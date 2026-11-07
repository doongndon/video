// Photo editor panels: toolbar, tool options bar, layers, colour, properties and history.

import { h, clamp } from '../util.js';
import { showMenu, toast, promptDialog, loadPref, savePref, openModal } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openFontPicker } from '../ui/font-picker.js';
import { fontLabel } from '../fonts.js';
import { makeCanvas, SHAPES, LAYER_COLORS, FILL_TYPES, PhotoDoc, psdTextKey } from './doc.js';
import { GRADIENTS, GRADIENT_STYLES, gradientSwatch, listPatterns } from './resources.js';
import { BLEND_GROUPS, PASS_THROUGH, blendName } from './blend.js';
import { hasFx, FX_NAMES, instanceKeys } from './styles.js';

const FX_ORDER = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { ADJUSTMENTS, defaultParams } from './adjust.js';
import { buildColorViews } from './colorpanel.js';
import { paramEditors } from './pdialogs.js';
import { transformMasksBy } from './transform.js';

/** Turn a layer's linked masks by `deg` degrees about (cx, cy) (a rotation typed in the properties panel). */
const turnMasks = (doc, l, deg, cx, cy) => {
  const a = (deg * Math.PI) / 180;
  if (!a) return;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  transformMasksBy(doc, l, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
};

const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#c0c0c0', '#ff0000', '#ff7f00', '#ffd400', '#7fd400', '#00b050', '#00b0b0', '#0070c0', '#3a3aff', '#7030a0', '#ff4fa3', '#8b4513', '#f5deb3', '#ffe680', '#a8e6ff', '#2b2b2b', '#e8eaed'];

// ---------------------------------------------------------------- toolbar

/** Photoshop's toolbar order, by one tool of each slot. Slots it doesn't know keep their place after the slot before them. */
const TOOL_ORDER = ['move', 'rect', 'lasso', 'objSel', 'wand', 'crop', 'frame', 'eyedropper', 'heal', 'brush', 'clone', 'historyBrush', 'eraser', 'gradient', 'blur', 'dodge', 'pen', 'text', 'pathSelect', 'shape', 'hand', 'zoom'];
// the toolbar's sections (a line between them): move | select, crop, measure | retouch, paint | draw, type | navigate
const SECTION_STARTS = ['rect', 'heal', 'pen', 'hand'];
// order inside a slot where it differs from the order the tools were added in
const IN_SLOT = { text: ['text', 'verticalText', 'verticalTextMask', 'textMask'] };
/** Icons closer to Photoshop's for tools that share an icon with the video editor. */
const PS_ICONS = { move: 'psMove', heal: 'spotHeal', dodge: 'dodgeTool', gradient: 'gradTool' };
export const toolIcon = (t, size = 18) => icon(PS_ICONS[t.id] || t.icon, size);
/** Photoshop's name for a tool: "브러시 도구", "자동 선택 도구". */
export const toolTitle = (t) => {
  const base = t.name.replace(/\s*\(.*\)$/, '');
  return /도구$/.test(base) ? base : `${base} 도구`;
};
const toolTip = (t) => `${toolTitle(t)}${t.key ? ` (${t.key})` : ''}`;
const LAYOUT_KEY = 'photo.toolbarLayout';

/** The default slots in Photoshop's order (copies; TOOL_GROUPS itself is left as modules built it). */
function defaultSlots() {
  const rank = (g) => TOOL_ORDER.findIndex((id) => g.includes(id));
  let last = -1;
  const keyed = TOOL_GROUPS.map((g, i) => {
    const r = rank(g);
    const k = r >= 0 ? r : last + 0.5;
    if (r >= 0) last = r;
    return [k, i, g];
  });
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return keyed.map(([, , g]) => {
    const order = IN_SLOT[g[0]];
    return order ? [...g].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) : [...g];
  });
}

/**
 * The toolbar as the user arranged it (Edit Toolbar): { slots, hidden }. Tools added since (by a
 * module) join the slot that holds the other tools of their default slot.
 */
export function toolbarLayout() {
  const def = defaultSlots();
  const saved = loadPref(LAYOUT_KEY, null);
  if (!saved?.groups) return { slots: def, hidden: [], custom: false };
  const known = new Set(def.flat());
  const placed = new Set();
  const take = (id) => known.has(id) && !placed.has(id) && placed.add(id);
  const slots = saved.groups.map((g) => g.filter(take)).filter((g) => g.length);
  const hidden = (saved.hidden || []).filter(take);
  def.forEach((dg, di) => {
    for (const id of dg) {
      if (placed.has(id)) continue;
      placed.add(id);
      const mate = dg.find((x) => x !== id && slots.some((s) => s.includes(x)));
      const slot = mate ? slots.find((s) => s.includes(mate)) : null;
      if (slot) slot.push(id);
      else slots.splice(Math.min(di, slots.length), 0, [id]);
    }
  });
  return { slots, hidden, custom: true };
}

/** The section (0–4) a slot belongs to, from its first tool Photoshop knows (-1: unknown). */
function sectionOf(slot) {
  const i = Math.min(...slot.map((id) => TOOL_ORDER.indexOf(id)).filter((x) => x >= 0));
  if (!Number.isFinite(i)) return -1;
  return SECTION_STARTS.filter((s) => TOOL_ORDER.indexOf(s) <= i).length;
}

/** A small floating label beside a toolbar button (Photoshop's tool tip: name and shortcut). */
function hoverTip() {
  const el = h('div.ph-tip', { role: 'tooltip', hidden: true });
  document.body.append(el);
  let t = 0;
  const hide = () => {
    clearTimeout(t);
    el.hidden = true;
  };
  return {
    attach(b, text) {
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(t);
        t = setTimeout(() => {
          if (!b.isConnected) return;
          el.textContent = typeof text === 'function' ? text() : text;
          el.hidden = false;
          const r = b.getBoundingClientRect();
          el.style.left = `${r.right + 6}px`;
          el.style.top = `${Math.min(r.top + r.height / 2 - el.offsetHeight / 2, window.innerHeight - el.offsetHeight - 4)}px`;
        }, 450);
      });
      for (const ev of ['pointerleave', 'pointerdown']) b.addEventListener(ev, hide);
    },
    hide,
  };
}

/** The list of tools in a slot (right-click or press and hold), like Photoshop's flyout. */
function toolFlyout(P, onPick) {
  const el = h('div.ph-flyout', { role: 'menu', hidden: true });
  document.body.append(el);
  let owner = null;
  const close = () => {
    el.hidden = true;
    owner = null;
  };
  const outside = (e) => {
    if (!el.hidden && !el.contains(e.target) && !owner?.contains(e.target)) close();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) close(); });
  P.on('tool', close);
  return {
    open(b, slot) {
      owner = b;
      el.replaceChildren(...slot.map((id) => {
        const t = TOOL_BY_ID[id];
        return h(`button.ph-fly-item${id === P.tool ? '.on' : ''}`, { role: 'menuitemradio', 'aria-checked': String(id === P.tool), onclick: () => { onPick(slot, id); P.setTool(id); close(); } },
          h('span.ph-fly-mark'), toolIcon(t, 16), h('span', toolTitle(t)), t.key ? h('kbd', t.key) : h('kbd'));
      }));
      el.hidden = false;
      const r = b.getBoundingClientRect();
      el.style.left = `${r.right + 2}px`;
      el.style.top = `${Math.max(4, Math.min(r.top, window.innerHeight - el.offsetHeight - 8))}px`;
      el.querySelector('.on, button')?.focus({ preventScroll: true });
    },
    close,
  };
}

export function buildToolbar(P) {
  const pick = new Map();
  const slotKey = (slot) => slot.join(',');
  const el = h('div.ph-tools', { role: 'toolbar', 'aria-label': '도구', 'aria-orientation': 'vertical' });
  let twoCol = loadPref('photo.toolbar2', false);
  let autoTwo = false;
  const tip = hoverTip();
  const fly = toolFlyout(P, (slot, id) => pick.set(slotKey(slot), id));
  // like Photoshop, the swatches open the Color Picker (colorpicker.js); the Color panel otherwise
  const swFg = h('button.ph-sw.fg', { 'aria-label': '전경색 설정', onclick: () => (P.colorPicker ? P.colorPicker('fg') : P.showPanel('color', 'fg')) });
  const swBg = h('button.ph-sw.bg', { 'aria-label': '배경색 설정', onclick: () => (P.colorPicker ? P.colorPicker('bg') : P.showPanel('color', 'bg')) });
  const swap = h('button.ph-swap', { 'aria-label': '전경색과 배경색 전환 (X)', onclick: () => P.swapColors() }, icon('swapColors', 11));
  const def = h('button.ph-def', { 'aria-label': '기본 전경색과 배경색 (D)', onclick: () => P.defaultColors() }, icon('defaultColors', 10));
  tip.attach(swFg, '전경색 설정');
  tip.attach(swBg, '배경색 설정');
  tip.attach(swap, '전경색과 배경색 전환 (X)');
  tip.attach(def, '기본 전경색과 배경색 (D)');
  const qm = h('button.ph-tool.ph-qm', { 'aria-label': '빠른 마스크 모드로 편집 (Q)', onclick: () => P.cmd.quickMask?.(), ondblclick: () => P.cmd.quickMaskOptions?.() }, icon('quickMask', 18));
  tip.attach(qm, () => (P.doc?.quickMask ? '표준 모드로 편집 (Q)' : '빠른 마스크 모드로 편집 (Q)'));
  const screenMenu = (b) => {
    const m = P.screenModeMenu?.();
    if (!m) return;
    const r = b.getBoundingClientRect();
    showMenu(m.submenu.filter((x) => x && x !== '-' && x.label), r.right + 2, r.top - 40);
  };
  const scr = h('button.ph-tool.ph-scr', { 'aria-label': '화면 모드 변경 (F)', onclick: () => P.cmd.screenMode?.() }, icon('screenMode', 18));
  scr.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    screenMenu(scr);
  });
  tip.attach(scr, '화면 모드 변경 (F) · 오른쪽 클릭: 모드 고르기');
  const more = h('button.ph-tool.ph-etb', { 'aria-label': '도구 모음 편집' }, icon('more', 16));
  tip.attach(more, '도구 모음 편집 · 추가 도구');
  more.addEventListener('click', () => {
    const { hidden } = toolbarLayout();
    const r = more.getBoundingClientRect();
    showMenu([
      ...(hidden.length ? [{ group: '추가 도구' }, ...hidden.map((id) => ({ label: toolTip(TOOL_BY_ID[id]), checked: id === P.tool, action: () => P.setTool(id) })), '-'] : []),
      { label: '도구 모음 편집…', action: () => editToolbarDialog(P, render) },
    ], r.right + 2, r.top);
  });
  const syncQm = () => qm.classList.toggle('on', !!P.doc?.quickMask);
  const longPress = (b, fn) => {
    let timer = 0;
    let fired = false;
    b.addEventListener('pointerdown', (e) => {
      fired = false;
      if (e.button) return;
      timer = setTimeout(() => {
        fired = true;
        fn();
      }, 450);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    // the click that ends a long press only opened the list
    b.addEventListener('click', (e) => {
      if (fired) {
        e.stopImmediatePropagation();
        fired = false;
      }
    }, true);
  };
  longPress(scr, () => screenMenu(scr));
  const render = () => {
    const { slots } = toolbarLayout();
    el.classList.toggle('two', twoCol || autoTwo);
    const cols = h('button.ph-tools-cols', { 'aria-label': twoCol ? '한 열로 보기' : '두 열로 보기', onclick: () => { twoCol = !twoCol; savePref('photo.toolbar2', twoCol); render(); P.redraw(); } }, icon(twoCol ? 'dblChevL' : 'dblChevR', 10));
    tip.attach(cols, twoCol ? '한 열로 보기' : '두 열로 보기');
    const items = [h('div.ph-tools-head', cols)];
    let sec = 0;
    slots.forEach((slot, i) => {
      const s = sectionOf(slot);
      if (i && s >= 0 && s !== sec) items.push(h('div.ph-tools-sep'));
      if (s >= 0) sec = s;
      const cur = slot.includes(P.tool) ? P.tool : slot.includes(pick.get(slotKey(slot))) ? pick.get(slotKey(slot)) : slot[0];
      const t = TOOL_BY_ID[cur];
      const b = h(`button.ph-tool${slot.includes(P.tool) ? '.on' : ''}`, {
        'aria-label': toolTip(t),
        'aria-pressed': String(slot.includes(P.tool)),
        'aria-haspopup': slot.length > 1 ? 'menu' : null,
        'data-tool': cur,
      }, toolIcon(t), slot.length > 1 ? h('span.ph-more') : null);
      tip.attach(b, () => toolTip(TOOL_BY_ID[b.dataset.tool]));
      b.addEventListener('click', (e) => {
        // Alt+click goes through the tools of the slot, like Photoshop
        if (e.altKey && slot.length > 1) {
          const next = slot[(slot.indexOf(cur) + 1) % slot.length];
          pick.set(slotKey(slot), next);
          return P.setTool(next);
        }
        return P.setTool(cur);
      });
      if (slot.length > 1) {
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          fly.open(b, slot);
        });
        longPress(b, () => fly.open(b, slot));
      }
      items.push(b);
    });
    items.push(h('div.ph-tools-sep'), more, h('div.ph-tools-sep'), h('div.ph-colors', swBg, swFg, swap, def), qm, scr);
    el.replaceChildren(...items);
    syncQm();
    swFg.style.background = P.fg;
    swBg.style.background = P.bg;
  };
  P.on('tool', (id) => {
    for (const slot of toolbarLayout().slots) if (slot.includes(id)) pick.set(slotKey(slot), id);
    render();
  });
  P.on('color', () => {
    swFg.style.background = P.fg;
    swBg.style.background = P.bg;
  });
  P.on('quickmask', syncQm);
  P.on('history', syncQm);
  P.on('layers', syncQm);
  P.editToolbar = () => editToolbarDialog(P, render);
  P.renderToolbar = render;
  render();
  // a window too short for one column of tools gets two, as Photoshop does
  const fit = () => {
    if (twoCol || !el.isConnected || !el.clientHeight) return;
    el.classList.remove('two');
    autoTwo = el.scrollHeight > el.clientHeight + 1;
    el.classList.toggle('two', autoTwo);
  };
  new ResizeObserver(fit).observe(el);
  return el;
}

/**
 * Edit ▸ Toolbar (the ⋯ button): drag tools between slots, into a new slot (the gaps between them)
 * or into Extra Tools to hide them. Each row's menu does the same without dragging.
 */
function editToolbarDialog(P, rerender) {
  const L = toolbarLayout();
  let slots = L.slots.map((s) => [...s]);
  let hidden = [...L.hidden];
  let dragId = null;
  const left = h('div.ph-etb-list', { 'aria-label': '도구 모음' });
  const right = h('div.ph-etb-list.extra', { 'aria-label': '추가 도구' });
  const take = (id) => {
    for (const s of slots) {
      const i = s.indexOf(id);
      if (i >= 0) s.splice(i, 1);
    }
    hidden = hidden.filter((x) => x !== id);
  };
  const tidy = () => {
    slots = slots.filter((s) => s.length);
  };
  // where: { slot, index } | { newSlot: at } | { hidden: index } (indices as painted: emptied slots go after)
  const move = (id, where) => {
    const from = slots.findIndex((s) => s.includes(id));
    const oldIdx = from >= 0 ? slots[from].indexOf(id) : hidden.indexOf(id);
    take(id);
    if (where.hidden != null) {
      const k = from < 0 && oldIdx < where.hidden ? where.hidden - 1 : where.hidden;
      hidden.splice(Math.min(k, hidden.length), 0, id);
    } else if (where.newSlot != null) slots.splice(where.newSlot, 0, [id]);
    else {
      const s = slots[where.slot];
      let k = where.index ?? s.length;
      if (from === where.slot && oldIdx < k) k--;
      s.splice(Math.min(k, s.length), 0, id);
    }
    tidy();
    paint();
  };
  const dropZone = (el, where) => {
    el.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop');
      if (dragId) move(dragId, typeof where === 'function' ? where(e) : where);
      dragId = null;
    });
  };
  const row = (id, where) => {
    const t = TOOL_BY_ID[id];
    const menuBtn = h('button.ph-etb-mbtn', { 'aria-label': `${toolTitle(t)} 옮기기`, title: '옮기기' }, icon('more', 12));
    const r = h('div.ph-etb-row', { draggable: 'true' }, toolIcon(t, 16), h('span', toolTitle(t)), h('kbd', t.key || ''), menuBtn);
    r.addEventListener('dragstart', (e) => {
      dragId = id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    r.addEventListener('dragend', () => { dragId = null; });
    // dropped on a row: before or after it in the same list
    dropZone(r, (e) => {
      const b = r.getBoundingClientRect();
      const after = e.clientY > b.top + b.height / 2;
      return where.hidden != null ? { hidden: where.hidden + (after ? 1 : 0) } : { slot: where.slot, index: where.index + (after ? 1 : 0) };
    });
    menuBtn.addEventListener('click', () => {
      const b = menuBtn.getBoundingClientRect();
      const si = where.slot;
      showMenu([
        { label: '추가 도구로 옮기기', disabled: where.hidden != null, action: () => move(id, { hidden: hidden.length }) },
        { label: '도구 모음에 새 칸으로', action: () => move(id, { newSlot: si != null ? si + 1 : slots.length }) },
        { label: '위 칸과 합치기', disabled: !(si > 0), action: () => move(id, { slot: si - 1 }) },
        { label: '아래 칸과 합치기', disabled: si == null || si >= slots.length - 1, action: () => move(id, { slot: si + 1 }) },
      ], b.left, b.bottom + 2);
    });
    return r;
  };
  const gap = (at) => {
    const g = h('div.ph-etb-gap', { title: '여기에 놓으면 새 칸' });
    dropZone(g, { newSlot: at });
    return g;
  };
  const paint = () => {
    const items = [gap(0)];
    slots.forEach((s, si) => {
      const box = h('div.ph-etb-slot', ...s.map((id, index) => row(id, { slot: si, index })));
      dropZone(box, { slot: si });
      items.push(box, gap(si + 1));
    });
    left.replaceChildren(...items);
    right.replaceChildren(...hidden.map((id, i) => row(id, { hidden: i })), ...(hidden.length ? [] : [h('div.empty-hint', '도구를 여기로 끌어 놓으면 도구 모음에서 숨깁니다')]));
  };
  dropZone(right, () => ({ hidden: hidden.length }));
  paint();
  openModal({
    title: '도구 모음 사용자 정의',
    width: '640px',
    body: [
      h('div.note', '도구를 끌어서 칸의 순서를 바꾸거나 다른 칸과 묶으세요. 오른쪽 "추가 도구"로 옮긴 도구는 도구 모음에서 숨겨지고 ⋯ 단추에서 고를 수 있습니다.'),
      h('div.ph-etb', h('div.ph-etb-col', h('div.ph-sub', '도구 모음'), left), h('div.ph-etb-col', h('div.ph-sub', '추가 도구'), right)),
    ],
    buttons: [
      { label: '기본값 복원', action: () => { const d = defaultSlots(); slots = d; hidden = []; paint(); return false; } },
      { label: '추가 도구 지우기', action: () => { for (const id of hidden) slots.push([id]); hidden = []; paint(); return false; } },
      { label: '취소' },
      { label: '완료', primary: true, action: () => {
        const d = defaultSlots();
        const same = !hidden.length && slots.length === d.length && slots.every((s, i) => s.join() === d[i].join());
        savePref(LAYOUT_KEY, same ? null : { groups: slots, hidden });
        rerender();
        P.redraw();
        return true;
      } },
    ],
  });
}

/** Phone: one scrolling strip with every tool. */
export function buildToolStrip(P) {
  const el = h('div.ph-strip', { role: 'toolbar', 'aria-label': '도구' });
  const render = () => {
    el.replaceChildren(...TOOLS.map((t) => h(`button.ph-stool${t.id === P.tool ? '.on' : ''}`, { onclick: () => P.setTool(t.id), 'aria-label': t.name, title: t.name }, toolIcon(t, 20), h('span', t.name.replace(/ \(.*\)/, '')))));
    el.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  P.on('tool', render);
  render();
  return el;
}

// ---------------------------------------------------------------- options bar

const SEL_MODES = [['new', 'selNew', '새 선택'], ['add', 'selAdd', '선택 영역에 추가 (Shift)'], ['sub', 'selSub', '선택 영역에서 빼기 (Alt)'], ['inter', 'selInter', '선택 영역과 교차 (Shift+Alt)']];

/** A popover under `anchor` that closes on a click outside it or Esc. */
export function popover(anchor, ...content) {
  document.querySelectorAll('.ph-pop').forEach((p) => p.close?.());
  // measured at the top left so its width isn't squeezed by where it would land
  const el = h('div.ph-pop', { style: { left: '0px', top: '0px' } }, ...content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 4)}px`;
  const out = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) el.close(); };
  const key = (e) => { if (e.key === 'Escape') el.close(); };
  el.close = () => {
    el.remove();
    document.removeEventListener('pointerdown', out, true);
    document.removeEventListener('keydown', key, true);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', out, true);
    document.addEventListener('keydown', key, true);
  }, 0);
  return el;
}

/** The far left of the options bar: the tool's icon, which opens the Tool Preset picker. */
function presetPicker(P, t) {
  const b = h('button.ph-tname', { 'aria-label': `${toolTitle(t)} · 도구 사전 설정 피커`, title: '도구 사전 설정 피커' }, toolIcon(t, 18), h('span.ph-tname-text', t.name), h('span.ph-caret'));
  b.addEventListener('click', () => {
    if (document.querySelector('.ph-pop.ph-tpp')) return document.querySelector('.ph-pop.ph-tpp').close();
    let only = loadPref('photo.toolPresets.only', true);
    const list = h('div.ph-tpp-list');
    const paint = () => {
      const all = (P.toolPresetList?.() || []).filter((p) => TOOL_BY_ID[p.tool] && (!only || p.tool === P.tool));
      list.replaceChildren(...all.map((p) => h('button.ph-tpp-row', { onclick: () => { P.applyToolPreset?.(p); pop.close(); } }, toolIcon(TOOL_BY_ID[p.tool], 15), h('span', p.name))),
        ...(all.length ? [] : [h('div.empty-hint', only ? '이 도구의 사전 설정이 없습니다' : '사전 설정이 없습니다')]));
    };
    const chk = h('input', { type: 'checkbox', checked: only });
    chk.addEventListener('change', () => { only = chk.checked; savePref('photo.toolPresets.only', only); paint(); });
    const pop = popover(b,
      h('div.ph-tpp-head', h('b', toolTitle(t)),
        h('button.ph-ibtn', { title: '현재 도구 설정으로 새 도구 사전 설정 만들기', 'aria-label': '새 도구 사전 설정', onclick: async () => {
          pop.close();
          const v = await promptDialog('새 도구 사전 설정', '이름', `${t.name} 1`);
          if (v?.trim()) P.saveToolPreset?.(v.trim());
        } }, icon('newLayer', 15)),
        h('button.ph-ibtn', { title: '도구 사전 설정 메뉴', 'aria-label': '도구 사전 설정 메뉴', onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showMenu([
            { label: '도구 재설정', action: () => { P.resetToolOptions?.(t.id); pop.close(); } },
            { label: '모든 도구 재설정', action: () => { P.resetToolOptions?.(); pop.close(); } },
            '-',
            { label: '도구 사전 설정 패널 열기', action: () => { pop.close(); P.showPanel('presets'); } },
          ], r.left, r.bottom + 2);
        } }, icon('gear', 15))),
      list,
      h('label.ph-tpp-only', chk, h('span', '현재 도구만')));
    pop.classList.add('ph-tpp');
    paint();
    return undefined;
  });
  return b;
}

/**
 * Photoshop's number option: "불투명도: 100% ▾". Drag the label sideways to change the value
 * (scrubby slider; Shift: faster, Alt: slower), type it in the field, or drop a slider down from ▾.
 * onChange(value, done) runs live while dragging and with done = true when the change ends.
 */
export function numOption({ label, glyph = null, value, min, max, unit = '', title = null, onChange }) {
  const name = title || label;
  const num = h('input.ph-num', { type: 'number', min, max, value, 'aria-label': name });
  const range = h('input', { type: 'range', min, max, value, 'aria-label': name });
  let v = +value;
  const set = (x, done) => {
    const n = clamp(Math.round(+x), min, max);
    if (!Number.isFinite(n)) return;
    v = n;
    num.value = n;
    range.value = n;
    onChange(n, done);
  };
  num.addEventListener('change', () => set(num.value, true));
  range.addEventListener('input', () => set(range.value, false));
  range.addEventListener('change', () => set(range.value, true));
  const lab = h('span.ph-scrub', { title: `${name}: 좌우로 끌어서 값 바꾸기` }, glyph || `${label}:`);
  lab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    lab.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = v;
    const per = Math.max(0.2, (max - min) / 300);
    let moved = false;
    const mv = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      set(v0 + dx * per * (ev.shiftKey ? 10 : ev.altKey ? 0.2 : 1), false);
    };
    const up = () => {
      lab.removeEventListener('pointermove', mv);
      lab.removeEventListener('pointerup', up);
      lab.removeEventListener('pointercancel', up);
      if (moved) set(v, true);
      else num.focus();
    };
    lab.addEventListener('pointermove', mv);
    lab.addEventListener('pointerup', up);
    lab.addEventListener('pointercancel', up);
  });
  const box = h('span.ph-numdrop', num, unit ? h('small', unit) : null);
  const arrow = h('button.ph-dropbtn', { type: 'button', 'aria-label': `${name} 슬라이더`, title: name }, icon('chevDown', 10));
  arrow.addEventListener('click', () => {
    if (range.closest('.ph-pop')) return range.closest('.ph-pop').close();
    const pop = popover(box, range);
    pop.classList.add('ph-slpop');
    range.focus();
    return undefined;
  });
  box.append(arrow);
  return h('span.ph-opt.ph-nopt', lab, box);
}

// option-bar switches Photoshop shows as icons: [icon, tooltip]
const ICON_TOGGLES = {
  pressureOpacity: ['penPressure', '불투명도에 항상 압력 사용 (끄면 브러시 설정이 압력을 정합니다)'],
  airbrush: ['airbrush', '에어브러시 스타일 효과 쌓기 사용 (누르고 있으면 계속 쌓임)'],
  pressureSize: ['penPressure', '크기에 항상 압력 사용 (끄면 브러시 설정이 압력을 정합니다)'],
};
/** Tools that paint with a round brush but have no brush preset picker of their own. */
const sizedBrush = (t) => t.options.some((x) => x[0] === 'size' && x[2] === 'range') && (t.group === 'paint' || t.group === 'retouch' || t.id === 'quickSel');

/** A small brush picker for the tools above: tip preview, size and ▾ (size and hardness sliders). */
function sizePicker(P, t, o) {
  const hard = t.options.find((x) => x[0] === 'hardness');
  const sz = t.options.find((x) => x[0] === 'size');
  const hd = hard ? clamp(o.hardness ?? 100, 0, 99) : 99;
  const dot = h('span.ph-tipdot', { style: { background: `radial-gradient(circle closest-side, var(--text) ${hd}%, transparent 100%)` } });
  const b = h('button.small.ph-bpbtn', { title: '브러시 사전 설정 피커 (크기와 경도)', 'aria-label': '브러시 사전 설정 피커' }, dot, h('span', String(o.size)), icon('chevDown', 11));
  const row = (def) => {
    const [key, label, , min, max] = def;
    const r = h('input', { type: 'range', min, max, value: P.opts(t.id)[key], 'aria-label': label });
    const n = h('input.ph-num', { type: 'number', min, max, value: P.opts(t.id)[key], 'aria-label': label });
    const set = (x) => {
      const val = clamp(Math.round(+x), min, max);
      r.value = val;
      n.value = val;
      P.setOpt(t.id, key, val);
    };
    r.addEventListener('input', () => set(r.value));
    n.addEventListener('change', () => set(n.value));
    return h('label.ph-bprow', h('span', label), r, n, h('small', key === 'size' ? 'px' : '%'));
  };
  b.addEventListener('click', () => {
    if (document.querySelector('.ph-pop.ph-szpop')) return document.querySelector('.ph-pop.ph-szpop').close();
    popover(b, row(sz), hard ? row(hard) : null).classList.add('ph-szpop');
    return undefined;
  });
  return b;
}

/** 홈 (house) at the far left of the options bar: the home screen over the open documents. */
function homeButton(P) {
  return h('button.ph-ibtn.ph-homebtn', { title: '홈 화면', 'aria-label': '홈 화면', onclick: () => {
    if (P.showHome) return P.showHome();
    const home = document.querySelector('.ph-stage .ph-home');
    if (home && P.doc) home.hidden = !home.hidden;
    return undefined;
  } }, icon('homeIcon', 16));
}

export function buildOptionsBar(P) {
  const el = h('div.ph-opts');
  // a slider or number in the bar changing its own option must not rebuild the bar under the pointer
  // (the slider being dragged would be replaced and the drag would stop after the first step)
  let selfChange = false;
  const render = () => {
    const t = TOOL_BY_ID[P.tool];
    if (selfChange || !t) return;
    const o = P.opts(t.id);
    const ctrls = [];
    // size and hardness live in the brush preset picker (the tool's own, or a small one here)
    const lead = (t.leadButtons?.(P) || []).filter(Boolean);
    const brushPicker = lead.some((b) => b.classList?.contains('ph-bpbtn'));
    const picker = !brushPicker && sizedBrush(t) ? sizePicker(P, t, o) : null;
    const inPicker = (key) => (brushPicker || picker) && (key === 'size' || key === 'hardness');
    // the brush tip's angle (∠ 0°), before the pressure-for-size switch as in Photoshop
    let angleDone = !brushPicker;
    const angleOpt = () => {
      angleDone = true;
      return numOption({ label: '각도', glyph: icon('angle', 15), title: '브러시 각도', value: Math.round(o.angle ?? 0), min: -180, max: 180, unit: '°', onChange: (v) => setSelf('angle', v) });
    };
    const setSelf = (key, v) => {
      selfChange = true;
      try {
        P.setOpt(t.id, key, v);
      } finally {
        selfChange = false;
      }
    };
    for (const def of t.options) {
      const [key, rawLabel, type, min, max, , list] = def;
      // "페더 (px)": the unit goes after the field
      const m = /^(.*?)\s*\((px|%|°)\)$/.exec(rawLabel);
      const label = m ? m[1] : rawLabel;
      // ranges keep their unit where a select keeps its list
      const unit = typeof list === 'string' ? list : def[7] || m?.[2];
      if (t.id === 'shape' && ((key === 'sides' && !['polygon', 'star'].includes(o.type)) || (key === 'radius' && o.type !== 'round'))) continue;
      if (inPicker(key)) continue;
      if (key === 'pressureSize' && !angleDone) ctrls.push(angleOpt());
      if (type === 'range' || type === 'number') {
        ctrls.push(numOption({ label, value: o[key], min, max, unit: typeof unit === 'string' && unit.length <= 3 ? unit : '', onChange: (v) => setSelf(key, v) }));
      } else if (type === 'bool' && ICON_TOGGLES[key]) {
        const [ic, tip] = ICON_TOGGLES[key];
        ctrls.push(h(`button.ph-ibtn.ph-otog${o[key] ? '.on' : ''}`, { title: tip, 'aria-label': rawLabel, 'aria-pressed': String(!!o[key]), onclick: () => P.setOpt(t.id, key, !o[key]) }, icon(ic, 16)));
      } else if (type === 'bool') {
        const b = h('input', { type: 'checkbox', checked: !!o[key] });
        b.addEventListener('change', () => P.setOpt(t.id, key, b.checked));
        ctrls.push(h('label.ph-opt', b, h('span', label)));
      } else if (type === 'select' && key === 'mode' && Array.isArray(list) && list.some(([v]) => v === 'inter')) {
        // the selection tools' four mode buttons, as icons like Photoshop
        ctrls.push(h('span.ph-selmodes', { role: 'radiogroup', 'aria-label': label }, ...SEL_MODES.map(([v, ic, name]) => h(`button.ph-ibtn${o.mode === v ? '.on' : ''}`, {
          role: 'radio', 'aria-checked': String(o.mode === v), 'aria-label': name, title: name, onclick: () => P.setOpt(t.id, key, v),
        }, icon(ic, 16)))));
      } else if (type === 'select') {
        if (key === 'custom' && o.type !== 'custom') continue;
        if (key === 'sides' && !['polygon', 'star'].includes(o.type)) continue;
        const items = list === 'customShapes' ? P.customShapeList() : typeof list === 'function' ? list() : list;
        const s = h('select', { 'aria-label': label }, items.map(([v, txt]) => h('option', { value: v }, txt)));
        s.value = o[key];
        s.addEventListener('change', () => P.setOpt(t.id, key, isNaN(+s.value) || s.value === '' ? s.value : +s.value));
        ctrls.push(h('label.ph-opt', h('span', `${label}:`), s));
      } else if (type === 'font') {
        const b = h('button.small', { title: '글꼴 고르기' }, fontLabel(o[key]));
        b.style.fontFamily = `"${o[key]}", "Noto Sans KR", sans-serif`;
        b.addEventListener('click', () => {
          const l = P.doc?.active;
          const editing = l?.kind === 'text';
          const before = editing ? P.doc.capture() : null;
          const orig = editing ? l.text.font : null;
          openFontPicker(b, {
            current: o[key],
            sample: editing ? l.text.content : '',
            onPreview: (fam) => {
              if (!editing) return;
              l.text = { ...l.text, font: fam || orig };
              P.doc.touch(l);
              P.redraw();
            },
            onPick: (fam) => {
              P.setOpt(t.id, key, fam);
              if (editing) {
                l.text = { ...l.text, font: fam };
                P.doc.touch(l);
                P.commit('글꼴', before);
              }
              render();
            },
            onCancel: () => {
              if (editing) {
                l.text = { ...l.text, font: orig };
                P.doc.touch(l);
                P.redraw();
              }
            },
          });
        });
        ctrls.push(h('label.ph-opt', h('span', label), b));
      }
    }
    // tool-specific actions
    if (P.transform && P.transformBar) {
      // the transform's own options bar (transform2.js: reference point, numbers, warp grid…)
      el.replaceChildren(...P.transformBar(render));
      return;
    }
    if (P.transform) {
      const T = P.transform;
      const n = T.numbers();
      const numIn2 = (key, label, unit, step = 1) => {
        const inp = h('input.ph-num', { type: 'number', value: n[key], step, 'aria-label': label });
        inp.addEventListener('change', () => {
          const v = { [key]: +inp.value };
          if (key === 'w' && link.checked) v.h = n.h * (+inp.value / (n.w || 1));
          if (key === 'h' && link.checked) v.w = n.w * (+inp.value / (n.h || 1));
          T.setNumbers(v);
          render();
        });
        return h('label.ph-opt', h('span', label), inp, unit ? h('small', unit) : null);
      };
      const link = h('input', { type: 'checkbox', checked: true, 'aria-label': '비율 고정', title: '폭·높이 비율 고정' });
      const modes = h('span.ph-opt', ...P.transformModes.map(([id, name]) => h(`button.small.ph-tog${T.mode === id ? '.on' : ''}`, { onclick: () => { T.setMode(id); render(); } }, name)));
      ctrls.length = 0;
      ctrls.push(h('span.ph-opt.ph-hint', '변형'), modes);
      if (T.mode === 'warp') {
        const st = h('select', { 'aria-label': '뒤틀기 스타일' }, [['custom', '사용자 정의 (점 끌기)'], ...P.warpStyles.filter((w) => w[0] !== 'none')].map(([v, t2]) => h('option', { value: v }, t2)));
        st.value = T.warp?.style || 'custom';
        st.addEventListener('change', () => { T.setWarpPreset(st.value, T.warp?.bend ?? 50, T.warp?.h ?? 0, T.warp?.v ?? 0); render(); });
        ctrls.push(h('label.ph-opt', h('span', '뒤틀기'), st));
        if (T.warp && T.warp.style !== 'custom') {
          for (const [key, label] of [['bend', '구부리기'], ['h', '가로 왜곡'], ['v', '세로 왜곡']]) {
            const inp = h('input.ph-num', { type: 'number', min: -100, max: 100, value: T.warp[key] ?? (key === 'bend' ? 50 : 0) });
            inp.addEventListener('change', () => { T.setWarpPreset(T.warp.style, key === 'bend' ? +inp.value : T.warp.bend, key === 'h' ? +inp.value : T.warp.h, key === 'v' ? +inp.value : T.warp.v); });
            ctrls.push(h('label.ph-opt', h('span', label), inp, h('small', '%')));
          }
        }
      } else {
        ctrls.push(numIn2('x', 'X', 'px'), numIn2('y', 'Y', 'px'), numIn2('w', '폭', '%', 0.1), h('label.ph-opt', { title: '폭·높이 비율 고정' }, link, icon('link', 13)), numIn2('h', '높이', '%', 0.1), numIn2('angle', '회전', '°', 0.1), numIn2('skew', '기울기', '°', 0.1));
      }
      ctrls.push(h('button.primary.small', { onclick: () => P.applyTransform() }, icon('check', 13), ' 적용'), h('button.small', { onclick: () => P.cancelTransform() }, icon('close', 13), ' 취소'));
      el.replaceChildren(h('span.ph-tname', icon('move', 16), '변형'), ...ctrls);
      return;
    } else if (t.id === 'crop' && !t.optionButtons) {
      ctrls.push(h('button.primary.small', { onclick: () => t.apply(P) }, icon('check', 13), ' 자르기'), h('button.small', { onclick: () => { t.activate(P); } }, '되돌리기'));
    } else if (t.id === 'clone') {
      ctrls.push(h('button.small', { onclick: () => { P.cloneSourceNext = true; toast('복제할 원본 위치를 누르세요'); }, title: '휴대폰: 이 버튼을 누른 뒤 원본 위치를 누르세요' }, '원본 정하기'));
    } else if (['pen', 'freePen', 'pathSelect', 'directSelect', 'addAnchor', 'deleteAnchor', 'convertPoint'].includes(t.id)) {
      ctrls.push(h('span.ph-opt', '만들기:'),
        h('button.small', { onclick: () => P.cmd.pathToSelection() }, '선택 영역'),
        h('button.small', { onclick: () => P.cmd.addVectorMask('path') }, '마스크'),
        h('button.small', { onclick: () => P.cmd.pathToShape?.() }, '모양'),
        ...(P.doc?.workPath ? [h('button.small', { onclick: () => P.cmd.savePath() }, '패스 저장')] : []),
        ...(t.id === 'pathSelect' && P.cmd.mergeShapeComponents ? [h('button.small', { title: '패스 작업: 모양 구성 요소 병합', onclick: () => P.cmd.mergeShapeComponents() }, '구성 요소 병합')] : []));
    } else if (TOOL_BY_ID[t.id]?.optionsFrom === 'text') {
      // the text colour swatch and the orientation toggle of Photoshop's type options bar
      const tcol = P.typeState?.().char.color;
      const sw = h('input', { type: 'color', title: '텍스트 색상 설정', 'aria-label': '텍스트 색상', value: /^#[0-9a-f]{6}$/i.test(tcol || '') ? tcol : P.fg });
      sw.addEventListener('input', () => P.typeApply?.({ color: sw.value }, '글자 색상', { live: true }));
      sw.addEventListener('change', () => P.typeApply?.({ color: sw.value }, '글자 색상', { refocus: true }));
      const at = P.doc?.active?.kind === 'text' ? P.doc.active.text : null;
      ctrls.push(sw, h('button.small', { title: '텍스트 방향 켜기/끄기 (가로 ↔ 세로)', disabled: !at || !!at.path || !!at.area, onclick: () => P.cmd.textOrientation?.(at?.vertical ? 'h' : 'v') }, '방향'), h('button.small', { onclick: () => (P.doc?.active?.kind === 'text' ? P.warpText() : toast('글자 레이어를 고르세요')) }, '텍스트 뒤틀기'), h('button.small', { onclick: () => P.showPanel('char') }, '문자 패널'));
    } else if (t.optionButtons) {
      ctrls.push(...t.optionButtons(P).filter(Boolean));
    }
    if (!angleDone) ctrls.push(angleOpt());
    if (P.symmetryButton && ['brush', 'pencil', 'eraser', 'mixer'].includes(t.id)) {
      // Photoshop shows the butterfly icon; the state ("대칭: 방사형 8") stays in the tooltip
      const sb = P.symmetryButton();
      const state = sb.textContent.replace(/\s*▾\s*$/, '');
      sb.setAttribute('aria-label', `대칭 칠하기 (${state})`);
      sb.title = `${state} · ${sb.title}`;
      sb.classList.remove('small');
      sb.classList.add('ph-ibtn', 'ph-symbtn');
      sb.replaceChildren(icon('symmetry', 16), h('span.ph-caret'));
      ctrls.push(sb);
    }
    if (P.doc?.active?.mask && ['brush', 'pencil', 'eraser', 'bucket', 'gradient'].includes(t.id)) {
      ctrls.push(h('span.ph-opt.ph-hint', P.editMask ? '마스크에 칠하는 중 (검정=숨김, 흰색=보임)' : ''));
    }
    // Select and Mask… sits at the right end of the bar, as in Photoshop
    for (const c of ctrls) if (c?.tagName === 'BUTTON' && c.textContent.startsWith('선택 및 마스크')) c.classList.add('ph-right');
    // the tool preset picker (the tool's icon) first, then leadButtons: controls Photoshop shows
    // next (the brush preset picker)
    el.replaceChildren(homeButton(P), presetPicker(P, t), ...lead, ...(picker ? [picker] : []), ...ctrls);
  };
  P.on('tool', render);
  P.on('opts', render);
  P.on('transform', render);
  P.on('layers', render);
  // Enter in a number field sets the value and gives the keys back to the picture (Photoshop), so
  // the next shortcut (5 for 50%, ] for a bigger brush) is not typed into the field
  el.addEventListener('keydown', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLInputElement) || !['number', 'text'].includes(f.type) || e.isComposing) return;
    if (e.key === 'Enter') setTimeout(() => f.isConnected && f.blur(), 0);
  });
  render();
  return el;
}

// ---------------------------------------------------------------- layers

const thumbCache = new WeakMap();
/** Layers panel ▸ Panel Options ▸ thumbnail size (px; 0: none). */
export const THUMB_SIZES = [[0, '없음'], [26, '작게'], [40, '중간'], [64, '크게']];
// small by default, as in Photoshop (rows about 32 px)
let thumbSize = 26;
try {
  const v = +loadPref('photo.layerThumb', 26);
  if (THUMB_SIZES.some(([n]) => n === v)) thumbSize = v;
} catch { /* default */ }
function thumb(P, l, which = 'content') {
  const S = thumbSize || 40;
  const c = h('canvas.ph-thumb', { width: S, height: S, style: S !== 40 ? { width: `${S}px`, height: `${S}px` } : null });
  const doc = P.doc;
  const key = `${l.rev}:${which}:${doc.width}x${doc.height}:${S}`;
  const cache = thumbCache.get(l)?.[which];
  if (cache?.key === key && cache.doc === doc.id) {
    c.getContext('2d').drawImage(cache.c, 0, 0);
    return c;
  }
  const g = c.getContext('2d');
  const s = Math.min(S / doc.width, S / doc.height);
  const w = doc.width * s;
  const hh = doc.height * s;
  g.save();
  g.translate((S - w) / 2, (S - hh) / 2);
  if (which === 'mask' && l.mask) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hh);
    const t = makeCanvas(S, S);
    const tg = t.getContext('2d');
    tg.scale(s, s);
    tg.drawImage(l.mask.canvas, l.mask.x, l.mask.y);
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = '#fff';
    tg.fillRect(0, 0, S, S);
    g.drawImage(t, 0, 0);
  } else if (which === 'vmask' && l.vmask) {
    g.fillStyle = '#777';
    g.fillRect(0, 0, w, hh);
    const r = P.vectorMaskCanvas?.(l);
    if (r) {
      g.scale(s, s);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(r, 0, 0);
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, doc.width, doc.height);
    }
  } else if (l.kind === 'adjust') {
    g.fillStyle = '#4a4f58';
    g.fillRect(0, 0, w, hh);
    // Photoshop's adjustment layer mark: a half-filled circle
    const r = S * 0.22;
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.lineWidth = Math.max(1, S / 24);
    g.beginPath();
    g.arc(w / 2, hh / 2, r, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(w / 2, hh / 2, r, -Math.PI / 2, Math.PI / 2);
    g.closePath();
    g.fill();
  } else if (l.kind === 'group' && l.artboard) {
    // an artboard: Photoshop's artboard mark (a frame with crop-like ticks)
    g.restore();
    const k = S / 40;
    g.strokeStyle = '#b8bcc6';
    g.lineWidth = Math.max(1, 1.6 * k);
    g.strokeRect(12 * k, 12 * k, 16 * k, 16 * k);
    g.beginPath();
    for (const v of [12, 28]) {
      g.moveTo(v * k, 4 * k);
      g.lineTo(v * k, 9 * k);
      g.moveTo(v * k, 31 * k);
      g.lineTo(v * k, 36 * k);
      g.moveTo(4 * k, v * k);
      g.lineTo(9 * k, v * k);
      g.moveTo(31 * k, v * k);
      g.lineTo(36 * k, v * k);
    }
    g.stroke();
    g.save();
  } else if (l.kind === 'group') {
    g.restore();
    const k = S / 40;
    g.fillStyle = '#c9a54a';
    g.fillRect(4 * k, 10 * k, 32 * k, 22 * k);
    g.fillRect(4 * k, 7 * k, 13 * k, 5 * k);
    g.fillStyle = '#e4c870';
    g.fillRect(4 * k, 14 * k, 32 * k, 18 * k);
    g.save();
  } else {
    // checkerboard
    for (let y = 0; y < hh; y += 5) for (let x = 0; x < w; x += 5) {
      g.fillStyle = ((x + y) / 5) % 2 ? '#ccc' : '#fff';
      g.fillRect(x, y, 5, 5);
    }
    const ct = doc.content(l);
    if (ct) {
      g.scale(s, s);
      g.drawImage(ct.canvas, ct.x, ct.y);
    }
  }
  g.restore();
  if (l.kind === 'smart') {
    // the smart object badge at the bottom right, sized to the thumbnail
    const b = Math.max(8, Math.round(S * 0.3));
    g.fillStyle = '#fff';
    g.fillRect(S - b - 1, S - b - 1, b, b);
    g.strokeStyle = '#333';
    g.strokeRect(S - b - 0.5, S - b - 0.5, b - 1, b - 1);
    g.fillStyle = '#333';
    const k = Math.round(b / 2.2);
    g.fillRect(S - b + Math.round((b - k) / 2) - 1, S - b + Math.round((b - k) / 2) - 1, k, k);
  }
  if (l.kind === 'text') {
    const tb = Math.min(14, Math.max(10, Math.round(S * 0.4)));
    g.fillStyle = 'rgba(0,0,0,.65)';
    g.fillRect(0, S - tb, tb, tb);
    g.fillStyle = '#fff';
    g.font = `bold ${tb - 3}px sans-serif`;
    g.fillText('T', tb * 0.22, S - tb * 0.22);
  }
  const copy = makeCanvas(S, S);
  copy.getContext('2d').drawImage(c, 0, 0);
  thumbCache.set(l, { ...(thumbCache.get(l) || {}), [which]: { key, c: copy, doc: doc.id } });
  return c;
}

/** The blend-mode <select> with Photoshop's groups (and "pass through" for groups). */
export function blendSelect(withPass = false) {
  const s = h('select.ph-blend', { 'aria-label': '혼합 모드', title: '혼합 모드' });
  if (withPass) s.append(h('option', { value: PASS_THROUGH[0] }, PASS_THROUGH[1]));
  BLEND_GROUPS.forEach((grp, i) => {
    if (i || withPass) s.append(h('option', { disabled: true }, '──────'));
    for (const [id, name] of grp) s.append(h('option', { value: id }, name));
  });
  return s;
}

const LAYER_COLOR_CSS = Object.fromEntries(LAYER_COLORS.map(([id, , c]) => [id, c]));

export function buildLayersPanel(P) {
  let blend = blendSelect(true);
  const opacity = h('input.ph-num', { type: 'number', min: 0, max: 100, 'aria-label': '불투명도', title: '불투명도 (%)' });
  const opRange = h('input', { type: 'range', min: 0, max: 100, 'aria-label': '불투명도' });
  const fillNum = h('input.ph-num', { type: 'number', min: 0, max: 100, 'aria-label': '칠', title: '칠 (효과는 그대로 두고 레이어 내용만 투명하게)' });
  const lockBtn = (kind, label, glyph) => h('button.ph-ibtn.ph-lock', { title: label, 'aria-label': label, 'data-lock': kind, onclick: () => P.cmd.lock(kind) }, glyph);
  const locks = [lockBtn('alpha', '투명 픽셀 잠그기 (칠한 곳에만 칠하기) · /', icon('lockAlpha', 14)), lockBtn('pixels', '이미지 픽셀 잠그기 (칠하기 막기)', icon('lockPixels', 14)), lockBtn('position', '위치 잠그기 (옮기기 막기)', icon('lockPos', 14)), lockBtn('all', '모두 잠그기', icon('lock', 14))];
  // Photoshop's "불투명도: 100% ▾": a number with a slider that drops down from the arrow
  const dropSlider = (num, range, label) => {
    const arrow = h('button.ph-dropbtn', { 'aria-label': `${label} 슬라이더`, title: label }, icon('chevDown', 10));
    arrow.addEventListener('click', () => {
      if (range.closest('.ph-pop')) return range.closest('.ph-pop').close();
      const pop = popover(num, range);
      pop.classList.add('ph-slpop');
      range.focus();
      return undefined;
    });
    return h('span.ph-numdrop', num, h('small', '%'), arrow);
  };
  const fillRange = h('input', { type: 'range', min: 0, max: 100, 'aria-label': '칠' });
  const list = h('div.ph-layers', { role: 'tree', 'aria-label': '레이어', 'aria-multiselectable': 'true' });
  const footBtn = (ic, label, fn) => h(`button.ph-ibtn${ic === 'fx' ? '.ph-fxbtn' : ''}`, { title: label, 'aria-label': label.replace(/ \(.*$/, ''), onclick: fn }, typeof ic === 'string' && ic.length > 2 ? icon(ic, 16) : ic);
  const menuAt = (e, items) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(items, r.left, r.top - 4);
  };
  const foot = h('div.ph-lfoot',
    footBtn('link', '레이어 연결', () => (P.doc?.active?.linkId ? P.cmd.unlink() : P.cmd.link())),
    footBtn('fx', '레이어 스타일 추가', (e) => menuAt(e, [{ label: '혼합 옵션…', action: () => P.cmd.layerStyle('blending') }, '-', ...FX_ORDER.map((k) => ({ label: `${FX_NAMES[k]}…`, action: () => P.cmd.layerStyle(k) }))])),
    footBtn('mask', '레이어 마스크 추가 (선택 영역이 있으면 그 부분만 보이게 · Alt: 숨기기)', (e) => (P.cmd.addMaskMode ? P.cmd.addMaskMode(e.altKey ? 'hideSel' : 'revealSel') : P.cmd.addMask(e.altKey))),
    footBtn('fillAdjust', '새 칠 또는 조정 레이어 만들기', (e) => menuAt(e, P.newFillOrAdjustMenu())),
    footBtn('folder', '새 그룹 만들기 (Ctrl+G: 고른 레이어로 그룹 만들기)', () => P.cmd.newGroup()),
    footBtn('newLayer', '새 레이어 만들기 (Shift+Ctrl+N: 대화 상자)', () => P.cmd.newLayer()),
    footBtn('trash', '레이어 삭제', () => P.cmd.deleteLayer()));
  const head = h('div.ph-lhead');
  // find layers by name or kind (Photoshop's layer filter); kept out of `head` so typing keeps focus
  // Photoshop's filter row: a filter type, then the kind icons (or a name field), and an on/off switch
  const fq = h('input.ph-lfind', { type: 'search', placeholder: '레이어 이름', 'aria-label': '레이어 이름으로 찾기' });
  const fk = h('select.ph-lkind', { 'aria-label': '필터 유형', title: '필터 유형' },
    [['kind', '종류'], ['name', '이름'], ['fx', '효과'], ['group', '그룹 · 프레임'], ['hidden', '숨김 레이어']].map(([v, n]) => h('option', { value: v }, n)));
  const KINDS = {
    raster: (l) => l.kind === 'raster', adjust: (l) => l.kind === 'adjust' || l.kind === 'fill', text: (l) => l.kind === 'text', shape: (l) => l.kind === 'shape',
    smart: (l) => l.kind === 'smart', group: (l) => l.kind === 'group', fx: (l) => hasFx(l.fx), hidden: (l) => !l.visible,
  };
  const kindsOn = new Set();
  let filterSwitch = true;
  const kindBtns = [['raster', 'layerPixel', '픽셀 레이어 필터'], ['adjust', 'layerAdjust', '조정 레이어 필터'], ['text', 'layerType', '문자 레이어 필터'], ['shape', 'layerShape', '모양 레이어 필터'], ['smart', 'layerSmart', '고급 개체 필터']]
    .map(([k, ic, label]) => h('button.ph-ibtn.ph-kind', { title: label, 'aria-label': label, 'aria-pressed': 'false', onclick: (e) => {
      if (kindsOn.has(k)) kindsOn.delete(k);
      else kindsOn.add(k);
      e.currentTarget.classList.toggle('on', kindsOn.has(k));
      e.currentTarget.setAttribute('aria-pressed', String(kindsOn.has(k)));
      render();
    } }, icon(ic, 14)));
  const kindRow = h('span.ph-lkinds', ...kindBtns);
  const sw = h('button.ph-ibtn.ph-fswitch.on', { title: '레이어 필터 켜기/끄기', 'aria-label': '레이어 필터 켜기/끄기', 'aria-pressed': 'true', onclick: () => {
    filterSwitch = !filterSwitch;
    sw.classList.toggle('on', filterSwitch);
    sw.setAttribute('aria-pressed', String(filterSwitch));
    render();
  } }, icon('filterSwitch', 16));
  const syncFilterRow = () => {
    kindRow.hidden = fk.value !== 'kind';
    fq.hidden = fk.value !== 'name';
  };
  fk.addEventListener('change', () => {
    syncFilterRow();
    if (fk.value === 'name') fq.focus();
    render();
  });
  fq.addEventListener('input', () => render());
  syncFilterRow();
  P.focusLayerFilter = () => {
    P.showPanel('layers');
    fk.value = 'name';
    syncFilterRow();
    if (!filterSwitch) sw.click();
    fq.focus();
    fq.select();
  };
  let filterOn = false;
  // the panel menu (≡ on the dock's tab bar): Photoshop's layers panel menu with Panel Options
  P.panelMenus = P.panelMenus || {};
  P.panelMenus.layers = () => {
    const C = P.cmd;
    const no = !P.doc;
    return [
      { label: '새 레이어…', disabled: no, action: () => C.newLayer() },
      { label: '레이어 복제…', disabled: no, action: () => C.duplicateLayerDialog() },
      { label: '레이어 삭제', disabled: no, action: () => C.deleteLayer() },
      '-',
      { label: '새 그룹…', disabled: no, action: () => C.newGroup() },
      { label: '레이어에서 새 그룹…', disabled: no, action: () => C.groupLayers() },
      '-',
      { label: '고급 개체로 변환', disabled: no, action: () => C.convertToSmart() },
      { label: '레이어 속성…', disabled: no, action: () => C.layerProperties() },
      { label: '혼합 옵션…', disabled: no, action: () => C.layerStyle('blending') },
      '-',
      { label: '클리핑 마스크 만들기', key: 'Ctrl+Alt+G', disabled: no, action: () => C.toggleClip() },
      { label: '아래로 병합', key: 'Ctrl+E', disabled: no, action: () => C.mergeDown() },
      { label: '보이는 레이어 병합', key: 'Ctrl+Shift+E', disabled: no, action: () => C.mergeVisible() },
      { label: '이미지 병합', disabled: no, action: () => C.flatten() },
      '-',
      { label: '패널 옵션: 축소판 크기', submenu: THUMB_SIZES.map(([n, label]) => ({
        label, checked: thumbSize === n,
        action: () => {
          thumbSize = n;
          savePref('photo.layerThumb', n);
          render();
        },
      })) },
      { label: '모든 그룹 닫기', disabled: no, action: () => { for (const x of P.doc.layers) if (x.kind === 'group') x.collapsed = true; P.emit('layers'); } },
    ];
  };
  const el = h('div.ph-panel.layers', h('div.ph-lfilter', fk, kindRow, fq, sw), head, list, foot);

  const opDrop = dropSlider(opacity, opRange, '불투명도');
  const fillDrop = dropSlider(fillNum, fillRange, '칠');
  let opBefore = null;
  const setNum = (key, v, done) => {
    const l = P.doc?.active;
    if (!l) return;
    if (!opBefore) opBefore = P.doc.capture();
    l[key] = clamp(v, 0, 100) / 100;
    l._styled = null;
    P.doc.touch(l);
    P.redraw();
    if (key === 'opacity') {
      opacity.value = Math.round(l.opacity * 100);
      opRange.value = opacity.value;
    }
    if (done) {
      P.commit(key === 'opacity' ? '불투명도' : '칠', opBefore);
      opBefore = null;
    }
  };
  opRange.addEventListener('input', () => setNum('opacity', +opRange.value, false));
  opRange.addEventListener('change', () => setNum('opacity', +opRange.value, true));
  opacity.addEventListener('change', () => setNum('opacity', +opacity.value, true));
  fillNum.addEventListener('input', () => { if (fillNum.value !== '') setNum('fillOpacity', +fillNum.value, false); });
  fillRange.addEventListener('input', () => { fillNum.value = fillRange.value; setNum('fillOpacity', +fillRange.value, false); });
  fillRange.addEventListener('change', () => setNum('fillOpacity', +fillRange.value, true));
  fillNum.addEventListener('change', () => setNum('fillOpacity', +fillNum.value, true));
  const onBlend = () => {
    const d = P.doc;
    const v = blend.value;
    if (d) P.run('혼합 모드', () => { for (const l of d.selectedLayers) { if (v === 'pass through' && l.kind !== 'group') continue; l.blend = v; d.touch(l); } });
  };

  let drag = null;
  let maskDrag = null;
  // Double-clicks: the first click rebuilds the list (it selects the layer), so the browser never
  // sees two clicks on one element. Each target carries a key (data-dbl); two clicks on the same key
  // in quick succession run its action instead of the second click.
  const dblActions = new Map();
  let lastTap = { key: null, t: 0, x: 0, y: 0 };
  const onDbl = (el, key, fn) => {
    el.dataset.dbl = key;
    dblActions.set(key, fn);
    return el;
  };
  list.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-dbl]');
    const ctl = e.target.closest?.('button, input, select, textarea');
    if (!el || (ctl && ctl !== el && el.contains(ctl))) {
      lastTap = { key: null, t: 0, x: 0, y: 0 };
      return;
    }
    // A click with a modifier (Ctrl+click thumbnail = load selection, Alt / Shift on masks) is never
    // half of a double-click, so two quick modifier clicks keep doing their own job.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
      lastTap = { key: null, t: 0, x: 0, y: 0 };
      return;
    }
    const key = el.dataset.dbl;
    const now = performance.now();
    if (lastTap.key === key && now - lastTap.t < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 8) {
      lastTap = { key: null, t: 0, x: 0, y: 0 };
      e.stopPropagation();
      e.preventDefault();
      dblActions.get(key)?.(e);
      return;
    }
    lastTap = { key, t: now, x: e.clientX, y: e.clientY };
  }, true);
  const rowsFor = (l, depth, rows, clipBaseName) => {
    const doc = P.doc;
    const sel = new Set([...(doc.selectedIds || []), doc.activeId]);
    const eye = h('button.ph-eye', { title: `${l.visible ? '숨기기' : '보이기'} (Alt+클릭: 이 레이어만 보기)`, 'aria-label': l.visible ? '숨기기' : '보이기' }, icon(l.visible ? 'eye' : 'eyeOff', 15));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.altKey) return P.cmd.soloLayer(l);
      P.run(l.visible ? '레이어 숨기기' : '레이어 보이기', () => { l.visible = !l.visible; doc.touch(l); });
      return undefined;
    });
    if (LAYER_COLOR_CSS[l.color]) eye.style.background = LAYER_COLOR_CSS[l.color];
    const twist = l.kind === 'group' ? h('button.ph-twist', { 'aria-label': l.collapsed ? '펼치기' : '접기', 'aria-expanded': String(!l.collapsed), onclick: (e) => { e.stopPropagation(); l.collapsed = !l.collapsed; P.emit('layers'); } }, l.collapsed ? '▸' : '▾') : null;
    const t = thumb(P, l);
    if (!thumbSize) t.style.display = 'none';
    t.title = 'Ctrl(⌘)+클릭: 이 레이어 모양대로 선택 (Shift: 추가, Alt: 빼기, Shift+Alt: 교차) · 두 번 클릭: 편집';
    t.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        P.cmd.selectFromLayer(l, e.shiftKey && e.altKey ? 'inter' : e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new');
        return;
      }
      P.editMask = false;
      P.editFilterMask = null;
      // back from looking at a mask alone (Alt+click on a mask)
      if (P.showMaskOnly) {
        P.showMaskOnly = null;
        P.redraw();
      }
    });
    onDbl(t, `${l.id}:thumb`, () => {
      if (l.kind === 'smart') P.cmd.editSmartContents(l);
      else if (l.kind === 'fill' || l.kind === 'adjust') P.showPanel('props');
      else if (l.kind === 'text' && P.editText) P.editTextLayer(l);
      else P.cmd.layerStyle('blending');
    });
    const mt = l.mask ? thumb(P, l, 'mask') : null;
    if (mt && !thumbSize) mt.style.display = 'none';
    if (mt) {
      mt.title = '마스크 편집 (검정으로 칠하면 숨김, 흰색은 보임) · Shift+클릭: 끄기/켜기 · Alt+클릭: 마스크만 보기';
      mt.classList.add('mask');
      mt.classList.toggle('editing', P.editMask && l.id === doc.activeId);
      mt.classList.toggle('disabled', !l.mask.enabled);
      mt.title = '마스크 편집 (검정으로 칠하면 숨김, 흰색은 보임) · Shift+클릭: 끄기/켜기 · Alt+클릭: 마스크만 보기 · Ctrl+클릭: 선택 영역으로 · 다른 레이어로 끌기: 옮기기 (Alt: 복사)';
      mt.draggable = true;
      mt.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        maskDrag = l.id;
        drag = null;
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', `${l.name} 마스크`);
      });
      mt.addEventListener('dragend', () => { maskDrag = null; });
      onDbl(mt, `${l.id}:mask`, () => {
        P.selectLayer(l.id);
        P.editMask = true;
        P.emit('layers');
        P.showPanel('props');
      });
      mt.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
          P.cmd.selectFromMask?.(l, e.shiftKey && e.altKey ? 'inter' : e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new');
          return;
        }
        if (e.shiftKey) {
          P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: !l.mask.enabled }; doc.touch(l); });
          return;
        }
        if (e.altKey) {
          P.showMaskOnly = P.showMaskOnly === l.id ? null : l.id;
          P.redraw();
        }
        P.selectLayer(l.id);
        P.editMask = true;
        P.emit('layers');
      });
    }
    // the chain between the layer and its mask (Photoshop): linked masks move and transform with the layer
    const chain = (key, name, short) => {
      const on = l[key].linked !== false;
      return h(`button.ph-mlink${on ? '.on' : '.off'}`, {
        title: on ? `레이어와 ${short} 연결됨 (누르면 연결 해제)\n연결되어 있으면 옮기거나 크기를 바꿀 때 같이 움직입니다` : `연결 끊김 (누르면 연결)\n지금은 레이어와 ${short}가 따로 움직입니다`,
        'aria-label': on ? `${name} 연결 해제` : `${name} 연결`,
        'aria-pressed': String(on),
        style: thumbSize ? null : 'display:none',
        // a double click must not open Layer Style (the row's double click)
        ondblclick: (e) => e.stopPropagation(),
        onclick: (e) => {
          e.stopPropagation();
          // read the state now: two quick clicks before the panel redraws still toggle twice
          const cur = doc.layer(l.id);
          if (!cur?.[key]) return;
          const was = cur[key].linked !== false;
          P.run(was ? `${name} 연결 해제` : `${name} 연결`, () => { cur[key] = { ...cur[key], linked: !was }; doc.touch(cur); });
          toast(was ? `${short} 연결을 끊었습니다: 이제 레이어와 따로 움직입니다` : `${short}를 다시 연결했습니다: 레이어와 같이 움직입니다`);
        },
      }, on ? icon('link', 10) : h('span.ph-mlink-slot'));
    };
    const mlink = l.mask ? chain('mask', '레이어 마스크', '마스크') : null;
    const vlink = l.vmask ? chain('vmask', '벡터 마스크', '벡터 마스크') : null;
    const vt = l.vmask ? thumb(P, l, 'vmask') : null;
    if (vt) {
      vt.classList.add('mask', 'vmask');
      vt.title = '벡터 마스크 (패스 선택 도구로 고칩니다) · Shift+클릭: 끄기/켜기';
      vt.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) P.run('벡터 마스크 켜기/끄기', () => { l.vmask = { ...l.vmask, enabled: l.vmask.enabled === false }; doc.touch(l); });
        else {
          P.selectLayer(l.id);
          P.editVectorMask?.(l);
        }
      });
    }
    const fxOn = hasFx(l.fx);
    // the 배경 layer: italic name and a lock at the right (click: make it a normal layer)
    const isBg = l.kind === 'raster' && !l.parent && doc.layers[0] === l && l.name === '배경';
    const badges = [
      isBg ? h('button.ph-badge.ph-bglock', { title: '배경 레이어 (누르면 일반 레이어로 바꿉니다)', 'aria-label': '배경 레이어 잠금 풀기', onclick: (e) => { e.stopPropagation(); P.cmd.layerFromBackground?.(); } }, icon('lock', 12)) : null,
      l.linkId ? h('span.ph-badge', { title: '연결된 레이어' }, icon('link', 12)) : null,
      fxOn ? onDbl(h('button.ph-badge.fx', { title: '효과 보기/숨기기 · 두 번 클릭: 레이어 스타일', onclick: (e) => { e.stopPropagation(); l.fxOpen = !l.fxOpen; P.emit('layers'); } }, 'fx', l.fxOpen ? '▾' : '▸'), `${l.id}:fxb`, () => { l.fxOpen = !l.fxOpen; P.selectLayer(l.id); P.cmd.layerStyle('blending'); }) : null,
      !isBg && (l.locked || l.lockPixels || l.lockPos || l.lockAlpha) ? h('span.ph-badge', { title: '잠김' }, icon('lock', 12)) : null,
    ];
    // the name itself (double-click: rename); the rest of the row is the empty part (double-click: style)
    const nameText = h('span.ph-lnametext', l.name);
    const name = h('span.ph-lname', l.clip ? h('span.ph-clipmark', { title: `아래 레이어(${clipBaseName || ''})에 클리핑됨` }, '↳ ') : null, nameText, l.kind === 'group' && l.blend !== 'pass through' ? h('small', ` · ${blendName(l.blend)}`) : null);
    // double-click the name: rename in place (Enter / clicking away keeps it, Esc cancels)
    onDbl(nameText, `${l.id}:name`, () => {
      const inp = h('input.ph-lrename', { type: 'text', value: l.name, 'aria-label': '레이어 이름', style: { width: '100%', minWidth: '60px' } });
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        if (keep && v && v !== l.name) P.run('이름 바꾸기', () => { l.name = v; doc.touch(l); });
        else render();
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        if (ev.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      for (const ev of ['click', 'dblclick', 'pointerdown']) inp.addEventListener(ev, (x) => x.stopPropagation());
      row.draggable = false;
      nameText.replaceChildren(inp);
      nameText.style.display = 'inline-block';
      nameText.style.width = '100%';
      inp.focus();
      inp.select();
    });
    const row = h(`div.ph-layer${sel.has(l.id) ? '.on' : ''}${l.id === doc.activeId ? '.active' : ''}${doc.shown(l) ? '' : '.hidden'}${l.clip ? '.clipped' : ''}${isBg ? '.bg' : ''}`, {
      role: 'treeitem', 'aria-selected': String(sel.has(l.id)), 'aria-level': String(depth + 1), draggable: 'true', 'data-layer-id': l.id,
      style: { paddingLeft: `${6 + depth * 16 + (l.clip ? 12 : 0)}px` },
    }, eye, twist, t, mlink, mt, vlink, vt, name, h('span.ph-badges', badges));
    row.title = 'Alt+클릭(레이어 사이 선): 클리핑 마스크 · Alt+끌기: 복제 · 빈 곳 두 번 클릭: 레이어 스타일';
    row.addEventListener('click', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        // Alt+click on the line between two layers clips the upper one to the lower one
        const r = row.getBoundingClientRect();
        const sibs = doc.children(l.parent);
        const upper = sibs[sibs.indexOf(l) + 1];
        if ((e.clientY - r.top) / r.height < 0.3 && upper && !filterOn) return P.cmd.toggleClipFor(upper);
        return P.cmd.toggleClipFor(l);
      }
      if (doc.activeId !== l.id) P.editMask = false;
      P.selectLayer(l.id, e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'range' : 'single');
      return undefined;
    });
    onDbl(row, `${l.id}:row`, () => {
      P.selectLayer(l.id);
      if (l.kind === 'fill' || l.kind === 'adjust') P.showPanel('props');
      else P.cmd.layerStyle('blending');
    });
    const menuFor = () => (P.layerContextMenu ? P.layerContextMenu(l) : P.layerMenu());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sel.has(l.id)) P.selectLayer(l.id);
      showMenu(menuFor(), e.clientX, e.clientY);
    });
    // long press on touch: the layer menu
    let lp = null;
    row.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      lp = setTimeout(() => { P.selectLayer(l.id); showMenu(menuFor(), e.clientX, e.clientY); }, 550);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) row.addEventListener(ev, () => clearTimeout(lp));
    row.addEventListener('dragstart', (e) => {
      drag = l.id;
      // dropped on another document's tab or canvas, the layers are copied there (core2.js)
      P.layerDrag = { doc, ids: sel.has(l.id) ? [...sel] : [l.id] };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', l.name);
    });
    row.addEventListener('dragend', () => { drag = null; });
    row.addEventListener('dragover', (e) => {
      if (maskDrag) {
        if (maskDrag === l.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        row.dataset.drop = 'into';
        return;
      }
      if (!drag || drag === l.id) return;
      e.preventDefault();
      // Alt (Option) while dropping: a copy
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const zone = l.kind === 'group' && y > 0.3 && y < 0.7 ? 'into' : y < 0.5 ? 'above' : 'below';
      row.dataset.drop = zone;
    });
    row.addEventListener('dragleave', () => delete row.dataset.drop);
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const zone = row.dataset.drop;
      delete row.dataset.drop;
      if (maskDrag) {
        const from = maskDrag;
        maskDrag = null;
        if (from !== l.id) P.cmd.moveMaskTo(from, l.id, e.altKey);
        return;
      }
      if (!drag || drag === l.id) return;
      const ids = sel.has(drag) ? [...sel] : [drag];
      drag = null;
      const index = zone === 'into' ? doc.index(l.id) : zone === 'above' ? doc.index(l.id) + 1 : doc.block(l.id)[0];
      const parent = zone === 'into' ? l.id : l.parent || null;
      if (e.altKey) P.cmd.duplicateTo(ids, index, parent);
      else if (ids.length > 1 && P.cmd.moveLayersTo) P.cmd.moveLayersTo(ids, l.id, zone);
      else P.cmd.moveLayerTo(ids[0], index, parent);
    });
    rows.push(row);
    // effects and smart filters listed under the layer
    if (fxOn && l.fxOpen) {
      rows.push(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` } }, h('span', '효과')));
      for (const k0 of FX_ORDER) {
        for (const k of instanceKeys(l.fx, k0)) {
          const f = l.fx[k];
          const ey = h('button.ph-eye.small', { 'aria-label': f.enabled ? '효과 끄기' : '효과 켜기' }, icon(f.enabled ? 'eye' : 'eyeOff', 13));
          ey.addEventListener('click', (e) => {
            e.stopPropagation();
            P.run('효과 켜기/끄기', () => { l.fx = { ...l.fx, [k]: { ...f, enabled: !f.enabled } }; l._styled = null; doc.touch(l); });
          });
          const r = onDbl(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` }, title: '두 번 클릭: 설정 바꾸기' }, ey, h('span', FX_NAMES[k0])), `${l.id}:fx:${k}`, () => { P.selectLayer(l.id); P.cmd.layerStyle(k); });
          rows.push(r);
        }
      }
    }
    if (l.kind === 'smart' && l.smart.filters?.length) {
      // the Smart Filters row: its mask (if any) and a menu for it
      const fm = l.filterMask;
      const fmMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        P.selectLayer(l.id);
        const C = P.cmd;
        showMenu([
          { label: '필터 마스크 추가 (모두 보이기)', disabled: !!fm, action: () => C.smartFilterMask(l, 'reveal') },
          { label: '선택 영역에서 필터 마스크', disabled: !P.doc.selection, action: () => C.smartFilterMask(l, 'select') },
          { label: '필터 마스크 반전', disabled: !fm, action: () => C.smartFilterMask(l, 'invert') },
          { label: fm?.enabled === false ? '필터 마스크 사용' : '필터 마스크 사용 안 함', disabled: !fm, action: () => C.smartFilterMask(l, 'toggle') },
          { label: '필터 마스크를 선택 영역으로', disabled: !fm, action: () => C.smartFilterMask(l, 'toSelection') },
          { label: '필터 마스크 삭제', disabled: !fm, action: () => C.smartFilterMask(l, 'delete') },
        ], e.clientX, e.clientY);
      };
      // the filter mask thumbnail: a click picks it for painting (black hides the filters); without a
      // mask yet it shows white and a click makes one, as Photoshop adds it with the first filter
      const fmThumb = h('canvas.ph-thumb.mask', {
        width: 20, height: 20, title: '고급 필터 마스크: 누르고 브러시로 칠하기 (검정: 필터 숨김) · 오른쪽 클릭: 메뉴',
        style: { width: '20px', height: '20px', opacity: fm && fm.enabled === false ? 0.4 : 1 },
      });
      fmThumb.classList.toggle('editing', P.editFilterMask === l.id && l.id === doc.activeId && !P.editMask);
      fmThumb.addEventListener('click', (e) => {
        e.stopPropagation();
        P.cmd.pickFilterMask(l);
      });
      if (!fm?.canvas) {
        const g = fmThumb.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 20, 20);
      } else {
        const g = fmThumb.getContext('2d');
        g.fillStyle = fm.invert ? '#fff' : '#000';
        g.fillRect(0, 0, 20, 20);
        const k = Math.min(20 / P.doc.width, 20 / P.doc.height);
        const t2 = makeCanvas(20, 20);
        const tg = t2.getContext('2d');
        tg.scale(k, k);
        tg.drawImage(fm.canvas, fm.x, fm.y);
        tg.setTransform(1, 0, 0, 1, 0, 0);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = fm.invert ? '#000' : '#fff';
        tg.fillRect(0, 0, 20, 20);
        g.drawImage(t2, 0, 0);
      }
      rows.push(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` }, title: '오른쪽 클릭: 필터 마스크 메뉴', oncontextmenu: fmMenu }, fmThumb, h('span', '고급 필터'),
        h('button.ph-badge', { title: '필터 마스크 메뉴', 'aria-label': '필터 마스크 메뉴', onclick: fmMenu }, icon('mask', 12))));
      l.smart.filters.forEach((f, i) => {
        const ey = h('button.ph-eye.small', { 'aria-label': '필터 켜기/끄기', onclick: (e) => { e.stopPropagation(); P.cmd.smartFilterToggle(l, i); } }, icon(f.enabled === false ? 'eyeOff' : 'eye', 13));
        const del = h('button.ph-badge', { title: '이 고급 필터 지우기', onclick: (e) => { e.stopPropagation(); P.cmd.smartFilterDelete(l, i); } }, '×');
        const opts = h('button.ph-badge', { title: '혼합 옵션 (모드·불투명도)', 'aria-label': '필터 혼합 옵션', onclick: (e) => { e.stopPropagation(); P.cmd.smartFilterBlending?.(l, i); } }, icon('sliders', 12));
        const mixed = (f.blend && f.blend !== 'normal') || (f.opacity != null && f.opacity < 1);
        rows.push(onDbl(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` }, title: '두 번 클릭: 설정 바꾸기' }, ey, h('span', P.filterName?.(f.id) || f.id), mixed ? h('small', ` ${blendName(f.blend || 'normal')} ${Math.round((f.opacity ?? 1) * 100)}%`) : null, opts, del), `${l.id}:sf:${i}`, () => { P.selectLayer(l.id); P.editSmartFilter?.(l, i); }));
      });
    }
    if (l.kind === 'group' && !l.collapsed && !filterOn) renderLevel(l.id, depth + 1, rows);
  };
  const renderLevel = (pid, depth, rows) => {
    const kids = P.doc.children(pid);
    for (let i = kids.length - 1; i >= 0; i--) {
      const l = kids[i];
      // a clipped layer names its base (the nearest unclipped layer below)
      let base = null;
      if (l.clip) for (let j = i - 1; j >= 0; j--) if (!kids[j].clip) { base = kids[j].name; break; }
      rowsFor(l, depth, rows, base);
    }
  };

  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc) {
      head.replaceChildren();
      return;
    }
    const a = doc.active;
    const nb = blendSelect(a?.kind === 'group');
    nb.addEventListener('change', onBlend);
    blend.replaceWith?.(nb);
    blend = nb;
    blend.value = a?.blend || 'normal';
    opacity.value = Math.round((a?.opacity ?? 1) * 100);
    opRange.value = opacity.value;
    fillNum.value = Math.round((a?.fillOpacity ?? 1) * 100);
    fillNum.disabled = !a || a.kind === 'group' || a.kind === 'adjust';
    fillRange.value = fillNum.value;
    fillRange.disabled = fillNum.disabled;
    for (const b of locks) {
      const key = { alpha: 'lockAlpha', pixels: 'lockPixels', position: 'lockPos', all: 'locked' }[b.dataset.lock];
      b.classList.toggle('on', !!a?.[key]);
    }
    head.replaceChildren(
      h('div.ph-lrow', blend, h('label.ph-op', h('span', '불투명도:'), opDrop)),
      h('div.ph-lrow', h('span.ph-lockl', '잠그기:'), h('span.ph-locks', ...locks), h('label.ph-op.fill', h('span', '칠:'), fillDrop)));
    const rows = [];
    dblActions.clear();
    const q = fq.value.trim().toLowerCase();
    const mode = fk.value;
    const test = !filterSwitch ? null
      : mode === 'name' ? (q ? (l) => l.name.toLowerCase().includes(q) : null)
        : mode === 'kind' ? (kindsOn.size ? (l) => [...kindsOn].some((k) => KINDS[k](l)) : null)
          : KINDS[mode];
    el.classList.toggle('filtered', !!test);
    if (test) {
      // a flat list of the matching layers, top first
      filterOn = true;
      for (const l of [...doc.layers].reverse()) if (test(l)) rowsFor(l, 0, rows);
      filterOn = false;
      if (!rows.length) rows.push(h('div.empty-hint', '맞는 레이어가 없습니다'));
    } else renderLevel(null, 0, rows);
    list.append(...rows);
  };
  P.on('layers', render);
  P.on('doc', render);
  return el;
}

// ---------------------------------------------------------------- colour

export function buildColorPanel(P) {
  let target = 'fg';
  // Photoshop's Color panel: small foreground / background squares at the left, the colour field
  // and hue slider at the right (a click on the chosen square opens the Color Picker)
  const pick = (which) => {
    if (target === which && P.colorPicker) return P.colorPicker(which);
    target = which;
    sync();
    return undefined;
  };
  const fgB = h('button.ph-cbig.fg', { title: '전경색 (다시 누르면 색상 피커)', 'aria-label': '전경색', onclick: () => pick('fg') });
  const bgB = h('button.ph-cbig.bg', { title: '배경색 (다시 누르면 색상 피커)', 'aria-label': '배경색', onclick: () => pick('bg') });
  // 색조 큐브, 색상환 and the sliders, chosen in the panel menu (colorpanel.js)
  const views = buildColorViews(P, () => target, (v, done) => P.setColor(v, target === 'bg', !done));
  P.panelMenus = P.panelMenus || {};
  P.panelMenus.color = views.menu;
  const recent = h('div.ph-swatches.recent');
  const sync = () => {
    fgB.style.background = P.fg;
    bgB.style.background = P.bg;
    fgB.classList.toggle('on', target === 'fg');
    bgB.classList.toggle('on', target === 'bg');
    views.sync();
    recent.replaceChildren(...P.recent.slice(0, 16).map((c) => h('button.ph-swatch', { style: { background: c }, title: c, 'aria-label': c, onclick: () => P.setColor(c, target === 'bg') })));
  };
  P.on('color', sync);
  P.on('colortarget', (t) => { target = t; sync(); });
  sync();
  const swap = h('button.ph-cswap', { onclick: () => P.swapColors(), title: '전경색과 배경색 전환 (X)', 'aria-label': '전경색과 배경색 바꾸기' }, icon('swapColors', 11));
  const def = h('button.ph-cdef', { onclick: () => P.defaultColors(), title: '기본 전경색과 배경색 (D)', 'aria-label': '기본 전경색과 배경색' }, icon('defaultColors', 10));
  const sw = h('div.ph-swatches.ph-cswatches', SWATCHES.map((c) => h('button.ph-swatch', { style: { background: c }, title: c, 'aria-label': c, onclick: () => P.setColor(c, target === 'bg') })));
  return h('div.ph-panel.color', h('div.ph-cmain', h('div.ph-cfgbg', bgB, fgB, swap, def), views.el), views.bar, h('div.ph-sub.ph-csub', '견본'), sw, h('div.ph-sub', '최근 색'), recent);
}

// ---------------------------------------------------------------- properties

/** A smart object's bounds in the document: its contents' corners through its transform. */
function smartBox(sm) {
  const m = sm.m;
  const q = sm.corners || [[0, 0], [sm.w, 0], [sm.w, sm.h], [0, sm.h]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function buildPropertiesPanel(P) {
  const el = h('div.ph-panel.props');
  let pending = null;
  const live = (label, fn, done) => {
    if (!pending) pending = P.doc.capture();
    fn();
    P.doc.touch(P.doc.active);
    P.redraw();
    if (done) {
      P.commit(label, pending);
      pending = null;
    }
  };
  const field = (label, ctrl) => h('label.ph-prow', h('span', label), ctrl);
  const numIn = (v, min, max, step, onSet) => {
    const n = h('input.ph-num', { type: 'number', value: v, min, max, step });
    n.addEventListener('change', () => onSet(clamp(+n.value, min, max)));
    return n;
  };
  // 변형 (pixel layers and smart objects, as Photoshop): W / H with a link, X / Y, angle and the flips;
  // each change is one undo step and the linked masks follow (P.transformLayerBy)
  let linkWH = loadPref('photo.props.linkWH', true);
  // the bounds need a scan of the pixels: only while the panel shows (it draws again when it shows),
  // and not right after a change (a brush stroke on a big layer): the last bounds show (fields off)
  // until the scan has run when the browser is idle
  let stale = false;
  const measured = new WeakMap();
  let measuring = 0;
  const pixelBounds = (doc, l) => {
    const m = measured.get(l);
    if (m && m.rev === l.rev && m.canvas === l.canvas) return m.b;
    if (!measuring) {
      const later = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
      measuring = later(() => {
        measuring = 0;
        const a = P.doc?.active;
        if (a?.kind !== 'raster' || !a.canvas || !el.offsetParent) return;
        measured.set(a, { rev: a.rev, canvas: a.canvas, b: P.doc.opaqueBounds(a) });
        render();
      }, { timeout: 400 });
    }
    return m?.b ? { ...m.b, old: true } : undefined;
  };
  const transformRows = (doc, l) => {
    const head = h('div.ph-sub', '변형');
    if (!el.isConnected || !el.offsetParent) {
      stale = true;
      return [head];
    }
    const b = l.kind === 'smart' ? smartBox(l.smart) : pixelBounds(doc, l);
    if (b === undefined) return [head, h('div.note', '크기를 재는 중…')];
    if (!b) return [head, h('div.note', '빈 레이어입니다.')];
    const fixed = l.locked || l.lockPos || b.old;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const go = (label, M) => P.run(label, () => P.transformLayerBy(l, M));
    const scaleTo = (w, hh) => {
      const kx = w / b.w;
      const ky = hh / b.h;
      if (Math.abs(kx - 1) > 1e-6 || Math.abs(ky - 1) > 1e-6) go('변형', [kx, 0, 0, ky, b.x - kx * b.x, b.y - ky * b.y]);
    };
    const moveBy = (dx, dy) => {
      if (!dx && !dy) return;
      // whole pixels move without resampling
      if (l.kind === 'raster') {
        P.run('이동', () => {
          l.x += dx;
          l.y += dy;
          transformMasksBy(doc, l, [1, 0, 0, 1, dx, dy]);
          doc.touch(l);
        });
      } else go('이동', [1, 0, 0, 1, dx, dy]);
    };
    // Photoshop's angle: positive turns clockwise, about the middle
    const ang = l.kind === 'smart' ? Math.round((Math.atan2(l.smart.m[1], l.smart.m[0]) * 1800) / Math.PI) / 10 : 0;
    const turn = (deg) => {
      const t = ((deg - ang) * Math.PI) / 180;
      const [c, s] = [Math.cos(t), Math.sin(t)];
      if (Math.abs(t) > 1e-6) go('회전', [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
    };
    const flip = (horiz) => (l.kind === 'raster' ? P.cmd.transformLayer(horiz ? 'flipH' : 'flipV') : go('뒤집기', horiz ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy]));
    const r1 = (v) => Math.round(v * 10) / 10;
    const wIn = numIn(r1(b.w), 1, 30000, 1, (v) => scaleTo(v, linkWH ? (b.h * v) / b.w : b.h));
    const hIn = numIn(r1(b.h), 1, 30000, 1, (v) => scaleTo(linkWH ? (b.w * v) / b.h : b.w, v));
    const xIn = numIn(Math.round(b.x), -30000, 30000, 1, (v) => moveBy(Math.round(v - b.x), 0));
    const yIn = numIn(Math.round(b.y), -30000, 30000, 1, (v) => moveBy(0, Math.round(v - b.y)));
    const aIn = numIn(ang, -360, 360, 0.1, (v) => turn(v));
    const link = h(`button.small.ph-xlink${linkWH ? '.on' : ''}`, { title: linkWH ? '폭과 높이 비율 유지 (누르면 해제)' : '폭과 높이 연결', 'aria-label': '폭과 높이 연결', 'aria-pressed': String(linkWH), onclick: () => {
      linkWH = !linkWH;
      savePref('photo.props.linkWH', linkWH);
      render();
    } }, icon('link', 13));
    for (const n of [wIn, hIn, xIn, yIn, aIn]) n.disabled = fixed;
    const lab = (t, n, title) => h('label.ph-xf-f', { title }, h('span', t), n);
    return [head,
      h('div.ph-xform',
        lab('W', wIn, '폭 (px)'), link, lab('H', hIn, '높이 (px)'),
        lab('X', xIn, '왼쪽 위치 (px)'), h('span'), lab('Y', yIn, '위쪽 위치 (px)')),
      h('div.ph-prow.ph-xf-row', lab('각도', aIn, '회전 각도 (°, 양수: 시계 방향)'), h('small', '°'),
        h('button.small', { disabled: fixed, title: '가로로 뒤집기', 'aria-label': '가로로 뒤집기', onclick: () => flip(true) }, icon('flipH', 14)),
        h('button.small', { disabled: fixed, title: '세로로 뒤집기', 'aria-label': '세로로 뒤집기', onclick: () => flip(false) }, icon('flipV', 14))),
      fixed ? h('div.note', '위치가 잠긴 레이어입니다.') : null].filter(Boolean);
  };
  new ResizeObserver(() => {
    if (stale && el.offsetParent) render();
  }).observe(el);
  // the panel menu (≡ on the dock's tab bar): commands for what the panel shows
  P.panelMenus = P.panelMenus || {};
  P.panelMenus.props = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l) return [];
    const C = P.cmd;
    return [
      ...(l.kind === 'adjust' ? [
        { label: '아래 레이어에 클립', key: 'Ctrl+Alt+G', checked: !!l.clip, action: () => C.toggleClip() },
        { label: '조정 기본값으로 재설정', action: () => P.run(`${ADJUSTMENTS[l.adjust.type].name} 재설정`, () => { l.adjust = { ...l.adjust, params: defaultParams(l.adjust.type) }; l._cache = null; doc.touch(l); }) },
        '-'] : []),
      ...(l.kind === 'text' ? [
        { label: '문자 패널', action: () => P.showPanel('char') },
        { label: '단락 패널', action: () => P.showPanel('para') },
        { label: '텍스트 뒤틀기…', action: () => P.warpText?.() },
        '-'] : []),
      ...(l.kind === 'raster' || l.kind === 'smart' ? [
        { label: '자유 변형', key: 'Ctrl+T', disabled: l.locked || l.lockPos, action: () => C.freeTransform() },
        '-'] : []),
      ...(l.mask ? [
        { label: '선택 및 마스크…', action: () => C.selectAndMask?.() },
        { label: '마스크를 선택 영역으로', action: () => C.maskToSelection?.() },
        { label: '마스크 반전', action: () => C.invertMask() },
        '-'] : []),
      { label: '레이어 스타일…', disabled: l.kind === 'adjust', action: () => C.layerStyle('blending') },
    ];
  };
  const render = () => {
    const doc = P.doc;
    const l = doc?.active;
    pending = null;
    stale = false;
    if (!l) {
      el.replaceChildren(h('div.empty-hint', '레이어가 없습니다'));
      return;
    }
    const rows = [h('div.ph-ptitle', l.name)];
    if (l.kind === 'text' && l.psdPicture?.canvas && l.psdPicture.key === psdTextKey(l)) rows.push(h('div.note', 'PSD에서 연 글자입니다. 고치기 전까지는 포토샵에서 보던 모양 그대로 보이고, 고치면 이 앱의 글꼴로 다시 그립니다.'));
    if (l.kind === 'text') {
      const t = l.text;
      const ta = h('textarea.ph-ptext', { rows: 3 });
      ta.value = t.content;
      ta.addEventListener('input', () => live('텍스트 내용', () => { l.text = { ...l.text, content: ta.value }; l.name = ta.value.split('\n')[0].slice(0, 30) || '텍스트'; }, false));
      ta.addEventListener('change', () => live('텍스트 내용', () => {}, true));
      const fontB = h('button.small', { style: { fontFamily: `"${t.font}", sans-serif` } }, fontLabel(t.font));
      fontB.addEventListener('click', () => {
        const before = doc.capture();
        const orig = l.text.font;
        openFontPicker(fontB, {
          current: orig, sample: t.content,
          onPreview: (f) => { l.text = { ...l.text, font: f || orig }; doc.touch(l); P.redraw(); },
          onPick: (f) => { l.text = { ...l.text, font: f }; doc.touch(l); P.commit('글꼴', before); },
          onCancel: () => { l.text = { ...l.text, font: orig }; doc.touch(l); P.redraw(); },
        });
      });
      const color = h('input', { type: 'color', value: t.color });
      color.addEventListener('input', () => live('글자 색', () => { l.text = { ...l.text, color: color.value }; }, false));
      color.addEventListener('change', () => live('글자 색', () => {}, true));
      const tog = (key, label) => {
        const b = h(`button.small${t[key] ? '.on' : ''}`, { onclick: () => live(label, () => { l.text = { ...l.text, [key]: !l.text[key] }; }, true) }, label);
        return b;
      };
      const align = h('select', ['left', 'center', 'right'].map((a) => h('option', { value: a }, { left: '왼쪽', center: '가운데', right: '오른쪽' }[a])));
      align.value = t.align || 'left';
      align.addEventListener('change', () => live('정렬', () => { l.text = { ...l.text, align: align.value }; }, true));
      rows.push(ta, field('글꼴', fontB),
        field('크기 (px)', numIn(t.size, 1, 4000, 1, (v) => live('글자 크기', () => { l.text = { ...l.text, size: v }; }, true))),
        field('색', color),
        h('div.ph-prow', tog('bold', '굵게'), tog('italic', '기울임'), align),
        field('줄 간격', numIn(t.lineHeight || 1.2, 0.5, 4, 0.05, (v) => live('줄 간격', () => { l.text = { ...l.text, lineHeight: v }; }, true))),
        field('자간 (px)', numIn(t.letterSpacing || 0, -50, 200, 0.5, (v) => live('자간', () => { l.text = { ...l.text, letterSpacing: v }; }, true))),
        field('회전 (°)', numIn(l.rotation || 0, -360, 360, 1, (v) => live('회전', () => {
          // the linked masks turn along, about the text box's middle (as Free Transform turns it)
          const L = P.textBox(l);
          turnMasks(doc, l, v - (l.rotation || 0), l.x + L.w / 2, l.y + L.h / 2);
          l.rotation = v;
        }, true))),
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.rasterize() }, '이미지로 바꾸기 (래스터화)')));
    } else if (l.kind === 'shape' && P.shapeProperties) {
      rows.push(...P.shapeProperties(l, live));
    } else if (l.kind === 'shape') {
      const s = l.shape;
      const type = h('select', SHAPES.map(([id, n]) => h('option', { value: id }, n)));
      type.value = s.type;
      type.addEventListener('change', () => live('모양 종류', () => { l.shape = { ...l.shape, type: type.value }; }, true));
      const fill = h('input', { type: 'color', value: s.fill || '#000000' });
      const noFill = h('input', { type: 'checkbox', checked: !s.fill });
      fill.addEventListener('input', () => live('채우기', () => { l.shape = { ...l.shape, fill: fill.value }; noFill.checked = false; }, false));
      fill.addEventListener('change', () => live('채우기', () => {}, true));
      noFill.addEventListener('change', () => live('채우기 없음', () => { l.shape = { ...l.shape, fill: noFill.checked ? null : fill.value }; }, true));
      const stroke = h('input', { type: 'color', value: s.stroke || '#000000' });
      stroke.addEventListener('input', () => live('선 색', () => { l.shape = { ...l.shape, stroke: stroke.value }; }, false));
      stroke.addEventListener('change', () => live('선 색', () => {}, true));
      const extra = [];
      if (s.type === 'custom') {
        const cs = h('select', P.customShapeList().map(([v, n]) => h('option', { value: v }, n)));
        cs.value = s.custom || 'heart';
        cs.addEventListener('change', () => live('사용자 정의 모양', () => { l.shape = { ...l.shape, custom: cs.value }; }, true));
        extra.push(field('사용자 정의', cs));
      }
      if (s.type === 'polygon' || s.type === 'star') extra.push(field('면 / 꼭짓점', numIn(s.sides || 5, 3, 100, 1, (v) => live('면 수', () => { l.shape = { ...l.shape, sides: v }; }, true))));
      if (s.type === 'star') extra.push(field('들어감 (%)', numIn(s.indent ?? 60, 1, 99, 1, (v) => live('별 들어감', () => { l.shape = { ...l.shape, indent: v }; }, true))));
      const align = h('select', [['center', '가운데'], ['inside', '안쪽'], ['outside', '바깥쪽']].map(([v, n]) => h('option', { value: v }, n)));
      align.value = s.strokeAlign || 'center';
      align.addEventListener('change', () => live('선 맞춤', () => { l.shape = { ...l.shape, strokeAlign: align.value }; }, true));
      const dash = h('select', [['solid', '실선'], ['dash', '파선'], ['dot', '점선']].map(([v, n]) => h('option', { value: v }, n)));
      dash.value = !s.dash?.length ? 'solid' : s.dash[0] > 1 ? 'dash' : 'dot';
      dash.addEventListener('change', () => live('선 모양', () => { l.shape = { ...l.shape, dash: dash.value === 'dash' ? [4, 2] : dash.value === 'dot' ? [0.01, 2] : null }; }, true));
      extra.push(field('선 맞춤', align), field('선 모양', dash), h('div.ph-prow', h('button.small', { onclick: () => { P.pathTarget = { kind: 'shape', layerId: l.id }; P.setTool('directSelect'); } }, '패스 고치기 (직접 선택)')));
      rows.push(field('모양', type), ...extra,
        field('폭 × 높이', h('span.inline', numIn(s.w, 1, 20000, 1, (v) => live('모양 크기', () => { l.shape = { ...l.shape, w: v }; }, true)), '×', numIn(s.h, 1, 20000, 1, (v) => live('모양 크기', () => { l.shape = { ...l.shape, h: v }; }, true)))),
        field('채우기', h('span.inline', fill, h('label.inline', noFill, '없음'))),
        field('선 색', stroke),
        field('선 두께', numIn(s.strokeWidth || 0, 0, 500, 1, (v) => live('선 두께', () => { l.shape = { ...l.shape, strokeWidth: v, stroke: l.shape.stroke || stroke.value }; }, true))),
        field('모서리 반경', numIn(s.radius || 0, 0, 2000, 1, (v) => live('모서리', () => { l.shape = { ...l.shape, radius: v }; }, true))),
        field('회전 (°)', numIn(l.rotation || 0, -360, 360, 1, (v) => live('회전', () => { l.rotation = v; }, true))),
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.rasterize() }, '이미지로 바꾸기 (래스터화)')));
    } else if (l.kind === 'adjust') {
      const def = ADJUSTMENTS[l.adjust.type];
      rows.push(h('div.ph-sub', `조정: ${def.name}`));
      const params = structuredClone(l.adjust.params);
      rows.push(...paramEditors(def.params, params, (p, done) => live(def.name, () => { l.adjust = { ...l.adjust, params: structuredClone(p) }; l._cache = null; }, done)));
    } else if (l.kind === 'fill') {
      const f = l.fill;
      rows.push(h('div.ph-sub', `칠 레이어: ${FILL_TYPES.find((t) => t[0] === f.type)?.[1] || ''}`));
      const set = (label, patch, done) => live(label, () => { l.fill = { ...l.fill, ...patch }; }, done);
      if (f.type === 'solid') {
        const c = h('input', { type: 'color', value: f.color || '#808080' });
        c.addEventListener('input', () => set('칠 색상', { color: c.value }, false));
        c.addEventListener('change', () => set('칠 색상', {}, true));
        rows.push(field('색', c));
      } else if (f.type === 'gradient') {
        rows.push(field('그레이디언트', gradientPicker(P, f.gradient, (g) => set('그레이디언트', { gradient: g }, true))));
        const st = h('select', GRADIENT_STYLES.map(([v, n]) => h('option', { value: v }, n)));
        st.value = f.style || 'linear';
        st.addEventListener('change', () => set('스타일', { style: st.value }, true));
        rows.push(field('스타일', st),
          field('각도 (°)', numIn(f.angle ?? 90, -180, 180, 1, (v) => set('각도', { angle: v }, true))),
          field('비율 (%)', numIn(f.scale ?? 100, 10, 150, 1, (v) => set('비율', { scale: v }, true))),
          h('label.ph-prow', h('input', { type: 'checkbox', checked: !!f.reverse, onchange: (e) => set('반전', { reverse: e.target.checked }, true) }), '반전'));
      } else {
        const ps = h('select', listPatterns().map((p) => h('option', { value: p.id }, p.name)));
        ps.value = f.pattern || 'checker';
        ps.addEventListener('change', () => set('패턴', { pattern: ps.value }, true));
        rows.push(field('패턴', ps), field('비율 (%)', numIn(f.scale ?? 100, 1, 1000, 1, (v) => set('비율', { scale: v }, true))));
      }
    } else if (l.kind === 'smart') {
      const sm = l.smart;
      const [a, b] = sm.m;
      const scale = Math.hypot(a, b);
      rows.push(h('div.ph-sub', '고급 개체 (원본 화질을 지키며 크기·변형·필터를 바꿀 수 있음)'),
        h('div.ph-prow', h('span', '원본 크기'), h('span.mono', `${sm.w} × ${sm.h}`)),
        h('div.ph-prow', h('span', '배율'), h('span.mono', `${Math.round(scale * 1000) / 10}%  ${Math.round((Math.atan2(b, a) * 180) / Math.PI)}°`)),
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.editSmartContents(l) }, '내용 편집'), h('button.small', { onclick: () => P.cmd.replaceSmartContents() }, '내용 바꾸기…'), h('button.small', { onclick: () => P.cmd.exportSmartContents() }, '내용 내보내기')),
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.rasterize() }, '래스터화 (일반 레이어로)'), h('button.small', { onclick: () => P.cmd.freeTransform() }, '변형')),
        ...transformRows(doc, l));
    } else if (l.kind === 'group' && l.artboard && P.artboardProps) {
      rows.push(...P.artboardProps(l), h('div.ph-prow', h('button.small', { onclick: () => P.cmd.ungroup() }, '대지 그룹 해제')));
    } else if (l.kind === 'group') {
      rows.push(h('div.ph-sub', `그룹 · 레이어 ${doc.descendants(l.id).length}개`), h('div.ph-prow', h('button.small', { onclick: () => P.cmd.mergeGroup() }, '그룹 병합'), h('button.small', { onclick: () => P.cmd.ungroup() }, '그룹 해제')));
    } else {
      rows.push(...(l.kind === 'raster' && l.canvas ? transformRows(doc, l) : [h('div.ph-prow', h('span', '위치'), h('span.mono', `${Math.round(l.x)}, ${Math.round(l.y)}`))]));
      if (l.psdText) rows.push(h('div.note', `PSD의 글자 레이어였습니다: "${String(l.psdText.text || '').slice(0, 40)}"`), h('div.ph-prow', h('button.small', { onclick: () => P.cmd.psdTextToEditable?.(l) }, '고칠 수 있는 글자로 다시 만들기')));
    }
    // mask controls
    if (l.mask) {
      const m = l.mask;
      rows.push(h('div.ph-sub', '레이어 마스크'),
        field('농도 (%)', numIn(Math.round((m.density ?? 1) * 100), 0, 100, 1, (v) => live('마스크 농도', () => { l.mask = { ...l.mask, density: v / 100 }; }, true))),
        field('페더 (px)', numIn(m.feather || 0, 0, 250, 0.5, (v) => live('마스크 페더', () => { l.mask = { ...l.mask, feather: v }; }, true))),
        h('div.ph-prow',
          h('button.small', { onclick: () => P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: !l.mask.enabled }; doc.touch(l); }) }, l.mask.enabled ? '끄기' : '켜기'),
          h('button.small', { onclick: () => P.cmd.invertMask() }, '반전'),
          h('button.small', { onclick: () => P.cmd.maskToSelection?.() }, '선택 영역으로'),
          l.kind === 'raster' ? h('button.small', { onclick: () => P.cmd.applyMask() }, '적용') : null,
          h('button.small', { onclick: () => P.cmd.deleteMask() }, '삭제'),
          h('button.small', { title: l.mask.linked === false ? '연결 끊김 (누르면 연결): 연결하면 옮기거나 크기를 바꿀 때 마스크도 같이 움직입니다' : '레이어와 마스크 연결됨 (누르면 연결 해제)', onclick: () => P.run('마스크 연결', () => { l.mask = { ...l.mask, linked: l.mask.linked === false }; doc.touch(l); }) }, l.mask.linked === false ? '연결' : '연결 해제')));
    }
    if (l.vmask) {
      rows.push(h('div.ph-sub', '벡터 마스크'), h('div.ph-prow',
        h('button.small', { onclick: () => P.run('벡터 마스크 켜기/끄기', () => { l.vmask = { ...l.vmask, enabled: l.vmask.enabled === false }; doc.touch(l); }) }, l.vmask.enabled === false ? '켜기' : '끄기'),
        h('button.small', { onclick: () => P.cmd.rasterizeVectorMask?.() }, '래스터화'),
        h('button.small', { onclick: () => P.run('벡터 마스크 삭제', () => { l.vmask = null; doc.touch(l); }) }, '삭제')));
    }
    if (l.kind !== 'adjust') rows.push(h('div.ph-prow', h('button.small', { onclick: () => P.cmd.layerStyle('blending') }, 'fx 레이어 스타일…'), h('button.small', { onclick: () => P.cmd.convertToSmart() }, l.kind === 'smart' ? '고급 개체 안에 넣기' : '고급 개체로 변환')));
    el.replaceChildren(...rows);
  };
  P.on('layers', render);
  P.on('doc', render);
  return el;
}

// ---------------------------------------------------------------- history

export function buildHistoryPanel(P) {
  const list = h('div.ph-hlist', { role: 'list' });
  /** Snapshots: states kept by name (Photoshop's History snapshots); the first is the opened state. */
  const snapshots = (doc) => [
    ...(doc.openState ? [{ id: 'open', name: '처음 연 상태 (또는 마지막 저장)', state: doc.openState, fixed: true }] : []),
    ...(doc.snapshots || []),
  ];
  let count = 0;
  P.newSnapshot = async (name) => {
    const doc = P.doc;
    if (!doc) return;
    const n = name ?? (await promptDialog('새 스냅숏', '지금 모습을 이 이름으로 기억합니다 (작업 내역이 넘쳐도 남음)', `스냅숏 ${++count}`));
    if (n == null) return;
    doc.snapshots = [...(doc.snapshots || []), { id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: n.trim() || `스냅숏 ${count}`, state: doc.capture() }];
    toast(`스냅숏 "${n.trim() || `스냅숏 ${count}`}"을(를) 만들었습니다`);
    render();
  };
  const toSnapshot = (s) => P.run(`스냅숏으로: ${s.name}`, () => P.doc.restore(s.state));
  const snapshotToDoc = (s) => {
    const d = new PhotoDoc({ name: s.name, width: 1, height: 1, background: null });
    d.restore(s.state);
    d.name = `${P.doc.name} (${s.name})`;
    d.saved = false;
    P.openDoc(d);
  };
  P.stateToDoc = () => snapshotToDoc({ name: '복사', state: P.doc.capture() });
  // the dock's panel menu (≡) for this panel
  P.panelMenus = P.panelMenus || {};
  P.panelMenus.history = () => [
    { label: '단계 앞으로', key: 'Shift+Ctrl+Z', disabled: !P.doc?.history.redoStack?.length, action: () => P.redo() },
    { label: '단계 뒤로', key: 'Ctrl+Z', disabled: !P.doc?.history.undoStack.length, action: () => P.undo() },
    '-',
    { label: '새 스냅숏…', disabled: !P.doc, action: () => P.newSnapshot() },
    { label: '새 문서', disabled: !P.doc, action: () => P.stateToDoc() },
    '-',
    { label: '작업 내역 옵션…', action: () => P.cmd.historyOptions?.() },
  ];
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc) return;
    const hist = doc.history;
    // the brush mark picks the state the history brush paints back
    const src = (e) => h(`button.ph-hsrc${(doc._histSrc || null) === e ? '.on' : ''}`, { title: '작업 내역 브러시의 원본으로', 'aria-label': '작업 내역 브러시 원본', onclick: () => { doc._histSrc = e; render(); } }, icon('historyBrush', 14));
    const items = snapshots(doc).map((s) => {
      const row = h('button.ph-hrow.snap', { title: '눌러서 이 모습으로 (실행 취소 가능) · 오른쪽 클릭: 메뉴', onclick: () => toSnapshot(s) }, icon('camera', 14), ` ${s.name}`);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: '이 모습으로 돌아가기', action: () => toSnapshot(s) },
          { label: '이 모습으로 새 문서 만들기', action: () => snapshotToDoc(s) },
          { label: '이름 바꾸기…', disabled: s.fixed, action: async () => { const v = await promptDialog('스냅숏 이름', '이름', s.name); if (v?.trim()) { s.name = v.trim(); render(); } } },
          { label: '삭제', disabled: s.fixed, action: () => { doc.snapshots = doc.snapshots.filter((x) => x !== s); if (doc._histSrc === s) doc._histSrc = null; render(); } },
        ], e.clientX, e.clientY);
      });
      return h('div.ph-hline', src(s), row);
    });
    if (items.length) items.push(h('div.ph-hsep'));
    items.push(h('div.ph-hline', src(null), h(`button.ph-hrow${hist.undoStack.length === 0 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(-1); P.afterHistory(); } }, `${doc.name} (작업 내역 처음)`)));
    hist.undoStack.forEach((e, i) => items.push(h('div.ph-hline', src(e), h(`button.ph-hrow${i === hist.undoStack.length - 1 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(i); P.afterHistory(); } }, e.label))));
    [...hist.redoStack].reverse().forEach((e, i) => items.push(h('button.ph-hrow.redo', { onclick: () => { for (let k = 0; k <= i; k++) hist.redo(); P.afterHistory(); } }, e.label)));
    list.append(...items);
    list.querySelector('.ph-hrow.on')?.scrollIntoView({ block: 'nearest' });
  };
  const foot = h('div.ph-hfoot',
    h('button.small', { title: '지금 모습을 스냅숏으로 기억 (작업 내역이 넘쳐도 남음)', onclick: () => P.newSnapshot() }, icon('camera', 14), ' 새 스냅숏'),
    h('button.small', { title: '지금 모습으로 새 문서 만들기', onclick: () => (P.doc ? P.stateToDoc() : null) }, icon('plus', 13), ' 새 문서로'));
  P.on('history', render);
  P.on('doc', render);
  return h('div.ph-panel.history', list, foot);
}

/** A button showing a gradient; opens the gradient editor. onChange(gradient). */
export function gradientPicker(P, gr, onChange) {
  const b = h('button.ph-gradbtn', { title: '그레이디언트 고르기·편집', type: 'button' });
  const paint = (g) => b.replaceChildren(gradientSwatch(g, 140, 18, P.fg, P.bg));
  paint(gr || GRADIENTS[0]);
  b.addEventListener('click', async () => {
    const D = await import('./pdialogs.js');
    D.gradientEditor(P, gr || GRADIENTS[0], (g) => {
      gr = g;
      paint(g);
      onChange(g);
    });
  });
  return b;
}

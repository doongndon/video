// Photo editor panels: toolbar, tool options bar, layers, colour, properties and history.

import { h, clamp } from '../util.js';
import { showMenu, toast } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openFontPicker } from '../ui/font-picker.js';
import { fontLabel } from '../fonts.js';
import { makeCanvas, SHAPES, LAYER_COLORS, FILL_TYPES } from './doc.js';
import { GRADIENTS, GRADIENT_STYLES, gradientSwatch, listPatterns } from './resources.js';
import { BLEND_GROUPS, PASS_THROUGH, blendName } from './blend.js';
import { hasFx, FX_NAMES } from './styles.js';

const FX_ORDER = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { ADJUSTMENTS } from './adjust.js';
import { createColorPicker } from './colorpicker.js';
import { paramEditors } from './pdialogs.js';

const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#c0c0c0', '#ff0000', '#ff7f00', '#ffd400', '#7fd400', '#00b050', '#00b0b0', '#0070c0', '#3a3aff', '#7030a0', '#ff4fa3', '#8b4513', '#f5deb3', '#ffe680', '#a8e6ff', '#2b2b2b', '#e8eaed'];

// ---------------------------------------------------------------- toolbar

/** The list of tools in a toolbar slot, shown beside it while hovering (like Photoshop's flyout). */
function toolFlyout(P, onPick) {
  const el = h('div.ph-flyout', { role: 'menu', hidden: true });
  document.body.append(el);
  let openT = 0;
  let closeT = 0;
  let cur = null;
  const close = () => {
    clearTimeout(openT);
    el.hidden = true;
    cur = null;
  };
  const show = (b, g) => {
    cur = b;
    el.replaceChildren(...g.map((id) => {
      const t = TOOL_BY_ID[id];
      return h(`button.ph-fly-item${id === P.tool ? '.on' : ''}`, { role: 'menuitem', onclick: () => { onPick(g, id); P.setTool(id); close(); } },
        icon(t.icon, 18), h('span', t.name), t.key ? h('kbd', t.key) : null);
    }));
    el.hidden = false;
    const r = b.getBoundingClientRect();
    el.style.left = `${r.right + 4}px`;
    el.style.top = `${Math.min(r.top, window.innerHeight - el.offsetHeight - 8)}px`;
  };
  el.addEventListener('pointerenter', () => clearTimeout(closeT));
  el.addEventListener('pointerleave', () => { closeT = setTimeout(close, 220); });
  P.on('tool', close);
  return {
    open(b, g) {
      clearTimeout(closeT);
      clearTimeout(openT);
      if (!el.hidden && cur !== b) return show(b, g);
      openT = setTimeout(() => show(b, g), 380);
      return undefined;
    },
    leave() {
      clearTimeout(openT);
      closeT = setTimeout(close, 220);
    },
  };
}

export function buildToolbar(P) {
  const groupPick = new Map(TOOL_GROUPS.map((g) => [g[0], g[0]]));
  const el = h('div.ph-tools', { role: 'toolbar', 'aria-label': '도구' });
  const swFg = h('button.ph-sw.fg', { title: '전경색 (누르면 색 패널)', 'aria-label': '전경색', onclick: () => P.showPanel('color', 'fg') });
  const swBg = h('button.ph-sw.bg', { title: '배경색', 'aria-label': '배경색', onclick: () => P.showPanel('color', 'bg') });
  const swap = h('button.ph-swap', { title: '전경/배경색 바꾸기 (X)', 'aria-label': '색 바꾸기', onclick: () => P.swapColors() }, '⇄');
  const def = h('button.ph-def', { title: '기본 색 (D)', 'aria-label': '기본 색', onclick: () => P.defaultColors() }, '◩');
  const qm = h('button.ph-tool.ph-qm', { title: '빠른 마스크 모드로 편집 (Q) · 두 번 눌러 옵션', 'aria-label': '빠른 마스크', onclick: () => P.cmd.quickMask?.(), ondblclick: () => P.cmd.quickMaskOptions?.() }, icon('quickMask', 18));
  const syncQm = () => qm.classList.toggle('on', !!P.doc?.quickMask);
  const btns = [];
  const flyout = toolFlyout(P, (g, id) => groupPick.set(g[0], id));
  const render = () => {
    el.replaceChildren();
    for (const g of TOOL_GROUPS) {
      const cur = g.includes(P.tool) ? P.tool : groupPick.get(g[0]) || g[0];
      const t = TOOL_BY_ID[cur];
      const b = h(`button.ph-tool${g.includes(P.tool) ? '.on' : ''}`, {
        title: `${t.name}${t.key ? ` (${t.key})` : ''}${g.length > 1 ? ' · 오른쪽 클릭/길게 눌러 다른 도구' : ''}`,
        'aria-label': t.name,
        onclick: () => P.setTool(cur),
      }, icon(t.icon, 18), g.length > 1 ? h('span.ph-more') : null);
      const menu = (e) => {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        showMenu(g.map((id) => ({ label: `${TOOL_BY_ID[id].name}${TOOL_BY_ID[id].key ? `  (${TOOL_BY_ID[id].key})` : ''}`, checked: id === P.tool, action: () => { groupPick.set(g[0], id); P.setTool(id); } })), r.right + 2, r.top);
      };
      if (g.length > 1) {
        // hovering shows the hidden tools of this slot (mouse only; touch uses a long press)
        b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') flyout.open(b, g); });
        b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') flyout.leave(); });
        b.addEventListener('contextmenu', menu);
        let timer = null;
        b.addEventListener('pointerdown', (e) => { timer = setTimeout(() => menu(e), 500); });
        b.addEventListener('pointerup', () => clearTimeout(timer));
        b.addEventListener('pointerleave', () => clearTimeout(timer));
      }
      btns.push(b);
      el.append(b);
    }
    el.append(h('div.ph-colors', swBg, swFg, swap, def), qm);
    syncQm();
    swFg.style.background = P.fg;
    swBg.style.background = P.bg;
  };
  P.on('tool', (id) => {
    for (const g of TOOL_GROUPS) if (g.includes(id)) groupPick.set(g[0], id);
    render();
  });
  P.on('color', () => {
    swFg.style.background = P.fg;
    swBg.style.background = P.bg;
  });
  P.on('quickmask', syncQm);
  P.on('history', syncQm);
  P.on('layers', syncQm);
  render();
  return el;
}

/** Phone: one scrolling strip with every tool. */
export function buildToolStrip(P) {
  const el = h('div.ph-strip', { role: 'toolbar', 'aria-label': '도구' });
  const render = () => {
    el.replaceChildren(...TOOLS.map((t) => h(`button.ph-stool${t.id === P.tool ? '.on' : ''}`, { onclick: () => P.setTool(t.id), 'aria-label': t.name, title: t.name }, icon(t.icon, 20), h('span', t.name.replace(/ \(.*\)/, '')))));
    el.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  P.on('tool', render);
  render();
  return el;
}

// ---------------------------------------------------------------- options bar

export function buildOptionsBar(P) {
  const el = h('div.ph-opts');
  const render = () => {
    const t = TOOL_BY_ID[P.tool];
    const o = P.opts(t.id);
    const ctrls = [];
    for (const def of t.options) {
      const [key, label, type, min, max, , list] = def;
      // ranges keep their unit where a select keeps its list
      const unit = typeof list === 'string' ? list : def[7];
      if (t.id === 'shape' && ((key === 'sides' && !['polygon', 'star'].includes(o.type)) || (key === 'radius' && o.type !== 'round'))) continue;
      if (type === 'range' || type === 'number') {
        const r = type === 'range' ? h('input', { type: 'range', min, max, value: o[key], 'aria-label': label }) : null;
        const n = h('input.ph-num', { type: 'number', min, max, value: o[key], 'aria-label': label });
        const set = (v) => {
          const val = clamp(Math.round(+v), min, max);
          P.setOpt(t.id, key, val);
          if (r) r.value = val;
          n.value = val;
        };
        r?.addEventListener('input', () => set(r.value));
        n.addEventListener('change', () => set(n.value));
        ctrls.push(h('label.ph-opt', h('span', label), r, n, unit && typeof unit === 'string' ? h('small', unit) : null));
      } else if (type === 'bool') {
        const b = h('input', { type: 'checkbox', checked: !!o[key] });
        b.addEventListener('change', () => P.setOpt(t.id, key, b.checked));
        ctrls.push(h('label.ph-opt', b, h('span', label)));
      } else if (type === 'select') {
        if (key === 'custom' && o.type !== 'custom') continue;
        if (key === 'sides' && !['polygon', 'star'].includes(o.type)) continue;
        const items = list === 'customShapes' ? P.customShapeList() : typeof list === 'function' ? list() : list;
        const s = h('select', { 'aria-label': label }, items.map(([v, txt]) => h('option', { value: v }, txt)));
        s.value = o[key];
        s.addEventListener('change', () => P.setOpt(t.id, key, isNaN(+s.value) || s.value === '' ? s.value : +s.value));
        ctrls.push(h('label.ph-opt', h('span', label), s));
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
        ctrls.push(numIn2('x', 'X', 'px'), numIn2('y', 'Y', 'px'), numIn2('w', '폭', '%', 0.1), h('label.ph-opt', link, h('span', '🔗')), numIn2('h', '높이', '%', 0.1), numIn2('angle', '회전', '°', 0.1), numIn2('skew', '기울기', '°', 0.1));
      }
      ctrls.push(h('button.primary.small', { onclick: () => P.applyTransform() }, '✓ 적용'), h('button.small', { onclick: () => P.cancelTransform() }, '✕ 취소'));
      el.replaceChildren(h('span.ph-tname', icon('move', 16), '변형'), ...ctrls);
      return;
    } else if (t.id === 'crop') {
      ctrls.push(h('button.primary.small', { onclick: () => t.apply(P) }, '✓ 자르기'), h('button.small', { onclick: () => { t.activate(P); } }, '되돌리기'));
    } else if (t.id === 'clone') {
      ctrls.push(h('button.small', { onclick: () => { P.cloneSourceNext = true; toast('복제할 원본 위치를 누르세요'); }, title: '휴대폰: 이 버튼을 누른 뒤 원본 위치를 누르세요' }, '원본 정하기'));
    } else if (['pen', 'freePen', 'pathSelect', 'directSelect', 'addAnchor', 'deleteAnchor', 'convertPoint'].includes(t.id)) {
      ctrls.push(h('span.ph-opt', '만들기:'),
        h('button.small', { onclick: () => P.cmd.pathToSelection() }, '선택 영역'),
        h('button.small', { onclick: () => P.cmd.addVectorMask('path') }, '마스크'),
        h('button.small', { onclick: () => P.cmd.pathToShape?.() }, '모양'),
        P.doc?.workPath ? h('button.small', { onclick: () => P.cmd.savePath() }, '패스 저장') : null);
    } else if (TOOL_BY_ID[t.id]?.optionsFrom === 'text') {
      ctrls.push(h('button.small', { onclick: () => (P.doc?.active?.kind === 'text' ? P.warpText() : toast('글자 레이어를 고르세요')) }, '⌒ 뒤틀기'), h('button.small', { onclick: () => P.showPanel('char') }, '문자 패널'));
    } else if (t.optionButtons) {
      ctrls.push(...t.optionButtons(P).filter(Boolean));
    }
    if (P.doc?.active?.mask && ['brush', 'pencil', 'eraser', 'bucket', 'gradient'].includes(t.id)) {
      ctrls.push(h('span.ph-opt.ph-hint', P.editMask ? '◐ 마스크에 칠하는 중 (검정=숨김, 흰색=보임)' : ''));
    }
    el.replaceChildren(h('span.ph-tname', icon(t.icon, 16), t.name), ...ctrls);
  };
  P.on('tool', render);
  P.on('opts', render);
  P.on('transform', render);
  P.on('layers', render);
  render();
  return el;
}

// ---------------------------------------------------------------- layers

const thumbCache = new WeakMap();
function thumb(P, l, which = 'content') {
  const c = h('canvas.ph-thumb', { width: 40, height: 40 });
  const doc = P.doc;
  const key = `${l.rev}:${which}:${doc.width}x${doc.height}`;
  const cache = thumbCache.get(l)?.[which];
  if (cache?.key === key && cache.doc === doc.id) {
    c.getContext('2d').drawImage(cache.c, 0, 0);
    return c;
  }
  const g = c.getContext('2d');
  const s = Math.min(40 / doc.width, 40 / doc.height);
  const w = doc.width * s;
  const hh = doc.height * s;
  g.save();
  g.translate((40 - w) / 2, (40 - hh) / 2);
  if (which === 'mask' && l.mask) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hh);
    const t = makeCanvas(40, 40);
    const tg = t.getContext('2d');
    tg.scale(s, s);
    tg.drawImage(l.mask.canvas, l.mask.x, l.mask.y);
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = '#fff';
    tg.fillRect(0, 0, 40, 40);
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
    g.fillStyle = '#fff';
    g.font = 'bold 18px sans-serif';
    g.textAlign = 'center';
    g.fillText('◐', w / 2, hh / 2 + 6);
  } else if (l.kind === 'group') {
    g.restore();
    g.fillStyle = '#c9a54a';
    g.fillRect(4, 10, 32, 22);
    g.fillRect(4, 7, 13, 5);
    g.fillStyle = '#e4c870';
    g.fillRect(4, 14, 32, 18);
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
    g.fillStyle = '#fff';
    g.fillRect(28, 28, 11, 11);
    g.strokeStyle = '#333';
    g.strokeRect(28.5, 28.5, 10, 10);
    g.fillStyle = '#333';
    g.fillRect(31, 31, 5, 5);
  }
  if (l.kind === 'text') {
    g.fillStyle = 'rgba(0,0,0,.65)';
    g.fillRect(0, 26, 14, 14);
    g.fillStyle = '#fff';
    g.font = 'bold 11px sans-serif';
    g.fillText('T', 3, 37);
  }
  const copy = makeCanvas(40, 40);
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
  const lockBtn = (kind, label, glyph) => h('button.small.ph-lock', { title: label, 'aria-label': label, 'data-lock': kind, onclick: () => P.cmd.lock(kind) }, glyph);
  const locks = [lockBtn('alpha', '투명 픽셀 잠그기 (칠한 곳에만 칠하기)', '▦'), lockBtn('pixels', '이미지 픽셀 잠그기 (칠하기 막기)', '✎'), lockBtn('position', '위치 잠그기 (옮기기 막기)', '✥'), lockBtn('all', '모두 잠그기', icon('lock', 13))];
  const list = h('div.ph-layers', { role: 'tree', 'aria-label': '레이어', 'aria-multiselectable': 'true' });
  const footBtn = (ic, label, fn) => h('button.small', { title: label, 'aria-label': label, onclick: fn }, typeof ic === 'string' && ic.length > 2 ? icon(ic, 15) : ic);
  const menuAt = (e, items) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(items, r.left, r.top - 4);
  };
  const foot = h('div.ph-lfoot',
    footBtn('link', '레이어 연결', () => (P.doc?.active?.linkId ? P.cmd.unlink() : P.cmd.link())),
    footBtn('fx', '레이어 스타일 추가', (e) => menuAt(e, [{ label: '혼합 옵션…', action: () => P.cmd.layerStyle('blending') }, '-', ...FX_ORDER.map((k) => ({ label: `${FX_NAMES[k]}…`, action: () => P.cmd.layerStyle(k) }))])),
    footBtn('mask', '레이어 마스크 추가 (Alt: 모두 숨김)', (e) => P.cmd.addMask(e.altKey)),
    footBtn('◐', '새 칠 또는 조정 레이어', (e) => menuAt(e, P.newFillOrAdjustMenu())),
    footBtn('folderPlus', '새 그룹 (Ctrl+G: 고른 레이어로 그룹 만들기)', () => P.cmd.newGroup()),
    footBtn('plus', '새 레이어', () => P.cmd.newLayer()),
    footBtn('trash', '레이어 삭제', () => P.cmd.deleteLayer()));
  const head = h('div.ph-lhead');
  const el = h('div.ph-panel.layers', head, list, foot);

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
  fillNum.addEventListener('change', () => setNum('fillOpacity', +fillNum.value, true));
  const onBlend = () => {
    const d = P.doc;
    const v = blend.value;
    if (d) P.run('혼합 모드', () => { for (const l of d.selectedLayers) { if (v === 'pass through' && l.kind !== 'group') continue; l.blend = v; d.touch(l); } });
  };

  let drag = null;
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
    t.title = 'Ctrl(⌘)+클릭: 이 레이어 모양대로 선택 · 두 번 클릭: 편집';
    t.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        P.cmd.selectFromLayer(l, e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new');
        return;
      }
      P.editMask = false;
    });
    t.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (l.kind === 'smart') P.cmd.editSmartContents(l);
      else if (l.kind === 'fill' || l.kind === 'adjust') P.showPanel('props');
      else P.cmd.layerStyle('blending');
    });
    const mt = l.mask ? thumb(P, l, 'mask') : null;
    if (mt) {
      mt.title = '마스크 편집 (검정으로 칠하면 숨김, 흰색은 보임) · Shift+클릭: 끄기/켜기 · Alt+클릭: 마스크만 보기';
      mt.classList.add('mask');
      mt.classList.toggle('editing', P.editMask && l.id === doc.activeId);
      mt.classList.toggle('disabled', !l.mask.enabled);
      mt.addEventListener('click', (e) => {
        e.stopPropagation();
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
    const badges = [
      l.linkId ? h('span.ph-badge', { title: '연결된 레이어' }, icon('link', 12)) : null,
      fxOn ? h('button.ph-badge.fx', { title: '효과 보기/숨기기', onclick: (e) => { e.stopPropagation(); l.fxOpen = !l.fxOpen; P.emit('layers'); } }, 'fx', l.fxOpen ? '▾' : '▸') : null,
      l.locked || l.lockPixels || l.lockPos || l.lockAlpha ? h('span.ph-badge', { title: '잠김' }, icon('lock', 12)) : null,
    ];
    const name = h('span.ph-lname', l.clip ? h('span.ph-clipmark', { title: `아래 레이어(${clipBaseName || ''})에 클리핑됨` }, '↳ ') : null, h('span', l.name), l.kind === 'group' && l.blend !== 'pass through' ? h('small', ` · ${blendName(l.blend)}`) : null);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      P.cmd.renameLayer(l);
    });
    const row = h(`div.ph-layer${sel.has(l.id) ? '.on' : ''}${l.id === doc.activeId ? '.active' : ''}${doc.shown(l) ? '' : '.hidden'}${l.clip ? '.clipped' : ''}`, {
      role: 'treeitem', 'aria-selected': String(sel.has(l.id)), 'aria-level': String(depth + 1), draggable: 'true',
      style: { paddingLeft: `${6 + depth * 16 + (l.clip ? 12 : 0)}px` },
    }, eye, twist, t, mt, vt, name, h('span.ph-badges', badges));
    row.addEventListener('click', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey) return P.cmd.toggleClipFor(l);
      if (doc.activeId !== l.id) P.editMask = false;
      P.selectLayer(l.id, e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'range' : 'single');
      return undefined;
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sel.has(l.id)) P.selectLayer(l.id);
      showMenu(P.layerMenu(), e.clientX, e.clientY);
    });
    // long press on touch: the layer menu
    let lp = null;
    row.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      lp = setTimeout(() => { P.selectLayer(l.id); showMenu(P.layerMenu(), e.clientX, e.clientY); }, 550);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) row.addEventListener(ev, () => clearTimeout(lp));
    row.addEventListener('dragstart', (e) => {
      drag = l.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', l.name);
    });
    row.addEventListener('dragover', (e) => {
      if (!drag || drag === l.id) return;
      e.preventDefault();
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
      if (!drag || drag === l.id) return;
      if (zone === 'into') P.cmd.moveLayerTo(drag, doc.index(l.id), l.id);
      else if (zone === 'above') P.cmd.moveLayerTo(drag, doc.index(l.id) + 1, l.parent || null);
      else P.cmd.moveLayerTo(drag, doc.block(l.id)[0], l.parent || null);
      drag = null;
    });
    rows.push(row);
    // effects and smart filters listed under the layer
    if (fxOn && l.fxOpen) {
      rows.push(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` } }, h('span', '효과')));
      for (const k of FX_ORDER) {
        const f = l.fx[k];
        if (!f) continue;
        const ey = h('button.ph-eye.small', { 'aria-label': f.enabled ? '효과 끄기' : '효과 켜기' }, icon(f.enabled ? 'eye' : 'eyeOff', 13));
        ey.addEventListener('click', (e) => {
          e.stopPropagation();
          P.run('효과 켜기/끄기', () => { l.fx = { ...l.fx, [k]: { ...f, enabled: !f.enabled } }; l._styled = null; doc.touch(l); });
        });
        const r = h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` }, ondblclick: () => { P.selectLayer(l.id); P.cmd.layerStyle(k); } }, ey, h('span', FX_NAMES[k]));
        rows.push(r);
      }
    }
    if (l.kind === 'smart' && l.smart.filters?.length) {
      rows.push(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` } }, h('span', '고급 필터')));
      l.smart.filters.forEach((f, i) => {
        const ey = h('button.ph-eye.small', { 'aria-label': '필터 켜기/끄기', onclick: (e) => { e.stopPropagation(); P.cmd.smartFilterToggle(l, i); } }, icon(f.enabled === false ? 'eyeOff' : 'eye', 13));
        const del = h('button.ph-badge', { title: '이 고급 필터 지우기', onclick: (e) => { e.stopPropagation(); P.cmd.smartFilterDelete(l, i); } }, '×');
        rows.push(h('div.ph-subrow', { style: { paddingLeft: `${46 + depth * 16}px` }, title: '두 번 클릭: 설정 바꾸기', ondblclick: () => { P.selectLayer(l.id); P.editSmartFilter?.(l, i); } }, ey, h('span', P.filterName?.(f.id) || f.id), del));
      });
    }
    if (l.kind === 'group' && !l.collapsed) renderLevel(l.id, depth + 1, rows);
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
    for (const b of locks) {
      const key = { alpha: 'lockAlpha', pixels: 'lockPixels', position: 'lockPos', all: 'locked' }[b.dataset.lock];
      b.classList.toggle('on', !!a?.[key]);
    }
    head.replaceChildren(
      h('div.ph-lrow', blend, h('label.ph-op', '불투명도', opRange, opacity)),
      h('div.ph-lrow', h('span.ph-lockl', '잠그기:'), ...locks, h('label.ph-op.fill', '칠', fillNum)));
    const rows = [];
    renderLevel(null, 0, rows);
    list.append(...rows);
  };
  P.on('layers', render);
  P.on('doc', render);
  return el;
}

// ---------------------------------------------------------------- colour

export function buildColorPanel(P) {
  let target = 'fg';
  const fgB = h('button.ph-cbig.fg', { onclick: () => { target = 'fg'; sync(); } }, '전경');
  const bgB = h('button.ph-cbig.bg', { onclick: () => { target = 'bg'; sync(); } }, '배경');
  const picker = createColorPicker({ value: P.fg, onChange: (v, done) => P.setColor(v, target === 'bg', !done) });
  const sw = h('div.ph-swatches', SWATCHES.map((c) => h('button.ph-swatch', { style: { background: c }, title: c, 'aria-label': c, onclick: () => P.setColor(c, target === 'bg') })));
  const recent = h('div.ph-swatches.recent');
  const sync = () => {
    fgB.style.background = P.fg;
    bgB.style.background = P.bg;
    fgB.classList.toggle('on', target === 'fg');
    bgB.classList.toggle('on', target === 'bg');
    picker.set(target === 'fg' ? P.fg : P.bg);
    recent.replaceChildren(...P.recent.map((c) => h('button.ph-swatch', { style: { background: c }, title: c, 'aria-label': c, onclick: () => P.setColor(c, target === 'bg') })));
  };
  P.on('color', sync);
  P.on('colortarget', (t) => { target = t; sync(); });
  sync();
  return h('div.ph-panel.color', h('div.ph-crow', fgB, bgB, h('button.small', { onclick: () => P.swapColors(), title: '바꾸기 (X)' }, '⇄')), picker.el, h('div.ph-sub', '견본'), sw, h('div.ph-sub', '최근 색'), recent);
}

// ---------------------------------------------------------------- properties

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
  const render = () => {
    const doc = P.doc;
    const l = doc?.active;
    pending = null;
    if (!l) {
      el.replaceChildren(h('div.empty-hint', '레이어가 없습니다'));
      return;
    }
    const rows = [h('div.ph-ptitle', l.name)];
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
        field('회전 (°)', numIn(l.rotation || 0, -360, 360, 1, (v) => live('회전', () => { l.rotation = v; }, true))),
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.rasterize() }, '이미지로 바꾸기 (래스터화)')));
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
        h('div.ph-prow', h('button.small', { onclick: () => P.cmd.rasterize() }, '래스터화 (일반 레이어로)'), h('button.small', { onclick: () => P.cmd.freeTransform() }, '변형')));
    } else if (l.kind === 'group') {
      rows.push(h('div.ph-sub', `그룹 · 레이어 ${doc.descendants(l.id).length}개`), h('div.ph-prow', h('button.small', { onclick: () => P.cmd.mergeGroup() }, '그룹 병합'), h('button.small', { onclick: () => P.cmd.ungroup() }, '그룹 해제')));
    } else {
      rows.push(h('div.ph-prow', h('span', '위치'), h('span.mono', `${Math.round(l.x)}, ${Math.round(l.y)}`)),
        h('div.ph-prow', h('span', '크기'), h('span.mono', l.canvas ? `${l.canvas.width} × ${l.canvas.height}` : '-')));
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
          h('button.small', { title: '연결하면 레이어를 옮길 때 마스크도 같이 움직입니다', onclick: () => P.run('마스크 연결', () => { l.mask = { ...l.mask, linked: l.mask.linked === false }; doc.touch(l); }) }, l.mask.linked === false ? '연결' : '연결 해제')));
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
  const el = h('div.ph-panel.history', { role: 'list' });
  const render = () => {
    const doc = P.doc;
    el.replaceChildren();
    if (!doc) return;
    const hist = doc.history;
    // the brush mark picks the state the history brush paints back
    const src = (e) => h(`button.ph-hsrc${(doc._histSrc || null) === e ? '.on' : ''}`, { title: '작업 내역 브러시의 원본으로', 'aria-label': '작업 내역 브러시 원본', onclick: () => { doc._histSrc = e; render(); } }, icon('historyBrush', 14));
    const items = [h('div.ph-hline', src(null), h(`button.ph-hrow${hist.undoStack.length === 0 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(-1); P.afterHistory(); } }, `${doc.name} (처음)`))];
    hist.undoStack.forEach((e, i) => items.push(h('div.ph-hline', src(e), h(`button.ph-hrow${i === hist.undoStack.length - 1 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(i); P.afterHistory(); } }, e.label))));
    [...hist.redoStack].reverse().forEach((e, i) => items.push(h('button.ph-hrow.redo', { onclick: () => { for (let k = 0; k <= i; k++) hist.redo(); P.afterHistory(); } }, e.label)));
    el.append(...items);
    el.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  P.on('history', render);
  P.on('doc', render);
  return el;
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

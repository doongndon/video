// Photo editor panels: toolbar, tool options bar, layers, colour, properties and history.

import { h, clamp } from '../util.js';
import { showMenu, toast } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openFontPicker } from '../ui/font-picker.js';
import { fontLabel } from '../fonts.js';
import { BLEND_MODES, makeCanvas, SHAPES } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { ADJUSTMENTS } from './adjust.js';
import { createColorPicker } from './colorpicker.js';
import { paramEditors } from './pdialogs.js';

const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#c0c0c0', '#ff0000', '#ff7f00', '#ffd400', '#7fd400', '#00b050', '#00b0b0', '#0070c0', '#3a3aff', '#7030a0', '#ff4fa3', '#8b4513', '#f5deb3', '#ffe680', '#a8e6ff', '#2b2b2b', '#e8eaed'];

// ---------------------------------------------------------------- toolbar

export function buildToolbar(P) {
  const groupPick = new Map(TOOL_GROUPS.map((g) => [g[0], g[0]]));
  const el = h('div.ph-tools', { role: 'toolbar', 'aria-label': '도구' });
  const swFg = h('button.ph-sw.fg', { title: '전경색 (누르면 색 패널)', 'aria-label': '전경색', onclick: () => P.showPanel('color', 'fg') });
  const swBg = h('button.ph-sw.bg', { title: '배경색', 'aria-label': '배경색', onclick: () => P.showPanel('color', 'bg') });
  const swap = h('button.ph-swap', { title: '전경/배경색 바꾸기 (X)', 'aria-label': '색 바꾸기', onclick: () => P.swapColors() }, '⇄');
  const def = h('button.ph-def', { title: '기본 색 (D)', 'aria-label': '기본 색', onclick: () => P.defaultColors() }, '◩');
  const btns = [];
  const render = () => {
    el.replaceChildren();
    for (const g of TOOL_GROUPS) {
      const cur = g.includes(P.tool) ? P.tool : groupPick.get(g[0]);
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
        b.addEventListener('contextmenu', menu);
        let timer = null;
        b.addEventListener('pointerdown', (e) => { timer = setTimeout(() => menu(e), 500); });
        b.addEventListener('pointerup', () => clearTimeout(timer));
        b.addEventListener('pointerleave', () => clearTimeout(timer));
      }
      btns.push(b);
      el.append(b);
    }
    el.append(h('div.ph-colors', swBg, swFg, swap, def));
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
        const s = h('select', { 'aria-label': label }, list.map(([v, txt]) => h('option', { value: v }, txt)));
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
      ctrls.unshift(h('span.ph-opt.ph-hint', '자유 변형 중'), h('button.primary.small', { onclick: () => P.applyTransform() }, '✓ 적용'), h('button.small', { onclick: () => P.cancelTransform() }, '✕ 취소'));
    } else if (t.id === 'crop') {
      ctrls.push(h('button.primary.small', { onclick: () => t.apply(P) }, '✓ 자르기'), h('button.small', { onclick: () => { t.activate(P); } }, '되돌리기'));
    } else if (t.id === 'clone') {
      ctrls.push(h('button.small', { onclick: () => { P.cloneSourceNext = true; toast('복제할 원본 위치를 누르세요'); }, title: '휴대폰: 이 버튼을 누른 뒤 원본 위치를 누르세요' }, '원본 정하기'));
    } else if (t.id === 'lasso' && P.opts('lasso').polygon) {
      ctrls.push(h('button.small', { onclick: () => t.finish?.(P) }, '다각형 닫기'));
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
function thumb(P, l, mask = false) {
  const c = h('canvas.ph-thumb', { width: 40, height: 40 });
  const key = `${l.rev}:${mask}`;
  const doc = P.doc;
  const cache = thumbCache.get(l);
  const draw = (g) => {
    const s = Math.min(40 / doc.width, 40 / doc.height);
    const w = doc.width * s;
    const hh = doc.height * s;
    g.save();
    g.translate((40 - w) / 2, (40 - hh) / 2);
    if (mask && l.mask) {
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
    } else if (l.kind === 'adjust') {
      g.fillStyle = '#555';
      g.fillRect(0, 0, w, hh);
      g.fillStyle = '#fff';
      g.font = 'bold 16px sans-serif';
      g.textAlign = 'center';
      g.fillText('◐', w / 2, hh / 2 + 6);
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
  };
  if (cache?.key === key && cache.doc === doc.id) c.getContext('2d').drawImage(cache.c, 0, 0);
  else {
    draw(c.getContext('2d'));
    const copy = makeCanvas(40, 40);
    copy.getContext('2d').drawImage(c, 0, 0);
    thumbCache.set(l, { key, c: copy, doc: doc.id });
  }
  return c;
}

export function buildLayersPanel(P) {
  const blend = h('select.ph-blend', { 'aria-label': '혼합 모드', title: '혼합 모드' }, BLEND_MODES.map(([id, name]) => h('option', { value: id }, name)));
  const opacity = h('input.ph-num', { type: 'number', min: 0, max: 100, 'aria-label': '불투명도', title: '불투명도 (%)' });
  const opRange = h('input', { type: 'range', min: 0, max: 100, 'aria-label': '불투명도' });
  const lockAll = h('button.small.ph-lock', { title: '모두 잠그기', 'aria-label': '모두 잠그기' }, icon('lock', 14));
  const lockAlpha = h('button.small.ph-lock', { title: '투명 픽셀 잠그기 (칠한 곳에만 칠하기)', 'aria-label': '투명 픽셀 잠그기' }, '▦');
  const list = h('div.ph-layers', { role: 'listbox', 'aria-label': '레이어' });
  const footBtn = (ic, label, fn) => h('button.small', { title: label, 'aria-label': label, onclick: fn }, icon(ic, 15));
  const foot = h('div.ph-lfoot',
    h('button.small', { title: '레이어 스타일 (그림자·획·광선)', onclick: () => P.cmd.layerStyle() }, 'fx'),
    footBtn('mask', '레이어 마스크 추가', () => P.cmd.addMask()),
    h('button.small', {
      title: '새 조정 레이어', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'desaturate').map(([k, a]) => ({ label: a.name, action: () => P.cmd.newAdjustLayer(k) })), r.left, r.top - 4);
      },
    }, '◐'),
    footBtn('plus', '새 레이어', () => P.cmd.newLayer()),
    footBtn('copy', '레이어 복제 (Ctrl+J)', () => P.cmd.duplicateLayer()),
    footBtn('trash', '레이어 삭제', () => P.cmd.deleteLayer()));
  const el = h('div.ph-panel.layers', h('div.ph-lhead', blend, h('label.ph-op', '불투명도', opRange, opacity), lockAll, lockAlpha), list, foot);

  let opBefore = null;
  const setOpacity = (v, done) => {
    const l = P.doc?.active;
    if (!l) return;
    if (!opBefore) opBefore = P.doc.capture();
    l.opacity = clamp(v, 0, 100) / 100;
    P.doc.touch(l);
    P.redraw();
    opacity.value = Math.round(l.opacity * 100);
    opRange.value = opacity.value;
    if (done) {
      P.commit('불투명도', opBefore);
      opBefore = null;
    }
  };
  opRange.addEventListener('input', () => setOpacity(+opRange.value, false));
  opRange.addEventListener('change', () => setOpacity(+opRange.value, true));
  opacity.addEventListener('change', () => setOpacity(+opacity.value, true));
  blend.addEventListener('change', () => {
    const l = P.doc?.active;
    if (l) P.run('혼합 모드', () => { l.blend = blend.value; P.doc.touch(l); });
  });
  lockAll.addEventListener('click', () => {
    const l = P.doc?.active;
    if (l) P.run(l.locked ? '잠금 해제' : '레이어 잠금', () => { l.locked = !l.locked; P.doc.touch(l); });
  });
  lockAlpha.addEventListener('click', () => {
    const l = P.doc?.active;
    if (l) P.run('투명 픽셀 잠금', () => { l.lockAlpha = !l.lockAlpha; P.doc.touch(l); });
  });

  let dragId = null;
  const render = () => {
    const doc = P.doc;
    list.replaceChildren();
    if (!doc) return;
    const a = doc.active;
    blend.value = a?.blend || 'normal';
    opacity.value = Math.round((a?.opacity ?? 1) * 100);
    opRange.value = opacity.value;
    lockAll.classList.toggle('on', !!a?.locked);
    lockAlpha.classList.toggle('on', !!a?.lockAlpha);
    for (const l of [...doc.layers].reverse()) {
      const eye = h('button.ph-eye', { title: l.visible ? '숨기기' : '보이기', 'aria-label': l.visible ? '숨기기' : '보이기', onclick: (e) => { e.stopPropagation(); P.run(l.visible ? '레이어 숨기기' : '레이어 보이기', () => { l.visible = !l.visible; doc.touch(l); }); } }, icon(l.visible ? 'eye' : 'eyeOff', 15));
      const t = thumb(P, l);
      t.title = 'Ctrl(⌘)+클릭: 이 레이어 모양대로 선택';
      t.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.stopPropagation();
          P.cmd.selectFromLayer(l);
          return;
        }
        P.editMask = false;
      });
      const mt = l.mask ? thumb(P, l, true) : null;
      if (mt) {
        mt.title = '마스크 편집 (검정으로 칠하면 숨김, 흰색은 보임) · Shift+클릭: 마스크 끄기/켜기';
        mt.classList.add('mask');
        mt.classList.toggle('editing', P.editMask && l.id === doc.activeId);
        mt.classList.toggle('disabled', !l.mask.enabled);
        mt.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: !l.mask.enabled }; doc.touch(l); });
            return;
          }
          P.selectLayer(l.id);
          P.editMask = true;
          P.emit('layers');
        });
      }
      const badges = [l.kind === 'text' ? 'T' : l.kind === 'shape' ? '◇' : l.kind === 'adjust' ? '◐' : '', l.fx && (l.fx.shadow || l.fx.stroke || l.fx.glow) ? 'fx' : '', l.locked ? '🔒' : '', l.blend !== 'normal' ? '◑' : ''].filter(Boolean);
      const name = h('span.ph-lname', l.name);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        P.cmd.renameLayer(l);
      });
      const row = h(`div.ph-layer${l.id === doc.activeId ? '.on' : ''}${l.visible ? '' : '.hidden'}`, { role: 'option', 'aria-selected': String(l.id === doc.activeId), draggable: 'true' },
        eye, t, mt, name, h('span.ph-badges', badges.join(' ')));
      row.addEventListener('click', () => {
        if (P.doc.activeId !== l.id) P.editMask = false;
        P.selectLayer(l.id);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        P.selectLayer(l.id);
        showMenu(P.layerMenu(), e.clientX, e.clientY);
      });
      row.addEventListener('dragstart', (e) => {
        dragId = l.id;
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        row.classList.add('drop');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop');
        if (dragId && dragId !== l.id) P.cmd.moveLayerTo(dragId, doc.index(l.id));
        dragId = null;
      });
      list.append(row);
    }
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
      rows.push(field('모양', type),
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
    } else {
      rows.push(h('div.ph-prow', h('span', '위치'), h('span.mono', `${Math.round(l.x)}, ${Math.round(l.y)}`)),
        h('div.ph-prow', h('span', '크기'), h('span.mono', l.canvas ? `${l.canvas.width} × ${l.canvas.height}` : '-')));
    }
    // mask controls
    if (l.mask) {
      rows.push(h('div.ph-sub', '레이어 마스크'), h('div.ph-prow',
        h('button.small', { onclick: () => P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: !l.mask.enabled }; doc.touch(l); }) }, l.mask.enabled ? '끄기' : '켜기'),
        h('button.small', { onclick: () => P.cmd.invertMask() }, '반전'),
        l.kind === 'raster' ? h('button.small', { onclick: () => P.cmd.applyMask() }, '적용') : null,
        h('button.small', { onclick: () => P.cmd.deleteMask() }, '삭제')));
    }
    rows.push(h('div.ph-prow', h('button.small', { onclick: () => P.cmd.layerStyle() }, 'fx 레이어 스타일…')));
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
    const items = [h(`button.ph-hrow${hist.undoStack.length === 0 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(-1); P.afterHistory(); } }, `📄 ${doc.name} (처음)`)];
    hist.undoStack.forEach((e, i) => items.push(h(`button.ph-hrow${i === hist.undoStack.length - 1 ? '.on' : ''}`, { onclick: () => { hist.jumpTo(i); P.afterHistory(); } }, e.label)));
    [...hist.redoStack].reverse().forEach((e, i) => items.push(h('button.ph-hrow.redo', { onclick: () => { for (let k = 0; k <= i; k++) hist.redo(); P.afterHistory(); } }, e.label)));
    el.append(...items);
    el.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  P.on('history', render);
  P.on('doc', render);
  return el;
}

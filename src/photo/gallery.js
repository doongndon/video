// Filter ▸ Filter Gallery: a preview (100% of a part, or the whole picture), the effects by folder
// with thumbnails, the chosen effect's settings and a stack of effect layers that are applied top
// to bottom, like Photoshop's. OK applies the stack to the active layer as one undo step (or adds
// the effects as smart filters on a smart object).

import { h } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { FILTERS, applyFilter, defaultFilterParams } from './adjust.js';
import { applyToLayer, paramEditors } from './pdialogs.js';
import { makeCanvas } from './doc.js';
import { GALLERY } from './fxgallery.js';

const PREVIEW = 460;
let lastStack = null;

/** The stack applied in order to a canvas. */
export function applyStack(c, stack, colors) {
  let out = c;
  for (const e of stack) if (e.enabled !== false && FILTERS[e.id]) out = applyFilter(out, e.id, e.params, colors);
  return out;
}

// a hidden filter so a gallery stack can be recorded in actions and repeated with Ctrl+F
FILTERS.filterGallery = {
  name: '필터 갤러리', group: '필터 갤러리', gallery: true, hidden: true, slow: true, params: [],
  fn: (c, p, colors) => applyStack(c, Array.isArray(p.stack) ? p.stack : [], colors),
};

export function filterGalleryDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  const smart = l?.kind === 'smart';
  if (!l || (l.kind !== 'raster' && !smart) || (!smart && !l.canvas)) {
    toast('이미지(일반) 레이어나 고급 개체를 선택하세요');
    return;
  }
  const colors = { fg: P.fg, bg: P.bg };
  const src = smart ? doc.rasterizeLayer(l) : P.layerAsDocCanvas(l);
  // the stack: [{ id, params, enabled }], last used first time
  let stack = (lastStack || [{ id: 'dryBrush', params: defaultFilterParams('dryBrush'), enabled: true }]).map((e) => ({ ...e, params: { ...e.params } }));
  let cur = stack.length - 1;

  // ---- preview: 100% of a part (draggable) or the whole picture scaled down
  let mode = src.width * src.height > PREVIEW * PREVIEW * 1.5 ? 'part' : 'fit';
  let off = { x: Math.max(0, (src.width - PREVIEW) / 2), y: Math.max(0, (src.height - PREVIEW) / 2) };
  const view = h('canvas.ph-gal-view', { width: PREVIEW, height: PREVIEW, 'aria-label': '미리 보기' });
  const busy = h('div.ph-gal-busy', { hidden: true }, '계산 중…');
  const sample = () => {
    if (mode === 'fit') {
      const k = Math.min(1, PREVIEW / Math.max(src.width, src.height));
      const c = makeCanvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, c.width, c.height);
      return c;
    }
    const w = Math.min(PREVIEW, src.width);
    const hh = Math.min(PREVIEW, src.height);
    off.x = Math.max(0, Math.min(src.width - w, off.x));
    off.y = Math.max(0, Math.min(src.height - hh, off.y));
    const c = makeCanvas(w, hh);
    c.getContext('2d').drawImage(src, -Math.round(off.x), -Math.round(off.y));
    return c;
  };
  let timer = 0;
  const draw = () => {
    clearTimeout(timer);
    busy.hidden = false;
    timer = setTimeout(() => {
      try {
        const out = applyStack(sample(), stack, colors);
        view.width = out.width;
        view.height = out.height;
        const g = view.getContext('2d');
        g.clearRect(0, 0, view.width, view.height);
        g.drawImage(out, 0, 0);
      } catch (err) {
        toast(String(err.message || err));
      }
      busy.hidden = true;
    }, 30);
  };
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (mode !== 'part') return;
    drag = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = view.getBoundingClientRect();
    const k = view.width / r.width;
    off = { x: drag.ox - (e.clientX - drag.x) * k, y: drag.oy - (e.clientY - drag.y) * k };
  });
  view.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    draw();
  });
  const modeSel = h('select', { 'aria-label': '미리 보기 크기' }, h('option', { value: 'part' }, '100% (끌어서 옮기기)'), h('option', { value: 'fit' }, '전체 (줄여서)'));
  modeSel.value = mode;
  modeSel.addEventListener('change', () => {
    mode = modeSel.value;
    draw();
  });

  // ---- folders with thumbnails
  const thumbSrc = (() => {
    const s = 72;
    const c = makeCanvas(s, s);
    const k = Math.max(s / src.width, s / src.height, Math.min(1, 220 / Math.max(src.width, src.height)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (s - src.width * k) / 2, (s - src.height * k) / 2, src.width * k, src.height * k);
    return c;
  })();
  const buttons = new Map();
  const mark = () => {
    for (const [id, b] of buttons) b.classList.toggle('on', id === stack[cur]?.id);
  };
  const folders = GALLERY.map(([cat, ids]) => {
    const grid = h('div.ph-gal-grid');
    let filled = false;
    const det = h('details.ph-gal-folder', h('summary', cat), grid);
    const fill = () => {
      if (filled) return;
      filled = true;
      for (const id of ids) {
        if (!FILTERS[id]) continue;
        const t = h('canvas', { width: 72, height: 72 });
        const b = h('button.ph-gal-fx', { type: 'button', title: FILTERS[id].name, onclick: () => choose(id) }, t, h('span', FILTERS[id].name));
        buttons.set(id, b);
        grid.append(b);
        // thumbnails one at a time so the dialog stays responsive
        setTimeout(() => {
          try {
            t.getContext('2d').drawImage(applyFilter(thumbSrc, id, defaultFilterParams(id), colors), 0, 0);
          } catch {
            /* a thumbnail is only decoration */
          }
        }, 0);
      }
      mark();
    };
    det.addEventListener('toggle', () => det.open && fill());
    if (ids.includes(stack[cur]?.id)) {
      det.open = true;
      fill();
    }
    return det;
  });

  // ---- settings of the current effect + the effect layers
  const settings = h('div.ph-gal-settings');
  const layersEl = h('div.ph-gal-layers', { role: 'list', 'aria-label': '효과 레이어' });
  const renderSettings = () => {
    const e = stack[cur];
    settings.replaceChildren(
      h('b', e ? FILTERS[e.id]?.name || e.id : '효과 없음'),
      ...(e ? paramEditors(FILTERS[e.id].params, e.params, () => draw(), P) : []),
    );
  };
  const renderLayers = () => {
    layersEl.replaceChildren(...stack.map((e, i) => i).reverse().map((i) => {
      const e = stack[i];
      const eye = h('button.small.ph-gal-eye', { type: 'button', title: e.enabled === false ? '켜기' : '끄기', 'aria-pressed': String(e.enabled !== false), onclick: (ev) => { ev.stopPropagation(); e.enabled = e.enabled === false; renderLayers(); draw(); } }, e.enabled === false ? '○' : '●');
      return h(`div.ph-gal-layer${i === cur ? '.on' : ''}`, { role: 'listitem', onclick: () => { cur = i; renderLayers(); renderSettings(); mark(); } }, eye, h('span', FILTERS[e.id]?.name || e.id));
    }));
  };
  const choose = (id) => {
    if (!stack.length) {
      stack.push({ id, params: defaultFilterParams(id), enabled: true });
      cur = 0;
    } else stack[cur] = { id, params: defaultFilterParams(id), enabled: true };
    mark();
    renderLayers();
    renderSettings();
    draw();
  };
  const addLayer = () => {
    const base = stack[cur] || { id: 'dryBrush' };
    stack.splice(cur + 1, 0, { id: base.id, params: { ...(base.params || defaultFilterParams(base.id)) }, enabled: true });
    cur++;
    renderLayers();
    renderSettings();
    draw();
  };
  const removeLayer = () => {
    if (!stack.length) return;
    stack.splice(cur, 1);
    cur = Math.max(0, Math.min(cur, stack.length - 1));
    renderLayers();
    renderSettings();
    mark();
    draw();
  };
  const move = (d) => {
    const j = cur + d;
    if (j < 0 || j >= stack.length) return;
    [stack[cur], stack[j]] = [stack[j], stack[cur]];
    cur = j;
    renderLayers();
    draw();
  };

  const apply = () => {
    const active = stack.filter((e) => e.enabled !== false);
    lastStack = stack.map((e) => ({ ...e, params: { ...e.params } }));
    if (!active.length) return;
    if (smart) {
      P.run('고급 필터: 필터 갤러리', () => {
        l.smart = { ...l.smart, filters: [...(l.smart.filters || []), ...active.map((e) => ({ id: e.id, params: { ...e.params, _fg: P.fg, _bg: P.bg }, enabled: true }))] };
        doc.touch(l);
      });
      return;
    }
    P.run('필터 갤러리', () => applyToLayer(P, (c) => applyStack(c, active, colors)));
    P.recordStep?.({ type: 'filter', id: 'filterGallery', params: { stack: active.map((e) => ({ id: e.id, params: { ...e.params } })) } });
  };

  renderLayers();
  renderSettings();
  openModal({
    title: '필터 갤러리',
    width: 'min(1100px, 96vw)',
    body: h('div.ph-gal',
      h('div.ph-gal-left', h('div.ph-gal-viewwrap', view, busy), h('label.ph-gal-mode', h('span', '미리 보기'), modeSel)),
      h('div.ph-gal-mid', ...folders),
      h('div.ph-gal-right', settings,
        h('div.ph-gal-layerbar',
          h('b', '효과 레이어'),
          h('button.small', { type: 'button', title: '새 효과 레이어 (지금 효과를 복제)', onclick: addLayer }, '+'),
          h('button.small', { type: 'button', title: '위로', onclick: () => move(1) }, '▲'),
          h('button.small', { type: 'button', title: '아래로', onclick: () => move(-1) }, '▼'),
          h('button.small', { type: 'button', title: '효과 레이어 삭제', onclick: removeLayer }, '삭제')),
        layersEl,
        h('p.ph-ainote', '효과 레이어는 아래에서 위로 차례로 적용됩니다. 스케치 효과는 전경색·배경색을 씁니다.'))),
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: apply }],
  });
  draw();
}

// Photo editor dialogs. Each takes the editor API `P`.

import { h, clamp } from '../util.js';
import { openModal, formRow, toast } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { ADJUSTMENTS, defaultParams, applyAdjustment, curveLut, FILTERS, defaultFilterParams, applyFilter } from './adjust.js';
import { EXPORT_TYPES } from './io.js';
import { BLEND_MODES } from './blend.js';
import { GRADIENTS, GRADIENT_STYLES, gradientSwatch, listPatterns, resolveStopColor } from './resources.js';
import { FX_DEFAULTS, FX_NAMES, STYLE_PRESETS, normalizeFx } from './styles.js';
import { createColorPicker } from './colorpicker.js';

export const DOC_PRESETS = [
  ['1920x1080', '유튜브·동영상 1920 × 1080', 1920, 1080],
  ['1080x1920', '쇼츠·릴스·스토리 1080 × 1920', 1080, 1920],
  ['1080x1080', '인스타 정사각형 1080 × 1080', 1080, 1080],
  ['1080x1350', '인스타 세로 1080 × 1350', 1080, 1350],
  ['1280x720', '유튜브 썸네일 1280 × 720', 1280, 720],
  ['1200x628', '웹 배너·링크 1200 × 628', 1200, 628],
  ['2480x3508', 'A4 인쇄 (300ppi) 2480 × 3508', 2480, 3508],
  ['800x600', '작은 그림 800 × 600', 800, 600],
];

const num = (value, min, max, step = 1, w = '90px') => h('input', { type: 'number', value, min, max, step, style: { width: w } });
const sel = (opts, value) => {
  const s = h('select', opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  return s;
};
const chk = (checked, label) => {
  const box = h('input', { type: 'checkbox', checked });
  return { el: h('label.inline', box, label), box };
};

// ---------------------------------------------------------------- new document

export function newDocDialog(P) {
  const name = h('input', { type: 'text', value: `제목 없음-${P.docs.length + 1}`, style: { width: '100%' } });
  const preset = sel([...DOC_PRESETS.map(([id, t]) => [id, t]), ['custom', '직접 입력']], '1920x1080');
  const w = num(1920, 1, 12000);
  const hh = num(1080, 1, 12000);
  const bg = sel([['#ffffff', '흰색'], ['transparent', '투명'], ['fg', '전경색'], ['bg', '배경색'], ['#000000', '검정']], '#ffffff');
  preset.addEventListener('change', () => {
    const p = DOC_PRESETS.find((x) => x[0] === preset.value);
    if (p) {
      w.value = p[2];
      hh.value = p[3];
    }
  });
  for (const el of [w, hh]) el.addEventListener('input', () => { preset.value = 'custom'; });
  openModal({
    title: '새 문서',
    width: '480px',
    body: [formRow('이름', name), formRow('크기', preset), formRow('폭 × 높이 (px)', w, '×', hh), formRow('배경', bg)],
    buttons: [{ label: '취소' }, {
      label: '만들기', primary: true, action: () => {
        const W = clamp(Math.round(+w.value || 1), 1, 12000);
        const H = clamp(Math.round(+hh.value || 1), 1, 12000);
        if (W * H > 80e6) {
          toast('너무 큰 문서입니다 (최대 약 8000만 픽셀)');
          return false;
        }
        const b = bg.value === 'fg' ? P.fg : bg.value === 'bg' ? P.bg : bg.value;
        P.newDoc({ name: name.value.trim() || '제목 없음', width: W, height: H, background: b });
        return true;
      },
    }],
  });
}

// ---------------------------------------------------------------- image / canvas size

export function imageSizeDialog(P) {
  const doc = P.doc;
  const w = num(doc.width, 1, 12000);
  const hh = num(doc.height, 1, 12000);
  const pct = num(100, 1, 1000, 1, '70px');
  const keep = chk(true, '비율 유지');
  const ratio = doc.width / doc.height;
  w.addEventListener('input', () => {
    if (keep.box.checked) hh.value = Math.round(+w.value / ratio);
    pct.value = Math.round((+w.value / doc.width) * 100);
  });
  hh.addEventListener('input', () => {
    if (keep.box.checked) w.value = Math.round(+hh.value * ratio);
    pct.value = Math.round((+hh.value / doc.height) * 100);
  });
  pct.addEventListener('input', () => {
    w.value = Math.round((doc.width * +pct.value) / 100);
    hh.value = Math.round((doc.height * +pct.value) / 100);
  });
  openModal({
    title: '이미지 크기',
    width: '440px',
    body: [formRow('폭 × 높이 (px)', w, '×', hh), formRow('배율 (%)', pct), formRow('', keep.el), h('div.note', '모든 레이어의 픽셀을 다시 계산합니다(리샘플링). 글자·모양 레이어는 크기 값만 바뀌어 선명하게 유지됩니다.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.resizeImage(clamp(Math.round(+w.value), 1, 12000), clamp(Math.round(+hh.value), 1, 12000)) }],
  });
}

export function canvasSizeDialog(P) {
  const doc = P.doc;
  const w = num(doc.width, 1, 12000);
  const hh = num(doc.height, 1, 12000);
  let anchor = [1, 1];
  const grid = h('div.ph-anchor', [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => {
    const b = h('button.small', { onclick: () => { anchor = [c, r]; paint(); }, 'aria-label': `기준점 ${r * 3 + c + 1}` }, '');
    b.dataset.c = c;
    b.dataset.r = r;
    return b;
  })));
  const paint = () => grid.querySelectorAll('button').forEach((b) => { b.textContent = +b.dataset.c === anchor[0] && +b.dataset.r === anchor[1] ? '●' : ''; });
  paint();
  openModal({
    title: '캔버스 크기',
    width: '420px',
    body: [formRow('새 폭 × 높이 (px)', w, '×', hh), formRow('기준점', grid), h('div.note', '이미지는 그대로 두고 캔버스(작업 영역)만 늘리거나 줄입니다. 늘어난 곳은 투명합니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const W = clamp(Math.round(+w.value), 1, 12000);
        const H = clamp(Math.round(+hh.value), 1, 12000);
        P.cropTo({ x: Math.round(((doc.width - W) * anchor[0]) / 2), y: Math.round(((doc.height - H) * anchor[1]) / 2), w: W, h: H }, false, '캔버스 크기');
      },
    }],
  });
}

// ---------------------------------------------------------------- param editors (shared by adjustments, filters and the properties panel)

/**
 * Controls for a params definition list [key, label, min, max, default, kind]. kind: 'bool' | 'color' |
 * 'curve' | 'gradient' | 'pattern' | 'blend' | [[value, label]…] (a select) | a number (slider step).
 * onChange(params, done).
 */
export function paramEditors(defs, params, onChange, P = null) {
  const rows = [];
  for (const [key, label, min, max, , kind] of defs) {
    if (kind === 'bool') {
      const c = chk(!!params[key], label);
      c.box.addEventListener('change', () => {
        params[key] = c.box.checked;
        onChange(params, true);
      });
      rows.push(h('div.ph-prow', c.el));
    } else if (kind === 'color') {
      const inp = h('input', { type: 'color', value: params[key] });
      inp.addEventListener('input', () => {
        params[key] = inp.value;
        onChange(params, false);
      });
      inp.addEventListener('change', () => onChange(params, true));
      rows.push(h('label.ph-prow', h('span', label), inp));
    } else if (kind === 'kernel') {
      // a 5×5 grid of weights (Filter ▸ Other ▸ Custom)
      params[key] = Array.isArray(params[key]) && params[key].length === 25 ? params[key].slice() : Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0));
      const grid = h('div.ph-kernel', ...params[key].map((v, i) => {
        const inp = h('input', { type: 'number', step: 1, value: v, 'aria-label': `${Math.floor(i / 5) + 1}행 ${(i % 5) + 1}열` });
        inp.addEventListener('change', () => {
          params[key][i] = Number(inp.value) || 0;
          onChange(params, true);
        });
        return inp;
      }));
      rows.push(h('div.ph-prow.ph-kernelrow', h('span', label), grid));
    } else if (kind === 'curve') {
      rows.push(curveEditor(params[key], (pts, done) => {
        params[key] = pts;
        onChange(params, done);
      }));
    } else if (kind === 'gradient') {
      rows.push(h('div.ph-prow', h('span', label), gradientButton(P, params[key], (g) => {
        params[key] = g;
        onChange(params, true);
      })));
    } else if (kind === 'pattern' || kind === 'blend' || Array.isArray(kind)) {
      const opts = kind === 'pattern' ? listPatterns().map((p) => [p.id, p.name]) : kind === 'blend' ? BLEND_MODES.map(([id, n]) => [id, n]) : kind;
      const s2 = h('select', opts.map(([v, t]) => h('option', { value: v }, t)));
      s2.value = params[key];
      s2.addEventListener('change', () => {
        params[key] = typeof opts[0][0] === 'number' ? +s2.value : s2.value;
        onChange(params, true);
      });
      rows.push(h('label.ph-prow', h('span', label), s2));
    } else {
      const step = typeof kind === 'number' ? kind : max - min > 20 ? 1 : 0.01;
      const r = h('input', { type: 'range', min, max, step, value: params[key] });
      const n = h('input.ph-num', { type: 'number', min, max, step, value: params[key] });
      const set = (v, done) => {
        params[key] = clamp(+v, min, max);
        r.value = params[key];
        n.value = params[key];
        onChange(params, done);
      };
      r.addEventListener('input', () => set(r.value, false));
      r.addEventListener('change', () => set(r.value, true));
      n.addEventListener('change', () => set(n.value, true));
      rows.push(h('label.ph-prow', h('span', label), r, n));
    }
  }
  return rows;
}

function gradientButton(P, gr, onChange) {
  const b = h('button.ph-gradbtn', { type: 'button', title: '그레이디언트 편집' });
  const paint = (g) => b.replaceChildren(gradientSwatch(g, 140, 18, P?.fg, P?.bg));
  paint(gr || GRADIENTS[0]);
  b.addEventListener('click', () => gradientEditor(P, gr || GRADIENTS[0], (g) => {
    gr = g;
    paint(g);
    onChange(g);
  }));
  return b;
}

/** A small curves editor: click to add a point, drag to move, double-click a point to remove it. */
export function curveEditor(points, onChange) {
  const S = 220;
  const c = h('canvas.ph-curve', { width: S, height: S, 'aria-label': '곡선' });
  let pts = points.map((p) => [...p]);
  let drag = -1;
  const g = c.getContext('2d');
  const draw = () => {
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = '#30353e';
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo((S * i) / 4, 0);
      g.lineTo((S * i) / 4, S);
      g.moveTo(0, (S * i) / 4);
      g.lineTo(S, (S * i) / 4);
      g.stroke();
    }
    const lut = curveLut(pts);
    g.strokeStyle = '#e8eaed';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x < 256; x++) {
      const px = (x / 255) * S;
      const py = S - (lut[x] / 255) * S;
      if (x) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.stroke();
    g.lineWidth = 1;
    for (const [x, y] of pts) {
      g.fillStyle = '#fff';
      g.fillRect((x / 255) * S - 4, S - (y / 255) * S - 4, 8, 8);
    }
  };
  const at = (e) => {
    const r = c.getBoundingClientRect();
    return [clamp(((e.clientX - r.left) / r.width) * 255, 0, 255), clamp((1 - (e.clientY - r.top) / r.height) * 255, 0, 255)];
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    drag = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 12);
    if (drag < 0) {
      pts.push([Math.round(x), Math.round(y)]);
      pts.sort((a, b) => a[0] - b[0]);
      drag = pts.findIndex(([px]) => px === Math.round(x));
    }
    draw();
    onChange(pts, false);
  });
  c.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = at(e);
    const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
    pts[drag] = [Math.round(drag === 0 ? 0 : drag === pts.length - 1 ? 255 : clamp(x, lo, hi)), Math.round(y)];
    if (drag === 0 || drag === pts.length - 1) pts[drag][0] = drag === 0 ? Math.min(pts[drag][0], lo) : 255;
    draw();
    onChange(pts.map((p) => [...p]), false);
  });
  c.addEventListener('pointerup', () => {
    if (drag >= 0) onChange(pts.map((p) => [...p]), true);
    drag = -1;
  });
  c.addEventListener('dblclick', (e) => {
    const [x, y] = at(e);
    const i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 12);
    if (i > 0 && i < pts.length - 1) {
      pts.splice(i, 1);
      draw();
      onChange(pts.map((p) => [...p]), true);
    }
  });
  draw();
  return h('div.ph-curvewrap', c, h('div.note', '누르면 점 추가 · 끌어서 이동 · 두 번 눌러 삭제'));
}

// ---------------------------------------------------------------- destructive adjustment / filter with live preview

/** Run `compute(baseCanvas, params)` live on the active layer (inside the selection), OK keeps it. */
// adjustments whose result at a pixel depends only on that pixel: a smaller copy previews them exactly
const PER_PIXEL = new Set(['brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'bw', 'photoFilter', 'invert', 'posterize', 'threshold', 'gradientMap', 'desaturate', 'selectiveColor', 'channelMixer', 'replaceColor', 'colorLookup']);
// filters that look the same on a smaller copy (their sizes are relative to the picture)
const SCALE_FREE = new Set(['cameraRaw', 'vignette', 'spherize', 'pinch', 'twirl']);

/**
 * `proxy`: on a big layer, previews are computed at about screen resolution (what the view shows
 * at the current zoom) and only "확인" computes the full-size result.
 */
function liveLayerDialog(P, { title, defs, params, compute, label, slow = false, record = null, proxy = false }) {
  const doc = P.doc;
  const l = doc.active;
  if (!l || l.kind !== 'raster' || !l.canvas) {
    toast('이미지(일반) 레이어를 선택하세요. 글자·모양 레이어는 레이어 ▸ 래스터화 후 쓸 수 있고, 조정은 "새 조정 레이어"로도 넣을 수 있습니다.');
    return;
  }
  const before = doc.capture();
  const base = l.canvas;
  const bx = l.x;
  const by = l.y;
  const status = h('div.note', '');
  let timer = null;
  let applied = false;
  let small = null;
  const proxyScale = () => {
    const px = base.width * base.height;
    if (!proxy || px <= 3e6) return 1;
    return Math.min(1, Math.max(doc.view.zoom * (window.devicePixelRatio || 1), Math.sqrt(2.5e6 / px)));
  };
  const preview = (full = false) => {
    try {
      const s = full ? 1 : proxyScale();
      let out;
      if (s < 0.95) {
        if (small?.s !== s) {
          const c = makeCanvas(Math.max(1, Math.round(base.width * s)), Math.max(1, Math.round(base.height * s)));
          const cg = c.getContext('2d');
          cg.imageSmoothingQuality = 'high';
          cg.drawImage(base, 0, 0, c.width, c.height);
          small = { s, canvas: c };
        }
        const r = compute(small.canvas, params);
        out = makeCanvas(base.width, base.height);
        out.getContext('2d').drawImage(r, 0, 0, base.width, base.height);
      } else out = compute(base, params);
      if (doc.selection) {
        // only inside the selection: original outside, result inside
        const g = out.getContext('2d');
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(doc.selection.canvas, -bx, -by);
        const mix = cloneCanvas(base);
        const mg = mix.getContext('2d');
        mg.globalCompositeOperation = 'destination-out';
        mg.drawImage(doc.selection.canvas, -bx, -by);
        mg.globalCompositeOperation = 'source-over';
        mg.drawImage(out, 0, 0);
        l.canvas = mix;
      } else l.canvas = out;
      l.x = bx;
      l.y = by;
      l._styled = null;
      doc.touch(l);
      P.redraw();
      status.textContent = '';
    } catch (err) {
      status.textContent = String(err.message || err);
    }
  };
  const schedule = (now) => {
    clearTimeout(timer);
    const heavy = slow && proxyScale() >= 0.95;
    if (heavy) status.textContent = '미리 보기 계산 중…';
    timer = setTimeout(preview, now ? 0 : heavy ? 220 : 40);
  };
  const pv = chk(true, '미리 보기');
  pv.box.addEventListener('change', () => {
    if (pv.box.checked) schedule(true);
    else {
      l.canvas = base;
      doc.touch(l);
      P.redraw();
    }
  });
  openModal({
    title,
    width: '460px',
    body: [...paramEditors(defs, params, () => schedule(false)), h('div.inline', pv.el), status],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        clearTimeout(timer);
        preview(true);
        applied = true;
        P.commit(label, before);
        if (record) P.recordStep?.({ ...record, params: structuredClone(params) });
      },
    }],
    onClose: () => {
      clearTimeout(timer);
      if (!applied) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  schedule(true);
}

export function adjustDialog(P, type) {
  const def = ADJUSTMENTS[type];
  const params = defaultParams(type);
  if (P.doc?.active?.kind === 'smart') return smartFilterDialog(P, `adj:${type}`, params);
  if (!def.params.length) {
    // instant adjustments (invert, desaturate)
    const doc = P.doc;
    const l = doc.active;
    if (!l || l.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
    P.run(def.name, () => applyToLayer(P, (c) => adjustCanvas(c, type, params)));
    P.recordStep?.({ type: 'adjust', id: type, params });
    return undefined;
  }
  liveLayerDialog(P, { title: def.name, defs: def.params, params, label: def.name, compute: (c, p) => adjustCanvas(c, type, p), slow: P.doc.width * P.doc.height > 6e6, record: { type: 'adjust', id: type }, proxy: PER_PIXEL.has(type) });
  return undefined;
}

export function adjustCanvas(c, type, params) {
  const out = makeCanvas(c.width, c.height);
  const g = out.getContext('2d');
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  applyAdjustment(img, type, params);
  g.putImageData(img, 0, 0);
  return out;
}

/** Replace the active layer's pixels with fn(canvas), limited to the selection. Raw (inside a run). */
export function applyToLayer(P, fn) {
  const doc = P.doc;
  const l = doc.active;
  const base = l.canvas;
  const out = fn(base);
  if (doc.selection) {
    const g = out.getContext('2d');
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(doc.selection.canvas, -l.x, -l.y);
    const mix = cloneCanvas(base);
    const mg = mix.getContext('2d');
    mg.globalCompositeOperation = 'destination-out';
    mg.drawImage(doc.selection.canvas, -l.x, -l.y);
    mg.globalCompositeOperation = 'source-over';
    mg.drawImage(out, 0, 0);
    l.canvas = mix;
  } else l.canvas = out;
  l._styled = null;
  doc.touch(l);
}

let lastFilter = null;
export function filterDialog(P, id) {
  const f = FILTERS[id];
  const params = lastFilter?.id === id ? { ...lastFilter.params } : defaultFilterParams(id);
  if (P.doc?.active?.kind === 'smart') return smartFilterDialog(P, id, params);
  const run = (c, p) => applyFilter(c, id, p, { fg: P.fg, bg: P.bg });
  const remember = () => { lastFilter = { id, params: { ...params } }; };
  if (!f.params.length) {
    if (!P.doc.active || P.doc.active.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
    P.run(f.name, () => applyToLayer(P, (c) => run(c, params)));
    remember();
    P.recordStep?.({ type: 'filter', id, params });
    return undefined;
  }
  const big = P.doc.width * P.doc.height;
  liveLayerDialog(P, { title: f.name, defs: f.params.map((d) => [...d.slice(0, 5), d[5]]), params, label: f.name, record: { type: 'filter', id }, compute: (c, p) => { remember(); return run(c, p); }, slow: big > 2e6 || !!f.slow || ['median', 'oil', 'motion', 'twirl', 'spherize', 'pinch', 'wave', 'clouds', 'edges'].includes(id), proxy: SCALE_FREE.has(id) });
  return undefined;
}

export function repeatFilter(P) {
  if (!lastFilter) return toast('아직 적용한 필터가 없습니다');
  const { id, params } = lastFilter;
  if (P.doc?.active?.kind === 'smart') {
    const l = P.doc.active;
    P.run(`고급 필터: ${FILTERS[id].name}`, () => { l.smart = { ...l.smart, filters: [...(l.smart.filters || []), { id, params: { ...params, _fg: P.fg, _bg: P.bg }, enabled: true }] }; P.doc.touch(l); });
    return undefined;
  }
  if (!P.doc.active || P.doc.active.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
  P.run(FILTERS[id].name, () => applyToLayer(P, (c) => applyFilter(c, id, params, { fg: P.fg, bg: P.bg })));
  P.recordStep?.({ type: 'filter', id, params: { ...params } });
  return undefined;
}

// ---------------------------------------------------------------- smart filters

export const filterName = (id) => (id.startsWith('adj:') ? ADJUSTMENTS[id.slice(4)]?.name : FILTERS[id]?.name) || id;
const filterDefs = (id) => (id.startsWith('adj:') ? ADJUSTMENTS[id.slice(4)].params : FILTERS[id].params.map((d) => [...d.slice(0, 5), d[5]]));

/** Add (index = null) or edit a smart filter on a smart object layer, with live preview. */
export function smartFilterDialog(P, id, params, index = null) {
  const doc = P.doc;
  const l = doc.active;
  const before = doc.capture();
  const defs = filterDefs(id);
  const list = [...(l.smart.filters || [])];
  const at = index ?? list.length;
  let entry = index != null ? { ...list[index] } : { id, params: { ...params }, enabled: true };
  const p = { ...entry.params };
  const apply = () => {
    entry = { ...entry, params: { ...p, _fg: P.fg, _bg: P.bg } };
    const fl = [...list];
    fl[at] = entry;
    l.smart = { ...l.smart, filters: fl };
    doc.touch(l);
    P.redraw();
  };
  if (!defs.length) {
    P.run(`고급 필터: ${filterName(id)}`, apply);
    return undefined;
  }
  let timer = null;
  let ok = false;
  const op = { opacity: Math.round((entry.opacity ?? 1) * 100) };
  openModal({
    title: `고급 필터: ${filterName(id)}`,
    width: '460px',
    body: [...paramEditors(defs, p, () => { clearTimeout(timer); timer = setTimeout(apply, 60); }, P),
      ...paramEditors([['opacity', '불투명도 (%)', 0, 100, 100]], op, () => { entry.opacity = op.opacity / 100; clearTimeout(timer); timer = setTimeout(apply, 60); }, P),
      h('div.note', '고급 개체에 넣는 필터는 원본을 바꾸지 않습니다. 레이어 패널에서 끄거나 두 번 눌러 다시 고칠 수 있습니다.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { clearTimeout(timer); apply(); ok = true; P.commit(`고급 필터: ${filterName(id)}`, before); } }],
    onClose: () => {
      clearTimeout(timer);
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  apply();
  return undefined;
}

// ---------------------------------------------------------------- layer style

const BLEND = 'blend';
const FX_FIELDS = {
  dropShadow: [['blend', '혼합 모드', null, null, 'multiply', BLEND], ['color', '색', null, null, '#000000', 'color'], ['opacity', '불투명도 (%)', 0, 100, 75], ['angle', '각도 (°)', -180, 180, 120], ['distance', '거리 (px)', 0, 300, 5], ['spread', '스프레드 (%)', 0, 100, 0], ['size', '크기 (px)', 0, 250, 5], ['knockout', '레이어가 그림자를 가림', null, null, true, 'bool']],
  innerShadow: [['blend', '혼합 모드', null, null, 'multiply', BLEND], ['color', '색', null, null, '#000000', 'color'], ['opacity', '불투명도 (%)', 0, 100, 75], ['angle', '각도 (°)', -180, 180, 120], ['distance', '거리 (px)', 0, 300, 5], ['choke', '경계 감소 (%)', 0, 100, 0], ['size', '크기 (px)', 0, 250, 5]],
  outerGlow: [['blend', '혼합 모드', null, null, 'screen', BLEND], ['color', '색', null, null, '#ffffbe', 'color'], ['opacity', '불투명도 (%)', 0, 100, 75], ['spread', '스프레드 (%)', 0, 100, 0], ['size', '크기 (px)', 0, 250, 5]],
  innerGlow: [['blend', '혼합 모드', null, null, 'screen', BLEND], ['color', '색', null, null, '#ffffbe', 'color'], ['opacity', '불투명도 (%)', 0, 100, 75], ['source', '소스', null, null, 'edge', [['edge', '가장자리'], ['center', '가운데']]], ['choke', '경계 감소 (%)', 0, 100, 0], ['size', '크기 (px)', 0, 250, 5]],
  bevel: [['style', '스타일', null, null, 'inner bevel', [['inner bevel', '내부 경사'], ['outer bevel', '외부 경사'], ['emboss', '엠보스'], ['pillow emboss', '쿠션 엠보스']]], ['technique', '기법', null, null, 'smooth', [['smooth', '매끄럽게'], ['chisel hard', '단단하게 깎기'], ['chisel soft', '부드럽게 깎기']]], ['depth', '깊이 (%)', 1, 1000, 100], ['direction', '방향', null, null, 'up', [['up', '위로'], ['down', '아래로']]], ['size', '크기 (px)', 0, 250, 5], ['soften', '부드럽게 (px)', 0, 16, 0], ['angle', '빛의 각도 (°)', -180, 180, 120], ['altitude', '빛의 높이 (°)', 0, 90, 30],
    ['highlightBlend', '밝은 영역 모드', null, null, 'screen', BLEND], ['highlightColor', '밝은 영역 색', null, null, '#ffffff', 'color'], ['highlightOpacity', '밝은 영역 불투명도 (%)', 0, 100, 75], ['shadowBlend', '그림자 모드', null, null, 'multiply', BLEND], ['shadowColor', '그림자 색', null, null, '#000000', 'color'], ['shadowOpacity', '그림자 불투명도 (%)', 0, 100, 75]],
  satin: [['blend', '혼합 모드', null, null, 'multiply', BLEND], ['color', '색', null, null, '#000000', 'color'], ['opacity', '불투명도 (%)', 0, 100, 50], ['angle', '각도 (°)', -180, 180, 19], ['distance', '거리 (px)', 0, 250, 11], ['size', '크기 (px)', 0, 250, 14], ['invert', '반전', null, null, true, 'bool']],
  colorOverlay: [['blend', '혼합 모드', null, null, 'normal', BLEND], ['color', '색', null, null, '#ff0000', 'color'], ['opacity', '불투명도 (%)', 0, 100, 100]],
  gradientOverlay: [['blend', '혼합 모드', null, null, 'normal', BLEND], ['opacity', '불투명도 (%)', 0, 100, 100], ['gradient', '그레이디언트', null, null, null, 'gradient'], ['reverse', '반전', null, null, false, 'bool'], ['style', '스타일', null, null, 'linear', GRADIENT_STYLES], ['angle', '각도 (°)', -180, 180, 90], ['scale', '비율 (%)', 10, 150, 100]],
  patternOverlay: [['blend', '혼합 모드', null, null, 'normal', BLEND], ['opacity', '불투명도 (%)', 0, 100, 100], ['pattern', '패턴', null, null, 'checker', 'pattern'], ['scale', '비율 (%)', 1, 1000, 100]],
  stroke: [['size', '크기 (px)', 1, 250, 3], ['position', '위치', null, null, 'outside', [['outside', '바깥쪽'], ['inside', '안쪽'], ['center', '가운데']]], ['blend', '혼합 모드', null, null, 'normal', BLEND], ['opacity', '불투명도 (%)', 0, 100, 100], ['fillType', '칠 유형', null, null, 'color', [['color', '색상'], ['gradient', '그레이디언트']]], ['color', '색', null, null, '#000000', 'color'], ['gradient', '그레이디언트', null, null, null, 'gradient'], ['angle', '각도 (°)', -180, 180, 90]],
};
const FX_LIST = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
const PCT = new Set(['opacity', 'highlightOpacity', 'shadowOpacity']);

const userStyles = () => {
  try {
    return JSON.parse(localStorage.getItem('montage.photo.styles') || '[]');
  } catch {
    return [];
  }
};

/** Photoshop-like layer style dialog: sections on the left, settings on the right, live preview. */
export function layerStyleDialog(P, start = 'blending') {
  const doc = P.doc;
  const l = doc.active;
  if (!l || l.kind === 'adjust') return toast('스타일은 조정 레이어가 아닌 레이어에 넣을 수 있습니다');
  const before = doc.capture();
  const fx = normalizeFx(structuredClone(l.fx || {}));
  const blending = { blend: l.blend, opacity: Math.round(l.opacity * 100), fillOpacity: Math.round((l.fillOpacity ?? 1) * 100), thisLo: l.blendIf?.this[0] ?? 0, thisLo2: l.blendIf?.this[1] ?? 0, thisHi2: l.blendIf?.this[2] ?? 255, thisHi: l.blendIf?.this[3] ?? 255, underLo: l.blendIf?.under[0] ?? 0, underLo2: l.blendIf?.under[1] ?? 0, underHi2: l.blendIf?.under[2] ?? 255, underHi: l.blendIf?.under[3] ?? 255 };
  let raf = 0;
  const apply = () => {
    raf = 0;
    l.fx = structuredClone(fx);
    l.blend = blending.blend;
    l.opacity = blending.opacity / 100;
    l.fillOpacity = blending.fillOpacity / 100;
    const bi = { this: [blending.thisLo, Math.max(blending.thisLo, blending.thisLo2), Math.min(blending.thisHi, blending.thisHi2), blending.thisHi], under: [blending.underLo, Math.max(blending.underLo, blending.underLo2), Math.min(blending.underHi, blending.underHi2), blending.underHi] };
    l.blendIf = bi.this[0] <= 0 && bi.this[3] >= 255 && bi.under[0] <= 0 && bi.under[3] >= 255 ? null : bi;
    l._styled = null;
    doc.touch(l);
    P.redraw();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  const side = h('div.ph-fxlist');
  const pane = h('div.ph-fxpane');
  let current = start;
  const showSection = (k) => {
    current = k;
    side.querySelectorAll('[data-k]').forEach((r) => r.classList.toggle('on', r.dataset.k === k));
    if (k === 'blending') {
      const defs = [['blend', '혼합 모드', null, null, 'normal', l.kind === 'group' ? [['pass through', '통과'], ...BLEND_MODES.map(([id, n]) => [id, n])] : BLEND], ['opacity', '불투명도 (%)', 0, 100, 100], ['fillOpacity', '칠 불투명도 (%) — 효과는 그대로', 0, 100, 100]];
      const bi = [['thisLo', '이 레이어: 검정 쪽 시작', 0, 255, 0], ['thisLo2', '이 레이어: 검정 쪽 끝 (부드럽게)', 0, 255, 0], ['thisHi2', '이 레이어: 흰색 쪽 시작 (부드럽게)', 0, 255, 255], ['thisHi', '이 레이어: 흰색 쪽 끝', 0, 255, 255], ['underLo', '아래 레이어: 검정 쪽 시작', 0, 255, 0], ['underLo2', '아래 레이어: 검정 쪽 끝 (부드럽게)', 0, 255, 0], ['underHi2', '아래 레이어: 흰색 쪽 시작 (부드럽게)', 0, 255, 255], ['underHi', '아래 레이어: 흰색 쪽 끝', 0, 255, 255]];
      pane.replaceChildren(h('h4', '혼합 옵션'), ...paramEditors(defs, blending, schedule, P), h('h4', '혼합 조건 (Blend If, 회색 밝기 기준)'), h('div.note', '이 레이어가 보일 밝기 범위와, 아래 레이어의 어느 밝기 위에서 보일지를 정합니다.'), ...paramEditors(bi, blending, schedule, P));
      return;
    }
    if (k === 'styles') {
      const presets = [...STYLE_PRESETS, ...userStyles().map((u) => ({ ...u, user: true }))];
      pane.replaceChildren(h('h4', '스타일'), h('div.ph-stylegrid', presets.map((pr) => h('button.ph-stylecell', {
        title: pr.name,
        onclick: () => {
          for (const key of FX_LIST) delete fx[key];
          Object.assign(fx, structuredClone(pr.fx));
          renderSide();
          schedule();
        },
      }, h('span', pr.name)))));
      return;
    }
    if (!fx[k]) fx[k] = { ...FX_DEFAULTS[k], enabled: true };
    const ui = { ...fx[k] };
    for (const key of PCT) if (key in ui) ui[key] = Math.round(ui[key] * 100);
    const on = chk(!!fx[k].enabled, `${FX_NAMES[k]} 사용`);
    on.box.addEventListener('change', () => {
      fx[k] = { ...fx[k], enabled: on.box.checked };
      renderSide();
      schedule();
    });
    const eds = paramEditors(FX_FIELDS[k], ui, () => {
      const v = { ...ui };
      for (const key of PCT) if (key in v) v[key] = v[key] / 100;
      fx[k] = { ...v, enabled: true };
      on.box.checked = true;
      renderSide();
      schedule();
    }, P);
    pane.replaceChildren(h('h4', FX_NAMES[k]), on.el, ...eds, h('div.inline', h('button.small', { onclick: () => { fx[k] = { ...FX_DEFAULTS[k], enabled: fx[k].enabled }; showSection(k); schedule(); } }, '기본값으로')));
  };
  const renderSide = () => {
    side.replaceChildren(
      h(`button.ph-fxitem${current === 'styles' ? '.on' : ''}`, { 'data-k': 'styles', onclick: () => showSection('styles') }, '스타일'),
      h(`button.ph-fxitem${current === 'blending' ? '.on' : ''}`, { 'data-k': 'blending', onclick: () => showSection('blending') }, '혼합 옵션'),
      ...FX_LIST.map((k) => {
        const box = h('input', { type: 'checkbox', checked: !!fx[k]?.enabled, 'aria-label': `${FX_NAMES[k]} 켜기` });
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          fx[k] = { ...(fx[k] || FX_DEFAULTS[k]), enabled: box.checked };
          schedule();
          if (box.checked) showSection(k);
        });
        return h(`div.ph-fxitem${current === k ? '.on' : ''}`, { 'data-k': k, role: 'button', tabindex: 0, onclick: () => showSection(k) }, box, h('span', FX_NAMES[k]));
      }));
  };
  renderSide();
  showSection(start);
  let ok = false;
  openModal({
    title: '레이어 스타일',
    width: '760px',
    body: [h('div.ph-fxdlg', side, pane)],
    buttons: [
      {
        label: '새 스타일로 저장…', action: async () => {
          const { promptDialog } = await import('../ui/common.js');
          const name = await promptDialog('새 스타일', '스타일 이름', '내 스타일');
          if (!name) return false;
          const list = userStyles();
          list.push({ id: `u${Date.now()}`, name, fx: structuredClone(fx) });
          try { localStorage.setItem('montage.photo.styles', JSON.stringify(list)); } catch { /* storage unavailable */ }
          toast(`스타일 "${name}"을(를) 저장했습니다 (스타일 패널·스타일 목록)`);
          return false;
        },
      },
      { label: '취소' },
      { label: '확인', primary: true, action: () => { cancelAnimationFrame(raf); apply(); ok = true; P.commit('레이어 스타일', before); } },
    ],
    onClose: () => {
      cancelAnimationFrame(raf);
      if (!ok) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  return undefined;
}

// ---------------------------------------------------------------- gradient editor

/** Pick a preset or edit colour/opacity stops (drag them along the bar). onApply(gradient). */
export function gradientEditor(P, gr, onApply) {
  let g = structuredClone(gr?.stops ? gr : GRADIENTS[0]);
  g.alphas ||= [{ pos: 0, a: 1 }, { pos: 1, a: 1 }];
  const bar = h('div.ph-gbar');
  const stopsC = h('div.ph-gstops.color');
  const stopsA = h('div.ph-gstops.alpha');
  const detail = h('div.ph-gdetail');
  let selected = { kind: 'c', i: 0 };
  const W = 360;
  const paint = () => {
    bar.replaceChildren(gradientSwatch(g, W, 26, P?.fg, P?.bg));
    const mk = (arr, kind, el) => {
      el.replaceChildren(...arr.map((s, i) => {
        const m = h(`button.ph-gstop${selected.kind === kind && selected.i === i ? '.on' : ''}`, { style: { left: `${s.pos * 100}%`, background: kind === 'c' ? resolveStopColor(s.color, P?.fg, P?.bg) : `rgba(0,0,0,${s.a})` }, 'aria-label': `${kind === 'c' ? '색' : '불투명도'} 정지점 ${Math.round(s.pos * 100)}%` });
        m.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          selected = { kind, i };
          m.setPointerCapture(e.pointerId);
          const r = el.getBoundingClientRect();
          const mv = (ev) => {
            s.pos = clamp((ev.clientX - r.left) / r.width, 0, 1);
            m.style.left = `${s.pos * 100}%`;
            bar.replaceChildren(gradientSwatch(g, W, 26, P?.fg, P?.bg));
          };
          const up = () => {
            m.removeEventListener('pointermove', mv);
            m.removeEventListener('pointerup', up);
            paint();
          };
          m.addEventListener('pointermove', mv);
          m.addEventListener('pointerup', up);
          paint();
        });
        return m;
      }));
    };
    mk(g.stops, 'c', stopsC);
    mk(g.alphas, 'a', stopsA);
    const arr = selected.kind === 'c' ? g.stops : g.alphas;
    const s = arr[Math.min(selected.i, arr.length - 1)];
    if (!s) return;
    const pos = h('input.ph-num', { type: 'number', min: 0, max: 100, value: Math.round(s.pos * 100) });
    pos.addEventListener('change', () => { s.pos = clamp(+pos.value / 100, 0, 1); paint(); });
    const del = h('button.small', { disabled: arr.length <= 2, onclick: () => { arr.splice(arr.indexOf(s), 1); selected.i = 0; paint(); } }, '정지점 삭제');
    if (selected.kind === 'c') {
      const col = h('input', { type: 'color', value: resolveStopColor(s.color, P?.fg, P?.bg) });
      col.addEventListener('input', () => { s.color = col.value; paint(); });
      detail.replaceChildren(h('label.ph-prow', h('span', '색'), col, h('button.small', { onclick: () => { s.color = 'fg'; paint(); } }, '전경색'), h('button.small', { onclick: () => { s.color = 'bg'; paint(); } }, '배경색')), h('label.ph-prow', h('span', '위치 (%)'), pos), del);
    } else {
      const a = h('input.ph-num', { type: 'number', min: 0, max: 100, value: Math.round(s.a * 100) });
      a.addEventListener('change', () => { s.a = clamp(+a.value / 100, 0, 1); paint(); });
      detail.replaceChildren(h('label.ph-prow', h('span', '불투명도 (%)'), a), h('label.ph-prow', h('span', '위치 (%)'), pos), del);
    }
  };
  // click the strips to add stops
  const addAt = (el, kind) => el.addEventListener('dblclick', (e) => {
    const r = el.getBoundingClientRect();
    const pos = clamp((e.clientX - r.left) / r.width, 0, 1);
    if (kind === 'c') g.stops.push({ pos, color: '#808080' });
    else g.alphas.push({ pos, a: 1 });
    selected = { kind, i: (kind === 'c' ? g.stops : g.alphas).length - 1 };
    paint();
  });
  addAt(stopsC, 'c');
  addAt(stopsA, 'a');
  const presets = h('div.ph-gpresets', GRADIENTS.map((pr) => h('button.ph-gpreset', { title: pr.name, onclick: () => { g = structuredClone(pr); g.alphas ||= [{ pos: 0, a: 1 }, { pos: 1, a: 1 }]; selected = { kind: 'c', i: 0 }; paint(); } }, gradientSwatch(pr, 64, 20, P?.fg, P?.bg))));
  paint();
  openModal({
    title: '그레이디언트 편집기',
    width: '440px',
    body: [h('div.ph-sub', '사전 설정'), presets, h('div.ph-sub', '불투명도 정지점 (위) · 색 정지점 (아래) — 끌어서 옮기고, 줄을 두 번 눌러 추가'), h('div.ph-gwrap', stopsA, bar, stopsC), detail,
      h('div.inline', h('button.small', { onclick: () => { g.stops = g.stops.map((s) => ({ ...s, pos: 1 - s.pos })); g.alphas = g.alphas.map((s) => ({ ...s, pos: 1 - s.pos })); paint(); } }, '좌우 뒤집기'))],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => onApply(structuredClone(g)) }],
  });
}

// ---------------------------------------------------------------- new fill layer

export function fillLayerDialog(P, type) {
  if (type === 'solid') {
    let color = P.fg;
    const picker = createColorPicker({ value: color, onChange: (v) => { color = v; } });
    openModal({
      title: '새 칠 레이어: 단색',
      width: '300px',
      body: [picker.el],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'solid', color }) }],
    });
    return;
  }
  if (type === 'gradient') {
    const p = { gradient: structuredClone(GRADIENTS[0]), style: 'linear', angle: 90, scale: 100, reverse: false };
    openModal({
      title: '새 칠 레이어: 그레이디언트',
      width: '420px',
      body: paramEditors([['gradient', '그레이디언트', null, null, null, 'gradient'], ['style', '스타일', null, null, 'linear', GRADIENT_STYLES], ['angle', '각도 (°)', -180, 180, 90], ['scale', '비율 (%)', 10, 150, 100], ['reverse', '반전', null, null, false, 'bool']], p, () => {}, P),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'gradient', ...structuredClone(p), gradient: resolveGradient(p.gradient, P) }) }],
    });
    return;
  }
  const p = { pattern: 'checker', scale: 100 };
  openModal({
    title: '새 칠 레이어: 패턴',
    width: '380px',
    body: paramEditors([['pattern', '패턴', null, null, 'checker', 'pattern'], ['scale', '비율 (%)', 1, 1000, 100]], p, () => {}, P),
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.cmd.newFillLayer({ type: 'pattern', ...p }) }],
  });
}

/** Fill layers keep real colours (not "foreground") so they look the same later. */
function resolveGradient(g, P) {
  return { ...g, stops: g.stops.map((s) => ({ ...s, color: resolveStopColor(s.color, P.fg, P.bg) })) };
}

// ---------------------------------------------------------------- fill / stroke

export function fillDialog(P) {
  const what = sel([['fg', '전경색'], ['bg', '배경색'], ['custom', '색상…'], ['content', '내용 인식 (주변으로 채움)'], ['#808080', '50% 회색'], ['#ffffff', '흰색'], ['#000000', '검정']], 'fg');
  const color = h('input', { type: 'color', value: P.fg });
  const op = num(100, 1, 100, 1, '70px');
  openModal({
    title: '칠 (채우기)',
    width: '400px',
    body: [formRow('내용', what, color), formRow('불투명도 (%)', op), h('div.note', P.doc.selection ? '선택 영역을 채웁니다.' : '선택 영역이 없어 레이어 전체를 채웁니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        if (what.value === 'content') return P.cmd.contentAwareFill();
        const c = what.value === 'fg' ? P.fg : what.value === 'bg' ? P.bg : what.value === 'custom' ? color.value : what.value;
        P.fill(c, +op.value / 100);
      },
    }],
  });
}

export function strokeDialog(P) {
  if (!P.doc.selection) return toast('먼저 선택 영역을 만드세요');
  const width = num(4, 1, 200);
  const color = h('input', { type: 'color', value: P.fg });
  const pos = sel([['outside', '바깥쪽'], ['center', '가운데'], ['inside', '안쪽']], 'center');
  openModal({
    title: '획 (선택 영역 테두리 그리기)',
    width: '400px',
    body: [formRow('두께 (px)', width), formRow('색', color), formRow('위치', pos)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.strokeSelection(+width.value, color.value, pos.value) }],
  });
  return undefined;
}

// ---------------------------------------------------------------- export / send to video

export function exportDialog(P) {
  const doc = P.doc;
  const type = sel(EXPORT_TYPES.map(([id, t]) => [id, t]), 'png');
  const q = h('input', { type: 'range', min: 0.3, max: 1, step: 0.01, value: 0.9 });
  const qv = h('span', '90%');
  q.addEventListener('input', () => { qv.textContent = `${Math.round(q.value * 100)}%`; });
  const scale = sel([[1, '원래 크기'], [0.5, '50%'], [0.25, '25%'], [2, '200%']], 1);
  const name = h('input', { type: 'text', value: doc.name, style: { width: '100%' } });
  const qRow = formRow('화질', q, qv);
  const sync = () => { qRow.hidden = type.value === 'png'; };
  type.addEventListener('change', sync);
  sync();
  openModal({
    title: '내보내기 (이미지 파일로 저장)',
    width: '440px',
    body: [formRow('파일 이름', name), formRow('형식', type), qRow, formRow('크기', scale), h('div.note', `${doc.width} × ${doc.height} px · 보이는 레이어를 합쳐 저장합니다.`)],
    buttons: [{ label: '취소' }, { label: '저장', primary: true, action: () => P.exportImage(name.value.trim() || doc.name, type.value, +q.value, +scale.value) }],
  });
}

export function sendToVideoDialog(P) {
  const doc = P.doc;
  const replace = chk(false, '영상 타임라인에서 원래 이미지를 쓰던 클립도 이 이미지로 바꾸기');
  if (!doc.sourceMediaId) replace.box.disabled = true;
  openModal({
    title: '영상 편집으로 보내기',
    width: '460px',
    body: [
      h('div.note', '보이는 레이어를 합친 PNG를 영상 프로젝트의 미디어(프로젝트 패널)에 새 이미지로 넣습니다.'),
      doc.sourceMediaId ? replace.el : h('div.note', '이 문서는 영상 프로젝트의 이미지에서 연 것이 아니어서 새 이미지로만 넣을 수 있습니다.'),
    ],
    buttons: [{ label: '취소' }, { label: '보내기', primary: true, action: () => P.sendToVideo({ replace: replace.box.checked }) }],
  });
}

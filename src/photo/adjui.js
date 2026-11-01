// Photoshop-style editors for the adjustments (used by Image ▸ Adjustments dialogs, the Properties
// panel of adjustment layers and smart filters): Levels and Curves with channels, histogram, presets,
// Auto and black / grey / white point eyedroppers that sample the picture; Hue/Saturation with the six
// colour ranges and their range sliders; Color Balance tones; Black & White presets, Auto and tint;
// Photo Filter list; Channel Mixer output channels and presets; Gradient Map gradients; Selective Color
// per colour; Color Lookup's LUT files (.cube / .3dl).
//
// An editor is (params, onChange(params, done), env) → [elements]. env: { P, hist() → histograms,
// sample(cb) → starts an eyedropper on the picture, ctl(key) → another control's setter }.

import { h, clamp } from '../util.js';
import { toast } from '../ui/common.js';
import { HUE_RANGES, PHOTO_FILTERS, SELECTIVE_TARGETS, levelsLut, curveLut } from './adjust.js';
import { histograms, percentile, hexRgb, rgbHex, hslToRgb, mk, lum } from './fxcore.js';
import { GRADIENTS, gradientSwatch } from './resources.js';

const STYLE_ID = 'ph-adjui-style';
export function ensureAdjStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.adj-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-s); color: var(--text-dim); }
.adj-row > span:first-child { min-width: calc(64px * var(--ui-scale)); }
.adj-row select { min-width: 0; }
.adj-graph { position: relative; width: min(256px, 100%); }
.adj-graph canvas { display: block; width: 100%; height: auto; background: #101114; border: 1px solid var(--line-2); border-radius: 3px; touch-action: none; }
.adj-tri { position: relative; height: 14px; width: 100%; touch-action: none; }
.adj-tri i { position: absolute; top: 0; width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 11px solid #888; transform: translateX(-6px); cursor: ew-resize; }
.adj-tri i.k { border-bottom-color: #000; filter: drop-shadow(0 0 1px #aaa); }
.adj-tri i.g { border-bottom-color: #808080; }
.adj-tri i.w { border-bottom-color: #fff; }
.adj-ramp { height: 10px; border-radius: 2px; border: 1px solid var(--line-2); }
.adj-nums { display: flex; justify-content: space-between; gap: 6px; }
.adj-nums .ph-num { width: calc(58px * var(--ui-scale)); }
.adj-picks { display: inline-flex; gap: 4px; }
.adj-picks button { width: 30px; height: 26px; min-height: 0; padding: 0; display: grid; place-items: center; }
.adj-picks button.on { background: var(--accent); border-color: var(--accent); }
.adj-drop { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #999; }
.adj-hue { position: relative; width: 100%; height: 40px; touch-action: none; }
.adj-hue .bar { position: absolute; left: 0; right: 0; height: 10px; border-radius: 2px; }
.adj-hue .h { position: absolute; top: 13px; width: 8px; height: 14px; transform: translateX(-4px); background: #ddd; border: 1px solid #333; cursor: ew-resize; border-radius: 2px; }
.adj-hue .h.in { background: #888; }
.adj-total { font-variant-numeric: tabular-nums; color: var(--text-faint); }
.ph-scrub { cursor: ew-resize; user-select: none; touch-action: none; }
.ph-fboxwrap { display: grid; justify-items: center; gap: 4px; }
.ph-fbox { width: min(240px, 100%); height: auto; background: #26282d; border: 1px solid var(--line-2); border-radius: 4px; cursor: grab; touch-action: none; }
.ph-fboxwrap .inline { display: inline-flex; gap: 6px; align-items: center; }
body.ph-picking .ph-stage, body.ph-picking .ph-stage canvas { cursor: crosshair !important; }
.ph-pin { position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%; border: 2px solid #fff; background: rgba(30, 110, 255, .3); box-shadow: 0 0 0 1px rgba(0,0,0,.65), inset 0 0 0 1px rgba(0,0,0,.65); cursor: move; touch-action: none; display: grid; place-items: center; }
.ph-pin::after { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
.ph-pin[hidden] { display: none; }
.modal-backdrop.peeking .ph-pin { pointer-events: auto; }
.nf { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 12px; min-height: 300px; }
.nf-list { display: flex; flex-direction: column; gap: 4px; }
.nf-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.nf-item.on { border-color: var(--accent); background: var(--accent-soft); }
.nf-item span { display: grid; }
.nf-item small { color: var(--text-faint); font-size: var(--fs-xs); }
.nf-settings { display: grid; gap: 6px; align-content: start; }
body.mobile .nf { grid-template-columns: 1fr; }
.modal:has(.cr), .modal:has(.lq), .modal:has(.ph-gal) { max-width: 98vw; }
.modal:has(.nf) { max-width: min(820px, 96vw); }
.lq-side { overflow-y: auto; max-height: min(660px, 72vh); padding-right: 4px; }
.lq-group { display: grid; gap: 4px; border-top: 1px solid var(--line); padding-top: 6px; }
details.lq-group > summary { cursor: pointer; font-weight: 600; }
.lq-side .lq-row { grid-template-columns: 74px minmax(0, 1fr) 52px; align-items: center; gap: 6px; }
.lq-side .lq-row:has(input[type=checkbox]) { grid-template-columns: auto 1fr; }
.lq-side .lq-row .ph-num { width: 52px; }
.lq-side .lq-row > span { font-size: var(--fs-s); color: var(--text-dim); }
body.mobile .lq-side { max-height: none; }
`;
  document.head.append(h('style', { id: STYLE_ID }, css));
}

// ---------------------------------------------------------------- small controls

const select = (opts, value, onChange, label) => {
  const s = h('select', { 'aria-label': label || '' }, ...opts.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(value);
  s.addEventListener('change', () => onChange(s.value));
  return s;
};
/** A slider + number row; returns { el, set(v) }. */
function slider(label, min, max, value, onInput, { step = 1, bg = null } = {}) {
  const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  if (bg) r.style.background = bg;
  const n = h('input.ph-num', { type: 'number', min, max, step, value });
  const set = (v) => {
    r.value = v;
    n.value = v;
  };
  r.addEventListener('input', () => {
    n.value = r.value;
    onInput(+r.value, false);
  });
  r.addEventListener('change', () => onInput(+r.value, true));
  n.addEventListener('input', () => {
    if (n.value === '' || !Number.isFinite(+n.value)) return;
    r.value = clamp(+n.value, min, max);
    onInput(clamp(+n.value, min, max), false);
  });
  n.addEventListener('change', () => {
    const v = clamp(+n.value || 0, min, max);
    set(v);
    onInput(v, true);
  });
  return { el: h('label.ph-prow', h('span', label), r, n), set };
}
const grad = (a, b) => `linear-gradient(90deg, ${a}, ${b})`;
const SPECTRUM = 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';

/** Eyedropper buttons: black / grey / white point; each picks once on the picture. */
function pointPickers(env, onPick) {
  const mkBtn = (kind, title, color) => {
    const b = h('button.small', { type: 'button', title, 'aria-label': title }, h('span.adj-drop', { style: { background: color } }));
    b.addEventListener('click', () => {
      if (!env?.sample) return toast('스포이드는 문서가 열려 있을 때 쓸 수 있습니다');
      for (const x of wrap.children) x.classList.remove('on');
      b.classList.add('on');
      env.sample((rgb) => {
        b.classList.remove('on');
        if (rgb) onPick(kind, rgb);
      });
      return undefined;
    });
    return b;
  };
  const wrap = h('span.adj-picks', mkBtn('black', '이미지에서 샘플링하여 검정 점 설정', '#000'), mkBtn('gray', '이미지에서 샘플링하여 회색 점 설정', '#808080'), mkBtn('white', '이미지에서 샘플링하여 흰색 점 설정', '#fff'));
  return wrap;
}

function drawHist(g, W, H, hist, color = '#9aa0aa') {
  if (!hist) return;
  let mx = 1;
  for (let i = 1; i < 255; i++) mx = Math.max(mx, hist[i]);
  g.fillStyle = color;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(H, (hist[i] / mx) * H * 0.95);
    g.fillRect((i / 256) * W, H - v, Math.max(1, W / 256), v);
  }
}

// ---------------------------------------------------------------- Levels

const LEVELS_PRESETS = [
  ['default', '기본값', [0, 1, 255, 0, 255]],
  ['darker', '더 어둡게', [15, 0.6, 255, 0, 255]],
  ['contrast1', '대비 증가 1', [10, 1, 245, 0, 255]],
  ['contrast2', '대비 증가 2', [20, 1, 235, 0, 255]],
  ['contrast3', '대비 증가 3', [30, 1, 225, 0, 255]],
  ['lighter', '밝게', [0, 1.6, 230, 0, 255]],
  ['lightenShadows', '어두운 영역 밝게', [0, 1.6, 255, 0, 255]],
  ['midBrighter', '중간 톤 더 밝게', [0, 1.25, 255, 0, 255]],
  ['midDarker', '중간 톤 더 어둡게', [0, 0.8, 255, 0, 255]],
];

export function levelsEditor(p, onChange, env) {
  ensureAdjStyle();
  let ch = 'rgb';
  const get = () => (ch === 'rgb' ? [p.inBlack, p.gamma, p.inWhite, p.outBlack, p.outWhite] : (p.channels?.[ch] || [0, 1, 255, 0, 255]).slice());
  const put = (v, done) => {
    v = [clamp(Math.round(v[0]), 0, 253), clamp(+v[1] || 1, 0.1, 9.99), clamp(Math.round(v[2]), 2, 255), clamp(Math.round(v[3]), 0, 255), clamp(Math.round(v[4]), 0, 255)];
    if (v[2] <= v[0] + 1) v[2] = v[0] + 2;
    if (ch === 'rgb') [p.inBlack, p.gamma, p.inWhite, p.outBlack, p.outWhite] = v;
    else {
      const identity = v[0] === 0 && v[1] === 1 && v[2] === 255 && v[3] === 0 && v[4] === 255;
      const chans = { ...(p.channels || {}) };
      if (identity) delete chans[ch];
      else chans[ch] = v;
      p.channels = Object.keys(chans).length ? chans : null;
    }
    sync();
    onChange(p, done);
  };
  const W = 256;
  const H = 100;
  const cv = h('canvas', { width: W, height: H, 'aria-label': '히스토그램' });
  const g = cv.getContext('2d');
  let H0 = null;
  const hist = () => {
    if (H0 === null) {
      try {
        H0 = env?.hist?.() || false;
      } catch {
        H0 = false;
      }
    }
    return H0 || null;
  };
  const tri = h('div.adj-tri');
  const tk = h('i.k');
  const tg = h('i.g');
  const tw = h('i.w');
  tri.append(tk, tg, tw);
  const outTri = h('div.adj-tri');
  const ok = h('i.k');
  const ow = h('i.w');
  outTri.append(ok, ow);
  const nIb = h('input.ph-num', { type: 'number', min: 0, max: 253, 'aria-label': '입력 검정' });
  const nG = h('input.ph-num', { type: 'number', min: 0.1, max: 9.99, step: 0.01, 'aria-label': '중간 톤 감마' });
  const nIw = h('input.ph-num', { type: 'number', min: 2, max: 255, 'aria-label': '입력 흰색' });
  const nOb = h('input.ph-num', { type: 'number', min: 0, max: 255, 'aria-label': '출력 검정' });
  const nOw = h('input.ph-num', { type: 'number', min: 0, max: 255, 'aria-label': '출력 흰색' });
  const nums = [nIb, nG, nIw, nOb, nOw];
  nums.forEach((n, i) => n.addEventListener('change', () => {
    const v = get();
    v[i] = +n.value;
    put(v, true);
  }));
  const ramp = h('div.adj-ramp');
  const sync = () => {
    const v = get();
    const pos = (x) => `${(x / 255) * 100}%`;
    tk.style.left = pos(v[0]);
    tw.style.left = pos(v[2]);
    tg.style.left = pos(v[0] + (v[2] - v[0]) * 0.5 ** v[1]);
    ok.style.left = pos(v[3]);
    ow.style.left = pos(v[4]);
    nIb.value = v[0];
    nG.value = Math.round(v[1] * 100) / 100;
    nIw.value = v[2];
    nOb.value = v[3];
    nOw.value = v[4];
    const col = { rgb: '#fff', r: '#f33', g: '#3c3', b: '#36f' }[ch];
    ramp.style.background = grad('#000', col);
    g.clearRect(0, 0, W, H);
    const hs = hist();
    drawHist(g, W, H, hs ? hs[ch === 'rgb' ? 'l' : ch] : null, { rgb: '#9aa0aa', r: '#d55', g: '#5b5', b: '#57e' }[ch]);
    // the resulting mapping, faintly
    const lut = levelsLut(v);
    g.strokeStyle = 'rgba(255,255,255,.25)';
    g.beginPath();
    for (let i = 0; i < 256; i++) {
      const y = H - (lut[i] / 255) * H;
      if (i) g.lineTo((i / 255) * W, y);
      else g.moveTo(0, y);
    }
    g.stroke();
  };
  const dragTri = (bar, which) => {
    bar.addEventListener('pointerdown', (e) => {
      const r = bar.getBoundingClientRect();
      const at = (ev) => clamp(((ev.clientX - r.left) / r.width) * 255, 0, 255);
      const v0 = get();
      // the nearest handle
      const x = at(e);
      const cands = which === 'in' ? [[0, v0[0]], [1, v0[0] + (v0[2] - v0[0]) * 0.5 ** v0[1]], [2, v0[2]]] : [[3, v0[3]], [4, v0[4]]];
      cands.sort((a, b) => Math.abs(a[1] - x) - Math.abs(b[1] - x));
      const idx = cands[0][0];
      bar.setPointerCapture(e.pointerId);
      const move = (ev, done) => {
        const v = get();
        const nx = at(ev);
        if (idx === 1) {
          const t = clamp((nx - v[0]) / Math.max(1, v[2] - v[0]), 0.01, 0.99);
          v[1] = clamp(Math.log(t) / Math.log(0.5), 0.1, 9.99);
        } else v[idx] = nx;
        put(v, done);
      };
      const mv = (ev) => move(ev, false);
      const up = (ev) => {
        bar.removeEventListener('pointermove', mv);
        bar.removeEventListener('pointerup', up);
        move(ev, true);
      };
      bar.addEventListener('pointermove', mv);
      bar.addEventListener('pointerup', up);
    });
  };
  dragTri(tri, 'in');
  dragTri(outTri, 'out');
  const chSel = select([['rgb', 'RGB'], ['r', '빨강'], ['g', '녹색'], ['b', '파랑']], ch, (v) => {
    ch = v;
    sync();
  }, '채널');
  const preset = select([...LEVELS_PRESETS.map(([id, t]) => [id, t]), ['custom', '사용자 정의']], 'custom', (id) => {
    const pr = LEVELS_PRESETS.find((x) => x[0] === id);
    if (!pr) return;
    p.channels = null;
    [p.inBlack, p.gamma, p.inWhite, p.outBlack, p.outWhite] = pr[2];
    ch = 'rgb';
    chSel.value = 'rgb';
    sync();
    onChange(p, true);
  }, '사전 설정');
  const auto = h('button.small', { type: 'button', title: '채널마다 가장 어두운 곳과 밝은 곳을 0.1% 잘라 늘립니다' }, '자동');
  auto.addEventListener('click', () => {
    const hs = hist();
    if (!hs) return;
    const chans = {};
    for (const c of ['r', 'g', 'b']) {
      const lo = percentile(hs[c], 0.001);
      const hi = Math.max(lo + 2, percentile(hs[c], 0.999));
      chans[c] = [lo, 1, hi, 0, 255];
    }
    p.channels = chans;
    sync();
    onChange(p, true);
  });
  const picks = pointPickers(env, (kind, rgb) => {
    const chans = { ...(p.channels || {}) };
    const cur = (c) => (chans[c] || [0, 1, 255, 0, 255]).slice();
    if (kind === 'black' || kind === 'white') {
      ['r', 'g', 'b'].forEach((c, i) => {
        const v = cur(c);
        if (kind === 'black') v[0] = clamp(Math.round(rgb[i]), 0, v[2] - 2);
        else v[2] = clamp(Math.round(rgb[i]), v[0] + 2, 255);
        chans[c] = v;
      });
    } else {
      // grey: each channel's midtone so the sample comes out neutral
      const outs = ['r', 'g', 'b'].map((c, i) => {
        const v = cur(c);
        return clamp((rgb[i] - v[0]) / Math.max(1, v[2] - v[0]), 0.01, 0.99);
      });
      const target = (outs[0] + outs[1] + outs[2]) / 3;
      ['r', 'g', 'b'].forEach((c, i) => {
        const v = cur(c);
        // t^(1/γ) = target  →  γ = ln t / ln target
        v[1] = clamp(Math.log(outs[i]) / Math.log(clamp(target, 0.02, 0.98)), 0.1, 9.99);
        chans[c] = v;
      });
    }
    p.channels = chans;
    sync();
    onChange(p, true);
  });
  sync();
  return [
    h('div.adj-row', h('span', '사전 설정'), preset),
    h('div.adj-row', h('span', '채널'), chSel, auto, picks),
    h('div.ph-sub', '입력 레벨'),
    h('div.adj-graph', cv, tri),
    h('div.adj-nums', nIb, nG, nIw),
    h('div.ph-sub', '출력 레벨'),
    h('div.adj-graph', ramp, outTri),
    h('div.adj-nums', nOb, nOw),
  ];
}

// ---------------------------------------------------------------- Curves

export const CURVE_PRESETS = [
  ['default', '기본값', {}],
  ['colorNegative', '컬러 네거티브 (RGB)', { r: [[0, 255], [255, 30]], g: [[0, 255], [255, 15]], b: [[0, 230], [255, 0]] }],
  ['crossProcess', '교차 처리 (RGB)', { r: [[0, 0], [64, 40], [190, 220], [255, 255]], g: [[0, 0], [64, 52], [190, 214], [255, 255]], b: [[0, 40], [255, 205]] }],
  ['darker', '어둡게 (RGB)', { points: [[0, 0], [140, 105], [255, 255]] }],
  ['increaseContrast', '대비 증가 (RGB)', { points: [[0, 0], [64, 52], [192, 204], [255, 255]] }],
  ['lighter', '밝게 (RGB)', { points: [[0, 0], [115, 150], [255, 255]] }],
  ['linearContrast', '선형 대비 (RGB)', { points: [[0, 0], [64, 56], [192, 200], [255, 255]] }],
  ['mediumContrast', '중간 대비 (RGB)', { points: [[0, 0], [64, 48], [192, 208], [255, 255]] }],
  ['negative', '네거티브 (RGB)', { points: [[0, 255], [255, 0]] }],
  ['strongContrast', '강한 대비 (RGB)', { points: [[0, 0], [64, 38], [192, 218], [255, 255]] }],
];

/**
 * A curves graph: click to add a point, drag to move, drag a point out of the box or double-click
 * it to remove it. opts: { color, hist (256 array), others: [[points, colour]…] drawn faintly, grid }.
 * onChange(points, done). Returns the element (with .setPoints, .redraw, .addAt).
 */
export function curvesGraph(points, onChange, opts = {}) {
  const S = 256;
  const c = h('canvas.ph-curve', { width: S, height: S, 'aria-label': '곡선' });
  let pts = (points || [[0, 0], [255, 255]]).map((q) => [...q]);
  let drag = -1;
  let sel = -1;
  let grid = opts.grid || 4;
  const g = c.getContext('2d');
  const draw = () => {
    g.fillStyle = '#101114';
    g.fillRect(0, 0, S, S);
    if (opts.hist) drawHist(g, S, S, typeof opts.hist === 'function' ? opts.hist() : opts.hist, 'rgba(140,146,156,.45)');
    g.strokeStyle = '#30353e';
    g.lineWidth = 1;
    for (let i = 1; i < grid; i++) {
      g.beginPath();
      g.moveTo((S * i) / grid + 0.5, 0);
      g.lineTo((S * i) / grid + 0.5, S);
      g.moveTo(0, (S * i) / grid + 0.5);
      g.lineTo(S, (S * i) / grid + 0.5);
      g.stroke();
    }
    g.strokeStyle = '#3a404b';
    g.beginPath();
    g.moveTo(0, S);
    g.lineTo(S, 0);
    g.stroke();
    for (const [op, col] of opts.others?.() || []) {
      if (!Array.isArray(op)) continue;
      const lut = curveLut(op);
      g.strokeStyle = col;
      g.beginPath();
      for (let x = 0; x < 256; x++) {
        const y = S - (lut[x] / 255) * S;
        if (x) g.lineTo((x / 255) * S, y);
        else g.moveTo(0, y);
      }
      g.stroke();
    }
    const lut = curveLut(pts);
    g.strokeStyle = opts.color || '#e8eaed';
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
    pts.forEach(([x, y], i) => {
      g.fillStyle = i === sel ? opts.color || '#fff' : '#101114';
      g.strokeStyle = opts.color || '#fff';
      g.fillRect((x / 255) * S - 4, S - (y / 255) * S - 4, 8, 8);
      g.strokeRect((x / 255) * S - 4.5, S - (y / 255) * S - 4.5, 9, 9);
    });
  };
  const at = (e) => {
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 255, (1 - (e.clientY - r.top) / r.height) * 255];
  };
  const emit = (done) => {
    onChange(pts.map((q) => [...q]), done);
    wrap.onSelect?.(sel >= 0 ? pts[sel] : null);
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.altKey) {
      // Alt+click: a finer grid (Photoshop)
      grid = grid === 4 ? 10 : 4;
      draw();
      return;
    }
    c.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    drag = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 10);
    if (drag < 0) {
      const nx = Math.round(clamp(x, 0, 255));
      if (pts.some(([px]) => px === nx)) return;
      pts.push([nx, Math.round(clamp(y, 0, 255))]);
      pts.sort((a, b) => a[0] - b[0]);
      drag = pts.findIndex(([px]) => px === nx);
    }
    sel = drag;
    draw();
    emit(false);
  });
  c.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = at(e);
    const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
    // dragged well out of the box: the point goes (not the last two)
    const out = x < -20 || x > 275 || y < -20 || y > 275;
    if (out && pts.length > 2) {
      pts.splice(drag, 1);
      drag = -1;
      sel = -1;
      draw();
      emit(false);
      return;
    }
    pts[drag] = [Math.round(clamp(x, lo, hi)), Math.round(clamp(y, 0, 255))];
    draw();
    emit(false);
  });
  const end = () => {
    if (drag >= 0 || sel === -1) emit(true);
    drag = -1;
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('dblclick', (e) => {
    const [x, y] = at(e);
    const i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 10);
    if (i >= 0 && pts.length > 2) {
      pts.splice(i, 1);
      sel = -1;
      draw();
      emit(true);
    }
  });
  const wrap = h('div.ph-curvewrap', c);
  wrap.setPoints = (np) => {
    pts = (np || [[0, 0], [255, 255]]).map((q) => [...q]);
    sel = -1;
    draw();
  };
  wrap.redraw = draw;
  wrap.selected = () => (sel >= 0 ? pts[sel] : null);
  wrap.setSelected = (x, y) => {
    if (sel < 0) return;
    const lo = sel > 0 ? pts[sel - 1][0] + 1 : 0;
    const hi = sel < pts.length - 1 ? pts[sel + 1][0] - 1 : 255;
    pts[sel] = [Math.round(clamp(x, lo, hi)), Math.round(clamp(y, 0, 255))];
    draw();
    emit(true);
  };
  /** Add (or move) a point at input x to output y (on-image adjustments, eyedroppers). */
  wrap.addAt = (x, y, done = true) => {
    x = Math.round(clamp(x, 0, 255));
    let i = pts.findIndex(([px]) => Math.abs(px - x) < 3);
    if (i < 0) {
      pts.push([x, Math.round(clamp(y, 0, 255))]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex(([px]) => px === x);
    } else pts[i] = [pts[i][0], Math.round(clamp(y, 0, 255))];
    sel = i;
    draw();
    emit(done);
  };
  wrap.points = () => pts.map((q) => [...q]);
  draw();
  return wrap;
}

export function curvesEditor(p, onChange, env) {
  ensureAdjStyle();
  let ch = 'points';
  let H0 = null;
  const hist = () => {
    if (H0 === null) {
      try {
        H0 = env?.hist?.() || false;
      } catch {
        H0 = false;
      }
    }
    return H0 || null;
  };
  const colors = { points: '#e8eaed', r: '#ff6b6b', g: '#5fd35f', b: '#6b8bff' };
  const cur = () => (Array.isArray(p[ch]) && p[ch].length >= 2 ? p[ch] : [[0, 0], [255, 255]]);
  const isIdentity = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255;
  const inN = h('input.ph-num', { type: 'number', min: 0, max: 255, 'aria-label': '입력' });
  const outN = h('input.ph-num', { type: 'number', min: 0, max: 255, 'aria-label': '출력' });
  const graph = curvesGraph(cur(), (pts, done) => {
    p[ch] = ch !== 'points' && isIdentity(pts) ? null : pts;
    onChange(p, done);
  }, {
    color: colors.points,
    hist: () => {
      const hs = hist();
      return hs ? hs[ch === 'points' ? 'l' : ch] : null;
    },
    others: () => (ch === 'points' ? [['r', '#ff6b6b80'], ['g', '#5fd35f80'], ['b', '#6b8bff80']].filter(([k]) => Array.isArray(p[k])).map(([k, c]) => [p[k], c]) : []),
  });
  graph.onSelect = (pt) => {
    inN.value = pt ? pt[0] : '';
    outN.value = pt ? pt[1] : '';
  };
  for (const n of [inN, outN]) n.addEventListener('change', () => graph.setSelected(+inN.value, +outN.value));
  const setCh = (v) => {
    ch = v;
    graph.setPoints(cur());
    chSel.value = v;
  };
  const chSel = select([['points', 'RGB'], ['r', '빨강'], ['g', '녹색'], ['b', '파랑']], ch, (v) => setCh(v), '채널');
  const preset = select([...CURVE_PRESETS.map(([id, t]) => [id, t]), ['custom', '사용자 정의']], 'custom', (id) => {
    const pr = CURVE_PRESETS.find((x) => x[0] === id);
    if (!pr) return;
    p.points = pr[2].points || [[0, 0], [255, 255]];
    p.r = pr[2].r || null;
    p.g = pr[2].g || null;
    p.b = pr[2].b || null;
    setCh('points');
    onChange(p, true);
  }, '사전 설정');
  const auto = h('button.small', { type: 'button', title: '채널마다 대비를 늘립니다 (0.1% 잘라내기)' }, '자동');
  auto.addEventListener('click', () => {
    const hs = hist();
    if (!hs) return;
    for (const c of ['r', 'g', 'b']) {
      const lo = percentile(hs[c], 0.001);
      const hi = Math.max(lo + 2, percentile(hs[c], 0.999));
      p[c] = [[lo, 0], [hi, 255]];
    }
    setCh(ch);
    onChange(p, true);
  });
  const picks = pointPickers(env, (kind, rgb) => {
    const L = lum(rgb[0], rgb[1], rgb[2]);
    ['r', 'g', 'b'].forEach((c, i) => {
      let pts = Array.isArray(p[c]) ? p[c].map((q) => [...q]) : [[0, 0], [255, 255]];
      const v = Math.round(clamp(rgb[i], 1, 254));
      if (kind === 'black') {
        pts = pts.filter(([x]) => x > v);
        pts.unshift([v, 0]);
      } else if (kind === 'white') {
        pts = pts.filter(([x]) => x < v);
        pts.push([v, 255]);
      } else {
        pts = pts.filter(([x]) => Math.abs(x - v) > 2);
        pts.push([v, Math.round(L)]);
        pts.sort((a, b) => a[0] - b[0]);
      }
      p[c] = pts;
    });
    setCh(ch);
    onChange(p, true);
  });
  // on-image adjustment: click a spot of the picture to put a point at its brightness
  const onImage = h('button.small', { type: 'button', title: '이미지에서 클릭하여 그 밝기에 점 추가' }, '이미지에서 점 추가');
  onImage.addEventListener('click', () => {
    if (!env?.sample) return;
    onImage.classList.add('on');
    env.sample((rgb) => {
      onImage.classList.remove('on');
      if (!rgb) return;
      const v = ch === 'points' ? lum(rgb[0], rgb[1], rgb[2]) : rgb[{ r: 0, g: 1, b: 2 }[ch]];
      const lut = curveLut(cur());
      graph.addAt(v, lut[Math.round(clamp(v, 0, 255))]);
    });
  });
  return [
    h('div.adj-row', h('span', '사전 설정'), preset),
    h('div.adj-row', h('span', '채널'), chSel, auto, picks),
    graph,
    h('div.adj-row', h('span', '입력'), inN, h('span', '출력'), outN, onImage),
    h('div.note', '누르면 점 추가 · 끌어서 이동 · 상자 밖으로 끌거나 두 번 눌러 삭제 · Alt+클릭: 격자'),
  ];
}

// ---------------------------------------------------------------- Hue / Saturation

const HS_PRESETS = [
  ['default', '기본값', { hue: 0, saturation: 0, lightness: 0, colorize: false, ranges: null }],
  ['cyanotype', '시안 화', { hue: 200, saturation: 25, lightness: 0, colorize: true, ranges: null }],
  ['sepia', '세피아', { hue: 35, saturation: 25, lightness: 0, colorize: true, ranges: null }],
  ['oldStyle', '이전 스타일', { hue: 0, saturation: -40, lightness: 0, colorize: false, ranges: { yellows: { h: 0, s: 20, l: 0 } } }],
  ['redBoost', '빨강 증가', { hue: 0, saturation: 0, lightness: 0, colorize: false, ranges: { reds: { h: 0, s: 30, l: 0 } } }],
  ['yellowBoost', '노랑 증가', { hue: 0, saturation: 0, lightness: 0, colorize: false, ranges: { yellows: { h: 0, s: 30, l: 0 } } }],
  ['satMore', '채도 증가', { hue: 0, saturation: 25, lightness: 0, colorize: false, ranges: null }],
  ['satStrong', '채도 많이 증가', { hue: 0, saturation: 50, lightness: 0, colorize: false, ranges: null }],
  ['desat', '채도 감소', { hue: 0, saturation: -60, lightness: 0, colorize: false, ranges: null }],
];

export function hueSatEditor(p, onChange, env) {
  ensureAdjStyle();
  let edit = 'master';
  const range = () => (edit === 'master' ? null : HUE_RANGES.find((r) => r[0] === edit));
  const rv = () => {
    const r = p.ranges?.[edit] || {};
    return { h: r.h || 0, s: r.s || 0, l: r.l || 0, r: Array.isArray(r.r) ? r.r.slice() : range()[2].slice() };
  };
  const setRange = (patch, done) => {
    const v = { ...rv(), ...patch };
    const ranges = { ...(p.ranges || {}) };
    const def = range()[2];
    if (!v.h && !v.s && !v.l && JSON.stringify(v.r) === JSON.stringify(def)) delete ranges[edit];
    else ranges[edit] = v;
    p.ranges = Object.keys(ranges).length ? ranges : null;
    onChange(p, done);
  };
  const hue = slider('색조', -180, 180, 0, (v, done) => {
    if (edit === 'master') {
      p.hue = v;
      onChange(p, done);
    } else {
      setRange({ h: v }, done);
      syncRange();
    }
  }, { bg: SPECTRUM });
  const sat = slider('채도', -100, 100, 0, (v, done) => {
    if (edit === 'master') {
      p.saturation = v;
      onChange(p, done);
    } else setRange({ s: v }, done);
  });
  const lig = slider('밝기', -100, 100, 0, (v, done) => {
    if (edit === 'master') {
      p.lightness = v;
      onChange(p, done);
    } else setRange({ l: v }, done);
  }, { bg: grad('#000', '#fff') });
  const colorize = h('input', { type: 'checkbox' });
  // the range bar: four handles (ramp start, full from, full to, ramp end)
  const hueBox = h('div.adj-hue');
  const topBar = h('div.bar', { style: { top: '0px', background: SPECTRUM } });
  const botBar = h('div.bar', { style: { top: '28px', background: SPECTRUM } });
  const handles = [0, 1, 2, 3].map((i) => h(`div.h${i === 1 || i === 2 ? '.in' : ''}`));
  hueBox.append(topBar, botBar, ...handles);
  const rangeRow = h('div', hueBox, h('div.note', '가운데 두 손잡이 사이는 완전히, 바깥 손잡이까지는 서서히 바뀝니다.'));
  // the shown hue bars start opposite the edited range so it sits in the middle
  let heldOrigin = null;
  const origin = () => {
    if (heldOrigin != null) return heldOrigin;
    const r = rv().r;
    const centre = (r[0] + ((r[3] - r[0] + 360) % 360) / 2) % 360;
    return (centre + 180) % 360;
  };
  // the lower bar shows the result: hues inside the range moved by its hue shift
  const weightAt = (hh, [a, b, c, d]) => {
    const rel = (x) => (((x - a) % 360) + 360) % 360;
    const t = rel(hh);
    const tb = rel(b);
    const tc = rel(c);
    const td = rel(d);
    return t <= tb ? (tb ? t / tb : 1) : t <= tc ? 1 : t <= td ? (td - t) / Math.max(1e-6, td - tc) : 0;
  };
  const spectrumFrom = (o, shift = 0, bounds = null) => {
    const stops = [];
    for (let i = 0; i <= 24; i++) {
      const hh = (o + i * 15) % 360;
      const k = bounds ? weightAt(hh, bounds) : 1;
      stops.push(`hsl(${hh + shift * k},100%,50%) ${(i / 24) * 100}%`);
    }
    return `linear-gradient(90deg, ${stops.join(',')})`;
  };
  const syncRange = () => {
    rangeRow.hidden = !range() || p.colorize;
    if (rangeRow.hidden) return;
    const o = origin();
    const v = rv();
    topBar.style.background = spectrumFrom(o);
    botBar.style.background = spectrumFrom(o, v.h, v.r);
    v.r.forEach((deg, i) => {
      handles[i].style.left = `${((((deg - o) % 360) + 360) % 360) / 3.6}%`;
    });
  };
  hueBox.addEventListener('pointerdown', (e) => {
    if (!range()) return;
    const rect = hueBox.getBoundingClientRect();
    const o = origin();
    const toDeg = (ev) => (o + clamp((ev.clientX - rect.left) / rect.width, 0, 1) * 360) % 360;
    const v = rv();
    const pos = v.r.map((deg) => ((((deg - o) % 360) + 360) % 360) / 360);
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    let idx = 0;
    pos.forEach((t, i) => {
      if (Math.abs(t - x) < Math.abs(pos[idx] - x)) idx = i;
    });
    hueBox.setPointerCapture(e.pointerId);
    // the bar stays put while a handle is dragged
    heldOrigin = o;
    const move = (ev, done) => {
      const vv = rv();
      vv.r[idx] = Math.round(toDeg(ev));
      setRange({ r: vv.r }, done);
      syncRange();
    };
    const mv = (ev) => move(ev, false);
    const up = (ev) => {
      hueBox.removeEventListener('pointermove', mv);
      hueBox.removeEventListener('pointerup', up);
      move(ev, true);
      heldOrigin = null;
      syncRange();
    };
    hueBox.addEventListener('pointermove', mv);
    hueBox.addEventListener('pointerup', up);
  });
  const pick = h('button.small', { type: 'button', title: '이미지에서 색을 눌러 그 색 범위를 편집' }, '스포이드로 범위 고르기');
  pick.addEventListener('click', () => {
    if (!env?.sample) return;
    pick.classList.add('on');
    env.sample((rgb) => {
      pick.classList.remove('on');
      if (!rgb) return;
      const [r, g, b] = rgb.map((v) => v / 255);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx - mn < 0.03) return toast('회색에 가까운 색은 색 범위를 고를 수 없습니다');
      const dd = mx - mn;
      let hh = mx === r ? (g - b) / dd : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      hh = ((hh * 60) + 360) % 360;
      // the nearest named range, its bounds centred on the picked hue
      const best = HUE_RANGES.map((x) => {
        const c = (x[2][1] + ((x[2][2] - x[2][1] + 360) % 360) / 2) % 360;
        let dist = Math.abs(c - hh);
        if (dist > 180) dist = 360 - dist;
        return [x[0], dist];
      }).sort((a, b) => a[1] - b[1])[0][0];
      edit = best;
      editSel.value = best;
      const H = Math.round(hh);
      setRange({ r: [(H - 45 + 360) % 360, (H - 15 + 360) % 360, (H + 15) % 360, (H + 45) % 360] }, true);
      syncAll();
    });
  });
  const editSel = select([['master', '마스터'], ...HUE_RANGES.map(([id, n]) => [id, n])], edit, (v) => {
    edit = v;
    syncAll();
  }, '편집');
  const syncAll = () => {
    const m = edit === 'master';
    const v = m ? { h: p.hue, s: p.saturation, l: p.lightness } : rv();
    hue.set(v.h || 0);
    sat.set(v.s || 0);
    lig.set(v.l || 0);
    colorize.checked = !!p.colorize;
    editSel.disabled = !!p.colorize;
    syncRange();
  };
  colorize.addEventListener('change', () => {
    p.colorize = colorize.checked;
    if (p.colorize) {
      // Photoshop: hue from the foreground colour, saturation 25
      edit = 'master';
      editSel.value = 'master';
      const fg = env?.P?.fg;
      let hh = 0;
      if (fg) {
        const [r, g, b] = hexRgb(fg).map((x) => x / 255);
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (mx > mn) {
          hh = mx === r ? (g - b) / (mx - mn) : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
          hh = Math.round(((hh * 60) + 360) % 360);
        }
      }
      p.hue = hh;
      p.saturation = 25;
      p.lightness = 0;
    } else {
      p.hue = 0;
      p.saturation = 0;
    }
    syncAll();
    onChange(p, true);
  });
  const preset = select([...HS_PRESETS.map(([id, t]) => [id, t]), ['custom', '사용자 정의']], 'custom', (id) => {
    const pr = HS_PRESETS.find((x) => x[0] === id);
    if (!pr) return;
    Object.assign(p, structuredClone(pr[2]));
    edit = 'master';
    editSel.value = 'master';
    syncAll();
    onChange(p, true);
  }, '사전 설정');
  syncAll();
  return [
    h('div.adj-row', h('span', '사전 설정'), preset),
    h('div.adj-row', h('span', '편집'), editSel, pick),
    hue.el, sat.el, lig.el,
    rangeRow,
    h('label.ph-prow', colorize, '색상화'),
  ];
}

// ---------------------------------------------------------------- Color Balance

export function colorBalanceEditor(p, onChange) {
  ensureAdjStyle();
  let tone = 'midtones';
  const vals = () => (tone === 'midtones' ? [p.cr || 0, p.mg || 0, p.yb || 0] : (p[tone] || [0, 0, 0]).slice());
  const put = (i, v, done) => {
    if (tone === 'midtones') p[['cr', 'mg', 'yb'][i]] = v;
    else {
      const a = vals();
      a[i] = v;
      p[tone] = a.some((x) => x) ? a : null;
    }
    onChange(p, done);
  };
  const s = [
    slider('녹청 ↔ 빨강', -100, 100, 0, (v, d) => put(0, v, d), { bg: grad('#00c8c8', '#e03030') }),
    slider('마젠타 ↔ 녹색', -100, 100, 0, (v, d) => put(1, v, d), { bg: grad('#d040d0', '#30b030') }),
    slider('노랑 ↔ 파랑', -100, 100, 0, (v, d) => put(2, v, d), { bg: grad('#e0d030', '#3050e0') }),
  ];
  const sync = () => vals().forEach((v, i) => s[i].set(v));
  const name = `cbtone${Math.random().toString(36).slice(2)}`;
  const toneBtns = [['shadows', '어두운 영역'], ['midtones', '중간 영역'], ['highlights', '밝은 영역']].map(([id, t]) => {
    const r = h('input', { type: 'radio', name, checked: id === tone });
    r.addEventListener('change', () => {
      tone = id;
      sync();
    });
    return h('label.inline', r, t);
  });
  const keep = h('input', { type: 'checkbox', checked: p.preserve !== false });
  keep.addEventListener('change', () => {
    p.preserve = keep.checked;
    onChange(p, true);
  });
  sync();
  return [h('div.adj-row', h('span', '톤'), ...toneBtns), ...s.map((x) => x.el), h('label.ph-prow', keep, '광도 유지')];
}

// ---------------------------------------------------------------- Black & White

const BW_KEYS = [['reds', '빨강 계열', '#e03030'], ['yellows', '노랑 계열', '#e0d030'], ['greens', '녹색 계열', '#30b030'], ['cyans', '녹청 계열', '#00c8c8'], ['blues', '파랑 계열', '#3050e0'], ['magentas', '마젠타 계열', '#d040d0']];
const BW_PRESETS = [
  ['default', '기본값', [40, 60, 40, 60, 20, 80]],
  ['blueFilter', '파랑 필터', [0, 0, 0, 50, 120, 70]],
  ['darker', '더 어둡게', [25, 40, 25, 40, 10, 60]],
  ['greenFilter', '녹색 필터', [40, 80, 100, 60, 20, 40]],
  ['highBlue', '높은 대비 파랑 필터', [-30, -20, 40, 120, 150, 70]],
  ['highRed', '높은 대비 빨강 필터', [120, 120, -10, -50, -50, 120]],
  ['infrared', '적외선', [-40, 235, 144, -68, -3, -107]],
  ['lighter', '더 밝게', [55, 75, 55, 75, 35, 95]],
  ['maxBlack', '최대 검정', [0, 0, 0, 0, 0, 0]],
  ['maxWhite', '최대 흰색', [100, 100, 100, 100, 100, 100]],
  ['neutral', '중간 밀도', [20, 30, 20, 30, 20, 30]],
  ['redFilter', '빨강 필터', [120, 110, -10, -50, -50, 120]],
  ['yellowFilter', '노랑 필터', [100, 110, 40, 30, 10, 70]],
];

export function bwEditor(p, onChange, env) {
  ensureAdjStyle();
  const sl = BW_KEYS.map(([k, n, c]) => slider(n, -200, 300, p[k], (v, done) => {
    p[k] = v;
    onChange(p, done);
  }, { bg: grad('#000', c) }));
  const sync = () => {
    BW_KEYS.forEach(([k], i) => sl[i].set(p[k]));
    tint.checked = !!p.tint;
    hue.set(p.tintHue ?? 42);
    tsat.set(p.tintSat ?? 20);
    tintRows.hidden = !p.tint;
    swatch.style.background = rgbHex(...hslToRgb((p.tintHue ?? 42) / 360, (p.tintSat ?? 20) / 100, 0.5));
  };
  const preset = select([...BW_PRESETS.map(([id, t]) => [id, t]), ['custom', '사용자 정의']], 'custom', (id) => {
    const pr = BW_PRESETS.find((x) => x[0] === id);
    if (!pr) return;
    BW_KEYS.forEach(([k], i) => { p[k] = pr[2][i]; });
    sync();
    onChange(p, true);
  }, '사전 설정');
  const auto = h('button.small', { type: 'button', title: '사진의 색에 맞춰 회색 단계가 가장 넓게 퍼지도록 맞춥니다' }, '자동');
  auto.addEventListener('click', () => {
    const src = env?.histSource?.();
    if (!src) return;
    // a small copy: search the mix that spreads the greys the most (with a pull toward the default)
    const k = Math.min(1, 64 / Math.max(src.width, src.height));
    const c = mk(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) px.push([d[i], d[i + 1], d[i + 2]]);
    if (!px.length) return;
    const W = BW_KEYS.map(([kk]) => p[kk] / 100);
    const grey = ([r, g, b], w) => {
      const [wR, wY, wG, wC, wB, wM] = w;
      if (r >= g && r >= b) return g >= b ? b + (g - b) * wY + (r - g) * wR : g + (b - g) * wM + (r - b) * wR;
      if (g >= r && g >= b) return r >= b ? b + (r - b) * wY + (g - r) * wG : r + (b - r) * wC + (g - b) * wG;
      return r >= g ? g + (r - g) * wM + (b - r) * wB : r + (g - r) * wC + (b - g) * wB;
    };
    const score = (w) => {
      let s = 0;
      let s2 = 0;
      for (const q of px) {
        const v = Math.min(255, Math.max(0, grey(q, w)));
        s += v;
        s2 += v * v;
      }
      const m = s / px.length;
      const def = [0.4, 0.6, 0.4, 0.6, 0.2, 0.8];
      let pen = 0;
      w.forEach((x, i) => { pen += (x - def[i]) ** 2; });
      return Math.sqrt(Math.max(0, s2 / px.length - m * m)) - pen * 25 - Math.abs(m - 128) * 0.15;
    };
    let best = score(W);
    for (let it = 0; it < 30; it++) {
      let improved = false;
      for (let i = 0; i < 6; i++) {
        for (const dlt of [0.1, -0.1]) {
          const t = W.slice();
          t[i] = clamp(t[i] + dlt, -2, 3);
          const sc = score(t);
          if (sc > best + 1e-6) {
            best = sc;
            W[i] = t[i];
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    BW_KEYS.forEach(([kk], i) => { p[kk] = Math.round(W[i] * 100); });
    sync();
    onChange(p, true);
  });
  const tint = h('input', { type: 'checkbox' });
  const swatch = h('span.adj-drop', { style: { width: '22px', height: '16px', borderRadius: '3px' } });
  const hue = slider('색조', 0, 360, p.tintHue ?? 42, (v, done) => {
    p.tintHue = v;
    sync();
    onChange(p, done);
  }, { bg: SPECTRUM });
  const tsat = slider('채도 (%)', 0, 100, p.tintSat ?? 20, (v, done) => {
    p.tintSat = v;
    sync();
    onChange(p, done);
  });
  const tintRows = h('div', hue.el, tsat.el);
  tint.addEventListener('change', () => {
    p.tint = tint.checked;
    sync();
    onChange(p, true);
  });
  sync();
  return [h('div.adj-row', h('span', '사전 설정'), preset, auto), ...sl.map((x) => x.el), h('label.ph-prow', tint, '색조', swatch), tintRows];
}

// ---------------------------------------------------------------- Photo Filter

export function photoFilterEditor(p, onChange) {
  ensureAdjStyle();
  const name = `pf${Math.random()}`;
  const useFilter = h('input', { type: 'radio', name, checked: p.filter !== 'custom' });
  const useColor = h('input', { type: 'radio', name, checked: p.filter === 'custom' });
  const sel = select(PHOTO_FILTERS.map(([id, n]) => [id, n]), PHOTO_FILTERS.some((f) => f[0] === p.filter) ? p.filter : 'warm85', (id) => {
    p.filter = id;
    p.color = PHOTO_FILTERS.find((f) => f[0] === id)[2];
    useFilter.checked = true;
    col.value = p.color;
    onChange(p, true);
  }, '필터');
  const col = h('input', { type: 'color', value: p.color || '#ec8a00', 'aria-label': '색상' });
  col.addEventListener('input', () => {
    p.filter = 'custom';
    p.color = col.value;
    useColor.checked = true;
    onChange(p, false);
  });
  col.addEventListener('change', () => onChange(p, true));
  useFilter.addEventListener('change', () => sel.dispatchEvent(new Event('change')));
  useColor.addEventListener('change', () => {
    p.filter = 'custom';
    p.color = col.value;
    onChange(p, true);
  });
  return [h('div.adj-row', h('label.inline', useFilter, '필터'), sel), h('div.adj-row', h('label.inline', useColor, '색상'), col)];
}

// ---------------------------------------------------------------- Channel Mixer

const MIX_PRESETS = [
  ['default', '기본값', { mono: false, rr: 100, rg: 0, rb: 0, gr: 0, gg: 100, gb: 0, br: 0, bg: 0, bb: 100, rk: 0, gk: 0, bk: 0 }],
  ['bwInfrared', '흑백 적외선 (RGB)', { mono: true, mr: -70, mg: 200, mb: -30, mk: 0 }],
  ['bwBlue', '흑백 파랑 필터 (RGB)', { mono: true, mr: 0, mg: 0, mb: 100, mk: 0 }],
  ['bwGreen', '흑백 녹색 필터 (RGB)', { mono: true, mr: 0, mg: 100, mb: 0, mk: 0 }],
  ['bwOrange', '흑백 주황 필터 (RGB)', { mono: true, mr: 50, mg: 50, mb: 0, mk: 0 }],
  ['bwRed', '흑백 빨강 필터 (RGB)', { mono: true, mr: 100, mg: 0, mb: 0, mk: 0 }],
  ['bwYellow', '흑백 노랑 필터 (RGB)', { mono: true, mr: 34, mg: 66, mb: 0, mk: 0 }],
  ['bwNormal', '흑백 (40/40/20)', { mono: true, mr: 40, mg: 40, mb: 20, mk: 0 }],
  ['swapRB', '빨강과 파랑 바꾸기', { mono: false, rr: 0, rg: 0, rb: 100, gr: 0, gg: 100, gb: 0, br: 100, bg: 0, bb: 0, rk: 0, gk: 0, bk: 0 }],
];

export function channelMixerEditor(p, onChange) {
  ensureAdjStyle();
  let out = 'r';
  const keys = () => (p.mono ? ['mr', 'mg', 'mb', 'mk'] : [`${out}r`, `${out}g`, `${out}b`, `${out}k`]);
  const val = (k) => {
    if (k.endsWith('k') && k.length === 2 && k !== 'mk' && (p[k] == null || p[k] === 0) && p.constant) return p.constant;
    return p[k] ?? (k === 'mr' ? 40 : k === 'mg' ? 40 : k === 'mb' ? 20 : 0);
  };
  const total = h('span.adj-total');
  const sl = [['빨강', '#e03030'], ['녹색', '#30b030'], ['파랑', '#3050e0']].map(([n, c], i) => slider(`${n} (%)`, -200, 200, 0, (v, done) => {
    p[keys()[i]] = v;
    syncTotal();
    onChange(p, done);
  }, { bg: grad('#000', c) }));
  const konst = slider('상수 (%)', -200, 200, 0, (v, done) => {
    p[keys()[3]] = v;
    if (p.constant) p.constant = 0;
    onChange(p, done);
  });
  const syncTotal = () => {
    const t = keys().slice(0, 3).reduce((s, k) => s + (+val(k) || 0), 0);
    total.textContent = `총계: ${t > 0 ? '+' : ''}${t}%`;
    total.style.color = t > 100 ? 'var(--warn)' : '';
  };
  const outSel = select([['r', '빨강'], ['g', '녹색'], ['b', '파랑']], out, (v) => {
    out = v;
    sync();
  }, '출력 채널');
  const mono = h('input', { type: 'checkbox', checked: !!p.mono });
  mono.addEventListener('change', () => {
    p.mono = mono.checked;
    if (p.mono && p.mr == null) Object.assign(p, { mr: 40, mg: 40, mb: 20, mk: 0 });
    sync();
    onChange(p, true);
  });
  const sync = () => {
    outSel.disabled = !!p.mono;
    if (p.mono) outSel.title = '단색: 회색 출력';
    keys().forEach((k, i) => (i < 3 ? sl[i] : konst).set(val(k)));
    mono.checked = !!p.mono;
    syncTotal();
  };
  const preset = select([...MIX_PRESETS.map(([id, t]) => [id, t]), ['custom', '사용자 정의']], 'custom', (id) => {
    const pr = MIX_PRESETS.find((x) => x[0] === id);
    if (!pr) return;
    Object.assign(p, structuredClone(pr[2]));
    p.constant = 0;
    sync();
    onChange(p, true);
  }, '사전 설정');
  sync();
  return [h('div.adj-row', h('span', '사전 설정'), preset), h('div.adj-row', h('span', '출력 채널'), outSel, total), ...sl.map((x) => x.el), konst.el, h('label.ph-prow', mono, '단색')];
}

// ---------------------------------------------------------------- Gradient Map

export function gradientMapEditor(p, onChange, env) {
  ensureAdjStyle();
  const eff = () => (p.gradient?.stops?.length ? p.gradient : { name: '사용자', stops: [{ pos: 0, color: p.from || '#000000' }, { pos: 1, color: p.to || '#ffffff' }] });
  const btn = h('button.ph-gradbtn', { type: 'button', title: '눌러서 그레이디언트 편집' });
  const paint = () => btn.replaceChildren(gradientSwatch(eff(), 200, 18, env?.P?.fg, env?.P?.bg));
  btn.addEventListener('click', async () => {
    const { gradientEditor } = await import('./pdialogs.js');
    gradientEditor(env?.P, eff(), (g) => {
      p.gradient = g;
      paint();
      onChange(p, true);
    });
  });
  const pre = select([['', '사전 설정 고르기…'], ...GRADIENTS.map((g, i) => [i, g.name])], '', (v) => {
    if (v === '') return;
    p.gradient = structuredClone(GRADIENTS[+v]);
    pre.value = '';
    paint();
    onChange(p, true);
  }, '그레이디언트 사전 설정');
  paint();
  return [h('div.adj-row', h('span', '그레이디언트'), btn), h('div.adj-row', h('span', ''), pre)];
}

// ---------------------------------------------------------------- Selective Color

export function selectiveColorEditor(p, onChange) {
  ensureAdjStyle();
  let target = p.target || 'reds';
  const cur = () => {
    const v = p.colors?.[target];
    if (Array.isArray(v)) return v.slice();
    // an older single-colour setting
    if (!p.colors && target === (p.target || 'reds')) return [p.cyan || 0, p.magenta || 0, p.yellow || 0, p.black || 0];
    return [0, 0, 0, 0];
  };
  const put = (i, v, done) => {
    const colors = { ...(p.colors || (p.cyan || p.magenta || p.yellow || p.black ? { [p.target || 'reds']: [p.cyan || 0, p.magenta || 0, p.yellow || 0, p.black || 0] } : {})) };
    const a = cur();
    a[i] = v;
    if (a.some((x) => x)) colors[target] = a;
    else delete colors[target];
    p.colors = colors;
    // the shown colour also in the older single keys
    p.target = target;
    [p.cyan, p.magenta, p.yellow, p.black] = a;
    onChange(p, done);
  };
  const sl = [['녹청 (%)', '#00c8c8'], ['마젠타 (%)', '#d040d0'], ['노랑 (%)', '#e0d030'], ['검정 (%)', '#000']].map(([n, c], i) => slider(n, -100, 100, 0, (v, d) => put(i, v, d), { bg: grad('#fff', c) }));
  const sync = () => cur().forEach((v, i) => sl[i].set(v));
  const tSel = select(SELECTIVE_TARGETS, target, (v) => {
    target = v;
    p.target = v;
    sync();
  }, '색상');
  const name = `sc${Math.random()}`;
  const rel = h('input', { type: 'radio', name, checked: !p.absolute });
  const abs = h('input', { type: 'radio', name, checked: !!p.absolute });
  rel.addEventListener('change', () => {
    p.absolute = false;
    onChange(p, true);
  });
  abs.addEventListener('change', () => {
    p.absolute = true;
    onChange(p, true);
  });
  sync();
  return [h('div.adj-row', h('span', '색상'), tSel), ...sl.map((x) => x.el), h('div.adj-row', h('span', '방법'), h('label.inline', rel, '상대치'), h('label.inline', abs, '절대치'))];
}

// ---------------------------------------------------------------- Color Lookup: LUT files

/** Parse a .cube or .3dl file into { size, data (base64 of r-fastest RGB bytes) }. */
export function parseLut(text, name = '') {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const is3dl = /\.3dl$/i.test(name) || (!lines.some((l) => /^LUT_3D_SIZE/i.test(l)) && /^\d+(\s+\d+){4,}$/.test(lines[0] || ''));
  let N = 0;
  let vals = [];
  if (!is3dl) {
    let dmin = [0, 0, 0];
    let dmax = [1, 1, 1];
    for (const l of lines) {
      if (/^LUT_3D_SIZE/i.test(l)) N = parseInt(l.split(/\s+/)[1], 10);
      else if (/^DOMAIN_MIN/i.test(l)) dmin = l.split(/\s+/).slice(1).map(Number);
      else if (/^DOMAIN_MAX/i.test(l)) dmax = l.split(/\s+/).slice(1).map(Number);
      else if (/^LUT_1D_SIZE/i.test(l)) throw new Error('1D LUT은 지원하지 않습니다 (3D LUT 파일을 쓰세요)');
      else if (/^[-\d.]/.test(l)) {
        const a = l.split(/\s+/).map(Number);
        if (a.length >= 3) vals.push((a[0] - dmin[0]) / (dmax[0] - dmin[0] || 1), (a[1] - dmin[1]) / (dmax[1] - dmin[1] || 1), (a[2] - dmin[2]) / (dmax[2] - dmin[2] || 1));
      }
    }
    if (!N || vals.length < N * N * N * 3) throw new Error('.cube 파일을 읽지 못했습니다');
  } else {
    // .3dl: a header line with the input steps, then "R G B" integers, blue changing fastest
    const rows = lines.map((l) => l.split(/\s+/).map(Number)).filter((a) => a.every(Number.isFinite));
    let start = 0;
    if (rows[0] && rows[0].length > 3) {
      N = rows[0].length;
      start = 1;
    }
    const data = rows.slice(start).filter((a) => a.length >= 3);
    if (!N) N = Math.round(Math.cbrt(data.length));
    if (N < 2 || data.length < N * N * N) throw new Error('.3dl 파일을 읽지 못했습니다');
    let mx = 0;
    for (const a of data) mx = Math.max(mx, a[0], a[1], a[2]);
    const scale = mx > 4095 ? 65535 : mx > 1023 ? 4095 : mx > 255 ? 1023 : 255;
    vals = new Array(N * N * N * 3);
    for (let r = 0; r < N; r++) for (let g = 0; g < N; g++) for (let b = 0; b < N; b++) {
      const src = data[(r * N + g) * N + b];
      const dst = ((b * N + g) * N + r) * 3;
      vals[dst] = src[0] / scale;
      vals[dst + 1] = src[1] / scale;
      vals[dst + 2] = src[2] / scale;
    }
  }
  if (N > 65) throw new Error('LUT이 너무 큽니다 (최대 65)');
  const bytes = new Uint8Array(N * N * N * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = clamp(Math.round(vals[i] * 255), 0, 255);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { name: name.replace(/\.[^.]+$/, ''), size: N, data: btoa(bin) };
}

export function lutEditor(p, onChange, env) {
  ensureAdjStyle();
  const label = h('span.note', p.lut?.name ? `불러온 파일: ${p.lut.name}` : '불러온 파일 없음');
  const input = h('input', { type: 'file', accept: '.cube,.3dl', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      p.lut = parseLut(await f.text(), f.name);
      p.look = 'file';
      env?.ctl?.('look')?.(p.look);
      label.textContent = `불러온 파일: ${p.lut.name} (${p.lut.size}³)`;
      onChange(p, true);
    } catch (err) {
      toast(String(err.message || err));
    }
    input.value = '';
  });
  const btn = h('button.small', { type: 'button', onclick: () => input.click() }, '3DLUT 파일 불러오기… (.cube, .3dl)');
  return [h('div.adj-row', h('span', ''), btn, input), h('div.adj-row', h('span', ''), label)];
}

// ---------------------------------------------------------------- Threshold

export function thresholdEditor(p, onChange, env) {
  ensureAdjStyle();
  const W = 256;
  const H = 90;
  const cv = h('canvas', { width: W, height: H, 'aria-label': '히스토그램' });
  const g = cv.getContext('2d');
  let H0 = null;
  const draw = () => {
    if (H0 === null) {
      try {
        H0 = env?.hist?.() || false;
      } catch {
        H0 = false;
      }
    }
    g.clearRect(0, 0, W, H);
    drawHist(g, W, H, H0 ? H0.l : null);
    g.fillStyle = '#ff5050';
    g.fillRect(Math.round((p.level / 255) * W), 0, 1, H);
  };
  const sl = slider('한계값 레벨', 1, 255, p.level, (v, done) => {
    p.level = v;
    draw();
    onChange(p, done);
  });
  // a click or drag on the histogram sets the level too
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const at = (ev, done) => {
      const r = cv.getBoundingClientRect();
      p.level = clamp(Math.round(((ev.clientX - r.left) / r.width) * 255), 1, 255);
      sl.set(p.level);
      draw();
      onChange(p, done);
    };
    at(e, false);
    const mv = (ev) => at(ev, false);
    const up = (ev) => {
      cv.removeEventListener('pointermove', mv);
      cv.removeEventListener('pointerup', up);
      at(ev, true);
    };
    cv.addEventListener('pointermove', mv);
    cv.addEventListener('pointerup', up);
  });
  draw();
  return [h('div.adj-graph', cv), sl.el];
}

export const CUSTOM_EDITORS = {
  levels: levelsEditor,
  curves: curvesEditor,
  hueSat: hueSatEditor,
  colorBalance: colorBalanceEditor,
  bw: bwEditor,
  photoFilter: photoFilterEditor,
  channelMixer: channelMixerEditor,
  gradientMap: gradientMapEditor,
  selectiveColor: selectiveColorEditor,
  lut: lutEditor,
  threshold: thresholdEditor,
};

/** Histograms of a canvas for the editors (cached per canvas). */
const histCache = new WeakMap();
export function histOf(c) {
  if (!c) return null;
  if (!histCache.has(c)) histCache.set(c, histograms(c));
  return histCache.get(c);
}

// Layer styles (Photoshop "레이어 스타일"): drop shadow, inner shadow, outer/inner glow, bevel & emboss,
// satin, colour/gradient/pattern overlay and stroke. Shapes come from the layer's alpha: distance
// transforms give strokes, spreads and bevel profiles; box blurs (3 passes ≈ Gaussian) give softness.
// The result is a list of passes drawn in order, each with its own blend mode, so a multiply shadow
// really multiplies with the layers below.

import { hexRgb, paintGradient, paintPattern, gradientLut } from './resources.js';

export const FX_KEYS = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'stroke'];

export const FX_NAMES = {
  bevel: '경사와 엠보스', stroke: '획', innerShadow: '내부 그림자', innerGlow: '내부 광선', satin: '새틴',
  colorOverlay: '색상 오버레이', gradientOverlay: '그레이디언트 오버레이', patternOverlay: '패턴 오버레이', outerGlow: '외부 광선', dropShadow: '드롭 섀도',
};

/** Defaults roughly matching Photoshop's. */
export const FX_DEFAULTS = {
  dropShadow: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5, knockout: true },
  innerShadow: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.75, angle: 120, distance: 5, choke: 0, size: 5 },
  outerGlow: { enabled: true, color: '#ffffbe', blend: 'screen', opacity: 0.75, spread: 0, size: 5 },
  innerGlow: { enabled: true, color: '#ffffbe', blend: 'screen', opacity: 0.75, source: 'edge', choke: 0, size: 5 },
  bevel: { enabled: true, style: 'inner bevel', technique: 'smooth', depth: 100, direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30, highlightColor: '#ffffff', highlightBlend: 'screen', highlightOpacity: 0.75, shadowColor: '#000000', shadowBlend: 'multiply', shadowOpacity: 0.75 },
  satin: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.5, angle: 19, distance: 11, size: 14, invert: true, contour: 'gaussian' },
  colorOverlay: { enabled: true, color: '#ff0000', blend: 'normal', opacity: 1 },
  gradientOverlay: { enabled: true, gradient: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }, blend: 'normal', opacity: 1, style: 'linear', angle: 90, scale: 100, reverse: false },
  patternOverlay: { enabled: true, pattern: 'checker', blend: 'normal', opacity: 1, scale: 100 },
  stroke: { enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, fillType: 'color', color: '#000000', gradient: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }, angle: 90 },
};

/** Effects that can be added more than once (Photoshop's "+" button): fx[k], fx[`${k}_2`], … top first. */
export const MULTI_FX = ['dropShadow', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'stroke'];

/** The effect type of an fx key ('stroke_2' → 'stroke'). */
export const baseKey = (key) => String(key).replace(/_\d+$/, '');

/** Keys of every instance of effect type k present in fx, top (drawn last) first. */
export function instanceKeys(fx, k) {
  if (!fx) return [];
  const out = [];
  for (const key of Object.keys(fx)) if (baseKey(key) === k && fx[key] && typeof fx[key] === 'object') out.push(key);
  const n = (key) => (key === k ? 1 : +key.slice(k.length + 1));
  return out.sort((a, b) => n(a) - n(b));
}

/** Write a list of instances of effect type k back into fx (renumbered: k, k_2, k_3 …). */
export function setInstances(fx, k, list) {
  for (const key of instanceKeys(fx, k)) delete fx[key];
  list.forEach((v, i) => { fx[i ? `${k}_${i + 1}` : k] = v; });
  return fx;
}

/**
 * Contours (윤곽선): how an effect's density runs from the edge outward (shadows, glows, satin) or how a
 * bevel's surface rises. [id, Korean name, curve 0..1 → 0..1].
 */
export const CONTOURS = [
  ['linear', '선형', (x) => x],
  ['cone', '원뿔', (x) => 1 - Math.abs(2 * x - 1)],
  ['coneInv', '원뿔 - 반전', (x) => Math.abs(2 * x - 1)],
  ['gaussian', '가우스', (x) => x * x * (3 - 2 * x)],
  ['halfRound', '반원', (x) => Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)))],
  ['ring', '고리', (x) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x)],
  ['ringDouble', '고리 - 이중', (x) => 0.5 - 0.5 * Math.cos(4 * Math.PI * x)],
  ['sawtooth', '톱니 모양', (x) => (x >= 1 ? 1 : (x * 3) % 1)],
  ['coveDeep', '만 - 깊게', (x) => x * x * x],
  ['coveShallow', '만 - 얕게', (x) => x * Math.sqrt(x)],
  ['rollingSlope', '구르는 경사 - 내림차순', (x) => Math.min(1, Math.max(0, 1 - x + 0.18 * Math.sin(4 * Math.PI * x)))],
  ['roundedSteps', '둥근 계단', (x) => { const n = 4; const f = Math.min(n - 1e-6, x * n); const i = Math.floor(f); const t = f - i; return Math.min(1, (i + t * t * (3 - 2 * t)) / (n - 1) * ((n - 1) / n) + (x >= 1 ? 1 / n : 0)); }],
  ['log', '로그', (x) => Math.log(1 + 9 * x) / Math.LN10],
];
const CONTOUR_FN = Object.fromEntries(CONTOURS.map(([id, , f]) => [id, f]));
/** A 256-entry lookup table for a contour (null for the linear one). */
const contourLuts = new Map();
export function contourLut(id) {
  if (!id || id === 'linear' || !CONTOUR_FN[id]) return null;
  if (!contourLuts.has(id)) {
    const f = CONTOUR_FN[id];
    const lut = new Float32Array(257);
    for (let i = 0; i <= 256; i++) lut[i] = Math.min(1, Math.max(0, f(i / 256)));
    contourLuts.set(id, lut);
  }
  return contourLuts.get(id);
}
/** Map an array of 0..1 values through a contour (in place). */
function applyContour(arr, id) {
  const lut = contourLut(id);
  if (!lut) return arr;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > 0) arr[i] = lut[Math.min(256, Math.round(v * 256))];
  }
  return arr;
}

// ---------------------------------------------------------------- defaults the user saved (기본값으로 만들기)

const USER_DEFAULTS_KEY = 'montage.photo.fxDefaults';
let userDefaults = null;
const loadUserDefaults = () => {
  if (userDefaults) return userDefaults;
  try {
    userDefaults = JSON.parse(localStorage.getItem(USER_DEFAULTS_KEY) || '{}') || {};
  } catch {
    userDefaults = {};
  }
  return userDefaults;
};
/** Settings for a new effect of type k: the user's saved defaults, else Photoshop's. */
export function fxDefaults(k) {
  const u = loadUserDefaults()[k];
  return structuredClone({ ...FX_DEFAULTS[k], ...(u || {}), enabled: true });
}
/** Remember settings as the defaults for effect type k (null: back to the factory settings). */
export function saveFxDefaults(k, v) {
  const all = loadUserDefaults();
  if (v) {
    const { enabled, ...rest } = v;
    void enabled;
    all[k] = structuredClone(rest);
  } else delete all[k];
  try {
    localStorage.setItem(USER_DEFAULTS_KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}
/** Photoshop's built-in settings for effect type k. */
export const factoryFx = (k) => structuredClone({ ...FX_DEFAULTS[k], enabled: true });

/** Bring older style data ({shadow, glow, stroke}) to the current shape. */
export function normalizeFx(fx) {
  if (!fx) return {};
  const out = { ...fx };
  if (fx.shadow && !fx.dropShadow) out.dropShadow = { ...FX_DEFAULTS.dropShadow, color: fx.shadow.color, opacity: fx.shadow.opacity, angle: fx.shadow.angle, distance: fx.shadow.distance, size: fx.shadow.blur };
  if (fx.glow && !fx.outerGlow) out.outerGlow = { ...FX_DEFAULTS.outerGlow, color: fx.glow.color, opacity: fx.glow.opacity, size: fx.glow.size };
  if (fx.stroke && fx.stroke.enabled === undefined) out.stroke = { ...FX_DEFAULTS.stroke, color: fx.stroke.color, size: fx.stroke.size };
  delete out.shadow;
  delete out.glow;
  return out;
}

export function hasFx(fx) {
  if (!fx || fx.disabled) return false;
  for (const key in fx) {
    const v = fx[key];
    if (v && typeof v === 'object' && v.enabled && FX_DEFAULTS[baseKey(key)]) return true;
  }
  return false;
}

/** Whether any effect follows the document's global light (전체 조명 사용). */
export function fxUsesGlobalLight(fx) {
  if (!fx) return false;
  if (fx.useGlobalLight) return true;
  for (const key in fx) if (fx[key]?.enabled && fx[key].useGlobalLight) return true;
  return false;
}

/** Whether an effect is laid out on the document (gradient not aligned with the layer, pattern not linked). */
export function fxDocAnchored(fx) {
  if (!hasFx(fx)) return false;
  for (const key in fx) {
    const e = fx[key];
    if (!e?.enabled) continue;
    const k = baseKey(key);
    if ((k === 'gradientOverlay' || (k === 'stroke' && e.fillType === 'gradient')) && e.align === false) return true;
    if ((k === 'patternOverlay' || (k === 'stroke' && e.fillType === 'pattern')) && e.link === false) return true;
    if (k === 'bevel' && e.textureOn && e.texLink === false) return true;
  }
  return false;
}

/** Layer ▸ Layer Style ▸ Scale Effects: sizes and distances times k. */
export function scaleFx(fx, k) {
  const out = structuredClone(fx || {});
  const SIZE = ['size', 'distance', 'soften'];
  for (const key of Object.keys(out)) {
    const e = out[key];
    if (!e || typeof e !== 'object' || !FX_DEFAULTS[baseKey(key)]) continue;
    for (const f of SIZE) if (typeof e[f] === 'number') e[f] = Math.max(f === 'size' && baseKey(key) === 'stroke' ? 1 : 0, Math.round(e[f] * k * 10) / 10);
    if (baseKey(key) === 'patternOverlay' && typeof e.scale === 'number') e.scale = Math.max(1, Math.min(1000, Math.round(e.scale * k)));
    if (baseKey(key) === 'bevel' && typeof e.texScale === 'number') e.texScale = Math.max(1, Math.min(1000, Math.round(e.texScale * k)));
  }
  return out;
}

/** How far effects reach outside the layer pixels. */
export function fxPad(fx) {
  if (!hasFx(fx)) return 0;
  let p = 0;
  for (const key of Object.keys(fx)) {
    const e = fx[key];
    if (!e?.enabled) continue;
    const k = baseKey(key);
    if (k === 'dropShadow') p = Math.max(p, (e.distance || 0) + (e.size || 0) * 1.5);
    if (k === 'outerGlow') p = Math.max(p, (e.size || 0) * 1.5);
    if (k === 'stroke' && e.position !== 'inside') p = Math.max(p, e.size || 0);
    if (k === 'bevel' && e.style !== 'inner bevel') p = Math.max(p, (e.size || 0) * 1.2);
  }
  return Math.ceil(p) + 3;
}

// ---------------------------------------------------------------- array helpers

/** Squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place on `f`. */
function edt(f, w, h) {
  const INF = 1e20;
  const n = Math.max(w, h);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(n);
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) g[q] = get(q);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => f[y * w + x], (y, val) => { f[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (x) => f[y * w + x], (x, val) => { f[y * w + x] = val; });
  return f;
}

/** Distance (px) from each pixel to the nearest pixel where inside() is true. */
export function distanceTo(a, w, h, inside) {
  const f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = inside(a[i]) ? 0 : 1e20;
  edt(f, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) out[i] = Math.sqrt(f[i]);
  return out;
}

/** Box blur (3 passes ≈ Gaussian with sigma ≈ r). */
export function blurArray(src, w, h, r) {
  if (r < 0.5) return src;
  const rad = Math.max(1, Math.round(r * 0.9));
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let x = -rad; x <= rad; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc / (2 * rad + 1);
        acc += a[o + Math.min(w - 1, x + rad + 1)] - a[o + Math.max(0, x - rad)];
      }
    }
    // vertical: every column at once, row by row (the same sums as one column at a time, read in
    // memory order, which is several times faster on big layers)
    const acc = new Float64Array(w);
    for (let y = -rad; y <= rad; y++) {
      const o = Math.min(h - 1, Math.max(0, y)) * w;
      for (let x = 0; x < w; x++) acc[x] += b[o + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      const add = Math.min(h - 1, y + rad + 1) * w;
      const sub = Math.max(0, y - rad) * w;
      for (let x = 0; x < w; x++) {
        a[o + x] = acc[x] / (2 * rad + 1);
        acc[x] += b[add + x] - b[sub + x];
      }
    }
  }
  b = null;
  return a;
}

function shift(src, w, h, dx, dy, fill = 0) {
  dx = Math.round(dx);
  dy = Math.round(dy);
  const out = new Float32Array(w * h).fill(fill);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < w) out[y * w + x] = src[sy * w + sx];
    }
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The box of the pixels that aren't transparent in an alpha array, or null. */
function alphaBounds(A, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (A[o + x] <= 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * A w×h canvas with a gradient laid out on `box` (Photoshop's gradient overlay / gradient stroke: angle,
 * scale and style measured on the layer's bounds or the document), continuing past the box.
 */
function gradientIn(w, h, box, gr, { angle = 90, scale = 100, style = 'linear', reverse = false, fg, bg, offset = null, dither = false } = {}) {
  const a = (angle * Math.PI) / 180;
  // offset: where the gradient was dragged to on the picture, in percent of the box (정렬 재설정 clears it)
  const cx = box.x + box.w / 2 + (box.w * (offset?.[0] || 0)) / 100;
  const cy = box.y + box.h / 2 + (box.h * (offset?.[1] || 0)) / 100;
  const k = scale / 100;
  if (style === 'linear' || style === 'reflected' || style === 'diamond' || style === 'angle') {
    const half = ((Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2) * k;
    const from = style === 'linear' ? { x: cx - Math.cos(a) * half, y: cy + Math.sin(a) * half } : { x: cx, y: cy };
    const to = { x: cx + Math.cos(a) * half, y: cy - Math.sin(a) * half };
    return paintGradient(w, h, gr, from, to, { style, reverse, fg, bg, dither });
  }
  const r = (Math.hypot(box.w, box.h) / 2) * k;
  return paintGradient(w, h, gr, { x: cx, y: cy }, { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }, { style, reverse, fg, bg, dither });
}

/** An RGBA canvas from a colour and an alpha array. */
function colourCanvas(w, h, color, alpha, opacity = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const [r, gg, b] = hexRgb(color);
  const d = img.data;
  for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
    const a = alpha[j] * opacity;
    if (a <= 0) continue;
    d[i] = r;
    d[i + 1] = gg;
    d[i + 2] = b;
    d[i + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * A glow's paint: its colour, or (the gradient choice) a gradient running from the layer's edge to the
 * glow's outer end, its stops' opacity included; 파형 (jitter) scatters where each pixel reads it.
 */
function glowCanvas(w, h, e, s, fg, bg) {
  if (e.fill !== 'gradient' || !e.gradient) return colourCanvas(w, h, e.color, s);
  const lut = gradientLut(e.gradient, { fg, bg });
  const jit = clamp01((e.jitter || 0) / 100);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let j = 0, i = 0; j < s.length; j++, i += 4) {
    const v = s[j];
    if (v <= 0) continue;
    const t = jit ? clamp01(1 - v + (Math.random() - 0.5) * jit) : 1 - v;
    const k = Math.round(t * 255) * 4;
    d[i] = lut[k];
    d[i + 1] = lut[k + 1];
    d[i + 2] = lut[k + 2];
    d[i + 3] = lut[k + 3] * Math.min(1, v * 8);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** An image (canvas) kept only where alpha says so. */
function maskedCanvas(img, alpha, opacity = 1) {
  const w = img.width;
  const h = img.height;
  const g = img.getContext('2d');
  const id = g.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0, j = 0; j < alpha.length; i += 4, j++) d[i + 3] = d[i + 3] * alpha[j] * opacity;
  g.putImageData(id, 0, 0);
  return img;
}

// ---------------------------------------------------------------- the effects

/**
 * Build the passes for a layer: `body` is the layer pixels with its mask applied (canvas already padded
 * by fxPad). Returns [{ canvas, blend, opacity, kind, interior? }] in drawing order: shadows and glows
 * behind the layer, the 'body' pass (the layer itself: it takes the layer's blend mode and fill
 * opacity), the effects painted inside the layer (interior: overlays, satin, inner glow and shadow),
 * then strokes and the bevel. Several instances of one effect: the first listed is drawn on top.
 * `globalAngle` / `globalAltitude`: the document's light for effects that use it (전체 조명 사용).
 * `docBox`: the document's rectangle in body coordinates (gradients with 레이어에 정렬 off span it);
 * `origin`: where the layer's own origin is in body coordinates (patterns linked with the layer start there).
 */
export function stylePasses(body, fx, { fg = '#000000', bg = '#ffffff', globalAngle = null, globalAltitude = null, docBox = null, origin = null } = {}) {
  const w = body.width;
  const h = body.height;
  const bd = body.getContext('2d').getImageData(0, 0, w, h).data;
  const A = new Float32Array(w * h);
  for (let i = 0; i < A.length; i++) A[i] = bd[i * 4 + 3] / 255;
  // Photoshop lays gradients out on the layer's bounds (레이어에 정렬) or on the document
  let layerBox = null;
  const getLayerBox = () => (layerBox ||= alphaBounds(A, w, h) || { x: 0, y: 0, w, h });
  const gradBox = (e) => (e.align === false && docBox ? docBox : getLayerBox());
  const gradient = (e, opts) => gradientIn(w, h, gradBox(e), e.gradient, { fg, bg, offset: e.offset, dither: !!e.dither, ...opts });
  // patterns start at the layer's origin (레이어에 연결) or the document's
  // plus where the pattern was dragged to on the picture (원점에 스냅 clears it)
  const patternAt = (e) => {
    const o = e.link === false && docBox ? [docBox.x, docBox.y] : origin ? [origin.x, origin.y] : [0, 0];
    return [o[0] + (e.phase?.[0] || 0), o[1] + (e.phase?.[1] || 0)];
  };
  const texture = (bv) => (bv.textureOn && (bv.texDepth ?? 100) ? textureHeights(w, h, bv, patternAt({ link: bv.texLink, phase: bv.texPhase })) : null);
  // enabled instances of an effect type, bottom (drawn first) to top
  const list = (k) => instanceKeys(fx, k).map((key) => fx[key]).filter((e) => e?.enabled).reverse();
  const global = (e) => (fx.useGlobalLight || e.useGlobalLight) && globalAngle != null;
  const ang = (e) => (((global(e) ? globalAngle : e.angle ?? 120) * Math.PI) / 180);
  let dOut = null;
  let dIn = null;
  const getOut = () => (dOut ||= distanceTo(A, w, h, (a) => a >= 0.5));
  const getIn = () => (dIn ||= distanceTo(A, w, h, (a) => a < 0.5));
  const passes = [];

  // ---- below the layer
  for (const ds of list('dropShadow')) {
    const spread = clamp01((ds.spread || 0) / 100);
    let base = A;
    if (spread > 0) {
      const o = getOut();
      const r = ds.size * spread;
      base = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) base[i] = Math.max(A[i], clamp01(r + 0.5 - o[i]));
    }
    let s = blurArray(base, w, h, (ds.size * (1 - spread)) / 2);
    if (s === base) s = Float32Array.from(base);
    applyContour(s, ds.contour);
    s = shift(s, w, h, -Math.cos(ang(ds)) * ds.distance, Math.sin(ang(ds)) * ds.distance);
    if (ds.noise) addNoise(s, ds.noise / 100);
    if (ds.knockout !== false) for (let i = 0; i < s.length; i++) s[i] *= 1 - A[i];
    passes.push({ canvas: colourCanvas(w, h, ds.color, s), blend: ds.blend, opacity: ds.opacity, kind: 'dropShadow' });
  }
  for (const og of list('outerGlow')) {
    const spread = clamp01((og.spread || 0) / 100);
    const o = getOut();
    const r = og.size * spread;
    const base = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) base[i] = Math.max(A[i], clamp01(r + 0.5 - o[i]));
    let s;
    if (og.technique === 'precise') {
      // 정확하게: the glow keeps the shape's corners, fading evenly over its size
      s = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) s[i] = Math.max(A[i], og.size > 0 ? clamp01(1 - Math.max(0, o[i] - r) / Math.max(0.5, og.size - r)) : 0);
    } else {
      s = blurArray(base, w, h, (og.size * (1 - spread)) / 2 || 0.5);
      // the glow fades out over its size
      s = s.map((v, i) => clamp01(v * 1.6) * (o[i] <= og.size + 1 ? 1 : 0));
    }
    if (og.contour && og.contour !== 'linear') {
      // the contour runs over the glow's range (범위): 0 at its outer end, 1 at the layer's edge
      const range = clamp01((og.range ?? 50) / 100) || 0.01;
      const lut = contourLut(og.contour);
      for (let i = 0; i < s.length; i++) {
        if (A[i] >= 0.999 || s[i] <= 0) continue;
        const t = clamp01(1 - (1 - s[i]) / (range * 2));
        s[i] = lut[Math.round(t * 256)] * (s[i] > 0 ? 1 : 0);
      }
    }
    if (og.noise) addNoise(s, og.noise / 100);
    passes.push({ canvas: glowCanvas(w, h, og, s, fg, bg), blend: og.blend, opacity: og.opacity, kind: 'outerGlow' });
  }

  // ---- the layer itself
  passes.push({ canvas: body, blend: null, opacity: 1, kind: 'body' });

  // ---- painted inside the layer (bottom to top: pattern, gradient, colour, satin, inner glow, inner shadow)
  for (const po of list('patternOverlay')) passes.push({ canvas: maskedCanvas(paintPattern(w, h, po.pattern, po.scale, ...patternAt(po), po.angle || 0), A), blend: po.blend, opacity: po.opacity, kind: 'patternOverlay', interior: true });
  for (const go of list('gradientOverlay')) passes.push({ canvas: maskedCanvas(gradient(go, { angle: go.angle ?? 90, scale: go.scale ?? 100, style: go.style || 'linear', reverse: !!go.reverse }), A), blend: go.blend, opacity: go.opacity, kind: 'gradientOverlay', interior: true });
  for (const co of list('colorOverlay')) passes.push({ canvas: colourCanvas(w, h, co.color, A), blend: co.blend, opacity: co.opacity, kind: 'colorOverlay', interior: true });
  for (const sa of list('satin')) {
    const a = ((sa.angle ?? 19) * Math.PI) / 180;
    const dx = Math.cos(a) * sa.distance;
    const dy = -Math.sin(a) * sa.distance;
    const s1 = blurArray(shift(A, w, h, dx, dy), w, h, sa.size / 2);
    const s2 = blurArray(shift(A, w, h, -dx, -dy), w, h, sa.size / 2);
    const lut = contourLut(sa.contour);
    const s = new Float32Array(A.length);
    for (let i = 0; i < s.length; i++) {
      let v = Math.abs(s1[i] - s2[i]);
      if (lut) v = lut[Math.round(clamp01(v) * 256)];
      s[i] = (sa.invert ? 1 - v : v) * A[i];
    }
    passes.push({ canvas: colourCanvas(w, h, sa.color, s), blend: sa.blend, opacity: sa.opacity, kind: 'satin', interior: true });
  }
  for (const igl of list('innerGlow')) {
    const choke = clamp01((igl.choke || 0) / 100);
    let edge;
    if (igl.technique === 'precise') {
      const di = getIn();
      const r = igl.size * choke;
      edge = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) edge[i] = igl.size > 0 ? clamp01(1 - Math.max(0, di[i] - r) / Math.max(0.5, igl.size - r)) / 1.6 : 0;
    } else {
      if (choke > 0) {
        const di = getIn();
        const r = igl.size * choke;
        edge = new Float32Array(A.length);
        for (let i = 0; i < A.length; i++) edge[i] = clamp01(r + 0.5 - di[i]);
      } else edge = A.map((v) => 1 - v);
      edge = blurArray(edge, w, h, (igl.size * (1 - choke)) / 2 || 0.5);
    }
    const lut = contourLut(igl.contour);
    const s = new Float32Array(A.length);
    for (let i = 0; i < s.length; i++) {
      let e = clamp01(edge[i] * 1.6);
      if (lut) e = lut[Math.round(e * 256)];
      s[i] = (igl.source === 'center' ? 1 - e : e) * A[i];
    }
    if (igl.noise) addNoise(s, igl.noise / 100);
    passes.push({ canvas: glowCanvas(w, h, igl, s, fg, bg), blend: igl.blend, opacity: igl.opacity, kind: 'innerGlow', interior: true });
  }
  for (const ish of list('innerShadow')) {
    const inv = A.map((v) => 1 - v);
    const choke = clamp01((ish.choke || 0) / 100);
    let base = inv;
    if (choke > 0) {
      const di = getIn();
      const r = ish.size * choke;
      base = inv.map((v, i) => Math.max(v, clamp01(r + 0.5 - di[i])));
    }
    let s = shift(base, w, h, -Math.cos(ang(ish)) * ish.distance, Math.sin(ang(ish)) * ish.distance, 1);
    s = blurArray(s, w, h, (ish.size * (1 - choke)) / 2);
    applyContour(s, ish.contour);
    if (ish.noise) addNoise(s, ish.noise / 100);
    for (let i = 0; i < s.length; i++) s[i] *= A[i];
    passes.push({ canvas: colourCanvas(w, h, ish.color, s), blend: ish.blend, opacity: ish.opacity, kind: 'innerShadow', interior: true });
  }

  // ---- above: strokes, then the bevel
  let strokeA = null;
  for (const st of list('stroke')) {
    if (!(st.size > 0)) continue;
    const s = new Float32Array(A.length);
    const size = st.size;
    const pos = st.position || 'outside';
    const out = pos !== 'inside' ? getOut() : null;
    const din = pos !== 'outside' ? getIn() : null;
    const ro = pos === 'center' ? size / 2 : size;
    const ri = pos === 'center' ? size / 2 : size;
    for (let i = 0; i < A.length; i++) {
      const dil = out ? clamp01(ro + 0.5 - out[i]) : A[i];
      const ero = din ? clamp01(din[i] - ri + 0.5) * (A[i] >= 0.5 ? 1 : 0) : A[i];
      s[i] = pos === 'outside' ? Math.max(0, dil - A[i]) : pos === 'inside' ? Math.max(0, A[i] - ero) : Math.max(0, dil - ero);
    }
    strokeA = s;
    let canvas;
    if (st.fillType === 'gradient') canvas = maskedCanvas(gradient(st, { angle: st.angle ?? 90, style: st.style || 'linear', scale: st.scale ?? 100, reverse: !!st.reverse }), s);
    else if (st.fillType === 'pattern') canvas = maskedCanvas(paintPattern(w, h, st.pattern || 'checker', st.scale ?? 100, ...patternAt(st), st.patAngle || 0), s);
    else canvas = colourCanvas(w, h, st.color, s);
    passes.push({ canvas, blend: st.blend, opacity: st.opacity, kind: 'stroke' });
  }
  for (const bv of list('bevel')) {
    if (!(bv.size > 0)) continue;
    const alt = global(bv) && globalAltitude != null ? globalAltitude : bv.altitude ?? 30;
    if (bv.style === 'stroke emboss') {
      // 획 엠보스: an inner bevel on the stroke's band (nothing without a stroke)
      if (!strokeA) continue;
      const U = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) U[i] = Math.max(A[i], strokeA[i]);
      let uIn = null;
      const getUIn = () => (uIn ||= distanceTo(U, w, h, (a) => a < 0.5));
      const ps = bevelPasses(U, w, h, { ...bv, style: 'inner bevel', altitude: alt }, getUIn, getOut, ang(bv), texture(bv));
      for (const p of ps) maskedCanvas(p.canvas, strokeA);
      passes.push(...ps);
      continue;
    }
    passes.push(...bevelPasses(A, w, h, { ...bv, altitude: alt }, getIn, getOut, ang(bv), texture(bv)));
  }
  return passes;
}

/**
 * 경사와 엠보스 ▸ 텍스처: the pattern's brightness as a height map (0..1, light = high; 반전 flips it),
 * laid out like a pattern overlay (레이어에 연결: moves with the layer).
 */
function textureHeights(w, h, bv, at) {
  const c = paintPattern(w, h, bv.texPattern || 'checker', bv.texScale ?? 100, ...at);
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const T = new Float32Array(w * h);
  for (let i = 0, j = 0; j < T.length; i += 4, j++) {
    const v = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255) * (d[i + 3] / 255);
    T[j] = bv.texInvert ? 1 - v : v;
  }
  return T;
}

/** Photoshop's noise slider: random dots knocked out of an effect (deterministic per pixel). */
function addNoise(s, amount) {
  if (!(amount > 0)) return;
  let seed = 12345;
  for (let i = 0; i < s.length; i++) {
    if (s[i] <= 0) continue;
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    const r = ((seed >>> 8) & 0xffff) / 65535;
    s[i] *= 1 - amount * r;
  }
}

function bevelPasses(A, w, h, bv, getIn, getOut, a, tex = null) {
  const size = bv.size;
  const style = bv.style || 'inner bevel';
  const Hm = new Float32Array(A.length);
  const din = style === 'outer bevel' ? null : getIn();
  const dout = style === 'inner bevel' ? null : getOut();
  // the surface profile; the 윤곽선 (contour) option reshapes it
  const shape = bv.contourOn && bv.profile && bv.profile !== 'linear' ? contourLut(bv.profile) : null;
  const prof = (t) => {
    t = clamp01(t);
    let v;
    if (bv.technique === 'chisel hard') v = t;
    else if (bv.technique === 'chisel soft') v = Math.sqrt(t);
    else v = 1 - (1 - t) * (1 - t);
    if (shape) v = shape[Math.round(clamp01(v) * 256)];
    return v;
  };
  for (let i = 0; i < A.length; i++) {
    const inside = A[i] >= 0.5;
    if (style === 'inner bevel') Hm[i] = inside ? prof(din[i] / size) : 0;
    else if (style === 'outer bevel') Hm[i] = inside ? 1 : 1 - prof(dout[i] / size);
    else if (style === 'emboss') Hm[i] = inside ? 0.5 + 0.5 * prof(din[i] / (size / 2)) : 0.5 - 0.5 * prof(dout[i] / (size / 2));
    else Hm[i] = inside ? prof(din[i] / (size / 2)) : prof(dout[i] / (size / 2)); // pillow: the edge sinks
  }
  const soft = blurArray(Hm, w, h, Math.max(0.6, (bv.soften || 0) / 2));
  const depth = ((bv.depth ?? 100) / 100) * size * (bv.direction === 'down' ? -1 : 1);
  const alt = ((bv.altitude ?? 30) * Math.PI) / 180;
  const L = [Math.cos(alt) * Math.cos(a), -Math.cos(alt) * Math.sin(a), Math.sin(alt)];
  const flat = L[2];
  const hi = new Float32Array(A.length);
  const sh = new Float32Array(A.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xl = soft[y * w + Math.max(0, x - 1)];
      const xr = soft[y * w + Math.min(w - 1, x + 1)];
      const yu = soft[Math.max(0, y - 1) * w + x];
      const yd = soft[Math.min(h - 1, y + 1) * w + x];
      let nx = -(xr - xl) * 0.5 * depth;
      let ny = -(yd - yu) * 0.5 * depth;
      if (tex) {
        // the texture bumps the surface inside the layer (깊이 ±1000%)
        const k = ((bv.texDepth ?? 100) / 100) * 2 * A[i];
        nx -= (tex[y * w + Math.min(w - 1, x + 1)] - tex[y * w + Math.max(0, x - 1)]) * 0.5 * k;
        ny -= (tex[Math.min(h - 1, y + 1) * w + x] - tex[Math.max(0, y - 1) * w + x]) * 0.5 * k;
      }
      const len = Math.hypot(nx, ny, 1);
      const shade = (nx * L[0] + ny * L[1] + L[2]) / len;
      // where the bevel is drawn
      let region;
      if (style === 'inner bevel') region = A[i];
      else if (style === 'outer bevel') region = (1 - A[i]) * (dout[i] <= size + 1 ? 1 : 0);
      else region = A[i] >= 0.5 ? 1 : dout[i] <= size / 2 + 1 ? 1 : 0;
      if (!region) continue;
      if (shade > flat) hi[i] = clamp01((shade - flat) / (1 - flat)) * region;
      else sh[i] = clamp01((flat - shade) / Math.max(0.05, flat)) * region;
    }
  }
  // 광택 윤곽선 (gloss contour): reshapes how light and shade fall off
  if (bv.gloss && bv.gloss !== 'linear') {
    applyContour(hi, bv.gloss);
    applyContour(sh, bv.gloss);
  }
  return [
    { canvas: colourCanvas(w, h, bv.shadowColor || '#000000', sh), blend: bv.shadowBlend || 'multiply', opacity: bv.shadowOpacity ?? 0.75, kind: 'bevelShadow' },
    { canvas: colourCanvas(w, h, bv.highlightColor || '#ffffff', hi), blend: bv.highlightBlend || 'screen', opacity: bv.highlightOpacity ?? 0.75, kind: 'bevelHighlight' },
  ];
}

// ---------------------------------------------------------------- presets (Styles panel)

export const STYLE_PRESETS = [
  { id: 'none', name: '스타일 없음', fx: {} },
  { id: 'shadow', name: '부드러운 그림자', fx: { dropShadow: { ...FX_DEFAULTS.dropShadow, opacity: 0.5, distance: 8, size: 16 } } },
  { id: 'outline', name: '흰 외곽선 + 그림자', fx: { stroke: { ...FX_DEFAULTS.stroke, color: '#ffffff', size: 6 }, dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 6, size: 10, opacity: 0.6 } } },
  { id: 'neon', name: '네온', fx: { outerGlow: { ...FX_DEFAULTS.outerGlow, color: '#00e5ff', size: 22, spread: 10, opacity: 0.9 }, innerGlow: { ...FX_DEFAULTS.innerGlow, color: '#ffffff', size: 6 }, colorOverlay: { ...FX_DEFAULTS.colorOverlay, color: '#7ff6ff' } } },
  { id: 'gold', name: '금속 (금)', fx: { gradientOverlay: { ...FX_DEFAULTS.gradientOverlay, gradient: { stops: [{ pos: 0, color: '#8a6e2f' }, { pos: 0.5, color: '#f5e6a8' }, { pos: 1, color: '#a17c2b' }] } }, bevel: { ...FX_DEFAULTS.bevel, size: 8, depth: 200 }, dropShadow: { ...FX_DEFAULTS.dropShadow, opacity: 0.5 } } },
  { id: 'emboss', name: '엠보스', fx: { bevel: { ...FX_DEFAULTS.bevel, style: 'emboss', size: 6 } } },
  { id: 'pillow', name: '쿠션 엠보스', fx: { bevel: { ...FX_DEFAULTS.bevel, style: 'pillow emboss', size: 8 } } },
  { id: 'inset', name: '움푹 들어간 글자', fx: { innerShadow: { ...FX_DEFAULTS.innerShadow, distance: 3, size: 4 }, dropShadow: { ...FX_DEFAULTS.dropShadow, color: '#ffffff', blend: 'screen', opacity: 0.6, distance: 1, size: 0 } } },
  { id: 'sticker', name: '스티커', fx: { stroke: { ...FX_DEFAULTS.stroke, color: '#ffffff', size: 10 }, dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 4, size: 8, opacity: 0.45 } } },
  { id: 'glass', name: '유리', fx: { bevel: { ...FX_DEFAULTS.bevel, size: 12, soften: 4, highlightOpacity: 0.9 }, innerGlow: { ...FX_DEFAULTS.innerGlow, color: '#ffffff', opacity: 0.5, size: 10 }, satin: { ...FX_DEFAULTS.satin, color: '#ffffff', blend: 'screen', opacity: 0.3 } } },
  { id: 'retro', name: '레트로 3D 그림자', fx: { stroke: { ...FX_DEFAULTS.stroke, color: '#1d1d1d', size: 3 }, dropShadow: { ...FX_DEFAULTS.dropShadow, color: '#ff4d6d', blend: 'normal', opacity: 1, distance: 8, size: 0, angle: 135 } } },
];

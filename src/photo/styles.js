// Layer styles (Photoshop "레이어 스타일"): drop shadow, inner shadow, outer/inner glow, bevel & emboss,
// satin, colour/gradient/pattern overlay and stroke. Shapes come from the layer's alpha: distance
// transforms give strokes, spreads and bevel profiles; box blurs (3 passes ≈ Gaussian) give softness.
// The result is a list of passes drawn in order, each with its own blend mode, so a multiply shadow
// really multiplies with the layers below.

import { hexRgb, boxGradient, paintPattern } from './resources.js';

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
  satin: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.5, angle: 19, distance: 11, size: 14, invert: true },
  colorOverlay: { enabled: true, color: '#ff0000', blend: 'normal', opacity: 1 },
  gradientOverlay: { enabled: true, gradient: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }, blend: 'normal', opacity: 1, style: 'linear', angle: 90, scale: 100, reverse: false },
  patternOverlay: { enabled: true, pattern: 'checker', blend: 'normal', opacity: 1, scale: 100 },
  stroke: { enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, fillType: 'color', color: '#000000', gradient: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }, angle: 90 },
};

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
  return FX_KEYS.some((k) => fx[k]?.enabled);
}

/** How far effects reach outside the layer pixels. */
export function fxPad(fx) {
  if (!hasFx(fx)) return 0;
  let p = 0;
  const on = (k) => fx[k]?.enabled && fx[k];
  if (on('dropShadow')) p = Math.max(p, fx.dropShadow.distance + fx.dropShadow.size * 1.5);
  if (on('outerGlow')) p = Math.max(p, fx.outerGlow.size * 1.5);
  if (on('stroke') && fx.stroke.position !== 'inside') p = Math.max(p, fx.stroke.size);
  if (on('bevel') && fx.bevel.style !== 'inner bevel') p = Math.max(p, fx.bevel.size * 1.2);
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
function distanceTo(a, w, h, inside) {
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
    // vertical
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -rad; y <= rad; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * rad + 1);
        acc += b[Math.min(h - 1, y + rad + 1) * w + x] - b[Math.max(0, y - rad) * w + x];
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
 * by fxPad), `fill` the fill opacity. Returns [{ canvas, blend, opacity, kind }] in drawing order;
 * kind 'body' marks the pass that takes the layer's own blend mode.
 */
export function stylePasses(body, fx, { fill = 1, fg = '#000000', bg = '#ffffff', globalAngle = null } = {}) {
  const w = body.width;
  const h = body.height;
  const bd = body.getContext('2d').getImageData(0, 0, w, h).data;
  const A = new Float32Array(w * h);
  for (let i = 0; i < A.length; i++) A[i] = bd[i * 4 + 3] / 255;
  const on = (k) => (fx[k]?.enabled ? fx[k] : null);
  const ang = (e) => (((globalAngle ?? e.angle ?? 120) * Math.PI) / 180);
  let dOut = null;
  let dIn = null;
  const getOut = () => (dOut ||= distanceTo(A, w, h, (a) => a >= 0.5));
  const getIn = () => (dIn ||= distanceTo(A, w, h, (a) => a < 0.5));
  const passes = [];

  // ---- below the layer
  const ds = on('dropShadow');
  if (ds) {
    const spread = clamp01((ds.spread || 0) / 100);
    let base = A;
    if (spread > 0) {
      const o = getOut();
      const r = ds.size * spread;
      base = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) base[i] = Math.max(A[i], clamp01(r + 0.5 - o[i]));
    }
    let s = blurArray(base, w, h, (ds.size * (1 - spread)) / 2);
    s = shift(s, w, h, -Math.cos(ang(ds)) * ds.distance, Math.sin(ang(ds)) * ds.distance);
    if (ds.knockout !== false) for (let i = 0; i < s.length; i++) s[i] *= 1 - A[i];
    passes.push({ canvas: colourCanvas(w, h, ds.color, s), blend: ds.blend, opacity: ds.opacity, kind: 'dropShadow' });
  }
  const og = on('outerGlow');
  if (og) {
    const spread = clamp01((og.spread || 0) / 100);
    const o = getOut();
    const r = og.size * spread;
    const base = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) base[i] = Math.max(A[i], clamp01(r + 0.5 - o[i]));
    let s = blurArray(base, w, h, (og.size * (1 - spread)) / 2 || 0.5);
    // the glow fades out over its size
    s = s.map((v, i) => clamp01(v * 1.6) * (o[i] <= og.size + 1 ? 1 : 0));
    passes.push({ canvas: colourCanvas(w, h, og.color, s), blend: og.blend, opacity: og.opacity, kind: 'outerGlow' });
  }

  // ---- the layer and what is painted inside it
  const inner = document.createElement('canvas');
  inner.width = w;
  inner.height = h;
  const ig = inner.getContext('2d');
  ig.globalAlpha = fill;
  ig.drawImage(body, 0, 0);
  ig.globalAlpha = 1;
  const interior = [];
  const po = on('patternOverlay');
  if (po) interior.push([maskedCanvas(paintPattern(w, h, po.pattern, po.scale), A), po.blend, po.opacity]);
  const go = on('gradientOverlay');
  if (go) interior.push([maskedCanvas(boxGradient(w, h, go.gradient, { angle: go.angle, scale: go.scale, style: go.style, reverse: go.reverse, fg, bg }), A), go.blend, go.opacity]);
  const co = on('colorOverlay');
  if (co) interior.push([colourCanvas(w, h, co.color, A), co.blend, co.opacity]);
  const sa = on('satin');
  if (sa) {
    const a = ang(sa);
    const dx = Math.cos(a) * sa.distance;
    const dy = -Math.sin(a) * sa.distance;
    const s1 = blurArray(shift(A, w, h, dx, dy), w, h, sa.size / 2);
    const s2 = blurArray(shift(A, w, h, -dx, -dy), w, h, sa.size / 2);
    const s = new Float32Array(A.length);
    for (let i = 0; i < s.length; i++) {
      const v = Math.abs(s1[i] - s2[i]);
      s[i] = (sa.invert ? 1 - v : v) * A[i];
    }
    interior.push([colourCanvas(w, h, sa.color, s), sa.blend, sa.opacity]);
  }
  const igl = on('innerGlow');
  if (igl) {
    const choke = clamp01((igl.choke || 0) / 100);
    let edge;
    if (choke > 0) {
      const di = getIn();
      const r = igl.size * choke;
      edge = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) edge[i] = clamp01(r + 0.5 - di[i]);
    } else edge = A.map((v) => 1 - v);
    edge = blurArray(edge, w, h, (igl.size * (1 - choke)) / 2 || 0.5);
    const s = new Float32Array(A.length);
    for (let i = 0; i < s.length; i++) {
      const e = clamp01(edge[i] * 1.6);
      s[i] = (igl.source === 'center' ? 1 - e : e) * A[i];
    }
    interior.push([colourCanvas(w, h, igl.color, s), igl.blend, igl.opacity]);
  }
  const ish = on('innerShadow');
  if (ish) {
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
    for (let i = 0; i < s.length; i++) s[i] *= A[i];
    interior.push([colourCanvas(w, h, ish.color, s), ish.blend, ish.opacity]);
  }
  passes.push({ canvas: inner, blend: null, opacity: 1, kind: 'body', interior });

  // ---- above: stroke, then bevel
  const st = on('stroke');
  if (st && st.size > 0) {
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
    const canvas = st.fillType === 'gradient'
      ? maskedCanvas(boxGradient(w, h, st.gradient, { angle: st.angle ?? 90, fg, bg }), s)
      : colourCanvas(w, h, st.color, s);
    passes.push({ canvas, blend: st.blend, opacity: st.opacity, kind: 'stroke' });
  }
  const bv = on('bevel');
  if (bv && bv.size > 0) passes.push(...bevelPasses(A, w, h, bv, getIn, getOut, ang(bv)));
  return passes;
}

function bevelPasses(A, w, h, bv, getIn, getOut, a) {
  const size = bv.size;
  const style = bv.style || 'inner bevel';
  const Hm = new Float32Array(A.length);
  const din = style === 'outer bevel' ? null : getIn();
  const dout = style === 'inner bevel' ? null : getOut();
  const prof = (t) => {
    t = clamp01(t);
    if (bv.technique === 'chisel hard') return t;
    if (bv.technique === 'chisel soft') return Math.sqrt(t);
    return 1 - (1 - t) * (1 - t);
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
      const nx = -(xr - xl) * 0.5 * depth;
      const ny = -(yd - yu) * 0.5 * depth;
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

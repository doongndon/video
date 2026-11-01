// Camera Raw ▸ 마스킹: local adjustments through masks, like Photoshop's Camera Raw masking panel.
//
// A mask is plain data kept in the filter's params (so smart filters, actions and .mphoto files keep
// it): { id, name, invert, hidden, amount, adj: {exposure, …}, comps: [component] }. Components are
// combined in order with op 'add' | 'sub' | 'int' (추가 / 빼기 / 교차):
//   subject / sky / background — a small mask computed once from the picture (run-length coded)
//   brush    — strokes in picture coordinates (0..1), each with size, feather, flow, density, erase, auto mask
//   linear   — x0, y0 (full effect) → x1, y1 (no effect)
//   radial   — cx, cy, rx, ry (in units of the long side), angle, feather
//   color    — sampled colours and 다듬기 (refine)
//   lum      — a brightness range lo..hi with smoothness
// Everything is in picture coordinates, so the same mask works on the small preview, a zoomed crop
// and the full-size layer.

import { clamp, smooth, mk } from './fxcore.js';
import { gaussF } from './fxutil.js';
import { colorRange } from './selectx.js';
import { guidedFilterGrey } from './selcut.js';

/** Local adjustment sliders: [key, label, min, max, step, gradient]. */
export const LOCAL_ADJ = [
  ['temp', '색온도', -100, 100, 1, 'linear-gradient(90deg,#3b6dd8,#e8c24a)'],
  ['tint', '색조', -100, 100, 1, 'linear-gradient(90deg,#46b04a,#c94fc0)'],
  ['exposure', '노출', -4, 4, 0.05],
  ['contrast', '대비', -100, 100, 1],
  ['highlights', '밝은 영역', -100, 100, 1],
  ['shadows', '어두운 영역', -100, 100, 1],
  ['whites', '흰색 계열', -100, 100, 1],
  ['blacks', '검정 계열', -100, 100, 1],
  ['texture', '텍스처', -100, 100, 1],
  ['clarity', '부분 대비', -100, 100, 1],
  ['dehaze', '디헤이즈', -100, 100, 1],
  ['hue', '색조', -180, 180, 1, 'linear-gradient(90deg,#0ff,#00f,#f0f,#f00,#ff0,#0f0,#0ff)'],
  ['saturation', '채도', -100, 100, 1, 'linear-gradient(90deg,#888,#e33)'],
  ['sharpness', '선명도', -100, 100, 1],
  ['noise', '노이즈', -100, 100, 1],
];
const ADJ_KEYS = LOCAL_ADJ.map((r) => r[0]);

/** Component types: [type, label, icon, shortcut]. */
export const COMP_TYPES = [
  ['subject', '피사체 선택', 'smile'],
  ['sky', '하늘 선택', 'image'],
  ['background', '배경 선택', 'selRect'],
  ['brush', '브러시', 'brush', 'K'],
  ['linear', '선형 그레이디언트', 'gradient', 'G'],
  ['radial', '방사형 그레이디언트', 'maskEllipse', 'J'],
  ['color', '색상 범위', 'eyedropper', 'Shift+J'],
  ['lum', '광도 범위', 'sliders'],
];
export const compLabel = (type) => COMP_TYPES.find((t) => t[0] === type)?.[1] || type;

let uid = 0;
export const newId = () => `m${Date.now().toString(36)}${(uid++).toString(36)}`;

/** A new, empty mask. */
export function newMask(name) {
  return { id: newId(), name, invert: false, hidden: false, amount: 100, adj: {}, comps: [] };
}

/** True when the mask changes anything. */
export function maskActive(m) {
  if (!m || m.hidden || !m.comps?.length || (m.amount ?? 100) === 0) return false;
  const a = m.adj || {};
  return ADJ_KEYS.some((k) => a[k]) || (a.colorS > 0);
}

// ---------------------------------------------------------------- AI masks (run-length coded)

const MASK_MAX = 512;

/** Alpha (0..1, sw × sh) → { w, h, rle } with the mask at most 512 px on the long side. */
export function encodeMask(alpha, sw, sh) {
  const s = Math.min(1, MASK_MAX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
  const v = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / s);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) / s)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / s);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) / s)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += alpha[yy * sw + xx];
      v[y * w + x] = Math.round((sum / ((y1 - y0) * (x1 - x0))) * 255);
    }
  }
  // runs of (count 1..255, value)
  const out = [];
  for (let i = 0; i < v.length;) {
    let j = i + 1;
    while (j < v.length && v[j] === v[i] && j - i < 255) j++;
    out.push(j - i, v[i]);
    i = j;
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return { w, h, rle: btoa(bin) };
}

const decoded = new Map();
/** The mask's values (Uint8Array w × h), cached by its code. */
function decodeMask(m) {
  let v = decoded.get(m.rle);
  if (v) return v;
  v = new Uint8Array(m.w * m.h);
  const bin = atob(m.rle);
  let o = 0;
  for (let i = 0; i + 1 < bin.length && o < v.length; i += 2) {
    const c = bin.charCodeAt(i);
    v.fill(bin.charCodeAt(i + 1), o, Math.min(v.length, o + c));
    o += c;
  }
  if (decoded.size > 12) decoded.delete(decoded.keys().next().value);
  decoded.set(m.rle, v);
  return v;
}

/** An alpha canvas (selection-like, alpha = amount) → Float32 alpha of the same size. */
export function canvasAlpha(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const a = new Float32Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

// ---------------------------------------------------------------- mask evaluation

/**
 * The geometry of an image that shows `region` (0..1 of the whole picture): full-picture size in this
 * image's pixels (FW × FH), the image's offset in it, and the long side L.
 */
function geom(w, h, region) {
  const rg = region || { x: 0, y: 0, w: 1, h: 1 };
  const FW = w / rg.w;
  const FH = h / rg.h;
  return { w, h, FW, FH, ox: rg.x * FW, oy: rg.y * FH, L: Math.max(FW, FH) };
}

function aiAlpha(c, g, ctx) {
  const m = c.m;
  const n = g.w * g.h;
  const out = new Float32Array(n);
  if (!m?.rle) return out;
  const v = decodeMask(m);
  const sx = m.w / g.FW;
  const sy = m.h / g.FH;
  for (let y = 0; y < g.h; y++) {
    const fy = clamp((g.oy + y + 0.5) * sy - 0.5, 0, m.h - 1);
    const y0 = fy | 0;
    const y1 = Math.min(m.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < g.w; x++) {
      const fx = clamp((g.ox + x + 0.5) * sx - 0.5, 0, m.w - 1);
      const x0 = fx | 0;
      const x1 = Math.min(m.w - 1, x0 + 1);
      const tx = fx - x0;
      const a = v[y0 * m.w + x0] + (v[y0 * m.w + x1] - v[y0 * m.w + x0]) * tx;
      const b = v[y1 * m.w + x0] + (v[y1 * m.w + x1] - v[y1 * m.w + x0]) * tx;
      out[y * g.w + x] = (a + (b - a) * ty) / 255;
    }
  }
  // the small mask's soft edge snaps to the picture's edges (guided by brightness)
  const up = g.FW / m.w;
  if (up > 1.5 && ctx.orig && n <= 16e6) {
    const r = Math.max(2, Math.round(up * 1.5));
    const f = guidedFilterGrey(ctx.orig, g.w, g.h, out, r, 1e-3);
    for (let i = 0; i < n; i++) out[i] = clamp(f[i], 0, 1);
  }
  return out;
}

function linearAlpha(c, g) {
  const out = new Float32Array(g.w * g.h);
  const x0 = c.x0 * g.FW;
  const y0 = c.y0 * g.FH;
  const dx = c.x1 * g.FW - x0;
  const dy = c.y1 * g.FH - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = 0; y < g.h; y++) {
    const Y = g.oy + y + 0.5 - y0;
    for (let x = 0; x < g.w; x++) {
      const t = ((g.ox + x + 0.5 - x0) * dx + Y * dy) / len2;
      out[y * g.w + x] = 1 - smooth(0, 1, t);
    }
  }
  return out;
}

function radialAlpha(c, g) {
  const out = new Float32Array(g.w * g.h);
  const cx = c.cx * g.FW;
  const cy = c.cy * g.FH;
  const rx = Math.max(0.5, c.rx * g.L);
  const ry = Math.max(0.5, c.ry * g.L);
  const ca = Math.cos(-(c.angle || 0));
  const sa = Math.sin(-(c.angle || 0));
  const inner = 1 - clamp((c.feather ?? 50) / 100, 0, 1);
  for (let y = 0; y < g.h; y++) {
    const Y = g.oy + y + 0.5 - cy;
    for (let x = 0; x < g.w; x++) {
      const X = g.ox + x + 0.5 - cx;
      const u = (X * ca - Y * sa) / rx;
      const v = (X * sa + Y * ca) / ry;
      const d = Math.sqrt(u * u + v * v);
      out[y * g.w + x] = d >= 1 ? 0 : d <= inner ? 1 : 1 - smooth(inner, 1, d);
    }
  }
  return out;
}

function brushAlpha(c, g, ctx) {
  const { w, h } = g;
  const M = new Float32Array(w * h);
  const orig = ctx.orig;
  for (const s of c.strokes || []) {
    const pts = s.pts || [];
    if (!pts.length) continue;
    const R = Math.max(0.5, s.r * g.L);
    const inner = 1 - clamp((s.feather ?? 50) / 100, 0, 1);
    // the stroke's box on this image
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const q of pts) {
      const X = q[0] * g.FW - g.ox;
      const Y = q[1] * g.FH - g.oy;
      bx0 = Math.min(bx0, X);
      by0 = Math.min(by0, Y);
      bx1 = Math.max(bx1, X);
      by1 = Math.max(by1, Y);
    }
    bx0 = Math.max(0, Math.floor(bx0 - R));
    by0 = Math.max(0, Math.floor(by0 - R));
    bx1 = Math.min(w, Math.ceil(bx1 + R) + 1);
    by1 = Math.min(h, Math.ceil(by1 + R) + 1);
    if (bx1 <= bx0 || by1 <= by0) continue;
    const bw = bx1 - bx0;
    const S = new Float32Array(bw * (by1 - by0));
    const stamp = (X, Y, col) => {
      const xa = Math.max(bx0, Math.floor(X - R));
      const xb = Math.min(bx1, Math.ceil(X + R) + 1);
      const ya = Math.max(by0, Math.floor(Y - R));
      const yb = Math.min(by1, Math.ceil(Y + R) + 1);
      for (let y = ya; y < yb; y++) {
        const dy = (y + 0.5 - Y) / R;
        for (let x = xa; x < xb; x++) {
          const dx = (x + 0.5 - X) / R;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 1) continue;
          let f = d <= inner ? 1 : 1 - smooth(inner, 1, d);
          if (col && orig) {
            // auto mask: only colours like the one under the brush's centre
            const o = (y * w + x) * 4;
            const dd = Math.hypot(orig[o] - col[0], orig[o + 1] - col[1], orig[o + 2] - col[2]);
            f *= 1 - smooth(16, 44, dd);
          }
          const j = (y - by0) * bw + (x - bx0);
          if (f > S[j]) S[j] = f;
        }
      }
    };
    const step = Math.max(0.7, R * 0.2);
    let prev = null;
    for (const q of pts) {
      const X = q[0] * g.FW - g.ox;
      const Y = q[1] * g.FH - g.oy;
      const col = s.auto && q.length >= 5 ? [q[2], q[3], q[4]] : null;
      if (prev) {
        const len = Math.hypot(X - prev[0], Y - prev[1]);
        const k = Math.floor(len / step);
        for (let i = 1; i <= k; i++) stamp(prev[0] + ((X - prev[0]) * i) / (k + 1), prev[1] + ((Y - prev[1]) * i) / (k + 1), col);
      }
      stamp(X, Y, col);
      prev = [X, Y];
    }
    const flow = clamp((s.flow ?? 100) / 100, 0, 1);
    const dens = clamp((s.density ?? 100) / 100, 0, 1);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const a = S[(y - by0) * bw + (x - bx0)] * flow;
        if (!a) continue;
        const i = y * w + x;
        if (s.erase) M[i] *= 1 - a;
        else if (M[i] < dens) M[i] += (dens - M[i]) * a;
      }
    }
  }
  return M;
}

function colorAlpha(c, g, ctx) {
  if (!ctx.orig || !c.samples?.length) return new Float32Array(g.w * g.h);
  const fuzz = 12 + clamp(c.refine ?? 50, 0, 100) * 1.6;
  return colorRange(ctx.orig, g.w, g.h, { select: 'sampled', samples: c.samples, fuzziness: fuzz });
}

function lumAlpha(c, g, ctx) {
  const n = g.w * g.h;
  const out = new Float32Array(n);
  if (!ctx.orig) return out;
  const lo = clamp(c.lo ?? 0, 0, 100);
  const hi = clamp(c.hi ?? 100, lo, 100);
  const sm = clamp(c.smooth ?? 30, 0, 100) * 0.5 + 0.5;
  const d = ctx.orig;
  for (let i = 0; i < n; i++) {
    const L = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 2.55;
    out[i] = (lo <= 0 ? 1 : smooth(lo - sm, lo, L)) * (hi >= 100 ? 1 : 1 - smooth(hi, hi + sm, L));
  }
  return out;
}

/** One component's alpha (before its invert). */
export function compAlpha(c, w, h, ctx) {
  const g = geom(w, h, ctx.region);
  switch (c.type) {
    case 'subject': case 'sky': case 'background': return aiAlpha(c, g, ctx);
    case 'brush': return brushAlpha(c, g, ctx);
    case 'linear': return linearAlpha(c, g);
    case 'radial': return radialAlpha(c, g);
    case 'color': return colorAlpha(c, g, ctx);
    case 'lum': return lumAlpha(c, g, ctx);
    default: return new Float32Array(w * h);
  }
}

/**
 * A mask's alpha (0..1) on a w × h image. ctx: { orig (the picture's own RGBA bytes, for colour,
 * brightness and auto mask), region }.
 */
export function maskAlpha(m, w, h, ctx) {
  const n = w * h;
  let M = null;
  for (const c of m.comps || []) {
    const C = compAlpha(c, w, h, ctx);
    if (c.invert) for (let i = 0; i < n; i++) C[i] = 1 - C[i];
    if (!M) {
      // the first component starts the mask (subtracting or intersecting from nothing gives nothing)
      M = c.op === 'sub' || c.op === 'int' ? new Float32Array(n) : C;
      continue;
    }
    if (c.op === 'sub') for (let i = 0; i < n; i++) M[i] *= 1 - C[i];
    else if (c.op === 'int') for (let i = 0; i < n; i++) M[i] *= C[i];
    else for (let i = 0; i < n; i++) if (C[i] > M[i]) M[i] = C[i];
  }
  if (!M) M = new Float32Array(n);
  if (m.invert) for (let i = 0; i < n; i++) M[i] = 1 - M[i];
  return M;
}

// ---------------------------------------------------------------- local adjustments

/** Hue rotation (degrees) keeping brightness, on rgb 0..1. */
function rotateHue(r, g, b, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // rotation around the grey axis (luminance-preserving matrix)
  const m00 = 0.213 + c * 0.787 - s * 0.213;
  const m01 = 0.715 - c * 0.715 - s * 0.715;
  const m02 = 0.072 - c * 0.072 + s * 0.928;
  const m10 = 0.213 - c * 0.213 + s * 0.143;
  const m11 = 0.715 + c * 0.285 + s * 0.14;
  const m12 = 0.072 - c * 0.072 - s * 0.283;
  const m20 = 0.213 - c * 0.213 - s * 0.787;
  const m21 = 0.715 - c * 0.715 + s * 0.715;
  const m22 = 0.072 + c * 0.928 + s * 0.072;
  return [r * m00 + g * m01 + b * m02, r * m10 + g * m11 + b * m12, r * m20 + g * m21 + b * m22];
}

/** The mask's adjustments scaled by its 양 (amount). */
function scaledAdj(m) {
  const k = (m.amount ?? 100) / 100;
  const a = m.adj || {};
  const o = {};
  for (const key of ADJ_KEYS) o[key] = (a[key] || 0) * (key === 'hue' ? Math.min(1, k) : k);
  o.colorH = a.colorH || 0;
  o.colorS = Math.min(100, (a.colorS || 0) * k);
  return o;
}

/**
 * Apply every active mask's adjustments to `img` (after the global settings). ctx: { orig, k, region,
 * bw (the picture is black & white), raw } where raw(img, params, k, region) is the Camera Raw processing used for the tone sliders.
 */
export function applyMasks(img, masks, ctx) {
  const { width: w, height: h, data: d } = img;
  const g = geom(w, h, ctx.region);
  for (const m of masks) {
    if (!maskActive(m)) continue;
    const M = maskAlpha(m, w, h, ctx);
    // only the masked part (plus room for the neighbourhood filters) is processed
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (M[y * w + x] > 0.002) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) continue;
    const pad = Math.ceil(g.L / 16);
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w, x1 + pad + 1);
    y1 = Math.min(h, y1 + pad + 1);
    const cw = x1 - x0;
    const ch = y1 - y0;
    const part = new ImageData(cw, ch);
    const pd = part.data;
    for (let y = 0; y < ch; y++) pd.set(d.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1) * 4), y * cw * 4);
    const a = scaledAdj(m);
    const lp = {
      _local: true, temp: a.temp, tint: a.tint, exposure: a.exposure, contrast: a.contrast, highlights: a.highlights, shadows: a.shadows,
      whites: a.whites, blacks: a.blacks, texture: a.texture, clarity: a.clarity, dehaze: a.dehaze, saturation: a.saturation,
      sharpAmount: Math.max(0, a.sharpness) + Math.max(0, -a.noise) * 0.5, sharpRadius: 1, sharpDetail: 25,
      nrLum: Math.max(0, a.noise), nrDetail: 50,
    };
    const rg = ctx.region || { x: 0, y: 0, w: 1, h: 1 };
    const sub = { x: rg.x + (x0 / w) * rg.w, y: rg.y + (y0 / h) * rg.h, w: (cw / w) * rg.w, h: (ch / h) * rg.h };
    ctx.raw(part, lp, ctx.k, sub);
    // negative 선명도 softens
    if (a.sharpness < 0) {
      const amt = Math.min(1, -a.sharpness / 100);
      const sg = Math.max(0.6, g.L / 400);
      for (let c = 0; c < 3; c++) {
        const ch1 = new Float32Array(cw * ch);
        for (let i = 0; i < ch1.length; i++) ch1[i] = pd[i * 4 + c];
        const bl = gaussF(ch1, cw, ch, sg);
        for (let i = 0; i < ch1.length; i++) pd[i * 4 + c] = ch1[i] + (bl[i] - ch1[i]) * amt;
      }
    }
    const hueOn = !!a.hue;
    const colOn = a.colorS > 0;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    if (colOn) {
      const t = mk(1, 1).getContext('2d');
      t.fillStyle = `hsl(${a.colorH},100%,50%)`;
      t.fillRect(0, 0, 1, 1);
      const px = t.getImageData(0, 0, 1, 1).data;
      [cr, cg, cb] = [px[0] / 255, px[1] / 255, px[2] / 255];
    }
    const cy0 = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb || 1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y + y0) * w + x + x0;
        const al = M[i];
        if (al <= 0.002) continue;
        const o = i * 4;
        const q = (y * cw + x) * 4;
        let r = pd[q] / 255;
        let gg = pd[q + 1] / 255;
        let b = pd[q + 2] / 255;
        if (hueOn) [r, gg, b] = rotateHue(r, gg, b, a.hue);
        if (ctx.bw) r = gg = b = 0.2126 * r + 0.7152 * gg + 0.0722 * b; // a black & white picture stays grey
        if (colOn) {
          // 색상: a colour wash that keeps each pixel's brightness
          const yy = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          const s = (a.colorS / 100) * 0.7;
          const k2 = yy / cy0;
          r += (cr * k2 - r) * s;
          gg += (cg * k2 - gg) * s;
          b += (cb * k2 - b) * s;
        }
        d[o] = d[o] + (r * 255 - d[o]) * al;
        d[o + 1] = d[o + 1] + (gg * 255 - d[o + 1]) * al;
        d[o + 2] = d[o + 2] + (b * 255 - d[o + 2]) * al;
      }
    }
  }
}

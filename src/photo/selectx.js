// Selection algorithms beyond the basics: colour range, grow / similar, border / smooth, precise
// expand / contract, the quick selection brush, object selection / select subject / sky, the
// magnetic lasso's live wire, and Select and Mask's edge refinement.
//
// None of this is machine learning: object selection, subject and sky are colour-model heuristics
// (an iterated, GrabCut-like colour clustering with neighbour smoothing), so they work on clear
// subjects against plain backgrounds and miss on busy photos.
//
// Selections here are alpha arrays (Float32Array, 0..1) or doc-size canvases whose alpha is the
// selection amount.

import { makeCanvas } from './doc.js';
import { blurArray, distanceTo } from './styles.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- canvas ↔ arrays

/** RGBA bytes of a canvas region (out-of-canvas parts are transparent). */
export function pixelsOf(c, x = 0, y = 0, w = c.width, h = c.height) {
  if (x === 0 && y === 0 && w === c.width && h === c.height) return c.getContext('2d').getImageData(0, 0, w, h).data;
  const t = makeCanvas(w, h);
  t.getContext('2d').drawImage(c, -x, -y);
  return t.getContext('2d').getImageData(0, 0, w, h).data;
}

/** Alpha (0..1) of a canvas region. */
export function alphaOf(c, x = 0, y = 0, w = c.width, h = c.height) {
  const d = pixelsOf(c, x, y, w, h);
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

/** A canvas whose alpha is `a` (black pixels, like every selection canvas). */
export function alphaCanvas(a, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < a.length; i++) d[i * 4 + 3] = Math.round(clamp01(a[i]) * 255);
  g.putImageData(img, 0, 0);
  return c;
}

/** Paste a region alpha back into a doc-size alpha canvas copy. */
export function placeAlpha(base, a, x, y, w, h) {
  const c = makeCanvas(base.width, base.height);
  const g = c.getContext('2d');
  g.drawImage(base, 0, 0);
  g.clearRect(x, y, w, h);
  g.drawImage(alphaCanvas(a, w, h), x, y);
  return c;
}

/**
 * Mix `src`'s alpha into a mask-like canvas: new = old·(1−a) + value·a, where a = src alpha × alpha.
 * value 1 adds (white paint on a mask), 0 removes (black), anything between paints grey.
 */
export function mixIntoMask(g, src, value, alpha = 1, ox = 0, oy = 0) {
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(src, ox, oy);
  if (value > 0) {
    g.globalAlpha = alpha * value;
    g.globalCompositeOperation = 'lighter';
    g.drawImage(src, ox, oy);
  }
  g.restore();
}

/** Bounding box of alpha > th in an array. */
export function boundsOf(a, w, h, th = 0) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (a[o + x] > th) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- colour helpers

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
/** CIE L*a*b* (D65) of an sRGB colour. */
export function labOf(r, g, b) {
  const R = LIN[r | 0];
  const G = LIN[g | 0];
  const B = LIN[b | 0];
  const x = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
// Lab for every colour at 6 bits per channel (enough for fuzzy matching)
let LAB_LUT = null;
function labLut() {
  if (LAB_LUT) return LAB_LUT;
  LAB_LUT = new Float32Array(64 * 64 * 64 * 3);
  for (let r = 0; r < 64; r++) {
    for (let g = 0; g < 64; g++) {
      for (let b = 0; b < 64; b++) {
        const [L, A, B] = labOf(r * 4.05, g * 4.05, b * 4.05);
        const o = ((r * 64 + g) * 64 + b) * 3;
        LAB_LUT[o] = L;
        LAB_LUT[o + 1] = A;
        LAB_LUT[o + 2] = B;
      }
    }
  }
  return LAB_LUT;
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Hue (0..360), saturation and value (0..1). */
function hsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let hh = 0;
  if (d > 0) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return [hh, mx ? d / mx : 0, mx / 255];
}

/** Sobel gradient magnitude of the luminance, scaled to about 0..1. */
export function gradientOf(px, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) * (px[i * 4 + 3] / 255);
  const G = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const a = L[ym * w + xm];
      const b = L[ym * w + x];
      const c = L[ym * w + xp];
      const d = L[y * w + xm];
      const f = L[y * w + xp];
      const g2 = L[yp * w + xm];
      const hh = L[yp * w + x];
      const k = L[yp * w + xp];
      const gx = c + 2 * f + k - a - 2 * d - g2;
      const gy = g2 + 2 * hh + k - a - 2 * b - c;
      G[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 1020);
    }
  }
  return G;
}

// ---------------------------------------------------------------- colour range

export const COLOR_RANGE_PRESETS = [
  ['sampled', '샘플 색상'], ['reds', '빨강 계열'], ['yellows', '노랑 계열'], ['greens', '초록 계열'], ['cyans', '녹청 계열'],
  ['blues', '파랑 계열'], ['magentas', '마젠타 계열'], ['highlights', '밝은 영역'], ['midtones', '중간 영역'], ['shadows', '어두운 영역'], ['skin', '피부 톤'],
];
const HUE_OF = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

/**
 * Colour range: how much each pixel belongs to the chosen colours (0..1).
 * o: {select, samples: [[r,g,b]], subtract: [[r,g,b]], fuzziness 0..200, localized, points: [[x,y]],
 *     range 0..100 (%), tones: {low, high} for highlights/shadows/midtones, invert}
 */
export function colorRange(px, w, h, o = {}) {
  const n = w * h;
  const out = new Float32Array(n);
  const sel = o.select || 'sampled';
  const fuzz = Math.max(1, o.fuzziness ?? 40);
  if (sel === 'sampled') {
    const adds = (o.samples || []).map((c) => labOf(...c));
    const subs = (o.subtract || []).map((c) => labOf(...c));
    if (!adds.length) return out;
    const lut = labLut();
    // fully selected within ~fuzz/5 ΔE, nothing beyond fuzz/2 ΔE
    const far = fuzz * 0.5;
    const near = fuzz * 0.2;
    const score = (L, A, B, list) => {
      let m = 0;
      for (const c of list) {
        const d = Math.sqrt((L - c[0]) ** 2 + (A - c[1]) ** 2 + (B - c[2]) ** 2);
        const v = d <= near ? 1 : d >= far ? 0 : (far - d) / (far - near);
        if (v > m) m = v;
      }
      return m;
    };
    const pts = o.localized && o.points?.length ? o.points : null;
    const R = Math.max(1, ((o.range ?? 100) / 100) * Math.hypot(w, h) * 0.5);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const li = (((px[p] >> 2) * 64 + (px[p + 1] >> 2)) * 64 + (px[p + 2] >> 2)) * 3;
      const L = lut[li];
      const A = lut[li + 1];
      const B = lut[li + 2];
      let v = score(L, A, B, adds);
      if (v > 0 && subs.length) v *= 1 - score(L, A, B, subs);
      if (v > 0 && pts) {
        const x = i % w;
        const y = (i / w) | 0;
        let dm = Infinity;
        for (const [qx, qy] of pts) dm = Math.min(dm, Math.hypot(x - qx, y - qy));
        v *= clamp01(1 - dm / R);
      }
      out[i] = v * (px[p + 3] / 255);
    }
  } else if (HUE_OF[sel] !== undefined) {
    const c = HUE_OF[sel];
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const [hh, s, v] = hsv(px[p], px[p + 1], px[p + 2]);
      let dh = Math.abs(hh - c);
      if (dh > 180) dh = 360 - dh;
      out[i] = clamp01(1 - (dh - 15) / 30) * clamp01((s - 0.08) / 0.17) * clamp01((v - 0.06) / 0.1) * (px[p + 3] / 255);
    }
  } else if (sel === 'highlights' || sel === 'shadows' || sel === 'midtones') {
    const t = o.tones || { highlights: { low: 190, high: 255 }, shadows: { low: 0, high: 65 }, midtones: { low: 105, high: 150 } }[sel];
    const soft = Math.max(1, ((o.toneFuzz ?? 20) / 100) * 128);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const L = luma(px[p], px[p + 1], px[p + 2]);
      const v = L < t.low ? 1 - (t.low - L) / soft : L > t.high ? 1 - (L - t.high) / soft : 1;
      out[i] = clamp01(v) * (px[p + 3] / 255);
    }
  } else if (sel === 'skin') {
    // the classic YCbCr skin box (Chai & Ngan 1999) with soft edges
    const box = (v, lo, hi, s = 6) => clamp01(Math.min(v - lo + s, hi - v + s) / s);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const r = px[p];
      const g = px[p + 1];
      const b = px[p + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      out[i] = box(cb, 77, 127) * box(cr, 133, 173) * clamp01((luma(r, g, b) - 40) / 30) * (px[p + 3] / 255);
    }
  }
  if (o.invert) for (let i = 0; i < n; i++) out[i] = 1 - out[i];
  return out;
}

// ---------------------------------------------------------------- grow / similar

const QBITS = 5; // 32 levels per channel
const qbin = (px, i) => (((px[i * 4] >> 3) << 10) | ((px[i * 4 + 1] >> 3) << 5) | (px[i * 4 + 2] >> 3));

/** 3-D max filter on a 32³ colour cube (marks colours within k bins of a marked one). */
function dilateCube(bins, k) {
  if (k <= 0) return bins;
  const N = 1 << QBITS;
  let a = bins;
  for (let axis = 0; axis < 3; axis++) {
    const b = new Uint8Array(a.length);
    const stride = axis === 0 ? 1 : axis === 1 ? N : N * N;
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      const c = axis === 0 ? i & (N - 1) : axis === 1 ? (i >> QBITS) & (N - 1) : i >> (2 * QBITS);
      for (let d = Math.max(0, c - k); d <= Math.min(N - 1, c + k); d++) b[i + (d - c) * stride] = 1;
    }
    a = b;
  }
  return a;
}

/**
 * Grow (contiguous) or Similar (anywhere): add pixels whose colour is within `tolerance` of a colour
 * already selected. Returns the new alpha, or null when nothing is selected.
 */
export function similarSelect(px, w, h, selA, tolerance = 32, contiguous = true) {
  const n = w * h;
  let bins = new Uint8Array(1 << (3 * QBITS));
  let any = false;
  for (let i = 0; i < n; i++) {
    if (selA[i] >= 0.5) {
      bins[qbin(px, i)] = 1;
      any = true;
    }
  }
  if (!any) return null;
  bins = dilateCube(bins, Math.ceil(tolerance / 8));
  const out = Float32Array.from(selA);
  if (!contiguous) {
    for (let i = 0; i < n; i++) if (bins[qbin(px, i)] && px[i * 4 + 3] > 0) out[i] = 1;
    return out;
  }
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) {
    if (selA[i] >= 0.5) {
      seen[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    const visit = (j) => {
      if (seen[j]) return;
      seen[j] = 1;
      if (!bins[qbin(px, j)]) return;
      out[j] = 1;
      stack[sp++] = j;
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  return out;
}

// ---------------------------------------------------------------- modify

/** Expand (n > 0) or contract (n < 0) by n pixels, round corners, antialiased. */
export function expandAlpha(a, w, h, n) {
  const out = new Float32Array(a.length);
  if (n > 0) {
    const d = distanceTo(a, w, h, (v) => v >= 0.5);
    for (let i = 0; i < a.length; i++) out[i] = Math.max(a[i], clamp01(n + 0.5 - d[i]));
  } else {
    const m = -n;
    const d = distanceTo(a, w, h, (v) => v < 0.5);
    for (let i = 0; i < a.length; i++) out[i] = Math.min(a[i], clamp01(d[i] - m + 0.5));
  }
  return out;
}

/** Border: a soft band `width` px wide straddling the selection edge. */
export function borderAlpha(a, w, h, width) {
  const dIn = distanceTo(a, w, h, (v) => v < 0.5);
  const dOut = distanceTo(a, w, h, (v) => v >= 0.5);
  const half = width / 2;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const d = a[i] >= 0.5 ? dIn[i] - 0.5 : dOut[i] - 0.5;
    out[i] = clamp01(half + 0.5 - d);
  }
  return blurArray(out, w, h, 1);
}

/** Smooth: majority vote in a radius (rounds corners, drops specks and fills pinholes). */
export function smoothAlpha(a, w, h, radius) {
  const b = blurArray(a, w, h, radius);
  const k = 2.5;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = clamp01((b[i] - 0.5) * k + 0.5);
  return out;
}

/** Sliding max (or min) over ±r along every row and then every column (square window, O(n)). */
export function rankFilter(src, w, h, r, max = true) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const dq = new Int32Array(Math.max(w, h));
  const line = (s, d, off, stride, len) => {
    let head = 0;
    let tail = 0;
    for (let j = 0; j < len + r; j++) {
      if (j < len) {
        const v = s[off + j * stride];
        while (tail > head && (max ? s[off + dq[tail - 1] * stride] <= v : s[off + dq[tail - 1] * stride] >= v)) tail--;
        dq[tail++] = j;
      }
      const c = j - r;
      if (c >= 0) {
        while (dq[head] < c - r) head++;
        d[off + c * stride] = s[off + dq[head] * stride];
      }
    }
  };
  for (let y = 0; y < h; y++) line(src, tmp, y * w, 1, w);
  for (let x = 0; x < w; x++) line(tmp, out, x, w, h);
  return out;
}

// ---------------------------------------------------------------- quick selection brush

/**
 * The quick selection brush: each dab learns the colours under the brush and floods out from it
 * (up to three brush radii) through pixels of those colours, stopping at strong edges.
 */
export class QuickSelector {
  constructor(px, w, h) {
    this.px = px;
    this.w = w;
    this.h = h;
    this.mask = new Uint8Array(w * h);
    this.bins = new Uint8Array(1 << (3 * QBITS));
    this.core = new Uint8Array(1 << (3 * QBITS));
    this.grad = null;
  }

  learn(bin) {
    if (this.core[bin]) return;
    this.core[bin] = 1;
    const N = 1 << QBITS;
    const r = bin >> (2 * QBITS);
    const g = (bin >> QBITS) & (N - 1);
    const b = bin & (N - 1);
    const k = 2;
    for (let i = Math.max(0, r - k); i <= Math.min(N - 1, r + k); i++) {
      for (let j = Math.max(0, g - k); j <= Math.min(N - 1, g + k); j++) {
        for (let l = Math.max(0, b - k); l <= Math.min(N - 1, b + k); l++) this.bins[(i << (2 * QBITS)) | (j << QBITS) | l] = 1;
      }
    }
  }

  /** One dab at (cx, cy) with radius r. Returns the changed box. */
  dab(cx, cy, r) {
    const { w, h, px, mask } = this;
    if (!this.grad) this.grad = gradientOf(px, w, h);
    const G = this.grad;
    r = Math.max(1, r);
    const R = r * 3;
    const x0 = Math.max(0, Math.floor(cx - R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(w - 1, Math.ceil(cx + R));
    const y1 = Math.min(h - 1, Math.ceil(cy + R));
    if (x0 > x1 || y0 > y1) return null;
    // learn the colours near the brush centre; the edge threshold follows the texture under it
    const gs = [];
    const queue = [];
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const i = y * w + x;
        if (d <= r * 0.6) this.learn(qbin(px, i));
        gs.push(G[i]);
        queue.push(i);
      }
    }
    if (!queue.length) return null;
    gs.sort((a, b) => a - b);
    const edgeT = Math.max(0.05, gs[gs.length >> 1] * 3 + 0.02);
    const seen = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
    const li = (i) => ((((i / w) | 0) - y0) * (x1 - x0 + 1)) + (i % w) - x0;
    for (const i of queue) {
      seen[li(i)] = 1;
      mask[i] = 1;
    }
    let head = 0;
    const R2 = R * R;
    while (head < queue.length) {
      const i = queue[head++];
      if (G[i] > edgeT) continue; // edges are taken but not crossed
      const x = i % w;
      const y = (i / w) | 0;
      const visit = (j, jx, jy) => {
        if (jx < x0 || jx > x1 || jy < y0 || jy > y1) return;
        const l = li(j);
        if (seen[l]) return;
        seen[l] = 1;
        if ((jx - cx) ** 2 + (jy - cy) ** 2 > R2) return;
        if (!this.bins[qbin(px, j)]) return;
        mask[j] = 1;
        queue.push(j);
      };
      visit(i - 1, x - 1, y);
      visit(i + 1, x + 1, y);
      visit(i - w, x, y - 1);
      visit(i + w, x, y + 1);
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** The stroke so far as a doc-size alpha canvas (optionally with smoothed edges). */
  canvas(enhance = false) {
    const { w, h } = this;
    let a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = this.mask[i];
    if (enhance) a = smoothAlpha(a, w, h, 1.5);
    return alphaCanvas(a, w, h);
  }
}

// ---------------------------------------------------------------- object selection / subject / sky

/** k-means colour clusters of the pixels `idx`: {cs: centres, pi: weights, v: mean squared spread}. */
function kmeans(px, idx, K, iters = 5) {
  const m = idx.length;
  if (!m) return null;
  let cs = [];
  for (let k = 0; k < K; k++) {
    const i = idx[Math.floor(((k + 0.5) / K) * m)];
    cs.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
  }
  const step = Math.max(1, Math.floor(m / 6000));
  let acc = null;
  let sq = 0;
  let total = 0;
  for (let it = 0; it < iters; it++) {
    acc = cs.map(() => [0, 0, 0, 0]);
    sq = 0;
    total = 0;
    for (let s = 0; s < m; s += step) {
      const i = idx[s] * 4;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < cs.length; k++) {
        const d = (px[i] - cs[k][0]) ** 2 + (px[i + 1] - cs[k][1]) ** 2 + (px[i + 2] - cs[k][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      const a = acc[best];
      a[0] += px[i];
      a[1] += px[i + 1];
      a[2] += px[i + 2];
      a[3]++;
      sq += bd;
      total++;
    }
    cs = cs.map((c, k) => (acc[k][3] ? [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]] : c));
  }
  const keep = cs.map((_, k) => acc[k][3] > 0);
  return {
    cs: cs.filter((_, k) => keep[k]),
    pi: acc.filter((a) => a[3] > 0).map((a) => a[3] / total),
    v: Math.max(30, sq / Math.max(1, total) / 3),
  };
}

/** −log likelihood of a pixel under a colour model (a mixture of round Gaussians). */
function cost(px, i, M) {
  // −log Σ πk·N(x; ck, v) via log-sum-exp
  let mx = -Infinity;
  const t = M._t || (M._t = new Float64Array(M.cs.length));
  for (let k = 0; k < M.cs.length; k++) {
    const c = M.cs[k];
    const d = (px[i * 4] - c[0]) ** 2 + (px[i * 4 + 1] - c[1]) ** 2 + (px[i * 4 + 2] - c[2]) ** 2;
    t[k] = Math.log(M.pi[k]) - d / (2 * M.v);
    if (t[k] > mx) mx = t[k];
  }
  let sum = 0;
  for (let k = 0; k < M.cs.length; k++) sum += Math.exp(t[k] - mx);
  return -(mx + Math.log(sum)) + 1.5 * Math.log(M.v);
}

/**
 * Two-colour-model segmentation on a small image: `fixed` pixels are background for sure, `label`
 * holds the starting guess (1 = object). Alternates fitting a colour mixture to each side and
 * relabelling every pixel by the more likely model, with the likelihoods smoothed over neighbours
 * (a cheap stand-in for GrabCut's graph cut). Returns the labels.
 */
function segment(px, w, h, label, fixed, rounds = 6, prior = null) {
  const n = w * h;
  const q = new Float32Array(n);
  // start from what the background colours explain badly (falls back to the caller's guess)
  const bgIdx = [];
  for (let i = 0; i < n; i++) if (!label[i]) bgIdx.push(i);
  const B0 = kmeans(px, bgIdx, 10);
  if (B0) {
    const cb = new Float32Array(n);
    for (let i = 0; i < n; i++) cb[i] = cost(px, i, B0);
    const ref = Float32Array.from(bgIdx, (i) => cb[i]).sort();
    const th = ref[Math.floor(ref.length * 0.98)] + 4;
    let any = 0;
    const init = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      init[i] = !fixed[i] && label[i] && cb[i] > th ? 1 : 0;
      any += init[i];
    }
    if (any > n * 0.002) label.set(init);
  }
  for (let round = 0; round < rounds; round++) {
    const fg = [];
    const bg = [];
    for (let i = 0; i < n; i++) (label[i] ? fg : bg).push(i);
    if (!fg.length || !bg.length) break;
    const F = kmeans(px, fg, 5);
    const B = kmeans(px, bg, 10);
    for (let i = 0; i < n; i++) {
      const dd = cost(px, i, B) - cost(px, i, F) - (prior ? prior[i] : 0);
      q[i] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, dd))));
    }
    const sm = blurArray(q, w, h, 1.2);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const v = fixed[i] ? 0 : sm[i] > 0.5 ? 1 : 0;
      if (v !== label[i]) changed++;
      label[i] = v;
    }
    if (!changed) break;
  }
  return label;
}

/** Keep the big pieces of the object and fill its holes. */
function tidyLabels(label, w, h, fixed, { holes = 0.25 } = {}) {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const touches = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const v = label[s];
    const id = sizes.length;
    let sp = 0;
    let size = 0;
    let edge = false;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || fixed[i]) edge = true;
      const go = (j) => {
        if (comp[j] < 0 && label[j] === v) {
          comp[j] = id;
          stack[sp++] = j;
        }
      };
      if (x > 0) go(i - 1);
      if (x < w - 1) go(i + 1);
      if (y > 0) go(i - w);
      if (y < h - 1) go(i + w);
    }
    sizes.push(v ? size : -size);
    touches.push(edge);
  }
  let biggest = 0;
  for (const s of sizes) if (s > biggest) biggest = s;
  if (!biggest) return null;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    const s = sizes[c];
    if (s > 0) label[i] = s >= biggest * 0.15 ? 1 : 0;
    else label[i] = !touches[c] && -s < biggest * holes ? 1 : 0; // holes inside the object
    area += label[i];
  }
  return area ? label : null;
}

/**
 * Turn small labels into a doc-size selection canvas: scale up smoothly, then snap the edge to the
 * real picture with a narrow edge refinement at full resolution.
 */
function labelsToSelection(src, label, sw, sh, E, s) {
  const a = new Float32Array(sw * sh);
  for (let i = 0; i < a.length; i++) a[i] = label[i];
  const small = alphaCanvas(blurArray(a, sw, sh, 0.7), sw, sh);
  const big = makeCanvas(E.w, E.h);
  const bg = big.getContext('2d');
  bg.imageSmoothingEnabled = true;
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(small, 0, 0, E.w, E.h);
  let A = alphaOf(big);
  for (let i = 0; i < A.length; i++) A[i] = clamp01((A[i] - 0.5) * 3 + 0.5);
  const px = pixelsOf(src, E.x, E.y, E.w, E.h);
  A = refineAlpha(px, E.w, E.h, A, { radius: Math.max(2, Math.ceil(1.2 / s)), contrast: 25 }).alpha;
  const out = makeCanvas(src.width, src.height);
  out.getContext('2d').drawImage(alphaCanvas(A, E.w, E.h), E.x, E.y);
  return out;
}

function shrinkTo(src, E, max = 256) {
  const s = Math.min(1, max / Math.max(E.w, E.h));
  const sw = Math.max(4, Math.round(E.w * s));
  const sh = Math.max(4, Math.round(E.h * s));
  const c = makeCanvas(sw, sh);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, E.x, E.y, E.w, E.h, 0, 0, sw, sh);
  return { px: g.getImageData(0, 0, sw, sh).data, sw, sh, s: sw / E.w };
}

/**
 * Object selection inside a rectangle (or a lasso polygon): returns a doc-size selection canvas or
 * null. `poly` (doc coords) marks everything outside it as background.
 */
export function objectSelect(src, rect, { poly = null } = {}) {
  const W = src.width;
  const H = src.height;
  const r = { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)) };
  r.w = Math.min(W, Math.ceil(rect.x + rect.w)) - r.x;
  r.h = Math.min(H, Math.ceil(rect.y + rect.h)) - r.y;
  if (r.w < 4 || r.h < 4) return null;
  const m = Math.round(Math.max(r.w, r.h) * 0.1) + 2;
  const E = { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m) };
  E.w = Math.min(W, r.x + r.w + m) - E.x;
  E.h = Math.min(H, r.y + r.h + m) - E.y;
  const { px, sw, sh, s } = shrinkTo(src, E);
  const n = sw * sh;
  const fixed = new Uint8Array(n);
  const label = new Uint8Array(n);
  const band = Math.max(1, Math.round(Math.min(sw, sh) * 0.03));
  let polyMask = null;
  if (poly?.length > 2) {
    const c = makeCanvas(sw, sh);
    const g = c.getContext('2d');
    g.beginPath();
    poly.forEach(([x, y], i) => (i ? g.lineTo((x - E.x) * s, (y - E.y) * s) : g.moveTo((x - E.x) * s, (y - E.y) * s)));
    g.closePath();
    g.fill();
    polyMask = alphaOf(c);
  }
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      const dx = x / s + E.x;
      const dy = y / s + E.y;
      const inRect = dx >= r.x && dy >= r.y && dx < r.x + r.w && dy < r.y + r.h;
      if (!inRect || (polyMask && polyMask[i] < 0.5)) fixed[i] = 1;
      // start: the inside of the box is the object, its rim the background
      const rim = Math.min(dx - r.x, dy - r.y, r.x + r.w - dx, r.y + r.h - dy) * s < band;
      label[i] = fixed[i] || rim ? 0 : 1;
    }
  }
  // a box drawn right up to the picture edge has nothing outside: its rim stands in for the background
  let anyFixed = false;
  for (let i = 0; i < n && !anyFixed; i++) anyFixed = !!fixed[i];
  if (!anyFixed) for (let i = 0; i < n; i++) if (!label[i]) fixed[i] = 1;
  segment(px, sw, sh, label, fixed);
  if (!tidyLabels(label, sw, sh, fixed)) return null;
  return labelsToSelection(src, label, sw, sh, E, s);
}

/** Select Subject: the main object of the picture, judged against the colours around the edges. */
export function selectSubject(src) {
  const W = src.width;
  const H = src.height;
  const E = { x: 0, y: 0, w: W, h: H };
  const { px, sw, sh, s } = shrinkTo(src, E);
  const n = sw * sh;
  const fixed = new Uint8Array(n);
  const label = new Uint8Array(n);
  const band = Math.max(2, Math.round(Math.max(sw, sh) * 0.05));
  const side = Math.max(1, Math.round(sw * 0.025));
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      // the top and side edges are background for sure; the bottom only probably (people get cut there)
      if (x < side || y === 0 || x >= sw - side) fixed[i] = 1;
      const d = Math.min(x, y, sw - 1 - x, sh - 1 - y);
      label[i] = d < band ? 0 : 1;
    }
  }
  // subjects sit towards the middle: far from it, a pixel needs more colour evidence
  const prior = new Float32Array(n);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const dx = (x / sw - 0.5) * 2;
      const dy = (y / sh - 0.45) * 2;
      prior[y * sw + x] = 2.5 * (dx * dx + dy * dy);
    }
  }
  segment(px, sw, sh, label, fixed, 6, prior);
  if (!tidyLabels(label, sw, sh, fixed)) return null;
  return labelsToSelection(src, label, sw, sh, E, s);
}

/** Select Sky: bright, bluish or pale, smooth areas connected to the top edge. */
export function selectSky(src) {
  const W = src.width;
  const H = src.height;
  const E = { x: 0, y: 0, w: W, h: H };
  const { px, sw, sh, s } = shrinkTo(src, E, 360);
  const n = sw * sh;
  const G = gradientOf(px, sw, sh);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    const L = luma(r, g, b);
    const [, sat] = hsv(r, g, b);
    const blue = b >= r - 6 && b >= g - 25 && L > 70;
    const pale = L > 165 && sat < 0.22;
    const dusk = L > 90 && r > b && sat < 0.6 && i < n * 0.5; // sunsets near the top
    cand[i] = (blue || pale || dusk) && G[i] < 0.09 ? 1 : 0;
  }
  const label = new Uint8Array(n);
  const stack = [];
  for (let x = 0; x < sw; x++) {
    if (cand[x]) {
      label[x] = 1;
      stack.push(x);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % sw;
    const go = (j) => {
      if (!label[j] && cand[j]) {
        label[j] = 1;
        stack.push(j);
      }
    };
    if (x > 0) go(i - 1);
    if (x < sw - 1) go(i + 1);
    if (i >= sw) go(i - sw);
    if (i < n - sw) go(i + sw);
  }
  let area = 0;
  for (let i = 0; i < n; i++) area += label[i];
  if (area < n * 0.02) return null;
  // fill specks (birds, wires) inside the sky, but not things in front of it
  const fixed = new Uint8Array(n);
  if (!tidyLabels(label, sw, sh, fixed, { holes: 0.004 })) return null;
  return labelsToSelection(src, label, sw, sh, E, s);
}

// ---------------------------------------------------------------- magnetic lasso (live wire)

/**
 * Least-cost paths along edges (intelligent scissors): from an anchor, Dijkstra over a window
 * where crossing a strong edge is cheap. path(x, y) then follows the edges to the cursor.
 */
export class LiveWire {
  constructor(px, w, h, { contrast = 10 } = {}) {
    this.w = w;
    this.h = h;
    const G = gradientOf(px, w, h);
    // normalise to the strong edges of this picture
    const sample = [];
    for (let i = 0; i < G.length; i += Math.max(1, Math.floor(G.length / 20000))) sample.push(G[i]);
    sample.sort((a, b) => a - b);
    const top = Math.max(0.02, sample[Math.floor(sample.length * 0.98)] || 1);
    const cmin = contrast / 100;
    this.G = G;
    this.cost = new Float32Array(G.length);
    for (let i = 0; i < G.length; i++) {
      const g = Math.min(1, G[i] / top);
      this.cost[i] = g < cmin ? 1 : 0.04 + 0.96 * (1 - g);
    }
    this.top = top;
    this.cmin = cmin;
    this.win = null;
  }

  /** The strongest edge pixel within `r` of (x, y) (or the point itself when there is none). */
  snap(x, y, r) {
    const { w, h, G } = this;
    let best = null;
    let bv = this.cmin * this.top;
    for (let yy = Math.max(0, Math.round(y - r)); yy <= Math.min(h - 1, Math.round(y + r)); yy++) {
      for (let xx = Math.max(0, Math.round(x - r)); xx <= Math.min(w - 1, Math.round(x + r)); xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
        // prefer near pixels a little when edges are equal
        const v = G[yy * w + xx] - Math.hypot(xx - x, yy - y) * 0.002;
        if (v > bv) {
          bv = v;
          best = [xx, yy];
        }
      }
    }
    return best || [Math.round(Math.max(0, Math.min(w - 1, x))), Math.round(Math.max(0, Math.min(h - 1, y)))];
  }

  setAnchor(ax, ay, R = 180) {
    const { w, h, cost } = this;
    ax = Math.round(ax);
    ay = Math.round(ay);
    const x0 = Math.max(0, ax - R);
    const y0 = Math.max(0, ay - R);
    const ww = Math.min(w, ax + R + 1) - x0;
    const hh = Math.min(h, ay + R + 1) - y0;
    const n = ww * hh;
    const dist = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    // binary heap with lazy deletion
    let cap = n * 4 + 16;
    let hk = new Float32Array(cap);
    let hv = new Int32Array(cap);
    let hn = 0;
    const push = (k, v) => {
      if (hn >= cap) {
        cap *= 2;
        const k2 = new Float32Array(cap);
        k2.set(hk);
        hk = k2;
        const v2 = new Int32Array(cap);
        v2.set(hv);
        hv = v2;
      }
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p];
        hv[i] = hv[p];
        i = p;
      }
      hk[i] = k;
      hv[i] = v;
    };
    const pop = () => {
      const v = hv[0];
      const k = hk[--hn];
      const val = hv[hn];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
      }
      hk[i] = k;
      hv[i] = val;
      return v;
    };
    const s = (ay - y0) * ww + (ax - x0);
    dist[s] = 0;
    push(0, s);
    const nb = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];
    while (hn) {
      const i = pop();
      if (done[i]) continue;
      done[i] = 1;
      const x = i % ww;
      const y = (i / ww) | 0;
      for (const [dx, dy, len] of nb) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= ww || yy >= hh) continue;
        const j = yy * ww + xx;
        if (done[j]) continue;
        const nd = dist[i] + cost[(yy + y0) * w + xx + x0] * len;
        if (nd < dist[j]) {
          dist[j] = nd;
          prev[j] = i;
          push(nd, j);
        }
      }
    }
    this.win = { x0, y0, ww, hh, prev, anchor: [ax, ay] };
  }

  /** Points from the anchor to (x, y) along edges, or null when (x, y) is outside the window. */
  path(x, y) {
    const W = this.win;
    if (!W) return null;
    const lx = Math.round(x) - W.x0;
    const ly = Math.round(y) - W.y0;
    if (lx < 0 || ly < 0 || lx >= W.ww || ly >= W.hh) return null;
    const pts = [];
    let i = ly * W.ww + lx;
    let guard = W.ww * W.hh;
    while (i >= 0 && guard-- > 0) {
      pts.push([(i % W.ww) + W.x0, ((i / W.ww) | 0) + W.y0]);
      i = W.prev[i];
    }
    pts.reverse();
    return pts;
  }
}

/** Length of a polyline. */
export function polyLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

// ---------------------------------------------------------------- Select and Mask

/** Box sums of `src` over a (2k+1)² window (edges clamp the window). */
function boxSum(src, w, h, k) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(w - 1, k); x++) acc += src[o + x];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc;
      if (x + k + 1 < w) acc += src[o + x + k + 1];
      if (x - k >= 0) acc -= src[o + x - k];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(h - 1, k); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      if (y + k + 1 < h) acc += tmp[(y + k + 1) * w + x];
      if (y - k >= 0) acc -= tmp[(y - k) * w + x];
    }
  }
  return out;
}

/**
 * Select and Mask's refinement of a selection alpha `a0` against the picture `px`:
 * o = {radius, smart, brush (Uint8Array: extra areas to refine), smooth 0..100, feather px,
 *      contrast 0..100, shift −100..100, decontaminate 0..100}
 * Within `radius` of the edge (and in brushed areas) the alpha is re-estimated from the nearby sure
 * object and sure background colours (alpha = projection of the pixel onto the line between them).
 * Returns {alpha, fg} where fg (RGB per pixel, or null) is the estimated object colour for
 * decontamination.
 */
export function refineAlpha(px, w, h, a0, o = {}) {
  const n = w * h;
  let a = Float32Array.from(a0);
  let fg = null;
  const radius = Math.max(0, o.radius || 0);
  const brush = o.brush || null;
  let anyBrush = false;
  if (brush) for (let i = 0; i < n && !anyBrush; i++) anyBrush = !!brush[i];
  if (radius > 0 || anyBrush || o.decontaminate > 0) {
    const hard = new Float32Array(n);
    for (let i = 0; i < n; i++) hard[i] = a[i] >= 0.5 ? 1 : 0;
    const bandOf = (r) => {
      const ri = Math.max(0, Math.round(r));
      if (!ri) return new Uint8Array(n);
      const dil = rankFilter(hard, w, h, ri, true);
      const ero = rankFilter(hard, w, h, ri, false);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = dil[i] !== ero[i] ? 1 : 0;
      return b;
    };
    let band = bandOf(radius);
    if (o.smart && radius >= 3) {
      // hard edges (strong contrast) keep a narrow band, soft ones (hair, fur) the full radius
      const narrow = bandOf(radius / 3);
      const G = blurArray(gradientOf(px, w, h), w, h, Math.max(1, radius / 3));
      for (let i = 0; i < n; i++) if (band[i] && !narrow[i] && G[i] > 0.12) band[i] = 0;
    }
    if (anyBrush) for (let i = 0; i < n; i++) if (brush[i]) band[i] = 1;
    // pixels to re-estimate; partial pixels left from feathering only get their colour learnt
    const est = Uint8Array.from(band);
    for (let i = 0; i < n; i++) if (a[i] > 0.02 && a[i] < 0.98) band[i] = 1;
    const idx = [];
    for (let i = 0; i < n; i++) if (band[i]) idx.push(i);
    if (idx.length) {
      let k = Math.ceil(radius * 1.5) + 3;
      if (anyBrush) k = Math.max(k, 14);
      const sums = [];
      const chan = new Float32Array(n);
      for (const want of [1, 0]) {
        for (let c = 0; c < 4; c++) {
          for (let i = 0; i < n; i++) {
            const sure = !band[i] && hard[i] === want;
            chan[i] = sure ? (c < 3 ? px[i * 4 + c] : 1) : 0;
          }
          const s = boxSum(chan, w, h, k);
          sums.push(Float32Array.from(idx, (i) => s[i]));
        }
      }
      fg = new Uint8ClampedArray(n * 3);
      for (let i = 0; i < n; i++) {
        fg[i * 3] = px[i * 4];
        fg[i * 3 + 1] = px[i * 4 + 1];
        fg[i * 3 + 2] = px[i * 4 + 2];
      }
      const refine = radius > 0 || anyBrush;
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j];
        const nf = sums[3][j];
        const nb = sums[7][j];
        if (nf < 0.5) continue;
        const F = [sums[0][j] / nf, sums[1][j] / nf, sums[2][j] / nf];
        fg[i * 3] = F[0];
        fg[i * 3 + 1] = F[1];
        fg[i * 3 + 2] = F[2];
        if (!refine || nb < 0.5 || !est[i]) continue;
        const B = [sums[4][j] / nb, sums[5][j] / nb, sums[6][j] / nb];
        const fb = [F[0] - B[0], F[1] - B[1], F[2] - B[2]];
        const den = fb[0] ** 2 + fb[1] ** 2 + fb[2] ** 2;
        if (den < 300) continue; // object and background look alike here: keep the old edge
        const p = i * 4;
        const v = ((px[p] - B[0]) * fb[0] + (px[p + 1] - B[1]) * fb[1] + (px[p + 2] - B[2]) * fb[2]) / den;
        a[i] = clamp01(v);
      }
    }
  }
  const sc = o.scale || 1; // preview runs at a smaller size
  const smooth = o.smooth || 0;
  if (smooth > 0) {
    const r = (smooth / 100) * 6 * sc;
    const b = blurArray(a, w, h, r);
    const k = 1 + 4 / Math.max(0.5, r);
    for (let i = 0; i < n; i++) a[i] = clamp01((b[i] - 0.5) * k + 0.5);
  }
  if (o.feather > 0) a = blurArray(a, w, h, o.feather / 2);
  if (o.contrast > 0) {
    const k = 1 / Math.max(0.01, 1 - o.contrast / 100);
    for (let i = 0; i < n; i++) a[i] = clamp01((a[i] - 0.5) * k + 0.5);
  }
  if (o.shift) {
    const r = Math.round((Math.abs(o.shift) / 100) * 10 * sc);
    if (r >= 1) a = rankFilter(a, w, h, r, o.shift > 0);
    else {
      const d = o.shift / 100;
      for (let i = 0; i < n; i++) if (a[i] > 0 && a[i] < 1) a[i] = clamp01(a[i] + d);
    }
  }
  return { alpha: a, fg };
}

/**
 * Refine a doc-size selection canvas against the doc-size picture `src`, working only on the area
 * around the selection's edges. Returns {alpha: canvas, colors: canvas | null (decontaminated)}.
 */
export function refineCanvas(src, base, brushCanvas, o = {}) {
  const W = src.width;
  const H = src.height;
  const A = alphaOf(base);
  let box = boundsOf(A, W, H, 0);
  const B = brushCanvas ? alphaOf(brushCanvas) : null;
  const bb = B ? boundsOf(B, W, H, 0) : null;
  if (bb) box = box ? union(box, bb) : bb;
  if (!box) return { alpha: makeCanvas(W, H), colors: null };
  const pad = Math.ceil((o.radius || 0) * 2.5 + (o.feather || 0) * 2 + 12 + (Math.abs(o.shift || 0) / 10) + (o.smooth || 0) / 10);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(W, box.x + box.w + pad) - x;
  const h = Math.min(H, box.y + box.h + pad) - y;
  const crop = (arr) => {
    const out = new Float32Array(w * h);
    for (let yy = 0; yy < h; yy++) out.set(arr.subarray((yy + y) * W + x, (yy + y) * W + x + w), yy * w);
    return out;
  };
  const a = crop(A);
  const brush = B ? Uint8Array.from(crop(B), (v) => (v > 0.3 ? 1 : 0)) : null;
  const px = pixelsOf(src, x, y, w, h);
  const r = refineAlpha(px, w, h, a, { ...o, brush });
  const full = makeCanvas(W, H);
  full.getContext('2d').drawImage(alphaCanvas(r.alpha, w, h), x, y);
  let colors = null;
  if (o.decontaminate > 0 && r.fg) {
    const amt = o.decontaminate / 100;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      const al = r.alpha[i];
      const t = al >= 0.995 ? 0 : amt;
      d[i * 4] = px[i * 4] + (r.fg[i * 3] - px[i * 4]) * t;
      d[i * 4 + 1] = px[i * 4 + 1] + (r.fg[i * 3 + 1] - px[i * 4 + 1]) * t;
      d[i * 4 + 2] = px[i * 4 + 2] + (r.fg[i * 3 + 2] - px[i * 4 + 2]) * t;
      d[i * 4 + 3] = t > 0 ? px[i * 4 + 3] : 0; // only the pixels that changed
    }
    g.putImageData(img, 0, 0);
    colors = { canvas: c, x, y };
  }
  return { alpha: full, colors };
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ---------------------------------------------------------------- channels

/** A colour channel ('r' | 'g' | 'b') or the luminosity ('rgb') of a picture as selection alpha. */
export function channelAlpha(src, which) {
  const W = src.width;
  const H = src.height;
  const px = pixelsOf(src);
  const a = new Float32Array(W * H);
  const c = { r: 0, g: 1, b: 2 }[which];
  for (let i = 0; i < a.length; i++) {
    const p = i * 4;
    const v = c === undefined ? luma(px[p], px[p + 1], px[p + 2]) : px[p + c];
    a[i] = (v / 255) * (px[p + 3] / 255);
  }
  return alphaCanvas(a, W, H);
}

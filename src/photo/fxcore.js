// Low-level pixel helpers shared by adjust.js, fx2.js, fx3.js and the newer filter modules. This file
// imports nothing from the filter tables, so adjust.js can use it without an import cycle.

export const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
export const read = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
export const toCanvas = (img) => {
  const c = mk(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
};
export const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
export const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
export const hexRgb = (hex) => {
  let s = String(hex || '#000000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbHex = (r, g, b) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

/** A small seeded random generator (same picture → same result). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A canvas grown by `p` pixels on each side, the border filled with mirrored copies of the edges. */
export function mirrorPad(c, p) {
  // wider than the picture: mirror the mirrored copy again (an opaque picture stays opaque after a
  // blur wider than itself), up to a sane canvas size
  p = Math.max(0, Math.min(Math.ceil(p), Math.max(Math.min(c.width, c.height), Math.floor((3072 - Math.max(c.width, c.height)) / 2))));
  let out = { canvas: c, pad: 0 };
  while (out.pad < p) {
    const step = mirrorOnce(out.canvas, p - out.pad);
    if (!step.pad) break;
    out = { canvas: step.canvas, pad: out.pad + step.pad };
  }
  return out.pad ? out : mirrorOnce(c, 0);
}

function mirrorOnce(c, p) {
  const w = c.width;
  const h = c.height;
  p = Math.max(0, Math.min(Math.ceil(p), w, h));
  const big = mk(w + 2 * p, h + 2 * p);
  const g = big.getContext('2d');
  g.drawImage(c, p, p);
  if (!p) return { canvas: big, pad: 0 };
  g.save();
  g.scale(-1, 1);
  g.drawImage(c, 0, 0, p, h, -p, p, p, h);
  g.drawImage(c, w - p, 0, p, h, -(w + 2 * p), p, p, h);
  g.restore();
  g.save();
  g.scale(1, -1);
  g.drawImage(big, 0, p, w + 2 * p, p, 0, -p, w + 2 * p, p);
  g.drawImage(big, 0, h, w + 2 * p, p, 0, -(h + 2 * p), w + 2 * p, p);
  g.restore();
  return { canvas: big, pad: p };
}

/**
 * Gaussian blur (CSS blur radius = standard deviation) with mirrored edges, so an opaque picture keeps
 * opaque, unchanged-brightness edges (like Photoshop), while transparent parts still blur softly.
 */
export function blurred(c, r) {
  if (!(r > 0)) return c;
  // a wide blur only keeps broad shapes: blur a smaller copy and scale it back up (much faster,
  // the difference is a fraction of a percent of the radius)
  const f = Math.min(16, Math.floor(r / 3));
  if (f >= 2 && c.width / f >= 8 && c.height / f >= 8) {
    const s = mk(Math.ceil(c.width / f), Math.ceil(c.height / f));
    const sg = s.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(c, 0, 0, s.width, s.height);
    const b = blurred(s, Math.sqrt(Math.max(0.25, r * r - (f * f) / 4)) / f);
    const out = mk(c.width, c.height);
    const og = out.getContext('2d');
    og.imageSmoothingQuality = 'low';
    og.drawImage(b, 0, 0, out.width, out.height);
    return out;
  }
  const { canvas: big, pad } = mirrorPad(c, r * 3);
  const out = mk(c.width, c.height);
  const og = out.getContext('2d');
  og.filter = `blur(${r}px)`;
  og.drawImage(big, -pad, -pad);
  // a picture smaller than the blur is padded less than 3σ: what is left is plain edge blur
  return out;
}

/** Bilinear sample of RGBA at (x, y), edges clamped. */
export function sampler(d, w, h) {
  return (x, y, o, k) => {
    x = clamp(x, 0, w - 1.001);
    y = clamp(y, 0, h - 1.001);
    if (w === 1) x = 0;
    if (h === 1) y = 0;
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = (y0 * w + x0) * 4;
    const j = w > 1 ? i + 4 : i;
    const m = h > 1 ? i + w * 4 : i;
    const n = w > 1 ? m + 4 : m;
    for (let c = 0; c < 4; c++) o[k + c] = (d[i + c] * (1 - fx) + d[j + c] * fx) * (1 - fy) + (d[m + c] * (1 - fx) + d[n + c] * fx) * fy;
  };
}

/** New canvas where each pixel comes from map(x, y) → [sx, sy] in the source (pixel centres). */
export function remap(c, map) {
  const src = read(c);
  const { width: w, height: h } = src;
  const out = new ImageData(w, h);
  const s = sampler(src.data, w, h);
  const q = [0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      map(x + 0.5, y + 0.5, q);
      if (q[0] !== q[0]) continue; // NaN: transparent
      s(q[0] - 0.5, q[1] - 0.5, out.data, (y * w + x) * 4);
    }
  }
  return toCanvas(out);
}

/** Per-channel median in a (2r+1)² window, using running histograms (Huang). */
export function medianData(d, w, h, r) {
  const out = new Uint8ClampedArray(d);
  const hist = new Uint16Array(256);
  const half = ((2 * r + 1) ** 2) >> 1;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      let n = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      const add = (x, v) => {
        for (let yy = y0; yy <= y1; yy++) hist[d[(yy * w + x) * 4 + c]] += v;
        n += v * (y1 - y0 + 1);
      };
      for (let x = 0; x <= Math.min(w - 1, r); x++) add(x, 1);
      for (let x = 0; x < w; x++) {
        let acc = 0;
        let m = 0;
        const target = Math.min(half, n >> 1);
        while (m < 255 && acc + hist[m] <= target) acc += hist[m++];
        out[(y * w + x) * 4 + c] = m;
        if (x - r >= 0) add(x - r, -1);
        if (x + r + 1 < w) add(x + r + 1, 1);
      }
    }
  }
  return out;
}

/** Per-channel minimum or maximum in a square (or, with `round`, a near-circular) window. */
export function minMax(d, w, h, r, isMax, round = false) {
  const pick = isMax ? (a, b) => (a > b ? a : b) : (a, b) => (a < b ? a : b);
  // a square window is separable: rows then columns, with a sliding scan per row
  const pass = (src, rr, horizontal) => {
    const out = new Uint8ClampedArray(src);
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++) {
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < len; i++) {
          let v = isMax ? 0 : 255;
          const a = Math.max(0, i - rr);
          const b = Math.min(len - 1, i + rr);
          for (let k = a; k <= b; k++) {
            const o = horizontal ? (line * w + k) * 4 + c : (k * w + line) * 4 + c;
            v = pick(v, src[o]);
          }
          out[horizontal ? (line * w + i) * 4 + c : (i * w + line) * 4 + c] = v;
        }
      }
    }
    return out;
  };
  if (!round || r <= 1) return pass(pass(d, r, true), r, false);
  // round: r steps that alternate a 3×3 square and a plus-shaped cross ≈ an octagon (a rounder blob)
  let cur = d;
  for (let s = 0; s < r; s++) {
    if (s % 2 === 0) cur = pass(pass(cur, 1, true), 1, false);
    else {
      const a = pass(cur, 1, true);
      const b = pass(cur, 1, false);
      const o = new Uint8ClampedArray(cur);
      for (let i = 0; i < o.length; i++) if ((i & 3) !== 3) o[i] = pick(a[i], b[i]);
      cur = o;
    }
  }
  return cur;
}

/** Luminance 0..255 of an ImageData as floats. */
export function grayOf(img) {
  const d = img.data;
  const n = img.width * img.height;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return L;
}

// sRGB <-> linear light lookup tables (for exposure and other "light" maths)
export const TO_LIN = new Float32Array(256).map((_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
export const toSrgb = (v) => {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
};

/** RGB 0..255 → HSL (h 0..1, s, l 0..1). */
export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL (0..1) → RGB 0..255. */
export function hslToRgb(h, s, l) {
  if (s <= 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** 256-bin histograms (luminosity, red, green, blue) of a canvas, alpha-weighted, from a smaller copy. */
export function histograms(c, maxSide = 512) {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  let src = c;
  if (k < 1) {
    src = mk(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
    const g = src.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(c, 0, 0, src.width, src.height);
  }
  const d = read(src).data;
  const H = { l: new Float64Array(256), r: new Float64Array(256), g: new Float64Array(256), b: new Float64Array(256) };
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (!a) continue;
    H.r[d[i]] += a;
    H.g[d[i + 1]] += a;
    H.b[d[i + 2]] += a;
    H.l[Math.round(lum(d[i], d[i + 1], d[i + 2]))] += a;
  }
  return H;
}

/** The value below which `frac` of a histogram lies. */
export function percentile(hist, frac) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (!total) return frac < 0.5 ? 0 : 255;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * frac) return i;
  }
  return 255;
}

// Building blocks for the filters in fx3.js and the filter gallery (fxgallery.js): pixel access,
// fast blurs on float arrays, edges, noise and stroke textures, embossed shading, cells.

import { blurred, remap, sampler, medianData } from './fx2.js';

export { blurred, remap, sampler, medianData };

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
  const n = parseInt(String(hex || '#000000').slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A small seeded random generator (same picture → same result). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Luminance 0..255 of an ImageData. */
export function grayOf(img) {
  const d = img.data;
  const n = img.width * img.height;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return L;
}

/** One box blur pass (radius r) along x then y, edges clamped. */
function boxPass(a, w, h, r) {
  if (r < 1) return a;
  const t = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = a[row] * (r + 1);
    for (let x = 1; x <= r; x++) s += a[row + Math.min(w - 1, x)];
    for (let x = 0; x < w; x++) {
      t[row + x] = s * k;
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = t[x] * (r + 1);
    for (let y = 1; y <= r; y++) s += t[Math.min(h - 1, y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s * k;
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Box blur of a float array (one pass = box, three passes ≈ Gaussian). */
export function boxBlurF(a, w, h, r, passes = 1) {
  let o = a;
  const rr = Math.max(0, Math.round(r));
  for (let i = 0; i < passes; i++) o = boxPass(o, w, h, rr);
  return o === a ? new Float32Array(a) : o;
}
/** Gaussian-like blur of a float array with standard deviation ≈ sigma. */
export function gaussF(a, w, h, sigma) {
  if (sigma < 0.5) return new Float32Array(a);
  return boxBlurF(a, w, h, Math.max(1, Math.round(Math.sqrt(sigma * sigma + 1) - 0.5)), 3);
}

/** Sobel gradient of a float image: gx, gy and magnitude. */
export function sobelF(L, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const yc = y * w;
    const yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const a = L[ym + xm];
      const b = L[ym + x];
      const c = L[ym + xp];
      const d = L[yc + xm];
      const f = L[yc + xp];
      const g = L[yp + xm];
      const hh = L[yp + x];
      const k = L[yp + xp];
      const sx = c + 2 * f + k - a - 2 * d - g;
      const sy = g + 2 * hh + k - a - 2 * b - c;
      const i = yc + x;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  return { gx, gy, mag };
}

/**
 * Smooth fractal noise 0..1 (w×h): random grids scaled up with smooth filtering, `octaves` of them
 * halving in size. `scale` is the size of the largest blobs in pixels.
 */
export function noiseF(w, h, scale = 32, octaves = 3, seed = 1) {
  const out = new Float32Array(w * h);
  const r = rng(seed);
  let amp = 1;
  let total = 0;
  let s = Math.max(1, scale);
  for (let o = 0; o < octaves; o++) {
    const gw = Math.max(2, Math.ceil(w / s) + 2);
    const gh = Math.max(2, Math.ceil(h / s) + 2);
    const small = mk(gw, gh);
    const sg = small.getContext('2d');
    const id = sg.createImageData(gw, gh);
    for (let i = 0; i < gw * gh; i++) {
      const v = (r() * 255) | 0;
      id.data[i * 4] = v;
      id.data[i * 4 + 3] = 255;
    }
    sg.putImageData(id, 0, 0);
    const big = mk(w, h);
    const bg = big.getContext('2d', { willReadFrequently: true });
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(small, 0.5, 0.5, gw - 1, gh - 1, 0, 0, (gw - 1) * s, (gh - 1) * s);
    const d = bg.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) out[i] += (d[i * 4] / 255) * amp;
    total += amp;
    amp *= 0.5;
    s = Math.max(1, s / 2);
    if (s <= 1 && o > 0) break;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Plain per-pixel random values 0..1. */
export function whiteF(w, h, seed = 1) {
  const r = rng(seed);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = r();
  return out;
}

/** A float image (0..255) as a grey canvas. */
export function floatCanvas(a, w, h) {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = cl(a[i]);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return toCanvas(img);
}
/** Red channel of a canvas as floats 0..255. */
export function canvasFloat(c) {
  const d = read(c).data;
  const n = c.width * c.height;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4];
  return a;
}

/** Smear a canvas along a direction (degrees) over `len` pixels: an average of shifted copies. */
export function dirBlur(c, angle, len) {
  const out = mk(c.width, c.height);
  const g = out.getContext('2d');
  g.drawImage(c, 0, 0);
  const steps = Math.max(1, Math.min(24, Math.round(len / 1.5)));
  const t = (angle * Math.PI) / 180;
  for (let k = 1; k <= steps; k++) {
    const d = ((k / steps) - 0.5) * len;
    g.globalAlpha = 1 / (k + 1);
    g.drawImage(c, Math.cos(t) * d, Math.sin(t) * d);
  }
  return out;
}
/** The same for a float image. */
export function dirBlurF(a, w, h, angle, len) {
  return canvasFloat(dirBlur(floatCanvas(a, w, h), angle, len));
}

/**
 * Stroke texture 0..1: random specks smeared along `angle`, `len` pixels long (pencil, charcoal,
 * crosshatch). `density` 0..1 is how many specks start a stroke.
 */
export function strokesF(w, h, angle, len, density = 0.3, seed = 1) {
  const n = whiteF(w, h, seed);
  for (let i = 0; i < n.length; i++) n[i] = n[i] < density ? 255 : 0;
  const s = dirBlurF(n, w, h, angle, len);
  let mx = 1e-6;
  for (let i = 0; i < s.length; i++) if (s[i] > mx) mx = s[i];
  for (let i = 0; i < s.length; i++) s[i] /= mx;
  return s;
}

/** Light falling on a relief made from a height map: -1..1 (0 = flat), light from `angle` degrees. */
export function shadeF(H, w, h, angle = 135, height = 1) {
  const { gx, gy } = sobelF(H, w, h);
  const t = (angle * Math.PI) / 180;
  const lx = Math.cos(t);
  const ly = -Math.sin(t);
  const out = new Float32Array(w * h);
  const k = height / 8;
  for (let i = 0; i < out.length; i++) {
    const nx = -gx[i] * k;
    const ny = -gy[i] * k;
    // how far the surface normal (nx, ny, 1) leans toward the light: flat 0, -1..1
    out[i] = (nx * lx + ny * ly) / Math.hypot(nx, ny, 1);
  }
  return out;
}

/** Two-colour picture: t = 1 → fg (the dark parts), t = 0 → bg, keeping the source alpha. */
export function duo(src, t, fg, bg) {
  const [fr, fgc, fb] = hexRgb(fg);
  const [br, bgc, bb] = hexRgb(bg);
  const out = new ImageData(src.width, src.height);
  const d = out.data;
  for (let i = 0; i < t.length; i++) {
    const k = clamp(t[i], 0, 1);
    d[i * 4] = br + (fr - br) * k;
    d[i * 4 + 1] = bgc + (fgc - bgc) * k;
    d[i * 4 + 2] = bb + (fb - bb) * k;
    d[i * 4 + 3] = src.data[i * 4 + 3];
  }
  return out;
}

/** Kuwahara filter (painterly flat areas with crisp edges), radius r, using summed-area tables. */
export function kuwahara(img, r) {
  const { width: w, height: h, data: d } = img;
  const W = w + 1;
  const sums = [0, 1, 2].map(() => new Float64Array(W * (h + 1)));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    const rs = [0, 0, 0];
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) rs[c] += d[o + c];
      const L = lum(d[o], d[o + 1], d[o + 2]);
      rq += L * L;
      const j = (y + 1) * W + x + 1;
      for (let c = 0; c < 3; c++) sums[c][j] = sums[c][j - W] + rs[c];
      sq[j] = sq[j - W] + rq;
    }
  }
  const Ls = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rl = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rl += lum(d[o], d[o + 1], d[o + 2]);
      const j = (y + 1) * W + x + 1;
      Ls[j] = Ls[j - W] + rl;
    }
  }
  const box = (t, x0, y0, x1, y1) => t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0];
  const out = new ImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      let bi = 0;
      const quads = [[x - r, y - r, x + 1, y + 1], [x, y - r, x + r + 1, y + 1], [x - r, y, x + 1, y + r + 1], [x, y, x + r + 1, y + r + 1]];
      const areas = [];
      for (let q = 0; q < 4; q++) {
        const x0 = clamp(quads[q][0], 0, w);
        const y0 = clamp(quads[q][1], 0, h);
        const x1 = clamp(quads[q][2], 0, w);
        const y1 = clamp(quads[q][3], 0, h);
        const n = Math.max(1, (x1 - x0) * (y1 - y0));
        const m = box(Ls, x0, y0, x1, y1) / n;
        const v = box(sq, x0, y0, x1, y1) / n - m * m;
        areas.push([x0, y0, x1, y1, n]);
        if (v < best) {
          best = v;
          bi = q;
        }
      }
      const [x0, y0, x1, y1, n] = areas[bi];
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) od[o + c] = box(sums[c], x0, y0, x1, y1) / n;
      od[o + 3] = d[o + 3];
    }
  }
  return out;
}

/**
 * Jittered-grid Voronoi cells of size `cell`: for each pixel the cell index and how far it is from
 * the border with the next cell (pixels). Also the cell centres.
 */
export function voronoi(w, h, cell, seed = 1, jitter = 0.8) {
  const r = rng(seed);
  const cw = Math.ceil(w / cell) + 1;
  const chh = Math.ceil(h / cell) + 1;
  const cx = new Float32Array(cw * chh);
  const cy = new Float32Array(cw * chh);
  for (let j = 0; j < chh; j++) {
    for (let i = 0; i < cw; i++) {
      cx[j * cw + i] = (i + 0.5 + (r() - 0.5) * jitter) * cell;
      cy[j * cw + i] = (j + 0.5 + (r() - 0.5) * jitter) * cell;
    }
  }
  const id = new Int32Array(w * h);
  const edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gj = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const gi = Math.floor(x / cell);
      let d1 = Infinity;
      let d2 = Infinity;
      let b1 = 0;
      for (let j = Math.max(0, gj - 1); j <= Math.min(chh - 1, gj + 1); j++) {
        for (let i = Math.max(0, gi - 1); i <= Math.min(cw - 1, gi + 1); i++) {
          const k = j * cw + i;
          const dd = (cx[k] - x) ** 2 + (cy[k] - y) ** 2;
          if (dd < d1) {
            d2 = d1;
            d1 = dd;
            b1 = k;
          } else if (dd < d2) d2 = dd;
        }
      }
      const i = y * w + x;
      id[i] = b1;
      edge[i] = (Math.sqrt(d2) - Math.sqrt(d1)) / 2;
    }
  }
  return { id, edge, cx, cy, n: cw * chh };
}

/** Average colour of each region of a label map. */
export function regionMeans(img, id, n) {
  const d = img.data;
  const s = new Float64Array(n * 4);
  for (let i = 0; i < id.length; i++) {
    const k = id[i] * 4;
    s[k] += d[i * 4];
    s[k + 1] += d[i * 4 + 1];
    s[k + 2] += d[i * 4 + 2];
    s[k + 3]++;
  }
  for (let k = 0; k < n; k++) if (s[k * 4 + 3]) for (let c = 0; c < 3; c++) s[k * 4 + c] /= s[k * 4 + 3];
  return s;
}

/** Copy of an ImageData. */
export const cloneImg = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

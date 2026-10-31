// Resampling for Image ▸ Image Size (and Super Zoom): nearest neighbour, bilinear, bicubic (smooth
// gradients), bicubic smoother (enlarging), bicubic sharper (reducing) and preserve details
// (enlarging, with noise reduction), like Photoshop's choices. Separable filters on premultiplied
// pixels in typed arrays.

import { mk, read, clamp } from './fxcore.js';

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/** Kernels: [function, support radius]. */
const KERNELS = {
  bilinear: [(x) => Math.max(0, 1 - Math.abs(x)), 1],
  // Keys cubic, a = -0.5 (Photoshop's plain bicubic)
  bicubic: [(x) => {
    const a = -0.5;
    x = Math.abs(x);
    if (x < 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
    if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
    return 0;
  }, 2],
  // Mitchell–Netravali (B = C = 1/3): smooth, few halos when enlarging
  bicubicSmoother: [(x) => {
    const B = 1 / 3;
    const C = 1 / 3;
    x = Math.abs(x);
    if (x < 1) return ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x ** 2 + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x ** 2 + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  }, 2],
  // Keys with a = -0.75: crisper when reducing
  bicubicSharper: [(x) => {
    const a = -0.75;
    x = Math.abs(x);
    if (x < 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
    if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
    return 0;
  }, 2],
  lanczos: [(x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0), 3],
};

/** Contributions of the source samples to each of `dn` outputs (scale dn / sn). */
function weights(sn, dn, kern, support) {
  const scale = dn / sn;
  const stretch = scale < 1 ? 1 / scale : 1;
  const rad = support * stretch;
  const idx = [];
  const wts = [];
  for (let i = 0; i < dn; i++) {
    const c = (i + 0.5) / scale - 0.5;
    const a = Math.floor(c - rad) + 1;
    const b = Math.floor(c + rad);
    const ii = [];
    const ww = [];
    let sum = 0;
    for (let j = a; j <= b; j++) {
      const w = kern((j - c) / stretch);
      if (!w) continue;
      ii.push(clamp(j, 0, sn - 1));
      ww.push(w);
      sum += w;
    }
    if (!ii.length) {
      ii.push(clamp(Math.round(c), 0, sn - 1));
      ww.push(1);
      sum = 1;
    }
    idx.push(Int32Array.from(ii));
    wts.push(Float32Array.from(ww.map((w) => w / sum)));
  }
  return { idx, wts };
}

/** Separable resample of RGBA bytes (premultiplied while filtering). */
function resampleData(src, sw, sh, dw, dh, kern, support) {
  const H = weights(sw, dw, kern, support);
  const V = weights(sh, dh, kern, support);
  // premultiplied source as floats, one row at a time through the horizontal pass
  const mid = new Float32Array(dw * sh * 4);
  const row = new Float32Array(sw * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const o = (y * sw + x) * 4;
      const a = src[o + 3] / 255;
      row[x * 4] = src[o] * a;
      row[x * 4 + 1] = src[o + 1] * a;
      row[x * 4 + 2] = src[o + 2] * a;
      row[x * 4 + 3] = src[o + 3];
    }
    for (let x = 0; x < dw; x++) {
      const ii = H.idx[x];
      const ww = H.wts[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let k = 0; k < ii.length; k++) {
        const j = ii[k] * 4;
        const w = ww[k];
        r += row[j] * w;
        g += row[j + 1] * w;
        b += row[j + 2] * w;
        al += row[j + 3] * w;
      }
      const o = (y * dw + x) * 4;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
      mid[o + 3] = al;
    }
  }
  const out = new ImageData(dw, dh);
  const d = out.data;
  for (let y = 0; y < dh; y++) {
    const ii = V.idx[y];
    const ww = V.wts[y];
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let k = 0; k < ii.length; k++) {
        const j = (ii[k] * dw + x) * 4;
        const w = ww[k];
        r += mid[j] * w;
        g += mid[j + 1] * w;
        b += mid[j + 2] * w;
        al += mid[j + 3] * w;
      }
      const o = (y * dw + x) * 4;
      const A = clamp(al, 0, 255);
      d[o + 3] = A;
      const k = A > 0.5 ? 255 / A : 0;
      d[o] = clamp(r * k, 0, 255);
      d[o + 1] = clamp(g * k, 0, 255);
      d[o + 2] = clamp(b * k, 0, 255);
    }
  }
  return out;
}

/** Edge-aware sharpening of the luminance (preserve details) and optional noise smoothing. */
function detailPass(img, amount, noise) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // 3×3 blur
  const B = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const yc = y * w;
    const yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      B[yc + x] = (Y[ym + xm] + 2 * Y[ym + x] + Y[ym + xp] + 2 * Y[yc + xm] + 4 * Y[yc + x] + 2 * Y[yc + xp] + Y[yp + xm] + 2 * Y[yp + x] + Y[yp + xp]) / 16;
    }
  }
  const nT = noise * 0.12;
  for (let i = 0; i < n; i++) {
    let dlt = Y[i] - B[i];
    // small differences are noise: smooth them; bigger ones are detail: strengthen them
    if (Math.abs(dlt) < nT) dlt = -dlt * 0.8;
    else dlt *= amount;
    const lim = 24;
    dlt = lim * Math.tanh(dlt / lim);
    for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] + dlt, 0, 255);
  }
  return img;
}

/**
 * A resized copy of canvas `src` (W × H) with one of Photoshop's methods: auto, preserve,
 * bicubicSmoother, bicubicSharper, bicubic, nearest, bilinear. opts.noise: 0..100 (preserve details).
 */
export function resampleCanvas(src, W, H, method = 'auto', { noise = 0, detail = 0.5 } = {}) {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const up = W * H > src.width * src.height;
  if (method === 'auto') method = up ? 'bicubicSmoother' : 'bicubicSharper';
  const out = mk(W, H);
  const g = out.getContext('2d');
  if (method === 'nearest') {
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, W, H);
    return out;
  }
  const kind = method === 'preserve' ? 'lanczos' : KERNELS[method] ? method : 'bicubic';
  const [kern, support] = KERNELS[kind];
  const img = resampleData(read(src).data, src.width, src.height, W, H, kern, support);
  if (method === 'preserve') detailPass(img, 0.35 + detail * 0.5, noise);
  else if (method === 'bicubicSharper' && !up) detailPass(img, 0.25, 0);
  g.putImageData(img, 0, 0);
  return out;
}

/** Super Zoom (Neural Filters): ×k enlargement with detail enhancement and noise reduction. */
export function superZoom(src, k = 2, { detail = 50, noise = 0 } = {}) {
  return resampleCanvas(src, src.width * k, src.height * k, 'preserve', { noise, detail: detail / 100 });
}

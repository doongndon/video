// Fewer colours: palettes (adaptive median cut, web-safe, uniform, greys, black and white),
// dithering (none, diffusion, pattern, noise), see-through pixels, and writers for GIF and PNG-8.
// Used by Image ▸ Mode (Indexed Color, Bitmap) and File ▸ Export ▸ Save for Web.

import { medianCut, encodeIndexedGif } from '../gif.js';

export const PALETTES = [['adaptive', '적응 (사진에 맞춤)'], ['perceptual', '지각 (사람 눈 기준)'], ['web', '웹 색상 (216)'], ['uniform', '균일'], ['gray', '회색 음영'], ['bw', '검정과 흰색']];
export const DITHERS = [['diffusion', '확산 (오차 퍼뜨리기)'], ['pattern', '패턴 (규칙적인 점)'], ['noise', '노이즈'], ['none', '없음']];

function paletteFor(img, kind, colors) {
  const d = img.data;
  if (kind === 'bw') return [[0, 0, 0], [255, 255, 255]];
  if (kind === 'gray') return Array.from({ length: colors }, (_, i) => {
    const v = Math.round((i * 255) / Math.max(1, colors - 1));
    return [v, v, v];
  });
  if (kind === 'web') {
    const p = [];
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push([r * 51, g * 51, b * 51]);
    return p;
  }
  if (kind === 'uniform') {
    const n = Math.max(2, Math.floor(Math.cbrt(colors)));
    const p = [];
    for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++) p.push([r, g, b].map((v) => Math.round((v * 255) / (n - 1))));
    return p;
  }
  // adaptive / perceptual: median cut over sampled opaque pixels
  const n = img.width * img.height;
  const want = Math.min(n, 40000);
  const step = Math.max(1, Math.floor(n / want));
  const s = [];
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (d[i + 3] < 128) continue;
    if (kind === 'perceptual') {
      // count mid-tones and skin-ish colours twice: the eye notices them most
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (L > 40 && L < 220) s.push(d[i], d[i + 1], d[i + 2]);
    }
    s.push(d[i], d[i + 1], d[i + 2]);
  }
  if (!s.length) return [[0, 0, 0]];
  return medianCut(Uint8Array.from(s), Math.max(2, colors));
}

const BAYER8 = (() => {
  const m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return m.flat().map((v) => v / 64 - 0.5);
})();

/**
 * Reduce a picture to a palette. Returns { palette: [[r,g,b]…], indices: Uint8Array, transparent }
 * where `transparent` is the index of see-through pixels (-1 when `transparency` is off or none).
 * `matte`: colour mixed under half-transparent pixels.
 */
export function quantize(img, { colors = 256, palette = 'adaptive', dither = 'diffusion', amount = 100, transparency = true, matte = [255, 255, 255] } = {}) {
  const { width: w, height: h, data: src } = img;
  const n = w * h;
  // flatten half-transparent pixels onto the matte
  const d = new Float32Array(n * 3);
  let anyClear = false;
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3] / 255;
    if (a < 0.5) anyClear = true;
    for (let c = 0; c < 3; c++) d[i * 3 + c] = src[i * 4 + c] * a + matte[c] * (1 - a);
  }
  const reserve = transparency && anyClear ? 1 : 0;
  let pal = paletteFor(img, palette, Math.max(2, Math.min(256, colors) - reserve));
  if (pal.length > 256 - reserve) pal = pal.slice(0, 256 - reserve);
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      const dd = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };
  const k = amount / 100;
  const idx = new Uint8Array(n);
  const tIndex = reserve ? pal.length : -1;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (reserve && src[i * 4 + 3] < 128) {
        idx[i] = tIndex;
        continue;
      }
      let r = d[i * 3];
      let g = d[i * 3 + 1];
      let b = d[i * 3 + 2];
      if (dither === 'pattern') {
        const o = BAYER8[(y & 7) * 8 + (x & 7)] * 64 * k;
        r += o;
        g += o;
        b += o;
      } else if (dither === 'noise') {
        const o = rnd() * 64 * k;
        r += o;
        g += o;
        b += o;
      }
      const q = nearest(r | 0, g | 0, b | 0);
      idx[i] = q;
      if (dither === 'diffusion' && k > 0) {
        // Floyd–Steinberg: push the error to the neighbours not yet visited
        const p = pal[q];
        const er = (r - p[0]) * k;
        const eg = (g - p[1]) * k;
        const eb = (b - p[2]) * k;
        const spread = (j, f) => {
          d[j * 3] += er * f;
          d[j * 3 + 1] += eg * f;
          d[j * 3 + 2] += eb * f;
        };
        if (x + 1 < w) spread(i + 1, 7 / 16);
        if (y + 1 < h) {
          if (x > 0) spread(i + w - 1, 3 / 16);
          spread(i + w, 5 / 16);
          if (x + 1 < w) spread(i + w + 1, 1 / 16);
        }
      }
    }
  }
  const palette2 = reserve ? [...pal, [0, 0, 0]] : pal;
  return { palette: palette2, indices: idx, transparent: tIndex, width: w, height: h };
}

/** The reduced picture back as RGBA pixels (see-through stays see-through). */
export function indexedToImage(q) {
  const out = new ImageData(q.width, q.height);
  for (let i = 0; i < q.indices.length; i++) {
    const v = q.indices[i];
    if (v === q.transparent) continue;
    const p = q.palette[v];
    out.data[i * 4] = p[0];
    out.data[i * 4 + 1] = p[1];
    out.data[i * 4 + 2] = p[2];
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

export function gifBlob(q) {
  return encodeIndexedGif([{ indices: q.indices, delay: 0 }], q.palette, q.width, q.height, { transparent: q.transparent, loop: null });
}

// ---------------------------------------------------------------- PNG-8 (indexed PNG)

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An 8-bit palette PNG (with see-through pixels when the reduction has them). */
export async function png8Blob(q) {
  const { width: w, height: h } = q;
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(q.indices.subarray(y * w, y * w + w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = new Uint8Array(q.palette.length * 3);
  q.palette.forEach((p, i) => plte.set(p, i * 3));
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (q.transparent >= 0) {
    const trns = new Uint8Array(q.transparent + 1).fill(255);
    trns[q.transparent] = 0;
    parts.push(chunk('tRNS', trns));
  }
  parts.push(chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

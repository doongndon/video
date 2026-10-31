// Still more of Photoshop's Filter menu, registered into FILTERS like fx2.js / fx3.js:
//  흐림 효과 ▸ 모양 흐림 효과, 흐림 효과 갤러리 ▸ 필드 흐림 효과 / 경로 흐림 효과, 선명 효과 ▸ 흔들기 감소,
//  스타일화 ▸ 유화 (Photoshop's settings), 렌즈 교정 (one filter with all its sections),
//  and the filters of the Neural Filters dialog (피부를 매끄럽게, 깊이 흐림, JPEG 아티팩트 제거).
// All are our own approximations: similar looks from the same settings, not Photoshop's pixels.

import { FILTERS, keepOpaque } from './adjust.js';
import { mk, read, toCanvas, lum, cl, clamp, smooth, rng, blurred, sampler, mirrorPad } from './fxcore.js';
import { kuwahara, gaussF, sobelF, grayOf, boxBlurF } from './fxutil.js';

// ---------------------------------------------------------------- helpers

/** Run fn on a copy scaled by k (≤ 1), then scale the result back up to the original size. */
function atScale(c, k, fn) {
  if (k >= 0.999) return fn(c, 1);
  const s = mk(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const g = s.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, s.width, s.height);
  const r = fn(s, s.width / c.width);
  const out = mk(c.width, c.height);
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(r, 0, 0, out.width, out.height);
  return out;
}

/** Shape masks for Shape Blur (inside test on -1..1). */
const SHAPES = {
  circle: (x, y) => x * x + y * y <= 1,
  square: (x, y) => Math.abs(x) <= 0.85 && Math.abs(y) <= 0.85,
  diamond: (x, y) => Math.abs(x) + Math.abs(y) <= 1,
  triangle: (x, y) => y <= 0.8 && y >= 2 * Math.abs(x) - 1,
  hexagon: (x, y) => {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    return ay <= 0.866 && ax * 0.866 + ay * 0.5 <= 0.866;
  },
  star: (x, y) => {
    const r = Math.hypot(x, y);
    if (r > 1) return false;
    const a = Math.atan2(y, x) + Math.PI / 2;
    const k = (Math.cos(5 * a) + 1) / 2;
    return r <= 0.45 + 0.55 * k ** 2;
  },
  heart: (x, y) => {
    const X = x * 1.15;
    const Y = -y * 1.15 + 0.25;
    return (X * X + Y * Y - 0.6) ** 3 - X * X * Y ** 3 * 0.9 <= 0;
  },
  ring: (x, y) => {
    const r = Math.hypot(x, y);
    return r <= 1 && r >= 0.6;
  },
  snowflake: (x, y) => {
    const r = Math.hypot(x, y);
    if (r > 1) return false;
    const a = Math.atan2(y, x);
    const k = Math.abs(Math.cos(3 * a));
    return r < 0.25 || k > 0.9 - r * 0.15;
  },
};

/**
 * Convolve with a binary shape kernel of radius r: the kernel is split into its rows, each row a
 * horizontal box (prefix sums) moved vertically, so the cost grows with r, not r².
 */
function shapeConvolve(c, r, inside) {
  const img = read(c);
  const { width: w, height: h, data: d } = img;
  const R = Math.max(1, Math.round(r));
  const rows = [];
  let count = 0;
  for (let dy = -R; dy <= R; dy++) {
    let x0 = null;
    let x1 = null;
    for (let dx = -R; dx <= R; dx++) {
      if (inside(dx / R, dy / R)) {
        if (x0 == null) x0 = dx;
        x1 = dx;
      }
    }
    if (x0 != null) {
      rows.push([dy, x0, x1]);
      count += x1 - x0 + 1;
    }
  }
  if (!count) return c;
  const n = w * h;
  // premultiplied channels
  const ch = [0, 1, 2, 3].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    ch[0][i] = d[i * 4] * a;
    ch[1][i] = d[i * 4 + 1] * a;
    ch[2][i] = d[i * 4 + 2] * a;
    ch[3][i] = d[i * 4 + 3];
  }
  const acc = [0, 1, 2, 3].map(() => new Float32Array(n));
  const pre = new Float64Array(w + 1);
  for (let k = 0; k < 4; k++) {
    const src = ch[k];
    const dst = acc[k];
    for (let y = 0; y < h; y++) {
      // each kernel row adds a box sum from row y + dy into this row
      for (const [dy, x0, x1] of rows) {
        const sy = clamp(y + dy, 0, h - 1) * w;
        pre[0] = 0;
        for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[sy + x];
        for (let x = 0; x < w; x++) {
          const a = x + x0;
          const b = x + x1;
          // clamp at the edges: the edge pixel repeats
          let s = pre[clamp(b, -1, w - 1) + 1] - pre[clamp(a, 0, w)];
          if (a < 0) s += src[sy] * Math.min(-a, b - a + 1);
          if (b > w - 1) s += src[sy + w - 1] * Math.min(b - (w - 1), b - a + 1);
          dst[y * w + x] += s;
        }
      }
    }
  }
  const out = new ImageData(w, h);
  const inv = 1 / count;
  for (let i = 0; i < n; i++) {
    const a = acc[3][i] * inv;
    out.data[i * 4 + 3] = a;
    const k = a > 0.5 ? 255 / a : 0;
    out.data[i * 4] = cl(acc[0][i] * inv * k);
    out.data[i * 4 + 1] = cl(acc[1][i] * inv * k);
    out.data[i * 4 + 2] = cl(acc[2][i] * inv * k);
  }
  return toCanvas(out);
}

/** Self-guided filter (edge-preserving smoothing) of a float channel: radius r, eps (0..255² units). */
function guided(I, w, h, r, eps) {
  const mean = boxBlurF(I, w, h, r, 1);
  const sq = new Float32Array(I.length);
  for (let i = 0; i < I.length; i++) sq[i] = I[i] * I[i];
  const meanSq = boxBlurF(sq, w, h, r, 1);
  const A = new Float32Array(I.length);
  const B = new Float32Array(I.length);
  for (let i = 0; i < I.length; i++) {
    const v = meanSq[i] - mean[i] * mean[i];
    A[i] = v / (v + eps);
    B[i] = mean[i] * (1 - A[i]);
  }
  const mA = boxBlurF(A, w, h, r, 1);
  const mB = boxBlurF(B, w, h, r, 1);
  const out = new Float32Array(I.length);
  for (let i = 0; i < I.length; i++) out[i] = mA[i] * I[i] + mB[i];
  return out;
}

function channels(img) {
  const n = img.width * img.height;
  const d = img.data;
  const C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    C[0][i] = d[i * 4];
    C[1][i] = d[i * 4 + 1];
    C[2][i] = d[i * 4 + 2];
  }
  return C;
}

/** Skin likelihood 0..1 per pixel (YCbCr skin box, softened). */
function skinMask(img) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const Y = lum(r, g, b);
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const inCb = smooth(70, 80, cb) * (1 - smooth(124, 134, cb));
    const inCr = smooth(128, 138, cr) * (1 - smooth(170, 182, cr));
    M[i] = inCb * inCr * smooth(30, 60, Y) * (d[i * 4 + 3] / 255);
  }
  return gaussF(M, w, h, Math.max(1, Math.min(w, h) / 200));
}

/** The digital lines of direction θ through a w×h picture: slope, orientation and offsets. */
function strokeLines(w, h, theta) {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const horiz = Math.abs(c) >= Math.abs(sn);
  const m = horiz ? sn / c : c / sn;
  const len = horiz ? w : h;
  const span = horiz ? h : w;
  const off = new Int32Array(len);
  for (let t = 0; t < len; t++) off[t] = Math.round(t * m);
  return { horiz, m, len, span, off, lo: Math.min(0, off[len - 1]), hi: Math.max(0, off[len - 1]) };
}
/** The stretch [t0, t1] of line `base` inside the picture (off is monotonic), or null. */
function lineRange(L, base) {
  const { len, span, off, m } = L;
  let t0;
  let t1;
  if (m === 0) {
    if (base < 0 || base >= span) return null;
    return [0, len - 1];
  }
  const a = (-base - 0.5) / m;
  const b = (span - 0.5 - base) / m;
  t0 = Math.max(0, Math.floor(Math.min(a, b)) - 1);
  t1 = Math.min(len - 1, Math.ceil(Math.max(a, b)) + 1);
  const inside = (t) => base + off[t] >= 0 && base + off[t] < span;
  while (t0 <= t1 && !inside(t0)) t0++;
  while (t1 >= t0 && !inside(t1)) t1--;
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * Oil paint strokes: for the pixels whose stroke angle (A, 0..π) is near direction bin `b` of
 * `bins`, add the average of `src` along that direction over ±half pixels, weighted by closeness to
 * the bin, into `acc`. Runs along the digital lines of the direction with prefix sums, so the
 * stroke length costs nothing. Two versions: RGBA bytes and one float channel.
 */
function accumRGBA(src, w, h, A, b, bins, half, acc) {
  const L = strokeLines(w, h, (b * Math.PI) / bins);
  const { horiz, len, off } = L;
  const steps = Math.max(1, Math.round(half / Math.sqrt(1 + L.m * L.m)));
  const pre = new Float64Array((len + 1) * 4);
  const idx = new Int32Array(len);
  const binW = Math.PI / bins;
  for (let base = -L.hi; base < L.span - L.lo; base++) {
    const r = lineRange(L, base);
    if (!r) continue;
    const [t0, t1] = r;
    for (let t = t0; t <= t1; t++) {
      const q = base + off[t];
      const i = horiz ? q * w + t : t * w + q;
      idx[t] = i;
      const k = (t - t0) * 4;
      const s = i * 4;
      pre[k + 4] = pre[k] + src[s];
      pre[k + 5] = pre[k + 1] + src[s + 1];
      pre[k + 6] = pre[k + 2] + src[s + 2];
      pre[k + 7] = pre[k + 3] + src[s + 3];
    }
    for (let t = t0; t <= t1; t++) {
      const i = idx[t];
      let f = A[i] / binW - b;
      if (f > bins / 2) f -= bins;
      else if (f < -bins / 2) f += bins;
      const wgt = 1 - (f < 0 ? -f : f);
      if (wgt <= 0) continue;
      const a = t - steps > t0 ? t - steps : t0;
      const e = t + steps < t1 ? t + steps : t1;
      const k = wgt / (e - a + 1);
      const pa = (a - t0) * 4;
      const pe = (e - t0 + 1) * 4;
      const o = i * 4;
      acc[o] += (pre[pe] - pre[pa]) * k;
      acc[o + 1] += (pre[pe + 1] - pre[pa + 1]) * k;
      acc[o + 2] += (pre[pe + 2] - pre[pa + 2]) * k;
      acc[o + 3] += (pre[pe + 3] - pre[pa + 3]) * k;
    }
  }
}
function accum1(src, w, h, A, b, bins, half, acc) {
  const L = strokeLines(w, h, (b * Math.PI) / bins);
  const { horiz, len, off } = L;
  const steps = Math.max(1, Math.round(half / Math.sqrt(1 + L.m * L.m)));
  const pre = new Float64Array(len + 1);
  const idx = new Int32Array(len);
  const binW = Math.PI / bins;
  for (let base = -L.hi; base < L.span - L.lo; base++) {
    const r = lineRange(L, base);
    if (!r) continue;
    const [t0, t1] = r;
    for (let t = t0; t <= t1; t++) {
      const q = base + off[t];
      const i = horiz ? q * w + t : t * w + q;
      idx[t] = i;
      pre[t - t0 + 1] = pre[t - t0] + src[i];
    }
    for (let t = t0; t <= t1; t++) {
      const i = idx[t];
      let f = A[i] / binW - b;
      if (f > bins / 2) f -= bins;
      else if (f < -bins / 2) f += bins;
      const wgt = 1 - (f < 0 ? -f : f);
      if (wgt <= 0) continue;
      const a = t - steps > t0 ? t - steps : t0;
      const e = t + steps < t1 ? t + steps : t1;
      acc[i] += ((pre[e - t0 + 1] - pre[a - t0]) * wgt) / (e - a + 1);
    }
  }
}


// ---------------------------------------------------------------- filters

const F = {
  shapeBlur: {
    name: '모양 흐림 효과', group: '흐림 효과', slow: true,
    params: [['radius', '반경 (픽셀)', 5, 1000, 10], ['shape', '모양', null, null, 'circle', [['circle', '원'], ['heart', '하트'], ['star', '별'], ['square', '사각형'], ['diamond', '다이아몬드'], ['triangle', '삼각형'], ['hexagon', '육각형'], ['ring', '고리'], ['snowflake', '눈송이']]]],
    fn(c, p) {
      const r = clamp(+p.radius || 5, 1, 1000);
      const inside = SHAPES[p.shape] || SHAPES.circle;
      // a large radius works on a smaller copy (the kernel keeps about 12 pixels of detail)
      const k = Math.min(1, 12 / r);
      return atScale(c, k, (s, kk) => shapeConvolve(s, r * kk, inside));
    },
  },
  fieldBlur: {
    name: '필드 흐림 효과', group: '흐림 효과 갤러리', slow: true,
    params: [['blur1', '핀 1: 흐림 효과 (픽셀)', 0, 500, 15], ['x1', '핀 1: 가로 (%)', 0, 100, 50], ['y1', '핀 1: 세로 (%)', 0, 100, 20],
      ['two', '핀 2 사용', null, null, false, 'bool'], ['blur2', '핀 2: 흐림 효과 (픽셀)', 0, 500, 0], ['x2', '핀 2: 가로 (%)', 0, 100, 50], ['y2', '핀 2: 세로 (%)', 0, 100, 80],
      ['bokeh', '빛 보케 (%)', 0, 100, 0], ['bokehRange', '광원 범위 (밝기 한계값)', 0, 255, 191]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const b1 = +p.blur1 || 0;
      const b2 = p.two ? +p.blur2 || 0 : b1;
      const maxB = Math.max(b1, b2);
      // bright spots bloom into discs: boost them before blurring
      let src = c;
      if (p.bokeh > 0) {
        const img = read(c);
        const d = img.data;
        const k = 1 + (p.bokeh / 100) * 1.5;
        for (let i = 0; i < d.length; i += 4) {
          if (lum(d[i], d[i + 1], d[i + 2]) < p.bokehRange) continue;
          for (let ch = 0; ch < 3; ch++) d[i + ch] = cl(d[i + ch] * k);
        }
        src = toCanvas(img);
      }
      if (!p.two || Math.abs(b1 - b2) < 0.5) return blurred(src, b1 / 2);
      // blur amounts change along the line from pin 1 to pin 2: blend a few blur levels
      const levels = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxB);
      const imgs = levels.map((r) => read(r > 0.3 ? blurred(src, r / 2) : src).data);
      const ax = (w * p.x1) / 100;
      const ay = (h * p.y1) / 100;
      const bx = (w * p.x2) / 100;
      const by = (h * p.y2) / 100;
      const vx = bx - ax;
      const vy = by - ay;
      const L2 = vx * vx + vy * vy || 1;
      const out = new ImageData(w, h);
      const o = out.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = clamp(((x - ax) * vx + (y - ay) * vy) / L2, 0, 1);
          const r = (b1 + (b2 - b1) * t) / Math.max(1e-6, maxB);
          const f = r * (levels.length - 1);
          const i0 = Math.min(levels.length - 2, Math.floor(f));
          const ft = f - i0;
          const k = (y * w + x) * 4;
          for (let ch = 0; ch < 4; ch++) o[k + ch] = imgs[i0][k + ch] * (1 - ft) + imgs[i0 + 1][k + ch] * ft;
        }
      }
      return toCanvas(out);
    },
  },
  pathBlur: {
    name: '경로 흐림 효과', group: '흐림 효과 갤러리', slow: true,
    params: [['speed', '속도 (%)', 0, 500, 50], ['taper', '가늘게 (%)', 0, 100, 0], ['centered', '중앙 흐림 효과', null, null, true, 'bool'],
      ['x1', '경로 시작: 가로 (%)', 0, 100, 35], ['y1', '경로 시작: 세로 (%)', 0, 100, 50], ['x2', '경로 끝: 가로 (%)', 0, 100, 65], ['y2', '경로 끝: 세로 (%)', 0, 100, 50], ['bend', '경로 굽힘', -100, 100, 0]],
    fn(c, p) {
      // every pixel is smeared along the same curved path (as if the camera moved along it)
      const w = c.width;
      const h = c.height;
      const ax = (w * p.x1) / 100;
      const ay = (h * p.y1) / 100;
      const bx = (w * p.x2) / 100;
      const by = (h * p.y2) / 100;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1 || !(p.speed > 0)) return c;
      const k = p.speed / 100;
      // control point: off the middle of the line, perpendicular, by `bend`
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      const cx = (ax + bx) / 2 + nx * len * (p.bend / 100) * 0.5;
      const cy = (ay + by) / 2 + ny * len * (p.bend / 100) * 0.5;
      const N = clamp(Math.round(len * k * 0.6), 2, 64);
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx;
        const y = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by;
        pts.push([(x - ax) * k, (y - ay) * k, 1 - (p.taper / 100) * t]);
      }
      if (p.centered) {
        const [mx, my] = pts[Math.floor(N / 2)];
        for (const q of pts) {
          q[0] -= mx;
          q[1] -= my;
        }
      }
      const pad = Math.ceil(Math.max(...pts.map(([x, y]) => Math.hypot(x, y)))) + 2;
      const { canvas: big, pad: pp } = mirrorPad(c, pad);
      const acc = mk(big.width, big.height);
      const g = acc.getContext('2d');
      let wsum = 0;
      for (const [x, y, wt] of pts) {
        if (wt <= 0) continue;
        wsum += wt;
        // a running weighted average of the moved copies
        g.globalAlpha = wt / wsum;
        g.drawImage(big, -x, -y);
      }
      const out = mk(w, h);
      out.getContext('2d').drawImage(acc, -pp, -pp);
      return keepOpaque(c, out);
    },
  },
  shakeReduction: {
    name: '흔들기 감소', group: '선명 효과', slow: true,
    params: [['bounds', '흐림 효과 추적 경계 (픽셀)', 1, 100, 10], ['smooth', '매끄럽게 (%)', 0, 100, 30], ['artifacts', '가공 효과 억제 (%)', 0, 100, 30]],
    fn(c, p) {
      // the blur direction is where the picture has the weakest gradients: sharpen along it
      const img = read(c);
      const { width: w, height: h } = img;
      const L = grayOf(img);
      const { gx, gy } = sobelF(gaussF(L, w, h, 1), w, h);
      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (let i = 0; i < gx.length; i += 3) {
        xx += gx[i] * gx[i];
        xy += gx[i] * gy[i];
        yy += gy[i] * gy[i];
      }
      // the minor eigenvector of the structure tensor
      const theta = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
      const angle = (-theta * 180) / Math.PI;
      const sharp = FILTERS.smartSharpen?.fn;
      if (!sharp) return c;
      let out = sharp(c, { amount: 100 + (100 - p.artifacts) * 1.2, radius: Math.max(0.5, p.bounds / 4), noise: p.smooth / 3, remove: 'motion', angle, shadows: 0, highlights: 0 });
      if (p.smooth > 0) {
        // a light edge-preserving pass takes the grain back out
        const im = read(out);
        const C = channels(im);
        const eps = (2 + p.smooth / 6) ** 2;
        const S = C.map((a) => guided(a, w, h, 1, eps));
        for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) im.data[i * 4 + ch] = cl(S[ch][i]);
        out = toCanvas(im);
      }
      return out;
    },
  },
  oil: {
    name: '유화', group: '스타일화', slow: true,
    params: [['stylization', '브러시: 양식화', 0.1, 10, 2.5, 0.1], ['cleanliness', '브러시: 청결도', 0, 10, 4, 0.1], ['scale', '브러시: 비율', 0.1, 10, 0.6, 0.1], ['bristle', '브러시: 세부 사항 비율', 0, 10, 3, 0.1],
      ['lighting', '조명', null, null, true, 'bool'], ['angle', '조명: 각도 (°)', -180, 180, -60], ['shine', '조명: 광택', 0, 10, 1.5, 0.1]],
    fn(c, p) {
      if (p.stylization == null && p.radius != null) {
        // older documents: the first version's settings
        return FILTERS.oilLegacy ? FILTERS.oilLegacy.fn(c, p) : c;
      }
      const w = c.width;
      const h = c.height;
      const n = w * h;
      const sc = clamp(p.scale ?? 0.6, 0.1, 10);
      // sizes follow the picture (a big photo gets proportionally big strokes)
      const sizeK = Math.max(1, Math.min(w, h) / 600);
      const ks = 1 / sizeK;
      // 1. flat painterly patches with crisp borders (on a copy about 600 px on its short side)
      const kr = Math.max(1, Math.round((1 + (p.stylization ?? 2.5) * 0.6) * (0.6 + sc * 0.5)));
      const flat = atScale(c, ks, (s) => toCanvas(kuwahara(read(s), kr)));
      // 2. stroke direction: along the edges (structure tensor), as doubled angles so it interpolates
      const sw = Math.max(1, Math.round(w * ks));
      const shh = Math.max(1, Math.round(h * ks));
      const small = mk(sw, shh);
      small.getContext('2d').drawImage(flat, 0, 0, sw, shh);
      const Ls = grayOf(read(small));
      const { gx, gy } = sobelF(gaussF(Ls, sw, shh, 1 + sc * 0.5), sw, shh);
      const N = sw * shh;
      const Jxx = new Float32Array(N);
      const Jxy = new Float32Array(N);
      const Jyy = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        Jxx[i] = gx[i] * gx[i];
        Jxy[i] = gx[i] * gy[i];
        Jyy[i] = gy[i] * gy[i];
      }
      const sig = 2 + sc * 2;
      const Sxx = gaussF(Jxx, sw, shh, sig);
      const Sxy = gaussF(Jxy, sw, shh, sig);
      const Syy = gaussF(Jyy, sw, shh, sig);
      // the stroke angle (0..π) per full-size pixel, from the small field
      const A = new Float32Array(n);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(shh - 1, Math.floor(y * ks));
        for (let x = 0; x < w; x++) {
          const j = sy * sw + Math.min(sw - 1, Math.floor(x * ks));
          let t = 0.5 * Math.atan2(2 * Sxy[j], Sxx[j] - Syy[j]) + Math.PI / 2;
          if (t < 0) t += Math.PI;
          if (t >= Math.PI) t -= Math.PI;
          A[y * w + x] = t;
        }
      }
      // 3. smear colours and a bristle texture along the strokes (cleanliness = stroke length):
      //    each pixel mixes the two nearest of eight stroke directions
      const len = Math.max(2, (2 + (p.cleanliness ?? 4) * 2.2) * (0.5 + sc * 0.5) * sizeK);
      const r0 = rng(17);
      const noise = new Float32Array(n);
      for (let i = 0; i < n; i++) noise[i] = r0();
      const fd = read(flat).data;
      const BINS = 8;
      const col = new Float32Array(n * 4);
      const tex = new Float32Array(n);
      for (let b = 0; b < BINS; b++) {
        accumRGBA(fd, w, h, A, b, BINS, len / 2, col);
        accum1(noise, w, h, A, b, BINS, len * 0.45 + 1, tex);
      }
      // 4. light on the paint: a relief from the brightness and the bristles
      const out = new ImageData(w, h);
      const o = out.data;
      const bristle = (p.bristle ?? 3) / 10;
      if (!p.lighting) {
        for (let i = 0; i < n * 4; i++) o[i] = cl(col[i]);
        return toCanvas(out);
      }
      const H = new Float32Array(n);
      for (let i = 0; i < n; i++) H[i] = (lum(col[i * 4], col[i * 4 + 1], col[i * 4 + 2]) / 255) * 0.6 + (tex[i] - 0.5) * 6 * bristle;
      const { gx: hx, gy: hy } = sobelF(gaussF(H, w, h, 0.7), w, h);
      const a = ((p.angle ?? -60) * Math.PI) / 180;
      const lx = Math.cos(a);
      const ly = -Math.sin(a);
      const shine = (p.shine ?? 1.5) / 10;
      const depth = 3 * sizeK ** 0.5;
      for (let i = 0; i < n; i++) {
        const nx = -hx[i] * depth;
        const ny = -hy[i] * depth;
        const nl = Math.hypot(nx, ny, 1);
        const lambert = (nx * lx + ny * ly + 0.6) / nl / 0.6;
        const spec = Math.max(0, lambert - 1) ** 2 * shine * 160;
        const k = 0.75 + 0.25 * lambert;
        const j = i * 4;
        o[j] = cl(col[j] * k + spec);
        o[j + 1] = cl(col[j + 1] * k + spec);
        o[j + 2] = cl(col[j + 2] * k + spec);
        o[j + 3] = cl(col[j + 3]);
      }
      return toCanvas(out);
    },
  },
  lensCorrection: {
    name: '렌즈 교정', group: '렌즈 교정', slow: true, dialog: 'lens',
    params: [
      ['distortion', '기하학적 왜곡 제거 (+ 술통형 / − 핀쿠션형)', -100, 100, 0],
      ['ca', '색수차: 빨강/녹청 언저리 수정', -100, 100, 0], ['caGM', '색수차: 녹색/마젠타 언저리 수정', -100, 100, 0], ['caBY', '색수차: 파랑/노랑 언저리 수정', -100, 100, 0],
      ['vignette', '비네팅: 양 (− 어둡게 / + 밝게)', -100, 100, 0], ['midpoint', '비네팅: 중간점', 0, 100, 50],
      ['vPersp', '변형: 세로 원근', -100, 100, 0], ['hPersp', '변형: 가로 원근', -100, 100, 0], ['angle', '변형: 각도 (°)', -180, 180, 0], ['scale', '변형: 비율 (%)', 50, 150, 100],
      ['edge', '가장자리', null, null, 'edge', [['edge', '가장자리 확장'], ['transparent', '투명도'], ['black', '검정'], ['white', '흰색']]],
    ],
    fn(c, p) {
      const src = read(c);
      const { width: w, height: h, data: d } = src;
      const out = new ImageData(w, h);
      const o = out.data;
      const s = sampler(d, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.hypot(cx, cy);
      const k = -(p.distortion || 0) / 250;
      const sc = 100 / (p.scale || 100);
      const ang = (-(p.angle || 0) * Math.PI) / 180;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const vp = (p.vPersp || 0) / 200;
      const hp = (p.hPersp || 0) / 200;
      // per channel scale for colour fringes (red/cyan, green/magenta, blue/yellow)
      const kr = 1 + (p.ca || 0) / 4000 - (p.caGM || 0) / 8000;
      const kg = 1 + (p.caGM || 0) / 4000;
      const kb = 1 + (p.caBY || 0) / 4000 - (p.caGM || 0) / 8000;
      const vig = (p.vignette || 0) / 100;
      const mid = 0.2 + ((p.midpoint ?? 50) / 100) * 0.75;
      const edge = p.edge || 'edge';
      const fill = edge === 'black' ? [0, 0, 0, 255] : edge === 'white' ? [255, 255, 255, 255] : [0, 0, 0, 0];
      const tmp = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // undo the transform: scale, angle, then the perspective keystone
          let ux = (x + 0.5 - cx) * sc;
          let uy = (y + 0.5 - cy) * sc;
          const rx = ux * ca - uy * sa;
          const ry = ux * sa + uy * ca;
          ux = rx;
          uy = ry;
          // vertical perspective: rows narrow toward the top (positive) or bottom
          const fy = 1 + vp * (uy / cy);
          const fx = 1 + hp * (ux / cx);
          ux *= fy;
          uy *= fx;
          const r2 = (ux * ux + uy * uy) / (R * R);
          const f = 1 + k * r2;
          const i = (y * w + x) * 4;
          let outside = false;
          for (let ch = 0; ch < 3; ch++) {
            const kk = ch === 0 ? kr : ch === 1 ? kg : kb;
            const sx = cx + ux * f * kk;
            const sy = cy + uy * f * kk;
            if (edge !== 'edge' && (sx < 0 || sy < 0 || sx > w || sy > h)) {
              outside = true;
              break;
            }
            s(sx - 0.5, sy - 0.5, tmp, 0);
            o[i + ch] = tmp[ch];
            if (ch === 1) o[i + 3] = tmp[3];
          }
          if (outside) {
            o[i] = fill[0];
            o[i + 1] = fill[1];
            o[i + 2] = fill[2];
            o[i + 3] = fill[3];
            continue;
          }
          if (vig) {
            const rr = Math.sqrt(((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (R * R));
            const t = smooth(mid * 0.6, 1.05, rr);
            const m = 1 + vig * t * 0.9;
            for (let ch = 0; ch < 3; ch++) o[i + ch] = cl(vig > 0 ? o[i + ch] + (255 - o[i + ch]) * vig * t * 0.8 : o[i + ch] * m);
          }
        }
      }
      return toCanvas(out);
    },
  },

  // ---- neural filters (our own non-AI approximations, in the Neural Filters dialog)
  skinSmoothing: {
    name: '피부를 매끄럽게', group: '뉴럴 필터', neural: true, slow: true,
    params: [['blur', '흐림 효과', 0, 100, 50], ['smoothness', '매끄러움', -50, 50, 0]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const M = skinMask(img);
      const C = channels(img);
      const r = Math.max(2, Math.round((Math.min(w, h) / 220) * (0.6 + (p.blur ?? 50) / 50)));
      const eps = (6 + (((p.smoothness ?? 0) + 50) / 100) * 22) ** 2;
      const S = C.map((a) => guided(a, w, h, r, eps));
      const amt = (p.blur ?? 50) / 100;
      for (let i = 0; i < w * h; i++) {
        const k = M[i] * Math.min(1, amt * 1.4);
        if (k <= 0.001) continue;
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = cl(C[ch][i] + (S[ch][i] - C[ch][i]) * k);
      }
      return toCanvas(img);
    },
  },
  depthBlur: {
    name: '깊이 흐림', group: '뉴럴 필터', neural: true, slow: true,
    params: [['fx', '초점 위치: 가로 (%)', 0, 100, 50], ['fy', '초점 위치: 세로 (%)', 0, 100, 50], ['range', '초점 범위', 0, 100, 50], ['blur', '흐림 효과 강도', 0, 100, 50],
      ['haze', '연무', 0, 100, 0], ['temp', '색온도', -50, 50, 0], ['tint', '색조', -50, 50, 0], ['saturation', '채도', -50, 50, 0], ['brightness', '명도', -50, 50, 0], ['grain', '그레인', 0, 100, 0]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      // "depth": how hard it is to walk from the focus point to each pixel through similar colours
      const S = 140 / Math.max(w, h);
      const sw = Math.max(2, Math.round(w * Math.min(1, S)));
      const sh = Math.max(2, Math.round(h * Math.min(1, S)));
      const small = mk(sw, sh);
      const sg = small.getContext('2d', { willReadFrequently: true });
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(c, 0, 0, sw, sh);
      const sd = sg.getImageData(0, 0, sw, sh).data;
      const N = sw * sh;
      const dist = new Float64Array(N).fill(Infinity);
      const fx = clamp(Math.round(((p.fx ?? 50) / 100) * (sw - 1)), 0, sw - 1);
      const fy = clamp(Math.round(((p.fy ?? 50) / 100) * (sh - 1)), 0, sh - 1);
      const heap = [];
      const push = (i, v) => {
        heap.push([v, i]);
        let j = heap.length - 1;
        while (j > 0) {
          const pa = (j - 1) >> 1;
          if (heap[pa][0] <= heap[j][0]) break;
          [heap[pa], heap[j]] = [heap[j], heap[pa]];
          j = pa;
        }
      };
      const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let j = 0;
          for (;;) {
            const l = 2 * j + 1;
            const r = l + 1;
            let m = j;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if (m === j) break;
            [heap[m], heap[j]] = [heap[j], heap[m]];
            j = m;
          }
        }
        return top;
      };
      const start = fy * sw + fx;
      dist[start] = 0;
      push(start, 0);
      while (heap.length) {
        const [dv, i] = pop();
        if (dv > dist[i]) continue;
        const x = i % sw;
        const y = (i / sw) | 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const j = ny * sw + nx;
          const cd = Math.abs(sd[i * 4] - sd[j * 4]) + Math.abs(sd[i * 4 + 1] - sd[j * 4 + 1]) + Math.abs(sd[i * 4 + 2] - sd[j * 4 + 2]);
          const nd = dv + 1 + cd * 0.15;
          if (nd < dist[j]) {
            dist[j] = nd;
            push(j, nd);
          }
        }
      }
      let mx = 0;
      for (let i = 0; i < N; i++) if (dist[i] > mx && Number.isFinite(dist[i])) mx = dist[i];
      // depth 0..1, smoothed, with the in-focus range kept sharp
      const D = new Float32Array(N);
      const rangeT = 0.05 + ((p.range ?? 50) / 100) * 0.6;
      for (let i = 0; i < N; i++) D[i] = smooth(rangeT * 0.6, rangeT + 0.25, (Number.isFinite(dist[i]) ? dist[i] : mx) / (mx || 1));
      const Ds = gaussF(D, sw, sh, 1.5);
      const dc = mk(sw, sh);
      const dimg = new ImageData(sw, sh);
      for (let i = 0; i < N; i++) {
        const v = Ds[i] * 255;
        dimg.data[i * 4] = dimg.data[i * 4 + 1] = dimg.data[i * 4 + 2] = v;
        dimg.data[i * 4 + 3] = 255;
      }
      dc.getContext('2d').putImageData(dimg, 0, 0);
      const big = mk(w, h);
      const bgc = big.getContext('2d', { willReadFrequently: true });
      bgc.imageSmoothingQuality = 'high';
      bgc.drawImage(dc, 0, 0, w, h);
      const depth = bgc.getImageData(0, 0, w, h).data;
      // blend between a few blur levels by depth
      const maxR = (Math.max(w, h) / 90) * ((p.blur ?? 50) / 50);
      const lv = [0, 0.33, 0.66, 1].map((t) => t * maxR);
      const L = lv.map((r) => read(r > 0.3 ? blurred(c, r) : c).data);
      const img = read(c);
      const d = img.data;
      const haze = (p.haze || 0) / 100;
      const wbR = 1 + (p.temp || 0) / 200 + (p.tint || 0) / 400;
      const wbG = 1 - (p.tint || 0) / 200;
      const wbB = 1 - (p.temp || 0) / 200 + (p.tint || 0) / 400;
      const satK = 1 + (p.saturation || 0) / 50;
      const bri = (p.brightness || 0) * 1.2;
      const rg = rng(5);
      const grain = (p.grain || 0) * 0.4;
      for (let i = 0; i < w * h; i++) {
        const t = depth[i * 4] / 255;
        const f = t * (lv.length - 1);
        const i0 = Math.min(lv.length - 2, Math.floor(f));
        const ft = f - i0;
        const k = i * 4;
        let r = L[i0][k] * (1 - ft) + L[i0 + 1][k] * ft;
        let g = L[i0][k + 1] * (1 - ft) + L[i0 + 1][k + 1] * ft;
        let b = L[i0][k + 2] * (1 - ft) + L[i0 + 1][k + 2] * ft;
        // the far part only: haze, colour and brightness
        r = r * (1 + (wbR - 1) * t) + bri * t;
        g = g * (1 + (wbG - 1) * t) + bri * t;
        b = b * (1 + (wbB - 1) * t) + bri * t;
        const Y = lum(r, g, b);
        const sk = 1 + (satK - 1) * t;
        r = Y + (r - Y) * sk;
        g = Y + (g - Y) * sk;
        b = Y + (b - Y) * sk;
        if (haze) {
          const hz = haze * t * 0.8;
          r += (225 - r) * hz;
          g += (228 - g) * hz;
          b += (232 - b) * hz;
        }
        if (grain) {
          const n = (rg() - 0.5) * grain * t;
          r += n;
          g += n;
          b += n;
        }
        d[k] = cl(r);
        d[k + 1] = cl(g);
        d[k + 2] = cl(b);
      }
      return toCanvas(img);
    },
  },
  jpegArtifacts: {
    name: 'JPEG 아티팩트 제거', group: '뉴럴 필터', neural: true, slow: true,
    params: [['strength', '강도', null, null, 'medium', [['low', '낮음'], ['medium', '중간'], ['high', '높음']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const st = { low: 0.5, medium: 1, high: 1.6 }[p.strength] || 1;
      const T = 10 + 14 * st;
      // deblocking: soften small steps at the 8-pixel block borders (big steps are real edges)
      const C = channels(img);
      for (const a of C) {
        for (let y = 0; y < h; y++) {
          for (let x = 8; x < w - 2; x += 8) {
            const i = y * w + x;
            const step = a[i] - a[i - 1];
            if (Math.abs(step) >= T) continue;
            const k = (1 - Math.abs(step) / T) * Math.min(1, st);
            a[i - 2] += (step / 6) * k;
            a[i - 1] += (step / 3) * k;
            a[i] -= (step / 3) * k;
            a[i + 1] -= (step / 6) * k;
          }
        }
        for (let y = 8; y < h - 2; y += 8) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const step = a[i] - a[i - w];
            if (Math.abs(step) >= T) continue;
            const k = (1 - Math.abs(step) / T) * Math.min(1, st);
            a[i - 2 * w] += (step / 6) * k;
            a[i - w] += (step / 3) * k;
            a[i] -= (step / 3) * k;
            a[i + w] -= (step / 6) * k;
          }
        }
      }
      // ringing ("mosquito noise") near edges: an edge-preserving smoothing pass
      const eps = (4 + 6 * st) ** 2;
      const S = C.map((a) => guided(a, w, h, 1 + Math.round(st), eps));
      for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = cl(C[ch][i] + (S[ch][i] - C[ch][i]) * Math.min(1, 0.4 * st));
      return toCanvas(img);
    },
  },
};

// the first Oil Paint (still used by older documents and recorded actions)
if (FILTERS.oil) F.oilLegacy = { ...FILTERS.oil, name: '유화 (이전 버전)', hidden: true };

Object.assign(FILTERS, F);

export { shapeConvolve, guided, skinMask, atScale };

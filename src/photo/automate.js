// File ▸ Automate: Crop and Straighten Photos (several scanned photos on a plain background, each
// opened as its own straightened document) and Photomerge (two or more overlapping photos lined up
// with feature matching — corners, binary descriptors, RANSAC — and blended into one panorama).

import { h } from '../util.js';
import { toast, openModal, formRow } from '../ui/common.js';
import { makeCanvas, newLayer, PhotoDoc } from './doc.js';

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** A canvas shrunk so its long side is at most `max` (the scale used too). */
function shrink(c, max) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * k));
  const hh = Math.max(1, Math.round(c.height * k));
  const t = makeCanvas(w, hh);
  const g = t.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, w, hh);
  return { canvas: t, k, w, h: hh, data: g.getImageData(0, 0, w, hh).data };
}

// ---------------------------------------------------------------- crop and straighten photos

/** Smallest-area rotated rectangle around points: { angle (rad), cx, cy, w, h }. */
function minAreaRect(pts) {
  const area = (a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * c + pts[i + 1] * s;
      const y = -pts[i] * s + pts[i + 1] * c;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { a, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
  };
  let best = area(0);
  for (let d = -45; d <= 45; d += 1) {
    const r = area((d * Math.PI) / 180);
    if (r.area < best.area - 1e-9) best = r;
  }
  // finer around the best angle
  const a0 = best.a;
  for (let d = -1; d <= 1; d += 0.05) {
    const r = area(a0 + (d * Math.PI) / 180);
    if (r.area < best.area - 1e-9) best = r;
  }
  const c = Math.cos(best.a);
  const s = Math.sin(best.a);
  const mx = (best.x0 + best.x1) / 2;
  const my = (best.y0 + best.y1) / 2;
  return { angle: best.a, cx: mx * c - my * s, cy: mx * s + my * c, w: best.x1 - best.x0, h: best.y1 - best.y0 };
}

/**
 * Find separate photos on a plain background (a scan): [{ angle, cx, cy, w, h }] in the source's
 * pixels, biggest first.
 */
export function findPhotos(src) {
  const S = shrink(src, 900);
  const { w, h: hh, data: d } = S;
  const n = w * hh;
  // the background: the median colour of the border
  const ring = [[], [], []];
  const take = (x, y) => {
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) ring[k].push(d[i + k]);
  };
  for (let x = 0; x < w; x += 2) {
    take(x, 0);
    take(x, hh - 1);
  }
  for (let y = 0; y < hh; y += 2) {
    take(0, y);
    take(w - 1, y);
  }
  const med = ring.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  // how much the border itself varies (paper grain, scanner noise) sets the threshold
  let dev = 0;
  for (let i = 0; i < ring[0].length; i++) dev += Math.abs(ring[0][i] - med[0]) + Math.abs(ring[1][i] - med[1]) + Math.abs(ring[2][i] - med[2]);
  dev /= Math.max(1, ring[0].length);
  const th = Math.max(30, Math.min(90, dev * 3 + 18));
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < 32) continue;
    const dd = Math.abs(d[o] - med[0]) + Math.abs(d[o + 1] - med[1]) + Math.abs(d[o + 2] - med[2]);
    if (dd > th) fg[i] = 1;
  }
  // close small gaps (a white area inside a photo touching its edge), then fill holes
  const r = 2;
  const grow = (a, val) => {
    const out = new Uint8Array(a);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        if (a[y * w + x] === val) continue;
        let hit = false;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= hh) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && a[yy * w + xx] === val) {
              hit = true;
              break;
            }
          }
        }
        if (hit) out[y * w + x] = val;
      }
    }
    return out;
  };
  let m = grow(fg, 1);
  m = grow(m, 0);
  // holes: background not reachable from the border
  const outside = new Uint8Array(n);
  const stack = [];
  const push = (i) => {
    if (!m[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((hh - 1) * w + x);
  }
  for (let y = 0; y < hh; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  for (let i = 0; i < n; i++) if (!outside[i]) m[i] = 1;
  // connected pieces
  const label = new Int32Array(n).fill(-1);
  const found = [];
  for (let s = 0; s < n; s++) {
    if (!m[s] || label[s] >= 0) continue;
    const id = found.length;
    const q = [s];
    label[s] = id;
    let count = 0;
    const edge = [];
    while (q.length) {
      const i = q.pop();
      count++;
      const x = i % w;
      const y = (i - x) / w;
      let border = false;
      for (const [j, ok] of [[i - 1, x > 0], [i + 1, x < w - 1], [i - w, y > 0], [i + w, y < hh - 1]]) {
        if (!ok || !m[j]) {
          border = true;
          continue;
        }
        if (label[j] < 0) {
          label[j] = id;
          q.push(j);
        }
      }
      if (border) edge.push(x + 0.5, y + 0.5);
    }
    found.push({ count, edge });
  }
  const minArea = Math.max(400, n * 0.01);
  const out = [];
  for (const f of found) {
    if (f.count < minArea) continue;
    const rr = minAreaRect(f.edge);
    // in source pixels, a little inside so no background shows at the edges
    const k = S.k;
    const inset = 1.5;
    const W = (rr.w - inset * 2) / k;
    const H = (rr.h - inset * 2) / k;
    if (W < 16 || H < 16) continue;
    // a photo is roughly as wide as its rectangle: mostly filled, not a thin line or a blob
    if (f.count < rr.w * rr.h * 0.55) continue;
    let angle = rr.angle;
    let pw = W;
    let ph = H;
    // keep the photo upright: turns of more than 45° are a portrait / landscape swap
    if (angle > Math.PI / 4) {
      angle -= Math.PI / 2;
      [pw, ph] = [ph, pw];
    } else if (angle < -Math.PI / 4) {
      angle += Math.PI / 2;
      [pw, ph] = [ph, pw];
    }
    out.push({ angle, cx: rr.cx / k, cy: rr.cy / k, w: pw, h: ph, area: f.count });
  }
  return out.sort((a, b) => b.area - a.area);
}

/** One found photo cut out of the source and turned straight. */
export function extractPhoto(src, p) {
  const W = Math.max(1, Math.round(p.w));
  const H = Math.max(1, Math.round(p.h));
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.translate(W / 2, H / 2);
  g.rotate(-p.angle);
  g.drawImage(src, -p.cx, -p.cy);
  return c;
}

// ---------------------------------------------------------------- photomerge: features

/** Grey values (Float32) of RGBA pixels. */
function greyOf(d, n) {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lumOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return L;
}
function boxBlur(a, w, hh, r) {
  const t = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < hh; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[y * w + x] = s * k;
      s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(hh - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < hh; y++) {
      out[y * w + x] = s * k;
      s += t[Math.min(hh - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// a fixed random pattern of 256 point pairs in a 31×31 patch (ORB-like binary tests)
const PAIRS = (() => {
  let s = 1234567;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const g = () => {
    // roughly Gaussian, inside the patch
    const v = (rnd() + rnd() + rnd() + rnd() - 2) * 6.5;
    return Math.max(-13, Math.min(13, v));
  };
  const p = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    p[i * 4] = g();
    p[i * 4 + 1] = g();
    p[i * 4 + 2] = g();
    p[i * 4 + 3] = g();
  }
  return p;
})();

/** Harris corners spread over the picture, each with an oriented binary descriptor. */
function features(L, w, hh, max = 600) {
  // gradients and the structure tensor
  const n = w * hh;
  const ixx = new Float32Array(n);
  const iyy = new Float32Array(n);
  const ixy = new Float32Array(n);
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (L[i + 1 - w] + 2 * L[i + 1] + L[i + 1 + w] - L[i - 1 - w] - 2 * L[i - 1] - L[i - 1 + w]) / 8;
      const gy = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1]) / 8;
      ixx[i] = gx * gx;
      iyy[i] = gy * gy;
      ixy[i] = gx * gy;
    }
  }
  const sxx = boxBlur(ixx, w, hh, 2);
  const syy = boxBlur(iyy, w, hh, 2);
  const sxy = boxBlur(ixy, w, hh, 2);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) R[i] = sxx[i] * syy[i] - sxy[i] * sxy[i] - 0.05 * (sxx[i] + syy[i]) ** 2;
  // the strongest corner of each grid cell (spread out), local maxima only
  const B = 18;
  const cell = Math.max(8, Math.round(Math.sqrt((w * hh) / (max * 1.2))));
  const cand = [];
  for (let cy = B; cy < hh - B; cy += cell) {
    for (let cx = B; cx < w - B; cx += cell) {
      let best = -1;
      let bv = 1e-3;
      for (let y = cy; y < Math.min(hh - B, cy + cell); y++) {
        for (let x = cx; x < Math.min(w - B, cx + cell); x++) {
          const v = R[y * w + x];
          if (v > bv) {
            bv = v;
            best = y * w + x;
          }
        }
      }
      if (best >= 0) cand.push([best, bv]);
    }
  }
  cand.sort((a, b) => b[1] - a[1]);
  const pts = cand.slice(0, max);
  // descriptors on a smoothed copy
  const S = boxBlur(boxBlur(L, w, hh, 1), w, hh, 1);
  const out = [];
  for (const [i] of pts) {
    const x = i % w;
    const y = (i - x) / w;
    // orientation from the intensity centroid
    let m01 = 0;
    let m10 = 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
      if (dx * dx + dy * dy > 100) continue;
      const v = S[(y + dy) * w + x + dx];
      m10 += dx * v;
      m01 += dy * v;
    }
    const a = Math.atan2(m01, m10);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const desc = new Uint32Array(8);
    for (let k = 0; k < 256; k++) {
      const ax = Math.round(c * PAIRS[k * 4] - s * PAIRS[k * 4 + 1]);
      const ay = Math.round(s * PAIRS[k * 4] + c * PAIRS[k * 4 + 1]);
      const bx = Math.round(c * PAIRS[k * 4 + 2] - s * PAIRS[k * 4 + 3]);
      const by = Math.round(s * PAIRS[k * 4 + 2] + c * PAIRS[k * 4 + 3]);
      if (S[(y + ay) * w + x + ax] < S[(y + by) * w + x + bx]) desc[k >> 5] |= 1 << (k & 31);
    }
    out.push({ x, y, desc });
  }
  return out;
}

const popcnt = (v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
const hamming = (a, b) => {
  let d = 0;
  for (let i = 0; i < 8; i++) d += popcnt(a[i] ^ b[i]);
  return d;
};

/** Matches between two feature lists (ratio test + cross check): [[i, j]…]. */
function match(fa, fb) {
  const best = (f, list) => {
    let b1 = 1e9;
    let b2 = 1e9;
    let bi = -1;
    for (let j = 0; j < list.length; j++) {
      const d = hamming(f.desc, list[j].desc);
      if (d < b1) {
        b2 = b1;
        b1 = d;
        bi = j;
      } else if (d < b2) b2 = d;
    }
    return { bi, b1, b2 };
  };
  const ab = fa.map((f) => best(f, fb));
  const ba = fb.map((f) => best(f, fa).bi);
  const out = [];
  ab.forEach((m, i) => {
    if (m.bi >= 0 && m.b1 < 64 && m.b1 < m.b2 * 0.8 && ba[m.bi] === i) out.push([i, m.bi]);
  });
  return out;
}

/** Similarity transform [a, b, tx, ty] (x' = a x − b y + tx, y' = b x + a y + ty) from point pairs. */
function fitSimilarity(P, Q, rigidOnly) {
  const n = P.length / 2;
  let mpx = 0;
  let mpy = 0;
  let mqx = 0;
  let mqy = 0;
  for (let i = 0; i < n; i++) {
    mpx += P[i * 2];
    mpy += P[i * 2 + 1];
    mqx += Q[i * 2];
    mqy += Q[i * 2 + 1];
  }
  mpx /= n;
  mpy /= n;
  mqx /= n;
  mqy /= n;
  if (rigidOnly === 'translate') return [1, 0, mqx - mpx, mqy - mpy];
  let sxx = 0;
  let sxy = 0;
  let pp = 0;
  for (let i = 0; i < n; i++) {
    const px = P[i * 2] - mpx;
    const py = P[i * 2 + 1] - mpy;
    const qx = Q[i * 2] - mqx;
    const qy = Q[i * 2 + 1] - mqy;
    sxx += px * qx + py * qy;
    sxy += px * qy - py * qx;
    pp += px * px + py * py;
  }
  if (pp < 1e-9) return null;
  let a = sxx / pp;
  let b = sxy / pp;
  // panoramas from one camera keep their scale: allow only a little zoom
  const s = Math.hypot(a, b);
  const sc = Math.max(0.8, Math.min(1.25, s));
  a = (a / s) * sc;
  b = (b / s) * sc;
  return [a, b, mqx - (a * mpx - b * mpy), mqy - (b * mpx + a * mpy)];
}
const apply = (T, x, y) => [T[0] * x - T[1] * y + T[2], T[1] * x + T[0] * y + T[3]];

/** RANSAC: the transform taking image A's points onto image B's, with its inlier count. */
function ransac(fa, fb, matches, mode, tol = 3) {
  if (matches.length < (mode === 'translate' ? 3 : 4)) return null;
  let best = null;
  let bestIn = [];
  let seed = 99;
  const rnd = (k) => {
    seed = (seed * 16807) % 2147483647;
    return seed % k;
  };
  const iters = Math.min(800, matches.length * 30);
  for (let it = 0; it < iters; it++) {
    const s1 = matches[rnd(matches.length)];
    const s2 = matches[rnd(matches.length)];
    if (s1 === s2 && mode !== 'translate') continue;
    const P = [fa[s1[0]].x, fa[s1[0]].y, fa[s2[0]].x, fa[s2[0]].y];
    const Q = [fb[s1[1]].x, fb[s1[1]].y, fb[s2[1]].x, fb[s2[1]].y];
    const T = fitSimilarity(mode === 'translate' ? P.slice(0, 2) : P, mode === 'translate' ? Q.slice(0, 2) : Q, mode);
    if (!T) continue;
    const inl = [];
    for (const m of matches) {
      const [x, y] = apply(T, fa[m[0]].x, fa[m[0]].y);
      if ((x - fb[m[1]].x) ** 2 + (y - fb[m[1]].y) ** 2 < tol * tol) inl.push(m);
    }
    if (inl.length > bestIn.length) {
      bestIn = inl;
      best = T;
    }
  }
  if (!best || bestIn.length < 6) return null;
  // refine on every inlier
  const P = [];
  const Q = [];
  for (const m of bestIn) {
    P.push(fa[m[0]].x, fa[m[0]].y);
    Q.push(fb[m[1]].x, fb[m[1]].y);
  }
  return { T: fitSimilarity(P, Q, mode) || best, inliers: bestIn.length };
}
const compose = (A, B) => [A[0] * B[0] - A[1] * B[1], A[1] * B[0] + A[0] * B[1], A[0] * B[2] - A[1] * B[3] + A[2], A[1] * B[2] + A[0] * B[3] + A[3]];
const invert = (T) => {
  const d = T[0] * T[0] + T[1] * T[1];
  const a = T[0] / d;
  const b = -T[1] / d;
  return [a, b, -(a * T[2] - b * T[3]), -(b * T[2] + a * T[3])];
};

/**
 * Line pictures up: for each, a transform into the reference picture's pixels (null when it could not
 * be placed). mode: 'auto' (move, turn, a little zoom) | 'translate'.
 */
export function alignImages(canvases, { mode = 'auto', onProgress = () => {} } = {}) {
  const WORK = 800;
  const info = canvases.map((c, i) => {
    onProgress(`특징점 찾는 중 (${i + 1}/${canvases.length})`);
    const s = shrink(c, WORK);
    const L = greyOf(s.data, s.w * s.h);
    return { k: s.k, feats: features(L, s.w, s.h) };
  });
  // every pair: how well they match
  const N = canvases.length;
  const pair = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      onProgress('겹치는 곳 맞추는 중…');
      const m = match(info[i].feats, info[j].feats);
      const r = ransac(info[i].feats, info[j].feats, m, mode);
      if (r) pair.push({ i, j, T: r.T, n: r.inliers });
    }
  }
  // the picture with the most matches is the reference; others join by their strongest link
  const score = new Array(N).fill(0);
  for (const p of pair) {
    score[p.i] += p.n;
    score[p.j] += p.n;
  }
  const ref = score.indexOf(Math.max(...score));
  // transforms in working pixels into the reference's working pixels
  const T = new Array(N).fill(null);
  T[ref] = [1, 0, 0, 0];
  let added = true;
  while (added) {
    added = false;
    let bestP = null;
    for (const p of pair) {
      const a = T[p.i];
      const b = T[p.j];
      if (!!a === !!b) continue;
      if (!bestP || p.n > bestP.n) bestP = p;
    }
    if (bestP) {
      // p.T maps i → j
      if (T[bestP.j]) T[bestP.i] = compose(T[bestP.j], bestP.T);
      else T[bestP.j] = compose(T[bestP.i], invert(bestP.T));
      added = true;
    }
  }
  // into full-size pixels of each picture: x_ref_full = (T (x_full k_i)) / k_ref
  return T.map((t, i) => {
    if (!t) return null;
    const ki = info[i].k;
    const kr = info[ref].k;
    return [(t[0] * ki) / kr, (t[1] * ki) / kr, t[2] / kr, t[3] / kr];
  });
}

/** Distance of each pixel to the outside of a footprint (alpha > 0), capped. */
function edgeDistance(alpha, w, hh, cap = 60) {
  const d = new Float32Array(w * hh);
  for (let i = 0; i < d.length; i++) d[i] = alpha[i] ? cap : 0;
  // two passes of a chamfer distance
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x === 0 || y === 0 || x === w - 1 || y === hh - 1) v = 1;
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - w] + 1);
    d[i] = v;
  }
  for (let y = hh - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < hh - 1) v = Math.min(v, d[i + w] + 1);
    d[i] = v;
  }
  return d;
}

/**
 * Merge pictures into one document: each its own layer, lined up, and (blend) a soft seam mask on each
 * plus matched brightness. Returns { doc, placed, skipped }.
 */
export function photomerge(canvases, names, { mode = 'auto', blend = true, onProgress = () => {} } = {}) {
  const T = alignImages(canvases, { mode, onProgress });
  const placed = canvases.map((c, i) => (T[i] ? i : -1)).filter((i) => i >= 0);
  if (placed.length < 2) throw new Error('겹치는 부분을 찾지 못했습니다. 사진끼리 30% 이상 겹치게 찍은 사진을 쓰세요.');
  /** Where a picture's corners land (reference pixels). */
  const cornersOf = (i) => {
    const c = canvases[i];
    return [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]].map(([x, y]) => apply(T[i], x, y));
  };
  // the merged picture's bounds
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of placed) {
    for (const [px, py] of cornersOf(i)) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  let W = Math.ceil(x1 - x0);
  let H = Math.ceil(y1 - y0);
  // very big results are made smaller (each picture is its own layer: memory adds up)
  const fit = Math.min(1, Math.sqrt(60e6 / (W * H)), 30000 / Math.max(W, H));
  W = Math.max(1, Math.round(W * fit));
  H = Math.max(1, Math.round(H * fit));
  const toDoc = (t) => [t[0] * fit, t[1] * fit, (t[2] - x0) * fit, (t[3] - y0) * fit];
  onProgress('사진을 놓는 중…');
  // each layer is only as big as its picture (a box in document pixels)
  const layers = placed.map((i) => {
    const t = toDoc(T[i]);
    const cs = cornersOf(i).map(([x, y]) => [(x - x0) * fit, (y - y0) * fit]);
    const bx = Math.max(0, Math.floor(Math.min(...cs.map((q) => q[0]))));
    const by = Math.max(0, Math.floor(Math.min(...cs.map((q) => q[1]))));
    const bw = Math.max(1, Math.min(W, Math.ceil(Math.max(...cs.map((q) => q[0])))) - bx);
    const bh = Math.max(1, Math.min(H, Math.ceil(Math.max(...cs.map((q) => q[1])))) - by);
    const c = makeCanvas(bw, bh);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.setTransform(t[0], t[1], -t[1], t[0], t[2] - bx, t[3] - by);
    g.drawImage(canvases[i], 0, 0);
    return { i, canvas: c, x: bx, y: by };
  });
  if (blend && layers.length > 1) {
    onProgress('이음매를 부드럽게 하는 중…');
    // work small: footprints, brightness and seams
    const k = Math.min(1, 700 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k));
    const hh = Math.max(1, Math.round(H * k));
    const small = layers.map((l) => {
      const sc = makeCanvas(w, hh);
      const g = sc.getContext('2d', { willReadFrequently: true });
      g.drawImage(l.canvas, l.x * k, l.y * k, l.canvas.width * k, l.canvas.height * k);
      const d = g.getImageData(0, 0, w, hh).data;
      const a = new Uint8Array(w * hh);
      for (let p = 0; p < a.length; p++) a[p] = d[p * 4 + 3] > 200 ? 1 : 0;
      return { d, a };
    });
    // brightness: each picture matches the ones placed before it where they overlap
    const gains = layers.map(() => 1);
    for (let li = 1; li < layers.length; li++) {
      let sa = 0;
      let sb = 0;
      for (let p = 0; p < w * hh; p++) {
        if (!small[li].a[p]) continue;
        for (let lj = 0; lj < li; lj++) {
          if (!small[lj].a[p]) continue;
          const o = p * 4;
          sa += lumOf(small[li].d[o], small[li].d[o + 1], small[li].d[o + 2]);
          sb += lumOf(small[lj].d[o], small[lj].d[o + 1], small[lj].d[o + 2]) * gains[lj];
          break;
        }
      }
      if (sa > 0 && sb > 0) gains[li] = Math.max(0.7, Math.min(1.4, sb / sa));
    }
    layers.forEach((l, li) => {
      if (Math.abs(gains[li] - 1) < 0.01) return;
      // the browser's own brightness filter (a straight multiply) on the GPU
      const c = makeCanvas(l.canvas.width, l.canvas.height);
      const g = c.getContext('2d');
      g.filter = `brightness(${gains[li]})`;
      g.drawImage(l.canvas, 0, 0);
      l.canvas = c;
    });
    // seams: each pixel belongs to the picture it is deepest inside
    const dist = small.map((sm) => edgeDistance(sm.a, w, hh));
    const owner = new Int16Array(w * hh).fill(-1);
    for (let p = 0; p < w * hh; p++) {
      let best = -1;
      for (let lj = 0; lj < layers.length; lj++) if (small[lj].a[p] && (best < 0 || dist[lj][p] > dist[best][p])) best = lj;
      owner[p] = best;
    }
    layers.forEach((l, li) => {
      if (li === 0) return;
      // shown where it or a picture above it owns the pixel: the soft edge is only toward the
      // pictures below (a picture above blends over this one with its own soft edge)
      const m = makeCanvas(w, hh);
      const mg = m.getContext('2d');
      const mi = mg.createImageData(w, hh);
      // where no picture below reaches: always shown (no hole at the outer edges)
      const solo = makeCanvas(w, hh);
      const sg = solo.getContext('2d');
      const si = sg.createImageData(w, hh);
      for (let p = 0; p < w * hh; p++) {
        if (!small[li].a[p]) continue;
        if (owner[p] >= li) mi.data[p * 4 + 3] = 255;
        let below = false;
        for (let lj = 0; lj < li; lj++) if (small[lj].a[p]) { below = true; break; }
        if (!below) si.data[p * 4 + 3] = 255;
      }
      mg.putImageData(mi, 0, 0);
      sg.putImageData(si, 0, 0);
      // the mask covers the layer's box, in document pixels
      const full = makeCanvas(l.canvas.width, l.canvas.height);
      const fg = full.getContext('2d');
      fg.filter = `blur(${Math.max(1.5, Math.min(W, H) * 0.006)}px)`;
      fg.imageSmoothingQuality = 'high';
      fg.drawImage(m, -l.x, -l.y, W, H);
      fg.filter = 'none';
      fg.drawImage(solo, -l.x, -l.y, W, H);
      l.mask = full;
    });
  }
  const doc = new PhotoDoc({ name: 'Photomerge', width: W, height: H, background: null });
  layers.forEach((l, li) => {
    const layer = newLayer('raster', { name: names[l.i] || `사진 ${l.i + 1}`, canvas: l.canvas, x: l.x, y: l.y });
    if (l.mask) layer.mask = { canvas: l.mask, x: l.x, y: l.y, enabled: true, linked: true };
    doc.layers.push(layer);
    if (li === layers.length - 1) {
      doc.activeId = layer.id;
      doc.selectedIds = [layer.id];
    }
  });
  return { doc, placed: placed.length, skipped: canvases.length - placed.length };
}

// ---------------------------------------------------------------- install

export function installAutomate(P) {
  const C = P.cmd;

  /** File ▸ Automate ▸ Crop and Straighten Photos. */
  C.cropStraighten = () => {
    const doc = P.doc;
    if (!doc) return toast('먼저 스캔한 사진을 여세요');
    toast('사진을 찾는 중…');
    setTimeout(() => {
      let src = doc.flatten({ fg: P.fg, bg: P.bg });
      let ox = 0;
      let oy = 0;
      // a selection limits the search to that part (like Photoshop)
      const b = doc.selection && P.selBounds(doc.selection.canvas);
      if (b) {
        const c = makeCanvas(b.w, b.h);
        c.getContext('2d').drawImage(src, -b.x, -b.y);
        src = c;
        ox = b.x;
        oy = b.y;
      }
      const found = findPhotos(src);
      if (!found.length) return void toast('따로 떨어진 사진을 찾지 못했습니다. 사진이 단색 배경 위에 서로 떨어져 있어야 합니다.');
      const base = (doc.name || '사진').replace(/\.[a-z0-9]+$/i, '');
      found.forEach((p, i) => P.openCanvas(extractPhoto(src, p), `${base} 사본${i ? ` ${i + 1}` : ''}`));
      toast(`사진 ${found.length}장을 찾아 각각 새 문서로 열었습니다${ox || oy ? ' (선택 영역 안)' : ''}`);
    }, 30);
    return undefined;
  };

  /** File ▸ Automate ▸ Photomerge… */
  C.photomerge = () => {
    const items = [];
    const list = h('div.ph-pmlist');
    const status = h('div.note', '');
    const renderList = () => {
      list.replaceChildren(...(items.length ? items.map((it, i) => h('div.ph-pmitem',
        h('canvas', { width: 64, height: 48, 'data-thumb': i }),
        h('span', it.name),
        h('small', `${it.canvas.width} × ${it.canvas.height}`),
        h('button.small', { 'aria-label': `${it.name} 빼기`, title: '목록에서 빼기', onclick: () => { items.splice(i, 1); renderList(); } }, '빼기'))) : [h('div.empty-hint', '합칠 사진을 두 장 이상 넣으세요')]));
      list.querySelectorAll('canvas[data-thumb]').forEach((cv) => {
        const it = items[+cv.dataset.thumb];
        const g = cv.getContext('2d');
        const k = Math.min(64 / it.canvas.width, 48 / it.canvas.height);
        g.drawImage(it.canvas, (64 - it.canvas.width * k) / 2, (48 - it.canvas.height * k) / 2, it.canvas.width * k, it.canvas.height * k);
      });
    };
    const addFiles = async () => {
      const { pickFiles } = await import('../ui/project-panel.js');
      const files = await pickFiles({ accept: 'image/*', multiple: true });
      const { canvasFromFile } = await import('./io.js');
      for (const f of files) {
        try {
          items.push({ name: f.name.replace(/\.[^.]+$/, ''), canvas: await canvasFromFile(f) });
        } catch {
          toast(`${f.name}: 열 수 없는 파일입니다`);
        }
      }
      renderList();
    };
    const addOpen = () => {
      for (const d of P.docs) items.push({ name: d.name, canvas: d.flatten({ fg: P.fg, bg: P.bg }) });
      renderList();
    };
    const layout = h('select', h('option', { value: 'auto' }, '자동 (이동·회전)'), h('option', { value: 'translate' }, '위치 변경만'));
    const blend = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: 'Photomerge',
      width: '520px',
      body: [
        h('div.ph-swbar', h('button.small', { onclick: addFiles }, '파일 찾아보기…'), h('button.small', { disabled: !P.docs.length, onclick: addOpen }, '열린 파일 추가')),
        list,
        formRow('레이아웃', layout),
        formRow('이미지 함께 혼합', blend),
        status,
        h('div.note', '같은 자리에서 돌아가며 찍어 서로 30% 이상 겹치는 사진을 이어 붙여 파노라마를 만듭니다. 결과는 사진마다 레이어(이음매 마스크 포함)로 된 새 문서입니다.'),
      ],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: async () => {
          if (items.length < 2) {
            status.textContent = '사진을 두 장 이상 넣으세요';
            return false;
          }
          const say = (t) => { status.textContent = t; };
          say('맞추는 중…');
          await new Promise((r) => setTimeout(r, 30));
          try {
            const r = photomerge(items.map((x) => x.canvas), items.map((x) => x.name), { mode: layout.value, blend: blend.checked, onProgress: say });
            P.openDoc(r.doc);
            toast(`사진 ${r.placed}장을 이었습니다${r.skipped ? ` (${r.skipped}장은 겹치는 곳을 못 찾아 뺐습니다)` : ''}`);
            return undefined;
          } catch (err) {
            say(String(err?.message || err));
            return false;
          }
        },
      }],
    });
    renderList();
  };

  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['파일'];
    if (!orig) return;
    P.menus['파일'] = () => {
      const items = orig();
      const a = items.find((x) => typeof x === 'object' && x?.label === '자동화');
      if (a && Array.isArray(a.submenu)) {
        // Photoshop's order: Batch …, Crop and Straighten Photos, Contact Sheet, …, Fit Image, …, Photomerge
        a.submenu.splice(Math.min(1, a.submenu.length), 0, { label: '사진 자르기 및 똑바르게 하기', disabled: !P.doc, action: () => C.cropStraighten() });
        a.submenu.push({ label: 'Photomerge… (파노라마)', action: () => C.photomerge() });
      }
      return items;
    };
  }];
}

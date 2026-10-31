// Segmentation for the selection tools, on plain typed arrays (no canvas): GrabCut (colour mixtures
// and a max-flow / min-cut over the pixel grid), a minimum-barrier saliency map for Select Subject,
// the colour guided filter that snaps mask edges to the picture, and the alpha matting behind
// Select and Mask's edge refinement.
//
// Images are RGBA bytes (Uint8ClampedArray, w × h × 4); masks and alphas are Float32Array (0..1)
// or Uint8Array labels.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- max-flow (Boykov–Kolmogorov)

// the 8 neighbours; k ^ 1 is the opposite direction
const DXS = [1, -1, 0, 0, 1, -1, -1, 1];
const DYS = [0, 0, 1, -1, 1, -1, 1, -1];
const TERM = -2;
const ORPH = -1;

/**
 * Min cut of an 8-connected pixel grid (Boykov & Kolmogorov 2004). The grid has a one-pixel frame
 * of dead nodes so neighbours never need bounds checks. Integer capacities: tr[i] > 0 is the
 * residual from the source to node i, tr[i] < 0 from i to the sink; cap[i * 8 + k] is the residual
 * from i to its neighbour in direction k.
 */
export class GridCut {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.W = w + 2;
    this.n = (w + 2) * (h + 2);
    this.cap = new Int32Array(this.n * 8);
    this.tr = new Int32Array(this.n);
    this.off = DXS.map((dx, k) => dx + DYS[k] * this.W);
    this.tree = null;
  }

  node(x, y) {
    return (y + 1) * this.W + x + 1;
  }

  /** Runs the max-flow; afterwards inSource(x, y) tells the side of the cut. */
  solve() {
    const { cap, tr, off, n, W } = this;
    const H2 = this.h + 2;
    const tree = new Uint8Array(n); // 0 free, 1 source tree, 2 sink tree, 3 dead frame
    const parent = new Int8Array(n).fill(ORPH);
    const ts = new Int32Array(n);
    const dist = new Int32Array(n);
    for (let x = 0; x < W; x++) {
      tree[x] = 3;
      tree[(H2 - 1) * W + x] = 3;
    }
    for (let y = 0; y < H2; y++) {
      tree[y * W] = 3;
      tree[y * W + W - 1] = 3;
    }
    const qn = n + 1;
    const q = new Int32Array(qn);
    const inq = new Uint8Array(n);
    let qh = 0;
    let qt = 0;
    const push = (i) => {
      if (inq[i]) return;
      inq[i] = 1;
      q[qt] = i;
      qt = qt + 1 === qn ? 0 : qt + 1;
    };
    for (let i = 0; i < n; i++) {
      if (tree[i] === 3 || !tr[i]) continue;
      tree[i] = tr[i] > 0 ? 1 : 2;
      parent[i] = TERM;
      dist[i] = 1;
      push(i);
    }
    const orphans = new Int32Array(n);
    let on = 0;
    let time = 0;
    let cur = -1;
    for (;;) {
      // ---- grow the trees until they touch
      let s = -1;
      let t = -1;
      let kst = -1;
      for (;;) {
        let i = cur;
        if (i < 0 || !(tree[i] === 1 || tree[i] === 2)) {
          i = -1;
          while (qh !== qt) {
            const c = q[qh];
            qh = qh + 1 === qn ? 0 : qh + 1;
            inq[c] = 0;
            if (tree[c] === 1 || tree[c] === 2) {
              i = c;
              break;
            }
          }
          if (i < 0) break;
        }
        cur = i;
        const ti = tree[i];
        const i8 = i * 8;
        for (let k = 0; k < 8; k++) {
          const j = i + off[k];
          const tj = tree[j];
          if (ti === 1) {
            if (cap[i8 + k] <= 0) continue;
            if (tj === 0) {
              tree[j] = 1;
              parent[j] = k ^ 1;
              ts[j] = ts[i];
              dist[j] = dist[i] + 1;
              push(j);
            } else if (tj === 2) {
              s = i;
              t = j;
              kst = k;
              break;
            }
          } else {
            if (cap[j * 8 + (k ^ 1)] <= 0) continue;
            if (tj === 0) {
              tree[j] = 2;
              parent[j] = k ^ 1;
              ts[j] = ts[i];
              dist[j] = dist[i] + 1;
              push(j);
            } else if (tj === 1) {
              s = j;
              t = i;
              kst = k ^ 1;
              break;
            }
          }
        }
        if (s >= 0) break;
        cur = -1;
      }
      if (s < 0) break;
      // ---- augment along source … s → t … sink
      time++;
      let f = cap[s * 8 + kst];
      for (let u = s; ;) {
        const p = parent[u];
        if (p === TERM) {
          if (tr[u] < f) f = tr[u];
          break;
        }
        const v = u + off[p];
        const c = cap[v * 8 + (p ^ 1)];
        if (c < f) f = c;
        u = v;
      }
      for (let u = t; ;) {
        const p = parent[u];
        if (p === TERM) {
          if (-tr[u] < f) f = -tr[u];
          break;
        }
        const c = cap[u * 8 + p];
        if (c < f) f = c;
        u += off[p];
      }
      cap[s * 8 + kst] -= f;
      cap[t * 8 + (kst ^ 1)] += f;
      for (let u = s; ;) {
        const p = parent[u];
        if (p === TERM) {
          tr[u] -= f;
          if (!tr[u]) {
            parent[u] = ORPH;
            orphans[on++] = u;
          }
          break;
        }
        const v = u + off[p];
        cap[v * 8 + (p ^ 1)] -= f;
        cap[u * 8 + p] += f;
        if (!cap[v * 8 + (p ^ 1)]) {
          parent[u] = ORPH;
          orphans[on++] = u;
        }
        u = v;
      }
      for (let u = t; ;) {
        const p = parent[u];
        if (p === TERM) {
          tr[u] += f;
          if (!tr[u]) {
            parent[u] = ORPH;
            orphans[on++] = u;
          }
          break;
        }
        const v = u + off[p];
        cap[u * 8 + p] -= f;
        cap[v * 8 + (p ^ 1)] += f;
        if (!cap[u * 8 + p]) {
          parent[u] = ORPH;
          orphans[on++] = u;
        }
        u = v;
      }
      // ---- adopt the orphans (or free them)
      while (on) {
        const u = orphans[--on];
        const tu = tree[u];
        let best = -1;
        let dmin = 0x7fffffff;
        for (let k = 0; k < 8; k++) {
          const j = u + off[k];
          if (tree[j] !== tu) continue;
          const c = tu === 1 ? cap[j * 8 + (k ^ 1)] : cap[u * 8 + k];
          if (c <= 0) continue;
          // does j still reach a terminal?
          let d = 0;
          let x = j;
          let ok = false;
          for (;;) {
            if (ts[x] === time) {
              d += dist[x];
              ok = true;
              break;
            }
            const px = parent[x];
            d++;
            if (px === TERM) {
              ts[x] = time;
              dist[x] = 1;
              ok = true;
              break;
            }
            if (px === ORPH) break;
            x += off[px];
          }
          if (!ok) continue;
          if (d < dmin) {
            best = k;
            dmin = d;
          }
          for (x = j; ts[x] !== time; x += off[parent[x]]) {
            ts[x] = time;
            dist[x] = d--;
          }
        }
        if (best >= 0) {
          parent[u] = best;
          ts[u] = time;
          dist[u] = dmin + 1;
          continue;
        }
        for (let k = 0; k < 8; k++) {
          const j = u + off[k];
          if (tree[j] !== tu) continue;
          const pj = parent[j];
          if (pj >= 0 && j + off[pj] === u) {
            parent[j] = ORPH;
            orphans[on++] = j;
          }
          const c = tu === 1 ? cap[j * 8 + (k ^ 1)] : cap[u * 8 + k];
          if (c > 0) push(j);
        }
        tree[u] = 0;
        parent[u] = ORPH;
      }
    }
    this.tree = tree;
  }

  inSource(x, y) {
    return this.tree[this.node(x, y)] === 1;
  }
}

// ---------------------------------------------------------------- colour mixtures

/** Colours as floats (n × 3). */
export function colorsOf(px, n) {
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = px[i * 4];
    c[i * 3 + 1] = px[i * 4 + 1];
    c[i * 3 + 2] = px[i * 4 + 2];
  }
  return c;
}

/**
 * A Gaussian mixture (full covariances) of the colours of pixels idx: k-means (started from `init`
 * centres when given) and then each cluster's mean and covariance. Returns null for no pixels.
 */
export function fitGMM(col, idx, K = 5, init = null) {
  const m = idx.length;
  if (!m) return null;
  K = Math.max(1, Math.min(K, m));
  const step = Math.max(1, Math.floor(m / 5000));
  let cs = init && init.length === K * 3 ? Float32Array.from(init) : new Float32Array(K * 3);
  if (!init || init.length !== K * 3) {
    // spread starting centres along the brightness order of a sample
    const sample = [];
    for (let s = 0; s < m; s += step) sample.push(idx[s]);
    sample.sort((a, b) => col[a * 3] + col[a * 3 + 1] + col[a * 3 + 2] - col[b * 3] - col[b * 3 + 1] - col[b * 3 + 2]);
    for (let k = 0; k < K; k++) {
      const i = sample[Math.floor(((k + 0.5) / K) * sample.length)];
      cs[k * 3] = col[i * 3];
      cs[k * 3 + 1] = col[i * 3 + 1];
      cs[k * 3 + 2] = col[i * 3 + 2];
    }
  }
  const nearest = (i) => {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < K; k++) {
      const d = (col[i * 3] - cs[k * 3]) ** 2 + (col[i * 3 + 1] - cs[k * 3 + 1]) ** 2 + (col[i * 3 + 2] - cs[k * 3 + 2]) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  };
  for (let it = 0; it < 4; it++) {
    const acc = new Float64Array(K * 4);
    for (let s = 0; s < m; s += step) {
      const i = idx[s];
      const k = nearest(i);
      acc[k * 4] += col[i * 3];
      acc[k * 4 + 1] += col[i * 3 + 1];
      acc[k * 4 + 2] += col[i * 3 + 2];
      acc[k * 4 + 3]++;
    }
    for (let k = 0; k < K; k++) {
      if (!acc[k * 4 + 3]) continue;
      cs[k * 3] = acc[k * 4] / acc[k * 4 + 3];
      cs[k * 3 + 1] = acc[k * 4 + 1] / acc[k * 4 + 3];
      cs[k * 3 + 2] = acc[k * 4 + 2] / acc[k * 4 + 3];
    }
  }
  // means and covariances of the final clusters (every pixel)
  const S = new Float64Array(K * 10); // count, sum r g b, sum rr rg rb gg gb bb
  for (let s = 0; s < m; s++) {
    const i = idx[s];
    const k = nearest(i);
    const r = col[i * 3];
    const g = col[i * 3 + 1];
    const b = col[i * 3 + 2];
    const o = k * 10;
    S[o]++;
    S[o + 1] += r;
    S[o + 2] += g;
    S[o + 3] += b;
    S[o + 4] += r * r;
    S[o + 5] += r * g;
    S[o + 6] += r * b;
    S[o + 7] += g * g;
    S[o + 8] += g * b;
    S[o + 9] += b * b;
  }
  const comps = [];
  for (let k = 0; k < K; k++) {
    const o = k * 10;
    const c = S[o];
    if (!c) continue;
    const mr = S[o + 1] / c;
    const mg = S[o + 2] / c;
    const mb = S[o + 3] / c;
    // a little extra variance keeps flat colours (and JPEG noise) from making razor-thin models
    const reg = 6;
    const a = S[o + 4] / c - mr * mr + reg;
    const bb = S[o + 5] / c - mr * mg;
    const cc = S[o + 6] / c - mr * mb;
    const d = S[o + 7] / c - mg * mg + reg;
    const e = S[o + 8] / c - mg * mb;
    const f = S[o + 9] / c - mb * mb + reg;
    const det = a * (d * f - e * e) - bb * (bb * f - cc * e) + cc * (bb * e - cc * d);
    if (!(det > 1e-9)) continue;
    comps.push({
      w: c / m,
      mu: [mr, mg, mb],
      inv: [(d * f - e * e) / det, (cc * e - bb * f) / det, (bb * e - cc * d) / det, (a * f - cc * cc) / det, (bb * cc - a * e) / det, (a * d - bb * bb) / det],
      ln: Math.log(c / m) - 0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI),
    });
  }
  if (!comps.length) return null;
  return { comps, centres: cs, t: new Float64Array(comps.length) };
}

/** −log likelihood of colour (r, g, b) under a mixture. */
export function gmmCost(M, r, g, b) {
  const { comps, t } = M;
  let mx = -Infinity;
  for (let k = 0; k < comps.length; k++) {
    const C = comps[k];
    const dx = r - C.mu[0];
    const dy = g - C.mu[1];
    const dz = b - C.mu[2];
    const v = C.inv;
    const q = v[0] * dx * dx + v[3] * dy * dy + v[5] * dz * dz + 2 * (v[1] * dx * dy + v[2] * dx * dz + v[4] * dy * dz);
    t[k] = C.ln - 0.5 * q;
    if (t[k] > mx) mx = t[k];
  }
  let sum = 0;
  for (let k = 0; k < comps.length; k++) sum += Math.exp(t[k] - mx);
  return -(mx + Math.log(sum));
}

// ---------------------------------------------------------------- GrabCut

/** Smoothness weights of the grid edges (right, down, down-right, down-left) for GrabCut. */
function edgeWeights(col, w, h, gamma) {
  const n = w * h;
  const wt = new Float32Array(n * 4);
  const d2 = (i, j) => (col[i * 3] - col[j * 3]) ** 2 + (col[i * 3 + 1] - col[j * 3 + 1]) ** 2 + (col[i * 3 + 2] - col[j * 3 + 2]) ** 2;
  let sum = 0;
  let cnt = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) {
        sum += d2(i, i + 1);
        cnt++;
      }
      if (y < h - 1) {
        sum += d2(i, i + w);
        cnt++;
      }
    }
  }
  const beta = 1 / (2 * Math.max(1, sum / Math.max(1, cnt)));
  const dg = gamma / Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) wt[i * 4] = gamma * Math.exp(-beta * d2(i, i + 1));
      if (y < h - 1) {
        wt[i * 4 + 1] = gamma * Math.exp(-beta * d2(i, i + w));
        if (x < w - 1) wt[i * 4 + 2] = dg * Math.exp(-beta * d2(i, i + w + 1));
        if (x > 0) wt[i * 4 + 3] = dg * Math.exp(-beta * d2(i, i + w - 1));
      }
    }
  }
  return wt;
}

/**
 * GrabCut (Rother et al. 2004) on a small image. state per pixel: 0 sure background, 1 sure
 * object, 2 probably background, 3 probably object. prior (optional): extra evidence for "object"
 * in nats (negative: for background). Returns labels (1 = object).
 */
export function grabCut(px, w, h, state, { iters = 5, prior = null, gamma = 50, K = 5 } = {}) {
  const n = w * h;
  const col = colorsOf(px, n);
  const wt = edgeWeights(col, w, h, gamma);
  const label = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = state[i] & 1;
  const SCALE = 64;
  const BIG = 1 << 24;
  let F = null;
  let B = null;
  for (let it = 0; it < iters; it++) {
    const fi = [];
    const bi = [];
    for (let i = 0; i < n; i++) (label[i] ? fi : bi).push(i);
    if (!fi.length || !bi.length) break;
    F = fitGMM(col, fi, K, F?.centres);
    B = fitGMM(col, bi, K, B?.centres);
    if (!F || !B) break;
    const G = new GridCut(w, h);
    const { cap, tr } = G;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = G.node(x, y);
        const st = state[i];
        if (st === 0) tr[v] = -BIG;
        else if (st === 1) tr[v] = BIG;
        else {
          const r = col[i * 3];
          const g = col[i * 3 + 1];
          const b = col[i * 3 + 2];
          // source = object: cutting source→i costs labelling i background
          let d = gmmCost(B, r, g, b) - gmmCost(F, r, g, b);
          if (prior) d += prior[i];
          tr[v] = Math.round(Math.max(-1e5, Math.min(1e5, d)) * SCALE);
        }
        // pairwise edges (both directions)
        const o = i * 4;
        const link = (k, j, wv) => {
          const c = Math.round(wv * SCALE);
          cap[v * 8 + k] = c;
          cap[j * 8 + (k ^ 1)] = c;
        };
        if (x < w - 1) link(0, v + 1, wt[o]);
        if (y < h - 1) {
          link(2, v + G.W, wt[o + 1]);
          if (x < w - 1) link(4, v + G.W + 1, wt[o + 2]);
          if (x > 0) link(6, v + G.W - 1, wt[o + 3]);
        }
      }
    }
    G.solve();
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = state[i] === 0 ? 0 : state[i] === 1 ? 1 : G.inSource(x, y) ? 1 : 0;
        if (v !== label[i]) changed++;
        label[i] = v;
      }
    }
    if (changed < n * 0.0005) break;
  }
  return label;
}

// ---------------------------------------------------------------- saliency

/** L*a*b*-like channels (0..255 ranges) of RGBA bytes, for perceptual distances. */
export function labChannels(px, n) {
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    const R = r <= 0.04045 ? r / 12.92 : ((r + 0.055) / 1.055) ** 2.4;
    const G = g <= 0.04045 ? g / 12.92 : ((g + 0.055) / 1.055) ** 2.4;
    const Bl = b <= 0.04045 ? b / 12.92 : ((b + 0.055) / 1.055) ** 2.4;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const X = f((0.4124 * R + 0.3576 * G + 0.1805 * Bl) / 0.95047);
    const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * Bl);
    const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * Bl) / 1.08883);
    L[i] = (116 * Y - 16) * 2.55;
    A[i] = 500 * (X - Y) + 128;
    B[i] = 200 * (Y - Z) + 128;
  }
  return [L, A, B];
}

/**
 * Minimum barrier distance (Zhang et al. 2015, raster-scan approximation) of every pixel from the
 * seed pixels, summed over the channels: high where every path to a seed crosses a big change.
 */
export function barrierDistance(chans, w, h, seeds, passes = 3) {
  const n = w * h;
  const out = new Float32Array(n);
  const D = new Float32Array(n);
  const U = new Float32Array(n);
  const Lo = new Float32Array(n);
  for (const I of chans) {
    for (let i = 0; i < n; i++) {
      D[i] = seeds[i] ? 0 : Infinity;
      U[i] = I[i];
      Lo[i] = I[i];
    }
    const relax = (i, j) => {
      const v = I[i];
      const u = U[j] > v ? U[j] : v;
      const l = Lo[j] < v ? Lo[j] : v;
      const b = u - l;
      if (b < D[i]) {
        D[i] = b;
        U[i] = u;
        Lo[i] = l;
      }
    };
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (x > 0) relax(i, i - 1);
          if (y > 0) relax(i, i - w);
        }
      }
      for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
          const i = y * w + x;
          if (x < w - 1) relax(i, i + 1);
          if (y < h - 1) relax(i, i + w);
        }
      }
    }
    for (let i = 0; i < n; i++) out[i] += Number.isFinite(D[i]) ? D[i] : 255;
  }
  return out;
}

/** Value at fraction q (0..1) of the sorted values of `a` (sampled for big arrays). */
export function quantile(a, q, idx = null) {
  const m = idx ? idx.length : a.length;
  if (!m) return 0;
  const step = Math.max(1, Math.floor(m / 20000));
  const s = [];
  for (let k = 0; k < m; k += step) s.push(a[idx ? idx[k] : k]);
  s.sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/** Otsu's threshold of values in 0..1. */
export function otsu(a) {
  const bins = new Float64Array(256);
  for (let i = 0; i < a.length; i++) bins[Math.min(255, Math.max(0, Math.round(a[i] * 255)))]++;
  let total = 0;
  let sumAll = 0;
  for (let b = 0; b < 256; b++) {
    total += bins[b];
    sumAll += b * bins[b];
  }
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let th = 128;
  for (let b = 0; b < 256; b++) {
    wB += bins[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * bins[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) {
      best = v;
      th = b;
    }
  }
  return (th + 0.5) / 255;
}

// ---------------------------------------------------------------- labels

/** 3×3 box blur of a float array (edges clamp). */
export function blur3(a, w, h, times = 1) {
  let src = a;
  for (let t = 0; t < times; t++) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tmp[i] = (src[x > 0 ? i - 1 : i] + src[i] + src[x < w - 1 ? i + 1 : i]) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = (tmp[y > 0 ? i - w : i] + tmp[i] + tmp[y < h - 1 ? i + w : i]) / 3;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Keep the big object pieces (at least `keep` × the biggest) and fill holes smaller than `holes` ×
 * the biggest piece that touch neither the picture edge nor a sure-background pixel.
 * Returns the number of object pixels left (labels change in place).
 */
export function tidy(label, w, h, fixed = null, { keep = 0.15, holes = 0.25 } = {}) {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const edge = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const v = label[s];
    const id = sizes.length;
    let sp = 0;
    let size = 0;
    let touches = false;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || (fixed && fixed[i])) touches = true;
      if (x > 0 && comp[i - 1] < 0 && label[i - 1] === v) {
        comp[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && comp[i + 1] < 0 && label[i + 1] === v) {
        comp[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && comp[i - w] < 0 && label[i - w] === v) {
        comp[i - w] = id;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && comp[i + w] < 0 && label[i + w] === v) {
        comp[i + w] = id;
        stack[sp++] = i + w;
      }
    }
    sizes.push(v ? size : -size);
    edge.push(touches);
  }
  let biggest = 0;
  for (const s of sizes) if (s > biggest) biggest = s;
  if (!biggest) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const s = sizes[comp[i]];
    if (s > 0) label[i] = s >= biggest * keep ? 1 : 0;
    else label[i] = !edge[comp[i]] && -s < biggest * holes ? 1 : 0;
    area += label[i];
  }
  return area;
}

// ---------------------------------------------------------------- guided filter

/** Mean over a (2r+1)² window (clamped at the edges) of a float array (into `out` when given). */
export function boxMean(src, w, h, r, out = null, tmp = null) {
  tmp = tmp || new Float32Array(src.length);
  out = out || new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) {
      acc += src[o + x];
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / cnt;
      if (x + r + 1 < w) {
        acc += src[o + x + r + 1];
        cnt++;
      }
      if (x - r >= 0) {
        acc -= src[o + x - r];
        cnt--;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) {
      acc += tmp[y * w + x];
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / cnt;
      if (y + r + 1 < h) {
        acc += tmp[(y + r + 1) * w + x];
        cnt++;
      }
      if (y - r >= 0) {
        acc -= tmp[(y - r) * w + x];
        cnt--;
      }
    }
  }
  return out;
}

/**
 * Colour guided filter (He et al. 2010) of `p` guided by the picture: the output follows the
 * picture's edges (hair strands, fur) where `p` changes. r: window radius, eps: smoothing (colours
 * in 0..1, so 1e-4 keeps fine detail and 1e-2 is soft). sub > 1 runs the fast version (statistics
 * on a sub-sampled copy, Fast Guided Filter 2015) for big areas.
 */
export function guidedFilter(px, w, h, p, r, eps, sub = 1) {
  sub = Math.max(1, Math.floor(sub));
  const lw = Math.ceil(w / sub);
  const lh = Math.ceil(h / sub);
  const ln = lw * lh;
  const Ir = new Float32Array(ln);
  const Ig = new Float32Array(ln);
  const Ib = new Float32Array(ln);
  const P = new Float32Array(ln);
  if (sub === 1) {
    for (let i = 0; i < ln; i++) {
      Ir[i] = px[i * 4] / 255;
      Ig[i] = px[i * 4 + 1] / 255;
      Ib[i] = px[i * 4 + 2] / 255;
      P[i] = p[i];
    }
  } else {
    const cnt = new Float32Array(ln);
    for (let y = 0; y < h; y++) {
      const ly = ((y / sub) | 0) * lw;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = ly + ((x / sub) | 0);
        Ir[l] += px[i * 4];
        Ig[l] += px[i * 4 + 1];
        Ib[l] += px[i * 4 + 2];
        P[l] += p[i];
        cnt[l]++;
      }
    }
    for (let l = 0; l < ln; l++) {
      const c = cnt[l] || 1;
      Ir[l] /= 255 * c;
      Ig[l] /= 255 * c;
      Ib[l] /= 255 * c;
      P[l] /= c;
    }
  }
  const lr = Math.max(1, Math.round(r / sub));
  // shared scratch buffers keep the many window means from churning memory
  const tmp = new Float32Array(ln);
  const pb = new Float32Array(ln);
  const mean = (a) => boxMean(a, lw, lh, lr, null, tmp);
  const prod = (a, b) => {
    for (let i = 0; i < ln; i++) pb[i] = a[i] * b[i];
    return pb;
  };
  const mR = mean(Ir);
  const mG = mean(Ig);
  const mB = mean(Ib);
  const mP = mean(P);
  const vRR = mean(prod(Ir, Ir));
  const vRG = mean(prod(Ir, Ig));
  const vRB = mean(prod(Ir, Ib));
  const vGG = mean(prod(Ig, Ig));
  const vGB = mean(prod(Ig, Ib));
  const vBB = mean(prod(Ib, Ib));
  const cR = mean(prod(Ir, P));
  const cG = mean(prod(Ig, P));
  const cB = mean(prod(Ib, P));
  const aR = new Float32Array(ln);
  const aG = new Float32Array(ln);
  const aB = new Float32Array(ln);
  const bb = new Float32Array(ln);
  for (let i = 0; i < ln; i++) {
    const a = vRR[i] - mR[i] * mR[i] + eps;
    const b = vRG[i] - mR[i] * mG[i];
    const c = vRB[i] - mR[i] * mB[i];
    const d = vGG[i] - mG[i] * mG[i] + eps;
    const e = vGB[i] - mG[i] * mB[i];
    const f = vBB[i] - mB[i] * mB[i] + eps;
    const pr = cR[i] - mR[i] * mP[i];
    const pg = cG[i] - mG[i] * mP[i];
    const pb = cB[i] - mB[i] * mP[i];
    const i0 = d * f - e * e;
    const i1 = c * e - b * f;
    const i2 = b * e - c * d;
    const det = a * i0 + b * i1 + c * i2;
    const i3 = a * f - c * c;
    const i4 = b * c - a * e;
    const i5 = a * d - b * b;
    const x = (i0 * pr + i1 * pg + i2 * pb) / det;
    const y = (i1 * pr + i3 * pg + i4 * pb) / det;
    const z = (i2 * pr + i4 * pg + i5 * pb) / det;
    aR[i] = x;
    aG[i] = y;
    aB[i] = z;
    bb[i] = mP[i] - x * mR[i] - y * mG[i] - z * mB[i];
  }
  const maR = mean(aR);
  const maG = mean(aG);
  const maB = mean(aB);
  const mb = mean(bb);
  const out = new Float32Array(w * h);
  if (sub === 1) {
    for (let i = 0; i < ln; i++) out[i] = (maR[i] * px[i * 4] + maG[i] * px[i * 4 + 1] + maB[i] * px[i * 4 + 2]) / 255 + mb[i];
    return out;
  }
  // bilinear up-sampling of the coefficients, applied to the full-size picture
  for (let y = 0; y < h; y++) {
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / sub - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(lh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / sub - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(lw - 1, x0 + 1);
      const tx = fx - x0;
      const k00 = y0 * lw + x0;
      const k01 = y0 * lw + x1;
      const k10 = y1 * lw + x0;
      const k11 = y1 * lw + x1;
      const lerp = (A) => (A[k00] * (1 - tx) + A[k01] * tx) * (1 - ty) + (A[k10] * (1 - tx) + A[k11] * tx) * ty;
      const i = y * w + x;
      out[i] = (lerp(maR) * px[i * 4] + lerp(maG) * px[i * 4 + 1] + lerp(maB) * px[i * 4 + 2]) / 255 + lerp(mb);
    }
  }
  return out;
}

/** Guided filter with the picture's brightness as the guide (cheaper than the colour one). */
export function guidedFilterGrey(px, w, h, p, r, eps) {
  const n = w * h;
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  const tmp = new Float32Array(n);
  const pb = new Float32Array(n);
  const mI = boxMean(I, w, h, r, null, tmp);
  const mP = boxMean(p, w, h, r, null, tmp);
  for (let i = 0; i < n; i++) pb[i] = I[i] * I[i];
  const vI = boxMean(pb, w, h, r, null, tmp);
  for (let i = 0; i < n; i++) pb[i] = I[i] * p[i];
  const cIP = boxMean(pb, w, h, r, null, tmp);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (cIP[i] - mI[i] * mP[i]) / (vI[i] - mI[i] * mI[i] + eps);
    A[i] = a;
    B[i] = mP[i] - a * mI[i];
  }
  const mA = boxMean(A, w, h, r, null, tmp);
  const mB = boxMean(B, w, h, r, null, tmp);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mA[i] * I[i] + mB[i];
  return out;
}

// ---------------------------------------------------------------- alpha matting

/**
 * Alpha of the `unknown` pixels from nearby sure-object and sure-background colours: for each
 * unknown pixel, object and background colours are estimated as local means at three window sizes,
 * and the pair that best explains the pixel as a mix (alpha·F + (1−alpha)·B) wins.
 * hard: Uint8Array (1 = object side), unknown: Uint8Array. Returns {alpha, fg (RGB of the object
 * colour per pixel, for colour decontamination), conf (0..1)}; alpha is NaN where nothing was
 * estimated.
 */
export function sampleMatte(px, w, h, hard, unknown, radius, nScales = 3) {
  const n = w * h;
  const alpha = new Float32Array(n).fill(NaN);
  const conf = new Float32Array(n);
  const fg = new Float32Array(n * 3);
  let any = false;
  for (let i = 0; i < n && !any; i++) any = !!unknown[i];
  if (!any) return { alpha, fg, conf };
  const r0 = Math.max(2, Math.round(radius * 0.6));
  const scales = [r0, Math.round(r0 * 2.2) + 2, Math.round(r0 * 5) + 6].slice(0, Math.max(1, nScales));
  const ns = scales.length;
  // summed-area tables of the sure colours (r, g, b, count) on each side: any window in O(1)
  const W1 = w + 1;
  const tables = [1, 0].map((want) => {
    const T = [0, 1, 2, 3].map(() => new Float64Array(W1 * (h + 1)));
    for (let y = 0; y < h; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      const o0 = y * W1;
      const o1 = (y + 1) * W1;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!unknown[i] && hard[i] === want) {
          r += px[i * 4];
          g += px[i * 4 + 1];
          b += px[i * 4 + 2];
          c++;
        }
        T[0][o1 + x + 1] = T[0][o0 + x + 1] + r;
        T[1][o1 + x + 1] = T[1][o0 + x + 1] + g;
        T[2][o1 + x + 1] = T[2][o0 + x + 1] + b;
        T[3][o1 + x + 1] = T[3][o0 + x + 1] + c;
      }
    }
    return T;
  });
  const Fs = scales.map(() => [0, 0, 0]);
  const Bs = scales.map(() => [0, 0, 0]);
  const fOk = scales.map(() => false);
  const bOk = scales.map(() => false);
  const read = (T, out, x0, y0, x1, y1) => {
    const a = y1 * W1 + x1;
    const bb = y0 * W1 + x1;
    const c = y1 * W1 + x0;
    const d = y0 * W1 + x0;
    const cnt = T[3][a] - T[3][bb] - T[3][c] + T[3][d];
    if (cnt < 0.5) return false;
    out[0] = (T[0][a] - T[0][bb] - T[0][c] + T[0][d]) / cnt;
    out[1] = (T[1][a] - T[1][bb] - T[1][c] + T[1][d]) / cnt;
    out[2] = (T[2][a] - T[2][bb] - T[2][c] + T[2][d]) / cnt;
    return true;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!unknown[i]) continue;
      const R = px[i * 4];
      const G = px[i * 4 + 1];
      const Bv = px[i * 4 + 2];
      for (let s = 0; s < ns; s++) {
        const k = scales[s];
        const x0 = x - k < 0 ? 0 : x - k;
        const y0 = y - k < 0 ? 0 : y - k;
        const x1 = x + k + 1 > w ? w : x + k + 1;
        const y1 = y + k + 1 > h ? h : y + k + 1;
        fOk[s] = read(tables[0], Fs[s], x0, y0, x1, y1);
        bOk[s] = read(tables[1], Bs[s], x0, y0, x1, y1);
      }
      let best = Infinity;
      let ba = NaN;
      let bf = null;
      let bden = 0;
      for (let a = 0; a < ns; a++) {
        if (!fOk[a]) continue;
        const F = Fs[a];
        for (let b = 0; b < ns; b++) {
          if (!bOk[b]) continue;
          const B = Bs[b];
          const d0 = F[0] - B[0];
          const d1 = F[1] - B[1];
          const d2 = F[2] - B[2];
          const den = d0 * d0 + d1 * d1 + d2 * d2;
          if (den < 100) continue;
          const al = clamp01(((R - B[0]) * d0 + (G - B[1]) * d1 + (Bv - B[2]) * d2) / den);
          const e0 = R - (al * F[0] + (1 - al) * B[0]);
          const e1 = G - (al * F[1] + (1 - al) * B[1]);
          const e2 = Bv - (al * F[2] + (1 - al) * B[2]);
          // small windows describe the spot best: prefer them a little
          const err = (e0 * e0 + e1 * e1 + e2 * e2) / den + (a + b) * 0.004;
          if (err < best) {
            best = err;
            ba = al;
            bf = F;
            bden = den;
          }
        }
      }
      if (bf) {
        alpha[i] = ba;
        fg[i * 3] = bf[0];
        fg[i * 3 + 1] = bf[1];
        fg[i * 3 + 2] = bf[2];
        // weak colour contrast or a poor fit: little confidence
        conf[i] = clamp01((bden - 100) / 2500) * clamp01(1 - best * 4);
      } else {
        const s = fOk.indexOf(true);
        const F = s >= 0 ? Fs[s] : [R, G, Bv];
        fg[i * 3] = F[0];
        fg[i * 3 + 1] = F[1];
        fg[i * 3 + 2] = F[2];
      }
    }
  }
  return { alpha, fg, conf };
}

// ---------------------------------------------------------------- subject / object

/** Gentle blur of RGBA bytes (two 3×3 passes) for statistics that should ignore fine texture. */
function softened(px, w, h) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  for (let c = 0; c < 4; c++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = px[i * 4 + c];
    const b = blur3(a, w, h, 2);
    for (let i = 0; i < n; i++) out[i * 4 + c] = b[i];
  }
  return out;
}

/** Normalise to 0..1 by the value at quantile q (robust against a few extreme pixels). */
function normalize(a, q = 0.99) {
  const top = Math.max(1e-6, quantile(a, q));
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.min(1, a[i] / top);
  return out;
}

/**
 * Saliency of every pixel against the background `seeds`: how hard it is to reach a seed without
 * crossing a big colour change (minimum barrier distance) and how badly the seeds' colours
 * explain it, combined (0..1).
 */
export function saliency(px, w, h, seeds) {
  const n = w * h;
  const soft = softened(px, w, h);
  const mbd = normalize(barrierDistance(labChannels(soft, n), w, h, seeds));
  const col = colorsOf(soft, n);
  const sidx = [];
  for (let i = 0; i < n; i++) if (seeds[i]) sidx.push(i);
  const M = fitGMM(col, sidx, 8);
  const S = new Float32Array(n);
  if (!M) return mbd;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) cost[i] = gmmCost(M, col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
  const c0 = quantile(cost, 0.9, sidx);
  for (let i = 0; i < n; i++) {
    const s2 = clamp01((cost[i] - c0) / 14);
    S[i] = 0.5 * mbd[i] + 0.5 * s2;
  }
  return S;
}

/** Connected pieces of a binary map: {comp: Int32Array (−1 outside), list: [{size, x0, y0, x1, y1}]}. */
function components(bin, w, h) {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const list = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!bin[s] || comp[s] >= 0) continue;
    const id = list.length;
    const c = { size: 0, x0: w, y0: h, x1: 0, y1: 0 };
    let sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      c.size++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x > 0 && bin[i - 1] && comp[i - 1] < 0) {
        comp[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && bin[i + 1] && comp[i + 1] < 0) {
        comp[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bin[i - w] && comp[i - w] < 0) {
        comp[i - w] = id;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && bin[i + w] && comp[i + w] < 0) {
        comp[i + w] = id;
        stack[sp++] = i + w;
      }
    }
    list.push(c);
  }
  return { comp, list };
}

/**
 * Select Subject on a small picture: the main object. The picture's edges give the background
 * (the top and upper sides for sure; lower edge stretches only when their colours also appear up
 * there, since people and products often run out of the frame at the bottom). A saliency map
 * picks the salient piece nearest the middle, and GrabCut grows the final shape from it.
 * Returns labels (1 = subject) or null.
 */
export function subjectLabels(px, w, h) {
  const n = w * h;
  const soft = softened(px, w, h);
  const col = colorsOf(soft, n);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.035));
  const sure = [];
  const maybe = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = y < band || y >= h - band || x < band || x >= w - band;
      if (!edge) continue;
      const i = y * w + x;
      if (y < h * 0.55 && y < h - band) sure.push(i);
      else maybe.push(i);
    }
  }
  const seeds = new Uint8Array(n);
  for (const i of sure) seeds[i] = 1;
  const M = fitGMM(col, sure, 8);
  if (M) {
    const ref = Float32Array.from(sure, (i) => gmmCost(M, col[i * 3], col[i * 3 + 1], col[i * 3 + 2]));
    const th = quantile(ref, 0.95) + 1;
    for (const i of maybe) if (gmmCost(M, col[i * 3], col[i * 3 + 1], col[i * 3 + 2]) <= th) seeds[i] = 1;
  }
  // stray decisions along the edge follow their neighbours
  const sm = blur3(Float32Array.from(seeds), w, h, 2);
  for (const i of maybe) seeds[i] = sm[i] > 0.4 ? 1 : 0;
  const S = saliency(px, w, h, seeds);
  const centre = (x, y) => {
    const dx = (x / w - 0.5) / 0.3;
    const dy = (y / h - 0.5) / 0.35;
    return Math.exp(-(dx * dx + dy * dy));
  };
  // subjects sit towards the middle: far from it, a pixel needs more saliency
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) S[y * w + x] *= 0.5 + 0.5 * centre(x, y);
  // the salient piece nearest the middle is the subject
  let th = Math.max(0.12, otsu(S));
  const pickCore = (t) => {
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = S[i] > t && !seeds[i] ? 1 : 0;
    // a small opening drops thin links to neighbouring blobs
    const o = blur3(Float32Array.from(bin), w, h, 1);
    for (let i = 0; i < n; i++) bin[i] = o[i] > 0.6 ? 1 : 0;
    const { comp, list } = components(bin, w, h);
    const score = new Float64Array(list.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = comp[y * w + x];
      if (c >= 0) score[c] += centre(x, y) * S[y * w + x];
    }
    let best = -1;
    for (let c = 0; c < list.length; c++) if (best < 0 || score[c] > score[best]) best = c;
    return best < 0 ? null : { comp, list, best, score };
  };
  let core = pickCore(th);
  if (!core) return null;
  const C0 = core.list[core.best];
  // other pieces that score nearly as well and sit next to it belong too (a face and a shirt)
  const keep = new Uint8Array(core.list.length);
  keep[core.best] = 1;
  const pad = Math.round(Math.max(w, h) * 0.03);
  for (let c = 0; c < core.list.length; c++) {
    const L = core.list[c];
    const near = L.x0 <= C0.x1 + pad && L.x1 >= C0.x0 - pad && L.y0 <= C0.y1 + pad && L.y1 >= C0.y0 - pad;
    if (near && core.score[c] > core.score[core.best] * 0.15) keep[c] = 1;
  }
  const state = new Uint8Array(n);
  const prior = new Float32Array(n);
  let fg = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (seeds[i]) continue;
      const c = core.comp[i];
      const inCore = c >= 0 && keep[c];
      state[i] = inCore ? 3 : 2;
      fg += inCore;
      // salient pieces away from the subject lean to background, the subject's surroundings stay open
      prior[i] = inCore ? 4 * (S[i] - th) : c >= 0 ? -2 : 4 * (S[i] - th) * centre(x, y);
    }
  }
  if (fg < n * 0.003) return null;
  const label = grabCut(px, w, h, state, { iters: 5, prior });
  const area = tidy(label, w, h, null, { keep: 0.12, holes: 0.2 });
  if (area < n * 0.003 || area > n * 0.97) return null;
  return label;
}

/**
 * Object selection inside a drawn region: `inside` marks the box or lasso (1). Outside is
 * background for sure (when the region fills the whole picture, its rim stands in). Saliency
 * against the region's surroundings starts GrabCut. Returns labels or null.
 */
export function objectLabels(px, w, h, inside) {
  const n = w * h;
  const state = new Uint8Array(n);
  const seeds = new Uint8Array(n);
  let outside = 0;
  for (let i = 0; i < n; i++) {
    if (!inside[i]) {
      seeds[i] = 1;
      outside++;
    }
  }
  if (outside < n * 0.01) {
    const band = Math.max(1, Math.round(Math.min(w, h) * 0.03));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (x < band || y < band || x >= w - band || y >= h - band) seeds[y * w + x] = 1;
    }
  }
  const S = saliency(px, w, h, seeds);
  const inIdx = [];
  for (let i = 0; i < n; i++) if (!seeds[i]) inIdx.push(i);
  if (inIdx.length < 16) return null;
  const vals = Float32Array.from(inIdx, (i) => S[i]);
  const th = Math.max(0.08, otsu(vals));
  const prior = new Float32Array(n);
  // like GrabCut: the whole region starts as the object; saliency only leans
  for (const i of inIdx) {
    state[i] = 3;
    prior[i] = 2 * (S[i] - th);
  }
  const label = grabCut(px, w, h, state, { iters: 5, prior });
  const area = tidy(label, w, h, seeds, { keep: 0.15, holes: 0.25 });
  return area >= 4 ? label : null;
}

// ---------------------------------------------------------------- refinement

/** Bilinear resize of a float map (centres aligned). */
export function resizeMap(a, sw, sh, W, H) {
  const out = new Float32Array(W * H);
  const kx = sw / W;
  const ky = sh / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      out[y * W + x] = (a[y0 * sw + x0] * (1 - tx) + a[y0 * sw + x1] * tx) * (1 - ty) + (a[y1 * sw + x0] * (1 - tx) + a[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

/**
 * Labels found on a small copy, brought to full size: smooth enlargement, then a guided filter
 * snaps the edge to the picture (scale: small size / full size). Returns alpha (0..1).
 */
export function snapLabels(px, W, H, label, sw, sh, scale, { hard = false } = {}) {
  const small = blur3(Float32Array.from(label), sw, sh, 1);
  const A = resizeMap(small, sw, sh, W, H);
  const r = Math.max(2, Math.round(1.6 / scale));
  const sub = Math.max(1, Math.round(Math.sqrt((W * H) / 4e5)));
  const q = guidedFilter(px, W, H, A, r, 2e-3, sub);
  for (let i = 0; i < q.length; i++) {
    const v = clamp01((q[i] - 0.5) * 1.8 + 0.5);
    q[i] = hard ? (v >= 0.5 ? 1 : 0) : v;
  }
  return q;
}

/** Sliding max (or min) over a (2r+1)² square window, O(n). */
export function rankMap(src, w, h, r, max = true) {
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

/** Luminance gradient magnitude (Sobel), about 0..1. */
export function gradientMap(px, w, h) {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) * (px[i * 4 + 3] / 255);
  const G = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const gx = L[ym * w + xp] + 2 * L[y * w + xp] + L[yp * w + xp] - L[ym * w + xm] - 2 * L[y * w + xm] - L[yp * w + xm];
      const gy = L[yp * w + xm] + 2 * L[yp * w + x] + L[yp * w + xp] - L[ym * w + xm] - 2 * L[ym * w + x] - L[ym * w + xp];
      G[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 1020);
    }
  }
  return G;
}

/**
 * Refine Hair: the stretches of the selection edge that look like hair or fur (lots of fine detail
 * across a wide band), as a map of areas to re-estimate (1). The band reaches `R` pixels outwards
 * (where loose strands are) and half as far inwards.
 */
export function hairAreas(px, w, h, a0, R) {
  const n = w * h;
  R = Math.max(2, Math.round(R));
  const hard = new Float32Array(n);
  for (let i = 0; i < n; i++) hard[i] = a0[i] >= 0.5 ? 1 : 0;
  const dil = rankMap(hard, w, h, R, true);
  const ero = rankMap(hard, w, h, Math.max(1, Math.round(R / 2)), false);
  const G = gradientMap(px, w, h);
  const k = Math.max(1, Math.round(R / 3));
  const mean = boxMean(G, w, h, k);
  const peak = rankMap(G, w, h, k, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (dil[i] === ero[i]) continue;
    // a clean edge is one strong line in a quiet window; hair fills the window with detail
    const busy = mean[i] / Math.max(0.03, peak[i]);
    out[i] = busy > 0.16 && mean[i] > 0.012 ? 1 : 0;
  }
  // close small gaps and drop specks
  const sm = blur3(out, w, h, Math.max(1, Math.round(k / 2)));
  const res = new Uint8Array(n);
  for (let i = 0; i < n; i++) res[i] = sm[i] > 0.3 && dil[i] !== ero[i] ? 1 : 0;
  return res;
}

/**
 * Re-estimate the alpha of the `est` pixels (the edge band): colour-aware mode explains each pixel
 * as a mix of nearby object and background colours (sampleMatte), object-aware mode follows the
 * picture's structure from the old edge (guided filter); where the colours give little confidence
 * both lean on the structure. `learn` (default est) are the pixels whose object colour is wanted
 * for decontamination. Returns {alpha, fg (RGB bytes or null)}.
 */
export function matteBand(px, w, h, a0, est, { radius = 4, mode = 'color', learn = null } = {}) {
  const n = w * h;
  const unknown = learn || est;
  // work only around the band: its box plus the widest sampling window
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!unknown[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  const alpha = Float32Array.from(a0);
  const fg = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    fg[i * 3] = px[i * 4];
    fg[i * 3 + 1] = px[i * 4 + 1];
    fg[i * 3 + 2] = px[i * 4 + 2];
  }
  if (x1 < 0) return { alpha, fg };
  const m = Math.round(Math.max(2, radius * 0.6) * 5) + 12;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const cn = cw * ch;
  const cpx = new Uint8ClampedArray(cn * 4);
  const ca = new Float32Array(cn);
  const cest = new Uint8Array(cn);
  const cun = new Uint8Array(cn);
  for (let y = 0; y < ch; y++) {
    const src = (y + y0) * w + x0;
    cpx.set(px.subarray(src * 4, (src + cw) * 4), y * cw * 4);
    ca.set(a0.subarray(src, src + cw), y * cw);
    cest.set(est.subarray(src, src + cw), y * cw);
    cun.set(unknown.subarray(src, src + cw), y * cw);
  }
  const hard = new Uint8Array(cn);
  for (let i = 0; i < cn; i++) hard[i] = ca[i] >= 0.5 ? 1 : 0;
  const M = sampleMatte(cpx, cw, ch, hard, cun, radius);
  const gr = Math.max(2, Math.round(radius * 0.6));
  // the old edge's shape, smoothed along the picture's structure (statistics on a smaller copy)
  const sub = Math.max(1, Math.min(4, Math.floor(gr / 4)), Math.floor(Math.sqrt(cn / 1.5e6)));
  const S = guidedFilter(cpx, cw, ch, Float32Array.from(hard), gr, mode === 'object' ? 8e-3 : 4e-3, sub);
  // object-aware trusts the colour estimate less and the shape of the old edge more
  const trust = mode === 'object' ? 0.85 : 1;
  const a = ca;
  for (let i = 0; i < cn; i++) {
    if (!cest[i]) continue;
    const sv = clamp01(S[i]);
    const c = Number.isNaN(M.alpha[i]) ? 0 : M.conf[i] * trust;
    a[i] = c * M.alpha[i] + (1 - c) * sv || 0;
  }
  // a light edge-aware clean-up keeps strands and removes speckle
  const q = guidedFilterGrey(cpx, cw, ch, a, 1, 1e-4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const o = (y + y0) * w + x + x0;
      // nearly clear and nearly solid pixels are clear and solid (no haze at the band's rim)
      if (cest[i]) alpha[o] = clamp01((0.5 * a[i] + 0.5 * q[i] - 0.05) / 0.9);
      if (cun[i] && (M.fg[i * 3] || M.fg[i * 3 + 1] || M.fg[i * 3 + 2])) {
        fg[o * 3] = M.fg[i * 3];
        fg[o * 3 + 1] = M.fg[i * 3 + 1];
        fg[o * 3 + 2] = M.fg[i * 3 + 2];
      }
    }
  }
  return { alpha, fg };
}

/**
 * Object Finder: the object under the point (x, y). On the main subject (labels `subject`), the
 * subject; elsewhere the coherent region GrabCut grows from a small disk around the point.
 * Returns labels or null when the point is on open background.
 */
export function pointLabels(px, w, h, x, y, subject = null) {
  const n = w * h;
  x = Math.max(0, Math.min(w - 1, Math.round(x)));
  y = Math.max(0, Math.min(h - 1, Math.round(y)));
  const i0 = y * w + x;
  if (subject && subject[i0]) return subject;
  const state = new Uint8Array(n).fill(2);
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) state[yy * w + xx] = 1;
  }
  const label = grabCut(px, w, h, state, { iters: 4 });
  // only the piece under the point, holes filled
  const { comp } = components(label, w, h);
  const id = comp[i0];
  if (id < 0) return null;
  let area = 0;
  for (let i = 0; i < n; i++) {
    label[i] = comp[i] === id ? 1 : 0;
    area += label[i];
  }
  tidy(label, w, h, null, { keep: 1, holes: 0.3 });
  // most of the picture, or a patch whose outline is largely the picture's edge, is background
  let edge = 0;
  for (let xx = 0; xx < w; xx++) edge += label[xx] + label[(h - 1) * w + xx];
  for (let yy = 1; yy < h - 1; yy++) edge += label[yy * w] + label[yy * w + w - 1];
  if (area > n * 0.5 || edge > Math.sqrt(area) * 4 * 0.25) return null;
  return label;
}

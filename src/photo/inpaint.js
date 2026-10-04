// Pixel maths behind the healing tools, with no DOM so it can be tested on its own.
//  - solveLaplace: fill unknown pixels as smoothly as possible from the known ones around them
//    (used to carry the colour difference at a patch's edge into the patch: "healing")
//  - inpaint: content-aware fill. Multi-scale PatchMatch (Barnes et al. 2009) with
//    expectation-maximisation voting (Wexler et al. 2007): every pixel of the hole is rebuilt from
//    small squares of the picture outside it that best match their surroundings.

/**
 * Fill the unknown pixels (unk[i] = 1) of F (w×h, C channels) by solving Laplace's equation with
 * the known pixels as the boundary. Coarse-to-fine so big holes converge quickly.
 */
export function solveLaplace(w, h, unk, F, C = 4) {
  const list = [];
  for (let i = 0; i < w * h; i++) if (unk[i]) list.push(i);
  if (!list.length) return;
  if (list.length === w * h) return; // nothing known to start from
  if (w > 24 && h > 24) {
    // a half-size problem gives the starting guess
    const w2 = (w + 1) >> 1;
    const h2 = (h + 1) >> 1;
    const F2 = new Float32Array(w2 * h2 * C);
    const cnt = new Float32Array(w2 * h2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (unk[i]) continue;
        const j = (y >> 1) * w2 + (x >> 1);
        cnt[j]++;
        for (let c = 0; c < C; c++) F2[j * C + c] += F[i * C + c];
      }
    }
    const unk2 = new Uint8Array(w2 * h2);
    for (let j = 0; j < w2 * h2; j++) {
      if (cnt[j]) for (let c = 0; c < C; c++) F2[j * C + c] /= cnt[j];
      else unk2[j] = 1;
    }
    solveLaplace(w2, h2, unk2, F2, C);
    for (const i of list) {
      const j = ((i / w) >> 1) * w2 + ((i % w) >> 1);
      for (let c = 0; c < C; c++) F[i * C + c] = F2[j * C + c];
    }
  } else {
    let s = new Float64Array(C);
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (unk[i]) continue;
      for (let c = 0; c < C; c++) s[c] += F[i * C + c];
      n++;
    }
    s = s.map((v) => v / n);
    for (const i of list) for (let c = 0; c < C; c++) F[i * C + c] = s[c];
  }
  // successive over-relaxation; the edges of the grid act as mirrors
  const iters = w * h < 2500 ? 300 : 40;
  const om = 1.8;
  for (let it = 0; it < iters; it++) {
    for (const i of list) {
      const x = i % w;
      const y = (i / w) | 0;
      let n = 0;
      const a = x > 0 ? (n++, i - 1) : -1;
      const b = x < w - 1 ? (n++, i + 1) : -1;
      const u = y > 0 ? (n++, i - w) : -1;
      const d = y < h - 1 ? (n++, i + w) : -1;
      for (let c = 0; c < C; c++) {
        let v = 0;
        if (a >= 0) v += F[a * C + c];
        if (b >= 0) v += F[b * C + c];
        if (u >= 0) v += F[u * C + c];
        if (d >= 0) v += F[d * C + c];
        const k = i * C + c;
        F[k] += om * (v / n - F[k]);
      }
    }
  }
}

/**
 * Healing paste: put `src` into `dst` where `amt` > 0, shifted in colour so its edge meets `dst`
 * without a seam. All arrays are RGBA w×h; amt is 0..255 per pixel. Returns the blended pixels.
 */
export function healBlend(w, h, dst, src, amt, opacity = 1) {
  const unk = new Uint8Array(w * h);
  const F = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (amt[i]) unk[i] = 1;
    for (let c = 0; c < 4; c++) F[i * 4 + c] = dst[i * 4 + c] - src[i * 4 + c];
  }
  solveLaplace(w, h, unk, F, 4);
  const out = new Uint8ClampedArray(dst);
  for (let i = 0; i < w * h; i++) {
    if (!amt[i]) continue;
    const a = (amt[i] / 255) * opacity;
    for (let c = 0; c < 4; c++) {
      const k = i * 4 + c;
      out[k] = dst[k] + (src[k] + F[k] - dst[k]) * a;
    }
  }
  return out;
}

// ---------------------------------------------------------------- content-aware fill

/** A deterministic random generator so the same fill gives the same result. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function boxSum(w, h, m) {
  // integral image of a 0/1 mask, (w+1)×(h+1)
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return (x0, y0, x1, y1) => I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
}

function downsample(L) {
  const { w, h, img, hole, avoid } = L;
  const w2 = (w + 1) >> 1;
  const h2 = (h + 1) >> 1;
  const img2 = new Float32Array(w2 * h2 * 4);
  const cnt = new Float32Array(w2 * h2);
  const hole2 = new Uint8Array(w2 * h2);
  const avoid2 = new Uint8Array(w2 * h2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = (y >> 1) * w2 + (x >> 1);
      if (hole[i]) hole2[j] = 1;
      if (avoid[i]) avoid2[j] = 1;
      if (hole[i]) continue;
      cnt[j]++;
      for (let c = 0; c < 4; c++) img2[j * 4 + c] += img[i * 4 + c];
    }
  }
  for (let j = 0; j < w2 * h2; j++) if (cnt[j]) for (let c = 0; c < 4; c++) img2[j * 4 + c] /= cnt[j];
  return { w: w2, h: h2, img: img2, hole: hole2, avoid: avoid2 };
}

/**
 * Content-aware fill in place. data: RGBA w×h; hole[i] = 1 where pixels are rebuilt.
 * avoid[i] = 1 marks pixels that may not be copied from (optional).
 */
export function inpaint(data, w, h, hole, { avoid = null, seed = 7 } = {}) {
  const rand = rng(seed);
  const img = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) img[i] = data[i];
  const levels = [{ w, h, img, hole, avoid: avoid || new Uint8Array(w * h) }];
  // shrink until the hole is a few pixels across
  for (;;) {
    const L = levels[levels.length - 1];
    let n = 0;
    for (let i = 0; i < L.w * L.h; i++) n += L.hole[i];
    if (Math.min(L.w, L.h) < 48 || n < 40 || levels.length >= 8) break;
    levels.push(downsample(L));
  }
  // coarsest start: a smooth guess from the edge colours
  const top = levels[levels.length - 1];
  solveLaplace(top.w, top.h, top.hole, top.img, 4);

  let prev = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const { w: W, h: H, img: I, hole: M } = L;
    if (prev) {
      // finer level: start the hole from the coarser result
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!M[i]) continue;
          const j = (y >> 1) * prev.w + (x >> 1);
          for (let c = 0; c < 4; c++) I[i * 4 + c] = prev.img[j * 4 + c];
        }
      }
    }
    const holeCount = M.reduce((a, b) => a + b, 0);
    const r = holeCount > 60000 ? 2 : 3;
    const P = 2 * r + 1;
    // sources: patches entirely outside the hole and the no-copy area
    const blocked = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) blocked[i] = M[i] | L.avoid[i];
    const bs = boxSum(W, H, blocked);
    const hs = boxSum(W, H, M);
    const valid = new Uint8Array(W * H);
    const vlist = [];
    for (let y = r; y < H - r; y++) {
      for (let x = r; x < W - r; x++) {
        if (bs(x - r, y - r, x + r + 1, y + r + 1) === 0) {
          valid[y * W + x] = 1;
          vlist.push(y * W + x);
        }
      }
    }
    if (!vlist.length) {
      prev = L;
      continue;
    }
    // targets: pixels whose patch touches the hole
    const targets = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (hs(Math.max(0, x - r), Math.max(0, y - r), Math.min(W, x + r + 1), Math.min(H, y + r + 1))) targets.push(y * W + x);
      }
    }
    const nnf = new Int32Array(W * H).fill(-1);
    const nnd = new Float64Array(W * H);
    const dist = (p, s, best) => {
      const px = p % W;
      const py = (p / W) | 0;
      const sx = s % W;
      const sy = (s / W) | 0;
      let d = 0;
      for (let dy = -r; dy <= r; dy++) {
        const qy = py + dy;
        if (qy < 0 || qy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const qx = px + dx;
          if (qx < 0 || qx >= W) continue;
          const q = (qy * W + qx) * 4;
          const t = ((sy + dy) * W + sx + dx) * 4;
          const a = I[q] - I[t];
          const b = I[q + 1] - I[t + 1];
          const c = I[q + 2] - I[t + 2];
          const e = I[q + 3] - I[t + 3];
          d += a * a + b * b + c * c + e * e;
        }
        if (d >= best) return d;
      }
      return d;
    };
    const randomValid = () => vlist[(rand() * vlist.length) | 0];
    for (const p of targets) {
      let s = -1;
      if (prev && prev.nnf) {
        const x = p % W;
        const y = (p / W) | 0;
        const cs = prev.nnf[(y >> 1) * prev.w + (x >> 1)];
        if (cs >= 0) {
          const sx = (cs % prev.w) * 2 + (x & 1);
          const sy = ((cs / prev.w) | 0) * 2 + (y & 1);
          if (sx < W && sy < H && valid[sy * W + sx]) s = sy * W + sx;
        }
      }
      if (s < 0) s = randomValid();
      nnf[p] = s;
      nnd[p] = dist(p, s, Infinity);
    }
    const tryS = (p, s) => {
      if (s < 0 || s >= W * H || !valid[s] || s === nnf[p]) return;
      const d = dist(p, s, nnd[p]);
      if (d < nnd[p]) {
        nnd[p] = d;
        nnf[p] = s;
      }
    };
    const patchMatch = (iters) => {
      for (let it = 0; it < iters; it++) {
        const fwd = it % 2 === 0;
        const step = fwd ? 1 : -1;
        for (let k = fwd ? 0 : targets.length - 1; k >= 0 && k < targets.length; k += step) {
          const p = targets[k];
          const x = p % W;
          const y = (p / W) | 0;
          // propagation: a neighbour's match, moved by one pixel
          const nx = x - step;
          const ny = y - step;
          if (nx >= 0 && nx < W && nnf[y * W + nx] >= 0) {
            const s = nnf[y * W + nx];
            if ((s % W) + step >= 0 && (s % W) + step < W) tryS(p, s + step);
          }
          if (ny >= 0 && ny < H && nnf[ny * W + x] >= 0) tryS(p, nnf[ny * W + x] + step * W);
          // random search around the current match, in shrinking windows
          const s0 = nnf[p];
          const sx = s0 % W;
          const sy = (s0 / W) | 0;
          for (let R = Math.max(W, H); R >= 1; R >>= 1) {
            const cx = Math.round(sx + (rand() * 2 - 1) * R);
            const cy = Math.round(sy + (rand() * 2 - 1) * R);
            if (cx < r || cy < r || cx >= W - r || cy >= H - r) continue;
            tryS(p, cy * W + cx);
          }
        }
      }
    };
    const vote = () => {
      // per-pixel mean squared difference sets how much each patch's opinion counts
      let md = 0;
      for (const p of targets) md += nnd[p];
      md = Math.max(1, md / targets.length / (P * P));
      const acc = new Float32Array(W * H * 4);
      const ws = new Float32Array(W * H);
      for (const p of targets) {
        const px = p % W;
        const py = (p / W) | 0;
        const s = nnf[p];
        const sx = s % W;
        const sy = (s / W) | 0;
        const wt = Math.exp(-nnd[p] / (P * P) / (2 * md));
        for (let dy = -r; dy <= r; dy++) {
          const qy = py + dy;
          if (qy < 0 || qy >= H) continue;
          for (let dx = -r; dx <= r; dx++) {
            const qx = px + dx;
            if (qx < 0 || qx >= W) continue;
            const q = qy * W + qx;
            if (!M[q]) continue;
            const t = ((sy + dy) * W + sx + dx) * 4;
            ws[q] += wt;
            acc[q * 4] += wt * I[t];
            acc[q * 4 + 1] += wt * I[t + 1];
            acc[q * 4 + 2] += wt * I[t + 2];
            acc[q * 4 + 3] += wt * I[t + 3];
          }
        }
      }
      for (let q = 0; q < W * H; q++) {
        if (!M[q] || !ws[q]) continue;
        for (let c = 0; c < 4; c++) I[q * 4 + c] = acc[q * 4 + c] / ws[q];
      }
    };
    const em = li === levels.length - 1 ? 5 : li === 0 ? 2 : 3;
    for (let k = 0; k < em; k++) {
      patchMatch(k === 0 ? 4 : 2);
      for (const p of targets) nnd[p] = dist(p, nnf[p], Infinity);
      vote();
      for (const p of targets) nnd[p] = dist(p, nnf[p], Infinity);
    }
    L.nnf = nnf;
    prev = L;
  }
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    for (let c = 0; c < 4; c++) data[i * 4 + c] = img[i * 4 + c];
  }
}

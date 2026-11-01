// Geometric transforms beyond scale/rotate: perspective (projective), distort, mesh warp and the warp
// presets (arc, bulge, flag…). Pixels are mapped triangle by triangle with affine draws, so any
// canvas-capable browser can do it quickly.

import { makeCanvas, setWarpRenderer, maskAlpha } from './doc.js';

// ---------------------------------------------------------------- homography

/** 3×3 matrix (row-major, h33 = 1) mapping the unit square / quad `src` onto quad `dst`. */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / (A[i][i] || 1e-12));
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det].map((v, k, arr) => v / arr[8]);
}

// ---------------------------------------------------------------- mesh drawing

/**
 * Draw `src` onto a deformed grid. pts: (rows+1)×(cols+1) points [x, y] (row-major) in output space,
 * the image of the regular source grid. Returns { canvas, x, y } (output canvas placed in doc coords).
 */
export function meshWarp(src, pts, rows, cols, { pad = 1, sx = 0, sy = 0, sw = src.width, sh = src.height, interp = 'bicubic' } = {}) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)) - pad;
  const y0 = Math.floor(Math.min(...ys)) - pad;
  const W = Math.ceil(Math.max(...xs)) - x0 + pad + 1;
  const H = Math.ceil(Math.max(...ys)) - y0 + pad + 1;
  if (W * H > 120e6) throw new Error('결과가 너무 큽니다');
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  smoothing(g, interp);
  const P = (r, c) => pts[r * (cols + 1) + c];
  const S = (r, c) => [sx + (c / cols) * sw, sy + (r / rows) * sh];
  // Neighbouring triangles share their edges exactly and their edge coverages add up: drawn
  // additively they meet without the see-through seams (or the doubled ones over semi-transparent
  // pixels) that overlapping triangles leave. Where a mesh folds over itself, the turned-over
  // triangles would add up with the ones below: they are drawn afterwards on top instead.
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let pos = 0;
  let neg = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (const v of [area(P(r, c), P(r, c + 1), P(r + 1, c)), area(P(r, c + 1), P(r + 1, c + 1), P(r + 1, c))]) {
        if (v > 1e-6) pos++;
        else if (v < -1e-6) neg++;
      }
    }
  }
  const major = pos >= neg ? 1 : -1;
  let growBy = 0;
  const tri = (s0, s1, s2, d0, d1, d2) => {
    const sa = Math.sign(area(d0, d1, d2));
    if (sa && sa !== (growBy ? -major : major)) return;
    const cx = (d0[0] + d1[0] + d2[0]) / 3;
    const cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p) => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const l = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / l) * growBy - x0, p[1] + (dy / l) * growBy - y0];
    };
    const [e0, e1, e2] = [grow(d0), grow(d1), grow(d2)];
    // affine: source → destination
    const [sx0, sy0] = s0;
    const [sx1, sy1] = s1;
    const [sx2, sy2] = s2;
    const [dx0, dy0] = [d0[0] - x0, d0[1] - y0];
    const [dx1, dy1] = [d1[0] - x0, d1[1] - y0];
    const [dx2, dy2] = [d2[0] - x0, d2[1] - y0];
    const den = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
    if (Math.abs(den) < 1e-9) return;
    const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / den;
    const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / den;
    const c = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / den;
    const d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / den;
    const e = dx0 - a * sx0 - c * sy0;
    const f = dy0 - b * sx0 - d * sy0;
    g.save();
    g.beginPath();
    g.moveTo(e0[0], e0[1]);
    g.lineTo(e1[0], e1[1]);
    g.lineTo(e2[0], e2[1]);
    g.closePath();
    g.clip();
    g.setTransform(a, b, c, d, e, f);
    g.drawImage(src, 0, 0);
    g.restore();
  };
  const pass = () => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tri(S(r, c), S(r, c + 1), S(r + 1, c), P(r, c), P(r, c + 1), P(r + 1, c));
        tri(S(r, c + 1), S(r + 1, c + 1), S(r + 1, c), P(r, c + 1), P(r + 1, c + 1), P(r + 1, c));
      }
    }
  };
  g.globalCompositeOperation = 'lighter';
  pass();
  if (pos && neg) {
    g.globalCompositeOperation = 'source-over';
    growBy = 0.6;
    pass();
  }
  return { canvas: out, x: x0, y: y0 };
}

/** Draw a w×h source onto 4 corners (TL, TR, BR, BL) with true perspective. */
export function projectiveDraw(src, corners, n = 24) {
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], corners);
  const pts = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) pts.push(applyH(H, c / n, r / n));
  return meshWarp(src, pts, n, n);
}

/** Cut a quad out of a canvas and straighten it to w×h (perspective crop). */
export function unprojectQuad(src, quad, w, h) {
  const out = makeCanvas(w, h);
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], quad);
  const sg = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const sd = sg.data;
  const img = out.getContext('2d').createImageData(w, h);
  const d = img.data;
  const SW = src.width;
  const SH = src.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = applyH(H, x + 0.5, y + 0.5);
      // bilinear sample
      const fx = u - 0.5;
      const fy = v - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const p = (xx, yy) => (xx < 0 || yy < 0 || xx >= SW || yy >= SH ? 0 : sd[(yy * SW + xx) * 4 + k]);
        d[o + k] = (p(ix, iy) * (1 - tx) + p(ix + 1, iy) * tx) * (1 - ty) + (p(ix, iy + 1) * (1 - tx) + p(ix + 1, iy + 1) * tx) * ty;
      }
    }
  }
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------- warp presets (Photoshop "뒤틀기")

export const WARP_STYLES = [
  ['none', '없음'], ['arc', '부채꼴'], ['arcLower', '아래 부채꼴'], ['arcUpper', '위 부채꼴'], ['arch', '아치'], ['bulge', '돌출'],
  ['shellLower', '아래가 넓은 조개'], ['shellUpper', '위가 넓은 조개'], ['flag', '깃발'], ['wave', '파형'], ['fish', '물고기'],
  ['rise', '상승'], ['fisheye', '물고기 눈'], ['inflate', '부풀리기'], ['squeeze', '양쪽 누르기'], ['twist', '비틀기'],
];

/**
 * Where the point (u, v) ∈ [0,1]² of a w×h box goes for a warp style. bend, h, v ∈ [-1, 1]
 * (Photoshop's percentages / 100); `vertical` swaps the axes.
 */
export function warpPoint(style, u, v, w, h, bend = 0.5, hd = 0, vd = 0, vertical = false) {
  if (vertical) {
    const [y, x] = warpPoint(style, v, u, h, w, bend, vd, hd, false);
    return [x, y];
  }
  let x = u * w;
  let y = v * h;
  const cu = u - 0.5;
  const cv = v - 0.5;
  const B = bend;
  switch (style) {
    case 'arc': case 'arcLower': case 'arcUpper': case 'arch': {
      // bend the box around a circle below (bend > 0) or above it
      const ang = B * Math.PI * 0.9;
      if (Math.abs(ang) < 1e-4) break;
      const R = w / ang;
      const t = cu * ang;
      const r = R + (0.5 - v) * h;
      const ax = w / 2 + Math.sin(t) * r;
      const ay = h / 2 + R - Math.cos(t) * r;
      if (style === 'arc') [x, y] = [ax, ay];
      else if (style === 'arch') y = ay;
      else {
        // only one edge bends; the other stays straight
        const k = style === 'arcLower' ? v : 1 - v;
        x = u * w + (ax - u * w) * k;
        y = v * h + (ay - v * h) * k;
      }
      break;
    }
    case 'bulge': {
      const k = 1 + B * 0.6 * Math.cos(cu * Math.PI);
      y = h / 2 + cv * h * k;
      break;
    }
    case 'shellLower': y = v * h + B * h * 0.5 * v * Math.cos(cu * Math.PI); break;
    case 'shellUpper': y = v * h - B * h * 0.5 * (1 - v) * Math.cos(cu * Math.PI); break;
    case 'flag': y = v * h + B * h * 0.25 * Math.sin(u * Math.PI * 2); break;
    case 'wave': y = v * h + B * h * 0.25 * Math.sin(u * Math.PI * 2 + v * Math.PI); break;
    case 'fish': y = h / 2 + cv * h * (1 + B * 0.5 * Math.sin(u * Math.PI)) + B * h * 0.1 * Math.sin(u * Math.PI * 2); break;
    case 'rise': y = v * h - B * h * 0.4 * (u - 0.5) * 2; break;
    case 'fisheye': {
      const r = Math.hypot(cu, cv);
      const k = 1 + B * 0.6 * Math.max(0, 1 - r * 2);
      x = w / 2 + cu * w * k;
      y = h / 2 + cv * h * k;
      break;
    }
    case 'inflate': {
      const k = 1 + B * 0.4 * Math.cos(cu * Math.PI) * Math.cos(cv * Math.PI);
      x = w / 2 + cu * w * k;
      y = h / 2 + cv * h * k;
      break;
    }
    case 'squeeze': {
      const k = 1 - B * 0.4 * Math.cos(cv * Math.PI);
      x = w / 2 + cu * w * k;
      const k2 = 1 + B * 0.3 * Math.cos(cu * Math.PI);
      y = h / 2 + cv * h * k2;
      break;
    }
    case 'twist': {
      const a = B * Math.PI * 0.5 * (1 - Math.min(1, Math.hypot(cu, cv) * 2));
      x = w / 2 + cu * w * Math.cos(a) - cv * h * Math.sin(a);
      y = h / 2 + cu * w * Math.sin(a) + cv * h * Math.cos(a);
      break;
    }
    default: break;
  }
  // perspective-like horizontal / vertical distortion
  if (hd) {
    const k = 1 + hd * (u - 0.5) * 1.2;
    y = h / 2 + (y - h / 2) * k;
  }
  if (vd) {
    const k = 1 + vd * (v - 0.5) * 1.2;
    x = w / 2 + (x - w / 2) * k;
  }
  return [x, y];
}

/** Grid points for a preset warp of a w×h box placed at (ox, oy). */
export function warpGrid(warp, w, h, ox = 0, oy = 0, n = 16) {
  const pts = [];
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const [x, y] = warpPoint(warp.style, c / n, r / n, w, h, (warp.bend ?? 50) / 100, (warp.h ?? 0) / 100, (warp.v ?? 0) / 100, !!warp.vertical);
      pts.push([ox + x, oy + y]);
    }
  }
  return pts;
}

// ---------------------------------------------------------------- custom warp grids

/** Interpolation (Photoshop's 보간): nearest neighbour, bilinear or bicubic. */
export function smoothing(g, interp = 'bicubic') {
  g.imageSmoothingEnabled = interp !== 'nearest';
  g.imageSmoothingQuality = interp === 'bilinear' ? 'low' : 'high';
}

const bern = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
const evenSplits = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);

/**
 * A custom warp is a grid of rows × cols cubic Bézier patches sharing their edges: (3·rows+1) ×
 * (3·cols+1) control points (doc coords, row-major). Every 3rd point is an anchor on a grid line
 * crossing, the ones between are handles. us / vs: where the grid lines sit in the source (0..1).
 */
export function warpDims(w) {
  const R = w.rows || 1;
  const C = w.cols || 1;
  return { R, C, N: 3 * C + 1, us: w.us || evenSplits(C), vs: w.vs || evenSplits(R) };
}

/** The warped position of source point (u, v) ∈ [0,1]². */
export function evalWarp(w, u, v) {
  const { R, C, N, us, vs } = warpDims(w);
  let j = 0;
  while (j < C - 1 && u > us[j + 1]) j++;
  let i = 0;
  while (i < R - 1 && v > vs[i + 1]) i++;
  const bu = bern((u - us[j]) / (us[j + 1] - us[j] || 1));
  const bv = bern((v - vs[i]) / (vs[i + 1] - vs[i] || 1));
  let X = 0;
  let Y = 0;
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      const p = w.ctrl[(3 * i + a) * N + 3 * j + b];
      const k = bv[a] * bu[b];
      X += p[0] * k;
      Y += p[1] * k;
    }
  }
  return [X, Y];
}

/** Mesh resolution for a warp grid. */
export const warpRes = (w) => Math.min(48, Math.max(16, 6 * Math.max(w?.rows || 1, w?.cols || 1)));

/** The warp evaluated on an (n+1)×(n+1) grid (doc coords). */
export function warpMesh(w, n = warpRes(w)) {
  const pts = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) pts.push(evalWarp(w, c / n, r / n));
  return pts;
}

/** Custom warp: a 4×4 Bézier patch (16 control points, doc coords) evaluated on a grid. */
export function patchGrid(ctrl, n = 16) {
  return warpMesh({ ctrl }, n);
}

/** The 16 control points of an undeformed w×h box at (x, y). */
export function flatPatch(x, y, w, h) {
  const out = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push([x + (j / 3) * w, y + (i / 3) * h]);
  return out;
}

/** The same grid with rows and columns swapped (so splitting rows can reuse splitting columns). */
function transposeWarp(w) {
  const { R, C, N, us, vs } = warpDims(w);
  const M = 3 * R + 1;
  const ctrl = [];
  for (let c = 0; c < N; c++) for (let r = 0; r < M; r++) ctrl.push(w.ctrl[r * N + c]);
  return { ...w, ctrl, rows: C, cols: R, us: vs, vs: us };
}

/** Split the grid with a vertical line at source u (exact: the picture doesn't change). */
function splitCols(w, U) {
  const { R, C, N, us } = warpDims(w);
  let j = 0;
  while (j < C - 1 && U > us[j + 1]) j++;
  const span = us[j + 1] - us[j];
  const s = (U - us[j]) / (span || 1);
  // too close to a line that is already there
  if (s * span < 0.02 || (1 - s) * span < 0.02) return w;
  const L = (a, b) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const ctrl = [];
  for (let r = 0; r < 3 * R + 1; r++) {
    const row = w.ctrl.slice(r * N, (r + 1) * N);
    const [p0, p1, p2, p3] = row.slice(3 * j, 3 * j + 4);
    const p01 = L(p0, p1);
    const p12 = L(p1, p2);
    const p23 = L(p2, p3);
    const p012 = L(p01, p12);
    const p123 = L(p12, p23);
    ctrl.push(...row.slice(0, 3 * j + 1), p01, p012, L(p012, p123), p123, p23, ...row.slice(3 * j + 3));
  }
  return { ...w, ctrl, cols: C + 1, us: [...us.slice(0, j + 1), U, ...us.slice(j + 1)], vs: warpDims(w).vs };
}

/** Split a custom warp: 'v' adds a vertical line at u, 'h' a horizontal one at v, 'cross' both. */
export function splitWarp(w, how, u, v) {
  let out = { ...w, us: warpDims(w).us, vs: warpDims(w).vs };
  if (how === 'v' || how === 'cross') out = splitCols(out, u);
  if (how === 'h' || how === 'cross') out = transposeWarp(splitCols(transposeWarp(out), v));
  return out;
}

/** An n×n grid made from the current one (Photoshop's 격자 3 x 3, 4 x 4, 5 x 5): exact splits. */
export function gridWarp(w, n) {
  let out = { ...w, us: warpDims(w).us, vs: warpDims(w).vs };
  for (let k = 1; k < n; k++) {
    if (!out.us.some((x) => Math.abs(x - k / n) < 1e-6)) out = splitCols(out, k / n);
    if (!out.vs.some((x) => Math.abs(x - k / n) < 1e-6)) out = transposeWarp(splitCols(transposeWarp(out), k / n));
  }
  return out;
}

// smart objects with distort/perspective corners or a warp
setWarpRenderer((src, s) => {
  if (s.warp?.ctrl) {
    const n = warpRes(s.warp);
    return meshWarp(src, warpMesh(s.warp, n), n, n);
  }
  if (s.warp?.style && s.warp.style !== 'none') {
    // preset warp inside the transformed box (affine, or perspective corners)
    const H = s.corners ? homography([[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]], s.corners) : null;
    const [a, b, c, d, e, f] = s.m;
    const grid = warpGrid(s.warp, s.w, s.h, 0, 0).map(([x, y]) => (H ? applyH(H, x, y) : [a * x + c * y + e, b * x + d * y + f]));
    return meshWarp(src, grid, 16, 16);
  }
  return projectiveDraw(src, s.corners);
});

// ---------------------------------------------------------------- the transform box (Ctrl+T)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const rotAbout = (p, c, ang) => {
  const s = Math.sin(ang);
  const co = Math.cos(ang);
  const d = sub(p, c);
  return [c[0] + d[0] * co - d[1] * s, c[1] + d[0] * s + d[1] * co];
};
/** Is the quad (TL, TR, BR, BL) a parallelogram (an affine image of the box)? */
export const isAffineQuad = (q, eps = 0.5) => len(sub(add(q[1], q[3]), add(q[0], q[2]))) < eps;
/** The affine matrix [a b c d e f] taking the w×h box onto the parallelogram q. */
export function quadAffine(q, w, h) {
  const ex = mul(sub(q[1], q[0]), 1 / w);
  const ey = mul(sub(q[3], q[0]), 1 / h);
  return [ex[0], ex[1], ey[0], ey[1], q[0][0], q[0][1]];
}
const applyM = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export const TRANSFORM_MODES = [['free', '자유 변형'], ['skew', '기울이기'], ['distort', '왜곡'], ['perspective', '원근'], ['warp', '뒤틀기']];

const near = (a, b, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

/**
 * Transform the active layer (pixels, smart object, shape path, text, group), its mask, or the
 * selection. State: the 4 corners of the source box, a pivot (the reference point), and an optional
 * warp (a preset {style, bend, h, v} or a custom grid of Bézier patches in doc coords).
 * opts.copy: transform a copy of the selected pixels (the originals stay, Ctrl+Alt+T).
 */
export class Transformer {
  constructor(E, { mode = 'free', target = 'auto', copy = false } = {}) {
    this.E = E;
    this.mode = mode;
    this.copy = !!copy;
    const doc = E.doc;
    const l = doc.active;
    this.layer = l;
    this.before = doc.capture();
    this.warp = null;
    // with the mask thumbnail picked, Photoshop still transforms the layer and its linked masks together;
    // only an unlinked mask (or one on a layer with nothing else to move, or selected mask pixels) goes alone
    const maskOnly = E.editMask && l?.mask && (l.mask.linked === false || !!doc.selection || !['raster', 'smart', 'shape', 'text', 'group'].includes(l.kind) || (l.kind === 'raster' && (!l.canvas || !doc.opaqueBounds(l))));
    this.kind = target === 'selection' ? 'selection' : maskOnly ? 'mask' : l?.kind === 'smart' ? 'smart' : l?.kind === 'shape' ? 'shape' : l?.kind === 'text' ? 'text' : l?.kind === 'group' ? 'group' : 'pixels';
    if (this.kind !== 'selection' && (!l || l.kind === 'adjust' || l.kind === 'fill')) throw new Error('변형할 레이어를 선택하세요 (칠·조정 레이어는 마스크를 고른 뒤 변형합니다)');
    if (this.kind !== 'selection' && (l.locked || l.lockPos)) throw new Error('위치가 잠긴 레이어입니다');
    let box;
    if (this.kind === 'smart') {
      const s = l.smart;
      this.src = l.smartSrc;
      box = { w: s.w, h: s.h };
      this.q0 = s.corners ? s.corners.map((p) => [...p]) : [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]].map((p) => applyM(s.m, p));
      if (s.warp) this.warp = structuredClone(s.warp);
    } else if (this.kind === 'text') {
      const t = l.text;
      const L = E.textBox(l);
      box = { w: L.w, h: L.h };
      this.t0 = { ...t, x: l.x, y: l.y, rotation: l.rotation || 0, skewX: l.skewX || 0 };
      const c = [l.x + L.w / 2, l.y + L.h / 2];
      const r = ((l.rotation || 0) * Math.PI) / 180;
      this.q0 = [[l.x, l.y], [l.x + L.w, l.y], [l.x + L.w, l.y + L.h], [l.x, l.y + L.h]].map((p) => rotAbout(p, c, r));
    } else if (this.kind === 'shape') {
      this.sps0 = E.shapePathDoc(l);
      const b = E.pathBounds(this.sps0) || { x: l.x, y: l.y, w: 1, h: 1 };
      box = { w: Math.max(1, b.w), h: Math.max(1, b.h) };
      this.box0 = b;
      this.q0 = [[b.x, b.y], [b.x + box.w, b.y], [b.x + box.w, b.y + box.h], [b.x, b.y + box.h]];
    } else if (this.kind === 'group') {
      const b = doc.bounds(l);
      if (!b) throw new Error('빈 그룹입니다');
      box = { w: b.w, h: b.h };
      this.box0 = b;
      this.q0 = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    } else {
      // pixels of a layer, its mask, or the selection: lift them into a floating canvas
      const lifted = this.lift();
      this.src = lifted.canvas;
      box = { w: lifted.canvas.width, h: lifted.canvas.height };
      this.q0 = [[lifted.x, lifted.y], [lifted.x + box.w, lifted.y], [lifted.x + box.w, lifted.y + box.h], [lifted.x, lifted.y + box.h]];
    }
    this.w = box.w;
    this.h = box.h;
    this.q = this.q0.map((p) => [...p]);
    this.pivot = this.center();
    this.warp0 = this.warp ? JSON.stringify(this.warp) : null;
    if (this.warp?.ctrl) this.warp.ctrl = this.warp.ctrl.map((p) => [...p]);
    if (this.kind === 'text' && mode !== 'free' && mode !== 'skew') {
      E.toast(mode === 'warp' ? '글자는 문자 ▸ 텍스트 뒤틀기로 휘게 합니다' : '글자 레이어는 왜곡·원근을 할 수 없습니다 (래스터화하거나 고급 개체로 바꾼 뒤 변형하세요)');
      this.mode = mode = 'free';
    }
    if (mode === 'warp') this.startWarp();
    this.setupMasks();
    this.update();
  }

  // ---------------------------------------------------------------- masks that go along

  /**
   * The masks linked to the layer (layer mask, vector mask, smart filter mask) take the same mapping
   * as the layer, as in Photoshop (the chain between the thumbnails). Not when the mask itself is the
   * target. For pixels lifted out of a selection, the selected part of a linked raster mask goes along
   * with them (vector masks stay where they are then).
   */
  setupMasks() {
    const l = this.layer;
    this.carry = [];
    if (!l || !['pixels', 'smart', 'shape', 'text', 'group'].includes(this.kind) || this.copy) return;
    this.sel0 = this.selLift ? this.E.doc.selection?.canvas || null : null;
    if (this.selLift && !this.sel0) return;
    for (const key of ['mask', 'filterMask', 'vmask']) {
      const m = l[key];
      if (!m || m.linked === false || (key === 'vmask' ? !m.subpaths?.length : !m.canvas)) continue;
      if (this.sel0 && key === 'vmask') continue;
      this.carry.push({ key, m0: m, reveal: key === 'vmask' ? null : maskReveals(m) });
    }
    if (!this.carry.length) return;
    // doc → source box (local coords), and the box's own affine when it has one
    this.H0i = invertH(homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q0));
    this.m0 = isAffineQuad(this.q0) ? quadAffine(this.q0, this.w, this.h) : null;
  }

  /** The whole change as one doc-space affine, or null (distort, perspective, warp). */
  docAffine() {
    const m = this.affine();
    return m && this.m0 ? composeM(m, invertM(this.m0)) : null;
  }

  /** Where a document point goes (any mode). */
  docMap(p) {
    const [u, v] = applyH(this.H0i, p[0], p[1]);
    return this.mapPoint(u, v);
  }

  /** Move the carried masks to match the current box (live while dragging; fine: the final quality). */
  updateMasks(fine = false) {
    if (!this.carry?.length) return;
    const l = this.layer;
    const doc = this.E.doc;
    const same = this.q.every((p, i) => near(p, this.q0[i], 1e-6)) && (this.warp ? JSON.stringify(this.warp) : null) === this.warp0;
    const T = same ? null : this.docAffine();
    let selMoved = null;
    for (const c of this.carry) {
      if (same) l[c.key] = c.m0;
      else if (this.sel0) {
        // pixels lifted out of a selection: the mask's selected part moves with them
        selMoved ||= this.tryRender(this.selBoxSource(this.sel0, this.selBox ||= {}), fine);
        const canvas = selMoved && this.selMaskCanvas(c, selMoved, fine);
        if (canvas) l[c.key] = { ...c.m0, canvas, x: 0, y: 0 };
      } else if (c.key === 'vmask') l.vmask = mapVmask(c.m0, T ? (p) => applyM(T, p) : (p) => this.docMap(p));
      else {
        // while dragging an affine change redraws into one buffer; the final one gets its own canvas
        const canvas = T ? mapMaskCanvas(c.m0, T, doc.width, doc.height, c.reveal, fine ? undefined : (c.buf ||= makeCanvas(doc.width, doc.height))) : this.warpMaskCanvas(c, fine);
        if (canvas) l[c.key] = { ...c.m0, canvas, x: 0, y: 0 };
      }
    }
    l._styled = null;
    doc.touch(l);
  }

  /** A doc-size canvas cut to the lifted box (kept in cache.canvas): the source for renderSource. */
  selBoxSource(docCanvas, cache) {
    if (cache.canvas) return cache.canvas;
    const c = makeCanvas(this.w, this.h);
    c.getContext('2d').drawImage(docCanvas, -this.q0[0][0], -this.q0[0][1]);
    return (cache.canvas = c);
  }

  /**
   * A raster mask when selected pixels move: as it was, except where the moved selection lands,
   * which takes the moved mask (the mask's selected part, mapped like the pixels).
   */
  selMaskCanvas(c, selMoved, fine) {
    const doc = this.E.doc;
    if (!c.base) {
      c.base = maskDocBase(doc, c.m0, c.reveal);
      c.part = {};
      this.selBoxSource(maskPart(c.base, this.sel0), c.part);
    }
    const r = this.tryRender(c.part.canvas, fine);
    if (!r) return null;
    const out = fine ? makeCanvas(doc.width, doc.height) : (c.buf ||= makeCanvas(doc.width, doc.height));
    return landMaskPart(out, c.base, selMoved, r);
  }

  /** A raster mask through a non-affine change (the part over the box; outside it the mask's edge colour). */
  warpMaskCanvas(c, fine) {
    const doc = this.E.doc;
    c.src ||= this.boxSource(c.m0);
    const r = this.tryRender(c.src, fine);
    if (!r) return null;
    const out = makeCanvas(doc.width, doc.height);
    const g = out.getContext('2d');
    if (c.reveal) {
      // outside the warped box: shown (a white mask's edge)
      const n = 16;
      const outline = [];
      for (let i = 0; i < n; i++) outline.push(this.mapPoint((i / n) * this.w, 0));
      for (let i = 0; i < n; i++) outline.push(this.mapPoint(this.w, (i / n) * this.h));
      for (let i = n; i > 0; i--) outline.push(this.mapPoint((i / n) * this.w, this.h));
      for (let i = n; i > 0; i--) outline.push(this.mapPoint(0, (i / n) * this.h));
      g.beginPath();
      g.rect(0, 0, out.width, out.height);
      outline.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill('evenodd');
    }
    g.drawImage(r.canvas, r.x, r.y);
    return out;
  }

  /** The mask laid out on the source box (as the layer's pixels are), for warps and perspective. */
  boxSource(m) {
    const q = this.q0;
    const dw = q[1][0] - q[0][0];
    const dh = q[3][1] - q[0][1];
    if (q[0][1] === q[1][1] && q[1][0] === q[2][0] && q[2][1] === q[3][1] && q[3][0] === q[0][0] && dw > 0 && dh > 0) {
      const c = makeCanvas(Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)));
      const g = c.getContext('2d');
      g.scale(c.width / dw, c.height / dh);
      g.drawImage(m.canvas, m.x - q[0][0], m.y - q[0][1]);
      return c;
    }
    // a turned or distorted box: straighten it (at about its size on the page)
    const sw = Math.max(1, Math.round(Math.min(this.w, Math.max(len(sub(q[1], q[0])), len(sub(q[2], q[3]))))));
    const sh = Math.max(1, Math.round(Math.min(this.h, Math.max(len(sub(q[3], q[0])), len(sub(q[2], q[1]))))));
    return unprojectQuad(m.canvas, q.map(([x, y]) => [x - m.x, y - m.y]), sw, sh);
  }

  /** The floating pixels as they will look: through the layer's (moved or unlinked) masks. */
  maskedFloat(r) {
    const l = this.layer;
    const doc = this.E.doc;
    const mask = l.mask?.canvas && l.mask.enabled;
    const vmask = l.vmask?.subpaths?.length && l.vmask.enabled !== false && this.E.vectorMaskCanvas;
    if (!mask && !vmask) return r;
    const c = makeCanvas(r.canvas.width, r.canvas.height);
    const g = c.getContext('2d');
    g.drawImage(r.canvas, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    if (mask) g.drawImage(maskAlpha(doc, l.mask), -r.x, -r.y);
    if (vmask) g.drawImage(this.E.vectorMaskCanvas(l), -r.x, -r.y);
    return { ...r, canvas: c };
  }

  /** Photoshop's interpolation choice for this transform (bicubic unless set). */
  get interp() {
    return this.E.transformInterp || 'bicubic';
  }

  /** Cut the pixels being transformed out of their layer (or mask / selection). */
  lift() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    const W = doc.width;
    const H = doc.height;
    const full = makeCanvas(W, H);
    const fg = full.getContext('2d');
    if (this.kind === 'selection') {
      if (!doc.selection) throw new Error('선택 영역이 없습니다');
      fg.drawImage(doc.selection.canvas, 0, 0);
    } else if (this.kind === 'mask') {
      fg.drawImage(l.mask.canvas, l.mask.x, l.mask.y);
    } else {
      if (l.kind !== 'raster' || !l.canvas) throw new Error('이 레이어는 변형할 수 없습니다');
      // a layer reaching past the canvas: all of it (the parts outside would be lost otherwise)
      if (!doc.selection && (l.x < 0 || l.y < 0 || l.x + l.canvas.width > W || l.y + l.canvas.height > H)) {
        const b = alphaBoxLocal(l.canvas);
        if (!b) throw new Error('레이어가 비어 있습니다');
        const c = makeCanvas(b.w, b.h);
        c.getContext('2d').drawImage(l.canvas, -b.x, -b.y);
        // where it was (clearing below grows the layer to the page and moves its origin)
        const at = { canvas: c, x: l.x + b.x, y: l.y + b.y };
        if (!this.copy) {
          const g = doc.editPixels(l);
          g.clearRect(0, 0, g.canvas.width, g.canvas.height);
        }
        return at;
      }
      fg.drawImage(l.canvas, l.x, l.y);
      if (doc.selection) {
        fg.globalCompositeOperation = 'destination-in';
        fg.drawImage(doc.selection.canvas, 0, 0);
        this.selLift = true;
      }
    }
    const b = alphaBoxLocal(full);
    if (!b) throw new Error(this.kind === 'selection' ? '선택 영역이 비어 있습니다' : '레이어가 비어 있습니다');
    const c = makeCanvas(b.w, b.h);
    c.getContext('2d').drawImage(full, -b.x, -b.y);
    // take them out of the source (a copy leaves them)
    if (this.kind === 'pixels' && !this.copy) {
      const g = doc.editPixels(l);
      g.save();
      if (doc.selection) {
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(doc.selection.canvas, -l.x, -l.y);
      } else g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      g.restore();
    } else if (this.kind === 'mask') {
      const g = doc.editMask(l);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    }
    return { canvas: c, x: b.x, y: b.y };
  }

  center() {
    const q = this.q;
    return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
  }

  /** A flat custom warp grid (1 patch) lying on the current box. */
  flatWarp() {
    const H = homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q);
    return { style: 'custom', rows: 1, cols: 1, ctrl: flatPatch(0, 0, this.w, this.h).map(([x, y]) => applyH(H, x, y)) };
  }

  startWarp() {
    this.mode = 'warp';
    if (!this.warp) this.warp = { style: 'custom' };
    if (this.warp.style === 'custom' && !this.warp.ctrl) this.warp = this.flatWarp();
  }

  /** The output mesh for pixel-type sources. */
  grid(n = 16) {
    if (this.warp?.ctrl) return warpMesh(this.warp, n);
    const H = homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q);
    if (this.warp?.style && this.warp.style !== 'none' && this.warp.style !== 'custom') {
      return warpGrid(this.warp, this.w, this.h, 0, 0, n).map(([x, y]) => applyH(H, x, y));
    }
    const pts = [];
    for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) pts.push(applyH(H, (c / n) * this.w, (r / n) * this.h));
    return pts;
  }

  /** Map one point of the source box (local coords) to the document. */
  mapPoint(x, y) {
    if (this.warp?.ctrl) return evalWarp(this.warp, x / this.w, y / this.h);
    const H = homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q);
    if (this.warp?.style && this.warp.style !== 'none' && this.warp.style !== 'custom') {
      const [wx, wy] = warpPoint(this.warp.style, x / this.w, y / this.h, this.w, this.h, (this.warp.bend ?? 50) / 100, (this.warp.h ?? 0) / 100, (this.warp.v ?? 0) / 100, !!this.warp.vertical);
      return applyH(H, wx, wy);
    }
    return applyH(H, x, y);
  }

  /** The source point (u, v ∈ [0,1]) of a custom warp that lands nearest to p, or null outside it. */
  warpUV(p) {
    if (!this.warp?.ctrl) return null;
    const n = 24;
    const mesh = warpMesh(this.warp, n);
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < mesh.length; i++) {
      const d = (mesh[i][0] - p[0]) ** 2 + (mesh[i][1] - p[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    let u = (best % (n + 1)) / n;
    let v = Math.floor(best / (n + 1)) / n;
    // refine with a few Gauss-Newton steps on the surface
    for (let it = 0; it < 8; it++) {
      const e = 1e-3;
      const f = evalWarp(this.warp, u, v);
      const fu = evalWarp(this.warp, Math.min(1, u + e), v);
      const fv = evalWarp(this.warp, u, Math.min(1, v + e));
      const a = (fu[0] - f[0]) / e;
      const b = (fv[0] - f[0]) / e;
      const c = (fu[1] - f[1]) / e;
      const d = (fv[1] - f[1]) / e;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-9) break;
      const rx = p[0] - f[0];
      const ry = p[1] - f[1];
      u = Math.max(0, Math.min(1, u + (d * rx - b * ry) / det));
      v = Math.max(0, Math.min(1, v + (-c * rx + a * ry) / det));
    }
    const f = evalWarp(this.warp, u, v);
    const tol = 6 / this.E.view.zoom;
    if (Math.hypot(f[0] - p[0], f[1] - p[1]) > tol) return null;
    return [u, v];
  }

  affine() {
    return !this.warp && isAffineQuad(this.q) ? quadAffine(this.q, this.w, this.h) : null;
  }

  /** Draw the source into a canvas placed in doc coords. */
  renderSource(src, fine = true) {
    const m = this.affine();
    if (m) {
      const xs = this.q.map((p) => p[0]);
      const ys = this.q.map((p) => p[1]);
      const x0 = Math.floor(Math.min(...xs));
      const y0 = Math.floor(Math.min(...ys));
      const c = makeCanvas(Math.ceil(Math.max(...xs)) - x0 + 1, Math.ceil(Math.max(...ys)) - y0 + 1);
      const g = c.getContext('2d');
      smoothing(g, this.interp);
      g.setTransform(m[0] * (this.w / src.width), m[1] * (this.w / src.width), m[2] * (this.h / src.height), m[3] * (this.h / src.height), m[4] - x0, m[5] - y0);
      g.drawImage(src, 0, 0);
      return { canvas: c, x: x0, y: y0 };
    }
    const n = this.warp?.ctrl ? (fine ? warpRes(this.warp) : Math.max(12, warpRes(this.warp) >> 1)) : fine ? 24 : 12;
    // the mesh is in source-pixel space: scale the box grid to the source size
    const pts = this.grid(n);
    return meshWarp(src, pts, n, n, { sw: src.width, sh: src.height, interp: this.interp });
  }

  /** The live preview; a shape too big to draw keeps the last one shown. */
  tryRender(src, fine) {
    try {
      return this.renderSource(src, fine);
    } catch {
      return null;
    }
  }

  /** Show the transform live. */
  update(fine = false) {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    this.updateMasks(fine);
    if (this.kind === 'smart') {
      const m = this.affine();
      l.smart = { ...l.smart, m: m ? [m[0] * (this.w / l.smart.w), m[1] * (this.w / l.smart.w), m[2] * (this.h / l.smart.h), m[3] * (this.h / l.smart.h), m[4], m[5]] : l.smart.m, corners: m ? null : this.q.map((p) => [...p]), warp: this.warp ? structuredClone(this.warp) : null };
      doc.touch(l);
    } else if (this.kind === 'shape') {
      E.setShapePathDoc(l, this.mapPaths(this.sps0));
    } else if (this.kind === 'text') {
      this.applyText();
    } else if (this.kind === 'group') {
      // live preview: a float of the whole group, applied to the children on Enter
      if (!this.groupSrc) {
        const pic = doc.rasterizeLayer(l, { withOpacity: true });
        const b = this.box0;
        this.groupSrc = makeCanvas(b.w, b.h);
        this.groupSrc.getContext('2d').drawImage(pic, -b.x, -b.y);
        this.groupHidden = l.visible;
        l.visible = false;
        doc.touch(l);
      }
      const r = this.tryRender(this.groupSrc, fine);
      if (r) E.float = { ...r, layerId: null, above: true };
    } else {
      let r = this.tryRender(this.src, fine);
      // the layer's masks show on the floating pixels already (no mismatch until Enter)
      if (r && this.kind === 'pixels') r = this.maskedFloat(r);
      if (r) E.float = { ...r, layerId: this.kind === 'pixels' ? l.id : null, above: this.kind !== 'pixels', tint: this.kind === 'selection' ? 'selection' : this.kind === 'mask' ? 'mask' : null };
    }
    E.transformChanged?.(this);
    E.redraw();
  }

  mapPaths(sps) {
    const b = this.box0;
    return sps.map((sp) => ({
      ...sp,
      knots: sp.knots.map((k) => ({ ...k, p: this.mapPoint(k.p[0] - b.x, k.p[1] - b.y), in: this.mapPoint(k.in[0] - b.x, k.in[1] - b.y), out: this.mapPoint(k.out[0] - b.x, k.out[1] - b.y) })),
    }));
  }

  /** Text only takes scale, rotation and skew (distortions need warp text or rasterizing). */
  applyText() {
    const l = this.layer;
    const t0 = this.t0;
    const q = this.q;
    const top = sub(q[1], q[0]);
    const left = sub(q[3], q[0]);
    const sx = len(top) / this.w;
    const ang = Math.atan2(top[1], top[0]);
    const nrm = [-Math.sin(ang), Math.cos(ang)];
    const sy = Math.abs(dot(left, nrm)) / this.h;
    const skew = Math.atan2(dot(left, unit(top)), dot(left, nrm));
    l.text = { ...l.text, size: Math.max(1, Math.round(t0.size * sy * 10) / 10), hScale: Math.max(1, Math.round((t0.hScale ?? 100) * (sx / (sy || 1)))), box: t0.box ? { w: Math.max(4, Math.round(t0.box.w * sx)), h: Math.max(4, Math.round(t0.box.h * sy)) } : null };
    l.rotation = Math.round((ang * 180) / Math.PI * 10) / 10;
    l.skewX = Math.round((skew * 180) / Math.PI * 10) / 10;
    const L = this.E.textBox(l);
    const c = this.center();
    l.x = Math.round(c[0] - L.w / 2);
    l.y = Math.round(c[1] - L.h / 2);
    this.E.doc.touch(l);
  }

  // ---------------------------------------------------------------- interaction

  handles() {
    const q = this.q;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return { c0: q[0], c1: q[1], c2: q[2], c3: q[3], e0: mid(q[0], q[1]), e1: mid(q[1], q[2]), e2: mid(q[2], q[3]), e3: mid(q[3], q[0]), pivot: this.pivot };
  }

  /** Indices of the warp control points shown (and dragged): all 16 on one patch, else anchors and handles. */
  warpPoints() {
    const { R, C, N } = warpDims(this.warp);
    const out = [];
    for (let r = 0; r <= 3 * R; r++) {
      for (let c = 0; c <= 3 * C; c++) {
        if (R * C > 1 && r % 3 && c % 3) continue;
        out.push(r * N + c);
      }
    }
    return out;
  }

  hit(p) {
    const tol = 9 / this.E.view.zoom;
    const pt = [p.x, p.y];
    this.hoverPt = pt;
    if (this.mode === 'warp' && this.warp?.ctrl) {
      if (this.splitMode) return this.warpUV(pt) ? 'split' : 'none';
      let best = null;
      let bd = tol;
      for (const i of this.warpPoints()) {
        const d = len(sub(this.warp.ctrl[i], pt));
        if (d < bd) {
          bd = d;
          best = `w${i}`;
        }
      }
      if (best) return best;
      return this.warpUV(pt) ? 'mesh' : 'none';
    }
    const hs = this.handles();
    if (len(sub(hs.pivot, pt)) < tol && this.mode === 'free') return 'pivot';
    for (const k of ['c0', 'c1', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3']) if (len(sub(hs[k], pt)) < tol) return k;
    if (pointInQuad(pt, this.q)) return 'move';
    return this.mode === 'free' ? 'rotate' : 'none';
  }

  down(p, e = {}) {
    const h = this.hit(p);
    // Split Warp: a click on the grid adds the line(s) there
    if (h === 'split') {
      const uv = this.warpUV([p.x, p.y]);
      if (uv) {
        this.warp = splitWarp(this.warp, this.splitMode, uv[0], uv[1]);
        this.splitMode = null;
        this.update(true);
        this.E.emit?.('transform');
      }
      this.d = null;
      return;
    }
    this.d = { h, a: [p.x, p.y], q: this.q.map((x) => [...x]), pivot: [...this.pivot], ctrl: this.warp?.ctrl?.map((x) => [...x]), uv: h === 'mesh' ? this.warpUV([p.x, p.y]) : null, e };
  }

  move(p, e = {}) {
    const d = this.d;
    if (!d || d.h === 'none') return;
    const pt = [p.x, p.y];
    const delta = sub(pt, d.a);
    const q = d.q.map((x) => [...x]);
    const h = d.h;
    let mode = this.mode;
    let sym = false;
    // Photoshop's modifiers in free transform: Ctrl distorts (Ctrl+Alt: about the centre),
    // Ctrl+Shift on a side skews, Ctrl+Alt+Shift on a corner sets perspective
    if (mode === 'free' && (e.ctrlKey || e.metaKey) && (h[0] === 'c' || h[0] === 'e') && h.length === 2) {
      if (e.altKey && e.shiftKey && h[0] === 'c') mode = 'perspective';
      else if (e.shiftKey && h[0] === 'e') mode = 'skew';
      else {
        mode = 'distort';
        sym = !!e.altKey;
      }
    }
    if (h.startsWith('w')) {
      this.dragWarpPoint(+h.slice(1), delta);
      this.update();
      return;
    }
    if (h === 'mesh') {
      this.dragMesh(d.uv, delta);
      this.update();
      return;
    }
    if (h === 'move') {
      this.q = q.map((x) => add(x, delta));
      this.pivot = add(d.pivot, delta);
      if (this.warp?.ctrl) this.warp.ctrl = d.ctrl.map((x) => add(x, delta));
    } else if (h === 'pivot') {
      this.pivot = add(d.pivot, delta);
      this.E.transformChanged?.(this);
      return this.E.redraw();
    } else if (h === 'rotate') {
      let ang = Math.atan2(pt[1] - d.pivot[1], pt[0] - d.pivot[0]) - Math.atan2(d.a[1] - d.pivot[1], d.a[0] - d.pivot[0]);
      if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      this.q = q.map((x) => rotAbout(x, d.pivot, ang));
    } else if (mode === 'distort') {
      const i = +h[1];
      const move = (j, v) => {
        q[j % 4] = add(q[j % 4], v);
      };
      if (h[0] === 'c') {
        move(i, delta);
        if (sym) move(i + 2, mul(delta, -1));
      } else {
        move(i, delta);
        move(i + 1, delta);
        if (sym) {
          move(i + 2, mul(delta, -1));
          move(i + 3, mul(delta, -1));
        }
      }
      this.q = q;
    } else if (mode === 'skew') {
      if (h[0] === 'e') {
        // slide the edge along its own direction
        const i = +h[1];
        const dir = unit(sub(q[(i + 1) % 4], q[i]));
        const k = dot(delta, dir);
        q[i] = add(q[i], mul(dir, k));
        q[(i + 1) % 4] = add(q[(i + 1) % 4], mul(dir, k));
        if (e.altKey) {
          const o = (i + 2) % 4;
          q[o] = sub(q[o], mul(dir, k));
          q[(o + 1) % 4] = sub(q[(o + 1) % 4], mul(dir, k));
        }
      } else {
        const i = +h[1];
        const along = unit(sub(q[i ^ 1], q[i]));
        q[i] = add(q[i], mul(along, dot(delta, along)));
      }
      this.q = q;
    } else if (mode === 'perspective') {
      if (h[0] === 'c') {
        const i = +h[1];
        // the partner corner on the edge the drag follows moves the opposite way
        const hEdge = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : 2;
        const vEdge = i === 0 ? 3 : i === 3 ? 0 : i === 1 ? 2 : 1;
        const hd = unit(sub(q[hEdge], q[i]));
        const vd = unit(sub(q[vEdge], q[i]));
        if (Math.abs(dot(delta, hd)) >= Math.abs(dot(delta, vd))) {
          const k = dot(delta, hd);
          q[i] = add(q[i], mul(hd, k));
          q[hEdge] = sub(q[hEdge], mul(hd, k));
        } else {
          const k = dot(delta, vd);
          q[i] = add(q[i], mul(vd, k));
          q[vEdge] = sub(q[vEdge], mul(vd, k));
        }
        this.q = q;
      } else this.q = q.map((x, j) => (j === +h[1] || j === (+h[1] + 1) % 4 ? add(x, delta) : x));
    } else {
      // free: scale in the box's own axes, about the opposite side (Alt: about the reference point)
      const ux = unit(sub(q[1], q[0]));
      const uy = unit(sub(q[3], q[0]));
      const fromCenter = !!e.altKey;
      const corner = h[0] === 'c';
      const i = +h[1];
      const anchor = fromCenter ? d.pivot : corner ? q[(i + 2) % 4] : (() => {
        const o = (i + 2) % 4;
        return [(q[o][0] + q[(o + 1) % 4][0]) / 2, (q[o][1] + q[(o + 1) % 4][1]) / 2];
      })();
      const handle = corner ? q[i] : [(q[i][0] + q[(i + 1) % 4][0]) / 2, (q[i][1] + q[(i + 1) % 4][1]) / 2];
      const v0 = sub(handle, anchor);
      const v1 = sub(add(handle, delta), anchor);
      // decompose in the (ux, uy) frame (works for skewed boxes too)
      const det = ux[0] * uy[1] - ux[1] * uy[0] || 1e-9;
      const coord = (v) => [(v[0] * uy[1] - v[1] * uy[0]) / det, (ux[0] * v[1] - ux[1] * v[0]) / det];
      const [a0, b0] = coord(v0);
      const [a1, b1] = coord(v1);
      let kx = Math.abs(a0) > 1e-6 ? a1 / a0 : 1;
      let ky = Math.abs(b0) > 1e-6 ? b1 / b0 : 1;
      if (!corner) {
        // a side stretches one way; Shift keeps the proportions
        if (i === 0 || i === 2) kx = e.shiftKey ? Math.abs(ky) : 1;
        else ky = e.shiftKey ? Math.abs(kx) : 1;
      } else if (!e.shiftKey) {
        // corners keep the proportions (Shift: free), like recent Photoshop
        const k = Math.abs(kx) > Math.abs(ky) ? kx : ky;
        kx = k;
        ky = k;
      }
      this.q = q.map((x) => {
        const [a, b] = coord(sub(x, anchor));
        return add(anchor, add(mul(ux, a * kx), mul(uy, b * ky)));
      });
      if (!fromCenter) {
        const [pa, pb] = coord(sub(d.pivot, anchor));
        this.pivot = add(anchor, add(mul(ux, pa * kx), mul(uy, pb * ky)));
      }
    }
    // the reference point rides on the box (at the same spot in it)
    if (h !== 'move' && h !== 'pivot' && h !== 'rotate') this.pivot = this.carryPoint(d.q, this.q, d.pivot);
    if (this.warp?.ctrl && h !== 'move') {
      // keep the warp grid riding on the box
      const H0 = homography(d.q, this.q);
      this.warp.ctrl = d.ctrl.map(([x, y]) => applyH(H0, x, y));
    }
    this.update();
  }

  /** Where point p (at the same spot of quad a) is in quad b. */
  carryPoint(a, b, p) {
    if (a.every((x, i) => near(x, b[i]))) return p;
    const H = homography(a, b);
    const r = applyH(H, p[0], p[1]);
    return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? r : p;
  }

  /** Drag one warp control point; an anchor takes its handles along. */
  dragWarpPoint(i, delta) {
    const d = this.d;
    const { R, C, N } = warpDims(this.warp);
    const ctrl = d.ctrl.map((x) => [...x]);
    const r = Math.floor(i / N);
    const c = i % N;
    ctrl[i] = add(d.ctrl[i], delta);
    if (r % 3 === 0 && c % 3 === 0) {
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr > 3 * R || cc > 3 * C) continue;
        ctrl[rr * N + cc] = add(d.ctrl[rr * N + cc], delta);
      }
    }
    this.warp.ctrl = ctrl;
    if (R * C > 1) this.untwist(r, c);
  }

  /**
   * Inner control points of the patches around control point (r, c) from their edges (no twist):
   * on a grid of several patches only anchors and handles are shown.
   */
  untwist(r, c) {
    const { R, C, N } = warpDims(this.warp);
    const P = this.warp.ctrl;
    const at = (rr, cc) => P[rr * N + cc];
    for (let i = Math.max(0, Math.floor((r - 1) / 3)); i <= Math.min(R - 1, Math.floor(r / 3)); i++) {
      for (let j = Math.max(0, Math.floor((c - 1) / 3)); j <= Math.min(C - 1, Math.floor(c / 3)); j++) {
        const r0 = 3 * i;
        const c0 = 3 * j;
        for (const [a, b] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
          // corner it leans on, and the two edge handles next to it
          const ca = a === 1 ? 0 : 3;
          const cb = b === 1 ? 0 : 3;
          const k = at(r0 + ca, c0 + cb);
          const e1 = at(r0 + ca, c0 + b);
          const e2 = at(r0 + a, c0 + cb);
          P[(r0 + a) * N + c0 + b] = [e1[0] + e2[0] - k[0], e1[1] + e2[1] - k[1]];
        }
      }
    }
  }

  /** Drag inside the warp grid: the spot under the pointer follows it (the patch bends around it). */
  dragMesh(uv, delta) {
    const d = this.d;
    if (!uv) return;
    const { R, C, N, us, vs } = warpDims(this.warp);
    let j = 0;
    while (j < C - 1 && uv[0] > us[j + 1]) j++;
    let i = 0;
    while (i < R - 1 && uv[1] > vs[i + 1]) i++;
    const bu = bern((uv[0] - us[j]) / (us[j + 1] - us[j] || 1));
    const bv = bern((uv[1] - vs[i]) / (vs[i + 1] - vs[i] || 1));
    let s2 = 0;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) s2 += (bv[a] * bu[b]) ** 2;
    const ctrl = d.ctrl.map((x) => [...x]);
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const k = (bv[a] * bu[b]) / (s2 || 1);
        const idx = (3 * i + a) * N + 3 * j + b;
        ctrl[idx] = add(d.ctrl[idx], mul(delta, k));
      }
    }
    this.warp.ctrl = ctrl;
  }

  up() {
    if (this.d && this.kind !== 'smart' && this.kind !== 'shape' && this.kind !== 'text') this.update(true);
    this.d = null;
  }

  setMode(mode) {
    if (mode === 'warp') {
      if (this.kind === 'text') {
        this.E.toast('글자는 문자 ▸ 텍스트 뒤틀기로 휘게 합니다');
        return;
      }
      this.startWarp();
    } else {
      if (this.kind === 'text' && mode !== 'free' && mode !== 'skew') {
        this.E.toast('글자 레이어는 왜곡·원근을 할 수 없습니다 (래스터화하거나 고급 개체로 바꾼 뒤 변형하세요)');
        return;
      }
      this.splitMode = null;
      this.mode = mode;
    }
    this.update();
  }

  setWarpPreset(style, bend = 50, hh = 0, vv = 0, vertical = !!this.warp?.vertical) {
    this.warp = style === 'none' ? null : style === 'custom' ? null : { style, bend, h: hh, v: vv, vertical };
    if (style === 'custom') this.startWarp();
    this.mode = style === 'none' ? 'free' : 'warp';
    this.splitMode = null;
    this.update(true);
  }

  /** Grid: 1 (the default patch) or an n×n grid made from the current warp. */
  setWarpGrid(n) {
    if (this.kind === 'text') return;
    if (!this.warp?.ctrl) {
      this.warp = null;
      this.startWarp();
    }
    const { R, C } = warpDims(this.warp);
    if (n <= 1) {
      // back to the default: a fresh grid on the box
      if (R * C > 1) this.warp = this.flatWarp();
    } else this.warp = gridWarp(this.warp, n);
    this.mode = 'warp';
    this.update(true);
  }

  /** Reset the custom warp to a flat grid of the same size. */
  resetWarp() {
    if (!this.warp?.ctrl) return;
    const { R, C } = warpDims(this.warp);
    this.warp = this.flatWarp();
    if (R === C && R > 1) this.warp = gridWarp(this.warp, R);
    this.update(true);
  }

  /** Arrow keys: move the whole box by (dx, dy). */
  nudge(dx, dy) {
    const v = [dx, dy];
    this.q = this.q.map((x) => add(x, v));
    this.pivot = add(this.pivot, v);
    if (this.warp?.ctrl) this.warp.ctrl = this.warp.ctrl.map((x) => add(x, v));
    this.update(true);
  }

  /** Move every corner (and the warp grid) by fn(point, pivot). */
  remapBox(fn) {
    const piv = [...this.pivot];
    this.q = this.q.map((p) => fn(p, piv));
    if (this.warp?.ctrl) this.warp.ctrl = this.warp.ctrl.map((p) => fn(p, piv));
    this.update(true);
  }

  /** Flip horizontally ('h') or vertically ('v') about the reference point, in the box's own axes. */
  flip(axis) {
    if (this.kind === 'text') return void this.E.toast('글자 레이어는 뒤집을 수 없습니다 (래스터화하거나 고급 개체로 바꾼 뒤 뒤집으세요)');
    const ux = unit(sub(this.q[1], this.q[0]));
    const uy = unit(sub(this.q[3], this.q[0]));
    const det = ux[0] * uy[1] - ux[1] * uy[0] || 1e-9;
    this.remapBox((p, piv) => {
      const v = sub(p, piv);
      const a = (v[0] * uy[1] - v[1] * uy[0]) / det;
      const b = (ux[0] * v[1] - ux[1] * v[0]) / det;
      return add(piv, add(mul(ux, axis === 'h' ? -a : a), mul(uy, axis === 'v' ? -b : b)));
    });
  }

  /** Turn by `deg` degrees (clockwise) about the reference point. */
  rotateBy(deg) {
    const ang = (deg * Math.PI) / 180;
    this.remapBox((p, piv) => rotAbout(p, piv, ang));
  }

  /** The reference point: one of the 9 points of the box (u, v ∈ {0, 0.5, 1}). */
  setReference(u, v) {
    this.pivot = this.warp ? this.mapPoint(u * this.w, v * this.h) : applyH(homography([[0, 0], [1, 0], [1, 1], [0, 1]], this.q), u, v);
    this.E.transformChanged?.(this);
    this.E.redraw();
  }

  /** Which of the 9 reference points the pivot sits on ([u, v]), or null. */
  reference() {
    const H = homography(this.q, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const [u, v] = applyH(H, this.pivot[0], this.pivot[1]);
    const snap = (x) => [0, 0.5, 1].find((k) => Math.abs(x - k) < 0.01);
    const su = snap(u);
    const sv = snap(v);
    return su != null && sv != null ? [su, sv] : null;
  }

  /** Numbers for the options bar: reference point position, size %, angle and skews. */
  numbers() {
    const q = this.q;
    const key = JSON.stringify([q, this.pivot]);
    if (this.typed?.key === key) return { ...this.typed.v };
    const top = sub(q[1], q[0]);
    const left = sub(q[3], q[0]);
    const ang = Math.atan2(top[1], top[0]);
    const nrm = [-Math.sin(ang), Math.cos(ang)];
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      x: r1(this.pivot[0]), y: r1(this.pivot[1]),
      w: Math.round((len(top) / this.w) * 1000) / 10, h: Math.round((Math.abs(dot(left, nrm)) / this.h) * 1000) / 10,
      angle: r1((ang * 180) / Math.PI),
      skew: r1((Math.atan2(dot(left, unit(top)), dot(left, nrm)) * 180) / Math.PI),
      skewV: 0,
    };
  }

  /** Rebuild a parallelogram from typed numbers (about the reference point). */
  setNumbers(n) {
    const cur = this.numbers();
    const v = { ...cur, ...n };
    const piv = [v.x, v.y];
    const ang = (v.angle * Math.PI) / 180;
    const tx = Math.tan((Math.max(-89, Math.min(89, v.skew)) * Math.PI) / 180);
    const ty = Math.tan((Math.max(-89, Math.min(89, v.skewV || 0)) * Math.PI) / 180);
    const ux = [Math.cos(ang), Math.sin(ang)];
    const uy = [-Math.sin(ang), Math.cos(ang)];
    const W = (this.w * v.w) / 100;
    const H = (this.h * v.h) / 100;
    // keep the reference point at the same relative spot in the box
    const H0 = homography(this.q, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const [pu, pv] = applyH(H0, this.pivot[0], this.pivot[1]);
    const corner = (u, vv) => {
      const lx = (u - pu) * W + (vv - pv) * H * tx;
      const ly = (u - pu) * W * ty + (vv - pv) * H;
      return add(piv, add(mul(ux, lx), mul(uy, ly)));
    };
    const q0 = this.q.map((x) => [...x]);
    this.q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    this.pivot = piv;
    if (this.warp?.ctrl) {
      const Hq = homography(q0, this.q);
      this.warp.ctrl = this.warp.ctrl.map(([x, y]) => applyH(Hq, x, y));
    }
    this.typed = { key: JSON.stringify([this.q, this.pivot]), v: { ...v, skewV: v.skewV || 0 } };
    this.update(true);
  }

  /** Nothing changed since the transform started (Enter then changes nothing). */
  unchanged() {
    return this.q.every((p, i) => near(p, this.q0[i], 1e-6)) && (this.warp ? JSON.stringify(this.warp) : null) === this.warp0 && !this.keep;
  }

  // ---------------------------------------------------------------- finish

  apply() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    // committing an untouched transform records nothing
    if (this.unchanged()) {
      this.cancel();
      E.afterHistory?.();
      return;
    }
    E.float = null;
    let r = null;
    if (this.kind === 'pixels' || this.kind === 'mask' || this.kind === 'selection') {
      try {
        r = this.renderSource(this.src, true);
      } catch (err) {
        // too big to make (a perspective running off to infinity): everything goes back as it was
        this.cancel();
        E.afterHistory?.();
        E.toast(`변형을 적용하지 못했습니다: ${err.message || err}`);
        return;
      }
    }
    if (this.kind === 'group') {
      l.visible = this.groupHidden;
      this.applyToGroup();
    } else if (r) {
      if (this.kind === 'pixels') {
        const g = doc.editPixels(l, { x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height });
        g.drawImage(r.canvas, r.x - l.x, r.y - l.y);
        l._styled = null;
        // the selection follows the pixels
        if (doc.selection && this.selLift) doc.selection = { canvas: this.mapCanvasDoc(doc.selection.canvas) };
      } else if (this.kind === 'mask') {
        const g = doc.editMask(l);
        g.drawImage(r.canvas, r.x - l.mask.x, r.y - l.mask.y);
      } else {
        const c = makeCanvas(doc.width, doc.height);
        c.getContext('2d').drawImage(r.canvas, r.x, r.y);
        doc.selection = { canvas: c };
      }
    }
    // the linked masks at full quality, in the same history step
    this.updateMasks(true);
    if (l) doc.touch(l);
    const m = this.affine();
    if (m) {
      // remember the change as a doc-space affine for "Transform Again"
      const m0 = quadAffine(this.q0, this.w, this.h);
      E.lastTransform = composeM(m, invertM(m0));
    }
    const name = this.kind === 'selection' ? '선택 영역 변형' : { free: '자유 변형', skew: '기울이기', distort: '왜곡', perspective: '원근', warp: '뒤틀기' }[this.mode] || '변형';
    E.commit(this.label || name, this.before);
  }

  /** A doc-size alpha canvas pushed through the same mapping. */
  mapCanvasDoc(canvas) {
    const b = { x: this.q0[0][0], y: this.q0[0][1], w: this.w, h: this.h };
    const part = makeCanvas(b.w, b.h);
    part.getContext('2d').drawImage(canvas, -b.x, -b.y);
    const r = this.renderSource(part, true);
    const out = makeCanvas(canvas.width, canvas.height);
    const g = out.getContext('2d');
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.fillRect(b.x, b.y, b.w, b.h);
    g.globalCompositeOperation = 'source-over';
    g.drawImage(r.canvas, r.x, r.y);
    return out;
  }

  applyToGroup() {
    const E = this.E;
    const doc = E.doc;
    const b = this.box0;
    for (const c of doc.descendants(this.layer.id)) {
      if (c.kind === 'group' || c.kind === 'adjust' || c.kind === 'fill') continue;
      if (c.kind === 'raster' && c.canvas) {
        const src = makeCanvas(b.w, b.h);
        src.getContext('2d').drawImage(c.canvas, c.x - b.x, c.y - b.y);
        const r = this.renderSource(src, true);
        c.canvas = r.canvas;
        c.x = r.x;
        c.y = r.y;
      } else if (c.kind === 'smart') {
        const cs = (c.smart.corners || [[0, 0], [c.smart.w, 0], [c.smart.w, c.smart.h], [0, c.smart.h]].map((p) => applyM(c.smart.m, p)));
        const nq = cs.map(([x, y]) => this.mapPoint(x - b.x, y - b.y));
        if (isAffineQuad(nq)) c.smart = { ...c.smart, m: quadAffine(nq, c.smart.w, c.smart.h), corners: null };
        else c.smart = { ...c.smart, corners: nq };
      } else if (c.kind === 'shape') {
        E.setShapePathDoc(c, this.mapPaths(E.shapePathDoc(c)));
      } else if (c.kind === 'text') {
        const L = E.textBox(c);
        const [nx, ny] = this.mapPoint(c.x + L.w / 2 - b.x, c.y + L.h / 2 - b.y);
        const k = len(sub(this.q[1], this.q[0])) / this.w;
        const ang = Math.atan2(this.q[1][1] - this.q[0][1], this.q[1][0] - this.q[0][0]);
        c.text = { ...c.text, size: Math.max(1, Math.round(c.text.size * k * 10) / 10) };
        c.rotation = ((c.rotation || 0) + (ang * 180) / Math.PI) % 360;
        const L2 = E.textBox(c);
        c.x = Math.round(nx - L2.w / 2);
        c.y = Math.round(ny - L2.h / 2);
      }
      if (c.mask) {
        const r = this.mapCanvasDoc(maskDocCanvas(doc, c.mask));
        c.mask = { ...c.mask, canvas: r, x: 0, y: 0 };
      }
      c._styled = null;
      doc.touch(c);
    }
  }

  cancel() {
    const E = this.E;
    E.float = null;
    if (this.kind === 'group') this.layer.visible = this.groupHidden;
    E.doc.restore(this.before);
    E.redraw();
  }

  overlay(g) {
    const E = this.E;
    const S = (p) => E.toScreen(p[0], p[1]);
    const q = this.q.map(S);
    g.save();
    g.strokeStyle = '#4aa3ff';
    g.lineWidth = 1;
    g.beginPath();
    q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    if (!(this.mode === 'warp' && this.warp?.ctrl)) g.stroke();
    if (this.mode === 'warp' && this.warp?.ctrl) {
      const w = this.warp;
      const { R, C, N, us, vs } = warpDims(w);
      const c = w.ctrl.map(S);
      // the warp mesh: thirds on the default patch, the grid lines on a bigger grid
      g.strokeStyle = 'rgba(74,163,255,.75)';
      const lineU = (u) => {
        g.beginPath();
        for (let k = 0; k <= 40; k++) {
          const [x, y] = S(evalWarp(w, u, k / 40));
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      };
      const lineV = (v) => {
        g.beginPath();
        for (let k = 0; k <= 40; k++) {
          const [x, y] = S(evalWarp(w, k / 40, v));
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      };
      const ul = R * C === 1 ? [0, 1 / 3, 2 / 3, 1] : us;
      const vl = R * C === 1 ? [0, 1 / 3, 2 / 3, 1] : vs;
      ul.forEach(lineU);
      vl.forEach(lineV);
      // handles: lines from each anchor to its handles
      g.strokeStyle = '#1d6fd1';
      const shown = new Set(this.warpPoints());
      for (let r = 0; r <= 3 * R; r += 3) {
        for (let cc = 0; cc <= 3 * C; cc += 3) {
          for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const rr = r + dr;
            const c2 = cc + dc;
            if (rr < 0 || c2 < 0 || rr > 3 * R || c2 > 3 * C) continue;
            g.beginPath();
            g.moveTo(...c[r * N + cc]);
            g.lineTo(...c[rr * N + c2]);
            g.stroke();
          }
        }
      }
      for (const i of shown) {
        const [x, y] = c[i];
        const r = Math.floor(i / N);
        const col = i % N;
        const anchor = r % 3 === 0 && col % 3 === 0;
        g.fillStyle = anchor ? '#fff' : '#4aa3ff';
        g.beginPath();
        g.arc(x, y, anchor ? 5 : 3.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      // Split Warp: where the line(s) would go
      if (this.splitMode && this.hoverPt && !this.d) {
        const uv = this.warpUV(this.hoverPt);
        if (uv) {
          g.save();
          g.setLineDash([5, 4]);
          g.strokeStyle = '#ffcc00';
          g.lineWidth = 1.5;
          if (this.splitMode !== 'h') lineU(uv[0]);
          if (this.splitMode !== 'v') lineV(uv[1]);
          g.restore();
        }
      }
    } else {
      g.fillStyle = '#fff';
      g.strokeStyle = '#1d6fd1';
      const hs = this.handles();
      for (const k of ['c0', 'c1', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3']) {
        const [x, y] = S(hs[k]);
        g.fillRect(x - 4, y - 4, 8, 8);
        g.strokeRect(x - 4.5, y - 4.5, 9, 9);
      }
      // the reference point
      const [px, py] = S(this.pivot);
      g.beginPath();
      g.arc(px, py, 5, 0, Math.PI * 2);
      g.moveTo(px - 8, py);
      g.lineTo(px + 8, py);
      g.moveTo(px, py - 8);
      g.lineTo(px, py + 8);
      g.stroke();
    }
    const n = this.numbers();
    g.font = '12px sans-serif';
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.lineWidth = 3;
    const label = this.splitMode ? '뒤틀기 분할: 나눌 곳을 누르세요 · Esc 취소' : `${TRANSFORM_MODES.find((m) => m[0] === this.mode)?.[1]} · 폭 ${n.w}% 높이 ${n.h}% · ${n.angle}° · Enter 적용 · Esc 취소`;
    // kept on screen (a narrow phone screen cut it off at the right)
    const vw = g.canvas.clientWidth || g.canvas.width;
    const lx = Math.max(4, Math.min(Math.min(...q.map((p) => p[0])), vw - g.measureText(label).width - 4));
    const ly = Math.max(16, Math.min(...q.map((p) => p[1])) - 10);
    g.strokeText(label, lx, ly);
    g.fillText(label, lx, ly);
    g.restore();
  }
}

function pointInQuad(p, q) {
  let ins = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) ins = !ins;
  }
  return ins;
}

function alphaBoxLocal(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function maskDocCanvas(doc, m) {
  const c = makeCanvas(doc.width, doc.height);
  c.getContext('2d').drawImage(m.canvas, m.x, m.y);
  return c;
}

// ---------------------------------------------------------------- masks under a transform

/** Whether a raster mask's edge shows (white) or hides (black): what lies outside it once moved. */
export function maskReveals(m) {
  const c = m.canvas;
  const g = c.getContext('2d');
  let n = 0;
  for (const [x, y] of [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]]) if (g.getImageData(x, y, 1, 1).data[3] >= 128) n++;
  return n >= 2;
}

/** A raster mask at doc size (at 0, 0); beyond its own canvas, its edge colour. */
function maskDocBase(doc, m, reveal = maskReveals(m)) {
  const base = makeCanvas(doc.width, doc.height);
  const g = base.getContext('2d');
  if (reveal) {
    g.fillRect(0, 0, base.width, base.height);
    g.clearRect(m.x, m.y, m.canvas.width, m.canvas.height);
  }
  g.drawImage(m.canvas, m.x, m.y);
  return base;
}

/** The part of a doc-size mask under a selection. */
function maskPart(base, sel) {
  const part = makeCanvas(base.width, base.height);
  const g = part.getContext('2d');
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(sel, 0, 0);
  return part;
}

/** out = the mask as it was, with the moved selection ({canvas, x, y}) taking the moved part. */
function landMaskPart(out, base, selMoved, part) {
  const g = out.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, out.width, out.height);
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(selMoved.canvas, selMoved.x, selMoved.y);
  g.globalCompositeOperation = 'lighter';
  g.drawImage(part.canvas, part.x, part.y);
  g.globalCompositeOperation = 'source-over';
  return out;
}

/** Mask m cut to the doc rect (x, y, w, h), as a w×h canvas (its edge colour beyond its own canvas). */
export function maskRect(m, x, y, w, h, reveal = maskReveals(m)) {
  const c = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const g = c.getContext('2d');
  if (reveal) {
    g.fillRect(0, 0, c.width, c.height);
    g.clearRect(m.x - x, m.y - y, m.canvas.width, m.canvas.height);
  }
  g.drawImage(m.canvas, m.x - x, m.y - y);
  return c;
}

/**
 * A new doc-size canvas for mask m: as it was, except where `cover` ({canvas, x, y}, by its alpha)
 * lands, which takes `part` ({canvas, x, y}): the mask of pixels that were reshaped there.
 */
export function maskWithPart(doc, m, cover, part) {
  return landMaskPart(makeCanvas(doc.width, doc.height), maskDocBase(doc, m), cover, part);
}

/**
 * Selected pixels moved by the move tool or the arrow keys take the selected part of the layer's
 * linked raster masks along (Photoshop). liftLinkedMasks keeps what is needed; placeLinkedMasks
 * sets the masks for an offset of (dx, dy) (0, 0: as they were).
 */
export function liftLinkedMasks(doc, l, sel) {
  const out = [];
  if (!l || !sel) return null;
  for (const key of ['mask', 'filterMask']) {
    const m = l[key];
    if (!m?.canvas || m.linked === false) continue;
    const base = maskDocBase(doc, m);
    out.push({ key, m0: m, base, part: maskPart(base, sel) });
  }
  return out.length ? { sel, list: out } : null;
}
export function placeLinkedMasks(doc, l, lifted, dx, dy, live = false) {
  if (!lifted || !l) return;
  for (const c of lifted.list) {
    // while dragging, one buffer is redrawn; the final masks get their own canvas
    const out = live ? (c.buf ||= makeCanvas(doc.width, doc.height)) : makeCanvas(doc.width, doc.height);
    if (!dx && !dy) l[c.key] = c.m0;
    else l[c.key] = { ...c.m0, canvas: landMaskPart(out, c.base, { canvas: lifted.sel, x: dx, y: dy }, { canvas: c.part, x: dx, y: dy }), x: 0, y: 0 };
  }
  l._styled = null;
  doc.touch(l);
}

/**
 * A float lifted from a selection (move tool), with the layer's linked masks going along: the float
 * shows through its mask while it moves (float.pixels keeps the pixels themselves), and
 * float.masks / x0 / y0 tell dropFloat where the masks land.
 */
export function withLinkedMasks(doc, l, f) {
  const lifted = doc.selection && liftLinkedMasks(doc, l, doc.selection.canvas);
  if (!lifted) return f;
  const shown = makeCanvas(f.canvas.width, f.canvas.height);
  const g = shown.getContext('2d');
  g.drawImage(f.canvas, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  for (const c of lifted.list) if (c.key === 'mask' && c.m0.enabled !== false) g.drawImage(maskAlpha(doc, c.m0), -f.x, -f.y);
  return { ...f, canvas: shown, pixels: f.canvas, masks: lifted, x0: f.x, y0: f.y };
}

/** A W×H mask canvas (at 0, 0): mask m pushed through the doc-space affine M; outside it, its edge colour. */
export function mapMaskCanvas(m, M, W, H, reveal = maskReveals(m), out = makeCanvas(W, H)) {
  const g = out.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, out.width, out.height);
  if (reveal) {
    const w = m.canvas.width;
    const h = m.canvas.height;
    const cs = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => applyM(M, [x + m.x, y + m.y]));
    g.beginPath();
    g.rect(0, 0, out.width, out.height);
    cs.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill('evenodd');
  }
  g.imageSmoothingQuality = 'high';
  g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
  g.drawImage(m.canvas, m.x, m.y);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/** A vector mask with every point sent through f (doc coords); its offset is folded in. */
export function mapVmask(vm, f) {
  const dx = vm.dx || 0;
  const dy = vm.dy || 0;
  const F = ([x, y]) => f([x + dx, y + dy]);
  return { ...vm, subpaths: vm.subpaths.map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ ...k, p: F(k.p), in: F(k.in || k.p), out: F(k.out || k.p) })) })), dx: 0, dy: 0 };
}

/**
 * A layer's masks (layer mask, vector mask, smart filter mask) through a doc-space affine M.
 * all: every mask (image size, canvas rotation); otherwise only the linked ones (layer transforms).
 * W, H: the document size afterwards.
 */
export function transformMasksBy(doc, l, M, { all = false, W = doc.width, H = doc.height } = {}) {
  for (const key of ['mask', 'filterMask']) {
    const m = l[key];
    if (m?.canvas && (all || m.linked !== false)) l[key] = { ...m, canvas: mapMaskCanvas(m, M, W, H), x: 0, y: 0 };
  }
  if (l.vmask?.subpaths && (all || l.vmask.linked !== false)) l.vmask = mapVmask(l.vmask, (p) => applyM(M, p));
}

/** Affine helpers ([a b c d e f] = x' = a x + c y + e, y' = b x + d y + f). */
export function composeM(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export { applyM };

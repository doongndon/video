// Geometric transforms beyond scale/rotate: perspective (projective), distort, mesh warp and the warp
// presets (arc, bulge, flag…). Pixels are mapped triangle by triangle with affine draws, so any
// canvas-capable browser can do it quickly.

import { makeCanvas, setWarpRenderer } from './doc.js';

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
export function meshWarp(src, pts, rows, cols, { pad = 1, sx = 0, sy = 0, sw = src.width, sh = src.height } = {}) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)) - pad;
  const y0 = Math.floor(Math.min(...ys)) - pad;
  const W = Math.ceil(Math.max(...xs)) - x0 + pad + 1;
  const H = Math.ceil(Math.max(...ys)) - y0 + pad + 1;
  if (W * H > 120e6) throw new Error('결과가 너무 큽니다');
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const P = (r, c) => pts[r * (cols + 1) + c];
  const S = (r, c) => [sx + (c / cols) * sw, sy + (r / rows) * sh];
  const tri = (s0, s1, s2, d0, d1, d2) => {
    // expand the destination triangle a little to hide seams between neighbours
    const cx = (d0[0] + d1[0] + d2[0]) / 3;
    const cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p) => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const l = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / l) * 0.6 - x0, p[1] + (dy / l) * 0.6 - y0];
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
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tri(S(r, c), S(r, c + 1), S(r + 1, c), P(r, c), P(r, c + 1), P(r + 1, c));
      tri(S(r, c + 1), S(r + 1, c + 1), S(r + 1, c), P(r, c + 1), P(r + 1, c + 1), P(r + 1, c));
    }
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

/** Custom warp: a 4×4 Bézier patch (16 control points, doc coords) evaluated on a grid. */
export function patchGrid(ctrl, n = 16) {
  const B = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
  const pts = [];
  for (let r = 0; r <= n; r++) {
    const bv = B(r / n);
    for (let c = 0; c <= n; c++) {
      const bu = B(c / n);
      let x = 0;
      let y = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const w = bv[i] * bu[j];
        x += ctrl[i * 4 + j][0] * w;
        y += ctrl[i * 4 + j][1] * w;
      }
      pts.push([x, y]);
    }
  }
  return pts;
}

/** The 16 control points of an undeformed w×h box at (x, y). */
export function flatPatch(x, y, w, h) {
  const out = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push([x + (j / 3) * w, y + (i / 3) * h]);
  return out;
}

// smart objects with distort/perspective corners or a warp
setWarpRenderer((src, s) => {
  if (s.warp?.ctrl) return meshWarp(src, patchGrid(s.warp.ctrl), 16, 16);
  if (s.warp?.style && s.warp.style !== 'none') {
    // preset warp inside the transformed box
    const [a, b, c, d, e, f] = s.m;
    const grid = warpGrid(s.warp, s.w, s.h, 0, 0).map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    return meshWarp(src, grid, 16, 16);
  }
  return projectiveDraw(src, s.corners);
});

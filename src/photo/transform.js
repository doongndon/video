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

/**
 * Transform the active layer (pixels, smart object, shape path, text, group), its mask, or the
 * selection. State: the 4 corners of the source box, a pivot, and an optional warp
 * (a preset {style, bend, h, v} or a custom 4×4 control grid in doc coords).
 */
export class Transformer {
  constructor(E, { mode = 'free', target = 'auto' } = {}) {
    this.E = E;
    this.mode = mode;
    const doc = E.doc;
    const l = doc.active;
    this.layer = l;
    this.before = doc.capture();
    this.warp = null;
    this.kind = target === 'selection' ? 'selection' : E.editMask && l?.mask ? 'mask' : l?.kind === 'smart' ? 'smart' : l?.kind === 'shape' ? 'shape' : l?.kind === 'text' ? 'text' : l?.kind === 'group' ? 'group' : 'pixels';
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
    if (this.warp?.ctrl) this.warp.ctrl = this.warp.ctrl.map((p) => [...p]);
    if (this.kind === 'text' && mode !== 'free' && mode !== 'skew') {
      E.toast(mode === 'warp' ? '글자는 문자 ▸ 텍스트 뒤틀기로 휘게 합니다' : '글자 레이어는 왜곡·원근을 할 수 없습니다 (래스터화하거나 고급 개체로 바꾼 뒤 변형하세요)');
      this.mode = mode = 'free';
    }
    if (mode === 'warp') this.startWarp();
    this.update();
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
    // take them out of the source
    if (this.kind === 'pixels') {
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

  startWarp() {
    this.mode = 'warp';
    if (!this.warp) this.warp = { style: 'custom' };
    if (this.warp.style === 'custom' && !this.warp.ctrl) {
      const H = homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q);
      this.warp.ctrl = flatPatch(0, 0, this.w, this.h).map(([x, y]) => applyH(H, x, y));
    }
  }

  /** The output mesh for pixel-type sources. */
  grid(n = 16) {
    if (this.warp?.ctrl) return patchGrid(this.warp.ctrl, n);
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
    if (this.warp?.ctrl) {
      // evaluate the patch at (u, v)
      const u = x / this.w;
      const v = y / this.h;
      const B = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      const bu = B(u);
      const bv = B(v);
      let X = 0;
      let Y = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        X += this.warp.ctrl[i * 4 + j][0] * bv[i] * bu[j];
        Y += this.warp.ctrl[i * 4 + j][1] * bv[i] * bu[j];
      }
      return [X, Y];
    }
    const H = homography([[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], this.q);
    if (this.warp?.style && this.warp.style !== 'none' && this.warp.style !== 'custom') {
      const [wx, wy] = warpPoint(this.warp.style, x / this.w, y / this.h, this.w, this.h, (this.warp.bend ?? 50) / 100, (this.warp.h ?? 0) / 100, (this.warp.v ?? 0) / 100, !!this.warp.vertical);
      return applyH(H, wx, wy);
    }
    return applyH(H, x, y);
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
      g.imageSmoothingQuality = 'high';
      g.setTransform(m[0] * (this.w / src.width), m[1] * (this.w / src.width), m[2] * (this.h / src.height), m[3] * (this.h / src.height), m[4] - x0, m[5] - y0);
      g.drawImage(src, 0, 0);
      return { canvas: c, x: x0, y: y0 };
    }
    const n = fine ? 24 : 12;
    // the mesh is in source-pixel space: scale the box grid to the source size
    const pts = this.grid(n);
    return meshWarp(src, pts, n, n, { sw: src.width, sh: src.height });
  }

  /** Show the transform live. */
  update(fine = false) {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
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
      const r = this.renderSource(this.groupSrc, fine);
      E.float = { ...r, layerId: null, above: true };
    } else {
      const r = this.renderSource(this.src, fine);
      E.float = { ...r, layerId: this.kind === 'pixels' ? l.id : null, above: this.kind !== 'pixels', tint: this.kind === 'selection' ? 'selection' : this.kind === 'mask' ? 'mask' : null };
    }
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

  hit(p) {
    const tol = 9 / this.E.view.zoom;
    const pt = [p.x, p.y];
    if (this.mode === 'warp' && this.warp?.ctrl) {
      for (let i = 0; i < 16; i++) if (len(sub(this.warp.ctrl[i], pt)) < tol) return `w${i}`;
      return pointInQuad(pt, this.q) ? 'move' : 'none';
    }
    const hs = this.handles();
    if (len(sub(hs.pivot, pt)) < tol && this.mode === 'free') return 'pivot';
    for (const k of ['c0', 'c1', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3']) if (len(sub(hs[k], pt)) < tol) return k;
    if (pointInQuad(pt, this.q)) return 'move';
    return this.mode === 'free' ? 'rotate' : 'none';
  }

  down(p, e = {}) {
    this.d = { h: this.hit(p), a: [p.x, p.y], q: this.q.map((x) => [...x]), pivot: [...this.pivot], ctrl: this.warp?.ctrl?.map((x) => [...x]), e };
  }

  move(p, e = {}) {
    const d = this.d;
    if (!d || d.h === 'none') return;
    const pt = [p.x, p.y];
    const delta = sub(pt, d.a);
    const q = d.q.map((x) => [...x]);
    const h = d.h;
    let mode = this.mode;
    // Ctrl: distort a corner / skew an edge; Ctrl+Alt+Shift: perspective (like Photoshop)
    if (mode === 'free' && (e.ctrlKey || e.metaKey)) mode = e.altKey && e.shiftKey ? 'perspective' : h[0] === 'c' ? 'distort' : 'skew';
    if (h.startsWith('w')) {
      const i = +h.slice(1);
      this.warp.ctrl = d.ctrl.map((x) => [...x]);
      this.warp.ctrl[i] = add(d.ctrl[i], delta);
      // dragging a corner point carries its two handles along
      const corner = { 0: [1, 4], 3: [2, 7], 12: [8, 13], 15: [11, 14] }[i];
      if (corner) for (const j of corner) this.warp.ctrl[j] = add(d.ctrl[j], delta);
      this.update();
      return;
    }
    if (h === 'move') {
      this.q = q.map((x) => add(x, delta));
      this.pivot = add(d.pivot, delta);
      if (this.warp?.ctrl) this.warp.ctrl = d.ctrl.map((x) => add(x, delta));
    } else if (h === 'pivot') {
      this.pivot = add(d.pivot, delta);
      return this.E.redraw();
    } else if (h === 'rotate') {
      let ang = Math.atan2(pt[1] - d.pivot[1], pt[0] - d.pivot[0]) - Math.atan2(d.a[1] - d.pivot[1], d.a[0] - d.pivot[0]);
      if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      this.q = q.map((x) => rotAbout(x, d.pivot, ang));
    } else if (mode === 'distort') {
      if (h[0] === 'c') q[+h[1]] = add(q[+h[1]], delta);
      else {
        const i = +h[1];
        q[i] = add(q[i], delta);
        q[(i + 1) % 4] = add(q[(i + 1) % 4], delta);
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
      // free: scale in the box's own axes, about the opposite side (Alt: about the pivot)
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
        if (i === 0 || i === 2) kx = 1;
        else ky = 1;
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
    if (this.warp?.ctrl && h !== 'move') {
      // keep the warp grid riding on the box
      const H0 = homography(d.q, this.q);
      this.warp.ctrl = d.ctrl.map(([x, y]) => applyH(H0, x, y));
    }
    this.update();
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
      this.mode = mode;
    }
    this.update();
  }

  setWarpPreset(style, bend = 50, hh = 0, vv = 0) {
    this.warp = style === 'none' ? null : style === 'custom' ? { style: 'custom' } : { style, bend, h: hh, v: vv };
    if (style === 'custom') this.startWarp();
    this.mode = style === 'none' ? 'free' : 'warp';
    this.update();
  }

  /** Numbers for the options bar: centre, size %, angle, skew. */
  numbers() {
    const q = this.q;
    const top = sub(q[1], q[0]);
    const left = sub(q[3], q[0]);
    const ang = Math.atan2(top[1], top[0]);
    const nrm = [-Math.sin(ang), Math.cos(ang)];
    return {
      x: Math.round(this.pivot[0]), y: Math.round(this.pivot[1]),
      w: Math.round((len(top) / this.w) * 1000) / 10, h: Math.round((Math.abs(dot(left, nrm)) / this.h) * 1000) / 10,
      angle: Math.round((ang * 180) / Math.PI * 10) / 10,
      skew: Math.round((Math.atan2(dot(left, unit(top)), dot(left, nrm)) * 180) / Math.PI * 10) / 10,
    };
  }

  /** Rebuild a parallelogram from typed numbers (about the pivot). */
  setNumbers(n) {
    const cur = this.numbers();
    const v = { ...cur, ...n };
    const piv = [v.x, v.y];
    const ang = (v.angle * Math.PI) / 180;
    const sk = (v.skew * Math.PI) / 180;
    const ux = [Math.cos(ang), Math.sin(ang)];
    const uy = [-Math.sin(ang), Math.cos(ang)];
    const W = (this.w * v.w) / 100;
    const H = (this.h * v.h) / 100;
    // keep the pivot at the same relative spot in the box
    const H0 = homography(this.q, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const [pu, pv] = applyH(H0, this.pivot[0], this.pivot[1]);
    const corner = (u, vv) => add(piv, add(mul(ux, (u - pu) * W + (vv - pv) * H * Math.tan(sk)), mul(uy, (vv - pv) * H)));
    this.q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    this.pivot = piv;
    this.warp = this.warp?.ctrl ? null : this.warp;
    this.update(true);
  }

  // ---------------------------------------------------------------- finish

  apply() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    E.float = null;
    if (this.kind === 'group') {
      l.visible = this.groupHidden;
      this.applyToGroup();
    } else if (this.kind === 'pixels' || this.kind === 'mask' || this.kind === 'selection') {
      const r = this.renderSource(this.src, true);
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
    if (l) doc.touch(l);
    const m = this.affine();
    if (m) {
      // remember the change as a doc-space affine for "Transform Again"
      const m0 = quadAffine(this.q0, this.w, this.h);
      E.lastTransform = composeM(m, invertM(m0));
    }
    E.commit(this.kind === 'selection' ? '선택 영역 변형' : { free: '자유 변형', skew: '기울이기', distort: '왜곡', perspective: '원근', warp: '뒤틀기' }[this.mode] || '변형', this.before);
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
    g.stroke();
    if (this.mode === 'warp' && this.warp?.ctrl) {
      const c = this.warp.ctrl.map(S);
      // the warp mesh
      g.strokeStyle = 'rgba(74,163,255,.7)';
      const mesh = patchGrid(this.warp.ctrl, 12).map(S);
      for (let r = 0; r <= 12; r += 4) {
        g.beginPath();
        for (let k = 0; k <= 12; k++) (k ? g.lineTo : g.moveTo).call(g, ...mesh[r * 13 + k]);
        g.stroke();
      }
      for (let k = 0; k <= 12; k += 4) {
        g.beginPath();
        for (let r = 0; r <= 12; r++) (r ? g.lineTo : g.moveTo).call(g, ...mesh[r * 13 + k]);
        g.stroke();
      }
      g.strokeStyle = '#1d6fd1';
      for (const [a, b] of [[0, 1], [3, 2], [12, 13], [15, 14], [0, 4], [3, 7], [12, 8], [15, 11]]) {
        g.beginPath();
        g.moveTo(...c[a]);
        g.lineTo(...c[b]);
        g.stroke();
      }
      c.forEach(([x, y], i) => {
        const corner = [0, 3, 12, 15].includes(i);
        g.fillStyle = corner ? '#fff' : '#4aa3ff';
        g.beginPath();
        g.arc(x, y, corner ? 5 : 3.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      });
    } else {
      g.fillStyle = '#fff';
      g.strokeStyle = '#1d6fd1';
      const hs = this.handles();
      for (const k of ['c0', 'c1', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3']) {
        const [x, y] = S(hs[k]);
        g.fillRect(x - 4, y - 4, 8, 8);
        g.strokeRect(x - 4.5, y - 4.5, 9, 9);
      }
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
    const label = `${TRANSFORM_MODES.find((m) => m[0] === this.mode)?.[1]} · 폭 ${n.w}% 높이 ${n.h}% · ${n.angle}° · Enter 적용 · Esc 취소`;
    const lx = Math.min(...q.map((p) => p[0]));
    const ly = Math.min(...q.map((p) => p[1])) - 10;
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

/** Affine helpers ([a b c d e f] = x' = a x + c y + e, y' = b x + d y + f). */
export function composeM(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export { applyM };

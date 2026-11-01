// Edit ▸ Content-Aware Scale (seam carving, on the canvas), Edit ▸ Puppet Warp (pins on a mesh,
// moving least squares, on the canvas; a smart filter on smart objects), Edit ▸ Content-Aware Fill's
// workspace (cafill.js), Edit ▸ Fade (the last edit's strength and blend mode), Image ▸ Duplicate and
// Image ▸ Reveal All.

import { h, clamp } from '../util.js';
import { toast, openModal, formRow, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas, PhotoDoc } from './doc.js';
import { FILTERS } from './adjust.js';
import { alphaBounds } from './selection.js';
import { meshWarp, maskRect, maskWithPart } from './transform.js';
import { contentAwareFillWorkspace } from './cafill.js';
import { BLEND_MODES, compositeOnto } from './blend.js';
import { installCrop2 } from './crop2.js';
import { installTransform2 } from './transform2.js';

// ---------------------------------------------------------------- content-aware scale

/** Energy of a w×h RGBA image: gradient magnitude plus protection. */
function energyOf(d, w, hh, protect, skin) {
  const E = new Float32Array(w * hh);
  const L = new Float32Array(w * hh);
  for (let i = 0; i < w * hh; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] + d[i * 4 + 3] * 0.3;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = L[y * w + Math.min(w - 1, x + 1)] - L[y * w + Math.max(0, x - 1)];
      const gy = L[Math.min(hh - 1, y + 1) * w + x] - L[Math.max(0, y - 1) * w + x];
      let e = Math.abs(gx) + Math.abs(gy);
      if (protect && protect[i] > 127) e += 1e5;
      if (skin) {
        const r = d[i * 4];
        const g = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        // a common skin-tone rule of thumb (RGB)
        if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15) e += 3e3;
      }
      E[i] = e;
    }
  }
  return E;
}

/**
 * Column orders for seam carving at low resolution: removes k vertical seams and returns, per row,
 * the original column indices of the removed seams (in removal order).
 */
function findSeams(E0, w, hh, k) {
  let w2 = w;
  const E = E0.slice();
  const idx = new Int32Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) idx[y * w + x] = x;
  const removed = Array.from({ length: hh }, () => []);
  const M = new Float32Array(w * hh);
  const seam = new Int32Array(hh);
  for (let s = 0; s < k && w2 > 2; s++) {
    for (let x = 0; x < w2; x++) M[x] = E[x];
    for (let y = 1; y < hh; y++) {
      for (let x = 0; x < w2; x++) {
        const up = M[(y - 1) * w + x];
        const l = x > 0 ? M[(y - 1) * w + x - 1] : Infinity;
        const r = x < w2 - 1 ? M[(y - 1) * w + x + 1] : Infinity;
        M[y * w + x] = E[y * w + x] + Math.min(up, l, r);
      }
    }
    let bx = 0;
    for (let x = 1; x < w2; x++) if (M[(hh - 1) * w + x] < M[(hh - 1) * w + bx]) bx = x;
    seam[hh - 1] = bx;
    for (let y = hh - 2; y >= 0; y--) {
      const x = seam[y + 1];
      let b = x;
      if (x > 0 && M[y * w + x - 1] < M[y * w + b]) b = x - 1;
      if (x < w2 - 1 && M[y * w + x + 1] < M[y * w + b]) b = x + 1;
      seam[y] = b;
    }
    for (let y = 0; y < hh; y++) {
      const x = seam[y];
      removed[y].push(idx[y * w + x]);
      for (let i = x; i < w2 - 1; i++) {
        E[y * w + i] = E[y * w + i + 1];
        idx[y * w + i] = idx[y * w + i + 1];
      }
      // neighbours of a removed seam get a little more energy so seams spread out
      if (x < w2 - 1) E[y * w + x] += 2;
      if (x > 0) E[y * w + x - 1] += 2;
    }
    w2--;
  }
  return removed;
}

/**
 * Width change of an RGBA image (W×H) to newW with seams found at low resolution. extra: another
 * W×H RGBA image (the layer mask) carved along the same seams.
 */
function carveWidth(src, W, H, newW, protect, skin, extra = null) {
  if (newW === W) return { data: src, w: W, extra };
  const k = Math.min(1, 420 / W, 360 / H);
  const lw = Math.max(3, Math.round(W * k));
  const lh = Math.max(3, Math.round(H * k));
  const c = makeCanvas(W, H);
  c.getContext('2d').putImageData(new ImageData(src, W, H), 0, 0);
  const sm = makeCanvas(lw, lh);
  sm.getContext('2d').drawImage(c, 0, 0, lw, lh);
  const ld = sm.getContext('2d').getImageData(0, 0, lw, lh).data;
  let lp = null;
  if (protect) {
    const pc = makeCanvas(W, H);
    pc.getContext('2d').putImageData(new ImageData(protect, W, H), 0, 0);
    const ps = makeCanvas(lw, lh);
    ps.getContext('2d').drawImage(pc, 0, 0, lw, lh);
    const pd = ps.getContext('2d').getImageData(0, 0, lw, lh).data;
    lp = new Uint8Array(lw * lh);
    for (let i = 0; i < lp.length; i++) lp[i] = pd[i * 4 + 3];
  }
  const E = energyOf(ld, lw, lh, lp, skin);
  // each low-resolution seam stands for `span` full-size columns
  const span = Math.max(1, Math.floor(W / lw));
  const removed = findSeams(E, lw, lh, Math.min(Math.round(Math.abs(newW - W) / span), lw - 3));
  const out = new Uint8ClampedArray(newW * H * 4);
  const xout = extra ? new Uint8ClampedArray(newW * H * 4) : null;
  const grow = newW > W;
  // every seam takes (or doubles) the same number of full-size pixels in every row, centred on
  // the seam, so all rows keep the same length and nothing wobbles; the small rest is a plain stretch
  const count = new Uint8Array(W);
  const cols = [];
  for (let y = 0; y < H; y++) {
    const ly = Math.min(lh - 1, Math.floor((y * lh) / H));
    count.fill(0);
    for (const lx of removed[ly]) {
      const X0 = clamp(Math.round((lx + 0.5) * (W / lw) - span / 2), 0, W - span);
      for (let X = X0; X < X0 + span; X++) count[X]++;
    }
    cols.length = 0;
    for (let X = 0; X < W; X++) {
      if (!grow) {
        if (!count[X]) cols.push(X);
      } else for (let r = 0; r <= count[X]; r++) cols.push(X);
    }
    if (!cols.length) cols.push(0);
    const m = cols.length;
    for (let x = 0; x < newW; x++) {
      const t = ((x + 0.5) * m) / newW - 0.5;
      const i0 = clamp(Math.floor(t), 0, m - 1);
      const i1 = Math.min(m - 1, i0 + 1);
      const f = clamp(t - i0, 0, 1);
      const a = (y * W + cols[i0]) * 4;
      const b = (y * W + cols[i1]) * 4;
      const o = (y * newW + x) * 4;
      for (let ch = 0; ch < 4; ch++) out[o + ch] = src[a + ch] * (1 - f) + src[b + ch] * f;
      if (xout) for (let ch = 0; ch < 4; ch++) xout[o + ch] = extra[a + ch] * (1 - f) + extra[b + ch] * f;
    }
  }
  return { data: out, w: newW, extra: xout };
}

function transpose(d, w, hh) {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) o[(x * hh + y) * 4 + c] = d[(y * w + x) * 4 + c];
  return o;
}

/**
 * An RGBA image (w×hh) carved to nw × nh: widths first, then heights. protect: RGBA w×hh or null.
 * Returns { data, extra }: extra is the RGBA w×hh `extra` (a mask) carved the same way, or null.
 */
function carveSize(d, w, hh, nw, nh, protect, skin, extra = null) {
  let r = carveWidth(d, w, hh, nw, protect, skin, extra);
  if (nh !== hh) {
    const t = transpose(r.data, r.w, hh);
    // the protected area for the second pass: the mask stretched to the new width (close enough)
    let p2 = null;
    if (protect) {
      const pc = makeCanvas(w, hh);
      pc.getContext('2d').putImageData(new ImageData(protect, w, hh), 0, 0);
      const ps = makeCanvas(nw, hh);
      ps.getContext('2d').drawImage(pc, 0, 0, nw, hh);
      p2 = transpose(ps.getContext('2d').getImageData(0, 0, nw, hh).data, nw, hh);
    }
    const r2 = carveWidth(t, hh, r.w, nh, p2, skin, r.extra && transpose(r.extra, r.w, hh));
    r = { data: transpose(r2.data, r2.w, r.w), w: r.w, extra: r2.extra && transpose(r2.extra, r2.w, r.w) };
  }
  return { data: r.data, extra: r.extra || null };
}

// on-canvas sessions (content-aware scale, puppet warp) live in P.transform like the free
// transform: Enter applies, Esc cancels, and P.transformBar shows their options (bar())
const finishBtns = (P) => [
  h('button.small.ph-icobtn', { title: '취소 (Esc)', 'aria-label': '취소', onclick: () => P.cancelTransform() }, icon('close', 16)),
  h('button.primary.small.ph-icobtn', { title: '적용 (Enter)', 'aria-label': '적용', onclick: () => P.applyTransform() }, icon('check', 16)),
];
const toggBtn = (on, content, title, onclick) => h(`button.small.ph-tog${on ? '.on' : ''}`, { title, 'aria-label': title, onclick }, content);
function hintText(g, label) {
  g.font = '12px system-ui, sans-serif';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(0,0,0,.7)';
  g.fillStyle = '#fff';
  g.strokeText(label, 30, 40);
  g.fillText(label, 30, 40);
}

const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];

/** Edit ▸ Content-Aware Scale on the canvas: a box with handles; the layer is carved to its size. */
class ContentAwareScale {
  constructor(E) {
    const doc = E.doc;
    const l = doc.active;
    if (!l || l.kind !== 'raster' || !l.canvas) throw new Error('내용 인식 비율은 일반(이미지) 레이어에서 씁니다. 글자·모양·고급 개체는 래스터화한 뒤 쓰세요.');
    if (l.locked || l.lockPixels || l.lockPos) throw new Error('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
    const b = doc.opaqueBounds(l);
    if (!b || b.w < 4 || b.h < 4) throw new Error('레이어에 비율을 바꿀 픽셀이 없습니다');
    this.E = E;
    this.kind = 'cascale';
    this.layer = l;
    this.before = doc.capture();
    this.B0 = { ...b };
    this.box = { ...b };
    this.amount = 100;
    this.protect = '';
    this.skin = false;
    this.src = makeCanvas(b.w, b.h);
    this.src.getContext('2d').drawImage(l.canvas, l.x - b.x, l.y - b.y);
    this.prev = {};
    // a linked layer mask is carved along the same seams, so a cut-out stays whole
    if (l.mask?.canvas && l.mask.linked !== false) {
      this.mask0 = l.mask;
      this.msrc = maskRect(l.mask, b.x, b.y, b.w, b.h);
      this.mprev = {};
    }
    // the pixels float while the box is dragged; the layer keeps the rest
    const g = doc.editPixels(l);
    g.clearRect(b.x - l.x, b.y - l.y, b.w, b.h);
    this.update(true);
  }

  /** A copy of the source (or of its mask: mask = true) at most `max` px across (cached). */
  copy(max, mask = false) {
    const cache = mask ? this.mprev : this.prev;
    if (cache[max]) return cache[max];
    const k = Math.min(1, max / Math.max(this.B0.w, this.B0.h));
    const c = makeCanvas(Math.max(4, Math.round(this.B0.w * k)), Math.max(4, Math.round(this.B0.h * k)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(mask ? this.msrc : this.src, 0, 0, c.width, c.height);
    cache[max] = c;
    return c;
  }

  /** The protected area (보호: an alpha channel) at w × hh, as RGBA, or null. */
  protectData(w, hh) {
    const ch = this.protect && (this.E.doc.channels || []).find((x) => x.id === this.protect);
    if (!ch?.canvas) return null;
    const c = makeCanvas(w, hh);
    c.getContext('2d').drawImage(ch.canvas, this.B0.x, this.B0.y, this.B0.w, this.B0.h, 0, 0, w, hh);
    return c.getContext('2d').getImageData(0, 0, w, hh).data;
  }

  /**
   * src carved to the box's proportions (양: the rest is a plain stretch), at src's resolution;
   * msrc (the mask, same size) along the same seams. Returns { c, m } (m: null without a mask).
   */
  carve(src, msrc = null) {
    const w = src.width;
    const hh = src.height;
    const nw = Math.max(2, Math.round((w * this.box.w) / this.B0.w));
    const nh = Math.max(2, Math.round((hh * this.box.h) / this.B0.h));
    const a = this.amount / 100;
    const iw = Math.max(2, Math.round(w + (nw - w) * a));
    const ih = Math.max(2, Math.round(hh + (nh - hh) * a));
    let c = src;
    let m = msrc;
    if (iw !== w || ih !== hh) {
      const r = carveSize(src.getContext('2d').getImageData(0, 0, w, hh).data, w, hh, iw, ih, this.protectData(w, hh), this.skin, msrc && msrc.getContext('2d').getImageData(0, 0, w, hh).data);
      c = makeCanvas(iw, ih);
      c.getContext('2d').putImageData(new ImageData(r.data, iw, ih), 0, 0);
      if (r.extra) {
        m = makeCanvas(iw, ih);
        m.getContext('2d').putImageData(new ImageData(r.extra, iw, ih), 0, 0);
      }
    }
    const fit = (x) => {
      if (!x || (x.width === nw && x.height === nh)) return x;
      const o = makeCanvas(nw, nh);
      const g = o.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(x, 0, 0, nw, nh);
      return o;
    };
    return { c: fit(c), m: fit(m) };
  }

  update(fine = false) {
    const E = this.E;
    const b = this.box;
    const max = fine ? 640 : 220;
    const r = this.carve(this.copy(max), this.msrc ? this.copy(max, true) : null);
    const c = makeCanvas(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(r.c, 0, 0, c.width, c.height);
    // the float shows through its (carved) mask, as the result will
    if (r.m && this.mask0.enabled !== false) {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(r.m, 0, 0, c.width, c.height);
    }
    E.float = { canvas: c, x: Math.round(b.x), y: Math.round(b.y), layerId: this.layer.id };
    if (this.inputs) {
      this.inputs.w.value = Math.round((b.w / this.B0.w) * 1000) / 10;
      this.inputs.h.value = Math.round((b.h / this.B0.h) * 1000) / 10;
    }
    E.redraw();
  }

  handleAt(p) {
    const tol = 8 / this.E.view.zoom;
    const b = this.box;
    return HANDLES.find(([, fx, fy]) => Math.abs(p.x - (b.x + fx * b.w)) <= tol && Math.abs(p.y - (b.y + fy * b.h)) <= tol)?.[0] || null;
  }

  inside(p) {
    const b = this.box;
    return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
  }

  hit(p) {
    if (this.handleAt(p)) return 'c0';
    return this.inside(p) ? 'move' : 'none';
  }

  down(p) {
    const hd = this.handleAt(p);
    this.d = hd || this.inside(p) ? { h: hd, p0: p, b0: { ...this.box } } : null;
  }

  move(p, e = {}) {
    const d = this.d;
    if (!d) return;
    const dx = p.x - d.p0.x;
    const dy = p.y - d.p0.y;
    const b0 = d.b0;
    if (!d.h) {
      this.box = { ...b0, x: b0.x + dx, y: b0.y + dy };
      this.update();
      return;
    }
    const hd = d.h;
    // the edges each handle moves; Alt scales about the middle
    let x0 = b0.x;
    let y0 = b0.y;
    let x1 = b0.x + b0.w;
    let y1 = b0.y + b0.h;
    if (hd.includes('w')) x0 += dx;
    if (hd.includes('e')) x1 += dx;
    if (hd.includes('n')) y0 += dy;
    if (hd.includes('s')) y1 += dy;
    if (e.altKey) {
      if (hd.includes('w')) x1 -= dx;
      if (hd.includes('e')) x0 -= dx;
      if (hd.includes('n')) y1 -= dy;
      if (hd.includes('s')) y0 -= dy;
    }
    let w = Math.max(4, x1 - x0);
    let hh = Math.max(4, y1 - y0);
    // corners keep the proportions (Shift: free), like Photoshop's pixel layers
    if (hd.length === 2 && !e.shiftKey) {
      const s = Math.max(w / b0.w, hh / b0.h);
      w = b0.w * s;
      hh = b0.h * s;
    }
    const cx = b0.x + b0.w / 2;
    const cy = b0.y + b0.h / 2;
    const nx = e.altKey ? cx - w / 2 : hd.includes('w') ? b0.x + b0.w - w : hd.includes('e') ? b0.x : cx - w / 2;
    const ny = e.altKey ? cy - hh / 2 : hd.includes('n') ? b0.y + b0.h - hh : hd.includes('s') ? b0.y : cy - hh / 2;
    this.box = { x: hd === 'n' || hd === 's' ? b0.x : nx, y: hd === 'e' || hd === 'w' ? b0.y : ny, w: hd === 'n' || hd === 's' ? b0.w : w, h: hd === 'e' || hd === 'w' ? b0.h : hh };
    this.update();
  }

  up() {
    if (!this.d) return;
    this.d = null;
    this.update(true);
  }

  nudge(dx, dy) {
    this.box = { ...this.box, x: this.box.x + dx, y: this.box.y + dy };
    this.update(true);
  }

  setMode() {}

  numbers() {
    return { x: 0, y: 0, w: 100, h: 100, angle: 0, skew: 0, skewV: 0 };
  }

  apply() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    E.float = null;
    const b = this.box;
    if (Math.abs(b.w - this.B0.w) < 0.5 && Math.abs(b.h - this.B0.h) < 0.5 && Math.abs(b.x - this.B0.x) < 0.5 && Math.abs(b.y - this.B0.y) < 0.5) {
      doc.restore(this.before);
      E.afterHistory?.();
      return;
    }
    const r = this.carve(this.src, this.msrc);
    const x = Math.round(b.x);
    const y = Math.round(b.y);
    const w = Math.max(1, Math.round(b.w));
    const hh = Math.max(1, Math.round(b.h));
    const g = doc.editPixels(l, { x, y, w, h: hh });
    g.imageSmoothingQuality = 'high';
    g.drawImage(r.c, x - l.x, y - l.y, w, hh);
    if (r.m) {
      // the carved mask takes the new box; the rest of the mask stays as it was
      const part = makeCanvas(w, hh);
      const pg = part.getContext('2d');
      pg.imageSmoothingQuality = 'high';
      pg.drawImage(r.m, 0, 0, w, hh);
      const cover = makeCanvas(w, hh);
      cover.getContext('2d').fillRect(0, 0, w, hh);
      l.mask = { ...this.mask0, canvas: maskWithPart(doc, this.mask0, { canvas: cover, x, y }, { canvas: part, x, y }), x: 0, y: 0 };
    }
    l._styled = null;
    doc.touch(l);
    E.commit('내용 인식 비율', this.before);
  }

  cancel() {
    this.E.float = null;
    this.E.doc.restore(this.before);
    this.E.redraw();
  }

  overlay(g) {
    const E = this.E;
    const b = this.box;
    const [x0, y0] = E.toScreen(b.x, b.y);
    const [x1, y1] = E.toScreen(b.x + b.w, b.y + b.h);
    g.save();
    g.strokeStyle = '#4aa3ff';
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    for (const [, fx, fy] of HANDLES) {
      const x = x0 + (x1 - x0) * fx;
      const y = y0 + (y1 - y0) * fy;
      g.fillStyle = '#fff';
      g.strokeStyle = '#1d6fd1';
      g.fillRect(x - 4, y - 4, 8, 8);
      g.strokeRect(x - 4 + 0.5, y - 4 + 0.5, 7, 7);
    }
    hintText(g, '내용 인식 비율: 손잡이를 끌어 크기를 바꾸세요 (모서리: 비율 유지, Shift: 자유) · Enter 적용 · Esc 취소');
    g.restore();
  }

  bar(render) {
    const E = this.E;
    const pct = (key, label) => {
      const inp = h('input.ph-num', { type: 'number', step: 1, min: 1, max: 1000, 'aria-label': label, value: Math.round((this.box[key] / this.B0[key]) * 1000) / 10 });
      inp.addEventListener('change', () => {
        const v = clamp(+inp.value || 100, 1, 1000) / 100;
        const b = this.box;
        const n = Math.max(4, this.B0[key] * v);
        const c = key === 'w' ? b.x + b.w / 2 : b.y + b.h / 2;
        this.box = key === 'w' ? { ...b, x: c - n / 2, w: n } : { ...b, y: c - n / 2, h: n };
        this.update(true);
      });
      return inp;
    };
    this.inputs = { w: pct('w', '폭'), h: pct('h', '높이') };
    const amt = h('input', { type: 'range', min: 0, max: 100, value: this.amount, 'aria-label': '양', style: { width: '90px' } });
    const amtN = h('input.ph-num', { type: 'number', min: 0, max: 100, value: this.amount, 'aria-label': '양' });
    const setAmt = (v) => {
      this.amount = clamp(Math.round(+v) || 0, 0, 100);
      amt.value = this.amount;
      amtN.value = this.amount;
      this.update(true);
    };
    amt.addEventListener('change', () => setAmt(amt.value));
    amtN.addEventListener('change', () => setAmt(amtN.value));
    const prot = h('select', { 'aria-label': '보호', title: '보호: 이 알파 채널의 흰 곳(지킬 곳)은 줄이거나 늘리지 않아요. 선택 ▸ 선택 영역 저장으로 만들어요.' },
      h('option', { value: '' }, '없음'), ...(E.doc.channels || []).map((ch) => h('option', { value: ch.id }, ch.name || '알파')));
    prot.value = this.protect;
    prot.addEventListener('change', () => {
      this.protect = prot.value;
      this.update(true);
    });
    return [
      h('span.ph-tname', icon('maximize', 16), '내용 인식 비율'),
      h('label.ph-opt', h('span', 'W'), this.inputs.w, h('small', '%')),
      h('label.ph-opt', h('span', 'H'), this.inputs.h, h('small', '%')),
      h('label.ph-opt', { title: '양: 100%는 내용 인식으로만, 0%는 보통 비율 조정처럼 늘리고 줄여요' }, h('span', '양'), amt, amtN, h('small', '%')),
      h('label.ph-opt', h('span', '보호'), prot),
      toggBtn(this.skin, icon('smile', 16), '피부톤 보호: 사람 피부색이 있는 곳은 모양을 지켜요', () => {
        this.skin = !this.skin;
        this.update(true);
        render();
      }),
      ...finishBtns(E),
    ];
  }
}

// ---------------------------------------------------------------- puppet warp

const PW_MODES = [['rigid', '고정'], ['normal', '표준'], ['distort', '왜곡']];
const PW_DENSITY = [['fewer', '점 줄이기'], ['normal', '표준'], ['more', '점 늘리기']];
const PW_CELLS = { fewer: 9, normal: 16, more: 28 };

/**
 * Moving least squares (Schaefer et al. 2006) at v: control points qs move to ps. mode: rigid
 * (고정), normal (similarity, 표준) or distort (affine, 왜곡).
 */
function mlsMap(vx, vy, qs, ps, mode, out) {
  const n = qs.length;
  let sw = 0;
  let qx = 0;
  let qy = 0;
  let px = 0;
  let py = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d2 = (qs[i][0] - vx) ** 2 + (qs[i][1] - vy) ** 2;
    if (d2 < 1e-6) {
      out[0] = ps[i][0];
      out[1] = ps[i][1];
      return;
    }
    w[i] = 1 / d2;
    sw += w[i];
    qx += w[i] * qs[i][0];
    qy += w[i] * qs[i][1];
    px += w[i] * ps[i][0];
    py += w[i] * ps[i][1];
  }
  qx /= sw;
  qy /= sw;
  px /= sw;
  py /= sw;
  const dx = vx - qx;
  const dy = vy - qy;
  if (n === 1) {
    out[0] = vx + px - qx;
    out[1] = vy + py - qy;
    return;
  }
  if (mode === 'distort' && n >= 3) {
    // affine: (v - q*) (Σ w q̂ᵀq̂)⁻¹ Σ w q̂ᵀp̂ + p*
    let a = 0;
    let b = 0;
    let d = 0;
    let m00 = 0;
    let m01 = 0;
    let m10 = 0;
    let m11 = 0;
    for (let i = 0; i < n; i++) {
      const hx = qs[i][0] - qx;
      const hy = qs[i][1] - qy;
      const bx = ps[i][0] - px;
      const by = ps[i][1] - py;
      a += w[i] * hx * hx;
      b += w[i] * hx * hy;
      d += w[i] * hy * hy;
      m00 += w[i] * hx * bx;
      m01 += w[i] * hx * by;
      m10 += w[i] * hy * bx;
      m11 += w[i] * hy * by;
    }
    const det = a * d - b * b;
    if (Math.abs(det) > 1e-9 * (a * d + 1e-12)) {
      const tx = (dx * d - dy * b) / det;
      const ty = (-dx * b + dy * a) / det;
      out[0] = tx * m00 + ty * m10 + px;
      out[1] = tx * m01 + ty * m11 + py;
      return;
    }
  }
  let fx = 0;
  let fy = 0;
  let mu = 0;
  for (let i = 0; i < n; i++) {
    const hx = qs[i][0] - qx;
    const hy = qs[i][1] - qy;
    const bx = ps[i][0] - px;
    const by = ps[i][1] - py;
    const a = hx * dx + hy * dy;
    const b = hx * dy - hy * dx;
    fx += w[i] * (bx * a - by * b);
    fy += w[i] * (bx * b + by * a);
    mu += w[i] * (hx * hx + hy * hy);
  }
  if (mode === 'rigid') {
    const len = Math.hypot(fx, fy) || 1;
    const dl = Math.hypot(dx, dy);
    out[0] = (fx / len) * dl + px;
    out[1] = (fy / len) * dl + py;
  } else {
    out[0] = fx / (mu || 1) + px;
    out[1] = fy / (mu || 1) + py;
  }
}

/**
 * The puppet's mesh over the opaque pixels of `alpha` (a canvas, in its own pixel space): a grid over
 * their bounds grown by `expand`, with the cells that hold something.
 */
function puppetMesh(alpha, { density = 'normal', expand = 2 } = {}) {
  const b = alphaBounds(alpha);
  if (!b) return null;
  const e = Math.max(0, +expand || 0);
  const B = { x: b.x - e, y: b.y - e, w: b.w + 2 * e, h: b.h + 2 * e };
  const n = PW_CELLS[density] || 16;
  const step = Math.max(3, Math.max(B.w, B.h) / n);
  const cols = Math.max(1, Math.ceil(B.w / step));
  const rows = Math.max(1, Math.ceil(B.h / step));
  // what each cell holds: the layer's alpha drawn small (4 samples per cell side)
  const t = makeCanvas(cols * 4, rows * 4);
  const tg = t.getContext('2d', { willReadFrequently: true });
  tg.drawImage(alpha, B.x, B.y, B.w, B.h, 0, 0, cols * 4, rows * 4);
  const d = tg.getImageData(0, 0, cols * 4, rows * 4).data;
  const cells = new Uint8Array(rows * cols);
  const grow = Math.round(e / (B.w / cols)) ;
  for (let r = 0; r < rows * 4; r++) {
    for (let c = 0; c < cols * 4; c++) {
      if (d[(r * cols * 4 + c) * 4 + 3] < 8) continue;
      const cr = r >> 2;
      const cc = c >> 2;
      for (let y = Math.max(0, cr - grow); y <= Math.min(rows - 1, cr + grow); y++) for (let x = Math.max(0, cc - grow); x <= Math.min(cols - 1, cc + grow); x++) cells[y * cols + x] = 1;
    }
  }
  return { B, rows, cols, cells, step: B.w / cols };
}

/** The mesh's points pushed through the pins: [x, y] per vertex, row by row. */
function puppetPoints(mesh, pins, mode) {
  const { B, rows, cols } = mesh;
  const qs = [];
  const ps = [];
  for (const p of pins) {
    qs.push(p.o);
    ps.push(p.c);
    // a pin with a fixed turn holds two more points around it, turned by that much
    if (p.rot != null) {
      const r = mesh.step * 1.5;
      const cs = Math.cos(p.rot);
      const sn = Math.sin(p.rot);
      qs.push([p.o[0] + r, p.o[1]], [p.o[0], p.o[1] + r]);
      ps.push([p.c[0] + r * cs, p.c[1] + r * sn], [p.c[0] - r * sn, p.c[1] + r * cs]);
    }
  }
  const out = [];
  const o = [0, 0];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = B.x + (c / cols) * B.w;
      const y = B.y + (r / rows) * B.h;
      if (qs.length) {
        mlsMap(x, y, qs, ps, mode, o);
        out.push([o[0], o[1]]);
      } else out.push([x, y]);
    }
  }
  return out;
}

/**
 * Draw src through the warped mesh: { canvas, x, y } in src's pixel space. Cells take the depth of
 * their nearest pin; deeper groups are drawn first so 핀 깊이 decides what goes on top.
 */
function puppetRender(src, mesh, pts, pins, interp = 'bicubic') {
  const { B, rows, cols, cells } = mesh;
  const depthOf = new Int32Array(rows * cols);
  const depths = new Set([0]);
  if (pins.some((p) => p.depth)) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = B.x + ((c + 0.5) / cols) * B.w;
        const y = B.y + ((r + 0.5) / rows) * B.h;
        let best = Infinity;
        let dp = 0;
        for (const p of pins) {
          const dd = (p.o[0] - x) ** 2 + (p.o[1] - y) ** 2;
          if (dd < best) {
            best = dd;
            dp = p.depth || 0;
          }
        }
        depthOf[r * cols + c] = dp;
        depths.add(dp);
      }
    }
  }
  const groups = [...depths].sort((a, b) => a - b);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)) - 2;
  const y0 = Math.floor(Math.min(...ys)) - 2;
  const out = makeCanvas(Math.ceil(Math.max(...xs)) - x0 + 3, Math.ceil(Math.max(...ys)) - y0 + 3);
  const og = out.getContext('2d');
  const cw = B.w / cols;
  const ch = B.h / rows;
  for (const dp of groups) {
    // with pins at different depths, each group's cells are drawn on their own
    if (groups.length === 1) {
      const m = meshWarp(src, pts, rows, cols, { sx: B.x, sy: B.y, sw: B.w, sh: B.h, interp, pad: 0 });
      og.drawImage(m.canvas, m.x - x0, m.y - y0);
      break;
    }
    const part = makeCanvas(src.width, src.height);
    const pg = part.getContext('2d');
    let any = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cells[r * cols + c] || depthOf[r * cols + c] !== dp) continue;
        const sx = Math.floor(B.x + c * cw);
        const sy = Math.floor(B.y + r * ch);
        pg.drawImage(src, sx, sy, Math.ceil(B.x + (c + 1) * cw) - sx, Math.ceil(B.y + (r + 1) * ch) - sy, sx, sy, Math.ceil(B.x + (c + 1) * cw) - sx, Math.ceil(B.y + (r + 1) * ch) - sy);
        any = true;
      }
    }
    if (!any) continue;
    const m = meshWarp(part, pts, rows, cols, { sx: B.x, sy: B.y, sw: B.w, sh: B.h, interp, pad: 0 });
    og.drawImage(m.canvas, m.x - x0, m.y - y0);
  }
  return { canvas: out, x: x0, y: y0 };
}

/** The 퍼펫 뒤틀기 smart filter: the same warp on the smart object's own pixels (same size). */
function puppetFilter(c, p) {
  const pins = p.pins || [];
  if (!pins.length) return c;
  const mesh = puppetMesh(c, p);
  if (!mesh) return c;
  const r = puppetRender(c, mesh, puppetPoints(mesh, pins, p.mode), pins);
  const o = makeCanvas(c.width, c.height);
  o.getContext('2d').drawImage(r.canvas, r.x, r.y);
  return o;
}
FILTERS.puppetWarp = { name: '퍼펫 뒤틀기', group: '왜곡', hidden: true, menu: false, params: [], fn: puppetFilter };

const pwPrefs = () => ({ mode: 'normal', density: 'normal', expand: 2, showMesh: true, ...loadPref('photo.puppet', {}) });

/** Edit ▸ Puppet Warp on the canvas: pins on a mesh over the layer; drag them to bend it. */
class PuppetWarp {
  constructor(E, { smartIndex = null } = {}) {
    const doc = E.doc;
    const l = doc.active;
    const smart = l?.kind === 'smart';
    if (!l || (!smart && (l.kind !== 'raster' || !l.canvas))) throw new Error('퍼펫 뒤틀기는 일반(이미지) 레이어나 고급 개체에서 씁니다. 글자·모양은 래스터화하거나 고급 개체로 바꾼 뒤 쓰세요.');
    if (l.locked || (!smart && l.lockPixels)) throw new Error('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
    if (smart && (l.smart.corners || l.smart.warp || !l.smartSrc)) throw new Error('원근·뒤틀기로 변형한 고급 개체에는 쓸 수 없습니다. 래스터화하거나 변형을 되돌린 뒤 쓰세요.');
    this.E = E;
    this.kind = 'puppet';
    this.layer = l;
    this.smart = smart;
    this.before = doc.capture();
    const pr = pwPrefs();
    this.mode = pr.mode;
    this.density = pr.density;
    this.expand = pr.expand;
    this.showMesh = pr.showMesh;
    this.pins = []; // { o: [x, y] where it was, c: [x, y] where it is (content px), depth, rot (radians | null) }
    this.sel = new Set();
    if (smart) {
      // pins live in the smart object's own pixels; the warp is a smart filter (editable later)
      const [a, b, c, d, e, f] = l.smart.m;
      const det = a * d - b * c || 1;
      this.toDoc = ([x, y]) => [a * x + c * y + e, b * x + d * y + f];
      this.fromDoc = ([x, y]) => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
      this.scale = Math.sqrt(Math.abs(det));
      this.src = l.smartSrc;
      const list = l.smart.filters || [];
      this.index = smartIndex != null && list[smartIndex]?.id === 'puppetWarp' ? smartIndex : list.length;
      const old = list[this.index]?.params;
      if (old) {
        Object.assign(this, { mode: old.mode || this.mode, density: old.density || this.density, expand: old.expand ?? this.expand });
        this.pins = (old.pins || []).map((p) => ({ o: [...p.o], c: [...p.c], depth: p.depth || 0, rot: p.rot ?? null }));
      }
    } else {
      this.toDoc = ([x, y]) => [x + this.ox, y + this.oy];
      this.fromDoc = ([x, y]) => [x - this.ox, y - this.oy];
      this.scale = 1;
      // the layer's pixels float while warping (the layer itself is emptied)
      this.src = l.canvas;
      this.ox = l.x;
      this.oy = l.y;
      // a linked layer mask bends along with the pixels; while warping, the float shows through it
      if (l.mask?.canvas && l.mask.linked !== false) {
        this.mask0 = l.mask;
        this.msrc = maskRect(l.mask, l.x, l.y, l.canvas.width, l.canvas.height);
        if (l.mask.enabled !== false) {
          this.shown = makeCanvas(l.canvas.width, l.canvas.height);
          const sg = this.shown.getContext('2d');
          sg.drawImage(l.canvas, 0, 0);
          sg.globalCompositeOperation = 'destination-in';
          sg.drawImage(this.msrc, 0, 0);
        }
      }
      const g = doc.editPixels(l);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    }
    this.onKey = (e) => {
      if (e.key !== 'Alt' || this.alt === (e.type === 'keydown')) return;
      this.alt = e.type === 'keydown';
      E.redraw();
    };
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    this.remesh();
  }

  get interp() {
    return this.E.transformInterp || 'bicubic';
  }

  savePrefs() {
    savePref('photo.puppet', { mode: this.mode, density: this.density, expand: this.expand, showMesh: this.showMesh });
  }

  remesh() {
    this.mesh = puppetMesh(this.src, { density: this.density, expand: this.expand });
    this.update(true);
  }

  params() {
    return { pins: this.pins.map((p) => ({ o: [...p.o], c: [...p.c], depth: p.depth, rot: p.rot })), mode: this.mode, density: this.density, expand: this.expand };
  }

  warped() {
    return this.pins.some((p) => Math.hypot(p.o[0] - p.c[0], p.o[1] - p.c[1]) > 0.3 || p.rot);
  }

  update(fine = false) {
    const E = this.E;
    const l = this.layer;
    this.pts = this.mesh ? puppetPoints(this.mesh, this.pins, this.mode) : null;
    if (this.smart) {
      // the smart filter itself is changed live (the step is recorded on Enter)
      const list = [...(l.smart.filters || [])];
      const entry = { id: 'puppetWarp', params: this.params(), enabled: true };
      list[this.index] = list[this.index] ? { ...list[this.index], ...entry } : entry;
      l.smart = { ...l.smart, filters: list };
      E.doc.touch(l);
      // the filter keeps to the smart object's own bounds: say so once when the warp goes past them
      const s = this.src;
      if (fine && !this.clipNote && this.pins.length && this.pts?.some(([x, y]) => x < -2 || y < -2 || x > s.width + 2 || y > s.height + 2)) {
        this.clipNote = true;
        E.toast('고급 개체에서는 개체의 테두리 밖으로 나간 부분이 잘려요. 더 크게 움직이려면 래스터화한 뒤 쓰세요.');
      }
    } else if (this.mesh && this.pins.length) {
      const r = puppetRender(this.shown || this.src, this.mesh, this.pts, this.pins, fine ? this.interp : 'bilinear');
      E.float = { canvas: r.canvas, x: r.x + this.ox, y: r.y + this.oy, layerId: l.id };
    } else E.float = { canvas: this.shown || this.src, x: this.ox, y: this.oy, layerId: l.id };
    E.redraw();
  }

  // ---------------------------------------------------------------- interaction (doc coords in, content px inside)

  pinAt(q, tol) {
    let best = null;
    let bd = tol * tol;
    for (const p of this.pins) {
      const dd = (p.c[0] - q[0]) ** 2 + (p.c[1] - q[1]) ** 2;
      if (dd <= bd) {
        bd = dd;
        best = p;
      }
    }
    return best;
  }

  /** Where a point on the warped mesh was before the warp (content px), or null off the mesh. */
  unwarp(q) {
    const m = this.mesh;
    if (!m) return null;
    const { B, rows, cols, cells } = m;
    const P = this.pts;
    const V = (r, c) => P[r * (cols + 1) + c];
    const S = (r, c) => [B.x + (c / cols) * B.w, B.y + (r / rows) * B.h];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cells[r * cols + c]) continue;
        for (const [a, b, cc] of [[[r, c], [r, c + 1], [r + 1, c]], [[r, c + 1], [r + 1, c + 1], [r + 1, c]]]) {
          const A = V(...a);
          const Bv = V(...b);
          const C = V(...cc);
          const den = (Bv[1] - C[1]) * (A[0] - C[0]) + (C[0] - Bv[0]) * (A[1] - C[1]);
          if (Math.abs(den) < 1e-9) continue;
          const u = ((Bv[1] - C[1]) * (q[0] - C[0]) + (C[0] - Bv[0]) * (q[1] - C[1])) / den;
          const v = ((C[1] - A[1]) * (q[0] - C[0]) + (A[0] - C[0]) * (q[1] - C[1])) / den;
          const w = 1 - u - v;
          if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
          const sa = S(...a);
          const sb = S(...b);
          const sc = S(...cc);
          return [u * sa[0] + v * sb[0] + w * sc[0], u * sa[1] + v * sb[1] + w * sc[1]];
        }
      }
    }
    return null;
  }

  tol() {
    return 8 / (this.E.view.zoom * this.scale);
  }

  hit(p) {
    const q = this.fromDoc([p.x, p.y]);
    if (this.pinAt(q, this.tol())) return 'move';
    if (this.alt && this.pinAt(q, this.tol() * 6)) return 'rotate';
    return this.unwarp(q) ? 'pivot' : 'none';
  }

  down(p, e = {}) {
    // the right button opens the menu; it doesn't add a pin
    if (e.button === 2) return;
    const q = this.fromDoc([p.x, p.y]);
    const pin = this.pinAt(q, this.tol());
    this.d = null;
    if (pin && e.altKey) {
      // Alt+click on a pin: remove it
      this.pins.splice(this.pins.indexOf(pin), 1);
      this.sel.delete(pin);
      this.update(true);
      this.E.emit?.('transform');
      return;
    }
    if (pin) {
      if (e.shiftKey) {
        if (this.sel.has(pin)) this.sel.delete(pin);
        else this.sel.add(pin);
      } else if (!this.sel.has(pin)) this.sel = new Set([pin]);
      this.d = { q0: q, start: [...this.sel].map((x) => [x, [...x.c]]) };
      this.E.emit?.('transform');
      this.E.redraw();
      return;
    }
    const near = e.altKey && this.pinAt(q, this.tol() * 6);
    if (near) {
      // Alt near a pin: turn the mesh around it
      this.sel = new Set([near]);
      const a0 = Math.atan2(q[1] - near.c[1], q[0] - near.c[0]);
      this.d = { rot: near, a0, r0: near.rot || 0 };
      this.E.emit?.('transform');
      return;
    }
    const o = this.unwarp(q);
    if (!o) {
      if (!e.shiftKey) this.sel = new Set();
      this.E.emit?.('transform');
      this.E.redraw();
      return;
    }
    const np = { o, c: [...q], depth: 0, rot: null };
    this.pins.push(np);
    this.sel = new Set([np]);
    this.d = { q0: q, start: [[np, [...np.c]]] };
    this.update(true);
    this.E.emit?.('transform');
  }

  move(p) {
    const d = this.d;
    if (!d) return;
    const q = this.fromDoc([p.x, p.y]);
    if (d.rot) {
      d.rot.rot = d.r0 + Math.atan2(q[1] - d.rot.c[1], q[0] - d.rot.c[0]) - d.a0;
      if (this.inputs?.angle) this.inputs.angle.value = Math.round((d.rot.rot * 180) / Math.PI);
    } else {
      for (const [pin, c0] of d.start) pin.c = [c0[0] + q[0] - d.q0[0], c0[1] + q[1] - d.q0[1]];
    }
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.E.transform === this) this.update();
      });
    }
  }

  up() {
    if (!this.d) return;
    this.d = null;
    this.update(true);
    this.E.emit?.('transform');
  }

  nudge(dx, dy) {
    if (!this.sel.size) return;
    for (const p of this.sel) p.c = [p.c[0] + dx / this.scale, p.c[1] + dy / this.scale];
    this.update(true);
  }

  /** Delete: remove the selected pins. */
  removeSelected() {
    if (!this.sel.size) return false;
    this.pins = this.pins.filter((p) => !this.sel.has(p));
    this.sel = new Set();
    this.update(true);
    return true;
  }

  depth(dir) {
    if (!this.sel.size) return;
    const ds = this.pins.map((p) => p.depth || 0);
    const v = dir > 0 ? Math.max(...ds) + 1 : Math.min(...ds) - 1;
    for (const p of this.sel) p.depth = v;
    this.update(true);
  }

  setMode() {}

  numbers() {
    return { x: 0, y: 0, w: 100, h: 100, angle: 0, skew: 0, skewV: 0 };
  }

  finish() {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    cancelAnimationFrame(this.raf);
  }

  apply() {
    const E = this.E;
    const doc = E.doc;
    const l = this.layer;
    this.finish();
    E.float = null;
    if (!this.warped()) {
      doc.restore(this.before);
      E.afterHistory?.();
      return;
    }
    if (this.smart) {
      this.update(true);
      E.commit('고급 필터: 퍼펫 뒤틀기', this.before);
      return;
    }
    const pts = puppetPoints(this.mesh, this.pins, this.mode);
    const r = puppetRender(this.src, this.mesh, pts, this.pins, this.interp);
    const x = r.x + this.ox;
    const y = r.y + this.oy;
    const g = doc.editPixels(l, { x, y, w: r.canvas.width, h: r.canvas.height });
    g.drawImage(r.canvas, x - l.x, y - l.y);
    if (this.msrc) {
      // the mask through the same mesh; where the mesh lands, it replaces the old mask
      const rm = puppetRender(this.msrc, this.mesh, pts, this.pins, this.interp);
      const full = makeCanvas(this.src.width, this.src.height);
      full.getContext('2d').fillRect(0, 0, full.width, full.height);
      const rc = puppetRender(full, this.mesh, pts, this.pins, 'bilinear');
      l.mask = { ...this.mask0, canvas: maskWithPart(doc, this.mask0, { canvas: rc.canvas, x: rc.x + this.ox, y: rc.y + this.oy }, { canvas: rm.canvas, x: rm.x + this.ox, y: rm.y + this.oy }), x: 0, y: 0 };
    }
    l._styled = null;
    doc.touch(l);
    E.commit('퍼펫 뒤틀기', this.before);
  }

  cancel() {
    this.finish();
    this.E.float = null;
    this.E.doc.restore(this.before);
    this.E.redraw();
  }

  overlay(g) {
    const E = this.E;
    const S = (q) => {
      const [x, y] = this.toDoc(q);
      return E.toScreen(x, y);
    };
    g.save();
    const m = this.mesh;
    if (m && this.showMesh && this.pts) {
      const { rows, cols, cells } = m;
      const V = (r, c) => S(this.pts[r * (cols + 1) + c]);
      g.strokeStyle = 'rgba(40,40,40,.55)';
      g.lineWidth = 1;
      g.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!cells[r * cols + c]) continue;
          const a = V(r, c);
          const b = V(r, c + 1);
          const cc = V(r + 1, c + 1);
          const d = V(r + 1, c);
          g.moveTo(...a);
          g.lineTo(...b);
          g.lineTo(...cc);
          g.lineTo(...d);
          g.closePath();
          g.moveTo(...b);
          g.lineTo(...d);
        }
      }
      g.stroke();
    }
    for (const p of this.pins) {
      const [x, y] = S(p.c);
      g.fillStyle = '#ffd400';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 5.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (this.sel.has(p)) {
        g.fillStyle = '#000';
        g.beginPath();
        g.arc(x, y, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      if (this.sel.has(p) && (this.alt || p.rot != null)) {
        // the turn circle around the selected pin (Alt)
        g.strokeStyle = '#fff';
        g.setLineDash([3, 3]);
        g.beginPath();
        g.arc(x, y, 40, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        const a = p.rot || 0;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * 40, y + Math.sin(a) * 40);
        g.stroke();
        g.font = '11px system-ui, sans-serif';
        g.fillStyle = '#fff';
        g.fillText(`${Math.round((a * 180) / Math.PI)}°`, x + 44, y - 6);
      }
    }
    const phone = document.body.classList.contains('mobile');
    if (phone) hintText(g, this.pins.length ? '핀을 끌어 모양을 바꾸세요' : '메시를 탭해 핀을 꽂으세요');
    else hintText(g, this.pins.length ? '핀을 끌어 모양을 바꾸세요 · Alt+클릭: 핀 삭제 · 핀 근처에서 Alt+끌기: 회전 · Enter 적용 · Esc 취소' : '퍼펫 뒤틀기: 메시 위를 클릭해 핀을 꽂으세요 (움직이지 않을 곳에도 꽂아요)');
    g.restore();
  }

  bar(render) {
    const sel = (items, value, label, title, onchange) => {
      const s = h('select', { 'aria-label': label, title }, items.map(([v, t]) => h('option', { value: v }, t)));
      s.value = value;
      s.addEventListener('change', () => onchange(s.value));
      return h('label.ph-opt', h('span', label), s);
    };
    const exp = h('input.ph-num', { type: 'number', min: 0, max: 200, value: this.expand, 'aria-label': '확장' });
    exp.addEventListener('change', () => {
      this.expand = clamp(Math.round(+exp.value) || 0, 0, 200);
      exp.value = this.expand;
      this.savePrefs();
      this.remesh();
    });
    const mesh = h('input', { type: 'checkbox', checked: this.showMesh });
    mesh.addEventListener('change', () => {
      this.showMesh = mesh.checked;
      this.savePrefs();
      this.E.redraw();
    });
    const one = this.sel.size === 1 ? [...this.sel][0] : null;
    const angle = h('input.ph-num', { type: 'number', min: -360, max: 360, value: one?.rot != null ? Math.round((one.rot * 180) / Math.PI) : 0, disabled: !one || one.rot == null, 'aria-label': '회전 각도' });
    angle.addEventListener('change', () => {
      if (!one) return;
      one.rot = ((+angle.value || 0) * Math.PI) / 180;
      this.update(true);
    });
    this.inputs = { angle };
    return [
      h('span.ph-tname', icon('move', 16), '퍼펫 뒤틀기'),
      sel(PW_MODES, this.mode, '모드', '고정: 단단하게 · 표준: 자연스럽게 · 왜곡: 늘어나고 기울어지게', (v) => {
        this.mode = v;
        this.savePrefs();
        this.update(true);
      }),
      sel(PW_DENSITY, this.density, '밀도', '메시 점의 간격: 점이 많을수록 정밀하지만 느려요', (v) => {
        this.density = v;
        this.savePrefs();
        this.remesh();
      }),
      h('label.ph-opt', { title: '메시를 내용의 가장자리 밖으로 넓혀요' }, h('span', '확장'), exp, h('small', 'px')),
      h('label.ph-opt', mesh, h('span', '메시 표시')),
      h('span.ph-opt', { title: '핀 깊이: 겹치는 곳에서 선택한 핀 쪽이 앞(위)이나 뒤(아래)에 오게 해요' }, h('span', '핀 깊이'),
        h('button.small', { title: '앞으로', disabled: !this.sel.size, onclick: () => this.depth(1) }, '앞으로'),
        h('button.small', { title: '뒤로', disabled: !this.sel.size, onclick: () => this.depth(-1) }, '뒤로')),
      sel([['auto', '자동'], ['fixed', '고정']], one?.rot != null ? 'fixed' : 'auto', '회전', '선택한 핀 둘레의 회전: 자동은 메시를 따라, 고정은 정한 각도로 (Alt+끌기로도 정해요)', (v) => {
        if (!one) return;
        one.rot = v === 'fixed' ? one.rot || 0 : null;
        this.update(true);
        render();
      }),
      h('label.ph-opt', angle, h('small', '°')),
      h('button.small', { title: '선택한 핀 삭제 (Delete, Alt+클릭)', disabled: !this.sel.size, onclick: () => {
        this.removeSelected();
        render();
      } }, '핀 삭제'),
      h('button.small.ph-icobtn', { title: '모든 핀 제거', 'aria-label': '모든 핀 제거', onclick: () => {
        this.pins = [];
        this.sel = new Set();
        this.update(true);
        render();
      } }, icon('reset', 16)),
      ...finishBtns(this.E),
    ];
  }
}

// ---------------------------------------------------------------- fade

// Photoshop's blend modes (dissolve and the computed ones included)
const FADE_MODES = BLEND_MODES.map(([id, name]) => [id, name]);

function fadeDialog(P) {
  const doc = P.doc;
  const e = doc?.history.undoStack.at(-1);
  const l = doc?.active;
  const prev = e?.state.layers.find((x) => x.id === l?.id);
  if (!e || !l || l.kind !== 'raster' || !l.canvas || !prev?.canvas || prev.canvas === l.canvas) return toast('희미하게 할 마지막 작업이 없습니다 (필터·조정·칠하기 바로 뒤에 쓰세요)');
  const after = l.canvas;
  const ax = l.x;
  const ay = l.y;
  const before = doc.capture();
  const op = h('input', { type: 'range', min: 0, max: 100, value: 100 });
  const opn = h('span', '100%');
  const mode = h('select', FADE_MODES.map(([v, t]) => h('option', { value: v }, t)));
  const apply = () => {
    opn.textContent = `${op.value}%`;
    const a = +op.value / 100;
    const c = makeCanvas(after.width, after.height);
    const g = c.getContext('2d');
    if (mode.value === 'normal') {
      // part-way between before and after (an erased stroke comes partly back too)
      g.globalAlpha = 1 - a;
      g.drawImage(prev.canvas, prev.x - ax, prev.y - ay);
      g.globalAlpha = a;
      g.globalCompositeOperation = 'lighter';
      g.drawImage(after, 0, 0);
    } else {
      // the edit blended over what was there before
      g.drawImage(prev.canvas, prev.x - ax, prev.y - ay);
      compositeOnto(g, after, 0, 0, mode.value, a);
    }
    l.canvas = c;
    l._styled = null;
    doc.touch(l);
    P.redraw();
  };
  op.addEventListener('input', apply);
  mode.addEventListener('change', apply);
  let ok = false;
  openModal({
    title: `희미하게 하기: ${e.label}`,
    width: '380px',
    body: [formRow('불투명도', op, opn), formRow('모드', mode)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; P.commit(`희미하게 하기: ${e.label}`, before); } }],
    onClose: () => {
      if (ok) return;
      doc.restore(before);
      P.afterHistory();
    },
  });
  return undefined;
}

// ---------------------------------------------------------------- install

export function installEdit2(P) {
  const C = P.cmd;
  installCrop2(P);
  installTransform2(P);
  // on-canvas sessions: content-aware scale and puppet warp
  const start = (Kind, opts, msg) => {
    if (!P.doc) return toast('먼저 문서를 여세요');
    if (P.transform) P.applyTransform();
    P.finishText?.();
    try {
      P.transform = new Kind(P, opts);
      P.emit('transform');
      if (msg) toast(msg);
    } catch (err) {
      toast(String(err.message || err));
    }
    return undefined;
  };
  C.contentAwareScale = () => start(ContentAwareScale, undefined, '손잡이를 끌어 크기를 바꾸세요. 지킬 곳은 옵션 막대의 보호에서 알파 채널로 골라요.');
  C.puppetWarp = (opts) => start(PuppetWarp, opts, '메시 위를 클릭해 핀을 꽂고, 핀을 끌어 모양을 바꾸세요. Enter로 적용해요.');
  C.contentAwareFillWorkspace = () => contentAwareFillWorkspace(P);
  const tb = P.transformBar;
  P.transformBar = (render) => {
    const T = P.transform;
    if (!T?.bar) return tb ? tb(render) : [];
    const out = T.bar(render);
    // phones have no Enter / Esc and the bar scrolls: cancel and apply come first there
    if (document.body.classList.contains('mobile')) out.splice(1, 0, ...out.splice(-2));
    return out;
  };
  const sessionMenu = () => [
    ...(P.transform.kind === 'puppet' ? [{ label: '모든 핀 제거', action: () => {
      P.transform.pins = [];
      P.transform.sel = new Set();
      P.transform.update(true);
      P.emit('transform');
    } }, '-'] : []),
    { label: '적용', key: 'Enter', action: () => P.applyTransform() },
    { label: '취소', key: 'Esc', action: () => P.cancelTransform() },
  ];
  P.extendMenus = [...(P.extendMenus || []), () => {
    const keys = P.viewKeys;
    P.viewKeys = (e, mod) => {
      const T = P.transform;
      // Delete removes the selected pins
      if (T?.kind === 'puppet' && !mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (T.removeSelected()) P.emit('transform');
        return true;
      }
      return keys?.(e, mod) || false;
    };
    // after transform2.js has wrapped the right-click menu
    setTimeout(() => {
      const ctx = P.contextMenu;
      if (typeof ctx === 'function') P.contextMenu = (...a) => (P.transform?.bar ? sessionMenu() : ctx(...a));
    }, 0);
    // double-click on a 퍼펫 뒤틀기 smart filter: back to its pins on the canvas
    const edit = P.editSmartFilter;
    P.editSmartFilter = (l, i) => (l?.smart?.filters?.[i]?.id === 'puppetWarp' ? C.puppetWarp({ smartIndex: i }) : edit?.(l, i));
  }];
  C.fade = () => fadeDialog(P);
  C.duplicateDoc = () => {
    const doc = P.doc;
    if (!doc) return;
    const st = doc.capture();
    const d = new PhotoDoc({ name: `${doc.name} 복사`, width: doc.width, height: doc.height, background: null });
    d.restore(st);
    d.name = `${doc.name} 복사`;
    d.saved = false;
    P.openDoc(d);
  };
  C.revealAll = () => {
    const doc = P.doc;
    if (!doc) return undefined;
    let x0 = 0;
    let y0 = 0;
    let x1 = doc.width;
    let y1 = doc.height;
    for (const l of doc.layers) {
      const b = doc.bounds(l);
      if (!b) continue;
      x0 = Math.min(x0, Math.floor(b.x));
      y0 = Math.min(y0, Math.floor(b.y));
      x1 = Math.max(x1, Math.ceil(b.x + b.w));
      y1 = Math.max(y1, Math.ceil(b.y + b.h));
    }
    if (x0 === 0 && y0 === 0 && x1 === doc.width && y1 === doc.height) return toast('캔버스 밖으로 나간 부분이 없습니다');
    P.cropTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false, '모두 나타내기');
    return undefined;
  };
}

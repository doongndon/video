// Photo editor tools. A tool gets pointer events in document coordinates plus the editor context
// `E` (current doc, colours, tool options, view and helpers) and draws its own overlay.

import { makeCanvas, cloneCanvas, newLayer, boxCorners, SHAPES } from './doc.js';
import * as SEL from './selection.js';
import { hasFx } from './styles.js';
import { mixIntoMask } from './selectx.js';
import { FONT_CATEGORIES } from '../fonts.js';
import { h } from '../util.js';
import { icon } from '../ui/icons.js';
import { BLEND_MODES, compositeOnto } from './blend.js';
import { GRADIENTS } from './resources.js';
import { RETOUCH_MODES, retouchMode } from './retouchmix.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hexRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// ---------------------------------------------------------------- brush dabs

const dabCache = new Map();
/** A round brush dab of diameter `size`, hardness 0..1, in `color` (alpha = brush shape). */
function dab(size, hardness, color, hard = false) {
  const key = `${size}|${hardness}|${color}|${hard}`;
  let c = dabCache.get(key);
  if (c) return c;
  const s = Math.max(1, Math.ceil(size));
  c = makeCanvas(s, s);
  const g = c.getContext('2d');
  if (hard) {
    g.fillStyle = color;
    if (s <= 2) g.fillRect(0, 0, s, s);
    else {
      const img = g.createImageData(s, s);
      const [r, gg, b] = hexRgb(color);
      const rr = s / 2;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          if ((x + 0.5 - rr) ** 2 + (y + 0.5 - rr) ** 2 <= rr * rr) {
            const o = (y * s + x) * 4;
            img.data[o] = r;
            img.data[o + 1] = gg;
            img.data[o + 2] = b;
            img.data[o + 3] = 255;
          }
        }
      }
      g.putImageData(img, 0, 0);
    }
  } else {
    const r = s / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    const [cr, cg, cb] = hexRgb(color);
    const h = Math.min(0.99, Math.max(0, hardness));
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    grad.addColorStop(h, `rgba(${cr},${cg},${cb},1)`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }
  if (dabCache.size > 60) dabCache.clear();
  dabCache.set(key, c);
  return c;
}

/** Falloff weight of a dab at distance d from its centre (radius r, hardness h). */
const falloff = (d, r, h) => (d >= r ? 0 : d <= r * h ? 1 : 1 - (d - r * h) / Math.max(1e-6, r * (1 - h)));
// the blur and sharpen tools' 3×3 kernel: rows, then columns, then weights (they add up to 10)
const taps = [0, 0, 0, -1, 1, -1, -1, 1, 1, 0, -1, 1, 0, 0, -1, 1, -1, 1];
const tapW = [4, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5];

// ---------------------------------------------------------------- strokes (brush, pencil, eraser, mask, clone, heal)

/**
 * A paint stroke on the active layer (or its mask). Dabs accumulate in a buffer so the stroke's
 * opacity caps like Photoshop's; the layer = pre-stroke pixels + buffer, clipped to the selection.
 */
export class Stroke {
  constructor(E, mode, o) {
    const doc = E.doc;
    this.E = E;
    this.mode = mode; // paint | erase | clone | heal
    this.o = o;
    this.layer = doc.active;
    this.before = doc.capture();
    // painting on a mask: the layer's mask, the quick mask or an alpha channel
    const mt = E.maskTarget?.() || (E.editMask && this.layer?.mask ? { kind: 'layer', canvas: this.layer.mask.canvas, x: this.layer.mask.x, y: this.layer.mask.y, edit: () => doc.editMask(this.layer) } : null);
    this.onMask = !!mt;
    if (mt) {
      this.maskKind = mt.kind;
      this.maskInvert = !!mt.invert;
      this.base = mt.canvas;
      this.g = mt.edit();
      this.ox = mt.x;
      this.oy = mt.y;
    } else {
      const old = this.layer.canvas;
      const [ox, oy] = [this.layer.x, this.layer.y];
      this.g = doc.editPixels(this.layer, { x: 0, y: 0, w: doc.width, h: doc.height });
      // pre-stroke pixels at the (possibly grown) canvas size: editing swapped in a copy, so the old
      // canvas is exactly that (and is never changed) unless the canvas had to grow
      this.base = sameGeometry(old, ox, oy, this.layer) ? old : cloneCanvas(this.layer.canvas);
      this.ox = this.layer.x;
      this.oy = this.layer.y;
    }
    const tc = this.g.canvas;
    this.buf = makeCanvas(tc.width, tc.height);
    this.bg = this.buf.getContext('2d');
    this.sel = doc.selection?.canvas || null;
    this.last = null;
    this.rest = 0;
    this.dirty = null;
    if (mode === 'clone') {
      this.src = o.srcCanvas || (o.sampleAll ? doc.flatten() : E.layerAsDocCanvas(this.layer, this.base));
      this.srcOff = o.cloneOffset;
    }
    // symmetry painting (brush, pencil, eraser): every dab is repeated in mirror / around a centre
    this.sym = mode === 'heal' ? null : E.symmetryTransforms?.() || null;
  }

  color() {
    // on a mask only the dab's alpha counts (see flush)
    if (this.onMask) return '#000000';
    return this.o.color;
  }

  to(p, pressure = 1) {
    // smoothing: the brush trails the pointer like a weight on a string
    if (this.o.smoothing > 0 && this.sm) {
      const k = 1 - Math.min(0.92, this.o.smoothing);
      p = { x: this.sm.x + (p.x - this.sm.x) * k, y: this.sm.y + (p.y - this.sm.y) * k };
    }
    this.sm = p;
    this.pressure = pressure;
    const size = Math.max(1, this.o.size * (this.o.pressureSize ? Math.max(0.1, pressure) : 1));
    if (!this.last) {
      this.stamp(p.x, p.y, size);
      this.last = p;
      return;
    }
    const step = Math.max(1, size * (this.o.spacing ?? 0.15));
    let d = dist(this.last, p);
    let t = this.rest;
    const dx = (p.x - this.last.x) / (d || 1);
    const dy = (p.y - this.last.y) / (d || 1);
    if (d > 0.5) this.dir = Math.atan2(dy, dx);
    while (t + step <= d) {
      t += step;
      this.stamp(this.last.x + dx * t, this.last.y + dy * t, size);
    }
    this.rest = t - d;
    if (this.rest < -step) this.rest = 0;
    d = 0;
    this.last = p;
    this.flush();
  }

  stamp(x, y, size) {
    const T = this.sym;
    if (!T) return this.stamp1(x, y, size);
    const d0 = this.dir;
    for (const t of T) {
      const [px, py, dd] = t(x, y, d0 || 0);
      this.dir = dd;
      this.stamp1(px, py, size);
    }
    this.dir = d0;
    return undefined;
  }

  stamp1(x, y, size) {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const r = size / 2;
    let rect = { x: Math.floor(lx - r) - 1, y: Math.floor(ly - r) - 1, w: Math.ceil(size) + 3, h: Math.ceil(size) + 3 };
    const g = this.bg;
    g.globalAlpha = this.o.flow ?? 1;
    if (this.o.engine) {
      // brush tips and dynamics (brushes.js)
      rect = this.o.engine(this, lx, ly, size, x, y);
      if (!rect) return;
    } else if (this.mode === 'clone') {
      const s = Math.ceil(size);
      const t = makeCanvas(s, s);
      const tg = t.getContext('2d');
      tg.drawImage(this.src, -(x + this.srcOff.x - s / 2), -(y + this.srcOff.y - s / 2));
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(dab(size, this.o.hardness, '#000'), 0, 0, s, s);
      g.drawImage(t, lx - s / 2, ly - s / 2);
    } else {
      const col = this.mode === 'paint' ? this.color() : '#000000';
      g.drawImage(dab(size, this.o.hardness, col, !!this.o.hard), Math.round((lx - size / 2) * (this.o.hard ? 1 : 100)) / (this.o.hard ? 1 : 100), this.o.hard ? Math.round(ly - size / 2) : ly - size / 2, Math.ceil(size), Math.ceil(size));
    }
    g.globalAlpha = 1;
    if (this.sel) {
      g.save();
      g.beginPath();
      g.rect(rect.x, rect.y, rect.w, rect.h);
      g.clip();
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this.sel, -this.ox, -this.oy);
      g.restore();
    }
    this.dirty = this.dirty ? union(this.dirty, rect) : rect;
  }

  /** Redraw the changed area of the target: pre-stroke pixels + stroke buffer. */
  flush() {
    const r = this.dirty;
    if (!r) return;
    this.dirty = null;
    const g = this.g;
    const tc = g.canvas;
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    const w = Math.min(tc.width, r.x + r.w) - x;
    const h = Math.min(tc.height, r.y + r.h) - y;
    if (w <= 0 || h <= 0) return;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.base, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = this.o.opacity ?? 1;
    if (this.mode === 'heal') {
      // show the area being healed
      g.globalAlpha = 0.35;
      g.globalCompositeOperation = 'source-atop';
      g.drawImage(this.buf, 0, 0);
    } else if (this.onMask) {
      // grey paints part-way: new = old·(1−a) + grey·a (the eraser paints the background colour)
      let v = (this.mode === 'erase' ? E_lum(this.E.bg) : E_lum(this.o.color)) / 255;
      if (this.maskInvert) v = 1 - v;
      g.globalAlpha = 1;
      mixIntoMask(g, this.buf, v, this.o.opacity ?? 1);
    } else {
      // o.blend: the brush's mode in the options bar (a canvas operation, set by brushes.js)
      g.globalCompositeOperation = this.mode === 'erase' ? 'destination-out' : this.layer.lockAlpha ? 'source-atop' : this.o.blend || 'source-over';
      g.drawImage(this.buf, 0, 0);
    }
    g.restore();
    if (this.maskKind === 'quick' || this.maskKind === 'channel') this.E.doc.rev++;
    else {
      this.layer._styled = null;
      // only this rectangle changed, unless layer styles (a shadow, a stroke) spread it further
      const feathered = this.onMask && this.layer.mask?.feather > 0;
      this.E.doc.touch(this.layer, feathered ? null : changedRect(this.E.doc, this.layer, { x: x + this.ox, y: y + this.oy, w, h }));
    }
    this.E.redraw();
  }

  end() {
    this.flush();
    if (this.mode === 'heal' && !this.E.healFill?.(this)) heal(this);
    else if (this.o.afterStroke) this.o.afterStroke(this);
    // every change was already marked (flush, healing): no need to redraw the whole picture, which
    // made the end of each stroke stall on big documents
    this.E.commit(this.o.label || '브러시', this.before, { touched: true });
  }
}

function E_lum(hex) {
  const [r, g, b] = hexRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Point in a convex quad (any winding). */
function insideQuad(pt, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (pt[1] - ay) - (by - ay) * (pt[0] - ax);
    if (c === 0) continue;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  return true;
}

/** The bottom layer that fills the canvas under everything else: auto-select leaves it alone. */
function isBackdrop(doc, l) {
  if (l !== doc.layers[0] || l.parent || doc.layers.length < 2 || l.kind !== 'raster') return false;
  const b = doc.opaqueBounds(l);
  return !!b && b.x <= 0 && b.y <= 0 && b.x + b.w >= doc.width && b.y + b.h >= doc.height;
}

const sameGeometry = (c, x, y, l) => !!c && c !== l.canvas && c.width === l.canvas.width && c.height === l.canvas.height && x === l.x && y === l.y;

/** `r` when a change inside it shows only inside it: no layer styles on the layer or its groups. */
export function changedRect(doc, layer, r) {
  for (let l = layer; l; l = l.parent ? doc.layer(l.parent) : null) if (hasFx(l.fx)) return null;
  return r;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Spot healing: fill the painted area from its surroundings (diffusion, coarse to fine). */
function heal(st) {
  const g = st.g;
  const tc = g.canvas;
  const bd = st.buf.getContext('2d').getImageData(0, 0, tc.width, tc.height).data;
  let x0 = tc.width;
  let y0 = tc.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < tc.height; y++) {
    for (let x = 0; x < tc.width; x++) {
      if (bd[(y * tc.width + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  const m = 6;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(tc.width - 1, x1 + m);
  y1 = Math.min(tc.height - 1, y1 + m);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const bg = st.base.getContext('2d');
  const img = bg.getImageData(x0, y0, w, h);
  const d = img.data;
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bd[((y + y0) * tc.width + x + x0) * 4 + 3] > 20) hole[y * w + x] = 1;
  const f = new Float32Array(w * h * 4);
  for (let i = 0; i < d.length; i++) f[i] = d[i];
  // initial guess: average colour of the ring around the hole
  let sum = [0, 0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < w * h; i++) {
    if (hole[i]) continue;
    for (let k = 0; k < 4; k++) sum[k] += f[i * 4 + k];
    cnt++;
  }
  sum = sum.map((v) => v / Math.max(1, cnt));
  for (let i = 0; i < w * h; i++) if (hole[i]) for (let k = 0; k < 4; k++) f[i * 4 + k] = sum[k];
  const iters = Math.min(600, 40 + Math.max(w, h) * 4);
  for (let it = 0; it < iters; it++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        for (let k = 0; k < 4; k++) f[i * 4 + k] = (f[(i - 1) * 4 + k] + f[(i + 1) * 4 + k] + f[(i - w) * 4 + k] + f[(i + w) * 4 + k]) / 4;
      }
    }
  }
  // a little texture back (noise matched to the surroundings' variation)
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    const n = (Math.random() - 0.5) * 6;
    for (let k = 0; k < 3; k++) d[i * 4 + k] = f[i * 4 + k] + n;
    d[i * 4 + 3] = f[i * 4 + 3];
  }
  g.save();
  g.globalCompositeOperation = 'copy';
  g.drawImage(st.base, 0, 0);
  g.restore();
  g.putImageData(img, x0, y0);
  st.E.doc.touch(st.layer);
  st.E.redraw();
}

// ---------------------------------------------------------------- retouch brushes (blur, sharpen, smudge, dodge, burn, push)

class Retouch {
  constructor(E, kind, o) {
    this.E = E;
    this.kind = kind;
    this.o = o;
    this.layer = E.doc.active;
    this.before = E.doc.capture();
    this.g = E.doc.editPixels(this.layer, { x: 0, y: 0, w: E.doc.width, h: E.doc.height });
    this.last = null;
    this.carry = null;
    // the part of the document changed since the last redraw (doc coords)
    this.dirty = null;
    // 모든 레이어 샘플링 (blur, sharpen, smudge): the picture as it shows is worked on, and the
    // result is laid on the active layer (which can be an empty layer above)
    if (o.sampleAll && ['blur', 'sharpen', 'smudge'].includes(kind)) this.all = E.doc.flatten().getContext('2d', { willReadFrequently: true });
  }

  to(p) {
    if (!this.last) {
      this.last = p;
      if (this.kind !== 'smudge' && this.kind !== 'push') this.apply(p, { x: 0, y: 0 });
      // 손가락 페인팅: the stroke starts with the foreground colour on the finger
      else if (this.kind === 'smudge' && this.o.fingerPaint) this.apply(p, { x: 0, y: 0 }, [...hexRgb(this.E.fg || '#000000'), 255]);
      return;
    }
    const step = Math.max(1, this.o.size * 0.2);
    const d = dist(this.last, p);
    const n = Math.max(1, Math.floor(d / step));
    for (let i = 1; i <= n; i++) {
      const q = { x: this.last.x + ((p.x - this.last.x) * i) / n, y: this.last.y + ((p.y - this.last.y) * i) / n };
      const prev = { x: this.last.x + ((p.x - this.last.x) * (i - 1)) / n, y: this.last.y + ((p.y - this.last.y) * (i - 1)) / n };
      this.apply(q, { x: q.x - prev.x, y: q.y - prev.y });
    }
    this.last = p;
    this.layer._styled = null;
    // only the brushed part is redrawn (unless styles spread it further)
    this.E.doc.touch(this.layer, this.dirty && changedRect(this.E.doc, this.layer, this.dirty));
    this.dirty = null;
    this.E.redraw();
  }

  apply(p, mv, paint = null) {
    const g = this.g;
    const r = this.o.size / 2;
    const cx = p.x - this.layer.x;
    const cy = p.y - this.layer.y;
    const pad = this.kind === 'push' ? Math.ceil(Math.hypot(mv.x, mv.y) * 2) + 2 : 2;
    const x0 = Math.max(0, Math.floor(cx - r - pad));
    const y0 = Math.max(0, Math.floor(cy - r - pad));
    const x1 = Math.min(g.canvas.width, Math.ceil(cx + r + pad));
    const y1 = Math.min(g.canvas.height, Math.ceil(cy + r + pad));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 2 || h <= 2) return;
    const r0 = { x: x0 + this.layer.x, y: y0 + this.layer.y, w, h };
    this.dirty = this.dirty ? union(this.dirty, r0) : r0;
    // with 모든 레이어 샘플링 the shown picture is worked on (and kept up to date for the next dabs);
    // tv / tWt keep what each pixel became and how strongly, for the layer
    const img = this.all ? this.all.getImageData(x0 + this.layer.x, y0 + this.layer.y, w, h) : g.getImageData(x0, y0, w, h);
    const d = img.data;
    const src = new Uint8ClampedArray(d);
    const tv = this.all ? new Uint8ClampedArray(d.length) : null;
    const tWt = this.all ? new Float32Array(w * h) : null;
    const mode = this.o.mode && this.o.mode !== 'normal' && ['blur', 'sharpen', 'smudge'].includes(this.kind) ? this.o.mode : null;
    const vv = [0, 0, 0, 0];
    // mixed premultiplied, so transparent pixels don't darken what they touch
    const put = (o, t) => {
      if (mode) retouchMode(mode, src, o, vv);
      const a0 = src[o + 3];
      const a = a0 + (vv[3] - a0) * t;
      if (a > 0) for (let c = 0; c < 3; c++) d[o + c] = (src[o + c] * a0 + (vv[c] * vv[3] - src[o + c] * a0) * t) / a;
      d[o + 3] = a;
      if (tv) {
        for (let c = 0; c < 4; c++) tv[o + c] = vv[c];
        tWt[o >> 2] = t;
      }
    };
    const k = (this.o.strength ?? 50) / 100;
    const avg = [0, 0, 0, 0];
    // dodge and burn work on one tonal range (shadows, midtones, highlights), like Photoshop
    const range = this.o.range || 'midtones';
    const tone = (l) => (range === 'shadows' ? (1 - l) * (1 - l) : range === 'highlights' ? l * l : 1 - (2 * l - 1) * (2 * l - 1));
    const hard = this.o.hardness ?? 0.5;
    const sel = this.E.doc.selection ? this.E.selAlpha(x0 + this.layer.x, y0 + this.layer.y, w, h) : null;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let wgt = falloff(Math.hypot(x0 + x + 0.5 - cx, y0 + y + 0.5 - cy), r, hard) * k;
        if (sel) wgt *= sel[y * w + x] / 255;
        if (wgt <= 0) continue;
        const o = (y * w + x) * 4;
        if (this.kind === 'blur' || this.kind === 'sharpen') {
          // the 3×3 average, weighted by opacity (the colour of see-through pixels doesn't count)
          let sa = 0;
          avg[0] = avg[1] = avg[2] = 0;
          for (let n = 0; n < 9; n++) {
            const q = o + (taps[n] * w + taps[n + 9]) * 4;
            const wa = tapW[n] * src[q + 3];
            sa += wa;
            for (let c = 0; c < 3; c++) avg[c] += src[q + c] * wa;
          }
          for (let c = 0; c < 3; c++) avg[c] = sa > 0 ? avg[c] / sa : src[o + c];
          avg[3] = sa / 10;
          for (let c = 0; c < 4; c++) {
            let v = this.kind === 'blur' ? avg[c] : src[o + c] + (src[o + c] - avg[c]) * 1.5;
            if (this.kind === 'sharpen' && this.o.protectDetail) {
              // 세부 묘사 보호: little overshoot past the neighbours, so no halos or speckles
              const ns = [src[o - 4 + c], src[o + 4 + c], src[o - w * 4 + c], src[o + w * 4 + c], src[o + c]];
              const lo = Math.min(...ns);
              const hi = Math.max(...ns);
              v = Math.min(hi + (hi - lo) * 0.25, Math.max(lo - (hi - lo) * 0.25, v));
            }
            vv[c] = v;
          }
          put(o, wgt * (this.kind === 'sharpen' ? (this.o.protectDetail ? 1 : 0.6) : 1));
        } else if (this.kind === 'dodge' || this.kind === 'burn') {
          const L = src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114;
          const tw = tone(L / 255) * wgt * 0.35;
          if (this.o.protectTones) {
            // 톤 보호: only the brightness moves; the colour keeps its hue and strength, shrunk just
            // enough not to clip
            const L2 = this.kind === 'dodge' ? L + (255 - L) * tw : L - L * tw;
            const hi = Math.max(src[o], src[o + 1], src[o + 2]) - L;
            const lo = L - Math.min(src[o], src[o + 1], src[o + 2]);
            const s = Math.min(1, hi > 0 ? (255 - L2) / hi : 1, lo > 0 ? L2 / lo : 1);
            for (let c = 0; c < 3; c++) d[o + c] = L2 + (src[o + c] - L) * s;
          } else {
            for (let c = 0; c < 3; c++) {
              const v = src[o + c];
              d[o + c] = this.kind === 'dodge' ? v + (255 - v) * tw : v - v * tw;
            }
          }
        } else if (this.kind === 'sponge') {
          // sponge: push the colour away from (saturate) or towards (desaturate) its own grey
          const r = src[o];
          const gg = src[o + 1];
          const b = src[o + 2];
          const lum = r * 0.299 + gg * 0.587 + b * 0.114;
          let t = wgt * 0.3;
          if (this.o.mode !== 'desaturate') {
            // vibrance: colours that are already strong change less (and skin keeps from clipping)
            if (this.o.vibrance) t *= 1 - (Math.max(r, gg, b) - Math.min(r, gg, b)) / 255;
            t = -t;
          }
          d[o] = r + (lum - r) * t;
          d[o + 1] = gg + (lum - gg) * t;
          d[o + 2] = b + (lum - b) * t;
        } else if (this.kind === 'smudge' || this.kind === 'push') {
          // sample from behind the brush movement
          const sx = Math.round(x - mv.x * (this.kind === 'push' ? 1 : 1));
          const sy = Math.round(y - mv.y * (this.kind === 'push' ? 1 : 1));
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const so = (sy * w + sx) * 4;
          for (let c = 0; c < 4; c++) vv[c] = paint ? paint[c] : src[so + c];
          put(o, wgt);
        }
      }
    }
    if (!this.all) {
      g.putImageData(img, x0, y0);
      return;
    }
    // the shown picture, and the layer moved towards what each pixel became (mixed premultiplied, so
    // an empty layer takes on the colour itself)
    this.all.putImageData(img, x0 + this.layer.x, y0 + this.layer.y);
    const li = g.getImageData(x0, y0, w, h);
    const ld = li.data;
    for (let i = 0; i < tWt.length; i++) {
      const t = tWt[i];
      if (t <= 0) continue;
      const o = i * 4;
      const a0 = ld[o + 3] / 255;
      const a1 = tv[o + 3] / 255;
      const a = a0 + (a1 - a0) * t;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) ld[o + c] = (ld[o + c] * a0 + (tv[o + c] * a1 - ld[o + c] * a0) * t) / a;
      ld[o + 3] = a * 255;
    }
    g.putImageData(li, x0, y0);
  }

  end() {
    this.E.commit(this.o.label, this.before);
  }
}

// ---------------------------------------------------------------- floating pixels (move a selection / free transform)

/** Lift the selected pixels of the active raster layer into a float (removed from the layer). */
export function liftSelection(E, { copy = false } = {}) {
  const doc = E.doc;
  const l = doc.active;
  if (!doc.selection || l.kind !== 'raster' || !l.canvas) return null;
  const c = makeCanvas(doc.width, doc.height);
  const g = c.getContext('2d');
  g.drawImage(l.canvas, l.x, l.y);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(doc.selection.canvas, 0, 0);
  if (!copy) {
    const lg = doc.editPixels(l);
    lg.save();
    lg.globalCompositeOperation = 'destination-out';
    lg.drawImage(doc.selection.canvas, -l.x, -l.y);
    lg.restore();
  }
  const b = SEL.alphaBounds(c) || { x: 0, y: 0, w: 1, h: 1 };
  const t = makeCanvas(b.w, b.h);
  t.getContext('2d').drawImage(c, -b.x, -b.y);
  return { canvas: t, x: b.x, y: b.y, layerId: l.id };
}

export function dropFloat(E, f) {
  const doc = E.doc;
  const l = doc.layer(f.layerId);
  if (!l) return;
  const g = doc.editPixels(l, { x: f.x, y: f.y, w: f.canvas.width, h: f.canvas.height });
  g.drawImage(f.canvas, f.x - l.x, f.y - l.y);
  l._styled = null;
}

// ---------------------------------------------------------------- tool definitions

const BRUSH_OPTS = [
  ['size', '크기', 'range', 1, 500, 30],
  ['hardness', '경도', 'range', 0, 100, 70, '%'],
  ['opacity', '불투명도', 'range', 1, 100, 100, '%'],
  ['flow', '흐름', 'range', 1, 100, 100, '%'],
  ['pressureSize', '펜 압력 → 크기', 'bool', null, null, true],
];

export function brushOpts(o, E, extra = {}) {
  return { size: o.size, hardness: (o.hardness ?? 70) / 100, opacity: (o.opacity ?? 100) / 100, flow: (o.flow ?? 100) / 100, pressureSize: o.pressureSize, color: E.fg, ...extra };
}

export function needRaster(E, what = '이 도구') {
  const mt = E.maskTarget?.();
  if (mt && mt.kind !== 'layer') return true;
  const l = E.doc.active;
  if (!l) return false;
  if (l.locked || (l.lockPixels && !(E.editMask && l.mask))) {
    E.toast('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
    return false;
  }
  // like Photoshop: painting on a layer nobody can see would change nothing visible
  if (E.doc.shown && !E.doc.shown(l)) {
    E.toast(`대상 레이어가 숨겨져 있어 칠할 수 없습니다: ${what} (레이어 패널에서 눈 아이콘을 켜세요)`);
    return false;
  }
  if (E.editMask && l.mask) return true;
  if (l.kind === 'smart') {
    E.toast('고급 개체에는 바로 칠할 수 없습니다. 레이어 ▸ 고급 개체 ▸ 내용 편집, 또는 래스터화한 뒤 칠하세요.');
    return false;
  }
  if (l.kind !== 'raster') {
    E.toast(`${what}는 일반(이미지) 레이어에서 씁니다. 레이어 ▸ 래스터화로 바꾸거나 새 레이어를 만드세요.`);
    return false;
  }
  return true;
}

// what the eyedropper reads, remembered until the picture changes
const sampleCache = { key: '', c: null };

/** The canvas (doc coords at x, y) the eyedropper samples: all layers, the layers up to the active one, or the active one. */
function sampleSource(E, which) {
  const doc = E.doc;
  const l = doc.active;
  if (which === 'current' && l) {
    const ct = doc.content(l);
    return ct ? { canvas: ct.canvas, x: ct.x, y: ct.y } : null;
  }
  if (which === 'below' && l) {
    const key = `${doc.id}:${doc.rev}:${l.id}`;
    if (sampleCache.key !== key) {
      sampleCache.key = key;
      sampleCache.c = doc.flatten({ upTo: doc.index(l.id) + 1, fg: E.fg, bg: E.bg });
    }
    return { canvas: sampleCache.c, x: 0, y: 0 };
  }
  return { canvas: E.composite(), x: 0, y: 0 };
}

/**
 * The colour at p averaged over the eyedropper's sample size (transparent pixels count for
 * nothing), or null where there is nothing to pick.
 */
export function sampleColor(E, p, o = E.opts('eyedropper')) {
  const src = sampleSource(E, o.layers || 'all');
  if (!src?.canvas) return null;
  const s = Math.max(1, +o.sample || 1);
  const r = Math.floor(s / 2);
  const cx = Math.floor(p.x) - src.x;
  const cy = Math.floor(p.y) - src.y;
  const x0 = Math.max(0, cx - r);
  const y0 = Math.max(0, cy - r);
  const x1 = Math.min(src.canvas.width, cx - r + s);
  const y1 = Math.min(src.canvas.height, cy - r + s);
  if (x1 <= x0 || y1 <= y0) return null;
  const d = src.canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  let aa = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    rr += d[i] * a;
    gg += d[i + 1] * a;
    bb += d[i + 2] * a;
    aa += a;
  }
  return aa ? [rr / aa, gg / aa, bb / aa] : null;
}

function pickColor(E, p, toBg) {
  const c = sampleColor(E, p);
  if (c) E.setColor(rgbHex(...c), toBg);
  return c;
}

/** The eyedropper's overlay: the marks brushes.js draws (samplers, notes) and the sampling ring. */
function eyedropperOverlay(E, g) {
  this.marks?.(E, g);
  this.drawRing?.(E, g);
}

/** Selection mode from options + modifier keys. */
export function selMode(E, e, toolId) {
  if (e.shiftKey && e.altKey) return 'inter';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'sub';
  return E.opts(toolId).mode || 'new';
}

export const SEL_MODE_OPT = ['mode', '선택 방식', 'select', null, null, 'new', [['new', '새 선택'], ['add', '더하기 (Shift)'], ['sub', '빼기 (Alt)'], ['inter', '교차']]];

function marquee(id, name, key, icon, shape) {
  return {
    id, name, key, icon, group: 'select', cursor: 'crosshair',
    options: [SEL_MODE_OPT, ['feather', '페더 (px)', 'range', 0, 200, 0], ['fixed', '비율', 'select', null, null, 'free', [['free', '자유'], ['1:1', '1:1'], ['4:3', '4:3'], ['16:9', '16:9'], ['9:16', '9:16']]]],
    down(E, p, e) {
      const s = E.doc.selection;
      // drag inside the selection (no modifier) moves the outline
      if (s && !e.shiftKey && !e.altKey && E.selAt(p) > 0) {
        this.d = { moveSel: true, a: p, b: p };
        return;
      }
      this.d = { a: p, b: p, mode: selMode(E, e, id) };
    },
    move(E, p, e) {
      if (!this.d) return;
      let b = p;
      if (!this.d.moveSel) {
        const fx = E.opts(id).fixed;
        const ratio = e.shiftKey && this.d.mode === 'new' ? 1 : fx === 'free' ? 0 : fx.split(':').reduce((a, c) => a / c);
        if (ratio) {
          const w = p.x - this.d.a.x;
          const h = p.y - this.d.a.y;
          const sw = Math.abs(w);
          const sh = Math.abs(h);
          const W = Math.max(sw, sh * ratio);
          b = { x: this.d.a.x + Math.sign(w || 1) * W, y: this.d.a.y + Math.sign(h || 1) * (W / ratio) };
        }
        if (e.altKey && this.d.mode === 'new') {
          // Alt while dragging a new selection: draw from the centre
          b = { x: p.x, y: p.y, fromCenter: true };
        }
      }
      this.d.b = b;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const before = E.doc.capture();
      if (d.moveSel) {
        const dx = Math.round(d.b.x - d.a.x);
        const dy = Math.round(d.b.y - d.a.y);
        if (!dx && !dy) return;
        const c = makeCanvas(E.doc.width, E.doc.height);
        c.getContext('2d').drawImage(E.doc.selection.canvas, dx, dy);
        E.doc.selection = { canvas: c };
        E.commit('선택 영역 이동', before);
        return;
      }
      const r = rectOf(d);
      if (r.w < 2 || r.h < 2) {
        if (d.mode === 'new' && E.doc.selection) {
          E.doc.selection = null;
          E.commit('선택 해제', before);
        }
        E.overlay();
        return;
      }
      const m = SEL.shapeMask(E.doc, shape(r.x, r.y, r.w, r.h), E.opts(id).feather || 0);
      E.doc.selection = SEL.combine(E.doc, m, d.mode);
      E.commit(`${name}`, before);
    },
    overlay(E, g) {
      const d = this.d;
      if (!d) return;
      if (d.moveSel) {
        E.drawSelOffset(g, d.b.x - d.a.x, d.b.y - d.a.y);
        return;
      }
      const r = rectOf(d);
      const [x, y] = E.toScreen(r.x, r.y);
      const w = r.w * E.view.zoom;
      const h = r.h * E.view.zoom;
      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = '#fff';
      g.beginPath();
      if (id === 'ellipse') g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else g.rect(x + 0.5, y + 0.5, w, h);
      g.stroke();
      g.lineDashOffset = 4;
      g.strokeStyle = '#000';
      g.stroke();
      g.restore();
    },
  };
}

/** Freehand lasso, or the polygonal lasso (click points; double-click, Enter or the first point closes). */
function lassoTool(id, name, icon, forcePoly) {
  return {
    id, name, key: 'L', icon, group: 'select', cursor: 'crosshair',
    options: [SEL_MODE_OPT, ['feather', '페더 (px)', 'range', 0, 200, 0]],
    down(E, p, e) {
      const poly = forcePoly;
      if (poly && this.d) {
        // close when clicking near the first point
        if (dist(p, this.d.pts[0]) * E.view.zoom < 10 && this.d.pts.length > 2) {
          this.finish(E);
          return;
        }
        this.d.pts.push(p);
        E.overlay();
        return;
      }
      this.d = { pts: [p], mode: selMode(E, e, id), poly };
    },
    move(E, p) {
      if (!this.d) return;
      if (this.d.poly) this.d.hover = p;
      else this.d.pts.push(p);
      E.overlay();
    },
    hover(E, p) {
      if (this.d?.poly) {
        this.d.hover = p;
        E.overlay();
      }
    },
    up(E) {
      if (this.d && !this.d.poly) this.finish(E);
    },
    dblclick(E) {
      if (this.d?.poly) this.finish(E);
    },
    onKey(E, e) {
      if (!this.d?.poly) return false;
      if (e.key === 'Enter') this.finish(E);
      else if (e.key === 'Escape') {
        this.d = null;
        E.overlay();
      } else return false;
      return true;
    },
    // switching tools drops an outline that was being drawn
    deactivate(E) {
      this.d = null;
      E.overlay?.();
    },
    finish(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      // a click (or a shape too small to see) with a new-selection lasso removes the selection,
      // like a click with the marquee
      if (d.pts.length < 3 || tinyOutline(d.pts.map((q) => [q.x, q.y]), E.view.zoom)) {
        deselectByClick(E, d.mode);
        return;
      }
      const before = E.doc.capture();
      E.doc.selection = SEL.combine(E.doc, SEL.shapeMask(E.doc, SEL.polyPath(d.pts.map((q) => [q.x, q.y])), E.opts(id).feather || 0), d.mode);
      E.commit(name, before);
    },
    overlay(E, g) {
      const d = this.d;
      if (!d) return;
      g.save();
      g.strokeStyle = '#fff';
      g.setLineDash([4, 4]);
      g.beginPath();
      [...d.pts, ...(d.hover ? [d.hover] : [])].forEach((q, i) => {
        const [x, y] = E.toScreen(q.x, q.y);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.stroke();
      g.restore();
    },
  };
}

/** True when an outline (doc points) spans less than a few screen pixels: a click, not a shape. */
export function tinyOutline(pts, zoom) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Math.max(x1 - x0, y1 - y0) * zoom < 6;
}

/** A click with a selection tool in "new selection" mode: drop the selection (one undo step). */
export function deselectByClick(E, mode) {
  if (mode === 'new' && E.doc.selection) {
    const before = E.doc.capture();
    E.doc.lastSelection = E.doc.selection;
    E.doc.selection = null;
    E.commit('선택 해제', before);
  }
  E.overlay();
}

function rectOf(d) {
  if (d.b.fromCenter) {
    const w = Math.abs(d.b.x - d.a.x);
    const h = Math.abs(d.b.y - d.a.y);
    return { x: d.a.x - w, y: d.a.y - h, w: w * 2, h: h * 2 };
  }
  return { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) };
}

function strokeTool(id, name, key, icon, mode, extra = {}) {
  return {
    id, name, key, icon, group: extra.group || 'paint', cursor: 'brush',
    options: extra.options || BRUSH_OPTS,
    down(E, p, e) {
      if (e.altKey && mode === 'paint') {
        pickColor(E, p, false);
        return;
      }
      if (mode === 'clone' && e.altKey) {
        this.source = p;
        E.toast('복제 원본을 정했습니다. 이제 칠할 곳을 끌어 보세요.');
        E.overlay();
        return;
      }
      if (mode === 'clone' && !this.source) {
        E.toast('먼저 Alt(휴대폰은 "원본 정하기" 버튼)를 누른 채 복제할 곳을 누르세요');
        return;
      }
      if (!needRaster(E, name)) return;
      const o = E.opts(id);
      const bo = brushOpts(o, E, { hard: extra.hard, label: name, sampleAll: !!o.sampleAll });
      if (mode === 'clone') {
        if (!this.aligned || !o.aligned) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
        this.aligned = true;
        bo.cloneOffset = this.offset;
      }
      if (extra.hardness100) bo.hardness = 1;
      if (E.brushEngine && mode !== 'heal') bo.engine = E.brushEngine(id, o, bo, mode);
      this.st = new Stroke(E, mode, bo);
      // a mouse reports pressure 0.5 while a button is down: only a pen's pressure counts
      this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
      this.st.flush();
    },
    move(E, p, e) {
      if (this.st) this.st.to(p, e.pointerType === 'pen' ? e.pressure : 1);
    },
    up() {
      if (this.st) this.st.end();
      this.st = null;
    },
    cancel(E) {
      if (!this.st) return;
      E.doc.restore(this.st.before);
      this.st = null;
      E.redraw();
    },
    overlay(E, g) {
      if (mode === 'clone' && this.source) {
        const [x, y] = E.toScreen(this.source.x, this.source.y);
        g.strokeStyle = '#fff';
        g.beginPath();
        g.moveTo(x - 8, y);
        g.lineTo(x + 8, y);
        g.moveTo(x, y - 8);
        g.lineTo(x, y + 8);
        g.stroke();
      }
    },
    setSourceHere(E) {
      this.source = { ...E.lastPoint };
    },
  };
}

const TONE_RANGE = ['range', '범위', 'select', null, null, 'midtones', [['shadows', '어두운 영역'], ['midtones', '중간 영역'], ['highlights', '밝은 영역']]];

// the blur, sharpen and smudge tools' 모드 and 모든 레이어 샘플링
const RETOUCH_MODE = ['mode', '모드', 'select', null, null, 'normal', RETOUCH_MODES];
const SAMPLE_ALL_R = ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false];
function retouchTool(id, name, key, icon, kind, extra = [], strengthLabel = '강도') {
  return {
    id, name, key, icon, group: 'retouch', cursor: 'brush',
    options: [['size', '크기', 'range', 1, 500, 60], ['strength', strengthLabel, 'range', 1, 100, 50, '%'], ['hardness', '경도', 'range', 0, 100, 40, '%'], ...extra],
    down(E, p) {
      const mk = E.maskTarget?.()?.kind;
      if (mk === 'quick' || mk === 'channel') {
        E.toast('빠른 마스크·알파 채널에는 브러시, 연필, 지우개, 그레이디언트, 페인트 통으로 칠하세요');
        return;
      }
      if (!needRaster(E, name)) return;
      if (E.editMask) {
        E.toast('마스크가 아니라 레이어 내용을 고칩니다 (레이어 축소판을 누르세요)');
        return;
      }
      const o = E.opts(id);
      this.r = new Retouch(E, kind, { ...o, size: o.size, strength: o.strength, hardness: (o.hardness ?? 40) / 100, label: name });
      this.r.to(p);
      E.redraw();
    },
    move(E, p) {
      this.r?.to(p);
    },
    up() {
      this.r?.end();
      this.r = null;
    },
    cancel(E) {
      if (!this.r) return;
      E.doc.restore(this.r.before);
      this.r = null;
      E.redraw();
    },
  };
}

const TEXT_OPTS = [['font', '글꼴', 'font', null, null, 'Noto Sans KR'], ['size', '크기 (px)', 'number', 4, 2000, 72], ['bold', '굵게', 'bool', null, null, true], ['italic', '기울임', 'bool', null, null, false], ['align', '정렬', 'select', null, null, 'left', [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽'], ['justify', '양쪽 (마지막 줄 왼쪽)'], ['justifyAll', '양쪽 모두']]]];

/** Type tools: click for point text, drag for a paragraph box, click on a path for text on the path. */
function typeTool(id, name, key, icon, { vertical, mask }) {
  return {
    id, name, key, icon, group: 'type', cursor: 'text',
    options: TEXT_OPTS,
    optionsFrom: 'text',
    down(E, p) {
      const hit = !mask && E.layerAt(p, (l) => l.kind === 'text');
      if (hit) {
        E.selectLayer(hit.id);
        E.editText(hit);
        return;
      }
      this.d = { a: p, b: p };
    },
    move(E, p) {
      if (!this.d) return;
      this.d.b = p;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const o = E.opts('text');
      const before = E.doc.capture();
      const r = rectOf(d);
      const box = r.w > 8 && r.h > 8 ? { w: Math.round(r.w), h: Math.round(r.h) } : null;
      const t = E.newText(o, E.fg, { vertical, box });
      const l = newLayer('text', { name: mask ? '문자 마스크' : '텍스트', text: t, typeMask: mask });
      // clicking on the current path: text along the path
      const sps = !box && E.getPath ? E.getPath() : [];
      const near = sps.length && E.nearestOnPath(sps, d.a.x, d.a.y);
      if (near && near.d <= 8 / E.view.zoom && !vertical) {
        l.text = { ...t, path: { subpath: sps[near.si], offset: 0 }, align: 'left' };
        l.x = 0;
        l.y = 0;
        l.name = '패스 위 문자';
      } else if (box) {
        l.x = Math.round(r.x);
        l.y = Math.round(r.y);
      } else if (vertical) {
        l.x = Math.round(p0(d).x - o.size * 0.6);
        l.y = Math.round(p0(d).y);
      } else {
        l.x = Math.round(d.a.x);
        l.y = Math.round(d.a.y - o.size * 0.95);
      }
      E.addLayer(l);
      E.editText(l, before);
    },
    overlay(E, g) {
      if (!this.d) return;
      const r = rectOf(this.d);
      if (r.w < 3 && r.h < 3) return;
      const [x, y] = E.toScreen(r.x, r.y);
      g.strokeStyle = '#4aa3ff';
      g.setLineDash([4, 3]);
      g.strokeRect(x + 0.5, y + 0.5, r.w * E.view.zoom, r.h * E.view.zoom);
      g.setLineDash([]);
    },
  };
}
const p0 = (d) => d.a;

// ---------------------------------------------------------------- crop presets and overlays

/** The crop tool's ratio menu (Photoshop's presets; "px:" entries set a pixel size). */
export const CROP_PRESETS = [
  ['free', '비율'], ['wxh', 'W x H x 해상도'], ['orig', '원본 비율'], ['1:1', '1:1 (정사각형)'], ['4:5', '4:5 (8:10)'], ['5:7', '5:7'], ['2:3', '2:3 (4:6)'], ['16:9', '16:9'],
  ['4:3', '4:3'], ['3:2', '3:2'], ['9:16', '9:16'], ['px:1080x1080', '1080 x 1080 픽셀 72ppi'], ['px:1080x1350', '1080 x 1350 픽셀 72ppi'], ['px:1920x1080', '1920 x 1080 픽셀 72ppi'], ['px:1280x720', '1280 x 720 픽셀 72ppi'],
];
export const CROP_OVERLAYS = [['thirds', '삼등분 법칙'], ['grid', '격자'], ['diagonal', '대각선'], ['triangle', '삼각형'], ['golden', '황금 비율'], ['spiral', '황금 나선'], ['none', '오버레이 없음']];

/** An angle in (-π, π]. */
const normAngle = (a) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x <= -Math.PI) x += Math.PI * 2;
  return x;
};

/** A crop overlay in a W×H box centred on the origin (the context is already turned with the box). */
function drawCropOverlay(g, kind, flip, W, H) {
  const x0 = -W / 2;
  const y0 = -H / 2;
  g.save();
  g.beginPath();
  g.rect(x0, y0, W, H);
  g.clip();
  // Shift+O turns the shapes that have a direction
  if (kind === 'triangle' || kind === 'spiral' || kind === 'diagonal') g.scale(flip & 1 ? -1 : 1, flip & 2 ? -1 : 1);
  g.beginPath();
  const line = (ax, ay, bx, by) => {
    g.moveTo(x0 + ax, y0 + ay);
    g.lineTo(x0 + bx, y0 + by);
  };
  if (kind === 'thirds' || kind === 'golden') {
    for (const k of kind === 'thirds' ? [1 / 3, 2 / 3] : [0.382, 0.618]) {
      line(W * k, 0, W * k, H);
      line(0, H * k, W, H * k);
    }
  } else if (kind === 'grid') {
    const step = Math.max(12, Math.max(W, H) / 12);
    for (let x = step; x < W; x += step) line(x, 0, x, H);
    for (let y = step; y < H; y += step) line(0, y, W, y);
  } else if (kind === 'diagonal') {
    const m = Math.min(W, H);
    line(0, 0, m, m);
    line(W, 0, W - m, m);
    line(0, H, m, H - m);
    line(W, H, W - m, H - m);
  } else if (kind === 'triangle') {
    line(0, 0, W, H);
    // perpendiculars from the two other corners onto the diagonal
    const L2 = W * W + H * H || 1;
    const foot = (px, py) => {
      const t = (px * W + py * H) / L2;
      return [W * t, H * t];
    };
    line(W, 0, ...foot(W, 0));
    line(0, H, ...foot(0, H));
  } else if (kind === 'spiral') {
    // golden sections turning inwards, a quarter curve in each
    let [rx, ry, rw, rh] = [x0, y0, W, H];
    const start = W >= H ? 0 : 1;
    for (let i = start; i < start + 12; i++) {
      const k = 0.618;
      const side = i % 4;
      let px;
      let py;
      let pw;
      let ph;
      if (side === 0) {
        [px, py, pw, ph] = [rx, ry, rw * k, rh];
        [rx, rw] = [rx + pw, rw - pw];
        g.moveTo(px + pw, py);
        g.lineTo(px + pw, py + ph);
        g.moveTo(px, py + ph);
        g.ellipse(px + pw, py + ph, pw, ph, 0, Math.PI, Math.PI * 1.5);
      } else if (side === 1) {
        [px, py, pw, ph] = [rx, ry, rw, rh * k];
        [ry, rh] = [ry + ph, rh - ph];
        g.moveTo(px, py + ph);
        g.lineTo(px + pw, py + ph);
        g.moveTo(px, py);
        g.ellipse(px, py + ph, pw, ph, 0, Math.PI * 1.5, Math.PI * 2);
      } else if (side === 2) {
        [pw, ph] = [rw * k, rh];
        [px, py] = [rx + rw - pw, ry];
        rw -= pw;
        g.moveTo(px, py);
        g.lineTo(px, py + ph);
        g.moveTo(px + pw, py);
        g.ellipse(px, py, pw, ph, 0, 0, Math.PI * 0.5);
      } else {
        [pw, ph] = [rw, rh * k];
        [px, py] = [rx, ry + rh - ph];
        rh -= ph;
        g.moveTo(px, py);
        g.lineTo(px + pw, py);
        g.moveTo(px + pw, py + ph);
        g.ellipse(px + pw, py, pw, ph, 0, Math.PI * 0.5, Math.PI);
      }
      if (pw < 1 || ph < 1) break;
    }
  }
  g.stroke();
  g.restore();
}

// ---------------------------------------------------------------- gradient options

const GRAD_MODE = ['mode', '모드', 'select', null, null, 'normal', BLEND_MODES.map(([id, name]) => [id, name])];
const GRAD_TRANSPARENCY = ['transparency', '투명도', 'bool', null, null, true];
const GRAD_ORDER = ['preset', 'style', 'type', 'to', 'mode', 'opacity', 'reverse', 'dither', 'transparency'];

/** The gradient tool's options with Mode and Transparency, in Photoshop's order. */
function gradientOptions(list) {
  const rest = list.filter((o) => o[0] !== 'mode' && o[0] !== 'transparency');
  const all = [...rest, GRAD_MODE, GRAD_TRANSPARENCY];
  const rank = (o) => {
    const i = GRAD_ORDER.indexOf(o[0]);
    return i < 0 ? GRAD_ORDER.length + all.indexOf(o) : i;
  };
  return all.sort((a, b) => rank(a) - rank(b));
}

/** The gradient the options name (a preset or the edited one). */
function gradientOf(o) {
  return o.preset === 'custom' && o.custom ? o.custom : GRADIENTS.find((g) => g.id === o.preset) || GRADIENTS[0];
}

export const TOOLS = [
  // ---- move
  {
    id: 'move', name: '이동', key: 'V', icon: 'move', group: 'move', cursor: 'move',
    options: [['autoSelect', '자동 선택', 'bool', null, null, true], ['autoTarget', '대상', 'select', null, null, 'layer', [['layer', '레이어'], ['group', '그룹']]], ['showTransform', '변형 컨트롤 표시', 'bool', null, null, true]],
    /** With auto-select: the layer a click picks (not the background under everything). */
    pick(E, p) {
      const doc = E.doc;
      let hit = E.layerAt(p);
      if (hit && isBackdrop(doc, hit)) hit = null;
      // frames (frame tool): an empty frame is picked by its shape, a picture in a frame by its frame
      // (moving it moves the picture too) unless that picture is the layer already picked
      const fr = E.frameAt?.(p);
      if (fr && (!hit || doc.index(fr.id) > doc.index(hit.id))) {
        const inner = hit && doc.ancestors(hit).includes(fr);
        if (!(inner && doc.activeId === hit.id)) hit = fr;
      }
      if (hit && E.opts('move').autoTarget === 'group') {
        const top = doc.ancestors(hit).pop();
        if (top) hit = top;
      }
      return hit;
    },
    /** The active layer's frame with its handles (screen tolerance), when they are shown. */
    handlesOf(E) {
      const doc = E.doc;
      const l = doc.active;
      if (!E.opts('move').showTransform || E.transform || doc.selectedLayers.length !== 1 || !l || l.kind === 'adjust' || l.kind === 'fill' || isBackdrop(doc, l)) return null;
      // with a selection, a free transform works on the selected pixels, not the layer's box
      if (doc.selection && l.kind === 'raster') return null;
      const f = E.layerFrame(l);
      if (!f || f.box.w < 1 || f.box.h < 1) return null;
      const q = f.quad;
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const pts = { c0: q[0], c1: q[1], c2: q[2], c3: q[3], e0: mid(q[0], q[1]), e1: mid(q[1], q[2]), e2: mid(q[2], q[3]), e3: mid(q[3], q[0]) };
      // the turning handle sits a little below the bottom edge, square to it
      const c = mid(q[0], q[2]);
      const bm = pts.e2;
      const len = Math.hypot(bm[0] - c[0], bm[1] - c[1]) || 1;
      const off = 26 / E.view.zoom;
      pts.rotate = [bm[0] + ((bm[0] - c[0]) / len) * off, bm[1] + ((bm[1] - c[1]) / len) * off];
      return { frame: f, pts };
    },
    grab(E, p, e) {
      const hs = this.handlesOf(E);
      if (!hs) return false;
      // a finger gets a wider reach, but only outside the box: inside it a drag moves the layer
      const inside = insideQuad([p.x, p.y], hs.frame.quad);
      const tol = (e?.pointerType === 'touch' && !inside ? 20 : 9) / E.view.zoom;
      let key = null;
      let best = tol;
      for (const [k, q] of Object.entries(hs.pts)) {
        const d = Math.hypot(q[0] - p.x, q[1] - p.y);
        if (d <= best) {
          best = d;
          key = k;
        }
      }
      if (!key) return false;
      E.cmd.freeTransform();
      const t = E.transform;
      if (!t) return false;
      t.autoCommit = true;
      t.down(p, e);
      if (t.d) {
        if (key === 'rotate') t.d.h = 'rotate';
        else {
          // the transform's own corners match ours; take its nearest one
          const th = t.handles();
          let k2 = null;
          let b2 = Infinity;
          for (const k of ['c0', 'c1', 'c2', 'c3', 'e0', 'e1', 'e2', 'e3']) {
            const d = Math.hypot(th[k][0] - p.x, th[k][1] - p.y);
            if (d < b2) {
              b2 = d;
              k2 = k;
            }
          }
          t.d.h = k2;
        }
      }
      return true;
    },
    hover(E, p) {
      const id = E.opts('move').autoSelect ? this.pick(E, p)?.id || null : null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        E.overlay();
      }
    },
    deactivate() {
      this.hoverId = null;
    },
    overlay(E, g) {
      const doc = E.doc;
      if (!doc || E.transform || this.d) return;
      const outline = (quad, color, width = 1) => {
        g.save();
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        quad.forEach((q, i) => {
          const [x, y] = E.toScreen(q[0], q[1]);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
        g.closePath();
        g.stroke();
        g.restore();
      };
      // the layer under the pointer (what a click would pick)
      if (this.hoverId && !doc.selectedLayers.some((l) => l.id === this.hoverId)) {
        const f = E.layerFrame(doc.layer(this.hoverId));
        if (f) outline(f.quad, 'rgba(74,163,255,.85)', 1);
      }
      // selected layers
      for (const l of doc.selectedLayers) {
        if (isBackdrop(doc, l) || l.kind === 'adjust') continue;
        const f = E.layerFrame(l);
        if (f) outline(f.quad, '#4aa3ff', 1.5);
      }
      const hs = this.handlesOf(E);
      if (!hs) return;
      const [bx, by] = E.toScreen(...hs.pts.e2);
      const [rx, ry] = E.toScreen(...hs.pts.rotate);
      g.save();
      g.strokeStyle = '#4aa3ff';
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(rx, ry);
      g.stroke();
      g.fillStyle = '#ffffff';
      g.lineWidth = 1.5;
      for (const [k, q] of Object.entries(hs.pts)) {
        const [x, y] = E.toScreen(q[0], q[1]);
        g.beginPath();
        if (k === 'rotate') g.arc(x, y, 6, 0, Math.PI * 2);
        else g.rect(x - 4.5, y - 4.5, 9, 9);
        g.fill();
        g.stroke();
      }
      g.restore();
    },
    down(E, p, e) {
      const doc = E.doc;
      // Ctrl (⌘) inverts auto-select for one click, like Photoshop
      if (!!E.opts('move').autoSelect !== !!(e?.ctrlKey || e?.metaKey)) {
        const hit = this.pick(E, p);
        if (hit) E.selectLayer(hit.id, e?.shiftKey ? 'add' : 'single');
        // nothing but the background there: don't drag along the layer picked before
        else if (!doc.selection) return;
      }
      const l = doc.active;
      if (!l || l.kind === 'adjust' && !l.mask) return;
      const moving = doc.selectedLayers.filter((x) => x.kind !== 'adjust' || x.mask);
      if (moving.some((x) => x.locked || x.lockPos)) {
        E.toast('위치가 잠긴 레이어가 있습니다 (레이어 패널에서 잠금 해제)');
        return;
      }
      const before = doc.capture();
      let float = null;
      let dup = false;
      // with a selection, Alt+drag duplicates the pixels instead of cutting them out
      if (doc.selection && l.kind === 'raster') float = liftSelection(E, { copy: !!e?.altKey });
      else if (e?.altKey && !doc.selection) {
        // Alt+drag a layer: move a copy (one undo step with the move, see up())
        const top = doc.history.undoStack.at(-1);
        E.cmd.duplicateLayer();
        dup = doc.history.undoStack.at(-1) !== top;
        if (dup) doc.history.undoStack.pop();
      }
      this.d = { a: p, before, float, dup, moving: doc.selectedLayers.filter((x) => x.kind !== 'adjust' || x.mask), last: { dx: 0, dy: 0 }, sel: doc.selection };
      E.float = float;
      E.redraw();
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      let dx = p.x - d.a.x;
      let dy = p.y - d.a.y;
      if (e.shiftKey) {
        // Shift: straight across, up and down or at 45°
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = dx * Math.cos(a) + dy * Math.sin(a);
        dx = len * Math.cos(a);
        dy = len * Math.sin(a);
      }
      dx = Math.round(dx);
      dy = Math.round(dy);
      if (d.float) {
        E.float = { ...d.float, x: d.float.x + dx, y: d.float.y + dy };
        d.offset = { dx, dy };
      } else {
        const sx = E.snapMove ? E.snapMove(d.moving, dx, dy, e) : { dx, dy };
        E.doc.translateLayers(d.moving, sx.dx - d.last.dx, sx.dy - d.last.dy);
        d.last = sx;
      }
      E.redraw();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const off = d.offset || { dx: 0, dy: 0 };
      // a click without a drag changes nothing: no lifted pixels are put back as a step, and an
      // Alt+click leaves no unrecorded copy of the layer behind
      if (d.float ? !off.dx && !off.dy : !d.last.dx && !d.last.dy) {
        E.float = null;
        if (d.float || d.dup) {
          E.doc.restore(d.before);
          E.afterHistory();
        } else E.redraw();
        return;
      }
      if (d.float) {
        dropFloat(E, E.float || d.float);
        E.float = null;
        if (d.sel && (off.dx || off.dy)) {
          const c = makeCanvas(E.doc.width, E.doc.height);
          c.getContext('2d').drawImage(d.sel.canvas, off.dx, off.dy);
          E.doc.selection = { canvas: c };
        }
        E.doc.touch(E.doc.active);
      }
      // a plain move touched the layers while dragging: touching again would redo masks and styles,
      // and redrawing the whole picture would stall the end of the drag
      E.commit(d.dup ? '레이어 복제' : '이동', d.before, { touched: true });
    },
    cancel(E) {
      if (!this.d) return;
      E.float = null;
      E.doc.restore(this.d.before);
      this.d = null;
      E.afterHistory();
    },
    /** Arrow keys with a selection move the selected pixels and the selection (Alt: a copy of them). */
    onKey(E, e) {
      if (!e.key.startsWith('Arrow') || e.ctrlKey || e.metaKey || this.d) return false;
      const doc = E.doc;
      const l = doc.active;
      if (!doc.selection || l?.kind !== 'raster' || !l.canvas || doc.selectedLayers.length > 1) return false;
      if (l.locked || l.lockPos || l.lockPixels) {
        E.toast('잠긴 레이어입니다 (레이어 패널에서 잠금 해제)');
        return true;
      }
      const s = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
      const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
      const before = doc.capture();
      const f = liftSelection(E, { copy: e.altKey });
      if (!f) return false;
      dropFloat(E, { ...f, x: f.x + dx, y: f.y + dy });
      const c = makeCanvas(doc.width, doc.height);
      c.getContext('2d').drawImage(doc.selection.canvas, dx, dy);
      doc.selection = { canvas: c };
      doc.touch(l);
      E.commit('이동', before, { touched: true });
      return true;
    },
    /** Options bar: align and distribute the selected layers (Photoshop's move tool buttons). */
    optionButtons(E) {
      const C = E.cmd;
      const b = (ic, title, fn) => h('button.small.ph-icobtn', { title, 'aria-label': title, onclick: fn }, icon(ic, 16));
      return [
        h('span.ph-opt', { style: { gap: '2px' } },
          b('alignLeft', '왼쪽 가장자리 정렬', () => C.align('left')),
          b('alignHCenter', '수평 중앙 정렬', () => C.align('hcenter')),
          b('alignRight', '오른쪽 가장자리 정렬', () => C.align('right')),
          b('alignTop', '위쪽 가장자리 정렬', () => C.align('top')),
          b('alignVCenter', '수직 중앙 정렬', () => C.align('vcenter')),
          b('alignBottom', '아래쪽 가장자리 정렬', () => C.align('bottom'))),
        h('span.ph-opt', { style: { gap: '2px' } },
          b('distH', '수평 중앙 분포 (레이어 3개 이상)', () => C.distribute('h')),
          b('distV', '수직 중앙 분포 (레이어 3개 이상)', () => C.distribute('v'))),
      ];
    },
  },
  // ---- selections
  marquee('rect', '사각형 선택 윤곽', 'M', 'selRect', SEL.rectPath),
  marquee('ellipse', '원형 선택 윤곽', 'M', 'selEllipse', SEL.ellipsePath),
  lassoTool('lasso', '올가미', 'lasso', false),
  lassoTool('polyLasso', '다각형 올가미', 'polyLasso', true),
  {
    id: 'wand', name: '자동 선택 (마술봉)', key: 'W', icon: 'wand', group: 'select', cursor: 'crosshair',
    options: [SEL_MODE_OPT, ['tolerance', '허용치', 'range', 0, 255, 32], ['contiguous', '인접', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false]],
    down(E, p, e) {
      const o = E.opts('wand');
      const src = o.sampleAll ? E.composite() : E.layerAsDocCanvas(E.doc.active);
      const m = SEL.magicWand(E.doc, src, p.x, p.y, { tolerance: o.tolerance, contiguous: o.contiguous });
      if (!m) return;
      const before = E.doc.capture();
      E.doc.selection = SEL.combine(E.doc, m, selMode(E, e, 'wand'));
      E.commit('자동 선택', before);
    },
  },
  // ---- crop
  {
    id: 'crop', name: '자르기', key: 'C', icon: 'crop', group: 'crop', cursor: 'crosshair',
    // shown by optionButtons (ratio menu, W ⇄ H, straighten, overlay, delete cropped pixels…)
    options: [
      ['ratio', '비율', 'none', null, null, 'free'],
      ['rw', 'W', 'none', null, null, ''],
      ['rh', 'H', 'none', null, null, ''],
      ['res', '해상도', 'none', null, null, 72],
      ['overlay', '오버레이', 'none', null, null, 'thirds'],
      ['flip', '오버레이 방향', 'none', null, null, 0],
      ['deletePixels', '자른 픽셀 삭제', 'none', null, null, false],
      ['contentAware', '내용 인식', 'none', null, null, false],
    ],
    activate(E) {
      // the whole picture to start with; dragging draws a new box (like Photoshop)
      const doc = E.doc;
      this.d = null;
      this.b = doc ? { cx: doc.width / 2, cy: doc.height / 2, w: doc.width, h: doc.height, a: 0 } : null;
      this.on = doc ? { doc, w: doc.width, h: doc.height } : null;
      this.fresh = true;
      if (doc && this.ratio(E)) this.fitRatio(E, true);
      E.overlay();
    },
    deactivate() {
      this.b = null;
      this.d = null;
      this.straighten = false;
    },
    /** The box, kept in step with the picture while it is untouched (undo, another document). */
    box(E) {
      const doc = E.doc;
      if (!doc) return null;
      const moved = !this.on || this.on.doc !== doc || this.on.w !== doc.width || this.on.h !== doc.height;
      if (!this.b || (moved && !this.d && (this.fresh || this.on?.doc !== doc))) this.activate(E);
      return this.b;
    },
    /** Width : height the box keeps, or 0 when free. */
    ratio(E) {
      const o = E.opts('crop');
      if (o.ratio === 'orig') return E.doc ? E.doc.width / E.doc.height : 0;
      const w = +o.rw;
      const hh = +o.rh;
      return w > 0 && hh > 0 ? w / hh : 0;
    },
    corners(b = this.b) {
      const c = Math.cos(b.a);
      const s = Math.sin(b.a);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.cx + ((u * b.w) / 2) * c - ((v * b.h) / 2) * s, b.cy + ((u * b.w) / 2) * s + ((v * b.h) / 2) * c]);
    },
    /** A doc point in the box's own (turned, centred) frame. */
    local(p, b = this.b) {
      const c = Math.cos(b.a);
      const s = Math.sin(b.a);
      const dx = p.x - b.cx;
      const dy = p.y - b.cy;
      return [dx * c + dy * s, -dx * s + dy * c];
    },
    handleAt(E, p) {
      const b = this.b;
      const tol = 10 / E.view.zoom;
      const [lx, ly] = this.local(p);
      const hw = b.w / 2;
      const hh = b.h / 2;
      const hs = { tl: [-hw, -hh], tr: [hw, -hh], bl: [-hw, hh], br: [hw, hh], t: [0, -hh], b: [0, hh], l: [-hw, 0], r: [hw, 0] };
      let best = null;
      let bd = tol;
      for (const [k, [x, y]] of Object.entries(hs)) {
        const d = Math.hypot(lx - x, ly - y);
        if (d <= bd) {
          bd = d;
          best = k;
        }
      }
      return best;
    },
    hover(E, p) {
      // the pointer shows what a drag does: turn outside the box, move inside
      const b = this.box(E);
      if (!b || this.d) return;
      const st = document.querySelector('.ph-stage');
      if (!st) return;
      const k = this.straighten ? 'crosshair' : this.handleAt(E, p);
      const [lx, ly] = this.local(p);
      const inside = Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
      const cur = k === 'crosshair' ? k : k ? (['t', 'b'].includes(k) ? 'ns-resize' : ['l', 'r'].includes(k) ? 'ew-resize' : ['tl', 'br'].includes(k) ? 'nwse-resize' : 'nesw-resize') : this.fresh ? 'crosshair' : inside ? 'move' : 'alias';
      this.cursor = cur;
    },
    down(E, p, e) {
      const b = this.box(E);
      if (!b) return;
      // Straighten (or Ctrl held): draw a line along what should be level
      if (this.straighten || e.ctrlKey || e.metaKey) {
        this.d = { h: 'line', a: p, b: p, moved: false };
        return;
      }
      const hd = this.handleAt(E, p);
      const [lx, ly] = this.local(p);
      const inside = Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
      this.d = { h: hd || (this.fresh ? 'new' : inside ? 'move' : 'rotate'), a: p, b0: { ...b }, moved: false };
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      if (!d.moved && Math.hypot(p.x - d.a.x, p.y - d.a.y) * E.view.zoom < 2) return;
      d.moved = true;
      const b0 = d.b0;
      const k = this.ratio(E);
      if (d.h === 'line') d.b = p;
      else if (d.h === 'move') this.b = { ...b0, cx: b0.cx + p.x - d.a.x, cy: b0.cy + p.y - d.a.y };
      else if (d.h === 'rotate') {
        let ang = b0.a + Math.atan2(p.y - b0.cy, p.x - b0.cx) - Math.atan2(d.a.y - b0.cy, d.a.x - b0.cx);
        if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        this.b = this.fitInside(E, { ...b0, a: normAngle(ang) }, b0);
      } else if (d.h === 'new') {
        let w = p.x - d.a.x;
        let hh = p.y - d.a.y;
        // a ratio (or Shift: a square) keeps the corner pressed on where it is
        const kk = k || (e.shiftKey ? 1 : 0);
        if (kk) {
          if (Math.abs(w) / kk > Math.abs(hh)) hh = (Math.sign(hh) || 1) * (Math.abs(w) / kk);
          else w = (Math.sign(w) || 1) * Math.abs(hh) * kk;
        }
        this.b = e.altKey ? { cx: d.a.x, cy: d.a.y, w: Math.abs(w) * 2, h: Math.abs(hh) * 2, a: 0 } : { cx: d.a.x + w / 2, cy: d.a.y + hh / 2, w: Math.abs(w), h: Math.abs(hh), a: 0 };
      } else this.b = this.resize(d, p, e, k);
      E.overlay();
    },
    /** Drag a handle: in the box's own frame, the opposite side stays (Alt: the centre). */
    resize(d, p, e, k) {
      const b0 = d.b0;
      const [ax, ay] = this.local(d.a, b0);
      const [px, py] = this.local(p, b0);
      const dx = px - ax;
      const dy = py - ay;
      let L = -b0.w / 2;
      let R = b0.w / 2;
      let T = -b0.h / 2;
      let B = b0.h / 2;
      const hd = d.h;
      const alt = !!e.altKey;
      if (hd.includes('l')) {
        L += dx;
        if (alt) R -= dx;
      }
      if (hd.includes('r')) {
        R += dx;
        if (alt) L -= dx;
      }
      if (hd.includes('t')) {
        T += dy;
        if (alt) B -= dy;
      }
      if (hd.includes('b')) {
        B += dy;
        if (alt) T -= dy;
      }
      const corner = hd.length === 2;
      // Shift on a corner keeps the box's own proportions when no ratio is set
      const kk = k || (corner && e.shiftKey ? b0.w / Math.max(1e-6, b0.h) : 0);
      if (kk) {
        let w = R - L;
        let hh = B - T;
        if (corner) {
          if (Math.abs(w) / kk > Math.abs(hh)) hh = (Math.sign(hh) || 1) * (Math.abs(w) / kk);
          else w = (Math.sign(w) || 1) * Math.abs(hh) * kk;
          if (alt) [L, R, T, B] = [-w / 2, w / 2, -hh / 2, hh / 2];
          else {
            if (hd.includes('l')) L = R - w;
            else R = L + w;
            if (hd.includes('t')) T = B - hh;
            else B = T + hh;
          }
        } else if (hd === 't' || hd === 'b') {
          w = Math.abs(hh) * kk;
          const mid = (L + R) / 2;
          [L, R] = [mid - w / 2, mid + w / 2];
        } else {
          hh = Math.abs(w) / kk;
          const mid = (T + B) / 2;
          [T, B] = [mid - hh / 2, mid + hh / 2];
        }
      }
      const c = Math.cos(b0.a);
      const s = Math.sin(b0.a);
      const mx = (L + R) / 2;
      const my = (T + B) / 2;
      return { cx: b0.cx + mx * c - my * s, cy: b0.cy + mx * s + my * c, w: Math.max(1, Math.abs(R - L)), h: Math.max(1, Math.abs(B - T)), a: b0.a };
    },
    /**
     * While turning: shrink the box (from its size before the turn) so no empty corners come in,
     * unless Content-Aware will fill them or the box already reached outside the picture.
     */
    fitInside(E, b, b0 = b) {
      if (E.opts('crop').contentAware) return b;
      const W = E.doc.width;
      const H = E.doc.height;
      if (!this.corners({ ...b0 }).every(([x, y]) => x >= -0.5 && y >= -0.5 && x <= W + 0.5 && y <= H + 0.5)) return b;
      const c = Math.cos(b.a);
      const sn = Math.sin(b.a);
      let s = 1;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const vx = ((u * b.w) / 2) * c - ((v * b.h) / 2) * sn;
        const vy = ((u * b.w) / 2) * sn + ((v * b.h) / 2) * c;
        if (vx > 1e-9) s = Math.min(s, (W - b.cx) / vx);
        else if (vx < -1e-9) s = Math.min(s, -b.cx / vx);
        if (vy > 1e-9) s = Math.min(s, (H - b.cy) / vy);
        else if (vy < -1e-9) s = Math.min(s, -b.cy / vy);
      }
      s = Math.max(0.02, s);
      return { ...b, w: b.w * s, h: b.h * s };
    },
    /** Turn the box so a line at `ang` (radians) becomes level (or upright, whichever is nearer). */
    straightenTo(E, ang) {
      const doc = E.doc;
      const a = normAngle(ang - Math.round(ang / (Math.PI / 2)) * (Math.PI / 2));
      const k = this.ratio(E);
      let w = doc.width;
      let hh = doc.height;
      if (k) {
        if (w / hh > k) w = hh * k;
        else hh = w / k;
      }
      // the biggest box of these proportions inside the turned picture
      const b0 = { cx: doc.width / 2, cy: doc.height / 2, w, h: hh, a: 0 };
      this.b = this.fitInside(E, { ...b0, a }, b0);
      this.fresh = false;
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      if (d.h === 'line') {
        if (d.moved && dist(d.a, d.b) * E.view.zoom > 4) this.straightenTo(E, Math.atan2(d.b.y - d.a.y, d.b.x - d.a.x));
        if (this.straighten) {
          this.straighten = false;
          E.emit('opts');
        }
        E.overlay();
        return;
      }
      if (!d.moved) return;
      // a box too small to see: back to the whole picture
      if (d.h === 'new' && (this.b.w * E.view.zoom < 3 || this.b.h * E.view.zoom < 3)) {
        this.activate(E);
        return;
      }
      this.fresh = false;
      E.overlay();
    },
    dblclick(E, p) {
      const b = this.box(E);
      if (!b) return;
      const [lx, ly] = this.local(p);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) this.apply(E);
    },
    onKey(E, e) {
      if (!this.box(E)) return false;
      if (e.key === 'Enter') this.apply(E);
      else if (e.key === 'Escape') this.reset(E);
      else if (e.code === 'KeyO' && !e.altKey) this.cycleOverlay(E, e.shiftKey);
      else if (e.code === 'KeyX' && !e.altKey && !e.shiftKey) this.swap(E);
      else if (e.key.startsWith('Arrow')) {
        const s = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
        const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
        this.b = { ...this.b, cx: this.b.cx + dx, cy: this.b.cy + dy };
        this.fresh = false;
        E.overlay();
      } else return false;
      return true;
    },
    reset(E) {
      this.straighten = false;
      this.activate(E);
      E.emit('opts');
    },
    /** O: the next overlay; Shift+O: turn the triangle / spiral / diagonal around. */
    cycleOverlay(E, turn) {
      const o = E.opts('crop');
      if (turn) E.setOpt('crop', 'flip', ((+o.flip || 0) + 1) % 4);
      else {
        const list = CROP_OVERLAYS.filter((x) => x[0] !== 'none');
        const i = list.findIndex((x) => x[0] === o.overlay);
        const next = list[(i + 1) % list.length];
        E.setOpt('crop', 'overlay', next[0]);
        E.toast(`오버레이: ${next[1]}`);
      }
    },
    /** X / the swap button: portrait ⇄ landscape (the ratio fields swap too). */
    swap(E) {
      const o = E.opts('crop');
      if (o.ratio === 'orig') E.setOpt('crop', 'ratio', 'free');
      if (o.rw !== '' || o.rh !== '' || o.ratio === 'free') {
        const [w, hh] = [o.ratio === 'orig' ? E.doc.width : o.rw, o.ratio === 'orig' ? E.doc.height : o.rh];
        E.setOpt('crop', 'rw', hh);
        E.setOpt('crop', 'rh', w);
      }
      const b = this.b;
      this.b = this.fitInside(E, { ...b, w: b.h, h: b.w }, { ...b, w: b.h, h: b.w });
      // the swapped box keeps inside the picture
      const doc = E.doc;
      if (this.b.w > doc.width || this.b.h > doc.height) {
        const s = Math.min(doc.width / this.b.w, doc.height / this.b.h);
        if (!this.b.a) this.b = { ...this.b, w: this.b.w * s, h: this.b.h * s, cx: doc.width / 2, cy: doc.height / 2 };
      }
      this.fresh = false;
      E.overlay();
    },
    /** A ratio preset from the menu (W x H x Resolution presets set a pixel size). */
    setPreset(E, v) {
      const set = (k, x) => E.setOpt('crop', k, x);
      if (v.startsWith('px:')) {
        const [w, hh] = v.slice(3).split('x').map(Number);
        set('ratio', 'wxh');
        set('rw', w);
        set('rh', hh);
        set('res', 72);
      } else if (v === 'free' || v === 'wxh' || v === 'orig') {
        set('ratio', v);
        set('rw', '');
        set('rh', '');
      } else {
        const [w, hh] = v.split(':').map(Number);
        set('ratio', v);
        set('rw', w);
        set('rh', hh);
      }
      this.fitRatio(E);
    },
    /** A new ratio: the box becomes the biggest one of those proportions inside the current one. */
    fitRatio(E, keepFresh = false) {
      const k = this.ratio(E);
      const b = this.box(E);
      if (!k || !b) return void E.overlay();
      let w = b.w;
      let hh = b.h;
      if (w / hh > k) w = hh * k;
      else hh = w / k;
      this.b = { ...b, w, h: hh };
      if (!keepFresh) this.fresh = false;
      E.overlay();
    },
    apply(E) {
      const b = this.box(E);
      const doc = E.doc;
      if (!b || b.w < 1 || b.h < 1) return;
      const o = E.opts('crop');
      const size = o.ratio === 'wxh' && +o.rw > 0 && +o.rh > 0 ? { w: Math.round(+o.rw), h: Math.round(+o.rh) } : null;
      const turned = Math.abs(b.a) > 1e-4;
      const whole = !turned && Math.round(b.cx - b.w / 2) === 0 && Math.round(b.cy - b.h / 2) === 0 && Math.round(b.w) === doc.width && Math.round(b.h) === doc.height;
      if (whole && (!size || (size.w === doc.width && size.h === doc.height))) return;
      const opts = { deletePixels: !!o.deletePixels, contentAware: !!o.contentAware, size, res: size ? +o.res || null : null };
      this.b = null;
      this.straighten = false;
      const r = E.cmd.cropBox
        ? E.cmd.cropBox({ cx: b.cx, cy: b.cy, w: b.w, h: b.h, a: turned ? b.a : 0 }, opts)
        : E.cropTo({ x: Math.round(b.cx - b.w / 2), y: Math.round(b.cy - b.h / 2), w: Math.round(b.w), h: Math.round(b.h) }, opts.deletePixels);
      Promise.resolve(r).then(() => {
        if (E.tool === 'crop') this.activate(E);
        E.emit('opts');
      });
    },
    overlay(E, g) {
      const b = this.box(E);
      if (!b) return;
      const z = E.view.zoom;
      const cs = this.corners(b).map(([x, y]) => E.toScreen(x, y));
      g.save();
      // what is cut away is dimmed
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.beginPath();
      g.rect(-1e5, -1e5, 2e5, 2e5);
      cs.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill('evenodd');
      const [sx, sy] = E.toScreen(b.cx, b.cy);
      const W = b.w * z;
      const H = b.h * z;
      g.translate(sx, sy);
      g.rotate(b.a);
      const o = E.opts('crop');
      g.lineWidth = 1;
      if (this.d?.h === 'rotate') {
        // turning: a fine grid to line things up with
        g.strokeStyle = 'rgba(255,255,255,.35)';
        drawCropOverlay(g, 'grid', 0, W, H);
      } else if (o.overlay !== 'none') {
        g.strokeStyle = 'rgba(255,255,255,.6)';
        drawCropOverlay(g, o.overlay, +o.flip || 0, W, H);
      }
      g.strokeStyle = '#fff';
      g.strokeRect(-W / 2, -H / 2, W, H);
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.6)';
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
        g.fillRect((u * W) / 2 - 4, (v * H) / 2 - 4, 8, 8);
        g.strokeRect((u * W) / 2 - 4.5, (v * H) / 2 - 4.5, 9, 9);
      }
      g.restore();
      // the size (and the turn) of the result
      const turnDeg = Math.round((b.a * 1800) / Math.PI) / 10;
      const label = `${Math.round(b.w)} × ${Math.round(b.h)} px${turnDeg ? ` · ${turnDeg}°` : ''}  (Enter 또는 두 번 눌러 자르기 · Esc 취소)`;
      const top = cs.reduce((m, q) => (q[1] < m[1] ? q : m), cs[0]);
      g.save();
      g.font = '12px system-ui, sans-serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.fillStyle = '#fff';
      const ly = top[1] - 8 > 12 ? top[1] - 8 : top[1] + 18;
      g.strokeText(label, Math.max(4, top[0] - 40), ly);
      g.fillText(label, Math.max(4, top[0] - 40), ly);
      g.restore();
      // Straighten: the line being drawn and its angle
      if (this.d?.h === 'line' && this.d.moved) {
        const [x1, y1] = E.toScreen(this.d.a.x, this.d.a.y);
        const [x2, y2] = E.toScreen(this.d.b.x, this.d.b.y);
        g.save();
        for (const [c, w] of [['rgba(0,0,0,.7)', 3], ['#fff', 1]]) {
          g.strokeStyle = c;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(x1, y1);
          g.lineTo(x2, y2);
          g.stroke();
        }
        const ang = (Math.atan2(this.d.b.y - this.d.a.y, this.d.b.x - this.d.a.x) * 180) / Math.PI;
        g.font = '12px system-ui, sans-serif';
        g.fillStyle = '#fff';
        g.strokeStyle = 'rgba(0,0,0,.7)';
        g.lineWidth = 3;
        const t = `${(-ang).toFixed(1)}°`;
        g.strokeText(t, x2 + 10, y2 + 4);
        g.fillText(t, x2 + 10, y2 + 4);
        g.restore();
      }
    },
    optionButtons(E) {
      const o = E.opts('crop');
      const doc = E.doc;
      const set = (k, v) => E.setOpt('crop', k, v);
      const wxh = o.ratio === 'wxh';
      const sel = h('select', { 'aria-label': '자르기 비율', title: '비율 · 크기 사전 설정' }, CROP_PRESETS.map(([v, t]) => h('option', { value: v }, t)));
      sel.value = CROP_PRESETS.some((p) => p[0] === o.ratio) ? o.ratio : 'free';
      sel.addEventListener('change', () => this.setPreset(E, sel.value));
      const num = (key, label) => {
        const shown = o.ratio === 'orig' && doc ? (key === 'rw' ? doc.width : doc.height) : o[key];
        const inp = h('input.ph-num', { type: 'number', min: 0, step: 'any', value: shown, 'aria-label': label, title: label, placeholder: key === 'rw' ? 'W' : 'H' });
        inp.addEventListener('change', () => {
          const v = inp.value === '' ? '' : Math.max(0, +inp.value);
          if (o.ratio === 'orig') {
            set('rw', doc.width);
            set('rh', doc.height);
          }
          // typed numbers make a ratio of their own (or a pixel size in W x H x Resolution)
          if (!wxh) set('ratio', 'free');
          set(key, v);
          this.fitRatio(E);
        });
        return inp;
      };
      const res = h('input.ph-num', { type: 'number', min: 1, max: 9999, value: o.res, 'aria-label': '해상도 (ppi)', title: '해상도 (픽셀/인치)' });
      res.addEventListener('change', () => set('res', Math.max(1, +res.value || 72)));
      const ov = h('select', { 'aria-label': '오버레이', title: '자르기 오버레이 (O: 다음, Shift+O: 방향 바꾸기)' }, CROP_OVERLAYS.map(([v, t]) => h('option', { value: v }, t)));
      ov.value = o.overlay;
      ov.addEventListener('change', () => set('overlay', ov.value));
      const chk = (key, label, title) => {
        const c = h('input', { type: 'checkbox', checked: !!o[key] });
        c.addEventListener('change', () => set(key, c.checked));
        return h('label.ph-opt', { title }, c, h('span', label));
      };
      return [
        h('label.ph-opt', sel),
        h('span.ph-opt', { style: { gap: '4px' } },
          num('rw', wxh ? '폭 (px)' : '폭 비율'),
          h('button.small.ph-icobtn', { title: '높이와 폭 교체 (X)', 'aria-label': '높이와 폭 교체', onclick: () => this.swap(E) }, icon('swap', 16)),
          num('rh', wxh ? '높이 (px)' : '높이 비율'),
          wxh ? h('span.ph-opt', res, h('small', 'ppi')) : null,
          h('button.small', { title: '비율 지우기', onclick: () => this.setPreset(E, wxh ? 'wxh' : 'free') }, '지우기')),
        h(`button.small.ph-tog${this.straighten ? '.on' : ''}`, { title: '사진 안에서 수평(또는 수직)이어야 할 선을 따라 끌면 똑바르게 돌립니다 (Ctrl을 누른 채 끌어도 됨)', onclick: () => { this.straighten = !this.straighten; E.emit('opts'); } }, icon('straighten', 16), ' 똑바르게'),
        h('label.ph-opt', icon('grid', 16), ov),
        chk('deletePixels', '자른 픽셀 삭제', '끄면 잘린 부분이 캔버스 밖에 남아 나중에 옮길 수 있습니다'),
        chk('contentAware', '내용 인식', '돌리거나 넓혀서 생긴 빈 곳을 주변 내용으로 채웁니다'),
        h('button.small.ph-icobtn', { title: '현재 자르기 작업 취소 (Esc)', 'aria-label': '자르기 취소', onclick: () => this.reset(E) }, icon('close', 16)),
        h('button.primary.small.ph-icobtn', { title: '현재 자르기 작업 적용 (Enter)', 'aria-label': '자르기 적용', onclick: () => this.apply(E) }, icon('check', 16)),
      ];
    },
  },
  // ---- perspective crop
  {
    id: 'perspCrop', name: '원근 자르기', key: 'C', icon: 'perspCrop', group: 'crop', cursor: 'crosshair',
    options: [],
    activate() {
      this.q = null;
    },
    down(E, p) {
      const tol = 10 / E.view.zoom;
      if (this.q) {
        const i = this.q.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < tol);
        if (i >= 0) {
          this.d = { corner: i };
          return;
        }
        if (pointInPoly(p, this.q)) {
          this.d = { move: true, a: p, q: this.q.map((c) => [...c]) };
          return;
        }
      }
      this.d = { a: p };
      this.q = null;
    },
    move(E, p) {
      const d = this.d;
      if (!d) return;
      if (d.corner != null) this.q[d.corner] = [p.x, p.y];
      else if (d.move) this.q = d.q.map(([x, y]) => [x + p.x - d.a.x, y + p.y - d.a.y]);
      else {
        const r = rectOf({ a: d.a, b: p });
        this.q = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      }
      E.overlay();
    },
    up() {
      this.d = null;
    },
    dblclick(E) {
      this.apply(E);
    },
    onKey(E, e) {
      if (e.key === 'Enter') this.apply(E);
      else if (e.key === 'Escape') {
        this.q = null;
        E.overlay();
      } else return false;
      return true;
    },
    apply(E) {
      const q = this.q;
      if (!q) return;
      this.q = null;
      E.perspectiveCrop(q);
    },
    overlay(E, g) {
      if (!this.q) return;
      const s = this.q.map(([x, y]) => E.toScreen(x, y));
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.rect(0, 0, g.canvas.width, g.canvas.height);
      s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill('evenodd');
      g.strokeStyle = '#fff';
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
      // a 3×3 grid helps line up the perspective
      g.strokeStyle = 'rgba(255,255,255,.45)';
      const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const t of [1 / 3, 2 / 3]) {
        g.beginPath();
        g.moveTo(...L(s[0], s[3], t));
        g.lineTo(...L(s[1], s[2], t));
        g.moveTo(...L(s[0], s[1], t));
        g.lineTo(...L(s[3], s[2], t));
        g.stroke();
      }
      g.fillStyle = '#fff';
      for (const [x, y] of s) g.fillRect(x - 5, y - 5, 10, 10);
      g.fillText('모서리를 기울어진 면에 맞춘 뒤 Enter (두 번 눌러도 됨)', s[0][0], s[0][1] - 8);
      g.restore();
    },
  },
  // ---- eyedropper
  {
    id: 'eyedropper', name: '스포이드', key: 'I', icon: 'eyedropper', group: 'crop', cursor: 'crosshair',
    options: [
      ['sample', '샘플 크기', 'select', null, null, 1, [[1, '포인트 샘플'], [3, '3 x 3 평균'], [5, '5 x 5 평균'], [11, '11 x 11 평균'], [31, '31 x 31 평균'], [51, '51 x 51 평균'], [101, '101 x 101 평균']]],
      ['layers', '샘플', 'select', null, null, 'all', [['current', '현재 레이어'], ['below', '현재 및 아래'], ['all', '모든 레이어']]],
      ['ring', '샘플링 링 표시', 'bool', null, null, true],
    ],
    // Alt+click picks the background colour; dragging keeps picking the same one
    down(E, p, e) {
      this.toBg = !!e.altKey;
      this.prev = this.toBg ? E.bg : E.fg;
      this.on = true;
      this.pick(E, p);
    },
    move(E, p) {
      if (this.on) this.pick(E, p);
    },
    up(E) {
      // the colour let go on goes to the recent colours (and is remembered)
      if (this.on && this.ring?.color) E.setColor(this.ring.color, this.toBg);
      this.on = false;
      this.ring = null;
      E.overlay();
    },
    cancel(E) {
      this.up(E);
    },
    pick(E, p) {
      const c = sampleColor(E, p);
      if (c) E.setColor(rgbHex(...c), this.toBg, true);
      this.ring = c ? { p, color: rgbHex(...c) } : this.ring && { ...this.ring, p };
      E.overlay();
    },
    /** The sampling ring: the new colour above, the colour before below (Photoshop). */
    drawRing(E, g) {
      const r = this.ring;
      if (!r || !E.opts('eyedropper').ring) return;
      const [x, y] = E.toScreen(r.p.x, r.p.y);
      const R = 58;
      const w = 16;
      g.save();
      g.lineWidth = w;
      g.strokeStyle = 'rgba(128,128,128,.85)';
      g.beginPath();
      g.arc(x, y, R + w / 2 + 3, 0, Math.PI * 2);
      g.lineWidth = 6;
      g.stroke();
      g.lineWidth = w;
      g.strokeStyle = r.color;
      g.beginPath();
      g.arc(x, y, R, Math.PI, Math.PI * 2);
      g.stroke();
      g.strokeStyle = this.prev || '#000000';
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI);
      g.stroke();
      g.restore();
    },
    // brushes.js sets the overlay (notes, counts and samplers); the ring is drawn over it
    set overlay(fn) {
      this.marks = fn;
    },
    get overlay() {
      return eyedropperOverlay;
    },
  },
  // ---- painting
  strokeTool('heal', '스팟 복구 브러시', 'J', 'heal', 'heal', { group: 'retouch', options: [['size', '크기', 'range', 1, 300, 30], ['hardness', '경도', 'range', 0, 100, 60, '%']] }),
  strokeTool('brush', '브러시', 'B', 'brush', 'paint'),
  strokeTool('pencil', '연필', 'B', 'pencil', 'paint', { hard: true, hardness100: true, options: [['size', '크기', 'range', 1, 200, 2], ['opacity', '불투명도', 'range', 1, 100, 100, '%']] }),
  strokeTool('clone', '복제 도장', 'S', 'stamp', 'clone', { group: 'retouch', options: [...BRUSH_OPTS.slice(0, 4), ['aligned', '정렬 (끊어 칠해도 같은 간격)', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false]] }),
  strokeTool('eraser', '지우개', 'E', 'eraser', 'erase'),
  // ---- fills
  {
    id: 'bucket', name: '페인트 통', key: 'G', icon: 'bucket', group: 'fill', cursor: 'crosshair',
    options: [GRAD_MODE, ['opacity', '불투명도', 'range', 1, 100, 100, '%'], ['tolerance', '허용치', 'range', 0, 255, 32], ['contiguous', '인접', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false]],
    down(E, p, e) {
      if (e.altKey) {
        pickColor(E, p, false);
        return;
      }
      if (!needRaster(E, '페인트 통')) return;
      const o = E.opts('bucket');
      const doc = E.doc;
      const l = doc.active;
      const mt = E.maskTarget?.();
      let src;
      if (mt) {
        // on a mask the bucket looks at the mask itself
        src = makeCanvas(doc.width, doc.height);
        src.getContext('2d').drawImage(mt.canvas, mt.x, mt.y);
      } else src = o.sampleAll ? E.composite() : E.layerAsDocCanvas(l);
      const m = SEL.magicWand(doc, src, p.x, p.y, { tolerance: o.tolerance, contiguous: o.contiguous });
      if (!m) return;
      const before = doc.capture();
      if (mt) {
        if (doc.selection) {
          const mg = m.getContext('2d');
          mg.globalCompositeOperation = 'destination-in';
          mg.drawImage(doc.selection.canvas, 0, 0);
        }
        const v = E_lum(E.fg) / 255;
        mixIntoMask(mt.edit(), m, mt.invert ? 1 - v : v, (o.opacity ?? 100) / 100, -mt.x, -mt.y);
        if (mt.kind === 'layer') doc.touch(l);
        E.commit('페인트 통', before);
        return;
      }
      const mg = m.getContext('2d');
      mg.globalCompositeOperation = 'source-in';
      mg.fillStyle = o.fill === 'pattern' && E.patternStyle ? E.patternStyle(mg, o.pattern) : E.fg;
      mg.fillRect(0, 0, m.width, m.height);
      if (doc.selection) {
        mg.globalCompositeOperation = 'destination-in';
        mg.drawImage(doc.selection.canvas, 0, 0);
      }
      const g = doc.editPixels(l);
      const op = (o.opacity ?? 100) / 100;
      const mode = o.mode || 'normal';
      if (mode === 'normal') {
        g.globalAlpha = op;
        if (l.lockAlpha) g.globalCompositeOperation = 'source-atop';
        g.drawImage(m, -l.x, -l.y);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      } else if (!l.lockAlpha) compositeOnto(g, m, -l.x, -l.y, mode, op);
      else {
        // a blend mode with transparency locked: blend, then keep the old alpha
        const t = cloneCanvas(g.canvas);
        compositeOnto(t.getContext('2d'), m, -l.x, -l.y, mode, op);
        g.save();
        g.globalCompositeOperation = 'source-atop';
        g.drawImage(t, 0, 0);
        g.restore();
      }
      l._styled = null;
      E.commit('페인트 통', before);
    },
  },
  {
    id: 'gradient', name: '그레이디언트', key: 'G', icon: 'gradient', group: 'fill', cursor: 'crosshair',
    _options: gradientOptions([['type', '종류', 'select', null, null, 'linear', [['linear', '선형'], ['radial', '방사형'], ['reflected', '반사']]], ['to', '끝 색', 'select', null, null, 'bg', [['bg', '전경색 → 배경색'], ['clear', '전경색 → 투명']]], ['opacity', '불투명도', 'range', 1, 100, 100, '%']]),
    // paint2.js replaces the options (presets, styles…): mode and transparency are kept in them
    get options() {
      return this._options;
    },
    set options(v) {
      this._options = gradientOptions(v);
    },
    down(E, p) {
      // the gradient just drawn stays editable: drag its start or end point (or the line) again
      const live = this.liveAt(E, p);
      if (live) {
        const e0 = this.live.entry;
        const after = E.doc.capture();
        this.live = null;
        E.doc.history.undoStack.pop();
        E.doc.restore(e0.state);
        if (!this.begin(E, live.a, live.b, e0.state)) {
          E.doc.restore(after);
          E.commit('그레이디언트', e0.state);
          return;
        }
        this.d.after = after;
        this.d.edit = live.part;
        this.d.grab = p;
        this.d.a0 = live.a;
        this.d.b0 = live.b;
        return;
      }
      this.live = null;
      this.begin(E, p, p, null);
    },
    begin(E, a, b, before) {
      if (!needRaster(E, '그레이디언트')) return false;
      const l = E.doc.active;
      this.d = { a, b, before: before || E.doc.capture() };
      const mt = E.maskTarget?.();
      if (mt) {
        this.d.mt = mt;
        this.d.base = mt.canvas;
        this.d.mg = mt.edit();
        return true;
      }
      const old = l.canvas;
      const [ox, oy] = [l.x, l.y];
      E.doc.editPixels(l);
      this.d.base = sameGeometry(old, ox, oy, l) ? old : cloneCanvas(l.canvas);
      return true;
    },
    /** Which part of the live gradient is under p (screen tolerance): 'a', 'b', 'line' or null. */
    liveAt(E, p) {
      const L = this.live;
      if (!L || L.doc !== E.doc || E.doc.history.undoStack.at(-1) !== L.entry) return null;
      const tol = 10 / E.view.zoom;
      if (dist(p, L.a) <= tol) return { ...L, part: 'a' };
      if (dist(p, L.b) <= tol) return { ...L, part: 'b' };
      const dx = L.b.x - L.a.x;
      const dy = L.b.y - L.a.y;
      const t = ((p.x - L.a.x) * dx + (p.y - L.a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy);
      if (t > 0 && t < 1 && dist(p, { x: L.a.x + dx * t, y: L.a.y + dy * t }) <= tol * 0.7) return { ...L, part: 'line' };
      return null;
    },
    activate(E) {
      // the live gradient follows changed options and colours (reverse, style, mode…)
      if (this.hooked || !E.on) return;
      this.hooked = true;
      let raf = 0;
      const again = () => {
        if (raf || E.tool !== 'gradient' || this.d || !this.liveOk(E)) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (E.tool === 'gradient' && !this.d && this.liveOk(E)) this.repaintLive(E);
        });
      };
      E.on('opts', again);
      E.on('color', again);
    },
    liveOk(E) {
      const L = this.live;
      return !!L && L.doc === E.doc && E.doc.history.undoStack.at(-1) === L.entry;
    },
    /** Draw the live gradient again over what was there before it (one step, still live). */
    repaintLive(E) {
      const L = this.live;
      const e0 = L.entry;
      const after = E.doc.capture();
      E.doc.history.undoStack.pop();
      E.doc.restore(e0.state);
      if (!this.begin(E, L.a, L.b, e0.state)) {
        E.doc.restore(after);
        E.commit('그레이디언트', e0.state);
        this.live = { ...L, entry: E.doc.history.undoStack.at(-1) };
        return;
      }
      this.d.final = true;
      this.paint(E);
      this.d = null;
      E.commit('그레이디언트', e0.state);
      this.live = { a: L.a, b: L.b, doc: E.doc, entry: E.doc.history.undoStack.at(-1) };
    },
    onKey(E, e) {
      if (!this.live || (e.key !== 'Enter' && e.key !== 'Escape')) return false;
      this.live = null;
      E.overlay();
      return true;
    },
    deactivate(E) {
      this.live = null;
      E?.overlay?.();
    },
    move(E, p) {
      if (!this.d) return;
      const d = this.d;
      if (d.edit === 'a') d.a = p;
      else if (d.edit === 'line') {
        const dx = p.x - d.grab.x;
        const dy = p.y - d.grab.y;
        d.a = { x: d.a0.x + dx, y: d.a0.y + dy };
        d.b = { x: d.b0.x + dx, y: d.b0.y + dy };
      } else d.b = p;
      // pointers report far more often than the screen updates: paint once per frame
      if (!this.raf) {
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          if (this.d) this.paint(E);
        });
      }
    },
    up(E) {
      if (!this.d) return;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.d.floating) E.float = null;
      const d = this.d;
      if (dist(d.a, d.b) > 1) {
        d.final = true;
        this.paint(E);
        E.commit('그레이디언트', d.before);
        // until something else happens, its start and end points can still be dragged
        this.live = { a: d.a, b: d.b, doc: E.doc, entry: E.doc.history.undoStack.at(-1) };
        this.activate(E);
      } else if (d.edit) this.restoreLive(E, d);
      else {
        E.doc.restore(d.before);
        E.afterHistory();
      }
      this.d = null;
      E.redraw();
    },
    /** An edit of the live gradient called off: the gradient as it was is the last step again. */
    restoreLive(E, d) {
      E.doc.restore(d.after);
      E.commit('그레이디언트', d.before);
      this.live = { a: d.a0, b: d.b0, doc: E.doc, entry: E.doc.history.undoStack.at(-1) };
    },
    paint(E) {
      const { a, b, base } = this.d;
      const doc = E.doc;
      const l = doc.active;
      const o0 = E.opts('gradient');
      const mode = o0.mode || 'normal';
      // Transparency off: the gradient's opacity stops are left out
      const o = o0.transparency === false ? { ...o0, preset: 'custom', custom: { ...gradientOf(o0), alphas: [{ pos: 0, a: 1 }, { pos: 1, a: 1 }] } } : o0;
      // while dragging over a plain layer, the gradient floats just above it instead of being
      // painted into the layer every frame; on the top layer it is made at screen size
      const plain = !this.d.mt && !this.d.final && mode === 'normal' && !l.lockAlpha && (l.blend || 'normal') === 'normal' && !l.mask && !l.vmask && !l.clip && !hasFx(l.fx) && (l.fillOpacity ?? 1) === 1;
      const li = doc.layers.indexOf(l);
      const top = plain && !l.parent && doc.layers.slice(li + 1).every((x) => !doc.shown(x));
      const scale = top ? Math.min(1, doc.view.zoom * (window.devicePixelRatio || 1)) : 1;
      // presets, five styles, reverse and dither come from paint2.js
      const gc = E.gradientCanvas ? E.gradientCanvas(a, b, { ...o, final: !!this.d.final, scale }) : makeCanvas(doc.width, doc.height);
      const gg = gc.getContext('2d');
      if (!E.gradientCanvas) {
        const len = Math.max(1, dist(a, b));
        const grad = o.type === 'linear' ? gg.createLinearGradient(a.x, a.y, b.x, b.y) : gg.createRadialGradient(a.x, a.y, 0, a.x, a.y, len);
        const end = o.to === 'clear' ? `${E.fg}00` : E.bg;
        if (o.type === 'reflected') {
          const g2 = gg.createLinearGradient(a.x - (b.x - a.x), a.y - (b.y - a.y), b.x, b.y);
          g2.addColorStop(0, end);
          g2.addColorStop(0.5, E.fg);
          g2.addColorStop(1, end);
          gg.fillStyle = g2;
        } else {
          grad.addColorStop(0, E.fg);
          grad.addColorStop(1, end);
          gg.fillStyle = grad;
        }
        gg.fillRect(0, 0, gc.width, gc.height);
      }
      if (doc.selection) {
        gg.globalCompositeOperation = 'destination-in';
        gg.drawImage(doc.selection.canvas, 0, 0, gc.width, gc.height);
        gg.globalCompositeOperation = 'source-over';
      }
      if (this.d.mt) {
        // on a mask: the gradient's grey levels (and transparency) become mask amounts
        const mt = this.d.mt;
        const img = gg.getImageData(0, 0, gc.width, gc.height);
        const d = img.data;
        const va = new ImageData(gc.width, gc.height);
        for (let i = 0; i < d.length; i += 4) {
          let v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          if (mt.invert) v = 1 - v;
          va.data[i + 3] = d[i + 3] * v;
          d[i] = d[i + 1] = d[i + 2] = 0;
        }
        const A = makeCanvas(gc.width, gc.height);
        A.getContext('2d').putImageData(img, 0, 0);
        const VA = makeCanvas(gc.width, gc.height);
        VA.getContext('2d').putImageData(va, 0, 0);
        const g = this.d.mg;
        const op = (o.opacity ?? 100) / 100;
        g.save();
        g.globalCompositeOperation = 'copy';
        g.drawImage(base, 0, 0);
        g.globalAlpha = op;
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(A, -mt.x, -mt.y);
        g.globalCompositeOperation = 'lighter';
        g.drawImage(VA, -mt.x, -mt.y);
        g.restore();
        if (mt.kind === 'layer') doc.touch(l);
        else doc.rev++;
        E.redraw();
        return;
      }
      if (plain) {
        const op = (o.opacity ?? 100) / 100;
        if (op < 1) {
          gg.globalCompositeOperation = 'destination-in';
          gg.fillStyle = `rgba(0,0,0,${op})`;
          gg.fillRect(0, 0, gc.width, gc.height);
          gg.globalCompositeOperation = 'source-over';
        }
        if (!this.d.floating) {
          // the layer shows its pre-gradient pixels under the float
          const lg = l.canvas.getContext('2d');
          lg.save();
          lg.globalCompositeOperation = 'copy';
          lg.drawImage(base, 0, 0);
          lg.restore();
          doc.touch(l);
          this.d.floating = true;
        }
        // on the top layer nothing covers the gradient: it is drawn straight over the view
        E.float = { layerId: l.id, canvas: gc, x: 0, y: 0, preview: true, viewOnly: top };
        if (!top) doc.rev++;
        E.redraw();
        return;
      }
      if (this.d.floating) {
        E.float = null;
        this.d.floating = false;
      }
      const g = l.canvas.getContext('2d');
      const op = (o.opacity ?? 100) / 100;
      g.save();
      g.globalCompositeOperation = 'copy';
      g.drawImage(base, 0, 0);
      g.restore();
      if (mode === 'normal') {
        g.save();
        g.globalCompositeOperation = l.lockAlpha ? 'source-atop' : 'source-over';
        g.globalAlpha = op;
        g.drawImage(gc, -l.x, -l.y);
        g.restore();
      } else if (!l.lockAlpha) compositeOnto(g, gc, -l.x, -l.y, mode, op);
      else {
        // a blend mode on a layer whose transparency is locked: blend, then keep the old alpha
        const t = cloneCanvas(base);
        compositeOnto(t.getContext('2d'), gc, -l.x, -l.y, mode, op);
        g.save();
        g.globalCompositeOperation = 'source-atop';
        g.drawImage(t, 0, 0);
        g.restore();
      }
      l._styled = null;
      doc.touch(l);
      E.redraw();
    },
    cancel(E) {
      if (!this.d) return;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.d.floating) E.float = null;
      const d = this.d;
      this.d = null;
      if (d.edit) this.restoreLive(E, d);
      else {
        E.doc.restore(d.before);
        E.afterHistory();
      }
    },
    overlay(E, g) {
      const L = !this.d && this.live?.doc === E.doc && E.doc.history.undoStack.at(-1) === this.live.entry ? this.live : null;
      if (L) {
        // the live gradient: its line with the start and end points to drag
        const [x1, y1] = E.toScreen(L.a.x, L.a.y);
        const [x2, y2] = E.toScreen(L.b.x, L.b.y);
        g.save();
        for (const [c, w] of [['rgba(0,0,0,.55)', 3], ['#fff', 1.5]]) {
          g.strokeStyle = c;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(x1, y1);
          g.lineTo(x2, y2);
          g.stroke();
        }
        for (const [x, y, c] of [[x1, y1, E.fg], [x2, y2, E.bg]]) {
          g.beginPath();
          g.arc(x, y, 6, 0, Math.PI * 2);
          g.fillStyle = c;
          g.fill();
          g.lineWidth = 2;
          g.strokeStyle = '#fff';
          g.stroke();
          g.lineWidth = 1;
          g.strokeStyle = 'rgba(0,0,0,.6)';
          g.beginPath();
          g.arc(x, y, 7.5, 0, Math.PI * 2);
          g.stroke();
        }
        g.restore();
        return;
      }
      if (!this.d) return;
      const [x1, y1] = E.toScreen(this.d.a.x, this.d.a.y);
      const [x2, y2] = E.toScreen(this.d.b.x, this.d.b.y);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    },
  },
  // ---- retouch
  // Photoshop's names (흐림 효과 도구, 손가락 도구, 닷지 도구, 스폰지 도구…)
  retouchTool('blur', '흐림 효과', null, 'drop', 'blur', [RETOUCH_MODE, SAMPLE_ALL_R]),
  retouchTool('sharpen', '선명 효과', null, 'sharpenTool', 'sharpen', [RETOUCH_MODE, SAMPLE_ALL_R, ['protectDetail', '세부 묘사 보호', 'bool', null, null, true]]),
  retouchTool('smudge', '손가락', null, 'smudge', 'smudge', [RETOUCH_MODE, SAMPLE_ALL_R, ['fingerPaint', '손가락 페인팅', 'bool', null, null, false]]),
  retouchTool('push', '픽셀 유동화 (밀기)', null, 'push', 'push'),
  retouchTool('dodge', '닷지', 'O', 'dodge', 'dodge', [TONE_RANGE, ['protectTones', '톤 보호', 'bool', null, null, true]], '노출'),
  retouchTool('burn', '번', 'O', 'burn', 'burn', [TONE_RANGE, ['protectTones', '톤 보호', 'bool', null, null, true]], '노출'),
  retouchTool('sponge', '스폰지', 'O', 'sponge', 'sponge', [['mode', '모드', 'select', null, null, 'desaturate', [['desaturate', '채도 감소'], ['saturate', '채도 증가']]], ['vibrance', '활기 (강한 색은 덜)', 'bool', null, null, true]], '흐름'),
  // ---- text
  typeTool('text', '수평 문자', 'T', 'text', { vertical: false, mask: false }),
  typeTool('verticalText', '세로 문자', 'T', 'verticalText', { vertical: true, mask: false }),
  typeTool('textMask', '수평 문자 마스크', 'T', 'textMask', { vertical: false, mask: true }),
  typeTool('verticalTextMask', '세로 문자 마스크', 'T', 'verticalTextMask', { vertical: true, mask: true }),
  // ---- shapes
  {
    id: 'shape', name: '모양', key: 'U', icon: 'shape', group: 'type', cursor: 'crosshair',
    options: [['mode', '모드', 'select', null, null, 'shape', [['shape', '모양 (레이어)'], ['path', '패스'], ['pixels', '픽셀 (현재 레이어에)']]], ['type', '모양', 'select', null, null, 'rect', SHAPES], ['custom', '사용자 정의', 'select', null, null, 'heart', 'customShapes'], ['sides', '면 / 꼭짓점', 'number', 3, 100, 5], ['fill', '채우기', 'select', null, null, 'fg', [['fg', '전경색'], ['bg', '배경색'], ['none', '없음']]], ['strokeWidth', '선 두께', 'range', 0, 100, 0], ['radius', '모서리 반경', 'range', 0, 300, 24]],
    down(E, p, e) {
      if (e.altKey) {
        pickColor(E, p, false);
        return;
      }
      this.d = { a: p, b: p };
    },
    move(E, p, e) {
      if (!this.d) return;
      let b = p;
      if (e.shiftKey) {
        const s = Math.max(Math.abs(p.x - this.d.a.x), Math.abs(p.y - this.d.a.y));
        b = { x: this.d.a.x + Math.sign(p.x - this.d.a.x || 1) * s, y: this.d.a.y + Math.sign(p.y - this.d.a.y || 1) * s };
      }
      this.d.b = b;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const r = rectOf(d);
      const o = E.opts('shape');
      if (r.w < 3 && r.h < 3) {
        E.overlay();
        return;
      }
      const before = E.doc.capture();
      const fill = o.fill === 'none' ? null : o.fill === 'bg' ? E.bg : E.fg;
      const isLine = o.type === 'line';
      const l = newLayer('shape', {
        name: o.type === 'custom' ? E.customShapeName(o.custom) : SHAPES.find((s) => s[0] === o.type)?.[1] || '모양',
        shape: { type: o.type, custom: o.custom, sides: o.sides, w: Math.max(1, Math.round(r.w)), h: Math.max(isLine ? Math.max(2, o.strokeWidth || 6) : 1, Math.round(isLine ? Math.max(2, o.strokeWidth || 6) : r.h)), fill, stroke: o.strokeWidth > 0 || isLine ? (fill === E.fg ? E.bg : E.fg) : null, strokeWidth: isLine ? Math.max(2, o.strokeWidth || 6) : o.strokeWidth, radius: o.radius },
      });
      if (o.mode === 'path' || o.mode === 'pixels') {
        // the same geometry as a work path, or painted straight onto the current layer
        const sps = E.shapeSubpaths(l.shape, Math.round(r.x), Math.round(r.y));
        if (o.mode === 'path') E.addToWorkPath(sps, '모양 (패스)', before);
        else E.paintShapePixels(sps, l.shape, before);
        return;
      }
      l.x = Math.round(r.x);
      l.y = Math.round(isLine ? d.a.y - l.shape.h / 2 : r.y);
      if (isLine) {
        // a line follows the drag direction
        const ang = (Math.atan2(d.b.y - d.a.y, d.b.x - d.a.x) * 180) / Math.PI;
        l.shape.w = Math.max(2, Math.round(dist(d.a, d.b)));
        l.rotation = Math.round(ang * 10) / 10;
        l.x = Math.round((d.a.x + d.b.x) / 2 - l.shape.w / 2);
        l.y = Math.round((d.a.y + d.b.y) / 2 - l.shape.h / 2);
      }
      E.addLayer(l);
      E.commit('모양', before);
    },
    overlay(E, g) {
      if (!this.d) return;
      const r = rectOf(this.d);
      const [x, y] = E.toScreen(r.x, r.y);
      g.strokeStyle = '#4aa3ff';
      g.setLineDash([4, 3]);
      if (E.opts('shape').type === 'line') {
        const [x1, y1] = E.toScreen(this.d.a.x, this.d.a.y);
        const [x2, y2] = E.toScreen(this.d.b.x, this.d.b.y);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      } else g.strokeRect(x + 0.5, y + 0.5, r.w * E.view.zoom, r.h * E.view.zoom);
      g.setLineDash([]);
    },
  },
  // ---- navigation
  {
    id: 'hand', name: '손 (화면 이동)', key: 'H', icon: 'hand', group: 'view', cursor: 'grab',
    options: [],
    down(E, p, e) {
      this.d = { sx: e.clientX, sy: e.clientY, vx: E.view.x, vy: E.view.y };
    },
    move(E, p, e) {
      if (!this.d) return;
      E.view.auto = false;
      E.view.x = this.d.vx + (e.clientX - this.d.sx);
      E.view.y = this.d.vy + (e.clientY - this.d.sy);
      E.viewChanged();
    },
    up() {
      this.d = null;
    },
    optionButtons: (E) => viewButtons(E),
  },
  {
    id: 'zoom', name: '돋보기', key: 'Z', icon: 'zoomIn', group: 'view',
    options: [['scrubby', '스크러비 확대/축소', 'bool', null, null, true]],
    // Alt (held while the pointer moves over the picture) zooms out
    get cursor() {
      return this.alt ? 'zoom-out' : 'zoom-in';
    },
    hover(E, p, e) {
      this.alt = !!e?.altKey;
    },
    down(E, p, e) {
      this.alt = !!e.altKey;
      this.d = { cx: e.clientX, cy: e.clientY, p, zoom: E.view.zoom, out: !!e.altKey, moved: false, b: p };
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 3) d.moved = true;
      if (!d.moved) return;
      // scrubby zoom: drag right to zoom in, left to zoom out, about the point pressed on;
      // without it, drag a box to zoom into
      if (E.opts('zoom').scrubby) E.setZoom(d.zoom * Math.exp((e.clientX - d.cx) * 0.01), d.cx, d.cy);
      else {
        d.b = p;
        E.overlay();
      }
    },
    up(E, p, e) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      if (!d.moved) {
        zoomStepAt(E, d.out ? -1 : 1, d.cx, d.cy);
        return;
      }
      if (E.opts('zoom').scrubby) return;
      const r = rectOf({ a: d.p, b: d.b });
      E.overlay();
      if (d.out) {
        zoomStepAt(E, -1, d.cx, d.cy);
        return;
      }
      const st = document.querySelector('.ph-stage')?.getBoundingClientRect();
      if (!st || r.w * E.view.zoom < 4 || r.h * E.view.zoom < 4) return;
      // zoom so the box fills the window, centred on it
      E.setZoom(Math.min(st.width / r.w, st.height / r.h), st.left + st.width / 2, st.top + st.height / 2);
      const [sx, sy] = E.toScreen(r.x + r.w / 2, r.y + r.h / 2);
      E.view.x += st.width / 2 - sx;
      E.view.y += st.height / 2 - sy;
      E.viewChanged();
    },
    overlay(E, g) {
      const d = this.d;
      if (!d?.moved || E.opts('zoom').scrubby) return;
      const r = rectOf({ a: d.p, b: d.b });
      const [x, y] = E.toScreen(r.x, r.y);
      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = '#fff';
      g.strokeRect(x + 0.5, y + 0.5, r.w * E.view.zoom, r.h * E.view.zoom);
      g.lineDashOffset = 4;
      g.strokeStyle = '#000';
      g.strokeRect(x + 0.5, y + 0.5, r.w * E.view.zoom, r.h * E.view.zoom);
      g.restore();
    },
    optionButtons: (E) => [h('span.ph-opt.ph-hint', 'Alt: 축소'), ...viewButtons(E)],
  },
];

const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];

/** One zoom level in or out, keeping the point under (cx, cy) in place. */
function zoomStepAt(E, dir, cx, cy) {
  const z = E.view.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((x) => x > z * 1.001) : [...ZOOM_STEPS].reverse().find((x) => x < z / 1.001);
  E.setZoom(next ?? z, cx, cy);
}

/** The hand and zoom tools' buttons: 100%, Fit on Screen, Fill Screen. */
function viewButtons(E) {
  const fill = () => {
    const doc = E.doc;
    const st = document.querySelector('.ph-stage')?.getBoundingClientRect();
    if (!doc || !st) return;
    const z = Math.max(st.width / doc.width, st.height / doc.height);
    doc.view = { ...doc.view, zoom: z, x: (st.width - doc.width * z) / 2, y: (st.height - doc.height * z) / 2, fitted: true, auto: false };
    E.viewChanged();
  };
  return [
    h('button.small', { onclick: () => E.doc && E.setZoom(1), title: '실제 픽셀 크기로 보기' }, '100%'),
    h('button.small', { onclick: () => E.doc && E.fit(), title: '화면에 맞게 보기 (Ctrl+0)' }, '화면 맞추기'),
    h('button.small', { onclick: fill, title: '화면을 가득 채우게 보기' }, '화면 채우기'),
  ];
}

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/** Toolbar groups (like Photoshop's tool slots), in order. */
export const TOOL_GROUPS = [
  ['move'], ['rect', 'ellipse'], ['lasso'], ['wand'], ['crop', 'perspCrop'], ['eyedropper'], ['heal'], ['brush', 'pencil'], ['clone'], ['eraser'],
  ['gradient', 'bucket'], ['blur', 'sharpen', 'smudge', 'push'], ['dodge', 'burn', 'sponge'], ['text', 'verticalText', 'textMask', 'verticalTextMask'], ['shape'], ['hand'], ['zoom'],
];

function pointInPoly(p, pts) {
  let inside2 = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside2 = !inside2;
  }
  return inside2;
}

export { boxCorners, FONT_CATEGORIES };

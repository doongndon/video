// Photo editor tools. A tool gets pointer events in document coordinates plus the editor context
// `E` (current doc, colours, tool options, view and helpers) and draws its own overlay.

import { makeCanvas, cloneCanvas, newLayer, boxCorners, SHAPES } from './doc.js';
import * as SEL from './selection.js';
import { mixIntoMask } from './selectx.js';
import { FONT_CATEGORIES } from '../fonts.js';

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
      this.g = doc.editPixels(this.layer, { x: 0, y: 0, w: doc.width, h: doc.height });
      // pre-stroke pixels at the (possibly grown) canvas size
      this.base = cloneCanvas(this.layer.canvas);
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
      g.globalCompositeOperation = this.mode === 'erase' ? 'destination-out' : this.layer.lockAlpha ? 'source-atop' : 'source-over';
      g.drawImage(this.buf, 0, 0);
    }
    g.restore();
    if (this.maskKind === 'quick' || this.maskKind === 'channel') this.E.doc.rev++;
    else {
      this.layer._styled = null;
      this.E.doc.touch(this.layer);
    }
    this.E.redraw();
  }

  end() {
    this.flush();
    if (this.mode === 'heal' && !this.E.healFill?.(this)) heal(this);
    else if (this.o.afterStroke) this.o.afterStroke(this);
    this.E.commit(this.o.label || '브러시', this.before);
  }
}

function E_lum(hex) {
  const [r, g, b] = hexRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
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
  }

  to(p) {
    if (!this.last) {
      this.last = p;
      if (this.kind !== 'smudge' && this.kind !== 'push') this.apply(p, { x: 0, y: 0 });
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
    this.E.doc.touch(this.layer);
    this.E.redraw();
  }

  apply(p, mv) {
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
    const img = g.getImageData(x0, y0, w, h);
    const d = img.data;
    const src = new Uint8ClampedArray(d);
    const k = (this.o.strength ?? 50) / 100;
    const hard = this.o.hardness ?? 0.5;
    const sel = this.E.doc.selection ? this.E.selAlpha(x0 + this.layer.x, y0 + this.layer.y, w, h) : null;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let wgt = falloff(Math.hypot(x0 + x + 0.5 - cx, y0 + y + 0.5 - cy), r, hard) * k;
        if (sel) wgt *= sel[y * w + x] / 255;
        if (wgt <= 0) continue;
        const o = (y * w + x) * 4;
        if (this.kind === 'blur' || this.kind === 'sharpen') {
          for (let c = 0; c < 4; c++) {
            const avg = (src[o + c] * 4 + src[o - 4 + c] + src[o + 4 + c] + src[o - w * 4 + c] + src[o + w * 4 + c] + (src[o - w * 4 - 4 + c] + src[o - w * 4 + 4 + c] + src[o + w * 4 - 4 + c] + src[o + w * 4 + 4 + c]) * 0.5) / 10;
            const v = this.kind === 'blur' ? avg : src[o + c] + (src[o + c] - avg) * 1.5;
            d[o + c] = src[o + c] + (v - src[o + c]) * wgt * (this.kind === 'sharpen' ? 0.6 : 1);
          }
        } else if (this.kind === 'dodge' || this.kind === 'burn') {
          for (let c = 0; c < 3; c++) {
            const v = src[o + c];
            d[o + c] = this.kind === 'dodge' ? v + (255 - v) * wgt * 0.25 : v - v * wgt * 0.25;
          }
        } else if (this.kind === 'smudge' || this.kind === 'push') {
          // sample from behind the brush movement
          const sx = Math.round(x - mv.x * (this.kind === 'push' ? 1 : 1));
          const sy = Math.round(y - mv.y * (this.kind === 'push' ? 1 : 1));
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const so = (sy * w + sx) * 4;
          for (let c = 0; c < 4; c++) d[o + c] = src[o + c] + (src[so + c] - src[o + c]) * wgt;
        }
      }
    }
    g.putImageData(img, x0, y0);
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

function pickColor(E, p, toBg) {
  const c = E.composite();
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const s = E.opts('eyedropper').sample || 1;
  const r = Math.floor(s / 2);
  const d = c.getContext('2d').getImageData(Math.max(0, x - r), Math.max(0, y - r), s, s).data;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    rr += d[i];
    gg += d[i + 1];
    bb += d[i + 2];
    n++;
  }
  E.setColor(rgbHex(rr / n, gg / n, bb / n), toBg);
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
    finish(E) {
      const d = this.d;
      this.d = null;
      if (!d || d.pts.length < 3) {
        E.overlay();
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
      this.st.to(p, e.pressure || 1);
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

function retouchTool(id, name, key, icon, kind) {
  return {
    id, name, key, icon, group: 'retouch', cursor: 'brush',
    options: [['size', '크기', 'range', 1, 500, 60], ['strength', '강도', 'range', 1, 100, 50, '%'], ['hardness', '경도', 'range', 0, 100, 40, '%']],
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
      this.r = new Retouch(E, kind, { size: o.size, strength: o.strength, hardness: (o.hardness ?? 40) / 100, label: name });
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

export const TOOLS = [
  // ---- move
  {
    id: 'move', name: '이동', key: 'V', icon: 'move', group: 'move', cursor: 'move',
    options: [['autoSelect', '자동 선택', 'bool', null, null, false], ['autoTarget', '대상', 'select', null, null, 'layer', [['layer', '레이어'], ['group', '그룹']]], ['showTransform', '변형 컨트롤 표시', 'bool', null, null, false]],
    down(E, p, e) {
      const doc = E.doc;
      // Ctrl (⌘) inverts auto-select for one click, like Photoshop
      if (!!E.opts('move').autoSelect !== !!(e?.ctrlKey || e?.metaKey)) {
        let hit = E.layerAt(p);
        if (hit && E.opts('move').autoTarget === 'group') {
          const top = doc.ancestors(hit).pop();
          if (top) hit = top;
        }
        if (hit) E.selectLayer(hit.id, e?.shiftKey ? 'add' : 'single');
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
      // with a selection, Alt+drag duplicates the pixels instead of cutting them out
      if (doc.selection && l.kind === 'raster') float = liftSelection(E, { copy: !!e?.altKey });
      else if (e?.altKey && !doc.selection) {
        // Alt+drag a layer: move a copy
        E.cmd.duplicateLayer();
        doc.history.undoStack.pop();
      }
      this.d = { a: p, before, float, moving: doc.selectedLayers.filter((x) => x.kind !== 'adjust' || x.mask), last: { dx: 0, dy: 0 }, sel: doc.selection };
      E.float = float;
      E.redraw();
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      let dx = p.x - d.a.x;
      let dy = p.y - d.a.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      dx = Math.round(dx);
      dy = Math.round(dy);
      if (d.float) {
        E.float = { ...d.float, x: d.float.x + dx, y: d.float.y + dy };
        d.offset = { dx, dy };
      } else {
        const sx = E.snapMove ? E.snapMove(d.moving, dx, dy) : { dx, dy };
        E.doc.translateLayers(d.moving, sx.dx - d.last.dx, sx.dy - d.last.dy);
        d.last = sx;
      }
      E.redraw();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      if (d.float) {
        const off = d.offset || { dx: 0, dy: 0 };
        dropFloat(E, E.float || d.float);
        E.float = null;
        if (d.sel && (off.dx || off.dy)) {
          const c = makeCanvas(E.doc.width, E.doc.height);
          c.getContext('2d').drawImage(d.sel.canvas, off.dx, off.dy);
          E.doc.selection = { canvas: c };
        }
      } else if (!d.last.dx && !d.last.dy) {
        E.redraw();
        return;
      }
      E.doc.touch(E.doc.active);
      E.commit('이동', d.before);
    },
    cancel(E) {
      if (!this.d) return;
      E.float = null;
      E.doc.restore(this.d.before);
      this.d = null;
      E.redraw();
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
    options: [['ratio', '비율', 'select', null, null, 'free', [['free', '자유'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['9:16', '9:16'], ['4:5', '4:5']]], ['deletePixels', '잘린 픽셀 삭제', 'bool', null, null, false]],
    activate(E) {
      // the whole picture to start with; dragging inside it draws a new box (like Photoshop)
      this.r = { x: 0, y: 0, w: E.doc.width, h: E.doc.height };
      this.fresh = true;
      E.overlay();
    },
    deactivate() {
      this.r = null;
    },
    down(E, p) {
      const r = this.r || { x: 0, y: 0, w: E.doc.width, h: E.doc.height };
      const h = this.handleAt(E, p, r);
      this.d = { a: p, r0: { ...r }, h: h || (inside(p, r) && !this.fresh ? 'move' : 'new') };
      this.fresh = false;
      if (this.d.h === 'new') this.r = { x: p.x, y: p.y, w: 0, h: 0 };
    },
    move(E, p, e) {
      const d = this.d;
      if (!d) return;
      const dx = p.x - d.a.x;
      const dy = p.y - d.a.y;
      let r = { ...d.r0 };
      if (d.h === 'move') {
        r.x += dx;
        r.y += dy;
      } else if (d.h === 'new') r = { x: Math.min(d.a.x, p.x), y: Math.min(d.a.y, p.y), w: Math.abs(p.x - d.a.x), h: Math.abs(p.y - d.a.y) };
      else {
        if (d.h.includes('l')) {
          r.x += dx;
          r.w -= dx;
        }
        if (d.h.includes('r')) r.w += dx;
        if (d.h.includes('t')) {
          r.y += dy;
          r.h -= dy;
        }
        if (d.h.includes('b')) r.h += dy;
      }
      const ratio = E.opts('crop').ratio;
      const k = e.shiftKey ? d.r0.w / Math.max(1, d.r0.h) : ratio === 'free' ? 0 : ratio.split(':').reduce((a, c) => a / c);
      if (k && d.h !== 'move') r.h = Math.abs(r.w) / k;
      if (r.w < 0) {
        r.x += r.w;
        r.w = -r.w;
      }
      if (r.h < 0) {
        r.y += r.h;
        r.h = -r.h;
      }
      this.r = r;
      E.overlay();
    },
    up(E) {
      // a click without dragging brings the whole-picture box back
      if (this.d?.h === 'new' && this.r && (this.r.w < 2 || this.r.h < 2)) this.activate(E);
      this.d = null;
    },
    dblclick(E) {
      this.apply(E);
    },
    onKey(E, e) {
      if (e.key === 'Enter') this.apply(E);
      else if (e.key === 'Escape') this.activate(E);
      else return false;
      return true;
    },
    apply(E) {
      const r = this.r;
      if (!r || r.w < 1 || r.h < 1) return;
      if (Math.round(r.x) === 0 && Math.round(r.y) === 0 && Math.round(r.w) === E.doc.width && Math.round(r.h) === E.doc.height) return;
      E.cropTo({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, E.opts('crop').deletePixels);
      this.activate(E);
    },
    handleAt(E, p, r) {
      const tol = 10 / E.view.zoom;
      const near = (x, y) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol;
      const hs = { tl: [r.x, r.y], tr: [r.x + r.w, r.y], bl: [r.x, r.y + r.h], br: [r.x + r.w, r.y + r.h], t: [r.x + r.w / 2, r.y], b: [r.x + r.w / 2, r.y + r.h], l: [r.x, r.y + r.h / 2], r: [r.x + r.w, r.y + r.h / 2] };
      return Object.keys(hs).find((k) => near(...hs[k])) || null;
    },
    overlay(E, g) {
      const r = this.r;
      if (!r) return;
      const [x, y] = E.toScreen(r.x, r.y);
      const w = r.w * E.view.zoom;
      const h = r.h * E.view.zoom;
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.beginPath();
      g.rect(0, 0, g.canvas.width, g.canvas.height);
      g.rect(x, y, w, h);
      g.fill('evenodd');
      g.strokeStyle = '#fff';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.4)';
      for (const k of [1, 2]) {
        g.beginPath();
        g.moveTo(x + (w * k) / 3, y);
        g.lineTo(x + (w * k) / 3, y + h);
        g.moveTo(x, y + (h * k) / 3);
        g.lineTo(x + w, y + (h * k) / 3);
        g.stroke();
      }
      g.fillStyle = '#fff';
      for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) g.fillRect(x + w * hx - 4, y + h * hy - 4, 8, 8);
      g.font = '12px sans-serif';
      g.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}  (Enter 또는 두 번 눌러 자르기)`, x + 4, y - 6 > 12 ? y - 6 : y + 16);
      g.restore();
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
    options: [['sample', '샘플 크기', 'select', null, null, 1, [[1, '1 픽셀'], [3, '3×3 평균'], [5, '5×5 평균']]]],
    down(E, p, e) {
      pickColor(E, p, e.altKey);
      this.on = !e.altKey;
    },
    move(E, p) {
      if (this.on) pickColor(E, p, false);
    },
    up() {
      this.on = false;
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
    options: [['tolerance', '허용치', 'range', 0, 255, 32], ['contiguous', '인접', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false], ['opacity', '불투명도', 'range', 1, 100, 100, '%']],
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
      g.globalAlpha = (o.opacity ?? 100) / 100;
      if (l.lockAlpha) g.globalCompositeOperation = 'source-atop';
      g.drawImage(m, -l.x, -l.y);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      l._styled = null;
      E.commit('페인트 통', before);
    },
  },
  {
    id: 'gradient', name: '그레이디언트', key: 'G', icon: 'gradient', group: 'fill', cursor: 'crosshair',
    options: [['type', '종류', 'select', null, null, 'linear', [['linear', '선형'], ['radial', '방사형'], ['reflected', '반사']]], ['to', '끝 색', 'select', null, null, 'bg', [['bg', '전경색 → 배경색'], ['clear', '전경색 → 투명']]], ['opacity', '불투명도', 'range', 1, 100, 100, '%']],
    down(E, p) {
      if (!needRaster(E, '그레이디언트')) return;
      const l = E.doc.active;
      this.d = { a: p, b: p, before: E.doc.capture() };
      const mt = E.maskTarget?.();
      if (mt) {
        this.d.mt = mt;
        this.d.base = mt.canvas;
        this.d.mg = mt.edit();
        return;
      }
      E.doc.editPixels(l);
      this.d.base = cloneCanvas(l.canvas);
    },
    move(E, p) {
      if (!this.d) return;
      this.d.b = p;
      this.paint(E);
    },
    up(E) {
      if (!this.d) return;
      if (dist(this.d.a, this.d.b) > 1) {
        this.d.final = true;
        this.paint(E);
        E.commit('그레이디언트', this.d.before);
      } else E.doc.restore(this.d.before);
      this.d = null;
      E.redraw();
    },
    paint(E) {
      const { a, b, base } = this.d;
      const doc = E.doc;
      const l = doc.active;
      const o = E.opts('gradient');
      // presets, five styles, reverse and dither come from paint2.js
      const gc = E.gradientCanvas ? E.gradientCanvas(a, b, { ...o, final: !!this.d.final }) : makeCanvas(doc.width, doc.height);
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
        gg.drawImage(doc.selection.canvas, 0, 0);
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
      const g = l.canvas.getContext('2d');
      g.save();
      g.globalCompositeOperation = 'copy';
      g.drawImage(base, 0, 0);
      g.globalCompositeOperation = l.lockAlpha ? 'source-atop' : 'source-over';
      g.globalAlpha = (o.opacity ?? 100) / 100;
      g.drawImage(gc, -l.x, -l.y);
      g.restore();
      l._styled = null;
      doc.touch(l);
      E.redraw();
    },
    overlay(E, g) {
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
  retouchTool('blur', '흐림 효과 브러시', null, 'drop', 'blur'),
  retouchTool('sharpen', '선명 효과 브러시', null, 'sharpenTool', 'sharpen'),
  retouchTool('smudge', '손가락 (문지르기)', null, 'smudge', 'smudge'),
  retouchTool('push', '픽셀 유동화 (밀기)', null, 'push', 'push'),
  retouchTool('dodge', '닷지 (밝게)', 'O', 'dodge', 'dodge'),
  retouchTool('burn', '번 (어둡게)', 'O', 'burn', 'burn'),
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
  },
  {
    id: 'zoom', name: '돋보기', key: 'Z', icon: 'zoomIn', group: 'view', cursor: 'zoom-in',
    options: [],
    down(E, p, e) {
      E.zoomAt(e.altKey ? 1 / 1.5 : 1.5, e.clientX, e.clientY);
    },
  },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/** Toolbar groups (like Photoshop's tool slots), in order. */
export const TOOL_GROUPS = [
  ['move'], ['rect', 'ellipse'], ['lasso'], ['wand'], ['crop', 'perspCrop'], ['eyedropper'], ['heal'], ['brush', 'pencil'], ['clone'], ['eraser'],
  ['gradient', 'bucket'], ['blur', 'sharpen', 'smudge', 'push'], ['dodge', 'burn'], ['text', 'verticalText', 'textMask', 'verticalTextMask'], ['shape'], ['hand'], ['zoom'],
];

const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;

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

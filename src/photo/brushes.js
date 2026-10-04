// Brush engine and retouching tools: brush tips (shapes, custom tips from the picture), dynamics
// (scatter, jitter, colour), smoothing, brush presets and settings; healing brush, patch, content-aware
// move, remove tool, spot healing's content-aware mode and Edit ▸ Content-Aware Fill; mixer brush,
// history brush, background / magic eraser, colour replacement, red eye; ruler, notes, count and
// colour samplers.

import { h, clamp } from '../util.js';
import { toast, promptDialog, openModal, formRow, loadPref, savePref } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, Stroke, brushOpts, needRaster, liftSelection, selMode, rgbHex } from './tools.js';
import * as SEL from './selection.js';
import { inpaint, healBlend } from './inpaint.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hexRgb = (hex) => {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const falloff = (d, r, hd) => (d >= r ? 0 : d <= r * hd ? 1 : 1 - (d - r * hd) / Math.max(1e-6, r * (1 - hd)));

// ---------------------------------------------------------------- colour helpers

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh / 6, s, l];
}

function hslToRgb(hh, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

// ---------------------------------------------------------------- brush tips

/** Tip choices for the options bar; custom tips (Edit ▸ Define Brush) are added at the end. */
export const TIP_LIST = [['round', '둥근'], ['square', '사각'], ['chalk', '분필'], ['spray', '스프레이'], ['bristle', '붓털'], ['star', '별'], ['leaf', '나뭇잎'], ['grass', '풀'], ['dots', '점 무리']];
const customTips = new Map();
const tipCache = new Map();

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The tip's shape at s×s pixels: white, alpha = paint amount. */
function tipMask(tip, s, hard) {
  const key = `${tip}|${s}|${Math.round(hard * 20)}`;
  let c = tipCache.get(key);
  if (c) return c;
  c = makeCanvas(s, s);
  const g = c.getContext('2d');
  const R = s / 2;
  const rnd = seeded(s * 31 + tip.length);
  const soft = Math.max(0, (1 - hard) * s * 0.12);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  if (soft > 0.3 && !['round', 'chalk', 'spray'].includes(tip)) g.filter = `blur(${soft}px)`;
  const pad = soft * 2;
  switch (tip) {
    case 'square':
      g.fillRect(pad + s * 0.08, pad + s * 0.08, s - 2 * pad - s * 0.16, s - 2 * pad - s * 0.16);
      break;
    case 'chalk': {
      const img = g.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const d = Math.hypot(x + 0.5 - R, y + 0.5 - R);
          const f = falloff(d, R, Math.max(0.3, hard));
          if (!f || rnd() > 0.62) continue;
          const o = (y * s + x) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
          img.data[o + 3] = 255 * f * (0.35 + 0.65 * rnd());
        }
      }
      g.putImageData(img, 0, 0);
      break;
    }
    case 'spray': {
      const n = clamp(Math.round(s * 1.6), 16, 500);
      const dot = Math.max(0.6, s / 45);
      for (let i = 0; i < n; i++) {
        // gaussian spread around the centre
        const a = rnd() * Math.PI * 2;
        const rr = Math.min(R - dot, Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)) * R * 0.38);
        g.globalAlpha = 0.4 + 0.6 * rnd();
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, dot, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'bristle': {
      const n = clamp(Math.round(s / 2), 8, 60);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * R * 0.8;
        g.globalAlpha = 0.25 + 0.6 * rnd();
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, Math.max(0.6, s / 14 * (0.5 + rnd())), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = (i % 2 ? 0.4 : 1) * (R - pad);
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        g.lineTo(R + Math.cos(a) * rr, R + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      break;
    }
    case 'leaf': {
      const t = pad + s * 0.04;
      g.beginPath();
      g.moveTo(R, t);
      g.quadraticCurveTo(s - t, R * 0.9, R, s - t);
      g.quadraticCurveTo(t, R * 0.9, R, t);
      g.fill();
      break;
    }
    case 'grass': {
      g.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const x = s * (0.2 + 0.6 * rnd());
        const top = s * (0.05 + 0.45 * rnd());
        g.lineWidth = Math.max(0.8, s / 22);
        g.beginPath();
        g.moveTo(x, s - pad);
        g.quadraticCurveTo(x + (rnd() - 0.5) * s * 0.2, (s + top) / 2, x + (rnd() - 0.5) * s * 0.45, top + pad);
        g.stroke();
      }
      break;
    }
    case 'dots': {
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd();
        const rr = i ? R * 0.55 : 0;
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, Math.max(0.7, s * (0.08 + 0.06 * rnd()) - pad / 3), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    default: {
      const ct = customTips.get(tip);
      if (ct) {
        const k = Math.min(s / ct.width, s / ct.height);
        g.drawImage(ct, (s - ct.width * k) / 2, (s - ct.height * k) / 2, ct.width * k, ct.height * k);
        break;
      }
      const grad = g.createRadialGradient(R, R, 0, R, R, R);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(Math.min(0.99, Math.max(0, hard)), '#fff');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  }
  if (tipCache.size > 80) tipCache.clear();
  tipCache.set(key, c);
  return c;
}

let tintCanvas = null;
/** The tip in one colour (a shared scratch canvas, drawn right away by the caller). */
function tinted(tip, s, hard, color) {
  const m = tipMask(tip, s, hard);
  if (!tintCanvas || tintCanvas.width < s || tintCanvas.height < s) tintCanvas = makeCanvas(Math.max(s, 64), Math.max(s, 64));
  const g = tintCanvas.getContext('2d');
  g.globalCompositeOperation = 'copy';
  g.drawImage(m, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
  return tintCanvas;
}

// ---------------------------------------------------------------- dynamics

/** Brush settings kept with each painting tool's options (percentages unless noted). */
const DYN = {
  spacing: 15, angle: 0, roundness: 100, followDir: false, scatter: 0, count: 1,
  sizeJitter: 0, angleJitter: 0, roundJitter: 0, opacityJitter: 0,
  fgbgJitter: 0, hueJitter: 0, satJitter: 0, briJitter: 0, smoothing: 10, pressureOpacity: false,
};
const dyn = (o) => Object.fromEntries(Object.entries(DYN).map(([k, v]) => [k, o[k] ?? v]));

const PRESETS = [
  ['단단한 둥근', { tip: 'round', hardness: 100, spacing: 10 }],
  ['부드러운 둥근', { tip: 'round', hardness: 0, spacing: 10 }],
  ['에어브러시', { tip: 'round', hardness: 0, spacing: 4, flow: 15 }],
  ['서예 펜', { tip: 'round', hardness: 95, spacing: 4, roundness: 22, angle: 40 }],
  ['분필', { tip: 'chalk', hardness: 80, spacing: 18, angleJitter: 100, sizeJitter: 12 }],
  ['스프레이', { tip: 'spray', hardness: 100, spacing: 30, angleJitter: 100 }],
  ['수채 붓털', { tip: 'bristle', hardness: 60, spacing: 6, opacityJitter: 30, followDir: true }],
  ['나뭇잎 흩뿌리기', { tip: 'leaf', hardness: 90, spacing: 60, scatter: 150, count: 2, sizeJitter: 60, angleJitter: 100, fgbgJitter: 60, hueJitter: 6 }],
  ['풀', { tip: 'grass', hardness: 90, spacing: 35, scatter: 60, sizeJitter: 50, angleJitter: 6, fgbgJitter: 50 }],
  ['별 흩뿌리기', { tip: 'star', hardness: 90, spacing: 90, scatter: 200, count: 2, sizeJitter: 70, angleJitter: 100, hueJitter: 30 }],
  ['점 무리', { tip: 'dots', hardness: 90, spacing: 50, scatter: 100, sizeJitter: 40, angleJitter: 100 }],
];

function dabColor(D, fg, bg, rnd) {
  if (!D.fgbgJitter && !D.hueJitter && !D.satJitter && !D.briJitter) return fg;
  let [r, g, b] = hexRgb(fg);
  if (D.fgbgJitter) {
    const [r2, g2, b2] = hexRgb(bg);
    const t = rnd() * (D.fgbgJitter / 100);
    r += (r2 - r) * t;
    g += (g2 - g) * t;
    b += (b2 - b) * t;
  }
  let [hh, s, l] = rgbToHsl(r, g, b);
  hh += (rnd() * 2 - 1) * (D.hueJitter / 100) * 0.5;
  s = clamp(s + (rnd() * 2 - 1) * (D.satJitter / 100), 0, 1);
  l = clamp(l + (rnd() * 2 - 1) * (D.briJitter / 100) * 0.5, 0, 1);
  return rgbHex(...hslToRgb(hh, s, l));
}

/** A dab painter for Stroke (see tools.js): draws one or more tips and returns the changed rect. */
function makeEngine(o, bo, fg, bg) {
  const D = dyn(o);
  const tip = o.tip || 'round';
  const rnd = Math.random;
  return (st, lx, ly, size) => {
    const g = st.bg;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const n = clamp(Math.round(D.count), 1, 16);
    for (let k = 0; k < n; k++) {
      const s = Math.max(1, Math.ceil(size * (1 - (D.sizeJitter / 100) * rnd())));
      const ang = (D.angle * Math.PI) / 180 + (D.followDir ? st.dir || 0 : 0) + (rnd() * 2 - 1) * Math.PI * (D.angleJitter / 100);
      const round = Math.max(0.05, (D.roundness / 100) * (1 - (D.roundJitter / 100) * rnd() * 0.9));
      let x = lx;
      let y = ly;
      if (D.scatter) {
        const sc = (size * D.scatter) / 100 / 2;
        x += (rnd() * 2 - 1) * sc;
        y += (rnd() * 2 - 1) * sc;
      }
      let a = (bo.flow ?? 1) * (1 - (D.opacityJitter / 100) * rnd()) * (D.pressureOpacity ? Math.max(0.05, st.pressure ?? 1) : 1);
      let col = st.mode === 'paint' && !st.onMask ? dabColor(D, fg, bg, rnd) : '#000000';
      if (bo.mixer) {
        const m = bo.mixer(st, x, y, s);
        col = m.color;
        a *= m.alpha;
      }
      if (a <= 0.002) continue;
      g.save();
      g.globalAlpha = Math.min(1, a);
      g.translate(x, y);
      if (ang) g.rotate(ang);
      if (round < 1) g.scale(1, round);
      g.drawImage(tinted(tip, s, bo.hardness ?? 0.7, col), 0, 0, s, s, -s / 2, -s / 2, s, s);
      g.restore();
      const R = s * 0.72 + 2;
      x0 = Math.min(x0, x - R);
      y0 = Math.min(y0, y - R);
      x1 = Math.max(x1, x + R);
      y1 = Math.max(y1, y + R);
    }
    if (x1 < x0) return null;
    return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0) + 1, h: Math.ceil(y1 - y0) + 1 };
  };
}

const isPlain = (o) => {
  const D = dyn(o);
  return (o.tip || 'round') === 'round' && !D.angle && D.roundness >= 100 && !D.scatter && D.count <= 1 && !D.sizeJitter && !D.angleJitter && !D.roundJitter && !D.opacityJitter && !D.fgbgJitter && !D.hueJitter && !D.satJitter && !D.briJitter && !D.pressureOpacity;
};

// ---------------------------------------------------------------- pixel helpers

function bboxOf(a, w, hh, min = 1) {
  let x0 = w;
  let y0 = hh;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] < min) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const alphaOf = (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
};

/** Grow a 0/1 mask by r pixels (square). */
function dilate(m, w, hh, r) {
  if (r <= 0) return m;
  const t = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0, run = -1e9; x < w; x++) {
      if (m[y * w + x]) run = x;
      if (x - run <= r) t[y * w + x] = 1;
    }
    for (let x = w - 1, run = 1e9; x >= 0; x--) {
      if (m[y * w + x]) run = x;
      if (run - x <= r) t[y * w + x] = 1;
    }
  }
  const o = new Uint8Array(w * hh);
  for (let x = 0; x < w; x++) {
    for (let y = 0, run = -1e9; y < hh; y++) {
      if (t[y * w + x]) run = y;
      if (y - run <= r) o[y * w + x] = 1;
    }
    for (let y = hh - 1, run = 1e9; y >= 0; y--) {
      if (t[y * w + x]) run = y;
      if (run - y <= r) o[y * w + x] = 1;
    }
  }
  return o;
}

/**
 * Content-aware fill on a canvas context: rebuild the pixels where hole[i] is set (canvas size)
 * from the rest of the picture. amt (0..255, optional) softens the result into the original.
 */
function contentFillCtx(g, hole, amt = null) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const b = bboxOf(hole, W, H);
  if (!b) return false;
  const m = clamp(Math.round(Math.max(b.w, b.h) * 0.9), 24, 360);
  const x0 = Math.max(0, b.x - m);
  const y0 = Math.max(0, b.y - m);
  const cw = Math.min(W, b.x + b.w + m) - x0;
  const ch = Math.min(H, b.y + b.h + m) - y0;
  const img = g.getImageData(x0, y0, cw, ch);
  const d = img.data;
  const hc = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) hc[y * cw + x] = hole[(y + y0) * W + x + x0];
  // on a picture with empty margins, copy only from painted pixels
  let op = 0;
  let tot = 0;
  for (let i = 0; i < cw * ch; i++) {
    if (hc[i]) continue;
    tot++;
    if (d[i * 4 + 3] > 200) op++;
  }
  let avoid = null;
  if (op > tot * 0.5 && op < tot) {
    avoid = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) if (d[i * 4 + 3] <= 200) avoid[i] = 1;
  }
  const orig = amt ? new Uint8ClampedArray(d) : null;
  inpaint(d, cw, ch, hc, { avoid });
  if (amt) {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        if (!hc[i]) continue;
        const a = amt[(y + y0) * W + x + x0] / 255;
        for (let c = 0; c < 4; c++) d[i * 4 + c] = orig[i * 4 + c] + (d[i * 4 + c] - orig[i * 4 + c]) * a;
      }
    }
  }
  g.putImageData(img, x0, y0);
  return true;
}

/**
 * Paste `paste` into the context where `region` has alpha, over `base` (all canvases of the
 * context's size). adapt: shift the pasted colours so the edge disappears (healing).
 */
function healPaste(g, base, paste, region, { adapt = true, opacity = 1 } = {}) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const ra = alphaOf(region);
  const b0 = bboxOf(ra, W, H);
  if (!b0) return false;
  const x = Math.max(0, b0.x - 2);
  const y = Math.max(0, b0.y - 2);
  const w = Math.min(W, b0.x + b0.w + 2) - x;
  const hh = Math.min(H, b0.y + b0.h + 2) - y;
  const dst = base.getContext('2d').getImageData(x, y, w, hh).data;
  const src = paste.getContext('2d').getImageData(x, y, w, hh).data;
  const amt = new Uint8Array(w * hh);
  for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) amt[yy * w + xx] = ra[(yy + y) * W + xx + x];
  let out;
  if (adapt) out = healBlend(w, hh, dst, src, amt, opacity);
  else {
    out = new Uint8ClampedArray(dst);
    for (let i = 0; i < w * hh; i++) {
      const a = (amt[i] / 255) * opacity;
      if (a) for (let c = 0; c < 4; c++) out[i * 4 + c] = dst[i * 4 + c] + (src[i * 4 + c] - dst[i * 4 + c]) * a;
    }
  }
  g.putImageData(new ImageData(out, w, hh), x, y);
  return true;
}

const shifted = (c, dx, dy, w = c.width, hh = c.height) => {
  const t = makeCanvas(w, hh);
  t.getContext('2d').drawImage(c, dx, dy);
  return t;
};

// ---------------------------------------------------------------- per-pixel brushes

/** A brush that changes pixels directly under it (background eraser, colour replacement). */
class PixelBrush {
  constructor(E, o, fx) {
    this.E = E;
    this.o = o;
    this.fx = fx;
    this.layer = E.doc.active;
    this.before = E.doc.capture();
    this.g = E.doc.editPixels(this.layer, { x: 0, y: 0, w: E.doc.width, h: E.doc.height });
    this.last = null;
  }

  to(p) {
    if (!this.last) {
      this.apply(p);
      this.last = p;
    } else {
      const step = Math.max(1, this.o.size * 0.25);
      const d = dist(this.last, p);
      const n = Math.floor(d / step);
      for (let i = 1; i <= n; i++) this.apply({ x: this.last.x + ((p.x - this.last.x) * i * step) / d, y: this.last.y + ((p.y - this.last.y) * i * step) / d });
      if (n) this.last = { x: this.last.x + ((p.x - this.last.x) * n * step) / d, y: this.last.y + ((p.y - this.last.y) * n * step) / d };
    }
    this.layer._styled = null;
    this.E.doc.touch(this.layer);
    this.E.redraw();
  }

  apply(p) {
    const g = this.g;
    const r = this.o.size / 2;
    const cx = p.x - this.layer.x;
    const cy = p.y - this.layer.y;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const w = Math.min(g.canvas.width, Math.ceil(cx + r)) - x0;
    const hh = Math.min(g.canvas.height, Math.ceil(cy + r)) - y0;
    if (w <= 0 || hh <= 0) return;
    const img = g.getImageData(x0, y0, w, hh);
    const sel = this.E.doc.selection ? this.E.selAlpha(x0 + this.layer.x, y0 + this.layer.y, w, hh) : null;
    // weight per pixel: brush falloff × selection
    const wt = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        let v = falloff(Math.hypot(x0 + x + 0.5 - cx, y0 + y + 0.5 - cy), r, this.o.hardness);
        if (sel) v *= sel[y * w + x] / 255;
        wt[y * w + x] = v;
      }
    }
    if (this.fx({ d: img.data, w, h: hh, wt, cx: Math.round(cx - x0), cy: Math.round(cy - y0) }, this) !== false) g.putImageData(img, x0, y0);
  }

  end() {
    this.E.commit(this.o.label, this.before);
  }
}

/** Pixels of the dab that match `ref` within tolerance t (optionally only those joined to the centre). */
function matchMask(c, ref, t, contiguous, protect = null) {
  const { d, w, h: hh, wt } = c;
  const m = new Uint8Array(w * hh);
  const ok = (i) => {
    if (!wt[i] || d[i * 4 + 3] === 0) return false;
    const o = i * 4;
    if (Math.max(Math.abs(d[o] - ref[0]), Math.abs(d[o + 1] - ref[1]), Math.abs(d[o + 2] - ref[2])) > t) return false;
    if (protect && Math.max(Math.abs(d[o] - protect[0]), Math.abs(d[o + 1] - protect[1]), Math.abs(d[o + 2] - protect[2])) <= t) return false;
    return true;
  };
  if (!contiguous) {
    for (let i = 0; i < w * hh; i++) if (ok(i)) m[i] = 1;
    return m;
  }
  const start = clamp(c.cy, 0, hh - 1) * w + clamp(c.cx, 0, w - 1);
  if (!ok(start)) return m;
  const st = [start];
  m[start] = 1;
  while (st.length) {
    const i = st.pop();
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * hh || m[j] || !ok(j)) continue;
      m[j] = 1;
      st.push(j);
    }
  }
  return m;
}

function sampleRef(E, c, br) {
  const o = br.o;
  if (o.sampling === 'bg') return hexRgb(E.bg);
  if (o.sampling === 'once' && br.ref) return br.ref;
  const i = (clamp(c.cy, 0, c.h - 1) * c.w + clamp(c.cx, 0, c.w - 1)) * 4;
  if (c.d[i + 3] === 0) return br.ref || null;
  const ref = [c.d[i], c.d[i + 1], c.d[i + 2]];
  if (o.sampling === 'once') br.ref = ref;
  return ref;
}

const SAMPLING = ['sampling', '샘플링', 'select', null, null, 'continuous', [['continuous', '계속 (붓 아래 색)'], ['once', '한 번 (처음 누른 색)'], ['bg', '배경색']]];
const LIMITS = ['contiguous', '인접한 부분만', 'bool', null, null, true];

// ---------------------------------------------------------------- install

export function installBrushTools(P) {
  const C = P.cmd;
  const allDoc = () => ({ x: 0, y: 0, w: P.doc.width, h: P.doc.height });

  // ---- the engine for strokes (tools.js asks for it when a stroke starts)
  P.brushEngine = (id, o, bo, mode) => {
    if (mode === 'clone' || id === 'pencil') return null;
    const D = dyn(o);
    bo.spacing = Math.max(0.01, D.spacing / 100);
    bo.smoothing = D.smoothing / 100;
    if (isPlain(o) && !bo.mixer) return null;
    return makeEngine(o, bo, P.fg, P.bg);
  };

  // ---- custom tips saved in this browser
  const savedTips = loadPref('photo.brushTips', []);
  const addTip = (t) => {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      customTips.set(t.id, c);
      tipCache.clear();
    };
    img.src = t.data;
    if (!TIP_LIST.some((x) => x[0] === t.id)) TIP_LIST.push([t.id, t.name]);
  };
  savedTips.forEach(addTip);

  const TIP_OPT = ['tip', '모양', 'select', null, null, 'round', TIP_LIST];
  const BRUSH = [['size', '크기', 'range', 1, 500, 30], ['hardness', '경도', 'range', 0, 100, 70, '%'], TIP_OPT, ['opacity', '불투명도', 'range', 1, 100, 100, '%'], ['flow', '흐름', 'range', 1, 100, 100, '%'], ['pressureSize', '펜 압력 → 크기', 'bool', null, null, true]];
  const settingsBtn = (id) => h('button.small', { onclick: () => brushSettings(P, id), title: '모양·간격·흩뿌리기·색 변화·보정' }, '브러시 설정…');
  for (const id of ['brush', 'eraser']) {
    const t = TOOL_BY_ID[id];
    t.options = id === 'brush' ? BRUSH : BRUSH.slice(0, 5);
    t.optionButtons = () => [settingsBtn(id)];
  }

  // ---- spot healing: content-aware by default
  const heal = TOOL_BY_ID.heal;
  heal.options = [...heal.options, ['type', '유형', 'select', null, null, 'content', [['content', '내용 인식'], ['proximity', '근접 일치 (주변 색 번짐)']]]];
  P.healFill = (st) => {
    const kind = st.o.healKind || (P.tool === 'heal' && P.opts('heal').type !== 'proximity' ? 'content' : null);
    if (!kind || st.onMask) return false;
    const g = st.g;
    const W = g.canvas.width;
    const H = g.canvas.height;
    g.save();
    g.globalCompositeOperation = 'copy';
    g.drawImage(st.base, 0, 0);
    g.restore();
    const a = alphaOf(st.buf);
    let hole = new Uint8Array(W * H);
    for (let i = 0; i < a.length; i++) if (a[i] > 20) hole[i] = 1;
    hole = dilate(hole, W, H, kind === 'remove' ? 3 : 2);
    contentFillCtx(g, hole);
    st.layer._styled = null;
    P.doc.touch(st.layer);
    P.redraw();
    return true;
  };

  // ---- shared shape for stroke-based tools
  const strokeLike = (def) => ({
    group: 'retouch', cursor: 'brush', ...def,
    down(E, p, e) {
      if (this.pre?.(E, p, e) === false) return;
      if (!needRaster(E, def.name)) return;
      const o = E.opts(def.id);
      const bo = brushOpts(o, E, { label: def.name });
      if (this.prepare?.(E, p, e, o, bo) === false) return;
      if (def.engine !== false && def.mode !== 'clone') bo.engine = P.brushEngine(def.id, o, bo, def.mode);
      this.st = new Stroke(E, def.mode, bo);
      this.st.to(p, e.pressure || 1);
      this.st.flush();
    },
    move(E, p, e) {
      this.st?.to(p, e.pointerType === 'pen' ? e.pressure : 1);
    },
    up() {
      this.st?.end();
      this.st = null;
    },
    cancel(E) {
      if (!this.st) return;
      E.doc.restore(this.st.before);
      this.st = null;
      E.redraw();
    },
  });
  const crossAt = (E, g, q) => {
    const [x, y] = E.toScreen(q.x, q.y);
    g.save();
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    for (const [c, lw] of [['#000', 3], ['#fff', 1]]) {
      g.strokeStyle = c;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x - 8, y);
      g.lineTo(x + 8, y);
      g.moveTo(x, y - 8);
      g.lineTo(x, y + 8);
      g.stroke();
    }
    g.restore();
  };

  // ---- healing brush: clone from a source, then blend the colours into the surroundings
  const healBrush = strokeLike({
    id: 'healBrush', name: '복구 브러시', key: 'J', icon: 'healBrush', mode: 'clone',
    options: [['size', '크기', 'range', 1, 500, 40], ['hardness', '경도', 'range', 0, 100, 80, '%'], ['aligned', '정렬 (끊어 칠해도 같은 간격)', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false]],
    pre(E, p, e) {
      if (e.altKey || this.pickNext) {
        this.pickNext = false;
        this.source = p;
        this.offset = null;
        toast('복구 원본을 정했습니다. 이제 고칠 곳을 칠하세요.');
        E.overlay();
        return false;
      }
      if (!this.source) {
        toast('먼저 Alt(휴대폰은 "원본 정하기" 버튼)를 누른 채 깨끗한 곳을 누르세요');
        return false;
      }
      return true;
    },
    prepare(E, p, e, o, bo) {
      if (!this.offset || !o.aligned) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
      bo.cloneOffset = this.offset;
      bo.sampleAll = o.sampleAll;
      bo.opacity = 1;
      bo.afterStroke = (st) => {
        const g = st.g;
        const region = st.buf;
        const paste = shifted(st.src, -(st.ox + this.offset.x), -(st.oy + this.offset.y), g.canvas.width, g.canvas.height);
        healPaste(g, st.base, paste, region);
        st.layer._styled = null;
        P.doc.touch(st.layer);
      };
      return !(E.maskTarget?.());
    },
    overlay(E, g) {
      if (this.source) crossAt(E, g, this.source);
    },
    optionButtons() {
      return [h('button.small', { onclick: () => { this.pickNext = true; toast('복구 원본으로 쓸 깨끗한 곳을 누르세요'); } }, '원본 정하기')];
    },
  });

  // ---- remove tool: paint over something, it is replaced by its surroundings
  const remove = strokeLike({
    id: 'remove', name: '제거 도구', key: 'J', icon: 'removeTool', mode: 'heal', engine: false,
    options: [['size', '크기', 'range', 1, 500, 50]],
    prepare(E, p, e, o, bo) {
      bo.hardness = 0.9;
      bo.healKind = 'remove';
    },
  });

  // ---- mixer brush: picks up and mixes with the paint already on the canvas
  const mixer = strokeLike({
    id: 'mixer', name: '혼합 브러시', key: 'B', icon: 'mixer', group: 'paint', mode: 'paint',
    options: [['size', '크기', 'range', 1, 500, 40], ['hardness', '경도', 'range', 0, 100, 60, '%'], TIP_OPT, ['wet', '젖음', 'range', 0, 100, 50, '%'], ['load', '물감 양', 'range', 1, 100, 50, '%'], ['mix', '섞기', 'range', 0, 100, 50, '%'], ['flow', '흐름', 'range', 1, 100, 100, '%'], ['clean', '획마다 붓 씻기', 'bool', null, null, true]],
    prepare(E, p, e, o, bo) {
      if (E.maskTarget?.()) {
        toast('혼합 브러시는 레이어 내용에만 칠합니다');
        return false;
      }
      if (o.clean || !this.res) this.res = { c: hexRgb(E.fg).map(Number), amt: 1 };
      const res = this.res;
      const tmp = makeCanvas(4, 4);
      const tg = tmp.getContext('2d', { willReadFrequently: true });
      const wet = o.wet / 100;
      const mixK = o.mix / 100;
      const load = o.load / 100;
      bo.mixer = (st, x, y, s) => {
        tg.clearRect(0, 0, 4, 4);
        tg.drawImage(st.g.canvas, x - s / 2, y - s / 2, s, s, 0, 0, 4, 4);
        const d = tg.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let g2 = 0;
        let b = 0;
        let a = 0;
        for (let i = 0; i < 64; i += 4) {
          r += d[i] * d[i + 3];
          g2 += d[i + 1] * d[i + 3];
          b += d[i + 2] * d[i + 3];
          a += d[i + 3];
        }
        let col = res.c;
        if (a > 0) {
          const cv = [r / a, g2 / a, b / a];
          const pick = wet * Math.min(1, a / 16 / 255);
          col = res.c.map((v, k) => v + (cv[k] - v) * mixK * pick);
          // the brush gets dirty with what it touches
          res.c = res.c.map((v, k) => v + (cv[k] - v) * pick * 0.12);
        }
        const alpha = mixK >= 1 ? 1 : res.amt;
        res.amt = Math.max(0, res.amt * (1 - (1 - load) * 0.04));
        return { color: rgbHex(...col), alpha };
      };
    },
  });

  // ---- history brush: paints back a state from the History panel
  P.historySourceState = () => {
    const doc = P.doc;
    const hist = doc.history;
    const src = doc._histSrc;
    const first = hist.undoStack[0]?.state || doc.capture();
    if (!src) return first;
    const i = hist.undoStack.indexOf(src);
    if (i < 0) {
      doc._histSrc = null;
      return first;
    }
    return hist.undoStack[i + 1]?.state || doc.capture();
  };
  const historyBrush = strokeLike({
    id: 'historyBrush', name: '작업 내역 브러시', key: 'Y', icon: 'historyBrush', group: 'paint', mode: 'clone',
    options: BRUSH.filter((o) => o[0] !== 'tip'),
    prepare(E, p, e, o, bo) {
      if (E.maskTarget?.()) {
        toast('작업 내역 브러시는 레이어 내용에만 칠합니다');
        return false;
      }
      const l = E.doc.active;
      const sl = P.historySourceState().layers.find((x) => x.id === l.id);
      if (!sl?.canvas) {
        toast('작업 내역에서 고른 시점에 이 레이어가 없었습니다. 작업 내역 패널에서 붓 표시를 다른 단계로 옮기세요.');
        return false;
      }
      const src = makeCanvas(E.doc.width, E.doc.height);
      src.getContext('2d').drawImage(sl.canvas, sl.x, sl.y);
      bo.srcCanvas = src;
      bo.cloneOffset = { x: 0, y: 0 };
      bo.afterStroke = null;
      return true;
    },
    optionButtons() {
      return [h('button.small', { onclick: () => P.showPanel('history') }, '작업 내역 패널')];
    },
  });

  // ---- per-pixel tools
  const pixelTool = (def) => ({
    group: 'paint', cursor: 'brush', ...def,
    down(E, p) {
      if (E.maskTarget?.()) {
        toast(`${def.name}는 레이어 내용에만 씁니다`);
        return;
      }
      if (!needRaster(E, def.name)) return;
      const o = { ...E.opts(def.id), label: def.name };
      o.hardness = (o.hardness ?? 70) / 100;
      this.br = new PixelBrush(E, o, (c, br) => def.fx(E, c, br));
      this.br.to(p);
    },
    move(E, p) {
      this.br?.to(p);
    },
    up() {
      this.br?.end();
      this.br = null;
    },
    cancel(E) {
      if (!this.br) return;
      E.doc.restore(this.br.before);
      this.br = null;
      E.redraw();
    },
  });

  const bgEraser = pixelTool({
    id: 'bgEraser', name: '배경 지우개', key: 'E', icon: 'bgEraser',
    options: [['size', '크기', 'range', 1, 500, 60], ['hardness', '경도', 'range', 0, 100, 80, '%'], ['tolerance', '허용치', 'range', 1, 100, 25, '%'], SAMPLING, LIMITS, ['protect', '전경색 보호', 'bool', null, null, false]],
    fx(E, c, br) {
      const ref = sampleRef(E, c, br);
      if (!ref) return false;
      const t = br.o.tolerance * 2.55;
      const m = matchMask(c, ref, t, br.o.contiguous, br.o.protect ? hexRgb(E.fg) : null);
      for (let i = 0; i < m.length; i++) if (m[i]) c.d[i * 4 + 3] *= 1 - c.wt[i];
      return true;
    },
  });

  const colorReplace = pixelTool({
    id: 'colorReplace', name: '색상 대체', key: 'B', icon: 'colorReplace',
    options: [['size', '크기', 'range', 1, 500, 40], ['hardness', '경도', 'range', 0, 100, 70, '%'], ['mode', '모드', 'select', null, null, 'color', [['color', '색상 (밝기 유지)'], ['hue', '색조'], ['saturation', '채도'], ['luminosity', '광도']]], ['tolerance', '허용치', 'range', 1, 100, 30, '%'], SAMPLING, LIMITS],
    fx(E, c, br) {
      const ref = sampleRef(E, c, br);
      if (!ref) return false;
      const t = br.o.tolerance * 2.55;
      const m = matchMask(c, ref, t, br.o.contiguous);
      const [fh, fs, fl] = rgbToHsl(...hexRgb(E.fg));
      const mode = br.o.mode;
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        const o = i * 4;
        let [hh, s, l] = rgbToHsl(c.d[o], c.d[o + 1], c.d[o + 2]);
        if (mode === 'color' || mode === 'hue') hh = fh;
        if (mode === 'color' || mode === 'saturation') s = fs;
        if (mode === 'luminosity') l = fl;
        const [r, g, b] = hslToRgb(hh, s, l);
        const k = c.wt[i];
        c.d[o] += (r - c.d[o]) * k;
        c.d[o + 1] += (g - c.d[o + 1]) * k;
        c.d[o + 2] += (b - c.d[o + 2]) * k;
      }
      return true;
    },
  });

  const magicEraser = {
    id: 'magicEraser', name: '자동 지우개', key: 'E', icon: 'magicEraser', group: 'paint', cursor: 'crosshair',
    options: [['tolerance', '허용치', 'range', 0, 255, 32], ['contiguous', '인접', 'bool', null, null, true], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false], ['opacity', '불투명도', 'range', 1, 100, 100, '%']],
    down(E, p) {
      if (E.maskTarget?.()) return toast('자동 지우개는 레이어 내용에만 씁니다');
      if (!needRaster(E, '자동 지우개')) return undefined;
      const doc = E.doc;
      const l = doc.active;
      const o = E.opts('magicEraser');
      const src = o.sampleAll ? E.composite() : E.layerAsDocCanvas(l);
      const m = SEL.magicWand(doc, src, p.x, p.y, { tolerance: o.tolerance, contiguous: o.contiguous });
      if (!m) return undefined;
      const before = doc.capture();
      if (doc.selection) {
        const mg = m.getContext('2d');
        mg.globalCompositeOperation = 'destination-in';
        mg.drawImage(doc.selection.canvas, 0, 0);
      }
      const g = doc.editPixels(l);
      g.save();
      g.globalAlpha = o.opacity / 100;
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(m, -l.x, -l.y);
      g.restore();
      l._styled = null;
      E.commit('자동 지우개', before);
      return undefined;
    },
  };

  // ---- red eye
  const redEye = {
    id: 'redEye', name: '적목 현상 도구', key: 'J', icon: 'redEye', group: 'retouch', cursor: 'crosshair',
    options: [['size', '찾을 크기 (누를 때)', 'range', 8, 400, 60], ['darken', '어둡게', 'range', 1, 100, 50, '%']],
    down(E, p) {
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
      if (!d || !needRaster(E, '적목 현상 도구')) return;
      const o = E.opts('redEye');
      let r = { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) };
      if (r.w < 6 || r.h < 6) r = { x: d.a.x - o.size / 2, y: d.a.y - o.size / 2, w: o.size, h: o.size };
      const doc = E.doc;
      const l = doc.active;
      const before = doc.capture();
      const g = doc.editPixels(l, r);
      const x0 = Math.max(0, Math.floor(r.x - l.x));
      const y0 = Math.max(0, Math.floor(r.y - l.y));
      const w = Math.min(g.canvas.width, Math.ceil(r.x + r.w - l.x)) - x0;
      const hh = Math.min(g.canvas.height, Math.ceil(r.y + r.h - l.y)) - y0;
      if (w <= 0 || hh <= 0) return;
      const img = g.getImageData(x0, y0, w, hh);
      const dd = img.data;
      const sel = doc.selection ? E.selAlpha(x0 + l.x, y0 + l.y, w, hh) : null;
      const dk = o.darken / 100;
      let n = 0;
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < w; x++) {
          const ex = (x + 0.5 - w / 2) / (w / 2);
          const ey = (y + 0.5 - hh / 2) / (hh / 2);
          if (ex * ex + ey * ey > 1) continue;
          const i = (y * w + x) * 4;
          const R = dd[i];
          const G = dd[i + 1];
          const B = dd[i + 2];
          const red = R - Math.max(G, B);
          if (R < 50 || red < R * 0.2) continue;
          let k = clamp((red / R - 0.2) / 0.3, 0, 1);
          if (sel) k *= sel[y * w + x] / 255;
          if (!k) continue;
          n++;
          const v = ((G + B) / 2) * (1 - dk);
          dd[i] = R + (v - R) * k;
          dd[i + 1] = G + (G * (1 - dk * 0.4) - G) * k;
          dd[i + 2] = B + (B * (1 - dk * 0.4) - B) * k;
        }
      }
      if (!n) {
        doc.restore(before);
        E.redraw();
        toast('빨간 눈동자를 찾지 못했습니다. 눈 둘레를 끌어서 감싸 보세요.');
        return;
      }
      g.putImageData(img, x0, y0);
      l._styled = null;
      E.commit('적목 현상 제거', before);
    },
    overlay(E, g) {
      if (!this.d) return;
      const [x1, y1] = E.toScreen(this.d.a.x, this.d.a.y);
      const [x2, y2] = E.toScreen(this.d.b.x, this.d.b.y);
      g.save();
      g.strokeStyle = '#fff';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    },
  };

  // ---- patch and content-aware move: draw a selection, then drag it
  const dragSelTool = (def) => ({
    group: 'retouch', cursor: 'crosshair', ...def,
    down(E, p, e) {
      const doc = E.doc;
      if (doc.selection && E.selAt(p) > 0 && !e.shiftKey && !e.altKey) {
        if (!needRaster(E, def.name)) return;
        if (E.maskTarget?.()) {
          toast(`${def.name}는 레이어 내용에만 씁니다`);
          return;
        }
        this.d = { kind: 'drag', a: p, b: p };
        def.start?.call(this, E);
      } else this.d = { kind: 'lasso', pts: [[p.x, p.y]], mode: selMode(E, e, def.id) };
      E.overlay();
    },
    move(E, p) {
      const d = this.d;
      if (!d) return;
      if (d.kind === 'lasso') {
        const q = d.pts[d.pts.length - 1];
        if (Math.hypot(p.x - q[0], p.y - q[1]) * E.view.zoom > 2) d.pts.push([p.x, p.y]);
      } else d.b = p;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const doc = E.doc;
      if (d.kind === 'lasso') {
        if (d.pts.length > 2) {
          const before = doc.capture();
          doc.selection = SEL.combine(doc, SEL.shapeMask(doc, SEL.polyPath(d.pts), 0, true), d.mode);
          E.commit(`${def.name} 선택`, before);
        }
        E.overlay();
        return;
      }
      const off = { x: Math.round(d.b.x - d.a.x), y: Math.round(d.b.y - d.a.y) };
      if (!off.x && !off.y) {
        E.overlay();
        return;
      }
      const before = doc.capture();
      def.apply.call(this, E, off, E.opts(def.id));
      E.commit(def.name, before);
      this.float = null;
    },
    cancel(E) {
      this.d = null;
      this.float = null;
      E.overlay();
    },
    overlay(E, g) {
      const d = this.d;
      if (!d) return;
      if (d.kind === 'lasso') {
        g.save();
        g.strokeStyle = '#fff';
        g.setLineDash([4, 4]);
        g.beginPath();
        d.pts.forEach(([x, y], i) => {
          const [sx, sy] = E.toScreen(x, y);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.stroke();
        g.restore();
        return;
      }
      const dx = d.b.x - d.a.x;
      const dy = d.b.y - d.a.y;
      if (this.float) {
        const f = this.float;
        const [x0, y0] = E.toScreen(f.x + dx, f.y + dy);
        const [x1, y1] = E.toScreen(f.x + dx + f.canvas.width, f.y + dy + f.canvas.height);
        g.save();
        g.globalAlpha = 0.85;
        g.drawImage(f.canvas, x0, y0, x1 - x0, y1 - y0);
        g.restore();
      }
      E.drawSelOffset(g, dx, dy);
    },
  });

  /** Pixels of the layer (canvas grown to the doc) as {g, base, toLayer(docCanvas)}. */
  const layerWork = (E) => {
    const doc = E.doc;
    const l = doc.active;
    const g = doc.editPixels(l, allDoc());
    const base = cloneCanvas(g.canvas);
    const toLayer = (c, dx = 0, dy = 0) => shifted(c, dx - l.x, dy - l.y, g.canvas.width, g.canvas.height);
    return { doc, l, g, base, toLayer };
  };

  const patch = dragSelTool({
    id: 'patch', name: '패치', key: 'J', icon: 'patch',
    options: [['patchMode', '패치', 'select', null, null, 'source', [['source', '원본 (선택한 곳을 끌어간 곳으로 고침)'], ['dest', '대상 (선택한 곳을 끌어간 곳에 복사)']]], ['adapt', '가장자리 녹이기', 'bool', null, null, true]],
    apply(E, off, o) {
      const { doc, l, g, base, toLayer } = layerWork(E);
      const sel = doc.selection.canvas;
      if (o.patchMode === 'dest') {
        healPaste(g, base, shifted(base, off.x, off.y), toLayer(sel, off.x, off.y), { adapt: o.adapt });
        doc.selection = { canvas: shifted(sel, off.x, off.y) };
      } else healPaste(g, base, shifted(base, -off.x, -off.y), toLayer(sel), { adapt: o.adapt });
      l._styled = null;
    },
  });

  const contentMove = dragSelTool({
    id: 'contentMove', name: '내용 인식 이동', key: 'J', icon: 'contentMove',
    options: [['moveMode', '방식', 'select', null, null, 'move', [['move', '이동 (빈자리는 주변으로 채움)'], ['extend', '확장 (복제)']]], ['adapt', '가장자리 녹이기', 'bool', null, null, true]],
    start(E) {
      this.float = liftSelection(E, { copy: true });
    },
    apply(E, off, o) {
      const f = this.float || liftSelection(E, { copy: true });
      const { doc, l, g, toLayer } = layerWork(E);
      const sel = doc.selection.canvas;
      if (o.moveMode !== 'extend') {
        const W = g.canvas.width;
        const H = g.canvas.height;
        const a = alphaOf(toLayer(sel));
        let hole = new Uint8Array(W * H);
        for (let i = 0; i < a.length; i++) if (a[i] > 8) hole[i] = 1;
        hole = dilate(hole, W, H, 1);
        contentFillCtx(g, hole);
      }
      const base = cloneCanvas(g.canvas);
      const paste = makeCanvas(g.canvas.width, g.canvas.height);
      paste.getContext('2d').drawImage(base, 0, 0);
      paste.getContext('2d').drawImage(f.canvas, f.x + off.x - l.x, f.y + off.y - l.y);
      healPaste(g, base, paste, toLayer(sel, off.x, off.y), { adapt: o.adapt });
      doc.selection = { canvas: shifted(sel, off.x, off.y) };
      l._styled = null;
    },
  });

  // ---- measuring and marking: ruler, notes, count, colour samplers
  const sampled = { rev: -1, g: null };
  const sampleAt = (E, x, y, s = 1) => {
    if (sampled.rev !== E.doc.rev || sampled.doc !== E.doc) {
      sampled.g = E.composite().getContext('2d', { willReadFrequently: true });
      sampled.rev = E.doc.rev;
      sampled.doc = E.doc;
    }
    const r = Math.floor(s / 2);
    const d = sampled.g.getImageData(Math.round(x) - r, Math.round(y) - r, s, s).data;
    let R = 0;
    let G = 0;
    let B = 0;
    for (let i = 0; i < d.length; i += 4) {
      R += d[i];
      G += d[i + 1];
      B += d[i + 2];
    }
    const n = d.length / 4;
    return [R / n, G / n, B / n].map(Math.round);
  };
  const label = (g, text, x, y, bg = 'rgba(20,20,20,.85)') => {
    g.save();
    g.font = '12px system-ui, sans-serif';
    const w = g.measureText(text).width + 8;
    g.fillStyle = bg;
    g.fillRect(x, y - 9, w, 18);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, x + 4, y);
    g.restore();
  };
  const drawMarks = (E, g) => {
    const doc = E.doc;
    if (!doc) return;
    g.save();
    for (const n of doc.notes) {
      const [x, y] = E.toScreen(n.x, n.y);
      g.fillStyle = '#ffd84a';
      g.strokeStyle = '#7a5b00';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 12, y);
      g.lineTo(x + 16, y + 4);
      g.lineTo(x + 16, y + 16);
      g.lineTo(x, y + 16);
      g.closePath();
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(x + 3, y + 7);
      g.lineTo(x + 13, y + 7);
      g.moveTo(x + 3, y + 11);
      g.lineTo(x + 11, y + 11);
      g.stroke();
      if (P.tool === 'note') label(g, n.text.length > 40 ? `${n.text.slice(0, 40)}…` : n.text, x + 20, y + 8);
    }
    doc.counts.forEach((c, i) => {
      const [x, y] = E.toScreen(c.x, c.y);
      g.fillStyle = c.color || '#00c8ff';
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
      g.font = 'bold 13px system-ui, sans-serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.strokeText(String(i + 1), x + 6, y - 5);
      g.fillText(String(i + 1), x + 6, y - 5);
    });
    const ss = E.opts('sampler').sample || 1;
    doc.samplers.forEach((s, i) => {
      const [x, y] = E.toScreen(s.x, s.y);
      g.strokeStyle = '#000';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = '#fff';
      g.lineWidth = 1;
      g.stroke();
      const [R, G, B] = sampleAt(E, s.x, s.y, ss);
      label(g, `#${i + 1}  R${R} G${G} B${B}`, x + 10, y);
    });
    g.restore();
  };
  const near = (E, list, p, px = 12) => {
    let best = -1;
    let bd = px / E.view.zoom;
    list.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const ruler = {
    id: 'ruler', name: '눈금자', key: 'I', icon: 'ruler', group: 'crop', cursor: 'crosshair',
    options: [],
    down(E, p) {
      this.r = { a: p, b: p };
      this.dragging = true;
      E.overlay();
    },
    move(E, p, e) {
      if (!this.r || !this.dragging) return;
      let b = p;
      if (e.shiftKey) {
        // 45° steps
        const ang = Math.round(Math.atan2(p.y - this.r.a.y, p.x - this.r.a.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = dist(this.r.a, p);
        b = { x: this.r.a.x + Math.cos(ang) * len, y: this.r.a.y + Math.sin(ang) * len };
      }
      this.r.b = b;
      E.overlay();
    },
    up() {
      this.dragging = false;
      P.emit('opts');
    },
    info() {
      if (!this.r) return null;
      const dx = this.r.b.x - this.r.a.x;
      const dy = this.r.b.y - this.r.a.y;
      return { len: Math.hypot(dx, dy), ang: (-Math.atan2(dy, dx) * 180) / Math.PI, dx, dy };
    },
    optionButtons() {
      const i = this.info();
      return [
        h('span.ph-opt.ph-hint', i ? `길이 ${i.len.toFixed(1)} px · 각도 ${i.ang.toFixed(1)}° · 가로 ${i.dx.toFixed(0)} · 세로 ${i.dy.toFixed(0)}` : '끌어서 길이와 각도를 잽니다 (Shift: 45° 단위)'),
        h('button.small', { disabled: !i, onclick: () => C.straightenLayer(i.ang), title: '잰 선이 수평(또는 수직)이 되게 레이어를 돌립니다' }, '레이어 똑바르게'),
        h('button.small', { disabled: !i, onclick: () => { this.r = null; P.overlay(); P.emit('opts'); } }, '지우기'),
      ];
    },
    deactivate() {
      this.r = null;
    },
    overlay(E, g) {
      drawMarks(E, g);
      if (!this.r) return;
      const [x1, y1] = E.toScreen(this.r.a.x, this.r.a.y);
      const [x2, y2] = E.toScreen(this.r.b.x, this.r.b.y);
      g.save();
      for (const [c, lw] of [['#000', 3], ['#fff', 1]]) {
        g.strokeStyle = c;
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.moveTo(x1 - 5, y1);
        g.lineTo(x1 + 5, y1);
        g.moveTo(x2 - 5, y2);
        g.lineTo(x2 + 5, y2);
        g.stroke();
      }
      const i = this.info();
      label(g, `${i.len.toFixed(1)} px  ${i.ang.toFixed(1)}°`, x2 + 8, y2 + 12);
      g.restore();
    },
  };

  C.straightenLayer = (ang) => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l) return;
    if (l.kind !== 'raster' || !l.canvas) return toast('이미지 레이어를 고르세요 (글자·모양은 래스터화한 뒤)');
    // turn the measured line horizontal, or vertical if it is closer to that
    let rot = ang;
    if (ang > 45) rot = ang - 90;
    else if (ang < -45) rot = ang + 90;
    if (Math.abs(rot) < 0.01) return toast('이미 똑바릅니다');
    const t = (rot * Math.PI) / 180;
    P.run('레이어 똑바르게', () => {
      const c = l.canvas;
      const cos = Math.abs(Math.cos(t));
      const sin = Math.abs(Math.sin(t));
      const w = Math.ceil(c.width * cos + c.height * sin);
      const hh = Math.ceil(c.width * sin + c.height * cos);
      const n = makeCanvas(w, hh);
      const g = n.getContext('2d');
      g.translate(w / 2, hh / 2);
      g.rotate(t);
      g.drawImage(c, -c.width / 2, -c.height / 2);
      const cx = l.x + c.width / 2;
      const cy = l.y + c.height / 2;
      l.canvas = n;
      l.x = Math.round(cx - w / 2);
      l.y = Math.round(cy - hh / 2);
      l._styled = null;
      doc.touch(l);
    });
    TOOL_BY_ID.ruler.r = null;
    P.emit('opts');
    return undefined;
  };

  const noteDialog = (n, onSave, onDelete) => {
    const ta = h('textarea', { rows: 5, style: { width: '100%' } });
    ta.value = n?.text || '';
    openModal({
      title: n ? '메모 고치기' : '메모 추가',
      width: '380px',
      body: [ta],
      buttons: [...(onDelete ? [{ label: '삭제', action: onDelete }] : []), { label: '취소' }, { label: '저장', primary: true, action: () => onSave(ta.value.trim()) }],
    });
    setTimeout(() => ta.focus(), 30);
  };
  const note = {
    id: 'note', name: '메모', key: 'I', icon: 'note', group: 'crop', cursor: 'crosshair',
    options: [],
    down(E, p) {
      const doc = E.doc;
      const i = doc.notes.findIndex((n) => {
        const [x, y] = E.toScreen(n.x, n.y);
        const [px, py] = E.toScreen(p.x, p.y);
        return px >= x - 2 && px <= x + 18 && py >= y - 2 && py <= y + 18;
      });
      if (i >= 0) {
        noteDialog(doc.notes[i], (text) => P.run('메모 고치기', () => {
          if (text) doc.notes[i] = { ...doc.notes[i], text };
          else doc.notes.splice(i, 1);
        }), () => P.run('메모 삭제', () => doc.notes.splice(i, 1)));
        return;
      }
      noteDialog(null, (text) => {
        if (text) P.run('메모 추가', () => doc.notes.push({ x: Math.round(p.x), y: Math.round(p.y), text }));
      });
    },
    optionButtons() {
      const n = P.doc?.notes.length || 0;
      return [h('span.ph-opt.ph-hint', `메모 ${n}개 · 누르면 추가, 메모를 누르면 고치기`), h('button.small', { disabled: !n, onclick: () => P.run('메모 모두 지우기', () => { P.doc.notes = []; }) }, '모두 지우기')];
    },
    overlay: drawMarks,
  };

  const COUNT_COLORS = [['#00c8ff', '하늘색'], ['#ff3b3b', '빨강'], ['#ffd400', '노랑'], ['#2ee66b', '초록'], ['#ff4fd8', '분홍']];
  const count = {
    id: 'count', name: '카운트', key: 'I', icon: 'count', group: 'crop', cursor: 'crosshair',
    options: [['color', '색', 'select', null, null, '#00c8ff', COUNT_COLORS]],
    down(E, p, e) {
      const doc = E.doc;
      if (e.altKey) {
        const i = near(E, doc.counts, p);
        if (i >= 0) P.run('카운트 빼기', () => doc.counts.splice(i, 1));
      } else P.run('카운트', () => doc.counts.push({ x: Math.round(p.x), y: Math.round(p.y), color: E.opts('count').color }));
      P.emit('opts');
    },
    optionButtons() {
      const n = P.doc?.counts.length || 0;
      return [h('span.ph-opt.ph-hint', `개수: ${n} · Alt+클릭으로 빼기`), h('button.small', { disabled: !n, onclick: () => { P.run('카운트 지우기', () => { P.doc.counts = []; }); P.emit('opts'); } }, '모두 지우기')];
    },
    overlay: drawMarks,
  };

  const sampler = {
    id: 'sampler', name: '색상 샘플러', key: 'I', icon: 'sampler', group: 'crop', cursor: 'crosshair',
    options: [['sample', '샘플 크기', 'select', null, null, 1, [[1, '1 픽셀'], [3, '3×3 평균'], [5, '5×5 평균']]]],
    down(E, p, e) {
      const doc = E.doc;
      const i = near(E, doc.samplers, p);
      if (e.altKey) {
        if (i >= 0) P.run('색상 샘플러 지우기', () => doc.samplers.splice(i, 1));
        return;
      }
      if (i >= 0) {
        this.drag = { i, before: doc.capture() };
        return;
      }
      if (doc.samplers.length >= 10) return void toast('색상 샘플러는 10개까지 둘 수 있습니다 (Alt+클릭으로 지우기)');
      P.run('색상 샘플러', () => doc.samplers.push({ x: Math.round(p.x), y: Math.round(p.y) }));
    },
    move(E, p) {
      if (!this.drag) return;
      E.doc.samplers[this.drag.i] = { x: Math.round(p.x), y: Math.round(p.y) };
      E.overlay();
    },
    up(E) {
      if (this.drag) E.commit('색상 샘플러 옮기기', this.drag.before);
      this.drag = null;
    },
    optionButtons() {
      const n = P.doc?.samplers.length || 0;
      return [h('span.ph-opt.ph-hint', 'Alt+클릭으로 지우기, 끌어서 옮기기'), h('button.small', { disabled: !n, onclick: () => P.run('색상 샘플러 모두 지우기', () => { P.doc.samplers = []; }) }, '모두 지우기')];
    },
    overlay: drawMarks,
  };
  TOOL_BY_ID.eyedropper.overlay = drawMarks;

  // ---- register
  for (const t of [healBrush, patch, contentMove, remove, redEye, mixer, colorReplace, historyBrush, bgEraser, magicEraser, ruler, note, count, sampler]) {
    TOOLS.push(t);
    TOOL_BY_ID[t.id] = t;
  }
  const group = (first) => TOOL_GROUPS.find((g) => g[0] === first);
  group('eyedropper').push('sampler', 'ruler', 'note', 'count');
  group('heal').push('healBrush', 'patch', 'contentMove', 'remove', 'redEye');
  group('brush').push('colorReplace', 'mixer');
  group('eraser').push('bgEraser', 'magicEraser');
  TOOL_GROUPS.splice(TOOL_GROUPS.indexOf(group('clone')) + 1, 0, ['historyBrush']);

  // ---- commands
  C.liquify = () => import('./liquify.js').then((m) => m.liquifyDialog(P));
  C.contentAwareFill = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!doc?.selection) return toast('먼저 지울 곳을 선택하세요 (조금 넉넉하게)');
    if (l?.kind !== 'raster') return toast('이미지 레이어를 고르세요');
    toast('내용 인식 채우기 중…');
    setTimeout(() => {
      P.run('내용 인식 채우기', () => {
        const g = doc.editPixels(l, allDoc());
        const W = g.canvas.width;
        const H = g.canvas.height;
        const a = alphaOf(shifted(doc.selection.canvas, -l.x, -l.y, W, H));
        const hole = new Uint8Array(W * H);
        for (let i = 0; i < a.length; i++) if (a[i] > 8) hole[i] = 1;
        contentFillCtx(g, hole, a);
        l._styled = null;
      });
    }, 30);
    return undefined;
  };

  C.defineBrush = async () => {
    const doc = P.doc;
    if (!doc) return;
    const sel = doc.selection;
    const r = sel ? SEL.alphaBounds(sel.canvas) : { x: 0, y: 0, w: doc.width, h: doc.height };
    if (!r) return;
    const k = Math.min(1, 256 / Math.max(r.w, r.h));
    const w = Math.max(1, Math.round(r.w * k));
    const hh = Math.max(1, Math.round(r.h * k));
    const c = makeCanvas(w, hh);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, hh);
    g.drawImage(P.composite(), r.x, r.y, r.w, r.h, 0, 0, w, hh);
    const sa = sel ? (() => {
      const t = makeCanvas(w, hh);
      t.getContext('2d').drawImage(sel.canvas, r.x, r.y, r.w, r.h, 0, 0, w, hh);
      return alphaOf(t);
    })() : null;
    const img = g.getImageData(0, 0, w, hh);
    const d = img.data;
    let tot = 0;
    for (let i = 0; i < w * hh; i++) {
      // dark = paint, like Photoshop
      const a = (255 - (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])) * (sa ? sa[i] / 255 : 1);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
      d[i * 4 + 3] = a;
      tot += a;
    }
    if (tot < w * hh * 2) return toast('어두운 부분이 브러시 모양이 됩니다. 흰 바탕에 검게 그린 뒤 다시 해 보세요.');
    g.putImageData(img, 0, 0);
    const name = await promptDialog('브러시 사전 설정 정의', '이름', `내 브러시 ${savedTips.length + 1}`);
    if (!name) return;
    const t = { id: `custom:${Date.now().toString(36)}`, name: name.slice(0, 30), data: c.toDataURL('image/png') };
    savedTips.push(t);
    while (savedTips.length > 16) savedTips.shift();
    savePref('photo.brushTips', savedTips);
    addTip(t);
    customTips.set(t.id, c);
    P.setOpt('brush', 'tip', t.id);
    P.setTool('brush');
    toast(`"${t.name}" 브러시를 만들어 브러시 도구에 골라 두었습니다`);
  };
}

// ---------------------------------------------------------------- brush settings dialog

function brushSettings(P, id) {
  const o = P.opts(id);
  const D = dyn(o);
  const set = (k, v) => {
    P.setOpt(id, k, v);
    draw();
  };
  const rows = [];
  const ctl = {};
  const range = (k, label, min, max, unit = '%') => {
    const r = h('input', { type: 'range', min, max, value: D[k] ?? o[k] });
    const n = h('input.ph-num', { type: 'number', min, max, value: D[k] ?? o[k], style: { width: '64px' } });
    const f = (v) => {
      v = clamp(Math.round(+v), min, max);
      r.value = v;
      n.value = v;
      set(k, v);
    };
    r.addEventListener('input', () => f(r.value));
    n.addEventListener('change', () => f(n.value));
    ctl[k] = (v) => {
      r.value = v;
      n.value = v;
    };
    rows.push(formRow(label, r, n, h('small', unit)));
  };
  const check = (k, label) => {
    const b = h('input', { type: 'checkbox', checked: !!(D[k] ?? o[k]) });
    b.addEventListener('change', () => set(k, b.checked));
    ctl[k] = (v) => {
      b.checked = !!v;
    };
    rows.push(formRow(label, b));
  };
  const head = (t) => rows.push(h('div.note', { style: { fontWeight: 600, marginTop: '8px' } }, t));

  const preset = h('select', h('option', { value: '' }, '사전 설정 고르기…'), PRESETS.map(([n], i) => h('option', { value: i }, n)));
  preset.addEventListener('change', () => {
    const p = PRESETS[+preset.value];
    if (!p) return;
    // every preset starts from the defaults (flow too), so settings from the last one don't linger
    const v = { ...DYN, flow: 100, ...p[1] };
    for (const [k, val] of Object.entries(v)) {
      P.setOpt(id, k, val);
      ctl[k]?.(val);
    }
    tipSel.value = v.tip;
    draw();
  });
  const tipSel = h('select', TIP_LIST.map(([v, t]) => h('option', { value: v }, t)));
  tipSel.value = o.tip || 'round';
  tipSel.addEventListener('change', () => set('tip', tipSel.value));
  rows.push(formRow('사전 설정', preset), formRow('모양', tipSel));
  head('모양');
  range('hardness', '경도', 0, 100);
  range('spacing', '간격', 1, 300);
  range('angle', '각도', -180, 180, '°');
  range('roundness', '원형율', 5, 100);
  check('followDir', '그리는 방향 따라 돌리기');
  head('흩뿌리기 · 변화');
  range('scatter', '흩뿌리기', 0, 500);
  range('count', '한 번에 찍는 개수', 1, 16, '개');
  range('sizeJitter', '크기 변화', 0, 100);
  range('angleJitter', '각도 변화', 0, 100);
  range('roundJitter', '원형율 변화', 0, 100);
  range('opacityJitter', '불투명도 변화', 0, 100);
  check('pressureOpacity', '펜 압력 → 불투명도');
  if (id === 'brush') {
    head('색 변화');
    range('fgbgJitter', '전경 ↔ 배경색', 0, 100);
    range('hueJitter', '색조', 0, 100);
    range('satJitter', '채도', 0, 100);
    range('briJitter', '명도', 0, 100);
  }
  head('보정');
  range('smoothing', '손떨림 보정', 0, 100);

  const pv = h('canvas', { width: 420, height: 110, style: { width: '100%', background: '#fff', borderRadius: '6px' } });
  function draw() {
    const g = pv.getContext('2d');
    const oo = P.opts(id);
    const col = id === 'eraser' ? '#333333' : P.fg;
    // a light colour is shown on a dark background so it stays visible
    const [r, gg, b] = hexRgb(col);
    pv.style.background = 0.299 * r + 0.587 * gg + 0.114 * b > 170 ? '#2b2b2b' : '#fff';
    g.clearRect(0, 0, pv.width, pv.height);
    const bo = brushOpts(oo, P, {});
    bo.hardness = (oo.hardness ?? 70) / 100;
    const size = clamp(oo.size || 30, 4, 48);
    const eng = makeEngine(oo, bo, col, P.bg);
    const mock = { bg: g, mode: 'paint', onMask: false, dir: 0, pressure: 1 };
    const step = Math.max(1, size * Math.max(0.01, dyn(oo).spacing / 100));
    let last = null;
    let rest = 0;
    for (let t = 0; t <= 1.0001; t += 0.002) {
      const x = 30 + t * 360;
      const y = 55 + Math.sin(t * Math.PI * 2) * 28;
      if (!last) {
        eng(mock, x, y, size);
        last = { x, y };
        continue;
      }
      const d = Math.hypot(x - last.x, y - last.y);
      rest += d;
      mock.dir = Math.atan2(y - last.y, x - last.x);
      last = { x, y };
      if (rest >= step) {
        rest = 0;
        eng(mock, x, y, size);
      }
    }
  }
  openModal({
    title: `브러시 설정 (${TOOL_BY_ID[id].name})`,
    width: '460px',
    body: [pv, h('div', { style: { maxHeight: '52vh', overflow: 'auto', marginTop: '8px' } }, rows)],
    buttons: [{ label: '기본값으로', action: () => { for (const [k, v] of Object.entries(DYN)) P.setOpt(id, k, v); P.setOpt(id, 'tip', 'round'); setTimeout(() => brushSettings(P, id), 0); } }, { label: '닫기', primary: true }],
  });
  draw();
}

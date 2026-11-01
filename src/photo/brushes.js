// Painting and retouching tools on top of the brush engine (brushengine.js): the brush options
// (options bar, presets and the Brush Settings panel live in brushpanel.js); healing brush, patch,
// content-aware move, remove tool, spot healing's content-aware mode and Edit ▸ Content-Aware Fill;
// mixer brush, history brush, background / magic eraser, colour replacement, red eye; ruler, notes,
// count and colour samplers.

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, Stroke, brushOpts, needRaster, liftSelection, selMode, rgbHex } from './tools.js';
import * as SEL from './selection.js';
import { inpaint, healBlend, solveLaplace } from './inpaint.js';
import { createBrushRun, normDyn } from './brushengine.js';
import { listPatterns, paintPattern } from './resources.js';
import { installCloneSource, sampleCanvas, ALIGNED_OPT, SAMPLE_OPT, IGNORE_ADJ_OPT } from './clonesrc.js';
import { installBrushPanels, BRUSH_BAR, BRUSH_MODES } from './brushpanel.js';

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

/** Alpha bytes of a canvas inside rectangle r. */
const alphaIn = (c, r) => {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h).data;
  const a = new Uint8Array(r.w * r.h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
};

const clipRect = (r, W, H) => {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(W, Math.ceil(r.x + r.w)) - x;
  const hh = Math.min(H, Math.ceil(r.y + r.h)) - y;
  return w > 0 && hh > 0 ? { x, y, w, h: hh } : null;
};
const growRect = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/**
 * The painted part of a canvas (alpha > 0), or null. Big canvases are looked at small first: anything
 * at least `feature` pixels across shows up there, so only that part is read in full.
 */
function paintedBox(c, feature = 1) {
  const W = c.width;
  const H = c.height;
  let r = { x: 0, y: 0, w: W, h: H };
  const k = Math.max(1, Math.min(16, Math.floor(feature / 3)));
  if (k > 1 && W * H > 1e6) {
    const sw = Math.ceil(W / k);
    const sh = Math.ceil(H / k);
    const t = makeCanvas(sw, sh);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.imageSmoothingQuality = 'low';
    tg.drawImage(c, 0, 0, sw, sh);
    const sa = alphaIn(t, { x: 0, y: 0, w: sw, h: sh });
    const b = bboxOf(sa, sw, sh);
    if (!b) return null;
    r = clipRect({ x: (b.x - 1) * k, y: (b.y - 1) * k, w: (b.w + 2) * k, h: (b.h + 2) * k }, W, H);
  }
  const b = bboxOf(alphaIn(c, r), r.w, r.h);
  return b ? { x: b.x + r.x, y: b.y + r.y, w: b.w, h: b.h } : null;
}

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
 * Content-aware fill on a canvas context: rebuild the pixels where hole (r.w×r.h, for rectangle r of
 * the canvas) is set, from the rest of the picture. amt (0..255 per hole pixel, optional) softens the
 * result into the original.
 */
function contentFill(g, hole, r, amt = null, reach = 0.9) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const hb = bboxOf(hole, r.w, r.h);
  if (!hb) return false;
  const b = { x: hb.x + r.x, y: hb.y + r.y, w: hb.w, h: hb.h };
  // how far around the hole patches are taken from (texture: close by only)
  const m = clamp(Math.round(Math.max(b.w, b.h) * reach), 16, 360);
  const x0 = Math.max(0, b.x - m);
  const y0 = Math.max(0, b.y - m);
  const cw = Math.min(W, b.x + b.w + m) - x0;
  const ch = Math.min(H, b.y + b.h + m) - y0;
  const img = g.getImageData(x0, y0, cw, ch);
  const d = img.data;
  const hc = new Uint8Array(cw * ch);
  const hi = (x, y) => {
    const hx = x + x0 - r.x;
    const hy = y + y0 - r.y;
    return hx < 0 || hy < 0 || hx >= r.w || hy >= r.h ? -1 : hy * r.w + hx;
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = hi(x, y);
      if (i >= 0 && hole[i]) hc[y * cw + x] = 1;
    }
  }
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
        const a = amt[hi(x, y)] / 255;
        for (let c = 0; c < 4; c++) d[i * 4 + c] = orig[i * 4 + c] + (d[i * 4 + c] - orig[i * 4 + c]) * a;
      }
    }
  }
  g.putImageData(img, x0, y0);
  return true;
}

/**
 * Proximity match: fill the hole (r.w×r.h for rectangle r) smoothly from the colours around it, with a
 * little grain like the surroundings'.
 */
function proximityFill(g, hole, r) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const hb = bboxOf(hole, r.w, r.h);
  if (!hb) return;
  const R = clipRect({ x: hb.x + r.x - 6, y: hb.y + r.y - 6, w: hb.w + 12, h: hb.h + 12 }, W, H);
  const img = g.getImageData(R.x, R.y, R.w, R.h);
  const d = img.data;
  const unk = new Uint8Array(R.w * R.h);
  for (let y = 0; y < R.h; y++) {
    for (let x = 0; x < R.w; x++) {
      const hx = x + R.x - r.x;
      const hy = y + R.y - r.y;
      if (hx >= 0 && hy >= 0 && hx < r.w && hy < r.h && hole[hy * r.w + hx]) unk[y * R.w + x] = 1;
    }
  }
  // grain: how much the known pixels vary from their neighbours
  let gs = 0;
  let gn = 0;
  for (let i = 1; i < R.w * R.h; i++) {
    if (unk[i] || unk[i - 1]) continue;
    gs += Math.abs(d[i * 4] - d[i * 4 - 4]) + Math.abs(d[i * 4 + 1] - d[i * 4 - 3]) + Math.abs(d[i * 4 + 2] - d[i * 4 - 2]);
    gn += 3;
  }
  const grain = gn ? gs / gn : 0;
  const F = new Float32Array(R.w * R.h * 4);
  for (let i = 0; i < F.length; i++) F[i] = d[i];
  solveLaplace(R.w, R.h, unk, F, 4);
  let seed = 7;
  for (let i = 0; i < R.w * R.h; i++) {
    if (!unk[i]) continue;
    seed = (seed * 16807) % 2147483647;
    const n = ((seed / 2147483647) - 0.5) * grain * 1.2;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = F[i * 4 + c] + n;
    d[i * 4 + 3] = F[i * 4 + 3];
  }
  g.putImageData(img, R.x, R.y);
}

/**
 * Paste into the context where ra (alpha bytes for rectangle r) is set, over `base` (a canvas of the
 * context's size). pasteAt(R) gives the pasted picture for rectangle R as an R.w×R.h canvas.
 * adapt: shift the pasted colours so the edge disappears (healing).
 */
function healPasteIn(g, base, pasteAt, ra, r, { adapt = true, opacity = 1, layer = null } = {}) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const hb = bboxOf(ra, r.w, r.h);
  if (!hb) return false;
  const R = clipRect({ x: hb.x + r.x - 2, y: hb.y + r.y - 2, w: hb.w + 4, h: hb.h + 4 }, W, H);
  if (!R) return false;
  const dst = base.getContext('2d').getImageData(R.x, R.y, R.w, R.h).data;
  const src = pasteAt(R).getContext('2d').getImageData(0, 0, R.w, R.h).data;
  const amt = new Uint8Array(R.w * R.h);
  for (let yy = 0; yy < R.h; yy++) {
    const sy = yy + R.y - r.y;
    if (sy < 0 || sy >= r.h) continue;
    for (let xx = 0; xx < R.w; xx++) {
      const sx = xx + R.x - r.x;
      if (sx >= 0 && sx < r.w) amt[yy * R.w + xx] = ra[sy * r.w + sx];
    }
  }
  let out;
  if (layer) {
    // healed against `base` (every layer's picture), then laid over the layer's own pixels
    const full = amt.map((v) => (v ? 255 : 0));
    const healed = adapt ? healBlend(R.w, R.h, dst, src, full, 1) : src;
    out = new Uint8ClampedArray(layer.getContext('2d').getImageData(R.x, R.y, R.w, R.h).data);
    for (let i = 0; i < R.w * R.h; i++) {
      if (!amt[i]) continue;
      const o = i * 4;
      const ha = (healed[o + 3] / 255) * (amt[i] / 255) * opacity;
      const la = out[o + 3] / 255;
      const a = ha + la * (1 - ha);
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[o + c] = (healed[o + c] * ha + out[o + c] * la * (1 - ha)) / a;
      out[o + 3] = a * 255;
    }
  } else if (adapt) out = healBlend(R.w, R.h, dst, src, amt, opacity);
  else {
    out = new Uint8ClampedArray(dst);
    for (let i = 0; i < R.w * R.h; i++) {
      const a = (amt[i] / 255) * opacity;
      if (a) for (let c = 0; c < 4; c++) out[i * 4 + c] = dst[i * 4 + c] + (src[i * 4 + c] - dst[i * 4 + c]) * a;
    }
  }
  g.putImageData(new ImageData(out, R.w, R.h), R.x, R.y);
  return true;
}

/** A canvas's rectangle R, moved by (dx, dy) first, as an R.w×R.h canvas. */
const piece = (c, dx = 0, dy = 0) => (R) => {
  const t = makeCanvas(R.w, R.h);
  t.getContext('2d').drawImage(c, dx - R.x, dy - R.y);
  return t;
};

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
    if (id === 'eraser' && o.eraseMode === 'pencil') {
      // the pencil eraser: hard edged, no anti-aliasing (Stroke's own hard dab)
      bo.hard = true;
      bo.hardness = 1;
      return null;
    }
    if (id === 'eraser' && o.eraseMode === 'block') {
      // the block eraser: a 16-pixel square on screen, always full strength
      const size = Math.max(1, Math.round(16 / (P.view.zoom || 1)));
      Object.assign(bo, { size, hardness: 1, opacity: 1, flow: 1 });
      o = { size, tip: 'block', hardness: 100, spacing: 25, smoothing: o.smoothing };
    }
    if (id === 'pencil') {
      // the pencil: Stroke's own hard dab, with the options bar's mode and smoothing
      if (o.blend && o.blend !== 'source-over') bo.blend = o.blend;
      bo.smoothing = clamp(o.smoothing || 0, 0, 100) / 100;
      return null;
    }
    if (mode === 'clone' && !bo.cloneSrc) return null;
    const D = normDyn(o);
    bo.smoothing = D.smoothingOn ? D.smoothing / 100 : 0;
    // the painter places the dabs itself (spacing follows the current size and pen pressure), so
    // Stroke calls it for every pixel of the path, at the full size
    bo.spacing = 1 / Math.max(1, bo.size || o.size || 1);
    bo.pressureSize = false;
    // the options bar's mode (Stroke composites the stroke with it)
    if (mode !== 'erase' && o.blend && o.blend !== 'source-over') bo.blend = o.blend;
    const run = createBrushRun({ o, bo, mode, fg: P.fg, bg: P.bg, isAlive: (st) => TOOL_BY_ID[P.tool]?.st === st });
    const after = bo.afterStroke;
    bo.afterStroke = (st) => {
      run.end();
      after?.(st);
    };
    return run;
  };

  // tool options, presets, the Brush Settings and Brushes panels, Define Brush, .abr import
  installBrushPanels(P);

  // ---- the pencil: Photoshop's options bar (mode, smoothing, Auto Erase)
  const pencil = TOOL_BY_ID.pencil;
  pencil.options = [
    ['size', '크기', 'range', 1, 1000, 2, 'px'], ['blend', '모드', 'select', null, null, 'source-over', BRUSH_MODES],
    ['opacity', '불투명도', 'range', 1, 100, 100, '%'], ['smoothing', '보정', 'range', 0, 100, 0, '%'],
    ['autoErase', '자동 지우기', 'bool', null, null, false], ['pressureSize', '압력: 크기', 'bool', null, null, false],
  ];
  const pencilDown = pencil.down;
  pencil.down = function down(E, p, e) {
    // 자동 지우기: a stroke that starts on the foreground colour paints the background colour
    const l = E.doc?.active;
    if (E.opts('pencil').autoErase && !e.altKey && l?.canvas && !E.maskTarget?.() && !E.editMask) {
      const x = Math.floor(p.x - l.x);
      const y = Math.floor(p.y - l.y);
      if (x >= 0 && y >= 0 && x < l.canvas.width && y < l.canvas.height) {
        const d = l.canvas.getContext('2d').getImageData(x, y, 1, 1).data;
        const f = hexRgb(E.fg);
        if (d[3] > 127 && Math.abs(d[0] - f[0]) + Math.abs(d[1] - f[1]) + Math.abs(d[2] - f[2]) < 12) {
          const fg = E.fg;
          E.fg = E.bg;
          try {
            return pencilDown.call(this, E, p, e);
          } finally {
            E.fg = fg;
          }
        }
      }
    }
    return pencilDown.call(this, E, p, e);
  };

  // ---- the eraser's 작업 내역 지우기 (or Alt+drag): paint back the History panel's source state
  const eraser = TOOL_BY_ID.eraser;
  const eraserDown = eraser.down;
  eraser.down = function down(E, p, e) {
    const o = E.opts('eraser');
    if (!(o.eraseHistory || e.altKey) || E.maskTarget?.() || (E.editMask && E.doc.active?.mask)) return eraserDown.call(this, E, p, e);
    if (!needRaster(E, '지우개')) return undefined;
    const l = E.doc.active;
    const sl = P.historySourceState().layers.find((x) => x.id === l.id);
    if (!sl?.canvas) return void toast('작업 내역에서 고른 시점에 이 레이어가 없었습니다');
    const src = makeCanvas(E.doc.width, E.doc.height);
    src.getContext('2d').drawImage(sl.canvas, sl.x, sl.y);
    const bo = brushOpts(o, E, { label: '지우개 (작업 내역)' });
    Object.assign(bo, { srcCanvas: src, cloneSrc: src, cloneXf: new DOMMatrix(), cloneOffset: { x: 0, y: 0 } });
    bo.engine = P.brushEngine('eraser', o, bo, 'clone');
    this.st = new Stroke(E, 'clone', bo);
    this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
    this.st.flush();
    return undefined;
  };
  // ---- spot healing: content-aware by default
  const heal = TOOL_BY_ID.heal;
  const SAMPLE_ALL = ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, false];
  heal.options = [...heal.options.filter((x) => !['type', 'sampleAll'].includes(x[0])), ['type', '유형', 'select', null, null, 'content', [['content', '내용 인식'], ['texture', '텍스처 만들기'], ['proximity', '근접 일치']]], SAMPLE_ALL];
  /**
   * The end of a spot healing / remove stroke: the painted area is rebuilt from its surroundings.
   * With 모든 레이어 샘플링 the picture of every visible layer is used and only the fix goes onto
   * this layer (so retouching can live on an empty layer of its own).
   */
  P.healFill = (st) => {
    const remove = st.o.healKind === 'remove';
    if (st.onMask || (!remove && P.tool !== 'heal')) return false;
    const o = P.opts(remove ? 'remove' : 'heal');
    const kind = remove ? 'content' : o.type || 'content';
    const g = st.g;
    const W = g.canvas.width;
    const H = g.canvas.height;
    g.save();
    g.globalCompositeOperation = 'copy';
    g.drawImage(st.base, 0, 0);
    g.restore();
    // only the painted part of the (document-sized) stroke is looked at
    const grow = remove ? 3 : 2;
    const box = paintedBox(st.buf, st.o.size || 10);
    const r = box && clipRect(growRect(box, grow + 1), W, H);
    if (r) {
      const a = alphaIn(st.buf, r);
      let hole = new Uint8Array(r.w * r.h);
      for (let i = 0; i < a.length; i++) if (a[i] > 20) hole[i] = 1;
      hole = dilate(hole, r.w, r.h, grow);
      let work = g;
      if (o.sampleAll) {
        const comp = makeCanvas(W, H);
        comp.getContext('2d').drawImage(sampleCanvas(P, P.doc, { sample: 'all' }), -st.ox, -st.oy);
        work = comp.getContext('2d', { willReadFrequently: true });
      }
      if (kind === 'proximity') proximityFill(work, hole, r);
      else contentFill(work, hole, r, null, kind === 'texture' ? 0.35 : 0.9);
      if (work !== g) {
        // the rebuilt pixels alone go onto this layer
        const m = makeCanvas(r.w, r.h);
        const mg = m.getContext('2d');
        const mi = mg.createImageData(r.w, r.h);
        for (let i = 0; i < hole.length; i++) if (hole[i]) mi.data[i * 4 + 3] = 255;
        mg.putImageData(mi, 0, 0);
        mg.globalCompositeOperation = 'source-in';
        mg.drawImage(work.canvas, -r.x, -r.y);
        g.drawImage(m, r.x, r.y);
      }
    }
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
      if (def.engine !== false && (def.mode !== 'clone' || bo.cloneSrc)) bo.engine = P.brushEngine(def.id, o, bo, def.mode);
      this.st = new Stroke(E, def.mode, bo);
      this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
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

  // ---- healing brush: paint from a clone source (or a pattern), then blend the colours into the
  // surroundings when the stroke ends
  const healBrush = {
    id: 'healBrush', name: '복구 브러시', key: 'J', icon: 'healBrush', group: 'retouch', cursor: 'brush',
    options: [['size', '크기', 'range', 1, 1000, 40, 'px'], ['hardness', '경도', 'range', 0, 100, 80, '%'], ['source', '원본', 'select', null, null, 'sampled', [['sampled', '샘플'], ['pattern', '패턴']]], ['pattern', '패턴', 'select', null, null, 'paper', () => listPatterns().map((x) => [x.id, x.name])], ALIGNED_OPT, SAMPLE_OPT, IGNORE_ADJ_OPT],
    down(E, p, e) {
      if (e.altKey || this.pickNext) {
        this.pickNext = false;
        P.setCloneSource(p);
        return;
      }
      if (E.maskTarget?.()) return void toast('복구 브러시는 레이어 내용에만 칠합니다');
      if (!needRaster(E, '복구 브러시')) return;
      const o = E.opts('healBrush');
      // sampling other layers: the colours are matched to the picture, not to this layer alone
      const dest = o.source !== 'pattern' && o.sample && o.sample !== 'current' ? sampleCanvas(P, E.doc, { sample: o.sample, ignoreAdj: !!o.ignoreAdj, layer: E.doc.active }) : null;
      const heal = (bo) => {
        bo.opacity = 1;
        bo.afterStroke = (st) => {
          const box = paintedBox(st.buf, o.size || 10);
          if (!box) return;
          const ra = alphaIn(st.buf, box);
          if (dest) {
            const blendBase = makeCanvas(st.g.canvas.width, st.g.canvas.height);
            blendBase.getContext('2d').drawImage(dest, -st.ox, -st.oy);
            healPasteIn(st.g, blendBase, (R) => {
              const t = makeCanvas(R.w, R.h);
              const tg = t.getContext('2d');
              tg.setTransform(new DOMMatrix().translate(-(R.x + st.ox), -(R.y + st.oy)).multiply(bo.cloneXf));
              tg.drawImage(bo.cloneSrc, 0, 0);
              return t;
            }, ra, box, { layer: st.base });
            st.layer._styled = null;
            P.doc.touch(st.layer);
            return;
          }
          // the source as the dabs laid it onto the layer
          const pasteAt = (R) => {
            const t = makeCanvas(R.w, R.h);
            const tg = t.getContext('2d');
            tg.setTransform(new DOMMatrix().translate(-(R.x + st.ox), -(R.y + st.oy)).multiply(bo.cloneXf));
            tg.drawImage(bo.cloneSrc, 0, 0);
            return t;
          };
          healPasteIn(st.g, st.base, pasteAt, ra, box);
          st.layer._styled = null;
          P.doc.touch(st.layer);
        };
      };
      if (o.source === 'pattern') {
        const bo = brushOpts(o, E, { label: '복구 브러시' });
        bo.srcCanvas = paintPattern(E.doc.width, E.doc.height, o.pattern, 100);
        bo.cloneSrc = bo.srcCanvas;
        bo.cloneXf = new DOMMatrix();
        bo.cloneOffset = { x: 0, y: 0 };
        heal(bo);
        bo.engine = P.brushEngine('healBrush', o, bo, 'clone');
        this.st = new Stroke(E, 'clone', bo);
      } else this.st = P.cloneStroke(E, 'healBrush', p, e, { label: '복구 브러시', prepare: heal });
      if (!this.st) return;
      this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
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
    overlay(E, g) {
      if (E.opts('healBrush').source !== 'pattern') P.cloneOverlay?.(E, g, 'healBrush', !!this.st);
    },
    leadButtons() {
      return [...(P.brushOptionButtons?.('healBrush') || []), P.cloneSourceButton?.()];
    },
    optionButtons() {
      return [h('button.small', { title: '휴대폰: 이 버튼을 누른 뒤 원본 위치를 누르세요', onclick: () => { this.pickNext = true; toast('복구 원본으로 쓸 깨끗한 곳을 누르세요'); } }, '원본 정하기')];
    },
  };

  // ---- remove tool: paint over something, it is replaced by its surroundings
  const remove = strokeLike({
    id: 'remove', name: '제거 도구', key: 'J', icon: 'removeTool', mode: 'heal', engine: false,
    options: [['size', '크기', 'range', 1, 1000, 50, 'px'], ['sampleAll', '모든 레이어 샘플링', 'bool', null, null, true]],
    prepare(E, p, e, o, bo) {
      bo.hardness = 0.9;
      bo.healKind = 'remove';
    },
  });

  // ---- mixer brush: picks up and mixes with the paint already on the canvas
  const mixer = strokeLike({
    id: 'mixer', name: '혼합 브러시', key: 'B', icon: 'mixer', group: 'paint', mode: 'paint',
    options: [['size', '크기', 'range', 1, 1000, 40, 'px'], ['hardness', '경도', 'range', 0, 100, 60, '%'], ['wet', '젖음', 'range', 0, 100, 50, '%'], ['load', '물감 양', 'range', 1, 100, 50, '%'], ['mix', '섞기', 'range', 0, 100, 50, '%'], ['flow', '흐름', 'range', 1, 100, 100, '%'], ['clean', '획마다 붓 씻기', 'bool', null, null, true], ['smoothing', '보정', 'range', 0, 100, 10, '%']],
    leadButtons() {
      return P.brushOptionButtons('mixer');
    },
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
    // a snapshot (History panel)
    if (src.state && !hist.undoStack.includes(src)) {
      if ([doc.openState, ...(doc.snapshots || []).map((x) => x.state)].includes(src.state)) return src.state;
      doc._histSrc = null;
      return first;
    }
    const i = hist.undoStack.indexOf(src);
    if (i < 0) {
      doc._histSrc = null;
      return first;
    }
    return hist.undoStack[i + 1]?.state || doc.capture();
  };
  const historyBrush = strokeLike({
    id: 'historyBrush', name: '작업 내역 브러시', key: 'Y', icon: 'historyBrush', group: 'paint', mode: 'clone',
    options: BRUSH_BAR,
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
      bo.cloneSrc = src;
      bo.cloneXf = new DOMMatrix();
      bo.cloneOffset = { x: 0, y: 0 };
      bo.afterStroke = null;
      return true;
    },
    leadButtons() {
      return P.brushOptionButtons('historyBrush');
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

  /**
   * Pixels of the layer (canvas grown to the doc) as {g, base, selIn(dx, dy)}: selIn gives the
   * selection moved by (dx, dy) as alpha bytes and their rectangle, in layer coordinates.
   */
  const layerWork = (E) => {
    const doc = E.doc;
    const l = doc.active;
    const g = doc.editPixels(l, allDoc());
    const base = cloneCanvas(g.canvas);
    const sel = doc.selection.canvas;
    const sb = P.selBounds(sel);
    const selIn = (dx, dy) => {
      const r = sb && clipRect({ x: sb.x + dx - l.x, y: sb.y + dy - l.y, w: sb.w, h: sb.h }, g.canvas.width, g.canvas.height);
      if (!r) return [null, null];
      const t = makeCanvas(r.w, r.h);
      t.getContext('2d').drawImage(sel, dx - l.x - r.x, dy - l.y - r.y);
      return [alphaIn(t, { x: 0, y: 0, w: r.w, h: r.h }), r];
    };
    return { doc, l, g, base, selIn };
  };

  const patch = dragSelTool({
    id: 'patch', name: '패치', key: 'J', icon: 'patch',
    options: [['patchMode', '패치', 'select', null, null, 'source', [['source', '원본 (선택한 곳을 끌어간 곳으로 고침)'], ['dest', '대상 (선택한 곳을 끌어간 곳에 복사)']]], ['adapt', '가장자리 녹이기', 'bool', null, null, true]],
    apply(E, off, o) {
      const { doc, l, g, base, selIn } = layerWork(E);
      const sel = doc.selection.canvas;
      if (o.patchMode === 'dest') {
        const [ra, r] = selIn(off.x, off.y);
        if (r) healPasteIn(g, base, piece(base, off.x, off.y), ra, r, { adapt: o.adapt });
        doc.selection = { canvas: shifted(sel, off.x, off.y) };
      } else {
        const [ra, r] = selIn(0, 0);
        if (r) healPasteIn(g, base, piece(base, -off.x, -off.y), ra, r, { adapt: o.adapt });
      }
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
      const { doc, l, g, selIn } = layerWork(E);
      const sel = doc.selection.canvas;
      if (o.moveMode !== 'extend') {
        // the hole left behind is filled from its surroundings
        const [a, r0] = selIn(0, 0);
        const r = r0 && clipRect(growRect(r0, 1), g.canvas.width, g.canvas.height);
        if (r) {
          let hole = new Uint8Array(r.w * r.h);
          for (let y = 0; y < r0.h; y++) for (let x = 0; x < r0.w; x++) if (a[y * r0.w + x] > 8) hole[(y + r0.y - r.y) * r.w + x + r0.x - r.x] = 1;
          hole = dilate(hole, r.w, r.h, 1);
          contentFill(g, hole, r);
        }
      }
      const base = cloneCanvas(g.canvas);
      const pasteAt = (R) => {
        const t = makeCanvas(R.w, R.h);
        const tg = t.getContext('2d');
        tg.drawImage(base, -R.x, -R.y);
        if (f) tg.drawImage(f.canvas, f.x + off.x - l.x - R.x, f.y + off.y - l.y - R.y);
        return t;
      };
      const [ra, r] = selIn(off.x, off.y);
      if (r) healPasteIn(g, base, pasteAt, ra, r, { adapt: o.adapt });
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

  // the Clone Source panel and the clone stamp's sampling (clonesrc.js)
  installCloneSource(P);

  // ---- Shift with the painting and retouching tools, like Photoshop: Shift+click paints a straight
  // line from where the last stroke ended; Shift+drag keeps the stroke horizontal or vertical
  const LINE_TOOLS = ['brush', 'pencil', 'eraser', 'mixer', 'colorReplace', 'clone', 'patternStamp', 'healBrush', 'historyBrush', 'bgEraser', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge'];
  const lastEnd = new WeakMap();
  const active = (t) => !!(t.st || t.r || t.br);
  const straightLines = () => {
    for (const id of LINE_TOOLS) {
      const t = TOOL_BY_ID[id];
      if (!t?.down || t.straightLines) continue;
      t.straightLines = true;
      const { down, move, up } = t;
      t.down = function shiftDown(E, p, e) {
        const from = e.shiftKey && !e.altKey ? lastEnd.get(E.doc) : null;
        this.sl = { start: p, last: p, axis: null, line: !!from };
        if (!from) return down.call(this, E, p, e);
        down.call(this, E, from, e);
        // a ruler-straight line: no smoothing on it
        if (this.st?.o) this.st.o.smoothing = 0;
        if (active(this)) move?.call(this, E, p, e);
        return undefined;
      };
      t.move = function shiftMove(E, p, e) {
        const sl = this.sl;
        if (sl && !sl.line && e.shiftKey) {
          if (!sl.axis) {
            const dx = Math.abs(p.x - sl.start.x);
            const dy = Math.abs(p.y - sl.start.y);
            // the direction is picked once the pointer has clearly moved
            if (Math.max(dx, dy) * E.view.zoom < 4) return undefined;
            sl.axis = dx >= dy ? 'h' : 'v';
          }
          p = sl.axis === 'h' ? { x: p.x, y: sl.start.y } : { x: sl.start.x, y: p.y };
        }
        if (sl) sl.last = p;
        return move?.call(this, E, p, e);
      };
      t.up = function shiftUp(E, ...rest) {
        const sl = this.sl;
        const painted = active(this);
        const r = up?.call(this, E, ...rest);
        if (sl && painted && E.doc) lastEnd.set(E.doc, sl.last);
        this.sl = null;
        return r;
      };
    }
  };
  // after every module has added its tools
  P.extendMenus = [...(P.extendMenus || []), straightLines];

  // ---- commands
  C.liquify = () => import('./liquify.js').then((m) => m.liquifyDialog(P));
  C.contentAwareFill = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!doc?.selection) return toast('먼저 지울 곳을 선택하세요 (조금 넉넉하게)');
    if (l?.kind !== 'raster') return toast('이미지 레이어를 고르세요');
    if (!needRaster(P, '내용 인식 채우기')) return undefined;
    if (!P.selBounds(doc.selection.canvas)) return toast('선택 영역이 비어 있습니다');
    toast('내용 인식 채우기 중…');
    setTimeout(() => {
      if (P.doc !== doc || !doc.selection) return;
      P.run('내용 인식 채우기', () => {
        const { g, selIn } = layerWork(P);
        const [a, r] = selIn(0, 0);
        if (!r) return;
        const hole = new Uint8Array(r.w * r.h);
        for (let i = 0; i < a.length; i++) if (a[i] > 8) hole[i] = 1;
        contentFill(g, hole, r, a);
        l._styled = null;
      });
    }, 30);
    return undefined;
  };
}

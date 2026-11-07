// Video compositing engine. Draws a sequence frame at time t onto a 2D canvas.
// The same code path is used for the Program monitor and for export so what you see is what
// you get. Frame sources come from a "provider" (live <video> elements for preview, exact
// decoded frames for export).
//
// Effects run in clip order on a "stage" canvas holding the clip's source at about its on-screen
// resolution (processStage); CSS-filter effects are batched, the rest draw in place or come from
// PIXEL_FX renderers (fx-video.js, WebGL2 via glfx.js). Per-effect masks (masks.js) blend each
// effect with its input; masks on 불투명도 cut out the clip. Transitions come from transitionPlan
// (clip options / pieces) or shader plans (transitions2.js) that receive both clips rendered alone.

import { clipsOnTrack, clipEnd, evalEffect, mediaTimeAt, videoTracks, getTrack } from './model.js';
import { ensureFont, fontSheetPending, isGenericFamily } from './fonts.js';
import { EFFECTS } from './effects.js';
import { clamp } from './util.js';
import { PIXEL_FX, TRANSITION_PLANS } from './fx-registry.js';
import { blurCanvas } from './fx-video.js';
import './transitions2.js';
import { MaskRaster, activeMasks, evalMask } from './masks.js';
import { applyLumetri, applyLut, curveTable } from './lumetri.js';

export { PIXEL_FX, TRANSITION_PLANS, curveTable };

const FILTER_FX = new Set(['brightnessContrast', 'basicColor', 'hueShift', 'gaussianBlur', 'blackWhite', 'sepia', 'invert', 'sharpen', 'findEdges', 'posterize']);
const TRANSFORM_FX = new Set(['dropShadow', 'hFlip', 'vFlip', 'cameraShake', 'stabilize', 'trackMatte', 'blurFill']);
/** Effects that spread pixels outwards: on text and shapes (frame-sized layers in Premiere) they need room. */
const SPREAD_FX = new Set(['gaussianBlur', 'directionalBlur', 'channelBlur', 'cameraBlur', 'glow', 'rgbSplit', 'glitch', 'echo']);
const SVG_NS = 'http://www.w3.org/2000/svg';

let svgRoot = null;

/** Smooth pseudo-random wobble in [-1, 1] (sum of incommensurate sines). */
function wobble(x) {
  return (Math.sin(x * 2.1) + 0.6 * Math.sin(x * 3.7 + 1.3) + 0.3 * Math.sin(x * 5.3 + 2.1)) / 1.9;
}

/** Register (once) an SVG filter usable from canvas `ctx.filter = url(#id)`. */
function svgFilter(kind, value) {
  const id = `mf-${kind}-${String(value).replace(/[^\w-]/g, '')}`;
  if (document.getElementById(id)) return `url(#${id})`;
  if (!svgRoot) {
    svgRoot = document.createElementNS(SVG_NS, 'svg');
    svgRoot.setAttribute('width', '0');
    svgRoot.setAttribute('height', '0');
    svgRoot.style.position = 'absolute';
    svgRoot.setAttribute('aria-hidden', 'true');
    document.body.append(svgRoot);
  }
  const f = document.createElementNS(SVG_NS, 'filter');
  f.id = id;
  f.setAttribute('color-interpolation-filters', 'sRGB');
  const el = (tag, attrs, parent = f) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.append(e);
    return e;
  };
  if (kind === 'sharpen') {
    const k = value / 100;
    el('feConvolveMatrix', { order: '3', kernelMatrix: `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`, preserveAlpha: 'true' });
  } else if (kind === 'edges') {
    el('feConvolveMatrix', { order: '3', kernelMatrix: '-1 -1 -1 -1 8 -1 -1 -1 -1', preserveAlpha: 'true' });
  } else if (kind === 'posterize') {
    const n = Math.max(2, value);
    const table = Array.from({ length: n }, (_, i) => (i / (n - 1)).toFixed(4)).join(' ');
    const ct = el('feComponentTransfer', {});
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) el(ch, { type: 'discrete', tableValues: table }, ct);
  } else if (kind === 'l2a') {
    el('feColorMatrix', { type: 'luminanceToAlpha' });
  } else if (kind === 'tint') {
    const [b, w] = [value.slice(0, 6), value.slice(6, 12)];
    const c = (hex, i) => (parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255).toFixed(4);
    el('feColorMatrix', { type: 'saturate', values: '0' });
    const ct = el('feComponentTransfer', {});
    ['feFuncR', 'feFuncG', 'feFuncB'].forEach((ch, i) => el(ch, { type: 'table', tableValues: `${c(b, i)} ${c(w, i)}` }, ct));
  }
  svgRoot.append(f);
  return `url(#${id})`;
}

let noiseTile = null;
function grainTile() {
  if (!noiseTile) {
    noiseTile = document.createElement('canvas');
    noiseTile.width = noiseTile.height = 256;
    const ctx = noiseTile.getContext('2d');
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return noiseTile;
}

function makeCanvas(w = 2, h = 2) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function sizeCanvas(c, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
  }
  return c.getContext('2d');
}

// Big still images (a phone photo is 12 MP) also keep halved copies: drawing the copy just larger than
// the size on screen is far cheaper than shrinking the original every frame, and smoother too.
const MIPS = new WeakMap();
function mip(img, px) {
  if (!(px > 0) || !img || !('naturalWidth' in img)) return img; // still images only, not video frames
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w * h < 4e6 || w < px * 2) return img;
  let chain = MIPS.get(img);
  if (!chain) MIPS.set(img, (chain = []));
  let level = img;
  for (let i = 0; Math.floor(w / 2) >= px; i++) {
    w = Math.floor(w / 2);
    h = Math.max(1, Math.floor(h / 2));
    if (!chain[i]) {
      const c = makeCanvas(w, h);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(level, 0, 0, w, h);
      chain[i] = c;
    }
    level = chain[i];
  }
  return level;
}

/** On-screen width in pixels of something w units wide drawn with ctx's current transform. */
const onScreenWidth = (ctx, w) => {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) * w;
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

export class Compositor {
  constructor({ onAsyncReady } = {}) {
    this.stageA = makeCanvas();
    this.stageB = makeCanvas();
    this.small = makeCanvas();
    this.trackLayer = makeCanvas();
    this.textCache = new Map();
    this.solidCache = new Map();
    this.onAsyncReady = onAsyncReady || (() => {});
    this.pendingFonts = new Set();
    this.depth = 0;
    this.prefix = '';
    this.subs = new Map();
    this.matteA = makeCanvas();
    this.matteB = makeCanvas();
    this.stabCache = new Map();
    this.preMask = makeCanvas();
    this.layerA = makeCanvas();
    this.layerB = makeCanvas();
    this.layerEmpty = makeCanvas();
    this.textMaskLayer = makeCanvas();
    this.background = null;
  }

  /**
   * Render frame t. ctx must belong to a canvas of size seq.width*scale x seq.height*scale.
   * provider.videoFrame(clip, mediaTime) -> {img,w,h} | {offline:true} | null
   * provider.image(mediaId) -> {img,w,h} | {offline:true} | null
   * provider.media(id) -> media item
   */
  render(ctx, seq, t, provider, { scale = 1, background, angle = null } = {}) {
    // undefined background = the sequence's own colour; null = transparent (nested sequences)
    if (background === undefined) background = seq.background || '#000000';
    this.background = background;
    const W = seq.width;
    const H = seq.height;
    this.scale = scale;
    this.frameT = t;
    this.seq = seq;
    this.provider = provider;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    } else ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const vts = videoTracks(seq);
    const mattes = this.matteTracksAt(seq, t);
    // transition windows are looked up once per track for this frame (the lookup scans every clip)
    this.windowCache = new Map();
    try {
      for (let i = 0; i < vts.length; i++) {
        const track = vts[i];
        if (angle != null ? i !== angle - 1 : track.hidden) continue;
        if (mattes.has(track.id)) continue;
        const job = this.trackJob(seq, track, t);
        if (!job) continue;
        try {
          this.drawJob(ctx, job, t, W, H);
        } catch (err) {
          console.error('render failed for track', track.name, err);
        }
      }
    } finally {
      this.windowCache = null;
    }
    ctx.restore();
  }

  /** transitionsOnTrack, remembered while one frame renders. */
  windowsOn(seq, trackId) {
    const cache = this.windowCache;
    if (!cache) return trackWindows(seq, trackId);
    const key = `${seq.id}\u0000${trackId}`;
    let w = cache.get(key);
    if (!w) cache.set(key, (w = trackWindows(seq, trackId)));
    return w;
  }

  /** Tracks used (and hidden) as track mattes by clips visible at time t. */
  matteTracksAt(seq, t) {
    const out = new Set();
    for (const c of Object.values(seq.clips)) {
      if (c.enabled === false || t < c.start || t >= clipEnd(c)) continue;
      const fx = c.effects.find((e) => e.type === 'trackMatte' && e.enabled);
      if (fx && fx.params.hideMatte.value && fx.params.track.value && fx.params.track.value !== c.trackId) out.add(fx.params.track.value);
    }
    return out;
  }

  /** Work out what to draw on a track at time t (handles transitions). */
  trackJob(seq, track, t) {
    const clips = clipsOnTrack(seq, track.id).filter((c) => c.enabled !== false);
    if (!clips.length) return null;
    const windows = this.windowsOn(seq, track.id);
    for (const w of windows) {
      if (t < w.start || t >= w.end) continue;
      const p = clamp((t - w.start) / Math.max(1e-6, w.end - w.start), 0, 1);
      const aOk = w.a && w.a.enabled !== false;
      const bOk = w.b && w.b.enabled !== false;
      if (w.a && w.b) {
        if (aOk && bOk) return { kind: 'two', a: w.a, b: w.b, type: w.type, p };
        const only = aOk ? w.a : bOk ? w.b : null;
        if (only && t >= only.start && t < clipEnd(only)) return { kind: 'one', clip: only };
        continue;
      }
      const clip = w.a || w.b;
      if (clip.enabled === false) continue;
      return { kind: 'one', clip, type: w.type, reveal: w.edge === 'in' ? p : 1 - p, edge: w.edge };
    }
    const c = clips.find((x) => t >= x.start && t < clipEnd(x));
    return c ? { kind: 'one', clip: c } : null;
  }

  drawJob(ctx, job, t, W, H) {
    if (job.kind === 'one') {
      const { clip, type, reveal } = job;
      if (clip.kind === 'adjustment') return this.applyAdjustment(ctx, clip, t, type ? reveal : 1);
      if (!type) return this.drawClip(ctx, clip, t, {});
      const dir = (job.edge === 'in' ? clip.transIn : clip.transOut)?.direction;
      if (type === 'dipToBlack' || type === 'dipToWhite') {
        return this.drawClip(ctx, clip, t, { dip: { color: type === 'dipToBlack' ? '#000000' : '#ffffff', amount: 1 - reveal } });
      }
      // one-sided transitions run the two-sided plan with only this clip present
      const p = job.edge === 'in' ? reveal : 1 - reveal;
      const plan = transitionPlan(type, p, dir, W, H);
      if (plan.render) {
        return this.drawShaderTransition(ctx, plan, job.edge === 'in' ? null : clip, job.edge === 'in' ? clip : null, t, p, dir, clip);
      }
      const o = job.edge === 'in' ? plan.b : plan.a;
      if (o) this.drawPieces(ctx, clip, t, o);
      return;
    }
    const { a, b, type, p } = job;
    if (a.kind === 'adjustment' || b.kind === 'adjustment') {
      // adjustment layers cross-fade their strength
      if (a.kind === 'adjustment') this.applyAdjustment(ctx, a, t, 1 - p);
      else this.drawClip(ctx, a, t, { alpha: 1 - p });
      if (b.kind === 'adjustment') this.applyAdjustment(ctx, b, t, p);
      else this.drawClip(ctx, b, t, { alpha: p });
      return;
    }
    const dir = b.transIn?.direction;
    const plan = transitionPlan(type, p, dir, W, H);
    if (plan.render) return this.drawShaderTransition(ctx, plan, a, b, t, p, dir, p < 0.5 ? a : b);
    if (plan.layer) {
      // dissolves blend linearly inside a track layer, then composite with the clip blend mode
      const s = this.scale;
      const lctx = sizeCanvas(this.trackLayer, W * s, H * s);
      lctx.setTransform(s, 0, 0, s, 0, 0);
      if (plan.a) this.drawClip(lctx, a, t, { ...plan.a, composite: plan.layer === 'additive' ? 'lighter' : 'source-over' });
      if (plan.b) this.drawClip(lctx, b, t, { ...plan.b, composite: 'lighter' });
      const blend = this.clipBlend(p < 0.5 ? a : b, t);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = blend;
      ctx.drawImage(this.trackLayer, 0, 0);
      ctx.restore();
      return;
    }
    if (plan.bFirst) {
      if (plan.b) this.drawPieces(ctx, b, t, plan.b);
      if (plan.a) this.drawPieces(ctx, a, t, plan.a);
      return;
    }
    if (plan.a) this.drawPieces(ctx, a, t, plan.a);
    if (plan.b) this.drawPieces(ctx, b, t, plan.b);
  }

  /** Draw a clip once per option set (a transition plan side may cut a clip into pieces). */
  drawPieces(ctx, clip, t, o) {
    if (Array.isArray(o)) for (const piece of o) this.drawClip(ctx, clip, t, piece);
    else this.drawClip(ctx, clip, t, o);
  }

  /** A clip rendered alone into a frame-sized layer canvas (transparent around it). */
  clipLayer(which, clip, t) {
    const W = this.seq.width;
    const H = this.seq.height;
    const s = this.scale;
    const canvas = which === 'A' ? this.layerA : which === 'B' ? this.layerB : this.layerEmpty;
    const lctx = sizeCanvas(canvas, W * s, H * s);
    if (clip) {
      lctx.setTransform(s, 0, 0, s, 0, 0);
      this.drawClip(lctx, clip, t, { composite: 'source-over' });
    }
    return canvas;
  }

  /** Shader transitions (transitions2.js): both clips rendered alone, mixed on the GPU. */
  drawShaderTransition(ctx, plan, a, b, t, p, dir, blendClip) {
    const A = this.clipLayer(a ? 'A' : 'E', a, t);
    const B = this.clipLayer(b ? 'B' : (a ? 'E' : 'B'), b, t);
    const out = plan.render({ A, B, p, dir, cw: A.width, ch: A.height, k: this.scale });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = this.clipBlend(blendClip, t);
    if (out) ctx.drawImage(out, 0, 0, ctx.canvas.width, ctx.canvas.height);
    else {
      // no WebGL2: fall back to a plain cross-fade
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(A, 0, 0);
      ctx.globalAlpha = p;
      ctx.drawImage(B, 0, 0);
    }
    ctx.restore();
  }

  /**
   * One video track rendered alone at time t into a frame-sized canvas (for effects that read
   * another layer, e.g. 그레이디언트 지우기). Uses a helper compositor so the stage canvases of the
   * clip being processed are left alone. Returns null for the calling track or inside another
   * such render.
   */
  renderTrack(trackId, t, selfTrackId = null) {
    if (this.inTrackRender || !trackId || trackId === selfTrackId) return null;
    const track = getTrack(this.seq, trackId);
    if (!track) return null;
    const W = this.seq.width;
    const H = this.seq.height;
    const s = this.scale;
    const c = this.trackRenderCanvas || (this.trackRenderCanvas = makeCanvas());
    const g = sizeCanvas(c, W * s, H * s);
    const job = this.trackJob(this.seq, track, t);
    if (!job) return c;
    const sub = this.trackSub || (this.trackSub = new Compositor({ onAsyncReady: this.onAsyncReady }));
    Object.assign(sub, { depth: this.depth + 1, prefix: this.prefix, scale: s, seq: this.seq, provider: this.provider, frameT: t, background: null, inTrackRender: true });
    g.setTransform(s, 0, 0, s, 0, 0);
    try {
      sub.drawJob(g, job, t, W, H);
    } catch (err) {
      console.warn('track render failed', err);
    }
    return c;
  }

  clipBlend(clip, t) {
    const op = clip.effects.find((e) => e.type === 'opacity');
    return op ? evalEffect(op, t - clip.start).blend || 'source-over' : 'source-over';
  }

  // ---------------------------------------------------------------- sources

  /** Resolve the drawable for a clip at time t: {img, w, h, fit} where w,h are logical sequence-space dims. */
  getSource(clip, t, tl) {
    const seq = this.seq;
    const W = seq.width;
    const H = seq.height;
    switch (clip.kind) {
      case 'video': {
        const m = this.provider.media(clip.mediaId);
        const mt = clampMediaTime(mediaTimeAt(clip, t), m);
        return this.provider.videoFrame(clip, mt, this.prefix + clip.id);
      }
      case 'nest': {
        // nested sequence: render it (transparent background) into its own canvas
        const m = this.provider.media(clip.mediaId);
        const inner = m && this.provider.sequence?.(m.sequenceId);
        if (!inner || this.depth >= 8) return null;
        const mt = clampMediaTime(mediaTimeAt(clip, t), m);
        const key = `${this.prefix}${clip.id}/`;
        let sub = this.subs.get(key);
        if (!sub) {
          sub = new Compositor({ onAsyncReady: this.onAsyncReady });
          sub.depth = this.depth + 1;
          sub.prefix = key;
          sub.canvas = makeCanvas();
          if (this.subs.size > 32) this.subs.clear();
          this.subs.set(key, sub);
        }
        const sc = clamp(this.scale * Math.max(W / inner.width, H / inner.height), 0.05, 2);
        const cw = Math.max(2, Math.round(inner.width * sc));
        const ch = Math.max(2, Math.round(inner.height * sc));
        if (sub.canvas.width !== cw || sub.canvas.height !== ch) {
          sub.canvas.width = cw;
          sub.canvas.height = ch;
        }
        const angle = clip.multicam && inner.multicam ? clip.multicam.angle : null;
        sub.render(sub.canvas.getContext('2d'), inner, mt, this.provider, { scale: cw / inner.width, background: angle ? '#000000' : null, angle });
        return { img: sub.canvas, w: inner.width, h: inner.height, fit: true };
      }
      case 'image':
        return this.provider.image(clip.mediaId);
      case 'color': {
        const fill = clip.effects.find((e) => e.type === 'fill');
        const color = fill ? evalEffect(fill, tl).color : '#000000';
        return { img: this.solid(color), w: W, h: H, fit: false };
      }
      case 'text':
      case 'shape': {
        const fx = clip.effects.find((e) => e.type === clip.kind);
        const motion = clip.effects.find((e) => e.type === 'motion');
        const mv = motion ? evalEffect(motion, tl) : null;
        const sc = mv ? Math.max(Math.abs(mv.scale), mv.uniform === false ? Math.abs(mv.scaleW ?? 100) : 0) / 100 : 1;
        const k = clamp(this.scale * Math.max(1, sc), 0.25, 4);
        return clip.kind === 'text' ? this.textSource(evalEffect(fx, tl), k) : this.shapeSource(evalEffect(fx, tl), k);
      }
      default:
        return null;
    }
  }

  solid(color) {
    let c = this.solidCache.get(color);
    if (!c) {
      c = makeCanvas(4, 4);
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.fillRect(0, 0, 4, 4);
      if (this.solidCache.size > 64) this.solidCache.clear();
      this.solidCache.set(color, c);
    }
    return c;
  }

  shapeSource(p, k) {
    const key = 'shape:' + JSON.stringify(p) + '|' + k.toFixed(3);
    const hit = this.textCache.get(key);
    if (hit) return hit;
    const sw = Math.max(0, p.strokeWidth || 0);
    const isLine = p.shape === 'line';
    const sw2 = isLine ? Math.max(1, sw) : sw;
    const bw = Math.max(1, p.width);
    const bh = isLine ? sw2 : Math.max(1, p.height);
    const w = Math.ceil(bw + sw2 + 2);
    const h = Math.ceil(bh + (isLine ? 2 : sw2 + 2));
    const c = makeCanvas(Math.max(1, Math.ceil(w * k)), Math.max(1, Math.ceil(h * k)));
    const ctx = c.getContext('2d');
    ctx.scale(k, k);
    const x0 = (w - bw) / 2;
    const y0 = (h - bh) / 2;
    ctx.beginPath();
    if (p.shape === 'ellipse') ctx.ellipse(w / 2, h / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
    else if (p.shape === 'triangle') {
      ctx.moveTo(w / 2, y0);
      ctx.lineTo(x0 + bw, y0 + bh);
      ctx.lineTo(x0, y0 + bh);
      ctx.closePath();
    } else if (isLine) {
      ctx.moveTo(x0, h / 2);
      ctx.lineTo(x0 + bw, h / 2);
    } else roundRectPath(ctx, x0, y0, bw, bh, Math.min(p.radius || 0, bw / 2, bh / 2));
    if (p.fillOn && !isLine) {
      if (p.gradient) {
        const a = ((p.gradAngle || 0) * Math.PI) / 180;
        const dx = (Math.cos(a) * bw) / 2;
        const dy = (Math.sin(a) * bh) / 2;
        const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
        g.addColorStop(0, p.fill);
        g.addColorStop(1, p.fill2);
        ctx.fillStyle = g;
      } else ctx.fillStyle = p.fill;
      ctx.fill();
    }
    if (sw2 > 0 && (sw > 0 || isLine)) {
      ctx.strokeStyle = isLine && !sw ? p.fill : p.strokeColor;
      ctx.lineWidth = sw2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    const src = { img: c, w, h, fit: false };
    if (this.textCache.size > 80) this.textCache.clear();
    this.textCache.set(key, src);
    return src;
  }

  textSource(p, k) {
    const key = JSON.stringify(p) + '|' + k.toFixed(3);
    const hit = this.textCache.get(key);
    if (hit) return hit;
    const weight = p.bold ? '700' : '400';
    const style = p.italic ? 'italic ' : '';
    const fontSpec = `${style}${weight} ${p.size}px "${p.font}"`;
    const generic = isGenericFamily(p.font);
    const font = generic ? `${style}${weight} ${p.size}px ${p.font}` : `${fontSpec}, "Noto Sans KR", sans-serif`;
    if (!generic && document.fonts) {
      // Korean web fonts are split into many unicode-range files: load the ones this text needs
      // (after the family's stylesheet), then redraw.
      const text = String(p.content ?? '') || ' ';
      if (fontSheetPending(p.font) || !document.fonts.check(fontSpec, text)) {
        const pk = `${fontSpec}|${text}`;
        if (!this.pendingFonts.has(pk)) {
          if (this.pendingFonts.size > 400) this.pendingFonts.clear();
          this.pendingFonts.add(pk);
          ensureFont(p.font).then(() => document.fonts.load(fontSpec, text)).then(() => {
            this.textCache.clear();
            this.onAsyncReady();
          }).catch(() => {});
        }
      }
    }
    const lines = String(p.content ?? '').split('\n');
    const measure = makeCanvas(2, 2).getContext('2d');
    measure.font = font;
    if ('letterSpacing' in measure) measure.letterSpacing = `${p.tracking || 0}px`;
    const widths = lines.map((l) => measure.measureText(l || ' ').width);
    const lineH = p.size * (p.lineHeight || 120) / 100;
    const pad = p.background ? p.bgPadding : 0;
    // strokes wrap the glyphs from the inside out: 외곽선, 외곽선 2, 외곽선 3
    const strokes = [];
    let reach = 0;
    for (const [wk, ck] of [['strokeWidth', 'strokeColor'], ['stroke2Width', 'stroke2Color'], ['stroke3Width', 'stroke3Color']]) {
      const sw = Math.max(0, p[wk] || 0);
      if (sw <= 0) continue;
      reach += sw;
      strokes.push({ width: reach, color: p[ck] || '#000000' });
    }
    const stroke = reach;
    const shadowOn = !!p.shadowOn && (p.shadowOpacity ?? 75) > 0;
    const sDist = shadowOn ? Math.max(0, p.shadowDistance || 0) : 0;
    const sBlur = shadowOn ? Math.max(0, p.shadowBlur || 0) : 0;
    const sSize = shadowOn ? Math.max(0, p.shadowSize || 0) : 0;
    // room for the shadow on every side keeps the text box centred on the clip position
    const margin = shadowOn ? Math.ceil(sDist + sBlur * 1.5 + sSize + 2) : 0;
    const bw = Math.ceil(Math.max(1, ...widths) + pad * 2 + stroke * 2 + 4);
    const bh = Math.ceil(lineH * lines.length + pad * 2 + stroke * 2 + 4);
    const w = bw + margin * 2;
    const h = bh + margin * 2;
    const c = makeCanvas(Math.max(1, Math.ceil(w * k)), Math.max(1, Math.ceil(h * k)));
    const ctx = c.getContext('2d');
    ctx.scale(k, k);
    if (p.background) {
      const [r, g, b] = hexToRgb(p.bgColor);
      ctx.fillStyle = `rgba(${r},${g},${b},${(p.bgOpacity ?? 100) / 100})`;
      roundRect(ctx, margin, margin, bw, bh, Math.min(p.bgRadius ?? Math.min(16, pad / 2), bw / 2, bh / 2));
      ctx.fill();
    }
    const inner = bw - pad * 2 - stroke * 2;
    // typewriter reveal: show only the first N characters, laid out in their final positions
    const total = Array.from(String(p.content ?? '')).length;
    const revealN = p.reveal == null ? Infinity : Math.round((total * clamp(p.reveal, 0, 100)) / 100);
    const eachLine = (fn) => {
      let remaining = revealN;
      lines.forEach((full, i) => {
        const chars = Array.from(full);
        const line = remaining >= chars.length ? full : chars.slice(0, Math.max(0, remaining)).join('');
        remaining -= chars.length + 1;
        if (!line) return;
        const lw = widths[i];
        let x = margin + pad + stroke + 2;
        if (p.align === 'center') x += (inner - 4 - lw) / 2;
        else if (p.align === 'right') x += inner - 4 - lw;
        const y = margin + pad + stroke + 2 + lineH * (i + 0.5);
        fn(line, x, y);
      });
    };
    const setup = (g) => {
      g.font = font;
      if ('letterSpacing' in g) g.letterSpacing = `${p.tracking || 0}px`;
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
    };
    setup(ctx);
    if (shadowOn) {
      // 그림자: the glyph silhouette (with strokes and 크기 spread), blurred and offset
      const sh = makeCanvas(c.width, c.height);
      const sg = sh.getContext('2d');
      sg.scale(k, k);
      setup(sg);
      const rad = ((p.shadowAngle ?? 135) * Math.PI) / 180;
      const dx = Math.sin(rad) * sDist;
      const dy = -Math.cos(rad) * sDist;
      sg.fillStyle = sg.strokeStyle = p.shadowColor || '#000000';
      sg.lineWidth = (stroke + sSize) * 2;
      eachLine((line, x, y) => {
        if (stroke + sSize > 0) sg.strokeText(line, x + dx, y + dy);
        sg.fillText(line, x + dx, y + dy);
      });
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (sBlur > 0.3) ctx.filter = `blur(${(sBlur * k) / 2}px)`;
      ctx.globalAlpha = clamp((p.shadowOpacity ?? 75) / 100, 0, 1);
      ctx.drawImage(sh, 0, 0);
      ctx.restore();
    }
    for (let i = strokes.length - 1; i >= 0; i--) {
      ctx.strokeStyle = strokes[i].color;
      ctx.lineWidth = strokes[i].width * 2;
      eachLine((line, x, y) => ctx.strokeText(line, x, y));
    }
    if (p.fillOn !== false) {
      let style = p.color;
      const x0 = margin + pad + stroke;
      const y0 = margin + pad + stroke;
      const tw = bw - (pad + stroke) * 2;
      const th = bh - (pad + stroke) * 2;
      if (p.fillType === 'linear') {
        const a = ((p.gradAngle ?? 90) * Math.PI) / 180;
        const half = (Math.abs(Math.cos(a)) * tw + Math.abs(Math.sin(a)) * th) / 2;
        const cx = x0 + tw / 2;
        const cy = y0 + th / 2;
        style = ctx.createLinearGradient(cx - Math.cos(a) * half, cy - Math.sin(a) * half, cx + Math.cos(a) * half, cy + Math.sin(a) * half);
        style.addColorStop(0, p.color);
        style.addColorStop(1, p.color2 || p.color);
      } else if (p.fillType === 'radial') {
        style = ctx.createRadialGradient(x0 + tw / 2, y0 + th / 2, 0, x0 + tw / 2, y0 + th / 2, Math.max(tw, th) / 2);
        style.addColorStop(0, p.color);
        style.addColorStop(1, p.color2 || p.color);
      }
      ctx.fillStyle = style;
      eachLine((line, x, y) => ctx.fillText(line, x, y));
    }
    const src = { img: c, w, h, fit: false };
    if (p.point) {
      // point text: the clip position is the first line's baseline, at its left end (정렬 왼쪽),
      // middle or right end; cx / cy is where the box centre lies from there
      const ox = p.align === 'center' ? margin + bw / 2 : p.align === 'right' ? margin + bw - pad - stroke - 2 : margin + pad + stroke + 2;
      measure.textBaseline = 'middle';
      const base = measure.measureText(lines[0] || ' ').alphabeticBaseline;
      const oy = margin + pad + stroke + 2 + lineH / 2 + (Number.isFinite(base) ? -base : p.size * 0.35);
      src.cx = w / 2 - ox;
      src.cy = h / 2 - oy;
    }
    if (this.textCache.size > 80) this.textCache.clear();
    this.textCache.set(key, src);
    return src;
  }

  /** Logical size of a clip's source (for bounding boxes in the monitor). */
  sourceSize(clip, t) {
    const tl = t - clip.start;
    if (clip.kind === 'text' || clip.kind === 'shape') {
      const src = this.getSourceSafe(clip, t, tl);
      return src ? { w: src.w, h: src.h, fit: false, cx: src.cx || 0, cy: src.cy || 0 } : null;
    }
    if (clip.kind === 'color') return { w: this.seq.width, h: this.seq.height, fit: false };
    const m = this.provider?.media(clip.mediaId);
    if (!m || !m.width) return null;
    return { w: m.width, h: m.height, fit: true };
  }

  getSourceSafe(clip, t, tl) {
    try {
      return this.getSource(clip, t, tl);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Draw one clip. opts: { alpha, composite, offsetX, offsetY, blur, frameZoom, clipPath(ctx),
   * dip:{color,amount} }
   */
  drawClip(ctx, clip, t, opts = {}) {
    const seq = this.seq;
    const W = seq.width;
    const H = seq.height;
    const tl = t - clip.start;
    let src = this.getSource(clip, t, tl);
    if (!src) return;
    if (src.offline) {
      this.drawOffline(ctx, W, H, src.message);
      return;
    }

    const fx = {};
    const userFx = [];
    let opacityFx = null;
    for (const e of clip.effects) {
      if (!e.enabled) continue;
      const def = EFFECTS[e.type];
      if (!def) continue;
      const v = evalEffect(e, tl);
      if (def.fixed) {
        fx[e.type] = v;
        if (e.type === 'opacity') opacityFx = e;
      } else userFx.push({ type: e.type, v, fx: e, masks: activeMasks(e) });
    }
    // 텍스트로 마스크: the glyphs cut the tracks below instead of being drawn
    if (clip.kind === 'text' && fx.text?.textMask && !opts._noTextMask) return this.drawTextMask(ctx, clip, t, opts, !!fx.text.maskInvert);
    const motion = fx.motion || { posX: W / 2, posY: H / 2, scale: 100, rotation: 0, anchorX: 0, anchorY: 0 };
    const opacity = fx.opacity ? fx.opacity.opacity / 100 : 1;
    const blend = fx.opacity?.blend || 'source-over';
    const alpha = clamp(opacity * (opts.alpha ?? 1), 0, 1);
    if (alpha <= 0.001) return;

    // pictures are fitted to the frame (프레임 크기로 비율 조정) unless the clip keeps its own pixels
    // (clip.native: 프레임 크기로 설정 / 기본 미디어 비율 조정 없음, where 모션 ▸ 비율 sizes it)
    const baseScale = src.fit && !clip.native ? Math.min(W / src.w, H / src.h) : 1;
    let flipX = 1;
    let flipY = 1;
    const matte = !opts._noMatte && userFx.find((f) => f.type === 'trackMatte' && f.v.track && f.v.track !== clip.trackId)?.v;
    if (matte && this.depth < 6 && !this.inMatte) return this.drawWithMatte(ctx, clip, t, opts, matte, blend);
    const shadow = userFx.find((f) => f.type === 'dropShadow')?.v;
    const shake = userFx.find((f) => f.type === 'cameraShake')?.v;
    const stab = userFx.find((f) => f.type === 'stabilize')?.v;
    const fill = userFx.find((f) => f.type === 'blurFill')?.v;
    const stageFx = userFx.filter((f) => !TRANSFORM_FX.has(f.type));
    for (const f of userFx) {
      if (f.type === 'hFlip') flipX = -flipX;
      if (f.type === 'vFlip') flipY = -flipY;
    }
    const opMasks = opacityFx ? activeMasks(opacityFx) : null;
    // text and shapes are only as big as their content: effects that work in frame space (변형,
    // 기본 3D, generators, wipes…) or spread outwards (blurs, glow) get the source padded out to
    // the sequence frame around it
    if (!src.fit && stageFx.some((f) => EFFECTS[f.type]?.frameSpace || SPREAD_FX.has(f.type))) src = padSource(src, W, H);

    let img = src.img;
    if (stageFx.length || opts.dip || opMasks) {
      // process at roughly the on-screen resolution
      const onScreen = baseScale * this.scale * Math.max(1, Math.abs(motion.scale) / 100, motion.uniform === false ? Math.abs(motion.scaleW ?? 100) / 100 : 0);
      img = this.processStage(src, stageFx, opts.dip, clamp(onScreen, 0.05, 1), clip, tl, { baseScale, opMasks, opacityFx });
    }

    if (fill) {
      // background fill behind a clip that does not cover the frame (e.g. a vertical phone video)
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = opts.composite || blend;
      if (fill.mode === 'color') {
        ctx.fillStyle = fill.color;
        ctx.fillRect(0, 0, W, H);
      } else {
        const cover = Math.max(W / src.w, H / src.h) * 1.1;
        const dw = src.w * cover;
        const dh = src.h * cover;
        if (fill.blur > 0.3) ctx.filter = `blur(${fill.blur * this.scale}px)`;
        ctx.drawImage(img === src.img ? mip(img, onScreenWidth(ctx, dw)) : img, (W - dw) / 2, (H - dh) / 2, dw, dh);
        ctx.filter = 'none';
        if (fill.dim > 0) {
          ctx.fillStyle = `rgba(0,0,0,${clamp(fill.dim / 100, 0, 1)})`;
          ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = opts.composite || blend;
    if (opts.blur > 0.3) ctx.filter = `blur(${opts.blur * this.scale}px)`;
    if (opts.frameZoom && opts.frameZoom !== 1) {
      ctx.translate(W / 2, H / 2);
      ctx.scale(opts.frameZoom, opts.frameZoom);
      ctx.translate(-W / 2, -H / 2);
    }
    if (opts.clipPath) {
      // a transition piece's clip region travels with its offset (가운데 분할, 분할 …)
      const ox = opts.offsetX || 0;
      const oy = opts.offsetY || 0;
      ctx.translate(ox, oy);
      ctx.beginPath();
      opts.clipPath(ctx);
      ctx.clip();
      ctx.translate(-ox, -oy);
    }
    if (shadow) {
      const [r, g, b] = hexToRgb(shadow.color);
      const rad = (shadow.direction * Math.PI) / 180;
      ctx.shadowColor = `rgba(${r},${g},${b},${shadow.opacity / 100})`;
      ctx.shadowOffsetX = Math.sin(rad) * shadow.distance * this.scale;
      ctx.shadowOffsetY = -Math.cos(rad) * shadow.distance * this.scale;
      ctx.shadowBlur = shadow.softness * this.scale;
    }
    // 균일 비율 off: 비율 is the height, 비율 폭 the width
    const s = (baseScale * motion.scale) / 100;
    const sxm = motion.uniform === false ? (baseScale * (motion.scaleW ?? 100)) / 100 : s;
    let shX = 0;
    let shY = 0;
    let shR = 0;
    if (shake) {
      const ph = t * shake.speed;
      shX = shake.amount * wobble(ph);
      shY = shake.amount * wobble(ph + 31.7);
      shR = shake.rotation * wobble(ph + 77.1);
    }
    ctx.translate(motion.posX + (opts.offsetX || 0) + shX, motion.posY + (opts.offsetY || 0) + shY);
    ctx.rotate(((motion.rotation + shR) * Math.PI) / 180);
    ctx.scale(sxm * flipX, s * flipY);
    ctx.translate(-(motion.anchorX || 0) / (sxm || 1), -(motion.anchorY || 0) / (s || 1));
    if (stab && clip.stab) {
      const corr = this.stabCorrection(clip, t, stab, src);
      if (corr) {
        ctx.scale(corr.zoom, corr.zoom);
        ctx.rotate(corr.a);
        ctx.translate(corr.x, corr.y);
      }
    }
    if (src.cx || src.cy) ctx.translate(src.cx || 0, src.cy || 0);
    if (img === src.img) img = mip(img, onScreenWidth(ctx, src.w));
    if (img === src.img && src.inner) {
      const r = src.inner;
      ctx.drawImage(img, -src.w / 2 + r.x, -src.h / 2 + r.y, r.w, r.h);
    } else ctx.drawImage(img, -src.w / 2, -src.h / 2, src.w, src.h);
    ctx.restore();
  }

  /**
   * The clip's processed source at sequence time t, through its enabled effects that come before
   * effect `stopFxId`, on the same stage as `stage` ({ src, ps, baseScale } of the running
   * processStage). Lets time effects (반향, 포스터화 시간) look at other moments of stills, text and
   * shapes exactly. Uses a helper compositor; the returned canvas is only valid until the next call.
   */
  stageAt(clip, t, stopFxId, stage) {
    const sub = this.timeSub || (this.timeSub = new Compositor({ onAsyncReady: this.onAsyncReady }));
    Object.assign(sub, { depth: this.depth + 1, prefix: this.prefix, scale: this.scale, seq: this.seq, provider: this.provider, frameT: t, background: null, inTrackRender: true });
    const tl = t - clip.start;
    let src = sub.getSource(clip, t, tl);
    if (!src || src.offline) return null;
    if (stage.src?.inner && !src.fit) src = padSource(src, this.seq.width, this.seq.height);
    const effects = [];
    for (const e of clip.effects) {
      if (e.id === stopFxId) break;
      const def = EFFECTS[e.type];
      if (!e.enabled || !def || def.fixed || TRANSFORM_FX.has(e.type)) continue;
      effects.push({ type: e.type, v: evalEffect(e, tl), fx: e, masks: activeMasks(e) });
    }
    return sub.processStage(src, effects, null, stage.ps, clip, tl, { baseScale: stage.baseScale });
  }

  /** 텍스트로 마스크: keep (or with 반전, remove) the tracks drawn so far only where the text is. */
  drawTextMask(ctx, clip, t, opts, invert) {
    const W = this.seq.width;
    const H = this.seq.height;
    const s = this.scale;
    const lctx = sizeCanvas(this.textMaskLayer, W * s, H * s);
    lctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawClip(lctx, clip, t, { ...opts, composite: 'source-over', _noTextMask: true });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
    ctx.drawImage(this.textMaskLayer, 0, 0);
    if (this.background && ctx.canvas.width) {
      // what is cut away shows the sequence background, like Premiere's black
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.restore();
  }

  /**
   * Run the per-clip pixel effects. Returns a canvas holding the processed source.
   * extra: { baseScale (fit scale of the source in the frame), opMasks (masks on 불투명도) }.
   */
  processStage(src, effects, dip, ps, clip = null, tl = 0, extra = {}) {
    const w = Math.max(1, Math.round(src.w * ps));
    const h = Math.max(1, Math.round(src.h * ps));
    const seq = this.seq;
    const baseScale = extra.baseScale || 1;
    let cur = this.stageA;
    let alt = this.stageB;
    let cctx = sizeCanvas(cur, w, h);
    const inner = src.inner ? { x: src.inner.x * ps, y: src.inner.y * ps, w: src.inner.w * ps, h: src.inner.h * ps } : null;
    if (inner) cctx.drawImage(mip(src.img, inner.w), inner.x, inner.y, inner.w, inner.h);
    else cctx.drawImage(mip(src.img, w), 0, 0, w, h);
    let filters = [];
    // stage pixels per sequence pixel, and sequence point → stage pixel (clip placed fit, centred)
    const k = ps / baseScale;
    const map = (X, Y) => [(X - seq.width / 2) * k + w / 2, (Y - seq.height / 2) * k + h / 2];

    const flushFilters = () => {
      if (!filters.length) return;
      const actx = sizeCanvas(alt, w, h);
      actx.filter = filters.join(' ');
      actx.drawImage(cur, 0, 0);
      actx.filter = 'none';
      [cur, alt] = [alt, cur];
      cctx = actx;
      filters = [];
    };

    /** Replace the stage with `out` (a canvas of any size, stretched over the stage). */
    const put = (out) => {
      if (!out || out === cur) return;
      cctx.save();
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.globalCompositeOperation = 'copy';
      cctx.globalAlpha = 1;
      cctx.filter = 'none';
      cctx.drawImage(out, 0, 0, w, h);
      cctx.restore();
    };

    const run = (type, v, fxObj) => {
      if (FILTER_FX.has(type)) {
        switch (type) {
          case 'brightnessContrast':
            filters.push(`brightness(${Math.max(0, 1 + v.brightness / 100)})`, `contrast(${Math.max(0, 1 + v.contrast / 100)})`);
            break;
          case 'basicColor':
            filters.push(`brightness(${Math.pow(2, v.exposure / 50)})`, `contrast(${Math.max(0, 1 + v.contrast / 100)})`, `saturate(${Math.max(0, v.saturation / 100)})`);
            if (v.temperature || v.tint) {
              flushFilters();
              this.tint(cctx, cur, w, h, v.temperature, v.tint);
            }
            break;
          case 'hueShift':
            filters.push(`hue-rotate(${v.hue}deg)`);
            break;
          case 'gaussianBlur': {
            if (!(v.blurriness > 0)) break;
            const r = v.blurriness * ps;
            if ((!v.dims || v.dims === 'both') && !v.repeatEdges) {
              filters.push(`blur(${r}px)`);
              break;
            }
            // 흐림 차원 / 가장자리 픽셀 반복
            flushFilters();
            put(blurCanvas(cur, v.dims === 'v' ? 0 : r, v.dims === 'h' ? 0 : r, !!v.repeatEdges, 'gauss'));
            break;
          }
          case 'blackWhite':
            filters.push('grayscale(1)');
            break;
          case 'sepia':
            filters.push(`sepia(${v.amount / 100})`);
            break;
          case 'invert':
            filters.push(`invert(${v.amount / 100})`);
            break;
          case 'sharpen':
            if (v.amount > 0) filters.push(svgFilter('sharpen', Math.round(v.amount)));
            break;
          case 'findEdges':
            filters.push(svgFilter('edges', 0), 'invert(1)');
            break;
          case 'posterize':
            filters.push(svgFilter('posterize', Math.round(clamp(v.levels, 2, 32))));
            break;
        }
        return;
      }
      flushFilters();
      switch (type) {
        case 'mosaic': {
          const bx = clamp(Math.round(v.blocks), 1, w);
          // 세로 블록 0 (older projects): square blocks
          const by = v.vblocks >= 1 ? clamp(Math.round(v.vblocks), 1, h) : Math.max(1, Math.round((bx * h) / w));
          const sctx = sizeCanvas(this.small, bx, by);
          sctx.clearRect(0, 0, bx, by);
          // 선명한 색상: each block takes the colour of its centre pixel (nearest sampling)
          sctx.imageSmoothingEnabled = !v.sharp;
          sctx.drawImage(cur, 0, 0, bx, by);
          sctx.imageSmoothingEnabled = true;
          cctx.clearRect(0, 0, w, h);
          cctx.imageSmoothingEnabled = false;
          cctx.drawImage(this.small, 0, 0, w, h);
          cctx.imageSmoothingEnabled = true;
          break;
        }
        case 'vignette': {
          const [r, g, b] = hexToRgb(v.color);
          const rOuter = Math.hypot(w, h) / 2;
          const rInner = rOuter * clamp(v.midpoint / 100, 0, 0.99);
          const grad = cctx.createRadialGradient(w / 2, h / 2, rInner, w / 2, h / 2, rOuter);
          grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
          grad.addColorStop(1, `rgba(${r},${g},${b},${v.amount / 100})`);
          cctx.save();
          cctx.globalCompositeOperation = 'source-atop';
          cctx.fillStyle = grad;
          cctx.fillRect(0, 0, w, h);
          cctx.restore();
          break;
        }
        case 'glow': {
          if (v.radius <= 0 || v.intensity <= 0) break;
          const actx = sizeCanvas(alt, w, h);
          actx.filter = `blur(${Math.max(0.5, v.radius * ps)}px) brightness(1.15)`;
          actx.drawImage(cur, 0, 0);
          actx.filter = 'none';
          cctx.save();
          cctx.globalCompositeOperation = 'lighter';
          cctx.globalAlpha = clamp(v.intensity / 100, 0, 1);
          cctx.drawImage(alt, 0, 0);
          cctx.restore();
          break;
        }
        case 'filmGrain': {
          if (v.amount <= 0) break;
          const mask = sizeCanvas(this.small, w, h);
          mask.drawImage(cur, 0, 0);
          const frame = Math.floor((this.frameT || 0) * 30);
          const ox = (frame * 97) % 256;
          const oy = (frame * 57) % 256;
          const pat = cctx.createPattern(grainTile(), 'repeat');
          pat.setTransform(new DOMMatrix().translate(ox, oy).scale(Math.max(0.5, v.size * ps)));
          cctx.save();
          cctx.globalCompositeOperation = 'overlay';
          cctx.globalAlpha = clamp(v.amount / 100, 0, 1);
          cctx.fillStyle = pat;
          cctx.fillRect(0, 0, w, h);
          cctx.globalCompositeOperation = 'destination-in';
          cctx.globalAlpha = 1;
          cctx.drawImage(this.small, 0, 0);
          cctx.restore();
          break;
        }
        case 'tint': {
          if (v.amount <= 0) break;
          const actx = sizeCanvas(alt, w, h);
          actx.filter = svgFilter('tint', `${v.black.slice(1, 7)}${v.white.slice(1, 7)}`);
          actx.drawImage(cur, 0, 0);
          actx.filter = 'none';
          cctx.save();
          cctx.globalCompositeOperation = 'source-atop';
          cctx.globalAlpha = clamp(v.amount / 100, 0, 1);
          cctx.drawImage(alt, 0, 0);
          cctx.restore();
          break;
        }
        case 'letterbox': {
          const target = Math.max(0.1, v.aspect);
          cctx.save();
          cctx.fillStyle = v.color;
          if (w / h < target) {
            const bar = (h - w / target) / 2;
            cctx.fillRect(0, 0, w, bar);
            cctx.fillRect(0, h - bar, w, bar);
          } else {
            const bar = (w - h * target) / 2;
            cctx.fillRect(0, 0, bar, h);
            cctx.fillRect(w - bar, 0, bar, h);
          }
          cctx.restore();
          break;
        }
        case 'mask': {
          const mctx = this.buildMask(v, w, h, ps);
          cctx.save();
          cctx.globalCompositeOperation = v.invert ? 'destination-out' : 'destination-in';
          cctx.drawImage(mctx.canvas, 0, 0);
          cctx.restore();
          break;
        }
        case 'censor': {
          const mctx = this.buildMask({ ...v, opacity: 100, invert: false, expansion: 0, rotation: 0 }, w, h, ps);
          const actx = sizeCanvas(alt, w, h);
          if (v.mode === 'blur') {
            actx.filter = `blur(${Math.max(1, v.strength * ps)}px)`;
            actx.drawImage(cur, 0, 0);
            actx.filter = 'none';
          } else {
            const bs = Math.max(2, v.strength * ps);
            const sw2 = Math.max(1, Math.round(w / bs));
            const sh2 = Math.max(1, Math.round(h / bs));
            const sctx = sizeCanvas(this.small, sw2, sh2);
            sctx.drawImage(cur, 0, 0, sw2, sh2);
            actx.imageSmoothingEnabled = false;
            actx.drawImage(this.small, 0, 0, w, h);
            actx.imageSmoothingEnabled = true;
          }
          actx.globalCompositeOperation = 'destination-in';
          actx.drawImage(mctx.canvas, 0, 0);
          actx.globalCompositeOperation = 'source-over';
          cctx.drawImage(alt, 0, 0);
          break;
        }
        case 'lumetri':
          put(applyLumetri(cur, v, { lut: (id) => this.provider.lut?.(id) || null, k }));
          break;
        case 'lut': {
          const lutData = v.lutId ? this.provider.lut?.(v.lutId) : null;
          if (lutData) put(applyLut(cur, lutData, v.intensity / 100));
          break;
        }
        case 'crop': {
          let l = (clamp(v.left, 0, 100) / 100) * w;
          let tp = (clamp(v.top, 0, 100) / 100) * h;
          let r = (clamp(v.right, 0, 100) / 100) * w;
          let b = (clamp(v.bottom, 0, 100) / 100) * h;
          if (v.zoom && w - l - r > 1 && h - tp - b > 1) {
            // 확대/축소: the part that is left fills the frame again
            const actx = sizeCanvas(alt, w, h);
            actx.drawImage(cur, l, tp, w - l - r, h - tp - b, 0, 0, w, h);
            [cur, alt] = [alt, cur];
            cctx = actx;
            l = tp = r = b = 0;
          }
          const fe = Math.max(0, v.feather || 0) * k;
          if (fe > 0.3) {
            // 가장자리 페더: a soft-edged rectangle (drawn on a padded canvas so the frame edge fades too)
            const pad = Math.ceil(fe) + 2;
            const mc = sizeCanvas(this.small, w + pad * 2, h + pad * 2);
            mc.filter = `blur(${fe / 2}px)`;
            mc.fillStyle = '#fff';
            mc.fillRect(pad + l + fe / 2, pad + tp + fe / 2, Math.max(0, w - l - r - fe), Math.max(0, h - tp - b - fe));
            mc.filter = 'none';
            cctx.save();
            cctx.globalCompositeOperation = 'destination-in';
            cctx.drawImage(this.small, pad, pad, w, h, 0, 0, w, h);
            cctx.restore();
            break;
          }
          cctx.clearRect(0, 0, l, h);
          cctx.clearRect(w - r, 0, r, h);
          cctx.clearRect(0, 0, w, tp);
          cctx.clearRect(0, h - b, w, b);
          break;
        }
        default: {
          const fn = PIXEL_FX[type];
          if (!fn) break;
          let out;
          try {
            out = fn({ canvas: cur, ctx: cctx, w, h, v, ps, k, map, clip, fx: fxObj, tl, t: (clip?.start || 0) + tl, seq, comp: this, stage: { src, ps, baseScale } });
          } catch (err) {
            console.warn(`effect ${type} failed`, err);
          }
          put(out);
          break;
        }
      }
    };

    for (const { type, v, fx: fxObj, masks } of effects) {
      if (!masks) {
        run(type, v, fxObj);
        continue;
      }
      // masked effect: out = input · (1 − m) + effect · m
      flushFilters();
      const pctx = sizeCanvas(this.preMask, w, h);
      pctx.drawImage(cur, 0, 0);
      run(type, v, fxObj);
      flushFilters();
      const m = this.maskCoverage(masks, tl, w, h, ps, inner);
      if (!m) continue;
      cctx.save();
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.globalAlpha = 1;
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(m, 0, 0);
      pctx.globalCompositeOperation = 'destination-out';
      pctx.drawImage(m, 0, 0);
      pctx.globalCompositeOperation = 'source-over';
      cctx.globalCompositeOperation = 'lighter';
      cctx.drawImage(this.preMask, 0, 0);
      cctx.restore();
    }
    flushFilters();
    if (extra.opMasks) {
      // masks on 불투명도: the clip only shows inside them
      const m = this.maskCoverage(extra.opMasks, tl, w, h, ps, inner);
      if (m) {
        cctx.save();
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        cctx.globalCompositeOperation = 'destination-in';
        cctx.drawImage(m, 0, 0);
        cctx.restore();
      }
    }
    if (dip && dip.amount > 0) {
      cctx.save();
      cctx.globalCompositeOperation = 'source-atop';
      cctx.globalAlpha = clamp(dip.amount, 0, 1);
      cctx.fillStyle = dip.color;
      cctx.fillRect(0, 0, w, h);
      cctx.restore();
    }
    return cur;
  }

  /**
   * MaskRaster.render, kept while the masks look the same: a still (or held) feathered mask was
   * drawn and blurred again every frame. Each mask set has its own raster, so a moving mask costs
   * nothing extra. The returned canvas is only read by the caller.
   */
  maskCoverage(masks, tl, w, h, ps, rect) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const key = JSON.stringify([masks.map((m) => evalMask(m, tl)), w, h, ps, rect]);
    const slots = this.maskSlots || (this.maskSlots = new Map());
    const id = masks.map((m) => m.id).join('|');
    let slot = slots.get(id);
    if (!slot) {
      if (slots.size >= 16) slots.clear();
      slot = { raster: new MaskRaster(), key: null, out: null };
      slots.set(id, slot);
    }
    if (slot.key !== key) {
      slot.out = slot.raster.render(masks, tl, w, h, ps, rect);
      slot.key = key;
    }
    return slot.out;
  }

  /** Warm/cool + magenta/green grade using overlay blending, preserving alpha. */
  tint(cctx, canvas, w, h, temperature, tintAmt) {
    const mask = sizeCanvas(this.small, w, h);
    mask.drawImage(canvas, 0, 0);
    cctx.save();
    cctx.globalCompositeOperation = 'overlay';
    if (temperature) {
      const k = Math.abs(temperature) / 100 * 0.6;
      cctx.fillStyle = temperature > 0 ? `rgba(255,150,40,${k})` : `rgba(40,140,255,${k})`;
      cctx.fillRect(0, 0, w, h);
    }
    if (tintAmt) {
      const k = Math.abs(tintAmt) / 100 * 0.5;
      cctx.fillStyle = tintAmt > 0 ? `rgba(255,40,255,${k})` : `rgba(40,255,80,${k})`;
      cctx.fillRect(0, 0, w, h);
    }
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(this.small, 0, 0);
    cctx.restore();
  }

  /** Mask alpha canvas (w×h, source space) for mask / censor effects. */
  buildMask(v, w, h, ps) {
    // a mask that does not move keeps its drawn (and blurred) canvas; a few are kept so that a mask
    // and a censor on one clip do not push each other out. Callers only read the canvas.
    const key = JSON.stringify([v, w, h, ps]);
    const kept = this.maskCanvases || (this.maskCanvases = new Map());
    const hit = kept.get(key);
    if (hit) return hit.getContext('2d');
    let canvas = null;
    if (kept.size >= 4) {
      const [oldKey, oldCanvas] = kept.entries().next().value;
      kept.delete(oldKey);
      canvas = oldCanvas;
    }
    canvas = canvas || makeCanvas();
    const mctx = sizeCanvas(canvas, w, h);
    const feather = Math.max(0, v.feather || 0) * ps;
    const exp = (v.expansion || 0) * ps;
    if (feather > 0.3) mctx.filter = `blur(${feather / 2}px)`;
    mctx.fillStyle = `rgba(255,255,255,${clamp((v.opacity ?? 100) / 100, 0, 1)})`;
    mctx.beginPath();
    if (v.shape === 'polygon' && Array.isArray(v.points) && v.points.length >= 3) {
      v.points.forEach(([px, py], i) => (i ? mctx.lineTo((px / 100) * w, (py / 100) * h) : mctx.moveTo((px / 100) * w, (py / 100) * h)));
      mctx.closePath();
      mctx.fill();
      if (Math.abs(exp) > 0.05) {
        // 확장: grow by stroking the outline, shrink (negative) by erasing along it
        mctx.strokeStyle = mctx.fillStyle;
        mctx.lineJoin = 'round';
        mctx.lineWidth = Math.abs(exp) * 2;
        if (exp < 0) {
          mctx.globalCompositeOperation = 'destination-out';
          mctx.strokeStyle = '#000';
        }
        mctx.stroke();
        mctx.globalCompositeOperation = 'source-over';
      }
    } else {
      const cx = (v.cx / 100) * w;
      const cy = (v.cy / 100) * h;
      const rw = Math.max(0.5, (v.w / 100) * w / 2 + exp);
      const rh = Math.max(0.5, (v.h / 100) * h / 2 + exp);
      mctx.translate(cx, cy);
      mctx.rotate(((v.rotation || 0) * Math.PI) / 180);
      if (v.shape === 'rectangle') mctx.rect(-rw, -rh, rw * 2, rh * 2);
      else mctx.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2);
      mctx.fill();
      mctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    mctx.filter = 'none';
    kept.set(key, canvas);
    return mctx;
  }

  /** Draw a clip through a track matte taken from another track at the same time. */
  drawWithMatte(ctx, clip, t, opts, matte, blend) {
    const W = this.seq.width;
    const H = this.seq.height;
    const s = this.scale;
    const actx = sizeCanvas(this.matteA, W * s, H * s);
    actx.setTransform(s, 0, 0, s, 0, 0);
    this.drawClip(actx, clip, t, { ...opts, composite: 'source-over', _noMatte: true });
    const track = getTrack(this.seq, matte.track);
    const bctx = sizeCanvas(this.matteB, W * s, H * s);
    bctx.setTransform(s, 0, 0, s, 0, 0);
    if (track) {
      const job = this.trackJob(this.seq, track, t);
      if (job) {
        this.inMatte = true;
        try { this.drawJob(bctx, job, t, W, H); } finally { this.inMatte = false; }
      }
    }
    actx.setTransform(1, 0, 0, 1, 0, 0);
    if (matte.mode === 'luma') {
      // turn brightness into alpha in place
      const tmp = sizeCanvas(this.small, W * s, H * s);
      tmp.filter = svgFilter('l2a', 0);
      tmp.drawImage(this.matteB, 0, 0);
      tmp.filter = 'none';
      actx.globalCompositeOperation = matte.invert ? 'destination-out' : 'destination-in';
      actx.drawImage(this.small, 0, 0);
    } else {
      actx.globalCompositeOperation = matte.invert ? 'destination-out' : 'destination-in';
      actx.drawImage(this.matteB, 0, 0);
    }
    actx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = opts.composite || blend;
    ctx.drawImage(this.matteA, 0, 0);
    ctx.restore();
  }

  /** Stabilization offset (source pixels / radians) and zoom for a clip at time t. */
  stabCorrection(clip, t, v, src) {
    const st = clip.stab;
    const n = st?.x?.length || 0;
    if (n < 2) return null;
    const key = `${clip.id}:${v.smoothness}:${n}:${st.t0}:${st.x[n - 1]}:${st.y[n - 1]}:${st.a[n - 1]}`;
    let c = this.stabCache.get(key);
    if (!c) {
      const r = Math.max(1, Math.round((v.smoothness / 100) * st.fps * 2));
      const smooth = (arr) => {
        const out = new Float32Array(n);
        const pre = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
        for (let i = 0; i < n; i++) {
          const a = Math.max(0, i - r);
          const b = Math.min(n - 1, i + r);
          out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
        }
        return out;
      };
      const xs = smooth(st.x);
      const ys = smooth(st.y);
      const as = smooth(st.a);
      let max = 0;
      for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(xs[i] - st.x[i]), Math.abs(ys[i] - st.y[i]));
      c = { xs, ys, as, max };
      if (this.stabCache.size > 16) this.stabCache.clear();
      this.stabCache.set(key, c);
    }
    const m = this.provider.media(clip.mediaId);
    const mt = clampMediaTime(mediaTimeAt(clip, t), m);
    const f = clamp((mt - st.t0) * st.fps, 0, n - 1);
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    const u = f - i;
    const lerp2 = (A, B) => A[i] * (1 - u) + A[j] * u - (B[i] * (1 - u) + B[j] * u);
    const zoom = 1 + (2 * c.max) / Math.max(1, Math.min(src.w, src.h)) + (v.zoom || 0) / 100;
    return { x: lerp2(c.xs, st.x), y: lerp2(c.ys, st.y), a: v.rotation ? lerp2(c.as, st.a) : 0, zoom };
  }

  applyAdjustment(ctx, clip, t, strength = 1) {
    const tl = t - clip.start;
    const userFx = [];
    let opacity = 1;
    let blend = 'source-over';
    let opMasks = null;
    for (const e of clip.effects) {
      if (!e.enabled || !EFFECTS[e.type]) continue;
      const v = evalEffect(e, tl);
      if (e.type === 'opacity') {
        opacity = v.opacity / 100;
        blend = v.blend;
        opMasks = activeMasks(e);
      } else if (!EFFECTS[e.type].fixed && !TRANSFORM_FX.has(e.type)) userFx.push({ type: e.type, v, fx: e, masks: activeMasks(e) });
    }
    if (!userFx.length) return;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    // the frame below is the source: sizes in sequence pixels scale with the preview resolution.
    // processStage copies it onto its stage first, so no extra full-frame copy is needed here
    const s = this.scale || 1;
    const processed = this.processStage({ img: ctx.canvas, w: cw / s, h: ch / s }, userFx, null, s, clip, tl, { opMasks });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = clamp(opacity * strength, 0, 1);
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(processed, 0, 0, cw, ch);
    ctx.restore();
  }

  drawOffline(ctx, W, H, message) {
    ctx.save();
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(H / 12)}px "Noto Sans KR", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || '미디어 오프라인', W / 2, H / 2);
    ctx.restore();
  }

  /**
   * Corners of a clip's transformed rectangle in sequence coordinates (for monitor handles).
   */
  clipQuad(seq, clip, t, provider) {
    this.seq = seq;
    this.provider = provider;
    this.scale = this.scale || 1;
    const size = this.sourceSize(clip, t);
    if (!size) return null;
    const tl = t - clip.start;
    const motionFx = clip.effects.find((e) => e.type === 'motion');
    if (!motionFx) return null;
    const m = evalEffect(motionFx, tl);
    const base = size.fit && !clip.native ? Math.min(seq.width / size.w, seq.height / size.h) : 1;
    const s = (base * m.scale) / 100;
    const sx = m.uniform === false ? (base * (m.scaleW ?? 100)) / 100 : s;
    const rad = (m.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hw = (size.w * sx) / 2;
    const hh = (size.h * s) / 2;
    // point text lies off its origin (the clip position) by cx / cy source pixels
    const ax = (m.anchorX || 0) - (size.cx || 0) * sx;
    const ay = (m.anchorY || 0) - (size.cy || 0) * s;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
      const lx = x - ax;
      const ly = y - ay;
      return [m.posX + lx * cos - ly * sin, m.posY + lx * sin + ly * cos];
    });
  }
}

/**
 * Same result as model.transitionsOnTrack, but the neighbour lookups use sorted indexes instead of
 * scanning every clip for each clip (a long timeline full of transitions rendered in O(n²) per frame).
 * The neighbour picked is the same: the first matching clip in seq.clips order.
 */
export function trackWindows(seq, trackId) {
  const all = Object.values(seq.clips);
  const own = [];
  for (let i = 0; i < all.length; i++) if (all[i].trackId === trackId) own.push({ c: all[i], i, start: all[i].start, end: clipEnd(all[i]) });
  if (!own.some((o) => o.c.transIn || o.c.transOut)) return [];
  const byEnd = [...own].sort((a, b) => a.end - b.end);
  const byStart = [...own].sort((a, b) => a.start - b.start);
  // first entry (in seq.clips order) whose key is within 1e-4 of v, other than clip `self`
  const near = (list, key, v, self) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][key] < v - 2e-4) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    for (let k = lo; k < list.length && list[k][key] <= v + 2e-4; k++) {
      const o = list[k];
      if (o.c.id === self.id || !(Math.abs(o[key] - v) < 1e-4)) continue;
      if (!best || o.i < best.i) best = o;
    }
    return best ? best.c : undefined;
  };
  const out = [];
  for (const { c, start, end } of byStart) {
    if (c.transIn) {
      const prev = near(byEnd, 'end', start, c);
      const d = c.transIn.duration;
      if (prev) out.push({ clip: c, edge: 'in', type: c.transIn.type, start: c.start - d / 2, end: c.start + d / 2, a: prev, b: c });
      else out.push({ clip: c, edge: 'in', type: c.transIn.type, start: c.start, end: c.start + d, a: null, b: c });
    }
    if (c.transOut && !near(byStart, 'start', end, c)?.transIn) {
      const d = c.transOut.duration;
      out.push({ clip: c, edge: 'out', type: c.transOut.type, start: end - d, end, a: c, b: null });
    }
  }
  return out;
}

/** Direction a transition moves content in, as a unit vector. */
function dirVector(dir) {
  switch (dir) {
    case 'right': return [1, 0];
    case 'up': return [0, -1];
    case 'down': return [0, 1];
    default: return [-1, 0];
  }
}

/**
 * Drawing plan for a two-sided transition at progress p (0..1): options for the outgoing (a)
 * and incoming (b) clip, and whether they are blended in a dissolve layer.
 */
function transitionPlan(type, p, dir, W, H) {
  if (TRANSITION_PLANS[type]) return TRANSITION_PLANS[type](p, dir, W, H);
  const e = p * p * (3 - 2 * p);
  const diag = Math.hypot(W, H);
  switch (type) {
    case 'additiveDissolve':
      return { layer: 'additive', a: { alpha: Math.min(1, 2 * (1 - p)) }, b: { alpha: Math.min(1, 2 * p) } };
    case 'blurDissolve': {
      const bl = Math.sin(Math.PI * p) * 24;
      return { layer: 'dissolve', a: { alpha: 1 - p, blur: bl }, b: { alpha: p, blur: bl } };
    }
    case 'dipToBlack':
    case 'dipToWhite': {
      const color = type === 'dipToBlack' ? '#000000' : '#ffffff';
      return p < 0.5 ? { a: { dip: { color, amount: p * 2 } }, b: null } : { a: null, b: { dip: { color, amount: (1 - p) * 2 } } };
    }
    case 'wipe': {
      const d = dir || 'right';
      const rect = {
        right: (c) => c.rect(0, 0, W * p, H),
        left: (c) => c.rect(W * (1 - p), 0, W * p, H),
        down: (c) => c.rect(0, 0, W, H * p),
        up: (c) => c.rect(0, H * (1 - p), W, H * p),
      }[d];
      return { a: {}, b: { clipPath: rect } };
    }
    case 'barnDoor':
      return { a: {}, b: { clipPath: (c) => c.rect((W / 2) * (1 - p), 0, W * p, H) } };
    case 'clockWipe':
      return {
        a: {},
        b: {
          clipPath: (c) => {
            c.moveTo(W / 2, H / 2);
            c.arc(W / 2, H / 2, diag, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.0001, p));
            c.closePath();
          },
        },
      };
    case 'irisRound':
      return { a: {}, b: { clipPath: (c) => c.arc(W / 2, H / 2, Math.max(0.01, (diag / 2) * p), 0, Math.PI * 2) } };
    case 'push':
    case 'whip': {
      const [mx, my] = dirVector(dir);
      const blur = type === 'whip' ? Math.sin(Math.PI * p) * 30 : 0;
      const k = type === 'whip' ? e : p;
      return {
        a: { offsetX: mx * k * W, offsetY: my * k * H, blur },
        b: { offsetX: -mx * (1 - k) * W, offsetY: -my * (1 - k) * H, blur },
      };
    }
    case 'slide': {
      const [mx, my] = dirVector(dir);
      return { a: {}, b: { offsetX: -mx * (1 - e) * W, offsetY: -my * (1 - e) * H } };
    }
    case 'crossZoom':
      return { layer: 'dissolve', a: { alpha: 1 - p, frameZoom: 1 + 1.5 * e, blur: 14 * p }, b: { alpha: p, frameZoom: 2.5 - 1.5 * e, blur: 14 * (1 - p) } };
    case 'crossDissolve':
    default:
      return { layer: 'dissolve', a: { alpha: 1 - p }, b: { alpha: p } };
  }
}

function clampMediaTime(mt, media) {
  if (!media || !Number.isFinite(media.duration)) return Math.max(0, mt);
  const fps = media.fps || 30;
  return clamp(mt, 0, Math.max(0, media.duration - 1 / fps));
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * A text / shape source padded out to the sequence frame around it (same centre), so frame-space
 * effects have room. `inner` is where the original lies, in logical units.
 */
function padSource(src, W, H) {
  const w = Math.max(W, src.w);
  const h = Math.max(H, src.h);
  return { img: src.img, w, h, fit: false, cx: src.cx, cy: src.cy, inner: { x: (w - src.w) / 2, y: (h - src.h) / 2, w: src.w, h: src.h } };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

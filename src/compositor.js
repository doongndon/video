// Video compositing engine. Draws a sequence frame at time t onto a 2D canvas.
// The same code path is used for the Program monitor and for export so what you see is what
// you get. Frame sources come from a "provider" (live <video> elements for preview, exact
// decoded frames for export).

import { clipsOnTrack, clipEnd, evalEffect, mediaTimeAt, transitionsOnTrack, videoTracks, getTrack } from './model.js';
import { EFFECTS } from './effects.js';
import { clamp } from './util.js';

const FILTER_FX = new Set(['brightnessContrast', 'basicColor', 'hueShift', 'gaussianBlur', 'blackWhite', 'sepia', 'invert', 'sharpen', 'findEdges', 'posterize']);
const TRANSFORM_FX = new Set(['dropShadow', 'hFlip', 'vFlip', 'cameraShake', 'stabilize', 'trackMatte']);
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

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

const shared = { keyer: null, grader: null };

export class Compositor {
  constructor({ onAsyncReady } = {}) {
    this.stageA = makeCanvas();
    this.stageB = makeCanvas();
    this.small = makeCanvas();
    this.trackLayer = makeCanvas();
    this.adjust = makeCanvas();
    this.textCache = new Map();
    this.solidCache = new Map();
    this.onAsyncReady = onAsyncReady || (() => {});
    this.pendingFonts = new Set();
    this.depth = 0;
    this.prefix = '';
    this.subs = new Map();
    this.matteA = makeCanvas();
    this.matteB = makeCanvas();
    this.maskCanvas = makeCanvas();
    this.stabCache = new Map();
  }

  /**
   * Render frame t. ctx must belong to a canvas of size seq.width*scale x seq.height*scale.
   * provider.videoFrame(clip, mediaTime) -> {img,w,h} | {offline:true} | null
   * provider.image(mediaId) -> {img,w,h} | {offline:true} | null
   * provider.media(id) -> media item
   */
  render(ctx, seq, t, provider, { scale = 1, background = '#000000', angle = null } = {}) {
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
    ctx.restore();
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
    const windows = transitionsOnTrack(seq, track.id);
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
      const plan = transitionPlan(type, job.edge === 'in' ? reveal : 1 - reveal, dir, W, H);
      const o = job.edge === 'in' ? plan.b : plan.a;
      if (o) this.drawClip(ctx, clip, t, o);
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
    const plan = transitionPlan(type, p, b.transIn?.direction, W, H);
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
    if (plan.a) this.drawClip(ctx, a, t, plan.a);
    if (plan.b) this.drawClip(ctx, b, t, plan.b);
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
        const sc = motion ? Math.abs(evalEffect(motion, tl).scale) / 100 : 1;
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
    const generic = /^(sans-serif|serif|monospace)$/.test(p.font);
    const font = generic ? `${style}${weight} ${p.size}px ${p.font}` : `${fontSpec}, sans-serif`;
    if (!generic && document.fonts && !document.fonts.check(fontSpec) && !this.pendingFonts.has(fontSpec)) {
      this.pendingFonts.add(fontSpec);
      document.fonts.load(fontSpec).then(() => {
        this.textCache.clear();
        this.onAsyncReady();
      }).catch(() => {});
    }
    const lines = String(p.content ?? '').split('\n');
    const measure = makeCanvas(2, 2).getContext('2d');
    measure.font = font;
    if ('letterSpacing' in measure) measure.letterSpacing = `${p.tracking || 0}px`;
    const widths = lines.map((l) => measure.measureText(l || ' ').width);
    const lineH = p.size * (p.lineHeight || 120) / 100;
    const pad = p.background ? p.bgPadding : 0;
    const stroke = p.strokeWidth || 0;
    const w = Math.ceil(Math.max(1, ...widths) + pad * 2 + stroke * 2 + 4);
    const h = Math.ceil(lineH * lines.length + pad * 2 + stroke * 2 + 4);
    const c = makeCanvas(Math.max(1, Math.ceil(w * k)), Math.max(1, Math.ceil(h * k)));
    const ctx = c.getContext('2d');
    ctx.scale(k, k);
    if (p.background) {
      const [r, g, b] = hexToRgb(p.bgColor);
      ctx.fillStyle = `rgba(${r},${g},${b},${(p.bgOpacity ?? 100) / 100})`;
      roundRect(ctx, 0, 0, w, h, Math.min(16, pad / 2));
      ctx.fill();
    }
    ctx.font = font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${p.tracking || 0}px`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const inner = w - pad * 2 - stroke * 2;
    // typewriter reveal: show only the first N characters, laid out in their final positions
    const total = Array.from(String(p.content ?? '')).length;
    let remaining = p.reveal == null ? Infinity : Math.round((total * clamp(p.reveal, 0, 100)) / 100);
    lines.forEach((full, i) => {
      const chars = Array.from(full);
      const line = remaining >= chars.length ? full : chars.slice(0, Math.max(0, remaining)).join('');
      remaining -= chars.length + 1;
      if (!line) return;
      const lw = widths[i];
      let x = pad + stroke + 2;
      if (p.align === 'center') x += (inner - 4 - lw) / 2;
      else if (p.align === 'right') x += inner - 4 - lw;
      const y = pad + stroke + 2 + lineH * (i + 0.5);
      if (stroke > 0) {
        ctx.strokeStyle = p.strokeColor;
        ctx.lineWidth = stroke * 2;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = p.color;
      ctx.fillText(line, x, y);
    });
    const src = { img: c, w, h, fit: false };
    if (this.textCache.size > 80) this.textCache.clear();
    this.textCache.set(key, src);
    return src;
  }

  /** Logical size of a clip's source (for bounding boxes in the monitor). */
  sourceSize(clip, t) {
    const tl = t - clip.start;
    if (clip.kind === 'text' || clip.kind === 'shape') {
      const src = this.getSourceSafe(clip, t, tl);
      return src ? { w: src.w, h: src.h, fit: false } : null;
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
   * Draw one clip. opts: { alpha, composite, offsetX, clipPath(ctx), dip:{color,amount} }
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
    for (const e of clip.effects) {
      if (!e.enabled) continue;
      const def = EFFECTS[e.type];
      if (!def) continue;
      const v = evalEffect(e, tl);
      if (def.fixed) fx[e.type] = v;
      else userFx.push({ type: e.type, v });
    }
    const motion = fx.motion || { posX: W / 2, posY: H / 2, scale: 100, rotation: 0, anchorX: 0, anchorY: 0 };
    const opacity = fx.opacity ? fx.opacity.opacity / 100 : 1;
    const blend = fx.opacity?.blend || 'source-over';
    const alpha = clamp(opacity * (opts.alpha ?? 1), 0, 1);
    if (alpha <= 0.001) return;

    const baseScale = src.fit ? Math.min(W / src.w, H / src.h) : 1;
    let flipX = 1;
    let flipY = 1;
    const matte = !opts._noMatte && userFx.find((f) => f.type === 'trackMatte' && f.v.track && f.v.track !== clip.trackId)?.v;
    if (matte && this.depth < 6 && !this.inMatte) return this.drawWithMatte(ctx, clip, t, opts, matte, blend);
    const shadow = userFx.find((f) => f.type === 'dropShadow')?.v;
    const shake = userFx.find((f) => f.type === 'cameraShake')?.v;
    const stab = userFx.find((f) => f.type === 'stabilize')?.v;
    const stageFx = userFx.filter((f) => !TRANSFORM_FX.has(f.type));
    for (const f of userFx) {
      if (f.type === 'hFlip') flipX = -flipX;
      if (f.type === 'vFlip') flipY = -flipY;
    }

    let img = src.img;
    if (stageFx.length || opts.dip) {
      // process at roughly the on-screen resolution
      const onScreen = baseScale * this.scale * Math.max(1, Math.abs(motion.scale) / 100);
      img = this.processStage(src, stageFx, opts.dip, clamp(onScreen, 0.05, 1), clip, tl);
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
      ctx.beginPath();
      opts.clipPath(ctx);
      ctx.clip();
    }
    if (shadow) {
      const [r, g, b] = hexToRgb(shadow.color);
      const rad = (shadow.direction * Math.PI) / 180;
      ctx.shadowColor = `rgba(${r},${g},${b},${shadow.opacity / 100})`;
      ctx.shadowOffsetX = Math.sin(rad) * shadow.distance * this.scale;
      ctx.shadowOffsetY = -Math.cos(rad) * shadow.distance * this.scale;
      ctx.shadowBlur = shadow.softness * this.scale;
    }
    const s = (baseScale * motion.scale) / 100;
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
    ctx.scale(s * flipX, s * flipY);
    ctx.translate(-(motion.anchorX || 0) / (s || 1), -(motion.anchorY || 0) / (s || 1));
    if (stab && clip.stab) {
      const corr = this.stabCorrection(clip, t, stab, src);
      if (corr) {
        ctx.scale(corr.zoom, corr.zoom);
        ctx.rotate(corr.a);
        ctx.translate(corr.x, corr.y);
      }
    }
    ctx.drawImage(img, -src.w / 2, -src.h / 2, src.w, src.h);
    ctx.restore();
  }

  /** Run the per-clip pixel effects. Returns a canvas holding the processed source. */
  processStage(src, effects, dip, ps, clip = null, tl = 0) {
    const w = Math.max(1, Math.round(src.w * ps));
    const h = Math.max(1, Math.round(src.h * ps));
    let cur = this.stageA;
    let alt = this.stageB;
    let cctx = sizeCanvas(cur, w, h);
    cctx.drawImage(src.img, 0, 0, w, h);
    let filters = [];

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

    for (const { type, v } of effects) {
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
          case 'gaussianBlur':
            if (v.blurriness > 0) filters.push(`blur(${v.blurriness * ps}px)`);
            break;
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
        continue;
      }
      flushFilters();
      switch (type) {
        case 'mosaic': {
          const bx = clamp(Math.round(v.blocks), 1, w);
          const by = Math.max(1, Math.round((bx * h) / w));
          const sctx = sizeCanvas(this.small, bx, by);
          sctx.imageSmoothingEnabled = true;
          sctx.drawImage(cur, 0, 0, bx, by);
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
        case 'lut': {
          const grader = this.getGrader();
          if (!grader) break;
          const lutData = type === 'lut' && v.lutId ? this.provider.lut?.(v.lutId) : null;
          if (type === 'lut' && !lutData) break;
          const out = type === 'lut' ? grader.applyLut(cur, lutData, v.lutId, v.intensity / 100) : grader.applyGrade(cur, v);
          if (out) {
            cctx.save();
            cctx.globalCompositeOperation = 'copy';
            cctx.drawImage(out, 0, 0, w, h);
            cctx.restore();
          }
          break;
        }
        case 'crop': {
          const l = (clamp(v.left, 0, 100) / 100) * w;
          const tp = (clamp(v.top, 0, 100) / 100) * h;
          const r = (clamp(v.right, 0, 100) / 100) * w;
          const b = (clamp(v.bottom, 0, 100) / 100) * h;
          cctx.clearRect(0, 0, l, h);
          cctx.clearRect(w - r, 0, r, h);
          cctx.clearRect(0, 0, w, tp);
          cctx.clearRect(0, h - b, w, b);
          break;
        }
        case 'colorKey': {
          const keyer = this.getKeyer();
          if (!keyer) break;
          const out = keyer.apply(cur, v);
          if (out) {
            cctx.save();
            cctx.globalCompositeOperation = 'copy';
            cctx.drawImage(out, 0, 0, w, h);
            cctx.restore();
          }
          break;
        }
      }
    }
    flushFilters();
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
    const mctx = sizeCanvas(this.maskCanvas, w, h);
    const feather = Math.max(0, v.feather || 0) * ps;
    const exp = (v.expansion || 0) * ps;
    if (feather > 0.3) mctx.filter = `blur(${feather / 2}px)`;
    mctx.fillStyle = `rgba(255,255,255,${clamp((v.opacity ?? 100) / 100, 0, 1)})`;
    mctx.beginPath();
    if (v.shape === 'polygon' && Array.isArray(v.points) && v.points.length >= 3) {
      v.points.forEach(([px, py], i) => (i ? mctx.lineTo((px / 100) * w, (py / 100) * h) : mctx.moveTo((px / 100) * w, (py / 100) * h)));
      mctx.closePath();
      mctx.fill();
      if (exp > 0) {
        mctx.strokeStyle = mctx.fillStyle;
        mctx.lineJoin = 'round';
        mctx.lineWidth = exp * 2;
        mctx.stroke();
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

  getGrader() {
    if (shared.grader === null) {
      try {
        shared.grader = new ColorGrader();
      } catch (err) {
        console.warn('WebGL2 colour grading unavailable', err);
        shared.grader = false;
      }
    }
    return shared.grader || null;
  }

  applyAdjustment(ctx, clip, t, strength = 1) {
    const tl = t - clip.start;
    const userFx = [];
    let opacity = 1;
    let blend = 'source-over';
    for (const e of clip.effects) {
      if (!e.enabled || !EFFECTS[e.type]) continue;
      const v = evalEffect(e, tl);
      if (e.type === 'opacity') {
        opacity = v.opacity / 100;
        blend = v.blend;
      } else if (!EFFECTS[e.type].fixed && !TRANSFORM_FX.has(e.type)) userFx.push({ type: e.type, v });
    }
    if (!userFx.length) return;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const actx = sizeCanvas(this.adjust, cw, ch);
    actx.drawImage(ctx.canvas, 0, 0);
    const processed = this.processStage({ img: this.adjust, w: cw, h: ch }, userFx, null, 1);
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

  /** WebGL helpers are shared by every compositor (browsers allow only a few WebGL contexts). */
  getKeyer() {
    if (shared.keyer === null) {
      try {
        shared.keyer = new ColorKeyer();
      } catch (err) {
        console.warn('WebGL keyer unavailable', err);
        shared.keyer = false;
      }
    }
    return shared.keyer || null;
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
    const base = size.fit ? Math.min(seq.width / size.w, seq.height / size.h) : 1;
    const s = (base * m.scale) / 100;
    const rad = (m.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hw = (size.w * s) / 2;
    const hh = (size.h * s) / 2;
    const ax = m.anchorX || 0;
    const ay = m.anchorY || 0;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
      const lx = x - ax;
      const ly = y - ay;
      return [m.posX + lx * cos - ly * sin, m.posY + lx * sin + ly * cos];
    });
  }
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// ---------------------------------------------------------------- WebGL chroma keyer

class ColorKeyer {
  constructor() {
    this.canvas = makeCanvas(2, 2);
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('no webgl');
    this.gl = gl;
    const vs = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
    const fs = `precision mediump float;
      uniform sampler2D tex; uniform vec3 key; uniform float tol; uniform float soft; uniform float spill; uniform float mode;
      varying vec2 uv;
      vec2 chroma(vec3 c){ return vec2(-0.168736*c.r - 0.331264*c.g + 0.5*c.b, 0.5*c.r - 0.418688*c.g - 0.081312*c.b); }
      void main(){
        vec4 c = texture2D(tex, uv);
        vec2 pc = chroma(c.rgb);
        vec2 kc = chroma(key);
        float pl = length(pc);
        float kl = max(length(kc), 1e-4);
        // hue similarity (1 = same hue) gated by saturation relative to the key colour,
        // so darker/brighter shades of the key colour are keyed as well
        float cosA = dot(pc, kc) / (pl * kl + 1e-5);
        float hueDiff = 1.0 - cosA;
        float sat = pl / kl;
        float m = (1.0 - smoothstep(tol, tol + soft + 1e-4, hueDiff)) * smoothstep(0.12, 0.12 + soft + 0.08, sat);
        float a = 1.0 - m;
        vec3 col = c.rgb;
        if (mode > 0.5 && mode < 1.5) { float lim = (col.r + col.b) * 0.5; col.g = mix(col.g, min(col.g, lim), spill); }
        else if (mode > 1.5) { float lim = (col.r + col.g) * 0.5; col.b = mix(col.b, min(col.b, lim), spill); }
        float outA = c.a * a;
        gl_FragColor = vec4(col * outA, outA);
      }`;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.u = {};
    for (const n of ['tex', 'key', 'tol', 'soft', 'spill', 'mode']) this.u[n] = gl.getUniformLocation(prog, n);
  }

  apply(source, v) {
    const gl = this.gl;
    const w = source.width;
    const h = source.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const [r, g, b] = hexToRgb(v.keyColor).map((x) => x / 255);
    gl.uniform1i(this.u.tex, 0);
    gl.uniform3f(this.u.key, r, g, b);
    gl.uniform1f(this.u.tol, (v.tolerance / 100) * 0.3);
    gl.uniform1f(this.u.soft, (v.softness / 100) * 0.25);
    gl.uniform1f(this.u.spill, v.spill / 100);
    gl.uniform1f(this.u.mode, g >= r && g >= b ? 1 : b >= r && b >= g ? 2 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

// ---------------------------------------------------------------- WebGL2 colour grading (curves, wheels, LUT)

/** Monotone cubic interpolation through curve points → 256-entry table (0..1). */
export function curveTable(points) {
  const pts = (points?.length >= 2 ? points : [[0, 0], [1, 1]]).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const tt = 3 / Math.sqrt(h);
      m[i] = tt * a * d[i];
      m[i + 1] = tt * b * d[i];
    }
  }
  const out = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    if (x <= xs[0]) out[k] = ys[0];
    else if (x >= xs[n - 1]) out[k] = ys[n - 1];
    else {
      const hseg = xs[i + 1] - xs[i];
      const t = (x - xs[i]) / hseg;
      const t2 = t * t;
      const t3 = t2 * t;
      out[k] = clamp((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hseg * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hseg * m[i + 1], 0, 1);
    }
  }
  return out;
}

function wheelOffset(w, k) {
  const x = w?.x || 0;
  const y = w?.y || 0;
  const amt = Math.min(1, Math.hypot(x, y));
  if (amt < 1e-4) return [0, 0, 0];
  const hue = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1;
  const f = (n) => {
    const kk = (n + hue * 6) % 6;
    return 1 - Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  const rgb = [f(5), f(3), f(1)];
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((c) => (c - l) * amt * k);
}

class ColorGrader {
  constructor() {
    this.canvas = makeCanvas(2, 2);
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    const vs = `#version 300 es
      in vec2 p; out vec2 uv;
      void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
    const grade = `#version 300 es
      precision highp float;
      uniform sampler2D tex; uniform sampler2D curve;
      uniform float exposure, contrast, highlights, shadows, whites, blacks, temp, tint, sat, vib;
      uniform vec3 lift, gamma, gain;
      in vec2 uv; out vec4 o;
      float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main(){
        vec4 s = texture(tex, uv);
        vec3 c = s.rgb;
        c *= vec3(1.0 + temp * 0.25, 1.0 - tint * 0.12, 1.0 - temp * 0.25);
        c *= exp2(exposure);
        c = (c - 0.45) * (1.0 + contrast) + 0.45;
        float l = luma(c);
        c += highlights * 0.35 * smoothstep(0.35, 1.0, l);
        c += shadows * 0.35 * (1.0 - smoothstep(0.0, 0.6, l));
        c += whites * 0.25 * c;
        c += blacks * 0.15 * (1.0 - c);
        c = c + lift * (1.0 - clamp(c, 0.0, 1.0));
        c = pow(max(c, 0.0), 1.0 / max(vec3(0.05), vec3(1.0) + gamma));
        c = c * (vec3(1.0) + gain);
        l = luma(c);
        float mx = max(c.r, max(c.g, c.b));
        float mn = min(c.r, min(c.g, c.b));
        float boost = 1.0 + vib * (1.0 - clamp((mx - mn) * 2.0, 0.0, 1.0));
        c = mix(vec3(l), c, sat * boost);
        c = clamp(c, 0.0, 1.0);
        c = vec3(texture(curve, vec2(c.r, 0.5)).r, texture(curve, vec2(c.g, 0.5)).g, texture(curve, vec2(c.b, 0.5)).b);
        o = vec4(c * s.a, s.a);
      }`;
    const lut = `#version 300 es
      precision highp float;
      precision highp sampler3D;
      uniform sampler2D tex; uniform sampler3D lut;
      uniform float size, intensity; uniform vec3 dmin, dmax;
      in vec2 uv; out vec4 o;
      void main(){
        vec4 s = texture(tex, uv);
        vec3 c = clamp((s.rgb - dmin) / max(dmax - dmin, vec3(1e-5)), 0.0, 1.0);
        vec3 g = texture(lut, c * ((size - 1.0) / size) + 0.5 / size).rgb;
        o = vec4(mix(s.rgb, clamp(g, 0.0, 1.0), intensity) * s.a, s.a);
      }`;
    this.progGrade = this.program(vs, grade);
    this.progLut = this.program(vs, lut);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    for (const prog of [this.progGrade, this.progLut]) {
      const loc = gl.getAttribLocation(prog, 'p');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }
    this.srcTex = this.texture2D();
    this.curveTex = this.texture2D();
    this.curveKey = '';
    this.luts = new Map();
  }

  program(vs, fs) {
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
  }

  texture2D() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  begin(source, prog) {
    const gl = this.gl;
    if (this.canvas.width !== source.width || this.canvas.height !== source.height) {
      this.canvas.width = source.width;
      this.canvas.height = source.height;
    }
    gl.viewport(0, 0, source.width, source.height);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
  }

  finish() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  applyGrade(source, v) {
    const gl = this.gl;
    const prog = this.progGrade;
    this.begin(source, prog);
    const curves = v.curves || {};
    const key = JSON.stringify(curves);
    if (key !== this.curveKey) {
      const master = curveTable(curves.master);
      const r = curveTable(curves.r);
      const g = curveTable(curves.g);
      const b = curveTable(curves.b);
      const data = new Uint8Array(256 * 4);
      const at = (tab, x) => tab[Math.round(clamp(x, 0, 1) * 255)];
      for (let i = 0; i < 256; i++) {
        const m = master[i];
        data[i * 4] = Math.round(at(r, m) * 255);
        data[i * 4 + 1] = Math.round(at(g, m) * 255);
        data[i * 4 + 2] = Math.round(at(b, m) * 255);
        data[i * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.curveKey = key;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform1i(u('curve'), 1);
    gl.uniform1f(u('exposure'), v.exposure || 0);
    gl.uniform1f(u('contrast'), (v.contrast || 0) / 100);
    gl.uniform1f(u('highlights'), (v.highlights || 0) / 100);
    gl.uniform1f(u('shadows'), (v.shadows || 0) / 100);
    gl.uniform1f(u('whites'), (v.whites || 0) / 100);
    gl.uniform1f(u('blacks'), (v.blacks || 0) / 100);
    gl.uniform1f(u('temp'), (v.temperature || 0) / 100);
    gl.uniform1f(u('tint'), (v.tint || 0) / 100);
    gl.uniform1f(u('sat'), (v.saturation ?? 100) / 100);
    gl.uniform1f(u('vib'), (v.vibrance || 0) / 100);
    gl.uniform3f(u('lift'), ...wheelOffset(v.shadowsWheel, 0.25));
    gl.uniform3f(u('gamma'), ...wheelOffset(v.midsWheel, 0.5));
    gl.uniform3f(u('gain'), ...wheelOffset(v.highlightsWheel, 0.5));
    return this.finish();
  }

  applyLut(source, lut, id, intensity) {
    const gl = this.gl;
    const prog = this.progLut;
    let tex = this.luts.get(id);
    if (!tex || tex.lut !== lut) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
      tex = { t, lut };
      this.luts.set(id, tex);
    }
    this.begin(source, prog);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, tex.t);
    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform1i(u('lut'), 2);
    gl.uniform1f(u('size'), lut.size);
    gl.uniform1f(u('intensity'), clamp(intensity, 0, 1));
    gl.uniform3f(u('dmin'), ...(lut.domainMin || [0, 0, 0]));
    gl.uniform3f(u('dmax'), ...(lut.domainMax || [1, 1, 1]));
    return this.finish();
  }
}

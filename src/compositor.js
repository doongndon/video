// Video compositing engine. Draws a sequence frame at time t onto a 2D canvas.
// The same code path is used for the Program monitor and for export so what you see is what
// you get. Frame sources come from a "provider" (live <video> elements for preview, exact
// decoded frames for export).

import { clipsOnTrack, clipEnd, evalEffect, mediaTimeAt, transitionsOnTrack, videoTracks } from './model.js';
import { EFFECTS } from './effects.js';
import { clamp } from './util.js';

const FILTER_FX = new Set(['brightnessContrast', 'basicColor', 'hueShift', 'gaussianBlur', 'blackWhite', 'sepia', 'invert']);

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

export class Compositor {
  constructor({ onAsyncReady } = {}) {
    this.stageA = makeCanvas();
    this.stageB = makeCanvas();
    this.small = makeCanvas();
    this.trackLayer = makeCanvas();
    this.adjust = makeCanvas();
    this.textCache = new Map();
    this.solidCache = new Map();
    this.keyer = null;
    this.onAsyncReady = onAsyncReady || (() => {});
    this.pendingFonts = new Set();
  }

  /**
   * Render frame t. ctx must belong to a canvas of size seq.width*scale x seq.height*scale.
   * provider.videoFrame(clip, mediaTime) -> {img,w,h} | {offline:true} | null
   * provider.image(mediaId) -> {img,w,h} | {offline:true} | null
   * provider.media(id) -> media item
   */
  render(ctx, seq, t, provider, { scale = 1, background = '#000000' } = {}) {
    const W = seq.width;
    const H = seq.height;
    this.scale = scale;
    this.seq = seq;
    this.provider = provider;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    for (const track of videoTracks(seq)) {
      if (track.hidden) continue;
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
      const o = {};
      if (type) Object.assign(o, oneSided(type, reveal, job.edge, W, H));
      this.drawClip(ctx, clip, t, o);
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
    switch (type) {
      case 'dipToBlack':
      case 'dipToWhite': {
        const color = type === 'dipToBlack' ? '#000000' : '#ffffff';
        if (p < 0.5) this.drawClip(ctx, a, t, { dip: { color, amount: p * 2 } });
        else this.drawClip(ctx, b, t, { dip: { color, amount: (1 - p) * 2 } });
        return;
      }
      case 'wipe':
        this.drawClip(ctx, a, t, {});
        this.drawClip(ctx, b, t, { clipPath: (c) => c.rect(0, 0, W * p, H) });
        return;
      case 'push':
        this.drawClip(ctx, a, t, { offsetX: -p * W });
        this.drawClip(ctx, b, t, { offsetX: (1 - p) * W });
        return;
      case 'irisRound': {
        const r = Math.hypot(W, H) / 2 * p;
        this.drawClip(ctx, a, t, {});
        this.drawClip(ctx, b, t, { clipPath: (c) => c.arc(W / 2, H / 2, Math.max(0.01, r), 0, Math.PI * 2) });
        return;
      }
      case 'crossDissolve':
      default: {
        // linear cross-fade inside a track layer, then composite with the clip blend mode
        const s = this.scale;
        const lctx = sizeCanvas(this.trackLayer, W * s, H * s);
        lctx.setTransform(s, 0, 0, s, 0, 0);
        this.drawClip(lctx, a, t, { alpha: 1 - p, composite: 'source-over' });
        this.drawClip(lctx, b, t, { alpha: p, composite: 'lighter' });
        const blend = this.clipBlend(p < 0.5 ? a : b, t);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = blend;
        ctx.drawImage(this.trackLayer, 0, 0);
        ctx.restore();
      }
    }
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
        return this.provider.videoFrame(clip, mt);
      }
      case 'image':
        return this.provider.image(clip.mediaId);
      case 'color': {
        const fill = clip.effects.find((e) => e.type === 'fill');
        const color = fill ? evalEffect(fill, tl).color : '#000000';
        return { img: this.solid(color), w: W, h: H, fit: false };
      }
      case 'text': {
        const fx = clip.effects.find((e) => e.type === 'text');
        const motion = clip.effects.find((e) => e.type === 'motion');
        const sc = motion ? Math.abs(evalEffect(motion, tl).scale) / 100 : 1;
        const k = clamp(this.scale * Math.max(1, sc), 0.25, 4);
        return this.textSource(evalEffect(fx, tl), k);
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
    lines.forEach((line, i) => {
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
    if (clip.kind === 'text') {
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
    const shadow = userFx.find((f) => f.type === 'dropShadow')?.v;
    const stageFx = userFx.filter((f) => f.type !== 'dropShadow' && f.type !== 'hFlip' && f.type !== 'vFlip');
    for (const f of userFx) {
      if (f.type === 'hFlip') flipX = -flipX;
      if (f.type === 'vFlip') flipY = -flipY;
    }

    let img = src.img;
    if (stageFx.length || opts.dip) {
      // process at roughly the on-screen resolution
      const onScreen = baseScale * this.scale * Math.max(1, Math.abs(motion.scale) / 100);
      img = this.processStage(src, stageFx, opts.dip, clamp(onScreen, 0.05, 1));
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = opts.composite || blend;
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
    ctx.translate(motion.posX + (opts.offsetX || 0), motion.posY);
    ctx.rotate((motion.rotation * Math.PI) / 180);
    ctx.scale(s * flipX, s * flipY);
    ctx.translate(-(motion.anchorX || 0) / (s || 1), -(motion.anchorY || 0) / (s || 1));
    ctx.drawImage(img, -src.w / 2, -src.h / 2, src.w, src.h);
    ctx.restore();
  }

  /** Run the per-clip pixel effects. Returns a canvas holding the processed source. */
  processStage(src, effects, dip, ps) {
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
      } else if (!EFFECTS[e.type].fixed && e.type !== 'dropShadow' && e.type !== 'hFlip' && e.type !== 'vFlip') userFx.push({ type: e.type, v });
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
    ctx.font = `700 ${Math.round(H / 12)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || 'Media Offline', W / 2, H / 2);
    ctx.restore();
  }

  getKeyer() {
    if (this.keyer === null) {
      try {
        this.keyer = new ColorKeyer();
      } catch (err) {
        console.warn('WebGL keyer unavailable', err);
        this.keyer = false;
      }
    }
    return this.keyer || null;
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

function oneSided(type, reveal, edge, W, H) {
  const r = clamp(reveal, 0, 1);
  switch (type) {
    case 'dipToBlack':
      return { dip: { color: '#000000', amount: 1 - r } };
    case 'dipToWhite':
      return { dip: { color: '#ffffff', amount: 1 - r } };
    case 'wipe':
      return edge === 'out' ? { clipPath: (c) => c.rect(W * (1 - r), 0, W * r, H) } : { clipPath: (c) => c.rect(0, 0, W * r, H) };
    case 'push':
      return { offsetX: edge === 'out' ? -(1 - r) * W : (1 - r) * W };
    case 'irisRound':
      return { clipPath: (c) => c.arc(W / 2, H / 2, Math.max(0.01, (Math.hypot(W, H) / 2) * r), 0, Math.PI * 2) };
    case 'crossDissolve':
    default:
      return { alpha: r };
  }
}

function clampMediaTime(mt, media) {
  if (!media || !Number.isFinite(media.duration)) return Math.max(0, mt);
  const fps = media.fps || 30;
  return clamp(mt, 0, Math.max(0, media.duration - 1 / fps));
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

// Photo document: layers (image, text, shape, adjustment), blend modes, masks, layer styles and
// the compositor. Pixel canvases are never changed in place once an undo snapshot may point at them:
// editPixels()/editMask() swap in a copy first (copy-on-write), so history entries stay cheap.

import { loadFontFor } from '../fonts.js';
import { applyAdjustment } from './adjust.js';

export const BLEND_MODES = [
  ['normal', '표준', 'source-over'],
  ['multiply', '곱하기', 'multiply'],
  ['screen', '스크린', 'screen'],
  ['overlay', '오버레이', 'overlay'],
  ['darken', '어둡게 하기', 'darken'],
  ['lighten', '밝게 하기', 'lighten'],
  ['color dodge', '색상 닷지', 'color-dodge'],
  ['color burn', '색상 번', 'color-burn'],
  ['linear dodge', '선형 닷지 (추가)', 'lighter'],
  ['hard light', '하드 라이트', 'hard-light'],
  ['soft light', '소프트 라이트', 'soft-light'],
  ['difference', '차이', 'difference'],
  ['exclusion', '제외', 'exclusion'],
  ['hue', '색조', 'hue'],
  ['saturation', '채도', 'saturation'],
  ['color', '색상', 'color'],
  ['luminosity', '광도', 'luminosity'],
];
const COMPOSITE = Object.fromEntries(BLEND_MODES.map(([id, , op]) => [id, op]));

let seq = 1;
export const lid = (p = 'L') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function newLayer(kind, props = {}) {
  return {
    id: lid(), name: props.name || '레이어', kind, visible: true, opacity: 1, blend: 'normal',
    locked: false, lockAlpha: false, x: 0, y: 0, rotation: 0, canvas: null, mask: null,
    text: null, shape: null, adjust: null, fx: {}, rev: 0, ...props,
  };
}

export class PhotoDoc {
  constructor({ name = '제목 없음', width = 1920, height = 1080, background = '#ffffff' } = {}) {
    this.id = lid('D');
    this.name = name;
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.layers = [];
    this.activeId = null;
    this.selection = null; // { canvas } — doc-size alpha mask
    this.sourceMediaId = null;
    this.rev = 0;
    this.saved = true;
    if (background !== null) {
      const bg = newLayer('raster', { name: '배경' });
      bg.canvas = makeCanvas(this.width, this.height);
      if (background !== 'transparent') {
        const g = bg.canvas.getContext('2d');
        g.fillStyle = background;
        g.fillRect(0, 0, this.width, this.height);
      }
      this.layers.push(bg);
      this.activeId = bg.id;
    }
  }

  get active() {
    return this.layers.find((l) => l.id === this.activeId) || this.layers[this.layers.length - 1] || null;
  }

  layer(id) {
    return this.layers.find((l) => l.id === id) || null;
  }

  index(id) {
    return this.layers.findIndex((l) => l.id === id);
  }

  touch(layer) {
    if (layer) layer.rev++;
    this.rev++;
    this.saved = false;
  }

  // ---------------------------------------------------------------- copy-on-write editing

  /** Make the layer's pixels safe to change; grows the canvas so it covers `rect` (doc coords). */
  editPixels(layer, rect = null) {
    if (layer.kind !== 'raster') return null;
    if (!layer.canvas) {
      layer.canvas = makeCanvas(this.width, this.height);
      layer.x = 0;
      layer.y = 0;
    }
    const want = rect || { x: 0, y: 0, w: this.width, h: this.height };
    const x0 = Math.min(layer.x, Math.floor(want.x));
    const y0 = Math.min(layer.y, Math.floor(want.y));
    const x1 = Math.max(layer.x + layer.canvas.width, Math.ceil(want.x + want.w));
    const y1 = Math.max(layer.y + layer.canvas.height, Math.ceil(want.y + want.h));
    const c = makeCanvas(x1 - x0, y1 - y0);
    c.getContext('2d').drawImage(layer.canvas, layer.x - x0, layer.y - y0);
    layer.canvas = c;
    layer.x = x0;
    layer.y = y0;
    this.touch(layer);
    return c.getContext('2d');
  }

  editMask(layer) {
    if (!layer.mask) this.addMask(layer, 'white', false);
    layer.mask = { ...layer.mask, canvas: cloneCanvas(layer.mask.canvas) };
    this.touch(layer);
    return layer.mask.canvas.getContext('2d');
  }

  addMask(layer, fill = 'white', fromSelection = true) {
    const c = makeCanvas(this.width, this.height);
    const g = c.getContext('2d');
    if (fromSelection && this.selection) g.drawImage(this.selection.canvas, 0, 0);
    else if (fill === 'white') {
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
    }
    layer.mask = { canvas: c, x: 0, y: 0, enabled: true, linked: true };
    this.touch(layer);
  }

  // ---------------------------------------------------------------- snapshots (undo)

  capture() {
    return {
      name: this.name, width: this.width, height: this.height, activeId: this.activeId,
      selection: this.selection,
      layers: this.layers.map((l) => ({ ...l, text: l.text && { ...l.text }, shape: l.shape && { ...l.shape }, adjust: l.adjust && { ...l.adjust, params: structuredClone(l.adjust.params) }, fx: structuredClone(l.fx || {}), mask: l.mask && { ...l.mask }, _cache: null })),
    };
  }

  restore(st) {
    this.name = st.name;
    this.width = st.width;
    this.height = st.height;
    this.activeId = st.activeId;
    this.selection = st.selection;
    this.layers = st.layers.map((l) => ({ ...l, text: l.text && { ...l.text }, shape: l.shape && { ...l.shape }, adjust: l.adjust && { ...l.adjust, params: structuredClone(l.adjust.params) }, fx: structuredClone(l.fx || {}), mask: l.mask && { ...l.mask }, rev: (l.rev || 0) + 1, _cache: null }));
    this.rev++;
    this.saved = false;
  }

  /** Bytes of one full-size layer, used to size the undo history. */
  get layerBytes() {
    return this.width * this.height * 4;
  }

  // ---------------------------------------------------------------- content

  /** Pixels of a layer before mask/styles: {canvas, x, y} in doc coords, or null. */
  content(layer) {
    if (layer.kind === 'raster') return layer.canvas ? { canvas: layer.canvas, x: layer.x, y: layer.y } : null;
    if (layer.kind === 'text') return renderTextLayer(this, layer);
    if (layer.kind === 'shape') return renderShapeLayer(layer);
    return null;
  }

  /** Axis-aligned bounds of a layer's visible pixels area (doc coords). */
  bounds(layer) {
    if (layer.kind === 'text' || layer.kind === 'shape') {
      const b = layer.kind === 'text' ? textBox(layer) : { w: layer.shape.w, h: layer.shape.h };
      return { x: layer.x, y: layer.y, w: b.w, h: b.h, rotation: layer.rotation || 0 };
    }
    const c = this.content(layer);
    return c ? { x: c.x, y: c.y, w: c.canvas.width, h: c.canvas.height, rotation: 0 } : null;
  }

  /** Tight bounds of non-transparent pixels of a raster layer (doc coords) or null when empty. */
  opaqueBounds(layer) {
    const c = this.content(layer);
    if (!c) return null;
    const { width: w, height: h } = c.canvas;
    const d = c.canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: c.x + x0, y: c.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // ---------------------------------------------------------------- compositing

  /** Draw the visible layers (optionally only those below index `upTo`) into ctx (doc-size). */
  render(ctx, { upTo = this.layers.length, skipId = null, float = null } = {}) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    let sig = '';
    for (let i = 0; i < upTo; i++) {
      const l = this.layers[i];
      sig += `${l.id}:${l.rev}:${l.visible ? 1 : 0};`;
      if (!l.visible || l.id === skipId || l.opacity <= 0) continue;
      if (l.kind === 'adjust') {
        this.drawAdjustment(ctx, l, sig);
        continue;
      }
      const c = this.content(l);
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = COMPOSITE[l.blend] || 'source-over';
      if (c) {
        const styled = this.styled(l, c);
        ctx.drawImage(styled.canvas, styled.x, styled.y);
      }
      // pixels being moved or transformed float just above their layer
      if (float && float.layerId === l.id) ctx.drawImage(float.canvas, float.x, float.y);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  /** Content with the layer mask and layer styles applied (cached per layer revision). */
  styled(l, c) {
    const fx = l.fx || {};
    const hasFx = !!(fx.shadow || fx.stroke || fx.glow);
    const masked = l.mask && l.mask.enabled;
    if (!hasFx && !masked) return c;
    const key = `${l.rev}:${c.x},${c.y},${c.canvas.width},${c.canvas.height}`;
    if (l._styled?.key === key) return l._styled.out;
    const pad = hasFx ? Math.ceil(Math.max(fx.stroke ? fx.stroke.size : 0, fx.glow ? fx.glow.size * 2 : 0, fx.shadow ? fx.shadow.distance + fx.shadow.blur * 2 : 0)) + 2 : 0;
    const out = makeCanvas(c.canvas.width + pad * 2, c.canvas.height + pad * 2);
    const ox = c.x - pad;
    const oy = c.y - pad;
    // the layer itself, masked
    const body = makeCanvas(out.width, out.height);
    const bg = body.getContext('2d');
    bg.drawImage(c.canvas, pad, pad);
    if (masked) {
      bg.globalCompositeOperation = 'destination-in';
      bg.drawImage(maskAlpha(this, l.mask), -ox, -oy);
      bg.globalCompositeOperation = 'source-over';
    }
    const g = out.getContext('2d');
    const silhouette = (color) => {
      const s = makeCanvas(out.width, out.height);
      const sg = s.getContext('2d');
      sg.drawImage(body, 0, 0);
      sg.globalCompositeOperation = 'source-in';
      sg.fillStyle = color;
      sg.fillRect(0, 0, s.width, s.height);
      return s;
    };
    if (fx.shadow) {
      const s = fx.shadow;
      const a = (s.angle * Math.PI) / 180;
      g.save();
      g.globalAlpha = s.opacity;
      g.filter = s.blur > 0 ? `blur(${s.blur}px)` : 'none';
      g.drawImage(silhouette(s.color), -Math.cos(a) * s.distance, Math.sin(a) * s.distance);
      g.restore();
    }
    if (fx.glow) {
      g.save();
      g.globalAlpha = fx.glow.opacity;
      g.filter = `blur(${fx.glow.size}px)`;
      const sil = silhouette(fx.glow.color);
      g.drawImage(sil, 0, 0);
      g.drawImage(sil, 0, 0);
      g.restore();
    }
    if (fx.stroke && fx.stroke.size > 0) {
      const sil = silhouette(fx.stroke.color);
      const r = fx.stroke.size;
      const steps = Math.max(12, Math.round(r * 4));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        g.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r);
      }
      for (let rr = r - 1; rr > 0; rr--) for (let i = 0; i < 8; i++) g.drawImage(sil, Math.cos((i / 8) * Math.PI * 2) * rr, Math.sin((i / 8) * Math.PI * 2) * rr);
    }
    g.drawImage(body, 0, 0);
    const res = { canvas: out, x: ox, y: oy };
    l._styled = { key, out: res };
    return res;
  }

  drawAdjustment(ctx, l, sig) {
    const key = `${sig}|${JSON.stringify(l.adjust)}|${l.mask ? l.rev : 0}`;
    let out = l._cache?.key === key ? l._cache.canvas : null;
    if (!out) {
      const src = ctx.canvas;
      out = makeCanvas(this.width, this.height);
      const og = out.getContext('2d');
      const img = src.getContext('2d').getImageData(0, 0, this.width, this.height);
      applyAdjustment(img, l.adjust.type, l.adjust.params);
      og.putImageData(img, 0, 0);
      if (l.mask && l.mask.enabled) {
        og.globalCompositeOperation = 'destination-in';
        og.drawImage(maskAlpha(this, l.mask), 0, 0);
      }
      l._cache = { key, canvas: out };
    }
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = COMPOSITE[l.blend] || 'source-over';
    ctx.drawImage(out, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Flattened image (new doc-size canvas). */
  flatten({ upTo, skipId } = {}) {
    const c = makeCanvas(this.width, this.height);
    this.render(c.getContext('2d'), { upTo, skipId });
    return c;
  }

  /** A layer drawn on its own (mask, styles, opacity; normal blend) as a doc-size canvas. */
  rasterizeLayer(l, { withOpacity = false } = {}) {
    const out = makeCanvas(this.width, this.height);
    const c = this.content(l);
    if (!c) return out;
    const s = this.styled(l, c);
    const g = out.getContext('2d');
    if (withOpacity) g.globalAlpha = l.opacity;
    g.drawImage(s.canvas, s.x, s.y);
    return out;
  }
}

/** The mask as a doc-size alpha canvas (outside the mask canvas counts as hidden). */
export function maskAlpha(doc, mask) {
  if (mask.x === 0 && mask.y === 0 && mask.canvas.width === doc.width && mask.canvas.height === doc.height) return mask.canvas;
  const c = makeCanvas(doc.width, doc.height);
  c.getContext('2d').drawImage(mask.canvas, mask.x, mask.y);
  return c;
}

// ---------------------------------------------------------------- text layers

const measureCtx = () => (measureCtx.c ||= makeCanvas(1, 1).getContext('2d'));

export function textFont(t) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${t.size}px "${t.font}", "Noto Sans KR", sans-serif`;
}

/** Unrotated size of a text layer's box. */
export function textBox(layer) {
  const t = layer.text;
  const g = measureCtx();
  g.font = textFont(t);
  if ('letterSpacing' in g) g.letterSpacing = `${t.letterSpacing || 0}px`;
  const lines = String(t.content ?? '').split('\n');
  const w = Math.max(1, ...lines.map((s) => g.measureText(s || ' ').width));
  const lh = t.size * (t.lineHeight || 1.2);
  return { w: Math.ceil(w + 2), h: Math.ceil(lh * lines.length), lh, lines };
}

const fontWaits = new Set();
function renderTextLayer(doc, layer) {
  const t = layer.text;
  const key = `${layer.rev}:${JSON.stringify(t)}:${layer.rotation}:${layer.x},${layer.y}`;
  if (layer._text?.key === key) return layer._text.out;
  // load the web font (and its Korean subsets) for this text, then redraw
  const fk = `${t.font}|${t.bold}|${t.italic}|${t.content}`;
  if (!fontWaits.has(fk)) {
    fontWaits.add(fk);
    loadFontFor(t.font, t.content || '', { bold: t.bold, italic: t.italic }).then(() => {
      layer._text = null;
      layer.rev++;
      doc.rev++;
      window.dispatchEvent(new Event('photo:redraw'));
    }).catch(() => {});
  }
  const { w, h, lh, lines } = textBox(layer);
  const out = rotatedBox(layer, w, h, (g) => {
    g.font = textFont(t);
    if ('letterSpacing' in g) g.letterSpacing = `${t.letterSpacing || 0}px`;
    g.fillStyle = t.color;
    g.textBaseline = 'alphabetic';
    g.textAlign = t.align || 'left';
    const ax = t.align === 'center' ? w / 2 : t.align === 'right' ? w : 0;
    lines.forEach((s, i) => g.fillText(s, ax, i * lh + t.size * 0.95 + (lh - t.size) / 2));
  });
  layer._text = { key, out };
  return out;
}

// ---------------------------------------------------------------- shape layers

export const SHAPES = [['rect', '사각형'], ['round', '둥근 사각형'], ['ellipse', '타원'], ['line', '선'], ['triangle', '삼각형'], ['star', '별']];

function shapePath(s) {
  const p = new Path2D();
  const { w, h } = s;
  if (s.type === 'ellipse') p.ellipse(w / 2, h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  else if (s.type === 'round') p.roundRect(0, 0, w, h, Math.min(s.radius || 20, w / 2, h / 2));
  else if (s.type === 'line') {
    p.moveTo(0, h / 2);
    p.lineTo(w, h / 2);
  } else if (s.type === 'triangle') {
    p.moveTo(w / 2, 0);
    p.lineTo(w, h);
    p.lineTo(0, h);
    p.closePath();
  } else if (s.type === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 0.4 : 1;
      const x = w / 2 + Math.cos(a) * (w / 2) * r;
      const y = h / 2 + Math.sin(a) * (h / 2) * r;
      if (i) p.lineTo(x, y);
      else p.moveTo(x, y);
    }
    p.closePath();
  } else p.rect(0, 0, w, h);
  return p;
}

function renderShapeLayer(layer) {
  const s = layer.shape;
  const key = `${layer.rev}:${JSON.stringify(s)}:${layer.rotation}:${layer.x},${layer.y}`;
  if (layer._shape?.key === key) return layer._shape.out;
  const pad = s.stroke && s.strokeWidth ? Math.ceil(s.strokeWidth) : 0;
  const out = rotatedBox(layer, s.w, s.h, (g) => {
    const p = shapePath(s);
    if (s.type !== 'line' && s.fill) {
      g.fillStyle = s.fill;
      g.fill(p);
    }
    if ((s.stroke && s.strokeWidth > 0) || s.type === 'line') {
      g.strokeStyle = s.stroke || s.fill || '#000';
      g.lineWidth = Math.max(1, s.strokeWidth || 4);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke(p);
    }
  }, pad);
  layer._shape = { key, out };
  return out;
}

/** Render content of size w×h (top-left at layer.x/y) rotated about its centre. */
function rotatedBox(layer, w, h, draw, pad = 0) {
  const rot = ((layer.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const W = Math.ceil(w * cos + h * sin) + pad * 2 + 2;
  const H = Math.ceil(w * sin + h * cos) + pad * 2 + 2;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.translate(W / 2, H / 2);
  g.rotate(rot);
  g.translate(-w / 2, -h / 2);
  draw(g);
  const cx = layer.x + w / 2;
  const cy = layer.y + h / 2;
  return { canvas: c, x: Math.round(cx - W / 2), y: Math.round(cy - H / 2) };
}

/** Corners of a text/shape layer's (rotated) box in doc coords. */
export function boxCorners(layer, w, h) {
  const rot = ((layer.rotation || 0) * Math.PI) / 180;
  const cx = layer.x + w / 2;
  const cy = layer.y + h / 2;
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
}

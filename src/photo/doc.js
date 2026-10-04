// Photo document: a layer tree (image, text, shape, adjustment, fill, smart object and group layers),
// blend modes, clipping masks, layer masks, layer styles and the compositor.
//
// Layers live in one flat list, bottom → top; a layer's `parent` names its group, and a group's
// descendants always sit directly below the group entry (one contiguous block). Pixel canvases are
// never changed in place once an undo snapshot may point at them: editPixels()/editMask() swap in a
// copy first (copy-on-write), so history entries stay cheap.

import { loadFontFor } from '../fonts.js';
import { applyAdjustment, applyFilter } from './adjust.js';
import { compositeOnto, BLEND_MODES as BM } from './blend.js';
import { stylePasses, fxPad, hasFx, normalizeFx } from './styles.js';
import { boxGradient, paintPattern } from './resources.js';

/** [id, Korean label, canvas op] — kept for older callers; see blend.js for the grouped list. */
export const BLEND_MODES = BM;

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

export const LAYER_COLORS = [['none', '없음', null], ['red', '빨강', '#c94b4b'], ['orange', '주황', '#d9822b'], ['yellow', '노랑', '#d8c43a'], ['green', '초록', '#4e9a52'], ['blue', '파랑', '#3f7fcf'], ['violet', '보라', '#8c62c4'], ['gray', '회색', '#8a8f98']];

export function newLayer(kind, props = {}) {
  return {
    id: lid(), name: props.name || '레이어', kind, visible: true, opacity: 1, fillOpacity: 1,
    blend: kind === 'group' ? 'pass through' : 'normal', parent: null, clip: false, collapsed: false,
    locked: false, lockAlpha: false, lockPixels: false, lockPos: false, linkId: null, color: 'none',
    x: 0, y: 0, rotation: 0, canvas: null, mask: null, vmask: null,
    text: null, shape: null, adjust: null, fill: null, smart: null, blendIf: null, fx: {}, rev: 0, ...props,
  };
}

const META = ['text', 'shape', 'fill', 'smart', 'vmask', 'blendIf', 'adjust'];
/** A copy of a layer's settings that shares its pixel canvases (for undo snapshots). */
function snapshotLayer(l) {
  const o = { ...l };
  for (const k of META) if (l[k]) o[k] = structuredClone(l[k]);
  o.fx = structuredClone(l.fx || {});
  if (l.mask) o.mask = { ...l.mask };
  o._cache = null;
  o._styled = null;
  return o;
}

const DOC_ARRAYS = ['selectedIds', 'guides', 'channels', 'paths', 'notes', 'counts', 'samplers', 'comps'];

export class PhotoDoc {
  constructor({ name = '제목 없음', width = 1920, height = 1080, background = '#ffffff' } = {}) {
    this.id = lid('D');
    this.name = name;
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.layers = [];
    this.activeId = null;
    this.selectedIds = [];
    this.selection = null; // { canvas } — doc-size alpha mask
    this.quickMask = null; // { canvas } while editing in quick mask mode (alpha = selected)
    this.guides = []; // { axis: 'x'|'y', pos }
    this.channels = []; // saved selections { id, name, canvas }
    this.paths = []; // { id, name, subpaths }
    this.workPath = null;
    this.notes = [];
    this.counts = [];
    this.samplers = [];
    this.comps = []; // layer comps { id, name, state }
    this.mode = 'rgb';
    this.resolution = 72;
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

  /** Selected layers (always includes the active one), bottom → top. */
  get selectedLayers() {
    const ids = new Set([...(this.selectedIds || []), this.activeId]);
    return this.layers.filter((l) => ids.has(l.id));
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

  // ---------------------------------------------------------------- tree

  children(parentId) {
    return this.layers.filter((l) => (l.parent || null) === (parentId || null));
  }

  /** All layers inside a group (any depth). */
  descendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const l of this.layers) {
        if (l.parent === pid) {
          out.push(l);
          if (l.kind === 'group') walk(l.id);
        }
      }
    };
    walk(id);
    return out;
  }

  ancestors(l) {
    const out = [];
    let p = l && this.layer(l.parent);
    while (p) {
      out.push(p);
      p = this.layer(p.parent);
    }
    return out;
  }

  depth(l) {
    return this.ancestors(l).length;
  }

  /** Visible here and in every enclosing group. */
  shown(l) {
    return !!l && l.visible && this.ancestors(l).every((a) => a.visible);
  }

  /** Flat index range [start, end] of a layer and its descendants (end = the layer itself). */
  block(id) {
    const end = this.index(id);
    if (end < 0) return null;
    const l = this.layers[end];
    if (l.kind !== 'group') return [end, end];
    const ids = new Set(this.descendants(id).map((d) => d.id));
    let start = end;
    while (start > 0 && ids.has(this.layers[start - 1].id)) start--;
    return [start, end];
  }

  /** Remove a layer (and a group's contents); returns the removed block. */
  removeBlock(id) {
    const b = this.block(id);
    if (!b) return [];
    const out = this.layers.splice(b[0], b[1] - b[0] + 1);
    this.rev++;
    return out;
  }

  /**
   * Move a layer block so that its top sits right below flat index `beforeIndex` (i.e. inserted at that
   * index after removal) with a new parent.
   */
  moveBlock(id, toIndex, parent = undefined) {
    const l = this.layer(id);
    if (!l) return;
    if (parent && (parent === id || this.ancestors(this.layer(parent)).some((a) => a.id === id))) return;
    const b = this.block(id);
    const blk = this.layers.splice(b[0], b[1] - b[0] + 1);
    let at = toIndex;
    if (toIndex > b[1]) at -= blk.length;
    at = Math.max(0, Math.min(this.layers.length, at));
    this.layers.splice(at, 0, ...blk);
    if (parent !== undefined) l.parent = parent || null;
    this.rev++;
  }

  /** Insert a layer above `refId` (same group), or at the top of the document. */
  insertAbove(layer, refId) {
    const ref = refId && this.layer(refId);
    if (!ref) {
      layer.parent = null;
      this.layers.push(layer);
    } else if (ref.kind === 'group' && !ref.collapsed) {
      // inside an open group: on top of its contents
      layer.parent = ref.id;
      this.layers.splice(this.index(ref.id), 0, layer);
    } else {
      layer.parent = ref.parent || null;
      this.layers.splice(this.index(ref.id) + 1, 0, layer);
    }
    this.touch(layer);
  }

  // ---------------------------------------------------------------- moving layers

  /** Move layers by (dx, dy): groups move their contents, linked masks follow, smart objects keep quality. */
  translateLayers(layers, dx, dy) {
    const done = new Set();
    const move = (l) => {
      if (done.has(l.id)) return;
      done.add(l.id);
      if (l.kind === 'group') {
        for (const d of this.descendants(l.id)) move(d);
      } else if (l.kind === 'smart') {
        const m = l.smart.m;
        l.smart = { ...l.smart, m: [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy], corners: l.smart.corners?.map(([x, y]) => [x + dx, y + dy]) };
      } else if (l.kind !== 'fill' && l.kind !== 'adjust') {
        l.x += dx;
        l.y += dy;
      }
      if (l.mask && l.mask.linked !== false) l.mask = { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy };
      if (l.vmask && l.vmask.linked !== false) l.vmask = { ...l.vmask, dx: (l.vmask.dx || 0) + dx, dy: (l.vmask.dy || 0) + dy };
      l._styled = null;
      this.touch(l);
    };
    for (const l of layers) {
      move(l);
      // linked layers move together
      if (l.linkId) for (const o of this.layers) if (o.linkId === l.linkId) move(o);
    }
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
    const st = {
      name: this.name, width: this.width, height: this.height, activeId: this.activeId, selection: this.selection, quickMask: this.quickMask || null,
      workPath: this.workPath && structuredClone(this.workPath), mode: this.mode, resolution: this.resolution,
      layers: this.layers.map(snapshotLayer),
    };
    for (const k of DOC_ARRAYS) st[k] = (this[k] || []).map((v) => (v && typeof v === 'object' ? { ...v } : v));
    return st;
  }

  restore(st) {
    this.name = st.name;
    this.width = st.width;
    this.height = st.height;
    this.activeId = st.activeId;
    this.selection = st.selection;
    this.quickMask = st.quickMask || null;
    this.workPath = st.workPath ? structuredClone(st.workPath) : null;
    this.mode = st.mode || 'rgb';
    this.resolution = st.resolution || 72;
    for (const k of DOC_ARRAYS) this[k] = (st[k] || []).map((v) => (v && typeof v === 'object' ? { ...v } : v));
    this.layers = st.layers.map((l) => ({ ...snapshotLayer(l), rev: (l.rev || 0) + 1 }));
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
    switch (layer.kind) {
      case 'raster': return layer.canvas ? { canvas: layer.canvas, x: layer.x, y: layer.y } : null;
      case 'text': return renderTextLayer(this, layer);
      case 'shape': return renderShapeLayer(layer);
      case 'fill': return renderFillLayer(this, layer);
      case 'smart': return renderSmartLayer(layer);
      case 'group': return { canvas: this.renderGroupAlone(layer), x: 0, y: 0 };
      default: return null;
    }
  }

  /** Axis-aligned bounds of a layer (doc coords). */
  bounds(layer) {
    if (layer.kind === 'text' || layer.kind === 'shape') {
      const b = layer.kind === 'text' ? textBox(layer) : { w: layer.shape.w, h: layer.shape.h };
      return { x: layer.x, y: layer.y, w: b.w, h: b.h, rotation: layer.rotation || 0 };
    }
    if (layer.kind === 'group') {
      const bs = this.descendants(layer.id).filter((d) => d.kind !== 'group' && d.kind !== 'adjust').map((d) => this.opaqueBounds(d)).filter(Boolean);
      if (!bs.length) return null;
      const x0 = Math.min(...bs.map((b) => b.x));
      const y0 = Math.min(...bs.map((b) => b.y));
      return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0, rotation: 0 };
    }
    const c = this.content(layer);
    return c ? { x: c.x, y: c.y, w: c.canvas.width, h: c.canvas.height, rotation: 0 } : null;
  }

  /** Tight bounds of non-transparent pixels (doc coords) or null when empty. */
  opaqueBounds(layer) {
    if (layer.kind === 'group') return this.bounds(layer);
    const c = this.content(layer);
    if (!c) return null;
    const b = alphaBox(c.canvas);
    return b && { x: c.x + b.x, y: c.y + b.y, w: b.w, h: b.h };
  }

  // ---------------------------------------------------------------- compositing

  /** Draw the visible layers into ctx (doc-size). `upTo`: only layers below that flat index. */
  render(ctx, { upTo = null, skipId = null, float = null, fg, bg } = {}) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const only = upTo == null ? null : new Set(this.layers.slice(0, upTo).map((l) => l.id));
    const o = { skipId, float, only, sig: '', fg, bg };
    this.renderList(ctx, this.children(null), o);
    // a float that belongs to no layer (a transformed group, mask or selection) goes on top
    if (float && !float.layerId) {
      if (float.tint) {
        const t = makeCanvas(float.canvas.width, float.canvas.height);
        const tg = t.getContext('2d');
        tg.drawImage(float.canvas, 0, 0);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = float.tint === 'mask' ? 'rgba(255,60,60,.45)' : 'rgba(70,140,255,.4)';
        tg.fillRect(0, 0, t.width, t.height);
        ctx.drawImage(t, float.x, float.y);
      } else ctx.drawImage(float.canvas, float.x, float.y);
    }
    ctx.restore();
  }

  drawable(l, o) {
    if (!l.visible || l.id === o.skipId) return false;
    if (o.only && !o.only.has(l.id) && l.kind !== 'group') return false;
    if (o.only && l.kind === 'group' && !this.descendants(l.id).some((d) => o.only.has(d.id))) return false;
    return true;
  }

  renderList(ctx, list, o) {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      // clipped layers are drawn with their base (a clipped layer with no base draws normally)
      if (l.clip && i > 0) continue;
      const clips = [];
      for (let j = i + 1; j < list.length && list[j].clip; j++) clips.push(list[j]);
      if (!this.drawable(l, o)) continue;
      if (clips.some((c) => this.drawable(c, o)) && l.kind !== 'adjust') this.renderClipStack(ctx, l, clips, o);
      else this.drawLayer(ctx, l, o);
    }
  }

  drawLayer(ctx, l, o, { normal = false } = {}) {
    o.sig += `${l.id}:${l.rev}:${l.visible ? 1 : 0};`;
    if (l.kind === 'group') return this.drawGroup(ctx, l, o, { normal });
    if (l.kind === 'adjust') return this.drawAdjustment(ctx, l, o.sig, o);
    const c = this.content(l);
    if (c) this.drawContent(ctx, l, c, o, { normal });
    // pixels being moved or transformed float just above their layer
    if (o.float && o.float.layerId === l.id) {
      o.sig += `float${o.float.x},${o.float.y};`;
      ctx.drawImage(o.float.canvas, o.float.x, o.float.y);
    }
    return undefined;
  }

  /** A layer's pixels (with mask and styles) composited with its blend mode and opacity. */
  drawContent(ctx, l, c, o, { normal = false, key = '' } = {}) {
    const st = this.styled(l, c, key, o);
    const mode = normal ? 'normal' : l.blend === 'pass through' ? 'normal' : l.blend;
    if (!st.passes) {
      this.drawBody(ctx, l, st.canvas, st.x, st.y, mode, l.opacity * (l.fillOpacity ?? 1));
      return;
    }
    for (const p of st.passes) {
      if (p.kind === 'body') this.drawBody(ctx, l, p.canvas, st.x, st.y, mode, l.opacity);
      else compositeOnto(ctx, p.canvas, st.x, st.y, normal ? 'normal' : p.blend, l.opacity * p.opacity);
    }
  }

  /** Composite the layer body, applying "blend if" ranges against what is below. */
  drawBody(ctx, l, canvas, x, y, mode, alpha) {
    const bi = l.blendIf;
    if (!bi || (bi.this[0] <= 0 && bi.this[3] >= 255 && bi.under[0] <= 0 && bi.under[3] >= 255)) {
      compositeOnto(ctx, canvas, x, y, mode, alpha);
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    const src = cloneCanvas(canvas);
    const sg = src.getContext('2d');
    const sd = sg.getImageData(0, 0, w, h);
    const under = makeCanvas(w, h);
    under.getContext('2d').drawImage(ctx.canvas, -x, -y);
    const ud = under.getContext('2d').getImageData(0, 0, w, h).data;
    const ramp = (v, [a, b, c, d]) => (v < a || v > d ? 0 : v < b ? (v - a) / Math.max(1, b - a) : v > c ? (d - v) / Math.max(1, d - c) : 1);
    const s = sd.data;
    for (let i = 0; i < s.length; i += 4) {
      if (!s[i + 3]) continue;
      const ls = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
      const lu = 0.299 * ud[i] + 0.587 * ud[i + 1] + 0.114 * ud[i + 2];
      s[i + 3] *= ramp(ls, bi.this) * (ud[i + 3] ? ramp(lu, bi.under) : 1);
    }
    sg.putImageData(sd, 0, 0);
    compositeOnto(ctx, src, x, y, mode, alpha);
  }

  /** Content with the layer mask, vector mask and layer styles applied (cached per revision). */
  styled(l, c, extraKey = '', o = null) {
    const fx = l.fx || {};
    const fxOn = hasFx(fx);
    const masked = (l.mask && l.mask.enabled) || (l.vmask && l.vmask.enabled !== false && l.vmask.subpaths?.length);
    if (!fxOn && !masked) return c;
    const key = `${l.rev}:${extraKey}:${c.x},${c.y},${c.canvas.width},${c.canvas.height}:${fxOn ? JSON.stringify(fx) : ''}:${l.fillOpacity}`;
    if (l._styled?.key === key) return l._styled.out;
    const pad = fxOn ? fxPad(fx) : 0;
    const ox = c.x - pad;
    const oy = c.y - pad;
    const body = makeCanvas(c.canvas.width + pad * 2, c.canvas.height + pad * 2);
    const bg = body.getContext('2d');
    bg.drawImage(c.canvas, pad, pad);
    if (l.mask && l.mask.enabled) {
      bg.globalCompositeOperation = 'destination-in';
      bg.drawImage(maskAlpha(this, l.mask), -ox, -oy);
      bg.globalCompositeOperation = 'source-over';
    }
    if (l.vmask && l.vmask.enabled !== false && l.vmask.subpaths?.length && vectorMaskRenderer) {
      bg.globalCompositeOperation = 'destination-in';
      bg.drawImage(vectorMaskRenderer(this, l.vmask), -ox, -oy);
      bg.globalCompositeOperation = 'source-over';
    }
    let out;
    if (!fxOn) out = { canvas: body, x: ox, y: oy };
    else {
      const passes = stylePasses(body, fx, { fill: l.fillOpacity ?? 1, fg: o?.fg, bg: o?.bg, globalAngle: fx.useGlobalLight && this.globalAngle != null ? this.globalAngle : null });
      for (const p of passes) {
        if (p.kind !== 'body' || !p.interior?.length) continue;
        // effects painted inside the layer are blended onto the layer itself
        const g = p.canvas.getContext('2d');
        for (const [cv, blend, op] of p.interior) compositeOnto(g, cv, 0, 0, blend, op);
        p.interior = null;
      }
      out = { passes, x: ox, y: oy };
    }
    l._styled = { key, out };
    return out;
  }

  drawGroup(ctx, g, o, { normal = false } = {}) {
    const kids = this.children(g.id);
    const masked = (g.mask && g.mask.enabled) || (g.vmask && g.vmask.subpaths?.length);
    const passThrough = g.blend === 'pass through' && !normal;
    if (passThrough && g.opacity >= 1 && !masked && !hasFx(g.fx)) {
      this.renderList(ctx, kids, o);
      return;
    }
    const W = this.width;
    const H = this.height;
    if (passThrough && !hasFx(g.fx)) {
      // pass-through with opacity / mask: blend "with the group" against "without the group"
      const tmp = makeCanvas(W, H);
      const tg = tmp.getContext('2d');
      tg.drawImage(ctx.canvas, 0, 0);
      this.renderList(tg, kids, o);
      if (masked) {
        const st = this.styled({ ...g, fx: {} }, { canvas: tmp, x: 0, y: 0 }, `pt${o.sig.length}`);
        compositeOnto(ctx, st.canvas, st.x, st.y, 'normal', g.opacity);
      } else compositeOnto(ctx, tmp, 0, 0, 'normal', g.opacity);
      return;
    }
    const buf = makeCanvas(W, H);
    this.renderList(buf.getContext('2d'), kids, o);
    this.drawContent(ctx, g, { canvas: buf, x: 0, y: 0 }, o, { normal, key: `g${o.sig}` });
  }

  /** A group drawn on its own (isolated, normal blend) as a doc-size canvas. */
  renderGroupAlone(g) {
    const buf = makeCanvas(this.width, this.height);
    this.renderList(buf.getContext('2d'), this.children(g.id), { sig: `alone${g.id}`, only: null, skipId: null, float: null });
    return buf;
  }

  /** A base layer with clipped layers painted inside its pixels. */
  renderClipStack(ctx, base, clips, o) {
    const W = this.width;
    const H = this.height;
    o.sig += `clip${base.id}:${base.rev};`;
    const buf = makeCanvas(W, H);
    const bgc = buf.getContext('2d');
    const above = [];
    // clipped layers show through the base's pixels whatever its fill opacity (a common trick)
    let baseAlpha = null;
    if (base.kind === 'group') {
      this.drawGroup(bgc, { ...base, opacity: 1 }, o, { normal: true });
      baseAlpha = cloneCanvas(buf);
    } else {
      const c = this.content(base);
      if (c) {
        const m = this.styled({ ...base, fx: {}, _styled: null }, c);
        baseAlpha = makeCanvas(W, H);
        baseAlpha.getContext('2d').drawImage(m.canvas, m.x, m.y);
        const st = this.styled(base, c, '', o);
        if (st.passes) {
          // shadows and glows go straight onto the document; stroke and bevel above the clipped stack
          for (const p of st.passes) {
            if (p.kind === 'body') compositeOnto(bgc, p.canvas, st.x, st.y, 'normal', 1);
            else if (p.kind === 'dropShadow' || p.kind === 'outerGlow') compositeOnto(ctx, p.canvas, st.x, st.y, p.blend, base.opacity * p.opacity);
            else above.push([p, st.x, st.y]);
          }
        } else compositeOnto(bgc, st.canvas, st.x, st.y, 'normal', base.fillOpacity ?? 1);
      }
      if (o.float && o.float.layerId === base.id) bgc.drawImage(o.float.canvas, o.float.x, o.float.y);
    }
    for (const c of clips) if (this.drawable(c, o)) this.drawLayer(bgc, c, o);
    bgc.globalCompositeOperation = 'destination-in';
    if (baseAlpha) bgc.drawImage(baseAlpha, 0, 0);
    else bgc.clearRect(0, 0, W, H);
    bgc.globalCompositeOperation = 'source-over';
    this.drawBody(ctx, base, buf, 0, 0, base.blend === 'pass through' ? 'normal' : base.blend, base.opacity);
    for (const [p, x, y] of above) compositeOnto(ctx, p.canvas, x, y, p.blend, base.opacity * p.opacity);
  }

  drawAdjustment(ctx, l, sig, o = {}) {
    const key = `${sig}|${JSON.stringify(l.adjust)}|${l.mask ? l.rev : 0}|${ctx.canvas.width}`;
    let out = l._cache?.key === key ? l._cache.canvas : null;
    if (!out) {
      const src = ctx.canvas;
      out = makeCanvas(src.width, src.height);
      const og = out.getContext('2d');
      const img = src.getContext('2d').getImageData(0, 0, src.width, src.height);
      applyAdjustment(img, l.adjust.type, { ...l.adjust.params, _fg: o.fg, _bg: o.bg });
      og.putImageData(img, 0, 0);
      if (l.mask && l.mask.enabled) {
        og.globalCompositeOperation = 'destination-in';
        og.drawImage(maskAlpha(this, l.mask), 0, 0);
      }
      if (l.vmask?.subpaths?.length && vectorMaskRenderer) {
        og.globalCompositeOperation = 'destination-in';
        og.drawImage(vectorMaskRenderer(this, l.vmask), 0, 0);
      }
      l._cache = { key, canvas: out };
    }
    const mode = l.blend === 'pass through' ? 'normal' : l.blend;
    if (mode === 'normal') {
      // replace, keeping what is below exactly as transparent as it was
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(out, 0, 0);
      ctx.restore();
    } else compositeOnto(ctx, out, 0, 0, mode, l.opacity);
  }

  /** Flattened image (new doc-size canvas). */
  flatten({ upTo, skipId, fg, bg } = {}) {
    const c = makeCanvas(this.width, this.height);
    this.render(c.getContext('2d'), { upTo, skipId, fg, bg });
    return c;
  }

  /** A layer drawn on its own (mask, styles, opacity, normal blend) as a doc-size canvas. */
  rasterizeLayer(l, { withOpacity = false } = {}) {
    const out = makeCanvas(this.width, this.height);
    const g = out.getContext('2d');
    const o = { sig: `r${l.id}`, only: null, skipId: null, float: null };
    if (l.kind === 'group') this.drawGroup(g, { ...l, opacity: withOpacity ? l.opacity : 1 }, o, { normal: true });
    else if (l.kind !== 'adjust') {
      const c = this.content(l);
      if (c) this.drawContent(g, withOpacity ? l : { ...l, opacity: 1, _styled: l._styled }, c, o, { normal: true });
    }
    return out;
  }
}

/** Tight box of non-transparent pixels in a canvas. */
export function alphaBox(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The mask as a doc-size alpha canvas (outside the mask canvas counts as hidden). */
export function maskAlpha(doc, mask) {
  const dens = mask.density ?? 1;
  const feather = mask.feather || 0;
  if (!feather && dens >= 1 && mask.x === 0 && mask.y === 0 && mask.canvas.width === doc.width && mask.canvas.height === doc.height) return mask.canvas;
  const key = `${doc.width}x${doc.height}:${mask.x},${mask.y}:${dens}:${feather}`;
  if (mask._a?.key === key && mask._a.src === mask.canvas) return mask._a.c;
  const c = makeCanvas(doc.width, doc.height);
  const g = c.getContext('2d');
  // density: how much the black parts of the mask hide
  if (dens < 1) {
    g.fillStyle = `rgba(0,0,0,${1 - dens})`;
    g.fillRect(0, 0, c.width, c.height);
  }
  if (feather) g.filter = `blur(${feather / 2}px)`;
  g.drawImage(mask.canvas, mask.x, mask.y);
  g.filter = 'none';
  Object.defineProperty(mask, '_a', { value: { key, src: mask.canvas, c }, enumerable: false, configurable: true, writable: true });
  return c;
}

/** Set by paths.js: renders a vector mask to a doc-size alpha canvas. */
let vectorMaskRenderer = null;
export function setVectorMaskRenderer(fn) {
  vectorMaskRenderer = fn;
}

// ---------------------------------------------------------------- fill layers

export const FILL_TYPES = [['solid', '단색'], ['gradient', '그레이디언트'], ['pattern', '패턴']];

function renderFillLayer(doc, l) {
  const f = l.fill || { type: 'solid', color: '#808080' };
  const key = `${doc.width}x${doc.height}:${JSON.stringify(f)}`;
  if (l._fillc?.key === key) return l._fillc.out;
  let canvas;
  if (f.type === 'gradient') canvas = boxGradient(doc.width, doc.height, f.gradient, { angle: f.angle ?? 90, scale: f.scale ?? 100, style: f.style || 'linear', reverse: !!f.reverse });
  else if (f.type === 'pattern') canvas = paintPattern(doc.width, doc.height, f.pattern || 'checker', f.scale ?? 100);
  else {
    canvas = makeCanvas(doc.width, doc.height);
    const g = canvas.getContext('2d');
    g.fillStyle = f.color || '#808080';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  const out = { canvas, x: 0, y: 0 };
  Object.defineProperty(l, '_fillc', { value: { key, out }, enumerable: false, configurable: true, writable: true });
  return out;
}

// ---------------------------------------------------------------- smart objects

/**
 * smart = { w, h, m: [a, b, c, d, e, f] (source px → doc), corners?: 4 doc points (distort/perspective),
 * filters: [{ id, params, enabled }] }; the source pixels are in layer.smartSrc.
 */
export function smartCorners(l) {
  const s = l.smart;
  if (s.corners) return s.corners;
  const [a, b, c, d, e, f] = s.m;
  return [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
}

let warpRenderer = null;
/** Set by transform.js: draws a source canvas onto 4 corners (projective) or a warp mesh. */
export function setWarpRenderer(fn) {
  warpRenderer = fn;
}

function smartFiltered(l) {
  const filters = (l.smart.filters || []).filter((f) => f.enabled !== false);
  const key = `${JSON.stringify(filters)}`;
  const src = l.smartSrc;
  if (!filters.length || !src) return src;
  if (l._sf?.key === key && l._sf.src === src) return l._sf.c;
  let c = src;
  for (const f of filters) {
    const r = f.id.startsWith('adj:') ? adjustedCopy(c, f.id.slice(4), f.params) : applyFilter(c, f.id, f.params, { fg: f.params?._fg, bg: f.params?._bg });
    if (f.opacity != null && f.opacity < 1) {
      const t = cloneCanvas(c);
      const g = t.getContext('2d');
      g.globalAlpha = f.opacity;
      g.drawImage(r, 0, 0);
      c = t;
    } else c = r;
  }
  Object.defineProperty(l, '_sf', { value: { key, src, c }, enumerable: false, configurable: true, writable: true });
  return c;
}

function adjustedCopy(c, type, params) {
  const out = makeCanvas(c.width, c.height);
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  applyAdjustment(img, type, params || {});
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

function renderSmartLayer(l) {
  const s = l.smart;
  if (!s || !l.smartSrc) return null;
  const key = `${l.rev}:${JSON.stringify(s)}`;
  if (l._smc?.key === key && l._smc.src === l.smartSrc) return l._smc.out;
  const src = smartFiltered(l);
  let out;
  if ((s.corners || s.warp) && warpRenderer) out = warpRenderer(src, s);
  else {
    const cs = smartCorners(l);
    const xs = cs.map((p) => p[0]);
    const ys = cs.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs));
    const y0 = Math.floor(Math.min(...ys));
    const c = makeCanvas(Math.ceil(Math.max(...xs)) - x0 + 1, Math.ceil(Math.max(...ys)) - y0 + 1);
    const g = c.getContext('2d');
    const [a, b, cc, d, e, f] = s.m;
    g.imageSmoothingQuality = 'high';
    g.setTransform(a, b, cc, d, e - x0, f - y0);
    g.drawImage(src, 0, 0, s.w, s.h);
    out = { canvas: c, x: x0, y: y0 };
  }
  Object.defineProperty(l, '_smc', { value: { key, src: l.smartSrc, out }, enumerable: false, configurable: true, writable: true });
  return out;
}

// ---------------------------------------------------------------- text layers

const measureCtx = () => (measureCtx.c ||= makeCanvas(1, 1).getContext('2d'));

export function textFont(t) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${t.size}px "${t.font}", "Noto Sans KR", sans-serif`;
}

let textRenderer = null;
let textMeasurer = null;
/** Set by type.js: richer text (paragraph boxes, vertical text, warp). */
export function setTextEngine(render, measure) {
  textRenderer = render;
  textMeasurer = measure;
}

/** Unrotated size of a text layer's box. */
export function textBox(layer) {
  if (textMeasurer) return textMeasurer(layer);
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
  let out;
  if (textRenderer) out = textRenderer(layer, rotatedBox);
  else {
    const { w, h, lh, lines } = textBox(layer);
    out = rotatedBox(layer, w, h, (g) => {
      g.font = textFont(t);
      if ('letterSpacing' in g) g.letterSpacing = `${t.letterSpacing || 0}px`;
      g.fillStyle = t.color;
      g.textBaseline = 'alphabetic';
      g.textAlign = t.align || 'left';
      const ax = t.align === 'center' ? w / 2 : t.align === 'right' ? w : 0;
      lines.forEach((s, i) => g.fillText(s, ax, i * lh + t.size * 0.95 + (lh - t.size) / 2));
    });
  }
  layer._text = { key, out };
  return out;
}

// ---------------------------------------------------------------- shape layers

export const SHAPES = [['rect', '사각형'], ['round', '둥근 사각형'], ['ellipse', '타원'], ['polygon', '다각형'], ['star', '별'], ['triangle', '삼각형'], ['line', '선'], ['custom', '사용자 정의 모양']];

let customShapePath = null;
/** Set by paths.js: Path2D for custom shapes and vector (path-based) shapes. */
export function setShapePathProvider(fn) {
  customShapePath = fn;
}

export function shapePath(s) {
  if (customShapePath) {
    const p = customShapePath(s);
    if (p) return p;
  }
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
  } else if (s.type === 'polygon') {
    const n = Math.max(3, Math.round(s.sides || 5));
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const x = w / 2 + Math.cos(a) * (w / 2);
      const y = h / 2 + Math.sin(a) * (h / 2);
      if (i) p.lineTo(x, y);
      else p.moveTo(x, y);
    }
    p.closePath();
  } else if (s.type === 'star') {
    const n = Math.max(3, Math.round(s.sides || 5));
    const inner = (s.indent != null ? 1 - s.indent / 100 : 0.4);
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const r = i % 2 ? inner : 1;
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
      g.fill(p, s.fillRule || 'nonzero');
    }
    if ((s.stroke && s.strokeWidth > 0) || s.type === 'line') {
      g.strokeStyle = s.stroke || s.fill || '#000';
      g.lineWidth = Math.max(1, s.strokeWidth || 4);
      g.lineJoin = s.lineJoin || 'round';
      g.lineCap = s.lineCap || 'round';
      if (s.dash?.length) g.setLineDash(s.dash.map((v) => v * g.lineWidth));
      if (s.strokeAlign === 'inside' && s.type !== 'line') {
        g.save();
        g.clip(p);
        g.lineWidth *= 2;
        g.stroke(p);
        g.restore();
      } else if (s.strokeAlign === 'outside' && s.type !== 'line') {
        // outside: a doubled stroke with the shape itself kept clear
        const t = makeCanvas(g.canvas.width, g.canvas.height);
        const tg = t.getContext('2d');
        tg.setTransform(g.getTransform());
        tg.strokeStyle = g.strokeStyle;
        tg.lineWidth = g.lineWidth * 2;
        tg.lineJoin = g.lineJoin;
        tg.setLineDash(g.getLineDash());
        tg.stroke(p);
        tg.globalCompositeOperation = 'destination-out';
        tg.fill(p);
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(t, 0, 0);
        g.restore();
      } else g.stroke(p);
    }
  }, pad * 2);
  layer._shape = { key, out };
  return out;
}

/** Render content of size w×h (top-left at layer.x/y) rotated about its centre. */
export function rotatedBox(layer, w, h, draw, pad = 0) {
  const rot = ((layer.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const W = Math.ceil(w * cos + h * sin) + pad * 2 + 2;
  const H = Math.ceil(w * sin + h * cos) + pad * 2 + 2;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.translate(W / 2, H / 2);
  g.rotate(rot);
  if (layer.skewX) g.transform(1, 0, Math.tan((layer.skewX * Math.PI) / 180), 1, 0, 0);
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

export { normalizeFx };

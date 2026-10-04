// Photo files: open images / PSD / Montage photo projects, save PSD and projects, export PNG/JPG/WebP,
// autosave open documents to IndexedDB, and hand images over to the video editor.

import { readPsd, writePsd } from '../../vendor/ag-psd/ag-psd.min.mjs';
import { PhotoDoc, newLayer, makeCanvas, alphaBox } from './doc.js';
import { isBlend } from './blend.js';
import { defaultParams } from './adjust.js';
import { FX_DEFAULTS, normalizeFx } from './styles.js';
import { userPatterns, rgbHex, hexRgb } from './resources.js';
import { pathBounds, translatePath, shapeToSubpaths, mapPath } from './paths.js';

const baseName = (n) => String(n || '이미지').replace(/\.[^.]+$/, '');

export const OPEN_ACCEPT = 'image/*,.psd,.psb,.mphoto,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif';

export async function canvasFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = makeCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasFromImage(img, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height) {
  const c = makeCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

/** A document made of one image (named after the file). */
export function docFromCanvas(canvas, name) {
  const doc = new PhotoDoc({ name, width: canvas.width, height: canvas.height, background: null });
  const l = newLayer('raster', { name: '배경', canvas });
  doc.layers.push(l);
  doc.activeId = l.id;
  return doc;
}

export async function openFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.psd') || lower.endsWith('.psb')) return finishPsd(docFromPsd(await file.arrayBuffer(), baseName(file.name)));
  if (lower.endsWith('.mphoto') || file.type === 'application/json') return docFromProject(JSON.parse(await file.text()));
  const doc = docFromCanvas(await canvasFromFile(file), baseName(file.name));
  doc.fileName = file.name;
  return doc;
}

// ---------------------------------------------------------------- PSD helpers

const colorHex = (c) => {
  if (!c) return '#000000';
  if ('r' in c) return rgbHex(c.r, c.g, c.b);
  if ('fr' in c) return rgbHex(c.fr * 255, c.fg * 255, c.fb * 255);
  if ('k' in c && !('c' in c)) return rgbHex(255 - c.k * 2.55, 255 - c.k * 2.55, 255 - c.k * 2.55);
  if ('c' in c) return rgbHex(255 * (1 - c.c / 100) * (1 - c.k / 100), 255 * (1 - c.m / 100) * (1 - c.k / 100), 255 * (1 - c.y / 100) * (1 - c.k / 100));
  return '#000000';
};
const psdColor = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return { r, g, b };
};
const px = (u, def = 0) => (u == null ? def : typeof u === 'number' ? u : u.value ?? def);
const unitPx = (v) => ({ units: 'Pixels', value: Math.round(v || 0) });
const blendIn = (b) => (isBlend(b) ? b : 'normal');

function gradientFromPsd(g) {
  if (!g || g.type !== 'solid') return { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] };
  return {
    stops: g.colorStops.map((s) => ({ pos: s.location, color: colorHex(s.color) })),
    alphas: g.opacityStops?.map((s) => ({ pos: s.location, a: s.opacity })),
  };
}
function gradientToPsd(gr, fg = '#000000', bg = '#ffffff') {
  const col = (c) => psdColor(c === 'fg' ? fg : c === 'bg' ? bg : c);
  return {
    name: '사용자 정의', type: 'solid', smoothness: 1,
    colorStops: (gr?.stops || []).map((s) => ({ color: col(s.color), location: s.pos, midpoint: 0.5 })),
    opacityStops: (gr?.alphas?.length ? gr.alphas : [{ pos: 0, a: 1 }, { pos: 1, a: 1 }]).map((s) => ({ opacity: s.a, location: s.pos, midpoint: 0.5 })),
  };
}

/** Photoshop layer effects → our layer styles. */
export function fxFromPsd(e) {
  if (!e) return {};
  const fx = {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const ds = first(e.dropShadow);
  if (ds) fx.dropShadow = { ...FX_DEFAULTS.dropShadow, enabled: ds.enabled !== false, color: colorHex(ds.color), blend: blendIn(ds.blendMode), opacity: ds.opacity ?? 0.75, angle: ds.angle ?? 120, distance: px(ds.distance, 5), spread: px(ds.choke, 0), size: px(ds.size, 5), knockout: ds.layerConceals !== false };
  const is = first(e.innerShadow);
  if (is) fx.innerShadow = { ...FX_DEFAULTS.innerShadow, enabled: is.enabled !== false, color: colorHex(is.color), blend: blendIn(is.blendMode), opacity: is.opacity ?? 0.75, angle: is.angle ?? 120, distance: px(is.distance, 5), choke: px(is.choke, 0), size: px(is.size, 5) };
  if (e.outerGlow) fx.outerGlow = { ...FX_DEFAULTS.outerGlow, enabled: e.outerGlow.enabled !== false, color: colorHex(e.outerGlow.color), blend: blendIn(e.outerGlow.blendMode), opacity: e.outerGlow.opacity ?? 0.75, spread: px(e.outerGlow.choke, 0), size: px(e.outerGlow.size, 5) };
  if (e.innerGlow) fx.innerGlow = { ...FX_DEFAULTS.innerGlow, enabled: e.innerGlow.enabled !== false, color: colorHex(e.innerGlow.color), blend: blendIn(e.innerGlow.blendMode), opacity: e.innerGlow.opacity ?? 0.75, source: e.innerGlow.source || 'edge', choke: px(e.innerGlow.choke, 0), size: px(e.innerGlow.size, 5) };
  const bv = e.bevel;
  if (bv) {
    fx.bevel = {
      ...FX_DEFAULTS.bevel, enabled: bv.enabled !== false, style: bv.style === 'stroke emboss' ? 'emboss' : bv.style || 'inner bevel', technique: bv.technique || 'smooth',
      depth: Math.round((bv.strength ?? 1) * 100), direction: bv.direction || 'up', size: px(bv.size, 5), soften: px(bv.soften, 0), angle: bv.angle ?? 120, altitude: bv.altitude ?? 30,
      highlightColor: colorHex(bv.highlightColor || { r: 255, g: 255, b: 255 }), highlightBlend: blendIn(bv.highlightBlendMode || 'screen'), highlightOpacity: bv.highlightOpacity ?? 0.75,
      shadowColor: colorHex(bv.shadowColor), shadowBlend: blendIn(bv.shadowBlendMode || 'multiply'), shadowOpacity: bv.shadowOpacity ?? 0.75,
    };
  }
  if (e.satin) fx.satin = { ...FX_DEFAULTS.satin, enabled: e.satin.enabled !== false, color: colorHex(e.satin.color), blend: blendIn(e.satin.blendMode), opacity: e.satin.opacity ?? 0.5, angle: e.satin.angle ?? 19, distance: px(e.satin.distance, 11), size: px(e.satin.size, 14), invert: !!e.satin.invert };
  const sf = first(e.solidFill);
  if (sf) fx.colorOverlay = { ...FX_DEFAULTS.colorOverlay, enabled: sf.enabled !== false, color: colorHex(sf.color), blend: blendIn(sf.blendMode), opacity: sf.opacity ?? 1 };
  const go = first(e.gradientOverlay);
  if (go) fx.gradientOverlay = { ...FX_DEFAULTS.gradientOverlay, enabled: go.enabled !== false, blend: blendIn(go.blendMode), opacity: go.opacity ?? 1, style: go.type || 'linear', angle: go.angle ?? 90, scale: Math.round((go.scale ?? 1) * 100), reverse: !!go.reverse, gradient: gradientFromPsd(go.gradient) };
  if (e.patternOverlay) fx.patternOverlay = { ...FX_DEFAULTS.patternOverlay, enabled: e.patternOverlay.enabled !== false, blend: blendIn(e.patternOverlay.blendMode), opacity: e.patternOverlay.opacity ?? 1, scale: Math.round((e.patternOverlay.scale ?? 1) * 100) };
  const st = first(e.stroke);
  if (st) fx.stroke = { ...FX_DEFAULTS.stroke, enabled: st.enabled !== false, size: px(st.size, 3), position: st.position || 'outside', blend: blendIn(st.blendMode), opacity: st.opacity ?? 1, fillType: st.fillType === 'gradient' ? 'gradient' : 'color', color: colorHex(st.color), gradient: st.gradient ? gradientFromPsd(st.gradient) : FX_DEFAULTS.stroke.gradient };
  if (e.disabled) fx.disabled = true;
  return fx;
}

/** Our layer styles → Photoshop layer effects. */
export function fxToPsd(fx, fg, bg) {
  fx = normalizeFx(fx);
  const e = {};
  const on = (k) => fx[k];
  if (on('dropShadow')) {
    const s = fx.dropShadow;
    e.dropShadow = [{ enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), choke: unitPx(s.spread), size: unitPx(s.size), useGlobalLight: false, layerConceals: s.knockout !== false }];
  }
  if (on('innerShadow')) {
    const s = fx.innerShadow;
    e.innerShadow = [{ enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), choke: unitPx(s.choke), size: unitPx(s.size), useGlobalLight: false }];
  }
  if (on('outerGlow')) {
    const s = fx.outerGlow;
    e.outerGlow = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, choke: unitPx(s.spread), size: unitPx(s.size) };
  }
  if (on('innerGlow')) {
    const s = fx.innerGlow;
    e.innerGlow = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, source: s.source, choke: unitPx(s.choke), size: unitPx(s.size) };
  }
  if (on('bevel')) {
    const s = fx.bevel;
    e.bevel = {
      enabled: !!s.enabled, style: s.style, technique: s.technique, strength: (s.depth ?? 100) / 100, direction: s.direction, size: unitPx(s.size), soften: unitPx(s.soften), angle: s.angle, altitude: s.altitude, useGlobalLight: false,
      highlightColor: psdColor(s.highlightColor), highlightBlendMode: s.highlightBlend, highlightOpacity: s.highlightOpacity, shadowColor: psdColor(s.shadowColor), shadowBlendMode: s.shadowBlend, shadowOpacity: s.shadowOpacity,
    };
  }
  if (on('satin')) {
    const s = fx.satin;
    e.satin = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), size: unitPx(s.size), invert: !!s.invert };
  }
  if (on('colorOverlay')) e.solidFill = [{ enabled: !!fx.colorOverlay.enabled, color: psdColor(fx.colorOverlay.color), blendMode: fx.colorOverlay.blend, opacity: fx.colorOverlay.opacity }];
  if (on('gradientOverlay')) {
    const s = fx.gradientOverlay;
    e.gradientOverlay = [{ enabled: !!s.enabled, blendMode: s.blend, opacity: s.opacity, type: s.style, angle: s.angle, scale: (s.scale ?? 100) / 100, reverse: !!s.reverse, align: true, gradient: gradientToPsd(s.gradient, fg, bg) }];
  }
  if (on('stroke')) {
    const s = fx.stroke;
    e.stroke = [{ enabled: !!s.enabled, size: unitPx(s.size), position: s.position, blendMode: s.blend, opacity: s.opacity, fillType: s.fillType === 'gradient' ? 'gradient' : 'color', color: psdColor(s.color), ...(s.fillType === 'gradient' ? { gradient: { ...gradientToPsd(s.gradient, fg, bg), style: 'linear', angle: s.angle ?? 90 } } : {}) }];
  }
  if (fx.disabled) e.disabled = true;
  return Object.keys(e).length ? e : undefined;
}

function maskFromPsd(doc, m) {
  if (!m?.canvas) return null;
  // PSD masks are grey images (white = visible); ours keep visibility in the alpha channel
  const src = m.canvas;
  const g0 = src.getContext('2d');
  const data = g0.getImageData(0, 0, src.width, src.height);
  for (let i = 0; i < data.data.length; i += 4) {
    data.data[i + 3] = data.data[i];
    data.data[i] = data.data[i + 1] = data.data[i + 2] = 0;
  }
  const c = makeCanvas(doc.width, doc.height);
  const g = c.getContext('2d');
  if (m.defaultColor === 255) g.fillRect(0, 0, c.width, c.height);
  const t = makeCanvas(src.width, src.height);
  t.getContext('2d').putImageData(data, 0, 0);
  g.clearRect(m.left || 0, m.top || 0, src.width, src.height);
  g.drawImage(t, m.left || 0, m.top || 0);
  return { canvas: c, x: 0, y: 0, enabled: !m.disabled, linked: true, density: m.userMaskDensity ?? 1, feather: m.userMaskFeather || 0 };
}

function maskToPsd(doc, m) {
  if (!m) return undefined;
  const c = makeCanvas(doc.width, doc.height);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  // alpha → white
  const t = makeCanvas(doc.width, doc.height);
  const tg = t.getContext('2d');
  tg.drawImage(m.canvas, m.x, m.y);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = '#fff';
  tg.fillRect(0, 0, t.width, t.height);
  g.drawImage(t, 0, 0);
  return { canvas: c, left: 0, top: 0, defaultColor: 0, disabled: !m.enabled, userMaskDensity: m.density, userMaskFeather: m.feather };
}

/** PSD bezier paths ↔ our subpaths ({ closed, op, knots: [{ in, p, out }] }). */
export function pathsFromPsd(paths) {
  return (paths || []).map((sp) => ({
    closed: !sp.open, op: sp.operation || 'combine',
    knots: sp.knots.map((k) => ({ in: [k.points[0], k.points[1]], p: [k.points[2], k.points[3]], out: [k.points[4], k.points[5]], smooth: !!k.linked })),
  }));
}
export function pathsToPsd(subpaths) {
  return (subpaths || []).map((sp) => ({
    open: !sp.closed, operation: sp.op || 'combine', fillRule: 'non-zero',
    knots: sp.knots.map((k) => ({ linked: !!k.smooth, points: [...k.in, ...k.p, ...k.out] })),
  }));
}

function adjustFromPsd(a) {
  const ch = (x) => x || {};
  switch (a?.type) {
    case 'invert': return { type: 'invert', params: {} };
    case 'posterize': return { type: 'posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold': return { type: 'threshold', params: { level: a.level ?? 128 } };
    case 'brightness/contrast': return { type: 'brightness', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0 } };
    case 'vibrance': return { type: 'vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'exposure': return { type: 'exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'hue/saturation': return { type: 'hueSat', params: { hue: ch(a.master).hue ?? 0, saturation: ch(a.master).saturation ?? 0, lightness: ch(a.master).lightness ?? 0, colorize: false } };
    case 'color balance': {
      const m = a.midtones || {};
      return { type: 'colorBalance', params: { cr: m.cyanRed ?? 0, mg: m.magentaGreen ?? 0, yb: m.yellowBlue ?? 0, preserve: a.preserveLuminosity !== false } };
    }
    case 'black & white': return { type: 'bw', params: { reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80 } };
    case 'photo filter': return { type: 'photoFilter', params: { color: colorHex(a.color), density: a.density ?? 25, preserve: a.preserveLuminosity !== false } };
    case 'gradient map': {
      const s = a.colorStops || [];
      if (!s.length) return null;
      return { type: 'gradientMap', params: { from: colorHex(s[0].color), to: colorHex(s[s.length - 1].color) } };
    }
    case 'levels': {
      const c = a.rgb;
      if (!c) return null;
      let gamma = c.midtoneInput ?? 1;
      if (gamma > 10) gamma /= 100;
      return { type: 'levels', params: { inBlack: c.shadowInput ?? 0, inWhite: c.highlightInput ?? 255, gamma, outBlack: c.shadowOutput ?? 0, outWhite: c.highlightOutput ?? 255 } };
    }
    case 'curves': return a.rgb?.length ? { type: 'curves', params: { points: a.rgb.map((p) => [p.input, p.output]) } } : null;
    default: return null;
  }
}

function adjustToPsd(l) {
  const p = l.adjust.params;
  switch (l.adjust.type) {
    case 'invert': return { type: 'invert' };
    case 'posterize': return { type: 'posterize', levels: p.levels };
    case 'threshold': return { type: 'threshold', level: p.level };
    case 'brightness': return { type: 'brightness/contrast', brightness: p.brightness, contrast: p.contrast };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance, saturation: p.saturation };
    case 'exposure': return { type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma };
    case 'hueSat': return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: p.hue, saturation: p.saturation, lightness: p.lightness } };
    case 'levels': return { type: 'levels', rgb: { shadowInput: p.inBlack, highlightInput: p.inWhite, shadowOutput: p.outBlack, highlightOutput: p.outWhite, midtoneInput: p.gamma } };
    case 'curves': return { type: 'curves', rgb: p.points.map(([input, output]) => ({ input, output })) };
    case 'colorBalance': return { type: 'color balance', midtones: { cyanRed: p.cr, magentaGreen: p.mg, yellowBlue: p.yb }, shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, preserveLuminosity: !!p.preserve };
    case 'bw': return { type: 'black & white', reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas, useTint: false };
    case 'photoFilter': return { type: 'photo filter', color: psdColor(p.color), density: p.density, preserveLuminosity: !!p.preserve };
    case 'gradientMap': return { type: 'gradient map', gradientType: 'solid', colorStops: [{ color: psdColor(p.from), location: 0, midpoint: 0.5 }, { color: psdColor(p.to), location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] };
    default: return null;
  }
}

// ---------------------------------------------------------------- PSD read

async function decodeLinked(data) {
  if (!data) return null;
  const head = String.fromCharCode(...data.slice(0, 4));
  if (head === '8BPS') {
    const sub = await finishPsd(docFromPsd(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '고급 개체'));
    return { canvas: sub.flatten(), doc: sub };
  }
  try {
    const bmp = await createImageBitmap(new Blob([data]));
    const c = makeCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return { canvas: c, doc: null };
  } catch {
    return null;
  }
}

export function docFromPsd(buffer, name) {
  const psd = readPsd(buffer);
  const doc = new PhotoDoc({ name, width: psd.width, height: psd.height, background: null });
  const notes = { adjust: 0, text: 0, smart: 0, smartFilters: 0 };
  const linked = new Map((psd.linkedFiles || []).map((f) => [f.id, f]));
  doc._pendingSmart = [];
  const walk = (children, parent) => {
    for (const c of children || []) {
      const common = {
        name: c.name || '레이어', visible: !c.hidden, opacity: c.opacity ?? 1, fillOpacity: c.fillOpacity ?? 1, blend: blendIn(c.blendMode), parent,
        clip: !!c.clipping, lockAlpha: !!(c.protected?.transparency || c.transparencyProtected), lockPixels: !!c.protected?.composite, lockPos: !!c.protected?.position,
        color: c.layerColor || 'none', fx: fxFromPsd(c.effects),
      };
      let l;
      if (c.children) {
        l = newLayer('group', { ...common, blend: c.blendMode === 'pass through' || !c.blendMode ? 'pass through' : blendIn(c.blendMode), collapsed: c.opened === false });
        doc.layers.push(l); // placeholder position is fixed below
        walk(c.children, l.id);
        // the group entry sits above its contents
        doc.layers.splice(doc.index(l.id), 1);
        doc.layers.push(l);
        l.mask = maskFromPsd(doc, c.mask);
        continue;
      }
      if (c.adjustment) {
        const adj = adjustFromPsd(c.adjustment);
        if (!adj) {
          notes.adjust++;
          continue;
        }
        l = newLayer('adjust', { ...common, adjust: { type: adj.type, params: { ...defaultParams(adj.type), ...adj.params } } });
      } else if (c.vectorFill?.type === 'color' && c.vectorMask?.paths?.length && !c.vectorMask.invert) {
        // a Photoshop shape layer: an editable path shape
        const sps = pathsFromPsd(c.vectorMask.paths);
        const b = pathBounds(sps) || { x: 0, y: 0, w: 1, h: 1 };
        const vs = c.vectorStroke;
        const strokeOn = vs && vs.strokeEnabled !== false && vs.content?.type === 'color' && px(vs.lineWidth, 0) > 0;
        l = newLayer('shape', {
          ...common, x: b.x, y: b.y,
          shape: { type: 'path', subpaths: translatePath(sps, -b.x, -b.y), w: Math.max(1, b.w), h: Math.max(1, b.h), pw: Math.max(1, b.w), ph: Math.max(1, b.h), fill: vs?.fillEnabled === false ? null : colorHex(c.vectorFill.color), stroke: strokeOn ? colorHex(vs.content.color) : null, strokeWidth: strokeOn ? px(vs.lineWidth, 0) : 0, strokeAlign: vs?.lineAlignment || 'center' },
        });
        doc.layers.push(l);
        l.mask = maskFromPsd(doc, c.mask);
        continue;
      } else if (c.vectorFill && !c.canvas && !c.vectorMask?.paths?.length) {
        const vf = c.vectorFill;
        const fill = vf.type === 'color' ? { type: 'solid', color: colorHex(vf.color) } : vf.type === 'solid' ? { type: 'gradient', gradient: gradientFromPsd(vf), angle: vf.angle ?? 90, style: vf.style || 'linear', scale: Math.round((vf.scale ?? 1) * 100), reverse: !!vf.reverse } : { type: 'solid', color: '#808080' };
        l = newLayer('fill', { ...common, fill });
      } else if (c.placedLayer && linked.get(c.placedLayer.id)?.data && !c.placedLayer.filter?.list?.length) {
        if (!c.canvas) continue;
        l = newLayer('raster', { ...common, canvas: c.canvas, x: c.left || 0, y: c.top || 0 });
        // turned into a smart object once its embedded file is decoded (async, see finishPsd)
        doc._pendingSmart.push({ id: l.id, placed: c.placedLayer, data: linked.get(c.placedLayer.id).data });
      } else {
        if (!c.canvas) continue;
        if (c.placedLayer?.filter?.list?.length) notes.smartFilters++;
        l = newLayer('raster', { ...common, canvas: c.canvas, x: c.left || 0, y: c.top || 0 });
        if (c.text) {
          notes.text++;
          l.name = c.name || c.text.text?.slice(0, 30) || '텍스트';
          l.psdText = { text: c.text.text, font: c.text.style?.font?.name, size: c.text.style?.fontSize, color: c.text.style?.fillColor ? colorHex(c.text.style.fillColor) : null };
        }
      }
      l.mask = maskFromPsd(doc, c.mask);
      if (c.vectorMask?.paths?.length) l.vmask = { subpaths: pathsFromPsd(c.vectorMask.paths), enabled: !c.vectorMask.disable, invert: !!c.vectorMask.invert, linked: true };
      doc.layers.push(l);
    }
  };
  walk(psd.children, null);
  if (!doc.layers.length && psd.canvas) doc.layers.push(newLayer('raster', { name: '배경', canvas: psd.canvas }));
  doc.activeId = doc.layers[doc.layers.length - 1]?.id || null;
  doc.selectedIds = doc.activeId ? [doc.activeId] : [];
  const msg = [];
  if (notes.adjust) msg.push(`지원하지 않는 조정 레이어 ${notes.adjust}개는 빠졌습니다`);
  if (notes.text) msg.push(`글자 레이어 ${notes.text}개는 이미지로 열었습니다 (글꼴 차이 때문에 모양을 그대로 두려고)`);
  if (notes.smartFilters) msg.push(`고급 필터가 있는 고급 개체 ${notes.smartFilters}개는 필터가 적용된 이미지로 열었습니다`);
  doc.importNote = msg.join(' · ');
  if (psd.imageResources?.gridAndGuidesInformation?.guides) {
    doc.guides = psd.imageResources.gridAndGuidesInformation.guides.map((g) => ({ axis: g.direction === 'horizontal' ? 'y' : 'x', pos: g.location }));
  }
  if (psd.imageResources?.resolutionInfo) doc.resolution = Math.round(psd.imageResources.resolutionInfo.horizontalResolution || 72);
  return doc;
}

/** Decode embedded smart object files after a PSD was read (needs async image decoding). */
export async function finishPsd(doc) {
  for (const p of doc._pendingSmart || []) {
    const l = doc.layer(p.id);
    const dec = await decodeLinked(p.data);
    if (!l || !dec) continue;
    const w = dec.canvas.width;
    const h = dec.canvas.height;
    const t = p.placed.transform || [0, 0, w, 0, w, h, 0, h];
    const [x0, y0, x1, y1, x2, y2, x3, y3] = t;
    const smart = { w, h, m: [(x1 - x0) / w, (y1 - y0) / w, (x3 - x0) / h, (y3 - y0) / h, x0, y0], filters: [] };
    if (Math.abs(x2 - (x1 + x3 - x0)) > 1 || Math.abs(y2 - (y1 + y3 - y0)) > 1) smart.corners = [[x0, y0], [x1, y1], [x2, y2], [x3, y3]];
    Object.assign(l, { kind: 'smart', smart, smartSrc: dec.canvas, smartDoc: dec.doc, canvas: null });
    doc.touch(l);
  }
  delete doc._pendingSmart;
  return doc;
}

// ---------------------------------------------------------------- PSD write

/** options: { editableText } — write text layers as Photoshop text (experimental). */
export function docToPsd(doc, { editableText = false, fg = '#000000', bg = '#ffffff' } = {}) {
  let skipped = 0;
  const flat = { fill: 0, smart: 0, shape: 0 };
  const layerOut = (l) => {
    const base = {
      name: l.name, opacity: l.opacity, fillOpacity: l.fillOpacity ?? 1, hidden: !l.visible, blendMode: l.blend, clipping: !!l.clip,
      transparencyProtected: !!l.lockAlpha, protected: { transparency: !!l.lockAlpha, composite: !!l.lockPixels, position: !!l.lockPos },
      layerColor: l.color && l.color !== 'none' ? l.color : undefined, effects: l.kind === 'adjust' ? undefined : fxToPsd(l.fx, fg, bg),
      mask: maskToPsd(doc, l.mask),
      vectorMask: l.vmask?.subpaths?.length ? { paths: pathsToPsd(l.vmask.subpaths.map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ ...k, in: [k.in[0] + (l.vmask.dx || 0), k.in[1] + (l.vmask.dy || 0)], p: [k.p[0] + (l.vmask.dx || 0), k.p[1] + (l.vmask.dy || 0)], out: [k.out[0] + (l.vmask.dx || 0), k.out[1] + (l.vmask.dy || 0)] })) }))), invert: !!l.vmask.invert, disable: l.vmask.enabled === false } : undefined,
    };
    if (l.kind === 'group') return { ...base, blendMode: l.blend, opened: !l.collapsed, children: doc.children(l.id).map(layerOut).filter(Boolean) };
    if (l.kind === 'adjust') {
      const a = adjustToPsd(l);
      if (!a) {
        skipped++;
        return null;
      }
      return { ...base, adjustment: a };
    }
    const c = doc.content(l);
    if (!c) return null;
    if (l.kind === 'fill') flat.fill++;
    if (l.kind === 'smart') flat.smart++;
    if (l.kind === 'shape') flat.shape++;
    const out = { ...base, canvas: c.canvas, left: c.x, top: c.y };
    if (l.kind === 'shape' && editableText && l.shape.fill && !l.rotation) {
      // a real Photoshop shape layer: vector mask + solid colour fill (+ stroke)
      const s = l.shape;
      const kx = s.w / (s.pw || s.w || 1);
      const ky = s.h / (s.ph || s.h || 1);
      const local = s.type === 'path' ? mapPath(s.subpaths, ([x, y]) => [x * kx, y * ky]) : shapeToSubpaths(s);
      const sps = translatePath(local, l.x, l.y).map((sp) => ({ ...sp, closed: s.type === 'line' ? false : sp.closed }));
      flat.shape--;
      out.vectorMask = { paths: pathsToPsd(sps) };
      out.vectorFill = { type: 'color', color: psdColor(s.fill) };
      if (s.stroke && s.strokeWidth) out.vectorStroke = { strokeEnabled: true, fillEnabled: true, lineWidth: unitPx(s.strokeWidth), lineAlignment: s.strokeAlign || 'center', lineCapType: 'round', lineJoinType: 'round', content: { type: 'color', color: psdColor(s.stroke) }, opacity: 1, blendMode: 'normal' };
    }
    if (l.kind === 'text' && editableText) {
      const t = l.text;
      out.text = {
        text: t.content,
        transform: [1, 0, 0, 1, l.x, l.y + t.size * 0.95],
        style: { font: { name: String(t.font || 'NotoSansKR').replace(/\s+/g, '') }, fontSize: t.size, fillColor: psdColor(t.color), fauxBold: !!t.bold, fauxItalic: !!t.italic, tracking: Math.round((t.letterSpacing || 0) * 1000 / Math.max(1, t.size)) },
        paragraphStyle: { justification: t.align || 'left' },
      };
    }
    return out;
  };
  const children = doc.children(null).map(layerOut).filter(Boolean);
  const psd = {
    width: doc.width, height: doc.height, canvas: doc.flatten({ fg, bg }), children,
    imageResources: {
      resolutionInfo: { horizontalResolution: doc.resolution || 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: doc.resolution || 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' },
      ...(doc.guides?.length ? { gridAndGuidesInformation: { grid: { horizontal: 18 * 32, vertical: 18 * 32 }, guides: doc.guides.map((g) => ({ location: g.pos, direction: g.axis === 'y' ? 'horizontal' : 'vertical' })) } } : {}),
    },
  };
  const buf = writePsd(psd, { generateThumbnail: true, invalidateTextLayers: editableText, noBackground: true });
  return { blob: new Blob([buf], { type: 'image/vnd.adobe.photoshop' }), skipped, flat };
}

// ---------------------------------------------------------------- documents ↔ plain data (projects, autosave)

const PLAIN_SKIP = new Set(['canvas', 'mask', 'smartSrc', 'smartDoc']);

/** A JSON-able copy of a document; `enc(canvas)` turns canvases into data URLs or blobs. */
export async function serializeDoc(doc, enc) {
  const layers = [];
  for (const l of doc.layers) {
    const o = {};
    for (const [k, v] of Object.entries(l)) if (!k.startsWith('_') && !PLAIN_SKIP.has(k)) o[k] = v;
    o.canvas = await enc(l.canvas);
    o.mask = l.mask ? { ...l.mask, canvas: await enc(l.mask.canvas) } : null;
    o.smartSrc = await enc(l.smartSrc);
    o.smartDoc = l.smartDoc ? await serializeDoc(l.smartDoc, enc) : null;
    layers.push(o);
  }
  const channels = [];
  for (const ch of doc.channels || []) channels.push({ ...ch, canvas: await enc(ch.canvas) });
  return {
    name: doc.name, width: doc.width, height: doc.height, activeId: doc.activeId, selectedIds: doc.selectedIds, sourceMediaId: doc.sourceMediaId,
    guides: doc.guides, paths: doc.paths, workPath: doc.workPath, notes: doc.notes, counts: doc.counts, samplers: doc.samplers, mode: doc.mode, resolution: doc.resolution,
    channels, layers,
  };
}

export async function deserializeDoc(o, dec) {
  const doc = new PhotoDoc({ name: o.name, width: o.width, height: o.height, background: null });
  for (const l of o.layers) {
    doc.layers.push({
      ...newLayer(l.kind), ...l, fx: normalizeFx(l.fx), canvas: await dec(l.canvas), mask: l.mask ? { ...l.mask, canvas: await dec(l.mask.canvas) } : null,
      smartSrc: await dec(l.smartSrc), smartDoc: l.smartDoc ? await deserializeDoc(l.smartDoc, dec) : null, rev: 0,
    });
  }
  doc.activeId = o.activeId || doc.layers[doc.layers.length - 1]?.id || null;
  doc.selectedIds = o.selectedIds?.length ? o.selectedIds : doc.activeId ? [doc.activeId] : [];
  for (const k of ['guides', 'paths', 'notes', 'counts', 'samplers']) doc[k] = o[k] || [];
  doc.workPath = o.workPath || null;
  doc.mode = o.mode || 'rgb';
  doc.resolution = o.resolution || 72;
  doc.sourceMediaId = o.sourceMediaId || null;
  doc.channels = [];
  for (const ch of o.channels || []) doc.channels.push({ ...ch, canvas: await dec(ch.canvas) });
  return doc;
}

async function patternsOut(enc) {
  const out = [];
  for (const [id, p] of userPatterns) out.push({ id, name: p.name, canvas: await enc(p.canvas) });
  return out;
}
async function patternsIn(list, dec) {
  for (const p of list || []) if (!userPatterns.has(p.id)) userPatterns.set(p.id, { name: p.name, canvas: await dec(p.canvas) });
}

// ---------------------------------------------------------------- Montage photo project (.mphoto)

const toDataUrl = async (c) => (c ? c.toDataURL('image/png') : null);
async function dataUrlCanvas(url) {
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return canvasFromImage(img);
}

export async function docToProject(doc) {
  return { format: 'montage-photo', version: 2, ...(await serializeDoc(doc, toDataUrl)), patterns: await patternsOut(toDataUrl) };
}

export async function docFromProject(p) {
  if (p?.format !== 'montage-photo') throw new Error('Montage 사진 파일이 아닙니다');
  await patternsIn(p.patterns, dataUrlCanvas);
  return deserializeDoc(p, dataUrlCanvas);
}

// ---------------------------------------------------------------- export

export const EXPORT_TYPES = [['png', 'PNG (투명 유지)', 'image/png'], ['jpg', 'JPG (사진, 작은 파일)', 'image/jpeg'], ['webp', 'WebP (웹용)', 'image/webp']];

export function exportBlob(doc, type = 'png', quality = 0.92, scale = 1, { fg, bg, canvas = null, matte = '#ffffff' } = {}) {
  const flat = canvas || doc.flatten({ fg, bg });
  let c = flat;
  if (scale !== 1 || type === 'jpg') {
    c = makeCanvas(flat.width * scale, flat.height * scale);
    const g = c.getContext('2d');
    if (type === 'jpg') {
      g.fillStyle = matte;
      g.fillRect(0, 0, c.width, c.height);
    }
    g.imageSmoothingQuality = 'high';
    g.drawImage(flat, 0, 0, c.width, c.height);
  }
  const mime = EXPORT_TYPES.find((t) => t[0] === type)?.[2] || 'image/png';
  return new Promise((resolve) => c.toBlob(resolve, mime, quality));
}

/** Each layer (or top-level group) as its own PNG: [{ name, blob }]. */
export async function exportLayers(doc, { visibleOnly = true, trim = true } = {}) {
  const out = [];
  for (const l of doc.children(null)) {
    if (visibleOnly && !l.visible) continue;
    if (l.kind === 'adjust') continue;
    let c = doc.rasterizeLayer(l, { withOpacity: true });
    if (trim) {
      const b = alphaBox(c);
      if (!b) continue;
      const t = makeCanvas(b.w, b.h);
      t.getContext('2d').drawImage(c, -b.x, -b.y);
      c = t;
    }
    out.push({ name: l.name, blob: await new Promise((r) => c.toBlob(r, 'image/png')) });
  }
  return out;
}

// ---------------------------------------------------------------- autosave (IndexedDB)

const DB = 'montage-photo';
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function kv(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const blobOf = new WeakMap();
const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
async function canvasBlob(c) {
  if (!c) return null;
  if (!blobOf.has(c)) blobOf.set(c, await toBlob(c));
  return blobOf.get(c);
}
async function blobCanvas(b) {
  if (!b) return null;
  const bmp = await createImageBitmap(b);
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  blobOf.set(c, b);
  return c;
}

export async function saveSession(docs, activeIndex) {
  const out = [];
  for (const doc of docs) out.push({ ...(await serializeDoc(doc, canvasBlob)), smartParent: doc.smartParent || null });
  const patterns = await patternsOut(canvasBlob);
  await kv('readwrite', (s) => s.put({ docs: out, activeIndex, patterns, savedAt: Date.now() }, 'session'));
}

export async function loadSession() {
  const s = await kv('readonly', (st) => st.get('session')).catch(() => null);
  if (!s?.docs?.length) return null;
  await patternsIn(s.patterns, blobCanvas);
  const docs = [];
  for (const d of s.docs) {
    const doc = await deserializeDoc(d, blobCanvas);
    doc.smartParent = d.smartParent || null;
    doc.saved = true;
    docs.push(doc);
  }
  return { docs, activeIndex: Math.min(s.activeIndex || 0, docs.length - 1) };
}

export async function clearSession() {
  await kv('readwrite', (s) => s.delete('session')).catch(() => {});
}

// ---------------------------------------------------------------- a small ZIP writer (stored, no compression)

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, blob }] → a .zip Blob (UTF-8 names). */
export async function zipFiles(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const used = new Set();
  for (const f of files) {
    let name = f.name.replace(/[\\/:*?"<>|]/g, '_');
    let n = 2;
    while (used.has(name)) name = f.name.replace(/(\.[^.]+)?$/, ` (${n++})$1`);
    used.add(name);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

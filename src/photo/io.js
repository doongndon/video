// Photo files: open images / PSD / Montage photo projects, save PSD and projects, export PNG/JPG/WebP,
// autosave open documents to IndexedDB, and hand images over to the video editor.

import { readPsd, writePsd } from '../../vendor/ag-psd/ag-psd.min.mjs';
import { PhotoDoc, newLayer, makeCanvas, alphaBox, psdTextKey, textBox } from './doc.js';
import { isBlend } from './blend.js';
import { defaultParams } from './adjust.js';
import { FX_DEFAULTS, normalizeFx, instanceKeys } from './styles.js';
import { newText } from './type.js';
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

// Photoshop's contour preset names ↔ ours (styles.js CONTOURS)
const CONTOUR_NAMES = {
  linear: 'Linear', cone: 'Cone', coneInv: 'Cone - Inverted', gaussian: 'Gaussian', halfRound: 'Half Round', ring: 'Ring', ringDouble: 'Ring - Double',
  sawtooth: 'Sawtooth 1', coveDeep: 'Cove - Deep', coveShallow: 'Cove - Shallow', rollingSlope: 'Rolling Slope - Descending', roundedSteps: 'Rounded Steps', log: 'Log',
};
const CONTOUR_CURVES = {
  linear: [[0, 0], [255, 255]], cone: [[0, 0], [128, 255], [255, 0]], coneInv: [[0, 255], [128, 0], [255, 255]], gaussian: [[0, 0], [64, 26], [191, 229], [255, 255]],
  halfRound: [[0, 0], [64, 168], [128, 222], [255, 255]], ring: [[0, 0], [128, 255], [255, 0]], ringDouble: [[0, 0], [64, 255], [128, 0], [191, 255], [255, 0]],
  sawtooth: [[0, 0], [85, 255], [86, 0], [170, 255], [171, 0], [255, 255]], coveDeep: [[0, 0], [128, 32], [255, 255]], coveShallow: [[0, 0], [128, 90], [255, 255]],
  rollingSlope: [[0, 255], [128, 128], [255, 0]], roundedSteps: [[0, 0], [64, 64], [128, 128], [191, 191], [255, 255]], log: [[0, 0], [64, 154], [128, 211], [255, 255]],
};
function contourIn(c) {
  if (!c?.name) return 'linear';
  const n = String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [id, name] of Object.entries(CONTOUR_NAMES)) if (name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === n) return id;
  if (n.includes('cone') && n.includes('inv')) return 'coneInv';
  if (n.includes('cone')) return 'cone';
  if (n.includes('gauss')) return 'gaussian';
  if (n.includes('ring') && n.includes('double')) return 'ringDouble';
  if (n.includes('ring')) return 'ring';
  if (n.includes('half')) return 'halfRound';
  return 'linear';
}
const contourOut = (id) => ({ name: CONTOUR_NAMES[id] || 'Linear', curve: (CONTOUR_CURVES[id] || CONTOUR_CURVES.linear).map(([x, y]) => ({ x, y })) });
// ag-psd keeps percentages as fractions (1 = 100%)
const pctIn = (v, def = 0) => (v == null ? def : Math.round(v * 100));

/** Photoshop layer effects → our layer styles (several instances become stroke, stroke_2, …). */
export function fxFromPsd(e) {
  if (!e) return {};
  const fx = {};
  const all = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const put = (k, list) => { list.forEach((v, i) => { fx[i ? `${k}_${i + 1}` : k] = v; }); };
  const common = (x) => ({ useGlobalLight: !!x.useGlobalLight, ...(x.contour ? { contour: contourIn(x.contour) } : {}), ...(x.antialiased ? { antialias: true } : {}), ...(x.noise ? { noise: pctIn(x.noise) } : {}) });
  put('dropShadow', all(e.dropShadow).map((ds) => ({ ...FX_DEFAULTS.dropShadow, enabled: ds.enabled !== false, color: colorHex(ds.color), blend: blendIn(ds.blendMode), opacity: ds.opacity ?? 0.75, angle: ds.angle ?? 120, distance: px(ds.distance, 5), spread: px(ds.choke, 0), size: px(ds.size, 5), knockout: ds.layerConceals !== false, ...common(ds) })));
  put('innerShadow', all(e.innerShadow).map((is) => ({ ...FX_DEFAULTS.innerShadow, enabled: is.enabled !== false, color: colorHex(is.color), blend: blendIn(is.blendMode), opacity: is.opacity ?? 0.75, angle: is.angle ?? 120, distance: px(is.distance, 5), choke: px(is.choke, 0), size: px(is.size, 5), ...common(is) })));
  for (const og of all(e.outerGlow).slice(0, 1)) fx.outerGlow = { ...FX_DEFAULTS.outerGlow, enabled: og.enabled !== false, color: colorHex(og.color), blend: blendIn(og.blendMode), opacity: og.opacity ?? 0.75, spread: px(og.choke, 0), size: px(og.size, 5), technique: og.technique === 'precise' ? 'precise' : 'softer', range: pctIn(og.range, 50), ...common(og) };
  for (const ig of all(e.innerGlow).slice(0, 1)) fx.innerGlow = { ...FX_DEFAULTS.innerGlow, enabled: ig.enabled !== false, color: colorHex(ig.color), blend: blendIn(ig.blendMode), opacity: ig.opacity ?? 0.75, source: ig.source || 'edge', choke: px(ig.choke, 0), size: px(ig.size, 5), technique: ig.technique === 'precise' ? 'precise' : 'softer', range: pctIn(ig.range, 50), ...common(ig) };
  for (const bv of all(e.bevel).slice(0, 1)) {
    // ag-psd gives the depth as a percentage (older files: a fraction)
    const depth = bv.strength == null ? 100 : bv.strength <= 10 ? Math.round(bv.strength * 100) : Math.round(bv.strength);
    fx.bevel = {
      ...FX_DEFAULTS.bevel, enabled: bv.enabled !== false, style: bv.style || 'inner bevel', technique: bv.technique || 'smooth',
      depth, direction: bv.direction || 'up', size: px(bv.size, 5), soften: px(bv.soften, 0), angle: bv.angle ?? 120, altitude: bv.altitude ?? 30, useGlobalLight: !!bv.useGlobalLight,
      highlightColor: colorHex(bv.highlightColor || { r: 255, g: 255, b: 255 }), highlightBlend: blendIn(bv.highlightBlendMode || 'screen'), highlightOpacity: bv.highlightOpacity ?? 0.75,
      shadowColor: colorHex(bv.shadowColor), shadowBlend: blendIn(bv.shadowBlendMode || 'multiply'), shadowOpacity: bv.shadowOpacity ?? 0.75,
      ...(bv.contour ? { gloss: contourIn(bv.contour) } : {}),
    };
  }
  for (const sa of all(e.satin).slice(0, 1)) fx.satin = { ...FX_DEFAULTS.satin, enabled: sa.enabled !== false, color: colorHex(sa.color), blend: blendIn(sa.blendMode), opacity: sa.opacity ?? 0.5, angle: sa.angle ?? 19, distance: px(sa.distance, 11), size: px(sa.size, 14), invert: !!sa.invert, contour: sa.contour ? contourIn(sa.contour) : 'gaussian' };
  put('colorOverlay', all(e.solidFill).map((sf) => ({ ...FX_DEFAULTS.colorOverlay, enabled: sf.enabled !== false, color: colorHex(sf.color), blend: blendIn(sf.blendMode), opacity: sf.opacity ?? 1 })));
  put('gradientOverlay', all(e.gradientOverlay).map((go) => ({ ...FX_DEFAULTS.gradientOverlay, enabled: go.enabled !== false, blend: blendIn(go.blendMode), opacity: go.opacity ?? 1, style: go.type || 'linear', angle: go.angle ?? 90, scale: Math.round((go.scale ?? 1) * (go.scale > 5 ? 1 : 100)), reverse: !!go.reverse, align: go.align !== false, dither: !!go.dither, gradient: gradientFromPsd(go.gradient) })));
  for (const po of all(e.patternOverlay).slice(0, 1)) fx.patternOverlay = { ...FX_DEFAULTS.patternOverlay, enabled: po.enabled !== false, blend: blendIn(po.blendMode), opacity: po.opacity ?? 1, scale: Math.round((po.scale ?? 1) * (po.scale > 5 ? 1 : 100)) };
  put('stroke', all(e.stroke).map((st) => ({
    ...FX_DEFAULTS.stroke, enabled: st.enabled !== false, size: px(st.size, 3), position: st.position || 'outside', blend: blendIn(st.blendMode), opacity: st.opacity ?? 1,
    fillType: st.fillType === 'gradient' ? 'gradient' : st.fillType === 'pattern' ? 'pattern' : 'color', color: colorHex(st.color),
    gradient: st.gradient ? gradientFromPsd(st.gradient) : FX_DEFAULTS.stroke.gradient, ...(st.gradient?.angle != null || st.angle != null ? { angle: st.angle ?? st.gradient?.angle } : {}),
  })));
  if (e.disabled) fx.disabled = true;
  return fx;
}

/** Our layer styles → Photoshop layer effects. */
export function fxToPsd(fx, fg, bg) {
  fx = normalizeFx(fx);
  const e = {};
  const list = (k) => instanceKeys(fx, k).map((key) => fx[key]);
  const common = (s) => ({ useGlobalLight: !!s.useGlobalLight, ...(s.contour && s.contour !== 'linear' ? { contour: contourOut(s.contour) } : {}), antialiased: !!s.antialias, noise: (s.noise || 0) / 100 });
  if (list('dropShadow').length) e.dropShadow = list('dropShadow').map((s) => ({ enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), choke: unitPx(s.spread), size: unitPx(s.size), layerConceals: s.knockout !== false, ...common(s) }));
  if (list('innerShadow').length) e.innerShadow = list('innerShadow').map((s) => ({ enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), choke: unitPx(s.choke), size: unitPx(s.size), ...common(s) }));
  if (fx.outerGlow) {
    const s = fx.outerGlow;
    e.outerGlow = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, choke: unitPx(s.spread), size: unitPx(s.size), range: (s.range ?? 50) / 100, technique: s.technique === 'precise' ? 'precise' : 'softer', ...common(s) };
  }
  if (fx.innerGlow) {
    const s = fx.innerGlow;
    e.innerGlow = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, source: s.source, choke: unitPx(s.choke), size: unitPx(s.size), range: (s.range ?? 50) / 100, technique: s.technique === 'precise' ? 'precise' : 'softer', ...common(s) };
  }
  if (fx.bevel) {
    const s = fx.bevel;
    e.bevel = {
      enabled: !!s.enabled, style: s.style, technique: s.technique, strength: (s.depth ?? 100) / 100, direction: s.direction, size: unitPx(s.size), soften: unitPx(s.soften), angle: s.angle, altitude: s.altitude, useGlobalLight: !!s.useGlobalLight,
      highlightColor: psdColor(s.highlightColor), highlightBlendMode: s.highlightBlend, highlightOpacity: s.highlightOpacity, shadowColor: psdColor(s.shadowColor), shadowBlendMode: s.shadowBlend, shadowOpacity: s.shadowOpacity,
      ...(s.gloss && s.gloss !== 'linear' ? { contour: contourOut(s.gloss) } : {}),
    };
  }
  if (fx.satin) {
    const s = fx.satin;
    e.satin = { enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity, angle: s.angle, distance: unitPx(s.distance), size: unitPx(s.size), invert: !!s.invert, contour: contourOut(s.contour || 'gaussian') };
  }
  if (list('colorOverlay').length) e.solidFill = list('colorOverlay').map((s) => ({ enabled: !!s.enabled, color: psdColor(s.color), blendMode: s.blend, opacity: s.opacity }));
  if (list('gradientOverlay').length) e.gradientOverlay = list('gradientOverlay').map((s) => ({ enabled: !!s.enabled, blendMode: s.blend, opacity: s.opacity, type: s.style, angle: s.angle, scale: (s.scale ?? 100) / 100, reverse: !!s.reverse, align: s.align !== false, dither: !!s.dither, gradient: gradientToPsd(s.gradient, fg, bg) }));
  if (list('stroke').length) {
    e.stroke = list('stroke').map((s) => ({
      enabled: !!s.enabled, size: unitPx(s.size), position: s.position, blendMode: s.blend, opacity: s.opacity, fillType: s.fillType === 'gradient' ? 'gradient' : 'color', color: psdColor(s.color),
      ...(s.fillType === 'gradient' ? { gradient: { ...gradientToPsd(s.gradient, fg, bg), style: s.style || 'linear', angle: s.angle ?? 90 } } : {}),
    }));
  }
  if (fx.disabled) e.disabled = true;
  if (!Object.keys(e).length) return undefined;
  e.scale = 1;
  return e;
}

/** Blending Options read from a PSD layer (fill is read with the common settings). */
function blendOptsFromPsd(c) {
  const o = {};
  const br = c.blendingRanges;
  if (br?.compositeGrayBlendSource) {
    const r4 = (v) => (Array.isArray(v) && v.length === 4 ? [v[0], v[1], v[2], v[3]] : [0, 0, 255, 255]);
    const bi = { this: r4(br.compositeGrayBlendSource), under: r4(br.compositeGraphBlendDestinationRange) };
    ['r', 'g', 'b'].forEach((ch, i) => {
      const rr = br.ranges?.[i];
      if (rr) bi[ch] = { this: r4(rr.sourceRange), under: r4(rr.destRange) };
    });
    o.blendIf = bi;
  }
  const ex = c.channelBlendingRestrictions;
  if (Array.isArray(ex) && ex.some((i) => i >= 0 && i <= 2)) o.blendChannels = { r: !ex.includes(0), g: !ex.includes(1), b: !ex.includes(2) };
  if (c.knockout) o.knockout = 'shallow';
  if (c.blendClippendElements === false) o.blendClipped = false;
  if (c.blendInteriorElements) o.blendInterior = true;
  if (c.transparencyShapesLayer === false) o.transparencyShapes = false;
  if (c.layerMaskAsGlobalMask) o.maskHidesFx = true;
  if (c.vectorMaskAsGlobalMask) o.vmaskHidesFx = true;
  return o;
}
function blendOptsToPsd(l) {
  const o = {};
  const bi = l.blendIf;
  if (bi) {
    const full = [0, 0, 255, 255];
    o.blendingRanges = {
      compositeGrayBlendSource: bi.this || full, compositeGraphBlendDestinationRange: bi.under || full,
      ranges: ['r', 'g', 'b'].map((ch) => ({ sourceRange: bi[ch]?.this || full, destRange: bi[ch]?.under || full })),
    };
  }
  const ch = l.blendChannels;
  if (ch && (ch.r === false || ch.g === false || ch.b === false)) {
    const ex = [ch.r === false ? 0 : -1, ch.g === false ? 1 : -1, ch.b === false ? 2 : -1].filter((i) => i >= 0);
    // ag-psd's reader drops the last entry: repeat it (a repeated channel means the same to Photoshop)
    o.channelBlendingRestrictions = [...ex, ex[ex.length - 1]];
  }
  if (l.knockout && l.knockout !== 'none') o.knockout = true;
  if (l.blendClipped === false) o.blendClippendElements = false;
  if (l.blendInterior) o.blendInteriorElements = true;
  if (l.transparencyShapes === false) o.transparencyShapesLayer = false;
  if (l.maskHidesFx) o.layerMaskAsGlobalMask = true;
  return o;
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
    case 'hue/saturation': {
      const ranges = {};
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']) {
        const r = a[k];
        if (r && (r.hue || r.saturation || r.lightness)) ranges[k] = { h: r.hue || 0, s: r.saturation || 0, l: r.lightness || 0, ...(r.a != null && (r.a || r.b || r.c || r.d) ? { r: [r.a, r.b, r.c, r.d] } : {}) };
      }
      return { type: 'hueSat', params: { hue: ch(a.master).hue ?? 0, saturation: ch(a.master).saturation ?? 0, lightness: ch(a.master).lightness ?? 0, colorize: !!a.colorize, ...(Object.keys(ranges).length ? { ranges } : {}) } };
    }
    case 'selective color': {
      const colors = {};
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) {
        const v = a[k];
        if (v && (v.c || v.m || v.y || v.k)) colors[k] = [v.c || 0, v.m || 0, v.y || 0, v.k || 0];
      }
      const first = Object.keys(colors)[0] || 'reds';
      const f = colors[first] || [0, 0, 0, 0];
      return { type: 'selectiveColor', params: { target: first, cyan: f[0], magenta: f[1], yellow: f[2], black: f[3], absolute: a.mode === 'absolute', colors } };
    }
    case 'channel mixer': {
      const c3 = (v) => v || { red: 0, green: 0, blue: 0, constant: 0 };
      const r = c3(a.red);
      const g = c3(a.green);
      const b = c3(a.blue);
      const k = c3(a.gray);
      if (a.monochrome) return { type: 'channelMixer', params: { mono: true, mr: k.red, mg: k.green, mb: k.blue, mk: k.constant || 0 } };
      return { type: 'channelMixer', params: { rr: r.red ?? 100, rg: r.green ?? 0, rb: r.blue ?? 0, rk: r.constant || 0, gr: g.red ?? 0, gg: g.green ?? 100, gb: g.blue ?? 0, gk: g.constant || 0, br: b.red ?? 0, bg: b.green ?? 0, bb: b.blue ?? 100, bk: b.constant || 0, mono: false } };
    }
    case 'color balance': {
      const m = a.midtones || {};
      const t = (v) => (v && (v.cyanRed || v.magentaGreen || v.yellowBlue) ? { cr: v.cyanRed || 0, mg: v.magentaGreen || 0, yb: v.yellowBlue || 0 } : null);
      return { type: 'colorBalance', params: { cr: m.cyanRed ?? 0, mg: m.magentaGreen ?? 0, yb: m.yellowBlue ?? 0, preserve: a.preserveLuminosity !== false, ...(t(a.shadows) ? { shadows: t(a.shadows) } : {}), ...(t(a.highlights) ? { highlights: t(a.highlights) } : {}) } };
    }
    case 'black & white': return { type: 'bw', params: { reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80 } };
    case 'photo filter': return { type: 'photoFilter', params: { color: colorHex(a.color), density: a.density ?? 25, preserve: a.preserveLuminosity !== false } };
    case 'gradient map': {
      const s = a.colorStops || [];
      if (!s.length) return null;
      const gradient = { stops: s.map((x) => ({ pos: x.location, color: colorHex(x.color) })), alphas: a.opacityStops?.map((x) => ({ pos: x.location, a: x.opacity })) };
      return { type: 'gradientMap', params: { from: colorHex(s[0].color), to: colorHex(s[s.length - 1].color), gradient, reverse: !!a.reverse, dither: !!a.dither } };
    }
    case 'levels': {
      const lv = (c) => {
        if (!c) return null;
        let gamma = c.midtoneInput ?? 1;
        if (gamma > 10) gamma /= 100;
        return [c.shadowInput ?? 0, gamma, c.highlightInput ?? 255, c.shadowOutput ?? 0, c.highlightOutput ?? 255];
      };
      const m = lv(a.rgb) || [0, 1, 255, 0, 255];
      const channels = {};
      for (const [k, c] of [['r', a.red], ['g', a.green], ['b', a.blue]]) {
        const v = lv(c);
        if (v && (v[0] !== 0 || v[1] !== 1 || v[2] !== 255 || v[3] !== 0 || v[4] !== 255)) channels[k] = v;
      }
      if (!a.rgb && !Object.keys(channels).length) return null;
      return { type: 'levels', params: { inBlack: m[0], gamma: m[1], inWhite: m[2], outBlack: m[3], outWhite: m[4], ...(Object.keys(channels).length ? { channels } : {}) } };
    }
    case 'curves': {
      const pts = (v) => (Array.isArray(v) && v.length >= 2 ? v.map((p) => [p.input, p.output]) : null);
      const out = { points: pts(a.rgb) || [[0, 0], [255, 255]] };
      for (const [k, c] of [['r', a.red], ['g', a.green], ['b', a.blue]]) if (pts(c)) out[k] = pts(c);
      return a.rgb?.length || out.r || out.g || out.b ? { type: 'curves', params: out } : null;
    }
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
    case 'hueSat': {
      const o = { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: p.hue, saturation: p.saturation, lightness: p.lightness } };
      for (const [k, r] of Object.entries(p.ranges || {})) if (r) o[k] = { a: r.r?.[0] || 0, b: r.r?.[1] || 0, c: r.r?.[2] || 0, d: r.r?.[3] || 0, hue: r.h || 0, saturation: r.s || 0, lightness: r.l || 0 };
      return o;
    }
    case 'levels': {
      const lv = (v) => ({ shadowInput: v[0], midtoneInput: v[1], highlightInput: v[2], shadowOutput: v[3], highlightOutput: v[4] });
      const o = { type: 'levels', rgb: lv([p.inBlack, p.gamma, p.inWhite, p.outBlack, p.outWhite]) };
      for (const [k, name] of [['r', 'red'], ['g', 'green'], ['b', 'blue']]) if (Array.isArray(p.channels?.[k])) o[name] = lv(p.channels[k]);
      return o;
    }
    case 'curves': {
      const o = { type: 'curves', rgb: p.points.map(([input, output]) => ({ input, output })) };
      for (const [k, name] of [['r', 'red'], ['g', 'green'], ['b', 'blue']]) if (Array.isArray(p[k]) && p[k].length >= 2) o[name] = p[k].map(([input, output]) => ({ input, output }));
      return o;
    }
    case 'selectiveColor': {
      const o = { type: 'selective color', mode: p.absolute ? 'absolute' : 'relative' };
      const colors = p.colors && typeof p.colors === 'object' ? p.colors : { [p.target || 'reds']: [p.cyan, p.magenta, p.yellow, p.black] };
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) {
        const v = colors[k] || [0, 0, 0, 0];
        o[k] = { c: v[0] || 0, m: v[1] || 0, y: v[2] || 0, k: v[3] || 0 };
      }
      return o;
    }
    case 'channelMixer': {
      const row = (r, g, b, k) => ({ red: r || 0, green: g || 0, blue: b || 0, constant: k || 0 });
      return { type: 'channel mixer', monochrome: !!p.mono, red: row(p.rr, p.rg, p.rb, p.rk), green: row(p.gr, p.gg, p.gb, p.gk), blue: row(p.br, p.bg, p.bb, p.bk), gray: row(p.mr, p.mg, p.mb, p.mk) };
    }
    case 'colorBalance': return { type: 'color balance', midtones: { cyanRed: p.cr, magentaGreen: p.mg, yellowBlue: p.yb }, shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, preserveLuminosity: !!p.preserve };
    case 'bw': return { type: 'black & white', reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas, useTint: false };
    case 'photoFilter': return { type: 'photo filter', color: psdColor(p.color), density: p.density, preserveLuminosity: !!p.preserve };
    case 'gradientMap': {
      const g = p.gradient?.stops?.length ? gradientToPsd(p.gradient, p._fg, p._bg) : null;
      return {
        type: 'gradient map', gradientType: 'solid', reverse: !!p.reverse, dither: !!p.dither,
        colorStops: g ? g.colorStops : [{ color: psdColor(p.from), location: 0, midpoint: 0.5 }, { color: psdColor(p.to), location: 1, midpoint: 0.5 }],
        opacityStops: g ? g.opacityStops : [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }],
      };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- PSD text layers

// PostScript names Photoshop stores → families we have (or the closest look)
const FONT_ALIASES = {
  'source han sans k': 'Noto Sans KR', 'source han sans kr': 'Noto Sans KR', 'noto sans cjk kr': 'Noto Sans KR', 'adobe gothic': 'Noto Sans KR', 'malgun gothic': 'Malgun Gothic',
  'source han serif k': 'Noto Serif KR', 'source han serif kr': 'Noto Serif KR', 'adobe myungjo': 'Noto Serif KR', 'nanum gothic': 'Nanum Gothic', 'nanum myeongjo': 'Nanum Myeongjo',
  'nanum barun gothic': 'Nanum Gothic', 'nanum square': 'Nanum Gothic', 'spoqa han sans': 'Noto Sans KR', 'pretendard': 'Noto Sans KR',
};
/** A PostScript font name → { font (family), bold, italic }. */
export function psFont(name) {
  const n = String(name || 'NotoSansKR-Regular');
  const [base0, ...rest] = n.split('-');
  const style = rest.join('-');
  const all = `${base0} ${style}`;
  const bold = /(Bold|Black|Heavy|Semibold|SemiBold|Demi|ExtraBold|Ultra)/.test(all);
  const italic = /(Italic|Oblique)/.test(all);
  let fam = base0.replace(/(PSMT|PS|MT|Std|Pro|LT|OTF)$/, '').replace(/(Bold|Italic|Regular|Light|Medium|Black|Heavy)+$/, '');
  fam = fam.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim() || 'Noto Sans KR';
  return { font: FONT_ALIASES[fam.toLowerCase()] || fam, bold, italic };
}
const ALIGN_IN = { left: 'left', center: 'center', right: 'right', 'justify-left': 'justify', 'justify-center': 'justifyCenter', 'justify-right': 'justifyRight', 'justify-all': 'justifyAll' };

/**
 * A Photoshop text layer → our editable text layer. Until its text is changed it keeps showing the
 * picture Photoshop saved (fonts may differ here), placed exactly where the PSD had it.
 */
function textLayerFromPsd(c, common) {
  const T = c.text;
  const [xx, xy, yx, yy, tx, ty] = T.transform || [1, 0, 0, 1, c.left || 0, c.top || 0];
  const sx = Math.hypot(xx, xy) || 1;
  const sy = Math.hypot(yx, yy) || 1;
  const rotation = Math.round(((Math.atan2(xy, xx) * 180) / Math.PI) * 100) / 100;
  const runs0 = T.styleRuns?.length ? T.styleRuns : [{ length: (T.text || '').length, style: {} }];
  const eff = (r) => ({ ...(T.style || {}), ...(r?.style || {}) });
  const st = eff(runs0[0]);
  const ps = { ...(T.paragraphStyle || {}), ...(T.paragraphStyleRuns?.[0]?.style || {}) };
  const f = psFont(st.font?.name);
  const size = Math.max(1, Math.round((st.fontSize || 12) * sy * 10) / 10);
  const lead = st.autoLeading === false && st.leading ? (st.leading * sy) / size : ps.autoLeading || 1.2;
  const content = String(T.text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const color = colorHex(st.fillColor || { r: 0, g: 0, b: 0 });
  const t = newText({ font: f.font, size, bold: f.bold || !!st.fauxBold, italic: f.italic || !!st.fauxItalic, align: ALIGN_IN[ps.justification] || 'left' }, color, {
    content,
    lineHeight: Math.round(lead * 1000) / 1000,
    letterSpacing: ((st.tracking || 0) / 1000) * size,
    hScale: Math.round((st.horizontalScale ?? 1) * 100),
    vScale: Math.round((st.verticalScale ?? 1) * 100),
    baseline: (st.baselineShift || 0) * sy,
    underline: !!st.underline,
    strike: !!st.strikethrough,
    caps: st.fontCaps === 2 ? 'all' : st.fontCaps === 1 ? 'small' : 'none',
    vertical: T.orientation === 'vertical',
    ...(T.antiAlias ? { aa: { none: 'none', sharp: 'sharp', crisp: 'crisp', strong: 'strong', smooth: 'smooth' }[T.antiAlias] || 'sharp' } : {}),
  });
  if (ps.firstLineIndent || ps.startIndent || ps.endIndent) t.indent = { left: (ps.startIndent || 0) * sx, right: (ps.endIndent || 0) * sx, first: (ps.firstLineIndent || 0) * sx };
  if (ps.spaceBefore) t.spaceBefore = ps.spaceBefore * sy;
  if (ps.spaceAfter) t.spaceAfter = ps.spaceAfter * sy;
  // parts of the text in another font, size or colour
  if (runs0.length > 1) {
    const runs = [];
    let any = false;
    for (const r of runs0) {
      const e = eff(r);
      const o = { n: r.length };
      const rf = psFont(e.font?.name);
      if (rf.font !== f.font) o.font = rf.font;
      if ((rf.bold || !!e.fauxBold) !== t.bold) o.bold = rf.bold || !!e.fauxBold;
      if ((rf.italic || !!e.fauxItalic) !== t.italic) o.italic = rf.italic || !!e.fauxItalic;
      const rs = (e.fontSize || 12) * sy;
      if (Math.abs(rs - size) > 0.05) o.sizeK = Math.round((rs / size) * 1000) / 1000;
      const rc = colorHex(e.fillColor || { r: 0, g: 0, b: 0 });
      if (rc !== color) o.color = rc;
      if ((e.tracking || 0) !== (st.tracking || 0)) o.tracking = e.tracking || 0;
      if (!!e.underline !== t.underline) o.underline = !!e.underline;
      if (!!e.strikethrough !== t.strike) o.strike = !!e.strikethrough;
      if ((e.baselineShift || 0) !== (st.baselineShift || 0)) o.baseline = (e.baselineShift || 0) * sy;
      if (Object.keys(o).length > 1) any = true;
      runs.push(o);
    }
    if (any) t.runs = runs;
  }
  if (T.warp?.style && T.warp.style !== 'none') t.warp = { style: T.warp.style, bend: Math.round(T.warp.value ?? 0), h: Math.round(T.warp.perspective ?? 0), v: Math.round(T.warp.perspectiveOther ?? 0), vertical: T.warp.rotate === 'vertical' };
  // where the box sits: (tx, ty) is the first baseline's start for point text, the box origin for paragraph text
  let bx;
  let by;
  const probe = { kind: 'text', text: t, rotation: 0, x: 0, y: 0 };
  if (T.shapeType === 'box' && Array.isArray(T.boxBounds)) {
    const [l0, t0, r0, b0] = T.boxBounds;
    t.box = { w: Math.max(1, (r0 - l0) * sx), h: Math.max(1, (b0 - t0) * sy) };
    bx = l0 * sx;
    by = t0 * sy;
  } else {
    let W = 1;
    try {
      W = textBox(probe).w;
    } catch { /* measured later */ }
    const lh = size * t.lineHeight;
    const base0 = (lh - size) / 2 + size * 0.88;
    const al = t.align;
    bx = al === 'center' || al === 'justifyCenter' ? -W / 2 : al === 'right' || al === 'justifyRight' ? -W : 0;
    by = -base0;
  }
  let box = { w: 1, h: 1 };
  try {
    box = textBox(probe);
  } catch { /* fonts not ready: approximate */ }
  const a = (rotation * Math.PI) / 180;
  const cxl = bx + box.w / 2;
  const cyl = by + box.h / 2;
  const cx = tx + cxl * Math.cos(a) - cyl * Math.sin(a);
  const cy = ty + cxl * Math.sin(a) + cyl * Math.cos(a);
  const l = newLayer('text', { ...common, name: c.name || content.slice(0, 30) || '텍스트', text: t, rotation, x: Math.round((cx - box.w / 2) * 100) / 100, y: Math.round((cy - box.h / 2) * 100) / 100 });
  if (c.canvas) l.psdPicture = { canvas: c.canvas, dx: (c.left || 0) - l.x, dy: (c.top || 0) - l.y, key: psdTextKey(l) };
  return l;
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
        color: c.layerColor || 'none', fx: fxFromPsd(c.effects), ...blendOptsFromPsd(c),
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
        if (c.vectorMask?.paths?.length) l.vmask = { subpaths: pathsFromPsd(c.vectorMask.paths), enabled: !c.vectorMask.disable, invert: !!c.vectorMask.invert, linked: true };
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
      } else if (c.text) {
        try {
          l = textLayerFromPsd(c, common);
          notes.text++;
        } catch (err) {
          console.warn('PSD text layer', err);
          if (!c.canvas) continue;
          l = newLayer('raster', { ...common, canvas: c.canvas, x: c.left || 0, y: c.top || 0 });
          l.psdText = { text: c.text.text, font: c.text.style?.font?.name, size: c.text.style?.fontSize, color: c.text.style?.fillColor ? colorHex(c.text.style.fillColor) : null };
        }
      } else {
        if (c.placedLayer?.filter?.list?.length) notes.smartFilters++;
        // an empty layer (nothing painted yet) stays an empty layer
        l = newLayer('raster', { ...common, canvas: c.canvas || null, x: c.canvas ? c.left || 0 : 0, y: c.canvas ? c.top || 0 : 0 });
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
  if (notes.text) msg.push(`글자 레이어 ${notes.text}개는 고칠 수 있는 글자로 열었습니다 (고치기 전까지는 포토샵에서 보던 모양 그대로 보입니다)`);
  if (notes.smartFilters) msg.push(`고급 필터가 있는 고급 개체 ${notes.smartFilters}개는 필터가 적용된 이미지로 열었습니다`);
  doc.importNote = msg.join(' · ');
  if (psd.imageResources?.gridAndGuidesInformation?.guides) {
    doc.guides = psd.imageResources.gridAndGuidesInformation.guides.map((g) => ({ axis: g.direction === 'horizontal' ? 'y' : 'x', pos: g.location }));
  }
  if (psd.imageResources?.resolutionInfo) doc.resolution = Math.round(psd.imageResources.resolutionInfo.horizontalResolution || 72);
  if (psd.imageResources?.globalAngle != null) doc.globalAngle = psd.imageResources.globalAngle;
  if (psd.imageResources?.globalAltitude != null) doc.globalAltitude = psd.imageResources.globalAltitude;
  // Photoshop's Background layer (English files) is the 배경 here
  const bottom = doc.layers[0];
  if (bottom && !bottom.parent && bottom.kind === 'raster' && /^background$/i.test(bottom.name)) bottom.name = '배경';
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
      layerColor: l.color && l.color !== 'none' ? l.color : undefined, effects: l.kind === 'adjust' ? undefined : fxToPsd(l.fx, fg, bg), ...blendOptsToPsd(l),
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
    // an empty layer is kept as an empty layer
    if (!c) return l.kind === 'raster' ? base : null;
    if (l.kind === 'fill') flat.fill++;
    if (l.kind === 'smart') flat.smart++;
    if (l.kind === 'shape') flat.shape++;
    const out = { ...base, canvas: c.canvas, left: c.x, top: c.y };
    if (l.kind === 'shape' && editableText && l.shape.fill && !l.rotation && (l.shape.fillType || 'color') === 'color' && (l.shape.strokeType || 'color') === 'color') {
      // a real Photoshop shape layer: vector mask + solid colour fill (+ stroke)
      const s = l.shape;
      const kx = s.w / (s.pw || s.w || 1);
      const ky = s.h / (s.ph || s.h || 1);
      const local = s.type === 'path' ? mapPath(s.subpaths, ([x, y]) => [x * kx, y * ky]) : shapeToSubpaths(s);
      const sps = translatePath(local, l.x, l.y).map((sp) => ({ ...sp, closed: s.type === 'line' ? false : sp.closed }));
      flat.shape--;
      out.vectorMask = { paths: pathsToPsd(sps) };
      out.vectorFill = { type: 'color', color: psdColor(s.fill) };
      if (s.stroke && s.strokeWidth) out.vectorStroke = { strokeEnabled: true, fillEnabled: true, lineWidth: unitPx(s.strokeWidth), lineAlignment: s.strokeAlign || 'center', lineCapType: s.lineCap || 'round', lineJoinType: s.lineJoin || 'round', ...(s.dash?.length ? { lineDashSet: s.dash.map((v) => ({ units: 'None', value: v })) } : {}), content: { type: 'color', color: psdColor(s.stroke) }, opacity: 1, blendMode: 'normal' };
    }
    // type on a path, area type and warped text keep their pixels (written as point text they would move)
    if (l.kind === 'text' && editableText && !l.text.path && !l.text.area && !l.text.warp) {
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
      globalAngle: Math.round(doc.globalAngle ?? 120), globalAltitude: Math.round(doc.globalAltitude ?? 30),
      ...(doc.guides?.length ? { gridAndGuidesInformation: { grid: { horizontal: 18 * 32, vertical: 18 * 32 }, guides: doc.guides.map((g) => ({ location: g.pos, direction: g.axis === 'y' ? 'horizontal' : 'vertical' })) } } : {}),
    },
  };
  const buf = writePsd(psd, { generateThumbnail: true, invalidateTextLayers: editableText, noBackground: true });
  return { blob: new Blob([buf], { type: 'image/vnd.adobe.photoshop' }), skipped, flat };
}

// ---------------------------------------------------------------- documents ↔ plain data (projects, autosave)

const PLAIN_SKIP = new Set(['canvas', 'mask', 'smartSrc', 'smartDoc', 'psdPicture', 'filterMask']);

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
    // a PSD text layer's own picture, while its text is unchanged
    if (l.psdPicture?.canvas && l.kind === 'text') o.psdPicture = { ...l.psdPicture, canvas: await enc(l.psdPicture.canvas) };
    if (l.filterMask?.canvas) o.filterMask = { ...l.filterMask, canvas: await enc(l.filterMask.canvas) };
    layers.push(o);
  }
  const channels = [];
  for (const ch of doc.channels || []) channels.push({ ...ch, canvas: await enc(ch.canvas) });
  return {
    id: doc.id, globalAngle: doc.globalAngle ?? 120, globalAltitude: doc.globalAltitude ?? 30,
    name: doc.name, width: doc.width, height: doc.height, activeId: doc.activeId, selectedIds: doc.selectedIds, sourceMediaId: doc.sourceMediaId,
    guides: doc.guides, paths: doc.paths, workPath: doc.workPath, charStyles: doc.charStyles || [], paraStyles: doc.paraStyles || [], notes: doc.notes, counts: doc.counts, samplers: doc.samplers, comps: doc.comps, frames: doc.frames || [], frameLoop: doc.frameLoop || 0, mode: doc.mode, resolution: doc.resolution, info: doc.info || null, hideFx: !!doc.hideFx,
    channels, layers,
  };
}

export async function deserializeDoc(o, dec, { keepId = false } = {}) {
  const doc = new PhotoDoc({ name: o.name, width: o.width, height: o.height, background: null });
  for (const l of o.layers) {
    doc.layers.push({
      ...newLayer(l.kind), ...l, fx: normalizeFx(l.fx), canvas: await dec(l.canvas), mask: l.mask ? { ...l.mask, canvas: await dec(l.mask.canvas) } : null,
      smartSrc: await dec(l.smartSrc), smartDoc: l.smartDoc ? await deserializeDoc(l.smartDoc, dec) : null, rev: 0,
      psdPicture: l.psdPicture?.canvas ? { ...l.psdPicture, canvas: await dec(l.psdPicture.canvas) } : null,
      filterMask: l.filterMask?.canvas ? { ...l.filterMask, canvas: await dec(l.filterMask.canvas) } : null,
    });
  }
  // autosave keeps the document's id, so a smart object opened for editing still finds its parent
  if (keepId && o.id) doc.id = o.id;
  doc.globalAngle = o.globalAngle ?? 120;
  doc.globalAltitude = o.globalAltitude ?? 30;
  doc.activeId = o.activeId || doc.layers[doc.layers.length - 1]?.id || null;
  doc.selectedIds = o.selectedIds?.length ? o.selectedIds : doc.activeId ? [doc.activeId] : [];
  for (const k of ['guides', 'paths', 'notes', 'counts', 'samplers', 'comps', 'frames', 'charStyles', 'paraStyles']) doc[k] = o[k] || [];
  doc.frameLoop = o.frameLoop || 0;
  doc.workPath = o.workPath || null;
  doc.mode = o.mode || 'rgb';
  doc.resolution = o.resolution || 72;
  doc.info = o.info || null;
  doc.hideFx = !!o.hideFx;
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
  const ids = new Set();
  for (const d of s.docs) {
    const doc = await deserializeDoc(d, blobCanvas, { keepId: !ids.has(d.id) });
    ids.add(doc.id);
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

// Photo files: open images / PSD / Montage photo projects, save PSD and projects, export PNG/JPG/WebP,
// autosave open documents to IndexedDB, and hand images over to the video editor.

import { readPsd, writePsd } from '../../vendor/ag-psd/ag-psd.min.mjs';
import { PhotoDoc, newLayer, makeCanvas, BLEND_MODES } from './doc.js';
import { defaultParams } from './adjust.js';

const BLENDS = new Set(BLEND_MODES.map((b) => b[0]));
const baseName = (n) => String(n || '이미지').replace(/\.[^.]+$/, '');

export const OPEN_ACCEPT = 'image/*,.psd,.mphoto,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif';

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
  if (lower.endsWith('.psd')) return docFromPsd(await file.arrayBuffer(), baseName(file.name));
  if (lower.endsWith('.mphoto') || file.type === 'application/json') return docFromProject(JSON.parse(await file.text()));
  const doc = docFromCanvas(await canvasFromFile(file), baseName(file.name));
  doc.fileName = file.name;
  return doc;
}

// ---------------------------------------------------------------- PSD

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
  return { canvas: c, x: 0, y: 0, enabled: !m.disabled, linked: true };
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
    default: return null;
  }
}

export function docFromPsd(buffer, name) {
  const psd = readPsd(buffer);
  const doc = new PhotoDoc({ name, width: psd.width, height: psd.height, background: null });
  let skipped = 0;
  const walk = (children, parentHidden, parentOpacity) => {
    for (const c of children || []) {
      const hidden = parentHidden || !!c.hidden;
      const opacity = (c.opacity ?? 1) * parentOpacity;
      if (c.children) {
        walk(c.children, hidden, opacity);
        continue;
      }
      const blend = BLENDS.has(c.blendMode) ? c.blendMode : 'normal';
      const common = { name: c.name || '레이어', visible: !hidden, opacity, blend };
      if (c.adjustment) {
        const adj = adjustFromPsd(c.adjustment);
        if (!adj) {
          skipped++;
          continue;
        }
        const l = newLayer('adjust', { ...common, adjust: { type: adj.type, params: { ...defaultParams(adj.type), ...adj.params } } });
        l.mask = maskFromPsd(doc, c.mask);
        doc.layers.push(l);
        continue;
      }
      if (!c.canvas) continue;
      const l = newLayer('raster', { ...common, canvas: c.canvas, x: c.left || 0, y: c.top || 0 });
      if (c.text) l.name = `${l.name} (텍스트→이미지)`;
      l.mask = maskFromPsd(doc, c.mask);
      doc.layers.push(l);
    }
  };
  walk(psd.children, false, 1);
  if (!doc.layers.length && psd.canvas) doc.layers.push(newLayer('raster', { name: '배경', canvas: psd.canvas }));
  doc.activeId = doc.layers[doc.layers.length - 1]?.id || null;
  doc.importNote = skipped ? `지원하지 않는 조정 레이어 ${skipped}개는 빠졌습니다` : '';
  return doc;
}

export function docToPsd(doc) {
  const children = [];
  let skipped = 0;
  for (const l of doc.layers) {
    const base = { name: l.name, opacity: l.opacity, hidden: !l.visible, blendMode: l.blend };
    if (l.kind === 'adjust') {
      const a = adjustToPsd(l);
      if (!a) {
        skipped++;
        continue;
      }
      children.push({ ...base, adjustment: a, mask: maskToPsd(doc, l.mask) });
      continue;
    }
    const c = doc.content(l);
    if (!c) continue;
    // styles and text/shapes are written as pixels
    const hasFx = l.fx && (l.fx.shadow || l.fx.stroke || l.fx.glow);
    const s = hasFx ? doc.styled({ ...l, mask: null, _styled: null }, c) : c;
    children.push({ ...base, canvas: s.canvas, left: s.x, top: s.y, mask: maskToPsd(doc, l.mask) });
  }
  const psd = { width: doc.width, height: doc.height, canvas: doc.flatten(), children };
  const buf = writePsd(psd, { generateThumbnail: true });
  return { blob: new Blob([buf], { type: 'image/vnd.adobe.photoshop' }), skipped };
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
  return { canvas: c, left: 0, top: 0, defaultColor: 0, disabled: !m.enabled };
}

// ---------------------------------------------------------------- Montage photo project (.mphoto)

export function docToProject(doc) {
  const enc = (c) => (c ? c.toDataURL('image/png') : null);
  return {
    format: 'montage-photo', version: 1, name: doc.name, width: doc.width, height: doc.height, activeId: doc.activeId,
    layers: doc.layers.map((l) => ({
      ...l, canvas: enc(l.canvas), mask: l.mask && { ...l.mask, canvas: enc(l.mask.canvas) }, _cache: undefined, _styled: undefined, _text: undefined, _shape: undefined,
    })),
  };
}

async function dataUrlCanvas(url) {
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return canvasFromImage(img);
}

export async function docFromProject(p) {
  if (p?.format !== 'montage-photo') throw new Error('Montage 사진 파일이 아닙니다');
  const doc = new PhotoDoc({ name: p.name, width: p.width, height: p.height, background: null });
  for (const l of p.layers) {
    const canvas = await dataUrlCanvas(l.canvas);
    const mask = l.mask ? { ...l.mask, canvas: await dataUrlCanvas(l.mask.canvas) } : null;
    doc.layers.push({ ...newLayer(l.kind), ...l, canvas, mask, rev: 0 });
  }
  doc.activeId = p.activeId || doc.layers[doc.layers.length - 1]?.id;
  return doc;
}

// ---------------------------------------------------------------- export

export const EXPORT_TYPES = [['png', 'PNG (투명 유지)', 'image/png'], ['jpg', 'JPG (사진, 작은 파일)', 'image/jpeg'], ['webp', 'WebP (웹용)', 'image/webp']];

export function exportBlob(doc, type = 'png', quality = 0.92, scale = 1) {
  const flat = doc.flatten();
  let c = flat;
  if (scale !== 1 || type === 'jpg') {
    c = makeCanvas(doc.width * scale, doc.height * scale);
    const g = c.getContext('2d');
    if (type === 'jpg') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
    }
    g.imageSmoothingQuality = 'high';
    g.drawImage(flat, 0, 0, c.width, c.height);
  }
  const mime = EXPORT_TYPES.find((t) => t[0] === type)?.[2] || 'image/png';
  return new Promise((resolve) => c.toBlob(resolve, mime, quality));
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

export async function saveSession(docs, activeIndex) {
  const out = [];
  for (const doc of docs) {
    const layers = [];
    for (const l of doc.layers) {
      layers.push({
        ...l, canvas: await canvasBlob(l.canvas), mask: l.mask && { ...l.mask, canvas: await canvasBlob(l.mask.canvas) }, _cache: undefined, _styled: undefined, _text: undefined, _shape: undefined,
      });
    }
    out.push({ name: doc.name, width: doc.width, height: doc.height, activeId: doc.activeId, sourceMediaId: doc.sourceMediaId, layers });
  }
  await kv('readwrite', (s) => s.put({ docs: out, activeIndex, savedAt: Date.now() }, 'session'));
}

async function blobCanvas(b) {
  if (!b) return null;
  const bmp = await createImageBitmap(b);
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  blobOf.set(c, b);
  return c;
}

export async function loadSession() {
  const s = await kv('readonly', (st) => st.get('session')).catch(() => null);
  if (!s?.docs?.length) return null;
  const docs = [];
  for (const d of s.docs) {
    const doc = new PhotoDoc({ name: d.name, width: d.width, height: d.height, background: null });
    for (const l of d.layers) doc.layers.push({ ...newLayer(l.kind), ...l, canvas: await blobCanvas(l.canvas), mask: l.mask ? { ...l.mask, canvas: await blobCanvas(l.mask.canvas) } : null, rev: 0 });
    doc.activeId = d.activeId;
    doc.sourceMediaId = d.sourceMediaId || null;
    doc.saved = true;
    docs.push(doc);
  }
  return { docs, activeIndex: Math.min(s.activeIndex || 0, docs.length - 1) };
}

export async function clearSession() {
  await kv('readwrite', (s) => s.delete('session')).catch(() => {});
}

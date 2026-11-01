// Shared photo resources: gradients (presets, user gradients, rendering with midpoints, smoothness
// and noise gradients), patterns (built-in, defined, imported) and a small store in this browser
// (IndexedDB) for brush tips and presets.

// preferences, read and written like ui/common.js's loadPref / savePref (no UI import here)
const loadPref = (key, fallback) => {
  try {
    const v = localStorage.getItem(`montage.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const savePref = (key, value) => {
  try {
    localStorage.setItem(`montage.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable or full
  }
};

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

// ---------------------------------------------------------------- colours

export function hexRgb(hex) {
  const s = String(hex || '#000000').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// ---------------------------------------------------------------- gradients

/** A gradient: colour stops (colour may be 'fg' / 'bg') and opacity stops, positions 0..1. */
export const GRADIENTS = [
  { id: 'fgbg', name: '전경색 → 배경색', stops: [{ pos: 0, color: 'fg' }, { pos: 1, color: 'bg' }] },
  { id: 'fgclear', name: '전경색 → 투명', stops: [{ pos: 0, color: 'fg' }, { pos: 1, color: 'fg' }], alphas: [{ pos: 0, a: 1 }, { pos: 1, a: 0 }] },
  { id: 'bw', name: '검정 → 흰색', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] },
  { id: 'spectrum', name: '스펙트럼', stops: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].map((color, i) => ({ pos: i / 6, color })) },
  { id: 'sunset', name: '노을', stops: [{ pos: 0, color: '#2b1055' }, { pos: 0.5, color: '#d53369' }, { pos: 1, color: '#ffcc70' }] },
  { id: 'ocean', name: '바다', stops: [{ pos: 0, color: '#003973' }, { pos: 1, color: '#7de2fc' }] },
  { id: 'copper', name: '구리', stops: [{ pos: 0, color: '#97461d' }, { pos: 0.35, color: '#fbd8c2' }, { pos: 0.65, color: '#a95a2e' }, { pos: 1, color: '#f3c19f' }] },
  { id: 'chrome', name: '크롬', stops: [{ pos: 0, color: '#294f6d' }, { pos: 0.45, color: '#f2f2f2' }, { pos: 0.5, color: '#3d2a1b' }, { pos: 0.75, color: '#c7a37d' }, { pos: 1, color: '#ffffff' }] },
  { id: 'violetorange', name: '보라 → 주황', stops: [{ pos: 0, color: '#290a59' }, { pos: 1, color: '#ff7c00' }] },
  { id: 'gold', name: '금', stops: [{ pos: 0, color: '#8a6e2f' }, { pos: 0.5, color: '#f5e6a8' }, { pos: 1, color: '#a17c2b' }] },
  { id: 'pastel', name: '파스텔', stops: [{ pos: 0, color: '#fbc2eb' }, { pos: 1, color: '#a6c1ee' }] },
  { id: 'transparentStripes', name: '투명 줄무늬', stops: [{ pos: 0, color: 'fg' }, { pos: 1, color: 'fg' }], alphas: [0, 0.2, 0.2, 0.4, 0.4, 0.6, 0.6, 0.8, 0.8, 1].map((pos, i) => ({ pos, a: i % 4 < 2 ? 1 : 0 })) },
];

export function resolveStopColor(c, fg = '#000000', bg = '#ffffff') {
  return c === 'fg' ? fg : c === 'bg' ? bg : c || '#000000';
}

const seeded = (seed) => {
  let v = seed >>> 0 || 1;
  return () => {
    v = (v * 1664525 + 1013904223) >>> 0;
    return v / 4294967296;
  };
};

/**
 * Where a position u (0..1 between two stops) lands after the midpoint (0..1, 0.5 = halfway) and
 * smoothness (0..1) are applied.
 */
function segmentT(u, mid, smooth) {
  const m = Math.min(0.99, Math.max(0.01, mid ?? 0.5));
  let v = u < m ? (0.5 * u) / m : 0.5 + (0.5 * (u - m)) / (1 - m);
  if (smooth > 0) v += (v * v * (3 - 2 * v) - v) * smooth;
  return v;
}

/** Values of a list of stops at t: stops sorted by pos; `mid` on a stop is the midpoint before it (%). */
function stopsAt(arr, t, get, smooth) {
  if (t <= arr[0].pos) return get(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    if (t <= arr[i].pos) {
      const a = arr[i - 1];
      const b = arr[i];
      const u = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
      const k = segmentT(u, (b.mid ?? 50) / 100, smooth);
      const va = get(a);
      const vb = get(b);
      return Array.isArray(va) ? va.map((v, j) => v + (vb[j] - v) * k) : va + (vb - va) * k;
    }
  }
  return get(arr[arr.length - 1]);
}

function hsbToRgb(hh, s, v) {
  hh = (((hh % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6].map((x) => x * 255);
}

function labToRgb(L, A, B) {
  let y = (L + 16) / 116;
  let x = A / 500 + y;
  let z = y - B / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = f(y);
  z = 1.08883 * f(z);
  const g = (c) => 255 * (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  return [g(x * 3.2406 + y * -1.5372 + z * -0.4986), g(x * -0.9689 + y * 1.8758 + z * 0.0415), g(x * 0.0557 + y * -0.204 + z * 1.057)];
}

/**
 * Photoshop's noise gradient: random colours between each channel's minimum and maximum (0..100),
 * roughness 0..100, in RGB, HSB or Lab, optionally with random transparency.
 */
function noiseLut(n) {
  const rnd = seeded(n.seed ?? 1);
  const rough = Math.max(0, Math.min(100, n.roughness ?? 50)) / 100;
  const model = n.model || 'rgb';
  const min = n.min || [0, 0, 0, 0];
  const max = n.max || [100, 100, 100, 100];
  const count = Math.round(3 + rough * rough * 60);
  const pts = [];
  for (let k = 0; k <= count; k++) {
    const ch = [0, 1, 2, 3].map((c) => (min[c] + (max[c] - min[c]) * rnd()) / 100);
    // restrict colours: keep away from fully saturated extremes
    if (n.restrict && model !== 'hsb') for (let c = 0; c < 3; c++) ch[c] = 0.1 + ch[c] * 0.8;
    if (n.restrict && model === 'hsb') ch[1] *= 0.85;
    pts.push(ch);
  }
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * count;
    const k = Math.min(count - 1, Math.floor(t));
    let u = t - k;
    // low roughness: smooth blends; high roughness: sharper steps
    u = u * u * (3 - 2 * u) * (1 - rough * 0.5) + u * rough * 0.5;
    const ch = pts[k].map((v, c) => v + (pts[k + 1][c] - v) * u);
    let rgb;
    if (model === 'hsb') rgb = hsbToRgb(ch[0], ch[1], ch[2]);
    else if (model === 'lab') rgb = labToRgb(ch[0] * 100, ch[1] * 255 - 128, ch[2] * 255 - 128);
    else rgb = [ch[0] * 255, ch[1] * 255, ch[2] * 255];
    lut[i * 4] = rgb[0];
    lut[i * 4 + 1] = rgb[1];
    lut[i * 4 + 2] = rgb[2];
    lut[i * 4 + 3] = n.transparency ? 255 * (0.15 + 0.85 * ch[3]) : 255;
  }
  return lut;
}

/** 256-entry RGBA lookup for a gradient (colour and opacity stops with midpoints, or noise). */
export function gradientLut(gr, { fg = '#000000', bg = '#ffffff', reverse = false } = {}) {
  let lut;
  if (gr?.type === 'noise') lut = noiseLut(gr.noise || {});
  else {
    const stops = [...(gr?.stops?.length ? gr.stops : GRADIENTS[0].stops)].sort((a, b) => a.pos - b.pos);
    const alphas = [...(gr?.alphas?.length ? gr.alphas : [{ pos: 0, a: 1 }, { pos: 1, a: 1 }])].sort((a, b) => a.pos - b.pos);
    const cols = stops.map((s) => ({ pos: s.pos, mid: s.mid, rgb: hexRgb(resolveStopColor(s.color, fg, bg)) }));
    // Photoshop's smoothness eases each stretch between two stops a little (100% = gently S-shaped)
    const smooth = gr?.smooth == null ? 0 : (Math.max(0, Math.min(100, gr.smooth)) / 100) * 0.5;
    lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = stopsAt(cols, t, (s) => s.rgb, smooth);
      lut[i * 4] = r;
      lut[i * 4 + 1] = g;
      lut[i * 4 + 2] = b;
      lut[i * 4 + 3] = stopsAt(alphas, t, (s) => s.a, smooth) * 255;
    }
  }
  if (reverse) {
    const out = new Uint8ClampedArray(lut.length);
    for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] = lut[(255 - i) * 4 + c];
    return out;
  }
  return lut;
}

export const GRADIENT_STYLES = [['linear', '선형'], ['radial', '방사형'], ['angle', '각도'], ['reflected', '반사'], ['diamond', '다이아몬드']];

/**
 * Paint a gradient into a w×h canvas from point a to point b (canvas coords), any style.
 * Returns the canvas.
 */
export function paintGradient(w, h, gr, a, b, { style = 'linear', fg, bg, reverse = false, dither = true } = {}) {
  const c = mk(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height);
  const d = img.data;
  const lut = gradientLut(gr, { fg, bg, reverse });
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = Math.max(1e-6, dx * dx + dy * dy);
  const len = Math.sqrt(len2);
  const ang0 = Math.atan2(dy, dx);
  const ux = dx / len;
  const uy = dy / len;
  let seed = 12345;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const px = x + 0.5 - a.x;
      const py = y + 0.5 - a.y;
      let t;
      if (style === 'radial') t = Math.sqrt(px * px + py * py) / len;
      else if (style === 'angle') {
        let an = Math.atan2(py, px) - ang0;
        an = ((an % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        t = an / (2 * Math.PI);
      } else if (style === 'reflected') t = Math.abs((px * dx + py * dy) / len2);
      else if (style === 'diamond') t = (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
      else t = (px * dx + py * dy) / len2;
      if (dither) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        t += ((seed / 0x7fffffff) - 0.5) / 255;
      }
      const k = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
      const i = (y * c.width + x) * 4;
      d[i] = lut[k];
      d[i + 1] = lut[k + 1];
      d[i + 2] = lut[k + 2];
      d[i + 3] = lut[k + 3];
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** A gradient laid across a box at an angle (layer styles, gradient fill layers). */
export function boxGradient(w, h, gr, { angle = 90, scale = 100, style = 'linear', reverse = false, fg, bg, ox = 0, oy = 0 } = {}) {
  const a = (angle * Math.PI) / 180;
  const cx = w / 2 + ox;
  const cy = h / 2 + oy;
  const k = scale / 100;
  // half the box extent along the angle, like Photoshop's "align with layer"
  const half = ((Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2) * k;
  if (style === 'linear' || style === 'reflected' || style === 'diamond' || style === 'angle') {
    const from = style === 'linear' ? { x: cx - Math.cos(a) * half, y: cy + Math.sin(a) * half } : { x: cx, y: cy };
    const to = { x: cx + Math.cos(a) * half, y: cy - Math.sin(a) * half };
    return paintGradient(w, h, gr, from, to, { style, reverse, fg, bg });
  }
  const r = (Math.hypot(w, h) / 2) * k;
  return paintGradient(w, h, gr, { x: cx, y: cy }, { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }, { style, reverse, fg, bg });
}

/** A small preview strip for menus. */
export function gradientSwatch(gr, w = 120, h = 16, fg, bg) {
  const c = paintGradient(w, h, gr, { x: 0, y: 0 }, { x: w, y: 0 }, { fg, bg, dither: false });
  // checkerboard under transparency
  const out = mk(w, h);
  const g = out.getContext('2d');
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    g.fillStyle = ((x + y) / 4) % 2 ? '#ccc' : '#fff';
    g.fillRect(x, y, 4, 4);
  }
  g.drawImage(c, 0, 0);
  return out;
}

// ---------------------------------------------------------------- patterns

const builtin = {
  checker: ['체크무늬', (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = '#bbb'; g.fillRect(0, 0, s / 2, s / 2); g.fillRect(s / 2, s / 2, s / 2, s / 2); }, 32],
  stripes: ['사선 줄무늬', (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.strokeStyle = '#444'; g.lineWidth = s / 6; for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(i * s, s); g.lineTo(i * s + s, 0); g.stroke(); } }, 24],
  dots: ['물방울', (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = '#333'; g.beginPath(); g.arc(s / 2, s / 2, s / 5, 0, Math.PI * 2); g.fill(); }, 24],
  grid: ['격자', (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.strokeStyle = '#888'; g.strokeRect(0.5, 0.5, s, s); }, 20],
  bricks: ['벽돌', (g, s) => { g.fillStyle = '#b5512e'; g.fillRect(0, 0, s, s); g.strokeStyle = '#e8d8c8'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 1); g.lineTo(s, 1); g.moveTo(0, s / 2 + 1); g.lineTo(s, s / 2 + 1); g.moveTo(s / 2, 0); g.lineTo(s / 2, s / 2); g.moveTo(1, s / 2); g.lineTo(1, s); g.stroke(); }, 48],
  noise: ['잡티', (g, s) => { const img = g.createImageData(s, s); for (let i = 0; i < img.data.length; i += 4) { const v = 96 + Math.random() * 128; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); }, 64],
  paper: ['종이', (g, s) => { const img = g.createImageData(s, s); let seed = 7; for (let i = 0; i < img.data.length; i += 4) { seed = (seed * 16807) % 2147483647; const v = 225 + (seed % 30); img.data[i] = v; img.data[i + 1] = v - 4; img.data[i + 2] = v - 12; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); }, 64],
  hearts: ['하트', (g, s) => { g.fillStyle = '#ffe3ec'; g.fillRect(0, 0, s, s); g.fillStyle = '#e8456b'; g.font = `${s * 0.6}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('♥', s / 2, s / 2 + 1); }, 32],
  waves: ['물결', (g, s) => { g.fillStyle = '#e6f3ff'; g.fillRect(0, 0, s, s); g.strokeStyle = '#3a7bd5'; g.lineWidth = 2; g.beginPath(); for (let x = 0; x <= s; x++) g.lineTo(x, s / 2 + Math.sin((x / s) * Math.PI * 2) * s / 6); g.stroke(); }, 32],
};
const builtinCache = new Map();
/** User-defined patterns (Edit ▸ Define Pattern) live here and are saved with documents. */
export const userPatterns = new Map();

export function listPatterns() {
  return [...Object.entries(builtin).map(([id, [name]]) => ({ id, name })), ...[...userPatterns.entries()].map(([id, p]) => ({ id, name: p.name }))];
}

export function patternCanvas(id) {
  if (userPatterns.has(id)) return userPatterns.get(id).canvas;
  const b = builtin[id] || builtin.checker;
  if (!builtinCache.has(id)) {
    const c = mk(b[2], b[2]);
    b[1](c.getContext('2d'), b[2]);
    builtinCache.set(id, c);
  }
  return builtinCache.get(id);
}

export function definePattern(canvas, name) {
  const id = `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  userPatterns.set(id, { name, canvas });
  return id;
}

/** Tile a pattern over w×h at a scale (percent), starting at (ox, oy), turned by `angle` degrees. */
export function paintPattern(w, h, id, scale = 100, ox = 0, oy = 0, angle = 0) {
  const c = mk(w, h);
  const g = c.getContext('2d');
  const p = patternCanvas(id);
  const k = Math.max(0.01, scale / 100);
  const tile = mk(p.width * k, p.height * k);
  tile.getContext('2d').drawImage(p, 0, 0, tile.width, tile.height);
  const pat = g.createPattern(tile, 'repeat');
  g.translate(ox, oy);
  g.fillStyle = pat;
  if (angle) {
    g.rotate((-angle * Math.PI) / 180);
    // cover the whole canvas, wherever the turned origin is
    const r = Math.hypot(w, h) + Math.hypot(ox, oy);
    g.fillRect(-r, -r, r * 2, r * 2);
  } else g.fillRect(-ox, -oy, w, h);
  return c;
}

// ---------------------------------------------------------------- saved resources (IndexedDB)

const RES_DB = 'montage-photo-res';
let resDbp = null;
function resDb() {
  resDbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(RES_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return resDbp;
}
async function resTx(mode, fn) {
  const d = await resDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
/** Brushes, patterns and gradients kept in this browser (survive reloads, not tied to a document). */
export const resGet = (key) => resTx('readonly', (s) => s.get(key)).catch(() => undefined);
export const resPut = (key, value) => resTx('readwrite', (s) => s.put(value, key));
export const resDel = (key) => resTx('readwrite', (s) => s.delete(key)).catch(() => {});

/** 'patterns' events when the pattern list changes (brush textures imported with .abr files). */
export const resourceEvents = new EventTarget();
export const resourcesChanged = (kind) => resourceEvents.dispatchEvent(new Event(kind));

export async function blobCanvas(b) {
  const bmp = await createImageBitmap(b);
  const c = mk(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

/**
 * Keep imported patterns (brush textures from .abr files) with the Patterns panel's imported ones:
 * in this browser's preferences, at most 512 px, the newest 60. Returns the new pattern ids.
 */
export function keepImportedPatterns(list) {
  const saved = loadPref('photo.patterns.imported', []);
  const ids = [];
  for (const { canvas, name } of list) {
    let c = canvas;
    const k = Math.min(1, 512 / Math.max(c.width, c.height));
    if (k < 1) {
      const t = mk(c.width * k, c.height * k);
      const tg = t.getContext('2d');
      tg.imageSmoothingQuality = 'high';
      tg.drawImage(c, 0, 0, t.width, t.height);
      c = t;
    }
    const id = definePattern(c, String(name || '패턴').slice(0, 40));
    saved.push({ id, name: userPatterns.get(id).name, data: c.toDataURL('image/png') });
    ids.push(id);
  }
  savePref('photo.patterns.imported', saved.slice(-60));
  resourcesChanged('patterns');
  return ids;
}

// ---------------------------------------------------------------- user gradients

/** The user's gradients (the Gradients panel's 내 그레이디언트), kept in this browser's preferences. */
export const userGradients = () => loadPref('photo.gradients', []);
/** Built-in presets and the user's gradients. */
export const allGradients = () => [...GRADIENTS, ...userGradients()];

/** Add gradients (real colours, not fg/bg, so they look the same later); returns them with ids. */
export function addUserGradients(list, fg = '#000000', bg = '#ffffff') {
  const added = list.map((g, i) => ({
    ...structuredClone(g),
    stops: (g.stops || []).map((s) => ({ ...s, color: resolveStopColor(s.color, fg, bg) })),
    id: `ug${Date.now().toString(36)}${i.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  }));
  savePref('photo.gradients', [...userGradients(), ...added]);
  return added;
}

// Brush engine: brush tips (drawn shapes, tips defined from the picture and sampled tips imported
// from Photoshop .abr files) and Photoshop's brush settings: tip shape (size, angle, roundness, flip,
// spacing), shape dynamics, scattering, texture, dual brush, colour dynamics, transfer, noise, wet
// edges and build-up (airbrush). Stroke (tools.js) calls the dab painter made here for every pixel
// of the pointer path; the painter decides where dabs go, so spacing follows the current size.

import { clamp } from '../util.js';
import { makeCanvas } from './doc.js';
import { patternCanvas } from './resources.js';

// ---------------------------------------------------------------- colour helpers

export const hexRgb = (hex) => {
  const s = String(hex || '#000000').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh / 6, mx ? d / mx : 0, mx];
}

export function hsvToRgb(hh, s, v) {
  hh = (((hh % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

/** A small seeded random generator (same tip, same speckles). */
export function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const falloff = (d, r, hd) => (d >= r ? 0 : d <= r * hd ? 1 : 1 - (d - r * hd) / Math.max(1e-6, r * (1 - hd)));

// ---------------------------------------------------------------- tips

/** Drawn tips; tips defined from the picture and imported sampled tips are added to TIP_LIST. */
export const TIP_LIST = [['round', '둥근'], ['square', '사각'], ['chalk', '분필'], ['spray', '스프레이'], ['bristle', '붓털'], ['star', '별'], ['leaf', '나뭇잎'], ['grass', '풀'], ['dots', '점 무리']];
// 'block': the block eraser's full square (not offered as a tip)
const DRAWN = new Set([...TIP_LIST.map((t) => t[0]), 'block']);
/** Sampled tips: id → { name, canvas (white, alpha = paint), w, h, mips }. */
const SAMPLED = new Map();
const tipCache = new Map();
let cachedPixels = 0;
const forget = (k) => {
  const e = tipCache.get(k);
  if (!e) return;
  cachedPixels -= e.w * e.h;
  tipCache.delete(k);
};
const dropCached = (id) => {
  for (const k of [...tipCache.keys()]) if (k.startsWith(`${id}|`)) forget(k);
};

export const isDrawnTip = (id) => DRAWN.has(id || 'round');
export const hasTip = (id) => DRAWN.has(id) || SAMPLED.has(id);
export const tipName = (id) => TIP_LIST.find((t) => t[0] === id)?.[1] || SAMPLED.get(id)?.name || id;
/** Natural size of a sampled tip ([w, h] in pixels), or null for drawn tips. */
export const tipSize = (id) => {
  const t = SAMPLED.get(id);
  return t ? [t.w, t.h] : null;
};

/** Add (or replace) a sampled tip. `canvas` is white with alpha = paint amount. */
export function addSampledTip(id, name, canvas, { listed = true } = {}) {
  SAMPLED.set(id, { name, canvas, w: canvas.width, h: canvas.height, mips: [canvas] });
  dropCached(id);
  const i = TIP_LIST.findIndex((t) => t[0] === id);
  if (i >= 0) TIP_LIST[i] = [id, name];
  else if (listed) TIP_LIST.push([id, name]);
}

export function renameTip(id, name) {
  const t = SAMPLED.get(id);
  if (t) t.name = name;
  const i = TIP_LIST.findIndex((x) => x[0] === id);
  if (i >= 0) TIP_LIST[i] = [id, name];
}

export function removeTip(id) {
  if (DRAWN.has(id)) return;
  SAMPLED.delete(id);
  dropCached(id);
  const i = TIP_LIST.findIndex((t) => t[0] === id);
  if (i >= 0) TIP_LIST.splice(i, 1);
}

/** Turn a grey picture (dark = paint, like Photoshop's Define Brush) into a tip canvas. */
export function tipFromGray(gray, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = gray[i];
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Rendered sizes step by about 12%, so a size that changes every dab reuses a handful of images. */
const quant = (s) => (s <= 12 ? Math.max(1, Math.ceil(s)) : Math.ceil(2 ** (Math.ceil(Math.log2(s) * 6) / 6)));

/** A drawn tip at s×s pixels: white, alpha = paint amount. */
function drawTip(tip, s, hard) {
  const c = makeCanvas(s, s);
  const g = c.getContext('2d');
  const R = s / 2;
  const rnd = seeded(s * 31 + tip.length);
  const soft = Math.max(0, (1 - hard) * s * 0.12);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  if (soft > 0.3 && !['round', 'chalk', 'spray'].includes(tip)) g.filter = `blur(${soft}px)`;
  const pad = soft * 2;
  switch (tip) {
    case 'square':
      g.fillRect(pad + s * 0.08, pad + s * 0.08, s - 2 * pad - s * 0.16, s - 2 * pad - s * 0.16);
      break;
    case 'block':
      g.filter = 'none';
      g.fillRect(0, 0, s, s);
      break;
    case 'chalk': {
      const img = g.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const f = falloff(Math.hypot(x + 0.5 - R, y + 0.5 - R), R, Math.max(0.3, hard));
          if (!f || rnd() > 0.62) continue;
          const o = (y * s + x) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
          img.data[o + 3] = 255 * f * (0.35 + 0.65 * rnd());
        }
      }
      g.putImageData(img, 0, 0);
      break;
    }
    case 'spray': {
      const n = clamp(Math.round(s * 1.6), 16, 500);
      const dot = Math.max(0.6, s / 45);
      for (let i = 0; i < n; i++) {
        // gaussian spread around the centre
        const a = rnd() * Math.PI * 2;
        const rr = Math.min(R - dot, Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)) * R * 0.38);
        g.globalAlpha = 0.4 + 0.6 * rnd();
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, dot, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'bristle': {
      const n = clamp(Math.round(s / 2), 8, 60);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * R * 0.8;
        g.globalAlpha = 0.25 + 0.6 * rnd();
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, Math.max(0.6, (s / 14) * (0.5 + rnd())), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = (i % 2 ? 0.4 : 1) * (R - pad);
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        g.lineTo(R + Math.cos(a) * rr, R + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      break;
    }
    case 'leaf': {
      const t = pad + s * 0.04;
      g.beginPath();
      g.moveTo(R, t);
      g.quadraticCurveTo(s - t, R * 0.9, R, s - t);
      g.quadraticCurveTo(t, R * 0.9, R, t);
      g.fill();
      break;
    }
    case 'grass': {
      g.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const x = s * (0.2 + 0.6 * rnd());
        const top = s * (0.05 + 0.45 * rnd());
        g.lineWidth = Math.max(0.8, s / 22);
        g.beginPath();
        g.moveTo(x, s - pad);
        g.quadraticCurveTo(x + (rnd() - 0.5) * s * 0.2, (s + top) / 2, x + (rnd() - 0.5) * s * 0.45, top + pad);
        g.stroke();
      }
      break;
    }
    case 'dots': {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rnd();
        const rr = i ? R * 0.55 : 0;
        g.beginPath();
        g.arc(R + Math.cos(a) * rr, R + Math.sin(a) * rr, Math.max(0.7, s * (0.08 + 0.06 * rnd()) - pad / 3), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    default: {
      // round: solid core, then a smooth (cosine) falloff like Photoshop's soft round
      const grad = g.createRadialGradient(R, R, 0, R, R, R);
      const hd = Math.min(0.98, Math.max(0, hard));
      grad.addColorStop(0, '#fff');
      grad.addColorStop(hd, '#fff');
      if (hd < 0.97) {
        for (let k = 1; k < 6; k++) {
          const t = k / 6;
          grad.addColorStop(hd + (1 - hd) * t, `rgba(255,255,255,${(0.5 + 0.5 * Math.cos(Math.PI * t)).toFixed(3)})`);
        }
      }
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  }
  return c;
}

/** A sampled tip scaled so its longer side is q pixels (halving first keeps big reductions smooth). */
function scaleSampled(t, q) {
  const k = q / Math.max(t.w, t.h);
  const w = Math.max(1, Math.round(t.w * k));
  const hh = Math.max(1, Math.round(t.h * k));
  let src = t.mips[0];
  for (let i = 1; ; i++) {
    if (!t.mips[i]) {
      const p = t.mips[i - 1];
      if (p.width / 2 < w * 1.5 || p.height / 2 < 1) break;
      const c = makeCanvas(Math.ceil(p.width / 2), Math.ceil(p.height / 2));
      c.getContext('2d').drawImage(p, 0, 0, c.width, c.height);
      t.mips[i] = c;
    }
    if (t.mips[i].width < w) break;
    src = t.mips[i];
  }
  const c = makeCanvas(w, hh);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, hh);
  return c;
}

/** Speckle the soft parts of a tip (Photoshop's Noise). */
function addNoise(c) {
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const rnd = seeded(c.width * 7919 + c.height);
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a > 0 && a < 255) d[i] = clamp(a + (rnd() - 0.5) * 2.6 * Math.min(a, 255 - a) * 1.4, 0, 255);
  }
  g.putImageData(img, 0, 0);
}

/**
 * The tip's image for a dab of size s (longer side): { c, w, h, key }. Drawn at a slightly larger
 * cached size; the caller scales it to s.
 */
export function tipImage(tip, s, hard = 1, noise = false) {
  tip = hasTip(tip) ? tip : 'round';
  const q = quant(s);
  const drawn = DRAWN.has(tip);
  const key = `${tip}|${q}|${drawn ? Math.round(hard * 20) : 0}|${noise ? 1 : 0}`;
  let e = tipCache.get(key);
  if (e) {
    // most recently used goes last
    tipCache.delete(key);
    tipCache.set(key, e);
    return e;
  }
  const c = drawn ? drawTip(tip, q, hard) : scaleSampled(SAMPLED.get(tip), q);
  if (noise) addNoise(c);
  e = { c, w: c.width, h: c.height, key };
  tipCache.set(key, e);
  cachedPixels += e.w * e.h;
  // big sampled tips at several sizes add up: keep about 24 million pixels at most
  while (tipCache.size > 1 && (tipCache.size > 160 || cachedPixels > 24e6)) forget(tipCache.keys().next().value);
  return e;
}

/** A thumbnail of a tip (dark on transparent) for lists and pickers. */
export function tipThumb(tip, size = 40, hard = 1, color = '#e8eaed') {
  const out = makeCanvas(size, size);
  const t = tipImage(tip, Math.max(4, size - 6), hard);
  const k = Math.min((size - 6) / t.w, (size - 6) / t.h);
  const g = out.getContext('2d');
  g.drawImage(t.c, (size - t.w * k) / 2, (size - t.h * k) / 2, t.w * k, t.h * k);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  return out;
}

/** A copy of a tip image kept in memory, for canvases that are read back pixel by pixel. */
function cpuOf(img) {
  if (!img.cpu) {
    img.cpu = makeCanvas(img.w, img.h);
    img.cpu.getContext('2d', { willReadFrequently: true }).drawImage(img.c, 0, 0);
  }
  return img.cpu;
}

// the tip in one colour: one scratch canvas on the graphics card, one in memory
const tint = [{ c: null, key: '' }, { c: null, key: '' }];
/** The tip image in one colour (a shared scratch canvas the caller draws right away). */
function tinted(img, color, cpu = false) {
  const t = tint[cpu ? 1 : 0];
  const key = `${img.key}#${color}`;
  if (t.key === key && t.c) return t.c;
  if (!t.c || t.c.width < img.w || t.c.height < img.h) {
    t.c = makeCanvas(Math.max(img.w, t.c?.width || 64, 64), Math.max(img.h, t.c?.height || 64, 64));
    t.g = t.c.getContext('2d', { willReadFrequently: cpu });
  }
  const g = t.g;
  g.globalCompositeOperation = 'copy';
  g.drawImage(cpu ? cpuOf(img) : img.c, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, img.w, img.h);
  g.globalCompositeOperation = 'source-over';
  t.key = key;
  return t.c;
}

/**
 * Draw a tip image centred at (x, y): dw×dh pixels, turned, squashed (roundness) and flipped.
 * cpu: the target is a canvas kept in memory (so the tip comes from memory too).
 */
function putTip(g, img, color, x, y, dw, dh, ang, round, fx, fy, alpha, cpu = false) {
  const src = color ? tinted(img, color, cpu) : cpu ? cpuOf(img) : img.c;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const sx = fx ? -1 : 1;
  const sy = (fy ? -1 : 1) * round;
  g.globalAlpha = Math.min(1, alpha);
  g.setTransform(c * sx, s * sx, -s * sy, c * sy, x, y);
  g.drawImage(src, 0, 0, img.w, img.h, -dw / 2, -dh / 2, dw, dh);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
}

/** Bounding box of a dab: its dw × (dh·round) box turned by ang, around (x, y). */
function dabRect(x, y, dw, dh, round, ang = 0) {
  const c = Math.abs(Math.cos(ang));
  const sn = Math.abs(Math.sin(ang));
  const hw = 0.5 * (c * dw + sn * dh * round) + 1.5;
  const hh = 0.5 * (sn * dw + c * dh * round) + 1.5;
  return { x: Math.floor(x - hw), y: Math.floor(y - hh), w: Math.ceil(2 * hw) + 1, h: Math.ceil(2 * hh) + 1 };
}

const union = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const clipTo = (r, W, H) => {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.min(W, r.x + r.w) - x;
  const h = Math.min(H, r.y + r.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};

// ---------------------------------------------------------------- settings

/** How a setting follows the pen or the stroke (Photoshop's 조절 menu). */
export const CONTROLS = [['off', '끔'], ['fade', '희미하게'], ['pressure', '펜 압력'], ['tilt', '펜 기울기']];
export const ANGLE_CONTROLS = [...CONTROLS, ['initial', '초기 방향'], ['direction', '방향']];
export const TEXTURE_MODES = [['multiply', '곱하기'], ['subtract', '빼기'], ['darken', '어둡게 하기'], ['overlay', '오버레이'], ['colorDodge', '색상 닷지'], ['colorBurn', '색상 번'], ['linearBurn', '선형 번'], ['hardMix', '하드 혼합'], ['linearHeight', '선형 높이'], ['height', '높이']];
export const DUAL_MODES = [['multiply', '곱하기'], ['darken', '어둡게 하기'], ['overlay', '오버레이'], ['colorDodge', '색상 닷지'], ['colorBurn', '색상 번'], ['linearBurn', '선형 번'], ['hardMix', '하드 혼합'], ['linearHeight', '선형 높이']];

/** Every brush setting with its default (percentages unless noted). Kept in each tool's options. */
export const DYN = {
  // brush tip shape
  spacing: 15, angle: 0, roundness: 100, flipX: false, flipY: false,
  // shape dynamics
  shapeDyn: false, sizeJitter: 0, sizeCtrl: 'off', sizeFade: 25, minDiameter: 0,
  angleJitter: 0, angleCtrl: 'off', angleFade: 25, roundJitter: 0, roundCtrl: 'off', roundFade: 25, minRoundness: 25,
  flipXJitter: false, flipYJitter: false,
  // scattering
  scatterOn: false, scatter: 0, bothAxes: false, scatterCtrl: 'off', scatterFade: 25, count: 1, countJitter: 0, countCtrl: 'off', countFade: 25,
  // texture
  textureOn: false, texPattern: 'paper', texInvert: false, texScale: 100, texBrightness: 0, texContrast: 0, texEachTip: false, texMode: 'multiply', texDepth: 100, texMinDepth: 0, texDepthJitter: 0, texDepthCtrl: 'off', texDepthFade: 25,
  // dual brush
  dualOn: false, dualTip: 'spray', dualMode: 'multiply', dualSize: 25, dualSpacing: 25, dualScatter: 0, dualBothAxes: false, dualCount: 1, dualFlip: false,
  // colour dynamics
  colorDyn: false, colorEachTip: true, fgbgJitter: 0, fgbgCtrl: 'off', fgbgFade: 25, hueJitter: 0, satJitter: 0, briJitter: 0, purity: 0,
  // transfer
  transferOn: false, opacityJitter: 0, opacityCtrl: 'off', opacityFade: 25, minOpacity: 0, flowJitter: 0, flowCtrl: 'off', flowFade: 25, minFlow: 0,
  // the rest
  noise: false, wetEdges: false, airbrush: false, smoothingOn: true, smoothing: 10, protectTexture: false,
};
export const DYN_KEYS = Object.keys(DYN);

/**
 * The brush settings of a tool's options with defaults filled in. Settings saved before the
 * sections had their own switches turn their section on.
 */
export function normDyn(o) {
  const D = {};
  for (const k of DYN_KEYS) D[k] = o[k] ?? DYN[k];
  const legacy = (k, test) => {
    if (o[k] === undefined && test) D[k] = true;
  };
  legacy('shapeDyn', o.sizeJitter > 0 || o.angleJitter > 0 || o.roundJitter > 0 || o.followDir);
  if (o.followDir && o.angleCtrl === undefined) D.angleCtrl = 'direction';
  legacy('scatterOn', o.scatter > 0 || o.count > 1);
  legacy('colorDyn', o.fgbgJitter > 0 || o.hueJitter > 0 || o.satJitter > 0 || o.briJitter > 0);
  legacy('transferOn', o.opacityJitter > 0);
  return D;
}

/** True when the plain round brush would look the same (no dynamics at all). */
export function isPlainBrush(o) {
  const D = normDyn(o);
  return (o.tip || 'round') === 'round' && !D.angle && D.roundness >= 100 && !D.flipX && !D.flipY && !D.shapeDyn && !D.scatterOn && !D.textureOn && !D.dualOn && !D.colorDyn && !D.transferOn && !D.noise && !D.wetEdges && !D.airbrush && !o.pressureOpacity;
}

// ---------------------------------------------------------------- pen state

/** The pen as last seen (tilt is not passed through Stroke, so it is read here). */
const pen = { tiltX: 0, tiltY: 0, type: 'mouse' };
if (typeof window !== 'undefined') {
  const seen = (e) => {
    pen.type = e.pointerType;
    pen.tiltX = e.tiltX || 0;
    pen.tiltY = e.tiltY || 0;
  };
  window.addEventListener('pointerdown', seen, { capture: true, passive: true });
  window.addEventListener('pointermove', seen, { capture: true, passive: true });
}

// ---------------------------------------------------------------- textures

const texCache = new Map();
/**
 * A pattern turned into a height map for brush textures (grey, brightness / contrast / invert,
 * scaled): { w, h, v: Uint8Array of 0..255 }.
 */
function textureMap(D) {
  const key = `${D.texPattern}|${D.texScale}|${D.texBrightness}|${D.texContrast}|${D.texInvert}`;
  let t = texCache.get(key);
  if (t) return t;
  const p = patternCanvas(D.texPattern);
  const k = clamp(D.texScale, 1, 1000) / 100;
  const w = Math.max(1, Math.round(p.width * k));
  const hh = Math.max(1, Math.round(p.height * k));
  const c = makeCanvas(w, hh);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, hh);
  g.drawImage(p, 0, 0, w, hh);
  const d = g.getImageData(0, 0, w, hh).data;
  const v = new Uint8Array(w * hh);
  // contrast like Photoshop's (-50..100), brightness -150..150
  const cf = D.texContrast >= 0 ? 1 + D.texContrast / 25 : 1 + D.texContrast / 50;
  for (let i = 0; i < w * hh; i++) {
    let y = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    y = (y - 0.5) * cf + 0.5 + D.texBrightness / 300;
    y = clamp(y, 0, 1);
    v[i] = Math.round((D.texInvert ? 1 - y : y) * 255);
  }
  t = { w, h: hh, v };
  if (texCache.size > 12) texCache.delete(texCache.keys().next().value);
  texCache.set(key, t);
  return t;
}

/** A canvas tile whose alpha is 1 - depth·(1 - texture): multiplying by it is the Multiply mode. */
function multiplyTile(tex, depth) {
  const c = makeCanvas(tex.w, tex.h);
  const g = c.getContext('2d');
  const img = g.createImageData(tex.w, tex.h);
  for (let i = 0; i < tex.w * tex.h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255 * (1 - depth * (1 - tex.v[i] / 255));
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Paint amount a (0..1) against a texture height t (0..1) at a depth (0..1) in one of Photoshop's
 * texture modes; also used for the dual brush (t = its coverage, depth 1).
 */
function blendAmount(mode, a, t, depth) {
  // how much paint the texture lets through: 1 where it is high, 1 - depth where it is low
  const u = 1 - depth * (1 - t);
  switch (mode) {
    case 'multiply': return a * u;
    case 'subtract': return Math.max(0, a - depth * (1 - t));
    case 'darken': return Math.min(a, u);
    case 'overlay': return a * (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));
    case 'colorDodge': return a * Math.min(1, u * 1.6);
    case 'colorBurn': return a * Math.max(0, 1 - (1 - u) * 1.8);
    case 'linearBurn': return Math.max(0, a + u - 1);
    case 'hardMix': return u >= 0.5 ? a : 0;
    case 'linearHeight': return a * Math.min(1, Math.max(0, 0.5 + (t - depth * 0.5) / Math.max(0.2, 1 - depth * 0.5)));
    case 'height': return a * Math.min(1, Math.max(0, 0.5 + (t - depth * 0.5) * 6));
    default: return a;
  }
}

// ---------------------------------------------------------------- the dab painter

const TAU = Math.PI * 2;

/**
 * Make the dab painter for one stroke. ctx: { o (tool options), bo (Stroke options), mode, fg, bg,
 * isAlive() }. Stroke calls the result for every pixel of the path; it returns the changed rectangle
 * (layer coordinates) or null.
 */
export function createBrushRun({ o, bo, mode, fg, bg, isAlive = () => true }) {
  const D = normDyn(o);
  const tip = hasTip(o.tip) ? o.tip : 'round';
  const hard = bo.hardness ?? 0.7;
  const base = Math.max(1, o.size || bo.size || 30);
  const rnd = Math.random;
  const flow = bo.flow ?? 1;
  // the options bar's pen buttons win over the brush settings, like Photoshop's
  const sizeCtrl = o.pressureSize ? 'pressure' : D.shapeDyn ? D.sizeCtrl : 'off';
  const opacityCtrl = o.pressureOpacity ? 'pressure' : D.transferOn ? D.opacityCtrl : 'off';
  const opacityJ = D.transferOn ? D.opacityJitter / 100 : 0;
  const opacityDyn = opacityCtrl !== 'off' || opacityJ > 0;
  const texOn = D.textureOn;
  const texStroke = texOn && !D.texEachTip;
  const dualOn = D.dualOn;
  const wet = D.wetEdges;
  const composeOn = texStroke || dualOn || wet || opacityDyn;
  // modes the graphics card cannot do are worked out pixel by pixel
  const perPixel = opacityDyn || (texStroke && D.texMode !== 'multiply') || (dualOn && D.dualMode !== 'multiply');
  const tex = texOn ? textureMap(D) : null;
  let texMul = null;
  // cloning: the source picture (doc coords) and the matrix that carries it onto the document
  const clone = bo.cloneSrc ? { src: bo.cloneSrc, xf: bo.cloneXf || new DOMMatrix() } : null;
  const st0 = {
    calls: 0, n: 0, acc: 0, dacc: 0, last: null, force: false, dueMain: false, dueDual: false,
    initDir: null, strokeColor: null, lastMove: 0, timer: 0, ended: false,
  };
  let cov = null;
  let covG = null;
  let dualC = null;
  let dualG = null;
  let cap = null;
  let capW = 0;
  let scratch = null;
  let wetS = null;
  let wetE = null;
  let wetM = null;
  const sized = (c, w, h) => (c && c.width >= w && c.height >= h ? c : makeCanvas(Math.max(w, c?.width || 0, 32), Math.max(h, c?.height || 0, 32)));

  const pressureOf = (st) => clamp(st.pressure ?? 1, 0.02, 1);
  const tilt = () => (pen.type === 'pen' ? clamp(1 - Math.hypot(pen.tiltX, pen.tiltY) / 90, 0, 1) : 1);
  const ctrl = (kind, fade, st) => {
    switch (kind) {
      case 'fade': return Math.max(0, 1 - (st0.n - 1) / Math.max(1, fade));
      case 'pressure': return pressureOf(st);
      case 'tilt': return tilt();
      default: return 1;
    }
  };
  /** Size before jitter: what spacing is measured against. */
  const ctrlSize = (st) => {
    if (sizeCtrl === 'off') return base;
    const m = D.shapeDyn ? D.minDiameter / 100 : 0;
    return base * Math.max(m, ctrl(sizeCtrl, D.sizeFade, st));
  };

  function dabSize(st) {
    let s = ctrlSize(st);
    if (D.shapeDyn && D.sizeJitter) s = Math.max(base * (D.minDiameter / 100), s * (1 - (D.sizeJitter / 100) * rnd()));
    return Math.max(0.5, s);
  }

  function dabAngle(st) {
    let a = (D.angle * Math.PI) / 180;
    if (!D.shapeDyn) return a;
    switch (D.angleCtrl) {
      case 'direction': a += st.dir || 0; break;
      case 'initial': a += st0.initDir ?? st.dir ?? 0; break;
      case 'fade': a += TAU * (1 - ctrl('fade', D.angleFade, st)); break;
      case 'pressure': a += TAU * pressureOf(st); break;
      case 'tilt': a += pen.type === 'pen' ? Math.atan2(pen.tiltY, pen.tiltX) : 0; break;
      default:
    }
    if (D.angleJitter) a += (rnd() * 2 - 1) * Math.PI * (D.angleJitter / 100);
    return a;
  }

  function dabRound(st) {
    let r = D.roundness / 100;
    if (!D.shapeDyn) return Math.max(0.01, r);
    const m = D.minRoundness / 100;
    if (D.roundCtrl !== 'off') r *= Math.max(m, ctrl(D.roundCtrl, D.roundFade, st));
    if (D.roundJitter) r = Math.max(m * (D.roundness / 100), r * (1 - (D.roundJitter / 100) * rnd()));
    return Math.max(0.01, r);
  }

  function dabColor(st) {
    if (st.mode !== 'paint' || st.onMask) return '#000000';
    if (!D.colorDyn) return fg;
    if (!D.colorEachTip && st0.strokeColor) return st0.strokeColor;
    let [r, g, b] = hexRgb(fg);
    let t = D.fgbgCtrl !== 'off' ? 1 - ctrl(D.fgbgCtrl, D.fgbgFade, st) : 0;
    t = clamp(t + rnd() * (D.fgbgJitter / 100), 0, 1);
    if (t) {
      const [r2, g2, b2] = hexRgb(bg);
      r += (r2 - r) * t;
      g += (g2 - g) * t;
      b += (b2 - b) * t;
    }
    let [hh, s, v] = rgbToHsv(r, g, b);
    hh += (rnd() * 2 - 1) * (D.hueJitter / 100) * 0.5;
    s = clamp(s + (rnd() * 2 - 1) * (D.satJitter / 100), 0, 1);
    v = clamp(v + (rnd() * 2 - 1) * (D.briJitter / 100) * 0.5, 0, 1);
    if (D.purity) s = clamp(s * (1 + D.purity / 100), 0, 1);
    const col = rgbHex(...hsvToRgb(hh, s, v));
    if (!D.colorEachTip) st0.strokeColor = col;
    return col;
  }

  /** Paint amount of one dab: flow and transfer (opacity dynamics go into the cap, see compose). */
  function dabFlow(st) {
    let a = flow;
    if (D.transferOn) {
      const m = D.minFlow / 100;
      if (D.flowCtrl !== 'off') a *= Math.max(m, ctrl(D.flowCtrl, D.flowFade, st));
      if (D.flowJitter) a *= Math.max(m, 1 - (D.flowJitter / 100) * rnd());
    }
    return a;
  }
  function dabOpacity(st) {
    let a = 1;
    const m = D.transferOn ? D.minOpacity / 100 : 0;
    if (opacityCtrl !== 'off') a *= Math.max(m, ctrl(opacityCtrl, D.opacityFade, st));
    if (opacityJ) a *= Math.max(m, 1 - opacityJ * rnd());
    return a;
  }

  function ensureBuffers(st) {
    const W = st.bg.canvas.width;
    const H = st.bg.canvas.height;
    // read pixel by pixel: kept in memory (reading back from the graphics card is slow)
    if (!cov) {
      cov = makeCanvas(W, H);
      covG = cov.getContext('2d', { willReadFrequently: perPixel });
    }
    if (dualOn && !dualC) {
      dualC = makeCanvas(W, H);
      dualG = dualC.getContext('2d', { willReadFrequently: perPixel });
    }
    if (opacityDyn && !cap) {
      cap = new Uint8Array(W * H);
      capW = W;
    }
  }

  /** Scratch canvas at least w×h, cleared: in memory (cpu, read back) or on the graphics card. */
  const scratches = [null, null];
  function scratchOf(w, h, cpu = true) {
    let c = scratches[cpu ? 1 : 0];
    if (!c || c.width < w || c.height < h) {
      c = makeCanvas(Math.max(w, c?.width || 0, 64), Math.max(h, c?.height || 0, 64));
      c.getContext('2d', { willReadFrequently: cpu });
      scratches[cpu ? 1 : 0] = c;
    }
    scratch = c;
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    return g;
  }

  /**
   * Raise the opacity cap under a dab to the dab's opacity (Photoshop's per-dab opacity: paint
   * builds up with flow but never past the strongest opacity that touched the spot).
   */
  function raiseCap(st, img, x, y, dw, dh, ang, round, fx, fy, op) {
    const r = clipTo(dabRect(x, y, dw, dh, round, ang), capW, cap.length / capW);
    if (!r) return;
    const v = Math.round(op * 255);
    if (tip === 'round') {
      // a round tip covers an ellipse: no need to draw it
      const a = dw / 2;
      const b = Math.max(0.5, (dh * round) / 2);
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      for (let yy = 0; yy < r.h; yy++) {
        const py = r.y + yy + 0.5 - y;
        let i = (r.y + yy) * capW + r.x;
        for (let xx = 0; xx < r.w; xx++, i++) {
          const px = r.x + xx + 0.5 - x;
          const u = (px * c + py * sn) / a;
          const w = (-px * sn + py * c) / b;
          if (u * u + w * w <= 1 && v > cap[i]) cap[i] = v;
        }
      }
      return;
    }
    const g = scratchOf(r.w, r.h);
    putTip(g, img, null, x - r.x, y - r.y, dw, dh, ang, round, fx, fy, 1, true);
    const d = g.getImageData(0, 0, r.w, r.h).data;
    for (let yy = 0; yy < r.h; yy++) {
      let i = (r.y + yy) * capW + r.x;
      let j = yy * r.w * 4 + 3;
      for (let xx = 0; xx < r.w; xx++, i++, j += 4) if (d[j] && v > cap[i]) cap[i] = v;
    }
  }

  /** One dab of the main tip at layer point (x, y) into the target; returns its rectangle. */
  function mainDab(st, g, x, y) {
    const s = dabSize(st);
    const img = tipImage(tip, s, hard, D.noise);
    const k = s / Math.max(img.w, img.h);
    const dw = img.w * k;
    const dh = img.h * k;
    const ang = dabAngle(st);
    const round = dabRound(st);
    const fx = D.flipX !== (D.shapeDyn && D.flipXJitter && rnd() < 0.5);
    const fy = D.flipY !== (D.shapeDyn && D.flipYJitter && rnd() < 0.5);
    if (D.scatterOn && D.scatter) {
      const amp = (D.scatter / 100) * s * 0.5 * ctrl(D.scatterCtrl, D.scatterFade, st);
      if (D.bothAxes) {
        x += (rnd() * 2 - 1) * amp;
        y += (rnd() * 2 - 1) * amp;
      } else {
        // across the stroke
        const dir = st.dir || 0;
        const off = (rnd() * 2 - 1) * amp;
        x += -Math.sin(dir) * off;
        y += Math.cos(dir) * off;
      }
    }
    let a = dabFlow(st);
    let col = dabColor(st);
    if (bo.mixer) {
      const m = bo.mixer(st, x, y, s);
      col = m.color;
      a *= m.alpha;
    }
    if (a <= 0.002) return null;
    if (clone) {
      // clone stamp, healing, pattern stamp, history brush: the source picture shows through the tip
      const r = dabRect(x, y, dw, dh, round, ang);
      const sg = scratchOf(r.w, r.h, false);
      sg.setTransform(new DOMMatrix().translate(-(r.x + st.ox), -(r.y + st.oy)).multiply(clone.xf));
      sg.drawImage(clone.src, 0, 0);
      sg.setTransform(1, 0, 0, 1, 0, 0);
      sg.globalCompositeOperation = 'destination-in';
      putTip(sg, img, null, x - r.x, y - r.y, dw, dh, ang, round, fx, fy, 1);
      sg.globalCompositeOperation = 'source-over';
      g.globalAlpha = Math.min(1, a);
      g.drawImage(scratch, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
    } else if (texOn && D.texEachTip) {
      // the texture goes into each dab, with its own depth
      const r = dabRect(x, y, dw, dh, round, ang);
      const sg = scratchOf(r.w, r.h);
      putTip(sg, img, col, x - r.x, y - r.y, dw, dh, ang, round, fx, fy, 1, true);
      let depth = D.texDepth / 100;
      const dm = D.texMinDepth / 100;
      if (D.texDepthCtrl !== 'off') depth *= Math.max(dm, ctrl(D.texDepthCtrl, D.texDepthFade, st));
      if (D.texDepthJitter) depth *= Math.max(dm, 1 - (D.texDepthJitter / 100) * rnd());
      const im = sg.getImageData(0, 0, r.w, r.h);
      const d = im.data;
      for (let yy = 0; yy < r.h; yy++) {
        const ty = (((r.y + yy + st.oy) % tex.h) + tex.h) % tex.h;
        for (let xx = 0; xx < r.w; xx++) {
          const j = (yy * r.w + xx) * 4 + 3;
          if (!d[j]) continue;
          const tx = (((r.x + xx + st.ox) % tex.w) + tex.w) % tex.w;
          d[j] = 255 * blendAmount(D.texMode, d[j] / 255, tex.v[ty * tex.w + tx] / 255, depth);
        }
      }
      sg.putImageData(im, 0, 0);
      g.globalAlpha = Math.min(1, a);
      g.drawImage(scratch, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
    } else putTip(g, img, col, x, y, dw, dh, ang, round, fx, fy, a, composeOn && perPixel);
    if (opacityDyn) raiseCap(st, img, x, y, dw, dh, ang, round, fx, fy, dabOpacity(st));
    return dabRect(x, y, dw, dh, round, ang);
  }

  /** Dabs of the dual brush (alpha only) along the same path. */
  function dualDab(st, x, y) {
    const s = Math.max(1, D.dualSize);
    const img = tipImage(hasTip(D.dualTip) ? D.dualTip : 'spray', s, 1, false);
    const k = s / Math.max(img.w, img.h);
    let rect = null;
    const n = clamp(Math.round(D.dualCount), 1, 16);
    for (let i = 0; i < n; i++) {
      let px = x;
      let py = y;
      if (D.dualScatter) {
        const amp = (D.dualScatter / 100) * s * 0.5;
        if (D.dualBothAxes) {
          px += (rnd() * 2 - 1) * amp;
          py += (rnd() * 2 - 1) * amp;
        } else {
          const dir = st.dir || 0;
          const off = (rnd() * 2 - 1) * amp;
          px += -Math.sin(dir) * off;
          py += Math.cos(dir) * off;
        }
      }
      const fx = D.dualFlip && rnd() < 0.5;
      const fy = D.dualFlip && rnd() < 0.5;
      const da = D.dualFlip ? rnd() * TAU : 0;
      putTip(dualG, img, null, px, py, img.w * k, img.h * k, da, 1, fx, fy, 1, perPixel);
      rect = union(rect, dabRect(px, py, img.w * k, img.h * k, 1, da));
    }
    return rect;
  }

  /**
   * Rebuild the stroke buffer inside r from the coverage: dual brush, texture, opacity cap and wet
   * edges. Returns the rectangle that changed.
   */
  function compose(st, r) {
    const W = st.bg.canvas.width;
    const H = st.bg.canvas.height;
    const blur = wet ? Math.max(1, Math.round(base * 0.1)) : 0;
    r = clipTo(grow(r, blur * 2), W, H);
    if (!r) return null;
    const g = st.bg;
    if (perPixel) {
      // dual brush, texture and the opacity cap, pixel by pixel from the coverage
      const im = covG.getImageData(r.x, r.y, r.w, r.h);
      const d = im.data;
      const dd = dualOn ? dualG.getImageData(r.x, r.y, r.w, r.h).data : null;
      const depth = D.texDepth / 100;
      for (let yy = 0; yy < r.h; yy++) {
        const ty = texStroke ? (((r.y + yy + st.oy) % tex.h) + tex.h) % tex.h : 0;
        const row = ty * (tex?.w || 0);
        let ci = (r.y + yy) * capW + r.x;
        let tx = texStroke ? (((r.x + st.ox) % tex.w) + tex.w) % tex.w : 0;
        for (let xx = 0, j = yy * r.w * 4 + 3; xx < r.w; xx++, ci++, j += 4) {
          let a = d[j];
          if (a) {
            a /= 255;
            if (dd) a = blendAmount(D.dualMode, a, dd[j] / 255, 1);
            if (texStroke) a = blendAmount(D.texMode, a, tex.v[row + tx] / 255, depth);
            if (cap) a *= cap[ci] / 255;
            d[j] = a * 255;
          }
          if (texStroke && ++tx === tex.w) tx = 0;
        }
      }
      g.putImageData(im, r.x, r.y);
    } else {
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      g.globalCompositeOperation = 'copy';
      g.drawImage(cov, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      if (dualOn) {
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(dualC, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      }
      if (texStroke) {
        texMul ||= g.createPattern(multiplyTile(tex, D.texDepth / 100), 'repeat');
        // the texture stays put on the document between strokes
        texMul.setTransform(new DOMMatrix().translate(-st.ox, -st.oy));
        g.globalCompositeOperation = 'destination-in';
        g.fillStyle = texMul;
        g.fillRect(r.x, r.y, r.w, r.h);
      }
      g.restore();
    }
    if (wet) wetEdges(st, r, blur);
    return r;
  }

  /** Wet edges: the middle of the stroke lighter, the paint gathered at its edges. */
  function wetEdges(st, r, blur) {
    const W = st.bg.canvas.width;
    const H = st.bg.canvas.height;
    const R = clipTo(grow(r, blur * 2), W, H);
    const f = Math.max(1, blur);
    const sw = Math.max(1, Math.ceil(R.w / f));
    const sh = Math.max(1, Math.ceil(R.h / f));
    // blurred coverage: shrunk, then stretched back (smooth and cheap)
    wetS = sized(wetS, sw, sh);
    const sg = wetS.getContext('2d');
    sg.clearRect(0, 0, sw, sh);
    sg.drawImage(cov, R.x, R.y, R.w, R.h, 0, 0, sw, sh);
    // edge = coverage · (1 - blurred coverage)
    wetE = sized(wetE, R.w, R.h);
    const eg = wetE.getContext('2d');
    eg.globalCompositeOperation = 'copy';
    eg.drawImage(cov, R.x, R.y, R.w, R.h, 0, 0, R.w, R.h);
    eg.globalCompositeOperation = 'destination-out';
    eg.drawImage(wetS, 0, 0, sw, sh, 0, 0, R.w, R.h);
    eg.globalCompositeOperation = 'source-over';
    // mask: 40% inside, rising to full strength at the edges
    wetM = sized(wetM, R.w, R.h);
    const mg = wetM.getContext('2d');
    mg.globalCompositeOperation = 'copy';
    mg.fillStyle = 'rgba(255,255,255,0.4)';
    mg.fillRect(0, 0, R.w, R.h);
    mg.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 3; k++) mg.drawImage(wetE, 0, 0, R.w, R.h, 0, 0, R.w, R.h);
    const g = st.bg;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(wetM, 0, 0, R.w, R.h, R.x, R.y, R.w, R.h);
    g.restore();
  }

  /** Decide, once per path pixel, whether a main or dual dab is due here. */
  function advance(st, x, y) {
    if (st0.last) {
      const d = Math.hypot(x - st0.last.x, y - st0.last.y);
      if (d > 0) st0.lastMove = performance.now();
      st0.acc += d;
      st0.dacc += d;
      if (st0.initDir == null && d > 0.5 && st.dir != null) st0.initDir = st.dir;
    }
    st0.last = { x, y };
    const sp = Math.max(1, ctrlSize(st) * (D.spacing / 100));
    st0.dueMain = st0.force || st0.n === 0 || st0.acc >= sp;
    if (st0.dueMain) {
      if (st0.n > 0 && !st0.force) st0.acc = Math.min(st0.acc - sp, sp);
      st0.n++;
    }
    if (dualOn) {
      const dsp = Math.max(1, D.dualSize * (D.dualSpacing / 100));
      st0.dueDual = st0.force || st0.dacc >= dsp || !st0.dualStarted;
      if (st0.dueDual) {
        if (st0.dualStarted && !st0.force) st0.dacc = Math.min(st0.dacc - dsp, dsp);
        st0.dualStarted = true;
      }
    }
    st0.force = false;
  }

  function startAirbrush(st) {
    if (!D.airbrush || st0.timer || !st.stamp) return;
    st0.timer = setInterval(() => {
      if (st0.ended || !isAlive(st)) {
        clearInterval(st0.timer);
        return;
      }
      // while the pen rests, paint keeps building up where it is
      if (performance.now() - st0.lastMove < 70 || !st.last) return;
      st0.force = true;
      st.stamp(st.last.x, st.last.y, base);
      st.flush();
    }, 60);
  }

  const engine = (st, lx, ly, size, x, y) => {
    const T = st.sym ? st.sym.length : 1;
    const k = st0.calls++ % T;
    if (k === 0) advance(st, x, y);
    if (!st0.dueMain && !st0.dueDual) return null;
    if (composeOn) ensureBuffers(st);
    if (st0.n === 1 && k === 0) startAirbrush(st);
    let rect = null;
    if (st0.dueMain) {
      const n = D.scatterOn ? clamp(Math.round(D.count * (1 - (D.countJitter / 100) * rnd()) * ctrl(D.countCtrl, D.countFade, st)), 1, 16) : 1;
      const g = composeOn ? covG : st.bg;
      for (let i = 0; i < n; i++) rect = union(rect, mainDab(st, g, lx, ly));
    }
    if (st0.dueDual) rect = union(rect, dualDab(st, lx, ly));
    if (!rect) return null;
    if (composeOn) return compose(st, rect);
    return rect;
  };
  /** Stop timers (the stroke ended). */
  engine.end = () => {
    st0.ended = true;
    clearInterval(st0.timer);
  };
  engine.settings = D;
  return engine;
}

/**
 * Paint a preview stroke (an S-curve) with the given options into a canvas, the way Stroke would:
 * the painter is called every pixel along the path.
 */
export function previewStroke(canvas, o, { color = '#000000', bg = '#ffffff', size = null, eraser = false } = {}) {
  const W = canvas.width;
  const H = canvas.height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  const buf = makeCanvas(W, H);
  const sz = size ?? clamp(o.size || 30, 4, Math.round(H * 0.42));
  const oo = { ...o, size: sz, pressureSize: false, pressureOpacity: false };
  const bo = { size: sz, hardness: (o.hardness ?? 70) / 100, flow: (o.flow ?? 100) / 100 };
  const run = createBrushRun({ o: oo, bo, mode: eraser ? 'erase' : 'paint', fg: color, bg });
  const st = { bg: buf.getContext('2d'), mode: 'paint', onMask: false, dir: 0, pressure: 1, sym: null, ox: 0, oy: 0 };
  const fade = (oo.sizeCtrl === 'pressure' || oo.opacityCtrl === 'pressure' || oo.flowCtrl === 'pressure' || oo.fgbgCtrl === 'pressure');
  let last = null;
  const pad = sz * 0.6 + 6;
  for (let t = 0; t <= 1.0001; t += 0.0005) {
    const x = pad + t * (W - 2 * pad);
    const y = H / 2 + Math.sin(t * Math.PI * 2) * (H / 2 - pad) * 0.8;
    if (last) {
      const d = Math.hypot(x - last.x, y - last.y);
      if (d < 1) continue;
      st.dir = Math.atan2(y - last.y, x - last.x);
    }
    // a pen stroke that starts and ends light, so pressure settings show
    st.pressure = fade ? Math.sin(Math.PI * t) * 0.9 + 0.1 : 1;
    last = { x, y };
    run(st, x, y, sz, x, y);
  }
  run.end();
  g.globalAlpha = (o.opacity ?? 100) / 100;
  g.drawImage(buf, 0, 0);
  g.globalAlpha = 1;
  return canvas;
}

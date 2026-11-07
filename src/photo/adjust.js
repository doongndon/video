// Image adjustments (also used by adjustment layers and smart filters) and the core filters. All work
// on ImageData / canvases. Other modules register more entries in the same tables (fx2.js, fx3.js,
// fx4.js, fxgallery.js…); each entry may carry its own fn.
//
// A params definition is [key, label, min, max, default, kind]; kind is 'bool' | 'color' | 'gradient' |
// a select list [[value, label]…] | a slider step | 'hidden' (stored, edited by a custom editor) or the
// name of a custom editor in adjui.js ('levels', 'curves', 'hueSat'…) that edits the whole entry.

import { blurred, mk, read, toCanvas, lum, cl, clamp, smooth, hexRgb, rng, mirrorPad, sampler, medianData, TO_LIN, toSrgb, rgbToHsl, hslToRgb } from './fxcore.js';
import { gradientLut } from './resources.js';

// ---------------------------------------------------------------- shared data

/** Hue ranges of Hue/Saturation (degrees: start of ramp, full from, full to, end of ramp). */
export const HUE_RANGES = [
  ['reds', '빨강 계열', [315, 345, 15, 45]],
  ['yellows', '노랑 계열', [15, 45, 75, 105]],
  ['greens', '녹색 계열', [75, 105, 135, 165]],
  ['cyans', '녹청 계열', [135, 165, 195, 225]],
  ['blues', '파랑 계열', [195, 225, 255, 285]],
  ['magentas', '마젠타 계열', [255, 285, 315, 345]],
];

/** Photoshop's Photo Filter list (Korean names) and their colours. */
export const PHOTO_FILTERS = [
  ['warm85', '따뜻한 효과 필터 (85)', '#ec8a00'], ['warmLBA', '따뜻한 효과 필터 (LBA)', '#fa9600'], ['warm81', '따뜻한 효과 필터 (81)', '#ebb113'],
  ['cool80', '냉각 효과 필터 (80)', '#006dff'], ['coolLBB', '냉각 효과 필터 (LBB)', '#005dff'], ['cool82', '냉각 효과 필터 (82)', '#00b5ff'],
  ['red', '빨강', '#ea1a1a'], ['orange', '주황', '#f38417'], ['yellow', '노랑', '#f9e31c'], ['green', '녹색', '#19c919'], ['cyan', '녹청', '#1dcbea'],
  ['blue', '파랑', '#1d35ea'], ['violet', '보라', '#9b1dea'], ['magenta', '마젠타', '#e318e3'], ['sepia', '세피아', '#ac7a33'],
  ['deepRed', '진한 빨강', '#ff0000'], ['deepBlue', '진한 파랑', '#0022cd'], ['deepEmerald', '진한 에메랄드', '#008c00'], ['deepYellow', '진한 노랑', '#ffd500'], ['underwater', '수중', '#00c1b1'],
];

export const SELECTIVE_TARGETS = [['reds', '빨강 계열'], ['yellows', '노랑 계열'], ['greens', '녹색 계열'], ['cyans', '녹청 계열'], ['blues', '파랑 계열'], ['magentas', '마젠타 계열'], ['whites', '흰색 계열'], ['neutrals', '중간 회색 계열'], ['blacks', '검정 계열']];

/** Built-in looks of Color Lookup (our own approximations of Photoshop's 3DLUT files). */
export const LOOKS = [
  ['tealOrange', '틸 앤 오렌지 (TealOrangePlusContrast)'], ['crispWarm', 'Crisp_Warm'], ['crispWinter', 'Crisp_Winter'], ['softWarming', 'Soft_Warming'],
  ['candlelight', 'Candlelight'], ['fallColors', 'FallColors'], ['lateSunset', 'LateSunset'], ['edgyAmber', 'EdgyAmber'], ['dropBlues', 'DropBlues'],
  ['foggyNight', 'FoggyNight'], ['moonlight', 'Moonlight'], ['nightFromDay', 'NightFromDay'], ['horrorBlue', 'HorrorBlue'], ['tensionGreen', 'TensionGreen'],
  ['bleach', '블리치 바이패스 (Bleach Bypass)'], ['strip2', '2Strip'], ['strip3', '3Strip'], ['filmstock', 'filmstock_50'],
  ['warmFilm', '따뜻한 필름'], ['coolBlue', '차가운 블루'], ['fadedVintage', '바랜 빈티지'], ['bwContrast', '흑백 고대비'], ['purpleDusk', '보라빛 노을'], ['greenMatrix', '녹색 톤'],
  ['file', '불러온 LUT 파일'],
];

const TONES = [['shadows', '어두운 영역'], ['midtones', '중간 영역'], ['highlights', '밝은 영역']];

// ---------------------------------------------------------------- adjustments

export const ADJUSTMENTS = {
  brightness: { name: '명도/대비', params: [['brightness', '명도', -150, 150, 0], ['contrast', '대비', -100, 100, 0], ['legacy', '레거시 사용', null, null, false, 'bool']] },
  levels: {
    name: '레벨',
    params: [['inBlack', '입력 검정', 0, 253, 0, 'levels'], ['gamma', '중간 톤 (감마)', 0.1, 9.99, 1, 'hidden'], ['inWhite', '입력 흰색', 2, 255, 255, 'hidden'], ['outBlack', '출력 검정', 0, 255, 0, 'hidden'], ['outWhite', '출력 흰색', 0, 255, 255, 'hidden'], ['channels', '채널별 값', null, null, null, 'hidden']],
  },
  curves: { name: '곡선', params: [['points', '곡선', null, null, [[0, 0], [255, 255]], 'curves'], ['r', '빨강 곡선', null, null, null, 'hidden'], ['g', '녹색 곡선', null, null, null, 'hidden'], ['b', '파랑 곡선', null, null, null, 'hidden']] },
  exposure: { name: '노출', params: [['exposure', '노출', -10, 10, 0, 0.01], ['offset', '오프셋', -0.5, 0.5, 0, 0.0001], ['gamma', '감마 교정', 0.01, 9.99, 1, 0.01]] },
  vibrance: { name: '활기', params: [['vibrance', '활기', -100, 100, 0], ['saturation', '채도', -100, 100, 0]] },
  hueSat: { name: '색조/채도', params: [['hue', '색조', -180, 180, 0, 'hueSat'], ['saturation', '채도', -100, 100, 0, 'hidden'], ['lightness', '밝기', -100, 100, 0, 'hidden'], ['colorize', '색상화', null, null, false, 'hidden'], ['ranges', '색상 범위별 값', null, null, null, 'hidden']] },
  colorBalance: { name: '색상 균형', params: [['cr', '녹청 ↔ 빨강', -100, 100, 0, 'colorBalance'], ['mg', '마젠타 ↔ 녹색', -100, 100, 0, 'hidden'], ['yb', '노랑 ↔ 파랑', -100, 100, 0, 'hidden'], ['shadows', '어두운 영역 값', null, null, null, 'hidden'], ['highlights', '밝은 영역 값', null, null, null, 'hidden'], ['preserve', '광도 유지', null, null, true, 'hidden']] },
  bw: { name: '흑백', params: [['reds', '빨강 계열', -200, 300, 40, 'bw'], ['yellows', '노랑 계열', -200, 300, 60, 'hidden'], ['greens', '녹색 계열', -200, 300, 40, 'hidden'], ['cyans', '녹청 계열', -200, 300, 60, 'hidden'], ['blues', '파랑 계열', -200, 300, 20, 'hidden'], ['magentas', '마젠타 계열', -200, 300, 80, 'hidden'], ['tint', '색조', null, null, false, 'hidden'], ['tintHue', '색조 각도', 0, 360, 42, 'hidden'], ['tintSat', '색조 채도', 0, 100, 20, 'hidden']] },
  photoFilter: { name: '포토 필터', params: [['filter', '필터', null, null, 'warm85', 'photoFilter'], ['color', '색상', null, null, '#ec8a00', 'hidden'], ['density', '밀도 (%)', 1, 100, 25], ['preserve', '광도 유지', null, null, true, 'bool']] },
  channelMixer: {
    name: '채널 혼합',
    params: [['rr', '빨강 출력: 빨강', -200, 200, 100, 'channelMixer'], ['rg', '빨강 출력: 녹색', -200, 200, 0, 'hidden'], ['rb', '빨강 출력: 파랑', -200, 200, 0, 'hidden'], ['gr', '녹색 출력: 빨강', -200, 200, 0, 'hidden'], ['gg', '녹색 출력: 녹색', -200, 200, 100, 'hidden'], ['gb', '녹색 출력: 파랑', -200, 200, 0, 'hidden'], ['br', '파랑 출력: 빨강', -200, 200, 0, 'hidden'], ['bg', '파랑 출력: 녹색', -200, 200, 0, 'hidden'], ['bb', '파랑 출력: 파랑', -200, 200, 100, 'hidden'],
      ['constant', '상수', -200, 200, 0, 'hidden'], ['rk', '빨강 출력: 상수', -200, 200, 0, 'hidden'], ['gk', '녹색 출력: 상수', -200, 200, 0, 'hidden'], ['bk', '파랑 출력: 상수', -200, 200, 0, 'hidden'],
      ['mono', '단색', null, null, false, 'hidden'], ['mr', '회색 출력: 빨강', -200, 200, 40, 'hidden'], ['mg', '회색 출력: 녹색', -200, 200, 40, 'hidden'], ['mb', '회색 출력: 파랑', -200, 200, 20, 'hidden'], ['mk', '회색 출력: 상수', -200, 200, 0, 'hidden']],
  },
  colorLookup: { name: '색상 검색', params: [['look', '3DLUT 파일', null, null, 'tealOrange', LOOKS], ['lut', 'LUT 파일', null, null, null, 'lut'], ['amount', '강도 (%)', 0, 100, 100]] },
  invert: { name: '반전', params: [] },
  posterize: { name: '포스터화', params: [['levels', '레벨', 2, 255, 4]] },
  threshold: { name: '한계값', params: [['level', '한계값 레벨', 1, 255, 128, 'threshold']] },
  gradientMap: { name: '그레이디언트 맵', params: [['gradient', '그레이디언트', null, null, null, 'gradientMap'], ['from', '어두운 색', null, null, '#000000', 'hidden'], ['to', '밝은 색', null, null, '#ffffff', 'hidden'], ['dither', '디더', null, null, false, 'bool'], ['reverse', '반전', null, null, false, 'bool']] },
  selectiveColor: { name: '선택 색상', params: [['target', '색상', null, null, 'reds', 'selectiveColor'], ['cyan', '녹청', -100, 100, 0, 'hidden'], ['magenta', '마젠타', -100, 100, 0, 'hidden'], ['yellow', '노랑', -100, 100, 0, 'hidden'], ['black', '검정', -100, 100, 0, 'hidden'], ['absolute', '절대치', null, null, false, 'hidden'], ['colors', '색상별 값', null, null, null, 'hidden']] },
  shadowsHighlights: {
    name: '어두운 영역/밝은 영역',
    params: [['shadows', '어두운 영역: 양 (%)', 0, 100, 35], ['sTone', '어두운 영역: 톤 (%)', 0, 100, 50], ['radius', '어두운 영역: 반경 (px)', 0, 2500, 30],
      ['highlights', '밝은 영역: 양 (%)', 0, 100, 0], ['hTone', '밝은 영역: 톤 (%)', 0, 100, 50], ['hRadius', '밝은 영역: 반경 (px)', 0, 2500, 30],
      ['color', '조정: 색상', -100, 100, 20], ['midtone', '조정: 중간 톤', -100, 100, 0], ['blackClip', '검정 클리핑 (%)', 0, 50, 0.01, 0.01], ['whiteClip', '흰색 클리핑 (%)', 0, 50, 0.01, 0.01]],
  },
  desaturate: { name: '채도 감소', params: [] },
  replaceColor: { name: '색상 대체', params: [['color', '색상', null, null, '#d03030', 'replaceColor'], ['add', '추가한 색', null, null, null, 'hidden'], ['sub', '뺀 색', null, null, null, 'hidden'], ['fuzz', '허용량', 1, 200, 40, 'hidden'], ['hue', '색조', -180, 180, 0, 'hidden'], ['saturation', '채도', -100, 100, 0, 'hidden'], ['lightness', '밝기', -100, 100, 0, 'hidden']] },
  equalize: { name: '평활화', params: [] },
};

export function defaultParams(type) {
  const out = {};
  for (const [k, , , , def] of ADJUSTMENTS[type].params) out[k] = structuredClone(def);
  return out;
}

/** Monotone cubic curve through points [[x,y]...] → 256-entry lookup table. */
export function curveLut(points) {
  const pts = [...(points || [])].filter((p) => Array.isArray(p)).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const lut = new Uint8ClampedArray(256);
  if (n < 2) {
    for (let i = 0; i < 256; i++) lut[i] = n === 1 ? pts[0][1] : i;
    return lut;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) lut[x] = ys[0];
    else if (x >= xs[n - 1]) lut[x] = ys[n - 1];
    else {
      let i = 0;
      while (x > xs[i + 1]) i++;
      const hseg = Math.max(1e-6, xs[i + 1] - xs[i]);
      const t = (x - xs[i]) / hseg;
      const t2 = t * t;
      const t3 = t2 * t;
      lut[x] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hseg * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hseg * m[i + 1];
    }
  }
  return lut;
}

/** One Levels channel [inBlack, gamma, inWhite, outBlack, outWhite] as a lookup table. */
export function levelsLut(v) {
  const [ib = 0, ga = 1, iw = 255, ob = 0, ow = 255] = v || [];
  const lut = new Float32Array(256);
  const g = clamp(+ga || 1, 0.01, 10);
  for (let i = 0; i < 256; i++) {
    const t = clamp((i - ib) / Math.max(1, iw - ib), 0, 1);
    lut[i] = ob + (ow - ob) * t ** (1 / g);
  }
  return lut;
}

/** Brightness/Contrast (non-legacy keeps black and white points, like Photoshop's). */
function brightnessLut(p) {
  const lut = new Float32Array(256);
  const b = +p.brightness || 0;
  const c = +p.contrast || 0;
  if (p.legacy) {
    const k = c / 100;
    const f = k >= 0 ? 1 / Math.max(0.01, 1 - k) : 1 + k;
    for (let i = 0; i < 256; i++) lut[i] = (i + b - 128) * f + 128;
    return lut;
  }
  const gamma = b >= 0 ? 1 / (1 + b / 100) : 1 - b / 100;
  const k = c >= 0 ? 1 + (c / 100) * 1.6 : 1 + c / 150;
  for (let i = 0; i < 256; i++) {
    let t = (i / 255) ** gamma;
    if (k !== 1) {
      const a = t ** k;
      t = a / (a + (1 - t) ** k);
      // lower contrast also pulls black and white a little toward grey
      if (c < 0) t = 0.5 + (t - 0.5) * (1 + c / 250);
    }
    lut[i] = t * 255;
  }
  return lut;
}

function rangeWeight(h, [a, b, c, d]) {
  const rel = (x) => (((x - a) % 360) + 360) % 360;
  const hb = rel(b);
  const hc = rel(c);
  const hd = rel(d);
  const t = rel(h);
  if (t <= hb) return hb > 0 ? t / hb : 1;
  if (t <= hc) return 1;
  if (t <= hd) return (hd - t) / Math.max(1e-6, hd - hc);
  return 0;
}

// Bayer 4×4 matrix for dithering (values -0.5..0.5)
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

// decoded LUT files (base64 → Float32Array), a few at a time
const lutCache = new Map();
export function decodeLut(lut) {
  if (!lut?.data || !lut.size) return null;
  const key = `${lut.size}:${lut.data.length}:${lut.data.slice(0, 64)}:${lut.data.slice(-64)}`;
  if (lutCache.has(key)) return lutCache.get(key);
  const bin = atob(lut.data);
  const a = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i) / 255;
  if (lutCache.size > 6) lutCache.delete(lutCache.keys().next().value);
  const out = { size: lut.size, a };
  lutCache.set(key, out);
  return out;
}

/** Built-in look: rgb 0..255 in, [r, g, b] out (before the amount mix). */
function lookPixel(look, r, g, b) {
  const L = lum(r, g, b);
  const t = L / 255;
  const sc = (v, lo, hi) => lo + (v / 255) * (hi - lo);
  const sat = (o, k) => o.map((v) => L + (v - L) * k);
  const con = (v, k) => (v - 128) * k + 128;
  const sh = 1 - smooth(0, 0.6, t);
  const hi = smooth(0.4, 1, t);
  switch (look) {
    case 'warmFilm': return [sc(r, 18, 255), sc(g, 12, 242), sc(b, 10, 215)];
    case 'coolBlue': return [sc(r, 0, 225), sc(g, 8, 240), sc(b, 25, 255)];
    case 'tealOrange': return sat([con(r - 22 * sh + 26 * hi, 1.1), con(g + 8 * sh + 6 * hi, 1.1), con(b + 20 * sh - 30 * hi, 1.1)], 1.12);
    case 'fadedVintage': return [sc(r, 35, 235), sc(g, 30, 225), sc(b, 40, 200)].map((v) => L * 0.25 + v * 0.75);
    case 'bwContrast': {
      const v = con(L, 1.35);
      return [v, v, v];
    }
    case 'purpleDusk': return [r * 1.02 + 18 * (1 - t), g * 0.9, b * 1.05 + 30 * (1 - t)];
    case 'greenMatrix': return [r * 0.8, g * 1.05 + 10, b * 0.75];
    case 'bleach': {
      const k = 0.45;
      return [con(r * (1 - k) + L * k, 1.25), con(g * (1 - k) + L * k, 1.25), con(b * (1 - k) + L * k, 1.25)];
    }
    case 'crispWarm': return sat([con(r * 1.04 + 6, 1.12), con(g * 1.0 + 2, 1.12), con(b * 0.9, 1.12)], 1.08);
    case 'crispWinter': return sat([con(r * 0.92, 1.12), con(g * 0.99 + 2, 1.12), con(b * 1.06 + 10, 1.12)], 0.95);
    case 'softWarming': return [sc(r, 10, 255), sc(g, 6, 246), sc(b, 4, 228)].map((v) => con(v, 0.96));
    case 'candlelight': return sat([r * 1.08 + 18 * (1 - t), g * 0.94 + 4, b * 0.68], 0.92).map((v) => v * (0.85 + 0.15 * t));
    case 'fallColors': return sat([r * 1.06 + 8 * hi, g * 0.97 + 6 * hi, b * 0.78], 1.15);
    case 'lateSunset': return [r * 1.05 + 20 * hi + 10 * sh, g * 0.93 + 8 * hi, b * 0.85 + 22 * sh];
    case 'edgyAmber': return sat([con(r * 1.05 + 14, 1.2), con(g * 0.97 + 6, 1.2), con(b * 0.7, 1.2)], 0.85);
    case 'dropBlues': {
      // blues lose their colour, everything else stays
      const [hh, s] = hueSat01(r, g, b);
      const w = Math.max(0, 1 - Math.abs(hh * 360 - 220) / 50) * s;
      return [r + (L - r) * w, g + (L - g) * w, b + (L - b) * w];
    }
    case 'foggyNight': return [sc(r, 40, 190) * 0.95, sc(g, 45, 200), sc(b, 60, 220)].map((v) => L * 0.35 + v * 0.65);
    case 'moonlight': return sat([r * 0.62, g * 0.75 + 4, b * 0.95 + 18].map((v) => v * 0.8), 0.55);
    case 'nightFromDay': return sat([r * 0.35, g * 0.45 + 2, b * 0.7 + 12].map((v) => con(v, 1.15)), 0.5);
    case 'horrorBlue': return sat([con(r * 0.75, 1.3), con(g * 0.95 + 4, 1.3), con(b * 1.1 + 18, 1.3)], 0.6);
    case 'tensionGreen': return sat([con(r * 0.86, 1.15), con(g * 1.04 + 10, 1.15), con(b * 0.84, 1.15)], 0.8);
    case 'strip2': {
      // two-strip Technicolor: red-orange and cyan-green only
      const rc = r * 0.95 + g * 0.05;
      const gc = g * 0.5 + b * 0.5;
      return [rc, gc, gc * 0.9 + rc * 0.1];
    }
    case 'strip3': return sat([con(r, 1.15), con(g, 1.1), con(b, 1.1)], 1.35);
    case 'filmstock': return [sc(r, 12, 248), sc(g, 10, 240), sc(b, 14, 232)].map((v) => con(v, 1.06));
    default: return [r, g, b];
  }
}
function hueSat01(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return [0, 0];
  const dd = mx - mn;
  let hh = mx === r ? (g - b) / dd : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  hh = ((hh / 6) % 1 + 1) % 1;
  return [hh, dd / 255];
}

/** A float Gaussian-like blur (three box passes) of a w×h array. */
function gaussFloat(a, w, h, sigma) {
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 1) - 0.5));
  let cur = a;
  const t = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(a.length);
    const k = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = cur[row] * (r + 1);
      for (let x = 1; x <= r; x++) s += cur[row + Math.min(w - 1, x)];
      for (let x = 0; x < w; x++) {
        t[row + x] = s * k;
        s += cur[row + Math.min(w - 1, x + r + 1)] - cur[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = t[x] * (r + 1);
      for (let y = 1; y <= r; y++) s += t[Math.min(h - 1, y) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s * k;
        s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
    cur = out;
  }
  return cur;
}

/** Luminance of an ImageData blurred by `radius` (a smaller copy for big radii). */
function blurredLum(img, radius) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  if (radius < 0.5) {
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    return L;
  }
  const f = Math.max(1, Math.min(32, Math.floor(radius / 4)));
  const sw = Math.max(1, Math.ceil(w / f));
  const sh = Math.max(1, Math.ceil(h / f));
  const S = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / f) * sw;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const j = sy + Math.floor(x / f);
      S[j] += lum(d[o], d[o + 1], d[o + 2]);
      cnt[j]++;
    }
  }
  for (let i = 0; i < S.length; i++) S[i] /= cnt[i] || 1;
  const B = gaussFloat(S, sw, sh, radius / f);
  if (f === 1) return B;
  // bilinear back up to full size
  const L = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / f - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / f - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = B[y0 * sw + x0] + (B[y0 * sw + x1] - B[y0 * sw + x0]) * tx;
      const b = B[y1 * sw + x0] + (B[y1 * sw + x1] - B[y1 * sw + x0]) * tx;
      L[y * w + x] = a + (b - a) * ty;
    }
  }
  return L;
}

/** Apply an adjustment to ImageData in place. */
export function applyAdjustment(img, type, p) {
  // adjustments registered by other modules bring their own code
  if (ADJUSTMENTS[type]?.fn) {
    ADJUSTMENTS[type].fn(img, p);
    return img;
  }
  const d = img.data;
  const n = d.length;
  const lut3 = (lr, lg = lr, lb = lr) => {
    for (let i = 0; i < n; i += 4) {
      d[i] = lr[d[i]];
      d[i + 1] = lg[d[i + 1]];
      d[i + 2] = lb[d[i + 2]];
    }
  };
  switch (type) {
    case 'brightness': lut3(brightnessLut(p)); break;
    case 'levels': {
      const master = levelsLut([p.inBlack, p.gamma, p.inWhite, p.outBlack, p.outWhite]);
      const ch = p.channels || {};
      const luts = ['r', 'g', 'b'].map((c) => {
        const own = Array.isArray(ch[c]) ? levelsLut(ch[c]) : null;
        const out = new Float32Array(256);
        for (let i = 0; i < 256; i++) out[i] = master[own ? clamp(Math.round(own[i]), 0, 255) : i];
        return out;
      });
      lut3(...luts);
      break;
    }
    case 'curves': {
      const master = curveLut(p.points);
      const luts = ['r', 'g', 'b'].map((c) => {
        const own = Array.isArray(p[c]) && p[c].length >= 2 ? curveLut(p[c]) : null;
        const out = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i++) out[i] = master[own ? own[i] : i];
        return out;
      });
      lut3(...luts);
      break;
    }
    case 'exposure': {
      // in linear light, like Photoshop: exposure in stops, offset darkens or lifts the shadows, gamma
      const lut = new Float32Array(256);
      const k = 2 ** (+p.exposure || 0);
      const off = +p.offset || 0;
      const ig = 1 / clamp(+p.gamma || 1, 0.01, 10);
      for (let i = 0; i < 256; i++) lut[i] = toSrgb(Math.max(0, TO_LIN[i] * k + off) ** ig);
      lut3(lut);
      break;
    }
    case 'posterize': {
      const L = clamp(Math.round(+p.levels || 2), 2, 255);
      const lut = new Float32Array(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.round((Math.min(L - 1, Math.floor((i * L) / 256)) * 255) / (L - 1));
      lut3(lut);
      break;
    }
    case 'invert': {
      const lut = new Float32Array(256).map((_, i) => 255 - i);
      lut3(lut);
      break;
    }
    case 'threshold':
      for (let i = 0; i < n; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]) >= p.level ? 255 : 0;
      break;
    case 'vibrance': {
      const vib = p.vibrance / 100;
      const sat = p.saturation / 100;
      for (let i = 0; i < n; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const l = lum(r, g, b);
        const mx = Math.max(r, g, b);
        const amt = (mx - Math.min(r, g, b)) / 255;
        // vibrance spares already strong colours and skin tones (reddish-orange) a little
        const skin = r > g && g > b ? 0.5 + 0.5 * Math.min(1, Math.abs((g - b) / Math.max(1, r - b) - 0.45) * 3) : 1;
        const k = 1 + sat + vib * (1 - amt) * (vib > 0 ? skin : 1);
        d[i] = cl(l + (r - l) * k);
        d[i + 1] = cl(l + (g - l) * k);
        d[i + 2] = cl(l + (b - l) * k);
      }
      break;
    }
    case 'hueSat': hueSat(d, p); break;
    case 'colorBalance': colorBalance(d, p); break;
    case 'bw': blackWhite(d, p); break;
    case 'photoFilter': {
      const [fr, fg, fb] = hexRgb(p.color);
      const a = p.density / 100;
      for (let i = 0; i < n; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        let nr = r * (1 - a) + ((r * fr) / 255) * a + (fr - r) * a * 0.35;
        let ng = g * (1 - a) + ((g * fg) / 255) * a + (fg - g) * a * 0.35;
        let nb = b * (1 - a) + ((b * fb) / 255) * a + (fb - b) * a * 0.35;
        if (p.preserve) {
          const dl = lum(r, g, b) - lum(nr, ng, nb);
          nr += dl;
          ng += dl;
          nb += dl;
        }
        d[i] = cl(nr);
        d[i + 1] = cl(ng);
        d[i + 2] = cl(nb);
      }
      break;
    }
    case 'gradientMap': {
      const gr = p.gradient?.stops?.length ? p.gradient : { stops: [{ pos: 0, color: p.from || '#000000' }, { pos: 1, color: p.to || '#ffffff' }] };
      const lut = gradientLut(gr, { fg: p._fg || '#000000', bg: p._bg || '#ffffff', reverse: !!p.reverse });
      const w = img.width;
      for (let i = 0, px = 0; i < n; i += 4, px++) {
        let v = lum(d[i], d[i + 1], d[i + 2]);
        if (p.dither) v += BAYER[((((px / w) | 0) & 3) << 2) | (px % w & 3)];
        const k = clamp(Math.round(v), 0, 255) * 4;
        d[i] = lut[k];
        d[i + 1] = lut[k + 1];
        d[i + 2] = lut[k + 2];
      }
      break;
    }
    case 'desaturate':
      for (let i = 0; i < n; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = (mx + mn) / 2;
      }
      break;
    case 'channelMixer': channelMixer(d, p); break;
    case 'selectiveColor': selectiveColor(d, p); break;
    case 'colorLookup': colorLookup(d, p); break;
    case 'shadowsHighlights': shadowsHighlights(img, p); break;
    case 'replaceColor': replaceColor(d, p); break;
    case 'equalize': equalize(d); break;
    default:
  }
  return img;
}

function hueSat(d, p) {
  const n = d.length;
  const ranges = p.ranges || {};
  const act = HUE_RANGES.map(([id, , def]) => {
    const r = ranges[id];
    return r && (r.h || r.s || r.l) ? { h: +r.h || 0, s: +r.s || 0, l: +r.l || 0, b: Array.isArray(r.r) && r.r.length === 4 ? r.r : def } : null;
  }).filter(Boolean);
  const colorize = !!p.colorize;
  const H0 = +p.hue || 0;
  const S0 = +p.saturation || 0;
  const L0 = +p.lightness || 0;
  // worked out once (this loop runs for every pixel of a big photo): hues in turns (0…1)
  const ss0 = clamp(S0, -100, 100) / 100;
  const ls0 = clamp(L0, -100, 100) / 100;
  const cHue = (((H0 % 360) + 360) % 360) / 360;
  const cSat = clamp(S0, 0, 100) / 100;
  const shift = cHue;
  const T = 1 / 3;
  for (let i = 0; i < n; i += 4) {
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    let l = (max + min) / 2;
    const dd = max - min;
    let s = dd ? (l > 0.5 ? dd / (2 - max - min) : dd / (max + min)) : 0;
    let h1 = 0;
    if (dd) h1 = (max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4) / 6;
    let dh = 0;
    let ss = ss0;
    let ls = ls0;
    if (act.length && dd > 0.004) {
      // colour ranges only touch coloured pixels (a grey has no hue)
      const cw = Math.min(1, dd / 0.08);
      let ds = S0;
      let dl = L0;
      for (const a of act) {
        const w = rangeWeight(h1 * 360, a.b) * cw;
        if (!w) continue;
        dh += a.h * w;
        ds += a.s * w;
        dl += a.l * w;
      }
      ss = clamp(ds, -100, 100) / 100;
      ls = clamp(dl, -100, 100) / 100;
    }
    let hh;
    if (colorize) {
      hh = cHue;
      s = cSat;
    } else {
      hh = h1 + shift;
      if (dh) hh = (((hh + dh / 360) % 1) + 1) % 1;
      else if (hh >= 1) hh -= 1;
      s = ss >= 0 ? s + (1 - s) * ss * s * 1.5 + s * ss * 0.5 : s * (1 + ss);
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    }
    l = ls >= 0 ? l + (1 - l) * ls : l * (1 + ls);
    if (s <= 0) {
      d[i] = d[i + 1] = d[i + 2] = l * 255;
      continue;
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const pp = 2 * l - q;
    const k6 = (q - pp) * 6;
    // hue2 for the three channels, written out
    let t = hh + T;
    if (t > 1) t -= 1;
    d[i] = (t < 1 / 6 ? pp + k6 * t : t < 0.5 ? q : t < 2 / 3 ? pp + k6 * (2 / 3 - t) : pp) * 255;
    t = hh;
    d[i + 1] = (t < 1 / 6 ? pp + k6 * t : t < 0.5 ? q : t < 2 / 3 ? pp + k6 * (2 / 3 - t) : pp) * 255;
    t = hh - T;
    if (t < 0) t += 1;
    d[i + 2] = (t < 1 / 6 ? pp + k6 * t : t < 0.5 ? q : t < 2 / 3 ? pp + k6 * (2 / 3 - t) : pp) * 255;
  }
}

function colorBalance(d, p) {
  // GIMP's take on Photoshop's colour balance: three overlapping tone masks on the pixel lightness
  const tri = (v) => (Array.isArray(v) ? v.map((x) => (+x || 0) / 100) : [0, 0, 0]);
  const S = tri(p.shadows);
  const M = [(+p.cr || 0) / 100, (+p.mg || 0) / 100, (+p.yb || 0) / 100];
  const Hh = tri(p.highlights);
  const A = 0.25;
  const B = 0.333;
  const SC = 0.7;
  const shift = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let li = 0; li < 256; li++) {
    const l = li / 255;
    const ws = clamp((l - B) / -A + 0.5, 0, 1) * SC;
    const wm = clamp((l - B) / A + 0.5, 0, 1) * clamp((l + B - 1) / -A + 0.5, 0, 1) * SC;
    const wh = clamp((l + B - 1) / A + 0.5, 0, 1) * SC;
    for (let c = 0; c < 3; c++) shift[c][li] = (S[c] * ws + M[c] * wm + Hh[c] * wh) * 255;
  }
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const li = (mx + mn) >> 1;
    let nr = cl(r + shift[0][li]);
    let ng = cl(g + shift[1][li]);
    let nb = cl(b + shift[2][li]);
    if (p.preserve) {
      // keep the HSL lightness of the pixel
      const [h, s] = rgbToHsl(nr, ng, nb);
      [nr, ng, nb] = hslToRgb(h, s, (mx + mn) / 510);
    }
    d[i] = nr;
    d[i + 1] = ng;
    d[i + 2] = nb;
  }
}

function blackWhite(d, p) {
  // grey = min + (mid − min)·secondary weight + (max − mid)·primary weight
  // (primary: the strongest channel's colour; secondary: the colour mixing the two strongest)
  const wR = p.reds / 100;
  const wG = p.greens / 100;
  const wB = p.blues / 100;
  const wY = p.yellows / 100;
  const wC = p.cyans / 100;
  const wM = p.magentas / 100;
  const tint = p.tint ? hslToRgb((((+p.tintHue || 0) % 360) + 360) % 360 / 360, clamp(+p.tintSat || 0, 0, 100) / 100, 0.5) : null;
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    let v;
    if (r >= g && r >= b) {
      // red strongest: secondary yellow (r+g) or magenta (r+b)
      v = g >= b ? b + (g - b) * wY + (r - g) * wR : g + (b - g) * wM + (r - b) * wR;
    } else if (g >= r && g >= b) {
      v = r >= b ? b + (r - b) * wY + (g - r) * wG : r + (b - r) * wC + (g - b) * wG;
    } else {
      v = r >= g ? g + (r - g) * wM + (b - r) * wB : r + (g - r) * wC + (b - g) * wB;
    }
    v = cl(v);
    if (tint) {
      // a colour layer over the grey: the tint shows most in the midtones
      const t = v / 255;
      const k = 4 * t * (1 - t);
      d[i] = cl(v + (tint[0] - 127.5) * k * 2 * 0.5);
      d[i + 1] = cl(v + (tint[1] - 127.5) * k * 2 * 0.5);
      d[i + 2] = cl(v + (tint[2] - 127.5) * k * 2 * 0.5);
    } else d[i] = d[i + 1] = d[i + 2] = v;
  }
}

function channelMixer(d, p) {
  const k = (x, fb) => ((x ?? fb ?? 0) * 255) / 100;
  const ck = (+p.constant || 0) * 2.55;
  const rk = p.rk != null && p.rk !== 0 ? k(p.rk) : ck;
  const gk = p.gk != null && p.gk !== 0 ? k(p.gk) : ck;
  const bk = p.bk != null && p.bk !== 0 ? k(p.bk) : ck;
  const n = d.length;
  if (p.mono) {
    // grey output: its own weights (older documents used the red output row)
    const mr = (p.mr ?? p.rr) / 100;
    const mg = (p.mg ?? p.rg) / 100;
    const mb = (p.mb ?? p.rb) / 100;
    const mk2 = p.mk != null ? k(p.mk) : ck;
    for (let i = 0; i < n; i += 4) d[i] = d[i + 1] = d[i + 2] = cl(d[i] * mr + d[i + 1] * mg + d[i + 2] * mb + mk2);
    return;
  }
  for (let i = 0; i < n; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    d[i] = cl((r * p.rr + g * p.rg + b * p.rb) / 100 + rk);
    d[i + 1] = cl((r * p.gr + g * p.gg + b * p.gb) / 100 + gk);
    d[i + 2] = cl((r * p.br + g * p.bg + b * p.bb) / 100 + bk);
  }
}

function selectiveColor(d, p) {
  // every colour has its own CMYK values; older documents kept only the shown one
  const colors = p.colors && typeof p.colors === 'object' ? p.colors : { [p.target || 'reds']: [p.cyan, p.magenta, p.yellow, p.black] };
  const act = {};
  let any = false;
  for (const [id] of SELECTIVE_TARGETS) {
    const v = colors[id];
    if (Array.isArray(v) && v.some((x) => +x)) {
      act[id] = v.map((x) => (+x || 0) / 100);
      any = true;
    }
  }
  if (!any) return;
  const abs = !!p.absolute;
  const n = d.length;
  const PRIMARY = ['reds', 'greens', 'blues'];
  for (let i = 0; i < n; i += 4) {
    const v = [d[i], d[i + 1], d[i + 2]];
    // the channel order of this pixel
    let a = 0;
    let b = 1;
    let c = 2;
    if (v[b] > v[a]) [a, b] = [b, a];
    if (v[c] > v[a]) [a, c] = [c, a];
    if (v[c] > v[b]) [b, c] = [c, b];
    const mx = v[a];
    const md = v[b];
    const mn = v[c];
    const w = {};
    w[PRIMARY[a]] = (mx - md) / 255;
    // the secondary colour of the two strongest channels: r+g yellow, g+b cyan, r+b magenta
    const pair = a + b;
    w[pair === 1 ? 'yellows' : pair === 3 ? 'cyans' : 'magentas'] = (md - mn) / 255;
    w.whites = mn > 127.5 ? (mn - 127.5) / 127.5 : 0;
    w.blacks = mx < 127.5 ? (127.5 - mx) / 127.5 : 0;
    w.neutrals = 1 - (Math.abs(mx - 127.5) + Math.abs(mn - 127.5)) / 255;
    const out = [v[0], v[1], v[2]];
    for (const id in act) {
      const wt = w[id];
      if (!wt || wt <= 0) continue;
      const [cc, mm, yy, kk] = act[id];
      for (let ch = 0; ch < 3; ch++) {
        const amt = ch === 0 ? cc : ch === 1 ? mm : yy;
        // CMY ink: more ink = less light; black adds ink to every channel
        const ink = 1 - v[ch] / 255;
        const dInk = abs ? amt + kk : amt * ink + kk * ink;
        out[ch] -= dInk * 255 * wt;
      }
    }
    d[i] = cl(out[0]);
    d[i + 1] = cl(out[1]);
    d[i + 2] = cl(out[2]);
  }
}

function colorLookup(d, p) {
  const a = (p.amount ?? 100) / 100;
  const n = d.length;
  const L = p.look === 'file' ? decodeLut(p.lut) : null;
  if (p.look === 'file' && !L) return;
  if (L) {
    const N = L.size;
    const T = L.a;
    const s = (N - 1) / 255;
    for (let i = 0; i < n; i += 4) {
      const r = d[i] * s;
      const g = d[i + 1] * s;
      const b = d[i + 2] * s;
      const r0 = Math.min(N - 2, r | 0);
      const g0 = Math.min(N - 2, g | 0);
      const b0 = Math.min(N - 2, b | 0);
      const fr = r - r0;
      const fg = g - g0;
      const fb = b - b0;
      for (let c = 0; c < 3; c++) {
        // trilinear interpolation; the table is red-fastest (.cube order)
        const at = (ri, gi, bi) => T[((bi * N + gi) * N + ri) * 3 + c];
        const c00 = at(r0, g0, b0) * (1 - fr) + at(r0 + 1, g0, b0) * fr;
        const c10 = at(r0, g0 + 1, b0) * (1 - fr) + at(r0 + 1, g0 + 1, b0) * fr;
        const c01 = at(r0, g0, b0 + 1) * (1 - fr) + at(r0 + 1, g0, b0 + 1) * fr;
        const c11 = at(r0, g0 + 1, b0 + 1) * (1 - fr) + at(r0 + 1, g0 + 1, b0 + 1) * fr;
        const v = ((c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb) * 255;
        d[i + c] = cl(d[i + c] + (v - d[i + c]) * a);
      }
    }
    return;
  }
  for (let i = 0; i < n; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const o = lookPixel(p.look, r, g, b);
    d[i] = cl(r + (o[0] - r) * a);
    d[i + 1] = cl(g + (o[1] - g) * a);
    d[i + 2] = cl(b + (o[2] - b) * a);
  }
}

function shadowsHighlights(img, p) {
  const { width: w, height: h, data: d } = img;
  const N = w * h;
  const sAmt = (+p.shadows || 0) / 100;
  const hAmt = (+p.highlights || 0) / 100;
  // tone: how far up (shadows) or down (highlights) the tonal range the correction reaches
  const sw = 0.12 + 0.88 * ((p.sTone ?? 50) / 100);
  const hw = 0.12 + 0.88 * ((p.hTone ?? 50) / 100);
  const Bs = sAmt ? blurredLum(img, p.radius ?? 30) : null;
  const Bh = hAmt ? (p.hRadius ?? p.radius ?? 30) === (p.radius ?? 30) && Bs ? Bs : blurredLum(img, p.hRadius ?? p.radius ?? 30) : null;
  const colorK = (p.color ?? 20) / 100;
  const mid = (p.midtone || 0) / 100;
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = lum(r, g, b) / 255;
    let ratio = 1;
    if (Bs) {
      const B = Bs[i] / 255;
      const ws = 1 - smooth(0, sw, B);
      if (ws > 0) {
        const nb = B ** (1 / (1 + 2.2 * sAmt * ws));
        ratio *= nb / Math.max(0.02, B);
      }
    }
    if (Bh) {
      const B = Bh[i] / 255;
      const wh = smooth(1 - hw, 1, B);
      if (wh > 0) {
        const nb = 1 - (1 - B) ** (1 / (1 + 2.2 * hAmt * wh));
        ratio *= Math.max(0.05, 1 - (nb - B) / Math.max(0.05, 1 - B) * 0.6 * B) * Math.min(1, (1 - nb * 0.0) / 1);
        ratio *= 1 - hAmt * wh * 0.35;
      }
    }
    // keep the lift from blowing the pixel out: a soft limit near white
    let nL = L * ratio;
    if (nL > 0.9) nL = 0.9 + 0.1 * (1 - Math.exp(-(nL - 0.9) / 0.1));
    if (mid) {
      const t = nL;
      nL = clamp(t + mid * (t - 0.5) * 4 * t * (1 - t), 0, 1);
    }
    const k = L > 0.002 ? nL / L : 1;
    const sk = 1 + colorK * (k - 1) * (k > 1 ? 0.5 : 1);
    const nl255 = nL * 255;
    out[i * 3] = nl255 + (r * k - nl255) * sk;
    out[i * 3 + 1] = nl255 + (g * k - nl255) * sk;
    out[i * 3 + 2] = nl255 + (b * k - nl255) * sk;
    if (L <= 0.002) {
      out[i * 3] = r + nL * 255 - L * 255;
      out[i * 3 + 1] = g + nL * 255 - L * 255;
      out[i * 3 + 2] = b + nL * 255 - L * 255;
    }
  }
  // black and white clipping: stretch so that the given share of pixels clips
  let lo = 0;
  let hi = 255;
  const bc = (p.blackClip ?? 0.01) / 100;
  const wc = (p.whiteClip ?? 0.01) / 100;
  if (bc > 0 || wc > 0) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) hist[clamp(Math.round(lum(out[i * 3], out[i * 3 + 1], out[i * 3 + 2])), 0, 255)]++;
    let acc = 0;
    for (lo = 0; lo < 255 && acc + hist[lo] <= N * bc; lo++) acc += hist[lo];
    acc = 0;
    for (hi = 255; hi > 0 && acc + hist[hi] <= N * wc; hi--) acc += hist[hi];
    if (hi - lo < 16) {
      lo = 0;
      hi = 255;
    }
  }
  const sc = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    d[o] = cl((out[i * 3] - lo) * sc);
    d[o + 1] = cl((out[i * 3 + 1] - lo) * sc);
    d[o + 2] = cl((out[i * 3 + 2] - lo) * sc);
  }
}

/** How much a pixel belongs to Replace Color's selection: near its colours, not near the taken-out ones. */
export function replaceWeight(p) {
  const ins = [p.color, ...(Array.isArray(p.add) ? p.add : [])].map(hexRgb);
  const outs = (Array.isArray(p.sub) ? p.sub : []).map(hexRgb);
  const a = p.fuzz * 0.5;
  const b = p.fuzz * 1.2;
  const near = (cols, r, g, bl) => {
    let w = 0;
    for (const [cr, cg, cb] of cols) w = Math.max(w, 1 - smooth(a, b, Math.hypot(r - cr, g - cg, bl - cb)));
    return w;
  };
  return (r, g, bl) => near(ins, r, g, bl) * (outs.length ? 1 - near(outs, r, g, bl) : 1);
}

function replaceColor(d, p) {
  const weight = replaceWeight(p);
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    const w = weight(d[i], d[i + 1], d[i + 2]);
    if (w <= 0) continue;
    let [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    hh = (((hh * 360 + p.hue) % 360) + 360) % 360 / 360;
    s = clamp(s * (1 + p.saturation / 100), 0, 1);
    l = clamp(l + (p.lightness / 100) * (p.lightness > 0 ? 1 - l : l), 0, 1);
    const rgb = hslToRgb(hh, s, l);
    for (let c = 0; c < 3; c++) d[i + c] += (rgb[c] - d[i + c]) * w;
  }
}

function equalize(d) {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    hist[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
    n++;
  }
  if (!n) return;
  const lut = new Float64Array(256);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    lut[v] = (acc / n) * 255;
  }
  for (let i = 0; i < d.length; i += 4) {
    const L = lum(d[i], d[i + 1], d[i + 2]);
    const k = L > 0.5 ? lut[Math.round(L)] / L : 1;
    for (let c = 0; c < 3; c++) d[i + c] = cl(d[i + c] * k);
  }
}

// ---------------------------------------------------------------- filters

function convolve(img, kernel, divisor = 1, offset = 0) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const k = Math.sqrt(kernel.length) | 0;
  const half = k >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < k; j++) {
        const yy = Math.min(h - 1, Math.max(0, y + j - half));
        for (let i = 0; i < k; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i - half));
          const o = (yy * w + xx) * 4;
          const kv = kernel[j * k + i];
          r += src[o] * kv;
          g += src[o + 1] * kv;
          b += src[o + 2] * kv;
        }
      }
      const o = (y * w + x) * 4;
      d[o] = r / divisor + offset;
      d[o + 1] = g / divisor + offset;
      d[o + 2] = b / divisor + offset;
    }
  }
}

/** Pixel filter helper: fn(ImageData) changes it in place; returns a new canvas. */
const pixels = (c, fn) => {
  const img = read(c);
  fn(img);
  return toCanvas(img);
};

/** An opaque picture stays opaque after a blur that pulls in pixels from outside (spin, zoom). */
function keepOpaque(src, out) {
  const d = read(src).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return out;
  const c = mk(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.drawImage(out, 0, 0);
  return c;
}

/**
 * Average of copies of `c` moved by transforms t(k) for k = ±1 at each of `passes` halvings: the
 * comb of copies fills the whole range evenly (2^passes copies) with only `passes` draws, on the GPU.
 * xf(g, s, w, h) sets the canvas transform for the signed fraction s of the full range.
 */
function doublingBlur(c, passes, xf, pad = 0) {
  const { canvas: big, pad: p } = mirrorPad(c, pad);
  let cur = big;
  for (let j = 1; j <= passes; j++) {
    const s = 1 / 2 ** j;
    const next = mk(cur.width, cur.height);
    const g = next.getContext('2d');
    g.imageSmoothingQuality = 'high';
    for (const [sign, alpha] of [[1, 1], [-1, 0.5]]) {
      g.save();
      g.globalAlpha = alpha;
      xf(g, sign * s, cur.width, cur.height);
      g.drawImage(cur, 0, 0);
      g.restore();
    }
    cur = next;
  }
  if (!p) return cur;
  const out = mk(c.width, c.height);
  out.getContext('2d').drawImage(cur, -p, -p);
  return out;
}

function motionBlur(c, p) {
  const dist = clamp(+p.distance || 0, 0, 2000);
  if (dist < 1) return c;
  const a = ((+p.angle || 0) * Math.PI) / 180;
  const dx = Math.cos(a) * dist;
  const dy = -Math.sin(a) * dist;
  const passes = Math.max(1, Math.ceil(Math.log2(dist)) + 1);
  return doublingBlur(c, passes, (g, s) => g.translate((dx * s) / 2, (dy * s) / 2), dist / 2 + 2);
}

function radialBlur(c, p) {
  const w = c.width;
  const h = c.height;
  const cx = (w * (p.x ?? 50)) / 100;
  const cy = (h * (p.y ?? 50)) / 100;
  const R = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const amt = clamp(+p.amount || 0, 0, 100) / 100;
  const quality = p.quality === 'draft' ? -2 : p.quality === 'good' ? -1 : 0;
  if (p.method === 'spin') {
    // spin: up to ±(amount × 0.9°)·… like Photoshop (100 ≈ a 90° arc)
    const ang = amt * (Math.PI / 2);
    const passes = clamp(Math.ceil(Math.log2(Math.max(2, R * ang))) + 1 + quality, 2, 14);
    const pad = Math.min(w, h);
    return keepOpaque(c, doublingBlur(c, passes, (g, s, W, H) => {
      g.translate(cx + (W - w) / 2, cy + (H - h) / 2);
      g.rotate((ang * s) / 2);
      g.translate(-(cx + (W - w) / 2), -(cy + (H - h) / 2));
    }, pad));
  }
  // zoom: copies scaled about the centre between 1 and 1 + amount
  const span = Math.log(1 + amt * 0.6);
  const passes = clamp(Math.ceil(Math.log2(Math.max(2, R * span))) + 1 + quality, 2, 14);
  const out = doublingBlur(c, passes, (g, s, W, H) => {
    const k = Math.exp((span * (s + 0.5)) / 2);
    const ox = cx + (W - w) / 2;
    const oy = cy + (H - h) / 2;
    g.translate(ox, oy);
    g.scale(k, k);
    g.translate(-ox, -oy);
  }, 0);
  return keepOpaque(c, out);
}

function ellipseWarp(c, p, fn) {
  // the effect area is the largest ellipse in the layer (Photoshop: the selection's)
  const w = c.width;
  const h = c.height;
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  return remapCanvas(c, (x, y, o) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    const r = Math.hypot(dx, dy);
    if (r >= 1 || r === 0) {
      o[0] = x;
      o[1] = y;
      return;
    }
    const k = fn(r, dx, dy);
    o[0] = cx + dx * (p.mode === 'vertical' ? 1 : k) * rx;
    o[1] = cy + dy * (p.mode === 'horizontal' ? 1 : k) * ry;
  });
}

/** Canvas → canvas remap with bilinear sampling (pixel centres). */
function remapCanvas(c, map) {
  const src = read(c);
  const { width: w, height: h } = src;
  const out = new ImageData(w, h);
  const s = sampler(src.data, w, h);
  const q = [0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      map(x + 0.5, y + 0.5, q);
      s(q[0] - 0.5, q[1] - 0.5, out.data, (y * w + x) * 4);
    }
  }
  return toCanvas(out);
}

/** Smooth value noise in 0..1 at `scale` pixels, `octaves` of it (Clouds). */
function cloudNoise(w, h, scale, seed, octaves = 6) {
  const r = rng(seed);
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  let s = Math.max(2, scale);
  for (let o = 0; o < octaves && s >= 1; o++) {
    const gw = Math.ceil(w / s) + 2;
    const gh = Math.ceil(h / s) + 2;
    const v = new Float32Array(gw * gh);
    for (let i = 0; i < v.length; i++) v[i] = r();
    for (let y = 0; y < h; y++) {
      const fy = y / s;
      const y0 = fy | 0;
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++) {
        const fx = x / s;
        const x0 = fx | 0;
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const i = y0 * gw + x0;
        const a = v[i] + (v[i + 1] - v[i]) * sx;
        const b = v[i + gw] + (v[i + gw + 1] - v[i + gw]) * sx;
        out[y * w + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
    s /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  // stretch to the full range like Photoshop's clouds
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

const UNDEF = [['wrap', '둘러싸기'], ['repeat', '가장자리 픽셀 반복']];

export const FILTERS = {
  gaussian: {
    name: '가우시안 흐림 효과', group: '흐림 효과', params: [['radius', '반경 (픽셀)', 0.1, 1000, 5, 0.1]],
    fn: (c, p) => blurred(c, +p.radius || 0),
  },
  motion: {
    name: '동작 흐림 효과', group: '흐림 효과', params: [['angle', '각도 (°)', -360, 360, 0], ['distance', '거리 (픽셀)', 1, 2000, 20]],
    fn: motionBlur,
  },
  radial: {
    name: '방사형 흐림 효과', group: '흐림 효과',
    params: [['amount', '양', 1, 100, 10], ['method', '흐림 효과 방법', null, null, 'zoom', [['spin', '돌기'], ['zoom', '돋보기']]], ['quality', '품질', null, null, 'good', [['draft', '초안'], ['good', '좋음'], ['best', '최상']]], ['x', '흐림 효과 중심: 가로 (%)', 0, 100, 50], ['y', '흐림 효과 중심: 세로 (%)', 0, 100, 50]],
    fn: radialBlur,
  },
  unsharp: {
    name: '언샵 마스크', group: '선명 효과', params: [['amount', '양 (%)', 1, 500, 80], ['radius', '반경 (픽셀)', 0.1, 1000, 1.5, 0.1], ['threshold', '한계값 (레벨)', 0, 255, 0]],
    fn(c, p) {
      const bd = read(blurred(c, +p.radius || 0.1)).data;
      const amt = p.amount / 100;
      return pixels(c, (img) => {
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            const diff = d[i + k] - bd[i + k];
            if (Math.abs(diff) >= p.threshold) d[i + k] = cl(d[i + k] + diff * amt);
          }
        }
      });
    },
  },
  sharpen: {
    name: '선명하게', group: '선명 효과', params: [],
    fn: (c) => pixels(c, (img) => convolve(img, [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0])),
  },
  noise: {
    name: '노이즈 추가', group: '노이즈',
    params: [['amount', '양 (%)', 0.1, 400, 12.5, 0.1], ['dist', '분포', null, null, 'uniform', [['uniform', '균일'], ['gaussian', '가우시안']]], ['mono', '단색', null, null, true, 'bool'], ['seed', '무작위 값', null, null, 1, 'hidden']],
    fn(c, p) {
      const a = (p.amount / 100) * 255;
      const r = rng(p.seed || 1);
      const gauss = p.dist === 'gaussian';
      const rnd = gauss ? () => (r() + r() + r() - 1.5) * 0.9 : () => r() - 0.5;
      return pixels(c, (img) => {
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          if (p.mono) {
            const n = rnd() * a;
            d[i] = cl(d[i] + n);
            d[i + 1] = cl(d[i + 1] + n);
            d[i + 2] = cl(d[i + 2] + n);
          } else {
            d[i] = cl(d[i] + rnd() * a);
            d[i + 1] = cl(d[i + 1] + rnd() * a);
            d[i + 2] = cl(d[i + 2] + rnd() * a);
          }
        }
      });
    },
  },
  median: {
    name: '중간값', group: '노이즈', slow: true, params: [['radius', '반경 (픽셀)', 1, 100, 1]],
    fn: (c, p) => pixels(c, (img) => img.data.set(medianData(img.data, img.width, img.height, clamp(Math.round(p.radius), 1, 100)))),
  },
  mosaic: {
    name: '모자이크', group: '픽셀화', params: [['size', '셀 크기 (정사각형)', 2, 200, 16]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const s = Math.max(2, Math.round(p.size));
      const img = read(c);
      const d = img.data;
      // each cell takes the (alpha-weighted) average colour of its pixels
      for (let y0 = 0; y0 < h; y0 += s) {
        for (let x0 = 0; x0 < w; x0 += s) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          const x1 = Math.min(w, x0 + s);
          const y1 = Math.min(h, y0 + s);
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const o = (y * w + x) * 4;
              const al = d[o + 3];
              r += d[o] * al;
              g += d[o + 1] * al;
              b += d[o + 2] * al;
              a += al;
              n++;
            }
          }
          const ia = a ? 1 / a : 0;
          const A = a / n;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const o = (y * w + x) * 4;
              d[o] = r * ia;
              d[o + 1] = g * ia;
              d[o + 2] = b * ia;
              d[o + 3] = A;
            }
          }
        }
      }
      return toCanvas(img);
    },
  },
  emboss: {
    name: '엠보스', group: '스타일화', params: [['angle', '각도 (°)', -180, 180, 135], ['height', '높이 (픽셀)', 1, 100, 3], ['amount', '양 (%)', 1, 500, 100]],
    fn(c, p) {
      const src = read(c);
      const { width: w, height: h, data: s } = src;
      const a = ((p.angle ?? 135) * Math.PI) / 180;
      const hh = (p.height ?? 3) / 2;
      const ox = Math.cos(a) * hh;
      const oy = -Math.sin(a) * hh;
      const k = (p.amount ?? 100) / 100;
      const smp = sampler(s, w, h);
      const A = [0, 0, 0, 0];
      const B = [0, 0, 0, 0];
      const out = new ImageData(w, h);
      const o = out.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          smp(x + ox, y + oy, A, 0);
          smp(x - ox, y - oy, B, 0);
          const i = (y * w + x) * 4;
          // grey relief with the colour showing only along the edges, like Photoshop's
          for (let ch = 0; ch < 3; ch++) o[i + ch] = cl(128 + (A[ch] - B[ch]) * k);
          o[i + 3] = s[i + 3];
        }
      }
      return toCanvas(out);
    },
  },
  edges: {
    name: '가장자리 찾기', group: '스타일화', params: [],
    fn(c) {
      const src = read(c);
      const { width: w, height: h, data: s } = src;
      const out = new ImageData(w, h);
      const o = out.data;
      for (let y = 0; y < h; y++) {
        const ym = Math.max(0, y - 1) * w;
        const yc = y * w;
        const yp = Math.min(h - 1, y + 1) * w;
        for (let x = 0; x < w; x++) {
          const xm = Math.max(0, x - 1);
          const xp = Math.min(w - 1, x + 1);
          const i = (yc + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const v = (j) => s[j * 4 + ch];
            const gx = v(ym + xp) + 2 * v(yc + xp) + v(yp + xp) - v(ym + xm) - 2 * v(yc + xm) - v(yp + xm);
            const gy = v(yp + xm) + 2 * v(yp + x) + v(yp + xp) - v(ym + xm) - 2 * v(ym + x) - v(ym + xp);
            // coloured outlines on white
            o[i + ch] = 255 - Math.min(255, Math.hypot(gx, gy) * 0.5);
          }
          o[i + 3] = s[i + 3];
        }
      }
      return toCanvas(out);
    },
  },
  oil: {
    name: '유화', group: '스타일화', slow: true, params: [['radius', '붓 크기', 1, 6, 3], ['levels', '색 단계', 4, 40, 20]],
    fn(c, p) {
      // a simple version; fx4.js replaces it with Photoshop's settings
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const r = Math.round(p.radius || 3);
      const L = Math.round(p.levels || 20);
      const src = new Uint8ClampedArray(d);
      const cnt = new Int32Array(L);
      const sr = new Int32Array(L);
      const sg = new Int32Array(L);
      const sb = new Int32Array(L);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          cnt.fill(0);
          sr.fill(0);
          sg.fill(0);
          sb.fill(0);
          for (let j = -r; j <= r; j++) {
            const yy = Math.min(h - 1, Math.max(0, y + j));
            for (let i = -r; i <= r; i++) {
              const o = (yy * w + Math.min(w - 1, Math.max(0, x + i))) * 4;
              const li = Math.min(L - 1, ((lum(src[o], src[o + 1], src[o + 2]) * L) / 256) | 0);
              cnt[li]++;
              sr[li] += src[o];
              sg[li] += src[o + 1];
              sb[li] += src[o + 2];
            }
          }
          let best = 0;
          for (let k = 1; k < L; k++) if (cnt[k] > cnt[best]) best = k;
          const o = (y * w + x) * 4;
          d[o] = sr[best] / cnt[best];
          d[o + 1] = sg[best] / cnt[best];
          d[o + 2] = sb[best] / cnt[best];
        }
      }
      return toCanvas(img);
    },
  },
  twirl: {
    name: '돌리기', group: '왜곡', slow: true, params: [['angle', '각도 (°)', -999, 999, 50]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const cx = w / 2;
      const cy = h / 2;
      const rx = w / 2;
      const ry = h / 2;
      const ang = (p.angle * Math.PI) / 180;
      return remapCanvas(c, (x, y, o) => {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const r = Math.hypot(dx, dy);
        if (r >= 1) {
          o[0] = x;
          o[1] = y;
          return;
        }
        const t = ang * (1 - r) ** 2;
        o[0] = cx + (dx * Math.cos(t) - dy * Math.sin(t)) * rx;
        o[1] = cy + (dx * Math.sin(t) + dy * Math.cos(t)) * ry;
      });
    },
  },
  spherize: {
    name: '구형화', group: '왜곡', slow: true, params: [['amount', '양 (%)', -100, 100, 100], ['mode', '모드', null, null, 'normal', [['normal', '표준'], ['horizontal', '가로로만'], ['vertical', '세로로만']]]],
    fn(c, p) {
      const k = (p.amount || 0) / 100;
      // a bulge (positive) magnifies the middle, a dent (negative) shrinks it
      return ellipseWarp(c, p, (r) => (k >= 0 ? r ** (1 + k * 0.85) : r ** (1 / (1 - k * 0.85))) / r);
    },
  },
  pinch: {
    name: '핀치', group: '왜곡', slow: true, params: [['amount', '양 (%)', -100, 100, 50]],
    fn(c, p) {
      const k = -(p.amount || 0) / 100;
      return ellipseWarp(c, { mode: 'normal' }, (r) => {
        const nr = k >= 0 ? r ** (1 + k * 0.9) : r ** (1 / (1 - k * 0.9));
        // fade back to no change at the ellipse edge
        const t = smooth(0.6, 1, r);
        return (nr + (r - nr) * t) / r;
      });
    },
  },
  wave: {
    name: '파형', group: '왜곡', slow: true,
    params: [['generators', '생성자 수', 1, 999, 5], ['wlMin', '파장: 최소', 1, 998, 10], ['wlMax', '파장: 최대', 2, 999, 120], ['ampMin', '진폭: 최소', 1, 998, 5], ['ampMax', '진폭: 최대', 1, 999, 35], ['sx', '비율: 가로 (%)', 0, 100, 100], ['sy', '비율: 세로 (%)', 0, 100, 100],
      ['type', '유형', null, null, 'sine', [['sine', '사인파'], ['triangle', '삼각형'], ['square', '사각형']]], ['undef', '정의되지 않은 영역', null, null, 'repeat', UNDEF], ['seed', '임의화 (값을 바꾸면 다른 무늬)', 1, 999, 1]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      if (p.generators == null && p.amplitude != null) {
        // older documents: one simple wave
        return remapCanvas(c, (x, y, o) => {
          o[0] = x + Math.sin((y / p.wavelength) * Math.PI * 2) * p.amplitude;
          o[1] = y + Math.sin((x / p.wavelength) * Math.PI * 2) * p.amplitude * 0.5;
        });
      }
      const r = rng(p.seed || 1);
      const n = clamp(Math.round(p.generators || 1), 1, 999);
      const wl0 = Math.min(p.wlMin, p.wlMax);
      const wl1 = Math.max(p.wlMin, p.wlMax);
      const a0 = Math.min(p.ampMin, p.ampMax);
      const a1 = Math.max(p.ampMin, p.ampMax);
      const shape = p.type === 'triangle' ? (t) => 1 - 4 * Math.abs(((t / (2 * Math.PI) + 0.25) % 1) - 0.5) : p.type === 'square' ? (t) => (Math.sin(t) >= 0 ? 1 : -1) : Math.sin;
      const gens = Array.from({ length: Math.min(n, 64) }, () => ({
        wx: wl0 + r() * (wl1 - wl0), wy: wl0 + r() * (wl1 - wl0), ax: a0 + r() * (a1 - a0), ay: a0 + r() * (a1 - a0), px: r() * Math.PI * 2, py: r() * Math.PI * 2,
      }));
      const norm = 1 / Math.sqrt(gens.length);
      const kx = (p.sx ?? 100) / 100;
      const ky = (p.sy ?? 100) / 100;
      // the displacement of one row (x moves with y) and one column (y moves with x)
      const DX = new Float32Array(h);
      const DY = new Float32Array(w);
      for (let y = 0; y < h; y++) for (const g of gens) DX[y] += shape((y / g.wx) * Math.PI * 2 + g.px) * g.ax * norm * kx;
      for (let x = 0; x < w; x++) for (const g of gens) DY[x] += shape((x / g.wy) * Math.PI * 2 + g.py) * g.ay * norm * ky;
      const wrap = p.undef === 'wrap';
      return remapCanvas(c, (x, y, o) => {
        let sx = x + DX[Math.min(h - 1, y | 0)];
        let sy = y + DY[Math.min(w - 1, x | 0)];
        if (wrap) {
          sx = ((sx % w) + w) % w;
          sy = ((sy % h) + h) % h;
        }
        o[0] = sx;
        o[1] = sy;
      });
    },
  },
  vignette: {
    name: '비네팅', group: '렌즈 교정', params: [['amount', '양', -100, 100, 60], ['size', '중간점 (%)', 10, 100, 55]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.drawImage(c, 0, 0);
      const r = Math.hypot(w, h) / 2;
      const grad = g.createRadialGradient(w / 2, h / 2, (r * p.size) / 100, w / 2, h / 2, r);
      const a = Math.abs(p.amount) / 100;
      const col = p.amount >= 0 ? '0,0,0' : '255,255,255';
      grad.addColorStop(0, `rgba(${col},0)`);
      grad.addColorStop(1, `rgba(${col},${a})`);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      return out;
    },
  },
  clouds: {
    name: '구름 효과 1', group: '렌더', params: [['seed', '무작위 값', null, null, 1, 'hidden']], random: true,
    fn(c, p, { fg = '#000000', bg = '#ffffff' } = {}) {
      const w = c.width;
      const h = c.height;
      const N = cloudNoise(w, h, (p.scale || Math.max(w, h) / 3), p.seed || 1);
      const a = hexRgb(fg);
      const b = hexRgb(bg);
      const img = new ImageData(w, h);
      const d = img.data;
      for (let i = 0; i < w * h; i++) {
        const t = N[i];
        d[i * 4] = a[0] + (b[0] - a[0]) * t;
        d[i * 4 + 1] = a[1] + (b[1] - a[1]) * t;
        d[i * 4 + 2] = a[2] + (b[2] - a[2]) * t;
        d[i * 4 + 3] = 255;
      }
      return toCanvas(img);
    },
  },
};

export { cloudNoise, remapCanvas, motionBlur, doublingBlur, keepOpaque, gaussFloat, blurredLum };

/** Default values of a filter's settings. */
export const defaultFilterParams = (id) => Object.fromEntries(FILTERS[id].params.map(([k, , , , def]) => [k, structuredClone(def)]));

/** Settings a user sees (not 'hidden' ones). */
export const visibleParams = (defs) => (defs || []).filter((d) => d[5] !== 'hidden');

/**
 * Apply a filter to a canvas; returns a new canvas of the same size. `ctx`: { fg, bg } colours and,
 * when a selection limits the filter, `mask` (a canvas the size of `canvas`, selected = opaque).
 */
export function applyFilter(canvas, id, p, ctx = {}) {
  const f = FILTERS[id];
  if (!f?.fn) return canvas;
  const colors = { fg: ctx.fg || '#000000', bg: ctx.bg || '#ffffff', mask: ctx.mask || null };
  const out = f.fn(canvas, p || {}, colors);
  return out || canvas;
}

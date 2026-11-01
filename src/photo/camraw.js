// Filter ▸ Camera Raw 필터 (Shift+Ctrl+A): Photoshop's Camera Raw window — the 편집 panels (기본,
// 곡선, 세부, 혼합, 색상 그레이딩, 광학, 효과, 보정 with 자동 and 흑백 on top), 마스킹 (camrawmask*.js)
// and 사전 설정 (camrawpresets.js) on a right-hand toolbar with 확대/축소 and 손, before / after views
// and in-window undo. Our own processing (similar looks, not Adobe's pixels).
// The filter id stays 'cameraRaw' (actions, smart filters and the AI assistant use it); its declared
// params are the basic ones, the other panels' settings are optional keys of the same params object.

import { h } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { FILTERS, curveLut } from './adjust.js';
import { mk, read, toCanvas, cl, clamp, smooth, rng, TO_LIN, hexRgb } from './fxcore.js';
import { gaussF, boxBlurF } from './fxutil.js';
import { applyMasks, maskActive, maskAlpha } from './camrawmask.js';
import { maskingPanel } from './camrawmaskui.js';
import { presetsPanel } from './camrawpresets.js';

// ---------------------------------------------------------------- settings

const HSL_COLORS = [['red', '빨강', 0], ['orange', '주황', 30], ['yellow', '노랑', 60], ['green', '녹색', 120], ['aqua', '바다색', 180], ['blue', '파랑', 240], ['purple', '자주', 275], ['magenta', '마젠타', 315]];

// [key, label, min, max, default, step]
const BASIC = [['temp', '색온도', -100, 100, 0], ['tint', '색조', -100, 100, 0], ['exposure', '노출', -5, 5, 0, 0.05], ['contrast', '대비', -100, 100, 0], ['highlights', '밝은 영역', -100, 100, 0], ['shadows', '어두운 영역', -100, 100, 0], ['whites', '흰색 계열', -100, 100, 0], ['blacks', '검정 계열', -100, 100, 0], ['texture', '텍스처', -100, 100, 0], ['clarity', '부분 대비', -100, 100, 0], ['dehaze', '디헤이즈', -100, 100, 0], ['vibrance', '활기', -100, 100, 0], ['saturation', '채도', -100, 100, 0]];
const EFFECTS_OLD = [['vignette', '자르기 후 비네팅: 양', -100, 100, 0], ['grain', '그레인: 양', 0, 100, 0]];

/** Every optional setting with its default (the panels beyond 기본). */
export const CR_EXTRA = {
  treatment: 'color', profile: 'color',
  pcHigh: 0, pcLight: 0, pcDark: 0, pcShadow: 0, pcS1: 25, pcS2: 50, pcS3: 75,
  curve: null, curveR: null, curveG: null, curveB: null,
  sharpAmount: 0, sharpRadius: 1, sharpDetail: 25, sharpMasking: 0, nrLum: 0, nrDetail: 50, nrColor: 0,
  ...Object.fromEntries(HSL_COLORS.flatMap(([k]) => [[`h_${k}`, 0], [`s_${k}`, 0], [`l_${k}`, 0], [`bw_${k}`, 0]])),
  cgShadowH: 0, cgShadowS: 0, cgShadowL: 0, cgMidH: 0, cgMidS: 0, cgMidL: 0, cgHighH: 0, cgHighS: 0, cgHighL: 0, cgGlobalH: 0, cgGlobalS: 0, cgGlobalL: 0, cgBlend: 50, cgBalance: 0,
  removeCA: false, lensDist: 0, lensVig: 0, lensVigMid: 50,
  vigStyle: 'highlight', vigMid: 50, vigRound: 0, vigFeather: 50, vigHigh: 0, grainSize: 25, grainRough: 50,
  calShadows: 0, calRedH: 0, calRedS: 0, calGreenH: 0, calGreenS: 0, calBlueH: 0, calBlueS: 0,
};

const PROFILES = [['color', 'Adobe 색상'], ['vivid', 'Adobe 생동감'], ['landscape', 'Adobe 풍경'], ['portrait', 'Adobe 인물'], ['standard', 'Adobe 표준'], ['bw', 'Adobe 흑백']];

const isOn = (v) => v != null && v !== 0 && v !== false;

// ---------------------------------------------------------------- processing

/** Hue (0..360) and saturation-ish chroma of r, g, b in 0..1. */
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d <= 1e-6) return [0, 0];
  let hh = mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hh = (hh * 60 + 360) % 360;
  return [hh, d];
}

/** A wide Gaussian of a float image computed on a smaller copy (less memory and time). */
function wideBlur(Y, w, h, sigma) {
  const f = Math.max(1, Math.min(16, Math.floor(sigma / 3)));
  if (f < 2) return gaussF(Y, w, h, sigma);
  const sw = Math.ceil(w / f);
  const sh = Math.ceil(h / f);
  const S = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / f) * sw;
    for (let x = 0; x < w; x++) {
      const j = row + Math.floor(x / f);
      S[j] += Y[y * w + x];
      cnt[j]++;
    }
  }
  for (let i = 0; i < S.length; i++) S[i] /= cnt[i] || 1;
  const B = gaussF(S, sw, sh, sigma / f);
  const out = new Float32Array(w * h);
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
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Weights of the 8 HSL colour bands at hue hh: the two neighbouring bands share it. */
function bandWeights(hh, out) {
  out.fill(0);
  const n = HSL_COLORS.length;
  for (let i = 0; i < n; i++) {
    const a = HSL_COLORS[i][2];
    const b = i + 1 < n ? HSL_COLORS[i + 1][2] : 360;
    if (hh >= a && hh < b) {
      const t = (hh - a) / (b - a);
      out[i] = 1 - t;
      out[(i + 1) % n] += t;
      return out;
    }
  }
  out[0] = 1;
  return out;
}

/** Hue → rgb 0..1 of a fully saturated colour. */
function hueRgb(hh) {
  const x = ((hh % 360) + 360) % 360 / 60;
  const c = 1;
  const k = c * (1 - Math.abs((x % 2) - 1));
  if (x < 1) return [c, k, 0];
  if (x < 2) return [k, c, 0];
  if (x < 3) return [0, c, k];
  if (x < 4) return [0, k, c];
  if (x < 5) return [k, 0, c];
  return [c, 0, k];
}

/** The parametric tone curve (four regions split at s1..s3) as a 256 LUT 0..1. */
function parametricLut(p) {
  const s1 = clamp((p.pcS1 ?? 25) / 100, 0.05, 0.9);
  const s2 = clamp((p.pcS2 ?? 50) / 100, s1 + 0.02, 0.95);
  const s3 = clamp((p.pcS3 ?? 75) / 100, s2 + 0.02, 0.98);
  const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin(((x - a) / (b - a)) * Math.PI));
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y = x;
    y += ((p.pcShadow || 0) / 100) * 0.22 * bump(x, 0, s1 * 1.6);
    y += ((p.pcDark || 0) / 100) * 0.22 * bump(x, s1 * 0.4, s2 + (s2 - s1) * 0.6);
    y += ((p.pcLight || 0) / 100) * 0.22 * bump(x, s2 - (s3 - s2) * 0.6, s3 + (1 - s3) * 0.6);
    y += ((p.pcHigh || 0) / 100) * 0.22 * bump(x, s3 - (1 - s3) * 0.6, 1.0001);
    lut[i] = clamp(y, 0, 1);
  }
  return lut;
}

/**
 * Camera Raw on ImageData in place. `k` is the scale of this picture relative to the full-size layer
 * (previews are smaller): neighbourhood sizes follow it so the preview matches the result. `region`
 * (0..1 of the whole picture) says which part this image shows (zoomed views and masked parts).
 */
export function cameraRawData(img, p0, k = 1, region = null) {
  const masks = Array.isArray(p0.masks) ? p0.masks.filter(maskActive) : [];
  if (!masks.length) return baseRaw(img, p0, k, region);
  // masks: global settings, then each mask's local settings, then the effects (vignette, grain)
  const orig = new Uint8ClampedArray(img.data);
  const fx = p0.vignette || p0.grain;
  baseRaw(img, fx ? { ...p0, vignette: 0, grain: 0 } : p0, k, region);
  applyMasks(img, masks, { orig, k, region, raw: baseRaw, bw: p0.treatment === 'bw' || p0.profile === 'bw' });
  if (fx) {
    const q = { _local: true };
    for (const key of ['vignette', 'grain', 'vigStyle', 'vigMid', 'vigRound', 'vigFeather', 'vigHigh', 'grainSize', 'grainRough']) if (p0[key] != null) q[key] = p0[key];
    baseRaw(img, q, k, region);
  }
  return img;
}

function baseRaw(img, p0, k = 1, region = null) {
  const p = { ...CR_EXTRA, ...p0 };
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const rg = region || { x: 0, y: 0, w: 1, h: 1 };
  const full = Math.max(w / rg.w, h / rg.h) / Math.max(1e-6, k);
  // ---- 1. white balance and exposure in linear light
  const t = (p.temp || 0) / 100;
  const m = (p.tint || 0) / 100;
  let wr = 2 ** (t * 0.6 + m * 0.15);
  let wg = 2 ** (-m * 0.45);
  let wb = 2 ** (-t * 0.6 + m * 0.15);
  const norm = 1 / (0.2126 * wr + 0.7152 * wg + 0.0722 * wb);
  wr *= norm;
  wg *= norm;
  wb *= norm;
  const ex = 2 ** (p.exposure || 0);
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const lin = TO_LIN;
  const tos = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  // a mask's own pass without white balance or exposure leaves the light alone (no highlight roll-off)
  const plain = p._local && !p.temp && !p.tint && !p.exposure;
  for (let i = 0; i < n; i++) {
    if (plain) {
      R[i] = d[i * 4] / 255;
      G[i] = d[i * 4 + 1] / 255;
      B[i] = d[i * 4 + 2] / 255;
      continue;
    }
    const o = i * 4;
    // highlights roll off softly instead of clipping hard
    const soft = (v) => (v < 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2)));
    R[i] = tos(soft(lin[d[o]] * wr * ex));
    G[i] = tos(soft(lin[d[o + 1]] * wg * ex));
    B[i] = tos(soft(lin[d[o + 2]] * wb * ex));
  }
  // ---- 2. profile
  const prof = p.profile || 'color';
  const profSat = { vivid: 1.18, landscape: 1.1, portrait: 0.95, standard: 1.04 }[prof] || 1;
  const profCon = { vivid: 1.08, landscape: 1.06, standard: 1.05, portrait: 0.98 }[prof] || 1;
  // ---- 3. tone: luminance and its blurred bases (for highlights / shadows and local contrast)
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  const needBase = isOn(p.highlights) || isOn(p.shadows) || isOn(p.clarity) || isOn(p.dehaze);
  const base = needBase ? wideBlur(Y, w, h, Math.max(1, (full / 40) * k)) : null;
  const fine = isOn(p.texture) ? gaussF(Y, w, h, Math.max(0.8, (full / 700) * k)) : null;
  const con = (1 + (p.contrast || 0) / 100 * 0.9) * profCon;
  const hiA = (p.highlights || 0) / 100;
  const shA = (p.shadows || 0) / 100;
  const whA = (p.whites || 0) / 100;
  const blA = (p.blacks || 0) / 100;
  const clA = (p.clarity || 0) / 100;
  const txA = (p.texture || 0) / 100;
  const dhA = (p.dehaze || 0) / 100;
  // airlight for dehaze: the brightness of the haziest (brightest) part
  let air = 0.9;
  if (dhA) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[clamp(Math.round(base[i] * 255), 0, 255)]++;
    let acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc > n * 0.01) {
        air = Math.max(0.5, v / 255);
        break;
      }
    }
  }
  const pcLut = (p.pcHigh || p.pcLight || p.pcDark || p.pcShadow) ? parametricLut(p) : null;
  const ptM = Array.isArray(p.curve) && p.curve.length >= 2 ? curveLut(p.curve) : null;
  const ptR = Array.isArray(p.curveR) && p.curveR.length >= 2 ? curveLut(p.curveR) : null;
  const ptG = Array.isArray(p.curveG) && p.curveG.length >= 2 ? curveLut(p.curveG) : null;
  const ptB = Array.isArray(p.curveB) && p.curveB.length >= 2 ? curveLut(p.curveB) : null;
  const lutAt = (L, v) => {
    const x = clamp(v, 0, 1) * 255;
    const i = Math.min(254, x | 0);
    const f = x - i;
    return L[i] + (L[i + 1] - L[i]) * f;
  };
  const lut8 = (L, v) => {
    const x = clamp(v, 0, 1) * 255;
    const i = Math.min(254, x | 0);
    const f = x - i;
    return (L[i] + (L[i + 1] - L[i]) * f) / 255;
  };
  const vigOld = p.vignette || 0;
  for (let i = 0; i < n; i++) {
    let y = Y[i];
    if (y <= 1e-5) y = 1e-5;
    let ny = y;
    // contrast around the middle
    if (con !== 1) {
      const a = ny ** con;
      ny = a / (a + (1 - ny) ** con);
    }
    // whites and blacks: the ends of the range
    if (whA) ny += whA * 0.18 * smooth(0.55, 1, ny) * (whA > 0 ? 1 - ny * 0.5 : 1);
    if (blA) ny += blA * 0.16 * (1 - smooth(0, 0.4, ny));
    // highlights and shadows: by the neighbourhood's brightness, keeping local detail
    if (base) {
      const b = base[i];
      if (hiA) ny += hiA * 0.3 * smooth(0.45, 0.95, b) * (hiA < 0 ? ny : 1 - ny + 0.3);
      if (shA) ny += shA * 0.32 * (1 - smooth(0.05, 0.55, b)) * (shA > 0 ? 1 - ny : ny + 0.2);
      if (clA) ny += (y - b) * clA * 1.1 * (1 - Math.abs(ny - 0.5)) * 1.4;
      if (dhA > 0) {
        // dark-channel-like: take out a veil of the airlight, then restore brightness a little
        const tr = Math.max(0.25, 1 - dhA * 0.75 * smooth(0.1, 0.9, b));
        ny = (ny - air * (1 - tr)) / tr;
        ny = ny * (1 - dhA * 0.15) + dhA * 0.05;
      } else if (dhA < 0) ny = ny + (air - ny) * -dhA * 0.6;
    }
    if (fine) ny += (y - fine[i]) * txA * 1.6;
    ny = clamp(ny, 0, 1.2);
    const ratio = ny / y;
    let r = R[i] * ratio;
    let g = G[i] * ratio;
    let bb = B[i] * ratio;
    if (dhA > 0) {
      // dehaze also brings colour back
      const yy = 0.2126 * r + 0.7152 * g + 0.0722 * bb;
      const sk = 1 + dhA * 0.35;
      r = yy + (r - yy) * sk;
      g = yy + (g - yy) * sk;
      bb = yy + (bb - yy) * sk;
    }
    // tone curves (parametric, then point: master and per channel)
    if (pcLut) {
      r = lutAt(pcLut, r);
      g = lutAt(pcLut, g);
      bb = lutAt(pcLut, bb);
    }
    if (ptM) {
      r = lut8(ptM, r);
      g = lut8(ptM, g);
      bb = lut8(ptM, bb);
    }
    if (ptR) r = lut8(ptR, r);
    if (ptG) g = lut8(ptG, g);
    if (ptB) bb = lut8(ptB, bb);
    R[i] = r;
    G[i] = g;
    B[i] = bb;
  }
  // ---- 4. colour: HSL / B&W mix, calibration, grading, vibrance & saturation
  const hsl = HSL_COLORS.map(([key]) => [(p[`h_${key}`] || 0) / 100, (p[`s_${key}`] || 0) / 100, (p[`l_${key}`] || 0) / 100]);
  const anyHsl = hsl.some(([a, b, c]) => a || b || c);
  const bw = p.treatment === 'bw' || prof === 'bw';
  const bwMix = HSL_COLORS.map(([key]) => (p[`bw_${key}`] || 0) / 100);
  const cal = [[(p.calRedH || 0) / 100, (p.calRedS || 0) / 100], [(p.calGreenH || 0) / 100, (p.calGreenS || 0) / 100], [(p.calBlueH || 0) / 100, (p.calBlueS || 0) / 100]];
  const anyCal = cal.some(([a, b]) => a || b) || p.calShadows;
  const wheels = [['Shadow', 0], ['Mid', 1], ['High', 2], ['Global', 3]].map(([k2]) => {
    const S = (p[`cg${k2}S`] || 0) / 100;
    const L = (p[`cg${k2}L`] || 0) / 100;
    const c = hueRgb(p[`cg${k2}H`] || 0);
    return { S, L, c };
  });
  const anyGrade = wheels.some((x) => x.S || x.L);
  const blend = clamp((p.cgBlend ?? 50) / 100, 0.01, 1);
  const bal = (p.cgBalance || 0) / 100;
  const vib = (p.vibrance || 0) / 100;
  const sat = (p.saturation || 0) / 100;
  const wts = new Float32Array(8);
  for (let i = 0; i < n; i++) {
    let r = R[i];
    let g = G[i];
    let b = B[i];
    if (anyCal) {
      // calibration: move / weaken the primaries (a broad version of the HSL bands)
      const [hh, ch] = hueOf(r, g, b);
      if (ch > 0.002) {
        let dh = 0;
        let ds = 0;
        for (let c = 0; c < 3; c++) {
          let dd = Math.abs(hh - c * 120);
          if (dd > 180) dd = 360 - dd;
          const wgt = Math.max(0, 1 - dd / 120);
          dh += cal[c][0] * wgt * 25;
          ds += cal[c][1] * wgt;
        }
        if (dh || ds) {
          const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const mx = Math.max(r, g, b);
          const [cr, cg, cb] = hueRgb(hh + dh);
          const amt = ch * (1 + ds);
          const k2 = mx - ch;
          r = k2 + cr * amt;
          g = k2 + cg * amt;
          b = k2 + cb * amt;
          const y2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r += yy - y2;
          g += yy - y2;
          b += yy - y2;
        }
      }
      if (p.calShadows) {
        const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const ws = (1 - smooth(0, 0.5, yy)) * (p.calShadows / 100) * 0.06;
        r += ws;
        g -= ws;
        b += ws;
      }
    }
    if (bw) {
      // black & white: the colour bands brighten or darken their part of the grey
      const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const [hh, ch] = hueOf(r, g, b);
      bandWeights(hh, wts);
      let adj = 0;
      for (let c = 0; c < 8; c++) adj += wts[c] * bwMix[c];
      const v = clamp(yy * (1 + adj * Math.min(1, ch * 3) * 0.8), 0, 1.2);
      r = g = b = v;
    } else {
      if (anyHsl) {
        const [hh, ch] = hueOf(r, g, b);
        if (ch > 0.002) {
          bandWeights(hh, wts);
          let dh = 0;
          let ds = 0;
          let dl = 0;
          for (let c = 0; c < 8; c++) {
            if (!wts[c]) continue;
            dh += wts[c] * hsl[c][0];
            ds += wts[c] * hsl[c][1];
            dl += wts[c] * hsl[c][2];
          }
          const satW = Math.min(1, ch * 2.5);
          if (dh) {
            const mx = Math.max(r, g, b);
            const [cr, cg, cb] = hueRgb(hh + dh * 30 * satW);
            const base0 = mx - ch;
            const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r = base0 + cr * ch;
            g = base0 + cg * ch;
            b = base0 + cb * ch;
            const y2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r += yy - y2;
            g += yy - y2;
            b += yy - y2;
          }
          if (ds) {
            const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const sk = 1 + ds * satW;
            r = yy + (r - yy) * sk;
            g = yy + (g - yy) * sk;
            b = yy + (b - yy) * sk;
          }
          if (dl) {
            const kk = 1 + dl * 0.45 * satW;
            r *= kk;
            g *= kk;
            b *= kk;
          }
        }
      }
      // vibrance and saturation (and the profile's colour)
      if (vib || sat || profSat !== 1) {
        const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b);
        const curS = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
        const sk = (1 + sat + vib * (1 - curS) * (vib > 0 ? 1 : 1)) * profSat;
        r = yy + (r - yy) * sk;
        g = yy + (g - yy) * sk;
        b = yy + (b - yy) * sk;
      }
    }
    if (anyGrade) {
      const yy = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      // shadow / midtone / highlight weights, overlap set by blending, split moved by balance
      const sp = 0.5 + bal * 0.35;
      const wdt = 0.15 + blend * 0.45;
      const ws = 1 - smooth(sp - wdt, sp, yy);
      const wh = smooth(sp, sp + wdt, yy);
      const wm = Math.max(0, 1 - ws - wh) * (0.5 + blend * 0.5);
      const ww = [ws, wm, wh, 1];
      for (let q = 0; q < 4; q++) {
        const { S, L, c } = wheels[q];
        const wq = ww[q];
        if (!wq || (!S && !L)) continue;
        const amt = S * 0.25 * wq;
        r += (c[0] - 0.5) * amt * 2 * (q === 2 ? 1 : 1);
        g += (c[1] - 0.5) * amt * 2;
        b += (c[2] - 0.5) * amt * 2;
        if (L) {
          r += L * 0.2 * wq;
          g += L * 0.2 * wq;
          b += L * 0.2 * wq;
        }
      }
    }
    R[i] = r;
    G[i] = g;
    B[i] = b;
  }
  // ---- 5. detail: noise reduction and sharpening on the luminance
  if (p.nrLum > 0 || p.nrColor > 0 || p.sharpAmount > 0 || p.removeCA) {
    const Yl = new Float32Array(n);
    for (let i = 0; i < n; i++) Yl[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    let Y2 = Yl;
    if (p.nrLum > 0) {
      const r = Math.max(1, Math.round((1 + p.nrLum / 30) * Math.max(0.6, k)));
      const eps = ((p.nrLum / 100) * 0.06 * (1.2 - (p.nrDetail ?? 50) / 100)) ** 2 + 1e-6;
      const mean = boxBlurF(Yl, w, h, r, 1);
      const sq = new Float32Array(n);
      for (let i = 0; i < n; i++) sq[i] = Yl[i] * Yl[i];
      const msq = boxBlurF(sq, w, h, r, 1);
      const A = new Float32Array(n);
      const Bc = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = msq[i] - mean[i] * mean[i];
        A[i] = v / (v + eps);
        Bc[i] = mean[i] * (1 - A[i]);
      }
      const mA = boxBlurF(A, w, h, r, 1);
      const mB = boxBlurF(Bc, w, h, r, 1);
      Y2 = new Float32Array(n);
      for (let i = 0; i < n; i++) Y2[i] = mA[i] * Yl[i] + mB[i];
    }
    if (p.sharpAmount > 0) {
      const rad = clamp(p.sharpRadius ?? 1, 0.5, 3) * k;
      const bl = gaussF(Y2, w, h, Math.max(0.5, rad));
      const amt = (p.sharpAmount / 100) * 1.4;
      const det = (p.sharpDetail ?? 25) / 100;
      const maskT = (p.sharpMasking || 0) / 100;
      let edge = null;
      if (maskT > 0) {
        edge = new Float32Array(n);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          edge[i] = Math.hypot(Y2[i + 1] - Y2[i - 1], Y2[i + w] - Y2[i - w]);
        }
        edge = gaussF(edge, w, h, 1);
      }
      const Y3 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let dlt = Y2[i] - bl[i];
        // "detail" low: keep halos small by squashing big differences
        const lim = 0.03 + det * 0.25;
        dlt = lim * Math.tanh(dlt / lim);
        const mk2 = edge ? smooth(maskT * 0.06, maskT * 0.12 + 0.005, edge[i]) : 1;
        Y3[i] = Y2[i] + dlt * amt * mk2;
      }
      Y2 = Y3;
    }
    // colour noise: smooth the colour, keep the (new) luminance
    let Cr = null;
    let Cb = null;
    if (p.nrColor > 0 || p.removeCA) {
      Cr = new Float32Array(n);
      Cb = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        Cr[i] = R[i] - Yl[i];
        Cb[i] = B[i] - Yl[i];
      }
      if (p.removeCA) {
        // purple / green fringes along strong edges lose their colour
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const e = Math.abs(Yl[i + 1] - Yl[i - 1]) + Math.abs(Yl[i + w] - Yl[i - w]);
          if (e < 0.18) continue;
          const purple = Cr[i] > 0 && Cb[i] > 0;
          const green = Cr[i] < 0 && Cb[i] < 0;
          if (purple || green) {
            const kk = 1 - smooth(0.18, 0.4, e) * 0.9;
            Cr[i] *= kk;
            Cb[i] *= kk;
          }
        }
      }
      if (p.nrColor > 0) {
        const s = (0.5 + (p.nrColor / 100) * 5) * Math.max(0.5, k * 1.5);
        Cr = gaussF(Cr, w, h, s);
        Cb = gaussF(Cb, w, h, s);
      }
    }
    for (let i = 0; i < n; i++) {
      let r = R[i];
      let b = B[i];
      let g = G[i];
      if (Cr) {
        r = Yl[i] + Cr[i];
        b = Yl[i] + Cb[i];
        g = (Yl[i] - 0.2126 * r - 0.0722 * b) / 0.7152;
      }
      const dy = Y2[i] - Yl[i];
      R[i] = r + dy;
      G[i] = g + dy;
      B[i] = b + dy;
    }
  }
  // ---- 6. optics (lens distortion is done on the canvas afterwards), vignettes and grain
  // the whole picture's centre and half size, in this image's pixels
  const hx = w / rg.w / 2;
  const hy = h / rg.h / 2;
  const cx = hx - rg.x * hx * 2;
  const cy = hy - rg.y * hy * 2;
  const R2 = hx * hx + hy * hy;
  const lensVig = (p.lensVig || 0) / 100;
  const lensMid = 0.2 + ((p.lensVigMid ?? 50) / 100) * 0.7;
  const vAmt = (p.vignette || 0) / 100;
  const vMid = clamp((p.vigMid ?? 50) / 100, 0, 1);
  const vRound = clamp((p.vigRound || 0) / 100, -1, 1);
  const vFeather = clamp((p.vigFeather ?? 50) / 100, 0.02, 1);
  const vHigh = clamp((p.vigHigh || 0) / 100, 0, 1);
  const grain = (p.grain || 0) / 100;
  let G2 = null;
  if (grain) {
    // grain: noise at a size relative to the full picture, rougher = less smoothing
    const gs = (0.5 + ((p.grainSize ?? 25) / 100) * 3) * k;
    const r0 = rng(9);
    const N = new Float32Array(n);
    for (let i = 0; i < n; i++) N[i] = r0() - 0.5;
    G2 = gs > 0.6 ? gaussF(N, w, h, gs * (1 - ((p.grainRough ?? 50) / 100) * 0.6)) : N;
    let sd = 0;
    for (let i = 0; i < n; i += 7) sd += G2[i] * G2[i];
    sd = Math.sqrt(sd / Math.ceil(n / 7)) || 1;
    for (let i = 0; i < n; i++) G2[i] /= sd;
  }
  // the vignette's ellipse: roundness 0 follows the picture, 100 is a circle
  const ax = vRound >= 0 ? hx + (Math.min(hx, hy) - hx) * vRound : hx * (1 - vRound * 0.3);
  const ay = vRound >= 0 ? hy + (Math.min(hx, hy) - hy) * vRound : hy * (1 - vRound * 0.3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r = R[i];
      let g = G[i];
      let b = B[i];
      if (lensVig) {
        const rr = Math.sqrt(((x - cx) ** 2 + (y - cy) ** 2) / R2);
        const kk = 1 + lensVig * smooth(lensMid * 0.6, 1.05, rr) * 0.8;
        r *= kk;
        g *= kk;
        b *= kk;
      }
      if (vAmt) {
        const dx = (x - cx) / Math.max(1, ax);
        const dy = (y - cy) / Math.max(1, ay);
        const rr = Math.hypot(dx, dy) / Math.SQRT2 * (vRound >= 0 ? 1.2 : 1);
        const start = 0.15 + vMid * 0.8;
        const t2 = smooth(start * (1 - vFeather * 0.9), start + vFeather * 0.5 + 0.05, rr);
        if (t2 > 0) {
          if (vAmt < 0) {
            // darken, sparing the brightest parts with "highlights"
            const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const keep = vHigh * smooth(0.6, 1, yy);
            const kk = 1 + vAmt * t2 * (1 - keep);
            r *= kk;
            g *= kk;
            b *= kk;
          } else {
            r += (1 - r) * vAmt * t2;
            g += (1 - g) * vAmt * t2;
            b += (1 - b) * vAmt * t2;
          }
        }
      }
      if (G2) {
        const yy = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
        const nn = G2[i] * grain * 0.09 * (0.4 + 0.6 * 4 * yy * (1 - yy) + 0.2);
        r += nn;
        g += nn;
        b += nn;
      }
      const o = i * 4;
      d[o] = cl(r * 255);
      d[o + 1] = cl(g * 255);
      d[o + 2] = cl(b * 255);
    }
  }
  void vigOld;
  return img;
}

/** The whole filter on a canvas (k: preview scale, region: the part of the picture `c` shows). */
export function cameraRawCanvas(c, p, k = 1, region = null) {
  let src = c;
  if (p.lensDist && FILTERS.lensCorrection && !region) src = FILTERS.lensCorrection.fn(c, { distortion: p.lensDist, scale: 100, edge: 'edge' });
  const img = read(src);
  cameraRawData(img, p, k, region);
  return toCanvas(img);
}

FILTERS.cameraRaw = {
  name: 'Camera Raw 필터', group: 'Camera Raw', slow: true, dialog: 'camraw',
  params: [...BASIC, ...EFFECTS_OLD],
  fn: (c, p) => cameraRawCanvas(c, p, 1),
};

// ---------------------------------------------------------------- the dialog

let lastParams = null;
const STYLE_ID = 'ph-camraw-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.cr { display: grid; grid-template-columns: minmax(0, 1fr) 336px 40px; gap: 8px; height: min(76vh, 800px); }
.modal:has(.cr) { max-width: 98vw; }
.cr-stage { position: relative; min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 6px; }
.cr-view { position: relative; overflow: hidden; background: #1b1c1f; border-radius: 6px; touch-action: none; }
.cr-disp { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--fs-s); }
.cr-bar .note { font-size: var(--fs-xs); }
.cr-bar .grow { flex: 1; }
.cr-bar select { max-width: 190px; }
.cr button.on, .cr-bar button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.cr-tools { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 2px 0; border-left: 1px solid var(--line); }
.cr-tools .ibtn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 5px; }
.cr-tools .ibtn.on { background: var(--accent-soft); color: var(--value); box-shadow: inset 0 0 0 1px var(--accent); }
.cr-tools-gap { flex: 1; }
.cr-side { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
.cr-ptitle { font-weight: 600; font-size: var(--fs); padding: 4px 2px 2px; display: flex; align-items: center; gap: 6px; }
.cr-hist { width: 100%; height: 80px; background: #111; border-radius: 4px; display: block; flex: none; }
.cr-top { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cr-top button { flex: 1; }
.cr-sec { border: 1px solid var(--line); border-radius: 6px; }
.cr-sec > summary { cursor: pointer; padding: 6px 8px; font-weight: 600; font-size: var(--fs); list-style: none; display: flex; justify-content: space-between; }
.cr-sec > summary::after { content: '▸'; color: var(--text-faint); }
.cr-sec[open] > summary::after { content: '▾'; }
.cr-sec > div { padding: 2px 8px 8px; display: grid; gap: 3px; }
.cr-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) 54px; align-items: center; gap: 6px; font-size: var(--fs-s); color: var(--text-dim); }
.cr-row > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.cr-row input[type=range] { width: 100%; min-width: 0; }
.cr-row input.ph-num { width: 54px; }
.cr-sub { font-size: var(--fs-xs); color: var(--text-faint); margin-top: 6px; text-transform: none; }
.cr-tabs { display: flex; flex-wrap: wrap; gap: 3px; }
.cr-tabs button { padding: 2px 8px; min-height: 0; font-size: var(--fs-xs); }
.cr-tabs button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.cr-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-s); color: var(--text-dim); }
.cr-wheelwrap { display: grid; place-items: center; padding: 4px 0; }
.cr-wheel { width: 132px; height: 132px; cursor: crosshair; touch-action: none; }
.crm, .crp { display: grid; gap: 6px; }
.crm-new { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.crm-new button { display: flex; align-items: center; gap: 6px; justify-content: flex-start; text-align: left; padding: 6px 8px; font-size: var(--fs-s); }
.crm-list { display: grid; gap: 4px; }
.crm-mask { border: 1px solid var(--line); border-radius: 6px; padding: 2px; }
.crm-mask.sel { border-color: var(--accent); }
.crm-row, .crm-comp { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 4px; cursor: default; font-size: var(--fs-s); }
.crm-row { font-weight: 600; }
.crm-name, .crm-cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crm-comp { margin-left: 10px; color: var(--text-dim); }
.crm-comp.sel { background: var(--accent-soft); color: var(--value); }
.crm-op { width: 14px; display: inline-grid; place-items: center; color: var(--text-faint); }
.crm-badge { font-size: var(--fs-xs); padding: 0 4px; border-radius: 3px; background: #444a55; color: #fff; font-weight: 400; }
.crm-ib { width: 24px; height: 22px; min-height: 0; padding: 0; display: grid; place-items: center; background: transparent; border-color: transparent; }
.crm-ib.on { color: var(--value); }
.crm-ops { display: flex; gap: 4px; padding: 4px 4px 2px 24px; }
.crm-ops button { padding: 2px 8px; min-height: 0; font-size: var(--fs-xs); }
.crm-swatch { width: 22px; height: 22px; min-height: 0; padding: 0; border-radius: 4px; border: 1px solid #000; }
.crm-colsw { width: 28px; height: 16px; border-radius: 3px; border: 1px solid var(--line); background-image: linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%); background-size: 8px 8px; }
.crm-head input[type=color] { width: 28px; height: 22px; padding: 0; border: none; background: none; }
.crm-head .ph-num { width: 46px; }
.crp-amount { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; display: grid; gap: 4px; }
.crp-folder { border: 1px solid var(--line); border-radius: 6px; }
.crp-folder > summary { cursor: pointer; padding: 6px 8px; display: flex; gap: 6px; align-items: center; font-weight: 600; font-size: var(--fs); list-style: none; }
.crp-folder > summary .note { margin-left: auto; font-weight: 400; }
.crp-list { display: grid; gap: 4px; }
.crp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px 8px 8px; }
.crp-tile { position: relative; display: grid; gap: 3px; padding: 4px; text-align: left; font-size: var(--fs-xs); min-height: 0; }
.crp-tile.on { border-color: var(--accent); background: var(--accent-soft); color: var(--value); }
.crp-thumb { aspect-ratio: 3 / 2; background: #111; border-radius: 3px; overflow: hidden; }
.crp-thumb canvas { width: 100%; height: 100%; display: block; object-fit: cover; }
.crp-del { position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,.6); border-radius: 3px; display: grid; place-items: center; width: 18px; height: 18px; color: #fff; }
body.mobile .cr { grid-template-columns: 1fr; grid-template-rows: auto auto auto; height: auto; }
body.mobile .cr-view { height: 44vh; }
body.mobile .cr-tools { flex-direction: row; border-left: none; border-top: 1px solid var(--line); padding-top: 4px; }
body.mobile .cr-tools-gap { flex: 0 0 12px; }
body.mobile .cr-side { max-height: 40vh; }
body.mobile .cr-tools .ibtn { width: 40px; height: 40px; }
`;
  document.head.append(h('style', { id: STYLE_ID }, css));
}

const VIEWS = [['single', '단일 보기'], ['lr', '이전/이후 좌/우'], ['tb', '이전/이후 위/아래'], ['splitLR', '이전/이후 좌/우 분할 화면'], ['splitTB', '이전/이후 위/아래 분할 화면']];
const ZOOM_STEPS = [0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 6, 8, 16];
const PANELS = { edit: '편집', mask: '마스킹', presets: '사전 설정' };
/** Every setting at its default. */
const crDefaults = () => ({ ...Object.fromEntries([...BASIC, ...EFFECTS_OLD].map(([k, , , , d]) => [k, d])), ...structuredClone(CR_EXTRA) });

/** Open Camera Raw for the active layer (or a smart object's filter at `index`). */
export function cameraRawDialog(P, { params = null, onApply = null, smartIndex = null } = {}) {
  const doc = P.doc;
  const l = doc?.active;
  const smart = l?.kind === 'smart';
  if (!l || (l.kind !== 'raster' && !smart) || (!smart && !l.canvas)) {
    toast('이미지(일반) 레이어나 고급 개체를 선택하세요');
    return;
  }
  ensureStyle();
  const DEF = crDefaults();
  const p = { ...structuredClone(DEF), ...(params ? structuredClone(params) : lastParams ? structuredClone(lastParams) : {}) };
  delete p._fg;
  delete p._bg;
  if (!Array.isArray(p.masks)) p.masks = [];
  // the source: the layer's own pixels (smart object: its rendered content)
  const src = smart ? doc.rasterizeLayer(l) : l.canvas;
  const fullW = src.width;
  const fullH = src.height;
  // masks are made for one picture: a picture of another size starts without them
  const sizeKey = `${fullW}x${fullH}`;
  if (smartIndex == null && p.maskSize && p.maskSize !== sizeKey) p.masks = [];
  // preview copy: about the size of the window
  const pk = Math.min(1, 1100 / Math.max(fullW, fullH));
  const prev = mk(Math.max(1, Math.round(fullW * pk)), Math.max(1, Math.round(fullH * pk)));
  {
    const g = prev.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, prev.width, prev.height);
  }
  const before = mk(prev.width, prev.height);
  before.getContext('2d').drawImage(prev, 0, 0);
  const beforeData = read(before).data;
  const after = mk(prev.width, prev.height);
  after.getContext('2d').drawImage(prev, 0, 0);

  // ---- view state
  let viewMode = 'single';
  let showBefore = false;
  let zoom = null; // CSS pixels per picture pixel; null = fit
  let center = { x: fullW / 2, y: fullH / 2 };
  let tool = null; // 'zoom' | 'hand'
  let space = false;
  let wbPick = false;
  let panel = 'edit';
  let crop = null; // zoomed in past the preview: a full-resolution render of the visible part
  let overlayC = null;
  let lastPanes = [];
  let lastFit = 1;
  const dpr = () => window.devicePixelRatio || 1;
  const disp = h('canvas.cr-disp', { 'aria-label': 'Camera Raw 미리 보기' });
  const view = h('div.cr-view', disp);
  const hist = h('canvas.cr-hist', { width: 256, height: 80 });
  const busy = h('span.note', '');

  /** The panes of the current view with their scale and offset (device pixels). */
  const panes = () => {
    const W = disp.width;
    const H = disp.height;
    const gap = Math.round(4 * dpr());
    let list;
    if (!showBefore && viewMode === 'lr') list = [{ x: 0, y: 0, w: (W - gap) / 2, h: H, which: 'before' }, { x: (W + gap) / 2, y: 0, w: (W - gap) / 2, h: H, which: 'after' }];
    else if (!showBefore && viewMode === 'tb') list = [{ x: 0, y: 0, w: W, h: (H - gap) / 2, which: 'before' }, { x: 0, y: (H + gap) / 2, w: W, h: (H - gap) / 2, which: 'after' }];
    else list = [{ x: 0, y: 0, w: W, h: H, which: showBefore ? 'before' : 'after', split: !showBefore && viewMode.startsWith('split') ? viewMode : null }];
    const pn0 = list[0];
    lastFit = Math.max(1e-4, Math.min(pn0.w / fullW, pn0.h / fullH) * 0.98);
    const s = zoom == null ? lastFit : zoom * dpr();
    // keep the picture in view
    const hw = pn0.w / 2 / s;
    const hh = pn0.h / 2 / s;
    center.x = fullW <= hw * 2 ? fullW / 2 : clamp(center.x, hw, fullW - hw);
    center.y = fullH <= hh * 2 ? fullH / 2 : clamp(center.y, hh, fullH - hh);
    for (const pn of list) {
      pn.s = s;
      pn.ox = pn.x + pn.w / 2 - center.x * s;
      pn.oy = pn.y + pn.h / 2 - center.y * s;
    }
    return list;
  };
  const toScreen = (pn, u, v) => ({ x: pn.ox + u * fullW * pn.s, y: pn.oy + v * fullH * pn.s });
  const fromEvent = (e) => {
    const r = disp.getBoundingClientRect();
    if (!r.width || !lastPanes.length) return null;
    const x = ((e.clientX - r.left) / r.width) * disp.width;
    const y = ((e.clientY - r.top) / r.height) * disp.height;
    const pane = lastPanes.find((pn) => x >= pn.x && x <= pn.x + pn.w && y >= pn.y && y <= pn.y + pn.h) || lastPanes[lastPanes.length - 1];
    const X = (x - pane.ox) / pane.s;
    const Y = (y - pane.oy) / pane.s;
    return { pane, x, y, X, Y, u: X / fullW, v: Y / fullH };
  };
  /** Visible part of the picture in a pane (picture pixels). */
  const visible = (pn) => {
    const x = Math.max(0, Math.floor((pn.x - pn.ox) / pn.s));
    const y = Math.max(0, Math.floor((pn.y - pn.oy) / pn.s));
    return { x, y, w: Math.min(fullW, Math.ceil((pn.x + pn.w - pn.ox) / pn.s)) - x, h: Math.min(fullH, Math.ceil((pn.y + pn.h - pn.oy) / pn.s)) - y };
  };

  const paint = () => {
    const g = disp.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1b1c1f';
    g.fillRect(0, 0, disp.width, disp.height);
    if (!disp.width) return;
    const list = panes();
    lastPanes = list;
    const s0 = list[0].s;
    const vis = visible(list[0]);
    const useCrop = crop && crop.ver === ver && s0 > pk * 1.05 && crop.s >= Math.min(1, s0) * 0.99
      && crop.rect.x <= vis.x && crop.rect.y <= vis.y && crop.rect.x + crop.rect.w >= vis.x + vis.w && crop.rect.y + crop.rect.h >= vis.y + vis.h;
    const dp = dpr();
    const label = (pn, text, x, y) => {
      g.font = `${11 * dp}px sans-serif`;
      const w = g.measureText(text).width + 12 * dp;
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillRect(x, y, w, 18 * dp);
      g.fillStyle = '#fff';
      g.fillText(text, x + 6 * dp, y + 13 * dp);
    };
    for (const pn of list) {
      g.save();
      g.beginPath();
      g.rect(pn.x, pn.y, pn.w, pn.h);
      g.clip();
      g.imageSmoothingEnabled = pn.s < 1.5 * dp;
      g.imageSmoothingQuality = 'high';
      const draw = (which) => {
        if (useCrop) g.drawImage(crop[which], pn.ox + crop.rect.x * pn.s, pn.oy + crop.rect.y * pn.s, crop.rect.w * pn.s, crop.rect.h * pn.s);
        else g.drawImage(which === 'before' ? before : after, pn.ox, pn.oy, fullW * pn.s, fullH * pn.s);
      };
      draw(pn.which);
      if (pn.which === 'after' && overlayC) g.drawImage(overlayC, pn.ox, pn.oy, fullW * pn.s, fullH * pn.s);
      if (pn.split) {
        const lr = pn.split === 'splitLR';
        const mid = lr ? pn.x + pn.w / 2 : pn.y + pn.h / 2;
        g.save();
        g.beginPath();
        if (lr) g.rect(pn.x, pn.y, mid - pn.x, pn.h);
        else g.rect(pn.x, pn.y, pn.w, mid - pn.y);
        g.clip();
        draw('before');
        g.restore();
        g.fillStyle = '#fff';
        if (lr) g.fillRect(mid, pn.y, Math.max(1, dp), pn.h);
        else g.fillRect(pn.x, mid, pn.w, Math.max(1, dp));
        label(pn, '이전', pn.x + 6 * dp, pn.y + 6 * dp);
        label(pn, '이후', lr ? mid + 6 * dp : pn.x + 6 * dp, lr ? pn.y + 6 * dp : mid + 6 * dp);
      } else if (list.length > 1 || showBefore) label(pn, pn.which === 'before' ? '이전' : '이후', pn.x + 6 * dp, pn.y + 6 * dp);
      if (pn.which === 'after' && panel === 'mask' && !tool) maskUi.drawOn(g, pn);
      g.restore();
    }
  };
  const drawHist = (c) => {
    const g = hist.getContext('2d');
    const d = read(c).data;
    const H = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < d.length; i += 16) {
      H[0][d[i]]++;
      H[1][d[i + 1]]++;
      H[2][d[i + 2]]++;
    }
    let mx = 1;
    for (const a of H) for (let i = 2; i < 254; i++) mx = Math.max(mx, a[i]);
    g.clearRect(0, 0, 256, 80);
    g.globalCompositeOperation = 'lighter';
    ['#e04040', '#40c040', '#4060ff'].forEach((col, ci) => {
      g.fillStyle = col;
      for (let i = 0; i < 256; i++) {
        const v = Math.min(80, (H[ci][i] / mx) * 76);
        g.fillRect(i, 80 - v, 1, v);
      }
    });
    g.globalCompositeOperation = 'source-over';
  };
  /** The selected mask tinted with the overlay colour, at preview size. */
  const makeOverlay = ({ mask, color, opacity }) => {
    const M = maskAlpha(mask, prev.width, prev.height, { orig: beforeData, region: null });
    const img = new ImageData(prev.width, prev.height);
    const [r, g2, b] = hexRgb(color);
    for (let i = 0; i < M.length; i++) {
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g2;
      img.data[o + 2] = b;
      img.data[o + 3] = M[i] * opacity * 255;
    }
    return toCanvas(img);
  };

  // ---- rendering (debounced) and the zoomed-in crop
  let ver = 0;
  let timer = 0;
  let cropTimer = 0;
  const render = () => {
    ver++;
    clearTimeout(timer);
    busy.textContent = '…';
    timer = setTimeout(renderNow, 40);
  };
  const renderNow = () => {
    try {
      const out = cameraRawCanvas(prev, p, pk);
      const ag = after.getContext('2d');
      ag.clearRect(0, 0, after.width, after.height);
      ag.drawImage(out, 0, 0);
      const info = panel === 'mask' ? maskUi.overlay() : null;
      overlayC = info ? makeOverlay(info) : null;
      drawHist(out);
      paint();
      scheduleCrop();
    } catch (err) {
      busy.textContent = String(err.message || err);
      return;
    }
    busy.textContent = '';
  };
  let lensCache = null;
  const lensSrc = () => {
    if (!p.lensDist || !FILTERS.lensCorrection) return src;
    if (lensCache?.v !== p.lensDist) lensCache = { v: p.lensDist, c: FILTERS.lensCorrection.fn(src, { distortion: p.lensDist, scale: 100, edge: 'edge' }) };
    return lensCache.c;
  };
  const scheduleCrop = () => {
    clearTimeout(cropTimer);
    if (!lastPanes[0] || lastPanes[0].s <= pk * 1.05) {
      crop = null;
      return;
    }
    cropTimer = setTimeout(renderCrop, 120);
  };
  const renderCrop = () => {
    const pn = lastPanes[0];
    if (!pn || pn.s <= pk * 1.05) return;
    const s = Math.min(1, pn.s);
    const v = visible(pn);
    if (v.w < 1 || v.h < 1) return;
    // a little extra around the view so small pans stay sharp
    const m = Math.round(Math.min(v.w, v.h) * 0.15);
    const r = { x: Math.max(0, v.x - m), y: Math.max(0, v.y - m) };
    r.w = Math.min(fullW, v.x + v.w + m) - r.x;
    r.h = Math.min(fullH, v.y + v.h + m) - r.y;
    const cw = Math.max(1, Math.round(r.w * s));
    const ch = Math.max(1, Math.round(r.h * s));
    const at = ver;
    try {
      const part = mk(cw, ch);
      part.getContext('2d').drawImage(lensSrc(), r.x, r.y, r.w, r.h, 0, 0, cw, ch);
      const b = mk(cw, ch);
      b.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
      const a = cameraRawCanvas(part, { ...p, lensDist: 0 }, s, { x: r.x / fullW, y: r.y / fullH, w: r.w / fullW, h: r.h / fullH });
      if (at !== ver) return;
      crop = { rect: r, s, before: b, after: a, ver: at };
      paint();
    } catch (err) {
      busy.textContent = String(err.message || err);
    }
  };

  // ---- zoom and hand
  const zoomSel = h('select', { 'aria-label': '확대/축소 수준', title: '확대/축소 수준 (Ctrl+0 맞춤 보기, Ctrl+Alt+0 100%)' });
  const syncZoomSel = () => {
    const z = (lastPanes[0]?.s ?? lastFit) / dpr();
    const opts = [h('option', { value: 'fit' }, '맞춤 보기'), ...ZOOM_STEPS.map((v) => h('option', { value: String(v) }, `${Math.round(v * 1000) / 10}%`))];
    if (zoom != null && !ZOOM_STEPS.includes(zoom)) opts.push(h('option', { value: String(zoom) }, `${Math.round(zoom * 1000) / 10}%`));
    zoomSel.replaceChildren(...opts);
    zoomSel.value = zoom == null ? 'fit' : String(zoom);
    zoomSel.title = `확대/축소 수준: ${Math.round(z * 1000) / 10}%`;
  };
  zoomSel.addEventListener('change', () => setZoom(zoomSel.value === 'fit' ? null : +zoomSel.value));
  const setZoom = (z, anchor = null) => {
    const fitZ = lastFit / dpr();
    if (z != null && z <= fitZ * 1.001 && !ZOOM_STEPS.includes(z)) z = null;
    if (z != null) {
      z = clamp(z, 0.02, 16);
      if (anchor) {
        // keep the picture point under the pointer where it is
        const pn = anchor.pane;
        const sN = z * dpr();
        center = { x: anchor.X - (anchor.x - pn.x - pn.w / 2) / sN, y: anchor.Y - (anchor.y - pn.y - pn.h / 2) / sN };
      }
    } else center = { x: fullW / 2, y: fullH / 2 };
    zoom = z;
    paint();
    syncZoomSel();
    scheduleCrop();
    updCursor();
  };
  const curZ = () => (lastPanes[0]?.s ?? lastFit) / dpr();
  const stepZoom = (dir, anchor = null) => {
    const z = curZ();
    const fitZ = lastFit / dpr();
    if (dir > 0) setZoom(ZOOM_STEPS.find((v) => v > z * 1.01) ?? 16, anchor);
    else {
      const next = [...ZOOM_STEPS].reverse().find((v) => v < z / 1.01);
      setZoom(next == null || next <= fitZ ? null : next, anchor);
    }
  };
  const setTool = (t) => {
    tool = tool === t ? null : t;
    if (tool) wbPick = false;
    wbBtn.classList.toggle('on', wbPick);
    syncTools();
    updCursor();
    paint();
  };
  const updCursor = () => {
    const zoomed = lastPanes[0] && lastPanes[0].s > lastFit * 1.01;
    let c = 'default';
    if (space || tool === 'hand') c = 'grab';
    else if (tool === 'zoom') c = 'zoom-in';
    else if (wbPick) c = 'crosshair';
    else if (panel === 'mask' && maskUi.cursor()) c = maskUi.cursor();
    else if (zoomed) c = 'grab';
    disp.style.cursor = c;
  };

  /** Average colour (bytes) of the unedited preview around picture point u, v. */
  const sampleAt = (u, v, r = 2) => {
    const x0 = clamp(Math.round(u * prev.width), 0, prev.width - 1);
    const y0 = clamp(Math.round(v * prev.height), 0, prev.height - 1);
    let rr = 0;
    let gg = 0;
    let bb = 0;
    let n = 0;
    for (let y = Math.max(0, y0 - r); y <= Math.min(prev.height - 1, y0 + r); y++) {
      for (let x = Math.max(0, x0 - r); x <= Math.min(prev.width - 1, x0 + r); x++) {
        const o = (y * prev.width + x) * 4;
        rr += beforeData[o];
        gg += beforeData[o + 1];
        bb += beforeData[o + 2];
        n++;
      }
    }
    return [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)];
  };
  const pickWb = (pt) => {
    const [r0, g0, b0] = sampleAt(pt.u, pt.v, 2);
    const rr = TO_LIN[r0];
    const gg = TO_LIN[g0];
    const bb = TO_LIN[b0];
    if (rr > 0 && gg > 0 && bb > 0) {
      // solve temp / tint so this colour becomes neutral (the multipliers of cameraRawData)
      set('temp', Math.round(clamp(Math.log2(bb / rr) / 1.2 * 100, -100, 100)));
      set('tint', Math.round(clamp(Math.log2(gg / Math.sqrt(rr * bb)) / 0.6 * 100, -100, 100)));
      wbSel.value = 'custom';
      commit();
    }
    wbPick = false;
    wbBtn.classList.remove('on');
    updCursor();
  };

  // ---- pointer on the picture
  let drag = null;
  const panDrag = (pt) => {
    const c0 = { ...center };
    const s = pt.pane.s;
    disp.style.cursor = 'grabbing';
    return {
      move(q) {
        center = { x: c0.x - (q.x - pt.x) / s, y: c0.y - (q.y - pt.y) / s };
        paint();
      },
      up() {
        updCursor();
        scheduleCrop();
      },
    };
  };
  disp.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const pt = fromEvent(e);
    if (!pt) return;
    e.preventDefault();
    try {
      disp.setPointerCapture(e.pointerId);
    } catch { /* pointer already gone */ }
    if (e.button === 1 || space || tool === 'hand') drag = panDrag(pt);
    else if (tool === 'zoom') stepZoom(e.altKey ? -1 : 1, pt);
    else if (wbPick) pickWb(pt);
    else if (panel === 'mask' && pt.pane.which === 'after' && (drag = maskUi.pointerDown(pt, e))) { /* the mask tool drags */ }
    else if (lastPanes[0]?.s > lastFit * 1.01) drag = panDrag(pt);
  });
  disp.addEventListener('pointermove', (e) => {
    const pt = fromEvent(e);
    if (!pt) return;
    if (drag) {
      drag.move(pt, e);
      if (panel === 'mask') maskUi.hover(pt);
      return;
    }
    if (panel === 'mask') maskUi.hover(pt);
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.up?.(fromEvent(e), e);
  };
  disp.addEventListener('pointerup', endDrag);
  disp.addEventListener('pointercancel', endDrag);
  disp.addEventListener('pointerleave', () => {
    if (!drag && panel === 'mask') maskUi.hover(null);
  });
  disp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = fromEvent(e);
    if (e.ctrlKey || e.altKey || !(lastPanes[0]?.s > lastFit * 1.01)) stepZoom(e.deltaY < 0 ? 1 : -1, pt);
    else {
      // scroll pans when zoomed in
      const s = lastPanes[0].s;
      center = { x: center.x + (e.shiftKey ? e.deltaY : e.deltaX) * dpr() / s, y: center.y + (e.shiftKey ? 0 : e.deltaY) * dpr() / s };
      paint();
      scheduleCrop();
    }
  }, { passive: false });
  const ro = new ResizeObserver(() => {
    const w = Math.max(1, Math.round(view.clientWidth * dpr()));
    const hh = Math.max(1, Math.round(view.clientHeight * dpr()));
    if (w === disp.width && hh === disp.height) return;
    disp.width = w;
    disp.height = hh;
    paint();
    syncZoomSel();
    scheduleCrop();
  });
  ro.observe(view);

  // ---- in-dialog undo (Ctrl+Z / Ctrl+Shift+Z)
  const undoList = [structuredClone(p)];
  let undoAt = 0;
  const commit = () => {
    const snap = structuredClone(p);
    if (JSON.stringify(snap) === JSON.stringify(undoList[undoAt])) return;
    undoList.splice(undoAt + 1);
    undoList.push(snap);
    if (undoList.length > 80) undoList.shift();
    undoAt = undoList.length - 1;
  };
  const restore = (snap) => {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, structuredClone(snap));
    syncAll();
    render();
  };
  const undo = () => {
    if (undoAt <= 0) return toast('더 취소할 단계가 없습니다');
    undoAt--;
    restore(undoList[undoAt]);
  };
  const redo = () => {
    if (undoAt >= undoList.length - 1) return;
    undoAt++;
    restore(undoList[undoAt]);
  };

  // ---- controls
  const rows = new Map();
  const set = (key, v) => {
    p[key] = v;
    const r = rows.get(key);
    if (r) {
      r.range.value = v;
      r.num.value = v;
    }
    render();
  };
  const slider = (key, label, min, max, def = 0, step = 1, bg = null) => {
    const range = h('input', { type: 'range', min, max, step, value: p[key] ?? def, 'aria-label': label });
    if (bg) range.style.background = bg;
    const num = h('input.ph-num', { type: 'number', min, max, step, value: p[key] ?? def });
    const upd = (v) => {
      p[key] = clamp(+v, min, max);
      range.value = p[key];
      num.value = p[key];
      render();
    };
    range.addEventListener('input', () => upd(range.value));
    num.addEventListener('input', () => {
      if (num.value !== '' && Number.isFinite(+num.value)) upd(num.value);
    });
    num.addEventListener('change', () => upd(num.value));
    const lab = h('span', { title: '두 번 누르면 기본값' }, label);
    // double-click the label or the slider: back to the default (like Camera Raw)
    lab.addEventListener('dblclick', () => {
      upd(def);
      commit();
    });
    range.addEventListener('dblclick', () => {
      upd(def);
      commit();
    });
    rows.set(key, { range, num, min, max, def });
    return h('label.cr-row', { dataset: { key } }, lab, range, num);
  };
  const section = (title, open, ...kids) => h('details.cr-sec', { open }, h('summary', title), h('div', ...kids));
  const grad = (a, b) => `linear-gradient(90deg, ${a}, ${b})`;

  // top of 편집: 자동, 흑백 and the profile
  const autoBtn = h('button', { type: 'button', title: '사진에 맞춰 노출·대비·흰색·검정 등을 자동으로 맞춥니다' }, '자동');
  autoBtn.addEventListener('click', async () => {
    try {
      const { heuristicSettings } = await import('./photoai.js');
      const s = heuristicSettings(before);
      for (const [key, , min, max] of BASIC) if (Number.isFinite(s[key])) set(key, Math.round(clamp(s[key], min, max) * 100) / 100);
      commit();
    } catch (err) {
      toast(String(err.message || err));
    }
  });
  const bwBtn = h('button', { type: 'button', title: '흑백으로 바꿉니다 (다시 누르면 컬러)' }, '흑백');
  const profSel = h('select', { 'aria-label': '프로필' }, ...PROFILES.map(([v, t]) => h('option', { value: v }, t)));
  const treatBtns = () => {
    bwBtn.classList.toggle('on', p.treatment === 'bw' || p.profile === 'bw');
    mixPanel();
  };
  bwBtn.addEventListener('click', () => {
    if (p.treatment === 'bw' || p.profile === 'bw') {
      p.treatment = 'color';
      if (p.profile === 'bw') p.profile = 'color';
    } else p.treatment = 'bw';
    profSel.value = p.profile || 'color';
    treatBtns();
    render();
    commit();
  });
  profSel.addEventListener('change', () => {
    p.profile = profSel.value;
    if (profSel.value === 'bw') p.treatment = 'bw';
    else if (p.treatment === 'bw') p.treatment = 'color';
    treatBtns();
    render();
  });

  // 기본
  const wbSel = h('select', { 'aria-label': '흰색 균형' }, h('option', { value: 'asShot' }, '원본'), h('option', { value: 'auto' }, '자동'), h('option', { value: 'custom' }, '사용자 정의'));
  wbSel.addEventListener('change', () => {
    if (wbSel.value === 'asShot') {
      set('temp', 0);
      set('tint', 0);
    } else if (wbSel.value === 'auto') {
      // grey world on the preview
      let rr = 0;
      let gg = 0;
      let bb = 0;
      for (let i = 0; i < beforeData.length; i += 4) {
        rr += TO_LIN[beforeData[i]];
        gg += TO_LIN[beforeData[i + 1]];
        bb += TO_LIN[beforeData[i + 2]];
      }
      set('temp', Math.round(clamp(Math.log2(bb / Math.max(1e-6, rr)) / 1.2 * 100, -100, 100)));
      set('tint', Math.round(clamp(Math.log2(gg / Math.sqrt(Math.max(1e-9, rr * bb))) / 0.6 * 100, -100, 100)));
    }
  });
  const wbBtn = h('button.small', { type: 'button', title: '흰색 균형 도구 (I): 미리 보기에서 회색이어야 할 곳을 누르세요' }, icon('eyedropper', 14), ' 흰색 균형 도구');
  wbBtn.addEventListener('click', () => {
    wbPick = !wbPick;
    if (wbPick) tool = null;
    wbBtn.classList.toggle('on', wbPick);
    syncTools();
    updCursor();
  });
  const basic = section('기본', true,
    h('div.cr-line', h('span', '흰색 균형'), wbSel, wbBtn),
    slider('temp', '색온도', -100, 100, 0, 1, grad('#3b6dd8', '#e8c24a')),
    slider('tint', '색조', -100, 100, 0, 1, grad('#46b04a', '#c94fc0')),
    slider('exposure', '노출', -5, 5, 0, 0.05),
    slider('contrast', '대비', -100, 100),
    slider('highlights', '밝은 영역', -100, 100),
    slider('shadows', '어두운 영역', -100, 100),
    slider('whites', '흰색 계열', -100, 100),
    slider('blacks', '검정 계열', -100, 100),
    h('div.cr-sub', '현장감'),
    slider('texture', '텍스처', -100, 100),
    slider('clarity', '부분 대비', -100, 100),
    slider('dehaze', '디헤이즈', -100, 100),
    slider('vibrance', '활기', -100, 100),
    slider('saturation', '채도', -100, 100));

  // 곡선: parametric + point (per channel)
  const curveTabs = h('div.cr-tabs');
  const curveBox = h('div');
  let curveCh = 'param';
  const renderCurve = async () => {
    curveTabs.replaceChildren(...[['param', '매개 변수'], ['curve', '점 (RGB)'], ['curveR', '빨강'], ['curveG', '녹색'], ['curveB', '파랑']].map(([id, t]) => h(`button.small${curveCh === id ? '.on' : ''}`, { type: 'button', onclick: () => { curveCh = id; renderCurve(); } }, t)));
    if (curveCh === 'param') {
      curveBox.replaceChildren(slider('pcHigh', '밝은 영역', -100, 100), slider('pcLight', '밝음', -100, 100), slider('pcDark', '어두움', -100, 100), slider('pcShadow', '어두운 영역', -100, 100),
        h('div.cr-sub', '영역 나누기'), slider('pcS1', '분할 1', 5, 90, 25), slider('pcS2', '분할 2', 10, 95, 50), slider('pcS3', '분할 3', 15, 98, 75));
      return;
    }
    const { curveEditor } = await import('./pdialogs.js');
    const ch = curveCh;
    const pts = Array.isArray(p[ch]) ? p[ch] : [[0, 0], [255, 255]];
    curveBox.replaceChildren(curveEditor(pts, (np, done) => {
      p[ch] = np.length === 2 && np[0][0] === 0 && np[0][1] === 0 && np[1][0] === 255 && np[1][1] === 255 ? null : np.map((q) => [...q]);
      render();
      if (done) commit();
    }, { color: { curve: '#e8eaed', curveR: '#ff6060', curveG: '#60d060', curveB: '#6080ff' }[ch] }));
  };
  const curves = section('곡선', false, curveTabs, curveBox);

  // 세부
  const detail = section('세부', false,
    slider('sharpAmount', '선명하게', 0, 150), slider('sharpRadius', '반경', 0.5, 3, 1, 0.1), slider('sharpDetail', '세부', 0, 100, 25), slider('sharpMasking', '마스킹', 0, 100),
    h('div.cr-sub', '노이즈 감소'),
    slider('nrLum', '노이즈 감소', 0, 100), slider('nrDetail', '세부', 0, 100, 50), slider('nrColor', '색상 노이즈 감소', 0, 100));

  // 혼합 (HSL or B&W mix)
  const mixBox = h('div');
  let mixTab = 'h';
  const mixPanel = () => {
    if (p.treatment === 'bw' || p.profile === 'bw') {
      mixBox.replaceChildren(h('div.cr-sub', '흑백 혼합'), ...HSL_COLORS.map(([key, name]) => slider(`bw_${key}`, name, -100, 100)));
      return;
    }
    const tabs = h('div.cr-tabs', ...[['h', '색조'], ['s', '채도'], ['l', '광도']].map(([id, t]) => h(`button.small${mixTab === id ? '.on' : ''}`, { type: 'button', onclick: () => { mixTab = id; mixPanel(); } }, t)));
    mixBox.replaceChildren(tabs, ...HSL_COLORS.map(([key, name, hh]) => {
      const c = `hsl(${hh},80%,50%)`;
      const bg = mixTab === 'h' ? grad(`hsl(${hh - 30},80%,50%)`, `hsl(${hh + 30},80%,50%)`) : mixTab === 's' ? grad('#888', c) : grad('#111', c);
      return slider(`${mixTab}_${key}`, name, -100, 100, 0, 1, bg);
    }));
  };
  const mix = section('혼합', false, mixBox);

  // 색상 그레이딩
  const cgTabs = h('div.cr-tabs');
  const cgBox = h('div');
  let cgTab = 'Mid';
  /** A colour wheel: the angle is the hue, the distance from the middle the saturation. */
  const wheel = (hKey, sKey) => {
    const S = 132;
    const c = h('canvas.cr-wheel', { width: S, height: S, 'aria-label': '색상 휠 (끌어서 색조·채도)' });
    const g = c.getContext('2d');
    const R = S / 2 - 6;
    const draw = () => {
      g.clearRect(0, 0, S, S);
      const cg = g.createConicGradient(-Math.PI / 2, S / 2, S / 2);
      for (let i = 0; i <= 6; i++) cg.addColorStop(i / 6, `hsl(${i * 60},90%,50%)`);
      g.fillStyle = cg;
      g.beginPath();
      g.arc(S / 2, S / 2, R, 0, Math.PI * 2);
      g.fill();
      const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, R);
      rg.addColorStop(0, 'rgba(128,128,128,1)');
      rg.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = rg;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,.5)';
      g.stroke();
      // the puck: hue 0 at the top, clockwise
      const a = (((p[hKey] || 0) - 90) * Math.PI) / 180;
      const r = ((p[sKey] || 0) / 100) * R;
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r;
      g.lineWidth = 2;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = '#000';
      g.beginPath();
      g.arc(x, y, 7.5, 0, Math.PI * 2);
      g.stroke();
    };
    const at = (e) => {
      const rc = c.getBoundingClientRect();
      const x = ((e.clientX - rc.left) / rc.width) * S - S / 2;
      const y = ((e.clientY - rc.top) / rc.height) * S - S / 2;
      const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360);
      set(hKey, hue);
      set(sKey, Math.round(clamp(Math.hypot(x, y) / R, 0, 1) * 100));
      draw();
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      at(e);
      const mv = (ev) => at(ev);
      const up = () => {
        c.removeEventListener('pointermove', mv);
        c.removeEventListener('pointerup', up);
        commit();
      };
      c.addEventListener('pointermove', mv);
      c.addEventListener('pointerup', up);
    });
    // double-click: no colour
    c.addEventListener('dblclick', () => {
      set(sKey, 0);
      draw();
      commit();
    });
    draw();
    c.redraw = draw;
    return c;
  };
  const renderCg = () => {
    cgTabs.replaceChildren(...[['Shadow', '어두운 영역'], ['Mid', '중간 영역'], ['High', '밝은 영역'], ['Global', '전역']].map(([id, t]) => h(`button.small${cgTab === id ? '.on' : ''}`, { type: 'button', onclick: () => { cgTab = id; renderCg(); } }, t)));
    const wh = wheel(`cg${cgTab}H`, `cg${cgTab}S`);
    const hs = [slider(`cg${cgTab}H`, '색조', 0, 360, 0, 1, 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'), slider(`cg${cgTab}S`, '채도', 0, 100)];
    // the sliders move the wheel's puck too
    for (const row of hs) row.addEventListener('input', () => wh.redraw());
    cgBox.replaceChildren(
      h('div.cr-wheelwrap', wh),
      ...hs,
      slider(`cg${cgTab}L`, '광도', -100, 100),
      h('div.cr-sub', '모든 휠'),
      slider('cgBlend', '혼합', 0, 100, 50),
      slider('cgBalance', '균형', -100, 100));
  };
  const grading = section('색상 그레이딩', false, cgTabs, cgBox);

  // 광학
  const caChk = h('input', { type: 'checkbox' });
  caChk.addEventListener('change', () => {
    p.removeCA = caChk.checked;
    render();
  });
  const optics = section('광학', false,
    h('label.cr-line', caChk, '색수차 제거'),
    slider('lensDist', '왜곡', -100, 100),
    slider('lensVig', '비네팅', -100, 100),
    slider('lensVigMid', '중간점', 0, 100, 50));

  // 효과
  const vigStyle = h('select', { 'aria-label': '비네팅 스타일' }, h('option', { value: 'highlight' }, '밝은 영역 우선'), h('option', { value: 'color' }, '색상 우선'), h('option', { value: 'paint' }, '페인트 오버레이'));
  vigStyle.addEventListener('change', () => {
    p.vigStyle = vigStyle.value;
    render();
  });
  const effects = section('효과', false,
    h('div.cr-sub', '그레인'),
    slider('grain', '양', 0, 100), slider('grainSize', '크기', 0, 100, 25), slider('grainRough', '거칠기', 0, 100, 50),
    h('div.cr-sub', '자르기 후 비네팅'),
    h('div.cr-line', h('span', '스타일'), vigStyle),
    slider('vignette', '양', -100, 100), slider('vigMid', '중간점', 0, 100, 50), slider('vigRound', '원형률', -100, 100), slider('vigFeather', '페더', 0, 100, 50), slider('vigHigh', '밝은 영역', 0, 100));

  // 보정
  const calib = section('보정', false,
    slider('calShadows', '어두운 영역: 색조', -100, 100, 0, 1, grad('#46b04a', '#c94fc0')),
    h('div.cr-sub', '빨강 기본 색상'), slider('calRedH', '색조', -100, 100), slider('calRedS', '채도', -100, 100),
    h('div.cr-sub', '녹색 기본 색상'), slider('calGreenH', '색조', -100, 100), slider('calGreenS', '채도', -100, 100),
    h('div.cr-sub', '파랑 기본 색상'), slider('calBlueH', '색조', -100, 100), slider('calBlueS', '채도', -100, 100));

  const resetBtn = h('button.small', { type: 'button', title: '편집 설정을 모두 기본값으로 (마스크는 그대로)' }, icon('reset', 14), ' 기본값으로');
  resetBtn.addEventListener('click', () => {
    const masks = p.masks;
    Object.assign(p, crDefaults(), { masks });
    syncAll();
    render();
    commit();
  });

  /** Every control from the settings (after undo, presets, 자동 or reset). */
  const syncAll = () => {
    for (const [key, r] of rows) {
      const v = p[key] ?? r.def;
      r.range.value = v;
      r.num.value = v;
    }
    profSel.value = p.profile || 'color';
    wbSel.value = p.temp || p.tint ? 'custom' : 'asShot';
    caChk.checked = !!p.removeCA;
    vigStyle.value = p.vigStyle || 'highlight';
    treatBtns();
    renderCurve();
    renderCg();
    maskUi.refresh();
  };

  const editBox = h('div.cr-edit',
    h('div.cr-top', autoBtn, bwBtn),
    h('div.cr-line', h('span', '프로필'), profSel),
    basic, curves, detail, mix, grading, optics, effects, calib, h('div.cr-line', resetBtn));

  // ---- 마스킹 and 사전 설정
  const ui = {
    p, render, commit, before, fullW, fullH, sampleAt, toScreen,
    repaint: () => paint(),
  };
  const maskUi = maskingPanel(ui);
  const thumbBase = (() => {
    const s = Math.min(1, 120 / Math.max(fullW, fullH));
    const c = mk(Math.max(1, Math.round(fullW * s)), Math.max(1, Math.round(fullH * s)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(before, 0, 0, c.width, c.height);
    return { c, s };
  })();
  const presetUi = presetsPanel({
    p,
    defs: DEF,
    commit,
    apply: (vals) => {
      for (const [k, v] of Object.entries(vals)) {
        const r = rows.get(k);
        p[k] = r && typeof v === 'number' ? clamp(v, r.min, r.max) : v;
      }
      syncAll();
      render();
    },
    thumb: (vals) => cameraRawCanvas(thumbBase.c, { ...DEF, ...vals }, thumbBase.s),
    current: () => {
      const out = {};
      for (const [k, v] of Object.entries(p)) if (k !== 'masks' && k !== 'maskSize' && !k.startsWith('_') && JSON.stringify(v) !== JSON.stringify(DEF[k])) out[k] = structuredClone(v);
      return out;
    },
  });
  const maskBox = h('div', maskUi.el);
  const presetBox = h('div', presetUi.el);
  const ptitle = h('div.cr-ptitle');

  // ---- the toolbar on the right (like Camera Raw's)
  const toolBtn = (id, ic, title, fn) => {
    const b = h('button.ibtn', { type: 'button', title, 'aria-label': title, dataset: { id } }, icon(ic, 18));
    b.addEventListener('click', fn);
    return b;
  };
  const showPanel = (id) => {
    panel = id;
    tool = null;
    wbPick = false;
    wbBtn.classList.remove('on');
    ptitle.replaceChildren(icon({ edit: 'sliders', mask: 'mask', presets: 'presets' }[id], 16), PANELS[id]);
    editBox.hidden = id !== 'edit';
    maskBox.hidden = id !== 'mask';
    presetBox.hidden = id !== 'presets';
    if (id === 'mask') maskUi.refresh();
    syncTools();
    updCursor();
    render();
  };
  const tEdit = toolBtn('edit', 'sliders', '편집 (E)', () => showPanel('edit'));
  const tMask = toolBtn('mask', 'mask', '마스킹 (Shift+W)', () => showPanel('mask'));
  const tPre = toolBtn('presets', 'presets', '사전 설정 (Shift+P)', () => showPanel('presets'));
  const tZoom = toolBtn('zoom', 'zoom', '확대/축소 도구 (Z): 누르면 확대, Alt+클릭은 축소, 두 번 누르면 100%', () => setTool('zoom'));
  tZoom.addEventListener('dblclick', () => setZoom(1));
  const tHand = toolBtn('hand', 'hand', '손 도구 (H): 끌어서 옮기기, 두 번 누르면 맞춤 보기 (Space를 누르는 동안에도 손 도구)', () => setTool('hand'));
  tHand.addEventListener('dblclick', () => setZoom(null));
  const syncTools = () => {
    for (const [b, on] of [[tEdit, panel === 'edit'], [tMask, panel === 'mask'], [tPre, panel === 'presets'], [tZoom, tool === 'zoom'], [tHand, tool === 'hand']]) b.classList.toggle('on', on);
  };
  const tools = h('div.cr-tools', { role: 'toolbar', 'aria-label': 'Camera Raw 도구' }, tEdit, tMask, tPre, h('div.cr-tools-gap'), tZoom, tHand);

  // ---- the bar under the picture: zoom, before / after
  const zOut = h('button.small', { type: 'button', title: '축소 (Ctrl+-)', 'aria-label': '축소' }, icon('zoomOut', 14));
  zOut.addEventListener('click', () => stepZoom(-1));
  const zIn = h('button.small', { type: 'button', title: '확대 (Ctrl++)', 'aria-label': '확대' }, icon('zoomIn', 14));
  zIn.addEventListener('click', () => stepZoom(1));
  const viewSel = h('select', { 'aria-label': '이전/이후 보기', title: '이전/이후 보기 (Q로 차례로 바꾸기)' }, ...VIEWS.map(([v, t]) => h('option', { value: v }, t)));
  viewSel.addEventListener('change', () => {
    viewMode = viewSel.value;
    showBefore = false;
    syncBar();
    paint();
    scheduleCrop();
  });
  const cycleBtn = h('button.small', { type: 'button', title: '이전/이후 보기 전환 (Q)', 'aria-label': '이전/이후 보기 전환' }, icon('compare', 14));
  cycleBtn.addEventListener('click', () => cycleView());
  const prevBtn = h('button.small', { type: 'button', title: '원본 보기 켜기/끄기 (P)' }, '원본 보기');
  prevBtn.addEventListener('click', () => {
    showBefore = !showBefore;
    syncBar();
    paint();
  });
  const cycleView = () => {
    const order = VIEWS.map((v) => v[0]);
    viewMode = order[(order.indexOf(viewMode) + 1) % order.length];
    showBefore = false;
    syncBar();
    paint();
    scheduleCrop();
  };
  const syncBar = () => {
    viewSel.value = viewMode;
    prevBtn.classList.toggle('on', showBefore);
  };

  const onKey = (e) => {
    if (!view.isConnected) return;
    // another window on top (a name prompt): leave the keys to it
    const tops = document.querySelectorAll('.modal-backdrop');
    if (tops.length && !tops[tops.length - 1].contains(view)) return;
    const t = e.target;
    const tag = t?.tagName;
    if ((tag === 'INPUT' && !['range', 'checkbox', 'color', 'radio'].includes(t.type)) || tag === 'TEXTAREA' || t?.isContentEditable) return;
    // a focused list keeps its own arrow keys
    if (tag === 'SELECT' && /^(Arrow|Enter|Home|End|Page)/.test(e.key)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !mod) {
      if (!space) {
        space = true;
        updCursor();
      }
    } else if (mod && e.code === 'KeyZ') (e.shiftKey ? redo : undo)();
    else if (mod && e.code === 'KeyY') redo();
    else if (mod && (e.key === '=' || e.key === '+')) stepZoom(1);
    else if (mod && e.key === '-') stepZoom(-1);
    else if (mod && e.code === 'Digit0') setZoom(e.altKey ? 1 : null);
    else if (mod) return;
    else if (panel === 'mask' && maskUi.key(e)) { /* a masking key */ }
    else if (e.code === 'KeyW' && e.shiftKey) showPanel('mask');
    else if (e.code === 'KeyP' && e.shiftKey) showPanel('presets');
    else if (e.code === 'KeyE' && !e.shiftKey && !e.altKey) showPanel('edit');
    else if (e.code === 'KeyQ' && !e.shiftKey) cycleView();
    else if (e.code === 'KeyP' && !e.altKey) prevBtn.click();
    else if (e.code === 'KeyI' && !e.shiftKey) {
      if (panel !== 'edit') showPanel('edit');
      wbBtn.click();
    } else if (e.code === 'KeyZ' && !e.shiftKey) setTool('zoom');
    else if (e.code === 'KeyH' && !e.shiftKey) setTool('hand');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space' && space) {
      space = false;
      updCursor();
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);

  const apply = () => {
    const out = { ...p };
    // keep only what differs from the defaults (smaller actions and files)
    for (const [key, def] of Object.entries(CR_EXTRA)) if (JSON.stringify(out[key]) === JSON.stringify(def)) delete out[key];
    const masks = (p.masks || []).filter((m) => m.comps?.length);
    if (masks.length) {
      out.masks = structuredClone(masks);
      out.maskSize = sizeKey;
    } else {
      delete out.masks;
      delete out.maskSize;
    }
    // masks belong to this picture: the next Camera Raw starts from the settings without them
    lastParams = structuredClone(out);
    delete lastParams.masks;
    delete lastParams.maskSize;
    if (onApply) {
      onApply(out);
      return;
    }
    // Ctrl+F applies it again, Alt+Ctrl+F reopens it with these settings
    import('./pdialogs.js').then((m) => m.setLastFilter('cameraRaw', out));
    if (smart) {
      P.run('고급 필터: Camera Raw 필터', () => {
        const list = [...(l.smart.filters || [])];
        const entry = { id: 'cameraRaw', params: { ...out, _fg: P.fg, _bg: P.bg }, enabled: true };
        if (smartIndex != null && list[smartIndex]) list[smartIndex] = { ...list[smartIndex], ...entry };
        else list.push(entry);
        l.smart = { ...l.smart, filters: list };
        doc.touch(l);
      });
      return;
    }
    toast('Camera Raw 필터 적용 중…');
    setTimeout(async () => {
      const { applyToLayer } = await import('./pdialogs.js');
      P.run('Camera Raw 필터', () => applyToLayer(P, (c) => cameraRawCanvas(c, out, 1)));
      P.recordStep?.({ type: 'filter', id: 'cameraRaw', params: structuredClone(out) });
    }, 30);
  };

  const side = h('div.cr-side', hist, ptitle, editBox, maskBox, presetBox);
  // any slider or option let go: one undo step
  side.addEventListener('change', () => commit());
  openModal({
    title: 'Camera Raw 필터',
    width: 'min(1400px, 98vw)',
    peek: false,
    body: [h('div.cr',
      h('div.cr-stage', view, h('div.cr-bar', zOut, zoomSel, zIn, busy, h('span.grow'), cycleBtn, viewSel, prevBtn)),
      side, tools)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: apply }],
    onClose: () => {
      clearTimeout(timer);
      clearTimeout(cropTimer);
      ro.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    },
  });
  syncAll();
  syncBar();
  showPanel('edit');
  syncZoomSel();
  // the picture has the keyboard first (not the zoom list)
  disp.tabIndex = -1;
  setTimeout(() => disp.focus({ preventScroll: true }), 0);
}

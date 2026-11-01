// Filter ▸ Camera Raw 필터 (Shift+Ctrl+A): Photoshop's Camera Raw panels — 기본, 곡선, 세부, 혼합,
// 색상 그레이딩, 광학, 효과, 보정 — in a large window with its own preview, before/after views, a
// white balance picker and 100% zoom. Our own processing (similar looks, not Adobe's pixels).
// The filter id stays 'cameraRaw' (actions, smart filters and the AI assistant use it); its declared
// params are the basic ones, the other panels' settings are optional keys of the same params object.

import { h } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { FILTERS, curveLut } from './adjust.js';
import { mk, read, toCanvas, cl, clamp, smooth, rng, TO_LIN } from './fxcore.js';
import { gaussF, boxBlurF } from './fxutil.js';

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
 * (previews are smaller): neighbourhood sizes follow it so the preview matches the result.
 */
export function cameraRawData(img, p0, k = 1) {
  const p = { ...CR_EXTRA, ...p0 };
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const full = Math.max(w, h) / Math.max(1e-6, k);
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
  for (let i = 0; i < n; i++) {
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
  const cx = w / 2;
  const cy = h / 2;
  const R2 = cx * cx + cy * cy;
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
  const ax = vRound >= 0 ? cx + (Math.min(cx, cy) - cx) * vRound : cx * (1 - vRound * 0.3);
  const ay = vRound >= 0 ? cy + (Math.min(cx, cy) - cy) * vRound : cy * (1 - vRound * 0.3);
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

/** The whole filter on a canvas (k: preview scale). */
export function cameraRawCanvas(c, p, k = 1) {
  let src = c;
  if (p.lensDist && FILTERS.lensCorrection) src = FILTERS.lensCorrection.fn(c, { distortion: p.lensDist, scale: 100, edge: 'edge' });
  const img = read(src);
  cameraRawData(img, p, k);
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
.cr { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 10px; height: min(72vh, 740px); }
.modal:has(.cr) { max-width: 98vw; }
.cr-stage { position: relative; min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 6px; }
.cr-view { position: relative; overflow: hidden; background: #26282d; border-radius: 6px; display: grid; place-items: center; touch-action: none; }
.cr-view canvas { max-width: 100%; max-height: 100%; display: block; }
.cr-view.zoom100 canvas { max-width: none; max-height: none; cursor: grab; }
.cr-pair { display: flex; gap: 6px; width: 100%; height: 100%; align-items: center; justify-content: center; }
.cr-pair > div { position: relative; flex: 1; min-width: 0; height: 100%; display: grid; place-items: center; }
.cr-pair > div > span { position: absolute; left: 6px; top: 6px; font-size: var(--fs-xs); background: rgba(0,0,0,.55); color: #fff; padding: 1px 6px; border-radius: 3px; }
.cr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--fs-s); }
.cr-bar .note { font-size: var(--fs-xs); }
.cr-bar button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.cr-side { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
.cr-hist { width: 100%; height: 80px; background: #111; border-radius: 4px; display: block; }
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
body.mobile .cr { grid-template-columns: 1fr; height: auto; }
body.mobile .cr-view { height: 46vh; }
body.mobile .cr-side { max-height: 40vh; }
`;
  document.head.append(h('style', { id: STYLE_ID }, css));
}

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
  const p = { ...Object.fromEntries([...BASIC, ...EFFECTS_OLD].map(([k, , , , d]) => [k, d])), ...structuredClone(CR_EXTRA), ...(params ? structuredClone(params) : lastParams ? structuredClone(lastParams) : {}) };
  delete p._fg;
  delete p._bg;
  // the source: the layer's own pixels (smart object: its rendered content)
  const src = smart ? doc.rasterizeLayer(l) : l.canvas;
  const fullW = src.width;
  const fullH = src.height;
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
  const after = mk(prev.width, prev.height);
  let mode = 'after'; // after | sideBySide | split
  let zoom100 = false;
  let off = { x: 0, y: 0 };
  let crop = null; // 100% view: the processed full-size crop
  const view = h('div.cr-view');
  const hist = h('canvas.cr-hist', { width: 256, height: 80 });
  const busy = h('span.note', '');
  let timer = 0;
  const render = () => {
    clearTimeout(timer);
    busy.textContent = '…';
    timer = setTimeout(() => {
      try {
        const out = cameraRawCanvas(prev, p, pk);
        after.getContext('2d').clearRect(0, 0, after.width, after.height);
        after.getContext('2d').drawImage(out, 0, 0);
        if (zoom100) {
          const vw = Math.min(fullW, Math.max(200, view.clientWidth || 800));
          const vh = Math.min(fullH, Math.max(150, view.clientHeight || 500));
          off.x = clamp(off.x, 0, fullW - vw);
          off.y = clamp(off.y, 0, fullH - vh);
          const part = mk(vw, vh);
          part.getContext('2d').drawImage(src, -Math.round(off.x), -Math.round(off.y));
          crop = { before: part, after: cameraRawCanvas(part, p, 1) };
        }
        paint();
        drawHist(out);
      } catch (err) {
        busy.textContent = String(err.message || err);
        return;
      }
      busy.textContent = '';
    }, 40);
  };
  const paint = () => {
    const b = zoom100 && crop ? crop.before : before;
    const a = zoom100 && crop ? crop.after : after;
    view.classList.toggle('zoom100', zoom100);
    const cv = (c, label) => {
      const x = mk(c.width, c.height);
      x.getContext('2d').drawImage(c, 0, 0);
      return label ? h('div', x, h('span', label)) : x;
    };
    if (mode === 'sideBySide') view.replaceChildren(h('div.cr-pair', cv(b, '이전'), cv(a, '이후')));
    else if (mode === 'split') {
      const x = mk(a.width, a.height);
      const g = x.getContext('2d');
      g.drawImage(a, 0, 0);
      g.drawImage(b, 0, 0, Math.floor(b.width / 2), b.height, 0, 0, Math.floor(b.width / 2), b.height);
      g.fillStyle = '#fff';
      g.fillRect(Math.floor(b.width / 2), 0, 1, b.height);
      view.replaceChildren(h('div.cr-pair', h('div', x, h('span', '이전 | 이후'))));
    } else if (mode === 'before') view.replaceChildren(h('div.cr-pair', cv(b, '이전 (미리 보기 끔)')));
    else view.replaceChildren(cv(a));
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

  // ---- panning at 100% and the white balance picker
  let wbPick = false;
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    const cvs = e.target.closest?.('canvas');
    if (wbPick && cvs) {
      const r = cvs.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * cvs.width);
      const y = Math.floor(((e.clientY - r.top) / r.height) * cvs.height);
      const srcC = zoom100 && crop ? crop.before : before;
      const sx = mode === 'sideBySide' ? x : x;
      const dd = srcC.getContext('2d').getImageData(clamp(sx - 2, 0, srcC.width - 1), clamp(y - 2, 0, srcC.height - 1), 5, 5).data;
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let nn = 0;
      for (let i = 0; i < dd.length; i += 4) {
        rr += TO_LIN[dd[i]];
        gg += TO_LIN[dd[i + 1]];
        bb += TO_LIN[dd[i + 2]];
        nn++;
      }
      if (nn && rr > 0 && bb > 0 && gg > 0) {
        // solve temp / tint so this colour becomes neutral (the multipliers of cameraRawData)
        const tt = clamp(Math.log2(bb / rr) / 1.2 * 100, -100, 100);
        const mm = clamp(Math.log2(gg / Math.sqrt(rr * bb)) / 0.6 * 100, -100, 100);
        set('temp', Math.round(tt));
        set('tint', Math.round(mm));
        wbSel.value = 'custom';
      }
      wbPick = false;
      wbBtn.classList.remove('on');
      return;
    }
    if (!zoom100) return;
    drag = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    off = { x: drag.ox - (e.clientX - drag.x), y: drag.oy - (e.clientY - drag.y) };
  });
  view.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    render();
  });

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
    lab.addEventListener('dblclick', () => upd(def));
    range.addEventListener('dblclick', () => upd(def));
    rows.set(key, { range, num });
    return h('label.cr-row', lab, range, num);
  };
  const section = (title, open, ...kids) => h(`details.cr-sec${''}`, { open }, h('summary', title), h('div', ...kids));
  const grad = (a, b) => `linear-gradient(90deg, ${a}, ${b})`;

  // 기본
  const wbSel = h('select', { 'aria-label': '흰색 균형' }, h('option', { value: 'asShot' }, '원본'), h('option', { value: 'auto' }, '자동'), h('option', { value: 'custom' }, '사용자 정의'));
  wbSel.value = p.temp || p.tint ? 'custom' : 'asShot';
  wbSel.addEventListener('change', () => {
    if (wbSel.value === 'asShot') {
      set('temp', 0);
      set('tint', 0);
    } else if (wbSel.value === 'auto') {
      // grey world on the preview
      const d = read(before).data;
      let rr = 0;
      let gg = 0;
      let bb = 0;
      for (let i = 0; i < d.length; i += 4) {
        rr += TO_LIN[d[i]];
        gg += TO_LIN[d[i + 1]];
        bb += TO_LIN[d[i + 2]];
      }
      set('temp', Math.round(clamp(Math.log2(bb / Math.max(1e-6, rr)) / 1.2 * 100, -100, 100)));
      set('tint', Math.round(clamp(Math.log2(gg / Math.sqrt(Math.max(1e-9, rr * bb))) / 0.6 * 100, -100, 100)));
    }
  });
  const wbBtn = h('button.small', { type: 'button', title: '흰색 균형 도구 (I): 미리 보기에서 회색이어야 할 곳을 누르세요' }, '흰색 균형 도구');
  wbBtn.addEventListener('click', () => {
    wbPick = !wbPick;
    wbBtn.classList.toggle('on', wbPick);
  });
  const profSel = h('select', { 'aria-label': '프로필' }, ...PROFILES.map(([v, t]) => h('option', { value: v }, t)));
  profSel.value = p.profile || 'color';
  profSel.addEventListener('change', () => {
    p.profile = profSel.value;
    if (profSel.value === 'bw') p.treatment = 'bw';
    else if (p.treatment === 'bw' && profSel.value !== 'bw') p.treatment = 'color';
    treatBtns();
    render();
  });
  const treatColor = h('button.small', { type: 'button' }, '컬러');
  const treatBw = h('button.small', { type: 'button' }, '흑백');
  const treatBtns = () => {
    treatColor.classList.toggle('on', p.treatment !== 'bw');
    treatBw.classList.toggle('on', p.treatment === 'bw');
    mixPanel();
  };
  treatColor.addEventListener('click', () => {
    p.treatment = 'color';
    if (p.profile === 'bw') {
      p.profile = 'color';
      profSel.value = 'color';
    }
    treatBtns();
    render();
  });
  treatBw.addEventListener('click', () => {
    p.treatment = 'bw';
    treatBtns();
    render();
  });
  const autoBtn = h('button.small', { type: 'button', title: '사진에 맞춰 노출·대비·흰색·검정 등을 자동으로 맞춥니다' }, '자동');
  autoBtn.addEventListener('click', async () => {
    try {
      const { heuristicSettings } = await import('./photoai.js');
      const s = heuristicSettings(before);
      for (const [key, , min, max] of BASIC) if (Number.isFinite(s[key])) set(key, Math.round(clamp(s[key], min, max) * 100) / 100);
    } catch (err) {
      toast(String(err.message || err));
    }
  });
  const basic = section('기본', true,
    h('div.cr-line', h('span', '처리'), treatColor, treatBw, h('span', '프로필'), profSel),
    h('div.cr-line', h('span', '흰색 균형'), wbSel, wbBtn),
    slider('temp', '색온도', -100, 100, 0, 1, grad('#3b6dd8', '#e8c24a')),
    slider('tint', '색조', -100, 100, 0, 1, grad('#46b04a', '#c94fc0')),
    h('div.cr-line', autoBtn, h('span.note', '두 번 누르면 기본값으로')),
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
    const pts = Array.isArray(p[curveCh]) ? p[curveCh] : [[0, 0], [255, 255]];
    curveBox.replaceChildren(curveEditor(pts, (np, done) => {
      p[curveCh] = np.length === 2 && np[0][0] === 0 && np[0][1] === 0 && np[1][0] === 255 && np[1][1] === 255 ? null : np;
      if (done || true) render();
    }, { color: { curve: '#e8eaed', curveR: '#ff6060', curveG: '#60d060', curveB: '#6080ff' }[curveCh] }));
  };
  renderCurve();
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
  mixPanel();
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
      };
      c.addEventListener('pointermove', mv);
      c.addEventListener('pointerup', up);
    });
    // double-click: no colour
    c.addEventListener('dblclick', () => {
      set(sKey, 0);
      draw();
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
  renderCg();
  const grading = section('색상 그레이딩', false, cgTabs, cgBox);

  // 광학
  const caChk = h('input', { type: 'checkbox', checked: !!p.removeCA });
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
  vigStyle.value = p.vigStyle || 'highlight';
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

  // ---- view bar
  const modeBtns = [['after', '이후'], ['sideBySide', '이전 | 이후 나란히'], ['split', '이전 | 이후 분할']].map(([id, t]) => {
    const b = h('button.small', { type: 'button', onclick: () => { mode = id; syncBar(); paint(); } }, t);
    b.dataset.id = id;
    return b;
  });
  const zoomBtn = h('button.small', { type: 'button', title: '100% (실제 픽셀) 보기: 끌어서 옮기기' }, '100%');
  zoomBtn.addEventListener('click', () => {
    zoom100 = !zoom100;
    if (zoom100) off = { x: Math.max(0, (fullW - 800) / 2), y: Math.max(0, (fullH - 500) / 2) };
    syncBar();
    render();
  });
  const syncBar = () => {
    for (const b of modeBtns) b.classList.toggle('on', b.dataset.id === mode);
    zoomBtn.classList.toggle('on', zoom100);
  };
  const resetBtn = h('button.small', { type: 'button', title: '모든 설정을 기본값으로' }, '기본값으로');
  resetBtn.addEventListener('click', () => {
    for (const [key, , , , def] of [...BASIC, ...EFFECTS_OLD]) p[key] = def;
    Object.assign(p, structuredClone(CR_EXTRA));
    for (const [key, r] of rows) {
      r.range.value = p[key];
      r.num.value = p[key];
    }
    profSel.value = 'color';
    caChk.checked = false;
    vigStyle.value = 'highlight';
    treatBtns();
    renderCurve();
    render();
  });
  syncBar();

  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Q: cycle before / after views, P: preview on / off, I: white balance tool, Z: 100%
    if (e.code === 'KeyQ' && !e.ctrlKey && !e.metaKey) {
      const order = ['after', 'sideBySide', 'split'];
      mode = order[(order.indexOf(mode) + 1) % order.length];
      syncBar();
      paint();
    } else if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey) {
      mode = mode === 'before' ? 'after' : 'before';
      syncBar();
      paint();
    } else if (e.code === 'KeyI' && !e.ctrlKey && !e.metaKey) wbBtn.click();
    else if (e.code === 'KeyZ' && !e.ctrlKey && !e.metaKey) zoomBtn.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);

  const apply = () => {
    const out = { ...p };
    // keep only what differs from the defaults (smaller actions and files)
    for (const [key, def] of Object.entries(CR_EXTRA)) if (JSON.stringify(out[key]) === JSON.stringify(def)) delete out[key];
    lastParams = structuredClone(out);
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

  openModal({
    title: 'Camera Raw 필터',
    width: 'min(1320px, 98vw)',
    peek: false,
    body: [h('div.cr',
      h('div.cr-stage', view, h('div.cr-bar', ...modeBtns, zoomBtn, h('span.note', 'Q: 이전/이후 보기 · P: 미리 보기 · I: 흰색 균형 도구 · Z: 100%'), busy)),
      h('div.cr-side', hist, basic, curves, detail, mix, grading, optics, effects, calib, h('div.cr-line', resetBtn)))],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: apply }],
    onClose: () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
    },
  });
  render();
}

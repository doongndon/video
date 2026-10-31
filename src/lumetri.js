// Lumetri 색상 renderer: 기본 교정 (input LUT, white balance, tone, saturation), 크리에이티브 (Look,
// intensity, faded film, sharpen, vibrance, saturation, shadow / highlight tint, tint balance),
// 곡선 (RGB curves and the five hue / saturation curves), 색상 휠 및 일치 (lift / gamma / gain with
// brightness), HSL 보조 (key, denoise / blur, mask view, correction) and 비네팅, in that order like
// Premiere. WebGL2 through glfx.js; without it a canvas-filter fallback keeps the basic sliders.
//
// Helpers for UI code: autoTone(canvas) — values for the 자동 button; whiteBalanceFrom([r, g, b])
// — temperature / tint that neutralise a picked colour (흰색 균형 선택기); hueCurveTable(points).

import { glfx } from './glfx.js';
import { bakeLook, isBuiltinLook } from './looks.js';
import { clamp } from './util.js';

/** Monotone cubic interpolation through curve points → 256-entry table (0..1). */
export function curveTable(points) {
  const pts = (points?.length >= 2 ? points : [[0, 0], [1, 1]]).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const tt = 3 / Math.sqrt(h);
      m[i] = tt * a * d[i];
      m[i + 1] = tt * b * d[i];
    }
  }
  const out = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    if (x <= xs[0]) out[k] = ys[0];
    else if (x >= xs[n - 1]) out[k] = ys[n - 1];
    else {
      const hseg = xs[i + 1] - xs[i];
      const t = (x - xs[i]) / hseg;
      const t2 = t * t;
      const t3 = t2 * t;
      out[k] = clamp((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hseg * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hseg * m[i + 1], 0, 1);
    }
  }
  return out;
}

/**
 * Periodic curve for the hue-based curves (x = hue 0..1 wraps around; y 0.5 = no change) →
 * 256-entry table. Points [[x, y], …]; a flat line when fewer than 2 points.
 */
export function hueCurveTable(points, periodic = true) {
  const out = new Float32Array(256).fill(0.5);
  const pts = (points || []).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) {
    if (pts.length === 1) out.fill(pts[0][1]);
    return out;
  }
  if (!periodic) return curveTable(pts);
  // Catmull-Rom through the points, wrapping around the hue circle
  const n = pts.length;
  const P = (i) => {
    const j = ((i % n) + n) % n;
    const wrap = Math.floor(i / n);
    return [pts[j][0] + wrap, pts[j][1]];
  };
  for (let k = 0; k < 256; k++) {
    const x = k / 256;
    let i = n - 1;
    for (let j = 0; j < n; j++) if (pts[j][0] <= x) i = j;
    let p1 = P(i);
    if (p1[0] > x) p1 = [p1[0] - 1, p1[1]];
    let i2 = i + 1;
    let p2 = P(i2);
    if (p2[0] <= p1[0]) p2 = [p2[0] + 1, p2[1]];
    const p0 = P(i - 1);
    const p3 = P(i2 + 1);
    const span = Math.max(1e-6, p2[0] - p1[0]);
    const t = clamp((x - p1[0]) / span, 0, 1);
    const m1 = (p2[1] - p0[1]) / 2;
    const m2 = (p3[1] - p1[1]) / 2;
    const t2 = t * t;
    const t3 = t2 * t;
    out[k] = clamp((2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2, 0, 1);
  }
  return out;
}

/** Colour wheel {x, y} → RGB offset (hue direction, zero mean luminance) scaled by k. */
export function wheelOffset(w, k) {
  const x = w?.x || 0;
  const y = w?.y || 0;
  const amt = Math.min(1, Math.hypot(x, y));
  if (amt < 1e-4) return [0, 0, 0];
  const hue = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1;
  const f = (n) => {
    const kk = (n + hue * 6) % 6;
    return 1 - Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  const rgb = [f(5), f(3), f(1)];
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((c) => (c - l) * amt * k);
}

/** Temperature / tint that turn a picked colour neutral (흰색 균형 선택기). rgb in 0..255 or 0..1. */
export function whiteBalanceFrom(rgb) {
  let [r, g, b] = rgb;
  if (r > 1 || g > 1 || b > 1) [r, g, b] = [r / 255, g / 255, b / 255];
  const eps = 1e-3;
  // the shader multiplies by (1 + .3·temp + .12·tint, 1 − .3·tint, 1 − .3·temp + .12·tint)
  const temp = clamp(((b - r) / Math.max(eps, (r + b) / 2)) / 0.6, -1, 1);
  const tint = clamp(((g - (r + b) / 2) / Math.max(eps, g)) / 0.3, -1, 1);
  return { temperature: Math.round(temp * 100), tint: Math.round(tint * 100) };
}

/** Values for Lumetri's 자동 (auto tone) from a frame canvas. */
export function autoTone(canvas) {
  const w = Math.min(160, canvas.width);
  const h = Math.max(1, Math.round((w * canvas.height) / Math.max(1, canvas.width)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    n++;
  }
  if (!n) return {};
  const pct = (p) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= p * n) return i / 255;
    }
    return 1;
  };
  const lo = pct(0.005);
  const hi = pct(0.995);
  const mid = pct(0.5);
  const exposure = clamp(Math.log2(0.45 / Math.max(0.02, mid)) * 0.6, -2, 2);
  return {
    exposure: Math.round(exposure * 20) / 20,
    contrast: Math.round(clamp((0.75 - (hi - lo)) * 60, -30, 40)),
    whites: Math.round(clamp((0.97 - hi) * 150, -40, 40)),
    blacks: Math.round(clamp((0.03 - lo) * 150, -40, 40)),
    highlights: 0,
    shadows: 0,
  };
}

const GRADE = `
uniform sampler2D curve; uniform sampler2D hcurve; uniform sampler3D lutIn; uniform sampler3D lutLook;
uniform float inLut, inLutSize, look, lookSize, lookAmt;
uniform vec3 wb;
uniform float exposure, contrast, highlights, shadows, whites, blacks, sat;
uniform float faded, sharp, vib, csat, tintBal;
uniform vec3 shTint, hiTint;
uniform float curves, hueCurves;
uniform vec3 lift, gamma, gain;
uniform float vig, vigMid, vigRound, vigFeather, doVig;
vec3 lutSample(sampler3D t, vec3 c, float n){ return texture(t, clamp(c, 0.0, 1.0) * ((n - 1.0) / n) + 0.5 / n).rgb; }
float hc(float x, float row){ return texture(hcurve, vec2(fract(x) * (255.0 / 256.0) + 0.5 / 256.0, row)).r; }
vec4 hc4(float x, float row){ return texture(hcurve, vec2(clamp(x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, row)); }
void main(){
  vec2 p = P();
  vec4 s = unpm(S(p));
  vec3 c = s.rgb;
  // ---- 기본 교정
  if (inLut > 0.5) c = lutSample(lutIn, c, inLutSize);
  c *= wb;
  vec3 lin = pow(max(c, 0.0), vec3(2.2)) * exp2(exposure);
  c = pow(lin, vec3(1.0 / 2.2));
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  float l = luma(c);
  float wH = smoothstep(0.45, 1.0, l);
  float wS = 1.0 - smoothstep(0.0, 0.55, l);
  c *= 1.0 + highlights * 0.55 * wH;
  c += shadows * 0.28 * wS * (1.0 - c);
  c *= 1.0 + whites * 0.35 * smoothstep(0.2, 1.0, l);
  c += blacks * 0.14 * (1.0 - smoothstep(0.0, 0.5, l));
  l = luma(c);
  c = mix(vec3(l), c, sat);
  // ---- 크리에이티브
  if (look > 0.5) c = mix(c, lutSample(lutLook, c, lookSize), lookAmt);
  if (faded > 0.0) c = mix(c, 0.075 + c * 0.86, faded);
  if (abs(sharp) > 0.001) {
    vec3 n4 = unpm(S(p + vec2(1.0, 0.0))).rgb + unpm(S(p - vec2(1.0, 0.0))).rgb + unpm(S(p + vec2(0.0, 1.0))).rgb + unpm(S(p - vec2(0.0, 1.0))).rgb;
    c += (s.rgb - n4 * 0.25) * sharp * 1.6;
  }
  l = luma(c);
  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + vib * (1.0 - clamp((mx - mn) * 1.6, 0.0, 1.0)));
  c = mix(vec3(luma(c)), c, csat);
  l = clamp(luma(c), 0.0, 1.0);
  float piv = 0.5 + tintBal * 0.35;
  c += shTint * (1.0 - smoothstep(0.0, piv, l)) + hiTint * smoothstep(piv, 1.0, l);
  // ---- 곡선
  c = clamp(c, 0.0, 1.0);
  if (curves > 0.5) c = vec3(texture(curve, vec2(c.r * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).r, texture(curve, vec2(c.g * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).g, texture(curve, vec2(c.b * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).b);
  if (hueCurves > 0.5) {
    vec3 hsv = rgb2hsv(c);
    float L = luma(c);
    vec4 byHue = hc4(hsv.x, 0.25);
    float satMul = byHue.r * 2.0 * hc4(L, 0.25).a * 2.0 * hc4(hsv.y, 0.75).r * 2.0;
    hsv.x = fract(hsv.x + (byHue.g - 0.5));
    hsv.y = clamp(hsv.y * satMul, 0.0, 1.0);
    c = hsv2rgb(hsv);
    c += (byHue.b - 0.5) * 0.6 * hsv.y;
  }
  // ---- 색상 휠 및 일치 (lift / gamma / gain)
  c = c + lift * (1.0 - clamp(c, 0.0, 1.0));
  c = pow(max(c, 0.0), 1.0 / max(vec3(0.05), vec3(1.0) + gamma));
  c = c * (vec3(1.0) + gain);
  // ---- 비네팅
  if (doVig > 0.5 && abs(vig) > 0.001) {
    vec2 q = (P() / res - 0.5) * 2.0;
    float aspect = res.x / res.y;
    float d;
    if (vigRound >= 0.0) { q.x *= mix(1.0, aspect, vigRound); q /= mix(1.0, aspect, vigRound * 0.5); d = length(q); }
    else { float e = 2.0 + (-vigRound) * 8.0; d = pow(pow(abs(q.x), e) + pow(abs(q.y), e), 1.0 / e); }
    float mid = mix(0.25, 1.45, vigMid);
    float fe = mix(0.04, 1.2, vigFeather);
    float vv = smoothstep(mid - fe * 0.5, mid + fe * 0.5, d);
    if (vig < 0.0) c *= 1.0 + vig * 0.2 * vv;
    else c = mix(c, vec3(1.0), vig * 0.2 * vv);
  }
  o = pm(vec4(clamp(c, 0.0, 1.0), s.a));
}`;

const HSL_KEY = `
uniform vec3 key; uniform vec3 range; uniform float soft;
void main(){
  vec4 s = unpm(S(P()));
  vec3 h = rgb2hsl(s.rgb); vec3 k = rgb2hsl(key);
  float dh = abs(h.x - k.x); dh = min(dh, 1.0 - dh) * 360.0;
  float hueGate = k.y < 0.08 ? 1.0 : smoothstep(0.02, 0.1, h.y);
  float f = max(soft, 0.02);
  float mh = range.x >= 179.0 ? 1.0 : 1.0 - smoothstep(range.x, range.x * (1.0 + f * 2.0) + 2.0, dh);
  float ms = 1.0 - smoothstep(range.y, range.y + f * 0.5 + 0.01, abs(h.y - k.y));
  float ml = 1.0 - smoothstep(range.z, range.z + f * 0.5 + 0.01, abs(h.z - k.z));
  float m = mh * mix(1.0, hueGate, step(0.08, k.y)) * ms * ml * s.a;
  o = vec4(vec3(m), 1.0);
}`;

const HSL_FIX = `
uniform sampler2D matte; uniform float inv; uniform float show; uniform float denoise;
uniform vec3 wb; uniform float con; uniform float sharp; uniform float sat; uniform vec3 shift;
uniform float vig, vigMid, vigRound, vigFeather;
void main(){
  vec2 p = P();
  vec4 s = unpm(S(p));
  float m = texture(matte, p / res).r;
  if (denoise > 0.0) m = smoothstep(denoise * 0.45, 1.0 - denoise * 0.45, m);
  if (inv > 0.5) m = 1.0 - m;
  vec3 c = s.rgb;
  vec3 x = c * wb;
  x = (x - 0.5) * (1.0 + con) + 0.5;
  if (abs(sharp) > 0.001) {
    vec3 n4 = unpm(S(p + vec2(1.0, 0.0))).rgb + unpm(S(p - vec2(1.0, 0.0))).rgb + unpm(S(p + vec2(0.0, 1.0))).rgb + unpm(S(p - vec2(0.0, 1.0))).rgb;
    x += (c - n4 * 0.25) * sharp * 1.6;
  }
  x = mix(vec3(luma(x)), x, sat) + shift;
  c = mix(c, clamp(x, 0.0, 1.0), m);
  if (show > 0.5) c = mix(vec3(luma(s.rgb) * 0.35 + 0.3), c, m);
  if (abs(vig) > 0.001) {
    vec2 q = (p / res - 0.5) * 2.0;
    float aspect = res.x / res.y;
    float d;
    if (vigRound >= 0.0) { q.x *= mix(1.0, aspect, vigRound); q /= mix(1.0, aspect, vigRound * 0.5); d = length(q); }
    else { float e = 2.0 + (-vigRound) * 8.0; d = pow(pow(abs(q.x), e) + pow(abs(q.y), e), 1.0 / e); }
    float vv = smoothstep(mix(0.25, 1.45, vigMid) - mix(0.04, 1.2, vigFeather) * 0.5, mix(0.25, 1.45, vigMid) + mix(0.04, 1.2, vigFeather) * 0.5, d);
    if (vig < 0.0) c *= 1.0 + vig * 0.2 * vv;
    else c = mix(c, vec3(1.0), vig * 0.2 * vv);
  }
  o = pm(vec4(clamp(c, 0.0, 1.0), s.a));
}`;

const isIdentityCurve = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);
const isFlatHue = (pts) => !pts || pts.every(([, y]) => Math.abs(y - 0.5) < 1e-4);

function wbVec(temp, tint, picked = null) {
  const t = (temp || 0) / 100;
  const n = (tint || 0) / 100;
  const v = [1 + 0.3 * t + 0.12 * n, 1 - 0.3 * n, 1 - 0.3 * t + 0.12 * n];
  if (picked) {
    // 흰색 균형 선택기: gains that turn the picked colour neutral grey
    const [r, g, b] = hexRgb(picked).map((x) => Math.max(0.02, x));
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    [r, g, b].forEach((x, i) => {
      v[i] *= clamp(l / x, 0.4, 2.5);
    });
  }
  const l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return v.map((x) => x / l);
}

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

const scratches = new Map();
function scratch(name, w, h) {
  let c = scratches.get(name);
  if (!c) scratches.set(name, (c = document.createElement('canvas')));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else c.getContext('2d').clearRect(0, 0, w, h);
  return c;
}

/**
 * Grade `canvas` (w × h stage pixels) with Lumetri values v. lut(id) returns an imported LUT
 * ({ size, data }) for the input LUT / Look; k = stage pixels per sequence pixel. Returns the
 * graded canvas (to be copied by the caller) or null when nothing could be done.
 */
export function applyLumetri(canvas, v, { lut = () => null, k = 1 } = {}) {
  const e = glfx();
  if (!e) return lumetriFallback(canvas, v);
  const gl = e.gl;
  const w = canvas.width;
  const h = canvas.height;
  // tables: RGB curve (unit 4), hue curves (unit 5)
  const curves = v.curves || {};
  const useCurves = !['master', 'r', 'g', 'b'].every((ch) => isIdentityCurve(curves[ch]));
  const hcv = v.hueCurves || {};
  const useHue = !['hueSat', 'hueHue', 'hueLuma', 'lumaSat', 'satSat'].every((ch) => isFlatHue(hcv[ch]));
  // 3D LUTs: input LUT (unit 6), look (unit 7)
  const inLut = v.inputLut ? lut(v.inputLut) : null;
  let lookLut = null;
  if (v.look) lookLut = isBuiltinLook(v.look) ? { id: v.look } : lut(v.look);
  const hslOn = !!v.hslOn;
  const n = (x, d = 0) => (x ?? d) / 100;
  const vigU = { vig: v.vigAmount || 0, vigMid: n(v.vigMid, 50), vigRound: n(v.vigRound, 0), vigFeather: n(v.vigFeather, 50) };
  let out;
  try {
    out = e.run('lumetri', GRADE, canvas, {
      uniforms: {
        wb: wbVec(v.temperature, v.tint, v.wbColor),
        exposure: v.exposure || 0, contrast: n(v.contrast), highlights: n(v.highlights), shadows: n(v.shadows), whites: n(v.whites), blacks: n(v.blacks),
        sat: n(v.saturation, 100), faded: n(v.fadedFilm), sharp: n(v.sharpen), vib: n(v.vibrance), csat: n(v.creativeSat, 100), tintBal: n(v.tintBalance),
        shTint: wheelOffset(v.shadowTint, 0.25), hiTint: wheelOffset(v.highlightTint, 0.25),
        curves: useCurves ? 1 : 0, hueCurves: useHue ? 1 : 0,
        lift: wheelOffset(v.shadowsWheel, 0.25).map((x) => x + n(v.shadowsLevel) * 0.25),
        gamma: wheelOffset(v.midsWheel, 0.5).map((x) => x + n(v.midsLevel) * 0.5),
        gain: wheelOffset(v.highlightsWheel, 0.5).map((x) => x + n(v.highlightsLevel) * 0.5),
        ...vigU, doVig: hslOn ? 0 : 1,
        lookAmt: n(v.lookIntensity, 100),
      },
      before: (gl2, pr, loc) => {
        gl2.uniform1i(loc('curve'), 4);
        gl2.uniform1i(loc('hcurve'), 5);
        gl2.uniform1i(loc('lutIn'), 6);
        gl2.uniform1i(loc('lutLook'), 7);
        if (useCurves) {
          e.table(4, JSON.stringify(curves), () => {
            const master = curveTable(curves.master);
            const r = curveTable(curves.r);
            const g = curveTable(curves.g);
            const b = curveTable(curves.b);
            const data = new Uint8Array(256 * 4);
            const at = (tab, x) => tab[Math.round(clamp(x, 0, 1) * 255)];
            for (let i = 0; i < 256; i++) {
              const m = master[i];
              data[i * 4] = Math.round(at(r, m) * 255);
              data[i * 4 + 1] = Math.round(at(g, m) * 255);
              data[i * 4 + 2] = Math.round(at(b, m) * 255);
              data[i * 4 + 3] = 255;
            }
            return { data, width: 256, height: 1 };
          });
        }
        if (useHue) {
          e.table(5, JSON.stringify(hcv), () => {
            // same interpolation as the curve editor in Effect Controls draws (curveTable)
            const hs = curveTable(hcv.hueSat || [[0, 0.5], [1, 0.5]]);
            const hh = curveTable(hcv.hueHue || [[0, 0.5], [1, 0.5]]);
            const hl = curveTable(hcv.hueLuma || [[0, 0.5], [1, 0.5]]);
            const ls = curveTable(hcv.lumaSat || [[0, 0.5], [1, 0.5]]);
            const ss = curveTable(hcv.satSat || [[0, 0.5], [1, 0.5]]);
            const data = new Uint8Array(256 * 2 * 4);
            for (let i = 0; i < 256; i++) {
              data.set([hs[i] * 255, hh[i] * 255, hl[i] * 255, ls[i] * 255].map(Math.round), i * 4);
              data.set([Math.round(ss[i] * 255), 0, 0, 255], 1024 + i * 4);
            }
            return { data, width: 256, height: 2 };
          });
        }
        let lin = null;
        if (inLut) lin = e.lut3d(6, lutKey(inLut), () => inLut);
        let llk = null;
        if (lookLut) llk = e.lut3d(7, lookLut.id ? `look:${lookLut.id}` : lutKey(lookLut), () => (lookLut.id ? bakeLook(lookLut.id) : lookLut));
        // a 3D texture must be bound to every sampler3D unit even when unused
        if (!lin) e.lut3d(6, 'identity', () => identityLut());
        if (!llk) e.lut3d(7, 'identity', () => identityLut());
        gl2.uniform1f(loc('inLut'), lin ? 1 : 0);
        gl2.uniform1f(loc('inLutSize'), lin ? lin.size : 2);
        gl2.uniform1f(loc('look'), llk ? 1 : 0);
        gl2.uniform1f(loc('lookSize'), llk ? llk.size : 2);
        if (!useCurves) e.table(4, 'flat', () => ({ data: new Uint8Array(4), width: 1, height: 1 }));
        if (!useHue) e.table(5, 'flat', () => ({ data: new Uint8Array(4), width: 1, height: 1 }));
      },
    });
  } catch (err) {
    console.warn('Lumetri failed', err);
    return lumetriFallback(canvas, v);
  }
  if (!hslOn) return out;
  // HSL 보조: key the graded image, clean the matte, then correct inside it (and vignette)
  const graded = scratch('lum:g', w, h);
  graded.getContext('2d').drawImage(out, 0, 0);
  const key = e.run('lumetri-hslkey', HSL_KEY, graded, {
    uniforms: { key: hexRgb(v.hslColor), range: [v.hslHue ?? 30, n(v.hslSat, 60) * 0.5, n(v.hslLum, 60) * 0.5], soft: n(v.hslSoft, 40) },
  });
  let matte = scratch('lum:m', w, h);
  const mx = matte.getContext('2d');
  const blurPx = (n(v.hslBlur) * 20 + n(v.hslDenoise, 10) * 2) * Math.max(0.25, k);
  if (blurPx > 0.3) mx.filter = `blur(${blurPx}px)`;
  mx.drawImage(key, 0, 0);
  mx.filter = 'none';
  return e.run('lumetri-hslfix', HSL_FIX, graded, {
    textures: { matte },
    uniforms: {
      inv: v.hslInvert ? 1 : 0, show: v.hslShow ? 1 : 0, denoise: n(v.hslDenoise, 10) * 0.6,
      wb: wbVec(v.hslTemp, v.hslTint), con: n(v.hslContrast), sharp: n(v.hslSharpen), sat: n(v.hslSaturation, 100),
      shift: wheelOffset(v.hslWheel, 0.35),
      ...vigU,
    },
  });
}

const lutIds = new WeakMap();
let lutSeq = 0;
/** Stable cache key for a LUT object (a re-imported file gets a new key). */
function lutKey(lut) {
  if (!lutIds.has(lut)) lutIds.set(lut, ++lutSeq);
  return `lut${lutIds.get(lut)}`;
}

/** 'LUT 적용' effect: a .cube table at `intensity` (0..1). Returns the canvas or null. */
export function applyLut(canvas, lut, intensity) {
  const e = glfx();
  if (!e || !lut) return null;
  return e.run('lut', `
uniform sampler3D lut; uniform float size; uniform float amt; uniform vec3 dmin; uniform vec3 dmax;
void main(){
  vec4 s = unpm(S(P()));
  vec3 c = clamp((s.rgb - dmin) / max(dmax - dmin, vec3(1e-5)), 0.0, 1.0);
  vec3 g = texture(lut, c * ((size - 1.0) / size) + 0.5 / size).rgb;
  o = pm(vec4(mix(s.rgb, clamp(g, 0.0, 1.0), amt), s.a));
}`, canvas, {
    uniforms: { size: lut.size, amt: clamp(intensity, 0, 1), dmin: lut.domainMin || [0, 0, 0], dmax: lut.domainMax || [1, 1, 1] },
    before: (gl, pr, loc) => {
      gl.uniform1i(loc('lut'), 6);
      e.lut3d(6, lutKey(lut), () => lut);
    },
  });
}

let idLut = null;
function identityLut() {
  if (!idLut) {
    const data = new Float32Array(2 * 2 * 2 * 3);
    let o = 0;
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) data.set([r, g, b], (o++) * 3);
    idLut = { size: 2, data };
  }
  return idLut;
}

/** Canvas-filter approximation used when WebGL2 is unavailable (tone, saturation, temperature, vignette). */
function lumetriFallback(canvas, v) {
  const w = canvas.width;
  const h = canvas.height;
  const out = scratch('lum:fb', w, h);
  const x = out.getContext('2d');
  const n = (a, d = 0) => (a ?? d) / 100;
  const bright = Math.pow(2, (v.exposure || 0) * 0.8) * (1 + n(v.shadows) * 0.15 + n(v.highlights) * 0.1 + n(v.whites) * 0.1 + n(v.blacks) * 0.05);
  const sat = n(v.saturation, 100) * n(v.creativeSat, 100) * (1 + n(v.vibrance) * 0.3);
  x.filter = `brightness(${Math.max(0, bright)}) contrast(${Math.max(0, 1 + n(v.contrast))}) saturate(${Math.max(0, sat)})`;
  x.drawImage(canvas, 0, 0);
  x.filter = 'none';
  const temp = n(v.temperature);
  if (Math.abs(temp) > 0.01) {
    x.globalCompositeOperation = 'overlay';
    x.fillStyle = temp > 0 ? `rgba(255,150,40,${Math.abs(temp) * 0.5})` : `rgba(40,140,255,${Math.abs(temp) * 0.5})`;
    x.fillRect(0, 0, w, h);
  }
  const vig = v.vigAmount || 0;
  if (Math.abs(vig) > 0.01) {
    const r = Math.hypot(w, h) / 2;
    const g = x.createRadialGradient(w / 2, h / 2, r * (0.2 + n(v.vigMid, 50) * 0.6), w / 2, h / 2, r);
    const c = vig < 0 ? '0,0,0' : '255,255,255';
    g.addColorStop(0, `rgba(${c},0)`);
    g.addColorStop(1, `rgba(${c},${Math.min(1, Math.abs(vig) * 0.2)})`);
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  }
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(canvas, 0, 0);
  x.globalCompositeOperation = 'source-over';
  return out;
}

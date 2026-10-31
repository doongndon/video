// Renderers of the Premiere Pro style video effects defined in fx-defs.js (Distort, Generate,
// Keying, Stylize, Time, Transition, Color Correction, Blur …). Most run as WebGL2 shaders through
// the shared engine in glfx.js at the stage resolution (preview size while editing, full size on
// export); without WebGL2 they are skipped (the clip draws unchanged), except 변형 which falls back
// to canvas drawing. See fx-registry.js for the renderer arguments.

import { PIXEL_FX } from './fx-registry.js';
import { shade, rgb01 } from './glfx.js';
import { evalEffect } from './model.js';
import { clamp } from './util.js';

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- helpers

const scratchMap = new Map();
/** A named scratch canvas of the given size, cleared (shared by every compositor; use immediately). */
export function scratch(name, w, h) {
  let c = scratchMap.get(name);
  if (!c) {
    c = document.createElement('canvas');
    scratchMap.set(name, c);
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return c;
}

/** Copy of `src` padded by `pad` pixels on every side, repeating the edge pixels. */
function padEdges(src, pad, name) {
  const w = src.width;
  const h = src.height;
  const c = scratch(name, w + pad * 2, h + pad * 2);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(src, pad, pad);
  x.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
  x.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h);
  x.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  x.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad);
  x.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  x.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  x.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  x.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  x.imageSmoothingEnabled = true;
  return c;
}

const BLUR1D = `
uniform vec2 dir; uniform float sigma; uniform float clampEdge;
void main(){
  vec2 p = P();
  float n = min(64.0, ceil(sigma * 3.0));
  float st = sigma * 3.0 / max(n, 1.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -64; i <= 64; i++) {
    float fi = float(i);
    if (abs(fi) > n) continue;
    float x = fi * st;
    float w = exp(-x * x / (2.0 * sigma * sigma));
    vec2 q = p + dir * x;
    acc += (clampEdge > 0.5 ? S(q) : St(q)) * w;
    ws += w;
  }
  o = acc / max(ws, 1e-5);
}`;

/**
 * Gaussian blur of a canvas with standard deviations sx / sy (stage pixels). `repeat` keeps the
 * frame edges solid (가장자리 픽셀 반복) instead of fading them into transparency. Returns a canvas
 * (a scratch canvas, or `src` itself when there is nothing to blur).
 */
export function blurCanvas(src, sx, sy, repeat, name = 'blur') {
  const w = src.width;
  const h = src.height;
  sx = Math.max(0, sx || 0);
  sy = Math.max(0, sy || 0);
  if (sx < 0.25 && sy < 0.25) return src;
  if (Math.abs(sx - sy) < 0.01) {
    const out = scratch(name, w, h);
    const x = out.getContext('2d');
    if (!repeat) {
      x.filter = `blur(${sx}px)`;
      x.drawImage(src, 0, 0);
      x.filter = 'none';
      return out;
    }
    const pad = Math.ceil(sx * 3) + 1;
    const padded = padEdges(src, pad, `${name}:pad`);
    const tmp = scratch(`${name}:tmp`, w + pad * 2, h + pad * 2);
    const t = tmp.getContext('2d');
    t.filter = `blur(${sx}px)`;
    t.drawImage(padded, 0, 0);
    t.filter = 'none';
    x.drawImage(tmp, pad, pad, w, h, 0, 0, w, h);
    return out;
  }
  // different blur per axis: two separable shader passes
  let cur = src;
  for (const [s, dir, tag] of [[sx, [1, 0], 'h'], [sy, [0, 1], 'v']]) {
    if (s < 0.25) continue;
    const g = shade('blur1d', BLUR1D, cur, { uniforms: { dir, sigma: s, clampEdge: repeat ? 1 : 0 } });
    if (!g) return cur;
    const out = scratch(`${name}:${tag}`, w, h);
    out.getContext('2d').drawImage(g, 0, 0);
    cur = out;
  }
  return cur;
}

/** Draw a generated layer over the stage with a Premiere generate-effect blending mode. */
function composite(a, layer, mode, opacity = 1) {
  const c = a.ctx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = clamp(opacity, 0, 1);
  c.globalCompositeOperation = mode === 'none' ? 'copy' : mode === 'normal' ? 'source-over' : mode === 'add' ? 'lighter' : mode;
  c.drawImage(layer, 0, 0, a.w, a.h);
  c.restore();
}

/** Mix a processed result with the original stage (원본과 혼합): returns nothing, draws in place. */
function blendOriginal(a, out, keepOriginal) {
  const c = a.ctx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = clamp(1 - keepOriginal, 0, 1);
  c.drawImage(out, 0, 0, a.w, a.h);
  c.restore();
}

const pt = (a, X, Y) => a.map(X, Y);

// ---------------------------------------------------------------- 변형 (Transform) with motion blur

const TRANSFORM = `
uniform vec4 M[128]; uniform float N; uniform float opac;
vec4 samp(vec2 q){
  vec2 d = min(q, srcRes - q);
  float cov = clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
  return texture(src, clamp(q, vec2(0.5), srcRes - 0.5) / srcRes) * cov;
}
void main(){
  vec2 p = P();
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (float(i) >= N) break;
    vec4 r0 = M[i * 2]; vec4 r1 = M[i * 2 + 1];
    acc += samp(vec2(r0.x * p.x + r0.y * p.y + r0.z, r1.x * p.x + r1.y * p.y + r1.z));
  }
  o = acc / N * opac;
}`;

/** Forward 2×3 matrix (stage px → stage px) of the 변형 effect values v. */
function transformMatrix(a, v) {
  const sy = (v.scaleH ?? 100) / 100;
  const sx = v.uniform !== false ? sy : (v.scaleW ?? 100) / 100;
  const rot = (v.rotation || 0) * RAD;
  const sk = Math.tan(clamp(v.skew || 0, -85, 85) * RAD);
  const ax = (v.skewAxis || 0) * RAD;
  // M = R(rot) · R(ax) · shear(sk) · R(-ax) · S(sx, sy)
  const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
  const R = (t) => [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
  let m = mul(R(rot), mul(R(ax), mul([1, sk, 0, 1], mul(R(-ax), [sx, 0, 0, sy]))));
  const [px, py] = pt(a, v.posX, v.posY);
  const [qx, qy] = pt(a, v.anchorX, v.anchorY);
  // out = m · (in − anchor) + position
  return [m[0], m[1], px - (m[0] * qx + m[1] * qy), m[2], m[3], py - (m[2] * qx + m[3] * qy)];
}

function invert23(m) {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[4] / det;
  const b = -m[1] / det;
  const d = -m[3] / det;
  const e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

PIXEL_FX.transform = (a) => {
  const { v, fx, tl } = a;
  const fps = a.seq?.fps || 30;
  const shutter = v.compShutter === false ? clamp(v.shutter || 0, 0, 720) : 0;
  const times = [tl];
  if (shutter > 0 && fx) {
    // sample the transform across the shutter interval (centred on the frame, like Premiere)
    const span = shutter / 360 / fps;
    const m0 = transformMatrix(a, evalEffect(fx, tl - span / 2));
    const m1 = transformMatrix(a, evalEffect(fx, tl + span / 2));
    let d = 0;
    for (const [x, y] of [[0, 0], [a.w, 0], [0, a.h], [a.w, a.h], [a.w / 2, a.h / 2]]) {
      d = Math.max(d, Math.hypot(m0[0] * x + m0[1] * y + m0[2] - (m1[0] * x + m1[1] * y + m1[2]), m0[3] * x + m0[4] * y + m0[5] - (m1[3] * x + m1[4] * y + m1[5])));
    }
    const n = clamp(Math.ceil(d / 1.5) + 1, 1, 64);
    if (n > 1) {
      times.length = 0;
      for (let i = 0; i < n; i++) times.push(tl + (i / (n - 1) - 0.5) * span);
    }
  }
  const mats = times.map((t) => (t === tl ? transformMatrix(a, v) : transformMatrix(a, evalEffect(fx, t))));
  const opac = clamp((v.opacity ?? 100) / 100, 0, 1);
  const inv = mats.map(invert23);
  if (inv.some((m) => !m)) {
    a.ctx.clearRect(0, 0, a.w, a.h);
    return undefined;
  }
  const arr = new Float32Array(inv.length * 8);
  inv.forEach((m, i) => arr.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0], i * 8));
  const out = shade('transform', TRANSFORM, a.canvas, { uniforms: { M: { vec4: arr }, N: inv.length, opac }, mip: true });
  if (out) return out;
  // canvas fallback (no WebGL2): average the samples by drawing them with decreasing weight
  const copy = scratch('transform:fb', a.w, a.h);
  copy.getContext('2d').drawImage(a.canvas, 0, 0);
  const c = a.ctx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, a.w, a.h);
  mats.forEach((m, i) => {
    c.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
    c.globalAlpha = opac / (i + 1);
    c.drawImage(copy, 0, 0);
  });
  c.restore();
  return undefined;
};

// ---------------------------------------------------------------- homography warps (모서리 고정, 기본 3D)

const WARP = `
uniform vec3 H0; uniform vec3 H1; uniform vec3 H2; uniform vec2 inRes;
uniform float spec; uniform mat3 R; uniform float dist; uniform float focal; uniform vec2 c0;
void main(){
  vec2 p = P();
  vec3 q = vec3(dot(H0, vec3(p, 1.0)), dot(H1, vec3(p, 1.0)), dot(H2, vec3(p, 1.0)));
  if (q.z <= 1e-6) { o = vec4(0.0); return; }
  vec2 s = q.xy / q.z;
  vec2 d = min(s, inRes - s);
  float cov = clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
  vec4 c = texture(src, clamp(s, vec2(0.5), inRes - 0.5) / srcRes) * cov;
  if (spec > 0.5 && c.a > 0.0) {
    vec3 X = R * vec3(s - c0, 0.0) + vec3(0.0, 0.0, dist);
    vec3 N = normalize(R * vec3(0.0, 0.0, -1.0));
    vec3 V = normalize(vec3(0.0, 0.0, -focal) - X);
    if (dot(N, V) < 0.0) N = -N;
    vec3 L = normalize(vec3(-0.45, -0.55, -1.0));
    float sp = pow(max(dot(reflect(-L, N), V), 0.0), 60.0);
    c.rgb = min(c.rgb + vec3(sp * 0.9) * c.a, vec3(c.a));
  }
  o = c;
}`;

/** Homography taking the unit square (0,0),(1,0),(1,1),(0,1) to quad q (4 points). */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

function inv33(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const mul33 = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));

function warp(a, Hinv, extra = {}) {
  if (!Hinv) {
    a.ctx.clearRect(0, 0, a.w, a.h);
    return undefined;
  }
  return shade('warp', WARP, a.canvas, {
    uniforms: { H0: Hinv.slice(0, 3), H1: Hinv.slice(3, 6), H2: Hinv.slice(6, 9), inRes: [a.w, a.h], spec: 0, ...extra },
    before: (gl, pr, loc) => {
      if (extra.R9) gl.uniformMatrix3fv(loc('R'), false, extra.R9);
    },
  }) || undefined;
}

PIXEL_FX.cornerPin = (a) => {
  const { v } = a;
  const W = a.seq.width;
  const H = a.seq.height;
  // corners are in layer pixels scaled to the sequence frame (a frame-filling clip: its own pixels)
  const c = (X, Y) => [(X / W) * a.w, (Y / H) * a.h];
  const Hq = squareToQuad([c(v.ulX, v.ulY), c(v.urX, v.urY), c(v.lrX, v.lrY), c(v.llX, v.llY)]);
  // stage px → unit square → source px
  const inv = inv33(Hq);
  return warp(a, inv && mul33([a.w, 0, 0, 0, a.h, 0, 0, 0, 1], inv));
};

PIXEL_FX.basic3d = (a) => {
  const { v } = a;
  const sw = (v.swivel || 0) * RAD;
  const tt = (v.tilt || 0) * RAD;
  const Ry = [Math.cos(sw), 0, Math.sin(sw), 0, 1, 0, -Math.sin(sw), 0, Math.cos(sw)];
  const Rx = [1, 0, 0, 0, Math.cos(tt), -Math.sin(tt), 0, Math.sin(tt), Math.cos(tt)];
  const R = mul33(Rx, Ry);
  const f = 1.39 * a.seq.width * a.k;
  const dist = ((v.distance || 0) / 100) * f;
  const cx = a.w / 2;
  const cy = a.h / 2;
  // screen = c0 + f·(R·(x, y, 0)).xy / (f + (R·(x, y, 0)).z + dist), with x, y centred source px
  const Hc = [f * R[0], f * R[1], 0, f * R[3], f * R[4], 0, R[6], R[7], f + dist];
  const H = mul33(mul33([1, 0, cx, 0, 1, cy, 0, 0, 1], Hc), [1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  // column-major 3×3 for GLSL
  const R9 = new Float32Array([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
  return warp(a, inv33(H), { spec: v.specular ? 1 : 0, dist, focal: f, c0: [cx, cy], R9 });
};

// ---------------------------------------------------------------- distortions

PIXEL_FX.lensDistortion = (a) => {
  const { v } = a;
  const [fr, fg, fb] = rgb01(v.fillColor);
  return shade('lens', `
uniform float k; uniform vec2 dc; uniform vec2 prism; uniform float fillA; uniform vec3 fill;
void main(){
  vec2 p = P();
  vec2 c = srcRes * 0.5 + dc * srcRes * 0.5;
  float R = length(srcRes) * 0.5;
  vec2 d = (p - c) / R;
  float r2 = dot(d, d);
  vec2 q = d * (1.0 + k * r2);
  q += prism * vec2(q.y * q.y, q.x * q.x);
  vec2 s = c + q * R;
  vec2 e = min(s, srcRes - s);
  float cov = clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
  vec4 col = texture(src, clamp(s, vec2(0.5), srcRes - 0.5) / srcRes) * cov;
  o = fillA > 0.5 ? col : col + vec4(fill, 1.0) * (1.0 - cov);
}`, a.canvas, { uniforms: { k: (-(v.curvature || 0) / 100) * 0.55, dc: [-(v.hDecenter || 0) / 100, -(v.vDecenter || 0) / 100], prism: [(v.hPrism || 0) / 200, (v.vPrism || 0) / 200], fillA: v.fillAlpha !== false ? 1 : 0, fill: [fr, fg, fb] } }) || undefined;
};

PIXEL_FX.mirror = (a) => {
  const { v } = a;
  const [cx, cy] = pt(a, v.centerX, v.centerY);
  const t = (v.angle || 0) * RAD;
  return shade('mirror', `
uniform vec2 c; uniform vec2 n;
void main(){
  vec2 p = P();
  float d = dot(p - c, n);
  if (d > 0.0) p -= 2.0 * d * n;
  o = St(p);
}`, a.canvas, { uniforms: { c: [cx, cy], n: [Math.cos(t), Math.sin(t)] } }) || undefined;
};

PIXEL_FX.offset = (a) => {
  const { v } = a;
  const [sx, sy] = pt(a, v.shiftX, v.shiftY);
  const out = shade('offset', `
uniform vec2 sh;
void main(){ o = Sw(P() - sh); }`, a.canvas, { uniforms: { sh: [sx - a.w / 2, sy - a.h / 2] } });
  if (!out) return undefined;
  blendOriginal(a, out, (v.blend || 0) / 100);
  return undefined;
};

PIXEL_FX.replicate = (a) => shade('replicate', `
uniform float n;
void main(){ o = S(fract(P() / res * n) * srcRes); }`, a.canvas, { uniforms: { n: clamp(Math.round(a.v.count || 2), 1, 16) } }) || undefined;

PIXEL_FX.twirl = (a) => {
  const { v } = a;
  const [cx, cy] = pt(a, v.centerX, v.centerY);
  return shade('twirl', `
uniform vec2 c; uniform float ang; uniform float R;
void main(){
  vec2 p = P();
  vec2 d = p - c;
  float r = length(d);
  if (r < R) {
    float f = 1.0 - r / R;
    float th = -ang * f * f;
    d = mat2(cos(th), sin(th), -sin(th), cos(th)) * d;
  }
  o = St(c + d);
}`, a.canvas, { uniforms: { c: [cx, cy], ang: (v.angle || 0) * RAD, R: Math.max(1, ((v.radius || 0) / 100) * Math.max(a.w, a.h)) } }) || undefined;
};

const WAVE_TYPES = ['sine', 'square', 'triangle', 'saw', 'circle', 'semicircle', 'uncircle', 'noise', 'smooth'];
PIXEL_FX.waveWarp = (a) => {
  const { v } = a;
  const th = (v.direction ?? 90) * RAD;
  return shade('wave', `
uniform float type; uniform float amp; uniform float wl; uniform vec2 tv; uniform float ph; uniform float pin;
float wave(float x){
  float f = fract(x);
  if (type < 0.5) return sin(x * 2.0 * PI);
  if (type < 1.5) return f < 0.5 ? 1.0 : -1.0;
  if (type < 2.5) return 1.0 - 4.0 * abs(f - 0.5);
  if (type < 3.5) return 2.0 * f - 1.0;
  if (type < 4.5) { float u = 2.0 * f - 1.0; return sqrt(max(0.0, 1.0 - u * u)) * (fract(x * 0.5) < 0.5 ? 1.0 : -1.0); }
  if (type < 5.5) { float u = 2.0 * f - 1.0; return sqrt(max(0.0, 1.0 - u * u)) * 2.0 - 1.0; }
  if (type < 6.5) { float u = 2.0 * f - 1.0; return 1.0 - sqrt(max(0.0, 1.0 - u * u)) * 2.0; }
  if (type < 7.5) return hash(vec2(floor(x * 8.0), 3.7)) * 2.0 - 1.0;
  return vnoise(vec2(x * 4.0, 1.3)) * 2.0 - 1.0;
}
void main(){
  vec2 p = P();
  vec2 nv = vec2(-tv.y, tv.x);
  float along = dot(p, tv) / wl;
  float d = amp * wave(along - ph);
  if (pin > 0.5) {
    vec2 e = min(p, res - p);
    d *= smoothstep(0.0, min(res.x, res.y) * 0.08, min(e.x, e.y));
  }
  if (pin > 1.5) d *= 1.0 - smoothstep(0.0, min(res.x, res.y) * 0.25, length(p - res * 0.5));
  o = St(p - nv * d);
}`, a.canvas, {
    uniforms: {
      type: Math.max(0, WAVE_TYPES.indexOf(v.wave)),
      amp: (v.height || 0) * a.k,
      wl: Math.max(1, (v.width || 40) * a.k),
      tv: [Math.sin(th), -Math.cos(th)],
      ph: (v.speed || 0) * a.tl + (v.phase || 0) / 360,
      pin: v.pinning === 'all' ? 1 : v.pinning === 'center' ? 2 : 0,
    },
  }) || undefined;
};

PIXEL_FX.spherize = (a) => {
  const { v } = a;
  const [cx, cy] = pt(a, v.centerX, v.centerY);
  const R = (v.radius || 0) * a.k;
  if (R < 1) return undefined;
  return shade('spherize', `
uniform vec2 c; uniform float R;
void main(){
  vec2 p = P();
  vec2 d = p - c;
  float r = length(d);
  if (r < R && r > 1e-4) d *= (R * asin(r / R) * 2.0 / PI) / r;
  o = St(c + d);
}`, a.canvas, { uniforms: { c: [cx, cy], R } }) || undefined;
};

const TURB = ['turbulent', 'bulge', 'twist', 'horizontal', 'vertical', 'cross'];
PIXEL_FX.turbulentDisplace = (a) => {
  const { v } = a;
  const [ox, oy] = pt(a, v.offsetX, v.offsetY);
  return shade('turb', `
uniform float mode; uniform float amt; uniform float size; uniform vec2 off; uniform float cpx; uniform float ev; uniform float pin;
float F(vec2 n, float s){ return fbm3(vec3(n + s, ev), cpx); }
void main(){
  vec2 p = P();
  vec2 n = (p - off) / size;
  vec2 d;
  if (mode < 0.5) d = vec2(F(n, 0.0), F(n, 17.3)) - 0.5;
  else if (mode < 2.5) {
    float e = 0.05;
    vec2 g = vec2(F(n + vec2(e, 0.0), 0.0) - F(n - vec2(e, 0.0), 0.0), F(n + vec2(0.0, e), 0.0) - F(n - vec2(0.0, e), 0.0)) / (2.0 * e);
    d = mode < 1.5 ? -g * 0.25 : vec2(-g.y, g.x) * 0.25;
  }
  else if (mode < 3.5) d = vec2(F(vec2(0.0, n.y), 0.0) - 0.5, 0.0);
  else if (mode < 4.5) d = vec2(0.0, F(vec2(n.x, 0.0), 5.1) - 0.5);
  else d = vec2(F(vec2(n.x * 0.3, n.y * 3.0), 0.0), F(vec2(n.x * 3.0, n.y * 0.3), 9.0)) - 0.5;
  d *= amt;
  if (pin > 0.5) { vec2 e2 = min(p, res - p); d *= smoothstep(0.0, size * 0.5, min(e2.x, e2.y)); }
  o = St(p + d);
}`, a.canvas, {
    uniforms: {
      mode: Math.max(0, TURB.indexOf(v.mode)),
      amt: (v.amount || 0) * 0.5 * a.k,
      size: Math.max(2, (v.size || 100) * a.k),
      off: [ox, oy],
      cpx: clamp(v.complexity || 1, 1, 8),
      ev: (v.evolution || 0) / 360,
      pin: v.pinning === 'all' ? 1 : 0,
    },
  }) || undefined;
};

// ---------------------------------------------------------------- blur & sharpen

PIXEL_FX.directionalBlur = (a) => {
  const { v } = a;
  const len = (v.length || 0) * a.k;
  if (len < 0.5) return undefined;
  const th = (v.direction || 0) * RAD;
  return shade('dirblur', `
uniform vec2 dir; uniform float n;
void main(){
  vec2 p = P();
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 96; i++) {
    if (float(i) >= n) break;
    acc += St(p + dir * (float(i) / max(n - 1.0, 1.0) - 0.5));
  }
  o = acc / n;
}`, a.canvas, { uniforms: { dir: [Math.sin(th) * len, -Math.cos(th) * len], n: clamp(Math.ceil(len), 2, 96) } }) || undefined;
};

PIXEL_FX.channelBlur = (a) => {
  const { v } = a;
  const s = (x) => Math.max(0, (x || 0) * a.k);
  const ax = v.dims === 'v' ? 0 : 1;
  const ay = v.dims === 'h' ? 0 : 1;
  const chans = [s(v.red), s(v.green), s(v.blue), s(v.alpha)];
  if (chans.every((x) => x < 0.25)) return undefined;
  const tex = {};
  ['R', 'G', 'B', 'A'].forEach((n, i) => {
    const b = blurCanvas(a.canvas, chans[i] * ax, chans[i] * ay, !!v.repeatEdges, `chblur${n}`);
    tex[`t${n}`] = b === a.canvas ? a.canvas : b;
  });
  return shade('chblur', `
uniform sampler2D tR; uniform sampler2D tG; uniform sampler2D tB; uniform sampler2D tA;
void main(){
  vec2 uv = P() / res;
  float al = texture(tA, uv).a;
  vec3 r = vec3(unpm(texture(tR, uv)).r, unpm(texture(tG, uv)).g, unpm(texture(tB, uv)).b);
  o = vec4(r * al, al);
}`, a.canvas, { textures: tex }) || undefined;
};

PIXEL_FX.cameraBlur = (a) => {
  const r = (a.v.amount || 0) * 0.3 * a.k;
  if (r < 0.4) return undefined;
  return shade('camblur', `
uniform float r;
void main(){
  vec2 p = P();
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 64; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / 64.0) * r;
    float th = fi * 2.39996323;
    vec4 c = S(p + vec2(cos(th), sin(th)) * rr);
    float l = c.a > 0.0 ? luma(c.rgb / c.a) : 0.0;
    float w = 1.0 + 6.0 * l * l * l * l;
    acc += c * w; ws += w;
  }
  o = acc / ws;
}`, a.canvas, { uniforms: { r } }) || undefined;
};

PIXEL_FX.unsharpMask = (a) => {
  const { v } = a;
  const sigma = Math.max(0.1, (v.radius || 1) * a.k);
  const b = blurCanvas(a.canvas, sigma, sigma, true, 'usm');
  return shade('usm', `
uniform sampler2D bl; uniform float amt; uniform float th;
void main(){
  vec2 p = P();
  vec4 c = unpm(S(p)); vec4 b = unpm(texture(bl, p / res));
  vec3 d = c.rgb - b.rgb;
  vec3 m = step(vec3(th), abs(d));
  o = pm(vec4(clamp(c.rgb + d * amt * m, 0.0, 1.0), c.a));
}`, a.canvas, { textures: { bl: b }, uniforms: { amt: (v.amount || 0) / 100, th: (v.threshold || 0) / 255 } }) || undefined;
};

// ---------------------------------------------------------------- colour

PIXEL_FX.procAmp = (a) => {
  const { v } = a;
  return shade('procamp', `
uniform float br; uniform float ct; uniform float hue; uniform float sat; uniform float split;
void main(){
  vec2 p = P();
  vec4 c = unpm(S(p));
  if (p.x <= split) {
    vec3 x = c.rgb + br;
    x = (x - 0.5) * ct + 0.5;
    vec3 hsv = rgb2hsv(clamp(x, 0.0, 1.0));
    hsv.x = fract(hsv.x + hue);
    hsv.y = clamp(hsv.y * sat, 0.0, 1.0);
    c.rgb = hsv2rgb(hsv);
  }
  o = pm(vec4(clamp(c.rgb, 0.0, 1.0), c.a));
}`, a.canvas, { uniforms: { br: (v.brightness || 0) / 100 * 0.5, ct: (v.contrast ?? 100) / 100, hue: (v.hue || 0) / 360, sat: (v.saturation ?? 100) / 100, split: v.split ? a.w * clamp((v.splitPct ?? 50) / 100, 0, 1) : a.w + 1 } }) || undefined;
};

PIXEL_FX.channelMixer = (a) => {
  const { v } = a;
  const n = (x) => (x || 0) / 100;
  return shade('chmix', `
uniform vec4 r; uniform vec4 g; uniform vec4 b; uniform float mono;
void main(){
  vec4 c = unpm(S(P()));
  vec3 x = vec3(dot(r.xyz, c.rgb) + r.w, dot(g.xyz, c.rgb) + g.w, dot(b.xyz, c.rgb) + b.w);
  if (mono > 0.5) x = vec3(x.r);
  o = pm(vec4(clamp(x, 0.0, 1.0), c.a));
}`, a.canvas, { uniforms: { r: [n(v.rr), n(v.rg), n(v.rb), n(v.rc)], g: [n(v.gr), n(v.gg), n(v.gb), n(v.gc)], b: [n(v.br), n(v.bg), n(v.bb), n(v.bc)], mono: v.mono ? 1 : 0 } }) || undefined;
};

PIXEL_FX.colorBalance = (a) => {
  const { v } = a;
  const n = (x) => ((x || 0) / 100) * 0.35;
  return shade('colbal', `
uniform vec3 sh; uniform vec3 md; uniform vec3 hi; uniform float keepL;
void main(){
  vec4 c = unpm(S(P()));
  float l = luma(c.rgb);
  float ws = 1.0 - smoothstep(0.0, 0.5, l);
  float wh = smoothstep(0.5, 1.0, l);
  float wm = max(0.0, 1.0 - ws - wh);
  vec3 x = clamp(c.rgb + sh * ws + md * wm + hi * wh, 0.0, 1.0);
  if (keepL > 0.5) { float l2 = luma(x); x = clamp(x + (l - l2), 0.0, 1.0); }
  o = pm(vec4(x, c.a));
}`, a.canvas, { uniforms: { sh: [n(v.sr), n(v.sg), n(v.sb)], md: [n(v.mr), n(v.mg), n(v.mb)], hi: [n(v.hr), n(v.hg), n(v.hb)], keepL: v.preserveLum ? 1 : 0 } }) || undefined;
};

const COLOR_MATCH = `
float hueDist(float a, float b){ float d = abs(a - b); return min(d, 1.0 - d) * 2.0; }
float colorDist(vec3 c, vec3 k, float mode){
  if (mode < 0.5) return length(c - k) / 1.7320508;
  vec3 hc = rgb2hsl(c); vec3 hk = rgb2hsl(k);
  if (mode < 1.5) return hueDist(hc.x, hk.x) + (1.0 - smoothstep(0.02, 0.12, hc.y)) * 0.6;
  return abs(hc.y - hk.y);
}`;

PIXEL_FX.leaveColor = (a) => {
  const { v } = a;
  return shade('leavecolor', `${COLOR_MATCH}
uniform vec3 key; uniform float amt; uniform float tol; uniform float soft; uniform float mode;
void main(){
  vec4 c = unpm(S(P()));
  float d = colorDist(c.rgb, key, mode);
  float keep = 1.0 - smoothstep(tol, tol + soft + 1e-3, d);
  float l = luma(c.rgb);
  o = pm(vec4(mix(vec3(l), c.rgb, mix(1.0 - amt, 1.0, keep)), c.a));
}`, a.canvas, { uniforms: { key: rgb01(v.color), amt: (v.amount ?? 100) / 100, tol: (v.tolerance ?? 15) / 100, soft: (v.softness || 0) / 100, mode: v.match === 'hue' ? 1 : 0 } }) || undefined;
};

PIXEL_FX.changeColor = (a) => {
  const { v } = a;
  return shade('changecolor', `${COLOR_MATCH}
uniform vec3 key; uniform float tol; uniform float soft; uniform float mode; uniform vec3 tr; uniform float view; uniform float inv;
void main(){
  vec4 c = unpm(S(P()));
  float m = 1.0 - smoothstep(tol, tol + soft + 1e-3, colorDist(c.rgb, key, mode));
  if (inv > 0.5) m = 1.0 - m;
  if (view > 0.5) { o = vec4(vec3(m) * c.a, c.a); return; }
  vec3 h = rgb2hsl(c.rgb);
  h.x = fract(h.x + tr.x * m);
  h.z = clamp(h.z + tr.y * m * (tr.y > 0.0 ? 1.0 - h.z : h.z), 0.0, 1.0);
  h.y = clamp(h.y + tr.z * m * (tr.z > 0.0 ? 1.0 - h.y : h.y), 0.0, 1.0);
  o = pm(vec4(hsl2rgb(h), c.a));
}`, a.canvas, { uniforms: { key: rgb01(v.color), tol: (v.tolerance ?? 15) / 100, soft: (v.softness || 0) / 100, mode: v.match === 'hue' ? 1 : v.match === 'chroma' ? 2 : 0, tr: [(v.hue || 0) / 360, (v.lightness || 0) / 100, (v.saturation || 0) / 100], view: v.view === 'mask' ? 1 : 0, inv: v.invert ? 1 : 0 } }) || undefined;
};

PIXEL_FX.changeToColor = (a) => {
  const { v } = a;
  const modes = ['hue', 'hueLight', 'hueLightSat', 'colorize'];
  return shade('changeto', `
uniform vec3 from; uniform vec3 to; uniform float mode; uniform vec3 tol; uniform float soft; uniform float show;
void main(){
  vec4 c = unpm(S(P()));
  vec3 h = rgb2hsl(c.rgb); vec3 f = rgb2hsl(from); vec3 t = rgb2hsl(to);
  float dh = abs(h.x - f.x); dh = min(dh, 1.0 - dh) * 2.0;
  float gate = smoothstep(0.03, 0.12, h.y);
  vec3 d = vec3(dh, abs(h.z - f.z), abs(h.y - f.y));
  vec3 e = clamp(d / max(tol, vec3(1e-3)), 0.0, 4.0);
  float m = (1.0 - smoothstep(1.0 - soft, 1.0 + soft, e.x)) * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, e.y)) * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, e.z)) * gate;
  if (show > 0.5) { o = vec4(vec3(m) * c.a, c.a); return; }
  vec3 n = h;
  n.x = mix(h.x, h.x + (t.x - f.x), m); n.x = fract(n.x);
  if (mode > 0.5) n.z = clamp(h.z + (t.z - f.z) * m, 0.0, 1.0);
  if (mode > 1.5) n.y = clamp(h.y + (t.y - f.y) * m, 0.0, 1.0);
  if (mode > 2.5) { n.x = mix(h.x, t.x, m); n.y = mix(h.y, t.y, m); }
  o = pm(vec4(hsl2rgb(n), c.a));
}`, a.canvas, { uniforms: { from: rgb01(v.from), to: rgb01(v.to), mode: Math.max(0, modes.indexOf(v.change)), tol: [(v.tolHue ?? 5) / 100 * 4, (v.tolLight ?? 50) / 100, (v.tolSat ?? 50) / 100], soft: clamp((v.softness ?? 50) / 100, 0.01, 0.99) * 0.8, show: v.showMatte ? 1 : 0 } }) || undefined;
};

PIXEL_FX.shadowHighlight = (a) => {
  const { v } = a;
  const r = Math.max(0.5, ((v.shadowRadius ?? 30) + (v.highlightRadius ?? 30)) * 0.5 * a.k);
  const bl = blurCanvas(a.canvas, r, r, true, 'shhi');
  const out = shade('shhi', `
uniform sampler2D bl; uniform float sa; uniform float ha; uniform float sw; uniform float hw; uniform float cc; uniform float mc;
void main(){
  vec2 p = P();
  vec4 c = unpm(S(p));
  float L = luma(unpm(texture(bl, p / res)).rgb);
  float s = sa * (1.0 - smoothstep(0.0, max(sw, 0.02), L));
  float h = ha * smoothstep(1.0 - max(hw, 0.02), 1.0, L);
  vec3 x = c.rgb;
  x = 1.0 - (1.0 - x) * pow(1.0 - x, vec3(s * 1.4));
  x = x * (1.0 - h * 0.55 * x);
  float l = luma(x);
  x = mix(vec3(l), x, 1.0 + (s + h) * cc);
  x = (x - 0.5) * (1.0 + mc) + 0.5;
  o = pm(vec4(clamp(x, 0.0, 1.0), c.a));
}`, a.canvas, { textures: { bl }, uniforms: { sa: (v.shadows ?? 50) / 100, ha: (v.highlights || 0) / 100, sw: (v.shadowWidth ?? 50) / 100, hw: (v.highlightWidth ?? 50) / 100, cc: (v.colorCorrection ?? 20) / 100, mc: (v.midContrast || 0) / 100 } });
  if (!out) return undefined;
  blendOriginal(a, out, (v.blend || 0) / 100);
  return undefined;
};

// ---------------------------------------------------------------- generate

PIXEL_FX.ramp = (a) => {
  const { v } = a;
  const [sx, sy] = pt(a, v.startX, v.startY);
  const [ex, ey] = pt(a, v.endX, v.endY);
  const out = shade('ramp', `
uniform vec2 s; uniform vec2 e; uniform vec3 c0; uniform vec3 c1; uniform float radial; uniform float scatter; uniform float keep;
void main(){
  vec2 p = P();
  vec4 c = unpm(S(p));
  vec2 d = e - s;
  float t = radial > 0.5 ? length(p - s) / max(length(d), 1e-3) : dot(p - s, d) / max(dot(d, d), 1e-3);
  t = clamp(t + (hash(p) - 0.5) * scatter, 0.0, 1.0);
  vec3 g = mix(c0, c1, t);
  o = pm(vec4(mix(g, c.rgb, keep), c.a));
}`, a.canvas, { uniforms: { s: [sx, sy], e: [ex, ey], c0: rgb01(v.startColor), c1: rgb01(v.endColor), radial: v.shape === 'radial' ? 1 : 0, scatter: (v.scatter || 0) / 100 * 0.25, keep: (v.blend || 0) / 100 } });
  return out || undefined;
};

PIXEL_FX.fourColorGradient = (a) => {
  const { v } = a;
  const P = [1, 2, 3, 4].map((i) => pt(a, v[`p${i}X`], v[`p${i}Y`]));
  const layer = shade('grad4', `
uniform vec2 p1; uniform vec2 p2; uniform vec2 p3; uniform vec2 p4;
uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform vec3 c4; uniform float pw; uniform float jit;
void main(){
  vec2 p = P();
  float a0 = S(p).a;
  vec2 q = p + (vec2(hash(p), hash(p + 3.1)) - 0.5) * jit;
  float w1 = 1.0 / pow(max(distance(q, p1), 1.0), pw);
  float w2 = 1.0 / pow(max(distance(q, p2), 1.0), pw);
  float w3 = 1.0 / pow(max(distance(q, p3), 1.0), pw);
  float w4 = 1.0 / pow(max(distance(q, p4), 1.0), pw);
  vec3 g = (c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4) / (w1 + w2 + w3 + w4);
  o = vec4(g * a0, a0);
}`, a.canvas, { uniforms: { p1: P[0], p2: P[1], p3: P[2], p4: P[3], c1: rgb01(v.c1), c2: rgb01(v.c2), c3: rgb01(v.c3), c4: rgb01(v.c4), pw: 1 + clamp(v.blend ?? 100, 1, 1000) / 60, jit: (v.jitter || 0) / 100 * 0.05 * Math.max(a.w, a.h) } });
  if (layer) composite(a, layer, v.mode || 'none', (v.opacity ?? 100) / 100);
  return undefined;
};

PIXEL_FX.lensFlare = (a) => {
  const { v } = a;
  const [fx, fy] = pt(a, v.centerX, v.centerY);
  const lens = v.lens === 'prime35' ? 1 : v.lens === 'prime105' ? 2 : 0;
  const layer = shade('flare', `
uniform vec2 C; uniform float b; uniform float lens; uniform float sc;
vec3 ghost(vec2 p, vec2 at, float r, vec3 col, float hex){
  vec2 d = p - at;
  float dist = length(d);
  if (hex > 0.5) { vec2 q = abs(d); dist = max(q.x * 0.866 + q.y * 0.5, q.y); }
  return col * (1.0 - smoothstep(r * 0.7, r, dist)) * 0.35 + col * exp(-dist * dist / (r * r)) * 0.15;
}
void main(){
  vec2 p = P();
  vec2 d = p - C;
  float r = length(d) / sc;
  vec3 col = vec3(1.0, 0.95, 0.85) * (exp(-r * r / 2500.0) * 1.2 + 6.0 / (1.0 + r * 0.35));
  col += vec3(1.0, 0.75, 0.5) * exp(-r * r / 40000.0) * 0.45;
  float an = atan(d.y, d.x);
  float spikes = lens > 1.5 ? 0.0 : lens > 0.5 ? 10.0 : 6.0;
  if (spikes > 0.0) col += vec3(1.0, 0.9, 0.8) * pow(abs(cos(an * spikes * 0.5)), 60.0) * exp(-r / 160.0) * 0.8;
  if (lens < 0.5) col += vec3(0.7, 0.8, 1.0) * exp(-abs(d.y / sc) / 2.5) * exp(-abs(d.x / sc) / 700.0) * 0.7;
  float ring = exp(-pow((r - 240.0) / 9.0, 2.0)) * 0.25;
  col += ring * vec3(0.6 + 0.4 * sin(an * 3.0), 0.7, 0.9 + 0.1 * cos(an * 2.0));
  vec2 axis = res * 0.5 - C;
  float hex = lens > 1.5 ? 1.0 : 0.0;
  col += ghost(p, C + axis * 0.45, 30.0 * sc, vec3(0.5, 0.9, 0.6), hex);
  col += ghost(p, C + axis * 0.8, 18.0 * sc, vec3(0.9, 0.6, 1.0), hex);
  col += ghost(p, C + axis * 1.25, 55.0 * sc, vec3(0.4, 0.6, 1.0), hex);
  col += ghost(p, C + axis * 1.55, 24.0 * sc, vec3(1.0, 0.7, 0.4), hex);
  col += ghost(p, C + axis * 2.1, 80.0 * sc, vec3(0.6, 1.0, 0.8), hex);
  col *= b;
  col = col / (1.0 + col * 0.15);
  o = vec4(col, max(col.r, max(col.g, col.b)));
}`, a.canvas, { uniforms: { C: [fx, fy], b: (v.brightness ?? 100) / 100, lens, sc: a.k * a.seq.width / 1920 } });
  if (!layer) return undefined;
  const keep = (v.blend || 0) / 100;
  composite(a, layer, 'add', 1 - keep);
  return undefined;
};

PIXEL_FX.checkerboard = (a) => {
  const { v } = a;
  const [ax, ay] = pt(a, v.anchorX, v.anchorY);
  const cw = Math.max(1, (v.width || 64) * a.k);
  const ch = Math.max(1, ((v.height || v.width || 64) * a.k));
  const layer = shade('checker', `
uniform vec2 an; uniform vec2 cell; uniform vec3 col; uniform float fe;
void main(){
  vec2 q = (P() - an) / cell;
  vec2 f = fract(q);
  float on = mod(floor(q.x) + floor(q.y), 2.0) < 0.5 ? 1.0 : 0.0;
  vec2 e = min(f, 1.0 - f) * cell;
  float edge = clamp(min(e.x, e.y) / max(fe, 0.5) + (fe > 0.5 ? 0.0 : 0.5), 0.0, 1.0);
  float al = on * edge;
  o = vec4(col * al, al);
}`, a.canvas, { uniforms: { an: [ax, ay], cell: [cw, ch], col: rgb01(v.color), fe: (v.feather || 0) * a.k } });
  if (layer) composite(a, layer, v.mode || 'none', (v.opacity ?? 100) / 100);
  return undefined;
};

PIXEL_FX.circle = (a) => {
  const { v } = a;
  const [cx, cy] = pt(a, v.centerX, v.centerY);
  const layer = shade('circle', `
uniform vec2 c; uniform float R; uniform float T; uniform float fo; uniform float fi; uniform float ring; uniform float inv; uniform vec3 col;
void main(){
  float d = length(P() - c);
  float outer = 1.0 - smoothstep(R - fo * 0.5 - 0.5, R + fo * 0.5 + 0.5, d);
  float al = outer;
  if (ring > 0.5) { float Ri = max(R - T, 0.0); al *= smoothstep(Ri - fi * 0.5 - 0.5, Ri + fi * 0.5 + 0.5, d); }
  if (inv > 0.5) al = 1.0 - al;
  o = vec4(col * al, al);
}`, a.canvas, { uniforms: { c: [cx, cy], R: (v.radius || 0) * a.k, T: (v.thickness || 0) * a.k, fo: (v.featherOuter || 0) * a.k, fi: (v.featherInner || 0) * a.k, ring: v.edge && v.edge !== 'none' ? 1 : 0, inv: v.invert ? 1 : 0, col: rgb01(v.color) } });
  if (layer) composite(a, layer, v.mode || 'none', (v.opacity ?? 100) / 100);
  return undefined;
};

PIXEL_FX.grid = (a) => {
  const { v } = a;
  const [ax, ay] = pt(a, v.anchorX, v.anchorY);
  const layer = shade('grid', `
uniform vec2 an; uniform vec2 cell; uniform float bd; uniform float fe; uniform float inv; uniform vec3 col;
void main(){
  vec2 m = mod(P() - an + bd * 0.5, cell);
  vec2 e = min(m, cell - m);
  float dline = min(m.x, m.y) - bd;
  float al = 1.0 - smoothstep(-0.5 - fe * 0.5, 0.5 + fe * 0.5, dline);
  if (inv > 0.5) al = 1.0 - al;
  o = vec4(col * al, al);
}`, a.canvas, { uniforms: { an: [ax, ay], cell: [Math.max(2, (v.width || 120) * a.k), Math.max(2, (v.height || 120) * a.k)], bd: (v.border ?? 3) * a.k, fe: (v.feather || 0) * a.k, inv: v.invert ? 1 : 0, col: rgb01(v.color) } });
  if (layer) composite(a, layer, v.mode || 'normal', (v.opacity ?? 100) / 100);
  return undefined;
};

PIXEL_FX.filmBurn = (a) => {
  const { v } = a;
  const layer = shade('filmburn', `
uniform float t; uniform float amt; uniform float sc; uniform float seed; uniform vec3 c1; uniform vec3 c2;
void main(){
  vec2 q = (P() - res * 0.5) / (max(res.x, res.y) * sc);
  vec2 cen = vec2(sin(t * 0.37 + seed) * 0.55, cos(t * 0.29 + seed * 1.7) * 0.4);
  float n = fbm3(vec3(q * 2.2 + seed, t * 0.18), 4.0);
  float m = fbm3(vec3(q * 1.4 - seed, t * 0.12 + 3.0), 3.0);
  float blob = 1.0 - smoothstep(0.0, 0.75, length(q - cen) - n * 0.45);
  float edge = smoothstep(0.25, 0.75, max(abs(q.x) * 1.1, abs(q.y) * 1.6) + n * 0.3 - 0.2);
  float vv = clamp(blob * 0.85 + edge * m * 0.9, 0.0, 1.0);
  vv = smoothstep(0.15, 0.95, vv) * amt;
  vec3 col = mix(c1, c2, smoothstep(0.35, 0.8, m + blob * 0.3)) * vv * 1.35;
  o = vec4(col, max(col.r, max(col.g, col.b)));
}`, a.canvas, { uniforms: { t: a.tl * (v.speed ?? 1), amt: (v.amount ?? 70) / 100, sc: (v.scale ?? 100) / 100, seed: (v.seed || 0) * 1.618, c1: rgb01(v.color1), c2: rgb01(v.color2) } });
  if (layer) composite(a, layer, v.mode || 'screen', 1);
  return undefined;
};

// ---------------------------------------------------------------- keying

const CBCR = `
vec2 cbcr(vec3 c){ return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b); }`;

const UK_MATTE = `${CBCR}
uniform vec3 key; uniform float transp; uniform float hi; uniform float sh; uniform float tol; uniform float ped;
void main(){
  vec4 s = unpm(S(P()));
  vec3 c = s.rgb;
  vec2 kc = cbcr(key); float kl = max(length(kc), 1e-3); vec2 kn = kc / kl;
  vec2 pc = cbcr(c);
  float along = dot(pc, kn) / kl;
  float across = abs(pc.x * kn.y - pc.y * kn.x) / kl;
  float keyness = along - across / mix(0.12, 1.1, tol);
  float m = clamp(keyness / mix(1.0, 0.3, transp), 0.0, 1.0);
  float lk = luma(key); float lp = luma(c);
  m *= 1.0 - hi * smoothstep(lk + 0.05, lk + 0.5, lp);
  m *= 1.0 - sh * (1.0 - smoothstep(lk - 0.5, lk - 0.08, lp));
  float al = 1.0 - m;
  float pd = ped * 0.35;
  al = clamp((al - pd) / max(1.0 - pd, 1e-3), 0.0, 1.0);
  al *= s.a;
  o = vec4(vec3(al), 1.0);
}`;

const UK_FINAL = `${CBCR}
uniform sampler2D matte; uniform vec3 key; uniform float con; uniform float mid; uniform float choke;
uniform float desat; uniform float range; uniform float spill; uniform float lumaP;
uniform float ccSat; uniform float ccHue; uniform float ccLum; uniform float outMode;
void main(){
  vec2 p = P();
  vec4 s = unpm(S(p));
  float al = texture(matte, p / res).r;
  if (choke > 0.0) al = clamp((al - choke) / max(1.0 - choke, 1e-3), 0.0, 1.0);
  if (con > 0.0) al = clamp((al - mid) * (1.0 + con * 6.0) + mid, 0.0, 1.0);
  vec3 c = s.rgb;
  vec2 kc = cbcr(key); float kl = max(length(kc), 1e-3); vec2 kn = kc / kl;
  vec2 pc = cbcr(c);
  float along = max(dot(pc, kn), 0.0) / kl;
  float amount = smoothstep(0.0, mix(0.15, 1.0, range), along) * spill;
  float Y = dot(c, vec3(0.299, 0.587, 0.114));
  pc -= kn * dot(pc, kn) * amount;
  pc *= 1.0 - desat * amount;
  Y += (lumaP - 0.5) * amount * 0.25;
  c = vec3(Y + 1.402 * pc.y, Y - 0.344136 * pc.x - 0.714136 * pc.y, Y + 1.772 * pc.x);
  vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
  hsv.x = fract(hsv.x + ccHue);
  hsv.y = clamp(hsv.y * ccSat, 0.0, 1.0);
  hsv.z = hsv.z * ccLum;
  c = clamp(hsv2rgb(hsv), 0.0, 1.0);
  if (outMode > 1.5) { o = vec4(c, 1.0); return; }
  if (outMode > 0.5) { o = vec4(vec3(al), 1.0); return; }
  o = vec4(c * al, al);
}`;

PIXEL_FX.ultraKey = (a) => {
  const { v } = a;
  const d = { relaxed: [-0.15, -0.12, -0.05, 0], aggressive: [0.15, 0.1, 0.1, 0.05] }[v.setting] || [0, 0, 0, 0];
  const n = (x, def) => clamp((x ?? def) / 100, 0, 1);
  const key = rgb01(v.keyColor);
  const matte = shade('ukmatte', UK_MATTE, a.canvas, {
    uniforms: { key, transp: clamp(n(v.transparency, 45) + d[0], 0, 1), hi: n(v.highlight, 10), sh: n(v.shadow, 50), tol: clamp(n(v.tolerance, 50) + d[1], 0, 1), ped: clamp(n(v.pedestal, 10) + d[2], 0, 1) },
  });
  if (!matte) return undefined;
  let m = scratch('ukm', a.w, a.h);
  m.getContext('2d').drawImage(matte, 0, 0);
  // 매트 정리: 경계 감소 (choke) erodes by blurring then raising the threshold; 부드럽게 blurs
  const choke = clamp(n(v.choke, 0) + d[3], 0, 1);
  const chokeR = choke * 12 * a.k;
  if (chokeR > 0.3) m = blurCanvas(m, chokeR, chokeR, true, 'ukc');
  const soft = n(v.soften, 0) * 20 * a.k;
  if (soft > 0.3) m = blurCanvas(m, soft, soft, true, 'uks');
  const outMode = v.output === 'alpha' ? 1 : v.output === 'color' ? 2 : 0;
  return shade('ukfinal', UK_FINAL, a.canvas, {
    textures: { matte: m },
    uniforms: {
      key, con: n(v.contrast, 0), mid: n(v.midpoint, 50), choke: chokeR > 0.3 ? choke * 0.5 : 0,
      desat: n(v.desaturate, 25), range: n(v.range, 50), spill: n(v.spill, 50), lumaP: n(v.luma, 50),
      ccSat: (v.ccSat ?? 100) / 100, ccHue: (v.ccHue || 0) / 360, ccLum: (v.ccLum ?? 100) / 100, outMode,
    },
  }) || undefined;
};

PIXEL_FX.lumaKey = (a) => {
  const { v } = a;
  return shade('lumakey', `
uniform float th; uniform float cut; uniform float bright; uniform float inv; uniform float show;
void main(){
  vec4 c = unpm(S(P()));
  float l = luma(c.rgb);
  float al = smoothstep(th - cut * 0.5, th + cut * 0.5 + 1e-4, l);
  if (bright > 0.5) al = 1.0 - al;
  if (inv > 0.5) al = 1.0 - al;
  al *= c.a;
  o = show > 0.5 ? vec4(vec3(al), 1.0) : vec4(c.rgb * al, al);
}`, a.canvas, { uniforms: { th: (v.threshold ?? 25) / 100, cut: (v.cutoff ?? 10) / 100, bright: v.mode === 'brighter' ? 1 : 0, inv: v.invert ? 1 : 0, show: v.output === 'alpha' ? 1 : 0 } }) || undefined;
};

PIXEL_FX.alphaAdjust = (a) => {
  const { v } = a;
  return shade('alphaadj', `
uniform float op; uniform float ign; uniform float inv; uniform float maskOnly;
void main(){
  vec4 c = unpm(S(P()));
  float al = ign > 0.5 ? 1.0 : c.a;
  if (inv > 0.5) al = 1.0 - al;
  al *= op;
  o = maskOnly > 0.5 ? vec4(vec3(al), al) : vec4(c.rgb * al, al);
}`, a.canvas, { uniforms: { op: (v.opacity ?? 100) / 100, ign: v.ignore ? 1 : 0, inv: v.invert ? 1 : 0, maskOnly: v.maskOnly ? 1 : 0 } }) || undefined;
};

/** The older 크로마 키 (색상 키) effect on the shared engine. */
PIXEL_FX.colorKey = (a) => {
  const { v } = a;
  const [r, g, b] = rgb01(v.keyColor);
  return shade('colorkey', `${CBCR}
uniform vec3 key; uniform float tol; uniform float soft; uniform float spill; uniform float mode;
void main(){
  vec4 c = unpm(S(P()));
  vec2 pc = cbcr(c.rgb); vec2 kc = cbcr(key);
  float pl = length(pc); float kl = max(length(kc), 1e-4);
  float cosA = dot(pc, kc) / (pl * kl + 1e-5);
  float sat = pl / kl;
  float m = (1.0 - smoothstep(tol, tol + soft + 1e-4, 1.0 - cosA)) * smoothstep(0.12, 0.12 + soft + 0.08, sat);
  vec3 col = c.rgb;
  if (mode > 0.5 && mode < 1.5) { float lim = (col.r + col.b) * 0.5; col.g = mix(col.g, min(col.g, lim), spill); }
  else if (mode > 1.5) { float lim = (col.r + col.g) * 0.5; col.b = mix(col.b, min(col.b, lim), spill); }
  float al = c.a * (1.0 - m);
  o = vec4(col * al, al);
}`, a.canvas, { uniforms: { key: [r, g, b], tol: ((v.tolerance ?? 30) / 100) * 0.3, soft: ((v.softness ?? 10) / 100) * 0.25, spill: (v.spill ?? 50) / 100, mode: g >= r && g >= b ? 1 : b >= r && b >= g ? 2 : 0 } }) || undefined;
};

// ---------------------------------------------------------------- noise & stylize

PIXEL_FX.noise = (a) => {
  const { v } = a;
  return shade('noise', `
uniform float amt; uniform float colorN; uniform float clipV; uniform float seed;
void main(){
  vec2 p = P();
  vec4 c = unpm(S(p));
  vec3 n = colorN > 0.5 ? vec3(hash(p + seed), hash(p + seed + 7.13), hash(p + seed + 3.71)) : vec3(hash(p + seed));
  vec3 x = c.rgb + (n - 0.5) * amt * 1.6;
  x = clipV > 0.5 ? clamp(x, 0.0, 1.0) : fract(x + 1.0);
  o = pm(vec4(x, c.a));
}`, a.canvas, { uniforms: { amt: (v.amount || 0) / 100, colorN: v.colorNoise !== false ? 1 : 0, clipV: v.clip !== false ? 1 : 0, seed: (Math.floor(a.t * 60) % 997) * 1.37 } }) || undefined;
};

PIXEL_FX.rgbSplit = (a) => {
  const { v } = a;
  let amt = (v.amount || 0) * a.k;
  if (v.jitter > 0) {
    const f = Math.floor(a.t * 24);
    const r = Math.sin(f * 12.9898 + 78.233) * 43758.5453;
    amt *= 1 + (v.jitter / 100) * ((r - Math.floor(r)) * 2 - 1);
  }
  const th = (v.angle || 0) * RAD;
  return shade('rgbsplit', `
uniform vec2 d; uniform float radial;
void main(){
  vec2 p = P();
  vec2 off = radial > 0.5 ? d * length((p - res * 0.5) / (res * 0.5)) : d;
  vec4 r = S(p + off); vec4 g = S(p); vec4 b = S(p - off);
  float al = max(g.a, max(r.a, b.a));
  o = vec4(r.r, g.g, b.b, al);
}`, a.canvas, { uniforms: { d: [Math.cos(th) * amt, Math.sin(th) * amt], radial: v.radial ? 1 : 0 } }) || undefined;
};

PIXEL_FX.glitch = (a) => {
  const { v } = a;
  return shade('glitch', `
uniform float t; uniform float amt; uniform float blk; uniform float split; uniform float scan; uniform float seed;
void main(){
  vec2 p = P();
  float slice = floor(t);
  float band = floor(p.y / blk);
  float r = hash(vec2(band, slice + seed));
  float on = step(1.0 - amt * 0.5, r);
  float shift = (hash(vec2(band * 1.7, slice * 3.1 + seed)) - 0.5) * 2.0 * blk * 2.5 * amt * on;
  vec2 cell = floor(p / (blk * 2.0));
  float r2 = hash(cell + vec2(slice * 1.3 + seed, 0.7));
  vec2 bshift = r2 > 1.0 - amt * 0.2 ? vec2((hash(cell * 2.3 + slice) - 0.5) * blk * 4.0, (hash(cell * 5.1 + slice) - 0.5) * blk) : vec2(0.0);
  vec2 q = p + vec2(shift, 0.0) + bshift;
  float sp = split * (0.35 + on) * (0.3 + amt);
  vec4 cr = S(q + vec2(sp, 0.0)); vec4 cg = S(q); vec4 cb = S(q - vec2(sp, 0.0));
  vec4 c = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
  if (hash(vec2(band, slice * 7.0 + seed)) > 1.0 - amt * 0.06) c.rgb = c.a - c.rgb;
  if (scan > 0.5) c.rgb *= 0.86 + 0.14 * step(0.5, fract(p.y / 3.0));
  o = c;
}`, a.canvas, { uniforms: { t: a.tl * (v.speed ?? 12), amt: (v.amount ?? 50) / 100, blk: Math.max(2, (v.block || 48) * a.k), split: (v.split || 0) * a.k, scan: v.scanlines !== false ? 1 : 0, seed: (v.seed || 0) * 0.731 } }) || undefined;
};

PIXEL_FX.vhs = (a) => {
  const { v } = a;
  const out = shade('vhs', `
uniform float t; uniform float bleed; uniform float nz; uniform float track; uniform float scan; uniform float fade; uniform float k;
void main(){
  vec2 p = P();
  float line = floor(p.y / (2.0 * k));
  float jit = (vnoise(vec2(line * 0.05, t * 8.0)) - 0.5) * track * 6.0 * k;
  float bandY = fract(t * 0.15) * res.y * 1.4 - res.y * 0.2;
  float inBand = exp(-pow((p.y - bandY) / (res.y * 0.03), 2.0));
  jit += inBand * track * 25.0 * k * (hash(vec2(line, floor(t * 30.0))) - 0.5);
  vec2 q = p + vec2(jit, 0.0);
  vec4 base = S(q);
  vec3 c = unpm(base).rgb;
  float Y = luma(c);
  vec3 acc = vec3(0.0);
  for (int i = -4; i <= 4; i++) acc += unpm(S(q + vec2(float(i) * bleed * 0.5 + bleed, 0.0))).rgb;
  acc /= 9.0;
  vec3 chroma = acc - luma(acc);
  c = Y + chroma * (1.0 - fade * 0.6);
  c += (hash(p + fract(t) * 100.0) - 0.5) * nz * 0.3 + inBand * nz * 0.35 * (hash(p * 1.3 + t) - 0.3);
  c *= 1.0 - scan * 0.3 * step(0.5, fract(p.y / (3.0 * k)));
  c = mix(c, c * vec3(1.05, 0.98, 0.9) + 0.035, fade);
  o = pm(vec4(clamp(c, 0.0, 1.0), base.a));
}`, a.canvas, { uniforms: { t: a.tl, bleed: (v.bleed ?? 6) * a.k, nz: (v.noise ?? 30) / 100, track: (v.tracking ?? 40) / 100, scan: (v.scanlines ?? 35) / 100, fade: (v.fade ?? 25) / 100, k: Math.max(0.25, a.k) } });
  if (!out) return undefined;
  blendOriginal(a, out, 1 - (v.amount ?? 70) / 100);
  return undefined;
};

PIXEL_FX.strobeLight = (a) => {
  const { v } = a;
  const period = Math.max(0.02, v.period || 0.5);
  const i = Math.floor(a.tl / period);
  const phase = a.tl - i * period;
  let on = phase < (v.duration ?? 0.05);
  if (v.random > 0) {
    const r = Math.sin(i * 91.3458 + 17.17) * 47453.5453;
    on = on && r - Math.floor(r) < v.random / 100;
  }
  if (!on) return undefined;
  const keep = (v.blend || 0) / 100;
  if (v.strobe === 'transparent') {
    a.ctx.save();
    a.ctx.globalCompositeOperation = 'destination-out';
    a.ctx.globalAlpha = 1 - keep;
    a.ctx.fillRect(0, 0, a.w, a.h);
    a.ctx.restore();
    return undefined;
  }
  const ops = ['copy', 'add', 'subtract', 'multiply', 'difference', 'screen', 'lighten', 'darken'];
  return shade('strobe', `
uniform vec3 col; uniform float op; uniform float keep;
void main(){
  vec4 c = unpm(S(P()));
  vec3 x = c.rgb;
  vec3 r;
  if (op < 0.5) r = col;
  else if (op < 1.5) r = x + col;
  else if (op < 2.5) r = x - col;
  else if (op < 3.5) r = x * col;
  else if (op < 4.5) r = abs(x - col);
  else if (op < 5.5) r = 1.0 - (1.0 - x) * (1.0 - col);
  else if (op < 6.5) r = max(x, col);
  else r = min(x, col);
  o = pm(vec4(mix(clamp(r, 0.0, 1.0), x, keep), c.a));
}`, a.canvas, { uniforms: { col: rgb01(v.color), op: Math.max(0, ops.indexOf(v.op)), keep } }) || undefined;
};

// ---------------------------------------------------------------- transform & transition effects

PIXEL_FX.edgeFeather = (a) => {
  const f = (a.v.amount || 0) * a.k;
  if (f < 0.5) return undefined;
  return shade('edgefeather', `
uniform float f;
void main(){
  vec2 p = P();
  vec2 e = min(p, res - p);
  o = S(p) * smoothstep(0.0, f, min(e.x, e.y));
}`, a.canvas, { uniforms: { f } }) || undefined;
};

PIXEL_FX.linearWipe = (a) => {
  const { v } = a;
  const c = clamp((v.completion || 0) / 100, 0, 1);
  if (c <= 0) return undefined;
  const th = (v.angle ?? 90) * RAD;
  const d = [Math.sin(th), -Math.cos(th)];
  const L = Math.abs(a.w * d[0]) + Math.abs(a.h * d[1]);
  const fs = ((v.feather || 0) * a.k) / Math.max(1, L);
  return shade('linwipe', `
uniform vec2 d; uniform float L; uniform float c; uniform float fs;
void main(){
  vec2 p = P();
  float s = dot(p - res * 0.5, d) / L + 0.5;
  float e = c * (1.0 + fs) - fs * 0.5;
  o = S(p) * smoothstep(e - fs * 0.5 - 1e-4, e + fs * 0.5 + 1e-4, s);
}`, a.canvas, { uniforms: { d, L, c, fs } }) || undefined;
};

PIXEL_FX.radialWipe = (a) => {
  const { v } = a;
  const c = clamp((v.completion || 0) / 100, 0, 1);
  if (c <= 0) return undefined;
  const [cx, cy] = pt(a, v.centerX, v.centerY);
  return shade('radwipe', `
uniform vec2 cen; uniform float c; uniform float st; uniform float mode; uniform float fe;
void main(){
  vec2 p = P();
  vec2 d = p - cen;
  float an = fract((atan(d.x, -d.y) - st) / (2.0 * PI) + 1.0);
  if (mode > 0.5 && mode < 1.5) an = 1.0 - an;
  if (mode > 1.5) an = min(an, 1.0 - an) * 2.0;
  float fa = fe / max(2.0 * PI * length(d), 1.0);
  float e = c * (1.0 + fa) - fa * 0.5;
  o = S(p) * smoothstep(e - fa * 0.5 - 1e-4, e + fa * 0.5 + 1e-4, an);
}`, a.canvas, { uniforms: { cen: [cx, cy], c, st: (v.start || 0) * RAD, mode: v.wipe === 'ccw' ? 1 : v.wipe === 'both' ? 2 : 0, fe: (v.feather || 0) * a.k } }) || undefined;
};

PIXEL_FX.venetianBlinds = (a) => {
  const { v } = a;
  const c = clamp((v.completion || 0) / 100, 0, 1);
  if (c <= 0) return undefined;
  const th = (v.direction || 0) * RAD;
  const wd = Math.max(2, (v.width || 60) * a.k);
  return shade('blinds', `
uniform vec2 d; uniform float wd; uniform float c; uniform float fe;
void main(){
  vec2 p = P();
  float s = fract(dot(p, d) / wd);
  float fs = fe / wd;
  float e = c * (1.0 + fs) - fs * 0.5;
  o = S(p) * smoothstep(e - fs * 0.5 - 1e-4, e + fs * 0.5 + 1e-4, s);
}`, a.canvas, { uniforms: { d: [Math.cos(th + Math.PI / 2), Math.sin(th + Math.PI / 2)], wd, c, fe: (v.feather || 0) * a.k } }) || undefined;
};

PIXEL_FX.gradientWipe = (a) => {
  const { v } = a;
  const c = clamp((v.completion || 0) / 100, 0, 1);
  if (c <= 0) return undefined;
  let grad = null;
  if (v.layer && a.comp?.renderTrack) grad = a.comp.renderTrack(v.layer, a.t, a.clip?.trackId);
  // gradient texture coordinates: stretch over the clip, centre at frame size, or tile
  const W = a.seq.width;
  const H = a.seq.height;
  const k = a.k;
  const mode = !grad ? 0 : v.placement === 'center' ? 2 : v.placement === 'tile' ? 3 : 1;
  return shade('gradwipe', `
uniform sampler2D g; uniform float mode; uniform float c; uniform float soft; uniform float inv; uniform vec2 frame;
void main(){
  vec2 p = P();
  vec4 s = S(p);
  float v;
  if (mode < 0.5) v = luma(unpm(s).rgb);
  else {
    vec2 uv = p / res;
    if (mode > 1.5) uv = (p - res * 0.5) / frame + 0.5;
    if (mode > 2.5) uv = fract(uv);
    vec4 gc = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(g, uv);
    v = luma(unpm(gc).rgb);
  }
  if (inv > 0.5) v = 1.0 - v;
  float e = c * (1.0 + 2.0 * soft) - soft;
  o = s * smoothstep(e - soft - 1e-4, e + soft + 1e-4, v);
}`, a.canvas, { textures: grad ? { g: grad } : {}, uniforms: { mode, c, soft: clamp((v.softness ?? 10) / 100, 0, 1) * 0.5, inv: v.invert ? 1 : 0, frame: [W * k, H * k] } }) || undefined;
};

// ---------------------------------------------------------------- time (반향, 포스터화 시간)

/**
 * Frame history per compositor and effect, for effects that look at earlier frames. A history
 * only holds a continuous run of frames (playback, export, frame stepping); a jump resets it.
 */
const histories = new WeakMap();
function historyOf(a, cap) {
  let byFx = histories.get(a.comp || PIXEL_FX);
  if (!byFx) histories.set(a.comp || PIXEL_FX, (byFx = new Map()));
  const key = `${a.clip?.id}:${a.fx?.id}`;
  let hst = byFx.get(key);
  if (!hst) {
    if (byFx.size > 24) byFx.clear();
    byFx.set(key, (hst = { frames: [], cap }));
  }
  hst.cap = cap;
  return hst;
}

function pushFrame(hst, a, fidx) {
  const last = hst.frames[hst.frames.length - 1];
  if (last && (fidx < last.f || fidx > last.f + 2 || last.c.width !== a.w || last.c.height !== a.h)) {
    // discontinuity (scrub, size change): start over, recycling the canvases
    hst.free = (hst.free || []).concat(hst.frames.map((x) => x.c));
    hst.frames = [];
  }
  const same = hst.frames.length && hst.frames[hst.frames.length - 1].f === fidx;
  let entry = same ? hst.frames[hst.frames.length - 1] : null;
  if (!entry) {
    let c = hst.free?.pop();
    if (!c && hst.frames.length >= hst.cap) c = hst.frames.shift().c;
    if (!c) c = document.createElement('canvas');
    entry = { f: fidx, c };
    hst.frames.push(entry);
  }
  if (entry.c.width !== a.w || entry.c.height !== a.h) {
    entry.c.width = a.w;
    entry.c.height = a.h;
  }
  const x = entry.c.getContext('2d');
  x.globalCompositeOperation = 'copy';
  x.drawImage(a.canvas, 0, 0);
  x.globalCompositeOperation = 'source-over';
  while (hst.frames.length > hst.cap) hst.free = (hst.free || []).concat([hst.frames.shift().c]);
}

/** Stills, text, shapes and mattes look the same at any time except for their effects. */
const STATIC = new Set(['image', 'text', 'shape', 'color']);

/** History budget: at most ~160 MB of frames per effect. */
const historyCap = (a, want) => clamp(Math.min(want, Math.floor(160e6 / Math.max(1, a.w * a.h * 4))), 2, 90);

/** Copy of the clip's stage at another frame (static sources: re-rendered exactly). */
function frameAt(a, fidx, fps, name) {
  const st = a.comp?.stageAt?.(a.clip, a.clip.start + fidx / fps, a.fx?.id, a.stage);
  if (!st) return null;
  const c = scratch(name, a.w, a.h);
  c.getContext('2d').drawImage(st, 0, 0, a.w, a.h);
  return c;
}

PIXEL_FX.echo = (a) => {
  const { v } = a;
  const fps = a.seq?.fps || 30;
  const count = clamp(Math.round(v.count || 0), 0, 20);
  const dt = v.time ?? -0.033;
  const fidx = Math.round(a.tl * fps);
  const step = dt * fps;
  const still = STATIC.has(a.clip?.kind) && a.comp?.stageAt && a.stage;
  let hst = null;
  if (!still) {
    const reach = Math.ceil(Math.abs(step) * count) + 1;
    hst = historyOf(a, historyCap(a, reach + 1));
    pushFrame(hst, a, fidx);
  }
  if (!count || Math.abs(step) < 0.5 || dt > 0) return undefined;
  const op = v.op || 'add';
  const start = clamp(v.start ?? 1, 0, 1);
  const decay = clamp(v.decay ?? 1, 0, 1);
  const ctx = a.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (op !== 'composite-front' && start < 1) {
    // the current frame at 시작 강도
    const cur = scratch('echo:cur', a.w, a.h);
    cur.getContext('2d').drawImage(a.canvas, 0, 0);
    ctx.clearRect(0, 0, a.w, a.h);
    ctx.globalAlpha = start;
    ctx.drawImage(cur, 0, 0);
  }
  const gco = { add: 'lighter', max: 'lighten', min: 'darken', screen: 'screen', 'composite-back': 'destination-over', 'composite-front': 'source-over', blend: 'source-over' }[op] || 'lighter';
  // 앞에 합성 stacks the farthest echo first so nearer ones end up on top; the others go nearest first
  const order = [];
  for (let i = 1; i <= count; i++) order.push(i);
  if (op === 'composite-front') order.reverse();
  for (const i of order) {
    const want = fidx + Math.round(step * i);
    if (want < 0) continue;
    let c = null;
    if (still) c = frameAt(a, want, fps, 'echo:tmp');
    else c = hst.frames.find((x) => x.f === want)?.c || null;
    if (!c) continue;
    ctx.globalCompositeOperation = gco;
    ctx.globalAlpha = op === 'blend' ? 1 / (i + 1) : start * Math.pow(decay, i);
    ctx.drawImage(c, 0, 0);
  }
  ctx.restore();
  return undefined;
};

PIXEL_FX.posterizeTime = (a) => {
  const rate = clamp(a.v.fps || 12, 1, 99);
  const bucket = Math.floor(a.tl * rate + 1e-6);
  if (STATIC.has(a.clip?.kind) && a.comp?.stageAt && a.stage) {
    // stills: show the effects as they were at the start of the step, exactly
    const fps = a.seq?.fps || 30;
    const f = Math.round((bucket / rate) * fps);
    if (f === Math.round(a.tl * fps)) return undefined;
    return frameAt(a, f, fps, 'post:tmp') || undefined;
  }
  const hst = historyOf(a, 1);
  const held = hst.held;
  if (held && held.bucket === bucket && held.c.width === a.w && held.c.height === a.h) return held.c;
  const c = held?.c || document.createElement('canvas');
  if (c.width !== a.w || c.height !== a.h) {
    c.width = a.w;
    c.height = a.h;
  }
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'copy';
  x.drawImage(a.canvas, 0, 0);
  x.globalCompositeOperation = 'source-over';
  hst.held = { bucket, c };
  return undefined;
};

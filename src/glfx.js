// Shared WebGL2 engine for shader-based video effects (distortions, generators, keyers, Lumetri).
// One context serves every compositor (browsers allow only a few WebGL contexts per page). Each
// run() renders one fragment shader over a source canvas and returns the engine's canvas, which
// the caller must draw (copy) before the next run.
//
// Shader conventions (see PRELUDE): `P()` is the output pixel in image coordinates (y down, pixel
// centres at .5), `S(p)` samples the source at an image position (edge-clamped), `St(p)` returns
// transparent outside the frame. Textures hold PREMULTIPLIED colour; use unpm()/pm() around
// colour maths. `res` is the output size in pixels.

const VS = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

export const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D src;
uniform vec2 res;
uniform vec2 srcRes;
out vec4 o;
const float PI = 3.14159265358979;
vec2 P(){ return vec2(gl_FragCoord.x, res.y - gl_FragCoord.y); }
vec4 S(vec2 p){ return texture(src, p / srcRes); }
vec4 St(vec2 p){ return (p.x < 0.0 || p.y < 0.0 || p.x > srcRes.x || p.y > srcRes.y) ? vec4(0.0) : texture(src, p / srcRes); }
vec4 Sw(vec2 p){ return texture(src, fract(p / srcRes)); }
vec4 unpm(vec4 c){ return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 pm(vec4 c){ return vec4(c.rgb * c.a, c.a); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 q = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 r = mix(vec4(q.xyw, c.r), vec4(c.r, q.yzx), step(q.x, c.r));
  float d = r.x - min(r.w, r.y);
  return vec3(abs(r.z + (r.w - r.y) / (6.0 * d + 1e-10)), d / (r.x + 1e-10), r.x);
}
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2hsl(vec3 c){
  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5; float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
vec3 hsl2rgb(vec3 c){
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
}
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash3(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash3(i), hash3(i + vec3(1,0,0)), u.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm3(vec3 p, float oct){
  float s = 0.0; float a = 0.5; float n = 0.0;
  for (int i = 0; i < 8; i++){ if (float(i) >= oct) break; s += a * vnoise3(p); n += a; p *= 2.03; a *= 0.5; }
  return s / max(n, 1e-4);
}
`;

class Engine {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 2;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.progs = new Map();
    this.textures = [];
    this.luts = new Map();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  program(key, body) {
    let pr = this.progs.get(key);
    if (pr) return pr;
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, PRELUDE + body]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`shader ${key}: ${log}`);
      }
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link ${key}: ${gl.getProgramInfoLog(prog)}`);
    pr = { prog, locs: new Map() };
    this.progs.set(key, pr);
    return pr;
  }

  loc(pr, name) {
    if (!pr.locs.has(name)) pr.locs.set(name, this.gl.getUniformLocation(pr.prog, name));
    return pr.locs.get(name);
  }

  texture(unit) {
    const gl = this.gl;
    if (!this.textures[unit]) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures[unit] = t;
    }
    return this.textures[unit];
  }

  /** Upload a canvas / image / video / {data, width, height} (RGBA8) into texture unit `unit`. */
  upload(unit, source) {
    const gl = this.gl;
    const t = this.texture(unit);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (source.data && source.width) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  /**
   * A cached 3D LUT texture. `key` identifies the table, `make()` returns { size, data: Float32Array
   * (RGB, r fastest), domainMin?, domainMax? } and is only called on a cache miss.
   */
  lut3d(unit, key, make) {
    const gl = this.gl;
    let hit = this.luts.get(key);
    if (!hit) {
      const lut = make();
      if (!lut) return null;
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
      hit = { t, lut };
      if (this.luts.size > 24) {
        for (const v of this.luts.values()) gl.deleteTexture(v.t);
        this.luts.clear();
      }
      this.luts.set(key, hit);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, hit.t);
    return hit.lut;
  }

  /** A 256×N RGBA8 data texture (curve tables), cached by key. */
  table(unit, key, make) {
    const gl = this.gl;
    this.tables = this.tables || new Map();
    let hit = this.tables.get(unit);
    if (!hit || hit.key !== key) {
      const { data, width, height } = make();
      if (!hit) hit = { t: gl.createTexture() };
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, hit.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      hit.key = key;
      this.tables.set(unit, hit);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, hit.t);
  }

  /**
   * Render shader `body` (GLSL defining main(), appended to PRELUDE) with `source` bound as `src`.
   * opts: { width, height (output, default = source size), uniforms: { name: number | [2..4] |
   * { vec4: Float32Array } | { vec2: Float32Array } | { int: n } }, textures: { name: canvas } (bound
   * from unit 1 up), before(gl, pr) for custom bindings }. Returns the engine canvas.
   */
  run(key, body, source, opts = {}) {
    const gl = this.gl;
    const pr = this.program(key, body);
    const sw = source.width;
    const sh = source.height;
    const w = Math.max(1, Math.round(opts.width || sw));
    const h = Math.max(1, Math.round(opts.height || sh));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(pr.prog);
    gl.bindVertexArray(this.vao);
    this.upload(0, source);
    // mipmaps let strongly shrunk warps (변형 at 20 %) sample smoothly
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (opts.mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1i(this.loc(pr, 'src'), 0);
    gl.uniform2f(this.loc(pr, 'res'), w, h);
    gl.uniform2f(this.loc(pr, 'srcRes'), sw, sh);
    let unit = 1;
    for (const [name, tex] of Object.entries(opts.textures || {})) {
      if (!tex) continue;
      this.upload(unit, tex);
      gl.uniform1i(this.loc(pr, name), unit);
      unit++;
    }
    if (opts.before) opts.before(gl, pr, (name) => this.loc(pr, name), unit);
    for (const [name, v] of Object.entries(opts.uniforms || {})) {
      const l = this.loc(pr, name);
      if (l == null || v == null) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
      else if (v.vec4) gl.uniform4fv(l, v.vec4);
      else if (v.vec2) gl.uniform2fv(l, v.vec2);
      else if (v.vec3) gl.uniform3fv(l, v.vec3);
      else if (v.float) gl.uniform1fv(l, v.float);
      else if (v.int != null) gl.uniform1i(l, v.int);
      else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    }
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let engine = null;
let failed = false;

/** The shared engine, or null when WebGL2 is unavailable (callers fall back or skip the effect). */
export function glfx() {
  if (engine && (engine.lost || engine.gl.isContextLost())) engine = null;
  if (!engine && !failed) {
    try {
      engine = new Engine();
    } catch (err) {
      console.warn('WebGL2 effects unavailable', err);
      failed = true;
    }
  }
  return engine;
}

/** Run a shader if WebGL2 works; returns the output canvas or null (also logs shader errors once). */
const reported = new Set();
export function shade(key, body, source, opts) {
  const e = glfx();
  if (!e) return null;
  try {
    return e.run(key, body, source, opts);
  } catch (err) {
    if (!reported.has(key)) {
      reported.add(key);
      console.warn(err);
    }
    return null;
  }
}

/** '#rrggbb' → [r, g, b] in 0..1. */
export function rgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

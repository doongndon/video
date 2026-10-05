// More of Photoshop's Filter menu: blur (blur, blur more, box, lens, smart, spin), sharpen (sharpen
// more, sharpen edges, smart sharpen), reduce noise, facet, distort (displace, ripple, shear),
// stylize (extrude, trace contour), render (difference clouds, fibers, lighting effects), other
// (custom kernel) and video (de-interlace, NTSC colours). Registered into FILTERS like fx2.js.
// These are our own approximations: the same settings give a similar look, not Photoshop's pixels.

import { FILTERS } from './adjust.js';
import {
  mk, read, toCanvas, lum, cl, clamp, smooth, hexRgb, rng, grayOf, boxBlurF, gaussF, sobelF, noiseF,
  dirBlur, blurred, remap, kuwahara, cloneImg,
} from './fxutil.js';

/** Apply a float-array operation to each channel, premultiplied so transparent pixels don't bleed. */
function perChannel(img, op) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const ch = [0, 1, 2, 3].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) ch[c][i] = d[i * 4 + c] * a;
    ch[3][i] = d[i * 4 + 3];
  }
  const res = ch.map((a) => op(a, w, h));
  const out = new ImageData(w, h);
  for (let i = 0; i < n; i++) {
    const a = res[3][i];
    out.data[i * 4 + 3] = a;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = a > 0.5 ? cl((res[c][i] * 255) / a) : 0;
  }
  return out;
}

/** Disc-shaped (lens) blur of a small picture with bright spots made brighter first. */
function discBlur(img, r, bright, threshold) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const offs = [];
  const R = Math.max(1, Math.round(r));
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= R * R + R * 0.5) offs.push([x, y]);
  // work in a gamma-ish "light" space so highlights bloom like real bokeh
  const lin = [0, 1, 2].map(() => new Float32Array(n));
  const boost = 1 + bright / 20;
  for (let i = 0; i < n; i++) {
    const L = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const k = L >= threshold ? boost : 1;
    for (let c = 0; c < 3; c++) lin[c][i] = (d[i * 4 + c] / 255) ** 2.2 * k;
  }
  const out = new ImageData(w, h);
  const inv = 1 / offs.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      for (const [ox, oy] of offs) {
        const j = clamp(y + oy, 0, h - 1) * w + clamp(x + ox, 0, w - 1);
        r0 += lin[0][j];
        g0 += lin[1][j];
        b0 += lin[2][j];
      }
      const o = (y * w + x) * 4;
      out.data[o] = cl((r0 * inv) ** (1 / 2.2) * 255);
      out.data[o + 1] = cl((g0 * inv) ** (1 / 2.2) * 255);
      out.data[o + 2] = cl((b0 * inv) ** (1 / 2.2) * 255);
      out.data[o + 3] = d[o + 3];
    }
  }
  return out;
}

/** A displacement: each output pixel takes the source pixel at (x + dx, y + dy). */
function displaceBy(c, fn, wrap = false) {
  const w = c.width;
  const h = c.height;
  return remap(c, (x, y, o) => {
    fn(x, y, o);
    let sx = x + o[0];
    let sy = y + o[1];
    if (wrap) {
      sx = ((sx % w) + w) % w;
      sy = ((sy % h) + h) % h;
    }
    o[0] = sx;
    o[1] = sy;
  });
}

const F = {
  // ---- blur
  blur: {
    name: '흐림 효과', group: '흐림 효과', params: [],
    fn: (c) => blurred(c, 0.8),
  },
  blurMore: {
    name: '더 흐리게', group: '흐림 효과', params: [],
    fn: (c) => blurred(c, 1.8),
  },
  boxBlur: {
    name: '상자 흐림 효과', group: '흐림 효과', params: [['radius', '반경 (px)', 1, 200, 10]],
    fn(c, p) {
      return toCanvas(perChannel(read(c), (a, w, h) => boxBlurF(a, w, h, p.radius, 1)));
    },
  },
  lensBlur: {
    name: '렌즈 흐림 효과', group: '흐림 효과', slow: true,
    params: [['radius', '반경 (px)', 1, 100, 15], ['bright', '반사 밝기', 0, 100, 30], ['threshold', '반사 한계값', 0, 255, 230], ['noise', '노이즈 (%)', 0, 20, 0]],
    fn(c, p) {
      // a wide disc on a smaller copy, scaled back up (the look of an out-of-focus lens)
      const f = Math.max(1, p.radius / 7);
      const sw = Math.max(1, Math.round(c.width / f));
      const sh = Math.max(1, Math.round(c.height / f));
      const s = mk(sw, sh);
      const sg = s.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(c, 0, 0, sw, sh);
      const b = toCanvas(discBlur(read(s), p.radius / f, p.bright, p.threshold));
      const out = mk(c.width, c.height);
      const og = out.getContext('2d');
      og.imageSmoothingQuality = 'high';
      og.drawImage(b, 0, 0, c.width, c.height);
      // keep the original transparency
      og.globalCompositeOperation = 'destination-in';
      og.drawImage(c, 0, 0);
      if (p.noise > 0) {
        const img = read(out);
        const r = rng(7);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (r() - 0.5) * p.noise * 5;
          for (let k = 0; k < 3; k++) img.data[i + k] = cl(img.data[i + k] + n);
        }
        return toCanvas(img);
      }
      return out;
    },
  },
  smartBlur: {
    name: '고급 흐림 효과', group: '흐림 효과', slow: true,
    params: [['radius', '반경', 0.5, 100, 4, 0.5], ['threshold', '한계값', 1, 100, 25], ['mode', '모드', null, null, 'normal', [['normal', '표준'], ['edges', '가장자리만'], ['overlay', '가장자리 겹치기']]]],
    fn(c, p) {
      // blur only where the picture is smooth: a pixel close to its blurred self takes the blur
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const b = read(blurred(c, p.radius)).data;
      const L = grayOf(img);
      const { mag } = sobelF(L, w, h);
      const out = cloneImg(img);
      const o = out.data;
      const t = p.threshold * 2.5;
      for (let i = 0; i < w * h; i++) {
        const k = i * 4;
        const diff = Math.abs(lum(d[k], d[k + 1], d[k + 2]) - lum(b[k], b[k + 1], b[k + 2])) * 2 + mag[i] * 0.25;
        const edge = diff > t;
        if (p.mode === 'edges') {
          const v = edge ? 255 : 0;
          o[k] = o[k + 1] = o[k + 2] = v;
          o[k + 3] = 255;
        } else if (p.mode === 'overlay' && edge) {
          o[k] = o[k + 1] = o[k + 2] = 255;
        } else {
          const wgt = 1 - smooth(t * 0.6, t, diff);
          for (let ch = 0; ch < 3; ch++) o[k + ch] = d[k + ch] + (b[k + ch] - d[k + ch]) * wgt;
        }
      }
      return toCanvas(out);
    },
  },
  spinBlur: {
    name: '회전 흐림 효과', group: '흐림 효과 갤러리', slow: true,
    params: [['angle', '흐림 각도 (°)', 1, 90, 15], ['x', '중심 가로 (%)', 0, 100, 50], ['y', '중심 세로 (%)', 0, 100, 50]],
    fn(c, p) {
      const out = mk(c.width, c.height);
      const g = out.getContext('2d');
      const cx = (c.width * p.x) / 100;
      const cy = (c.height * p.y) / 100;
      const steps = Math.max(2, Math.min(60, Math.round(p.angle * 1.5)));
      g.drawImage(c, 0, 0);
      for (let k = 1; k <= steps; k++) {
        const a = (((k / steps) - 0.5) * p.angle * Math.PI) / 180;
        g.save();
        g.globalAlpha = 1 / (k + 1);
        g.translate(cx, cy);
        g.rotate(a);
        g.translate(-cx, -cy);
        g.drawImage(c, 0, 0);
        g.restore();
      }
      return out;
    },
  },

  // ---- sharpen
  sharpenMore: {
    name: '더 선명하게', group: '선명 효과', params: [],
    fn(c) {
      return sharpenWith(c, read(blurred(c, 1)), 1.6, 0);
    },
  },
  sharpenEdges: {
    name: '가장자리 선명하게', group: '선명 효과', params: [],
    fn(c) {
      return sharpenWith(c, read(blurred(c, 1)), 1.2, 12);
    },
  },
  smartSharpen: {
    name: '고급 선명 효과', group: '선명 효과', slow: true,
    params: [['amount', '양 (%)', 1, 500, 150], ['radius', '반경 (px)', 0.1, 64, 1.5, 0.1], ['noise', '노이즈 감소 (%)', 0, 100, 10], ['remove', '제거', null, null, 'gaussian', [['gaussian', '가우시안 흐림'], ['lens', '렌즈 흐림'], ['motion', '동작 흐림']]], ['angle', '각도 (동작 흐림)', -180, 180, 0], ['shadows', '어두운 영역 페이드 (%)', 0, 100, 0], ['highlights', '밝은 영역 페이드 (%)', 0, 100, 0]],
    fn(c, p) {
      let b;
      if (p.remove === 'motion') b = dirBlur(c, p.angle, Math.max(2, p.radius * 3));
      else if (p.remove === 'lens') b = blurred(blurred(c, p.radius * 0.8), p.radius * 0.5);
      else b = blurred(c, p.radius);
      const img = read(c);
      const bd = read(b).data;
      const d = img.data;
      const out = cloneImg(img);
      const amt = p.amount / 100;
      const thr = p.noise * 0.25;
      for (let i = 0; i < d.length; i += 4) {
        const L = lum(d[i], d[i + 1], d[i + 2]) / 255;
        const fade = 1 - (p.shadows / 100) * (1 - smooth(0, 0.35, L)) - (p.highlights / 100) * smooth(0.65, 1, L);
        for (let k = 0; k < 3; k++) {
          const diff = d[i + k] - bd[i + k];
          if (Math.abs(diff) <= thr) continue;
          out.data[i + k] = cl(d[i + k] + diff * amt * fade);
        }
      }
      return toCanvas(out);
    },
  },

  // ---- noise
  reduceNoise: {
    name: '노이즈 감소', group: '노이즈', slow: true,
    params: [['strength', '강도', 0, 10, 6], ['details', '세부 유지 (%)', 0, 100, 60], ['color', '색상 노이즈 감소 (%)', 0, 100, 45], ['sharpen', '세부 선명하게 (%)', 0, 100, 25]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const n = w * h;
      const Y = new Float32Array(n);
      const Cb = new Float32Array(n);
      const Cr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const r = d[i * 4];
        const g = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        Cb[i] = -0.1687 * r - 0.3313 * g + 0.5 * b;
        Cr[i] = 0.5 * r - 0.4187 * g - 0.0813 * b;
      }
      // brightness noise: smooth flat areas, keep edges (more with "preserve details")
      const ys = gaussF(Y, w, h, 0.4 + p.strength * 0.35);
      const { mag } = sobelF(gaussF(Y, w, h, 1), w, h);
      const keep = p.details / 100;
      const Y2 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const edge = smooth(8, 60, mag[i]);
        const k = (p.strength / 10) * (1 - edge * keep);
        Y2[i] = Y[i] + (ys[i] - Y[i]) * k;
      }
      // colour noise: blur the colour channels
      const cs = 0.5 + (p.color / 100) * 6;
      const Cb2 = p.color ? gaussF(Cb, w, h, cs) : Cb;
      const Cr2 = p.color ? gaussF(Cr, w, h, cs) : Cr;
      // a touch of sharpening back on the details
      const Y3 = p.sharpen ? (() => {
        const b = gaussF(Y2, w, h, 1);
        const a = (p.sharpen / 100) * 0.8;
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = Y2[i] + (Y2[i] - b[i]) * a;
        return o;
      })() : Y2;
      const out = new ImageData(w, h);
      for (let i = 0; i < n; i++) {
        const y = Y3[i];
        out.data[i * 4] = cl(y + 1.402 * Cr2[i]);
        out.data[i * 4 + 1] = cl(y - 0.34414 * Cb2[i] - 0.71414 * Cr2[i]);
        out.data[i * 4 + 2] = cl(y + 1.772 * Cb2[i]);
        out.data[i * 4 + 3] = d[i * 4 + 3];
      }
      return toCanvas(out);
    },
  },

  // ---- pixelate
  facet: {
    name: '단면화', group: '픽셀화', slow: true, params: [],
    fn: (c) => toCanvas(kuwahara(read(c), 3)),
  },

  // ---- distort
  displace: {
    name: '변위', group: '왜곡', slow: true,
    params: [['sx', '가로 비율 (%)', -100, 100, 10], ['sy', '세로 비율 (%)', -100, 100, 10], ['map', '변위 맵', null, null, 'clouds', [['clouds', '구름 (매끄러운 무늬)'], ['self', '이 그림의 밝기'], ['waves', '물결']]], ['scale', '맵 크기 (px)', 4, 400, 80], ['wrap', '빈 곳', null, null, 'repeat', [['repeat', '가장자리 픽셀 반복'], ['wrap', '반대쪽으로 감싸기']]]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      let M;
      if (p.map === 'self') M = grayOf(read(blurred(c, 2))).map((v) => v / 255);
      else if (p.map === 'waves') {
        M = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) M[y * w + x] = 0.5 + 0.5 * Math.sin((x + y * 0.6) / (p.scale / (2 * Math.PI)));
      } else M = noiseF(w, h, p.scale, 3, 11);
      // like Photoshop: mid grey moves nothing, 100% moves up to 128 px
      const kx = (p.sx / 100) * 128 * 2;
      const ky = (p.sy / 100) * 128 * 2;
      return displaceBy(c, (x, y, o) => {
        const v = M[clamp(y | 0, 0, h - 1) * w + clamp(x | 0, 0, w - 1)] - 0.5;
        o[0] = v * kx;
        o[1] = v * ky;
      }, p.wrap === 'wrap');
    },
  },
  ripple: {
    name: '잔물결', group: '왜곡', slow: true, params: [['amount', '양 (%)', -999, 999, 100], ['size', '크기', null, null, 'medium', [['small', '작게'], ['medium', '중간'], ['large', '크게']]]],
    fn(c, p) {
      const period = { small: 7, medium: 14, large: 30 }[p.size] || 14;
      const amp = (p.amount / 100) * period * 0.35;
      const jit = rng(3);
      const ph = Array.from({ length: 64 }, () => jit() * Math.PI * 2);
      return displaceBy(c, (x, y, o) => {
        o[0] = amp * Math.sin(y / period * 2 + ph[(y / (period * 8)) & 63]);
        o[1] = amp * Math.sin(x / period * 2 + ph[(x / (period * 8)) & 63]);
      });
    },
  },
  shear: {
    name: '기울임', group: '왜곡', slow: true, params: [['amount', '양', -100, 100, 40], ['curve', '모양', null, null, 'arc', [['arc', '활 모양'], ['s', 'S자'], ['wave', '물결'], ['line', '사선']]], ['wrap', '빈 곳', null, null, 'repeat', [['repeat', '가장자리 픽셀 반복'], ['wrap', '반대쪽으로 감싸기']]]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const A = (p.amount / 100) * (w / 4);
      const f = { arc: (t) => 1 - (2 * t - 1) ** 2, s: (t) => Math.sin(t * 2 * Math.PI), wave: (t) => Math.sin(t * 4 * Math.PI), line: (t) => 2 * t - 1 }[p.curve] || ((t) => t);
      return displaceBy(c, (x, y, o) => {
        o[0] = -A * f(y / h);
        o[1] = 0;
      }, p.wrap === 'wrap');
    },
  },

  // ---- stylize
  extrude: {
    name: '돌출', group: '스타일화', slow: true,
    params: [['size', '크기 (px)', 4, 255, 30], ['depth', '깊이', 1, 255, 30], ['depthMode', '깊이 정하기', null, null, 'level', [['level', '밝기에 따라'], ['random', '무작위']]], ['solid', '앞면 단색', null, null, true, 'bool']],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const s = Math.max(4, p.size);
      const gw = Math.ceil(w / s);
      const gh = Math.ceil(h / s);
      // block colours from a smaller copy
      const small = mk(gw, gh);
      const sg = small.getContext('2d', { willReadFrequently: true });
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(c, 0, 0, gw, gh);
      const cd = sg.getImageData(0, 0, gw, gh).data;
      const r = rng(5);
      const blocks = [];
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const k = (j * gw + i) * 4;
          const L = lum(cd[k], cd[k + 1], cd[k + 2]);
          const dep = (p.depthMode === 'random' ? r() : L / 255) * p.depth;
          blocks.push({ i, j, dep, col: [cd[k], cd[k + 1], cd[k + 2]] });
        }
      }
      blocks.sort((a, b) => a.dep - b.dep);
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const rgb = (col, k) => `rgb(${cl(col[0] * k)},${cl(col[1] * k)},${cl(col[2] * k)})`;
      for (const b of blocks) {
        const x0 = b.i * s;
        const y0 = b.j * s;
        const grow = 1 + b.dep / 400;
        const fx = cx + (x0 + s / 2 - cx) * grow - s / 2;
        const fy = cy + (y0 + s / 2 - cy) * grow - s / 2;
        // sides: the four quads from the base square to the raised front
        const base = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
        const front = [[fx, fy], [fx + s, fy], [fx + s, fy + s], [fx, fy + s]];
        const shades = [0.75, 0.5, 0.35, 0.6];
        for (let e = 0; e < 4; e++) {
          g.fillStyle = rgb(b.col, shades[e]);
          g.beginPath();
          g.moveTo(...base[e]);
          g.lineTo(...base[(e + 1) % 4]);
          g.lineTo(...front[(e + 1) % 4]);
          g.lineTo(...front[e]);
          g.closePath();
          g.fill();
        }
        if (p.solid) {
          g.fillStyle = rgb(b.col, 1);
          g.fillRect(fx, fy, s, s);
        } else {
          g.save();
          g.beginPath();
          g.rect(fx, fy, s, s);
          g.clip();
          g.drawImage(c, x0, y0, s, s, fx, fy, s, s);
          g.restore();
        }
      }
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  traceContour: {
    name: '윤곽선 추적', group: '스타일화', params: [['level', '레벨', 0, 255, 128], ['edge', '가장자리', null, null, 'lower', [['lower', '아래쪽'], ['upper', '위쪽']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const out = new ImageData(w, h);
      const o = out.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = (y * w + Math.min(w - 1, x + 1)) * 4;
          const b = (Math.min(h - 1, y + 1) * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const v = d[i + ch] > p.level;
            const line = (v !== d[r + ch] > p.level || v !== d[b + ch] > p.level) && (p.edge === 'upper' ? v : !v);
            o[i + ch] = line ? 0 : 255;
          }
          o[i + 3] = d[i + 3];
        }
      }
      return toCanvas(out);
    },
  },

  // ---- render
  differenceClouds: {
    name: '차이 구름 효과', group: '렌더', params: [['scale', '크기', 20, 600, 160]],
    fn(c, p, { fg, bg }) {
      const w = c.width;
      const h = c.height;
      const N = noiseF(w, h, p.scale, 6, 23);
      const [fr, fgc, fb] = hexRgb(fg);
      const [br, bgc, bb] = hexRgb(bg);
      const img = read(c);
      const d = img.data;
      for (let i = 0; i < w * h; i++) {
        const t = N[i];
        const cr = fr + (br - fr) * t;
        const cg = fgc + (bgc - fgc) * t;
        const cb = fb + (bb - fb) * t;
        d[i * 4] = Math.abs(d[i * 4] - cr);
        d[i * 4 + 1] = Math.abs(d[i * 4 + 1] - cg);
        d[i * 4 + 2] = Math.abs(d[i * 4 + 2] - cb);
        if (!d[i * 4 + 3]) d[i * 4 + 3] = 255;
      }
      return toCanvas(img);
    },
  },
  fibers: {
    name: '섬유', group: '렌더', render: true, params: [['variance', '변화', 1, 64, 16], ['strength', '강도', 1, 64, 4]],
    fn(c, p, { fg, bg }) {
      const w = c.width;
      const h = c.height;
      const r = rng(31);
      // each column wanders; strength = how long a fibre runs (vertical smoothing)
      const cols = new Float32Array(w * h);
      for (let x = 0; x < w; x++) {
        let v = r();
        for (let y = 0; y < h; y++) {
          if (r() < p.variance / 400) v = r();
          cols[y * w + x] = v;
        }
      }
      const sm = cols;
      // vertical-only smoothing
      const out = new Float32Array(w * h);
      const R = Math.round(p.strength * 2);
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = -R; y <= R; y++) s += sm[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = s / (2 * R + 1);
          s += sm[clamp(y + R + 1, 0, h - 1) * w + x] - sm[clamp(y - R, 0, h - 1) * w + x];
        }
      }
      const [fr, fgc, fb] = hexRgb(fg);
      const [br, bgc, bb] = hexRgb(bg);
      const img = new ImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const t = clamp((out[i] - 0.5) * (1 + p.variance / 16) + 0.5, 0, 1);
        img.data[i * 4] = fr + (br - fr) * t;
        img.data[i * 4 + 1] = fgc + (bgc - fgc) * t;
        img.data[i * 4 + 2] = fb + (bb - fb) * t;
        img.data[i * 4 + 3] = 255;
      }
      return toCanvas(img);
    },
  },
  lightingEffects: {
    name: '조명 효과', group: '렌더', slow: true,
    params: [['style', '빛 종류', null, null, 'spot', [['spot', '스포트라이트'], ['point', '점 조명'], ['infinite', '무한 조명 (햇빛)']]], ['x', '빛 위치 가로 (%)', 0, 100, 35], ['y', '빛 위치 세로 (%)', 0, 100, 30], ['radius', '빛 범위 (%)', 5, 200, 70], ['intensity', '강도', 0, 200, 100], ['color', '빛 색', null, null, '#fff4e0', 'color'], ['ambient', '주변광', -100, 100, 10], ['bump', '질감 높이 (밝기로)', 0, 100, 20], ['angle', '빛 방향 (°)', 0, 360, 315]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const L = grayOf(img);
      const H = gaussF(L, w, h, 1.2);
      const { gx, gy } = sobelF(H, w, h);
      const [lr, lg, lb] = hexRgb(p.color).map((v) => v / 255);
      const lx = (w * p.x) / 100;
      const ly = (h * p.y) / 100;
      const R = (Math.hypot(w, h) * p.radius) / 200;
      const t = (p.angle * Math.PI) / 180;
      const dirx = Math.cos(t);
      const diry = -Math.sin(t);
      const amb = 0.35 + (p.ambient / 100) * 0.35;
      const k = (p.bump / 100) * 0.02;
      const out = new ImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          // light direction at this pixel (from the surface toward the light), with height
          let vx;
          let vy;
          let fall;
          if (p.style === 'infinite') {
            vx = -dirx;
            vy = -diry;
            fall = 1;
          } else {
            vx = lx - x;
            vy = ly - y;
            const dist = Math.hypot(vx, vy) || 1;
            vx /= dist;
            vy /= dist;
            fall = Math.max(0, 1 - (dist / R) ** 2);
            if (p.style === 'spot') {
              // a cone pointing along the angle
              const along = -(vx * dirx + vy * diry);
              fall *= smooth(0.55, 0.95, along) * 0.6 + 0.4 * fall;
            }
          }
          const nx = -gx[i] * k;
          const ny = -gy[i] * k;
          const nl = Math.hypot(nx, ny, 1);
          const lambert = Math.max(0, (nx * vx * 0.7 + ny * vy * 0.7 + 0.7) / nl);
          const light = amb + (p.intensity / 100) * fall * lambert * 1.6;
          const o = i * 4;
          out.data[o] = cl(d[o] * light * (amb + (1 - amb) * lr));
          out.data[o + 1] = cl(d[o + 1] * light * (amb + (1 - amb) * lg));
          out.data[o + 2] = cl(d[o + 2] * light * (amb + (1 - amb) * lb));
          out.data[o + 3] = d[o + 3];
        }
      }
      return toCanvas(out);
    },
  },

  // ---- other
  customKernel: {
    name: '사용자 정의', group: '기타',
    params: [['kernel', '5×5 값 (가운데가 이 픽셀)', null, null, [0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, -1, 5, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0], 'kernel'], ['scale', '나누기 (비율)', 1, 9999, 1], ['offset', '더하기 (오프셋)', -9999, 9999, 0]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const K = Array.isArray(p.kernel) && p.kernel.length === 25 ? p.kernel.map(Number) : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const sc = p.scale || 1;
      const out = cloneImg(img);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0;
          let g = 0;
          let b = 0;
          for (let ky = 0; ky < 5; ky++) {
            const yy = clamp(y + ky - 2, 0, h - 1);
            for (let kx = 0; kx < 5; kx++) {
              const k = K[ky * 5 + kx];
              if (!k) continue;
              const j = (yy * w + clamp(x + kx - 2, 0, w - 1)) * 4;
              r += d[j] * k;
              g += d[j + 1] * k;
              b += d[j + 2] * k;
            }
          }
          const o = (y * w + x) * 4;
          out.data[o] = cl(r / sc + p.offset);
          out.data[o + 1] = cl(g / sc + p.offset);
          out.data[o + 2] = cl(b / sc + p.offset);
        }
      }
      return toCanvas(out);
    },
  },

  // ---- video
  deinterlace: {
    name: '인터레이스 제거', group: '비디오', params: [['drop', '없앨 줄', null, null, 'odd', [['odd', '홀수 줄'], ['even', '짝수 줄']]], ['fill', '채우기', null, null, 'interpolate', [['interpolate', '보간 (위아래 평균)'], ['duplicate', '복제 (옆 줄 그대로)']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const out = cloneImg(img);
      const start = p.drop === 'odd' ? 1 : 0;
      for (let y = start; y < h; y += 2) {
        const up = y - 1 >= 0 ? y - 1 : y + 1;
        const dn = y + 1 < h ? y + 1 : y - 1;
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const a = (up * w + x) * 4;
          const b = (dn * w + x) * 4;
          for (let k = 0; k < 4; k++) out.data[o + k] = p.fill === 'duplicate' ? d[a + k] : (d[a + k] + d[b + k]) / 2;
        }
      }
      return toCanvas(out);
    },
  },
  ntscColors: {
    name: 'NTSC 색상', group: '비디오', params: [],
    fn(c) {
      // keep colours a TV can show: limit chroma so Y ± C stays inside 16..235
      const img = read(c);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const Y = lum(r, g, b);
        const cr = r - Y;
        const cg = g - Y;
        const cb = b - Y;
        const C = Math.hypot(cr, cg, cb);
        const limit = Math.min(235 - Y, Y - 16, 110) * 1.25;
        const k = C > limit && C > 0 ? Math.max(0, limit) / C : 1;
        d[i] = cl(Y + cr * k);
        d[i + 1] = cl(Y + cg * k);
        d[i + 2] = cl(Y + cb * k);
      }
      return toCanvas(img);
    },
  },
};

/** Unsharp with a given blurred copy: amount, threshold. */
function sharpenWith(c, blurImg, amount, threshold) {
  const img = read(c);
  const d = img.data;
  const b = blurImg.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const diff = d[i + k] - b[i + k];
      if (Math.abs(diff) >= threshold) d[i + k] = cl(d[i + k] + diff * amount);
    }
  }
  return toCanvas(img);
}

Object.assign(FILTERS, F);

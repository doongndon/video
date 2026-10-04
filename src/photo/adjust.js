// Image adjustments (also used by adjustment layers) and filters. All work on ImageData / canvases.

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const hexRgb = (hex) => {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// ---------------------------------------------------------------- adjustments

export const ADJUSTMENTS = {
  brightness: { name: '밝기/대비', key: 'brightness', params: [['brightness', '밝기', -150, 150, 0], ['contrast', '대비', -100, 100, 0]] },
  levels: { name: '레벨', params: [['inBlack', '입력 검정', 0, 253, 0], ['gamma', '중간 톤 (감마)', 0.1, 4, 1, 0.01], ['inWhite', '입력 흰색', 2, 255, 255], ['outBlack', '출력 검정', 0, 255, 0], ['outWhite', '출력 흰색', 0, 255, 255]] },
  curves: { name: '곡선', params: [['points', '곡선', null, null, [[0, 0], [64, 64], [192, 192], [255, 255]], 'curve']] },
  exposure: { name: '노출', params: [['exposure', '노출 (스톱)', -4, 4, 0, 0.05], ['offset', '오프셋', -0.5, 0.5, 0, 0.005], ['gamma', '감마', 0.1, 3, 1, 0.01]] },
  vibrance: { name: '활기', params: [['vibrance', '활기', -100, 100, 0], ['saturation', '채도', -100, 100, 0]] },
  hueSat: { name: '색조/채도', params: [['hue', '색조', -180, 180, 0], ['saturation', '채도', -100, 100, 0], ['lightness', '밝기', -100, 100, 0], ['colorize', '색상화', null, null, false, 'bool']] },
  colorBalance: { name: '색상 균형', params: [['cr', '녹청 ↔ 빨강', -100, 100, 0], ['mg', '마젠타 ↔ 녹색', -100, 100, 0], ['yb', '노랑 ↔ 파랑', -100, 100, 0], ['preserve', '광도 유지', null, null, true, 'bool']] },
  bw: { name: '흑백', params: [['reds', '빨강', -200, 300, 40], ['yellows', '노랑', -200, 300, 60], ['greens', '녹색', -200, 300, 40], ['cyans', '녹청', -200, 300, 60], ['blues', '파랑', -200, 300, 20], ['magentas', '마젠타', -200, 300, 80]] },
  photoFilter: { name: '포토 필터', params: [['color', '필터 색', null, null, '#ec8a00', 'color'], ['density', '농도', 1, 100, 25], ['preserve', '광도 유지', null, null, true, 'bool']] },
  invert: { name: '반전', params: [] },
  posterize: { name: '포스터화', params: [['levels', '단계', 2, 32, 4]] },
  threshold: { name: '한계값', params: [['level', '한계값', 1, 255, 128]] },
  gradientMap: { name: '그레이디언트 맵', params: [['from', '어두운 색', null, null, '#000000', 'color'], ['to', '밝은 색', null, null, '#ffffff', 'color']] },
  desaturate: { name: '채도 감소', params: [] },
};

export function defaultParams(type) {
  const out = {};
  for (const [k, , , , def] of ADJUSTMENTS[type].params) out[k] = structuredClone(def);
  return out;
}

/** Monotone cubic curve through points [[x,y]...] → 256-entry lookup table. */
export function curveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const lut = new Uint8ClampedArray(256);
  if (n < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
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
      const hseg = xs[i + 1] - xs[i];
      const t = (x - xs[i]) / hseg;
      const t2 = t * t;
      const t3 = t2 * t;
      lut[x] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hseg * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hseg * m[i + 1];
    }
  }
  return lut;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Apply an adjustment to ImageData in place. */
export function applyAdjustment(img, type, p) {
  const d = img.data;
  const n = d.length;
  if (type === 'brightness') {
    const b = p.brightness;
    const c = p.contrast / 100;
    const f = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = (i + b * 0.8 - 128) * f + 128;
    for (let i = 0; i < n; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  } else if (type === 'levels' || type === 'curves' || type === 'exposure' || type === 'posterize' || type === 'threshold' || type === 'invert') {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      if (type === 'levels') {
        const t = Math.min(1, Math.max(0, (i - p.inBlack) / Math.max(1, p.inWhite - p.inBlack)));
        v = p.outBlack + (p.outWhite - p.outBlack) * Math.pow(t, 1 / p.gamma);
      } else if (type === 'exposure') {
        const t = Math.max(0, (i / 255) * Math.pow(2, p.exposure) + p.offset);
        v = Math.pow(t, 1 / p.gamma) * 255;
      } else if (type === 'posterize') {
        const L = Math.max(2, Math.round(p.levels));
        v = (Math.round((i / 255) * (L - 1)) / (L - 1)) * 255;
      } else if (type === 'invert') v = 255 - i;
      lut[i] = v;
    }
    const curve = type === 'curves' ? curveLut(p.points) : null;
    for (let i = 0; i < n; i += 4) {
      if (type === 'threshold') {
        const v = lum(d[i], d[i + 1], d[i + 2]) >= p.level ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      } else {
        const L = curve || lut;
        d[i] = L[d[i]];
        d[i + 1] = L[d[i + 1]];
        d[i + 2] = L[d[i + 2]];
      }
    }
  } else if (type === 'vibrance') {
    const vib = p.vibrance / 100;
    const sat = p.saturation / 100;
    for (let i = 0; i < n; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const l = lum(r, g, b);
      const mx = Math.max(r, g, b);
      const amt = (mx - Math.min(r, g, b)) / 255;
      const k = 1 + sat + vib * (1 - amt);
      d[i] = clamp255(l + (r - l) * k);
      d[i + 1] = clamp255(l + (g - l) * k);
      d[i + 2] = clamp255(l + (b - l) * k);
    }
  } else if (type === 'hueSat') {
    const hs = p.hue / 360;
    const ss = p.saturation / 100;
    const ls = p.lightness / 100;
    for (let i = 0; i < n; i += 4) {
      let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      if (p.colorize) {
        h = ((p.hue + 360) % 360) / 360;
        s = Math.min(1, 0.25 + ss * 0.75 + 0.25);
      } else {
        h = (h + hs + 1) % 1;
        s = Math.min(1, Math.max(0, ss >= 0 ? s + (1 - s) * ss * s : s * (1 + ss)));
      }
      l = ls >= 0 ? l + (1 - l) * ls : l * (1 + ls);
      const [r, g, b] = hslToRgb(h, s, l);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  } else if (type === 'colorBalance') {
    const k = 0.5;
    for (let i = 0; i < n; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const l0 = lum(r, g, b);
      const mid = 1 - Math.abs(l0 / 127.5 - 1); // strongest in the midtones
      let nr = r + p.cr * k * mid * 1.27;
      let ng = g + p.mg * k * mid * 1.27;
      let nb = b + p.yb * k * mid * 1.27;
      if (p.preserve) {
        const dl = l0 - lum(nr, ng, nb);
        nr += dl;
        ng += dl;
        nb += dl;
      }
      d[i] = clamp255(nr);
      d[i + 1] = clamp255(ng);
      d[i + 2] = clamp255(nb);
    }
  } else if (type === 'bw') {
    // grey = min + (mid − min)·secondary weight + (max − mid)·primary weight
    // (primary: the strongest channel's colour; secondary: the colour mixing the two strongest)
    const W = { r: p.reds / 100, g: p.greens / 100, b: p.blues / 100, rg: p.yellows / 100, gb: p.cyans / 100, rb: p.magentas / 100 };
    for (let i = 0; i < n; i += 4) {
      const ch = [['r', d[i]], ['g', d[i + 1]], ['b', d[i + 2]]].sort((x, y) => y[1] - x[1]);
      const [[c1, mx], [c2, md], [, mn]] = ch;
      const sec = W[[c1, c2].sort().join('').replace('br', 'rb').replace('bg', 'gb').replace('gr', 'rg')];
      d[i] = d[i + 1] = d[i + 2] = clamp255(mn + (md - mn) * sec + (mx - md) * W[c1]);
    }
  } else if (type === 'photoFilter') {
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
      d[i] = clamp255(nr);
      d[i + 1] = clamp255(ng);
      d[i + 2] = clamp255(nb);
    }
  } else if (type === 'gradientMap') {
    const a = hexRgb(p.from);
    const b = hexRgb(p.to);
    for (let i = 0; i < n; i += 4) {
      const t = lum(d[i], d[i + 1], d[i + 2]) / 255;
      d[i] = a[0] + (b[0] - a[0]) * t;
      d[i + 1] = a[1] + (b[1] - a[1]) * t;
      d[i + 2] = a[2] + (b[2] - a[2]) * t;
    }
  } else if (type === 'desaturate') {
    for (let i = 0; i < n; i += 4) {
      const v = lum(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return img;
}

// ---------------------------------------------------------------- filters

function sampler(src, w, h) {
  return (x, y, out, o) => {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > w - 1) x = w - 1;
    if (y > h - 1) y = h - 1;
    const x0 = x | 0;
    const y0 = y | 0;
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    for (let k = 0; k < 4; k++) {
      const a = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
      const b = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
      out[o + k] = a + (b - a) * fy;
    }
  };
}

/** Move pixels: map(x, y) returns the source position for destination (x, y). */
function remap(img, map) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data);
  const s = sampler(src, w, h);
  const d = img.data;
  const p = [0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      map(x, y, p);
      s(p[0], p[1], d, (y * w + x) * 4);
    }
  }
}

function convolve(img, kernel, divisor = 1, offset = 0, keepAlpha = true) {
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
      if (!keepAlpha) d[o + 3] = 255;
    }
  }
}

export const FILTERS = {
  gaussian: { name: '가우시안 흐림', group: '흐림 효과', params: [['radius', '반경 (px)', 0.5, 100, 5, 0.5]] },
  motion: { name: '동작 흐림', group: '흐림 효과', params: [['angle', '각도', -180, 180, 0], ['distance', '거리 (px)', 1, 200, 20]] },
  radial: { name: '방사형 흐림 (확대)', group: '흐림 효과', params: [['amount', '양', 1, 100, 20]] },
  unsharp: { name: '언샵 마스크', group: '선명 효과', params: [['amount', '양 (%)', 1, 300, 80], ['radius', '반경 (px)', 0.5, 20, 1.5, 0.1], ['threshold', '한계값', 0, 255, 0]] },
  sharpen: { name: '선명하게', group: '선명 효과', params: [] },
  noise: { name: '노이즈 추가', group: '노이즈', params: [['amount', '양 (%)', 1, 100, 12], ['mono', '단색', null, null, true, 'bool']] },
  median: { name: '노이즈 감소 (중간값)', group: '노이즈', params: [['radius', '반경 (px)', 1, 3, 1]] },
  mosaic: { name: '모자이크', group: '픽셀화', params: [['size', '셀 크기 (px)', 2, 200, 16]] },
  emboss: { name: '엠보스', group: '스타일화', params: [] },
  edges: { name: '가장자리 찾기', group: '스타일화', params: [] },
  oil: { name: '유화 (간단)', group: '스타일화', params: [['radius', '붓 크기', 1, 6, 3], ['levels', '색 단계', 4, 40, 20]] },
  twirl: { name: '돌리기', group: '왜곡', params: [['angle', '각도', -999, 999, 120]] },
  spherize: { name: '구형화', group: '왜곡', params: [['amount', '양 (%)', -100, 100, 60]] },
  pinch: { name: '핀치', group: '왜곡', params: [['amount', '양 (%)', -100, 100, 50]] },
  wave: { name: '물결', group: '왜곡', params: [['amplitude', '진폭 (px)', 1, 100, 12], ['wavelength', '파장 (px)', 4, 400, 80]] },
  vignette: { name: '비네팅 (렌즈 교정)', group: '렌즈', params: [['amount', '양', -100, 100, 60], ['size', '중심 크기 (%)', 10, 100, 55]] },
  clouds: { name: '구름 효과 (전경/배경색)', group: '렌더', params: [['scale', '크기', 20, 600, 160]], render: true },
};

export const defaultFilterParams = (id) => Object.fromEntries(FILTERS[id].params.map(([k, , , , def]) => [k, def]));

/** Apply a filter to a canvas; returns a new canvas of the same size. ctx.filter is used where it is fast. */
export function applyFilter(canvas, id, p, { fg = '#000000', bg = '#ffffff' } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (id === 'gaussian') {
    g.filter = `blur(${p.radius}px)`;
    g.drawImage(canvas, 0, 0);
    return out;
  }
  if (id === 'mosaic') {
    const s = Math.max(2, p.size);
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(w / s));
    small.height = Math.max(1, Math.ceil(h / s));
    const sg = small.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(canvas, 0, 0, small.width, small.height);
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, small.width * s, small.height * s);
    return out;
  }
  if (id === 'vignette') {
    g.drawImage(canvas, 0, 0);
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
  }
  if (id === 'radial') {
    g.drawImage(canvas, 0, 0);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const k = 1 + (p.amount / 100) * 0.25 * (i / steps);
      g.globalAlpha = 1 / (i + 1);
      g.drawImage(canvas, (w - w * k) / 2, (h - h * k) / 2, w * k, h * k);
    }
    return out;
  }
  if (id === 'clouds') {
    const img = g.createImageData(w, h);
    const a = hexRgb(fg);
    const b = hexRgb(bg);
    const grid = (sz) => {
      const gw = Math.ceil(w / sz) + 2;
      const gh = Math.ceil(h / sz) + 2;
      const v = new Float32Array(gw * gh).map(() => Math.random());
      return (x, y) => {
        const fx = x / sz;
        const fy = y / sz;
        const x0 = fx | 0;
        const y0 = fy | 0;
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const v00 = v[y0 * gw + x0];
        const v10 = v[y0 * gw + x0 + 1];
        const v01 = v[(y0 + 1) * gw + x0];
        const v11 = v[(y0 + 1) * gw + x0 + 1];
        return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
      };
    };
    const octaves = [1, 0.5, 0.25, 0.125, 0.0625].map((k) => [grid(Math.max(2, p.scale * k)), k]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let t = 0;
        let norm = 0;
        for (const [f, k] of octaves) {
          t += f(x, y) * k;
          norm += k;
        }
        t /= norm;
        const o = (y * w + x) * 4;
        img.data[o] = a[0] + (b[0] - a[0]) * t;
        img.data[o + 1] = a[1] + (b[1] - a[1]) * t;
        img.data[o + 2] = a[2] + (b[2] - a[2]) * t;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return out;
  }
  // pixel filters
  g.drawImage(canvas, 0, 0);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  if (id === 'unsharp') {
    const blur = document.createElement('canvas');
    blur.width = w;
    blur.height = h;
    const bg2 = blur.getContext('2d');
    bg2.filter = `blur(${p.radius}px)`;
    bg2.drawImage(canvas, 0, 0);
    const bd = bg2.getImageData(0, 0, w, h).data;
    const amt = p.amount / 100;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const diff = d[i + k] - bd[i + k];
        if (Math.abs(diff) >= p.threshold) d[i + k] = clamp255(d[i + k] + diff * amt);
      }
    }
  } else if (id === 'sharpen') convolve(img, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
  else if (id === 'emboss') convolve(img, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0);
  else if (id === 'edges') {
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const L = (xx, yy) => {
          const o = (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4;
          return lum(src[o], src[o + 1], src[o + 2]);
        };
        const gx = -L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1) + L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1);
        const gy = -L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1) + L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1);
        const v = 255 - Math.min(255, Math.hypot(gx, gy));
        const o = (y * w + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = v;
      }
    }
  } else if (id === 'noise') {
    const a = (p.amount / 100) * 255;
    for (let i = 0; i < d.length; i += 4) {
      if (p.mono) {
        const n = (Math.random() - 0.5) * a;
        d[i] = clamp255(d[i] + n);
        d[i + 1] = clamp255(d[i + 1] + n);
        d[i + 2] = clamp255(d[i + 2] + n);
      } else {
        d[i] = clamp255(d[i] + (Math.random() - 0.5) * a);
        d[i + 1] = clamp255(d[i + 1] + (Math.random() - 0.5) * a);
        d[i + 2] = clamp255(d[i + 2] + (Math.random() - 0.5) * a);
      }
    }
  } else if (id === 'median') {
    const r = Math.round(p.radius);
    const src = new Uint8ClampedArray(d);
    const vals = [[], [], []];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        vals[0].length = vals[1].length = vals[2].length = 0;
        for (let j = -r; j <= r; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j));
          for (let i = -r; i <= r; i++) {
            const o = (yy * w + Math.min(w - 1, Math.max(0, x + i))) * 4;
            vals[0].push(src[o]);
            vals[1].push(src[o + 1]);
            vals[2].push(src[o + 2]);
          }
        }
        const o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          const v = vals[k].sort((a, b) => a - b);
          d[o + k] = v[v.length >> 1];
        }
      }
    }
  } else if (id === 'oil') {
    const r = Math.round(p.radius);
    const L = Math.round(p.levels);
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
  } else if (id === 'motion') {
    const src = new Uint8ClampedArray(d);
    const s = sampler(src, w, h);
    const a = (p.angle * Math.PI) / 180;
    const steps = Math.min(48, Math.max(2, Math.round(p.distance)));
    const dx = (Math.cos(a) * p.distance) / steps;
    const dy = (-Math.sin(a) * p.distance) / steps;
    const tmp = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let gg = 0;
        let b = 0;
        let al = 0;
        for (let k = 0; k <= steps; k++) {
          const t = k - steps / 2;
          s(x + dx * t, y + dy * t, tmp, 0);
          r += tmp[0];
          gg += tmp[1];
          b += tmp[2];
          al += tmp[3];
        }
        const o = (y * w + x) * 4;
        d[o] = r / (steps + 1);
        d[o + 1] = gg / (steps + 1);
        d[o + 2] = b / (steps + 1);
        d[o + 3] = al / (steps + 1);
      }
    }
  } else if (id === 'twirl') {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2;
    const ang = (p.angle * Math.PI) / 180;
    remap(img, (x, y, o) => {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r >= R) {
        o[0] = x;
        o[1] = y;
        return;
      }
      const t = ang * (1 - r / R) ** 2;
      o[0] = cx + dx * Math.cos(t) - dy * Math.sin(t);
      o[1] = cy + dx * Math.sin(t) + dy * Math.cos(t);
    });
  } else if (id === 'spherize' || id === 'pinch') {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2;
    const k = (id === 'pinch' ? -1 : 1) * (p.amount / 100);
    remap(img, (x, y, o) => {
      const dx = (x - cx) / R;
      const dy = (y - cy) / R;
      const r = Math.hypot(dx, dy);
      if (r >= 1 || r === 0) {
        o[0] = x;
        o[1] = y;
        return;
      }
      const nr = k >= 0 ? Math.pow(r, 1 + k) : Math.pow(r, 1 / (1 - k));
      o[0] = cx + (dx / r) * nr * R;
      o[1] = cy + (dy / r) * nr * R;
    });
  } else if (id === 'wave') {
    remap(img, (x, y, o) => {
      o[0] = x + Math.sin((y / p.wavelength) * Math.PI * 2) * p.amplitude;
      o[1] = y + Math.sin((x / p.wavelength) * Math.PI * 2) * p.amplitude * 0.5;
    });
  }
  g.putImageData(img, 0, 0);
  return out;
}

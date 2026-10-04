// More filters and adjustments, registered into the tables of adjust.js (each entry carries its
// own fn, so menus, dialogs, adjustment layers and smart filters pick them up unchanged).
// Filters: fn(canvas, params, { fg, bg }) → new canvas. Adjustments: fn(ImageData, params) in place.

import { FILTERS, ADJUSTMENTS } from './adjust.js';

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const read = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
const toCanvas = (img) => {
  const c = mk(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
};
const hexRgb = (hex) => {
  const n = parseInt(String(hex || '#000000').slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Gaussian blur with mirrored edges (no dark rim from the transparent outside). */
function blurred(c, r) {
  if (r <= 0) return c;
  const p = Math.ceil(r * 3);
  const w = c.width;
  const h = c.height;
  const big = mk(w + 2 * p, h + 2 * p);
  const g = big.getContext('2d');
  g.drawImage(c, p, p);
  // mirror the borders into the padding
  g.save();
  g.scale(-1, 1);
  g.drawImage(c, 0, 0, p, h, -p, p, p, h);
  g.drawImage(c, w - p, 0, p, h, -(w + 2 * p), p, p, h);
  g.restore();
  g.save();
  g.scale(1, -1);
  g.drawImage(big, 0, p, w + 2 * p, p, 0, -p, w + 2 * p, p);
  g.drawImage(big, 0, h, w + 2 * p, p, 0, -(h + 2 * p), w + 2 * p, p);
  g.restore();
  const out = mk(w, h);
  const og = out.getContext('2d');
  og.filter = `blur(${r}px)`;
  og.drawImage(big, -p, -p);
  return out;
}

/** Bilinear sample of RGBA at (x, y), edges clamped. */
function sampler(d, w, h) {
  return (x, y, o, k) => {
    x = clamp(x, 0, w - 1.001);
    y = clamp(y, 0, h - 1.001);
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = (y0 * w + x0) * 4;
    const j = i + 4;
    const m = i + w * 4;
    const n = m + 4;
    for (let c = 0; c < 4; c++) o[k + c] = (d[i + c] * (1 - fx) + d[j + c] * fx) * (1 - fy) + (d[m + c] * (1 - fx) + d[n + c] * fx) * fy;
  };
}

/** New canvas where each pixel comes from map(x, y) → [sx, sy] in the source. */
function remap(c, map) {
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

/** Per-channel median in a (2r+1)² window, using running histograms (Huang). */
function medianData(d, w, h, r) {
  const out = new Uint8ClampedArray(d);
  const hist = new Uint16Array(256);
  const half = ((2 * r + 1) ** 2) >> 1;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      let n = 0;
      const add = (x, v) => {
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          hist[d[(yy * w + x) * 4 + c]] += v;
          n += v;
        }
      };
      for (let x = 0; x <= Math.min(w - 1, r); x++) add(x, 1);
      for (let x = 0; x < w; x++) {
        let acc = 0;
        let m = 0;
        const target = Math.min(half, n >> 1);
        while (m < 255 && acc + hist[m] <= target) acc += hist[m++];
        out[(y * w + x) * 4 + c] = m;
        if (x - r >= 0) add(x - r, -1);
        if (x + r + 1 < w) add(x + r + 1, 1);
      }
    }
  }
  return out;
}

/** Per-channel minimum or maximum in a square window (separable). */
function minMax(d, w, h, r, isMax) {
  const pick = isMax ? Math.max : Math.min;
  const tmp = new Uint8ClampedArray(d);
  const out = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let v = d[(y * w + x) * 4 + c];
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, d[(y * w + k) * 4 + c]);
        tmp[(y * w + x) * 4 + c] = v;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let v = tmp[(y * w + x) * 4 + c];
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[(k * w + x) * 4 + c]);
        out[(y * w + x) * 4 + c] = v;
      }
    }
  }
  return out;
}

function sobel(d, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const m = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1];
      const gy = L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1];
      m[i] = Math.hypot(gx, gy);
    }
  }
  return m;
}

let seed = 1;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Jittered seed points on a grid of `cell`; returns { pts, cols, rows }. */
function seeds(w, h, cell) {
  seed = 12345;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const pts = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      pts[(j * cols + i) * 2] = (i + 0.1 + rnd() * 0.8) * cell;
      pts[(j * cols + i) * 2 + 1] = (j + 0.1 + rnd() * 0.8) * cell;
    }
  }
  return { pts, cols, rows };
}

// ---------------------------------------------------------------- filters

const F = {
  // ---- blur
  average: {
    name: '평균', group: '흐림 효과', params: [],
    fn(c) {
      const img = read(c);
      const d = img.data;
      const s = [0, 0, 0, 0];
      let a = 0;
      for (let i = 0; i < d.length; i += 4) {
        const k = d[i + 3];
        s[0] += d[i] * k;
        s[1] += d[i + 1] * k;
        s[2] += d[i + 2] * k;
        a += k;
      }
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        d[i] = s[0] / a;
        d[i + 1] = s[1] / a;
        d[i + 2] = s[2] / a;
      }
      return toCanvas(img);
    },
  },
  surfaceBlur: {
    name: '표면 흐림 (피부 매끄럽게)', group: '흐림 효과', slow: true, params: [['radius', '반경 (px)', 1, 20, 5], ['threshold', '한계값 (색 차이)', 2, 255, 25]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const out = new Uint8ClampedArray(d);
      const r = Math.round(p.radius);
      const st = Math.max(1, Math.round(r / 4));
      const t = p.threshold;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const v0 = d[i + ch];
            let s = 0;
            let ws = 0;
            for (let dy = -r; dy <= r; dy += st) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              for (let dx = -r; dx <= r; dx += st) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                const v = d[(yy * w + xx) * 4 + ch];
                const k = Math.max(0, 1 - Math.abs(v - v0) / (2.5 * t));
                s += v * k;
                ws += k;
              }
            }
            out[i + ch] = s / ws;
          }
        }
      }
      img.data.set(out);
      return toCanvas(img);
    },
  },
  tiltShift: {
    name: '기울기-이동 (미니어처)', group: '흐림 효과 갤러리', params: [['center', '초점 위치 (%)', 0, 100, 55], ['focus', '선명한 띠 (%)', 0, 80, 18], ['fade', '흐려지는 폭 (%)', 1, 80, 22], ['angle', '각도', -90, 90, 0], ['blur', '흐림 (px)', 1, 60, 14], ['saturate', '채도 높이기', 0, 100, 25]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const b = blurred(c, p.blur);
      const mask = mk(w, h);
      const g = mask.getContext('2d');
      const a = (p.angle * Math.PI) / 180;
      const cx = w / 2;
      const cy = (h * p.center) / 100;
      const L = Math.hypot(w, h);
      const nx = -Math.sin(a);
      const ny = Math.cos(a);
      const grad = g.createLinearGradient(cx - nx * L / 2, cy - ny * L / 2, cx + nx * L / 2, cy + ny * L / 2);
      const f = (p.focus / 100) * (h / L) / 2;
      const fd = (p.fade / 100) * (h / L);
      const stop = (t, al) => grad.addColorStop(clamp(t, 0, 1), `rgba(0,0,0,${al})`);
      stop(0, 1);
      stop(0.5 - f - fd, 1);
      stop(0.5 - f, 0);
      stop(0.5 + f, 0);
      stop(0.5 + f + fd, 1);
      stop(1, 1);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-in';
      g.drawImage(b, 0, 0);
      const out = mk(w, h);
      const og = out.getContext('2d');
      if (p.saturate) og.filter = `saturate(${100 + p.saturate}%) contrast(${100 + p.saturate / 5}%)`;
      og.drawImage(c, 0, 0);
      og.filter = 'none';
      og.globalCompositeOperation = 'source-atop';
      og.drawImage(mask, 0, 0);
      return out;
    },
  },
  irisBlur: {
    name: '조리개 흐림 (배경 흐리게)', group: '흐림 효과 갤러리', params: [['x', '중심 가로 (%)', 0, 100, 50], ['y', '중심 세로 (%)', 0, 100, 50], ['radius', '선명한 크기 (%)', 2, 100, 28], ['aspect', '가로세로 비율 (%)', 20, 500, 100], ['fade', '흐려지는 폭 (%)', 1, 100, 30], ['blur', '흐림 (px)', 1, 60, 16]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const b = blurred(c, p.blur);
      const mask = mk(w, h);
      const g = mask.getContext('2d');
      const R = (Math.min(w, h) / 2) * (p.radius / 100);
      const R2 = R * (1 + p.fade / 50);
      g.save();
      g.translate((w * p.x) / 100, (h * p.y) / 100);
      g.scale(p.aspect / 100, 1);
      const grad = g.createRadialGradient(0, 0, R, 0, 0, Math.max(R + 1, R2));
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,1)');
      g.fillStyle = grad;
      g.fillRect(-w * 4, -h * 4, w * 8, h * 8);
      g.restore();
      g.globalCompositeOperation = 'source-in';
      g.drawImage(b, 0, 0);
      const out = mk(w, h);
      const og = out.getContext('2d');
      og.drawImage(c, 0, 0);
      og.globalCompositeOperation = 'source-atop';
      og.drawImage(mask, 0, 0);
      return out;
    },
  },
  // ---- noise
  dustScratches: {
    name: '먼지와 스크래치', group: '노이즈', slow: true, params: [['radius', '반경 (px)', 1, 16, 2], ['threshold', '한계값', 0, 255, 10]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const m = medianData(d, w, h, Math.round(p.radius));
      for (let i = 0; i < d.length; i += 4) {
        for (let k = 0; k < 3; k++) if (Math.abs(d[i + k] - m[i + k]) > p.threshold) d[i + k] = m[i + k];
      }
      return toCanvas(img);
    },
  },
  despeckle: {
    name: '반점 제거', group: '노이즈', params: [],
    fn(c) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const m = medianData(d, w, h, 1);
      const e = sobel(d, w, h);
      for (let i = 0; i < w * h; i++) {
        // keep edges, smooth flat areas
        const k = 1 - smooth(30, 90, e[i]);
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] += (m[i * 4 + ch] - d[i * 4 + ch]) * k;
      }
      return toCanvas(img);
    },
  },
  // ---- pixelate
  crystallize: {
    name: '수정화', group: '픽셀화', params: [['cell', '셀 크기', 3, 300, 18]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const cell = p.cell;
      const { pts, cols, rows } = seeds(w, h, cell);
      const lab = new Int32Array(w * h);
      const sum = new Float64Array(cols * rows * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ci = Math.floor(x / cell);
          const cj = Math.floor(y / cell);
          let best = 0;
          let bd = Infinity;
          for (let j = Math.max(0, cj - 1); j <= Math.min(rows - 1, cj + 1); j++) {
            for (let i = Math.max(0, ci - 1); i <= Math.min(cols - 1, ci + 1); i++) {
              const k = j * cols + i;
              const dd = (pts[k * 2] - x) ** 2 + (pts[k * 2 + 1] - y) ** 2;
              if (dd < bd) {
                bd = dd;
                best = k;
              }
            }
          }
          lab[y * w + x] = best;
          const o = (y * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) sum[best * 4 + ch] += d[o + ch];
          sum[best * 4 + 3]++;
        }
      }
      for (let i = 0; i < w * h; i++) {
        const k = lab[i];
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = sum[k * 4 + ch] / sum[k * 4 + 3];
      }
      return toCanvas(img);
    },
  },
  pointillize: {
    name: '점묘화', group: '픽셀화', params: [['cell', '점 크기', 3, 100, 10]],
    fn(c, p, { bg }) {
      const w = c.width;
      const h = c.height;
      const d = read(c).data;
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      const { pts } = seeds(w, h, p.cell * 0.8);
      for (let k = 0; k < pts.length; k += 2) {
        const x = Math.min(w - 1, pts[k] | 0);
        const y = Math.min(h - 1, pts[k + 1] | 0);
        const o = (y * w + x) * 4;
        g.fillStyle = `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`;
        g.beginPath();
        g.arc(pts[k], pts[k + 1], p.cell * 0.55, 0, Math.PI * 2);
        g.fill();
      }
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  colorHalftone: {
    name: '색상 하프톤', group: '픽셀화', params: [['radius', '최대 반경 (px)', 2, 60, 6]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const d = read(c).data;
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      const R = p.radius;
      const step = R * 2;
      [[0, 108, '#ff0000'], [1, 162, '#00ff00'], [2, 90, '#0000ff']].forEach(([ch, deg, col]) => {
        const a = (deg * Math.PI) / 180;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const L = Math.hypot(w, h);
        g.fillStyle = col;
        for (let v = -L; v < L; v += step) {
          for (let u = -L; u < L; u += step) {
            const x = w / 2 + u * ca - v * sa;
            const y = h / 2 + u * sa + v * ca;
            if (x < -R || y < -R || x > w + R || y > h + R) continue;
            const o = ((clamp(y | 0, 0, h - 1)) * w + clamp(x | 0, 0, w - 1)) * 4;
            const rr = R * Math.sqrt(d[o + ch] / 255) * 1.41;
            if (rr < 0.3) continue;
            g.beginPath();
            g.arc(x, y, rr, 0, Math.PI * 2);
            g.fill();
          }
        }
      });
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  mezzotint: {
    name: '메조틴트', group: '픽셀화', params: [['type', '종류', null, null, 'dots', [['dots', '고운 점'], ['lines', '짧은 선']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, data: d } = img;
      seed = 7;
      let th = 128;
      for (let i = 0, n = 0; i < d.length; i += 4, n++) {
        // lines: one random threshold held for 6 pixels along the row
        if (p.type !== 'lines' || n % w % 6 === 0) th = rnd() * 255;
        for (let k = 0; k < 3; k++) d[i + k] = d[i + k] > th ? 255 : 0;
      }
      return toCanvas(img);
    },
  },
  fragment: {
    name: '분열', group: '픽셀화', params: [],
    fn(c) {
      const out = mk(c.width, c.height);
      const g = out.getContext('2d');
      g.globalAlpha = 0.25;
      for (const [x, y] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) g.drawImage(c, x, y);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  // ---- stylize
  solarize: {
    name: '솔라리제이션', group: '스타일화', params: [],
    fn(c) {
      const img = read(c);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) if (d[i + k] > 127) d[i + k] = 255 - d[i + k];
      return toCanvas(img);
    },
  },
  diffuse: {
    name: '확산', group: '스타일화', params: [['amount', '퍼짐 (px)', 1, 10, 2]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const src = new Uint8ClampedArray(d);
      seed = 3;
      const a = Math.round(p.amount);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = clamp(x + Math.round((rnd() * 2 - 1) * a), 0, w - 1);
          const sy = clamp(y + Math.round((rnd() * 2 - 1) * a), 0, h - 1);
          const o = (y * w + x) * 4;
          const s = (sy * w + sx) * 4;
          for (let k = 0; k < 4; k++) d[o + k] = src[s + k];
        }
      }
      return toCanvas(img);
    },
  },
  wind: {
    name: '바람', group: '스타일화', params: [['strength', '세기', 1, 100, 50], ['dir', '방향', null, null, 'right', [['right', '왼쪽에서 (→)'], ['left', '오른쪽에서 (←)']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      seed = 11;
      const step = p.dir === 'left' ? -1 : 1;
      const base = 0.88 + (p.strength / 100) * 0.1;
      for (let y = 0; y < h; y++) {
        // bright pixels leave a fading streak downwind
        const k = base + rnd() * 0.015;
        let cL = 0;
        const cc = [0, 0, 0];
        for (let n = 0, x = step > 0 ? 0 : w - 1; n < w; n++, x += step) {
          const o = (y * w + x) * 4;
          const L = lum(d[o], d[o + 1], d[o + 2]);
          cL *= k;
          if (L >= cL) {
            cL = L;
            cc[0] = d[o];
            cc[1] = d[o + 1];
            cc[2] = d[o + 2];
          } else {
            const t = Math.min(0.9, (cL - L) / 70);
            for (let ch = 0; ch < 3; ch++) d[o + ch] += (cc[ch] - d[o + ch]) * t;
          }
        }
      }
      return toCanvas(img);
    },
  },
  glowingEdges: {
    name: '네온 가장자리', group: '스타일화', params: [['brightness', '밝기', 1, 20, 8], ['smooth', '부드럽게 (px)', 0, 10, 2]],
    fn(c, p) {
      const src = blurred(c, p.smooth * 0.6);
      const img = read(src);
      const { width: w, height: h, data: d } = img;
      const e = sobel(d, w, h);
      const k = p.brightness / 8;
      const sat = d.slice();
      for (let i = 0; i < w * h; i++) {
        const v = Math.min(1, (e[i] / 255) * k);
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = cl(sat[i * 4 + ch] * v * 1.6 + v * 40);
      }
      const out = toCanvas(img);
      const g = out.getContext('2d');
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  tiles: {
    name: '타일', group: '스타일화', params: [['count', '가로 타일 수', 2, 99, 10], ['offset', '최대 어긋남 (%)', 1, 99, 10]],
    fn(c, p, { bg }) {
      const w = c.width;
      const h = c.height;
      const s = w / p.count;
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      seed = 5;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const m = (s * p.offset) / 100;
          g.drawImage(c, x, y, s, s, x + (rnd() * 2 - 1) * m, y + (rnd() * 2 - 1) * m, s, s);
        }
      }
      return out;
    },
  },
  cutout: {
    name: '오려내기', group: '예술 효과', params: [['levels', '색 단계', 2, 8, 4], ['simple', '단순화', 0, 10, 4]],
    fn(c, p) {
      const img = read(blurred(c, p.simple * 0.8));
      const d = img.data;
      const step = 255 / (p.levels - 1);
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / step) * step;
      const out = toCanvas(img);
      const g = out.getContext('2d');
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  posterEdges: {
    name: '포스터 가장자리', group: '예술 효과', params: [['thickness', '가장자리 진하기', 0, 10, 4], ['levels', '색 단계', 2, 8, 5]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const e = sobel(d, w, h);
      const step = 255 / (p.levels - 1);
      for (let i = 0; i < w * h; i++) {
        const k = 1 - Math.min(1, (e[i] / 255) * (p.thickness / 3));
        for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.round(d[i * 4 + ch] / step) * step * k;
      }
      return toCanvas(img);
    },
  },
  // ---- distort
  polar: {
    name: '극좌표', group: '왜곡', slow: true, params: [['mode', '방향', null, null, 'toPolar', [['toPolar', '직각 → 극좌표 (동그랗게 말기)'], ['toRect', '극좌표 → 직각 (펴기)']]]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(cx, cy);
      return remap(c, (x, y, o) => {
        if (p.mode === 'toPolar') {
          const dx = (x - cx) / cx;
          const dy = (y - cy) / cy;
          const a = Math.atan2(dx, -dy);
          o[0] = ((a / (2 * Math.PI) + 1) % 1) * w;
          o[1] = Math.hypot(dx, dy) * h;
        } else {
          const a = (x / w) * 2 * Math.PI;
          const r = (y / h) * R;
          o[0] = cx + Math.sin(a) * r * (cx / R);
          o[1] = cy - Math.cos(a) * r * (cy / R);
        }
      });
    },
  },
  zigzag: {
    name: '지그재그 (물결 동심원)', group: '왜곡', slow: true, params: [['amount', '양', -100, 100, 30], ['ridges', '물결 수', 1, 20, 6]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(cx, cy);
      return remap(c, (x, y, o) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r >= R || r === 0) {
          o[0] = x;
          o[1] = y;
          return;
        }
        const f = (r / R) * p.ridges * 2 * Math.PI;
        const nr = r + Math.sin(f) * (p.amount / 100) * (R / p.ridges / 3) * (1 - r / R);
        o[0] = cx + (dx / r) * nr;
        o[1] = cy + (dy / r) * nr;
      });
    },
  },
  lensCorrection: {
    name: '렌즈 교정 (왜곡·색수차)', group: '렌즈', slow: true, params: [['distortion', '왜곡 (− 술통 / + 바늘꽂이)', -100, 100, 0], ['ca', '색수차 빨강/녹청', -100, 100, 0], ['scale', '확대 (%)', 50, 150, 100]],
    fn(c, p) {
      const src = read(c);
      const { width: w, height: h, data: d } = src;
      const out = new ImageData(w, h);
      const s = sampler(d, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.hypot(cx, cy);
      const k = -p.distortion / 250;
      const sc = 100 / p.scale;
      const tmp = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) * sc;
          const dy = (y + 0.5 - cy) * sc;
          const r2 = (dx * dx + dy * dy) / (R * R);
          const f = 1 + k * r2;
          const o = (y * w + x) * 4;
          // red and blue sampled at slightly different scales fix colour fringes
          for (const [ch, ca] of [[0, 1 + p.ca / 4000], [1, 1], [2, 1 - p.ca / 4000]]) {
            s(cx + dx * f * ca - 0.5, cy + dy * f * ca - 0.5, tmp, 0);
            out.data[o + ch] = tmp[ch];
            if (ch === 1) out.data[o + 3] = tmp[3];
          }
        }
      }
      return toCanvas(out);
    },
  },
  // ---- render
  lensFlare: {
    name: '렌즈 플레어', group: '렌더', params: [['x', '가로 위치 (%)', 0, 100, 25], ['y', '세로 위치 (%)', 0, 100, 25], ['brightness', '밝기 (%)', 10, 300, 100], ['color', '색', null, null, '#ffd9a0', 'color']],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const out = mk(w, h);
      const g = out.getContext('2d');
      g.drawImage(c, 0, 0);
      g.globalCompositeOperation = 'screen';
      const x = (w * p.x) / 100;
      const y = (h * p.y) / 100;
      const S = Math.min(w, h) * (p.brightness / 100);
      const [r, gg, b] = hexRgb(p.color);
      const blob = (bx, by, rad, a, inner = 0) => {
        const gr = g.createRadialGradient(bx, by, rad * inner, bx, by, rad);
        gr.addColorStop(0, `rgba(${r},${gg},${b},${a})`);
        gr.addColorStop(1, `rgba(${r},${gg},${b},0)`);
        g.fillStyle = gr;
        g.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
      };
      blob(x, y, S * 0.5, 0.9);
      blob(x, y, S * 0.08, 1);
      // streak
      g.save();
      g.translate(x, y);
      g.scale(1, 0.03);
      blob(0, 0, S * 0.9, 0.6);
      g.restore();
      // ghosts along the line through the centre
      const cx = w / 2;
      const cy = h / 2;
      [[0.5, 0.06, 0.25], [0.8, 0.03, 0.35], [1.25, 0.1, 0.18], [1.6, 0.05, 0.3], [2, 0.14, 0.12]].forEach(([t, rad, a]) => blob(x + (cx - x) * t, y + (cy - y) * t, S * rad, a, 0.6));
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  // ---- other
  highPass: {
    name: '하이 패스', group: '기타', params: [['radius', '반경 (px)', 0.5, 100, 4, 0.5]],
    fn(c, p) {
      const a = read(c);
      const b = read(blurred(c, p.radius)).data;
      const d = a.data;
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = cl(128 + d[i + k] - b[i + k]);
      return toCanvas(a);
    },
  },
  minimum: {
    name: '최소값 (어두운 곳 넓히기)', group: '기타', params: [['radius', '반경 (px)', 1, 30, 2]],
    fn(c, p) {
      const img = read(c);
      img.data.set(minMax(img.data, img.width, img.height, Math.round(p.radius), false));
      return toCanvas(img);
    },
  },
  maximum: {
    name: '최대값 (밝은 곳 넓히기)', group: '기타', params: [['radius', '반경 (px)', 1, 30, 2]],
    fn(c, p) {
      const img = read(c);
      img.data.set(minMax(img.data, img.width, img.height, Math.round(p.radius), true));
      return toCanvas(img);
    },
  },
  offset: {
    name: '오프셋 (밀어서 감싸기)', group: '기타', params: [['dx', '가로 (px)', -4000, 4000, 100], ['dy', '세로 (px)', -4000, 4000, 0], ['wrap', '반대쪽으로 감싸기', null, null, true, 'bool']],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const out = mk(w, h);
      const g = out.getContext('2d');
      const dx = ((p.dx % w) + w) % w;
      const dy = ((p.dy % h) + h) % h;
      if (!p.wrap) {
        g.drawImage(c, p.dx, p.dy);
        return out;
      }
      for (const ox of [dx - w, dx]) for (const oy of [dy - h, dy]) g.drawImage(c, ox, oy);
      return out;
    },
  },
  // ---- camera raw
  cameraRaw: {
    name: 'Camera Raw 필터…', group: 'Camera Raw', slow: true,
    params: [['temp', '색온도', -100, 100, 0], ['tint', '색조 (녹색↔마젠타)', -100, 100, 0], ['exposure', '노출', -4, 4, 0, 0.05], ['contrast', '대비', -100, 100, 0], ['highlights', '밝은 영역', -100, 100, 0], ['shadows', '어두운 영역', -100, 100, 0], ['whites', '흰색 계열', -100, 100, 0], ['blacks', '검정 계열', -100, 100, 0], ['texture', '텍스처', -100, 100, 0], ['clarity', '부분 대비', -100, 100, 0], ['dehaze', '디헤이즈 (안개 제거)', -100, 100, 0], ['vibrance', '활기', -100, 100, 0], ['saturation', '채도', -100, 100, 0], ['vignette', '비네팅', -100, 100, 0], ['grain', '그레인', 0, 100, 0]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const need = (k) => p[k] && Math.abs(p[k]) > 0.001;
      const big = need('clarity') || need('dehaze') ? read(blurred(c, Math.max(4, Math.min(w, h) / 40))).data : null;
      const fine = need('texture') ? read(blurred(c, 2)).data : null;
      const ex = Math.pow(2, p.exposure || 0);
      const wbR = 1 + p.temp / 250 + p.tint / 600;
      const wbG = 1 - p.tint / 300;
      const wbB = 1 - p.temp / 250 + p.tint / 600;
      const con = 1 + p.contrast / 100;
      const cx = w / 2;
      const cy = h / 2;
      const R2 = cx * cx + cy * cy;
      seed = 9;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          let r = d[o] * wbR * ex;
          let g = d[o + 1] * wbG * ex;
          let b = d[o + 2] * wbB * ex;
          let L = lum(r, g, b);
          // tone regions
          const t = L / 255;
          let dL = 0;
          dL += (p.highlights / 100) * 70 * smooth(0.45, 1, t) * (p.highlights < 0 ? 1 : 1 - t);
          dL += (p.shadows / 100) * 70 * (1 - smooth(0, 0.55, t)) * (p.shadows > 0 ? 1 : t * 2);
          dL += (p.whites / 100) * 50 * smooth(0.7, 1, t);
          dL += (p.blacks / 100) * 50 * (1 - smooth(0, 0.3, t));
          dL += (L - 128) * (con - 1) * 0.8;
          if (big) {
            const bo = big[o] * 0.299 + big[o + 1] * 0.587 + big[o + 2] * 0.114;
            dL += (L - bo) * (p.clarity / 100) * 1.2 * (1 - Math.abs(t - 0.5));
            if (p.dehaze) dL += (L - bo) * (p.dehaze / 100) * 0.8 - (p.dehaze / 100) * 18 * (1 - t);
          }
          if (fine) dL += (L - (fine[o] * 0.299 + fine[o + 1] * 0.587 + fine[o + 2] * 0.114)) * (p.texture / 100) * 1.5;
          if (p.vignette) {
            const v = ((x - cx) ** 2 + (y - cy) ** 2) / R2;
            dL += -(p.vignette / 100) * 120 * smooth(0.25, 1, v);
          }
          if (dL) {
            const k = L > 1 ? (L + dL) / L : 1;
            r = k > 0 ? r * k : 0;
            g = k > 0 ? g * k : 0;
            b = k > 0 ? b * k : 0;
            if (L <= 1) {
              r += dL;
              g += dL;
              b += dL;
            }
          }
          L = lum(r, g, b);
          const sat = (p.saturation + (p.dehaze > 0 ? p.dehaze / 4 : 0)) / 100;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const curS = mx ? (mx - mn) / mx : 0;
          const vib = (p.vibrance / 100) * (1 - curS);
          const sk = 1 + sat + vib;
          r = L + (r - L) * sk;
          g = L + (g - L) * sk;
          b = L + (b - L) * sk;
          if (p.grain) {
            const n = (rnd() - 0.5) * p.grain * 0.9;
            r += n;
            g += n;
            b += n;
          }
          d[o] = cl(r);
          d[o + 1] = cl(g);
          d[o + 2] = cl(b);
        }
      }
      return toCanvas(img);
    },
  },
};

// ---------------------------------------------------------------- adjustments

const COLOR_SETS = [['reds', '빨강 계열'], ['yellows', '노랑 계열'], ['greens', '녹색 계열'], ['cyans', '녹청 계열'], ['blues', '파랑 계열'], ['magentas', '마젠타 계열'], ['whites', '흰색 계열'], ['neutrals', '중간 회색 계열'], ['blacks', '검정 계열']];
const HUES = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

function hueOf(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return [0, 0];
  const dd = mx - mn;
  let hh = mx === r ? (g - b) / dd : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  hh = (hh * 60 + 360) % 360;
  return [hh, dd / 255];
}

const LOOKS = [['warmFilm', '따뜻한 필름'], ['coolBlue', '차가운 블루'], ['tealOrange', '틸 앤 오렌지'], ['fadedVintage', '바랜 빈티지'], ['bwContrast', '흑백 고대비'], ['purpleDusk', '보라빛 노을'], ['greenMatrix', '녹색 톤'], ['bleach', '블리치 바이패스']];

const A = {
  shadowsHighlights: {
    name: '어두운 영역/밝은 영역', params: [['shadows', '어두운 영역 밝히기 (%)', 0, 100, 35], ['highlights', '밝은 영역 누르기 (%)', 0, 100, 0], ['radius', '범위 (px)', 1, 200, 30], ['color', '색상 보정', -100, 100, 20]],
    fn(img, p) {
      const { width: w, height: h, data: d } = img;
      const bl = read(blurred(toCanvas(img), p.radius)).data;
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const L = lum(d[o], d[o + 1], d[o + 2]);
        const t = lum(bl[o], bl[o + 1], bl[o + 2]) / 255;
        let k = 1;
        k += (p.shadows / 100) * 1.6 * (1 - smooth(0, 0.6, t)) * (1 - L / 255);
        k -= (p.highlights / 100) * 0.6 * smooth(0.45, 1, t) * (L / 255);
        const sk = 1 + ((p.color / 100) * Math.abs(k - 1)) / 2;
        for (let c = 0; c < 3; c++) {
          const v = d[o + c] * k;
          const Lk = L * k;
          d[o + c] = cl(Lk + (v - Lk) * sk);
        }
      }
    },
  },
  selectiveColor: {
    name: '선택 색상', params: [['target', '색상', null, null, 'reds', COLOR_SETS], ['cyan', '녹청', -100, 100, 0], ['magenta', '마젠타', -100, 100, 0], ['yellow', '노랑', -100, 100, 0], ['black', '검정', -100, 100, 0], ['absolute', '절대치 (끄면 상대치)', null, null, false, 'bool']],
    fn(img, p) {
      const d = img.data;
      const t = p.target;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        let wgt;
        if (t in HUES) {
          const [hh, s] = hueOf(r, g, b);
          let dh = Math.abs(hh - HUES[t]);
          if (dh > 180) dh = 360 - dh;
          wgt = Math.max(0, 1 - dh / 60) * s;
        } else {
          const L = lum(r, g, b) / 255;
          wgt = t === 'whites' ? smooth(0.5, 1, L) : t === 'blacks' ? 1 - smooth(0, 0.5, L) : 1 - Math.abs(L - 0.5) * 2;
        }
        if (wgt <= 0) continue;
        const adj = (v, amt) => {
          // CMY ink: more ink = less light
          const ink = 1 - v / 255;
          const delta = (amt / 100) * (p.absolute ? 1 : ink);
          return cl((1 - (ink + delta)) * 255);
        };
        const nr = adj(adj(r, p.cyan), p.black);
        const ng = adj(adj(g, p.magenta), p.black);
        const nb = adj(adj(b, p.yellow), p.black);
        d[i] = r + (nr - r) * wgt;
        d[i + 1] = g + (ng - g) * wgt;
        d[i + 2] = b + (nb - b) * wgt;
      }
    },
  },
  channelMixer: {
    name: '채널 혼합', params: [['rr', '빨강 출력: 빨강', -200, 200, 100], ['rg', '빨강 출력: 녹색', -200, 200, 0], ['rb', '빨강 출력: 파랑', -200, 200, 0], ['gr', '녹색 출력: 빨강', -200, 200, 0], ['gg', '녹색 출력: 녹색', -200, 200, 100], ['gb', '녹색 출력: 파랑', -200, 200, 0], ['br', '파랑 출력: 빨강', -200, 200, 0], ['bg', '파랑 출력: 녹색', -200, 200, 0], ['bb', '파랑 출력: 파랑', -200, 200, 100], ['constant', '상수', -100, 100, 0], ['mono', '흑백 (빨강 출력 값으로)', null, null, false, 'bool']],
    fn(img, p) {
      const d = img.data;
      const k = p.constant * 2.55;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const R = (r * p.rr + g * p.rg + b * p.rb) / 100 + k;
        if (p.mono) {
          d[i] = d[i + 1] = d[i + 2] = cl(R);
          continue;
        }
        d[i] = cl(R);
        d[i + 1] = cl((r * p.gr + g * p.gg + b * p.gb) / 100 + k);
        d[i + 2] = cl((r * p.br + g * p.bg + b * p.bb) / 100 + k);
      }
    },
  },
  replaceColor: {
    name: '색상 대체', params: [['color', '바꿀 색', null, null, '#d03030', 'color'], ['fuzz', '허용량', 1, 200, 40], ['hue', '색조', -180, 180, 120], ['saturation', '채도', -100, 100, 0], ['lightness', '밝기', -100, 100, 0]],
    fn(img, p) {
      const d = img.data;
      const [cr, cg, cb] = hexRgb(p.color);
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.hypot(d[i] - cr, d[i + 1] - cg, d[i + 2] - cb);
        const w = 1 - smooth(p.fuzz * 0.5, p.fuzz * 1.2, dist);
        if (w <= 0) continue;
        let [hh, s] = hueOf(d[i], d[i + 1], d[i + 2]);
        const mx = Math.max(d[i], d[i + 1], d[i + 2]) / 255;
        const mn = Math.min(d[i], d[i + 1], d[i + 2]) / 255;
        let l = (mx + mn) / 2;
        s = mx === mn ? 0 : l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
        hh = (hh + p.hue + 360) % 360;
        s = clamp(s * (1 + p.saturation / 100), 0, 1);
        l = clamp(l + (p.lightness / 100) * (p.lightness > 0 ? 1 - l : l), 0, 1);
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const pp = 2 * l - q;
        const f = (tt) => {
          tt = ((tt % 1) + 1) % 1;
          return tt < 1 / 6 ? pp + (q - pp) * 6 * tt : tt < 0.5 ? q : tt < 2 / 3 ? pp + (q - pp) * (2 / 3 - tt) * 6 : pp;
        };
        const H = hh / 360;
        const rgb = [f(H + 1 / 3), f(H), f(H - 1 / 3)];
        for (let c = 0; c < 3; c++) d[i + c] += (rgb[c] * 255 - d[i + c]) * w;
      }
    },
  },
  equalize: {
    name: '평활화', params: [],
    fn(img) {
      const d = img.data;
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
    },
  },
  colorLookup: {
    name: '색상 검색 (룩)', params: [['look', '룩', null, null, 'tealOrange', LOOKS], ['amount', '강도 (%)', 0, 100, 80]],
    fn(img, p) {
      const d = img.data;
      const a = p.amount / 100;
      const sc = (v, lo, hi) => lo + (v / 255) * (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const L = lum(r, g, b);
        const t = L / 255;
        let o;
        switch (p.look) {
          case 'warmFilm': o = [sc(r, 18, 255), sc(g, 12, 242), sc(b, 10, 215)]; break;
          case 'coolBlue': o = [sc(r, 0, 225), sc(g, 8, 240), sc(b, 25, 255)]; break;
          case 'tealOrange': {
            // shadows toward teal, highlights toward orange
            const sh = 1 - smooth(0, 0.6, t);
            const hi = smooth(0.4, 1, t);
            o = [r - 22 * sh + 26 * hi, g + 8 * sh + 6 * hi, b + 20 * sh - 30 * hi];
            const k = 1.12;
            o = o.map((v) => L + (v - L) * k);
            break;
          }
          case 'fadedVintage': o = [sc(r, 35, 235), sc(g, 30, 225), sc(b, 40, 200)].map((v) => L * 0.25 + v * 0.75); break;
          case 'bwContrast': {
            const v = cl((L - 128) * 1.35 + 128);
            o = [v, v, v];
            break;
          }
          case 'purpleDusk': o = [r * 1.02 + 18 * (1 - t), g * 0.9, b * 1.05 + 30 * (1 - t)]; break;
          case 'greenMatrix': o = [r * 0.8, g * 1.05 + 10, b * 0.75]; break;
          case 'bleach': {
            const k = 0.45;
            const c2 = (v) => cl((v - 128) * 1.25 + 128);
            o = [c2(r * (1 - k) + L * k), c2(g * (1 - k) + L * k), c2(b * (1 - k) + L * k)];
            break;
          }
          default: o = [r, g, b];
        }
        d[i] = cl(r + (o[0] - r) * a);
        d[i + 1] = cl(g + (o[1] - g) * a);
        d[i + 2] = cl(b + (o[2] - b) * a);
      }
    },
  },
};

Object.assign(FILTERS, F);
Object.assign(ADJUSTMENTS, A);

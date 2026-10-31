// More filters, registered into FILTERS of adjust.js (each entry carries its own fn, so menus,
// dialogs, smart filters and actions pick them up unchanged): fn(canvas, params, { fg, bg, mask })
// → new canvas. `mask` is the selection (selected = opaque) when one limits the filter.

import { FILTERS } from './adjust.js';
import { mk, read, toCanvas, hexRgb, lum, cl, clamp, smooth, blurred, sampler, remap, medianData, minMax } from './fxcore.js';

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
    fn(c, p, { mask } = {}) {
      // the average colour of the selected pixels (all of them without a selection)
      const img = read(c);
      const d = img.data;
      const m = mask ? read(mask).data : null;
      const s = [0, 0, 0];
      let a = 0;
      for (let i = 0; i < d.length; i += 4) {
        const k = d[i + 3] * (m ? m[i + 3] / 255 : 1);
        s[0] += d[i] * k;
        s[1] += d[i + 1] * k;
        s[2] += d[i + 2] * k;
        a += k;
      }
      if (!a) return c;
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
    name: '표면 흐림 효과', group: '흐림 효과', slow: true, params: [['radius', '반경 (픽셀)', 1, 100, 5], ['threshold', '한계값 (레벨)', 2, 255, 15]],
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
            out[i + ch] = ws ? s / ws : v0;
          }
        }
      }
      img.data.set(out);
      return toCanvas(img);
    },
  },
  tiltShift: {
    name: '기울기-이동', group: '흐림 효과 갤러리', params: [['center', '초점 위치 (%)', 0, 100, 55], ['focus', '선명한 띠 (%)', 0, 80, 18], ['fade', '흐려지는 폭 (%)', 1, 80, 22], ['angle', '각도', -90, 90, 0], ['blur', '흐림 (px)', 1, 60, 14], ['saturate', '채도 높이기', 0, 100, 25]],
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
    name: '조리개 흐림 효과', group: '흐림 효과 갤러리', params: [['x', '중심 가로 (%)', 0, 100, 50], ['y', '중심 세로 (%)', 0, 100, 50], ['radius', '선명한 크기 (%)', 2, 100, 28], ['aspect', '가로세로 비율 (%)', 20, 500, 100], ['fade', '흐려지는 폭 (%)', 1, 100, 30], ['blur', '흐림 (px)', 1, 60, 16]],
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
    name: '먼지와 스크래치', group: '노이즈', slow: true, params: [['radius', '반경 (픽셀)', 1, 100, 1], ['threshold', '한계값 (레벨)', 0, 255, 0]],
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
    name: '색상 하프톤', group: '픽셀화', params: [['radius', '최대 반경 (픽셀)', 4, 127, 8], ['a1', '스크린 각도: 채널 1 (빨강)', -360, 360, 108], ['a2', '스크린 각도: 채널 2 (녹색)', -360, 360, 162], ['a3', '스크린 각도: 채널 3 (파랑)', -360, 360, 90]],
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
      [[0, p.a1 ?? 108, '#ff0000'], [1, p.a2 ?? 162, '#00ff00'], [2, p.a3 ?? 90, '#0000ff']].forEach(([ch, deg, col]) => {
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
    name: '메조틴트', group: '픽셀화', params: [['type', '유형', null, null, 'fineDots', [['fineDots', '미세한 점'], ['mediumDots', '중간 점'], ['grainyDots', '거친 점'], ['coarseDots', '큰 점'], ['shortLines', '짧은 선'], ['mediumLines', '중간 선'], ['longLines', '긴 선'], ['shortStrokes', '짧은 획'], ['mediumStrokes', '중간 획'], ['longStrokes', '긴 획']]]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      seed = 7;
      const t = p.type === 'dots' ? 'fineDots' : p.type === 'lines' ? 'shortLines' : p.type || 'fineDots';
      // a threshold map: random per pixel (dots), per cell (bigger dots) or held along rows (lines)
      const cell = { fineDots: 1, mediumDots: 2, grainyDots: 2, coarseDots: 3 }[t] || 1;
      const run = { shortLines: 6, mediumLines: 14, longLines: 30, shortStrokes: 5, mediumStrokes: 10, longStrokes: 20 }[t] || 0;
      const strokes = t.endsWith('Strokes');
      const T = new Float32Array(w * h);
      if (run) {
        for (let y = 0; y < h; y++) {
          let th = rnd() * 255;
          for (let x = 0; x < w; x++) {
            if (x % run === 0) th = rnd() * 255;
            T[y * w + x] = th;
          }
        }
        if (strokes) {
          // strokes run diagonally: shift each row a little
          const S = new Float32Array(T);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) T[y * w + x] = S[y * w + ((x + y) % w)];
        }
      } else {
        const cw = Math.ceil(w / cell);
        const grid = new Float32Array(cw * Math.ceil(h / cell)).map(() => rnd() * 255);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) T[y * w + x] = grid[Math.floor(y / cell) * cw + Math.floor(x / cell)] * (t === 'grainyDots' ? 0.7 + rnd() * 0.3 : 1);
      }
      for (let i = 0, n = 0; i < d.length; i += 4, n++) for (let k = 0; k < 3; k++) d[i + k] = d[i + k] > T[n] ? 255 : 0;
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
    name: '과대 노출', group: '스타일화', params: [],
    fn(c) {
      const img = read(c);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) if (d[i + k] > 127) d[i + k] = 255 - d[i + k];
      return toCanvas(img);
    },
  },
  diffuse: {
    name: '확산', group: '스타일화', params: [['mode', '모드', null, null, 'normal', [['normal', '표준'], ['darken', '어둡게만'], ['lighten', '밝게만'], ['anisotropic', '이방성']]], ['amount', '퍼짐 (픽셀)', 1, 10, 2]],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      const src = new Uint8ClampedArray(d);
      seed = 3;
      const a = Math.round(p.amount || 2);
      const mode = p.mode || 'normal';
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          let sx;
          let sy;
          if (mode === 'anisotropic') {
            // move along the edges (least change) instead of across them
            let best = Infinity;
            sx = x;
            sy = y;
            for (let k = 0; k < 4; k++) {
              const tx = clamp(x + Math.round((rnd() * 2 - 1) * a), 0, w - 1);
              const ty = clamp(y + Math.round((rnd() * 2 - 1) * a), 0, h - 1);
              const t = (ty * w + tx) * 4;
              const diff = Math.abs(src[t] - src[o]) + Math.abs(src[t + 1] - src[o + 1]) + Math.abs(src[t + 2] - src[o + 2]);
              if (diff < best) {
                best = diff;
                sx = tx;
                sy = ty;
              }
            }
          } else {
            sx = clamp(x + Math.round((rnd() * 2 - 1) * a), 0, w - 1);
            sy = clamp(y + Math.round((rnd() * 2 - 1) * a), 0, h - 1);
          }
          const s = (sy * w + sx) * 4;
          if (mode === 'darken' || mode === 'lighten') {
            const ls = lum(src[s], src[s + 1], src[s + 2]);
            const lo = lum(src[o], src[o + 1], src[o + 2]);
            if (mode === 'darken' ? ls >= lo : ls <= lo) continue;
          }
          for (let k = 0; k < 4; k++) d[o + k] = src[s + k];
        }
      }
      return toCanvas(img);
    },
  },
  wind: {
    name: '바람', group: '스타일화', params: [['method', '방법', null, null, 'wind', [['wind', '바람'], ['blast', '강풍'], ['stagger', '돌풍']]], ['dir', '방향', null, null, 'right', [['right', '오른쪽에서'], ['left', '왼쪽에서']]], ['strength', '세기', 1, 100, 50, 'hidden']],
    fn(c, p) {
      const img = read(c);
      const { width: w, height: h, data: d } = img;
      seed = 11;
      // Photoshop's direction names where the wind comes from: "from the right" streaks to the left
      const step = p.dir === 'left' ? 1 : -1;
      const method = p.method || 'wind';
      const base = method === 'blast' ? 0.975 : 0.88 + ((p.strength ?? 50) / 100) * 0.1;
      const src = method === 'stagger' ? new Uint8ClampedArray(d) : null;
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
            const t = Math.min(0.9, (cL - L) / (method === 'blast' ? 40 : 70));
            for (let ch = 0; ch < 3; ch++) d[o + ch] += (cc[ch] - d[o + ch]) * t;
          }
        }
      }
      if (src) {
        // stagger: streaks broken into short random shifts of the rows
        const out = new Uint8ClampedArray(d);
        for (let y = 0; y < h; y++) {
          let off = 0;
          for (let n = 0, x = step > 0 ? 0 : w - 1; n < w; n++, x += step) {
            if (rnd() < 0.08) off = Math.round(rnd() * 6) * -step;
            const sx = clamp(x + off, 0, w - 1);
            const o = (y * w + x) * 4;
            const s2 = (y * w + sx) * 4;
            for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.max(d[o + ch], d[s2 + ch] * 0.85 + src[o + ch] * 0.15);
          }
        }
        d.set(out);
      }
      return toCanvas(img);
    },
  },
  glowingEdges: {
    name: '가장자리 광선 효과', group: '스타일화', gallery: true, params: [['brightness', '밝기', 1, 20, 8], ['smooth', '부드럽게 (px)', 0, 10, 2]],
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
    name: '타일', group: '스타일화', params: [['count', '타일 수', 1, 99, 10], ['offset', '최대 오프셋 (%)', 1, 99, 10], ['fill', '빈 영역 채우기', null, null, 'bg', [['bg', '배경색'], ['fg', '전경색'], ['inverse', '반전 이미지'], ['original', '원본 이미지']]]],
    fn(c, p, { fg, bg }) {
      const w = c.width;
      const h = c.height;
      // the number of tiles runs along the shorter side, like Photoshop
      const s = Math.max(1, Math.min(w, h) / Math.max(1, p.count));
      const out = mk(w, h);
      const g = out.getContext('2d');
      const fill = p.fill || 'bg';
      if (fill === 'original') g.drawImage(c, 0, 0);
      else if (fill === 'inverse') {
        g.filter = 'invert(1)';
        g.drawImage(c, 0, 0);
        g.filter = 'none';
      } else {
        g.fillStyle = fill === 'fg' ? fg : bg;
        g.fillRect(0, 0, w, h);
      }
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
    name: '오려내기', group: '예술 효과', gallery: true, params: [['levels', '색 단계', 2, 8, 4], ['simple', '단순화', 0, 10, 4]],
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
    name: '포스터 가장자리', group: '예술 효과', gallery: true, params: [['thickness', '가장자리 진하기', 0, 10, 4], ['levels', '색 단계', 2, 8, 5]],
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
    name: '극좌표', group: '왜곡', slow: true, params: [['mode', '변환', null, null, 'toPolar', [['toPolar', '직교 좌표를 극좌표로'], ['toRect', '극좌표를 직교 좌표로']]]],
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
    name: '지그재그', group: '왜곡', slow: true, params: [['amount', '양', -100, 100, 10], ['ridges', '능선', 0, 20, 5], ['style', '스타일', null, null, 'pond', [['around', '중앙 둘레'], ['out', '중앙에서 바깥쪽으로'], ['pond', '물결 무늬']]]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(cx, cy);
      const ridges = Math.max(0.5, p.ridges || 0.5);
      const amt = (p.amount || 0) / 100;
      const style = p.style || 'pond';
      return remap(c, (x, y, o) => {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r >= R || r === 0) {
          o[0] = x;
          o[1] = y;
          return;
        }
        const t = r / R;
        const f = t * ridges * 2 * Math.PI;
        const fade = 1 - t;
        if (style === 'around') {
          // rotate back and forth around the centre
          const a = Math.sin(f) * amt * 0.6 * fade;
          o[0] = cx + dx * Math.cos(a) - dy * Math.sin(a);
          o[1] = cy + dx * Math.sin(a) + dy * Math.cos(a);
          return;
        }
        const k = style === 'out' ? Math.sin(f) * amt * (R / ridges / 2) * fade : Math.sin(f) * amt * (R / ridges / 3) * fade + amt * 0.15 * Math.sin(f * 0.5) * (R / ridges / 3) * fade;
        const nr = r + k;
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
    name: '렌즈 플레어', group: '렌더', params: [['x', '플레어 중심: 가로 (%)', 0, 100, 25], ['y', '플레어 중심: 세로 (%)', 0, 100, 25], ['brightness', '명도 (%)', 10, 300, 100], ['lens', '렌즈 유형', null, null, 'zoom', [['zoom', '50-300mm 확대/축소'], ['p35', '35mm 프라임'], ['p105', '105mm 프라임'], ['movie', '동영상 프라임']]], ['color', '색', null, null, '#ffd9a0', 'color']],
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
      const blob = (bx, by, rad, a, inner = 0, col = [r, gg, b]) => {
        if (rad <= 0) return;
        const gr = g.createRadialGradient(bx, by, rad * inner, bx, by, rad);
        gr.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
        gr.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        g.fillStyle = gr;
        g.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
      };
      const lens = p.lens || 'zoom';
      blob(x, y, S * (lens === 'p105' ? 0.35 : 0.5), 0.9);
      blob(x, y, S * 0.08, 1);
      // streak (a long horizontal one for the movie lens)
      g.save();
      g.translate(x, y);
      g.scale(1, lens === 'movie' ? 0.012 : 0.03);
      blob(0, 0, S * (lens === 'movie' ? 2.2 : 0.9), lens === 'movie' ? 0.8 : 0.6, 0, lens === 'movie' ? [150, 190, 255] : [r, gg, b]);
      g.restore();
      // ghosts along the line through the centre
      const cx = w / 2;
      const cy = h / 2;
      const ghosts = {
        zoom: [[0.5, 0.06, 0.25], [0.8, 0.03, 0.35], [1.25, 0.1, 0.18], [1.6, 0.05, 0.3], [2, 0.14, 0.12]],
        p35: [[0.7, 0.04, 0.3], [1.3, 0.08, 0.2], [1.9, 0.12, 0.12]],
        p105: [[0.6, 0.03, 0.25], [1.5, 0.05, 0.2]],
        movie: [[0.6, 0.05, 0.2], [1.4, 0.07, 0.15], [2, 0.03, 0.25]],
      }[lens] || [];
      ghosts.forEach(([t, rad, a]) => blob(x + (cx - x) * t, y + (cy - y) * t, S * rad, a, 0.6));
      if (lens === 'p105') {
        // a bright ring around the source
        g.strokeStyle = `rgba(${r},${gg},${b},0.25)`;
        g.lineWidth = Math.max(1, S * 0.01);
        g.beginPath();
        g.arc(x, y, S * 0.25, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(c, 0, 0);
      return out;
    },
  },
  // ---- other
  highPass: {
    name: '하이 패스', group: '기타', params: [['radius', '반경 (픽셀)', 0.1, 1000, 10, 0.1]],
    fn(c, p) {
      const a = read(c);
      const b = read(blurred(c, p.radius)).data;
      const d = a.data;
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = cl(128 + d[i + k] - b[i + k]);
      return toCanvas(a);
    },
  },
  minimum: {
    name: '최솟값', group: '기타', params: [['radius', '반경 (픽셀)', 1, 100, 1], ['round', '보존', null, null, false, [[false, '직각'], [true, '원형']]]],
    fn(c, p) {
      const img = read(c);
      img.data.set(minMax(img.data, img.width, img.height, Math.round(p.radius), false, p.round === true || p.round === 'true'));
      return toCanvas(img);
    },
  },
  maximum: {
    name: '최댓값', group: '기타', params: [['radius', '반경 (픽셀)', 1, 100, 1], ['round', '보존', null, null, false, [[false, '직각'], [true, '원형']]]],
    fn(c, p) {
      const img = read(c);
      img.data.set(minMax(img.data, img.width, img.height, Math.round(p.radius), true, p.round === true || p.round === 'true'));
      return toCanvas(img);
    },
  },
  offset: {
    name: '오프셋', group: '기타', params: [['dx', '가로: 픽셀 오른쪽으로', -30000, 30000, 100], ['dy', '세로: 픽셀 아래로', -30000, 30000, 0], ['undef', '정의되지 않은 영역', null, null, 'wrap', [['background', '배경으로 설정 (투명)'], ['repeat', '가장자리 픽셀 반복'], ['wrap', '둘러싸기']]]],
    fn(c, p) {
      const w = c.width;
      const h = c.height;
      const out = mk(w, h);
      const g = out.getContext('2d');
      const undef = p.undef || (p.wrap === false ? 'background' : 'wrap');
      const ox = Math.round(+p.dx || 0);
      const oy = Math.round(+p.dy || 0);
      if (undef === 'wrap') {
        const dx = ((ox % w) + w) % w;
        const dy = ((oy % h) + h) % h;
        for (const x of [dx - w, dx]) for (const y of [dy - h, dy]) g.drawImage(c, x, y);
        return out;
      }
      if (undef === 'repeat') {
        // stretch the edge row / column into the uncovered strips, then the picture itself
        const sx = clamp(ox, -w, w);
        const sy = clamp(oy, -h, h);
        if (sx > 0) g.drawImage(c, 0, 0, 1, h, 0, sy, sx, h);
        if (sx < 0) g.drawImage(c, w - 1, 0, 1, h, w + sx, sy, -sx, h);
        if (sy > 0) g.drawImage(c, 0, 0, w, 1, sx, 0, w, sy);
        if (sy < 0) g.drawImage(c, 0, h - 1, w, 1, sx, h + sy, w, -sy);
        // corners
        const corner = (srcX, srcY, x, y, cw, chh) => cw > 0 && chh > 0 && g.drawImage(c, srcX, srcY, 1, 1, x, y, cw, chh);
        if (sx > 0 && sy > 0) corner(0, 0, 0, 0, sx, sy);
        if (sx < 0 && sy > 0) corner(w - 1, 0, w + sx, 0, -sx, sy);
        if (sx > 0 && sy < 0) corner(0, h - 1, 0, h + sy, sx, -sy);
        if (sx < 0 && sy < 0) corner(w - 1, h - 1, w + sx, h + sy, -sx, -sy);
        g.drawImage(c, sx, sy);
        return out;
      }
      g.drawImage(c, ox, oy);
      return out;
    },
  },
  // ---- camera raw
};

Object.assign(FILTERS, F);

// shared with the filters in fx3.js and the filter gallery
export { blurred, remap, sampler, medianData };

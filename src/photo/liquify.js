// Filter ▸ Liquify (Shift+Ctrl+X): forward warp, reconstruct, smooth, twirl, pucker, bloat, push left,
// freeze / thaw mask, the face tool with Photoshop's Face-Aware Liquify sliders (eyes, nose, mouth,
// face shape) for a face the user marks with a box, and the hand and zoom tools. Brush size (in image
// pixels) / density / pressure / rate, stylus pressure, mesh view and pin edges.
// The picture is edited through a displacement map at up to about 900 × 620 (each map pixel moves
// the source by D[p] + face[p]). The view is a window onto the picture that zooms and pans (Ctrl+ +/−,
// Ctrl+0, Ctrl+1, Space or H to pan); zoomed in, it is drawn from the full-size pixels through the
// map. OK scales the map up and resamples the full-size layer once.

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { applyToLayer } from './pdialogs.js';
import { ensureAdjStyle } from './adjui.js';

const TOOLS = [
  ['warp', '뒤틀기 도구 (밀기)', 'W', '<path d="M2.5 11c2.5 0 3-6 6-6s3 3 5 3"/><path d="M11 5.5 13.5 8 11 10.5"/>'],
  ['reconstruct', '재구성 도구', 'R', '<path d="M3.5 6.5A5 5 0 1 1 3 9M3.5 3v3.5H7"/>'],
  ['smooth', '매끄럽게 도구', 'E', '<path d="M2 10c2-4 4-4 6 0s4 4 6 0"/>'],
  ['twirl', '시계 방향 돌리기 도구 (Alt: 반대)', 'C', '<path d="M8 8a1.5 1.5 0 1 1 1.5 1.5A3 3 0 1 1 12.5 6.5 4.5 4.5 0 1 1 8 3.5"/>'],
  ['pucker', '오목 도구', 'S', '<circle cx="8" cy="8" r="5.5"/><path d="M8 3.5v2.5M8 10v2.5M3.5 8H6M10 8h2.5"/>'],
  ['bloat', '볼록 도구', 'B', '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>'],
  ['pushLeft', '왼쪽 밀기 도구', 'O', '<path d="M3 4h10M3 8h10M3 12h10"/><path d="M6 2 3 4l3 2"/>'],
  ['freeze', '마스크 고정 도구', 'F', '<path d="M8 2v12M3 5l10 6M13 5 3 11"/>'],
  ['thaw', '마스크 고정 해제 도구', 'D', '<path d="M8 2v12M3 5l10 6M13 5 3 11"/><path d="M2 14 14 2"/>'],
  ['face', '얼굴 도구 (얼굴을 상자로 지정)', 'A', '<circle cx="8" cy="8" r="6"/><circle cx="6" cy="6.5" r=".6"/><circle cx="10" cy="6.5" r=".6"/><path d="M5.5 10c1.5 1.4 3.5 1.4 5 0"/>'],
  ['hand', '손 도구 (Space를 누른 채 끌어도 됩니다)', 'H', '<path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4.5M9.5 7.2V4a1 1 0 0 1 2 0v5.5c0 2.6-1.6 4.5-4 4.5-1.8 0-2.8-.9-3.8-2.4L2.4 8.8a1 1 0 0 1 1.6-1.2L5.5 9.3"/>'],
  ['zoom', '확대/축소 도구 (Alt: 축소)', 'Z', '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M5 7h4M7 5v4"/>'],
];

// Face-Aware Liquify sliders: [key, label, group]
const FACE = [
  ['eyeSize', '눈 크기', '눈'], ['eyeHeight', '눈 높이', '눈'], ['eyeWidth', '눈 폭', '눈'], ['eyeTilt', '눈 기울기', '눈'], ['eyeDist', '눈 거리', '눈'],
  ['noseHeight', '코 높이', '코'], ['noseWidth', '코 폭', '코'],
  ['smile', '미소', '입'], ['upperLip', '윗입술', '입'], ['lowerLip', '아랫입술', '입'], ['mouthWidth', '입 폭', '입'], ['mouthHeight', '입 높이', '입'],
  ['forehead', '이마', '얼굴 모양'], ['chin', '턱 높이', '얼굴 모양'], ['jaw', '턱선', '얼굴 모양'], ['faceWidth', '얼굴 폭', '얼굴 모양'],
];

const svg = (p) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.3');
  s.setAttribute('stroke-linecap', 'round');
  s.innerHTML = p;
  return s;
};

/** Bilinear sample of a 2-channel field at (x, y). */
function field2(D, w, hh, x, y, o) {
  x = clamp(x, 0, w - 1.001);
  y = clamp(y, 0, hh - 1.001);
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = (y0 * w + x0) * 2;
  const j = w > 1 ? i + 2 : i;
  const m = hh > 1 ? i + w * 2 : i;
  const n = w > 1 ? m + 2 : m;
  o[0] = (D[i] * (1 - fx) + D[j] * fx) * (1 - fy) + (D[m] * (1 - fx) + D[n] * fx) * fy;
  o[1] = (D[i + 1] * (1 - fx) + D[j + 1] * fx) * (1 - fy) + (D[m + 1] * (1 - fx) + D[n + 1] * fx) * fy;
}

/** Resample src (RGBA w×h) through the map: out[p] = src[p + D(p)·k], D at grid size gw×gh. */
function warpImage(src, w, hh, D, gw, gh) {
  const out = new ImageData(w, hh);
  const o = out.data;
  const sx = gw / w;
  const sy = gh / hh;
  const v = [0, 0];
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      field2(D, gw, gh, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, v);
      let px = x + v[0] / sx;
      let py = y + v[1] / sy;
      px = clamp(px, 0, w - 1.001);
      py = clamp(py, 0, hh - 1.001);
      const x0 = px | 0;
      const y0 = py | 0;
      const fx = px - x0;
      const fy = py - y0;
      const i = (y0 * w + x0) * 4;
      const j = w > 1 ? i + 4 : i;
      const m = hh > 1 ? i + w * 4 : i;
      const n = w > 1 ? m + 4 : m;
      const k = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) o[k + c] = (src[i + c] * (1 - fx) + src[j + c] * fx) * (1 - fy) + (src[m + c] * (1 - fx) + src[n + c] * fx) * fy;
    }
  }
  return out;
}

/** Feature points of a face box (preview pixels): eyes, nose, mouth corners, chin, jaw, forehead. */
function faceFeatures(b) {
  const at = (u, v) => [b.x + b.w * u, b.y + b.h * v];
  return { le: at(0.31, 0.42), re: at(0.69, 0.42), nose: at(0.5, 0.62), mouth: at(0.5, 0.78), chin: at(0.5, 0.97), jawL: at(0.14, 0.78), jawR: at(0.86, 0.78), forehead: at(0.5, 0.12) };
}

/**
 * The face sliders as one offset field (preview pixels): out(p) = src(p + O(p)). Each slider is a
 * smooth local move / scale / turn around its feature; they are small, so their offsets add up.
 */
function faceField(F, pw, ph, box, v, pts) {
  F.fill(0);
  if (!box) return;
  const any = FACE.some(([k]) => v[k]);
  if (!any) return;
  const W = box.w;
  const H = box.h;
  const fall = (dx, dy, R) => {
    const r2 = (dx * dx + dy * dy) / (R * R);
    return r2 >= 1 ? 0 : (1 - r2) * (1 - r2);
  };
  const ops = [];
  const eyeR = W * 0.17;
  for (const [c, side] of [[pts.le, -1], [pts.re, 1]]) {
    // size: scale about the eye; width: scale in x; height: move up; tilt: turn; distance: move out
    if (v.eyeSize) ops.push((x, y, o) => {
      const f = fall(x - c[0], y - c[1], eyeR);
      if (!f) return;
      const k = 1 + (v.eyeSize / 100) * 0.35 * f;
      o[0] += (x - c[0]) * (1 / k - 1);
      o[1] += (y - c[1]) * (1 / k - 1);
    });
    if (v.eyeWidth) ops.push((x, y, o) => {
      const f = fall(x - c[0], y - c[1], eyeR);
      if (f) o[0] += (x - c[0]) * (1 / (1 + (v.eyeWidth / 100) * 0.35 * f) - 1);
    });
    if (v.eyeHeight) ops.push((x, y, o) => {
      const f = fall(x - c[0], y - c[1], eyeR * 1.2);
      if (f) o[1] += (v.eyeHeight / 100) * H * 0.05 * f;
    });
    if (v.eyeTilt) ops.push((x, y, o) => {
      const f = fall(x - c[0], y - c[1], eyeR);
      if (!f) return;
      const a = -side * (v.eyeTilt / 100) * 0.35 * f;
      const dx = x - c[0];
      const dy = y - c[1];
      o[0] += dx * Math.cos(a) - dy * Math.sin(a) - dx;
      o[1] += dx * Math.sin(a) + dy * Math.cos(a) - dy;
    });
    if (v.eyeDist) ops.push((x, y, o) => {
      const f = fall(x - c[0], y - c[1], eyeR * 1.3);
      if (f) o[0] -= side * (v.eyeDist / 100) * W * 0.05 * f;
    });
  }
  const nR = W * 0.2;
  const n = pts.nose;
  if (v.noseHeight) ops.push((x, y, o) => {
    const f = fall(x - n[0], y - n[1], nR);
    if (f) o[1] += (v.noseHeight / 100) * H * 0.05 * f;
  });
  if (v.noseWidth) ops.push((x, y, o) => {
    const f = fall(x - n[0], (y - n[1]) * 1.3, nR);
    if (f) o[0] += (x - n[0]) * (1 / (1 + (v.noseWidth / 100) * 0.4 * f) - 1);
  });
  const m = pts.mouth;
  const mw = W * 0.18;
  if (v.smile) ops.push((x, y, o) => {
    // the mouth corners go up (a smile) or down
    for (const s of [-1, 1]) {
      const f = fall(x - (m[0] + s * mw), y - m[1], W * 0.14);
      if (f) o[1] += (v.smile / 100) * H * 0.04 * f;
    }
    const fc = fall(x - m[0], y - m[1], mw);
    if (fc) o[1] -= (v.smile / 100) * H * 0.008 * fc;
  });
  if (v.mouthWidth) ops.push((x, y, o) => {
    const f = fall((x - m[0]) * 0.8, (y - m[1]) * 1.6, mw * 1.3);
    if (f) o[0] += (x - m[0]) * (1 / (1 + (v.mouthWidth / 100) * 0.35 * f) - 1);
  });
  if (v.mouthHeight) ops.push((x, y, o) => {
    const f = fall((x - m[0]) * 0.8, y - m[1], mw * 1.3);
    if (f) o[1] += (v.mouthHeight / 100) * H * 0.05 * f;
  });
  if (v.upperLip) ops.push((x, y, o) => {
    const f = fall((x - m[0]) * 0.9, y - (m[1] - H * 0.03), mw);
    if (f && y < m[1]) o[1] += (v.upperLip / 100) * H * 0.025 * f;
  });
  if (v.lowerLip) ops.push((x, y, o) => {
    const f = fall((x - m[0]) * 0.9, y - (m[1] + H * 0.03), mw);
    if (f && y > m[1]) o[1] -= (v.lowerLip / 100) * H * 0.025 * f;
  });
  const fh = pts.forehead;
  if (v.forehead) ops.push((x, y, o) => {
    const f = fall((x - fh[0]) * 0.7, y - fh[1], W * 0.45);
    if (f) o[1] += (v.forehead / 100) * H * 0.06 * f;
  });
  const ch = pts.chin;
  if (v.chin) ops.push((x, y, o) => {
    const f = fall((x - ch[0]) * 0.9, y - ch[1], W * 0.3);
    if (f) o[1] -= (v.chin / 100) * H * 0.06 * f;
  });
  if (v.jaw) ops.push((x, y, o) => {
    for (const [c, s] of [[pts.jawL, -1], [pts.jawR, 1]]) {
      const f = fall(x - c[0], y - c[1], W * 0.25);
      if (f) o[0] -= s * (v.jaw / 100) * W * 0.05 * f;
    }
  });
  if (v.faceWidth) ops.push((x, y, o) => {
    const cx = box.x + W / 2;
    const cy = box.y + H * 0.55;
    const f = fall((x - cx) / 1.1, (y - cy) * (W / H), W * 0.62);
    if (f) o[0] += (x - cx) * (1 / (1 + (v.faceWidth / 100) * 0.12 * f) - 1);
  });
  // only the area around the face
  const x0 = Math.max(0, Math.floor(box.x - W * 0.4));
  const y0 = Math.max(0, Math.floor(box.y - H * 0.4));
  const x1 = Math.min(pw, Math.ceil(box.x + W * 1.4));
  const y1 = Math.min(ph, Math.ceil(box.y + H * 1.4));
  const o = [0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      o[0] = 0;
      o[1] = 0;
      for (const op of ops) op(x + 0.5, y + 0.5, o);
      const p = (y * pw + x) * 2;
      F[p] = o[0];
      F[p + 1] = o[1];
    }
  }
}


const ZOOMS = [0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 6, 8, 12, 16];

export function liquifyDialog(P) {
  const doc = P.doc;
  const l = doc?.active;
  if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 고르세요. 글자·모양·고급 개체는 래스터화한 뒤 쓰세요.');
  ensureAdjStyle();
  const full = l.canvas;
  const W = full.width;
  const H = full.height;
  // the map (and the picture shown when zoomed out) at up to about 900 × 620
  const s = Math.min(1, 900 / W, 620 / H);
  const pw = Math.max(1, Math.round(W * s));
  const ph = Math.max(1, Math.round(H * s));
  const kx = pw / W;
  const ky = ph / H;
  const small = makeCanvas(pw, ph);
  {
    const g = small.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, pw, ph);
  }
  const src = small.getContext('2d').getImageData(0, 0, pw, ph).data;
  // the full-size pixels, read the first time the view is zoomed in past the map
  let fd = null;
  const fullData = () => (fd ||= full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data);
  let D = new Float32Array(pw * ph * 2);
  const FO = new Float32Array(pw * ph * 2);
  const F = new Float32Array(pw * ph);
  const undo = [];

  // st.size is the brush diameter in image pixels (as in Photoshop)
  const st = { tool: 'warp', size: Math.max(4, Math.round(Math.min(W, H) / 6)), pressure: 50, density: 50, rate: 80, stylus: false, showMask: true, showMesh: false, showImage: true, pinEdges: false };
  const face = { box: null, pts: null, v: Object.fromEntries(FACE.map(([k]) => [k, 0])) };
  const view = h('canvas.lq-view', { width: 1, height: 1 });
  const vg = view.getContext('2d');
  const over = h('canvas.lq-over', { width: 1, height: 1 });
  const og = over.getContext('2d');
  let img = null;
  // the view: z screen pixels per image pixel, (x, y) the image point at the top left corner
  const vw = { z: 1, x: 0, y: 0, cw: 1, ch: 1, fit: true };
  // pin edges: the map fades to nothing at the border (no edge pixels pulled in or out)
  const edgeK = (x, y) => (st.pinEdges ? Math.max(0, Math.min(1, x / 6, y / 6, (pw - 1 - x) / 6, (ph - 1 - y) / 6)) : 1);
  const toScr = (ix, iy) => [(ix - vw.x) * vw.z, (iy - vw.y) * vw.z];

  const t0 = [0, 0];
  const t1 = [0, 0];
  /** Draw the picture into the view, in a screen rectangle (the whole view by default). */
  const render = (rx0 = 0, ry0 = 0, rx1 = vw.cw, ry1 = vw.ch) => {
    if (!img) return;
    rx0 = clamp(Math.floor(rx0), 0, vw.cw);
    ry0 = clamp(Math.floor(ry0), 0, vw.ch);
    rx1 = clamp(Math.ceil(rx1), 0, vw.cw);
    ry1 = clamp(Math.ceil(ry1), 0, vw.ch);
    if (rx1 <= rx0 || ry1 <= ry0) return;
    const o = img.data;
    const cw = vw.cw;
    // zoomed in past the map: the full-size pixels, else the map-size copy
    const hi = vw.z > kx * 1.05;
    const S = hi ? fullData() : src;
    const SW = hi ? W : pw;
    const SH = hi ? H : ph;
    const face0 = !!face.box;
    for (let y = ry0; y < ry1; y++) {
      const iy = vw.y + (y + 0.5) / vw.z;
      for (let x = rx0; x < rx1; x++) {
        const ix = vw.x + (x + 0.5) / vw.z;
        const k = (y * cw + x) * 4;
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) {
          o[k] = 43;
          o[k + 1] = 45;
          o[k + 2] = 49;
          o[k + 3] = 255;
          continue;
        }
        const mx = ix * kx - 0.5;
        const my = iy * ky - 0.5;
        if (!st.showImage) {
          o[k] = o[k + 1] = o[k + 2] = 128;
          o[k + 3] = 255;
        } else {
          field2(D, pw, ph, mx, my, t0);
          if (face0) {
            field2(FO, pw, ph, mx, my, t1);
            t0[0] += t1[0];
            t0[1] += t1[1];
          }
          const ek = edgeK(mx, my);
          // the source point: in map pixels on the small copy, in image pixels on the full one
          const px = clamp(hi ? ix + (t0[0] * ek) / kx - 0.5 : mx + t0[0] * ek, 0, SW - 1.001);
          const py = clamp(hi ? iy + (t0[1] * ek) / ky - 0.5 : my + t0[1] * ek, 0, SH - 1.001);
          const xi = px | 0;
          const yi = py | 0;
          const fx = px - xi;
          const fy = py - yi;
          const i = (yi * SW + xi) * 4;
          const j = SW > 1 ? i + 4 : i;
          const m = SH > 1 ? i + SW * 4 : i;
          const n = SW > 1 ? m + 4 : m;
          for (let c = 0; c < 4; c++) o[k + c] = (S[i + c] * (1 - fx) + S[j + c] * fx) * (1 - fy) + (S[m + c] * (1 - fx) + S[n + c] * fx) * fy;
        }
        if (st.showMask) {
          const f = F[clamp(Math.floor(iy * ky), 0, ph - 1) * pw + clamp(Math.floor(ix * kx), 0, pw - 1)];
          if (f > 0) {
            const a = f * 0.55;
            o[k] = o[k] * (1 - a) + 230 * a;
            o[k + 1] *= 1 - a;
            o[k + 2] *= 1 - a;
            o[k + 3] = Math.max(o[k + 3], 255 * a);
          }
        }
      }
    }
    vg.putImageData(img, 0, 0, rx0, ry0, rx1 - rx0, ry1 - ry0);
  };
  /** The map rectangle [x0, x1) × [y0, y1) drawn again (once per frame, all dabs together). */
  let dirty = null;
  let frame = 0;
  const renderMap = (x0, y0, x1, y1) => {
    dirty = dirty ? [Math.min(dirty[0], x0), Math.min(dirty[1], y0), Math.max(dirty[2], x1), Math.max(dirty[3], y1)] : [x0, y0, x1, y1];
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const [a, b] = toScr(dirty[0] / kx, dirty[1] / ky);
      const [c, d] = toScr(dirty[2] / kx, dirty[3] / ky);
      dirty = null;
      render(a - 2, b - 2, c + 2, d + 2);
    });
  };

  // ---- the overlay: mesh, face box, brush
  let hover = null;
  const drawMesh = () => {
    // where a regular grid of the source ends up (to a first approximation p − D(p))
    const step = Math.max(8, Math.round(Math.min(pw, ph) / 24));
    og.save();
    og.strokeStyle = 'rgba(160,170,190,.75)';
    og.lineWidth = 1;
    const pt = (x, y) => {
      const xi = clamp(Math.round(x), 0, pw - 1);
      const yi = clamp(Math.round(y), 0, ph - 1);
      const p = (yi * pw + xi) * 2;
      const ek = edgeK(xi, yi);
      return toScr((x - (D[p] + FO[p]) * ek) / kx, (y - (D[p + 1] + FO[p + 1]) * ek) / ky);
    };
    og.beginPath();
    for (let y = 0; y <= ph; y += step) {
      for (let x = 0; x <= pw; x += 4) {
        const [a, b] = pt(x, y);
        if (x) og.lineTo(a, b);
        else og.moveTo(a, b);
      }
    }
    for (let x = 0; x <= pw; x += step) {
      for (let y = 0; y <= ph; y += 4) {
        const [a, b] = pt(x, y);
        if (y) og.lineTo(a, b);
        else og.moveTo(a, b);
      }
    }
    og.stroke();
    og.restore();
  };
  const faceScr = (q) => toScr(q[0] / kx, q[1] / ky);
  const drawOverlay = () => {
    og.clearRect(0, 0, over.width, over.height);
    if (st.showMesh) drawMesh();
    if (face.box) {
      // the face box and its feature handles
      const [a, b] = faceScr([face.box.x, face.box.y]);
      const [c, d] = faceScr([face.box.x + face.box.w, face.box.y + face.box.h]);
      og.setLineDash([4, 3]);
      og.strokeStyle = '#7fd0ff';
      og.strokeRect(a, b, c - a, d - b);
      og.setLineDash([]);
      if (st.tool === 'face' && face.pts) {
        og.fillStyle = '#7fd0ff';
        for (const q of Object.values(face.pts)) {
          const [x, y] = faceScr(q);
          og.beginPath();
          og.arc(x, y, 4, 0, Math.PI * 2);
          og.fill();
        }
      }
    }
    if (!hover || ['face', 'hand', 'zoom'].includes(st.tool)) return;
    const r = (st.size / 2) * vw.z;
    for (const [c, off] of [['rgba(0,0,0,.7)', 0.5], ['#fff', 0]]) {
      og.strokeStyle = c;
      og.beginPath();
      og.arc(hover.x, hover.y, Math.max(1, r + off), 0, Math.PI * 2);
      og.stroke();
    }
  };

  // ---- zoom and pan
  const zoomLbl = h('span.mono', '100%');
  const clampView = () => {
    // a picture smaller than the view stays in the middle; a bigger one can't leave it
    const vwW = vw.cw / vw.z;
    const vwH = vw.ch / vw.z;
    vw.x = W <= vwW ? (W - vwW) / 2 : clamp(vw.x, 0, W - vwW);
    vw.y = H <= vwH ? (H - vwH) / 2 : clamp(vw.y, 0, H - vwH);
  };
  const fitZ = () => Math.min(vw.cw / W, vw.ch / H);
  const refresh = () => {
    clampView();
    zoomLbl.textContent = `${Math.round(vw.z * 1000) / 10}%`;
    render();
    drawOverlay();
  };
  /** Move the view to (nx, ny): what stays in sight is shifted, only the rest is drawn anew. */
  const scrollTo = (nx, ny) => {
    vw.fit = false;
    const ox = vw.x;
    const oy = vw.y;
    vw.x = nx;
    vw.y = ny;
    clampView();
    // whole screen pixels, so the shifted part lines up with what is drawn new
    const dx = Math.round((ox - vw.x) * vw.z);
    const dy = Math.round((oy - vw.y) * vw.z);
    vw.x = ox - dx / vw.z;
    vw.y = oy - dy / vw.z;
    if (!dx && !dy) return;
    if (Math.abs(dx) >= vw.cw || Math.abs(dy) >= vw.ch) {
      refresh();
      return;
    }
    vg.globalCompositeOperation = 'copy';
    vg.drawImage(view, dx, dy);
    vg.globalCompositeOperation = 'source-over';
    if (dx > 0) render(0, 0, dx, vw.ch);
    else if (dx < 0) render(vw.cw + dx, 0, vw.cw, vw.ch);
    if (dy > 0) render(0, 0, vw.cw, dy);
    else if (dy < 0) render(0, vw.ch + dy, vw.cw, vw.ch);
    drawOverlay();
  };
  const fit = () => {
    vw.fit = true;
    vw.z = fitZ();
    refresh();
  };
  /** Zoom to z keeping the image point under screen point (sx, sy) in place. */
  const zoomTo = (z, sx = vw.cw / 2, sy = vw.ch / 2) => {
    const ix = vw.x + sx / vw.z;
    const iy = vw.y + sy / vw.z;
    vw.z = clamp(z, Math.min(fitZ(), 0.05), 16);
    vw.fit = false;
    vw.x = ix - sx / vw.z;
    vw.y = iy - sy / vw.z;
    refresh();
  };
  const zoomStep = (dir, sx, sy) => {
    const z = dir > 0 ? ZOOMS.find((v) => v > vw.z * 1.001) ?? 16 : [...ZOOMS].reverse().find((v) => v < vw.z * 0.999) ?? Math.min(fitZ(), 0.05);
    zoomTo(z, sx, sy);
  };
  const stage = h('div.lq-stage.lq-vp', h('div.lq-canvas', view, over),
    h('div.lq-zoombar',
      h('button.small', { type: 'button', title: '축소 (Ctrl+−)', 'aria-label': '축소', onclick: () => zoomStep(-1) }, '−'),
      zoomLbl,
      h('button.small', { type: 'button', title: '확대 (Ctrl++)', 'aria-label': '확대', onclick: () => zoomStep(1) }, '+'),
      h('button.small', { type: 'button', title: '화면 크기에 맞추기 (Ctrl+0)', onclick: fit }, '맞추기'),
      h('button.small', { type: 'button', title: '100% (Ctrl+1)', onclick: () => zoomTo(1) }, '100%')));
  const resize = () => {
    const r = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(r.width));
    const ch = Math.max(1, Math.round(r.height));
    if (cw === vw.cw && ch === vw.ch && img) return;
    // keep the middle of the view where it was
    const cx = vw.x + vw.cw / 2 / vw.z;
    const cy = vw.y + vw.ch / 2 / vw.z;
    vw.cw = cw;
    vw.ch = ch;
    view.width = over.width = cw;
    view.height = over.height = ch;
    img = vg.createImageData(cw, ch);
    if (vw.fit) vw.z = fitZ();
    else {
      vw.x = cx - cw / 2 / vw.z;
      vw.y = cy - ch / 2 / vw.z;
    }
    refresh();
  };
  const ro = new ResizeObserver(() => resize());

  // ---- brush
  const tmp = [0, 0];
  const dab = (cx, cy, vx, vy, alt, prs = 1) => {
    const R = (st.size * kx) / 2;
    const x0 = Math.max(0, Math.floor(cx - R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(pw, Math.ceil(cx + R));
    const y1 = Math.min(ph, Math.ceil(cy + R));
    if (x1 <= x0 || y1 <= y0) return;
    const old = D;
    const nD = st.tool === 'freeze' || st.tool === 'thaw' ? D : D.slice();
    const pr = (st.pressure / 100) * (st.stylus ? prs : 1);
    const hard = st.density / 100;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r = Math.hypot(dx, dy);
        if (r >= R) continue;
        // falloff: density = how much of the brush works at full strength
        const t = r / R;
        let wgt = t <= hard * 0.6 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * ((t - hard * 0.6) / (1 - hard * 0.6)));
        const p = y * pw + x;
        if (st.tool === 'freeze') {
          F[p] = Math.min(1, F[p] + wgt * pr);
          continue;
        }
        if (st.tool === 'thaw') {
          F[p] = Math.max(0, F[p] - wgt * pr);
          continue;
        }
        wgt *= 1 - F[p];
        if (wgt <= 0) continue;
        let sx = x;
        let sy = y;
        const rate = st.rate / 80;
        switch (st.tool) {
          case 'warp':
            sx -= vx * wgt * pr * 1.6;
            sy -= vy * wgt * pr * 1.6;
            break;
          case 'pushLeft': {
            const k = wgt * pr * 0.8 * (alt ? -1 : 1);
            sx -= vy * k;
            sy += vx * k;
            break;
          }
          case 'twirl': {
            const a = wgt * pr * 0.08 * rate * (alt ? -1 : 1);
            sx = cx + dx * Math.cos(a) + dy * Math.sin(a) - 0.5;
            sy = cy - dx * Math.sin(a) + dy * Math.cos(a) - 0.5;
            break;
          }
          case 'pucker':
          case 'bloat': {
            const k = 1 + (st.tool === 'pucker' ? 1 : -1) * (alt ? -1 : 1) * wgt * pr * 0.06 * rate;
            sx = cx + dx * k - 0.5;
            sy = cy + dy * k - 0.5;
            break;
          }
          case 'reconstruct': {
            const k = wgt * pr * 0.25 * rate;
            nD[p * 2] = old[p * 2] * (1 - k);
            nD[p * 2 + 1] = old[p * 2 + 1] * (1 - k);
            continue;
          }
          case 'smooth': {
            // toward the average of the neighbours: smooths a bumpy distortion, keeps a smooth one
            const k = wgt * pr * 0.5 * rate;
            let ax = 0;
            let ay = 0;
            let cnt = 0;
            for (let oy = -2; oy <= 2; oy++) {
              const yy = clamp(y + oy, 0, ph - 1);
              for (let ox = -2; ox <= 2; ox++) {
                const q = (yy * pw + clamp(x + ox, 0, pw - 1)) * 2;
                ax += old[q];
                ay += old[q + 1];
                cnt++;
              }
            }
            nD[p * 2] = old[p * 2] + (ax / cnt - old[p * 2]) * k;
            nD[p * 2 + 1] = old[p * 2 + 1] + (ay / cnt - old[p * 2 + 1]) * k;
            continue;
          }
          default:
        }
        // new map at p = old map at the moved point
        field2(old, pw, ph, sx, sy, tmp);
        nD[p * 2] = sx - x + tmp[0];
        nD[p * 2 + 1] = sy - y + tmp[1];
      }
    }
    D = nD;
    renderMap(x0, y0, x1, y1);
  };

  // ---- pointer
  let drag = null;
  let faceDrag = null;
  let pan = null;
  let space = false;
  let timer = null;
  /** Screen (view) point and map point of a pointer event. */
  const at = (e) => {
    const r = over.getBoundingClientRect();
    const x = ((e.clientX - r.left) / (r.width || 1)) * vw.cw;
    const y = ((e.clientY - r.top) / (r.height || 1)) * vw.ch;
    return { sx: x, sy: y, x: (vw.x + x / vw.z) * kx, y: (vw.y + y / vw.z) * ky };
  };
  const cursorFor = () => {
    over.style.cursor = space || st.tool === 'hand' ? (pan ? 'grabbing' : 'grab') : st.tool === 'zoom' ? 'zoom-in' : st.tool === 'face' ? 'crosshair' : 'none';
  };
  const tick = () => {
    // tools that work while held still (twirl, pucker, bloat, reconstruct, smooth)
    if (!drag || ['warp', 'pushLeft', 'freeze', 'thaw'].includes(st.tool)) return;
    dab(drag.p.x, drag.p.y, 0, 0, drag.alt, drag.prs);
  };
  const refreshFace = () => {
    faceField(FO, pw, ph, face.box, face.v, face.pts);
    render();
    drawOverlay();
  };
  over.addEventListener('pointerdown', (e) => {
    over.setPointerCapture(e.pointerId);
    const p = at(e);
    if (space || st.tool === 'hand' || e.button === 1) {
      pan = { x: e.clientX, y: e.clientY, vx: vw.x, vy: vw.y };
      cursorFor();
      return;
    }
    if (st.tool === 'zoom') {
      zoomStep(e.altKey ? -1 : 1, p.sx, p.sy);
      return;
    }
    if (st.tool === 'face') {
      // drag a feature handle, or draw a new face box
      const hit = face.pts && Object.entries(face.pts).find(([, q]) => {
        const [x, y] = faceScr(q);
        return Math.hypot(x - p.sx, y - p.sy) < 10;
      });
      faceDrag = hit ? { key: hit[0] } : { start: p };
      return;
    }
    undo.push({ D: D.slice(), F: F.slice() });
    if (undo.length > 20) undo.shift();
    drag = { p, alt: e.altKey, prs: e.pointerType === 'pen' ? e.pressure || 0.5 : 1 };
    dab(p.x, p.y, 0, 0, e.altKey, drag.prs);
    clearInterval(timer);
    timer = setInterval(tick, Math.round(40 + (100 - st.rate) * 1.5));
  });
  over.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (pan) {
      scrollTo(pan.vx - (e.clientX - pan.x) / vw.z, pan.vy - (e.clientY - pan.y) / vw.z);
      return;
    }
    if (faceDrag) {
      if (faceDrag.key) {
        face.pts[faceDrag.key] = [p.x, p.y];
        refreshFace();
      } else {
        const a = faceDrag.start;
        face.box = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
        face.pts = faceFeatures(face.box);
        drawOverlay();
      }
      return;
    }
    hover = { x: p.sx, y: p.sy };
    drawOverlay();
    if (!drag) return;
    const vx = p.x - drag.p.x;
    const vy = p.y - drag.p.y;
    const d = Math.hypot(vx, vy);
    if (d < 0.25) return;
    // dabs along the movement, an eighth of the brush apart
    const step = Math.max(0.5, (st.size * kx) / 8);
    const n = Math.ceil(d / step);
    const prs = e.pointerType === 'pen' ? e.pressure || 0.5 : 1;
    for (let i = 1; i <= n; i++) dab(drag.p.x + (vx * i) / n, drag.p.y + (vy * i) / n, vx / n, vy / n, e.altKey, prs);
    drag.p = p;
    drag.alt = e.altKey;
    drag.prs = prs;
  });
  const end = () => {
    if (faceDrag) {
      // a box of a few screen pixels is a slip, not a face
      if (!faceDrag.key && face.box && (face.box.w / kx) * vw.z < 12) {
        face.box = null;
        face.pts = null;
      }
      faceDrag = null;
      syncFace();
      refreshFace();
    }
    pan = null;
    drag = null;
    clearInterval(timer);
    cursorFor();
  };
  over.addEventListener('pointerup', end);
  over.addEventListener('pointercancel', end);
  over.addEventListener('pointerleave', () => {
    if (drag) return;
    hover = null;
    drawOverlay();
  });
  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = at(e);
    // Ctrl / Alt + wheel: zoom at the pointer; the wheel alone: brush size
    if (e.ctrlKey || e.metaKey || e.altKey) {
      zoomTo(vw.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p.sx, p.sy);
      return;
    }
    st.size = clamp(Math.round(st.size * (e.deltaY < 0 ? 1.1 : 0.9)), 1, Math.max(W, H));
    sync();
    hover = { x: p.sx, y: p.sy };
    drawOverlay();
  }, { passive: false });

  // ---- side panels
  const toolBtns = TOOLS.map(([id, name, key, icon]) => {
    const b = h('button.lq-tool', { title: `${name} (${key})`, 'aria-label': name, onclick: () => setTool(id) }, svg(icon));
    b.dataset.id = id;
    return b;
  });
  const setTool = (id) => {
    st.tool = id;
    for (const b of toolBtns) b.classList.toggle('on', b.dataset.id === id);
    toolName.textContent = TOOLS.find((t) => t[0] === id)[1];
    cursorFor();
    brushBox.hidden = ['face', 'hand', 'zoom'].includes(id);
    faceNote.hidden = id !== 'face';
    // the face tool works with the Face-Aware Liquify sliders: show them
    if (id === 'face' && !faceBox.open) faceBox.open = true;
    drawOverlay();
  };
  const toolName = h('div.lq-toolname');
  const num = (obj, key, label, min, max, onSet) => {
    const r = h('input', { type: 'range', min, max, value: obj[key], 'aria-label': label });
    const n = h('input.ph-num', { type: 'number', min, max, value: obj[key], 'aria-label': label });
    const set = (v, done = true) => {
      obj[key] = clamp(Math.round(+v), min, max);
      r.value = obj[key];
      n.value = obj[key];
      onSet?.(done);
    };
    r.addEventListener('input', () => set(r.value, false));
    r.addEventListener('change', () => set(r.value, true));
    n.addEventListener('change', () => set(n.value));
    // double-click: back to 0 (the face sliders)
    r.addEventListener('dblclick', () => set(0));
    return { el: h('label.lq-row', h('span', label), r, n), set };
  };
  const size = num(st, 'size', '브러시 크기', 1, Math.max(W, H), () => drawOverlay());
  const pressure = num(st, 'pressure', '브러시 압력', 1, 100);
  const density = num(st, 'density', '브러시 밀도', 0, 100);
  const rate = num(st, 'rate', '브러시 속도', 0, 100);
  const sync = () => size.set(st.size);
  const check = (key, label, after) => {
    const c = h('input', { type: 'checkbox', checked: st[key] });
    c.addEventListener('change', () => {
      st[key] = c.checked;
      after?.();
    });
    return h('label.lq-row', c, h('span', label));
  };
  const brushBox = h('div.lq-group', h('div.ph-sub', '브러시 도구 옵션'), size.el, density.el, pressure.el, rate.el, check('stylus', '스타일러스 압력'), check('pinEdges', '가장자리 고정', () => refresh()));
  // face sliders
  let faceTimer = 0;
  const faceRows = FACE.map(([k, label]) => num(face.v, k, label, -100, 100, () => {
    clearTimeout(faceTimer);
    faceTimer = setTimeout(refreshFace, 30);
  }));
  const faceNote = h('div.note', '얼굴 도구: 얼굴을 상자로 감싸듯 끌어 지정하고, 점(눈·코·입·턱)을 끌어 위치를 맞추세요.');
  const faceBody = h('div');
  const syncFace = () => {
    faceBody.replaceChildren(...(face.box ? ['눈', '코', '입', '얼굴 모양'].flatMap((g) => [h('div.ph-sub', g), ...FACE.map((f, i) => [f, i]).filter(([f]) => f[2] === g).map(([, i]) => faceRows[i].el)]) : [h('div.note', '얼굴이 지정되지 않았습니다.')]));
  };
  syncFace();
  const faceBox = h('details.lq-group', { open: false }, h('summary', '얼굴 인식 픽셀 유동화'), faceNote, faceBody,
    h('div.lq-btns', h('button.small', { onclick: () => { for (const r of faceRows) r.set(0, false); refreshFace(); } }, '얼굴 값 재설정'), h('button.small', { onclick: () => { face.box = null; face.pts = null; syncFace(); refreshFace(); } }, '얼굴 지우기')));
  faceBox.addEventListener('toggle', () => {
    if (faceBox.open && !face.box) setTool('face');
  });
  const btn = (label, fn) => h('button.small', { onclick: fn }, label);
  const viewBox = h('div.lq-group', h('div.ph-sub', '보기 옵션'), check('showImage', '이미지 표시', () => render()), check('showMesh', '메시 표시', () => drawOverlay()), check('showMask', '마스크 표시', () => render()));
  const side = h('div.lq-side',
    toolName,
    brushBox,
    faceBox,
    h('div.lq-group', h('div.ph-sub', '마스크 옵션'), h('div.lq-btns',
      btn('모두 마스크', () => {
        F.fill(1);
        render();
      }),
      btn('없음', () => {
        F.fill(0);
        render();
      }),
      btn('모두 반전', () => {
        for (let i = 0; i < F.length; i++) F[i] = 1 - F[i];
        render();
      }))),
    viewBox,
    h('div.lq-group', h('div.ph-sub', '브러시 재구성 옵션'), h('div.lq-btns',
      btn('되돌리기 (Ctrl+Z)', () => doUndo()),
      btn('모두 복원', () => {
        undo.push({ D: D.slice(), F: F.slice() });
        D = new Float32Array(pw * ph * 2);
        render();
        drawOverlay();
      }))),
    h('div.note', '끌어서 밀고, 돌리기·오목·볼록·재구성·매끄럽게는 누르고 있으면 계속 작용합니다. Alt를 누르면 반대로 움직입니다. 마우스 휠·[ ]: 브러시 크기, Ctrl+휠·Ctrl+ +/−: 확대/축소, Space+끌기: 이동.'));
  const doUndo = () => {
    const u = undo.pop();
    if (!u) return;
    D = u.D;
    F.set(u.F);
    render();
    drawOverlay();
  };
  const onKey = (e) => {
    const t0 = e.target;
    // typing in a number box keeps its keys; sliders and check boxes don't take letters
    if ((t0.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t0.type)) || t0.tagName === 'SELECT' || t0.tagName === 'TEXTAREA' || e.key === 'Escape' || e.key === 'Enter') return;
    // the editor behind the dialog must not see these keys (Ctrl+Z would undo the document)
    e.stopPropagation();
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!space) {
        space = true;
        cursorFor();
      }
      return;
    }
    if (mod && k === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (mod && (k === '=' || k === '+' || k === '-' || k === '0' || k === '1')) {
      e.preventDefault();
      if (k === '0') fit();
      else if (k === '1') zoomTo(1);
      else zoomStep(k === '-' ? -1 : 1);
      return;
    }
    const t = TOOLS.find((x) => x[2].toLowerCase() === k);
    if (t && !mod) setTool(t[0]);
    if (k === '[' || k === ']') {
      st.size = clamp(Math.round(st.size * (k === ']' ? 1.15 : 0.87)), 1, Math.max(W, H));
      sync();
      drawOverlay();
    }
  };
  const onKeyUp = (e) => {
    if (e.code !== 'Space' || !space) return;
    space = false;
    cursorFor();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);

  setTool('warp');
  openModal({
    title: '픽셀 유동화',
    width: 'min(1240px, 97vw)',
    peek: false,
    body: [h('div.lq', h('div.lq-tools', toolBtns), stage, side)],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        // the brush map and the face sliders together (pin edges applied)
        const T = new Float32Array(pw * ph * 2);
        let any = false;
        for (let y = 0; y < ph; y++) {
          for (let x = 0; x < pw; x++) {
            const p = (y * pw + x) * 2;
            const ek = edgeK(x, y);
            T[p] = (D[p] + FO[p]) * ek;
            T[p + 1] = (D[p + 1] + FO[p + 1]) * ek;
            if (!any && (Math.abs(T[p]) > 0.01 || Math.abs(T[p + 1]) > 0.01)) any = true;
          }
        }
        if (!any) return;
        toast('픽셀 유동화 적용 중…');
        setTimeout(() => {
          const out = warpImage(fullData(), W, H, T, pw, ph);
          P.run('픽셀 유동화', () => applyToLayer(P, () => {
            const c = makeCanvas(W, H);
            c.getContext('2d').putImageData(out, 0, 0);
            return c;
          }));
        }, 30);
      },
    }],
    onClose: () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      ro.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(timer);
      clearTimeout(faceTimer);
    },
  });
  ro.observe(stage);
  resize();
  return undefined;
}

// Vector paths (Photoshop "패스"): cubic Bézier subpaths made of knots { p, in, out } (anchor and its
// incoming/outgoing handles, doc or layer coordinates), combined with boolean operations.
// Used by the pen tools, the Paths panel, vector masks and path-based shape layers.

import { setVectorMaskRenderer, setShapePathProvider, makeCanvas } from './doc.js';

export const PATH_OPS = [['combine', '모양 결합'], ['subtract', '전면 모양 빼기'], ['intersect', '모양 영역 교차'], ['exclude', '오버랩 모양 영역 제외']];

export const knot = (x, y, inX = x, inY = y, outX = x, outY = y, smooth = false) => ({ p: [x, y], in: [inX, inY], out: [outX, outY], smooth });
export const clonePath = (sps) => (sps || []).map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ p: [...k.p], in: [...k.in], out: [...k.out], smooth: k.smooth })) }));

/** Map every point of a path through fn([x, y]) → [x, y]. */
export function mapPath(sps, fn) {
  return (sps || []).map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ p: fn(k.p), in: fn(k.in), out: fn(k.out), smooth: k.smooth })) }));
}
export const translatePath = (sps, dx, dy) => mapPath(sps, ([x, y]) => [x + dx, y + dy]);

function addSub(p2, sp, dx = 0, dy = 0, reverse = false) {
  let ks = sp.knots;
  if (!ks.length) return;
  if (reverse) ks = [...ks].reverse().map((k) => ({ p: k.p, in: k.out, out: k.in }));
  p2.moveTo(ks[0].p[0] + dx, ks[0].p[1] + dy);
  const n = ks.length;
  const segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = ks[i];
    const b = ks[(i + 1) % n];
    p2.bezierCurveTo(a.out[0] + dx, a.out[1] + dy, b.in[0] + dx, b.in[1] + dy, b.p[0] + dx, b.p[1] + dy);
  }
  if (sp.closed) p2.closePath();
}

/** Signed area of the knots' polygon (sign = winding direction). */
function area(sp) {
  let a = 0;
  const k = sp.knots;
  for (let i = 0; i < k.length; i++) {
    const [x1, y1] = k[i].p;
    const [x2, y2] = k[(i + 1) % k.length].p;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** One Path2D for drawing outlines (and filling, when ops are only combine/subtract). */
export function toPath2D(sps, dx = 0, dy = 0) {
  const p = new Path2D();
  const sign = Math.sign(area(sps?.[0] || { knots: [] })) || 1;
  for (const sp of sps || []) {
    // subtracted subpaths run the other way round, so the non-zero rule punches holes
    const want = sp.op === 'subtract' ? -sign : sign;
    addSub(p, sp, dx, dy, sp.closed && Math.sign(area(sp)) !== want && area(sp) !== 0);
  }
  return p;
}
export const fillRuleFor = (sps) => ((sps || []).some((sp) => sp.op === 'exclude') ? 'evenodd' : 'nonzero');

/** The filled area of a path (with all boolean operations) as an alpha canvas. */
export function rasterizePath(w, h, sps, { dx = 0, dy = 0, invert = false, feather = 0 } = {}) {
  const out = makeCanvas(w, h);
  const g = out.getContext('2d');
  const one = makeCanvas(w, h);
  const og = one.getContext('2d');
  (sps || []).forEach((sp, i) => {
    og.clearRect(0, 0, w, h);
    const p = new Path2D();
    addSub(p, { ...sp, closed: true }, dx, dy);
    og.fillStyle = '#000';
    og.fill(p);
    const op = i === 0 ? 'combine' : sp.op || 'combine';
    g.globalCompositeOperation = op === 'subtract' ? 'destination-out' : op === 'intersect' ? 'destination-in' : op === 'exclude' ? 'xor' : 'source-over';
    g.drawImage(one, 0, 0);
  });
  g.globalCompositeOperation = 'source-over';
  if (invert) {
    const t = makeCanvas(w, h);
    const tg = t.getContext('2d');
    tg.fillRect(0, 0, w, h);
    tg.globalCompositeOperation = 'destination-out';
    tg.drawImage(out, 0, 0);
    return t;
  }
  if (feather > 0) {
    const t = makeCanvas(w, h);
    const tg = t.getContext('2d');
    tg.filter = `blur(${feather / 2}px)`;
    tg.drawImage(out, 0, 0);
    return t;
  }
  return out;
}

// vector masks: doc-size alpha, cached per mask object
setVectorMaskRenderer((doc, vm) => {
  const key = `${doc.width}x${doc.height}:${vm.dx || 0},${vm.dy || 0}:${vm.invert ? 1 : 0}:${vm.feather || 0}:${JSON.stringify(vm.subpaths)}`;
  if (vm._r?.key === key) return vm._r.c;
  const c = rasterizePath(doc.width, doc.height, vm.subpaths, { dx: vm.dx || 0, dy: vm.dy || 0, invert: !!vm.invert, feather: vm.feather || 0 });
  Object.defineProperty(vm, '_r', { value: { key, c }, enumerable: false, configurable: true, writable: true });
  return c;
});

// ---------------------------------------------------------------- geometry

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export function bezierPoint(a, b, c, d, t) {
  const mt = 1 - t;
  return [
    mt * mt * mt * a[0] + 3 * mt * mt * t * b[0] + 3 * mt * t * t * c[0] + t * t * t * d[0],
    mt * mt * mt * a[1] + 3 * mt * mt * t * b[1] + 3 * mt * t * t * c[1] + t * t * t * d[1],
  ];
}

/** Split segment i of a subpath at t (adds a knot). */
export function splitSegment(sp, i, t) {
  const n = sp.knots.length;
  const A = sp.knots[i];
  const B = sp.knots[(i + 1) % n];
  const p01 = lerp(A.p, A.out, t);
  const p12 = lerp(A.out, B.in, t);
  const p23 = lerp(B.in, B.p, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const m = lerp(p012, p123, t);
  const knots = sp.knots.map((k) => ({ ...k }));
  knots[i] = { ...A, out: p01 };
  knots[(i + 1) % n] = { ...B, in: p23 };
  knots.splice(i + 1, 0, { p: m, in: p012, out: p123, smooth: true });
  return { ...sp, knots };
}

/** Nearest point on any segment: { si, i, t, d }. */
export function nearestOnPath(sps, x, y) {
  let best = null;
  (sps || []).forEach((sp, si) => {
    const n = sp.knots.length;
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const A = sp.knots[i];
      const B = sp.knots[(i + 1) % n];
      for (let s = 0; s <= 40; s++) {
        const t = s / 40;
        const q = bezierPoint(A.p, A.out, B.in, B.p, t);
        const d = Math.hypot(q[0] - x, q[1] - y);
        if (!best || d < best.d) best = { si, i, t, d };
      }
    }
  });
  return best;
}

/** Points along the path (for strokes, text on a path and hit tests). */
export function flatten(sp, step = 2) {
  const out = [];
  const n = sp.knots.length;
  if (!n) return out;
  const segs = sp.closed ? n : n - 1;
  out.push(sp.knots[0].p);
  for (let i = 0; i < segs; i++) {
    const A = sp.knots[i];
    const B = sp.knots[(i + 1) % n];
    const len = Math.hypot(A.out[0] - A.p[0], A.out[1] - A.p[1]) + Math.hypot(B.in[0] - A.out[0], B.in[1] - A.out[1]) + Math.hypot(B.p[0] - B.in[0], B.p[1] - B.in[1]);
    const k = Math.max(2, Math.ceil(len / step));
    for (let s = 1; s <= k; s++) out.push(bezierPoint(A.p, A.out, B.in, B.p, s / k));
  }
  return out;
}

export function pathBounds(sps) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sp of sps || []) {
    for (const q of flatten(sp, 4)) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Freehand points → a smooth subpath (Ramer–Douglas–Peucker, then Catmull-Rom handles). */
export function fitFreehand(pts, tolerance = 2, closed = false) {
  if (pts.length < 2) return null;
  const rdp = (a, b) => {
    let dmax = 0;
    let idx = -1;
    const [x1, y1] = pts[a];
    const [x2, y2] = pts[b];
    const L = Math.hypot(x2 - x1, y2 - y1) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((y2 - y1) * pts[i][0] - (x2 - x1) * pts[i][1] + x2 * y1 - y2 * x1) / L;
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    return dmax > tolerance ? [...rdp(a, idx).slice(0, -1), ...rdp(idx, b)] : [a, b];
  };
  let idx;
  if (closed || Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < tolerance) {
    // a loop: split it at the point farthest from the start so both halves have a real chord
    let far = 0;
    let fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far <= 0 || far >= pts.length - 1) idx = [0, pts.length - 1];
    else idx = [...rdp(0, far).slice(0, -1), ...rdp(far, pts.length - 1)];
  } else idx = rdp(0, pts.length - 1);
  const keep = idx.map((i) => pts[i]);
  const n = keep.length;
  const knots = keep.map((p, i) => {
    const prev = keep[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = keep[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = (next[0] - prev[0]) / 6;
    const ty = (next[1] - prev[1]) / 6;
    return { p: [...p], in: [p[0] - tx, p[1] - ty], out: [p[0] + tx, p[1] + ty], smooth: true };
  });
  if (!closed) {
    knots[0].in = [...knots[0].p];
    knots[n - 1].out = [...knots[n - 1].p];
  }
  return { closed, op: 'combine', knots };
}

/**
 * A selection (alpha canvas) traced into a path (Photoshop "작업 패스 만들기"): marching squares on
 * pixel centres, loops joined, holes marked as subtracted, then smoothed into Bézier knots.
 */
export function pathFromMask(maskCanvas, tolerance = 2) {
  const W = maskCanvas.width;
  const H = maskCanvas.height;
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 1.5e6)));
  const w = Math.ceil(W / step);
  const h = Math.ceil(H / step);
  const src = maskCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const m = new Uint8Array((w + 2) * (h + 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[(y + 1) * (w + 2) + x + 1] = src[(Math.min(H - 1, y * step) * W + Math.min(W - 1, x * step)) * 4 + 3] >= 128 ? 1 : 0;
  const at = (x, y) => m[(y + 1) * (w + 2) + x + 1];
  // segments between edge midpoints of each 2×2 cell of pixel centres
  const segs = [];
  const E = (x, y, e) => (e === 0 ? [x + 0.5, y] : e === 1 ? [x + 1, y + 0.5] : e === 2 ? [x + 0.5, y + 1] : [x, y + 0.5]);
  const TABLE = { 1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[1, 0]], 5: [[3, 0], [1, 2]], 6: [[2, 0]], 7: [[3, 0]], 8: [[0, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[0, 1]], 12: [[1, 3]], 13: [[1, 2]], 14: [[2, 3]] };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1);
      const t = TABLE[c];
      if (t) for (const [e1, e2] of t) segs.push([E(x, y, e1), E(x, y, e2)]);
    }
  }
  // join segments into loops (undirected: works whatever way each case was written)
  const key = (p) => `${p[0]},${p[1]}`;
  const byPoint = new Map();
  segs.forEach((sg, i) => {
    for (const p of sg) {
      const k = key(p);
      const arr = byPoint.get(k);
      if (arr) arr.push(i);
      else byPoint.set(k, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i][0]];
    let cur = segs[i][1];
    const start = key(segs[i][0]);
    let guard = 0;
    while (key(cur) !== start && guard++ < segs.length) {
      pts.push(cur);
      const j = (byPoint.get(key(cur)) || []).find((k) => !used[k]);
      if (j == null) break;
      used[j] = 1;
      cur = key(segs[j][0]) === key(cur) ? segs[j][1] : segs[j][0];
    }
    if (pts.length > 3) loops.push(pts);
  }
  const area2 = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  loops.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)));
  const outerSign = Math.sign(area2(loops[0] || [])) || 1;
  const subs = [];
  for (const pts of loops) {
    const scaled = pts.map(([x, y]) => [(x + 0.5) * step, (y + 0.5) * step]);
    const sp = fitFreehand([...scaled, scaled[0]], tolerance, true);
    if (!sp) continue;
    if (sp.knots.length > 1 && Math.hypot(sp.knots[0].p[0] - sp.knots.at(-1).p[0], sp.knots[0].p[1] - sp.knots.at(-1).p[1]) < 0.5) sp.knots.pop();
    sp.op = Math.sign(area2(pts)) === outerSign ? 'combine' : 'subtract';
    subs.push(sp);
  }
  return subs;
}

// ---------------------------------------------------------------- custom shapes (Photoshop "사용자 정의 모양")

/** SVG path data in a 100×100 box. */
export const CUSTOM_SHAPES = [
  ['heart', '하트', 'M50 88 C20 66 4 50 4 30 C4 14 16 4 30 4 C40 4 47 10 50 18 C53 10 60 4 70 4 C84 4 96 14 96 30 C96 50 80 66 50 88 Z'],
  ['arrowRight', '화살표 →', 'M4 36 H60 V14 L96 50 L60 86 V64 H4 Z'],
  ['arrowLeft', '화살표 ←', 'M96 36 H40 V14 L4 50 L40 86 V64 H96 Z'],
  ['arrowUp', '화살표 ↑', 'M36 96 V40 H14 L50 4 L86 40 H64 V96 Z'],
  ['bubble', '말풍선', 'M12 8 H88 C94 8 96 12 96 18 V60 C96 66 94 70 88 70 H40 L20 92 L24 70 H12 C6 70 4 66 4 60 V18 C4 12 6 8 12 8 Z'],
  ['thought', '생각 풍선', 'M30 70 C10 70 4 56 10 46 C2 36 10 20 26 22 C30 8 52 4 60 16 C74 6 94 16 88 32 C100 40 96 62 78 62 C74 74 50 76 42 68 C38 70 34 70 30 70 Z M18 82 A6 6 0 1 0 18.1 82 Z M8 94 A3 3 0 1 0 8.1 94 Z'],
  ['check', '체크', 'M8 52 L22 38 L40 56 L80 14 L94 28 L40 84 Z'],
  ['cross', '엑스', 'M18 4 L50 36 L82 4 L96 18 L64 50 L96 82 L82 96 L50 64 L18 96 L4 82 L36 50 L4 18 Z'],
  ['plus', '더하기', 'M38 4 H62 V38 H96 V62 H62 V96 H38 V62 H4 V38 H38 Z'],
  ['lightning', '번개', 'M58 2 L18 56 H44 L36 98 L82 38 H54 Z'],
  ['cloud', '구름', 'M26 80 C12 80 4 70 4 58 C4 46 14 38 26 40 C28 22 44 12 60 18 C70 8 92 14 92 34 C100 40 98 80 78 80 Z'],
  ['house', '집', 'M50 6 L96 46 H82 V94 H60 V64 H40 V94 H18 V46 H4 Z'],
  ['moon', '달', 'M62 4 C36 8 18 30 18 54 C18 80 40 98 66 96 C82 95 92 88 96 80 C88 84 78 86 70 84 C48 80 34 62 36 40 C38 22 48 10 62 4 Z'],
  ['drop', '물방울', 'M50 4 C66 30 84 48 84 66 C84 84 68 96 50 96 C32 96 16 84 16 66 C16 48 34 30 50 4 Z'],
  ['badge', '배지', 'M50 2 L62 14 L78 10 L82 26 L96 34 L88 50 L96 66 L82 74 L78 90 L62 86 L50 98 L38 86 L22 90 L18 74 L4 66 L12 50 L4 34 L18 26 L22 10 L38 14 Z'],
  ['banner', '리본', 'M2 30 H18 V20 H82 V30 H98 L90 46 L98 62 H82 V72 H18 V62 H2 L10 46 Z'],
  ['frame', '사각 틀', 'M4 4 H96 V96 H4 Z M16 16 V84 H84 V16 Z'],
  ['ring', '고리', 'M50 4 A46 46 0 1 0 50.1 4 Z M50 24 A26 26 0 1 1 49.9 24 Z'],
  ['paw', '발자국', 'M50 52 C66 52 82 70 78 84 C74 96 60 90 50 90 C40 90 26 96 22 84 C18 70 34 52 50 52 Z M24 26 A9 12 0 1 0 24.1 26 Z M42 10 A9 12 0 1 0 42.1 10 Z M60 10 A9 12 0 1 0 60.1 10 Z M78 26 A9 12 0 1 0 78.1 26 Z'],
  ['music', '음표', 'M36 70 V14 L86 4 V60 C86 70 78 76 70 76 C62 76 56 70 56 64 C56 58 62 52 70 52 C73 52 75 53 78 54 V20 L44 27 V80 C44 90 36 96 28 96 C20 96 14 90 14 84 C14 78 20 72 28 72 C31 72 34 73 36 74 Z'],
];
const svgCache = new Map();

/** Parse absolute SVG path data (M L H V C Q A Z) into subpaths. */
export function parseSvgPath(d) {
  const toks = String(d).match(/[MLHVCQAZmlhvcqaz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  const subs = [];
  let sp = null;
  let cur = [0, 0];
  let cmd = '';
  const last = () => sp.knots[sp.knots.length - 1];
  const lineTo = (x, y) => {
    sp.knots.push(knot(x, y));
    cur = [x, y];
  };
  const cubic = (c1, c2, p) => {
    last().out = c1;
    sp.knots.push({ p, in: c2, out: [...p], smooth: false });
    cur = p;
  };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    switch (cmd.toUpperCase()) {
      case 'M':
        sp = { closed: false, op: 'combine', knots: [] };
        subs.push(sp);
        cur = [num(), num()];
        sp.knots.push(knot(cur[0], cur[1]));
        cmd = 'L';
        break;
      case 'L': lineTo(num(), num()); break;
      case 'H': lineTo(num(), cur[1]); break;
      case 'V': lineTo(cur[0], num()); break;
      case 'C': cubic([num(), num()], [num(), num()], [num(), num()]); break;
      case 'Q': {
        const q = [num(), num()];
        const p = [num(), num()];
        cubic([cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        const p = [num(), num()];
        for (const [c1, c2, e] of arcToCubics(cur, rx, ry, rot, large, sweep, p)) cubic(c1, c2, e);
        break;
      }
      case 'Z': {
        sp.closed = true;
        // a closing point on top of the first one merges with it
        const f = sp.knots[0];
        const l = last();
        if (sp.knots.length > 1 && Math.hypot(l.p[0] - f.p[0], l.p[1] - f.p[1]) < 1e-3) {
          f.in = l.in;
          sp.knots.pop();
        }
        cur = [...f.p];
        if (i < toks.length && !/[A-Za-z]/.test(toks[i])) cmd = 'L';
        else if (i < toks.length) cmd = toks[i];
        break;
      }
      default: i++;
    }
  }
  return subs;
}

/** SVG elliptical arc → cubic Bézier segments [[c1, c2, end]…]. */
function arcToCubics(p0, rx, ry, rotDeg, large, sweep, p1) {
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const sign = large === sweep ? -1 : 1;
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step;
    const b = a + step;
    const pa = pt(a);
    const pb = pt(b);
    const da = der(a);
    const db = der(b);
    out.push([[pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
  }
  return out;
}

// shape layers: custom shapes and pen-drawn paths
setShapePathProvider((s) => {
  if (s.type === 'custom') {
    const d = CUSTOM_SHAPES.find((c) => c[0] === s.custom)?.[2] || CUSTOM_SHAPES[0][2];
    if (!svgCache.has(d)) svgCache.set(d, new Path2D(d));
    const p = new Path2D();
    p.addPath(svgCache.get(d), new DOMMatrix().scale(s.w / 100, s.h / 100));
    return p;
  }
  if (s.type === 'path' && s.subpaths) {
    const kx = s.w / (s.pw || s.w || 1);
    const ky = s.h / (s.ph || s.h || 1);
    return toPath2D(mapPath(s.subpaths, ([x, y]) => [x * kx, y * ky]));
  }
  return null;
});

/** A parametric shape (rectangle, ellipse…) as editable path knots in a w×h box. */
export function shapeToSubpaths(s) {
  const { w, h } = s;
  const K = 0.5522847498;
  if (s.type === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    const cx = w / 2;
    const cy = h / 2;
    return [{ closed: true, op: 'combine', knots: [
      knot(cx, 0, cx - rx * K, 0, cx + rx * K, 0, true),
      knot(w, cy, w, cy - ry * K, w, cy + ry * K, true),
      knot(cx, h, cx + rx * K, h, cx - rx * K, h, true),
      knot(0, cy, 0, cy + ry * K, 0, cy - ry * K, true),
    ] }];
  }
  if (s.type === 'round') {
    const r = Math.min(s.radius || 20, w / 2, h / 2);
    const k = r * K;
    return [{ closed: true, op: 'combine', knots: [
      knot(r, 0, r - k, 0, r, 0), knot(w - r, 0, w - r, 0, w - r + k, 0),
      knot(w, r, w, r - k, w, r), knot(w, h - r, w, h - r, w, h - r + k),
      knot(w - r, h, w - r + k, h, w - r, h), knot(r, h, r, h, r - k, h),
      knot(0, h - r, 0, h - r + k, 0, h - r), knot(0, r, 0, r, 0, r - k),
    ] }];
  }
  const poly = (pts) => [{ closed: true, op: 'combine', knots: pts.map(([x, y]) => knot(x, y)) }];
  if (s.type === 'triangle') return poly([[w / 2, 0], [w, h], [0, h]]);
  if (s.type === 'polygon' || s.type === 'star') {
    const n = Math.max(3, Math.round(s.sides || 5));
    const star = s.type === 'star';
    const inner = s.indent != null ? 1 - s.indent / 100 : 0.4;
    const pts = [];
    for (let i = 0; i < (star ? n * 2 : n); i++) {
      const a = -Math.PI / 2 + (i * (star ? Math.PI : 2 * Math.PI)) / n;
      const r = star && i % 2 ? inner : 1;
      pts.push([w / 2 + Math.cos(a) * (w / 2) * r, h / 2 + Math.sin(a) * (h / 2) * r]);
    }
    return poly(pts);
  }
  if (s.type === 'line') return [{ closed: false, op: 'combine', knots: [knot(0, h / 2), knot(w, h / 2)] }];
  if (s.type === 'custom') {
    const d = CUSTOM_SHAPES.find((c) => c[0] === s.custom)?.[2] || CUSTOM_SHAPES[0][2];
    const sps = parseSvgPath(d);
    // inner subpaths cut holes (the shapes are drawn with the non-zero rule)
    return mapPath(sps, ([x, y]) => [(x * w) / 100, (y * h) / 100]).map((sp, i) => ({ ...sp, op: i && /^(frame|ring)$/.test(s.custom) ? 'subtract' : 'combine' }));
  }
  if (s.type === 'path') return clonePath(s.subpaths);
  return poly([[0, 0], [w, 0], [w, h], [0, h]]);
}

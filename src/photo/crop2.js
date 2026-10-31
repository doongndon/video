// Crop tool backend (Photoshop's crop): crop the whole document to a box that may be turned,
// optionally deleting the cropped pixels, filling the empty edges with content-aware fill and
// resampling to an exact pixel size (W x H x Resolution). Also keeps P.cropTo's other callers
// (canvas size, trim, crop to selection) from leaving smart objects and vector masks behind.

import { makeCanvas, textBox } from './doc.js';
import { composeM, invertM, applyM } from './transform.js';
import { mapPath } from './paths.js';
import { inpaint } from './inpaint.js';
import { toast } from '../ui/common.js';

export function installCrop2(P) {
  /**
   * Edit the document to `box` ({ cx, cy, w, h, a }: centre, size and turn in radians, doc coords).
   * opts: deletePixels, contentAware (fill what was outside the picture), size ({ w, h }: resample
   * to exactly this many pixels), res (ppi), label. Returns a promise while content-aware fill runs.
   */
  P.cmd.cropBox = (box, opts = {}) => cropBox(P, box, opts);
  fixCropTo(P);
}

function cropBox(P, box, { deletePixels = false, contentAware = false, size = null, res = null, label = '자르기' } = {}) {
  const doc = P.doc;
  if (!doc || !box || !(box.w >= 1) || !(box.h >= 1)) return undefined;
  const W = Math.max(1, Math.round(box.w));
  const H = Math.max(1, Math.round(box.h));
  const a = box.a || 0;
  const turned = Math.abs(a) > 1e-6;
  if (W * H > 120e6) return void toast('결과가 너무 큽니다');
  let M;
  if (turned) {
    // turn by -a about the box centre, which lands in the middle of the new canvas
    const co = Math.cos(-a);
    const si = Math.sin(-a);
    M = [co, si, -si, co, W / 2 - (co * box.cx - si * box.cy), H / 2 - (si * box.cx + co * box.cy)];
  } else M = [1, 0, 0, 1, -Math.round(box.cx - box.w / 2), -Math.round(box.cy - box.h / 2)];
  const work = () => {
    if (P.doc !== doc) return;
    P.run(label, () => {
      cropDoc(doc, M, W, H, { deletePixels, contentAware, turned });
      if (res > 0) doc.resolution = Math.round(res * 100) / 100;
    });
    if (size && size.w > 0 && size.h > 0 && (size.w !== doc.width || size.h !== doc.height)) {
      // Image Size records a step of its own: it is part of this crop
      const step = doc.history.undoStack.at(-1);
      P.resizeImage(Math.round(size.w), Math.round(size.h));
      while (doc.history.undoStack.length && doc.history.undoStack.at(-1) !== step) doc.history.undoStack.pop();
      P.afterHistory();
    }
    P.fit();
  };
  if (contentAware) {
    toast('내용 인식으로 빈 곳을 채우는 중…');
    return new Promise((resolve) => setTimeout(() => {
      try {
        work();
      } finally {
        resolve();
      }
    }, 40));
  }
  work();
  return undefined;
}

/** The layer content-aware crop fills: the bottom image layer that covers the whole picture. */
function backdropLayer(doc) {
  for (const l of doc.layers) {
    if (l.kind !== 'raster' || !l.canvas || l.parent || !doc.shown(l)) continue;
    const b = doc.opaqueBounds(l);
    if (b && b.x <= 0 && b.y <= 0 && b.x + b.w >= doc.width && b.y + b.h >= doc.height) return l;
    break;
  }
  const l = doc.active;
  return l?.kind === 'raster' && l.canvas ? l : null;
}

/** A mask or alpha canvas ({ canvas, x, y }) carried to the new canvas (kept canvas-size). */
function mapAlpha(m, M, W, H) {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const t = composeM(M, [1, 0, 0, 1, m.x || 0, m.y || 0]);
  g.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  g.drawImage(m.canvas, 0, 0);
  return c;
}

function cropDoc(doc, M, W, H, { deletePixels, contentAware, turned }) {
  const pt = (p) => applyM(M, p);
  const fillTarget = contentAware ? backdropLayer(doc) : null;
  const rotDeg = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
  for (const l of doc.layers) {
    if (l.kind === 'raster' && l.canvas) {
      const cut = deletePixels || l === fillTarget;
      if (!turned) {
        l.x += M[4];
        l.y += M[5];
        if (cut) {
          const c = makeCanvas(W, H);
          c.getContext('2d').drawImage(l.canvas, l.x, l.y);
          l.canvas = c;
          l.x = 0;
          l.y = 0;
        }
      } else {
        // the turned layer keeps everything (or only what is inside the new canvas)
        const cs = [[l.x, l.y], [l.x + l.canvas.width, l.y], [l.x + l.canvas.width, l.y + l.canvas.height], [l.x, l.y + l.canvas.height]].map(pt);
        let x0 = Math.floor(Math.min(...cs.map((q) => q[0])));
        let y0 = Math.floor(Math.min(...cs.map((q) => q[1])));
        let x1 = Math.ceil(Math.max(...cs.map((q) => q[0])));
        let y1 = Math.ceil(Math.max(...cs.map((q) => q[1])));
        if (cut) [x0, y0, x1, y1] = [0, 0, W, H];
        const c = makeCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        const m = composeM(M, [1, 0, 0, 1, l.x, l.y]);
        g.setTransform(m[0], m[1], m[2], m[3], m[4] - x0, m[5] - y0);
        g.drawImage(l.canvas, 0, 0);
        l.canvas = c;
        l.x = x0;
        l.y = y0;
      }
    } else if (l.kind === 'smart' && l.smart) {
      const s = l.smart;
      l.smart = { ...s, m: composeM(M, s.m), corners: s.corners ? s.corners.map(pt) : s.corners, warp: s.warp?.ctrl ? { ...s.warp, ctrl: s.warp.ctrl.map(pt) } : s.warp };
    } else if (l.kind === 'text' && l.text?.path?.subpath) {
      // text on a path: the path is in document coordinates
      l.text = { ...l.text, path: { ...l.text.path, subpath: mapPath([l.text.path.subpath], pt)[0] } };
    } else if (l.kind === 'text' || l.kind === 'shape') {
      if (!turned) {
        l.x += M[4];
        l.y += M[5];
      } else {
        const b = l.kind === 'text' ? textBox(l) : { w: l.shape.w, h: l.shape.h };
        const [cx, cy] = pt([l.x + b.w / 2, l.y + b.h / 2]);
        l.rotation = Math.round((((l.rotation || 0) + rotDeg) % 360) * 100) / 100;
        l.x = Math.round(cx - b.w / 2);
        l.y = Math.round(cy - b.h / 2);
      }
    } else if (l.kind !== 'group' && l.kind !== 'adjust' && l.kind !== 'fill' && !turned) {
      l.x = (l.x || 0) + M[4];
      l.y = (l.y || 0) + M[5];
    }
    if (l.mask?.canvas) l.mask = { ...l.mask, canvas: mapAlpha(l.mask, M, W, H), x: 0, y: 0 };
    if (l.vmask?.subpaths) {
      const vx = l.vmask.dx || 0;
      const vy = l.vmask.dy || 0;
      l.vmask = { ...l.vmask, subpaths: mapPath(l.vmask.subpaths, ([x, y]) => pt([x + vx, y + vy])), dx: 0, dy: 0 };
    }
    l._styled = null;
    l._cache = null;
    l.rev++;
  }
  // what lives in document coordinates follows the picture
  const sps = (s) => mapPath(s, pt);
  if (doc.workPath?.subpaths) doc.workPath = { ...doc.workPath, subpaths: sps(doc.workPath.subpaths) };
  doc.paths = (doc.paths || []).map((p) => (p.subpaths ? { ...p, subpaths: sps(p.subpaths) } : p));
  for (const k of ['notes', 'counts', 'samplers']) {
    doc[k] = (doc[k] || []).map((q) => {
      const [x, y] = pt([q.x, q.y]);
      return { ...q, x: k === 'samplers' ? Math.round(x) : x, y: k === 'samplers' ? Math.round(y) : y };
    });
  }
  if (!turned) doc.guides = (doc.guides || []).map((g) => ({ ...g, pos: g.pos + (g.axis === 'x' ? M[4] : M[5]) }));
  else doc.guides = [];
  doc.channels = (doc.channels || []).map((ch) => (ch.canvas ? { ...ch, canvas: mapAlpha({ canvas: ch.canvas, x: 0, y: 0 }, M, W, H) } : ch));
  if (doc.quickMask?.canvas) doc.quickMask = { ...doc.quickMask, canvas: mapAlpha({ canvas: doc.quickMask.canvas, x: 0, y: 0 }, M, W, H) };
  const oldW = doc.width;
  const oldH = doc.height;
  doc.width = W;
  doc.height = H;
  doc.selection = null;
  doc.rev++;
  if (fillTarget && doc.layers.includes(fillTarget)) fillOutside(fillTarget, M, W, H, oldW, oldH);
}

/**
 * Content-aware fill of what came from outside the old picture (the corners a turn brings in, or
 * the border of a crop box bigger than the picture), on the layer's W×H canvas.
 */
function fillOutside(l, M, W, H, oldW, oldH) {
  const g = l.canvas.getContext('2d');
  const inv = invertM(M);
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const hole = new Uint8Array(W * H);
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const [u, v] = applyM(inv, [x + 0.5, y + 0.5]);
      // outside the old picture, or a pixel the turn left part-transparent at its edge
      const out = u < 0 || v < 0 || u > oldW || v > oldH;
      if (out || d[i * 4 + 3] < 250) {
        hole[i] = 1;
        n++;
      }
    }
  }
  if (!n || n === W * H) return;
  // grow the hole by a pixel so the soft edge left by resampling is rebuilt too
  const grown = hole.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (hole[i]) continue;
      if ((x > 0 && hole[i - 1]) || (x < W - 1 && hole[i + 1]) || (y > 0 && hole[i - W]) || (y < H - 1 && hole[i + W])) grown[i] = 1;
    }
  }
  for (let i = 0; i < W * H; i++) if (grown[i]) d[i * 4 + 3] = 255;
  inpaint(d, W, H, grown);
  for (let i = 0; i < W * H; i++) d[i * 4 + 3] = 255;
  g.putImageData(img, 0, 0);
}

/**
 * P.cropTo moves layers by their x / y: smart objects (placed by a matrix) and vector masks (an
 * offset of their own) would stay behind. Move whatever it left where it was.
 */
function fixCropTo(P) {
  const orig = P.cropTo;
  if (typeof orig !== 'function' || orig.fixed) return;
  const wrapped = (r, ...rest) => {
    const doc = P.doc;
    const before = doc ? new Map(doc.layers.map((l) => [l.id, { m: l.smart?.m ? [...l.smart.m] : null, v: l.vmask ? [l.vmask.dx || 0, l.vmask.dy || 0] : null }])) : null;
    const out = orig(r, ...rest);
    if (!doc || !r || (!r.x && !r.y) || doc.width !== r.w || doc.height !== r.h) return out;
    let fixed = false;
    for (const l of doc.layers) {
      const b = before.get(l.id);
      if (!b) continue;
      let moved = false;
      if (l.kind === 'smart' && l.smart && b.m && l.smart.m[4] === b.m[4] && l.smart.m[5] === b.m[5]) {
        const s = l.smart;
        l.smart = { ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] - r.x, s.m[5] - r.y], corners: s.corners?.map(([x, y]) => [x - r.x, y - r.y]) || s.corners, warp: s.warp?.ctrl ? { ...s.warp, ctrl: s.warp.ctrl.map(([x, y]) => [x - r.x, y - r.y]) } : s.warp };
        moved = true;
      }
      if (l.vmask && b.v && (l.vmask.dx || 0) === b.v[0] && (l.vmask.dy || 0) === b.v[1]) {
        l.vmask = { ...l.vmask, dx: b.v[0] - r.x, dy: b.v[1] - r.y };
        moved = true;
      }
      if (moved) {
        l._styled = null;
        doc.touch(l);
        fixed = true;
      }
    }
    if (fixed) P.redraw();
    return out;
  };
  wrapped.fixed = true;
  P.cropTo = wrapped;
}

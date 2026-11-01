// 마스크 경로 추적 (Premiere Pro's mask tracking): follows a per-effect mask (see masks.js) through
// its video clip and writes a 마스크 경로 keyframe on every frame, like Premiere's
// "선택한 마스크를 앞으로 / 뒤로 추적" and "1프레임 앞으로 / 뒤로 추적" buttons.
//
// trackMask(clipId, fxId, maskId, options) → Promise<{ frames, from, to, reason, cancelled }>
//   (or trackMask({ clipId, fxId, maskId, ...options }); options.oneFrame = true is frames: 1)
//   options.direction   1 = forward (앞으로), -1 = backward (뒤로)
//   options.frames      how many frames to track (default: to the clip's end / start; 1 = one frame)
//   options.from        clip-local start time in seconds (default: the playhead, snapped to a frame)
//   options.method      'position' | 'posRot' | 'posScaleRot' (default: the mask's `track` field)
//   options.onProgress  (fraction 0..1, framesDone) => void
//   options.token       { cancelled: false } — set cancelled = true to stop (keys found so far are kept)
//   options.moveHead    move the playhead along with the tracked frame (default true for UI calls)
// The result is ONE undo step ('마스크 경로 추적'). Only video clips can be tracked (other kinds
// throw an Error with a Korean message suitable for a toast). isTracking(maskId) tells whether a
// job runs for a mask; cancelTracking(maskId) stops it.
//
// How it works: frames of the clip's media are decoded at a small size (320 px wide, WebCodecs via
// mediabunny, else <video> seeking) and turned into grey images. Small patches on a grid inside
// the mask's bounding box are matched from each frame to the next (sum of absolute differences,
// coarse-to-fine over a 2-level pyramid with sub-pixel refinement); a similarity transform
// (translation / rotation / uniform scale, as allowed by the method) is fitted to the patch motions
// with outlier rejection, and the mask path is carried along by it.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { mediaTimeAt, clipEnd } from './model.js';
import { mediaUrl, openVideoTrack } from './media.js';
import { evalMaskPath, transformPath, pathBounds, pathPolyline, setMaskPath } from './masks.js';
import { clamp, once, deepClone } from './util.js';

const TRACK_W = 320;
const jobs = new Map();

export const isTracking = (maskId) => jobs.has(maskId);
export function cancelTracking(maskId) {
  const j = jobs.get(maskId);
  if (j) j.token.cancelled = true;
}

function findMask(clipId, fxId, maskId) {
  const clip = store.seq?.clips[clipId];
  const fx = clip?.effects.find((e) => e.id === fxId);
  const mask = fx?.masks?.find((m) => m.id === maskId);
  return mask ? { clip, fx, mask } : null;
}

/** Grey (luma) image from a canvas, w × h. */
function grey(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return g;
}

function half(img, w, h) {
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = y * 2 * w + x * 2;
      out[y * w2 + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
    }
  }
  return { img: out, w: w2, h: h2 };
}

/** Sum of absolute differences of a B×B patch at (cx, cy) in a and (cx+dx, cy+dy) in b (bilinear in b). */
function sad(a, b, w, h, cx, cy, dx, dy, B, limit) {
  let s = 0;
  const r = B >> 1;
  for (let y = -r; y < r; y++) {
    const ya = cy + y;
    const yb = ya + dy;
    if (ya < 0 || ya >= h || yb < 0 || yb >= h - 1) {
      s += 255 * B;
      continue;
    }
    for (let x = -r; x < r; x++) {
      const xa = cx + x;
      const xb = xa + dx;
      if (xa < 0 || xa >= w || xb < 0 || xb >= w - 1) {
        s += 255;
        continue;
      }
      const v = a[ya * w + xa] - b[yb * w + xb];
      s += v < 0 ? -v : v;
    }
    if (s > limit) return s;
  }
  return s;
}

/** Best integer displacement of a patch within ±R around (gx, gy), then sub-pixel by a parabola fit. */
function matchPatch(a, b, w, h, cx, cy, gx, gy, R, B) {
  // a slight pull towards the guess: on repeating textures (tiles, checks, stripes) several shifts
  // match equally well, and the one nearest the expected motion is the right one (without it the
  // first of them in scan order won and a mask over a tiled wall drifted away up and left)
  const pull = B * B * 0.05;
  let best = Infinity;
  let score = Infinity;
  let bx = gx;
  let by = gy;
  for (let dy = gy - R; dy <= gy + R; dy++) {
    for (let dx = gx - R; dx <= gx + R; dx++) {
      const pen = pull * Math.hypot(dx - gx, dy - gy);
      if (pen >= score) continue;
      const v = sad(a, b, w, h, cx, cy, dx, dy, B, score - pen);
      if (v + pen < score) {
        score = v + pen;
        best = v;
        bx = dx;
        by = dy;
      }
    }
  }
  const f = (dx, dy) => sad(a, b, w, h, cx, cy, dx, dy, B, Infinity);
  const c0 = best;
  const sub = (m, p) => {
    const den = m - 2 * c0 + p;
    return den > 1e-6 ? clamp((m - p) / (2 * den), -0.5, 0.5) : 0;
  };
  return { dx: bx + sub(f(bx - 1, by), f(bx + 1, by)), dy: by + sub(f(bx, by - 1), f(bx, by + 1)), cost: best / (B * B) };
}

/** Least-squares similarity x' = a·x − b·y + tx, y' = b·x + a·y + ty from point pairs. */
function fitSimilarity(pairs, method) {
  const n = pairs.length;
  if (!n) return null;
  // optional 5th element: the pair's weight (how much texture the patch had)
  let mx = 0;
  let my = 0;
  let nx = 0;
  let ny = 0;
  let sw = 0;
  for (const [x, y, u, v, w = 1] of pairs) {
    mx += x * w;
    my += y * w;
    nx += u * w;
    ny += v * w;
    sw += w;
  }
  mx /= sw;
  my /= sw;
  nx /= sw;
  ny /= sw;
  if (method === 'position' || n < 3) return { a: 1, b: 0, tx: nx - mx, ty: ny - my };
  let sxx = 0;
  let sab = 0;
  let sba = 0;
  for (const [x, y, u, v, w = 1] of pairs) {
    const px = x - mx;
    const py = y - my;
    const qx = u - nx;
    const qy = v - ny;
    sxx += (px * px + py * py) * w;
    sab += (px * qx + py * qy) * w;
    sba += (px * qy - py * qx) * w;
  }
  if (sxx < 1e-6) return { a: 1, b: 0, tx: nx - mx, ty: ny - my };
  let a = sab / sxx;
  let b = sba / sxx;
  if (method === 'posRot') {
    const s = Math.hypot(a, b) || 1;
    a /= s;
    b /= s;
  } else {
    // keep the scale change per frame sane
    const s = Math.hypot(a, b);
    if (s < 0.8 || s > 1.25) {
      a /= s;
      b /= s;
    }
  }
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/**
 * Motion of the region inside `box` (tracking pixels) from grey frame A to B: a similarity
 * transform plus how many patches agreed ({ tr, n }), or null. `inside(x, y)` limits the patches
 * to the mask shape.
 */
function estimateMotion(A, B, w, h, box, method, guess, inside = () => true) {
  const pa = half(A, w, h);
  const pb = half(B, w, h);
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const n = clamp(Math.round(Math.sqrt((bw * bh) / 160)), 2, 5);
  const Bsz = clamp(Math.round(Math.min(bw, bh) / (n + 1)) * 2, 8, 24);
  const pairs = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = Math.round(box.x0 + (bw * (i + 0.5)) / n);
      const cy = Math.round(box.y0 + (bh * (j + 0.5)) / n);
      if (cx < 4 || cy < 4 || cx > w - 5 || cy > h - 5 || !inside(cx, cy)) continue;
      // skip flat patches: nothing to lock on to
      let mn = 255;
      let mxv = 0;
      const r = Bsz >> 1;
      for (let y = -r; y < r; y += 2) {
        for (let x = -r; x < r; x += 2) {
          const v = A[clamp(cy + y, 0, h - 1) * w + clamp(cx + x, 0, w - 1)];
          if (v < mn) mn = v;
          if (v > mxv) mxv = v;
        }
      }
      if (mxv - mn < 10) continue;
      const g = guess ? [guess.a * cx - guess.b * cy + guess.tx - cx, guess.b * cx + guess.a * cy + guess.ty - cy] : [0, 0];
      // coarse search at half size, then refine at full size
      const c = matchPatch(pa.img, pb.img, pa.w, pa.h, cx >> 1, cy >> 1, Math.round(g[0] / 2), Math.round(g[1] / 2), 10, Math.max(6, Bsz >> 1));
      const f = matchPatch(A, B, w, h, cx, cy, Math.round(c.dx * 2), Math.round(c.dy * 2), 2, Bsz);
      if (f.cost > 60) continue;
      pairs.push([cx, cy, cx + f.dx, cy + f.dy, mxv - mn]);
    }
  }
  if (!pairs.length) return null;
  // the motion most of the texture agrees on: a loose mask around a face also covers some faint
  // static background, and the face (eyes, mouth, edges) has far more contrast, so each patch
  // votes for its own shift with its contrast and the pairs near the winning shift start the fit
  if (pairs.length > 3) {
    let bestW = -1;
    let best = null;
    for (const [x, y, u, v] of pairs) {
      const dx = u - x;
      const dy = v - y;
      let w = 0;
      for (const q of pairs) if (Math.hypot(q[2] - q[0] - dx, q[3] - q[1] - dy) < 2) w += q[4];
      if (w > bestW) {
        bestW = w;
        best = [dx, dy];
      }
    }
    // a scale or rotation change spreads the shifts out: only narrow down when the winner holds
    // a real share of the texture, and keep everything within a few pixels of it
    const keep = pairs.filter((q) => Math.hypot(q[2] - q[0] - best[0], q[3] - q[1] - best[1]) < 4);
    if (keep.length >= 2 && keep.length < pairs.length) {
      pairs.length = 0;
      pairs.push(...keep);
    }
  }
  let tr = fitSimilarity(pairs, method);
  const found = pairs.length;
  // drop outliers (other things moving inside the mask) and refit
  for (let it = 0; it < 2 && pairs.length > 3; it++) {
    const res = pairs.map(([x, y, u, v]) => Math.hypot(tr.a * x - tr.b * y + tr.tx - u, tr.b * x + tr.a * y + tr.ty - v));
    const sorted = [...res].sort((p, q) => p - q);
    const lim = Math.max(1.5, sorted[Math.floor(sorted.length / 2)] * 2.5);
    const keep = pairs.filter((_, i) => res[i] <= lim);
    if (keep.length === pairs.length || keep.length < 2) break;
    pairs.length = 0;
    pairs.push(...keep);
    tr = fitSimilarity(pairs, method);
  }
  return { tr, n: pairs.length, found };
}

/** Compose similarity transforms: (p ∘ q)(x) = p(q(x)). */
function compose(p, q) {
  return { a: p.a * q.a - p.b * q.b, b: p.a * q.b + p.b * q.a, tx: p.a * q.tx - p.b * q.ty + p.tx, ty: p.b * q.tx + p.a * q.ty + p.ty };
}

/** Even-odd point-in-polygon test. */
function inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) c = !c;
  }
  return c;
}

/** Decoded small frames at media times (in the given order), as grey images. */
async function* frames(mediaId, times, W, H, token) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let ok = false;
  try {
    const { vt, first } = await openVideoTrack(mediaId);
    const sink = new MB.CanvasSink(vt, { width: W, height: H, fit: 'fill' });
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (token.cancelled) return;
      ok = true;
      if (wc) {
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(wc.canvas, 0, 0, W, H);
        yield { i, g: grey(ctx, W, H) };
      } else yield { i, g: null };
      i++;
    }
    return;
  } catch (err) {
    if (ok) throw err;
    console.warn('mask tracking: WebCodecs unavailable, seeking a <video> instead', err);
  }
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.src = mediaUrl(mediaId);
  if (!(await once(el, 'loadeddata', 15000))) throw new Error('영상을 열 수 없습니다');
  try {
    for (let i = 0; i < times.length; i++) {
      if (token.cancelled) return;
      el.currentTime = times[i];
      if (!(await once(el, 'seeked', 5000))) {
        yield { i, g: null };
        continue;
      }
      ctx.drawImage(el, 0, 0, W, H);
      yield { i, g: grey(ctx, W, H) };
    }
  } finally {
    el.removeAttribute('src');
    el.load();
  }
}

/**
 * Track a mask forward or backward from a frame. See the header comment for the options. Also
 * callable with one object: trackMask({ clipId, fxId, maskId, direction, oneFrame, frames, … }).
 */
export async function trackMask(clipId, fxId, maskId, opts = {}) {
  if (clipId && typeof clipId === 'object') {
    opts = { ...clipId };
    ({ clipId, fxId, maskId } = opts);
  }
  if (opts.oneFrame) opts = { ...opts, frames: 1 };
  const hit = findMask(clipId, fxId, maskId);
  if (!hit) throw new Error('마스크를 찾을 수 없습니다');
  const { clip, mask } = hit;
  if (clip.kind !== 'video') throw new Error('마스크 추적은 영상 클립에서만 할 수 있습니다');
  if (jobs.has(maskId)) throw new Error('이 마스크는 이미 추적 중입니다');
  const media = store.project.media[clip.mediaId];
  if (!media) throw new Error('미디어가 오프라인입니다');
  const seq = store.seq;
  const fps = seq.fps;
  const fd = 1 / fps;
  const dir = opts.direction < 0 ? -1 : 1;
  const method = opts.method || mask.track || 'posScaleRot';
  const lastFrame = Math.max(0, Math.round(clip.duration * fps) - 1);
  const f0 = clamp(Math.round((opts.from ?? store.ui.playhead - clip.start) * fps), 0, lastFrame);
  const limit = Math.max(1, Math.floor(opts.frames ?? Infinity));
  const idx = [f0];
  for (let f = f0 + dir; f >= 0 && f <= lastFrame && idx.length - 1 < limit; f += dir) idx.push(f);
  if (idx.length < 2) return { frames: 0, from: f0 * fd, to: f0 * fd };
  const W = TRACK_W;
  const H = Math.max(16, Math.round((W * (media.height || 1080)) / (media.width || 1920)));
  const sx = W / 100;
  const sy = H / 100;
  const tlOf = (f) => f * fd;
  const mtOf = (f) => clamp(mediaTimeAt(clip, clip.start + tlOf(f) + fd * 0.25), 0, Math.max(0, (media.duration || 1e9) - 1e-3));
  const token = opts.token || { cancelled: false };
  jobs.set(maskId, { token });
  const keys = [];
  let path = deepClone(evalMaskPath(mask.params.path, tlOf(f0)));
  if (path.length < 3) {
    jobs.delete(maskId);
    throw new Error('마스크 경로에 점이 3개 이상 있어야 추적할 수 있습니다');
  }
  let prev = null;
  let guess = null;
  // anchor: a reference frame and the path on it; acc maps anchor pixels → current pixels
  let anchor = null;
  let acc = { a: 1, b: 0, tx: 0, ty: 0 };
  let reason = null;
  const toPx = (pth) => pathPolyline(pth, 6).map(([x, y]) => [x * sx, y * sy]);
  const boxOf = (pth) => {
    const b = pathBounds(pth);
    return { x0: clamp(b.x0 * sx, 0, W - 1), x1: clamp(b.x1 * sx, 1, W), y0: clamp(b.y0 * sy, 0, H - 1), y1: clamp(b.y1 * sy, 1, H) };
  };
  try {
    for await (const { i, g } of frames(clip.mediaId, idx.map(mtOf), W, H, token)) {
      if (!g) {
        reason = 'decode';
        break;
      }
      if (!prev) anchor = { img: g, path, poly: toPx(path), box: boxOf(path), frame: 0 };
      else {
        const box = boxOf(path);
        if (box.x1 - box.x0 < 4 || box.y1 - box.y0 < 4) {
          reason = 'outside';
          break;
        }
        const poly = toPx(path);
        const ff = estimateMotion(prev, g, W, H, box, method, guess, (x, y) => inPoly(poly, x, y));
        if (!ff) {
          reason = 'flat';
          break;
        }
        guess = ff.tr;
        let pred = compose(ff.tr, acc);
        // refine directly against the anchor frame so small errors do not add up
        const ap = anchor.poly;
        const ref = estimateMotion(anchor.img, g, W, H, anchor.box, method, pred, (x, y) => inPoly(ap, x, y));
        if (ref && ref.n >= Math.max(2, ref.found * 0.5) && Math.hypot(ref.tr.tx - pred.tx, ref.tr.ty - pred.ty) < 6) pred = ref.tr;
        acc = pred;
        const tr = acc;
        // carry the anchor path (percent units) through the accumulated transform (tracking pixels)
        path = transformPath(anchor.path, ([x, y]) => {
          const px = x * sx;
          const py = y * sy;
          return [(tr.a * px - tr.b * py + tr.tx) / sx, (tr.b * px + tr.a * py + tr.ty) / sy];
        });
        keys.push({ t: tlOf(idx[i]), v: path.map((v) => v.map((n) => Math.round(n * 1000) / 1000)) });
        opts.onProgress?.(i / (idx.length - 1), keys.length);
        if (opts.moveHead !== false) store.setPlayhead?.(clip.start + tlOf(idx[i]));
        // re-anchor every second, or when the anchor no longer matches well (the look changed)
        if (i - anchor.frame >= 30 || !ref || ref.n < ref.found * 0.5) {
          anchor = { img: g, path, poly: toPx(path), box: boxOf(path), frame: i };
          acc = { a: 1, b: 0, tx: 0, ty: 0 };
        }
      }
      prev = g;
      if (token.cancelled) break;
    }
  } finally {
    jobs.delete(maskId);
  }
  if (keys.length) {
    store.transact('마스크 경로 추적', () => {
      const h2 = findMask(clipId, fxId, maskId);
      if (!h2) return;
      const p = h2.mask.params.path;
      if (!p.kf?.length) p.kf = [{ t: tlOf(f0), v: deepClone(p.value), ease: 'linear' }];
      for (const k of keys) setMaskPath(h2.mask, k.v, k.t, fd);
    });
  }
  opts.onProgress?.(1, keys.length);
  const last = keys.length ? keys[keys.length - 1].t : tlOf(f0);
  // reason (when it stopped early): 'flat' nothing to follow inside the mask, 'outside' the mask
  // left the frame, 'decode' a frame could not be read; null when it reached the end
  return { frames: keys.length, from: tlOf(f0), to: last, reason: keys.length < idx.length - 1 && !token.cancelled ? reason : null, cancelled: !!token.cancelled };
}

/** Clip-local frame range a mask can be tracked over (for UI hints). */
export function trackRange(clip, fps = store.seq?.fps || 30) {
  return { start: 0, end: Math.max(0, clipEnd(clip) - clip.start - 1 / fps) };
}

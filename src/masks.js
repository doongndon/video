// Per-effect masks, like Premiere Pro's 마스크 on every effect (타원 / 4점 다각형 / 펜 마스크),
// plus the helpers the compositor, Effect Controls and the Program Monitor share.
//
// ---------------------------------------------------------------- DATA MODEL
//
// Any video effect object (an entry of clip.effects) may carry an optional list `fx.masks`.
// Missing or empty = no masks (the effect applies everywhere).
//
//   fx.masks = [{
//     id: 'mask_…',          unique id (uid('mask'))
//     name: '마스크 (1)',     label shown in Effect Controls
//     inverted: false,        반전됨 — the effect applies OUTSIDE the shape instead of inside
//     track: 'posScaleRot',   추적 방법 used by 마스크 경로 추적 (src/masktrack.js):
//                             'position' (위치) | 'posRot' (위치 및 회전) |
//                             'posScaleRot' (위치, 비율 및 회전)
//     params: {               the same { value, kf } shape as effect params, so the existing
//                             stopwatch / keyframe-lane UI and model.evalParam work for numbers
//       path:      { value: Vertex[], kf: null | [{ t, v: Vertex[], ease }] },  마스크 경로
//       feather:   { value: 10,  kf: null },   마스크 페더 (px of the clip's source frame, ≥ 0)
//       opacity:   { value: 100, kf: null },   마스크 불투명도 (%, 0..100)
//       expansion: { value: 0,   kf: null },   마스크 확장 (px, negative shrinks the shape)
//     },
//   }]
//
//   Vertex = [x, y, inX, inY, outX, outY]
//     x, y        the point in PERCENT of the clip's source frame (0..100, may lie outside):
//                 the same space as the older '마스크' effect, so the Program Monitor maps a
//                 vertex to the screen exactly like it maps that effect's points
//                 (P(x / 100, y / 100) on the clip's transformed quad).
//     inX..outY   bezier tangent handles RELATIVE to the point, also in percent; all zero = a
//                 sharp corner. An ellipse is 4 vertices with tangents (as in Premiere), so it
//                 can be reshaped point by point afterwards.
//   Paths are always closed. Path keyframes interpolate vertex by vertex when both keys have the
//   same number of vertices (otherwise the earlier key holds) with the earlier key's ease.
//   Keyframe times `t` are clip-local seconds, like every other keyframe.
//
// Several masks on one effect combine as a union (each one inverted on its own if set).
// Masks on the fixed 불투명도 (opacity) effect cut out the clip itself (Premiere's opacity mask,
// the "text behind subject" trick); masks on any other effect blend the effect's output with its
// input: out = input·(1 − m) + effect·m. The fixed 모션 effect takes no masks.
//
// ---------------------------------------------------------------- API (for UI code)
//
//   createMask(kind, { index, aspect })   new mask object; kind 'ellipse' | 'polygon' (4점 다각형)
//                                          | 'rectangle' | 'pen' (empty path: add points by clicking)
//   ellipsePath(cx, cy, rx, ry), rectPath(x0, y0, x1, y1)   vertex lists (percent)
//   evalMaskPath(param, tl), evalMask(mask, tl)            values at clip-local time tl
//   setMaskPath(mask, path, tl, frameDur)  sets the path; writes/updates a keyframe when animated
//   toggleMaskPathAnimation(mask, tl)      stopwatch for 마스크 경로
//   pathPolyline(path, steps)              flattened [[x, y], …] (percent) for drawing / hit tests
//   tracePath(ctx, path, sx, sy, ox, oy)   adds the bezier path to a canvas context (x·sx + ox …)
//   pathBounds(path), pathCentroid(path), transformPath(path, fn)
//   activeMasks(fx)                        masks that currently shape the effect
//   MASKABLE(type)                         whether an effect type takes masks
//   Undo-wrapped edits: addMask(clipId, fxId, kind), removeMask(clipId, fxId, maskId),
//   duplicateMask(...), editMask(clipId, fxId, maskId, label, fn(mask, clip, fx))
//   Mask tracking (마스크 경로 추적): see trackMask() in src/masktrack.js.

import { store } from './store.js';
import { evalParam, isAnimated } from './model.js';
import { EFFECTS } from './effects.js';
import { easeFn } from './easing.js';
import { uid, clamp, EPS, deepClone } from './util.js';

/** Bezier circle constant: tangent length / radius for a 4-point ellipse. */
export const KAPPA = 0.5522847498;

export const MASK_KINDS = [
  ['ellipse', '타원 마스크 만들기'],
  ['polygon', '4점 다각형 마스크 만들기'],
  ['pen', '자유 그리기 베지어'],
];

export const TRACK_METHODS = [
  ['position', '위치'],
  ['posRot', '위치 및 회전'],
  ['posScaleRot', '위치, 비율 및 회전'],
];

/** Effect types that cannot take masks (fixed geometry / audio / time). */
const NO_MASK = new Set(['motion', 'timeRemap', 'text', 'fill', 'shape', 'mask', 'trackMatte', 'stabilize', 'cameraShake', 'hFlip', 'vFlip', 'blurFill', 'dropShadow']);

/** Whether an effect type takes masks: every video effect plus the fixed 불투명도 effect. */
export function MASKABLE(type) {
  const def = EFFECTS[type];
  if (!def || def.kind === 'audio' || NO_MASK.has(type)) return false;
  return !def.fixed || type === 'opacity';
}

const num = (v) => ({ value: v, kf: null });

/** Ellipse through 4 vertices (top, right, bottom, left) with bezier tangents, in percent. */
export function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    [cx, cy - ry, -kx, 0, kx, 0],
    [cx + rx, cy, 0, -ky, 0, ky],
    [cx, cy + ry, kx, 0, -kx, 0],
    [cx - rx, cy, 0, ky, 0, -ky],
  ];
}

export function rectPath(x0, y0, x1, y1) {
  return [[x0, y0, 0, 0, 0, 0], [x1, y0, 0, 0, 0, 0], [x1, y1, 0, 0, 0, 0], [x0, y1, 0, 0, 0, 0]];
}

/**
 * A new mask. `aspect` = source width / height, so the default ellipse is a circle on screen.
 * `index` numbers the name ("마스크 (2)").
 */
export function createMask(kind = 'ellipse', { index = 1, aspect = 16 / 9 } = {}) {
  let path;
  if (kind === 'ellipse') {
    const rx = 18;
    path = ellipsePath(50, 50, rx, clamp(rx * aspect, 2, 60));
  } else if (kind === 'polygon' || kind === 'rectangle') path = rectPath(35, 30, 65, 70);
  else path = [];
  return {
    id: uid('mask'),
    name: `마스크 (${index})`,
    inverted: false,
    track: 'posScaleRot',
    params: { path: num(path), feather: num(10), opacity: num(100), expansion: num(0) },
  };
}

const lerp = (a, b, u) => a + (b - a) * u;

function lerpPath(a, b, u) {
  return a.map((va, i) => va.map((x, k) => lerp(x, b[i][k] ?? x, u)));
}

/** Mask path at clip-local time tl (vertex arrays interpolate; see the data model above). */
export function evalMaskPath(param, tl) {
  if (!param) return [];
  const kf = param.kf;
  if (!kf || !kf.length) return param.value || [];
  if (tl <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (tl >= last.t) return last.v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    if (tl >= a.t && tl <= b.t) {
      if (a.ease === 'hold' || a.interp === 'hold' || !Array.isArray(a.v) || !Array.isArray(b.v) || a.v.length !== b.v.length) return a.v;
      if (b.t - a.t < EPS) return b.v;
      // temporal interpolation (linear, bezier, named eases) comes from the numeric keyframe model:
      // evaluate a stand-in param whose key values are the key indices
      let u;
      try {
        u = evalParam({ value: 0, kf: kf.map((k, j) => ({ t: k.t, v: j, ease: k.ease, interp: k.interp, inInf: k.inInf, outInf: k.outInf })) }, tl) - i;
      } catch {
        u = NaN;
      }
      if (!Number.isFinite(u)) u = easeFn(a.ease)((tl - a.t) / (b.t - a.t));
      return lerpPath(a.v, b.v, u);
    }
  }
  return last.v;
}

/** Every mask value at clip-local time tl. */
export function evalMask(mask, tl) {
  const p = mask.params || {};
  return {
    path: evalMaskPath(p.path, tl),
    feather: Math.max(0, evalParam(p.feather, tl) ?? 10),
    opacity: clamp(evalParam(p.opacity, tl) ?? 100, 0, 100),
    expansion: evalParam(p.expansion, tl) ?? 0,
    inverted: !!mask.inverted,
  };
}

/** Set the path; when the path is animated, writes (or replaces) the keyframe at tl. */
export function setMaskPath(mask, path, tl, frameDur = 1 / 30) {
  const p = mask.params.path;
  const v = path.map((vx) => vx.map((x) => Math.round(x * 1000) / 1000));
  if (!isAnimated(p)) {
    p.value = v;
    return;
  }
  const hit = p.kf.find((k) => Math.abs(k.t - tl) < frameDur / 2);
  if (hit) hit.v = v;
  else {
    p.kf.push({ t: tl, v, ease: 'linear' });
    p.kf.sort((a, b) => a.t - b.t);
  }
  p.value = v;
}

/** Stopwatch for 마스크 경로: on = one keyframe at tl with the current path; off = keep the path at tl. */
export function toggleMaskPathAnimation(mask, tl) {
  const p = mask.params.path;
  if (isAnimated(p)) {
    p.value = deepClone(evalMaskPath(p, tl));
    p.kf = null;
  } else p.kf = [{ t: tl, v: deepClone(p.value), ease: 'linear' }];
}

/** Masks that currently shape an effect (enabled effect, at least 3 points). */
export function activeMasks(fx) {
  if (!fx?.masks?.length) return null;
  const out = fx.masks.filter((m) => m && m.params?.path && (m.params.path.kf?.length ? m.params.path.kf[0].v.length >= 3 : (m.params.path.value?.length || 0) >= 3));
  return out.length ? out : null;
}

/** Add the closed bezier path to ctx (call beginPath first). Coordinates: x·sx + ox, y·sy + oy. */
export function tracePath(ctx, path, sx, sy, ox = 0, oy = 0) {
  const n = path.length;
  if (n < 2) return;
  const X = (v) => v * sx + ox;
  const Y = (v) => v * sy + oy;
  ctx.moveTo(X(path[0][0]), Y(path[0][1]));
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    if (!a[4] && !a[5] && !b[2] && !b[3]) ctx.lineTo(X(b[0]), Y(b[1]));
    else ctx.bezierCurveTo(X(a[0] + a[4]), Y(a[1] + a[5]), X(b[0] + b[2]), Y(b[1] + b[3]), X(b[0]), Y(b[1]));
  }
  ctx.closePath();
}

/** Flattened closed path [[x, y], …] (percent units), `steps` points per curved segment. */
export function pathPolyline(path, steps = 12) {
  const out = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    out.push([a[0], a[1]]);
    if (!a[4] && !a[5] && !b[2] && !b[3]) continue;
    const p1 = [a[0] + a[4], a[1] + a[5]];
    const p2 = [b[0] + b[2], b[1] + b[3]];
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        u * u * u * a[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * b[0],
        u * u * u * a[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * b[1],
      ]);
    }
  }
  return out;
}

export function pathBounds(path) {
  const pts = pathPolyline(path, 8);
  if (!pts.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function pathCentroid(path) {
  if (!path.length) return [50, 50];
  let x = 0;
  let y = 0;
  for (const v of path) {
    x += v[0];
    y += v[1];
  }
  return [x / path.length, y / path.length];
}

/**
 * Map every vertex through fn([x, y]) → [x', y'] (percent). Tangents are mapped as vectors
 * (fn applied to the handle end minus the mapped point), so rotations / scales carry them along.
 */
export function transformPath(path, fn) {
  return path.map(([x, y, ix, iy, ox, oy]) => {
    const [nx, ny] = fn([x, y]);
    const [ax, ay] = fn([x + ix, y + iy]);
    const [bx, by] = fn([x + ox, y + oy]);
    return [nx, ny, ax - nx, ay - ny, bx - nx, by - ny];
  });
}

// ---------------------------------------------------------------- rendering

function canvas2(w = 2, h = 2) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function fit(c, w, h) {
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
  return ctx;
}

/**
 * Rasterizes mask lists into an alpha canvas (white with the mask coverage as alpha). One
 * instance per compositor; canvases are reused between frames.
 */
export class MaskRaster {
  constructor() {
    this.acc = canvas2();
    this.one = canvas2();
  }

  /**
   * Coverage of `masks` at clip-local time tl on a w×h stage whose pixels are `ps` source pixels
   * (feather and expansion are in source pixels). `rect` ({x, y, w, h} in stage pixels, default the
   * whole stage) is where the clip's source frame lies when the stage was padded around it.
   * Returns the canvas, or null when no mask has a usable path.
   */
  render(masks, tl, w, h, ps, rect = null) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    this.rect = rect || { x: 0, y: 0, w, h };
    const actx = fit(this.acc, w, h);
    let any = false;
    for (const m of masks) {
      const v = evalMask(m, tl);
      if (v.path.length < 3 || v.opacity <= 0) continue;
      any = true;
      const feather = Math.max(0, v.feather) * ps;
      // the shape is drawn on a canvas padded by the feather width so that shapes running off the
      // frame (and inverted masks) stay solid at the frame edge after blurring
      const pad = feather > 0.3 ? Math.ceil(feather) + 2 : 0;
      const pw = w + pad * 2;
      const ph = h + pad * 2;
      const octx = fit(this.one, pw, ph);
      this.drawShape(octx, v, w, h, ps, pad);
      let src = this.one;
      if (pad) {
        // Premiere's feather spreads the edge half inside, half outside the shape
        const tmp = this.tmp || (this.tmp = canvas2());
        const tctx = fit(tmp, pw, ph);
        tctx.filter = `blur(${feather / 2}px)`;
        tctx.drawImage(this.one, 0, 0);
        tctx.filter = 'none';
        src = tmp;
      }
      actx.globalAlpha = clamp(v.opacity / 100, 0, 1);
      actx.drawImage(src, pad, pad, w, h, 0, 0, w, h);
      actx.globalAlpha = 1;
    }
    return any ? this.acc : null;
  }

  drawShape(ctx, v, w, h, ps, pad) {
    const exp = (v.expansion || 0) * ps;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineJoin = 'round';
    const r = this.rect;
    ctx.beginPath();
    tracePath(ctx, v.path, r.w / 100, r.h / 100, pad + r.x, pad + r.y);
    ctx.fill();
    // 마스크 확장: grow by stroking the outline, shrink by erasing along it
    if (Math.abs(exp) > 0.05) {
      ctx.lineWidth = Math.abs(exp) * 2;
      if (exp < 0) ctx.globalCompositeOperation = 'destination-out';
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (v.inverted) {
      ctx.globalCompositeOperation = 'xor';
      ctx.fillRect(0, 0, w + pad * 2, h + pad * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

// ---------------------------------------------------------------- undo-wrapped edits

function findFx(clipId, fxId) {
  const c = store.seq?.clips[clipId];
  const fx = c?.effects.find((e) => e.id === fxId);
  return fx ? { c, fx } : null;
}

/** Source aspect (width / height) of a clip, for round default ellipses. */
function clipAspect(c) {
  const m = c?.mediaId && store.project.media[c.mediaId];
  if (m?.width && m?.height) return m.width / m.height;
  return store.seq ? store.seq.width / store.seq.height : 16 / 9;
}

/** Add a mask to an effect (one undo step). Returns the new mask id, or null. */
export function addMask(clipId, fxId, kind = 'ellipse') {
  const hit = findFx(clipId, fxId);
  if (!hit || !MASKABLE(hit.fx.type)) return null;
  let id = null;
  store.transact(kind === 'ellipse' ? '타원 마스크 만들기' : kind === 'pen' ? '베지어 마스크 만들기' : '4점 다각형 마스크 만들기', () => {
    const h2 = findFx(clipId, fxId);
    if (!h2) return;
    const list = h2.fx.masks || (h2.fx.masks = []);
    const used = new Set(list.map((m) => m.name));
    let n = list.length + 1;
    while (used.has(`마스크 (${n})`)) n++;
    const m = createMask(kind, { index: n, aspect: clipAspect(h2.c) });
    list.push(m);
    id = m.id;
  });
  return id;
}

export function removeMask(clipId, fxId, maskId) {
  store.transact('마스크 삭제', () => {
    const hit = findFx(clipId, fxId);
    if (!hit?.fx.masks) return;
    hit.fx.masks = hit.fx.masks.filter((m) => m.id !== maskId);
    if (!hit.fx.masks.length) delete hit.fx.masks;
  });
}

export function duplicateMask(clipId, fxId, maskId) {
  store.transact('마스크 복제', () => {
    const hit = findFx(clipId, fxId);
    const i = hit?.fx.masks?.findIndex((m) => m.id === maskId) ?? -1;
    if (i < 0) return;
    const copy = deepClone(hit.fx.masks[i]);
    copy.id = uid('mask');
    copy.name = `${copy.name} 복사`;
    hit.fx.masks.splice(i + 1, 0, copy);
  });
}

/** Change one mask as an undo step: fn(mask, clip, fx). */
export function editMask(clipId, fxId, maskId, label, fn) {
  store.transact(label, () => {
    const hit = findFx(clipId, fxId);
    const m = hit?.fx.masks?.find((x) => x.id === maskId);
    if (m) fn(m, hit.c, hit.fx);
  });
}

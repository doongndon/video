// Value graph and velocity graph of one keyframed property, as shown in Premiere Pro's Effect
// Controls timeline view when a property is expanded with its twirl. Drawing, scaling and hit
// testing only; effect-controls.js owns the interaction (dragging keys and bezier handles).
//
// Handles follow the keyframe fields documented in model.js: a side of a key has a speed (value
// units per second, the slope of the value graph = the height of the velocity graph) and an
// influence (percent of the neighbouring segment's length, the handle's horizontal reach).

import { evalParam, evalParamSpeed, keyHandles, kfInterp, DEFAULT_INFLUENCE } from '../model.js';
import { clamp } from '../util.js';

/** Heights (CSS px) of the value graph, the gap and the velocity graph. */
export const GRAPH = { value: 96, gap: 10, speed: 70 };
export const GRAPH_HEIGHT = GRAPH.value + GRAPH.gap + GRAPH.speed;
/** Horizontal inset of time 0 / the view end inside every timeline cell (keeps end keys visible). */
export const PAD_X = 7;

const VAL_TOP = 8;
const VAL_BOT = GRAPH.value - 8;
const SPD_TOP = GRAPH.value + GRAPH.gap + 8;
const SPD_BOT = GRAPH_HEIGHT - 8;

const hasNamedEase = (k) => !!k?.ease && k.ease !== 'linear' && k.ease !== 'hold';

/**
 * Handle of key i on one side for drawing and dragging: { speed, inf (percent), T (segment
 * seconds), linear } or null when that side has no handle (end of the curve, holding segment, or a
 * segment shaped by a named easing curve). A linear side reports the straight segment's slope.
 */
export function sideHandle(kf, i, side) {
  const k = kf[i];
  if (!k || typeof k.v !== 'number') return null;
  const nb = side === 'in' ? kf[i - 1] : kf[i + 1];
  if (!nb || typeof nb.v !== 'number') return null;
  const from = side === 'in' ? nb : k;
  if (kfInterp(from) === 'hold' || hasNamedEase(from)) return null;
  const T = Math.abs(k.t - nb.t);
  if (T < 1e-6) return null;
  const hd = keyHandles(kf, i)[side];
  if (hd === 'hold') return null;
  if (hd) return { speed: hd.speed, inf: hd.inf, T, linear: false };
  const slope = side === 'in' ? (k.v - nb.v) / T : (nb.v - k.v) / T;
  return { speed: slope, inf: DEFAULT_INFLUENCE, T, linear: true };
}

/** Value-graph point at the end of a handle: [t, v]. */
export function handlePoint(k, side, hd) {
  const dt = (hd.inf / 100) * hd.T;
  return side === 'in' ? [k.t - dt, k.v - dt * hd.speed] : [k.t + dt, k.v + dt * hd.speed];
}

/** Value and speed ranges that fit the curve over [t0, t1] and the shown handles. */
export function graphScale(param, t0, t1, w, shown) {
  const N = clamp(Math.round(w / 2), 40, 600);
  let vMin = Infinity;
  let vMax = -Infinity;
  let sMin = 0;
  let sMax = 0;
  for (let n = 0; n <= N; n++) {
    const t = t0 + ((t1 - t0) * n) / N;
    const v = evalParam(param, t);
    if (typeof v === 'number' && Number.isFinite(v)) {
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    const s = evalParamSpeed(param, t);
    if (Number.isFinite(s)) {
      sMin = Math.min(sMin, s);
      sMax = Math.max(sMax, s);
    }
  }
  const kf = param?.kf || [];
  kf.forEach((k, i) => {
    if (typeof k.v !== 'number' || k.t < t0 - 1e-6 || k.t > t1 + 1e-6) return;
    vMin = Math.min(vMin, k.v);
    vMax = Math.max(vMax, k.v);
    if (!shown?.has(i)) return;
    for (const side of ['in', 'out']) {
      const hd = sideHandle(kf, i, side);
      if (!hd) continue;
      const [, hv] = handlePoint(k, side, hd);
      vMin = Math.min(vMin, hv);
      vMax = Math.max(vMax, hv);
      sMin = Math.min(sMin, hd.speed);
      sMax = Math.max(sMax, hd.speed);
    }
  });
  if (!Number.isFinite(vMin)) {
    vMin = 0;
    vMax = 1;
  }
  if (vMax - vMin < 1e-9) {
    const d = Math.max(1, Math.abs(vMax) * 0.1);
    vMin -= d;
    vMax += d;
  } else {
    const d = (vMax - vMin) * 0.08;
    vMin -= d;
    vMax += d;
  }
  if (sMax - sMin < 1e-9) {
    sMin -= 1;
    sMax += 1;
  } else {
    const d = (sMax - sMin) * 0.1;
    sMin -= d;
    sMax += d;
  }
  return { vMin, vMax, sMin, sMax };
}

/** Coordinate transforms for a graph canvas of CSS width w over [t0, t1] with a scale. */
export function graphGeom(w, t0, t1, scale) {
  const iw = Math.max(1, w - PAD_X * 2);
  const span = Math.max(1e-9, t1 - t0);
  return {
    x: (t) => PAD_X + ((t - t0) / span) * iw,
    t: (x) => t0 + ((x - PAD_X) / iw) * span,
    yv: (v) => VAL_BOT - ((v - scale.vMin) / (scale.vMax - scale.vMin)) * (VAL_BOT - VAL_TOP),
    v: (y) => scale.vMin + ((VAL_BOT - y) / (VAL_BOT - VAL_TOP)) * (scale.vMax - scale.vMin),
    ys: (s) => SPD_BOT - ((s - scale.sMin) / (scale.sMax - scale.sMin)) * (SPD_BOT - SPD_TOP),
    s: (y) => scale.sMin + ((SPD_BOT - y) / (SPD_BOT - SPD_TOP)) * (scale.sMax - scale.sMin),
    inValue: (y) => y < GRAPH.value + GRAPH.gap / 2,
  };
}

const fmt = (v, decimals) => {
  const d = Math.abs(v) >= 100 ? Math.min(decimals, 1) : decimals;
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
};

/**
 * Draw both graphs. opts: { param, t0, t1, tNow, sel: Set of selected key indices, shown: Set of
 * key indices whose handles are drawn, scale, unit, decimals }.
 */
export function drawGraph(ctx, w, opts) {
  const { param, t0, t1, tNow, sel, shown, scale, unit = '', decimals = 1 } = opts;
  const g = graphGeom(w, t0, t1, scale);
  const H = GRAPH_HEIGHT;
  ctx.clearRect(0, 0, w, H);
  ctx.fillStyle = '#121519';
  ctx.fillRect(0, 0, w, GRAPH.value);
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, GRAPH.value + GRAPH.gap, w, GRAPH.speed);
  // grid: the value range quarters, the zero speed line
  ctx.strokeStyle = '#262b33';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let q = 0; q <= 4; q++) {
    const y = Math.round(VAL_TOP + ((VAL_BOT - VAL_TOP) * q) / 4) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  if (scale.sMin < 0 && scale.sMax > 0) {
    ctx.strokeStyle = '#3a414d';
    ctx.beginPath();
    const y = Math.round(g.ys(0)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // curves
  const N = clamp(Math.round(w), 40, 1200);
  const curve = (fn, map, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let n = 0; n <= N; n++) {
      const t = t0 + ((t1 - t0) * n) / N;
      const v = fn(t);
      const x = g.x(t);
      const y = map(Number.isFinite(v) ? v : 0);
      if (n) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, GRAPH.value);
  ctx.clip();
  curve((t) => evalParam(param, t), g.yv, '#6cb6ff');
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, GRAPH.value + GRAPH.gap, w, GRAPH.speed);
  ctx.clip();
  curve((t) => evalParamSpeed(param, t), g.ys, '#f5b23d');
  ctx.restore();

  const kf = param?.kf || [];
  // handles (value graph: bezier tangents; velocity graph: speed level and influence)
  const handleDot = (x, y, linear) => {
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = linear ? '#1b1f25' : '#e8ecf2';
    ctx.fill();
    ctx.strokeStyle = '#e8ecf2';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };
  kf.forEach((k, i) => {
    if (!shown.has(i) || typeof k.v !== 'number') return;
    for (const side of ['in', 'out']) {
      const hd = sideHandle(kf, i, side);
      if (!hd) continue;
      const [ht, hv] = handlePoint(k, side, hd);
      ctx.setLineDash(hd.linear ? [3, 3] : []);
      ctx.strokeStyle = 'rgba(232,236,242,0.75)';
      ctx.lineWidth = 1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, GRAPH.value);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(g.x(k.t), g.yv(k.v));
      ctx.lineTo(g.x(ht), g.yv(hv));
      ctx.stroke();
      ctx.setLineDash([]);
      handleDot(g.x(ht), g.yv(hv), hd.linear);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, GRAPH.value + GRAPH.gap, w, GRAPH.speed);
      ctx.clip();
      ctx.setLineDash(hd.linear ? [3, 3] : []);
      ctx.strokeStyle = 'rgba(232,236,242,0.75)';
      ctx.beginPath();
      ctx.moveTo(g.x(k.t), g.ys(hd.speed));
      ctx.lineTo(g.x(ht), g.ys(hd.speed));
      ctx.stroke();
      ctx.setLineDash([]);
      handleDot(g.x(ht), g.ys(hd.speed), hd.linear);
      ctx.restore();
    }
  });
  // keys
  kf.forEach((k, i) => {
    if (typeof k.v !== 'number' || k.t < t0 - 1e-6 || k.t > t1 + 1e-6) return;
    const x = g.x(k.t);
    const y = g.yv(k.v);
    const on = sel.has(i);
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fillStyle = on ? '#6cb6ff' : '#c3c9d3';
    ctx.fill();
    ctx.strokeStyle = '#000a';
    ctx.lineWidth = 1;
    ctx.stroke();
    // velocity graph marker
    ctx.fillStyle = on ? '#6cb6ff' : '#8d95a3';
    ctx.fillRect(Math.round(x) - 1, GRAPH.value + GRAPH.gap + 2, 2, GRAPH.speed - 4);
  });
  // playhead
  if (tNow >= t0 && tNow <= t1) {
    ctx.fillStyle = '#3b8ff0';
    const x = Math.round(g.x(tNow));
    ctx.fillRect(x - 1, 0, 2, GRAPH.value);
    ctx.fillRect(x - 1, GRAPH.value + GRAPH.gap, 2, GRAPH.speed);
  }
  // range labels
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(195,201,211,0.8)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${fmt(scale.vMax, decimals)}${unit}`, 3, 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmt(scale.vMin, decimals)}${unit}`, 3, GRAPH.value - 1);
  ctx.fillStyle = 'rgba(245,178,61,0.85)';
  ctx.textBaseline = 'top';
  ctx.fillText(`${fmt(scale.sMax, decimals)}${unit}/초`, 3, GRAPH.value + GRAPH.gap + 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmt(scale.sMin, decimals)}${unit}/초`, 3, H - 1);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(141,149,163,0.9)';
  ctx.textBaseline = 'top';
  ctx.fillText('값', w - 4, 2);
  ctx.fillText('속도', w - 4, GRAPH.value + GRAPH.gap + 2);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

/**
 * What is under (x, y) on a graph canvas: { kind: 'handle', graph: 'value' | 'speed', i, side } |
 * { kind: 'key', i } | null. Handles win over keys.
 */
export function hitGraph(x, y, { param, t0, t1, w, scale, shown }) {
  const g = graphGeom(w, t0, t1, scale);
  const kf = param?.kf || [];
  const R = 7;
  let best = null;
  let bd = R;
  kf.forEach((k, i) => {
    if (!shown.has(i) || typeof k.v !== 'number') return;
    for (const side of ['in', 'out']) {
      const hd = sideHandle(kf, i, side);
      if (!hd) continue;
      const [ht, hv] = handlePoint(k, side, hd);
      const dv = Math.hypot(g.x(ht) - x, g.yv(hv) - y);
      if (dv < bd) {
        bd = dv;
        best = { kind: 'handle', graph: 'value', i, side };
      }
      const ds = Math.hypot(g.x(ht) - x, g.ys(hd.speed) - y);
      if (ds < bd) {
        bd = ds;
        best = { kind: 'handle', graph: 'speed', i, side };
      }
    }
  });
  if (best) return best;
  if (!g.inValue(y)) {
    // velocity graph: a key's marker line selects the key
    kf.forEach((k, i) => {
      const d = Math.abs(g.x(k.t) - x);
      if (d < bd && k.t >= t0 - 1e-6 && k.t <= t1 + 1e-6) {
        bd = d;
        best = { kind: 'key', i, graph: 'speed' };
      }
    });
    return best;
  }
  kf.forEach((k, i) => {
    if (typeof k.v !== 'number' || k.t < t0 - 1e-6 || k.t > t1 + 1e-6) return;
    const d = Math.hypot(g.x(k.t) - x, g.yv(k.v) - y);
    if (d < bd) {
      bd = d;
      best = { kind: 'key', i, graph: 'value' };
    }
  });
  return best;
}

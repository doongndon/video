// Project / sequence data model: factories, queries and keyframe evaluation.
// Everything here is plain JSON so it can be snapshotted for undo and persisted.

import { uid, EPS, clamp, lerp, deepClone } from './util.js';
import { EFFECTS, fixedEffectsFor } from './effects.js';
import { easeFn, easeIsWiggly } from './easing.js';

export const DEFAULT_STILL_DURATION = 5;

/** Fixed (non-removable) effect types. */
export const EFFECT_FIXED_TYPES = new Set(Object.entries(EFFECTS).filter(([, d]) => d.fixed).map(([k]) => k));

/** Clip / media label colours (empty = default colour by clip type). */
export const LABEL_COLORS = [
  ['', '기본 (없음)'],
  ['#d9534f', '빨강'],
  ['#f0883e', '주황'],
  ['#e3c23a', '노랑'],
  ['#5cb85c', '초록'],
  ['#2bb3a6', '청록'],
  ['#4a90e2', '파랑'],
  ['#8e6bd8', '보라'],
  ['#d46fb2', '분홍'],
  ['#8d95a3', '회색'],
];

/**
 * Markers live in seq.markers (sequence markers, time in sequence seconds) and clip.markers (clip
 * markers, time in clip-local seconds, they move with the clip):
 *   { id, time, duration (0 = a point marker, > 0 = a range), name, comment, color, type }
 * type is one of MARKER_TYPES ('comment' when missing).
 */
export const MARKER_COLORS = [
  ['#4ade80', '녹색'],
  ['#f87171', '빨간색'],
  ['#a78bfa', '자주색'],
  ['#fb923c', '주황색'],
  ['#facc15', '노란색'],
  ['#ffffff', '흰색'],
  ['#60a5fa', '파란색'],
  ['#22d3ee', '청록색'],
];

/** Marker types (마커 유형) as in Premiere's marker dialog. */
export const MARKER_TYPES = [
  ['comment', '주석 마커'],
  ['chapter', '챕터 마커'],
  ['segmentation', '세그먼트 마커'],
  ['weblink', '웹 링크'],
];

export function createProject(name = '제목 없는 프로젝트') {
  const project = { version: 3, name, media: {}, mediaOrder: [], sequences: {}, activeSequenceId: null, bins: {} };
  addSequenceToProject(project, createSequence());
  return project;
}

/** Register a sequence in a project together with its project-panel item (kind 'sequence'). */
export function addSequenceToProject(project, seq) {
  project.sequences[seq.id] = seq;
  const mid = `seqm_${seq.id}`;
  project.media[mid] = {
    id: mid, kind: 'sequence', sequenceId: seq.id, name: seq.name, duration: Math.max(sequenceDuration(seq), 1 / seq.fps),
    width: seq.width, height: seq.height, fps: seq.fps, hasAudio: false, hasVideo: true, inPoint: null, outPoint: null, analyzed: true,
  };
  project.mediaOrder.push(mid);
  if (!project.activeSequenceId) project.activeSequenceId = seq.id;
  return mid;
}

export const sequenceMediaId = (seqId) => `seqm_${seqId}`;

/** Upgrade older single-sequence projects and make sure every sequence has its project item. */
export function migrateProject(project) {
  if (project.sequence && !project.sequences) {
    const seq = project.sequence;
    delete project.sequence;
    project.sequences = {};
    project.activeSequenceId = null;
    addSequenceToProject(project, seq);
  }
  for (const seq of Object.values(project.sequences)) {
    if (!project.media[sequenceMediaId(seq.id)]) addSequenceToProject(project, seq);
  }
  if (!project.sequences[project.activeSequenceId]) project.activeSequenceId = Object.keys(project.sequences)[0];
  // clips from older versions may lack newer fixed effects (e.g. time remapping) or params
  for (const seq of Object.values(project.sequences)) {
    for (const c of Object.values(seq.clips)) {
      const want = fixedEffectsFor(c.kind);
      want.forEach((type, i) => {
        if (!c.effects.some((e) => e.type === type)) {
          const at = Math.min(i, c.effects.length);
          c.effects.splice(at, 0, createEffect(type, seq));
        }
      });
      for (const fx of c.effects) {
        const def = EFFECTS[fx.type];
        if (!def) continue;
        for (const p of def.params) {
          if (!fx.params[p.key]) {
            const v = defaultParamValue(p, seq);
            fx.params[p.key] = { value: v && typeof v === 'object' ? deepClone(v) : v, kf: null };
          }
        }
      }
    }
  }
  project.bins = project.bins || {};
  project.version = 3;
  return project;
}

/** Recompute derived fields of sequence items (duration, size, audio presence). */
export function deriveSequenceMedia(project) {
  for (const m of Object.values(project.media)) {
    if (m.kind !== 'sequence') continue;
    const seq = project.sequences[m.sequenceId];
    if (!seq) continue;
    m.name = seq.name;
    m.duration = Math.max(sequenceDuration(seq), 1 / seq.fps);
    m.width = seq.width;
    m.height = seq.height;
    m.fps = seq.fps;
    m.hasAudio = Object.values(seq.clips).some((c) => c.kind === 'audio');
  }
}

/** True if sequence `outerId` contains (directly or through nests) sequence `innerId`. */
export function sequenceContains(project, outerId, innerId, depth = 0) {
  if (outerId === innerId) return true;
  if (depth > 16) return true;
  const seq = project.sequences[outerId];
  if (!seq) return false;
  for (const c of Object.values(seq.clips)) {
    const m = c.mediaId && project.media[c.mediaId];
    if (m?.kind === 'sequence' && sequenceContains(project, m.sequenceId, innerId, depth + 1)) return true;
  }
  return false;
}

export function createSequence({ name = '시퀀스 01', width = 1920, height = 1080, fps = 30, videoTracks = 3, audioTracks = 3 } = {}) {
  const seq = { id: uid('seq'), name, width, height, fps, tracks: [], clips: {}, markers: [], inPoint: null, outPoint: null };
  for (let i = 0; i < videoTracks; i++) seq.tracks.push(createTrack('video', i));
  for (let i = 0; i < audioTracks; i++) seq.tracks.push(createTrack('audio', i));
  // track targeting (paste, edit points, add edit) and source patching (insert / overwrite) start on V1 / A1
  for (const kind of ['video', 'audio']) {
    const first = seq.tracks.find((t) => t.kind === kind);
    if (first) first.targeted = first.patched = true;
  }
  return seq;
}

export function createTrack(kind, index) {
  return {
    id: uid(kind === 'video' ? 'vt' : 'at'),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${index + 1}`,
    locked: false,
    hidden: false, // video: output toggle (eye)
    muted: false, // audio
    solo: false, // audio
    targeted: false, // track targeting: paste, add edit, edit point navigation
    patched: false, // source patching: where insert / overwrite from the source put this kind (one per kind)
  };
}

export function renameTracks(seq) {
  let v = 0;
  let a = 0;
  for (const t of seq.tracks) t.name = t.kind === 'video' ? `V${++v}` : `A${++a}`;
}

export const videoTracks = (seq) => seq.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (seq) => seq.tracks.filter((t) => t.kind === 'audio');
export const getTrack = (seq, id) => seq.tracks.find((t) => t.id === id);
export const trackKindForClip = (clip) => (clip.kind === 'audio' ? 'audio' : 'video');

// ---------------------------------------------------------------- effects & params

export function defaultParamValue(def, seq) {
  return typeof def.default === 'function' ? def.default(seq) : def.default;
}

export function createEffect(type, seq) {
  const def = EFFECTS[type];
  if (!def) throw new Error(`Unknown effect ${type}`);
  const params = {};
  for (const p of def.params) {
    const v = defaultParamValue(p, seq);
    params[p.key] = { value: v && typeof v === 'object' ? deepClone(v) : v, kf: null };
  }
  return { id: uid('fx'), type, enabled: true, params };
}

export function findEffect(clip, type) {
  return clip.effects.find((e) => e.type === type);
}

// ---------------------------------------------------------------- keyframes
//
// A param is { value, kf }: kf is null (not animated) or an array of keyframes sorted by time:
//
//   {
//     t: 1.5,            // clip-local seconds (0 = clip start)
//     v: 960,            // value: numbers interpolate; strings, colours and objects step at each key
//     interp: 'bezier',  // Premiere temporal interpolation of this key (키프레임 ▸ 시간 보간); missing = 'linear':
//                        //   'linear' 선형 · 'bezier' 베지어 · 'autoBezier' 자동 베지어 ·
//                        //   'continuousBezier' 연속 베지어 · 'hold' 정지 · 'easeIn' 감속 · 'easeOut' 가속
//     inSpeed: 0,        // bezier handle speed entering / leaving the key in value units per second
//     outSpeed: 0,       //   (the slope of the value graph = the value of the velocity graph at the key)
//     inInf: 33.33,      // handle influence in percent (0.1..100) of the previous / next segment's length
//     outInf: 33.33,     //   (missing = 33.33)
//     ease: 'outBack',   // optional named easing curve (easing.js) shaping the whole segment that starts at
//                        //   this key; any value other than 'linear' overrides the bezier sides of that
//                        //   segment. ease 'hold' is the older spelling of interp 'hold'.
//   }
//
// Sides of a key: "in" faces the previous key, "out" the next key.
//   linear            both sides linear (a linear side's handle lies on the straight segment)
//   hold              out side keeps the value until the next key; in side linear
//   easeIn  (감속)    in side bezier with speed inSpeed ?? 0 and influence inInf ?? 33.33; out side linear
//   easeOut (가속)    out side bezier with speed outSpeed ?? 0 and influence outInf ?? 33.33; in side linear
//   bezier            each side has its own speed and influence (broken handles allowed); a missing
//                     speed falls back to the automatic one
//   continuousBezier  both sides share one speed (outSpeed ?? inSpeed ?? automatic), own influences
//   autoBezier        automatic speed (smooth through the key, flat at peaks, no overshoot), 33.33 % both sides
// The segment a → b is the cubic bezier in (time, value) space through
//   (a.t, a.v), (a.t + oi·T, a.v + oi·T·os), (b.t − ii·T, b.v − ii·T·is), (b.t, b.v)
// with T = b.t − a.t, os / oi = a's out speed / influence (0..1) and is / ii = b's in speed / influence.
// It is evaluated exactly by solving time(s) = t for the curve parameter s, like After Effects / Premiere.
// Change keys with setKeyInterp / setKeyHandle and read them with keyHandles so the fields stay consistent.

/** Temporal interpolation types: [id, Korean Premiere name, English name]. */
export const KF_INTERP = [
  ['linear', '선형', 'Linear'],
  ['bezier', '베지어', 'Bezier'],
  ['autoBezier', '자동 베지어', 'Auto Bezier'],
  ['continuousBezier', '연속 베지어', 'Continuous Bezier'],
  ['hold', '정지', 'Hold'],
  ['easeIn', '감속', 'Ease In'],
  ['easeOut', '가속', 'Ease Out'],
];

export const DEFAULT_INFLUENCE = 100 / 3;

/** Effective temporal interpolation type of a key. */
export const kfInterp = (k) => (k?.ease === 'hold' ? 'hold' : k?.interp || 'linear');

const hasNamedEase = (k) => !!k.ease && k.ease !== 'linear' && k.ease !== 'hold';
const infFrac = (pct) => clamp((pct ?? DEFAULT_INFLUENCE) / 100, 0.001, 1);
const segSlope = (a, b) => (typeof a.v === 'number' && typeof b.v === 'number' ? (b.v - a.v) / Math.max(EPS, b.t - a.t) : 0);

/** Automatic (auto bezier) speed at key i: smooth through the key, 0 at peaks and valleys, no overshoot. */
export function autoSpeed(kf, i) {
  const k = kf[i];
  const p = kf[i - 1];
  const n = kf[i + 1];
  if (!k || (!p && !n)) return 0;
  if (!p) return segSlope(k, n);
  if (!n) return segSlope(p, k);
  const s1 = segSlope(p, k);
  const s2 = segSlope(k, n);
  if (s1 * s2 <= 0) return 0;
  // weighted harmonic mean of the neighbouring slopes (monotone cubic, Fritsch-Butland weights)
  const h1 = Math.max(EPS, k.t - p.t);
  const h2 = Math.max(EPS, n.t - k.t);
  const w1 = 2 * h2 + h1;
  const w2 = h2 + 2 * h1;
  return (w1 + w2) / (w1 / s1 + w2 / s2);
}

/**
 * Resolved handle of key i on one side ('in' | 'out'): { speed, inf } (inf as a 0..1 fraction) for a
 * bezier side, null for a linear side, 'hold' for a holding out side.
 */
function sideOf(kf, i, side) {
  const k = kf[i];
  const type = kfInterp(k);
  if (side === 'out') {
    if (type === 'hold') return 'hold';
    if (type === 'linear' || type === 'easeIn') return null;
    if (type === 'easeOut') return { speed: k.outSpeed ?? 0, inf: infFrac(k.outInf) };
  } else {
    if (type === 'linear' || type === 'hold' || type === 'easeOut') return null;
    if (type === 'easeIn') return { speed: k.inSpeed ?? 0, inf: infFrac(k.inInf) };
  }
  if (type === 'autoBezier') return { speed: autoSpeed(kf, i), inf: 1 / 3 };
  const inf = infFrac(side === 'out' ? k.outInf : k.inInf);
  if (type === 'continuousBezier') return { speed: k.outSpeed ?? k.inSpeed ?? autoSpeed(kf, i), inf };
  return { speed: (side === 'out' ? k.outSpeed : k.inSpeed) ?? autoSpeed(kf, i), inf };
}

/** Solve x(s) = u for a unit cubic bezier with time control points 0, x1, x2, 1 (monotone for x1, x2 in [0, 1]). */
function solveBezierX(x1, x2, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  let s = u;
  for (let n = 0; n < 8; n++) {
    const err = X(s) - u;
    if (Math.abs(err) < 1e-9) return s;
    const d = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(d) < 1e-7) break;
    s -= err / d;
    if (s < 0 || s > 1) break;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let n = 0; n < 60; n++) {
    const x = X(s);
    if (Math.abs(x - u) < 1e-9) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return s;
}

/** Bezier control points of the segment kf[i] → kf[i+1] in unit time: { x1, y1, x2, y2 } or null when linear. */
function segmentCurve(kf, i) {
  const a = kf[i];
  const b = kf[i + 1];
  const o = sideOf(kf, i, 'out');
  const n = sideOf(kf, i + 1, 'in');
  if (!o && !n) return null;
  const T = b.t - a.t;
  const D = b.v - a.v;
  const oo = o && o !== 'hold' ? o : null;
  return {
    x1: oo ? oo.inf : 1 / 3,
    y1: a.v + (oo ? oo.inf * T * oo.speed : D / 3),
    x2: 1 - (n ? n.inf : 1 / 3),
    y2: b.v - (n ? n.inf * T * n.speed : D / 3),
  };
}

/** Value of segment kf[i] → kf[i+1] at clip time t (kf[i].t <= t <= kf[i+1].t). */
function segmentValue(kf, i, t) {
  const a = kf[i];
  const b = kf[i + 1];
  if (typeof a.v !== 'number' || typeof b.v !== 'number' || kfInterp(a) === 'hold') return a.v;
  const T = b.t - a.t;
  if (T <= EPS) return t >= b.t ? b.v : a.v;
  const u = clamp((t - a.t) / T, 0, 1);
  if (hasNamedEase(a)) return lerp(a.v, b.v, easeFn(a.ease)(u));
  const cv = segmentCurve(kf, i);
  if (!cv) return lerp(a.v, b.v, u);
  const s = solveBezierX(cv.x1, cv.x2, u);
  const r = 1 - s;
  return r * r * r * a.v + 3 * r * r * s * cv.y1 + 3 * r * s * s * cv.y2 + s * s * s * b.v;
}

/** Index i of the segment kf[i] → kf[i+1] containing t, or -1 outside the keys. */
function segmentIndex(kf, t) {
  for (let i = 0; i < kf.length - 1; i++) if (t >= kf[i].t && t <= kf[i + 1].t) return i;
  return -1;
}

/** Evaluate a param at clip-local time (seconds from clip start). */
export function evalParam(param, tLocal) {
  if (!param) return undefined;
  const kf = param.kf;
  if (!kf || kf.length === 0) return param.value;
  if (tLocal <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (tLocal >= last.t) return last.v;
  const i = segmentIndex(kf, tLocal);
  return i < 0 ? last.v : segmentValue(kf, i, tLocal);
}

/** Rate of change (value units per second) of an animated numeric param at clip time t (the velocity graph). */
export function evalParamSpeed(param, t) {
  const kf = param?.kf;
  if (!kf || kf.length < 2 || typeof kf[0].v !== 'number') return 0;
  if (t < kf[0].t || t > kf[kf.length - 1].t) return 0;
  const i = Math.max(0, segmentIndex(kf, t));
  const a = kf[i];
  const b = kf[i + 1];
  const T = b.t - a.t;
  if (T <= EPS || kfInterp(a) === 'hold' || typeof b.v !== 'number') return 0;
  const cv = hasNamedEase(a) ? null : segmentCurve(kf, i);
  if (hasNamedEase(a) || !cv) {
    if (!hasNamedEase(a)) return (b.v - a.v) / T;
    const h = Math.min(1e-4, T / 4);
    const t0 = clamp(t - h, a.t, b.t);
    const t1 = clamp(t + h, a.t, b.t);
    return t1 > t0 ? (segmentValue(kf, i, t1) - segmentValue(kf, i, t0)) / (t1 - t0) : 0;
  }
  const s = solveBezierX(cv.x1, cv.x2, clamp((t - a.t) / T, 0, 1));
  const r = 1 - s;
  const dx = 3 * r * r * cv.x1 + 6 * r * s * (cv.x2 - cv.x1) + 3 * s * s * (1 - cv.x2);
  const dy = 3 * r * r * (cv.y1 - a.v) + 6 * r * s * (cv.y2 - cv.y1) + 3 * s * s * (b.v - cv.y2);
  return Math.abs(dx) < 1e-9 ? 0 : dy / dx / T;
}

/**
 * Resolved handles of key i for drawing and editing (graph editor):
 * { interp, in: { speed, inf } | null, out: { speed, inf } | null | 'hold' } with inf in percent.
 * A linear side reports null; its handle lies along the straight segment.
 */
export function keyHandles(kf, i) {
  const conv = (sd) => (sd && sd !== 'hold' ? { speed: sd.speed, inf: sd.inf * 100 } : sd);
  return { interp: kfInterp(kf[i]), in: i > 0 ? conv(sideOf(kf, i, 'in')) : null, out: i < kf.length - 1 ? conv(sideOf(kf, i, 'out')) : null };
}

function clearHandles(k) {
  delete k.inSpeed;
  delete k.outSpeed;
  delete k.inInf;
  delete k.outInf;
}

/**
 * Set the temporal interpolation of key i (Premiere: 키프레임 오른쪽 클릭 ▸ 시간 보간 / 효과 컨트롤의 그래프).
 * Bezier types start from the smooth automatic speeds (or keep handles already set); 감속 / 가속 flatten the
 * in / out side. A named easing curve on this key, and on the previous key when the in side becomes a
 * curve, is cleared so the interpolation is what shapes the motion.
 */
export function setKeyInterp(param, i, type) {
  const kf = param?.kf;
  const k = kf?.[i];
  if (!k || !KF_INTERP.some(([id]) => id === type)) return;
  const auto = autoSpeed(kf, i);
  if (k.ease && k.ease !== 'linear') k.ease = 'linear';
  const prev = kf[i - 1];
  if (prev && hasNamedEase(prev) && ['easeIn', 'bezier', 'autoBezier', 'continuousBezier'].includes(type)) prev.ease = 'linear';
  const was = k.interp || 'linear';
  const hadSpeeds = ['bezier', 'continuousBezier', 'easeIn', 'easeOut'].includes(was);
  switch (type) {
    case 'linear':
    case 'hold':
    case 'autoBezier':
      clearHandles(k);
      break;
    case 'easeIn':
      clearHandles(k);
      k.inSpeed = 0;
      k.inInf = DEFAULT_INFLUENCE;
      break;
    case 'easeOut':
      clearHandles(k);
      k.outSpeed = 0;
      k.outInf = DEFAULT_INFLUENCE;
      break;
    case 'bezier':
      if (!hadSpeeds || k.inSpeed == null) k.inSpeed = auto;
      if (!hadSpeeds || k.outSpeed == null) k.outSpeed = auto;
      k.inInf ??= DEFAULT_INFLUENCE;
      k.outInf ??= DEFAULT_INFLUENCE;
      break;
    case 'continuousBezier': {
      const sp = hadSpeeds ? k.outSpeed ?? k.inSpeed ?? auto : auto;
      k.inSpeed = sp;
      k.outSpeed = sp;
      k.inInf ??= DEFAULT_INFLUENCE;
      k.outInf ??= DEFAULT_INFLUENCE;
      break;
    }
    default:
      break;
  }
  if (type === 'linear') delete k.interp;
  else k.interp = type;
}

/**
 * Drag a bezier handle of key i (graph editor). side 'in' | 'out'; speed in value units per second,
 * inf in percent (either may be omitted). Like Premiere / After Effects: an auto bezier key becomes
 * continuous bezier, a linear / hold / ease key becomes bezier (its other side keeps its current shape),
 * continuous keys move both sides together unless `broken` (Ctrl-drag) turns them into bezier.
 */
export function setKeyHandle(param, i, side, { speed, inf } = {}, { broken = false } = {}) {
  const kf = param?.kf;
  const k = kf?.[i];
  if (!k || typeof k.v !== 'number') return;
  const cur = keyHandles(kf, i);
  const type = cur.interp;
  const resolved = (sd, which) => {
    if (sd && sd !== 'hold') return sd;
    const nb = which === 'in' ? kf[i - 1] : kf[i + 1];
    return { speed: nb ? (which === 'in' ? segSlope(nb, k) : segSlope(k, nb)) : 0, inf: DEFAULT_INFLUENCE };
  };
  const inH = resolved(cur.in, 'in');
  const outH = resolved(cur.out, 'out');
  if (k.ease && k.ease !== 'linear') k.ease = 'linear';
  let next = type;
  if (type === 'autoBezier' || type === 'continuousBezier') next = broken ? 'bezier' : 'continuousBezier';
  else if (type !== 'bezier') next = 'bezier';
  if (type !== 'bezier' && type !== 'continuousBezier') {
    k.inSpeed = inH.speed;
    k.outSpeed = outH.speed;
    k.inInf = inH.inf;
    k.outInf = outH.inf;
  }
  if (type === 'autoBezier') {
    k.inSpeed = k.outSpeed = autoSpeed(kf, i);
    k.inInf = k.outInf = DEFAULT_INFLUENCE;
  }
  if (side === 'in') {
    if (speed != null && Number.isFinite(speed)) k.inSpeed = speed;
    if (inf != null && Number.isFinite(inf)) k.inInf = clamp(inf, 0.1, 100);
  } else {
    if (speed != null && Number.isFinite(speed)) k.outSpeed = speed;
    if (inf != null && Number.isFinite(inf)) k.outInf = clamp(inf, 0.1, 100);
  }
  if (next === 'continuousBezier') {
    const sp = side === 'in' ? k.inSpeed : k.outSpeed;
    k.inSpeed = sp;
    k.outSpeed = sp;
  }
  k.inInf ??= DEFAULT_INFLUENCE;
  k.outInf ??= DEFAULT_INFLUENCE;
  k.interp = next;
}

/** Multiply an animated param's values (and handle speeds) by f, e.g. when the frame size changes. */
export function scaleParamValues(param, f) {
  if (typeof param.value === 'number') param.value *= f;
  for (const k of param.kf || []) {
    if (typeof k.v === 'number') k.v *= f;
    if (k.inSpeed != null) k.inSpeed *= f;
    if (k.outSpeed != null) k.outSpeed *= f;
  }
}

/** A new keyframe with the default interpolation (효과 컨트롤 ▸ 새 키프레임 기본값). */
export function newKey(t, v) {
  const k = { t, v, ease: keyframeDefaults.ease };
  if (keyframeDefaults.interp && keyframeDefaults.interp !== 'linear' && typeof v === 'number') setKeyInterpRaw(k, keyframeDefaults.interp);
  return k;
}

function setKeyInterpRaw(k, type) {
  k.interp = type;
  if (type === 'easeIn') Object.assign(k, { inSpeed: 0, inInf: DEFAULT_INFLUENCE });
  if (type === 'easeOut') Object.assign(k, { outSpeed: 0, outInf: DEFAULT_INFLUENCE });
}

/** Evaluate all params of an effect into a plain {key: value} object. */
export function evalEffect(effect, tLocal) {
  const out = {};
  for (const [k, p] of Object.entries(effect.params)) out[k] = evalParam(p, tLocal);
  return out;
}

export const isAnimated = (param) => !!(param?.kf && param.kf.length);

/**
 * Easing and temporal interpolation given to newly created keyframes
 * (효과 컨트롤 ▸ 키프레임 오른쪽 클릭 ▸ 새 키프레임 기본 이징 / 기본 보간).
 */
export const keyframeDefaults = { ease: 'linear', interp: 'linear' };

/** Set a param value; if animated, writes/updates a keyframe at tLocal. */
export function setParamValue(param, value, tLocal, frameDur) {
  if (!isAnimated(param)) {
    param.value = value;
    return;
  }
  const tol = frameDur / 2;
  const existing = param.kf.find((k) => Math.abs(k.t - tLocal) < tol);
  if (existing) existing.v = value;
  else {
    param.kf.push(newKey(tLocal, value));
    param.kf.sort((a, b) => a.t - b.t);
  }
  param.value = value;
}

export function toggleAnimation(param, tLocal) {
  if (isAnimated(param)) {
    param.value = evalParam(param, tLocal);
    param.kf = null;
  } else {
    param.kf = [newKey(tLocal, param.value)];
  }
}

export function toggleKeyframeAt(param, tLocal, frameDur) {
  if (!isAnimated(param)) return;
  const tol = frameDur / 2;
  const idx = param.kf.findIndex((k) => Math.abs(k.t - tLocal) < tol);
  if (idx >= 0) {
    param.kf.splice(idx, 1);
    if (!param.kf.length) param.kf = null;
  } else {
    param.kf.push(newKey(tLocal, evalParam(param, tLocal)));
    param.kf.sort((a, b) => a.t - b.t);
  }
}

/** Shift every keyframe and clip marker of a clip (used when the head is trimmed so they stay on the same frame). */
export function shiftClipKeyframes(clip, dt) {
  if (Math.abs(dt) < EPS) return;
  for (const fx of clip.effects) {
    for (const p of Object.values(fx.params)) if (p.kf) for (const k of p.kf) k.t += dt;
    // per-effect mask keyframes (masks.js) move with the clip's content too
    for (const m of fx.masks || []) for (const p of Object.values(m.params || {})) if (p.kf) for (const k of p.kf) k.t += dt;
  }
  for (const mk of clip.markers || []) mk.time += dt;
}

/** Scale keyframe times (used when clip speed changes); handle speeds scale inversely so curves keep their shape. */
export function scaleClipKeyframes(clip, factor) {
  if (!(factor > 0) || Math.abs(factor - 1) < EPS) return;
  const scaleKeys = (p) => {
    if (!p?.kf) return;
    for (const k of p.kf) {
      k.t *= factor;
      if (k.inSpeed != null) k.inSpeed /= factor;
      if (k.outSpeed != null) k.outSpeed /= factor;
    }
  };
  for (const fx of clip.effects) {
    for (const p of Object.values(fx.params)) scaleKeys(p);
    // per-effect mask keyframes (masks.js) too
    for (const m of fx.masks || []) for (const p of Object.values(m.params || {})) scaleKeys(p);
  }
  for (const mk of clip.markers || []) {
    mk.time *= factor;
    if (mk.duration) mk.duration *= factor;
  }
}

// ---------------------------------------------------------------- clips

/**
 * Create a clip. kind: video | audio | image | text | color | adjustment.
 */
export function createClip(seq, { kind, trackId, mediaId = null, name = '', start = 0, duration = DEFAULT_STILL_DURATION, inPoint = 0, linkId = null, color }) {
  const clip = {
    id: uid('clip'),
    kind,
    trackId,
    mediaId,
    name,
    start,
    duration,
    inPoint,
    speed: 1,
    linkId,
    enabled: true,
    effects: fixedEffectsFor(kind).map((t) => createEffect(t, seq)),
    transIn: null,
    transOut: null,
  };
  if (kind === 'color' && color) findEffect(clip, 'fill').params.color.value = color;
  return clip;
}

export const clipEnd = (c) => c.start + c.duration;

/**
 * Content seconds elapsed after tl seconds of a clip with a time-remap speed param (percent).
 * Integrates the keyframed speed curve exactly for linear/hold segments and numerically (Simpson) for curved ones.
 */
export function remapIntegral(param, tl) {
  if (!param) return tl;
  const kf = param.kf;
  if (!kf || !kf.length) return (tl * param.value) / 100;
  if (tl <= 0) return (tl * kf[0].v) / 100; // transition handles before the clip: first speed
  let acc = 0;
  let t = 0;
  if (kf[0].t > 0) {
    const e = Math.min(kf[0].t, tl);
    acc += (e * kf[0].v) / 100;
    t = e;
    if (tl <= kf[0].t) return acc;
  }
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    const s0 = Math.max(a.t, t);
    const s1 = Math.min(b.t, tl);
    if (s1 <= s0) {
      if (a.t >= tl) break;
      continue;
    }
    // overshooting curves (back / elastic, steep beziers) may dip below zero: content never runs backwards
    const speedAt = (x) => Math.max(0, segmentValue(kf, i, x));
    const curved = kfInterp(a) !== 'hold' && (hasNamedEase(a) || !!segmentCurve(kf, i));
    if (curved) {
      const n = hasNamedEase(a) && easeIsWiggly(a.ease) ? 64 : 16; // Simpson's rule (even n)
      const hdt = (s1 - s0) / n;
      let sum = 0;
      for (let k = 0; k <= n; k++) sum += speedAt(s0 + k * hdt) * (k === 0 || k === n ? 1 : k % 2 ? 4 : 2);
      acc += (sum * hdt) / 3 / 100;
    } else {
      acc += (((speedAt(s0) + speedAt(s1)) / 2) * (s1 - s0)) / 100;
    }
    t = s1;
    if (t >= tl) return acc;
  }
  const last = kf[kf.length - 1];
  const from = Math.max(t, last.t);
  if (tl > from) acc += ((tl - from) * last.v) / 100;
  return acc;
}

/** Instantaneous time-remap speed factor (1 = normal) at clip-local time tl. */
export function remapSpeedAt(clip, tl) {
  const fx = clip.effects?.find((e) => e.type === 'timeRemap' && e.enabled);
  if (!fx) return 1;
  return Math.max(0, evalParam(fx.params.speed, tl) / 100);
}

/** Source seconds consumed after tl seconds into the clip (speed, time remapping). */
export function contentTime(clip, tl) {
  const fx = clip.effects?.find((e) => e.type === 'timeRemap' && e.enabled);
  const r = fx ? remapIntegral(fx.params.speed, tl) : tl;
  return r * clip.speed;
}

export function mediaTimeAt(clip, t) {
  if (clip.hold) return clip.holdTime ?? clip.inPoint;
  const tl = t - clip.start;
  if (clip.reverse) return clip.inPoint + contentTime(clip, clip.duration) - contentTime(clip, tl);
  return clip.inPoint + contentTime(clip, tl);
}

/** Media time at the clip's out point (exclusive). */
export function sourceOut(clip) {
  if (clip.hold) return clip.holdTime ?? clip.inPoint;
  return clip.inPoint + contentTime(clip, clip.duration);
}

/** True when the clip's playback speed varies over time (speed ramps). */
export function hasSpeedRamp(clip) {
  const fx = clip.effects?.find((e) => e.type === 'timeRemap' && e.enabled);
  return !!(fx && (fx.params.speed.kf?.length || fx.params.speed.value !== 100));
}

/** Clips whose content runs in time (video, audio, nested sequences) — speed/slip/trim limits apply. */
export const isTimed = (clip) => clip.kind === 'video' || clip.kind === 'audio' || clip.kind === 'nest';

/** Media-backed clips are limited by source duration; generated clips are not. */
export function isMediaBounded(clip, media) {
  return isTimed(clip) && media && Number.isFinite(media.duration);
}

export function clipsOnTrack(seq, trackId) {
  return Object.values(seq.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function sequenceDuration(seq) {
  let end = 0;
  for (const c of Object.values(seq.clips)) end = Math.max(end, clipEnd(c));
  return end;
}

export function linkedClips(seq, clip) {
  if (!clip.linkId) return [clip];
  return Object.values(seq.clips).filter((c) => c.linkId === clip.linkId);
}

export function prevAdjacent(seq, clip) {
  return Object.values(seq.clips).find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 1e-4);
}

export function nextAdjacent(seq, clip) {
  return Object.values(seq.clips).find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < 1e-4);
}

export function clipAt(seq, trackId, t) {
  return Object.values(seq.clips).find((c) => c.trackId === trackId && t >= c.start - EPS && t < clipEnd(c) - EPS);
}

/**
 * Transition windows that touch a clip. A transIn on a clip with an adjacent previous clip is a
 * two-sided transition centred on the cut; otherwise it is a one-sided fade at the clip head.
 * Returns { lead, tail } seconds by which the clip's visible range extends beyond its bounds.
 */
export function transitionExtents(seq, clip) {
  let lead = 0;
  let tail = 0;
  if (clip.transIn && prevAdjacent(seq, clip)) lead = clip.transIn.duration / 2;
  const next = nextAdjacent(seq, clip);
  if (next?.transIn) tail = next.transIn.duration / 2;
  return { lead, tail };
}

/** All transition windows on a track: [{clip, edge, type, start, end, a, b}]. */
export function transitionsOnTrack(seq, trackId) {
  const out = [];
  for (const c of clipsOnTrack(seq, trackId)) {
    if (c.transIn) {
      const prev = prevAdjacent(seq, c);
      const d = c.transIn.duration;
      if (prev) out.push({ clip: c, edge: 'in', type: c.transIn.type, start: c.start - d / 2, end: c.start + d / 2, a: prev, b: c });
      else out.push({ clip: c, edge: 'in', type: c.transIn.type, start: c.start, end: c.start + d, a: null, b: c });
    }
    if (c.transOut && !nextAdjacent(seq, c)?.transIn) {
      const d = c.transOut.duration;
      out.push({ clip: c, edge: 'out', type: c.transOut.type, start: clipEnd(c) - d, end: clipEnd(c), a: c, b: null });
    }
  }
  return out;
}

/** Edit points (clip starts/ends) across tracks, sorted & unique. */
export function editPoints(seq, trackIds = null) {
  const set = new Set([0]);
  for (const c of Object.values(seq.clips)) {
    if (trackIds && !trackIds.includes(c.trackId)) continue;
    set.add(+c.start.toFixed(6));
    set.add(+clipEnd(c).toFixed(6));
  }
  return [...set].sort((a, b) => a - b);
}

export function clampTransitionDuration(seq, clip, edge, d) {
  const fd = 1 / seq.fps;
  if (edge === 'in') {
    const prev = prevAdjacent(seq, clip);
    const max = prev ? 2 * Math.min(prev.duration, clip.duration) : clip.duration;
    return clamp(d, fd, max);
  }
  return clamp(d, fd, clip.duration);
}

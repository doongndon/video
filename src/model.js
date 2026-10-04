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
  seq.tracks.find((t) => t.kind === 'video').targeted = true;
  seq.tracks.find((t) => t.kind === 'audio').targeted = true;
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
    targeted: false,
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

/** Evaluate a param at clip-local time (seconds from clip start). */
export function evalParam(param, tLocal) {
  if (!param) return undefined;
  const kf = param.kf;
  if (!kf || kf.length === 0) return param.value;
  if (tLocal <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (tLocal >= last.t) return last.v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    if (tLocal >= a.t && tLocal <= b.t) {
      if (typeof a.v !== 'number' || a.ease === 'hold') return a.v;
      const u = (tLocal - a.t) / Math.max(EPS, b.t - a.t);
      return lerp(a.v, b.v, easeFn(a.ease)(u));
    }
  }
  return last.v;
}

/** Evaluate all params of an effect into a plain {key: value} object. */
export function evalEffect(effect, tLocal) {
  const out = {};
  for (const [k, p] of Object.entries(effect.params)) out[k] = evalParam(p, tLocal);
  return out;
}

export const isAnimated = (param) => !!(param?.kf && param.kf.length);

/** Easing given to newly created keyframes (효과 컨트롤 ▸ 키프레임 오른쪽 클릭 ▸ 새 키프레임 기본 이징). */
export const keyframeDefaults = { ease: 'linear' };

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
    param.kf.push({ t: tLocal, v: value, ease: keyframeDefaults.ease });
    param.kf.sort((a, b) => a.t - b.t);
  }
  param.value = value;
}

export function toggleAnimation(param, tLocal) {
  if (isAnimated(param)) {
    param.value = evalParam(param, tLocal);
    param.kf = null;
  } else {
    param.kf = [{ t: tLocal, v: param.value, ease: keyframeDefaults.ease }];
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
    param.kf.push({ t: tLocal, v: evalParam(param, tLocal), ease: keyframeDefaults.ease });
    param.kf.sort((a, b) => a.t - b.t);
  }
}

/** Shift every keyframe of a clip (used when the head is trimmed so keys stay on the same frame). */
export function shiftClipKeyframes(clip, dt) {
  if (Math.abs(dt) < EPS) return;
  for (const fx of clip.effects) {
    for (const p of Object.values(fx.params)) if (p.kf) for (const k of p.kf) k.t += dt;
  }
}

/** Scale keyframe times (used when clip speed changes). */
export function scaleClipKeyframes(clip, factor) {
  for (const fx of clip.effects) {
    for (const p of Object.values(fx.params)) if (p.kf) for (const k of p.kf) k.t *= factor;
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
 * Integrates the keyframed speed curve exactly for linear/hold segments and numerically (Simpson) for eased ones.
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
    const span = Math.max(EPS, b.t - a.t);
    const ease = easeFn(a.ease);
    // overshooting curves (back / elastic) may dip below zero: content never runs backwards
    const speedAt = (x) => (a.ease === 'hold' ? a.v : Math.max(0, lerp(a.v, b.v, ease((x - a.t) / span))));
    if (a.ease && a.ease !== 'linear' && a.ease !== 'hold') {
      const n = easeIsWiggly(a.ease) ? 64 : 12; // Simpson's rule (even n)
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
  if (clip.hold) return clip.inPoint;
  const tl = t - clip.start;
  if (clip.reverse) return clip.inPoint + contentTime(clip, clip.duration) - contentTime(clip, tl);
  return clip.inPoint + contentTime(clip, tl);
}

/** Media time at the clip's out point (exclusive). */
export function sourceOut(clip) {
  if (clip.hold) return clip.inPoint;
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

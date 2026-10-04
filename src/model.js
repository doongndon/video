// Project / sequence data model: factories, queries and keyframe evaluation.
// Everything here is plain JSON so it can be snapshotted for undo and persisted.

import { uid, EPS, clamp, lerp } from './util.js';
import { EFFECTS, fixedEffectsFor } from './effects.js';

export const DEFAULT_STILL_DURATION = 5;

export function createProject(name = 'Untitled Project') {
  return {
    version: 1,
    name,
    media: {},
    mediaOrder: [],
    sequence: createSequence(),
  };
}

export function createSequence({ name = 'Sequence 01', width = 1920, height = 1080, fps = 30, videoTracks = 3, audioTracks = 3 } = {}) {
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
  for (const p of def.params) params[p.key] = { value: defaultParamValue(p, seq), kf: null };
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
      let u = (tLocal - a.t) / Math.max(EPS, b.t - a.t);
      if (a.ease === 'ease') u = u * u * (3 - 2 * u);
      return lerp(a.v, b.v, u);
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
    param.kf.push({ t: tLocal, v: value, ease: 'linear' });
    param.kf.sort((a, b) => a.t - b.t);
  }
  param.value = value;
}

export function toggleAnimation(param, tLocal) {
  if (isAnimated(param)) {
    param.value = evalParam(param, tLocal);
    param.kf = null;
  } else {
    param.kf = [{ t: tLocal, v: param.value, ease: 'linear' }];
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
    param.kf.push({ t: tLocal, v: evalParam(param, tLocal), ease: 'linear' });
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

export function mediaTimeAt(clip, t) {
  if (clip.hold) return clip.inPoint;
  if (clip.reverse) return clip.inPoint + (clip.start + clip.duration - t) * clip.speed;
  return clip.inPoint + (t - clip.start) * clip.speed;
}

/** Media-backed clips are limited by source duration; generated clips are not. */
export function isMediaBounded(clip, media) {
  return (clip.kind === 'video' || clip.kind === 'audio') && media && Number.isFinite(media.duration);
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

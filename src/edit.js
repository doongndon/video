// Editing operations on the active sequence. Every exported function performs one undoable step
// via store.transact unless noted ("raw" helpers mutate without a transaction).

import { store } from './store.js';
import { uid, EPS, clamp, snapFrame, deepClone } from './util.js';
import {
  setParamValue, createClip, createTrack, clipEnd, clipsOnTrack, linkedClips, getTrack, videoTracks, audioTracks,
  sequenceDuration, prevAdjacent, nextAdjacent, shiftClipKeyframes, scaleClipKeyframes, renameTracks,
  clampTransitionDuration, trackKindForClip, DEFAULT_STILL_DURATION, createEffect, isTimed,
  addSequenceToProject, createSequence, sequenceContains, sequenceMediaId,
} from './model.js';
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_VIDEO_TRANSITION, TRANSITIONS, EFFECTS } from './effects.js';

const seq = () => store.seq;
const media = (id) => store.project.media[id];
const fd = () => 1 / seq().fps;
const q = (t) => snapFrame(t, seq().fps);

// ---------------------------------------------------------------- raw helpers

function cloneClip(c, overrides = {}) {
  const copy = deepClone(c);
  copy.id = uid('clip');
  for (const fx of copy.effects) fx.id = uid('fx');
  return Object.assign(copy, overrides);
}

/** Remove the range [t0, t1) from a track (overwrite semantics). Clips crossing the range are trimmed or split. */
export function rawClearRange(trackId, t0, t1, exceptIds = new Set()) {
  const s = seq();
  if (t1 - t0 < EPS) return;
  for (const c of clipsOnTrack(s, trackId)) {
    if (exceptIds.has(c.id)) continue;
    const ce = clipEnd(c);
    if (ce <= t0 + EPS || c.start >= t1 - EPS) continue;
    if (c.start >= t0 - EPS && ce <= t1 + EPS) {
      delete s.clips[c.id];
    } else if (c.start < t0 && ce > t1) {
      // range is inside clip: split into two
      const right = cloneClip(c, { linkId: null });
      const cut = t1 - c.start;
      right.start = t1;
      right.duration = ce - t1;
      right.inPoint = c.inPoint + cut * c.speed;
      shiftClipKeyframes(right, -cut);
      right.transIn = null;
      c.duration = t0 - c.start;
      c.transOut = null;
      s.clips[right.id] = right;
    } else if (c.start < t0) {
      c.duration = t0 - c.start;
      c.transOut = null;
    } else {
      const cut = t1 - c.start;
      c.start = t1;
      c.duration = ce - t1;
      c.inPoint += cut * c.speed;
      shiftClipKeyframes(c, -cut);
      c.transIn = null;
    }
  }
}

/**
 * Clear [t0, t1) on several tracks at once. Splitting all tracks together keeps linked
 * video/audio halves linked to each other.
 */
export function rawClearRangeMulti(trackIds, t0, t1, exceptIds = new Set()) {
  const s = seq();
  if (t1 - t0 < EPS) return;
  splitAllAt(trackIds, t0, exceptIds);
  splitAllAt(trackIds, t1, exceptIds);
  for (const c of Object.values(s.clips)) {
    if (!trackIds.includes(c.trackId) || exceptIds.has(c.id)) continue;
    if (c.start >= t0 - EPS && clipEnd(c) <= t1 + EPS) delete s.clips[c.id];
  }
  // anything still overlapping (e.g. excluded neighbours) falls back to per-track clearing
  for (const tid of trackIds) rawClearRange(tid, t0, t1, exceptIds);
}

/** Shift every clip that starts at or after t on the given tracks by dt (ripple). */
export function rawRipple(trackIds, t, dt, exceptIds = new Set()) {
  if (Math.abs(dt) < EPS) return;
  const s = seq();
  for (const c of Object.values(s.clips)) {
    if (exceptIds.has(c.id) || !trackIds.includes(c.trackId)) continue;
    if (c.start >= t - EPS) c.start = Math.max(0, c.start + dt);
  }
}

/** Split a clip at time t (raw). Returns the right-hand clip or null. */
export function rawSplit(c, t) {
  const s = seq();
  t = q(t);
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const right = cloneClip(c);
  const cut = t - c.start;
  right.start = t;
  right.duration = clipEnd(c) - t;
  right.inPoint = c.hold ? c.inPoint : c.inPoint + cut * c.speed;
  right.transIn = null;
  shiftClipKeyframes(right, -cut);
  c.duration = cut;
  c.transOut = null;
  s.clips[right.id] = right;
  return right;
}

/** Split every clip crossing t on the given tracks, keeping linked partners linked. */
function splitAllAt(trackIds, t, exceptIds = new Set()) {
  const s = seq();
  const crossing = Object.values(s.clips).filter((c) => trackIds.includes(c.trackId) && !exceptIds.has(c.id) && c.start < t - EPS && clipEnd(c) > t + EPS);
  const groups = new Map();
  for (const c of crossing) {
    const key = c.linkId || c.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const g of groups.values()) splitGroup(g, t);
}

/** Split linked groups consistently so the right halves stay linked to each other. */
function splitGroup(clips, t) {
  const newLink = uid('link');
  const rights = [];
  for (const c of clips) {
    const r = rawSplit(c, t);
    if (r) {
      if (c.linkId) r.linkId = newLink;
      rights.push(r);
    }
  }
  return rights;
}

function unlockedTrackIds(kind) {
  return seq().tracks.filter((t) => !t.locked && (!kind || t.kind === kind)).map((t) => t.id);
}

function isLocked(trackId) {
  return !!getTrack(seq(), trackId)?.locked;
}

/** Expand a set of clip ids by their linked partners when linked selection is on. */
export function withLinked(ids) {
  const s = seq();
  const out = new Set(ids);
  if (!store.ui.linkedSelection) return out;
  for (const id of ids) {
    const c = s.clips[id];
    if (c?.linkId) for (const l of linkedClips(s, c)) out.add(l.id);
  }
  return out;
}

// ---------------------------------------------------------------- placing media

/**
 * Place media into the sequence. mode: 'overwrite' | 'insert'.
 * opts: { start, vTrackId, aTrackId, inPoint, outPoint, video, audio }
 */
export function placeMedia(mediaId, opts) {
  const m = media(mediaId);
  if (!m) return [];
  const s = seq();
  if (m.kind === 'sequence' && sequenceContains(store.project, m.sequenceId, s.id)) {
    store.toast('A sequence cannot be nested inside itself');
    return [];
  }
  const mode = opts.mode || 'overwrite';
  const start = q(Math.max(0, opts.start ?? store.ui.playhead));
  const inPoint = opts.inPoint ?? m.inPoint ?? 0;
  let outPoint = opts.outPoint ?? m.outPoint ?? (m.duration ?? (inPoint + DEFAULT_STILL_DURATION));
  if (m.duration == null && outPoint - inPoint <= 0) outPoint = inPoint + DEFAULT_STILL_DURATION;
  const duration = Math.max(fd(), outPoint - inPoint);
  const wantVideo = opts.video !== false && m.kind !== 'audio';
  const wantAudio = opts.audio !== false && (m.kind === 'audio' || ((m.kind === 'video' || m.kind === 'sequence') && m.hasAudio));

  const vTrack = wantVideo ? getTrack(s, opts.vTrackId) || targetTrack('video') : null;
  const aTrack = wantAudio ? getTrack(s, opts.aTrackId) || targetTrack('audio') : null;
  if ((vTrack && vTrack.locked) || (aTrack && aTrack.locked)) {
    store.toast('Target track is locked');
    return [];
  }
  if (!vTrack && !aTrack) return [];

  return store.transact(mode === 'insert' ? 'Insert' : 'Overwrite', () => {
    const linkId = vTrack && aTrack ? uid('link') : null;
    const trackIds = [vTrack?.id, aTrack?.id].filter(Boolean);
    if (mode === 'insert') {
      const affected = unlockedTrackIds();
      splitAllAt(affected, start);
      rawRipple(affected, start, duration);
    } else {
      rawClearRangeMulti(trackIds, start, start + duration);
    }
    const created = [];
    const clipKind = m.kind === 'sequence' ? 'nest' : m.kind;
    if (vTrack) {
      const c = createClip(s, { kind: clipKind, trackId: vTrack.id, mediaId, name: m.name, start, duration, inPoint, linkId, color: m.color });
      s.clips[c.id] = c;
      created.push(c.id);
    }
    if (aTrack) {
      const c = createClip(s, { kind: 'audio', trackId: aTrack.id, mediaId, name: m.name, start, duration, inPoint, linkId });
      s.clips[c.id] = c;
      created.push(c.id);
    }
    store.selectClips(created);
    return created;
  });
}

export function targetTrack(kind) {
  const s = seq();
  const list = kind === 'video' ? videoTracks(s) : audioTracks(s);
  return list.find((t) => t.targeted && !t.locked) || list.find((t) => !t.locked) || null;
}

/** Create a text clip at the playhead on the first free video track. */
export function addTextClip({ start = store.ui.playhead, x, y, content } = {}) {
  const s = seq();
  start = q(start);
  const dur = DEFAULT_STILL_DURATION;
  const tracks = videoTracks(s).filter((t) => !t.locked);
  let track = tracks.find((t, i) => i > 0 && !clipsOnTrack(s, t.id).some((c) => c.start < start + dur && clipEnd(c) > start));
  return store.transact('New Text', () => {
    if (!track) {
      track = createTrack('video', videoTracks(s).length);
      const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
      s.tracks.splice(lastVideoIdx + 1, 0, track);
      renameTracks(s);
    }
    const c = createClip(s, { kind: 'text', trackId: track.id, name: 'Text', start, duration: dur });
    const motion = c.effects.find((e) => e.type === 'motion');
    if (x != null) motion.params.posX.value = Math.round(x);
    if (y != null) motion.params.posY.value = Math.round(y);
    if (content) c.effects.find((e) => e.type === 'text').params.content.value = content;
    s.clips[c.id] = c;
    store.selectClips([c.id]);
    return c.id;
  });
}

/** Create a shape clip (rectangle / ellipse / triangle / line) at the playhead. */
export function addShapeClip(shape = 'rectangle', { start = store.ui.playhead } = {}) {
  const s = seq();
  start = q(start);
  const dur = DEFAULT_STILL_DURATION;
  const tracks = videoTracks(s).filter((t) => !t.locked);
  let track = tracks.find((t, i) => i > 0 && !clipsOnTrack(s, t.id).some((c) => c.start < start + dur && clipEnd(c) > start));
  return store.transact('New Shape', () => {
    if (!track) {
      track = createTrack('video', videoTracks(s).length);
      const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
      s.tracks.splice(lastVideoIdx + 1, 0, track);
      renameTracks(s);
    }
    const c = createClip(s, { kind: 'shape', trackId: track.id, name: shape[0].toUpperCase() + shape.slice(1), start, duration: dur });
    const fx = c.effects.find((e) => e.type === 'shape');
    fx.params.shape.value = shape;
    if (shape === 'ellipse') {
      fx.params.width.value = 400;
      fx.params.height.value = 400;
    }
    if (shape === 'line') {
      fx.params.strokeWidth.value = 8;
      fx.params.height.value = 8;
    }
    s.clips[c.id] = c;
    store.selectClips([c.id]);
    return c.id;
  });
}

// ---------------------------------------------------------------- delete / lift / extract

export function deleteSelection({ ripple = false } = {}) {
  const s = seq();
  const sel = store.selection;
  if (sel.transition) {
    const c = s.clips[sel.transition.clipId];
    store.transact('Clear Transition', () => {
      if (c) c[sel.transition.edge === 'in' ? 'transIn' : 'transOut'] = null;
      store.selection.transition = null;
    });
    store.emit('selection');
    return;
  }
  if (sel.gap) {
    const { trackId, start, end } = sel.gap;
    // close the gap on every unlocked track that is empty across it (keeps tracks in sync)
    const empty = unlockedTrackIds().filter((id) => !clipsOnTrack(s, id).some((c) => c.start < end - EPS && clipEnd(c) > start + EPS));
    if (!empty.includes(trackId)) return;
    store.transact('Ripple Delete Gap', () => rawRipple(empty, end - EPS, -(end - start)));
    store.selection.gap = null;
    store.emit('selection');
    return;
  }
  const ids = [...withLinked(sel.clips)].filter((id) => s.clips[id] && !isLocked(s.clips[id].trackId));
  if (!ids.length) return;
  store.transact(ripple ? 'Ripple Delete' : 'Clear', () => {
    const removed = ids.map((id) => s.clips[id]);
    for (const c of removed) delete s.clips[c.id];
    if (ripple) {
      // close the gap on each affected track, from right to left
      const spans = mergeSpans(removed.map((c) => [c.start, clipEnd(c)]));
      const tracks = [...new Set(removed.map((c) => c.trackId))];
      for (const [a, b] of spans.reverse()) {
        // only ripple if the span is empty on all affected tracks after removal
        const blocked = tracks.some((tid) => clipsOnTrack(s, tid).some((c) => c.start < b - EPS && clipEnd(c) > a + EPS));
        if (!blocked) rawRipple(tracks, b, -(b - a));
      }
    }
  });
  store.clearSelection();
}

function mergeSpans(spans) {
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp[0] <= last[1] + EPS) last[1] = Math.max(last[1], sp[1]);
    else out.push([...sp]);
  }
  return out;
}

/** Lift (leave gap) or extract (ripple) the sequence in/out range on targeted tracks. */
export function liftExtract(extract) {
  const s = seq();
  if (s.inPoint == null || s.outPoint == null || s.outPoint <= s.inPoint) {
    store.toast('Set sequence In and Out points first (I / O)');
    return;
  }
  const tracks = s.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id);
  const all = unlockedTrackIds();
  store.transact(extract ? 'Extract' : 'Lift', () => {
    rawClearRangeMulti(extract ? all : tracks, s.inPoint, s.outPoint);
    if (extract) rawRipple(all, s.outPoint, -(s.outPoint - s.inPoint));
    if (extract) {
      store.setPlayhead(s.inPoint);
      s.outPoint = null;
    }
  });
}

// ---------------------------------------------------------------- split

/** Add edit at time t on targeted tracks (or all tracks), or on the selected clips if any are under t. */
export function addEdit({ allTracks = false, t = store.ui.playhead, clipIds = null } = {}) {
  const s = seq();
  t = q(t);
  let targets;
  if (clipIds) targets = clipIds.map((id) => s.clips[id]).filter(Boolean);
  else {
    const selUnder = store.selectedClips().filter((c) => c.start < t && clipEnd(c) > t);
    if (selUnder.length && !allTracks) targets = selUnder;
    else {
      const tracks = s.tracks.filter((tr) => !tr.locked && (allTracks || tr.targeted)).map((tr) => tr.id);
      targets = Object.values(s.clips).filter((c) => tracks.includes(c.trackId));
    }
  }
  targets = [...withLinked(targets.map((c) => c.id))].map((id) => s.clips[id]).filter((c) => c && !isLocked(c.trackId) && c.start < t - EPS && clipEnd(c) > t + EPS);
  if (!targets.length) return;
  store.transact('Add Edit', () => {
    const groups = new Map();
    for (const c of targets) {
      const key = c.linkId || c.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const g of groups.values()) splitGroup(g, t);
  });
}

// ---------------------------------------------------------------- move

/**
 * Move clips by dt seconds and dTrack lanes (per kind). mode 'overwrite' clears destination ranges,
 * 'insert' ripples destination tracks, 'free' leaves overlaps (used only for previews).
 * duplicate: copy instead of move.
 */
export function rawMoveClips(ids, dt, dTrackVideo, dTrackAudio, { mode = 'overwrite', duplicate = false } = {}) {
  const s = seq();
  const vts = videoTracks(s);
  const ats = audioTracks(s);
  const moving = ids.map((id) => s.clips[id]).filter(Boolean);
  const plan = [];
  for (const c of moving) {
    const list = c.kind === 'audio' ? ats : vts;
    const idx = list.findIndex((t) => t.id === c.trackId);
    const d = c.kind === 'audio' ? dTrackAudio : dTrackVideo;
    const nidx = clamp(idx + d, 0, list.length - 1);
    plan.push({ c, trackId: list[nidx].id, start: Math.max(0, c.start + dt) });
  }
  if (plan.some((p) => isLocked(p.trackId) || isLocked(p.c.trackId))) return null;
  let targets = plan.map((p) => p.c);
  if (duplicate) {
    const linkMap = new Map();
    targets = plan.map((p) => {
      const copy = cloneClip(p.c);
      if (p.c.linkId) {
        if (!linkMap.has(p.c.linkId)) linkMap.set(p.c.linkId, uid('link'));
        copy.linkId = linkMap.get(p.c.linkId);
      }
      s.clips[copy.id] = copy;
      p.c = copy;
      return copy;
    });
  }
  const exceptIds = new Set(targets.map((c) => c.id));
  if (mode === 'insert') {
    const minStart = Math.min(...plan.map((p) => p.start));
    const span = Math.max(...plan.map((p) => p.start + p.c.duration)) - minStart;
    // pull moved clips out first so the ripple doesn't move them
    splitAllAt(unlockedTrackIds(), minStart, exceptIds);
    rawRipple(unlockedTrackIds(), minStart, span, exceptIds);
  }
  for (const p of plan) {
    p.c.trackId = p.trackId;
    p.c.start = p.start;
  }
  if (mode === 'overwrite') {
    // clear destination ranges; group by identical span so linked partners split together
    const spans = new Map();
    for (const p of plan) {
      const key = `${p.start.toFixed(6)}:${(p.start + p.c.duration).toFixed(6)}`;
      if (!spans.has(key)) spans.set(key, { t0: p.start, t1: p.start + p.c.duration, tracks: [] });
      spans.get(key).tracks.push(p.trackId);
    }
    for (const sp of spans.values()) rawClearRangeMulti(sp.tracks, sp.t0, sp.t1, exceptIds);
  }
  return targets.map((c) => c.id);
}

// ---------------------------------------------------------------- trims

/**
 * Compute limits for trimming an edge. Returns { min, max } of the allowed delta (seconds).
 * edge 'in' delta>0 shortens from the head; edge 'out' delta>0 lengthens the tail.
 */
export function trimLimits(c, edge, { ripple = false, rolling = false } = {}) {
  const s = seq();
  const m = media(c.mediaId);
  const bounded = isTimed(c) && m && Number.isFinite(m.duration) && !c.hold;
  let min = -Infinity;
  let max = Infinity;
  const f = fd();
  if (edge === 'in') {
    max = c.duration - f; // keep at least one frame
    if (bounded) min = Math.max(min, -c.inPoint / c.speed);
    min = Math.max(min, -c.start);
    if (!ripple && !rolling) {
      const prev = clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start + EPS).pop();
      if (prev) min = Math.max(min, prev ? clipEnd(prev) - c.start : min);
    }
  } else {
    min = -(c.duration - f);
    if (bounded) max = Math.min(max, (m.duration - c.inPoint) / c.speed - c.duration);
    if (!ripple && !rolling) {
      const next = clipsOnTrack(s, c.trackId).find((x) => x.id !== c.id && x.start >= clipEnd(c) - EPS);
      if (next) max = Math.min(max, next.start - clipEnd(c));
    }
  }
  if (min > max) min = max = 0;
  return { min, max };
}

export function rawTrimEdge(c, edge, delta) {
  if (edge === 'in') {
    c.start += delta;
    c.duration -= delta;
    if (!c.hold) c.inPoint += delta * c.speed;
    shiftClipKeyframes(c, -delta);
  } else {
    c.duration += delta;
  }
  if (c.transIn) c.transIn.duration = Math.min(c.transIn.duration, c.duration);
  if (c.transOut) c.transOut.duration = Math.min(c.transOut.duration, c.duration);
}

/** Ripple trim: trims the edge and shifts later clips on the same tracks. */
export function rawRippleTrim(clips, edge, delta) {
  const tracks = [...new Set(clips.map((c) => c.trackId))];
  const ids = new Set(clips.map((c) => c.id));
  if (edge === 'in') {
    // trimming head by delta: keep clip start fixed, content shifts; later clips shift by -delta
    const pivot = clips[0].start;
    for (const c of clips) {
      rawTrimEdge(c, 'in', delta);
      c.start -= delta;
    }
    rawRipple(tracks, pivot + EPS, -delta, ids);
  } else {
    const pivot = clipEnd(clips[0]);
    rawRipple(tracks, pivot - EPS, delta, ids);
    for (const c of clips) rawTrimEdge(c, 'out', delta);
  }
}

/** Q / W: ripple trim previous / next edit to playhead on targeted tracks. */
export function rippleTrimToPlayhead(which) {
  const s = seq();
  const t = q(store.ui.playhead);
  const tracks = s.tracks.filter((tr) => tr.targeted && !tr.locked).map((tr) => tr.id);
  const under = Object.values(s.clips).filter((c) => tracks.includes(c.trackId) && c.start < t - EPS && clipEnd(c) > t + EPS);
  if (!under.length) return;
  const all = [...withLinked(under.map((c) => c.id))].map((id) => s.clips[id]);
  const affectedTracks = [...new Set(all.map((c) => c.trackId))];
  store.transact(which === 'prev' ? 'Ripple Trim Previous Edit' : 'Ripple Trim Next Edit', () => {
    if (which === 'prev') {
      const delta = Math.min(...all.map((c) => t - c.start));
      for (const c of all) rawTrimEdge(c, 'in', delta);
      for (const c of all) c.start -= delta;
      rawRipple(affectedTracks, t + EPS, -delta, new Set(all.map((c) => c.id)));
      store.setPlayhead(t - delta);
    } else {
      const ends = all.map((c) => clipEnd(c));
      const delta = Math.max(...ends) - t;
      for (const c of all) rawTrimEdge(c, 'out', -(clipEnd(c) - t));
      rawRipple(affectedTracks, Math.max(...ends) - EPS, -delta, new Set(all.map((c) => c.id)));
    }
  });
}

// ---------------------------------------------------------------- clip properties

export function setSpeed(ids, { speed, duration, ripple = false, hold = false, reverse = false }) {
  const s = seq();
  store.transact('Speed/Duration', () => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c) continue;
      const oldDur = c.duration;
      if (isTimed(c)) {
        const newSpeed = speed ?? c.speed;
        let newDur = duration ?? (c.duration * c.speed) / newSpeed;
        const m = media(c.mediaId);
        if (m && Number.isFinite(m.duration) && !hold) newDur = Math.min(newDur, (m.duration - c.inPoint) / newSpeed);
        scaleClipKeyframes(c, newDur / c.duration);
        c.speed = newSpeed;
        c.duration = Math.max(fd(), q(newDur));
        c.hold = hold;
        c.reverse = reverse;
      } else if (duration) {
        c.duration = Math.max(fd(), q(duration));
      }
      if (ripple) rawRipple([c.trackId], c.start + oldDur - EPS, c.duration - oldDur, new Set([c.id]));
      else {
        const next = clipsOnTrack(s, c.trackId).find((x) => x.id !== c.id && x.start >= c.start + oldDur - EPS);
        if (next && clipEnd(c) > next.start) c.duration = next.start - c.start;
      }
    }
  });
}

/** Add Frame Hold: split at the playhead and freeze the frame there for the rest of the clip. */
export function addFrameHold(c, t = store.ui.playhead) {
  if (c.kind !== 'video') return;
  store.transact('Add Frame Hold', () => {
    const at = q(t);
    const target = at > c.start + EPS ? rawSplit(c, at) || c : c;
    target.hold = true;
    target.name = `${c.name} (Hold)`;
  });
}

/** Normalize clip volume so the loudest peak in the used range hits targetDb. */
export function normalizeAudio(ids, peakFn, targetDb = -1) {
  const s = seq();
  let changed = 0;
  store.transact('Normalize Audio', () => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c || c.kind !== 'audio') continue;
      const a = c.inPoint;
      const b = c.inPoint + c.duration * c.speed;
      const peak = peakFn(c.mediaId, Math.min(a, b), Math.max(a, b));
      if (!peak) continue;
      const vol = c.effects.find((e) => e.type === 'volume');
      if (!vol) continue;
      const level = clamp(targetDb - 20 * Math.log10(peak), -60, 15);
      const p = vol.params.level;
      if (p.kf) {
        const d = level - Math.max(...p.kf.map((k) => k.v));
        for (const k of p.kf) k.v = clamp(k.v + d, -60, 15);
      }
      p.value = Math.round(level * 10) / 10;
      changed++;
    }
  });
  return changed;
}

/** Apply cuts at the given sequence times to one clip (and its linked partners). */
export function cutClipAt(clipId, times) {
  const s = seq();
  store.transact('Scene Edit Detection', () => {
    for (const t of [...times].sort((a, b) => b - a)) {
      const c = Object.values(s.clips).find((x) => (x.id === clipId || (s.clips[clipId]?.linkId && x.linkId === s.clips[clipId].linkId)) && x.start < t - EPS && clipEnd(x) > t + EPS);
      if (!c) continue;
      splitGroup(linkedClips(s, c).filter((x) => x.start < t - EPS && clipEnd(x) > t + EPS), t);
    }
  });
}

export function setEnabled(ids, enabled) {
  const s = seq();
  store.transact(enabled ? 'Enable' : 'Disable', () => {
    for (const id of withLinked(ids)) if (s.clips[id]) s.clips[id].enabled = enabled ?? !s.clips[id].enabled;
  });
}

export function linkClips(ids) {
  const s = seq();
  const clips = ids.map((id) => s.clips[id]).filter(Boolean);
  if (clips.length < 2) return;
  store.transact('Link', () => {
    const l = uid('link');
    for (const c of clips) c.linkId = l;
  });
}

export function unlinkClips(ids) {
  const s = seq();
  store.transact('Unlink', () => {
    for (const id of withLinked(ids)) if (s.clips[id]) s.clips[id].linkId = null;
  });
}

export function renameClip(id, name) {
  store.transact('Rename', () => {
    const c = seq().clips[id];
    if (c) c.name = name;
  });
}

// ---------------------------------------------------------------- transitions

/** Apply a transition. edge 'in' | 'out'. If 'out' has an adjacent clip, it becomes that clip's 'in'. */
export function applyTransition(clipId, edge, type, duration = 1) {
  const s = seq();
  let c = s.clips[clipId];
  if (!c) return;
  const def = TRANSITIONS[type];
  if (!def || (def.kind === 'audio') !== (c.kind === 'audio')) {
    store.toast(`${def?.name || 'Transition'} can only be applied to ${def?.kind} clips`);
    return;
  }
  store.transact(`Apply ${def.name}`, () => {
    if (edge === 'out') {
      const next = nextAdjacent(s, c);
      if (next) {
        c = next;
        edge = 'in';
      }
    }
    const d = clampTransitionDuration(s, c, edge, duration);
    c[edge === 'in' ? 'transIn' : 'transOut'] = { type, duration: q(d) || fd() };
    store.selectTransition(c.id, edge);
  });
}

export function applyDefaultTransitions({ video = true, audio = true } = {}) {
  const s = seq();
  const sel = store.selectedClips();
  const apply = (c, edge) => {
    const type = c.kind === 'audio' ? DEFAULT_AUDIO_TRANSITION : DEFAULT_VIDEO_TRANSITION;
    if ((c.kind === 'audio' && !audio) || (c.kind !== 'audio' && !video)) return;
    if (edge === 'out') {
      const next = nextAdjacent(s, c);
      if (next) { c = next; edge = 'in'; }
    }
    const d = clampTransitionDuration(s, c, edge, 1);
    c[edge === 'in' ? 'transIn' : 'transOut'] = { type, duration: q(d) || fd() };
  };
  store.transact('Apply Default Transitions', () => {
    if (sel.length) {
      for (const c of sel) {
        apply(c, 'in');
        apply(c, 'out');
      }
      return;
    }
    const t = store.ui.playhead;
    const tracks = s.tracks.filter((tr) => tr.targeted && !tr.locked).map((tr) => tr.id);
    for (const tid of tracks) {
      const clips = clipsOnTrack(s, tid);
      // nearest edit point to the playhead
      let best = null;
      for (const c of clips) {
        for (const [edge, time] of [['in', c.start], ['out', clipEnd(c)]]) {
          if (!best || Math.abs(time - t) < Math.abs(best.time - t)) best = { c, edge, time };
        }
      }
      if (best) apply(best.c, best.edge);
    }
  });
}

export function setTransitionDuration(clipId, edge, d) {
  const s = seq();
  const c = s.clips[clipId];
  if (!c) return;
  const key = edge === 'in' ? 'transIn' : 'transOut';
  if (!c[key]) return;
  c[key].duration = q(clampTransitionDuration(s, c, edge, d)) || fd();
}

// ---------------------------------------------------------------- effects

/** Write a param at the playhead (keyframing aware). Raw: caller wraps in a transaction/begin. */
export function rawSetParam(clip, fx, key, value) {
  const p = fx.params[key];
  if (!p) return;
  setParamValue(p, value, clamp(store.ui.playhead - clip.start, 0, clip.duration), fd());
}

export function addEffect(clipIds, type) {
  const s = seq();
  const def = EFFECTS[type];
  store.transact(`Add ${def.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c) continue;
      if ((def.kind === 'audio') !== (c.kind === 'audio')) continue;
      c.effects.push(createEffect(type, s));
    }
  });
}

export function removeEffect(clipId, fxId) {
  store.transact('Remove Effect', () => {
    const c = seq().clips[clipId];
    if (c) c.effects = c.effects.filter((e) => e.id !== fxId || EFFECTS[e.type].fixed);
  });
}

export function moveEffect(clipId, fxId, dir) {
  store.transact('Reorder Effect', () => {
    const c = seq().clips[clipId];
    const i = c.effects.findIndex((e) => e.id === fxId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.effects.length || EFFECTS[c.effects[j].type].fixed) return;
    [c.effects[i], c.effects[j]] = [c.effects[j], c.effects[i]];
  });
}

export function resetEffect(clipId, fxId) {
  const s = seq();
  store.transact('Reset Effect', () => {
    const c = s.clips[clipId];
    const fx = c?.effects.find((e) => e.id === fxId);
    if (!fx) return;
    const fresh = createEffect(fx.type, s);
    fx.params = fresh.params;
  });
}

/** Copy effects from one clip to others (Paste Attributes). */
export function pasteAttributes(sourceClip, targetIds) {
  const s = seq();
  store.transact('Paste Attributes', () => {
    for (const id of targetIds) {
      const c = s.clips[id];
      if (!c || (c.kind === 'audio') !== (sourceClip.kind === 'audio')) continue;
      const keepFixed = c.effects.filter((e) => EFFECTS[e.type].fixed && !sourceClip.effects.some((x) => x.type === e.type));
      c.effects = [...keepFixed, ...deepClone(sourceClip.effects).filter((e) => !EFFECTS[e.type].fixed || c.effects.some((x) => x.type === e.type))];
      for (const fx of c.effects) fx.id = uid('fx');
      // keep fixed effects first
      c.effects.sort((a, b) => (EFFECTS[b.type].fixed ? 1 : 0) - (EFFECTS[a.type].fixed ? 1 : 0));
    }
  });
}

// ---------------------------------------------------------------- clipboard

export function copySelection(cut = false) {
  const s = seq();
  const ids = [...withLinked(store.selection.clips)].filter((id) => s.clips[id]);
  if (!ids.length) return;
  const clips = ids.map((id) => deepClone(s.clips[id]));
  const base = Math.min(...clips.map((c) => c.start));
  store.ui.clipboard = { clips, base };
  if (cut) deleteSelection();
  store.toast(`${cut ? 'Cut' : 'Copied'} ${clips.length} clip(s)`);
}

export function paste({ insert = false } = {}) {
  const cb = store.ui.clipboard;
  if (!cb) return;
  const s = seq();
  const t = q(store.ui.playhead);
  const vt = targetTrack('video');
  const at = targetTrack('audio');
  const vIdx = videoTracks(s).indexOf(vt);
  const aIdx = audioTracks(s).indexOf(at);
  const minV = Math.min(...cb.clips.filter((c) => c.kind !== 'audio').map((c) => videoTracks(s).findIndex((x) => x.id === c.trackId)).filter((i) => i >= 0), Infinity);
  const minA = Math.min(...cb.clips.filter((c) => c.kind === 'audio').map((c) => audioTracks(s).findIndex((x) => x.id === c.trackId)).filter((i) => i >= 0), Infinity);
  store.transact(insert ? 'Paste Insert' : 'Paste', () => {
    const linkMap = new Map();
    const created = [];
    const span = Math.max(...cb.clips.map((c) => clipEnd(c))) - cb.base;
    if (insert) {
      splitAllAt(unlockedTrackIds(), t);
      rawRipple(unlockedTrackIds(), t, span);
    }
    for (const src of cb.clips) {
      const c = cloneClip(src);
      if (src.linkId) {
        if (!linkMap.has(src.linkId)) linkMap.set(src.linkId, uid('link'));
        c.linkId = linkMap.get(src.linkId);
      }
      const list = c.kind === 'audio' ? audioTracks(s) : videoTracks(s);
      const srcIdx = list.findIndex((x) => x.id === src.trackId);
      const off = srcIdx >= 0 ? srcIdx - (c.kind === 'audio' ? minA : minV) : 0;
      const baseIdx = c.kind === 'audio' ? aIdx : vIdx;
      const tr = list[clamp((baseIdx >= 0 ? baseIdx : 0) + (Number.isFinite(off) ? off : 0), 0, list.length - 1)];
      if (!tr || tr.locked) continue;
      c.trackId = tr.id;
      c.start = t + (src.start - cb.base);
      if (!insert) rawClearRange(tr.id, c.start, clipEnd(c));
      s.clips[c.id] = c;
      created.push(c.id);
    }
    store.selectClips(created);
    store.setPlayhead(t + span);
  });
}

// ---------------------------------------------------------------- sequences

export function newSequence({ name, width, height, fps } = {}) {
  const cur = seq();
  const s = createSequence({
    name: name || `Sequence ${String(Object.keys(store.project.sequences).length + 1).padStart(2, '0')}`,
    width: width || cur.width, height: height || cur.height, fps: fps || cur.fps,
  });
  store.transact('New Sequence', () => addSequenceToProject(store.project, s));
  store.openSequence(s.id);
  return s.id;
}

export function duplicateSequence(id = seq().id) {
  const src = store.project.sequences[id];
  if (!src) return null;
  const copy = deepClone(src);
  copy.id = uid('seq');
  copy.name = `${src.name} Copy`;
  // fresh ids, preserving links and track references
  const trackMap = new Map();
  for (const t of copy.tracks) {
    const nid = uid(t.kind === 'video' ? 'vt' : 'at');
    trackMap.set(t.id, nid);
    t.id = nid;
  }
  const linkMap = new Map();
  const clips = {};
  for (const c of Object.values(copy.clips)) {
    c.id = uid('clip');
    c.trackId = trackMap.get(c.trackId);
    if (c.linkId) {
      if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('link'));
      c.linkId = linkMap.get(c.linkId);
    }
    for (const fx of c.effects) fx.id = uid('fx');
    clips[c.id] = c;
  }
  copy.clips = clips;
  for (const mk of copy.markers) mk.id = uid('mk');
  store.transact('Duplicate Sequence', () => addSequenceToProject(store.project, copy));
  return copy.id;
}

export function deleteSequence(id) {
  const p = store.project;
  if (Object.keys(p.sequences).length <= 1) {
    store.toast('A project needs at least one sequence');
    return;
  }
  const mid = sequenceMediaId(id);
  store.transact('Delete Sequence', () => {
    for (const other of Object.values(p.sequences)) {
      for (const c of Object.values(other.clips)) if (c.mediaId === mid) delete other.clips[c.id];
    }
    delete p.sequences[id];
    delete p.media[mid];
    p.mediaOrder = p.mediaOrder.filter((x) => x !== mid);
    if (p.activeSequenceId === id) p.activeSequenceId = Object.keys(p.sequences)[0];
  });
  store.pruneSelection();
  store.emit('sequence');
}

/**
 * Nest: move the selected clips into a new sequence and replace them with a nested-sequence clip.
 */
export function nestSelection(name) {
  const s = seq();
  const ids = [...withLinked(store.selection.clips)].filter((id) => s.clips[id] && !isLocked(s.clips[id].trackId));
  if (!ids.length) {
    store.toast('Select clips to nest');
    return null;
  }
  const clips = ids.map((id) => s.clips[id]);
  const t0 = Math.min(...clips.map((c) => c.start));
  const t1 = Math.max(...clips.map(clipEnd));
  const vts = videoTracks(s);
  const ats = audioTracks(s);
  const usedV = clips.filter((c) => c.kind !== 'audio').map((c) => vts.findIndex((t) => t.id === c.trackId));
  const usedA = clips.filter((c) => c.kind === 'audio').map((c) => ats.findIndex((t) => t.id === c.trackId));
  const minV = usedV.length ? Math.min(...usedV) : 0;
  const minA = usedA.length ? Math.min(...usedA) : 0;
  const nested = createSequence({
    name: name || `Nested Sequence ${String(Object.keys(store.project.sequences).length).padStart(2, '0')}`,
    width: s.width, height: s.height, fps: s.fps,
    videoTracks: Math.max(3, (usedV.length ? Math.max(...usedV) - minV : 0) + 1),
    audioTracks: Math.max(3, (usedA.length ? Math.max(...usedA) - minA : 0) + 1),
  });
  const nvts = videoTracks(nested);
  const nats = audioTracks(nested);
  let nestId = null;
  store.transact('Nest', () => {
    for (const c of clips) {
      const copy = deepClone(c);
      copy.start = c.start - t0;
      copy.trackId = c.kind === 'audio'
        ? nats[ats.findIndex((t) => t.id === c.trackId) - minA].id
        : nvts[vts.findIndex((t) => t.id === c.trackId) - minV].id;
      nested.clips[copy.id] = copy;
      delete s.clips[c.id];
    }
    const mid = addSequenceToProject(store.project, nested);
    const m = store.project.media[mid];
    m.duration = t1 - t0;
    m.hasAudio = usedA.length > 0;
    const link = usedV.length && usedA.length ? uid('link') : null;
    const created = [];
    if (usedV.length) {
      const c = createClip(s, { kind: 'nest', trackId: vts[minV].id, mediaId: mid, name: nested.name, start: t0, duration: t1 - t0, linkId: link });
      s.clips[c.id] = c;
      created.push(c.id);
      nestId = c.id;
    }
    if (usedA.length) {
      const c = createClip(s, { kind: 'audio', trackId: ats[minA].id, mediaId: mid, name: nested.name, start: t0, duration: t1 - t0, linkId: link });
      s.clips[c.id] = c;
      created.push(c.id);
      nestId = nestId || c.id;
    }
    store.selectClips(created);
  });
  return nestId;
}

// ---------------------------------------------------------------- tracks

export function addTrack(kind) {
  const s = seq();
  store.transact(`Add ${kind === 'video' ? 'Video' : 'Audio'} Track`, () => {
    const t = createTrack(kind, 0);
    if (kind === 'video') {
      const lastVideoIdx = s.tracks.findLastIndex((x) => x.kind === 'video');
      s.tracks.splice(lastVideoIdx + 1, 0, t);
    } else s.tracks.push(t);
    renameTracks(s);
  });
}

export function deleteTrack(trackId) {
  const s = seq();
  const tr = getTrack(s, trackId);
  if (!tr) return;
  if ((tr.kind === 'video' ? videoTracks(s) : audioTracks(s)).length <= 1) {
    store.toast('A sequence needs at least one track of each kind');
    return;
  }
  store.transact('Delete Track', () => {
    for (const c of clipsOnTrack(s, trackId)) delete s.clips[c.id];
    s.tracks = s.tracks.filter((t) => t.id !== trackId);
    renameTracks(s);
  });
}

export function setTrackFlag(trackId, flag, value) {
  const s = seq();
  store.transact('Track Setting', () => {
    const tr = getTrack(s, trackId);
    if (tr) tr[flag] = value ?? !tr[flag];
  });
}

export function setTrackValue(trackId, key, value) {
  const tr = getTrack(seq(), trackId);
  if (tr) tr[key] = value;
}

// ---------------------------------------------------------------- markers / in-out

export function addMarker(t = store.ui.playhead, props = {}) {
  const s = seq();
  t = q(t);
  if (s.markers.some((m) => Math.abs(m.time - t) < EPS)) return;
  store.transact('Add Marker', () => {
    s.markers.push({ id: uid('mk'), time: t, name: props.name || `Marker ${s.markers.length + 1}`, color: props.color || '#4ade80', comment: props.comment || '' });
    s.markers.sort((a, b) => a.time - b.time);
  });
}

export function removeMarker(id) {
  store.transact('Delete Marker', () => {
    seq().markers = seq().markers.filter((m) => m.id !== id);
  });
}

export function setSequenceInOut(which, t) {
  const s = seq();
  store.transact(which === 'in' ? 'Mark In' : 'Mark Out', () => {
    if (which === 'in') {
      s.inPoint = t == null ? null : q(t);
      if (s.inPoint != null && s.outPoint != null && s.outPoint <= s.inPoint) s.outPoint = null;
    } else {
      s.outPoint = t == null ? null : q(t);
      if (s.inPoint != null && s.outPoint != null && s.outPoint <= s.inPoint) s.inPoint = null;
    }
  });
}

export function markClip() {
  const s = seq();
  const t = store.ui.playhead;
  const tracks = s.tracks.filter((tr) => tr.targeted).map((tr) => tr.id);
  const c = store.selectedClips()[0] || Object.values(s.clips).find((x) => tracks.includes(x.trackId) && x.start <= t && clipEnd(x) > t);
  if (!c) return;
  store.transact('Mark Clip', () => {
    s.inPoint = c.start;
    s.outPoint = clipEnd(c);
  });
}

export function selectAll() {
  store.selectClips(Object.keys(seq().clips));
}

/** Track-select-forward: everything at/after t on one track (or on all tracks). */
export function selectForward(t, trackId = null) {
  const ids = Object.values(seq().clips).filter((c) => clipEnd(c) > t + EPS && (!trackId || c.trackId === trackId)).map((c) => c.id);
  store.selectClips([...withLinked(ids)]);
}

// ---------------------------------------------------------------- sequence settings

export function updateSequenceSettings({ width, height, fps, name }) {
  const s = seq();
  store.transact('Sequence Settings', () => {
    const sx = width / s.width;
    const sy = height / s.height;
    if (name) s.name = name;
    s.width = width;
    s.height = height;
    s.fps = fps;
    // keep relative positions of motion params
    for (const c of Object.values(s.clips)) {
      const motion = c.effects.find((e) => e.type === 'motion');
      if (!motion) continue;
      const px = motion.params.posX;
      const py = motion.params.posY;
      px.value *= sx;
      py.value *= sy;
      if (px.kf) for (const k of px.kf) k.v *= sx;
      if (py.kf) for (const k of py.kf) k.v *= sy;
    }
  });
}

export function closeAllGaps() {
  const s = seq();
  store.transact('Close Gaps', () => {
    for (const tr of s.tracks.filter((t) => !t.locked)) {
      let cursor = 0;
      for (const c of clipsOnTrack(s, tr.id)) {
        if (c.start > cursor + EPS) c.start = cursor;
        cursor = clipEnd(c);
      }
    }
  });
}

export { sequenceDuration, prevAdjacent, linkedClips, trackKindForClip };

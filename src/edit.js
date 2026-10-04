// Editing operations on the active sequence. Every exported function performs one undoable step
// via store.transact unless noted ("raw" helpers mutate without a transaction).

import { store } from './store.js';
import { uid, EPS, clamp, snapFrame, deepClone } from './util.js';
import {
  setParamValue, mediaTimeAt, contentTime, sourceOut, remapSpeedAt, createClip, createTrack, clipEnd, clipsOnTrack, linkedClips, getTrack, videoTracks, audioTracks,
  sequenceDuration, prevAdjacent, nextAdjacent, shiftClipKeyframes, scaleClipKeyframes, renameTracks,
  clampTransitionDuration, trackKindForClip, DEFAULT_STILL_DURATION, createEffect, isTimed,
  addSequenceToProject, createSequence, sequenceContains, sequenceMediaId,
} from './model.js';
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_VIDEO_TRANSITION, TRANSITIONS, EFFECTS, effectFitsClip } from './effects.js';

const seq = () => store.seq;
const media = (id) => store.project.media[id];
const fd = () => 1 / seq().fps;
const q = (t) => snapFrame(t, seq().fps);

// ---------------------------------------------------------------- raw helpers

/** In point of the part of clip `c` that starts `cut` seconds into it (speed, remap, reverse aware). */
function inPointAfterCut(c, cut) {
  if (c.hold) return c.inPoint;
  if (c.reverse) return c.inPoint; // reversed: inPoint is the media time at the clip's end
  return mediaTimeAt(c, c.start + cut);
}

/** In point of the left part of a reversed clip cut `cut` seconds in (its end now shows later media). */
function reverseLeftInPoint(c, cut) {
  return c.inPoint + contentTime(c, c.duration) - contentTime(c, cut);
}

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
      right.inPoint = inPointAfterCut(c, cut);
      shiftClipKeyframes(right, -cut);
      right.transIn = null;
      if (c.reverse) c.inPoint = reverseLeftInPoint(c, t0 - c.start);
      c.duration = t0 - c.start;
      c.transOut = null;
      s.clips[right.id] = right;
    } else if (c.start < t0) {
      if (c.reverse) c.inPoint = reverseLeftInPoint(c, t0 - c.start);
      c.duration = t0 - c.start;
      c.transOut = null;
    } else {
      const cut = t1 - c.start;
      c.inPoint = inPointAfterCut(c, cut);
      c.start = t1;
      c.duration = ce - t1;
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
  right.inPoint = inPointAfterCut(c, cut);
  right.transIn = null;
  shiftClipKeyframes(right, -cut);
  if (c.reverse) c.inPoint = reverseLeftInPoint(c, cut);
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
  if (m.kind === 'lut') {
    store.toast('LUT 파일은 타임라인에 놓지 않습니다. 클립을 선택한 뒤 프로젝트 패널에서 LUT를 오른쪽 클릭 ▸ 선택한 클립에 LUT 적용을 누르세요.');
    return [];
  }
  const s = seq();
  if (m.kind === 'sequence' && sequenceContains(store.project, m.sequenceId, s.id)) {
    store.toast('시퀀스를 자기 자신 안에 중첩할 수 없습니다');
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
    store.toast('대상 트랙이 잠겨 있습니다');
    return [];
  }
  if (!vTrack && !aTrack) return [];

  return store.transact(mode === 'insert' ? '삽입' : '덮어쓰기', () => {
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
  return store.transact('새 텍스트', () => {
    if (!track) {
      track = createTrack('video', videoTracks(s).length);
      const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
      s.tracks.splice(lastVideoIdx + 1, 0, track);
      renameTracks(s);
    }
    const c = createClip(s, { kind: 'text', trackId: track.id, name: content ? String(content).split('\n')[0].slice(0, 40) : '텍스트', start, duration: dur });
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
  return store.transact('새 도형', () => {
    if (!track) {
      track = createTrack('video', videoTracks(s).length);
      const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
      s.tracks.splice(lastVideoIdx + 1, 0, track);
      renameTracks(s);
    }
    const c = createClip(s, { kind: 'shape', trackId: track.id, name: { rectangle: '사각형', ellipse: '타원', triangle: '삼각형', line: '선' }[shape] || '도형', start, duration: dur });
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
    store.transact('전환 지우기', () => {
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
    store.transact('빈자리 잔물결 삭제', () => rawRipple(empty, end - EPS, -(end - start)));
    store.selection.gap = null;
    store.emit('selection');
    return;
  }
  const ids = [...withLinked(sel.clips)].filter((id) => s.clips[id] && !isLocked(s.clips[id].trackId));
  if (!ids.length) return;
  store.transact(ripple ? '잔물결 삭제' : '지우기', () => {
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
    store.toast('먼저 시퀀스 시작/끝을 표시하세요 (I / O 키)');
    return;
  }
  const tracks = s.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id);
  const all = unlockedTrackIds();
  store.transact(extract ? '추출' : '들어올리기', () => {
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
  store.transact('편집점 추가', () => {
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
  // seconds of source per timeline second at the clip's head and tail
  const rateIn = Math.max(1e-3, c.speed * remapSpeedAt(c, 0));
  const rateOut = Math.max(1e-3, c.speed * remapSpeedAt(c, c.duration));
  const srcOut = sourceOut(c);
  if (edge === 'in') {
    max = c.duration - f; // keep at least one frame
    if (bounded) {
      // extending the head reveals earlier media (or later media for reversed clips)
      min = Math.max(min, c.reverse ? -(m.duration - (c.inPoint + contentTime(c, c.duration))) / rateIn : -c.inPoint / rateIn);
    }
    if (!ripple) min = Math.max(min, -c.start);
    if (!ripple && !rolling) {
      const prev = clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start + EPS).pop();
      if (prev) min = Math.max(min, prev ? clipEnd(prev) - c.start : min);
    }
  } else {
    min = -(c.duration - f);
    if (bounded) max = Math.min(max, c.reverse ? c.inPoint / rateOut : (m.duration - srcOut) / rateOut);
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
    if (!c.hold && !c.reverse) c.inPoint = mediaTimeAt(c, c.start + delta);
    c.start += delta;
    c.duration -= delta;
    shiftClipKeyframes(c, -delta);
  } else {
    if (c.reverse && !c.hold) c.inPoint += contentTime(c, c.duration) - contentTime(c, c.duration + delta);
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
  store.transact(which === 'prev' ? '앞쪽 잔물결 트림' : '뒤쪽 잔물결 트림', () => {
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

export function setSpeed(ids, { speed, duration, ripple = false, hold, reverse, maintainPitch }) {
  const s = seq();
  store.transact('속도/지속 시간', () => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c) continue;
      const oldDur = c.duration;
      if (isTimed(c)) {
        // frame hold only applies to pictures; linked audio keeps playing normally
        if (hold != null) c.hold = !!hold && c.kind === 'video';
        if (reverse != null) c.reverse = !!reverse;
        if (maintainPitch != null) c.maintainPitch = !!maintainPitch;
        const newSpeed = speed ?? c.speed;
        let newDur = duration ?? (c.duration * c.speed) / newSpeed;
        const m = media(c.mediaId);
        if (m && Number.isFinite(m.duration) && !c.hold) newDur = Math.min(newDur, (m.duration - c.inPoint) / newSpeed);
        scaleClipKeyframes(c, newDur / c.duration);
        c.speed = newSpeed;
        c.duration = Math.max(fd(), q(newDur));
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

/** Toggle reverse playback per clip, keeping each clip's own speed. */
export function toggleReverse(ids) {
  const s = seq();
  const clips = ids.map((id) => s.clips[id]).filter((c) => c && isTimed(c));
  if (!clips.length) return;
  const to = !clips[0].reverse;
  store.transact('역재생', () => {
    for (const c of clips) setSpeed([c.id], { speed: c.speed, reverse: to });
  });
}

/** Add Frame Hold: split at the playhead and freeze the frame there for the rest of the clip. */
export function addFrameHold(c, t = store.ui.playhead) {
  if (c.kind !== 'video') return;
  store.transact('프레임 고정', () => {
    const at = q(t);
    const target = at > c.start + EPS ? rawSplit(c, at) || c : c;
    target.hold = true;
    target.name = `${c.name} (고정)`;
  });
}

/** Normalize clip volume so the loudest peak in the used range hits targetDb. */
export function normalizeAudio(ids, peakFn, targetDb = -1) {
  const s = seq();
  let changed = 0;
  store.transact('오디오 노멀라이즈', () => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c || c.kind !== 'audio') continue;
      const a = c.inPoint;
      const b = sourceOut(c);
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
  store.transact('장면 전환 감지', () => {
    for (const t of [...times].sort((a, b) => b - a)) {
      const c = Object.values(s.clips).find((x) => (x.id === clipId || (s.clips[clipId]?.linkId && x.linkId === s.clips[clipId].linkId)) && x.start < t - EPS && clipEnd(x) > t + EPS);
      if (!c) continue;
      splitGroup(linkedClips(s, c).filter((x) => x.start < t - EPS && clipEnd(x) > t + EPS), t);
    }
  });
}

export function setEnabled(ids, enabled) {
  const s = seq();
  store.transact(enabled ? '클립 사용' : '클립 사용 안 함', () => {
    for (const id of withLinked(ids)) if (s.clips[id]) s.clips[id].enabled = enabled ?? !s.clips[id].enabled;
  });
}

export function linkClips(ids) {
  const s = seq();
  const clips = ids.map((id) => s.clips[id]).filter(Boolean);
  if (clips.length < 2) return;
  store.transact('연결', () => {
    const l = uid('link');
    for (const c of clips) c.linkId = l;
  });
}

export function unlinkClips(ids) {
  const s = seq();
  store.transact('연결 해제', () => {
    for (const id of withLinked(ids)) if (s.clips[id]) s.clips[id].linkId = null;
  });
}

export function renameClip(id, name) {
  store.transact('이름 바꾸기', () => {
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
    store.toast(`${def?.name || '이 전환'}은(는) ${def?.kind === 'audio' ? '오디오' : '영상'} 클립에만 적용할 수 있습니다`);
    return;
  }
  store.transact(`${def.name} 적용`, () => {
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
  store.transact('기본 전환 적용', () => {
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
  store.transact(`${def.name} 추가`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || !effectFitsClip(type, c.kind)) continue;
      c.effects.push(createEffect(type, s));
    }
  });
}

export function removeEffect(clipId, fxId) {
  store.transact('효과 제거', () => {
    const c = seq().clips[clipId];
    if (c) c.effects = c.effects.filter((e) => e.id !== fxId || EFFECTS[e.type].fixed);
  });
}

export function moveEffect(clipId, fxId, dir) {
  store.transact('효과 순서 변경', () => {
    const c = seq().clips[clipId];
    const i = c.effects.findIndex((e) => e.id === fxId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.effects.length || EFFECTS[c.effects[j].type].fixed) return;
    [c.effects[i], c.effects[j]] = [c.effects[j], c.effects[i]];
  });
}

export function resetEffect(clipId, fxId) {
  const s = seq();
  store.transact('효과 초기화', () => {
    const c = s.clips[clipId];
    const fx = c?.effects.find((e) => e.id === fxId);
    if (!fx) return;
    const fresh = createEffect(fx.type, s);
    fx.params = fresh.params;
  });
}

/** Keep the time remapping of linked clips (video + its audio) identical. Raw: caller wraps. */
export function rawSyncLinkedRemap(clipId) {
  const s = seq();
  const c = s.clips[clipId];
  const src = c?.effects.find((e) => e.type === 'timeRemap');
  if (!src) return;
  for (const o of linkedClips(s, c)) {
    if (o.id === c.id) continue;
    const dst = o.effects.find((e) => e.type === 'timeRemap');
    if (!dst) continue;
    dst.enabled = src.enabled;
    dst.params.speed = deepClone(src.params.speed);
  }
}

/** Apply a saved effect preset ({type, enabled, params}) to clips. Returns the number of clips changed. */
export function applyEffectPreset(clipIds, preset) {
  const s = seq();
  const def = EFFECTS[preset.type];
  if (!def) return 0;
  let n = 0;
  store.transact(`프리셋 적용: ${preset.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || !effectFitsClip(preset.type, c.kind)) continue;
      let fx = def.fixed ? c.effects.find((e) => e.type === preset.type) : null;
      if (def.fixed && !fx) continue;
      if (!fx) {
        fx = createEffect(preset.type, s);
        c.effects.push(fx);
      }
      for (const [k, p] of Object.entries(preset.params || {})) {
        if (fx.params[k]) fx.params[k] = deepClone(p);
      }
      fx.enabled = preset.enabled !== false;
      if (preset.type === 'timeRemap') rawSyncLinkedRemap(c.id);
      n++;
    }
  });
  return n;
}

/** Copy effects from one clip to others (Paste Attributes). */
export function pasteAttributes(sourceClip, targetIds) {
  const s = seq();
  // fixed effects that carry "look" rather than content are replaced; added effects are appended
  const REPLACEABLE = new Set(['motion', 'opacity', 'timeRemap', 'volume', 'panner']);
  store.transact('특성 붙여넣기', () => {
    for (const id of targetIds) {
      const c = s.clips[id];
      if (!c || id === sourceClip.id || (c.kind === 'audio') !== (sourceClip.kind === 'audio')) continue;
      const src = deepClone(sourceClip.effects);
      c.effects = c.effects.map((e) => {
        if (!REPLACEABLE.has(e.type)) return e;
        const m = src.find((x) => x.type === e.type);
        return m ? { ...m, id: e.id } : e;
      });
      for (const e of src) {
        if (EFFECTS[e.type]?.fixed || !effectFitsClip(e.type, c.kind)) continue;
        c.effects.push({ ...e, id: uid('fx') });
      }
      rawSyncLinkedRemap(c.id);
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
  store.toast(`클립 ${clips.length}개를 ${cut ? '잘라냈습니다' : '복사했습니다'}`);
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
  store.transact(insert ? '삽입하며 붙여넣기' : '붙여넣기', () => {
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
    name: name || `시퀀스 ${String(Object.keys(store.project.sequences).length + 1).padStart(2, '0')}`,
    width: width || cur.width, height: height || cur.height, fps: fps || cur.fps,
  });
  store.transact('새 시퀀스', () => addSequenceToProject(store.project, s));
  store.openSequence(s.id);
  return s.id;
}

export function duplicateSequence(id = seq().id) {
  const src = store.project.sequences[id];
  if (!src) return null;
  const copy = deepClone(src);
  copy.id = uid('seq');
  copy.name = `${src.name} 복사본`;
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
  store.transact('시퀀스 복제', () => addSequenceToProject(store.project, copy));
  return copy.id;
}

export function deleteSequence(id) {
  const p = store.project;
  if (Object.keys(p.sequences).length <= 1) {
    store.toast('프로젝트에는 시퀀스가 하나 이상 있어야 합니다');
    return;
  }
  const mid = sequenceMediaId(id);
  store.transact('시퀀스 삭제', () => {
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
    store.toast('중첩할 클립을 선택하세요');
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
    name: name || `중첩 시퀀스 ${String(Object.keys(store.project.sequences).length).padStart(2, '0')}`,
    width: s.width, height: s.height, fps: s.fps,
    videoTracks: Math.max(3, (usedV.length ? Math.max(...usedV) - minV : 0) + 1),
    audioTracks: Math.max(3, (usedA.length ? Math.max(...usedA) - minA : 0) + 1),
  });
  const nvts = videoTracks(nested);
  const nats = audioTracks(nested);
  let nestId = null;
  store.transact('중첩', () => {
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
  store.transact(`${kind === 'video' ? '비디오' : '오디오'} 트랙 추가`, () => {
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
    store.toast('비디오·오디오 트랙은 각각 하나 이상 있어야 합니다');
    return;
  }
  store.transact('트랙 삭제', () => {
    for (const c of clipsOnTrack(s, trackId)) delete s.clips[c.id];
    s.tracks = s.tracks.filter((t) => t.id !== trackId);
    renameTracks(s);
  });
}

export function setTrackFlag(trackId, flag, value) {
  const s = seq();
  store.transact('트랙 설정', () => {
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
  store.transact('마커 추가', () => {
    s.markers.push({ id: uid('mk'), time: t, name: props.name || `마커 ${s.markers.length + 1}`, color: props.color || '#4ade80', comment: props.comment || '' });
    s.markers.sort((a, b) => a.time - b.time);
  });
}

export function removeMarker(id) {
  store.transact('마커 삭제', () => {
    seq().markers = seq().markers.filter((m) => m.id !== id);
  });
}

export function setSequenceInOut(which, t) {
  const s = seq();
  store.transact(which === 'in' ? '시작 표시' : '끝 표시', () => {
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
  store.transact('클립 범위 표시', () => {
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
  store.transact('시퀀스 설정', () => {
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
  store.transact('빈자리 닫기', () => {
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

// ---------------------------------------------------------------- labels

export function setLabel(ids, color) {
  const s = seq();
  store.transact('레이블 색상', () => {
    for (const id of ids) if (s.clips[id]) s.clips[id].label = color || null;
  });
}

// ---------------------------------------------------------------- multicam

/**
 * Build a multicam source sequence: one angle per video track (V1 = 앵글 1), audio of every
 * angle on its own track with only angle 1 audible. offsets: seconds each angle starts later.
 */
export function createMulticamSequence(mediaIds, offsets, { name, place = true } = {}) {
  const p = store.project;
  const first = p.media[mediaIds[0]];
  const cur = seq();
  const mc = createSequence({
    name: name || `멀티캠 ${Object.values(p.sequences).filter((x) => x.multicam).length + 1}`,
    width: first?.width ? Math.round(first.width / 2) * 2 : cur.width,
    height: first?.height ? Math.round(first.height / 2) * 2 : cur.height,
    fps: first?.fps ? Math.round(first.fps * 1000) / 1000 : cur.fps,
    videoTracks: Math.max(1, mediaIds.length),
    audioTracks: Math.max(1, mediaIds.length),
  });
  mc.multicam = true;
  const minOff = Math.min(...offsets);
  const vts = videoTracks(mc);
  const ats = audioTracks(mc);
  mediaIds.forEach((mid, i) => {
    const m = p.media[mid];
    if (!m) return;
    const start = offsets[i] - minOff;
    const dur = m.duration ?? DEFAULT_STILL_DURATION;
    const link = m.hasAudio ? uid('link') : null;
    const v = createClip(mc, { kind: 'video', trackId: vts[i].id, mediaId: mid, name: m.name, start, duration: dur, linkId: link });
    mc.clips[v.id] = v;
    if (m.hasAudio) {
      const a = createClip(mc, { kind: 'audio', trackId: ats[i].id, mediaId: mid, name: m.name, start, duration: dur, linkId: link });
      mc.clips[a.id] = a;
    }
    vts[i].name = `V${i + 1}`;
    ats[i].muted = i > 0;
  });
  let mid = null;
  store.transact('멀티캠 소스 시퀀스 만들기', () => {
    mid = addSequenceToProject(p, mc);
  });
  if (place) {
    const ids = placeMedia(mid, { mode: 'overwrite' });
    store.transact('멀티캠 사용', () => {
      for (const id of ids) {
        const c = seq().clips[id];
        if (c?.kind === 'nest') c.multicam = { angle: 1 };
      }
    });
  }
  return mc.id;
}

/** Find the multicam nest clip at the playhead (targeted video tracks first). */
export function multicamClipAt(t = store.ui.playhead) {
  const s = seq();
  const isMc = (c) => c.kind === 'nest' && c.multicam && store.project.sequences[store.project.media[c.mediaId]?.sequenceId]?.multicam;
  const tracks = videoTracks(s);
  const order = [...tracks.filter((tr) => tr.targeted), ...tracks.filter((tr) => !tr.targeted)];
  for (const tr of order) {
    const c = clipsOnTrack(s, tr.id).find((x) => x.start <= t + EPS && clipEnd(x) > t + EPS && isMc(x));
    if (c) return c;
  }
  return null;
}

/** Switch angle: while playing, cut at the playhead and switch the rest; while paused, switch the segment. */
export function switchAngle(n, { cut = null } = {}) {
  const s = seq();
  const c = multicamClipAt();
  if (!c) {
    store.toast('재생헤드 아래에 멀티캠 클립이 없습니다');
    return;
  }
  const inner = store.project.sequences[store.project.media[c.mediaId].sequenceId];
  if (n > videoTracks(inner).length) {
    store.toast(`앵글 ${n}이(가) 없습니다`);
    return;
  }
  const t = q(store.ui.playhead);
  const doCut = !!cut;
  store.transact(`앵글 ${n}(으)로 전환`, () => {
    let target = c;
    if (doCut && t > c.start + EPS && t < clipEnd(c) - EPS) {
      const rights = splitGroup(linkedClips(s, c).filter((x) => x.start < t - EPS && clipEnd(x) > t + EPS), t);
      target = rights.find((x) => x.kind === 'nest') || c;
    }
    target.multicam = { angle: n };
  });
}

// ---------------------------------------------------------------- auto ducking

/**
 * Lower music clips while speech is present on other tracks.
 * activity(t) -> boolean says whether speech is audible at sequence time t.
 */
export function autoDuck(musicIds, intervals, { duckDb = -15, fadeIn = 0.3, fadeOut = 0.6 } = {}) {
  const s = seq();
  let changed = 0;
  store.transact('자동 더킹', () => {
    for (const id of musicIds) {
      const c = s.clips[id];
      const vol = c?.effects.find((e) => e.type === 'volume');
      if (!vol) continue;
      const base = vol.params.level.kf?.length ? Math.max(...vol.params.level.kf.map((k) => k.v)) : vol.params.level.value;
      const low = clamp(base + duckDb, -60, 15);
      const keys = [];
      for (const [a, b] of intervals) {
        if (b <= c.start || a >= clipEnd(c)) continue;
        const pts = [[a - fadeIn, base], [a, low], [b, low], [b + fadeOut, base]];
        for (const [t, v] of pts) keys.push({ t: clamp(t - c.start, 0, c.duration), v, ease: 'linear' });
      }
      if (!keys.length) continue;
      keys.sort((x, y) => x.t - y.t);
      // collapse keys on the same frame, keeping the lower level (overlapping ducks)
      const merged = [];
      for (const k of keys) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.t - k.t) < 1 / s.fps) last.v = Math.min(last.v, k.v);
        else merged.push(k);
      }
      if (merged[0].t > 0) merged.unshift({ t: 0, v: base, ease: 'linear' });
      vol.params.level.kf = merged;
      changed++;
    }
  });
  return changed;
}

// ---------------------------------------------------------------- auto reframe

/** Duplicate the active sequence at a new frame size; visual clips are re-scaled to fill (centre crop). */
export function autoReframe(width, height, name) {
  const srcId = seq().id;
  const newId = duplicateSequence(srcId);
  if (!newId) return null;
  store.openSequence(newId);
  updateSequenceSettings({ width, height, fps: seq().fps, name: name || `${seq().name} (${width}×${height})` });
  const s = seq();
  store.transact('자동 리프레임', () => {
    for (const c of Object.values(s.clips)) {
      const motion = c.effects.find((e) => e.type === 'motion');
      if (!motion) continue;
      const m = c.mediaId ? store.project.media[c.mediaId] : null;
      if ((c.kind === 'video' || c.kind === 'image' || c.kind === 'nest') && m?.width) {
        const fit = Math.min(width / m.width, height / m.height);
        const fill = Math.max(width / m.width, height / m.height);
        const factor = fill / fit;
        const p = motion.params.scale;
        p.value = Math.round(p.value * factor * 10) / 10;
        if (p.kf) for (const k of p.kf) k.v = Math.round(k.v * factor * 10) / 10;
      }
    }
  });
  return newId;
}

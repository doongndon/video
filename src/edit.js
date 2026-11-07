// Editing operations on the active sequence. Every exported function performs one undoable step
// via store.transact unless noted ("raw" helpers mutate without a transaction).

import { store } from './store.js';
import { uid, EPS, clamp, snapFrame, deepClone } from './util.js';
import {
  setParamValue, isAnimated, evalParam, mediaTimeAt, contentTime, sourceOut, remapSpeedAt, createClip, createTrack, clipEnd, clipsOnTrack, linkedClips, getTrack, videoTracks, audioTracks,
  sequenceDuration, prevAdjacent, nextAdjacent, shiftClipKeyframes, scaleClipKeyframes, renameTracks,
  clampTransitionDuration, trackKindForClip, DEFAULT_STILL_DURATION, createEffect, isTimed,
  addSequenceToProject, createSequence, sequenceContains, sequenceMediaId, newKey, scaleParamValues, remapIntegral,
} from './model.js';
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_VIDEO_TRANSITION, TRANSITIONS, EFFECTS, effectFitsClip, fixedEffectsFor } from './effects.js';

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
  // clip markers are found by id (marker dialog, delete): a copy gets its own
  for (const mk of copy.markers || []) mk.id = uid('mk');
  return Object.assign(copy, overrides);
}

/**
 * After cutting clip `left` at `cut` seconds (clip-local) into `right` (whose markers were already
 * shifted by -cut), each half keeps the clip markers on its own side of the cut.
 */
function splitClipMarkers(left, right, cut) {
  if (left.markers?.length) left.markers = left.markers.filter((mk) => mk.time < cut - EPS);
  if (right.markers?.length) right.markers = right.markers.filter((mk) => mk.time >= -EPS);
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
      splitClipMarkers(c, right, t0 - c.start);
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
  // never leave a sliver shorter than half a frame (e.g. at the un-rounded end of a media file)
  if (t <= c.start + fd() / 2 || t >= clipEnd(c) - fd() / 2) return null;
  const right = cloneClip(c);
  const cut = t - c.start;
  right.start = t;
  right.duration = clipEnd(c) - t;
  right.inPoint = inPointAfterCut(c, cut);
  right.transIn = null;
  shiftClipKeyframes(right, -cut);
  splitClipMarkers(c, right, cut);
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
  // a subclip (하위 클립) places its master clip, kept inside the subclip's range
  if (m.subclipOf && media(m.subclipOf)) {
    const lo = m.subIn ?? 0;
    const hi = m.subOut ?? media(m.subclipOf).duration;
    const inP = clamp(opts.inPoint ?? m.inPoint ?? lo, lo, hi);
    const ids = placeMedia(m.subclipOf, { ...opts, inPoint: inP, outPoint: clamp(opts.outPoint ?? m.outPoint ?? hi, inP, hi) });
    for (const id of ids) {
      const c = seq().clips[id];
      if (c) Object.assign(c, { name: m.name, subclip: { id: m.id, in: lo, out: hi, restrict: m.restrictTrims !== false } });
    }
    if (ids.length) store.changed();
    return ids;
  }
  if (m.kind === 'font') {
    store.toast('글꼴 파일은 타임라인에 놓지 않습니다. 텍스트 클립을 선택하고 효과 컨트롤 ▸ 글꼴에서 고르세요.');
    return [];
  }
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
  // clip lengths are whole frames, so later edits at frame positions never leave slivers
  const duration = Math.max(fd(), q(outPoint - inPoint));
  const wantVideo = opts.video !== false && m.kind !== 'audio';
  const wantAudio = opts.audio !== false && (m.kind === 'audio' || ((m.kind === 'video' || m.kind === 'sequence') && m.hasAudio));

  // explicit tracks (drag and drop) win; otherwise the source patching decides (Premiere's V1 / A1 source indicators)
  const vTrack = wantVideo ? getTrack(s, opts.vTrackId) || (opts.aTrackId && !opts.vTrackId ? targetTrack('video') : sourceTrack('video')) : null;
  const aTrack = wantAudio ? getTrack(s, opts.aTrackId) || (opts.vTrackId && !opts.aTrackId ? targetTrack('audio') : sourceTrack('audio')) : null;
  const wasEmpty = !Object.keys(s.clips).length;
  if ((vTrack && vTrack.locked) || (aTrack && aTrack.locked)) {
    store.toast('대상 트랙이 잠겨 있습니다');
    return [];
  }
  if (!vTrack && !aTrack) {
    if (wantVideo || wantAudio) store.toast('넣을 트랙이 없습니다: 트랙 머리글의 소스 패치(V1·A1 표시)가 꺼져 있거나 트랙이 잠겨 있습니다');
    return [];
  }

  const created = store.transact(mode === 'insert' ? '삽입' : '덮어쓰기', () => {
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
      applyMediaScaling(c, s);
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
  // 클립 불일치 경고: the first clip in an empty sequence has another frame size or frame rate
  if (wasEmpty && created.length && opts.checkMismatch !== false && clipMismatch(m, s)) store.emit('clip-mismatch', { mediaId, sequenceId: s.id });
  return created;
}

/** True when video media differs from the sequence in frame size or frame rate. */
export function clipMismatch(m, s = seq()) {
  if (!m || m.kind !== 'video' || !m.width || !m.height) return false;
  const w = Math.round(m.width / 2) * 2;
  const h = Math.round(m.height / 2) * 2;
  return w !== s.width || h !== s.height || (m.fps > 0 && Math.abs(m.fps - s.fps) > 0.01);
}

/** Track targeting: the targeted (or first unlocked) track of a kind; used by paste and similar edits. */
export function targetTrack(kind) {
  const s = seq();
  const list = kind === 'video' ? videoTracks(s) : audioTracks(s);
  return list.find((t) => t.targeted && !t.locked) || list.find((t) => !t.locked) || null;
}

/**
 * Source patching: the track that insert / overwrite from the source put this kind on. Sequences
 * without patch flags (older projects) fall back to track targeting. Returns null when the kind's
 * source indicator is switched off.
 */
export function sourceTrack(kind) {
  const s = seq();
  const list = kind === 'video' ? videoTracks(s) : audioTracks(s);
  if (s.patchOff?.[kind]) return null;
  const patched = list.find((t) => t.patched);
  if (patched) return patched.locked ? null : patched;
  return targetTrack(kind);
}

/** Move the source patch of a kind to a track; patching the patched track again switches the kind off. */
export function setSourcePatch(trackId) {
  const s = seq();
  const tr = getTrack(s, trackId);
  if (!tr) return;
  store.transact('소스 패치', () => {
    const list = tr.kind === 'video' ? videoTracks(s) : audioTracks(s);
    s.patchOff = s.patchOff || {};
    if (tr.patched && !s.patchOff[tr.kind]) s.patchOff[tr.kind] = true;
    else {
      for (const t of list) t.patched = t.id === tr.id;
      s.patchOff[tr.kind] = false;
    }
  });
}

/** Create a text clip at the playhead on the first free video track. */
export function addTextClip({ start = store.ui.playhead, x, y, content, point = false } = {}) {
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
    const tp = c.effects.find((e) => e.type === 'text').params;
    if (content) tp.content.value = content;
    if (point) {
      // a click with the type tool: left-aligned text whose first line starts at the click, as in Premiere
      tp.point.value = true;
      tp.align.value = 'left';
    }
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
export function addEdit({ allTracks = false, t = store.ui.playhead, clipIds = null, linked = true } = {}) {
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
  const ids = targets.map((c) => c.id);
  targets = [...(linked ? withLinked(ids) : new Set(ids))].map((id) => s.clips[id]).filter((c) => c && !isLocked(c.trackId) && c.start < t - EPS && clipEnd(c) > t + EPS);
  if (!targets.length) return;
  store.transact('편집점 추가', () => {
    const groups = new Map();
    for (const c of targets) {
      // a cut of only one side of a linked pair (Alt+razor) leaves both halves linked to the other side
      const key = linked ? c.linkId || c.id : c.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const g of groups.values()) {
      if (linked) splitGroup(g, t);
      else for (const c of g) rawSplit(c, t);
    }
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
    const groupMap = new Map();
    targets = plan.map((p) => {
      const copy = cloneClip(p.c);
      if (p.c.linkId) {
        if (!linkMap.has(p.c.linkId)) linkMap.set(p.c.linkId, uid('link'));
        copy.linkId = linkMap.get(p.c.linkId);
      }
      // copies of grouped clips form their own group
      if (p.c.groupId) {
        if (!groupMap.has(p.c.groupId)) groupMap.set(p.c.groupId, uid('grp'));
        copy.groupId = groupMap.get(p.c.groupId);
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
  // clips from a subclip (하위 클립) are kept inside the subclip's range
  const lo = c.subclip?.restrict ? c.subclip.in : 0;
  const hi = c.subclip?.restrict ? Math.min(c.subclip.out, m?.duration ?? Infinity) : m?.duration;
  if (edge === 'in') {
    max = c.duration - f; // keep at least one frame
    if (bounded) {
      // extending the head reveals earlier media (or later media for reversed clips)
      min = Math.max(min, c.reverse ? -(hi - (c.inPoint + contentTime(c, c.duration))) / rateIn : -(c.inPoint - lo) / rateIn);
    }
    if (!ripple) min = Math.max(min, -c.start);
    if (!ripple && !rolling) {
      const prev = clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start + EPS).pop();
      if (prev) min = Math.max(min, prev ? clipEnd(prev) - c.start : min);
    }
  } else {
    min = -(c.duration - f);
    if (bounded) max = Math.min(max, c.reverse ? (c.inPoint - lo) / rateOut : (hi - srcOut) / rateOut);
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
        if (hold != null) {
          if (!!hold && c.kind === 'video' && !c.hold) c.holdTime = mediaTimeAt(c, c.start);
          c.hold = !!hold && c.kind === 'video';
          if (!c.hold) delete c.holdTime;
        }
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

/** Media time a clip shows at sequence time t when it is not frame-held. */
function liveMediaTime(c, t) {
  const hold = c.hold;
  c.hold = false;
  const v = mediaTimeAt(c, t);
  c.hold = hold;
  return v;
}

/** 프레임 고정 추가: split at the playhead and freeze the frame there for the rest of the clip. */
export function addFrameHold(c, t = store.ui.playhead) {
  if (c?.kind !== 'video') return;
  store.transact('프레임 고정 추가', () => {
    const at = clamp(q(t), c.start, clipEnd(c) - fd());
    const frame = liveMediaTime(c, at);
    const target = at > c.start + EPS ? rawSplit(c, at) || c : c;
    target.hold = true;
    target.holdTime = frame;
    if (!/\(고정\)$/.test(target.name)) target.name = `${c.name} (고정)`;
    store.selectClips([target.id]);
  });
}

/**
 * 프레임 고정 세그먼트 삽입: split at the playhead and insert a frozen frame of `dur` seconds there;
 * everything after it on unlocked tracks moves later (like an insert edit, keeping sync).
 */
export function insertFrameHoldSegment(c, t = store.ui.playhead, dur = 2) {
  if (c?.kind !== 'video' || isLocked(c.trackId)) return null;
  const at = q(t);
  if (at < c.start - EPS || at > clipEnd(c) + EPS) return null;
  const d = Math.max(fd(), q(dur));
  let id = null;
  store.transact('프레임 고정 세그먼트 삽입', () => {
    const atIn = clamp(at, c.start, clipEnd(c) - fd());
    const frame = liveMediaTime(c, atIn);
    const tracks = unlockedTrackIds();
    splitAllAt(tracks, at);
    rawRipple(tracks, at, d);
    const hold = cloneClip(c, { start: at, duration: d, hold: true, holdTime: frame, linkId: null, groupId: undefined, transIn: null, transOut: null, name: `${c.name} (고정)`, markers: [] });
    shiftClipKeyframes(hold, -(atIn - c.start));
    seq().clips[hold.id] = hold;
    id = hold.id;
    store.selectClips([hold.id]);
  });
  return id;
}

/**
 * 프레임 고정 옵션: hold (or release) whole clips at a chosen frame. at: 'in' | 'out' | 'playhead' |
 * 'source' (time = source seconds) | 'sequence' (time = sequence seconds).
 */
export function setFrameHold(ids, { on = true, at = 'in', time = null } = {}) {
  const sq = seq();
  const clips = ids.map((id) => sq.clips[id]).filter((c) => c?.kind === 'video' && !isLocked(c.trackId));
  if (!clips.length) return 0;
  store.transact(on ? '프레임 고정 옵션' : '프레임 고정 해제', () => {
    for (const c of clips) {
      if (!on) {
        c.hold = false;
        delete c.holdTime;
        continue;
      }
      const m = media(c.mediaId);
      let frame;
      if (at === 'source') frame = Math.max(0, time ?? 0);
      else {
        const st = at === 'out' ? clipEnd(c) - fd() : at === 'playhead' || at === 'sequence' ? (at === 'sequence' ? time ?? c.start : store.ui.playhead) : c.start;
        frame = liveMediaTime(c, clamp(st, c.start, clipEnd(c) - fd()));
      }
      if (m && Number.isFinite(m.duration)) frame = clamp(frame, 0, Math.max(0, m.duration - 1 / Math.max(1, m.fps || sq.fps)));
      c.hold = true;
      c.holdTime = frame;
    }
  });
  return clips.length;
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

const AUTO_KEY_FX = new Set(['motion', 'opacity']);

const PARAM_LIMITS = { opacity: [0, 100], scale: [0, 100000] };

/**
 * Write a param at the playhead (keyframing aware). Raw: caller wraps in a transaction/begin.
 *
 * Motion/opacity follow the "키프레임 기록" switch:
 *  - recording on: still values start animating (the old value stays as a keyframe at the clip
 *    start, the new one is keyed at the playhead); animated values get a keyframe at the playhead;
 *  - recording off and `direct` (the object moved on the monitor or with the quick sliders): no
 *    keyframe is ever added. A keyframe at the playhead is adjusted; elsewhere the whole animation
 *    shifts by the change, keeping its shape.
 * Otherwise (Effect Controls with recording off) the stopwatch decides, as in Premiere.
 * Returns 'shifted' when a whole animation was shifted.
 */
export function rawSetParam(clip, fx, key, value, { direct = false } = {}) {
  const p = fx.params[key];
  if (!p) return undefined;
  const t = clamp(store.ui.playhead - clip.start, 0, clip.duration);
  const keyable = AUTO_KEY_FX.has(fx.type) && typeof value === 'number' && typeof p.value === 'number';
  // recording on: every change keys (Effect Controls too)
  if (keyable && store.ui.autoKey && !isAnimated(p)) {
    p.kf = t > fd() / 2 ? [newKey(0, p.value), newKey(t, value)] : [newKey(t, value)];
    p.value = value;
    return undefined;
  }
  // recording off, object moved directly: never add a keyframe
  if (keyable && direct && !store.ui.autoKey && isAnimated(p)) {
    const here = p.kf.find((k) => Math.abs(k.t - t) < fd() / 2);
    if (here) {
      here.v = value;
      p.value = value;
      return undefined;
    }
    const delta = value - evalParam(p, t);
    const [lo, hi] = PARAM_LIMITS[key] || [-Infinity, Infinity];
    for (const k of p.kf) k.v = clamp(k.v + delta, lo, hi);
    p.value = value;
    return 'shifted';
  }
  setParamValue(p, value, t, fd());
  return undefined;
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

/**
 * Start state of a speed-band drag (시간 다시 매핑 ▸ 속도 on the timeline) for rawRetimeRemap: the speed
 * keys, the clip, its linked partners of the same span and the clips after them on their tracks.
 */
export function remapRetimeState(clipId) {
  const s = seq();
  const c = s.clips[clipId];
  const fx = c?.effects.find((e) => e.type === 'timeRemap');
  if (!fx) return null;
  const p = fx.params.speed;
  const end = clipEnd(c);
  const mates = linkedClips(s, c).filter((o) => o.id === c.id || (Math.abs(o.start - c.start) < 1e-4 && Math.abs(o.duration - c.duration) < 1e-4));
  const ids = new Set(mates.map((o) => o.id));
  const tracks = new Set(mates.map((o) => o.trackId).filter((tid) => !getTrack(s, tid)?.locked));
  const after = Object.values(s.clips).filter((o) => tracks.has(o.trackId) && !ids.has(o.id) && o.start >= end - 1e-6).map((o) => ({ id: o.id, start: o.start }));
  return { clipId, fxId: fx.id, mates: [...ids], dur: c.duration, kf: p.kf ? deepClone(p.kf) : null, value: p.value, after };
}

/**
 * Raw: after the speed values of a time-remapped clip changed, keep its content and change its length,
 * as Premiere does: each stretch between speed keys plays the same source frames at the new speed, so
 * the keys move, the clip gets shorter (faster) or longer (slower) and later clips on its tracks ripple.
 */
export function rawRetimeRemap(st) {
  const s = seq();
  const c = st && s.clips[st.clipId];
  const fx = c?.effects.find((e) => e.id === st.fxId);
  if (!fx) return;
  const p = fx.params.speed;
  const MIN = 1e-9;
  let dur;
  if (!st.kf) {
    if (p.kf?.length) return;
    dur = p.value > 0.01 ? (st.dur * st.value) / p.value : st.dur;
  } else {
    if (!p.kf || p.kf.length !== st.kf.length) return;
    // the new values at the old times: content per stretch at the old length
    const mid = { kf: st.kf.map((k, j) => ({ ...k, v: p.kf[j].v })) };
    const old = { kf: st.kf };
    const pts = [...new Set([0, st.dur, ...st.kf.map((k) => k.t)])].sort((a, b) => a - b);
    const ratio = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const cOld = remapIntegral(old, b) - remapIntegral(old, a);
      const cNew = remapIntegral(mid, b) - remapIntegral(mid, a);
      ratio.push(cOld > MIN && cNew > MIN ? cOld / cNew : 1);
    }
    // new positions: clip start stays at 0, stretches before it extend backwards, after it forwards
    const pos = new Array(pts.length);
    const z = pts.indexOf(0);
    pos[z] = 0;
    for (let i = z + 1; i < pts.length; i++) pos[i] = pos[i - 1] + (pts[i] - pts[i - 1]) * ratio[i - 1];
    for (let i = z - 1; i >= 0; i--) pos[i] = pos[i + 1] - (pts[i + 1] - pts[i]) * ratio[i];
    const at = (t) => pts.indexOf(t);
    p.kf.forEach((k, j) => {
      const o = st.kf[j];
      const i = at(o.t);
      k.t = pos[i];
      // bezier handle speeds are per second: a stretch made shorter gets steeper
      if (o.inSpeed != null) k.inSpeed = o.inSpeed / (i > 0 ? ratio[i - 1] : 1);
      if (o.outSpeed != null) k.outSpeed = o.outSpeed / (i < ratio.length ? ratio[i] : 1);
    });
    dur = pos[at(st.dur)];
  }
  dur = Math.max(fd(), q(dur));
  const delta = dur - st.dur;
  for (const id of st.mates) {
    const o = s.clips[id];
    if (o) o.duration = dur;
  }
  rawSyncLinkedRemap(c.id);
  for (const a of st.after) {
    const o = s.clips[a.id];
    if (o) o.start = a.start + delta;
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

/** Fixed effects that 특성 붙여넣기 / 특성 제거 offer as attributes (others carry content, e.g. text). */
export const ATTRIBUTE_FIXED = ['motion', 'opacity', 'timeRemap', 'volume', 'channelVolume', 'panner'];

/**
 * 특성 붙여넣기 (Paste Attributes). sources: copied clips (the one of the target's family is used, so
 * copying a linked video+audio pair pastes video attributes onto video and audio onto audio).
 * opts: { attrs: Set of fixed types to paste (default all), effects: Set of source effect ids to paste
 * (default all added effects), scaleTimes: 특성 시간 비율 조정 — fit keyframe times to each target's length }.
 */
export function pasteAttributes(sources, targetIds, opts = {}) {
  const s = seq();
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  const attrs = opts.attrs || new Set(ATTRIBUTE_FIXED);
  let n = 0;
  store.transact('특성 붙여넣기', () => {
    for (const id of targetIds) {
      const c = s.clips[id];
      if (!c || isLocked(c.trackId)) continue;
      const sourceClip = list.find((x) => (x.kind === 'audio') === (c.kind === 'audio'));
      if (!sourceClip || sourceClip.id === id) continue;
      const k = opts.scaleTimes && sourceClip.duration > EPS ? c.duration / sourceClip.duration : 1;
      const prep = (e) => {
        const copy = deepClone(e);
        if (k !== 1) {
          for (const p of Object.values(copy.params)) {
            for (const kf of p.kf || []) {
              kf.t *= k;
              if (kf.inSpeed != null) kf.inSpeed /= k;
              if (kf.outSpeed != null) kf.outSpeed /= k;
            }
          }
        }
        return copy;
      };
      let changed = false;
      c.effects = c.effects.map((e) => {
        if (!EFFECTS[e.type]?.fixed || !attrs.has(e.type)) return e;
        const m = sourceClip.effects.find((x) => x.type === e.type);
        if (!m) return e;
        changed = true;
        const out = { ...prep(m), id: e.id };
        // hidden values (a title's point-text origin) belong to the clip, not to its look
        for (const pd of EFFECTS[e.type].params) if (pd.hidden && e.params[pd.key]) out.params = { ...out.params, [pd.key]: e.params[pd.key] };
        return out;
      });
      for (const e of sourceClip.effects) {
        if (EFFECTS[e.type]?.fixed || !effectFitsClip(e.type, c.kind)) continue;
        if (opts.effects && !opts.effects.has(e.id)) continue;
        c.effects.push({ ...prep(e), id: uid('fx') });
        changed = true;
      }
      if (attrs.has('timeRemap')) rawSyncLinkedRemap(c.id);
      if (changed) n++;
    }
  });
  return n;
}

/**
 * 특성 제거 (Remove Attributes): reset the chosen fixed attributes to their defaults and remove the
 * chosen added effects. opts: { attrs: Set of fixed types, effectTypes: Set of effect types }.
 */
export function removeAttributes(ids, { attrs = new Set(), effectTypes = new Set() } = {}) {
  const s = seq();
  let n = 0;
  store.transact('특성 제거', () => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c || isLocked(c.trackId)) continue;
      const before = JSON.stringify(c.effects);
      c.effects = c.effects.filter((e) => EFFECTS[e.type]?.fixed || !effectTypes.has(e.type));
      for (const e of c.effects) {
        if (!EFFECTS[e.type]?.fixed || !attrs.has(e.type)) continue;
        const fresh = createEffect(e.type, s);
        e.params = fresh.params;
        e.enabled = true;
      }
      if (attrs.has('timeRemap')) rawSyncLinkedRemap(c.id);
      if (JSON.stringify(c.effects) !== before) n++;
    }
  });
  return n;
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
    const groupMap = new Map();
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
      if (src.groupId) {
        if (!groupMap.has(src.groupId)) groupMap.set(src.groupId, uid('grp'));
        c.groupId = groupMap.get(src.groupId);
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

/** Premiere's default name for a new nest: 중첩 시퀀스 01, 02 … (the first number not in use). */
export function nextNestName() {
  const names = new Set(Object.values(store.project.sequences).map((x) => x.name));
  for (let i = 1; ; i++) {
    const n = `중첩 시퀀스 ${String(i).padStart(2, '0')}`;
    if (!names.has(n)) return n;
  }
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
    name: name || nextNestName(),
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

/**
 * 트랙 추가…: add `video` / `audio` tracks in one step. where: 'first' (before the first track of
 * the kind) or 'last' (after the last one, the default).
 */
export function addTracks({ video = 0, audio = 0, videoWhere = 'last', audioWhere = 'last' } = {}) {
  const s = seq();
  if (video <= 0 && audio <= 0) return;
  store.transact('트랙 추가', () => {
    for (let i = 0; i < video; i++) {
      const t = createTrack('video', 0);
      if (videoWhere === 'first') s.tracks.splice(s.tracks.findIndex((x) => x.kind === 'video'), 0, t);
      else s.tracks.splice(s.tracks.findLastIndex((x) => x.kind === 'video') + 1, 0, t);
    }
    for (let i = 0; i < audio; i++) {
      const t = createTrack('audio', 0);
      if (audioWhere === 'first') s.tracks.splice(s.tracks.findIndex((x) => x.kind === 'audio'), 0, t);
      else s.tracks.push(t);
    }
    renameTracks(s);
  });
}

/** 트랙 삭제… ▸ 모든 빈 트랙: remove empty unlocked tracks of a kind (one of each kind always stays). */
export function deleteEmptyTracks(kinds = ['video', 'audio']) {
  const s = seq();
  let n = 0;
  store.transact('빈 트랙 삭제', () => {
    for (const kind of kinds) {
      const list = s.tracks.filter((t) => t.kind === kind);
      let left = list.length;
      for (const t of list.slice().reverse()) {
        if (left <= 1) break;
        if (t.locked || clipsOnTrack(s, t.id).length) continue;
        s.tracks = s.tracks.filter((x) => x.id !== t.id);
        left--;
        n++;
      }
    }
    renameTracks(s);
  });
  return n;
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

function makeMarker(t, props, n) {
  return {
    id: uid('mk'), time: t, duration: Math.max(0, props.duration || 0), name: props.name ?? `마커 ${n + 1}`,
    color: props.color || '#4ade80', comment: props.comment || '', type: props.type || 'comment',
  };
}

/** Add a sequence marker (M). Returns its id, or null when one already sits on that frame. */
export function addMarker(t = store.ui.playhead, props = {}) {
  const s = seq();
  t = q(Math.max(0, t));
  if (s.markers.some((m) => Math.abs(m.time - t) < EPS)) return null;
  let id = null;
  store.transact(props.type === 'chapter' ? '챕터 마커 추가' : '마커 추가', () => {
    const mk = makeMarker(t, props, s.markers.length);
    s.markers.push(mk);
    s.markers.sort((a, b) => a.time - b.time);
    id = mk.id;
  });
  return id;
}

/** Add a clip marker at sequence time t on each clip (it moves with the clip). Returns the ids. */
export function addClipMarker(clipIds, t = store.ui.playhead, props = {}) {
  const s = seq();
  const out = [];
  store.transact('클립 마커 추가', () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || t < c.start - EPS || t > clipEnd(c) + EPS) continue;
      c.markers = c.markers || [];
      const tl = clamp(q(t) - c.start, 0, c.duration);
      if (c.markers.some((m) => Math.abs(m.time - tl) < EPS)) continue;
      const mk = makeMarker(tl, props, c.markers.length);
      c.markers.push(mk);
      c.markers.sort((a, b) => a.time - b.time);
      out.push(mk.id);
    }
  });
  return out;
}

/** Find a marker by id: { marker, clip } (clip is null for sequence markers). */
export function findMarker(id) {
  const s = seq();
  const mk = s.markers.find((m) => m.id === id);
  if (mk) return { marker: mk, clip: null };
  for (const c of Object.values(s.clips)) {
    const cm = c.markers?.find((m) => m.id === id);
    if (cm) return { marker: cm, clip: c };
  }
  return null;
}

/**
 * Change a marker (마커 편집). props: name, comment, color, type, duration (seconds), time (sequence
 * seconds, also for clip markers).
 */
export function updateMarker(id, props) {
  store.transact('마커 편집', () => {
    const f = findMarker(id);
    if (!f) return;
    const { marker: m, clip } = f;
    for (const k of ['name', 'comment', 'color', 'type']) if (props[k] != null) m[k] = props[k];
    if (props.duration != null) m.duration = Math.max(0, q(props.duration));
    if (props.time != null) m.time = clip ? clamp(q(props.time) - clip.start, 0, clip.duration) : Math.max(0, q(props.time));
    (clip ? clip.markers : seq().markers).sort((a, b) => a.time - b.time);
  });
}

export function removeMarker(id) {
  store.transact('마커 삭제', () => {
    seq().markers = seq().markers.filter((m) => m.id !== id);
    for (const c of Object.values(seq().clips)) if (c.markers?.some((m) => m.id === id)) c.markers = c.markers.filter((m) => m.id !== id);
  });
}

/**
 * 시작 / 종료 표시 at time t. As in Premiere the Out frame is part of the range: seq.outPoint keeps
 * the range's end (the time just after the Out frame), so In 00:00:00:00 and Out 00:00:04:29 at
 * 30 fps is 5 seconds long.
 */
export function setSequenceInOut(which, t) {
  const s = seq();
  store.transact(which === 'in' ? '시작 표시' : '끝 표시', () => {
    if (which === 'in') {
      s.inPoint = t == null ? null : q(t);
      if (s.inPoint != null && s.outPoint != null && s.outPoint <= s.inPoint) s.outPoint = null;
    } else {
      s.outPoint = t == null ? null : q(q(t) + fd());
      if (s.inPoint != null && s.outPoint != null && s.outPoint <= s.inPoint) s.inPoint = null;
    }
  });
}

export function markClip() {
  const s = seq();
  const t = store.ui.playhead;
  const tracks = s.tracks.filter((tr) => tr.targeted).map((tr) => tr.id);
  // Premiere's 클립 표시 (X) marks the clip under the playhead on the targeted tracks; the selection is the fallback
  const c = Object.values(s.clips).find((x) => tracks.includes(x.trackId) && x.start <= t + EPS && clipEnd(x) > t + EPS) || store.selectedClips()[0];
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
      scaleParamValues(motion.params.posX, sx);
      scaleParamValues(motion.params.posY, sy);
    }
  });
}

/**
 * 빈 공간 닫기: pull every clip left over the gaps before it. Linked clips (video + its sound) move as
 * one so they stay in sync; clips on locked tracks stay put.
 */
export function closeAllGaps() {
  const s = seq();
  store.transact('빈 공간 닫기', () => {
    const cursor = new Map(s.tracks.map((t) => [t.id, 0]));
    const done = new Set();
    const order = Object.values(s.clips).sort((a, b) => a.start - b.start);
    for (const c of order) {
      if (done.has(c.id)) continue;
      const group = c.linkId ? linkedClips(s, c).filter((x) => !done.has(x.id)) : [c];
      for (const g of group) done.add(g.id);
      const g0 = Math.min(...group.map((g) => g.start));
      let shift = Infinity;
      for (const g of group) shift = Math.min(shift, g.start - (cursor.get(g.trackId) ?? 0));
      if (group.some((g) => isLocked(g.trackId))) shift = 0;
      shift = Math.max(0, Math.min(shift, g0));
      for (const g of group) {
        g.start -= shift;
        cursor.set(g.trackId, Math.max(cursor.get(g.trackId) ?? 0, clipEnd(g)));
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
  store.transact('멀티 카메라 소스 시퀀스 만들기', () => {
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
  // one undo step: the copy, its new frame size and the reframed clips
  return store.transact('자동 리프레임', () => {
    const newId = duplicateSequence(srcId);
    if (!newId) return null;
    store.openSequence(newId);
    updateSequenceSettings({ width, height, fps: seq().fps, name: name || `${seq().name} (${width}×${height})` });
    const s = seq();
    for (const c of Object.values(s.clips)) {
      const motion = c.effects.find((e) => e.type === 'motion');
      if (!motion) continue;
      const m = c.mediaId ? store.project.media[c.mediaId] : null;
      if ((c.kind === 'video' || c.kind === 'image' || c.kind === 'nest') && m?.width) {
        const fit = Math.min(width / m.width, height / m.height);
        const fill = Math.max(width / m.width, height / m.height);
        const factor = fill / fit;
        scaleParamValues(motion.params.scale, factor);
      }
    }
    return newId;
  });
}

// ---------------------------------------------------------------- groups

/** 그룹 (Ctrl+G): grouped clips are selected and moved together, across tracks. */
export function groupClips(ids) {
  const s = seq();
  const clips = [...withLinked(ids)].map((id) => s.clips[id]).filter(Boolean);
  if (clips.length < 2) {
    store.toast('그룹으로 묶을 클립을 두 개 이상 선택하세요');
    return null;
  }
  const g = uid('grp');
  store.transact('그룹', () => {
    for (const c of clips) c.groupId = g;
  });
  return g;
}

/** 그룹 해제 (Ctrl+Shift+G). */
export function ungroupClips(ids) {
  const s = seq();
  const groups = new Set(ids.map((id) => s.clips[id]?.groupId).filter(Boolean));
  if (!groups.size) {
    store.toast('선택한 클립은 그룹이 아닙니다');
    return;
  }
  store.transact('그룹 해제', () => {
    for (const c of Object.values(s.clips)) if (groups.has(c.groupId)) delete c.groupId;
  });
}

/** Ids expanded by their groups (selection helper; Alt+click picks one clip of a group). */
export function withGroups(ids) {
  const s = seq();
  const out = new Set(ids);
  const groups = new Set([...out].map((id) => s.clips[id]?.groupId).filter(Boolean));
  if (groups.size) for (const c of Object.values(s.clips)) if (groups.has(c.groupId)) out.add(c.id);
  return out;
}

/** Ids expanded by groups and (with linked selection on) links, until nothing more joins. */
export function withGroupsAndLinks(ids) {
  let cur = new Set(ids);
  for (let i = 0; i < 6; i++) {
    const next = withLinked(withGroups(cur));
    if (next.size === cur.size) return next;
    cur = next;
  }
  return cur;
}

/** Track Select Backward (Shift+A): everything that starts before t on one track (or on all tracks). */
export function selectBackward(t, trackId = null) {
  const ids = Object.values(seq().clips).filter((c) => c.start < t - EPS && (!trackId || c.trackId === trackId)).map((c) => c.id);
  store.selectClips([...withLinked(ids)]);
}

// ---------------------------------------------------------------- replace edit

/**
 * 바꾸기 편집 (Replace Edit): put other media into a clip, keeping its place, length, effects and
 * transitions. opts.inPoint: source time of the clip's first frame (default the media's In point);
 * opts.matchAt: { seqTime, srcTime } aligns that source frame with that sequence time (일치하는 프레임).
 * Linked partners get the matching stream of the new media when it has one.
 */
export function replaceClipMedia(clipIds, mediaId, opts = {}) {
  const s = seq();
  const m = media(mediaId);
  if (!m || ['lut', 'font'].includes(m.kind)) return 0;
  if (m.kind === 'sequence' && sequenceContains(store.project, m.sequenceId, s.id)) {
    store.toast('시퀀스를 자기 자신 안에 중첩할 수 없습니다');
    return 0;
  }
  const clips = clipIds.map((id) => s.clips[id]).filter((c) => c && !isLocked(c.trackId) && c.mediaId);
  let n = 0;
  store.transact('바꾸기 편집', () => {
    for (const c of clips) {
      const isAudio = c.kind === 'audio';
      const hasAudio = m.kind === 'audio' || ((m.kind === 'video' || m.kind === 'sequence') && m.hasAudio);
      if (isAudio ? !hasAudio : m.kind === 'audio') continue;
      const newKind = isAudio ? 'audio' : m.kind === 'sequence' ? 'nest' : m.kind;
      if (!isAudio && !['video', 'image', 'nest', 'color', 'adjustment'].includes(newKind)) continue;
      const oldKind = c.kind;
      c.kind = newKind;
      c.mediaId = m.subclipOf || mediaId; // a subclip (하위 클립) plays its master's file
      if (m.subclipOf) c.subclip = { id: mediaId, in: m.subIn, out: m.subOut, restrict: m.restrictTrims !== false };
      else delete c.subclip;
      c.name = m.name;
      delete c.multicam;
      // fixed effects follow the new clip kind (e.g. an image has no time remapping)
      if (oldKind !== newKind) {
        const want = fixedEffectsFor(newKind);
        c.effects = c.effects.filter((e) => !EFFECTS[e.type]?.fixed || want.includes(e.type));
        want.forEach((type, i) => {
          if (!c.effects.some((e) => e.type === type)) c.effects.splice(Math.min(i, c.effects.length), 0, createEffect(type, s));
        });
        if (newKind !== 'video') {
          c.hold = false;
          delete c.holdTime;
        }
      }
      if (newKind === 'color' && m.color) {
        const fill = c.effects.find((e) => e.type === 'fill');
        if (fill) fill.params.color.value = m.color;
      }
      let inPoint = opts.inPoint ?? m.inPoint ?? 0;
      if (opts.matchAt) {
        const off = c.reverse ? 0 : contentTime(c, clamp(opts.matchAt.seqTime - c.start, 0, c.duration));
        inPoint = opts.matchAt.srcTime - off;
      }
      if (isTimed(c) && Number.isFinite(m.duration)) {
        const need = contentTime(c, c.duration);
        inPoint = clamp(inPoint, 0, Math.max(0, m.duration - need));
        c.inPoint = inPoint;
        // shorter media: the clip ends where the media does
        const avail = sourceOut(c) - m.duration;
        if (avail > 1e-6 && !c.hold) c.duration = Math.max(fd(), q(c.duration * (m.duration - inPoint) / Math.max(EPS, need)));
      } else c.inPoint = isTimed(c) ? Math.max(0, inPoint) : 0;
      if (c.hold) c.holdTime = c.inPoint;
      n++;
    }
  });
  if (!n) store.toast('이 클립에는 그 미디어를 넣을 수 없습니다 (영상 클립에는 영상·이미지, 오디오 클립에는 소리가 있는 미디어)');
  return n;
}

// ---------------------------------------------------------------- sequences from clips

/** 클립에서 새 시퀀스: a sequence with the media's frame size and rate, holding the media. */
export function newSequenceFromMedia(mediaId) {
  const m = media(mediaId);
  if (!m || ['lut', 'font', 'sequence'].includes(m.kind)) return null;
  const cur = seq();
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const visual = m.kind === 'video' || m.kind === 'image';
  const sq = createSequence({
    name: m.name.replace(/\.[^.]+$/, '') || '시퀀스',
    width: visual && m.width ? even(m.width) : cur.width,
    height: visual && m.height ? even(m.height) : cur.height,
    fps: m.kind === 'video' && m.fps ? Math.round(m.fps * 1000) / 1000 : cur.fps,
  });
  const mark = store.undoMark();
  store.transact('클립에서 새 시퀀스', () => addSequenceToProject(store.project, sq));
  store.openSequence(sq.id);
  placeMedia(mediaId, { mode: 'overwrite', start: 0, checkMismatch: false });
  store.squashSince(mark, '클립에서 새 시퀀스');
  store.setPlayhead(0);
  return sq.id;
}

/** Change the active sequence to the media's frame size and rate (클립 불일치 경고 ▸ 시퀀스 설정 변경). */
export function matchSequenceToMedia(mediaId) {
  const m = media(mediaId);
  if (!m?.width || !m?.height) return;
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  updateSequenceSettings({ width: even(m.width), height: even(m.height), fps: m.fps ? Math.round(m.fps * 1000) / 1000 : seq().fps });
}

/**
 * 프레임 크기로 비율 조정 / 프레임 크기로 설정 (Premiere's Scale to Frame Size / Set to Frame Size):
 * both fit the picture inside the frame. 비율 조정 fits the picture itself (모션 ▸ 비율 stays 100 %);
 * 설정 keeps the media's own pixels (clip.native) and lowers 모션 ▸ 비율 instead (e.g. 50 % for 4K
 * in an HD sequence), so zooming in later stays sharp. Size keyframes are cleared.
 */
export function setClipsToFrameSize(ids, label = '프레임 크기로 설정') {
  const s = seq();
  const keep = label === '프레임 크기로 설정';
  let n = 0;
  store.transact(label, () => {
    for (const id of ids) {
      const c = s.clips[id];
      const motion = c?.effects.find((e) => e.type === 'motion');
      if (!motion || isLocked(c.trackId)) continue;
      const fit = fitScaleOf(c, s);
      if (keep && fit) c.native = true;
      else delete c.native;
      motion.params.scale.value = keep && fit ? Math.round(fit * 1000) / 10 : 100;
      motion.params.scale.kf = null;
      n++;
    }
  });
  return n;
}

/** Scale that fits a picture clip's media inside the frame, or 0 when the clip has no media size. */
export function fitScaleOf(c, s = seq()) {
  const m = c && (c.kind === 'video' || c.kind === 'image' || c.kind === 'nest') ? media(c.mediaId) : null;
  return m?.width && m?.height ? Math.min(s.width / m.width, s.height / m.height) : 0;
}

// 환경 설정 ▸ 기본 미디어 비율 조정 (Premiere's Default Media Scaling) for clips placed from now on:
// 'fit' 프레임 크기로 비율 조정 (Montage's default), 'set' 프레임 크기로 설정, 'none' 없음 (own pixels, 100 %)
export const MEDIA_SCALING = [['none', '없음'], ['fit', '프레임 크기로 비율 조정'], ['set', '프레임 크기로 설정']];
export function defaultMediaScaling() {
  try {
    const v = JSON.parse(localStorage.getItem('montage.mediaScaling'));
    return MEDIA_SCALING.some(([k]) => k === v) ? v : 'fit';
  } catch {
    return 'fit';
  }
}
export function setDefaultMediaScaling(v) {
  try {
    localStorage.setItem('montage.mediaScaling', JSON.stringify(v));
  } catch { /* storage unavailable */ }
}

/** Apply 기본 미디어 비율 조정 to a newly placed clip. */
function applyMediaScaling(c, s) {
  const mode = defaultMediaScaling();
  const fit = mode === 'fit' ? 0 : fitScaleOf(c, s);
  if (!fit) return;
  c.native = true;
  const motion = c.effects.find((e) => e.type === 'motion');
  if (motion && mode === 'set') motion.params.scale.value = Math.round(fit * 1000) / 10;
}

// ---------------------------------------------------------------- slide & rate stretch

/**
 * Limits for sliding clip c (밀기 도구): the clip keeps its content and length and moves; the clip
 * before it gets longer/shorter at its end and the clip after it at its start. Returns { min, max, prev, next }.
 */
export function slideLimits(c) {
  const s = seq();
  const prev = prevAdjacent(s, c);
  const next = nextAdjacent(s, c);
  let min = -c.start;
  let max = Infinity;
  if (prev) {
    const lp = trimLimits(prev, 'out', { rolling: true });
    min = Math.max(min, lp.min);
    max = Math.min(max, lp.max);
  } else {
    const before = clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start + EPS).pop();
    if (before) min = Math.max(min, clipEnd(before) - c.start);
  }
  if (next) {
    const ln = trimLimits(next, 'in', { rolling: true });
    min = Math.max(min, ln.min);
    max = Math.min(max, ln.max);
  } else {
    const after = clipsOnTrack(s, c.trackId).find((x) => x.id !== c.id && x.start >= clipEnd(c) - EPS);
    if (after) max = Math.min(max, after.start - clipEnd(c));
  }
  if (min > max) min = max = 0;
  return { min, max, prev, next };
}

/** Raw: round clip starts and lengths that drifted off the frame grid during a drag back onto it. */
export function rawTidyTimes(ids) {
  const s = seq();
  const near = (v) => Math.abs(v - q(v)) < 1e-6;
  for (const id of ids) {
    const c = s.clips[id];
    if (!c) continue;
    if (near(c.start)) c.start = q(c.start);
    if (near(c.duration)) c.duration = Math.max(fd(), q(c.duration));
  }
}

/** Raw: slide clip c by delta seconds (see slideLimits; the caller clamps). */
export function rawSlide(c, delta, prev, next) {
  if (Math.abs(delta) < EPS) return;
  if (prev) rawTrimEdge(prev, 'out', delta);
  if (next) rawTrimEdge(next, 'in', delta);
  c.start += delta;
}

/**
 * Limits for the rate stretch tool (속도 조정 도구) on an edge: new duration range so the clip keeps its
 * content (0.01× .. 100× speed) and does not run into its neighbours. Returns { min, max } of the delta.
 */
export function rateStretchLimits(c, edge) {
  const s = seq();
  const f = fd();
  const content = c.duration * c.speed;
  const minDur = Math.max(f, content / 100);
  const maxDur = content / 0.01;
  if (edge === 'out') {
    const next = clipsOnTrack(s, c.trackId).find((x) => x.id !== c.id && x.start >= clipEnd(c) - EPS);
    const room = next ? next.start - c.start : Infinity;
    return { min: minDur - c.duration, max: Math.min(maxDur, room) - c.duration };
  }
  const prev = clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start + EPS).pop();
  const room = clipEnd(c) - (prev ? clipEnd(prev) : 0);
  // delta > 0 moves the head right (shorter)
  return { min: c.duration - Math.min(maxDur, room), max: c.duration - minDur };
}

/** Raw: change the clip's length by stretching its speed; edge 'in' moves the start, 'out' the end. */
export function rawRateStretch(c, edge, newDuration) {
  if (!Number.isFinite(newDuration) || !(c.duration > 0)) return;
  const d = Math.max(fd() / 4, newDuration);
  const factor = d / c.duration;
  if (Math.abs(factor - 1) < 1e-9) return;
  const content = c.duration * c.speed;
  if (edge === 'in') c.start = clipEnd(c) - d;
  if (isTimed(c) && !c.hold) {
    scaleClipKeyframes(c, factor);
    c.speed = content / d;
  } else scaleClipKeyframes(c, factor);
  c.duration = d;
  if (c.transIn) c.transIn.duration = Math.min(c.transIn.duration, c.duration);
  if (c.transOut) c.transOut.duration = Math.min(c.transOut.duration, c.duration);
}

/**
 * 선택한 편집점을 재생 헤드로 확장 (E): the nearer edge of each selected clip moves to the playhead
 * (a normal trim, limited by the media and the neighbouring clips).
 */
export function extendToPlayhead() {
  const t = q(store.ui.playhead);
  const s = seq();
  // a selected edit point (a clip edge clicked in the timeline, store.ui.editPoint) wins, as in Premiere
  const ep = store.ui.editPoint;
  const fromPoint = ep?.ids?.length && ep.ids.every((id) => s.clips[id]) ? ep : null;
  const clips = (fromPoint ? fromPoint.ids.map((id) => s.clips[id]) : store.selectedClips()).filter((c) => !isLocked(c.trackId));
  if (!clips.length) {
    store.toast('늘리거나 줄일 클립이나 편집점을 먼저 선택하세요');
    return 0;
  }
  let n = 0;
  store.transact('편집점을 재생 헤드로 확장', () => {
    for (const c of clips) {
      const end = clipEnd(c);
      const edge = fromPoint ? fromPoint.edge : t <= c.start || (t < end && t - c.start < end - t) ? 'in' : 'out';
      const want = edge === 'in' ? t - c.start : t - end;
      const lim = trimLimits(c, edge);
      const d = clamp(want, lim.min, lim.max);
      if (Math.abs(d) < EPS) continue;
      rawTrimEdge(c, edge, d);
      n++;
    }
  });
  return n;
}

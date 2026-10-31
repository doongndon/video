// Subclips (하위 클립): project items that point at a master clip's file with their own start / end.
// A subclip item keeps the master's time base (its In/Out and bounds are master media times), so
// the timeline, decoders and autosave all keep using the master's file. Clips placed from a subclip
// reference the master (edit.placeMedia redirects) and remember the subclip's range so trims and
// slips stay inside it ("하위 클립 경계로 트리밍 제한").

import { store } from './store.js';
import { uid, clamp, snapFrame } from './util.js';

export const isSubclip = (m) => !!m?.subclipOf;

/** The master media item of a subclip (or the item itself). */
export function masterOf(id) {
  const m = store.project.media[id];
  if (!m?.subclipOf) return m || null;
  return store.project.media[m.subclipOf] || null;
}

/** The id whose file / runtime holds the frames of an item (the master for subclips). */
export const fileIdOf = (id) => store.project.media[id]?.subclipOf || id;

/** Media range an item covers: [start, end] in master media time. */
export function itemRange(m) {
  if (!m) return [0, 0];
  if (m.subclipOf) return [m.subIn ?? 0, m.subOut ?? m.duration ?? 0];
  return [0, Number.isFinite(m.duration) ? m.duration : 0];
}

/** A free default name: "<base> 하위 클립 01", "… 02", … */
export function nextSubclipName(masterId) {
  const master = store.project.media[masterId];
  const base = (master?.name || '클립').replace(/\.[^.]+$/, '');
  const taken = new Set(Object.values(store.project.media).map((m) => m.name));
  for (let n = 1; n < 1000; n++) {
    const name = `${base} 하위 클립 ${String(n).padStart(2, '0')}`;
    if (!taken.has(name)) return name;
  }
  return `${base} 하위 클립`;
}

/**
 * Create a subclip of `sourceId` (a master or another subclip) from inPoint to outPoint (master
 * media time). Returns the new item id, or null when the range is empty.
 */
export function createSubclip(sourceId, { name, inPoint, outPoint, restrict = true } = {}) {
  const src = store.project.media[sourceId];
  if (!src || !['video', 'audio'].includes(src.kind)) return null;
  const masterId = src.subclipOf || sourceId;
  const master = store.project.media[masterId];
  if (!master) return null;
  const fps = master.fps || store.seq.fps;
  const [lo, hi] = itemRange(src);
  const a = clamp(snapFrame(inPoint ?? lo, fps), lo, hi);
  const b = clamp(snapFrame(outPoint ?? hi, fps), a, hi);
  if (b - a < 1 / fps / 2) return null;
  const id = uid('media');
  store.transact('하위 클립 만들기', () => {
    const p = store.project;
    p.media[id] = {
      id, kind: master.kind, name: name || nextSubclipName(masterId), subclipOf: masterId, subIn: a, subOut: b, restrictTrims: restrict,
      duration: master.duration, width: master.width, height: master.height, fps: master.fps, hasAudio: master.hasAudio, hasVideo: master.hasVideo,
      size: master.size, mime: master.mime, inPoint: a, outPoint: b, analyzed: true, bin: src.bin || null, label: src.label || null,
    };
    // right after its source in the project panel
    const at = p.mediaOrder.indexOf(sourceId);
    if (at >= 0) p.mediaOrder.splice(at + 1, 0, id);
    else p.mediaOrder.push(id);
  });
  return id;
}

/** Change a subclip's range / name / trim restriction (existing timeline clips keep theirs, like Premiere). */
export function editSubclip(id, { name, subIn, subOut, restrict } = {}) {
  const m = store.project.media[id];
  const master = m?.subclipOf ? store.project.media[m.subclipOf] : null;
  if (!master) return false;
  const fps = master.fps || store.seq.fps;
  const max = Number.isFinite(master.duration) ? master.duration : Infinity;
  const a = clamp(snapFrame(subIn ?? m.subIn, fps), 0, max);
  const b = clamp(snapFrame(subOut ?? m.subOut, fps), a, max);
  if (b - a < 1 / fps / 2) return false;
  store.transact('하위 클립 편집', () => {
    const x = store.project.media[id];
    x.subIn = a;
    x.subOut = b;
    if (name) x.name = name;
    if (restrict != null) x.restrictTrims = restrict;
    // keep its own In/Out marks inside the new range
    x.inPoint = clamp(x.inPoint ?? a, a, b);
    x.outPoint = clamp(x.outPoint ?? b, x.inPoint, b);
  });
  return true;
}

/** Ids of the subclips made from a master item. */
export function subclipsOf(masterId) {
  return Object.values(store.project.media).filter((m) => m.subclipOf === masterId).map((m) => m.id);
}

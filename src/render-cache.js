// 렌더링 (Premiere's preview files): the render bar over the timeline ruler and rendered preview
// frames. Stretches with effects show yellow (plays as it is) or red (heavy, better rendered);
// 시작에서 끝까지 효과 렌더링 (Enter) draws their frames once into small JPEG frames, the bar
// turns green and playback shows those frames instead of composing the effects live. Any change
// to the clips of a stretch (or the sequence settings) makes it yellow / red again.

import { store } from './store.js';
import { sequenceDuration, hasSpeedRamp } from './model.js';
import { EFFECTS } from './effects.js';

// effects that are slow to draw live: their stretches are red (Premiere: needs rendering)
const HEAVY = new Set(['stabilize', 'echo', 'turbulentDisplace', 'waveWarp', 'twirl', 'spherize', 'glow', 'lensDistortion', 'ultraKey', 'cameraBlur', 'directionalBlur', 'channelBlur', 'replicate', 'basic3d']);
const MAX_FRAMES = 4000;
const PREVIEW_W = 1280;

const files = new Map(); // `${seqId}:${frame}` -> { sig, blob }
const decoded = new Map(); // same key -> ImageBitmap (a few around the playhead)
const decoding = new Set();
let memo = { seq: null, version: -1, segs: [] };
let version = 0;
store.on('change', () => { version++; });

/** 0: plays as it is (no bar), 1: yellow, 2: red. */
function levelOf(c) {
  if (c.enabled === false || c.kind === 'audio') return 0;
  const user = c.effects.filter((e) => e.enabled !== false && !EFFECTS[e.type]?.fixed);
  if (user.some((e) => HEAVY.has(e.type)) || user.length >= 3) return 2;
  if (user.length || c.transIn || c.transOut || ['text', 'shape', 'adjustment', 'nest'].includes(c.kind)) return 1;
  if (c.speed !== 1 || c.reverse || c.hold || hasSpeedRamp(c)) return 1;
  return 0;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + str.length.toString(36);
}

/** The render bar: [{ t0, t1, level, sig }] for the stretches that have effects. */
export function renderSegments(seq = store.seq) {
  if (memo.seq === seq && memo.version === version) return memo.segs;
  const hidden = new Set(seq.tracks.filter((t) => t.hidden).map((t) => t.id));
  const clips = Object.values(seq.clips).filter((c) => c.kind !== 'audio' && !hidden.has(c.trackId) && c.enabled !== false);
  const pts = [...new Set(clips.flatMap((c) => [c.start, c.start + c.duration]))].sort((a, b) => a - b);
  const segs = [];
  const head = `${seq.width}x${seq.height}@${seq.fps}|${seq.tracks.map((t) => `${t.id}${t.hidden ? 'h' : ''}`).join(',')}`;
  // what a stretch's frames depend on: its clips (and the sequences nested in them), worked out
  // only when needed (rendering, or rendered frames to check), not on every edit
  const hashes = new Map();
  const clipHash = (c) => {
    if (!hashes.has(c.id)) {
      const nested = c.kind === 'nest' ? store.project.sequences[store.project.media[c.mediaId]?.sequenceId] : null;
      hashes.set(c.id, hash(JSON.stringify(c) + (nested ? JSON.stringify(nested) : '')));
    }
    return hashes.get(c.id);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    if (b - a < 1e-6) continue;
    const here = clips.filter((c) => c.start < b - 1e-6 && c.start + c.duration > a + 1e-6);
    const level = Math.max(0, ...here.map(levelOf));
    if (!level) continue;
    let sig = null;
    segs.push({
      t0: a, t1: b, level,
      get sig() { return sig || (sig = hash(head + here.map(clipHash).sort().join('|'))); },
    });
  }
  memo = { seq, version, segs };
  // rendered frames of stretches that changed are of no use any more
  for (const [k, e] of files) {
    if (!k.startsWith(`${seq.id}:`)) continue;
    const f = Number(k.slice(seq.id.length + 1));
    if (segAt(segs, (f + 0.5) / seq.fps)?.sig !== e.sig) dropFile(k);
  }
  return segs;
}

function segAt(segs, t) {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < segs[m].t0) hi = m - 1;
    else if (t >= segs[m].t1) lo = m + 1;
    else return segs[m];
  }
  return null;
}

function dropFile(k) {
  files.delete(k);
  decoded.get(k)?.close?.();
  decoded.delete(k);
}

const framesOf = (seg, fps, lo = -Infinity, hi = Infinity) => {
  const out = [];
  const a = Math.max(seg.t0, lo);
  const b = Math.min(seg.t1, hi);
  for (let f = Math.ceil(a * fps - 0.5); (f + 0.5) / fps < b; f++) if ((f + 0.5) / fps >= a) out.push(f);
  return out;
};

/** Is every frame of the stretch rendered (green)? */
export function isRendered(seq, seg) {
  return framesOf(seg, seq.fps).every((f) => files.get(`${seq.id}:${f}`)?.sig === seg.sig);
}

/** The rendered (green) parts of a stretch: [[t0, t1], …]. */
export function renderedRuns(seq, seg) {
  const runs = [];
  if (!files.size) return runs;
  let start = null;
  const frames = framesOf(seg, seq.fps);
  for (const f of frames) {
    const ok = files.get(`${seq.id}:${f}`)?.sig === seg.sig;
    if (ok && start == null) start = f;
    if (!ok && start != null) {
      runs.push([Math.max(seg.t0, start / seq.fps), f / seq.fps]);
      start = null;
    }
  }
  if (start != null) runs.push([Math.max(seg.t0, start / seq.fps), seg.t1]);
  return runs;
}

/** 렌더링 파일 삭제: forget the rendered frames of this sequence (all sequences with all = true). */
export function deleteRenderFiles(all = false) {
  for (const k of [...files.keys()]) if (all || k.startsWith(`${store.seq.id}:`)) dropFile(k);
  store.emit('render-files');
}

/** The frames still to render between t0 and t1: [{ f, sig }]. */
export function framesToRender(seq, t0, t1) {
  const out = [];
  for (const seg of renderSegments(seq)) {
    if (seg.t1 <= t0 || seg.t0 >= t1) continue;
    for (const f of framesOf(seg, seq.fps, t0, t1)) if (files.get(`${seq.id}:${f}`)?.sig !== seg.sig) out.push({ f, sig: seg.sig });
  }
  return out;
}

export const previewWidth = (seq) => Math.min(seq.width, PREVIEW_W);

export function storeFrame(seq, f, sig, blob) {
  const k = `${seq.id}:${f}`;
  dropFile(k);
  files.set(k, { sig, blob });
  while (files.size > MAX_FRAMES) dropFile(files.keys().next().value);
}

/**
 * During playback: the rendered frame for time t (an ImageBitmap), or null to draw it live.
 * Decodes a few frames ahead so playback does not wait for them.
 */
export function previewFrame(seq, t) {
  if (!files.size) return null;
  const segs = renderSegments(seq);
  const f = Math.floor(t * seq.fps + 1e-6);
  const seg = segAt(segs, (f + 0.5) / seq.fps);
  if (!seg) return null;
  const k = `${seq.id}:${f}`;
  const e = files.get(k);
  if (!e || e.sig !== seg.sig) return null;
  for (let i = 0; i < 12; i++) {
    const kk = `${seq.id}:${f + i}`;
    const ee = files.get(kk);
    if (!ee || decoded.has(kk) || decoding.has(kk)) continue;
    decoding.add(kk);
    createImageBitmap(ee.blob).then((bm) => {
      decoding.delete(kk);
      if (files.get(kk) === ee) decoded.set(kk, bm);
      else bm.close?.();
    }, () => decoding.delete(kk));
  }
  // keep the decoded frames near the playhead only
  for (const kk of decoded.keys()) {
    const ff = Number(kk.slice(kk.lastIndexOf(':') + 1));
    if (!kk.startsWith(`${seq.id}:`) || ff < f - 2 || ff > f + 24) {
      decoded.get(kk)?.close?.();
      decoded.delete(kk);
    }
  }
  return decoded.get(k) || null;
}

/** In / Out of the sequence, or all of it (what 시작에서 끝까지 렌더링 covers). */
export function renderRange(seq = store.seq) {
  const dur = sequenceDuration(seq);
  const t0 = seq.inPoint ?? 0;
  const t1 = seq.outPoint ?? dur;
  return t1 > t0 ? [t0, t1] : [0, dur];
}

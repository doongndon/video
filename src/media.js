// Media import & analysis. Project media items (serialisable) live in store.project.media;
// runtime data that cannot be serialised (File, object URL, thumbnails, waveform peaks, decoders)
// lives in the `runtime` map keyed by media id.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { uid, once, Emitter } from './util.js';

export const mediaEvents = new Emitter();
export const runtime = new Map();

const PEAK_RATE = 100; // waveform buckets per second
const FILMSTRIP_FRAMES = 24;
const THUMB_W = 160;

// ---------------------------------------------------------------- kinds

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp|ts|mts|m2ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export function guessKind(file) {
  const t = file.type || '';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

export function getRuntime(id) {
  let rt = runtime.get(id);
  if (!rt) {
    rt = { status: 'offline', file: null, url: null, image: null, thumb: null, filmstrip: null, peaks: null, input: null };
    runtime.set(id, rt);
  }
  return rt;
}

export function mediaStatus(id) {
  const m = store.project.media[id];
  if (!m) return 'missing';
  if (m.kind === 'color' || m.kind === 'adjustment') return 'ready';
  return getRuntime(id).status;
}

// ---------------------------------------------------------------- import

/** Import a list of File objects. Returns created media ids. */
export async function importFiles(files) {
  const ids = [];
  const accepted = [];
  for (const file of files) {
    const kind = guessKind(file);
    if (!kind) {
      store.toast(`Unsupported file: ${file.name}`);
      continue;
    }
    accepted.push({ file, kind });
  }
  if (!accepted.length) return ids;

  store.transact(`Import ${accepted.length} item(s)`, () => {
    for (const { file, kind } of accepted) {
      const id = uid('media');
      store.project.media[id] = {
        id, name: file.name, kind, duration: null, width: 0, height: 0, fps: null,
        hasAudio: kind !== 'image', hasVideo: kind !== 'audio', size: file.size, mime: file.type,
        lastModified: file.lastModified, inPoint: null, outPoint: null, analyzed: false,
      };
      store.project.mediaOrder.push(id);
      const rt = getRuntime(id);
      rt.file = file;
      rt.status = 'loading';
      ids.push(id);
    }
  });

  for (const id of ids) {
    await probeMedia(id).catch((err) => {
      console.error(err);
      const rt = getRuntime(id);
      rt.status = 'error';
      rt.error = String(err?.message || err);
      store.toast(`Could not read ${store.project.media[id]?.name}: ${rt.error}`);
      mediaEvents.emit('updated', id);
    });
  }
  return ids;
}

/** Attach a (re)linked file to an existing media item and analyse it. */
export async function attachFile(id, file) {
  const rt = getRuntime(id);
  if (rt.url) URL.revokeObjectURL(rt.url);
  rt.url = null;
  rt.file = file;
  rt.status = 'loading';
  rt.thumb = rt.filmstrip = rt.peaks = rt.image = null;
  disposeInput(rt);
  mediaEvents.emit('updated', id);
  await probeMedia(id);
}

function disposeInput(rt) {
  try { rt.input?.dispose?.(); } catch { /* ignore */ }
  rt.input = null;
}

export function mediaUrl(id) {
  const rt = getRuntime(id);
  if (!rt.file) return null;
  if (!rt.url) rt.url = URL.createObjectURL(rt.file);
  return rt.url;
}

function getInput(rt) {
  if (!rt.input) rt.input = new MB.Input({ source: new MB.BlobSource(rt.file), formats: MB.ALL_FORMATS });
  return rt.input;
}

async function probeMedia(id) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  const info = {};

  if (media.kind === 'image') {
    const img = new Image();
    img.src = mediaUrl(id);
    await img.decode();
    rt.image = img;
    info.width = img.naturalWidth || 1920;
    info.height = img.naturalHeight || 1080;
    info.duration = null;
    info.hasAudio = false;
    info.hasVideo = true;
    rt.thumb = drawThumb(img, info.width, info.height);
  } else {
    const el = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.src = mediaUrl(id);
    const ok = await Promise.race([
      once(el, 'loadedmetadata', 20000),
      new Promise((resolve) => el.addEventListener('error', () => resolve(false), { once: true })),
    ]);
    if (!ok) throw new Error('the browser cannot decode this file');
    info.duration = Number.isFinite(el.duration) ? el.duration : null;
    info.width = el.videoWidth || 0;
    info.height = el.videoHeight || 0;
    if (media.kind === 'video' && !info.width) {
      // audio-only container (e.g. .m4a with a video mime) — treat as audio
      info.kind = 'audio';
    }
    el.removeAttribute('src');
    el.load();

    // container-level details via mediabunny (frame rate, audio presence, exact duration)
    try {
      const input = getInput(rt);
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      info.hasAudio = !!at;
      info.hasVideo = !!vt && (info.kind || media.kind) !== 'audio';
      if (vt) {
        const stats = await vt.computePacketStats(120);
        if (stats.averagePacketRate > 1 && stats.averagePacketRate < 300) info.fps = Math.round(stats.averagePacketRate * 100) / 100;
      }
      if (!info.duration) info.duration = await input.computeDuration();
    } catch (err) {
      console.warn('container probe failed, falling back to element metadata', err);
      info.hasAudio = true;
      info.hasVideo = (info.kind || media.kind) === 'video';
    }
  }

  // write analysed values without creating an undo entry
  Object.assign(media, info, { analyzed: true });
  if (info.kind) media.kind = info.kind;
  rt.status = 'ready';
  store.changed('media');
  mediaEvents.emit('updated', id);

  enqueueAnalysis(id);
}

// ---------------------------------------------------------------- background analysis

let queue = Promise.resolve();
function enqueueAnalysis(id) {
  queue = queue.then(() => analyse(id)).catch((err) => console.warn('analysis failed', err));
}

async function analyse(id) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  if (!media || rt.status !== 'ready') return;
  if (media.kind === 'video') {
    await buildFilmstrip(id).catch((err) => console.warn('filmstrip failed', err));
    mediaEvents.emit('updated', id);
  }
  if (media.hasAudio && media.kind !== 'image') {
    await buildPeaks(id).catch((err) => console.warn('waveform failed', err));
    mediaEvents.emit('updated', id);
  }
}

function drawThumb(source, w, h) {
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = Math.max(1, Math.round((THUMB_W * h) / Math.max(1, w)));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

async function buildFilmstrip(id) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  const dur = media.duration || 0;
  const n = Math.max(1, Math.min(FILMSTRIP_FRAMES, Math.ceil(dur)));
  const times = Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n);
  const frames = [];
  try {
    const input = getInput(rt);
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) throw new Error('no decodable video track');
    const sink = new MB.CanvasSink(vt, { width: THUMB_W });
    const first = await vt.getFirstTimestamp();
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (wrapped) frames.push({ t: times[i], canvas: copyCanvas(wrapped.canvas) });
      i++;
    }
  } catch (err) {
    console.warn('mediabunny thumbnails unavailable, using <video> seeking', err);
    frames.length = 0;
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.src = mediaUrl(id);
    await once(el, 'loadeddata', 15000);
    for (const t of times) {
      el.currentTime = t;
      if (await once(el, 'seeked', 5000)) frames.push({ t, canvas: drawThumb(el, el.videoWidth, el.videoHeight) });
    }
    el.removeAttribute('src');
    el.load();
  }
  if (frames.length) {
    rt.filmstrip = frames;
    rt.thumb = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.1))].canvas;
  }
}

function copyCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

async function buildPeaks(id) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  const dur = media.duration || 0;
  const peaks = new Float32Array(Math.ceil(dur * PEAK_RATE) + 2);
  let done = false;
  try {
    const input = getInput(rt);
    const at = await input.getPrimaryAudioTrack();
    if (!at) {
      media.hasAudio = false;
      return;
    }
    if (!(await at.canDecode())) throw new Error('audio codec not decodable');
    const sink = new MB.AudioBufferSink(at);
    const first = await at.getFirstTimestamp();
    for await (const { buffer, timestamp } of sink.buffers()) accumulatePeaks(peaks, buffer, timestamp - first);
    done = true;
  } catch (err) {
    console.warn('streamed waveform failed, trying decodeAudioData', err);
  }
  if (!done) {
    if (rt.file.size > 400 * 1024 * 1024) return;
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await rt.file.arrayBuffer());
    accumulatePeaks(peaks, buf, 0);
  }
  rt.peaks = { data: peaks, rate: PEAK_RATE };
}

function accumulatePeaks(peaks, buffer, timestamp) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  let i = 0;
  while (i < n) {
    const b = Math.floor((timestamp + i / sr) * PEAK_RATE);
    const end = Math.min(n, Math.max(i + 1, Math.ceil(((b + 1) / PEAK_RATE - timestamp) * sr)));
    let m = 0;
    for (const ch of chs) {
      for (let j = i; j < end; j++) {
        const v = ch[j] < 0 ? -ch[j] : ch[j];
        if (v > m) m = v;
      }
    }
    if (b >= 0 && b < peaks.length && m > peaks[b]) peaks[b] = m;
    i = end;
  }
}

// ---------------------------------------------------------------- export helpers

/**
 * Decode the audio of a media item between [start, end) media-seconds into one AudioBuffer.
 * Returns null when the media has no audio.
 */
export async function decodeAudioRange(id, start, end) {
  const rt = getRuntime(id);
  start = Math.max(0, start);
  if (end <= start) return null;
  try {
    const input = getInput(rt);
    const at = await input.getPrimaryAudioTrack();
    if (!at) return null;
    if (!(await at.canDecode())) throw new Error('audio codec not decodable');
    const first = await at.getFirstTimestamp();
    const sr = at.sampleRate;
    const chs = Math.min(2, at.numberOfChannels) || 1;
    const out = new AudioBuffer({ length: Math.max(1, Math.ceil((end - start) * sr)), numberOfChannels: chs, sampleRate: sr });
    for await (const { buffer, timestamp } of new MB.AudioBufferSink(at).buffers(start + first, end + first)) {
      const offset = Math.round((timestamp - first - start) * sr);
      for (let c = 0; c < chs; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        const from = Math.max(0, -offset);
        const to = Math.min(src.length, out.length - offset);
        if (to > from) out.getChannelData(c).set(src.subarray(from, to), offset + from);
      }
    }
    return out;
  } catch (err) {
    console.warn('streamed audio decode failed, falling back to decodeAudioData', err);
  }
  if (!rt.decodedFallback) {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    rt.decodedFallback = await ctx.decodeAudioData(await rt.file.arrayBuffer());
  }
  const full = rt.decodedFallback;
  const sr = full.sampleRate;
  const s0 = Math.floor(start * sr);
  const s1 = Math.min(full.length, Math.ceil(end * sr));
  if (s1 <= s0) return null;
  const out = new AudioBuffer({ length: s1 - s0, numberOfChannels: full.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < full.numberOfChannels; c++) out.getChannelData(c).set(full.getChannelData(c).subarray(s0, s1));
  return out;
}

/** Create a frame reader for exact, sequential frame access during export. */
export async function createFrameReader(id, width, height) {
  const rt = getRuntime(id);
  const input = getInput(rt);
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('video not decodable via WebCodecs');
  const first = await vt.getFirstTimestamp();
  const sink = new MB.CanvasSink(vt, { width, height, fit: 'contain', poolSize: 0 });
  return { sink, first };
}

/**
 * Scene Edit Detection: sample frames between [start, end) media-seconds and return media times
 * where the picture changes abruptly (luma-histogram distance above threshold).
 */
export async function detectScenes(id, start, end, { fps = 10, threshold = 0.35, onProgress = () => {} } = {}) {
  const rt = getRuntime(id);
  const times = [];
  for (let t = start; t < end; t += 1 / fps) times.push(t);
  const BINS = 32;
  const hist = (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const hst = new Float32Array(BINS * 3);
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      hst[(d[i] * BINS) >> 8]++;
      hst[BINS + ((d[i + 1] * BINS) >> 8)]++;
      hst[2 * BINS + ((d[i + 2] * BINS) >> 8)]++;
    }
    for (let i = 0; i < hst.length; i++) hst[i] /= n * 3;
    return hst;
  };
  const cuts = [];
  let prev = null;
  let i = 0;
  const consume = (canvas, t) => {
    const hcur = hist(canvas);
    if (prev) {
      let dist = 0;
      for (let k = 0; k < hcur.length; k++) dist += Math.abs(hcur[k] - prev[k]);
      dist /= 2;
      if (dist > threshold && (!cuts.length || t - cuts[cuts.length - 1] > 0.5)) cuts.push(t);
    }
    prev = hcur;
    if (++i % 10 === 0) onProgress(i / times.length);
  };
  try {
    const input = getInput(rt);
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) throw new Error('not decodable');
    const first = await vt.getFirstTimestamp();
    const sink = new MB.CanvasSink(vt, { width: 64, height: 36, fit: 'fill' });
    let k = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (wc) consume(wc.canvas, times[k]);
      k++;
    }
  } catch (err) {
    console.warn('scene detection via WebCodecs failed, using <video> seeking', err);
    const el = document.createElement('video');
    el.muted = true;
    el.src = mediaUrl(id);
    await once(el, 'loadeddata', 15000);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    for (const t of times) {
      el.currentTime = t;
      if (!(await once(el, 'seeked', 5000))) continue;
      c.getContext('2d').drawImage(el, 0, 0, 64, 36);
      consume(c, t);
    }
    el.removeAttribute('src');
    el.load();
  }
  return cuts;
}

/** Peak amplitude (0..1) of a media item's audio between two media times, from waveform data. */
export function peakInRange(id, start, end) {
  const p = getRuntime(id).peaks;
  if (!p) return null;
  let m = 0;
  for (let i = Math.max(0, Math.floor(start * p.rate)); i <= Math.min(p.data.length - 1, Math.ceil(end * p.rate)); i++) m = Math.max(m, p.data[i]);
  return m;
}

// ---------------------------------------------------------------- synthetic items

export function createSyntheticMedia(kind, { name, color, width, height } = {}) {
  const id = uid('media');
  const seq = store.seq;
  store.transact(`New ${name || kind}`, () => {
    store.project.media[id] = {
      id, kind, name: name || (kind === 'color' ? 'Color Matte' : 'Adjustment Layer'),
      duration: null, width: width || seq.width, height: height || seq.height, fps: null,
      hasAudio: false, hasVideo: true, color: color || '#000000', inPoint: null, outPoint: null, analyzed: true,
    };
    store.project.mediaOrder.push(id);
  });
  return id;
}

export function removeMedia(ids) {
  store.transact('Clear media', () => {
    for (const id of ids) {
      delete store.project.media[id];
      store.project.mediaOrder = store.project.mediaOrder.filter((m) => m !== id);
      for (const c of Object.values(store.seq.clips)) if (c.mediaId === id) delete store.seq.clips[c.id];
    }
  });
  for (const id of ids) {
    const rt = runtime.get(id);
    if (rt?.url) URL.revokeObjectURL(rt.url);
    if (rt) disposeInput(rt);
    runtime.delete(id);
  }
  if (ids.includes(store.ui.sourceMediaId)) {
    store.ui.sourceMediaId = null;
    store.emit('source');
  }
}

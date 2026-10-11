// Media import & analysis. Project media items (serialisable) live in store.project.media;
// runtime data that cannot be serialised (File, object URL, thumbnails, waveform peaks, decoders)
// lives in the `runtime` map keyed by media id.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { uid, once, Emitter } from './util.js';
import { registerFontFile } from './fonts.js';

export const mediaEvents = new Emitter();
export const runtime = new Map();

const PEAK_RATE = 100; // waveform buckets per second
const FILMSTRIP_FRAMES = 24;
const THUMB_W = 160;

// ---------------------------------------------------------------- kinds

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp|ts|mts|m2ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const LUT_EXT = /\.cube$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export function guessKind(file) {
  const t = file.type || '';
  if (LUT_EXT.test(file.name)) return 'lut';
  if (FONT_EXT.test(file.name) || t.startsWith('font/')) return 'font';
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
  if (m.kind === 'color' || m.kind === 'adjustment' || m.kind === 'sequence') return 'ready';
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
      store.toast(`지원하지 않는 파일입니다: ${file.name}`);
      continue;
    }
    accepted.push({ file, kind });
  }
  if (!accepted.length) return ids;

  store.transact(`가져오기 (${accepted.length}개)`, () => {
    for (const { file, kind } of accepted) {
      const id = uid('media');
      store.project.media[id] = {
        id, name: file.name, kind, duration: null, width: 0, height: 0, fps: null,
        hasAudio: kind === 'video' || kind === 'audio', hasVideo: kind === 'video' || kind === 'image', size: file.size, mime: file.type,
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
      store.toast(`${store.project.media[id]?.name} 파일을 읽을 수 없습니다: ${rt.error}`);
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
  if (!media) return;

  if (media.kind === 'font') {
    // fonts get a family name of their own; keep it stable across reloads
    let family = media.fontFamily;
    if (!family) {
      const base = rt.file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/["\\]/g, '').trim() || '내 글꼴';
      const taken = new Set(Object.values(store.project.media).filter((m) => m.kind === 'font' && m.id !== id).map((m) => m.fontFamily));
      family = base;
      for (let n = 2; taken.has(family); n++) family = `${base} ${n}`;
    }
    info.fontFamily = await registerFontFile(rt.file, family);
    info.duration = null;
    info.hasAudio = false;
    info.hasVideo = false;
  } else if (media.kind === 'lut') {
    rt.lut = parseCube(await rt.file.text());
    info.duration = null;
    info.width = rt.lut.size;
    info.height = 0;
    info.hasAudio = false;
    info.hasVideo = false;
  } else if (media.kind === 'image') {
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
    if (!ok) throw new Error('이 브라우저가 해석할 수 없는 형식입니다');
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

  // write analysed values without creating an undo entry. The project tree may have been replaced
  // (undo/redo) while probing, so look the item up again; keep a copy for later restores.
  rt.info = { ...info, analyzed: true };
  const current = store.project.media[id];
  if (current) {
    Object.assign(current, info, { analyzed: true });
    if (info.kind) current.kind = info.kind;
  }
  rt.status = 'ready';
  store.changed('media');
  mediaEvents.emit('updated', id);

  enqueueAnalysis(id);
}

/**
 * Undo snapshots taken while a file was still being analysed lack its duration / size. After any
 * restore, put the analysed values back from the runtime.
 */
function reapplyAnalysis() {
  for (const [id, rt] of runtime) {
    const m = store.project.media[id];
    if (m && rt.info && !m.analyzed) {
      Object.assign(m, rt.info);
      if (rt.info.kind) m.kind = rt.info.kind;
    }
  }
}
store.on('change', (reason) => {
  if (reason === 'restore' || reason === 'load') reapplyAnalysis();
});

// ---------------------------------------------------------------- background analysis

let queue = Promise.resolve();
function enqueueAnalysis(id) {
  queue = queue.then(() => analyse(id)).catch((err) => console.warn('analysis failed', err));
}

async function analyse(id) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  if (!media || rt.status !== 'ready' || media.kind === 'lut' || media.kind === 'font') return;
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
      if (rt.info) rt.info.hasAudio = false;
      const cur = store.project.media[id];
      if (cur) cur.hasAudio = false;
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
    accumulatePeaks(peaks, await decodeWholeAudio(rt), 0);
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
export async function decodeAudioRange(id, start, end, { capture = false, onCapture } = {}) {
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
    // a file that failed once is not decoded again for every clip that uses it
    if (!rt.audioDecodeError) {
      try {
        rt.decodedFallback = await decodeWholeAudio(rt);
      } catch (err) {
        rt.audioDecodeError = new Error(`${await audioCodecName(rt)} 소리를 이 브라우저에서 풀 수 없습니다 (${err.message || err})`);
      }
    }
    if (!rt.decodedFallback) {
      if (!capture || rt.captureFailed) throw rt.audioDecodeError;
      // the browser can still play it: record the range while it plays (real time)
      try {
        return await capturedRange(id, start, end, onCapture);
      } catch (err) {
        console.warn('capturing the sound by playing it failed', err);
        rt.captureFailed = true;
        throw rt.audioDecodeError;
      }
    }
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

/**
 * The whole sound of a file through the browser's audio decoder. Some browsers (phones especially)
 * cannot pull the sound out of a large video file: then the sound track alone is copied into a small
 * file of its own (packets copied, not re-encoded) and that is decoded instead.
 */
async function decodeWholeAudio(rt) {
  const ctx = new OfflineAudioContext(2, 1, 48000);
  try {
    return await ctx.decodeAudioData(await rt.file.arrayBuffer());
  } catch (err) {
    const audioOnly = await soundTrackFile(rt).catch((e) => {
      console.warn('copying the sound track failed', e);
      return null;
    });
    if (!audioOnly) throw err;
    return ctx.decodeAudioData(audioOnly);
  }
}

async function soundTrackFile(rt) {
  const input = new MB.Input({ source: new MB.BlobSource(rt.file), formats: MB.ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at) return null;
    const formats = [new MB.Mp4OutputFormat(), new MB.WebMOutputFormat(), new MB.OggOutputFormat(), new MB.Mp3OutputFormat(), new MB.AdtsOutputFormat()];
    const format = formats.find((f) => f.getSupportedAudioCodecs().includes(at.codec));
    if (!format) return null;
    const output = new MB.Output({ format, target: new MB.BufferTarget() });
    const conv = await MB.Conversion.init({ input, output, video: { discard: true }, showWarnings: false });
    if (!conv.isValid || !conv.utilizedTracks.some((t) => t.type === 'audio')) return null;
    await conv.execute();
    return output.target.buffer;
  } finally {
    input.dispose?.();
  }
}

/** A readable name for a file's sound codec, for messages. */
async function audioCodecName(rt) {
  try {
    const at = await getInput(rt).getPrimaryAudioTrack();
    const names = { aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3(돌비)', eac3: 'E-AC-3(돌비)', alaw: 'A-law', ulaw: 'μ-law' };
    return names[at?.codec] || (at?.codec ? at.codec.toUpperCase() : '알 수 없는 형식의');
  } catch {
    return '이 파일의';
  }
}

// ---------------------------------------------------------------- sound by playing (last resort)
// Some browsers (seen in an Android in-app browser) play a file's sound but neither WebCodecs nor
// decodeAudioData can decode it. Then the range is played through a hidden media element into Web Audio
// and recorded on the audio thread. Lined up by the first sample after the seek, the sound lands
// within a few milliseconds of where decoding puts it. It takes as long as the sound itself.

const CAPTURE_WORKLET = `registerProcessor('montage-capture', class extends AudioWorkletProcessor {
  process(inputs) {
    const i = inputs[0];
    this.port.postMessage(i && i.length ? [i[0].slice(), (i[1] || i[0]).slice()] : null);
    return true;
  }
});`;
let capturePrep = null;
let captureLatency = 0.05;

/** A short silent WAV, played once so the tap that starts an export unlocks the capture element. */
function silentWav() {
  const n = 800;
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const w = (o, str) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/**
 * Call synchronously from the tap/click that starts an export: phone browsers (in-app ones especially)
 * only let audio and media start from a user gesture.
 */
export function prepareSoundCapture() {
  if (capturePrep) return;
  try {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = silentWav();
    el.play().then(() => el.pause()).catch(() => {});
    capturePrep = { ctx, el, source: null, worklet: null, ranges: new Map() };
  } catch (err) {
    console.warn('sound capture unavailable', err);
  }
}

export function releaseSoundCapture() {
  const p = capturePrep;
  capturePrep = null;
  if (!p) return;
  p.el.pause();
  p.el.removeAttribute('src');
  p.ctx.close().catch(() => {});
}

async function capturedRange(id, start, end, onCapture) {
  if (!capturePrep) prepareSoundCapture();
  const p = capturePrep;
  if (!p) throw new Error('no audio context');
  // the same range again (several clips of one file): slice what was recorded
  for (const [key, buf] of p.ranges) {
    const [mid, s0, s1] = key.split('|');
    if (mid !== id || +s0 > start + 1e-6 || +s1 < end - 1e-6) continue;
    const sr = buf.sampleRate;
    const a = Math.round((start - s0) * sr);
    const out = new AudioBuffer({ length: Math.max(1, Math.round((end - start) * sr)), numberOfChannels: buf.numberOfChannels, sampleRate: sr });
    for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(a, a + out.length));
    return out;
  }
  const buf = await captureAudioRange(p, id, start, end, onCapture);
  p.ranges.set(`${id}|${start}|${end}`, buf);
  return buf;
}

async function captureAudioRange(p, id, start, end, onCapture = () => {}) {
  const { ctx, el } = p;
  if (!p.worklet) {
    p.worklet = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(p.worklet);
  }
  await ctx.resume();
  if (ctx.state !== 'running') throw new Error('audio context did not start');
  el.pause();
  el.muted = false;
  el.volume = 1;
  el.playbackRate = 1;
  el.src = mediaUrl(id);
  if (!(await once(el, 'loadedmetadata', 20000))) throw new Error('media did not load');
  el.currentTime = start;
  if ((Math.abs(el.currentTime - start) > 1e-3 || el.seeking) && !(await once(el, 'seeked', 15000))) throw new Error('seek failed');
  if (!p.source) p.source = ctx.createMediaElementSource(el);
  const node = new AudioWorkletNode(ctx, 'montage-capture', { channelCount: 2, channelCountMode: 'explicit' });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  p.source.connect(node);
  node.connect(mute).connect(ctx.destination);
  const left = [];
  const right = [];
  let n = 0;
  let playAt = -1;
  node.port.onmessage = (e) => {
    const d = e.data || [new Float32Array(128), new Float32Array(128)];
    left.push(d[0]);
    right.push(d[1]);
    n += d[0].length;
  };
  try {
    await new Promise((r) => setTimeout(r, 120));
    playAt = n;
    await el.play();
    // wait for the range to play through; stop if it stalls
    await new Promise((resolve, reject) => {
      let last = el.currentTime;
      let still = 0;
      const tick = () => {
        if (el.currentTime >= end + 0.25 || el.ended) return resolve();
        if (el.currentTime > last) {
          last = el.currentTime;
          still = 0;
        } else if ((still += 1) > 150) return reject(new Error('playback stalled'));
        onCapture(Math.max(0, el.currentTime - start), end - start);
        setTimeout(tick, 40);
      };
      tick();
    });
  } finally {
    el.pause();
    try { p.source.disconnect(node); } catch { /* not connected */ }
    node.disconnect();
    node.port.onmessage = null;
  }
  await new Promise((r) => setTimeout(r, 30));
  const sr = ctx.sampleRate;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let o = 0;
  for (let i = 0; i < left.length; i++) {
    L.set(left[i], o);
    R.set(right[i], o);
    o += left[i].length;
  }
  // the first sample after the seek is media time `start`. If the file is digitally silent there, use
  // the start-up delay seen on earlier captures instead
  let k0 = Math.max(0, playAt);
  while (k0 < n && Math.abs(L[k0]) < 1e-6 && Math.abs(R[k0]) < 1e-6) k0++;
  if (k0 >= n) throw new Error('no sound recorded');
  if ((k0 - playAt) / sr > 0.6) k0 = playAt + Math.round(captureLatency * sr);
  else captureLatency = (k0 - playAt) / sr;
  const len = Math.max(1, Math.round((end - start) * sr));
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: sr });
  out.getChannelData(0).set(L.subarray(k0, k0 + len));
  out.getChannelData(1).set(R.subarray(k0, k0 + len));
  return out;
}

/** The decodable video track of a media item, its first timestamp, and whether it is stored upright. */
export async function openVideoTrack(id) {
  const vt = await getInput(getRuntime(id)).getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('video not decodable via WebCodecs');
  const [first, rotation, flip] = await Promise.all([vt.getFirstTimestamp(), vt.getRotation(), vt.getFlip()]);
  return { vt, first, upright: !rotation && !flip };
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
    cuts.length = 0;
    prev = null;
    i = 0;
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
  store.transact(`새 ${name || kind}`, () => {
    store.project.media[id] = {
      id, kind, name: name || (kind === 'color' ? '색상 매트' : '조정 레이어'),
      duration: null, width: width || seq.width, height: height || seq.height, fps: null,
      hasAudio: false, hasVideo: true, color: color || '#000000', inPoint: null, outPoint: null, analyzed: true,
    };
    store.project.mediaOrder.push(id);
  });
  return id;
}

export function removeMedia(ids) {
  const p = store.project;
  const seqIds = ids.map((id) => p.media[id]).filter((m) => m?.kind === 'sequence').map((m) => m.sequenceId);
  if (seqIds.length && seqIds.length >= Object.keys(p.sequences).length) {
    store.toast('프로젝트에는 시퀀스가 하나 이상 있어야 합니다');
    ids = ids.filter((id) => p.media[id]?.kind !== 'sequence');
    seqIds.length = 0;
  }
  store.transact('미디어 지우기', () => {
    for (const id of ids) {
      delete p.media[id];
      p.mediaOrder = p.mediaOrder.filter((m) => m !== id);
      for (const sq of Object.values(p.sequences)) {
        for (const c of Object.values(sq.clips)) if (c.mediaId === id) delete sq.clips[c.id];
      }
    }
    for (const sid of seqIds) delete p.sequences[sid];
    if (!p.sequences[p.activeSequenceId]) p.activeSequenceId = Object.keys(p.sequences)[0];
  });
  store.pruneSelection();
  // keep the runtime (file, thumbnails, waveform) so that Undo brings the media back online;
  // only the decoder is released (it is recreated on demand)
  for (const id of ids) {
    const rt = runtime.get(id);
    if (rt) disposeInput(rt);
  }
  if (ids.includes(store.ui.sourceMediaId)) {
    store.ui.sourceMediaId = null;
    store.emit('source');
  }
}

// ---------------------------------------------------------------- LUT (.cube)

/** Parse an Adobe/Resolve .cube file (3D or 1D). Returns {size, data: Float32Array(size^3*3)} for a 3D table. */
export function parseCube(text) {
  let size3 = 0;
  let size1 = 0;
  let dmin = [0, 0, 0];
  let dmax = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_3D_SIZE')) size3 = parseInt(line.split(/\s+/)[1], 10);
    else if (up.startsWith('LUT_1D_SIZE')) size1 = parseInt(line.split(/\s+/)[1], 10);
    else if (up.startsWith('DOMAIN_MIN')) dmin = line.split(/\s+/).slice(1, 4).map(Number);
    else if (up.startsWith('DOMAIN_MAX')) dmax = line.split(/\s+/).slice(1, 4).map(Number);
    else if (/^[-+0-9.]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 3) vals.push(p[0], p[1], p[2]);
    }
  }
  const norm = (v, c) => (v - dmin[c]) / Math.max(1e-6, dmax[c] - dmin[c]);
  if (size3 >= 2) {
    const n = size3 * size3 * size3;
    if (vals.length < n * 3) throw new Error('LUT 데이터가 부족합니다');
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) data[i] = vals[i];
    return { size: size3, data, domainMin: dmin, domainMax: dmax };
  }
  if (size1 >= 2) {
    // expand a 1D LUT into a 33^3 table
    const N = 33;
    const data = new Float32Array(N * N * N * 3);
    const look = (x, c) => {
      const f = Math.min(Math.max(norm(x, c), 0), 1) * (size1 - 1);
      const i = Math.floor(f);
      const j = Math.min(size1 - 1, i + 1);
      const u = f - i;
      return vals[i * 3 + c] * (1 - u) + vals[j * 3 + c] * u;
    };
    let o = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      data[o++] = look(r / (N - 1), 0);
      data[o++] = look(g / (N - 1), 1);
      data[o++] = look(b / (N - 1), 2);
    }
    return { size: N, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
  }
  throw new Error('LUT_3D_SIZE 또는 LUT_1D_SIZE가 없는 파일입니다');
}

// ---------------------------------------------------------------- multicam audio sync

/**
 * Offsets (seconds) that line up each item's audio with the first one, by cross-correlating the
 * waveform envelopes. Items without audio get 0. maxLag limits the search window.
 */
export function audioSyncOffsets(ids, { maxLag = 30 } = {}) {
  const RATE = 50;
  const env = (id) => {
    const p = getRuntime(id).peaks;
    if (!p) return null;
    const step = p.rate / RATE;
    const out = new Float32Array(Math.floor(p.data.length / step));
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      for (let k = Math.floor(i * step); k < Math.floor((i + 1) * step); k++) m = Math.max(m, p.data[k]);
      out[i] = m;
    }
    // onset-style envelope: positive differences emphasise claps and speech starts
    const d = new Float32Array(out.length);
    for (let i = 1; i < out.length; i++) d[i] = Math.max(0, out[i] - out[i - 1]);
    let mean = 0;
    for (const v of d) mean += v;
    mean /= d.length || 1;
    for (let i = 0; i < d.length; i++) d[i] -= mean;
    return d;
  };
  const ref = env(ids[0]);
  return ids.map((id, idx) => {
    if (idx === 0 || !ref) return 0;
    const e = env(id);
    if (!e) return 0;
    const L = Math.round(maxLag * RATE);
    let best = 0;
    let bestScore = -Infinity;
    for (let lag = -L; lag <= L; lag++) {
      // e[i] aligns with ref[i + lag]: the angle starts `lag` frames after the reference
      let sum = 0;
      let n = 0;
      const i0 = Math.max(0, -lag);
      const i1 = Math.min(e.length, ref.length - lag);
      for (let i = i0; i < i1; i += 1) {
        sum += e[i] * ref[i + lag];
        n++;
      }
      if (n < RATE) continue;
      const score = sum / Math.sqrt(n);
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    return best / RATE;
  });
}

// ---------------------------------------------------------------- stabilization analysis

/**
 * Track global frame motion (translation + rotation) between [start, end) media seconds.
 * Returns {fps, t0, x, y, a} cumulative trajectories in source pixels / radians.
 */
export async function analyzeMotion(id, start, end, { onProgress = () => {}, token = {} } = {}) {
  const media = store.project.media[id];
  const rt = getRuntime(id);
  const fps = Math.min(30, media.fps || 30);
  const W = 192;
  const H = Math.max(36, Math.round((W * (media.height || 1080)) / (media.width || 1920)));
  const scale = (media.width || 1920) / W;
  const times = [];
  for (let t = start; t < end; t += 1 / fps) times.push(t);
  const gray = (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  };
  const B = 16;
  const R = 10;
  const blocks = [];
  const cols = 8;
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.round(R + B / 2 + ((W - 2 * R - B) * (c + 0.5)) / cols);
      const cy = Math.round(R + B / 2 + ((H - 2 * R - B) * (r + 0.5)) / rows);
      blocks.push([cx, cy]);
    }
  }
  const sad = (a, b, cx, cy, dx, dy, limit) => {
    let s = 0;
    for (let y = -B / 2; y < B / 2; y++) {
      const ra = (cy + y) * W + cx;
      const rb = (cy + y + dy) * W + cx + dx;
      for (let x = -B / 2; x < B / 2; x++) {
        const v = a[ra + x] - b[rb + x];
        s += v < 0 ? -v : v;
      }
      if (s > limit) return s;
    }
    return s;
  };
  const motion = (a, b) => {
    const vecs = [];
    for (const [cx, cy] of blocks) {
      // skip flat blocks (no texture to track)
      let mn = 255;
      let mx = 0;
      for (let y = -B / 2; y < B / 2; y += 2) for (let x = -B / 2; x < B / 2; x += 2) {
        const v = a[(cy + y) * W + cx + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mx - mn < 12) continue;
      let best = [0, 0];
      let bestS = Infinity;
      for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
        const v = sad(a, b, cx, cy, dx, dy, bestS);
        if (v < bestS) { bestS = v; best = [dx, dy]; }
      }
      const [bx, by] = best;
      for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) {
        if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
        const v = sad(a, b, cx, cy, dx, dy, bestS);
        if (v < bestS) { bestS = v; best = [dx, dy]; }
      }
      vecs.push([cx - W / 2, cy - H / 2, best[0], best[1]]);
    }
    if (vecs.length < 3) return [0, 0, 0];
    const med = (arr) => arr.slice().sort((p, q) => p - q)[arr.length >> 1];
    const mdx = med(vecs.map((v) => v[2]));
    const mdy = med(vecs.map((v) => v[3]));
    let num = 0;
    let den = 0;
    for (const [x, y, vx, vy] of vecs) {
      const ex = vx - mdx;
      const ey = vy - mdy;
      if (Math.abs(ex) > 4 || Math.abs(ey) > 4) continue; // outliers (moving subjects)
      num += x * ey - y * ex;
      den += x * x + y * y;
    }
    return [mdx, mdy, den ? num / den : 0];
  };

  const xs = [0];
  const ys = [0];
  const as = [0];
  let prev = null;
  const consume = (canvas, i) => {
    const g = gray(canvas);
    if (prev) {
      const [dx, dy, da] = motion(prev, g);
      xs.push(xs[xs.length - 1] + dx * scale);
      ys.push(ys[ys.length - 1] + dy * scale);
      as.push(as[as.length - 1] + da);
    }
    prev = g;
    if (i % 10 === 0) onProgress(i / times.length);
  };
  const frame = document.createElement('canvas');
  frame.width = W;
  frame.height = H;
  const fctx = frame.getContext('2d', { willReadFrequently: true });
  try {
    const input = getInput(rt);
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) throw new Error('not decodable');
    const first = await vt.getFirstTimestamp();
    const sink = new MB.CanvasSink(vt, { width: W, height: H, fit: 'fill' });
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (token.cancelled) throw new Error('취소되었습니다');
      if (wc) {
        fctx.drawImage(wc.canvas, 0, 0, W, H);
        consume(frame, i);
      }
      i++;
    }
  } catch (err) {
    if (token.cancelled) throw err;
    console.warn('motion analysis via WebCodecs failed, using <video> seeking', err);
    xs.length = ys.length = as.length = 1;
    prev = null;
    const el = document.createElement('video');
    el.muted = true;
    el.src = mediaUrl(id);
    await once(el, 'loadeddata', 15000);
    for (let i = 0; i < times.length; i++) {
      if (token.cancelled) throw new Error('취소되었습니다');
      el.currentTime = times[i];
      if (!(await once(el, 'seeked', 5000))) continue;
      fctx.drawImage(el, 0, 0, W, H);
      consume(frame, i);
    }
    el.removeAttribute('src');
    el.load();
  }
  onProgress(1);
  const round = (arr, k) => arr.map((v) => Math.round(v * k) / k);
  return { fps, t0: start, x: round(xs, 100), y: round(ys, 100), a: round(as, 100000) };
}

// ---------------------------------------------------------------- audio extraction

/** Audio file formats for "오디오 추출" and audio-only export. */
export const AUDIO_FILE_FORMATS = [
  { id: 'wav', label: 'WAV (무손실 · 파일 큼)', ext: 'wav', codec: 'pcm-s16' },
  { id: 'm4a', label: 'M4A (AAC · 작음 · 대부분 기기에서 재생)', ext: 'm4a', codec: 'aac' },
  { id: 'ogg', label: 'Ogg (Opus · 작음)', ext: 'ogg', codec: 'opus' },
];

/** Which audio formats this browser can write: {wav: true, m4a: bool, ogg: bool}. */
export async function audioFileFormatSupport() {
  const out = {};
  for (const f of AUDIO_FILE_FORMATS) {
    if (f.id === 'wav') out.wav = true;
    else out[f.id] = await MB.canEncodeAudio(f.codec, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false);
  }
  return out;
}

function audioOutputFormat(id) {
  if (id === 'm4a') return new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
  if (id === 'ogg') return new MB.OggOutputFormat();
  return new MB.WavOutputFormat();
}

/**
 * Extract the audio of a media file between [start, end) seconds into a new audio file, streamed
 * (the whole soundtrack is never held in memory). Compressed audio that already matches the
 * target codec is copied without re-encoding. Returns a Blob.
 */
export async function extractAudioFile(id, { start = 0, end = null, format = 'wav', onProgress = () => {}, token = {} } = {}) {
  const rt = getRuntime(id);
  if (!rt.file) throw new Error('파일이 연결되어 있지 않습니다 (오프라인)');
  const fmt = AUDIO_FILE_FORMATS.find((f) => f.id === format) || AUDIO_FILE_FORMATS[0];
  const input = new MB.Input({ source: new MB.BlobSource(rt.file), formats: MB.ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at) throw new Error('이 파일에는 소리가 없습니다');
    const outFormat = audioOutputFormat(fmt.id);
    const output = new MB.Output({ format: outFormat, target: new MB.BufferTarget() });
    const dur = await input.computeDuration();
    const trim = { start: Math.max(0, start), end: Math.min(end ?? dur, dur) };
    if (!(trim.end > trim.start)) throw new Error('추출할 구간이 비어 있습니다');
    const conv = await MB.Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: (track) => ({
        codec: fmt.codec,
        // the Opus encoder works at 48 kHz
        sampleRate: fmt.id === 'ogg' && track.sampleRate !== 48000 ? 48000 : undefined,
        quality: fmt.id === 'wav' ? undefined : MB.QUALITY_HIGH,
      }),
      trim,
      showWarnings: false,
    });
    if (!conv.isValid) {
      const why = conv.discardedTracks.map((d) => d.reason).join(', ');
      throw new Error(`이 브라우저에서는 이 형식으로 만들 수 없습니다 (${why || '알 수 없는 이유'})`);
    }
    conv.onProgress = (p) => onProgress(p);
    token.cancel = () => conv.cancel();
    await conv.execute();
    return new Blob([output.target.buffer], { type: outFormat.mimeType });
  } finally {
    try { input.dispose?.(); } catch { /* ignore */ }
  }
}

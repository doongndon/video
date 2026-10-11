// Export pipeline: frame-accurate render of the sequence through the same compositor used for
// preview, encoded with WebCodecs via mediabunny into MP4 or WebM; audio is mixed offline.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { playback, audioTransitionGain } from './playback.js';
import { Compositor } from './compositor.js';
import { decodeAudioRange, getRuntime, mediaStatus, mediaUrl, openVideoTrack, releaseSoundCapture } from './media.js';
import {
  audioTracks, clipEnd, clipsOnTrack, evalEffect, mediaTimeAt, sequenceDuration, transitionExtents, videoTracks, hasSpeedRamp,
} from './model.js';
import { clamp, dbToGain, once } from './util.js';
import { createChain, loadAudioWorklets } from './audio-fx.js';
import { retimeAudio } from './timestretch.js';
import { encodeGif } from './gif.js';
import { loadFontFor } from './fonts.js';

export const FORMATS = {
  mp4: { label: 'MP4 (H.264 / AAC) — 가장 널리 쓰임', ext: 'mp4', video: ['avc', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus'] },
  webm: { label: 'WebM (VP9 / Opus) — 웹용', ext: 'webm', video: ['vp9', 'vp8', 'av1'], audio: ['opus', 'vorbis'] },
  gif: { label: 'GIF (움직이는 이미지, 소리 없음)', ext: 'gif', gif: true },
  wav: { label: 'WAV (소리만, 무손실)', ext: 'wav', audioOnly: true },
  m4a: { label: 'M4A (AAC, 소리만)', ext: 'm4a', audioOnly: true, codec: 'aac' },
  ogg: { label: 'Ogg (Opus, 소리만)', ext: 'ogg', audioOnly: true, codec: 'opus' },
  png: { label: 'PNG (현재 프레임 한 장)', ext: 'png', still: true },
};

/** Export presets shown at the top of the export dialog. */
export const EXPORT_PRESETS = [
  { id: 'youtube', name: '유튜브 1080p', desc: 'MP4 · 고화질', format: 'mp4', scale: 1, quality: 'high', fps: null },
  { id: 'youtube4k', name: '유튜브 4K', desc: 'MP4 · 2배 업스케일/원본 4K', format: 'mp4', scale: 'uhd', quality: 'very-high', fps: null },
  { id: 'shorts', name: '쇼츠·릴스·틱톡', desc: 'MP4 · 세로 9:16 시퀀스용', format: 'mp4', scale: 1, quality: 'high', fps: null, vertical: true },
  { id: 'master', name: '최고 화질 보관용', desc: 'MP4 · 매우 높음', format: 'mp4', scale: 1, quality: 'very-high', fps: null },
  { id: 'small', name: '작은 파일 (공유용)', desc: 'MP4 · 절반 크기 · 중간 화질', format: 'mp4', scale: 0.5, quality: 'medium', fps: null },
  { id: 'web', name: '웹용 WebM', desc: 'VP9 · 고화질', format: 'webm', scale: 1, quality: 'high', fps: null },
  { id: 'gif', name: '움짤 (GIF)', desc: '480px · 12fps', format: 'gif', scale: 'gif', quality: 'medium', fps: 12 },
  { id: 'audio', name: '소리만 (WAV)', desc: '48kHz 16bit', format: 'wav', scale: 1, quality: 'high', fps: null },
];

/** Resolve the export range. which: 'all' | 'inout' */
export function exportRange(which) {
  const s = store.seq;
  if (which === 'inout' && s.inPoint != null && s.outPoint != null && s.outPoint > s.inPoint) return { start: s.inPoint, end: s.outPoint };
  if (which === 'inout' && s.inPoint != null) return { start: s.inPoint, end: sequenceDuration(s) };
  return { start: 0, end: sequenceDuration(s) };
}

// ---------------------------------------------------------------- frame provider

// Decoded frames as drawables {img, w, h, fit, ts, close}. Upright video hands the decoder's frames
// straight to the compositor (no copy per frame); rotated (phone portrait) or much larger video is
// drawn upright and smaller into a few reused canvases.
function frameSource(vt, first, m) {
  const sink = new MB.VideoSampleSink(vt);
  const wrap = (s) => {
    if (!s) return null;
    try {
      const f = s.toVideoFrame();
      return { img: f, w: m.width, h: m.height, fit: true, ts: s.timestamp - first, close: () => f.close() };
    } finally {
      s.close();
    }
  };
  return { from: (t) => sink.samples(t + first), wrap, at: async (t) => wrap(await sink.getSample(t + first)) };
}

function canvasSource(vt, first, m, width) {
  const height = width ? Math.round((width * m.height) / m.width) : undefined;
  // the current frame, the next one and the one being drawn are never overwritten with a pool of 4
  const sink = new MB.CanvasSink(vt, { width, height, fit: 'contain', poolSize: 4 });
  const wrap = (wc) => (wc ? { img: wc.canvas, w: m.width, h: m.height, fit: true, ts: wc.timestamp - first, close() {} } : null);
  return { from: (t) => sink.canvases(t + first), wrap, at: async (t) => wrap(await sink.getCanvas(t + first)) };
}


class ExportProvider {
  constructor(outW) {
    this.outW = outW;
    this.readers = new Map();
    this.frames = new Map();
  }

  media(id) {
    return store.project.media[id];
  }

  sequence(id) {
    return store.project.sequences[id];
  }

  lut(id) {
    return getRuntime(id).lut || null;
  }

  image(id) {
    const rt = getRuntime(id);
    if (!rt.image) return { offline: true };
    return { img: rt.image, w: rt.image.naturalWidth, h: rt.image.naturalHeight, fit: true };
  }

  videoFrame(clip, mt, key = clip.id) {
    const st = mediaStatus(clip.mediaId);
    if (st !== 'ready') return { offline: true };
    return this.frames.get(key) || null;
  }

  /** Decode the exact frame of every visible video clip (recursing into nested sequences). */
  async prepare(seq, t, prefix = '', depth = 0, angle = null) {
    if (depth === 0) {
      this.frames.clear();
      this.used = new Set();
      await this.prepare(seq, t, prefix, 1, angle);
      // a clip that is no longer on screen does not come back in a sequential pass: free its decoder
      for (const [key, r] of this.readers) {
        if (this.used.has(key)) continue;
        this.readers.delete(key);
        try { await r.close(); } catch { /* ignore */ }
      }
      return;
    }
    if (depth > 9) return;
    const vts = videoTracks(seq);
    for (const [i, tr] of vts.entries()) {
      // a multicam source only shows its active angle (hidden flags do not apply there)
      if (angle != null ? i !== angle - 1 : tr.hidden) continue;
      for (const clip of clipsOnTrack(seq, tr.id)) {
        if ((clip.kind !== 'video' && clip.kind !== 'nest') || clip.enabled === false || mediaStatus(clip.mediaId) !== 'ready') continue;
        const { lead, tail } = transitionExtents(seq, clip);
        if (t < clip.start - lead || t >= clipEnd(clip) + tail) continue;
        const m = store.project.media[clip.mediaId];
        const maxT = Math.max(0, (m.duration || 0) - 1 / (m.fps || seq.fps));
        const mt = clamp(mediaTimeAt(clip, t), 0, maxT);
        if (clip.kind === 'nest') {
          const inner = store.project.sequences[m.sequenceId];
          if (inner) await this.prepare(inner, mt, `${prefix}${clip.id}/`, depth + 1, clip.multicam && inner.multicam ? clip.multicam.angle : null);
          continue;
        }
        const key = prefix + clip.id;
        const f = await this.frameAt(clip, m, mt, key);
        if (f) this.frames.set(key, f);
      }
    }
  }

  async frameAt(clip, m, mt, key) {
    this.used?.add(key);
    let r = this.readers.get(key);
    if (!r) {
      r = await this.open(clip, m, mt);
      this.readers.set(key, r);
    }
    return r.get(mt);
  }

  async open(clip, m, mt) {
    try {
      const { vt, first, upright } = await openVideoTrack(clip.mediaId);
      // a source much larger than the output is shrunk by the sink (with mipmaps, so it stays smooth)
      const shrink = m.width > this.outW * 2 ? this.outW * 2 : undefined;
      const src = upright && !shrink && typeof VideoFrame !== 'undefined' ? frameSource(vt, first, m) : canvasSource(vt, first, m, shrink);
      if (clip.reverse) {
        let held = null;
        return {
          async get(t) {
            const f = await src.at(t);
            held?.close();
            held = f;
            return f;
          },
          close() {
            held?.close();
          },
        };
      }
      let iter = src.from(Math.max(0, mt));
      const pull = async () => src.wrap((await iter.next()).value);
      let cur = await pull();
      let next = await pull();
      let lastT = mt;
      return {
        async get(t) {
          // went backwards, or jumped far ahead (sparse sampling): restart the iterator there
          if (t < lastT - 1e-3 || (cur && t < cur.ts - 1e-3) || (cur && t - cur.ts > 1)) {
            await iter.return?.();
            cur?.close();
            next?.close();
            iter = src.from(Math.max(0, t));
            cur = await pull();
            next = await pull();
          }
          lastT = t;
          while (next && next.ts <= t + 1e-4) {
            cur?.close();
            cur = next;
            next = await pull();
          }
          return cur;
        },
        async close() {
          await iter.return?.();
          cur?.close();
          next?.close();
        },
      };
    } catch (err) {
      console.warn('WebCodecs frame reader failed, falling back to element seeking', err);
      const el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      el.src = mediaUrl(clip.mediaId);
      await once(el, 'loadeddata', 15000);
      return {
        async get(t) {
          if (Math.abs(el.currentTime - t) > 1e-3) {
            el.currentTime = t;
            await once(el, 'seeked', 5000);
          }
          return { img: el, w: m.width || el.videoWidth, h: m.height || el.videoHeight, fit: true };
        },
        close() {
          el.removeAttribute('src');
          el.load();
        },
      };
    }
  }

  async close() {
    for (const r of this.readers.values()) {
      try { await r.close(); } catch { /* ignore */ }
    }
    this.readers.clear();
  }
}

// ---------------------------------------------------------------- audio mix

/**
 * Mix the sequence's sound offline. skipped (a Map, optional): a file whose sound cannot be decoded
 * is recorded while it plays (onNote reports that), or left silent and noted there (name → reason)
 * instead of failing the whole mix.
 */
export async function renderAudioMix(seq, start, end, sampleRate = 48000, onProgress = () => {}, depth = 0, skipped = null, onNote = () => {}) {
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  try { await loadAudioWorklets(ctx); } catch { /* noise gate passes audio through */ }
  const master = ctx.createGain();
  master.gain.value = dbToGain(seq.masterVolume || 0);
  master.connect(ctx.destination);
  const anySolo = audioTracks(seq).some((t) => t.solo);
  const tracks = audioTracks(seq).filter((t) => !t.muted && (!anySolo || t.solo));
  const jobs = [];
  for (const tr of tracks) {
    for (const clip of clipsOnTrack(seq, tr.id)) {
      if (clip.kind === 'audio' && clip.enabled !== false && !clip.hold && mediaStatus(clip.mediaId) === 'ready') jobs.push({ tr, clip });
    }
  }
  const buses = new Map();
  let done = 0;
  for (const { tr, clip } of jobs) {
    const m = store.project.media[clip.mediaId];
    if (!m?.hasAudio) continue;
    const { lead, tail } = transitionExtents(seq, clip);
    let from = Math.max(clip.start - lead, start);
    let to = Math.min(clipEnd(clip) + tail, end);
    if (to <= from) continue;
    // media span consumed between [from, to) — mediaTimeAt covers speed, speed ramps and reverse
    const mA = mediaTimeAt(clip, from);
    const mB = mediaTimeAt(clip, to);
    const mdur = m.duration || Infinity;
    const lo = Math.max(0, Math.min(mA, mB));
    const hi = Math.min(mdur, Math.max(mA, mB));
    if (hi - lo < 1e-4) continue;
    const pad = 0.1;
    const srcStart = Math.max(0, lo - pad);
    const srcEnd = Math.min(mdur, hi + pad);
    let source = null;
    try {
      source = m.kind === 'sequence'
        ? (depth < 8 && store.project.sequences[m.sequenceId] ? await renderAudioMix(store.project.sequences[m.sequenceId], srcStart, srcEnd, sampleRate, () => {}, depth + 1, skipped, onNote) : null)
        : await decodeAudioRange(clip.mediaId, srcStart, srcEnd, {
          capture: !!skipped,
          onCapture: (sec, total) => onNote(`소리를 재생하며 받는 중 · ${m.name} ${Math.floor(sec)}/${Math.ceil(total)}초 (이 브라우저는 이 소리를 바로 풀지 못함)`),
        });
    } catch (err) {
      if (!skipped) throw err;
      console.warn('audio decode failed; the clip stays silent', m.name, err);
      skipped.set(m.name, err.message || String(err));
    }
    done++;
    onProgress(done / jobs.length);
    if (!source) continue;
    let buffer;
    const plain = clip.speed === 1 && !clip.reverse && !hasSpeedRamp(clip);
    if (plain) {
      buffer = source;
    } else {
      if (clip.reverse) for (let c = 0; c < source.numberOfChannels; c++) source.getChannelData(c).reverse();
      const srcLen = source.length / source.sampleRate;
      const posAt = (tOut) => {
        const mt = mediaTimeAt(clip, from + tOut);
        return clip.reverse ? srcLen - (mt - srcStart) : mt - srcStart;
      };
      buffer = retimeAudio(source, posAt, to - from, { maintainPitch: clip.maintainPitch !== false });
    }
    let bus = buses.get(tr.id);
    if (!bus) {
      const g = ctx.createGain();
      g.gain.value = dbToGain(tr.volume || 0);
      const p = ctx.createStereoPanner();
      p.pan.value = clamp((tr.pan || 0) / 100, -1, 1);
      g.connect(p).connect(master);
      bus = g;
      buses.set(tr.id, bus);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const chain = createChain(ctx, clip);
    const chainAnimated = chain?.animated(clip);
    chain?.apply(clip, Math.max(0, from - clip.start), Math.max(0, from - start), 'set');
    // automation at 100 Hz for volume keyframes, Amplify and crossfades
    const step = 0.01;
    let first = true;
    for (let t = from; t <= to + 1e-9; t += step) {
      const tl = t - clip.start;
      let db = 0;
      let bal = 0;
      for (const fx of clip.effects) {
        if (!fx.enabled) continue;
        if (fx.type === 'volume') db += evalEffect(fx, tl).level;
        else if (fx.type === 'gain') db += evalEffect(fx, tl).gain;
        else if (fx.type === 'panner') bal = evalEffect(fx, tl).balance / 100;
      }
      const g = dbToGain(db) * audioTransitionGain(seq, clip, Math.min(t, to - 1e-6));
      const at = Math.max(0, t - start);
      if (first) {
        gain.gain.setValueAtTime(g, at);
        pan.pan.setValueAtTime(clamp(bal, -1, 1), at);
        first = false;
      } else {
        gain.gain.linearRampToValueAtTime(g, at);
        pan.pan.linearRampToValueAtTime(clamp(bal, -1, 1), at);
        if (chainAnimated) chain.apply(clip, clamp(tl, 0, clip.duration), at, 'ramp');
      }
    }
    if (chain) {
      src.connect(gain).connect(chain.input);
      chain.output.connect(pan).connect(bus);
    } else src.connect(gain).connect(pan).connect(bus);
    if (plain) {
      // a transition handle can start before the media does: start later instead of shifting audio
      let offset = mA - srcStart;
      let when = from - start;
      if (offset < 0) {
        when -= offset;
        offset = 0;
      }
      const dur = to - start - when;
      if (dur > 0) src.start(Math.max(0, when), offset, dur);
    } else src.start(Math.max(0, from - start), 0, to - from);
  }
  return ctx.startRendering();
}

/** Compress a rendered mix to AAC (.m4a) or Opus (.ogg). */
async function encodeAudioBuffer(buffer, fmt, onProgress = () => {}, token = {}) {
  const ok = await MB.canEncodeAudio(fmt.codec, { numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }).catch(() => false);
  if (!ok) throw new Error(`이 브라우저는 ${fmt.label.split(' (')[0]} 소리를 만들 수 없습니다. WAV를 고르세요.`);
  const output = new MB.Output({
    format: fmt.codec === 'aac' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.OggOutputFormat(),
    target: new MB.BufferTarget(),
  });
  const src = new MB.AudioBufferSource({ codec: fmt.codec, quality: MB.QUALITY_HIGH });
  output.addAudioTrack(src);
  await output.start();
  const sr = buffer.sampleRate;
  try {
    for (let a = 0; a < buffer.length; a += sr) {
      if (token.cancelled) throw new Error('내보내기를 취소했습니다');
      await src.add(sliceBuffer(buffer, a, Math.min(buffer.length, a + sr)));
      onProgress(Math.min(1, (a + sr) / buffer.length));
    }
    await output.finalize();
  } catch (err) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
  }
  return new Blob([output.target.buffer], { type: fmt.codec === 'aac' ? 'audio/mp4' : 'audio/ogg' });
}

function sliceBuffer(buf, s0, s1) {
  const out = new AudioBuffer({ length: Math.max(1, s1 - s0), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(s0, s1));
  return out;
}

export function encodeWav(buffer) {
  const chs = buffer.numberOfChannels;
  const len = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + len * chs * 2));
  const w = (o, s) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + len * chs * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, chs, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * chs * 2, true);
  data.setUint16(32, chs * 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, len * chs * 2, true);
  const channels = [...Array(chs)].map((_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chs; c++) {
      const v = clamp(channels[c][i], -1, 1);
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- main export

/** Let the page update (progress bar) without a timer: timers are slowed down in background tabs. */
function yieldToPage() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Make sure every web font used by text clips is loaded before frames are rendered. */
export async function preloadFonts(seq) {
  if (!document.fonts) return;
  const jobs = [];
  for (const c of Object.values(seq.clips)) {
    const fx = c.effects.find((e) => e.type === 'text');
    if (!fx) continue;
    jobs.push(loadFontFor(fx.params.font.value, String(fx.params.content.value || ' '), { bold: !!fx.params.bold.value, italic: !!fx.params.italic.value }));
  }
  await Promise.all(jobs);
}

/**
 * opts: { format, scale (0..1], quality: 'low'|'medium'|'high'|'very-high', range:{start,end},
 *         audio: bool, onProgress(fraction, label), token:{cancelled} }
 * Returns { blob, filename-less ext, codec info }.
 */
export async function exportSequence(opts) {
  const seq = store.seq;
  const fmt = FORMATS[opts.format];
  const { start, end } = opts.range;
  if (end - start <= 0) throw new Error('내보낼 구간이 비어 있습니다. 타임라인에 클립이 있는지, 시작/끝 표시가 올바른지 확인하세요.');
  const token = opts.token || { cancelled: false };
  const progress = opts.onProgress || (() => {});
  playback.suspend(true);
  // keep the phone screen on: a sleeping screen pauses the page and the export with it
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not offered here */ }
  // files whose sound this browser cannot decode: exported silent and reported (name → reason)
  const skipped = new Map();
  const warnings = () => [...skipped].map(([name, why]) => `${name}: ${why}`);
  try {
    await preloadFonts(seq);
    if (fmt.audioOnly) {
      progress(0, '오디오 믹싱 중');
      const mix = await renderAudioMix(seq, start, end, 48000, (f) => progress(f * (fmt.codec ? 0.6 : 0.9), '오디오 믹싱 중'), 0, skipped, (label) => progress(0, label));
      if (fmt.codec) {
        const blob = await encodeAudioBuffer(mix, fmt, (f) => progress(0.6 + 0.39 * f, '소리 압축 중'), token);
        progress(1, '완료');
        return { blob, info: `${fmt.codec.toUpperCase()} · 48 kHz · 스테레오`, warnings: warnings() };
      }
      progress(1, '완료');
      return { blob: encodeWav(mix), info: 'PCM 16비트 · 48 kHz · 스테레오', warnings: warnings() };
    }

    const outW = Math.max(2, Math.round((seq.width * opts.scale) / 2) * 2);
    const outH = Math.max(2, Math.round((seq.height * opts.scale) / 2) * 2);
    const fps = opts.fps || seq.fps;
    if (fmt.gif) return await exportGifFrames(seq, start, end, outW, outH, fps, token, progress);
    const quality = new MB.Quality(opts.quality || 'high');

    const videoCodec = await MB.getFirstEncodableVideoCodec(fmt.video, { width: outW, height: outH, frameRate: fps, quality });
    if (!videoCodec) throw new Error(`이 브라우저는 ${fmt.label.split(' —')[0]} 영상을 만들 수 없습니다. 다른 형식을 고르거나 최신 Chrome/Edge를 사용하세요.`);
    const wantAudio = opts.audio !== false && Object.values(seq.clips).some((c) => c.kind === 'audio');
    const audioCodec = wantAudio ? await MB.getFirstEncodableAudioCodec(fmt.audio, { numberOfChannels: 2, sampleRate: 48000, quality }) : null;

    let mix = null;
    if (audioCodec) {
      progress(0, '오디오 믹싱 중');
      mix = await renderAudioMix(seq, start, end, 48000, (f) => progress(f * 0.05, '오디오 믹싱 중'), 0, skipped, (label) => progress(0, label));
    }
    if (token.cancelled) throw new Error('내보내기를 취소했습니다');

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    const compositor = new Compositor();
    const provider = new ExportProvider(outW);

    const output = new MB.Output({
      format: opts.format === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(),
      target: new MB.BufferTarget(),
    });
    const videoSource = new MB.CanvasSource(canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let audioSource = null;
    if (audioCodec && mix) {
      audioSource = new MB.AudioBufferSource({ codec: audioCodec, quality });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const total = Math.max(1, Math.round((end - start) * fps));
    const sr = mix?.sampleRate || 48000;
    let audioPos = 0;
    const started = performance.now();
    let shown = 0;
    try {
      await provider.prepare(seq, start);
      for (let i = 0; i < total; i++) {
        if (token.cancelled) throw new Error('내보내기를 취소했습니다');
        const t = start + i / fps;
        compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
        // add() takes its copy of the canvas right away, so the next frame is decoded while this one
        // is being encoded
        const added = videoSource.add(i / fps, 1 / fps);
        const nextReady = i + 1 < total ? provider.prepare(seq, start + (i + 1) / fps) : null;
        // wait for both before reacting to a failure, so nothing is still decoding while the export stops
        const [enc, dec] = await Promise.allSettled([added, nextReady]);
        if (enc.status === 'rejected') throw enc.reason;
        if (dec.status === 'rejected') throw dec.reason;
        // feed audio up to one second ahead of video
        if (audioSource && mix) {
          const want = Math.min(mix.length, Math.ceil(((i + 1) / fps + 1) * sr));
          if (want > audioPos) {
            await audioSource.add(sliceBuffer(mix, audioPos, want));
            audioPos = want;
          }
        }
        const now = performance.now();
        if (now - shown > 120 || i === total - 1) {
          shown = now;
          const elapsed = (now - started) / 1000;
          const eta = (elapsed / (i + 1)) * (total - i - 1);
          progress(0.05 + 0.93 * ((i + 1) / total), `프레임 ${i + 1} / ${total} · 약 ${Math.ceil(eta)}초 남음`);
          await yieldToPage();
        }
      }
      if (audioSource && mix && audioPos < mix.length) await audioSource.add(sliceBuffer(mix, audioPos, mix.length));
      progress(0.99, '파일 마무리 중');
      await output.finalize();
    } catch (err) {
      try { await output.cancel(); } catch { /* ignore */ }
      throw err;
    } finally {
      await provider.close();
    }
    const blob = new Blob([output.target.buffer], { type: opts.format === 'mp4' ? 'video/mp4' : 'video/webm' });
    progress(1, '완료');
    return { blob, info: `${outW}×${outH} @ ${fps} fps · ${videoCodec.toUpperCase()}${audioCodec ? ' + ' + audioCodec.toUpperCase() : ''}`, warnings: warnings() };
  } finally {
    wakeLock?.release().catch(() => {});
    releaseSoundCapture();
    playback.suspend(false);
    playback.requestRender();
  }
}

/** Render the current program frame at full sequence resolution to a PNG blob. */
/**
 * Small JPEG snapshots of the sequence (what the viewer sees) at the given times, e.g. so an AI can
 * look at the scenes. Returns [{t, blob}].
 */
export async function sampleFrames(seq, times, { maxSide = 384, quality = 0.7, onProgress = () => {}, signal } = {}) {
  const sc = Math.min(1, maxSide / Math.max(seq.width, seq.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(seq.width * sc));
  canvas.height = Math.max(2, Math.round(seq.height * sc));
  const ctx = canvas.getContext('2d');
  const provider = new ExportProvider(canvas.width);
  const comp = new Compositor();
  const out = [];
  try {
    await preloadFonts(seq);
    for (const [i, t] of times.entries()) {
      if (signal?.aborted) throw Object.assign(new Error('멈춤'), { name: 'AbortError' });
      await provider.prepare(seq, t);
      comp.render(ctx, seq, t, provider, { scale: sc });
      out.push({ t, blob: await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality)) });
      onProgress(i + 1, times.length);
    }
  } finally {
    await provider.close();
  }
  return out;
}

export async function exportFrame(t = store.ui.playhead) {
  const canvas = await exportFrameCanvas(t);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** The sequence frame at time t, full size, as a canvas (also used to open a frame in the photo editor). */
export async function exportFrameCanvas(t = store.ui.playhead) {
  const seq = store.seq;
  const canvas = document.createElement('canvas');
  canvas.width = seq.width;
  canvas.height = seq.height;
  const provider = new ExportProvider(seq.width);
  try {
    await preloadFonts(seq);
    await provider.prepare(seq, t);
    new Compositor().render(canvas.getContext('2d'), seq, t, provider, { scale: 1 });
  } finally {
    await provider.close();
  }
  return canvas;
}

// ---------------------------------------------------------------- GIF

async function exportGifFrames(seq, start, end, outW, outH, fps, token, progress) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const compositor = new Compositor();
  const provider = new ExportProvider(outW);
  const frames = [];
  const total = Math.max(1, Math.round((end - start) * fps));
  try {
    for (let i = 0; i < total; i++) {
      if (token.cancelled) throw new Error('내보내기를 취소했습니다');
      const t = start + i / fps;
      await provider.prepare(seq, t);
      compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
      frames.push(ctx.getImageData(0, 0, outW, outH).data.slice());
      if (i % 3 === 0) {
        progress(0.7 * ((i + 1) / total), `프레임 ${i + 1} / ${total}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    await provider.close();
  }
  progress(0.75, '색상표 만들고 압축하는 중');
  await new Promise((r) => setTimeout(r, 0));
  const blob = await encodeGif(frames, outW, outH, fps, (f) => progress(0.75 + 0.24 * f, 'GIF 압축 중'));
  progress(1, '완료');
  return { blob, info: `${outW}×${outH} · ${fps}fps · ${total}프레임` };
}

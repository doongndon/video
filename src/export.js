// Export pipeline: frame-accurate render of the sequence through the same compositor used for
// preview, encoded with WebCodecs via mediabunny into MP4 or WebM; audio is mixed offline.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { playback, audioTransitionGain } from './playback.js';
import { Compositor } from './compositor.js';
import { decodeAudioRange, getRuntime, mediaStatus, mediaUrl, openVideoTrack, releaseSoundCapture, interpretRatio } from './media.js';
import {
  audioTracks, clipEnd, clipsOnTrack, evalEffect, mediaTimeAt, sequenceDuration, transitionExtents, videoTracks, hasSpeedRamp,
} from './model.js';
import { clamp, dbToGain, once } from './util.js';
import { createChain, loadAudioWorklets, measureNodeDelays } from './audio-fx.js';
import { retimeAudio } from './timestretch.js';
import { encodeGif } from './gif.js';
import { loadFontFor } from './fonts.js';

/**
 * Export formats (Premiere's 형식 list). video: the codec; container: mp4 / webm; seq: an image
 * sequence in a ZIP; audioOnly: a sound file.
 */
export const FORMATS = {
  h264: { label: 'H.264 (MP4)', ext: 'mp4', container: 'mp4', video: 'avc', audio: ['aac', 'opus'] },
  hevc: { label: 'HEVC (H.265 · MP4)', ext: 'mp4', container: 'mp4', video: 'hevc', audio: ['aac', 'opus'] },
  av1: { label: 'AV1 (MP4)', ext: 'mp4', container: 'mp4', video: 'av1', audio: ['aac', 'opus'] },
  vp9: { label: 'VP9 (WebM)', ext: 'webm', container: 'webm', video: 'vp9', audio: ['opus', 'vorbis'] },
  gif: { label: '애니메이션 GIF (소리 없음)', ext: 'gif', gif: true },
  pngseq: { label: 'PNG 시퀀스 (ZIP)', ext: 'zip', seq: 'image/png', frameExt: 'png' },
  jpgseq: { label: 'JPEG 시퀀스 (ZIP)', ext: 'zip', seq: 'image/jpeg', frameExt: 'jpg' },
  wav: { label: '웨이브폼 오디오 (WAV)', ext: 'wav', audioOnly: true },
  aac: { label: 'AAC 오디오 (M4A)', ext: 'm4a', audioOnly: true, codec: 'aac' },
  opus: { label: 'Opus 오디오 (Ogg)', ext: 'ogg', audioOnly: true, codec: 'opus' },
};
// names used by earlier versions (saved presets, other modules)
const FORMAT_ALIASES = { mp4: 'h264', webm: 'vp9', m4a: 'aac', ogg: 'opus' };
export const formatId = (id) => (FORMATS[id] ? id : FORMAT_ALIASES[id] || 'h264');

/** Export presets shown at the top of the export dialog. */
export const EXPORT_PRESETS = [
  { id: 'youtube', name: '유튜브 1080p', desc: 'H.264 · 고화질', format: 'h264', scale: 1, quality: 'high', fps: null, loudness: -14 },
  { id: 'youtube4k', name: '유튜브 4K', desc: 'H.264 · 4K 폭', format: 'h264', scale: 'uhd', quality: 'very-high', fps: null, loudness: -14 },
  { id: 'shorts', name: '쇼츠·릴스·틱톡', desc: 'H.264 · 세로 9:16 시퀀스용', format: 'h264', scale: 1, quality: 'high', fps: null, vertical: true, loudness: -14 },
  { id: 'master', name: '최고 화질 보관용', desc: 'H.264 · 매우 높음', format: 'h264', scale: 1, quality: 'very-high', fps: null, maxQuality: true },
  { id: 'small', name: '작은 파일 (공유용)', desc: 'H.264 · 절반 크기', format: 'h264', scale: 0.5, quality: 'medium', fps: null },
  { id: 'web', name: '웹용 WebM', desc: 'VP9 · 고화질', format: 'vp9', scale: 1, quality: 'high', fps: null },
  { id: 'gif', name: '움짤 (GIF)', desc: '480px · 12fps', format: 'gif', scale: 'gif', quality: 'medium', fps: 12 },
  { id: 'audio', name: '소리만 (WAV)', desc: '48kHz 16비트', format: 'wav', scale: 1, quality: 'high', fps: null },
];

/**
 * Resolve the export range (소스 범위). which: 'all' (전체 시퀀스) | 'inout' (시퀀스 시작/끝) |
 * 'custom' (사용자 지정: custom = {start, end}).
 */
export function exportRange(which, custom = null) {
  const s = store.seq;
  const dur = sequenceDuration(s);
  if (which === 'custom' && custom) {
    const a = clamp(Number(custom.start) || 0, 0, dur);
    const b = clamp(Number(custom.end) || 0, 0, dur);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  if (which === 'inout' && (s.inPoint != null || s.outPoint != null)) {
    const a = clamp(s.inPoint ?? 0, 0, dur);
    const b = clamp(s.outPoint ?? dur, 0, dur);
    if (b > a) return { start: a, end: b };
  }
  return { start: 0, end: dur };
}

/** Bits per pixel and frame used to turn a 화질 setting into a bitrate (H.264; newer codecs need less). */
const BPP = { low: 0.05, medium: 0.08, high: 0.12, 'very-high': 0.2 };
const CODEC_EFFICIENCY = { avc: 1, hevc: 0.6, av1: 0.55, vp9: 0.65, vp8: 1 };

/** Typical video bitrate in Mbps for a quality setting (used for the size estimate and as a default). */
export function suggestedBitrate(codec, w, h, fps, quality = 'high') {
  return Math.max(0.2, ((w * h * fps * (BPP[quality] || BPP.high) * (CODEC_EFFICIENCY[codec] || 1)) / 1e6));
}

/** Estimated output size in bytes for export settings (see exportSequence opts). */
export function estimateExportSize(opts, seq = store.seq) {
  const fmt = FORMATS[formatId(opts.format)];
  const dur = Math.max(0, opts.range.end - opts.range.start);
  const sr = fmt.codec === 'opus' ? 48000 : opts.sampleRate || 48000;
  const ch = opts.channels || 2;
  if (fmt.audioOnly) {
    if (!fmt.codec) return Math.round(44 + dur * sr * ch * 2);
    return Math.round((dur * (opts.audioBitrate || 192) * 1000) / 8);
  }
  const { w, h } = outputSize(seq, opts.scale);
  const fps = opts.fps || seq.fps;
  const frames = Math.max(1, Math.round(dur * fps));
  if (fmt.gif) return Math.round(frames * w * h * 0.35);
  if (fmt.seq) return Math.round(frames * w * h * (fmt.seq === 'image/png' ? 1.6 : 0.25));
  const vMbps = opts.bitrate || suggestedBitrate(fmt.video, w, h, fps, opts.quality);
  const aKbps = opts.audio === false ? 0 : opts.audioBitrate || 192;
  return Math.round((dur * (vMbps * 1e6 + aKbps * 1000)) / 8);
}

/** Output frame size for a scale (fraction of the sequence size); even numbers for the encoders. */
export function outputSize(seq, scale = 1) {
  return {
    w: Math.max(2, Math.round((seq.width * scale) / 2) * 2),
    h: Math.max(2, Math.round((seq.height * scale) / 2) * 2),
  };
}

/** Which video codecs this browser can encode at a size: {avc: bool, hevc: bool, vp9: bool, av1: bool}. */
export async function encodableVideoCodecs(w = 1920, h = 1080) {
  const out = {};
  for (const c of ['avc', 'hevc', 'vp9', 'av1']) {
    out[c] = await MB.canEncodeVideo(c, { width: w, height: h }).catch(() => false);
  }
  return out;
}

/** Which audio codecs this browser can encode: {aac: bool, opus: bool}. */
export async function encodableAudioCodecs() {
  const out = {};
  for (const c of ['aac', 'opus']) out[c] = await MB.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false);
  return out;
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
        // 푸티지 해석: read the file at its own time
        const f = await this.frameAt(clip, m, mt / interpretRatio(m), key);
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
 *
 * Each clip runs: source → 오디오 게인 → effect chain → volume / crossfades → pan → track → master, the
 * same order as the live preview. Effects that look ahead (limiter, FFT-based ones) delay their output:
 * their input is started that much earlier, inside a short lead-in that is cut off afterwards.
 */
export async function renderAudioMix(seq, start, end, sampleRate = 48000, onProgress = () => {}, depth = 0, skipped = null, onNote = () => {}) {
  const LEAD = 0.5;
  const outLength = Math.max(1, Math.ceil((end - start) * sampleRate));
  const lead = Math.round(LEAD * sampleRate);
  const ctx = new OfflineAudioContext(2, outLength + lead, sampleRate);
  try { await loadAudioWorklets(ctx); } catch { /* worklet effects pass audio through */ }
  await measureNodeDelays(sampleRate);
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
    const { lead: tLead, tail } = transitionExtents(seq, clip);
    const from = Math.max(clip.start - tLead, start);
    const to = Math.min(clipEnd(clip) + tail, end);
    if (to <= from) continue;
    const chain = createChain(ctx, clip);
    const lat = Math.min(0.2, chain?.latency || 0);
    // the chain's input starts `lat` earlier where the clip has sound there
    const feed = Math.max(clip.start - tLead, from - lat);
    // media span consumed between [feed, to) — mediaTimeAt covers speed, speed ramps and reverse
    // (in file seconds: an interpreted frame rate stretches the file's time)
    const ir = interpretRatio(m);
    const mA = mediaTimeAt(clip, feed) / ir;
    const mB = mediaTimeAt(clip, to) / ir;
    const mdur = m.duration ? m.duration / ir : Infinity;
    const lo = Math.max(0, Math.min(mA, mB));
    const hi = Math.min(mdur, Math.max(mA, mB));
    if (hi - lo < 1e-4) {
      chain?.disconnect();
      continue;
    }
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
    if (!source) {
      chain?.disconnect();
      continue;
    }
    let buffer;
    const plain = clip.speed === 1 && !clip.reverse && !hasSpeedRamp(clip) && ir === 1;
    if (plain) {
      buffer = source;
    } else {
      if (clip.reverse) for (let c = 0; c < source.numberOfChannels; c++) source.getChannelData(c).reverse();
      const srcLen = source.length / source.sampleRate;
      const posAt = (tOut) => {
        const mt = mediaTimeAt(clip, feed + tOut) / ir;
        return clip.reverse ? srcLen - (mt - srcStart) : mt - srcStart;
      };
      buffer = retimeAudio(source, posAt, to - feed, { maintainPitch: clip.maintainPitch !== false });
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
    const pre = ctx.createGain();
    pre.gain.value = dbToGain(clip.gain || 0);
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    // context time of sequence time t (the lead-in comes first)
    const at = (t) => Math.max(0, t - start + LEAD);
    const chainAnimated = chain?.animated(clip);
    chain?.apply(clip, Math.max(0, feed - clip.start), at(feed) - lat, 'set');
    // automation at 100 Hz for volume keyframes, pan and crossfades (after the effects: not shifted);
    // keyframed effect parameters go `lat` earlier with the chain's input
    const step = 0.01;
    let first = true;
    for (let t = from; t <= to + 1e-9; t += step) {
      const tl = t - clip.start;
      let db = 0;
      let bal = 0;
      for (const fx of clip.effects) {
        if (!fx.enabled) continue;
        if (fx.type === 'volume') db += evalEffect(fx, tl).level;
        else if (fx.type === 'panner') bal = evalEffect(fx, tl).balance / 100;
      }
      const g = dbToGain(db) * audioTransitionGain(seq, clip, Math.min(t, to - 1e-6));
      if (first) {
        gain.gain.setValueAtTime(g, at(t));
        pan.pan.setValueAtTime(clamp(bal, -1, 1), at(t));
        first = false;
      } else {
        gain.gain.linearRampToValueAtTime(g, at(t));
        pan.pan.linearRampToValueAtTime(clamp(bal, -1, 1), at(t));
      }
    }
    if (chainAnimated) {
      for (let t = feed + step; t <= to + 1e-9; t += step) chain.apply(clip, clamp(t - clip.start, 0, clip.duration), at(t) - lat, 'ramp');
    }
    if (chain) {
      src.connect(pre).connect(chain.input);
      chain.output.connect(gain).connect(pan).connect(bus);
    } else src.connect(pre).connect(gain).connect(pan).connect(bus);
    if (plain) {
      // a transition handle can start before the media does: start later instead of shifting audio
      let offset = mA - srcStart;
      let when = at(feed) - lat;
      if (offset < 0) {
        when -= offset;
        offset = 0;
      }
      const dur = at(to) - lat - when;
      if (dur > 0) src.start(Math.max(0, when), offset, dur);
    } else src.start(Math.max(0, at(feed) - lat), 0, to - feed);
  }
  const rendered = await ctx.startRendering();
  // drop the lead-in
  const out = new AudioBuffer({ length: outLength, numberOfChannels: 2, sampleRate });
  for (let c = 0; c < 2; c++) out.getChannelData(c).set(rendered.getChannelData(c).subarray(lead, lead + outLength));
  return out;
}

/** Compress a rendered mix to AAC (.m4a) or Opus (.ogg). bitrate in kbps (optional). */
async function encodeAudioBuffer(buffer, fmt, onProgress = () => {}, token = {}, bitrate = null) {
  const ok = await MB.canEncodeAudio(fmt.codec, { numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }).catch(() => false);
  if (!ok) throw new Error(`이 브라우저는 ${fmt.label.split(' (')[0]} 소리를 만들 수 없습니다. WAV를 고르세요.`);
  const output = new MB.Output({
    format: fmt.codec === 'aac' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.OggOutputFormat(),
    target: new MB.BufferTarget(),
  });
  const src = new MB.AudioBufferSource(bitrate ? { codec: fmt.codec, bitrate: Math.round(bitrate * 1000) } : { codec: fmt.codec, quality: MB.QUALITY_HIGH });
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

/** Mix down to one channel, or resample, for the export's audio settings. */
async function conformAudio(buffer, sampleRate, channels) {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === channels) return buffer;
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.round((buffer.length * sampleRate) / buffer.sampleRate)), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // mono: both sides at half level (a centred sound keeps its loudness)
  if (channels === 1 && buffer.numberOfChannels > 1) {
    const g = ctx.createGain();
    g.gain.value = 0.5;
    g.channelCountMode = 'explicit';
    g.channelCount = 2;
    const split = ctx.createChannelSplitter(2);
    src.connect(split);
    split.connect(g, 0);
    split.connect(g, 1);
    g.connect(ctx.destination);
  } else src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
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
 * opts: { format, scale (0..1], fps, range:{start,end}, token:{cancelled}, onProgress(fraction, label),
 *   video: quality: 'low'|'medium'|'high'|'very-high' or bitrate (Mbps) with bitrateMode 'variable'|'constant',
 *          keyframeInterval (frames, 0 = automatic), maxQuality (최대 렌더링 품질),
 *   audio: audio (bool), sampleRate, channels (1|2), audioBitrate (kbps), loudness: {target, truePeak} or null }
 * Returns { blob, info, warnings, loudness }.
 */
export async function exportSequence(opts) {
  const seq = store.seq;
  const id = formatId(opts.format);
  const fmt = FORMATS[id];
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
  const channels = opts.channels === 1 ? 1 : 2;
  let loudness = null;
  /** The sequence's sound for the export: mixed, normalised (음량 정규화), at the asked rate and channels. */
  const mixdown = async (sampleRate, share) => {
    progress(0, '오디오 믹싱 중');
    let mix = await renderAudioMix(seq, start, end, 48000, (f) => progress(f * share, '오디오 믹싱 중'), 0, skipped, (label) => progress(0, label));
    mix = await conformAudio(mix, sampleRate, channels);
    // measured on the file's own channels and rate, as a loudness meter reading the file would
    if (opts.loudness) {
      progress(share, '음량 정규화 중');
      await yieldToPage();
      const { normalizeLoudness } = await import('./loudness.js');
      loudness = normalizeLoudness(mix, opts.loudness.target, opts.loudness.truePeak);
    }
    return mix;
  };
  const audioInfo = (codec, sr) => `${codec} · ${sr / 1000} kHz · ${channels === 1 ? '모노' : '스테레오'}${loudness && Number.isFinite(loudness.after.integrated) ? ` · ${loudness.after.integrated.toFixed(1)} LUFS` : ''}`;
  try {
    await preloadFonts(seq);
    if (fmt.audioOnly) {
      const sr = fmt.codec === 'opus' ? 48000 : opts.sampleRate || 48000;
      const mix = await mixdown(sr, fmt.codec ? 0.6 : 0.9);
      if (token.cancelled) throw new Error('내보내기를 취소했습니다');
      if (fmt.codec) {
        const blob = await encodeAudioBuffer(mix, fmt, (f) => progress(0.6 + 0.39 * f, '소리 압축 중'), token, opts.audioBitrate);
        progress(1, '완료');
        return { blob, info: audioInfo(`${fmt.codec.toUpperCase()}${opts.audioBitrate ? ` ${opts.audioBitrate} kbps` : ''}`, sr), warnings: warnings(), loudness };
      }
      progress(1, '완료');
      return { blob: encodeWav(mix), info: audioInfo('PCM 16비트', sr), warnings: warnings(), loudness };
    }

    const { w: outW, h: outH } = outputSize(seq, opts.scale || 1);
    const fps = opts.fps || seq.fps;
    if (fmt.gif) return await exportGifFrames(seq, start, end, outW, outH, fps, token, progress, !!opts.maxQuality);
    if (fmt.seq) return await exportImageSequence(seq, start, end, outW, outH, fps, fmt, token, progress, opts);
    const quality = new MB.Quality(opts.quality || 'high');
    const rate = opts.bitrate ? { bitrate: Math.max(50000, Math.round(opts.bitrate * 1e6)) } : { quality };
    const mode = opts.bitrateMode === 'constant' || opts.bitrateMode === 'variable' ? opts.bitrateMode : undefined;
    const canVideo = await MB.canEncodeVideo(fmt.video, { width: outW, height: outH, ...(opts.bitrate ? { bitrate: rate.bitrate } : {}) }).catch(() => false);
    if (!canVideo) throw new Error(`이 브라우저는 ${fmt.label} 영상을 만들 수 없습니다. 형식을 H.264나 VP9로 바꾸거나 최신 Chrome/Edge를 사용하세요.`);
    const wantAudio = opts.audio !== false && Object.values(seq.clips).some((c) => c.kind === 'audio');
    const sr = opts.sampleRate || 48000;
    let audioCodec = null;
    if (wantAudio) {
      for (const c of fmt.audio) {
        const csr = c === 'opus' ? 48000 : sr;
        if (await MB.canEncodeAudio(c, { numberOfChannels: channels, sampleRate: csr }).catch(() => false)) {
          audioCodec = c;
          break;
        }
      }
    }
    const audioRate = audioCodec === 'opus' ? 48000 : sr;

    let mix = null;
    if (audioCodec) mix = await mixdown(audioRate, 0.05);
    if (token.cancelled) throw new Error('내보내기를 취소했습니다');

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    // 최대 렌더링 품질: compose at the sequence size, then scale with the best filter
    const big = opts.maxQuality && (outW !== seq.width || outH !== seq.height) ? document.createElement('canvas') : null;
    if (big) {
      big.width = seq.width;
      big.height = seq.height;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    const bigCtx = big?.getContext('2d', { alpha: false });
    const compositor = new Compositor();
    const provider = new ExportProvider(opts.maxQuality ? Math.max(outW, seq.width) : outW);

    const output = new MB.Output({
      format: fmt.container === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(),
      target: new MB.BufferTarget(),
    });
    const kfi = opts.keyframeInterval > 0 ? opts.keyframeInterval / fps : 2;
    const videoSource = new MB.CanvasSource(canvas, { codec: fmt.video, ...rate, ...(mode ? { bitrateMode: mode } : {}), keyFrameInterval: kfi });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let audioSource = null;
    if (audioCodec && mix) {
      audioSource = new MB.AudioBufferSource(opts.audioBitrate ? { codec: audioCodec, bitrate: Math.round(opts.audioBitrate * 1000) } : { codec: audioCodec, quality });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const total = Math.max(1, Math.round((end - start) * fps));
    const asr = mix?.sampleRate || 48000;
    let audioPos = 0;
    const started = performance.now();
    let shown = 0;
    const draw = (t) => {
      if (big) {
        compositor.render(bigCtx, seq, t, provider, { scale: 1 });
        ctx.drawImage(big, 0, 0, outW, outH);
      } else compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
    };
    try {
      await provider.prepare(seq, start);
      for (let i = 0; i < total; i++) {
        if (token.cancelled) throw new Error('내보내기를 취소했습니다');
        const t = start + i / fps;
        draw(t);
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
          const want = Math.min(mix.length, Math.ceil(((i + 1) / fps + 1) * asr));
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
    const blob = new Blob([output.target.buffer], { type: fmt.container === 'mp4' ? 'video/mp4' : 'video/webm' });
    progress(1, '완료');
    const vInfo = `${outW}×${outH} @ ${fps} fps · ${fmt.video.toUpperCase()}${opts.bitrate ? ` ${opts.bitrate} Mbps ${mode === 'constant' ? 'CBR' : 'VBR'}` : ''}`;
    return { blob, info: `${vInfo}${audioCodec ? ` + ${audioInfo(audioCodec.toUpperCase(), audioRate)}` : ''}`, warnings: warnings(), loudness };
  } finally {
    wakeLock?.release().catch(() => {});
    releaseSoundCapture();
    playback.suspend(false);
    playback.requestRender();
  }
}

// ---------------------------------------------------------------- image sequences (ZIP)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive built from stored (uncompressed) entries; images are already compressed. */
export class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
  }

  async add(name, blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(cen.buffer), nameBytes);
    // keep the image as the browser's blob (it can live on disk), not as the bytes just read
    this.parts.push(new Uint8Array(head.buffer), nameBytes, blob);
    this.offset += 30 + nameBytes.length + data.length;
    this.count++;
    if (this.offset > 0xfffff000) throw new Error('ZIP 파일이 4GB를 넘습니다. 구간을 나누거나 크기를 줄이세요.');
  }

  finish() {
    const cenSize = this.central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}

async function exportImageSequence(seq, start, end, outW, outH, fps, fmt, token, progress, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  const compositor = new Compositor();
  const provider = new ExportProvider(opts.maxQuality ? Math.max(outW, seq.width) : outW);
  const zip = new ZipWriter();
  const total = Math.max(1, Math.round((end - start) * fps));
  const digits = Math.max(4, String(total).length);
  const base = (opts.baseName || seq.name || 'frame').replace(/[\\/:*?"<>|]+/g, '_');
  const started = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (token.cancelled) throw new Error('내보내기를 취소했습니다');
      const t = start + i / fps;
      await provider.prepare(seq, t);
      compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
      const blob = await new Promise((r) => canvas.toBlob(r, fmt.seq, 0.92));
      if (!blob) throw new Error('프레임 그림을 만들지 못했습니다 (메모리 부족일 수 있습니다)');
      await zip.add(`${base}_${String(i).padStart(digits, '0')}.${fmt.frameExt}`, blob);
      if (i % 2 === 0 || i === total - 1) {
        const eta = ((performance.now() - started) / 1000 / (i + 1)) * (total - i - 1);
        progress(0.98 * ((i + 1) / total), `프레임 ${i + 1} / ${total} · 약 ${Math.ceil(eta)}초 남음`);
        await yieldToPage();
      }
    }
  } finally {
    await provider.close();
  }
  progress(0.99, 'ZIP 파일 만드는 중');
  const blob = zip.finish();
  progress(1, '완료');
  return { blob, info: `${outW}×${outH} · ${fps} fps · ${fmt.frameExt.toUpperCase()} ${total}장`, warnings: [] };
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

/** The program frame at time t as an image blob: type 'image/png' (default) or 'image/jpeg'. */
export async function exportFrame(t = store.ui.playhead, { type = 'image/png', quality = 0.92 } = {}) {
  const canvas = await exportFrameCanvas(t);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
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

/**
 * Draw sequence frames for preview rendering (시작에서 끝까지 렌더링): frame numbers in, a JPEG per
 * frame out through onFrame(i, blob). Returns false when cancelled (token.cancelled).
 */
export async function renderPreviewFrames(seq, frames, outW, token, onFrame) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = Math.max(2, Math.round((outW * seq.height) / seq.width));
  const ctx = canvas.getContext('2d');
  const compositor = new Compositor();
  const provider = new ExportProvider(outW);
  try {
    await preloadFonts(seq);
    for (let i = 0; i < frames.length; i++) {
      if (token.cancelled) return false;
      const t = frames[i] / seq.fps;
      await provider.prepare(seq, t);
      compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
      if (blob) await onFrame(i, blob);
    }
  } finally {
    await provider.close();
  }
  return true;
}

// ---------------------------------------------------------------- GIF

async function exportGifFrames(seq, start, end, outW, outH, fps, token, progress, maxQuality = false) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const compositor = new Compositor();
  const provider = new ExportProvider(maxQuality ? Math.max(outW, seq.width) : outW);
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

// Export pipeline: frame-accurate render of the sequence through the same compositor used for
// preview, encoded with WebCodecs via mediabunny into MP4 or WebM; audio is mixed offline.

import * as MB from '../vendor/mediabunny/mediabunny.min.mjs';
import { store } from './store.js';
import { playback, audioTransitionGain } from './playback.js';
import { Compositor } from './compositor.js';
import { createFrameReader, decodeAudioRange, getRuntime, mediaStatus, mediaUrl } from './media.js';
import {
  audioTracks, clipEnd, clipsOnTrack, evalEffect, mediaTimeAt, sequenceDuration, transitionExtents, videoTracks,
} from './model.js';
import { clamp, dbToGain, once } from './util.js';
import { createChain } from './audio-fx.js';

export const FORMATS = {
  mp4: { label: 'MP4 (H.264 / AAC)', ext: 'mp4', video: ['avc', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus'] },
  webm: { label: 'WebM (VP9 / Opus)', ext: 'webm', video: ['vp9', 'vp8', 'av1'], audio: ['opus', 'vorbis'] },
  wav: { label: 'WAV (audio only)', ext: 'wav', audioOnly: true },
  png: { label: 'PNG sequence frame (current frame)', ext: 'png', still: true },
};

/** Resolve the export range. which: 'all' | 'inout' */
export function exportRange(which) {
  const s = store.seq;
  if (which === 'inout' && s.inPoint != null && s.outPoint != null && s.outPoint > s.inPoint) return { start: s.inPoint, end: s.outPoint };
  if (which === 'inout' && s.inPoint != null) return { start: s.inPoint, end: sequenceDuration(s) };
  return { start: 0, end: sequenceDuration(s) };
}

// ---------------------------------------------------------------- frame provider

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
  async prepare(seq, t, prefix = '', depth = 0) {
    if (depth === 0) this.frames.clear();
    if (depth > 8) return;
    for (const tr of videoTracks(seq)) {
      if (tr.hidden) continue;
      for (const clip of clipsOnTrack(seq, tr.id)) {
        if ((clip.kind !== 'video' && clip.kind !== 'nest') || clip.enabled === false || mediaStatus(clip.mediaId) !== 'ready') continue;
        const { lead, tail } = transitionExtents(seq, clip);
        if (t < clip.start - lead || t >= clipEnd(clip) + tail) continue;
        const m = store.project.media[clip.mediaId];
        const maxT = Math.max(0, (m.duration || 0) - 1 / (m.fps || seq.fps));
        const mt = clamp(mediaTimeAt(clip, t), 0, maxT);
        if (clip.kind === 'nest') {
          const inner = store.project.sequences[m.sequenceId];
          if (inner) await this.prepare(inner, mt, `${prefix}${clip.id}/`, depth + 1);
          continue;
        }
        const key = prefix + clip.id;
        const f = await this.frameAt(clip, m, mt, key);
        if (f) this.frames.set(key, f);
      }
    }
  }

  async frameAt(clip, m, mt, key) {
    let r = this.readers.get(key);
    if (!r) {
      r = await this.open(clip, m, mt);
      this.readers.set(key, r);
    }
    return r.get(mt);
  }

  async open(clip, m, mt) {
    try {
      const width = m.width > this.outW * 2 ? this.outW * 2 : undefined;
      const { sink, first } = await createFrameReader(clip.mediaId, width, width ? Math.round((width * m.height) / m.width) : undefined);
      const wrap = (wc) => (wc ? { img: wc.canvas, w: m.width, h: m.height, fit: true, ts: wc.timestamp - first } : null);
      if (clip.reverse) {
        return { get: async (t) => wrap(await sink.getCanvas(t + first)), close() {} };
      }
      let iter = sink.canvases(Math.max(0, mt) + first);
      let cur = wrap((await iter.next()).value);
      let next = wrap((await iter.next()).value);
      let lastT = mt;
      return {
        async get(t) {
          if (t < lastT - 1e-3 || (cur && t < cur.ts - 1e-3)) {
            // went backwards: restart iterator
            await iter.return?.();
            iter = sink.canvases(Math.max(0, t) + first);
            cur = wrap((await iter.next()).value);
            next = wrap((await iter.next()).value);
          }
          lastT = t;
          while (next && next.ts <= t + 1e-4) {
            cur = next;
            next = wrap((await iter.next()).value);
          }
          return cur;
        },
        async close() {
          await iter.return?.();
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

export async function renderAudioMix(seq, start, end, sampleRate = 48000, onProgress = () => {}, depth = 0) {
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
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
    // media span consumed between [from, to)
    let m0 = mediaTimeAt(clip, clip.reverse ? to : from);
    let m1 = mediaTimeAt(clip, clip.reverse ? from : to);
    const mdur = m.duration || Infinity;
    if (m0 < 0) {
      if (!clip.reverse) from += -m0 / clip.speed;
      else to -= -m0 / clip.speed;
      m0 = 0;
    }
    if (m1 > mdur) {
      if (!clip.reverse) to -= (m1 - mdur) / clip.speed;
      else from += (m1 - mdur) / clip.speed;
      m1 = mdur;
    }
    if (to <= from || m1 <= m0) continue;
    const buffer = m.kind === 'sequence'
      ? (depth < 8 && store.project.sequences[m.sequenceId] ? await renderAudioMix(store.project.sequences[m.sequenceId], m0, m1, sampleRate, () => {}, depth + 1) : null)
      : await decodeAudioRange(clip.mediaId, m0, m1);
    done++;
    onProgress(done / jobs.length);
    if (!buffer) continue;
    if (clip.reverse) for (let c = 0; c < buffer.numberOfChannels; c++) buffer.getChannelData(c).reverse();

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
    src.playbackRate.value = clip.speed;
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
    src.start(Math.max(0, from - start), 0, (to - from) * clip.speed);
  }
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

/** Make sure every web font used by text clips is loaded before frames are rendered. */
export async function preloadFonts(seq) {
  if (!document.fonts) return;
  const specs = new Set();
  for (const c of Object.values(seq.clips)) {
    const fx = c.effects.find((e) => e.type === 'text');
    if (!fx) continue;
    const font = fx.params.font.value;
    if (/^(sans-serif|serif|monospace)$/.test(font)) continue;
    specs.add(`${fx.params.italic.value ? 'italic ' : ''}${fx.params.bold.value ? '700' : '400'} 32px "${font}"`);
  }
  await Promise.all([...specs].map((s) => document.fonts.load(s).catch(() => null)));
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
  if (end - start <= 0) throw new Error('Nothing to export — the range is empty.');
  const token = opts.token || { cancelled: false };
  const progress = opts.onProgress || (() => {});
  playback.suspend(true);
  try {
    await preloadFonts(seq);
    if (fmt.audioOnly) {
      progress(0, 'Mixing audio');
      const mix = await renderAudioMix(seq, start, end, 48000, (f) => progress(f * 0.9, 'Mixing audio'));
      progress(1, 'Done');
      return { blob: encodeWav(mix), info: 'PCM 16-bit 48 kHz stereo' };
    }

    const outW = Math.max(2, Math.round((seq.width * opts.scale) / 2) * 2);
    const outH = Math.max(2, Math.round((seq.height * opts.scale) / 2) * 2);
    const fps = opts.fps || seq.fps;
    const quality = new MB.Quality(opts.quality || 'high');

    const videoCodec = await MB.getFirstEncodableVideoCodec(fmt.video, { width: outW, height: outH, frameRate: fps, quality });
    if (!videoCodec) throw new Error(`This browser cannot encode ${fmt.label} video. Try the other format or Chrome/Edge.`);
    const wantAudio = opts.audio !== false && Object.values(seq.clips).some((c) => c.kind === 'audio');
    const audioCodec = wantAudio ? await MB.getFirstEncodableAudioCodec(fmt.audio, { numberOfChannels: 2, sampleRate: 48000, quality }) : null;

    let mix = null;
    if (audioCodec) {
      progress(0, 'Mixing audio');
      mix = await renderAudioMix(seq, start, end, 48000, (f) => progress(f * 0.05, 'Mixing audio'));
    }
    if (token.cancelled) throw new Error('Export cancelled');

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
    try {
      for (let i = 0; i < total; i++) {
        if (token.cancelled) throw new Error('Export cancelled');
        const t = start + i / fps;
        await provider.prepare(seq, t);
        compositor.render(ctx, seq, t, provider, { scale: outW / seq.width });
        await videoSource.add(i / fps, 1 / fps);
        // feed audio up to one second ahead of video
        if (audioSource && mix) {
          const want = Math.min(mix.length, Math.ceil(((i + 1) / fps + 1) * sr));
          if (want > audioPos) {
            await audioSource.add(sliceBuffer(mix, audioPos, want));
            audioPos = want;
          }
        }
        if (i % 3 === 0 || i === total - 1) {
          const elapsed = (performance.now() - started) / 1000;
          const eta = (elapsed / (i + 1)) * (total - i - 1);
          progress(0.05 + 0.93 * ((i + 1) / total), `Frame ${i + 1} / ${total} · ${Math.ceil(eta)} s left`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (audioSource && mix && audioPos < mix.length) await audioSource.add(sliceBuffer(mix, audioPos, mix.length));
      progress(0.99, 'Finalizing');
      await output.finalize();
    } catch (err) {
      try { await output.cancel(); } catch { /* ignore */ }
      throw err;
    } finally {
      await provider.close();
    }
    const blob = new Blob([output.target.buffer], { type: opts.format === 'mp4' ? 'video/mp4' : 'video/webm' });
    progress(1, 'Done');
    return { blob, info: `${outW}×${outH} @ ${fps} fps · ${videoCodec.toUpperCase()}${audioCodec ? ' + ' + audioCodec.toUpperCase() : ''}` };
  } finally {
    playback.suspend(false);
    playback.requestRender();
  }
}

/** Render the current program frame at full sequence resolution to a PNG blob. */
export async function exportFrame(t = store.ui.playhead) {
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
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

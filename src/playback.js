// Transport (play / shuttle / step), media element synchronisation for preview, the live audio
// graph (clip gain/pan -> track bus -> master -> meters) and the preview frame provider.

import { store } from './store.js';
import { mediaUrl, getRuntime, mediaStatus } from './media.js';
import {
  clipEnd, clipsOnTrack, mediaTimeAt, transitionExtents, evalEffect, audioTracks, videoTracks,
  sequenceDuration, transitionsOnTrack,
} from './model.js';
import { Emitter, clamp, dbToGain, snapFrame } from './util.js';
import { createChain, chainSignature } from './audio-fx.js';

const MAX_VIDEO_ELEMENTS = 12;
const MAX_AUDIO_ELEMENTS = 16;
const PREROLL = 1.0;

// ---------------------------------------------------------------- element pool

class Pool {
  constructor(kind, max) {
    this.kind = kind;
    this.max = max;
    this.byClip = new Map();
    this.free = [];
  }

  get(key) {
    return this.byClip.get(key);
  }

  /** Get the element for a clip instance. key = clip id, prefixed by nest path for nested clips. */
  acquire(clip, key, onReady) {
    let e = this.byClip.get(key);
    if (e) {
      e.used = performance.now();
      if (e.mediaId !== clip.mediaId) this.setSource(e, clip.mediaId);
      return e;
    }
    e = this.free.pop() || this.create(onReady);
    e.clipId = key;
    e.used = performance.now();
    if (e.mediaId !== clip.mediaId) this.setSource(e, clip.mediaId);
    this.byClip.set(key, e);
    return e;
  }

  create(onReady) {
    const el = this.kind === 'video' ? document.createElement('video') : document.createElement('audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    if (this.kind === 'video') el.muted = true;
    el.preservesPitch = true;
    const e = { el, mediaId: null, clipId: null, target: null, seeking: false, used: 0, nodes: null };
    el.addEventListener('seeked', () => {
      e.seeking = false;
      if (e.target != null && Math.abs(el.currentTime - e.target) > 0.02 && el.paused) {
        e.seeking = true;
        el.currentTime = e.target;
      }
      onReady();
    });
    el.addEventListener('loadeddata', onReady);
    el.addEventListener('error', () => console.warn('media element error', el.error));
    return e;
  }

  setSource(e, mediaId) {
    e.mediaId = mediaId;
    e.target = null;
    e.seeking = false;
    const url = mediaUrl(mediaId);
    if (url) e.el.src = url;
    else {
      e.el.removeAttribute('src');
      e.el.load();
    }
  }

  /** Release entries not in keep, evicting least-recently-used beyond the limit. */
  trim(keep) {
    for (const [id, e] of this.byClip) {
      if (!keep.has(id) && !e.el.paused) e.el.pause();
    }
    if (this.byClip.size <= this.max) return;
    const victims = [...this.byClip.values()].filter((e) => !keep.has(e.clipId)).sort((a, b) => a.used - b.used);
    while (this.byClip.size > this.max && victims.length) {
      const v = victims.shift();
      this.byClip.delete(v.clipId);
      v.clipId = null;
      v.el.pause();
      this.free.push(v);
    }
  }

  pauseAll() {
    for (const e of this.byClip.values()) if (!e.el.paused) e.el.pause();
  }

  reset() {
    for (const e of [...this.byClip.values(), ...this.free]) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
      e.mediaId = null;
    }
    this.free.push(...this.byClip.values());
    this.byClip.clear();
  }
}

// ---------------------------------------------------------------- transport

class Playback extends Emitter {
  constructor() {
    super();
    this.playing = false;
    this.rate = 1;
    this.loop = false;
    this.range = null; // {start, end} when playing in-to-out
    this.dirty = true;
    this.renderers = new Set();
    this.lastTick = 0;
    this.suspended = false;
    this.videoPool = new Pool('video', MAX_VIDEO_ELEMENTS);
    this.audioPool = new Pool('audio', MAX_AUDIO_ELEMENTS);
    this.audio = null;
    this.trackBuses = new Map();
    this.requestRender = this.requestRender.bind(this);
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);

    store.on('change', () => this.requestRender());
    store.on('playhead', () => this.requestRender());
  }

  /** Preview frame provider used by the compositor. */
  get provider() {
    if (!this._provider) {
      this._provider = {
        media: (id) => store.project.media[id],
        sequence: (id) => store.project.sequences[id],
        videoFrame: (clip, mt, key = clip.id) => {
          const st = mediaStatus(clip.mediaId);
          if (st === 'offline' || st === 'error' || st === 'missing') return { offline: true };
          const e = this.videoPool.get(key);
          if (!e || e.el.readyState < 2) return null;
          const m = store.project.media[clip.mediaId];
          return { img: e.el, w: m?.width || e.el.videoWidth, h: m?.height || e.el.videoHeight, fit: true };
        },
        image: (id) => {
          const rt = getRuntime(id);
          if (!rt.image) return rt.status === 'loading' ? null : { offline: true };
          return { img: rt.image, w: rt.image.naturalWidth, h: rt.image.naturalHeight, fit: true };
        },
      };
    }
    return this._provider;
  }

  addRenderer(fn) {
    this.renderers.add(fn);
    this.requestRender();
    return () => this.renderers.delete(fn);
  }

  requestRender() {
    this.dirty = true;
  }

  ensureAudio() {
    if (this.audio) {
      if (this.audio.ctx.state === 'suspended') this.audio.ctx.resume().catch(() => {});
      return this.audio;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = right.fftSize = 1024;
    master.connect(ctx.destination);
    master.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    this.audio = { ctx, master, left, right, bufL: new Float32Array(1024), bufR: new Float32Array(1024) };
    return this.audio;
  }

  trackBus(trackId) {
    const a = this.ensureAudio();
    let bus = this.trackBuses.get(trackId);
    if (!bus) {
      const gain = a.ctx.createGain();
      const pan = a.ctx.createStereoPanner();
      const analyser = a.ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(pan).connect(a.master);
      pan.connect(analyser);
      bus = { gain, pan, analyser, buf: new Float32Array(512) };
      this.trackBuses.set(trackId, bus);
    }
    return bus;
  }

  /** Peak level of one track bus in dBFS (for the mixer). */
  trackLevel(trackId) {
    const bus = this.trackBuses.get(trackId);
    if (!bus) return -Infinity;
    bus.analyser.getFloatTimeDomainData(bus.buf);
    let m = 0;
    for (let i = 0; i < bus.buf.length; i++) m = Math.max(m, Math.abs(bus.buf[i]));
    return m > 0 ? 20 * Math.log10(m) : -Infinity;
  }

  /** Peak levels in dBFS for the master meters. */
  meterLevels() {
    if (!this.audio) return [-Infinity, -Infinity];
    const { left, right, bufL, bufR } = this.audio;
    left.getFloatTimeDomainData(bufL);
    right.getFloatTimeDomainData(bufR);
    const peak = (b) => {
      let m = 0;
      for (let i = 0; i < b.length; i++) {
        const v = Math.abs(b[i]);
        if (v > m) m = v;
      }
      return m > 0 ? 20 * Math.log10(m) : -Infinity;
    };
    return [peak(bufL), peak(bufR)];
  }

  // ---- transport controls

  play(rate = 1, range = null) {
    if (this.suspended) return;
    this.ensureAudio();
    const seq = store.seq;
    const end = range ? range.end : sequenceDuration(seq);
    if (rate > 0 && store.ui.playhead >= end - 1e-3) store.setPlayhead(range ? range.start : 0);
    this.range = range;
    this.rate = rate;
    this.playing = true;
    this.lastTick = performance.now();
    this.emit('state');
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    this.range = null;
    this.videoPool.pauseAll();
    this.audioPool.pauseAll();
    store.setPlayhead(snapFrame(store.ui.playhead, store.seq.fps));
    this.emit('state');
    this.requestRender();
  }

  toggle() {
    if (this.playing) this.stop();
    else this.play(1);
  }

  playInToOut() {
    const s = store.seq;
    if (s.inPoint == null || s.outPoint == null) return this.play(1);
    store.setPlayhead(s.inPoint);
    this.play(1, { start: s.inPoint, end: s.outPoint });
  }

  /** J / K / L shuttle. */
  shuttle(dir) {
    if (dir === 0) return this.stop();
    const speeds = [1, 2, 4, 8];
    if (this.playing && Math.sign(this.rate) === dir) {
      const i = speeds.indexOf(Math.abs(this.rate));
      this.rate = dir * speeds[Math.min(speeds.length - 1, i + 1)];
      this.emit('state');
    } else this.play(dir);
  }

  step(frames) {
    this.stop();
    const fps = store.seq.fps;
    store.setPlayhead(Math.max(0, snapFrame(store.ui.playhead, fps) + frames / fps));
  }

  suspend(on) {
    this.suspended = on;
    if (on) {
      this.stop();
      this.videoPool.pauseAll();
      this.audioPool.pauseAll();
    }
  }

  // ---- main loop

  tick(now) {
    requestAnimationFrame(this.tick);
    if (this.suspended) return;
    const seq = store.seq;
    if (this.playing) {
      const dt = Math.min(0.25, (now - this.lastTick) / 1000);
      this.lastTick = now;
      let t = store.ui.playhead + dt * this.rate;
      const end = this.range ? this.range.end : sequenceDuration(seq);
      const start = this.range ? this.range.start : 0;
      if (this.rate > 0 && t >= end) {
        if (this.loop && end > start) t = start;
        else {
          t = end;
          store.ui.playhead = t;
          this.stop();
          store.emit('playhead');
        }
      } else if (this.rate < 0 && t <= 0) {
        t = 0;
        store.ui.playhead = 0;
        this.stop();
        store.emit('playhead');
      }
      if (this.playing) {
        store.ui.playhead = t;
        store.emit('playhead');
      }
    }
    this.sync(store.ui.playhead);
    if (this.playing || this.dirty) {
      this.dirty = false;
      for (const fn of this.renderers) {
        try { fn(); } catch (err) { console.error('render error', err); }
      }
    }
  }

  /** Align media elements (including those inside nested sequences) with time t. */
  sync(t) {
    const seq = store.seq;
    const keepV = new Set();
    const keepA = new Set();
    // track buses of the active sequence carry track volume / pan / mute / solo
    const anySolo = audioTracks(seq).some((tr) => tr.solo);
    if (this.audio) {
      for (const tr of audioTracks(seq)) {
        const bus = this.trackBus(tr.id);
        const audible = !tr.muted && (!anySolo || tr.solo);
        bus.gain.gain.value = audible ? dbToGain(tr.volume || 0) : 0;
        bus.pan.pan.value = clamp((tr.pan || 0) / 100, -1, 1);
      }
      this.audio.master.gain.value = dbToGain(seq.masterVolume || 0);
    }
    this.visitSequence(seq, t, '', 0, { keepV, keepA, speed: 1, video: true, audio: true, busTrackId: null, gain: 1, audible: true, playing: true });
    this.videoPool.trim(keepV);
    this.audioPool.trim(keepA);
  }

  visitSequence(seq, t, prefix, depth, ctx) {
    const fps = seq.fps;
    const anySolo = audioTracks(seq).some((tr) => tr.solo);
    const playingFwd = this.playing && this.rate > 0 && ctx.playing;

    const span = (clip) => {
      const { lead, tail } = transitionExtents(seq, clip);
      const s = clip.start - lead;
      const e = clipEnd(clip) + tail;
      const active = t >= s && t < e;
      const preroll = !active && t < s && s - t <= PREROLL && this.playing;
      return { s, active, preroll };
    };

    const mediaTime = (clip, m, at) => {
      const raw = mediaTimeAt(clip, at);
      const maxT = Number.isFinite(m?.duration) ? Math.max(0, m.duration - 1 / (m.fps || fps)) : Infinity;
      return { mt: clamp(raw, 0, maxT), outside: raw < 0 || raw > maxT };
    };

    const visit = (clip, kind, track) => {
      const w = span(clip);
      if (!w.active && !w.preroll) return;
      if (mediaStatus(clip.mediaId) !== 'ready') return;
      const key = prefix + clip.id;
      const pool = kind === 'video' ? this.videoPool : this.audioPool;
      const entry = pool.acquire(clip, key, this.requestRender);
      (kind === 'video' ? ctx.keepV : ctx.keepA).add(key);
      const m = store.project.media[clip.mediaId];
      const { mt, outside } = mediaTime(clip, m, w.active ? t : w.s);
      const el = entry.el;
      if (kind === 'audio') this.updateAudioNodes(entry, seq, clip, track, t, anySolo, w.active, ctx);
      const canRoll = w.active && playingFwd && !clip.hold && !clip.reverse && !outside && clip.enabled !== false;
      if (canRoll) {
        const r = clamp(clip.speed * ctx.speed * this.rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
        const drift = el.currentTime - mt;
        if (el.paused) {
          if (Math.abs(drift) > 0.04) el.currentTime = mt;
          entry.target = null;
          el.play().catch(() => {});
        } else if (Math.abs(drift) > 0.3 * Math.max(1, this.rate)) {
          el.currentTime = mt;
        }
      } else {
        if (!el.paused) el.pause();
        if (el.readyState >= 1 && Math.abs(el.currentTime - mt) > 0.5 / fps) {
          entry.target = mt;
          if (!entry.seeking) {
            entry.seeking = true;
            el.currentTime = mt;
          }
        }
      }
    };

    /** Recurse into a nested sequence clip. */
    const nest = (clip, track, kind) => {
      if (depth >= 8) return;
      const w = span(clip);
      if (!w.active && !w.preroll) return;
      const m = store.project.media[clip.mediaId];
      const inner = m && store.project.sequences[m.sequenceId];
      if (!inner) return;
      const { mt } = mediaTime(clip, m, w.active ? t : w.s);
      const sub = {
        ...ctx,
        speed: ctx.speed * clip.speed,
        video: kind === 'video',
        audio: kind === 'audio',
        playing: ctx.playing && w.active && !clip.hold && !clip.reverse && clip.enabled !== false,
      };
      if (kind === 'audio') {
        const trackAudible = depth === 0 ? true : !track.muted && (!anySolo || track.solo);
        sub.busTrackId = ctx.busTrackId || track.id;
        sub.audible = ctx.audible && trackAudible && clip.enabled !== false && w.active && !clip.hold && !clip.reverse;
        sub.gain = ctx.gain * (depth === 0 ? 1 : dbToGain(track.volume || 0)) * clipGain(seq, clip, t);
      }
      this.visitSequence(inner, mt, `${prefix}${clip.id}/`, depth + 1, sub);
    };

    if (ctx.video) {
      for (const tr of videoTracks(seq)) {
        if (tr.hidden) continue;
        for (const c of clipsOnTrack(seq, tr.id)) {
          if (c.enabled === false) continue;
          if (c.kind === 'video') visit(c, 'video', tr);
          else if (c.kind === 'nest') nest(c, tr, 'video');
        }
      }
    }
    if (ctx.audio) {
      for (const tr of audioTracks(seq)) {
        for (const c of clipsOnTrack(seq, tr.id)) {
          if (c.kind !== 'audio') continue;
          if (store.project.media[c.mediaId]?.kind === 'sequence') nest(c, tr, 'audio');
          else visit(c, 'audio', tr);
        }
      }
    }
  }

  updateAudioNodes(entry, seq, clip, track, t, anySolo, active, ctx) {
    const a = this.ensureAudio();
    if (!entry.nodes) {
      const src = a.ctx.createMediaElementSource(entry.el);
      const gain = a.ctx.createGain();
      const pan = a.ctx.createStereoPanner();
      src.connect(gain).connect(pan);
      entry.nodes = { src, gain, pan, bus: null, chain: null, chainSig: '' };
    }
    // (re)build the clip's audio effect chain when its structure changes
    const sig = chainSignature(clip);
    if (sig !== entry.nodes.chainSig) {
      const n = entry.nodes;
      try { n.gain.disconnect(); } catch { /* not connected */ }
      n.chain?.disconnect();
      n.chain = sig ? createChain(a.ctx, clip) : null;
      if (n.chain) {
        n.gain.connect(n.chain.input);
        n.chain.output.connect(n.pan);
      } else n.gain.connect(n.pan);
      n.chainSig = sig;
    }
    entry.nodes.chain?.apply(clip, clamp(t - clip.start, 0, clip.duration), 0, 'now');
    // nested audio is routed to the bus of the outer track that holds the nest
    const bus = this.trackBus(ctx.busTrackId || track.id);
    if (entry.nodes.bus !== bus) {
      try { entry.nodes.pan.disconnect(); } catch { /* not connected */ }
      entry.nodes.pan.connect(bus.gain);
      entry.nodes.bus = bus;
    }
    let g = 0;
    let p = 0;
    if (active && ctx.audible && clip.enabled !== false && !clip.reverse && !clip.hold) {
      const nestedTrack = ctx.busTrackId ? (!track.muted && (!anySolo || track.solo) ? dbToGain(track.volume || 0) : 0) : 1;
      g = clipGain(seq, clip, t) * ctx.gain * nestedTrack;
      const pfx = clip.effects.find((fx) => fx.type === 'panner' && fx.enabled);
      if (pfx) p = evalEffect(pfx, t - clip.start).balance / 100;
    }
    entry.nodes.gain.gain.setTargetAtTime(g, a.ctx.currentTime, 0.01);
    entry.nodes.pan.pan.value = clamp(p, -1, 1);
  }

  /** Drop all elements (after load / relink). */
  resetMedia() {
    this.videoPool.reset();
    this.audioPool.reset();
    this.requestRender();
  }
}

/** Linear gain of an audio clip at time t: Volume + Amplify + crossfades. */
export function clipGain(seq, clip, t) {
  const tl = t - clip.start;
  let db = 0;
  for (const fx of clip.effects) {
    if (!fx.enabled) continue;
    if (fx.type === 'volume') db += evalEffect(fx, tl).level;
    else if (fx.type === 'gain') db += evalEffect(fx, tl).gain;
  }
  return dbToGain(db) * audioTransitionGain(seq, clip, t);
}

/** Gain multiplier from audio transitions touching a clip at time t. */
export function audioTransitionGain(seq, clip, t) {
  let g = 1;
  for (const w of transitionsOnTrack(seq, clip.trackId)) {
    if (t < w.start || t >= w.end) continue;
    if (w.a?.id !== clip.id && w.b?.id !== clip.id) continue;
    const p = clamp((t - w.start) / Math.max(1e-6, w.end - w.start), 0, 1);
    const isIncoming = w.b?.id === clip.id;
    const x = w.a && w.b ? (isIncoming ? p : 1 - p) : w.edge === 'in' ? p : 1 - p;
    g *= w.type === 'constantGain' ? x : Math.sin((x * Math.PI) / 2);
  }
  return g;
}

export const playback = new Playback();

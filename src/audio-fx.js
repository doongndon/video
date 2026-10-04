// Audio effect chains built from Web Audio nodes. The same builder is used for live preview
// (AudioContext) and export (OfflineAudioContext) so both sound identical.

import { EFFECTS } from './effects.js';
import { evalEffect } from './model.js';
import { dbToGain, clamp } from './util.js';

/** Audio effects handled by the chain (Volume/Panner/Amplify are applied as plain gain/pan). */
export const CHAIN_FX = new Set(['eq3', 'highpass', 'lowpass', 'compressor', 'reverb', 'delay', 'bandpass', 'noiseGate', 'humRemove', 'ringMod']);

// ---- AudioWorklet processors (loaded from a blob so the app needs no extra files)
const WORKLET_SRC = `
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45 },
      { name: 'reduction', defaultValue: -40 },
      { name: 'attack', defaultValue: 5 },
      { name: 'release', defaultValue: 150 },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 1; }
  process(inputs, outputs, p) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const thr = Math.pow(10, p.threshold[0] / 20);
    const red = Math.pow(10, p.reduction[0] / 20);
    const att = Math.exp(-1 / (sampleRate * Math.max(0.1, p.attack[0]) / 1000));
    const rel = Math.exp(-1 / (sampleRate * Math.max(1, p.release[0]) / 1000));
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > peak) peak = v; }
      this.env = peak > this.env ? peak : this.env * 0.9995;
      const target = this.env >= thr ? 1 : red;
      const coef = target > this.gain ? att : rel;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('montage-gate', GateProcessor);
`;

const workletReady = new WeakSet();
const workletLoading = new WeakMap();

/** Load the app's AudioWorklet processors into a context (idempotent). */
export function loadAudioWorklets(ctx) {
  if (workletReady.has(ctx)) return Promise.resolve();
  if (!ctx.audioWorklet) return Promise.reject(new Error('AudioWorklet unsupported'));
  if (!workletLoading.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    workletLoading.set(ctx, ctx.audioWorklet.addModule(url).then(() => {
      workletReady.add(ctx);
      URL.revokeObjectURL(url);
    }));
  }
  return workletLoading.get(ctx);
}

export function chainEffects(clip) {
  return clip.effects.filter((e) => e.enabled && CHAIN_FX.has(e.type) && EFFECTS[e.type]);
}

/** Structural signature: rebuild the chain only when this changes. */
export function chainSignature(clip, ctx) {
  return chainEffects(clip).map((e) => {
    const extra = e.type === 'reverb' ? e.params.decay.value
      : e.type === 'humRemove' ? `${e.params.freq.value}/${e.params.harmonics.value}/${e.params.q.value}`
        : e.type === 'noiseGate' ? (ctx && workletReady.has(ctx) ? 'ready' : 'pending') : '';
    return `${e.id}:${e.type}:${extra}`;
  }).join('|');
}

const irCache = new Map();
function impulseResponse(ctx, seconds) {
  const key = `${ctx.sampleRate}:${seconds.toFixed(2)}`;
  if (irCache.has(key) && irCache.get(key).ctx === ctx) return irCache.get(key).buf;
  const len = Math.max(1, Math.floor(ctx.sampleRate * clamp(seconds, 0.1, 10)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  // seeded noise so the preview and every export sound the same
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  irCache.set(key, { ctx, buf });
  return buf;
}

/**
 * Build a chain for the clip's audio effects. Returns null when there are none.
 * chain.apply(clip, tLocal, when, mode) pushes current parameter values:
 *   mode 'now'  -> set .value (preview), 'set' / 'ramp' -> automation at `when` (export).
 */
export function createChain(ctx, clip) {
  const fxs = chainEffects(clip);
  if (!fxs.length) return null;
  const input = ctx.createGain();
  const output = ctx.createGain();
  const units = [];
  let prev = input;
  for (const fx of fxs) {
    const u = buildUnit(ctx, fx);
    prev.connect(u.input);
    prev = u.output;
    units.push(u);
  }
  prev.connect(output);
  return {
    input,
    output,
    units,
    apply(c, tLocal, when = 0, mode = 'now') {
      for (const u of units) {
        const fx = c.effects.find((e) => e.id === u.fxId);
        if (fx) u.apply(evalEffect(fx, tLocal), when, mode);
      }
    },
    animated(c) {
      return units.some((u) => {
        const fx = c.effects.find((e) => e.id === u.fxId);
        return fx && Object.values(fx.params).some((p) => p.kf?.length);
      });
    },
    disconnect() {
      try { input.disconnect(); } catch { /* ignore */ }
      try { output.disconnect(); } catch { /* ignore */ }
    },
  };
}

function setParam(param, value, when, mode) {
  if (!Number.isFinite(value)) return;
  if (mode === 'now') param.value = value;
  else if (mode === 'ramp') param.linearRampToValueAtTime(value, when);
  else param.setValueAtTime(value, when);
}

function buildUnit(ctx, fx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const unit = { fxId: fx.id, input, output, apply() {} };
  switch (fx.type) {
    case 'eq3': {
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      input.connect(low).connect(mid).connect(high).connect(output);
      unit.apply = (v, when, mode) => {
        setParam(low.frequency, v.lowFreq, when, mode);
        setParam(low.gain, v.lowGain, when, mode);
        setParam(mid.frequency, v.midFreq, when, mode);
        setParam(mid.gain, v.midGain, when, mode);
        setParam(mid.Q, v.midQ, when, mode);
        setParam(high.frequency, v.highFreq, when, mode);
        setParam(high.gain, v.highGain, when, mode);
      };
      break;
    }
    case 'highpass':
    case 'lowpass':
    case 'bandpass': {
      const f = ctx.createBiquadFilter();
      f.type = fx.type;
      input.connect(f).connect(output);
      unit.apply = (v, when, mode) => {
        setParam(f.frequency, v.frequency, when, mode);
        setParam(f.Q, v.q, when, mode);
      };
      break;
    }
    case 'compressor': {
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      input.connect(comp).connect(makeup).connect(output);
      unit.apply = (v, when, mode) => {
        setParam(comp.threshold, v.threshold, when, mode);
        setParam(comp.ratio, v.ratio, when, mode);
        setParam(comp.knee, v.knee, when, mode);
        setParam(comp.attack, v.attack / 1000, when, mode);
        setParam(comp.release, v.release / 1000, when, mode);
        setParam(makeup.gain, dbToGain(v.makeup), when, mode);
      };
      break;
    }
    case 'reverb': {
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = impulseResponse(ctx, fx.params.decay.value);
      input.connect(dry).connect(output);
      input.connect(conv).connect(wet).connect(output);
      unit.apply = (v, when, mode) => {
        const m = clamp(v.mix / 100, 0, 1);
        setParam(dry.gain, 1 - m * 0.5, when, mode);
        setParam(wet.gain, m, when, mode);
      };
      break;
    }
    case 'delay': {
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const delay = ctx.createDelay(5);
      const fb = ctx.createGain();
      input.connect(dry).connect(output);
      input.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(wet).connect(output);
      unit.apply = (v, when, mode) => {
        setParam(delay.delayTime, clamp(v.time, 0.01, 5), when, mode);
        setParam(fb.gain, clamp(v.feedback / 100, 0, 0.95), when, mode);
        setParam(wet.gain, clamp(v.mix / 100, 0, 1), when, mode);
        setParam(dry.gain, 1, when, mode);
      };
      break;
    }
    case 'noiseGate': {
      if (!workletReady.has(ctx)) {
        input.connect(output); // processor not loaded yet: pass audio through
        break;
      }
      const node = new AudioWorkletNode(ctx, 'montage-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      input.connect(node).connect(output);
      unit.apply = (v, when, mode) => {
        for (const k of ['threshold', 'reduction', 'attack', 'release']) setParam(node.parameters.get(k), v[k], when, mode);
      };
      break;
    }
    case 'ringMod': {
      // multiply the voice by a sine wave: the classic robot / Dalek sound
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.frequency.value = fx.params.freq.value;
      osc.connect(ring.gain);
      osc.start();
      input.connect(dry).connect(output);
      input.connect(ring).connect(wet).connect(output);
      unit.apply = (v, when, mode) => {
        const m = clamp(v.mix / 100, 0, 1);
        setParam(osc.frequency, v.freq, when, mode);
        setParam(wet.gain, m, when, mode);
        setParam(dry.gain, 1 - m, when, mode);
      };
      break;
    }
    case 'humRemove': {
      const base = Number(fx.params.freq.value) || 60;
      const n = Math.max(1, Math.min(8, Math.round(fx.params.harmonics.value)));
      let prev = input;
      for (let k = 1; k <= n; k++) {
        const f = ctx.createBiquadFilter();
        f.type = 'notch';
        f.frequency.value = Math.min(base * k, ctx.sampleRate / 2 - 100);
        f.Q.value = fx.params.q.value;
        prev.connect(f);
        prev = f;
      }
      prev.connect(output);
      break;
    }
    default:
      input.connect(output);
  }
  return unit;
}

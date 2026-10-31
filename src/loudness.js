// Loudness measurement after ITU-R BS.1770-4 / EBU R 128: K-weighted, gated integrated loudness
// (LUFS), momentary / short-term maxima, sample peak and true peak (4x oversampled), plus loudness
// normalisation with a true-peak limiter for export, and clip / sequence measurement helpers.

import { store } from './store.js';
import { renderAudioMix } from './export.js';
import { clipEnd, sequenceDuration } from './model.js';
import { deepClone } from './util.js';

const ABS_GATE = -70;

/** The two K-weighting biquads (high shelf, then high pass) for a sample rate (libebur128 design). */
function kFilters(sr) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/** Sum of K-weighted squares per 100 ms segment of one channel. */
function segmentEnergy(data, sr, seg) {
  const [f1, f2] = kFilters(sr);
  const nSeg = Math.ceil(data.length / seg);
  const out = new Float64Array(nSeg);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1 state (direct form I)
  let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // stage 2 state
  for (let s = 0; s < nSeg; s++) {
    const end = Math.min(data.length, (s + 1) * seg);
    let acc = 0;
    for (let i = s * seg; i < end; i++) {
      const x = data[i];
      const y = f1.b0 * x + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = f2.b0 * y + f2.b1 * u1 + f2.b2 * u2 - f2.a1 * v1 - f2.a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      acc += v * v;
    }
    out[s] = acc;
  }
  return out;
}

const lufs = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

// 4x oversampling interpolator for true peak: windowed sinc, 4 phases × 16 taps
const TP_TAPS = 16;
const TP_KERNEL = (() => {
  const k = [];
  for (let ph = 0; ph < 4; ph++) {
    const row = new Float64Array(TP_TAPS);
    const frac = ph / 4;
    let sum = 0;
    for (let j = 0; j < TP_TAPS; j++) {
      const x = j - (TP_TAPS / 2 - 1) - frac;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TP_TAPS / 2 + 1));
      row[j] = sinc * w;
      sum += row[j];
    }
    for (let j = 0; j < TP_TAPS; j++) row[j] /= sum;
    k.push(row);
  }
  return k;
})();

function truePeakOf(data, samplePeak) {
  // only the neighbourhood of loud samples can hold an inter-sample peak above the sample peak
  const near = samplePeak * 0.5;
  let tp = samplePeak;
  const n = data.length;
  const off = TP_TAPS / 2 - 1;
  for (let i = 0; i < n - 1; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    const b = data[i + 1] < 0 ? -data[i + 1] : data[i + 1];
    if (a < near && b < near) continue;
    for (let ph = 1; ph < 4; ph++) {
      const row = TP_KERNEL[ph];
      let acc = 0;
      for (let j = 0; j < TP_TAPS; j++) {
        const idx = i - off + j;
        if (idx >= 0 && idx < n) acc += row[j] * data[idx];
      }
      const v = acc < 0 ? -acc : acc;
      if (v > tp) tp = v;
    }
  }
  return tp;
}

const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * Measure an AudioBuffer (or {sampleRate, channels: Float32Array[]}). Returns
 * { integrated, momentaryMax, shortTermMax, range (LRA), samplePeak, truePeak } in LUFS / LU / dBFS / dBTP.
 */
export function measureLoudness(buffer, { truePeak = true } = {}) {
  const sr = buffer.sampleRate;
  const chans = buffer.channels || Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const seg = Math.round(sr * 0.1);
  const energies = chans.map((d) => segmentEnergy(d, sr, seg));
  const nSeg = energies[0]?.length || 0;
  // per-segment K-weighted energy summed over channels (all weights 1 for L/R)
  const segE = new Float64Array(nSeg);
  for (const e of energies) for (let s = 0; s < nSeg; s++) segE[s] += e[s];
  const blocks = [];
  for (let s = 0; s + 4 <= nSeg; s++) blocks.push((segE[s] + segE[s + 1] + segE[s + 2] + segE[s + 3]) / (4 * seg));
  // a sound shorter than one block is measured as one block
  if (!blocks.length && nSeg) blocks.push(segE.reduce((x, y) => x + y, 0) / Math.max(1, chans[0].length));
  let momentaryMax = -Infinity;
  const above = [];
  for (const z of blocks) {
    const l = lufs(z);
    if (l > momentaryMax) momentaryMax = l;
    if (l > ABS_GATE) above.push(z);
  }
  let integrated = -Infinity;
  if (above.length) {
    const rel = lufs(above.reduce((x, y) => x + y, 0) / above.length) - 10;
    const gated = above.filter((z) => lufs(z) > rel);
    if (gated.length) integrated = lufs(gated.reduce((x, y) => x + y, 0) / gated.length);
  }
  // short-term: 3 s windows every 100 ms; loudness range (EBU Tech 3342) from their distribution
  const st = [];
  for (let s = 0; s + 30 <= nSeg; s++) {
    let e = 0;
    for (let k = 0; k < 30; k++) e += segE[s + k];
    st.push(lufs(e / (30 * seg)));
  }
  const shortTermMax = st.length ? Math.max(...st) : momentaryMax;
  let range = 0;
  const stAbs = st.filter((l) => l > ABS_GATE);
  if (stAbs.length > 1) {
    const meanE = stAbs.reduce((x, l) => x + 10 ** ((l + 0.691) / 10), 0) / stAbs.length;
    const relGate = lufs(meanE) - 20;
    const sorted = stAbs.filter((l) => l > relGate).sort((a, b) => a - b);
    if (sorted.length > 1) range = sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.1 * (sorted.length - 1))];
  }
  let sp = 0;
  for (const d of chans) for (let i = 0; i < d.length; i++) {
    const v = d[i] < 0 ? -d[i] : d[i];
    if (v > sp) sp = v;
  }
  let tp = sp;
  if (truePeak) for (const d of chans) tp = Math.max(tp, truePeakOf(d, sp));
  return { integrated, momentaryMax, shortTermMax, range, samplePeak: toDb(sp), truePeak: toDb(tp) };
}

/**
 * Look-ahead peak limiter over whole channels (linked), in place: no sample ends up above `ceilingDb`.
 * Each sample's gain is the average, over the look-ahead window, of a curve that is never above what
 * any sample in that window needs — a smooth ramp that still always gets there in time.
 */
export function limitChannels(chans, sr, ceilingDb, { lookahead = 0.0015, release = 0.05 } = {}) {
  const ceil = 10 ** (ceilingDb / 20);
  const n = chans[0].length;
  const L = Math.max(1, Math.round(lookahead * sr));
  const size = L + 1;
  const req = new Float64Array(size).fill(1);
  const dq = new Float64Array(size);
  let dh = 0;
  let dt = 0;
  let dc = 0;
  const box = new Float64Array(size).fill(1);
  let sum = size;
  let bi = 0;
  const relC = Math.exp(-1 / (release * sr));
  let r = 1;
  for (let j = 0; j < n + L; j++) {
    let q = 1;
    if (j < n) {
      let p = 0;
      for (const d of chans) {
        const v = d[j] < 0 ? -d[j] : d[j];
        if (v > p) p = v;
      }
      if (p > ceil) q = ceil / p;
    }
    req[j % size] = q;
    while (dc > 0) {
      const back = (dt - 1 + size) % size;
      if (req[dq[back] % size] >= q) {
        dt = back;
        dc--;
      } else break;
    }
    dq[dt] = j;
    dt = (dt + 1) % size;
    dc++;
    while (dq[dh] < j - L) {
      dh = (dh + 1) % size;
      dc--;
    }
    const m = req[dq[dh] % size]; // smallest need from j - L to j
    const rel = r + (1 - r) * (1 - relC);
    r = m < rel ? m : rel;
    sum += r - box[bi];
    box[bi] = r;
    bi = (bi + 1) % size;
    const i = j - L;
    if (i >= 0) {
      const g = Math.min(1, sum / size);
      if (g < 1) for (const d of chans) d[i] *= g;
    }
  }
}

/**
 * Normalise an AudioBuffer in place to `target` LUFS, keeping the true peak at or below `maxTruePeak`
 * dBTP with a limiter. Returns { gainDb, before, after } (after is measured again).
 */
export function normalizeLoudness(buffer, target = -14, maxTruePeak = -1) {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const before = measureLoudness(buffer, { truePeak: false });
  if (!Number.isFinite(before.integrated)) return { gainDb: 0, before, after: before };
  const gainDb = target - before.integrated;
  const g = 10 ** (gainDb / 20);
  for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= g;
  let after = measureLoudness(buffer);
  // true peak above the ceiling: limit the sample peaks a little lower, check, tighten once more
  let ceiling = maxTruePeak - 0.5;
  for (let pass = 0; pass < 3 && after.truePeak > maxTruePeak + 0.05; pass++) {
    limitChannels(chans, buffer.sampleRate, ceiling);
    after = measureLoudness(buffer);
    ceiling -= Math.max(0.3, after.truePeak - maxTruePeak);
  }
  return { gainDb, before, after };
}

// ---------------------------------------------------------------- clips and sequences

/**
 * The sound of one audio clip as it leaves its effects (audio gain and effects included, Volume,
 * crossfades and the track left out unless withVolume), rendered offline at 48 kHz.
 */
export async function renderClipSound(clipId, { withVolume = false, gainDb = null } = {}) {
  const seq = store.seq;
  const clip = seq.clips[clipId];
  if (!clip || clip.kind !== 'audio') return null;
  const c = deepClone(clip);
  c.transIn = null;
  c.transOut = null;
  if (gainDb != null) c.gain = gainDb;
  if (!withVolume) {
    for (const fx of c.effects) {
      if (fx.type === 'volume') {
        fx.params.level.value = 0;
        fx.params.level.kf = null;
      }
      if (fx.type === 'panner') {
        fx.params.balance.value = 0;
        fx.params.balance.kf = null;
      }
    }
  }
  const track = { ...seq.tracks.find((t) => t.id === clip.trackId), muted: false, solo: false, volume: 0, pan: 0 };
  const solo = { ...seq, tracks: [track], clips: { [c.id]: c }, masterVolume: 0 };
  return renderAudioMix(solo, clip.start, clipEnd(clip), 48000, () => {}, 0, new Map());
}

/** Loudness of a clip's sound (see renderClipSound). */
export async function measureClip(clipId, opts) {
  const buf = await renderClipSound(clipId, opts);
  return buf ? measureLoudness(buf) : null;
}

/** Loudness of the active sequence (or a range of it) as exported. */
export async function measureSequence(start = 0, end = sequenceDuration(store.seq), onProgress = () => {}) {
  if (end - start <= 0) return null;
  const buf = await renderAudioMix(store.seq, start, end, 48000, onProgress, 0, new Map());
  return measureLoudness(buf);
}

/**
 * Audio gain (dB, clip.gain) that brings a clip's sound to `target` LUFS. Measured through the clip's
 * effects; compressors and limiters change loudness by less than the gain, so the gain is refined by
 * the secant method from the levels measured at two gains (up to five renders, ±0.2 LU).
 */
export async function matchClipLoudness(clipId, target) {
  const clip = store.seq.clips[clipId];
  if (!clip) return null;
  const limit = (g) => Math.max(-60, Math.min(60, g));
  let ga = clip.gain || 0;
  const m0 = await measureClip(clipId, { gainDb: ga });
  if (!m0 || !Number.isFinite(m0.integrated)) return null;
  let la = m0.integrated;
  let gb = limit(ga + (target - la));
  let lb = (await measureClip(clipId, { gainDb: gb }))?.integrated;
  for (let i = 0; i < 3 && Number.isFinite(lb) && Math.abs(lb - target) > 0.2; i++) {
    // output dB per input dB between the last two tries
    const slope = Math.abs(gb - ga) > 1e-3 ? Math.max(0.05, Math.min(2, (lb - la) / (gb - ga))) : 1;
    const gc = limit(gb + (target - lb) / slope);
    ga = gb;
    la = lb;
    gb = gc;
    lb = (await measureClip(clipId, { gainDb: gb }))?.integrated;
  }
  return { gainDb: Math.round(gb * 10) / 10, measured: m0.integrated, result: lb };
}

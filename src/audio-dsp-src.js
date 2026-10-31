// AudioWorklet processors for the audio effects that Web Audio has no node for: dynamics (gate,
// expander, compressor, limiter), look-ahead hard limiter, de-esser, multiband compressor,
// spectral noise / reverb reduction and a phase-vocoder pitch shifter. The same code runs in the
// live preview (AudioContext) and in export (OfflineAudioContext), so both sound the same.
// Loaded from a blob by audio-fx.js; keep this plain ES5-ish code without imports.

export const DSP_WORKLET_SRC = String.raw`
const LN10_20 = Math.LN10 / 20;
const dbToLin = (d) => Math.exp(d * LN10_20);
const linToDb = (x) => (x > 1e-10 ? 20 * Math.log10(x) : -200);
// one-pole smoothing coefficient for a time constant in ms
const coefMs = (ms) => (ms > 0 ? Math.exp(-1 / ((sampleRate * ms) / 1000)) : 0);
const kParam = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: 'k-rate' });

// RBJ audio EQ cookbook biquad (transposed direct form II, doubles)
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, gainDb) {
    const w = (2 * Math.PI * Math.min(Math.max(f, 1), sampleRate * 0.49)) / sampleRate;
    const cs = Math.cos(w);
    const sn = Math.sin(w);
    const alpha = sn / (2 * Math.max(q, 1e-3));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; }
    else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; }
    else if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; }
    else if (type === 'allpass') { b0 = 1 - alpha; b1 = -2 * cs; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; }
    else if (type === 'peaking') { b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// in-place radix-2 complex FFT; inverse is unnormalised
function makeFFT(N) {
  const bits = Math.round(Math.log2(N));
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cs = new Float64Array(N / 2);
  const sn = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos((2 * Math.PI * i) / N); sn[i] = Math.sin((2 * Math.PI * i) / N); }
  return (re, im, inverse) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cs[k];
          const s = sign * sn[k];
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

function hann(N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  return w;
}

// Base: the main thread posts 'dispose' when a chain is torn down; the processor then stops.
class Proc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dead = false;
    this.port.onmessage = (e) => { if (e.data === 'dispose') this.dead = true; };
  }
}

// ---------------------------------------------------------------- dynamics (Premiere "Dynamics")
class DynamicsProcessor extends Proc {
  static get parameterDescriptors() {
    return [
      kParam('gateOn', 0), kParam('gateThr', -50), kParam('gateAtk', 2), kParam('gateRel', 150), kParam('gateHold', 50),
      kParam('expOn', 0), kParam('expThr', -45), kParam('expRatio', 2),
      kParam('compOn', 1), kParam('compThr', -20), kParam('compRatio', 4), kParam('compAtk', 10), kParam('compRel', 150), kParam('compMakeup', 0),
      kParam('limOn', 1), kParam('limThr', -1), kParam('limRel', 60), kParam('outGain', 0),
    ];
  }
  constructor() {
    super();
    this.env = 0; this.gate = 1; this.hold = 0; this.grComp = 0; this.lim = 1;
    this.detA = coefMs(0.3); this.detR = coefMs(40);
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const gateOn = p.gateOn[0] > 0.5, expOn = p.expOn[0] > 0.5, compOn = p.compOn[0] > 0.5, limOn = p.limOn[0] > 0.5;
    const gThr = p.gateThr[0], gA = coefMs(p.gateAtk[0]), gR = coefMs(p.gateRel[0]), holdN = Math.round((p.gateHold[0] * sampleRate) / 1000);
    const eThr = p.expThr[0], eRatio = Math.max(1, p.expRatio[0]);
    const cThr = p.compThr[0], cSlope = 1 - 1 / Math.max(1, p.compRatio[0]), cA = coefMs(p.compAtk[0]), cR = coefMs(p.compRel[0]);
    const makeup = p.compMakeup[0];
    const lThr = dbToLin(p.limThr[0]), lR = coefMs(p.limRel[0]);
    const og = dbToLin(p.outGain[0]);
    const KNEE = 4;
    for (let i = 0; i < n; i++) {
      const l = L ? L[i] : 0;
      const r = R ? R[i] : 0;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.env = pk > this.env ? this.detA * this.env + (1 - this.detA) * pk : this.detR * this.env + (1 - this.detR) * pk;
      const lvl = linToDb(this.env);
      let target = 1;
      if (gateOn) {
        if (lvl > gThr) this.hold = holdN;
        else if (this.hold > 0) this.hold--;
        target = lvl > gThr || this.hold > 0 ? 1 : 0;
      }
      this.gate = target > this.gate ? gA * this.gate + (1 - gA) * target : gR * this.gate + (1 - gR) * target;
      let db = 0;
      if (expOn && lvl < eThr) db -= Math.min(80, (eThr - lvl) * (eRatio - 1));
      if (compOn) {
        const over = linToDb(pk) - cThr;
        let gr = 0;
        if (over > KNEE / 2) gr = over * cSlope;
        else if (over > -KNEE / 2) gr = (((over + KNEE / 2) * (over + KNEE / 2)) / (2 * KNEE)) * cSlope;
        this.grComp = gr > this.grComp ? cA * this.grComp + (1 - cA) * gr : cR * this.grComp + (1 - cR) * gr;
        db += makeup - this.grComp;
      }
      const g = (db !== 0 ? dbToLin(db) : 1) * this.gate * og;
      let yl = l * g;
      let yr = r * g;
      if (limOn) {
        const p2 = Math.max(Math.abs(yl), Math.abs(yr));
        const need = p2 > lThr ? lThr / p2 : 1;
        const rel = lR * this.lim + (1 - lR);
        this.lim = need < rel ? need : rel;
        yl *= this.lim;
        yr *= this.lim;
      }
      out[0][i] = yl;
      if (out[1]) out[1][i] = yr;
    }
    return true;
  }
}
registerProcessor('montage-dynamics', DynamicsProcessor);

// ---------------------------------------------------------------- look-ahead brickwall limiter
// The gain needed by every sample is known lookahead samples before the sample is played: a sliding
// minimum over the look-ahead window, then a moving average of the same length, can never exceed it.
class LimiterProcessor extends Proc {
  static get parameterDescriptors() {
    return [kParam('ceiling', -0.1), kParam('boost', 0), kParam('release', 80), kParam('link', 1)];
  }
  constructor(opts) {
    super();
    const la = (opts && opts.processorOptions && opts.processorOptions.lookahead) || 5;
    this.L = Math.max(1, Math.round((la / 1000) * sampleRate));
    this.size = this.L + 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.t = 0;
    this.gc = [this.computer(), this.computer()];
  }
  computer() {
    const s = this.size;
    return { req: new Float64Array(s).fill(1), dq: new Float64Array(s), head: 0, tail: 0, count: 0, r: 1, box: new Float64Array(s).fill(1), sum: s, bi: 0 };
  }
  // push the gain sample t needs; returns the smoothed gain for the sample leaving the delay line
  step(c, t, need, relC) {
    const s = this.size;
    c.req[t % s] = need;
    while (c.count > 0) {
      const back = (c.tail - 1 + s) % s;
      if (c.req[c.dq[back] % s] >= need) { c.tail = back; c.count--; } else break;
    }
    c.dq[c.tail] = t; c.tail = (c.tail + 1) % s; c.count++;
    while (c.dq[c.head] <= t - s) { c.head = (c.head + 1) % s; c.count--; }
    const m = c.req[c.dq[c.head] % s];
    const rel = c.r + (1 - c.r) * (1 - relC);
    c.r = m < rel ? m : rel;
    c.sum += c.r - c.box[c.bi];
    c.box[c.bi] = c.r;
    c.bi = (c.bi + 1) % s;
    return Math.min(1, c.sum / s);
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const ceil = dbToLin(p.ceiling[0]);
    const boost = dbToLin(p.boost[0]);
    const relC = coefMs(Math.max(1, p.release[0]));
    const link = p.link[0] > 0.5;
    const s = this.size;
    for (let i = 0; i < n; i++) {
      const t = this.t++;
      const xl = (L ? L[i] : 0) * boost;
      const xr = (R ? R[i] : 0) * boost;
      const rd = (t + 1) % s;
      const dl = this.buf[0][rd];
      const dr = this.buf[1][rd];
      this.buf[0][t % s] = xl;
      this.buf[1][t % s] = xr;
      let gl, gr;
      if (link) {
        const pk = Math.max(Math.abs(xl), Math.abs(xr));
        gl = gr = this.step(this.gc[0], t, pk > ceil ? ceil / pk : 1, relC);
      } else {
        const al = Math.abs(xl), ar = Math.abs(xr);
        gl = this.step(this.gc[0], t, al > ceil ? ceil / al : 1, relC);
        gr = this.step(this.gc[1], t, ar > ceil ? ceil / ar : 1, relC);
      }
      out[0][i] = dl * gl;
      if (out[1]) out[1][i] = dr * gr;
    }
    return true;
  }
}
registerProcessor('montage-limiter', LimiterProcessor);

// ---------------------------------------------------------------- de-esser
// Sidechain: a band-pass around the sibilance. Broadband mode ducks the whole signal; multiband mode
// takes the reduction out of that band only (a dynamic bell cut, transparent below threshold).
class DeEsserProcessor extends Proc {
  static get parameterDescriptors() {
    return [kParam('mode', 1), kParam('threshold', -30), kParam('freq', 6500), kParam('bandwidth', 4000), kParam('listen', 0), kParam('gain', 0), kParam('maxCut', 18)];
  }
  constructor() {
    super();
    this.sc = new Biquad();
    this.bp = [new Biquad(), new Biquad()];
    this.key = '';
    this.env = 0; this.gr = 0;
    this.eA = coefMs(0.4); this.eR = coefMs(50);
    this.gA = coefMs(1); this.gR = coefMs(60);
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const f = p.freq[0];
    const bw = Math.max(200, p.bandwidth[0]);
    const key = f + '/' + bw;
    if (key !== this.key) {
      this.key = key;
      this.sc.set('bandpass', f, f / bw, 0);
      this.bp[0].set('bandpass', f, f / bw, 0);
      this.bp[1].set('bandpass', f, f / bw, 0);
    }
    const thr = p.threshold[0];
    const split = p.mode[0] > 0.5;
    const listen = p.listen[0] > 0.5;
    const maxCut = Math.max(0, p.maxCut[0]);
    const og = dbToLin(p.gain[0]);
    for (let i = 0; i < n; i++) {
      const l = L ? L[i] : 0;
      const r = R ? R[i] : 0;
      const s = this.sc.run((l + r) * 0.5);
      const a = Math.abs(s);
      this.env = a > this.env ? this.eA * this.env + (1 - this.eA) * a : this.eR * this.env + (1 - this.eR) * a;
      const over = linToDb(this.env) - thr;
      const want = over > 0 ? Math.min(maxCut, over * 0.75) : 0;
      this.gr = want > this.gr ? this.gA * this.gr + (1 - this.gA) * want : this.gR * this.gr + (1 - this.gR) * want;
      const cut = 1 - dbToLin(-this.gr);
      // what is taken away: the band (multiband) or the whole signal (broadband)
      const rl = (split ? this.bp[0].run(l) : l) * cut;
      const rr = (split ? this.bp[1].run(r) : r) * cut;
      out[0][i] = (listen ? rl : l - rl) * og;
      if (out[1]) out[1][i] = (listen ? rr : r - rr) * og;
    }
    return true;
  }
}
registerProcessor('montage-deesser', DeEsserProcessor);

// ---------------------------------------------------------------- multiband compressor
// Linkwitz-Riley (24 dB/oct) crossovers; lower bands get all-pass sections of the higher crossovers
// so that the bands add back up flat.
class MultibandProcessor extends Proc {
  static get parameterDescriptors() {
    const d = [kParam('c1', 120), kParam('c2', 2000), kParam('c3', 8000), kParam('attack', 10), kParam('release', 150), kParam('outGain', 0), kParam('limit', 1), kParam('ceiling', -0.3)];
    for (let b = 1; b <= 4; b++) d.push(kParam('thr' + b, -20), kParam('ratio' + b, 3), kParam('gain' + b, 0), kParam('solo' + b, 0), kParam('bypass' + b, 0));
    return d;
  }
  constructor() {
    super();
    const mk = () => new Biquad();
    this.ch = [0, 1].map(() => ({
      lp1a: mk(), lp1b: mk(), hp1a: mk(), hp1b: mk(), ap2a: mk(), ap3a: mk(),
      lp2a: mk(), lp2b: mk(), hp2a: mk(), hp2b: mk(), ap3b: mk(),
      lp3a: mk(), lp3b: mk(), hp3a: mk(), hp3b: mk(),
    }));
    this.key = '';
    this.gr = new Float64Array(4);
    this.lim = 1;
    this.lR = coefMs(60);
  }
  setup(c1, c2, c3) {
    const Q = Math.SQRT1_2;
    for (const f of this.ch) {
      f.lp1a.set('lowpass', c1, Q); f.lp1b.set('lowpass', c1, Q); f.hp1a.set('highpass', c1, Q); f.hp1b.set('highpass', c1, Q);
      f.lp2a.set('lowpass', c2, Q); f.lp2b.set('lowpass', c2, Q); f.hp2a.set('highpass', c2, Q); f.hp2b.set('highpass', c2, Q);
      f.lp3a.set('lowpass', c3, Q); f.lp3b.set('lowpass', c3, Q); f.hp3a.set('highpass', c3, Q); f.hp3b.set('highpass', c3, Q);
      f.ap2a.set('allpass', c2, Q); f.ap3a.set('allpass', c3, Q); f.ap3b.set('allpass', c3, Q);
    }
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    let c1 = Math.max(20, p.c1[0]);
    let c2 = Math.max(c1 * 1.2, p.c2[0]);
    let c3 = Math.min(sampleRate * 0.45, Math.max(c2 * 1.2, p.c3[0]));
    const key = c1 + '/' + c2 + '/' + c3;
    if (key !== this.key) { this.key = key; this.setup(c1, c2, c3); }
    const A = coefMs(p.attack[0]), Rl = coefMs(p.release[0]);
    const thr = [], slope = [], mk = [], on = [];
    let anySolo = false;
    for (let b = 0; b < 4; b++) if (p['solo' + (b + 1)][0] > 0.5) anySolo = true;
    for (let b = 0; b < 4; b++) {
      thr.push(p['thr' + (b + 1)][0]);
      slope.push(1 - 1 / Math.max(1, p['ratio' + (b + 1)][0]));
      mk.push(dbToLin(p['gain' + (b + 1)][0]));
      on.push(!anySolo || p['solo' + (b + 1)][0] > 0.5);
    }
    const bypass = [0, 1, 2, 3].map((b) => p['bypass' + (b + 1)][0] > 0.5);
    const og = dbToLin(p.outGain[0]);
    const limit = p.limit[0] > 0.5;
    const ceil = dbToLin(p.ceiling[0]);
    const KNEE = 6;
    const bandL = new Float64Array(4), bandR = new Float64Array(4);
    const f0 = this.ch[0], f1 = this.ch[1];
    for (let i = 0; i < n; i++) {
      const xs = [L ? L[i] : 0, R ? R[i] : 0];
      for (let c = 0; c < 2; c++) {
        const f = c ? f1 : f0;
        const x = xs[c];
        const lp1 = f.lp1b.run(f.lp1a.run(x));
        const hp1 = f.hp1b.run(f.hp1a.run(x));
        const b1 = f.ap3a.run(f.ap2a.run(lp1));
        const lp2 = f.lp2b.run(f.lp2a.run(hp1));
        const hp2 = f.hp2b.run(f.hp2a.run(hp1));
        const b2 = f.ap3b.run(lp2);
        const b3 = f.lp3b.run(f.lp3a.run(hp2));
        const b4 = f.hp3b.run(f.hp3a.run(hp2));
        const dst = c ? bandR : bandL;
        dst[0] = b1; dst[1] = b2; dst[2] = b3; dst[3] = b4;
      }
      let yl = 0, yr = 0;
      for (let b = 0; b < 4; b++) {
        if (!on[b]) continue;
        let g = 1;
        if (!bypass[b]) {
          const pk = Math.max(Math.abs(bandL[b]), Math.abs(bandR[b]));
          const over = linToDb(pk) - thr[b];
          let want = 0;
          if (over > KNEE / 2) want = over * slope[b];
          else if (over > -KNEE / 2) want = (((over + KNEE / 2) * (over + KNEE / 2)) / (2 * KNEE)) * slope[b];
          this.gr[b] = want > this.gr[b] ? A * this.gr[b] + (1 - A) * want : Rl * this.gr[b] + (1 - Rl) * want;
          g = dbToLin(-this.gr[b]) * mk[b];
        }
        yl += bandL[b] * g;
        yr += bandR[b] * g;
      }
      yl *= og; yr *= og;
      if (limit) {
        const pk = Math.max(Math.abs(yl), Math.abs(yr));
        const need = pk > ceil ? ceil / pk : 1;
        const rel = this.lR * this.lim + (1 - this.lR);
        this.lim = need < rel ? need : rel;
        yl *= this.lim; yr *= this.lim;
      }
      out[0][i] = yl;
      if (out[1]) out[1][i] = yr;
    }
    return true;
  }
}
registerProcessor('montage-multiband', MultibandProcessor);

// ---------------------------------------------------------------- phaser
// first-order all-pass stages swept by an LFO (right channel a quarter turn later), with feedback
class PhaserProcessor extends Proc {
  static get parameterDescriptors() {
    return [kParam('stages', 6), kParam('rate', 0.4), kParam('depth', 70), kParam('freq', 900), kParam('feedback', 40), kParam('mix', 50)];
  }
  constructor() {
    super();
    this.ph = 0;
    this.x1 = [new Float64Array(12), new Float64Array(12)];
    this.y1 = [new Float64Array(12), new Float64Array(12)];
    this.last = [0, 0];
    this.a = [0, 0];
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const stages = Math.max(2, Math.min(12, Math.round(p.stages[0])));
    const dPh = (2 * Math.PI * Math.max(0.01, p.rate[0])) / sampleRate;
    const depth = Math.min(1, Math.max(0, p.depth[0] / 100));
    const fc = Math.max(20, p.freq[0]);
    const fb = Math.min(0.95, Math.max(0, p.feedback[0] / 100));
    const m = Math.min(1, Math.max(0, p.mix[0] / 100));
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        for (let c = 0; c < 2; c++) {
          const lfo = Math.sin(this.ph + (c ? Math.PI / 2 : 0));
          const f = Math.min(sampleRate * 0.45, Math.max(20, fc * Math.pow(2, 2 * depth * lfo)));
          const t = Math.tan((Math.PI * f) / sampleRate);
          this.a[c] = (t - 1) / (t + 1);
        }
      }
      this.ph += dPh;
      if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
      for (let c = 0; c < 2; c++) {
        const src = c ? R : L;
        const x = src ? src[i] : 0;
        let s = x + fb * this.last[c];
        const a = this.a[c], x1 = this.x1[c], y1 = this.y1[c];
        for (let k = 0; k < stages; k++) {
          const y = a * s + x1[k] - a * y1[k];
          x1[k] = s; y1[k] = y; s = y;
        }
        this.last[c] = s;
        const y = x * (1 - m * 0.5) + s * (m * 0.5);
        if (c === 0) out[0][i] = y;
        else if (out[1]) out[1][i] = y;
      }
    }
    return true;
  }
}
registerProcessor('montage-phaser', PhaserProcessor);

// ---------------------------------------------------------------- STFT frame engine
// Two channels are packed into one complex FFT (left = real, right = imaginary). Latency = N samples.
class StftProcessor extends Proc {
  init(N) {
    this.N = N;
    this.H = N / 4;
    this.fft = makeFFT(N);
    this.win = hann(N);
    this.inL = new Float64Array(N); this.inR = new Float64Array(N);
    this.outL = new Float64Array(this.H); this.outR = new Float64Array(this.H);
    this.accL = new Float64Array(N); this.accR = new Float64Array(N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.pos = 0; // samples gathered towards the next frame
    this.scale = 1 / (N * 1.5); // Hann analysis * Hann synthesis at 75% overlap sums to 1.5
  }
  process(inputs, outputs, p) {
    if (this.dead) return false;
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const N = this.N, H = this.H, base = N - H;
    for (let i = 0; i < n; i++) {
      this.inL[base + this.pos] = L ? L[i] : 0;
      this.inR[base + this.pos] = R ? R[i] : 0;
      out[0][i] = this.outL[this.pos];
      if (out[1]) out[1][i] = this.outR[this.pos];
      if (++this.pos >= H) {
        this.pos = 0;
        this.runFrame(p);
      }
    }
    return true;
  }
  runFrame(p) {
    const N = this.N, H = this.H, re = this.re, im = this.im, w = this.win;
    for (let j = 0; j < N; j++) { re[j] = this.inL[j] * w[j]; im[j] = this.inR[j] * w[j]; }
    this.fft(re, im, false);
    this.spectrum(re, im, p);
    this.fft(re, im, true);
    const s = this.scale;
    for (let j = 0; j < N; j++) { this.accL[j] += re[j] * w[j] * s; this.accR[j] += im[j] * w[j] * s; }
    for (let j = 0; j < H; j++) { this.outL[j] = this.accL[j]; this.outR[j] = this.accR[j]; }
    this.accL.copyWithin(0, H); this.accR.copyWithin(0, H);
    this.accL.fill(0, N - H); this.accR.fill(0, N - H);
    this.inL.copyWithin(0, H); this.inR.copyWithin(0, H);
  }
}

// noise reduction (minimum-statistics noise estimate + decision-directed Wiener gain) and
// late-reverb suppression (exponential decay model), chosen by processorOptions.mode
class SpectralProcessor extends StftProcessor {
  static get parameterDescriptors() {
    return [kParam('amount', 50), kParam('focus', 0), kParam('gain', 0), kParam('decay', 0.5)];
  }
  constructor(opts) {
    super();
    this.mode = (opts && opts.processorOptions && opts.processorOptions.mode) || 'denoise';
    this.init(sampleRate > 64000 ? 2048 : 1024);
    const K = this.N / 2 + 1;
    this.K = K;
    this.P = new Float64Array(K);
    this.S = new Float64Array(K);
    this.G = new Float64Array(K).fill(1);
    this.Gs = new Float64Array(K).fill(1);
    this.post = new Float64Array(K).fill(1);
    this.cur = new Float64Array(K).fill(Infinity);
    this.U = 8;
    this.V = Math.max(4, Math.round((0.18 * sampleRate) / this.H)); // ~1.4 s window in 8 parts
    this.sub = Array.from({ length: this.U }, () => new Float64Array(K).fill(Infinity));
    this.subI = 0; this.frames = 0;
    this.D = Math.max(2, Math.round((0.05 * sampleRate) / this.H));
    this.hist = Array.from({ length: this.D }, () => new Float64Array(K));
    this.histI = 0;
    this.weights = new Float64Array(K).fill(1);
    this.focus = -1;
  }
  setFocus(focus) {
    this.focus = focus;
    const K = this.K, binHz = sampleRate / this.N;
    for (let k = 0; k < K; k++) {
      const f = k * binHz;
      const t = Math.min(1, Math.max(0, (f - 500) / 2500));
      const sm = t * t * (3 - 2 * t);
      this.weights[k] = focus === 1 ? 0.25 + 0.75 * sm : focus === 2 ? 1 - 0.75 * sm : 1;
    }
  }
  spectrum(re, im, p) {
    const N = this.N, K = this.K;
    const a = Math.min(1, Math.max(0, p.amount[0] / 100));
    const og = dbToLin(p.gain[0]);
    const focus = Math.round(p.focus[0]);
    if (focus !== this.focus) this.setFocus(focus);
    const P = this.P;
    for (let k = 0; k < K; k++) {
      const k2 = (N - k) % N;
      P[k] = (re[k] * re[k] + im[k] * im[k] + re[k2] * re[k2] + im[k2] * im[k2]) * 0.25 + 1e-20;
    }
    const G = this.G;
    if (this.mode === 'dereverb') {
      const old = this.hist[this.histI];
      const t60 = Math.max(0.2, p.decay[0]);
      const decay = Math.exp((-2 * 3 * Math.LN10 * this.D * this.H) / (sampleRate * t60));
      const beta = a;
      const floor = dbToLin(-18 * a);
      for (let k = 0; k < K; k++) {
        const late = decay * old[k];
        let g = 1 - (beta * late) / P[k];
        if (g < floor) g = floor;
        // fall slowly, rise at once: fewer warbling artefacts
        const prev = this.Gs[k];
        g = g > prev ? g : 0.55 * prev + 0.45 * g;
        this.Gs[k] = g;
        G[k] = g;
      }
      old.set(P);
      this.histI = (this.histI + 1) % this.D;
    } else {
      const S = this.S, cur = this.cur;
      const first = this.frames === 0;
      for (let k = 0; k < K; k++) {
        S[k] = first ? P[k] : 0.75 * S[k] + 0.25 * P[k];
        if (S[k] < cur[k]) cur[k] = S[k];
      }
      if (++this.frames % this.V === 0) {
        this.sub[this.subI].set(cur);
        this.subI = (this.subI + 1) % this.U;
        cur.set(S);
      }
      const over = (0.5 + 1.5 * a) * 2.2; // minimum-statistics bias, scaled by the amount
      const floor = dbToLin(-40 * a);
      for (let k = 0; k < K; k++) {
        let m = cur[k];
        for (let u = 0; u < this.U; u++) if (this.sub[u][k] < m) m = this.sub[u][k];
        const noise = m * over;
        const gamma = P[k] / noise;
        const xi = 0.96 * this.Gs[k] * this.Gs[k] * this.post[k] + 0.04 * Math.max(gamma - 1, 0);
        let g = xi / (1 + xi);
        if (g < floor) g = floor;
        this.Gs[k] = g;
        this.post[k] = gamma;
        G[k] = 1 - this.weights[k] * (1 - g);
      }
    }
    // a little smoothing across frequency
    let prev = G[0];
    for (let k = 1; k < K - 1; k++) {
      const c = G[k];
      G[k] = 0.25 * prev + 0.5 * c + 0.25 * G[k + 1];
      prev = c;
    }
    for (let k = 0; k < K; k++) {
      const g = G[k] * og;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
    }
  }
}
registerProcessor('montage-spectral', SpectralProcessor);

// phase-vocoder pitch shifter with identity phase locking (Laroche & Dolson): every spectral peak
// moves with the bins around it, so partials keep their shape and level. Both channels share one FFT.
class PitchProcessor extends StftProcessor {
  static get parameterDescriptors() {
    return [kParam('ratio', 1, 0.25, 4), kParam('mix', 1, 0, 1)];
  }
  constructor() {
    super();
    this.init(sampleRate > 64000 ? 4096 : 2048);
    const K = this.N / 2 + 1;
    this.K = K;
    this.prevPh = [new Float64Array(K), new Float64Array(K)];
    this.prevOut = [new Float64Array(K), new Float64Array(K)];
    this.xr = new Float64Array(K); this.xi = new Float64Array(K);
    this.mag = new Float64Array(K); this.ph = new Float64Array(K);
    this.yr = [new Float64Array(K), new Float64Array(K)];
    this.yi = [new Float64Array(K), new Float64Array(K)];
    this.peaks = new Int32Array(K);
  }
  spectrum(re, im, p) {
    const N = this.N, K = this.K, H = this.H;
    const ratio = p.ratio[0];
    const mix = p.mix[0];
    if (Math.abs(ratio - 1) < 1e-4 || mix <= 0) {
      // unchanged: keep the phase history current so a later change starts cleanly
      for (let c = 0; c < 2; c++) this.track(re, im, c, null);
      return;
    }
    for (let c = 0; c < 2; c++) this.track(re, im, c, ratio);
    const wet = mix, dry = 1 - mix;
    for (let k = 0; k < K; k++) {
      const lr = this.yr[0][k], li = this.yi[0][k], rr = this.yr[1][k], ri = this.yi[1][k];
      re[k] = re[k] * dry + (lr - ri) * wet;
      im[k] = im[k] * dry + (li + rr) * wet;
      if (k > 0 && k < K - 1) {
        re[N - k] = re[N - k] * dry + (lr + ri) * wet;
        im[N - k] = im[N - k] * dry + (rr - li) * wet;
      }
    }
  }
  // unpack channel c (window-centred phase: odd bins negated), then shift its peaks by ratio
  track(re, im, c, ratio) {
    const N = this.N, K = this.K, H = this.H;
    const xr = this.xr, xi = this.xi, mag = this.mag, ph = this.ph;
    for (let k = 0; k < K; k++) {
      const k2 = (N - k) % N;
      let a, b;
      if (c === 0) { a = (re[k] + re[k2]) * 0.5; b = (im[k] - im[k2]) * 0.5; }
      else { a = (im[k] + im[k2]) * 0.5; b = (re[k2] - re[k]) * 0.5; }
      if (k & 1) { a = -a; b = -b; }
      xr[k] = a; xi[k] = b;
      mag[k] = Math.sqrt(a * a + b * b);
      ph[k] = Math.atan2(b, a);
    }
    const prevPh = this.prevPh[c];
    const prevOut = this.prevOut[c];
    if (ratio == null) {
      prevPh.set(ph);
      prevOut.set(ph);
      return;
    }
    const yr = this.yr[c], yi = this.yi[c];
    yr.fill(0); yi.fill(0);
    let maxMag = 0;
    for (let k = 0; k < K; k++) if (mag[k] > maxMag) maxMag = mag[k];
    const floor = maxMag * 1e-5;
    const peaks = this.peaks;
    let np = 0;
    for (let k = 2; k < K - 2; k++) {
      const m = mag[k];
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) peaks[np++] = k;
    }
    const TWO_PI = 2 * Math.PI;
    const binW = TWO_PI / N;
    for (let i = 0; i < np; i++) {
      const kp = peaks[i];
      const lo = i === 0 ? 0 : ((peaks[i - 1] + kp) >> 1) + 1;
      const hi = i === np - 1 ? K - 1 : (kp + peaks[i + 1]) >> 1;
      let d = ph[kp] - prevPh[kp] - kp * binW * H;
      d -= TWO_PI * Math.round(d / TWO_PI);
      const omega = kp * binW + d / H;
      const w2 = omega * ratio;
      const kd = Math.round(w2 / binW);
      if (kd <= 0 || kd >= K - 1) continue;
      const shift = kd - kp;
      const out = prevOut[kd] + H * w2;
      const th = out - ph[kp];
      const ct = Math.cos(th), st = Math.sin(th);
      for (let k = lo; k <= hi; k++) {
        const dst = k + shift;
        if (dst < 0 || dst >= K) continue;
        yr[dst] += xr[k] * ct - xi[k] * st;
        yi[dst] += xr[k] * st + xi[k] * ct;
      }
    }
    prevPh.set(ph);
    for (let k = 0; k < K; k++) {
      prevOut[k] = Math.atan2(yi[k], yr[k]);
      if (k & 1) { yr[k] = -yr[k]; yi[k] = -yi[k]; }
    }
    yi[0] = 0; yi[K - 1] = 0;
  }
}
registerProcessor('montage-pitch', PitchProcessor);
`;

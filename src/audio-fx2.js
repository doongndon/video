// Premiere Pro audio effects beyond the basic set: parametric / graphic EQ, bass, treble, noise and
// reverb reduction, de-esser, dynamics, hard limiter, multiband compressor, pitch shifter, chorus /
// flanger, phaser, distortion, stereo expander, multitap delay and channel tools. The definitions go
// into EFFECTS (effects panel, effect controls, presets, copy/paste); the DSP is registered as chain
// units in audio-fx.js, so the live preview and the export render run the same code.

import { EFFECTS } from './effects.js';
import { UNIT_BUILDERS, setParam, disposeWorklet, nodeDelays } from './audio-fx.js';
import { dbToGain, clamp } from './util.js';

const num = (key, label, def, opts = {}) => ({ key, label, type: 'number', default: def, animatable: true, step: 1, ...opts });
const pct = (key, label, def, opts = {}) => num(key, label, def, { min: 0, max: 100, unit: '%', ...opts });
const dB = (key, label, def, opts = {}) => num(key, label, def, { min: -60, max: 24, unit: 'dB', step: 0.1, ...opts });
const hz = (key, label, def, opts = {}) => num(key, label, def, { min: 20, max: 20000, unit: 'Hz', step: 1, ...opts });
const ms = (key, label, def, opts = {}) => num(key, label, def, { min: 0, max: 2000, unit: 'ms', step: 0.1, ...opts });
const bool = (key, label, def, opts = {}) => ({ key, label, type: 'bool', default: def, ...opts });
const sel = (key, label, def, options, opts = {}) => ({ key, label, type: 'select', default: def, options, ...opts });

// Premiere's audio effect folders (효과 패널 ▸ 오디오 효과)
const CAT = {
  amp: '진폭 및 압축',
  delay: '지연 및 반향',
  eq: '필터 및 EQ',
  mod: '변조',
  restore: '노이즈 감소/복원',
  reverb: '리버브',
  special: '특수 효과',
  stereo: '스테레오 이미지',
  pitch: '시간 및 피치',
  channel: '채널',
};

// the original audio effects move into the same folders
const RECAT = { gain: CAT.amp, compressor: CAT.amp, noiseGate: CAT.restore, humRemove: CAT.restore, delay: CAT.delay, reverb: CAT.reverb, ringMod: CAT.special, eq3: CAT.eq, highpass: CAT.eq, lowpass: CAT.eq, bandpass: CAT.eq };
for (const [type, cat] of Object.entries(RECAT)) if (EFFECTS[type]) EFFECTS[type].category = cat;

// ---------------------------------------------------------------- EQ specs (shared with the curve UI)

const BAND_TYPES = [['peaking', '벨 (피킹)'], ['lowshelf', '로우 셸프'], ['highshelf', '하이 셸프'], ['notch', '노치'], ['lowpass', '로우패스'], ['highpass', '하이패스'], ['bandpass', '밴드패스']];
const SLOPES = [['12', '12 dB/옥타브'], ['24', '24 dB/옥타브'], ['48', '48 dB/옥타브']];
// Butterworth section Qs for 2nd, 4th and 8th order
const BUTTER = { 12: [Math.SQRT1_2], 24: [0.5412, 1.3066], 48: [0.5098, 0.6013, 0.9, 2.5629] };
export const PEQ_BANDS = [
  { type: 'lowshelf', freq: 100 },
  { type: 'peaking', freq: 250 },
  { type: 'peaking', freq: 1000 },
  { type: 'peaking', freq: 4000 },
  { type: 'highshelf', freq: 10000 },
];
export const GEQ_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GEQ_LABELS = ['31 Hz', '63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'];

// Web Audio takes lowpass / highpass Q in dB, the other types as a plain number
const qParam = (type, q) => (type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(Math.max(1e-3, q)) : q);
const IDENT = { type: 'peaking', freq: 1000, q: 1, gain: 0 };

function passSpecs(on, type, freq, slope) {
  const qs = BUTTER[slope] || BUTTER[12];
  return [0, 1, 2, 3].map((i) => (on && i < qs.length ? { type, freq, q: qs[i], gain: 0 } : IDENT));
}

/** Biquad settings ({type, freq, q (plain), gain}) an EQ effect uses for evaluated values v. */
export function eqSpecs(fxType, v) {
  if (fxType === 'parametricEq') {
    const bands = PEQ_BANDS.map((_, i) => {
      const n = i + 1;
      const on = !!v[`b${n}On`];
      return on ? { type: v[`b${n}Type`] || 'peaking', freq: v[`b${n}Freq`], q: v[`b${n}Q`], gain: v[`b${n}Gain`] } : IDENT;
    });
    return [...passSpecs(!!v.hpOn, 'highpass', v.hpFreq, v.hpSlope), ...bands, ...passSpecs(!!v.lpOn, 'lowpass', v.lpFreq, v.lpSlope)];
  }
  if (fxType === 'graphicEq') return GEQ_FREQS.map((f, i) => ({ type: 'peaking', freq: f, q: 1.41, gain: v[`g${i}`] || 0 }));
  if (fxType === 'bass') return [{ type: 'lowshelf', freq: v.freq, q: 1, gain: v.boost }];
  if (fxType === 'treble') return [{ type: 'highshelf', freq: v.freq, q: 1, gain: v.boost }];
  return [];
}

/** Output gain (dB) of an EQ effect besides its filters. */
export const eqOutputDb = (fxType, v) => (fxType === 'parametricEq' || fxType === 'graphicEq' ? v.gain || 0 : 0);

function applySpec(f, s, when, mode) {
  if (f.type !== s.type) f.type = s.type;
  setParam(f.frequency, clamp(s.freq, 10, 24000), when, mode);
  setParam(f.Q, qParam(s.type, s.q), when, mode);
  setParam(f.gain, s.gain, when, mode);
}

function eqBuilder(fxType) {
  return {
    build(ctx, fx, unit) {
      const n = eqSpecs(fxType, defaults(fxType)).length;
      const filters = Array.from({ length: n }, () => ctx.createBiquadFilter());
      const out = ctx.createGain();
      let prev = unit.input;
      for (const f of filters) {
        prev.connect(f);
        prev = f;
      }
      prev.connect(out).connect(unit.output);
      unit.apply = (v, when, mode) => {
        eqSpecs(fxType, v).forEach((s, i) => applySpec(filters[i], s, when, mode));
        setParam(out.gain, dbToGain(eqOutputDb(fxType, v)), when, mode);
      };
    },
  };
}

function defaults(type) {
  const out = {};
  for (const p of EFFECTS[type].params) out[p.key] = p.default;
  return out;
}

// ---------------------------------------------------------------- helpers

/** Make the unit's input stereo (mono sources are copied to both sides). */
function stereoInput(unit) {
  unit.input.channelCount = 2;
  unit.input.channelCountMode = 'explicit';
  unit.input.channelInterpretation = 'speakers';
}

function worklet(ctx, name, processorOptions = {}) {
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions,
  });
}

/** A unit around one worklet node; map(values) → {paramName: number}. */
function workletUnit(name, map, { options = () => ({}), latency = () => 0 } = {}) {
  return {
    worklet: true,
    build(ctx, fx, unit, ready) {
      if (!ready) {
        unit.input.connect(unit.output); // processors still loading: the chain is rebuilt once they are
        return;
      }
      const node = worklet(ctx, name, options(fx));
      unit.input.connect(node).connect(unit.output);
      unit.latency = latency(ctx, fx);
      unit.dispose = () => disposeWorklet(node);
      unit.apply = (v, when, mode) => {
        for (const [k, val] of Object.entries(map(v))) {
          const p = node.parameters.get(k);
          if (p) setParam(p, val, when, mode);
        }
      };
    },
  };
}

const b01 = (v) => (v ? 1 : 0);
const fftLatency = (n) => (ctx) => (ctx.sampleRate > 64000 ? n * 2 : n) / ctx.sampleRate;

// ---------------------------------------------------------------- definitions

// Effect Controls shows params of the same group under one sub-heading (closed when there are many)
const grouped = (group, list) => list.map((p) => ({ ...p, group }));
const peqParams = [dB('gain', '마스터 게인', 0, { min: -24, max: 24 })];
PEQ_BANDS.forEach((b, i) => {
  const n = i + 1;
  peqParams.push(...grouped(`밴드 ${n}`, [
    bool(`b${n}On`, `밴드 ${n}`, true),
    sel(`b${n}Type`, `밴드 ${n} 종류`, b.type, BAND_TYPES),
    hz(`b${n}Freq`, `밴드 ${n} 주파수`, b.freq),
    dB(`b${n}Gain`, `밴드 ${n} 게인`, 0, { min: -30, max: 30 }),
    num(`b${n}Q`, `밴드 ${n} Q (폭)`, 1, { min: 0.1, max: 30, step: 0.1 }),
  ]));
});
peqParams.push(...grouped('하이패스 · 로우패스', [
  bool('hpOn', '하이패스 (저음 차단)', false),
  hz('hpFreq', '하이패스 주파수', 60, { max: 2000 }),
  sel('hpSlope', '하이패스 기울기', '12', SLOPES),
  bool('lpOn', '로우패스 (고음 차단)', false),
  hz('lpFreq', '로우패스 주파수', 16000, { min: 1000 }),
  sel('lpSlope', '로우패스 기울기', '12', SLOPES),
]));

const NEW_EFFECTS = {
  parametricEq: {
    name: '파라메트릭 이퀄라이저', kind: 'audio', category: CAT.eq, params: peqParams,
    hint: '위의 곡선에서 점을 끌어 주파수와 게인을, 휠로 Q를 바꿉니다',
  },
  graphicEq: {
    name: '그래픽 이퀄라이저 (10밴드)', kind: 'audio', category: CAT.eq,
    params: [...GEQ_LABELS.map((l, i) => dB(`g${i}`, l, 0, { min: -24, max: 24 })), dB('gain', '출력 게인', 0, { min: -24, max: 24 })],
  },
  bass: {
    name: '베이스', kind: 'audio', category: CAT.eq,
    params: [dB('boost', '부스트', 6, { min: -24, max: 24 }), hz('freq', '주파수', 200, { max: 1000 })],
  },
  treble: {
    name: '고음', kind: 'audio', category: CAT.eq,
    params: [dB('boost', '부스트', 6, { min: -24, max: 24 }), hz('freq', '주파수', 4000, { min: 1000 })],
  },
  denoise: {
    name: '노이즈 제거', kind: 'audio', category: CAT.restore,
    params: [
      pct('amount', '양', 40, { hint: '배경의 일정한 잡음(쉬익·웅웅)을 줄입니다. 너무 높이면 목소리가 물속처럼 들립니다' }),
      sel('focus', '처리 초점', '0', [['0', '모든 주파수'], ['1', '높은 주파수 (쉬익 소리)'], ['2', '낮은 주파수 (웅웅 소리)']]),
      dB('gain', '출력 게인', 0, { min: -24, max: 24 }),
    ],
  },
  dereverb: {
    name: '리버브 제거', kind: 'audio', category: CAT.restore,
    params: [
      pct('amount', '양', 50, { hint: '방 울림을 줄입니다 (근사 처리)' }),
      num('decay', '울림 길이', 0.5, { min: 0.2, max: 3, step: 0.05, unit: '초', hint: '방이 울리는 시간에 맞추면 가장 잘 줄어듭니다' }),
      dB('gain', '출력 게인', 0, { min: -24, max: 24 }),
    ],
  },
  deesser: {
    name: '치찰음 제거', kind: 'audio', category: CAT.amp,
    params: [
      sel('mode', '모드', '1', [['1', '다중 대역 (치찰음 대역만)'], ['0', '광대역 (전체 음량)']]),
      dB('threshold', '임계값', -30, { min: -60, max: 0 }),
      hz('freq', '중심 주파수', 6500, { min: 2000, max: 16000 }),
      hz('bandwidth', '대역폭', 4000, { min: 200, max: 10000 }),
      num('maxCut', '최대 감소', 18, { min: 0, max: 40, unit: 'dB', step: 0.5 }),
      bool('listen', '치찰음만 출력 (확인용)', false),
      dB('gain', '출력 게인', 0, { min: -24, max: 24 }),
    ],
  },
  dynamics: {
    name: '다이내믹', kind: 'audio', category: CAT.amp,
    params: [
      dB('outGain', '출력 게인', 0, { min: -24, max: 24 }),
      ...grouped('자동 게이트', [
        bool('gateOn', '자동 게이트', false),
        dB('gateThr', '게이트 임계값', -50, { min: -80, max: 0 }),
        ms('gateAtk', '게이트 어택', 2, { max: 100 }),
        ms('gateRel', '게이트 릴리스', 150),
        ms('gateHold', '게이트 유지', 50, { max: 1000 }),
      ]),
      ...grouped('압축기', [
        bool('compOn', '압축기', true),
        dB('compThr', '압축 임계값', -20, { min: -60, max: 0 }),
        num('compRatio', '압축 비율', 4, { min: 1, max: 30, step: 0.1, unit: ':1' }),
        ms('compAtk', '압축 어택', 10, { max: 500 }),
        ms('compRel', '압축 릴리스', 150),
        dB('compMakeup', '메이크업 게인', 0, { min: 0, max: 30 }),
      ]),
      ...grouped('확장기', [
        bool('expOn', '확장기', false),
        dB('expThr', '확장 임계값', -45, { min: -80, max: 0 }),
        num('expRatio', '확장 비율', 2, { min: 1, max: 30, step: 0.1, unit: ':1' }),
      ]),
      ...grouped('리미터', [
        bool('limOn', '리미터', true),
        dB('limThr', '리미터 임계값', -1, { min: -30, max: 0 }),
        ms('limRel', '리미터 릴리스', 60, { max: 1000 }),
      ]),
    ],
  },
  hardLimiter: {
    name: '하드 리미터', kind: 'audio', category: CAT.amp,
    params: [
      dB('ceiling', '최대 진폭', -0.1, { min: -24, max: 0, hint: '이 크기를 절대 넘지 않게 합니다' }),
      dB('boost', '입력 증폭', 0, { min: 0, max: 24 }),
      sel('lookahead', '미리 보기 시간', '7', [['1', '1 ms'], ['3', '3 ms'], ['5', '5 ms'], ['7', '7 ms'], ['10', '10 ms']]),
      ms('release', '릴리스 시간', 100, { min: 1, max: 1000 }),
      bool('link', '채널 연결', true),
    ],
  },
  multiband: {
    name: '멀티밴드 압축기', kind: 'audio', category: CAT.amp,
    params: [
      dB('outGain', '출력 게인', 0, { min: -24, max: 24 }),
      ms('attack', '어택', 10, { max: 500 }),
      ms('release', '릴리스', 150),
      ...grouped('크로스오버', [
        hz('c1', '크로스오버 1 (저/중저)', 120, { max: 2000 }),
        hz('c2', '크로스오버 2 (중저/중고)', 2000, { min: 200, max: 10000 }),
        hz('c3', '크로스오버 3 (중고/고)', 8000, { min: 1000 }),
      ]),
      ...[1, 2, 3, 4].flatMap((b) => grouped(`대역 ${b} (${['저음', '중저음', '중고음', '고음'][b - 1]})`, [
        dB(`thr${b}`, `대역 ${b} 임계값`, -20, { min: -60, max: 0 }),
        num(`ratio${b}`, `대역 ${b} 비율`, 3, { min: 1, max: 30, step: 0.1, unit: ':1' }),
        dB(`gain${b}`, `대역 ${b} 게인`, 0, { min: -24, max: 24 }),
        bool(`solo${b}`, `대역 ${b} 솔로`, false),
        bool(`bypass${b}`, `대역 ${b} 바이패스`, false),
      ])),
      ...grouped('리미터', [
        bool('limit', '리미터', true),
        dB('ceiling', '리미터 최대값', -0.3, { min: -24, max: 0 }),
      ]),
    ],
  },
  channelVolume: {
    name: '채널 볼륨', kind: 'audio', category: CAT.amp,
    params: [dB('left', '왼쪽', 0, { min: -60, max: 15 }), dB('right', '오른쪽', 0, { min: -60, max: 15 })],
  },
  pitchShift: {
    name: '피치 변환', kind: 'audio', category: CAT.pitch,
    params: [
      num('semitones', '반음', 0, { min: -12, max: 12, step: 1, hint: '+12는 한 옥타브 위, -12는 한 옥타브 아래' }),
      num('cents', '센트', 0, { min: -100, max: 100, step: 1 }),
      pct('mix', '믹스', 100),
    ],
  },
  chorusFlanger: {
    name: '코러스/플랜저', kind: 'audio', category: CAT.mod,
    params: [
      sel('mode', '모드', 'chorus', [['chorus', '코러스'], ['flanger', '플랜저']]),
      num('rate', '속도', 0.6, { min: 0.05, max: 10, step: 0.05, unit: 'Hz' }),
      pct('depth', '폭', 50),
      pct('feedback', '강도', 20),
      pct('mix', '믹스', 50),
    ],
  },
  phaser: {
    name: '페이저', kind: 'audio', category: CAT.mod,
    params: [
      sel('stages', '단계', '6', [['4', '4'], ['6', '6'], ['8', '8'], ['12', '12']]),
      num('rate', '속도', 0.4, { min: 0.02, max: 10, step: 0.02, unit: 'Hz' }),
      pct('depth', '깊이', 70),
      hz('freq', '중심 주파수', 900, { min: 100, max: 8000 }),
      pct('feedback', '피드백', 40, { max: 95 }),
      pct('mix', '믹스', 100),
    ],
  },
  distortion: {
    name: '디스토션', kind: 'audio', category: CAT.special,
    params: [
      sel('shape', '종류', 'soft', [['soft', '부드러운 오버드라이브'], ['hard', '하드 클리핑'], ['fuzz', '퍼즈'], ['bitcrush', '비트 크러시']]),
      num('drive', '드라이브', 12, { min: 0, max: 48, unit: 'dB', step: 0.5 }),
      hz('tone', '톤 (고음 차단)', 8000, { min: 500 }),
      pct('mix', '믹스', 100),
      dB('output', '출력 게인', -6, { min: -36, max: 12 }),
    ],
  },
  vocalEnhancer: {
    name: '보컬 향상', kind: 'audio', category: CAT.special,
    params: [
      sel('mode', '모드', 'low', [['low', '저음 목소리'], ['high', '고음 목소리'], ['music', '음악']]),
      pct('amount', '양', 60),
    ],
  },
  stereoExpander: {
    name: '스테레오 확장기', kind: 'audio', category: CAT.stereo,
    params: [num('width', '폭', 150, { min: 0, max: 300, unit: '%', hint: '100%는 원래대로, 0%는 모노, 100%보다 크면 더 넓게' })],
  },
  multitapDelay: {
    name: '다중 탭 지연', kind: 'audio', category: CAT.delay,
    params: [
      pct('mix', '믹스', 50),
      ...[1, 2, 3, 4].flatMap((i) => grouped(`탭 ${i}`, [
        bool(`on${i}`, `탭 ${i}`, i <= 2),
        num(`time${i}`, `탭 ${i} 지연 시간`, [0.25, 0.5, 0.75, 1][i - 1], { min: 0.001, max: 4, step: 0.001, unit: '초' }),
        pct(`level${i}`, `탭 ${i} 레벨`, [60, 40, 30, 20][i - 1]),
        pct(`fb${i}`, `탭 ${i} 피드백`, 0, { max: 95 }),
        num(`pan${i}`, `탭 ${i} 팬`, [-50, 50, -30, 30][i - 1], { min: -100, max: 100 }),
      ])),
    ],
  },
  swapChannels: { name: '채널 바꾸기 (왼쪽↔오른쪽)', kind: 'audio', category: CAT.channel, params: [] },
  invertChannels: {
    name: '채널 반전 (위상)', kind: 'audio', category: CAT.channel,
    params: [bool('left', '왼쪽 반전', true), bool('right', '오른쪽 반전', true)],
  },
  fillLeft: { name: '왼쪽을 오른쪽 소리로 채우기', kind: 'audio', category: CAT.channel, params: [] },
  fillRight: { name: '오른쪽을 왼쪽 소리로 채우기', kind: 'audio', category: CAT.channel, params: [] },
};
Object.assign(EFFECTS, NEW_EFFECTS);

// ---------------------------------------------------------------- DSP units

UNIT_BUILDERS.parametricEq = eqBuilder('parametricEq');
UNIT_BUILDERS.graphicEq = eqBuilder('graphicEq');
UNIT_BUILDERS.bass = eqBuilder('bass');
UNIT_BUILDERS.treble = eqBuilder('treble');

UNIT_BUILDERS.denoise = workletUnit('montage-spectral', (v) => ({ amount: v.amount, focus: Number(v.focus) || 0, gain: v.gain }), {
  options: () => ({ mode: 'denoise' }), latency: fftLatency(1024),
});
UNIT_BUILDERS.dereverb = workletUnit('montage-spectral', (v) => ({ amount: v.amount, decay: v.decay, gain: v.gain }), {
  options: () => ({ mode: 'dereverb' }), latency: fftLatency(1024),
});
UNIT_BUILDERS.deesser = workletUnit('montage-deesser', (v) => ({
  mode: Number(v.mode), threshold: v.threshold, freq: v.freq, bandwidth: v.bandwidth, maxCut: v.maxCut, listen: b01(v.listen), gain: v.gain,
}));
UNIT_BUILDERS.dynamics = workletUnit('montage-dynamics', (v) => ({
  gateOn: b01(v.gateOn), gateThr: v.gateThr, gateAtk: v.gateAtk, gateRel: v.gateRel, gateHold: v.gateHold,
  compOn: b01(v.compOn), compThr: v.compThr, compRatio: v.compRatio, compAtk: v.compAtk, compRel: v.compRel, compMakeup: v.compMakeup,
  expOn: b01(v.expOn), expThr: v.expThr, expRatio: v.expRatio,
  limOn: b01(v.limOn), limThr: v.limThr, limRel: v.limRel, outGain: v.outGain,
}));
UNIT_BUILDERS.hardLimiter = {
  ...workletUnit('montage-limiter', (v) => ({ ceiling: v.ceiling, boost: v.boost, release: v.release, link: b01(v.link) }), {
    options: (fx) => ({ lookahead: Number(fx.params.lookahead.value) || 7 }),
    latency: (ctx, fx) => Math.max(1, Math.round(((Number(fx.params.lookahead.value) || 7) / 1000) * ctx.sampleRate)) / ctx.sampleRate,
  }),
  signature: (fx) => fx.params.lookahead.value,
};
UNIT_BUILDERS.multiband = workletUnit('montage-multiband', (v) => {
  const out = { c1: v.c1, c2: v.c2, c3: v.c3, attack: v.attack, release: v.release, outGain: v.outGain, limit: b01(v.limit), ceiling: v.ceiling };
  for (let b = 1; b <= 4; b++) Object.assign(out, { [`thr${b}`]: v[`thr${b}`], [`ratio${b}`]: v[`ratio${b}`], [`gain${b}`]: v[`gain${b}`], [`solo${b}`]: b01(v[`solo${b}`]), [`bypass${b}`]: b01(v[`bypass${b}`]) });
  return out;
});
UNIT_BUILDERS.pitchShift = workletUnit('montage-pitch', (v) => ({
  ratio: clamp(2 ** (((v.semitones || 0) + (v.cents || 0) / 100) / 12), 0.25, 4), mix: clamp((v.mix ?? 100) / 100, 0, 1),
}), { latency: fftLatency(2048) });
UNIT_BUILDERS.phaser = workletUnit('montage-phaser', (v) => ({
  stages: Number(v.stages) || 6, rate: v.rate, depth: v.depth, freq: v.freq, feedback: v.feedback, mix: v.mix,
}));

UNIT_BUILDERS.chorusFlanger = {
  build(ctx, fx, unit) {
    stereoInput(unit);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    unit.input.connect(dry).connect(unit.output);
    unit.input.connect(split);
    const lfoL = ctx.createOscillator();
    const lfoR = ctx.createOscillator();
    // the right voice runs a quarter turn ahead: a wider stereo image
    lfoR.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
    const voices = [0, 1].map((c) => {
      const d = ctx.createDelay(0.1);
      const fb = ctx.createGain();
      const depth = ctx.createGain();
      split.connect(d, c);
      d.connect(fb).connect(d);
      d.connect(merge, 0, c);
      (c ? lfoR : lfoL).connect(depth).connect(d.delayTime);
      return { d, fb, depth };
    });
    merge.connect(wet).connect(unit.output);
    lfoL.start();
    lfoR.start();
    unit.dispose = () => {
      for (const o of [lfoL, lfoR]) {
        try { o.stop(); } catch { /* already stopped */ }
      }
    };
    unit.apply = (v, when, mode) => {
      const fl = v.mode === 'flanger';
      const base = fl ? 0.003 : 0.022;
      const depth = clamp((v.depth ?? 50) / 100, 0, 1) * (fl ? 0.0025 : 0.008);
      const fb = clamp((v.feedback ?? 0) / 100, 0, 1) * (fl ? 0.9 : 0.6);
      for (const vc of voices) {
        setParam(vc.d.delayTime, base, when, mode);
        setParam(vc.depth.gain, depth, when, mode);
        setParam(vc.fb.gain, fb, when, mode);
      }
      setParam(lfoL.frequency, clamp(v.rate, 0.01, 20), when, mode);
      setParam(lfoR.frequency, clamp(v.rate, 0.01, 20), when, mode);
      const m = clamp((v.mix ?? 50) / 100, 0, 1);
      setParam(dry.gain, 1 - m * 0.5, when, mode);
      setParam(wet.gain, m * 0.5 * (1 - fb * 0.5), when, mode);
    };
  },
};

const curveCache = new Map();
function shaperCurve(shape) {
  if (curveCache.has(shape)) return curveCache.get(shape);
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 4; // the pre-gain divides by 4: the curve spans ±4
    let y;
    if (shape === 'hard') y = clamp(x, -1, 1);
    else if (shape === 'fuzz') y = x >= 0 ? Math.tanh(x * 1.8) : Math.tanh(x * 0.7) * 0.85;
    else if (shape === 'bitcrush') y = Math.round(clamp(x, -1, 1) * 7) / 7;
    else y = Math.tanh(x);
    c[i] = y;
  }
  curveCache.set(shape, c);
  return c;
}

UNIT_BUILDERS.distortion = {
  build(ctx, fx, unit) {
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    const dc = ctx.createBiquadFilter();
    dc.type = 'highpass';
    dc.frequency.value = 15;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    const post = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    // the dry path waits for the oversampling filters so the mix does not comb-filter
    const align = ctx.createDelay(0.1);
    align.delayTime.value = nodeDelays(ctx).shaper4x;
    unit.latency = nodeDelays(ctx).shaper4x;
    unit.input.connect(pre).connect(shaper).connect(dc).connect(tone).connect(post).connect(wet).connect(unit.output);
    unit.input.connect(align).connect(dry).connect(unit.output);
    let shape = null;
    unit.apply = (v, when, mode) => {
      if (v.shape !== shape) {
        shape = v.shape;
        shaper.curve = shaperCurve(shape);
      }
      setParam(pre.gain, dbToGain(v.drive) / 4, when, mode);
      setParam(tone.frequency, clamp(v.tone, 200, 22000), when, mode);
      setParam(tone.Q, -3.01, when, mode);
      setParam(post.gain, dbToGain(v.output), when, mode);
      const m = clamp((v.mix ?? 100) / 100, 0, 1);
      setParam(wet.gain, m, when, mode);
      setParam(dry.gain, 1 - m, when, mode);
    };
  },
};

UNIT_BUILDERS.vocalEnhancer = {
  build(ctx, fx, unit) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    const mud = ctx.createBiquadFilter();
    mud.type = 'peaking';
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    unit.input.connect(hp).connect(mud).connect(presence).connect(air).connect(comp).connect(makeup).connect(unit.output);
    unit.latency = nodeDelays(ctx).compressor;
    unit.apply = (v, when, mode) => {
      const a = clamp((v.amount ?? 60) / 100, 0, 1);
      const m = v.mode;
      setParam(hp.frequency, m === 'music' ? 40 : m === 'high' ? 120 : 80, when, mode);
      setParam(hp.Q, -3.01, when, mode);
      setParam(mud.frequency, m === 'high' ? 350 : 250, when, mode);
      setParam(mud.Q, 1.2, when, mode);
      setParam(mud.gain, m === 'music' ? -1 * a : -4 * a, when, mode);
      setParam(presence.frequency, m === 'high' ? 5000 : m === 'music' ? 3000 : 3200, when, mode);
      setParam(presence.Q, 0.9, when, mode);
      setParam(presence.gain, (m === 'music' ? 2 : 5) * a, when, mode);
      setParam(air.frequency, 10000, when, mode);
      setParam(air.gain, (m === 'music' ? 3 : 2) * a, when, mode);
      setParam(comp.threshold, -18 - 10 * a, when, mode);
      setParam(comp.ratio, 1 + 2.5 * a, when, mode);
      setParam(comp.knee, 12, when, mode);
      setParam(comp.attack, 0.005, when, mode);
      setParam(comp.release, 0.15, when, mode);
      setParam(makeup.gain, dbToGain(2 * a), when, mode);
    };
  },
};

UNIT_BUILDERS.stereoExpander = {
  build(ctx, fx, unit) {
    stereoInput(unit);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const ll = ctx.createGain();
    const rl = ctx.createGain();
    const lr = ctx.createGain();
    const rr = ctx.createGain();
    unit.input.connect(split);
    split.connect(ll, 0).connect(merge, 0, 0);
    split.connect(rl, 1).connect(merge, 0, 0);
    split.connect(lr, 0).connect(merge, 0, 1);
    split.connect(rr, 1).connect(merge, 0, 1);
    merge.connect(unit.output);
    unit.apply = (v, when, mode) => {
      const w = clamp((v.width ?? 100) / 100, 0, 3);
      const a = (1 + w) / 2;
      const b = (1 - w) / 2;
      setParam(ll.gain, a, when, mode);
      setParam(rr.gain, a, when, mode);
      setParam(rl.gain, b, when, mode);
      setParam(lr.gain, b, when, mode);
    };
  },
};

UNIT_BUILDERS.multitapDelay = {
  build(ctx, fx, unit) {
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    unit.input.connect(dry).connect(unit.output);
    wet.connect(unit.output);
    const taps = [1, 2, 3, 4].map(() => {
      const d = ctx.createDelay(5);
      const fb = ctx.createGain();
      const lvl = ctx.createGain();
      const pan = ctx.createStereoPanner();
      unit.input.connect(d);
      d.connect(fb).connect(d);
      d.connect(lvl).connect(pan).connect(wet);
      return { d, fb, lvl, pan };
    });
    unit.apply = (v, when, mode) => {
      taps.forEach((t, i) => {
        const n = i + 1;
        const on = !!v[`on${n}`];
        setParam(t.d.delayTime, clamp(v[`time${n}`], 0.001, 4.99), when, mode);
        setParam(t.fb.gain, on ? clamp(v[`fb${n}`] / 100, 0, 0.95) : 0, when, mode);
        setParam(t.lvl.gain, on ? clamp(v[`level${n}`] / 100, 0, 1) : 0, when, mode);
        setParam(t.pan.pan, clamp(v[`pan${n}`] / 100, -1, 1), when, mode);
      });
      setParam(wet.gain, clamp((v.mix ?? 50) / 100, 0, 1), when, mode);
      setParam(dry.gain, 1, when, mode);
    };
  },
};

/** Channel matrix units: m = [[LL, RL], [LR, RR]] gains from each input side into each output side. */
function matrixUnit(matrix) {
  return {
    build(ctx, fx, unit) {
      stereoInput(unit);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      unit.input.connect(split);
      const g = [[null, null], [null, null]];
      for (let o = 0; o < 2; o++) {
        for (let i = 0; i < 2; i++) {
          const n = ctx.createGain();
          split.connect(n, i).connect(merge, 0, o);
          g[o][i] = n;
        }
      }
      merge.connect(unit.output);
      unit.apply = (v, when, mode) => {
        const m = matrix(v);
        for (let o = 0; o < 2; o++) for (let i = 0; i < 2; i++) setParam(g[o][i].gain, m[o][i], when, mode);
      };
    },
  };
}

UNIT_BUILDERS.channelVolume = matrixUnit((v) => [[dbToGain(v.left), 0], [0, dbToGain(v.right)]]);
UNIT_BUILDERS.swapChannels = matrixUnit(() => [[0, 1], [1, 0]]);
UNIT_BUILDERS.invertChannels = matrixUnit((v) => [[v.left ? -1 : 1, 0], [0, v.right ? -1 : 1]]);
UNIT_BUILDERS.fillLeft = matrixUnit(() => [[0, 1], [0, 1]]);
UNIT_BUILDERS.fillRight = matrixUnit(() => [[1, 0], [1, 0]]);

// the curve editor in Effect Controls (loaded on first use)
for (const type of ['parametricEq', 'graphicEq', 'bass', 'treble']) {
  EFFECTS[type].widget = (api) => {
    const el = document.createElement('div');
    el.className = 'eq-widget';
    import('./ui/eq-widget.js').then((m) => m.mountEqWidget(el, { ...api, type })).catch((err) => console.warn('EQ curve unavailable', err));
    return el;
  };
}

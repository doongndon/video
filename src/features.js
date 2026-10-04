// One-tap editing features (the kind found in phone editors): in/out/loop animations, colour
// filters, text styles, emoji stickers, picture-in-picture positions, voice effects, background
// fill, silence (jump) cuts, beat markers, photo slideshows and aspect-ratio switching.

import { store } from './store.js';
import * as edit from './edit.js';
import { getRuntime, mediaStatus } from './media.js';
import {
  clipEnd, clipsOnTrack, evalParam, linkedClips, mediaTimeAt, videoTracks, audioTracks, createEffect, sequenceDuration, getTrack,
} from './model.js';
import { EFFECTS } from './effects.js';
import { clamp, dbToGain, snapFrame, uid, deepClone } from './util.js';

const seq = () => store.seq;
const VISUAL = new Set(['video', 'image', 'text', 'shape', 'color', 'nest']);

// ---------------------------------------------------------------- animations

/** In / out presets: `from` gives the starting state relative to the clip's resting state. */
export const ANIMATIONS = {
  in: [
    { id: 'fade', name: '페이드', ease: 'outSine', from: { opacity: 0 } },
    { id: 'zoomIn', name: '작게 → 크게', ease: 'outBack', from: { scale: 0.3, opacity: 0 } },
    { id: 'zoomOut', name: '크게 → 원래', ease: 'outCubic', from: { scale: 1.6, opacity: 0 } },
    { id: 'slideLeft', name: '왼쪽에서 들어오기', ease: 'outCubic', from: { dx: -0.7 } },
    { id: 'slideRight', name: '오른쪽에서 들어오기', ease: 'outCubic', from: { dx: 0.7 } },
    { id: 'slideUp', name: '아래에서 올라오기', ease: 'outCubic', from: { dy: 0.6, opacity: 0 } },
    { id: 'slideDown', name: '위에서 내려오기', ease: 'outCubic', from: { dy: -0.6, opacity: 0 } },
    { id: 'pop', name: '통통 튀며 등장', ease: 'outBounce', from: { scale: 0 } },
    { id: 'elastic', name: '고무줄처럼 등장', ease: 'outElastic', from: { scale: 0 } },
    { id: 'spin', name: '돌면서 등장', ease: 'outCubic', from: { rotation: -180, scale: 0.3, opacity: 0 } },
    { id: 'drop', name: '떨어지며 착지', ease: 'outBounce', from: { dy: -0.8 } },
    { id: 'typewriter', name: '타자기 (텍스트)', ease: 'linear', from: { reveal: 0 }, textOnly: true },
  ],
  out: [
    { id: 'fade', name: '페이드', ease: 'inSine', to: { opacity: 0 } },
    { id: 'zoomOut', name: '작아지며 사라짐', ease: 'inBack', to: { scale: 0.2, opacity: 0 } },
    { id: 'zoomIn', name: '커지며 사라짐', ease: 'inCubic', to: { scale: 1.8, opacity: 0 } },
    { id: 'slideLeft', name: '왼쪽으로 나가기', ease: 'inCubic', to: { dx: -0.7 } },
    { id: 'slideRight', name: '오른쪽으로 나가기', ease: 'inCubic', to: { dx: 0.7 } },
    { id: 'slideUp', name: '위로 날아가기', ease: 'inCubic', to: { dy: -0.6, opacity: 0 } },
    { id: 'slideDown', name: '아래로 떨어지기', ease: 'inBack', to: { dy: 0.7 } },
    { id: 'spin', name: '돌면서 사라짐', ease: 'inCubic', to: { rotation: 180, scale: 0.2, opacity: 0 } },
  ],
  loop: [
    { id: 'kenIn', name: '천천히 확대 (켄 번즈)' },
    { id: 'kenOut', name: '천천히 축소' },
    { id: 'panLR', name: '왼쪽 → 오른쪽 천천히 이동' },
    { id: 'float', name: '둥실둥실' },
    { id: 'wiggle', name: '흔들흔들' },
    { id: 'pulse', name: '두근두근' },
    { id: 'shake', name: '덜덜 떨림' },
  ],
};

const MOTION_KEYS = ['posX', 'posY', 'scale', 'rotation'];

/** Replace keyframes of a param inside [t0, t1] with two new ones (keeps keyframes outside). */
function setSegment(param, t0, t1, v0, v1, ease) {
  const kf = (param.kf || []).filter((k) => k.t < t0 - 1e-4 || k.t > t1 + 1e-4);
  kf.push({ t: t0, v: v0, ease }, { t: t1, v: v1, ease: 'linear' });
  kf.sort((a, b) => a.t - b.t);
  param.kf = kf;
}

function clipFx(c) {
  return {
    motion: c.effects.find((e) => e.type === 'motion'),
    opacity: c.effects.find((e) => e.type === 'opacity'),
    text: c.effects.find((e) => e.type === 'text'),
  };
}

/** Apply an animation preset. kind: 'in' | 'out' | 'loop'; duration in seconds (in/out). */
export function applyAnimation(clipIds, kind, presetId, duration = 0.6) {
  const s = seq();
  const preset = ANIMATIONS[kind]?.find((p) => p.id === presetId);
  if (!preset) return 0;
  let n = 0;
  store.transact(`애니메이션: ${preset.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || !VISUAL.has(c.kind)) continue;
      const { motion, opacity, text } = clipFx(c);
      if (!motion || !opacity) continue;
      if (preset.textOnly && !text) continue;
      const D = c.duration;
      const fps = s.fps;
      const q = (t) => Math.round(clamp(t, 0, D) * fps) / fps;
      if (kind === 'loop') {
        applyLoop(c, motion, preset.id, s);
        n++;
        continue;
      }
      // at least one frame, at most half the clip
      const d = Math.max(1 / fps, q(Math.min(duration, D / 2)));
      const restT = kind === 'in' ? d : q(D - d);
      const rest = {
        posX: evalParam(motion.params.posX, restT),
        posY: evalParam(motion.params.posY, restT),
        scale: evalParam(motion.params.scale, restT),
        rotation: evalParam(motion.params.rotation, restT),
        opacity: evalParam(opacity.params.opacity, restT),
        reveal: text ? evalParam(text.params.reveal, restT) : 100,
      };
      const delta = kind === 'in' ? preset.from : preset.to;
      const target = {
        posX: rest.posX + (delta.dx || 0) * s.width,
        posY: rest.posY + (delta.dy || 0) * s.height,
        scale: delta.scale != null ? rest.scale * delta.scale : rest.scale,
        rotation: rest.rotation + (delta.rotation || 0),
        opacity: delta.opacity != null ? delta.opacity : rest.opacity,
        reveal: delta.reveal != null ? delta.reveal : rest.reveal,
      };
      const touched = Object.keys(target).filter((k) => target[k] !== rest[k]);
      for (const key of touched) {
        const p = key === 'opacity' ? opacity.params.opacity : key === 'reveal' ? text?.params.reveal : motion.params[key];
        if (!p) continue;
        if (kind === 'in') setSegment(p, 0, d, target[key], rest[key], preset.ease);
        else setSegment(p, q(D - d), q(D), rest[key], target[key], preset.ease);
      }
      n++;
    }
  });
  return n;
}

function applyLoop(c, motion, id, s) {
  const D = c.duration;
  const fps = s.fps;
  const q = (t) => Math.round(clamp(t, 0, D) * fps) / fps;
  const mid = D / 2;
  const base = Object.fromEntries(MOTION_KEYS.map((k) => [k, evalParam(motion.params[k], mid)]));
  const wave = (key, amp, period) => {
    const kf = [];
    let sign = -1;
    for (let t = 0; t <= D + 1e-6; t += period / 2) {
      kf.push({ t: q(t), v: base[key] + sign * amp, ease: 'inOutSine' });
      sign = -sign;
    }
    motion.params[key].kf = kf.filter((k, i, a) => !i || k.t > a[i - 1].t);
  };
  switch (id) {
    case 'kenIn':
      motion.params.scale.kf = [{ t: 0, v: base.scale, ease: 'inOutSine' }, { t: q(D), v: base.scale * 1.18, ease: 'linear' }];
      break;
    case 'kenOut':
      motion.params.scale.kf = [{ t: 0, v: base.scale * 1.18, ease: 'inOutSine' }, { t: q(D), v: base.scale, ease: 'linear' }];
      break;
    case 'panLR':
      motion.params.scale.kf = null;
      motion.params.scale.value = Math.max(base.scale, 112);
      motion.params.posX.kf = [{ t: 0, v: base.posX - s.width * 0.04, ease: 'inOutSine' }, { t: q(D), v: base.posX + s.width * 0.04, ease: 'linear' }];
      break;
    case 'float':
      wave('posY', s.height * 0.015, 2);
      break;
    case 'wiggle':
      wave('rotation', 4, 1);
      break;
    case 'pulse':
      wave('scale', base.scale * 0.05, 0.8);
      break;
    case 'shake':
      wave('posX', s.width * 0.006, 0.12);
      break;
    default:
  }
}

/** Remove keyframes from Motion / Opacity (and the typewriter reveal), keeping the resting look. */
export function clearAnimations(clipIds) {
  const s = seq();
  store.transact('애니메이션 지우기', () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c) continue;
      const mid = c.duration / 2;
      for (const fx of c.effects) {
        if (!['motion', 'opacity', 'text'].includes(fx.type)) continue;
        for (const [k, p] of Object.entries(fx.params)) {
          if (!p.kf?.length || typeof p.kf[0].v !== 'number') continue;
          p.value = k === 'reveal' ? 100 : evalParam(p, mid);
          p.kf = null;
        }
      }
    }
  });
}

// ---------------------------------------------------------------- colour filters

const W = (hueDeg, amount) => ({ x: Math.round(Math.cos((hueDeg * Math.PI) / 180) * amount * 1000) / 1000, y: Math.round(Math.sin((hueDeg * Math.PI) / 180) * amount * 1000) / 1000 });
const FADE = (lo, hi) => ({ master: [[0, lo], [1, hi]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });
const SCURVE = { master: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };

export const FILTERS = [
  { id: 'none', name: '원본', v: {} },
  { id: 'vivid', name: '선명하게', v: { contrast: 15, saturation: 128, vibrance: 25 } },
  { id: 'bright', name: '화사하게', v: { exposure: 0.45, shadows: 20, saturation: 108 } },
  { id: 'warm', name: '따뜻하게', v: { temperature: 35, tint: 5, saturation: 106 } },
  { id: 'cool', name: '시원하게', v: { temperature: -35, saturation: 102 } },
  { id: 'cinema', name: '영화처럼', v: { contrast: 18, saturation: 110, shadowsWheel: W(190, 0.35), highlightsWheel: W(30, 0.3) } },
  { id: 'vintage', name: '빈티지', v: { contrast: -8, saturation: 72, temperature: 22, curves: FADE(0.08, 0.94), shadowsWheel: W(35, 0.2) } },
  { id: 'film', name: '필름', v: { contrast: 10, saturation: 85, curves: FADE(0.05, 0.96), midsWheel: W(150, 0.1) } },
  { id: 'retro', name: '레트로', v: { temperature: 25, tint: 15, saturation: 80, curves: SCURVE } },
  { id: 'dreamy', name: '몽환', v: { highlights: 25, contrast: -18, saturation: 88, curves: FADE(0.06, 1), highlightsWheel: W(320, 0.15) } },
  { id: 'moody', name: '무드 있게', v: { exposure: -0.35, contrast: 22, saturation: 78, temperature: -12 } },
  { id: 'sunset', name: '노을', v: { temperature: 45, tint: 15, highlightsWheel: W(25, 0.35), saturation: 112 } },
  { id: 'night', name: '푸른 밤', v: { temperature: -50, exposure: -0.3, saturation: 85, shadowsWheel: W(225, 0.25) } },
  { id: 'pink', name: '핑크빛', v: { tint: 25, highlights: 10, saturation: 92, highlightsWheel: W(330, 0.2) } },
  { id: 'mono', name: '흑백', v: { saturation: 0, contrast: 12 } },
  { id: 'noir', name: '흑백 대비', v: { saturation: 0, contrast: 45, blacks: -15, whites: 10 } },
];

/** The filter currently applied to a clip (from Montage's own filter effect), or 'none'. */
export function clipFilter(c) {
  return c?.effects.find((e) => e.filterId)?.filterId || 'none';
}

/** Put a filter on clips (replacing a previous one-tap filter). amount 0..100 scales its strength. */
export function applyFilter(clipIds, filterId, amount = 100) {
  const s = seq();
  const f = FILTERS.find((x) => x.id === filterId);
  if (!f) return;
  store.transact(`필터: ${f.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || !VISUAL.has(c.kind) || c.kind === 'text') continue;
      c.effects = c.effects.filter((e) => !e.filterId);
      if (filterId === 'none') continue;
      const fx = createEffect('lumetri', s);
      fx.filterId = filterId;
      fx.filterAmount = amount;
      const k = amount / 100;
      for (const [key, val] of Object.entries(f.v)) {
        const p = fx.params[key];
        if (!p) continue;
        const def = EFFECTS.lumetri.params.find((x) => x.key === key);
        if (typeof val === 'number') {
          const neutral = typeof def.default === 'number' ? def.default : 0;
          p.value = Math.round((neutral + (val - neutral) * k) * 1000) / 1000;
        } else if (key.endsWith('Wheel')) {
          p.value = { x: val.x * k, y: val.y * k };
        } else if (key === 'curves') {
          const mix = (pts) => pts.map(([x, y]) => [x, Math.round((x + (y - x) * k) * 1000) / 1000]);
          p.value = { master: mix(val.master), r: mix(val.r), g: mix(val.g), b: mix(val.b) };
        }
      }
      // filters sit right after the fixed effects so later effects (masks, keys…) still apply on top
      const firstUser = c.effects.findIndex((e) => !EFFECTS[e.type]?.fixed);
      if (firstUser < 0) c.effects.push(fx);
      else c.effects.splice(firstUser, 0, fx);
    }
  });
}

/** A copy of a clip with a filter applied (for preview thumbnails; never stored). */
export function previewWithFilter(c, filterId) {
  const copy = deepClone(c);
  copy.effects = copy.effects.filter((e) => !e.filterId);
  const f = FILTERS.find((x) => x.id === filterId);
  if (f && filterId !== 'none') {
    const fx = createEffect('lumetri', seq());
    fx.filterId = filterId;
    for (const [key, val] of Object.entries(f.v)) if (fx.params[key]) fx.params[key].value = deepClone(val);
    copy.effects.push(fx);
  }
  copy.transIn = null;
  copy.transOut = null;
  return copy;
}

// ---------------------------------------------------------------- text styles

export const TEXT_STYLES = [
  { id: 'plain', name: '기본 흰 글씨', v: { color: '#ffffff', strokeWidth: 0, background: false, bold: true } },
  { id: 'subtitle', name: '유튜브 자막', v: { color: '#ffffff', strokeWidth: 0, background: true, bgColor: '#000000', bgOpacity: 62, bold: false } },
  { id: 'variety', name: '노란 예능 자막', v: { font: 'Black Han Sans', color: '#ffe14d', strokeColor: '#000000', strokeRel: 0.1, background: false } },
  { id: 'outline', name: '굵은 외곽선', v: { color: '#ffffff', strokeColor: '#000000', strokeRel: 0.08, background: false, bold: true } },
  { id: 'marker', name: '형광펜', v: { color: '#111111', strokeWidth: 0, background: true, bgColor: '#ffe600', bgOpacity: 100, bold: true } },
  { id: 'pink', name: '핑크 귀요미', v: { font: 'Jua', color: '#ff6fae', strokeColor: '#ffffff', strokeRel: 0.08, background: false } },
  { id: 'note', name: '손글씨 메모', v: { font: 'Nanum Pen Script', color: '#ffffff', strokeWidth: 0, background: false, bold: false } },
  { id: 'news', name: '뉴스 헤드라인', v: { font: 'Noto Serif KR', color: '#ffffff', strokeWidth: 0, background: true, bgColor: '#b91c1c', bgOpacity: 92, bold: true } },
  { id: 'cute', name: '동글동글', v: { font: 'Dongle', color: '#ffffff', strokeColor: '#5b3cc4', strokeRel: 0.09, background: false } },
  { id: 'neon', name: '네온', v: { font: 'Do Hyeon', color: '#9ef9ff', strokeColor: '#1e6bff', strokeRel: 0.05, background: false } },
];

export function applyTextStyle(clipIds, styleId) {
  const s = seq();
  const st = TEXT_STYLES.find((x) => x.id === styleId);
  if (!st) return 0;
  let n = 0;
  store.transact(`글자 스타일: ${st.name}`, () => {
    for (const id of clipIds) {
      const tx = s.clips[id]?.effects.find((e) => e.type === 'text');
      if (!tx) continue;
      const size = evalParam(tx.params.size, 0);
      for (const [k, v] of Object.entries(st.v)) {
        if (k === 'strokeRel') {
          tx.params.strokeWidth.value = Math.max(1, Math.round(size * v));
          tx.params.strokeWidth.kf = null;
        } else if (tx.params[k]) tx.params[k].value = v;
      }
      if (st.v.background) tx.params.bgPadding.value = Math.round(size * 0.22);
      n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------- stickers

export const EMOJIS = ['😀', '😂', '🤣', '🥰', '😍', '😎', '🤔', '😮', '😭', '😡', '🥳', '😴', '👍', '👏', '🙏', '💪', '👀', '🔥', '✨', '💯', '❤️', '💔', '💕', '🎉', '🎂', '🎁', '🎵', '🎬', '📷', '💡', '📌', '⭐', '⚡', '☀️', '🌙', '☔', '🌸', '🍀', '🐶', '🐱', '🍔', '☕', '🚗', '✈️', '✅', '❌', '❗', '❓', '➡️', '⬅️', '⬆️', '⬇️', '💬', '💥', '💤', '🆗'];

export function addSticker(emoji, at = store.ui.playhead) {
  const s = seq();
  const id = edit.addTextClip({ start: at, content: emoji, x: s.width * 0.75, y: s.height * 0.3 });
  store.transact('스티커', () => {
    const c = s.clips[id];
    if (!c) return;
    c.name = `스티커 ${emoji}`;
    c.duration = Math.min(c.duration, 3);
    const tx = c.effects.find((e) => e.type === 'text');
    tx.params.size.value = Math.round(s.height * 0.16);
    tx.params.strokeWidth.value = 0;
    tx.params.background.value = false;
  });
  applyAnimation([id], 'in', 'pop', 0.5);
  return id;
}

// ---------------------------------------------------------------- picture in picture

export const PIP_POSITIONS = [
  ['tl', '왼쪽 위'], ['tr', '오른쪽 위'], ['bl', '왼쪽 아래'], ['br', '오른쪽 아래'], ['center', '가운데 작게'], ['fit', '화면에 맞춤'], ['fill', '화면 꽉 채우기'],
];

export function setPip(clipIds, pos, size = 35) {
  const s = seq();
  store.transact('화면 속 화면 위치', () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      const motion = c?.effects.find((e) => e.type === 'motion');
      const m = c?.mediaId ? store.project.media[c.mediaId] : null;
      if (!motion || !m?.width || !m?.height) continue;
      for (const k of ['posX', 'posY', 'scale']) motion.params[k].kf = null;
      const fit = Math.min(s.width / m.width, s.height / m.height);
      if (pos === 'fit' || pos === 'fill') {
        const fill = Math.max(s.width / m.width, s.height / m.height);
        motion.params.scale.value = pos === 'fit' ? 100 : Math.round((fill / fit) * 1000) / 10;
        motion.params.posX.value = s.width / 2;
        motion.params.posY.value = s.height / 2;
        continue;
      }
      const w = m.width * fit * (size / 100);
      const hh = m.height * fit * (size / 100);
      const mx = s.width * 0.04;
      const my = s.height * 0.05;
      motion.params.scale.value = size;
      motion.params.posX.value = Math.round(pos === 'center' ? s.width / 2 : pos.endsWith('l') ? mx + w / 2 : s.width - mx - w / 2);
      motion.params.posY.value = Math.round(pos === 'center' ? s.height / 2 : pos.startsWith('t') ? my + hh / 2 : s.height - my - hh / 2);
    }
  });
}

// ---------------------------------------------------------------- background fill

export function setBackgroundFill(clipIds, mode, { blur = 40, color = '#ffffff' } = {}) {
  const s = seq();
  store.transact('배경 채우기', () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || !['video', 'image', 'nest'].includes(c.kind)) continue;
      c.effects = c.effects.filter((e) => e.type !== 'blurFill');
      if (mode === 'none') continue;
      const fx = createEffect('blurFill', s);
      fx.params.mode.value = mode;
      fx.params.blur.value = blur;
      fx.params.color.value = color;
      c.effects.push(fx);
    }
  });
}

/** Colour behind everything in the sequence (letterbox bars, empty frames). */
export function setSequenceBackground(color) {
  store.transact('배경색', () => { seq().background = color; });
}

// ---------------------------------------------------------------- voice effects

export const VOICES = [
  { id: 'none', name: '원래 목소리', fx: [] },
  { id: 'robot', name: '로봇', fx: [['ringMod', { freq: 55, mix: 100 }], ['highpass', { frequency: 150 }]] },
  { id: 'phone', name: '전화 통화', fx: [['bandpass', { frequency: 1500, q: 1.3 }], ['compressor', { threshold: -30, ratio: 6 }]] },
  { id: 'radio', name: '라디오', fx: [['bandpass', { frequency: 1800, q: 0.8 }], ['compressor', { threshold: -28, ratio: 5, makeup: 4 }]] },
  { id: 'megaphone', name: '확성기', fx: [['highpass', { frequency: 700 }], ['lowpass', { frequency: 4000 }], ['gain', { gain: 8 }], ['compressor', { threshold: -20, ratio: 12 }]] },
  { id: 'cave', name: '동굴', fx: [['reverb', { mix: 55, decay: 4.5 }]] },
  { id: 'hall', name: '공연장', fx: [['reverb', { mix: 32, decay: 2.5 }]] },
  { id: 'echo', name: '메아리', fx: [['delay', { time: 0.28, feedback: 45, mix: 40 }]] },
  { id: 'underwater', name: '물속', fx: [['lowpass', { frequency: 450, q: 2 }]] },
  { id: 'clear', name: '또렷하게 (목소리 보정)', fx: [['highpass', { frequency: 90 }], ['eq3', { midFreq: 3000, midGain: 4, lowGain: -2 }], ['compressor', { threshold: -24, ratio: 3, makeup: 3 }]] },
];

export function applyVoice(clipIds, voiceId) {
  const s = seq();
  const v = VOICES.find((x) => x.id === voiceId);
  if (!v) return 0;
  let n = 0;
  store.transact(`목소리 효과: ${v.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || c.kind !== 'audio') continue;
      c.effects = c.effects.filter((e) => !e.voiceId);
      for (const [type, vals] of v.fx) {
        const fx = createEffect(type, s);
        fx.voiceId = voiceId;
        for (const [k, val] of Object.entries(vals)) if (fx.params[k]) fx.params[k].value = val;
        c.effects.push(fx);
      }
      n++;
    }
  });
  return n;
}

export const clipVoice = (c) => c?.effects.find((e) => e.voiceId)?.voiceId || 'none';

// ---------------------------------------------------------------- silence (jump) cuts

/**
 * Silent stretches (sequence time) of an audio clip: waveform below thresholdDb for at least
 * minSilence seconds, shrunk by `pad` on both sides so words are not clipped.
 */
export function silentIntervals(c, { thresholdDb = -40, minSilence = 0.6, pad = 0.12 } = {}) {
  const p = getRuntime(c.mediaId).peaks;
  if (!p) return null;
  const thr = dbToGain(thresholdDb);
  const step = 0.02;
  const out = [];
  let open = null;
  for (let t = c.start; t < clipEnd(c); t += step) {
    const mt = mediaTimeAt(c, t);
    const i0 = Math.max(0, Math.floor(mt * p.rate));
    let m = 0;
    for (let i = i0; i < Math.min(p.data.length, i0 + Math.max(1, Math.ceil(step * p.rate))); i++) m = Math.max(m, p.data[i]);
    if (m < thr) {
      if (open == null) open = t;
    } else if (open != null) {
      out.push([open, t]);
      open = null;
    }
  }
  if (open != null) out.push([open, clipEnd(c)]);
  return out
    .filter(([a, b]) => b - a >= minSilence)
    .map(([a, b]) => [a === c.start ? a : a + pad, b >= clipEnd(c) - 1e-6 ? b : b - pad])
    .filter(([a, b]) => b - a > 0.05);
}

/**
 * Cut the silent parts out of the selected clips (and their linked partners) and close the gaps.
 * allTracks: also pull every other unlocked track so the whole timeline stays in sync.
 * trackIds: exactly these tracks are cut and pulled (overrides allTracks).
 * Returns {cuts, removed} or null when waveforms are still being analysed.
 */
export function cutSilence(clipIds, opts = {}) {
  const s = seq();
  const audio = [...new Set(clipIds.flatMap((id) => {
    const c = s.clips[id];
    return c ? [c, ...linkedClips(s, c)] : [];
  }))].filter((c) => c.kind === 'audio' && c.mediaId && mediaStatus(c.mediaId) === 'ready');
  if (!audio.length) return { cuts: 0, removed: 0, noAudio: true };
  let ranges = [];
  for (const c of audio) {
    const iv = silentIntervals(c, opts);
    if (!iv) return null;
    ranges.push(...iv.map((r) => ({ r, c })));
  }
  // one clip group at a time; a range is cut on the tracks of that clip and its linked partners
  ranges = ranges.map(({ r, c }) => ({ r: [snapFrame(r[0], s.fps), snapFrame(r[1], s.fps)], tracks: [...new Set([c, ...linkedClips(s, c)].map((x) => x.trackId))] }))
    .filter(({ r }) => r[1] - r[0] >= 1 / s.fps)
    .sort((a, b) => b.r[0] - a.r[0]);
  if (!ranges.length) return { cuts: 0, removed: 0 };
  const unlocked = s.tracks.filter((t) => !t.locked).map((t) => t.id);
  let removed = 0;
  store.transact('무음 구간 자동 삭제', () => {
    for (const { r: [a, b], tracks } of ranges) {
      const tids = opts.trackIds ? opts.trackIds.filter((t) => unlocked.includes(t)) : opts.allTracks ? unlocked : tracks.filter((t) => !getTrack(s, t)?.locked);
      edit.rawClearRangeMulti(tids, a, b);
      edit.rawRipple(tids, b, -(b - a));
      removed += b - a;
    }
  });
  return { cuts: ranges.length, removed };
}

/** Sequence-time intervals where the given tracks carry audible sound (from waveform peaks). */
export function soundIntervals(seq, trackIds, thresholdDb, { step = 0.05, minGap = 0.5, minLen = 0.2 } = {}) {
  const thr = dbToGain(thresholdDb);
  const raw = [];
  for (const tid of trackIds) {
    const track = seq.tracks.find((t) => t.id === tid);
    if (!track || track.muted) continue;
    for (const c of clipsOnTrack(seq, tid)) {
      if (c.kind !== 'audio' || c.enabled === false) continue;
      const p = getRuntime(c.mediaId).peaks;
      if (!p) continue;
      let open = null;
      for (let t = c.start; t < clipEnd(c); t += step) {
        const mt = mediaTimeAt(c, t);
        const i0 = Math.max(0, Math.floor(mt * p.rate));
        const i1 = Math.min(p.data.length, i0 + Math.max(1, Math.ceil(step * p.rate * Math.abs(c.speed || 1))));
        let m = 0;
        for (let i = i0; i < i1; i++) m = Math.max(m, p.data[i]);
        if (m >= thr) {
          if (open == null) open = t;
        } else if (open != null) {
          raw.push([open, t]);
          open = null;
        }
      }
      if (open != null) raw.push([open, clipEnd(c)]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < minGap) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  return merged.filter(([a, b]) => b - a >= minLen);
}

// ---------------------------------------------------------------- beats

/** Beat / onset times (sequence seconds) of an audio clip from its waveform. sensitivity 0..100. */
export function detectBeats(c, sensitivity = 50) {
  const p = getRuntime(c.mediaId).peaks;
  if (!p) return null;
  const step = 1 / 100;
  const env = [];
  for (let t = c.start; t < clipEnd(c); t += step) {
    const i = Math.floor(mediaTimeAt(c, t) * p.rate);
    env.push(p.data[Math.max(0, Math.min(p.data.length - 1, i))] || 0);
  }
  // onset strength: rise of a lightly smoothed envelope
  const sm = env.map((_, i) => (env[i - 1] ?? env[i]) * 0.25 + env[i] * 0.5 + (env[i + 1] ?? env[i]) * 0.25);
  const on = sm.map((v, i) => Math.max(0, v - (sm[i - 3] ?? v)));
  const k = 0.6 + ((100 - sensitivity) / 100) * 2.2;
  const W = 75; // ±0.75 s window
  const beats = [];
  let last = -1;
  for (let i = 0; i < on.length; i++) {
    const a = Math.max(0, i - W);
    const b = Math.min(on.length, i + W);
    let mean = 0;
    for (let j = a; j < b; j++) mean += on[j];
    mean /= b - a;
    let vr = 0;
    for (let j = a; j < b; j++) vr += (on[j] - mean) ** 2;
    const sd = Math.sqrt(vr / (b - a));
    const isPeak = on[i] > (on[i - 1] ?? 0) && on[i] >= (on[i + 1] ?? 0);
    if (isPeak && on[i] > mean + k * sd && on[i] > 0.01 && (last < 0 || i - last >= 25)) {
      beats.push(c.start + i * step);
      last = i;
    }
  }
  return beats;
}

export function addBeatMarkers(times) {
  const s = seq();
  store.transact('비트 마커', () => {
    for (const t of times) {
      const tt = snapFrame(t, s.fps);
      if (s.markers.some((m) => Math.abs(m.time - tt) < 0.5 / s.fps)) continue;
      s.markers.push({ id: uid('mk'), time: tt, name: '비트', color: '#facc15', comment: '' });
    }
    s.markers.sort((a, b) => a.time - b.time);
  });
}

// ---------------------------------------------------------------- slideshow

/**
 * Place photos (and videos) one after another from the playhead with transitions and optional
 * slow zoom (Ken Burns). Returns the number of items placed.
 */
export function createSlideshow(mediaIds, { perImage = 3, transition = 'crossDissolve', transDur = 0.6, kenBurns = true, fill = true } = {}) {
  const s = seq();
  const ids = mediaIds.filter((id) => ['image', 'video'].includes(store.project.media[id]?.kind) && mediaStatus(id) === 'ready');
  if (!ids.length) return 0;
  const track = videoTracks(s).find((t) => t.targeted && !t.locked) || videoTracks(s).find((t) => !t.locked);
  if (!track) return 0;
  let t = snapFrame(store.ui.playhead, s.fps);
  const placed = [];
  store.transact('슬라이드쇼 만들기', () => {
    for (const id of ids) {
      const m = store.project.media[id];
      const dur = m.kind === 'image' ? perImage : m.outPoint != null || m.inPoint != null ? (m.outPoint ?? m.duration) - (m.inPoint ?? 0) : m.duration;
      const [cid] = edit.placeMedia(id, { mode: 'overwrite', start: t, vTrackId: track.id, inPoint: m.kind === 'image' ? 0 : m.inPoint ?? 0, outPoint: m.kind === 'image' ? perImage : undefined, audio: m.kind === 'video' });
      if (cid) placed.push(cid);
      t = snapFrame(t + dur, s.fps);
    }
    if (fill) setPip(placed, 'fill');
    placed.forEach((cid, i) => {
      if (kenBurns && store.project.media[s.clips[cid]?.mediaId]?.kind === 'image') applyAnimation([cid], 'loop', i % 2 ? 'kenOut' : 'kenIn');
      if (i > 0 && transition) edit.applyTransition(cid, 'in', transition, transDur);
    });
    if (transition && placed.length) {
      edit.applyTransition(placed[0], 'in', 'crossDissolve', transDur);
      edit.applyTransition(placed[placed.length - 1], 'out', 'crossDissolve', transDur);
    }
  });
  store.selectClips(placed);
  return placed.length;
}

// ---------------------------------------------------------------- aspect ratio

export const ASPECTS = [
  ['16:9', 1920, 1080, '가로 (유튜브)'],
  ['9:16', 1080, 1920, '세로 (쇼츠·릴스·틱톡)'],
  ['1:1', 1080, 1080, '정사각형'],
  ['4:5', 1080, 1350, '인스타 피드'],
  ['4:3', 1440, 1080, '옛날 TV'],
  ['21:9', 2560, 1080, '시네마'],
];

export function setAspect(id) {
  const a = ASPECTS.find((x) => x[0] === id);
  if (!a) return;
  edit.updateSequenceSettings({ width: a[1], height: a[2], fps: seq().fps, name: seq().name });
}

// ---------------------------------------------------------------- duplicate

/** Duplicate the selected clips (with linked partners) right after themselves, pushing later clips. */
export function duplicateClips(ids) {
  const s = seq();
  const all = [...edit.withLinked(ids)].filter((id) => s.clips[id]);
  if (!all.length) return [];
  const start = Math.min(...all.map((id) => s.clips[id].start));
  const end = Math.max(...all.map((id) => clipEnd(s.clips[id])));
  let copies = null;
  store.transact('복제', () => {
    copies = edit.rawMoveClips(all, end - start, 0, 0, { mode: 'insert', duplicate: true });
  });
  if (copies) store.selectClips(copies);
  return copies || [];
}

// ---------------------------------------------------------------- misc helpers for touch UIs

/** Visual (non-audio) clips among the selection, or the topmost visual clip under the playhead. */
export function targetVisualClips() {
  const sel = store.selectedClips().filter((c) => VISUAL.has(c.kind));
  if (sel.length) return sel.map((c) => c.id);
  const s = seq();
  const t = store.ui.playhead;
  for (const tr of videoTracks(s).slice().reverse()) {
    const c = clipsOnTrack(s, tr.id).find((x) => x.start <= t && clipEnd(x) > t);
    if (c) return [c.id];
  }
  return [];
}

/** Audio clips among the selection (including linked audio of selected videos). */
export function targetAudioClips() {
  const s = seq();
  const ids = new Set();
  for (const c of store.selectedClips()) {
    if (c.kind === 'audio') ids.add(c.id);
    for (const l of linkedClips(s, c)) if (l.kind === 'audio') ids.add(l.id);
  }
  if (!ids.size) {
    const t = store.ui.playhead;
    for (const tr of audioTracks(s)) {
      const c = clipsOnTrack(s, tr.id).find((x) => x.start <= t && clipEnd(x) > t);
      if (c) ids.add(c.id);
    }
  }
  return [...ids];
}

export const sequenceEnd = () => sequenceDuration(seq());

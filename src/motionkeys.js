// Keyframe helpers for moving objects (position, size, rotation, opacity) without the Effect
// Controls panel: the "키프레임 기록" toggle, keying the current pose, jumping between keyframes,
// deleting keys, the motion feel (easing) and the data for the motion path on the monitor.

import { store } from './store.js';
import { clipEnd, evalParam, isAnimated, setParamValue, keyframeDefaults } from './model.js';
import { clamp } from './util.js';

const PREF = 'montage.autoKey';
export const KEY_PARAMS = [['motion', 'posX'], ['motion', 'posY'], ['motion', 'scale'], ['motion', 'rotation'], ['opacity', 'opacity']];

try {
  store.ui.autoKey = localStorage.getItem(PREF) === '1';
} catch {
  /* storage unavailable */
}

export function setAutoKey(on) {
  store.ui.autoKey = !!on;
  try {
    localStorage.setItem(PREF, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  store.emit('autokey');
  store.emit('toast', on ? '키프레임 기록 켬: 움직이거나 크기·회전·불투명도를 바꾸면 재생헤드 위치에 키프레임이 생깁니다' : '키프레임 기록 끔');
}

const fd = () => 1 / store.seq.fps;
const localT = (c) => clamp(store.ui.playhead - c.start, 0, c.duration);

function keyParams(c) {
  const out = [];
  for (const [type, key] of KEY_PARAMS) {
    const p = c?.effects.find((e) => e.type === type)?.params[key];
    if (p) out.push({ type, key, p });
  }
  return out;
}

/** Sorted unique keyframe times (clip-local seconds) over position, size, rotation and opacity. */
export function keyTimes(c) {
  const ts = [];
  for (const { p } of keyParams(c)) for (const k of p.kf || []) if (!ts.some((x) => Math.abs(x - k.t) < 1e-3)) ts.push(k.t);
  return ts.sort((a, b) => a - b);
}

export const hasMotionKeys = (c) => keyParams(c).some(({ p }) => isAnimated(p));

/** Key every movement value at the playhead with what is shown now. */
export function keyCurrentPose(clipId) {
  const c = store.seq.clips[clipId];
  if (!c) return 0;
  const t = localT(c);
  let n = 0;
  store.transact('키프레임 추가', () => {
    for (const { p } of keyParams(c)) {
      const v = evalParam(p, t);
      if (!isAnimated(p)) p.kf = [{ t, v, ease: keyframeDefaults.ease }];
      else setParamValue(p, v, t, fd());
      n++;
    }
  });
  return n;
}

/** Move the playhead to the previous (-1) or next (+1) keyframe of the clip. */
export function jumpKey(clipId, dir) {
  const c = store.seq.clips[clipId];
  if (!c) return false;
  const t = localT(c);
  const ts = keyTimes(c);
  const target = dir < 0 ? [...ts].reverse().find((x) => x < t - 1e-3) : ts.find((x) => x > t + 1e-3);
  if (target == null) return false;
  store.setPlayhead(Math.min(c.start + target, clipEnd(c) - 1e-3));
  return true;
}

/** Delete the keyframes at the playhead (all movement values). */
export function deleteKeysHere(clipId) {
  const c = store.seq.clips[clipId];
  if (!c) return 0;
  const t = localT(c);
  let n = 0;
  store.transact('키프레임 삭제', () => {
    for (const { p } of keyParams(c)) {
      if (!isAnimated(p)) continue;
      const before = p.kf.length;
      const value = evalParam(p, t);
      p.kf = p.kf.filter((k) => Math.abs(k.t - t) >= fd() / 2);
      n += before - p.kf.length;
      if (!p.kf.length) {
        p.kf = null;
        p.value = value;
      }
    }
  });
  return n;
}

/** Use one easing for every movement keyframe of the clip. */
export function setMotionEase(clipId, ease) {
  const c = store.seq.clips[clipId];
  if (!c) return;
  store.transact('움직임 느낌', () => {
    for (const { p } of keyParams(c)) for (const k of p.kf || []) k.ease = ease;
  });
  keyframeDefaults.ease = ease;
}

/** Position over the clip (sequence px) for the motion path, sampled `n` times, plus key times. */
export function motionPath(c, n = 120) {
  const m = c?.effects.find((e) => e.type === 'motion');
  if (!m || !(isAnimated(m.params.posX) || isAnimated(m.params.posY))) return null;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (c.duration * i) / n;
    pts.push([evalParam(m.params.posX, t), evalParam(m.params.posY, t)]);
  }
  const ts = [...new Set([...(m.params.posX.kf || []), ...(m.params.posY.kf || [])].map((k) => Math.round(k.t * 1000) / 1000))].sort((a, b) => a - b);
  const keys = ts.map((t) => ({ t, x: evalParam(m.params.posX, t), y: evalParam(m.params.posY, t) }));
  return { pts, keys };
}

/**
 * Raw (inside begin/commit): set the position keyframe at clip time t. An axis that is not
 * animated yet gets keyframes at the other axis' times so both move together.
 */
export function rawSetPathKey(c, t, x, y) {
  const m = c.effects.find((e) => e.type === 'motion');
  if (!m) return;
  const { posX, posY } = m.params;
  for (const [p, other] of [[posX, posY], [posY, posX]]) {
    if (!isAnimated(p) && isAnimated(other)) p.kf = other.kf.map((k) => ({ t: k.t, v: p.value, ease: k.ease }));
  }
  setParamValue(posX, x, t, fd());
  setParamValue(posY, y, t, fd());
}

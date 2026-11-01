// Effect presets (사전 설정), like Premiere Pro's: the values and keyframes of one or more effects
// saved under a name in this browser, with Premiere's keyframe placement types (비율 조정 · 앵커를
// In 지점으로 · 앵커를 Out 지점으로). Built-in presets mirror Premiere's 사전 설정 bin (블러 인/아웃,
// 비틀기 인/아웃, PiP …), and the Lumetri 사전 설정 apply ready-made looks with Lumetri 색상.
//
// A saved preset: { id, name, desc, anchor: 'scale' | 'in' | 'out', duration (seconds of the clip it
// was saved from), effects: [{ type, enabled, params, masks? }] }. Presets saved by older versions
// held one effect ({ id, name, type, enabled, params }) and still load and apply.

import { store } from '../store.js';
import { uid, deepClone, h, clamp } from '../util.js';
import { loadPref, savePref, openModal, toast } from './common.js';
import { EFFECTS, effectFitsClip } from '../effects.js';
import { createEffect } from '../model.js';
import { rawSyncLinkedRemap } from '../edit.js';

export const PRESET_ANCHORS = [
  ['scale', '비율 조정', '키프레임 간격을 클립 길이에 맞춰 늘이거나 줄입니다'],
  ['in', '앵커를 In 지점으로', '키프레임을 클립 시작 기준으로 둡니다'],
  ['out', '앵커를 Out 지점으로', '키프레임을 클립 끝 기준으로 둡니다'],
];

// ---------------------------------------------------------------- user presets

export function listPresets() {
  const list = loadPref('fxPresets', []);
  return Array.isArray(list) ? list.filter((p) => p && p.id && p.name) : [];
}

/**
 * Save effects as a preset. `effects` is one effect or a list; opts { anchor, desc, duration }.
 * Returns the stored preset.
 */
export function savePreset(name, effects, { anchor = 'scale', desc = '', duration = null } = {}) {
  const fxs = (Array.isArray(effects) ? effects : [effects]).filter(Boolean);
  const preset = {
    id: uid('pre'),
    name,
    desc,
    anchor,
    duration,
    effects: fxs.map((fx) => ({ type: fx.type, enabled: fx.enabled !== false, params: deepClone(fx.params), ...(fx.masks?.length ? { masks: deepClone(fx.masks) } : {}) })),
  };
  // single-effect presets keep the older fields too, so older code can still apply them
  if (preset.effects.length === 1) Object.assign(preset, { type: preset.effects[0].type, enabled: preset.effects[0].enabled, params: preset.effects[0].params });
  const list = listPresets();
  list.push(preset);
  savePref('fxPresets', list);
  store.emit('presets');
  return preset;
}

export function deletePreset(id) {
  savePref('fxPresets', listPresets().filter((p) => p.id !== id));
  store.emit('presets');
}

export function renamePreset(id, name, desc) {
  const list = listPresets();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  p.name = name;
  if (desc != null) p.desc = desc;
  savePref('fxPresets', list);
  store.emit('presets');
}

// ---------------------------------------------------------------- built-in presets

const val = (v) => ({ value: v, kf: null });
/** A keyframed param from [[t, v], …] (straight lines). */
const keys = (list) => ({ value: list[0][1], kf: list.map(([t, v]) => ({ t, v, ease: 'linear' })) });
/** A keyframed param whose key values depend on the sequence: fn(seq) → [[t, v], …]. */
const keysSeq = (fn) => (seq) => keys(fn(seq));
/** Picture-in-picture position: quarter-size picture in a corner, 5% from the frame edges. */
const pip = (sx, sy) => ({
  scale: val(25),
  posX: (seq) => val(Math.round(sx < 0 ? seq.height * 0.05 + seq.width / 8 : seq.width - seq.height * 0.05 - seq.width / 8)),
  posY: (seq) => val(Math.round(sy < 0 ? seq.height * 0.05 + seq.height / 8 : seq.height - seq.height * 0.05 - seq.height / 8)),
});

/** Premiere's 사전 설정 bin (sub-bin → presets), with the effects of this app. */
export const BUILTIN_PRESETS = [
  { id: 'bi:blurIn', folder: '블러', name: '빠른 흐림 효과 인', desc: '처음 1초 동안 흐린 화면이 또렷해집니다', anchor: 'in', duration: 1, effects: [{ type: 'gaussianBlur', params: { blurriness: keys([[0, 60], [1, 0]]) } }] },
  { id: 'bi:blurOut', folder: '블러', name: '빠른 흐림 효과 아웃', desc: '마지막 1초 동안 화면이 흐려집니다', anchor: 'out', duration: 1, effects: [{ type: 'gaussianBlur', params: { blurriness: keys([[0, 0], [1, 60]]) } }] },
  { id: 'bi:twirlIn', folder: '비틀기', name: '비틀기 인', desc: '처음 1초 동안 소용돌이가 풀리며 나타납니다', anchor: 'in', duration: 1, effects: [{ type: 'twirl', params: { angle: keys([[0, 360], [1, 0]]), radius: val(60) } }] },
  { id: 'bi:twirlOut', folder: '비틀기', name: '비틀기 아웃', desc: '마지막 1초 동안 소용돌이처럼 말려 들어갑니다', anchor: 'out', duration: 1, effects: [{ type: 'twirl', params: { angle: keys([[0, 0], [1, 360]]), radius: val(60) } }] },
  { id: 'bi:pipUL', folder: 'PiP', name: 'PiP 25% 왼쪽 위', desc: '화면 왼쪽 위에 1/4 크기로', anchor: 'scale', duration: 1, effects: [{ type: 'motion', params: pip(-1, -1) }] },
  { id: 'bi:pipUR', folder: 'PiP', name: 'PiP 25% 오른쪽 위', desc: '화면 오른쪽 위에 1/4 크기로', anchor: 'scale', duration: 1, effects: [{ type: 'motion', params: pip(1, -1) }] },
  { id: 'bi:pipLL', folder: 'PiP', name: 'PiP 25% 왼쪽 아래', desc: '화면 왼쪽 아래에 1/4 크기로', anchor: 'scale', duration: 1, effects: [{ type: 'motion', params: pip(-1, 1) }] },
  { id: 'bi:pipLR', folder: 'PiP', name: 'PiP 25% 오른쪽 아래', desc: '화면 오른쪽 아래에 1/4 크기로', anchor: 'scale', duration: 1, effects: [{ type: 'motion', params: pip(1, 1) }] },
  {
    id: 'bi:pipURin', folder: 'PiP', name: 'PiP 25% 오른쪽 위 확대', desc: '처음 1초 동안 오른쪽 위에서 커지며 나타납니다', anchor: 'in', duration: 1,
    effects: [{ type: 'motion', params: { ...pip(1, -1), scale: keys([[0, 0], [1, 25]]) } }],
  },
  {
    id: 'bi:pipURout', folder: 'PiP', name: 'PiP 25% 오른쪽 위 축소', desc: '마지막 1초 동안 오른쪽 위로 작아지며 사라집니다', anchor: 'out', duration: 1,
    effects: [{ type: 'motion', params: { ...pip(1, -1), scale: keys([[0, 25], [1, 0]]) } }],
  },
  { id: 'bi:fadeIn', folder: '불투명도', name: '페이드 인 (1초)', desc: '처음 1초 동안 검은 화면에서 나타납니다', anchor: 'in', duration: 1, effects: [{ type: 'opacity', params: { opacity: keys([[0, 0], [1, 100]]) } }] },
  { id: 'bi:fadeOut', folder: '불투명도', name: '페이드 아웃 (1초)', desc: '마지막 1초 동안 사라집니다', anchor: 'out', duration: 1, effects: [{ type: 'opacity', params: { opacity: keys([[0, 100], [1, 0]]) } }] },
  { id: 'bi:kenIn', folder: '모션', name: '천천히 확대 (켄 번스)', desc: '클립 길이 내내 천천히 다가갑니다', anchor: 'scale', duration: 5, effects: [{ type: 'motion', params: { scale: keys([[0, 100], [5, 115]]) } }] },
  { id: 'bi:kenOut', folder: '모션', name: '천천히 축소 (켄 번스)', desc: '클립 길이 내내 천천히 멀어집니다', anchor: 'scale', duration: 5, effects: [{ type: 'motion', params: { scale: keys([[0, 115], [5, 100]]) } }] },
  {
    id: 'bi:slideInL', folder: '모션', name: '왼쪽에서 밀려 들어오기', desc: '처음 1초 동안 화면 왼쪽 밖에서 들어옵니다', anchor: 'in', duration: 1,
    effects: [{ type: 'motion', params: { posX: keysSeq((s) => [[0, -s.width / 2], [1, s.width / 2]]) } }],
  },
  {
    id: 'bi:slideOutR', folder: '모션', name: '오른쪽으로 밀려 나가기', desc: '마지막 1초 동안 화면 오른쪽 밖으로 나갑니다', anchor: 'out', duration: 1,
    effects: [{ type: 'motion', params: { posX: keysSeq((s) => [[0, s.width / 2], [1, s.width * 1.5]]) } }],
  },
];

const look = (id, extra = {}) => ({ look: val(id), lookIntensity: val(100), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, val(v)])) });
const basic = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, val(v)]));

/** Premiere's Lumetri 사전 설정 bin: looks applied with a Lumetri 색상 effect. */
export const LUMETRI_PRESETS = [
  ['시네마틱', '시네마틱 틸 앤 오렌지', look('look:tealOrange')],
  ['시네마틱', '블리치 바이패스', look('look:bleach')],
  ['시네마틱', '골든 아워', look('look:golden')],
  ['시네마틱', '블루 아워', look('look:blueHour')],
  ['시네마틱', '낮을 밤처럼', look('look:dayForNight')],
  ['필름', '따뜻한 필름', look('look:warmFilm')],
  ['필름', '차가운 필름', look('look:coolFilm')],
  ['필름', '빈티지', look('look:vintage')],
  ['필름', '매트 페이드', look('look:matte')],
  ['필름', '크로스 프로세스', look('look:cross')],
  ['필름', '파스텔', look('look:pastel')],
  ['필름', '세피아 필름', look('look:sepiaFilm')],
  ['흑백', '흑백 느와르', look('look:noir')],
  ['흑백', '부드러운 흑백', look('look:softMono')],
  ['흑백', '흑백 (채도 0)', basic({ saturation: 0 })],
  ['흑백', '흑백 고대비', basic({ saturation: 0, contrast: 45, whites: 15, blacks: -15 })],
  ['기술', '노출 +1 스톱', basic({ exposure: 1 })],
  ['기술', '노출 -1 스톱', basic({ exposure: -1 })],
  ['기술', '대비 높이기', basic({ contrast: 35, highlights: -10, shadows: 10 })],
  ['기술', '채도 높이기', basic({ saturation: 130, vibrance: 20 })],
  ['기술', '따뜻하게', basic({ temperature: 25 })],
  ['기술', '차갑게', basic({ temperature: -25 })],
  ['기술', '비네팅 (가장자리 어둡게)', basic({ vigAmount: -1.5, vigMid: 45, vigFeather: 60 })],
].map(([folder, name, params], i) => ({ id: `lum:${i}:${name}`, folder, name, desc: 'Lumetri 색상 효과로 적용됩니다', anchor: 'in', duration: 1, lumetri: true, effects: [{ type: 'lumetri', params }] }));

/** Built-in presets whose effects exist in this build (other modules may add effects later). */
export function builtinPresets() {
  return BUILTIN_PRESETS.filter((p) => p.effects.every((e) => EFFECTS[e.type]));
}

export function lumetriPresets() {
  if (!EFFECTS.lumetri) return [];
  const keysOk = new Set(EFFECTS.lumetri.params.map((p) => p.key));
  return LUMETRI_PRESETS.filter((p) => Object.keys(p.effects[0].params).every((k) => keysOk.has(k)));
}

export function getPreset(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('bi:')) return BUILTIN_PRESETS.find((p) => p.id === id) || null;
  if (id.startsWith('lum:')) return LUMETRI_PRESETS.find((p) => p.id === id) || null;
  return listPresets().find((p) => p.id === id) || null;
}

/** The effects of a preset in the current format (older single-effect presets included). */
export function presetEffects(preset) {
  if (!preset) return [];
  if (Array.isArray(preset.effects)) return preset.effects;
  if (preset.type) return [{ type: preset.type, enabled: preset.enabled !== false, params: preset.params || {} }];
  return [];
}

/** Effect types a preset uses, e.g. for its badge in the Effects panel. */
export const presetTypes = (preset) => presetEffects(preset).map((e) => e.type);

/** Place a param's keyframes on a clip of duration D following the preset's anchor type. */
function placeKeys(p, preset, D) {
  if (!p?.kf?.length) return p;
  const src = preset.duration || Math.max(...p.kf.map((k) => k.t), 0) || D;
  const anchor = preset.anchor || 'in';
  for (const k of p.kf) {
    if (anchor === 'out') k.t = D - (src - k.t);
    else if (anchor === 'scale') k.t = src > 0 ? (k.t * D) / src : k.t;
    k.t = Math.round(k.t * store.seq.fps) / store.seq.fps;
  }
  // keys landing on the same frame: the later one wins
  p.kf = p.kf.filter((k, i, a) => !a.slice(i + 1).some((o) => Math.abs(o.t - k.t) < 1e-6));
  return p;
}

/** Apply a preset to clips (one undo step). Returns the number of clips changed. */
export function applyPreset(clipIds, preset) {
  const list = presetEffects(preset).filter((e) => EFFECTS[e.type]);
  if (!list.length) return 0;
  const s = store.seq;
  let n = 0;
  store.transact(`사전 설정 적용: ${preset.name}`, () => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c) continue;
      let any = false;
      for (const e of list) {
        if (!effectFitsClip(e.type, c.kind)) continue;
        const def = EFFECTS[e.type];
        let fx = def.fixed ? c.effects.find((x) => x.type === e.type) : null;
        if (def.fixed && !fx) continue;
        if (!fx) {
          fx = createEffect(e.type, s);
          c.effects.push(fx);
        }
        for (const [k, p0] of Object.entries(e.params || {})) {
          if (!fx.params[k]) continue;
          const p = typeof p0 === 'function' ? p0(s) : p0;
          if (!p || typeof p !== 'object' || !('value' in p)) continue;
          fx.params[k] = placeKeys(deepClone(p), preset, c.duration);
        }
        if (e.masks?.length) fx.masks = deepClone(e.masks);
        fx.enabled = e.enabled !== false;
        any = true;
      }
      if (any) {
        n++;
        if (list.some((e) => e.type === 'timeRemap')) rawSyncLinkedRemap(c.id);
      }
    }
  });
  return n;
}

// ---------------------------------------------------------------- 사전 설정 저장 dialog

/** Premiere's 사전 설정 저장 dialog for one or more effects of a clip. */
export function openSavePresetDialog(clip, effects) {
  const list = (effects || []).filter((fx) => fx && EFFECTS[fx.type]);
  if (!clip || !list.length) {
    toast('저장할 효과를 효과 컨트롤에서 먼저 선택하세요');
    return;
  }
  const names = list.map((fx) => EFFECTS[fx.type].name);
  const name = h('input', { type: 'text', value: list.length === 1 ? `${names[0]} 사전 설정` : `${names[0]} 외 ${list.length - 1}개`, style: { width: '100%' } });
  const animated = list.some((fx) => Object.values(fx.params).some((p) => p.kf?.length));
  let anchor = animated ? 'scale' : 'in';
  const radios = PRESET_ANCHORS.map(([id, label, hint]) => {
    const r = h('input', { type: 'radio', name: 'preset-anchor', value: id, checked: id === anchor });
    r.addEventListener('change', () => { if (r.checked) anchor = id; });
    return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '3px 0' }, title: hint }, r, h('span', label), h('span.note', `— ${hint}`));
  });
  const desc = h('textarea', { rows: 2, style: { width: '100%' }, placeholder: '이 사전 설정에 대한 메모 (선택)' });
  desc.addEventListener('keydown', (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
  openModal({
    title: '사전 설정 저장',
    width: '460px',
    body: h('div',
      h('div.form-row', h('label', '이름'), name),
      h('div.form-row', h('label', '유형'), h('div', radios)),
      h('div.form-row', h('label', '설명'), desc),
      h('div.note', `포함되는 효과: ${names.join(', ')}${animated ? '' : ' · 키프레임이 없으면 유형은 상관없습니다'}`)),
    buttons: [
      { label: '취소' },
      {
        label: '확인',
        primary: true,
        action: () => {
          const n = name.value.trim();
          if (!n) {
            toast('사전 설정 이름을 입력하세요');
            return false;
          }
          savePreset(n, list, { anchor, desc: desc.value.trim(), duration: clamp(clip.duration, 1 / store.seq.fps, 1e6) });
          toast(`"${n}" 사전 설정을 저장했습니다 (효과 패널 ▸ 사전 설정)`);
          return true;
        },
      },
    ],
  });
}

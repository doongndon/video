// 기본 사운드 (Essential Sound) panel, after Premiere Pro: tag audio clips as 대화 / 음악 / 효과음 /
// 주변 소리 and fix or shape them with a few sliders. Every control adds, updates or removes real audio
// effects on the clip (marked fx.essential) and applies the clip gain, so the result shows in Effect
// Controls, plays in the preview, exports, and undoes like any other edit.

import { store } from '../store.js';
import { h, clamp } from '../util.js';
import { createEffect, evalParam, clipEnd, mediaTimeAt } from '../model.js';
import { EFFECTS } from '../effects.js';
import { getRuntime } from '../media.js';
import { sliderField, toast, loadPref, savePref, showPanel } from './common.js';
import { icon } from './icons.js';
import * as edit from '../edit.js';

export const AUDIO_TYPES = [
  ['dialogue', '대화'],
  ['music', '음악'],
  ['sfx', '효과음'],
  ['ambience', '주변 소리'],
];
const TYPE_NAME = Object.fromEntries(AUDIO_TYPES);

/** Loudness targets offered by 음량 ▸ 자동 일치 (Premiere's defaults first). */
const TARGETS = [[-23, '-23 LUFS (방송 기준)'], [-16, '-16 LUFS (팟캐스트)'], [-14, '-14 LUFS (유튜브·스트리밍)'], [-25, '-25 LUFS (배경 음악)'], [-30, '-30 LUFS (배경 소리)']];
const DEFAULT_TARGET = { dialogue: -23, music: -25, sfx: -23, ambience: -30 };

const EQ_PRESETS = {
  podcast: { name: '팟캐스트 음성', bands: [[1, 'lowshelf', 120, -2], [2, 'peaking', 300, -2.5], [4, 'peaking', 3500, 3], [5, 'highshelf', 9000, 2]], hp: 80 },
  clear: { name: '또렷한 목소리 (존재감)', bands: [[2, 'peaking', 250, -3], [3, 'peaking', 1200, -1], [4, 'peaking', 3000, 4]], hp: 90 },
  warm: { name: '따뜻한 목소리', bands: [[1, 'lowshelf', 150, 2.5], [3, 'peaking', 2500, -1.5], [5, 'highshelf', 8000, -2]], hp: 60 },
  radio: { name: '라디오 음성', bands: [[1, 'lowshelf', 200, -10], [3, 'peaking', 1800, 5], [5, 'highshelf', 4500, -12]], hp: 300 },
  phone: { name: '전화 통화', bands: [[1, 'lowshelf', 400, -18], [3, 'peaking', 1500, 6], [5, 'highshelf', 3400, -24]], hp: 400 },
  bright: { name: '밝게 (고음 살리기)', bands: [[4, 'peaking', 5000, 3], [5, 'highshelf', 10000, 4]], hp: 0 },
  muddy: { name: '먹먹함 줄이기', bands: [[2, 'peaking', 300, -5], [3, 'peaking', 800, -2]], hp: 80 },
};
const REVERB_PRESETS = {
  room: { name: '따뜻한 방', decay: 0.9 },
  hall: { name: '대형 홀', decay: 3.2 },
  church: { name: '성당', decay: 5.5 },
  outside: { name: '야외', decay: 1.6 },
  plate: { name: '플레이트', decay: 2.2 },
};

/**
 * Essential effects in processing order: 복구 (repair) → 명료도 (clarity) → 크리에이티브 → 스테레오 폭.
 * set(fx, amount 0…10, settings) writes the effect's parameters.
 */
const ES = {
  noise: { type: 'denoise', label: '노이즈 감소', set: (fx, a) => { fx.params.amount.value = Math.round(a * 8); } },
  rumble: { type: 'highpass', label: '럼블 감소', set: (fx, a) => { fx.params.frequency.value = Math.round(30 + a * 12); fx.params.q.value = 0.7; } },
  hum: {
    type: 'humRemove', label: '험 제거',
    set: (fx, a, st) => {
      fx.params.freq.value = st.humFreq || '60';
      fx.params.harmonics.value = clamp(Math.round(1 + a * 0.7), 1, 8);
      fx.params.q.value = 30;
    },
  },
  deess: { type: 'deesser', label: '치찰음 제거', set: (fx, a) => { fx.params.threshold.value = Math.round(-12 - a * 3); fx.params.maxCut.value = Math.round(6 + a * 1.4); } },
  reverb: { type: 'dereverb', label: '리버브 감소', set: (fx, a) => { fx.params.amount.value = Math.round(a * 10); } },
  dynamics: {
    type: 'dynamics', label: '다이내믹',
    set: (fx, a) => {
      const p = fx.params;
      p.compOn.value = true;
      p.compThr.value = Math.round(-10 - a * 2.5);
      p.compRatio.value = Math.round((1.5 + a * 0.35) * 10) / 10;
      p.compAtk.value = 8;
      p.compRel.value = 150;
      p.compMakeup.value = Math.round(a * 0.6 * 10) / 10;
      p.gateOn.value = false;
      p.expOn.value = a >= 6;
      p.expThr.value = -50;
      p.expRatio.value = 1.5;
      p.limOn.value = true;
      p.limThr.value = -1;
    },
  },
  eq: {
    type: 'parametricEq', label: 'EQ',
    set: (fx, a, st) => {
      const pr = EQ_PRESETS[st.eqPreset] || EQ_PRESETS.podcast;
      const p = fx.params;
      const k = a / 5; // amount 5 = the preset as designed
      for (let n = 1; n <= 5; n++) p[`b${n}On`].value = false;
      for (const [n, type, f, g] of pr.bands) {
        p[`b${n}On`].value = true;
        p[`b${n}Type`].value = type;
        p[`b${n}Freq`].value = f;
        p[`b${n}Gain`].value = Math.round(g * k * 10) / 10;
        p[`b${n}Q`].value = 1;
        p[`b${n}Gain`].kf = null;
      }
      p.hpOn.value = pr.hp > 0;
      if (pr.hp > 0) p.hpFreq.value = pr.hp;
    },
  },
  enhance: { type: 'vocalEnhancer', label: '음성 강조', set: (fx, a, st) => { fx.params.mode.value = st.enhanceMode || 'low'; fx.params.amount.value = 60; } },
  creative: {
    type: 'reverb', label: '리버브',
    set: (fx, a, st) => {
      fx.params.mix.value = Math.round(a * 6);
      fx.params.decay.value = (REVERB_PRESETS[st.reverbPreset] || REVERB_PRESETS.room).decay;
    },
  },
  width: { type: 'stereoExpander', label: '스테레오 폭', set: (fx, a) => { fx.params.width.value = Math.round(100 + a * 15); } },
};
const ES_ORDER = Object.keys(ES);
const DEFAULT_AMOUNT = { noise: 5, rumble: 5, hum: 5, deess: 5, reverb: 5, dynamics: 5, eq: 5, enhance: 5, creative: 4, width: 4 };

// ---------------------------------------------------------------- data helpers (raw: callers wrap)

const audioClips = () => store.selectedClips().filter((c) => c.kind === 'audio');
export const clipType = (c) => c?.essential?.type || null;
const esFx = (c, key) => c.effects.find((e) => e.essential === key);
const amountOf = (c, key) => c.essential?.amounts?.[key] ?? DEFAULT_AMOUNT[key];

/** Turn an essential effect on (with amount) or off on a clip. */
function rawSetEssential(c, key, on, amount = amountOf(c, key)) {
  const def = ES[key];
  c.essential = c.essential || { type: null };
  c.essential.amounts = { ...(c.essential.amounts || {}), [key]: amount };
  let fx = esFx(c, key);
  if (!on) {
    if (fx) c.effects = c.effects.filter((e) => e !== fx);
    return;
  }
  if (!EFFECTS[def.type]) return;
  if (!fx) {
    fx = createEffect(def.type, store.seq);
    fx.essential = key;
    // keep the essential effects in their processing order, after the clip's own effects
    const rank = ES_ORDER.indexOf(key);
    const after = c.effects.findIndex((e) => e.essential && ES_ORDER.indexOf(e.essential) > rank);
    if (after >= 0) c.effects.splice(after, 0, fx);
    else c.effects.push(fx);
  }
  fx.enabled = true;
  def.set(fx, amount, c.essential);
}

function rawAssignType(c, type) {
  c.essential = { ...(c.essential || {}), type };
  if (!c.essential.target) c.essential.target = loadPref(`es.target.${type}`, DEFAULT_TARGET[type]);
}

function rawClearType(c) {
  c.effects = c.effects.filter((e) => !e.essential);
  delete c.essential;
}

/** Assign an audio type to clips (one undo step). */
export function assignAudioType(ids, type) {
  store.transact(`오디오 유형: ${TYPE_NAME[type]}`, () => {
    for (const id of ids) {
      const c = store.seq.clips[id];
      if (c?.kind === 'audio') rawAssignType(c, type);
    }
  });
}

export function clearAudioType(ids) {
  store.transact('오디오 유형 지우기', () => {
    for (const id of ids) {
      const c = store.seq.clips[id];
      if (c) rawClearType(c);
    }
  });
}

/** Sequence-time intervals where clips of the given audio types make sound (from waveform data). */
export function typedSoundIntervals(types, thresholdDb, { minGap = 0.4, minLen = 0.15 } = {}) {
  const s = store.seq;
  const thr = 10 ** (thresholdDb / 20);
  const raw = [];
  let missing = 0;
  for (const c of Object.values(s.clips)) {
    if (c.kind !== 'audio' || c.enabled === false || !types.includes(clipType(c) || 'none')) continue;
    const p = getRuntime(c.mediaId).peaks;
    if (!p) {
      missing++;
      continue;
    }
    const step = 0.05;
    let open = null;
    for (let t = c.start; t < clipEnd(c); t += step) {
      const mt = mediaTimeAt(c, t);
      const i0 = Math.max(0, Math.floor(mt * p.rate));
      const i1 = Math.min(p.data.length, i0 + Math.max(1, Math.ceil(step * p.rate * Math.abs(c.speed || 1))));
      let m = 0;
      for (let i = i0; i < i1; i++) m = Math.max(m, p.data[i]);
      m *= 10 ** ((c.gain || 0) / 20);
      if (m >= thr) {
        if (open == null) open = t;
      } else if (open != null) {
        raw.push([open, t]);
        open = null;
      }
    }
    if (open != null) raw.push([open, clipEnd(c)]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < minGap) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  return { intervals: merged.filter(([a, b]) => b - a >= minLen), missing };
}

// ---------------------------------------------------------------- panel

let styled = false;
function ensureStyles() {
  if (styled) return;
  styled = true;
  const css = `
.es { overflow: auto; padding: 8px 10px 16px; display: flex; flex-direction: column; gap: 8px; }
.es-types { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.es-types button { min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 600; }
.es-head { display: flex; align-items: center; gap: 8px; }
.es-head .es-title { font-weight: 700; flex: 1; }
.es-sec { border: 1px solid var(--line-2, #333); border-radius: 6px; background: var(--bg-2, #1e2127); }
.es-sec > summary { cursor: pointer; padding: 6px 8px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 6px; }
.es-sec > summary::-webkit-details-marker { display: none; }
.es-sec > summary::before { content: '▸'; color: var(--text-dim, #aaa); }
.es-sec[open] > summary::before { content: '▾'; }
.es-sec .es-body { padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 6px; }
.es-row { display: grid; grid-template-columns: 112px 1fr; align-items: center; gap: 6px; }
.es-row > label { display: flex; align-items: center; gap: 6px; min-width: 0; }
.es-row .slider-field { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; }
.es-ctl { display: flex; gap: 6px; align-items: center; min-width: 0; }
.es-ctl > .slider-field { flex: 1; min-width: 0; }
.es-ctl > select { flex-shrink: 0; max-width: 46%; margin-top: 0 !important; }
.es-row.off .slider-field, .es-row.off select { opacity: 0.45; }
.es-note { font-size: 12px; color: var(--text-dim, #aaa); line-height: 1.5; }
.es-meter { font-variant-numeric: tabular-nums; }
.es-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
`;
  document.head.append(h('style', { id: 'essential-sound-styles' }, css));
}

export function createEssentialSoundPanel() {
  ensureStyles();
  const root = h('div.es');
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } }, root);
  const open = new Set(loadPref('es.open', ['loudness', 'repair', 'clarity', 'volume', 'ducking']));
  let sig = '';
  let updaters = [];
  let drag = false;
  const measured = new Map(); // clip id → {lufs, gain}

  const sectionEl = (id, title, ...children) => {
    const d = h('details.es-sec', { open: open.has(id) }, h('summary', title), h('div.es-body', ...children));
    d.addEventListener('toggle', () => {
      if (d.open) open.add(id);
      else open.delete(id);
      savePref('es.open', [...open]);
    });
    return d;
  };

  /** Apply fn(clip) to every selected audio clip; live while a slider is dragged, one undo step. */
  const change = (label, fn, live = false) => {
    const ids = audioClips().map((c) => c.id);
    if (!ids.length) return;
    const run = () => {
      for (const id of ids) {
        const c = store.seq.clips[id];
        if (c) fn(c);
      }
    };
    if (live) {
      if (!drag) {
        store.begin(label);
        drag = true;
      }
      run();
      store.changed();
      return;
    }
    if (drag) {
      run();
      drag = false;
      store.commit();
      return;
    }
    store.transact(label, run);
  };

  /** A checkbox + 0…10 slider row driving one essential effect. */
  const fxRow = (c, key, extra = null) => {
    const on = !!esFx(c, key);
    const box = h('input', { type: 'checkbox', checked: on, 'aria-label': ES[key].label });
    const slider = sliderField({
      min: 0, max: 10, step: 0.1, value: amountOf(c, key), decimals: 1, title: `${ES[key].label} 양`,
      onInput: (v) => change(ES[key].label, (cc) => rawSetEssential(cc, key, true, v), true),
      onChange: (v) => change(ES[key].label, (cc) => rawSetEssential(cc, key, true, v)),
    });
    box.addEventListener('change', () => change(box.checked ? `${ES[key].label} 켜기` : `${ES[key].label} 끄기`, (cc) => rawSetEssential(cc, key, box.checked)));
    const row = h(`div.es-row${on ? '' : '.off'}`, h('label', box, ES[key].label), h('div.es-ctl', slider, extra));
    updaters.push(() => {
      const cc = audioClips()[0];
      if (!cc) return;
      const isOn = !!esFx(cc, key);
      box.checked = isOn;
      row.classList.toggle('off', !isOn);
      if (!drag) slider.value = amountOf(cc, key);
    });
    return row;
  };

  const selectRow = (c, label, options, value, onPick) => {
    const sel = h('select', options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    sel.addEventListener('change', () => onPick(sel.value));
    return h('div.es-row', h('label', label), sel);
  };

  // ---- sections
  function loudnessSection(c) {
    const target = c.essential?.target ?? DEFAULT_TARGET[clipType(c)];
    const sel = h('select', TARGETS.map(([v, l]) => h('option', { value: v, selected: v === target }, l)));
    if (!TARGETS.some(([v]) => v === target)) sel.prepend(h('option', { value: target, selected: true }, `${target} LUFS`));
    sel.addEventListener('change', () => {
      const v = Number(sel.value);
      savePref(`es.target.${clipType(c)}`, v);
      change('목표 음량', (cc) => { cc.essential = { ...(cc.essential || {}), target: v }; });
    });
    const meter = h('span.es-meter', '');
    const status = h('span.es-note', '');
    const matchBtn = h('button.primary', '자동 일치');
    const measureBtn = h('button', '측정');
    const showMeasured = () => {
      const cc = audioClips()[0];
      const m = cc && measured.get(cc.id);
      meter.textContent = m ? `현재 음량 ${m.lufs.toFixed(1)} LUFS` : '';
    };
    updaters.push(showMeasured);
    const run = async (match) => {
      const clips = audioClips();
      if (!clips.length) return;
      matchBtn.disabled = measureBtn.disabled = true;
      const { measureClip, matchClipLoudness } = await import('../loudness.js');
      try {
        const results = [];
        for (const [i, cc] of clips.entries()) {
          status.textContent = `${match ? '맞추는 중' : '측정 중'}… (${i + 1}/${clips.length})`;
          if (match) {
            const r = await matchClipLoudness(cc.id, cc.essential?.target ?? Number(sel.value));
            if (r) results.push([cc.id, r.gainDb]);
          } else {
            const m = await measureClip(cc.id, { withVolume: true });
            if (m && Number.isFinite(m.integrated)) measured.set(cc.id, { lufs: m.integrated });
          }
        }
        if (match) {
          if (!results.length) {
            status.textContent = '소리가 너무 작거나 읽을 수 없어 맞추지 못했습니다';
            return;
          }
          store.transact('음량 자동 일치', () => {
            for (const [id, g] of results) {
              const cc = store.seq.clips[id];
              if (!cc) continue;
              cc.gain = g;
              cc.essential = { ...(cc.essential || {}), matched: true };
            }
          });
          for (const [id] of results) measured.delete(id);
          status.textContent = `클립 ${results.length}개를 목표 음량에 맞췄습니다 (오디오 게인으로 적용)`;
        } else status.textContent = '볼륨 키프레임까지 포함한 클립 음량입니다';
        showMeasured();
      } catch (err) {
        console.error(err);
        status.textContent = `실패: ${err.message || err}`;
      } finally {
        matchBtn.disabled = measureBtn.disabled = false;
      }
    };
    matchBtn.addEventListener('click', () => run(true));
    measureBtn.addEventListener('click', () => run(false));
    const gainNote = h('span.es-note', '');
    updaters.push(() => {
      const cc = audioClips()[0];
      gainNote.textContent = cc?.gain ? `오디오 게인 ${cc.gain > 0 ? '+' : ''}${cc.gain.toFixed(1)} dB` : '';
    });
    return sectionEl('loudness', '음량',
      h('div.es-row', h('label', '목표 음량'), sel),
      h('div.es-actions', matchBtn, measureBtn, meter, gainNote),
      status,
      h('div.es-note', '자동 일치는 클립 효과까지 거친 소리를 BS.1770 방식으로 재고 오디오 게인을 맞춥니다.'));
  }

  function repairSection(c) {
    const humSel = h('select', [['60', '60 Hz'], ['50', '50 Hz']].map(([v, l]) => h('option', { value: v, selected: (c.essential?.humFreq || '60') === v }, l)));
    humSel.style.marginTop = '4px';
    humSel.addEventListener('change', () => change('험 주파수', (cc) => {
      cc.essential = { ...(cc.essential || {}), humFreq: humSel.value };
      if (esFx(cc, 'hum')) rawSetEssential(cc, 'hum', true);
    }));
    return sectionEl('repair', '복구',
      fxRow(c, 'noise'), fxRow(c, 'rumble'), fxRow(c, 'hum', humSel), fxRow(c, 'deess'), fxRow(c, 'reverb'));
  }

  function claritySection(c) {
    const eqSel = h('select', Object.entries(EQ_PRESETS).map(([k, p]) => h('option', { value: k, selected: (c.essential?.eqPreset || 'podcast') === k }, p.name)));
    eqSel.style.marginTop = '4px';
    eqSel.addEventListener('change', () => change('EQ 사전 설정', (cc) => {
      cc.essential = { ...(cc.essential || {}), eqPreset: eqSel.value };
      rawSetEssential(cc, 'eq', true);
    }));
    const enh = h('select', [['low', '저음 목소리'], ['high', '고음 목소리']].map(([v, l]) => h('option', { value: v, selected: (c.essential?.enhanceMode || 'low') === v }, l)));
    const enhOn = h('input', { type: 'checkbox', checked: !!esFx(c, 'enhance'), 'aria-label': '음성 강조' });
    const pickEnh = () => change(enhOn.checked ? '음성 강조 켜기' : '음성 강조 끄기', (cc) => {
      cc.essential = { ...(cc.essential || {}), enhanceMode: enh.value };
      rawSetEssential(cc, 'enhance', enhOn.checked);
    });
    enhOn.addEventListener('change', pickEnh);
    enh.addEventListener('change', () => {
      enhOn.checked = true;
      pickEnh();
    });
    updaters.push(() => {
      const cc = audioClips()[0];
      if (cc) enhOn.checked = !!esFx(cc, 'enhance');
    });
    return sectionEl('clarity', '명료도',
      fxRow(c, 'dynamics'),
      fxRow(c, 'eq', eqSel),
      h('div.es-row', h('label', enhOn, '음성 강조'), enh));
  }

  function creativeSection(c) {
    const sel = h('select', Object.entries(REVERB_PRESETS).map(([k, p]) => h('option', { value: k, selected: (c.essential?.reverbPreset || 'room') === k }, p.name)));
    sel.style.marginTop = '4px';
    sel.addEventListener('change', () => change('리버브 사전 설정', (cc) => {
      cc.essential = { ...(cc.essential || {}), reverbPreset: sel.value };
      rawSetEssential(cc, 'creative', true);
    }));
    return sectionEl('creative', '크리에이티브', fxRow(c, 'creative', sel));
  }

  function widthSection(c) {
    return sectionEl('width', '스테레오 폭', fxRow(c, 'width'));
  }

  function duckingSection(c) {
    const st = c.essential?.duck || {};
    const boxes = AUDIO_TYPES.filter(([t]) => t !== clipType(c)).concat([['none', '태그 없는 클립']]).map(([t, l]) => {
      const b = h('input', { type: 'checkbox', checked: (st.against || ['dialogue']).includes(t) });
      b.dataset.type = t;
      return h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', marginRight: '8px' } }, b, l);
    });
    const field = (label, min, max, step, value, unit) => {
      const s = sliderField({ min, max, step, value, unit, decimals: step < 1 ? 1 : 0, title: label });
      return { s, row: h('div.es-row', h('label', label), s) };
    };
    const sens = field('민감도', 0, 10, 0.5, st.sensitivity ?? 6, '');
    const amount = field('감소량', -40, -3, 1, st.amount ?? -18, 'dB');
    const fade = field('페이드 시간', 0, 3000, 50, st.fade ?? 800, 'ms');
    const status = h('div.es-note', '');
    const go = h('button.primary', '키프레임 생성');
    go.addEventListener('click', () => {
      const against = boxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.dataset.type);
      if (!against.length) {
        status.textContent = '더킹 기준이 될 오디오 유형을 하나 이상 고르세요.';
        return;
      }
      const settings = { against, sensitivity: sens.s.value, amount: amount.s.value, fade: fade.s.value };
      const thr = -54 + (10 - settings.sensitivity) * 3.5;
      const { intervals, missing } = typedSoundIntervals(against, thr);
      const ids = audioClips().map((x) => x.id);
      if (!intervals.length) {
        status.textContent = missing ? '파형 분석이 아직 끝나지 않았습니다. 잠시 뒤 다시 누르세요.' : `"${against.map((t) => TYPE_NAME[t] || '태그 없음').join(', ')}" 클립에서 소리를 찾지 못했습니다. 그 클립에 오디오 유형을 지정했는지, 민감도를 높여 보세요.`;
        return;
      }
      const mark = store.undoMark();
      store.transact('더킹 설정', () => {
        for (const id of ids) {
          const cc = store.seq.clips[id];
          if (cc) cc.essential = { ...(cc.essential || {}), duck: settings };
        }
      });
      const n = edit.autoDuck(ids, intervals, { duckDb: settings.amount, fadeIn: settings.fade / 1000, fadeOut: settings.fade / 1000 });
      store.squashSince(mark, '더킹 키프레임 생성');
      status.textContent = n ? `클립 ${n}개의 볼륨에 ${intervals.length}곳의 더킹 키프레임을 넣었습니다.` : '선택한 클립과 겹치는 소리 구간이 없습니다.';
    });
    return sectionEl('ducking', '더킹',
      h('div.es-note', '다음 유형의 클립에서 소리가 날 때 이 클립의 볼륨을 낮춥니다:'),
      h('div', boxes),
      sens.row, amount.row, fade.row,
      h('div.es-actions', go), status);
  }

  function volumeSection(c) {
    const vol = () => audioClips()[0]?.effects.find((e) => e.type === 'volume');
    const tl = (cc) => clamp(store.ui.playhead - cc.start, 0, cc.duration);
    const level = sliderField({
      min: -60, max: 15, step: 0.1, value: vol() ? evalParam(vol().params.level, tl(c)) : 0, unit: 'dB', decimals: 1, title: '클립 볼륨 레벨',
      onInput: (v) => change('클립 볼륨', (cc) => setLevel(cc, v), true),
      onChange: (v) => change('클립 볼륨', (cc) => setLevel(cc, v)),
    });
    const mute = h('input', { type: 'checkbox', checked: c.enabled === false, 'aria-label': '음소거' });
    mute.addEventListener('change', () => change(mute.checked ? '클립 음소거' : '클립 음소거 해제', (cc) => { cc.enabled = !mute.checked; }));
    updaters.push(() => {
      const cc = audioClips()[0];
      const v = vol();
      if (cc && v && !drag) level.value = Math.round(evalParam(v.params.level, tl(cc)) * 10) / 10;
      if (cc) mute.checked = cc.enabled === false;
    });
    return sectionEl('volume', '클립 볼륨',
      h('div.es-row', h('label', '레벨'), level),
      h('div.es-row', h('label', mute, '음소거'), h('span.es-note', '이 오디오 클립만 소리를 끕니다')));
  }

  /** Volume level: shifts the whole envelope when the volume is keyframed (keeps fades and ducking). */
  function setLevel(cc, v) {
    const fx = cc.effects.find((e) => e.type === 'volume');
    if (!fx) return;
    const p = fx.params.level;
    if (p.kf?.length) {
      const now = evalParam(p, clamp(store.ui.playhead - cc.start, 0, cc.duration));
      const d = v - now;
      for (const k of p.kf) k.v = clamp(Math.round((k.v + d) * 10) / 10, -60, 15);
    }
    p.value = v;
  }

  // ---- build
  function signature() {
    const clips = audioClips();
    if (!clips.length) return `none:${store.selection.clips.size}`;
    const c = clips[0];
    return `${clips.map((x) => x.id).join(',')}|${clipType(c)}|${ES_ORDER.filter((k) => esFx(c, k)).join(',')}|${c.essential?.eqPreset}|${c.essential?.reverbPreset}|${c.essential?.humFreq}|${c.essential?.target}|${c.essential?.enhanceMode}`;
  }

  function rebuild() {
    sig = signature();
    updaters = [];
    root.replaceChildren();
    const clips = audioClips();
    if (!clips.length) {
      root.append(h('div.empty-hint', store.selection.clips.size
        ? '오디오 클립을 선택하세요.\n(영상 클립은 연결된 오디오 클립을 함께 선택하면 됩니다)'
        : '타임라인에서 오디오 클립을 선택한 뒤\n대화 · 음악 · 효과음 · 주변 소리 중 유형을 고르세요.\n\n유형마다 소음 제거, 음량 맞추기, 더킹 같은\n자주 쓰는 처리를 슬라이더 하나로 할 수 있습니다.'));
      return;
    }
    const c = clips[0];
    const type = clipType(c);
    const ids = clips.map((x) => x.id);
    if (!type) {
      root.append(
        h('div.es-note', clips.length > 1 ? `오디오 클립 ${clips.length}개 선택됨 · 오디오 유형을 고르세요` : `${c.name || '오디오 클립'} · 오디오 유형을 고르세요`),
        h('div.es-types', AUDIO_TYPES.map(([t, name]) => h('button', { onclick: () => assignAudioType(ids, t) }, icon(t === 'music' ? 'music' : 'audio', 16), name))),
        h('div.es-note', '대화: 말소리 정리 · 음악: 음량과 더킹 · 효과음: 음량과 울림 · 주변 소리: 음량, 폭, 더킹'));
      return;
    }
    const mixed = clips.some((x) => clipType(x) !== type);
    root.append(h('div.es-head',
      h('span.es-title', `${TYPE_NAME[type]}${clips.length > 1 ? ` · 클립 ${clips.length}개${mixed ? ' (유형이 섞임)' : ''}` : ''}`),
      h('button', { title: '이 클립의 오디오 유형과 기본 사운드 효과를 모두 지웁니다', onclick: () => clearAudioType(ids) }, '오디오 유형 지우기')));
    if (type !== 'dialogue') {
      root.append(h('div.es-actions', h('span.es-note', '유형 바꾸기:'), ...AUDIO_TYPES.filter(([t]) => t !== type).map(([t, name]) => h('button', { onclick: () => assignAudioType(ids, t) }, name))));
    }
    root.append(loudnessSection(c));
    if (type === 'dialogue') root.append(repairSection(c), claritySection(c), creativeSection(c));
    if (type === 'music') root.append(duckingSection(c));
    if (type === 'sfx') root.append(creativeSection(c));
    if (type === 'ambience') root.append(widthSection(c), duckingSection(c));
    root.append(volumeSection(c));
    if (type === 'dialogue') root.append(h('div.es-actions', h('span.es-note', '유형 바꾸기:'), ...AUDIO_TYPES.filter(([t]) => t !== type).map(([t, name]) => h('button', { onclick: () => assignAudioType(ids, t) }, name))));
    root.append(h('div.es-actions', h('button', { onclick: () => showPanel('effectControls') }, '효과 컨트롤에서 세부 조정')));
    update();
  }

  function update() {
    for (const u of updaters) u();
  }

  const onChange = () => {
    if (drag) return update();
    if (signature() !== sig) rebuild();
    else update();
  };
  store.on('selection', () => {
    if (!drag) rebuild();
  });
  store.on('change', onChange);
  store.on('playhead', update);
  rebuild();
  return body;
}

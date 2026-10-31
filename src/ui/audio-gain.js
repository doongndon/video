// 오디오 게인 (Audio Gain, G): set / adjust the clip gain of the selected audio clips, or normalise
// their peaks, like Premiere's Clip ▸ Audio Options ▸ Audio Gain dialog. Clip gain (clip.gain, dB)
// is applied before the clip's effects, in the preview and in export.

import { store } from '../store.js';
import { h } from '../util.js';
import { openModal, toast } from './common.js';
import { getRuntime, peakInRange, decodeAudioRange, mediaStatus, fileTime } from '../media.js';
import { sourceOut } from '../model.js';

const MAX_GAIN = 96;
const clampGain = (g) => Math.round(Math.max(-MAX_GAIN, Math.min(MAX_GAIN, g)) * 10) / 10;
const fmtDb = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` : '-∞ dB');

/** Audio clips the dialog works on: selected audio clips and the audio linked to selected video. */
export function gainTargets(ids = [...store.selection.clips]) {
  const s = store.seq;
  const out = new Set();
  for (const id of ids) {
    const c = s.clips[id];
    if (!c) continue;
    if (c.kind === 'audio') out.add(c.id);
    else if (c.linkId) for (const o of Object.values(s.clips)) if (o.linkId === c.linkId && o.kind === 'audio') out.add(o.id);
  }
  return [...out].map((id) => s.clips[id]).filter(Boolean);
}

/** Peak (0..1) of the source sound a clip uses, before its gain. Waveform data first, else decoded. */
export async function sourcePeak(clip) {
  const a = Math.min(clip.inPoint, sourceOut(clip));
  const b = Math.max(clip.inPoint, sourceOut(clip));
  const m = store.project.media[clip.mediaId];
  if (!m || mediaStatus(clip.mediaId) !== 'ready') return null;
  if (m.kind === 'sequence') {
    // a nested sequence: measure its mix
    const { renderAudioMix } = await import('../export.js');
    const inner = store.project.sequences[m.sequenceId];
    if (!inner || b <= a) return null;
    const buf = await renderAudioMix(inner, a, b, 48000, () => {}, 1, new Map());
    return bufferPeak(buf);
  }
  if (getRuntime(clip.mediaId).peaks) return peakInRange(clip.mediaId, a, b);
  const buf = await decodeAudioRange(clip.mediaId, fileTime(m, a), fileTime(m, b)).catch(() => null);
  return buf ? bufferPeak(buf) : null;
}

function bufferPeak(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > p) p = v;
    }
  }
  return p;
}

/**
 * Apply one of the dialog's operations to clips. mode: 'set' | 'adjust' | 'normalizeMax' | 'normalizeAll';
 * peaks: Map clipId → source peak (0..1) for the normalise modes. Returns the number of clips changed.
 */
export function applyAudioGain(clipIds, mode, value, peaks = new Map()) {
  const s = store.seq;
  const clips = clipIds.map((id) => s.clips[id]).filter(Boolean);
  if (!clips.length) return 0;
  let n = 0;
  store.transact('오디오 게인', () => {
    if (mode === 'normalizeMax') {
      // one change for all: the loudest peak among them lands on the value
      let max = -Infinity;
      for (const c of clips) {
        const p = peaks.get(c.id);
        if (p > 0) max = Math.max(max, 20 * Math.log10(p) + (c.gain || 0));
      }
      if (!Number.isFinite(max)) return;
      const d = value - max;
      for (const c of clips) {
        c.gain = clampGain((c.gain || 0) + d);
        n++;
      }
      return;
    }
    for (const c of clips) {
      if (mode === 'set') c.gain = clampGain(value);
      else if (mode === 'adjust') c.gain = clampGain((c.gain || 0) + value);
      else if (mode === 'normalizeAll') {
        const p = peaks.get(c.id);
        if (!(p > 0)) continue;
        c.gain = clampGain(value - 20 * Math.log10(p));
      }
      if (!c.gain) delete c.gain;
      n++;
    }
  });
  return n;
}

export function openAudioGainDialog() {
  const clips = gainTargets();
  if (!clips.length) {
    toast('오디오 게인을 바꿀 오디오 클립을 먼저 선택하세요');
    return;
  }
  const ids = clips.map((c) => c.id);
  const gains = clips.map((c) => c.gain || 0);
  const same = gains.every((g) => Math.abs(g - gains[0]) < 1e-6);
  const radios = [];
  const row = (mode, label, value, unit) => {
    const radio = h('input', { type: 'radio', name: 'audio-gain-mode', value: mode, checked: mode === 'set' });
    const input = h('input', { type: 'number', value, step: 0.1, min: -MAX_GAIN, max: MAX_GAIN, style: { width: '84px' } });
    input.addEventListener('focus', () => { radio.checked = true; });
    input.addEventListener('input', () => { radio.checked = true; });
    radios.push({ mode, radio, input });
    return h('div.form-row', h('label', radio, ` ${label}`), h('div.inline', input, h('span', unit)));
  };
  const peakEl = h('b', '계산 중…');
  const note = h('div.note', clips.length > 1
    ? `오디오 클립 ${clips.length}개 · "최대 피크"는 모두에 같은 양을, "모든 피크"는 클립마다 따로 맞춥니다.`
    : '게인은 클립의 효과보다 먼저 적용됩니다 (볼륨 키프레임과 별개).');
  const peaks = new Map();
  let ready = false;
  const body = [
    row('set', '게인 설정:', same ? gains[0] : 0, 'dB'),
    row('adjust', '게인 조정:', 0, 'dB'),
    row('normalizeMax', '최대 피크를 다음으로 정규화:', 0, 'dBFS'),
    row('normalizeAll', '모든 피크를 다음으로 정규화:', 0, 'dBFS'),
    h('div.form-row', h('label', '최대 피크 진폭:'), h('div.inline', peakEl)),
    note,
  ];
  (async () => {
    let max = -Infinity;
    for (const c of clips) {
      const p = await sourcePeak(c).catch(() => null);
      if (p != null) {
        peaks.set(c.id, p);
        if (p > 0) max = Math.max(max, 20 * Math.log10(p) + (c.gain || 0));
      }
    }
    ready = true;
    peakEl.textContent = peaks.size ? fmtDb(max) : '알 수 없음 (소리를 읽지 못함)';
  })();
  openModal({
    title: '오디오 게인',
    width: '440px',
    body,
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const pick = radios.find((r) => r.radio.checked) || radios[0];
          const value = parseFloat(pick.input.value);
          if (!Number.isFinite(value)) {
            toast('숫자를 입력하세요');
            return false;
          }
          if ((pick.mode === 'normalizeMax' || pick.mode === 'normalizeAll') && (!ready || !peaks.size)) {
            toast(ready ? '이 클립의 소리를 읽지 못해 정규화할 수 없습니다' : '피크를 계산하는 중입니다. 잠시 뒤 다시 누르세요');
            return false;
          }
          const n = applyAudioGain(ids, pick.mode, value, peaks);
          if (n) toast(`오디오 클립 ${n}개의 게인을 바꿨습니다`);
          return true;
        },
      },
    ],
  });
  setTimeout(() => radios[0].input.select?.(), 0);
}

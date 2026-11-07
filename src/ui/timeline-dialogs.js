// Timeline editing dialogs modelled on Premiere Pro: 특성 붙여넣기, 특성 제거, 프레임 고정 옵션,
// 클립 불일치 경고 and the marker dialog (sequence and clip markers).

import { store } from '../store.js';
import * as edit from '../edit.js';
import { EFFECTS } from '../effects.js';
import { clipEnd, MARKER_COLORS, MARKER_TYPES } from '../model.js';
import { h, formatTimecode, parseTimecode } from '../util.js';
import { openModal, formRow, toast } from './common.js';

const check = (checked, label, attrs = {}) => {
  const box = h('input', { type: 'checkbox', checked, ...attrs });
  return { box, el: h('label.check', box, ` ${label}`) };
};

const FIXED_LABELS = { motion: '모션', opacity: '불투명도', timeRemap: '시간 다시 매핑', volume: '볼륨', channelVolume: '채널 볼륨', panner: '패너' };
const VIDEO_FIXED = ['motion', 'opacity', 'timeRemap'];
const AUDIO_FIXED = ['volume', 'channelVolume', 'panner'];

/** A titled block of checkboxes. */
function section(title, rows) {
  return rows.length ? h('div.tl-attr-section', { style: { margin: '6px 0 10px' } }, h('div', { style: { fontWeight: '600', marginBottom: '4px' } }, title), ...rows.map((r) => h('div', { style: { padding: '2px 0 2px 12px' } }, r.el))) : null;
}

// ---------------------------------------------------------------- paste attributes

/**
 * 특성 붙여넣기 (Ctrl+Alt+V): choose which attributes of the copied clip go onto the selected clips.
 * sources: copied clips (video and / or audio); targetIds: selected clip ids.
 */
export function openPasteAttributesDialog(sources, targetIds) {
  const vSrc = sources.find((c) => c.kind !== 'audio');
  const aSrc = sources.find((c) => c.kind === 'audio');
  const s = store.seq;
  const targets = targetIds.map((id) => s.clips[id]).filter(Boolean);
  const hasV = vSrc && targets.some((c) => c.kind !== 'audio');
  const hasA = aSrc && targets.some((c) => c.kind === 'audio');
  if (!hasV && !hasA) {
    toast('복사한 클립과 같은 종류(영상/오디오)의 클립을 선택하세요');
    return;
  }
  const scale = check(false, '특성 시간 비율 조정 (키프레임을 각 클립 길이에 맞춤)');
  const fixedChecks = new Map();
  const fxChecks = new Map();
  const rowsFor = (src, fixed) => {
    const rows = [];
    for (const type of fixed) {
      if (!src.effects.some((e) => e.type === type)) continue;
      const c = check(true, FIXED_LABELS[type]);
      fixedChecks.set(type, c);
      rows.push(c);
    }
    for (const e of src.effects) {
      if (EFFECTS[e.type]?.fixed) continue;
      const c = check(true, EFFECTS[e.type]?.name || e.type);
      fxChecks.set(e.id, c);
      rows.push(c);
    }
    return rows;
  };
  const body = [
    h('div', { style: { marginBottom: '6px' } }, scale.el),
    hasV ? section('비디오 특성', rowsFor(vSrc, VIDEO_FIXED)) : null,
    hasA ? section('오디오 특성', rowsFor(aSrc, AUDIO_FIXED)) : null,
  ];
  openModal({
    title: '특성 붙여넣기',
    body,
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const attrs = new Set([...fixedChecks].filter(([, c]) => c.box.checked).map(([t]) => t));
          const effects = new Set([...fxChecks].filter(([, c]) => c.box.checked).map(([id]) => id));
          const n = edit.pasteAttributes([vSrc, aSrc].filter(Boolean), targetIds, { attrs, effects, scaleTimes: scale.box.checked });
          toast(n ? `클립 ${n}개에 특성을 붙여 넣었습니다` : '붙여 넣을 특성이 없습니다');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- remove attributes

/** 특성 제거: reset motion / opacity / time remapping / volume / panner and remove added effects. */
export function openRemoveAttributesDialog(ids) {
  const s = store.seq;
  const clips = ids.map((id) => s.clips[id]).filter(Boolean);
  if (!clips.length) {
    toast('클립을 먼저 선택하세요');
    return;
  }
  const fixedChecks = new Map();
  const typeChecks = new Map();
  const rowsFor = (family, fixed) => {
    const list = clips.filter((c) => (c.kind === 'audio') === (family === 'audio'));
    if (!list.length) return [];
    const rows = [];
    for (const type of fixed) {
      if (!list.some((c) => c.effects.some((e) => e.type === type))) continue;
      const c = check(true, FIXED_LABELS[type]);
      fixedChecks.set(type, c);
      rows.push(c);
    }
    const types = [...new Set(list.flatMap((c) => c.effects.filter((e) => !EFFECTS[e.type]?.fixed).map((e) => e.type)))];
    for (const type of types) {
      const c = check(true, EFFECTS[type]?.name || type);
      typeChecks.set(type, c);
      rows.push(c);
    }
    return rows;
  };
  const vRows = rowsFor('video', VIDEO_FIXED);
  const aRows = rowsFor('audio', AUDIO_FIXED);
  openModal({
    title: '특성 제거',
    body: [
      h('div', { style: { marginBottom: '6px', color: 'var(--text-dim)' } }, '고른 특성은 기본값으로 되돌리고, 고른 효과는 지웁니다.'),
      section('비디오 특성', vRows),
      section('오디오 특성', aRows),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const attrs = new Set([...fixedChecks].filter(([, c]) => c.box.checked).map(([t]) => t));
          const effectTypes = new Set([...typeChecks].filter(([, c]) => c.box.checked).map(([t]) => t));
          const n = edit.removeAttributes(ids, { attrs, effectTypes });
          toast(n ? `클립 ${n}개의 특성을 제거했습니다` : '바뀐 것이 없습니다');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- frame hold options

const HOLD_AT = [
  ['source', '소스 타임코드'],
  ['sequence', '시퀀스 타임코드'],
  ['in', '시작 지점'],
  ['out', '종료 지점'],
  ['playhead', '재생 헤드'],
];

/** 프레임 고정 옵션: hold whole clips at a chosen frame, or release the hold. */
export function openFrameHoldOptionsDialog(ids) {
  const s = store.seq;
  const clips = ids.map((id) => s.clips[id]).filter((c) => c?.kind === 'video');
  if (!clips.length) {
    toast('영상 클립을 선택하세요');
    return;
  }
  const c0 = clips[0];
  const on = check(!!c0.hold, '고정 위치');
  const at = h('select', HOLD_AT.map(([v, l]) => h('option', { value: v, selected: v === (c0.hold ? 'source' : 'playhead') }, l)));
  const tc = h('input', { type: 'text', style: { width: '120px' } });
  const refresh = () => {
    const mode = at.value;
    tc.disabled = !on.box.checked || !(mode === 'source' || mode === 'sequence');
    at.disabled = !on.box.checked;
    if (mode === 'source') tc.value = formatTimecode(c0.hold ? c0.holdTime ?? c0.inPoint : c0.inPoint, s.fps);
    else if (mode === 'sequence') tc.value = formatTimecode(Math.min(Math.max(store.ui.playhead, c0.start), clipEnd(c0)), s.fps);
    else tc.value = '';
  };
  at.addEventListener('change', refresh);
  on.box.addEventListener('change', refresh);
  refresh();
  openModal({
    title: '프레임 고정 옵션',
    body: [
      formRow('', on.el, at, tc),
      h('div', { style: { color: 'var(--text-dim)', marginTop: '6px' } }, '클립 전체가 고른 프레임에서 멈춘 화면이 됩니다. 고정 위치를 끄면 다시 움직입니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const mode = at.value;
          const t = mode === 'source' || mode === 'sequence' ? parseTimecode(tc.value, s.fps) : null;
          if ((mode === 'source' || mode === 'sequence') && t == null) {
            toast('타임코드를 확인하세요 (예: 00:00:01:15)');
            return false;
          }
          edit.setFrameHold(clips.map((c) => c.id), { on: on.box.checked, at: mode, time: t });
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- clip mismatch

/** 클립 불일치 경고: the first clip in an empty sequence has another frame size or rate. */
export function openClipMismatchDialog({ mediaId, sequenceId }) {
  const m = store.project.media[mediaId];
  const s = store.project.sequences[sequenceId];
  if (!m || !s) return;
  const fpsTxt = (v) => `${Math.round(v * 1000) / 1000}fps`;
  openModal({
    title: '클립 불일치 경고',
    body: [
      h('p', '이 클립은 시퀀스 설정과 일치하지 않습니다. 클립 설정에 맞게 시퀀스를 변경하시겠습니까?'),
      h('div', { style: { color: 'var(--text-dim)', lineHeight: '1.7' } },
        h('div', `클립: ${m.width}×${m.height} · ${m.fps ? fpsTxt(m.fps) : '-'}`),
        h('div', `시퀀스: ${s.width}×${s.height} · ${fpsTxt(s.fps)}`)),
    ],
    buttons: [
      { label: '기존 설정 유지' },
      {
        label: '시퀀스 설정 변경', primary: true, action: () => {
          if (store.seq.id !== sequenceId) store.openSequence(sequenceId);
          edit.matchSequenceToMedia(mediaId);
          toast(`시퀀스를 ${store.seq.width}×${store.seq.height} · ${fpsTxt(store.seq.fps)}로 바꿨습니다`);
        },
      },
    ],
  });
}

store.on('clip-mismatch', (info) => setTimeout(() => openClipMismatchDialog(info), 0));

// ---------------------------------------------------------------- markers

/** All markers of the active sequence in time order: [{ id, t (sequence seconds), clipId }]. */
function markerOrder() {
  const s = store.seq;
  const list = s.markers.map((m) => ({ id: m.id, t: m.time, clipId: null }));
  for (const c of Object.values(s.clips)) {
    for (const m of c.markers || []) if (m.time >= -1e-6 && m.time <= c.duration + 1e-6) list.push({ id: m.id, t: c.start + m.time, clipId: c.id });
  }
  return list.sort((a, b) => a.t - b.t);
}

/** The marker dialog (마커): 이름, 시작, 길이, 설명, 마커 색상, 마커 유형; 이전 / 다음 walk the markers. */
export function openMarkerEditor(id) {
  const s = store.seq;
  const found = edit.findMarker(id);
  if (!found) return;
  const { marker: mk, clip } = found;
  const fps = s.fps;
  const startT = clip ? clip.start + mk.time : mk.time;
  const name = h('input', { type: 'text', value: mk.name || '', style: { width: '100%' } });
  const start = h('input', { type: 'text', value: formatTimecode(startT, fps), style: { width: '120px' } });
  const dur = h('input', { type: 'text', value: formatTimecode(mk.duration || 0, fps), style: { width: '120px' } });
  const comment = h('textarea', { rows: 3, style: { width: '100%' } }, mk.comment || '');
  let color = mk.color || MARKER_COLORS[0][0];
  const swatches = h('div.inline.swatches', MARKER_COLORS.map(([c, label]) => {
    const b = h('button.swatch-btn', { title: label, 'aria-label': label, style: { background: c }, 'aria-pressed': String(c === color) });
    b.addEventListener('click', () => {
      color = c;
      swatches.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
    });
    return b;
  }));
  const group = `mk-type-${id}`;
  const types = MARKER_TYPES.map(([v, label]) => {
    const r = h('input', { type: 'radio', name: group, value: v, checked: (mk.type || 'comment') === v });
    return { r, el: h('label.check', { style: { marginRight: '10px' } }, r, ` ${label}`) };
  });
  const save = () => {
    const t = parseTimecode(start.value, fps);
    const d = parseTimecode(dur.value, fps);
    edit.updateMarker(id, {
      name: name.value, comment: comment.value, color,
      type: types.find((x) => x.r.checked)?.r.value || 'comment',
      time: t != null ? t : undefined, duration: d != null ? Math.max(0, d) : undefined,
    });
  };
  const goTo = (dir) => {
    save();
    const list = markerOrder();
    const i = list.findIndex((x) => x.id === id);
    const other = list[i + dir];
    if (!other) {
      toast(dir < 0 ? '이전 마커가 없습니다' : '다음 마커가 없습니다');
      return false;
    }
    store.setPlayhead(other.t);
    setTimeout(() => openMarkerEditor(other.id), 0);
    return true;
  };
  openModal({
    title: clip ? `클립 마커 · ${clip.name || ''}` : '마커',
    body: [
      formRow('이름', name),
      formRow('시작', start),
      formRow('길이', dur, h('span', { style: { color: 'var(--text-dim)' } }, '0이면 한 지점, 늘리면 구간 마커')),
      formRow('설명', comment),
      formRow('마커 색상', swatches),
      formRow('마커 유형', ...types.map((x) => x.el)),
    ],
    buttons: [
      { label: '삭제', action: () => edit.removeMarker(id) },
      { label: '이전', action: () => goTo(-1) },
      { label: '다음', action: () => goTo(1) },
      { label: '취소' },
      { label: '확인', primary: true, action: save },
    ],
  });
}

// ---------------------------------------------------------------- tracks

/** 트랙 추가…: how many video / audio tracks and where (Premiere's Add Tracks dialog). */
export function openAddTracksDialog() {
  const num = (v) => h('input', { type: 'number', min: 0, max: 20, step: 1, value: v, style: { width: '64px' } });
  const where = () => h('select', [['last', '마지막 트랙 뒤'], ['first', '첫 번째 트랙 앞']].map(([v, l]) => h('option', { value: v }, l)));
  const vN = num(1);
  const aN = num(1);
  const vW = where();
  const aW = where();
  openModal({
    title: '트랙 추가',
    body: [
      h('div', { style: { fontWeight: '600', margin: '2px 0 6px' } }, '비디오 트랙'),
      formRow('추가', vN, h('span', '트랙'), vW),
      h('div', { style: { fontWeight: '600', margin: '10px 0 6px' } }, '오디오 트랙'),
      formRow('추가', aN, h('span', '트랙'), aW),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const v = Math.max(0, Math.min(20, Math.round(Number(vN.value) || 0)));
          const a = Math.max(0, Math.min(20, Math.round(Number(aN.value) || 0)));
          edit.addTracks({ video: v, audio: a, videoWhere: vW.value, audioWhere: aW.value });
        },
      },
    ],
  });
}

/** 트랙 삭제…: remove all empty video and / or audio tracks. */
export function openDeleteTracksDialog() {
  const v = check(true, '비디오 트랙 삭제: 모든 빈 트랙');
  const a = check(true, '오디오 트랙 삭제: 모든 빈 트랙');
  openModal({
    title: '트랙 삭제',
    body: [h('div', v.el), h('div', { style: { marginTop: '6px' } }, a.el)],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const kinds = [v.box.checked && 'video', a.box.checked && 'audio'].filter(Boolean);
          const n = kinds.length ? edit.deleteEmptyTracks(kinds) : 0;
          toast(n ? `빈 트랙 ${n}개를 삭제했습니다` : '삭제할 빈 트랙이 없습니다');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- 렌더링

/**
 * 시작에서 끝까지 효과 렌더링 (Enter): render the yellow / red stretches between In and Out (all of the
 * sequence without them) with a progress window, then play the range like Premiere.
 */
export async function renderInToOut() {
  const [{ renderRange, framesToRender, previewWidth, storeFrame }, { renderPreviewFrames }, { playback }] = await Promise.all([
    import('../render-cache.js'), import('../export.js'), import('../playback.js'),
  ]);
  const seq = store.seq;
  const [t0, t1] = renderRange(seq);
  const todo = framesToRender(seq, t0, t1);
  const playRange = () => {
    store.setPlayhead(t0);
    if (seq.inPoint != null || seq.outPoint != null) playback.playInToOut();
    else playback.play(1);
  };
  if (!todo.length) {
    toast('렌더링할 구간이 없습니다 (효과가 없는 구간은 렌더링 없이 재생됩니다)');
    return playRange();
  }
  playback.stop?.();
  const token = { cancelled: false };
  const bar = h('div');
  const label = h('div', `프레임 0 / ${todo.length}`);
  const dlg = openModal({
    title: '렌더링',
    body: h('div', { style: { minWidth: '320px' } }, h('div', { style: { marginBottom: '8px' } }, `${formatTimecode(t0, seq.fps)} ~ ${formatTimecode(t1, seq.fps)} 효과 렌더링 중`), h('div.progress', bar), label),
    buttons: [{ label: '취소', action: () => { token.cancelled = true; } }],
    onClose: () => { token.cancelled = true; },
  });
  const started = performance.now();
  let done = false;
  try {
    done = await renderPreviewFrames(seq, todo.map((x) => x.f), previewWidth(seq), token, async (i, blob) => {
      storeFrame(seq, todo[i].f, todo[i].sig, blob);
      if (i % 4 === 0 || i === todo.length - 1) {
        bar.style.width = `${Math.round(((i + 1) / todo.length) * 100)}%`;
        const left = ((performance.now() - started) / (i + 1)) * (todo.length - i - 1);
        label.textContent = `프레임 ${i + 1} / ${todo.length} · 남은 시간 약 ${Math.ceil(left / 1000)}초`;
        store.emit('render-files');
        await new Promise((r) => setTimeout(r, 0));
      }
    });
  } catch (err) {
    console.error(err);
    toast(`렌더링하지 못했습니다: ${err.message || err}`);
  }
  dlg.close();
  store.emit('render-files');
  if (done) playRange();
}

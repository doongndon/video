// 푸티지 해석 (Interpret Footage) and 미디어 교체 (Replace Footage) for project items.

import { store } from '../store.js';
import { h } from '../util.js';
import { openModal, formRow, toast } from './common.js';
import { setInterpretation, importFiles, mediaStatus, guessKind } from '../media.js';
import { pickFiles } from './project-panel.js';

const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/** 푸티지 해석: use the file's frame rate, or assume another one, for the given video items. */
export function openInterpretFootageDialog(ids) {
  const items = ids.map((id) => store.project.media[id]).filter((m) => m?.kind === 'video');
  if (!items.length) {
    toast('푸티지 해석은 영상 항목에만 쓸 수 있습니다');
    return;
  }
  const first = items[0];
  const native = first.nativeFps || first.fps;
  const useFile = h('input', { type: 'radio', name: 'interp-fps', checked: !first.interpretFps });
  const assume = h('input', { type: 'radio', name: 'interp-fps', checked: !!first.interpretFps });
  const fps = h('input', { type: 'number', value: first.interpretFps || native || 30, min: 1, max: 240, step: 0.001, style: { width: '96px' }, list: 'interp-rates' });
  const rates = h('datalist', { id: 'interp-rates' }, COMMON_RATES.map((r) => h('option', { value: r })));
  fps.addEventListener('focus', () => { assume.checked = true; });
  fps.addEventListener('input', () => { assume.checked = true; update(); });
  fps.addEventListener('keydown', (e) => e.stopPropagation());
  const info = h('div.note');
  const update = () => {
    const f = parseFloat(fps.value);
    if (!assume.checked || !native || !(f > 0)) {
      info.textContent = `파일의 프레임 속도 ${native ? `${native} fps` : '(알 수 없음)'}로 재생합니다.`;
      return;
    }
    const speed = (f / native) * 100;
    const dur = first.fileDuration ?? first.duration;
    info.textContent = `${native} fps 영상을 ${f} fps로 재생합니다 → 속도 ${speed.toFixed(1)}%${dur ? ` · 길이 ${(dur * (native / f)).toFixed(2)}초` : ''}${speed < 100 ? ' (슬로 모션)' : ''}.`;
  };
  useFile.addEventListener('change', update);
  assume.addEventListener('change', update);
  update();
  openModal({
    title: '푸티지 해석',
    width: '460px',
    body: [
      h('div.note', items.length > 1 ? `영상 항목 ${items.length}개` : first.name),
      h('div', { style: { fontWeight: '700', margin: '8px 0 4px' } }, '프레임 속도'),
      h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0' } }, useFile, `파일에서 프레임 속도 사용: ${native ? `${native} fps` : '알 수 없음'}`),
      h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0' } }, assume, '다음 프레임 속도 가정:', fps, 'fps'),
      rates,
      info,
      h('div.note', '이 항목을 쓰는 모든 클립에 적용됩니다. 타임라인의 클립은 자리와 첫 프레임을 유지합니다. 고속 촬영(예: 60 fps) 영상을 24 fps로 해석하면 부드러운 슬로 모션이 됩니다.'),
    ],
    buttons: [
      { label: '취소' },
      {
        label: '확인', primary: true, action: () => {
          const f = parseFloat(fps.value);
          if (assume.checked && !(f > 0 && f <= 240)) {
            toast('1~240 사이의 프레임 속도를 입력하세요');
            return false;
          }
          const n = setInterpretation(items.map((m) => m.id), assume.checked ? f : null);
          if (n) toast(assume.checked ? `영상 ${n}개를 ${f} fps로 해석합니다` : `영상 ${n}개를 파일의 프레임 속도로 되돌렸습니다`);
          return true;
        },
      },
    ],
  });
}

/**
 * 미디어 교체 (Replace Footage): point a project item at another file. Every clip that uses it now
 * shows the new file (with the same in/out times). One undo step; undo brings the old file back.
 */
export async function replaceFootage(id) {
  const old = store.project.media[id];
  if (!old) return;
  const accept = old.kind === 'image' ? 'image/*' : old.kind === 'audio' ? 'audio/*,video/*' : 'video/*,audio/*,image/*';
  const [file] = await pickFiles({ accept, multiple: false });
  if (!file) return;
  if (!guessKind(file)) {
    toast(`지원하지 않는 파일입니다: ${file.name}`);
    return;
  }
  const mark = store.undoMark();
  const [nid] = await importFiles([file]);
  if (!nid || mediaStatus(nid) !== 'ready') {
    toast('새 파일을 읽지 못해 교체하지 않았습니다');
    if (nid) store.squashSince(mark, '미디어 교체 실패');
    return;
  }
  const fresh = store.project.media[nid];
  if (old.kind === 'video' && fresh.kind !== 'video' && Object.values(store.project.sequences).some((s) => Object.values(s.clips).some((c) => c.mediaId === id && c.kind === 'video'))) {
    toast('영상 클립이 쓰는 항목은 영상 파일로만 바꿀 수 있습니다');
  }
  store.transact('미디어 교체', () => {
    const p = store.project;
    const m = p.media[nid];
    const prev = p.media[id];
    if (!m || !prev) return;
    // the new item takes the old one's place, bin and label
    for (const k of ['bin', 'label', 'inPoint', 'outPoint']) if (prev[k] != null) m[k] = prev[k];
    for (const s of Object.values(p.sequences)) {
      for (const c of Object.values(s.clips)) {
        if (c.mediaId !== id) continue;
        if (c.kind === 'video' && m.kind !== 'video') continue;
        if (c.kind === 'audio' && !m.hasAudio) continue;
        c.mediaId = nid;
      }
    }
    // subclips of the old file follow it to the new one
    for (const sm of Object.values(p.media)) if (sm.subclipOf === id) sm.subclipOf = nid;
    const stillUsed = Object.values(p.sequences).some((s) => Object.values(s.clips).some((c) => c.mediaId === id));
    p.mediaOrder = p.mediaOrder.filter((x) => x !== nid);
    const at = p.mediaOrder.indexOf(id);
    if (stillUsed) p.mediaOrder.splice(at + 1, 0, nid);
    else {
      p.mediaOrder.splice(at, 1, nid);
      delete p.media[id];
    }
  });
  store.squashSince(mark, '미디어 교체');
  if (store.ui.selectedMedia?.has(id)) {
    store.ui.selectedMedia.delete(id);
    store.ui.selectedMedia.add(nid);
  }
  toast(`${old.name} → ${file.name} (으)로 교체했습니다`);
}

// Menu entries for the timeline editing features. Items are appended; the menu bar places them
// where Premiere Pro has them (편집 ▸ 특성 제거, 클립 ▸ 비디오 옵션 / 다음으로 바꾸기 / 그룹,
// 마커 ▸ 챕터 마커 …). Loaded after the menu bar is built (see timeline.js), so extendMenu applies at once.

import { store } from '../store.js';
import { commands as c } from '../commands.js';
import { isMac } from '../util.js';
import { extendMenu } from './menubar.js';
import { TOOLS } from './panels.js';

const mod = isMac ? '⌘' : 'Ctrl+';
const sel = () => store.selectedClips();
const has = () => sel().length > 0;
const hasVideo = () => sel().some((x) => x.kind === 'video');
const labelled = (it, prefix) => !!it && typeof it === 'object' && typeof it.label === 'string' && it.label.startsWith(prefix);

extendMenu('파일', (items) => [...items,
  { label: '클립에서 새 시퀀스', action: c.newSequenceFromClip },
]);

extendMenu('편집', (items) => [
  ...items.map((it) => (labelled(it, '효과만 붙여넣기') ? { ...it, label: '특성 붙여넣기…' } : it)),
  { label: '특성 제거…', disabled: !has(), action: c.removeAttributes },
]);

extendMenu('클립', (items) => [
  ...items.filter((it) => !labelled(it, '프레임 고정 (정지 화면)')),
  { label: '프레임 고정 옵션…', disabled: !hasVideo(), action: c.frameHoldOptions },
  { label: '프레임 고정 추가', disabled: !hasVideo(), action: c.frameHold },
  { label: '프레임 고정 세그먼트 삽입', disabled: !hasVideo(), action: c.frameHoldSegment },
  { label: '프레임 크기로 비율 조정', disabled: !has(), action: c.scaleToFrameSize },
  { label: '프레임 크기로 설정', disabled: !has(), action: c.setToFrameSize },
  { label: '다음으로 바꾸기', disabled: !has(), submenu: () => [
    { label: '소스 모니터', disabled: !store.ui.sourceMediaId, action: c.replaceFromSource },
    { label: '소스 모니터, 일치하는 프레임', disabled: !store.ui.sourceMediaId, action: c.replaceFromSourceMatch },
    { label: '저장소 항목', disabled: !store.ui.selectedMedia.size, action: c.replaceFromBin },
  ] },
  { label: '그룹', key: `${mod}G`, disabled: sel().length < 2, action: c.group },
  { label: '그룹 해제', key: `${mod}Shift+G`, disabled: !sel().some((x) => x.groupId), action: c.ungroup },
]);

extendMenu('시퀀스', (items) => [...items,
  { label: '선택한 편집점을 재생 헤드로 확장', key: 'E', disabled: !has(), action: c.extendEdit },
  { label: '트랙 추가…', action: c.addTracks },
  { label: '트랙 삭제…', action: c.deleteTracks },
  { label: '모든 트랙 확장', key: 'Shift+=', action: () => c.trackHeights('all', 1) },
  { label: '모든 트랙 최소화', key: 'Shift+-', action: () => c.trackHeights('all', -1) },
]);

extendMenu('마커', (items) => [
  ...items.map((it) => (it && it.label === '마커 모두 지우기' && !it.key ? { ...it, key: `${mod}Alt+Shift+M` } : it)),
  { label: '선택 항목 표시', key: '/', disabled: !has(), action: c.markSelection },
  { label: '선택한 마커 지우기', key: `${mod}Alt+M`, action: c.clearSelectedMarker },
  { label: '챕터 마커 추가…', action: c.addChapterMarker },
]);

// 창 ▸ 도구: pick a timeline tool from the menu (also how phones reach the tools)
extendMenu('창', (items) => [...items,
  { label: '도구', submenu: () => TOOLS.map(([id, title]) => {
    const m = String(title).match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    return { label: m ? m[1] : title, key: m ? m[2] : undefined, checked: store.ui.tool === id, action: () => c.setTool(id) };
  }) },
]);

// Application menu bar (Korean).

import { store } from '../store.js';
import { playback } from '../playback.js';
import { commands as c } from '../commands.js';
import { h, isMac } from '../util.js';
import { showMenu, closeMenus, UI_SCALES, uiScale } from './common.js';
import { LABEL_COLORS } from '../model.js';
import { TEMPLATES } from '../templates.js';
import { WORKSPACES } from './workspaces.js';
import { appMode, setMode } from '../mode.js';

const mod = isMac ? '⌘' : 'Ctrl+';

/** Menu definitions, shared with the phone layout's menu sheet. */
export const menubarApi = { menus: null };

export function createMenubar(el) {
  const sel = () => store.selectedClips();
  const has = () => sel().length > 0;
  const menus = {
    '파일': () => [
      { label: '새 프로젝트', action: c.newProject },
      { label: '프로젝트 열기…', key: `${mod}O`, action: c.openProject },
      { label: '프로젝트 파일로 저장', key: `${mod}S`, action: c.saveProject },
      { label: '프로젝트 이름 바꾸기…', action: c.renameProject },
      '-',
      { label: '가져오기… (영상·오디오·이미지·LUT)', key: `${mod}I`, action: c.importMedia },
      { label: '자막 파일 가져오기 (.srt)…', action: c.importCaptions },
      { label: '미디어 다시 연결…', action: c.linkMedia },
      '-',
      { label: '내보내기…', key: `${mod}M`, action: c.exportMedia },
      { label: '현재 프레임 저장 (PNG)', key: `${mod}Shift+E`, action: c.exportFrame },
      { label: '현재 프레임을 사진 편집에서 열기', action: c.frameToPhoto },
      { label: '자막 내보내기 (.srt)', action: c.exportCaptions },
      '-',
      { label: '샘플 프로젝트 열기', action: c.loadSample },
    ],
    '편집': () => [
      { label: `실행 취소${store.undoStack.length ? `: ${store.undoStack[store.undoStack.length - 1].label}` : ''}`, key: `${mod}Z`, disabled: !store.undoStack.length, action: c.undo },
      { label: `다시 실행${store.redoStack.length ? `: ${store.redoStack[store.redoStack.length - 1].label}` : ''}`, key: `${mod}Shift+Z`, disabled: !store.redoStack.length, action: c.redo },
      '-',
      { label: '잘라내기', key: `${mod}X`, disabled: !has(), action: c.cut },
      { label: '복사', key: `${mod}C`, disabled: !has(), action: c.copy },
      { label: '붙여넣기', key: `${mod}V`, disabled: !store.ui.clipboard, action: c.paste },
      { label: '삽입하며 붙여넣기', key: `${mod}Shift+V`, disabled: !store.ui.clipboard, action: c.pasteInsert },
      { label: '효과만 붙여넣기 (특성 붙여넣기)', key: `${mod}Alt+V`, disabled: !store.ui.clipboard || !has(), action: c.pasteAttributes },
      '-',
      { label: '지우기 (빈자리 남김)', key: 'Delete', action: c.clear },
      { label: '잔물결 삭제 (빈자리 당김)', key: 'Shift+Delete', action: c.rippleDelete },
      '-',
      { label: '모두 선택', key: `${mod}A`, action: c.selectAll },
      { label: '선택 해제', key: `${mod}Shift+A`, action: c.deselectAll },
    ],
    '클립': () => [
      { label: '속도/지속 시간…', key: `${mod}R`, disabled: !has(), action: c.speedDuration },
      { label: '역재생', disabled: !has(), action: c.reverse },
      { label: '프레임 고정 (정지 화면)', disabled: !sel().some((x) => x.kind === 'video'), action: c.frameHold },
      '-',
      { label: '소스에서 삽입', key: ',', action: c.insert },
      { label: '소스에서 덮어쓰기', key: '.', action: c.overwrite },
      '-',
      { label: '클립 사용', key: 'Shift+E', checked: has() && sel()[0].enabled !== false, disabled: !has(), action: c.toggleEnable },
      { label: '연결 / 연결 해제', key: `${mod}L`, disabled: !has(), action: c.linkToggle },
      { label: '중첩 (Nest)…', disabled: !has(), action: c.nest },
      { label: '레이블 색상', disabled: !has(), submenu: () => LABEL_COLORS.map(([color, name]) => ({ label: name, swatch: color || 'transparent', action: () => c.setLabel(color) })) },
      '-',
      { group: '꾸미기' },
      { label: '애니메이션 (등장·퇴장·반복)', action: () => c.quick('anim') },
      { label: '필터', action: () => c.quick('filter') },
      { label: '화면 위치 · 배경 채우기 · 비율', action: () => c.quick('frame') },
      '-',
      { group: '자동 편집' },
      { label: '무음 구간 자동 삭제 (점프 컷)…', action: c.silenceCut },
      { label: '비트 마커 (음악 박자 맞추기)…', action: c.beatMarkers },
      { label: '장면 전환 자동 감지…', disabled: !sel().some((x) => x.kind === 'video'), action: c.sceneDetect },
      { label: '멀티캠 소스 시퀀스 만들기…', action: c.multicamCreate },
      { label: '멀티캠 앵글 바꾸기', submenu: () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `앵글 ${n}`, key: String(n), action: () => c.switchAngle(n) })) },
      '-',
      { group: '오디오' },
      { label: '오디오 노멀라이즈 (최대 -1 dB)', disabled: !has(), action: c.normalize },
      { label: '오디오 추출 (영상에서 소리만 따로)…', action: c.extractAudio },
      { label: '목소리 효과 (로봇·전화·동굴…)', action: () => c.quick('audio') },
      { label: '자동 더킹 (말할 때 음악 줄이기)…', action: c.autoDuck },
      '-',
      { label: '효과 모두 제거', disabled: !has(), action: c.removeEffects },
      { label: '왼쪽으로 1프레임 이동', key: 'Alt+←', action: c.nudgeLeft },
      { label: '오른쪽으로 1프레임 이동', key: 'Alt+→', action: c.nudgeRight },
    ],
    '시퀀스': () => [
      { label: '새 시퀀스', action: c.newSequence },
      { label: '시퀀스 복제', action: c.duplicateSequence },
      { label: '시퀀스 삭제', action: c.deleteSequence },
      { label: '시퀀스 설정…', action: c.sequenceSettings },
      { label: '자동 리프레임 (세로·정사각형 변환)…', action: c.autoReframe },
      '-',
      { label: '원본 프레임 찾기 (매치 프레임)', key: 'F', action: c.matchFrame },
      { label: '편집점 추가 (자르기)', key: `${mod}K`, action: c.addEdit },
      { label: '모든 트랙에 편집점 추가', key: `${mod}Shift+K`, action: c.addEditAll },
      { label: '앞쪽을 재생헤드까지 잔물결 트림', key: 'Q', action: c.rippleTrimPrev },
      { label: '뒤쪽을 재생헤드까지 잔물결 트림', key: 'W', action: c.rippleTrimNext },
      '-',
      { label: '기본 영상 전환 적용', key: `${mod}D`, action: c.applyVideoTransition },
      { label: '기본 오디오 전환 적용', key: `${mod}Shift+D`, action: c.applyAudioTransition },
      { label: '선택한 클립에 기본 전환 적용', key: 'Shift+D', action: c.applyDefaultTransitions },
      '-',
      { label: '들어올리기 (시작~끝 지우기)', key: ';', action: c.lift },
      { label: '추출 (시작~끝 지우고 당기기)', key: "'", action: c.extract },
      { label: '모든 빈자리 닫기', action: c.closeGaps },
      '-',
      { label: '스냅', key: 'S', checked: store.ui.snapping, action: c.toggleSnap },
      { label: '연결된 선택', checked: store.ui.linkedSelection, action: c.toggleLinked },
      '-',
      { label: '비디오 트랙 추가', action: c.addVideoTrack },
      { label: '오디오 트랙 추가', action: c.addAudioTrack },
      { label: '보이스오버 녹음 (대상 오디오 트랙)', action: c.voiceover },
      '-',
      { label: '타임라인 확대', key: '=', action: c.zoomIn },
      { label: '타임라인 축소', key: '-', action: c.zoomOut },
      { label: '시퀀스 전체 보기', key: '\\', action: c.zoomFit },
    ],
    '마커': () => [
      { label: '시작 표시 (In)', key: 'I', action: c.markIn },
      { label: '끝 표시 (Out)', key: 'O', action: c.markOut },
      { label: '클립 범위로 표시', key: 'X', action: c.markClip },
      '-',
      { label: '시작 표시로 이동', key: 'Shift+I', action: c.goIn },
      { label: '끝 표시로 이동', key: 'Shift+O', action: c.goOut },
      '-',
      { label: '시작 표시 지우기', key: `${mod}Shift+I`, action: c.clearIn },
      { label: '끝 표시 지우기', key: `${mod}Shift+O`, action: c.clearOut },
      { label: '시작/끝 모두 지우기', key: `${mod}Shift+X`, action: c.clearInOut },
      '-',
      { label: '마커 추가', key: 'M', action: c.addMarker },
      { label: '다음 마커로', key: 'Shift+M', action: c.nextMarker },
      { label: '이전 마커로', key: `${mod}Shift+M`, action: c.prevMarker },
      { label: '마커 편집…', action: c.editMarker },
      { label: '마커 모두 지우기', action: c.clearMarkers },
    ],
    'AI': () => [
      { label: 'AI로 전체 편집하기…', action: () => c.ai('auto') },
      { label: 'AI 편집 도우미 (Gemini)…', action: () => c.ai('chat') },
      { label: '대본으로 편집 (자막 고치기·줄 잘라내기)', action: () => c.ai('script') },
      { label: 'Gemini API 키 설정…', action: () => c.ai('settings') },
      '-',
      { label: '자동 자막 만들기 (음성 인식)…', action: c.autoCaptions },
      { label: '무음 구간 자동 삭제…', action: c.silenceCut },
      { label: '비트 마커 (음악 박자)…', action: c.beatMarkers },
      { label: '장면 전환 감지…', action: c.sceneDetect },
    ],
    '그래픽': () => [
      { label: '새 텍스트', action: c.newText },
      { label: '문자 도구 (모니터를 클릭해 입력)', key: 'T', action: () => store.setTool('type') },
      { label: '타이틀 템플릿', submenu: () => TEMPLATES.map((t) => ({ label: t.name, action: () => c.template(t.id) })) },
      { label: '글자 스타일', action: () => c.quick('text') },
      { label: '스티커 (이모지)', action: () => c.quick('sticker') },
      { label: '사진 슬라이드쇼 만들기…', action: c.slideshow },
      '-',
      { label: '새 사각형', action: c.newRectangle },
      { label: '새 타원', action: c.newEllipse },
      { label: '새 삼각형', action: c.newTriangle },
      { label: '새 선', action: c.newLine },
      '-',
      { label: '새 색상 매트…', action: c.newColorMatte },
      { label: '새 블랙 비디오', action: c.newBlack },
      { label: '새 조정 레이어', action: c.newAdjustment },
      '-',
      { label: '자동 자막 만들기 (음성 인식)…', action: c.autoCaptions },
      { label: '자막 파일 가져오기 (.srt)…', action: c.importCaptions },
      { label: '자막 내보내기 (.srt)', action: c.exportCaptions },
    ],
    '보기': () => [
      { label: '재생 / 정지', key: 'Space', action: c.playStop },
      { label: '시작~끝 표시 구간 재생', key: `${mod}Shift+Space`, action: c.playInToOut },
      { label: '반복 재생', key: `${mod}Shift+L`, checked: playback.loop, action: c.toggleLoop },
      { label: '오디오 스크러빙 (끌 때 소리 듣기)', checked: !!store.ui.audioScrub, action: c.toggleAudioScrub },
      '-',
      { label: '화면 크기', submenu: () => UI_SCALES.map(([v, name]) => ({ label: name, checked: Math.abs(uiScale() - v) < 0.01, action: () => c.uiScale(v) })) },
      { label: '패널 최대화 / 복원', key: '`', action: c.maximizePanel },
    ],
    '창': () => [
      { label: '작업 영역', submenu: () => WORKSPACES.map((w) => ({ label: w.name, action: () => c.workspace(w.id) })) },
      '-',
      { label: '소스 모니터', action: () => c.showPanel('source') },
      { label: '효과 컨트롤', action: () => c.showPanel('effectControls') },
      { label: '오디오 트랙 믹서', action: () => c.showPanel('mixer') },
      { label: '빠른 편집', action: () => c.showPanel('quick') },
      { label: 'AI 편집', action: () => c.showPanel('ai') },
      { label: '멀티캠', action: () => c.showPanel('multicam') },
      { label: '스코프', action: () => c.showPanel('scopes') },
      { label: '프로그램 모니터', action: () => c.showPanel('program') },
      { label: '프로젝트', action: () => c.showPanel('project') },
      { label: '효과', action: () => c.showPanel('effects') },
      { label: '마커', action: () => c.showPanel('markers') },
      { label: '작업 내역', action: () => c.showPanel('history') },
      { label: '타임라인', action: () => c.showPanel('timeline') },
      '-',
      { label: '레이아웃 초기화', action: c.resetLayout },
    ],
    '도움말': () => [
      { label: '시작 가이드', action: c.guide },
      { label: '단축키 목록', key: 'F1', action: c.shortcuts },
      { label: '샘플 프로젝트 열기', action: c.loadSample },
      '-',
      { label: 'Montage 정보', action: c.about },
    ],
  };

  menubarApi.menus = menus;
  menubarApi.videoMenus = menus;
  el.append(h('span.brand', 'Montage'));
  // 영상 / 사진: the two editors share this bar; each brings its own menus
  const modeBtns = [['video', '영상 편집'], ['photo', '사진 편집']].map(([id, label]) => h('button.mode-btn', { 'data-mode': id, 'aria-pressed': 'false', onclick: () => setMode(id) }, label));
  el.append(h('div.mode-switch', { role: 'group', 'aria-label': '편집기 바꾸기' }, modeBtns));
  const menuWrap = h('div.menu-btns');
  el.append(menuWrap);
  const buttons = [];
  const renderMenus = () => {
    closeMenus();
    buttons.length = 0;
    menuWrap.replaceChildren();
    for (const [name, items] of Object.entries(menubarApi.menus)) {
      const b = h('button.menu-btn', name);
      const open = () => {
        const r = b.getBoundingClientRect();
        showMenu(items, r.left, r.bottom + 2);
        buttons.forEach((x) => x.classList.remove('open'));
        b.classList.add('open');
      };
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.classList.contains('open')) closeMenus();
        else open();
      });
      b.addEventListener('pointerenter', () => {
        if (buttons.some((x) => x.classList.contains('open') && x !== b) && document.querySelector('.menu')) open();
      });
      buttons.push(b);
      menuWrap.append(b);
    }
  };
  renderMenus();
  const name = h('span.project-name');
  const saved = h('span.saved');
  const guideBtn = h('button', { onclick: () => (appMode.isPhoto() ? appMode.P.menus['도움말']()[0].action() : c.guide()), title: '처음 쓰는 분을 위한 안내', style: { marginLeft: '8px' } }, '시작 가이드');
  const exportBtn = h('button.primary', { onclick: () => (appMode.isPhoto() ? appMode.P.exportDialog() : c.exportMedia()), style: { marginLeft: '6px' } }, '내보내기');
  el.append(h('span.spacer'), name, saved, guideBtn, exportBtn);
  const refresh = () => {
    const P = appMode.isPhoto() ? appMode.P : null;
    name.textContent = P ? (P.doc ? `${P.doc.name} · ${P.doc.width}×${P.doc.height}` : '사진 편집') : store.project.name;
    guideBtn.textContent = P ? '단축키' : '시작 가이드';
    guideBtn.title = P ? '사진 편집 단축키' : '처음 쓰는 분을 위한 안내';
    for (const b of modeBtns) {
      const on = b.dataset.mode === appMode.current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  store.on('change', refresh);
  store.on('saved', (d) => { if (!appMode.isPhoto()) saved.textContent = `자동 저장됨 ${d.toLocaleTimeString('ko-KR')}`; });
  let photoHooked = false;
  appMode.on((m) => {
    menubarApi.menus = m === 'photo' && appMode.P ? appMode.P.menus : menus;
    if (appMode.P && !photoHooked) {
      photoHooked = true;
      appMode.P.on('doc', refresh);
      appMode.P.on('history', refresh);
      appMode.P.on('saved', () => { if (appMode.isPhoto()) saved.textContent = `자동 저장됨 ${new Date().toLocaleTimeString('ko-KR')}`; });
    }
    saved.textContent = '';
    renderMenus();
    refresh();
  });
  refresh();
}

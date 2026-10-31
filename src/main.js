// Entry point: builds the workspace, restores the autosaved session and wires global behaviour.

import { store } from './store.js';
import { playback } from './playback.js';
import * as edit from './edit.js';
import * as media from './media.js';
import { commands } from './commands.js';
import { initAutosave, restoreSession } from './persist.js';
import { installShortcuts } from './shortcuts.js';
import { panelGroup, initSplitters, toast, applyUiScale, installFocusHygiene, loadPref } from './ui/common.js';
import { createMenubar } from './ui/menubar.js';
import { createProjectPanel } from './ui/project-panel.js';
import { createSourceMonitor } from './ui/source-monitor.js';
import { createProgramMonitor } from './ui/program-monitor.js';
import { createTimeline } from './ui/timeline.js';
import { createEffectControls } from './ui/effect-controls.js';
import {
  createEffectsPanel, createMarkersPanel, createHistoryPanel, createMixerPanel, createClipMixerPanel, createScopesPanel, createMulticamPanel, createMeters, createTools, TOOLS,
} from './ui/panels.js';
import { openGuideDialog } from './ui/dialogs.js';
import { createQuickPanel } from './ui/quick-panel.js';
import { createAiPanel } from './ui/ai-panel.js';
import { createEssentialSoundPanel } from './ui/essential-sound.js';
import './ui/audio-menus.js';
import { initMobile } from './ui/mobile.js';
import { formatTimecode } from './util.js';
import { loadSampleProject } from './sample.js';
import { ensureProjectFonts } from './fonts.js';
import { appMode, setMode, initialMode, photoEditor } from './mode.js';

const $ = (id) => document.getElementById(id);

function buildWorkspace() {
  createMenubar($('menubar'));
  const scopes = createScopesPanel();
  const multicam = createMulticamPanel();
  const quick = createQuickPanel();
  const ai = createAiPanel();
  panelGroup($('pg-top-left'), 'topLeft', [
    { id: 'source', title: '소스', body: createSourceMonitor() },
    { id: 'effectControls', title: '효과 컨트롤', body: createEffectControls() },
    { id: 'quick', title: '빠른 편집', body: quick, onShow: () => quick.onShow(), onHide: () => quick.onHide() },
    { id: 'ai', title: 'AI 편집', body: ai, onShow: () => ai.onShow(), onHide: () => ai.onHide() },
    { id: 'mixer', title: '오디오 트랙 믹서', body: createMixerPanel() },
    { id: 'clipMixer', title: '오디오 클립 믹서', body: createClipMixerPanel() },
    { id: 'essentialSound', title: '기본 사운드', body: createEssentialSoundPanel() },
    { id: 'scopes', title: 'Lumetri 범위', body: scopes, onShow: () => scopes.onShow(), onHide: () => scopes.setVisible(false) },
    { id: 'multicam', title: '멀티캠', body: multicam, onShow: () => multicam.onShow(), onHide: () => multicam.onHide() },
  ]);
  panelGroup($('pg-top-right'), 'topRight', [{ id: 'program', title: '프로그램', body: createProgramMonitor() }]);
  panelGroup($('pg-bottom-left'), 'bottomLeft', [
    { id: 'project', title: '프로젝트', body: createProjectPanel() },
    { id: 'effects', title: '효과', body: createEffectsPanel() },
    { id: 'markers', title: '마커', body: createMarkersPanel() },
    { id: 'history', title: '작업 내역', body: createHistoryPanel() },
    { id: 'lumetri', title: 'Lumetri 색상', body: createEffectControls({ only: 'lumetri' }) },
  ]);
  panelGroup($('pg-timeline'), 'timeline', [{ id: 'timeline', title: '타임라인', body: createTimeline() }]);
  createTools($('tools'));
  createMeters($('meters'));
  initSplitters();
  store.setFocus('timeline');
}

// what the tool does, shown in the status bar like Premiere's hints
const TOOL_HINTS = {
  select: '클릭해 선택 · 빈 곳에서 끌어 여러 개 선택 · Alt+끌기: 복제 · Ctrl+끌기: 삽입하며 이동',
  track: '클릭한 곳부터 뒤쪽 클립을 모두 선택',
  trackBack: '클릭한 곳부터 앞쪽 클립을 모두 선택',
  ripple: '편집점을 끌어 길이를 바꾸면 뒤쪽 클립이 따라 움직입니다',
  rolling: '두 클립 사이 편집점을 끌어 옮깁니다 (전체 길이는 그대로)',
  rate: '클립 끝을 끌면 길이에 맞춰 속도가 바뀝니다',
  razor: '클릭한 곳에서 클립을 자릅니다',
  slip: '클립 안의 내용만 앞뒤로 밉니다 (위치·길이는 그대로)',
  slide: '클립을 옮기고 양옆 클립의 길이를 맞춥니다',
  pen: '키프레임을 추가하거나 끌어서 값을 바꿉니다',
  hand: '끌어서 타임라인 보기를 옮깁니다',
  zoom: '클릭해 확대, Alt+클릭해 축소',
  type: '프로그램 모니터를 클릭해 글자를 입력합니다',
};

function buildStatusBar() {
  const bar = $('statusbar');
  const left = document.createElement('span');
  left.className = 'grow';
  const right = document.createElement('span');
  bar.append(left, right);
  const toolName = () => TOOLS.find(([id]) => id === store.ui.tool)?.[1] || store.ui.tool;
  const refresh = () => {
    const sel = store.selectedClips();
    const s = store.seq;
    let msg = toolName();
    if (!sel.length && !store.selection.transition && !store.selection.gap && TOOL_HINTS[store.ui.tool]) msg += ` · ${TOOL_HINTS[store.ui.tool]}`;
    if (sel.length === 1) {
      const c = sel[0];
      msg += ` · ${c.name || c.kind} · ${formatTimecode(c.start, s.fps)} → ${formatTimecode(c.start + c.duration, s.fps)} (길이 ${formatTimecode(c.duration, s.fps)})`;
    } else if (sel.length) msg += ` · 클립 ${sel.length}개 선택됨`;
    else if (store.selection.transition) msg += ' · 전환 선택됨 (Delete: 삭제)';
    else if (store.selection.gap) msg += ' · 빈 공간 선택됨 (Delete: 당겨서 메우기)';
    left.textContent = msg;
    const nMedia = store.project.mediaOrder.filter((id) => store.project.media[id]?.kind !== 'sequence').length;
    right.textContent = `클립 ${Object.keys(s.clips).length}개 · 미디어 ${nMedia}개 · F1 단축키 · 도움말 ▸ 시작 가이드`;
  };
  // edits fire many 'change' events while dragging: update once per frame
  let raf = 0;
  const later = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };
  for (const evt of ['selection', 'tool', 'change', 'sequence']) store.on(evt, later);
  refresh();
}

function installFileDrop() {
  const overlay = $('drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragenter', () => {
    overlay.textContent = appMode.isPhoto() ? '여기에 놓으면 사진 편집에서 엽니다 (Shift: 새 레이어로)' : '여기에 놓으면 파일을 가져옵니다';
  }, true);
  window.addEventListener('drop', (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (appMode.isPhoto()) photoEditor().then((P) => (P.doc && e.shiftKey ? P.cmd.placeFiles(files) : P.openFiles(files)));
    else media.importFiles(files);
  });
  // panels that handle drops themselves stop propagation; hide the overlay for them too
  window.addEventListener('drop', () => { depth = 0; overlay.hidden = true; }, true);
}

async function boot() {
  applyUiScale();
  installFocusHygiene();
  buildWorkspace();
  buildStatusBar();
  initMobile();
  installShortcuts();
  installFileDrop();
  store.on('toast', toast);
  store.on('change', (reason) => {
    if (reason === 'load' || reason === 'restore') ensureProjectFonts(store.project);
  });
  window.addEventListener('montage:toast', (e) => toast(e.detail));
  const restored = await restoreSession();
  initAutosave();
  const blank = /[?&]blank\b/.test(location.search);
  if (restored) toast('지난번 작업을 불러왔습니다');
  else if (!blank) {
    try {
      await loadSampleProject();
      toast('샘플 프로젝트를 열었습니다. 파일 ▸ 새로 만들기 ▸ 프로젝트로 빈 프로젝트를 시작할 수 있습니다.');
    } catch (err) {
      console.warn('sample project failed', err);
    }
  }
  if (!blank && !loadPref('guideSeen', false)) {
    try { localStorage.setItem('montage.guideSeen', 'true'); } catch { /* storage unavailable */ }
    openGuideDialog();
  }
  playback.requestRender();
  appMode.on((m) => {
    if (m === 'photo') playback.stop();
    else playback.requestRender();
    window.dispatchEvent(new Event('resize'));
  });
  if (initialMode() === 'photo') await setMode('photo');
  if (location.hash.startsWith('#docs')) import('./docs/viewer.js').then((m) => m.openFromHash());
  window.addEventListener('error', (e) => toast(`오류: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => console.warn('unhandled', e.reason));
}

// exposed for debugging and automated tests
window.montage = { store, edit, media, playback, commands, appMode, setMode };

boot();

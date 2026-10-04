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
  createEffectsPanel, createMarkersPanel, createHistoryPanel, createMixerPanel, createScopesPanel, createMulticamPanel, createMeters, createTools, TOOLS,
} from './ui/panels.js';
import { openGuideDialog } from './ui/dialogs.js';
import { formatTimecode } from './util.js';
import { loadSampleProject } from './sample.js';

const $ = (id) => document.getElementById(id);

function buildWorkspace() {
  createMenubar($('menubar'));
  const scopes = createScopesPanel();
  const multicam = createMulticamPanel();
  panelGroup($('pg-top-left'), 'topLeft', [
    { id: 'source', title: '소스', body: createSourceMonitor() },
    { id: 'effectControls', title: '효과 컨트롤', body: createEffectControls() },
    { id: 'mixer', title: '오디오 믹서', body: createMixerPanel() },
    { id: 'scopes', title: '스코프', body: scopes, onShow: () => scopes.onShow(), onHide: () => scopes.setVisible(false) },
    { id: 'multicam', title: '멀티캠', body: multicam, onShow: () => multicam.onShow(), onHide: () => multicam.onHide() },
  ]);
  panelGroup($('pg-top-right'), 'topRight', [{ id: 'program', title: '프로그램', body: createProgramMonitor() }]);
  panelGroup($('pg-bottom-left'), 'bottomLeft', [
    { id: 'project', title: '프로젝트', body: createProjectPanel() },
    { id: 'effects', title: '효과', body: createEffectsPanel() },
    { id: 'markers', title: '마커', body: createMarkersPanel() },
    { id: 'history', title: '작업 내역', body: createHistoryPanel() },
  ]);
  panelGroup($('pg-timeline'), 'timeline', [{ id: 'timeline', title: '타임라인', body: createTimeline() }]);
  createTools($('tools'));
  createMeters($('meters'));
  initSplitters();
  store.setFocus('timeline');
}

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
  for (const evt of ['selection', 'tool', 'change']) store.on(evt, refresh);
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
  window.addEventListener('drop', (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    media.importFiles([...e.dataTransfer.files]);
  });
  // panels that handle drops themselves stop propagation; hide the overlay for them too
  window.addEventListener('drop', () => { depth = 0; overlay.hidden = true; }, true);
}

async function boot() {
  applyUiScale();
  installFocusHygiene();
  buildWorkspace();
  buildStatusBar();
  installShortcuts();
  installFileDrop();
  store.on('toast', toast);
  window.addEventListener('montage:toast', (e) => toast(e.detail));
  const restored = await restoreSession();
  initAutosave();
  const blank = /[?&]blank\b/.test(location.search);
  if (restored) toast('지난번 작업을 불러왔습니다');
  else if (!blank) {
    try {
      await loadSampleProject();
      toast('샘플 프로젝트를 열었습니다. 파일 ▸ 새 프로젝트로 빈 프로젝트를 시작할 수 있습니다.');
    } catch (err) {
      console.warn('sample project failed', err);
    }
  }
  if (!blank && !loadPref('guideSeen', false)) {
    try { localStorage.setItem('montage.guideSeen', 'true'); } catch { /* storage unavailable */ }
    openGuideDialog();
  }
  playback.requestRender();
  window.addEventListener('error', (e) => toast(`오류: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => console.warn('unhandled', e.reason));
}

// exposed for debugging and automated tests
window.montage = { store, edit, media, playback, commands };

boot();

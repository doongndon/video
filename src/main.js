// Entry point: builds the workspace, restores the autosaved session and wires global behaviour.

import { store } from './store.js';
import { playback } from './playback.js';
import * as edit from './edit.js';
import * as media from './media.js';
import { commands } from './commands.js';
import { initAutosave, restoreSession } from './persist.js';
import { installShortcuts } from './shortcuts.js';
import { panelGroup, initSplitters, toast } from './ui/common.js';
import { createMenubar } from './ui/menubar.js';
import { createProjectPanel } from './ui/project-panel.js';
import { createSourceMonitor } from './ui/source-monitor.js';
import { createProgramMonitor } from './ui/program-monitor.js';
import { createTimeline } from './ui/timeline.js';
import { createEffectControls } from './ui/effect-controls.js';
import {
  createEffectsPanel, createMarkersPanel, createHistoryPanel, createMixerPanel, createScopesPanel, createMeters, createTools, TOOLS,
} from './ui/panels.js';
import { formatTimecode } from './util.js';

const $ = (id) => document.getElementById(id);

function buildWorkspace() {
  createMenubar($('menubar'));
  const scopes = createScopesPanel();
  panelGroup($('pg-top-left'), 'topLeft', [
    { id: 'source', title: 'Source', body: createSourceMonitor() },
    { id: 'effectControls', title: 'Effect Controls', body: createEffectControls() },
    { id: 'mixer', title: 'Audio Track Mixer', body: createMixerPanel() },
    { id: 'scopes', title: 'Scopes', body: scopes, onShow: () => scopes.onShow(), onHide: () => scopes.setVisible(false) },
  ]);
  panelGroup($('pg-top-right'), 'topRight', [{ id: 'program', title: 'Program', body: createProgramMonitor() }]);
  panelGroup($('pg-bottom-left'), 'bottomLeft', [
    { id: 'project', title: 'Project', body: createProjectPanel() },
    { id: 'effects', title: 'Effects', body: createEffectsPanel() },
    { id: 'markers', title: 'Markers', body: createMarkersPanel() },
    { id: 'history', title: 'History', body: createHistoryPanel() },
  ]);
  panelGroup($('pg-timeline'), 'timeline', [{ id: 'timeline', title: 'Timeline', body: createTimeline() }]);
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
      msg += ` · ${c.name || c.kind} · ${formatTimecode(c.start, s.fps)} → ${formatTimecode(c.start + c.duration, s.fps)} (${formatTimecode(c.duration, s.fps)})`;
    } else if (sel.length) msg += ` · ${sel.length} clips selected`;
    else if (store.selection.transition) msg += ' · transition selected';
    else if (store.selection.gap) msg += ' · gap selected (Delete to ripple delete)';
    left.textContent = msg;
    right.textContent = `${Object.keys(s.clips).length} clips · ${store.project.mediaOrder.length} media · F1 shortcuts`;
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
  buildWorkspace();
  buildStatusBar();
  installShortcuts();
  installFileDrop();
  store.on('toast', toast);
  const restored = await restoreSession();
  initAutosave();
  if (restored) toast('Restored your last session');
  playback.requestRender();
  window.addEventListener('error', (e) => toast(`Error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => console.warn('unhandled', e.reason));
}

// exposed for debugging and automated tests
window.montage = { store, edit, media, playback, commands };

boot();

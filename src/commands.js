// Command registry shared by the menu bar and keyboard shortcuts. Commands that exist in both the
// Source and Program/Timeline context route by the focused panel, like an NLE.

import { store } from './store.js';
import { playback } from './playback.js';
import * as edit from './edit.js';
import { createSyntheticMedia, importFiles, mediaStatus, runtime, peakInRange } from './media.js';
import { saveProjectFile, openProjectFile, clearSession, relinkFromFiles, setAutosave, saveProjectNow } from './persist.js';
import { createProject, clipEnd, clipsOnTrack, editPoints, sequenceDuration, videoTracks, mediaTimeAt } from './model.js';
import { snapFrame, EPS } from './util.js';
import { sourceApi } from './ui/source-monitor.js';
import { programApi } from './ui/program-monitor.js';
import { timelineApi } from './ui/timeline.js';
import { pickFiles, importDialog } from './ui/project-panel.js';
import { showPanel, toggleMaximize, confirmDialog, promptDialog, toast } from './ui/common.js';
import {
  openSpeedDialog, openSequenceSettings, openExportDialog, openShortcutsDialog, openAboutDialog,
  openColorMatteDialog, importSrt, exportSrt, openMarkerDialog, openSceneDetectDialog,
} from './ui/dialogs.js';

const inSource = () => store.ui.focusPanel === 'source' && sourceApi.hasMedia?.();
const seq = () => store.seq;
const sel = () => store.selectedClips();
const selIds = () => [...store.selection.clips];

function seekEdit(dir) {
  playback.stop();
  const t = store.ui.playhead;
  const targeted = seq().tracks.filter((tr) => tr.targeted).map((tr) => tr.id);
  const pts = editPoints(seq(), targeted.length ? targeted : null);
  const target = dir < 0 ? pts.filter((p) => p < t - EPS).pop() : pts.find((p) => p > t + EPS);
  if (target != null) store.setPlayhead(target);
}

function seekMarker(dir) {
  const t = store.ui.playhead;
  const list = seq().markers.map((m) => m.time);
  const target = dir < 0 ? list.filter((p) => p < t - EPS).pop() : list.find((p) => p > t + EPS);
  if (target != null) store.setPlayhead(target);
}

function nudge(frames) {
  const ids = [...edit.withLinked(selIds())];
  if (!ids.length) return;
  store.transact('Nudge', () => edit.rawMoveClips(ids, frames / seq().fps, 0, 0, { mode: 'overwrite' }));
}

function matchFrame() {
  const s = seq();
  const t = store.ui.playhead;
  for (const tr of videoTracks(s).slice().reverse().concat(s.tracks.filter((x) => x.kind === 'audio'))) {
    const c = clipsOnTrack(s, tr.id).find((x) => t >= x.start && t < clipEnd(x) && x.mediaId);
    if (!c) continue;
    const m = s.clips[c.id] && store.project.media[c.mediaId];
    if (!m || m.kind === 'color' || m.kind === 'adjustment') continue;
    store.ui.sourceMediaId = c.mediaId;
    store.ui.sourceSeek = mediaTimeAt(c, t);
    store.emit('source');
    showPanel('source');
    return;
  }
  toast('No clip under the playhead');
}

async function newProject() {
  if (store.project.mediaOrder.length || Object.keys(seq().clips).length) {
    if (!(await confirmDialog('New Project', 'Start a new project? The current project and its autosave will be cleared (save a project file first if you need it).'))) return;
  }
  setAutosave(false);
  await clearSession();
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
  playback.resetMedia();
  store.loadProject(createProject());
  setAutosave(true);
  saveProjectNow();
}

async function openProject() {
  const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
  if (!file) return;
  try {
    setAutosave(false);
    playback.resetMedia();
    await openProjectFile(file);
    setAutosave(true);
    saveProjectNow();
    const offline = store.project.mediaOrder.filter((id) => mediaStatus(id) === 'offline').length;
    toast(offline ? `Project opened — ${offline} media item(s) offline. Use File ▸ Link Media… to relink.` : 'Project opened');
  } catch (err) {
    setAutosave(true);
    toast(`Could not open project: ${err.message}`);
  }
}

async function linkMedia() {
  const files = await pickFiles();
  if (!files.length) return;
  const n = await relinkFromFiles(files);
  toast(n ? `Relinked ${n} item(s)` : 'No matching file names found');
}

export const commands = {
  // ---- file
  newProject,
  openProject,
  saveProject: () => saveProjectFile(),
  importMedia: () => importDialog(),
  importCaptions: async () => {
    const [f] = await pickFiles({ accept: '.srt,text/plain', multiple: false });
    if (f) await importSrt(f);
  },
  exportCaptions: () => exportSrt(),
  exportMedia: () => openExportDialog(),
  exportFrame: () => programApi.saveFrame?.(),
  linkMedia,
  renameProject: async () => {
    const n = await promptDialog('Rename Project', 'Project name', store.project.name);
    if (n) store.transact('Rename Project', () => { store.project.name = n; });
  },

  // ---- edit
  undo: () => store.undo(),
  redo: () => store.redo(),
  cut: () => edit.copySelection(true),
  copy: () => edit.copySelection(),
  paste: () => edit.paste(),
  pasteInsert: () => edit.paste({ insert: true }),
  pasteAttributes: () => {
    const cb = store.ui.clipboard;
    if (!cb?.clips.length || !sel().length) return;
    edit.pasteAttributes(cb.clips[0], selIds());
  },
  clear: () => edit.deleteSelection(),
  rippleDelete: () => edit.deleteSelection({ ripple: true }),
  selectAll: () => edit.selectAll(),
  deselectAll: () => store.clearSelection(),

  // ---- clip
  speedDuration: () => sel().length && openSpeedDialog(selIds()),
  toggleEnable: () => sel().length && edit.setEnabled(selIds(), !(sel()[0].enabled !== false)),
  linkToggle: () => {
    const s = sel();
    if (!s.length) return;
    if (s.some((c) => c.linkId)) edit.unlinkClips(selIds());
    else edit.linkClips(selIds());
  },
  frameHold: () => {
    const c = sel().find((x) => x.kind === 'video');
    if (c) edit.addFrameHold(c);
  },
  reverse: () => {
    const s = sel().filter((c) => c.kind === 'video' || c.kind === 'audio');
    if (s.length) edit.setSpeed(s.map((c) => c.id), { speed: s[0].speed, reverse: !s[0].reverse });
  },
  insert: () => sourceApi.insert?.(),
  overwrite: () => sourceApi.overwrite?.(),
  nudgeLeft: () => nudge(-1),
  nudgeRight: () => nudge(1),
  normalize: () => {
    const ids = [...edit.withLinked(selIds())];
    const n = edit.normalizeAudio(ids, peakInRange, -1);
    toast(n ? `Normalized ${n} audio clip(s) to -1 dB peak` : 'Select audio clips (waveforms must be analysed)');
  },
  sceneDetect: () => openSceneDetectDialog(),
  removeEffects: () => store.transact('Remove Effects', () => {
    for (const c of sel()) c.effects = c.effects.filter((fx) => ['motion', 'opacity', 'text', 'fill', 'volume', 'panner'].includes(fx.type));
  }),

  // ---- sequence
  sequenceSettings: () => openSequenceSettings(),
  addEdit: () => edit.addEdit(),
  addEditAll: () => edit.addEdit({ allTracks: true }),
  applyVideoTransition: () => edit.applyDefaultTransitions({ video: true, audio: false }),
  applyAudioTransition: () => edit.applyDefaultTransitions({ video: false, audio: true }),
  applyDefaultTransitions: () => edit.applyDefaultTransitions(),
  lift: () => edit.liftExtract(false),
  extract: () => edit.liftExtract(true),
  rippleTrimPrev: () => edit.rippleTrimToPlayhead('prev'),
  rippleTrimNext: () => edit.rippleTrimToPlayhead('next'),
  closeGaps: () => edit.closeAllGaps(),
  toggleSnap: () => timelineApi.toggleSnap?.(),
  toggleLinked: () => {
    store.ui.linkedSelection = !store.ui.linkedSelection;
    toast(`Linked selection ${store.ui.linkedSelection ? 'on' : 'off'}`);
    store.changed();
  },
  addVideoTrack: () => edit.addTrack('video'),
  addAudioTrack: () => edit.addTrack('audio'),
  zoomIn: () => timelineApi.zoomIn?.(),
  zoomOut: () => timelineApi.zoomOut?.(),
  zoomFit: () => timelineApi.zoomToFit?.(),
  matchFrame,

  // ---- marking (context aware)
  markIn: () => (inSource() ? sourceApi.markIn() : edit.setSequenceInOut('in', store.ui.playhead)),
  markOut: () => (inSource() ? sourceApi.markOut() : edit.setSequenceInOut('out', store.ui.playhead)),
  markClip: () => edit.markClip(),
  goIn: () => (inSource() ? sourceApi.goIn() : (playback.stop(), store.setPlayhead(seq().inPoint ?? 0))),
  goOut: () => (inSource() ? sourceApi.goOut() : (playback.stop(), store.setPlayhead(seq().outPoint ?? sequenceDuration(seq())))),
  clearIn: () => (inSource() ? sourceApi.clearIn() : edit.setSequenceInOut('in', null)),
  clearOut: () => (inSource() ? sourceApi.clearOut() : edit.setSequenceInOut('out', null)),
  clearInOut: () => (inSource() ? sourceApi.clearInOut() : store.transact('Clear In and Out', () => { seq().inPoint = null; seq().outPoint = null; })),
  addMarker: () => edit.addMarker(),
  nextMarker: () => seekMarker(1),
  prevMarker: () => seekMarker(-1),
  editMarker: () => {
    const mk = seq().markers.find((m) => Math.abs(m.time - store.ui.playhead) < 0.5 / seq().fps);
    if (mk) openMarkerDialog(mk.id);
    else toast('No marker at the playhead');
  },
  clearMarkers: () => store.transact('Clear All Markers', () => { seq().markers = []; }),

  // ---- graphics
  newText: () => edit.addTextClip(),
  newColorMatte: () => openColorMatteDialog(),
  newAdjustment: () => createSyntheticMedia('adjustment', { name: 'Adjustment Layer' }),
  newBlack: () => createSyntheticMedia('color', { name: 'Black Video', color: '#000000' }),

  // ---- transport (context aware)
  playStop: () => (inSource() ? sourceApi.togglePlay() : playback.toggle()),
  shuttleBack: () => (inSource() ? sourceApi.shuttle(-1) : playback.shuttle(-1)),
  shuttleStop: () => (inSource() ? sourceApi.shuttle(0) : playback.shuttle(0)),
  shuttleForward: () => (inSource() ? sourceApi.shuttle(1) : playback.shuttle(1)),
  stepBack: () => (inSource() ? sourceApi.step(-1) : playback.step(-1)),
  stepForward: () => (inSource() ? sourceApi.step(1) : playback.step(1)),
  stepBack5: () => (inSource() ? sourceApi.step(-5) : playback.step(-5)),
  stepForward5: () => (inSource() ? sourceApi.step(5) : playback.step(5)),
  prevEdit: () => seekEdit(-1),
  nextEdit: () => seekEdit(1),
  goStart: () => (inSource() ? sourceApi.goStart() : (playback.stop(), store.setPlayhead(0))),
  goEnd: () => (inSource() ? sourceApi.goEnd() : (playback.stop(), store.setPlayhead(sequenceDuration(seq())))),
  playInToOut: () => playback.playInToOut(),
  toggleLoop: () => {
    playback.loop = !playback.loop;
    playback.emit('state');
    toast(`Loop ${playback.loop ? 'on' : 'off'}`);
  },
  snapPlayhead: () => store.setPlayhead(snapFrame(store.ui.playhead, seq().fps)),

  // ---- window / help
  maximizePanel: () => toggleMaximize(),
  showPanel: (id) => showPanel(id),
  resetLayout: () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('montage.split') || k.startsWith('montage.tab.')) localStorage.removeItem(k);
    location.reload();
  },
  shortcuts: () => openShortcutsDialog(),
  about: () => openAboutDialog(),
};

export { importFiles };

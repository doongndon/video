// Command registry shared by the menu bar and keyboard shortcuts. Commands that exist in both the
// Source and Program/Timeline context route by the focused panel, like an NLE.

import { store } from './store.js';
import { playback } from './playback.js';
import * as edit from './edit.js';
import { createSyntheticMedia, importFiles, mediaStatus, runtime, peakInRange } from './media.js';
import { saveProjectFile, openProjectFile, clearSession, relinkFromFiles, setAutosave, saveProjectNow } from './persist.js';
import { createProject, clipEnd, clipsOnTrack, editPoints, sequenceDuration, videoTracks, mediaTimeAt, EFFECT_FIXED_TYPES } from './model.js';
import { snapFrame, EPS } from './util.js';
import { sourceApi } from './ui/source-monitor.js';
import { loadSampleProject } from './sample.js';
import { programApi } from './ui/program-monitor.js';
import { timelineApi } from './ui/timeline.js';
import { pickFiles, importDialog } from './ui/project-panel.js';
import { showPanel, toggleMaximize, confirmDialog, promptDialog, toast, applyUiScale } from './ui/common.js';
import { applyWorkspace } from './ui/workspaces.js';
import { insertTemplate } from './templates.js';
import { toggleVoiceover } from './recorder.js';
import {
  openSpeedDialog, openSequenceSettings, openExportDialog, openShortcutsDialog, openAboutDialog,
  openColorMatteDialog, importSrt, exportSrt, openMarkerDialog, openSceneDetectDialog,
  openDuckingDialog, openReframeDialog, openMulticamDialog, openAutoCaptionDialog, openGuideDialog, openExtractAudioDialog,
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
  store.transact('1프레임 이동', () => edit.rawMoveClips(ids, frames / seq().fps, 0, 0, { mode: 'overwrite' }));
}

function matchFrame() {
  const s = seq();
  const t = store.ui.playhead;
  for (const tr of videoTracks(s).slice().reverse().concat(s.tracks.filter((x) => x.kind === 'audio'))) {
    const c = clipsOnTrack(s, tr.id).find((x) => t >= x.start && t < clipEnd(x) && x.mediaId);
    if (!c) continue;
    const m = store.project.media[c.mediaId];
    if (!m || ['color', 'adjustment', 'sequence', 'lut'].includes(m.kind)) continue;
    store.ui.sourceMediaId = c.mediaId;
    store.ui.sourceSeek = mediaTimeAt(c, t);
    store.emit('source');
    showPanel('source');
    return;
  }
  toast('재생헤드 아래에 원본을 열 수 있는 클립이 없습니다');
}

async function resetProjectState() {
  setAutosave(false);
  await clearSession();
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
  playback.resetMedia();
}

async function newProject() {
  if (store.project.mediaOrder.length > 1 || Object.keys(seq().clips).length) {
    if (!(await confirmDialog('새 프로젝트', '현재 프로젝트와 자동 저장본을 지우고 새로 시작할까요?\n필요하면 먼저 파일 ▸ 프로젝트 파일로 저장을 하세요.'))) return;
  }
  await resetProjectState();
  store.loadProject(createProject('제목 없는 프로젝트'));
  setAutosave(true);
  saveProjectNow();
  toast('새 프로젝트를 만들었습니다');
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
    toast(offline ? `프로젝트를 열었습니다. 미디어 ${offline}개가 오프라인입니다 — 파일 ▸ 미디어 다시 연결로 연결하세요.` : '프로젝트를 열었습니다');
  } catch (err) {
    setAutosave(true);
    toast(`프로젝트를 열 수 없습니다: ${err.message}`);
  }
}

async function linkMedia() {
  const files = await pickFiles({ accept: 'video/*,audio/*,image/*,.cube,.ttf,.otf,.woff,.woff2' });
  if (!files.length) return;
  const n = await relinkFromFiles(files);
  toast(n ? `${n}개 항목을 다시 연결했습니다` : '이름이 같은 파일을 찾지 못했습니다');
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
    const n = await promptDialog('프로젝트 이름 바꾸기', '프로젝트 이름', store.project.name);
    if (n) store.transact('프로젝트 이름 바꾸기', () => { store.project.name = n; });
  },
  loadSample: async () => {
    if (store.project.mediaOrder.length > 1 || Object.keys(seq().clips).length) {
      if (!(await confirmDialog('샘플 프로젝트 열기', '현재 프로젝트를 샘플 프로젝트로 바꿀까요?\n필요하면 먼저 프로젝트 파일로 저장하세요.'))) return;
    }
    await resetProjectState();
    setAutosave(true);
    await loadSampleProject();
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
    if (!cb?.clips.length || !sel().length) return toast('먼저 클립을 복사하고, 붙여 넣을 클립을 선택하세요');
    edit.pasteAttributes(cb.clips[0], selIds());
  },
  clear: () => edit.deleteSelection(),
  rippleDelete: () => edit.deleteSelection({ ripple: true }),
  selectAll: () => edit.selectAll(),
  deselectAll: () => store.clearSelection(),

  // ---- clip
  speedDuration: () => (sel().length ? openSpeedDialog(selIds()) : toast('클립을 먼저 선택하세요')),
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
    else toast('영상 클립을 선택하세요');
  },
  reverse: () => edit.toggleReverse(selIds()),
  insert: () => sourceApi.insert?.(),
  overwrite: () => sourceApi.overwrite?.(),
  nudgeLeft: () => nudge(-1),
  nudgeRight: () => nudge(1),
  normalize: () => {
    const ids = [...edit.withLinked(selIds())];
    const n = edit.normalizeAudio(ids, peakInRange, -1);
    toast(n ? `오디오 클립 ${n}개를 최대 -1 dB로 맞췄습니다` : '오디오 클립을 선택하세요 (파형 분석이 끝나야 합니다)');
  },
  autoDuck: () => openDuckingDialog(),
  extractAudio: () => {
    const c = sel().find((x) => x.mediaId && ['video', 'audio'].includes(store.project.media[x.mediaId]?.kind));
    if (c) return openExtractAudioDialog({ clipId: c.id });
    const mid = [...store.ui.selectedMedia].find((id) => ['video', 'audio'].includes(store.project.media[id]?.kind));
    if (mid) return openExtractAudioDialog({ mediaId: mid });
    toast('타임라인 클립이나 프로젝트 패널의 영상을 먼저 선택하세요');
  },
  sceneDetect: () => openSceneDetectDialog(),
  setLabel: (color) => {
    if (!sel().length) return toast('클립을 먼저 선택하세요');
    edit.setLabel([...edit.withLinked(selIds())], color);
  },
  removeEffects: () => store.transact('효과 모두 제거', () => {
    for (const c of sel()) c.effects = c.effects.filter((fx) => EFFECT_FIXED_TYPES.has(fx.type));
  }),
  multicamCreate: () => openMulticamDialog(),
  switchAngle: (n) => edit.switchAngle(n, { cut: playback.playing }),

  // ---- sequence
  sequenceSettings: () => openSequenceSettings(),
  newSequence: () => edit.newSequence(),
  duplicateSequence: () => edit.duplicateSequence(),
  deleteSequence: () => edit.deleteSequence(store.seq.id),
  autoReframe: () => openReframeDialog(),
  nest: async () => {
    if (!sel().length) return toast('중첩할 클립을 선택하세요');
    const n = await promptDialog('중첩 시퀀스 이름', '이름', `중첩 시퀀스 ${Object.keys(store.project.sequences).length}`);
    if (n != null) edit.nestSelection(n);
  },
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
    toast(`연결된 선택 ${store.ui.linkedSelection ? '켬' : '끔'}`);
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
  clearInOut: () => (inSource() ? sourceApi.clearInOut() : store.transact('시작/끝 지우기', () => { seq().inPoint = null; seq().outPoint = null; })),
  addMarker: () => edit.addMarker(),
  nextMarker: () => seekMarker(1),
  prevMarker: () => seekMarker(-1),
  editMarker: () => {
    const mk = seq().markers.find((m) => Math.abs(m.time - store.ui.playhead) < 0.5 / seq().fps);
    if (mk) openMarkerDialog(mk.id);
    else toast('재생헤드 위치에 마커가 없습니다');
  },
  clearMarkers: () => store.transact('마커 모두 지우기', () => { seq().markers = []; }),

  // ---- graphics
  newText: () => edit.addTextClip(),
  newRectangle: () => edit.addShapeClip('rectangle'),
  newEllipse: () => edit.addShapeClip('ellipse'),
  newTriangle: () => edit.addShapeClip('triangle'),
  newLine: () => edit.addShapeClip('line'),
  newColorMatte: () => openColorMatteDialog(),
  newAdjustment: () => createSyntheticMedia('adjustment', { name: '조정 레이어' }),
  newBlack: () => createSyntheticMedia('color', { name: '블랙 비디오', color: '#000000' }),
  template: (id) => insertTemplate(id),
  autoCaptions: () => openAutoCaptionDialog(),

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
    toast(`반복 재생 ${playback.loop ? '켬' : '끔'}`);
  },
  toggleAudioScrub: () => {
    store.ui.audioScrub = !store.ui.audioScrub;
    toast(`오디오 스크러빙 ${store.ui.audioScrub ? '켬' : '끔'}`);
  },
  voiceover: () => {
    const tr = seq().tracks.find((t) => t.kind === 'audio' && t.targeted && !t.locked) || seq().tracks.find((t) => t.kind === 'audio' && !t.locked);
    if (tr) toggleVoiceover(tr.id);
  },
  snapPlayhead: () => store.setPlayhead(snapFrame(store.ui.playhead, seq().fps)),

  // ---- window / help
  maximizePanel: () => toggleMaximize(),
  showPanel: (id) => showPanel(id),
  workspace: (name) => applyWorkspace(name),
  uiScale: (v) => applyUiScale(v),
  resetLayout: () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('montage.split') || k.startsWith('montage.tab.')) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    location.reload();
  },
  shortcuts: () => openShortcutsDialog(),
  guide: () => openGuideDialog(),
  about: () => openAboutDialog(),
};

export { importFiles };

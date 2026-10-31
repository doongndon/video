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
  openSilenceCutDialog, openBeatDialog, openSlideshowDialog,
} from './ui/dialogs.js';
import { quickApi } from './ui/quick-panel.js';
import { aiApi } from './ui/ai-panel.js';
import {
  openPasteAttributesDialog, openRemoveAttributesDialog, openFrameHoldOptionsDialog, openMarkerEditor, openAddTracksDialog, openDeleteTracksDialog,
} from './ui/timeline-dialogs.js';

const inSource = () => store.ui.focusPanel === 'source' && sourceApi.hasMedia?.();
const seq = () => store.seq;
const sel = () => store.selectedClips();
const selIds = () => [...store.selection.clips];

function seekEdit(dir, allTracks = false) {
  playback.stop();
  const t = store.ui.playhead;
  const targeted = seq().tracks.filter((tr) => tr.targeted).map((tr) => tr.id);
  const pts = editPoints(seq(), targeted.length && !allTracks ? targeted : null);
  const target = dir < 0 ? pts.filter((p) => p < t - EPS).pop() : pts.find((p) => p > t + EPS);
  if (target != null) store.setPlayhead(target);
}

function seekMarker(dir) {
  const t = store.ui.playhead;
  const list = seq().markers.map((m) => m.time).sort((a, b) => a - b);
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

/** The clip a clip command works on: a selected clip under the playhead, else the first selected one. */
function clipAtPlayhead(filter = () => true) {
  const t = store.ui.playhead;
  const list = sel().filter(filter);
  return list.find((c) => c.start <= t + EPS && clipEnd(c) > t + EPS) || list[0]
    || Object.values(seq().clips).find((c) => filter(c) && seq().tracks.find((tr) => tr.id === c.trackId)?.targeted && c.start <= t + EPS && clipEnd(c) > t + EPS) || null;
}

/** 다음으로 바꾸기 ▸ 소스 모니터 (match: 일치하는 프레임) / 저장소 항목. */
function replaceWith(from, { match = false } = {}) {
  const ids = selIds();
  if (!ids.length) return toast('바꿀 타임라인 클립을 먼저 선택하세요');
  let mid = null;
  if (from === 'source') mid = store.ui.sourceMediaId;
  else mid = [...store.ui.selectedMedia].find((id) => store.project.media[id]);
  if (!mid) return toast(from === 'source' ? '소스 모니터에 클립을 먼저 여세요' : '프로젝트 패널에서 바꿀 항목을 먼저 선택하세요');
  const m = store.project.media[mid];
  const opts = {};
  if (from === 'source') {
    opts.inPoint = m.inPoint ?? 0;
    if (match) {
      const srcTime = sourceApi.currentTime?.();
      if (srcTime == null) return toast('소스 모니터 위치를 알 수 없습니다');
      opts.matchAt = { seqTime: store.ui.playhead, srcTime };
    }
  }
  edit.replaceClipMedia([...edit.withLinked(ids)], mid, opts);
}

/** M: a clip marker on the selected clips under the playhead (as in Premiere), otherwise a sequence marker. */
function addMarkerHere(props = {}) {
  const t = store.ui.playhead;
  const onClips = sel().filter((c) => c.start <= t + EPS && clipEnd(c) >= t - EPS).map((c) => c.id);
  if (onClips.length && !props.type) {
    const ids = edit.addClipMarker(onClips, t, props);
    if (ids.length) toast('선택한 클립에 클립 마커를 넣었습니다 (시퀀스 마커: 선택 해제 후 M)');
    return;
  }
  const id = edit.addMarker(t, props);
  if (!id && props.type) toast('이 위치에는 이미 마커가 있습니다');
  return id;
}

/** Marker at the playhead: sequence markers first, then clip markers of clips there. */
function markerAtPlayhead() {
  const s = seq();
  const t = store.ui.playhead;
  const tol = 0.5 / s.fps;
  const mk = s.markers.find((m) => Math.abs(m.time - t) < tol || (m.duration > 0 && t >= m.time - tol && t <= m.time + m.duration + tol));
  if (mk) return mk.id;
  for (const c of Object.values(s.clips)) {
    // clip markers a trim has hidden (outside the clip) do not count
    const cm = c.markers?.find((m) => m.time >= -tol && m.time <= c.duration + tol && Math.abs(c.start + m.time - t) < tol);
    if (cm) return cm.id;
  }
  return null;
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
  frameToPhoto: async () => {
    playback.stop();
    toast('현재 프레임을 사진 편집으로 보내는 중…');
    const { exportFrameCanvas } = await import('./export.js');
    const { openInPhoto } = await import('./mode.js');
    const { formatTimecode } = await import('./util.js');
    const canvas = await exportFrameCanvas();
    await openInPhoto(canvas, `${seq().name || '프레임'} ${formatTimecode(store.ui.playhead, seq().fps).replace(/:/g, '-')}`);
  },
  photoMode: () => import('./mode.js').then(({ setMode }) => setMode('photo')),
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
    openPasteAttributesDialog(cb.clips, selIds());
  },
  removeAttributes: () => {
    if (!sel().length) return toast('클립을 먼저 선택하세요');
    openRemoveAttributesDialog(selIds());
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
    const t = store.ui.playhead;
    const c = clipAtPlayhead((x) => x.kind === 'video');
    if (!c) return toast('영상 클립을 선택하세요');
    // the frame under the playhead is held, so the playhead has to be over the clip (as in Premiere)
    if (t < c.start - EPS || t >= clipEnd(c) - EPS) return toast('재생헤드를 고정할 프레임(영상 클립 위)에 두세요');
    edit.addFrameHold(c);
  },
  frameHoldSegment: () => {
    const t = store.ui.playhead;
    const c = clipAtPlayhead((x) => x.kind === 'video');
    if (!c || t < c.start - EPS || t > clipEnd(c) + EPS) return toast('재생헤드를 영상 클립 위에 두고 클립을 선택하세요');
    edit.insertFrameHoldSegment(c, t, 2);
  },
  frameHoldOptions: () => {
    const ids = sel().filter((x) => x.kind === 'video').map((x) => x.id);
    if (!ids.length) return toast('영상 클립을 선택하세요');
    openFrameHoldOptionsDialog(ids);
  },
  extendEdit: () => edit.extendToPlayhead(),
  group: () => edit.groupClips(selIds()),
  ungroup: () => edit.ungroupClips(selIds()),
  replaceFromSource: () => replaceWith('source'),
  replaceFromSourceMatch: () => replaceWith('source', { match: true }),
  replaceFromBin: () => replaceWith('bin'),
  newSequenceFromClip: () => {
    const mid = [...store.ui.selectedMedia].find((id) => store.project.media[id] && !['sequence', 'lut', 'font'].includes(store.project.media[id].kind))
      || sel().find((c) => c.mediaId && !['sequence', 'lut', 'font'].includes(store.project.media[c.mediaId]?.kind))?.mediaId;
    if (!mid) return toast('프로젝트 패널이나 타임라인에서 클립을 먼저 선택하세요');
    edit.newSequenceFromMedia(mid);
  },
  setToFrameSize: () => {
    const ids = sel().filter((c) => c.effects.some((e) => e.type === 'motion')).map((c) => c.id);
    if (!ids.length) return toast('영상·이미지 클립을 선택하세요');
    edit.setClipsToFrameSize(ids, '프레임 크기로 설정');
  },
  scaleToFrameSize: () => {
    const ids = sel().filter((c) => c.effects.some((e) => e.type === 'motion')).map((c) => c.id);
    if (!ids.length) return toast('영상·이미지 클립을 선택하세요');
    edit.setClipsToFrameSize(ids, '프레임 크기로 비율 조정');
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
  silenceCut: () => openSilenceCutDialog(),
  beatMarkers: () => openBeatDialog(),
  slideshow: () => openSlideshowDialog(),
  quick: (section) => {
    showPanel('quick');
    quickApi.show?.(section);
  },
  ai: (section) => {
    showPanel('ai');
    if (section) aiApi.show?.(section);
  },
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
  addTracks: () => openAddTracksDialog(),
  deleteTracks: () => openDeleteTracksDialog(),
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
  addMarker: () => addMarkerHere(),
  addChapterMarker: () => {
    const id = addMarkerHere({ type: 'chapter', name: '챕터', color: '#f87171' });
    if (id) openMarkerEditor(id);
  },
  clearSelectedMarker: () => {
    const id = markerAtPlayhead();
    if (id) edit.removeMarker(id);
    else toast('재생헤드 위치에 마커가 없습니다');
  },
  markSelection: () => {
    const list = sel();
    if (!list.length) return toast('클립을 먼저 선택하세요');
    store.transact('선택 항목 표시', () => {
      seq().inPoint = Math.min(...list.map((c) => c.start));
      seq().outPoint = Math.max(...list.map((c) => clipEnd(c)));
    });
  },
  nextMarker: () => seekMarker(1),
  prevMarker: () => seekMarker(-1),
  editMarker: () => {
    const id = markerAtPlayhead();
    if (id) openMarkerEditor(id);
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
  prevEditAll: () => seekEdit(-1, true),
  nextEditAll: () => seekEdit(1, true),
  setTool: (id) => store.setTool(id),
  trackHeights: (which, dir) => timelineApi.trackHeights?.(which, dir),
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
  resetLayout: async () => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('montage.split') || k.startsWith('montage.tab.')) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    // the page reloads: save the latest edits first (the autosave waits a moment after each edit)
    await saveProjectNow().catch(() => {});
    await import('./mode.js').then((m) => m.appMode.P?.saveNow?.()).catch(() => {});
    location.reload();
  },
  shortcuts: () => openShortcutsDialog(),
  guide: () => openGuideDialog(),
  about: () => openAboutDialog(),
};

export { importFiles };

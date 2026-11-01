// Timeline panel: canvas-rendered tracks with all editing tools, DOM track headers.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { runtime, mediaEvents, mediaStatus, importFiles } from '../media.js';
import * as edit from '../edit.js';
import {
  clipEnd, clipsOnTrack, videoTracks, audioTracks, getTrack, sequenceDuration, transitionsOnTrack,
  mediaTimeAt, linkedClips, prevAdjacent, nextAdjacent, editPoints, isAnimated, isTimed, hasSpeedRamp, LABEL_COLORS,
  evalParam, newKey, KF_INTERP, kfInterp, setKeyInterp, contentTime, MARKER_COLORS,
} from '../model.js';
import { EFFECTS, TRANSITIONS } from '../effects.js';
import { h, clamp, EPS, formatTimecode, parseTimecode, snapFrame, dbToGain, modKey } from '../util.js';
import { showMenu, loadPref, savePref, fitCanvasToBox, promptDialog, toast, dnd, inlineEdit, uiScale } from './common.js';
import { openSpeedDialog, openExtractAudioDialog } from './dialogs.js';
import {
  openMarkerEditor, openPasteAttributesDialog, openRemoveAttributesDialog, openFrameHoldOptionsDialog, openAddTracksDialog, openDeleteTracksDialog,
} from './timeline-dialogs.js';
import { icon, iconButton } from './icons.js';
import { toggleVoiceover, recordingTrack } from '../recorder.js';
import { getPreset, applyPreset } from './presets.js';

const RULER_H = 34;
const MIN_TRACK_H = 24;
const MAX_TRACK_H = 320;
const DIVIDER_H = 6;
const SNAP_PX = 8;
const EDGE_PX = 7;
const EDGE_PX_TOUCH = 18;
const COARSE = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

const COLORS = {
  video: ['#5d5fb8', '#8487e6'],
  image: ['#7a5bb8', '#a284e6'],
  audio: ['#2f7d55', '#4fb183'],
  text: ['#a1518a', '#d07ab8'],
  color: ['#2f7680', '#53a9b5'],
  adjustment: ['#9a5f3c', '#cf8a5f'],
  shape: ['#a1518a', '#d07ab8'],
  nest: ['#6b7d2a', '#93a94a'],
};

export const timelineApi = {};

/** Canvas font sizes follow the UI size setting (보기 ▸ 화면 크기). */
let SC = uiScale();
const fpx = (n) => Math.round(n * SC);

function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

export function createTimeline() {
  const view = {
    pps: loadPref('tl.pps', 40),
    scrollX: 0,
    scrollY: 0,
    th: loadPref('tl.trackH', COARSE ? 58 : 50),
    trackH: loadPref('tl.trackHeights', {}), // per-track heights (track id → px), dragged in the headers
    showThumbs: loadPref('tl.thumbs', true),
    showWaves: loadPref('tl.waves', true),
    // 타임라인 표시 설정
    showKf: loadPref('tl.showKf', { video: true, audio: true }),
    showNames: loadPref('tl.showNames', { video: true, audio: true }),
    autoScroll: loadPref('tl.autoScroll', 'page'), // 타임라인 재생 자동 스크롤: page | smooth | none
    rows: [],
    contentH: 0,
    width: 0,
    height: 0,
  };
  let drag = null; // active pointer interaction
  let edgePx = EDGE_PX; // wider edge zones for fingers
  const touches = new Map(); // active touch points (pinch zoom)
  let longPress = null;
  let lastPointerType = 'mouse';
  let hover = null;
  let dropPreview = null;
  let staticDirty = true;
  let selKey = null; // selected clip keyframe on a rubber band: { clipId, fxId, key, t }

  // ---------------------------------------------------------------- DOM
  const tcEl = h('span.tc', { title: '클릭해서 시간 입력 (+15처럼 쓰면 15프레임 앞으로)' }, '00:00:00:00');
  const seqName = h('span.seq-info');
  const snapBtn = iconButton('magnet', '스냅: 클립이 편집점·재생헤드에 달라붙기 (S)', () => toggleSnap(), { label: '스냅' });
  const linkBtn = iconButton('link', '연결된 선택: 영상과 소리를 함께 선택', () => { store.ui.linkedSelection = !store.ui.linkedSelection; refreshTopBar(); }, { label: '연결 선택' });
  const markerBtn = iconButton('marker', '마커 추가 (M)', () => edit.addMarker());
  const razorBtn = iconButton('scissors', '재생헤드 위치에서 자르기 (Ctrl+K)', () => edit.addEdit(), { label: '자르기' });
  const zoomOutBtn = iconButton('zoomOut', '타임라인 축소 (-)', () => timelineApi.zoomOut());
  const zoomInBtn = iconButton('zoomIn', '타임라인 확대 (=)', () => timelineApi.zoomIn());
  const settingsBtn = iconButton('gear', '타임라인 표시 설정', (e) => showSettingsMenu(e));
  const top = h('div.tl-top', tcEl, seqName, h('span.grow'), razorBtn, snapBtn, linkBtn, markerBtn, zoomOutBtn, zoomInBtn, settingsBtn);
  const seqTabs = h('div.seq-tabs');

  const headersInner = h('div.tl-headers-inner');
  const rulerSpacer = h('div.tl-ruler-spacer', h('span', '트랙'));
  const headers = h('div.tl-headers', rulerSpacer, headersInner);
  const canvas = h('canvas', { tabindex: 0 });
  const vscroll = h('div.tl-vscroll', h('div'));
  const wrap = h('div.tl-canvas-wrap', canvas, vscroll);
  const main = h('div.tl-main', headers, wrap);
  const hscroll = h('div.tl-hscroll', h('div'));
  const zoomSlider = h('input', { type: 'range', min: 0, max: 1000, step: 1, title: '타임라인 확대/축소', 'aria-label': '타임라인 확대/축소' });
  const durEl = h('span', { style: { color: 'var(--text-faint)' } });
  const bottom = h('div.tl-bottom', icon('zoomOut'), zoomSlider, icon('zoomIn'), h('span.grow'), durEl);
  const root = h('div.timeline', seqTabs, top, main, h('div.tl-hscroll-wrap', hscroll), bottom);

  const staticCanvas = document.createElement('canvas');

  // ---------------------------------------------------------------- geometry
  const xOf = (t) => t * view.pps - view.scrollX;
  const tOf = (x) => (x + view.scrollX) / view.pps;
  const fps = () => store.seq.fps;

  const heightOf = (t) => clamp(Math.round(view.trackH[t.id] ?? view.th), MIN_TRACK_H, MAX_TRACK_H);

  function layoutRows() {
    const s = store.seq;
    const rows = [];
    let y = 0;
    for (const t of videoTracks(s).slice().reverse()) {
      const th = heightOf(t);
      rows.push({ track: t, y, h: th });
      y += th;
    }
    view.dividerY = y;
    y += DIVIDER_H;
    for (const t of audioTracks(s)) {
      const th = heightOf(t);
      rows.push({ track: t, y, h: th });
      y += th;
    }
    view.rows = rows;
    view.contentH = y;
  }

  const rowY = (row) => RULER_H + row.y - view.scrollY;
  const rowOfTrack = (id) => view.rows.find((r) => r.track.id === id);
  function rowAtY(y) {
    const cy = y - RULER_H + view.scrollY;
    return view.rows.find((r) => cy >= r.y && cy < r.y + r.h) || null;
  }

  function maxScrollX() {
    const dur = Math.max(sequenceDuration(store.seq), 30);
    return Math.max(0, (dur + 30) * view.pps - view.width + 40);
  }

  function setScrollX(px) {
    view.scrollX = clamp(px, 0, Math.max(maxScrollX(), view.scrollX, px > 0 ? px : 0));
    if (view.scrollX < 0) view.scrollX = 0;
    syncScrollbars();
    invalidate();
  }

  function setScrollY(px) {
    const max = Math.max(0, view.contentH - (view.height - RULER_H) + 20);
    view.scrollY = clamp(px, 0, max);
    syncScrollbars();
    renderHeaders();
    invalidate();
  }

  function setZoom(pps, anchorX = view.width / 2) {
    const tAnchor = tOf(anchorX);
    view.pps = clamp(pps, 0.2, 3000);
    savePref('tl.pps', view.pps);
    view.scrollX = Math.max(0, tAnchor * view.pps - anchorX);
    syncScrollbars();
    invalidate();
  }

  function zoomToFit() {
    const dur = Math.max(1, sequenceDuration(store.seq));
    view.pps = clamp((view.width - 60) / dur, 0.2, 3000);
    view.scrollX = 0;
    syncScrollbars();
    invalidate();
  }

  let syncing = false;
  function syncScrollbars() {
    syncing = true;
    const total = Math.max(maxScrollX(), view.scrollX) + view.width;
    hscroll.firstChild.style.width = `${total}px`;
    hscroll.scrollLeft = view.scrollX;
    vscroll.firstChild.style.height = `${view.contentH + 20}px`;
    vscroll.scrollTop = view.scrollY;
    const z = Math.log(view.pps / 0.2) / Math.log(3000 / 0.2);
    zoomSlider.value = String(Math.round(z * 1000));
    syncing = false;
  }
  hscroll.addEventListener('scroll', () => {
    if (syncing) return;
    view.scrollX = hscroll.scrollLeft;
    invalidate();
  });
  vscroll.addEventListener('scroll', () => {
    if (syncing) return;
    view.scrollY = vscroll.scrollTop;
    renderHeaders();
    invalidate();
  });
  zoomSlider.addEventListener('input', () => {
    const z = Number(zoomSlider.value) / 1000;
    const px = xOf(store.ui.playhead);
    setZoom(0.2 * Math.pow(3000 / 0.2, z), px >= 0 && px <= view.width ? px : view.width / 2);
  });

  // ---------------------------------------------------------------- headers
  function renderHeaders() {
    headersInner.replaceChildren();
    headersInner.style.top = `${RULER_H - view.scrollY}px`;
    headersInner.style.height = `${view.contentH}px`;
    const s = store.seq;
    const anySolo = audioTracks(s).some((t) => t.solo);
    const list = (kind) => (kind === 'video' ? videoTracks(s) : audioTracks(s));
    const hasPatch = (kind) => list(kind).some((x) => x.patched);
    for (const row of view.rows) {
      const t = row.track;
      // source patching (Premiere's V1 / A1 source indicators): where insert / overwrite from the source go
      const patchedHere = !s.patchOff?.[t.kind] && (t.patched || (!hasPatch(t.kind) && edit.sourceTrack(t.kind)?.id === t.id));
      const srcIdx = list(t.kind).findIndex((x) => x.id === t.id) + 1;
      const patch = h(`button.src-patch${patchedHere ? '.on' : ''}`, {
        title: `소스 패치: 소스에서 삽입(,)·덮어쓰기(.)할 때 ${t.kind === 'video' ? '영상' : '소리'}이 들어갈 트랙입니다. 클릭해서 이 트랙으로 옮기고, 켜진 표시를 다시 누르면 끕니다.`,
        'aria-pressed': String(patchedHere), onclick: () => edit.setSourcePatch(t.id),
      }, patchedHere ? `${t.kind === 'video' ? 'V' : 'A'}${srcIdx}` : '');
      const lockBtn = h(`button.lock${t.locked ? '.on' : ''}`, { title: t.locked ? '트랙 잠금 풀기' : '트랙 잠그기 (편집 막기)', 'aria-pressed': String(!!t.locked), onclick: () => edit.setTrackFlag(t.id, 'locked') }, icon(t.locked ? 'lock' : 'unlock'));
      const name = h(`span.tname${t.targeted ? '.targeted' : ''}`, { title: '트랙 대상 지정: 붙여넣기·편집점 추가·편집점 이동이 이 트랙에 적용됩니다 (클릭해서 켜기/끄기)', 'aria-pressed': String(!!t.targeted), onclick: () => edit.setTrackFlag(t.id, 'targeted') }, t.name);
      const items = [patch, lockBtn, name];
      if (t.kind === 'video') {
        items.push(h(`button.eye${t.hidden ? '.on' : ''}`, { title: t.hidden ? '트랙 보이기' : '트랙 숨기기', 'aria-pressed': String(!!t.hidden), onclick: () => edit.setTrackFlag(t.id, 'hidden') }, icon(t.hidden ? 'eyeOff' : 'eye')));
      } else {
        items.push(h(`button.mute${t.muted ? '.on' : ''}`, { title: '음소거 (M)', 'aria-pressed': String(!!t.muted), onclick: () => edit.setTrackFlag(t.id, 'muted') }, 'M'));
        items.push(h(`button.solo${t.solo ? '.on' : ''}`, { title: '솔로: 이 트랙만 듣기 (S)', 'aria-pressed': String(!!t.solo), onclick: () => edit.setTrackFlag(t.id, 'solo') }, 'S'));
        const recOn = recordingTrack() === t.id;
        items.push(h(`button.rec${recOn ? '.on' : ''}`, { title: recOn ? '녹음 멈추기' : '보이스오버 녹음: 재생헤드부터 마이크로 녹음해 이 트랙에 넣기', 'aria-pressed': String(recOn), onclick: () => toggleVoiceover(t.id) }, icon(recOn ? 'record' : 'mic')));
        const vol = h('span.vol', { title: '트랙 볼륨 (좌우로 끌기 · 두 번 클릭: 0 dB)' }, `${(t.volume || 0).toFixed(1)}dB`);
        vol.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const x0 = e.clientX;
          const v0 = t.volume || 0;
          const tid = t.id;
          store.begin('트랙 볼륨');
          // every change rebuilds the headers, so follow the pointer on the window
          const move = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            const v = clamp(v0 + (ev.clientX - x0) * 0.2, -60, 12);
            edit.setTrackValue(tid, 'volume', Math.round(v * 10) / 10);
            store.changed();
          };
          const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            store.commit();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
          window.addEventListener('pointercancel', up);
        });
        vol.addEventListener('dblclick', () => {
          store.transact('트랙 볼륨', () => edit.setTrackValue(t.id, 'volume', 0));
        });
        items.push(vol);
        if (anySolo && !t.solo) name.style.opacity = '0.5';
      }
      const isFirstAudio = t.kind === 'audio' && audioTracks(s)[0].id === t.id;
      // drag the bottom edge of a header to change that track's height (video: top edge, as the lanes grow upwards)
      const grip = h('div.track-resize', { title: '끌어서 트랙 높이 바꾸기 · 두 번 클릭: 펼치기/접기' });
      grip.style.cssText = `position:absolute;left:0;right:0;height:6px;cursor:row-resize;z-index:1;${t.kind === 'video' ? 'top:-3px' : 'bottom:-3px'}`;
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const y0 = e.clientY;
        const h0 = row.h;
        // the headers are rebuilt while dragging, so follow the pointer on the window
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          const d = (ev.clientY - y0) * (t.kind === 'video' ? -1 : 1);
          view.trackH[t.id] = clamp(Math.round(h0 + d), MIN_TRACK_H, MAX_TRACK_H);
          layoutRows();
          renderHeaders();
          syncScrollbars();
          invalidate();
        };
        const up = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          saveTrackHeights();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleTrackExpanded(t);
      });
      const el = h(`div.track-header${isFirstAudio ? '.sep' : ''}`, { style: { top: `${row.y}px`, height: `${row.h}px` } }, ...items, grip);
      // double-click on the empty part of a header expands / collapses the track (Premiere)
      el.addEventListener('dblclick', (e) => {
        if (e.target === el) toggleTrackExpanded(t);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: '비디오 트랙 추가', action: () => edit.addTrack('video') },
          { label: '오디오 트랙 추가', action: () => edit.addTrack('audio') },
          { label: '트랙 추가…', action: () => openAddTracksDialog() },
          '-',
          { label: `${t.name} 트랙 삭제`, action: () => edit.deleteTrack(t.id) },
          { label: '트랙 삭제… (빈 트랙)', action: () => openDeleteTracksDialog() },
          '-',
          { label: '소스 패치를 이 트랙으로', checked: patchedHere, action: () => edit.setSourcePatch(t.id) },
          { label: '트랙 펼치기 / 접기', action: () => toggleTrackExpanded(t) },
          { label: '모든 트랙 확장', key: 'Shift+=', action: () => trackHeights('all', 1) },
          { label: '모든 트랙 최소화', key: 'Shift+-', action: () => trackHeights('all', -1) },
        ], e.clientX, e.clientY);
      });
      headersInner.append(el);
    }
  }

  function renderSeqTabs() {
    const p = store.project;
    seqTabs.replaceChildren();
    for (const id of p.mediaOrder) {
      const m = p.media[id];
      if (m?.kind !== 'sequence' || !p.sequences[m.sequenceId]) continue;
      const sid = m.sequenceId;
      const tab = h(`span.seq-tab${sid === p.activeSequenceId ? '.active' : ''}`, { title: '클릭: 열기 · 두 번 클릭: 이름 바꾸기 · 오른쪽 클릭: 메뉴' }, p.sequences[sid].multicam ? icon('multicam') : null, p.sequences[sid].name);
      tab.addEventListener('click', () => store.openSequence(sid));
      tab.addEventListener('dblclick', async () => {
        const n = await promptDialog('시퀀스 이름 바꾸기', '이름', p.sequences[sid].name);
        if (n) store.transact('시퀀스 이름 바꾸기', () => { store.project.sequences[sid].name = n; });
      });
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu([
          { label: '열기', action: () => store.openSequence(sid) },
          { label: '이름 바꾸기…', action: () => tab.dispatchEvent(new Event('dblclick')) },
          { label: '복제', action: () => edit.duplicateSequence(sid) },
          { label: '삭제', action: () => edit.deleteSequence(sid) },
        ], e.clientX, e.clientY);
      });
      seqTabs.append(tab);
    }
    seqTabs.append(iconButton('plus', '새 시퀀스', () => edit.newSequence()));
  }

  function refreshTopBar() {
    const s = store.seq;
    tcEl.textContent = formatTimecode(store.ui.playhead, s.fps);
    seqName.textContent = `${s.name} · ${s.width}×${s.height} · ${s.fps} fps`;
    snapBtn.classList.toggle('on', store.ui.snapping);
    snapBtn.setAttribute('aria-pressed', String(store.ui.snapping));
    linkBtn.classList.toggle('on', store.ui.linkedSelection);
    linkBtn.setAttribute('aria-pressed', String(store.ui.linkedSelection));
    durEl.textContent = `전체 길이 ${formatTimecode(sequenceDuration(s), s.fps)}`;
  }

  tcEl.addEventListener('click', () => {
    // absolute timecode, or +/- offset relative to the playhead (e.g. +15 = 15 frames)
    inlineEdit(tcEl, {
      width: '110px',
      onCommit: (v) => {
        let txt = v.trim();
        const rel = /^[+-]/.test(txt) ? txt[0] : null;
        if (rel) txt = txt.slice(1);
        const t = parseTimecode(txt, fps());
        if (t != null) store.setPlayhead(rel === '+' ? store.ui.playhead + t : rel === '-' ? store.ui.playhead - t : t);
        refreshTopBar();
      },
    });
  });

  function toggleSnap() {
    store.ui.snapping = !store.ui.snapping;
    refreshTopBar();
    toast(`스냅 ${store.ui.snapping ? '켬' : '끔'}`);
  }

  function showSettingsMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const flip = (obj, k, pref) => () => {
      view[obj][k] = !view[obj][k];
      savePref(pref, view[obj]);
      invalidate();
    };
    showMenu([
      { group: '트랙 높이' },
      { label: '작게', checked: view.th === 34, action: () => setTrackH(34) },
      { label: '보통', checked: view.th === 50, action: () => setTrackH(50) },
      { label: '크게', checked: view.th === 80, action: () => setTrackH(80) },
      { label: '아주 크게', checked: view.th === 120, action: () => setTrackH(120) },
      { label: '모든 트랙 확장', key: 'Shift+=', action: () => trackHeights('all', 1) },
      { label: '모든 트랙 최소화', key: 'Shift+-', action: () => trackHeights('all', -1) },
      '-',
      { label: '비디오 축소판 표시', checked: view.showThumbs, action: () => { view.showThumbs = !view.showThumbs; savePref('tl.thumbs', view.showThumbs); invalidate(); } },
      { label: '비디오 키프레임 표시', checked: view.showKf.video, action: flip('showKf', 'video', 'tl.showKf') },
      { label: '비디오 이름 표시', checked: view.showNames.video, action: flip('showNames', 'video', 'tl.showNames') },
      { label: '오디오 파형 표시', checked: view.showWaves, action: () => { view.showWaves = !view.showWaves; savePref('tl.waves', view.showWaves); invalidate(); } },
      { label: '오디오 키프레임 표시', checked: view.showKf.audio, action: flip('showKf', 'audio', 'tl.showKf') },
      { label: '오디오 이름 표시', checked: view.showNames.audio, action: flip('showNames', 'audio', 'tl.showNames') },
      { label: '재생헤드 끌 때 소리 듣기 (오디오 스크러빙)', checked: store.ui.audioScrub, action: () => { store.ui.audioScrub = !store.ui.audioScrub; } },
      { label: '타임라인 재생 자동 스크롤', submenu: () => [['page', '페이지 스크롤'], ['smooth', '부드러운 스크롤'], ['none', '스크롤 안 함']].map(([v, l]) => ({
        label: l, checked: view.autoScroll === v, action: () => { view.autoScroll = v; savePref('tl.autoScroll', v); },
      })) },
      '-',
      { label: '비디오 트랙 추가', action: () => edit.addTrack('video') },
      { label: '오디오 트랙 추가', action: () => edit.addTrack('audio') },
      { label: '간격 닫기', hint: '모든 빈 공간 메우기', action: () => edit.closeAllGaps() },
    ], r.left, r.bottom + 2);
  }

  function setTrackH(px) {
    view.th = px;
    view.trackH = {};
    savePref('tl.trackH', px);
    saveTrackHeights();
    relayout();
  }

  function relayout() {
    layoutRows();
    renderHeaders();
    syncScrollbars();
    invalidate();
  }

  function saveTrackHeights() {
    // only keep tracks that still exist somewhere in the project
    const ids = new Set(Object.values(store.project.sequences).flatMap((sq) => sq.tracks.map((t) => t.id)));
    for (const id of Object.keys(view.trackH)) if (!ids.has(id)) delete view.trackH[id];
    savePref('tl.trackHeights', view.trackH);
  }

  function toggleTrackExpanded(t) {
    const cur = heightOf(t);
    view.trackH[t.id] = cur < 80 ? Math.max(100, view.th * 2) : view.th;
    saveTrackHeights();
    relayout();
  }

  /** Taller (dir 1) / shorter (-1) tracks: which = 'all' | 'video' | 'audio' (Shift / Ctrl / Alt with = and -). */
  function trackHeights(which, dir) {
    for (const t of store.seq.tracks) {
      if (which !== 'all' && t.kind !== which) continue;
      const cur = heightOf(t);
      view.trackH[t.id] = clamp(Math.round(dir > 0 ? cur * 1.35 : cur / 1.35), MIN_TRACK_H, MAX_TRACK_H);
    }
    saveTrackHeights();
    relayout();
  }

  // ---------------------------------------------------------------- drawing

  function invalidate() {
    staticDirty = true;
    requestDraw();
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function draw() {
    const { ctx, w, h: hh, dpr } = fitCanvasToBox(canvas);
    if (w < 2 || hh < 2) return;
    if (view.width !== w || view.height !== hh) {
      view.width = w;
      view.height = hh;
      staticDirty = true;
      syncScrollbars();
    }
    if (staticDirty || staticCanvas.width !== canvas.width || staticCanvas.height !== canvas.height) {
      staticCanvas.width = canvas.width;
      staticCanvas.height = canvas.height;
      const sctx = staticCanvas.getContext('2d');
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(sctx, w, hh);
      staticDirty = false;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticCanvas, 0, 0);
    ctx.restore();
    drawDynamic(ctx, w, hh);
  }

  function drawStatic(ctx, W, H) {
    const s = store.seq;
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, W, H);

    // lanes
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, W, H - RULER_H);
    ctx.clip();
    for (const row of view.rows) {
      const y = rowY(row);
      if (y > H || y + row.h < RULER_H) continue;
      ctx.fillStyle = row.track.targeted ? '#262a30' : '#242424';
      ctx.fillRect(0, y, W, row.h - 1);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, y + row.h - 1, W, 1);
      if (row.track.locked) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = '#999';
        for (let x = -row.h; x < W; x += 10) {
          ctx.beginPath();
          ctx.moveTo(x, y + row.h);
          ctx.lineTo(x + row.h, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    const dy = RULER_H + view.dividerY - view.scrollY;
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, dy, W, DIVIDER_H);

    // in/out shading
    if (s.inPoint != null || s.outPoint != null) {
      const a = xOf(s.inPoint ?? 0);
      const b = xOf(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = 'rgba(90,140,220,0.07)';
      ctx.fillRect(a, RULER_H, b - a, H);
    }

    const dragIds = drag?.type === 'move' ? new Set(drag.ids) : null;
    // clips
    for (const row of view.rows) {
      const y = rowY(row);
      if (y > H || y + row.h < RULER_H) continue;
      for (const c of clipsOnTrack(s, row.track.id)) {
        const x0 = xOf(c.start);
        const x1 = xOf(clipEnd(c));
        if (x1 < 0 || x0 > W) continue;
        drawClip(ctx, c, x0, y + 1, x1 - x0, row.h - 3, { dim: dragIds?.has(c.id) && !drag.duplicate });
      }
      // transitions
      for (const tw of transitionsOnTrack(s, row.track.id)) {
        const x0 = xOf(tw.start);
        const x1 = xOf(tw.end);
        if (x1 < 0 || x0 > W) continue;
        const sel = store.selection.transition && store.selection.transition.clipId === tw.clip.id && store.selection.transition.edge === tw.edge;
        drawTransition(ctx, tw, x0, y + 1, Math.max(4, x1 - x0), Math.min(row.h - 3, 22), sel);
      }
    }

    // gap selection
    if (store.selection.gap) {
      const g = store.selection.gap;
      const row = rowOfTrack(g.trackId);
      if (row) {
        ctx.fillStyle = 'rgba(80,150,255,0.25)';
        ctx.fillRect(xOf(g.start), rowY(row) + 1, xOf(g.end) - xOf(g.start), row.h - 3);
      }
    }
    ctx.restore();

    drawRuler(ctx, W);
  }

  function drawClip(ctx, c, x, y, w, hh, { dim = false, ghost = false } = {}) {
    const selected = store.selection.clips.has(c.id);
    const [base, light] = c.label ? [c.label, lighten(c.label, 0.35)] : COLORS[c.kind] || COLORS.video;
    const offline = c.mediaId && ['offline', 'error', 'missing'].includes(mediaStatus(c.mediaId));
    ctx.save();
    ctx.globalAlpha = ghost ? 0.6 : dim ? 0.35 : 1;
    ctx.beginPath();
    ctx.rect(Math.max(-2, x), y, Math.min(w, view.width + 4 - Math.max(-2, x)), hh);
    ctx.clip();
    ctx.fillStyle = offline ? '#7a2222' : selected ? light : base;
    ctx.fillRect(x, y, w, hh);

    const nameH = Math.min(fpx(16), hh);
    const bodyY = y + nameH;
    const bodyH = hh - nameH;
    const m = c.mediaId ? store.project.media[c.mediaId] : null;
    const rt = c.mediaId ? runtime.get(c.mediaId) : null;

    // thumbnails
    if (c.kind === 'video' && view.showThumbs && rt?.filmstrip?.length && bodyH > 10 && w > 8) {
      const fs = rt.filmstrip;
      const aspect = fs[0].canvas.width / fs[0].canvas.height;
      const tw = Math.max(16, bodyH * aspect);
      const startI = Math.max(0, Math.floor((0 - x) / tw));
      for (let i = startI; x + i * tw < Math.min(x + w, view.width); i++) {
        const tx = x + i * tw;
        const tm = mediaTimeAt(c, tOf(tx + tw / 2));
        let best = fs[0];
        for (const f of fs) if (Math.abs(f.t - tm) < Math.abs(best.t - tm)) best = f;
        ctx.drawImage(best.canvas, tx, bodyY, tw, bodyH);
      }
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)';
      ctx.fillRect(x, bodyY, w, bodyH);
    } else if ((c.kind === 'image') && rt?.thumb && bodyH > 10) {
      const tw = Math.max(16, (bodyH * rt.thumb.width) / rt.thumb.height);
      ctx.drawImage(rt.thumb, x, bodyY, tw, bodyH);
    }

    // waveform
    if (c.kind === 'audio' && view.showWaves && rt?.peaks && bodyH > 6) {
      const { data, rate } = rt.peaks;
      const mid = bodyY + bodyH / 2;
      const amp = bodyH / 2 - 1;
      const vol = c.effects.find((e) => e.type === 'volume');
      ctx.fillStyle = selected ? 'rgba(10,40,25,0.75)' : 'rgba(170,240,200,0.75)';
      const px0 = Math.max(Math.floor(x), 0);
      const px1 = Math.min(Math.ceil(x + w), view.width);
      for (let px = px0; px < px1; px++) {
        const ta = tOf(px);
        const tb = tOf(px + 1);
        if (c.hold) break;
        let ia = Math.floor(mediaTimeAt(c, ta) * rate);
        let ib = Math.floor(mediaTimeAt(c, tb) * rate);
        if (ia > ib) [ia, ib] = [ib, ia];
        let v = 0;
        for (let i = Math.max(0, ia); i <= Math.min(data.length - 1, Math.max(ia, ib)); i++) if (data[i] > v) v = data[i];
        const g = (vol ? dbToGain(evalParam(vol.params.level, ta - c.start)) : 1) * dbToGain(c.gain || 0); // 오디오 게인 shows in the waveform
        const a = Math.min(amp, v * g * amp);
        if (a > 0.3) ctx.fillRect(px, mid - a, 1, a * 2);
      }
    }

    // clip keyframes: the rubber band of the chosen value (불투명도 / 볼륨 by default) with its keyframes
    const band = !ghost && bodyH > 14 ? bandOf(c) : null;
    if (band) drawBand(ctx, c, band, x, w, bodyY, bodyH);

    // text preview
    if (c.kind === 'text' && bodyH > 10) {
      const fx = c.effects.find((e) => e.type === 'text');
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${fpx(12)}px "Noto Sans KR", sans-serif`;
      ctx.fillText(`T  ${String(fx?.params.content.value || '').replace(/\n/g, ' ')}`, Math.max(x, 0) + 4, bodyY + Math.min(bodyH - 3, fpx(14)));
    }
    if (c.kind === 'color' && bodyH > 6) {
      const fx = c.effects.find((e) => e.type === 'fill');
      ctx.fillStyle = fx?.params.color.value || '#000';
      ctx.fillRect(x + 3, bodyY + 2, Math.min(24, w - 6), bodyH - 4);
    }

    // name bar
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x, y, w, nameH);
    let labelX = Math.max(x, 0) + 3;
    const userFx = c.effects.filter((e) => !EFFECTS[e.type]?.fixed);
    const anyKf = c.effects.some((e) => Object.values(e.params).some((p) => p.kf?.length));
    if (w > 22) {
      ctx.fillStyle = userFx.length ? '#e8c547' : anyKf ? '#9fc5ff' : 'rgba(255,255,255,0.35)';
      ctx.font = `italic bold ${fpx(11)}px serif`;
      ctx.fillText('fx', labelX, y + nameH - fpx(4));
      labelX += fpx(15);
    }
    ctx.fillStyle = '#fff';
    ctx.font = `${fpx(12)}px "Noto Sans KR", system-ui, sans-serif`;
    const showName = view.showNames[c.kind === 'audio' ? 'audio' : 'video'];
    let label = showName ? c.name || m?.name || c.kind : '';
    if (c.multicam) label = `[앵글 ${c.multicam.angle}] ${label}`;
    if (c.hold) label += ' [정지]';
    else if (c.speed !== 1 || c.reverse) label += ` [${c.reverse ? '역 ' : ''}${Math.round(c.speed * 100)}%]`;
    if (hasSpeedRamp(c)) label += ' [속도 램프]';
    if (c.stab) label += ' [손떨림 보정]';
    if (c.groupId) label = `[그룹] ${label}`;
    if (offline) label = `미디어 오프라인 · ${label}`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(labelX, y, Math.max(0, x + w - labelX - 3), nameH);
    ctx.clip();
    ctx.fillText(label, labelX, y + nameH - fpx(4));
    ctx.restore();

    // clip markers
    for (const mk of c.markers || []) {
      if (mk.time < -EPS || mk.time > c.duration + EPS) continue;
      const mx = xOf(c.start + mk.time);
      ctx.fillStyle = mk.color || '#4ade80';
      if (mk.duration > 0) {
        ctx.globalAlpha = (ghost ? 0.6 : 1) * 0.45;
        ctx.fillRect(mx, y + 1, Math.max(2, mk.duration * view.pps), Math.min(6, nameH - 2));
        ctx.globalAlpha = ghost ? 0.6 : dim ? 0.35 : 1;
      }
      ctx.beginPath();
      ctx.moveTo(mx - 4, y + 1);
      ctx.lineTo(mx + 4, y + 1);
      ctx.lineTo(mx + 4, y + 6);
      ctx.lineTo(mx, y + 10);
      ctx.lineTo(mx - 4, y + 6);
      ctx.closePath();
      ctx.fill();
    }

    // edges
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    if (selected && COARSE && w > 30 && !ghost) {
      // finger-sized trim handles on the selected clip
      ctx.fillStyle = '#ffffff';
      for (const hx of [x + 1, x + w - 9]) {
        ctx.fillRect(hx, y + 1, 8, hh - 2);
        ctx.fillStyle = '#1b1e23';
        ctx.fillRect(hx + 3, y + hh / 2 - 6, 2, 12);
        ctx.fillStyle = '#ffffff';
      }
    }
    if (c.enabled === false) {
      ctx.fillStyle = 'rgba(30,30,30,0.6)';
      ctx.fillRect(x, y, w, hh);
    }
    // in/out handle hints
    if (m && Number.isFinite(m.duration) && isTimed(c) && !c.hold) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      if (c.inPoint < 1e-3) ctx.fillRect(x, y, 3, 3);
      if (Math.abs(c.inPoint + c.duration * c.speed - m.duration) < 1 / fps()) ctx.fillRect(x + w - 3, y, 3, 3);
    }
    ctx.restore();
  }

  function volumeY(db, bodyY, bodyH) {
    // map +15..-60 dB onto the clip body (0 dB at ~1/4 from top)
    const n = db >= 0 ? 0.25 - (db / 15) * 0.25 : 0.25 + (Math.min(60, -db) / 60) * 0.75;
    return bodyY + 2 + clamp(n, 0, 1) * (bodyH - 4);
  }

  function dbFromY(y, bodyY, bodyH) {
    const n = clamp((y - bodyY - 2) / (bodyH - 4), 0, 1);
    return n <= 0.25 ? ((0.25 - n) / 0.25) * 15 : -((n - 0.25) / 0.75) * 60;
  }

  // ---------------------------------------------------------------- clip keyframes (rubber band)
  // Like Premiere, each clip shows one keyframable value as a line over its body: 불투명도 on video,
  // 볼륨 on audio, or what 클립 키프레임 표시 picks. Ctrl+click on the line or a click with the pen tool
  // adds a keyframe; keyframes and the line can be dragged; Ctrl+click on a keyframe toggles 선형 /
  // 자동 베지어; right-click on a keyframe sets its interpolation.

  /** Keyframable numbers of a clip: [{ fx, key, def, fxName }]. */
  function bandChoices(c) {
    const out = [];
    for (const fx of c.effects) {
      const def = EFFECTS[fx.type];
      for (const p of def?.params || []) {
        if (p.type === 'number' && p.animatable !== false && fx.params[p.key]) out.push({ fx, key: p.key, def: p, fxName: def.name });
      }
    }
    return out;
  }

  /** The value a clip's rubber band shows: { fx, key, p, def, db, lo, hi, label } or null. */
  function bandOf(c, { force = false } = {}) {
    if (!force && !view.showKf[c.kind === 'audio' ? 'audio' : 'video']) return null;
    const choices = bandChoices(c);
    let ch = c.band && choices.find((x) => x.fx.type === c.band.type && x.key === c.band.key);
    if (!ch) ch = choices.find((x) => (c.kind === 'audio' ? x.fx.type === 'volume' && x.key === 'level' : x.fx.type === 'opacity' && x.key === 'opacity'));
    if (!ch) return null;
    const p = ch.fx.params[ch.key];
    const db = ch.fx.type === 'volume' && ch.key === 'level';
    let lo = ch.def.min;
    let hi = ch.def.max;
    if (!(Number.isFinite(lo) && Number.isFinite(hi)) || hi - lo > 1000) {
      // unbounded values (position, size…): a range around the values in use
      const vals = [p.value, ...(p.kf || []).map((k) => k.v)].filter((v) => typeof v === 'number');
      let a = Math.min(...vals);
      let b = Math.max(...vals);
      const pad = Math.max((b - a) * 0.35, Math.abs(b) * 0.35, 10);
      a -= pad;
      b += pad;
      if (Number.isFinite(ch.def.min)) a = Math.max(a, ch.def.min);
      if (Number.isFinite(ch.def.max)) b = Math.min(b, ch.def.max);
      lo = a;
      hi = b > a ? b : a + 1;
    }
    // 시간 다시 매핑 ▸ 속도 as in Premiere: 100 % across the middle of the clip, 10 % at the bottom
    // and 1000 % at the top (a logarithmic scale, so slow and fast stretches are equally easy to drag)
    const log = ch.fx.type === 'timeRemap' && ch.key === 'speed';
    if (log) {
      lo = 10;
      hi = 1000;
    }
    return { fx: ch.fx, key: ch.key, p, def: ch.def, db, log, lo, hi, label: `${ch.fxName} ▸ ${ch.def.label}` };
  }

  const bandNorm = (b, v) => (b.log
    ? (Math.log10(Math.max(v, 1e-3)) - Math.log10(b.lo)) / (Math.log10(b.hi) - Math.log10(b.lo))
    : (v - b.lo) / (b.hi - b.lo));

  function bandY(b, v, bodyY, bodyH) {
    if (b.db) return volumeY(v, bodyY, bodyH);
    const n = 1 - clamp(bandNorm(b, v), 0, 1);
    return bodyY + 2 + n * (bodyH - 4);
  }

  function bandValue(b, y, bodyY, bodyH) {
    if (b.db) return clamp(Math.round(dbFromY(y, bodyY, bodyH) * 10) / 10, -60, 15);
    const n = clamp((y - bodyY - 2) / Math.max(1, bodyH - 4), 0, 1);
    if (b.log) {
      const lg = Math.log10(b.hi) - n * (Math.log10(b.hi) - Math.log10(b.lo));
      return clamp(Math.round(10 ** lg), b.def.min ?? -Infinity, b.def.max ?? Infinity);
    }
    const v = b.hi - n * (b.hi - b.lo);
    const step = b.hi - b.lo > 60 ? 1 : 0.1;
    return clamp(Math.round(v / step) * step, b.def.min ?? -Infinity, b.def.max ?? Infinity);
  }

  const bandColor = (c) => (c.kind === 'audio' ? '#f0d050' : '#f4f4f4');

  function drawBand(ctx, c, band, x, w, bodyY, bodyH) {
    const p = band.p;
    ctx.save();
    ctx.strokeStyle = bandColor(c);
    ctx.globalAlpha *= c.kind === 'audio' ? 1 : 0.85;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(x, -2);
    const x1 = Math.min(x + w, view.width + 2);
    const steps = isAnimated(p) ? Math.max(2, Math.min(400, Math.ceil((x1 - x0) / 3))) : 1;
    for (let i = 0; i <= steps; i++) {
      const px = x0 + ((x1 - x0) * i) / steps;
      const py = bandY(band, evalParam(p, tOf(px) - c.start), bodyY, bodyH);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (p.kf) {
      for (const k of p.kf) {
        if (k.t < -EPS || k.t > c.duration + EPS) continue;
        const px = xOf(c.start + k.t);
        const py = bandY(band, k.v, bodyY, bodyH);
        const isSel = selKey && selKey.clipId === c.id && selKey.fxId === band.fx.id && selKey.key === band.key && Math.abs(selKey.t - k.t) < 1e-6;
        drawKeyShape(ctx, px, py, kfInterp(k), isSel ? '#4aa3ff' : bandColor(c));
      }
    }
    ctx.restore();
  }

  /** Keyframe icon like Premiere: diamond = linear, circle = bezier kinds, square = hold, half shapes = ease. */
  function drawKeyShape(ctx, px, py, interp, fill) {
    const r = 4;
    ctx.fillStyle = fill;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    if (interp === 'hold') ctx.rect(px - r + 0.5, py - r + 0.5, 2 * r - 1, 2 * r - 1);
    else if (interp === 'bezier' || interp === 'autoBezier' || interp === 'continuousBezier') ctx.arc(px, py, r, 0, Math.PI * 2);
    else if (interp === 'easeIn') {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
      ctx.moveTo(px, py - r);
      ctx.arc(px, py, r, -Math.PI / 2, Math.PI / 2);
    } else if (interp === 'easeOut') {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px + r, py);
      ctx.closePath();
      ctx.moveTo(px, py + r);
      ctx.arc(px, py, r, Math.PI / 2, Math.PI * 1.5);
    } else {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  /** Clip body geometry inside a row (same numbers drawClip uses). */
  function clipBody(row) {
    const y = rowY(row) + 1;
    const hh = row.h - 3;
    const nameH = Math.min(fpx(16), hh);
    return { y, hh, nameH, bodyY: y + nameH, bodyH: hh - nameH };
  }

  function drawTransition(ctx, tw, x, y, w, hh, selected) {
    ctx.save();
    ctx.fillStyle = selected ? '#b98cf0' : '#8a63c7';
    ctx.globalAlpha = 0.92;
    ctx.fillRect(x, y, w, hh);
    ctx.strokeStyle = selected ? '#fff' : '#3c2a5a';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    if (tw.a && tw.b) {
      ctx.moveTo(x, y + hh);
      ctx.lineTo(x + w, y);
    } else if (tw.edge === 'in') {
      ctx.moveTo(x, y + hh);
      ctx.lineTo(x + w, y);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + hh);
    }
    ctx.stroke();
    if (w > 50) {
      ctx.fillStyle = '#fff';
      ctx.font = `${fpx(11)}px "Noto Sans KR", sans-serif`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y, w - 4, hh);
      ctx.clip();
      ctx.fillText(TRANSITIONS[tw.type]?.name || tw.type, x + 3, y + Math.min(hh - 4, fpx(13)));
      ctx.restore();
    }
    ctx.restore();
  }

  function rulerStep() {
    const f = fps();
    const candidates = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const c of candidates) if (c * view.pps >= fpx(92)) return c;
    return 3600;
  }

  function drawRuler(ctx, W) {
    const s = store.seq;
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, RULER_H - 1, W, 1);
    const step = rulerStep();
    const minor = step / 5;
    const t0 = Math.floor(tOf(0) / minor) * minor;
    ctx.strokeStyle = '#6a6a6a';
    ctx.fillStyle = '#a8a8a8';
    ctx.font = `${fpx(11)}px ui-monospace, Menlo, monospace`;
    ctx.beginPath();
    for (let t = Math.max(0, t0); xOf(t) < W; t += minor) {
      const x = Math.round(xOf(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, major ? 14 : 22);
      ctx.lineTo(x, RULER_H - 8);
      if (major) ctx.fillText(formatTimecode(t, s.fps), x + 3, 11);
    }
    ctx.stroke();
    // in/out on ruler
    if (s.inPoint != null || s.outPoint != null) {
      const a = xOf(s.inPoint ?? 0);
      const b = xOf(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = 'rgba(90,150,240,0.45)';
      ctx.fillRect(a, RULER_H - 8, b - a, 7);
      ctx.fillStyle = '#cfe2ff';
      if (s.inPoint != null) ctx.fillRect(a, RULER_H - 9, 2, 9);
      if (s.outPoint != null) ctx.fillRect(b - 2, RULER_H - 9, 2, 9);
    }
    // markers (range markers draw a bar over their length; chapter markers carry a notch)
    for (const mk of s.markers) {
      const x = xOf(mk.time);
      const x2 = mk.duration > 0 ? xOf(mk.time + mk.duration) : x;
      if (x2 < -10 || x > W + 10) continue;
      ctx.fillStyle = mk.color || '#4ade80';
      if (x2 > x) {
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, 14, x2 - x, 7);
        ctx.globalAlpha = 1;
      }
      if (mk.type === 'chapter' || mk.type === 'segmentation') {
        ctx.fillRect(x - 1, 8, 2, 6);
      }
      ctx.beginPath();
      ctx.moveTo(x - 5, 14);
      ctx.lineTo(x + 5, 14);
      ctx.lineTo(x + 5, 21);
      ctx.lineTo(x, 26);
      ctx.lineTo(x - 5, 21);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawDynamic(ctx, W, H) {
    const s = store.seq;
    // markers through tracks (thin)
    ctx.save();
    ctx.globalAlpha = 0.3;
    for (const mk of s.markers) {
      const x = Math.round(xOf(mk.time)) + 0.5;
      const x2 = mk.duration > 0 ? Math.round(xOf(mk.time + mk.duration)) + 0.5 : x;
      if (x2 < 0 || x > W) continue;
      ctx.strokeStyle = mk.color || '#4ade80';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      if (x2 !== x) {
        ctx.moveTo(x2, RULER_H);
        ctx.lineTo(x2, H);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // drag ghosts
    if (drag?.type === 'move' && drag.moved) {
      for (const g of drag.ghosts || []) {
        const row = rowOfTrack(g.trackId);
        if (!row) continue;
        const c = s.clips[g.id];
        if (!c) continue;
        drawClip(ctx, c, xOf(g.start), rowY(row) + 1, c.duration * view.pps, row.h - 3, { ghost: true });
      }
    }
    if (dropPreview) {
      for (const g of dropPreview.ghosts) {
        const row = rowOfTrack(g.trackId);
        if (!row) continue;
        ctx.fillStyle = dropPreview.replace ? 'rgba(255,190,80,0.35)' : 'rgba(120,160,255,0.35)';
        ctx.strokeStyle = dropPreview.replace ? '#ffc96b' : '#9fc5ff';
        const x = xOf(g.start);
        ctx.fillRect(x, rowY(row) + 1, g.duration * view.pps, row.h - 3);
        ctx.strokeRect(x + 0.5, rowY(row) + 1.5, g.duration * view.pps - 1, row.h - 4);
      }
      if (dropPreview.insert) {
        ctx.fillStyle = '#ffd34d';
        ctx.fillRect(xOf(dropPreview.start) - 1, RULER_H, 2, H);
      }
    }
    if (drag?.type === 'marquee' && drag.moved) {
      ctx.fillStyle = 'rgba(90,150,240,0.15)';
      ctx.strokeStyle = '#7fb0ff';
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    // selected edit point (Premiere's trim bracket: red, yellow for ripple; E extends it to the playhead)
    const ep = store.ui.editPoint;
    if (ep?.ids?.length && !(drag?.type === 'trim')) {
      ctx.fillStyle = ep.mode === 'ripple' ? '#ffd400' : '#ff4b4b';
      for (const id of ep.ids) {
        const c = s.clips[id];
        const row = c && rowOfTrack(c.trackId);
        if (!row) continue;
        const ex = Math.round(xOf(ep.edge === 'in' ? c.start : clipEnd(c)));
        if (ex < -6 || ex > W + 6) continue;
        const y0 = rowY(row) + 1;
        const hh = row.h - 3;
        const inside = ep.edge === 'in';
        ctx.fillRect(inside ? ex : ex - 3, y0, 3, hh);
        ctx.fillRect(inside ? ex : ex - 8, y0, 8, 3);
        ctx.fillRect(inside ? ex : ex - 8, y0 + hh - 3, 8, 3);
        // a rolling point covers both sides of the cut
        if (ep.mode === 'rolling') ctx.fillRect(inside ? ex - 3 : ex, y0, 3, hh);
      }
    }
    // razor preview
    if (hover?.razor != null) {
      ctx.strokeStyle = '#ff6b6b';
      ctx.setLineDash([4, 3]);
      const x = Math.round(xOf(hover.razor)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, hover.allTracks ? RULER_H : hover.y0);
      ctx.lineTo(x, hover.allTracks ? H : hover.y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // snap line
    if (drag?.snapAt != null) {
      const x = Math.round(xOf(drag.snapAt)) + 0.5;
      ctx.strokeStyle = '#ffe066';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    // trim tooltip
    if (drag?.tooltip) {
      ctx.font = `${fpx(12)}px "Noto Sans KR", ui-monospace, monospace`;
      const tw = ctx.measureText(drag.tooltip).width + 10;
      const tx = clamp(drag.tipX + 10, 0, W - tw);
      ctx.fillStyle = 'rgba(20,20,20,0.92)';
      ctx.fillRect(tx, drag.tipY - fpx(28), tw, fpx(20));
      ctx.fillStyle = '#fff';
      ctx.fillText(drag.tooltip, tx + 5, drag.tipY - fpx(13));
    }
    // playhead
    const px = Math.round(xOf(store.ui.playhead)) + 0.5;
    if (px >= -10 && px <= W + 10) {
      ctx.strokeStyle = '#4aa3ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, RULER_H - 10);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = '#4aa3ff';
      ctx.beginPath();
      ctx.moveTo(px - 6, 12);
      ctx.lineTo(px + 6, 12);
      ctx.lineTo(px + 6, 20);
      ctx.lineTo(px, 26);
      ctx.lineTo(px - 6, 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- hit testing

  /**
   * What is under (x, y). The rubber band (zones 'bandKey' / 'band') only counts for the tools that
   * edit it (selection, pen), so it never hides the trim zones from the ripple, rolling, rate stretch
   * or razor tools; `keys` makes keyframes count with any tool (right-click menu).
   */
  function hitTest(x, y, { keys = false } = {}) {
    if (y < RULER_H) return { area: 'ruler' };
    const bandTools = keys || store.ui.tool === 'select' || store.ui.tool === 'pen';
    const row = rowAtY(y);
    if (!row) return { area: 'empty' };
    const t = tOf(x);
    const s = store.seq;
    const ry = rowY(row);
    // transitions (drawn in the top part of the track)
    for (const tw of transitionsOnTrack(s, row.track.id)) {
      const x0 = xOf(tw.start);
      const x1 = Math.max(x0 + 4, xOf(tw.end));
      if (x >= x0 && x <= x1 && y >= ry && y <= ry + Math.min(row.h - 3, 22)) {
        return { area: 'transition', row, t, transition: tw };
      }
    }
    const clips = clipsOnTrack(s, row.track.id);
    for (const c of clips) {
      const x0 = xOf(c.start);
      const x1 = xOf(clipEnd(c));
      if (x < x0 - 1 || x > x1 + 1) continue;
      const w = x1 - x0;
      const ez = Math.min(edgePx, w / 3);
      const geo = clipBody(row);
      // clip markers in the name bar (markers a trim has hidden do not count)
      if (y <= geo.y + 11) {
        const mk = (c.markers || []).find((m) => m.time >= -EPS && m.time <= c.duration + EPS && Math.abs(xOf(c.start + m.time) - x) <= 5);
        if (mk) return { area: 'clip', row, t, clip: c, zone: 'marker', marker: mk };
      }
      // keyframes on the rubber band win over the trim zones (a key often sits on the clip's first frame)
      const band = geo.bodyH > 14 && bandTools ? bandOf(c) : null;
      if (band?.p.kf) {
        const tol = COARSE || lastPointerType === 'touch' ? 9 : 5;
        for (let i = 0; i < band.p.kf.length; i++) {
          const k = band.p.kf[i];
          if (k.t < -EPS || k.t > c.duration + EPS) continue;
          if (Math.abs(xOf(c.start + k.t) - x) <= tol && Math.abs(bandY(band, k.v, geo.bodyY, geo.bodyH) - y) <= tol + 1) {
            return { area: 'clip', row, t, clip: c, zone: 'bandKey', band, kfIndex: i, geo };
          }
        }
      }
      let zone = 'body';
      if (x <= x0 + ez) zone = 'in';
      else if (x >= x1 - ez) zone = 'out';
      // the line itself: a mouse grabs it; a finger on the selection tool drags the clip instead (a
      // line along the top of the clip would otherwise catch most drags) — fingers use keyframes or the pen
      const fingerSelect = lastPointerType === 'touch' && store.ui.tool === 'select' && !keys;
      if (zone === 'body' && band && y > geo.bodyY && !fingerSelect) {
        const vy = bandY(band, evalParam(band.p, t - c.start), geo.bodyY, geo.bodyH);
        if (Math.abs(y - vy) <= (COARSE || lastPointerType === 'touch' ? 8 : 3)) zone = 'band';
      }
      return { area: 'clip', row, t, clip: c, zone, band, geo };
    }
    return { area: 'track', row, t };
  }

  function snapCandidates(excludeIds = new Set()) {
    const s = store.seq;
    const pts = [0, store.ui.playhead];
    for (const c of Object.values(s.clips)) {
      if (excludeIds.has(c.id)) continue;
      pts.push(c.start, clipEnd(c));
    }
    for (const mk of s.markers) pts.push(mk.time);
    if (s.inPoint != null) pts.push(s.inPoint);
    if (s.outPoint != null) pts.push(s.outPoint);
    return pts;
  }

  /** Snap a set of candidate times; returns {delta, at} for the best match within SNAP_PX. */
  function snapDelta(times, candidates, force = false) {
    if (!store.ui.snapping && !force) return { delta: 0, at: null };
    let best = null;
    const thr = SNAP_PX / view.pps;
    for (const t of times) {
      for (const c of candidates) {
        const d = c - t;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: c };
      }
    }
    return best || { delta: 0, at: null };
  }

  // ---------------------------------------------------------------- pointer interactions

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerleave', () => {
    if (hover) {
      hover = null;
      requestDraw();
    }
  });

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    canvas.focus();
    store.setFocus('timeline');
    const { x, y } = localPos(e);
    lastPointerType = e.pointerType;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x, y });
      canvas.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        startPinch();
        return;
      }
      if (touches.size > 2) return;
      edgePx = EDGE_PX_TOUCH;
    } else edgePx = EDGE_PX;
    const hit = hitTest(x, y);
    const tool = store.ui.tool;
    canvas.setPointerCapture(e.pointerId);

    // fingers: dragging pans the timeline; a tap selects (or moves the playhead on empty space);
    // a selected clip can be dragged or trimmed by its edges; long press opens the clip menu
    if (e.pointerType === 'touch' && tool === 'select') {
      const onSelected = hit.area === 'clip' && store.selection.clips.has(hit.clip.id);
      armLongPress(e, hit);
      if (hit.area !== 'ruler' && hit.area !== 'transition' && !onSelected) {
        drag = { type: 'touchpan', x0: x, y0: y, sx: view.scrollX, sy: view.scrollY, moved: false, hit };
        return;
      }
    }

    if (tool === 'hand' || e.button === 1) {
      drag = { type: 'pan', x0: x, y0: y, sx: view.scrollX, sy: view.scrollY };
      return;
    }
    if (tool === 'zoom') {
      setZoom(view.pps * (e.altKey ? 0.5 : 2), x);
      return;
    }

    if (hit.area === 'ruler') {
      // marker drag?
      const mk = y > 12 && y < 28 ? rulerMarkerAt(x) : null;
      if (mk) {
        // the end of a range marker, or Alt-drag (Premiere), changes its length; elsewhere it moves
        const len = e.altKey || (mk.duration > 0 && Math.abs(xOf(mk.time + mk.duration) - x) <= 5 && Math.abs(xOf(mk.time) - x) > 5);
        store.begin(len ? '마커 길이' : '마커 이동');
        drag = { type: 'marker', id: mk.id, t0: mk.time, d0: mk.duration || 0, x0: x, len };
        return;
      }
      playback.stop();
      drag = { type: 'scrub' };
      scrubTo(x, e.shiftKey);
      return;
    }

    if (hit.area === 'transition' && (tool === 'select' || tool === 'ripple' || tool === 'rolling')) {
      store.selectTransition(hit.transition.clip.id, hit.transition.edge);
      return;
    }

    if (hit.area === 'clip' && getTrack(store.seq, hit.clip.trackId)?.locked) {
      store.selectClips([hit.clip.id]);
      return;
    }

    // keyframes on the rubber band: the selection and pen tools grab them
    if (hit.area === 'clip' && (tool === 'select' || tool === 'pen') && (hit.zone === 'bandKey' || hit.zone === 'band')) {
      const c = hit.clip;
      if (!store.selection.clips.has(c.id)) store.selectClips(e.altKey ? [c.id] : [...edit.withGroupsAndLinks([c.id])]);
      if (hit.zone === 'bandKey') {
        const k = hit.band.p.kf[hit.kfIndex];
        selKey = { clipId: c.id, fxId: hit.band.fx.id, key: hit.band.key, t: k.t };
        if (modKey(e)) {
          // Ctrl+click on a keyframe: 선형 <-> 자동 베지어 (Premiere)
          toggleKeyBezier(c.id, hit.band, hit.kfIndex);
          return;
        }
        // 시간 다시 매핑 ▸ 속도: dragging a speed keyframe splits it into a gradual ramp (Premiere);
        // Alt+drag moves the whole keyframe
        const kfs = hit.band.p.kf;
        const stepKey = hit.kfIndex > 0 && kfInterp(kfs[hit.kfIndex - 1]) === 'hold' && kfs[hit.kfIndex - 1].v !== k.v;
        if (hit.band.fx.type === 'timeRemap' && !e.altKey && stepKey) {
          beginRampKey(x, y, hit);
          return;
        }
        beginBandKey(x, y, hit);
        return;
      }
      if (modKey(e) || tool === 'pen') {
        addBandKey(c.id, hit.band, hit.t, tool === 'pen' && !modKey(e) ? bandValue(hit.band, y, hit.geo.bodyY, hit.geo.bodyH) : null);
        return;
      }
      beginBand(x, y, hit);
      return;
    }

    switch (tool) {
      case 'razor':
        if (hit.area === 'clip') {
          const t = razorTime(x);
          // Shift: every track · Alt: only this clip, not its linked partner
          if (e.shiftKey) edit.addEdit({ allTracks: true, t });
          else edit.addEdit({ t, clipIds: [hit.clip.id], linked: !e.altKey });
        }
        return;
      case 'track':
      case 'trackBack': {
        if (hit.area === 'empty' || hit.area === 'ruler' || !hit.row) return;
        const t = hit.t;
        // Premiere: the tools select on every track; Shift-click limits them to the clicked track
        if (tool === 'track') edit.selectForward(t, e.shiftKey ? hit.row.track.id : null);
        else edit.selectBackward(t, e.shiftKey ? hit.row.track.id : null);
        if (store.selection.clips.size) {
          const anchor = hit.area === 'clip' ? hit : { ...hit, clip: store.selectedClips()[0] };
          beginMove(e, x, y, anchor, [...store.selection.clips]);
        }
        return;
      }
      case 'slip':
        if (hit.area === 'clip' && isTimed(hit.clip)) {
          store.selectClips([...edit.withLinked([hit.clip.id])]);
          beginSlip(x, hit.clip, e);
        }
        return;
      case 'slide':
        if (hit.area === 'clip') {
          store.selectClips(e.altKey ? [hit.clip.id] : [...edit.withLinked([hit.clip.id])]);
          beginSlide(x, y, hit.clip, e);
        }
        return;
      case 'rate':
        if (hit.area === 'clip' && (hit.zone === 'in' || hit.zone === 'out')) beginRate(x, y, hit, e);
        else if (hit.area === 'clip') store.selectClips(e.altKey ? [hit.clip.id] : [...edit.withGroupsAndLinks([hit.clip.id])]);
        return;
      case 'pen':
        if (hit.area === 'clip') store.selectClips(e.altKey ? [hit.clip.id] : [...edit.withGroupsAndLinks([hit.clip.id])]);
        else if (hit.area === 'track' || hit.area === 'empty') store.clearSelection();
        return;
      case 'ripple':
      case 'rolling':
        if (hit.area === 'clip' && (hit.zone === 'in' || hit.zone === 'out')) {
          beginTrim(x, y, hit, tool === 'ripple' ? 'ripple' : 'rolling', e);
          return;
        }
        break;
      default:
        break;
    }

    // selection tool (and fallthrough)
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (hit.zone === 'in' || hit.zone === 'out') {
        beginTrim(x, y, hit, modKey(e) ? 'ripple' : 'normal', e);
        return;
      }
      // a click on the body selects the clip, not an edit point
      if (store.ui.editPoint) {
        store.ui.editPoint = null;
        invalidate();
      }
      // Alt+click picks one clip of a linked pair or a group
      const ids = e.altKey ? [c.id] : [...edit.withGroupsAndLinks([c.id])];
      const wasSelected = store.selection.clips.has(c.id);
      if (e.shiftKey) store.toggleClips(ids);
      else if (!wasSelected || e.altKey) store.selectClips(ids);
      if (!store.selection.clips.has(c.id)) return;
      beginMove(e, x, y, hit, [...store.selection.clips]);
      // a plain click on an already-selected clip narrows the selection on release
      if (wasSelected && !e.shiftKey && drag) drag.clickIds = ids;
      return;
    }
    if (hit.area === 'track' || hit.area === 'empty') {
      drag = { type: 'marquee', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, hit };
      if (!e.shiftKey) store.clearSelection();
    }
  }

  /** Sequence marker under ruler x (its head, or anywhere on a range marker's bar). */
  function rulerMarkerAt(x) {
    const list = store.seq.markers;
    return list.find((m) => Math.abs(xOf(m.time) - x) < 6) || list.find((m) => m.duration > 0 && x >= xOf(m.time) && x <= xOf(m.time + m.duration)) || null;
  }

  function razorTime(x) {
    let t = snapFrame(tOf(x), fps());
    if (store.ui.snapping && Math.abs(xOf(store.ui.playhead) - x) < SNAP_PX) t = store.ui.playhead;
    return t;
  }

  function scrubTo(x, snap) {
    let t = Math.max(0, tOf(x));
    if (snap || store.ui.snapping) {
      // Shift snaps the playhead to edit points and markers even when snapping is off
      const pts = editPoints(store.seq).concat(store.seq.markers.map((m) => m.time));
      const sd = snapDelta([t], pts, snap);
      if (sd.at != null) t += sd.delta;
    }
    store.setPlayhead(snapFrame(t, fps()));
    playback.scrubAudio();
  }

  function beginMove(e, x, y, hit, ids) {
    const s = store.seq;
    const movable = ids.filter((id) => s.clips[id] && !getTrack(s, s.clips[id].trackId)?.locked);
    if (!movable.length) return;
    drag = {
      type: 'move', ids: movable, x0: x, y0: y, moved: false,
      anchorKind: hit.clip.kind === 'audio' ? 'audio' : 'video',
      anchorRow: view.rows.indexOf(hit.row),
      duplicate: e.altKey, insert: modKey(e),
      candidates: snapCandidates(new Set(movable)),
      ghosts: [], dt: 0, dV: 0, dA: 0,
    };
  }

  function beginTrim(x, y, hit, mode, e) {
    const s = store.seq;
    const c = hit.clip;
    const edge = hit.zone;
    let clips = e.altKey || !store.ui.linkedSelection ? [c] : linkedClips(s, c).filter((l) => Math.abs((edge === 'in' ? l.start : clipEnd(l)) - (edge === 'in' ? c.start : clipEnd(c))) < 1e-4);
    clips = clips.filter((l) => !getTrack(s, l.trackId)?.locked);
    let partner = null;
    if (mode === 'rolling') {
      partner = edge === 'out' ? nextAdjacent(s, c) : prevAdjacent(s, c);
      if (!partner) mode = 'normal';
    }
    let min = -Infinity;
    let max = Infinity;
    for (const l of clips) {
      const lim = edit.trimLimits(l, edge, { ripple: mode === 'ripple', rolling: mode === 'rolling' });
      min = Math.max(min, lim.min);
      max = Math.min(max, lim.max);
    }
    let partners = [];
    if (mode === 'rolling') {
      partners = clips.map((l) => (edge === 'out' ? nextAdjacent(s, l) : prevAdjacent(s, l))).filter(Boolean);
      const pedge = edge === 'out' ? 'in' : 'out';
      for (const p of partners) {
        const lim = edit.trimLimits(p, pedge, { rolling: true });
        // partner delta is the same time shift: for its 'in' edge positive delta shortens
        min = Math.max(min, lim.min);
        max = Math.min(max, lim.max);
      }
    }
    store.selectClips(clips.map((l) => l.id));
    store.begin(mode === 'ripple' ? '잔물결 다듬기' : mode === 'rolling' ? '롤링 편집' : '다듬기');
    const restorePlayhead = store.ui.playhead;
    const edgeT = edge === 'in' ? c.start : clipEnd(c);
    drag = {
      type: 'trim', mode, edge, ids: clips.map((l) => l.id), partnerIds: partners.map((p) => p.id),
      x0: x, edgeT, min, max, applied: 0, candidates: snapCandidates(new Set([...clips, ...partners].map((l) => l.id))),
      tipX: x, tipY: y, restorePlayhead,
    };
  }

  function beginSlip(x, c, e) {
    const s = store.seq;
    const ids = e?.altKey ? [c.id] : [...edit.withLinked([c.id])];
    // every slipped clip must stay inside its media (speed, time remapping and reversal aware)
    let min = -Infinity;
    let max = Infinity;
    for (const id of ids) {
      const x2 = s.clips[id];
      if (!x2 || !isTimed(x2)) continue;
      const m = store.project.media[x2.mediaId];
      const rate = Math.max(1e-3, x2.speed);
      // a clip from a subclip (하위 클립) slips only inside the subclip's range
      const lo = x2.subclip?.restrict ? x2.subclip.in : 0;
      const hi = x2.subclip?.restrict ? Math.min(x2.subclip.out, m?.duration ?? Infinity) : m?.duration;
      min = Math.max(min, -(x2.inPoint - lo) / rate);
      if (m && Number.isFinite(hi)) max = Math.min(max, (hi - (x2.inPoint + contentTime(x2, x2.duration))) / rate);
    }
    if (min > max) min = max = 0;
    store.begin('밀어넣기 (슬립)');
    drag = { type: 'slip', ids, x0: x, min, max, applied: 0, restorePlayhead: store.ui.playhead };
  }

  /** 밀기 도구 (slide): move the clip over its neighbours, which get longer / shorter at the cut. */
  function beginSlide(x, y, c, e) {
    const s = store.seq;
    const ids = (e.altKey ? [c.id] : [...edit.withLinked([c.id])]).filter((id) => s.clips[id] && !getTrack(s, s.clips[id].trackId)?.locked);
    if (!ids.length) return;
    let min = -Infinity;
    let max = Infinity;
    const items = [];
    for (const id of ids) {
      const cl = s.clips[id];
      const lim = edit.slideLimits(cl);
      min = Math.max(min, lim.min);
      max = Math.min(max, lim.max);
      items.push({ id, prevId: lim.prev?.id || null, nextId: lim.next?.id || null });
    }
    if (min > max) min = max = 0;
    store.begin('밀기');
    drag = { type: 'slide', items, x0: x, min, max, applied: 0, tipX: x, tipY: y, restorePlayhead: store.ui.playhead, candidates: snapCandidates(new Set(ids)), edgeT: c.start };
  }

  /** 속도 조정 도구 (rate stretch): drag an edge to change the clip's length by changing its speed. */
  function beginRate(x, y, hit, e) {
    const s = store.seq;
    const c = hit.clip;
    const edge = hit.zone;
    let clips = e.altKey || !store.ui.linkedSelection ? [c] : linkedClips(s, c).filter((l) => Math.abs(l.start - c.start) < 1e-4 && Math.abs(l.duration - c.duration) < 1e-4);
    clips = clips.filter((l) => !getTrack(s, l.trackId)?.locked);
    if (!clips.length) return;
    let min = -Infinity;
    let max = Infinity;
    for (const l of clips) {
      const lim = edit.rateStretchLimits(l, edge);
      min = Math.max(min, lim.min);
      max = Math.min(max, lim.max);
    }
    if (min > max) min = max = 0;
    store.selectClips(clips.map((l) => l.id));
    store.begin('속도 조정');
    drag = {
      type: 'rate', edge, ids: clips.map((l) => l.id), dur0: c.duration, x0: x, min, max, tipX: x, tipY: y,
      edgeT: edge === 'in' ? c.start : clipEnd(c), candidates: snapCandidates(new Set(clips.map((l) => l.id))), restorePlayhead: store.ui.playhead,
    };
  }

  /** Find the band's param again by ids (undo replaces the project tree). */
  function bandParam(clipId, fxId, key) {
    const c = store.seq.clips[clipId];
    const fx = c?.effects.find((f) => f.id === fxId);
    return fx ? { c, fx, p: fx.params[key] } : null;
  }

  /** Drag one rubber-band keyframe in time and value. */
  function beginBandKey(x, y, hit) {
    const k = hit.band.p.kf[hit.kfIndex];
    store.begin('키프레임 이동');
    drag = {
      type: 'bandKey', clipId: hit.clip.id, fxId: hit.band.fx.id, key: hit.band.key, idx: hit.kfIndex, x0: x, y0: y, t0: k.t, moved: false,
      band: { db: hit.band.db, log: hit.band.log, lo: hit.band.lo, hi: hit.band.hi, def: hit.band.def }, bodyY: hit.geo.bodyY, bodyH: hit.geo.bodyH, tipX: x, tipY: y,
    };
  }

  /** Drag one half of a speed keyframe (시간 다시 매핑) sideways: the speed change becomes a ramp. */
  function beginRampKey(x, y, hit) {
    store.begin('속도 램프 전환');
    drag = {
      type: 'rampKey', clipId: hit.clip.id, fxId: hit.band.fx.id, key: hit.band.key, idx: hit.kfIndex, x0: x, y0: y, moved: false,
      st: edit.remapRetimeState(hit.clip.id), tipX: x, tipY: y,
    };
  }

  /**
   * Raw: rebuild the speed keys of a ramp drag. The step at key idx (speed vb before, va after) becomes
   * a straight ramp over d seconds after it (right half dragged) or before it (left half); the keys
   * after the ramp move so they keep their source frames, and the clip and the clips after it follow.
   */
  function applyRampKey(d, dt) {
    const st = d.st;
    const r = bandParam(d.clipId, d.fxId, d.key);
    if (!st?.kf || !r) return null;
    const old = st.kf;
    const i = d.idx;
    const k = old[i];
    const vb = old[i - 1]?.v;
    const va = k?.v;
    if (vb == null || va == null) return null;
    const f = 1 / fps();
    const right = dt >= 0;
    const room = right ? (i + 1 < old.length ? old[i + 1].t : st.dur) - k.t - f : k.t - old[i - 1].t - f;
    const len = clamp(snapFrame(Math.abs(dt), fps()), 0, Math.max(0, room));
    const shift = va > 0.01 ? ((right ? 1 : -1) * len * (va - vb)) / (2 * va) : 0;
    const a = { ...k, t: right ? k.t : k.t - len, v: vb, ease: 'linear', interp: 'linear' };
    delete a.inSpeed; delete a.outSpeed; delete a.inInf; delete a.outInf;
    const b = { ...k, t: right ? k.t + len : k.t };
    const kf = len > 0 ? [...old.slice(0, i), a, b] : [...old.slice(0, i), { ...k }];
    for (const o of old.slice(i + 1)) kf.push({ ...o, t: o.t + shift });
    r.p.kf = kf;
    const dur = Math.max(f, snapFrame(st.dur + (len > 0 ? shift : 0), fps()));
    const s = store.seq;
    for (const id of st.mates) if (s.clips[id]) s.clips[id].duration = dur;
    edit.rawSyncLinkedRemap(d.clipId);
    for (const o of st.after) if (s.clips[o.id]) s.clips[o.id].start = o.start + (dur - st.dur);
    return { len, vb, va };
  }

  /** Drag the rubber band: a still value changes; with keyframes, the two keys around the pointer move. */
  function beginBand(x, y, hit) {
    const p = hit.band.p;
    const tl = hit.t - hit.clip.start;
    let pair = null;
    if (isAnimated(p)) {
      let i = p.kf.findIndex((k) => k.t > tl);
      if (i < 0) pair = [p.kf.length - 1];
      else if (i === 0) pair = [0];
      // a stretch after a hold key (speed keys) has that key's value alone
      else pair = kfInterp(p.kf[i - 1]) === 'hold' ? [i - 1] : [i - 1, i];
    }
    store.begin(isAnimated(p) ? '키프레임 이동' : `${hit.band.def.label} 바꾸기`);
    drag = {
      type: 'band', clipId: hit.clip.id, fxId: hit.band.fx.id, key: hit.band.key, y0: y, x0: x, tl, pair,
      base: pair ? pair.map((i) => p.kf[i].v) : [p.value], v0: evalParam(p, tl),
      band: { db: hit.band.db, log: hit.band.log, lo: hit.band.lo, hi: hit.band.hi, def: hit.band.def }, bodyY: hit.geo.bodyY, bodyH: hit.geo.bodyH, tipX: x, tipY: y,
      // a speed band (시간 다시 매핑) keeps the content and changes the clip's length, as in Premiere
      remap: hit.band.fx.type === 'timeRemap' ? edit.remapRetimeState(hit.clip.id) : null,
    };
  }

  /** Add a keyframe on the band at sequence time t (value: on the line, or v when given). */
  function addBandKey(clipId, band, t, v = null) {
    const fxId = band.fx.id;
    const key = band.key;
    store.transact('키프레임 추가', () => {
      const r = bandParam(clipId, fxId, key);
      if (!r) return;
      const { c, p } = r;
      const tl = clamp(snapFrame(t, fps()) - c.start, 0, c.duration);
      const value = v ?? evalParam(p, tl);
      if (!p.kf) p.kf = [];
      const near = p.kf.find((k) => Math.abs(k.t - tl) < 0.5 / fps());
      // speed keys split the band into stretches of their own speed (Premiere's 시간 다시 매핑):
      // hold keys, and a first key at the clip start so the stretch before the new key stays separate
      const speedBand = r.fx.type === 'timeRemap';
      const add = (at) => {
        const k = newKey(at, value);
        if (speedBand) Object.assign(k, { ease: 'linear', interp: 'hold' });
        p.kf.push(k);
      };
      if (speedBand && !p.kf.length && tl > 0.5 / fps()) add(0);
      if (near) near.v = value;
      else add(tl);
      p.kf.sort((a, b) => a.t - b.t);
      p.value = value;
      // linked audio follows the speed keys
      if (speedBand) edit.rawSyncLinkedRemap(clipId);
      selKey = { clipId, fxId, key, t: near ? near.t : tl };
    });
  }

  function toggleKeyBezier(clipId, band, idx) {
    const fxId = band.fx.id;
    const key = band.key;
    store.transact('키프레임 보간', () => {
      const r = bandParam(clipId, fxId, key);
      const k = r?.p.kf?.[idx];
      if (!k) return;
      setKeyInterp(r.p, idx, kfInterp(k) === 'linear' ? 'autoBezier' : 'linear');
    });
  }

  /** Delete the selected rubber-band keyframe (Delete key). Returns true when one was deleted. */
  function deleteSelectedKey() {
    if (!selKey) return false;
    const r = bandParam(selKey.clipId, selKey.fxId, selKey.key);
    const i = r?.p.kf ? r.p.kf.findIndex((k) => Math.abs(k.t - selKey.t) < 1e-6) : -1;
    if (i < 0) {
      selKey = null;
      return false;
    }
    store.transact('키프레임 삭제', () => {
      const rr = bandParam(selKey.clipId, selKey.fxId, selKey.key);
      const p = rr.p;
      const v = evalParam(p, selKey.t);
      p.kf.splice(i, 1);
      if (!p.kf.length) {
        p.kf = null;
        p.value = v;
      }
    });
    selKey = null;
    return true;
  }

  function onPointerMove(e) {
    const { x, y } = localPos(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x, y });
    if (drag?.type === 'pinch') {
      movePinch();
      return;
    }
    if (drag?.type === 'touchpan') {
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > 8) {
        drag.moved = true;
        clearTimeout(longPress);
      }
      if (drag.moved) {
        setScrollX(drag.sx - (x - drag.x0));
        setScrollY(drag.sy - (y - drag.y0));
      }
      return;
    }
    if (drag && e.pointerType === 'touch' && !drag.longPressMoved && Math.hypot(x - (drag.lx ?? x), y - (drag.ly ?? y)) > 8) {
      drag.longPressMoved = true;
      clearTimeout(longPress);
    }
    if (!drag) {
      updateHover(x, y, e);
      return;
    }
    const s = store.seq;
    switch (drag.type) {
      case 'pan':
        setScrollX(drag.sx - (x - drag.x0));
        setScrollY(drag.sy - (y - drag.y0));
        break;
      case 'scrub':
        scrubTo(x, e.shiftKey);
        autoScroll(x);
        break;
      case 'marker': {
        const mk = s.markers.find((m) => m.id === drag.id);
        if (mk) {
          const dt = (x - drag.x0) / view.pps;
          if (drag.len) {
            mk.duration = Math.max(0, snapFrame(drag.d0 + dt, fps()));
            drag.tooltip = `길이 ${formatTimecode(mk.duration, fps())}`;
            drag.tipX = x;
            drag.tipY = RULER_H + fpx(26);
          } else mk.time = Math.max(0, snapFrame(drag.t0 + dt, fps()));
          store.changed();
        }
        break;
      }
      case 'marquee':
        drag.x1 = x;
        drag.y1 = y;
        drag.moved = drag.moved || Math.abs(x - drag.x0) > 3 || Math.abs(y - drag.y0) > 3;
        if (drag.moved) updateMarquee();
        requestDraw();
        break;
      case 'move': {
        const dx = x - drag.x0;
        const dy = y - drag.y0;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        drag.moved = true;
        drag.duplicate = e.altKey;
        drag.insert = modKey(e);
        let dt = dx / view.pps;
        const clips = drag.ids.map((id) => s.clips[id]).filter(Boolean);
        const minStart = Math.min(...clips.map((c) => c.start));
        dt = Math.max(-minStart, dt);
        const times = clips.flatMap((c) => [c.start + dt, clipEnd(c) + dt]);
        const sd = snapDelta(times, drag.candidates);
        dt += sd.delta;
        dt = snapFrame(dt, fps());
        drag.snapAt = sd.at;
        // vertical: lanes moved within the anchor kind
        const row = rowAtY(y);
        let dV = 0;
        let dA = 0;
        if (row) {
          const kindRows = view.rows.filter((r) => r.track.kind === drag.anchorKind);
          const anchorTrackId = view.rows[drag.anchorRow]?.track.id;
          const from = kindRows.findIndex((r) => r.track.id === anchorTrackId);
          const to = kindRows.findIndex((r) => r.track.id === row.track.id);
          if (from >= 0 && to >= 0) {
            // rows for video are displayed reversed (top = highest track)
            const d = drag.anchorKind === 'video' ? from - to : to - from;
            if (drag.anchorKind === 'video') dV = d;
            else dA = d;
          }
        }
        drag.dt = dt;
        drag.dV = dV;
        drag.dA = dA;
        const vts = videoTracks(s);
        const ats = audioTracks(s);
        drag.ghosts = clips.map((c) => {
          const list = c.kind === 'audio' ? ats : vts;
          const idx = list.findIndex((t) => t.id === c.trackId);
          const ni = clamp(idx + (c.kind === 'audio' ? dA : dV), 0, list.length - 1);
          return { id: c.id, trackId: list[ni].id, start: c.start + dt };
        });
        drag.tooltip = `${dt >= 0 ? '+' : '-'}${formatTimecode(Math.abs(dt), fps())}${drag.insert ? '  (삽입)' : ''}${drag.duplicate ? '  (복제)' : ''}`;
        drag.tipX = x;
        drag.tipY = y;
        autoScroll(x);
        invalidate();
        break;
      }
      case 'trim': {
        let delta = (x - drag.x0) / view.pps;
        const sd = snapDelta([drag.edgeT + delta], drag.candidates);
        delta += sd.delta;
        drag.snapAt = sd.at;
        delta = clamp(snapFrame(delta, fps()), drag.min, drag.max);
        applyTrim(delta);
        drag.tooltip = `${delta >= 0 ? '+' : '-'}${formatTimecode(Math.abs(delta), fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        autoScroll(x);
        break;
      }
      case 'slip': {
        const delta = clamp(snapFrame((x - drag.x0) / view.pps, fps()), drag.min, drag.max);
        const inc = delta - drag.applied;
        for (const id of drag.ids) {
          const c = s.clips[id];
          if (c) c.inPoint += inc * c.speed;
        }
        drag.applied = delta;
        drag.tooltip = `슬립 ${delta >= 0 ? '+' : '-'}${formatTimecode(Math.abs(delta), fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        // show the new in-point frame
        const c = s.clips[drag.ids[0]];
        if (c) store.setPlayhead(c.start);
        break;
      }
      case 'slide': {
        let delta = (x - drag.x0) / view.pps;
        const sd = snapDelta([drag.edgeT + delta], drag.candidates);
        delta += sd.delta;
        drag.snapAt = sd.at;
        delta = clamp(snapFrame(delta, fps()), drag.min, drag.max);
        const inc = delta - drag.applied;
        if (Math.abs(inc) > EPS) {
          for (const it of drag.items) {
            const c = s.clips[it.id];
            if (c) edit.rawSlide(c, inc, it.prevId ? s.clips[it.prevId] : null, it.nextId ? s.clips[it.nextId] : null);
          }
          drag.applied = delta;
          store.changed();
        }
        const c = s.clips[drag.items[0].id];
        if (c) store.setPlayhead(c.start);
        drag.tooltip = `밀기 ${delta >= 0 ? '+' : '-'}${formatTimecode(Math.abs(delta), fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        autoScroll(x);
        break;
      }
      case 'rate': {
        let delta = (x - drag.x0) / view.pps;
        const sd = snapDelta([drag.edgeT + delta], drag.candidates);
        delta += sd.delta;
        drag.snapAt = sd.at;
        delta = clamp(snapFrame(delta, fps()), drag.min, drag.max);
        const newDur = Math.max(1 / fps(), drag.edge === 'out' ? drag.dur0 + delta : drag.dur0 - delta);
        for (const id of drag.ids) {
          const c = s.clips[id];
          if (c) edit.rawRateStretch(c, drag.edge, newDur);
        }
        const c = s.clips[drag.ids[0]];
        drag.tooltip = c ? `속도 ${Math.round(c.speed * 1000) / 10}% · 길이 ${formatTimecode(c.duration, fps())}` : '';
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        autoScroll(x);
        break;
      }
      case 'rampKey': {
        if (!drag.moved && Math.abs(x - drag.x0) < 3) break;
        drag.moved = true;
        const res = applyRampKey(drag, (x - drag.x0) / view.pps);
        if (res) drag.tooltip = `속도 ${Math.round(res.vb)}% → ${Math.round(res.va)}% · 전환 ${formatTimecode(res.len, fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        break;
      }
      case 'bandKey': {
        const r = bandParam(drag.clipId, drag.fxId, drag.key);
        const k = r?.p.kf?.[drag.idx];
        if (!k) break;
        if (!drag.moved && Math.abs(x - drag.x0) < 3 && Math.abs(y - drag.y0) < 3) break;
        drag.moved = true;
        const kf = r.p.kf;
        const f = 1 / fps();
        // keys keep their order: a key stops one frame before its neighbours (Shift: value only)
        const lo = drag.idx > 0 ? kf[drag.idx - 1].t + f : 0;
        const hi = drag.idx < kf.length - 1 ? kf[drag.idx + 1].t - f : r.c.duration;
        if (!e.shiftKey) k.t = clamp(snapFrame(drag.t0 + (x - drag.x0) / view.pps, fps()), Math.min(lo, hi), Math.max(lo, hi));
        k.v = bandValue(drag.band, y, drag.bodyY, drag.bodyH);
        if (selKey) selKey.t = k.t;
        drag.tooltip = `${fmtBandValue(drag.band, k.v)} · ${formatTimecode(r.c.start + k.t, fps())}`;
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        break;
      }
      case 'band': {
        const r = bandParam(drag.clipId, drag.fxId, drag.key);
        if (!r) break;
        const p = r.p;
        // move by the change of the value under the pointer, so the line follows the pointer
        const vNow = bandValue(drag.band, bandY(drag.band, drag.v0, drag.bodyY, drag.bodyH) + (y - drag.y0), drag.bodyY, drag.bodyH);
        const d = vNow - drag.v0;
        const lo = drag.band.db ? -60 : drag.band.def.min ?? -Infinity;
        const hi = drag.band.db ? 15 : drag.band.def.max ?? Infinity;
        if (drag.pair && p.kf) drag.pair.forEach((i, j) => { if (p.kf[i]) p.kf[i].v = clamp(drag.base[j] + d, lo, hi); });
        else p.value = clamp(drag.base[0] + d, lo, hi);
        if (drag.remap) edit.rawRetimeRemap(drag.remap);
        drag.tooltip = fmtBandValue(drag.band, clamp(drag.v0 + d, lo, hi)) + (drag.remap ? ` · 길이 ${formatTimecode(r.c.duration, fps())}` : '');
        drag.tipX = x;
        drag.tipY = y;
        store.changed();
        break;
      }
    }
    requestDraw();
  }

  function fmtBandValue(b, v) {
    if (b.db) return `${v.toFixed(1)} dB`;
    const unit = b.def.unit || '';
    return `${Math.round(v * 10) / 10}${unit}`;
  }

  function applyTrim(delta) {
    const s = store.seq;
    const inc = delta - drag.applied;
    if (Math.abs(inc) < EPS) return;
    const clips = drag.ids.map((id) => s.clips[id]).filter(Boolean);
    if (drag.mode === 'ripple') {
      edit.rawRippleTrim(clips, drag.edge, inc);
    } else if (drag.mode === 'rolling') {
      // the cut moves: both sides of the edit point change by the same amount
      for (const c of clips) edit.rawTrimEdge(c, drag.edge, inc);
      for (const id of drag.partnerIds) {
        const p = s.clips[id];
        if (p) edit.rawTrimEdge(p, drag.edge === 'out' ? 'in' : 'out', inc);
      }
    } else {
      for (const c of clips) edit.rawTrimEdge(c, drag.edge, inc);
    }
    drag.applied = delta;
    // preview the edit frame
    const c = clips[0];
    if (c) store.setPlayhead(drag.edge === 'in' ? c.start : Math.max(c.start, clipEnd(c) - 1 / fps()));
    store.changed();
  }

  function updateMarquee() {
    const s = store.seq;
    const t0 = tOf(Math.min(drag.x0, drag.x1));
    const t1 = tOf(Math.max(drag.x0, drag.x1));
    const y0 = Math.min(drag.y0, drag.y1);
    const y1 = Math.max(drag.y0, drag.y1);
    const ids = [];
    for (const row of view.rows) {
      const ry = rowY(row);
      if (ry + row.h < y0 || ry > y1) continue;
      for (const c of clipsOnTrack(s, row.track.id)) if (clipEnd(c) > t0 && c.start < t1) ids.push(c.id);
    }
    // like Premiere, a marquee also takes the linked partners (with linked selection on) and whole groups
    store.selectClips([...edit.withGroupsAndLinks(ids)], { add: drag.add });
  }

  function onPointerUp(e) {
    touches.delete(e.pointerId);
    clearTimeout(longPress);
    if (!drag) return;
    if (drag.type === 'pinch') {
      if (touches.size < 2) drag = null;
      return;
    }
    const d = drag;
    drag = null;
    const s = store.seq;
    switch (d.type) {
      case 'touchpan':
        if (!d.moved && e.type !== 'pointercancel') {
          if (d.hit.area === 'clip') store.selectClips([...edit.withLinked([d.hit.clip.id])]);
          else if (d.hit.area === 'track' || d.hit.area === 'empty') {
            store.clearSelection();
            playback.stop();
            store.setPlayhead(snapFrame(Math.max(0, tOf(d.x0)), fps()));
          }
        }
        break;
      case 'move':
        if (!d.moved && d.clickIds) store.selectClips(d.clickIds);
        if (d.moved && (Math.abs(d.dt) > EPS || d.dV || d.dA || d.duplicate)) {
          store.transact(d.duplicate ? '복제' : d.insert ? '삽입하며 이동' : '이동', () => {
            const ids = edit.rawMoveClips(d.ids, d.dt, d.dV, d.dA, { mode: d.insert ? 'insert' : 'overwrite', duplicate: d.duplicate });
            if (!ids) toast('잠긴 트랙으로는 옮길 수 없습니다');
            else if (d.duplicate) store.selectClips(ids);
          });
        }
        break;
      case 'trim':
      case 'slip':
      case 'slide':
      case 'rate':
      case 'band':
      case 'bandKey':
      case 'rampKey':
      case 'marker':
        // trims and slips preview the edit frame in the Program monitor; put the playhead back
        if (d.restorePlayhead != null) store.setPlayhead(d.restorePlayhead);
        // a speed band (시간 다시 매핑) keeps the linked video/audio in step
        if ((d.type === 'band' || d.type === 'bandKey') && bandParam(d.clipId, d.fxId, d.key)?.fx.type === 'timeRemap') edit.rawSyncLinkedRemap(d.clipId);
        if (d.type === 'trim' || d.type === 'slide' || d.type === 'rate') {
          const touched = d.type === 'slide' ? d.items.flatMap((it) => [it.id, it.prevId, it.nextId]).filter(Boolean) : [...d.ids, ...(d.partnerIds || [])];
          if (d.type === 'trim' && d.mode === 'ripple') touched.push(...Object.keys(s.clips));
          edit.rawTidyTimes(touched);
        }
        if (d.type === 'marker') s.markers.sort((a, b) => a.time - b.time);
        store.commit();
        // a clicked or dragged clip edge stays selected as an edit point (E extends it to the playhead)
        if (d.type === 'trim' && e.type !== 'pointercancel') {
          store.ui.editPoint = { ids: d.ids.filter((id) => s.clips[id]), edge: d.edge, mode: d.mode };
          invalidate();
        }
        break;
      case 'marquee':
        if (!d.moved && d.hit?.area === 'track') {
          // click in empty track space: select the gap if it is bounded by clips
          const clips = clipsOnTrack(s, d.hit.row.track.id);
          const t = d.hit.t;
          const prev = clips.filter((c) => clipEnd(c) <= t).pop();
          const next = clips.find((c) => c.start >= t);
          if (next) store.selectGap({ trackId: d.hit.row.track.id, start: prev ? clipEnd(prev) : 0, end: next.start });
        }
        break;
    }
    invalidate();
  }

  function updateHover(x, y, e) {
    const hit = hitTest(x, y);
    const tool = store.ui.tool;
    let cursor = 'default';
    hover = null;
    if (tool === 'hand') cursor = 'grab';
    else if (tool === 'zoom') cursor = e.altKey ? 'zoom-out' : 'zoom-in';
    else if (hit.area === 'ruler') {
      // the end of a range marker (or Alt over a marker) drags its length
      const mk = y > 12 && y < 28 ? rulerMarkerAt(x) : null;
      cursor = mk && (e.altKey || (mk.duration > 0 && Math.abs(xOf(mk.time + mk.duration) - x) <= 5 && Math.abs(xOf(mk.time) - x) > 5)) ? 'ew-resize' : 'pointer';
    } else if (hit.area === 'clip') {
      if (tool === 'razor') {
        cursor = 'crosshair';
        const row = hit.row;
        hover = { razor: razorTime(x), allTracks: e.shiftKey, y0: rowY(row), y1: rowY(row) + row.h };
      } else if (tool === 'slip' || tool === 'slide') cursor = 'ew-resize';
      else if ((tool === 'select' || tool === 'pen') && hit.zone === 'bandKey') cursor = 'move';
      else if ((tool === 'select' || tool === 'pen') && hit.zone === 'band') cursor = modKey(e) || tool === 'pen' ? 'copy' : 'ns-resize';
      else if (tool === 'pen') cursor = 'crosshair';
      else if (tool === 'rate') cursor = hit.zone === 'in' || hit.zone === 'out' ? 'col-resize' : 'default';
      else if (hit.zone === 'in' || hit.zone === 'out') cursor = tool === 'ripple' || modKey(e) ? 'col-resize' : tool === 'rolling' ? 'ew-resize' : 'col-resize';
      else if (tool === 'track') cursor = 'e-resize';
      else if (tool === 'trackBack') cursor = 'w-resize';
    } else if (hit.area === 'track' && (tool === 'track' || tool === 'trackBack')) cursor = tool === 'track' ? 'e-resize' : 'w-resize';
    canvas.style.cursor = cursor;
    requestDraw();
  }

  function autoScroll(x) {
    if (x > view.width - 20) setScrollX(view.scrollX + 20);
    else if (x < 20 && view.scrollX > 0) setScrollX(view.scrollX - 20);
  }

  function onDoubleClick(e) {
    const { x, y } = localPos(e);
    const hit = hitTest(x, y);
    if (hit.area === 'ruler') {
      const mk = rulerMarkerAt(x);
      if (mk) openMarkerEditor(mk.id);
      return;
    }
    if (hit.area === 'clip' && hit.zone === 'marker') {
      openMarkerEditor(hit.marker.id);
      return;
    }
    if (hit.area === 'clip' && (hit.zone === 'bandKey' || hit.zone === 'band')) return;
    if (hit.area === 'clip') {
      const c = hit.clip;
      const nm = c.mediaId && store.project.media[c.mediaId];
      if (nm?.kind === 'sequence') {
        // open the nested sequence, parking the playhead at the matching time
        const t = mediaTimeAt(c, store.ui.playhead >= c.start && store.ui.playhead < clipEnd(c) ? store.ui.playhead : c.start);
        store.openSequence(nm.sequenceId);
        store.setPlayhead(Math.max(0, t));
        return;
      }
      if (c.mediaId && store.project.media[c.mediaId] && (c.kind === 'video' || c.kind === 'audio' || c.kind === 'image')) {
        store.ui.sourceMediaId = c.mediaId;
        store.ui.sourceSeek = mediaTimeAt(c, store.ui.playhead >= c.start && store.ui.playhead < clipEnd(c) ? store.ui.playhead : c.start);
        store.emit('source');
      }
      store.emit('reveal-effect-controls');
    }
    if (hit.area === 'transition') store.emit('reveal-effect-controls');
  }

  /** Long press with a finger = right click (iOS has no native long-press context menu). */
  function armLongPress(e, hit) {
    clearTimeout(longPress);
    const { clientX, clientY } = e;
    const { x, y } = localPos(e);
    longPress = setTimeout(() => {
      if (!drag || drag.moved || drag.longPressMoved || drag.type === 'pinch') return;
      if (drag.type !== 'touchpan' && drag.type !== 'move') return;
      drag = null;
      if (navigator.vibrate) navigator.vibrate(12);
      if (hit.area === 'clip' && !store.selection.clips.has(hit.clip.id)) store.selectClips([...edit.withLinked([hit.clip.id])]);
      onContextMenu({ preventDefault() {}, clientX, clientY, synthetic: true });
    }, 520);
    if (drag) Object.assign(drag, { lx: x, ly: y });
  }

  function startPinch() {
    clearTimeout(longPress);
    if (drag && drag.type !== 'touchpan' && store.pending) store.cancel();
    const [a, b] = [...touches.values()];
    const mid = (a.x + b.x) / 2;
    drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, pps0: view.pps, t0: tOf(mid), sy: view.scrollY, my0: (a.y + b.y) / 2 };
  }

  function movePinch() {
    const pts = [...touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const d = drag;
    const mid = (a.x + b.x) / 2;
    view.pps = clamp(d.pps0 * (Math.hypot(a.x - b.x, a.y - b.y) / d.d0), 0.2, 3000);
    savePref('tl.pps', view.pps);
    view.scrollX = Math.max(0, d.t0 * view.pps - mid);
    view.scrollY = clamp(d.sy - ((a.y + b.y) / 2 - d.my0), 0, Math.max(0, view.contentH - (view.height - RULER_H) + 20));
    syncScrollbars();
    renderHeaders();
    invalidate();
  }

  function onContextMenu(e) {
    e.preventDefault();
    // a finger's native long-press menu is replaced by our own long-press handling
    if (!e.synthetic && lastPointerType === 'touch') return;
    const { x, y } = localPos(e);
    // a right-click on a rubber-band keyframe opens its interpolation menu whatever the tool
    const hit = hitTest(x, y, { keys: true });
    const s = store.seq;
    if (hit.area === 'transition') {
      store.selectTransition(hit.transition.clip.id, hit.transition.edge);
      showMenu([
        { label: '전환 길이 정하기…', action: async () => {
          const c = store.seq.clips[hit.transition.clip.id];
          const key = hit.transition.edge === 'in' ? 'transIn' : 'transOut';
          if (!c?.[key]) return;
          const v = await promptDialog('전환 길이', '길이 (타임코드 또는 프레임 수)', formatTimecode(c[key].duration, s.fps));
          const d = v != null ? parseTimecode(v, s.fps) : null;
          if (d) store.transact('전환 길이', () => edit.setTransitionDuration(c.id, hit.transition.edge, d));
        } },
        { label: '전환 삭제', key: 'Del', action: () => edit.deleteSelection() },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'clip' && hit.zone === 'bandKey') {
      const c = hit.clip;
      const band = hit.band;
      const k = band.p.kf[hit.kfIndex];
      selKey = { clipId: c.id, fxId: band.fx.id, key: band.key, t: k.t };
      invalidate();
      const fxId = band.fx.id;
      const key = band.key;
      const idx = hit.kfIndex;
      showMenu([
        { group: `${band.label} 키프레임 · 시간 보간` },
        ...KF_INTERP.map(([id, label, en]) => ({
          label: `${label} (${en})`, checked: kfInterp(k) === id, action: () => store.transact('키프레임 보간', () => {
            const r = bandParam(c.id, fxId, key);
            if (r?.p.kf?.[idx]) setKeyInterp(r.p, idx, id);
          }),
        })),
        '-',
        { label: '키프레임 삭제', key: 'Del', action: () => deleteSelectedKey() },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'clip' && hit.zone === 'marker') {
      const mk = hit.marker;
      showMenu([
        { label: '마커 편집…', action: () => openMarkerEditor(mk.id) },
        { label: '마커 삭제', action: () => edit.removeMarker(mk.id) },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'clip') {
      const c = hit.clip;
      if (!store.selection.clips.has(c.id)) store.selectClips([...edit.withGroupsAndLinks([c.id])]);
      const sel = store.selectedClips();
      const ids = sel.map((x2) => x2.id);
      const cb = store.ui.clipboard;
      const isMc = c.kind === 'nest' && c.multicam;
      const mcInner = isMc ? store.project.sequences[store.project.media[c.mediaId]?.sequenceId] : null;
      const srcMid = store.ui.sourceMediaId && store.project.media[store.ui.sourceMediaId] ? store.ui.sourceMediaId : null;
      const binMid = [...store.ui.selectedMedia].find((id) => store.project.media[id]);
      const curBand = bandOf(c, { force: true });
      const visual = c.effects.some((fx) => fx.type === 'motion');
      showMenu([
        { label: '잘라내기', key: 'Ctrl+X', action: () => edit.copySelection(true) },
        { label: '복사', key: 'Ctrl+C', action: () => edit.copySelection() },
        { label: '특성 붙여넣기…', key: 'Ctrl+Alt+V', disabled: !(cb && cb.clips.length >= 1), action: () => openPasteAttributesDialog(cb.clips, ids) },
        { label: '특성 제거…', action: () => openRemoveAttributesDialog(ids) },
        '-',
        { label: '지우기 (빈자리 남김)', key: 'Del', action: () => edit.deleteSelection() },
        { label: '잔물결 삭제 (빈자리 당김)', key: 'Shift+Del', action: () => edit.deleteSelection({ ripple: true }) },
        '-',
        { label: '클립 사용', checked: c.enabled !== false, key: 'Shift+E', action: () => edit.setEnabled(ids, !(c.enabled !== false)) },
        c.linkId ? { label: '연결 해제 (영상/소리 따로)', key: 'Ctrl+L', action: () => edit.unlinkClips(ids) } : { label: '연결 (함께 움직이기)', key: 'Ctrl+L', disabled: ids.length < 2, action: () => edit.linkClips(ids) },
        { label: '이름 바꾸기…', action: async () => { const n = await promptDialog('클립 이름 바꾸기', '이름', c.name); if (n != null) edit.renameClip(c.id, n); } },
        { label: '레이블 색상', submenu: LABEL_COLORS.map(([col, n]) => ({ label: n, swatch: col || 'transparent', checked: (c.label || '') === col, action: () => edit.setLabel([...edit.withLinked(ids)], col) })) },
        '-',
        { label: '오디오 추출 (이 클립의 소리를 새 파일로)…', disabled: !(c.mediaId && ['video', 'audio'].includes(store.project.media[c.mediaId]?.kind) && store.project.media[c.mediaId]?.hasAudio), action: () => openExtractAudioDialog({ clipId: c.id }) },
        '-',
        { label: '그룹', key: 'Ctrl+G', disabled: ids.length < 2, action: () => edit.groupClips(ids) },
        { label: '그룹 해제', key: 'Ctrl+Shift+G', disabled: !sel.some((x2) => x2.groupId), action: () => edit.ungroupClips(ids) },
        { label: '다음으로 바꾸기', disabled: !c.mediaId, submenu: [
          { label: '소스 모니터', disabled: !srcMid, action: () => edit.replaceClipMedia([...edit.withLinked(ids)], srcMid, { inPoint: store.project.media[srcMid]?.inPoint ?? 0 }) },
          { label: '저장소 항목', disabled: !binMid, action: () => edit.replaceClipMedia([...edit.withLinked(ids)], binMid) },
        ] },
        '-',
        { label: '속도/지속 시간…', key: 'Ctrl+R', action: () => openSpeedDialog(ids) },
        { label: '프레임 고정 옵션…', disabled: c.kind !== 'video', action: () => openFrameHoldOptionsDialog(ids) },
        // as in Premiere, the playhead has to be over the clip (the frame there is held)
        { label: '프레임 고정 추가', disabled: c.kind !== 'video' || store.ui.playhead < c.start - EPS || store.ui.playhead >= clipEnd(c) - EPS, action: () => edit.addFrameHold(store.seq.clips[c.id]) },
        { label: '프레임 고정 세그먼트 삽입', disabled: c.kind !== 'video' || store.ui.playhead < c.start || store.ui.playhead > clipEnd(c), action: () => edit.insertFrameHoldSegment(store.seq.clips[c.id], store.ui.playhead, 2) },
        { label: '역재생', checked: !!c.reverse, disabled: !isTimed(c), action: () => edit.toggleReverse(ids) },
        { label: '속도 램프 (시간 다시 매핑) 편집', disabled: !c.effects.some((fx) => fx.type === 'timeRemap'), action: () => store.emit('reveal-effect-controls') },
        '-',
        // same path as the menus and Shift+D, so the transition picked with '기본 전환으로 설정' is used
        { label: '기본 전환 넣기', key: 'Shift+D', action: () => import('../commands.js').then(({ commands }) => commands.applyDefaultTransitions()) },
        { label: '중첩 (하나로 묶기)…', action: async () => { const n = await promptDialog('중첩 시퀀스 이름', '이름', `중첩 시퀀스 ${Object.keys(store.project.sequences).length}`); if (n != null) edit.nestSelection(n); } },
        c.kind === 'nest' ? { label: '중첩 시퀀스 열기', action: () => store.openSequence(store.project.media[c.mediaId]?.sequenceId) } : null,
        isMc && mcInner ? { label: '멀티캠 앵글', submenu: videoTracks(mcInner).map((tr, i) => ({ label: `앵글 ${i + 1} (${tr.name})`, key: String(i + 1), checked: c.multicam.angle === i + 1, action: () => {
          store.setPlayhead(Math.max(store.ui.playhead, c.start));
          store.transact(`앵글 ${i + 1}(으)로 전환`, () => { const cc = store.seq.clips[c.id]; if (cc) cc.multicam = { angle: i + 1 }; });
        } })) } : null,
        { label: '프레임 크기로 비율 조정', disabled: !visual, checked: !!edit.fitScaleOf(c) && !c.native, action: () => edit.setClipsToFrameSize(ids, '프레임 크기로 비율 조정') },
        { label: '프레임 크기로 설정', disabled: !visual, action: () => edit.setClipsToFrameSize(ids, '프레임 크기로 설정') },
        { label: '화면 채우기 (비율 맞춰 확대)', disabled: !(c.kind === 'video' || c.kind === 'image' || c.kind === 'nest'), action: () => scaleToFill(sel) },
        // Premiere's nesting: 클립 키프레임 표시 ▸ 시간 다시 매핑 ▸ 속도 (one submenu per effect)
        { label: '클립 키프레임 표시', submenu: () => {
          const groups = new Map();
          for (const ch of bandChoices(c)) {
            if (!groups.has(ch.fx.id)) groups.set(ch.fx.id, { name: ch.fxName, items: [] });
            groups.get(ch.fx.id).items.push({
              label: ch.def.label, checked: !!curBand && curBand.fx.id === ch.fx.id && curBand.key === ch.key,
              action: () => showBandFor(c.id, ch.fx.type, ch.key),
            });
          }
          return [...groups.values()].map((g) => ({ label: g.name, checked: g.items.some((it) => it.checked) || undefined, submenu: () => g.items }));
        } },
        { label: '모션 초기화', disabled: !c.effects.some((fx) => fx.type === 'motion'), action: () => { for (const id of ids) { const fx = store.seq.clips[id]?.effects.find((f) => f.type === 'motion'); if (fx) edit.resetEffect(id, fx.id); } } },
        '-',
        // 프로젝트에서 표시 (Premiere's Reveal in Project): a clip from a subclip shows the subclip
        { label: '프로젝트에서 표시', disabled: !c.mediaId, action: () => { const id = store.project.media[c.subclip?.id] ? c.subclip.id : c.mediaId; store.ui.selectedMedia = new Set([id]); store.emit('reveal-media', id); } },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'track') {
      const clips = clipsOnTrack(s, hit.row.track.id);
      const prev = clips.filter((c) => clipEnd(c) <= hit.t).pop();
      const next = clips.find((c) => c.start >= hit.t);
      showMenu([
        { label: '잔물결 삭제', hint: '이 빈 공간 메우기', disabled: !next, action: () => { store.selectGap({ trackId: hit.row.track.id, start: prev ? clipEnd(prev) : 0, end: next.start }); edit.deleteSelection(); } },
        { label: '여기에 붙여넣기', key: 'Ctrl+V', disabled: !store.ui.clipboard, action: () => { store.setPlayhead(snapFrame(hit.t, fps())); edit.paste(); } },
        '-',
        { label: '비디오 트랙 추가', action: () => edit.addTrack('video') },
        { label: '오디오 트랙 추가', action: () => edit.addTrack('audio') },
        { label: '간격 닫기', hint: '모든 빈 공간 메우기', action: () => edit.closeAllGaps() },
      ], e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'ruler') {
      const mk = rulerMarkerAt(x);
      showMenu([
        { label: '마커 추가', key: 'M', action: () => edit.addMarker(snapFrame(tOf(x), fps())) },
        { label: '챕터 마커 추가…', action: () => { const id = edit.addMarker(snapFrame(tOf(x), fps()), { type: 'chapter', name: '챕터', color: '#f87171' }); if (id) openMarkerEditor(id); } },
        { label: '마커 편집…', disabled: !mk, action: () => openMarkerEditor(mk.id) },
        { label: '마커 색상', disabled: !mk, submenu: () => MARKER_COLORS.map(([col, n]) => ({ label: n, swatch: col, checked: mk.color === col, action: () => edit.updateMarker(mk.id, { color: col }) })) },
        { label: '마커 삭제', disabled: !mk, action: () => edit.removeMarker(mk.id) },
        { label: '마커 모두 지우기', disabled: !s.markers.length, action: () => store.transact('마커 모두 지우기', () => { store.seq.markers = []; }) },
        '-',
        { label: '여기를 시작(In)으로 표시', action: () => edit.setSequenceInOut('in', tOf(x)) },
        { label: '여기를 끝(Out)으로 표시', action: () => edit.setSequenceInOut('out', tOf(x)) },
        { label: '시작·끝 표시 지우기', action: () => store.transact('시작/끝 지우기', () => { store.seq.inPoint = null; store.seq.outPoint = null; }) },
      ], e.clientX, e.clientY);
    }
  }


  /** 클립 키프레임 표시: choose the value the clip's rubber band shows (not an undoable edit). */
  function showBandFor(clipId, type, key) {
    const c = store.seq.clips[clipId];
    if (!c) return;
    c.band = { type, key };
    const kind = c.kind === 'audio' ? 'audio' : 'video';
    if (!view.showKf[kind]) {
      view.showKf[kind] = true;
      savePref('tl.showKf', view.showKf);
    }
    store.changed();
  }

  function scaleToFill(clips) {
    const s = store.seq;
    store.transact('화면 채우기', () => {
      for (const c0 of clips) {
        const c = store.seq.clips[c0.id];
        const m = c && store.project.media[c.mediaId];
        const motion = c?.effects.find((e) => e.type === 'motion');
        if (!m?.width || !motion) continue;
        const fit = Math.min(s.width / m.width, s.height / m.height);
        const fill = Math.max(s.width / m.width, s.height / m.height);
        // a clip that keeps its own pixels (프레임 크기로 설정) is sized from 100 % = native
        motion.params.scale.value = Math.round((fill / (c.native ? 1 : fit)) * 1000) / 10;
        motion.params.scale.kf = null;
      }
    });
  }

  // ---------------------------------------------------------------- wheel

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x } = localPos(e);
    if (e.altKey || e.ctrlKey || e.metaKey) {
      setZoom(view.pps * Math.pow(1.0015, -e.deltaY), x);
    } else if (e.shiftKey) {
      setScrollY(view.scrollY + e.deltaY);
    } else {
      // like Premiere: the wheel scrolls time; Shift+wheel scrolls tracks
      setScrollX(view.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
    }
  }, { passive: false });
  headers.addEventListener('wheel', (e) => {
    e.preventDefault();
    setScrollY(view.scrollY + e.deltaY);
  }, { passive: false });

  // ---------------------------------------------------------------- drag & drop

  function dropKindsFor(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('application/x-montage-media')) return 'media';
    if (types.includes('application/x-montage-effect')) return 'effect';
    if (types.includes('application/x-montage-template')) return 'template';
    if (types.includes('Files')) return 'files';
    return null;
  }

  function mediaPlacement(payload, x, y, insert) {
    const s = store.seq;
    const m = store.project.media[payload.mediaId];
    if (!m || m.kind === 'lut' || m.kind === 'font') return null;
    const row = rowAtY(y);
    const inP = payload.inPoint ?? m.inPoint ?? 0;
    const outP = payload.outPoint ?? m.outPoint ?? (m.duration ?? inP + 5);
    const duration = Math.max(1 / s.fps, outP - inP);
    let start = Math.max(0, snapFrame(tOf(x), s.fps));
    const sd = snapDelta([start, start + duration], snapCandidates());
    start = Math.max(0, start + sd.delta);
    const vts = videoTracks(s);
    const ats = audioTracks(s);
    let vIdx = 0;
    let aIdx = 0;
    if (row) {
      if (row.track.kind === 'video') vIdx = aIdx = vts.indexOf(row.track);
      else vIdx = aIdx = ats.indexOf(row.track);
    }
    const wantV = payload.video !== false && m.kind !== 'audio';
    const wantA = payload.audio !== false && (m.kind === 'audio' || ((m.kind === 'video' || m.kind === 'sequence') && m.hasAudio));
    const vTrack = wantV ? vts[Math.min(vIdx, vts.length - 1)] : null;
    const aTrack = wantA ? ats[Math.min(aIdx, ats.length - 1)] : null;
    const ghosts = [];
    if (vTrack) ghosts.push({ trackId: vTrack.id, start, duration });
    if (aTrack) ghosts.push({ trackId: aTrack.id, start, duration });
    return { start, duration, vTrack, aTrack, ghosts, insert, inPoint: inP, outPoint: outP, snapAt: sd.at };
  }

  wrap.addEventListener('dragover', (e) => {
    const kind = dropKindsFor(e);
    if (!kind) return;
    e.preventDefault();
    const { x, y } = localPos(e);
    if (kind === 'media') {
      const first = dnd.payload?.items?.[0];
      const hit = e.altKey ? hitTest(x, y) : null;
      if (first && hit?.area === 'clip' && hit.clip.mediaId) {
        // Alt: 바꾸기 편집 — the dropped media replaces this clip
        dropPreview = { ghosts: [{ trackId: hit.clip.trackId, start: hit.clip.start, duration: hit.clip.duration }], replace: true, start: hit.clip.start };
        e.dataTransfer.dropEffect = 'copy';
      } else if (first) {
        dropPreview = mediaPlacement(first, x, y, modKey(e));
        if (dropPreview && dnd.payload.items.length > 1) {
          const total = dnd.payload.items.reduce((acc, it) => acc + (mediaPlacement(it, x, y, false)?.duration || 0), 0);
          for (const g of dropPreview.ghosts) g.duration = total;
        }
        e.dataTransfer.dropEffect = 'copy';
      }
    } else if (kind === 'effect') {
      const hit = hitTest(x, y);
      e.dataTransfer.dropEffect = hit.area === 'clip' ? 'copy' : 'none';
      dropPreview = null;
      if (hit.area === 'clip') store.selectClips([hit.clip.id]);
    } else {
      e.dataTransfer.dropEffect = 'copy';
      dropPreview = { ghosts: [], start: tOf(x) };
    }
    requestDraw();
  });
  wrap.addEventListener('dragleave', () => {
    dropPreview = null;
    requestDraw();
  });
  wrap.addEventListener('drop', async (e) => {
    const kind = dropKindsFor(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = localPos(e);
    dropPreview = null;
    if (kind === 'media') {
      let payload = dnd.payload;
      try { payload = JSON.parse(e.dataTransfer.getData('application/x-montage-media')) || payload; } catch { /* use shared payload */ }
      const list = payload?.items || [];
      const target = e.altKey ? hitTest(x, y) : null;
      if (target?.area === 'clip' && target.clip.mediaId && list[0]) {
        // Alt-drag onto a clip = 바꾸기 편집 (keeps the clip's place, length and effects)
        const ids = store.ui.linkedSelection ? [...edit.withLinked([target.clip.id])] : [target.clip.id];
        edit.replaceClipMedia(ids, list[0].mediaId, list[0].inPoint != null ? { inPoint: list[0].inPoint } : {});
        dnd.payload = null;
        invalidate();
        return;
      }
      let px = x;
      for (const item of list) {
        const pl = mediaPlacement(item, px, y, modKey(e));
        if (!pl) continue;
        edit.placeMedia(item.mediaId, {
          mode: modKey(e) ? 'insert' : 'overwrite', start: pl.start, vTrackId: pl.vTrack?.id, aTrackId: pl.aTrack?.id,
          inPoint: pl.inPoint, outPoint: pl.outPoint, video: item.video, audio: item.audio,
        });
        px = xOf(pl.start + pl.duration);
      }
      canvas.focus();
      store.setFocus('timeline');
    } else if (kind === 'effect') {
      let payload = null;
      try { payload = JSON.parse(e.dataTransfer.getData('application/x-montage-effect')); } catch { /* ignore */ }
      const hit = hitTest(x, y);
      if (!payload || hit.area !== 'clip') return;
      if (payload.preset) {
        const preset = getPreset(payload.preset);
        const ids = store.selection.clips.has(hit.clip.id) ? [...store.selection.clips] : [hit.clip.id];
        if (preset && applyPreset(ids, preset)) {
          store.selectClips([hit.clip.id]);
          store.emit('reveal-effect-controls');
        } else toast('이 클립에는 그 프리셋을 적용할 수 없습니다');
      } else if (payload.transition) {
        const c = hit.clip;
        const rel = (hit.t - c.start) / c.duration;
        edit.applyTransition(c.id, rel < 0.5 ? 'in' : 'out', payload.type, 1);
      } else {
        const ids = store.selection.clips.has(hit.clip.id) ? [...store.selection.clips] : [hit.clip.id];
        edit.addEffect(ids, payload.type);
        store.selectClips([hit.clip.id]);
        store.emit('reveal-effect-controls');
      }
    } else if (kind === 'template') {
      // a title template from 기본 그래픽 ▸ 찾아보기 goes in where it is dropped
      const id = e.dataTransfer.getData('application/x-montage-template') || dnd.payload?.template;
      const row = rowAtY(y);
      if (id) (await import('../templates.js')).insertTemplate(id, Math.max(0, snapFrame(tOf(x), fps())), { trackId: row?.track.kind === 'video' ? row.track.id : null });
    } else if (kind === 'files') {
      const files = [...e.dataTransfer.files];
      const ids = await importFiles(files);
      let t = Math.max(0, snapFrame(tOf(x), fps()));
      for (const id of ids) {
        if (mediaStatus(id) !== 'ready' || ['lut', 'font'].includes(store.project.media[id]?.kind)) continue;
        const pl = mediaPlacement({ mediaId: id }, xOf(t), y, false);
        if (!pl) continue;
        edit.placeMedia(id, { mode: 'overwrite', start: t, vTrackId: pl.vTrack?.id, aTrackId: pl.aTrack?.id });
        t += pl.duration;
      }
    }
    dnd.payload = null;
    invalidate();
  });

  // ---------------------------------------------------------------- subscriptions

  function fullRefresh() {
    renderSeqTabs();
    layoutRows();
    renderHeaders();
    refreshTopBar();
    syncScrollbars();
    invalidate();
  }

  store.on('change', fullRefresh);
  store.on('selection', invalidate);
  store.on('tool', () => updateHover(-100, -100, {}));
  store.on('recording', renderHeaders);
  window.addEventListener('montage:uiscale', () => {
    SC = uiScale();
    invalidate();
  });
  mediaEvents.on('updated', invalidate);
  store.on('playhead', () => {
    tcEl.textContent = formatTimecode(store.ui.playhead, fps());
    // 자동 스크롤: page (Premiere's default) turns the page when the playhead leaves the view, smooth
    // keeps it in the middle while playing; outside playback the playhead is brought back into view
    const px = xOf(store.ui.playhead);
    const mode = playback.playing ? view.autoScroll : 'page';
    if (view.width > 0 && !drag && mode !== 'none') {
      if (mode === 'smooth' && store.ui.playhead * view.pps > view.width / 2) setScrollX(store.ui.playhead * view.pps - view.width / 2);
      else if (px > view.width - 10 || px < 0) {
        const back = playback.playing ? playback.rate < 0 : px < 0;
        setScrollX(back ? store.ui.playhead * view.pps - view.width + 30 : store.ui.playhead * view.pps - 10);
      }
    }
    requestDraw();
  });
  window.addEventListener('resize', () => {
    invalidate();
  });
  new ResizeObserver(() => invalidate()).observe(wrap);

  // Delete with a rubber-band keyframe selected removes the keyframe, not the clip
  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selKey && !e.shiftKey && !e.altKey) {
      if (deleteSelectedKey()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });
  store.on('selection', () => {
    if (selKey && !store.selection.clips.has(selKey.clipId)) selKey = null;
    // the selected edit point goes with a selection that no longer holds its clips
    const ep = store.ui.editPoint;
    if (ep && !(ep.ids.length && ep.ids.every((id) => store.selection.clips.has(id)))) store.ui.editPoint = null;
  });
  store.on('sequence', () => {
    store.ui.editPoint = null;
  });

  Object.assign(timelineApi, {
    trackHeights,
    zoomIn: () => setZoom(view.pps * 1.5, xOf(store.ui.playhead) >= 0 && xOf(store.ui.playhead) <= view.width ? xOf(store.ui.playhead) : view.width / 2),
    zoomOut: () => setZoom(view.pps / 1.5, xOf(store.ui.playhead) >= 0 && xOf(store.ui.playhead) <= view.width ? xOf(store.ui.playhead) : view.width / 2),
    zoomToFit,
    toggleSnap,
    focus: () => canvas.focus(),
    revealPlayhead: () => {
      const px = xOf(store.ui.playhead);
      if (px < 0 || px > view.width) setScrollX(store.ui.playhead * view.pps - view.width / 2);
    },
    view,
  });

  fullRefresh();
  // menu entries for the timeline features (loaded after the menu bar exists)
  import('./timeline-menus.js').catch((err) => console.error('timeline menus', err));
  return root;
}

// styles for the header controls added here (kept with the code that uses them)
if (typeof document !== 'undefined' && !document.getElementById('tl-extra-style')) {
  const st = document.createElement('style');
  st.id = 'tl-extra-style';
  st.textContent = `
.track-header button.src-patch { width: calc(22px * var(--ui-scale)); height: calc(18px * var(--ui-scale)); border: 1px solid var(--line-2); border-radius: 4px; font-size: calc(10px * var(--ui-scale)); color: var(--text-faint); flex-shrink: 0; }
.track-header button.src-patch.on { background: #2f6fc0; border-color: #2f6fc0; color: #fff; }
.track-header { overflow: visible; }
body.mobile .track-header button.src-patch { display: none; }
`;
  document.head.append(st);
}

// Project panel: imported media with bins (folders), label colours, list view with sortable
// columns (이름, 프레임 속도, 미디어 시작/끝, 지속 시간, 비디오 정보, 레이블), icon view with hover
// scrub and poster frames, search, subclips, new items (새 항목) and drag to the timeline.

import { store } from '../store.js';
import { runtime, mediaEvents, importFiles, createSyntheticMedia, removeMedia, attachFile, mediaStatus, mediaUrl } from '../media.js';
import * as edit from '../edit.js';
import { relinkFromFiles } from '../persist.js';
import { LABEL_COLORS, DEFAULT_STILL_DURATION } from '../model.js';
import { h, uid, clamp, once, formatTimecode, formatShort, formatBytes, modKey } from '../util.js';
import { showMenu, openModal, promptDialog, confirmDialog, loadPref, savePref, toast, dnd, showPanel } from './common.js';
import { icon, iconButton } from './icons.js';
import { extendMenu } from './menubar.js';
import { injectStyle } from './style-inject.js';
import {
  openColorMatteDialog, openMulticamDialog, openExtractAudioDialog, openNewSequenceDialog, openBarsToneDialog, openCountingLeaderDialog,
  openSubclipDialog, openEditSubclipDialog,
} from './dialogs.js';
import { createTransparentVideo } from '../generated-media.js';
import { noteFontUsed } from '../fonts.js';
import { isSubclip, fileIdOf, itemRange, subclipsOf } from '../subclips.js';

const KIND_NAMES = { video: '영상', audio: '오디오', image: '이미지', color: '색상 매트', adjustment: '조정 레이어', sequence: '시퀀스', lut: 'LUT', font: '글꼴' };
const KIND_ICONS = { video: 'film', audio: 'audio', image: 'image', adjustment: 'wand', sequence: 'sequence', lut: 'grid', color: 'image', font: 'type' };
const CHECKER = 'repeating-conic-gradient(#8a8a8a 0% 25%, #c8c8c8 0% 50%) 0 0 / 10px 10px';
const isTransparentColor = (c) => /^(transparent|rgba\([^)]*,\s*0\s*\)|#[0-9a-f]{6}00)$/i.test(String(c || '').trim());

/** 목록 보기 columns: [key, header, width]. */
const COLUMNS = [
  ['name', '이름', 'minmax(150px, 2fr)'],
  ['fps', '프레임 속도', '84px'],
  ['start', '미디어 시작', '96px'],
  ['end', '미디어 끝', '96px'],
  ['dur', '미디어 지속 시간', '104px'],
  ['video', '비디오 정보', '112px'],
  ['label', '레이블', '72px'],
];
const GRID_COLS = `40px ${COLUMNS.map((c) => c[2]).join(' ')}`;

injectStyle('pp-style', `
.project-list.cols { overflow: auto; }
.pp-head, .project-list.cols .media-item:not(.bin) { display: grid; grid-template-columns: ${GRID_COLS}; gap: 0 8px; min-width: 860px; }
.pp-head { position: sticky; top: 0; z-index: 2; background: var(--bg-3, #23262c); border-bottom: 1px solid var(--line); padding: 0 10px; }
.pp-head button { min-height: 0; height: calc(24px * var(--ui-scale)); padding: 0 2px; border: 0; background: none; color: var(--text-dim); font-size: var(--fs-xs); text-align: left; justify-content: flex-start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-head button.on { color: var(--value); }
.pp-head button .ico { margin-left: 2px; }
.project-list.cols .media-item { padding: 3px 10px; min-width: 860px; box-sizing: border-box; }
.project-list.cols .media-item .thumb { width: 40px; height: 24px; }
.project-list.cols .media-item .col { color: var(--text-dim); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.project-list.cols .media-item .col.lbl { display: flex; align-items: center; gap: 4px; }
.project-list.cols .media-item.bin { min-width: 860px; box-sizing: border-box; }
.project-list.cols .media-item.in-bin { padding-left: 30px; }
.media-item .sub-tag { font-size: 10px; border: 1px solid var(--line-2); border-radius: 3px; padding: 0 3px; color: var(--text-dim); flex-shrink: 0; }
.media-item.flash { animation: pp-flash 1.2s ease-out; }
@keyframes pp-flash { 0% { box-shadow: inset 0 0 0 2px var(--value); } 100% { box-shadow: inset 0 0 0 2px transparent; } }
.media-item .thumb.poster { position: relative; }
.media-item.bin .twisty { display: grid; place-items: center; }
.project-list.grid .media-item .meta { overflow: hidden; text-overflow: ellipsis; }
.project-list.cols .media-item:not(.bin) > .thumb, .project-list.cols .media-item:not(.bin) > .name, .pp-head > span:first-child, .pp-head > button:nth-child(2) { position: sticky; z-index: 1; background: var(--bg-3); }
.project-list.cols .media-item:not(.bin) > .thumb, .pp-head > span:first-child { left: 0; }
.project-list.cols .media-item:not(.bin) > .name, .pp-head > button:nth-child(2) { left: 48px; box-shadow: 6px 0 6px -6px rgba(0,0,0,.6); }
.project-list.cols .media-item:hover > .thumb, .project-list.cols .media-item:hover > .name { background: var(--bg-4); }
.project-list.cols .media-item.selected > .thumb, .project-list.cols .media-item.selected > .name { background: var(--sel); }
.project-list.cols .media-item.in-bin > .name { left: 48px; }
`);

export const projectApi = {};

export function pickFiles({ accept = 'video/*,audio/*,image/*,.cube,.ttf,.otf,.woff,.woff2', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export async function importDialog() {
  const files = await pickFiles();
  if (files.length) await importFiles(files);
}

// ---------------------------------------------------------------- item details (columns)

const fpsOf = (m) => (m.kind === 'sequence' ? store.project.sequences[m.sequenceId]?.fps : m.fps) || null;
const isTimedItem = (m) => ['video', 'audio', 'sequence'].includes(m.kind) && Number.isFinite(m.duration);
const isStill = (m) => ['image', 'color', 'adjustment'].includes(m.kind);

/** Duration shown for an item (subclips: their range; stills: the default still duration). */
export function itemDuration(m) {
  if (isSubclip(m)) return (m.subOut ?? 0) - (m.subIn ?? 0);
  if (isTimedItem(m)) return m.duration;
  if (isStill(m)) return DEFAULT_STILL_DURATION;
  return null;
}

function mediaStartOf(m) {
  if (isSubclip(m)) return m.subIn ?? 0;
  return isTimedItem(m) || isStill(m) ? 0 : null;
}

/** Media End is the last frame (inclusive), like Premiere. */
function mediaEndOf(m) {
  const d = itemDuration(m);
  const s = mediaStartOf(m);
  if (d == null || s == null) return null;
  const fps = fpsOf(m) || store.seq.fps;
  return Math.max(s, s + d - 1 / fps);
}

const labelIndex = (m) => Math.max(0, LABEL_COLORS.findIndex(([c]) => c === (m.label || '')));
const labelName = (m) => LABEL_COLORS.find(([c]) => c === (m.label || ''))?.[1] || '';

function columnText(m, key) {
  const fps = fpsOf(m) || store.seq.fps;
  const tc = (t) => (t == null ? '' : formatTimecode(t, fps));
  switch (key) {
    case 'fps': return fpsOf(m) ? `${Math.round(fpsOf(m) * 1000) / 1000} fps` : '';
    case 'start': return tc(mediaStartOf(m));
    case 'end': return tc(mediaEndOf(m));
    case 'dur': return tc(itemDuration(m));
    case 'video': return m.width && m.height && !['audio', 'lut', 'font', 'adjustment'].includes(m.kind) ? `${m.width} × ${m.height}` : m.kind === 'audio' ? '오디오만' : '';
    default: return '';
  }
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }),
  fps: (a, b) => (fpsOf(a) || 0) - (fpsOf(b) || 0),
  start: (a, b) => (mediaStartOf(a) ?? -1) - (mediaStartOf(b) ?? -1),
  end: (a, b) => (mediaEndOf(a) ?? -1) - (mediaEndOf(b) ?? -1),
  dur: (a, b) => (itemDuration(a) ?? -1) - (itemDuration(b) ?? -1),
  video: (a, b) => (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0),
  label: (a, b) => labelIndex(a) - labelIndex(b),
};

// ---------------------------------------------------------------- poster frames (exact frame grabs)

const posterCache = new Map(); // `${fileId}@${t}` -> canvas | 'pending' | 'failed'
let posterQueue = Promise.resolve();
let onPosterReady = () => {};

async function grabFrame(fileId, t) {
  const url = mediaUrl(fileId);
  if (!url) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    if (!(await once(v, 'loadeddata', 10000))) return null;
    v.currentTime = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.02));
    if (!(await once(v, 'seeked', 10000))) return null;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.max(1, Math.round((160 * (v.videoHeight || 9)) / (v.videoWidth || 16)));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

/** The thumbnail at media time t of an item's file (null until grabbed; re-renders when ready). */
function frameThumb(fileId, t) {
  const key = `${fileId}@${t.toFixed(3)}`;
  const hit = posterCache.get(key);
  if (hit instanceof HTMLCanvasElement) return hit;
  if (hit) return null;
  if (mediaStatus(fileId) !== 'ready') return null;
  posterCache.set(key, 'pending');
  posterQueue = posterQueue.then(() => grabFrame(fileId, t)).then((c) => {
    posterCache.set(key, c || 'failed');
    if (c) onPosterReady();
  }).catch(() => posterCache.set(key, 'failed'));
  return null;
}

// ---------------------------------------------------------------- panel

export function createProjectPanel() {
  let mode = loadPref('project.view', 'list');
  let filter = '';
  let anchor = null;
  let sort = loadPref('project.sort', { key: 'none', dir: 1 });
  const closedBins = new Set(loadPref('bins.closed', []));
  const hoverT = new Map(); // id -> media time last hover-scrubbed in icon view

  const search = h('input', { type: 'search', placeholder: '이름 검색', style: { width: '130px' }, 'aria-label': '미디어 검색' });
  const viewBtn = iconButton(mode === 'list' ? 'grid' : 'list', mode === 'list' ? '아이콘 보기로 바꾸기' : '목록 보기로 바꾸기', () => {
    mode = mode === 'list' ? 'grid' : 'list';
    viewBtn.replaceChildren(icon(mode === 'list' ? 'grid' : 'list'));
    viewBtn.title = mode === 'list' ? '아이콘 보기로 바꾸기' : '목록 보기로 바꾸기';
    savePref('project.view', mode);
    render();
  });
  const sortBtn = iconButton('sliders', '정렬', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(sortMenu(), r.left, r.bottom + 2);
  });
  const importBtn = iconButton('import', '파일 가져오기 (Ctrl+I)', () => importDialog(), { label: '가져오기', cls: 'boxed' });
  const binBtn = iconButton('folderPlus', '새 저장소(폴더) 만들기', () => newBin());
  const newBtn = iconButton('plus', '새 항목 (시퀀스, 조정 레이어, 바 및 톤, 블랙 비디오, 색상 매트, 카운트다운 리더, 투명 비디오)', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(newItemMenu(), r.left, r.bottom + 2);
  }, { label: '새 항목', cls: 'boxed' });
  const toolbar = h('div.panel-toolbar', importBtn, newBtn, binBtn, h('span.grow'), search, sortBtn, viewBtn);
  const list = h('div.project-list', { tabindex: 0, 'aria-label': '프로젝트 미디어 목록' });
  const footer = h('div.panel-footer');
  const body = h('div', toolbar, list, footer);

  search.addEventListener('input', () => {
    filter = search.value.toLowerCase();
    render();
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());

  // file drop
  list.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      list.classList.add('drop');
    }
  });
  list.addEventListener('dragleave', () => list.classList.remove('drop'));
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    importFiles([...e.dataTransfer.files]);
  });
  list.addEventListener('pointerdown', (e) => {
    store.setFocus('project');
    if (e.target === list) {
      store.ui.selectedMedia.clear();
      render();
    }
  });
  list.addEventListener('contextmenu', (e) => {
    if (e.target !== list) return;
    e.preventDefault();
    showMenu([{ label: '가져오기…', key: 'Ctrl+I', action: importDialog }, { label: '새 저장소(폴더)…', action: newBin }, { label: '새 항목', submenu: newItemMenu }, '-', ...sortMenu()], e.clientX, e.clientY);
  });
  list.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.ui.selectedMedia.size) {
      e.preventDefault();
      e.stopPropagation();
      clearSelected();
    }
    if (e.key === 'Enter' && store.ui.selectedMedia.size) openInSource([...store.ui.selectedMedia][0]);
  });

  function newItemMenu() {
    return [
      { label: '시퀀스…', action: openNewSequenceDialog },
      { label: '조정 레이어', action: () => select(createSyntheticMedia('adjustment', { name: '조정 레이어' })) },
      { label: '바 및 톤…', action: openBarsToneDialog },
      { label: '블랙 비디오', action: () => select(createSyntheticMedia('color', { name: '블랙 비디오', color: '#000000' })) },
      { label: '색상 매트…', action: openColorMatteDialog },
      { label: '범용 카운트다운 리더…', action: openCountingLeaderDialog },
      { label: '투명 비디오', action: () => select(createTransparentVideo()) },
      '-',
      { group: '그래픽 (재생헤드 위치)' },
      { label: '텍스트', action: () => edit.addTextClip() },
      { label: '사각형', action: () => edit.addShapeClip('rectangle') },
      { label: '원', action: () => edit.addShapeClip('ellipse') },
    ];
  }

  function sortMenu() {
    return [
      { group: '정렬' },
      { label: '가져온 순서', checked: sort.key === 'none', action: () => setSort('none') },
      ...COLUMNS.map(([k, label]) => ({ label: `${label}${sort.key === k ? (sort.dir > 0 ? ' (오름차순)' : ' (내림차순)') : ''}`, checked: sort.key === k, action: () => setSort(k, sort.key === k ? -sort.dir : 1) })),
    ];
  }

  function setSort(key, dir = 1) {
    sort = { key, dir };
    savePref('project.sort', sort);
    render();
  }

  function select(id) {
    if (!id) return;
    store.ui.selectedMedia = new Set([id]);
    reveal(id);
  }

  // ---- bins
  async function newBin() {
    const n = await promptDialog('새 저장소', '저장소 이름', `저장소 ${Object.keys(store.project.bins || {}).length + 1}`);
    if (!n) return;
    const id = uid('bin');
    const ids = [...store.ui.selectedMedia];
    store.transact('저장소 만들기', () => {
      store.project.bins = store.project.bins || {};
      store.project.bins[id] = { id, name: n };
      for (const mid of ids) if (store.project.media[mid]) store.project.media[mid].bin = id;
    });
  }

  function moveToBin(ids, binId) {
    store.transact(binId ? '저장소로 옮기기' : '저장소에서 꺼내기', () => {
      for (const id of ids) {
        const m = store.project.media[id];
        if (m) m.bin = binId || null;
      }
    });
  }

  function deleteBin(binId) {
    store.transact('저장소 삭제', () => {
      delete store.project.bins[binId];
      for (const m of Object.values(store.project.media)) if (m.bin === binId) m.bin = null;
    });
  }

  function setMediaLabel(ids, color) {
    store.transact('레이블 색상', () => {
      for (const id of ids) if (store.project.media[id]) store.project.media[id].label = color || null;
    });
  }

  async function clearSelected() {
    let ids = [...store.ui.selectedMedia].filter((id) => store.project.media[id]);
    // a master's subclips share its file: they go with it
    const subs = ids.flatMap((id) => subclipsOf(id)).filter((id) => !ids.includes(id));
    ids = [...ids, ...subs];
    const used = Object.values(store.project.sequences).flatMap((sq) => Object.values(sq.clips)).filter((c) => ids.includes(c.mediaId)).length;
    const parts = [];
    if (used) parts.push(`이 미디어를 쓰는 클립 ${used}개도 시퀀스에서 함께 지워집니다.`);
    if (subs.length) parts.push(`이 파일로 만든 하위 클립 ${subs.length}개도 함께 지워집니다.`);
    if (parts.length && !(await confirmDialog('미디어 지우기', `${parts.join(' ')} 계속할까요?`))) return;
    removeMedia(ids);
    store.ui.selectedMedia.clear();
  }

  async function openImageInPhoto(id) {
    const m = store.project.media[id];
    const img = runtime.get(id)?.image;
    if (!m || !img) return toast('이미지를 아직 불러오지 못했습니다');
    const [{ canvasFromImage }, { openInPhoto }] = await Promise.all([import('../photo/io.js'), import('../mode.js')]);
    await openInPhoto(canvasFromImage(img), m.name.replace(/\.[^.]+$/, ''), id);
  }

  function openInSource(id) {
    const m = store.project.media[id];
    if (!m) return;
    if (m.kind === 'lut') {
      toast('LUT는 클립에 적용해서 씁니다: 클립을 선택하고 오른쪽 클릭 ▸ 선택한 클립에 LUT 적용');
      return;
    }
    if (m.kind === 'font') {
      toast(`"${m.fontFamily || m.name}" 글꼴은 텍스트 클립의 효과 컨트롤 ▸ 글꼴 목록(내 글꼴)에서 고를 수 있습니다`);
      return;
    }
    store.ui.sourceMediaId = id;
    store.ui.sourceSeek = null;
    store.emit('source');
    showPanel('source', { quiet: true });
  }

  function applyFont(id) {
    const family = store.project.media[id]?.fontFamily;
    const ids = store.selectedClips().filter((c) => c.kind === 'text').map((c) => c.id);
    if (!family) return;
    if (!ids.length) {
      toast('타임라인에서 글꼴을 바꿀 텍스트 클립을 먼저 선택하세요');
      return;
    }
    store.transact('글꼴 적용', () => {
      for (const cid of ids) {
        const fx = store.seq.clips[cid]?.effects.find((e) => e.type === 'text');
        if (fx) {
          fx.params.font.value = family;
          fx.params.font.kf = null;
        }
      }
    });
    noteFontUsed(family);
    store.emit('reveal-effect-controls');
  }

  function applyLut(id) {
    const ids = store.selectedClips().filter((c) => c.kind !== 'audio').map((c) => c.id);
    if (!ids.length) {
      toast('타임라인에서 LUT를 적용할 클립을 먼저 선택하세요');
      return;
    }
    // one undo step: adding the effect and choosing the LUT
    const mark = store.undoMark();
    for (const cid of ids) {
      const c = store.seq.clips[cid];
      if (c && !c.effects.some((e) => e.type === 'lut')) edit.addEffect([cid], 'lut');
    }
    store.transact('LUT 적용', () => {
      for (const cid of ids) {
        const fx = store.seq.clips[cid]?.effects.filter((e) => e.type === 'lut').pop();
        if (fx) fx.params.lutId.value = id;
      }
    });
    store.squashSince(mark, 'LUT 적용');
    store.emit('reveal-effect-controls');
  }

  // ---- poster frames

  function setPoster(id, t) {
    store.transact('포스터 프레임 설정', () => {
      const m = store.project.media[id];
      if (m) m.posterTime = Math.round(t * 1000) / 1000;
    });
  }

  // ---- rendering

  let lastSig = '';
  let queued = false;
  function scheduleRender(force = false) {
    if (force) lastSig = '';
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const proj = store.project;
      const mobile = document.body.classList.contains('mobile');
      const sig = [mode, filter, mobile, JSON.stringify(sort), [...store.ui.selectedMedia].join(','), JSON.stringify(proj.bins || {}), ...proj.mediaOrder.map((id) => {
        const m = proj.media[id];
        const rt = runtime.get(fileIdOf(id));
        return m ? `${id}:${m.name}:${m.duration}:${m.width}:${m.fps}:${m.color}:${m.bin}:${m.label}:${m.posterTime}:${m.subIn}:${m.subOut}:${mediaStatus(id)}:${rt?.thumb ? 1 : 0}:${rt?.filmstrip?.length || 0}` : id;
      })].join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      render();
    });
  }
  onPosterReady = () => scheduleRender(true);

  const useColumns = () => mode === 'list' && !document.body.classList.contains('mobile');

  function sorted(ids) {
    if (sort.key === 'none' || !SORTERS[sort.key]) return ids;
    const p = store.project;
    return [...ids].sort((a, b) => SORTERS[sort.key](p.media[a], p.media[b]) * sort.dir || SORTERS.name(p.media[a], p.media[b]));
  }

  function headerRow() {
    const cells = COLUMNS.map(([k, label]) => {
      const on = sort.key === k;
      return h(`button${on ? '.on' : ''}`, { title: `${label} 기준 정렬`, onclick: () => setSort(k, on ? -sort.dir : 1) },
        label, on ? icon(sort.dir > 0 ? 'up' : 'down', 12) : null);
    });
    return h('div.pp-head', h('span'), cells);
  }

  function render() {
    const proj = store.project;
    const bins = proj.bins || {};
    const cols = useColumns();
    list.className = `project-list${mode === 'grid' ? ' grid' : ''}${cols ? ' cols' : ''}`;
    const scroll = [list.scrollLeft, list.scrollTop];
    list.replaceChildren();
    const visible = (id) => proj.media[id] && (!filter || proj.media[id].name.toLowerCase().includes(filter));
    if (!proj.mediaOrder.length) {
      list.append(h('div.empty-hint', h('b', '여기에 영상·소리·사진 파일을 끌어다 놓으세요'), h('br'), '또는 위의 "가져오기" 버튼 / Ctrl+I'));
    } else if (cols) list.append(headerRow());
    const binList = Object.values(bins);
    if (sort.key === 'name') binList.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }) * sort.dir);
    for (const bin of binList) {
      const inBin = proj.mediaOrder.filter((id) => proj.media[id]?.bin === bin.id);
      const shown = sorted(inBin.filter(visible));
      if (filter && !shown.length) continue;
      list.append(renderBin(bin, inBin.length));
      if (!closedBins.has(bin.id) || filter) for (const id of shown) list.append(renderItem(id, true));
    }
    for (const id of sorted(proj.mediaOrder.filter((x) => visible(x) && !(proj.media[x].bin && bins[proj.media[x].bin])))) list.append(renderItem(id, false));
    [list.scrollLeft, list.scrollTop] = scroll;
    const offline = proj.mediaOrder.filter((id) => ['offline', 'error'].includes(mediaStatus(id))).length;
    const nSel = store.ui.selectedMedia.size;
    footer.replaceChildren(...[
      h('span', `항목 ${proj.mediaOrder.length}개${nSel > 1 ? ` · ${nSel}개 선택` : ''}`),
      offline ? h('span', { style: { color: 'var(--danger)' } }, ` · 오프라인 ${offline}개`) : null,
      h('span.grow'),
      offline ? h('button', { onclick: linkMediaDialog }, '미디어 다시 연결…') : null,
    ].filter(Boolean));
  }

  function renderBin(bin, count) {
    const closed = closedBins.has(bin.id) && !filter;
    const twisty = h('span.twisty', icon(closed ? 'chevronRight' : 'chevronDown', 14));
    const el = h('div.media-item.bin', { title: `${bin.name} — 항목을 끌어다 놓아 넣기` }, twisty, h('div.name', icon('folder'), bin.name), h('div.meta', `${count}개`));
    const toggle = () => {
      if (closedBins.has(bin.id)) closedBins.delete(bin.id);
      else closedBins.add(bin.id);
      savePref('bins.closed', [...closedBins]);
      render();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('dragover', (e) => {
      if (!dnd.payload?.items?.length && !dnd.payload?.mediaIds) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      const ids = dnd.payload?.mediaIds;
      if (!ids?.length) return;
      e.preventDefault();
      e.stopPropagation();
      moveToBin(ids, bin.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: '이름 바꾸기…', action: async () => {
          const n = await promptDialog('저장소 이름 바꾸기', '이름', bin.name);
          if (n) store.transact('저장소 이름 바꾸기', () => { if (store.project.bins[bin.id]) store.project.bins[bin.id].name = n; });
        } },
        { label: '저장소 삭제 (안의 항목은 남김)', action: () => deleteBin(bin.id) },
      ], e.clientX, e.clientY);
    });
    return el;
  }

  /** The thumbnail element of an item (poster frame, subclip start frame, colour swatch or icon). */
  function thumbFor(id, m, st) {
    const file = fileIdOf(id);
    const rt = runtime.get(file);
    const thumb = h('div.thumb');
    let still = null;
    if (m.kind === 'video' && st === 'ready') {
      const t = m.posterTime ?? (isSubclip(m) ? m.subIn : null);
      if (t != null) still = frameThumb(file, t);
    }
    const base = still || rt?.thumb;
    if (base) {
      const c = document.createElement('canvas');
      c.width = base.width;
      c.height = base.height;
      c.getContext('2d').drawImage(base, 0, 0);
      thumb.append(c);
      // hover scrub in icon view (within a subclip's range); remembers the spot for 포스터 프레임 설정
      if (mode === 'grid' && rt?.filmstrip?.length && m.kind === 'video') {
        const [lo, hi] = itemRange(m);
        const n = rt.filmstrip.length;
        const dur = store.project.media[file]?.duration || hi || 1;
        thumb.addEventListener('pointermove', (e) => {
          const r = thumb.getBoundingClientRect();
          const t = lo + clamp((e.clientX - r.left) / r.width, 0, 1) * (hi - lo);
          hoverT.set(id, t);
          const f = rt.filmstrip[clamp(Math.floor((t / dur) * n), 0, n - 1)];
          c.getContext('2d').drawImage(f.canvas, 0, 0, c.width, c.height);
        });
        thumb.addEventListener('pointerleave', () => c.getContext('2d').drawImage(base, 0, 0, c.width, c.height));
      }
    } else if (m.kind === 'color') {
      thumb.style.background = isTransparentColor(m.color) ? CHECKER : m.color;
    } else {
      thumb.append(icon(KIND_ICONS[m.kind] || 'film', mode === 'list' && useColumns() ? 16 : 20));
      if (m.kind === 'sequence') thumb.style.background = '#33421a';
      if (m.kind === 'lut') thumb.style.background = 'linear-gradient(135deg,#2b4a7a,#7a2b5c,#7a6a2b)';
    }
    return thumb;
  }

  function renderItem(id, inBin) {
    const m = store.project.media[id];
    const st = mediaStatus(id);
    const thumb = thumbFor(id, m, st);
    const badge = st === 'offline' || st === 'error' ? h('span.badge.offline', st === 'error' ? '오류' : '오프라인') : st === 'loading' ? h('span.badge.loading', '불러오는 중…') : st === 'missing' ? h('span.badge.offline', '원본 없음') : null;
    const subTag = isSubclip(m) ? h('span.sub-tag', { title: `하위 클립 · ${store.project.media[m.subclipOf]?.name || ''}` }, '하위') : null;
    const metaParts = [isSubclip(m) ? '하위 클립' : KIND_NAMES[m.kind] || m.kind];
    const dur = itemDuration(m);
    if (dur != null && !isStill(m)) metaParts.push(formatShort(dur));
    if (m.width && !['audio', 'adjustment', 'lut', 'font'].includes(m.kind)) metaParts.push(`${m.width}×${m.height}`);
    if (m.kind === 'font' && m.fontFamily) metaParts.push(m.fontFamily);
    if (m.fps) metaParts.push(`${Math.round(m.fps * 100) / 100}fps`);
    if (m.kind === 'video' && m.hasAudio === false) metaParts.push('소리 없음');
    if (m.kind === 'sequence' && store.project.sequences[m.sequenceId]?.multicam) metaParts.unshift('멀티캠');
    const canPlace = st === 'ready' && !['lut', 'font'].includes(m.kind) && !(m.kind === 'sequence' && m.sequenceId === store.seq.id);
    const addBtn = canPlace ? h('button.m-place', {
      title: '재생헤드 위치에 넣기', 'aria-label': `${m.name} 타임라인에 넣기`,
      onclick: (e) => {
        e.stopPropagation();
        const ids = edit.placeMedia(id, { mode: 'insert' });
        if (ids.length) toast(`${m.name}을(를) 넣었습니다`);
      },
    }, '넣기') : null;
    const cls = `div.media-item${store.ui.selectedMedia.has(id) ? '.selected' : ''}${inBin ? '.in-bin' : ''}`;
    let el;
    if (useColumns()) {
      el = h(cls, { draggable: true, title: m.name, dataset: { id } },
        thumb,
        h('div.name', h('span', m.name), subTag, badge),
        ...COLUMNS.slice(1).map(([k]) => (k === 'label'
          ? h('div.col.lbl', m.label ? h('span.label-dot', { style: { background: m.label } }) : null, labelName(m) && m.label ? labelName(m) : '')
          : h('div.col', columnText(m, k)))));
    } else {
      el = h(cls, { draggable: true, title: m.name, dataset: { id } },
        thumb,
        h('div.name', m.label ? h('span.label-dot', { style: { background: m.label } }) : null, h('span', m.name), subTag, badge),
        h('div.meta', metaParts.join(' · '), addBtn));
    }
    el.addEventListener('click', (e) => {
      const sel = store.ui.selectedMedia;
      if (e.shiftKey && anchor) {
        const order = [...list.querySelectorAll('.media-item:not(.bin)')].map((x) => x.dataset.id);
        const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
        if (a >= 0) for (let i = a; i <= b; i++) sel.add(order[i]);
        else sel.add(id);
      } else if (modKey(e)) {
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
        anchor = id;
      } else {
        sel.clear();
        sel.add(id);
        anchor = id;
      }
      render();
      store.emit('media-selection');
    });
    el.addEventListener('dblclick', () => {
      if (m.kind === 'sequence') return store.openSequence(m.sequenceId);
      if (m.kind === 'color' || m.kind === 'adjustment') return;
      if (st === 'offline' || st === 'error') return relinkOne(fileIdOf(id));
      openInSource(id);
    });
    el.addEventListener('dragstart', (e) => {
      if (!store.ui.selectedMedia.has(id)) {
        store.ui.selectedMedia.clear();
        store.ui.selectedMedia.add(id);
      }
      const selected = [...store.ui.selectedMedia].filter((x) => store.project.media[x]);
      const items = selected.filter((x) => mediaStatus(x) === 'ready' && !['lut', 'font'].includes(store.project.media[x].kind)).map((mediaId) => ({ mediaId }));
      dnd.payload = { items, mediaIds: selected };
      e.dataTransfer.setData('application/x-montage-media', JSON.stringify({ items }));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    el.addEventListener('dragend', () => { dnd.payload = null; });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!store.ui.selectedMedia.has(id)) {
        store.ui.selectedMedia.clear();
        store.ui.selectedMedia.add(id);
        render();
      }
      showMenu(itemMenu(id), e.clientX, e.clientY);
    });
    return el;
  }

  function itemMenu(id) {
    const m = store.project.media[id];
    const st = mediaStatus(id);
    const selIds = [...store.ui.selectedMedia];
    const bins = Object.values(store.project.bins || {});
    const common = [
      { label: '레이블 색상', submenu: LABEL_COLORS.map(([c, n]) => ({ label: n, swatch: c || 'transparent', checked: (m.label || '') === c, action: () => setMediaLabel(selIds, c) })) },
      { label: '저장소로 옮기기', submenu: [
        { label: '(맨 위 — 저장소 밖)', checked: !m.bin, action: () => moveToBin(selIds, null) },
        ...bins.map((b) => ({ label: b.name, checked: m.bin === b.id, action: () => moveToBin(selIds, b.id) })),
        '-',
        { label: '새 저장소 만들어 옮기기…', action: newBin },
      ] },
    ];
    if (m.kind === 'sequence') {
      return [
        { label: '타임라인에서 열기', action: () => store.openSequence(m.sequenceId) },
        { label: '재생헤드에 삽입', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'insert' }) },
        { label: '재생헤드에 덮어쓰기 (중첩)', disabled: m.sequenceId === store.seq.id, action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
        '-',
        { label: '이름 바꾸기…', action: async () => {
          const n = await promptDialog('시퀀스 이름 바꾸기', '이름', m.name);
          if (n) store.transact('시퀀스 이름 바꾸기', () => { store.project.sequences[m.sequenceId].name = n; });
        } },
        { label: '복제', action: () => edit.duplicateSequence(m.sequenceId) },
        { label: '시퀀스 삭제', action: () => edit.deleteSequence(m.sequenceId) },
        '-',
        ...common,
      ];
    }
    if (m.kind === 'font' || m.kind === 'lut') {
      return [
        m.kind === 'font' ? { label: '선택한 텍스트 클립에 이 글꼴 적용', action: () => applyFont(id) } : { label: '선택한 클립에 LUT 적용', action: () => applyLut(id) },
        { label: '이름 바꾸기…', action: () => rename(id) },
        '-',
        ...common,
        '-',
        { label: '지우기', key: 'Del', action: clearSelected },
      ];
    }
    const real = m.kind !== 'color' && m.kind !== 'adjustment';
    const sub = isSubclip(m);
    const timed = ['video', 'audio'].includes(m.kind);
    const videos = selIds.filter((x) => store.project.media[x]?.kind === 'video');
    const posterT = hoverT.get(id);
    return [
      { label: '소스 모니터에서 열기', disabled: !real || st !== 'ready', action: () => openInSource(id) },
      m.kind === 'image' ? { label: '사진 편집에서 열기 (레이어·보정·PSD)', disabled: st !== 'ready', action: () => openImageInPhoto(id) } : null,
      { label: '재생헤드에 삽입', key: ',', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'insert' }) },
      { label: '재생헤드에 덮어쓰기', key: '.', disabled: st !== 'ready', action: () => edit.placeMedia(id, { mode: 'overwrite' }) },
      { label: '시퀀스 끝에 이어 붙이기', disabled: st !== 'ready', action: () => appendToEnd(selIds) },
      typeof edit.newSequenceFromMedia === 'function' ? { label: '클립에서 새 시퀀스', disabled: st !== 'ready', action: () => edit.newSequenceFromMedia(id) } : null,
      '-',
      { label: '하위 클립 만들기…', key: 'Ctrl+U', disabled: !timed || st !== 'ready', action: () => {
        const [lo, hi] = itemRange(m);
        openSubclipDialog(id, { inPoint: m.inPoint ?? lo, outPoint: m.outPoint ?? hi });
      } },
      sub ? { label: '하위 클립 편집…', action: () => openEditSubclipDialog(id) } : null,
      sub ? { label: '마스터 클립 표시', disabled: !store.project.media[m.subclipOf], action: () => reveal(m.subclipOf, { select: true }) } : null,
      m.kind === 'video' ? { label: posterT != null ? `포스터 프레임 설정 (${formatTimecode(posterT, m.fps || store.seq.fps)})` : '포스터 프레임 설정', disabled: st !== 'ready', action: () => posterFromMenu(id) } : null,
      m.kind === 'video' && m.posterTime != null ? { label: '포스터 프레임 지우기', action: () => store.transact('포스터 프레임 지우기', () => { const x = store.project.media[id]; if (x) delete x.posterTime; }) } : null,
      '-',
      { label: '오디오 추출 (소리만 따로 만들기)…', disabled: sub || !timed || !m.hasAudio || st !== 'ready', action: () => openExtractAudioDialog({ mediaId: id }) },
      { label: `멀티캠 소스 시퀀스 만들기… (${videos.length}개 선택)`, disabled: videos.length < 2, action: openMulticamDialog },
      { label: '이 클립에 맞춰 시퀀스 설정 바꾸기', disabled: !(m.width && m.kind === 'video') && m.kind !== 'image', action: () => matchSequence(m) },
      m.kind === 'color' ? { label: '색상 바꾸기…', action: () => changeColor(id) } : null,
      { label: '이름 바꾸기…', action: () => rename(id) },
      { label: real ? (st === 'ready' ? '다른 파일로 바꾸기…' : '미디어 다시 연결…') : '다른 파일로 바꾸기…', disabled: !real || sub, action: () => relinkOne(id) },
      { label: '속성…', action: () => showProperties(id) },
      '-',
      ...common,
      '-',
      { label: '지우기', key: 'Del', action: clearSelected },
    ];
  }

  /** 포스터 프레임 설정 from the menu: the hover-scrubbed spot (icon view) or the Source monitor's frame. */
  async function posterFromMenu(id) {
    const m = store.project.media[id];
    if (hoverT.has(id)) return setPoster(id, hoverT.get(id));
    const { sourceApi } = await import('./source-monitor.js');
    if (sourceApi.mediaId?.() === id && sourceApi.currentTime?.() != null) return setPoster(id, sourceApi.currentTime());
    openInSource(id);
    toast(`${m?.name || '항목'}: 소스 모니터에서 원하는 프레임으로 옮긴 뒤 Shift+P를 누르세요 (아이콘 보기에서는 썸네일 위를 훑은 자리로 정해집니다)`);
  }

  async function rename(id) {
    const m = store.project.media[id];
    const n = await promptDialog('이름 바꾸기', '이름', m.name);
    if (n) store.transact('미디어 이름 바꾸기', () => { store.project.media[id].name = n; });
  }

  function appendToEnd(ids) {
    const mark = store.undoMark();
    for (const id of ids) {
      if (mediaStatus(id) !== 'ready' || ['lut', 'font'].includes(store.project.media[id]?.kind)) continue;
      let end = 0;
      for (const c of Object.values(store.seq.clips)) end = Math.max(end, c.start + c.duration);
      edit.placeMedia(id, { mode: 'overwrite', start: end });
    }
    store.squashSince(mark, '시퀀스 끝에 이어 붙이기');
  }

  function matchSequence(m) {
    edit.updateSequenceSettings({ width: Math.round(m.width / 2) * 2, height: Math.round(m.height / 2) * 2, fps: m.fps ? Math.round(m.fps * 1000) / 1000 : store.seq.fps, name: store.seq.name });
    toast(`시퀀스를 ${m.width}×${m.height}${m.fps ? ` · ${Math.round(m.fps * 100) / 100} fps` : ''}로 바꿨습니다`);
  }

  function changeColor(id) {
    const cur = store.project.media[id].color;
    const input = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#000000' });
    openModal({
      title: '색상 매트 색 바꾸기',
      body: input,
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => store.transact('색상 바꾸기', () => {
          store.project.media[id].color = input.value;
          for (const sq of Object.values(store.project.sequences)) {
            for (const c of Object.values(sq.clips)) {
              if (c.mediaId !== id) continue;
              const fx = c.effects.find((e) => e.type === 'fill');
              if (fx) fx.params.color.value = input.value;
            }
          }
        }),
      }],
    });
  }

  async function relinkOne(id) {
    const m = store.project.media[id];
    const files = await pickFiles({ multiple: false, accept: m.kind === 'image' ? 'image/*' : m.kind === 'audio' ? 'audio/*,video/*' : 'video/*,audio/*' });
    if (!files[0]) return;
    await attachFile(id, files[0]);
    store.project.media[id].name = files[0].name;
    store.changed('media');
    toast(`${files[0].name} 파일로 연결했습니다`);
  }

  async function linkMediaDialog() {
    const files = await pickFiles();
    if (!files.length) return;
    const n = await relinkFromFiles(files);
    toast(n ? `${n}개 항목을 다시 연결했습니다` : '이름이 같은 파일을 찾지 못했습니다');
  }

  function showProperties(id) {
    const m = store.project.media[id];
    const rt = runtime.get(fileIdOf(id));
    const statusName = { ready: '사용 가능', loading: '불러오는 중', offline: '오프라인 (파일 연결 필요)', error: '오류', missing: '없음' }[mediaStatus(id)] || mediaStatus(id);
    const used = Object.values(store.project.sequences).reduce((n, sq) => n + Object.values(sq.clips).filter((c) => c.mediaId === id || c.subclip?.id === id).length, 0);
    const fps = fpsOf(m) || store.seq.fps;
    const dur = itemDuration(m);
    const rows = [
      ['이름', m.name], ['종류', isSubclip(m) ? `하위 클립 (${store.project.media[m.subclipOf]?.name || '마스터 없음'})` : KIND_NAMES[m.kind] || m.kind], ['상태', statusName],
      ['길이', dur != null ? formatTimecode(dur, fps) : '—'],
      isSubclip(m) ? ['하위 클립 구간', `${formatTimecode(m.subIn, fps)} ~ ${formatTimecode(m.subOut, fps)}${m.restrictTrims === false ? '' : ' (트리밍 제한)'}`] : null,
      ['화면 크기', m.width ? `${m.width} × ${m.height}` : '—'], ['프레임 속도', m.fps ? `${m.fps} fps` : '—'], ['소리', m.hasAudio ? '있음' : '없음'],
      ['파일 크기', m.size ? formatBytes(m.size) : '—'], ['파일 형식', m.mime || '—'], ['오류 내용', rt?.error || '—'],
      m.posterTime != null ? ['포스터 프레임', formatTimecode(m.posterTime, fps)] : null,
      ['사용 중인 클립', `${used}개 (모든 시퀀스)`],
    ].filter(Boolean);
    openModal({ title: '속성', body: h('div.kbd-table', rows.flatMap(([a, b]) => [h('span', a), h('span', String(b))])) });
  }

  /** 프로젝트에서 표시: show the panel, open the item's bin, select, scroll to and flash it. */
  function reveal(id, { select: sel = true } = {}) {
    let m = store.project.media[id];
    if (!m) return;
    // a timeline clip from a subclip points at the master: reveal the subclip it came from
    const fromSub = store.selectedClips().find((c) => c.mediaId === id && c.subclip?.id && store.project.media[c.subclip.id]);
    if (fromSub) {
      id = fromSub.subclip.id;
      m = store.project.media[id];
    }
    showPanel('project');
    if (filter && !m.name.toLowerCase().includes(filter)) {
      filter = '';
      search.value = '';
    }
    if (m.bin && closedBins.has(m.bin)) {
      closedBins.delete(m.bin);
      savePref('bins.closed', [...closedBins]);
    }
    if (sel) store.ui.selectedMedia = new Set([id]);
    anchor = id;
    render();
    lastSig = '';
    const el = [...list.querySelectorAll('.media-item')].find((x) => x.dataset.id === id);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }

  Object.assign(projectApi, { newBin, reveal, newItemMenu, render: () => scheduleRender(true) });

  store.on('change', () => scheduleRender());
  store.on('reveal-media', (id) => (id ? reveal(id) : scheduleRender(true)));
  mediaEvents.on('updated', () => scheduleRender());
  window.addEventListener('resize', () => scheduleRender());
  render();
  return body;
}

// 파일 ▸ 새로 만들기 (Premiere's File ▸ New), in Premiere's order
const NEW_ORDER = ['프로젝트', '시퀀스', '클립에서', '저장소', '검색 저장소', '오프라인 파일', '조정 레이어', '바 및 톤', '블랙 비디오', '캡션', '색상 매트', '범용 카운트다운 리더', '투명 비디오'];
const newKey = (label) => String(label || '').replace(/\s+|…|\.\.\.|\(.*?\)/g, '');
const newRank = (it) => {
  const k = newKey(it?.label);
  const i = NEW_ORDER.findIndex((w) => k === newKey(w) || (w === '클립에서' && k.includes('클립에서')));
  return i < 0 ? NEW_ORDER.length : i;
};
const fileNewItems = () => [
  { label: '시퀀스…', action: openNewSequenceDialog },
  { label: '저장소', action: () => projectApi.newBin?.() },
  { label: '조정 레이어', action: () => projectApi.reveal?.(createSyntheticMedia('adjustment', { name: '조정 레이어' })) },
  { label: '바 및 톤…', action: openBarsToneDialog },
  { label: '블랙 비디오', action: () => projectApi.reveal?.(createSyntheticMedia('color', { name: '블랙 비디오', color: '#000000' })) },
  { label: '색상 매트…', action: openColorMatteDialog },
  { label: '범용 카운트다운 리더…', action: openCountingLeaderDialog },
  { label: '투명 비디오', action: () => projectApi.reveal?.(createTransparentVideo()) },
];

extendMenu('파일', (items) => {
  const host = items.find((it) => it && it.submenu && it.label === '새로 만들기');
  if (!host) return [{ label: '새로 만들기', submenu: fileNewItems }, ...items];
  const base = host.submenu;
  host.submenu = () => {
    // ours replace the menu bar's items of the same name; the rest keep their place in the order
    const list = [...((typeof base === 'function' ? base() : base) || [])].filter((it) => it && it !== '-');
    for (const it of fileNewItems()) {
      const i = list.findIndex((x) => newKey(x.label) === newKey(it.label));
      if (i >= 0) list[i] = it;
      else list.push(it);
    }
    const sorted = list.map((it, i) => [newRank(it), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    // separators like Premiere's: project / sequence / bin items, then the synthetic media
    const out = [];
    for (const it of sorted) {
      if (out.length && newRank(it) >= 6 && newRank(out[out.length - 1]) < 6) out.push('-');
      out.push(it);
    }
    return out;
  };
  return items;
});

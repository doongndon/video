// Program monitor: renders the sequence through the compositor, transport controls, view options
// (zoom levels with panning, playback / paused resolution, transparency grid, safe margins,
// rule-of-thirds and centre overlays, rulers and draggable guides, comparison view), direct
// manipulation (move / scale / rotate) of the selected clip with snapping, on-screen editing of
// masks (ellipse / rectangle / polygon points) and the Type tool.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { Compositor } from '../compositor.js';
import * as edit from '../edit.js';
import { clipEnd, clipsOnTrack, videoTracks, sequenceDuration, outFrameTime, evalEffect, editPoints, setParamValue } from '../model.js';
import { evalMask, evalMaskPath, setMaskPath, editMask, pathPolyline } from '../masks.js';
import { EFFECTS } from '../effects.js';
import { h, clamp, uid, formatTimecode, parseTimecode, downloadBlob, modKey } from '../util.js';
import { fitCanvasToBox, loadPref, savePref, toast, dnd, inlineEdit, showMenu, openModal, formRow, menusOpen } from './common.js';
import { icon, iconButton } from './icons.js';
import { exportFrame, exportFrameCanvas } from '../export.js';
import { openExportFrameDialog } from './export-dialog.js';
import { motionPath, rawSetPathKey, setAutoKey } from '../motionkeys.js';
import { extendMenu } from './menubar.js';
import { injectStyle } from './style-inject.js';
import { insertTemplate } from '../templates.js';

export const programApi = {};

const MASK_TYPES = new Set(['mask', 'censor']);
let HANDLE = 7; // handle hit radius in px (bigger for fingers)

/** 확대/축소 레벨 (Premiere: 맞추기, 10% … 400%). */
export const ZOOM_LEVELS = [['fit', '맞추기'], ['0.1', '10%'], ['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.5', '150%'], ['2', '200%'], ['4', '400%']];
/** 재생 해상도 / 일시 정지 해상도. 'auto' renders at the monitor's own pixel size (capped while playing, see renderScale). */
export const RESOLUTIONS = [['auto', '자동 (화면 크기에 맞춤)'], ['1', '전체'], ['0.5', '1/2'], ['0.25', '1/4'], ['0.125', '1/8']];
const RULER = 18; // ruler strip size in px
const GUIDE_COLOR = '#36d1ff';
const SNAP_COLOR = '#ff4fd8';
const SNAP_PX = 6;
const CHECKER = 'repeating-conic-gradient(#9a9a9a 0% 25%, #d8d8d8 0% 50%) 0 0 / 16px 16px';
const VIEW_DEFAULTS = { grid: false, thirds: false, cross: false, rulers: false, guides: true, lockGuides: false, snap: true };

injectStyle('pm-style', `
.monitor-view canvas.frame.pm-ref { pointer-events: none; }
.pm-refbar { position: absolute; z-index: 4; display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-radius: 6px; background: rgba(20, 22, 27, 0.86); border: 1px solid var(--line-2); font-size: var(--fs-xs); color: var(--text-dim); }
.pm-refbar .ibtn { min-height: 0; height: calc(22px * var(--ui-scale)); min-width: calc(24px * var(--ui-scale)); padding: 0 4px; }
.pm-refbar .tc { min-width: 0; font-size: var(--fs-s); padding: 0 4px; }
.pm-refbar b { color: var(--text); font-weight: 600; padding: 0 4px; }
.transport .ibtn.on { color: var(--value); border-color: var(--accent); }
.pm-row { flex: 1; min-height: 0; display: flex; }
.pm-row > .monitor-view { flex: 1; min-width: 0; }
.pm-multicam { display: none; }
.monitor.mc-on .pm-multicam { display: flex; flex-direction: column; flex: 1; min-width: 0; border-right: 1px solid var(--line-2); }
.pm-multicam > .multicam { flex: 1; min-height: 0; display: flex; flex-direction: column; }
@media (max-width: 700px) { .monitor.mc-on .pm-row { flex-direction: column; } .monitor.mc-on .pm-multicam { border-right: 0; border-bottom: 1px solid var(--line-2); } }
`);

export function createProgramMonitor() {
  const view = h('div.monitor-view');
  const frame = h('canvas.frame');
  const refFrame = h('canvas.frame.pm-ref', { hidden: true });
  const overlay = h('canvas.overlay');
  const empty = h('div.monitor-empty', '타임라인에 클립을 놓으면 여기에 결과 화면이 나옵니다.\n클립을 선택하면 화면에서 직접 옮기고 크기·회전을 바꿀 수 있습니다.');
  const recBadge = h('button.pm-rec', { title: '키프레임 기록 끄기', onclick: () => setAutoKey(false) }, icon('record', 12), ' 키프레임 기록 중');
  const refTc = h('span.tc', { title: '클릭해서 참조 프레임 시간 입력' }, '00:00:00:00');
  const refBar = h('div.pm-refbar', { hidden: true },
    h('b', '참조'),
    iconButton('goIn', '참조 프레임: 이전 편집점', () => stepRefEdit(-1)),
    refTc,
    iconButton('goOut', '참조 프레임: 다음 편집점', () => stepRefEdit(1)),
    iconButton('marker', '참조 프레임을 재생헤드 위치로', () => setRefT(store.ui.playhead)));
  view.append(frame, refFrame, overlay, empty, recBadge, refBar);
  const compositor = new Compositor({ onAsyncReady: () => playback.requestRender() });
  const refCompositor = new Compositor({ onAsyncReady: () => playback.requestRender() });

  let resolution = loadPref('program.res', 'auto');
  let pauseRes = loadPref('program.pauseRes', 'auto');
  let zoom = loadPref('program.zoom', 'fit');
  if (!ZOOM_LEVELS.some(([v]) => v === String(zoom))) zoom = 'fit';
  let safe = loadPref('program.safe', false);
  const opts = { ...VIEW_DEFAULTS, ...loadPref('program.view', {}) };
  const cmp = { on: false, mode: loadPref('program.cmpMode', 'side'), kind: loadPref('program.cmpKind', 'frame'), split: 0.5, refT: null };
  let pan = { x: 0, y: 0 };
  let fr = { x: 0, y: 0, w: 1, h: 1, s: 1 };
  let rr = null; // reference frame rect (comparison view)
  let area = { x: 0, y: 0, w: 1, h: 1 };
  let slot = area;
  let handleDrag = null;
  let viewDrag = null; // pan / guide / divider / reference scrub
  let snapLines = null; // {xs, ys} in sequence px while a move snaps

  const tcEl = h('span.tc', { title: '클릭해서 시간 입력' }, '00:00:00:00');
  const durEl = h('span.tc.dur', '');
  const scrub = h('canvas');
  const scrubBar = h('div.monitor-scrub', { title: '끌어서 이동' }, scrub);
  const playBtn = iconButton('play', '재생 / 정지 (Space)', () => playback.toggle(), { cls: 'play' });
  const loopBtn = iconButton('loop', '반복 재생 (Ctrl+Shift+L)', () => { playback.loop = !playback.loop; playback.emit('state'); });
  const keyBtn = iconButton('key', '키프레임 기록: 켜면 화면에서 옮기거나 크기·회전을 바꿀 때마다 재생헤드 위치에 키프레임이 생깁니다', () => setAutoKey(!store.ui.autoKey), { cls: 'autokey' });
  const safeBtn = iconButton('safe', '안전 여백 (TV 가장자리 잘림 확인)', () => setSafe(!safe));
  const compareBtn = iconButton('compare', '비교 보기: 참조 프레임 또는 효과 적용 전 화면과 나란히 비교', () => setCompare(!cmp.on));
  const settingsBtn = iconButton('wrench', '설정: 해상도·투명도 격자·안전 여백·눈금자·안내선·비교 보기', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(settingsMenu(), r.left, r.top - 4);
  });
  const resSel = h('select', { title: '재생 해상도 (낮추면 재생이 빨라짐)', 'aria-label': '재생 해상도' },
    RESOLUTIONS.map(([v, l]) => h('option', { value: v, selected: v === String(resolution) }, v === 'auto' ? '자동' : l)));
  const zoomSel = h('select', { title: '확대/축소 레벨 (확대하면 손 도구나 휠 가운데 버튼으로 화면 이동)', 'aria-label': '확대/축소 레벨' },
    ZOOM_LEVELS.map(([v, l]) => h('option', { value: v, selected: v === String(zoom) }, l)));
  resSel.addEventListener('change', () => setResolution(resSel.value));
  zoomSel.addEventListener('change', () => setZoom(zoomSel.value));

  // Premiere's layout: timecode · 맞추기 … 해상도 · wrench · duration above the scrub bar, the
  // transport buttons centred below it (phones show their own short row with a timecode copy)
  const mTc = h('span.tc.pm-mtc');
  const info = h('div.pm-info', tcEl, zoomSel, h('span.grow'), resSel, settingsBtn, durEl);
  const transport = h('div.transport',
    mTc,
    h('span.t-side'),
    iconButton('marker', '마커 추가 (M)', () => edit.addMarker()),
    iconButton('markIn', '시작 표시 (I)', () => edit.setSequenceInOut('in', store.ui.playhead)),
    iconButton('markOut', '끝 표시 (O)', () => edit.setSequenceInOut('out', store.ui.playhead)),
    h('span.sep'),
    iconButton('goIn', '시작 표시로 이동 (Shift+I)', () => { playback.stop(); store.setPlayhead(store.seq.inPoint ?? 0); }),
    iconButton('stepBack', '1프레임 뒤로 (←)', () => playback.step(-1)),
    playBtn,
    iconButton('stepForward', '1프레임 앞으로 (→)', () => playback.step(1)),
    iconButton('goOut', '끝 표시로 이동 (Shift+O)', () => { playback.stop(); const s = store.seq; store.setPlayhead(s.outPoint != null ? outFrameTime(s.outPoint, s.fps, s.inPoint) : sequenceDuration(s)); }),
    h('span.sep'),
    iconButton('lift', '들어내기: 시작~끝 구간을 지우고 빈자리 남김 (;)', () => edit.liftExtract(false)),
    iconButton('extract', '추출: 시작~끝 구간을 지우고 당기기 (\')', () => edit.liftExtract(true)),
    iconButton('camera', '프레임 내보내기 (Ctrl+Shift+E)', () => openExportFrameDialog()),
    compareBtn,
    h('span.t-side.end', keyBtn, loopBtn, safeBtn));
  // 멀티 카메라 보기 (Premiere: 프로그램 모니터 설정 ▸ 멀티 카메라, Shift+0): the angles on the left,
  // the program on the right; the angle grid is a second copy of the 멀티 카메라 panel
  const mcHost = h('div.pm-multicam');
  const root = h('div.monitor', h('div.pm-row', mcHost, view), info, scrubBar, transport);
  let mcPanel = null;
  let mcView = false;
  async function setMulticamView(on) {
    mcView = !!on;
    if (mcView && !mcPanel) {
      const { createMulticamPanel } = await import('./panels.js');
      mcPanel = createMulticamPanel();
      mcHost.append(mcPanel);
    }
    root.classList.toggle('mc-on', mcView);
    if (mcPanel) mcPanel[mcView ? 'onShow' : 'onHide']();
    layout();
    playback.requestRender();
  }

  async function saveFrame() {
    const blob = await exportFrame();
    const name = `${store.seq.name || 'frame'}_${formatTimecode(store.ui.playhead, store.seq.fps).replace(/:/g, '-')}.png`;
    if (await downloadBlob(blob, name)) toast(`${name} 저장`);
  }

  // ---- view settings

  function saveOpts() {
    savePref('program.view', opts);
    layout();
    refresh();
  }

  function setOpt(key, value) {
    opts[key] = value;
    saveOpts();
  }

  function setSafe(on) {
    safe = on;
    savePref('program.safe', safe);
    playback.requestRender();
    refresh();
  }

  function setZoom(v) {
    zoom = ZOOM_LEVELS.some(([z]) => z === String(v)) ? String(v) : 'fit';
    zoomSel.value = zoom;
    savePref('program.zoom', zoom);
    pan = { x: 0, y: 0 };
    layout();
  }

  function setResolution(v) {
    resolution = v;
    resSel.value = v;
    savePref('program.res', v);
    layout();
  }

  function setPauseRes(v) {
    pauseRes = v;
    savePref('program.pauseRes', v);
    layout();
  }

  function setCompare(on, patch = {}) {
    Object.assign(cmp, patch);
    cmp.on = on;
    savePref('program.cmpMode', cmp.mode);
    savePref('program.cmpKind', cmp.kind);
    if (on && cmp.kind === 'frame' && cmp.refT == null) cmp.refT = defaultRefT();
    refKey = '';
    layout();
    refresh();
  }

  /** A frame from the previous shot (the middle of it), else the playhead. */
  function defaultRefT() {
    const s = store.seq;
    const t = store.ui.playhead;
    const pts = editPoints(s).filter((p) => p < sequenceDuration(s));
    const cur = pts.filter((p) => p <= t + 1e-6).pop() ?? 0;
    const prev = pts.filter((p) => p < cur - 1e-6).pop();
    if (prev == null) return t;
    return Math.round(((prev + cur) / 2) * s.fps) / s.fps;
  }

  function setRefT(t) {
    const s = store.seq;
    cmp.refT = clamp(Math.round(t * s.fps) / s.fps, 0, Math.max(0, sequenceDuration(s) - 1 / s.fps));
    refKey = '';
    playback.requestRender();
    refresh();
  }

  function stepRefEdit(dir) {
    const s = store.seq;
    const t = cmp.refT ?? store.ui.playhead;
    const pts = editPoints(s);
    const target = dir < 0 ? pts.filter((p) => p < t - 1e-6).pop() : pts.find((p) => p > t + 1e-6);
    if (target != null && target < sequenceDuration(s)) setRefT(target);
  }

  const guides = () => store.seq.guides || [];

  function addGuide(dir, pos, label = '안내선 추가') {
    store.transact(label, () => {
      const s = store.seq;
      s.guides = [...(s.guides || []), { id: uid('gd'), dir, pos: Math.round(pos * 10) / 10 }];
    });
  }

  function clearGuides() {
    if (!guides().length) return;
    store.transact('안내선 지우기', () => { store.seq.guides = []; });
  }

  /** 안내선 템플릿: preset sets of guides. */
  const GUIDE_TEMPLATES = [
    ['삼등분 (3×3)', (W, H) => [['v', W / 3], ['v', (2 * W) / 3], ['h', H / 3], ['h', (2 * H) / 3]]],
    ['가운데', (W, H) => [['v', W / 2], ['h', H / 2]]],
    ['액션 안전 (90%)', (W, H) => [['v', W * 0.05], ['v', W * 0.95], ['h', H * 0.05], ['h', H * 0.95]]],
    ['제목 안전 (80%)', (W, H) => [['v', W * 0.1], ['v', W * 0.9], ['h', H * 0.1], ['h', H * 0.9]]],
    ['자막 영역 (아래 1/5)', (W, H) => [['h', H * 0.8], ['h', H * 0.92]]],
  ];

  function applyGuideTemplate(fn) {
    const s = store.seq;
    store.transact('안내선 템플릿', () => {
      const add = fn(s.width, s.height).map(([dir, pos]) => ({ id: uid('gd'), dir, pos: Math.round(pos * 10) / 10 }));
      s.guides = [...(s.guides || []), ...add.filter((g) => !(s.guides || []).some((o) => o.dir === g.dir && Math.abs(o.pos - g.pos) < 0.5))];
    });
    if (!opts.guides) setOpt('guides', true);
  }

  function guideDialog(g = null) {
    const s = store.seq;
    const dir = h('select', [['h', '가로 (수평선)'], ['v', '세로 (수직선)']].map(([v, l]) => h('option', { value: v, selected: v === (g?.dir || 'h') }, l)));
    const pos = h('input', { type: 'number', value: g ? g.pos : Math.round(s.height / 2), step: 1, style: { width: '96px' } });
    const unit = h('select', [['px', '픽셀'], ['%', '%']].map(([v, l]) => h('option', { value: v }, l)));
    openModal({
      title: g ? '안내선 편집' : '안내선 추가',
      body: [formRow('방향', dir), formRow('위치', pos, unit), h('div.note', '가로 안내선은 위에서부터, 세로 안내선은 왼쪽에서부터의 거리입니다. 눈금자에서 끌어서 만들 수도 있습니다.')],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const v = parseFloat(pos.value);
          if (!Number.isFinite(v)) return false;
          const px = unit.value === '%' ? (v / 100) * (dir.value === 'h' ? s.height : s.width) : v;
          if (g) {
            store.transact('안내선 편집', () => {
              const x = (store.seq.guides || []).find((o) => o.id === g.id);
              if (x) Object.assign(x, { dir: dir.value, pos: Math.round(px * 10) / 10 });
            });
          } else addGuide(dir.value, px);
          if (!opts.guides) setOpt('guides', true);
          return true;
        },
      }],
    });
  }

  const resItems = (cur, set) => RESOLUTIONS.map(([v, l]) => ({ label: l, checked: String(cur) === v, action: () => set(v) }));

  /** Program monitor settings (the wrench menu); also listed under 보기 in the menu bar. */
  function settingsMenu({ viewMenu = false } = {}) {
    const has = guides().length > 0;
    return [
      { label: '확대/축소 레벨', submenu: () => ZOOM_LEVELS.map(([v, l]) => ({ label: l, checked: String(zoom) === v, action: () => setZoom(v) })) },
      { label: '재생 해상도', submenu: () => resItems(resolution, setResolution) },
      { label: '일시 정지 해상도', submenu: () => resItems(pauseRes, setPauseRes) },
      '-',
      { label: '투명도 격자', checked: opts.grid, action: () => setOpt('grid', !opts.grid) },
      { label: '안전 여백', checked: safe, action: () => setSafe(!safe) },
      { label: '삼등분선', checked: opts.thirds, action: () => setOpt('thirds', !opts.thirds) },
      { label: '가운데 십자', checked: opts.cross, action: () => setOpt('cross', !opts.cross) },
      '-',
      { label: '눈금자 표시', checked: opts.rulers, action: () => setOpt('rulers', !opts.rulers) },
      { label: '안내선 표시', key: 'Ctrl+;', checked: opts.guides, action: () => setOpt('guides', !opts.guides) },
      { label: '안내선 잠금', checked: opts.lockGuides, action: () => setOpt('lockGuides', !opts.lockGuides) },
      { label: '프로그램 모니터에서 스냅', key: 'Ctrl+Shift+;', checked: opts.snap, action: () => setOpt('snap', !opts.snap) },
      { label: '안내선 추가…', action: () => guideDialog() },
      { label: '안내선 템플릿', submenu: () => GUIDE_TEMPLATES.map(([l, fn]) => ({ label: l, action: () => applyGuideTemplate(fn) })) },
      { label: '안내선 지우기', disabled: !has, action: clearGuides },
      '-',
      { label: '멀티 카메라', key: 'Shift+0', checked: mcView, action: () => setMulticamView(!mcView) },
      '-',
      { label: '비교 보기', checked: cmp.on, action: () => setCompare(!cmp.on) },
      { label: '비교 방식', submenu: () => [['side', '나란히'], ['vsplit', '세로 분할 (왼쪽 / 오른쪽)'], ['hsplit', '가로 분할 (위 / 아래)']].map(([v, l]) => ({ label: l, checked: cmp.mode === v, action: () => setCompare(true, { mode: v }) })) },
      { label: '비교 대상', submenu: () => [['frame', '샷 또는 프레임 비교 (참조 프레임)'], ['beforeafter', '편집 전/후 비교 (효과 끄고 켜기)']].map(([v, l]) => ({ label: l, checked: cmp.kind === v, action: () => setCompare(true, { kind: v }) })) },
      ...(viewMenu ? [] : [
        '-',
        { label: '반복 재생', checked: playback.loop, action: () => { playback.loop = !playback.loop; playback.emit('state'); } },
        { label: '프레임 내보내기…', key: 'Ctrl+Shift+E', action: () => openExportFrameDialog() },
      ]),
    ];
  }

  // ---- layout

  function renderScale() {
    const s = store.seq;
    const res = playback.playing ? resolution : pauseRes;
    if (res === 'auto') {
      // while playing, sharp phone / retina screens (2-3 device pixels per CSS pixel) render at most
      // 1.5 per CSS pixel: a moving picture looks the same and costs a third to a half of the work.
      // The paused frame is drawn again at full sharpness.
      const dpr = window.devicePixelRatio || 1;
      return clamp((fr.w * (playback.playing ? Math.min(dpr, 1.5) : dpr)) / s.width, 0.1, 1);
    }
    return clamp(parseFloat(res) || 1, 0.05, 1);
  }

  /** Fit (or zoom) the frame into a slot, applying the pan offset; clamps the pan to the content. */
  function placeIn(sl, s) {
    const fit = Math.min(sl.w / s.width, sl.h / s.height);
    const sc = zoom === 'fit' ? fit : parseFloat(zoom);
    const w = s.width * sc;
    const hh = s.height * sc;
    let x = sl.x + (sl.w - w) / 2;
    let y = sl.y + (sl.h - hh) / 2;
    if (w > sl.w) x = clamp(x + pan.x, sl.x + sl.w - w, sl.x);
    if (hh > sl.h) y = clamp(y + pan.y, sl.y + sl.h - hh, sl.y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh), s: sc, cx: sl.x + (sl.w - w) / 2, cy: sl.y + (sl.h - hh) / 2 };
  }

  const pannable = () => fr.w > slot.w + 1 || fr.h > slot.h + 1;

  let laidFor = '';
  function layout() {
    const s = store.seq;
    laidFor = `${s.width}x${s.height}`;
    const r = view.getBoundingClientRect();
    const ru = opts.rulers ? RULER : 0;
    area = { x: ru, y: ru, w: Math.max(1, r.width - ru), h: Math.max(1, r.height - ru) };
    slot = area;
    rr = null;
    if (cmp.on && cmp.mode === 'side') {
      // two frames side by side (or stacked when the panel is tall)
      const gap = 6;
      const across = Math.min((area.w - gap) / 2 / s.width, area.h / s.height);
      const stacked = Math.min(area.w / s.width, (area.h - gap) / 2 / s.height);
      if (stacked > across * 1.15) {
        const hh = (area.h - gap) / 2;
        slot = { x: area.x, y: area.y + hh + gap, w: area.w, h: hh };
        rr = placeIn({ x: area.x, y: area.y, w: area.w, h: hh }, s);
      } else {
        const w = (area.w - gap) / 2;
        slot = { x: area.x + w + gap, y: area.y, w, h: area.h };
        rr = placeIn({ x: area.x, y: area.y, w, h: area.h }, s);
      }
    }
    fr = placeIn(slot, s);
    // remember the pan that actually applies (clamped), so panning never "sticks" past an edge
    pan = { x: fr.w > slot.w ? fr.x - fr.cx : 0, y: fr.h > slot.h ? fr.y - fr.cy : 0 };
    Object.assign(frame.style, { left: `${fr.x}px`, top: `${fr.y}px`, width: `${fr.w}px`, height: `${fr.h}px`, background: opts.grid ? CHECKER : '' });
    const showRef = cmp.on;
    refFrame.hidden = !showRef;
    if (showRef) {
      const R = rr || fr;
      Object.assign(refFrame.style, { left: `${R.x}px`, top: `${R.y}px`, width: `${R.w}px`, height: `${R.h}px`, background: opts.grid ? CHECKER : '' });
      refFrame.style.clipPath = cmp.mode === 'vsplit' ? `inset(0 ${(1 - cmp.split) * 100}% 0 0)` : cmp.mode === 'hsplit' ? `inset(0 0 ${(1 - cmp.split) * 100}% 0)` : '';
    }
    placeRefBar();
    playback.requestRender();
  }

  function placeRefBar() {
    const show = cmp.on && cmp.kind === 'frame';
    refBar.hidden = !show;
    if (!show) return;
    const R = rr || fr;
    const left = rr ? R.x + 6 : area.x + 6;
    const bottom = rr ? R.y + R.h - 6 : area.y + area.h - 6;
    Object.assign(refBar.style, { left: `${Math.max(2, left)}px`, top: `${Math.max(2, bottom - refBar.offsetHeight)}px` });
  }

  // ---- rendering

  /** The sequence without user effects or adjustment layers ("편집 전"). */
  function beforeSeq(s) {
    const clips = {};
    for (const [id, c] of Object.entries(s.clips)) {
      if (c.kind === 'adjustment') continue;
      const fixed = c.effects.filter((e) => EFFECTS[e.type]?.fixed);
      clips[id] = fixed.length === c.effects.length ? c : { ...c, effects: fixed };
    }
    return { ...s, clips };
  }

  let refKey = '';
  let refFull = null;
  let refJob = 0;
  let refDirtyTimer = null;

  function drawRef(s, w, hh) {
    if (refFrame.width !== w || refFrame.height !== hh) {
      refFrame.width = w;
      refFrame.height = hh;
      refKey = refKey ? `${refKey}*` : '';
    }
    const ctx = refFrame.getContext('2d');
    if (cmp.kind === 'beforeafter') {
      refCompositor.render(ctx, beforeSeq(s), store.ui.playhead, playback.provider, { scale: w / s.width, background: opts.grid ? null : undefined });
      return;
    }
    // reference frame: decoded exactly (it is usually not at the playhead) and cached
    if (cmp.refT == null) cmp.refT = defaultRefT();
    const want = `${s.id}|${cmp.refT}`;
    if (refFull && refFull.key === want && refKey === `${want}|${w}x${hh}`) return;
    if (refFull && refFull.key === want) {
      ctx.clearRect(0, 0, w, hh);
      ctx.drawImage(refFull.canvas, 0, 0, w, hh);
      refKey = `${want}|${w}x${hh}`;
      return;
    }
    if (refFull?.pending === want) return;
    const job = ++refJob;
    refFull = { ...(refFull || {}), pending: want };
    exportFrameCanvas(cmp.refT).then((canvas) => {
      if (job !== refJob) return;
      refFull = { key: want, canvas };
      refKey = '';
      playback.requestRender();
    }).catch((err) => {
      console.warn('reference frame failed', err);
      if (job === refJob) refFull = null;
    });
  }

  function invalidateRef() {
    if (!cmp.on || cmp.kind !== 'frame') return;
    clearTimeout(refDirtyTimer);
    refDirtyTimer = setTimeout(() => {
      if (refFull) refFull = { canvas: refFull.canvas, key: 'stale' };
      refKey = '';
      playback.requestRender();
    }, 250);
  }

  function draw() {
    const s = store.seq;
    // the sequence size can change (settings, aspect presets, switching sequences) without a resize
    if (laidFor !== `${s.width}x${s.height}`) layout();
    const sc = renderScale();
    const w = Math.max(2, Math.round(s.width * sc));
    const hh = Math.max(2, Math.round(s.height * sc));
    if (frame.width !== w || frame.height !== hh) {
      frame.width = w;
      frame.height = hh;
    }
    const ctx = frame.getContext('2d');
    compositor.render(ctx, s, store.ui.playhead, playback.provider, { scale: w / s.width, background: opts.grid ? null : undefined });
    if (cmp.on) drawRef(s, w, hh);
    empty.hidden = Object.keys(s.clips).length > 0;
    drawOverlay();
    refresh();
  }

  function seqToScreen([x, y]) {
    return [fr.x + x * fr.s, fr.y + y * fr.s];
  }

  function screenToSeq(x, y) {
    return [(x - fr.x) / fr.s, (y - fr.y) / fr.s];
  }

  /** The single selected visual clip under the playhead, if any. */
  function activeClip() {
    const sel = store.selectedClips().filter((c) => c.kind !== 'audio' && c.kind !== 'adjustment');
    if (sel.length !== 1) return null;
    const c = sel[0];
    const t = store.ui.playhead;
    if (t < c.start || t >= clipEnd(c)) return null;
    return c;
  }

  function quadFor(c) {
    return compositor.clipQuad(store.seq, c, store.ui.playhead, playback.provider);
  }

  // ---- mask geometry (mask values are percentages of the clip's source frame)

  function maskTarget() {
    const c = activeClip();
    if (!c || playback.playing) return null;
    const fx = c.effects.find((e) => e.id === store.ui.maskFxId && MASK_TYPES.has(e.type) && e.enabled);
    if (!fx) return null;
    const quad = quadFor(c);
    if (!quad) return null;
    const v = evalEffect(fx, store.ui.playhead - c.start);
    const q0 = quad[0];
    const ax = [quad[1][0] - q0[0], quad[1][1] - q0[1]];
    const bx = [quad[3][0] - q0[0], quad[3][1] - q0[1]];
    const la = Math.hypot(...ax) || 1;
    const lb = Math.hypot(...bx) || 1;
    const P = (u, w) => [q0[0] + ax[0] * u + bx[0] * w, q0[1] + ax[1] * u + bx[1] * w];
    const det = ax[0] * bx[1] - ax[1] * bx[0] || 1e-9;
    const inv = ([x, y]) => {
      const dx = x - q0[0];
      const dy = y - q0[1];
      return [(dx * bx[1] - dy * bx[0]) / det, (ax[0] * dy - ax[1] * dx) / det];
    };
    const polygon = fx.type === 'mask' && v.shape === 'polygon';
    const geo = { c, fx, v, P, inv, la, lb, polygon };
    if (!polygon) {
      const rot = ((v.rotation || 0) * Math.PI) / 180;
      const ex = [ax[0] / la, ax[1] / la];
      const ey = [bx[0] / lb, bx[1] / lb];
      geo.ux = [ex[0] * Math.cos(rot) + ey[0] * Math.sin(rot), ex[1] * Math.cos(rot) + ey[1] * Math.sin(rot)];
      geo.uy = [-ex[0] * Math.sin(rot) + ey[0] * Math.cos(rot), -ex[1] * Math.sin(rot) + ey[1] * Math.cos(rot)];
      geo.C = P(v.cx / 100, v.cy / 100);
      geo.rx = (v.w / 200) * la;
      geo.ry = (v.h / 200) * lb;
      geo.local = (lx, ly) => [geo.C[0] + geo.ux[0] * lx + geo.uy[0] * ly, geo.C[1] + geo.ux[1] * lx + geo.uy[1] * ly];
    }
    return geo;
  }

  function maskHandles(g) {
    if (g.polygon) {
      const pts = (g.v.points || []).map(([px, py]) => seqToScreen(g.P(px / 100, py / 100)));
      const cen = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
      return { pts, center: cen };
    }
    return {
      center: seqToScreen(g.C),
      e: seqToScreen(g.local(g.rx, 0)),
      s: seqToScreen(g.local(0, g.ry)),
      se: seqToScreen(g.local(g.rx, g.ry)),
      rot: g.fx.type === 'mask' ? seqToScreen(g.local(0, -g.ry - 26 / fr.s)) : null,
    };
  }

  function drawMask(ctx, g) {
    const H = maskHandles(g);
    ctx.save();
    ctx.strokeStyle = '#ffd84d';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (g.polygon) {
      H.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    } else if (g.v.shape === 'rectangle') {
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
        const [x, y] = seqToScreen(g.local(sx * g.rx, sy * g.ry));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    } else {
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const [x, y] = seqToScreen(g.local(Math.cos(a) * g.rx, Math.sin(a) * g.ry));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd84d';
    ctx.strokeStyle = '#000';
    const square = ([x, y]) => {
      ctx.fillRect(x - 5, y - 5, 10, 10);
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    };
    if (g.polygon) H.pts.forEach(square);
    else {
      [H.e, H.s, H.se].forEach(square);
    }
    if (!g.polygon && H.rot) {
      ctx.beginPath();
      ctx.moveTo(...seqToScreen(g.local(0, -g.ry)));
      ctx.lineTo(...H.rot);
      ctx.strokeStyle = '#ffd84d';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(H.rot[0], H.rot[1], 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(H.center[0], H.center[1], 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,216,77,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#ffd84d';
    ctx.stroke();
    ctx.restore();
  }

  /** What mask handle (if any) is under a screen point. */
  function maskHit(g, px, py) {
    const H = maskHandles(g);
    const near = (p) => p && Math.abs(px - p[0]) <= HANDLE && Math.abs(py - p[1]) <= HANDLE;
    if (g.polygon) {
      const i = H.pts.findIndex(near);
      if (i >= 0) return { mode: 'point', index: i };
    } else {
      if (H.rot && Math.hypot(px - H.rot[0], py - H.rot[1]) <= HANDLE) return { mode: 'mrot' };
      if (near(H.se)) return { mode: 'size', axes: 'xy' };
      if (near(H.e)) return { mode: 'size', axes: 'x' };
      if (near(H.s)) return { mode: 'size', axes: 'y' };
    }
    if (Math.hypot(px - H.center[0], py - H.center[1]) <= HANDLE + 2) return { mode: 'mmove' };
    return null;
  }

  // ---- 변형 / 모서리 고정: on-monitor handles while that effect is picked in Effect Controls

  let directFxId = null;
  // a mask picked in Effect Controls has the monitor until another effect is pressed there
  let maskFocus = false;
  // the effect the person works on: the Effect Controls section they last pressed (picking a mask
  // there announces 'mask-target' after this, which hands the monitor to the mask)
  document.addEventListener('pointerdown', (e) => {
    const sec = e.target?.closest?.('.ec-section[data-fx]');
    if (!sec) return;
    if (sec.dataset.fx === directFxId && !maskFocus) return;
    directFxId = sec.dataset.fx;
    maskFocus = false;
    playback.requestRender();
  }, true);

  const RADc = Math.PI / 180;
  /** 변형's matrix in layer space: out = m·(in − anchor) + position (as rendered in fx-video.js). */
  function transformOf(v) {
    const sy = (v.scaleH ?? 100) / 100;
    const sx = v.uniform !== false ? sy : (v.scaleW ?? 100) / 100;
    const rot = (v.rotation || 0) * RADc;
    const sk = Math.tan(clamp(v.skew || 0, -85, 85) * RADc);
    const ax = (v.skewAxis || 0) * RADc;
    const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
    const R = (t) => [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
    const m = mul(R(rot), mul(R(ax), mul([1, sk, 0, 1], mul(R(-ax), [sx, 0, 0, sy]))));
    const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
    return {
      m,
      mi: [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det],
      fwd: (X, Y) => [m[0] * (X - v.anchorX) + m[1] * (Y - v.anchorY) + v.posX, m[2] * (X - v.anchorX) + m[3] * (Y - v.anchorY) + v.posY],
    };
  }

  /** Geometry of the picked 변형 / 모서리 고정 effect of the selected clip, or null. */
  function directTarget() {
    const c = activeClip();
    if (!c || playback.playing || !directFxId) return null;
    if (maskFocus) return null;
    const fx = c.effects.find((e) => e.id === directFxId && e.enabled !== false && (e.type === 'transform' || e.type === 'cornerPin'));
    if (!fx) return null;
    const s = store.seq;
    const q = quadFor(c);
    const size = q && compositor.sourceSize(c, store.ui.playhead);
    if (!size?.w || !size?.h) return null;
    const { w: sw, h: sh } = size;
    const base = size.fit && !c.native ? Math.min(s.width / sw, s.height / sh) : 1;
    const c0 =[(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
    const ax = [(q[1][0] - q[0][0]) / sw, (q[1][1] - q[0][1]) / sw];
    const bx = [(q[3][0] - q[0][0]) / sh, (q[3][1] - q[0][1]) / sh];
    const det = ax[0] * bx[1] - ax[1] * bx[0] || 1e-9;
    // source px (from the source centre) ↔ screen, through the clip's 모션
    const fromSrc = (u, w) => seqToScreen([c0[0] + ax[0] * u + bx[0] * w, c0[1] + ax[1] * u + bx[1] * w]);
    const toSrc = (px, py) => {
      const [X, Y] = screenToSeq(px, py);
      const dx = X - c0[0];
      const dy = Y - c0[1];
      return [(dx * bx[1] - dy * bx[0]) / det, (ax[0] * dy - ax[1] * dx) / det];
    };
    const v = evalEffect(fx, store.ui.playhead - c.start);
    const g = { c, fx, v, type: fx.type };
    if (fx.type === 'transform') {
      // layer space: sequence px of the clip's frame placed fit and centred, before 모션
      g.L2S = (X, Y) => fromSrc((X - s.width / 2) / base, (Y - s.height / 2) / base);
      g.S2L = (px, py) => {
        const [u, w] = toSrc(px, py);
        return [u * base + s.width / 2, w * base + s.height / 2];
      };
      g.T = transformOf(v);
      const hw = (sw * base) / 2;
      const hh = (sh * base) / 2;
      g.corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => g.L2S(...g.T.fwd(s.width / 2 + x, s.height / 2 + y)));
      g.anchor = g.L2S(v.posX, v.posY);
    } else {
      // 모서리 고정: a corner's X / Y is a fraction of the (padded) source times the sequence size
      const pw = size.fit ? sw : Math.max(s.width, sw);
      const ph = size.fit ? sh : Math.max(s.height, sh);
      g.C2S = (X, Y) => fromSrc((X / s.width - 0.5) * pw, (Y / s.height - 0.5) * ph);
      g.S2C = (px, py) => {
        const [u, w] = toSrc(px, py);
        return [(u / pw + 0.5) * s.width, (w / ph + 0.5) * s.height];
      };
      g.pins = ['ul', 'ur', 'lr', 'll'].map((k) => ({ k, p: g.C2S(v[`${k}X`], v[`${k}Y`]) }));
    }
    return g;
  }

  function drawDirect(ctx, g) {
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffb347';
    ctx.fillStyle = '#ffb347';
    if (g.type === 'transform') {
      const pts = g.corners;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      for (const [x, y] of pts) ctx.fillRect(x - 4, y - 4, 8, 8);
      const rot = rotationHandle(pts);
      ctx.beginPath();
      ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
      ctx.lineTo(rot[0], rot[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rot[0], rot[1], 5, 0, Math.PI * 2);
      ctx.fill();
      const [x, y] = g.anchor;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 11, y);
      ctx.lineTo(x + 11, y);
      ctx.moveTo(x, y - 11);
      ctx.lineTo(x, y + 11);
      ctx.stroke();
    } else {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      g.pins.forEach(({ p: [x, y] }, i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 10px sans-serif';
      for (const { k, p: [x, y] } of g.pins) {
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,179,71,0.35)';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb347';
        ctx.fill();
        ctx.fillText({ ul: '왼쪽 위', ur: '오른쪽 위', lr: '오른쪽 아래', ll: '왼쪽 아래' }[k], x + 10, y - 8);
      }
    }
    ctx.restore();
  }

  function directHit(g, px, py) {
    const near = ([x, y], r = HANDLE) => Math.abs(px - x) <= r && Math.abs(py - y) <= r;
    if (g.type === 'cornerPin') {
      const pin = g.pins.find(({ p }) => near(p, HANDLE + 2));
      return pin ? { mode: 'pin', key: pin.k } : null;
    }
    const rot = rotationHandle(g.corners);
    if (Math.hypot(px - rot[0], py - rot[1]) <= HANDLE + 1) return { mode: 'trot' };
    const i = g.corners.findIndex((p) => near(p));
    if (i >= 0) return { mode: 'tscale', index: i };
    if (near(g.anchor, HANDLE + 2)) return { mode: 'tanchor' };
    if (pointInQuad(px, py, g.corners)) return { mode: 'tmove' };
    return null;
  }

  function dragDirect(d, px, py, e) {
    const c = store.seq.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    const g = d.g;
    const v0 = d.v0;
    const r1 = (v) => Math.round(v * 100) / 100;
    const set = (k, v) => edit.rawSetParam(c, fx, k, r1(v));
    if (d.mode === 'pin') {
      const [X, Y] = g.S2C(px, py);
      set(`${d.key}X`, X);
      set(`${d.key}Y`, Y);
    } else if (d.mode === 'tmove') {
      const [x0, y0] = g.S2L(d.x0, d.y0);
      const [x1, y1] = g.S2L(px, py);
      set('posX', v0.posX + x1 - x0);
      set('posY', v0.posY + y1 - y0);
    } else if (d.mode === 'tscale') {
      const P = [v0.posX, v0.posY];
      const L0 = g.S2L(d.x0, d.y0);
      const L1 = g.S2L(px, py);
      if (v0.uniform !== false || e.shiftKey) {
        const k = Math.hypot(L1[0] - P[0], L1[1] - P[1]) / Math.max(1e-6, Math.hypot(L0[0] - P[0], L0[1] - P[1]));
        set('scaleH', clamp((v0.scaleH ?? 100) * k, 0, 10000));
        if (v0.uniform === false) set('scaleW', clamp((v0.scaleW ?? 100) * k, 0, 10000));
      } else {
        // separate width / height: measure the drag along the effect's own (unscaled) axes
        const T1 = transformOf({ ...v0, uniform: false, scaleW: 100, scaleH: 100 });
        const loc = (L) => [T1.mi[0] * (L[0] - P[0]) + T1.mi[1] * (L[1] - P[1]), T1.mi[2] * (L[0] - P[0]) + T1.mi[3] * (L[1] - P[1])];
        const a = loc(L0);
        const b = loc(L1);
        if (Math.abs(a[0]) > 1) set('scaleW', clamp((v0.scaleW ?? 100) * Math.abs(b[0] / a[0]), 0, 10000));
        if (Math.abs(a[1]) > 1) set('scaleH', clamp((v0.scaleH ?? 100) * Math.abs(b[1] / a[1]), 0, 10000));
      }
    } else if (d.mode === 'trot') {
      const [cx, cy] = g.anchor;
      let a = (v0.rotation || 0) + ((Math.atan2(py - cy, px - cx) - Math.atan2(d.y0 - cy, d.x0 - cx)) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      set('rotation', a);
    } else if (d.mode === 'tanchor') {
      // move the anchor point without moving the picture: position follows
      const O = g.S2L(px, py);
      const T0 = transformOf(v0);
      const dP = [O[0] - v0.posX, O[1] - v0.posY];
      set('posX', O[0]);
      set('posY', O[1]);
      set('anchorX', v0.anchorX + T0.mi[0] * dP[0] + T0.mi[1] * dP[1]);
      set('anchorY', v0.anchorY + T0.mi[2] * dP[0] + T0.mi[3] * dP[1]);
    }
    store.changed();
  }

  // ---- per-effect masks: the mask picked in Effect Controls (store.ui.maskSel), Premiere-style

  let maskVertex = -1; // selected vertex of the picked mask
  let penOpen = null; // id of a pen mask still being drawn point by point

  function maskSelTarget() {
    const ms = store.ui.maskSel;
    const c = activeClip();
    if (!ms || !c || c.id !== ms.clipId || playback.playing) return null;
    // shown while it was just picked, or while its own effect is the one being worked on
    if (!maskFocus && directFxId && directFxId !== ms.fxId) return null;
    const fx = c.effects.find((e) => e.id === ms.fxId);
    const mask = fx?.masks?.find((m) => m.id === ms.maskId);
    const quad = mask && quadFor(c);
    if (!quad) return null;
    const tl = store.ui.playhead - c.start;
    const q0 = quad[0];
    const ax = [quad[1][0] - q0[0], quad[1][1] - q0[1]];
    const bx = [quad[3][0] - q0[0], quad[3][1] - q0[1]];
    const det = ax[0] * bx[1] - ax[1] * bx[0] || 1e-9;
    // mask points are percent of the clip's source frame, carried by its 모션
    const P = (x, y) => seqToScreen([q0[0] + (ax[0] * x + bx[0] * y) / 100, q0[1] + (ax[1] * x + bx[1] * y) / 100]);
    const inv = (px, py) => {
      const [X, Y] = screenToSeq(px, py);
      const dx = X - q0[0];
      const dy = Y - q0[1];
      return [((dx * bx[1] - dy * bx[0]) / det) * 100, ((ax[0] * dy - ax[1] * dx) / det) * 100];
    };
    const size = compositor.sourceSize(c, store.ui.playhead);
    const vals = evalMask(mask, tl);
    if (!vals.path.length && penOpen !== mask.id) penOpen = mask.id;
    if (maskVertex >= vals.path.length) maskVertex = -1;
    return { c, fx, mask, tl, path: vals.path, feather: vals.feather, P, inv, pxPer: size?.w ? (Math.hypot(...ax) / size.w) * fr.s : fr.s };
  }

  /** Bezier path through the mapping P (an affine map keeps beziers exact). */
  function traceMapped(ctx, path, P, close = true) {
    const n = path.length;
    if (n < 2) return;
    ctx.moveTo(...P(path[0][0], path[0][1]));
    for (let i = 0; i < (close ? n : n - 1); i++) {
      const a = path[i];
      const b = path[(i + 1) % n];
      if (!a[4] && !a[5] && !b[2] && !b[3]) ctx.lineTo(...P(b[0], b[1]));
      else ctx.bezierCurveTo(...P(a[0] + a[4], a[1] + a[5]), ...P(b[0] + b[2], b[1] + b[3]), ...P(b[0], b[1]));
    }
    if (close) ctx.closePath();
  }

  function featherHandle(g) {
    if (g.path.length < 3) return null;
    let top = null;
    for (const v of g.path) {
      const p = g.P(v[0], v[1]);
      if (!top || p[1] < top[1]) top = p;
    }
    return { from: top, at: [top[0], top[1] - Math.max(12, g.feather * g.pxPer)] };
  }

  function drawMaskSel(ctx, g) {
    const open = penOpen === g.mask.id;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffd84d';
    if (g.path.length >= 2) {
      ctx.beginPath();
      traceMapped(ctx, g.path, g.P, !open && g.path.length >= 3);
      ctx.stroke();
    }
    const fh = !open && featherHandle(g);
    if (fh) {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(...fh.from);
      ctx.lineTo(...fh.at);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(fh.at[0], fh.at[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    }
    const sel = g.path[maskVertex];
    if (sel) {
      const a = g.P(sel[0], sel[1]);
      for (const [dx, dy] of [[sel[2], sel[3]], [sel[4], sel[5]]]) {
        if (!dx && !dy) continue;
        const b = g.P(sel[0] + dx, sel[1] + dy);
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b[0], b[1], 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd84d';
        ctx.fill();
      }
    }
    ctx.strokeStyle = '#1b1d22';
    g.path.forEach((v, i) => {
      const [x, y] = g.P(v[0], v[1]);
      ctx.fillStyle = i === maskVertex ? '#ffd84d' : '#ffffff';
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    });
    if (open) {
      ctx.font = '600 11px sans-serif';
      ctx.fillStyle = '#ffd84d';
      const msg = g.path.length >= 3 ? '첫 점을 누르거나 Enter로 마스크 닫기' : '화면을 눌러 마스크 점을 찍으세요 (끌면 곡선)';
      ctx.fillText(msg, fr.x + 8, fr.y + fr.h - 10);
    }
    ctx.restore();
  }

  /** Nearest point on the path's segments: { index (segment start), t, d } in screen px. */
  function nearestSegment(g, px, py) {
    let best = null;
    const n = g.path.length;
    for (let i = 0; i < n; i++) {
      const a = g.path[i];
      const b = g.path[(i + 1) % n];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        const x = u * u * u * a[0] + 3 * u * u * t * (a[0] + a[4]) + 3 * u * t * t * (b[0] + b[2]) + t * t * t * b[0];
        const y = u * u * u * a[1] + 3 * u * u * t * (a[1] + a[5]) + 3 * u * t * t * (b[1] + b[3]) + t * t * t * b[1];
        const [sx, sy] = g.P(x, y);
        const dd = Math.hypot(px - sx, py - sy);
        if (!best || dd < best.d) best = { index: i, t, d: dd, x, y };
      }
    }
    return best;
  }

  function maskSelHit(g, px, py, e) {
    const near = ([x, y], r = HANDLE) => Math.abs(px - x) <= r && Math.abs(py - y) <= r;
    const sel = g.path[maskVertex];
    if (sel) {
      if ((sel[4] || sel[5]) && near(g.P(sel[0] + sel[4], sel[1] + sel[5]))) return { mode: 'tan', which: 'out' };
      if ((sel[2] || sel[3]) && near(g.P(sel[0] + sel[2], sel[1] + sel[3]))) return { mode: 'tan', which: 'in' };
    }
    const vi = g.path.findIndex((v) => near(g.P(v[0], v[1])));
    if (vi >= 0) return { mode: 'vertex', index: vi };
    if (penOpen === g.mask.id) return { mode: 'penadd' };
    const fh = featherHandle(g);
    if (fh && near(fh.at, HANDLE + 1)) return { mode: 'feather' };
    if (g.path.length >= 3 && (e?.ctrlKey || e?.metaKey)) {
      const seg = nearestSegment(g, px, py);
      if (seg && seg.d <= HANDLE + 4) return { mode: 'addpoint', seg };
    }
    if (g.path.length >= 3 && pointInQuad(px, py, pathPolyline(g.path, 10).map(([x, y]) => g.P(x, y)))) return { mode: 'mpath' };
    return null;
  }

  /** Split segment seg.index at seg.t (de Casteljau), keeping the curve's shape. */
  function splitPath(path, seg) {
    const n = path.length;
    const a = path[seg.index];
    const b = path[(seg.index + 1) % n];
    const t = seg.t;
    const L = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const p0 = [a[0], a[1]];
    const p1 = [a[0] + a[4], a[1] + a[5]];
    const p2 = [b[0] + b[2], b[1] + b[3]];
    const p3 = [b[0], b[1]];
    const q0 = L(p0, p1);
    const q1 = L(p1, p2);
    const q2 = L(p2, p3);
    const r0 = L(q0, q1);
    const r1 = L(q1, q2);
    const m = L(r0, r1);
    const out = path.map((v) => [...v]);
    const curved = a[4] || a[5] || b[2] || b[3];
    if (curved) {
      out[seg.index][4] = q0[0] - p0[0];
      out[seg.index][5] = q0[1] - p0[1];
      out[(seg.index + 1) % n][2] = q2[0] - p3[0];
      out[(seg.index + 1) % n][3] = q2[1] - p3[1];
    }
    const nv = curved ? [m[0], m[1], r0[0] - m[0], r0[1] - m[1], r1[0] - m[0], r1[1] - m[1]] : [m[0], m[1], 0, 0, 0, 0];
    out.splice(seg.index + 1, 0, nv);
    return out;
  }

  /** Smooth tangents for vertex i from its neighbours (Alt+click on a corner point). */
  function smoothVertex(path, i) {
    const n = path.length;
    const p = path[(i - 1 + n) % n];
    const q = path[(i + 1) % n];
    const dx = (q[0] - p[0]) / 6;
    const dy = (q[1] - p[1]) / 6;
    const out = path.map((v) => [...v]);
    out[i] = [out[i][0], out[i][1], -dx, -dy, dx, dy];
    return out;
  }

  const fdSec = () => 1 / store.seq.fps;
  const liveMask = (d) => {
    const c = store.seq.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    return fx?.masks?.find((m) => m.id === d.maskId) || null;
  };

  /** Start a pointer gesture on the picked mask. Returns true when it took the pointer. */
  function maskSelDown(e, g, hit, px, py) {
    const ids = { clipId: g.c.id, fxId: g.fx.id, maskId: g.mask.id };
    const edit1 = (label, fn) => editMask(ids.clipId, ids.fxId, ids.maskId, label, (m) => setMaskPath(m, fn(evalMaskPath(m.params.path, g.tl)), g.tl, fdSec()));
    if (hit.mode === 'vertex') {
      if (penOpen === g.mask.id && hit.index === 0 && g.path.length >= 3) {
        penOpen = null;
        playback.requestRender();
        return true;
      }
      maskVertex = hit.index;
      if (e.altKey) {
        // Alt+click: corner ⇄ smooth point
        const v = g.path[hit.index];
        edit1('마스크 꼭짓점 변환', (path) => (v[2] || v[3] || v[4] || v[5] ? path.map((x, i) => (i === hit.index ? [x[0], x[1], 0, 0, 0, 0] : [...x])) : smoothVertex(path, hit.index)));
        return true;
      }
      view.setPointerCapture(e.pointerId);
      store.begin('마스크 경로 편집');
      handleDrag = { maskSel: true, mode: 'vertex', index: hit.index, ...ids, tl: g.tl, path0: g.path.map((v) => [...v]), g, x0: px, y0: py };
      return true;
    }
    if (hit.mode === 'tan') {
      view.setPointerCapture(e.pointerId);
      store.begin('마스크 곡선 편집');
      handleDrag = { maskSel: true, mode: 'tan', which: hit.which, index: maskVertex, broken: e.altKey, ...ids, tl: g.tl, path0: g.path.map((v) => [...v]), g };
      return true;
    }
    if (hit.mode === 'feather') {
      view.setPointerCapture(e.pointerId);
      store.begin('마스크 페더');
      handleDrag = { maskSel: true, mode: 'feather', ...ids, tl: g.tl, f0: g.feather, y0: py, g };
      return true;
    }
    if (hit.mode === 'mpath') {
      view.setPointerCapture(e.pointerId);
      store.begin('마스크 이동');
      handleDrag = { maskSel: true, mode: 'mpath', ...ids, tl: g.tl, path0: g.path.map((v) => [...v]), g, x0: px, y0: py };
      return true;
    }
    if (hit.mode === 'addpoint') {
      edit1('마스크 점 추가', (path) => splitPath(path, hit.seg));
      maskVertex = hit.seg.index + 1;
      return true;
    }
    if (hit.mode === 'penadd') {
      // a click adds a corner point; dragging pulls out a smooth point's handles
      const [x, y] = g.inv(px, py);
      view.setPointerCapture(e.pointerId);
      store.begin('마스크 점 추가');
      const m = liveMask(ids);
      if (m) setMaskPath(m, [...evalMaskPath(m.params.path, g.tl), [x, y, 0, 0, 0, 0]], g.tl, fdSec());
      store.changed();
      maskVertex = g.path.length;
      handleDrag = { maskSel: true, mode: 'pendrag', index: g.path.length, ...ids, tl: g.tl, g, x0: px, y0: py };
      return true;
    }
    return false;
  }

  function dragMaskSel(d, px, py) {
    const m = liveMask(d);
    if (!m) return;
    const g = d.g;
    const [x, y] = g.inv(px, py);
    const r = (v) => Math.round(v * 100) / 100;
    let path = evalMaskPath(m.params.path, d.tl).map((v) => [...v]);
    if (d.mode === 'vertex') {
      const [x0, y0] = g.inv(d.x0, d.y0);
      const v = d.path0[d.index];
      path[d.index] = [r(v[0] + x - x0), r(v[1] + y - y0), v[2], v[3], v[4], v[5]];
    } else if (d.mode === 'mpath') {
      const [x0, y0] = g.inv(d.x0, d.y0);
      path = d.path0.map((v) => [r(v[0] + x - x0), r(v[1] + y - y0), v[2], v[3], v[4], v[5]]);
    } else if (d.mode === 'tan' || d.mode === 'pendrag') {
      const v = path[d.index];
      if (!v) return;
      const dx = r(x - v[0]);
      const dy = r(y - v[1]);
      if (d.mode === 'pendrag' || d.which === 'out') {
        v[4] = dx;
        v[5] = dy;
        if (!d.broken) {
          v[2] = -dx;
          v[3] = -dy;
        }
      } else {
        v[2] = dx;
        v[3] = dy;
        if (!d.broken) {
          v[4] = -dx;
          v[5] = -dy;
        }
      }
    } else if (d.mode === 'feather') {
      const f = Math.max(0, d.f0 + (d.y0 - py) / Math.max(1e-6, g.pxPer));
      const p = m.params.feather;
      setParamValue(p, Math.round(f * 10) / 10, d.tl, fdSec());
      store.changed();
      return;
    }
    setMaskPath(m, path, d.tl, fdSec());
    store.changed();
  }

  // ---- overlay

  function drawOverlay() {
    const { ctx, w, h: hh } = fitCanvasToBox(overlay, { cached: true });
    ctx.clearRect(0, 0, w, hh);
    const s = store.seq;
    drawFrameOverlays(ctx, s, fr);
    if (rr && (safe || opts.thirds || opts.cross)) drawFrameOverlays(ctx, s, rr);
    if (opts.guides) drawGuides(ctx, s);
    if (cmp.on) drawCompareMarks(ctx);
    const direct = !playback.playing && directTarget();
    const msel = !playback.playing && !direct && maskSelTarget();
    if (direct) drawDirect(ctx, direct);
    else if (msel) drawMaskSel(ctx, msel);
    else if (!playback.playing) {
      const c = activeClip();
      const quad = c && quadFor(c);
      if (c && quad) {
        drawMotionPath(ctx, c);
        const pts = quad.map(seqToScreen);
        ctx.strokeStyle = '#4aa3ff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const [x, y] of pts) ctx.fillRect(x - 4, y - 4, 8, 8);
        const rot = rotationHandle(pts);
        ctx.beginPath();
        ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
        ctx.lineTo(rot[0], rot[1]);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rot[0], rot[1], 5, 0, Math.PI * 2);
        ctx.fill();
        // anchor (centre)
        const motion = c.effects.find((e) => e.type === 'motion');
        if (motion) {
          const m = evalEffect(motion, store.ui.playhead - c.start);
          const [ax, ay] = seqToScreen([m.posX, m.posY]);
          ctx.strokeStyle = '#fff';
          ctx.beginPath();
          ctx.arc(ax, ay, 6, 0, Math.PI * 2);
          ctx.moveTo(ax - 9, ay);
          ctx.lineTo(ax + 9, ay);
          ctx.moveTo(ax, ay - 9);
          ctx.lineTo(ax, ay + 9);
          ctx.stroke();
        }
        const g = maskTarget();
        if (g) drawMask(ctx, g);
      }
    }
    if (snapLines) drawSnapLines(ctx);
    if (opts.rulers) drawRulers(ctx, w, hh);
    if (viewDrag?.type === 'guide') drawGuideDrag(ctx);
  }

  /** Safe margins, rule of thirds and centre cross for one frame rect. */
  function drawFrameOverlays(ctx, s, R) {
    const map = ([x, y]) => [R.x + x * R.s, R.y + y * R.s];
    ctx.save();
    ctx.lineWidth = 1;
    if (safe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      for (const k of [0.9, 0.8]) {
        const mw = R.w * k;
        const mh = R.h * k;
        ctx.strokeRect(Math.round(R.x + (R.w - mw) / 2) + 0.5, Math.round(R.y + (R.h - mh) / 2) + 0.5, Math.round(mw), Math.round(mh));
      }
      const [cx, cy] = map([s.width / 2, s.height / 2]);
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy);
      ctx.lineTo(cx + 10, cy);
      ctx.moveTo(cx, cy - 10);
      ctx.lineTo(cx, cy + 10);
      ctx.stroke();
    }
    if (opts.thirds) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      for (const k of [1 / 3, 2 / 3]) {
        const x = Math.round(R.x + R.w * k) + 0.5;
        const y = Math.round(R.y + R.h * k) + 0.5;
        ctx.moveTo(x, R.y);
        ctx.lineTo(x, R.y + R.h);
        ctx.moveTo(R.x, y);
        ctx.lineTo(R.x + R.w, y);
      }
      ctx.stroke();
    }
    if (opts.cross) {
      const x = Math.round(R.x + R.w / 2) + 0.5;
      const y = Math.round(R.y + R.h / 2) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, R.y);
      ctx.lineTo(x, R.y + R.h);
      ctx.moveTo(R.x, y);
      ctx.lineTo(R.x + R.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function guideScreen(g) {
    return g.dir === 'h' ? fr.y + g.pos * fr.s : fr.x + g.pos * fr.s;
  }

  function drawGuides(ctx) {
    const list = guides();
    if (!list.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (const g of list) {
      if (viewDrag?.type === 'guide' && viewDrag.id === g.id) continue;
      const p = Math.round(guideScreen(g)) + 0.5;
      ctx.strokeStyle = hoverGuide === g.id ? '#ffffff' : GUIDE_COLOR;
      ctx.beginPath();
      if (g.dir === 'h') {
        ctx.moveTo(slot.x, p);
        ctx.lineTo(slot.x + slot.w, p);
      } else {
        ctx.moveTo(p, slot.y);
        ctx.lineTo(p, slot.y + slot.h);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGuideDrag(ctx) {
    const d = viewDrag;
    if (d.pos == null) return;
    const p = Math.round(d.dir === 'h' ? fr.y + d.pos * fr.s : fr.x + d.pos * fr.s) + 0.5;
    ctx.save();
    ctx.strokeStyle = d.remove ? 'rgba(255,90,90,0.9)' : GUIDE_COLOR;
    ctx.setLineDash(d.remove ? [4, 4] : []);
    ctx.beginPath();
    if (d.dir === 'h') {
      ctx.moveTo(slot.x, p);
      ctx.lineTo(slot.x + slot.w, p);
    } else {
      ctx.moveTo(p, slot.y);
      ctx.lineTo(p, slot.y + slot.h);
    }
    ctx.stroke();
    const label = d.remove ? '놓으면 삭제' : `${d.dir === 'h' ? 'Y' : 'X'} ${Math.round(d.pos)}px`;
    ctx.font = '600 11px sans-serif';
    const tw = ctx.measureText(label).width + 10;
    const lx = d.dir === 'h' ? clamp(d.px + 12, 0, overlay.clientWidth - tw) : p + 6;
    const ly = d.dir === 'h' ? p - 22 : clamp(d.py + 12, 0, overlay.clientHeight - 18);
    ctx.fillStyle = 'rgba(15,17,21,0.9)';
    ctx.fillRect(lx, ly, tw, 17);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 5, ly + 12);
    ctx.restore();
  }

  function drawSnapLines(ctx) {
    ctx.save();
    ctx.strokeStyle = SNAP_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of snapLines.xs) {
      const sx = Math.round(fr.x + x * fr.s) + 0.5;
      ctx.moveTo(sx, slot.y);
      ctx.lineTo(sx, slot.y + slot.h);
    }
    for (const y of snapLines.ys) {
      const sy = Math.round(fr.y + y * fr.s) + 0.5;
      ctx.moveTo(slot.x, sy);
      ctx.lineTo(slot.x + slot.w, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Rulers in sequence pixels along the top and left edges. */
  function drawRulers(ctx, w, hh) {
    ctx.save();
    ctx.fillStyle = '#1b1e24';
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillRect(0, 0, RULER, hh);
    ctx.strokeStyle = '#3a404b';
    ctx.beginPath();
    ctx.moveTo(0, RULER - 0.5);
    ctx.lineTo(w, RULER - 0.5);
    ctx.moveTo(RULER - 0.5, 0);
    ctx.lineTo(RULER - 0.5, hh);
    ctx.stroke();
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const major = steps.find((st) => st * fr.s >= 56) || 10000;
    const minor = major / (String(major).startsWith('25') ? 5 : String(major).startsWith('2') ? 4 : 5);
    ctx.fillStyle = '#9aa3b2';
    ctx.strokeStyle = '#6b7383';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    // top (x)
    ctx.save();
    ctx.beginPath();
    ctx.rect(RULER, 0, w - RULER, RULER);
    ctx.clip();
    const x0 = Math.floor(screenToSeq(RULER, 0)[0] / minor) * minor;
    const x1 = screenToSeq(w, 0)[0];
    ctx.beginPath();
    for (let v = x0; v <= x1; v += minor) {
      const sx = Math.round(fr.x + v * fr.s) + 0.5;
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      ctx.moveTo(sx, isMajor ? 3 : RULER - 5);
      ctx.lineTo(sx, RULER);
      if (isMajor) ctx.fillText(String(Math.round(v)), sx + 3, 2);
    }
    ctx.stroke();
    ctx.restore();
    // left (y)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, RULER, hh - RULER);
    ctx.clip();
    const y0 = Math.floor(screenToSeq(0, RULER)[1] / minor) * minor;
    const y1 = screenToSeq(0, hh)[1];
    ctx.beginPath();
    for (let v = y0; v <= y1; v += minor) {
      const sy = Math.round(fr.y + v * fr.s) + 0.5;
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      ctx.moveTo(isMajor ? 3 : RULER - 5, sy);
      ctx.lineTo(RULER, sy);
      if (isMajor) {
        ctx.save();
        ctx.translate(2, sy + 3);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(String(Math.round(v)), 0, -RULER + 6);
        ctx.restore();
      }
    }
    ctx.stroke();
    ctx.restore();
    // frame extent marks
    ctx.fillStyle = 'rgba(74,163,255,0.35)';
    ctx.fillRect(Math.max(RULER, fr.x), RULER - 3, Math.max(0, Math.min(w, fr.x + fr.w) - Math.max(RULER, fr.x)), 3);
    ctx.fillRect(RULER - 3, Math.max(RULER, fr.y), 3, Math.max(0, Math.min(hh, fr.y + fr.h) - Math.max(RULER, fr.y)));
    ctx.restore();
  }

  /** Labels and the split divider of the comparison view. */
  function drawCompareMarks(ctx) {
    const s = store.seq;
    const before = cmp.kind === 'beforeafter';
    const refLabel = before ? '편집 전' : `참조 ${formatTimecode(cmp.refT ?? 0, s.fps)}`;
    const curLabel = before ? '편집 후' : `현재 ${formatTimecode(store.ui.playhead, s.fps)}`;
    const tag = (text, x, y) => {
      ctx.font = '600 11px sans-serif';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(12,14,18,0.78)';
      ctx.fillRect(x, y, tw, 17);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 5, y + 12);
    };
    ctx.save();
    if (rr) {
      tag(refLabel, rr.x + 6, rr.y + 6);
      tag(curLabel, fr.x + 6, fr.y + 6);
    } else {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (cmp.mode === 'vsplit') {
        const x = fr.x + fr.w * cmp.split;
        ctx.moveTo(x, fr.y);
        ctx.lineTo(x, fr.y + fr.h);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, fr.y + fr.h / 2, 7, 0, Math.PI * 2);
        ctx.fill();
        tag(refLabel, fr.x + 6, fr.y + 6);
        ctx.font = '600 11px sans-serif';
        tag(curLabel, fr.x + fr.w - ctx.measureText(curLabel).width - 16, fr.y + 6);
      } else {
        const y = fr.y + fr.h * cmp.split;
        ctx.moveTo(fr.x, y);
        ctx.lineTo(fr.x + fr.w, y);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(fr.x + fr.w / 2, y, 7, 0, Math.PI * 2);
        ctx.fill();
        tag(refLabel, fr.x + 6, fr.y + 6);
        tag(curLabel, fr.x + 6, fr.y + fr.h - 23);
      }
    }
    ctx.restore();
  }

  // recording off but the object already moves: its whole motion was shifted (say so once per drag)
  let shiftNoted = false;
  function noteShift(r) {
    if (r !== 'shifted' || shiftNoted) return;
    shiftNoted = true;
    toast('키프레임 기록이 꺼져 있어 새 키프레임 없이 움직임 전체를 함께 옮겼습니다. 이 위치에 키프레임을 만들려면 키프레임 기록을 켜세요.');
  }

  /** Dashed path of the clip's position over time, with diamonds at its keyframes (the current one bigger). */
  function drawMotionPath(ctx, c) {
    const path = motionPath(c);
    if (!path) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 214, 102, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    path.pts.forEach((p, i) => {
      const [x, y] = seqToScreen(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    const tNow = store.ui.playhead - c.start;
    for (const k of path.keys) {
      const [x, y] = seqToScreen([k.x, k.y]);
      const now = Math.abs(k.t - tNow) < 0.5 / store.seq.fps;
      const r = now ? 8 : 6;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = now ? '#ffd666' : '#ffffff';
      ctx.strokeStyle = '#1b1d22';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The keyframe diamond of the selected clip's motion path under the pointer. On the object
   * itself, grabbing it moves the object at the current time (that is how new keyframes are made),
   * so there only the current time's own diamond counts.
   */
  function pathKeyAt(c, px, py) {
    const path = c && !playback.playing ? motionPath(c) : null;
    if (!path) return null;
    const quad = quadFor(c)?.map(seqToScreen);
    const onBody = quad && pointInQuad(px, py, quad);
    const tNow = store.ui.playhead - c.start;
    return path.keys.find((k) => {
      const [x, y] = seqToScreen([k.x, k.y]);
      if (Math.hypot(px - x, py - y) > HANDLE + 2) return false;
      return !onBody || Math.abs(k.t - tNow) < 0.5 / store.seq.fps;
    }) || null;
  }

  function rotationHandle(pts) {
    const mx = (pts[0][0] + pts[1][0]) / 2;
    const my = (pts[0][1] + pts[1][1]) / 2;
    const cx = (pts[0][0] + pts[2][0]) / 2;
    const cy = (pts[0][1] + pts[2][1]) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [mx + (dx / len) * 24, my + (dy / len) * 24];
  }

  function pointInQuad(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Visible clips whose bounds contain the point, topmost first. */
  function clipsAtPoint(px, py) {
    const s = store.seq;
    const t = store.ui.playhead;
    const out = [];
    for (const tr of videoTracks(s).filter((x) => !x.hidden).reverse()) {
      const c = clipsOnTrack(s, tr.id).find((x) => t >= x.start && t < clipEnd(x) && x.enabled !== false && x.kind !== 'adjustment');
      if (!c) continue;
      const q = quadFor(c);
      if (q && pointInQuad(px, py, q.map(seqToScreen))) out.push(c);
    }
    return out;
  }

  const clipAtPoint = (px, py) => clipsAtPoint(px, py)[0] || null;

  /** Corner / rotation handle of the selected clip under the pointer. */
  function selHandleAt(px, py) {
    const c = activeClip();
    if (!c || playback.playing) return null;
    const pts = quadFor(c)?.map(seqToScreen);
    if (!pts) return null;
    const rot = rotationHandle(pts);
    if (Math.hypot(px - rot[0], py - rot[1]) < HANDLE + 1) return 'rotate';
    if (pts.some(([x, y]) => Math.abs(px - x) < HANDLE && Math.abs(py - y) < HANDLE)) return 'scale';
    return null;
  }

  /** The guide line under the pointer (guides shown and unlocked). */
  function guideAt(px, py) {
    if (!opts.guides || opts.lockGuides) return null;
    if (px < slot.x || px > slot.x + slot.w || py < slot.y || py > slot.y + slot.h) return null;
    const tol = HANDLE > 7 ? 10 : 4;
    let best = null;
    let bd = tol;
    for (const g of guides()) {
      const d = Math.abs((g.dir === 'h' ? py : px) - guideScreen(g));
      if (d <= bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  }

  /** Ctrl+click on a polygon mask: insert a point on the nearest edge. */
  function insertPolygonPoint(g, px, py) {
    const [u, w] = g.inv(screenToSeq(px, py));
    const pts = g.v.points;
    let best = 0;
    let bd = Infinity;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const [ax, ay] = [p[0] / 100, p[1] / 100];
      const [bx, by] = [q[0] / 100, q[1] / 100];
      const L = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9;
      const tt = clamp(((u - ax) * (bx - ax) + (w - ay) * (by - ay)) / L, 0, 1);
      const d = Math.hypot(u - (ax + (bx - ax) * tt), w - (ay + (by - ay) * tt));
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    store.transact('마스크 점 추가', () => {
      const f = store.seq.clips[g.c.id]?.effects.find((e) => e.id === g.fx.id);
      if (f) f.params.points.value.splice(best + 1, 0, [Math.round(u * 1000) / 10, Math.round(w * 1000) / 10]);
    });
  }

  // ---- view gestures: pan, rulers / guides, comparison divider and reference scrub

  /** Start a view gesture if the pointer is on a ruler, guide, divider or reference frame. */
  function viewPointerDown(e, px, py) {
    if (opts.rulers && (py < RULER || px < RULER)) {
      if (py < RULER && px < RULER) return true;
      viewDrag = { type: 'guide', dir: py < RULER ? 'h' : 'v', id: null, pos: null, px, py, remove: false };
      view.setPointerCapture(e.pointerId);
      return true;
    }
    if (cmp.on && !rr) {
      const near = cmp.mode === 'vsplit'
        ? Math.abs(px - (fr.x + fr.w * cmp.split)) < HANDLE + 2 && py >= fr.y && py <= fr.y + fr.h
        : Math.abs(py - (fr.y + fr.h * cmp.split)) < HANDLE + 2 && px >= fr.x && px <= fr.x + fr.w;
      if (near) {
        viewDrag = { type: 'divider' };
        view.setPointerCapture(e.pointerId);
        return true;
      }
    }
    if (rr && px >= rr.x && px <= rr.x + rr.w && py >= rr.y && py <= rr.y + rr.h) {
      if (cmp.kind === 'frame') {
        viewDrag = { type: 'refscrub', x0: px, t0: cmp.refT ?? 0 };
        view.setPointerCapture(e.pointerId);
      }
      return true;
    }
    if (!selHandleAt(px, py)) {
      const g = guideAt(px, py);
      if (g) {
        store.begin('안내선 이동');
        viewDrag = { type: 'guide', dir: g.dir, id: g.id, pos: g.pos, px, py, remove: false };
        view.setPointerCapture(e.pointerId);
        return true;
      }
    }
    return false;
  }

  function viewPointerMove(e, px, py) {
    const d = viewDrag;
    if (d.type === 'pan') {
      pan = { x: d.pan0.x + (px - d.x0), y: d.pan0.y + (py - d.y0) };
      layout();
      return;
    }
    if (d.type === 'guide') {
      d.px = px;
      d.py = py;
      const [sx, sy] = screenToSeq(px, py);
      let pos = d.dir === 'h' ? sy : sx;
      if (e.shiftKey) {
        // Shift: snap to the ruler's ticks
        const st = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v * fr.s >= 12) || 1000;
        pos = Math.round(pos / st) * st;
      }
      d.pos = Math.round(pos * 10) / 10;
      // dragged back onto the ruler (or out of the view): the guide goes away
      const r = view.getBoundingClientRect();
      d.remove = (d.dir === 'h' ? py < area.y : px < area.x) || px > r.width || py > r.height || px < 0 || py < 0;
      if (d.id) {
        const g = (store.seq.guides || []).find((x) => x.id === d.id);
        if (g) g.pos = d.pos;
      }
      drawOverlay();
      return;
    }
    if (d.type === 'divider') {
      cmp.split = cmp.mode === 'vsplit' ? clamp((px - fr.x) / fr.w, 0.02, 0.98) : clamp((py - fr.y) / fr.h, 0.02, 0.98);
      layout();
      return;
    }
    if (d.type === 'refscrub' && rr) {
      const dur = Math.max(1 / store.seq.fps, sequenceDuration(store.seq));
      setRefT(d.t0 + ((px - d.x0) / rr.w) * Math.min(dur, 10));
    }
  }

  function viewPointerUp() {
    const d = viewDrag;
    viewDrag = null;
    view.style.cursor = '';
    if (d.type === 'guide') {
      if (d.id) {
        if (d.remove) {
          const s = store.seq;
          s.guides = (s.guides || []).filter((g) => g.id !== d.id);
        }
        store.changed();
        store.commit();
      } else if (d.pos != null && !d.remove) {
        addGuide(d.dir, d.pos);
        if (!opts.guides) setOpt('guides', true);
      }
      drawOverlay();
    }
  }

  // ---- clip snapping while moving

  /** Snap a moved clip's edges / centre to guides, the frame edges and the frame centre. */
  function snapMove(d, nx, ny) {
    const s = store.seq;
    const tol = SNAP_PX / fr.s;
    const xs = [0, s.width / 2, s.width];
    const ys = [0, s.height / 2, s.height];
    if (opts.guides) for (const g of guides()) (g.dir === 'v' ? xs : ys).push(g.pos);
    const pick = (pos, feats, targets) => {
      let best = null;
      for (const f of feats) {
        for (const tg of targets) {
          const diff = tg - (pos + f);
          if (Math.abs(diff) <= tol && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, at: tg };
        }
      }
      return best;
    };
    const bx = pick(nx, [d.box.l, (d.box.l + d.box.r) / 2, d.box.r], xs);
    const by = pick(ny, [d.box.t, (d.box.t + d.box.b) / 2, d.box.b], ys);
    snapLines = { xs: bx ? [bx.at] : [], ys: by ? [by.at] : [] };
    return { nx: bx ? nx + bx.diff : nx, ny: by ? ny + by.diff : ny };
  }

  const touches = new Map();
  view.addEventListener('pointerdown', (e) => {
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    HANDLE = e.pointerType === 'touch' ? 16 : 7;
    // panning a zoomed-in view: middle button anywhere, or the hand tool (H)
    if (e.button === 1 || (e.button === 0 && store.ui.tool === 'hand' && !touches.size)) {
      e.preventDefault();
      store.setFocus('program');
      if (!pannable()) {
        if (e.button === 0) toast('화면을 확대하면(확대/축소 레벨 100% 이상) 손 도구로 끌어 이동할 수 있습니다');
        return;
      }
      view.setPointerCapture(e.pointerId);
      viewDrag = { type: 'pan', x0: px, y0: py, pan0: { ...pan } };
      view.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: px, y: py });
      view.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        if (viewDrag) return;
        startPinch();
        return;
      }
      if (touches.size > 2) return;
    }
    store.setFocus('program');
    if (viewPointerDown(e, px, py)) return;
    if (store.ui.tool === 'type') {
      // keep the press from moving the keyboard focus back to the page: what the person types next
      // goes into the new title's text box, not to the editor's single-key shortcuts
      e.preventDefault();
      const [sx, sy] = screenToSeq(px, py);
      edit.addTextClip({ x: sx, y: sy, point: true });
      store.setTool('select');
      store.emit('reveal-effect-controls', { focusText: true });
      return;
    }
    playback.stop();
    // the effect picked in Effect Controls (변형, 모서리 고정, an effect's mask) comes first
    const dg = directTarget();
    const dhit = dg && directHit(dg, px, py);
    if (dhit) {
      view.setPointerCapture(e.pointerId);
      store.begin(dg.type === 'cornerPin' ? '모서리 고정' : '변형');
      handleDrag = { ...dhit, direct: true, clipId: dg.c.id, fxId: dg.fx.id, x0: px, y0: py, v0: dg.v, g: dg };
      return;
    }
    const mg = !dg && maskSelTarget();
    if (mg) {
      const hit = maskSelHit(mg, px, py, e);
      if (hit && maskSelDown(e, mg, hit, px, py)) return;
    }
    // masks first
    const g = maskTarget();
    if (g) {
      const hit = maskHit(g, px, py);
      if (hit?.mode === 'point' && e.altKey) {
        if (g.v.points.length > 3) {
          store.transact('마스크 점 삭제', () => {
            const f = store.seq.clips[g.c.id]?.effects.find((x) => x.id === g.fx.id);
            if (f) f.params.points.value.splice(hit.index, 1);
          });
        } else toast('다각형에는 점이 3개 이상 있어야 합니다');
        return;
      }
      if (!hit && g.polygon && (e.ctrlKey || e.metaKey)) {
        insertPolygonPoint(g, px, py);
        return;
      }
      if (hit) {
        view.setPointerCapture(e.pointerId);
        store.begin('마스크 편집');
        handleDrag = { ...hit, mask: true, clipId: g.c.id, fxId: g.fx.id, x0: px, y0: py, v0: g.v, g };
        return;
      }
    }
    let c = activeClip();
    const key = pathKeyAt(c, px, py);
    if (key) {
      // drag a diamond to move that keyframe's position; a tap jumps to it
      view.setPointerCapture(e.pointerId);
      store.begin('키프레임 위치 (모션 경로)');
      handleDrag = { mode: 'pathkey', clipId: c.id, t: key.t, kx: key.x, ky: key.y, x0: px, y0: py, moved: false };
      return;
    }
    let pts = c && quadFor(c)?.map(seqToScreen);
    // the selected clip's corner / rotation handles win, even where other clips lie on top
    let mode = selHandleAt(px, py);
    if (!mode) {
      // otherwise the topmost visible clip under the pointer is picked (a full-frame video that was
      // just added and selected must not swallow clicks on titles above it); Alt+click cycles to
      // the clips underneath
      const stack = clipsAtPoint(px, py);
      let hit = stack[0] || null;
      if (e.altKey && stack.length > 1) {
        const i = c ? stack.findIndex((x) => x.id === c.id) : -1;
        hit = stack[(i + 1) % stack.length];
      }
      if (hit) {
        if (!c || hit.id !== c.id) {
          store.selectClips([...edit.withLinked([hit.id])]);
          c = hit;
          pts = quadFor(c)?.map(seqToScreen);
        }
        mode = 'move';
      } else if (pts && pointInQuad(px, py, pts)) {
        mode = 'move';
      } else {
        store.clearSelection();
        return;
      }
    }
    const motion = c.effects.find((fx) => fx.type === 'motion');
    if (!motion || !pts) return;
    const m = evalEffect(motion, store.ui.playhead - c.start);
    const [cx, cy] = seqToScreen([m.posX, m.posY]);
    const quad = quadFor(c) || [];
    const qx = quad.map((p) => p[0]);
    const qy = quad.map((p) => p[1]);
    view.setPointerCapture(e.pointerId);
    shiftNoted = false;
    store.begin(mode === 'move' ? '위치 이동 (모션)' : mode === 'scale' ? '크기 조절 (모션)' : '회전 (모션)');
    handleDrag = {
      mode, clipId: c.id, fxId: motion.id, x0: px, y0: py, m0: m, cx, cy,
      d0: Math.hypot(px - cx, py - cy) || 1, a0: Math.atan2(py - cy, px - cx),
      box: { l: Math.min(...qx) - m.posX, r: Math.max(...qx) - m.posX, t: Math.min(...qy) - m.posY, b: Math.max(...qy) - m.posY },
    };
  });

  function dragMask(d, px, py) {
    const s = store.seq;
    const c = s.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    const g = d.g;
    const r1 = (v) => Math.round(v * 10) / 10;
    const [u, w] = g.inv(screenToSeq(px, py));
    const [u0, w0] = g.inv(screenToSeq(d.x0, d.y0));
    if (d.mode === 'point') {
      const pts = fx.params.points.value;
      if (pts[d.index]) pts[d.index] = [r1(u * 100), r1(w * 100)];
    } else if (d.mode === 'mmove') {
      if (g.polygon) {
        const base = d.v0.points;
        fx.params.points.value = base.map(([x, y]) => [r1(x + (u - u0) * 100), r1(y + (w - w0) * 100)]);
      } else {
        edit.rawSetParam(c, fx, 'cx', r1(d.v0.cx + (u - u0) * 100));
        edit.rawSetParam(c, fx, 'cy', r1(d.v0.cy + (w - w0) * 100));
      }
    } else if (d.mode === 'size') {
      const [sx, sy] = screenToSeq(px, py);
      const dx = sx - g.C[0];
      const dy = sy - g.C[1];
      const lx = Math.abs(dx * g.ux[0] + dy * g.ux[1]);
      const ly = Math.abs(dx * g.uy[0] + dy * g.uy[1]);
      if (d.axes.includes('x')) edit.rawSetParam(c, fx, 'w', r1(clamp((lx * 2 * 100) / g.la, 0.5, 300)));
      if (d.axes.includes('y')) edit.rawSetParam(c, fx, 'h', r1(clamp((ly * 2 * 100) / g.lb, 0.5, 300)));
    } else if (d.mode === 'mrot' && 'rotation' in fx.params) {
      const C = seqToScreen(g.C);
      const a0 = Math.atan2(d.y0 - C[1], d.x0 - C[0]);
      const a1 = Math.atan2(py - C[1], px - C[0]);
      edit.rawSetParam(c, fx, 'rotation', r1((d.v0.rotation || 0) + ((a1 - a0) * 180) / Math.PI));
    }
    store.changed();
  }

  /** Two fingers on the selected clip: pinch = scale, twist = rotate, move together = position. */
  function startPinch() {
    const c = activeClip();
    if (!c) return;
    const motion = c.effects.find((fx) => fx.type === 'motion');
    if (!motion) return;
    if (!handleDrag) {
      shiftNoted = false;
      store.begin('크기·회전 (두 손가락)');
    }
    const [a, b] = [...touches.values()];
    handleDrag = {
      mode: 'pinch', clipId: c.id, fxId: motion.id, m0: evalEffect(motion, store.ui.playhead - c.start),
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2,
    };
  }

  function movePinch() {
    const d = handleDrag;
    const pts = [...touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const c = store.seq.clips[d.clipId];
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    const k = Math.hypot(a.x - b.x, a.y - b.y) / d.d0;
    let rot = d.m0.rotation + ((Math.atan2(b.y - a.y, b.x - a.x) - d.a0) * 180) / Math.PI;
    if (Math.abs(rot - Math.round(rot / 90) * 90) < 4) rot = Math.round(rot / 90) * 90; // snap to straight angles
    noteShift(edit.rawSetParam(c, fx, 'scale', Math.round(clamp(d.m0.scale * k, 1, 2000) * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'rotation', Math.round(rot * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'posX', Math.round((d.m0.posX + ((a.x + b.x) / 2 - d.mx0) / fr.s) * 10) / 10, { direct: true }));
    noteShift(edit.rawSetParam(c, fx, 'posY', Math.round((d.m0.posY + ((a.y + b.y) / 2 - d.my0) / fr.s) * 10) / 10, { direct: true }));
    store.changed();
  }

  view.addEventListener('pointermove', (e) => {
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: px, y: py });
    if (viewDrag) {
      viewPointerMove(e, px, py);
      return;
    }
    if (handleDrag?.mode === 'pinch') {
      movePinch();
      return;
    }
    if (touches.size > 1) return;
    if (!handleDrag) {
      updateCursor(px, py, e);
      return;
    }
    const d = handleDrag;
    if (d.direct) {
      dragDirect(d, px, py, e);
      return;
    }
    if (d.maskSel) {
      dragMaskSel(d, px, py);
      return;
    }
    if (d.mask) {
      dragMask(d, px, py);
      return;
    }
    const s = store.seq;
    const c = s.clips[d.clipId];
    if (d.mode === 'pathkey') {
      if (!c) return;
      if (Math.hypot(px - d.x0, py - d.y0) > 3) d.moved = true;
      if (!d.moved) return;
      rawSetPathKey(c, d.t, Math.round((d.kx + (px - d.x0) / fr.s) * 10) / 10, Math.round((d.ky + (py - d.y0) / fr.s) * 10) / 10);
      store.changed();
      return;
    }
    const fx = c?.effects.find((x) => x.id === d.fxId);
    if (!fx) return;
    if (d.mode === 'move') {
      let nx = d.m0.posX + (px - d.x0) / fr.s;
      let ny = d.m0.posY + (py - d.y0) / fr.s;
      snapLines = null;
      if (!e.shiftKey) {
        if (opts.snap) ({ nx, ny } = snapMove(d, nx, ny));
        else {
          if (Math.abs(nx - s.width / 2) * fr.s < SNAP_PX) nx = s.width / 2;
          if (Math.abs(ny - s.height / 2) * fr.s < SNAP_PX) ny = s.height / 2;
        }
      }
      noteShift(edit.rawSetParam(c, fx, 'posX', Math.round(nx * 10) / 10, { direct: true }));
      noteShift(edit.rawSetParam(c, fx, 'posY', Math.round(ny * 10) / 10, { direct: true }));
    } else if (d.mode === 'scale') {
      const dist = Math.hypot(px - d.cx, py - d.cy);
      noteShift(edit.rawSetParam(c, fx, 'scale', Math.round(clamp((d.m0.scale * dist) / d.d0, 0, 2000) * 10) / 10, { direct: true }));
    } else {
      let a = d.m0.rotation + ((Math.atan2(py - d.cy, px - d.cx) - d.a0) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      noteShift(edit.rawSetParam(c, fx, 'rotation', Math.round(a * 10) / 10, { direct: true }));
    }
    store.changed();
  });

  const endDrag = (e) => {
    if (e?.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (handleDrag?.mode === 'pinch' && touches.size >= 2) return;
    }
    if (viewDrag) {
      viewPointerUp();
      touches.clear();
      return;
    }
    snapLines = null;
    if (!handleDrag) return;
    const d = handleDrag;
    handleDrag = null;
    if (d.mode === 'pathkey' && !d.moved) {
      store.cancel();
      const c = store.seq.clips[d.clipId];
      if (c) store.setPlayhead(Math.min(c.start + d.t, clipEnd(c) - 1e-3));
      touches.clear();
      return;
    }
    store.commit();
    touches.clear();
    playback.requestRender();
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('dblclick', (e) => {
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const g = opts.guides && !opts.lockGuides ? guideAt(px, py) : null;
    if (g) {
      guideDialog(g);
      return;
    }
    if (store.ui.tool === 'hand') {
      setZoom('fit');
      return;
    }
    const c = clipAtPoint(px, py);
    if (c) {
      store.selectClips([c.id]);
      store.emit('reveal-effect-controls', { focusText: c.kind === 'text' });
    }
  });
  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const g = guideAt(e.clientX - r.left, e.clientY - r.top);
    if (g) {
      showMenu([
        { label: '안내선 위치 입력…', action: () => guideDialog(g) },
        { label: '이 안내선 삭제', action: () => store.transact('안내선 삭제', () => { store.seq.guides = guides().filter((x) => x.id !== g.id); }) },
        { label: '안내선 모두 지우기', action: clearGuides },
      ], e.clientX, e.clientY);
      return;
    }
    showMenu(settingsMenu(), e.clientX, e.clientY);
  });

  // wheel: pan a zoomed-in view (Shift = sideways), Ctrl/Alt+wheel zooms; otherwise step frames
  let wheelAcc = 0;
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const levels = ZOOM_LEVELS.filter(([v]) => v !== 'fit').map(([v]) => parseFloat(v));
      const cur = fr.s;
      const next = e.deltaY < 0 ? levels.find((z) => z > cur * 1.01) : [...levels].reverse().find((z) => z < cur * 0.99);
      if (next == null) return;
      const [sx, sy] = screenToSeq(px, py);
      zoom = String(next);
      zoomSel.value = zoom;
      savePref('program.zoom', zoom);
      pan = { x: 0, y: 0 };
      layout();
      // keep the point under the pointer where it was
      pan = { x: px - (fr.cx + sx * fr.s), y: py - (fr.cy + sy * fr.s) };
      layout();
      return;
    }
    if (pannable()) {
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      pan = { x: pan.x - dx, y: pan.y - dy };
      layout();
      return;
    }
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 40) return;
    const n = Math.sign(wheelAcc);
    wheelAcc = 0;
    playback.step(n);
  }, { passive: false });

  let hoverGuide = null;
  function updateCursor(px, py, e) {
    const prevHover = hoverGuide;
    hoverGuide = null;
    if (store.ui.tool === 'hand') {
      view.style.cursor = pannable() ? 'grab' : 'default';
      return;
    }
    if (opts.rulers && (py < RULER || px < RULER)) {
      view.style.cursor = py < RULER && px < RULER ? 'default' : py < RULER ? 'row-resize' : 'col-resize';
      view.title = '눈금자: 끌어서 안내선 만들기';
      return;
    }
    if (cmp.on && !rr) {
      const onDivider = cmp.mode === 'vsplit' ? Math.abs(px - (fr.x + fr.w * cmp.split)) < HANDLE + 2 : Math.abs(py - (fr.y + fr.h * cmp.split)) < HANDLE + 2;
      if (onDivider) {
        view.style.cursor = cmp.mode === 'vsplit' ? 'ew-resize' : 'ns-resize';
        return;
      }
    }
    if (rr && px >= rr.x && px <= rr.x + rr.w && py >= rr.y && py <= rr.y + rr.h) {
      view.style.cursor = cmp.kind === 'frame' ? 'ew-resize' : 'default';
      view.title = cmp.kind === 'frame' ? '참조 프레임: 좌우로 끌어 시간 바꾸기' : '';
      return;
    }
    if (store.ui.tool === 'type') {
      view.style.cursor = 'text';
      return;
    }
    const dg = !playback.playing && directTarget();
    const mg = !dg && !playback.playing && maskSelTarget();
    const dh = dg && directHit(dg, px, py);
    if (dh) {
      view.style.cursor = { pin: 'move', tmove: 'move', tscale: 'nwse-resize', trot: 'grab', tanchor: 'crosshair' }[dh.mode];
      view.title = dh.mode === 'tanchor' ? '변형 기준점: 끌면 그림은 그대로 두고 기준점만 옮깁니다' : dh.mode === 'pin' ? '모서리 고정: 끌어서 모서리 옮기기' : '';
      return;
    }
    const mh = mg && maskSelHit(mg, px, py, e);
    if (mh) {
      view.style.cursor = { vertex: e?.altKey ? 'alias' : 'move', tan: 'move', feather: 'ns-resize', mpath: 'move', addpoint: 'copy', penadd: 'crosshair' }[mh.mode];
      view.title = {
        vertex: '마스크 점: 끌어서 옮기기 · Alt+클릭 곡선/모서리 바꾸기 · Delete 지우기',
        mpath: '마스크: 끌어서 옮기기 · Ctrl+클릭으로 선 위에 점 추가',
        feather: '마스크 페더: 위아래로 끌어 가장자리 부드럽게',
        tan: '곡선 핸들: 끌어서 휘기 (Alt: 한쪽만)',
      }[mh.mode] || '';
      return;
    }
    const g = maskTarget();
    if (g) {
      const hit = maskHit(g, px, py);
      if (hit) {
        view.style.cursor = hit.mode === 'mrot' ? 'grab' : hit.mode === 'mmove' || hit.mode === 'point' ? (e?.altKey && hit.mode === 'point' ? 'not-allowed' : 'move') : 'nwse-resize';
        return;
      }
      if (g.polygon && (e?.ctrlKey || e?.metaKey)) {
        view.style.cursor = 'copy';
        return;
      }
    }
    const c = activeClip();
    const pts = c && !playback.playing ? quadFor(c)?.map(seqToScreen) : null;
    let cur = 'default';
    if (pathKeyAt(c, px, py)) {
      view.style.cursor = 'pointer';
      view.title = '키프레임 위치: 끌어서 옮기기 · 눌러서 그 시간으로 이동';
      return;
    }
    view.title = '';
    const handle = selHandleAt(px, py);
    if (handle) cur = handle === 'rotate' ? 'grab' : 'nwse-resize';
    else {
      const gd = guideAt(px, py);
      if (gd) {
        hoverGuide = gd.id;
        cur = gd.dir === 'h' ? 'row-resize' : 'col-resize';
        view.title = '안내선: 끌어서 옮기기 · 눈금자로 끌어 놓으면 삭제 · 두 번 클릭하면 위치 입력';
      }
    }
    if (cur === 'default' && !playback.playing && (clipAtPoint(px, py) || (pts && pointInQuad(px, py, pts)))) cur = 'move';
    view.style.cursor = cur;
    if (prevHover !== hoverGuide) drawOverlay();
  }

  // drop media onto the program monitor = overwrite at playhead on the first free video track;
  // a title template (기본 그래픽 ▸ 찾아보기) goes in at the playhead
  view.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (types.includes('application/x-montage-media') || types.includes('application/x-montage-template')) e.preventDefault();
  });
  view.addEventListener('drop', (e) => {
    const tpl = e.dataTransfer.getData('application/x-montage-template') || dnd.payload?.template;
    if (tpl) {
      e.preventDefault();
      dnd.payload = null;
      insertTemplate(tpl, store.ui.playhead);
      return;
    }
    const items = dnd.payload?.items;
    if (!items?.length) return;
    e.preventDefault();
    for (const it of items) edit.placeMedia(it.mediaId, { mode: 'overwrite', video: it.video, audio: it.audio, inPoint: it.inPoint, outPoint: it.outPoint });
    dnd.payload = null;
  });

  // ---- mini scrubber: a thin time bar over a zoom bar whose round ends set the part shown (Premiere's
  // zoom handles; double-click the zoom bar to see everything again)
  const sv = { a: 0, b: 1 };
  // phones keep the plain bar: the whole sequence, easy to scrub with a finger
  const zoomBar = () => (document.body.classList.contains('mobile') ? 0 : 8);
  function drawScrub() {
    const { ctx, w, h: hh } = fitCanvasToBox(scrub, { cached: true });
    const s = store.seq;
    const d = Math.max(1, sequenceDuration(s));
    // keep the playhead in a zoomed view while playing or stepping
    const ph = store.ui.playhead / d;
    const span = sv.b - sv.a;
    const moved = store.ui.playhead !== sv.lastPh;
    sv.lastPh = store.ui.playhead;
    if (span < 1 && moved && (ph < sv.a || ph > sv.b)) {
      sv.a = clamp(ph - span / 2, 0, 1 - span);
      sv.b = sv.a + span;
    }
    const X = (t) => ((t / d - sv.a) / (sv.b - sv.a)) * w;
    const ZOOM_BAR = zoomBar();
    if (!ZOOM_BAR) {
      sv.a = 0;
      sv.b = 1;
    }
    const top = hh - ZOOM_BAR;
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, top - 3, w, 1);
    // frame ticks: about one every 50 px
    const step = niceStep(((sv.b - sv.a) * d * 50) / Math.max(1, w));
    ctx.fillStyle = '#4a4a4a';
    for (let t = Math.ceil((sv.a * d) / step) * step; t <= sv.b * d; t += step) ctx.fillRect(Math.round(X(t)), top - 7, 1, 4);
    if (s.inPoint != null || s.outPoint != null) {
      const ia = X(s.inPoint ?? 0);
      const ib = X(s.outPoint ?? d);
      ctx.fillStyle = 'rgba(90,150,240,0.45)';
      ctx.fillRect(ia, top - 9, ib - ia, 6);
    }
    for (const mk of s.markers) {
      ctx.fillStyle = mk.color;
      ctx.fillRect(X(mk.time) - 1, 1, 3, 6);
    }
    if (cmp.on && cmp.kind === 'frame' && cmp.refT != null) {
      // the reference frame's position
      ctx.fillStyle = '#ffd666';
      ctx.fillRect(Math.min(w - 2, X(cmp.refT)) - 1, top - 8, 3, 6);
    }
    // the zoom bar and its handles
    const za = sv.a * w;
    const zb = sv.b * w;
    const zy = top + ZOOM_BAR / 2;
    if (ZOOM_BAR) {
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(0, zy - 1, w, 2);
      ctx.fillStyle = '#5a5a5a';
      ctx.fillRect(za, zy - 2, Math.max(2, zb - za), 4);
      ctx.fillStyle = '#9a9a9a';
    }
    for (const hx of ZOOM_BAR ? [Math.max(4, za), Math.min(w - 4, zb)] : []) {
      ctx.beginPath();
      ctx.arc(hx, zy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // the playhead: a blue line with a small head
    const px = clamp(X(store.ui.playhead), 1, w - 1);
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(Math.round(px) - 1, 0, 2, top - 2);
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px + 4, 4);
    ctx.lineTo(px, 8);
    ctx.lineTo(px - 4, 4);
    ctx.closePath();
    ctx.fill();
  }
  function niceStep(raw) {
    const fr = 1 / Math.max(1, store.seq.fps);
    for (const v of [fr, 2 * fr, 5 * fr, 10 * fr, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]) if (v >= raw) return v;
    return 3600;
  }
  scrubBar.addEventListener('pointerdown', (e) => {
    scrubBar.setPointerCapture(e.pointerId);
    const r = scrubBar.getBoundingClientRect();
    const fx = (ev) => clamp((ev.clientX - r.left) / r.width, 0, 1);
    let go;
    if (zoomBar() && e.clientY - r.top >= r.height - zoomBar() - 3) {
      // zoom bar: drag a round end to zoom, the middle to move the view
      const f0 = fx(e);
      const tol = 7 / r.width;
      const a0 = sv.a;
      const b0 = sv.b;
      const min = Math.min(1, 1 / Math.max(1, sequenceDuration(store.seq) * store.seq.fps) * 8);
      const mode = Math.abs(f0 - a0) <= tol ? 'a' : Math.abs(f0 - b0) <= tol ? 'b' : f0 > a0 && f0 < b0 ? 'pan' : 'jump';
      go = (ev) => {
        const f = fx(ev);
        if (mode === 'a') sv.a = clamp(f, 0, sv.b - min);
        else if (mode === 'b') sv.b = clamp(f, sv.a + min, 1);
        else {
          const span = b0 - a0;
          const c = mode === 'pan' ? a0 + (f - f0) : f - span / 2;
          sv.a = clamp(c, 0, 1 - span);
          sv.b = sv.a + span;
        }
        drawScrub();
      };
    } else {
      playback.stop();
      go = (ev) => {
        const d = Math.max(1, sequenceDuration(store.seq));
        store.setPlayhead((sv.a + fx(ev) * (sv.b - sv.a)) * d);
        playback.scrubAudio();
      };
    }
    go(e);
    const up = () => {
      scrubBar.removeEventListener('pointermove', go);
      scrubBar.removeEventListener('pointerup', up);
      scrubBar.removeEventListener('pointercancel', up);
    };
    scrubBar.addEventListener('pointermove', go);
    scrubBar.addEventListener('pointerup', up);
    scrubBar.addEventListener('pointercancel', up);
  });
  scrubBar.addEventListener('dblclick', (e) => {
    const r = scrubBar.getBoundingClientRect();
    if (!zoomBar() || e.clientY - r.top < r.height - zoomBar() - 3) return;
    sv.a = 0;
    sv.b = 1;
    drawScrub();
  });

  tcEl.addEventListener('click', () => {
    inlineEdit(tcEl, {
      onCommit: (v) => {
        const t = parseTimecode(v, store.seq.fps);
        if (t != null) store.setPlayhead(t);
      },
    });
  });
  refTc.addEventListener('click', () => {
    inlineEdit(refTc, {
      onCommit: (v) => {
        const t = parseTimecode(v, store.seq.fps);
        if (t != null) setRefT(t);
      },
    });
  });

  let playState = null;
  function refresh() {
    const s = store.seq;
    tcEl.textContent = formatTimecode(store.ui.playhead, s.fps);
    mTc.textContent = tcEl.textContent;
    const io = s.inPoint != null || s.outPoint != null;
    const d = io ? (s.outPoint ?? sequenceDuration(s)) - (s.inPoint ?? 0) : sequenceDuration(s);
    durEl.textContent = formatTimecode(Math.max(0, d), s.fps);
    durEl.title = io ? '시작~끝 표시 구간 길이' : '시퀀스 전체 길이';
    if (playState !== playback.playing) {
      playState = playback.playing;
      playBtn.replaceChildren(icon(playback.playing ? 'stop' : 'play'));
    }
    const toggle = (b, on) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    };
    toggle(loopBtn, playback.loop);
    toggle(keyBtn, store.ui.autoKey);
    recBadge.hidden = !store.ui.autoKey;
    toggle(safeBtn, safe);
    toggle(compareBtn, cmp.on);
    if (cmp.on && cmp.refT != null) refTc.textContent = formatTimecode(cmp.refT, s.fps);
    drawScrub();
  }

  // keyboard: monitor-only shortcuts while the Program monitor has focus (before the global ones)
  window.addEventListener('keydown', (e) => {
    if (store.ui.focusPanel !== 'program' || document.body.classList.contains('photo-mode')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)) return;
    if (document.querySelector('.modal-backdrop') || menusOpen()) return;
    let run = null;
    if ((e.key === 'Delete' || e.key === 'Backspace') && maskVertex >= 0) {
      const g = maskSelTarget();
      if (g?.path[maskVertex]) {
        const i = maskVertex;
        run = () => {
          if (g.path.length <= 3) return toast('마스크에는 점이 3개 이상 있어야 합니다');
          editMask(g.c.id, g.fx.id, g.mask.id, '마스크 점 삭제', (m) => setMaskPath(m, evalMaskPath(m.params.path, g.tl).filter((_, k) => k !== i), g.tl, fdSec()));
          maskVertex = -1;
        };
      }
    }
    if (!run && penOpen && (e.key === 'Enter' || e.key === 'Escape')) {
      run = () => {
        penOpen = null;
        playback.requestRender();
      };
    }
    // 눈금자 표시 has no shortcut (Ctrl+R is 클립 ▸ 속도/지속 시간, as in Premiere)
    if (!run && modKey(e) && e.code === 'Semicolon') run = e.shiftKey ? () => { setOpt('snap', !opts.snap); toast(`프로그램 모니터에서 스냅 ${opts.snap ? '켬' : '끔'}`); } : () => setOpt('guides', !opts.guides);
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  }, true);

  playback.addRenderer(draw);
  playback.on('state', refresh);
  store.on('selection', () => playback.requestRender());
  store.on('autokey', () => {
    refresh();
    playback.requestRender();
  });
  store.on('change', invalidateRef);
  store.on('sequence', () => {
    cmp.refT = null;
    refFull = null;
    refKey = '';
    if (cmp.on) setCompare(true);
  });
  store.on('mask-target', () => {
    maskVertex = -1;
    maskFocus = !!store.ui.maskSel;
    playback.requestRender();
  });
  store.on('tool', () => { view.classList.toggle('type-tool', store.ui.tool === 'type'); });
  new ResizeObserver(() => layout()).observe(view);

  Object.assign(programApi, {
    canvas: frame, saveFrame, layout, settingsMenu, setZoom, setCompare,
    toggleMulticamView: () => setMulticamView(!mcView), multicamView: () => mcView,
    toggleOpt: (k) => setOpt(k, !opts[k]),
    addGuide, clearGuides, guideDialog,
    viewState: () => ({ zoom, pan: { ...pan }, resolution, pauseRes, safe, ...opts, compare: { ...cmp }, fr: { ...fr }, rr: rr && { ...rr } }),
  });
  return root;
}

// 보기 menu: the Program monitor's display options (also reachable from phones' menu sheet)
extendMenu('보기', (items) => [
  ...items,
  '-',
  { group: '프로그램 모니터' },
  ...(programApi.settingsMenu ? programApi.settingsMenu({ viewMenu: true }) : []),
]);

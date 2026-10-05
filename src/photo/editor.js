// Photo editor ("사진 편집"): a Photoshop-style raster editor living next to the video editor.
// Owns the open documents, the canvas view (zoom/pan, overlay), tools, menus and shortcuts.

import { h, clamp, downloadBlob, modKey } from '../util.js';
import { toast, promptDialog, confirmDialog, showMenu, closeMenus, menusOpen, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { mobileApi } from '../ui/mobile.js';
import { PhotoDoc, newLayer, makeCanvas, cloneCanvas, textBox, boxCorners, unionRect } from './doc.js';
import { History } from './history.js';
import * as SEL from './selection.js';
import { TOOL_BY_ID } from './tools.js';
import { ADJUSTMENTS, FILTERS } from './adjust.js';
import './fx2.js';
import * as IO from './io.js';
import * as D from './pdialogs.js';
import { installLayerCommands, layerMenuItems } from './layercmds.js';
import { newText } from './type.js';
import { nearestOnPath } from './paths.js';
import { installPathTools } from './pathtools.js';
import { installSelectionTools, buildChannelsPanel } from './seltools.js';
import { installBrushTools } from './brushes.js';
import { installPaint2 } from './paint2.js';
import { installActions, buildActionsPanel } from './actions.js';
import { installEdit2 } from './edit2.js';
import { installExtra3, buildCompsPanel } from './extra3.js';
import { installViewExtras, buildNavigatorPanel, buildInfoPanel, buildHistogramPanel } from './view2.js';
import { installPhotoAI, buildAiPanel } from './photoai.js';
import { mixIntoMask } from './selectx.js';
import { buildPathsPanel, buildCharacterPanel, installTypeCommands, warpTextDialog } from './panels2.js';
import * as PT from './paths.js';
import { Transformer, TRANSFORM_MODES, WARP_STYLES, applyM, composeM, unprojectQuad } from './transform.js';
import { FX_NAMES } from './styles.js';
import { buildToolbar, buildToolStrip, buildOptionsBar, buildLayersPanel, buildColorPanel, buildPropertiesPanel, buildHistoryPanel } from './panels.js';

const isMobile = () => document.body.classList.contains('mobile');
const ZOOMS = [0.02, 0.05, 0.1, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];

/** The photo editor API shared by tools, panels, dialogs and menus. */
export const P = {
  docs: [],
  index: -1,
  fg: loadPref('photo.fg', '#000000'),
  bg: loadPref('photo.bg', '#ffffff'),
  recent: loadPref('photo.recent', []),
  tool: loadPref('photo.tool', 'brush'),
  editMask: false,
  float: null,
  transform: null,
  clipboard: null,
  lastPoint: { x: 0, y: 0 },
  cloneSourceNext: false,
  listeners: new Map(),
  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev).add(fn);
  },
  emit(ev, arg) {
    for (const fn of this.listeners.get(ev) || []) fn(arg);
  },
  get doc() {
    return this.docs[this.index] || null;
  },
  get view() {
    return this.doc?.view || { zoom: 1, x: 0, y: 0 };
  },
};

const toolOpts = loadPref('photo.opts', {});

export function createPhotoEditor(root) {
  // ---------------------------------------------------------------- state helpers

  P.opts = (id) => {
    const t = TOOL_BY_ID[id];
    // tools in one family (the type tools) share their settings
    const key = t.optionsFrom || id;
    const o = toolOpts[key] || (toolOpts[key] = {});
    for (const [key, , , , , def] of t.options) if (!(key in o)) o[key] = def;
    return o;
  };
  P.setOpt = (id, key, v) => {
    P.opts(TOOL_BY_ID[id]?.optionsFrom || id)[key] = v;
    savePref('photo.opts', toolOpts);
    P.emit('opts');
    P.overlay();
  };
  P.setTool = (id) => {
    if (!TOOL_BY_ID[id]) return;
    if (P.transform) P.applyTransform();
    finishText();
    TOOL_BY_ID[P.tool]?.deactivate?.(P);
    P.tool = id;
    savePref('photo.tool', id);
    if (P.doc) TOOL_BY_ID[id].activate?.(P);
    P.emit('tool', id);
    updateCursor();
    P.overlay();
  };
  P.setColor = (hex, toBg = false, transient = false) => {
    if (toBg) P.bg = hex;
    else P.fg = hex;
    if (!transient) {
      P.recent = [hex, ...P.recent.filter((c) => c !== hex)].slice(0, 12);
      savePref('photo.recent', P.recent);
      savePref('photo.fg', P.fg);
      savePref('photo.bg', P.bg);
    }
    P.emit('color');
  };
  P.swapColors = () => {
    [P.fg, P.bg] = [P.bg, P.fg];
    savePref('photo.fg', P.fg);
    savePref('photo.bg', P.bg);
    P.emit('color');
  };
  P.defaultColors = () => {
    P.fg = '#000000';
    P.bg = '#ffffff';
    P.emit('color');
  };
  P.toast = toast;
  // selection bounds, remembered per selection canvas (selections are replaced, never changed)
  const boundsCache = new WeakMap();
  P.selBounds = (c) => {
    if (!boundsCache.has(c)) boundsCache.set(c, SEL.alphaBounds(c));
    return boundsCache.get(c);
  };
  P.newText = (o, color, extra) => newText(o, color, extra);
  P.nearestOnPath = (sps, x, y) => nearestOnPath(sps, x, y);
  P.exportDialog = () => (P.doc ? D.exportDialog(P) : toast('내보낼 문서가 없습니다. 먼저 사진을 열거나 새 문서를 만드세요.'));

  // ---------------------------------------------------------------- DOM
  const view = h('canvas.ph-view');
  const over = h('canvas.ph-over');
  const welcome = h('div.ph-welcome',
    h('h2', '사진 편집'),
    h('p', '사진을 열거나 새 문서를 만들어 시작하세요. 레이어, 선택, 브러시, 조정, 필터, 글자, PSD 열기/저장을 쓸 수 있습니다.'),
    h('div.inline',
      h('button.primary', { onclick: () => D.newDocDialog(P) }, '새 문서…'),
      h('button', { onclick: () => P.cmd.open() }, '파일 열기… (사진·PSD)'),
      h('button', { onclick: () => P.cmd.openFromVideo() }, '영상 프로젝트의 이미지 열기')),
    h('p.note', '파일을 여기로 끌어 놓아도 열립니다.'));
  const stage = h('div.ph-stage', view, over, welcome);
  const tabs = h('div.ph-tabs');
  const status = h('div.ph-status');
  const toolbar = buildToolbar(P);
  const strip = buildToolStrip(P);
  const opts = buildOptionsBar(P);
  const panels = {
    color: { title: '색상', el: buildColorPanel(P) },
    props: { title: '속성', el: buildPropertiesPanel(P) },
    layers: { title: '레이어', el: buildLayersPanel(P) },
    history: { title: '작업 내역', el: buildHistoryPanel(P) },
    char: { title: '문자', el: buildCharacterPanel(P) },
    paths: { title: '패스', el: buildPathsPanel(P) },
    channels: { title: '채널', el: buildChannelsPanel(P) },
    nav: { title: '내비게이터', el: buildNavigatorPanel(P, stage) },
    info: { title: '정보', el: buildInfoPanel(P) },
    histo: { title: '히스토그램', el: buildHistogramPanel(P) },
    actions: { title: '액션', el: buildActionsPanel(P) },
    comps: { title: '레이어 구성요소', el: buildCompsPanel(P) },
    ai: { title: 'AI', el: buildAiPanel(P) },
  };
  const sideTabs = (ids) => {
    let cur = loadPref(`photo.side.${ids[0]}`, ids[0]);
    const bar = h('div.ph-ptabs');
    const body = h('div.ph-pbody');
    const show = (id) => {
      cur = id;
      savePref(`photo.side.${ids[0]}`, id);
      bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
      body.replaceChildren(panels[id].el);
    };
    for (const id of ids) {
      const b = h('button', { onclick: () => show(id) }, panels[id].title);
      b.dataset.id = id;
      bar.append(b);
    }
    show(ids.includes(cur) ? cur : ids[0]);
    return { el: h('div.ph-pgroup', bar, body), show, ids };
  };
  const groupsTop = sideTabs(['color', 'props', 'ai', 'char', 'history', 'nav', 'info', 'histo']);
  const groupLayers = sideTabs(['layers', 'channels', 'paths', 'actions', 'comps']);
  const side = h('div.ph-side', groupsTop.el, groupLayers.el);
  // phone: a sheet that shows one panel at a time
  const sheetBody = h('div.ph-sheet-body');
  const sheetTitle = h('b');
  const sheet = h('div.ph-sheet', h('div.ph-sheet-head', sheetTitle, h('button.m-icon', { 'aria-label': '닫기', onclick: () => closeSheet() }, icon('close', 20))), sheetBody);
  const mnav = h('div.ph-mnav',
    ...[['layers', '레이어', 'grid'], ['props', '속성', 'sliders'], ['color', '색', 'filter'], ['adjust', '조정', 'sparkle'], ['filter', '필터', 'wand'], ['ai', 'AI', 'ai'], ['history', '내역', 'undo'], ['more', '더보기', 'more']].map(([id, label, ic]) => h('button.m-tool', { onclick: () => mobileAction(id) }, icon(ic, 20), h('span', label))));
  const center = h('div.ph-center', tabs, stage);
  const bodyEl = h('div.ph-body', toolbar, center, side);
  const textBox2 = h('div.ph-textedit', { hidden: true });
  root.append(h('div.ph', opts, bodyEl, strip, status, mnav, sheet, textBox2));

  P.showPanel = (id, colorTarget) => {
    if (colorTarget) P.emit('colortarget', colorTarget);
    if (isMobile()) {
      openSheet(id);
      return;
    }
    if (groupsTop.ids.includes(id)) groupsTop.show(id);
    if (groupLayers.ids.includes(id)) groupLayers.show(id);
  };

  function openSheet(id) {
    sheet.classList.add('open');
    sheetTitle.textContent = panels[id].title;
    sheetBody.replaceChildren(panels[id].el);
    P.emit('layers');
  }
  function closeSheet() {
    sheet.classList.remove('open');
    // panels go back to the side column
    groupsTop.show(groupsTop.ids.find((i) => panels[i].el.isConnected) || groupsTop.ids[0]);
    groupLayers.show(groupLayers.ids.find((i) => panels[i].el.isConnected) || 'layers');
  }
  function mobileAction(id) {
    if (panels[id]) return openSheet(id);
    closeSheet();
    const menus = P.menus;
    const list = (title, items) => (mobileApi.listSheet ? mobileApi.listSheet(title, items) : showMenu(items, 8, 60));
    if (id === 'adjust') return list('조정', [...menus['이미지']().find((x) => x.label?.startsWith('조정')).submenu(), '-', { group: '조정 레이어 (원본을 바꾸지 않음)' }, ...menus['레이어']().find((x) => x.label === '새 조정 레이어').submenu()]);
    if (id === 'filter') return list('필터', menus['필터']());
    return list('더보기', [
      { label: '새 문서…', action: () => D.newDocDialog(P) },
      { label: '열기…', action: () => P.cmd.open() },
      { label: '내보내기 (PNG·JPG)…', action: () => D.exportDialog(P) },
      { label: 'PSD로 저장', action: () => P.cmd.savePsd() },
      { label: '영상 편집으로 보내기…', action: () => D.sendToVideoDialog(P) },
      '-',
      { label: '문자 · 단락 패널', action: () => openSheet('char') },
      { label: '패스 패널', action: () => openSheet('paths') },
      '-',
      { label: '자유 변형', action: () => P.cmd.freeTransform() },
      { label: '모두 선택', action: () => P.cmd.selectAll() },
      { label: '선택 해제', action: () => P.cmd.deselect() },
      { label: '화면에 맞추기', action: () => P.fit() },
      '-',
      { label: '전체 메뉴…', action: () => list('메뉴', Object.keys(menus).map((name) => ({ label: name, submenu: () => menus[name]() }))) },
    ]);
  }

  // ---------------------------------------------------------------- documents

  P.openDoc = (doc) => {
    doc.history = new History(doc, { budgetBytes: isMobile() ? 350e6 : 900e6 });
    doc.view = { zoom: 1, x: 0, y: 0 };
    P.docs.push(doc);
    P.index = P.docs.length - 1;
    P.editMask = false;
    docChanged();
    requestAnimationFrame(() => P.fit());
    if (doc.importNote) toast(doc.importNote);
    return doc;
  };
  P.newDoc = (o) => P.openDoc(new PhotoDoc(o));
  P.switchDoc = (i) => {
    if (P.transform) P.applyTransform();
    finishText();
    P.index = clamp(i, 0, P.docs.length - 1);
    P.editMask = false;
    docChanged();
  };
  P.closeDoc = async (i = P.index) => {
    const d = P.docs[i];
    if (!d) return;
    if (!d.saved && !(await confirmDialog('문서 닫기', `"${d.name}"을(를) 닫을까요? 저장하지 않은 변경은 자동 저장본에서도 지워집니다.`))) return;
    P.docs.splice(i, 1);
    P.index = Math.min(P.index, P.docs.length - 1);
    docChanged();
    scheduleSave();
  };
  /** Open a canvas as a new document (from the video editor, a frame grab, the clipboard…). */
  P.openCanvas = (canvas, name, sourceMediaId = null) => {
    const doc = IO.docFromCanvas(canvas, name);
    doc.sourceMediaId = sourceMediaId;
    return P.openDoc(doc);
  };
  P.openFiles = async (files) => {
    for (const f of files) {
      try {
        P.openDoc(await IO.openFile(f));
      } catch (err) {
        console.error(err);
        toast(`${f.name}: 열 수 없습니다 (${err.message || err})`);
      }
    }
  };

  function docChanged() {
    const doc = P.doc;
    welcome.hidden = !!doc;
    renderTabs();
    if (doc) TOOL_BY_ID[P.tool].activate?.(P);
    P.emit('doc');
    P.emit('history');
    P.emit('layers');
    P.redraw();
  }

  P.renderTabs = () => renderTabs();
  function renderTabs() {
    tabs.replaceChildren(...P.docs.map((d, i) => h(`div.ph-tab${i === P.index ? '.on' : ''}`, { onclick: () => P.switchDoc(i), title: `${d.name} (${d.width}×${d.height})` },
      h('span', `${d.name}${d.saved ? '' : ' •'}`),
      h('button.ph-tabx', { 'aria-label': '닫기', onclick: (e) => { e.stopPropagation(); P.closeDoc(i); } }, '×'))),
    h('button.ph-tabadd', { onclick: () => D.newDocDialog(P), title: '새 문서', 'aria-label': '새 문서' }, '+'));
  }

  // ---------------------------------------------------------------- history

  P.commit = (label, before) => {
    const doc = P.doc;
    if (!doc) return;
    doc.history.push(label, before);
    doc.saved = false;
    P.afterHistory();
  };
  P.run = (label, fn) => {
    const doc = P.doc;
    if (!doc) return undefined;
    const before = doc.capture();
    const r = fn();
    P.commit(label, before);
    return r;
  };
  P.afterHistory = () => {
    if (P.doc && !P.doc.layer(P.doc.activeId)) P.doc.activeId = P.doc.layers[P.doc.layers.length - 1]?.id || null;
    if (!P.doc?.active?.mask) P.editMask = false;
    renderTabs();
    P.emit('history');
    P.emit('layers');
    P.redraw();
    scheduleSave();
  };
  P.undo = () => {
    if (P.transform) return P.cancelTransform();
    if (finishText()) return undefined;
    const l = P.doc?.history.undo();
    if (l) toast(`실행 취소: ${l}`);
    P.afterHistory();
    return undefined;
  };
  P.redo = () => {
    const l = P.doc?.history.redo();
    if (l) toast(`다시 실행: ${l}`);
    P.afterHistory();
  };

  // ---------------------------------------------------------------- rendering

  const comp = makeCanvas(1, 1);
  let compRev = -1;
  let compDoc = null;
  let compFloat = null;
  let compMask = null;
  let compVersion = 0;
  // smaller copies of the composite (1/2, 1/4, …) for drawing it small: the view when zoomed out, the
  // navigator, the histogram. Kept up to date area by area while painting.
  const mips = [];
  let mipDirty = 'all';
  let frame = 0;
  // the picture as last drawn at screen size: reused while neither the picture nor the view changes
  const viewCache = makeCanvas(1, 1);
  viewCache.key = '';
  let vidCounter = 0;
  let checker = null;
  P.composite = () => {
    const doc = P.doc;
    if (comp.width !== doc.width || comp.height !== doc.height) {
      comp.width = doc.width;
      comp.height = doc.height;
      compRev = -1;
    }
    // a view-only float (a live preview on the top layer) is drawn over the view in draw(), not here
    const fl = P.float?.viewOnly ? null : P.float;
    if (compRev !== doc.rev || compDoc !== doc || compFloat !== fl || compMask !== P.showMaskOnly) {
      // only part of the picture changed (a brush stroke): redo just that rectangle
      const dirty = compDoc === doc && compFloat === fl && compMask === P.showMaskOnly && !P.showMaskOnly ? doc.takeDirty(compRev) : doc.takeDirty(NaN);
      const clip = dirty && clipRect(dirty, doc.width, doc.height);
      compMask = P.showMaskOnly;
      compDoc = doc;
      if (clip && clip.w * clip.h < doc.width * doc.height * 0.6) {
        doc.render(comp.getContext('2d'), { float: fl, fg: P.fg, bg: P.bg, clip });
        if (mipDirty !== 'all') mipDirty = mipDirty ? unionRect(mipDirty, clip) : clip;
      } else {
        doc.render(comp.getContext('2d'), { float: fl, fg: P.fg, bg: P.bg });
        mipDirty = 'all';
      }
      // Alt+click on a mask thumbnail: look at the mask itself
      const ml = P.showMaskOnly && doc.layer(P.showMaskOnly);
      if (ml?.mask) {
        const g = comp.getContext('2d');
        g.save();
        g.fillStyle = '#000';
        g.fillRect(0, 0, comp.width, comp.height);
        const t = makeCanvas(comp.width, comp.height);
        const tg = t.getContext('2d');
        tg.drawImage(ml.mask.canvas, ml.mask.x, ml.mask.y);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = '#fff';
        tg.fillRect(0, 0, t.width, t.height);
        g.drawImage(t, 0, 0);
        g.restore();
      }
      compRev = doc.rev;
      compFloat = fl;
      compVersion++;
    }
    return comp;
  };

  /**
   * The composite or a smaller copy of it that still has at least `scale` (0..1] of its resolution.
   * Drawn whole over the document area it looks the same, at a fraction of the cost.
   */
  P.viewSource = (scale) => {
    const src = P.composite();
    if (mipDirty === 'all') {
      mips.length = 0;
      mipDirty = null;
    }
    if (mipDirty) {
      for (let k = 0; k < mips.length; k++) updateMip(k, mipDirty);
      mipDirty = null;
    }
    if (!(scale < 0.5) || Math.max(src.width, src.height) <= 1024) return src;
    let k = 0;
    while (k < 8 && 2 ** -(k + 2) >= scale && Math.max(src.width, src.height) * 2 ** -(k + 2) >= 64) k++;
    for (let i = mips.length; i <= k; i++) {
      const prev = i ? mips[i - 1] : src;
      const c = makeCanvas(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
      // halving with plain bilinear filtering averages each 2×2 block: as good as the slow filter
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'low';
      g.drawImage(prev, 0, 0, c.width, c.height);
      mips.push(c);
    }
    return mips[k];
  };
  // redo one level of the pyramid inside a rectangle (doc coords) from the level above it
  function updateMip(k, r) {
    const prev = k ? mips[k - 1] : comp;
    const c = mips[k];
    const kx = c.width / comp.width;
    const ky = c.height / comp.height;
    const x0 = Math.max(0, Math.floor(r.x * kx) - 1);
    const y0 = Math.max(0, Math.floor(r.y * ky) - 1);
    const x1 = Math.min(c.width, Math.ceil((r.x + r.w) * kx) + 1);
    const y1 = Math.min(c.height, Math.ceil((r.y + r.h) * ky) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    const g = c.getContext('2d');
    g.save();
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.clip();
    g.clearRect(x0, y0, x1 - x0, y1 - y0);
    g.imageSmoothingQuality = 'low';
    // a margin around the piece keeps the filter from seeing its edge; the clip keeps it in place
    const fx = prev.width / c.width;
    const fy = prev.height / c.height;
    const sx0 = Math.max(0, x0 - 2);
    const sy0 = Math.max(0, y0 - 2);
    const sx1 = Math.min(c.width, x1 + 2);
    const sy1 = Math.min(c.height, y1 + 2);
    g.drawImage(prev, sx0 * fx, sy0 * fy, (sx1 - sx0) * fx, (sy1 - sy0) * fy, sx0, sy0, sx1 - sx0, sy1 - sy0);
    g.restore();
  }
  P.redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  P.overlay = () => P.redraw();
  P.viewChanged = () => {
    if (P.doc?.selection) P.doc.selection._ants = null;
    P.redraw();
    status.dataset.zoom = '1';
    updateStatus();
  };

  function sizeCanvases() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [view, over]) {
      const w = Math.max(1, Math.round(r.width * dpr));
      const hh = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== hh) {
        c.width = w;
        c.height = hh;
      }
    }
    return dpr;
  }

  function draw() {
    frame = 0;
    const dpr = sizeCanvases();
    const g = view.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1f2125';
    g.fillRect(0, 0, view.width, view.height);
    const doc = P.doc;
    const og = over.getContext('2d');
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, over.width, over.height);
    if (!doc) return;
    const v = doc.view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x, y] = [v.x, v.y];
    const w = doc.width * v.zoom;
    const hh = doc.height * v.zoom;
    // transparency checkerboard
    const full = P.composite();
    const shown = P.displayCanvas ? P.displayCanvas(full) : full;
    // zoomed out, a smaller copy of the picture looks the same and draws much faster
    const src = shown === full ? P.viewSource(v.zoom * dpr) : shown;
    if (!src._vid) src._vid = ++vidCounter;
    const vkey = `${src._vid}|${compVersion}|${v.zoom}|${v.x}|${v.y}|${dpr}|${view.width}x${view.height}`;
    if (viewCache.key !== vkey) {
      // scaling a big picture down to the screen is the costly part of a redraw: do it only when
      // the picture or the view changed (not for marching ants, cursors or overlays)
      if (viewCache.width !== view.width || viewCache.height !== view.height) {
        viewCache.width = view.width;
        viewCache.height = view.height;
      }
      const vg = viewCache.getContext('2d');
      vg.setTransform(1, 0, 0, 1, 0, 0);
      vg.clearRect(0, 0, viewCache.width, viewCache.height);
      vg.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!checker) {
        const c = makeCanvas(16, 16);
        const cg = c.getContext('2d');
        cg.fillStyle = '#ffffff';
        cg.fillRect(0, 0, 16, 16);
        cg.fillStyle = '#cccccc';
        cg.fillRect(0, 0, 8, 8);
        cg.fillRect(8, 8, 8, 8);
        checker = vg.createPattern(c, 'repeat');
      }
      vg.save();
      vg.fillStyle = checker;
      vg.translate(x, y);
      vg.fillRect(0, 0, w, hh);
      vg.restore();
      vg.imageSmoothingEnabled = v.zoom < 2;
      // within 2× of the source size bilinear filtering is enough (and several times faster)
      vg.imageSmoothingQuality = (w * dpr) / src.width >= 0.5 ? 'low' : 'high';
      vg.drawImage(src, x, y, w, hh);
      viewCache.key = vkey;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(viewCache, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // live preview on the top layer: made at screen size and drawn straight over the picture
    if (P.float?.viewOnly) {
      g.imageSmoothingEnabled = true;
      g.drawImage(P.float.canvas, x, y, w, hh);
    }
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.strokeRect(x - 0.5, y - 0.5, w + 1, hh + 1);
    // overlay: selection ants, tool overlay, transform handles, brush cursor
    og.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (doc.selection && !P.float) {
      const ants = SEL.antsImage(doc.selection, { zoom: v.zoom * dpr, x: v.x * dpr, y: v.y * dpr }, over.width, over.height, antsPhase);
      if (ants) {
        og.setTransform(1, 0, 0, 1, 0, 0);
        og.putImageData(ants, 0, 0);
        og.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    TOOL_BY_ID[P.tool].overlay?.(P, og);
    // the current path stays visible (thin) with the other tools
    if (!['pen', 'freePen', 'addAnchor', 'deleteAnchor', 'convertPoint', 'pathSelect', 'directSelect'].includes(P.tool) && P.resolvePathTarget?.()?.kind && P.pathTarget?.kind !== 'shape') P.drawPathOverlay(og, { outlineOnly: true });
    P.transform?.overlay(og);
    if (P.editingText) {
      const l = P.editingText.layer;
      const b = textBox(l);
      const cs = boxCorners(l, b.w, b.h).map(([cx, cy]) => P.toScreen(cx, cy));
      og.strokeStyle = '#4aa3ff';
      og.setLineDash([4, 3]);
      og.beginPath();
      cs.forEach(([cx, cy], i) => (i ? og.lineTo(cx, cy) : og.moveTo(cx, cy)));
      og.closePath();
      og.stroke();
      og.setLineDash([]);
    }
    if (hover && TOOL_BY_ID[P.tool].cursor === 'brush' && !P.transform) {
      const r = (P.opts(P.tool).size * v.zoom) / 2;
      const [cx, cy] = P.toScreen(hover.x, hover.y);
      og.strokeStyle = 'rgba(0,0,0,0.7)';
      og.beginPath();
      og.arc(cx, cy, Math.max(1.5, r), 0, Math.PI * 2);
      og.stroke();
      og.strokeStyle = 'rgba(255,255,255,0.9)';
      og.beginPath();
      og.arc(cx, cy, Math.max(1.5, r - 1), 0, Math.PI * 2);
      og.stroke();
    }
    P.drawViewExtras?.(og);
    updateStatus();
    P.emit('redraw');
  }

  let antsPhase = 0;
  setInterval(() => {
    if (P.doc?.selection && root.isConnected && !root.closest('[hidden]') && document.body.classList.contains('photo-mode')) {
      antsPhase = (antsPhase + 1) % 8;
      P.redraw();
    }
  }, 140);

  P.toScreen = (x, y) => [x * P.view.zoom + P.view.x, y * P.view.zoom + P.view.y];
  P.toDoc = (clientX, clientY) => {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - P.view.x) / P.view.zoom, y: (clientY - r.top - P.view.y) / P.view.zoom };
  };
  P.fit = () => {
    const doc = P.doc;
    if (!doc) return;
    const r = stage.getBoundingClientRect();
    // hidden (video mode): fit when the stage shows up
    if (r.width < 20 || r.height < 20) return;
    const pad = isMobile() ? 16 : 40;
    const z = Math.max(0.01, Math.min(1, (r.width - pad) / doc.width, (r.height - pad) / doc.height));
    // auto: the view follows the window (rotating the phone) until the user zooms or pans
    doc.view = { zoom: z, x: (r.width - doc.width * z) / 2, y: (r.height - doc.height * z) / 2, fitted: true, auto: true };
    P.viewChanged();
  };
  /** Called when the photo editor comes on screen. */
  P.shown = () => {
    if (P.doc && !P.doc.view.fitted) P.fit();
    P.emit('layers');
    P.redraw();
  };
  P.setZoom = (z, cx, cy) => {
    const doc = P.doc;
    if (!doc) return;
    const r = stage.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2;
    const py = cy ?? r.top + r.height / 2;
    const p = P.toDoc(px, py);
    const zoom = clamp(z, 0.01, 64);
    doc.view = { zoom, x: px - r.left - p.x * zoom, y: py - r.top - p.y * zoom, fitted: true };
    P.viewChanged();
  };
  P.zoomAt = (k, cx, cy) => P.setZoom(P.view.zoom * k, cx, cy);
  P.zoomStep = (dir) => {
    const z = P.view.zoom;
    const next = dir > 0 ? ZOOMS.find((x) => x > z * 1.001) : [...ZOOMS].reverse().find((x) => x < z / 1.001);
    P.setZoom(next ?? z);
  };

  function updateStatus() {
    const doc = P.doc;
    if (!doc) {
      status.textContent = '';
      return;
    }
    const t = TOOL_BY_ID[P.tool];
    status.textContent = `${Math.round(doc.view.zoom * 1000) / 10}% · ${doc.width} × ${doc.height} px · ${hover ? `${Math.floor(hover.x)}, ${Math.floor(hover.y)}` : ''} · ${t.name}${doc.selection ? ' · 선택 영역 있음' : ''}${P.editMask ? ' · 마스크 편집 중' : ''}${doc.quickMask ? ' · 빠른 마스크' : ''}${P.chState?.().active ? ' · 알파 채널 편집 중' : ''}`;
  }

  // ---------------------------------------------------------------- helpers for tools

  /** Make a layer active; mode 'add' toggles it in the selection (Ctrl), 'range' extends (Shift). */
  P.selectLayer = (id, mode = 'single') => {
    const doc = P.doc;
    if (!doc?.layer(id)) return;
    if (P.transform) P.applyTransform();
    if (mode === 'add') {
      const set = new Set([...(doc.selectedIds || []), doc.activeId]);
      if (set.has(id) && set.size > 1) {
        set.delete(id);
        doc.selectedIds = [...set];
        if (doc.activeId === id) doc.activeId = doc.selectedIds[doc.selectedIds.length - 1];
        P.emit('layers');
        return;
      }
      set.add(id);
      doc.selectedIds = [...set];
    } else if (mode === 'range') {
      const a = doc.index(doc.activeId);
      const b = doc.index(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const target = doc.layer(id);
      doc.selectedIds = doc.layers.slice(lo, hi + 1).filter((l) => (l.parent || null) === (target.parent || null)).map((l) => l.id);
    } else doc.selectedIds = [id];
    P.doc.activeId = id;
    if (!P.doc.active.mask) P.editMask = false;
    P.emit('layers');
    P.redraw();
  };
  /** Add a layer above the active one (inside it when it is an open group). */
  P.addLayer = (l, { above = undefined } = {}) => {
    const doc = P.doc;
    doc.insertAbove(l, above === undefined ? doc.activeId : above);
    doc.activeId = l.id;
    doc.selectedIds = [l.id];
    P.editMask = false;
    P.emit('layers');
  };
  /** Topmost visible layer with a pixel (or box) at p. */
  P.layerAt = (p, filter = () => true) => {
    const doc = P.doc;
    for (const l of [...doc.layers].reverse()) {
      if (!doc.shown(l) || l.kind === 'adjust' || l.kind === 'group' || !filter(l)) continue;
      if (l.kind === 'text' || l.kind === 'shape') {
        const b = l.kind === 'text' ? textBox(l) : { w: l.shape.w, h: l.shape.h };
        const cs = boxCorners(l, b.w, b.h);
        if (pointIn(p, cs)) return l;
        continue;
      }
      const c = doc.content(l);
      if (!c) continue;
      const x = Math.floor(p.x - c.x);
      const y = Math.floor(p.y - c.y);
      if (x < 0 || y < 0 || x >= c.canvas.width || y >= c.canvas.height) continue;
      if (c.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3] > 8) return l;
    }
    return null;
  };
  /** A layer's pixels placed in a doc-size canvas (for sampling). */
  P.layerAsDocCanvas = (l, canvasOverride = null) => {
    const doc = P.doc;
    const c = makeCanvas(doc.width, doc.height);
    if (!l) return c;
    if (canvasOverride) c.getContext('2d').drawImage(canvasOverride, l.x, l.y);
    else {
      const ct = doc.content(l);
      if (ct) c.getContext('2d').drawImage(ct.canvas, ct.x, ct.y);
    }
    return c;
  };
  P.selAt = (p) => {
    const s = P.doc?.selection;
    if (!s) return 0;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= s.canvas.width || y >= s.canvas.height) return 0;
    return s.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
  };
  P.selAlpha = (x, y, w, hh) => {
    const s = P.doc.selection;
    const c = makeCanvas(w, hh);
    c.getContext('2d').drawImage(s.canvas, -x, -y);
    const d = c.getContext('2d').getImageData(0, 0, w, hh).data;
    const a = new Uint8Array(w * hh);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  };
  P.drawSelOffset = (g, dx, dy) => {
    const s = P.doc.selection;
    if (!s) return;
    const v = P.view;
    const dpr = window.devicePixelRatio || 1;
    const ants = SEL.antsImage({ canvas: s.canvas }, { zoom: v.zoom * dpr, x: (v.x + dx * v.zoom) * dpr, y: (v.y + dy * v.zoom) * dpr }, over.width, over.height, antsPhase);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (ants) g.putImageData(ants, 0, 0);
    g.restore();
  };

  // ---------------------------------------------------------------- text editing

  P.editText = (l, before = null) => {
    finishText();
    const doc = P.doc;
    P.editingText = { layer: l, before: before || doc.capture(), created: !!before };
    const ta = h('textarea', { rows: 3, placeholder: '글자를 입력하세요', 'aria-label': '글자 입력' });
    ta.value = l.text.content;
    ta.addEventListener('input', () => {
      l.text = { ...l.text, content: ta.value };
      l.name = ta.value.split('\n')[0].slice(0, 30) || '텍스트';
      doc.touch(l);
      P.redraw();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        finishText();
      }
    });
    textBox2.replaceChildren(h('div.ph-tehead', h('span', '글자 입력'), h('button.primary.small', { onclick: () => finishText() }, '완료')), ta, h('div.note', 'Ctrl+Enter 또는 Esc로 마칩니다. 글꼴·크기·색은 위 옵션 막대나 속성 패널에서 바꿉니다.'));
    textBox2.hidden = false;
    placeTextBox();
    setTimeout(() => ta.focus(), 0);
    P.redraw();
  };
  function placeTextBox() {
    const t = P.editingText;
    if (!t) return;
    const b = textBox(t.layer);
    const [x, y] = P.toScreen(t.layer.x, t.layer.y + b.h);
    const r = stage.getBoundingClientRect();
    textBox2.style.left = `${clamp(r.left + x, 8, window.innerWidth - 300)}px`;
    textBox2.style.top = `${clamp(r.top + y + 8, 8, window.innerHeight - 180)}px`;
  }
  function finishText() {
    const t = P.editingText;
    if (!t) return false;
    P.editingText = null;
    textBox2.hidden = true;
    const doc = P.doc;
    const l = t.layer;
    if (!l.text.content.trim()) {
      // an empty new text layer is dropped
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      if (t.created) {
        doc.restore(t.before);
        P.afterHistory();
        return true;
      }
    }
    if (l.typeMask && doc.layer(l.id)) {
      // type mask tools: the text becomes a selection
      const c = doc.content(l);
      const m = makeCanvas(doc.width, doc.height);
      if (c) m.getContext('2d').drawImage(c.canvas, c.x, c.y);
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      doc.activeId = doc.layers[doc.layers.length - 1]?.id;
      doc.selection = { canvas: m };
      P.commit('문자 마스크', t.before);
      return true;
    }
    P.commit(t.created ? '텍스트 추가' : '텍스트 고치기', t.before);
    return true;
  }
  P.finishText = finishText;

  // ---------------------------------------------------------------- free transform

  P.cmd = {};
  /** Ctrl+T and Edit ▸ Transform: mode free | skew | distort | perspective | warp; target 'selection' for Select ▸ Transform Selection. */
  P.cmd.freeTransform = (mode = 'free', target = 'auto') => {
    const doc = P.doc;
    if (!doc) return toast('먼저 문서를 여세요');
    if (P.transform) {
      P.transform.setMode(mode);
      P.emit('transform');
      return undefined;
    }
    try {
      finishText();
      P.transform = new Transformer(P, { mode, target });
      P.emit('transform');
    } catch (err) {
      toast(String(err.message || err));
    }
    return undefined;
  };
  P.cmd.transformSelection = () => P.cmd.freeTransform('free', 'selection');
  P.applyTransform = () => {
    const t = P.transform;
    if (!t) return;
    P.transform = null;
    t.apply();
    P.emit('transform');
  };
  P.cancelTransform = () => {
    const t = P.transform;
    if (!t) return;
    P.transform = null;
    t.cancel();
    P.emit('transform');
    P.afterHistory();
  };
  P.transformModes = TRANSFORM_MODES;
  P.warpStyles = WARP_STYLES;
  P.textBox = (l) => textBox(l);
  P.pathBounds = (sps) => PT.pathBounds(sps);
  /** Edit ▸ Transform ▸ Again: repeat the last (affine) transform on the active layer. */
  P.cmd.transformAgain = () => {
    const M = P.lastTransform;
    const doc = P.doc;
    const l = doc?.active;
    if (!M) return toast('다시 할 변형이 없습니다');
    if (!l || l.kind === 'adjust' || l.kind === 'fill') return undefined;
    P.run('다시 변형', () => {
      if (l.kind === 'raster' && l.canvas) {
        const cs = [[l.x, l.y], [l.x + l.canvas.width, l.y], [l.x + l.canvas.width, l.y + l.canvas.height], [l.x, l.y + l.canvas.height]].map((q) => applyM(M, q));
        const xs = cs.map((q) => q[0]);
        const ys = cs.map((q) => q[1]);
        const x0 = Math.floor(Math.min(...xs));
        const y0 = Math.floor(Math.min(...ys));
        const c = makeCanvas(Math.ceil(Math.max(...xs)) - x0 + 1, Math.ceil(Math.max(...ys)) - y0 + 1);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        const m = composeM(M, [1, 0, 0, 1, l.x, l.y]);
        g.setTransform(m[0], m[1], m[2], m[3], m[4] - x0, m[5] - y0);
        g.drawImage(l.canvas, 0, 0);
        l.canvas = c;
        l.x = x0;
        l.y = y0;
      } else if (l.kind === 'smart') {
        l.smart = { ...l.smart, m: composeM(M, l.smart.m), corners: l.smart.corners?.map((q) => applyM(M, q)) || null };
      } else if (l.kind === 'shape') {
        P.setShapePathDoc(l, PT.mapPath(P.shapePathDoc(l), (q) => applyM(M, q)));
      } else if (l.kind === 'text') {
        const L = textBox(l);
        const [cx, cy] = applyM(M, [l.x + L.w / 2, l.y + L.h / 2]);
        const k = Math.hypot(M[0], M[1]);
        l.text = { ...l.text, size: Math.max(1, Math.round(l.text.size * k * 10) / 10) };
        l.rotation = ((l.rotation || 0) + (Math.atan2(M[1], M[0]) * 180) / Math.PI) % 360;
        const L2 = textBox(l);
        l.x = Math.round(cx - L2.w / 2);
        l.y = Math.round(cy - L2.h / 2);
      }
      l._styled = null;
      doc.touch(l);
    });
    return undefined;
  };

  // ---------------------------------------------------------------- pointer input

  let hover = null;
  let active = null; // 'tool' | 'pan' | 'transform' | 'pinch'
  let panStart = null;
  const touches = new Map();
  let spaceDown = false;
  // selection, crop and shape tools snap to guides, the grid and the canvas edges (view2.js)
  const snap = (p) => (P.snapPoint ? P.snapPoint(p, P.tool) : p);

  function updateCursor() {
    const t = TOOL_BY_ID[P.tool];
    stage.style.cursor = spaceDown ? 'grab' : t.cursor === 'brush' ? 'crosshair' : t.cursor || 'default';
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!P.doc || e.button === 2) return;
    closeMenus();
    stage.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // second finger: cancel what the first one started and pinch/pan instead
        if (active === 'tool') TOOL_BY_ID[P.tool].cancel?.(P);
        if (active === 'transform') P.transform?.up();
        const [a, b] = [...touches.values()];
        active = 'pinch';
        panStart = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: P.view.zoom, vx: P.view.x, vy: P.view.y };
        return;
      }
      if (touches.size > 2) return;
    }
    const p = P.toDoc(e.clientX, e.clientY);
    P.lastPoint = p;
    if (!spaceDown && e.button === 0 && !P.transform && P.viewExtrasDown?.(e, p)) {
      active = 'extras';
      return;
    }
    if (e.button === 1 || spaceDown || (P.tool === 'hand' && !P.transform)) {
      active = 'pan';
      panStart = { x: e.clientX, y: e.clientY, vx: P.view.x, vy: P.view.y };
      stage.style.cursor = 'grabbing';
      return;
    }
    if (P.editingText && P.tool !== 'text') finishText();
    if (P.transform) {
      active = 'transform';
      P.transform.down(p, e);
      return;
    }
    if (P.cloneSourceNext && P.tool === 'clone') {
      P.cloneSourceNext = false;
      TOOL_BY_ID.clone.source = p;
      toast('복제 원본을 정했습니다');
      P.overlay();
      return;
    }
    active = 'tool';
    TOOL_BY_ID[P.tool].down?.(P, snap(p), e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!P.doc) return;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = P.toDoc(e.clientX, e.clientY);
    hover = e.pointerType === 'touch' && !active ? null : p;
    P.hoverPoint = hover;
    P.emit('pointer');
    P.lastPoint = p;
    if (active === 'extras') {
      P.viewExtrasMove(e, p);
      return;
    }
    if (active === 'pinch') {
      const [a, b] = [...touches.values()];
      if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = stage.getBoundingClientRect();
      const zoom = clamp((panStart.zoom * d) / Math.max(1, panStart.d), 0.01, 64);
      // keep the point between the fingers under the fingers
      const docX = (panStart.mx - r.left - panStart.vx) / panStart.zoom;
      const docY = (panStart.my - r.top - panStart.vy) / panStart.zoom;
      P.doc.view = { zoom, x: mx - r.left - docX * zoom, y: my - r.top - docY * zoom, fitted: true };
      P.viewChanged();
      return;
    }
    if (active === 'pan') {
      P.doc.view.auto = false;
      P.doc.view.x = panStart.vx + e.clientX - panStart.x;
      P.doc.view.y = panStart.vy + e.clientY - panStart.y;
      P.viewChanged();
      return;
    }
    if (active === 'transform') {
      P.transform.move(p, e);
      return;
    }
    if (active === 'tool') {
      const t = TOOL_BY_ID[P.tool];
      // coalesced events give smoother brush strokes
      const evs = e.getCoalescedEvents?.() || [e];
      for (const ce of evs.length ? evs : [e]) t.move?.(P, snap(P.toDoc(ce.clientX, ce.clientY)), ce);
      P.redraw();
      return;
    }
    TOOL_BY_ID[P.tool].hover?.(P, p, e);
    if (!P.transform && !P.viewExtrasHover?.(e)) updateCursor();
    if (P.transform) {
      const hcur = P.transform.hit(p);
      stage.style.cursor = hcur === 'move' ? 'move' : hcur === 'rotate' ? 'alias' : hcur === 'none' ? 'default' : hcur === 'pivot' ? 'crosshair' : 'nwse-resize';
    }
    P.redraw();
  });
  const endPointer = (e) => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (active === 'pinch') {
        if (touches.size === 0) active = null;
        return;
      }
    }
    if (!active) return;
    const p = P.toDoc(e.clientX, e.clientY);
    if (active === 'tool') TOOL_BY_ID[P.tool].up?.(P, snap(p), e);
    else if (active === 'transform') P.transform?.up();
    else if (active === 'extras') P.viewExtrasUp(e, p);
    P.clearSnapMark?.();
    active = null;
    updateCursor();
    P.redraw();
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', (e) => {
    if (active === 'tool') TOOL_BY_ID[P.tool].cancel?.(P);
    touches.delete(e.pointerId);
    active = null;
  });
  stage.addEventListener('pointerleave', () => {
    hover = null;
    P.redraw();
  });
  stage.addEventListener('dblclick', (e) => {
    if (!P.doc) return;
    if (P.transform) {
      P.applyTransform();
      return;
    }
    TOOL_BY_ID[P.tool].dblclick?.(P, P.toDoc(e.clientX, e.clientY), e);
  });
  stage.addEventListener('wheel', (e) => {
    if (!P.doc) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) P.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.002)), e.clientX, e.clientY);
    else {
      P.doc.view.auto = false;
      P.doc.view.x -= e.shiftKey ? e.deltaY : e.deltaX;
      P.doc.view.y -= e.shiftKey ? 0 : e.deltaY;
      P.viewChanged();
    }
  }, { passive: false });
  stage.addEventListener('contextmenu', (e) => {
    if (!P.doc) return;
    e.preventDefault();
    showMenu(P.contextMenu(), e.clientX, e.clientY);
  });
  // files dropped on the photo editor open as documents (or as layers with Shift)
  root.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  root.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (P.doc && e.shiftKey) P.cmd.placeFiles(files);
    else P.openFiles(files);
  }, true);
  new ResizeObserver(() => {
    if (P.doc && (!P.doc.view.fitted || P.doc.view.auto)) P.fit();
    P.redraw();
    placeTextBox();
  }).observe(stage);

  // ---------------------------------------------------------------- keyboard

  window.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('photo-mode') || menusOpen()) return;
    const tag = e.target?.tagName;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(e.target.type)) || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (document.querySelector('.modal-backdrop')) return;
    const mod = modKey(e);
    const k = e.code;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (P.viewKeys?.(e, mod)) return done();
    if (k === 'Space' && !mod) {
      spaceDown = true;
      updateCursor();
      done();
      return;
    }
    if (P.transform) {
      if (e.key === 'Enter') return done(), P.applyTransform();
      if (e.key === 'Escape') return done(), P.cancelTransform();
    }
    if (!mod && P.doc && TOOL_BY_ID[P.tool].onKey?.(P, e) === true) return done();
    const map = {
      KeyZ: () => (mod ? (e.shiftKey ? P.redo() : P.undo()) : P.setTool('zoom')),
      KeyY: () => (mod ? P.redo() : P.setTool('historyBrush')),
      KeyA: () => (mod && e.altKey ? P.cmd.selectAllLayers() : mod ? P.cmd.selectAll() : cycle(['pathSelect', 'directSelect'], e.shiftKey)),
      KeyP: () => (mod ? null : cycle(['pen', 'freePen'], e.shiftKey)),
      KeyD: () => (mod ? (e.shiftKey ? P.cmd.reselect() : P.cmd.deselect()) : P.defaultColors()),
      KeyI: () => (mod ? (e.shiftKey ? P.cmd.inverse() : D.adjustDialog(P, 'invert')) : cycle(['eyedropper', 'sampler', 'ruler', 'note', 'count'], e.shiftKey)),
      KeyT: () => (mod && e.shiftKey ? P.cmd.transformAgain() : mod ? P.cmd.freeTransform() : cycle(['text', 'verticalText', 'textMask', 'verticalTextMask'], e.shiftKey)),
      KeyJ: () => (mod && e.shiftKey ? P.cmd.layerVia(true) : mod ? P.cmd.duplicateLayer() : cycle(['heal', 'healBrush', 'patch', 'contentMove', 'remove', 'redEye'], e.shiftKey)),
      KeyE: () => (mod && e.shiftKey && e.altKey ? P.cmd.stampVisible() : mod ? (e.shiftKey ? P.cmd.mergeVisible() : P.cmd.mergeDown()) : cycle(['eraser', 'bgEraser', 'magicEraser'], e.shiftKey)),
      KeyN: () => (mod && e.shiftKey ? P.cmd.newLayer() : mod ? D.newDocDialog(P) : null),
      KeyO: () => (mod ? P.cmd.open() : P.setTool(P.tool === 'dodge' ? 'burn' : 'dodge')),
      KeyS: () => (mod ? P.cmd.saveProject() : cycle(['clone', 'patternStamp'], e.shiftKey)),
      KeyC: () => (mod ? P.cmd.copy(e.shiftKey) : P.setTool('crop')),
      KeyX: () => (mod && e.shiftKey ? P.cmd.liquify() : mod ? P.cmd.cut() : P.swapColors()),
      KeyV: () => (mod ? P.cmd.paste() : P.setTool('move')),
      KeyM: () => (mod ? D.adjustDialog(P, 'curves') : P.setTool(e.shiftKey ? (P.tool === 'rect' ? 'ellipse' : 'rect') : P.tool === 'ellipse' ? 'ellipse' : 'rect')),
      KeyL: () => (mod && e.shiftKey ? (e.altKey ? P.cmd.autoContrast() : P.cmd.autoTone()) : mod ? D.adjustDialog(P, 'levels') : cycle(['lasso', 'polyLasso', 'magLasso'], e.shiftKey)),
      KeyU: () => (mod ? (e.shiftKey ? D.adjustDialog(P, 'desaturate') : D.adjustDialog(P, 'hueSat')) : P.setTool('shape')),
      KeyB: () => (mod && e.shiftKey ? P.cmd.autoColor() : mod ? D.adjustDialog(P, 'colorBalance') : cycle(['brush', 'pencil', 'colorReplace', 'mixer'], e.shiftKey)),
      KeyG: () => (mod ? (e.altKey ? P.cmd.toggleClip() : e.shiftKey ? P.cmd.ungroup() : P.cmd.groupLayers()) : P.setTool(e.shiftKey ? (P.tool === 'gradient' ? 'bucket' : 'gradient') : P.tool === 'bucket' ? 'bucket' : 'gradient')),
      KeyF: () => (mod ? (e.shiftKey ? P.cmd.fade() : D.repeatFilter(P)) : null),
      KeyW: () => (mod ? null : cycle(['objSel', 'quickSel', 'wand'], e.shiftKey)),
      KeyQ: () => (mod ? null : P.cmd.quickMask()),
      F6: () => (e.shiftKey && !mod ? P.cmd.feather() : null),
      KeyH: () => (mod ? null : P.setTool('hand')),
      KeyR: () => (mod && e.altKey ? P.cmd.selectAndMask() : mod ? null : P.setTool('blur')),
      Digit0: () => (mod ? P.fit() : P.setOpt(P.tool, 'opacity', 100)),
      Digit1: () => (mod ? P.setZoom(1) : null),
      Equal: () => (mod ? P.zoomStep(1) : null),
      Minus: () => (mod ? P.zoomStep(-1) : null),
      BracketLeft: () => (mod ? P.cmd.arrange(-1) : changeSize(e.shiftKey ? 'hardness' : 'size', -1)),
      BracketRight: () => (mod ? P.cmd.arrange(1) : changeSize(e.shiftKey ? 'hardness' : 'size', 1)),
      Delete: () => P.cmd.clear(),
      Backspace: () => (e.altKey ? P.fill(P.fg, 1) : mod ? P.fill(P.bg, 1) : P.cmd.clear()),
      Enter: () => (mod && P.getPath?.().length ? P.cmd.pathToSelection() : P.tool === 'crop' ? TOOL_BY_ID.crop.apply(P) : null),
      Escape: () => (P.tool === 'crop' ? TOOL_BY_ID.crop.activate(P) : null),
      ArrowLeft: () => nudge(-1, 0),
      ArrowRight: () => nudge(1, 0),
      ArrowUp: () => nudge(0, -1),
      ArrowDown: () => nudge(0, 1),
    };
    if (/^Digit[1-9]$/.test(k) && !mod && !e.altKey && TOOL_BY_ID[P.tool].options.some((o) => o[0] === 'opacity')) {
      P.setOpt(P.tool, 'opacity', +k.slice(5) * 10);
      return done();
    }
    const fn = map[k];
    if (!fn || !P.doc && !['KeyN', 'KeyO'].includes(k)) return;
    const r = fn();
    if (r !== null) done();
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      updateCursor();
    }
  });

  /** A tool key: pick the family's first tool, or the next one with Shift (like Photoshop). */
  function cycle(ids, shift) {
    const i = ids.indexOf(P.tool);
    P.setTool(i < 0 ? ids[0] : shift ? ids[(i + 1) % ids.length] : P.tool);
    return undefined;
  }

  function changeSize(key, dir) {
    const t = TOOL_BY_ID[P.tool];
    if (!t.options.some((o) => o[0] === key)) return null;
    const o = P.opts(P.tool);
    const v = o[key];
    const nv = key === 'size' ? Math.max(1, Math.round(v + dir * Math.max(1, v * 0.1))) : clamp(v + dir * 10, 0, 100);
    P.setOpt(P.tool, key, nv);
    return undefined;
  }
  function nudge(dx, dy) {
    if (P.tool !== 'move' || !P.doc?.active) return null;
    const l = P.doc.active;
    const k = 1;
    P.run('이동', () => {
      l.x += dx * k;
      l.y += dy * k;
      if (l.mask && l.mask.linked !== false) l.mask = { ...l.mask, x: l.mask.x + dx * k, y: l.mask.y + dy * k };
      P.doc.touch(l);
    });
    return undefined;
  }

  // system clipboard: paste images as a new layer (or a new document when none is open)
  window.addEventListener('paste', (e) => {
    if (!document.body.classList.contains('photo-mode')) return;
    const tag = e.target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    if (P.doc) P.cmd.placeFiles([file]);
    else P.openFiles([file]);
  });

  // ---------------------------------------------------------------- commands

  P.dialogs = D;
  P.fxNames = FX_NAMES;
  P.filterName = D.filterName;
  P.editSmartFilter = (l, i) => {
    const f = l.smart.filters[i];
    if (f) D.smartFilterDialog(P, f.id, f.params, i);
  };
  P.newFillOrAdjustMenu = () => [
    { label: '단색…', action: () => D.fillLayerDialog(P, 'solid') },
    { label: '그레이디언트…', action: () => D.fillLayerDialog(P, 'gradient') },
    { label: '패턴…', action: () => D.fillLayerDialog(P, 'pattern') },
    '-',
    ...Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'desaturate').map(([k, a]) => ({ label: `${a.name}…`, action: () => P.cmd.newAdjustLayer(k) })),
  ];
  installCommands(P);
  installLayerCommands(P);
  installPathTools(P);
  installSelectionTools(P);
  installBrushTools(P);
  installPaint2(P);
  installEdit2(P);
  installExtra3(P);
  installViewExtras(P, { stage });
  installTypeCommands(P, PT);
  installPhotoAI(P);
  installActions(P); // last: it wraps every command so it can record them
  P.emit('tool', P.tool);
  P.emit('channels');
  P.warpText = () => warpTextDialog(P);
  P.menus = buildMenus(P);
  P.layerMenu = () => P.menus['레이어']();
  P.contextMenu = () => [
    { label: '실행 취소', key: 'Ctrl+Z', action: () => P.undo(), disabled: !P.doc?.history.undoStack.length },
    '-',
    { label: '모두 선택', action: () => P.cmd.selectAll() },
    { label: '선택 해제', action: () => P.cmd.deselect(), disabled: !P.doc?.selection },
    { label: '선택 반전', action: () => P.cmd.inverse(), disabled: !P.doc?.selection },
    '-',
    { label: '자유 변형', action: () => P.cmd.freeTransform() },
    { label: '복사한 레이어 (선택 영역)', action: () => P.cmd.layerVia(false) },
    { label: '잘라낸 레이어 (선택 영역)', action: () => P.cmd.layerVia(true), disabled: !P.doc?.selection },
    { label: '칠…', action: () => D.fillDialog(P) },
  ];

  // ---------------------------------------------------------------- autosave

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      IO.saveSession(P.docs, P.index).then(() => P.emit('saved')).catch((err) => console.warn('photo autosave failed', err));
    }, 2500);
  }
  P.scheduleSave = scheduleSave;
  let restored = false;
  P.restoreSession = async () => {
    if (restored) return;
    restored = true;
    try {
      const s = await IO.loadSession();
      if (!s) return;
      for (const d of s.docs) P.openDoc(d);
      P.switchDoc(s.activeIndex);
      toast('지난번 사진 작업을 불러왔습니다');
    } catch (err) {
      console.warn('photo session restore failed', err);
    }
  };

  window.addEventListener('photo:redraw', () => {
    compRev = -1;
    P.redraw();
  });
  P.emit('tool', P.tool);
  docChanged();
  return P;
}

function pointIn(p, pts) {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// ---------------------------------------------------------------- document commands

function installCommands(P) {
  const C = P.cmd;
  const need = () => {
    if (!P.doc) {
      toast('먼저 문서를 열거나 새로 만드세요');
      return false;
    }
    return true;
  };
  const activeRaster = (what = '이 기능') => {
    const l = P.doc?.active;
    if (!l) return null;
    if (l.kind !== 'raster') {
      toast(`${what}은(는) 이미지(일반) 레이어에서 씁니다. 레이어 ▸ 래스터화를 먼저 하세요.`);
      return null;
    }
    return l;
  };

  C.open = async () => {
    const { pickFiles } = await import('../ui/project-panel.js');
    const files = await pickFiles({ accept: IO.OPEN_ACCEPT, multiple: true });
    if (files.length) await P.openFiles(files);
  };
  C.placeFiles = async (files) => {
    if (!need()) return;
    for (const f of files) {
      try {
        const c = f.name.toLowerCase().endsWith('.psd') ? (await IO.openFile(f)).flatten() : await IO.canvasFromFile(f);
        P.run('가져오기 (레이어로)', () => {
          const l = newLayer('raster', { name: f.name.replace(/\.[^.]+$/, ''), canvas: c });
          l.x = Math.round((P.doc.width - c.width) / 2);
          l.y = Math.round((P.doc.height - c.height) / 2);
          P.addLayer(l);
        });
      } catch {
        toast(`${f.name}: 열 수 없습니다`);
      }
    }
  };
  C.place = async () => {
    const { pickFiles } = await import('../ui/project-panel.js');
    const files = await pickFiles({ accept: IO.OPEN_ACCEPT, multiple: true });
    if (files.length) await C.placeFiles(files);
  };
  C.openFromVideo = async () => {
    const { store } = await import('../store.js');
    const { getRuntime } = await import('../media.js');
    const imgs = store.project.mediaOrder.map((id) => store.project.media[id]).filter((m) => m?.kind === 'image' && getRuntime(m.id).image);
    if (!imgs.length) return toast('영상 프로젝트에 불러온 이미지가 없습니다');
    const items = imgs.map((m) => ({ label: m.name, action: () => P.openCanvas(IO.canvasFromImage(getRuntime(m.id).image), m.name.replace(/\.[^.]+$/, ''), m.id) }));
    if (isMobile() && mobileApi.listSheet) return mobileApi.listSheet('영상 프로젝트의 이미지', items);
    const r = document.querySelector('.ph-welcome button:last-child')?.getBoundingClientRect() || { left: 40, bottom: 120 };
    showMenu(items, r.left, r.bottom + 4);
    return undefined;
  };
  C.savePsd = (opts = {}) => {
    if (!need()) return;
    const doc = P.doc;
    try {
      const { blob, skipped, flat } = IO.docToPsd(doc, { ...opts, fg: P.fg, bg: P.bg });
      const notes = [];
      if (skipped) notes.push(`PSD로 옮길 수 없는 조정 레이어 ${skipped}개는 빠짐`);
      const px = [flat.fill && `칠 레이어 ${flat.fill}개`, flat.smart && `고급 개체 ${flat.smart}개`, flat.shape && `모양 ${flat.shape}개`, !opts.editableText && doc.layers.some((l) => l.kind === 'text') && '글자'].filter(Boolean);
      if (px.length) notes.push(`${px.join('·')}는 픽셀로 저장`);
      downloadBlob(blob, `${doc.name}.psd`).then((ok) => {
        if (ok) {
          doc.saved = true;
          P.renderTabs();
          toast(`${doc.name}.psd 저장${notes.length ? ` (${notes.join(', ')})` : ''}`);
        }
      });
    } catch (err) {
      console.error(err);
      toast(`PSD로 저장하지 못했습니다: ${err.message || err}`);
    }
  };
  C.saveProject = async () => {
    if (!need()) return;
    if (P.doc.smartParent && C.commitSmart(P.doc)) return;
    const doc = P.doc;
    const blob = new Blob([JSON.stringify(await IO.docToProject(doc))], { type: 'application/json' });
    if (await downloadBlob(blob, `${doc.name}.mphoto`)) {
      doc.saved = true;
      P.renderTabs();
      toast(`${doc.name}.mphoto 저장 (모든 레이어를 그대로 다시 열 수 있는 Montage 사진 파일)`);
    }
  };
  C.exportLayers = async () => {
    if (!need()) return;
    const doc = P.doc;
    toast('레이어를 파일로 만드는 중…');
    const files = await IO.exportLayers(doc);
    if (!files.length) return toast('내보낼 보이는 레이어가 없습니다');
    const zip = await IO.zipFiles(files.map((f, i) => ({ name: `${String(i + 1).padStart(2, '0')} ${f.name}.png`, blob: f.blob })));
    if (await downloadBlob(zip, `${doc.name} 레이어.zip`)) toast(`레이어 ${files.length}개를 ${doc.name} 레이어.zip으로 저장했습니다`);
  };
  P.exportImage = async (name, type, quality, scale) => {
    const blob = await IO.exportBlob(P.doc, type, quality, scale);
    if (await downloadBlob(blob, `${name}.${type}`)) toast(`${name}.${type} 저장`);
  };
  P.sendToVideo = async ({ replace = false } = {}) => {
    const doc = P.doc;
    const { importFiles } = await import('../media.js');
    const { store } = await import('../store.js');
    const blob = await IO.exportBlob(doc, 'png');
    const file = new File([blob], `${doc.name} (편집됨).png`, { type: 'image/png' });
    const [id] = await importFiles([file]);
    if (!id) return toast('영상 프로젝트에 넣지 못했습니다');
    if (replace && doc.sourceMediaId) {
      let n = 0;
      store.transact('편집한 이미지로 바꾸기', () => {
        for (const s of Object.values(store.project.sequences)) {
          for (const c of Object.values(s.clips)) {
            if (c.mediaId === doc.sourceMediaId) {
              c.mediaId = id;
              n++;
            }
          }
        }
      });
      toast(`영상 프로젝트에 넣었고, 타임라인 클립 ${n}개를 바꿨습니다 (영상 편집에서 실행 취소 가능)`);
    } else toast('영상 프로젝트의 미디어에 새 이미지로 넣었습니다');
    return undefined;
  };

  // ---- edit
  C.copy = (merged = false) => {
    if (!need()) return;
    const doc = P.doc;
    const src = merged ? P.composite() : P.layerAsDocCanvas(doc.active);
    const c = cloneCanvas(src);
    const g = c.getContext('2d');
    if (doc.selection) {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(doc.selection.canvas, 0, 0);
    }
    const b = SEL.alphaBounds(c);
    if (!b) return toast('복사할 픽셀이 없습니다');
    const out = makeCanvas(b.w, b.h);
    out.getContext('2d').drawImage(c, -b.x, -b.y);
    P.clipboard = { canvas: out, x: b.x, y: b.y };
    out.toBlob((blob) => {
      try {
        navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
      } catch { /* system clipboard unavailable */ }
    });
    toast(merged ? '보이는 모습을 복사했습니다' : '복사했습니다');
  };
  C.cut = () => {
    if (!need() || !activeRaster('잘라내기')) return;
    C.copy();
    C.clear('잘라내기');
  };
  C.paste = () => {
    if (!need()) return;
    const cb = P.clipboard;
    if (!cb) return toast('붙여 넣을 내용이 없습니다 (다른 프로그램의 이미지는 Ctrl+V로 바로 붙여 넣을 수 있습니다)');
    P.run('붙여넣기', () => {
      const l = newLayer('raster', { name: '붙여넣은 레이어', canvas: cloneCanvas(cb.canvas) });
      l.x = cb.x;
      l.y = cb.y;
      P.addLayer(l);
      P.doc.selection = null;
    });
    return undefined;
  };
  C.clear = (label = '지우기') => {
    if (!need()) return null;
    const doc = P.doc;
    const l = doc.active;
    if (!doc.selection) {
      toast('지울 선택 영역이 없습니다 (레이어를 지우려면 레이어 ▸ 삭제)');
      return undefined;
    }
    const mt = P.maskTarget?.();
    if (mt) {
      P.run(mt.kind === 'layer' ? '마스크 지우기' : '지우기', () => {
        const g = mt.edit();
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(doc.selection.canvas, -mt.x, -mt.y);
      });
      return undefined;
    }
    if (!activeRaster('지우기')) return undefined;
    P.run(label, () => {
      const g = doc.editPixels(l);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(doc.selection.canvas, -l.x, -l.y);
      l._styled = null;
    });
    return undefined;
  };
  P.fill = (color, opacity = 1) => {
    if (!need()) return;
    const doc = P.doc;
    const l = doc.active;
    const fillTo = (g, ox, oy, lockAlpha) => {
      const t = makeCanvas(doc.width, doc.height);
      const tg = t.getContext('2d');
      tg.fillStyle = color;
      tg.fillRect(0, 0, t.width, t.height);
      if (doc.selection) {
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(doc.selection.canvas, 0, 0);
      }
      g.globalAlpha = opacity;
      if (lockAlpha) g.globalCompositeOperation = 'source-atop';
      g.drawImage(t, -ox, -oy);
    };
    const mt = P.maskTarget?.();
    if (mt) {
      P.run(mt.kind === 'layer' ? '마스크 칠하기' : '칠', () => {
        const g = mt.edit();
        const lum = (parseInt(color.slice(1, 3), 16) * 0.299 + parseInt(color.slice(3, 5), 16) * 0.587 + parseInt(color.slice(5, 7), 16) * 0.114) / 255;
        const area = doc.selection ? doc.selection.canvas : (() => {
          const t = makeCanvas(doc.width, doc.height);
          t.getContext('2d').fillRect(0, 0, t.width, t.height);
          return t;
        })();
        mixIntoMask(g, area, mt.invert ? 1 - lum : lum, opacity, -mt.x, -mt.y);
      });
      return;
    }
    if (!activeRaster('칠')) return;
    P.run('칠', () => {
      const g = doc.editPixels(l);
      fillTo(g, l.x, l.y, l.lockAlpha);
      l._styled = null;
    });
  };
  P.strokeSelection = (width, color, pos) => {
    const doc = P.doc;
    if (!activeRaster('획')) return;
    const outer = pos === 'inside' ? doc.selection : SEL.grow(doc, pos === 'center' ? width / 2 : width);
    const inner = pos === 'outside' ? doc.selection : SEL.grow(doc, -(pos === 'center' ? width / 2 : width));
    const ring = makeCanvas(doc.width, doc.height);
    const g = ring.getContext('2d');
    if (outer) g.drawImage(outer.canvas, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    if (inner) g.drawImage(inner.canvas, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, ring.width, ring.height);
    const l = doc.active;
    P.run('획', () => {
      const lg = doc.editPixels(l);
      lg.drawImage(ring, -l.x, -l.y);
      l._styled = null;
    });
  };
  C.transformLayer = (kind) => {
    if (!need()) return;
    const doc = P.doc;
    const l = doc.active;
    if (!l || l.kind === 'adjust') return;
    P.run(kind.startsWith('flip') ? '뒤집기' : '회전', () => {
      if (l.kind === 'raster') {
        const ob = doc.opaqueBounds(l) || { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
        const src = makeCanvas(ob.w, ob.h);
        src.getContext('2d').drawImage(l.canvas, l.x - ob.x, l.y - ob.y);
        const rot = kind === 'cw' || kind === 'ccw';
        const out = makeCanvas(rot ? ob.h : ob.w, rot ? ob.w : ob.h);
        const g = out.getContext('2d');
        g.translate(out.width / 2, out.height / 2);
        if (kind === 'cw') g.rotate(Math.PI / 2);
        if (kind === 'ccw') g.rotate(-Math.PI / 2);
        if (kind === '180') g.rotate(Math.PI);
        if (kind === 'flipH') g.scale(-1, 1);
        if (kind === 'flipV') g.scale(1, -1);
        g.drawImage(src, -ob.w / 2, -ob.h / 2);
        l.canvas = out;
        l.x = Math.round(ob.x + ob.w / 2 - out.width / 2);
        l.y = Math.round(ob.y + ob.h / 2 - out.height / 2);
      } else {
        l.rotation = ((l.rotation || 0) + (kind === 'cw' ? 90 : kind === 'ccw' ? -90 : kind === '180' ? 180 : 0)) % 360;
        if (kind.startsWith('flip')) toast('글자·모양 레이어는 뒤집을 수 없어 회전만 됩니다 (래스터화하면 가능)');
      }
      l._styled = null;
      doc.touch(l);
    });
  };

  // ---- image
  P.cropTo = (r, deletePixels = false, label = '자르기') => {
    const doc = P.doc;
    P.run(label, () => {
      for (const l of doc.layers) {
        l.x -= r.x;
        l.y -= r.y;
        if (l.mask) l.mask = { ...l.mask, x: l.mask.x - r.x, y: l.mask.y - r.y };
        if (deletePixels && l.kind === 'raster' && l.canvas) {
          const c = makeCanvas(r.w, r.h);
          c.getContext('2d').drawImage(l.canvas, l.x, l.y);
          l.canvas = c;
          l.x = 0;
          l.y = 0;
        }
        l._styled = null;
        l._cache = null;
        l.rev++;
      }
      // masks are kept doc-size
      for (const l of doc.layers) {
        if (!l.mask) continue;
        const m = makeCanvas(r.w, r.h);
        const g = m.getContext('2d');
        g.drawImage(l.mask.canvas, l.mask.x, l.mask.y);
        l.mask = { ...l.mask, canvas: m, x: 0, y: 0 };
      }
      doc.width = r.w;
      doc.height = r.h;
      doc.selection = null;
      doc.rev++;
    });
    P.fit();
  };
  P.resizeImage = (W, H) => {
    const doc = P.doc;
    const kx = W / doc.width;
    const ky = H / doc.height;
    P.run('이미지 크기', () => {
      for (const l of doc.layers) {
        if (l.kind === 'raster' && l.canvas) {
          const c = makeCanvas(l.canvas.width * kx, l.canvas.height * ky);
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(l.canvas, 0, 0, c.width, c.height);
          l.canvas = c;
        } else if (l.kind === 'text') l.text = { ...l.text, size: Math.max(1, Math.round(l.text.size * ky * 10) / 10) };
        else if (l.kind === 'shape') l.shape = { ...l.shape, w: Math.max(1, Math.round(l.shape.w * kx)), h: Math.max(1, Math.round(l.shape.h * ky)), strokeWidth: (l.shape.strokeWidth || 0) * Math.min(kx, ky) };
        l.x = Math.round(l.x * kx);
        l.y = Math.round(l.y * ky);
        if (l.mask) {
          const m = makeCanvas(W, H);
          const g = m.getContext('2d');
          g.drawImage(l.mask.canvas, l.mask.x * kx, l.mask.y * ky, l.mask.canvas.width * kx, l.mask.canvas.height * ky);
          l.mask = { ...l.mask, canvas: m, x: 0, y: 0 };
        }
        l._styled = null;
        l._cache = null;
        l.rev++;
      }
      doc.width = W;
      doc.height = H;
      doc.selection = null;
      doc.rev++;
    });
    P.fit();
  };
  C.rotateCanvas = (kind) => {
    if (!need()) return;
    const doc = P.doc;
    const W = doc.width;
    const H = doc.height;
    const rot = kind === 'cw' || kind === 'ccw';
    P.run(kind.startsWith('flip') ? '캔버스 뒤집기' : '캔버스 회전', () => {
      const tf = (c, x, y) => {
        const out = makeCanvas(rot ? H : W, rot ? W : H);
        const g = out.getContext('2d');
        g.translate(out.width / 2, out.height / 2);
        if (kind === 'cw') g.rotate(Math.PI / 2);
        if (kind === 'ccw') g.rotate(-Math.PI / 2);
        if (kind === '180') g.rotate(Math.PI);
        if (kind === 'flipH') g.scale(-1, 1);
        if (kind === 'flipV') g.scale(1, -1);
        g.drawImage(c, x - W / 2, y - H / 2);
        return out;
      };
      for (const l of doc.layers) {
        if (l.kind === 'raster' && l.canvas) {
          l.canvas = tf(l.canvas, l.x, l.y);
          l.x = 0;
          l.y = 0;
        } else if (l.kind === 'text' || l.kind === 'shape') {
          const b = l.kind === 'text' ? textBox(l) : { w: l.shape.w, h: l.shape.h };
          let cx = l.x + b.w / 2;
          let cy = l.y + b.h / 2;
          if (kind === 'cw') [cx, cy] = [H - cy, cx];
          else if (kind === 'ccw') [cx, cy] = [cy, W - cx];
          else if (kind === '180') [cx, cy] = [W - cx, H - cy];
          else if (kind === 'flipH') cx = W - cx;
          else if (kind === 'flipV') cy = H - cy;
          l.x = Math.round(cx - b.w / 2);
          l.y = Math.round(cy - b.h / 2);
          if (rot || kind === '180') l.rotation = ((l.rotation || 0) + (kind === 'cw' ? 90 : kind === 'ccw' ? -90 : 180)) % 360;
        }
        if (l.mask) l.mask = { ...l.mask, canvas: tf(l.mask.canvas, l.mask.x, l.mask.y), x: 0, y: 0 };
        l._styled = null;
        l._cache = null;
        l.rev++;
      }
      if (rot) {
        doc.width = H;
        doc.height = W;
      }
      doc.selection = null;
      doc.rev++;
    });
    P.fit();
  };
  /** Perspective crop: straighten the quad q (TL, TR, BR, BL) into the new canvas. */
  P.perspectiveCrop = (q) => {
    const doc = P.doc;
    const W = Math.max(1, Math.round(Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]))));
    const H = Math.max(1, Math.round(Math.max(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]))));
    if (W * H > 80e6) return toast('결과가 너무 큽니다');
    P.run('원근 자르기', () => {
      const flatLayer = (l) => {
        const c = makeCanvas(doc.width, doc.height);
        const ct = doc.content(l);
        if (ct) c.getContext('2d').drawImage(ct.canvas, ct.x, ct.y);
        return c;
      };
      for (const l of doc.layers) {
        if (l.kind === 'group' || l.kind === 'adjust') {
          if (l.mask) l.mask = { ...l.mask, canvas: unprojectQuad(maskDoc(l.mask), q, W, H), x: 0, y: 0 };
          continue;
        }
        const src = flatLayer(l);
        Object.assign(l, { kind: 'raster', canvas: unprojectQuad(src, q, W, H), x: 0, y: 0, text: null, shape: null, fill: null, smart: null, smartSrc: null, smartDoc: null, rotation: 0, _text: null, _shape: null, _styled: null });
        if (l.mask) l.mask = { ...l.mask, canvas: unprojectQuad(maskDoc(l.mask), q, W, H), x: 0, y: 0 };
        l.vmask = null;
        doc.touch(l);
      }
      doc.width = W;
      doc.height = H;
      doc.selection = null;
      doc.rev++;
    });
    P.fit();
    return undefined;
    function maskDoc(m) {
      const c = makeCanvas(doc.width, doc.height);
      c.getContext('2d').drawImage(m.canvas, m.x, m.y);
      return c;
    }
  };
  C.cropToSelection = () => {
    if (!need()) return;
    const s = P.doc.selection;
    if (!s) return toast('먼저 선택 영역을 만드세요');
    const b = SEL.alphaBounds(s.canvas);
    if (b) P.cropTo(b, false, '선택 영역으로 자르기');
    return undefined;
  };
  C.trim = () => {
    if (!need()) return;
    const b = SEL.alphaBounds(P.composite());
    if (!b) return toast('보이는 픽셀이 없습니다');
    P.cropTo(b, false, '투명 영역 잘라내기');
    return undefined;
  };
  C.autoTone = () => {
    const l = activeRaster('자동 톤');
    if (!l) return;
    P.run('자동 톤', () => {
      const c = l.canvas;
      const g = c.getContext('2d');
      const img = g.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      const lo = [];
      const hi = [];
      for (let k = 0; k < 3; k++) {
        const hist = new Uint32Array(256);
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { hist[d[i + k]]++; n++; }
        let acc = 0;
        let a = 0;
        while (a < 255 && (acc += hist[a]) < n * 0.005) a++;
        acc = 0;
        let b = 255;
        while (b > 0 && (acc += hist[b]) < n * 0.005) b--;
        lo.push(a);
        hi.push(Math.max(a + 1, b));
      }
      const out = makeCanvas(c.width, c.height);
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = ((d[i + k] - lo[k]) * 255) / (hi[k] - lo[k]);
      out.getContext('2d').putImageData(img, 0, 0);
      l.canvas = out;
      l._styled = null;
      P.doc.touch(l);
    });
  };

  // ---- layers (see layercmds.js)
  C.addMask = (hideAll = false) => {
    if (!need()) return;
    const doc = P.doc;
    const l = doc.active;
    if (!l) return;
    if (l.mask) return toast('이미 마스크가 있습니다');
    P.run('레이어 마스크', () => {
      if (hideAll) doc.addMask(l, 'black', false);
      else doc.addMask(l, 'white', !!doc.selection);
      doc.selection = null;
    });
    P.editMask = true;
    P.emit('layers');
    return undefined;
  };
  C.applyMask = () => {
    const doc = P.doc;
    const l = doc?.active;
    if (!l?.mask || l.kind !== 'raster') return;
    P.run('마스크 적용', () => {
      const g = doc.editPixels(l);
      g.globalCompositeOperation = 'destination-in';
      const m = makeCanvas(g.canvas.width, g.canvas.height);
      const mg = m.getContext('2d');
      mg.drawImage(l.mask.canvas, l.mask.x - l.x, l.mask.y - l.y);
      g.drawImage(m, 0, 0);
      l.mask = null;
    });
    P.editMask = false;
  };
  C.deleteMask = () => {
    const l = P.doc?.active;
    if (!l?.mask) return;
    P.run('마스크 삭제', () => { l.mask = null; P.doc.touch(l); });
    P.editMask = false;
  };
  C.invertMask = () => {
    const l = P.doc?.active;
    if (!l?.mask) return;
    P.run('마스크 반전', () => {
      const c = makeCanvas(l.mask.canvas.width, l.mask.canvas.height);
      const g = c.getContext('2d');
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(l.mask.canvas, 0, 0);
      l.mask = { ...l.mask, canvas: c };
      P.doc.touch(l);
    });
  };

  // ---- select
  C.selectAll = () => need() && P.run('모두 선택', () => { P.doc.selection = SEL.selectAll(P.doc); });
  C.deselect = () => {
    if (!P.doc?.selection) return;
    P.doc.lastSelection = P.doc.selection;
    P.run('선택 해제', () => { P.doc.selection = null; });
  };
  C.reselect = () => P.doc?.lastSelection && P.run('다시 선택', () => { P.doc.selection = P.doc.lastSelection; });
  C.inverse = () => need() && P.run('선택 반전', () => { P.doc.selection = SEL.invert(P.doc); });
  const selModify = async (label, fn, def) => {
    if (!P.doc?.selection) return toast('먼저 선택 영역을 만드세요');
    const v = await promptDialog(label, '픽셀', String(def));
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    P.run(label, () => { P.doc.selection = fn(n); });
    return undefined;
  };
  C.feather = () => selModify('페더', (n) => SEL.feather(P.doc, n), 10);
  C.selectFromLayer = (l = P.doc?.active, mode = 'new') => l && P.run('레이어 모양대로 선택', () => {
    const m = SEL.fromLayer(P.doc, l);
    P.doc.selection = mode === 'new' ? m : SEL.combine(P.doc, m.canvas, mode);
  });
  C.maskToSelection = (l = P.doc?.active) => {
    if (!l?.mask) return;
    P.run('마스크를 선택 영역으로', () => {
      const c = makeCanvas(P.doc.width, P.doc.height);
      c.getContext('2d').drawImage(l.mask.canvas, l.mask.x, l.mask.y);
      P.doc.selection = { canvas: c };
    });
  };
  C.toggleClipFor = (l) => {
    P.selectLayer(l.id);
    C.toggleClip();
  };
  C.layerStyle = (section = 'blending') => need() && D.layerStyleDialog(P, section);
  C.placeEmbedded = async () => {
    if (!need()) return;
    const { pickFiles } = await import('../ui/project-panel.js');
    const files = await pickFiles({ accept: IO.OPEN_ACCEPT, multiple: true });
    for (const f of files) {
      try {
        const isPsd = /\.ps[db]$/i.test(f.name);
        const sub = isPsd || /\.mphoto$/i.test(f.name) ? await IO.openFile(f) : null;
        const c = sub ? sub.flatten() : await IO.canvasFromFile(f);
        C.placeEmbeddedCanvas(c, f.name.replace(/\.[^.]+$/, ''), sub);
      } catch (err) {
        toast(`${f.name}: 가져오지 못했습니다 (${err.message || err})`);
      }
    }
  };
}

// ---------------------------------------------------------------- menus

function buildMenus(P) {
  const C = P.cmd;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const no = () => !P.doc;
  const adjustItems = () => Object.entries(ADJUSTMENTS).map(([k, a]) => ({ label: `${a.name}${a.params.length ? '…' : ''}`, key: { levels: `${mod}L`, curves: `${mod}M`, hueSat: `${mod}U`, colorBalance: `${mod}B`, invert: `${mod}I`, desaturate: `${mod}Shift+U` }[k], disabled: no(), action: () => D.adjustDialog(P, k) }));
  const filterGroups = () => {
    const groups = {};
    for (const [id, f] of Object.entries(FILTERS)) (groups[f.group] ||= []).push({ label: `${f.name}${f.params.length ? '…' : ''}`, disabled: no(), action: () => D.filterDialog(P, id) });
    // a group of one (Camera Raw) is a plain item, like Photoshop's
    return Object.entries(groups).map(([g, items]) => (items.length === 1 ? items[0] : { label: g, submenu: items }));
  };
  return {
    '파일': () => [
      { label: '새로 만들기…', key: `${mod}N`, action: () => D.newDocDialog(P) },
      { label: '열기… (사진·PSD·Montage 사진 파일)', key: `${mod}O`, action: () => C.open() },
      { label: '영상 프로젝트의 이미지 열기', action: () => C.openFromVideo() },
      { label: '포함 가져오기 (고급 개체)…', disabled: no(), action: () => C.placeEmbedded() },
      { label: '가져오기 (새 픽셀 레이어로)…', disabled: no(), action: () => C.place() },
      { label: '닫기', disabled: no(), action: () => P.closeDoc() },
      '-',
      { label: 'Montage 사진 파일로 저장 (.mphoto)', key: `${mod}S`, disabled: no(), action: () => C.saveProject() },
      { label: 'PSD로 저장 (포토샵 파일)', disabled: no(), action: () => C.savePsd() },
      { label: 'PSD로 저장 (글자·모양을 포토샵에서 고칠 수 있게, 실험적)', disabled: no(), action: () => C.savePsd({ editableText: true }) },
      { label: '레이어를 파일로 내보내기 (PNG)…', disabled: no(), action: () => C.exportLayers() },
      { label: '내보내기 (PNG · JPG · WebP)…', key: `${mod}Shift+Alt+W`, disabled: no(), action: () => D.exportDialog(P) },
      { label: '자동화', submenu: [{ label: '일괄 처리… (여러 사진에 액션)', action: () => C.batch() }, { label: '액션 패널 열기', action: () => P.showPanel('actions') }] },
      '-',
      { label: '영상 편집으로 보내기…', disabled: no(), action: () => D.sendToVideoDialog(P) },
    ],
    '편집': () => [
      { label: `실행 취소${P.doc?.history.undoStack.length ? `: ${P.doc.history.undoStack.at(-1).label}` : ''}`, key: `${mod}Z`, disabled: !P.doc?.history.undoStack.length, action: () => P.undo() },
      { label: `다시 실행${P.doc?.history.redoStack.length ? `: ${P.doc.history.redoStack.at(-1).label}` : ''}`, key: `${mod}Shift+Z`, disabled: !P.doc?.history.redoStack.length, action: () => P.redo() },
      '-',
      { label: '잘라내기', key: `${mod}X`, disabled: no(), action: () => C.cut() },
      { label: '복사', key: `${mod}C`, disabled: no(), action: () => C.copy() },
      { label: '병합하여 복사 (보이는 모습)', key: `${mod}Shift+C`, disabled: no(), action: () => C.copy(true) },
      { label: '붙여넣기', key: `${mod}V`, disabled: no(), action: () => C.paste() },
      { label: '지우기 (선택 영역)', key: 'Delete', disabled: no(), action: () => C.clear() },
      '-',
      { label: '희미하게 하기… (마지막 작업)', key: `${mod}Shift+F`, disabled: no(), action: () => C.fade() },
      '-',
      { label: '칠…', key: 'Shift+F5', disabled: no(), action: () => D.fillDialog(P) },
      { label: '내용 인식 채우기 (선택 영역을 주변으로)', disabled: no() || !P.doc?.selection, action: () => C.contentAwareFill() },
      { label: '획 (선택 영역 테두리)…', disabled: no(), action: () => D.strokeDialog(P) },
      '-',
      { label: '자유 변형', key: `${mod}T`, disabled: no(), action: () => C.freeTransform() },
      { label: '변형', disabled: no(), submenu: [
        { label: '다시', key: `${mod}Shift+T`, disabled: !P.lastTransform, action: () => C.transformAgain() },
        '-',
        { label: '크기 조절 · 회전', action: () => C.freeTransform('free') },
        { label: '기울이기', action: () => C.freeTransform('skew') },
        { label: '왜곡', action: () => C.freeTransform('distort') },
        { label: '원근', action: () => C.freeTransform('perspective') },
        { label: '뒤틀기', action: () => C.freeTransform('warp') },
        '-',
        { label: '90° 시계 방향 회전', action: () => C.transformLayer('cw') },
        { label: '90° 반시계 방향 회전', action: () => C.transformLayer('ccw') },
        { label: '180° 회전', action: () => C.transformLayer('180') },
        { label: '가로로 뒤집기', action: () => C.transformLayer('flipH') },
        { label: '세로로 뒤집기', action: () => C.transformLayer('flipV') },
      ] },
      { label: '내용 인식 비율…', key: `${mod}Alt+Shift+C`, disabled: no(), action: () => C.contentAwareScale() },
      { label: '퍼펫 뒤틀기…', disabled: no(), action: () => C.puppetWarp() },
      { label: '하늘 대체…', disabled: no(), action: () => C.skyReplacement() },
      '-',
      { label: '텍스트 찾기 / 바꾸기…', disabled: no(), action: () => C.findReplace() },
      '-',
      { label: '브러시 사전 설정 정의… (선택 영역의 어두운 부분)', disabled: no(), action: () => C.defineBrush() },
      { label: '패턴 정의… (선택 영역 또는 전체)', disabled: no(), action: () => C.definePattern() },
    ],
    '이미지': () => [
      { label: '조정', disabled: no(), submenu: adjustItems },
      { label: '자동 톤', key: `${mod}Shift+L`, disabled: no(), action: () => C.autoTone() },
      { label: '자동 대비', key: `${mod}Alt+Shift+L`, disabled: no(), action: () => C.autoContrast() },
      { label: '자동 색상', key: `${mod}Shift+B`, disabled: no(), action: () => C.autoColor() },
      { label: '색상 일치… (다른 사진의 색감)', disabled: no(), action: () => C.matchColor() },
      { label: '모드', disabled: no(), submenu: [{ label: 'RGB 색상', checked: P.doc?.mode !== 'gray', action: () => toast('RGB 색상 모드입니다 (회색 음영으로 바꾼 레이어는 다시 색이 생기지 않아요)') }, { label: '회색 음영으로 바꾸기', checked: P.doc?.mode === 'gray', action: () => C.grayscale() }] },
      '-',
      { label: '이미지 크기…', key: `${mod}Alt+I`, disabled: no(), action: () => D.imageSizeDialog(P) },
      { label: '캔버스 크기…', key: `${mod}Alt+C`, disabled: no(), action: () => D.canvasSizeDialog(P) },
      { label: '모두 나타내기 (캔버스 밖 부분까지)', disabled: no(), action: () => C.revealAll() },
      { label: '복제 (새 문서로)', disabled: no(), action: () => C.duplicateDoc() },
      { label: '이미지 회전', disabled: no(), submenu: [
        { label: '180°', action: () => C.rotateCanvas('180') },
        { label: '90° 시계 방향', action: () => C.rotateCanvas('cw') },
        { label: '90° 반시계 방향', action: () => C.rotateCanvas('ccw') },
        '-',
        { label: '캔버스 가로로 뒤집기', action: () => C.rotateCanvas('flipH') },
        { label: '캔버스 세로로 뒤집기', action: () => C.rotateCanvas('flipV') },
      ] },
      { label: '선택 영역으로 자르기', disabled: no() || !P.doc?.selection, action: () => C.cropToSelection() },
      { label: '투명 영역 잘라내기 (트리밍)', disabled: no(), action: () => C.trim() },
    ],
    '레이어': () => layerMenuItems(P, mod),
    '선택': () => [
      { label: '모두', key: `${mod}A`, disabled: no(), action: () => C.selectAll() },
      { label: '선택 해제', key: `${mod}D`, disabled: !P.doc?.selection, action: () => C.deselect() },
      { label: '다시 선택', key: `${mod}Shift+D`, disabled: !P.doc?.lastSelection, action: () => C.reselect() },
      { label: '반전', key: `${mod}Shift+I`, disabled: no(), action: () => C.inverse() },
      '-',
      { label: '모든 레이어', key: `${mod}Alt+A`, disabled: no(), action: () => C.selectAllLayers() },
      { label: '레이어 선택 해제', disabled: no(), action: () => C.deselectLayers() },
      '-',
      { label: '피사체 (색 분석, 단순 추정)', disabled: no(), action: () => C.selectSubject() },
      { label: '하늘 (단순 추정)', disabled: no(), action: () => C.selectSky() },
      { label: '초점 영역…', disabled: no(), action: () => C.focusArea() },
      { label: '색상 범위…', disabled: no(), action: () => C.colorRange() },
      '-',
      { label: '선택 및 마스크…', key: `${mod}Alt+R`, disabled: no(), action: () => C.selectAndMask() },
      { label: '수정', disabled: !P.doc?.selection, submenu: [
        { label: '테두리…', action: () => C.border() },
        { label: '매끄럽게…', action: () => C.smooth() },
        { label: '확대…', action: () => C.expand() },
        { label: '축소…', action: () => C.contract() },
        { label: '페더…', key: 'Shift+F6', action: () => C.feather() },
      ] },
      { label: '선택 영역 확장 (마술봉 허용치)', disabled: !P.doc?.selection, action: () => C.grow() },
      { label: '유사 영역 선택', disabled: !P.doc?.selection, action: () => C.similar() },
      '-',
      { label: '선택 영역 변형', disabled: !P.doc?.selection, action: () => C.transformSelection() },
      '-',
      { label: '빠른 마스크 모드로 편집', key: 'Q', checked: !!P.doc?.quickMask, disabled: no(), action: () => C.quickMask() },
      '-',
      { label: '선택 영역 불러오기…', disabled: no(), action: () => C.loadSelection() },
      { label: '선택 영역 저장…', disabled: !P.doc?.selection, action: () => C.saveSelection() },
      { label: '레이어 모양대로 선택', disabled: no(), action: () => C.selectFromLayer() },
    ],
    '필터': () => [
      { label: '마지막 필터 다시', key: `${mod}F`, disabled: no(), action: () => D.repeatFilter(P) },
      '-',
      { label: '픽셀 유동화…', key: `${mod}Shift+X`, disabled: no(), action: () => C.liquify() },
      ...filterGroups(),
    ],
    'AI': () => P.aiMenu(),
    '보기': () => [
      { label: '확대', key: `${mod}+`, disabled: no(), action: () => P.zoomStep(1) },
      { label: '축소', key: `${mod}-`, disabled: no(), action: () => P.zoomStep(-1) },
      { label: '화면에 맞추기', key: `${mod}0`, disabled: no(), action: () => P.fit() },
      { label: '100% (실제 픽셀)', key: `${mod}1`, disabled: no(), action: () => P.setZoom(1) },
      ...(P.viewMenuItems ? P.viewMenuItems(mod, no) : []),
    ],
    '창': () => [
      { label: '색상', action: () => P.showPanel('color') },
      { label: '속성', action: () => P.showPanel('props') },
      { label: '작업 내역', action: () => P.showPanel('history') },
      { label: '레이어', action: () => P.showPanel('layers') },
      { label: '채널', action: () => P.showPanel('channels') },
      { label: '패스', action: () => P.showPanel('paths') },
      { label: '내비게이터', action: () => P.showPanel('nav') },
      { label: '정보', action: () => P.showPanel('info') },
      { label: '히스토그램', action: () => P.showPanel('histo') },
      { label: '액션', action: () => P.showPanel('actions') },
      { label: '레이어 구성요소', action: () => P.showPanel('comps') },
      { label: 'AI (자동 보정 · 편집 도우미)', action: () => P.showPanel('ai') },
    ],
    '도움말': () => [
      { label: '설명서 (모든 기능)', action: () => import('../docs/viewer.js').then((m) => m.openDocs('p-start')) },
      { label: '사진 편집 단축키', action: () => photoShortcuts() },
      '-',
      { label: 'Montage 웹사이트 (새 탭)', action: () => window.open('index.html', '_blank', 'noopener') },
    ],
  };
}

function photoShortcuts() {
  import('../ui/common.js').then(({ openModal }) => {
    const rows = [
      ['V', '이동'], ['M / Shift+M', '사각형 · 원형 선택'], ['L', '올가미'], ['W', '자동 선택(마술봉)'], ['C', '자르기'], ['I / Shift+I', '스포이드 · 색상 샘플러 · 눈금자 · 메모 · 카운트'],
      ['J / Shift+J', '복구 도구들 (스팟 복구 · 복구 · 패치 · 내용 인식 이동 · 제거 · 적목)'], ['B / Shift+B', '브러시 · 연필 · 색상 대체 · 혼합 브러시'], ['Y', '작업 내역 브러시'], ['S', '복제 도장 (Alt+클릭으로 원본)'], ['E / Shift+E', '지우개 · 배경 지우개 · 자동 지우개'], ['G / Shift+G', '그레이디언트 · 페인트 통'],
      ['O', '닷지 · 번'], ['R', '흐림 브러시'], ['T', '문자'], ['U', '모양'], ['H / Space 누른 채 끌기', '화면 이동'], ['Z', '돋보기'],
      ['[ / ]', '브러시 크기'], ['Shift+[ / ]', '브러시 경도'], ['1~9, 0', '불투명도 10~90%, 100%'], ['X / D', '색 바꾸기 / 기본 색'],
      ['Ctrl+Z / Ctrl+Shift+Z', '실행 취소 / 다시 실행'], ['Ctrl+A / Ctrl+D / Ctrl+Shift+I', '모두 선택 / 해제 / 반전'],
      ['Ctrl+T', '자유 변형 (브라우저가 막으면 편집 메뉴 사용)'], ['Ctrl+J / Ctrl+E', '레이어 복제 / 아래로 병합'],
      ['Ctrl+L / M / U / B / I', '레벨 / 곡선 / 색조·채도 / 색상 균형 / 반전'], ['Alt+Backspace / Ctrl+Backspace', '전경색 / 배경색으로 칠'],
      ['Ctrl+0 / Ctrl+1', '화면에 맞추기 / 100%'], ['Ctrl+휠, Alt+휠', '확대·축소'], ['두 손가락', '휴대폰: 확대·축소·이동'],
    ];
    openModal({ title: '사진 편집 단축키 (macOS는 Ctrl 대신 ⌘)', width: '600px', body: [h('div.kbd-table', rows.flatMap(([k, d]) => [h('span', d), h('span.k', k)])), h('div.note', '한글 입력 상태에서도 단축키가 작동합니다 (키 위치 기준). 글자를 입력하는 칸에서는 단축키가 꺼집니다.')] });
  });
}

/** A dirty rectangle grown to whole pixels (plus a pixel of margin) and kept inside the document. */
function clipRect(r, W, H) {
  const x = Math.max(0, Math.floor(r.x) - 1);
  const y = Math.max(0, Math.floor(r.y) - 1);
  const x1 = Math.min(W, Math.ceil(r.x + r.w) + 1);
  const y1 = Math.min(H, Math.ceil(r.y + r.h) + 1);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

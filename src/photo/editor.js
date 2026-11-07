// Photo editor ("사진 편집"): a Photoshop-style raster editor living next to the video editor.
// Owns the open documents, the canvas view (zoom/pan, overlay), tools, menus and shortcuts.

import { h, clamp, downloadBlob, modKey } from '../util.js';
import { toast, promptDialog, confirmDialog, showMenu, closeMenus, menusOpen, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { mobileApi } from '../ui/mobile.js';
import { PhotoDoc, newLayer, makeCanvas, cloneCanvas, textBox, boxCorners, unionRect } from './doc.js';
import { History } from './history.js';
import * as SEL from './selection.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { ADJUSTMENTS, FILTERS } from './adjust.js';
import './fx2.js';
import './fx3.js';
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
import { filterGalleryDialog } from './gallery.js';
import { installFilters } from './filtermenu.js';
import { installImage2 } from './image2.js';
import { installTools3 } from './tools3.js';
import { installView3 } from './view3.js';
import { buildSwatchesPanel, buildGlyphsPanel, buildAdjustmentsPanel, buildToolPresetsPanel, buildTimelinePanel, installGlyphs } from './panels3.js';
import { mixIntoMask } from './selectx.js';
import { buildPathsPanel, buildCharacterPanel, installTypeCommands, warpTextDialog } from './panels2.js';
import * as PT from './paths.js';
import { Transformer, TRANSFORM_MODES, WARP_STYLES, applyM, composeM, unprojectQuad, transformMasksBy, mapMaskCanvas } from './transform.js';
import { FX_NAMES } from './styles.js';
import { buildToolbar, buildToolStrip, buildOptionsBar, buildLayersPanel, buildColorPanel, buildPropertiesPanel, buildHistoryPanel } from './panels.js';
import { installCore2, arrangeMenus } from './core2.js';
import { installLearn } from './learn.js';
import { installTheme, buildHome, rememberFile, recentMenu, keepDoc } from './psui.js';
import { installArtboards } from './artboards.js';

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
  // painting goes to the layer mask; adjustment and fill layers have nothing else to paint on, so
  // their mask is always the target (Photoshop)
  _editMask: false,
  get editMask() {
    const l = this.doc?.active;
    return this._editMask || (!!l?.mask && (l.kind === 'adjust' || l.kind === 'fill'));
  },
  set editMask(v) {
    this._editMask = !!v;
  },
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
// once: the move tool picks the layer under the pointer and shows its box (the options used to be
// off, and the box option did nothing)
if ((toolOpts._v || 0) < 2) {
  toolOpts.move = { ...(toolOpts.move || {}), autoSelect: true, showTransform: true };
  toolOpts._v = 2;
  savePref('photo.opts', toolOpts);
}

export function createPhotoEditor(root) {
  // The saved last tool may be one the install* calls below register (pen, frame, rotate view…):
  // build the bars with a core tool and switch back once every tool exists.
  const savedTool = P.tool;
  if (!TOOL_BY_ID[P.tool]) P.tool = 'brush';

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
  /** Tool Preset picker ▸ Reset Tool / Reset All Tools: the options back to their defaults. */
  P.resetToolOptions = (id = null) => {
    const keys = id ? [TOOL_BY_ID[id]?.optionsFrom || id] : Object.keys(toolOpts).filter((k) => k !== '_v');
    for (const k of keys) delete toolOpts[k];
    savePref('photo.opts', toolOpts);
    P.emit('opts');
    P.overlay();
    toast(id ? '도구를 기본 설정으로 되돌렸습니다' : '모든 도구를 기본 설정으로 되돌렸습니다');
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
  // Edit ▸ Preferences (view3.js): pasteboard colour, transparency grid, brush cursor, wheel, autosave
  P.prefs = { pasteboard: '#1f2125', checker: 'medium', checkerTone: 'light', cursor: 'outline', wheelZoom: false, autosave: true, historyMB: isMobile() ? 350 : 900, historyStates: 50, snapOnSave: false, units: 'px', ...loadPref('photo.prefs', {}) };
  P.exportDialog = () => (P.doc ? D.exportDialog(P) : toast('내보낼 문서가 없습니다. 먼저 사진을 열거나 새 문서를 만드세요.'));

  // ---------------------------------------------------------------- DOM
  const view = h('canvas.ph-view');
  const over = h('canvas.ph-over');
  // the home screen: over the whole editor while no document is open, or from the Home button (psui.js)
  const welcome = buildHome(P, { newDoc: () => D.newDocDialog(P), open: () => P.cmd.open(), openFromVideo: () => P.cmd.openFromVideo() });
  const stage = h('div.ph-stage', view, over);
  const tabs = h('div.ph-tabs');
  const status = h('div.ph-status', { hidden: true });
  const toolbar = buildToolbar(P);
  const strip = buildToolStrip(P);
  const opts = buildOptionsBar(P);
  installGlyphs(P);
  const panels = {
    color: { title: '색상', el: buildColorPanel(P) },
    swatches: { title: '견본', el: buildSwatchesPanel(P) },
    adjustments: { title: '조정', el: buildAdjustmentsPanel(P) },
    glyphs: { title: '글리프', el: buildGlyphsPanel(P) },
    presets: { title: '도구 사전 설정', el: buildToolPresetsPanel(P) },
    timeline: { title: '타임라인', el: buildTimelinePanel(P) },
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
  // ---- the right dock: Photoshop's panel groups (tabs, a panel menu ≡ on each tab bar, collapse to icons)
  P.panelMenus = P.panelMenus || {};
  // the group a panel opened from the Window menu joins when no group has it (0: first, 1: second, -1: last)
  const PANEL_HOME = { layers: -1, channels: -1, paths: -1, timeline: -1, actions: -1, comps: -1, props: 1, adjustments: 1, char: 1, para: 1, charStyles: 1, paraStyles: 1, glyphs: 1, ai: 1, presets: 1, history: 1, brushSettings: 1, brushes: 1, cloneSource: 1, styles: 1, shapes: 1 };
  const PANEL_ICONS = { color: 'drop', swatches: 'swatches', gradients: 'gradTool', patterns: 'grid', props: 'sliders', adjustments: 'fillAdjust', layers: 'copy', channels: 'channels', paths: 'pathSelect', history: 'clock', char: 'type', para: 'paraLeft', charStyles: 'type', paraStyles: 'paraLeft', glyphs: 'glyph', presets: 'presets', nav: 'zoomIn', info: 'info', histo: 'bars', actions: 'play', comps: 'folder', ai: 'ai', timeline: 'film', brushes: 'brush', brushSettings: 'sliders', styles: 'sparkle', shapes: 'shape', cloneSource: 'stamp', learn: 'book' };
  P.dockLayout = (name) => ({
    essentials: [['color', 'swatches', 'gradients', 'patterns'], ['props', 'adjustments'], ['layers', 'channels', 'paths']],
  })[name];
  const savedDock = loadPref('photo.dock', null);
  // where each panel's module asked for it ('top' or 'layers')
  const homeOf = { layers: 'layers', channels: 'layers', paths: 'layers', timeline: 'layers', actions: 'layers', comps: 'layers' };
  const dock = { groups: [], collapsed: !!savedDock?.collapsed, pop: null };
  const dockBody = h('div.ph-dock-body');
  const collapseBtn = h('button.ph-dock-toggle', { onclick: () => dock.setCollapsed(!dock.collapsed) });
  const dockIcons = h('div.ph-dock-icons', { role: 'toolbar', 'aria-label': '패널 아이콘' });
  const saveDock = () => savePref('photo.dock', { groups: dock.groups.map((G) => G.ids), cur: dock.groups.map((G) => G.cur), size: dock.groups.map((G) => G.size || 0), collapsed: dock.collapsed });
  const panelMenu = (G, anchor) => {
    const id = G.cur;
    const own = id && P.panelMenus[id]?.();
    // panels with their own menu button (Channels, Swatches, Actions…) open that menu
    const btn = !own && id ? panels[id].el.querySelector('[aria-label$="패널 메뉴"], [aria-label="액션 메뉴"], [aria-label="견본 메뉴"], [aria-label="타임라인 메뉴"]') : null;
    const r = anchor.getBoundingClientRect();
    const tail = [
      { label: '닫기', disabled: !id, action: () => dock.close(id) },
      { label: '탭 그룹 닫기', action: () => { for (const x of [...G.live()]) dock.close(x); } },
    ];
    if (btn) {
      btn.click();
      return;
    }
    showMenu([...(own || []), ...(own?.length ? ['-'] : []), ...tail], r.right - 220, r.bottom + 2);
  };
  const makeGroup = (ids, cur, size = 0) => {
    const G = { ids: [...ids], cur: cur || ids[0] || null, size };
    const bar = h('div.ph-ptabs', { role: 'tablist' });
    const menuBtn = h('button.ph-pmenu', { title: '패널 메뉴', 'aria-label': '패널 메뉴' }, icon('menu', 13));
    menuBtn.addEventListener('click', () => panelMenu(G, menuBtn));
    const body = h('div.ph-pbody');
    G.el = h('div.ph-pgroup', h('div.ph-ptabbar', bar, menuBtn), body);
    G.live = () => G.ids.filter((id) => panels[id]);
    G.render = () => {
      const live = G.live();
      if (!live.includes(G.cur)) G.cur = live[0] || null;
      bar.replaceChildren(...live.map((id) => {
        const b = h(`button${id === G.cur ? '.on' : ''}`, { role: 'tab', 'aria-selected': String(id === G.cur), onclick: () => G.show(id) }, panels[id].title);
        b.dataset.id = id;
        return b;
      }));
      G.el.hidden = !live.length;
      // more tabs than fit: keep the one shown in view (a panel opened from 창 was hidden past the edge)
      requestAnimationFrame(() => {
        const on = bar.querySelector('button.on');
        if (!on || bar.scrollWidth <= bar.clientWidth) return;
        const a = bar.getBoundingClientRect();
        const b = on.getBoundingClientRect();
        if (b.right > a.right) bar.scrollLeft += b.right - a.right;
        else if (b.left < a.left) bar.scrollLeft -= a.left - b.left;
      });
      G.el.style.flex = G.size && G !== dock.groups[dock.groups.length - 1] ? `0 0 ${G.size}px` : '';
      // on phones a panel lives in the sheet while it is open there
      if (G.cur && body.firstChild !== panels[G.cur].el && !panels[G.cur].el.closest('.ph-sheet.open')) body.replaceChildren(panels[G.cur].el);
      if (!G.cur) body.replaceChildren();
    };
    G.show = (id) => {
      if (!G.ids.includes(id)) return;
      G.cur = id;
      G.render();
      saveDock();
    };
    return G;
  };
  /** Lay the dock out: groups of panel ids (unregistered ids wait for their panel), `picks`: the tab shown in each. */
  dock.set = (groups, picks = [], sizes = []) => {
    dock.groups = groups.map((ids, i) => makeGroup(ids, picks[i], sizes[i]));
    renderDock();
    saveDock();
  };
  dock.find = (id) => dock.groups.find((G) => G.ids.includes(id));
  dock.visible = (id) => !!dock.find(id) && dock.find(id).cur === id && !dock.collapsed;
  dock.close = (id) => {
    const G = dock.find(id);
    if (!G) return;
    G.ids = G.ids.filter((x) => x !== id);
    G.render();
    renderDock();
    saveDock();
  };
  /** Bring a panel up in the dock, adding it to its usual group when no group has it. */
  dock.open = (id) => {
    let G = dock.find(id);
    if (!G) {
      const k = PANEL_HOME[id] ?? (homeOf[id] === 'layers' ? -1 : 0);
      const live = dock.groups.filter((x) => x.live().length);
      G = (k < 0 ? live[live.length - 1] : live[Math.min(k, live.length - 1)]) || dock.groups[0];
      if (!G) {
        dock.groups.push(makeGroup([]));
        G = dock.groups[0];
      }
      G.ids.push(id);
      renderDock();
    }
    G.show(id);
    if (dock.collapsed) openPop(G);
  };
  const renderDock = () => {
    const parts = [];
    dock.groups.forEach((G, i) => {
      G.render();
      if (i && !G.el.hidden && parts.length) parts.push(resizer(dock.groups.slice(0, i).reverse().find((x) => !x.el.hidden)));
      parts.push(G.el);
    });
    if (!dock.pop) dockBody.replaceChildren(...parts.filter(Boolean));
    side.classList.toggle('collapsed', dock.collapsed);
    // collapsed: one icon per panel, a line between groups
    const icons = [];
    for (const G of dock.groups) {
      const live = G.live();
      if (!live.length) continue;
      if (icons.length) icons.push(h('div.ph-dock-sep'));
      for (const id of live) {
        const b = h(`button.ph-dock-icon${dock.pop === G && G.cur === id ? '.on' : ''}`, { title: panels[id].title, 'aria-label': panels[id].title, onclick: () => {
          if (dock.pop === G && G.cur === id) return closePop();
          G.show(id);
          return openPop(G);
        } }, icon(PANEL_ICONS[id] || 'menu', 18));
        icons.push(b);
      }
    }
    dockIcons.replaceChildren(...icons);
    syncCollapseBtn();
  };
  // the line between two groups: drag to give the upper one more or less room
  const resizer = (G) => {
    if (!G) return null;
    const r = h('div.ph-dock-resize', { role: 'separator', 'aria-orientation': 'horizontal', title: '끌어서 패널 높이 바꾸기' });
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const start = e.clientY;
      const h0 = G.el.getBoundingClientRect().height;
      const move = (ev) => {
        G.size = clamp(Math.round(h0 + ev.clientY - start), 60, Math.max(80, side.getBoundingClientRect().height - 160));
        G.el.style.flex = `0 0 ${G.size}px`;
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        saveDock();
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up, { once: true });
      r.addEventListener('pointercancel', up, { once: true });
    });
    return r;
  };
  // collapsed to icons: a group pops out beside the icon column
  const popEl = h('div.ph-dock-pop', { hidden: true });
  const openPop = (G) => {
    dock.pop = G;
    popEl.replaceChildren(G.el);
    G.el.style.flex = '';
    popEl.hidden = false;
    renderDock();
  };
  const closePop = () => {
    if (!dock.pop) return;
    dock.pop = null;
    popEl.hidden = true;
    renderDock();
  };
  document.addEventListener('pointerdown', (e) => {
    if (dock.pop && !popEl.contains(e.target) && !dockIcons.contains(e.target) && !e.target.closest?.('.menu, .modal-backdrop, .ph-pop')) closePop();
  }, true);
  dock.setCollapsed = (on) => {
    closePop();
    dock.collapsed = !!on;
    renderDock();
    saveDock();
    P.redraw();
  };
  function syncCollapseBtn() {
    collapseBtn.replaceChildren(icon(dock.collapsed ? 'dblChevL' : 'dblChevR', 10));
    collapseBtn.title = dock.collapsed ? '패널 확장' : '아이콘으로 축소';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
  }
  const side = h('div.ph-side', h('div.ph-dock-head', collapseBtn), dockBody, dockIcons, popEl);
  P.dock = dock;
  /** Register a panel from a module: a tab in the upper ('top') or layers ('layers') group, a sheet on phones. */
  P.addPanel = (id, title, el, where = 'top') => {
    panels[id] = { title, el };
    homeOf[id] = where;
    // the default layout names panels before their modules register them
    if (dock.find(id)) renderDock();
  };
  {
    const ess = P.dockLayout('essentials');
    if (savedDock?.groups?.length) dock.set(savedDock.groups, savedDock.cur, savedDock.size);
    else dock.set(ess);
  }
  // phone: a sheet that shows one panel at a time
  const sheetBody = h('div.ph-sheet-body');
  const sheetTitle = h('b');
  // the panel's menu (≡), as on the dock's tab bar
  const sheetMenu = h('button.m-icon', { 'aria-label': '패널 메뉴', hidden: true, onclick: () => {
    const r = sheetMenu.getBoundingClientRect();
    showMenu(P.panelMenus[sheet.dataset.panel]?.() || [], Math.max(8, r.right - 260), r.bottom + 2);
  } }, icon('menu', 20));
  const sheet = h('div.ph-sheet', h('div.ph-sheet-head', sheetTitle, sheetMenu, h('button.m-icon', { 'aria-label': '닫기', onclick: () => closeSheet() }, icon('close', 20))), sheetBody);
  const mnav = h('div.ph-mnav',
    ...[['layers', '레이어', 'grid'], ['props', '속성', 'sliders'], ['color', '색', 'filter'], ['adjust', '조정', 'sparkle'], ['filter', '필터', 'wand'], ['ai', 'AI', 'ai'], ['history', '내역', 'undo'], ['more', '더보기', 'more']].map(([id, label, ic]) => h('button.m-tool', { onclick: () => mobileAction(id) }, icon(ic, 20), h('span', label))));
  const center = h('div.ph-center', tabs, stage);
  const bodyEl = h('div.ph-body', toolbar, center, side);
  const textBox2 = h('div.ph-textedit', { hidden: true });
  root.append(h('div.ph', opts, bodyEl, strip, status, mnav, sheet, textBox2, welcome));

  P.showPanel = (id, colorTarget) => {
    if (colorTarget) P.emit('colortarget', colorTarget);
    if (isMobile()) {
      openSheet(id);
      return;
    }
    // panels hidden with Tab / Shift+Tab come back when one is asked for (Window menu, F7…)
    document.body.classList.remove('ph-hide-panels', 'ph-hide-side');
    if (panels[id]) dock.open(id);
  };

  function openSheet(id) {
    sheet.classList.add('open');
    sheet.dataset.panel = id;
    sheetMenu.hidden = !P.panelMenus[id];
    sheetTitle.textContent = panels[id].title;
    sheetBody.replaceChildren(panels[id].el);
    P.emit('layers');
  }
  function closeSheet() {
    sheet.classList.remove('open');
    // panels go back to the dock
    renderDock();
  }
  function mobileAction(id) {
    if (panels[id]) return openSheet(id);
    closeSheet();
    const menus = P.menus;
    const list = (title, items) => (mobileApi.listSheet ? mobileApi.listSheet(title, items) : showMenu(items, 8, 60));
    if (id === 'adjust') return list('조정', [...menus['이미지']().find((x) => x.label?.startsWith('조정')).submenu(), '-', { group: '조정 레이어 (원본을 바꾸지 않음)' }, ...menus['레이어']().find((x) => x.label === '새 조정 레이어').submenu()]);
    if (id === 'filter') return list('필터', menus['필터']());
    return list('더보기', [
      { label: '홈 화면 (내 문서)', action: () => P.showHome(true) },
      { label: '새 문서…', action: () => D.newDocDialog(P) },
      { label: '열기…', action: () => P.cmd.open() },
      { label: '내보내기 형식…', action: () => P.exportDialog() },
      { label: 'PSD로 저장', action: () => P.cmd.savePsd() },
      { label: '영상 편집으로 보내기…', action: () => D.sendToVideoDialog(P) },
      '-',
      { label: '문자 · 단락 패널', action: () => openSheet('char') },
      { label: '글리프 (특수 문자)', action: () => openSheet('glyphs') },
      { label: '견본 패널', action: () => openSheet('swatches') },
      { label: '도구 사전 설정', action: () => openSheet('presets') },
      { label: '타임라인 (움직이는 GIF)', action: () => openSheet('timeline') },
      { label: '패스 패널', action: () => openSheet('paths') },
      '-',
      { label: '자유 변형', action: () => P.cmd.freeTransform() },
      { label: '모두 선택', action: () => P.cmd.selectAll() },
      { label: '선택 해제', action: () => P.cmd.deselect() },
      { label: '화면에 맞추기', action: () => P.fit(true) },
      '-',
      { label: '전체 메뉴…', action: () => list('메뉴', Object.keys(menus).map((name) => ({ label: name, submenu: () => menus[name]() }))) },
    ]);
  }

  // ---------------------------------------------------------------- documents

  P.openDoc = (doc) => {
    doc.history = new History(doc, { budgetBytes: (P.prefs.historyMB || (isMobile() ? 350 : 900)) * 1e6, states: P.prefs.historyStates || 50 });
    // File ▸ Revert goes back to how the document was opened (or last saved)
    doc.openState = doc.capture();
    doc.view = { zoom: 1, x: 0, y: 0 };
    P.docs.push(doc);
    P.index = P.docs.length - 1;
    P.editMask = false;
    docChanged();
    // (several opened at once: each fits when it comes up, see docChanged)
    requestAnimationFrame(() => { if (P.doc === doc) P.fit(); });
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
    // the home screen keeps it with all its layers (psui.js / library.js); asked only when that fails
    const kept = await keepDoc(P, d);
    if (!kept && !d.saved && !(await confirmDialog('문서 닫기', `"${d.name}"을(를) 닫을까요? 저장하지 않은 변경은 자동 저장본에서도 지워집니다.`))) return;
    i = P.docs.indexOf(d);
    if (i < 0) return;
    if (i === P.index) {
      if (P.transform) P.applyTransform();
      finishText();
    }
    P.docs.splice(i, 1);
    // closing a tab left of the active one keeps the same document active
    if (i < P.index) P.index--;
    P.index = Math.min(P.index, P.docs.length - 1);
    if (P.index < 0 && P.docs.length) P.index = 0;
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
        const doc = P.openDoc(await IO.openFile(f));
        // File ▸ Open Recent and the home screen list it (psui.js)
        doc.recentId = `${f.name}|${f.size}|${f.lastModified || 0}`;
        setTimeout(() => rememberFile(P, f, doc), 300);
      } catch (err) {
        console.error(err);
        toast(`${f.name}: 열 수 없습니다 (${err.message || err})`);
      }
    }
  };

  function docChanged() {
    const doc = P.doc;
    P.showHome(!doc);
    updateStatus();
    // a document opened while another was showing (or restored) fits the window when it comes up
    if (doc && !doc.view?.fitted) P.fit();
    renderTabs();
    if (doc) TOOL_BY_ID[P.tool].activate?.(P);
    P.emit('doc');
    P.emit('history');
    P.emit('layers');
    P.redraw();
  }

  P.renderTabs = () => renderTabs();
  /** Photoshop's tab title: "이름 @ 66.7%(레이어 1, RGB/8) *". */
  const tabTitle = (d) => {
    if (isMobile()) return `${d.name}${d.saved ? '' : ' *'}`;
    let a = d.layer(d.activeId) || d.layers[d.layers.length - 1];
    // an alpha channel or a single colour channel being looked at names itself (no layer)
    const ch = d._ch;
    const alpha = ch?.active && d.channels?.find((c) => c.id === ch.active);
    const one = !alpha && ch?.comps?.size === 1 && !ch.alpha?.size ? { r: '빨강', g: '녹색', b: '파랑' }[[...ch.comps][0]] : null;
    if (alpha || one) a = null;
    const mode = { gray: '회색', duotone: '이중톤', indexed: '인덱스', bitmap: '비트맵' }[d.mode] || 'RGB';
    const what = alpha ? `${alpha.name}/8` : one ? `${one}/8` : d === P.doc && P.editMask ? '레이어 마스크/8' : d.quickMask ? '빠른 마스크/8' : `${mode}/8`;
    return `${d.name} @ ${Math.round((d.view?.zoom || 1) * 1000) / 10}%(${a ? `${a.name}, ` : ''}${what})${d.saved ? '' : ' *'}`;
  };
  function renderTabs() {
    tabs.replaceChildren(...P.docs.map((d, i) => {
      const t = h(`div.ph-tab${i === P.index ? '.on' : ''}`, { onclick: () => P.switchDoc(i), title: `${d.name} (${d.width} × ${d.height} 픽셀)` },
        h('span', tabTitle(d)),
        h('button.ph-tabx', { 'aria-label': `${d.name} 닫기`, title: '닫기', onclick: (e) => { e.stopPropagation(); P.closeDoc(i); } }, icon('close', 10)));
      t.dataset.doc = d.id;
      // a layer dragged onto a tab goes into that document (core2.js)
      P.decorateTab?.(t, d);
      return t;
    }),
    h('button.ph-tabadd', { onclick: () => D.newDocDialog(P), title: '새 문서', 'aria-label': '새 문서' }, '+'));
    P.emit('tabs');
  }

  // ---------------------------------------------------------------- history

  P.commit = (label, before, { touched = false } = {}) => {
    const doc = P.doc;
    if (!doc) return;
    // whatever the step changed, the picture is redrawn (some commands swap layers without touching
    // them), unless the step marked every change itself (a move: only where the object was and is)
    // or the layers it changed show where (a layer shown or hidden, added, its opacity): then that
    // part alone, when the picture on screen is still the one from before the step
    let area;
    if (!touched) {
      area = doc.diffArea(before);
      // the picture on screen was put together at compRev: before the step or part-way through it
      let dirty = null;
      if (area && compDoc === doc && compRev >= 0 && compFloat === (P.float?.viewOnly ? null : P.float)) {
        const m = compRev >= before.rev ? doc.changedSince(before.rev, compRev) : doc.changedSince(compRev, before.rev);
        dirty = m && unionRect(m, area);
      }
      if (dirty) doc.markSince(compRev, dirty);
      else doc.rev++;
    }
    doc.history.push(label, before, area);
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
  // what changed in the composite since the view cache was drawn: null, a rectangle, or 'all'
  let viewDirty = null;
  // the view cache key the screen canvas shows as it is (no live preview over it), so an unchanged
  // picture isn't copied again and a changed part is copied alone
  let viewShows = '';
  /** Draw everything again (after a preference that changes how the picture is shown). */
  P.invalidateView = () => {
    viewCache.key = '';
    viewShows = '';
    checker = null;
    P.redraw();
  };
  let vidCounter = 0;
  let checker = null;
  let draftTimer = 0;
  let draftFull = false;
  // the composite holds a quick draft of an adjustment being changed (screen only)
  let compDraft = false;
  /**
   * The whole picture (doc size). forView: for drawing on screen, where a quick draft of an
   * adjustment being changed will do; everything else (copy merged, sampling, export) gets it exact.
   */
  P.composite = (forView = false) => {
    const doc = P.doc;
    if (comp.width !== doc.width || comp.height !== doc.height) {
      comp.width = doc.width;
      comp.height = doc.height;
      compRev = -1;
    }
    if (compDraft && !forView) {
      compDraft = false;
      clearTimeout(draftTimer);
      draftFull = true;
      compRev = -1;
    }
    // a view-only float (a live preview on the top layer) is drawn over the view in draw(), not here
    const fl = P.float?.viewOnly ? null : P.float;
    if (compRev !== doc.rev || compDoc !== doc || compFloat !== fl || compMask !== P.showMaskOnly) {
      // only part of the picture changed (a brush stroke, a moved layer or selection): redo just that
      const same = compDoc === doc && compMask === P.showMaskOnly && !P.showMaskOnly;
      const moved = same && compFloat !== fl ? doc.floatMoveArea(compFloat, fl) : null;
      let dirty;
      if (same && compFloat === fl) dirty = doc.takeDirty(compRev);
      else if (moved) {
        dirty = compRev === doc.rev ? moved : doc.takeDirty(compRev);
        if (dirty) dirty = unionRect(dirty, moved);
      } else dirty = doc.takeDirty(NaN);
      // nothing on screen changed (a layer copied before painting on it): keep the picture as it is
      const nothing = !!dirty && !(dirty.w > 0 && dirty.h > 0);
      const clip = dirty && !nothing && clipRect(dirty, doc.width, doc.height);
      compMask = P.showMaskOnly;
      compDoc = doc;
      if (nothing) {
        compRev = doc.rev;
        compFloat = fl;
        return comp;
      }
      if (clip && clip.w * clip.h < doc.width * doc.height * 0.6) {
        doc.render(comp.getContext('2d'), { float: fl, fg: P.fg, bg: P.bg, clip });
        if (mipDirty !== 'all') mipDirty = mipDirty ? unionRect(mipDirty, clip) : clip;
        if (viewDirty !== 'all') viewDirty = viewDirty ? unionRect(viewDirty, clip) : clip;
      } else {
        // an adjustment layer being changed (a slider dragged) is drawn quickly at screen size or
        // for the part on screen (doc.js); the whole picture follows once the changes stop
        const v = doc.view;
        const dpr = window.devicePixelRatio || 1;
        // ('prep': the changes stopped; a big picture is then worked out in strips, see adjustInStrips)
        const full = () => {
          draftFull = true;
          compRev = -1;
          P.redraw();
        };
        const draft = !forView || draftFull === true || !v ? null : { scale: v.zoom * dpr, rect: { x: (-off.x - v.x) / v.zoom, y: (-off.y - v.y) / v.zoom, w: view.width / dpr / v.zoom, h: view.height / dpr / v.zoom }, prep: draftFull === 'prep', ready: () => P.doc === doc && full() };
        draftFull = false;
        doc.render(comp.getContext('2d'), { float: fl, fg: P.fg, bg: P.bg, draft });
        compDraft = !!draft?.used;
        if (draft?.used && !draft.waiting) {
          clearTimeout(draftTimer);
          draftTimer = setTimeout(() => {
            draftFull = 'prep';
            compRev = -1;
            P.redraw();
          }, 300);
        }
        mipDirty = 'all';
        viewDirty = 'all';
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
    const src = P.composite(true);
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

  // Rotate View: the two canvases grow to the stage's diagonal and turn (CSS) about its middle, so
  // everything drawn on them (picture, selection, handles) turns along; `off` is where the stage's
  // top-left corner sits inside the bigger canvas
  let off = { x: 0, y: 0 };
  let cssKey = '';
  // the stage's size, read once after it changes (the ResizeObserver below forgets it): reading it on
  // every frame made the browser lay out the page again whenever a panel had just changed
  let stageBox = null;
  function sizeCanvases() {
    const r = stageBox || (stageBox = stage.getBoundingClientRect());
    // hidden (video mode) or not laid out yet: ask again next time
    if (!(r.width > 0 && r.height > 0)) stageBox = null;
    const dpr = window.devicePixelRatio || 1;
    const rot = P.doc?.view?.rot || 0;
    // View ▸ Flip Horizontal mirrors the view (not the picture)
    const flip = !!P.doc?.view?.flip;
    const D = rot ? Math.ceil(Math.hypot(r.width, r.height)) + 2 : 0;
    const cw = rot ? D : r.width;
    const ch = rot ? D : r.height;
    off = { x: rot ? (D - r.width) / 2 : 0, y: rot ? (D - r.height) / 2 : 0 };
    const key = rot || flip ? `${rot}|${flip}|${D}|${r.width}x${r.height}` : '';
    for (const c of [view, over]) {
      const w = Math.max(1, Math.round(cw * dpr));
      const hh = Math.max(1, Math.round(ch * dpr));
      if (c.width !== w || c.height !== hh) {
        c.width = w;
        c.height = hh;
      }
      if (key !== cssKey) {
        Object.assign(c.style, rot || flip
          ? { left: `${-off.x}px`, top: `${-off.y}px`, width: `${cw}px`, height: `${ch}px`, transform: `${rot ? `rotate(${rot}deg)` : ''}${flip ? ' scaleX(-1)' : ''}`.trim(), transformOrigin: '50% 50%' }
          : { left: '', top: '', width: '', height: '', transform: '', transformOrigin: '' });
      }
    }
    cssKey = key;
    return dpr;
  }
  /** A client point in the stage's own (unturned) coordinates. */
  const logical = (clientX, clientY) => {
    const r = stage.getBoundingClientRect();
    let lx = clientX - r.left;
    let ly = clientY - r.top;
    const rot = P.doc?.view?.rot || 0;
    if (rot) {
      const a = (-rot * Math.PI) / 180;
      const cx = r.width / 2;
      const cy = r.height / 2;
      const dx = lx - cx;
      const dy = ly - cy;
      lx = cx + dx * Math.cos(a) - dy * Math.sin(a);
      ly = cy + dx * Math.sin(a) + dy * Math.cos(a);
    }
    if (P.doc?.view?.flip) lx = r.width - lx;
    return [lx, ly];
  };
  /** A movement on screen turned into the stage's own coordinates. */
  const logicalDelta = (dx, dy) => {
    const rot = P.doc?.view?.rot || 0;
    const k = P.doc?.view?.flip ? -1 : 1;
    if (!rot) return [k * dx, dy];
    const a = (-rot * Math.PI) / 180;
    return [k * (dx * Math.cos(a) - dy * Math.sin(a)), dx * Math.sin(a) + dy * Math.cos(a)];
  };
  P.logicalPoint = logical;

  function draw() {
    frame = 0;
    const dpr = sizeCanvases();
    const g = view.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    const doc = P.doc;
    const og = over.getContext('2d');
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, over.width, over.height);
    if (!doc) {
      g.fillStyle = P.prefs.pasteboard || '#1f2125';
      g.fillRect(0, 0, view.width, view.height);
      viewShows = '';
      return;
    }
    const v = doc.view;
    const [x, y] = [v.x, v.y];
    const w = doc.width * v.zoom;
    const hh = doc.height * v.zoom;
    // transparency checkerboard
    const full = P.composite(true);
    const shown = P.displayCanvas ? P.displayCanvas(full) : full;
    // zoomed out, a smaller copy of the picture looks the same and draws much faster
    const src = shown === full ? P.viewSource(v.zoom * dpr) : shown;
    if (!src._vid) src._vid = ++vidCounter;
    const rotated = !!v.rot;
    const OX = off.x;
    const OY = off.y;
    const vbase = `${src._vid}|${v.zoom}|${v.x}|${v.y}|${dpr}|${view.width}x${view.height}|${v.rot || 0}`;
    const vkey = `${vbase}|${compVersion}`;
    // the part of the screen to paint again: null for all of it, 'none' for nothing
    let blit = viewShows === vkey ? 'none' : null;
    if (viewCache.key !== vkey) {
      const wasShown = viewShows === viewCache.key;
      // scaling a big picture down to the screen is the costly part of a redraw: do it only when
      // the picture or the view changed (not for marching ants, cursors or overlays), and when only
      // a part of the picture changed (moving an object, a brush stroke) only that part
      const part = viewCache.base === vbase && viewDirty && viewDirty !== 'all' && shown === full && !rotated ? viewDirty : null;
      viewDirty = null;
      viewCache.base = vbase;
      if (viewCache.width !== view.width || viewCache.height !== view.height) {
        viewCache.width = view.width;
        viewCache.height = view.height;
      }
      const vg = viewCache.getContext('2d');
      vg.setTransform(1, 0, 0, 1, 0, 0);
      vg.save();
      // only the screen pixels the changed source pixels (and the filter around them) reach; the whole
      // picture is still drawn into that clip, since drawing a cut-out of it filters its edges differently
      let none = false;
      if (part) {
        const kx = src.width / doc.width;
        const ky = src.height / doc.height;
        // shrinking, the filter blends several source pixels (through the browser's own smaller copies)
        const ratio = (w * dpr) / src.width;
        const m = 2 + (ratio < 1 ? 4 * Math.ceil(1 / ratio) : 0);
        const px0 = Math.floor(part.x * kx) - m;
        const py0 = Math.floor(part.y * ky) - m;
        const px1 = Math.ceil((part.x + part.w) * kx) + m;
        const py1 = Math.ceil((part.y + part.h) * ky) + m;
        const toX = (sx) => (x + (sx * w) / src.width) * dpr;
        const toY = (sy) => (y + (sy * hh) / src.height) * dpr;
        const rx = Math.max(0, Math.floor(toX(px0)) - 1);
        const ry = Math.max(0, Math.floor(toY(py0)) - 1);
        const rw = Math.min(viewCache.width, Math.ceil(toX(px1)) + 1) - rx;
        const rh = Math.min(viewCache.height, Math.ceil(toY(py1)) + 1) - ry;
        if (rw > 0 && rh > 0) {
          vg.beginPath();
          vg.rect(rx, ry, rw, rh);
          vg.clip();
          vg.clearRect(rx, ry, rw, rh);
          if (wasShown) blit = { x: rx, y: ry, w: rw, h: rh };
        } else {
          none = true;
          if (wasShown) blit = 'none';
        }
      } else vg.clearRect(0, 0, viewCache.width, viewCache.height);
      if (!none) {
        vg.setTransform(dpr, 0, 0, dpr, OX * dpr, OY * dpr);
        if (!checker) {
          // transparency grid (Preferences: size and colours)
          const cs = { small: 4, medium: 8, large: 16 }[P.prefs.checker] || 8;
          const [c0, c1] = { light: ['#ffffff', '#cccccc'], mid: ['#bfbfbf', '#8f8f8f'], dark: ['#666666', '#4d4d4d'] }[P.prefs.checkerTone] || ['#ffffff', '#cccccc'];
          const c = makeCanvas(cs * 2, cs * 2);
          const cg = c.getContext('2d');
          cg.fillStyle = c0;
          cg.fillRect(0, 0, cs * 2, cs * 2);
          cg.fillStyle = c1;
          cg.fillRect(0, 0, cs, cs);
          cg.fillRect(cs, cs, cs, cs);
          checker = vg.createPattern(c, 'repeat');
        }
        vg.save();
        vg.fillStyle = checker;
        vg.translate(x, y);
        // with artboards, only they show the grid; the rest of the canvas is pasteboard
        const abs = doc.layers.filter((l) => l.artboard && !l.parent);
        if (abs.length) for (const { artboard: a } of abs) vg.fillRect(a.x * v.zoom, a.y * v.zoom, a.w * v.zoom, a.h * v.zoom);
        else vg.fillRect(0, 0, w, hh);
        vg.restore();
        vg.imageSmoothingEnabled = v.zoom < 2;
        // within 2× of the source size bilinear filtering is enough (and several times faster)
        vg.imageSmoothingQuality = (w * dpr) / src.width >= 0.5 ? 'low' : 'high';
        vg.drawImage(src, x, y, w, hh);
      }
      vg.restore();
      viewCache.key = vkey;
    }
    // live preview on the top layer: made at screen size and drawn straight over the picture
    const live = P.float?.viewOnly ? P.float.canvas : null;
    if (live || rotated) blit = blit === 'none' && !live ? 'none' : null;
    if (blit !== 'none') {
      g.save();
      if (blit) {
        g.beginPath();
        g.rect(blit.x, blit.y, blit.w, blit.h);
        g.clip();
      }
      g.fillStyle = P.prefs.pasteboard || '#1f2125';
      g.fillRect(0, 0, view.width, view.height);
      if (blit) g.drawImage(viewCache, blit.x, blit.y, blit.w, blit.h, blit.x, blit.y, blit.w, blit.h);
      else g.drawImage(viewCache, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, OX * dpr, OY * dpr);
      if (live) {
        g.imageSmoothingEnabled = true;
        g.drawImage(live, x, y, w, hh);
      }
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      if (!P.artboardOverlay || !doc.layers.some((l) => l.artboard)) g.strokeRect(x - 0.5, y - 0.5, w + 1, hh + 1);
      g.restore();
    }
    viewShows = live ? '' : vkey;
    // overlay: selection ants, tool overlay, transform handles, brush cursor
    og.setTransform(dpr, 0, 0, dpr, OX * dpr, OY * dpr);
    if (doc.selection && !P.float && P.extrasOn !== false) {
      const ants = SEL.antsImage(doc.selection, { zoom: v.zoom * dpr, x: (v.x + OX) * dpr, y: (v.y + OY) * dpr }, over.width, over.height, antsPhase);
      if (ants) {
        og.setTransform(1, 0, 0, 1, 0, 0);
        // the overlay was cleared above: only the part with the edges needs putting back
        const b = ants.box;
        if (b) og.putImageData(ants, 0, 0, b.x, b.y, b.w, b.h);
        og.setTransform(dpr, 0, 0, dpr, OX * dpr, OY * dpr);
      }
    }
    P.artboardOverlay?.(og);
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
    if (hover && TOOL_BY_ID[P.tool].cursor === 'brush' && !P.transform && !document.body.classList.contains('modal-peeking')) {
      const r = (P.opts(P.tool).size * v.zoom) / 2;
      const [cx, cy] = P.toScreen(hover.x, hover.y);
      // Preferences ▸ brush cursor: the brush outline, a precise cross, or both
      if (P.prefs.cursor !== 'cross') {
        og.strokeStyle = 'rgba(0,0,0,0.7)';
        og.beginPath();
        og.arc(cx, cy, Math.max(1.5, r), 0, Math.PI * 2);
        og.stroke();
        og.strokeStyle = 'rgba(255,255,255,0.9)';
        og.beginPath();
        og.arc(cx, cy, Math.max(1.5, r - 1), 0, Math.PI * 2);
        og.stroke();
      }
      if (P.prefs.cursor !== 'outline') {
        for (const [col, w] of [['rgba(0,0,0,0.8)', 3], ['rgba(255,255,255,0.95)', 1]]) {
          og.strokeStyle = col;
          og.lineWidth = w;
          og.beginPath();
          og.moveTo(cx - 7, cy);
          og.lineTo(cx + 7, cy);
          og.moveTo(cx, cy - 7);
          og.lineTo(cx, cy + 7);
          og.stroke();
        }
        og.lineWidth = 1;
      }
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
    const [lx, ly] = logical(clientX, clientY);
    return { x: (lx - P.view.x) / P.view.zoom, y: (ly - P.view.y) / P.view.zoom };
  };
  // `enlarge`: View ▸ Fit on Screen (Ctrl+0) also zooms a small picture (a pattern tile) up to
  // fill the window, like Photoshop; opening a document never goes above 100%
  P.fit = (enlarge = !!P.doc?.view?.enlarge) => {
    const doc = P.doc;
    if (!doc) return;
    const r = stage.getBoundingClientRect();
    // hidden (video mode): fit when the stage shows up
    if (r.width < 20 || r.height < 20) return;
    // artboards keep room for their names above them
    const pad = (isMobile() ? 16 : 40) + (doc.layers.some((l) => l.artboard) ? 40 : 0);
    // a turned view (Rotate View) fits the turned picture
    const rot = doc.view?.rot || 0;
    const a = (rot * Math.PI) / 180;
    const bw = Math.abs(doc.width * Math.cos(a)) + Math.abs(doc.height * Math.sin(a));
    const bh = Math.abs(doc.width * Math.sin(a)) + Math.abs(doc.height * Math.cos(a));
    const z = Math.max(0.01, Math.min(enlarge ? 64 : 1, (r.width - pad) / bw, (r.height - pad) / bh));
    // auto: the view follows the window (rotating the phone) until the user zooms or pans
    doc.view = { zoom: z, x: (r.width - doc.width * z) / 2, y: (r.height - doc.height * z) / 2, fitted: true, auto: true, rot, flip: !!doc.view?.flip, enlarge: enlarge || undefined };
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
    const [lx, ly] = logical(px, py);
    const zoom = clamp(z, 0.01, 64);
    doc.view = { zoom, x: lx - p.x * zoom, y: ly - p.y * zoom, fitted: true, rot: doc.view.rot || 0, flip: !!doc.view.flip };
    P.viewChanged();
  };
  P.zoomAt = (k, cx, cy) => P.setZoom(P.view.zoom * k, cx, cy);
  /** View ▸ Flip Horizontal: mirror the view to check a drawing (the picture stays as it is). */
  P.setViewFlip = (on = !P.doc?.view?.flip) => {
    const doc = P.doc;
    if (!doc) return;
    // the middle of the window stays on the same spot of the picture
    const r = stage.getBoundingClientRect();
    const c = P.toDoc(r.left + r.width / 2, r.top + r.height / 2);
    doc.view = { ...doc.view, flip: !!on };
    const [lx] = logical(r.left + r.width / 2, r.top + r.height / 2);
    doc.view.x = lx - c.x * doc.view.zoom;
    P.viewChanged();
  };
  P.zoomStep = (dir) => {
    const z = P.view.zoom;
    const next = dir > 0 ? ZOOMS.find((x) => x > z * 1.001) : [...ZOOMS].reverse().find((x) => x < z / 1.001);
    P.setZoom(next ?? z);
  };

  // ---- the status bar: the zoom (type a value), the document information chosen from its ▸ menu
  const STATUS_ITEMS = [['size', '문서 크기'], ['profile', '문서 프로필'], ['dims', '문서 치수'], ['res', '해상도'], ['tool', '현재 도구']];
  let statusShow = loadPref('photo.statusShow', 'size');
  const zoomField = h('input.ph-zoomin', { type: 'text', 'aria-label': '확대/축소 비율', title: '확대/축소 비율 (값을 넣고 Enter)', spellcheck: false });
  zoomField.addEventListener('focus', () => zoomField.select());
  zoomField.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = parseFloat(zoomField.value);
      if (P.doc && v > 0) P.setZoom(clamp(v / 100, 0.01, 32));
      zoomField.blur();
    } else if (e.key === 'Escape') zoomField.blur();
  });
  zoomField.addEventListener('blur', () => {
    lastStatus = '';
    updateStatus();
  });
  const infoText = h('span');
  const infoBtn = h('button.ph-sinfo', { title: '문서 정보 · 눌러서 보여 줄 항목 고르기', 'aria-label': '문서 정보 표시 항목' }, infoText, h('span.ph-caret'));
  infoBtn.addEventListener('click', () => {
    const r = infoBtn.getBoundingClientRect();
    showMenu(STATUS_ITEMS.map(([k, label]) => ({ label, checked: statusShow === k, action: () => {
      statusShow = k;
      savePref('photo.statusShow', k);
      lastStatus = '';
      updateStatus();
    } })), r.left, Math.max(8, r.top - 30 - STATUS_ITEMS.length * 28));
  });
  const stateText = h('span.ph-sstate');
  status.append(zoomField, infoBtn, stateText);
  const mb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 1048576 * 100 ? 0 : 1)}M` : `${Math.max(1, Math.round(bytes / 1024))}K`);
  const docInfo = (doc) => {
    const res = doc.resolution || 72;
    if (statusShow === 'profile') return '문서 프로필: sRGB IEC61966-2.1 (8bpc)';
    if (statusShow === 'dims') return `${doc.width} 픽셀 × ${doc.height} 픽셀 (${Math.round(res * 100) / 100} ppi)`;
    if (statusShow === 'res') return `해상도: ${Math.round(res * 100) / 100} 픽셀/인치`;
    if (statusShow === 'tool') return toolLabel();
    // Photoshop's "문서: flattened/with layers"
    let layered = 0;
    for (const l of doc.layers) if (l.canvas) layered += l.canvas.width * l.canvas.height * 4;
    return `문서: ${mb(doc.width * doc.height * 3)}/${mb(Math.max(layered, doc.width * doc.height * 3))}`;
  };
  const toolLabel = () => {
    const t = TOOL_BY_ID[P.tool];
    const base = t.name.replace(/\s*\(.*\)$/, '');
    return /도구$/.test(base) ? base : `${base} 도구`;
  };
  let lastStatus = '';
  function updateStatus() {
    const doc = P.doc;
    if (!doc) {
      if (lastStatus !== 'none') status.hidden = true;
      lastStatus = 'none';
      return;
    }
    const zoom = `${Math.round(doc.view.zoom * 10000) / 100}%`;
    const info = docInfo(doc);
    const state = `${hover ? `${Math.floor(hover.x)}, ${Math.floor(hover.y)} px` : ''}${doc.selection ? ' · 선택 영역 있음' : ''}${P.editMask ? ' · 마스크 편집 중' : ''}${doc.quickMask ? ' · 빠른 마스크' : ''}${P.chState?.().active ? ' · 알파 채널 편집 중' : ''}`;
    const tabT = tabTitle(doc);
    const key = `${zoom}|${info}|${state}|${tabT}`;
    if (key === lastStatus) return;
    lastStatus = key;
    status.hidden = false;
    if (document.activeElement !== zoomField) zoomField.value = zoom;
    infoText.textContent = info;
    stateText.textContent = state.replace(/^ · /, '');
    // the active tab's title follows the zoom and the active layer
    const span = tabs.querySelector('.ph-tab.on > span');
    if (span && span.textContent !== tabT) span.textContent = tabT;
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
  /**
   * Where a layer sits on the canvas: `quad` (its four corners in doc coords, clockwise from the
   * top left; turned with the layer for text and shapes) and `box` (axis-aligned bounds), or null.
   */
  P.layerFrame = (l) => {
    const doc = P.doc;
    if (!doc || !l || l.kind === 'adjust') return null;
    let quad = null;
    if (l.kind === 'text' || l.kind === 'shape') {
      const b = l.kind === 'text' ? textBox(l) : { w: l.shape.w, h: l.shape.h };
      quad = boxCorners(l, b.w, b.h);
    } else {
      const b = doc.opaqueBounds(l);
      if (b) quad = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    }
    if (!quad) return null;
    const xs = quad.map((q) => q[0]);
    const ys = quad.map((q) => q[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { quad, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
  };
  /** Topmost visible layer with a pixel (or box) at p. */
  P.layerAt = (p, filter = () => true) => {
    const doc = P.doc;
    for (const l of [...doc.layers].reverse()) {
      if (!doc.shown(l) || l.kind === 'adjust' || l.kind === 'group' || !filter(l) || P.hiddenByFrame?.(l, p)) continue;
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
    const ants = SEL.antsImage({ canvas: s.canvas }, { zoom: v.zoom * dpr, x: (v.x + off.x + dx * v.zoom) * dpr, y: (v.y + off.y + dy * v.zoom) * dpr }, over.width, over.height, antsPhase);
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
      // only where the text was and is now is drawn again (typing on a big photo stays quick)
      const r0 = doc.movedArea(l);
      l.text = { ...l.text, content: ta.value };
      l.name = ta.value.split('\n')[0].slice(0, 30) || '텍스트';
      l.rev++;
      const r1 = doc.movedArea(l);
      const area = r0 && r1 && (r0.w > 0 ? (r1.w > 0 ? unionRect(r0, r1) : r0) : r1);
      doc.touch(l, area && area.w > 0 && doc.ancestors(l).every((a) => !a.fx || !Object.values(a.fx).some((f) => f?.enabled)) ? area : null);
      P.redraw();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        finishText();
      }
    });
    textBox2.replaceChildren(h('div.ph-tehead', h('span', '글자 입력'), h('button.small', { title: '특수 문자 (글리프)', onclick: () => P.toggleGlyphs?.(ta) }, '기호'), h('button.primary.small', { onclick: () => finishText() }, '완료')), ta, h('div.note', 'Ctrl+Enter 또는 Esc로 마칩니다. 글꼴·크기·색은 위 옵션 막대나 속성 패널에서 바꿉니다.'));
    textBox2.hidden = false;
    placeTextBox();
    setTimeout(() => ta.focus(), 0);
    P.redraw();
  };
  function placeTextBox() {
    const t = P.editingText;
    if (!t) return;
    const b = textBox(t.layer);
    const flip = !!P.doc?.view?.flip;
    let [x, y] = P.toScreen(t.layer.x + (flip ? b.w : 0), t.layer.y + b.h);
    const r = stage.getBoundingClientRect();
    // a mirrored view (View ▸ Flip Horizontal): the box's left edge is the layer's right one
    if (flip) x = r.width - x;
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
  /** Transform a layer by a doc-space affine M (Transform Again, actions). Raw: inside a run. */
  P.transformLayerBy = (l, M, inGroup = false) => {
    const doc = P.doc;
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
      const w = l.smart.warp;
      l.smart = { ...l.smart, m: composeM(M, l.smart.m), corners: l.smart.corners?.map((q) => applyM(M, q)) || null, warp: w?.ctrl ? { ...w, ctrl: w.ctrl.map((q) => applyM(M, q)) } : w };
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
    } else if (l.kind === 'group' && !inGroup) {
      // everything inside comes along (groups inside only turn their masks: their layers are listed too)
      for (const d of doc.descendants(l.id)) P.transformLayerBy(d, M, true);
    }
    // linked masks come along (outside the old mask stays as its edge says: white shows, black hides)
    transformMasksBy(doc, l, M);
    l._styled = null;
    doc.touch(l);
  };
  const transformable = (l) => l && l.kind !== 'adjust' && l.kind !== 'fill' && !l.locked && !l.lockPos;
  /** Edit ▸ Transform ▸ Again: repeat the last (affine) transform on the picked layers. */
  P.cmd.transformAgain = (M = P.lastTransform, label = '다시 변형') => {
    const doc = P.doc;
    const ls = doc?.selectedLayers.filter(transformable) || [];
    if (!Array.isArray(M)) M = P.lastTransform;
    if (!M) return toast('다시 할 변형이 없습니다 (먼저 자유 변형을 한 번 적용하세요)');
    if (!ls.length) return toast('변형할 레이어를 고르세요 (잠긴 레이어·칠·조정 레이어는 안 됩니다)');
    P.run(typeof label === 'string' ? label : '다시 변형', () => {
      for (const l of ls) P.transformLayerBy(l, M);
    });
    return undefined;
  };
  // Ctrl+Alt+T (transform a copy) and Ctrl+Alt+Shift+T (again, on a copy): transform2.js

  // ---------------------------------------------------------------- pointer input

  let hover = null;
  let active = null; // 'tool' | 'pan' | 'transform' | 'pinch'
  let panStart = null;
  const touches = new Map();
  let spaceDown = false;
  // a tool key held down (spring-loaded tool): the tool to go back to when it is let go
  let spring = null;
  // selection, crop and shape tools snap to guides, the grid and the canvas edges (view2.js)
  const snap = (p) => (P.snapPoint ? P.snapPoint(p, P.tool) : p);

  function updateCursor(e) {
    const t = TOOL_BY_ID[P.tool];
    // Space + Ctrl (⌘): zoom in, Space + Alt: zoom out (Photoshop)
    const z = spaceDown && e ? (e.ctrlKey || e.metaKey ? 'zoom-in' : e.altKey ? 'zoom-out' : null) : null;
    stage.style.cursor = z || (spaceDown ? 'grab' : t.cursor === 'brush' ? 'crosshair' : t.cursor || 'default');
  }
  /** One step of the zoom levels, keeping the point under (cx, cy) in place. */
  const zoomStepAt = (dir, cx, cy) => {
    const z = P.view.zoom;
    const next = dir > 0 ? ZOOMS.find((x) => x > z * 1.001) : [...ZOOMS].reverse().find((x) => x < z / 1.001);
    P.setZoom(next ?? z, cx, cy);
  };

  stage.addEventListener('pointerdown', (e) => {
    if (!P.doc || e.button === 2) return;
    closeMenus();
    stage.setPointerCapture(e.pointerId);
    if (spring) spring.used = true;
    if (spaceDown && e.button === 0 && (e.ctrlKey || e.metaKey || e.altKey)) {
      // Space + Ctrl: click to zoom in, drag sideways to zoom smoothly; Space + Alt: zoom out
      active = 'zoomdrag';
      panStart = { x: e.clientX, y: e.clientY, zoom: P.view.zoom, out: e.altKey && !(e.ctrlKey || e.metaKey), moved: false };
      return;
    }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // second finger: cancel what the first one started and pinch/pan instead
        if (active === 'tool') TOOL_BY_ID[P.tool].cancel?.(P);
        if (active === 'transform') P.transform?.up();
        if (active === 'extras') P.viewExtrasCancel?.();
        if (active === 'xdrag') P.xdragCancel?.();
        const [a, b] = [...touches.values()];
        active = 'pinch';
        panStart = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: P.view.zoom, vx: P.view.x, vy: P.view.y };
        return;
      }
      if (touches.size > 2) return;
    }
    const p = P.toDoc(e.clientX, e.clientY);
    P.lastPoint = p;
    // a dialog hidden to look at its preview (창 숨기기): the picture only pans and zooms
    const peeking = document.body.classList.contains('modal-peeking');
    if (!spaceDown && !peeking && e.button === 0 && !P.transform && P.viewExtrasDown?.(e, p)) {
      active = 'extras';
      return;
    }
    if (e.button === 1 || spaceDown || peeking || (P.tool === 'hand' && !P.transform)) {
      active = 'pan';
      panStart = { x: e.clientX, y: e.clientY, vx: P.view.x, vy: P.view.y };
      stage.style.cursor = 'grabbing';
      return;
    }
    if (P.editingText && !['text', 'verticalText', 'textMask', 'verticalTextMask'].includes(P.tool)) finishText();
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
    // the move tool's transform handles (Show Transform Controls) start a free transform
    if (TOOL_BY_ID[P.tool].grab?.(P, p, e)) {
      active = 'transform';
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
      const zoom = clamp((panStart.zoom * d) / Math.max(1, panStart.d), 0.01, 64);
      // keep the point between the fingers under the fingers
      const [sx, sy] = logical(panStart.mx, panStart.my);
      const [nx, ny] = logical(mx, my);
      const docX = (sx - panStart.vx) / panStart.zoom;
      const docY = (sy - panStart.vy) / panStart.zoom;
      P.doc.view = { zoom, x: nx - docX * zoom, y: ny - docY * zoom, fitted: true, rot: P.doc.view.rot || 0, flip: !!P.doc.view.flip };
      P.viewChanged();
      return;
    }
    if (active === 'pan') {
      P.doc.view.auto = false;
      const [dx, dy] = logicalDelta(e.clientX - panStart.x, e.clientY - panStart.y);
      P.doc.view.x = panStart.vx + dx;
      P.doc.view.y = panStart.vy + dy;
      P.viewChanged();
      return;
    }
    if (active === 'zoomdrag') {
      const dx = e.clientX - panStart.x;
      if (Math.abs(dx) > 3) panStart.moved = true;
      if (panStart.moved) P.setZoom(panStart.zoom * Math.exp(dx * 0.01), panStart.x, panStart.y);
      return;
    }
    if (active === 'xdrag') {
      P.xdragMove?.(e);
      return;
    }
    if (active === 'transform') {
      P.transform.move(p, e);
      return;
    }
    if (active === 'tool') {
      const t = TOOL_BY_ID[P.tool];
      // the move tool dragged onto another document's tab: the layers go over there (core2.js)
      if (P.tool === 'move' && P.xdragStart?.(e)) {
        active = 'xdrag';
        return;
      }
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
    else if (active === 'transform') {
      P.transform?.up();
      // started from the move tool's handles: done when the handle is let go (like Canva)
      if (P.transform?.autoCommit) P.applyTransform();
    } else if (active === 'extras') P.viewExtrasUp(e, p);
    else if (active === 'zoomdrag' && !panStart.moved) zoomStepAt(panStart.out ? -1 : 1, e.clientX, e.clientY);
    else if (active === 'xdrag') P.xdragDrop?.(e);
    P.clearSnapMark?.();
    active = null;
    updateCursor(e);
    P.redraw();
    // a spring-loaded tool let go of during the drag goes back now
    if (spring?.release) springBack();
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', (e) => {
    if (active === 'tool') TOOL_BY_ID[P.tool].cancel?.(P);
    if (active === 'xdrag') P.xdragCancel?.();
    if (active === 'extras') P.viewExtrasCancel?.();
    touches.delete(e.pointerId);
    active = null;
    if (spring?.release) springBack();
  });
  stage.addEventListener('pointerleave', () => {
    hover = null;
    P.redraw();
  });
  stage.addEventListener('dblclick', (e) => {
    if (!P.doc) return;
    // on a ruler: Preferences ▸ Units & Rulers
    if (P.viewExtrasDblclick?.(e)) return;
    if (P.transform) {
      P.applyTransform();
      return;
    }
    TOOL_BY_ID[P.tool].dblclick?.(P, P.toDoc(e.clientX, e.clientY), e);
  });
  stage.addEventListener('wheel', (e) => {
    if (!P.doc) return;
    e.preventDefault();
    // Preferences ▸ zoom with the scroll wheel (then Shift scrolls sideways)
    if (P.prefs.wheelZoom && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) P.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    else if (e.ctrlKey || e.metaKey || e.altKey) P.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.002)), e.clientX, e.clientY);
    else {
      P.doc.view.auto = false;
      // Shift: sideways (macOS already turns Shift+wheel into a sideways scroll)
      const [dx, dy] = logicalDelta(e.shiftKey ? e.deltaY || e.deltaX : e.deltaX, e.shiftKey ? 0 : e.deltaY);
      P.doc.view.x -= dx;
      P.doc.view.y -= dy;
      P.viewChanged();
    }
  }, { passive: false });
  stage.addEventListener('contextmenu', (e) => {
    if (!P.doc) return;
    // on a ruler: its units
    if (P.viewExtrasContext?.(e)) return;
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
    // onto a frame (frame tool): the picture goes into it; Shift: as new layers
    const at = P.doc ? P.toDoc(e.clientX, e.clientY) : null;
    const frame = at && P.frameAt?.(at);
    if (P.doc && (e.shiftKey || frame)) P.cmd.placeFiles(files, { frame });
    else P.openFiles(files);
  }, true);
  new ResizeObserver(() => {
    stageBox = null;
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
    const alt = e.altKey;
    const sh = e.shiftKey;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (P.viewKeys?.(e, mod)) return done();
    if (k === 'Space') {
      // Space: hand tool while held; with Ctrl (⌘) or Alt the zoom tool (in / out)
      if (!e.repeat) {
        spaceDown = true;
        updateCursor(e);
      }
      done();
      return;
    }
    if (spaceDown && /^(Control|Alt|Meta)/.test(k)) updateCursor(e);
    if (P.transform) {
      if (e.key === 'Enter') return done(), P.applyTransform();
      if (e.key === 'Escape') return done(), P.cancelTransform();
    }
    if (!mod && P.doc && TOOL_BY_ID[P.tool].onKey?.(P, e) === true) return done();
    // a tool key held down repeats: the tool stays (Shift would otherwise race through the family)
    if (e.repeat && !mod && !alt && /^Key[A-Z]$/.test(k)) return done();
    const C = P.cmd;
    // (Alt+letter is not a tool key in Photoshop)
    const tool = (letter) => (alt ? null : cycleKey(letter, sh));
    const filter = (id) => (FILTERS[id] ? D.filterDialog(P, id) : null);
    const map = {
      KeyZ: () => (mod ? (alt && !sh ? C.toggleLastState() : sh ? P.redo() : P.undo()) : tool('Z')),
      KeyY: () => (mod ? (sh ? C.gamutWarning?.() : C.proofColors ? C.proofColors() : P.redo()) : tool('Y')),
      KeyA: () => (mod ? (alt ? C.selectAllLayers() : sh ? filter('cameraRaw') : C.selectAll()) : tool('A')),
      KeyP: () => (mod ? (sh || alt ? null : C.print?.()) : tool('P')),
      KeyD: () => (mod ? (sh ? C.reselect() : C.deselect()) : P.defaultColors()),
      KeyI: () => (mod ? (alt && sh ? C.fileInfo?.() : alt ? D.imageSizeDialog(P) : sh ? C.inverse() : D.adjustDialog(P, 'invert')) : tool('I')),
      KeyT: () => (mod ? (alt && sh ? C.transformAgainCopy() : sh ? C.transformAgain() : alt ? C.freeTransformCopy() : C.freeTransform()) : tool('T')),
      KeyJ: () => (mod ? (sh ? C.layerVia(true) : C.duplicateLayer()) : tool('J')),
      KeyE: () => (mod ? (sh && alt ? C.stampVisible() : sh ? C.mergeVisible() : C.mergeDown()) : tool('E')),
      KeyN: () => (mod ? (sh && alt ? C.newLayer() : sh ? C.newLayerDialog() : D.newDocDialog(P)) : null),
      KeyO: () => (mod ? C.open() : tool('O')),
      KeyK: () => (mod ? (alt && sh ? C.keyboardShortcuts() : C.preferences?.()) : tool('K')),
      KeyS: () => (mod ? (alt && sh ? C.saveForWeb?.() : sh ? C.saveAs() : alt ? C.saveCopy() : C.saveProject()) : tool('S')),
      KeyC: () => (mod ? (alt && sh ? C.contentAwareScale?.() : alt ? D.canvasSizeDialog(P) : C.copy(sh)) : tool('C')),
      KeyX: () => (mod ? (sh ? C.liquify() : C.cut()) : P.swapColors()),
      KeyV: () => (mod ? (sh && alt ? C.pasteInto?.() : sh ? (C.pasteInPlace || C.paste)() : C.paste()) : tool('V')),
      KeyM: () => (mod ? D.adjustDialog(P, 'curves') : tool('M')),
      KeyL: () => (mod ? (sh && alt ? C.autoContrast() : sh ? C.autoTone() : D.adjustDialog(P, 'levels')) : tool('L')),
      KeyU: () => (mod ? (sh ? D.adjustDialog(P, 'desaturate') : D.adjustDialog(P, 'hueSat')) : tool('U')),
      KeyB: () => (mod ? (sh && alt ? D.adjustDialog(P, 'bw') : sh ? C.autoColor() : D.adjustDialog(P, 'colorBalance')) : tool('B')),
      KeyG: () => (mod ? (alt ? C.toggleClip() : sh ? C.ungroup() : C.groupLayers()) : tool('G')),
      KeyF: () => (mod ? (sh ? C.fade() : alt ? D.lastFilterDialog(P) : D.repeatFilter(P)) : null),
      KeyW: () => (mod ? (alt && sh ? (C.exportAs ? C.exportAs() : D.exportDialog(P)) : alt ? C.closeAll() : sh ? null : P.closeDoc()) : tool('W')),
      KeyQ: () => (mod ? null : C.quickMask()),
      KeyH: () => (mod ? null : tool('H')),
      KeyR: () => (mod ? (alt ? C.selectAndMask() : sh ? filter('lensCorrection') : null) : tool('R')),
      Quote: () => (mod && sh ? C.quickExport?.() : null),
      Slash: () => (!mod && !alt && P.doc?.active ? C.lock?.('alpha') : null),
      Comma: () => (mod && !alt ? C.toggleLayerVisibility() : alt && !mod ? selectLayerEnd('bottom') : null),
      Period: () => (alt && !mod ? selectLayerEnd('top') : null),
      Tab: () => (mod ? P.switchDocStep(sh ? -1 : 1) : null),
      F2: () => (!mod && !alt && !sh ? C.cut() : null),
      F3: () => (!mod && !alt && !sh ? C.copy() : null),
      F4: () => (!mod && !alt && !sh ? C.paste() : null),
      F5: () => (mod ? null : sh ? D.fillDialog(P) : C.brushSettings()),
      F6: () => (mod ? P.switchDocStep(sh ? -1 : 1) : sh ? C.feather() : P.showPanel('color')),
      F7: () => (mod ? null : sh ? C.inverse() : P.showPanel('layers')),
      F8: () => (mod || sh ? null : P.showPanel('info')),
      F9: () => (mod || sh ? null : P.showPanel('actions')),
      F12: () => (mod || sh || alt ? null : C.revert()),
      Digit0: () => (mod ? (alt ? P.setZoom(1) : P.fit(true)) : null),
      Digit1: () => (mod ? P.setZoom(1) : null),
      Digit2: () => (mod && alt ? (C.selectLuminosity || C.luminositySelection)() : null),
      Equal: () => (mod ? P.zoomStep(1) : null),
      NumpadAdd: () => (mod ? P.zoomStep(1) : null),
      Minus: () => (mod ? P.zoomStep(-1) : null),
      NumpadSubtract: () => (mod ? P.zoomStep(-1) : null),
      // Ctrl+[ ]: down / up one; Ctrl+Shift+[ ]: to the bottom / top; Alt+[ ]: pick the layer below /
      // above (Shift+Alt: add it to the picked layers); no modifier: brush size (Shift: hardness)
      BracketLeft: () => (mod ? C.arrange(sh ? 'bottom' : -1) : alt ? selectLayerStep(-1, sh) : changeSize(sh ? 'hardness' : 'size', -1)),
      BracketRight: () => (mod ? C.arrange(sh ? 'top' : 1) : alt ? selectLayerStep(1, sh) : changeSize(sh ? 'hardness' : 'size', 1)),
      Delete: () => clearOrDelete(),
      Backspace: () => (P.transform ? null : sh && !mod && !alt ? D.fillDialog(P) : alt && !mod ? P.fill(P.fg, 1, sh) : mod && !alt ? P.fill(P.bg, 1, sh) : clearOrDelete()),
      Enter: () => (mod && P.getPath?.().length ? C.pathToSelection() : P.tool === 'crop' ? TOOL_BY_ID.crop.apply(P) : null),
      Escape: () => (P.tool === 'crop' ? TOOL_BY_ID.crop.activate(P) : null),
      ArrowLeft: () => nudge(-1, 0, sh),
      ArrowRight: () => nudge(1, 0, sh),
      ArrowUp: () => nudge(0, -1, sh),
      ArrowDown: () => nudge(0, 1, sh),
    };
    if (/^Digit[0-9]$/.test(k) && !mod && !alt) {
      const v = k === 'Digit0' ? 100 : +k.slice(5) * 10;
      // painting tools: their own opacity; other tools (move…): the selected layers', like Photoshop
      if (TOOL_BY_ID[P.tool].options.some((o) => o[0] === 'opacity')) {
        P.setOpt(P.tool, 'opacity', v);
        return done();
      }
      const ls = P.doc?.selectedLayers.filter((l) => !l.locked) || [];
      if (ls.length) {
        P.run(`불투명도 ${v}%`, () => {
          for (const l of ls) {
            l.opacity = v / 100;
            P.doc.touch(l);
          }
        });
        toast(`레이어 불투명도 ${v}%`);
        return done();
      }
    }
    const fn = map[k];
    if (!fn || !P.doc && !['KeyN', 'KeyO', 'KeyK', 'F6', 'F7', 'F8', 'F9'].includes(k)) return;
    const before = P.tool;
    const r = fn();
    if (r === null) return;
    done();
    // spring-loaded tools: a tool key held down picks the tool until it is let go
    if (!mod && !alt && /^Key[A-Z]$/.test(k) && P.tool !== before && !spring) spring = { code: k, prev: before, t: performance.now(), used: false, release: false };
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      updateCursor(e);
    } else if (spaceDown) updateCursor(e);
    if (spring && e.code === spring.code) {
      const tag = e.target?.tagName;
      // typing started with the tool (a text box): it stays
      if (P.editingText || tag === 'TEXTAREA' || tag === 'INPUT' || e.target?.isContentEditable) spring = null;
      // held long enough to count as holding (or used while held): back to the tool from before
      else if (spring.used || performance.now() - spring.t > 400) {
        spring.release = true;
        if (!active) springBack();
      } else spring = null;
    }
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    spring = null;
  });
  function springBack() {
    const s = spring;
    spring = null;
    if (s && TOOL_BY_ID[s.prev] && P.tool !== s.prev) P.setTool(s.prev);
  }

  /** A tool key: the family's last used tool, or the next one with Shift (like Photoshop). */
  const lastOfKey = loadPref('photo.toolKeys', {});
  P.on('tool', (id) => {
    const key = TOOL_BY_ID[id]?.key;
    if (key && lastOfKey[key] !== id) {
      lastOfKey[key] = id;
      savePref('photo.toolKeys', lastOfKey);
    }
  });
  function cycleKey(letter, shift) {
    const ids = [];
    for (const id of TOOL_GROUPS.flat()) if (TOOL_BY_ID[id]?.key === letter && !ids.includes(id)) ids.push(id);
    for (const t of TOOLS) if (t.key === letter && !ids.includes(t.id)) ids.push(t.id);
    if (!ids.length) return null;
    const i = ids.indexOf(P.tool);
    if (i >= 0) {
      if (shift) P.setTool(ids[(i + 1) % ids.length]);
      return undefined;
    }
    P.setTool(ids.includes(lastOfKey[letter]) ? lastOfKey[letter] : ids[0]);
    return undefined;
  }
  /** Delete / Backspace: clear the selected pixels, or delete the picked layers when nothing is selected. */
  function clearOrDelete() {
    const doc = P.doc;
    if (!doc || P.transform) return null;
    if (doc.selection || doc.quickMask) return P.cmd.clear();
    if (!doc.active) return undefined;
    if (doc.layers.length <= 1) return void toast('마지막 레이어는 지울 수 없습니다');
    return P.cmd.deleteLayer();
  }
  /** Alt+[ / ]: the layer below / above in the layers panel (Shift: add it to the picked layers). */
  function panelOrder() {
    const doc = P.doc;
    const out = [];
    const walk = (pid) => {
      const kids = doc.children(pid);
      for (let i = kids.length - 1; i >= 0; i--) {
        out.push(kids[i]);
        if (kids[i].kind === 'group' && !kids[i].collapsed) walk(kids[i].id);
      }
    };
    walk(null);
    return out;
  }
  function selectLayerStep(dir, add) {
    const doc = P.doc;
    if (!doc?.active) return undefined;
    const rows = panelOrder();
    const i = rows.indexOf(doc.active);
    // [ goes down the panel (towards the bottom of the stack), ] goes up
    const next = rows[i < 0 ? 0 : i - dir];
    if (!next) return undefined;
    if (add) {
      const ids = new Set([...doc.selectedLayers.map((l) => l.id), next.id]);
      P.selectLayer(next.id);
      doc.selectedIds = [...ids];
      P.emit('layers');
    } else P.selectLayer(next.id);
    return undefined;
  }
  function selectLayerEnd(where) {
    const rows = P.doc ? panelOrder() : [];
    const l = where === 'top' ? rows[0] : rows[rows.length - 1];
    if (l) P.selectLayer(l.id);
    return undefined;
  }
  /** Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+F6): the next / previous open document. */
  P.switchDocStep = (dir) => {
    if (P.docs.length < 2) return undefined;
    P.switchDoc((P.index + dir + P.docs.length) % P.docs.length);
    return undefined;
  };

  function changeSize(key, dir) {
    const t = TOOL_BY_ID[P.tool];
    if (!t.options.some((o) => o[0] === key)) return null;
    const o = P.opts(P.tool);
    const v = o[key];
    // Photoshop's steps: the size by 1 px under 10, 10 px up to 100, then 25, 50, 100 and 250 px;
    // the hardness (Shift) by 25%
    const stepAt = (x) => (key !== 'size' ? 25 : x < 10 ? 1 : x < 100 ? 10 : x < 200 ? 25 : x < 300 ? 50 : x < 1000 ? 100 : 250);
    const s = stepAt(dir > 0 ? v : v - 1);
    const max = t.options.find((x) => x[0] === key)?.[4] ?? 100;
    const nv = clamp(dir > 0 ? Math.floor(v / s) * s + s : Math.ceil(v / s) * s - s, key === 'size' ? 1 : 0, max);
    P.setOpt(P.tool, key, nv);
    return undefined;
  }
  // arrow keys with the move tool: 1 pixel, 10 with Shift; the selected layers move like a drag
  function nudge(dx, dy, big) {
    const doc = P.doc;
    if (P.tool !== 'move' || !doc?.active) return null;
    const k = big ? 10 : 1;
    const layers = doc.selectedLayers.filter((x) => x.kind !== 'adjust' || x.mask);
    if (!layers.length) return undefined;
    if (layers.some((x) => x.locked || x.lockPos)) {
      P.toast('위치가 잠긴 레이어가 있습니다 (레이어 패널에서 잠금 해제)');
      return undefined;
    }
    const before = doc.capture();
    doc.translateLayers(layers, dx * k, dy * k);
    P.commit('이동', before, { touched: true });
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
  installTools3(P);
  installEdit2(P);
  installExtra3(P);
  installViewExtras(P, { stage });
  installView3(P);
  installTypeCommands(P, PT);
  installPhotoAI(P);
  P.cmd.filterGallery = () => filterGalleryDialog(P);
  installImage2(P);
  // artboards: the Artboard tool, Layer ▸ New ▸ 대지…, export per artboard (artboards.js)
  installArtboards(P);
  // Filter menu and Image ▸ Adjustments order, filter shortcuts, Image Size resampling (filtermenu.js)
  installFilters(P);
  // workspaces, document arrangement, copying layers between documents, Save As, New Layer dialog,
  // shortcuts list, history options (core2.js)
  installCore2(P, { stage, center, tabs, side, toolbar, opts, strip, dock, panels, finishText });
  // Window ▸ Learn: hands-on practice lessons (learn.js)
  installLearn(P);
  installActions(P); // last: it wraps every command so it can record them
  // interface colour themes (after view2.js, which sets the first P.viewKeys)
  installTheme(P);
  if (TOOL_BY_ID[savedTool]) P.tool = savedTool;
  else savePref('photo.tool', P.tool);
  P.emit('tool', P.tool);
  P.emit('channels');
  P.warpText = () => warpTextDialog(P);
  P.menus = buildMenus(P);
  for (const extend of P.extendMenus || []) extend();
  // last: items other modules added go where Photoshop has them (File ▸ Export…)
  arrangeMenus(P);
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
    saveTimer = null;
    if (P.prefs.autosave === false) return;
    saveTimer = setTimeout(() => P.saveNow(), 2500);
  }
  P.scheduleSave = scheduleSave;
  /** Save the open documents to this browser now (also when the page is hidden or closed). */
  P.saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (P.prefs.autosave === false) return Promise.resolve();
    return IO.saveSession(P.docs, P.index).then(() => P.emit('saved')).catch((err) => console.warn('photo autosave failed', err));
  };
  // edits made in the last moments before the tab closes (or the phone switches apps) are kept too
  const saveIfWaiting = () => { if (saveTimer) P.saveNow(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveIfWaiting(); });
  window.addEventListener('pagehide', saveIfWaiting);
  window.addEventListener('beforeunload', saveIfWaiting);
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

  // a part of the document changed outside an edit (a font arrived): redraw what doc.touch marked
  window.addEventListener('photo:repaint', () => P.redraw());
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
  C.placeFiles = async (files, { frame = null } = {}) => {
    if (!need()) return;
    for (const f of files) {
      try {
        const c = f.name.toLowerCase().endsWith('.psd') ? (await IO.openFile(f)).flatten() : await IO.canvasFromFile(f);
        if (frame && P.doc.layer(frame.id)) {
          P.run('프레임에 이미지 넣기', () => P.placeInFrame(frame, c, f.name.replace(/\.[^.]+$/, '')));
          frame = null;
          continue;
        }
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
    const r = document.querySelector('.ph-home-video')?.getBoundingClientRect() || { left: 40, bottom: 120 };
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
          doc.openState = doc.capture();
          P.renderTabs();
          P.emit('docsaved', doc);
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
      doc.openState = doc.capture();
      P.renderTabs();
      P.emit('docsaved', doc);
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
    P.clipboard = { canvas: out, x: b.x, y: b.y, docId: doc.id };
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
  // like Photoshop: Paste centres the picture on the selection, or on the canvas when it came from
  // another photo; from the same photo (and with Paste in Place) it lands where it was copied
  C.paste = (inPlace = false) => {
    if (!need()) return;
    const cb = P.clipboard;
    if (!cb) return toast('붙여 넣을 내용이 없습니다 (다른 프로그램의 이미지는 Ctrl+V로 바로 붙여 넣을 수 있습니다)');
    const doc = P.doc;
    const sb = !inPlace && doc.selection ? SEL.alphaBounds(doc.selection.canvas) : null;
    const centre = sb ? [sb.x + sb.w / 2, sb.y + sb.h / 2] : !inPlace && cb.docId && cb.docId !== doc.id ? [doc.width / 2, doc.height / 2] : null;
    P.run('붙여넣기', () => {
      const l = newLayer('raster', { name: P.doc.nextLayerName(), canvas: cloneCanvas(cb.canvas) });
      l.x = centre ? Math.round(centre[0] - cb.canvas.width / 2) : cb.x;
      l.y = centre ? Math.round(centre[1] - cb.canvas.height / 2) : cb.y;
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
  /** Fill the selection (or the layer) with a colour; `preserve`: keep transparent pixels as they are. */
  P.fill = (color, opacity = 1, preserve = false) => {
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
      fillTo(g, l.x, l.y, l.lockAlpha || preserve);
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
        // the linked masks turn the same way, about the same middle
        const R = { cw: [0, 1, -1, 0], ccw: [0, -1, 1, 0], 180: [-1, 0, 0, -1], flipH: [-1, 0, 0, 1], flipV: [1, 0, 0, -1] }[kind];
        if (R) {
          const [ox, oy] = [ob.x + ob.w / 2, ob.y + ob.h / 2];
          transformMasksBy(doc, l, [...R, l.x + out.width / 2 - (R[0] * ox + R[2] * oy), l.y + out.height / 2 - (R[1] * ox + R[3] * oy)]);
        }
      } else {
        const a = kind === 'cw' ? 90 : kind === 'ccw' ? -90 : kind === '180' ? 180 : 0;
        l.rotation = ((l.rotation || 0) + a) % 360;
        if (kind.startsWith('flip')) toast('글자·모양 레이어는 뒤집을 수 없어 회전만 됩니다 (래스터화하면 가능)');
        const b = a && doc.bounds(l);
        if (b) {
          const t = (a * Math.PI) / 180;
          const [c, s] = [Math.round(Math.cos(t)), Math.round(Math.sin(t))];
          const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
          transformMasksBy(doc, l, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
        }
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
        if (l.artboard) l.artboard = { ...l.artboard, x: l.artboard.x - r.x, y: l.artboard.y - r.y };
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
      // masks are kept doc-size (new canvas around a white mask shows, as its edge says)
      for (const l of doc.layers) {
        if (l.mask) l.mask = { ...l.mask, canvas: mapMaskCanvas(l.mask, [1, 0, 0, 1, 0, 0], r.w, r.h), x: 0, y: 0 };
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
        else if (l.kind === 'smart' && l.smart) {
          // a smart object is placed by a matrix (and maybe corners or a warp) in document space
          const { m, corners, warp } = l.smart;
          const sc = ([x, y]) => [x * kx, y * ky];
          l.smart = { ...l.smart, m: [m[0] * kx, m[1] * ky, m[2] * kx, m[3] * ky, m[4] * kx, m[5] * ky], corners: corners?.map(sc) || corners, warp: warp?.ctrl ? { ...warp, ctrl: warp.ctrl.map(sc) } : warp };
        }
        l.x = Math.round(l.x * kx);
        l.y = Math.round(l.y * ky);
        if (l.artboard) { const a = l.artboard; l.artboard = { ...a, x: Math.round(a.x * kx), y: Math.round(a.y * ky), w: Math.max(1, Math.round(a.w * kx)), h: Math.max(1, Math.round(a.h * ky)) }; }
        // layer masks, vector masks and smart filter masks scale with the picture
        transformMasksBy(doc, l, [kx, 0, 0, ky, 0, 0], { all: true, W, H });
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
        } else if (l.kind === 'smart' && l.smart) {
          // smart objects turn with the canvas through their placement matrix
          const M = { cw: [0, 1, -1, 0, H, 0], ccw: [0, -1, 1, 0, 0, W], 180: [-1, 0, 0, -1, W, H], flipH: [-1, 0, 0, 1, W, 0], flipV: [1, 0, 0, -1, 0, H] }[kind];
          const s = l.smart;
          if (M) l.smart = { ...s, m: composeM(M, s.m), corners: s.corners?.map((q) => applyM(M, q)) || s.corners, warp: s.warp?.ctrl ? { ...s.warp, ctrl: s.warp.ctrl.map((q) => applyM(M, q)) } : s.warp };
        }
        // every mask turns with the canvas (layer, vector and smart filter masks)
        transformMasksBy(doc, l, { cw: [0, 1, -1, 0, H, 0], ccw: [0, -1, 1, 0, 0, W], 180: [-1, 0, 0, -1, W, H], flipH: [-1, 0, 0, 1, W, 0], flipV: [1, 0, 0, -1, 0, H] }[kind], { all: true, W: rot ? H : W, H: rot ? W : H });
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
  /** A selection change by a number of pixels: asked for when not given (actions replay the value). */
  const selModify = async (label, fn, def, value, again) => {
    if (!P.doc?.selection) return toast('먼저 선택 영역을 만드세요');
    if (value === undefined) {
      const v = await promptDialog(label, '픽셀', String(def));
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      // through the command again, so an action being recorded keeps the value
      return again(n);
    }
    const n = +value;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    P.run(label, () => { P.doc.selection = fn(n); });
    return undefined;
  };
  C.feather = (value) => selModify('페더', (n) => SEL.feather(P.doc, n), 10, value, (n) => P.cmd.feather(n));
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
  const noSel = () => !P.doc?.selection;
  const ell = (name, more) => (more && !name.endsWith('…') ? `${name}…` : name);
  const ADJ_KEYS = { levels: `${mod}L`, curves: `${mod}M`, hueSat: `${mod}U`, colorBalance: `${mod}B`, bw: `${mod}Alt+Shift+B`, invert: `${mod}I`, desaturate: `${mod}Shift+U` };
  const adjustItems = () => [
    ...Object.entries(ADJUSTMENTS).map(([k, a]) => ({ label: ell(a.name, a.params.length), key: ADJ_KEYS[k], disabled: no(), action: () => D.adjustDialog(P, k) })),
    // Photoshop keeps Match Color with the adjustments
    ...(C.matchColor ? ['-', { label: '색상 일치…', disabled: no(), action: () => C.matchColor() }] : []),
  ];
  const filterGroups = () => {
    const groups = {};
    // the filter gallery's own effects live in the gallery (like Photoshop's default menu)
    for (const [id, f] of Object.entries(FILTERS)) if (!f.gallery && !f.hidden) (groups[f.group] ||= []).push({ label: ell(f.name, f.params.length), disabled: no(), action: () => D.filterDialog(P, id) });
    // a group of one (Camera Raw) is a plain item, like Photoshop's
    return Object.entries(groups).map(([g, items]) => (items.length === 1 ? items[0] : { label: g, submenu: items }));
  };
  const hist = () => P.doc?.history;
  return {
    '파일': () => [
      { label: '새로 만들기…', key: `${mod}N`, action: () => D.newDocDialog(P) },
      { label: '열기… (사진·PSD·Montage 사진 파일)', key: `${mod}O`, action: () => C.open() },
      recentMenu(P),
      { label: '영상 프로젝트의 이미지 열기', action: () => C.openFromVideo() },
      '-',
      { label: '닫기', disabled: no(), action: () => P.closeDoc() },
      { label: '모두 닫기', key: `${mod}Alt+W`, disabled: no(), action: () => C.closeAll() },
      { label: '기타 항목 닫기', disabled: P.docs.length < 2, action: () => C.closeOthers() },
      '-',
      { label: '저장 (Montage 사진 파일 .mphoto)', key: `${mod}S`, disabled: no(), action: () => C.saveProject() },
      { label: '다른 이름으로 저장…', key: `${mod}Shift+S`, disabled: no(), action: () => C.saveAs() },
      { label: '사본 저장…', key: `${mod}Alt+S`, disabled: no(), action: () => C.saveCopy() },
      { label: 'PSD로 저장 (포토샵 파일)', disabled: no(), action: () => C.savePsd() },
      { label: 'PSD로 저장 (글자·모양을 포토샵에서 고칠 수 있게, 실험적)', disabled: no(), action: () => C.savePsd({ editableText: true }) },
      { label: '되돌리기', key: 'F12', disabled: no() || !P.doc?.openState, action: () => C.revert() },
      '-',
      { label: '내보내기 (PNG · JPG · WebP)…', key: `${mod}Shift+Alt+W`, disabled: no(), action: () => D.exportDialog(P) },
      { label: '레이어를 파일로 내보내기 (PNG)…', disabled: no(), action: () => C.exportLayers() },
      '-',
      { label: '포함 가져오기 (고급 개체)…', disabled: no(), action: () => C.placeEmbedded() },
      { label: '가져오기 (새 픽셀 레이어로)…', disabled: no(), action: () => C.place() },
      '-',
      // (the Actions panel itself is under Window ▸ 액션, Alt+F9)
      { label: '자동화', submenu: [{ label: '일괄 처리… (여러 사진에 액션)', action: () => C.batch() }] },
      '-',
      { label: '영상 편집으로 보내기…', disabled: no(), action: () => D.sendToVideoDialog(P) },
    ],
    '편집': () => [
      { label: `실행 취소${hist()?.undoStack.length ? `: ${hist().undoStack.at(-1).label}` : ''}`, key: `${mod}Z`, disabled: !hist()?.undoStack.length, action: () => P.undo() },
      { label: `다시 실행${hist()?.redoStack.length ? `: ${hist().redoStack.at(-1).label}` : ''}`, key: `${mod}Shift+Z`, disabled: !hist()?.redoStack.length, action: () => P.redo() },
      { label: '마지막 상태 전환', key: `${mod}Alt+Z`, disabled: !hist()?.undoStack.length && !hist()?.redoStack.length, action: () => C.toggleLastState() },
      '-',
      { label: '희미하게 하기… (마지막 작업)', key: `${mod}Shift+F`, disabled: no(), action: () => C.fade() },
      '-',
      { label: '잘라내기', key: `${mod}X`, disabled: no(), action: () => C.cut() },
      { label: '복사', key: `${mod}C`, disabled: no(), action: () => C.copy() },
      { label: '병합하여 복사', key: `${mod}Shift+C`, disabled: no(), action: () => C.copy(true) },
      { label: '붙여넣기', key: `${mod}V`, disabled: no(), action: () => C.paste() },
      { label: '지우기', key: 'Delete', disabled: no() || noSel(), action: () => C.clear() },
      '-',
      { label: '텍스트 찾기 / 바꾸기…', disabled: no(), action: () => C.findReplace() },
      '-',
      { label: '칠…', key: 'Shift+F5', disabled: no(), action: () => D.fillDialog(P) },
      { label: '획…', disabled: no(), action: () => D.strokeDialog(P) },
      { label: '내용 인식 채우기…', disabled: no() || noSel(), action: () => (C.contentAwareFillWorkspace || C.contentAwareFill)() },
      '-',
      { label: '내용 인식 비율', key: `${mod}Alt+Shift+C`, disabled: no(), action: () => C.contentAwareScale() },
      { label: '퍼펫 뒤틀기', disabled: no(), action: () => C.puppetWarp() },
      { label: '자유 변형', key: `${mod}T`, disabled: no(), action: () => C.freeTransform() },
      { label: '변형', disabled: no(), submenu: [
        { label: '다시', key: `${mod}Shift+T`, disabled: !P.lastTransform, action: () => C.transformAgain() },
        { label: '복사본을 다시 변형', key: `${mod}Alt+Shift+T`, disabled: !P.lastTransform, action: () => C.transformAgainCopy() },
        { label: '복사본 자유 변형', key: `${mod}Alt+T`, action: () => C.freeTransformCopy() },
        '-',
        { label: '비율', action: () => C.freeTransform('free') },
        { label: '회전', action: () => C.freeTransform('free') },
        { label: '기울이기', action: () => C.freeTransform('skew') },
        { label: '왜곡', action: () => C.freeTransform('distort') },
        { label: '원근', action: () => C.freeTransform('perspective') },
        '-',
        { label: '뒤틀기', action: () => C.freeTransform('warp') },
        '-',
        { label: '180° 회전', action: () => C.transformLayer('180') },
        { label: '시계 방향으로 90° 회전', action: () => C.transformLayer('cw') },
        { label: '반시계 방향으로 90° 회전', action: () => C.transformLayer('ccw') },
        '-',
        { label: '가로로 뒤집기', action: () => C.transformLayer('flipH') },
        { label: '세로로 뒤집기', action: () => C.transformLayer('flipV') },
      ] },
      '-',
      { label: '하늘 대체…', disabled: no(), action: () => C.skyReplacement() },
      '-',
      { label: '브러시 사전 설정 정의… (선택 영역의 어두운 부분)', disabled: no(), action: () => C.defineBrush() },
      { label: '패턴 정의… (선택 영역 또는 전체)', disabled: no(), action: () => C.definePattern() },
      '-',
      { label: '바로 가기 키…', key: `${mod}Alt+Shift+K`, action: () => C.keyboardShortcuts() },
      { label: '환경 설정', submenu: [
        { label: '일반…', key: `${mod}K`, action: () => C.preferences() },
        { label: '성능 (작업 내역 · 메모리)…', action: () => C.preferences('perf') },
        { label: '커서…', action: () => C.preferences('cursor') },
        { label: '투명도…', action: () => C.preferences('transparency') },
        { label: '단위와 눈금자…', action: () => C.preferences('units') },
        { label: '안내선, 격자 및 분할 영역…', action: () => C.preferences('guides') },
      ] },
    ],
    '이미지': () => [
      { label: '모드', disabled: no(), submenu: [{ label: 'RGB 색상', checked: !P.doc?.mode || P.doc.mode === 'rgb', action: () => C.rgbMode() }, { label: '회색 음영', checked: P.doc?.mode === 'gray', action: () => C.grayscale() }] },
      '-',
      { label: '조정', disabled: no(), submenu: adjustItems },
      '-',
      { label: '자동 톤', key: `${mod}Shift+L`, disabled: no(), action: () => C.autoTone() },
      { label: '자동 대비', key: `${mod}Alt+Shift+L`, disabled: no(), action: () => C.autoContrast() },
      { label: '자동 색상', key: `${mod}Shift+B`, disabled: no(), action: () => C.autoColor() },
      '-',
      { label: '이미지 크기…', key: `${mod}Alt+I`, disabled: no(), action: () => D.imageSizeDialog(P) },
      { label: '캔버스 크기…', key: `${mod}Alt+C`, disabled: no(), action: () => D.canvasSizeDialog(P) },
      { label: '이미지 회전', disabled: no(), submenu: [
        { label: '180°', action: () => C.rotateCanvas('180') },
        { label: '시계 방향으로 90°', action: () => C.rotateCanvas('cw') },
        { label: '반시계 방향으로 90°', action: () => C.rotateCanvas('ccw') },
        '-',
        { label: '캔버스 가로로 뒤집기', action: () => C.rotateCanvas('flipH') },
        { label: '캔버스 세로로 뒤집기', action: () => C.rotateCanvas('flipV') },
      ] },
      { label: '자르기 (선택 영역으로)', disabled: no() || noSel(), action: () => C.cropToSelection() },
      { label: '재단…', disabled: no(), action: () => C.trimDialog() },
      { label: '모두 나타내기', disabled: no(), action: () => C.revealAll() },
      '-',
      { label: '복제…', disabled: no(), action: () => C.duplicateDoc() },
    ],
    '레이어': () => layerMenuItems(P, mod),
    // Photoshop's Type menu; modules add to it through P.extendMenus
    '문자': () => [
      { label: '패널', submenu: [{ label: '문자 · 단락 패널', action: () => P.showPanel('char') }, { label: '글리프 패널', action: () => P.showPanel('glyphs') }] },
      '-',
      { label: '텍스트 뒤틀기…', disabled: P.doc?.active?.kind !== 'text', action: () => P.warpText() },
      { label: '작업 패스 만들기', disabled: P.doc?.active?.kind !== 'text', action: () => C.textToPath?.() },
      { label: '모양으로 변환', disabled: P.doc?.active?.kind !== 'text', action: () => C.textToShape?.() },
      { label: '문자 레이어 래스터화', disabled: P.doc?.active?.kind !== 'text', action: () => C.rasterize('layer') },
      '-',
      { label: '텍스트 찾기 / 바꾸기…', disabled: no(), action: () => C.findReplace() },
    ],
    '선택': () => [
      { label: '모두', key: `${mod}A`, disabled: no(), action: () => C.selectAll() },
      { label: '선택 해제', key: `${mod}D`, disabled: noSel(), action: () => C.deselect() },
      { label: '다시 선택', key: `${mod}Shift+D`, disabled: !P.doc?.lastSelection, action: () => C.reselect() },
      { label: '반전', key: `${mod}Shift+I`, disabled: no(), action: () => C.inverse() },
      '-',
      { label: '모든 레이어', key: `${mod}Alt+A`, disabled: no(), action: () => C.selectAllLayers() },
      { label: '레이어 선택 해제', disabled: no(), action: () => C.deselectLayers() },
      { label: '레이어 찾기', key: `${mod}Alt+Shift+F`, disabled: no(), action: () => P.focusLayerFilter?.() },
      '-',
      { label: '색상 범위…', disabled: no(), action: () => C.colorRange() },
      { label: '초점 영역…', disabled: no(), action: () => C.focusArea() },
      { label: '피사체', disabled: no(), action: () => C.selectSubject() },
      { label: '하늘', disabled: no(), action: () => C.selectSky() },
      '-',
      { label: '선택 및 마스크…', key: `${mod}Alt+R`, disabled: no(), action: () => C.selectAndMask() },
      { label: '수정', disabled: noSel(), submenu: [
        { label: '테두리…', action: () => C.border() },
        { label: '매끄럽게…', action: () => C.smooth() },
        { label: '확대…', action: () => C.expand() },
        { label: '축소…', action: () => C.contract() },
        { label: '페더…', key: 'Shift+F6', action: () => C.feather() },
      ] },
      { label: '선택 영역 확장', disabled: noSel(), action: () => C.grow() },
      { label: '유사 영역 선택', disabled: noSel(), action: () => C.similar() },
      '-',
      { label: '선택 영역 변형', disabled: noSel(), action: () => C.transformSelection() },
      '-',
      { label: '빠른 마스크 모드로 편집', key: 'Q', checked: !!P.doc?.quickMask, disabled: no(), action: () => C.quickMask() },
      '-',
      { label: '선택 영역 불러오기…', disabled: no(), action: () => C.loadSelection() },
      { label: '선택 영역 저장…', disabled: noSel(), action: () => C.saveSelection() },
      { label: '레이어 모양대로 선택', disabled: no(), action: () => C.selectFromLayer() },
      { label: '광도를 선택 영역으로', key: `${mod}Alt+2`, disabled: no(), action: () => (C.selectLuminosity || C.luminositySelection)() },
    ],
    '필터': () => [
      { label: '마지막 필터 다시', key: `${mod}F`, disabled: no(), action: () => D.repeatFilter(P) },
      { label: '고급 필터용으로 변환', disabled: no() || P.doc?.active?.kind === 'smart', action: () => C.convertToSmart() },
      '-',
      { label: '필터 갤러리…', disabled: no(), action: () => C.filterGallery() },
      { label: '픽셀 유동화…', key: `${mod}Shift+X`, disabled: no(), action: () => C.liquify() },
      ...filterGroups(),
    ],
    'AI': () => P.aiMenu(),
    '보기': () => [
      { label: '확대', key: `${mod}+`, disabled: no(), action: () => P.zoomStep(1) },
      { label: '축소', key: `${mod}-`, disabled: no(), action: () => P.zoomStep(-1) },
      { label: '화면 크기에 맞게 조정', key: `${mod}0`, disabled: no(), action: () => P.fit(true) },
      { label: '100%', key: `${mod}1`, disabled: no(), action: () => P.setZoom(1) },
      { label: '200%', disabled: no(), action: () => P.setZoom(2) },
      ...(P.viewMenuItems ? P.viewMenuItems(mod, no) : []),
    ],
    '창': () => P.windowMenu(),
    '도움말': () => [
      // first: the menu bar's 단축키 button opens it
      { label: '바로 가기 키 (단축키)…', key: `${mod}Alt+Shift+K`, action: () => C.keyboardShortcuts() },
      { label: '설명서 (모든 기능)', action: () => import('../docs/viewer.js').then((m) => m.openDocs('p-start')) },
      '-',
      { label: 'Montage 웹사이트 (새 탭)', action: () => window.open('index.html', '_blank', 'noopener') },
    ],
  };
}

/** A dirty rectangle grown to whole pixels (plus a pixel of margin) and kept inside the document. */
function clipRect(r, W, H) {
  const x = Math.max(0, Math.floor(r.x) - 1);
  const y = Math.max(0, Math.floor(r.y) - 1);
  const x1 = Math.min(W, Math.ceil(r.x + r.w) + 1);
  const y1 = Math.min(H, Math.ceil(r.y + r.h) + 1);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

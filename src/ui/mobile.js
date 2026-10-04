// Phone layout: preview on top, timeline in the middle, a contextual clip toolbar and a bottom
// navigation bar that opens the panels as bottom sheets. Desktop panels are reused as they are;
// this module only adds the phone chrome and moves things around with CSS.

import { store } from '../store.js';
import { playback } from '../playback.js';
import * as edit from '../edit.js';
import { commands as c } from '../commands.js';
import { h } from '../util.js';
import { showPanel, toast, closeMenus, panelHooks } from './common.js';
import { icon } from './icons.js';
import { quickApi } from './quick-panel.js';
import { menubarApi } from './menubar.js';
import { pickFiles } from './project-panel.js';
import { importFiles, mediaStatus } from '../media.js';
import { openSpeedDialog } from './dialogs.js';
import { duplicateClips } from '../features.js';

// narrow windows, and touch phones held sideways (wide but very short)
const MQ = '(max-width: 760px), (pointer: coarse) and (max-height: 540px)';
const LAND = '(orientation: landscape)';
const SHEET_PANELS = {
  'pg-top-left': ['source', 'effectControls', 'quick', 'ai', 'mixer', 'scopes', 'multicam'],
  'pg-bottom-left': ['project', 'effects', 'markers', 'history'],
};
const PANEL_NAMES = {
  source: '소스', effectControls: '조정 (효과 컨트롤)', quick: '빠른 편집', ai: 'AI 편집 (Gemini)', mixer: '오디오 믹서', scopes: '스코프', multicam: '멀티캠',
  project: '미디어', effects: '효과', markers: '마커', history: '작업 내역',
};

export const mobileApi = { active: false };

export function initMobile() {
  const mq = window.matchMedia(MQ);
  const app = document.getElementById('app');
  const groups = Object.keys(SHEET_PANELS).map((id) => document.getElementById(id));
  let openGroup = null;
  let big = false;

  // ---------------------------------------------------------------- top bar
  const undoBtn = h('button.m-icon', { 'aria-label': '실행 취소', title: '실행 취소', onclick: () => store.undo() }, icon('undo', 20));
  const redoBtn = h('button.m-icon', { 'aria-label': '다시 실행', title: '다시 실행', onclick: () => store.redo() }, icon('redo', 20));
  const title = h('span.m-title');
  const top = h('header.m-top',
    h('button.m-icon', { 'aria-label': '메뉴', title: '메뉴', onclick: openMenuSheet }, icon('menu', 22)),
    title, undoBtn, redoBtn,
    h('button.m-icon', { 'aria-label': '도움말', title: '시작 가이드', onclick: () => c.guide() }, icon('help', 20)),
    h('button.primary.m-export', { onclick: () => c.exportMedia() }, '내보내기'));
  app.prepend(top);

  // ---------------------------------------------------------------- sheet heads
  const heads = new Map();
  for (const g of groups) {
    const name = h('span.m-sheet-name');
    const head = h('div.m-sheet-head',
      h('button.m-grip', { 'aria-label': '시트 크기 바꾸기', title: '크게 / 작게', onclick: () => setBig(!big) }),
      name,
      h('button.m-icon', { 'aria-label': '닫기', title: '닫기', onclick: closeSheet }, icon('close', 20)));
    g.prepend(head);
    heads.set(g, name);
  }

  // ---------------------------------------------------------------- clip toolbar (shown while clips are selected)
  const tool = (ic, label, fn, cls = '') => h(`button.m-tool${cls}`, { onclick: fn, 'aria-label': label }, icon(ic, 22), h('span', label));
  const selIds = () => [...store.selection.clips];
  const clipbar = h('div.m-clipbar', { role: 'toolbar', 'aria-label': '클립 도구' },
    tool('scissors', '분할', () => { edit.addEdit(); }),
    tool('trash', '삭제', () => edit.deleteSelection({ ripple: true })),
    tool('copy', '복제', () => duplicateClips(selIds())),
    tool('speed', '속도', () => { if (selIds().length) openSpeedDialog(selIds()); }),
    tool('reverse', '역재생', () => edit.toggleReverse(selIds())),
    tool('freeze', '정지 화면', () => c.frameHold()),
    tool('wand', '애니메이션', () => openQuick('anim')),
    tool('filter', '필터', () => openQuick('filter')),
    tool('frame', '위치·크기', () => openQuick('frame')),
    tool('audio', '소리', () => openQuick('audio')),
    tool('sliders', '세부 조정', () => openSheet('effectControls')),
    tool('check', '선택 해제', () => store.clearSelection(), '.done'));

  // ---------------------------------------------------------------- bottom navigation
  const navItems = [
    ['folder', '미디어', () => openSheet('project')],
    ['ai', 'AI', () => c.ai()],
    ['text', '텍스트', () => openQuick('text')],
    ['smile', '스티커', () => openQuick('sticker')],
    ['wand', '애니메이션', () => openQuick('anim')],
    ['filter', '필터', () => openQuick('filter')],
    ['sparkle', '효과', () => openSheet('effects')],
    ['audio', '소리', () => openQuick('audio')],
    ['frame', '화면', () => openQuick('frame')],
    ['scissors', '자동 편집', () => openQuick('auto')],
    ['sliders', '조정', () => openSheet('effectControls')],
    ['more', '더보기', openMoreSheet],
  ];
  const nav = h('nav.m-nav', { 'aria-label': '편집 도구' }, navItems.map(([ic, label, fn]) => tool(ic, label, fn)));
  const addBtn = h('button.m-add', { 'aria-label': '영상·사진·음악 추가', title: '영상·사진·음악을 가져와 재생헤드 위치에 넣기', onclick: addMedia }, icon('plus', 26));

  /** Phone "+": import files and insert them one after another at the playhead. */
  async function addMedia() {
    const files = await pickFiles();
    if (!files.length) return;
    toast('가져오는 중…');
    const ids = await importFiles(files);
    let n = 0;
    for (const id of ids) {
      const m = store.project.media[id];
      if (!m || mediaStatus(id) !== 'ready' || ['lut', 'font'].includes(m.kind)) continue;
      const placed = edit.placeMedia(id, { mode: 'insert' });
      const end = Math.max(...placed.map((cid) => { const cc = store.seq.clips[cid]; return cc ? cc.start + cc.duration : 0; }));
      if (Number.isFinite(end)) store.setPlayhead(end);
      n++;
    }
    if (n) toast(`${n}개를 타임라인에 넣었습니다`);
  }
  const bottom = h('div.m-bottom', clipbar, nav);
  app.append(bottom);
  document.getElementById('pg-timeline').append(addBtn);

  // ---------------------------------------------------------------- sheets
  function groupOf(panelId) {
    return groups.find((g) => SHEET_PANELS[g.id].includes(panelId)) || null;
  }

  let opening = false;
  function openSheet(panelId) {
    closeMenus();
    const g = groupOf(panelId);
    if (!g) return;
    opening = true;
    showPanel(panelId);
    opening = false;
    for (const x of groups) x.classList.toggle('m-open', x === g);
    openGroup = g;
    placeSheets();
    heads.get(g).textContent = PANEL_NAMES[panelId] || '';
    document.body.classList.add('m-sheet-open');
    window.dispatchEvent(new Event('resize'));
  }

  function openQuick(section) {
    openSheet('quick');
    quickApi.show?.(section);
  }

  function closeSheet() {
    document.body.classList.remove('m-typing');
    for (const x of groups) x.classList.remove('m-open');
    openGroup = null;
    document.body.classList.remove('m-sheet-open');
    window.dispatchEvent(new Event('resize'));
  }

  function setBig(v) {
    big = v;
    document.body.classList.toggle('m-sheet-big', big);
    window.dispatchEvent(new Event('resize'));
  }

  // portrait sheets start right under the preview and its play controls, so playback stays usable
  const program = document.getElementById('pg-top-right');
  function placeSheets() {
    if (!mobileApi.active) return;
    const root = document.documentElement.style;
    root.setProperty('--m-sheet-top', `${Math.round(program.getBoundingClientRect().bottom)}px`);
    root.setProperty('--m-bar-bottom', `${Math.round(top.getBoundingClientRect().bottom)}px`);
  }
  new ResizeObserver(placeSheets).observe(program);
  window.addEventListener('resize', placeSheets);

  // typing in a sheet: the on-screen keyboard takes half the screen, so the sheet takes the rest
  const typable = (el) => el?.matches?.('textarea, input:not([type]), input[type=text], input[type=search], input[type=password], input[type=number], [contenteditable=""], [contenteditable="true"]');
  let typingTimer = null;
  document.addEventListener('focusin', (e) => {
    if (!mobileApi.active || !typable(e.target) || !e.target.closest('.m-open')) return;
    clearTimeout(typingTimer);
    document.body.classList.add('m-typing');
  });
  document.addEventListener('focusout', () => {
    clearTimeout(typingTimer);
    // focus may be moving to the next field: decide after it lands
    typingTimer = setTimeout(() => {
      const a = document.activeElement;
      if (!(typable(a) && a.closest('.m-open'))) document.body.classList.remove('m-typing');
    }, 120);
  });

  // menus and commands that bring a panel forward open its sheet on the phone
  panelHooks.onShow = (id) => {
    if (!opening && mobileApi.active && groupOf(id)) openSheet(id);
  };

  // keep the sheet title in sync when the user switches tabs inside it
  store.on('focus', () => {
    if (!openGroup) return;
    const id = store.ui.focusPanel;
    if (SHEET_PANELS[openGroup.id].includes(id)) heads.get(openGroup).textContent = PANEL_NAMES[id] || '';
  });

  // ---------------------------------------------------------------- menu sheets (full menus, more)
  let menuSheet = null;
  function listSheet(heading, rows, back = null) {
    menuSheet?.remove();
    const list = h('div.m-list');
    for (const it of rows) {
      if (!it) continue;
      if (it === '-') {
        list.append(h('div.m-sep'));
        continue;
      }
      if (it.group) {
        list.append(h('div.m-group', it.group));
        continue;
      }
      const row = h(`button.m-row${it.disabled ? '.disabled' : ''}`, { disabled: !!it.disabled },
        it.swatch ? h('span.swatch', { style: { background: it.swatch } }) : null,
        h('span.m-row-label', it.label), it.checked ? icon('check', 18) : null, it.submenu ? h('span.m-chev', '›') : null);
      row.addEventListener('click', () => {
        if (it.submenu) {
          const sub = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
          listSheet(it.label, sub, () => listSheet(heading, rows, back));
          return;
        }
        menuSheet?.remove();
        menuSheet = null;
        try {
          it.action?.();
        } catch (err) {
          toast(String(err.message || err));
        }
      });
      list.append(row);
    }
    const close = () => {
      menuSheet?.remove();
      menuSheet = null;
    };
    menuSheet = h('div.m-menu-backdrop', { onclick: (e) => { if (e.target === menuSheet) close(); } },
      h('div.m-menu', { role: 'dialog', 'aria-label': heading },
        h('div.m-menu-head', back ? h('button.m-icon', { 'aria-label': '뒤로', onclick: back }, icon('kfPrev', 20)) : null, h('b', heading), h('button.m-icon', { 'aria-label': '닫기', onclick: close }, icon('close', 20))),
        list));
    document.body.append(menuSheet);
  }

  function openMenuSheet() {
    const menus = menubarApi.menus || {};
    listSheet('메뉴', Object.keys(menus).map((name) => ({ label: name, submenu: () => menus[name]() })));
  }

  function openMoreSheet() {
    listSheet('더보기', [
      { label: '마커', action: () => openSheet('markers') },
      { label: '작업 내역 (실행 취소 목록)', action: () => openSheet('history') },
      { label: '오디오 믹서', action: () => openSheet('mixer') },
      { label: '멀티캠', action: () => openSheet('multicam') },
      { label: '소스 모니터', action: () => openSheet('source') },
      { label: '스코프', action: () => openSheet('scopes') },
      '-',
      { label: '화면 비율 바꾸기', action: () => openQuick('frame') },
      { label: '시퀀스 설정…', action: () => c.sequenceSettings() },
      { label: '프로젝트 파일로 저장', action: () => c.saveProject() },
      { label: '프로젝트 열기…', action: () => c.openProject() },
      { label: '새 프로젝트', action: () => c.newProject() },
      '-',
      { label: '전체 메뉴…', action: openMenuSheet },
    ]);
  }

  // ---------------------------------------------------------------- state
  const refresh = () => {
    title.textContent = store.project.name;
    undoBtn.disabled = !store.undoStack.length;
    redoBtn.disabled = !store.redoStack.length;
    document.body.classList.toggle('m-has-sel', store.selection.clips.size > 0);
  };
  store.on('change', refresh);
  store.on('history', refresh);
  store.on('selection', refresh);
  refresh();

  const land = window.matchMedia(LAND);
  function apply() {
    const on = mq.matches;
    mobileApi.active = on;
    document.body.classList.toggle('mobile', on);
    document.body.classList.toggle('m-land', on && land.matches);
    if (!on) closeSheet();
    window.dispatchEvent(new Event('resize'));
  }
  mq.addEventListener('change', apply);
  land.addEventListener('change', apply);
  apply();
  Object.assign(mobileApi, { openSheet, openQuick, closeSheet });
  playback.on('state', refresh);
}

// Photoshop look for the photo editor: the interface colour themes (Edit ▸ Preferences ▸ Interface,
// Shift+F1 / Shift+F2), the Home screen (a full-area page with the documents kept in this browser,
// search, New / Open, quick-start presets; library.js keeps the documents) and File ▸ Open Recent.

import { h, clamp, downloadBlob } from '../util.js';
import { toast, loadPref, savePref, showMenu, confirmDialog, promptDialog } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { DOC_CATEGORIES } from './pdialogs.js';
import { LESSONS } from './lessons.js';
import * as LIB from './library.js';
import { installTopBar } from './topbar.js';

/** [theme, name, panel colour, pasteboard colour]; 3 (medium grey panels, dark pasteboard, as in the
 * owner's Photoshop screenshot) is the default here. */
const THEMES = [[1, '가장 어둡게', '#262626', '#1e1e1e'], [2, '어둡게', '#323232', '#282828'], [3, '중간 회색 (기본값)', '#535353', '#262626'], [4, '밝게', '#dcdcdc', '#c2c2c2']];
const pasteOf = (n) => THEMES.find((t) => t[0] === n)[3];
// a pasteboard of one of these colours is the theme's (it follows the theme when that changes)
const THEME_PASTE = new Set(['#1f2125', ...THEMES.map((t) => t[3])]);

export function installTheme(P) {
  P.theme = clamp(loadPref('photo.theme', 3) | 0, 1, 4);
  installTopBar(P);
  P.themePasteboard = () => pasteOf(P.theme);
  /** Edit ▸ Preferences ▸ Interface ▸ Color Theme. */
  P.setTheme = (n, { quiet = true } = {}) => {
    n = clamp(n | 0, 1, 4);
    P.theme = n;
    savePref('photo.theme', n);
    document.body.dataset.psTheme = String(n);
    if (!P.prefs.pasteboard || THEME_PASTE.has(P.prefs.pasteboard.toLowerCase())) {
      P.prefs.pasteboard = pasteOf(n);
      savePref('photo.prefs', P.prefs);
    }
    document.body.style.setProperty('--ps-pasteboard', P.prefs.pasteboard);
    P.invalidateView?.();
    P.emit('theme', n);
    if (!quiet) toast(`색상 테마: ${THEMES[n - 1][1]}`);
  };
  /** The four colour swatches of the Interface preferences (they apply at once, like Photoshop). */
  P.themeControl = () => {
    const row = h('span.ph-themes', { role: 'radiogroup', 'aria-label': '색상 테마' });
    const paint = () => row.replaceChildren(...THEMES.map(([n, name, c]) => h(`button.ph-theme${P.theme === n ? '.on' : ''}`, {
      type: 'button', role: 'radio', 'aria-checked': String(P.theme === n), 'aria-label': name, title: name, style: { background: c },
      onclick: () => { P.setTheme(n); paint(); },
    })));
    paint();
    return row;
  };
  // Shift+F1 / Shift+F2: a darker / lighter theme
  const prevKeys = P.viewKeys;
  P.viewKeys = (e, mod) => {
    if (e.shiftKey && !mod && !e.altKey && (e.code === 'F1' || e.code === 'F2')) {
      P.setTheme(P.theme + (e.code === 'F1' ? -1 : 1), { quiet: false });
      return true;
    }
    return prevKeys?.(e, mod) || false;
  };
  P.setTheme(P.theme);
}

// ---------------------------------------------------------------- recent files (the document library)

/** A file was just opened from disk: it goes on the home screen with its layers (library.js). */
export function rememberFile(P, file, doc) {
  return LIB.put(P, doc);
}

/** Keep a document on the home screen before it closes; false when it could not be kept. */
export const keepDoc = (P, doc) => LIB.put(P, doc);

/** File ▸ Open Recent: the home screen's documents, most recent first. */
export function recentMenu(P) {
  const list = LIB.recent();
  return { label: '최근 파일 열기', disabled: !list.length, submenu: () => [
    ...list.slice(0, 15).map((x) => ({ label: x.name, hint: `${x.w} × ${x.h}`, action: () => LIB.open(P, x.id) })),
    '-',
    { label: '홈 화면에서 모두 보기', action: () => P.showHome(true) },
    { label: '최근 파일 목록 지우기', action: () => clearRecent(P) },
  ] };
}

/** Moves every closed document on the list to 삭제됨 (they can be restored from there). */
async function clearRecent(P) {
  const open = new Set(P.docs.map((d) => d.id));
  const ids = LIB.recent().filter((x) => !open.has(x.id)).map((x) => x.id);
  if (!ids.length) return;
  await LIB.remove(ids);
  toast(`문서 ${ids.length}개를 삭제됨으로 옮겼습니다. 홈 화면 ▸ 삭제됨에서 되살릴 수 있어요.`);
}

// ---------------------------------------------------------------- home screen

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  if (s < 86400 * 31) return `${Math.floor(s / 86400 / 7)}주 전`;
  return new Date(t).toLocaleDateString('ko-KR');
};
const mb = (n) => (n < 1e6 ? `${Math.max(0, Math.round(n / 1e3))} KB` : n < 1e8 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e6)} MB`);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const SORTS = [['recent', '최근 항목'], ['name', '이름'], ['size', '크기']];

/** Every menu command as { label, path, key, action, disabled } (for the home screen's search). */
function menuCommands(P) {
  const out = [];
  const walk = (items, path, depth, off) => {
    let list = [];
    try {
      list = (typeof items === 'function' ? items() : items) || [];
    } catch { /* a submenu that needs a document */ }
    for (const it of list) {
      if (!it || it === '-' || it.group || typeof it.label !== 'string') continue;
      // a submenu that is off (no document yet) still lists its commands, greyed out
      if (it.submenu) {
        if (depth < 3) walk(it.submenu, [...path, it.label], depth + 1, off || !!it.disabled);
      } else if (it.action) out.push({ label: it.label, path: path.join(' ▸ '), key: it.key || '', action: it.action, disabled: off || !!it.disabled });
    }
  };
  for (const [name, fn] of Object.entries(P.menus || {})) walk(fn, [name], 0, false);
  return out;
}

/** A touch held still on el for a moment opens its menu (like a right-click). */
function onLongPress(el, fn) {
  let t = 0;
  let at = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    at = [e.clientX, e.clientY];
    clearTimeout(t);
    t = setTimeout(() => {
      el.dataset.longpress = '1';
      fn(at[0], at[1]);
    }, 550);
  });
  el.addEventListener('pointermove', (e) => { if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 10) clearTimeout(t); });
  for (const ev of ['pointerup', 'pointercancel']) el.addEventListener(ev, () => clearTimeout(t));
}

/**
 * Photoshop's home screen: a full-area page shown while no document is open, or from the Home button
 * at the left of the options bar. Header with the search, 홈 / 내 작업 (이 브라우저의 문서, 삭제됨) on
 * the left with 새로 만들기 and 열기, and the documents as large cards (sort, filter, grid or list).
 */
export function buildHome(P, { newDoc, open, openFromVideo }) {
  let view = 'home';
  let sort = loadPref('photo.home.sort', 'recent');
  if (!SORTS.some(([k]) => k === sort)) sort = 'recent';
  let desc = loadPref('photo.home.desc', true) !== false;
  let layout = loadPref('photo.home.layout', 'grid') === 'list' ? 'list' : 'grid';
  let filterText = '';
  let query = '';
  const thumbs = new Map(); // id → { blob, url }
  const thumbUrl = (x) => {
    const t = thumbs.get(x.id);
    if (t?.blob === x.thumb) return t.url;
    if (t) URL.revokeObjectURL(t.url);
    if (!x.thumb) return thumbs.delete(x.id), null;
    const url = URL.createObjectURL(x.thumb);
    thumbs.set(x.id, { blob: x.thumb, url });
    return url;
  };

  // ---- the header: app mark, search (documents, menu commands, Learn lessons)
  const search = h('input.ph-hs-in', { type: 'search', placeholder: '검색', 'aria-label': '문서, 메뉴 명령, 학습 검색', autocomplete: 'off', spellcheck: false });
  const pop = h('div.ph-hs-pop', { hidden: true, role: 'listbox', 'aria-label': '검색 결과' });
  const searchBox = h('div.ph-hs', h('span.ph-hs-ic', icon('search', 16)), search, pop);
  let commands = null;
  let hits = [];
  let hitAt = 0;
  const closePop = () => { pop.hidden = true; };
  const runHit = (x) => {
    if (!x || x.disabled) return;
    closePop();
    x.run();
  };
  const paintPop = () => {
    const q = norm(query);
    if (!q) return closePop();
    commands ||= menuCommands(P);
    const docs = LIB.recent().filter((x) => norm(x.name).includes(q)).slice(0, 4)
      .map((x) => ({ group: '문서', label: x.name, sub: `${x.w} × ${x.h} · ${ago(x.time)}`, ic: 'image', run: () => LIB.open(P, x.id) }));
    const cmds = commands.filter((c) => norm(c.label).includes(q) || norm(`${c.path}${c.label}`).includes(q))
      .sort((a, b) => a.disabled - b.disabled).slice(0, 8)
      .map((c) => ({ group: '메뉴 명령', label: c.label, sub: c.disabled ? `${c.path} · 문서를 먼저 여세요` : c.path, key: c.key, ic: 'menu', disabled: c.disabled, run: () => {
        if (P.doc) P.showHome(false);
        c.action();
      } }));
    const lessons = LESSONS.filter((l) => norm(`${l.title}${l.group}${l.intro}`).includes(q)).slice(0, 4)
      .map((l) => ({ group: '학습', label: l.title, sub: `${l.group} · 실습 ${l.steps.length}단계`, ic: 'book', run: () => {
        P.openPracticeFile?.(l.id);
        P.showPanel?.('learn');
      } }));
    hits = [...docs, ...cmds, ...lessons];
    hitAt = hits.findIndex((x) => !x.disabled);
    let group = null;
    pop.replaceChildren(...(hits.length ? hits.flatMap((x, i) => {
      const head = x.group !== group ? h('div.ph-hs-g', (group = x.group)) : null;
      const row = h(`div.ph-hs-r${x.disabled ? '.off' : ''}${i === hitAt ? '.on' : ''}`, { role: 'option', 'aria-disabled': x.disabled ? 'true' : null, onpointerdown: (e) => e.preventDefault(), onclick: () => runHit(x) },
        icon(x.ic, 16), h('span.ph-hs-t', h('b', x.label), h('small', x.sub)), x.key ? h('kbd', x.key) : null);
      return head ? [head, row] : [row];
    }) : [h('div.ph-hs-none', `"${query}"에 맞는 문서, 메뉴, 학습이 없습니다.`)]));
    pop.hidden = false;
  };
  search.addEventListener('focus', () => { commands = null; if (query) paintPop(); });
  search.addEventListener('blur', () => setTimeout(closePop, 120));
  search.addEventListener('input', () => {
    query = search.value.trim();
    paintPop();
    paint();
  });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const rows = [...pop.querySelectorAll('.ph-hs-r')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      for (let k = 1; k <= hits.length; k++) {
        const i = (hitAt + d * k + hits.length * 2) % hits.length;
        if (!hits[i].disabled) {
          hitAt = i;
          break;
        }
      }
      rows.forEach((r, i) => r.classList.toggle('on', i === hitAt));
      rows[hitAt]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runHit(hits[hitAt]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (search.value) {
        search.value = query = '';
        closePop();
        paint();
      } else search.blur();
    }
  });
  const head = h('header.ph-home-head',
    h('span.ph-home-mark', { 'aria-hidden': 'true' }, 'Ph'),
    h('span.ph-home-app', '사진 편집'),
    h('button.ph-home-back', { onclick: () => P.showHome(false), title: '작업 중인 문서로 돌아가기 (Esc)' }, icon('chevLeft', 14), '문서로 돌아가기'),
    h('span.ph-home-sp'),
    searchBox);

  // ---- the left column
  const navBtn = (id, label, ic) => h('button.ph-hn', { dataset: { view: id }, onclick: () => setView(id) }, icon(ic, 16), h('span', label), h('small.ph-hn-n'));
  const storage = h('div.ph-home-store');
  const nav = h('nav.ph-home-nav', { 'aria-label': '홈' },
    navBtn('home', '홈', 'homeIcon'),
    h('div.ph-hn-h', '내 작업'),
    navBtn('docs', '이 브라우저의 문서', 'folder'),
    navBtn('trash', '삭제됨', 'trash'),
    h('div.ph-hn-btns',
      h('button.ph-hb.ph-hb-new', { onclick: newDoc, title: `새 문서 (${MOD}N)` }, '새로 만들기'),
      h('button.ph-hb.ph-hb-open', { onclick: open, title: `열기 (${MOD}O)` }, '열기'),
      h('button.ph-hb.ph-home-video', { onclick: openFromVideo, title: '영상 프로젝트에 불러온 이미지를 엽니다' }, icon('film', 14), '영상 프로젝트 이미지')),
    storage,
    h('p.ph-home-note', '파일을 이 화면으로 끌어 놓아도 열립니다. 작업한 문서는 레이어까지 이 브라우저에 보관됩니다.'));

  // ---- the main area: sort / filter / grid-list, quick start (홈) and the cards
  const sortSel = h('select.ph-hsort', { 'aria-label': '정렬', onchange: () => {
    sort = sortSel.value;
    // names read A→Z, the others newest / biggest first
    desc = sort !== 'name';
    savePref('photo.home.sort', sort);
    savePref('photo.home.desc', desc);
    paint();
  } },
    ...SORTS.map(([k, n]) => h('option', { value: k, selected: k === sort }, n)));
  const dirBtn = h('button.ph-ibtn.ph-hdir', { onclick: () => { desc = !desc; savePref('photo.home.desc', desc); paint(); } });
  const filter = h('input.ph-hfilter', { type: 'search', placeholder: '이름으로 찾기', 'aria-label': '필터', oninput: () => { filterText = filter.value.trim(); paint(); } });
  filter.addEventListener('keydown', (e) => e.stopPropagation());
  const layoutBtn = (id, ic, label) => h('button.ph-ibtn.ph-hlay', { dataset: { lay: id }, title: label, 'aria-label': label, onclick: () => { layout = id; savePref('photo.home.layout', id); paint(); } }, icon(ic, 16));
  const bar = h('div.ph-home-bar',
    h('label.ph-hlab', '정렬', sortSel), dirBtn,
    h('span.ph-home-sp'),
    h('label.ph-hlab', '필터', filter),
    h('span.ph-hlays', layoutBtn('grid', 'grid', '격자 보기'), layoutBtn('list', 'list', '목록 보기')));
  const quick = [['기본 Photoshop 크기', 2100, 1500, 300], ['HDTV 1080p', 1920, 1080, 72], ['인스타그램 정사각형', 1080, 1080, 72], ['A4', 2480, 3508, 300], ['쇼츠 · 릴스 · 스토리', 1080, 1920, 72], ['웹 일반', 1366, 768, 72]]
    .filter(([n]) => DOC_CATEGORIES.some(([, , l]) => l.some((p) => p[0] === n)));
  const qcard = ([n, w, hh, res]) => {
    const k = 30 / Math.max(w, hh);
    return h('button.ph-home-q', { title: `${n} · ${w} × ${hh} 픽셀`, onclick: () => {
      P.newDoc({ name: `제목 없음-${P.docs.length + 1}`, width: w, height: hh, background: '#ffffff' });
      if (P.doc) P.doc.resolution = res;
    } }, h('i', { style: { width: `${Math.round(w * k)}px`, height: `${Math.round(hh * k)}px` } }), h('span', h('b', n), h('small', `${w} × ${hh}`)));
  };
  const quickBox = h('section.ph-home-quick', h('h3', '빠른 시작'), h('div.ph-home-qrow', ...quick.map(qcard)));
  const titleBox = h('div.ph-home-title');
  const grid = h('div.ph-home-grid');
  const main = h('div.ph-home-main', bar, quickBox, titleBox, grid);

  const el = h('div.ph-home', { hidden: true }, head, h('div.ph-home-body', nav, main));
  // Esc goes back to the open document (like leaving Photoshop's home screen)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.hidden || !P.doc || e.target.closest?.('input, select, textarea') || document.querySelector('.modal-backdrop, .menu')) return;
    e.preventDefault();
    e.stopPropagation();
    P.showHome(false);
  }, true);

  // ---- cards
  /** An open document's latest changes are written first (a copy or a download takes what is kept). */
  const writeIfOpen = async (id) => {
    const d = P.docs.find((dd) => dd.id === id);
    if (d) await LIB.put(P, d);
  };
  const menuFor = (x) => (x.deleted ? [
    { label: '복원', action: () => LIB.restore(x.id).then(() => toast(`"${x.name}"을(를) 되살렸습니다`)) },
    '-',
    { label: '영구 삭제…', action: async () => {
      if (await confirmDialog('영구 삭제', `"${x.name}"을(를) 영구 삭제할까요? 되돌릴 수 없습니다.`)) LIB.purge(x.id);
    } },
  ] : [
    { label: '열기', action: () => openItem(x) },
    { label: '이름 바꾸기…', action: async () => {
      const name = (await promptDialog('이름 바꾸기', '새 이름', x.name))?.trim();
      if (!name || name === x.name) return;
      await LIB.rename(x.id, name);
      const d = P.docs.find((dd) => dd.id === x.id);
      if (d) {
        d.name = name;
        P.renderTabs?.();
      }
    } },
    { label: '복제', action: async () => {
      await writeIfOpen(x.id);
      const c = await LIB.duplicate(P, x.id);
      if (c) toast(`"${c.name}"을(를) 만들었습니다`);
    } },
    { label: '컴퓨터에 저장 (.mphoto)', action: async () => {
      await writeIfOpen(x.id);
      const blob = await LIB.projectBlob(x.id);
      if (blob) downloadBlob(blob, `${x.name}.mphoto`);
    } },
    '-',
    { label: '목록에서 제거 (삭제됨으로)', action: () => LIB.remove(x.id).then(() => toast(`"${x.name}"을(를) 삭제됨으로 옮겼습니다`)) },
  ]);
  const openItem = async (x) => {
    if (x.deleted) return showMenu(menuFor(x), ...menuAt(grid.querySelector(`[data-id="${x.id}"]`)));
    return LIB.open(P, x.id);
  };
  const menuAt = (card) => {
    const r = card?.getBoundingClientRect() || { left: 100, top: 100, width: 0 };
    return [r.left + Math.min(r.width, 160) / 2, r.top + 40];
  };
  const card = (x, openIds) => {
    const url = thumbUrl(x);
    const isOpen = openIds.has(x.id);
    const more = h('button.ph-ibtn.ph-hc-more', { title: '더 보기', 'aria-label': `${x.name} 메뉴`, onclick: (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      showMenu(menuFor(x), r.left, r.bottom + 2);
    } }, icon('more', 16));
    const th = h('div.ph-hc-th', url ? h('img', { src: url, alt: '', draggable: false }) : icon('image', 28), isOpen ? h('span.ph-hc-badge', '열림') : null, more);
    const c = h(`div.ph-hc${isOpen ? '.open' : ''}`, {
      tabindex: 0, role: 'button', dataset: { id: x.id },
      title: `${x.name} · ${x.w} × ${x.h} 픽셀 · ${mb(x.bytes || 0)}`,
      onclick: () => {
        if (c.dataset.longpress) return void delete c.dataset.longpress;
        openItem(x);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openItem(x);
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          showMenu(menuFor(x), ...menuAt(c));
        } else if (e.key === 'Delete' && !x.deleted) LIB.remove(x.id);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(menuFor(x), e.clientX, e.clientY);
      },
    },
    th,
    h('div.ph-hc-name', x.name),
    h('div.ph-hc-time', x.deleted ? `삭제: ${ago(x.deleted)}` : ago(x.time)),
    h('div.ph-hc-dim', `${x.w} × ${x.h}`),
    h('div.ph-hc-size', mb(x.bytes || 0)));
    onLongPress(c, (cx, cy) => showMenu(menuFor(x), cx, cy));
    return c;
  };

  function setView(v) {
    view = v;
    grid.scrollTop = 0;
    paint();
  }

  let painted = false;
  function paint() {
    painted = true;
    const list = view === 'trash' ? LIB.trash() : LIB.recent();
    const q = norm(filterText);
    const q2 = norm(query);
    let shown = list.filter((x) => (!q || norm(x.name).includes(q)) && (!q2 || norm(x.name).includes(q2)));
    if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    else if (sort === 'size') shown.sort((a, b) => a.w * a.h - b.w * b.h || a.bytes - b.bytes);
    else shown.sort((a, b) => (view === 'trash' ? a.deleted - b.deleted : a.time - b.time));
    if (desc) shown.reverse();
    dirBtn.textContent = desc ? '↓' : '↑';
    dirBtn.title = desc ? '내림차순' : '오름차순';
    sortSel.value = sort;
    for (const b of nav.querySelectorAll('.ph-hn')) b.classList.toggle('on', b.dataset.view === view);
    nav.querySelector('[data-view="docs"] .ph-hn-n').textContent = String(LIB.recent().length);
    nav.querySelector('[data-view="trash"] .ph-hn-n').textContent = LIB.trash().length ? String(LIB.trash().length) : '';
    for (const b of bar.querySelectorAll('.ph-hlay')) b.classList.toggle('on', b.dataset.lay === layout);
    quickBox.hidden = view !== 'home' || !!q2;
    const used = LIB.usage();
    const cap = LIB.limit();
    storage.replaceChildren(
      h('div.ph-hs-row', h('span', '저장 공간'), h('b', `${mb(used)} / ${mb(cap)}`)),
      h('div.ph-hs-bar', h('i', { style: { width: `${Math.min(100, (used / cap) * 100).toFixed(1)}%` } })),
      h('small', '가득 차면 오래된 문서부터 지워집니다.'));
    // the title row of the view
    const trashN = LIB.trash().length;
    titleBox.replaceChildren(...[
      h('h3', q2 ? `"${query}" 검색 결과` : view === 'trash' ? '삭제됨' : view === 'docs' ? '이 브라우저의 문서' : '최근 항목', h('small', `${shown.length}개`)),
      view === 'trash' ? h('span.ph-home-tnote', `${30}일이 지나면 영구 삭제됩니다.`) : null,
      view === 'trash' && trashN ? h('button.small.ph-home-empty-btn', { onclick: async () => {
        if (await confirmDialog('삭제됨 비우기', `삭제됨의 문서 ${trashN}개를 영구 삭제할까요? 되돌릴 수 없습니다.`)) LIB.purge(LIB.trash().map((x) => x.id));
      } }, icon('trash', 14), '모두 영구 삭제') : null].filter(Boolean));
    grid.className = `ph-home-grid ${layout}`;
    const openIds = new Set(P.docs.map((d) => d.id));
    if (!shown.length) {
      grid.replaceChildren(h('div.ph-home-empty', q || q2 ? '찾는 이름의 문서가 없습니다.'
        : view === 'trash' ? '삭제한 문서가 없습니다.'
          : '아직 작업한 문서가 없습니다. 새로 만들기나 열기로 시작해 보세요. 작업한 문서는 여기에 레이어까지 그대로 보관됩니다.'));
    } else {
      const head2 = layout === 'list' ? h('div.ph-hl-head', h('span'), h('span', '이름'), h('span', '수정한 날짜'), h('span', '크기'), h('span', '저장 용량')) : null;
      grid.replaceChildren(...[head2, ...shown.map((x) => card(x, openIds))].filter(Boolean));
    }
    // object URLs of documents that are gone
    for (const [id, t] of thumbs) if (!LIB.get(id)) { URL.revokeObjectURL(t.url); thumbs.delete(id); }
  }
  const paintIfShown = () => {
    if (!el.hidden) paint();
    else painted = false;
  };
  LIB.onChange(paintIfShown);
  P.on('tabs', paintIfShown);
  // the relative times move on while the home screen is up
  setInterval(() => { if (!el.hidden && !document.hidden) paint(); }, 60000);

  /** Shows (or hides) the home screen (also the Home button of the options bar, panels.js); it hides by itself when a document comes up. */
  P.showHome = (on = true) => {
    on = !!on || !P.doc;
    const was = !el.hidden;
    el.hidden = !on;
    document.body.classList.toggle('ph-at-home', on);
    head.classList.toggle('with-doc', !!P.doc);
    if (on && (!was || !painted)) {
      view = 'home';
      paint();
    }
    if (!on) closePop();
    if (on !== was) P.emit('home', on);
  };
  P.homeShown = () => !el.hidden;
  P.on('doc', () => {
    P.showHome(!P.doc);
    // new and opened documents go on the list a moment later (with their picture)
    LIB.putSoon(P, P.docs);
  });
  // after each autosave the changed documents are written too (at most every few seconds each)
  P.on('saved', () => LIB.putSoon(P, P.docs));
  LIB.ready.then(() => P.showHome(!P.doc));
  return el;
}

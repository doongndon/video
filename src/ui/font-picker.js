// Font picker popup: every font previewed in its own face, recently used fonts at the top, categories,
// search, live preview on hover, and buttons to import font files or list the fonts installed on this
// computer. Used by the video editor's text clips and the photo editor's type tools.

import { store } from '../store.js';
import { h } from '../util.js';
import { toast } from './common.js';
import { FONT_CATEGORIES, fontChoices, loadFontFor, loadLocalFonts, localFontsAvailable, recentFonts, noteFontUsed } from '../fonts.js';
import { importFiles } from '../media.js';
import { pickFiles } from './project-panel.js';
import { injectStyle } from './style-inject.js';

injectStyle('fp-style', `
.font-picker .fp-group { padding: 4px 12px 2px; font-size: var(--fs-xs); color: var(--text-faint); background: #20242a; border-bottom: 1px solid #2f343c; position: sticky; top: 0; z-index: 1; }
`);

let open = null;

export function closeFontPicker() {
  open?.close(false);
}

/**
 * anchor: element the popup hangs from. opts: { current, sample, onPreview(family|null), onPick(family), onCancel() }
 */
export function openFontPicker(anchor, { current, sample = '', onPreview = () => {}, onPick = () => {}, onCancel = () => {} }) {
  closeFontPicker();
  let cat = loadCat();
  let query = '';
  let text = (sample || '').split('\n')[0].slice(0, 24) || '가나다라 Abc 123';
  let active = -1;
  let items = [];

  const search = h('input', { type: 'search', placeholder: '글꼴 이름 검색', 'aria-label': '글꼴 검색' });
  const sampleInput = h('input', { type: 'text', value: text, 'aria-label': '미리보기 문구', title: '미리보기에 쓸 문구' });
  const chips = h('div.fp-cats', FONT_CATEGORIES.map(([id, name]) => {
    const b = h('button.small', { onclick: () => { cat = id; saveCat(id); render(); } }, name);
    b.dataset.cat = id;
    return b;
  }));
  const list = h('div.fp-list', { role: 'listbox', 'aria-label': '글꼴 목록' });
  const importBtn = h('button.small', { onclick: importFonts, title: '.ttf / .otf / .woff / .woff2 파일을 프로젝트에 넣습니다' }, '글꼴 파일 가져오기…');
  const localBtn = localFontsAvailable()
    ? h('button.small', { onclick: listLocal, title: '이 컴퓨터에 설치된 글꼴 목록을 불러옵니다 (브라우저가 권한을 묻습니다)' }, '이 컴퓨터 글꼴 불러오기')
    : null;
  const pop = h('div.font-picker', { role: 'dialog', 'aria-label': '글꼴 고르기' },
    h('div.fp-head', search, sampleInput), chips, list,
    h('div.fp-foot', importBtn, localBtn, h('span.note', '마우스를 올리면 화면에 미리 적용됩니다')));
  document.body.append(pop);

  function place() {
    const r = anchor.getBoundingClientRect();
    const W = Math.min(380, window.innerWidth - 16);
    pop.style.width = `${W}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - W - 8))}px`;
    const below = window.innerHeight - r.bottom;
    if (below > 320 || below > r.top) {
      pop.style.top = `${r.bottom + 4}px`;
      pop.style.bottom = '';
      pop.style.maxHeight = `${Math.max(240, below - 16)}px`;
    } else {
      pop.style.top = '';
      pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
      pop.style.maxHeight = `${Math.max(240, r.top - 16)}px`;
    }
  }
  place();

  // fonts load as their row scrolls into view (never all at once: most are web fonts)
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const fam = en.target.dataset.family;
      io.unobserve(en.target);
      loadFontFor(fam, text).catch(() => {});
    }
  }, { root: list, rootMargin: '120px' });
  const observeAll = () => {
    io.disconnect();
    for (const el of items) if (!/^(sans-serif|serif|monospace)$/.test(el.dataset.family)) io.observe(el);
  };

  function row(f, i) {
    const preview = h('div.fp-preview', { style: { fontFamily: `"${f.family}", "Noto Sans KR", sans-serif` } }, text);
    const el = h(`div.fp-item${f.family === current ? '.current' : ''}`, { role: 'option', 'aria-selected': String(f.family === current), title: f.korean ? f.label : `${f.label} — 한글 글자가 없어 한글은 다른 글꼴로 보입니다` },
      h('div.fp-name', f.label, f.korean ? null : h('span.fp-tag', '영문')), preview);
    el.dataset.family = f.family;
    el.addEventListener('pointerenter', () => setActive(i, false));
    el.addEventListener('click', () => pick(f.family));
    return el;
  }

  function render() {
    chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    const q = query.trim().toLowerCase();
    const choices = fontChoices(store.project);
    // a search looks through every category
    const all = choices.filter((f) => (q ? f.label.toLowerCase().includes(q) || f.family.toLowerCase().includes(q) : cat === 'all' || f.cat === cat));
    chips.classList.toggle('dim', !!q);
    list.replaceChildren();
    items = [];
    // 최근 사용: the families picked lately, on top of the full list (like Premiere / Photoshop)
    const recent = !q && cat === 'all'
      ? recentFonts().map((fam) => choices.find((f) => f.family === fam) || { family: fam, label: fam, cat: 'mine', korean: true }).filter(Boolean)
      : [];
    if (recent.length) {
      list.append(h('div.fp-group', '최근 사용한 글꼴'));
      for (const f of recent) {
        const el = row(f, items.length);
        items.push(el);
        list.append(el);
      }
      list.append(h('div.fp-group', '모든 글꼴'));
    }
    for (const f of all) {
      const el = row(f, items.length);
      items.push(el);
      list.append(el);
    }
    if (!all.length) list.append(h('div.empty-hint', cat === 'mine' ? '아직 가져온 글꼴이 없습니다.\n아래 "글꼴 파일 가져오기"를 누르세요.' : '맞는 글꼴이 없습니다'));
    observeAll();
    // open at the current font: among the recent ones when it is one (they stay in view at the top)
    active = items.findIndex((el) => el.dataset.family === current);
    if (active >= 0) {
      if (active < recent.length) list.scrollTop = 0;
      else items[active].scrollIntoView({ block: 'center' });
    }
  }

  let previewTimer = null;
  function setActive(i, scroll = true) {
    items[active]?.classList.remove('active');
    active = i;
    const el = items[i];
    if (!el) return;
    el.classList.add('active');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => onPreview(el.dataset.family), 90);
  }

  let done = false;
  function close(picked) {
    if (done) return;
    done = true;
    clearTimeout(previewTimer);
    io.disconnect();
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    open = null;
    if (!picked) onCancel();
  }

  function pick(family) {
    clearTimeout(previewTimer);
    noteFontUsed(family);
    onPick(family);
    close(true);
  }

  async function importFonts() {
    const files = await pickFiles({ accept: '.ttf,.otf,.woff,.woff2,font/*', multiple: true });
    if (!files.length) return;
    const ids = await importFiles(files);
    const fams = ids.map((id) => store.project.media[id]?.fontFamily).filter(Boolean);
    if (fams.length) {
      toast(`글꼴 ${fams.length}개를 가져왔습니다: ${fams.join(', ')}`);
      cat = 'mine';
      if (!done) render();
    }
  }

  async function listLocal() {
    try {
      const n = await loadLocalFonts();
      toast(`이 컴퓨터의 글꼴 ${n}개를 불러왔습니다 (내 글꼴)`);
      cat = 'mine';
      if (!done) render();
    } catch (err) {
      toast(err?.name === 'SecurityError' || err?.name === 'NotAllowedError'
        ? '글꼴 목록 권한이 없습니다. 이 화면(예: claude.ai 보기 화면)에서는 막혀 있을 수 있습니다.'
        : String(err?.message || err));
    }
  }

  const outside = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target) && !e.target.closest?.('.modal, .menu')) close(false);
  };
  const onKey = (e) => {
    if (!pop.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setActive(Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      e.stopPropagation();
      pick(items[active].dataset.family);
    } else if (pop.contains(e.target)) {
      e.stopPropagation(); // typing in the search box must not trigger editing shortcuts
    }
  };
  setTimeout(() => {
    if (done) return;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  window.addEventListener('resize', place);

  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  sampleInput.addEventListener('input', () => {
    text = sampleInput.value || '가나다라 Abc 123';
    for (const el of list.querySelectorAll('.fp-preview')) el.textContent = text;
    // the new characters may need other font files: load them for the rows on screen
    observeAll();
  });
  list.addEventListener('pointerleave', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => onPreview(null), 120);
  });

  render();
  // on phones the keyboard would cover the list
  if (!document.body.classList.contains('mobile')) search.focus();
  open = { close };
  return open;
}

function loadCat() {
  try { return localStorage.getItem('montage.fontCat') || 'all'; } catch { return 'all'; }
}
function saveCat(v) {
  try { localStorage.setItem('montage.fontCat', v); } catch { /* storage unavailable */ }
}

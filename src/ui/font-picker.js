// Font picker popup: every font previewed in its own face, categories, search, live preview on
// hover, and buttons to import font files or list the fonts installed on this computer.

import { store } from '../store.js';
import { h } from '../util.js';
import { toast } from './common.js';
import { FONT_CATEGORIES, fontChoices, loadFontFor, loadLocalFonts, localFontsAvailable } from '../fonts.js';
import { importFiles } from '../media.js';
import { pickFiles } from './project-panel.js';

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

  const r = anchor.getBoundingClientRect();
  const W = Math.min(380, window.innerWidth - 16);
  pop.style.width = `${W}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - W - 8))}px`;
  const below = window.innerHeight - r.bottom;
  if (below > 320 || below > r.top) {
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.maxHeight = `${Math.max(240, below - 16)}px`;
  } else {
    pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
    pop.style.maxHeight = `${Math.max(240, r.top - 16)}px`;
  }

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const fam = en.target.dataset.family;
      io.unobserve(en.target);
      loadFontFor(fam, text).catch(() => {});
    }
  }, { root: list, rootMargin: '120px' });

  function render() {
    chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    const q = query.trim().toLowerCase();
    // a search looks through every category
    const all = fontChoices(store.project).filter((f) => (q ? f.label.toLowerCase().includes(q) || f.family.toLowerCase().includes(q) : cat === 'all' || f.cat === cat));
    chips.classList.toggle('dim', !!q);
    io.disconnect();
    list.replaceChildren();
    items = all.map((f, i) => {
      const preview = h('div.fp-preview', { style: { fontFamily: `"${f.family}", "Noto Sans KR", sans-serif` } }, text);
      const el = h(`div.fp-item${f.family === current ? '.current' : ''}`, { role: 'option', 'aria-selected': String(f.family === current), title: f.korean ? f.label : `${f.label} — 한글 글자가 없어 한글은 다른 글꼴로 보입니다` },
        h('div.fp-name', f.label, f.korean ? null : h('span.fp-tag', '영문')), preview);
      el.dataset.family = f.family;
      if (!/^(sans-serif|serif|monospace)$/.test(f.family)) io.observe(el);
      el.addEventListener('pointerenter', () => setActive(i, false));
      el.addEventListener('click', () => pick(f.family));
      return el;
    });
    if (!items.length) list.append(h('div.empty-hint', cat === 'mine' ? '아직 가져온 글꼴이 없습니다.\n아래 "글꼴 파일 가져오기"를 누르세요.' : '맞는 글꼴이 없습니다'));
    list.append(...items);
    active = items.findIndex((el) => el.dataset.family === current);
    if (active >= 0) items[active].scrollIntoView({ block: 'center' });
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
    open = null;
    if (!picked) onCancel();
  }

  function pick(family) {
    clearTimeout(previewTimer);
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
      render();
    }
  }

  async function listLocal() {
    try {
      const n = await loadLocalFonts();
      toast(`이 컴퓨터의 글꼴 ${n}개를 불러왔습니다 (내 글꼴)`);
      cat = 'mine';
      render();
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
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  sampleInput.addEventListener('input', () => {
    text = sampleInput.value || '가나다라 Abc 123';
    for (const el of list.querySelectorAll('.fp-preview')) el.textContent = text;
    for (const el of items) loadFontFor(el.dataset.family, text).catch(() => {});
  });
  list.addEventListener('pointerleave', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => onPreview(null), 120);
  });

  render();
  search.focus();
  open = { close };
  return open;
}

function loadCat() {
  try { return localStorage.getItem('montage.fontCat') || 'all'; } catch { return 'all'; }
}
function saveCat(v) {
  try { localStorage.setItem('montage.fontCat', v); } catch { /* storage unavailable */ }
}

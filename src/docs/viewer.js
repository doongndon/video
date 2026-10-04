// The manual: a full-screen reader with a page list, search, an "on this page" outline and
// previous / next links. Opened from Help ▸ 설명서, the 설명서 button or a #docs/<page> link.

import { h } from '../util.js';
import { START, VIDEO, AI } from './content-video.js';
import { PHOTO, HELP } from './content-photo.js';
import { render, plain } from './render.js';

export const GROUPS = [
  { id: 'start', title: '시작하기', pages: START },
  { id: 'video', title: '영상 편집', pages: VIDEO },
  { id: 'ai', title: 'AI 편집', pages: AI },
  { id: 'photo', title: '사진 편집', pages: PHOTO },
  { id: 'help', title: '도움', pages: HELP },
];
const PAGES = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g })));
const BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));

// ---------------------------------------------------------------- icons (16×16, stroke)

const ICONS = {
  home: '<path d="M2.5 7.5 8 3l5.5 4.5V13H9.5v-3h-3v3h-4z"/>',
  layout: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M6 6v7.5"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
  save: '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4"/>',
  folder: '<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>',
  timeline: '<path d="M2 4h7M5 8h9M2 12h6"/><path d="M11 2v12" stroke-dasharray="1.5 1.3"/>',
  sliders: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="5" cy="12" r="1.4"/>',
  motion: '<circle cx="12" cy="4" r="1.8"/><path d="M2.5 13.5c3-1 4-6 8-8.3" stroke-dasharray="1.8 1.4"/>',
  sparkle: '<path d="M7 2l1.2 3.3L11.5 6.5 8.2 7.7 7 11 5.8 7.7 2.5 6.5l3.3-1.2zM12 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  wand: '<path d="M3 13 11 5M10 3.5l1.2 1.2M12.5 6l1.2 1.2M12 2v1.6M14 4h-1.6"/>',
  palette: '<path d="M8 2a6 6 0 1 0 0 12c1 0 1.5-.8 1-1.7-.5-.9 0-1.8 1-1.8h1.5A2.5 2.5 0 0 0 14 8a6 6 0 0 0-6-6z"/><circle cx="5" cy="7" r=".8"/><circle cx="8" cy="5" r=".8"/><circle cx="11" cy="7" r=".8"/>',
  mask: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><circle cx="8" cy="8" r="3.2"/>',
  fx: '<path d="M3 13V5.5a2 2 0 0 1 2-2h1.5M2.5 8H6M8.5 7l4 5M12.5 7l-4 5"/>',
  speed: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l3-4"/>',
  audio: '<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',
  text: '<path d="M3 3.5h10M8 3.5v9.5M6 13h4"/>',
  grid: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
  export: '<path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5v4h10v-4"/>',
  ai: '<path d="M6.5 2.5 7.6 5.4 10.5 6.5 7.6 7.6 6.5 10.5 5.4 7.6 2.5 6.5 5.4 5.4z"/><path d="M11.5 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
  script: '<path d="M4 2.5h6l2.5 2.5v8.5H4z"/><path d="M6 7h5M6 9.5h5M6 12h3"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  tools: '<path d="M10.5 2.5a3 3 0 0 0-3.2 4L2.5 11.3l2.2 2.2 4.8-4.8a3 3 0 0 0 4-3.2l-1.8 1.8-2-.4-.4-2z"/>',
  select: '<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.6"/>',
  scissors: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10 12 2.5M10 10 4 2.5"/>',
  layers: '<path d="M8 2.5 14 5.5 8 8.5 2 5.5z"/><path d="M2 8.5l6 3 6-3M2 11.2l6 3 6-3"/>',
  style: '<rect x="3" y="3" width="8" height="8" rx="1"/><path d="M5.5 13.5h7.5a.5.5 0 0 0 .5-.5V5.5"/>',
  box: '<path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5 8 7.5 13.5 5M8 7.5v6"/>',
  brush: '<path d="M13.5 2.5 7 9l-1.5-1.5L12 1z" transform="translate(0 .5)"/><path d="M5.5 8.5c-2 0-3 1.5-3 3.5v1.5H4c2 0 3.5-1 3.5-3z"/>',
  heal: '<rect x="2" y="5.5" width="12" height="5" rx="2.5" transform="rotate(-45 8 8)"/><path d="M7 7l2 2M9 7l-2 2"/>',
  pen: '<path d="M8 2 12 8l-2.5 4.5h-3L4 8z"/><path d="M8 2v5M6.5 14h3"/><circle cx="8" cy="8" r=".8"/>',
  transform: '<rect x="3.5" y="3.5" width="9" height="9"/><path d="M2 2h3v3H2zM11 2h3v3h-3zM2 11h3v3H2zM11 11h3v3h-3z"/>',
  adjust: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor"/>',
  ruler: '<path d="M1.5 11 11 1.5l3.5 3.5L5 14.5z"/><path d="M4.5 8l1.5 1.5M6.5 6l2 2M8.5 4l1.5 1.5"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1"/><path d="M4 6.5h.1M6.5 6.5h.1M9 6.5h.1M11.5 6.5h.1M4.5 9.5h7"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v4M8 4.8v.1"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2v.4M8 11.6v.1"/>',
  book: '<path d="M2.5 3.5c2-.8 3.8-.6 5.5.8 1.7-1.4 3.5-1.6 5.5-.8v9c-2-.8-3.8-.6-5.5.8-1.7-1.4-3.5-1.6-5.5-.8zM8 4.3v9"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 13.5 13.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  left: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  right: '<path d="M6 3.5 10.5 8 6 12.5"/>',
};

function svg(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ICONS.book;
  return s;
}

// ---------------------------------------------------------------- search

const INDEX = PAGES.map((p) => ({ p, title: p.title.toLowerCase(), text: `${p.summary} ${plain(p.body)}`.replace(/\s+/g, ' ') }));

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const e of INDEX) {
    const low = e.text.toLowerCase();
    if (!terms.every((t) => e.title.includes(t) || low.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (e.title.includes(t)) score += 10;
      score += Math.min(5, low.split(t).length - 1);
    }
    const at = Math.max(0, ...terms.map((t) => low.indexOf(t)).filter((x) => x >= 0).slice(0, 1));
    const from = Math.max(0, at - 30);
    const snip = `${from ? '…' : ''}${e.text.slice(from, from + 110)}…`;
    out.push({ p: e.p, score, snip });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}

function marked(text, terms) {
  if (!terms.length) return [text];
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', part) : part));
}

/** Wrap search terms found in an element's text in <mark>. */
function highlightIn(el, terms) {
  if (!terms.length) return null;
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (re.test(n.data)) hits.push(n);
  let first = null;
  for (const n of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.data.replace(re, (m, off) => {
      frag.append(n.data.slice(last, off));
      const mk = h('mark.docs-hit', m);
      first ||= mk;
      frag.append(mk);
      last = off + m.length;
      return m;
    });
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
  return first;
}

// ---------------------------------------------------------------- viewer

let root = null;
let api = null;
const pref = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    /* storage may be blocked */
  }
  return null;
};

/** Open the manual at a page (id) or the first page. */
export function openDocs(id = null, { query = '' } = {}) {
  if (!root) build();
  root.hidden = false;
  document.body.classList.add('docs-open');
  api.show(BY_ID[id] ? id : api.current || 'intro', query);
  setTimeout(() => api.focus(), 0);
}

export function closeDocs() {
  if (!root || root.hidden) return;
  root.hidden = true;
  document.body.classList.remove('docs-open');
  if (location.hash.startsWith('#docs')) history.replaceState(null, '', location.pathname + location.search);
}

function build() {
  const theme = pref('montage.docs.theme') || 'light';
  const themeBtn = h('button.docs-iconbtn', { 'aria-label': '밝게 / 어둡게', title: '밝게 / 어둡게' });
  const setTheme = (t) => {
    root.dataset.theme = t;
    themeBtn.replaceChildren(svg(t === 'dark' ? 'sun' : 'moon', 18));
    pref('montage.docs.theme', t);
  };
  themeBtn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

  const input = h('input.docs-search', { type: 'search', placeholder: '기능 이름으로 찾기 (예: 누끼, 자막, 키프레임)', 'aria-label': '설명서 검색', autocomplete: 'off' });
  const results = h('div.docs-results', { role: 'listbox', hidden: true });
  const navBtn = h('button.docs-iconbtn.docs-navbtn', { 'aria-label': '목차', title: '목차' }, svg('menu', 18));
  const closeBtn = h('button.docs-iconbtn', { 'aria-label': '설명서 닫기', title: '닫기 (Esc)', onclick: closeDocs }, svg('close', 18));
  const top = h('header.docs-top',
    navBtn,
    h('div.docs-brand', svg('book', 20), h('span', 'Montage'), h('span.docs-brand-sub', '설명서')),
    h('div.docs-searchwrap', svg('search', 16), input, h('kbd.docs-slash', '/'), results),
    themeBtn, closeBtn);

  const side = h('nav.docs-side', { 'aria-label': '설명서 목차' });
  const links = new Map();
  for (const g of GROUPS) {
    side.append(h('div.docs-side-group', g.title));
    for (const p of g.pages) {
      const a = h('a.docs-side-link', { href: `#docs/${p.id}`, onclick: (e) => { e.preventDefault(); show(p.id); } }, svg(p.icon), h('span', p.title));
      links.set(p.id, a);
      side.append(a);
    }
  }
  const article = h('article.docs-article');
  const main = h('main.docs-main', article);
  const toc = h('aside.docs-toc', { 'aria-label': '이 쪽의 내용' });
  const scrim = h('div.docs-scrim', { onclick: () => root.classList.remove('nav-open') });
  root = h('div#docs.docs-root', { hidden: true, role: 'dialog', 'aria-label': 'Montage 설명서' }, top, h('div.docs-body', side, scrim, main, toc));
  document.body.append(root);
  setTheme(theme);
  navBtn.addEventListener('click', () => root.classList.toggle('nav-open'));

  let observer = null;
  function show(id, query = '') {
    const p = BY_ID[id];
    if (!p) return;
    api.current = id;
    root.classList.remove('nav-open');
    for (const [pid, a] of links) a.classList.toggle('on', pid === id);
    links.get(id)?.scrollIntoView({ block: 'nearest' });
    const { nodes, headings } = render(p.body);
    const i = PAGES.indexOf(p);
    const prev = PAGES[i - 1];
    const next = PAGES[i + 1];
    const pager = (q, dir) => q && h(`a.docs-pager.${dir}`, { href: `#docs/${q.id}`, onclick: (e) => { e.preventDefault(); show(q.id); } },
      h('small', dir === 'prev' ? '이전' : '다음'), h('span', dir === 'prev' ? svg('left') : null, q.title, dir === 'next' ? svg('right') : null));
    article.replaceChildren(
      h('div.docs-crumb', p.group.title),
      h('h1', p.title),
      h('p.docs-lead', p.summary),
      ...nodes,
      h('nav.docs-pagers', pager(prev, 'prev') || h('span'), pager(next, 'next') || h('span')));
    // on this page
    observer?.disconnect();
    toc.replaceChildren();
    if (headings.length) {
      const tl = new Map();
      toc.append(h('div.docs-toc-title', '이 쪽의 내용'), ...headings.map((hd) => {
        const a = h(`a.docs-toc-link.l${hd.level}`, { href: `#${hd.id}`, onclick: (e) => { e.preventDefault(); article.querySelector(`#${CSS.escape(hd.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, hd.text.replace(/\*\*|`|\[\[|\]\]/g, ''));
        tl.set(hd.id, a);
        return a;
      }));
      observer = new IntersectionObserver((ents) => {
        for (const en of ents) {
          if (!en.isIntersecting) continue;
          for (const a of tl.values()) a.classList.remove('on');
          tl.get(en.target.id)?.classList.add('on');
        }
      }, { root: main, rootMargin: '0px 0px -70% 0px' });
      for (const hd of headings) observer.observe(article.querySelector(`#${CSS.escape(hd.id)}`));
    }
    main.scrollTop = 0;
    const hit = highlightIn(article, query.toLowerCase().split(/\s+/).filter(Boolean));
    if (hit) hit.scrollIntoView({ block: 'center' });
    const hash = `#docs/${id}`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }

  // search box
  let sel = 0;
  let found = [];
  const renderResults = () => {
    const q = input.value.trim();
    found = search(q);
    sel = 0;
    results.hidden = !q;
    if (!q) return;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    results.replaceChildren(...(found.length ? found.map((r, k) => h(`button.docs-result${k === sel ? '.on' : ''}`, { role: 'option', onmousedown: (e) => e.preventDefault(), onclick: () => pick(k) },
      h('span.docs-result-title', svg(r.p.icon), marked(r.p.title, terms), h('small', r.p.group.title)),
      h('span.docs-result-snip', marked(r.snip, terms)))) : [h('div.docs-noresult', `"${q}"에 맞는 쪽이 없어요. 다른 말로 찾아보세요.`)]));
  };
  const pick = (k) => {
    const r = found[k];
    if (!r) return;
    const q = input.value.trim();
    input.value = '';
    results.hidden = true;
    show(r.p.id, q);
    main.focus({ preventScroll: true });
  };
  input.addEventListener('input', renderResults);
  input.addEventListener('focus', () => input.value && renderResults());
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!found.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
      [...results.children].forEach((c, k) => c.classList.toggle('on', k === sel));
      results.children[sel]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(sel);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (input.value) {
        input.value = '';
        results.hidden = true;
      } else input.blur();
    }
  });
  // keys inside the manual don't reach the editors
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && e.target !== input) closeDocs();
    else if (e.key === '/' && e.target !== input) {
      e.preventDefault();
      input.focus();
    }
  });
  root.addEventListener('keyup', (e) => e.stopPropagation());
  // focus outside the manual (after a click on nothing): keys still belong to the manual, not the editors
  window.addEventListener('keydown', (e) => {
    if (root.hidden || root.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Escape') closeDocs();
    else if (e.key === '/') {
      e.preventDefault();
      input.focus();
    }
  }, true);

  api = {
    current: null,
    show,
    focus() {
      // keys typed while the manual is open stay inside it (see the keydown handler above)
      main.focus({ preventScroll: true });
    },
  };
  main.tabIndex = -1;
  root.tabIndex = -1;
}

/** Open the manual if the address asks for it (#docs or #docs/<page>). */
export function openFromHash() {
  const m = location.hash.match(/^#docs(?:\/([\w-]+))?/);
  if (m) openDocs(m[1] || 'intro');
}

export const DOC_PAGES = PAGES;

// The manual: a full-screen reader with a page list, search, an "on this page" outline and
// previous / next links. Opened from Help ▸ 설명서, the 설명서 button or a #docs/<page> link.

import { h } from '../util.js';
import { START, VIDEO, AI } from './content-video.js';
import { PHOTO, HELP } from './content-photo.js';
import { render, plain } from './render.js';
import { svg } from './icons.js';

export const GROUPS = [
  { id: 'start', title: '시작하기', pages: START },
  { id: 'video', title: '영상 편집', pages: VIDEO },
  { id: 'ai', title: 'AI 편집', pages: AI },
  { id: 'photo', title: '사진 편집', pages: PHOTO },
  { id: 'help', title: '도움', pages: HELP },
];
const PAGES = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g })));
const BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));

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
// standalone: the website's docs page (docs.html) rather than the overlay inside the editors
let standalone = false;
const pageHash = (id) => (standalone ? `#${id}` : `#docs/${id}`);
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
  if (!root || root.hidden || standalone) return;
  root.hidden = true;
  document.body.classList.remove('docs-open');
  if (location.hash.startsWith('#docs')) history.replaceState(null, '', location.pathname + location.search);
}

/**
 * The manual as a page of the website: fills the window, links back to the site, and keeps the
 * page in the address as #<page> (?q= opens a search).
 */
export function mountDocs() {
  standalone = true;
  build();
  root.hidden = false;
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    return BY_ID[id] ? id : null;
  };
  const q = new URLSearchParams(location.search).get('q') || '';
  const asked = fromHash();
  api.show(asked || 'intro');
  window.addEventListener('hashchange', () => {
    const id = fromHash();
    if (id && id !== api.current) api.show(id);
  });
  // a search from the website: show the matching pages in the search box
  if (q && !asked) api.search(q);
  else api.focus();
}

function build() {
  const sys = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = pref('montage.docs.theme') || sys;
  const themeBtn = h('button.docs-iconbtn', { 'aria-label': '밝게 / 어둡게', title: '밝게 / 어둡게' });
  const setTheme = (t, save = true) => {
    root.dataset.theme = t;
    if (standalone) document.documentElement.dataset.theme = t;
    themeBtn.replaceChildren(svg(t === 'dark' ? 'sun' : 'moon', 18));
    if (save) pref('montage.docs.theme', t);
  };
  themeBtn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

  const input = h('input.docs-search', { type: 'search', placeholder: '기능 이름으로 찾기 (예: 누끼, 자막, 키프레임)', 'aria-label': '설명서 검색', autocomplete: 'off' });
  const results = h('div.docs-results', { role: 'listbox', hidden: true });
  const navBtn = h('button.docs-iconbtn.docs-navbtn', { 'aria-label': '목차', title: '목차' }, svg('menu', 18));
  const closeBtn = h('button.docs-iconbtn', { 'aria-label': '설명서 닫기', title: '닫기 (Esc)', onclick: closeDocs }, svg('close', 18));
  const brandBody = [svg(standalone ? 'film' : 'book', 20), h('span', 'Montage'), h('span.docs-brand-sub', '설명서')];
  const siteLinks = [['index.html', '홈'], ['video.html', '영상 편집'], ['photo.html', '사진 편집'], ['docs.html', '설명서']];
  const top = h('header.docs-top',
    navBtn,
    standalone ? h('a.docs-brand', { href: 'index.html', title: 'Montage 홈' }, ...brandBody) : h('div.docs-brand', ...brandBody),
    h('div.docs-searchwrap', svg('search', 16), input, h('kbd.docs-slash', '/'), results),
    standalone ? h('nav.docs-sitelinks', { 'aria-label': '웹사이트' }, ...siteLinks.slice(0, 3).map(([href, t]) => h('a', { href }, t))) : null,
    themeBtn,
    standalone ? h('a.docs-applink', { href: 'app.html' }, svg('open', 16), h('span', '편집기 열기')) : closeBtn);

  const side = h('nav.docs-side', { 'aria-label': '설명서 목차' });
  if (standalone) {
    // on phones the page list is also the site menu
    side.append(h('div.docs-side-site', ...siteLinks.map(([href, t]) => h('a', { href, class: href === 'docs.html' ? 'on' : null }, t)), h('a.docs-side-app', { href: 'app.html' }, '편집기 열기')));
  }
  const links = new Map();
  for (const g of GROUPS) {
    side.append(h('div.docs-side-group', g.title));
    for (const p of g.pages) {
      const a = h('a.docs-side-link', { href: pageHash(p.id), onclick: (e) => { e.preventDefault(); show(p.id); } }, svg(p.icon), h('span', p.title));
      links.set(p.id, a);
      side.append(a);
    }
  }
  const article = h('article.docs-article');
  const main = h('main.docs-main', article);
  const toc = h('aside.docs-toc', { 'aria-label': '이 쪽의 내용' });
  const scrim = h('div.docs-scrim', { onclick: () => root.classList.remove('nav-open') });
  root = h(`div#docs.docs-root${standalone ? '.standalone' : ''}`, { hidden: true, role: standalone ? null : 'dialog', 'aria-label': 'Montage 설명서' }, top, h('div.docs-body', side, scrim, main, toc));
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
    const pager = (q, dir) => q && h(`a.docs-pager.${dir}`, { href: pageHash(q.id), onclick: (e) => { e.preventDefault(); show(q.id); } },
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
    const hash = pageHash(id);
    if (standalone) document.title = `${p.title} — Montage 설명서`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${standalone ? '' : location.search}${hash}`);
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
      h('span.docs-result-snip', marked(r.snip, terms)))) : [h('div.docs-noresult', `"${q}"에 맞는 쪽이 없다. 다른 말로 찾아본다.`)]));
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
    search(q) {
      input.value = q;
      renderResults();
      input.focus();
    },
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

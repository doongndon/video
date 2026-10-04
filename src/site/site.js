// The website around the editors: the shared header (menu), footer, light / dark switch, the
// phone menu and the little timeline in the home page's hero.

import { h } from '../util.js';
import { svg } from '../docs/icons.js';

export const NAV = [
  ['index.html', '홈', 'home'],
  ['video.html', '영상 편집', 'timeline'],
  ['photo.html', '사진 편집', 'image'],
  ['docs.html', '설명서', 'book'],
];
export const APPS = [
  ['app.html?mode=video', '영상 편집기', 'timeline', 'video', '타임라인, 효과, 자막, 내보내기'],
  ['app.html?mode=photo', '사진 편집기', 'image', 'photo', '레이어, 선택, 고치기, 필터'],
];
const THEME_KEY = 'montage.docs.theme'; // shared with the manual

function pref(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    /* storage may be blocked: the theme just follows the system */
  }
  return null;
}

const page = () => location.pathname.split('/').pop() || 'index.html';
const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

function themeButton() {
  const b = h('button.iconbtn', { type: 'button', 'aria-label': '밝게 / 어둡게 보기', title: '밝게 / 어둡게' });
  const paint = () => b.replaceChildren(svg(isDark() ? 'sun' : 'moon', 18));
  b.addEventListener('click', () => {
    const t = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    pref(THEME_KEY, t);
    paint();
  });
  paint();
  return b;
}

function appMenu() {
  const d = h('details.appmenu',
    h('summary.btn.btn-ink.small', svg('open', 16), '편집기 열기'),
    h('div.appmenu-panel', ...APPS.map(([href, name, icon, kind, sub]) => h('a', { href },
      h(`span.appmenu-ico.${kind}`, svg(icon, 18)), h('span', h('strong', name), h('small', sub))))));
  document.addEventListener('click', (e) => {
    if (!d.contains(e.target)) d.open = false;
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') d.open = false;
  });
  return d;
}

export function buildHeader(el) {
  const cur = page();
  const link = ([href, label, icon], withIcon = false) => h('a', { href, 'aria-current': href === cur ? 'page' : null }, withIcon ? svg(icon, 18) : null, label);
  const menuBtn = h('button.iconbtn.menu-btn', { type: 'button', 'aria-label': '메뉴', 'aria-expanded': 'false' }, svg('menu', 20));
  menuBtn.addEventListener('click', () => {
    const open = el.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.replaceChildren(svg(open ? 'close' : 'menu', 20));
  });
  el.replaceChildren(
    h('div.wrap.head-row',
      h('a.brand', { href: 'index.html', 'aria-label': 'Montage 홈' }, h('span.brand-mark', svg('film', 18)), 'Montage'),
      h('nav.nav', { 'aria-label': '사이트 메뉴' }, ...NAV.map((n) => link(n))),
      h('div.head-tools', themeButton(), appMenu(), menuBtn)),
    h('nav.wrap.mobile-nav', { 'aria-label': '사이트 메뉴' },
      ...NAV.map((n) => link(n, true)),
      h('div.mobile-apps', ...APPS.map(([href, name, , kind]) => h(`a.btn.btn-${kind}`, { href }, name)))));
}

export function buildFooter(el) {
  const col = (title, items) => h('div', h('h4', title), h('ul', ...items.map(([href, t]) => h('li', h('a', { href }, t)))));
  el.replaceChildren(h('div.wrap',
    h('div.foot-grid',
      h('div',
        h('a.brand', { href: 'index.html' }, h('span.brand-mark', svg('film', 18)), 'Montage'),
        h('p', { style: { margin: '12px 0 0', maxWidth: '24em' } }, '설치 없이 브라우저에서 쓰는 영상·사진 편집기. 가져온 파일은 내 컴퓨터 밖으로 나가지 않아요.')),
      col('편집기', [['app.html?mode=video', '영상 편집기 열기'], ['app.html?mode=photo', '사진 편집기 열기'], ['video.html', '영상 편집 기능'], ['photo.html', '사진 편집 기능']]),
      col('설명서', [['docs.html#intro', '시작하기'], ['docs.html#shortcuts', '단축키 모음'], ['docs.html#faq', '문제 해결'], ['docs.html#limits', '알려진 제한']]),
      col('저장과 기기', [['docs.html#saving', '저장과 불러오기'], ['docs.html#mobile', '휴대폰에서 쓰기'], ['docs.html#ai-start', 'AI 편집 시작하기'], ['docs.html#p-save', '사진 저장과 내보내기']])),
    h('div.foot-legal',
      h('p', { style: { margin: '0 0 6px' } }, 'Montage는 Premiere Pro와 Photoshop의 작업 방식을 참고해 만든 독립 프로젝트이며 Adobe와 관계가 없습니다. Premiere Pro와 Photoshop은 Adobe의 상표입니다.'),
      h('p', { style: { margin: 0 } }, '함께 쓰는 오픈 소스: mediabunny (MPL-2.0), ag-psd (MIT), transformers.js (Apache-2.0, 자동 자막을 쓸 때 불러옴).'))));
}

/** The hero timeline: the playhead runs and its timecode counts like the editor's (30 fps). */
function runTimeline() {
  const tl = document.querySelector('.tl');
  if (!tl) return;
  const ph = tl.querySelector('.playhead');
  const label = ph?.querySelector('span');
  const lane = tl.querySelector('.tl-lane');
  if (!ph || !label || !lane) return;
  const total = 12; // seconds shown by the ruler
  const tc = (t) => {
    const f = Math.floor(t * 30);
    const p = (n) => String(n).padStart(2, '0');
    return `00:00:${p(Math.floor(f / 30))}:${p(f % 30)}`;
  };
  const place = (t) => {
    ph.style.left = `calc(44px + (100% - 44px) * ${t / total})`;
    label.textContent = tc(t);
  };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    place(1.5);
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    place((((now - t0) / 1000) * 0.6 + 1.5) % total);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Search forms on the site open the manual with the query. */
function wireSearch() {
  for (const f of document.querySelectorAll('form[data-docs-search]')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = f.querySelector('input')?.value.trim();
      location.href = q ? `docs.html?q=${encodeURIComponent(q)}` : 'docs.html';
    });
  }
}

export function initSite() {
  const t = pref(THEME_KEY);
  if (t) document.documentElement.dataset.theme = t;
  const head = document.getElementById('site-header');
  const foot = document.getElementById('site-footer');
  if (head) buildHeader(head);
  if (foot) buildFooter(foot);
  // icons placed in the static pages as <i data-icon="name">
  for (const i of document.querySelectorAll('i[data-icon]')) i.replaceWith(svg(i.dataset.icon, +(i.dataset.size || 16)));
  runTimeline();
  wireSearch();
}

initSite();

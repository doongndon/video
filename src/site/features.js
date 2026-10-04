// Feature pages (video.html, photo.html): one section per manual page, built from the manual's
// own content so the site and the manual never disagree.

import { h } from '../util.js';
import { svg } from '../docs/icons.js';
import { START, VIDEO, AI } from '../docs/content-video.js';
import { PHOTO, HELP } from '../docs/content-photo.js';
import { inline } from '../docs/render.js';

const GROUPS = {
  video: [
    { id: 'video', title: '영상 편집', kind: 'video', pages: VIDEO, intro: '미디어를 가져와 타임라인에 놓고, 자르고, 움직이고, 색과 소리를 고친 뒤 내보내는 과정 전체를 담았어요.' },
    { id: 'ai', title: 'AI 편집', kind: 'ai', pages: AI, intro: 'Google Gemini에 내 API 키를 넣으면 켜져요. 자동 자막은 키 없이도 브라우저 안에서 돌아가요.' },
  ],
  photo: [
    { id: 'photo', title: '사진 편집', kind: 'photo', pages: PHOTO, intro: '문서를 만들고, 레이어를 쌓고, 고르고, 고치고, 꾸민 뒤 저장하는 과정 전체를 담았어요.' },
  ],
};
const RELATED = {
  video: ['intro', 'saving', 'mobile', 'shortcuts', 'limits', 'faq'],
  photo: ['p-start', 'saving', 'mobile', 'shortcuts', 'limits', 'faq'],
};
const ALL = [...START, ...VIDEO, ...AI, ...PHOTO, ...HELP];

/** The page's first plain paragraph (not a heading, list, table or box). */
function firstParagraph(body) {
  for (const block of body.trim().split(/\n\s*\n/)) {
    const lines = block.trim().split('\n').filter((l) => !/^(#{2,3} |\||- |\d+\. |!?> )/.test(l));
    if (lines.length) return lines.join(' ');
  }
  return '';
}

const topics = (body) => [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

function section(p, kind) {
  const paras = firstParagraph(p.body);
  const ts = topics(p.body);
  return h('article.feature', { id: p.id },
    h('div.feature-side', h(`span.ico.${kind}`, svg(p.icon, 22)), h('h3', p.title)),
    h('div',
      h('p.sum', p.summary),
      paras ? h('p.desc', inline(paras)) : null,
      ts.length ? h('ul.chips', { 'aria-label': '이 기능에서 다루는 것' }, ...ts.map((t) => h('li', h('span', inline(t))))) : null,
      h('a.more', { href: `docs.html#${p.id}` }, '설명서에서 자세히 보기', svg('arrow'))));
}

export function renderFeatures(which) {
  const groups = GROUPS[which];
  const nav = document.getElementById('subnav');
  const main = document.getElementById('features');
  const links = new Map();
  for (const g of groups) {
    for (const p of g.pages) {
      const a = h('a', { href: `#${p.id}` }, svg(p.icon, 14), p.title);
      links.set(p.id, a);
      nav.append(a);
    }
  }
  for (const g of groups) {
    main.append(
      h('div.group-head', { id: `g-${g.id}` },
        h(`p.kicker.${g.kind}`, svg(g.kind === 'ai' ? 'ai' : g.kind === 'photo' ? 'image' : 'timeline'), `${g.pages.length}가지 기능 묶음`),
        h('h2', g.title), h('p', g.intro)),
      h('div.features', ...g.pages.map((p) => section(p, g.kind))));
  }
  const rel = document.getElementById('related');
  if (rel) {
    rel.append(h('ul.chips', ...RELATED[which].map((id) => {
      const p = ALL.find((x) => x.id === id);
      return p && h('li', h('a', { href: `docs.html#${id}` }, svg(p.icon, 14), p.title));
    })));
  }
  // highlight the section in view
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('on');
      const a = links.get(e.target.id);
      if (a) {
        a.classList.add('on');
        // keep the active chip visible without moving the page
        nav.scrollTo({ left: a.offsetLeft - nav.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' });
      }
    }
  }, { rootMargin: '-35% 0px -60% 0px' });
  for (const el of main.querySelectorAll('.feature')) io.observe(el);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

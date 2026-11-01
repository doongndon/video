// The photo editor's top bar, like Photoshop's: the app mark and the menus at the left, and at the
// right a small 영상 / 사진 switch and icon buttons (search, workspace, share-like export). The bar
// itself belongs to src/ui/menubar.js; this adds the photo-only buttons, and photo.css styles the
// bar under body.photo-mode.

import { h } from '../util.js';
import { showMenu, toast } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { TOOLS } from './tools.js';
import { popover, toolIcon, toolTitle } from './panels.js';

const list = (x) => (typeof x === 'function' ? x() : x) || [];

/** Every menu command as [path, item], e.g. ['필터 ▸ 흐림 효과 ▸ 가우시안 흐림…', item]. */
function menuCommands(P) {
  const out = [];
  const walk = (items, path, depth) => {
    for (const it of list(items)) {
      if (!it || typeof it !== 'object' || !it.label) continue;
      const p = path ? `${path} ▸ ${it.label}` : it.label;
      if (it.submenu) {
        if (depth < 3) {
          try {
            walk(it.submenu, p, depth + 1);
          } catch { /* a submenu that needs a document */ }
        }
      } else if (it.action) out.push([p, it]);
    }
  };
  for (const [name, items] of Object.entries(P.menus || {})) {
    try {
      walk(items, name, 1);
    } catch { /* skip a menu that can't be listed now */ }
  }
  return out;
}

/** Photoshop's search (the magnifier at the top right): tools and menu commands by name. */
function openSearch(P, anchor) {
  if (document.querySelector('.ph-pop.ph-search')) return document.querySelector('.ph-pop.ph-search').close();
  const q = h('input', { type: 'search', placeholder: '도구, 메뉴 찾기 (예: 흐림, 레이어 복제)', 'aria-label': '도구와 메뉴 찾기' });
  const box = h('div.ph-search-list', { role: 'listbox' });
  const cmds = menuCommands(P);
  let rows = [];
  let at = 0;
  const run = (r) => {
    pop.close();
    if (r.disabled) return toast('지금은 쓸 수 없는 명령입니다 (문서나 레이어를 먼저 고르세요)');
    return r.run();
  };
  const paint = () => {
    const s = q.value.trim().toLowerCase().replace(/\s+/g, '');
    rows = [];
    if (s) {
      const hit = (txt) => txt.toLowerCase().replace(/\s+/g, '').includes(s);
      for (const t of TOOLS) if (hit(t.name) || hit(toolTitle(t))) rows.push({ ico: toolIcon(t, 15), label: toolTitle(t), hint: t.key ? `도구 · ${t.key}` : '도구', run: () => P.setTool(t.id) });
      for (const [path, it] of cmds) {
        if (rows.length >= 40) break;
        if (hit(it.label) || hit(path)) rows.push({ ico: icon('menu', 14), label: it.label, hint: path.split(' ▸ ').slice(0, -1).join(' ▸ ') + (it.key ? ` · ${it.key}` : ''), disabled: !!it.disabled, run: () => it.action() });
      }
    }
    at = Math.min(at, Math.max(0, rows.length - 1));
    box.replaceChildren(...rows.slice(0, 40).map((r, i) => h(`button.ph-search-row${i === at ? '.on' : ''}${r.disabled ? '.off' : ''}`, { role: 'option', 'aria-selected': String(i === at), onclick: () => run(r) }, r.ico, h('span', r.label), h('small', r.hint))),
      ...(s && !rows.length ? [h('div.empty-hint', '찾는 항목이 없습니다')] : []),
      ...(!s ? [h('div.empty-hint', '도구 이름이나 메뉴 이름을 입력하세요')] : []));
    box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  q.addEventListener('input', () => { at = 0; paint(); });
  q.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      paint();
    } else if (e.key === 'Enter' && rows[at]) run(rows[at]);
    else if (e.key === 'Escape') pop.close();
  });
  const pop = popover(anchor, q, box);
  pop.classList.add('ph-search');
  // keep it inside the window at the right edge
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 4))}px`;
  paint();
  q.focus();
  return undefined;
}

/** Window ▸ Workspace as a menu under the workspace icon. */
function workspaceMenu(P, anchor) {
  const ws = list(P.menus?.['창']).find((it) => it?.label === '작업 영역');
  const r = anchor.getBoundingClientRect();
  if (ws?.submenu) showMenu(ws.submenu, Math.max(4, r.right - 220), r.bottom + 2);
}

export function installTopBar(P) {
  const bar = document.getElementById('menubar');
  if (!bar || bar.querySelector('.ph-topicons')) return;
  // "영상 편집" → "영상" + " 편집" so the photo bar can show the short segmented switch
  for (const b of bar.querySelectorAll('.mode-btn')) {
    const m = /^(\S+)( 편집)$/.exec(b.textContent);
    if (m && b.childNodes.length === 1) b.replaceChildren(m[1], h('span.mode-sfx', m[2]));
  }
  const btn = (ic, label, fn) => h('button.ph-topbtn', { type: 'button', title: label, 'aria-label': label, onclick: (e) => fn(e.currentTarget) }, icon(ic, 16));
  bar.append(h('span.ph-topicons',
    btn('search', '찾기: 도구와 메뉴', (b) => openSearch(P, b)),
    btn('workspace', '작업 영역 고르기', (b) => workspaceMenu(P, b)),
    btn('share', '내보내기 (공유할 파일 만들기)', () => P.exportDialog())));
}

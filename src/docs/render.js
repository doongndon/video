// A small Markdown-like renderer for the manual pages. It builds DOM nodes (never innerHTML),
// so page text can't inject markup.
//   ## / ###        headings          - item / 1. item (sub-items indented 4 spaces)
//   | a | b |       tables            > tip box        !> warning box
//   **bold**  `code`  [[Ctrl+J]] keys

import { h } from '../util.js';

const INLINE = /(`[^`]+`)|(\*\*.+?\*\*)|(\[\[.+?\]\])/g;

/** Inline text → array of nodes. */
export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h('code', t.slice(1, -1)));
    else if (m[2]) out.push(h('strong', inline(t.slice(2, -2))));
    else out.push(h('kbd', t.slice(2, -2)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Plain text of a page body (for search). */
export function plain(text) {
  return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1').replace(/^\s*(#+|!?>|-|\d+\.)\s*/gm, '').replace(/\|/g, ' ').replace(/-{3,}/g, ' ');
}

export const slug = (s, i) => `s${i}-${s.replace(/[^\w가-힣]+/g, '-').slice(0, 30)}`;

/** Page body → { nodes, headings: [{ id, text, level }] }. */
export function render(src) {
  const lines = src.replace(/^\n+|\s+$/g, '').split('\n');
  const nodes = [];
  const headings = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{2,3} |\||- |\d+\. |!?> )/.test(l) || !l.trim();
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const hm = l.match(/^(#{2,3}) (.+)$/);
    if (hm) {
      const level = hm[1].length;
      const id = slug(hm[2], headings.length);
      headings.push({ id, text: hm[2], level });
      nodes.push(h(level === 2 ? 'h2' : 'h3', { id }, inline(hm[2])));
      i++;
      continue;
    }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      nodes.push(h('div.docs-table', h('table',
        h('thead', h('tr', head.map((c) => h('th', inline(c))))),
        h('tbody', body.map((r) => h('tr', head.map((_, k) => h('td', inline(r[k] || '')))))))));
      continue;
    }
    if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d+\. /.test(l);
      const list = h(ordered ? 'ol' : 'ul');
      let li = null;
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || /^ {4}(- |\d+\. )/.test(lines[i]))) {
        const sub = lines[i].match(/^ {4}(- |\d+\. )(.*)$/);
        if (sub && li) {
          let ul = li.querySelector(':scope > ul, :scope > ol');
          if (!ul) li.append((ul = h(/\d/.test(sub[1]) ? 'ol' : 'ul')));
          ul.append(h('li', inline(sub[2])));
        } else {
          li = h('li', inline(lines[i].replace(/^(- |\d+\. )/, '')));
          list.append(li);
        }
        i++;
      }
      nodes.push(list);
      continue;
    }
    const cm = l.match(/^(!?)> (.*)$/);
    if (cm) {
      const warn = cm[1] === '!';
      const parts = [cm[2]];
      i++;
      while (i < lines.length && /^!?> /.test(lines[i])) parts.push(lines[i++].replace(/^!?> /, ''));
      nodes.push(h(`div.docs-callout${warn ? '.warn' : ''}`, h('span.docs-callout-icon', calloutIcon(warn)), h('div', inline(parts.join(' ')))));
      continue;
    }
    const para = [l];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) para.push(lines[i++]);
    nodes.push(h('p', inline(para.join(' '))));
  }
  return { nodes, headings };
}

function calloutIcon(warn) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = warn
    ? '<path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    : '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.3v4M8 4.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
  return s;
}

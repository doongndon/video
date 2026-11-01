// Window ▸ Learn (창 ▸ 학습) and Help ▸ Hands-on tutorials: Photoshop-style practice lessons.
// Each lesson opens a practice document drawn in the browser (practice.js) and walks through step
// cards (lessons.js). '보여 주기' opens the real menu and points at the item, or points at the tool
// or panel; a step completes by itself when the app state matches, with '다음' as the fallback.
// Progress stays in this browser (prefs).

import { h } from '../util.js';
import { toast, showMenu, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { PhotoDoc, newLayer, restrictsChannels } from './doc.js';
import { TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { listPatterns } from './resources.js';
import * as PANELS from './panels.js';
import { LESSONS, LESSON_GROUPS, practiceFile } from './lessons.js';

const CSS = `
.lrn { padding: 8px 10px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; font-size: var(--fs-s); }
.lrn-head { display: flex; align-items: center; gap: 6px; }
.lrn-head b { flex: 1; font-size: var(--fs-m, 14px); }
.lrn-dim { color: var(--text-dim); line-height: 1.5; }
.lrn-faint { color: var(--text-faint); font-size: var(--fs-xs); }
.lrn-card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: rgba(255,255,255,.03); display: flex; flex-direction: column; gap: 6px; }
.lrn-card .lrn-row2 { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.lrn-group { margin-top: 4px; color: var(--text-faint); font-size: var(--fs-xs); letter-spacing: .03em; }
.lrn-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 1px solid transparent; border-radius: 6px; padding: 6px 8px; min-height: 0; color: var(--text); }
.lrn-item:hover { background: var(--sel, rgba(255,255,255,.06)); }
.lrn-item span:first-child { flex: 1; }
.lrn-item .lrn-faint { white-space: nowrap; }
.lrn-item .ok { color: #5cc87a; display: inline-flex; }
.lrn-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.lrn-bar i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.lrn-step { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.lrn-step.cur { border-color: var(--accent); background: rgba(74,163,255,.07); }
.lrn-step.done { opacity: .7; }
.lrn-step.flash { animation: lrn-flash .7s ease; }
.lrn-st { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; min-height: 0; text-align: left; color: var(--text); width: 100%; }
.lrn-st b { flex: 1; font-weight: 600; }
.lrn-num { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; background: var(--line); color: var(--text-dim); flex: none; }
.lrn-step.cur .lrn-num { background: var(--accent); color: #fff; }
.lrn-step.done .lrn-num { background: #2f7a47; color: #fff; }
.lrn-why { color: var(--text-dim); font-size: var(--fs-xs); line-height: 1.5; border-left: 2px solid var(--line); padding-left: 6px; }
.lrn-path { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: var(--fs-xs); }
.lrn-chip { border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; background: rgba(255,255,255,.04); white-space: nowrap; }
.lrn-key { font-family: ui-monospace, Menlo, Consolas, monospace; }
.lrn-auto { color: var(--text-faint); font-size: var(--fs-xs); display: inline-flex; align-items: center; gap: 4px; }
.lrn-done-card { text-align: center; align-items: center; }
.lrn-done-card .ok { color: #5cc87a; }
.lrn-ring { position: fixed; z-index: 2000; pointer-events: none; border: 2px solid var(--accent, #4aa3ff); border-radius: 6px; box-shadow: 0 0 0 4px rgba(74,163,255,.35), 0 0 18px rgba(74,163,255,.6); animation: lrn-pulse 1s ease-in-out infinite; }
.lrn-tip { position: fixed; z-index: 2001; max-width: 260px; background: #1d4f86; color: #fff; border-radius: 8px; padding: 7px 10px; font-size: 13px; line-height: 1.45; box-shadow: 0 6px 20px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 6px; }
.lrn-tip button { align-self: flex-end; background: rgba(255,255,255,.18); color: #fff; border: none; min-height: 0; padding: 3px 8px; border-radius: 5px; }
.lrn-coach { position: fixed; z-index: 800; left: 50%; top: 110px; transform: translateX(-50%); width: max-content; display: flex; align-items: center; gap: 8px; max-width: min(560px, calc(100vw - 24px)); background: #23272e; border: 1px solid var(--accent, #4aa3ff); border-radius: 10px; padding: 6px 8px 6px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 13px; }
.lrn-coach span { flex: 1 1 auto; min-width: 0; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrn-coach button { min-height: 0; padding: 4px 8px; white-space: nowrap; }
@keyframes lrn-pulse { 50% { box-shadow: 0 0 0 7px rgba(74,163,255,.15), 0 0 26px rgba(74,163,255,.75); } }
@keyframes lrn-flash { 0% { background: rgba(92,200,122,.35); } 100% { background: transparent; } }
`;

const isMobile = () => document.body.classList.contains('mobile');
const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const pathText = (path) => path.join(' ▸ ');

export function installLearn(P) {
  document.head.append(h('style', CSS));
  const el = h('div.lrn', { role: 'region', 'aria-label': '학습' });
  // where the learner is: { id, step } (step === steps.length: finished)
  let cur = loadPref('photo.learn.cur', null);
  if (cur && !LESSONS.find((l) => l.id === cur.id)) cur = null;
  const prog = loadPref('photo.learn.prog', {});
  let base = null;
  const shownPanels = new Set();
  const lesson = () => (cur ? LESSONS.find((l) => l.id === cur.id) : null);

  // panels opened through P.showPanel (Window menu, F7…) count for "open the … panel" steps
  const showPanel = P.showPanel;
  P.showPanel = (id, ...rest) => {
    shownPanels.add(id);
    return showPanel(id, ...rest);
  };

  // ---------------------------------------------------------------- state checks

  const sigOf = (l) => JSON.stringify(l.kind === 'adjust' ? l.adjust : l.kind === 'text' ? l.text : null);
  const labels = () => (P.doc?.history?.undoStack || []).map((e) => e.label || '');
  const tabOn = (id) => {
    const b = document.querySelector(`.ph-ptabs button[data-id="${id}"]`);
    if (b && b.classList.contains('on') && visible(b)) return true;
    const sheet = document.querySelector('.ph-sheet.open b');
    return !!sheet && !!b && sheet.textContent === b.textContent;
  };
  /** A snapshot taken when a step starts, so steps can ask "one more layer than before". */
  const snapshot = () => {
    const d = P.doc;
    const o = P.opts?.('brush') || {};
    shownPanels.clear();
    return {
      doc: d, count: d?.layers.length || 0, docs: P.docs.length, fg: P.fg, brushSize: o.size, brushHardness: o.hardness,
      patterns: listPatterns().length, sig: new Map((d?.layers || []).map((l) => [l.id, sigOf(l)])),
    };
  };
  const ctx = () => {
    const d = P.doc;
    const layers = d?.layers || [];
    const ls = labels();
    return {
      doc: d, layers, active: d?.active || null, tool: P.tool, sel: !!d?.selection, count: layers.length, base, fg: P.fg,
      docs: P.docs.length, transforming: !!P.transform, frames: d?.frames?.length || 0,
      patterns: listPatterns().length,
      channels: layers.some((l) => restrictsChannels(l)),
      did: (re) => ls.some((x) => re.test(x)),
      times: (re) => ls.filter((x) => re.test(x)).length,
      kind: (k) => layers.some((l) => l.kind === k),
      adj: (type) => layers.some((l) => l.kind === 'adjust' && l.adjust?.type === type),
      fx: (key) => layers.some((l) => [].concat(l.fx?.[key] || []).some((f) => f && f.enabled !== false)),
      blend: (mode) => layers.some((l) => l.blend === mode),
      named: (name) => layers.some((l) => l.name === name),
      panel: (id) => shownPanels.has(id) || tabOn(id),
      opt: (tool, key) => P.opts?.(tool)?.[key],
      modal: (re) => [...document.querySelectorAll('.modal .modal-title')].some((t) => re.test(t.textContent)),
      changed: (kind) => layers.some((l) => l.kind === kind && base.sig.has(l.id) && base.sig.get(l.id) !== sigOf(l)),
    };
  };

  // ---------------------------------------------------------------- progress

  const save = () => {
    savePref('photo.learn.cur', cur);
    savePref('photo.learn.prog', prog);
  };
  const setStep = (i) => {
    const L = lesson();
    if (!L) return;
    cur = { id: L.id, step: Math.max(0, Math.min(L.steps.length, i)) };
    prog[L.id] = Math.max(prog[L.id] || 0, cur.step);
    base = snapshot();
    save();
    render();
  };
  const open = (id) => {
    cur = { id, step: 0 };
    base = snapshot();
    save();
    render();
  };
  const advance = (auto) => {
    const L = lesson();
    if (!L || cur.step >= L.steps.length) return;
    const was = cur.step;
    setStep(cur.step + 1);
    if (auto) {
      el.querySelector(`.lrn-step[data-i="${was}"]`)?.classList.add('flash');
      if (cur.step >= L.steps.length) toast(`'${L.title}' 실습을 마쳤습니다`);
    }
    clearPointer();
  };

  /** Draws the lesson's practice picture into a new document and opens it. */
  P.openPracticeFile = (id) => {
    const L = LESSONS.find((l) => l.id === id);
    if (!L) return null;
    const f = practiceFile(L);
    const d = new PhotoDoc({ name: f.name, width: f.width, height: f.height, background: null });
    for (const x of f.layers) {
      const { canvas, ...props } = x;
      d.layers.push(newLayer('raster', { ...props, canvas }));
    }
    d.activeId = d.layers[f.active ?? d.layers.length - 1].id;
    d.saved = false;
    P.openDoc(d);
    cur = { id, step: 0 };
    base = snapshot();
    save();
    render();
    return d;
  };

  // the step completes by itself when the app state matches
  let timer = null;
  const tick = () => {
    const L = lesson();
    if (!L || cur.step >= L.steps.length) return;
    const st = L.steps[cur.step];
    if (!base) base = snapshot();
    let ok = false;
    try {
      ok = !!st.done?.(ctx());
    } catch { /* a check that needs a document */ }
    if (ok) advance(true);
    // another document came up: compare against it from now on
    else if (base.doc !== P.doc && !st.newDoc) base = snapshot();
    syncCoach();
  };
  const run = () => {
    clearInterval(timer);
    timer = setInterval(tick, 500);
  };

  // ---------------------------------------------------------------- pointing at the real UI

  let pointer = null;
  function clearPointer() {
    if (!pointer) return;
    cancelAnimationFrame(pointer.raf);
    clearTimeout(pointer.timer);
    pointer.ring.remove();
    pointer.tip.remove();
    document.removeEventListener('pointerdown', pointer.off, true);
    pointer = null;
  }
  /** A pulsing ring around `target` and a note next to it; goes away on the next press or after a while. */
  function pointAt(target, text, { back = false } = {}) {
    clearPointer();
    if (!target) return toast(text);
    target.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    const ring = h('div.lrn-ring');
    const tip = h('div.lrn-tip', { role: 'status' }, h('span', text),
      back ? h('button', { onclick: () => { clearPointer(); P.showPanel('learn'); } }, '학습으로 돌아가기') : null);
    document.body.append(ring, tip);
    const place = () => {
      const r = target.getBoundingClientRect();
      Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = r.right + 12;
      let y = r.top;
      if (x + tw > innerWidth - 8) {
        x = Math.max(8, Math.min(innerWidth - tw - 8, r.left));
        y = r.bottom + 10;
        if (y + th > innerHeight - 8) y = Math.max(8, r.top - th - 10);
      }
      Object.assign(tip.style, { left: `${x}px`, top: `${Math.max(8, Math.min(innerHeight - th - 8, y))}px` });
      if (!target.isConnected) clearPointer();
      else if (pointer) pointer.raf = requestAnimationFrame(place);
    };
    const off = (e) => {
      if (tip.contains(e.target)) return;
      // let the press reach the menu or button first
      setTimeout(clearPointer, 0);
    };
    pointer = { ring, tip, off, raf: 0, timer: setTimeout(clearPointer, 9000) };
    place();
    document.addEventListener('pointerdown', off, true);
  }

  const findText = (root, text) => [...(root || document).querySelectorAll('button, label, span, div')]
    .filter((x) => visible(x) && x.children.length <= 3 && x.textContent.trim().startsWith(text))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;

  /** Opens the real menu (menu bar, or a pop-up menu where there is none) and points at the item. */
  async function showMenuPath(path) {
    const [name, ...rest] = path;
    if (!P.menus[name]) return;
    const btn = [...document.querySelectorAll('.menu-btn')].find((b) => b.dataset.menu === name);
    if (visible(btn) && btn.open) btn.open();
    else showMenu(P.menus[name], 8, 56);
    await frame();
    let row = null;
    for (let i = 0; i < rest.length; i++) {
      const menus = document.querySelectorAll('.menu');
      const menu = menus[menus.length - 1];
      row = [...(menu?.querySelectorAll('.item') || [])].find((r) => r.querySelector('.label')?.textContent.startsWith(rest[i])) || null;
      if (!row) break;
      if (i < rest.length - 1) {
        row.open?.(false);
        await frame();
      }
    }
    const last = rest[rest.length - 1] || name;
    const off = row?.classList.contains('disabled') ? ' (지금은 흐리게 보입니다: 문서를 열고 알맞은 레이어를 고르세요)' : '';
    pointAt(row || btn, `${pathText(path)}${off}`);
    if (!row) toast(`메뉴에서 '${last}'을(를) 찾으세요`);
  }

  /** The tool box button that holds tool `id` (its slot may show another tool of the same family). */
  function toolButton(id) {
    const strip = [...document.querySelectorAll('.ph-stool')].find((b) => visible(b) && b.getAttribute('aria-label') === TOOL_BY_ID[id]?.name);
    if (strip) return strip;
    const btns = [...document.querySelectorAll('.ph-tools .ph-tool')].filter(visible);
    const slots = PANELS.toolbarLayout?.().slots || TOOL_GROUPS;
    const slot = slots.find((x) => x.includes(id)) || [id];
    const name = TOOL_BY_ID[id]?.name || id;
    return btns.find((b) => b.dataset.tool === id) || btns.find((b) => slot.includes(b.dataset.tool))
      || btns.find((b) => (b.getAttribute('aria-label') || '').startsWith(name))
      || document.querySelector('.ph-tools .ph-etb') || null;
  }

  function closeSheetIfLearn() {
    const sheet = document.querySelector('.ph-sheet.open');
    if (!sheet || !sheet.contains(el)) return;
    const btns = [...sheet.querySelectorAll('.ph-sheet-head button')];
    (btns.find((b) => b.getAttribute('aria-label') === '닫기') || btns[btns.length - 1])?.click();
  }

  async function show(st) {
    const sh = st.show || (st.path ? { menu: st.path } : null);
    if (!sh) return;
    if (sh.menu) {
      closeSheetIfLearn();
      return showMenuPath(sh.menu);
    }
    const leaving = sh.panel && sh.panel !== 'learn';
    if (sh.tool) {
      closeSheetIfLearn();
      await frame();
      const t = TOOL_BY_ID[sh.tool];
      const btn = toolButton(sh.tool);
      const same = btn && !btn.classList.contains('ph-stool') && btn.dataset.tool !== sh.tool;
      return pointAt(btn, `${t?.name || sh.tool}${t?.key ? ` (${t.key})` : ''}${same ? ' · 이 칸을 오른쪽 클릭(길게 누르기)해서 고르세요' : ''}`, { back: isMobile() });
    }
    if (sh.panel) P.showPanel(sh.panel);
    else closeSheetIfLearn();
    await frame();
    let target = null;
    const scope = sh.panel && isMobile() ? document.querySelector('.ph-sheet.open') : document;
    if (sh.sel) target = [...scope.querySelectorAll(sh.sel)].find(visible) || null;
    if (!target && sh.text) target = findText(sh.within ? document.querySelector(sh.within) : scope, sh.text);
    if (!target && sh.panel) {
      target = isMobile() ? document.querySelector('.ph-sheet.open .ph-sheet-head') : document.querySelector(`.ph-ptabs button[data-id="${sh.panel}"]`);
    }
    pointAt(target, st.t, { back: (leaving || isMobile()) && !visible(el) });
  }

  // ---------------------------------------------------------------- the coach (when the panel is out of sight)

  const coachText = h('span');
  const coach = h('div.lrn-coach', { hidden: true, role: 'status' },
    icon('book', 16), coachText,
    h('button.small', { onclick: () => { const L = lesson(); if (L?.steps[cur.step]) show(L.steps[cur.step]); } }, '보여 주기'),
    h('button.small', { onclick: () => advance(false) }, '다음'),
    h('button.small', { title: '학습 패널 열기', 'aria-label': '학습 패널 열기', onclick: () => P.showPanel('learn') }, icon('chevRight', 14)),
    h('button.small', { title: '실습 그만하기', 'aria-label': '실습 그만하기', onclick: () => { cur = null; save(); render(); } }, icon('close', 14)));
  document.body.append(coach);
  function syncCoach() {
    const L = lesson();
    const on = !!L && cur.step < L.steps.length && !!P.doc && !visible(el) && document.body.contains(document.querySelector('.ph')) && visible(document.querySelector('.ph'));
    coach.hidden = !on;
    if (!on) return;
    coachText.textContent = `${cur.step + 1}/${L.steps.length} · ${L.steps[cur.step].t}`;
    // at the top of the picture area, clear of the contextual task bar below
    const r = document.querySelector('.ph-stage')?.getBoundingClientRect();
    if (r) Object.assign(coach.style, { top: `${Math.round(r.top + 8)}px`, left: `${Math.round(r.left + r.width / 2)}px` });
  }

  // ---------------------------------------------------------------- the panel

  const listView = () => {
    const out = [
      h('div.lrn-head', icon('book', 16), h('b', '학습')),
      h('div.lrn-dim', '포토샵 강의처럼 같은 메뉴와 도구로 따라 하는 실습입니다. 맞게 하면 저절로 다음 단계로 넘어갑니다.'),
      h('div.lrn-card',
        h('b', '내 예제 파일로 연습'),
        h('div.lrn-dim', '강의 연습 파일(JPG, PNG, PSD)은 파일 ▸ 열기(Ctrl+O)로 열고, 아래 실습의 단계를 그대로 따라 하세요.'),
        h('div.lrn-row2', h('button.small', { onclick: () => P.cmd.open() }, icon('folder', 13), ' 파일 열기…'))),
    ];
    for (const g of LESSON_GROUPS) {
      out.push(h('div.lrn-group', g));
      for (const L of LESSONS.filter((x) => x.group === g)) {
        const n = prog[L.id] || 0;
        const done = n >= L.steps.length;
        out.push(h('button.lrn-item', { onclick: () => open(L.id), title: L.intro },
          h('span', L.title),
          done ? h('span.ok', { 'aria-label': '마침' }, icon('check', 14)) : h('span.lrn-faint', n ? `${n}/${L.steps.length}` : `${L.steps.length}단계 · ${L.min}분`)));
      }
    }
    return out;
  };

  const stepView = (L, st, i) => {
    const state = i < cur.step ? 'done' : i === cur.step ? 'cur' : '';
    const card = h(`div.lrn-step${state ? `.${state}` : ''}`, { 'data-i': i });
    card.append(h('button.lrn-st', { onclick: () => setStep(i), title: '이 단계로 가기' },
      h('span.lrn-num', state === 'done' ? icon('check', 12) : String(i + 1)), h('b', st.t)));
    if (state !== 'cur') return card;
    card.append(h('div', st.d));
    if (st.why) card.append(h('div.lrn-why', `왜? ${st.why}`));
    if (st.path || st.key) {
      card.append(h('div.lrn-path',
        st.path ? h('span.lrn-chip', pathText(st.path)) : null,
        st.key ? h('span.lrn-chip.lrn-key', st.key) : null));
    }
    card.append(h('div.lrn-row2',
      st.show || st.path ? h('button.small.primary', { onclick: () => show(st) }, '보여 주기') : null,
      h('button.small', { onclick: () => advance(false) }, st.done ? '건너뛰기' : '다음'),
      i > 0 ? h('button.small', { onclick: () => setStep(i - 1) }, '이전') : null));
    if (st.done) card.append(h('div.lrn-auto', icon('sparkle', 12), '맞게 하면 저절로 넘어갑니다'));
    return card;
  };

  const lessonView = (L) => {
    const n = Math.min(cur.step, L.steps.length);
    const next = LESSONS[LESSONS.indexOf(L) + 1];
    const out = [
      h('div.lrn-head',
        h('button.small', { title: '실습 목록', 'aria-label': '실습 목록', onclick: () => { cur = null; save(); render(); } }, icon('chevLeft', 14)),
        h('b', L.title), h('span.lrn-faint', `${L.group} · ${L.min}분`)),
      h('div.lrn-dim', L.intro),
      h('div.lrn-row2', h('button.small.primary', { onclick: () => P.openPracticeFile(L.id) }, icon('image', 13), ' 연습 파일 열기')),
      h('div.lrn-faint', '강의 예제 파일이나 내 사진을 열어 두고 따라 해도 됩니다.'),
      h('div.lrn-bar', { 'aria-hidden': 'true' }, h('i', { style: { width: `${(n / L.steps.length) * 100}%` } })),
      ...L.steps.map((st, i) => stepView(L, st, i)),
    ];
    if (n >= L.steps.length) {
      out.push(h('div.lrn-card.lrn-done-card',
        h('span.ok', icon('check', 22)), h('b', '잘했습니다! 실습을 마쳤습니다.'),
        h('div.lrn-dim', '같은 방법을 강의의 예제 파일이나 내 사진에도 해 보세요.'),
        h('div.lrn-row2',
          h('button.small', { onclick: () => setStep(0) }, '처음부터 다시'),
          next ? h('button.small.primary', { onclick: () => open(next.id) }, `다음: ${next.title}`) : null)));
    }
    return out;
  };

  function render() {
    const L = lesson();
    el.replaceChildren(...(L ? lessonView(L) : listView()));
    if (L) {
      const c = el.querySelector('.lrn-step.cur');
      if (c) requestAnimationFrame(() => c.scrollIntoView({ block: 'nearest' }));
      run();
    } else clearInterval(timer);
    syncCoach();
  }

  P.addPanel('learn', '학습', el, 'top');
  render();

  // Help ▸ Hands-on tutorials (Window ▸ Learn comes from the panel list)
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['도움말'];
    if (!orig) return;
    P.menus['도움말'] = () => {
      const items = orig();
      const at = items.findIndex((it) => typeof it?.label === 'string' && it.label.startsWith('설명서'));
      const add = { label: '실습 튜토리얼 (학습 패널)', action: () => P.showPanel('learn') };
      return at < 0 ? [...items, add] : [...items.slice(0, at + 1), add, ...items.slice(at + 1)];
    };
  }];
}

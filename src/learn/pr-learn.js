// Window ▸ Learn (창 ▸ 학습) and Help ▸ Hands-on tutorials for the video editor: Premiere Pro style
// practice lessons. '연습 파일 열기' makes the lesson's practice media in the browser
// (practice-media.js), imports it into the bin '연습 파일' and sets up a sequence; step cards
// (pr-lessons.js) say what to do, with the menu path and shortcut. '보여 주기' opens the real menu
// and points at the item, or points at the tool, panel or the spot on the timeline; a step
// completes by itself when the project state matches, with '다음' as the fallback. Progress stays
// in this browser (prefs).

import { store } from '../store.js';
import * as edit from '../edit.js';
import { playback } from '../playback.js';
import { h, formatBytes } from '../util.js';
import { toast, showMenu, showPanel, loadPref, savePref, confirmDialog } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { menubarApi, extendMenu } from '../ui/menubar.js';
import { timelineApi } from '../ui/timeline.js';
import { TOOLS } from '../ui/panels.js';
import { videoTracks, clipEnd } from '../model.js';
import { appMode } from '../mode.js';
import { LESSONS, LESSON_GROUPS } from './pr-lessons.js';
import { ensurePractice, practiceMediaId, practiceUsage, clearPracticeCache, PRACTICE_BIN } from './practice-media.js';

const CSS = `
.prl { padding: 8px 10px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; font-size: var(--fs-s, 13px); }
.prl-head { display: flex; align-items: center; gap: 6px; }
.prl-head b { flex: 1; font-size: var(--fs-m, 14px); }
.prl-dim { color: var(--text-dim); line-height: 1.5; }
.prl-faint { color: var(--text-faint); font-size: var(--fs-xs, 11px); }
.prl-card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: rgba(255,255,255,.03); display: flex; flex-direction: column; gap: 6px; }
.prl-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.prl-group { margin-top: 4px; color: var(--text-faint); font-size: var(--fs-xs, 11px); letter-spacing: .03em; }
.prl-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 1px solid transparent; border-radius: 6px; padding: 6px 8px; min-height: 0; color: var(--text); }
.prl-item:hover { background: rgba(255,255,255,.06); }
.prl-item span:first-child { flex: 1; }
.prl-item .prl-faint { white-space: nowrap; }
.prl .ok { color: #5cc87a; display: inline-flex; }
.prl-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.prl-bar i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.prl-step { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.prl-step.cur { border-color: var(--accent); background: rgba(74,163,255,.07); }
.prl-step.done { opacity: .7; }
.prl-step.flash { animation: prl-flash .7s ease; }
.prl-st { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; min-height: 0; text-align: left; color: var(--text); width: 100%; }
.prl-st b { flex: 1; font-weight: 600; }
.prl-num { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; background: var(--line); color: var(--text-dim); flex: none; }
.prl-step.cur .prl-num { background: var(--accent); color: #fff; }
.prl-step.done .prl-num { background: #2f7a47; color: #fff; }
.prl-why { color: var(--text-dim); font-size: var(--fs-xs, 11px); line-height: 1.5; border-left: 2px solid var(--line); padding-left: 6px; }
.prl-path { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: var(--fs-xs, 11px); }
.prl-chip { border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; background: rgba(255,255,255,.04); white-space: nowrap; }
.prl-key { font-family: ui-monospace, Menlo, Consolas, monospace; }
.prl-auto { color: var(--text-faint); font-size: var(--fs-xs, 11px); display: inline-flex; align-items: center; gap: 4px; }
.prl-done-card { text-align: center; align-items: center; }
.prl-ring { position: fixed; z-index: 2000; pointer-events: none; border: 2px solid var(--accent, #4aa3ff); border-radius: 6px; box-shadow: 0 0 0 4px rgba(74,163,255,.35), 0 0 18px rgba(74,163,255,.6); animation: prl-pulse 1s ease-in-out infinite; }
.prl-tip { position: fixed; z-index: 2001; max-width: 260px; background: #1d4f86; color: #fff; border-radius: 8px; padding: 7px 10px; font-size: 13px; line-height: 1.45; box-shadow: 0 6px 20px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 6px; }
.prl-tip button { align-self: flex-end; background: rgba(255,255,255,.18); color: #fff; border: none; min-height: 0; padding: 3px 8px; border-radius: 5px; }
.prl-coach { position: fixed; z-index: 800; transform: translateX(-50%); width: max-content; display: flex; align-items: center; gap: 8px; max-width: min(560px, calc(100vw - 24px)); background: #23272e; border: 1px solid var(--accent, #4aa3ff); border-radius: 10px; padding: 6px 8px 6px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 13px; }
.prl-coach span { flex: 1 1 auto; min-width: 0; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prl-coach button { min-height: 0; padding: 4px 8px; white-space: nowrap; }
body.mobile .prl-coach { top: auto !important; bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
@keyframes prl-pulse { 50% { box-shadow: 0 0 0 7px rgba(74,163,255,.15), 0 0 26px rgba(74,163,255,.75); } }
@keyframes prl-flash { 0% { background: rgba(92,200,122,.35); } 100% { background: transparent; } }
`;

const RULER_H = 34; // the timeline's ruler (timeline.js)
const isMobile = () => document.body.classList.contains('mobile');
const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const pathText = (path) => path.join(' ▸ ');
const labels = () => store.undoStack.map((e) => e.label || '');
const count = (list, re) => list.filter((x) => re.test(x)).length;

/** The Learn panel element; call once while the workspace is built. */
export function createLearnPanel() {
  document.head.append(h('style', CSS));
  const el = h('div.prl', { role: 'region', 'aria-label': '학습' });
  let cur = loadPref('learn.cur', null);
  if (cur && !LESSONS.find((l) => l.id === cur.id)) cur = null;
  const prog = loadPref('learn.prog', {});
  let base = null;
  let busy = null; // { label, f } while practice media is being made
  let usage = null;
  const shownPanels = new Set();
  const lesson = () => (cur ? LESSONS.find((l) => l.id === cur.id) : null);

  // ---------------------------------------------------------------- state checks

  const seq = () => store.seq;
  const clips = () => Object.values(seq()?.clips || {});
  const panelOn = (id) => {
    const b = document.querySelector(`.panel-body.active[data-panel="${id}"]`);
    return !!b && visible(b);
  };
  const toasts = [];
  // tools picked since the step began (a click with the type tool switches back to the selection tool at once)
  const toolsSeen = new Set();
  store.on('tool', () => toolsSeen.add(store.ui.tool));
  const snapshot = () => {
    shownPanels.clear();
    toasts.length = 0;
    toolsSeen.clear();
    const s = seq();
    return {
      seqId: s?.id, seqs: Object.keys(store.project.sequences).length, clips: clips().length, labels: labels(),
      dur: s ? Math.max(0, ...clips().map(clipEnd)) : 0, tool: store.ui.tool,
      media: store.project.mediaOrder.length, sig: JSON.stringify(s?.clips || {}),
    };
  };
  /** What steps look at (see pr-lessons.js). */
  const ctx = () => {
    const s = seq();
    const all = clips();
    const ls = labels();
    const mediaOf = (key) => practiceMediaId(key);
    return {
      seq: s, clips: all, base, tool: store.ui.tool, usedTool: (id) => store.ui.tool === id || toolsSeen.has(id), sel: store.selectedClips(), playhead: store.ui.playhead,
      playing: !!playback.playing || [...document.querySelectorAll('.panel-body[data-panel="source"] video')].some((v) => !v.paused), project: store.project, source: store.ui.sourceMediaId, selectedMedia: [...store.ui.selectedMedia],
      media: mediaOf,
      of: (key, kind = null) => {
        const id = mediaOf(key);
        return all.filter((c) => id && c.mediaId === id && (!kind || (kind === 'audio' ? c.kind === 'audio' : c.kind !== 'audio')));
      },
      onTrack: (name) => {
        const t = s.tracks.find((x) => x.name === name);
        return t ? all.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start) : [];
      },
      track: (id) => s.tracks.find((x) => x.id === id),
      vIndex: (c) => videoTracks(s).findIndex((t) => t.id === c.trackId),
      did: (re) => count(ls, re) > count(base.labels, re),
      fx: (c, type) => c?.effects?.find((e) => e.type === type && e.enabled !== false) || null,
      panel: (id) => shownPanels.has(id) || panelOn(id),
      modal: (re) => [...document.querySelectorAll('.modal')].some((m) => visible(m) && re.test(m.getAttribute('aria-label') || m.querySelector('.modal-title, h2, .title')?.textContent || '')),
      toast: (re) => toasts.some((x) => re.test(x)),
      changed: () => JSON.stringify(s?.clips || {}) !== base.sig,
      dur: () => Math.max(0, ...all.map(clipEnd)),
      seqCount: () => Object.keys(store.project.sequences).length,
    };
  };

  // toasts seen while a step runs ("파일을 내보냈습니다")
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.classList?.contains('toast')) toasts.push(n.textContent || '');
    if (toasts.length > 30) toasts.splice(0, toasts.length - 30);
  }).observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------- progress

  const save = () => {
    savePref('learn.cur', cur);
    savePref('learn.prog', prog);
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
  const close = () => {
    cur = null;
    save();
    render();
  };
  const advance = (auto) => {
    const L = lesson();
    if (!L || cur.step >= L.steps.length) return;
    const was = cur.step;
    setStep(cur.step + 1);
    if (auto) {
      el.querySelector(`.prl-step[data-i="${was}"]`)?.classList.add('flash');
      if (cur.step >= L.steps.length) toast(`'${L.title}' 실습을 마쳤습니다`);
    }
    clearPointer();
  };

  /** Helpers lesson setups use to build their practice sequence. */
  const setupApi = (ids) => ({
    ids,
    sequence(name) {
      // a lesson's sequence is made fresh each time (an older one with the same name stays)
      return edit.newSequence({ name, width: 960, height: 540, fps: 25 });
    },
    place(key, { track = 'V1', audioTrack = 'A1', start = 0, inPoint, outPoint, video, audio } = {}) {
      const s = seq();
      const vt = s.tracks.find((t) => t.name === track);
      const at = s.tracks.find((t) => t.name === audioTrack);
      return edit.placeMedia(ids[key], { start, inPoint, outPoint, video, audio, vTrackId: vt?.id, aTrackId: at?.id, checkMismatch: false });
    },
    marker(t, name, color) {
      edit.addMarker(t, { name, ...(color ? { color } : {}) });
    },
  });

  /** Makes the lesson's practice media, imports it and sets up its sequence. */
  async function openPractice(id) {
    const L = LESSONS.find((l) => l.id === id);
    if (!L || busy) return;
    if (appMode.isPhoto()) return toast('영상 편집으로 바꾼 뒤 연습 파일을 여세요');
    busy = { label: '준비 중', f: 0 };
    cur = { id, step: 0 };
    render();
    try {
      const ids = await ensurePractice(L.media || [], (f, label) => {
        busy = { label: label || '가져오는 중', f };
        renderBusy();
      });
      const api = setupApi(ids);
      if (L.setup) {
        const mark = store.undoMark();
        await L.setup(api);
        store.squashSince(mark, `연습 파일 열기: ${L.title}`);
        playback.requestRender?.();
      }
      showPanel(L.panel || 'project', { quiet: true });
      timelineApi.zoomToFit?.();
      toast(`'${PRACTICE_BIN}' 저장소에 연습 파일을 넣었습니다`);
    } catch (err) {
      console.error(err);
      toast(`연습 파일을 만들지 못했습니다: ${err?.message || err}`);
    } finally {
      busy = null;
      usage = null;
      cur = { id, step: 0 };
      base = snapshot();
      save();
      render();
    }
  }

  // the step completes by itself when the project state matches
  let timer = null;
  const tick = () => {
    const L = lesson();
    if (!L || busy || cur.step >= L.steps.length) return syncCoach();
    const st = L.steps[cur.step];
    if (!base) base = snapshot();
    let ok = false;
    try {
      ok = !!st.done?.(ctx());
    } catch { /* a check that needs a sequence or a clip */ }
    if (ok) advance(true);
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
  /** A pulsing ring around `target` (an element, or a function returning a rect) and a note next to it. */
  function pointAt(target, text, { back = false } = {}) {
    clearPointer();
    if (!target) return toast(text);
    if (target instanceof Element) target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const rectOf = () => (target instanceof Element ? (target.isConnected ? target.getBoundingClientRect() : null) : target());
    const ring = h('div.prl-ring');
    const tip = h('div.prl-tip', { role: 'status' }, h('span', text),
      back ? h('button', { onclick: () => { clearPointer(); showPanel('learn'); } }, '학습으로 돌아가기') : null);
    document.body.append(ring, tip);
    const place = () => {
      const r = rectOf();
      if (!r) return clearPointer();
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
      if (pointer) pointer.raf = requestAnimationFrame(place);
    };
    const off = (e) => {
      if (tip.contains(e.target)) return;
      setTimeout(clearPointer, 0);
    };
    pointer = { ring, tip, off, raf: 0, timer: setTimeout(clearPointer, 9000) };
    place();
    document.addEventListener('pointerdown', off, true);
  }

  const findText = (root, text) => [...(root || document).querySelectorAll('button, label, span, div, summary, h3, h4')]
    .filter((x) => visible(x) && x.children.length <= 3 && x.textContent.trim().startsWith(text))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;

  /** Opens the real menu and points at the item (a pop-up menu on phones, where the bar is hidden). */
  async function showMenuPath(path) {
    const [name, ...rest] = path;
    const menus = menubarApi.menus || {};
    if (!menus[name]) return toast(pathText(path));
    const btn = [...document.querySelectorAll('.menu-btn')].find((b) => b.dataset.menu === name);
    if (visible(btn) && btn.open) btn.open();
    else showMenu(menus[name], 8, 56);
    await frame();
    let row = null;
    for (let i = 0; i < rest.length; i++) {
      const all = document.querySelectorAll('.menu');
      const menu = all[all.length - 1];
      row = [...(menu?.querySelectorAll(':scope > .item') || [])].find((r) => r.querySelector('.label')?.textContent.startsWith(rest[i])) || null;
      if (!row) break;
      if (i < rest.length - 1) {
        if (row.open) row.open(false);
        else row.dispatchEvent(new PointerEvent('pointerenter'));
        await frame();
        await frame();
      }
    }
    const off = row?.classList.contains('disabled') ? ' (지금은 흐리게 보입니다: 먼저 클립을 선택하세요)' : '';
    pointAt(row || btn, `${pathText(path)}${off}`);
    if (!row) toast(`메뉴에서 '${rest[rest.length - 1] || name}'을(를) 찾으세요`);
  }

  function toolButton(id) {
    const name = (TOOLS.find(([t]) => t === id)?.[1] || id).replace(/\s*\(.*\)$/, '');
    const btns = [...document.querySelectorAll('#tools button')].filter(visible);
    return btns.find((b) => (b.getAttribute('aria-label') || '').startsWith(name)) || btns.find((b) => (b.title || '').includes(name)) || null;
  }

  /** A spot on the timeline: a clip (or its edge), or a time on the ruler. */
  function timelineRect({ clip, edge, time }) {
    const canvas = document.querySelector('.timeline .tl-canvas-wrap canvas');
    const v = timelineApi.view;
    if (!canvas || !v || !visible(canvas)) return null;
    return () => {
      const cr = canvas.getBoundingClientRect();
      const c = typeof clip === 'function' ? clip(ctx()) : clip;
      if (c) {
        const row = v.rows?.find((r) => r.track.id === c.trackId);
        if (!row) return null;
        const x0 = cr.left + c.start * v.pps - v.scrollX;
        const x1 = cr.left + clipEnd(c) * v.pps - v.scrollX;
        const top = cr.top + RULER_H + row.y - v.scrollY;
        const l = Math.max(cr.left, edge === 'out' ? x1 - 8 : x0);
        const r = Math.min(cr.right, edge === 'in' ? x0 + 8 : x1);
        return new DOMRect(l, top, Math.max(6, r - l), row.h);
      }
      const t = typeof time === 'function' ? time(ctx()) : time;
      const x = cr.left + t * v.pps - v.scrollX;
      return new DOMRect(Math.max(cr.left, Math.min(cr.right - 6, x - 3)), cr.top, 6, cr.height);
    };
  }

  function closeSheetIfLearn() {
    if (!isMobile()) return;
    const g = el.closest('.panel-group');
    if (g?.classList.contains('m-open')) g.querySelector('.m-sheet-head button[aria-label="닫기"]')?.click();
  }

  async function show(st) {
    const sh = st.show || (st.path ? { menu: st.path } : null);
    if (!sh) return st.key ? toast(`단축키: ${st.key}`) : null;
    if (sh.menu) {
      closeSheetIfLearn();
      return showMenuPath(sh.menu);
    }
    if (sh.tool) {
      closeSheetIfLearn();
      await frame();
      const t = TOOLS.find(([x]) => x === sh.tool)?.[1] || sh.tool;
      const btn = toolButton(sh.tool);
      const same = btn && !(btn.getAttribute('aria-label') || '').startsWith(t.replace(/\s*\(.*\)$/, ''));
      return pointAt(btn, `${t}${same ? ' · 이 단추를 길게 누르거나 오른쪽 클릭해서 고르세요' : ''}`, { back: isMobile() });
    }
    if (sh.clip || sh.time != null) {
      closeSheetIfLearn();
      showPanel('timeline', { quiet: true });
      await frame();
      return pointAt(timelineRect(sh), sh.note || st.t, { back: isMobile() });
    }
    const leaving = sh.panel && sh.panel !== 'learn';
    if (sh.panel) showPanel(sh.panel);
    else closeSheetIfLearn();
    await frame();
    await frame();
    let target = null;
    if (sh.sel) target = [...document.querySelectorAll(sh.sel)].find(visible) || null;
    if (!target && sh.text) target = findText(sh.within ? document.querySelector(sh.within) : document.querySelector(`.panel-body[data-panel="${sh.panel}"]`) || document, sh.text);
    if (!target && sh.panel) {
      const body = document.querySelector(`.panel-body[data-panel="${sh.panel}"]`);
      const g = body?.closest('.panel-group');
      const i = g ? [...g.querySelectorAll(':scope > .panel-body')].indexOf(body) : -1;
      target = isMobile() ? g?.querySelector('.m-sheet-head') : g?.querySelectorAll(':scope > .tabs .tab')[i] || body;
    }
    pointAt(target, sh.note || st.t, { back: (leaving || isMobile()) && !visible(el) });
  }

  // ---------------------------------------------------------------- the coach (while the panel is out of sight)

  const coachText = h('span');
  const coach = h('div.prl-coach', { hidden: true, role: 'status' },
    icon('book', 16), coachText,
    h('button.small', { onclick: () => { const L = lesson(); if (L?.steps[cur.step]) show(L.steps[cur.step]); } }, '보여 주기'),
    h('button.small', { onclick: () => advance(false) }, '다음'),
    h('button.small', { title: '학습 패널 열기', 'aria-label': '학습 패널 열기', onclick: () => showPanel('learn') }, icon('chevRight', 14)),
    h('button.small', { title: '실습 그만하기', 'aria-label': '실습 그만하기', onclick: close }, icon('close', 14)));
  document.body.append(coach);
  function syncCoach() {
    const L = lesson();
    const on = !!L && !busy && cur.step < L.steps.length && !appMode.isPhoto() && !visible(el) && !document.querySelector('.modal-backdrop');
    coach.hidden = !on;
    if (!on) return;
    coachText.textContent = `${cur.step + 1}/${L.steps.length} · ${L.steps[cur.step].t}`;
    // on the timeline's header row, clear of the picture
    const r = document.querySelector('#pg-timeline')?.getBoundingClientRect();
    if (r && r.width) Object.assign(coach.style, { top: `${Math.round(r.top + 2)}px`, left: `${Math.round(r.left + r.width * 0.62)}px` });
  }

  // ---------------------------------------------------------------- the panel

  const storageCard = () => {
    const info = h('div.prl-faint', usage ? `이 브라우저에 저장한 연습 파일: ${usage.items.length}개 · ${formatBytes(usage.total)}` : '저장 공간 확인 중…');
    if (!usage) practiceUsage().then((u) => { usage = u; if (!lesson()) render(); });
    return h('div.prl-card',
      h('b', '내 예제 파일로 연습'),
      h('div.prl-dim', '강의 예제 파일은 파일 ▸ 가져오기(Ctrl+I)로 가져오고, 아래 실습의 단계를 그대로 따라 하세요. 연습 파일은 이 브라우저에서 바로 만들어 지므로 내려받을 필요가 없습니다.'),
      info,
      h('div.prl-row',
        h('button.small', { onclick: () => import('../ui/project-panel.js').then((m) => (m.pickFiles ? m.pickFiles() : null)) }, icon('folder', 13), ' 가져오기…'),
        usage?.items.length ? h('button.small', {
          onclick: async () => {
            if (!(await confirmDialog('연습 파일 지우기', '이 브라우저에 저장해 둔 연습 파일을 지울까요? 프로젝트에 이미 넣은 파일은 그대로 남고, 다음에 실습을 열면 다시 만듭니다.'))) return;
            await clearPracticeCache();
            usage = null;
            render();
          },
        }, icon('trash', 13), ' 저장한 연습 파일 지우기') : null));
  };

  const listView = () => {
    const out = [
      h('div.prl-head', icon('book', 16), h('b', '학습')),
      h('div.prl-dim', '프리미어 프로 강의처럼 같은 메뉴, 도구, 단축키로 따라 하는 실습입니다. 맞게 하면 저절로 다음 단계로 넘어갑니다.'),
      storageCard(),
    ];
    for (const g of LESSON_GROUPS) {
      out.push(h('div.prl-group', g));
      for (const L of LESSONS.filter((x) => x.group === g)) {
        const n = prog[L.id] || 0;
        const done = n >= L.steps.length;
        out.push(h('button.prl-item', { onclick: () => open(L.id), title: L.intro },
          h('span', L.title),
          done ? h('span.ok', { 'aria-label': '마침' }, icon('check', 14)) : h('span.prl-faint', n ? `${n}/${L.steps.length}` : `${L.steps.length}단계 · ${L.min}분`)));
      }
    }
    return out;
  };

  const stepView = (L, st, i) => {
    const state = i < cur.step ? 'done' : i === cur.step ? 'cur' : '';
    const card = h(`div.prl-step${state ? `.${state}` : ''}`, { 'data-i': i });
    card.append(h('button.prl-st', { onclick: () => setStep(i), title: '이 단계로 가기' },
      h('span.prl-num', state === 'done' ? icon('check', 12) : String(i + 1)), h('b', st.t)));
    if (state !== 'cur') return card;
    card.append(h('div', st.d));
    if (st.why) card.append(h('div.prl-why', `왜? ${st.why}`));
    if (st.path || st.key) {
      card.append(h('div.prl-path',
        st.path ? h('span.prl-chip', pathText(st.path)) : null,
        st.key ? h('span.prl-chip.prl-key', st.key) : null));
    }
    card.append(h('div.prl-row',
      st.show || st.path ? h('button.small.primary', { onclick: () => show(st) }, '보여 주기') : null,
      h('button.small', { onclick: () => advance(false) }, st.done ? '건너뛰기' : '다음'),
      i > 0 ? h('button.small', { onclick: () => setStep(i - 1) }, '이전') : null));
    if (st.done) card.append(h('div.prl-auto', icon('sparkle', 12), '맞게 하면 저절로 넘어갑니다'));
    return card;
  };

  const busyBar = h('div.prl-card', h('b', '연습 파일을 만드는 중…'), h('div.prl-faint'), h('div.prl-bar', h('i', { style: { width: '0%' } })));
  function renderBusy() {
    if (!busy) return;
    busyBar.children[1].textContent = `${busy.label} · ${Math.round(busy.f * 100)}%`;
    busyBar.querySelector('i').style.width = `${Math.round(busy.f * 100)}%`;
  }

  const lessonView = (L) => {
    const n = Math.min(cur.step, L.steps.length);
    const next = LESSONS[LESSONS.indexOf(L) + 1];
    const out = [
      h('div.prl-head',
        h('button.small', { title: '실습 목록', 'aria-label': '실습 목록', onclick: close }, icon('chevLeft', 14)),
        h('b', L.title), h('span.prl-faint', `${L.group} · ${L.min}분`)),
      h('div.prl-dim', L.intro),
      busy ? busyBar : h('div.prl-row', h('button.small.primary', { onclick: () => openPractice(L.id) }, icon('film', 13), ' 연습 파일 열기')),
      h('div.prl-faint', L.media?.length ? '연습 파일은 이 브라우저에서 만들어 프로젝트의 \'연습 파일\' 저장소에 넣고, 새 시퀀스를 엽니다. 강의 예제 파일로 따라 해도 됩니다.' : '강의 예제 파일이나 내 영상으로 따라 해도 됩니다.'),
      h('div.prl-bar', { 'aria-hidden': 'true' }, h('i', { style: { width: `${(n / L.steps.length) * 100}%` } })),
      ...L.steps.map((st, i) => stepView(L, st, i)),
    ];
    if (n >= L.steps.length) {
      out.push(h('div.prl-card.prl-done-card',
        h('span.ok', icon('check', 22)), h('b', '잘했습니다! 실습을 마쳤습니다.'),
        h('div.prl-dim', '같은 방법을 강의의 예제 파일이나 내 영상에도 해 보세요.'),
        h('div.prl-row',
          h('button.small', { onclick: () => setStep(0) }, '처음부터 다시'),
          next ? h('button.small.primary', { onclick: () => open(next.id) }, `다음: ${next.title}`) : null)));
    }
    return out;
  };

  function render() {
    const L = lesson();
    el.replaceChildren(...(L ? lessonView(L) : listView()));
    renderBusy();
    if (L) {
      const c = el.querySelector('.prl-step.cur');
      if (c) requestAnimationFrame(() => c.scrollIntoView({ block: 'nearest' }));
      run();
    } else clearInterval(timer);
    syncCoach();
  }

  // panels brought forward on purpose (창 menu, Shift+7…) count for "open the … panel" steps
  for (const evt of ['focus']) store.on(evt, () => shownPanels.add(store.ui.focusPanel));
  appMode.on?.(() => syncCoach());
  window.addEventListener('resize', () => syncCoach());

  render();
  // for automated tests
  el.learn = { open, openPractice, setStep, show, state: () => ({ cur, busy: !!busy }) };
  return el;
}

// 창 ▸ 학습 and 도움말 ▸ 실습 튜토리얼
extendMenu('창', (items) => [...items, { label: '학습', action: () => showPanel('learn') }]);
extendMenu('도움말', (items) => {
  const at = items.findIndex((it) => typeof it?.label === 'string' && it.label.startsWith('시작 가이드'));
  const add = { label: '실습 튜토리얼 (학습 패널)', action: () => showPanel('learn') };
  return at < 0 ? [...items, add] : [...items.slice(0, at + 1), add, ...items.slice(at + 1)];
});

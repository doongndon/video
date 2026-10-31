// Shared UI building blocks: panel groups, splitters, menus, modals, toasts and scrubbable numbers.

import { h, clamp } from '../util.js';
import { store } from '../store.js';
import { icon } from './icons.js';

/** Shared drag-and-drop payload (dataTransfer contents are unreadable during dragover). */
export const dnd = { payload: null };

// ---------------------------------------------------------------- storage helpers

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`montage.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`montage.${key}`, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- panel groups

const groups = [];

/** panels: [{id, title, body}] */
export function panelGroup(el, name, panels) {
  const tabs = h('div.tabs');
  el.append(tabs);
  const entries = panels.map((p) => {
    const tab = h('div.tab', { onclick: () => activate(p.id) }, p.title);
    const body = p.body;
    body.classList.add('panel-body');
    body.dataset.panel = p.id;
    tabs.append(tab);
    el.append(body);
    body.addEventListener('pointerdown', () => store.setFocus(p.id), true);
    return { ...p, tab };
  });
  function activate(id) {
    for (const e of entries) {
      const on = e.id === id;
      e.tab.classList.toggle('active', on);
      e.body.classList.toggle('active', on);
      if (on) e.onShow?.();
      else e.onHide?.();
    }
    group.active = id;
    savePref(`tab.${name}`, id);
    store.setFocus(id);
    window.dispatchEvent(new Event('resize'));
  }
  const group = { el, name, entries, activate, active: null, has: (id) => entries.some((e) => e.id === id) };
  groups.push(group);
  const initial = loadPref(`tab.${name}`, panels[0].id);
  activate(entries.some((e) => e.id === initial) ? initial : panels[0].id);
  store.on('focus', () => {
    el.classList.toggle('focused', entries.some((e) => e.id === store.ui.focusPanel) && group.active === store.ui.focusPanel);
  });
  return group;
}

/** onShow(id) runs whenever a panel is brought forward on purpose (the phone layout opens its sheet). */
export const panelHooks = { onShow: null };

/** Bring a panel to front wherever it lives. */
export function showPanel(id, { quiet = false } = {}) {
  for (const g of groups) if (g.has(id)) g.activate(id);
  if (!quiet) panelHooks.onShow?.(id);
}

/** Every panel id that lives in a panel group (창 menu, shortcuts). */
export const panelIds = () => groups.flatMap((g) => g.entries.map((e) => e.id));

// where the pointer was last seen: ` maximizes the frame under it, like Premiere
const pointer = { x: -1, y: -1 };
window.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}, { capture: true, passive: true });

/**
 * Maximize or restore a panel frame (창 ▸ 프레임 최대화). ` takes the frame under the pointer and
 * Shift+` ({active: true}) the active one; either restores a maximized frame.
 */
export function toggleMaximize({ active = false } = {}) {
  if (document.body.classList.contains('mobile')) return;
  const current = groups.find((g) => g.el.classList.contains('maximized'));
  if (current) current.el.classList.remove('maximized');
  else {
    const under = (g) => {
      const r = g.el.getBoundingClientRect();
      return r.width > 0 && pointer.x >= r.left && pointer.x < r.right && pointer.y >= r.top && pointer.y < r.bottom;
    };
    const target = (!active && groups.find(under)) || groups.find((g) => g.active === store.ui.focusPanel);
    if (!target) return;
    target.el.classList.add('maximized');
    if (!target.has(store.ui.focusPanel)) store.setFocus(target.active);
  }
  document.body.classList.toggle('frame-maximized', !current);
  window.dispatchEvent(new Event('resize'));
}

export const isMaximized = () => groups.some((g) => g.el.classList.contains('maximized'));

// ---------------------------------------------------------------- splitters

// room the neighbouring panels keep while dragging (styles/app.css clamps saved sizes the same way)
const SPLIT_ROOM = { '--tl-w': 260, '--bl-w': 340, '--top-h': 170 };

export function initSplitters() {
  const root = document.documentElement;
  for (const sp of document.querySelectorAll('.splitter')) {
    const v = sp.dataset.var;
    const saved = loadPref(`split${v}`, null);
    if (saved) root.style.setProperty(v, saved);
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      document.body.classList.add('splitting');
      const target = document.getElementById(sp.dataset.target);
      const horizontal = sp.classList.contains('v');
      const startPos = horizontal ? e.clientX : e.clientY;
      const r0 = target.getBoundingClientRect();
      const box = target.parentElement.getBoundingClientRect();
      const startSize = horizontal ? r0.width : r0.height;
      const max = (horizontal ? box.width : box.height) - (SPLIT_ROOM[v] ?? 200);
      const min = horizontal ? 160 : 120;
      let raf = 0;
      let ended = false;
      const move = (ev) => {
        const d = (horizontal ? ev.clientX : ev.clientY) - startPos;
        const size = clamp(startSize + d, min, Math.max(min, max));
        root.style.setProperty(v, `${Math.round(size)}px`);
        // panels redraw on resize: once per frame is enough
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          window.dispatchEvent(new Event('resize'));
        });
      };
      const end = () => {
        if (ended) return;
        ended = true;
        cancelAnimationFrame(raf);
        sp.classList.remove('dragging');
        document.body.classList.remove('splitting');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', end);
        sp.removeEventListener('pointercancel', end);
        sp.removeEventListener('lostpointercapture', end);
        savePref(`split${v}`, root.style.getPropertyValue(v));
        window.dispatchEvent(new Event('resize'));
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', end);
      sp.addEventListener('pointercancel', end);
      sp.addEventListener('lostpointercapture', end);
    });
  }
}

// ---------------------------------------------------------------- menus

let openMenus = [];
let menuNav = null; // {step(dir)}: ← → move between the menu bar's menus
let hoverTimer = 0;
let hoverLevel = -1;

export function closeMenus() {
  clearTimeout(hoverTimer);
  for (const m of openMenus) m.remove();
  openMenus = [];
  menuNav = null;
  document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open'));
}

/** Close the menus from `level` down (submenus), keeping their parents open. */
function closeFrom(level) {
  clearTimeout(hoverTimer);
  for (const m of openMenus.slice(level)) m.remove();
  openMenus = openMenus.slice(0, level);
}

const menuRows = (menu) => [...menu.querySelectorAll(':scope > .item:not(.disabled)')];

function setActive(menu, row, scroll = true) {
  for (const r of menu.querySelectorAll(':scope > .item.active')) r.classList.remove('active');
  if (!row) return;
  row.classList.add('active');
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

/** Small inline SVG showing a curve (path in a 30×20 box) — used for easing previews. */
function curveIcon(d) {
  const span = h('span.curve');
  span.innerHTML = `<svg viewBox="0 0 30 20" aria-hidden="true"><path d="M3 17H27M3 3H27" class="guide"/><path d="${d}"/></svg>`;
  return span;
}

/**
 * items: [{label, key, hint, action, disabled, checked, submenu, swatch, curve}], '-' for a separator
 * or {group} for a small heading. A function returning such a list is evaluated now (submenus
 * when they open). Keyboard: ↑ ↓ choose, → opens a submenu, ← closes it, Enter runs, Esc closes.
 * opts.nav {step(dir)} lets ← → at the top level move to the menu bar's neighbouring menus;
 * opts.select highlights the first item (menus opened from the keyboard).
 */
export function showMenu(items, x, y, { level = 0, nav = null, select = false } = {}) {
  if (level === 0) {
    closeMenus();
    menuNav = nav;
  } else closeFrom(level);
  const list = (typeof items === 'function' ? items() : items) || [];
  const menu = h('div.menu', { role: 'menu' });
  menu.addEventListener('pointerenter', () => {
    // the pointer reached this submenu: keep it open even if it crossed other rows on the way
    if (hoverLevel < level) clearTimeout(hoverTimer);
  });
  for (const it of list) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div.sep'));
      continue;
    }
    if (it.group) {
      menu.append(h('div.group', it.group));
      continue;
    }
    const checkable = it.checked !== undefined && !it.submenu;
    const row = h(`div.item${it.disabled ? '.disabled' : ''}${it.checked ? '.checked' : ''}${it.submenu ? '.sub' : ''}`, {
      role: checkable ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': checkable ? String(!!it.checked) : null,
      'aria-disabled': it.disabled ? 'true' : null,
      'aria-haspopup': it.submenu ? 'menu' : null,
    },
    it.checked ? h('span.check', icon('check', 14)) : null,
    it.swatch ? h('span.swatch', { style: { background: it.swatch } }) : null,
    it.curve ? curveIcon(it.curve) : null,
    h('span.label', it.label), it.hint ? h('span.hint', it.hint) : null, it.key ? h('span.key', it.key) : null,
    it.submenu ? h('span.chev', icon('chevRight', 14)) : null);
    const subOpen = () => openMenus[level + 1]?.owner === row;
    const openSub = (selectFirst) => {
      if (it.disabled) return;
      setActive(menu, row, false);
      if (subOpen()) {
        if (selectFirst) setActive(openMenus[level + 1], menuRows(openMenus[level + 1])[0]);
        return;
      }
      const r = row.getBoundingClientRect();
      const sub = showMenu(it.submenu, r.right - 2, r.top - 4, { level: level + 1, select: selectFirst });
      sub.owner = row;
      // no room on the right: open on the left of the parent
      const sr = sub.getBoundingClientRect();
      if (r.right - 2 + sr.width > window.innerWidth - 4) sub.style.left = `${Math.max(2, r.left - sr.width + 2)}px`;
    };
    const run = () => {
      if (it.disabled) return;
      closeMenus();
      try {
        it.action?.();
      } catch (err) {
        console.error(err);
        toast(String(err.message || err));
      }
    };
    if (it.submenu) row.open = openSub;
    else row.run = run;
    row.addEventListener('pointerenter', (e) => {
      setActive(menu, it.disabled ? null : row, false);
      clearTimeout(hoverTimer);
      const act = () => {
        if (it.submenu && !it.disabled) openSub(false);
        else closeFrom(level + 1);
      };
      // a submenu is open: wait a moment so the pointer can travel across other rows to reach it
      if (e.pointerType === 'mouse' && openMenus.length > level + 1 && !subOpen()) {
        hoverLevel = level;
        hoverTimer = setTimeout(act, 150);
      } else act();
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.submenu) openSub(false);
      else run();
    });
    menu.append(row);
  }
  // separators only between items
  for (const el of [...menu.children]) {
    if (!el.classList.contains('sep')) continue;
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    if (!prev || !next || prev.classList.contains('sep') || next.classList.contains('sep')) el.remove();
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenus.push(menu);
  if (select) setActive(menu, menuRows(menu)[0]);
  return menu;
}

window.addEventListener('pointerdown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target))) return;
  if (e.target.closest?.('.menu-btn')) return;
  closeMenus();
}, true);

window.addEventListener('keydown', (e) => {
  if (!openMenus.length) return;
  const level = openMenus.length - 1;
  const menu = openMenus[level];
  const rows = menuRows(menu);
  const cur = menu.querySelector(':scope > .item.active:not(.disabled)');
  const i = rows.indexOf(cur);
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case 'Escape':
      stop();
      if (level > 0) closeFrom(level);
      else closeMenus();
      break;
    case 'ArrowDown':
      stop();
      setActive(menu, rows[i < 0 ? 0 : (i + 1) % rows.length]);
      break;
    case 'ArrowUp':
      stop();
      setActive(menu, rows[i <= 0 ? rows.length - 1 : i - 1]);
      break;
    case 'Home':
    case 'PageUp':
      stop();
      setActive(menu, rows[0]);
      break;
    case 'End':
    case 'PageDown':
      stop();
      setActive(menu, rows[rows.length - 1]);
      break;
    case 'ArrowRight':
      stop();
      if (cur?.open) cur.open(true);
      else menuNav?.step(1);
      break;
    case 'ArrowLeft':
      stop();
      if (level > 0) closeFrom(level);
      else menuNav?.step(-1);
      break;
    case 'Enter':
    case ' ':
      stop();
      if (cur?.open) cur.open(true);
      else cur?.run?.();
      break;
    case 'Tab':
      stop();
      break;
    default:
  }
}, true);
window.addEventListener('blur', () => closeMenus());

export const menusOpen = () => openMenus.length > 0;

// ---------------------------------------------------------------- modals

const modalStack = [];
// a dialog whose backdrop was taken out of the page some other way counts as closed
function pruneModals() {
  for (const m of [...modalStack]) if (!m.modal.isConnected) m.close();
  return modalStack;
}
/** True while a dialog is open. */
export const modalOpen = () => pruneModals().length > 0;

const FOCUSABLE = 'button, input:not([type=hidden]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const canFocus = (el) => !el.disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(canFocus);

/**
 * A dialog. `peek` (default: photo dialogs with sliders, which preview on the picture) adds a
 * "창 숨기기" button (H): the dialog steps aside so the whole picture can be seen (and panned or
 * zoomed) and comes back with "창 다시 보기"; `compare(on)` adds a hold-to-see-the-original button.
 * Keys: Enter runs the primary button (not from a text area or a focused button), Esc closes,
 * Tab stays inside the dialog. Only the topmost dialog answers; the editors' shortcuts wait.
 */
export function openModal({ title, body, buttons = [{ label: '닫기', primary: true }], onClose, width, peek, compare }) {
  const footer = h('footer');
  const head = h('header', h('span.modal-title', title));
  const modal = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : null, style: width ? { width } : null },
    head, h('div.body', body), footer);
  const backdrop = h('div.modal-backdrop', modal);
  const prevFocus = document.activeElement;
  const entry = { modal, close: () => close() };
  const isTop = () => pruneModals()[modalStack.length - 1] === entry;
  let closed = false;
  const canPeek = peek ?? (document.body.classList.contains('photo-mode') && !!modal.querySelector('input[type=range]'));
  let peekBar = null;
  const peeking = () => backdrop.classList.contains('peeking');
  const setPeek = (on) => {
    if (closed || on === peeking()) return;
    backdrop.classList.toggle('peeking', on);
    document.body.classList.toggle('modal-peeking', on);
    peekBar?.remove();
    peekBar = null;
    if (on) {
      const hold = compare ? h('button.peek-hold', { title: '누르고 있는 동안 적용 전 원본을 보여 줍니다', 'aria-label': '원본 보기 (누르고 있기)' }, '원본 보기') : null;
      if (hold) {
        let down = false;
        const up = () => {
          if (!down) return;
          down = false;
          hold.classList.remove('on');
          compare(false);
        };
        hold.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          down = true;
          hold.classList.add('on');
          compare(true);
        });
        for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) hold.addEventListener(ev, up);
        hold.addEventListener('contextmenu', (e) => e.preventDefault());
      }
      peekBar = h('div.peek-bar', { role: 'toolbar', 'aria-label': '미리 보기' },
        h('span.peek-note', '창을 숨긴 동안 그림을 끌어 옮기고 확대해 볼 수 있습니다'),
        hold,
        h('button.primary', { onclick: () => setPeek(false) }, icon('eye', 15), ' 창 다시 보기'));
      document.body.append(peekBar);
      setTimeout(() => peekBar?.querySelector('button.primary')?.focus({ preventScroll: true }), 0);
    } else setTimeout(() => head.querySelector('.modal-peek')?.focus({ preventScroll: true }), 0);
  };
  if (canPeek) head.append(h('button.modal-peek', { title: '창 숨기기 (H): 그림 전체를 보며 미리 보기', 'aria-label': '창 숨기기', onclick: () => setPeek(true) }, icon('eyeOff', 15), h('span', '창 숨기기')));
  const close = () => {
    if (closed) return;
    setPeek(false);
    closed = true;
    backdrop.remove();
    const at = modalStack.indexOf(entry);
    if (at >= 0) modalStack.splice(at, 1);
    document.removeEventListener('keydown', guard, true);
    onClose?.();
    // hand the keyboard back to where it was, unless something else took it meanwhile
    const a = document.activeElement;
    if (prevFocus?.isConnected && prevFocus !== document.body && (!a || a === document.body)) prevFocus.focus?.({ preventScroll: true });
  };
  const typing = (t) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type));
  const onKey = (e) => {
    // H: hide / show the dialog; while hidden, Esc and Enter only bring it back
    if (canPeek && e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
      e.preventDefault();
      setPeek(!peeking());
      return;
    }
    if (peeking()) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        setPeek(false);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // keep the keyboard inside the dialog
      const f = focusables(modal);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) {
        e.preventDefault();
        f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
      }
      return;
    }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      const t = e.target;
      // a focused button, link or text area keeps its own Enter
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t instanceof HTMLSelectElement) return;
      const primary = buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        run(primary);
      }
    }
  };
  // keys typed inside the dialog: its controls see them first; what they leave reaches onKey,
  // and nothing reaches the editors' shortcuts
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (!e.defaultPrevented && isTop()) onKey(e);
  });
  // keys aimed elsewhere (the page behind, the peek bar) while this dialog is on top
  const guard = (e) => {
    if (!backdrop.isConnected) {
      close();
      return;
    }
    if (!isTop() || modal.contains(e.target)) return;
    if (e.target?.closest?.('.menu, .font-picker')) return; // pop-ups opened from the dialog handle their keys
    e.stopPropagation();
    onKey(e);
  };
  let busy = false;
  const run = async (b) => {
    if (b.disabled || b.el?.disabled || busy || closed) return;
    busy = true;
    let keep;
    try {
      keep = await b.action?.();
    } catch (err) {
      console.error(err);
      toast(String(err?.message || err));
      keep = false;
    } finally {
      busy = false;
    }
    if (keep !== false) close();
  };
  for (const b of buttons) {
    const btn = h(`button${b.primary ? '.primary' : ''}`, { onclick: () => run(b) }, b.label);
    b.el = btn;
    footer.append(btn);
  }
  document.body.append(backdrop);
  modalStack.push(entry);
  document.addEventListener('keydown', guard, true);
  // on phones, focusing a text field would pop up the keyboard over the dialog
  const phone = document.body.classList.contains('mobile');
  setTimeout(() => {
    if (closed || modal.contains(document.activeElement)) return;
    const first = (sel) => [...modal.querySelectorAll(sel)].find(canFocus);
    (first(phone ? 'button.primary' : 'input:not([type=hidden]),select,textarea,button.primary') || first(FOCUSABLE))?.focus({ preventScroll: phone });
  }, 0);
  return { close, modal, footer, peek: setPeek };
}

export function confirmDialog(title, message) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: h('div', message),
      buttons: [
        { label: '취소' },
        { label: '확인', primary: true, action: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, style: { width: '100%' } });
    let result = null;
    openModal({
      title,
      body: h('div.form-row', h('label', label), input),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    setTimeout(() => input.select(), 0);
  });
}

export function formRow(label, ...controls) {
  return h('div.form-row', h('label', label), h('div.inline', ...controls));
}

// ---------------------------------------------------------------- toasts

let toastBox = null;
export function toast(msg) {
  if (!toastBox) {
    toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div.toast', msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), 3100);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
}

// ---------------------------------------------------------------- scrubbable numbers

const roundTo = (v, decimals) => {
  const q = 10 ** Math.min(decimals, 8);
  return Math.round(v * q) / q;
};
const dragMult = (e) => (e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1);

/**
 * A Premiere-style blue number: drag left or right to change it (Shift: 10x, Ctrl: 1/10), click
 * (or Enter) to type, ↑ ↓ to step; Tab moves to the next number. While typing, Enter applies,
 * Esc cancels.
 * opts: {value, step, min, max, decimals, unit, format(v), parse(str), onStart, onChange(v), onCommit}
 */
export function scrubNumber(opts) {
  const step = opts.step ?? 1;
  const decimals = opts.decimals ?? (step < 0.1 ? 3 : step < 1 ? 2 : 1);
  const fmt = opts.format || ((v) => (Number.isFinite(v) ? roundTo(v, decimals).toString() : '—'));
  const span = h('span.scrub', { tabindex: 0, role: 'spinbutton', title: '끌어서 바꾸기 (Shift: 크게, Ctrl: 세밀하게) · 눌러서 입력' });
  const wrap = h('span.scrub-wrap', span, opts.unit ? h('span.unit', opts.unit) : null);
  let value = opts.value;
  let input = null;
  const set = (v) => {
    value = v;
    span.textContent = fmt(v);
    if (Number.isFinite(v)) span.setAttribute('aria-valuenow', String(v));
  };
  set(value);
  const lim = (v) => clamp(v, opts.min ?? -Infinity, opts.max ?? Infinity);
  /** One finished change (keys, typing). */
  const apply = (v) => {
    v = lim(roundTo(v, decimals));
    if (!Number.isFinite(v)) return;
    opts.onStart?.();
    set(v);
    opts.onChange?.(v);
    opts.onCommit?.(v);
  };

  span.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    span.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let lastX = x0;
    let acc = Number.isFinite(value) ? value : 0;
    let dragging = false;
    // the value follows the pointer from where it is, so pressing Shift or Ctrl midway never jumps
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        dragging = true;
        lastX = x0;
        span.classList.add('dragging');
        opts.onStart?.();
      }
      acc = lim(acc + (ev.clientX - lastX) * step * dragMult(ev));
      lastX = ev.clientX;
      const v = lim(roundTo(acc, decimals));
      if (v === value) return;
      set(v);
      opts.onChange?.(v);
    };
    const up = () => {
      span.removeEventListener('pointermove', move);
      span.removeEventListener('pointerup', up);
      span.removeEventListener('pointercancel', up);
      span.classList.remove('dragging');
      if (dragging) opts.onCommit?.(value);
      else edit();
    };
    span.addEventListener('pointermove', move);
    span.addEventListener('pointerup', up);
    span.addEventListener('pointercancel', up);
  });
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      edit();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      apply((Number.isFinite(value) ? value : 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * dragMult(e));
    }
  });

  function edit() {
    if (input) return;
    input = h('input.scrub-input', { type: 'text', value: fmt(value), inputMode: 'decimal', 'aria-label': span.getAttribute('aria-label') || '값' });
    const field = input;
    span.replaceWith(field);
    field.focus();
    field.select();
    let done = false;
    const parse = () => (opts.parse ? opts.parse(field.value) : parseFloat(field.value));
    const finish = (ok) => {
      if (done) return;
      done = true;
      input = null;
      if (field.isConnected) field.replaceWith(span);
      if (ok) {
        const parsed = parse();
        if (parsed != null && Number.isFinite(parsed) && lim(roundTo(parsed, decimals)) !== value) apply(parsed);
      }
    };
    field.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        // a dialog may also take Enter as "OK" — it gets the new value first
        finish(true);
        return;
      }
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        span.focus({ preventScroll: true });
      } else if (e.key === 'Tab') {
        // Premiere: Tab goes on to the next number
        e.preventDefault();
        const scope = wrap.closest('.modal, .panel-body, .ph-side, .ph-opts') || document.body;
        const all = [...scope.querySelectorAll('.scrub, .scrub-input')];
        const at = all.indexOf(field);
        finish(true);
        const next = all[at + (e.shiftKey ? -1 : 1)];
        const nextEdit = next?.isConnected && next.classList.contains('scrub') ? next.closest('.scrub-wrap')?.edit : null;
        if (nextEdit) nextEdit();
        else span.focus({ preventScroll: true });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = parse();
        const v = lim(roundTo((Number.isFinite(cur) ? cur : value) + (e.key === 'ArrowUp' ? 1 : -1) * step * dragMult(e), decimals));
        field.value = fmt(v);
        field.select();
        opts.onStart?.();
        set(v);
        opts.onChange?.(v);
        opts.onCommit?.(v);
      }
    });
    field.addEventListener('blur', () => finish(true));
  }

  wrap.update = (v) => {
    if (input || span.classList.contains('dragging')) return;
    set(v);
  };
  wrap.edit = edit;
  return wrap;
}

/**
 * A slider with a scrubbable number beside it, kept in step:
 * {label, min, max, step, value, unit, decimals, format, title, onInput(v), onChange(v)}.
 * onInput runs while either control moves, onChange once a change is finished.
 * Returns the row element; row.value reads or sets the value, row.input is the slider.
 */
export function sliderField({ label = '', min = 0, max = 100, step = 1, value = min, unit = '', decimals, format, title, onInput, onChange }) {
  let v = value;
  const range = h('input', { type: 'range', min, max, step, value, 'aria-label': label || title || '' });
  const num = scrubNumber({
    value, step, min, max, unit, decimals, format,
    onChange: (x) => {
      v = x;
      range.value = String(x);
      onInput?.(x);
    },
    onCommit: (x) => {
      v = x;
      onChange?.(x);
    },
  });
  range.addEventListener('input', () => {
    v = parseFloat(range.value);
    num.update(v);
    onInput?.(v);
  });
  range.addEventListener('change', () => {
    v = parseFloat(range.value);
    onChange?.(v);
  });
  const row = h('div.slider-field', { title }, label ? h('span.sf-label', label) : null, range, h('span.sf-num', num));
  Object.defineProperty(row, 'value', {
    get: () => v,
    set: (x) => {
      v = x;
      range.value = String(x);
      num.update(x);
    },
  });
  row.input = range;
  return row;
}

/**
 * Number boxes in dialogs (and any input.scrubbable) scrub like Premiere's blue numbers: drag left
 * or right on the box (Shift: 10x, Ctrl: 1/10), or click it to type.
 */
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || e.button !== 0 || t.disabled || t.readOnly) return;
  if (!t.classList.contains('scrubbable') && !(t.type === 'number' && t.closest('.modal'))) return;
  // even a focused box scrubs when dragged (a dialog focuses its first box); a click selects the value
  e.preventDefault();
  const step = parseFloat(t.step) > 0 ? parseFloat(t.step) : 1;
  const min = t.min !== '' && Number.isFinite(parseFloat(t.min)) ? parseFloat(t.min) : -Infinity;
  const max = t.max !== '' && Number.isFinite(parseFloat(t.max)) ? parseFloat(t.max) : Infinity;
  const decimals = (String(step).split('.')[1] || '').length;
  let acc = parseFloat(t.value);
  if (!Number.isFinite(acc)) acc = Number.isFinite(min) ? min : 0;
  const x0 = e.clientX;
  let lastX = x0;
  let dragging = false;
  t.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - x0) < 3) return;
      dragging = true;
      t.classList.add('scrubbing');
    }
    acc = clamp(acc + (ev.clientX - lastX) * step * dragMult(ev), min, max);
    lastX = ev.clientX;
    const v = clamp(Number((Math.round(acc / step) * step).toFixed(decimals)), min, max);
    if (String(v) === t.value) return;
    t.value = String(v);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const up = () => {
    t.removeEventListener('pointermove', move);
    t.removeEventListener('pointerup', up);
    t.removeEventListener('pointercancel', up);
    t.classList.remove('scrubbing');
    if (dragging) t.dispatchEvent(new Event('change', { bubbles: true }));
    else {
      t.focus();
      t.select?.();
    }
  };
  t.addEventListener('pointermove', move);
  t.addEventListener('pointerup', up);
  t.addEventListener('pointercancel', up);
}, true);

/**
 * Swap an element for a text input until Enter/Escape/blur. onCommit(value) runs on Enter or blur.
 */
export function inlineEdit(el, { width = '96px', onCommit }) {
  const input = h('input', { type: 'text', value: el.textContent, style: { width } });
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (input.isConnected) input.replaceWith(el);
    if (apply) onCommit(input.value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
}

/** Fit a w×h box inside a container, returning CSS pixel rect. */
export function fitRect(cw, ch, w, h, zoom = 0) {
  const s = zoom > 0 ? zoom : Math.min(cw / w, ch / h);
  const dw = w * s;
  const dh = h * s;
  return { x: Math.round((cw - dw) / 2), y: Math.round((ch - dh) / 2), w: Math.round(dw), h: Math.round(dh), s };
}

/** Resize a canvas backing store to its CSS size × devicePixelRatio. Returns ctx scaled to CSS px. */
export function fitCanvasToBox(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const hh = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== hh) {
    canvas.width = w;
    canvas.height = hh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height, dpr };
}

// ---------------------------------------------------------------- UI size & focus hygiene

export const UI_SCALES = [[0.9, '작게'], [1, '보통'], [1.15, '크게'], [1.3, '아주 크게']];

export function uiScale() {
  const v = Number(loadPref('uiScale', 1));
  return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : 1;
}

export function applyUiScale(v = uiScale()) {
  v = Number(v);
  if (!Number.isFinite(v) || v < 0.5 || v > 2) v = 1;
  document.documentElement.style.setProperty('--ui-scale', String(v));
  savePref('uiScale', v);
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('montage:uiscale'));
}

/**
 * Keep keyboard shortcuts working after mouse use: clicking a button must not leave it focused
 * (Space would "click" it again), and a changed dropdown hands focus back to the page.
 */
export function installFocusHygiene() {
  document.addEventListener('mousedown', (e) => {
    const b = e.target.closest?.('button');
    if (b && !b.closest('.modal')) e.preventDefault();
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement && !t.closest('.modal')) t.blur();
    if (t instanceof HTMLInputElement && (t.type === 'range' || t.type === 'checkbox' || t.type === 'color') && !t.closest('.modal')) t.blur();
  }, true);
}

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

/** Bring a panel to front wherever it lives. */
/** onShow(id) runs whenever a panel is brought forward on purpose (the phone layout opens its sheet). */
export const panelHooks = { onShow: null };

export function showPanel(id, { quiet = false } = {}) {
  for (const g of groups) if (g.has(id)) g.activate(id);
  if (!quiet) panelHooks.onShow?.(id);
}

export function toggleMaximize() {
  const focused = groups.find((g) => g.active === store.ui.focusPanel);
  const current = groups.find((g) => g.el.classList.contains('maximized'));
  if (current) current.el.classList.remove('maximized');
  else if (focused) focused.el.classList.add('maximized');
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------- splitters

export function initSplitters() {
  const root = document.documentElement;
  for (const sp of document.querySelectorAll('.splitter')) {
    const v = sp.dataset.var;
    const saved = loadPref(`split${v}`, null);
    if (saved) root.style.setProperty(v, saved);
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      const target = document.getElementById(sp.dataset.target);
      const horizontal = sp.classList.contains('v');
      const startPos = horizontal ? e.clientX : e.clientY;
      const startSize = horizontal ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
      const move = (ev) => {
        const d = (horizontal ? ev.clientX : ev.clientY) - startPos;
        const max = horizontal ? window.innerWidth - 240 : window.innerHeight - 180;
        const size = clamp(startSize + d, 160, max);
        root.style.setProperty(v, `${size}px`);
        window.dispatchEvent(new Event('resize'));
      };
      const up = () => {
        sp.classList.remove('dragging');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        savePref(`split${v}`, root.style.getPropertyValue(v));
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  }
}

// ---------------------------------------------------------------- menus

let openMenus = [];

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open'));
}

/**
 * items: [{label, key, action, disabled, checked, submenu}] or '-' for separators.
 * Items may also be functions returning such arrays (evaluated lazily).
 */
/** Small inline SVG showing a curve (path in a 30×20 box) — used for easing previews. */
function curveIcon(d) {
  const span = h('span.curve');
  span.innerHTML = `<svg viewBox="0 0 30 20" aria-hidden="true"><path d="M3 17H27M3 3H27" class="guide"/><path d="${d}"/></svg>`;
  return span;
}

export function showMenu(items, x, y, { level = 0 } = {}) {
  if (level === 0) closeMenus();
  else openMenus.slice(level).forEach((m) => m.remove()), (openMenus = openMenus.slice(0, level));
  const list = typeof items === 'function' ? items() : items;
  const menu = h('div.menu', { role: 'menu' });
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
    const row = h(`div.item${it.disabled ? '.disabled' : ''}${it.checked ? '.checked' : ''}${it.submenu ? '.sub' : ''}`, { role: 'menuitem' },
      it.swatch ? h('span.swatch', { style: { background: it.swatch } }) : null,
      it.curve ? curveIcon(it.curve) : null,
      h('span.label', it.label), it.hint ? h('span.hint', it.hint) : null, it.key ? h('span.key', it.key) : null);
    if (it.submenu && !it.disabled) {
      row.addEventListener('pointerenter', () => {
        const r = row.getBoundingClientRect();
        showMenu(it.submenu, r.right - 2, r.top - 4, { level: level + 1 });
      });
    } else if (!it.submenu) {
      row.addEventListener('pointerenter', () => {
        openMenus.slice(level + 1).forEach((m) => m.remove());
        openMenus = openMenus.slice(0, level + 1);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenus();
        try {
          it.action?.();
        } catch (err) {
          console.error(err);
          toast(String(err.message || err));
        }
      });
    }
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenus.push(menu);
  return menu;
}

window.addEventListener('pointerdown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target))) return;
  if (e.target.closest?.('.menu-btn')) return;
  closeMenus();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenus.length) {
    closeMenus();
    e.stopPropagation();
  }
}, true);

export const menusOpen = () => openMenus.length > 0;

// ---------------------------------------------------------------- modals

/**
 * A dialog. `peek` (default: photo dialogs with sliders, which preview on the picture) adds a
 * "창 숨기기" button (H): the dialog steps aside so the whole picture can be seen (and panned or
 * zoomed) and comes back with "창 다시 보기"; `compare(on)` adds a hold-to-see-the-original button.
 */
export function openModal({ title, body, buttons = [{ label: '닫기', primary: true }], onClose, width, peek, compare }) {
  const footer = h('footer');
  const head = h('header', h('span.modal-title', title));
  const modal = h('div.modal', { role: 'dialog', 'aria-modal': 'true', style: width ? { width } : null },
    head, h('div.body', body), footer);
  const backdrop = h('div.modal-backdrop', modal);
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
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const typing = (t) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type));
  const onKey = (e) => {
    e.stopPropagation();
    // H: hide / show the dialog; while hidden, Esc and Enter only bring it back
    if (canPeek && e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
      e.preventDefault();
      setPeek(!peeking());
      return;
    }
    if (peeking() && (e.key === 'Escape' || e.key === 'Enter')) {
      e.preventDefault();
      setPeek(false);
      return;
    }
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      const primary = buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        run(primary);
      }
    }
  };
  const run = async (b) => {
    if (b.disabled) return;
    const keep = await b.action?.();
    if (keep !== false) close();
  };
  for (const b of buttons) {
    const btn = h(`button${b.primary ? '.primary' : ''}`, { onclick: () => run(b) }, b.label);
    b.el = btn;
    footer.append(btn);
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  // on phones, focusing a text field would pop up the keyboard over the dialog
  const phone = document.body.classList.contains('mobile');
  setTimeout(() => modal.querySelector(phone ? 'button.primary' : 'input,select,textarea,button.primary')?.focus({ preventScroll: phone }), 0);
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
  });
}

export function formRow(label, ...controls) {
  return h('div.form-row', h('label', label), h('div.inline', ...controls));
}

// ---------------------------------------------------------------- toasts

let toastBox = null;
export function toast(msg) {
  if (!toastBox) {
    toastBox = h('div.toasts');
    document.body.append(toastBox);
  }
  const t = h('div.toast', msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), 3100);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
}

// ---------------------------------------------------------------- scrubbable numbers

/**
 * A Premiere-style blue number you can drag horizontally or click to type.
 * opts: {value, step, min, max, decimals, unit, format(v), parse(str), onStart, onChange(v), onCommit}
 */
export function scrubNumber(opts) {
  const step = opts.step ?? 1;
  const decimals = opts.decimals ?? (step < 1 ? 2 : step < 0.1 ? 3 : 1);
  const fmt = opts.format || ((v) => (Number.isFinite(v) ? (Math.round(v * 10 ** decimals) / 10 ** decimals).toString() : '—'));
  const span = h('span.scrub', { tabindex: 0 });
  const wrap = h('span', span, opts.unit ? h('span.unit', opts.unit) : null);
  let value = opts.value;
  const set = (v) => {
    value = v;
    span.textContent = fmt(v);
  };
  set(value);
  const lim = (v) => clamp(v, opts.min ?? -Infinity, opts.max ?? Infinity);

  span.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    span.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = value;
    let dragging = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!dragging && Math.abs(dx) < 3) return;
      if (!dragging) {
        dragging = true;
        opts.onStart?.();
      }
      const mult = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
      const v = lim(v0 + Math.round(dx) * step * mult);
      set(v);
      opts.onChange?.(v);
    };
    const up = () => {
      span.removeEventListener('pointermove', move);
      span.removeEventListener('pointerup', up);
      if (dragging) opts.onCommit?.(value);
      else edit();
    };
    span.addEventListener('pointermove', move);
    span.addEventListener('pointerup', up);
  });
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      edit();
    }
  });

  function edit() {
    const input = h('input.scrub-input', { type: 'text', value: fmt(value) });
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      if (apply) {
        const parsed = opts.parse ? opts.parse(input.value) : parseFloat(input.value);
        if (parsed != null && Number.isFinite(parsed)) {
          const v = lim(parsed);
          opts.onStart?.();
          set(v);
          opts.onChange?.(v);
          opts.onCommit?.(v);
        }
      }
      input.replaceWith(span);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  wrap.update = (v) => {
    if (document.activeElement?.classList.contains('scrub-input') && wrap.contains(document.activeElement)) return;
    set(v);
  };
  return wrap;
}

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
  return loadPref('uiScale', 1);
}

export function applyUiScale(v = uiScale()) {
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

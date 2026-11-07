// On-canvas sessions: Free Transform and its kin (warp, perspective warp, puppet warp, content-aware
// scale) or a crop box being changed. Like Photoshop, what would change the document waits until the
// session is applied (Enter) or cancelled (Esc): those menu items are greyed out, their shortcuts and
// the panels that edit the document do nothing. Text being typed is committed first instead.
import { toast } from '../ui/common.js';
import { TOOL_BY_ID } from './tools.js';
import { Transformer } from './transform.js';

/** Panels that change the document (colour, swatches, brushes, navigator, info… keep working). */
const LOCKED = new Set(['layers', 'channels', 'paths', 'history', 'adjustments', 'props', 'styles', 'actions', 'comps', 'timeline', 'gradients', 'patterns', 'shapes', 'char', 'para', 'charStyles', 'paraStyles', 'glyphs', 'ai']);
// View ▸ guide commands are history steps
const GUIDE_EDITS = /^(안내선 지우기|새 안내선|모양에서 새 안내선)/;

const items = (x) => (typeof x === 'function' ? x() : x) || [];

export function installSessionLock(P, { panels }) {
  /** 'transform' | 'crop' while a session is open, else null. */
  P.busy = () => {
    if (!P.doc) return null;
    if (P.transform) return 'transform';
    const t = TOOL_BY_ID[P.tool];
    if (P.tool === 'crop' && t.b && (!t.fresh || t.d)) return 'crop';
    if (P.tool === 'perspCrop' && t.q) return 'crop';
    return null;
  };
  const freeTransform = () => P.transform instanceof Transformer;
  let hinted = 0;
  const hint = () => {
    if (performance.now() - hinted < 2500) return;
    hinted = performance.now();
    toast(P.busy() === 'crop' ? '자르는 중에는 쓸 수 없습니다. Enter로 자르거나 Esc로 취소하세요' : '변형하는 중에는 쓸 수 없습니다. Enter로 적용하거나 Esc로 취소하세요');
  };
  P.busyHint = hint;

  // ---- menus: greyed out, except the transform's own commands, zoom and the screen, Window and Help
  const lock = (list, keep) => list.map((it) => {
    if (!it || typeof it !== 'object' || it.group || it.disabled || keep(it)) return it;
    // (a greyed submenu's items too: the phone's 조정 / 필터 lists open them directly)
    const sub = it.submenu;
    return { ...it, disabled: true, ...(sub ? { submenu: () => lock(items(sub), () => false) } : {}) };
  });
  const keepIn = (menu) => (it) => {
    if (menu === '창' || menu === '도움말') return true;
    if (menu === '보기') return !GUIDE_EDITS.test(it.label);
    if (menu !== '편집') return false;
    if (/^(실행 취소|바로 가기 키|환경 설정)/.test(it.label)) return true;
    if (!freeTransform()) return false;
    if (it.label === '자유 변형') return true;
    // Edit ▸ Transform: scale, rotate, skew… turn the open box; Again and the copies wait
    if (it.label === '변형' && it.submenu) {
      const sub = it.submenu;
      it.submenu = () => lock(items(sub), (x) => !/^(다시|복사본)/.test(x.label));
      return true;
    }
    return false;
  };
  // typing: the text is committed, then the command runs (the Type menu works on the text being typed)
  const commitFirst = (list) => list.map((it) => {
    if (!it || typeof it !== 'object' || it.group || it.disabled) return it;
    const out = { ...it };
    if (it.action) out.action = (...a) => {
      P.finishText?.();
      return it.action(...a);
    };
    if (it.submenu) out.submenu = () => commitFirst(items(it.submenu));
    return out;
  });
  const guard = (name, list) => {
    if (P.busy()) return lock(list.map((it) => (it && typeof it === 'object' ? { ...it } : it)), keepIn(name));
    if (P.editingText && !['문자', '보기', '창', '도움말'].includes(name)) return commitFirst(list);
    return list;
  };
  // modules replace P.menus[name] at any time: each one is guarded when it is read
  P.menus = new Proxy(P.menus, {
    get(t, k) {
      const f = t[k];
      return typeof f === 'function' ? () => guard(k, items(f)) : f;
    },
  });
  for (const [id, fn] of Object.entries(P.panelMenus || {})) if (LOCKED.has(id)) P.panelMenus[id] = () => (P.busy() ? lock(items(fn), () => false) : items(fn));

  // ---- panels, the quick mask button and the top bar's Export: nothing happens (with a hint)
  const lockedAt = (el) => {
    if (el.closest?.('.ph-qm, .export-btn')) return true;
    for (const [id, p] of Object.entries(panels)) if (LOCKED.has(id) && p.el.contains(el)) return true;
    return false;
  };
  const stop = (e) => {
    if (!document.body.classList.contains('photo-mode') || !P.busy() || !(e.target instanceof Element) || !lockedAt(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown' || e.type === 'keydown') hint();
  };
  for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'dragstart', 'drop', 'keydown', 'change', 'input']) window.addEventListener(ev, stop, { capture: true, passive: false });
  // the locked panels look it
  const paint = () => {
    const busy = !!P.busy();
    for (const [id, p] of Object.entries(panels)) if (LOCKED.has(id)) p.el.classList.toggle('ph-locked', busy);
  };
  for (const ev of ['transform', 'tool', 'opts', 'doc', 'history']) P.on(ev, paint);
  const overlay = P.overlay;
  if (overlay) P.overlay = (...a) => {
    paint();
    return overlay(...a);
  };

  // ---- Ctrl+Z while cropping: the box goes back (Photoshop undoes the crop box's last change)
  const undo = P.undo;
  P.undo = () => {
    if (P.busy() === 'crop') {
      TOOL_BY_ID[P.tool].activate(P);
      P.overlay();
      return undefined;
    }
    return undo();
  };
  // a command run during a transform some other way (a dropped file, a paste): the transform is applied first
  const run = P.run;
  P.run = (label, fn) => {
    if (P.transform) P.applyTransform();
    return run(label, fn);
  };
}

/**
 * Keys that would change the document while a session is open: they do nothing (true).
 * The transform's own keys, zoom, the screen and the panels that only show things still work.
 */
export function blockedWhileBusy(P, e, mod) {
  const busy = P.busy?.();
  if (!busy) return false;
  const k = e.code;
  const alt = e.altKey;
  const sh = e.shiftKey;
  let ok;
  if (mod) {
    ok = ['Digit0', 'Digit1', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Semicolon', 'Tab', 'F6'].includes(k)
      || (k === 'KeyZ' && !alt && !sh) // undo: cancels the transform (crop: resets the box)
      || (k === 'KeyT' && !alt && !sh && P.transform instanceof Transformer)
      || (['KeyR', 'KeyH'].includes(k) && !alt && !sh) // rulers, extras
      || (k === 'Quote' && !sh && !alt) // grid
      || (k === 'KeyY' && !alt && !!P.cmd.proofColors) // proof colours, gamut warning
      || (k === 'KeyK' && (!alt || sh)); // preferences, keyboard shortcuts
  } else if (alt) ok = false;
  else {
    ok = /^(Arrow|Enter|NumpadEnter|Escape|Space|Tab|Bracket|Shift|Control|Alt|Meta)/.test(k)
      || ['KeyX', 'KeyD', 'KeyF'].includes(k)
      || (/^F[5-9]$/.test(k) && !sh)
      || (sh && (k === 'F1' || k === 'F2')) // interface theme
      // the transform's own Delete (puppet pins, perspective warp quads)
      || ((k === 'Delete' || k === 'Backspace') && busy === 'transform')
      // tool keys: another tool while cropping (Photoshop ignores them during a transform)
      || (/^Key[A-Z]$/.test(k) && k !== 'KeyQ' && busy === 'crop');
  }
  if (!ok) P.busyHint?.();
  return !ok;
}

// Touch on phones and tablets, the way Photoshop on iPad does it with a finger:
//  - the touch shortcut (터치 단축키): a round button that stands in for Shift and Alt (add to a
//    selection, constrain, pick a clone source…); a tap turns it on for the next stroke, a long
//    press keeps it on
//  - press and hold on the picture: an eyedropper for the painting tools, the right-click menu for
//    the move and selection tools and during a transform
//  - a two-finger tap undoes, a three-finger tap redoes
//  - once a pen (Apple Pencil, S Pen) has drawn, a lone finger moves the view instead of painting,
//    and a palm-sized touch is ignored
//  - the options bar fades at the edge that has more to scroll
import { h } from '../util.js';
import { toast, showMenu, closeMenus, openModal } from '../ui/common.js';
import { TOOL_BY_ID, sampleColor, rgbHex } from './tools.js';

const isMobile = () => document.body.classList.contains('mobile');
const coarse = () => window.matchMedia?.('(pointer: coarse)').matches;
// held still this long (ms) and within this many px: a long press
const HOLD_MS = 550;
const SLOP = 10;
// tools whose long press picks a colour (Photoshop on iPad: touch and hold for the eyedropper)
const PICKS = new Set(['brush', 'pencil', 'mixer', 'colorReplace', 'bucket', 'gradient', 'shape', 'ellipseShape', 'triangleShape', 'polygonShape', 'lineShape', 'customShape']);
// tools whose long press opens the right-click menu
const MENUS = new Set(['move', 'select']);

export function installPhone(P, { stage, opts }) {
  // ---------------------------------------------------------------- the options bar's edges
  const edges = () => {
    const more = opts.scrollWidth - opts.clientWidth > 2;
    opts.classList.toggle('ph-more-l', more && opts.scrollLeft > 2);
    opts.classList.toggle('ph-more-r', more && opts.scrollLeft < opts.scrollWidth - opts.clientWidth - 2);
  };
  opts.addEventListener('scroll', edges, { passive: true });
  new ResizeObserver(edges).observe(opts);
  new MutationObserver(() => {
    // a new tool's bar starts at its left end
    opts.scrollLeft = 0;
    edges();
  }).observe(opts, { childList: true });

  // ---------------------------------------------------------------- touch shortcut (Shift / Alt)
  // mod: null | 'shift' | 'alt'; locked: stays on after the stroke
  let mod = null;
  let locked = false;
  const tsc = h('button.ph-tsc', { type: 'button', 'aria-label': '터치 단축키 (Shift / Alt)', title: '터치 단축키: 누를 때마다 Shift → Alt → 끔. 길게 누르면 계속 켜 둡니다.' }, h('span'));
  const paintTsc = () => {
    tsc.classList.toggle('on', !!mod);
    tsc.classList.toggle('locked', !!mod && locked);
    tsc.firstChild.textContent = mod === 'alt' ? 'Alt' : 'Shift';
    tsc.setAttribute('aria-pressed', String(!!mod));
    tsc.hidden = !P.doc || !coarse();
  };
  let tscTimer = 0;
  let tscHeld = false;
  tsc.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    tscHeld = false;
    clearTimeout(tscTimer);
    tscTimer = setTimeout(() => {
      tscHeld = true;
      if (!mod) mod = 'shift';
      locked = true;
      paintTsc();
      toast(`${mod === 'alt' ? 'Alt' : 'Shift'}를 계속 누른 상태로 둡니다. 다시 누르면 꺼집니다.`);
    }, HOLD_MS);
  });
  for (const ev of ['pointercancel', 'pointerleave']) tsc.addEventListener(ev, () => clearTimeout(tscTimer));
  // on pointerup, not click: a browser may make no click for a tap right after a drag on the picture
  tsc.addEventListener('click', (e) => e.stopPropagation());
  tsc.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    clearTimeout(tscTimer);
    if (tscHeld) return;
    if (locked) {
      mod = null;
      locked = false;
    } else mod = mod === null ? 'shift' : mod === 'shift' ? 'alt' : null;
    paintTsc();
  });
  for (const ev of ['dblclick', 'contextmenu']) tsc.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
  stage.append(tsc);
  for (const ev of ['doc', 'tool']) P.on(ev, paintTsc);
  window.matchMedia?.('(pointer: coarse)').addEventListener?.('change', paintTsc);
  paintTsc();
  /** The touch shortcut's key on an event from a finger or a pen (the tools read e.shiftKey / e.altKey). */
  const withMod = (e) => {
    if (!mod || e.pointerType === 'mouse') return;
    Object.defineProperty(e, mod === 'alt' ? 'altKey' : 'shiftKey', { value: true });
  };

  // ---------------------------------------------------------------- fingers on the picture
  const fingers = new Map(); // pointerId -> { x, y, x0, y0 }
  let gesture = null; // { t0, max, moved } from the first finger down to the last one up
  let hold = null; // { id, timer, x, y } the long press being timed
  let picking = null; // { id, ring } the long-press eyedropper
  let penSeen = false;
  let penHinted = false;
  const ignored = new Set(); // palms and the fingers of a long press: the editor never sees them
  const stopHold = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  /** End what the editor started with this pointer (a stroke, a drag): it is cancelled, not applied. */
  const cancelEditor = (id) => {
    P.transform?.up?.();
    stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true }));
    try {
      stage.releasePointerCapture(id);
    } catch { /* not captured */ }
  };
  const ownEvent = (e) => e.target === tsc || e.target.closest?.('.ph-ctb, .ph-tsc, .ph-home, .ph-textedit');

  const pick = (x, y) => {
    if (!P.doc) return;
    const c = sampleColor(P, P.toDoc(x, y));
    if (!c) return;
    P.setColor(rgbHex(...c), false, true);
    picking.ring.style.left = `${x}px`;
    picking.ring.style.top = `${y}px`;
    picking.ring.style.borderColor = P.fg;
  };
  const startPick = (id, x, y) => {
    const ring = h('div.ph-pickring', { 'aria-hidden': 'true' });
    document.body.append(ring);
    picking = { id, ring, before: P.fg };
    pick(x, y);
  };
  const endPick = () => {
    if (!picking) return;
    picking.ring.remove();
    // remembered like a colour picked with the eyedropper tool
    if (P.fg !== picking.before) P.setColor(P.fg);
    toast(`전경색: ${P.fg}`);
    picking = null;
  };

  const onHold = () => {
    const hd = hold;
    hold = null;
    if (!hd || fingers.size !== 1 || !P.doc) return;
    const t = TOOL_BY_ID[P.tool];
    const pickTool = PICKS.has(P.tool) && !P.transform && !P.opts(P.tool)?.airbrush;
    const menuTool = P.transform || MENUS.has(t?.group) || MENUS.has(P.tool);
    if (!pickTool && !menuTool) return;
    if (P.busy?.() === 'crop' || P.editingText) return;
    ignored.add(hd.id);
    cancelEditor(hd.id);
    navigator.vibrate?.(10);
    // the click the browser makes when this finger lifts must not land on the menu opened under it
    const eat = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', eat, { capture: true, once: true });
    // (some browsers make none: the next touch is a fresh one)
    window.addEventListener('pointerdown', () => window.removeEventListener('click', eat, true), { capture: true, once: true });
    if (pickTool) return void startPick(hd.id, hd.x, hd.y);
    closeMenus();
    showMenu(P.contextMenu(), hd.x, hd.y);
  };

  const down = (e) => {
    if (ownEvent(e)) return;
    // handles and points give a finger a bigger target (transform.js, pathtools.js)
    P.lastPointerType = e.pointerType;
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerType !== 'touch') {
      withMod(e);
      return;
    }
    // a palm: a contact much bigger than a fingertip
    if (e.width * e.height > 3600) {
      ignored.add(e.pointerId);
      e.stopPropagation();
      return;
    }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (fingers.size === 1) gesture = { t0: performance.now(), max: 1, moved: false };
    else if (gesture) gesture.max = Math.max(gesture.max, fingers.size);
    if (fingers.size === 1) {
      hold = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(onHold, HOLD_MS) };
      // a pen has been drawing: a lone finger moves the view (as the middle mouse button does)
      if (penSeen && !P.transform && P.tool !== 'hand') {
        Object.defineProperty(e, 'button', { value: 1 });
        if (!penHinted) toast('펜으로 그리는 동안 손가락은 화면을 옮기기만 합니다 (손바닥이 닿아도 칠해지지 않게)');
        penHinted = true;
      }
    } else stopHold();
    withMod(e);
  };
  const move = (e) => {
    if (ignored.has(e.pointerId)) {
      e.stopPropagation();
      if (picking?.id === e.pointerId) pick(e.clientX, e.clientY);
      return;
    }
    const f = fingers.get(e.pointerId);
    if (f) {
      f.x = e.clientX;
      f.y = e.clientY;
      if (Math.hypot(f.x - f.x0, f.y - f.y0) > SLOP) {
        if (gesture) gesture.moved = true;
        if (hold?.id === e.pointerId) stopHold();
      }
    }
    withMod(e);
  };
  const up = (e) => {
    // (listened for on the window: a finger may lift over the menu its long press opened)
    if (!fingers.has(e.pointerId) && !ignored.has(e.pointerId) && !stage.contains(e.target)) return;
    const wasIgnored = ignored.delete(e.pointerId);
    if (wasIgnored) e.stopPropagation();
    if (picking?.id === e.pointerId) endPick();
    if (hold?.id === e.pointerId) stopHold();
    if (!wasIgnored) withMod(e);
    if (e.pointerType !== 'touch' || !fingers.delete(e.pointerId)) {
      if (e.type === 'pointerup' && e.pointerType === 'pen' && !locked) setTimeout(clearMod, 0);
      return;
    }
    if (fingers.size) return;
    // all fingers up: a quick tap with two or three of them undoes or redoes
    const g = gesture;
    gesture = null;
    if (e.type === 'pointerup' && g && !g.moved && g.max >= 2 && g.max <= 3 && performance.now() - g.t0 < 350) {
      // (they say what they undid)
      if (g.max === 2) P.undo();
      else P.redo();
    }
    // the touch shortcut was for this stroke only
    if (!locked) setTimeout(clearMod, 0);
  };
  const clearMod = () => {
    if (!mod || locked) return;
    mod = null;
    paintTsc();
  };
  stage.addEventListener('pointerdown', down, true);
  stage.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', (e) => {
    // our own cancel (cancelEditor) goes through to the editor
    if (!e.isTrusted) return;
    stopHold();
    up(e);
  }, true);
  for (const ev of ['click', 'dblclick']) stage.addEventListener(ev, (e) => { if (!ownEvent(e) && e.pointerType !== 'mouse') withMod(e); }, true);
  // the browser's own long-press menu (Android) is replaced by the one above
  stage.addEventListener('contextmenu', (e) => {
    if (fingers.size || picking || ignored.size) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  P.touchShortcut = () => mod;

  // ---------------------------------------------------------------- the on-screen keyboard
  // iPhone Safari lays the keyboard over the page instead of making it shorter: the text box (and
  // anything else at the bottom) moves up by the part of the window the keyboard covers
  const vv = window.visualViewport;
  if (vv) {
    const kb = () => {
      // (a page zoomed in by the browser is not a keyboard)
      const covered = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.body.style.setProperty('--ph-kb', `${covered > 80 ? covered : 0}px`);
    };
    vv.addEventListener('resize', kb);
    vv.addEventListener('scroll', kb);
  }

  // ---------------------------------------------------------------- pictures too big for a phone
  // iPhone and iPad Safari draw nothing on a canvas over about 16.7 million pixels, and phones run out
  // of memory long before a desktop does: a bigger photo (a 48 MP camera) opens at about 12 MP
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const HARD = 16_777_216;
  const SAFE = 12_000_000;
  P.openLimit = (w, hh, name) => {
    if (!(isMobile() || ios) || w * hh <= HARD) return 1;
    const k = Math.sqrt(SAFE / (w * hh));
    const sw = Math.round(w * k);
    const sh = Math.round(hh * k);
    return new Promise((resolve) => {
      let answer = 0;
      openModal({
        title: '사진이 휴대폰에서 다루기에 너무 큽니다',
        body: h('div', h('p', `${name}: ${w} × ${hh} 픽셀 (${Math.round((w * hh) / 1e4)}만 화소)`),
          h('p', `휴대폰 브라우저는 이만큼 큰 그림을 그리지 못하거나 메모리가 모자라 멈출 수 있습니다. ${sw} × ${sh} 픽셀로 줄여서 열까요? (강의 연습에는 충분한 크기입니다)`)),
        buttons: [
          { label: '취소' },
          ...(ios ? [] : [{ label: '원래 크기로', action: () => { answer = 1; } }]),
          { label: '줄여서 열기', primary: true, action: () => { answer = k; } },
        ],
        onClose: () => resolve(answer),
      });
    });
  };
  if (isMobile() || coarse()) document.body.classList.add('ph-touch');
}

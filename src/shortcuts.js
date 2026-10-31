// Global keyboard shortcuts. Letter keys use KeyboardEvent.code so they keep working with a
// Korean (or any non-Latin) input method active.

import { store } from './store.js';
import { commands as c } from './commands.js';
import { modKey } from './util.js';
import { menusOpen } from './ui/common.js';

// Premiere's tool keys: V 선택, A 앞으로 트랙 선택 (Shift+A 뒤로), B 잔물결, N 롤링, R 속도 조정, C 자르기,
// Y 밀어넣기 (slip), U 밀기 (slide), P 펜, H 손, Z 확대/축소, T 문자
const TOOL_KEYS = {
  KeyV: 'select', KeyA: 'track', KeyB: 'ripple', KeyN: 'rolling', KeyR: 'rate', KeyC: 'razor', KeyY: 'slip', KeyU: 'slide', KeyP: 'pen', KeyH: 'hand', KeyZ: 'zoom', KeyT: 'type',
};

// K held down: J / L step one frame (Premiere's K+J / K+L)
let kHeld = false;

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (target.isContentEditable) return true;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'color'].includes(target.type);
  return false;
}

export function installShortcuts() {
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyK') kHeld = false;
  });
  window.addEventListener('blur', () => {
    kHeld = false;
  });
  window.addEventListener('keydown', (e) => {
    // the photo editor has its own shortcuts
    if (menusOpen() || document.body.classList.contains('photo-mode')) return;
    if (isTyping(e.target)) return;
    const mod = modKey(e);
    const { shiftKey: shift, altKey: alt } = e;
    const code = e.code;
    let run = null;

    switch (code) {
      case 'Space':
        run = mod && shift ? c.playInToOut : c.playStop;
        break;
      case 'KeyJ': if (!mod) run = kHeld ? c.stepBack : shift && c.shuttleSlowBack ? c.shuttleSlowBack : c.shuttleBack; break;
      case 'KeyK':
        if (mod) run = shift ? c.addEditAll : c.addEdit;
        else {
          kHeld = true;
          run = c.shuttleStop;
        }
        break;
      case 'KeyL':
        if (mod && shift) run = c.toggleLoop;
        else if (mod) run = c.linkToggle;
        else run = kHeld ? c.stepForward : shift && c.shuttleSlowForward ? c.shuttleSlowForward : c.shuttleForward;
        break;
      case 'ArrowLeft':
        run = alt ? c.nudgeLeft : shift ? c.stepBack5 : c.stepBack;
        break;
      case 'ArrowRight':
        run = alt ? c.nudgeRight : shift ? c.stepForward5 : c.stepForward;
        break;
      case 'ArrowUp': run = shift ? c.prevEditAll : c.prevEdit; break;
      case 'ArrowDown': run = shift ? c.nextEditAll : c.nextEdit; break;
      case 'Home': run = c.goStart; break;
      case 'End': run = c.goEnd; break;
      case 'KeyI':
        if (mod && shift) run = c.clearIn;
        else if (mod) run = c.importMedia;
        else run = shift ? c.goIn : c.markIn;
        break;
      case 'KeyO':
        if (mod && shift) run = c.clearOut;
        else if (mod) run = c.openProject;
        else run = shift ? c.goOut : c.markOut;
        break;
      case 'KeyX':
        if (mod && shift) run = c.clearInOut;
        else if (mod) run = c.cut;
        else run = c.markClip;
        break;
      case 'KeyM':
        if (mod && alt) run = shift ? c.clearMarkers : c.clearSelectedMarker;
        else if (mod && shift) run = c.prevMarker;
        else if (mod) run = c.exportMedia;
        else run = shift ? c.nextMarker : c.addMarker;
        break;
      case 'KeyG':
        if (mod) run = shift ? c.ungroup : c.group;
        else if (!shift && !alt) run = c.audioGain; // 오디오 게인
        break;
      case 'Comma': if (!mod) run = c.insert; break;
      case 'Period': if (!mod) run = c.overwrite; break;
      case 'Semicolon': run = c.lift; break;
      case 'Quote': run = c.extract; break;
      case 'KeyQ': if (!mod) run = c.rippleTrimPrev; break;
      case 'KeyW': if (!mod) run = c.rippleTrimNext; break;
      case 'Delete':
      case 'Backspace':
        run = shift || alt ? c.rippleDelete : c.clear;
        break;
      case 'KeyC': if (mod) run = c.copy; break;
      case 'KeyV':
        if (mod && alt) run = c.pasteAttributes;
        else if (mod) run = shift ? c.pasteInsert : c.paste;
        break;
      case 'KeyD':
        if (mod) run = shift ? c.applyAudioTransition : c.applyVideoTransition;
        else if (shift) run = c.applyDefaultTransitions;
        break;
      case 'KeyE':
        if (mod && shift) run = c.exportFrame;
        else if (shift) run = c.toggleEnable;
        else if (!mod && !alt) run = c.extendEdit;
        break;
      case 'KeyR': if (mod) run = c.speedDuration; break;
      case 'KeyA':
        if (mod) run = shift ? c.deselectAll : c.selectAll;
        else if (shift && !alt) run = () => store.setTool('trackBack');
        break;
      case 'KeyZ':
        if (mod) run = shift ? c.redo : c.undo;
        break;
      case 'KeyY': if (mod) run = c.redo; break;
      case 'KeyS':
        if (mod) run = c.saveProject;
        else run = c.toggleSnap;
        break;
      case 'KeyF': if (!mod) run = c.matchFrame; break;
      case 'Equal':
      case 'NumpadAdd':
        // Shift: expand all tracks · Ctrl: taller video tracks · Alt: taller audio tracks (Premiere)
        if (shift) run = () => c.trackHeights('all', 1);
        else if (mod) run = () => c.trackHeights('video', 1);
        else if (alt) run = () => c.trackHeights('audio', 1);
        else run = c.zoomIn;
        break;
      case 'Minus':
      case 'NumpadSubtract':
        if (shift) run = () => c.trackHeights('all', -1);
        else if (mod) run = () => c.trackHeights('video', -1);
        else if (alt) run = () => c.trackHeights('audio', -1);
        else run = c.zoomOut;
        break;
      case 'Backslash': run = c.zoomFit; break;
      case 'Backquote': run = c.maximizePanel; break;
      case 'F1': run = c.shortcuts; break;
      case 'Slash': run = shift ? c.shortcuts : c.markSelection; break;
      case 'Escape': run = c.deselectAll; break;
      default:
        // multicam angles: 1-9 (top row or keypad)
        if (!mod && !alt && !shift && /^(Digit|Numpad)[1-9]$/.test(code)) {
          const n = Number(code.slice(-1));
          run = () => c.switchAngle(n);
        }
        break;
    }
    if (!run && !mod && !alt && !shift && TOOL_KEYS[code]) run = () => store.setTool(TOOL_KEYS[code]);
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      run();
    } catch (err) {
      console.error(err);
      store.toast(String(err.message || err));
    }
  });
}

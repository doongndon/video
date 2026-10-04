// Global keyboard shortcuts. Letter keys use KeyboardEvent.code so they keep working with a
// Korean (or any non-Latin) input method active.

import { store } from './store.js';
import { commands as c } from './commands.js';
import { modKey } from './util.js';
import { menusOpen } from './ui/common.js';

const TOOL_KEYS = { KeyV: 'select', KeyA: 'track', KeyB: 'ripple', KeyN: 'rolling', KeyC: 'razor', KeyY: 'slip', KeyH: 'hand', KeyZ: 'zoom', KeyT: 'type' };

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (target.isContentEditable) return true;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'color'].includes(target.type);
  return false;
}

export function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (menusOpen()) return;
    if (isTyping(e.target)) return;
    const mod = modKey(e);
    const { shiftKey: shift, altKey: alt } = e;
    const code = e.code;
    let run = null;

    switch (code) {
      case 'Space':
        run = mod && shift ? c.playInToOut : c.playStop;
        break;
      case 'KeyJ': if (!mod) run = c.shuttleBack; break;
      case 'KeyK':
        if (mod) run = shift ? c.addEditAll : c.addEdit;
        else run = c.shuttleStop;
        break;
      case 'KeyL':
        if (mod && shift) run = c.toggleLoop;
        else if (mod) run = c.linkToggle;
        else run = c.shuttleForward;
        break;
      case 'ArrowLeft':
        run = alt ? c.nudgeLeft : shift ? c.stepBack5 : c.stepBack;
        break;
      case 'ArrowRight':
        run = alt ? c.nudgeRight : shift ? c.stepForward5 : c.stepForward;
        break;
      case 'ArrowUp': run = c.prevEdit; break;
      case 'ArrowDown': run = c.nextEdit; break;
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
        if (mod && shift) run = c.prevMarker;
        else if (mod) run = c.exportMedia;
        else run = shift ? c.nextMarker : c.addMarker;
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
        break;
      case 'KeyR': if (mod) run = c.speedDuration; break;
      case 'KeyA':
        if (mod) run = shift ? c.deselectAll : c.selectAll;
        break;
      case 'KeyZ':
        if (mod) run = shift ? c.redo : c.undo;
        break;
      case 'KeyY': if (mod) run = c.redo; break;
      case 'KeyT': if (mod) run = c.newText; break;
      case 'KeyS':
        if (mod) run = c.saveProject;
        else run = c.toggleSnap;
        break;
      case 'KeyF': if (!mod) run = c.matchFrame; break;
      case 'Equal':
      case 'NumpadAdd':
        run = c.zoomIn;
        break;
      case 'Minus':
      case 'NumpadSubtract':
        run = c.zoomOut;
        break;
      case 'Backslash': run = c.zoomFit; break;
      case 'Backquote': run = c.maximizePanel; break;
      case 'F1': run = c.shortcuts; break;
      case 'Slash': if (shift) run = c.shortcuts; break;
      case 'Escape': run = c.deselectAll; break;
      default: break;
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

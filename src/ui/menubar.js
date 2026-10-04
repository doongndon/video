// Application menu bar.

import { store } from '../store.js';
import { playback } from '../playback.js';
import { commands as c } from '../commands.js';
import { h, isMac } from '../util.js';
import { showMenu } from './common.js';

const mod = isMac ? '⌘' : 'Ctrl+';

export function createMenubar(el) {
  const sel = () => store.selectedClips();
  const menus = {
    File: () => [
      { label: 'New Project', action: c.newProject },
      { label: 'Open Project…', key: `${mod}O`, action: c.openProject },
      { label: 'Save Project As File', key: `${mod}S`, action: c.saveProject },
      { label: 'Rename Project…', action: c.renameProject },
      '-',
      { label: 'Import…', key: `${mod}I`, action: c.importMedia },
      { label: 'Import Captions (.srt)…', action: c.importCaptions },
      { label: 'Link Media…', action: c.linkMedia },
      '-',
      { label: 'Export Media…', key: `${mod}M`, action: c.exportMedia },
      { label: 'Export Frame (PNG)', key: `${mod}Shift+E`, action: c.exportFrame },
      { label: 'Export Captions (.srt)', action: c.exportCaptions },
    ],
    Edit: () => [
      { label: `Undo${store.undoStack.length ? ` ${store.undoStack[store.undoStack.length - 1].label}` : ''}`, key: `${mod}Z`, disabled: !store.undoStack.length, action: c.undo },
      { label: `Redo${store.redoStack.length ? ` ${store.redoStack[store.redoStack.length - 1].label}` : ''}`, key: `${mod}Shift+Z`, disabled: !store.redoStack.length, action: c.redo },
      '-',
      { label: 'Cut', key: `${mod}X`, disabled: !sel().length, action: c.cut },
      { label: 'Copy', key: `${mod}C`, disabled: !sel().length, action: c.copy },
      { label: 'Paste', key: `${mod}V`, disabled: !store.ui.clipboard, action: c.paste },
      { label: 'Paste Insert', key: `${mod}Shift+V`, disabled: !store.ui.clipboard, action: c.pasteInsert },
      { label: 'Paste Attributes', key: `${mod}Alt+V`, disabled: !store.ui.clipboard || !sel().length, action: c.pasteAttributes },
      { label: 'Clear', key: 'Del', action: c.clear },
      { label: 'Ripple Delete', key: 'Shift+Del', action: c.rippleDelete },
      '-',
      { label: 'Select All', key: `${mod}A`, action: c.selectAll },
      { label: 'Deselect All', key: `${mod}Shift+A`, action: c.deselectAll },
      '-',
      { label: 'Keyboard Shortcuts', key: 'F1', action: c.shortcuts },
    ],
    Clip: () => [
      { label: 'Speed/Duration…', key: `${mod}R`, disabled: !sel().length, action: c.speedDuration },
      { label: 'Reverse Speed', disabled: !sel().length, action: c.reverse },
      { label: 'Add Frame Hold', disabled: !sel().some((x) => x.kind === 'video'), action: c.frameHold },
      { label: 'Scene Edit Detection…', disabled: !sel().some((x) => x.kind === 'video'), action: c.sceneDetect },
      { label: 'Normalize Audio (-1 dB peak)', disabled: !sel().length, action: c.normalize },
      '-',
      { label: 'Insert (from Source)', key: ',', action: c.insert },
      { label: 'Overwrite (from Source)', key: '.', action: c.overwrite },
      '-',
      { label: 'Enable', key: 'Shift+E', checked: sel().length && sel()[0].enabled !== false, disabled: !sel().length, action: c.toggleEnable },
      { label: 'Link / Unlink', key: `${mod}L`, disabled: !sel().length, action: c.linkToggle },
      { label: 'Nest…', disabled: !sel().length, action: c.nest },
      { label: 'Remove Effects', disabled: !sel().length, action: c.removeEffects },
      '-',
      { label: 'Nudge Left 1 Frame', key: 'Alt+←', action: c.nudgeLeft },
      { label: 'Nudge Right 1 Frame', key: 'Alt+→', action: c.nudgeRight },
    ],
    Sequence: () => [
      { label: 'New Sequence', action: c.newSequence },
      { label: 'Duplicate Sequence', action: c.duplicateSequence },
      { label: 'Delete Sequence', action: c.deleteSequence },
      { label: 'Sequence Settings…', action: c.sequenceSettings },
      '-',
      { label: 'Match Frame', key: 'F', action: c.matchFrame },
      { label: 'Add Edit', key: `${mod}K`, action: c.addEdit },
      { label: 'Add Edit to All Tracks', key: `${mod}Shift+K`, action: c.addEditAll },
      { label: 'Ripple Trim Previous Edit to Playhead', key: 'Q', action: c.rippleTrimPrev },
      { label: 'Ripple Trim Next Edit to Playhead', key: 'W', action: c.rippleTrimNext },
      '-',
      { label: 'Apply Video Transition', key: `${mod}D`, action: c.applyVideoTransition },
      { label: 'Apply Audio Transition', key: `${mod}Shift+D`, action: c.applyAudioTransition },
      { label: 'Apply Default Transitions to Selection', key: 'Shift+D', action: c.applyDefaultTransitions },
      '-',
      { label: 'Lift', key: ';', action: c.lift },
      { label: 'Extract', key: "'", action: c.extract },
      { label: 'Close All Gaps', action: c.closeGaps },
      '-',
      { label: 'Snap in Timeline', key: 'S', checked: store.ui.snapping, action: c.toggleSnap },
      { label: 'Linked Selection', checked: store.ui.linkedSelection, action: c.toggleLinked },
      '-',
      { label: 'Add Video Track', action: c.addVideoTrack },
      { label: 'Add Audio Track', action: c.addAudioTrack },
      '-',
      { label: 'Zoom In', key: '=', action: c.zoomIn },
      { label: 'Zoom Out', key: '-', action: c.zoomOut },
      { label: 'Zoom to Sequence', key: '\\', action: c.zoomFit },
    ],
    Markers: () => [
      { label: 'Mark In', key: 'I', action: c.markIn },
      { label: 'Mark Out', key: 'O', action: c.markOut },
      { label: 'Mark Clip', key: 'X', action: c.markClip },
      '-',
      { label: 'Go to In', key: 'Shift+I', action: c.goIn },
      { label: 'Go to Out', key: 'Shift+O', action: c.goOut },
      '-',
      { label: 'Clear In', key: `${mod}Shift+I`, action: c.clearIn },
      { label: 'Clear Out', key: `${mod}Shift+O`, action: c.clearOut },
      { label: 'Clear In and Out', key: `${mod}Shift+X`, action: c.clearInOut },
      '-',
      { label: 'Add Marker', key: 'M', action: c.addMarker },
      { label: 'Go to Next Marker', key: 'Shift+M', action: c.nextMarker },
      { label: 'Go to Previous Marker', key: `${mod}Shift+M`, action: c.prevMarker },
      { label: 'Edit Marker…', action: c.editMarker },
      { label: 'Clear All Markers', action: c.clearMarkers },
    ],
    Graphics: () => [
      { label: 'New Text Layer', action: c.newText },
      { label: 'Type Tool', key: 'T', action: () => store.setTool('type') },
      { label: 'New Rectangle', action: c.newRectangle },
      { label: 'New Ellipse', action: c.newEllipse },
      { label: 'New Triangle', action: c.newTriangle },
      { label: 'New Line', action: c.newLine },
      '-',
      { label: 'New Color Matte…', action: c.newColorMatte },
      { label: 'New Black Video', action: c.newBlack },
      { label: 'New Adjustment Layer', action: c.newAdjustment },
      '-',
      { label: 'Import Captions (.srt)…', action: c.importCaptions },
      { label: 'Export Captions (.srt)', action: c.exportCaptions },
    ],
    View: () => [
      { label: 'Play / Stop', key: 'Space', action: c.playStop },
      { label: 'Play In to Out', key: `${mod}Shift+Space`, action: c.playInToOut },
      { label: 'Loop Playback', checked: playback.loop, action: c.toggleLoop },
      '-',
      { label: 'Maximize Panel', key: '`', action: c.maximizePanel },
    ],
    Window: () => [
      { label: 'Source Monitor', action: () => c.showPanel('source') },
      { label: 'Effect Controls', action: () => c.showPanel('effectControls') },
      { label: 'Audio Track Mixer', action: () => c.showPanel('mixer') },
      { label: 'Scopes', action: () => c.showPanel('scopes') },
      { label: 'Program Monitor', action: () => c.showPanel('program') },
      { label: 'Project', action: () => c.showPanel('project') },
      { label: 'Effects', action: () => c.showPanel('effects') },
      { label: 'Markers', action: () => c.showPanel('markers') },
      { label: 'History', action: () => c.showPanel('history') },
      { label: 'Timeline', action: () => c.showPanel('timeline') },
      '-',
      { label: 'Reset Layout', action: c.resetLayout },
    ],
    Help: () => [
      { label: 'Keyboard Shortcuts', key: 'F1', action: c.shortcuts },
      { label: 'Load Sample Project', action: c.loadSample },
      { label: 'About Montage', action: c.about },
    ],
  };

  el.append(h('span.brand', 'Montage'));
  const buttons = [];
  for (const [name, items] of Object.entries(menus)) {
    const b = h('button.menu-btn', name);
    const open = () => {
      const r = b.getBoundingClientRect();
      showMenu(items, r.left, r.bottom + 1);
      buttons.forEach((x) => x.classList.remove('open'));
      b.classList.add('open');
    };
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.classList.contains('open')) {
        document.querySelectorAll('.menu').forEach((m) => m.remove());
        b.classList.remove('open');
      } else open();
    });
    b.addEventListener('pointerenter', () => {
      if (buttons.some((x) => x.classList.contains('open') && x !== b) && document.querySelector('.menu')) open();
    });
    buttons.push(b);
    el.append(b);
  }
  const name = h('span.project-name');
  const saved = h('span', { style: { color: 'var(--text-faint)', fontSize: '11px' } });
  el.append(h('span.spacer'), name, saved, h('button.primary', { onclick: c.exportMedia, style: { marginLeft: '8px' } }, 'Export'));
  const refresh = () => { name.textContent = store.project.name; };
  store.on('change', refresh);
  store.on('saved', (d) => { saved.textContent = `Autosaved ${d.toLocaleTimeString()}`; });
  refresh();
}

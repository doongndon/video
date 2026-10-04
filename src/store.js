// Application state: the serialisable project, UI state, selection and snapshot-based undo.
// Rule for consumers: never hold on to clip/track objects across 'change' events — undo replaces
// the whole project tree, so always look things up by id.

import { Emitter } from './util.js';
import { createProject, migrateProject, deriveSequenceMedia } from './model.js';

const MAX_UNDO = 200;

class Store extends Emitter {
  constructor() {
    super();
    this.project = createProject();
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.selection = { clips: new Set(), transition: null, gap: null };
    this.ui = {
      playhead: 0,
      tool: 'select',
      snapping: true,
      linkedSelection: true,
      focusPanel: 'timeline',
      sourceMediaId: null,
      clipboard: null,
      selectedMedia: new Set(),
    };
  }

  get seq() {
    return this.project.sequences[this.project.activeSequenceId];
  }

  snapshot() {
    return JSON.stringify(this.project);
  }

  /** Run fn as one undoable step. Nested calls merge into the outer step. */
  transact(label, fn) {
    if (this.pending) {
      const r = fn();
      this.changed();
      return r;
    }
    const before = this.snapshot();
    let result;
    try {
      result = fn();
    } catch (err) {
      this.project = JSON.parse(before);
      this.changed('restore');
      throw err;
    }
    this.pushUndo(label, before);
    this.changed();
    return result;
  }

  /** Begin a long-running edit (drags). Mutate in place, call changed(), then commit(). */
  begin(label) {
    if (this.pending) return;
    this.pending = { label, before: this.snapshot() };
  }

  commit() {
    if (!this.pending) return;
    const { label, before } = this.pending;
    this.pending = null;
    this.pushUndo(label, before);
    this.changed();
  }

  cancel() {
    if (!this.pending) return;
    this.project = JSON.parse(this.pending.before);
    this.pending = null;
    this.pruneSelection();
    this.changed('restore');
  }

  pushUndo(label, before) {
    if (this.snapshot() === before) return;
    this.undoStack.push({ label, snapshot: before });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  }

  undo() {
    if (this.pending) this.commit();
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ label: entry.label, snapshot: this.snapshot() });
    this.project = JSON.parse(entry.snapshot);
    this.pruneSelection();
    this.changed('restore');
    this.emit('history');
    this.emit('toast', `Undo: ${entry.label}`);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ label: entry.label, snapshot: this.snapshot() });
    this.project = JSON.parse(entry.snapshot);
    this.pruneSelection();
    this.changed('restore');
    this.emit('history');
    this.emit('toast', `Redo: ${entry.label}`);
  }

  /** Replace the whole project (open / new). Clears history. */
  loadProject(project) {
    this.project = migrateProject(project);
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.selection = { clips: new Set(), transition: null, gap: null };
    this.ui.selectedMedia = new Set();
    this.ui.sourceMediaId = null;
    this.ui.playhead = 0;
    this.changed('load');
    this.emit('history');
    this.emit('selection');
    this.emit('playhead');
  }

  changed(reason) {
    deriveSequenceMedia(this.project);
    this.emit('change', reason);
  }

  /** Switch the sequence shown in the Timeline / Program monitor (not an undoable edit). */
  openSequence(id) {
    if (!this.project.sequences[id] || this.project.activeSequenceId === id) return;
    this.project.activeSequenceId = id;
    this.selection = { clips: new Set(), transition: null, gap: null };
    this.ui.playhead = 0;
    this.changed('sequence');
    this.emit('selection');
    this.emit('playhead');
    this.emit('sequence');
  }

  pruneSelection() {
    const clips = this.seq.clips;
    for (const id of [...this.selection.clips]) if (!clips[id]) this.selection.clips.delete(id);
    if (this.selection.transition && !clips[this.selection.transition.clipId]) this.selection.transition = null;
    this.emit('selection');
  }

  // ---- selection helpers
  selectClips(ids, { add = false } = {}) {
    if (!add) this.selection.clips.clear();
    for (const id of ids) this.selection.clips.add(id);
    this.selection.transition = null;
    this.selection.gap = null;
    this.emit('selection');
  }

  toggleClips(ids) {
    const allSelected = ids.every((id) => this.selection.clips.has(id));
    for (const id of ids) {
      if (allSelected) this.selection.clips.delete(id);
      else this.selection.clips.add(id);
    }
    this.selection.transition = null;
    this.selection.gap = null;
    this.emit('selection');
  }

  selectTransition(clipId, edge) {
    this.selection.clips.clear();
    this.selection.gap = null;
    this.selection.transition = { clipId, edge };
    this.emit('selection');
  }

  selectGap(gap) {
    this.selection.clips.clear();
    this.selection.transition = null;
    this.selection.gap = gap;
    this.emit('selection');
  }

  clearSelection() {
    if (!this.selection.clips.size && !this.selection.transition && !this.selection.gap) return;
    this.selection.clips.clear();
    this.selection.transition = null;
    this.selection.gap = null;
    this.emit('selection');
  }

  selectedClips() {
    return [...this.selection.clips].map((id) => this.seq.clips[id]).filter(Boolean);
  }

  setPlayhead(t) {
    const v = Math.max(0, t);
    if (v === this.ui.playhead) return;
    this.ui.playhead = v;
    this.emit('playhead');
  }

  setTool(tool) {
    this.ui.tool = tool;
    this.emit('tool');
  }

  setFocus(panel) {
    if (this.ui.focusPanel === panel) return;
    this.ui.focusPanel = panel;
    this.emit('focus');
  }

  toast(msg) {
    this.emit('toast', msg);
  }
}

export const store = new Store();

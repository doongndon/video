// Undo / redo for a photo document. Each entry holds a snapshot from doc.capture(): layer metadata
// plus references to pixel canvases (which are never modified after capture, see doc.editPixels).

import { unionRect } from './doc.js';

export class History {
  constructor(doc, { budgetBytes = 900e6, states = 50 } = {}) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.budgetBytes = budgetBytes;
    // Preferences ▸ History States (Photoshop's default is 50)
    this.states = states;
    // counts every recorded step, also once the oldest ones start dropping off (actions use it)
    this.serial = 0;
    this.listeners = new Set();
  }

  get max() {
    // at most `states` steps, and about one full-size layer copy per step within the memory budget
    const byMemory = Math.max(8, Math.floor(this.budgetBytes / Math.max(1, this.doc.layerBytes)));
    return Math.max(1, Math.min(Math.round(this.states) || 50, byMemory, 1000));
  }

  /**
   * Record an edit: `before` is doc.capture() taken before changing anything; `known`, when given,
   * is where it changed the picture (null: unknown).
   */
  push(label, before, known = undefined) {
    // where the step changed the picture (when known): undoing it redraws that part alone
    const doc = this.doc;
    const ours = before.revOf === doc.id;
    const area = known !== undefined ? known : ours ? doc.changedSince(before.rev) : null;
    // the step before is undone from the state this one started from: add what changed in between
    const prev = this.undoStack[this.undoStack.length - 1];
    if (prev) widen(prev, ours && prev.rev != null && before.rev >= prev.rev ? doc.changedSince(prev.rev, before.rev) : null);
    this.undoStack.push({ label, state: before, area, rev: doc.rev });
    this.trim();
    this.redoStack = [];
    this.serial++;
    this.emit();
  }

  /** Drop the oldest steps beyond the limit (after the limit changed too). */
  trim() {
    while (this.undoStack.length > this.max) this.undoStack.shift();
  }

  /** Run fn as one undoable step. */
  run(label, fn) {
    const before = this.doc.capture();
    const r = fn();
    this.push(label, before);
    return r;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    // a spot heal still being filled in is given up along with its step: there is nothing to redo
    const dropped = this.doc.settle('undo', e);
    this.swap(e, this.undoStack, dropped ? null : this.redoStack);
    this.emit();
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.swap(e, this.redoStack, this.undoStack);
    this.emit();
    return e.label;
  }

  /**
   * Go to entry e's state (taken off `from`) and put the way back on `to`. Each entry knows where
   * its state differs from the one next to it (area) as of revision `rev`, so only that part of the
   * picture is redrawn; whatever changed since without a step of its own is added.
   */
  swap(e, from, to) {
    const doc = this.doc;
    const since = e.area && e.rev != null ? doc.changedSince(e.rev) : null;
    const area = since && unionRect(e.area, since);
    // the entry the way back goes on top of is next to the state now
    const next = to?.[to.length - 1];
    if (next) widen(next, next.rev != null ? doc.changedSince(next.rev) : null);
    const back = { label: e.label, state: doc.capture(), area };
    doc.restore(e.state, area);
    back.rev = doc.rev;
    to?.push(back);
    // the step now on top of `from` was next to the state just restored
    const top = from[from.length - 1];
    if (top) top.rev = doc.rev;
    return back;
  }

  /**
   * Edit ▸ Toggle Last State (Ctrl+Alt+Z): undo the last step, or redo it when the last thing done
   * was that undo. Returns the step's label, or null.
   */
  toggleLast() {
    if (this.lastToggle === 'undo' && this.redoStack.length && this.togglePos === this.undoStack.length) {
      const l = this.redo();
      this.lastToggle = 'redo';
      this.togglePos = this.undoStack.length;
      return l;
    }
    const l = this.undo();
    this.lastToggle = l ? 'undo' : null;
    this.togglePos = this.undoStack.length;
    return l;
  }

  /** Go back to the state right after undo entry `index` (the history panel). */
  jumpTo(index) {
    while (this.undoStack.length - 1 > index) this.undo();
    while (this.undoStack.length - 1 < index && this.redoStack.length) this.redo();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Grow an entry's area by `extra` (null: no longer known); it then counts from the state after it. */
function widen(e, extra) {
  e.area = e.area && extra ? unionRect(e.area, extra) : null;
  e.rev = null;
}

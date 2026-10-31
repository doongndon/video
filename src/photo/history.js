// Undo / redo for a photo document. Each entry holds a snapshot from doc.capture(): layer metadata
// plus references to pixel canvases (which are never modified after capture, see doc.editPixels).

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

  /** Record an edit: `before` is doc.capture() taken before changing anything. */
  push(label, before) {
    this.undoStack.push({ label, state: before });
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
    this.redoStack.push({ label: e.label, state: this.doc.capture() });
    this.doc.restore(e.state);
    this.emit();
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, state: this.doc.capture() });
    this.doc.restore(e.state);
    this.emit();
    return e.label;
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

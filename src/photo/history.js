// Undo / redo for a photo document. Each entry holds a snapshot from doc.capture(): layer metadata
// plus references to pixel canvases (which are never modified after capture, see doc.editPixels).

export class History {
  constructor(doc, { budgetBytes = 900e6 } = {}) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.budgetBytes = budgetBytes;
    this.listeners = new Set();
  }

  get max() {
    // one full-size layer copy per step at most, kept within the memory budget
    return Math.max(8, Math.min(80, Math.floor(this.budgetBytes / Math.max(1, this.doc.layerBytes))));
  }

  /** Record an edit: `before` is doc.capture() taken before changing anything. */
  push(label, before) {
    this.undoStack.push({ label, state: before });
    while (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
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

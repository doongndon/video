// Photoshop's type features on top of the type engine (type.js): rich text editing (select characters
// on the canvas or with Shift+arrows, double-click a word, then give them their own font, size,
// colour and style), type on a path and area type made with the type tools, a path text's start / end
// markers and flipping, the Type (문자) menu, character and paragraph styles, and the keyboard
// shortcuts Photoshop has while editing text.

import { toast, promptDialog } from '../ui/common.js';
import { newLayer, makeCanvas } from './doc.js';
import { TOOL_BY_ID } from './tools.js';
import * as TY from './type.js';
import * as PT from './paths.js';

const TYPE_TOOLS = ['text', 'verticalText', 'textMask', 'verticalTextMask'];
/** Run keys that map one to one onto the layer's own settings. */
const SAME_KEYS = new Set(['font', 'bold', 'italic', 'color', 'hScale', 'vScale', 'baseline', 'fauxBold', 'fauxItalic', 'caps', 'script', 'underline', 'strike', 'cs']);
const PARA_SET = new Set(['align', 'indent', 'spaceBefore', 'spaceAfter', 'ps']);
const LAYER_SET = new Set(['leading', 'lineHeight', 'aa']);
export const CHAR_PROPS = ['font', 'bold', 'italic', 'size', 'color', 'tracking', 'kerning', 'hScale', 'vScale', 'baseline', 'fauxBold', 'fauxItalic', 'caps', 'script', 'underline', 'strike'];

export const LOREM = {
  ko: '이곳에 글을 입력하세요. 자리 표시자 텍스트는 실제 내용이 정해지기 전에 글꼴과 크기, 줄 간격과 배치를 미리 확인하려고 넣는 임시 문장입니다. 문단의 길이와 줄바꿈이 어떻게 보이는지 살펴본 뒤 원하는 내용으로 바꾸어 쓰면 됩니다. 제목과 본문의 균형, 여백과 정렬도 함께 확인해 보세요.',
  la: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
};

const commonPrefix = (a, b) => {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p;
};
const rectOf = (d) => ({ x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) });

/** Arc-length position (0..1) of the point of a subpath nearest (x, y), and the distance. */
export function fracOnPath(sp, x, y) {
  const pts = PT.flatten(sp, 1);
  let total = 0;
  let best = { d: Infinity, at: 0, q: pts[0] || [x, y], ang: 0 };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay);
    const k = L ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (L * L))) : 0;
    const qx = ax + (bx - ax) * k;
    const qy = ay + (by - ay) * k;
    const d = Math.hypot(x - qx, y - qy);
    if (d < best.d) best = { d, at: total + L * k, q: [qx, qy], ang: Math.atan2(by - ay, bx - ax) };
    total += L;
  }
  return { ...best, frac: total ? best.at / total : 0, total };
}

/** A point at arc-length fraction f of a subpath (with the tangent angle). */
function pointAtFrac(sp, f) {
  const pts = PT.flatten(sp, 1);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let want = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= L || i === pts.length - 1) {
      const k = L ? Math.min(1, want / L) : 0;
      return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k, ang: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
    }
    want -= L;
  }
  return { x: pts[0]?.[0] || 0, y: pts[0]?.[1] || 0, ang: 0 };
}

export function installType2(P) {
  const C = P.cmd;
  const isMobile = () => document.body.classList.contains('mobile');
  let session = null; // { layer, el, prev, insert: { at, patch } }
  let pending = null;
  const clicks = { t: 0, n: 0, x: 0, y: 0, layer: null };

  // fonts used by runs arrive later: draw the layer again
  TY.onTextFontReady((layer) => {
    for (const d of P.docs || []) {
      if (d.layer(layer.id) === layer) {
        layer._text = null;
        d.touch(layer);
      }
    }
    P.redraw();
  });

  const geom = (l) => TY.textLayout(l);
  const local = (l, p) => {
    const L = geom(l);
    return TY.toLocal(l, L.w, L.h, p.x, p.y);
  };
  const docPt = (l, x, y) => {
    const L = geom(l);
    return TY.toDoc(l, L.w, L.h, x, y);
  };
  /** Is p on this text (glyphs of path text, the box of other text)? */
  const textHit = (l, p, slack = 0) => {
    const L = geom(l);
    const [x, y] = TY.toLocal(l, L.w, L.h, p.x, p.y);
    if (L.path) {
      for (const g of L.glyphs) if (!g.hidden && !g.nl && Math.hypot(g.x - x, g.y - y) < g.st.size * 0.75 + slack) return true;
      return false;
    }
    if (l.text.area) {
      const g = hitCtx();
      return TY.areaPaths(l.text).some((sp) => sp.closed !== false && g.isPointInPath(PT.toPath2D([{ ...sp, closed: true }]), x, y));
    }
    return x >= -slack && y >= -slack && x <= L.w + slack && y <= L.h + slack;
  };
  const hitCtx = () => (hitCtx.g ||= makeCanvas(1, 1).getContext('2d'));

  // Point text stays on the point it was clicked at: it grows to the right, both ways or to the left by
  // its alignment, and a size change keeps the first baseline (Photoshop's anchor point).
  const ALIGN_K = { center: 0.5, justifyCenter: 0.5, right: 1, justifyRight: 1 };
  const anchorPt = (l) => {
    const t = l?.text;
    if (!t || t.box || t.path || t.area || t.vertical) return null;
    const L = geom(l);
    return TY.toDoc(l, L.w, L.h, L.w * (ALIGN_K[TY.paraStyle(t, 0).align] || 0), L.lines?.[0]?.base ?? 0);
  };
  const keepAnchor = (l, a0) => {
    const a1 = a0 && anchorPt(l);
    if (!a1) return;
    l.x = Math.round((l.x + a0[0] - a1[0]) * 100) / 100;
    l.y = Math.round((l.y + a0[1] - a1[1]) * 100) / 100;
  };
  P.textAnchor = anchorPt;
  P.keepTextAnchor = keepAnchor;

  // ---------------------------------------------------------------- older type on a path

  /** Type on a path from before the box existed: give it one (the path relative to the box). */
  const migrate = (l) => {
    const t = l.text;
    if (!t?.path?.subpath || t.path.w0) return;
    const sp = PT.translatePath([t.path.subpath], l.x, l.y)[0];
    const b = PT.pathBounds([sp]) || { x: l.x, y: l.y, w: 1, h: 1 };
    const pad = Math.ceil((t.size || 72) * 1.3);
    l.x = Math.floor(b.x - pad);
    l.y = Math.floor(b.y - pad);
    const w0 = Math.ceil(b.w + pad * 2);
    const h0 = Math.ceil(b.h + pad * 2);
    l.text = { ...t, box: { w: w0, h: h0 }, path: { subpath: PT.translatePath([sp], -l.x, -l.y)[0], start: t.path.offset || 0, end: 1, flip: false, w0, h0 } };
    l.rotation = 0;
    P.doc?.touch(l);
  };

  // ---------------------------------------------------------------- the editing session

  const curSel = () => {
    const el = session?.el;
    if (!el || !P.editingText) return null;
    return { a: el.selectionStart, b: el.selectionEnd, back: el.selectionDirection === 'backward' };
  };
  P.textSelection = curSel;
  let caretFrame = 0;
  const onCaret = () => {
    const s = session;
    if (!s) return;
    if (s.insert && (s.el.selectionStart !== s.insert.at || s.el.selectionEnd !== s.insert.at)) s.insert = null;
    if (!caretFrame) {
      caretFrame = requestAnimationFrame(() => {
        caretFrame = 0;
        syncOpts();
        P.emit('typesel');
      });
    }
    P.overlay();
  };
  const onInput = () => {
    const s = session;
    const ed = P.editingText;
    if (!s || !ed || ed.layer !== s.layer) return;
    const l = s.layer;
    const next = s.el.value;
    let ins = null;
    if (s.insert) {
      if (commonPrefix(s.prev, next) === s.insert.at && next.length > s.prev.length) ins = s.insert.patch;
      s.insert = null;
    }
    const t2 = TY.syncEdit(l.text, s.prev, next, ins);
    s.prev = next;
    // the anchor of the text as it was before this input (taken before the edit box changed the layer)
    const a0 = s.a0;
    s.a0 = null;
    const x0 = l.x;
    const y0 = l.y;
    const synced = t2 !== l.text;
    const r0 = synced || a0 ? P.doc.movedArea?.(l) : null;
    l.text = t2;
    keepAnchor(l, a0);
    if (synced || l.x !== x0 || l.y !== y0) {
      const r1 = P.doc.movedArea?.(l);
      const r = r0 && r1 && r0.w > 0 && r1.w > 0 ? { x: Math.min(r0.x, r1.x), y: Math.min(r0.y, r1.y), w: Math.max(r0.x + r0.w, r1.x + r1.w) - Math.min(r0.x, r1.x), h: Math.max(r0.y + r0.h, r1.y + r1.h) - Math.min(r0.y, r1.y) } : r1;
      P.doc.touch(l, r && r.w > 0 ? r : null);
    }
    P.redraw();
  };
  /** Give the edit box the keyboard again (a press on the canvas takes it away after the tool ran). */
  const refocus = () => {
    const el = session?.el;
    if (!el || !P.editingText || isMobile()) return;
    el.focus({ preventScroll: true });
    setTimeout(() => {
      if (session?.el === el && P.editingText && document.activeElement !== el) el.focus({ preventScroll: true });
    }, 0);
  };
  const setSel = (a, b, back = false) => {
    const el = session?.el;
    if (!el) return;
    el.setSelectionRange(Math.min(a, b), Math.max(a, b), back ? 'backward' : 'forward');
    refocus();
    onCaret();
  };

  const origEdit = P.editText;
  P.editText = (l, before) => {
    if (l?.text?.path && !l.text.path.w0) migrate(l);
    origEdit(l, before);
    const el = document.querySelector('.ph-textedit textarea');
    if (!el || !P.editingText) {
      session = null;
      return;
    }
    session = { layer: l, el, prev: String(l.text.content ?? ''), insert: null, a0: null };
    // capture runs before the edit box's own listener puts the new content in the layer
    el.parentElement?.addEventListener('input', () => {
      if (session?.el === el) session.a0 = anchorPt(l);
    }, true);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    for (const ev of ['keyup', 'mouseup', 'select', 'focus']) el.addEventListener(ev, onCaret);
    // the edit box gets a hint about selecting on the canvas
    const note = el.parentElement?.querySelector('.note');
    if (note) note.textContent = 'Ctrl+Enter 또는 Esc로 마칩니다. 캔버스나 이 칸에서 글자를 골라(끌기, Shift+화살표, 두 번 누르기) 문자 패널에서 고르게 된 글자만 바꿀 수 있습니다.';
    syncOpts();
    P.emit('typesel');
    refocus();
  };
  /** A double-click on text (layer thumbnail, move tool): the type tool edits it, all of it selected. */
  P.editTextLayer = (l) => {
    if (l?.kind !== 'text' || l.locked) return;
    P.selectLayer(l.id);
    const t = l.text.vertical ? 'verticalText' : 'text';
    if (P.tool !== t) P.setTool(t);
    P.editText(l);
    document.querySelector('.ph-textedit textarea')?.select();
  };
  P.on('history', () => {
    if (!P.editingText) session = null;
  });

  // ---------------------------------------------------------------- applying settings

  /** The settings shown in the Character / Paragraph panels: the selected characters, else the layer. */
  P.typeState = () => {
    const d = P.doc;
    const ed = P.editingText;
    const l = ed?.layer || (d?.active?.kind === 'text' ? d.active : null);
    if (!l) {
      const o = P.opts('text');
      return { layer: null, editing: false, hasSel: false, char: { font: o.font, size: o.size, bold: !!o.bold, italic: !!o.italic, color: P.fg, tracking: 0, kerning: 'metrics', hScale: 100, vScale: 100, baseline: 0, fauxBold: false, fauxItalic: false, caps: 'none', script: 'none', underline: false, strike: false }, para: { align: o.align || 'left', indent: { left: 0, right: 0, first: 0 }, spaceBefore: 0, spaceAfter: 0 }, leading: 0, aa: o.aa || 'sharp' };
    }
    const t = l.text;
    const sel = ed && session ? curSel() : null;
    const n = String(t.content ?? '').length;
    const idx = sel ? (sel.a === sel.b ? Math.max(0, sel.a - 1) : sel.a) : 0;
    const st = n ? TY.charStyleAt(t, idx) : TY.baseChar(t);
    const ch = {
      font: st.font, size: Math.round(t.size * (st.sizeK || 1) * 100) / 100, bold: !!st.bold, italic: !!st.italic, color: st.color,
      tracking: Math.round(st.tracking ?? TY.baseTracking(t)), kerning: st.kern ? st.kern : st.kerning || 'metrics', hScale: st.hScale ?? 100, vScale: st.vScale ?? 100,
      baseline: st.baseline || 0, fauxBold: !!st.fauxBold, fauxItalic: !!st.fauxItalic, caps: st.caps || 'none', script: st.script || 'none', underline: !!st.underline, strike: !!st.strike, cs: st.cs || null,
    };
    if (sel && session.insert && sel.a === session.insert.at) Object.assign(ch, toDisplay(t, session.insert.patch));
    const pi = sel ? TY.paraIndexAt(t.content, sel.a) : 0;
    const para = { ...TY.paraStyle(t, pi), ps: t.paras?.[pi]?.ps ?? t.ps ?? null };
    return { layer: l, editing: !!ed, hasSel: !!sel && sel.a !== sel.b, char: ch, para, leading: t.leading || 0, aa: t.aa || 'sharp', kind: t.path ? 'path' : t.area ? 'area' : t.box ? 'box' : 'point', vertical: !!t.vertical };
  };
  const toDisplay = (t, patch) => {
    const o = { ...patch };
    if (o.sizeK != null) {
      o.size = Math.round(t.size * o.sizeK * 100) / 100;
      delete o.sizeK;
    }
    if (o.kern) o.kerning = o.kern;
    delete o.kern;
    return o;
  };

  /** Display values → run overrides (sizes relative to the layer, kerning split into mode / manual). */
  const runPatch = (t, patch) => {
    const o = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'size') o.sizeK = v / t.size;
      else if (k === 'tracking') o.tracking = v;
      else if (k === 'kerning') {
        if (typeof v === 'number') o.kern = v;
        else {
          o.kerning = v;
          o.kern = 0;
        }
      } else if (SAME_KEYS.has(k)) o[k] = v;
    }
    return o;
  };

  /** The whole layer: its own settings change and the runs stop overriding them. */
  const applyWhole = (t, patch) => {
    let out = { ...t };
    const clear = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'size') {
        const k2 = v / Math.max(0.01, out.size);
        out.size = v;
        out.letterSpacing = (out.letterSpacing || 0) * k2;
        if (out.leading > 0) out.leading = Math.round(out.leading * k2 * 100) / 100;
        clear.push('sizeK');
      } else if (k === 'tracking') {
        out.letterSpacing = (v / 1000) * out.size;
        clear.push('tracking');
      } else if (k === 'kerning') {
        if (typeof v === 'number') out = TY.withCharRange(out, 0, String(out.content ?? '').length, { kern: v });
        else {
          out.kerning = v;
          clear.push('kerning', 'kern');
        }
      } else if (SAME_KEYS.has(k)) {
        out[k] = v;
        clear.push(k);
      } else if (LAYER_SET.has(k)) out[k] = v;
      else if (PARA_SET.has(k)) {
        out[k] = k === 'indent' ? { left: 0, right: 0, first: 0, ...(out.indent || {}), ...v } : v;
        if (out.paras) {
          out.paras = out.paras.map((o) => {
            if (!o) return o;
            const c = { ...o };
            delete c[k];
            return Object.keys(c).length ? c : null;
          });
          if (!out.paras.some(Boolean)) out.paras = null;
        }
      }
    }
    if (clear.length) out = TY.clearRunKeys(out, clear);
    return out;
  };

  /** Characters a..b (and the paragraphs they touch). */
  const applyRange = (t, patch, a, b) => {
    let out = t;
    const rp = runPatch(t, patch);
    if (Object.keys(rp).length) out = TY.withCharRange(out, a, b, rp);
    const pp = {};
    for (const [k, v] of Object.entries(patch)) {
      if (PARA_SET.has(k)) pp[k] = v;
      else if (LAYER_SET.has(k)) out = { ...out, [k]: v };
    }
    if (Object.keys(pp).length) out = TY.withParaRange(out, TY.paraIndexAt(t.content, a), TY.paraIndexAt(t.content, Math.max(a, b - 1)), pp);
    return out;
  };

  /**
   * Change type settings like Photoshop's Character / Paragraph panels: while editing, the selected
   * characters (paragraph settings: their paragraphs; with only a caret, the next characters typed);
   * otherwise every selected text layer. With no text layer, the defaults for new text.
   * opts.paragraphs widens a selection to whole paragraphs (paragraph styles).
   */
  P.typeApply = (patch, label = '문자', { live = false, refocus = false, paragraphs = false } = {}) => {
    const d = P.doc;
    if (!d) return;
    const ed = P.editingText;
    const layers = ed ? [ed.layer] : d.selectedLayers.filter((l) => l.kind === 'text');
    if (!layers.length) {
      const o = P.opts('text');
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'color') P.setColor(v);
        else if (k in o || k === 'aa') {
          o[k] = v;
          origSetOpt('text', k, v);
        }
      }
      P.emit('typesel');
      return;
    }
    if (!pending && !ed) pending = d.capture();
    let changed = false;
    for (const l of layers) {
      const t = l.text;
      const n = String(t.content ?? '').length;
      let t2 = t;
      const sel = ed ? curSel() : null;
      if (sel && n) {
        let { a, b } = sel;
        if (paragraphs) {
          const ps = TY.paragraphs(t.content);
          a = ps[TY.paraIndexAt(t.content, a)].start;
          b = ps[TY.paraIndexAt(t.content, Math.max(sel.a, sel.b - 1))].end;
          if (b === a) b = Math.min(n, a + 1);
        }
        if (a === 0 && b >= n && !paragraphs) t2 = applyWhole(t, patch);
        else if (a !== b) t2 = applyRange(t, patch, a, b);
        else {
          // only a caret: character settings wait for the next characters typed; manual kerning sets
          // the pair around the caret; paragraph and layer settings apply at once
          const rp = runPatch(t, patch);
          if (typeof patch.kerning === 'number') {
            if (a > 0) t2 = TY.withCharRange(t2, a - 1, a, { kern: patch.kerning });
            delete rp.kern;
            delete rp.kerning;
          }
          if (Object.keys(rp).length) session.insert = { at: a, patch: { ...(session.insert?.at === a ? session.insert.patch : {}), ...rp } };
          const rest = {};
          for (const [k, v] of Object.entries(patch)) if (PARA_SET.has(k) || LAYER_SET.has(k)) rest[k] = v;
          if (Object.keys(rest).length) t2 = applyRange(t2, rest, a, a + 1 > n ? a : a + 1);
          if (!Object.keys(rest).length && t2 === t) {
            P.overlay();
            P.emit('typesel');
            if (refocus) refocusEditor();
            continue;
          }
        }
      } else t2 = applyWhole(t, patch);
      if (t2 !== t) {
        const r0 = d.movedArea?.(l);
        const a0 = anchorPt(l);
        l.text = t2;
        keepAnchor(l, a0);
        if (!ed && 'font' in patch && l.name) { /* names follow the content, not the font */ }
        const r1 = d.movedArea?.(l);
        const area = r0 && r1 && r0.w > 0 && r1.w > 0 ? { x: Math.min(r0.x, r1.x), y: Math.min(r0.y, r1.y), w: Math.max(r0.x + r0.w, r1.x + r1.w) - Math.min(r0.x, r1.x), h: Math.max(r0.y + r0.h, r1.y + r1.h) - Math.min(r0.y, r1.y) } : null;
        d.touch(l, area);
        changed = true;
      }
    }
    P.redraw();
    if (!live && pending) {
      if (changed || pendingChanged) P.commit(label, pending);
      pending = null;
      pendingChanged = false;
    } else if (live && changed) pendingChanged = true;
    if (refocus) refocusEditor();
    P.overlay();
    P.emit('typesel');
  };
  let pendingChanged = false;
  const refocusEditor = () => refocus();

  // ---------------------------------------------------------------- the options bar

  const origSetOpt = P.setOpt;
  const OPT_LABEL = { size: '글자 크기', bold: '굵게', italic: '기울임', align: '정렬', aa: '앤티 앨리어스' };
  let syncing = false;
  P.setOpt = (id, key, v) => {
    origSetOpt(id, key, v);
    if (syncing || (TOOL_BY_ID[id]?.optionsFrom || id) !== 'text') return;
    const d = P.doc;
    if (!d || (!P.editingText && d.active?.kind !== 'text')) return;
    if (key === 'font') return barFont(v);
    if (key in OPT_LABEL) P.typeApply({ [key]: v }, OPT_LABEL[key], { refocus: true });
  };
  /**
   * The options bar's font picker sets the layer's own font after this (and records the step), so
   * the characters that must keep theirs get it as an override first.
   */
  const barFont = (font) => {
    const ed = P.editingText;
    const l = ed?.layer || P.doc.active;
    const t = l.text;
    const n = String(t.content ?? '').length;
    const sel = ed ? curSel() : null;
    const a0 = anchorPt(l);
    if (!sel || !n || (sel.a === 0 && sel.b >= n)) {
      l.text = { ...TY.clearRunKeys(t, ['font']), font };
      keepAnchor(l, a0);
      P.doc.touch(l);
      return;
    }
    const arr = TY.expandRuns(t, n);
    const keep = (i) => !(sel.a !== sel.b && i >= sel.a && i < sel.b);
    const out = arr.map((o, i) => (keep(i) && !(o && 'font' in o) ? { ...(o || {}), font: t.font } : o));
    if (sel.a !== sel.b) for (let i = sel.a; i < sel.b; i++) out[i] = { ...(out[i] || {}), font };
    else session.insert = { at: sel.a, patch: { ...(session.insert?.patch || {}), font } };
    l.text = { ...t, runs: TY.compressRuns(out) };
    keepAnchor(l, a0);
    P.doc.touch(l);
  };
  /** The options bar shows the settings of the selected text (like Photoshop). */
  const syncOpts = () => {
    const st = P.typeState();
    if (!st.layer) return;
    const o = P.opts('text');
    const want = { font: st.char.font, size: Math.round(st.char.size), bold: st.char.bold, italic: st.char.italic, align: st.para.align === 'justify' || st.para.align === 'justifyCenter' || st.para.align === 'justifyRight' || st.para.align === 'justifyAll' ? st.para.align : st.para.align };
    let diff = false;
    for (const [k, v] of Object.entries(want)) if (o[k] !== v && v != null) diff = true;
    if (!diff) return;
    syncing = true;
    try {
      for (const [k, v] of Object.entries(want)) if (v != null) o[k] = v;
      P.emit('opts');
    } finally {
      syncing = false;
    }
  };
  P.on('layers', () => {
    if (TYPE_TOOLS.includes(P.tool) && P.doc?.active?.kind === 'text') syncOpts();
  });

  // ---------------------------------------------------------------- keyboard shortcuts while editing

  const onKey = (e) => {
    if (!P.editingText || !session) return;
    const mod = e.ctrlKey || e.metaKey;
    const st = P.typeState().char;
    const key = e.key;
    const code = e.code;
    const run = (patch, label) => {
      e.preventDefault();
      P.typeApply(patch, label);
    };
    if (mod && e.shiftKey && (code === 'Period' || code === 'Comma')) return run({ size: Math.max(1, st.size + (code === 'Period' ? 1 : -1) * (e.altKey ? 10 : 2)) }, '글자 크기');
    if (e.altKey && !mod && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const step = (key === 'ArrowRight' ? 1 : -1) * 20;
      const sel = curSel();
      if (sel && sel.a === sel.b) return run({ kerning: (typeof st.kerning === 'number' ? st.kerning : 0) + step }, '커닝');
      return run({ tracking: (st.tracking || 0) + step }, '자간');
    }
    if (e.altKey && e.shiftKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) return run({ baseline: (st.baseline || 0) + (key === 'ArrowUp' ? 2 : -2) }, '기준선 이동');
    if (e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
      const t = P.editingText.layer.text;
      const cur = t.leading > 0 ? t.leading : Math.round(t.size * (t.lineHeight || 1.2));
      return run({ leading: Math.max(1, cur + (key === 'ArrowUp' ? -2 : 2)) }, '행간');
    }
    if (!mod || !e.shiftKey) return;
    const map = {
      KeyB: () => run({ fauxBold: !st.fauxBold }, '포조 굵게'),
      KeyI: () => run({ fauxItalic: !st.fauxItalic }, '포조 기울임꼴'),
      KeyU: () => run({ underline: !st.underline }, '밑줄'),
      Slash: () => run({ strike: !st.strike }, '취소선'),
      KeyK: () => run({ caps: st.caps === 'all' ? 'none' : 'all' }, '모두 대문자'),
      KeyH: () => run({ caps: st.caps === 'small' ? 'none' : 'small' }, '작은 대문자'),
      Equal: () => run({ script: e.altKey ? (st.script === 'sub' ? 'none' : 'sub') : st.script === 'super' ? 'none' : 'super' }, e.altKey ? '아래 첨자' : '위 첨자'),
      KeyL: () => run({ align: 'left' }, '왼쪽 정렬'),
      KeyC: () => run({ align: 'center' }, '가운데 정렬'),
      KeyR: () => run({ align: 'right' }, '오른쪽 정렬'),
      KeyJ: () => run({ align: 'justify' }, '마지막 줄 왼쪽 정렬 균등 배치'),
      KeyF: () => run({ align: 'justifyAll' }, '모두 균등 배치'),
      KeyX: () => run(e.altKey ? { vScale: 100 } : { hScale: 100 }, e.altKey ? '세로 비율' : '가로 비율'),
      KeyQ: () => run({ tracking: 0, kerning: 'metrics' }, '자간'),
      KeyA: () => (e.altKey ? run({ leading: 0 }, '자동 행간') : null),
    };
    map[code]?.();
  };

  // ---------------------------------------------------------------- the type tools on the canvas

  /** A path to type on or in at p: the current path, else the active shape layer's outline. */
  const typePathAt = (p) => {
    const tolD = 8 / P.view.zoom;
    const cands = [];
    const cur = P.getPath?.() || [];
    if (cur.length) cands.push(cur);
    const a = P.doc?.active;
    if (a?.kind === 'shape' && !(P.pathTarget?.kind === 'shape' && P.pathTarget.layerId === a.id)) cands.push(P.shapePathDoc(a));
    for (const sps of cands) {
      const n = PT.nearestOnPath(sps, p.x, p.y);
      if (n && n.d <= tolD) return { kind: 'path', sp: sps[n.si] };
    }
    const g = makeCanvas(1, 1).getContext('2d');
    for (const sps of cands) {
      for (let si = sps.length - 1; si >= 0; si--) {
        const sp = sps[si];
        if (!sp.closed || sp.knots.length < 2 || sp.op === 'subtract') continue;
        if (!g.isPointInPath(PT.toPath2D([sp]), p.x, p.y)) continue;
        const b = PT.pathBounds([sp]);
        // holes cut into it go with it
        const holes = sps.filter((o, i) => i !== si && o.closed && (o.op === 'subtract' || o.op === 'exclude') && (() => {
          const ob = PT.pathBounds([o]);
          return ob && b && ob.x >= b.x - 1 && ob.y >= b.y - 1 && ob.x + ob.w <= b.x + b.w + 1 && ob.y + ob.h <= b.y + b.h + 1;
        })());
        if (b && b.w > 4 && b.h > 4) return { kind: 'area', sps: [sp, ...holes], b };
      }
    }
    return null;
  };

  /** Path text start / end markers in doc coordinates. */
  const markersOf = (l) => {
    const t = l?.text;
    if (!t?.path?.subpath || !t.path.w0) return null;
    const sp = TY.pathOfText(t);
    const s = pointAtFrac(sp, t.path.start ?? 0);
    const e = pointAtFrac(sp, t.path.end ?? 1);
    return { start: { ...s, d: docPt(l, s.x, s.y) }, end: { ...e, d: docPt(l, e.x, e.y) }, sp };
  };
  const markerAt = (p) => {
    const l = P.doc?.active;
    const m = markersOf(l);
    if (!m) return null;
    const tolD = 9 / P.view.zoom;
    const ds = Math.hypot(m.start.d[0] - p.x, m.start.d[1] - p.y);
    const de = Math.hypot(m.end.d[0] - p.x, m.end.d[1] - p.y);
    if (Math.min(ds, de) > tolD) return null;
    return { layer: l, which: ds <= de ? 'start' : 'end', before: null, moved: false };
  };
  const dragMarker = (mk, p) => {
    const l = mk.layer;
    const t = l.text;
    if (!mk.before) mk.before = P.doc.capture();
    const sp = TY.pathOfText(t);
    const [x, y] = local(l, p);
    const f = fracOnPath(sp, x, y);
    const path = { ...t.path };
    if (mk.which === 'start') path.start = f.frac;
    else path.end = f.frac;
    if (!sp.closed) {
      if (mk.which === 'start') path.start = Math.min(path.start, (path.end ?? 1) - 0.005);
      else path.end = Math.max(path.end, (path.start ?? 0) + 0.005);
    }
    // dragging across the path flips the text to the other side
    const nx = Math.sin(f.ang);
    const ny = -Math.cos(f.ang);
    const side = (x - f.q[0]) * nx + (y - f.q[1]) * ny;
    const thr = (t.size || 72) * 0.35;
    if (!path.flip && side < -thr) path.flip = true;
    else if (path.flip && side > thr) path.flip = false;
    l.text = { ...t, path };
    mk.moved = true;
    P.doc.touch(l);
    P.redraw();
  };
  P.pathTextMarkerAt = markerAt;
  P.dragPathTextMarker = dragMarker;
  P.finishPathTextMarker = (mk) => {
    if (mk?.moved) P.commit('패스 위의 문자', mk.before);
  };

  const startSelect = (tool, l, p, e) => {
    const L = geom(l);
    const [x, y] = TY.toLocal(l, L.w, L.h, p.x, p.y);
    const i = TY.indexAtPoint(L, l.text, x, y);
    const now = performance.now();
    if (now - clicks.t < 450 && Math.hypot(p.x - clicks.x, p.y - clicks.y) * P.view.zoom < 6 && clicks.layer === l) clicks.n++;
    else clicks.n = 1;
    clicks.t = now;
    clicks.x = p.x;
    clicks.y = p.y;
    clicks.layer = l;
    const content = String(l.text.content ?? '');
    let a = i;
    let b = i;
    if (clicks.n === 2) [a, b] = TY.wordAt(content, i);
    else if (clicks.n === 3) {
      const pr = TY.paragraphs(content)[TY.paraIndexAt(content, i)];
      a = pr.start;
      b = pr.end;
    } else if (clicks.n >= 4) {
      a = 0;
      b = content.length;
    }
    const cur = curSel();
    if (e.shiftKey && clicks.n === 1 && cur) {
      const anchor = cur.back ? cur.b : cur.a;
      tool.sel = { layer: l, anchor, words: false };
      setSel(Math.min(anchor, i), Math.max(anchor, i), i < anchor);
      return;
    }
    tool.sel = { layer: l, anchor: a, end: b, words: clicks.n === 2 };
    setSel(a, b);
  };

  const wrapTypeTool = (id) => {
    const tool = TOOL_BY_ID[id];
    if (!tool) return;
    const vertical = id.startsWith('vertical');
    const mask = id.endsWith('Mask');
    tool.down = function (E, p, e) {
      this.sel = null;
      this.marker = null;
      this.d = null;
      const ed = P.editingText;
      if (ed && session && textHit(ed.layer, p, 6 / P.view.zoom)) {
        startSelect(this, ed.layer, p, e);
        return;
      }
      const mk = !mask && !ed && markerAt(p);
      if (mk) {
        this.marker = mk;
        return;
      }
      // on a path's outline: type on that path (unless right on the glyphs of a path text)
      const onPath = !mask && !vertical && typePathAt(p)?.kind === 'path';
      const hit = !mask && P.layerAt(p, (l) => l.kind === 'text' && !l.locked && (!onPath || !!l.text.path) && textHit(l, p, 2 / P.view.zoom));
      if (hit) {
        P.selectLayer(hit.id);
        P.editText(hit);
        if (session) startSelect(this, hit, p, e);
        return;
      }
      this.d = { a: p, b: p };
    };
    tool.move = function (E, p) {
      if (this.sel) {
        const l = this.sel.layer;
        const L = geom(l);
        const [x, y] = TY.toLocal(l, L.w, L.h, p.x, p.y);
        const i = TY.indexAtPoint(L, l.text, x, y);
        if (this.sel.words) {
          const [wa, wb] = TY.wordAt(l.text.content, i);
          setSel(Math.min(this.sel.anchor, wa), Math.max(this.sel.end, wb), wa < this.sel.anchor);
        } else setSel(Math.min(this.sel.anchor, i), Math.max(this.sel.anchor, i), i < this.sel.anchor);
        return;
      }
      if (this.marker) {
        dragMarker(this.marker, p);
        return;
      }
      if (!this.d) return;
      this.d.b = p;
      E.overlay();
    };
    tool.up = function (E) {
      if (this.sel) {
        this.sel = null;
        refocus();
        return;
      }
      if (this.marker) {
        P.finishPathTextMarker(this.marker);
        this.marker = null;
        return;
      }
      const d = this.d;
      this.d = null;
      if (!d) return;
      const o = E.opts('text');
      const before = E.doc.capture();
      const r = rectOf(d);
      const box = r.w > 8 && r.h > 8 ? { w: Math.round(r.w), h: Math.round(r.h) } : null;
      const t = E.newText(o, E.fg, { vertical, box, aa: o.aa || 'sharp' });
      const l = newLayer('text', { name: mask ? '문자 마스크' : '텍스트', text: t, typeMask: mask });
      const tp = !box && !mask && !vertical ? typePathAt(d.a) : null;
      if (tp?.kind === 'path') {
        // type on a path: the path is kept relative to a box around it (so the layer moves, turns and scales)
        const sp = tp.sp;
        const b = PT.pathBounds([sp]) || { x: d.a.x, y: d.a.y, w: 1, h: 1 };
        const pad = Math.ceil((o.size || 72) * 1.3);
        l.x = Math.floor(b.x - pad);
        l.y = Math.floor(b.y - pad);
        const w0 = Math.ceil(b.w + pad * 2);
        const h0 = Math.ceil(b.h + pad * 2);
        const f = fracOnPath(sp, d.a.x, d.a.y).frac;
        l.text = { ...t, box: { w: w0, h: h0 }, align: 'left', path: { subpath: PT.clonePath(PT.translatePath([sp], -l.x, -l.y))[0], start: f, end: sp.closed ? (f + 0.985) % 1 : 1, flip: false, w0, h0 } };
        l.name = '패스 위의 문자';
      } else if (tp?.kind === 'area') {
        const b = tp.b;
        l.x = Math.floor(b.x);
        l.y = Math.floor(b.y);
        const w0 = Math.max(4, Math.ceil(b.w + (b.x - l.x)));
        const h0 = Math.max(4, Math.ceil(b.h + (b.y - l.y)));
        l.text = { ...t, box: { w: w0, h: h0 }, area: { subpaths: PT.clonePath(PT.translatePath(tp.sps, -l.x, -l.y)), w0, h0 } };
        l.name = '영역 문자';
      } else if (box) {
        l.x = Math.round(r.x);
        l.y = Math.round(r.y);
      } else if (vertical) {
        l.x = Math.round(d.a.x - (o.size || 72) * 0.6);
        l.y = Math.round(d.a.y);
      } else {
        l.x = Math.round(d.a.x);
        l.y = Math.round(d.a.y - (o.size || 72) * 0.95);
      }
      E.addLayer(l);
      E.editText(l, before);
    };
    tool.overlay = function (E, g) {
      if (this.d) {
        const r = rectOf(this.d);
        if (r.w >= 3 || r.h >= 3) {
          const [x, y] = E.toScreen(r.x, r.y);
          g.strokeStyle = '#4aa3ff';
          g.setLineDash([4, 3]);
          g.strokeRect(x + 0.5, y + 0.5, r.w * E.view.zoom, r.h * E.view.zoom);
          g.setLineDash([]);
        }
      }
      drawTypeOverlay(g, { hint: !mask && !vertical });
    };
  };
  for (const id of TYPE_TOOLS) wrapTypeTool(id);
  // the options bar gets Photoshop's anti-aliasing menu (the type tools share one options list)
  const textOptions = TOOL_BY_ID.text?.options;
  if (textOptions && !textOptions.some((o) => o[0] === 'aa')) textOptions.push(['aa', '앤티 앨리어스', 'select', null, null, 'sharp', TY.AA_MODES]);

  // path selection tools drag the markers of type on a path too
  for (const id of ['pathSelect', 'directSelect']) {
    const tool = TOOL_BY_ID[id];
    if (!tool) continue;
    const { down, move, up, overlay } = tool;
    tool.down = function (E, p, e) {
      const mk = markerAt(p);
      if (mk) {
        this.ptMarker = mk;
        return;
      }
      this.ptMarker = null;
      down.call(this, E, p, e);
    };
    tool.move = function (E, p, e) {
      if (this.ptMarker) return dragMarker(this.ptMarker, p);
      return move.call(this, E, p, e);
    };
    tool.up = function (E, p, e) {
      if (this.ptMarker) {
        P.finishPathTextMarker(this.ptMarker);
        this.ptMarker = null;
        return undefined;
      }
      return up.call(this, E, p, e);
    };
    tool.overlay = function (E, g) {
      overlay?.call(this, E, g);
      drawMarkers(g);
    };
  }

  // hover: show what a click would make (type on a path, area type)
  let hoverKind = null;
  P.on('pointer', () => {
    if (!['text', 'verticalText'].includes(P.tool) || !P.doc || P.editingText) {
      if (hoverKind) {
        hoverKind = null;
        P.overlay();
      }
      return;
    }
    const p = P.hoverPoint;
    let k = null;
    if (p && P.tool === 'text' && !P.layerAt(p, (l) => l.kind === 'text' && textHit(l, p, 2 / P.view.zoom))) k = markerAt(p) ? 'marker' : typePathAt(p)?.kind || null;
    if (k !== hoverKind || k) {
      hoverKind = k;
      P.overlay();
    }
  });

  const drawMarkers = (g) => {
    const l = P.doc?.active;
    const m = markersOf(l);
    if (!m) return;
    const z = P.view.zoom;
    // the path itself, thin
    const L = geom(l);
    g.save();
    g.strokeStyle = 'rgba(61,139,255,.75)';
    g.lineWidth = 1;
    g.beginPath();
    PT.flatten(m.sp, 3 / Math.max(0.05, z)).forEach(([x, y], i) => {
      const [sx, sy] = P.toScreen(...TY.toDoc(l, L.w, L.h, x, y));
      if (i) g.lineTo(sx, sy);
      else g.moveTo(sx, sy);
    });
    if (m.sp.closed) g.closePath();
    g.stroke();
    const rot = ((l.rotation || 0) * Math.PI) / 180;
    for (const which of ['start', 'end']) {
      const mk = m[which];
      const [sx, sy] = P.toScreen(mk.d[0], mk.d[1]);
      const a = mk.ang + rot;
      const nx = Math.sin(a);
      const ny = -Math.cos(a);
      g.strokeStyle = '#3d8bff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(sx - nx * 10, sy - ny * 10);
      g.lineTo(sx + nx * 10, sy + ny * 10);
      g.stroke();
      g.fillStyle = which === 'start' ? '#3d8bff' : '#ffffff';
      g.beginPath();
      g.arc(sx, sy, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    if (L.overflow) drawOverflow(g, m.end.d);
    g.restore();
  };
  const drawOverflow = (g, at) => {
    const [sx, sy] = P.toScreen(at[0], at[1]);
    g.save();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#d33';
    g.lineWidth = 1.5;
    g.fillRect(sx - 6, sy - 6, 12, 12);
    g.strokeRect(sx - 6, sy - 6, 12, 12);
    g.beginPath();
    g.moveTo(sx - 3, sy);
    g.lineTo(sx + 3, sy);
    g.moveTo(sx, sy - 3);
    g.lineTo(sx, sy + 3);
    g.stroke();
    g.restore();
  };

  /** Caret, selected characters, area shape, path markers and the hover hint. */
  const drawTypeOverlay = (g, { hint = false } = {}) => {
    const ed = P.editingText;
    if (ed && session) {
      const l = ed.layer;
      const L = geom(l);
      const sel = curSel();
      const toS = (x, y) => P.toScreen(...TY.toDoc(l, L.w, L.h, x, y));
      g.save();
      if (l.text.area) {
        g.strokeStyle = 'rgba(61,139,255,.8)';
        g.lineWidth = 1;
        for (const sp of TY.areaPaths(l.text)) {
          g.beginPath();
          PT.flatten(sp, 3).forEach(([x, y], i) => (i ? g.lineTo(...toS(x, y)) : g.moveTo(...toS(x, y))));
          if (sp.closed) g.closePath();
          g.stroke();
        }
      }
      if (sel && sel.a !== sel.b) {
        g.fillStyle = 'rgba(61,139,255,.35)';
        for (const poly of TY.selectionPolys(L, l.text, sel.a, sel.b)) {
          g.beginPath();
          poly.forEach(([x, y], i) => (i ? g.lineTo(...toS(x, y)) : g.moveTo(...toS(x, y))));
          g.closePath();
          g.fill();
        }
      } else if (sel) {
        const [p0, p1] = TY.caretSegment(L, l.text, sel.a);
        const a = toS(...p0);
        const b = toS(...p1);
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(255,255,255,.85)';
        g.beginPath();
        g.moveTo(...a);
        g.lineTo(...b);
        g.stroke();
        g.lineWidth = 1.5;
        g.strokeStyle = '#111';
        g.stroke();
      }
      if (L.overflow && !L.path) drawOverflow(g, TY.toDoc(l, L.w, L.h, L.w, L.h));
      g.restore();
    }
    drawMarkers(g);
    if (hint && hoverKind && P.hoverPoint && !ed) {
      const [sx, sy] = P.toScreen(P.hoverPoint.x, P.hoverPoint.y);
      const label = hoverKind === 'path' ? '패스 위의 문자' : hoverKind === 'area' ? '영역 문자' : '시작 / 끝 표시 끌기';
      g.save();
      g.font = '12px sans-serif';
      const w = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(20,24,30,.85)';
      g.fillRect(sx + 14, sy + 14, w, 20);
      g.fillStyle = '#fff';
      g.fillText(label, sx + 19, sy + 28);
      g.restore();
    }
  };

  // ---------------------------------------------------------------- commands

  const activeText = () => (P.doc?.active?.kind === 'text' ? P.doc.active : null);
  const textLayers = () => (P.doc ? P.doc.selectedLayers.filter((l) => l.kind === 'text') : []);
  const withTexts = (label, fn) => {
    if (P.editingText) P.finishText();
    const ls = textLayers();
    if (!ls.length) return toast('문자 레이어를 고르세요');
    P.run(label, () => {
      for (const l of ls) {
        fn(l);
        l._text = null;
        P.doc.touch(l);
      }
    });
    return undefined;
  };

  C.textOrientation = (dir) => withTexts(dir === 'v' ? '세로 방향' : '가로 방향', (l) => {
    if (l.text.path || l.text.area) return;
    const L0 = geom(l);
    const cx = l.x + L0.w / 2;
    const cy = l.y + L0.h / 2;
    l.text = { ...l.text, vertical: dir === 'v', box: l.text.box ? { w: l.text.box.h, h: l.text.box.w } : null };
    const L1 = geom(l);
    l.x = Math.round(cx - L1.w / 2);
    l.y = Math.round(cy - L1.h / 2);
  });
  C.textAntiAlias = (mode) => {
    if (!textLayers().length) {
      P.opts('text').aa = mode;
      origSetOpt('text', 'aa', mode);
      return toast(`새 글자의 앤티 앨리어스: ${TY.AA_MODES.find((m) => m[0] === mode)?.[1]}`);
    }
    return withTexts('앤티 앨리어스', (l) => {
      l.text = { ...l.text, aa: mode };
    });
  };
  /** Point text ↔ paragraph text (Photoshop's Convert Text Shape Type). */
  C.convertTextType = () => withTexts('텍스트 유형 변환', (l) => {
    const t = l.text;
    if (t.path) return;
    const L = geom(l);
    if (!t.box && !t.area) {
      l.text = { ...t, box: { w: Math.max(20, Math.ceil(L.w + t.size * 0.5)), h: Math.max(20, Math.ceil(L.h + t.size * 0.3)) } };
      return;
    }
    // paragraph → point: every wrapped line ends in a line break (spaces before it dropped);
    // character runs and paragraph settings travel with their characters
    const content = String(t.content ?? '');
    const arr = TY.expandRuns(t, content.length);
    let s = '';
    const ov = [];
    const paras = [];
    let maxEnd = 0;
    const lines = t.vertical ? [] : L.lines;
    lines.forEach((ln, li) => {
      let gs = ln.glyphs.map((k) => L.glyphs[k]);
      const endsNl = gs.length && gs[gs.length - 1].nl;
      const soft = !endsNl && li < lines.length - 1;
      if (soft) while (gs.length && gs[gs.length - 1].sp) gs = gs.slice(0, -1);
      if (ln.first || !paras.length) paras.push(t.paras?.[ln.para] || null);
      for (const g of gs) {
        s += g.ch;
        for (let q = 0; q < g.len; q++) ov.push(arr[g.i + q] ?? null);
      }
      for (const k of ln.glyphs) maxEnd = Math.max(maxEnd, L.glyphs[k].i + L.glyphs[k].len);
      if (soft) {
        s += '\n';
        ov.push(ov.length ? ov[ov.length - 1] : null);
        paras.push(t.paras?.[ln.para] || null);
      }
    });
    if (t.vertical) {
      s = content;
      ov.push(...arr);
      maxEnd = content.length;
    } else if (maxEnd < content.length) {
      // text that did not fit in the box comes along at the end
      s += content.slice(maxEnd);
      ov.push(...arr.slice(maxEnd));
    }
    l.text = { ...t, content: s, runs: TY.compressRuns(ov), paras: !t.vertical && paras.some(Boolean) ? paras : t.vertical ? t.paras : null, box: null, area: null };
  });
  C.flipPathText = () => withTexts('패스 위의 문자 뒤집기', (l) => {
    if (l.text.path) l.text = { ...l.text, path: { ...l.text.path, flip: !l.text.path.flip } };
  });
  C.updateAllText = () => {
    const d = P.doc;
    if (!d) return;
    const ls = d.layers.filter((l) => l.kind === 'text');
    if (!ls.length) return toast('문자 레이어가 없습니다');
    P.run('모든 문자 레이어 업데이트', () => {
      for (const l of ls) {
        migrate(l);
        l._text = null;
        d.touch(l);
      }
    });
    return toast(`문자 레이어 ${ls.length}개를 다시 그렸습니다`);
  };
  /** Type ▸ Paste Placeholder Text: into the text being edited (a paragraph box gets filled). */
  C.pastePlaceholder = (lang = 'ko') => {
    const s = session;
    if (!P.editingText || !s) {
      // no text being edited: a new paragraph text in the middle of the canvas
      const d = P.doc;
      if (!d) return;
      const o = P.opts('text');
      const before = d.capture();
      const size = Math.max(12, Math.round(Math.min(d.width, d.height) / 28));
      const w = Math.round(d.width * 0.6);
      const hh = Math.round(d.height * 0.5);
      const t = P.newText({ ...o, size }, P.fg, { box: { w, h: hh }, content: '', aa: o.aa || 'sharp' });
      const l = newLayer('text', { name: lang === 'ko' ? '자리 표시자' : 'Lorem ipsum', text: t });
      l.x = Math.round((d.width - w) / 2);
      l.y = Math.round((d.height - hh) / 2);
      P.addLayer(l);
      P.editText(l, before);
    }
    const el = session?.el;
    if (!el) return;
    const l = P.editingText.layer;
    let text = LOREM[lang] || LOREM.ko;
    const t = l.text;
    const fill = (t.box || t.area) && !t.path && !String(t.content ?? '').trim();
    if (fill) {
      // a paragraph box is filled: enough text, then cut where it stops fitting
      let out = text;
      while (out.length < 6000) out += ` ${text}`;
      text = out;
    }
    el.focus({ preventScroll: true });
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (fill) {
      const L = geom(l);
      let end = 0;
      for (const g of L.glyphs) if (!g.hidden && !g.nl) end = Math.max(end, g.i + g.len);
      const s = el.value;
      let cut = end;
      if (cut < s.length) {
        const sp = s.lastIndexOf(' ', cut);
        if (sp > cut * 0.6) cut = sp;
        el.value = s.slice(0, cut).replace(/\s+$/, '');
        el.setSelectionRange(el.value.length, el.value.length);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    onCaret();
    return undefined;
  };

  // ---------------------------------------------------------------- character and paragraph styles

  const styles = (kind) => P.doc?.[kind === 'char' ? 'charStyles' : 'paraStyles'] || [];
  const setStyles = (kind, list) => {
    P.doc[kind === 'char' ? 'charStyles' : 'paraStyles'] = list;
  };
  /** Current character (and paragraph) settings as a style definition. */
  const currentProps = (kind) => {
    const st = P.typeState();
    const ch = {};
    for (const k of CHAR_PROPS) ch[k] = st.char[k];
    if (kind === 'char') return ch;
    return { ...ch, align: st.para.align, indent: { ...st.para.indent }, spaceBefore: st.para.spaceBefore, spaceAfter: st.para.spaceAfter };
  };
  P.textStyles = styles;
  P.newTextStyle = async (kind) => {
    const d = P.doc;
    if (!d) return;
    const list = styles(kind);
    const name = await promptDialog(kind === 'char' ? '새 문자 스타일' : '새 단락 스타일', '스타일 이름', `${kind === 'char' ? '문자 스타일' : '단락 스타일'} ${list.length + 1}`);
    if (!name?.trim()) return;
    const id = `${kind === 'char' ? 'cs' : 'ps'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const props = currentProps(kind);
    const ed = !!P.editingText;
    if (!ed) pending = null;
    const before = ed ? null : d.capture();
    setStyles(kind, [...list, { id, name: name.trim(), props }]);
    if (before) P.commit(kind === 'char' ? '새 문자 스타일' : '새 단락 스타일', before);
    // the text it came from now uses it
    P.applyTextStyle(kind, id, { quiet: true });
    P.emit('textstyles');
  };
  P.applyTextStyle = (kind, id, { quiet = false } = {}) => {
    const st = styles(kind).find((s) => s.id === id);
    if (id && !st) return;
    if (!P.editingText && !textLayers().length) {
      if (!quiet) toast('문자 레이어를 고르거나 글자를 고르세요');
      return;
    }
    if (kind === 'char') {
      if (!id) P.typeApply({ cs: undefined }, '문자 스타일 없음');
      else P.typeApply({ ...st.props, cs: id }, `문자 스타일: ${st.name}`);
    } else if (!id) P.typeApply({ ps: undefined }, '단락 스타일 없음', { paragraphs: true });
    else P.typeApply({ ...st.props, ps: id }, `단락 스타일: ${st.name}`, { paragraphs: true });
    P.emit('textstyles');
  };
  /** Redefine a style from the current text, and update every text that uses it. */
  P.redefineTextStyle = (kind, id) => {
    const d = P.doc;
    const st = styles(kind).find((s) => s.id === id);
    if (!st || !d) return;
    const props = currentProps(kind);
    const run = () => {
      setStyles(kind, styles(kind).map((s) => (s.id === id ? { ...s, props } : s)));
      for (const l of d.layers) {
        if (l.kind !== 'text') continue;
        let t = l.text;
        const n = String(t.content ?? '').length;
        if (kind === 'char') {
          if (t.cs === id) t = applyWhole(t, props);
          const arr = TY.expandRuns(t, n);
          let i = 0;
          while (i < n) {
            if (arr[i]?.cs === id) {
              let j = i;
              while (j < n && arr[j]?.cs === id) j++;
              t = applyRange(t, props, i, j);
              i = j;
            } else i++;
          }
        } else {
          const ps = TY.paragraphs(t.content);
          ps.forEach((pr, pi) => {
            if ((t.paras?.[pi]?.ps ?? t.ps) === id) t = applyRange(t, props, pr.start, Math.max(pr.end, pr.start + 1));
          });
        }
        if (t !== l.text) {
          l.text = t;
          d.touch(l);
        }
      }
    };
    if (P.editingText) {
      run();
      P.redraw();
    } else P.run(kind === 'char' ? '문자 스타일 재정의' : '단락 스타일 재정의', run);
    P.emit('textstyles');
  };
  P.deleteTextStyle = (kind, id) => {
    const d = P.doc;
    if (!d) return;
    const run = () => {
      setStyles(kind, styles(kind).filter((s) => s.id !== id));
      // text keeps its look; it just stops pointing at the style
      for (const l of d.layers) {
        if (l.kind !== 'text') continue;
        let t = l.text;
        if (kind === 'char') {
          if (t.cs === id) t = { ...t, cs: undefined };
          if (t.runs?.some((r) => r.cs === id)) t = { ...t, runs: TY.compressRuns(TY.expandRuns(t).map((o) => (o?.cs === id ? (({ cs, ...rest }) => rest)(o) : o))) };
        } else {
          if (t.ps === id) t = { ...t, ps: undefined };
          if (t.paras?.some((o) => o?.ps === id)) t = { ...t, paras: t.paras.map((o) => (o?.ps === id ? (({ ps, ...rest }) => (Object.keys(rest).length ? rest : null))(o) : o)) };
        }
        if (t !== l.text) l.text = t;
      }
    };
    if (P.editingText) run();
    else P.run(kind === 'char' ? '문자 스타일 삭제' : '단락 스타일 삭제', run);
    P.emit('textstyles');
  };
  P.renameTextStyle = async (kind, id) => {
    const st = styles(kind).find((s) => s.id === id);
    if (!st) return;
    const name = await promptDialog('스타일 이름', '이름', st.name);
    if (!name?.trim()) return;
    P.run('스타일 이름', () => setStyles(kind, styles(kind).map((s) => (s.id === id ? { ...s, name: name.trim() } : s))));
    P.emit('textstyles');
  };
  /** The style the current text uses, and whether its settings differ from it ("+" in Photoshop). */
  P.textStyleState = (kind) => {
    const ts = P.typeState();
    if (!ts.layer) return { id: null, override: false };
    const id = kind === 'char' ? ts.char.cs : ts.para.ps;
    const st = styles(kind).find((s) => s.id === id);
    if (!st) return { id: null, override: false };
    const cur = currentProps(kind);
    const override = Object.entries(st.props).some(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v));
    return { id, override };
  };

  // ---------------------------------------------------------------- menus

  const panelItems = () => [
    { label: '문자 패널', action: () => P.showPanel('char') },
    { label: '단락 패널', action: () => P.showPanel('para') },
    { label: '글리프 패널', action: () => P.showPanel('glyphs') },
    { label: '문자 스타일 패널', action: () => P.showPanel('charStyles') },
    { label: '단락 스타일 패널', action: () => P.showPanel('paraStyles') },
  ];
  P.typeMenuItems = () => {
    const l = activeText();
    const t = l?.text;
    const aa = t?.aa || P.opts('text').aa || 'sharp';
    return {
      aa: { label: '앤티 앨리어스', disabled: !P.doc, submenu: TY.AA_MODES.map(([v, n]) => ({ label: n, checked: aa === v, action: () => C.textAntiAlias(v) })) },
      dir: { label: '방향', disabled: !l || !!t?.path || !!t?.area, submenu: [{ label: '가로', checked: !!l && !t.vertical, action: () => C.textOrientation('h') }, { label: '세로', checked: !!t?.vertical, action: () => C.textOrientation('v') }] },
      convert: { label: t?.box || t?.area ? '포인트 텍스트로 변환' : '단락 텍스트로 변환', disabled: !l || !!t?.path, action: () => C.convertTextType() },
      flip: { label: '패스 위의 문자 뒤집기', disabled: !t?.path, action: () => C.flipPathText() },
      update: { label: '모든 문자 레이어 업데이트', disabled: !P.doc, action: () => C.updateAllText() },
      lorem: { label: '자리 표시자 텍스트 붙여넣기', disabled: !P.doc, submenu: [{ label: '한글 (임시 문장)', action: () => C.pastePlaceholder('ko') }, { label: 'Lorem Ipsum (라틴어)', action: () => C.pastePlaceholder('la') }] },
    };
  };
  const TEXT_ONLY = new Set(['텍스트 뒤틀기…', '작업 패스 만들기', '모양으로 변환', '문자 레이어 래스터화']);
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['문자'];
    if (orig) {
      P.menus['문자'] = () => {
        const isText = !!activeText();
        const m = P.typeMenuItems();
        const items = orig().map((it) => {
          if (!it || it === '-' || typeof it !== 'object') return it;
          if (it.label === '패널') return { ...it, submenu: panelItems() };
          if (TEXT_ONLY.has(it.label)) return { ...it, disabled: !isText };
          return it;
        });
        const at = (label) => items.findIndex((x) => x?.label === label);
        const pi = at('패널');
        items.splice(pi + 1, 0, m.aa, m.dir);
        const ri = at('문자 레이어 래스터화');
        items.splice(ri >= 0 ? ri + 1 : items.length, 0, m.convert, m.flip);
        // Find and Replace Text stays in the Edit menu only, as in Photoshop
        const fi = at('텍스트 찾기 / 바꾸기…');
        if (fi >= 0) items.splice(fi, 1, m.update, m.lorem);
        else items.push('-', m.update, m.lorem);
        return items;
      };
    }
    const win = P.menus['창'];
    if (win) {
      P.menus['창'] = () => {
        const items = win();
        const gi = items.findIndex((x) => x?.label === '글리프');
        items.splice(gi >= 0 ? gi : items.length, 0,
          { label: '문자', action: () => P.showPanel('char') },
          { label: '단락', action: () => P.showPanel('para') },
          { label: '문자 스타일', action: () => P.showPanel('charStyles') },
          { label: '단락 스타일', action: () => P.showPanel('paraStyles') });
        return items;
      };
    }
  }];
}

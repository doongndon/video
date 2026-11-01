// Artboards (대지), like Photoshop's: an artboard is a top-level group with a rectangle, a background
// (흰색 / 검정 / 투명 / 사용자 정의) and a name. Its layers are cut to its rectangle; a document can hold
// several, and the area between them is pasteboard. The document always covers exactly the artboards
// (it grows and shrinks as they are added, moved and resized, like Photoshop's canvas).
//
// Here: the Artboard tool (V, with the Move tool), its options bar, the overlay (names, + buttons,
// handles), Layer ▸ New ▸ 대지… / 그룹에서 대지 / 레이어에서 대지, File ▸ Export ▸ 대지를 파일로…, the
// New Document "대지" option and the bookkeeping after every step (moving layers between artboards,
// fitting the document to the artboards).

import { h, clamp, downloadBlob } from '../util.js';
import { toast, openModal, formRow, promptDialog } from '../ui/common.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import { PhotoDoc, newLayer, makeCanvas } from './doc.js';
import { translatePath } from './paths.js';
import { maskReveals } from './transform.js';
import { encodeImage, quickExportPrefs, docMeta } from './exportas.js';

/** Photoshop-style size presets: [label, width, height]. */
export const ARTBOARD_PRESETS = [
  ['iPhone 16 / 15 Pro (393 × 852)', 393, 852],
  ['iPhone 16 Pro Max (440 × 956)', 440, 956],
  ['iPhone SE (375 × 667)', 375, 667],
  ['Android (360 × 800)', 360, 800],
  ['iPad Pro 11" (834 × 1194)', 834, 1194],
  ['웹 1920 × 1080', 1920, 1080],
  ['웹 1366 × 768', 1366, 768],
  ['인스타그램 정사각형 (1080 × 1080)', 1080, 1080],
  ['인스타그램 세로 4:5 (1080 × 1350)', 1080, 1350],
  ['인스타그램 스토리 · 릴스 (1080 × 1920)', 1080, 1920],
  ['유튜브 썸네일 (1280 × 720)', 1280, 720],
  ['유튜브 채널 아트 (2560 × 1440)', 2560, 1440],
  ['A4 72ppi (595 × 842)', 595, 842],
  ['A4 300ppi (2480 × 3508)', 2480, 3508],
  ['명함 300ppi (1063 × 591)', 1063, 591],
];
export const ARTBOARD_BGS = [['white', '흰색'], ['black', '검정'], ['transparent', '투명'], ['custom', '사용자 정의']];

const GAP = 100; // space between artboards made with the + buttons (document pixels)

export const isArtboard = (l) => !!(l && l.kind === 'group' && l.artboard);
/** The document's artboards, bottom → top. */
export const artboardsOf = (doc) => (doc ? doc.layers.filter((l) => isArtboard(l) && !l.parent) : []);
/** The artboard a layer belongs to (or the artboard itself), or null on the pasteboard. */
export function artboardOf(doc, l) {
  if (!doc || !l) return null;
  if (isArtboard(l)) return l;
  const top = doc.ancestors(l).pop();
  return isArtboard(top) ? top : null;
}
/** The topmost artboard under a document point. */
export function artboardAt(doc, p) {
  const list = artboardsOf(doc);
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i].artboard;
    if (list[i].visible && p.x >= a.x && p.y >= a.y && p.x < a.x + a.w && p.y < a.y + a.h) return list[i];
  }
  return null;
}
export const artboardFill = (a) => (a.bg === 'transparent' ? null : a.bg === 'black' ? '#000000' : a.bg === 'custom' ? a.color || '#ffffff' : '#ffffff');

function nextName(doc) {
  let n = 0;
  for (const l of doc.layers) {
    const m = /^대지 (\d+)$/.exec(l.name || '');
    if (m) n = Math.max(n, +m[1]);
  }
  return `대지 ${n + 1}`;
}
/** A background setting from a colour (the New Document dialog's 배경 내용). */
function bgFrom(v) {
  if (v === 'transparent' || v === null) return { bg: 'transparent' };
  const c = String(v || '#ffffff').toLowerCase();
  if (c === '#ffffff' || c === '#fff' || c === 'white') return { bg: 'white' };
  if (c === '#000000' || c === '#000' || c === 'black') return { bg: 'black' };
  return { bg: 'custom', color: c };
}
const rectOf = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) });

export function makeArtboard(doc, r, { name, bg = 'white', color } = {}) {
  return newLayer('group', { name: name || nextName(doc), artboard: { ...rectOf(r), bg, ...(bg === 'custom' ? { color: color || '#ffffff' } : {}) } });
}

/** One artboard as a picture of its own size (background optional). */
export function renderArtboard(doc, ab, { fg, bg, background = true } = {}) {
  const full = makeCanvas(doc.width, doc.height);
  const g = full.getContext('2d');
  const o = { sig: `abx${ab.id}`, only: null, skipId: null, float: null, fg, bg, root: g };
  doc.drawArtboard(g, background ? ab : { ...ab, artboard: { ...ab.artboard, bg: 'transparent' } }, o);
  const a = ab.artboard;
  const out = makeCanvas(a.w, a.h);
  out.getContext('2d').drawImage(full, -a.x, -a.y);
  return out;
}

// ---------------------------------------------------------------- keeping the document around the artboards

/**
 * Move everything in the document by (dx, dy) and make it W × H (no undo step of its own): layers,
 * artboards, masks, selection, saved selections, paths, guides and markers.
 */
function shiftDoc(doc, dx, dy, W, H) {
  if (dx || dy) {
    // unlinked masks stay behind when their layer moves: move them by hand
    for (const l of doc.layers) {
      if (l.mask && l.mask.linked === false) l.mask = { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy };
      if (l.vmask && l.vmask.linked === false) l.vmask = { ...l.vmask, dx: (l.vmask.dx || 0) + dx, dy: (l.vmask.dy || 0) + dy };
    }
    doc.translateLayers(doc.layers.filter((l) => !l.parent), dx, dy);
    for (const gd of doc.guides || []) gd.pos += gd.axis === 'x' ? dx : dy;
    for (const k of ['notes', 'counts', 'samplers']) for (const m of doc[k] || []) Object.assign(m, { x: m.x + dx, y: m.y + dy });
    doc.paths = (doc.paths || []).map((p) => ({ ...p, subpaths: translatePath(p.subpaths, dx, dy) }));
    if (doc.workPath?.subpaths) doc.workPath = { ...doc.workPath, subpaths: translatePath(doc.workPath.subpaths, dx, dy) };
    if (doc.rulerOrigin) doc.rulerOrigin = { ...doc.rulerOrigin, x: (doc.rulerOrigin.x || 0) + dx, y: (doc.rulerOrigin.y || 0) + dy };
  }
  const moveCanvas = (c, ox = dx, oy = dy) => {
    const n = makeCanvas(W, H);
    n.getContext('2d').drawImage(c, ox, oy);
    return n;
  };
  if (doc.selection) doc.selection = { canvas: moveCanvas(doc.selection.canvas) };
  if (doc.quickMask) doc.quickMask = { canvas: moveCanvas(doc.quickMask.canvas) };
  doc.channels = (doc.channels || []).map((ch) => ({ ...ch, canvas: moveCanvas(ch.canvas) }));
  doc.width = W;
  doc.height = H;
  // masks are kept covering the document (painting on them anywhere works)
  for (const l of doc.layers) {
    const m = l.mask;
    if (!m || (m.x <= 0 && m.y <= 0 && m.x + m.canvas.width >= W && m.y + m.canvas.height >= H)) continue;
    // the new area takes the mask's edge colour: a mask that shows everything keeps showing there
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    if (maskReveals(m)) {
      g.fillRect(0, 0, W, H);
      g.clearRect(m.x, m.y, m.canvas.width, m.canvas.height);
    }
    g.drawImage(m.canvas, m.x, m.y);
    l.mask = { ...m, canvas: c, x: 0, y: 0 };
    l._styled = null;
    l.rev++;
  }
  doc.rev++;
  doc._dirtyRect = null;
}

/** The document fitted to its artboards; returns the shift applied to document coordinates. */
export function fitDocToArtboards(P, doc) {
  const list = artboardsOf(doc);
  if (!list.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { artboard: a } of list) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.w);
    y1 = Math.max(y1, a.y + a.h);
  }
  if (!x0 && !y0 && x1 === doc.width && y1 === doc.height) return null;
  const W = x1 - x0;
  const H = y1 - y0;
  if (W * H > 120e6) return null;
  shiftDoc(doc, -x0, -y0, W, H);
  // the view follows, so nothing jumps on screen
  if (doc.view) {
    const z = doc.view.zoom || 1;
    doc.view = { ...doc.view, x: doc.view.x + x0 * z, y: doc.view.y + y0 * z, auto: false };
    P?.viewChanged?.();
  }
  return { dx: -x0, dy: -y0 };
}

// ---------------------------------------------------------------- install

export function installArtboards(P) {
  const C = P.cmd;
  const doc = () => P.doc;
  const active = () => artboardOf(P.doc, P.doc?.active);

  // ---- after every step: artboards stay top-level, layers moved onto another artboard join it,
  // and the document covers exactly the artboards
  let panelMoves = null;
  const fixUp = (d, label) => {
    if (!d.layers.some(isArtboard)) return;
    // an artboard can't sit inside a group (Ctrl+G, a drop into a group): lift it out
    // (top first, so their order is kept)
    for (const ab of d.layers.filter((l) => isArtboard(l) && l.parent).reverse()) {
      const top = d.ancestors(ab).pop();
      d.moveBlock(ab.id, d.index(top.id) + 1, null);
    }
    // dragged in the Layers panel from one artboard to another: it keeps its place on the artboard
    if (panelMoves) {
      for (const [id, from] of panelMoves) {
        const l = d.layer(id);
        const to = artboardOf(d, l);
        if (l && from && to && from !== to.id && !isArtboard(l)) {
          const fa = d.layer(from)?.artboard;
          if (fa) d.translateLayers([l], to.artboard.x - fa.x, to.artboard.y - fa.y);
        }
      }
      panelMoves = null;
    }
    // moved on the canvas (Move tool) onto another artboard or the pasteboard: it goes there
    if (label === '이동' && !d.selection) {
      const sel = d.selectedLayers.filter((l) => !isArtboard(l) && !d.ancestors(l).some((a) => d.selectedLayers.includes(a)));
      for (const l of sel) {
        const b = d.opaqueBounds(l) || d.bounds(l);
        if (!b) continue;
        const to = artboardAt(d, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
        const from = artboardOf(d, l);
        if (to === from) continue;
        if (to) d.moveBlock(l.id, d.index(to.id), to.id);
        else d.moveBlock(l.id, d.index(from.id) + 1, null);
        d.touch(l);
      }
    }
    fitDocToArtboards(P, d);
  };
  const commit = P.commit;
  P.commit = (label, before, opts) => {
    const d = P.doc;
    if (d) fixUp(d, label);
    return commit(label, before, opts);
  };
  for (const k of ['moveLayerTo', 'moveLayersTo']) {
    const orig = C[k];
    if (!orig) continue;
    C[k] = (...args) => {
      const d = doc();
      const ids = k === 'moveLayerTo' ? [args[0]] : args[0];
      panelMoves = d ? new Map(ids.filter((id) => d.layer(id)).map((id) => [id, artboardOf(d, d.layer(id))?.id || null])) : null;
      try {
        return orig(...args);
      } finally {
        panelMoves = null;
      }
    };
  }

  // artboards can't go in a group (Photoshop says so too)
  const groupLayers = C.groupLayers;
  if (groupLayers) {
    C.groupLayers = (...args) => {
      const d = doc();
      if (d?.selectedLayers.some(isArtboard)) return toast('대지는 그룹으로 묶을 수 없습니다');
      return groupLayers(...args);
    };
  }

  // ---- making artboards
  const insertArtboard = (d, ab, above = null) => {
    if (above && d.layer(above.id)) d.layers.splice(d.index(above.id) + 1, 0, ab);
    else d.layers.push(ab);
    d.activeId = ab.id;
    d.selectedIds = [ab.id];
    d.touch(ab);
    return ab;
  };
  const overlaps = (d, r, skip) => artboardsOf(d).some((l) => {
    if (l === skip) return false;
    const a = l.artboard;
    return r.x < a.x + a.w && a.x < r.x + r.w && r.y < a.y + a.h && a.y < r.y + r.h;
  });
  /** A free spot next to `ab` on one side ('right', 'left', 'top', 'bottom'). */
  const besideRect = (d, ab, side, w = ab.artboard.w, hgt = ab.artboard.h) => {
    const a = ab.artboard;
    const step = { right: [1, 0], left: [-1, 0], bottom: [0, 1], top: [0, -1] }[side];
    let r = { x: side === 'right' ? a.x + a.w + GAP : side === 'left' ? a.x - GAP - w : a.x, y: side === 'bottom' ? a.y + a.h + GAP : side === 'top' ? a.y - GAP - hgt : a.y, w, h: hgt };
    for (let i = 0; i < 50 && overlaps(d, r); i++) r = { ...r, x: r.x + step[0] * (w + GAP), y: r.y + step[1] * (hgt + GAP) };
    return r;
  };
  /** + beside an artboard: a new empty artboard of the same size (Alt: a copy with its layers). */
  C.addArtboardBeside = (ab = active(), side = 'right', copy = false) => {
    const d = doc();
    if (!d) return null;
    if (!ab) return C.newArtboard();
    const r = besideRect(d, ab, side);
    if (copy) {
      const before = d.capture();
      const top = d.history.undoStack.at(-1);
      P.selectLayer(ab.id);
      C.duplicateLayer({ noSelection: true });
      if (d.history.undoStack.at(-1) !== top) d.history.undoStack.pop();
      const dup = d.active;
      if (!isArtboard(dup)) return null;
      d.translateLayers([dup], r.x - ab.artboard.x, r.y - ab.artboard.y);
      P.commit('대지 복제', before);
      return dup;
    }
    return P.run('새 대지', () => insertArtboard(d, makeArtboard(d, r, { bg: ab.artboard.bg, color: ab.artboard.color }), ab));
  };

  /** The 대지 dialog (Layer ▸ New ▸ 대지…, 그룹에서 대지, 레이어에서 대지): name, preset, size, background. */
  const artboardDialog = (title, r0, onOk) => {
    const d = doc();
    const name = h('input', { type: 'text', value: nextName(d), style: { width: '100%' } });
    const preset = h('select', { 'aria-label': '사전 설정' }, h('option', { value: '' }, '사용자 정의'), ARTBOARD_PRESETS.map(([n], i) => h('option', { value: String(i) }, n)));
    const num = (v, label) => h('input.ph-num', { type: 'number', min: label === 'X' || label === 'Y' ? -30000 : 1, max: 30000, value: Math.round(v), 'aria-label': label });
    const x = num(r0.x, 'X');
    const y = num(r0.y, 'Y');
    const w = num(r0.w, '폭');
    const hh = num(r0.h, '높이');
    const bg = h('select', { 'aria-label': '대지 배경색' }, ARTBOARD_BGS.map(([v, n]) => h('option', { value: v }, n)));
    const color = h('input', { type: 'color', value: '#ffffff', 'aria-label': '사용자 정의 색' });
    const sync = () => { color.hidden = bg.value !== 'custom'; };
    bg.addEventListener('change', sync);
    sync();
    preset.addEventListener('change', () => {
      const p = ARTBOARD_PRESETS[+preset.value];
      if (!p || preset.value === '') return;
      w.value = p[1];
      hh.value = p[2];
    });
    for (const i of [w, hh]) i.addEventListener('input', () => { preset.value = ''; });
    openModal({
      title,
      width: '440px',
      body: [formRow('이름', name), formRow('대지를 사전 설정으로', preset), formRow('폭 (px)', w), formRow('높이 (px)', hh), formRow('X / Y (px)', x, y), formRow('대지 배경색', bg, color)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const r = { x: +x.value || 0, y: +y.value || 0, w: clamp(+w.value || 1, 1, 30000), h: clamp(+hh.value || 1, 1, 30000) };
          onOk(r, { name: name.value.trim() || nextName(d), bg: bg.value, color: color.value });
        },
      }],
    });
    setTimeout(() => name.select(), 0);
  };

  /** Layer ▸ New ▸ 대지…: next to the artboards there are (the whole canvas when there are none). */
  C.newArtboard = () => {
    const d = doc();
    if (!d) return toast('먼저 문서를 여세요');
    const list = artboardsOf(d);
    const last = active() || list[list.length - 1];
    const r0 = last ? besideRect(d, last, 'right') : { x: 0, y: 0, w: d.width, h: d.height };
    artboardDialog('새 대지', r0, (r, o) => P.run('새 대지', () => insertArtboard(d, makeArtboard(d, r, o), last)));
    return undefined;
  };
  /** The top-most selected layers (not inside another selected one), bottom → top. */
  const topSelected = (d) => d.selectedLayers.filter((l) => !d.ancestors(l).some((a) => d.selectedLayers.includes(a)));
  const unionBounds = (d, ls) => {
    const bs = ls.map((l) => (isArtboard(l) ? l.artboard : d.opaqueBounds(l) || d.bounds(l))).filter((b) => b && b.w > 0 && b.h > 0);
    if (!bs.length) return { x: 0, y: 0, w: d.width, h: d.height };
    const x0 = Math.min(...bs.map((b) => b.x));
    const y0 = Math.min(...bs.map((b) => b.y));
    return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
  };
  /** Layer ▸ New ▸ 레이어에서 대지: the selected layers in a new artboard around them. */
  C.artboardFromLayers = () => {
    const d = doc();
    if (!d?.active) return toast('대지로 만들 레이어를 고르세요');
    const items = topSelected(d).filter((l) => !isArtboard(l));
    if (!items.length) return toast('대지가 아닌 레이어를 고르세요');
    artboardDialog('레이어에서 대지', unionBounds(d, items), (r, o) => P.run('레이어에서 대지', () => {
      const ab = makeArtboard(d, r, o);
      // the artboard goes where the topmost item's top-level block is
      const top = items[items.length - 1];
      const anchor = d.ancestors(top).pop() || top;
      d.layers.splice(d.index(anchor.id) + 1, 0, ab);
      for (const it of items) d.moveBlock(it.id, d.index(ab.id), ab.id);
      d.activeId = ab.id;
      d.selectedIds = [ab.id];
      d.touch(ab);
    }));
    return undefined;
  };
  /** Layer ▸ New ▸ 그룹에서 대지: the selected group becomes an artboard. */
  C.artboardFromGroup = () => {
    const d = doc();
    const g = d?.active;
    if (g?.kind !== 'group' || isArtboard(g)) return toast('대지로 만들 그룹을 고르세요');
    artboardDialog('그룹에서 대지', unionBounds(d, [g]), (r, o) => P.run('그룹에서 대지', () => {
      if (g.parent) {
        const top = d.ancestors(g).pop();
        d.moveBlock(g.id, d.index(top.id) + 1, null);
      }
      g.name = o.name;
      g.blend = 'pass through';
      g.artboard = { ...rectOf(r), bg: o.bg, color: o.bg === 'custom' ? o.color : undefined };
      g.collapsed = false;
      d.touch(g);
    }));
    return undefined;
  };
  /** Change an artboard's rectangle or background (one undo step; `live` while typing). */
  C.setArtboard = (ab, patch, label = '대지 속성') => {
    const d = doc();
    if (!d || !isArtboard(ab)) return;
    P.run(label, () => {
      ab.artboard = { ...ab.artboard, ...patch, ...(patch.w ? { w: Math.max(1, Math.round(patch.w)) } : {}), ...(patch.h ? { h: Math.max(1, Math.round(patch.h)) } : {}) };
      ab._styled = null;
      d.touch(ab);
    });
  };

  // ---- File ▸ Export ▸ 대지를 파일로…
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
  C.artboardsToFiles = () => {
    const d = doc();
    const list = artboardsOf(d).filter((l) => l.visible);
    if (!list.length) return toast('대지가 없습니다 (레이어 ▸ 새로 만들기 ▸ 대지…)');
    const prefix = h('input', { type: 'text', value: (d.name || '대지').replace(/\.(png|jpe?g|psd|mphoto)$/i, ''), style: { width: '100%' } });
    const fmt = h('select', { 'aria-label': '파일 형식' }, h('option', { value: 'png' }, 'PNG'), h('option', { value: 'jpg' }, 'JPG'));
    const quality = h('input', { type: 'range', min: 1, max: 100, value: 90, 'aria-label': '품질' });
    const qRow = formRow('JPG 품질', quality);
    const withBg = h('input', { type: 'checkbox', checked: true });
    const onlySel = h('input', { type: 'checkbox', checked: false });
    const zip = h('input', { type: 'checkbox', checked: list.length > 1 });
    const sync = () => { qRow.hidden = fmt.value !== 'jpg'; };
    fmt.addEventListener('change', sync);
    sync();
    openModal({
      title: '대지를 파일로',
      width: '420px',
      body: [formRow('파일 이름 접두어', prefix), formRow('파일 형식', fmt), qRow, formRow('대지 배경 포함', withBg), formRow('선택한 대지만', onlySel), formRow('ZIP 하나로 묶기', zip), h('div.note', `보이는 대지 ${list.length}개를 대지마다 한 파일로 저장합니다. 대지 밖(대지 사이 빈 곳)의 레이어는 빠집니다.`)],
      buttons: [{ label: '취소' }, {
        label: '내보내기', primary: true, action: async () => {
          const sel = new Set(d.selectedLayers.map((l) => artboardOf(d, l)?.id).filter(Boolean));
          const which = onlySel.checked ? list.filter((l) => sel.has(l.id)) : list;
          if (!which.length) return toast('고른 대지가 없습니다');
          const files = [];
          for (const ab of which) {
            const c = renderArtboard(d, ab, { fg: P.fg, bg: P.bg, background: withBg.checked });
            const r = await encodeImage(c, { format: fmt.value, quality: +quality.value, transparency: true, matte: '#ffffff', meta: docMeta(d) });
            files.push({ name: `${safe(prefix.value || '대지')}_${safe(ab.name)}.${r.ext}`, blob: r.blob });
          }
          if (zip.checked && files.length > 1) {
            const IO = await import('./io.js');
            const z = await IO.zipFiles(files);
            if (await downloadBlob(z, `${safe(prefix.value || '대지')} 대지.zip`)) toast(`대지 ${files.length}개를 ZIP으로 저장했습니다`);
          } else {
            let n = 0;
            for (const f of files) if (await downloadBlob(f.blob, f.name)) n++;
            toast(`대지 ${n}개를 파일로 저장했습니다`);
          }
          return undefined;
        },
      }],
    });
    return undefined;
  };
  /** File ▸ Export ▸ Quick Export with artboards: one file per artboard. */
  P.artboardPictures = (d = doc(), { background = true } = {}) => artboardsOf(d).filter((l) => l.visible).map((ab) => ({ name: ab.name, canvas: renderArtboard(d, ab, { fg: P.fg, bg: P.bg, background }) }));
  const quick = C.quickExport;
  if (quick) {
    C.quickExport = async () => {
      const d = doc();
      if (!artboardsOf(d).length) return quick();
      const pref = quickExportPrefs();
      const base = safe((d.name || '대지').replace(/\.(png|jpe?g|gif|webp|psd|mphoto)$/i, ''));
      let n = 0;
      for (const pic of P.artboardPictures(d)) {
        const r = await encodeImage(pic.canvas, { ...pref, meta: pref.metadata ? docMeta(d) : null });
        if (await downloadBlob(r.blob, `${base}_${safe(pic.name)}.${r.ext}`)) n++;
      }
      toast(`대지 ${n}개를 ${pref.format.toUpperCase()} 파일로 저장했습니다`);
      return undefined;
    };
  }

  // ---- an opened document (PSD, .mphoto, autosave) covers its artboards
  const openDoc = P.openDoc;
  P.openDoc = (d) => {
    fitDocToArtboards(null, d);
    return openDoc(d);
  };

  // ---- New Document ▸ 대지
  const newDoc = P.newDoc;
  P.newDoc = (o = {}) => {
    if (!o.artboard) return newDoc(o);
    const d = new PhotoDoc({ ...o, background: null });
    const ab = makeArtboard(d, { x: 0, y: 0, w: d.width, h: d.height }, { name: '대지 1', ...bgFrom(o.background ?? '#ffffff') });
    const l = newLayer('raster', { name: '레이어 1', parent: ab.id, canvas: makeCanvas(d.width, d.height) });
    d.layers.push(l, ab);
    d.activeId = l.id;
    d.selectedIds = [l.id];
    return P.openDoc(d);
  };

  // ---- the Move tool: clicking an artboard's name (or its empty part) picks the artboard
  const mv = TOOL_BY_ID.move;
  const pick = mv.pick;
  mv.pick = function pickWithArtboards(E, p) {
    const lab = labelAt(E, p);
    if (lab) return lab;
    const hit = pick.call(this, E, p);
    if (hit || !artboardsOf(E.doc).length) return hit;
    return artboardAt(E.doc, p);
  };
  // an artboard has no transform box of its own (Ctrl+T transforms what is on it)
  const handlesOf = mv.handlesOf;
  mv.handlesOf = function handlesNoArtboard(E) {
    return isArtboard(E.doc?.active) ? null : handlesOf.call(this, E);
  };

  // ---- overlay: artboard outlines and names (every tool), handles and + buttons (Artboard tool)
  P.artboardOverlay = (g) => {
    const d = doc();
    const list = artboardsOf(d);
    if (!list.length || P.extrasOn === false) return;
    const cur = active();
    g.save();
    g.font = LABEL_FONT;
    g.textBaseline = 'bottom';
    for (const ab of list) {
      const a = ab.artboard;
      const [x0, y0] = P.toScreen(a.x, a.y);
      const [x1, y1] = P.toScreen(a.x + a.w, a.y + a.h);
      g.strokeStyle = ab === cur ? 'rgba(74,163,255,.9)' : 'rgba(0,0,0,.45)';
      g.lineWidth = 1;
      g.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
      g.fillStyle = ab === cur ? '#e8e8e8' : ab.visible ? '#9a9a9a' : '#666';
      g.fillText(fitLabel(g, ab.name, Math.max(40, x1 - x0)), x0, y0 - 5);
    }
    g.restore();
  };

  // ---- the Artboard tool (V)
  let hoverCursor = 'default';
  const tool = {
    id: 'artboard', name: '대지', key: 'V', icon: 'artboard', group: 'move',
    get cursor() { return hoverCursor; },
    options: [],
    /** What is under a pointer: a + button, a handle of the active artboard, a name, an artboard. */
    hit(E, p, e) {
      const d = E.doc;
      const sp = e?.clientX != null && E.logicalPoint ? E.logicalPoint(e.clientX, e.clientY) : E.toScreen(p.x, p.y);
      const cur = active();
      const touch = e?.pointerType === 'touch';
      if (cur) {
        for (const [side, [x, y]] of Object.entries(plusSpots(E, cur))) if (Math.hypot(sp[0] - x, sp[1] - y) <= (touch ? 16 : 11)) return { kind: 'plus', ab: cur, side };
        for (const [k, [x, y]] of Object.entries(handleSpots(E, cur))) if (Math.abs(sp[0] - x) <= (touch ? 14 : 6) && Math.abs(sp[1] - y) <= (touch ? 14 : 6)) return { kind: 'size', ab: cur, key: k };
      }
      const lab = labelAt(E, p, sp);
      if (lab) return { kind: 'move', ab: lab, label: true };
      const ab = artboardAt(d, p);
      return ab ? { kind: 'move', ab } : { kind: 'new' };
    },
    hover(E, p, e) {
      const t = this.hit(E, p, e);
      hoverCursor = t.kind === 'plus' ? 'pointer' : t.kind === 'size' ? SIZE_CURSOR[t.key] : t.kind === 'move' ? 'move' : 'crosshair';
    },
    down(E, p, e) {
      const d = E.doc;
      const t = this.hit(E, p, e);
      if (t.kind === 'plus') {
        C.addArtboardBeside(t.ab, t.side, !!e?.altKey);
        return;
      }
      if (t.kind === 'new') {
        this.d = { kind: 'new', a: p, r: null };
        return;
      }
      if (t.ab.locked || t.ab.lockPos) {
        E.selectLayer(t.ab.id);
        toast('위치가 잠긴 대지입니다');
        return;
      }
      // a double click on the name: rename, like Photoshop
      const now = performance.now();
      if (t.label && this.lastLabel?.id === t.ab.id && now - this.lastLabel.at < 400) {
        this.lastLabel = null;
        promptDialog('대지 이름', '새 이름', t.ab.name).then((name) => {
          if (name && name !== t.ab.name) E.run('이름 바꾸기', () => { t.ab.name = name; d.touch(t.ab); });
        });
        return;
      }
      this.lastLabel = t.label ? { id: t.ab.id, at: now } : null;
      if (t.kind === 'move' && d.activeId !== t.ab.id) E.selectLayer(t.ab.id, e?.shiftKey ? 'add' : 'single');
      this.d = { kind: t.kind, key: t.key, ab: t.ab, a: { ...p }, r0: { ...t.ab.artboard }, before: d.capture(), last: { dx: 0, dy: 0 }, moved: false };
    },
    move(E, p, e) {
      const s = this.d;
      if (!s) return;
      const d = E.doc;
      if (s.kind === 'new') {
        let w = p.x - s.a.x;
        let hh = p.y - s.a.y;
        if (e?.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(hh));
          w = Math.sign(w || 1) * m;
          hh = Math.sign(hh || 1) * m;
        }
        s.r = rectOf({ x: Math.min(s.a.x, s.a.x + w), y: Math.min(s.a.y, s.a.y + hh), w: Math.abs(w), h: Math.abs(hh) });
        E.overlay();
        return;
      }
      const dx = Math.round(p.x - s.a.x);
      const dy = Math.round(p.y - s.a.y);
      if (!s.moved && Math.hypot(dx, dy) * E.view.zoom < 3) return;
      s.moved = true;
      if (s.kind === 'move') {
        d.translateLayers([s.ab], dx - s.last.dx, dy - s.last.dy);
        s.last = { dx, dy };
      } else {
        const r = resizeRect(s.r0, s.key, dx, dy, !!e?.shiftKey, !!e?.altKey);
        s.ab.artboard = { ...s.ab.artboard, ...r };
        s.ab._styled = null;
        d.touch(s.ab);
      }
      // the document grows with the artboard; keep the drag's own points in step
      const shift = fitDocToArtboards(P, d);
      if (shift) {
        s.a = { x: s.a.x + shift.dx, y: s.a.y + shift.dy };
        s.r0 = { ...s.r0, x: s.r0.x + shift.dx, y: s.r0.y + shift.dy };
      }
      E.redraw();
    },
    up(E) {
      const s = this.d;
      this.d = null;
      if (!s) return;
      const d = E.doc;
      if (s.kind === 'new') {
        E.overlay();
        if (!s.r || s.r.w < 2 || s.r.h < 2) return;
        // drawn over another artboard's area? Photoshop draws it anyway (they may overlap)
        const above = active();
        E.run('대지 만들기', () => insertArtboard(d, makeArtboard(d, s.r, { bg: above?.artboard.bg || 'white', color: above?.artboard.color }), above));
        return;
      }
      if (s.moved) E.commit(s.kind === 'move' ? '대지 이동' : '대지 크기 조정', s.before);
    },
    cancel(E) {
      const s = this.d;
      this.d = null;
      if (s?.before) {
        E.doc.restore(s.before);
        E.afterHistory();
      } else E.overlay();
    },
    overlay(E, g) {
      const d = E.doc;
      const s = this.d;
      if (s?.kind === 'new' && s.r) {
        const [x0, y0] = E.toScreen(s.r.x, s.r.y);
        const [x1, y1] = E.toScreen(s.r.x + s.r.w, s.r.y + s.r.h);
        g.save();
        g.strokeStyle = '#4aa3ff';
        g.setLineDash([4, 3]);
        g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
        g.setLineDash([]);
        g.font = LABEL_FONT;
        g.fillStyle = '#4aa3ff';
        g.fillText(`${s.r.w} × ${s.r.h}`, x0, y1 + 14);
        g.restore();
        return;
      }
      const cur = active();
      if (!cur || !d) return;
      g.save();
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#4aa3ff';
      g.lineWidth = 1;
      for (const [x, y] of Object.values(handleSpots(E, cur))) {
        g.fillRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
        g.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
      }
      if (!s) {
        // + : a new artboard on that side (Alt: a copy)
        for (const [x, y] of Object.values(plusSpots(E, cur))) {
          g.beginPath();
          g.arc(x, y, 9, 0, Math.PI * 2);
          g.fillStyle = 'rgba(40,42,48,.9)';
          g.fill();
          g.strokeStyle = '#b8bcc6';
          g.stroke();
          g.beginPath();
          g.moveTo(x - 4.5, y);
          g.lineTo(x + 4.5, y);
          g.moveTo(x, y - 4.5);
          g.lineTo(x, y + 4.5);
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1.5;
          g.stroke();
          g.lineWidth = 1;
        }
      }
      g.restore();
    },
    deactivate() {
      this.d = null;
    },
    optionButtons(E) {
      return artboardControls(E, active(), { bar: true });
    },
  };
  TOOLS.push(tool);
  TOOL_BY_ID.artboard = tool;
  const grp = TOOL_GROUPS.find((g) => g[0] === 'move');
  if (grp && !grp.includes('artboard')) grp.push('artboard');

  /** Size presets, W / H, orientation, background (options bar and Properties panel). */
  const artboardControls = (E, ab, { bar = false } = {}) => {
    const out = [];
    const preset = h('select', { 'aria-label': '크기', title: '대지 크기 사전 설정', disabled: !ab }, h('option', { value: '' }, '사용자 정의'), ARTBOARD_PRESETS.map(([n], i) => h('option', { value: String(i) }, n)));
    if (ab) {
      const i = ARTBOARD_PRESETS.findIndex(([, w, hh]) => w === ab.artboard.w && hh === ab.artboard.h);
      preset.value = i >= 0 ? String(i) : '';
    }
    preset.addEventListener('change', () => {
      const p = ARTBOARD_PRESETS[+preset.value];
      if (ab && p && preset.value !== '') C.setArtboard(ab, { w: p[1], h: p[2] }, '대지 크기');
    });
    const num = (key, label) => {
      const inp = h('input.ph-num', { type: 'number', min: key === 'x' || key === 'y' ? -30000 : 1, max: 30000, value: ab ? ab.artboard[key] : '', disabled: !ab, 'aria-label': label });
      inp.addEventListener('change', () => {
        const v = Math.round(+inp.value);
        if (ab && Number.isFinite(v) && v !== ab.artboard[key]) {
          if (key === 'x' || key === 'y') {
            P.run('대지 이동', () => doc().translateLayers([ab], key === 'x' ? v - ab.artboard.x : 0, key === 'y' ? v - ab.artboard.y : 0));
          } else C.setArtboard(ab, { [key]: clamp(v, 1, 30000) }, '대지 크기');
        }
      });
      return h('label.ph-opt', h('span', label), inp);
    };
    const swap = (want) => {
      if (!ab) return;
      const { w, h: hh } = ab.artboard;
      if ((want === 'landscape') === w > hh || w === hh) return;
      C.setArtboard(ab, { w: hh, h: w }, '대지 방향');
    };
    const portrait = ab && ab.artboard.h >= ab.artboard.w;
    out.push(h('label.ph-opt', h('span', '크기'), preset), num('w', '폭'), num('h', '높이'),
      h('span.ph-opt', h('span', '방향'),
        h(`button.small.ph-tog${portrait ? '.on' : ''}`, { title: '세로', 'aria-label': '세로', disabled: !ab, onclick: () => swap('portrait') }, '세로'),
        h(`button.small.ph-tog${ab && !portrait ? '.on' : ''}`, { title: '가로', 'aria-label': '가로', disabled: !ab, onclick: () => swap('landscape') }, '가로')));
    if (!bar) out.push(num('x', 'X'), num('y', 'Y'));
    const bg = h('select', { 'aria-label': '대지 배경색', disabled: !ab }, ARTBOARD_BGS.map(([v, n]) => h('option', { value: v }, n)));
    const color = h('input', { type: 'color', 'aria-label': '사용자 정의 색', value: ab?.artboard.color || '#ffffff', disabled: !ab });
    if (ab) bg.value = ab.artboard.bg || 'white';
    color.hidden = bg.value !== 'custom';
    bg.addEventListener('change', () => ab && C.setArtboard(ab, { bg: bg.value, color: bg.value === 'custom' ? color.value : ab.artboard.color }, '대지 배경색'));
    color.addEventListener('change', () => ab && C.setArtboard(ab, { bg: 'custom', color: color.value }, '대지 배경색'));
    if (!bar) out.push(h('label.ph-opt', h('span', '대지 배경색'), bg, color));
    if (bar) out.push(h('button.small', { title: '지금 대지 옆에 같은 크기의 새 대지를 만듭니다', onclick: () => C.addArtboardBeside(ab, 'right') }, '새 대지 추가'));
    return out;
  };
  P.artboardProps = (ab) => [h('div.ph-sub', '대지'), h('div.ph-prow', { style: { flexWrap: 'wrap', gap: '6px' } }, ...artboardControls(P, ab))];

  // ---- menus
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['레이어'];
    if (!orig) return;
    P.menus['레이어'] = () => {
      const items = orig();
      const nw = items.find((x) => x && typeof x === 'object' && /^새로 만들기/.test(x.label || '') && Array.isArray(x.submenu));
      if (nw) {
        const d = doc();
        const at = nw.submenu.findIndex((x) => x && /^레이어에서 그룹/.test(x.label || ''));
        nw.submenu.splice(at >= 0 ? at + 1 : nw.submenu.length, 0,
          { label: '대지…', disabled: !d, action: () => C.newArtboard() },
          { label: '그룹에서 대지…', disabled: !d || d.active?.kind !== 'group' || isArtboard(d.active), action: () => C.artboardFromGroup() },
          { label: '레이어에서 대지…', disabled: !d?.active || isArtboard(d.active), action: () => C.artboardFromLayers() });
      }
      return items;
    };
  }];
}

// ---------------------------------------------------------------- overlay geometry

const LABEL_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const SIZE_CURSOR = { c0: 'nwse-resize', c2: 'nwse-resize', c1: 'nesw-resize', c3: 'nesw-resize', e0: 'ns-resize', e2: 'ns-resize', e1: 'ew-resize', e3: 'ew-resize' };
let measure = null;
function fitLabel(g, s, max) {
  if (g.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
/** The artboard whose name label is under a point (screen space `sp`, or from the document point). */
function labelAt(E, p, sp = null) {
  const list = artboardsOf(E.doc);
  if (!list.length) return null;
  const [sx, sy] = sp || E.toScreen(p.x, p.y);
  if (!measure) measure = makeCanvas(1, 1).getContext('2d');
  measure.font = LABEL_FONT;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i].artboard;
    const [x0, y0] = E.toScreen(a.x, a.y);
    const [x1] = E.toScreen(a.x + a.w, a.y);
    const w = Math.min(measure.measureText(list[i].name).width, Math.max(40, x1 - x0));
    if (sx >= x0 - 2 && sx <= x0 + w + 4 && sy >= y0 - 20 && sy <= y0 - 1) return list[i];
  }
  return null;
}
function handleSpots(E, ab) {
  const a = ab.artboard;
  const [x0, y0] = E.toScreen(a.x, a.y);
  const [x1, y1] = E.toScreen(a.x + a.w, a.y + a.h);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return { c0: [x0, y0], c1: [x1, y0], c2: [x1, y1], c3: [x0, y1], e0: [mx, y0], e1: [x1, my], e2: [mx, y1], e3: [x0, my] };
}
function plusSpots(E, ab) {
  const a = ab.artboard;
  const [x0, y0] = E.toScreen(a.x, a.y);
  const [x1, y1] = E.toScreen(a.x + a.w, a.y + a.h);
  const off = 22;
  return { top: [(x0 + x1) / 2, y0 - off], right: [x1 + off, (y0 + y1) / 2], bottom: [(x0 + x1) / 2, y1 + off], left: [x0 - off, (y0 + y1) / 2] };
}
/** A rectangle resized by a handle (c0..c3 corners, e0..e3 edges); Shift keeps the shape, Alt from the centre. */
function resizeRect(r, key, dx, dy, keep, centre) {
  let { x, y, w, h: hh } = r;
  const left = key === 'c0' || key === 'c3' || key === 'e3';
  const right = key === 'c1' || key === 'c2' || key === 'e1';
  const top = key === 'c0' || key === 'c1' || key === 'e0';
  const bottom = key === 'c2' || key === 'c3' || key === 'e2';
  const k = centre ? 2 : 1;
  if (right) w = r.w + dx * k;
  if (left) w = r.w - dx * k;
  if (bottom) hh = r.h + dy * k;
  if (top) hh = r.h - dy * k;
  if (keep && (left || right) && (top || bottom)) {
    const s = Math.max(w / r.w, hh / r.h);
    w = r.w * s;
    hh = r.h * s;
  }
  w = Math.max(1, Math.round(w));
  hh = Math.max(1, Math.round(hh));
  if (centre) {
    x = Math.round(r.x + (r.w - w) / 2);
    y = Math.round(r.y + (r.h - hh) / 2);
  } else {
    if (left) x = r.x + r.w - w;
    if (top) y = r.y + r.h - hh;
  }
  return { x, y, w, h: hh };
}

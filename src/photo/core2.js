// Photo editor core extras: Window ▸ Workspace and Window ▸ Arrange (tabs or two documents side
// by side), copying layers between documents (drag a layer from the Layers panel onto another
// document's tab or canvas, or drag with the Move tool onto a tab like Photoshop), File ▸ Save As /
// Save a Copy / Close All, the New Layer dialog (Ctrl+Shift+N), Image ▸ Trim, Edit ▸ Toggle Last
// State, the keyboard shortcuts list (Ctrl+Alt+Shift+K), the Window menu and the last arrangement
// pass that puts items other modules added where Photoshop has them.

import { h, clamp, downloadBlob } from '../util.js';
import { toast, openModal, formRow, confirmDialog, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { newLayer, makeCanvas, LAYER_COLORS } from './doc.js';
import { TOOLS } from './tools.js';
import { cloneLayer } from './layercmds.js';
import { blendSelect } from './panels.js';
import { blendName } from './blend.js';
import * as IO from './io.js';

const isMobile = () => document.body.classList.contains('mobile');

/** Window ▸ Workspace presets: which panels sit in the upper and the layers column, in what order. */
const WORKSPACES = [
  ['essentials', '필수 (기본값)', { top: ['color', 'swatches', 'gradients', 'patterns', 'props', 'adjustments', 'ai', 'char', 'para', 'glyphs', 'history', 'presets', 'nav', 'info', 'histo'], layers: ['layers', 'channels', 'paths', 'timeline', 'actions', 'comps'], showTop: 'color', showLayers: 'layers' }],
  ['photo', '사진', { top: ['histo', 'nav', 'props', 'adjustments', 'info', 'history', 'color', 'swatches', 'ai'], layers: ['layers', 'channels', 'paths', 'actions', 'comps', 'timeline'], showTop: 'histo', showLayers: 'layers' }],
  ['painting', '페인팅', { top: ['brushSettings', 'brushes', 'color', 'swatches', 'presets', 'history', 'nav', 'props'], layers: ['layers', 'channels', 'paths', 'actions'], showTop: 'brushSettings', showLayers: 'layers' }],
  ['graphic', '그래픽 및 웹', { top: ['char', 'para', 'glyphs', 'charStyles', 'paraStyles', 'props', 'shapes', 'styles', 'color', 'swatches', 'info'], layers: ['layers', 'comps', 'paths', 'channels', 'actions'], showTop: 'char', showLayers: 'layers' }],
  ['motion', '동작', { top: ['timeline', 'props', 'color', 'swatches', 'char', 'history'], layers: ['layers', 'channels', 'paths', 'actions', 'comps'], showTop: 'timeline', showLayers: 'layers' }],
];

/** Neutral colours for the New Layer dialog's "fill with … neutral colour" (dodge and burn layers). */
const NEUTRAL = {
  overlay: '#808080', 'soft light': '#808080', 'hard light': '#808080', 'vivid light': '#808080', 'linear light': '#808080', 'pin light': '#808080', 'hard mix': '#808080',
  screen: '#000000', 'color dodge': '#000000', 'linear dodge': '#000000', lighten: '#000000', difference: '#000000', exclusion: '#000000', subtract: '#000000',
  multiply: '#ffffff', 'color burn': '#ffffff', 'linear burn': '#ffffff', darken: '#ffffff', divide: '#ffffff',
};

const CSS = `
.ph-tab.ph-tab-drop { background: var(--accent-soft, #2b4a6e); color: var(--text); box-shadow: inset 0 0 0 2px var(--accent, #4aa3ff); }
.ph-stage.ph-stage-drop, .ph-pane2.ph-stage-drop { box-shadow: inset 0 0 0 3px var(--accent, #4aa3ff); }
.ph-split { flex: 1; min-height: 0; display: flex; gap: 2px; background: var(--line, #333); }
.ph-split > .ph-stage { flex: 1 1 0; min-width: 0; }
.ph-pane2 { flex: 1 1 0; min-width: 0; position: relative; overflow: hidden; background: #1f2125; cursor: pointer; }
.ph-pane2 canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ph-pane2-label { position: absolute; left: 8px; top: 6px; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,.55); color: #fff; font-size: 12px; pointer-events: none; max-width: calc(100% - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-pane2-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-dim, #aaa); font-size: 13px; padding: 16px; text-align: center; pointer-events: none; }
.ph-keys { display: flex; flex-direction: column; gap: 8px; }
.ph-keys input[type=search] { width: 100%; }
.ph-keys-list { max-height: 60vh; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content); gap: 3px 16px; align-content: start; font-size: 13px; }
.ph-keys-list .ph-keys-h { grid-column: 1 / -1; margin-top: 8px; font-weight: 600; color: var(--text, #eee); border-bottom: 1px solid var(--line, #333); padding-bottom: 2px; }
.ph-keys-list .k { font-family: ui-monospace, monospace; color: var(--text-dim, #bbb); text-align: right; max-width: 260px; }
.ph-prefsec.ph-prefsec-on .ph-sub { color: var(--accent, #4aa3ff); }
.ph-act-step.on { background: var(--accent-soft, #2b4a6e); border-radius: 4px; }
.ph-act-step.stop span { color: var(--warn, #e0b050); }
`;

export function installCore2(P, ui) {
  const C = P.cmd;
  document.head.append(h('style', CSS));

  // ---------------------------------------------------------------- workspaces

  // where each panel lives by default (modules add theirs with P.addPanel)
  const home = {};
  for (const id of ui.groupsTop.ids) home[id] = 'top';
  for (const id of ui.groupLayers.ids) home[id] = 'layers';
  const addPanel = P.addPanel;
  P.addPanel = (id, title, el, where = 'top') => {
    home[id] = where === 'layers' ? 'layers' : 'top';
    addPanel(id, title, el, where);
  };
  let workspace = loadPref('photo.workspace', 'essentials');
  /** Window ▸ Workspace: arrange the panels like the preset (`reset`: also the tabs shown). */
  P.setWorkspace = (id, { quiet = false } = {}) => {
    const ws = WORKSPACES.find((w) => w[0] === id);
    if (!ws) return;
    const { top, layers, showTop, showLayers } = ws[2];
    const all = Object.keys(ui.panels);
    const topIds = top.filter((x) => ui.panels[x]);
    const layerIds = layers.filter((x) => ui.panels[x] && !topIds.includes(x));
    // panels the preset doesn't mention stay in their usual column, after the preset's ones
    for (const x of all) {
      if (topIds.includes(x) || layerIds.includes(x)) continue;
      (home[x] === 'layers' ? layerIds : topIds).push(x);
    }
    ui.groupsTop.set(topIds, showTop);
    ui.groupLayers.set(layerIds, showLayers);
    workspace = id;
    savePref('photo.workspace', id);
    document.body.classList.remove('ph-hide-panels', 'ph-hide-side');
    if (!quiet) toast(`작업 영역: ${ws[1]}`);
  };
  if (workspace !== 'essentials' && !isMobile()) setTimeout(() => P.setWorkspace(workspace, { quiet: true }), 0);

  // ---------------------------------------------------------------- copying layers between documents

  /** The box (source doc coords) around what is copied. */
  const boxOf = (src, layers) => {
    let box = null;
    for (const l of layers) {
      const b = l.kind === 'adjust' || l.kind === 'fill' ? null : l.kind === 'group' ? src.bounds(l) : src.opaqueBounds(l);
      if (!b || !(b.w > 0 && b.h > 0)) continue;
      box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), x1: Math.max(box.x1, b.x + b.w), y1: Math.max(box.y1, b.y + b.h) } : { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h };
    }
    return box ? { x: box.x, y: box.y, w: box.x1 - box.x, h: box.y1 - box.y } : { x: 0, y: 0, w: src.width, h: src.height };
  };
  /**
   * Copy layers into another document, as one undoable step there. `what`: { ids } (layers with their
   * groups' contents) or { canvas, x, y } (pixels, e.g. a dragged selection). Placement: `same`
   * keeps the position (when the documents are the same size), `at` (a point in the target) with
   * `grab` (the point in the source that was held) keeps it under the pointer, else centred.
   */
  P.copyLayersToDoc = (src, what, dst, { at = null, grab = null, same = false } = {}) => {
    if (!src || !dst || !P.docs.includes(dst)) return null;
    let tops;
    let box;
    if (what.canvas) {
      const l = newLayer('raster', { name: `레이어 ${dst.layers.length + 1}`, canvas: what.canvas, x: what.x, y: what.y });
      tops = [[l]];
      box = { x: what.x, y: what.y, w: what.canvas.width, h: what.canvas.height };
    } else {
      const pick = new Set(what.ids || []);
      // a layer inside a picked group comes along with the group
      const layers = src.layers.filter((l) => pick.has(l.id) && !src.ancestors(l).some((a) => pick.has(a.id)));
      if (!layers.length) return null;
      box = boxOf(src, layers);
      // linked layers stay linked to each other, not to earlier copies already over there
      const links = new Map();
      const block = (l, parent) => {
        const c = cloneLayer(l, { parent });
        if (c.linkId) {
          if (!links.has(c.linkId)) links.set(c.linkId, `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
          c.linkId = links.get(c.linkId);
        }
        const out = [];
        if (l.kind === 'group') for (const k of src.children(l.id)) out.push(...block(k, c.id));
        out.push(c);
        return out;
      };
      tops = layers.map((l, i) => {
        const blk = block(l, null);
        const top = blk[blk.length - 1];
        // clipped onto a layer that doesn't come along: not clipped over there
        if (top.clip && (i === 0 || src.layers[src.block(l.id)[0] - 1] !== layers[i - 1])) top.clip = false;
        top.locked = false;
        top.lockPos = false;
        return blk;
      });
    }
    let dx;
    let dy;
    if (same && src.width === dst.width && src.height === dst.height) {
      dx = 0;
      dy = 0;
    } else if (at && !same) {
      const ox = grab ? grab.x - box.x : box.w / 2;
      const oy = grab ? grab.y - box.y : box.h / 2;
      dx = Math.round(at.x - ox - box.x);
      dy = Math.round(at.y - oy - box.y);
    } else {
      dx = Math.round((dst.width - box.w) / 2 - box.x);
      dy = Math.round((dst.height - box.h) / 2 - box.y);
    }
    const before = dst.capture();
    // above the target's picked layer (at the top level)
    const a = dst.active;
    const ref = a ? [a, ...dst.ancestors(a)].pop() : null;
    let index = ref ? dst.index(ref.id) + 1 : dst.layers.length;
    for (const blk of tops) {
      dst.layers.splice(index, 0, ...blk);
      index += blk.length;
    }
    const made = tops.map((blk) => blk[blk.length - 1]);
    if (dx || dy) dst.translateLayers(made, dx, dy);
    for (const blk of tops) for (const l of blk) dst.touch(l);
    dst.activeId = made[made.length - 1].id;
    dst.selectedIds = made.map((l) => l.id);
    dst.rev++;
    const label = made.length > 1 ? `레이어 ${made.length}개 복사해 오기` : `레이어 복사해 오기: ${made[0].name}`;
    if (dst === P.doc) P.commit(label, before);
    else {
      dst.history.push(label, before);
      dst.saved = false;
      P.switchDoc(P.docs.indexOf(dst));
    }
    toast(`"${src.name}"에서 ${made.length > 1 ? `레이어 ${made.length}개` : `"${made[0].name}"`}를 복사해 왔습니다`);
    return made;
  };
  const docById = (id) => P.docs.find((d) => d.id === id) || null;

  // --- the Layers panel's rows dragged onto a tab, the canvas or the other document's pane
  const layerDragOk = (e, target) => {
    const ld = P.layerDrag;
    if (!ld || !target || ld.doc === target || !P.docs.includes(ld.doc)) return false;
    // files from the computer are not layers
    return ![...(e.dataTransfer?.types || [])].includes('Files');
  };
  const takeLayerDrag = () => {
    const ld = P.layerDrag;
    P.layerDrag = null;
    return ld;
  };
  // the drag is over when it is dropped anywhere or ends (the dragged row may be gone by then)
  for (const ev of ['drop', 'dragend']) document.addEventListener(ev, () => setTimeout(() => { P.layerDrag = null; }, 0), true);
  window.addEventListener('pointerdown', () => { P.layerDrag = null; }, true);

  P.decorateTab = (el, d) => {
    let timer = 0;
    const leave = () => {
      el.classList.remove('ph-tab-drop');
      clearTimeout(timer);
      timer = 0;
    };
    el.addEventListener('dragover', (e) => {
      if (!layerDragOk(e, d)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('ph-tab-drop');
      // held over the tab: that document comes up, so the layer can be dropped on its canvas
      if (!timer && P.doc !== d) timer = setTimeout(() => { timer = 0; if (P.layerDrag && P.doc !== d && P.docs.includes(d)) P.switchDoc(P.docs.indexOf(d)); }, 600);
    });
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', (e) => {
      if (!layerDragOk(e, d)) return;
      e.preventDefault();
      e.stopPropagation();
      leave();
      const ld = takeLayerDrag();
      P.copyLayersToDoc(ld.doc, { ids: ld.ids }, d, { same: e.shiftKey });
    });
  };
  const dropZone = (el, target, toDoc) => {
    el.addEventListener('dragover', (e) => {
      const d = target();
      if (!layerDragOk(e, d)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('ph-stage-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('ph-stage-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('ph-stage-drop');
      const d = target();
      if (!layerDragOk(e, d)) return;
      e.preventDefault();
      e.stopPropagation();
      const ld = takeLayerDrag();
      P.copyLayersToDoc(ld.doc, { ids: ld.ids }, d, { at: toDoc(e), same: e.shiftKey });
    });
  };
  dropZone(ui.stage, () => P.doc, (e) => P.toDoc(e.clientX, e.clientY));
  // dropped on the layers list of the document that came up: copied in too
  ui.side.addEventListener('dragover', (e) => {
    if (!layerDragOk(e, P.doc) || !e.target.closest?.('.ph-layers, .ph-llist, .ph-layer')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, true);
  ui.side.addEventListener('drop', (e) => {
    if (!layerDragOk(e, P.doc) || !e.target.closest?.('.ph-layers, .ph-llist, .ph-layer')) return;
    e.preventDefault();
    e.stopPropagation();
    const ld = takeLayerDrag();
    P.copyLayersToDoc(ld.doc, { ids: ld.ids }, P.doc, {});
  }, true);

  // --- the Move tool dragged onto another document's tab (or the other pane): Photoshop's way
  let xd = null;
  const docAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tab = el?.closest?.('.ph-tab');
    if (tab) return docById(tab.dataset.doc);
    if (el?.closest?.('.ph-pane2')) return pane.doc();
    return null;
  };
  const overStage = (e) => {
    const r = ui.stage.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  };
  P.xdragStart = (e) => {
    if (P.docs.length < 2) return false;
    const target = docAt(e);
    if (!target || target === P.doc) return false;
    const t = TOOLS.find((x) => x.id === 'move');
    const d = t?.d;
    if (!d) return false;
    const src = P.doc;
    const what = d.float ? { canvas: d.float.canvas, x: d.float.x, y: d.float.y } : { ids: (d.moving || src.selectedLayers).map((l) => l.id) };
    // the drag doesn't move anything here: back to how it was
    t.cancel(P);
    xd = { src, what, grab: d.a, over: null, timer: 0 };
    P.xdragMove(e);
    return true;
  };
  P.xdragMove = (e) => {
    if (!xd) return;
    const target = docAt(e);
    if (target && target !== P.doc && target !== xd.over) {
      clearTimeout(xd.timer);
      xd.over = target;
      // held over a tab for a moment: that document comes up and the layer can be dropped on it
      if (!e.target?.closest?.('.ph-pane2')) xd.timer = setTimeout(() => { if (xd?.over === target && P.docs.includes(target)) P.switchDoc(P.docs.indexOf(target)); }, 500);
    } else if (!target) {
      clearTimeout(xd.timer);
      xd.over = null;
    }
    document.querySelectorAll('.ph-tab').forEach((t) => t.classList.toggle('ph-tab-drop', !!target && t.dataset.doc === target.id && target !== xd.src));
    ui.stage.style.cursor = 'copy';
  };
  P.xdragDrop = (e) => {
    const s = xd;
    P.xdragCancel();
    if (!s || !P.docs.includes(s.src)) return;
    const target = docAt(e);
    let dst = null;
    let at = null;
    if (target && target !== s.src) {
      dst = target;
      at = e.target?.closest?.('.ph-pane2') || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ph-pane2') ? pane.toDoc(e) : null;
    } else if (overStage(e) && P.doc !== s.src) {
      dst = P.doc;
      at = P.toDoc(e.clientX, e.clientY);
    }
    if (!dst) return;
    P.copyLayersToDoc(s.src, s.what, dst, { at, grab: at ? s.grab : null, same: e.shiftKey });
  };
  P.xdragCancel = () => {
    if (xd) clearTimeout(xd.timer);
    xd = null;
    document.querySelectorAll('.ph-tab.ph-tab-drop').forEach((t) => t.classList.remove('ph-tab-drop'));
  };

  // ---------------------------------------------------------------- Window ▸ Arrange: two up

  let arrange = 'tabs';
  let otherId = null;
  let lastId = null;
  const pane = (() => {
    const cv = h('canvas');
    const label = h('div.ph-pane2-label');
    const empty = h('div.ph-pane2-empty', '다른 문서를 열면 여기에 나란히 보입니다');
    const el = h('div.ph-pane2', { title: '누르면 이 문서를 편집합니다 · 레이어를 여기로 끌어 놓으면 이 문서로 복사됩니다' }, cv, label, empty);
    let cache = { key: '', canvas: null };
    let raf = 0;
    const doc = () => {
      const d = docById(otherId);
      if (d && d !== P.doc) return d;
      return P.docs.find((x) => x !== P.doc) || null;
    };
    const geom = (d) => {
      const r = el.getBoundingClientRect();
      const pad = 12;
      const z = Math.min(1, (r.width - pad * 2) / d.width, (r.height - pad * 2) / d.height);
      return { r, z, x: (r.width - d.width * z) / 2, y: (r.height - d.height * z) / 2 };
    };
    const render = () => {
      raf = 0;
      if (arrange !== '2up' || !el.isConnected) return;
      const d = doc();
      const dpr = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      const g = cv.getContext('2d');
      g.fillStyle = P.prefs.pasteboard || '#1f2125';
      g.fillRect(0, 0, cv.width, cv.height);
      empty.hidden = !!d;
      label.hidden = !d;
      if (!d) return;
      label.textContent = `${d.name} · ${d.width}×${d.height}`;
      const key = `${d.id}|${d.rev}|${d.layers.length}`;
      if (cache.key !== key) {
        const c = makeCanvas(d.width, d.height);
        d.render(c.getContext('2d'), { fg: P.fg, bg: P.bg });
        cache = { key, canvas: c };
      }
      const { z, x, y } = geom(d);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // transparency grid under the picture
      g.fillStyle = '#fff';
      g.fillRect(x, y, d.width * z, d.height * z);
      g.fillStyle = '#ccc';
      const cs = 8;
      g.save();
      g.beginPath();
      g.rect(x, y, d.width * z, d.height * z);
      g.clip();
      for (let yy = 0; yy < d.height * z; yy += cs) for (let xx = (Math.floor(yy / cs) % 2) * cs; xx < d.width * z; xx += cs * 2) g.fillRect(x + xx, y + yy, cs, cs);
      g.restore();
      g.imageSmoothingQuality = 'high';
      g.drawImage(cache.canvas, x, y, d.width * z, d.height * z);
      g.strokeStyle = 'rgba(0,0,0,.5)';
      g.strokeRect(x - 0.5, y - 0.5, d.width * z + 1, d.height * z + 1);
    };
    const schedule = () => {
      if (!raf && arrange === '2up') raf = requestAnimationFrame(render);
    };
    el.addEventListener('click', () => {
      const d = doc();
      if (d) P.switchDoc(P.docs.indexOf(d));
    });
    new ResizeObserver(schedule).observe(el);
    return {
      el, doc, schedule,
      toDoc: (e) => {
        const d = doc();
        const { r, z, x, y } = geom(d);
        return { x: (e.clientX - r.left - x) / z, y: (e.clientY - r.top - y) / z };
      },
    };
  })();
  dropZone(pane.el, () => pane.doc(), (e) => pane.toDoc(e));
  const split = h('div.ph-split');
  P.on('doc', () => {
    // the document that was active before is the one shown beside it
    const cur = P.doc?.id || null;
    if (cur !== lastId) {
      if (lastId && docById(lastId)) otherId = lastId;
      lastId = cur;
    }
    pane.schedule();
  });
  for (const ev of ['history', 'layers', 'tabs']) P.on(ev, pane.schedule);
  /** Window ▸ Arrange: 'tabs' (one document at a time) or '2up' (two side by side). */
  P.setArrange = (mode) => {
    if (mode === arrange) return;
    arrange = mode;
    if (mode === '2up') {
      split.replaceChildren(ui.stage, pane.el);
      ui.center.append(split);
      if (P.docs.length < 2) toast('문서를 하나 더 열면 나란히 보입니다');
      else toast('두 문서를 나란히 봅니다. 레이어를 오른쪽 문서로 끌어 놓거나, 이동 도구로 끌어다 놓으면 복사됩니다.');
    } else {
      ui.center.append(ui.stage);
      split.remove();
    }
    savePref('photo.arrange', mode);
    pane.schedule();
    P.redraw();
  };
  if (loadPref('photo.arrange', 'tabs') === '2up' && !isMobile()) setTimeout(() => P.setArrange('2up'), 0);

  // ---------------------------------------------------------------- File

  /** File ▸ Save As (Ctrl+Shift+S) / Save a Copy (Ctrl+Alt+S): pick a name and a format. */
  const saveDialog = (copy) => {
    const d = P.doc;
    if (!d) return toast('저장할 문서가 없습니다');
    const name = h('input', { type: 'text', value: copy ? `${d.name} 사본` : d.name, style: { width: '240px' } });
    const FORMATS = [['mphoto', 'Montage 사진 (.mphoto) — 레이어 그대로'], ['psd', 'Photoshop (.psd)'], ['psdText', 'Photoshop (.psd) — 글자·모양 편집 가능 (실험적)'], ['png', 'PNG (.png)'], ['jpg', 'JPEG (.jpg)'], ['webp', 'WebP (.webp)']];
    const fmt = h('select', FORMATS.map(([v, t]) => h('option', { value: v }, t)));
    fmt.value = loadPref('photo.saveFormat', 'mphoto');
    const q = h('input', { type: 'number', min: 10, max: 100, value: 92, style: { width: '70px' } });
    const qRow = formRow('화질 (%)', q);
    const note = h('div.note');
    const sync = () => {
      const flat = ['png', 'jpg', 'webp'].includes(fmt.value);
      qRow.hidden = fmt.value === 'png' || !flat;
      note.textContent = flat ? '레이어를 하나로 합친 그림을 저장합니다 (사본으로 저장되고, 문서는 그대로 열려 있어요).' : copy ? '지금 문서는 그대로 두고 사본 파일만 만듭니다.' : '문서 이름이 바뀌고, 이 파일로 저장한 것으로 표시됩니다.';
    };
    fmt.addEventListener('change', sync);
    sync();
    openModal({
      title: copy ? '사본 저장' : '다른 이름으로 저장',
      width: '460px',
      body: [formRow('파일 이름', name), formRow('형식', fmt), qRow, note],
      buttons: [{ label: '취소' }, {
        label: '저장', primary: true, action: async () => {
          const nm = (name.value.trim() || d.name).replace(/[\\/:*?"<>|]+/g, '_');
          const f = fmt.value;
          savePref('photo.saveFormat', f);
          try {
            let blob;
            let ext = f;
            if (f === 'mphoto') blob = new Blob([JSON.stringify(await IO.docToProject(d))], { type: 'application/json' });
            else if (f === 'psd' || f === 'psdText') {
              blob = IO.docToPsd(d, { editableText: f === 'psdText', fg: P.fg, bg: P.bg }).blob;
              ext = 'psd';
            } else blob = await IO.exportBlob(d, f, clamp(+q.value || 92, 10, 100) / 100, 1, { fg: P.fg, bg: P.bg });
            if (!(await downloadBlob(blob, `${nm}.${ext}`))) return undefined;
            const layered = f === 'mphoto' || ext === 'psd';
            if (!copy && layered) {
              d.name = nm;
              d.saved = true;
              d.openState = d.capture();
              P.renderTabs();
              P.emit('doc');
              P.emit('docsaved', d);
            }
            toast(`${nm}.${ext} 저장${copy || !layered ? ' (사본)' : ''}`);
          } catch (err) {
            console.error(err);
            toast(`저장하지 못했습니다: ${err.message || err}`);
          }
          return undefined;
        },
      }],
    });
    return undefined;
  };
  C.saveAs = () => saveDialog(false);
  C.saveCopy = () => saveDialog(true);
  /** File ▸ Close All (Ctrl+Alt+W) and Close Others. */
  const closeMany = async (keep = null) => {
    const list = P.docs.filter((d) => d !== keep);
    if (!list.length) return;
    const unsaved = list.filter((d) => !d.saved).length;
    if (unsaved && !(await confirmDialog(keep ? '기타 항목 닫기' : '모두 닫기', `저장하지 않은 문서 ${unsaved}개가 있습니다. 그래도 ${list.length}개를 모두 닫을까요?`))) return;
    for (const d of list) {
      d.saved = true;
      const i = P.docs.indexOf(d);
      if (i >= 0) await P.closeDoc(i);
    }
  };
  C.closeAll = () => closeMany(null);
  C.closeOthers = () => (P.doc ? closeMany(P.doc) : undefined);
  // History Options ▸ automatically create a new snapshot when saving
  P.on('docsaved', (d) => {
    if (!P.prefs.snapOnSave || d !== P.doc || !P.newSnapshot) return;
    const t = new Date();
    P.newSnapshot(`저장 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`);
  });

  // ---------------------------------------------------------------- Edit, Layer, Image, Select

  /** Edit ▸ Toggle Last State (Ctrl+Alt+Z). */
  C.toggleLastState = () => {
    const d = P.doc;
    if (!d) return;
    if (P.transform) return void P.cancelTransform();
    if (P.finishText?.()) return;
    const l = d.history.toggleLast();
    if (l) toast(`마지막 상태 전환: ${l}`);
    P.afterHistory();
  };
  /** Layer ▸ Hide Layers (Ctrl+,): the picked layers show / hide. */
  C.toggleLayerVisibility = () => {
    const d = P.doc;
    if (!d?.active) return;
    const ls = d.selectedLayers;
    const show = ls.every((l) => !l.visible);
    P.run(show ? '레이어 보이기' : '레이어 숨기기', () => {
      for (const l of ls) {
        l.visible = show;
        d.touch(l);
      }
    });
  };
  /** Window ▸ Brush Settings (F5): the brush tool's settings. */
  C.brushSettings = () => {
    if (ui.panels.brushSettings) return void P.showPanel('brushSettings');
    if (P.brushSettings) return void P.brushSettings();
    const find = () => [...document.querySelectorAll('.ph-opts button, .ph-opts-bar button')].find((b) => b.textContent.startsWith('브러시 설정'));
    const b = find();
    if (b) return void b.click();
    P.setTool('brush');
    setTimeout(() => find()?.click(), 30);
  };
  /** Layer ▸ New ▸ Layer… with options (what the New Layer dialog creates; recorded by actions). */
  C.newLayerOpts = (o = {}) => {
    const d = P.doc;
    if (!d) return;
    P.run('새 레이어', () => {
      const c = makeCanvas(d.width, d.height);
      if (o.neutral) {
        const g = c.getContext('2d');
        g.fillStyle = o.neutral;
        g.fillRect(0, 0, c.width, c.height);
      }
      const l = newLayer('raster', { name: o.name || `레이어 ${d.layers.length + 1}`, canvas: c, blend: o.blend || 'normal', opacity: clamp((o.opacity ?? 100) / 100, 0, 1), color: o.color || 'none' });
      P.addLayer(l);
      // Use Previous Layer to Create Clipping Mask
      if (o.clip && d.index(l.id) > 0) l.clip = true;
      d.touch(l);
    });
  };
  /** Ctrl+Shift+N: the New Layer dialog (name, clipping, colour, mode, opacity, neutral fill). */
  C.newLayerDialog = () => {
    const d = P.doc;
    if (!d) return toast('먼저 문서를 열거나 새로 만드세요');
    const name = h('input', { type: 'text', value: `레이어 ${d.layers.length + 1}`, style: { width: '240px' } });
    const clip = h('input', { type: 'checkbox' });
    const color = h('select', LAYER_COLORS.map(([id, n]) => h('option', { value: id }, n)));
    const mode = blendSelect(false);
    mode.value = 'normal';
    const op = h('input', { type: 'number', min: 0, max: 100, value: 100, style: { width: '70px' } });
    const neutral = h('input', { type: 'checkbox' });
    const nText = h('span');
    const nRow = h('label.ph-prow', neutral, nText);
    const sync = () => {
      const c = NEUTRAL[mode.value];
      nRow.hidden = !c;
      if (c) nText.textContent = ` ${blendName(mode.value)} 중간색으로 칠하기 (${c === '#808080' ? '50% 회색' : c === '#000000' ? '검정' : '흰색'})`;
    };
    mode.addEventListener('change', sync);
    sync();
    openModal({
      title: '새 레이어',
      width: '440px',
      body: [
        formRow('이름', name),
        h('label.ph-prow', clip, h('span', ' 이전 레이어를 사용하여 클리핑 마스크 만들기')),
        formRow('색상', color),
        formRow('모드', mode),
        formRow('불투명도 (%)', op),
        nRow,
        h('div.note', '대화 상자 없이 바로 만들려면 Ctrl+Alt+Shift+N.'),
      ],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => C.newLayerOpts({
          name: name.value.trim(), clip: clip.checked, color: color.value, blend: mode.value || 'normal',
          opacity: clamp(Math.round(+op.value), 0, 100), neutral: neutral.checked && !nRow.hidden ? NEUTRAL[mode.value] : null,
        }),
      }],
    });
    return undefined;
  };
  /** Ctrl+Alt+2: the picture's brightness as a selection (bright = selected). */
  C.luminositySelection = () => {
    const d = P.doc;
    if (!d) return;
    const src = P.composite();
    const w = d.width;
    const hh = d.height;
    const img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, hh);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const L = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = 0;
      px[i + 3] = Math.round((L * px[i + 3]) / 255);
    }
    const c = makeCanvas(w, hh);
    c.getContext('2d').putImageData(img, 0, 0);
    P.run('광도를 선택 영역으로', () => { d.selection = { canvas: c }; });
  };
  /** Image ▸ Trim: cut away transparent (or top-left / bottom-right coloured) edges. */
  C.trimBy = (based = 'transparent', sides = { top: true, bottom: true, left: true, right: true }) => {
    const d = P.doc;
    if (!d) return;
    const comp = P.composite();
    const w = d.width;
    const hh = d.height;
    const px = comp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, hh).data;
    const ref = based === 'topLeft' ? 0 : based === 'bottomRight' ? (w * hh - 1) * 4 : -1;
    const same = (i) => (ref < 0 ? px[i + 3] === 0 : Math.abs(px[i] - px[ref]) <= 1 && Math.abs(px[i + 1] - px[ref + 1]) <= 1 && Math.abs(px[i + 2] - px[ref + 2]) <= 1 && Math.abs(px[i + 3] - px[ref + 3]) <= 1);
    let x0 = w;
    let y0 = hh;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        if (same((y * w + x) * 4)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return void toast('잘라 내면 아무것도 남지 않습니다');
    const r = { x: sides.left ? x0 : 0, y: sides.top ? y0 : 0 };
    r.w = (sides.right ? x1 + 1 : w) - r.x;
    r.h = (sides.bottom ? y1 + 1 : hh) - r.y;
    if (r.x === 0 && r.y === 0 && r.w === w && r.h === hh) return void toast('잘라 낼 가장자리가 없습니다');
    P.cropTo(r, false, '재단');
  };
  C.trimDialog = () => {
    if (!P.doc) return;
    const based = h('select', h('option', { value: 'transparent' }, '투명 픽셀'), h('option', { value: 'topLeft' }, '왼쪽 위 픽셀 색상'), h('option', { value: 'bottomRight' }, '오른쪽 아래 픽셀 색상'));
    const box = (label) => {
      const c = h('input', { type: 'checkbox', checked: true });
      return [c, h('label.inline', c, ` ${label}`)];
    };
    const [t, tl] = box('위');
    const [b, bl] = box('아래');
    const [l, ll] = box('왼쪽');
    const [r, rl] = box('오른쪽');
    openModal({
      title: '재단',
      width: '380px',
      body: [formRow('기준', based), formRow('잘라 낼 곳', tl, bl, ll, rl)],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => C.trimBy(based.value, { top: t.checked, bottom: b.checked, left: l.checked, right: r.checked }) }],
    });
  };

  // ---------------------------------------------------------------- keyboard shortcuts list

  /** Edit ▸ Keyboard Shortcuts (Ctrl+Alt+Shift+K): every shortcut, searchable. */
  C.keyboardShortcuts = () => {
    const rows = [];
    // tools, by their letter
    const byKey = {};
    for (const t of TOOLS) if (t.key) (byKey[t.key] ||= []).push(t.name);
    rows.push(['도구 (Shift+같은 글자: 같은 무리의 다음 도구, 누르고 있으면 그동안만)', null]);
    for (const k of Object.keys(byKey).sort()) rows.push([byKey[k].join(' · '), k]);
    // menus
    const walk = (items, path) => {
      for (const it of typeof items === 'function' ? items() : items || []) {
        if (!it || typeof it !== 'object' || it.group) continue;
        const label = `${path} ▸ ${it.label}`;
        if (it.key) rows.push([label, it.key]);
        if (it.submenu) {
          try {
            walk(it.submenu, label);
          } catch { /* a submenu that needs a document */ }
        }
      }
    };
    for (const [name, fn] of Object.entries(P.menus)) {
      const start = rows.length;
      try {
        walk(fn(), name);
      } catch { /* skip */ }
      if (rows.length > start) rows.splice(start, 0, [`${name} 메뉴`, null]);
    }
    rows.push(['그 밖의 단축키', null]);
    for (const r of [
      ['손 도구 (누르는 동안)', 'Space'], ['돋보기 (확대 / 축소, 누르는 동안)', 'Space+Ctrl / Space+Alt'], ['확대·축소', 'Ctrl+휠 · Alt+휠'], ['가로로 이동', 'Shift+휠'],
      ['브러시 크기 / 경도', '[ ] / Shift+[ ]'], ['불투명도 10~100%', '1 … 9, 0'], ['전경색·배경색 바꾸기 / 기본 색', 'X / D'], ['빠른 마스크', 'Q'],
      ['아래 / 위 레이어 고르기', 'Alt+[ / Alt+]'], ['아래 / 위 레이어를 함께 고르기', 'Shift+Alt+[ / ]'], ['맨 아래 / 맨 위 레이어 고르기', 'Alt+, / Alt+.'],
      ['레이어 한 칸 뒤로 / 앞으로', 'Ctrl+[ / Ctrl+]'], ['맨 뒤로 / 맨 앞으로', 'Ctrl+Shift+[ / ]'], ['투명 픽셀 잠그기', '/'],
      ['전경색 / 배경색으로 칠', 'Alt+Backspace / Ctrl+Backspace (Shift: 투명 부분 보존)'], ['칠 대화 상자', 'Shift+Backspace · Shift+F5'], ['선택 영역 지우기 · 선택 영역이 없으면 레이어 삭제', 'Delete'],
      ['이동 도구: 1 / 10픽셀 옮기기', '← → ↑ ↓ / Shift+화살표'], ['다음 / 이전 문서', 'Ctrl+Tab / Ctrl+Shift+Tab (브라우저가 막으면 Ctrl+F6)'],
      ['브러시 설정 · 색상 · 레이어 · 정보 · 액션 패널', 'F5 · F6 · F7 · F8 · F9'], ['잘라내기 · 복사 · 붙여넣기', 'F2 · F3 · F4'], ['되돌리기 (연 상태로)', 'F12'],
      ['화면 모드 / 패널 숨기기 / 오른쪽 패널만', 'F / Tab / Shift+Tab'], ['휴대폰: 확대·축소·이동', '두 손가락'],
    ]) rows.push(r);
    const q = h('input', { type: 'search', placeholder: '찾기 (예: 변형, Ctrl+J, 브러시)', 'aria-label': '단축키 찾기' });
    const list = h('div.ph-keys-list');
    const paint = () => {
      const s = q.value.trim().toLowerCase();
      const out = [];
      let head = null;
      for (const [label, key] of rows) {
        if (key == null) {
          head = label;
          continue;
        }
        if (s && !`${label} ${key}`.toLowerCase().includes(s) && !(head || '').toLowerCase().includes(s)) continue;
        if (head) {
          out.push(h('div.ph-keys-h', head));
          head = null;
        }
        out.push(h('span', label), h('span.k', key));
      }
      list.replaceChildren(...(out.length ? out : [h('span', '찾는 단축키가 없습니다')]));
    };
    q.addEventListener('input', paint);
    paint();
    openModal({
      title: '바로 가기 키 (macOS는 Ctrl 대신 ⌘)',
      width: '680px',
      body: [h('div.ph-keys', q, list, h('div.note', '한글 입력 상태에서도 단축키가 작동합니다 (키 위치 기준). 글자를 입력하는 칸에서는 단축키가 꺼집니다. Ctrl+N·T·W·Tab처럼 브라우저가 먼저 쓰는 키는 메뉴를 쓰세요.'))],
    });
    setTimeout(() => q.focus(), 30);
  };

  // ---------------------------------------------------------------- Window menu

  const PANEL_KEYS = { brushSettings: 'F5', color: 'F6', layers: 'F7', info: 'F8', actions: 'Alt+F9' };
  const PANEL_NAMES = { timeline: '타임라인', comps: '레이어 구성 요소', ai: 'AI (자동 보정 · 편집 도우미)' };
  /** The panels the Window menu lists (also the ones modules registered), Korean alphabetical. */
  const panelItems = () => Object.entries(ui.panels)
    .map(([id, p]) => ({ id, label: PANEL_NAMES[id] || p.title }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'))
    .map(({ id, label }) => ({ label, key: PANEL_KEYS[id], checked: !isMobile() && (ui.groupsTop.current() === id || ui.groupLayers.current() === id), action: () => P.showPanel(id) }));
  P.windowPanelLabels = () => panelItems().map((x) => x.label);
  P.windowMenu = () => [
    { label: '정돈', submenu: [
      { label: '모두 탭으로 통합', checked: arrange === 'tabs', action: () => P.setArrange('tabs') },
      { label: '2개 나란히 보기 (2분할)', checked: arrange === '2up', disabled: isMobile(), action: () => P.setArrange('2up') },
      '-',
      { label: '다음 문서', key: 'Ctrl+Tab', disabled: P.docs.length < 2, action: () => P.switchDocStep(1) },
      { label: '이전 문서', key: 'Ctrl+Shift+Tab', disabled: P.docs.length < 2, action: () => P.switchDocStep(-1) },
    ] },
    { label: '작업 영역', disabled: isMobile(), submenu: [
      ...WORKSPACES.map(([id, name]) => ({ label: name, checked: workspace === id, action: () => P.setWorkspace(id) })),
      '-',
      { label: `${WORKSPACES.find((w) => w[0] === workspace)?.[1].replace(' (기본값)', '') || '필수'} 재설정`, action: () => P.setWorkspace(workspace) },
    ] },
    '-',
    ...(ui.panels.brushSettings ? [] : [{ label: '브러시 설정', key: 'F5', disabled: !P.doc, action: () => C.brushSettings() }]),
    ...panelItems(),
    '-',
    { label: '옵션', checked: ui.opts.style.display !== 'none', action: () => { ui.opts.style.display = ui.opts.style.display === 'none' ? '' : 'none'; P.redraw(); } },
    { label: '도구', checked: ui.toolbar.style.display !== 'none', action: () => { ui.toolbar.style.display = ui.toolbar.style.display === 'none' ? '' : 'none'; P.redraw(); } },
    ...(P.docs.length ? ['-', ...P.docs.map((d, i) => ({ label: `${d.name}${d.saved ? '' : ' •'}`, checked: i === P.index, action: () => P.switchDoc(i) }))] : []),
  ];

  // the History panel's options (Photoshop keeps them in the panel's menu)
  const hfoot = ui.panels.history?.el?.querySelector?.('.ph-hfoot');
  if (hfoot) hfoot.append(h('button.small', { title: '작업 내역 옵션 (단계 수, 저장할 때 스냅숏)', 'aria-label': '작업 내역 옵션', onclick: () => C.historyOptions?.() }, icon('gear', 13), ' 옵션…'));
}

/**
 * The last menu pass (after every module added its items): put items where Photoshop has them —
 * File ▸ Export ▸ …, Edit ▸ Preferences at the end, Proof Colors at the top of View — and keep the
 * Window menu free of panel entries listed twice.
 */
export function arrangeMenus(P) {
  const starts = (x, p) => x && typeof x === 'object' && typeof x.label === 'string' && x.label.startsWith(p);
  const take = (items, prefixes) => {
    const out = [];
    for (const p of prefixes) {
      const i = items.findIndex((x) => starts(x, p));
      if (i >= 0) out.push(...items.splice(i, 1));
    }
    return out;
  };
  const tidy = (items) => items.filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1)));
  const wrap = (name, fn) => {
    const orig = P.menus[name];
    if (orig) {
      P.menus[name] = () => {
        const items = orig();
        try {
          return tidy(fn(items) || items);
        } catch (err) {
          console.warn('menu arrangement', name, err);
          return items;
        }
      };
    }
  };
  wrap('파일', (items) => {
    // a module that built its own File ▸ Export submenu already did this
    if (items.some((x) => starts(x, '내보내기') && x.submenu)) return items;
    const at = items.findIndex((x) => starts(x, '빠른 내보내기') || starts(x, '내보내기') || starts(x, '레이어를 파일로') || starts(x, '웹용으로 저장'));
    if (at < 0) return items;
    const quick = take(items, ['빠른 내보내기']);
    const as = take(items, ['내보내기 형식', '내보내기 (PNG']);
    const layers = take(items, ['레이어를 파일로']);
    const web = take(items, ['웹용으로 저장']);
    const rest = [];
    for (let i = items.length - 1; i >= 0; i--) if (starts(items[i], '내보내기') && !items[i].submenu) rest.unshift(...items.splice(i, 1));
    for (const x of as) if (starts(x, '내보내기 (PNG')) x.label = '내보내기 형식… (PNG · JPG · WebP)';
    const sub = [...quick, ...as, ...rest, ...(layers.length ? ['-', ...layers] : []), ...(web.length ? ['-', ...web.map((x) => ({ ...x, label: x.label.replace('웹용으로 저장', '웹용으로 저장 (레거시)') }))] : [])];
    items.splice(Math.min(at, items.length), 0, { label: '내보내기', disabled: !P.doc, submenu: sub });
    return items;
  });
  wrap('편집', (items) => {
    for (const x of items) if (starts(x, '지우기 (메모리)')) x.label = '제거 (메모리 비우기)';
    // Auto-Align / Auto-Blend sit after Transform, Preferences and shortcuts at the very end
    const auto = take(items, ['레이어 자동 정렬', '레이어 자동 혼합']);
    const t = items.findIndex((x) => starts(x, '변형'));
    if (auto.length && t >= 0) items.splice(t + 1, 0, ...auto);
    const end = take(items, ['바로 가기 키', '환경 설정']);
    items.push('-', ...end);
    return items;
  });
  wrap('이미지', (items) => {
    // Apply Image / Calculations come after Duplicate, as in Photoshop
    const calc = take(items, ['이미지 적용', '계산']);
    const d = items.findIndex((x) => starts(x, '복제'));
    if (calc.length) items.splice(d >= 0 ? d + 1 : items.length, 0, ...calc);
    return items;
  });
  wrap('보기', (items) => {
    const proof = take(items, ['교정 색상', '색 영역 경고', '색상 교정']);
    for (const x of proof) {
      if (starts(x, '교정 색상') && !x.key) x.key = `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}Y`;
    }
    if (proof.length) items.unshift(...proof, '-');
    return items;
  });
  wrap('레이어', (items) => {
    // Layer ▸ New ▸ Layer… opens the New Layer dialog (Ctrl+Shift+N), like Photoshop
    const nw = items.find((x) => starts(x, '새로 만들기') && Array.isArray(x.submenu));
    const it = nw?.submenu.find((x) => x && x.label === '레이어');
    if (it && P.cmd.newLayerDialog) Object.assign(it, { label: '레이어…', action: () => P.cmd.newLayerDialog() });
    return items;
  });
  wrap('창', (items) => {
    // the panel list (between Workspace and Options): one entry per panel, in Korean alphabetical
    // order, whichever module added it (the entry with a shortcut wins)
    const a = items.findIndex((x) => x === '-');
    let b = items.findIndex((x, i) => i > a && (x === '-' || starts(x, '옵션')));
    if (a < 0) return items;
    if (b < 0) b = items.length;
    const best = new Map();
    for (const x of items.slice(a + 1, b)) {
      if (!x || typeof x !== 'object') continue;
      const o = best.get(x.label);
      if (!o || (!o.key && x.key)) best.set(x.label, o ? { ...x, checked: x.checked || o.checked } : x);
    }
    const list = [...best.values()].sort((p, q) => p.label.localeCompare(q.label, 'ko'));
    items.splice(a + 1, b - a - 1, ...list);
    return items;
  });
}

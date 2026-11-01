// Layer commands: new/duplicate/delete, groups, clipping masks, merging, fill layers, smart objects,
// align/distribute, linking, locks and layer colours. Installed onto P.cmd by the editor.

import { newLayer, makeCanvas, cloneCanvas, lid, alphaBox, PhotoDoc, LAYER_COLORS } from './doc.js';
import { compositeOnto, BLEND_MODES, blendName } from './blend.js';
import { TOOL_BY_ID } from './tools.js';
import { ADJUSTMENTS, defaultParams } from './adjust.js';
import { toast, promptDialog, menusOpen } from '../ui/common.js';
import { FX_DEFAULTS, scaleFx } from './styles.js';
import { layerStyleDialog, globalLightDialog } from './layerstyle.js';

/** A copy of a layer with a new id (pixels shared; they are never changed in place). */
export function cloneLayer(l, props = {}) {
  const c = { ...l, id: lid(), rev: 0, _styled: null, _cache: null, _text: null, _shape: null };
  for (const k of ['text', 'shape', 'fill', 'smart', 'vmask', 'blendIf', 'adjust']) if (l[k]) c[k] = structuredClone(l[k]);
  c.fx = structuredClone(l.fx || {});
  if (l.mask) c.mask = { ...l.mask };
  return Object.assign(c, props);
}

/** A standalone copy of a document (layers and pixels shared until edited). */
export function cloneDoc(doc, name = doc.name) {
  const d = new PhotoDoc({ name, width: doc.width, height: doc.height, background: null });
  d.restore(doc.capture());
  d.name = name;
  d.saved = true;
  return d;
}

// The editor whose layers the blend-mode / fill keys act on. The listener is added when this module
// loads, so it runs before the editor's own key handler (which would take Shift+Alt+letter as a tool
// key and Shift+number as opacity).
let keysFor = null;
const BLEND_KEYS = { KeyN: 'normal', KeyI: 'dissolve', KeyK: 'darken', KeyM: 'multiply', KeyB: 'color burn', KeyA: 'linear burn', KeyG: 'lighten', KeyS: 'screen', KeyD: 'color dodge', KeyW: 'linear dodge', KeyO: 'overlay', KeyF: 'soft light', KeyH: 'hard light', KeyV: 'vivid light', KeyJ: 'linear light', KeyZ: 'pin light', KeyL: 'hard mix', KeyE: 'difference', KeyX: 'exclusion', KeyU: 'hue', KeyT: 'saturation', KeyC: 'color', KeyY: 'luminosity' };
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const P = keysFor;
    if (!P?.doc || !document.body.classList.contains('photo-mode') || menusOpen() || document.querySelector('.modal-backdrop')) return;
    const tag = e.target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(e.target.type))) return;
    if (e.ctrlKey || e.metaKey || !e.shiftKey || P.transform || e.repeat) return;
    // painting tools keep these keys for their own options
    if (TOOL_BY_ID[P.tool]?.options?.some((o) => o[0] === 'opacity')) return;
    const C = P.cmd;
    let handled = false;
    if (e.altKey && BLEND_KEYS[e.code]) {
      C.setLayerBlend(BLEND_KEYS[e.code]);
      handled = true;
    } else if (!e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      C.cycleLayerBlend(e.code === 'Minus' || e.code === 'NumpadSubtract' ? -1 : 1);
      handled = true;
    } else if (!e.altKey && /^Digit[0-9]$/.test(e.code)) {
      const v = e.code === 'Digit0' ? 100 : +e.code.slice(5) * 10;
      const d = P.doc;
      const ls = d.selectedLayers.filter((l) => !l.locked && l.kind !== 'group' && l.kind !== 'adjust');
      if (ls.length) {
        P.run(`칠 ${v}%`, () => { for (const l of ls) { l.fillOpacity = v / 100; l._styled = null; d.touch(l); } });
        toast(`레이어 칠 ${v}%`);
        handled = true;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

export function installLayerCommands(P) {
  const C = P.cmd;
  const need = () => {
    if (!P.doc) {
      toast('먼저 문서를 열거나 새로 만드세요');
      return false;
    }
    return true;
  };
  const doc = () => P.doc;
  /** Selected layers without those inside a selected group (each block once), bottom → top. */
  const topSelected = () => {
    const d = doc();
    const sel = d.selectedLayers;
    const ids = new Set(sel.map((l) => l.id));
    return sel.filter((l) => !d.ancestors(l).some((a) => ids.has(a.id)));
  };
  const pixels = (l, withOpacity = true) => doc().rasterizeLayer(l, { withOpacity });

  // Layer ▸ Layer Style: the Photoshop-style dialog (blending options, all effects) and Global Light
  C.layerStyle = (section = 'blending') => need() && layerStyleDialog(P, section);
  C.globalLight = () => need() && globalLightDialog(P);
  /** Layer ▸ Layer Style ▸ Scale Effects… (효과 비율 조정) */
  C.scaleEffects = async (pct) => {
    if (!need()) return;
    const items = topSelected().filter((l) => l.fx && Object.keys(l.fx).length);
    if (!items.length) return toast('레이어 스타일이 있는 레이어를 고르세요');
    if (pct == null) {
      const v = await promptDialog('효과 비율 조정', '비율 (%) — 효과의 크기와 거리를 함께 키우거나 줄입니다', '100');
      pct = parseFloat(v);
    }
    if (!(pct > 0) || pct === 100) return;
    P.run('효과 비율 조정', () => {
      for (const l of items) {
        l.fx = scaleFx(l.fx, Math.min(1000, pct) / 100);
        l._styled = null;
        doc().touch(l);
      }
    });
  };

  // ---------------------------------------------------------------- create

  C.newLayer = (name) => need() && P.run('새 레이어', () => P.addLayer(newLayer('raster', { name: name || `레이어 ${doc().layers.length + 1}`, canvas: makeCanvas(doc().width, doc().height) })));
  C.newAdjustLayer = (type) => {
    if (!need()) return;
    P.run(`새 조정 레이어: ${ADJUSTMENTS[type].name}`, () => {
      const l = newLayer('adjust', { name: ADJUSTMENTS[type].name, adjust: { type, params: defaultParams(type) } });
      doc().addMask(l, 'white', !!doc().selection);
      P.addLayer(l);
    });
    P.showPanel('props');
  };
  C.newFillLayer = (fill, name) => {
    if (!need()) return;
    P.run('새 칠 레이어', () => {
      const l = newLayer('fill', { name: name || { solid: '색상 칠', gradient: '그레이디언트 칠', pattern: '패턴 칠' }[fill.type], fill });
      doc().addMask(l, 'white', !!doc().selection);
      P.addLayer(l);
      doc().selection = null;
    });
    P.showPanel('props');
  };
  C.newGroup = () => need() && P.run('새 그룹', () => P.addLayer(newLayer('group', { name: `그룹 ${doc().layers.filter((l) => l.kind === 'group').length + 1}` })));

  /** Ctrl+G: put the selected layers in a new group. */
  C.groupLayers = () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    if (!items.length) return;
    P.run('레이어 그룹화', () => {
      const top = items[items.length - 1];
      const g = newLayer('group', { name: `그룹 ${d.layers.filter((l) => l.kind === 'group').length + 1}`, parent: top.parent || null, collapsed: true });
      // the group entry goes where the topmost item is, the items right below it
      d.layers.splice(d.index(top.id) + 1, 0, g);
      // bottom item first: each one lands right below the group entry, so the order is kept
      for (const it of items) d.moveBlock(it.id, d.index(g.id), g.id);
      d.activeId = g.id;
      d.selectedIds = [g.id];
      d.touch(g);
    });
  };
  C.ungroup = () => {
    if (!need()) return;
    const d = doc();
    const g = d.active;
    if (g?.kind !== 'group') return C.groupLayers();
    P.run('레이어 그룹 해제', () => {
      const kids = d.children(g.id);
      for (const k of kids) k.parent = g.parent || null;
      d.layers.splice(d.index(g.id), 1);
      d.activeId = kids[kids.length - 1]?.id || d.layers[d.layers.length - 1]?.id;
      d.selectedIds = kids.map((k) => k.id);
      d.rev++;
    });
  };

  // ---------------------------------------------------------------- duplicate / delete / order

  const cloneBlock = (l, parent) => {
    const d = doc();
    const c = cloneLayer(l, { parent, name: l.name });
    const out = [];
    if (l.kind === 'group') for (const k of d.children(l.id)) out.push(...cloneBlock(k, c.id));
    out.push(c);
    return out;
  };
  C.duplicateLayer = ({ noSelection = false } = {}) => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    if (!items.length) return;
    if (!noSelection && d.selection && items.length === 1 && items[0].kind === 'raster') return C.layerVia(false);
    P.run('레이어 복제', () => {
      const newIds = [];
      for (const it of items) {
        const blk = cloneBlock(it, it.parent || null);
        blk[blk.length - 1].name = `${it.name} 복사`;
        d.layers.splice(d.index(it.id) + 1, 0, ...blk);
        newIds.push(blk[blk.length - 1].id);
      }
      d.activeId = newIds[newIds.length - 1];
      d.selectedIds = newIds;
      d.rev++;
    });
    return undefined;
  };
  C.layerVia = (cut) => {
    if (!need()) return;
    const d = doc();
    const l = d.active;
    if (!l || l.kind !== 'raster') return toast('이미지 레이어에서 씁니다 (레이어 ▸ 래스터화)');
    if (!d.selection) return C.duplicateLayer();
    P.run(cut ? '잘라낸 레이어' : '복사한 레이어', () => {
      const c = makeCanvas(d.width, d.height);
      const g = c.getContext('2d');
      g.drawImage(l.canvas, l.x, l.y);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(d.selection.canvas, 0, 0);
      if (cut) {
        const lg = d.editPixels(l);
        lg.globalCompositeOperation = 'destination-out';
        lg.drawImage(d.selection.canvas, -l.x, -l.y);
      }
      d.selection = null;
      P.addLayer(newLayer('raster', { name: `${l.name} ${cut ? '잘라냄' : '복사'}`, canvas: c }), { above: l.id });
    });
    return undefined;
  };
  C.deleteLayer = () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    const remaining = d.layers.length - items.reduce((n, it) => n + d.descendants(it.id).length + 1, 0);
    if (remaining < 1) return toast('레이어가 하나는 남아야 합니다');
    const below = d.layers[Math.max(0, d.block(items[0].id)[0] - 1)];
    P.run(items.length > 1 ? '레이어 삭제' : `레이어 삭제: ${items[0].name}`, () => {
      for (const it of items) d.removeBlock(it.id);
      d.activeId = (d.layer(below?.id) || d.layers[d.layers.length - 1]).id;
      d.selectedIds = [d.activeId];
    });
    return undefined;
  };
  C.renameLayer = async (l = doc()?.active) => {
    if (!l) return;
    const name = await promptDialog('레이어 이름', '새 이름', l.name);
    if (name && name !== l.name) P.run('이름 바꾸기', () => { l.name = name; doc().touch(l); });
  };
  /** Drag & drop in the layers panel: put `id` at flat index with a parent. */
  C.moveLayerTo = (id, index, parent) => {
    const d = doc();
    if (!d.layer(id)) return;
    P.run('레이어 순서', () => d.moveBlock(id, index, parent));
  };
  /**
   * Layers panel: several selected layers dragged next to `anchorId` ('above' / 'below' it, or 'into'
   * a group), keeping their order.
   */
  C.moveLayersTo = (ids, anchorId, zone) => {
    const d = doc();
    const anchor = d.layer(anchorId);
    if (!anchor) return;
    const items = ids.map((id) => d.layer(id)).filter(Boolean).filter((l, _, all) => !d.ancestors(l).some((a) => all.includes(a)));
    if (!items.length || items.includes(anchor) || d.ancestors(anchor).some((a) => items.includes(a))) return;
    P.run('레이어 순서', () => {
      items.sort((a, b) => d.index(a.id) - d.index(b.id));
      const blocks = [];
      for (const it of items) blocks.push(d.removeBlock(it.id));
      const parent = zone === 'into' ? anchor.id : anchor.parent || null;
      const at = zone === 'into' ? d.index(anchor.id) : zone === 'above' ? d.index(anchor.id) + 1 : d.block(anchor.id)[0];
      for (const it of items) it.parent = parent;
      d.layers.splice(at, 0, ...blocks.flat());
      d.rev++;
    });
  };
  /** Ctrl+click on a mask thumbnail: the mask as a selection (Shift: add, Alt: subtract, both: intersect). */
  C.selectFromMask = async (l = doc()?.active, mode = 'new') => {
    if (!l?.mask) return;
    const SEL = await import('./selection.js');
    P.run('마스크를 선택 영역으로', () => {
      const d = doc();
      const c = makeCanvas(d.width, d.height);
      c.getContext('2d').drawImage(l.mask.canvas, l.mask.x, l.mask.y);
      d.selection = mode === 'new' ? { canvas: c } : SEL.combine(d, c, mode);
    });
  };

  /** Ctrl+[ / ]: one step among siblings, or to the top / bottom of the group. */
  C.arrange = (dir) => {
    if (!need()) return;
    const d = doc();
    const l = d.active;
    if (!l) return;
    const sibs = d.children(l.parent);
    const i = sibs.indexOf(l);
    let target;
    if (dir === 'top') target = sibs[sibs.length - 1];
    else if (dir === 'bottom') target = sibs[0];
    else target = sibs[i + dir];
    if (!target || target === l) return;
    P.run('레이어 순서', () => {
      if (dir === 'top' || dir === 1) d.moveBlock(l.id, d.index(target.id) + 1);
      else d.moveBlock(l.id, d.block(target.id)[0]);
    });
  };

  // ---------------------------------------------------------------- merge

  /** Replace a block by a raster layer made of `canvas`, keeping position in the list. */
  const replaceWithRaster = (oldL, canvas, props = {}) => {
    const d = doc();
    const b = alphaBox(canvas) || { x: 0, y: 0, w: 1, h: 1 };
    const c = makeCanvas(b.w, b.h);
    c.getContext('2d').drawImage(canvas, -b.x, -b.y);
    const nl = newLayer('raster', { name: oldL.name, visible: oldL.visible, opacity: oldL.opacity, blend: oldL.blend === 'pass through' ? 'normal' : oldL.blend, parent: oldL.parent || null, clip: oldL.clip, color: oldL.color, canvas: c, x: b.x, y: b.y, ...props });
    const blk = d.block(oldL.id);
    d.layers.splice(blk[0], blk[1] - blk[0] + 1, nl);
    d.touch(nl);
    return nl;
  };

  C.mergeDown = () => {
    if (!need()) return;
    const d = doc();
    if (topSelected().length > 1) return C.mergeLayers();
    const top = d.active;
    if (top.kind === 'group') return C.mergeGroup();
    const sibs = d.children(top.parent);
    const below = sibs[sibs.indexOf(top) - 1];
    if (!below) return toast('아래에 합칠 레이어가 없습니다');
    if (below.kind === 'group' || below.kind === 'adjust') return toast('아래 레이어가 그룹이나 조정 레이어라 합칠 수 없습니다');
    P.run('아래로 병합', () => {
      const out = makeCanvas(d.width, d.height);
      const g = out.getContext('2d');
      g.drawImage(pixels(below, false), 0, 0);
      if (top.visible) {
        if (top.kind === 'adjust') d.drawAdjustment(g, { ...top, _cache: null }, `merge${Math.random()}`);
        else compositeOnto(g, pixels(top), 0, 0, top.blend, 1);
        // keep only the below layer's shape when the top layer was clipped to it
        if (top.clip) {
          g.globalCompositeOperation = 'destination-in';
          g.drawImage(pixels(below, false), 0, 0);
        }
      }
      const nl = replaceWithRaster(below, out);
      d.removeBlock(top.id);
      d.activeId = nl.id;
      d.selectedIds = [nl.id];
    });
    return undefined;
  };
  C.mergeLayers = () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    if (items.length < 2) return C.mergeDown();
    P.run('레이어 병합', () => {
      const out = makeCanvas(d.width, d.height);
      const g = out.getContext('2d');
      items.forEach((l, i) => {
        if (!l.visible) return;
        if (l.kind === 'adjust') d.drawAdjustment(g, { ...l, _cache: null }, `merge${Math.random()}`);
        else compositeOnto(g, pixels(l), 0, 0, i === 0 ? 'normal' : l.blend, 1);
      });
      const top = items[items.length - 1];
      const nl = replaceWithRaster(top, out, { opacity: 1, blend: 'normal' });
      for (const it of items.slice(0, -1)) d.removeBlock(it.id);
      d.activeId = nl.id;
      d.selectedIds = [nl.id];
    });
  };
  C.mergeGroup = () => {
    const d = doc();
    const g = d.active;
    if (g?.kind !== 'group') return;
    P.run('그룹 병합', () => {
      const nl = replaceWithRaster(g, pixels(g, false));
      d.activeId = nl.id;
      d.selectedIds = [nl.id];
    });
  };
  C.mergeVisible = () => {
    if (!need()) return;
    const d = doc();
    P.run('보이는 레이어 병합', () => {
      const flat = d.flatten({ fg: P.fg, bg: P.bg });
      const keep = d.layers.filter((l) => !d.shown(l) && !l.parent);
      const l = newLayer('raster', { name: '병합됨', canvas: flat });
      d.layers = [...keep.flatMap((k) => [...d.descendants(k.id), k]), l];
      d.activeId = l.id;
      d.selectedIds = [l.id];
    });
  };
  /** Ctrl+Alt+Shift+E: a new layer with everything visible merged, the others kept. */
  C.stampVisible = () => {
    if (!need()) return;
    P.run('보이는 레이어 도장 찍기', () => {
      const l = newLayer('raster', { name: '병합 (도장)', canvas: doc().flatten({ fg: P.fg, bg: P.bg }) });
      doc().layers.push(l);
      doc().activeId = l.id;
      doc().selectedIds = [l.id];
    });
  };
  C.flatten = () => {
    if (!need()) return;
    const d = doc();
    P.run('이미지 병합', () => {
      const c = makeCanvas(d.width, d.height);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(d.flatten({ fg: P.fg, bg: P.bg }), 0, 0);
      const l = newLayer('raster', { name: '배경', canvas: c });
      d.layers = [l];
      d.activeId = l.id;
      d.selectedIds = [l.id];
    });
  };

  // ---------------------------------------------------------------- rasterize

  /** what: 'layer' (text, shape, fill, smart object…), 'style' (bake layer styles), 'all' (both + mask) */
  C.rasterize = (what = 'layer') => {
    if (!need()) return;
    const d = doc();
    const l = d.active;
    if (!l || l.kind === 'adjust') return toast('래스터화할 레이어를 선택하세요');
    if (l.kind === 'group') return C.mergeGroup();
    if (what === 'layer' && l.kind === 'raster') return toast('이미 이미지(픽셀) 레이어입니다');
    P.run(what === 'style' ? '레이어 스타일 래스터화' : '래스터화', () => {
      if (what === 'layer') {
        const c = d.content(l);
        const nl = { ...l, kind: 'raster', canvas: cloneCanvas(c.canvas), x: c.x, y: c.y, text: null, shape: null, fill: null, smart: null, smartSrc: null, smartDoc: null, rotation: 0, skewX: 0, _text: null, _shape: null, _styled: null };
        d.layers[d.index(l.id)] = nl;
        d.touch(nl);
      } else {
        const nl = replaceWithRaster(l, pixels(l, false), { opacity: l.opacity, blend: l.blend, fillOpacity: 1 });
        nl.name = l.name;
        d.activeId = nl.id;
      }
    });
    return undefined;
  };

  // ---------------------------------------------------------------- clipping, links, locks, colours

  C.toggleClip = () => {
    if (!need()) return;
    const d = doc();
    const l = d.active;
    const sibs = d.children(l.parent);
    if (sibs.indexOf(l) === 0 && !l.clip) return toast('아래에 클리핑할 레이어가 없습니다');
    P.run(l.clip ? '클리핑 마스크 해제' : '클리핑 마스크 만들기', () => { l.clip = !l.clip; d.touch(l); });
    return undefined;
  };
  C.link = () => {
    const items = topSelected();
    if (items.length < 2) return toast('연결할 레이어를 두 개 이상 고르세요 (Ctrl+클릭)');
    const id = lid('K');
    P.run('레이어 연결', () => { for (const l of items) { l.linkId = id; doc().touch(l); } });
    return undefined;
  };
  C.unlink = () => P.run('레이어 연결 해제', () => { for (const l of topSelected()) { l.linkId = null; doc().touch(l); } });
  C.selectLinked = () => {
    const l = doc()?.active;
    if (!l?.linkId) return;
    doc().selectedIds = doc().layers.filter((x) => x.linkId === l.linkId).map((x) => x.id);
    P.emit('layers');
  };
  C.lock = (kind) => {
    const items = topSelected();
    if (!items.length) return;
    const key = { all: 'locked', alpha: 'lockAlpha', pixels: 'lockPixels', position: 'lockPos' }[kind];
    const on = !items[0][key];
    P.run(on ? '잠그기' : '잠금 해제', () => { for (const l of items) { l[key] = on; doc().touch(l); } });
  };
  C.layerColor = (color) => P.run('레이어 색상', () => { for (const l of topSelected()) { l.color = color; doc().touch(l); } });
  C.selectAllLayers = () => {
    const d = doc();
    if (!d) return;
    d.selectedIds = d.layers.filter((l) => !l.parent).map((l) => l.id);
    P.emit('layers');
  };
  C.deselectLayers = () => {
    const d = doc();
    if (!d) return;
    d.selectedIds = [d.activeId];
    P.emit('layers');
  };
  /**
   * Alt+click on an eye: show only this layer (every other layer hidden, its groups kept visible);
   * Alt+click on it again brings back what was visible before.
   */
  C.soloLayer = (l) => {
    const d = doc();
    if (!d || !l) return;
    const keep = new Set([l.id, ...d.ancestors(l).map((a) => a.id), ...d.descendants(l.id).map((x) => x.id)]);
    const prev = d._solo;
    const restoring = prev && prev.id === l.id && d.layers.every((x) => keep.has(x.id) || !x.visible);
    P.run(restoring ? '다른 레이어 다시 보이기' : '이 레이어만 보기', () => {
      if (restoring) {
        for (const x of d.layers) {
          if (prev.vis.has(x.id) && x.visible !== prev.vis.get(x.id)) {
            x.visible = prev.vis.get(x.id);
            d.touch(x);
          }
        }
        d._solo = null;
        return;
      }
      d._solo = { id: l.id, vis: new Map(d.layers.map((x) => [x.id, x.visible])) };
      for (const x of d.layers) {
        const want = keep.has(x.id) ? (x === l || d.ancestors(l).includes(x) ? true : x.visible) : false;
        if (x.visible !== want) {
          x.visible = want;
          d.touch(x);
        }
      }
    });
  };

  /** Run fn on another open document as one undoable step there. */
  const runOn = (target, label, fn) => {
    if (target === doc()) return P.run(label, fn);
    const before = target.capture();
    const r = fn();
    target.rev++;
    target.history?.push(label, before);
    target.saved = false;
    P.afterHistory();
    return r;
  };

  /**
   * Copies of layer blocks (groups with their contents) for another document: pixels are shared
   * (never changed in place), settings copied.
   */
  const copyBlocks = (items, parent = null) => {
    const out = [];
    for (const it of items) {
      const blk = cloneBlock(it, parent);
      out.push(...blk);
    }
    return out;
  };

  /**
   * Layer ▸ Duplicate Layer… (레이어 복제): a name and a destination — this document, another open
   * document or a new one (the usual first step of compositing tutorials).
   */
  C.duplicateLayerDialog = async () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    if (!items.length) return;
    const { openModal } = await import('../ui/common.js');
    const { h } = await import('../util.js');
    const one = items.length === 1 ? items[0] : null;
    const name = h('input', { type: 'text', value: one ? `${one.name} 복사` : '', style: { width: '100%' }, disabled: !one });
    const docs = P.docs.filter((x) => x !== d);
    const dest = h('select', { style: { width: '100%' } },
      h('option', { value: 'self' }, `${d.name} (지금 문서)`),
      ...docs.map((x, i) => h('option', { value: String(i) }, x.name)),
      h('option', { value: 'new' }, '새로 만들기'));
    const newName = h('input', { type: 'text', value: one ? one.name : '레이어', style: { width: '100%' } });
    const newRow = h('div.form-row', { hidden: true }, h('label', '새 문서 이름'), newName);
    dest.addEventListener('change', () => { newRow.hidden = dest.value !== 'new'; });
    openModal({
      title: '레이어 복제',
      width: '440px',
      body: [
        h('div.form-row', h('label', '복제'), h('div', one ? one.name : `레이어 ${items.length}개`)),
        h('div.form-row', h('label', '다른 이름으로'), name),
        h('div.form-row', h('label', '대상 문서'), dest),
        newRow,
      ],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const target = dest.value === 'self' ? d : dest.value === 'new' ? null : docs[+dest.value];
          const nm = name.value.trim();
          if (target === d) {
            C.duplicateLayer({ noSelection: true });
            if (one && nm) P.run('이름 바꾸기', () => { const l = d.active; l.name = nm; d.touch(l); });
            return;
          }
          const blocks = copyBlocks(items);
          if (one && nm) blocks[blocks.length - 1].name = nm;
          if (!target) {
            // a new document the size of this one, holding only the copies
            const nd = new PhotoDoc({ name: newName.value.trim() || (one ? one.name : '레이어'), width: d.width, height: d.height, background: null });
            nd.resolution = d.resolution;
            nd.layers.push(...blocks);
            nd.activeId = blocks[blocks.length - 1].id;
            nd.selectedIds = [nd.activeId];
            P.openDoc(nd);
            nd.saved = false;
            P.renderTabs?.();
            return;
          }
          runOn(target, '레이어 복제', () => {
            target.layers.push(...blocks);
            const tops = blocks.filter((b) => !b.parent);
            target.activeId = tops[tops.length - 1].id;
            target.selectedIds = tops.map((b) => b.id);
          });
          toast(`"${target.name}"에 레이어를 복제했습니다`);
        },
      }],
    });
  };

  /** Layers panel: Alt+drag a layer — a copy dropped at flat index `index` with `parent`. */
  C.duplicateTo = (ids, index, parent = null) => {
    const d = doc();
    const items = ids.map((id) => d.layer(id)).filter(Boolean).filter((l, _, all) => !d.ancestors(l).some((a) => all.includes(a)));
    if (!items.length) return;
    if (parent && items.some((it) => it.id === parent || d.ancestors(d.layer(parent)).includes(it))) return;
    P.run('레이어 복제', () => {
      // the copies keep their own nesting; the top entries take the drop parent
      const blocks = copyBlocks(items, parent || null);
      const ids2 = new Set(blocks.map((b) => b.id));
      const tops = blocks.filter((b) => !ids2.has(b.parent));
      for (const b of tops) b.name = `${b.name} 복사`;
      d.layers.splice(Math.max(0, Math.min(d.layers.length, index)), 0, ...blocks);
      d.activeId = tops[tops.length - 1].id;
      d.selectedIds = tops.map((b) => b.id);
      d.rev++;
    });
  };

  /** Layers panel: a mask thumbnail dragged onto another layer moves the mask there (Alt: copies it). */
  C.moveMaskTo = (fromId, toId, copy = false) => {
    const d = doc();
    const from = d?.layer(fromId);
    const to = d?.layer(toId);
    if (!from?.mask || !to || from === to) return;
    P.run(copy ? '마스크 복사' : '마스크 옮기기', () => {
      to.mask = { ...from.mask };
      to._styled = null;
      d.touch(to);
      if (!copy) {
        from.mask = null;
        from._styled = null;
        d.touch(from);
      }
      d.activeId = to.id;
      d.selectedIds = [to.id];
    });
    P.editMask = true;
  };

  /** Layer ▸ Layer Properties… (레이어 속성): name and colour label. */
  C.layerProperties = async (l = doc()?.active) => {
    if (!l) return;
    const { openModal } = await import('../ui/common.js');
    const { h } = await import('../util.js');
    const name = h('input', { type: 'text', value: l.name, style: { width: '100%' } });
    const color = h('select', LAYER_COLORS.map(([id, nm]) => h('option', { value: id }, nm)));
    color.value = l.color || 'none';
    openModal({
      title: '레이어 속성',
      width: '380px',
      body: [h('div.form-row', h('label', '이름'), name), h('div.form-row', h('label', '색상'), color)],
      buttons: [{ label: '취소' }, {
        label: '확인', primary: true, action: () => {
          const nm = name.value.trim() || l.name;
          if (nm === l.name && color.value === (l.color || 'none')) return;
          P.run('레이어 속성', () => { l.name = nm; l.color = color.value; doc().touch(l); });
        },
      }],
    });
  };

  // ---------------------------------------------------------------- align / distribute

  const boxOf = (l) => {
    const d = doc();
    if (l.kind === 'text' || l.kind === 'shape') {
      const b = d.content(l);
      const ab = b && alphaBox(b.canvas);
      return ab ? { x: b.x + ab.x, y: b.y + ab.y, w: ab.w, h: ab.h } : null;
    }
    return d.opaqueBounds(l);
  };
  C.align = (edge) => {
    if (!need()) return;
    const d = doc();
    const items = topSelected().filter((l) => l.kind !== 'adjust' && !l.lockPos && !l.locked);
    if (!items.length) return;
    let ref;
    if (items.length > 1) {
      const bs = items.map(boxOf).filter(Boolean);
      const x0 = Math.min(...bs.map((b) => b.x));
      const y0 = Math.min(...bs.map((b) => b.y));
      ref = { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
    } else if (d.selection) {
      const c = d.selection.canvas;
      ref = alphaBox(c);
    } else ref = { x: 0, y: 0, w: d.width, h: d.height };
    if (!ref) return;
    P.run('정렬', () => {
      for (const l of items) {
        const b = boxOf(l);
        if (!b) continue;
        let dx = 0;
        let dy = 0;
        if (edge === 'left') dx = ref.x - b.x;
        if (edge === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
        if (edge === 'right') dx = ref.x + ref.w - (b.x + b.w);
        if (edge === 'top') dy = ref.y - b.y;
        if (edge === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
        if (edge === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
        d.translateLayers([l], Math.round(dx), Math.round(dy));
      }
    });
  };
  C.distribute = (axis) => {
    if (!need()) return;
    const d = doc();
    const items = topSelected().filter((l) => l.kind !== 'adjust').map((l) => ({ l, b: boxOf(l) })).filter((x) => x.b);
    if (items.length < 3) return toast('레이어를 세 개 이상 고르세요');
    const c = (b) => (axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2);
    items.sort((a, b) => c(a.b) - c(b.b));
    const first = c(items[0].b);
    const step = (c(items[items.length - 1].b) - first) / (items.length - 1);
    P.run('분포', () => {
      items.forEach(({ l, b }, i) => {
        const delta = Math.round(first + step * i - c(b));
        d.translateLayers([l], axis === 'h' ? delta : 0, axis === 'h' ? 0 : delta);
      });
    });
    return undefined;
  };

  // ---------------------------------------------------------------- layer styles copy / paste

  // Copy / Paste Layer Style carries the effects and the blending options, like Photoshop's
  const STYLE_BLEND = ['blend', 'opacity', 'fillOpacity', 'blendIf', 'blendChannels', 'knockout', 'blendInterior', 'blendClipped', 'transparencyShapes', 'maskHidesFx', 'vmaskHidesFx'];
  let styleClip = null;
  C.copyStyle = () => {
    const l = doc()?.active;
    if (!l) return;
    styleClip = { fx: structuredClone(l.fx || {}), kind: l.kind, ...Object.fromEntries(STYLE_BLEND.map((k) => [k, l[k] && typeof l[k] === 'object' ? structuredClone(l[k]) : l[k]])) };
    toast('레이어 스타일을 복사했습니다');
  };
  C.pasteStyle = () => {
    if (!styleClip) return toast('복사한 스타일이 없습니다');
    P.run('레이어 스타일 붙여넣기', () => {
      for (const l of topSelected()) {
        if (l.kind !== 'adjust') l.fx = structuredClone(styleClip.fx);
        for (const k of STYLE_BLEND) {
          let v = styleClip[k];
          // a group's "pass through" means nothing to other layers
          if (k === 'blend' && v === 'pass through' && l.kind !== 'group') v = 'normal';
          if (v === undefined) delete l[k];
          else l[k] = v && typeof v === 'object' ? structuredClone(v) : v;
        }
        l._styled = null;
        doc().touch(l);
      }
    });
    return undefined;
  };
  C.clearStyle = () => P.run('레이어 스타일 지우기', () => { for (const l of topSelected()) { l.fx = {}; l._styled = null; doc().touch(l); } });
  C.applyStylePreset = (fx) => P.run('스타일 적용', () => {
    for (const l of topSelected()) {
      if (l.kind === 'adjust') continue;
      l.fx = structuredClone(fx);
      l._styled = null;
      doc().touch(l);
    }
  });
  C.quickStyle = (key) => P.run('레이어 스타일', () => {
    const l = doc().active;
    l.fx = { ...(l.fx || {}), [key]: { ...FX_DEFAULTS[key] } };
    l._styled = null;
    doc().touch(l);
  });

  // ---------------------------------------------------------------- smart objects

  /** Convert the selected layers to one smart object (their layers are kept inside it). */
  C.convertToSmart = () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected().filter((l) => l.kind !== 'adjust' || topSelected().length > 1);
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    // the contents' bounds
    const flatAll = makeCanvas(d.width, d.height);
    const fg = flatAll.getContext('2d');
    // a single layer's opacity, fill, styles, mask and blending options stay on the smart object layer
    const BLEND_OPTS = ['blendIf', 'blendChannels', 'knockout', 'blendInterior', 'blendClipped', 'transparencyShapes', 'maskHidesFx', 'vmaskHidesFx'];
    const plainCopy = (l) => ({ ...l, opacity: 1, fillOpacity: 1, fx: {}, mask: null, ...Object.fromEntries(BLEND_OPTS.map((k) => [k, undefined])) });
    for (const l of items) if (l.visible) compositeOnto(fg, pixels(one ? plainCopy(l) : l), 0, 0, one ? 'normal' : l.blend, 1);
    const b = alphaBox(flatAll);
    if (!b) return toast('빈 레이어는 고급 개체로 바꿀 수 없습니다');
    P.run('고급 개체로 변환', () => {
      // inner document: the layers moved to its origin
      const sub = new PhotoDoc({ name: one ? one.name : '고급 개체', width: b.w, height: b.h, background: null });
      for (const it of items) {
        const blk = cloneBlock(it, null);
        // a single layer's opacity, styles and mask stay on the smart object layer itself
        const inner = blk.map((x, i) => (one && i === blk.length - 1 ? { ...plainCopy(x), blend: x.kind === 'group' ? 'pass through' : 'normal', clip: false, linkId: null } : { ...x, linkId: null }));
        sub.layers.push(...inner);
        sub.translateLayers(inner.filter((x) => !x.parent), -b.x, -b.y);
      }
      sub.activeId = sub.layers[sub.layers.length - 1]?.id;
      const src = makeCanvas(b.w, b.h);
      src.getContext('2d').drawImage(flatAll, -b.x, -b.y);
      const top = items[items.length - 1];
      const sl = newLayer('smart', {
        name: one ? one.name : '고급 개체', parent: top.parent || null,
        smart: { w: b.w, h: b.h, m: [1, 0, 0, 1, b.x, b.y], filters: [] },
        smartSrc: src, smartDoc: sub,
        ...(one ? {
          opacity: one.opacity, blend: one.blend === 'pass through' ? 'normal' : one.blend, fx: structuredClone(one.fx || {}), mask: one.mask && { ...one.mask }, fillOpacity: one.fillOpacity ?? 1, clip: one.clip, visible: one.visible,
          ...Object.fromEntries(BLEND_OPTS.filter((k) => one[k] != null).map((k) => [k, structuredClone(one[k])])),
        } : {}),
      });
      d.layers.splice(d.index(top.id) + 1, 0, sl);
      for (const it of items) d.removeBlock(it.id);
      d.activeId = sl.id;
      d.selectedIds = [sl.id];
      d.touch(sl);
    });
    return undefined;
  };

  /** File ▸ Place Embedded: a picture as a smart object, fitted into the document. */
  C.placeEmbeddedCanvas = (canvas, name, subDoc = null) => {
    const d = doc();
    const k = Math.min(1, d.width / canvas.width, d.height / canvas.height);
    const w = canvas.width * k;
    const h = canvas.height * k;
    P.run(`포함 가져오기: ${name}`, () => {
      const l = newLayer('smart', { name, smart: { w: canvas.width, h: canvas.height, m: [k, 0, 0, k, Math.round((d.width - w) / 2), Math.round((d.height - h) / 2)], filters: [] }, smartSrc: canvas, smartDoc: subDoc });
      P.addLayer(l);
    });
  };

  /** Open the smart object's contents as their own document; saving it (Ctrl+S) updates the layer. */
  C.editSmartContents = (l = doc()?.active) => {
    if (l?.kind !== 'smart') return toast('고급 개체 레이어를 선택하세요');
    const parent = doc();
    let sub = l.smartDoc ? cloneDoc(l.smartDoc, `${l.name} (고급 개체)`) : null;
    if (!sub) {
      sub = new PhotoDoc({ name: `${l.name} (고급 개체)`, width: l.smart.w, height: l.smart.h, background: null });
      const r = newLayer('raster', { name: l.name, canvas: cloneCanvas(l.smartSrc) });
      sub.layers.push(r);
      sub.activeId = r.id;
    }
    sub.smartParent = { docId: parent.id, layerId: l.id };
    P.openDoc(sub);
    toast('고급 개체 내용을 열었습니다. 고친 뒤 Ctrl+S(또는 파일 ▸ 저장)를 누르면 원래 문서에 반영됩니다');
    return undefined;
  };
  /** Push a smart-object document back into its parent layer. */
  C.commitSmart = (sub = doc()) => {
    const link = sub?.smartParent;
    if (!link) return false;
    const parent = P.docs.find((x) => x.id === link.docId);
    const l = parent?.layer(link.layerId);
    if (!l) {
      toast('원래 문서나 레이어를 찾지 못했습니다 (닫았거나 지웠을 수 있음)');
      return true;
    }
    const before = parent.capture();
    const src = sub.flatten({ fg: P.fg, bg: P.bg });
    const keep = cloneDoc(sub);
    keep.smartParent = null;
    // keep the on-screen size when the contents changed size
    const sx = l.smart.w / src.width;
    const sy = l.smart.h / src.height;
    const [a, b, c, dd, e, f] = l.smart.m;
    l.smart = { ...l.smart, w: src.width, h: src.height, m: [a * sx, b * sx, c * sy, dd * sy, e, f] };
    l.smartSrc = src;
    l.smartDoc = keep;
    parent.touch(l);
    parent.history.push('고급 개체 내용 편집', before);
    parent.saved = false;
    sub.saved = true;
    toast(`"${parent.name}"의 고급 개체를 고쳤습니다`);
    P.afterHistory();
    return true;
  };
  C.replaceSmartContents = async () => {
    const l = doc()?.active;
    if (l?.kind !== 'smart') return toast('고급 개체 레이어를 선택하세요');
    const { pickFiles } = await import('../ui/project-panel.js');
    const IO = await import('./io.js');
    const [f] = await pickFiles({ accept: IO.OPEN_ACCEPT, multiple: false });
    if (!f) return undefined;
    const sub = f.name.toLowerCase().endsWith('.psd') ? await IO.openFile(f) : null;
    const c = sub ? sub.flatten() : await IO.canvasFromFile(f);
    P.run('내용 바꾸기', () => {
      const sx = l.smart.w / c.width;
      const sy = l.smart.h / c.height;
      const k = Math.min(sx, sy);
      const [a, b, cc, d, e, ff] = l.smart.m;
      l.smart = { ...l.smart, w: c.width, h: c.height, m: [a * k, b * k, cc * k, d * k, e, ff] };
      l.smartSrc = c;
      l.smartDoc = sub;
      doc().touch(l);
    });
    return undefined;
  };
  C.exportSmartContents = async () => {
    const l = doc()?.active;
    if (l?.kind !== 'smart') return;
    const { downloadBlob } = await import('../util.js');
    const blob = await new Promise((r) => l.smartSrc.toBlob(r, 'image/png'));
    if (await downloadBlob(blob, `${l.name}.png`)) toast(`${l.name}.png 저장`);
  };
  C.smartFilterToggle = (l, i) => P.run('고급 필터 켜기/끄기', () => {
    const fl = l.smart.filters.map((f, j) => (j === i ? { ...f, enabled: f.enabled === false } : f));
    l.smart = { ...l.smart, filters: fl };
    doc().touch(l);
  });
  C.smartFilterDelete = (l, i) => P.run('고급 필터 삭제', () => {
    l.smart = { ...l.smart, filters: l.smart.filters.filter((_, j) => j !== i) };
    doc().touch(l);
  });
  C.smartFiltersToggleAll = (l = doc()?.active) => {
    if (!l?.smart?.filters?.length) return;
    const on = l.smart.filters.every((f) => f.enabled === false);
    P.run(on ? '고급 필터 사용' : '고급 필터 사용 안 함', () => {
      l.smart = { ...l.smart, filters: l.smart.filters.map((f) => ({ ...f, enabled: on })) };
      doc().touch(l);
    });
  };
  C.smartFiltersClear = (l = doc()?.active) => {
    if (!l?.smart?.filters?.length) return;
    P.run('고급 필터 지우기', () => {
      l.smart = { ...l.smart, filters: [] };
      l.filterMask = null;
      doc().touch(l);
    });
  };
  /** Layers panel: a smart filter's blending options (mode and opacity), like Photoshop's ≡ icon. */
  C.smartFilterBlending = async (l, i) => {
    const d = doc();
    const f = l?.smart?.filters?.[i];
    if (!f) return;
    const { openModal } = await import('../ui/common.js');
    const { h } = await import('../util.js');
    const { blendSelect } = await import('./panels.js');
    const before = d.capture();
    const mode = blendSelect(false);
    mode.value = f.blend || 'normal';
    const op = h('input', { type: 'range', min: 0, max: 100, value: Math.round((f.opacity ?? 1) * 100), style: { width: '100%' } });
    const opN = h('input.ph-num', { type: 'number', min: 0, max: 100, value: op.value });
    const apply = () => {
      const fl = l.smart.filters.map((x, j) => (j === i ? { ...x, blend: mode.value, opacity: +op.value / 100 } : x));
      l.smart = { ...l.smart, filters: fl };
      d.touch(l);
      P.redraw();
    };
    mode.addEventListener('change', apply);
    op.addEventListener('input', () => { opN.value = op.value; apply(); });
    opN.addEventListener('change', () => { op.value = Math.max(0, Math.min(100, +opN.value)); apply(); });
    let ok = false;
    openModal({
      title: `혼합 옵션 (${P.filterName?.(f.id) || f.id})`,
      width: '380px',
      body: [h('div.form-row', h('label', '모드'), mode), h('div.form-row', h('label', '불투명도 (%)'), h('div.inline', op, opN))],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { apply(); ok = true; P.commit('고급 필터 혼합 옵션', before); } }],
      onClose: () => {
        if (!ok) {
          d.restore(before);
          P.afterHistory();
        }
      },
    });
  };
  /** The Smart Filters mask: 'select' (from the selection), 'reveal' (all white), 'invert', 'toggle', 'delete', 'toSelection'. */
  C.smartFilterMask = (l = doc()?.active, what = 'select') => {
    const d = doc();
    if (l?.kind !== 'smart') return toast('고급 개체 레이어를 고르세요');
    if (what === 'toSelection') {
      if (!l.filterMask) return undefined;
      return P.run('필터 마스크를 선택 영역으로', () => {
        const c = makeCanvas(d.width, d.height);
        const g = c.getContext('2d');
        if (l.filterMask.invert) {
          g.fillRect(0, 0, c.width, c.height);
          g.globalCompositeOperation = 'destination-out';
        }
        g.drawImage(l.filterMask.canvas, l.filterMask.x, l.filterMask.y);
        d.selection = { canvas: c };
      });
    }
    const labels = { select: '필터 마스크 (선택 영역에서)', reveal: '필터 마스크 추가', invert: '필터 마스크 반전', toggle: '필터 마스크 켜기/끄기', delete: '필터 마스크 삭제' };
    if (what === 'select' && !d.selection) return toast('먼저 선택 영역을 만드세요');
    return P.run(labels[what] || '필터 마스크', () => {
      if (what === 'select' || what === 'reveal') {
        const c = makeCanvas(d.width, d.height);
        const g = c.getContext('2d');
        if (what === 'select') g.drawImage(d.selection.canvas, 0, 0);
        else g.fillRect(0, 0, c.width, c.height);
        l.filterMask = { canvas: c, x: 0, y: 0, enabled: true, invert: false };
        // like Photoshop, the new mask is the one the brush paints on
        P.editFilterMask = l.id;
        P.editMask = false;
      } else if (what === 'invert' && l.filterMask) l.filterMask = { ...l.filterMask, invert: !l.filterMask.invert };
      else if (what === 'toggle' && l.filterMask) l.filterMask = { ...l.filterMask, enabled: l.filterMask.enabled === false };
      else if (what === 'delete') l.filterMask = null;
      d.touch(l);
    });
  };

  /**
   * Painting on the Smart Filters mask: after a click on its thumbnail (P.editFilterMask holds the
   * layer id) the painting tools paint on it, black hiding the filters. Used by P.maskTarget.
   */
  P.filterMaskTarget = () => {
    const d = doc();
    const l = d?.active;
    if (!l || P.editMask || P.editFilterMask !== l.id || l.kind !== 'smart' || !l.filterMask?.canvas) return null;
    const fm = l.filterMask;
    return {
      kind: 'filter', canvas: fm.canvas, x: fm.x, y: fm.y, invert: !!fm.invert,
      edit() {
        l.filterMask = { ...l.filterMask, canvas: cloneCanvas(l.filterMask.canvas) };
        d.touch(l);
        return l.filterMask.canvas.getContext('2d');
      },
    };
  };
  /** Layers panel: a click on the Smart Filters mask thumbnail (one is made first when missing). */
  C.pickFilterMask = (l) => {
    if (l?.kind !== 'smart') return;
    if (P.doc.activeId !== l.id) P.selectLayer(l.id);
    if (!l.filterMask) return void C.smartFilterMask(l, 'reveal');
    P.editMask = false;
    P.editFilterMask = l.id;
    if (P.showMaskOnly) P.showMaskOnly = null;
    P.emit('layers');
    P.redraw();
  };

  // closing the document of a smart object's contents asks whether to update the smart object
  const origClose = P.closeDoc;
  P.closeDoc = async (i = P.index) => {
    const sub = P.docs[i];
    if (sub?.smartParent && !sub.saved) {
      const { openModal } = await import('../ui/common.js');
      const { h } = await import('../util.js');
      const choice = await new Promise((resolve) => {
        let v = 'cancel';
        openModal({
          title: '고급 개체 내용 닫기',
          width: '420px',
          body: h('div', `"${sub.name}"에서 고친 내용을 원래 문서의 고급 개체에 반영할까요?`),
          buttons: [{ label: '취소' }, { label: '반영 안 함', action: () => { v = 'discard'; } }, { label: '반영하고 닫기', primary: true, action: () => { v = 'apply'; } }],
          onClose: () => resolve(v),
        });
      });
      if (choice === 'cancel') return undefined;
      if (choice === 'apply') C.commitSmart(sub);
      sub.saved = true;
    }
    return origClose(i);
  };

  // ---------------------------------------------------------------- layer masks (Layer ▸ Layer Mask)

  /**
   * Add a layer mask: 'revealAll', 'hideAll', 'revealSel' (the selection shows), 'hideSel' (the
   * selection is hidden). The layers panel's mask button: reveal the selection (or all); Alt: hide it.
   */
  C.addMaskMode = (mode) => {
    if (!need()) return;
    const d = doc();
    const l = d.active;
    if (!l) return;
    if (l.mask) return toast('이미 레이어 마스크가 있습니다');
    if ((mode === 'revealSel' || mode === 'hideSel') && !d.selection) mode = mode === 'revealSel' ? 'revealAll' : 'hideAll';
    const labels = { revealAll: '레이어 마스크: 모두 나타내기', hideAll: '레이어 마스크: 모두 숨기기', revealSel: '레이어 마스크: 선택 영역 나타내기', hideSel: '레이어 마스크: 선택 영역 숨기기' };
    P.run(labels[mode] || '레이어 마스크', () => {
      const c = makeCanvas(d.width, d.height);
      const g = c.getContext('2d');
      if (mode === 'revealAll' || mode === 'hideSel') g.fillRect(0, 0, c.width, c.height);
      if (mode === 'revealSel') g.drawImage(d.selection.canvas, 0, 0);
      if (mode === 'hideSel') {
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(d.selection.canvas, 0, 0);
      }
      l.mask = { canvas: c, x: 0, y: 0, enabled: true, linked: true };
      if (mode === 'revealSel' || mode === 'hideSel') d.selection = null;
      l._styled = null;
      d.touch(l);
    });
    P.editMask = true;
    P.emit('layers');
  };

  // ---------------------------------------------------------------- masks from transparency

  P.layerContextMenu = (l) => layerContextItems(P, l);

  // ---------------------------------------------------------------- blend mode and fill keys
  // Photoshop, with a tool that doesn't paint (the move tool…): Shift+Alt+letter sets the selected
  // layers' blend mode, Shift+'+' / Shift+'-' steps through the modes, Shift+number sets the fill.
  C.setLayerBlend = (mode) => {
    const d = doc();
    const ls = d?.selectedLayers.filter((l) => !l.locked && (mode !== 'pass through' || l.kind === 'group')) || [];
    if (!ls.length) return;
    P.run(`혼합 모드: ${blendName(mode)}`, () => { for (const l of ls) { l.blend = mode; d.touch(l); } });
    toast(`혼합 모드: ${blendName(mode)}`);
  };
  C.cycleLayerBlend = (dir) => {
    const l = doc()?.active;
    if (!l) return;
    const list = [...(l.kind === 'group' ? ['pass through'] : []), ...BLEND_MODES.map((b) => b[0])];
    const i = list.indexOf(l.blend);
    C.setLayerBlend(list[(Math.max(0, i) + dir + list.length) % list.length]);
  };
  keysFor = P;

  /** A PSD text layer opened as pixels (older files) → an editable text layer showing the same picture. */
  C.psdTextToEditable = async (l = doc()?.active) => {
    if (!l?.psdText || l.kind !== 'raster') return;
    const { newText } = await import('./type.js');
    const { psFont } = await import('./io.js');
    const { psdTextKey } = await import('./doc.js');
    const pt = l.psdText;
    const f = psFont(pt.font);
    P.run('고칠 수 있는 글자로', () => {
      const t = newText({ font: f.font, size: Math.max(1, Math.round(pt.size || 24)), bold: f.bold, italic: f.italic }, pt.color || '#000000', { content: String(pt.text || '').replace(/\r\n?/g, '\n') });
      const nl = { ...l, kind: 'text', text: t, canvas: null, psdText: null, rotation: 0, _text: null, _styled: null };
      if (l.canvas) nl.psdPicture = { canvas: l.canvas, dx: 0, dy: 0, key: psdTextKey(nl) };
      doc().layers[doc().index(l.id)] = nl;
      doc().touch(nl);
    });
  };

  C.maskFromTransparency = () => {
    const d = doc();
    const l = d?.active;
    if (!l || l.kind === 'group' || l.kind === 'adjust') return;
    P.run('투명도에서 마스크', () => {
      const px = pixels({ ...l, mask: null, fx: {} }, false);
      const m = makeCanvas(d.width, d.height);
      m.getContext('2d').drawImage(px, 0, 0);
      l.mask = { canvas: m, x: 0, y: 0, enabled: true, linked: true };
      d.touch(l);
    });
  };
}

/** The layers panel's right-click menu, with Photoshop's items for the layer under the pointer. */
export function layerContextItems(P, l) {
  const C = P.cmd;
  const d = P.doc;
  if (!d || !l) return [];
  const kind = l.kind;
  const multi = d.selectedLayers.length > 1;
  return [
    { label: '레이어 속성…', action: () => C.layerProperties(l) },
    { label: '혼합 옵션…', action: () => C.layerStyle('blending') },
    kind === 'adjust' || kind === 'fill' ? { label: '내용 편집…', action: () => P.showPanel('props') } : null,
    '-',
    { label: '레이어 복제…', action: () => C.duplicateLayerDialog() },
    { label: '레이어 삭제', action: () => C.deleteLayer() },
    kind === 'group' ? { label: '그룹 삭제', action: () => C.deleteLayer() } : null,
    '-',
    { label: '레이어에서 그룹…', action: () => C.groupLayers() },
    kind === 'group' ? { label: '레이어 그룹 해제', action: () => C.ungroup() } : null,
    '-',
    { label: '고급 개체로 변환', action: () => C.convertToSmart() },
    kind === 'smart' ? { label: '내용 편집', action: () => C.editSmartContents(l) } : null,
    kind === 'smart' ? { label: '내용 바꾸기…', action: () => C.replaceSmartContents() } : null,
    kind === 'smart' ? { label: '내용 내보내기…', action: () => C.exportSmartContents() } : null,
    ['text', 'shape', 'fill', 'smart'].includes(kind) ? { label: '레이어 래스터화', action: () => C.rasterize('layer') } : null,
    kind !== 'adjust' && l.fx && Object.keys(l.fx).length ? { label: '레이어 스타일 래스터화', action: () => C.rasterize('style') } : null,
    '-',
    l.mask ? { label: l.mask.enabled === false ? '레이어 마스크 사용' : '레이어 마스크 사용 안 함', action: () => P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: l.mask.enabled === false }; d.touch(l); }) } : null,
    l.mask ? { label: '레이어 마스크 적용', disabled: kind !== 'raster', action: () => C.applyMask() } : null,
    l.mask ? { label: '레이어 마스크 삭제', action: () => C.deleteMask() } : null,
    l.vmask ? { label: l.vmask.enabled === false ? '벡터 마스크 사용' : '벡터 마스크 사용 안 함', action: () => P.run('벡터 마스크 켜기/끄기', () => { l.vmask = { ...l.vmask, enabled: l.vmask.enabled === false }; d.touch(l); }) } : null,
    { label: l.clip ? '클리핑 마스크 해제' : '클리핑 마스크 만들기', action: () => C.toggleClip() },
    '-',
    { label: '레이어 연결', disabled: !multi, action: () => C.link() },
    { label: '연결된 레이어 선택', disabled: !l.linkId, action: () => C.selectLinked() },
    '-',
    { label: '레이어 스타일 복사', disabled: kind === 'adjust', action: () => C.copyStyle() },
    { label: '레이어 스타일 붙여넣기', action: () => C.pasteStyle() },
    { label: '레이어 스타일 지우기', action: () => C.clearStyle() },
    '-',
    ...LAYER_COLORS.map(([id, name, c]) => ({ label: id === 'none' ? '색상 없음' : name, swatch: c || 'transparent', checked: (l.color || 'none') === id, action: () => C.layerColor(id) })),
    '-',
    { label: multi ? '레이어 병합' : kind === 'group' ? '그룹 병합' : '아래로 병합', action: () => C.mergeDown() },
    { label: '보이는 레이어 병합', action: () => C.mergeVisible() },
    { label: '이미지 병합', action: () => C.flatten() },
  ].filter((x) => x !== null).filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-')));
}

/** The Layer menu (also the layers panel's context menu). */
export function layerMenuItems(P, mod) {
  const C = P.cmd;
  const d = P.doc;
  const no = !d;
  const l = d?.active;
  const kind = l?.kind;
  const multi = (d?.selectedLayers.length || 0) > 1;
  return [
    { label: '새로 만들기', disabled: no, submenu: [
      { label: '레이어', key: `${mod}Shift+N`, action: () => C.newLayer() },
      { label: '그룹', action: () => C.newGroup() },
      { label: '레이어에서 그룹', key: `${mod}G`, action: () => C.groupLayers() },
      '-',
      { label: '복사한 레이어', key: `${mod}J`, action: () => C.layerVia(false) },
      { label: '잘라낸 레이어', key: `${mod}Shift+J`, disabled: !d?.selection, action: () => C.layerVia(true) },
    ] },
    { label: multi ? '레이어 복제… (고른 레이어 모두)' : '레이어 복제…', disabled: no, action: () => C.duplicateLayerDialog() },
    { label: '삭제', disabled: no, action: () => C.deleteLayer() },
    { label: '이름 바꾸기…', disabled: no, action: () => C.renameLayer() },
    { label: '레이어 속성…', disabled: no, action: () => C.layerProperties() },
    '-',
    { label: '레이어 스타일', disabled: no, submenu: [
      { label: '혼합 옵션…', action: () => C.layerStyle('blending') },
      '-',
      ...['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'].map((k) => ({ label: `${P.fxNames[k]}…`, disabled: kind === 'adjust', action: () => C.layerStyle(k) })),
      '-',
      { label: '레이어 스타일 복사', disabled: kind === 'adjust', action: () => C.copyStyle() },
      { label: '레이어 스타일 붙여넣기', action: () => C.pasteStyle() },
      { label: '레이어 스타일 지우기', action: () => C.clearStyle() },
      '-',
      { label: '전체 조명…', action: () => C.globalLight() },
      { label: '효과 비율 조정…', disabled: kind === 'adjust', action: () => C.scaleEffects() },
    ] },
    { label: '새 칠 레이어', disabled: no, submenu: [
      { label: '단색…', action: () => P.dialogs.fillLayerDialog(P, 'solid') },
      { label: '그레이디언트…', action: () => P.dialogs.fillLayerDialog(P, 'gradient') },
      { label: '패턴…', action: () => P.dialogs.fillLayerDialog(P, 'pattern') },
    ] },
    { label: '새 조정 레이어', disabled: no, submenu: () => Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'desaturate').map(([k, a]) => ({ label: `${a.name}…`, action: () => C.newAdjustLayer(k) })) },
    '-',
    { label: '레이어 마스크', disabled: no, submenu: [
      { label: '모두 나타내기', disabled: !!l?.mask, action: () => C.addMaskMode('revealAll') },
      { label: '모두 숨기기', disabled: !!l?.mask, action: () => C.addMaskMode('hideAll') },
      { label: '선택 영역 나타내기', disabled: !!l?.mask || !d?.selection, action: () => C.addMaskMode('revealSel') },
      { label: '선택 영역 숨기기', disabled: !!l?.mask || !d?.selection, action: () => C.addMaskMode('hideSel') },
      { label: '투명도에서', disabled: !!l?.mask, action: () => C.maskFromTransparency() },
      '-',
      { label: '삭제', disabled: !l?.mask, action: () => C.deleteMask() },
      { label: '적용', disabled: !l?.mask || kind !== 'raster', action: () => C.applyMask() },
      '-',
      { label: l?.mask?.enabled === false ? '사용' : '사용 안 함', disabled: !l?.mask, action: () => P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: l.mask.enabled === false }; d.touch(l); }) },
      { label: l?.mask?.linked === false ? '연결' : '연결 해제', disabled: !l?.mask, action: () => P.run('마스크 연결', () => { l.mask = { ...l.mask, linked: l.mask.linked === false }; d.touch(l); }) },
      '-',
      { label: '마스크 반전', disabled: !l?.mask, action: () => C.invertMask() },
      { label: '마스크를 선택 영역으로', disabled: !l?.mask, action: () => C.maskToSelection() },
    ] },
    { label: '벡터 마스크', disabled: no, submenu: () => P.vectorMaskMenu?.() || [{ label: '(패스 기능에서 제공)', disabled: true }] },
    { label: l?.clip ? '클리핑 마스크 해제' : '클리핑 마스크 만들기', key: `${mod}Alt+G`, disabled: no, action: () => C.toggleClip() },
    '-',
    { label: '고급 개체', disabled: no, submenu: [
      { label: '고급 개체로 변환', action: () => C.convertToSmart() },
      { label: '포함 가져오기…', action: () => C.placeEmbedded() },
      '-',
      { label: '내용 편집', disabled: kind !== 'smart', action: () => C.editSmartContents() },
      { label: '내용 바꾸기…', disabled: kind !== 'smart', action: () => C.replaceSmartContents() },
      { label: '내용 내보내기…', disabled: kind !== 'smart', action: () => C.exportSmartContents() },
      { label: '래스터화', disabled: kind !== 'smart', action: () => C.rasterize() },
    ] },
    { label: '고급 필터', disabled: kind !== 'smart', submenu: [
      { label: l?.smart?.filters?.every((f) => f.enabled === false) ? '고급 필터 사용' : '고급 필터 사용 안 함', disabled: !l?.smart?.filters?.length, action: () => C.smartFiltersToggleAll() },
      { label: '필터 마스크 추가', disabled: !!l?.filterMask || !l?.smart?.filters?.length, action: () => C.smartFilterMask(l, 'reveal') },
      { label: '선택 영역에서 필터 마스크', disabled: !d?.selection || !l?.smart?.filters?.length, action: () => C.smartFilterMask(l, 'select') },
      { label: l?.filterMask?.enabled === false ? '필터 마스크 사용' : '필터 마스크 사용 안 함', disabled: !l?.filterMask, action: () => C.smartFilterMask(l, 'toggle') },
      { label: '필터 마스크 삭제', disabled: !l?.filterMask, action: () => C.smartFilterMask(l, 'delete') },
      { label: '고급 필터 지우기', disabled: !l?.smart?.filters?.length, action: () => C.smartFiltersClear() },
    ] },
    { label: '래스터화', disabled: no, submenu: [
      { label: '레이어 (글자·모양·칠·고급 개체 → 픽셀)', disabled: !['text', 'shape', 'fill', 'smart'].includes(kind), action: () => C.rasterize('layer') },
      { label: '레이어 스타일 (효과를 픽셀로)', disabled: !kind || kind === 'adjust', action: () => C.rasterize('style') },
      { label: '벡터 마스크', disabled: !l?.vmask, action: () => C.rasterizeVectorMask?.() },
    ] },
    '-',
    { label: '레이어 그룹화', key: `${mod}G`, disabled: no, action: () => C.groupLayers() },
    { label: '레이어 그룹 해제', key: `${mod}Shift+G`, disabled: kind !== 'group', action: () => C.ungroup() },
    { label: '레이어 숨기기 / 보이기', key: `${mod},`, disabled: no, action: () => P.run('레이어 숨기기', () => { for (const x of d.selectedLayers) { x.visible = !x.visible; d.touch(x); } }) },
    { label: '정돈', disabled: no, submenu: [
      { label: '맨 앞으로', key: `${mod}Shift+]`, action: () => C.arrange('top') },
      { label: '앞으로', key: `${mod}]`, action: () => C.arrange(1) },
      { label: '뒤로', key: `${mod}[`, action: () => C.arrange(-1) },
      { label: '맨 뒤로', key: `${mod}Shift+[`, action: () => C.arrange('bottom') },
    ] },
    { label: d?.selection && !multi ? '선택 영역에 맞춰 정렬' : '정렬', disabled: no, submenu: [
      { label: '왼쪽 가장자리', action: () => C.align('left') },
      { label: '가로 가운데', action: () => C.align('hcenter') },
      { label: '오른쪽 가장자리', action: () => C.align('right') },
      '-',
      { label: '위쪽 가장자리', action: () => C.align('top') },
      { label: '세로 가운데', action: () => C.align('vcenter') },
      { label: '아래쪽 가장자리', action: () => C.align('bottom') },
    ] },
    { label: '분포 (3개 이상)', disabled: no, submenu: [
      { label: '가로 간격 같게', action: () => C.distribute('h') },
      { label: '세로 간격 같게', action: () => C.distribute('v') },
    ] },
    { label: '레이어 잠그기', disabled: no, submenu: [
      { label: '투명 픽셀', checked: !!l?.lockAlpha, action: () => C.lock('alpha') },
      { label: '이미지 픽셀', checked: !!l?.lockPixels, action: () => C.lock('pixels') },
      { label: '위치', checked: !!l?.lockPos, action: () => C.lock('position') },
      { label: '모두', checked: !!l?.locked, action: () => C.lock('all') },
    ] },
    { label: '레이어 연결', disabled: no || !multi, action: () => C.link() },
    { label: '연결 해제', disabled: !l?.linkId, action: () => C.unlink() },
    { label: '연결된 레이어 선택', disabled: !l?.linkId, action: () => C.selectLinked() },
    { label: '레이어 색상', disabled: no, submenu: () => LAYER_COLORS.map(([id, name, c]) => ({ label: name, swatch: c || 'transparent', checked: l?.color === id, action: () => C.layerColor(id) })) },
    '-',
    { label: multi ? '레이어 병합' : kind === 'group' ? '그룹 병합' : '아래로 병합', key: `${mod}E`, disabled: no, action: () => C.mergeDown() },
    { label: '보이는 레이어 병합', key: `${mod}Shift+E`, disabled: no, action: () => C.mergeVisible() },
    { label: '보이는 레이어 도장 찍기 (새 레이어)', key: `${mod}Alt+Shift+E`, disabled: no, action: () => C.stampVisible() },
    { label: '이미지 병합', disabled: no, action: () => C.flatten() },
  ];
}

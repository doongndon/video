// Layer commands: new/duplicate/delete, groups, clipping masks, merging, fill layers, smart objects,
// align/distribute, linking, locks and layer colours. Installed onto P.cmd by the editor.

import { newLayer, makeCanvas, cloneCanvas, lid, alphaBox, PhotoDoc, LAYER_COLORS } from './doc.js';
import { compositeOnto } from './blend.js';
import { ADJUSTMENTS, defaultParams } from './adjust.js';
import { toast, promptDialog } from '../ui/common.js';
import { FX_DEFAULTS } from './styles.js';

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
  C.duplicateLayer = () => {
    if (!need()) return;
    const d = doc();
    const items = topSelected();
    if (!items.length) return;
    if (d.selection && items.length === 1 && items[0].kind === 'raster') return C.layerVia(false);
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
  /** Alt+click on an eye: show only this layer (again: show all). */
  C.soloLayer = (l) => {
    const d = doc();
    const others = d.layers.filter((x) => x !== l && !d.ancestors(l).includes(x) && !x.parent);
    const allHidden = others.every((x) => !x.visible);
    P.run('다른 레이어 숨기기/보이기', () => {
      for (const x of others) { x.visible = allHidden; d.touch(x); }
      l.visible = true;
      for (const a of d.ancestors(l)) a.visible = true;
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

  let styleClip = null;
  C.copyStyle = () => {
    const l = doc()?.active;
    if (!l) return;
    styleClip = { fx: structuredClone(l.fx || {}), blend: l.blend, fillOpacity: l.fillOpacity };
    toast('레이어 스타일을 복사했습니다');
  };
  C.pasteStyle = () => {
    if (!styleClip) return toast('복사한 스타일이 없습니다');
    P.run('레이어 스타일 붙여넣기', () => {
      for (const l of topSelected()) {
        l.fx = structuredClone(styleClip.fx);
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
    for (const l of items) if (l.visible) compositeOnto(fg, pixels(one ? { ...l, opacity: 1, fx: {}, mask: null } : l), 0, 0, l.blend, 1);
    const b = alphaBox(flatAll);
    if (!b) return toast('빈 레이어는 고급 개체로 바꿀 수 없습니다');
    P.run('고급 개체로 변환', () => {
      // inner document: the layers moved to its origin
      const sub = new PhotoDoc({ name: one ? one.name : '고급 개체', width: b.w, height: b.h, background: null });
      for (const it of items) {
        const blk = cloneBlock(it, null);
        // a single layer's opacity, styles and mask stay on the smart object layer itself
        const inner = blk.map((x, i) => (one && i === blk.length - 1 ? { ...x, opacity: 1, blend: x.kind === 'group' ? 'pass through' : 'normal', fx: {}, mask: null, clip: false, linkId: null } : { ...x, linkId: null }));
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
        ...(one ? { opacity: one.opacity, blend: one.blend === 'pass through' ? 'normal' : one.blend, fx: structuredClone(one.fx || {}), mask: one.mask && { ...one.mask }, fillOpacity: one.fillOpacity ?? 1, clip: one.clip, visible: one.visible } : {}),
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

  // ---------------------------------------------------------------- masks from transparency

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
    { label: multi ? '레이어 복제 (고른 레이어 모두)' : '레이어 복제', disabled: no, action: () => C.duplicateLayer() },
    { label: '삭제', disabled: no, action: () => C.deleteLayer() },
    { label: '이름 바꾸기…', disabled: no, action: () => C.renameLayer() },
    '-',
    { label: '레이어 스타일', disabled: no || kind === 'adjust', submenu: [
      { label: '혼합 옵션…', action: () => C.layerStyle('blending') },
      '-',
      ...['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'].map((k) => ({ label: `${P.fxNames[k]}…`, action: () => C.layerStyle(k) })),
      '-',
      { label: '레이어 스타일 복사', action: () => C.copyStyle() },
      { label: '레이어 스타일 붙여넣기', action: () => C.pasteStyle() },
      { label: '레이어 스타일 지우기', action: () => C.clearStyle() },
    ] },
    { label: '새 칠 레이어', disabled: no, submenu: [
      { label: '단색…', action: () => P.dialogs.fillLayerDialog(P, 'solid') },
      { label: '그레이디언트…', action: () => P.dialogs.fillLayerDialog(P, 'gradient') },
      { label: '패턴…', action: () => P.dialogs.fillLayerDialog(P, 'pattern') },
    ] },
    { label: '새 조정 레이어', disabled: no, submenu: () => Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'desaturate').map(([k, a]) => ({ label: `${a.name}…`, action: () => C.newAdjustLayer(k) })) },
    '-',
    { label: '레이어 마스크', disabled: no, submenu: [
      { label: '모두 나타내기 (선택 영역이 있으면 선택 영역만)', disabled: !!l?.mask, action: () => C.addMask(false) },
      { label: '모두 숨기기', disabled: !!l?.mask, action: () => C.addMask(true) },
      { label: '투명도에서', disabled: !!l?.mask, action: () => C.maskFromTransparency() },
      '-',
      { label: '마스크 반전', disabled: !l?.mask, action: () => C.invertMask() },
      { label: '마스크를 선택 영역으로', disabled: !l?.mask, action: () => C.maskToSelection() },
      { label: l?.mask?.enabled === false ? '마스크 켜기' : '마스크 끄기', disabled: !l?.mask, action: () => P.run('마스크 켜기/끄기', () => { l.mask = { ...l.mask, enabled: l.mask.enabled === false }; d.touch(l); }) },
      { label: '마스크 적용', disabled: !l?.mask || kind !== 'raster', action: () => C.applyMask() },
      { label: '마스크 삭제', disabled: !l?.mask, action: () => C.deleteMask() },
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

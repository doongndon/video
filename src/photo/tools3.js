// More Photoshop tools: the Art History Brush (stylised strokes painted from a history state) and the
// Frame tool (K): shaped placeholders that pictures drop into, cropped to the frame like Canva's frames.

import { h } from '../util.js';
import { toast } from '../ui/common.js';
import { newLayer, makeCanvas } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS, needRaster, changedRect } from './tools.js';
import * as PT from './paths.js';
import * as IO from './io.js';

const ART_STYLES = [
  ['tightShort', '촘촘하게 짧게'], ['tightMedium', '촘촘하게 중간'], ['tightLong', '촘촘하게 길게'],
  ['looseMedium', '느슨하게 중간'], ['looseLong', '느슨하게 길게'], ['dab', '점 찍기'],
  ['tightCurl', '촘촘하게 곱슬'], ['looseCurl', '느슨하게 곱슬'],
];

export const FRAME_SHAPES = [
  ['rect', '사각형'], ['ellipse', '원'], ['round', '둥근 사각형'], ['triangle', '삼각형'], ['star', '별'],
  ['heart', '하트'], ['bubble', '말풍선'], ['cloud', '구름'], ['drop', '물방울'], ['badge', '배지'],
];
const shapeSpec = (shape, w, h) => (['rect', 'ellipse', 'round', 'triangle', 'star'].includes(shape)
  ? { type: shape, w, h, radius: Math.min(w, h) * 0.12, sides: 5 }
  : { type: 'custom', custom: shape, w, h });

export function installTools3(P) {
  const doc = () => P.doc;

  // ---------------------------------------------------------------- art history brush

  const art = {
    id: 'artHistory', name: '미술 작업 내역 브러시', key: 'Y', icon: 'artHistory', group: 'paint', cursor: 'brush',
    options: [
      ['size', '크기', 'range', 1, 200, 10],
      ['opacity', '불투명도', 'range', 1, 100, 100, '%'],
      ['style', '스타일', 'select', null, null, 'tightShort', ART_STYLES],
      ['area', '영역 (px)', 'range', 5, 500, 50],
      ['fidelity', '색 충실도', 'range', 0, 100, 90, '%'],
    ],
    down(E, p) {
      if (E.maskTarget?.()) return void toast('미술 작업 내역 브러시는 레이어 내용에만 칠합니다');
      if (!needRaster(E, '미술 작업 내역 브러시')) return;
      const d = E.doc;
      const l = d.active;
      const sl = P.historySourceState?.().layers.find((x) => x.id === l.id);
      if (!sl?.canvas) return void toast('작업 내역에서 고른 시점에 이 레이어가 없었습니다. 작업 내역 패널에서 붓 표시를 다른 단계로 옮기세요.');
      // the history state's pixels, read back stroke by stroke
      const src = document.createElement('canvas');
      src.width = d.width;
      src.height = d.height;
      const sg = src.getContext('2d', { willReadFrequently: true });
      sg.drawImage(sl.canvas, sl.x, sl.y);
      const before = d.capture();
      const g = d.editPixels(l, { x: 0, y: 0, w: d.width, h: d.height });
      this.d = { before, g, sg, last: p, dirty: null };
      this.paint(E, p, 1);
    },
    move(E, p) {
      const s = this.d;
      if (!s) return;
      const o = E.opts('artHistory');
      const dist = Math.hypot(p.x - s.last.x, p.y - s.last.y);
      const steps = Math.min(6, Math.floor(dist / Math.max(2, o.size * 0.75)));
      if (!steps) return;
      for (let i = 1; i <= steps; i++) this.paint(E, { x: s.last.x + ((p.x - s.last.x) * i) / steps, y: s.last.y + ((p.y - s.last.y) * i) / steps }, 1);
      s.last = p;
    },
    up(E) {
      const s = this.d;
      this.d = null;
      if (s) E.commit('미술 작업 내역 브러시', s.before);
    },
    cancel(E) {
      if (!this.d) return;
      E.doc.restore(this.d.before);
      this.d = null;
      E.redraw();
    },
    /** A burst of short strokes around p, coloured from the history state. */
    paint(E, p) {
      const s = this.d;
      const d = E.doc;
      const l = d.active;
      const o = E.opts('artHistory');
      const size = Math.max(1, o.size);
      const A = Math.max(2, o.area / 2);
      const style = o.style || 'tightShort';
      const loose = style.startsWith('loose');
      const len = style === 'dab' ? 0 : style.endsWith('Short') ? size * 2 : style.endsWith('Long') ? size * 8 : size * 4;
      const curl = style.endsWith('Curl');
      const n = Math.max(2, Math.min(24, Math.round((loose ? 4 : 7) * Math.min(3, A / 25))));
      const reach = Math.ceil(A + len + size * 2 + 4);
      const ax = Math.max(0, Math.floor(p.x - reach));
      const ay = Math.max(0, Math.floor(p.y - reach));
      const aw = Math.min(d.width, Math.ceil(p.x + reach)) - ax;
      const ah = Math.min(d.height, Math.ceil(p.y + reach)) - ay;
      if (aw < 2 || ah < 2) return;
      const data = s.sg.getImageData(ax, ay, aw, ah).data;
      const at = (x, y) => {
        const xi = Math.max(0, Math.min(aw - 1, Math.round(x - ax)));
        const yi = Math.max(0, Math.min(ah - 1, Math.round(y - ay)));
        return (yi * aw + xi) * 4;
      };
      const lum = (i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const t = makeCanvas(aw, ah);
      const tg = t.getContext('2d');
      tg.lineCap = 'round';
      tg.lineJoin = 'round';
      tg.lineWidth = size;
      const jitter = (1 - (o.fidelity ?? 90) / 100) * 90;
      for (let i = 0; i < n; i++) {
        const a0 = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * (loose ? A : A * 0.6);
        const sx = p.x + Math.cos(a0) * rad;
        const sy = p.y + Math.sin(a0) * rad;
        if (sx < 0 || sy < 0 || sx >= d.width || sy >= d.height) continue;
        const k = at(sx, sy);
        if (data[k + 3] < 10) continue;
        const c = [0, 1, 2].map((j) => Math.max(0, Math.min(255, Math.round(data[k + j] + (Math.random() - 0.5) * 2 * jitter))));
        tg.strokeStyle = tg.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${data[k + 3] / 255})`;
        const lx = sx - ax;
        const ly = sy - ay;
        if (!len) {
          tg.beginPath();
          tg.arc(lx, ly, size / 2, 0, Math.PI * 2);
          tg.fill();
          continue;
        }
        // strokes follow the edges of the picture (across the brightness gradient), loosely or tightly
        const gx = lum(at(sx + 2, sy)) - lum(at(sx - 2, sy));
        const gy = lum(at(sx, sy + 2)) - lum(at(sx, sy - 2));
        let dir = Math.hypot(gx, gy) > 6 ? Math.atan2(gy, gx) + Math.PI / 2 : Math.random() * Math.PI * 2;
        dir += (Math.random() - 0.5) * (loose ? 1.4 : 0.35);
        const hl = (len * (0.6 + Math.random() * 0.6)) / 2;
        const ux = Math.cos(dir);
        const uy = Math.sin(dir);
        tg.beginPath();
        tg.moveTo(lx - ux * hl, ly - uy * hl);
        if (curl) {
          const bend = (Math.random() < 0.5 ? -1 : 1) * hl * 1.2;
          tg.quadraticCurveTo(lx - uy * bend, ly + ux * bend, lx + ux * hl, ly + uy * hl);
        } else tg.lineTo(lx + ux * hl, ly + uy * hl);
        tg.stroke();
      }
      if (d.selection) {
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(d.selection.canvas, -ax, -ay);
      }
      const g = s.g;
      g.save();
      g.globalAlpha = (o.opacity ?? 100) / 100;
      if (l.lockAlpha) g.globalCompositeOperation = 'source-atop';
      g.drawImage(t, ax - l.x, ay - l.y);
      g.restore();
      const r = { x: ax, y: ay, w: aw, h: ah };
      l._styled = null;
      d.touch(l, changedRect(d, l, r));
      E.redraw();
    },
    optionButtons() {
      return [h('button.small', { onclick: () => P.showPanel('history') }, '작업 내역 패널'), h('span.ph-opt.ph-hint', '작업 내역 패널의 붓 표시가 있는 단계에서 색을 가져옵니다')];
    },
  };
  TOOLS.push(art);
  TOOL_BY_ID.artHistory = art;
  const hg = TOOL_GROUPS.find((g) => g[0] === 'historyBrush');
  if (hg) hg.push('artHistory');

  // ---------------------------------------------------------------- frames

  const scratch = makeCanvas(1, 1).getContext('2d');
  /** The frame's shape in doc coords (follows the frame when it moves). */
  const framePath = (f) => PT.toPath2D(f.vmask?.subpaths || [], f.vmask?.dx || 0, f.vmask?.dy || 0);
  P.frameBounds = (f) => {
    const b = PT.pathBounds(f.vmask?.subpaths || []);
    return b && { x: b.x + (f.vmask.dx || 0), y: b.y + (f.vmask.dy || 0), w: b.w, h: b.h };
  };
  P.isFrame = (l) => !!(l && l.kind === 'group' && l.frame && l.vmask);
  const inFrame = (f, p) => scratch.isPointInPath(framePath(f), p.x, p.y);
  /** The topmost visible frame under a point. */
  P.frameAt = (p) => {
    const d = doc();
    if (!d || !p) return null;
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      if (P.isFrame(l) && d.shown(l) && inFrame(l, p)) return l;
    }
    return null;
  };
  /** True when a layer is cut away at p by a frame it sits in (clicking there misses it). */
  P.hiddenByFrame = (l, p) => doc().ancestors(l).some((a) => P.isFrame(a) && !inFrame(a, p));
  /** The frame a layer belongs to (itself when it is one). */
  const frameOf = (l) => (P.isFrame(l) ? l : doc()?.ancestors(l).find((a) => P.isFrame(a)) || null);

  /** Put a picture into a frame, scaled to cover it (as a smart object, so it stays sharp). */
  P.placeInFrame = (f, canvas, name, { fit = 'cover' } = {}) => {
    const d = doc();
    const b = P.frameBounds(f);
    if (!b) return null;
    const k = fit === 'contain' ? Math.min(b.w / canvas.width, b.h / canvas.height) : Math.max(b.w / canvas.width, b.h / canvas.height);
    const w = canvas.width * k;
    const hh = canvas.height * k;
    for (const x of d.descendants(f.id)) d.removeBlock(x.id);
    const l = newLayer('smart', {
      name: name || '이미지', parent: f.id,
      smart: { w: canvas.width, h: canvas.height, m: [k, 0, 0, k, b.x + (b.w - w) / 2, b.y + (b.h - hh) / 2], filters: [] },
      smartSrc: canvas, smartDoc: null,
    });
    d.layers.splice(d.index(f.id), 0, l);
    // the frame stays picked: dragging it moves frame and picture together (pick the picture in the
    // layers panel to move it inside the frame)
    d.activeId = f.id;
    d.selectedIds = [f.id];
    d.touch(l);
    return l;
  };
  /** Re-fit a frame's picture: fill the frame (cover) or show all of it (contain). */
  const refit = (fit) => {
    const f = frameOf(doc()?.active);
    const l = f && doc().descendants(f.id).find((x) => x.kind === 'smart');
    if (!l) return toast('프레임 안에 고급 개체(넣은 이미지)가 없습니다');
    const b = P.frameBounds(f);
    const k = fit === 'contain' ? Math.min(b.w / l.smart.w, b.h / l.smart.h) : Math.max(b.w / l.smart.w, b.h / l.smart.h);
    P.run(fit === 'contain' ? '프레임에 맞추기 (전체 보기)' : '프레임에 맞추기 (채우기)', () => {
      l.smart = { ...l.smart, m: [k, 0, 0, k, b.x + (b.w - l.smart.w * k) / 2, b.y + (b.h - l.smart.h * k) / 2], corners: undefined };
      l._styled = null;
      doc().touch(l);
    });
    return undefined;
  };
  let frameCount = 0;
  /** A new empty frame (a group cut by a vector mask); `content` moves into it when given. */
  const makeFrame = (shape, b, content = null) => {
    const d = doc();
    const sps = PT.mapPath(PT.shapeToSubpaths(shapeSpec(shape, b.w, b.h)), ([x, y]) => [x + b.x, y + b.y]);
    frameCount = Math.max(frameCount, d.layers.filter((l) => P.isFrame(l)).length) + 1;
    const f = newLayer('group', {
      name: `프레임 ${frameCount}`, blend: 'pass through', frame: { shape },
      vmask: { subpaths: sps, enabled: true, invert: false, linked: true, dx: 0, dy: 0 },
    });
    if (content) {
      f.parent = content.parent || null;
      d.layers.splice(d.index(content.id) + 1, 0, f);
      content.parent = f.id;
      d.touch(content);
    } else {
      const a = d.active;
      // above the picked layer (outside any group but a plain one)
      d.insertAbove(f, a && !P.isFrame(frameOf(a)) ? a.id : null);
    }
    d.activeId = f.id;
    d.selectedIds = [f.id];
    d.touch(f);
    return f;
  };

  const frameTool = {
    id: 'frame', name: '프레임', key: 'K', icon: 'frameTool', group: 'shape', cursor: 'crosshair',
    options: [
      ['shape', '모양', 'select', null, null, 'rect', FRAME_SHAPES],
      ['take', '고른 이미지 레이어를 프레임에 넣기', 'bool', null, null, true],
    ],
    down(E, p, e) {
      if (!E.doc) return;
      this.d = { a: p, b: p, alt: !!e?.altKey, shift: !!e?.shiftKey };
      E.redraw();
    },
    move(E, p, e) {
      if (!this.d) return;
      this.d.b = p;
      this.d.alt = !!e?.altKey;
      this.d.shift = !!e?.shiftKey;
      E.redraw();
    },
    box() {
      const { a, b, alt, shift } = this.d;
      let w = Math.abs(b.x - a.x);
      let hh = Math.abs(b.y - a.y);
      if (shift) w = hh = Math.max(w, hh);
      const sx = b.x < a.x ? -1 : 1;
      const sy = b.y < a.y ? -1 : 1;
      if (alt) return { x: a.x - w, y: a.y - hh, w: w * 2, h: hh * 2 };
      return { x: sx > 0 ? a.x : a.x - w, y: sy > 0 ? a.y : a.y - hh, w, h: hh };
    },
    up(E) {
      const s = this.d;
      if (!s) return;
      const r = this.box();
      this.d = null;
      const d = E.doc;
      if (r.w < 4 || r.h < 4) {
        // a click: pick the frame under the pointer
        const f = P.frameAt(s.a);
        if (f) E.selectLayer(f.id);
        E.redraw();
        return;
      }
      const box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      const o = E.opts('frame');
      const a = d.active;
      // the picked picture goes into the new frame (Photoshop does the same)
      const take = o.take && a && ['raster', 'smart'].includes(a.kind) && !a.locked && !a.lockPos && !frameOf(a) && d.layers[0] !== a ? a : null;
      E.run('프레임 만들기', () => makeFrame(o.shape, box, take));
      if (!take) toast('사진 파일을 프레임 위로 끌어 놓으면 프레임 안에 들어갑니다');
    },
    cancel(E) {
      this.d = null;
      E.redraw();
    },
    overlay(E, g) {
      if (!this.d) return;
      const r = this.box();
      const v = E.view;
      const sps = PT.shapeToSubpaths(shapeSpec(E.opts('frame').shape, Math.max(1, r.w), Math.max(1, r.h)));
      g.save();
      g.translate(v.x + r.x * v.zoom, v.y + r.y * v.zoom);
      g.scale(v.zoom, v.zoom);
      const path = PT.toPath2D(sps);
      g.fillStyle = 'rgba(160,165,175,.35)';
      g.fill(path);
      g.lineWidth = 1.5 / v.zoom;
      g.strokeStyle = '#2b8cff';
      g.stroke(path);
      g.restore();
    },
  };
  TOOLS.push(frameTool);
  TOOL_BY_ID.frame = frameTool;
  const sg = TOOL_GROUPS.find((g) => g[0] === 'shape');
  if (sg) TOOL_GROUPS.splice(TOOL_GROUPS.indexOf(sg) + 1, 0, ['frame']);

  // empty frames show a grey placeholder with a cross (on screen only: not in exports)
  const prevExtras = P.drawViewExtras;
  P.drawViewExtras = (g) => {
    prevExtras?.(g);
    const d = doc();
    if (!d || P.extrasOn === false) return;
    const v = d.view;
    for (const f of d.layers) {
      if (!P.isFrame(f) || !d.shown(f)) continue;
      const empty = !d.descendants(f.id).some((x) => d.shown(x));
      const active = frameOf(d.active) === f;
      if (!empty && !active && P.tool !== 'frame') continue;
      const b = P.frameBounds(f);
      if (!b) continue;
      g.save();
      g.translate(v.x, v.y);
      g.scale(v.zoom, v.zoom);
      const path = framePath(f);
      g.lineWidth = 1 / v.zoom;
      if (empty) {
        g.fillStyle = 'rgba(150,155,165,.45)';
        g.fill(path);
        g.save();
        g.clip(path);
        g.strokeStyle = 'rgba(255,255,255,.7)';
        g.beginPath();
        g.moveTo(b.x, b.y);
        g.lineTo(b.x + b.w, b.y + b.h);
        g.moveTo(b.x + b.w, b.y);
        g.lineTo(b.x, b.y + b.h);
        g.stroke();
        g.restore();
      }
      g.strokeStyle = active ? '#2b8cff' : 'rgba(120,125,135,.9)';
      g.setLineDash([4 / v.zoom, 3 / v.zoom]);
      g.stroke(path);
      g.restore();
    }
  };

  const C = P.cmd;
  C.placeIntoFrame = async (f = frameOf(doc()?.active)) => {
    if (!f) return toast('먼저 프레임(프레임 도구 K로 만든 것)을 고르세요');
    const { pickFiles } = await import('../ui/project-panel.js');
    const [file] = await pickFiles({ accept: IO.OPEN_ACCEPT, multiple: false });
    if (!file) return undefined;
    try {
      const c = file.name.toLowerCase().endsWith('.psd') ? (await IO.openFile(file)).flatten() : await IO.canvasFromFile(file);
      P.run('프레임에 이미지 넣기', () => P.placeInFrame(f, c, file.name.replace(/\.[^.]+$/, '')));
    } catch {
      toast(`${file.name}: 열 수 없습니다`);
    }
    return undefined;
  };
  C.emptyFrame = () => {
    const f = frameOf(doc()?.active);
    if (!f) return toast('프레임을 고르세요');
    P.run('프레임 비우기', () => {
      for (const x of doc().descendants(f.id)) doc().removeBlock(x.id);
      doc().activeId = f.id;
      doc().selectedIds = [f.id];
      doc().touch(f);
    });
    return undefined;
  };
  /** Layer ▸ Frame ▸ Convert to Frame: the picked layer goes into a rectangular frame of its size. */
  C.layerToFrame = () => {
    const d = doc();
    const a = d?.active;
    if (!a || !['raster', 'smart', 'text', 'shape'].includes(a.kind)) return toast('이미지·고급 개체·글자·모양 레이어를 고르세요');
    if (frameOf(a)) return toast('이미 프레임 안에 있습니다');
    const fr = P.layerFrame(a);
    if (!fr) return toast('빈 레이어입니다');
    const b = fr.box;
    P.run('프레임으로 변환', () => makeFrame('rect', { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, a));
    return undefined;
  };
  C.fitFrame = refit;
  P.frameMenu = () => {
    const f = frameOf(doc()?.active);
    return [
      { label: '프레임 도구 (K)', action: () => P.setTool('frame') },
      { label: '프레임에 이미지 넣기…', disabled: !f, action: () => C.placeIntoFrame() },
      { label: '이미지로 프레임 채우기', disabled: !f, action: () => refit('cover') },
      { label: '프레임 안에 이미지 전체 보이기', disabled: !f, action: () => refit('contain') },
      { label: '프레임 비우기', disabled: !f, action: () => C.emptyFrame() },
      { label: '레이어를 프레임으로 변환', disabled: !doc()?.active || !!f, action: () => C.layerToFrame() },
    ];
  };
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['레이어'];
    P.menus['레이어'] = () => {
      const items = orig();
      const i = items.findIndex((x) => x?.label === '클리핑 마스크 만들기');
      items.splice(i >= 0 ? i + 1 : items.length, 0, { label: '프레임', disabled: !doc(), submenu: () => P.frameMenu() });
      return items;
    };
  }];
}

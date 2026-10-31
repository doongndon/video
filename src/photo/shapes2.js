// Photoshop's shape tools (사각형 · 타원 · 삼각형 · 다각형 · 선 · 사용자 정의 모양, U / Shift+U), the shape
// layer renderer (fill and stroke with a colour, gradient or pattern; stroke alignment, dashes, caps and
// corners; arrowheads; live rectangle corners, polygon star ratio and smoothing) and the live shape
// properties shown in the Properties panel.

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { newLayer, makeCanvas, setShapeRenderer, rotatedBox } from './doc.js';
import { TOOLS, TOOL_BY_ID, TOOL_GROUPS } from './tools.js';
import * as PT from './paths.js';
import { GRADIENTS, GRADIENT_STYLES, boxGradient, gradientSwatch, listPatterns, patternCanvas, resolveStopColor } from './resources.js';
import { SHAPE_LIB } from './shapelib.js';

export const DASHES = [['solid', '실선', null], ['dash', '파선', [4, 2]], ['dot', '점선', [0, 2]]];
export const ALIGNS = [['inside', '안쪽'], ['center', '가운데'], ['outside', '바깥쪽']];
export const CAPS = [['butt', '버트 끝'], ['round', '둥근 끝'], ['square', '돌출 끝']];
export const JOINS = [['miter', '마이터 연결'], ['round', '둥근 연결'], ['bevel', '경사 연결']];
const PATH_OPS = [['new', '새 레이어'], ['combine', '모양 결합'], ['subtract', '전면 모양 빼기'], ['intersect', '모양 영역 교차'], ['exclude', '오버랩 모양 영역 제외']];

// ---------------------------------------------------------------- geometry and painting

/** The shape's subpaths in its own w×h box (path shapes scaled to the box). */
export function shapeSubpaths(s) {
  if (s.type === 'path' && s.subpaths) {
    const kx = s.w / (s.pw || s.w || 1);
    const ky = s.h / (s.ph || s.h || 1);
    return PT.mapPath(s.subpaths, ([x, y]) => [x * kx, y * ky]);
  }
  return PT.shapeToSubpaths(s);
}

const gradCache = new Map();
/** A canvas paint for a fill or stroke: a colour, or a pattern of a gradient / tiled pattern. */
function paintFor(g, s, which, w, h, pad) {
  const type = s[`${which}Type`] || 'color';
  const fallback = which === 'fill' ? s.fill || '#000000' : s.stroke || s.fill || '#000000';
  if (type === 'gradient' && s[`${which}Gradient`]?.gradient) {
    const gd = s[`${which}Gradient`];
    const W = Math.ceil(w + pad * 2);
    const H = Math.ceil(h + pad * 2);
    const style = gd.style || 'linear';
    const a = ((gd.angle ?? 90) * Math.PI) / 180;
    // the gradient spans the shape's box, like Photoshop's "align with layer"
    const k = style === 'radial'
      ? Math.hypot(w, h) / Math.max(1, Math.hypot(W, H))
      : (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / Math.max(1, Math.abs(Math.cos(a)) * W + Math.abs(Math.sin(a)) * H);
    const key = JSON.stringify([gd, W, H]);
    let c = gradCache.get(key);
    if (!c) {
      c = boxGradient(W, H, gd.gradient, { angle: gd.angle ?? 90, scale: (gd.scale ?? 100) * k, style, reverse: !!gd.reverse });
      if (gradCache.size > 24) gradCache.clear();
      gradCache.set(key, c);
    }
    const pat = g.createPattern(c, 'no-repeat');
    pat.setTransform(new DOMMatrix().translate(-pad, -pad));
    return pat;
  }
  if (type === 'pattern' && s[`${which}Pattern`]?.id) {
    const pp = s[`${which}Pattern`];
    const src = patternCanvas(pp.id);
    const k2 = Math.max(0.01, (pp.scale || 100) / 100);
    const tile = makeCanvas(src.width * k2, src.height * k2);
    tile.getContext('2d').drawImage(src, 0, 0, tile.width, tile.height);
    return g.createPattern(tile, 'repeat');
  }
  return fallback;
}

const hasFill = (s) => s.type !== 'line' && ((s.fillType === 'gradient' && s.fillGradient) || (s.fillType === 'pattern' && s.fillPattern) || (!s.fillType || s.fillType === 'color') && !!s.fill);
const strokeOn = (s) => (s.type === 'line' ? true : (s.strokeWidth || 0) > 0 && (!!s.stroke || s.strokeType === 'gradient' || s.strokeType === 'pattern'));
const lineWeight = (s) => Math.max(1, s.strokeWidth || s.h || 1);

/** Draw a shape into g (origin: the shape box's top left). */
export function drawShape(g, s, pad = 0) {
  const w = Math.max(1, s.w);
  const h = Math.max(1, s.h);
  const sps = shapeSubpaths(s);
  const closed = sps.filter((sp) => sp.closed);
  const rule = s.fillRule || PT.fillRuleFor(sps);
  if (hasFill(s) && closed.length) {
    g.fillStyle = paintFor(g, s, 'fill', w, h, pad);
    g.fill(PT.toPath2D(closed), rule);
  }
  if (!strokeOn(s)) return;
  const isLine = s.type === 'line';
  const sw = isLine ? lineWeight(s) : s.strokeWidth;
  const paint = paintFor(g, s, 'stroke', w, h, pad);
  if (isLine) {
    // the line and its arrowheads
    const open = sps.filter((sp) => !sp.closed);
    g.strokeStyle = paint;
    g.lineWidth = sw;
    g.lineCap = s.lineCap || 'round';
    if (s.dash?.length) g.setLineDash(s.dash.map((v) => Math.max(0.01, v) * sw));
    if (open.length) g.stroke(PT.toPath2D(open));
    g.setLineDash([]);
    if (closed.length) {
      g.fillStyle = paint;
      g.fill(PT.toPath2D(closed));
    }
    return;
  }
  const p = PT.toPath2D(sps);
  const setup = (c) => {
    c.lineWidth = sw;
    c.lineJoin = s.lineJoin || 'round';
    c.lineCap = s.lineCap || 'round';
    c.miterLimit = 4;
    if (s.dash?.length) c.setLineDash(s.dash.map((v) => Math.max(0.01, v) * sw));
  };
  const align = s.strokeAlign || 'center';
  if (align === 'inside' && closed.length) {
    g.save();
    g.clip(PT.toPath2D(closed), rule);
    setup(g);
    g.lineWidth = sw * 2;
    g.strokeStyle = paint;
    g.stroke(p);
    g.restore();
  } else if (align === 'outside' && closed.length) {
    // a doubled stroke with the shape itself kept clear
    const t = makeCanvas(g.canvas.width, g.canvas.height);
    const tg = t.getContext('2d');
    tg.setTransform(g.getTransform());
    setup(tg);
    tg.lineWidth = sw * 2;
    tg.strokeStyle = paintFor(tg, s, 'stroke', w, h, pad);
    tg.stroke(p);
    tg.globalCompositeOperation = 'destination-out';
    tg.setLineDash([]);
    tg.fill(PT.toPath2D(closed), rule);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(t, 0, 0);
    g.restore();
  } else {
    g.save();
    setup(g);
    g.strokeStyle = paint;
    g.stroke(p);
    g.restore();
  }
}

/** How far a shape's drawing reaches outside its box. */
export function shapePad(s) {
  let pad = 1;
  if (strokeOn(s)) {
    const sw = s.type === 'line' ? lineWeight(s) : s.strokeWidth;
    const align = s.type === 'line' ? 'center' : s.strokeAlign || 'center';
    const reach = align === 'outside' ? sw : align === 'center' ? sw / 2 : 0;
    pad += reach * ((s.lineJoin || 'round') === 'miter' ? 4 : 1.5);
  }
  if (s.type === 'line' && (s.arrowStart || s.arrowEnd)) pad += (lineWeight(s) * Math.max(s.arrowW ?? 500, 100)) / 200;
  return Math.ceil(pad);
}

setShapeRenderer((layer, box) => {
  const s = layer.shape;
  if (!s) return null;
  const pad = shapePad(s);
  return box(layer, Math.max(1, s.w), Math.max(1, s.h), (g) => drawShape(g, s, pad), pad);
});

// ---------------------------------------------------------------- shape style (fill / stroke)

/** Fill or stroke settings → the shape properties they set. */
export function paintProps(which, def, fg, bg) {
  const kind = def?.kind || (which === 'fill' ? 'fg' : 'none');
  if (kind === 'none') return which === 'fill' ? { fill: null, fillType: 'color' } : { stroke: null, strokeType: 'color' };
  if (kind === 'gradient') {
    const gr = def.gradient || GRADIENTS[0];
    const resolved = { ...gr, stops: (gr.stops || []).map((st) => ({ ...st, color: resolveStopColor(st.color, fg, bg) })) };
    const first = resolved.stops[0]?.color || fg;
    return { [which]: first, [`${which}Type`]: 'gradient', [`${which}Gradient`]: { gradient: resolved, style: def.style || 'linear', angle: def.angle ?? 90, scale: def.scale ?? 100, reverse: !!def.reverse } };
  }
  if (kind === 'pattern') return { [which]: fg, [`${which}Type`]: 'pattern', [`${which}Pattern`]: { id: def.pattern || 'checker', scale: def.scale ?? 100 } };
  const color = kind === 'fg' ? fg : kind === 'bg' ? bg : def.color || fg;
  return { [which]: color, [`${which}Type`]: 'color' };
}

/** A small swatch showing a fill / stroke setting. */
function swatch(P, def, which) {
  const c = makeCanvas(26, 18);
  const g = c.getContext('2d');
  const kind = def?.kind || (which === 'fill' ? 'fg' : 'none');
  if (kind === 'none') {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 26, 18);
    g.strokeStyle = '#d33';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(2, 16);
    g.lineTo(24, 2);
    g.stroke();
  } else if (kind === 'gradient') g.drawImage(gradientSwatch(def.gradient || GRADIENTS[0], 26, 18, P.fg, P.bg), 0, 0);
  else if (kind === 'pattern') {
    g.fillStyle = g.createPattern(patternCanvas(def.pattern || 'checker'), 'repeat');
    g.fillRect(0, 0, 26, 18);
  } else {
    g.fillStyle = kind === 'fg' ? P.fg : kind === 'bg' ? P.bg : def.color || '#000';
    g.fillRect(0, 0, 26, 18);
  }
  if (which === 'stroke' && kind !== 'none') {
    g.clearRect(6, 5, 14, 8);
  }
  c.style.cssText = 'display:block;border:1px solid var(--line, #555);border-radius:2px';
  return c;
}

/** A floating panel under an anchor that closes on an outside press or Esc. */
function popover(anchor, build) {
  document.querySelectorAll('.sp-pop').forEach((p) => p.remove());
  const el = h('div.sp-pop', { role: 'dialog', style: { position: 'fixed', zIndex: 3000, background: 'var(--panel, #24272c)', border: '1px solid var(--line, #444)', borderRadius: '8px', padding: '10px', boxShadow: '0 8px 28px rgba(0,0,0,.45)', maxWidth: 'min(360px, calc(100vw - 16px))', maxHeight: '70vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' } });
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const esc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const fill = () => el.replaceChildren(...build(fill, close).filter(Boolean));
  fill();
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth;
  el.style.left = `${clamp(r.left, 8, window.innerWidth - pw - 8)}px`;
  el.style.top = `${Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
  return { el, close };
}

const segBtn = (on, label, onclick, title) => h(`button.small${on ? '.on' : ''}`, { title: title || label, 'aria-pressed': String(!!on), style: on ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)' } : null, onclick }, label);

/** The fill / stroke picker: none, solid colour, gradient or pattern. onChange(def). */
export function paintPicker(P, which, def, onChange) {
  const b = h('button.small', { title: which === 'fill' ? '칠 (없음 · 단색 · 그레이디언트 · 패턴)' : '획 (없음 · 단색 · 그레이디언트 · 패턴)', 'aria-label': which === 'fill' ? '칠' : '획', style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } }, h('span', which === 'fill' ? '칠' : '획'), swatch(P, def, which));
  b.addEventListener('click', () => {
    let d = { kind: which === 'fill' ? 'fg' : 'none', ...(def || {}) };
    const set = (patch, rebuild) => {
      d = { ...d, ...patch };
      def = d;
      b.replaceChildren(h('span', which === 'fill' ? '칠' : '획'), swatch(P, d, which));
      onChange(d);
      rebuild?.();
    };
    popover(b, (rebuild) => {
      const kinds = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
        segBtn(d.kind === 'none', '없음', () => set({ kind: 'none' }, rebuild)),
        segBtn(['fg', 'bg', 'color'].includes(d.kind), '단색', () => set({ kind: 'color', color: d.color || P.fg }, rebuild)),
        segBtn(d.kind === 'gradient', '그레이디언트', () => set({ kind: 'gradient', gradient: d.gradient || GRADIENTS[0] }, rebuild)),
        segBtn(d.kind === 'pattern', '패턴', () => set({ kind: 'pattern', pattern: d.pattern || 'checker' }, rebuild)));
      const body = [];
      if (['fg', 'bg', 'color'].includes(d.kind)) {
        const col = h('input', { type: 'color', value: d.kind === 'fg' ? P.fg : d.kind === 'bg' ? P.bg : d.color || '#000000', 'aria-label': '색' });
        col.addEventListener('change', () => set({ kind: 'color', color: col.value }));
        const recent = [P.fg, P.bg, ...(P.recent || [])].filter((c, i, a) => a.indexOf(c) === i).slice(0, 14);
        body.push(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, col, segBtn(d.kind === 'fg', '전경색', () => set({ kind: 'fg' }, rebuild)), segBtn(d.kind === 'bg', '배경색', () => set({ kind: 'bg' }, rebuild))),
          h('div', { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' } }, recent.map((c) => h('button', { title: c, 'aria-label': c, style: { width: '20px', height: '20px', minHeight: 0, padding: 0, background: c, border: '1px solid #666' }, onclick: () => set({ kind: 'color', color: c }, rebuild) }))));
      } else if (d.kind === 'gradient') {
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' } }, GRADIENTS.map((gr) => {
          const bt = h('button', { title: gr.name, 'aria-label': gr.name, style: { padding: '2px', minHeight: 0, outline: d.gradient?.id === gr.id ? '2px solid var(--accent)' : 'none' }, onclick: () => set({ gradient: gr }, rebuild) }, gradientSwatch(gr, 64, 16, P.fg, P.bg));
          return bt;
        })));
        const st = h('select', { 'aria-label': '스타일' }, GRADIENT_STYLES.map(([v, n]) => h('option', { value: v }, n)));
        st.value = d.style || 'linear';
        st.addEventListener('change', () => set({ style: st.value }));
        const ang = h('input.ph-num', { type: 'number', value: d.angle ?? 90, min: -180, max: 180, 'aria-label': '각도' });
        ang.addEventListener('change', () => set({ angle: clamp(+ang.value, -180, 180) }));
        const sc = h('input.ph-num', { type: 'number', value: d.scale ?? 100, min: 10, max: 1000, 'aria-label': '비율' });
        sc.addEventListener('change', () => set({ scale: clamp(+sc.value, 10, 1000) }));
        const rev = h('input', { type: 'checkbox', checked: !!d.reverse });
        rev.addEventListener('change', () => set({ reverse: rev.checked }));
        body.push(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, h('span', '스타일'), st, h('span', '각도'), ang, h('span', '비율'), sc, h('label', rev, ' 반전')),
          h('button.small', { onclick: async () => { const D = await import('./pdialogs.js'); D.gradientEditor(P, d.gradient || GRADIENTS[0], (g2) => set({ gradient: g2 }, rebuild)); } }, '그레이디언트 편집…'));
      } else if (d.kind === 'pattern') {
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px' } }, listPatterns().map((pt) => {
          const c = makeCanvas(40, 40);
          const g = c.getContext('2d');
          g.fillStyle = g.createPattern(patternCanvas(pt.id), 'repeat');
          g.fillRect(0, 0, 40, 40);
          return h('button', { title: pt.name, 'aria-label': pt.name, style: { padding: '2px', minHeight: 0, outline: d.pattern === pt.id ? '2px solid var(--accent)' : 'none' }, onclick: () => set({ pattern: pt.id }, rebuild) }, c);
        })));
        const sc = h('input.ph-num', { type: 'number', value: d.scale ?? 100, min: 1, max: 1000, 'aria-label': '비율' });
        sc.addEventListener('change', () => set({ scale: clamp(+sc.value, 1, 1000) }));
        body.push(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('span', '비율 (%)'), sc));
      }
      return [h('b', which === 'fill' ? '칠' : '획'), kinds, ...body];
    });
  });
  return b;
}

/** Stroke options (Photoshop's 획 옵션): dash, alignment, caps and corners. onChange(patch). */
export function strokeOptionsButton(cur, onChange) {
  const b = h('button.small', { title: '획 옵션 (실선 · 파선 · 점선, 정렬, 끝, 모퉁이)', 'aria-label': '획 옵션' }, dashLabel(cur.dash));
  b.addEventListener('click', () => {
    let c = { ...cur };
    popover(b, (rebuild) => {
      const set = (patch) => {
        c = { ...c, ...patch };
        b.textContent = dashLabel(c.dash);
        onChange(patch);
        rebuild();
      };
      const row = (label, items, key, map = (v) => v) => h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' } }, h('span', { style: { minWidth: '44px' } }, label), ...items.map(([v, n, val]) => segBtn(key === 'dash' ? dashId(c.dash) === v : (c[key] || (key === 'strokeAlign' ? 'center' : key === 'lineCap' ? 'butt' : 'miter')) === v, n, () => set({ [key]: map(v, val) }))));
      const custom = h('input', { type: 'text', value: c.dash?.length ? c.dash.join(' ') : '', placeholder: '대시 간격 (예: 4 2)', style: { width: '120px' } });
      custom.addEventListener('change', () => {
        const nums = custom.value.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
        set({ dash: nums.length ? nums : null, ...(nums.length && nums[0] === 0 ? { lineCap: 'round' } : {}) });
      });
      return [h('b', '획 옵션'),
        row('모양', DASHES, 'dash', (v, val) => val),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('span', { style: { minWidth: '44px' } }, '사용자'), custom),
        row('정렬', ALIGNS, 'strokeAlign'),
        row('끝', CAPS, 'lineCap'),
        row('모퉁이', JOINS, 'lineJoin')];
    });
  });
  return b;
}
const dashId = (dash) => (!dash?.length ? 'solid' : dash[0] <= 0.01 ? 'dot' : 'dash');
const dashLabel = (dash) => DASHES.find((d) => d[0] === dashId(dash))?.[1] || '실선';

/** Arrowheads of the line tool. onChange(patch). */
function arrowButton(cur, onChange) {
  const b = h('button.small', { title: '화살촉 (시작 · 끝, 폭, 길이, 오목함)', 'aria-label': '화살촉' }, '화살촉');
  b.addEventListener('click', () => {
    const c = { arrowW: 500, arrowL: 1000, arrowC: 0, ...cur };
    popover(b, () => {
      const chk = (key, label) => {
        const x = h('input', { type: 'checkbox', checked: !!c[key] });
        x.addEventListener('change', () => {
          c[key] = x.checked;
          onChange({ [key]: x.checked });
        });
        return h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } }, x, label);
      };
      const num = (key, label, min, max) => {
        const n = h('input.ph-num', { type: 'number', value: c[key], min, max });
        n.addEventListener('change', () => {
          c[key] = clamp(+n.value, min, max);
          onChange({ [key]: c[key] });
        });
        return h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, h('span', { style: { minWidth: '64px' } }, label), n, h('small', '%'));
      };
      return [h('b', '화살촉'), h('div', { style: { display: 'flex', gap: '12px' } }, chk('arrowStart', '시작'), chk('arrowEnd', '끝')), num('arrowW', '폭', 10, 1000), num('arrowL', '길이', 10, 5000), num('arrowC', '오목함', -50, 50)];
    });
  });
  return b;
}

/** Thumbnails of the custom shape library in groups; onPick(id). */
export function shapeLibraryGrid(cur, onPick) {
  const thumb = (id) => {
    const c = makeCanvas(36, 36);
    const g = c.getContext('2d');
    g.translate(3, 3);
    g.fillStyle = '#d7dbe0';
    g.fill(PT.toPath2D(PT.shapeToSubpaths({ type: 'custom', custom: id, w: 30, h: 30 })));
    return c;
  };
  return SHAPE_LIB.map((grp) => h('div', h('div', { style: { color: 'var(--text-faint)', margin: '2px 0 4px' } }, grp.name),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' } }, grp.items.map(([id, name]) => h('button', { title: name, 'aria-label': name, style: { padding: '2px', minHeight: 0, outline: cur === id ? '2px solid var(--accent)' : 'none' }, onclick: () => onPick(id) }, thumb(id))))));
}

// ---------------------------------------------------------------- tools

export function installShapes2(P) {
  const S = () => P.opts('shape');
  const stylePatch = (o) => {
    const fillDef = o.fillDef || { kind: 'fg' };
    const strokeDef = o.strokeDef || { kind: 'none' };
    return {
      ...paintProps('fill', fillDef, P.fg, P.bg), ...paintProps('stroke', strokeDef, P.fg, P.bg),
      strokeWidth: strokeDef.kind === 'none' ? 0 : o.strokeWidth ?? 3, strokeAlign: o.strokeAlign || 'center', dash: o.dash || null,
      lineCap: o.lineCap || 'butt', lineJoin: o.lineJoin || 'miter',
    };
  };

  /** The shape a tool makes in a w×h box. */
  const shapeFor = (type, o, w, h) => {
    const base = { type, w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), ...stylePatch(o) };
    if (type === 'rect') {
      const r = Math.max(0, o.corner || 0);
      if (r) base.radii = [r, r, r, r];
    } else if (type === 'triangle') base.radius = Math.max(0, o.corner || 0);
    else if (type === 'polygon') Object.assign(base, { sides: o.sides || 5, starRatio: o.starRatio ?? 100, smooth: !!o.smooth, smoothIndents: !!o.smoothIndents });
    else if (type === 'custom') base.custom = o.custom || 'heart';
    else if (type === 'line') {
      // the line's colour: its stroke, or the fill when there is no stroke
      const weight = Math.max(1, o.weight || 4);
      const strokeDef = o.strokeDef?.kind && o.strokeDef.kind !== 'none' ? o.strokeDef : o.fillDef || { kind: 'fg' };
      Object.assign(base, paintProps('stroke', strokeDef.kind === 'none' ? { kind: 'fg' } : strokeDef, P.fg, P.bg), { fill: null, fillType: 'color', strokeWidth: weight, h: weight, arrowStart: !!o.arrowStart, arrowEnd: !!o.arrowEnd, arrowW: o.arrowW ?? 500, arrowL: o.arrowL ?? 1000, arrowC: o.arrowC ?? 0, lineCap: o.lineCap || 'butt' });
    }
    return base;
  };
  const NAMES = { rect: '사각형', ellipse: '타원', triangle: '삼각형', polygon: '다각형', line: '선', custom: '모양' };
  const layerName = (s) => (s.type === 'custom' ? P.customShapeName(s.custom) : s.type === 'polygon' && s.starRatio < 100 ? '별' : NAMES[s.type] || '모양');

  /** Put a finished shape on the canvas: a shape layer (or combined into the active one), a path or pixels. */
  const place = (s, x, y, rotation, before) => {
    const o = S();
    const mode = o.mode || 'shape';
    const doc = P.doc;
    const tmp = newLayer('shape', { name: layerName(s), shape: s, x, y, rotation: rotation || 0 });
    if (mode === 'path' || mode === 'pixels') {
      const sps = rotateSubpaths(PT.translatePath(shapeSubpaths(s), x, y), rotation, x + s.w / 2, y + s.h / 2).map((sp) => ({ ...sp, closed: s.type === 'line' && !sp.closed ? false : sp.closed }));
      if (mode === 'path') {
        P.addToWorkPath(sps, `${NAMES[s.type] || '모양'} (패스)`, before);
        return;
      }
      const l = doc.active;
      if (l?.kind !== 'raster') {
        toast('픽셀 모드는 이미지 레이어에 그립니다');
        return;
      }
      // pixels: the shape drawn with its fill (and stroke) into the layer
      const out = rotatedBox(tmp, s.w, s.h, (g) => drawShape(g, s, shapePad(s)), shapePad(s));
      const g = doc.editPixels(l);
      g.drawImage(out.canvas, out.x - l.x, out.y - l.y);
      l._styled = null;
      P.commit(`${NAMES[s.type] || '모양'} (픽셀)`, before);
      return;
    }
    const op = o.op || 'new';
    const act = doc.active;
    if (op !== 'new' && act?.kind === 'shape') {
      const add = rotateSubpaths(PT.translatePath(shapeSubpaths(s).filter((sp) => sp.closed), x, y), rotation, x + s.w / 2, y + s.h / 2).map((sp) => ({ ...sp, op }));
      P.setShapePathDoc(act, [...P.shapePathDoc(act), ...add]);
      P.commit('모양 결합', before);
      return;
    }
    P.addLayer(tmp);
    P.commit(NAMES[s.type] || '모양', before);
  };

  /** Click without dragging: Photoshop's "Create Rectangle / Ellipse…" dialog. */
  const createDialog = (type, p) => {
    const o = S();
    const last = P.lastShapeSize || { w: 100, h: 100 };
    const W = h('input.ph-num', { type: 'number', value: type === 'line' ? last.w : last.w, min: 1, max: 30000 });
    const H = h('input.ph-num', { type: 'number', value: last.h, min: 1, max: 30000 });
    const center = h('input', { type: 'checkbox' });
    const rows = [h('label.ph-prow', h('span', type === 'line' ? '길이' : '폭'), W, h('small', 'px')), type === 'line' ? null : h('label.ph-prow', h('span', '높이'), H, h('small', 'px')), h('label.ph-prow', center, h('span', '가운데부터'))];
    const title = { rect: '사각형 만들기', ellipse: '타원 만들기', triangle: '삼각형 만들기', polygon: '다각형 만들기', line: '선 만들기', custom: '사용자 정의 모양 만들기' }[type];
    openModal({
      title, width: '300px', body: rows.filter(Boolean),
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => {
        const w = clamp(+W.value || 100, 1, 30000);
        const hh = type === 'line' ? Math.max(1, o.weight || 4) : clamp(+H.value || 100, 1, 30000);
        P.lastShapeSize = { w, h: type === 'line' ? last.h : hh };
        const before = P.doc.capture();
        const s = shapeFor(type, o, w, hh);
        const x = Math.round(center.checked ? p.x - w / 2 : p.x);
        const y = Math.round(center.checked || type === 'line' ? p.y - hh / 2 : p.y);
        place(s, x, y, 0, before);
      } }],
    });
  };

  const rectFrom = (a, b, e, type) => {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (e.shiftKey && type !== 'line') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    if (e.altKey && type !== 'line') return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
  };
  const lineEnd = (a, b, e) => {
    if (!e.shiftKey) return b;
    const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  };

  const COMMON = (extra) => [['mode', '모드', 'select', null, null, 'shape', [['shape', '모양'], ['path', '패스'], ['pixels', '픽셀']]], ...extra, ['op', '패스 작업', 'select', null, null, 'new', PATH_OPS]];
  const ORDER = ['shape', 'ellipseShape', 'triangleShape', 'polygonShape', 'lineShape', 'customShape'];

  const makeTool = (id, type, name, ic, extra) => ({
    id, name, key: 'U', icon: ic, group: 'shape', cursor: 'crosshair', optionsFrom: 'shape',
    options: COMMON(extra),
    activate() {
      // Photoshop's Shapes panel (and older code) reads the kind of shape from here
      S().type = type;
    },
    down(E, p, e) {
      this.d = { a: p, b: p, e };
    },
    move(E, p, e) {
      if (!this.d) return;
      this.d.b = p;
      this.d.e = e;
      E.overlay();
    },
    up(E) {
      const d = this.d;
      this.d = null;
      if (!d) return;
      const o = S();
      const zoom = P.view.zoom;
      const moved = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) * zoom;
      if (moved < 3) {
        createDialog(type, d.a);
        E.overlay();
        return;
      }
      const before = P.doc.capture();
      if (type === 'line') {
        const b = lineEnd(d.a, d.b, d.e || {});
        const len = Math.max(2, Math.hypot(b.x - d.a.x, b.y - d.a.y));
        const s = shapeFor('line', o, len, Math.max(1, o.weight || 4));
        const ang = (Math.atan2(b.y - d.a.y, b.x - d.a.x) * 180) / Math.PI;
        const cx = (d.a.x + b.x) / 2;
        const cy = (d.a.y + b.y) / 2;
        place(s, Math.round(cx - s.w / 2), Math.round(cy - s.h / 2), Math.round(ang * 100) / 100, before);
        return;
      }
      const r = rectFrom(d.a, d.b, d.e || {}, type);
      if (r.w < 1 || r.h < 1) return;
      P.lastShapeSize = { w: Math.round(r.w), h: Math.round(r.h) };
      place(shapeFor(type, o, r.w, r.h), Math.round(r.x), Math.round(r.y), 0, before);
    },
    onKey(E, e) {
      if (e.code === 'KeyU' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        P.setTool(ORDER[(ORDER.indexOf(id) + 1) % ORDER.length]);
        return true;
      }
      return false;
    },
    overlay(E, g) {
      const d = this.d;
      if (!d) return;
      const o = S();
      g.save();
      g.strokeStyle = '#4aa3ff';
      g.lineWidth = 1;
      const z = E.view.zoom;
      if (type === 'line') {
        const b = lineEnd(d.a, d.b, d.e || {});
        const [x1, y1] = E.toScreen(d.a.x, d.a.y);
        const [x2, y2] = E.toScreen(b.x, b.y);
        g.lineWidth = Math.max(1, (o.weight || 4) * z);
        g.strokeStyle = 'rgba(74,163,255,.7)';
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      } else {
        const r = rectFrom(d.a, d.b, d.e || {}, type);
        const [x, y] = E.toScreen(r.x, r.y);
        const s = shapeFor(type, o, Math.max(1, r.w), Math.max(1, r.h));
        g.translate(x, y);
        g.scale(z, z);
        g.lineWidth = 1 / z;
        g.stroke(PT.toPath2D(shapeSubpaths(s)));
      }
      g.restore();
    },
  });

  const corner = ['corner', '반경 (px)', 'number', 0, 5000, 0];
  const tools = [
    makeTool('shape', 'rect', '사각형 도구', 'rectShape', [corner]),
    makeTool('ellipseShape', 'ellipse', '타원 도구', 'ellipseShape', []),
    makeTool('triangleShape', 'triangle', '삼각형 도구', 'triangleShape', [corner]),
    makeTool('polygonShape', 'polygon', '다각형 도구', 'polygonShape', [['sides', '변 수', 'number', 3, 100, 5], ['starRatio', '별 비율 (%)', 'number', 1, 100, 100], ['smooth', '모퉁이 매끄럽게', 'bool', null, null, false], ['smoothIndents', '들여쓰기 매끄럽게', 'bool', null, null, false]]),
    makeTool('lineShape', 'line', '선 도구', 'lineShape', [['weight', '두께 (px)', 'number', 1, 2000, 4]]),
    makeTool('customShape', 'custom', '사용자 정의 모양 도구', 'customShape', []),
  ];
  // the options bar: fill, stroke, stroke width and type, and per tool arrowheads / the shape library
  for (const t of tools) {
    t.optionButtons = (PP) => {
      const o = S();
      const set = (k, v) => PP.setOpt('shape', k, v);
      const sw = h('input.ph-num', { type: 'number', value: o.strokeWidth ?? 3, min: 0, max: 1000, title: '획 두께 (px)', 'aria-label': '획 두께' });
      sw.addEventListener('change', () => set('strokeWidth', clamp(+sw.value, 0, 1000)));
      const out = [
        paintPicker(PP, 'fill', o.fillDef || { kind: 'fg' }, (d) => set('fillDef', d)),
        paintPicker(PP, 'stroke', o.strokeDef || { kind: 'none' }, (d) => set('strokeDef', d)),
        h('label.ph-opt', sw, h('small', 'px')),
        strokeOptionsButton({ dash: o.dash, strokeAlign: o.strokeAlign, lineCap: o.lineCap, lineJoin: o.lineJoin }, (patch) => { for (const [k, v] of Object.entries(patch)) set(k, v); }),
      ];
      if (t.id === 'lineShape') out.push(arrowButton({ arrowStart: o.arrowStart, arrowEnd: o.arrowEnd, arrowW: o.arrowW, arrowL: o.arrowL, arrowC: o.arrowC }, (patch) => { for (const [k, v] of Object.entries(patch)) set(k, v); }));
      if (t.id === 'customShape') {
        const cur = o.custom || 'heart';
        const b = h('button.small', { title: '모양 고르기', 'aria-label': '모양 고르기', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, h('span', '모양'), (() => {
          const c = makeCanvas(18, 18);
          const g = c.getContext('2d');
          g.fillStyle = 'currentColor';
          g.fillStyle = '#d7dbe0';
          g.fill(PT.toPath2D(PT.shapeToSubpaths({ type: 'custom', custom: cur, w: 18, h: 18 })));
          return c;
        })(), h('span', P.customShapeName(cur)));
        b.addEventListener('click', () => popover(b, (rebuild, close) => [h('b', '사용자 정의 모양'), ...shapeLibraryGrid(S().custom || 'heart', (id) => {
          set('custom', id);
          close();
        })]));
        out.push(b);
      }
      return out;
    };
  }
  // replace the old all-in-one shape tool by Photoshop's tools (the rectangle keeps its id 'shape')
  const oldIdx = TOOLS.findIndex((x) => x.id === 'shape');
  for (const t of tools) {
    if (t.id === 'shape' && oldIdx >= 0) TOOLS[oldIdx] = t;
    else TOOLS.push(t);
    TOOL_BY_ID[t.id] = t;
  }
  const grp = TOOL_GROUPS.find((g) => g[0] === 'shape');
  if (grp) grp.splice(0, grp.length, ...ORDER);
  else TOOL_GROUPS.push([...ORDER]);
  if (!S().custom || !PT.CUSTOM_SHAPES.some((c) => c[0] === S().custom)) S().custom = 'heart';

  // older callers pick a shape kind through the shape tool's options: switch to that tool
  const prevSetOpt = P.setOpt;
  const TOOL_FOR = { rect: 'shape', round: 'shape', ellipse: 'ellipseShape', triangle: 'triangleShape', polygon: 'polygonShape', star: 'polygonShape', line: 'lineShape', custom: 'customShape' };
  P.setOpt = (id, key, v) => {
    if (key === 'type' && (TOOL_BY_ID[id]?.optionsFrom || id) === 'shape' && TOOL_FOR[v]) {
      if (v === 'star') prevSetOpt('shape', 'starRatio', 50);
      if (TOOL_BY_ID[P.tool]?.optionsFrom === 'shape' || P.tool === id) P.setTool(TOOL_FOR[v]);
      S().type = v === 'star' ? 'polygon' : v === 'round' ? 'rect' : v;
      P.emit('opts');
      return;
    }
    prevSetOpt(id, key, v);
  };

  P.customShapeGroups = () => SHAPE_LIB.map((g) => ({ name: g.name, items: g.items.map(([id, name]) => [id, name]) }));
  P.drawShape = drawShape;
  P.shapeProperties = (l, live) => shapeProperties(P, l, live);
}

/** Rotate subpaths about (cx, cy) by deg. */
function rotateSubpaths(sps, deg, cx, cy) {
  if (!deg) return sps;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return PT.mapPath(sps, ([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}

// ---------------------------------------------------------------- live shape properties

/** Rows for the Properties panel: Photoshop's live shape properties. live(label, fn, done). */
function shapeProperties(P, l, live) {
  const s = l.shape;
  const set = (label, patch, done = true) => live(label, () => {
    l.shape = { ...l.shape, ...patch };
  }, done);
  const num = (v, min, max, step, onSet, title) => {
    const n = h('input.ph-num', { type: 'number', value: Math.round(v * 100) / 100, min, max, step, title, 'aria-label': title });
    n.addEventListener('change', () => onSet(clamp(+n.value, min, max)));
    return n;
  };
  const field = (label, ...ctrl) => h('label.ph-prow', h('span', label), ...ctrl);
  const rows = [];
  const kindName = { rect: '사각형', round: '둥근 사각형', ellipse: '타원', triangle: '삼각형', polygon: '다각형', star: '별', line: '선', custom: '사용자 정의 모양', path: '패스' }[s.type] || '모양';
  rows.push(h('div.ph-sub', `모양 속성 · ${kindName}${s.type === 'custom' ? `: ${P.customShapeName(s.custom)}` : ''}`));
  // transform: W / H / X / Y / angle
  const resize = (patch) => live('모양 크기', () => {
    const cx = l.x + s.w / 2;
    const cy = l.y + s.h / 2;
    const w = patch.w ?? s.w;
    const hh = patch.h ?? s.h;
    l.shape = { ...l.shape, w, h: hh };
    // the top-left corner stays (like Photoshop); a turned shape grows about its centre instead
    if (l.rotation) {
      l.x = Math.round(cx - w / 2);
      l.y = Math.round(cy - hh / 2);
    }
  }, true);
  rows.push(field('W × H', num(s.w, 1, 30000, 1, (v) => resize({ w: v }), '폭'), h('span', '×'), num(s.h, 1, 30000, 1, (v) => resize({ h: v }), '높이')),
    field('X / Y', num(l.x, -30000, 30000, 1, (v) => live('위치', () => { l.x = v; }, true), 'X'), num(l.y, -30000, 30000, 1, (v) => live('위치', () => { l.y = v; }, true), 'Y')),
    field('회전 (°)', num(l.rotation || 0, -360, 360, 0.1, (v) => live('회전', () => { l.rotation = v; }, true), '회전')));
  // appearance
  const fillDef = s.fill == null && (!s.fillType || s.fillType === 'color') ? { kind: 'none' } : s.fillType === 'gradient' ? { kind: 'gradient', gradient: s.fillGradient?.gradient, style: s.fillGradient?.style, angle: s.fillGradient?.angle, scale: s.fillGradient?.scale, reverse: s.fillGradient?.reverse } : s.fillType === 'pattern' ? { kind: 'pattern', pattern: s.fillPattern?.id, scale: s.fillPattern?.scale } : { kind: 'color', color: s.fill };
  const strokeVisible = s.type === 'line' || (s.strokeWidth > 0 && (s.stroke || s.strokeType === 'gradient' || s.strokeType === 'pattern'));
  const strokeDef = !strokeVisible ? { kind: 'none' } : s.strokeType === 'gradient' ? { kind: 'gradient', gradient: s.strokeGradient?.gradient, style: s.strokeGradient?.style, angle: s.strokeGradient?.angle, scale: s.strokeGradient?.scale, reverse: s.strokeGradient?.reverse } : s.strokeType === 'pattern' ? { kind: 'pattern', pattern: s.strokePattern?.id, scale: s.strokePattern?.scale } : { kind: 'color', color: s.stroke || s.fill || '#000000' };
  const appearance = [];
  if (s.type !== 'line') appearance.push(paintPicker(P, 'fill', fillDef, (d) => set('칠', paintProps('fill', d, P.fg, P.bg))));
  appearance.push(paintPicker(P, 'stroke', strokeDef, (d) => {
    const pp = paintProps('stroke', d, P.fg, P.bg);
    set('획', { ...pp, ...(d.kind !== 'none' && !(l.shape.strokeWidth > 0) ? { strokeWidth: 3 } : {}) });
  }));
  rows.push(h('div.ph-sub', '모양'), h('div.ph-prow', ...appearance),
    field(s.type === 'line' ? '두께 (px)' : '획 (px)', num(s.strokeWidth || (s.type === 'line' ? s.h : 0), 0, 2000, 0.5, (v) => set('획 두께', s.type === 'line' ? { strokeWidth: Math.max(1, v), h: Math.max(1, v) } : { strokeWidth: v }), '획 두께'),
      strokeOptionsButton({ dash: s.dash, strokeAlign: s.strokeAlign, lineCap: s.lineCap, lineJoin: s.lineJoin }, (patch) => set('획 옵션', patch))));
  // per kind
  if (s.type === 'rect' || s.type === 'round') {
    const radii = s.type === 'round' ? [1, 1, 1, 1].map(() => s.radius ?? 20) : s.radii || [0, 0, 0, 0];
    const linked = radii.every((r) => r === radii[0]);
    let link = l._radiiLink ?? linked;
    const setR = (i, v) => {
      const next = link ? [v, v, v, v] : radii.map((r, j) => (j === i ? v : r));
      set('모퉁이 반경', { type: 'rect', radii: next, radius: undefined });
    };
    const lk = h('button.small', { title: '네 모퉁이 함께 바꾸기', 'aria-pressed': String(link), style: link ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)' } : null, onclick: () => {
      link = !link;
      Object.defineProperty(l, '_radiiLink', { value: link, writable: true, configurable: true, enumerable: false });
      lk.setAttribute('aria-pressed', String(link));
      lk.style.background = link ? 'var(--accent-soft)' : '';
    } }, icon('link', 14));
    rows.push(field('모퉁이 반경', lk),
      h('div.ph-prow', ...['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'].map((name, i) => num(radii[i], 0, 15000, 1, (v) => setR(i, v), `${name} 모퉁이 반경`))));
  }
  if (s.type === 'triangle') rows.push(field('모퉁이 반경', num(s.radius || 0, 0, 15000, 1, (v) => set('모퉁이 반경', { radius: v }), '모퉁이 반경')));
  if (s.type === 'polygon' || s.type === 'star') {
    const ratio = s.starRatio ?? (s.type === 'star' ? Math.round((s.indent != null ? 1 - s.indent / 100 : 0.4) * 100) : 100);
    const chk = (key, label) => {
      const x = h('input', { type: 'checkbox', checked: !!s[key] });
      x.addEventListener('change', () => set(label, { type: 'polygon', starRatio: ratio, [key]: x.checked }));
      return h('label.inline', x, label);
    };
    rows.push(field('변 수', num(s.sides || 5, 3, 100, 1, (v) => set('변 수', { sides: v }), '변 수')),
      field('별 비율 (%)', num(ratio, 1, 100, 1, (v) => set('별 비율', { type: 'polygon', starRatio: v }), '별 비율')),
      h('div.ph-prow', chk('smooth', '모퉁이 매끄럽게'), chk('smoothIndents', '들여쓰기 매끄럽게')));
  }
  if (s.type === 'line') {
    const chk = (key, label) => {
      const x = h('input', { type: 'checkbox', checked: !!s[key] });
      x.addEventListener('change', () => set('화살촉', { [key]: x.checked }));
      return h('label.inline', x, label);
    };
    rows.push(h('div.ph-prow', h('span', '화살촉'), chk('arrowStart', '시작'), chk('arrowEnd', '끝')),
      field('폭 / 길이 (%)', num(s.arrowW ?? 500, 10, 1000, 10, (v) => set('화살촉 폭', { arrowW: v }), '화살촉 폭'), num(s.arrowL ?? 1000, 10, 5000, 10, (v) => set('화살촉 길이', { arrowL: v }), '화살촉 길이')),
      field('오목함 (%)', num(s.arrowC ?? 0, -50, 50, 1, (v) => set('화살촉 오목함', { arrowC: v }), '오목함')));
  }
  if (s.type === 'custom') {
    const b = h('button.small', { title: '다른 모양으로 바꾸기' }, '모양 바꾸기…');
    b.addEventListener('click', () => popover(b, (rebuild, close) => [h('b', '사용자 정의 모양'), ...shapeLibraryGrid(s.custom, (id) => {
      set('사용자 정의 모양', { custom: id });
      close();
    })]));
    rows.push(h('div.ph-prow', b));
  }
  rows.push(h('div.ph-prow',
    h('button.small', { onclick: () => { P.pathTarget = { kind: 'shape', layerId: l.id }; P.setTool('directSelect'); } }, '패스 고치기 (직접 선택)'),
    h('button.small', { onclick: () => P.cmd.rasterize() }, '래스터화')));
  return rows;
}

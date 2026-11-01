// Clone sources (Photoshop's 복제 원본 panel): five source points, each remembering its document and
// layer, with an offset, scale (W / H), rotation and flips, and an overlay of the source under the
// brush. The clone stamp and the healing brush paint through it, sampling the current layer, the
// current layer and below, or all layers (optionally without adjustment layers).

import { h, clamp } from '../util.js';
import { toast, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { injectStyle } from '../ui/style-inject.js';
import { TOOL_BY_ID, Stroke, brushOpts, needRaster } from './tools.js';
import { BRUSH_BAR } from './brushpanel.js';

export const SAMPLE_OPT = ['sample', '샘플', 'select', null, null, 'current', [['current', '현재 레이어'], ['below', '현재 이하'], ['all', '모든 레이어']]];
export const IGNORE_ADJ_OPT = ['ignoreAdj', '조정 레이어 무시', 'bool', null, null, false];
export const ALIGNED_OPT = ['aligned', '정렬', 'bool', null, null, true];

injectStyle('ph-clonesrc-css', `
.cs-slots { display: flex; gap: 4px; }
.cs-slots button { flex: 1; min-height: calc(34px * var(--ui-scale)); padding: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-size: var(--fs-xs); }
.cs-slots button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.cs-slots button small { color: var(--text-faint); font-size: 9px; }
.cs-grid { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 6px; align-items: center; font-size: var(--fs-s); color: var(--text-dim); }
.cs-grid input[type=number] { width: 100%; min-height: 0; height: calc(24px * var(--ui-scale)); }
.cs-grid small { color: var(--text-faint); }
.cs-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-s); color: var(--text-dim); }
.cs-row input[type=range] { flex: 1; min-width: 70px; }
.cs-row .ph-num { width: calc(56px * var(--ui-scale)); }
.cs-row button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--value); }
.cs-note { color: var(--text-faint); font-size: var(--fs-xs); }
`);

const blank = () => ({ set: false, docId: null, layerId: null, x: 0, y: 0, offset: null, w: 100, h: 100, angle: 0, flipX: false, flipY: false });

/** The source picture (document coordinates) a stroke samples. */
export function sampleCanvas(P, doc, { sample = 'current', ignoreAdj = false, layer = null } = {}) {
  if (sample === 'current') {
    const l = layer || doc.active;
    if (doc === P.doc) return P.layerAsDocCanvas(l);
    const c = document.createElement('canvas');
    c.width = doc.width;
    c.height = doc.height;
    const ct = l && doc.content(l);
    if (ct) c.getContext('2d').drawImage(ct.canvas, ct.x, ct.y);
    return c;
  }
  // adjustment layers are switched off while the picture is put together
  const hidden = ignoreAdj ? doc.layers.filter((l) => l.kind === 'adjust' && l.visible) : [];
  for (const l of hidden) l.visible = false;
  try {
    const upTo = sample === 'below' && layer ? doc.index(layer.id) + 1 : undefined;
    return doc.flatten({ upTo, fg: P.fg, bg: P.bg });
  } finally {
    for (const l of hidden) l.visible = true;
  }
}

export function installCloneSource(P) {
  const S = {
    active: 0,
    slots: [blank(), blank(), blank(), blank(), blank()],
    overlay: { show: true, opacity: 50, clipped: true, autoHide: true, invert: false, ...loadPref('photo.cloneOverlay', {}) },
  };
  P.cloneSource = S;
  const slot = () => S.slots[S.active];
  const docOf = (s) => P.docs.find((d) => d.id === s.docId) || null;
  const saveOverlay = () => savePref('photo.cloneOverlay', S.overlay);

  /** Source → document matrix: the source point lands on the destination anchor, scaled and turned. */
  const matrix = (s, anchor) => {
    const m = new DOMMatrix()
      .translate(anchor.x, anchor.y)
      .rotate(s.angle || 0)
      .scale((s.flipX ? -1 : 1) * (s.w / 100), (s.flipY ? -1 : 1) * (s.h / 100))
      .translate(-s.x, -s.y);
    return m;
  };
  /** Where the source point lands for a stroke starting at p (aligned keeps the offset). */
  const anchorFor = (s, p, aligned) => {
    if (aligned && s.offset) return { x: s.x - s.offset.x, y: s.y - s.offset.y };
    return { x: p.x, y: p.y };
  };

  const setSource = (p) => {
    const doc = P.doc;
    const s = slot();
    Object.assign(s, { set: true, docId: doc.id, layerId: doc.active?.id || null, x: Math.round(p.x), y: Math.round(p.y), offset: null });
    srcCache.key = '';
    toast(`복제 원본 ${S.active + 1}을(를) 정했습니다 (${s.x}, ${s.y}). 이제 칠할 곳을 끌어 보세요.`);
    P.emit('clonesource');
    P.overlay();
  };

  // the overlay's picture, kept until the source document changes
  const srcCache = { key: '', c: null };
  const overlaySource = (s, o) => {
    const doc = docOf(s);
    if (!doc) return null;
    const key = `${doc.id}:${doc.rev}:${o.sample}:${o.ignoreAdj}:${s.layerId}:${doc.active?.id}`;
    if (srcCache.key !== key) {
      srcCache.key = key;
      const layer = doc.layer(o.sample === 'current' && doc !== P.doc ? s.layerId : doc.active?.id) || doc.active;
      srcCache.c = sampleCanvas(P, doc, { sample: o.sample, ignoreAdj: o.ignoreAdj, layer });
    }
    return srcCache.c;
  };

  /** Draw the clone source over the view at the pointer, like Photoshop's overlay. */
  const drawOverlay = (E, g, toolId, painting) => {
    const s = slot();
    const ov = S.overlay;
    const p = E.hoverPoint;
    if (!s.set || !p) return;
    // the source point's cross
    if (docOf(s) === E.doc) {
      const [x, y] = E.toScreen(s.x, s.y);
      g.save();
      for (const [c, lw] of [['#000', 3], ['#fff', 1]]) {
        g.strokeStyle = c;
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(x - 8, y);
        g.lineTo(x + 8, y);
        g.moveTo(x, y - 8);
        g.lineTo(x, y + 8);
        g.stroke();
      }
      g.restore();
    }
    if (!ov.show || (painting && ov.autoHide)) return;
    const o = E.opts(toolId);
    const src = overlaySource(s, o);
    if (!src) return;
    const m = matrix(s, anchorFor(s, p, o.aligned !== false));
    const v = E.view;
    g.save();
    if (ov.clipped) {
      const [cx, cy] = E.toScreen(p.x, p.y);
      g.beginPath();
      g.arc(cx, cy, Math.max(4, (o.size * v.zoom) / 2), 0, Math.PI * 2);
      g.clip();
    }
    g.globalAlpha = clamp(ov.opacity, 0, 100) / 100;
    if (ov.invert) g.filter = 'invert(1)';
    g.transform(v.zoom, 0, 0, v.zoom, v.x, v.y);
    g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    g.drawImage(src, 0, 0);
    g.restore();
  };

  /** Start a stroke through the clone source (clone stamp and healing brush). */
  const startStroke = (E, toolId, p, e, extra) => {
    const s = slot();
    const doc = docOf(s);
    if (!s.set || !doc) {
      toast(s.set ? '복제 원본의 문서가 닫혔습니다. Alt를 누른 채 다시 원본을 누르세요.' : '먼저 Alt(휴대폰은 "원본 정하기" 버튼)를 누른 채 복제할 곳을 누르세요');
      return null;
    }
    const o = E.opts(toolId);
    const aligned = o.aligned !== false;
    const anchor = anchorFor(s, p, aligned);
    s.offset = { x: s.x - anchor.x, y: s.y - anchor.y };
    P.emit('clonesource');
    const layer = doc.layer(o.sample === 'current' && doc !== E.doc ? s.layerId : doc.active?.id) || doc.active;
    const bo = brushOpts(o, E, { label: extra.label });
    bo.srcCanvas = sampleCanvas(P, doc, { sample: o.sample || 'current', ignoreAdj: !!o.ignoreAdj, layer });
    bo.cloneSrc = bo.srcCanvas;
    bo.cloneXf = matrix(s, anchor);
    bo.cloneOffset = { x: 0, y: 0 };
    extra.prepare?.(bo, o);
    bo.engine = E.brushEngine(toolId, o, bo, 'clone');
    const st = new Stroke(E, 'clone', bo);
    return st;
  };

  // ---- the clone stamp
  const clone = TOOL_BY_ID.clone;
  clone.options = [...BRUSH_BAR, ALIGNED_OPT, SAMPLE_OPT, IGNORE_ADJ_OPT];
  // the phone's "원본 정하기" (editor.js) sets `source` on the tool
  Object.defineProperty(clone, 'source', {
    configurable: true,
    get: () => (slot().set ? { x: slot().x, y: slot().y } : null),
    set: (p) => {
      if (p) setSource(p);
    },
  });
  clone.down = function down(E, p, e) {
    if (e.altKey) return void setSource(p);
    if (!needRaster(E, '복제 도장')) return;
    this.st = startStroke(E, 'clone', p, e, { label: '복제 도장' });
    if (!this.st) return;
    this.st.to(p, e.pointerType === 'pen' ? e.pressure || 1 : 1);
    this.st.flush();
  };
  clone.overlay = function overlay(E, g) {
    drawOverlay(E, g, 'clone', !!this.st);
  };
  clone.leadButtons = () => [...(P.brushOptionButtons?.('clone') || []), panelButton()];
  clone.hover = (E) => E.overlay();

  const panelButton = () => h('button.small', { title: '복제 원본 패널', 'aria-label': '복제 원본 패널', onclick: () => P.showPanel('cloneSource') }, icon('stamp', 14));
  P.cloneSourceButton = panelButton;
  /** For the healing brush (brushes.js). */
  P.cloneStroke = startStroke;
  P.cloneOverlay = drawOverlay;
  P.setCloneSource = setSource;
  P.cloneSourceSet = () => slot().set;

  // ---- the panel
  const el = h('div.ph-panel.cs-panel');
  let selfChange = false;
  const render = () => {
    if (selfChange) return;
    const s = slot();
    const doc = docOf(s);
    const slots = h('div.cs-slots', S.slots.map((x, i) => h(`button${i === S.active ? '.on' : ''}`, {
      title: x.set ? `원본 ${i + 1}: ${docOf(x)?.name || '닫힌 문서'} (${x.x}, ${x.y})` : `원본 ${i + 1}: 아직 없음 (고른 뒤 Alt+클릭)`,
      'aria-label': `복제 원본 ${i + 1}`,
      onclick: () => {
        S.active = i;
        srcCache.key = '';
        render();
        P.overlay();
      },
    }, icon('stamp', 14), h('small', x.set ? `${i + 1}` : '-'))));
    const numIn = (val, onSet, step = 1) => {
      const n = h('input', { type: 'number', step, value: Math.round(val * 10) / 10 });
      n.addEventListener('change', () => {
        const v = +n.value;
        if (Number.isNaN(v)) return;
        selfChange = true;
        try {
          onSet(v);
        } finally {
          selfChange = false;
        }
        P.emit('clonesource');
        P.overlay();
      });
      return n;
    };
    const link = loadPref('photo.cloneLinkWH', true);
    const linkB = h(`button.small${link ? '.on' : ''}`, { title: '폭·높이 비율 고정', 'aria-label': '폭·높이 비율 고정', onclick: () => { savePref('photo.cloneLinkWH', !link); render(); } }, icon('link', 13));
    const flip = (k, label) => h(`button.small${s[k] ? '.on' : ''}`, { onclick: () => { s[k] = !s[k]; render(); P.overlay(); } }, label);
    const ov = S.overlay;
    const check = (k, label) => {
      const b = h('input', { type: 'checkbox', checked: !!ov[k] });
      b.addEventListener('change', () => {
        ov[k] = b.checked;
        saveOverlay();
        P.overlay();
      });
      return h('label.cs-row', b, h('span', label));
    };
    const opR = h('input', { type: 'range', min: 0, max: 100, value: ov.opacity, 'aria-label': '오버레이 불투명도' });
    const opN = h('input.ph-num', { type: 'number', min: 0, max: 100, value: ov.opacity, 'aria-label': '오버레이 불투명도' });
    const setOp = (v) => {
      ov.opacity = clamp(Math.round(+v), 0, 100);
      opR.value = ov.opacity;
      opN.value = ov.opacity;
      saveOverlay();
      P.overlay();
    };
    opR.addEventListener('input', () => setOp(opR.value));
    opN.addEventListener('change', () => setOp(opN.value));
    el.replaceChildren(
      slots,
      h('div.cs-note', s.set ? `원본 ${S.active + 1}: ${doc ? doc.name : '닫힌 문서'} · ${doc?.layer(s.layerId)?.name || ''} (${s.x}, ${s.y})` : '복제 도장이나 복구 브러시로 Alt+클릭하면 이 칸에 원본이 정해집니다'),
      h('div.cs-grid',
        h('span', '오프셋 X'), numIn(s.offset?.x ?? 0, (v) => { s.offset = { x: v, y: s.offset?.y ?? 0 }; }), h('small', 'px'),
        h('span', 'Y'), numIn(s.offset?.y ?? 0, (v) => { s.offset = { x: s.offset?.x ?? 0, y: v }; }), h('small', 'px'),
        h('span', 'W'), numIn(s.w, (v) => { if (link) s.h = clamp(v, 1, 1000) * (s.h / s.w || 1); s.w = clamp(v, 1, 1000); render(); }, 0.1), h('small', '%'),
        h('span', 'H'), numIn(s.h, (v) => { if (link) s.w = clamp(v, 1, 1000) * (s.w / s.h || 1); s.h = clamp(v, 1, 1000); render(); }, 0.1), h('small', '%'),
        h('span', '각도'), numIn(s.angle, (v) => { s.angle = clamp(v, -360, 360); }, 0.1), h('small', '°')),
      h('div.cs-row', linkB, flip('flipX', '가로 뒤집기'), flip('flipY', '세로 뒤집기'),
        h('button.small', { title: '크기 100%, 각도 0°, 뒤집기 없음', onclick: () => { Object.assign(s, { w: 100, h: 100, angle: 0, flipX: false, flipY: false }); render(); P.overlay(); } }, icon('reset', 13), '변형 초기화')),
      h('div.ph-sub', '오버레이'),
      check('show', '오버레이 표시'),
      h('label.cs-row', h('span', '불투명도'), opR, opN, h('small', '%')),
      h('div.cs-row', check('clipped', '클리핑'), check('autoHide', '자동 숨기기'), check('invert', '반전')),
      h('div.cs-note', '정렬을 켜면 끊어 칠해도 원본과의 간격(오프셋)이 그대로 유지됩니다. 오프셋을 직접 입력할 수도 있습니다.'),
    );
  };
  P.addPanel('cloneSource', '복제 원본', el, 'top');
  P.on('clonesource', render);
  P.on('doc', render);
  render();

  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['창'];
    if (!orig) return;
    P.menus['창'] = () => {
      const items = orig();
      const at = items.findIndex((it) => it?.label === '색상');
      const add = { label: '복제 원본', action: () => P.showPanel('cloneSource') };
      return at < 0 ? [...items, add] : [...items.slice(0, at), add, ...items.slice(at)];
    };
  }];
}

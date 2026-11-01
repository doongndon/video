// Camera Raw ▸ 마스킹 panel (Shift+W): the mask list with components, new masks (피사체, 하늘, 배경,
// 브러시, 선형 / 방사형 그레이디언트, 색상 / 광도 범위), add / subtract / intersect, rename, invert,
// duplicate, delete, the overlay, each mask's local sliders and the on-picture handles and brush.
// Processing lives in camrawmask.js; the dialog (camraw.js) hands pointer events here.

import { h } from '../util.js';
import { icon } from '../ui/icons.js';
import { toast, showMenu, inlineEdit, loadPref, savePref } from '../ui/common.js';
import { clamp } from './fxcore.js';
import { LOCAL_ADJ, COMP_TYPES, compLabel, newMask, newId, encodeMask, canvasAlpha } from './camrawmask.js';

const OPS = [['add', '추가', 'plus'], ['sub', '빼기', 'minus'], ['int', '교차', 'filter']];
const AI = new Set(['subject', 'sky', 'background']);
const r4 = (v) => Math.round(v * 10000) / 10000;
const typeIcon = (t) => COMP_TYPES.find((x) => x[0] === t)?.[2] || 'mask';

/**
 * ui: { p, render(), commit(), before (preview canvas), sampleAt(u, v, r) → [r, g, b], fullW, fullH,
 *       repaint() }. Returns { el, refresh(), pointerDown(pt, e), hover(pt), drawOn(g, pane), overlay(), key(e) }.
 */
export function maskingPanel(ui) {
  const st = {
    mask: null,
    comp: -1,
    fresh: false,
    hover: null,
    busy: false,
    overlay: { show: true, color: '#ff2d2d', opacity: 50, ...loadPref('crMaskOverlay', {}) },
    brush: { size: 20, feather: 50, flow: 100, density: 100, auto: false, erase: false, ...loadPref('crMaskBrush', {}) },
  };
  const masks = () => {
    if (!Array.isArray(ui.p.masks)) ui.p.masks = [];
    return ui.p.masks;
  };
  const cur = () => masks().find((m) => m.id === st.mask) || null;
  const curComp = () => cur()?.comps?.[st.comp] || null;
  const changed = (commit = true) => {
    refresh();
    ui.render();
    if (commit) ui.commit();
  };

  // ---- creating masks and components
  const makeComp = async (type, op) => {
    const c = { id: newId(), type, op, invert: false };
    if (AI.has(type)) {
      if (st.busy) return null;
      st.busy = true;
      toast(type === 'sky' ? '하늘을 찾는 중…' : '피사체를 찾는 중…');
      try {
        await new Promise((r) => setTimeout(r, 30));
        const { selectSubject, selectSky } = await import('./selectx.js');
        const sel = type === 'sky' ? selectSky(ui.before) : selectSubject(ui.before);
        if (!sel) {
          toast(type === 'sky' ? '하늘을 찾지 못했습니다. 하늘이 사진 위쪽 가장자리에 닿아 있어야 해요.' : '피사체를 찾지 못했습니다. 브러시나 그레이디언트로 직접 칠해 보세요.');
          return null;
        }
        const a = canvasAlpha(sel);
        if (type === 'background') for (let i = 0; i < a.length; i++) a[i] = 1 - a[i];
        c.m = encodeMask(a, sel.width, sel.height);
      } finally {
        st.busy = false;
      }
    } else if (type === 'brush') c.strokes = [];
    else if (type === 'linear') Object.assign(c, { x0: 0.5, y0: 0.08, x1: 0.5, y1: 0.5 });
    else if (type === 'radial') Object.assign(c, { cx: 0.5, cy: 0.5, rx: 0.22, ry: 0.16, angle: 0, feather: 50 });
    else if (type === 'color') Object.assign(c, { samples: [], refine: 50 });
    else if (type === 'lum') Object.assign(c, { lo: 60, hi: 100, smooth: 30 });
    st.fresh = type === 'linear' || type === 'radial';
    return c;
  };
  const create = async (type) => {
    const c = await makeComp(type, 'add');
    if (!c) return;
    const m = newMask(`마스크 ${masks().length + 1}`);
    m.comps.push(c);
    masks().push(m);
    st.mask = m.id;
    st.comp = 0;
    changed();
    hint(type);
  };
  const addTo = async (type, op) => {
    const m = cur();
    if (!m) return create(type);
    const c = await makeComp(type, op);
    if (!c) return;
    m.comps.push(c);
    st.comp = m.comps.length - 1;
    changed();
    hint(type);
  };
  const hint = (type) => {
    if (type === 'linear' || type === 'radial') toast('그림 위에서 끌어 그리세요. 점을 끌어 옮기고 크기를 바꿉니다.');
    else if (type === 'brush') toast('그림 위를 칠하세요. Alt를 누르고 칠하면 지웁니다.');
    else if (type === 'color' || type === 'lum') toast('스포이드로 그림에서 고를 곳을 누르세요.');
  };
  const typeMenu = (e, op) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(COMP_TYPES.map(([t, label, , key]) => ({ label: key ? `${label}  (${key})` : label, action: () => (op ? addTo(t, op) : create(t)) })), r.left, r.bottom + 2);
  };

  // ---- mask commands
  const rename = (span, m) => inlineEdit(span, { width: '140px', onCommit: (v) => { if (v.trim()) { m.name = v.trim(); changed(); } } });
  const duplicate = (m) => {
    const c = structuredClone(m);
    c.id = newId();
    c.name = `${m.name} 복사`;
    for (const k of c.comps) k.id = newId();
    masks().splice(masks().indexOf(m) + 1, 0, c);
    st.mask = c.id;
    st.comp = 0;
    changed();
  };
  const remove = (m) => {
    const all = masks();
    all.splice(all.indexOf(m), 1);
    st.mask = all[0]?.id || null;
    st.comp = all[0] ? 0 : -1;
    changed();
  };
  const maskMenu = (e, m) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: '이름 바꾸기', action: () => rename(list.querySelector(`[data-mid="${m.id}"] .crm-name`), m) },
      { label: m.invert ? '마스크 반전 해제' : '마스크 반전', action: () => { m.invert = !m.invert; changed(); } },
      { label: '마스크 복제', action: () => duplicate(m) },
      { label: m.hidden ? '마스크 보이기' : '마스크 숨기기', action: () => { m.hidden = !m.hidden; changed(); } },
      '-',
      { label: '마스크 삭제', action: () => remove(m) },
    ], r.left, r.bottom + 2);
  };

  // ---- generic slider bound to an object
  const field = (obj, key, label, min, max, step = 1, def = 0, bg = null, after = null) => {
    const v0 = obj[key] ?? def;
    const range = h('input', { type: 'range', min, max, step, value: v0, 'aria-label': label });
    if (bg) range.style.background = bg;
    const num = h('input.ph-num', { type: 'number', min, max, step, value: v0 });
    const upd = (v, done) => {
      obj[key] = clamp(+v || 0, min, max);
      range.value = obj[key];
      num.value = obj[key];
      after?.();
      ui.render();
      if (done) changed(true);
    };
    range.addEventListener('input', () => upd(range.value));
    range.addEventListener('change', () => upd(range.value, true));
    num.addEventListener('change', () => upd(num.value, true));
    const lab = h('span', { title: '두 번 누르면 기본값' }, label);
    lab.addEventListener('dblclick', () => upd(def, true));
    range.addEventListener('dblclick', () => upd(def, true));
    return h('label.cr-row', { dataset: { key } }, lab, range, num);
  };

  // ---- the panel
  const overlayChk = h('input', { type: 'checkbox', checked: st.overlay.show });
  const overlayCol = h('input', { type: 'color', value: st.overlay.color, title: '오버레이 색상', 'aria-label': '오버레이 색상' });
  const overlayOp = h('input.ph-num', { type: 'number', min: 0, max: 100, value: st.overlay.opacity, title: '오버레이 불투명도 (%)', 'aria-label': '오버레이 불투명도' });
  const saveOverlay = () => {
    st.overlay.show = overlayChk.checked;
    st.overlay.color = overlayCol.value;
    st.overlay.opacity = clamp(+overlayOp.value || 0, 0, 100);
    savePref('crMaskOverlay', st.overlay);
    ui.render();
  };
  overlayChk.addEventListener('change', saveOverlay);
  overlayCol.addEventListener('input', saveOverlay);
  overlayOp.addEventListener('change', saveOverlay);
  const newBtn = h('button.small', { type: 'button', title: '새 마스크 만들기' }, icon('plus', 14), ' 새 마스크');
  newBtn.addEventListener('click', (e) => typeMenu(e, null));

  const startGrid = h('div.crm-new');
  for (const [t, label, ic, key] of COMP_TYPES) {
    const b = h('button', { type: 'button', title: key ? `${label} (${key})` : label, dataset: { type: t } }, icon(ic, 18), h('span', label));
    b.addEventListener('click', () => create(t));
    startGrid.append(b);
  }
  const startBox = h('div.crm-start', h('div.cr-sub', '새 마스크 만들기'), startGrid);
  const list = h('div.crm-list');
  const compBox = h('div.crm-comp-box');
  const adjBox = h('div.crm-adj');
  const clearAll = h('button.small', { type: 'button' }, icon('trash', 14), ' 모든 마스크 삭제');
  clearAll.addEventListener('click', () => {
    ui.p.masks = [];
    st.mask = null;
    st.comp = -1;
    changed();
  });
  const el = h('div.crm',
    h('div.cr-line.crm-head', h('b', '마스크'), newBtn, h('label.cr-line', overlayChk, '오버레이 표시'), overlayCol, overlayOp, h('span.note', '%')),
    startBox, list, compBox, adjBox, h('div.cr-line', clearAll));

  const iconBtn = (name, title, fn, on = false) => {
    const b = h(`button.crm-ib${on ? '.on' : ''}`, { type: 'button', title, 'aria-label': title }, icon(name, 14));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn(e);
    });
    return b;
  };

  function refresh() {
    const all = masks();
    if (st.mask && !cur()) st.mask = null;
    if (!st.mask && all.length) st.mask = all[all.length - 1].id;
    const m = cur();
    if (m && (st.comp < 0 || st.comp >= m.comps.length)) st.comp = m.comps.length - 1;
    startBox.hidden = all.length > 0;
    clearAll.hidden = !all.length;
    list.replaceChildren(...all.map((mm) => {
      const sel = mm === m;
      const name = h('span.crm-name', mm.name);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        rename(name, mm);
      });
      const row = h('div.crm-row',
        iconBtn(mm.hidden ? 'eyeOff' : 'eye', mm.hidden ? '마스크 보이기' : '마스크 숨기기', () => { mm.hidden = !mm.hidden; changed(); }, !mm.hidden),
        icon('mask', 14), name,
        mm.invert ? h('span.crm-badge', '반전') : null,
        iconBtn('more', '마스크 옵션 (이름 바꾸기, 반전, 복제, 삭제)', (e) => maskMenu(e, mm)));
      const box = h(`div.crm-mask${sel ? '.sel' : ''}`, { dataset: { mid: mm.id } }, row);
      row.addEventListener('click', () => {
        if (st.mask === mm.id) return;
        st.mask = mm.id;
        st.comp = mm.comps.length - 1;
        st.fresh = false;
        refresh();
        ui.render();
      });
      if (sel) {
        mm.comps.forEach((c, i) => {
          const op = OPS.find((o) => o[0] === c.op) || OPS[0];
          const cr = h(`div.crm-comp${i === st.comp ? '.sel' : ''}`, { dataset: { i } },
            i ? h('span.crm-op', { title: op[1] }, icon(op[2], 12)) : h('span.crm-op'),
            icon(typeIcon(c.type), 14), h('span.crm-cname', compLabel(c.type)),
            c.invert ? h('span.crm-badge', '반전') : null,
            iconBtn('swap', '구성 요소 반전', () => { c.invert = !c.invert; changed(); }, c.invert),
            iconBtn('trash', '구성 요소 삭제', () => {
              mm.comps.splice(i, 1);
              if (!mm.comps.length) remove(mm);
              else {
                st.comp = Math.min(st.comp, mm.comps.length - 1);
                changed();
              }
            }));
          cr.addEventListener('click', () => {
            st.comp = i;
            st.fresh = false;
            refresh();
            ui.render();
          });
          box.append(cr);
        });
        const ops = h('div.crm-ops', ...OPS.map(([op, label, ic]) => {
          const b = h('button.small', { type: 'button', title: `${label}: 이 마스크에 구성 요소를 ${label === '교차' ? '겹치는 부분만 남기도록 교차' : label}합니다` }, icon(ic, 12), ` ${label}`);
          b.addEventListener('click', (e) => typeMenu(e, op));
          return b;
        }));
        box.append(ops);
      }
      return box;
    }));
    compBox.replaceChildren(...compSettings());
    adjBox.replaceChildren(...adjSettings());
    ui.repaint();
  }

  function compSettings() {
    const c = curComp();
    if (!c) return [];
    const m = cur();
    const out = [h('div.cr-sub', compLabel(c.type))];
    if (m.comps.indexOf(c) > 0) {
      const opSel = h('select', { 'aria-label': '구성 요소 합치기' }, ...OPS.map(([v, t]) => h('option', { value: v }, t)));
      opSel.value = c.op || 'add';
      opSel.addEventListener('change', () => { c.op = opSel.value; changed(); });
      out.push(h('div.cr-line', h('span', '합치기'), opSel));
    }
    const inv = h('input', { type: 'checkbox', checked: !!c.invert });
    inv.addEventListener('change', () => { c.invert = inv.checked; changed(); });
    if (c.type === 'brush') {
      const B = st.brush;
      const save = () => savePref('crMaskBrush', B);
      const mode = (erase) => {
        const b = h(`button.small${!!B.erase === erase ? '.on' : ''}`, { type: 'button' }, icon(erase ? 'eraser' : 'brush', 14), erase ? ' 지우기' : ' 브러시');
        b.addEventListener('click', () => { B.erase = erase; save(); refresh(); });
        return b;
      };
      const auto = h('input', { type: 'checkbox', checked: !!B.auto });
      auto.addEventListener('change', () => { B.auto = auto.checked; save(); });
      out.push(h('div.cr-line', mode(false), mode(true)),
        field(B, 'size', '크기', 1, 100, 1, 20, null, save),
        field(B, 'feather', '페더', 0, 100, 1, 50, null, save),
        field(B, 'flow', '흐름', 1, 100, 1, 100, null, save),
        field(B, 'density', '밀도', 1, 100, 1, 100, null, save),
        h('label.cr-line', auto, '자동 마스크 (비슷한 색에만 칠하기)'),
        h('div.note', '[ ]로 크기, Alt를 누른 채 칠하면 지웁니다.'));
    } else if (c.type === 'linear') {
      out.push(h('div.note', '그림 위에서 끌어 새로 그립니다. 시작점(효과 100%)·끝점(0%)·가운데 점을 끌어 옮깁니다.'));
    } else if (c.type === 'radial') {
      out.push(field(c, 'feather', '페더', 0, 100, 1, 50), h('div.note', '그림 위에서 끌어 새로 그립니다. 가운데 점으로 옮기고, 가장자리 점으로 크기를, 타원 바로 바깥을 끌어 회전합니다.'));
    } else if (c.type === 'color') {
      const sw = h('div.cr-line', h('span', '샘플'), ...(c.samples || []).map((s, i) => {
        const b = h('button.crm-swatch', { type: 'button', title: '눌러서 이 색 빼기', style: { background: `rgb(${s[0]},${s[1]},${s[2]})` } });
        b.addEventListener('click', () => { c.samples.splice(i, 1); changed(); });
        return b;
      }), c.samples?.length ? null : h('span.note', '그림을 눌러 색을 고르세요'));
      out.push(sw, field(c, 'refine', '다듬기', 0, 100, 1, 50), h('div.note', '스포이드: 누르면 그 색, Shift+클릭으로 색 추가(최대 5개).'));
    } else if (c.type === 'lum') {
      out.push(field(c, 'lo', '범위: 시작', 0, 100, 1, 60), field(c, 'hi', '범위: 끝', 0, 100, 1, 100), field(c, 'smooth', '부드럽게', 0, 100, 1, 30),
        h('div.note', '스포이드: 그림을 누르면 그 밝기 둘레로 범위를 잡습니다.'));
    } else out.push(h('div.note', c.type === 'sky' ? '사진에서 찾은 하늘입니다. 브러시를 빼기로 더해 다듬을 수 있습니다.' : c.type === 'background' ? '피사체를 뺀 나머지입니다.' : '사진에서 찾은 주요 피사체입니다. 브러시를 추가·빼기로 더해 다듬을 수 있습니다.'));
    out.push(h('label.cr-line', inv, '반전'));
    return out;
  }

  function adjSettings() {
    const m = cur();
    if (!m) return [];
    if (!m.adj) m.adj = {};
    const A = m.adj;
    const swatch = h('span.crm-colsw');
    const paintSw = () => {
      swatch.style.background = A.colorS > 0 ? `hsla(${A.colorH || 0},100%,50%,${0.3 + (A.colorS / 100) * 0.7})` : 'transparent';
    };
    paintSw();
    const reset = h('button.small', { type: 'button', title: '이 마스크의 슬라이더를 모두 0으로' }, '모두 재설정');
    reset.addEventListener('click', () => { m.adj = {}; m.amount = 100; changed(); });
    return [
      h('div.cr-sub', `${m.name} 조정`),
      field(m, 'amount', '양', 0, 200, 1, 100),
      ...LOCAL_ADJ.map(([key, label, min, max, step, bg]) => field(A, key, label, min, max, step, 0, bg)),
      h('div.cr-line', h('b', '색상'), swatch),
      field(A, 'colorH', '색조', 0, 360, 1, 0, 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', paintSw),
      field(A, 'colorS', '채도', 0, 100, 1, 0, null, paintSw),
      h('div.cr-line', reset),
    ];
  }

  // ---- on the picture
  const handles = (c, pane) => {
    const S = (u, v) => ui.toScreen(pane, u, v);
    if (c.type === 'linear') {
      return [['start', S(c.x0, c.y0)], ['end', S(c.x1, c.y1)], ['mid', S((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)]];
    }
    if (c.type === 'radial') {
      const L = Math.max(ui.fullW, ui.fullH);
      const ca = Math.cos(c.angle || 0);
      const sa = Math.sin(c.angle || 0);
      const at = (lx, ly) => S(c.cx + (lx * ca - ly * sa) * L / ui.fullW, c.cy + (lx * sa + ly * ca) * L / ui.fullH);
      return [['center', S(c.cx, c.cy)], ['right', at(c.rx, 0)], ['left', at(-c.rx, 0)], ['bottom', at(0, c.ry)], ['top', at(0, -c.ry)]];
    }
    return [];
  };
  /** Full-picture pixel position of a pointer point. */
  const px = (pt) => [pt.u * ui.fullW, pt.v * ui.fullH];

  function pointerDown(pt, e) {
    const m = cur();
    const c = curComp();
    if (!m || !c || !pt) return null;
    const dpr = window.devicePixelRatio || 1;
    if (c.type === 'brush') {
      const B = st.brush;
      const stroke = { r: r4(B.size / 400), feather: B.feather, flow: B.flow, density: B.density, erase: !!(B.erase || e.altKey), auto: !!B.auto, pts: [] };
      const add = (q) => {
        const col = stroke.auto ? ui.sampleAt(q.u, q.v, 1) : null;
        stroke.pts.push(col ? [r4(q.u), r4(q.v), ...col] : [r4(q.u), r4(q.v)]);
      };
      add(pt);
      c.strokes.push(stroke);
      ui.render();
      let last = pt;
      return {
        move(q) {
          if (Math.hypot(q.x - last.x, q.y - last.y) < 3 * dpr) return;
          last = q;
          add(q);
          ui.render();
        },
        up() { changed(); },
      };
    }
    if (c.type === 'color' || c.type === 'lum') {
      const s = ui.sampleAt(pt.u, pt.v, 2);
      if (c.type === 'color') {
        if (e.shiftKey && c.samples.length < 5) c.samples.push(s);
        else c.samples = [s];
      } else {
        const L = (0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]) / 2.55;
        c.lo = Math.round(clamp(L - 15, 0, 100));
        c.hi = Math.round(clamp(L + 15, 0, 100));
      }
      changed();
      return { move() {}, up() {} };
    }
    if (c.type !== 'linear' && c.type !== 'radial') return null;
    const hs = handles(c, pt.pane);
    let hit = null;
    let best = 14 * dpr;
    for (const [id, q] of hs) {
      const d = Math.hypot(q.x - pt.x, q.y - pt.y);
      if (d < best) {
        best = d;
        hit = id;
      }
    }
    const [X0, Y0] = px(pt);
    const L = Math.max(ui.fullW, ui.fullH);
    const start = structuredClone(c);
    let mode = hit;
    if (!mode && c.type === 'radial' && !st.fresh) {
      // just outside the ellipse: rotate
      const ca = Math.cos(c.angle || 0);
      const sa = Math.sin(c.angle || 0);
      const dx = X0 - c.cx * ui.fullW;
      const dy = Y0 - c.cy * ui.fullH;
      const d = Math.hypot((dx * ca + dy * sa) / (c.rx * L), (-dx * sa + dy * ca) / (c.ry * L));
      if (d > 1 && d < 1.35) mode = 'rotate';
    }
    if (!mode) mode = 'draw';
    const move = (q) => {
      const [X, Y] = px(q);
      const du = q.u - pt.u;
      const dv = q.v - pt.v;
      if (c.type === 'linear') {
        if (mode === 'draw') Object.assign(c, { x0: r4(pt.u), y0: r4(pt.v), x1: r4(q.u), y1: r4(q.v) });
        else if (mode === 'start') Object.assign(c, { x0: r4(start.x0 + du), y0: r4(start.y0 + dv) });
        else if (mode === 'end') Object.assign(c, { x1: r4(start.x1 + du), y1: r4(start.y1 + dv) });
        else Object.assign(c, { x0: r4(start.x0 + du), y0: r4(start.y0 + dv), x1: r4(start.x1 + du), y1: r4(start.y1 + dv) });
      } else {
        const cx = start.cx * ui.fullW;
        const cy = start.cy * ui.fullH;
        const ca = Math.cos(start.angle || 0);
        const sa = Math.sin(start.angle || 0);
        const lx = ((X - cx) * ca + (Y - cy) * sa) / L;
        const ly = (-(X - cx) * sa + (Y - cy) * ca) / L;
        if (mode === 'draw') Object.assign(c, { cx: r4(pt.u), cy: r4(pt.v), rx: r4(Math.max(0.01, Math.abs(X - X0) / L)), ry: r4(Math.max(0.01, Math.abs(Y - Y0) / L)), angle: 0 });
        else if (mode === 'center') Object.assign(c, { cx: r4(start.cx + du), cy: r4(start.cy + dv) });
        else if (mode === 'left' || mode === 'right') c.rx = r4(Math.max(0.01, Math.abs(lx)));
        else if (mode === 'top' || mode === 'bottom') c.ry = r4(Math.max(0.01, Math.abs(ly)));
        else if (mode === 'rotate') {
          const a0 = Math.atan2(Y0 - cy, X0 - cx);
          const a1 = Math.atan2(Y - cy, X - cx);
          c.angle = Math.round(((start.angle || 0) + a1 - a0) * 1000) / 1000;
        }
      }
      ui.render();
    };
    return {
      move,
      up(q) {
        // a click without a drag on empty picture keeps the old gradient
        if (mode === 'draw' && q && Math.hypot(q.x - pt.x, q.y - pt.y) < 4 * dpr) Object.assign(c, start);
        st.fresh = false;
        changed();
      },
    };
  }

  /** Handles of the selected gradient and the brush outline, drawn on the view (device pixels). */
  function drawOn(g, pane) {
    const c = curComp();
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    g.save();
    g.lineWidth = 1.5 * dpr;
    const dot = (q, r = 5, fill = '#fff') => {
      g.beginPath();
      g.arc(q.x, q.y, r * dpr, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = '#000';
      g.stroke();
    };
    if (c.type === 'linear') {
      const [[, a], [, b], [, mid]] = handles(c, pane);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 4000;
      const ny = (dx / len) * 4000;
      const line = (q, dash) => {
        g.setLineDash(dash ? [6 * dpr, 4 * dpr] : []);
        g.strokeStyle = 'rgba(0,0,0,.6)';
        g.lineWidth = 3 * dpr;
        g.beginPath();
        g.moveTo(q.x - nx, q.y - ny);
        g.lineTo(q.x + nx, q.y + ny);
        g.stroke();
        g.strokeStyle = '#fff';
        g.lineWidth = 1.2 * dpr;
        g.stroke();
      };
      line(a, false);
      line(mid, true);
      line(b, false);
      g.setLineDash([]);
      dot(a, 5);
      dot(b, 5, '#bbb');
      dot(mid, 6, '#2d8cff');
    } else if (c.type === 'radial') {
      const L = Math.max(ui.fullW, ui.fullH);
      const s = pane.s;
      const cen = ui.toScreen(pane, c.cx, c.cy);
      g.translate(cen.x, cen.y);
      g.rotate(c.angle || 0);
      const ell = (k, dash) => {
        g.setLineDash(dash ? [6 * dpr, 4 * dpr] : []);
        g.beginPath();
        g.ellipse(0, 0, Math.max(1, c.rx * L * s * k), Math.max(1, c.ry * L * s * k), 0, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(0,0,0,.6)';
        g.lineWidth = 3 * dpr;
        g.stroke();
        g.strokeStyle = '#fff';
        g.lineWidth = 1.2 * dpr;
        g.stroke();
      };
      ell(1, false);
      if ((c.feather ?? 50) > 0) ell(1 - (c.feather ?? 50) / 100, true);
      g.setLineDash([]);
      g.setTransform(1, 0, 0, 1, 0, 0);
      const hs = handles(c, pane);
      for (const [id, q] of hs) dot(q, id === 'center' ? 6 : 4.5, id === 'center' ? '#2d8cff' : '#fff');
    } else if (c.type === 'brush' && st.hover && st.hover.pane === pane) {
      const R = (st.brush.size / 400) * Math.max(ui.fullW, ui.fullH) * pane.s;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(st.hover.x, st.hover.y, R, 0, Math.PI * 2);
      g.stroke();
      const inner = R * (1 - st.brush.feather / 100);
      if (inner > 2) {
        g.setLineDash([4 * dpr, 3 * dpr]);
        g.beginPath();
        g.arc(st.hover.x, st.hover.y, inner, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.restore();
  }

  const cursor = () => {
    const c = curComp();
    if (!c) return '';
    if (c.type === 'brush') return 'none';
    if (c.type === 'color' || c.type === 'lum') return 'crosshair';
    if (c.type === 'linear' || c.type === 'radial') return 'crosshair';
    return '';
  };

  /** Keys while the masking panel is open; true when used. */
  function key(e) {
    const k = e.key;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!plain) return false;
    const c = curComp();
    const quick = (type) => {
      if (c?.type === type) return true;
      create(type);
      return true;
    };
    if (e.code === 'KeyK' && !e.shiftKey) return quick('brush');
    if (e.code === 'KeyG' && !e.shiftKey) return quick('linear');
    if (e.code === 'KeyJ' && !e.shiftKey) return quick('radial');
    if (e.code === 'KeyJ' && e.shiftKey) return quick('color');
    if (e.code === 'KeyO' && !e.shiftKey) {
      overlayChk.checked = !overlayChk.checked;
      saveOverlay();
      return true;
    }
    if ((k === '[' || k === ']') && c?.type === 'brush') {
      st.brush.size = clamp(st.brush.size + (k === ']' ? 3 : -3), 1, 100);
      savePref('crMaskBrush', st.brush);
      refresh();
      return true;
    }
    return false;
  }

  refresh();
  return {
    el,
    refresh,
    pointerDown,
    drawOn,
    key,
    cursor,
    hover(pt) {
      st.hover = pt;
      if (curComp()?.type === 'brush') ui.repaint();
    },
    /** The mask to tint on the picture, or null. */
    overlay: () => (st.overlay.show && cur() ? { mask: cur(), color: st.overlay.color, opacity: st.overlay.opacity / 100 } : null),
    active: () => !!curComp(),
  };
}

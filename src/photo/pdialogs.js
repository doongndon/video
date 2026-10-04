// Photo editor dialogs. Each takes the editor API `P`.

import { h, clamp } from '../util.js';
import { openModal, formRow, toast } from '../ui/common.js';
import { makeCanvas, cloneCanvas } from './doc.js';
import { ADJUSTMENTS, defaultParams, applyAdjustment, curveLut, FILTERS, defaultFilterParams, applyFilter } from './adjust.js';
import { EXPORT_TYPES } from './io.js';

export const DOC_PRESETS = [
  ['1920x1080', '유튜브·동영상 1920 × 1080', 1920, 1080],
  ['1080x1920', '쇼츠·릴스·스토리 1080 × 1920', 1080, 1920],
  ['1080x1080', '인스타 정사각형 1080 × 1080', 1080, 1080],
  ['1080x1350', '인스타 세로 1080 × 1350', 1080, 1350],
  ['1280x720', '유튜브 썸네일 1280 × 720', 1280, 720],
  ['1200x628', '웹 배너·링크 1200 × 628', 1200, 628],
  ['2480x3508', 'A4 인쇄 (300ppi) 2480 × 3508', 2480, 3508],
  ['800x600', '작은 그림 800 × 600', 800, 600],
];

const num = (value, min, max, step = 1, w = '90px') => h('input', { type: 'number', value, min, max, step, style: { width: w } });
const sel = (opts, value) => {
  const s = h('select', opts.map(([v, t]) => h('option', { value: v }, t)));
  s.value = value;
  return s;
};
const chk = (checked, label) => {
  const box = h('input', { type: 'checkbox', checked });
  return { el: h('label.inline', box, label), box };
};

// ---------------------------------------------------------------- new document

export function newDocDialog(P) {
  const name = h('input', { type: 'text', value: `제목 없음-${P.docs.length + 1}`, style: { width: '100%' } });
  const preset = sel([...DOC_PRESETS.map(([id, t]) => [id, t]), ['custom', '직접 입력']], '1920x1080');
  const w = num(1920, 1, 12000);
  const hh = num(1080, 1, 12000);
  const bg = sel([['#ffffff', '흰색'], ['transparent', '투명'], ['fg', '전경색'], ['bg', '배경색'], ['#000000', '검정']], '#ffffff');
  preset.addEventListener('change', () => {
    const p = DOC_PRESETS.find((x) => x[0] === preset.value);
    if (p) {
      w.value = p[2];
      hh.value = p[3];
    }
  });
  for (const el of [w, hh]) el.addEventListener('input', () => { preset.value = 'custom'; });
  openModal({
    title: '새 문서',
    width: '480px',
    body: [formRow('이름', name), formRow('크기', preset), formRow('폭 × 높이 (px)', w, '×', hh), formRow('배경', bg)],
    buttons: [{ label: '취소' }, {
      label: '만들기', primary: true, action: () => {
        const W = clamp(Math.round(+w.value || 1), 1, 12000);
        const H = clamp(Math.round(+hh.value || 1), 1, 12000);
        if (W * H > 80e6) {
          toast('너무 큰 문서입니다 (최대 약 8000만 픽셀)');
          return false;
        }
        const b = bg.value === 'fg' ? P.fg : bg.value === 'bg' ? P.bg : bg.value;
        P.newDoc({ name: name.value.trim() || '제목 없음', width: W, height: H, background: b });
        return true;
      },
    }],
  });
}

// ---------------------------------------------------------------- image / canvas size

export function imageSizeDialog(P) {
  const doc = P.doc;
  const w = num(doc.width, 1, 12000);
  const hh = num(doc.height, 1, 12000);
  const pct = num(100, 1, 1000, 1, '70px');
  const keep = chk(true, '비율 유지');
  const ratio = doc.width / doc.height;
  w.addEventListener('input', () => {
    if (keep.box.checked) hh.value = Math.round(+w.value / ratio);
    pct.value = Math.round((+w.value / doc.width) * 100);
  });
  hh.addEventListener('input', () => {
    if (keep.box.checked) w.value = Math.round(+hh.value * ratio);
    pct.value = Math.round((+hh.value / doc.height) * 100);
  });
  pct.addEventListener('input', () => {
    w.value = Math.round((doc.width * +pct.value) / 100);
    hh.value = Math.round((doc.height * +pct.value) / 100);
  });
  openModal({
    title: '이미지 크기',
    width: '440px',
    body: [formRow('폭 × 높이 (px)', w, '×', hh), formRow('배율 (%)', pct), formRow('', keep.el), h('div.note', '모든 레이어의 픽셀을 다시 계산합니다(리샘플링). 글자·모양 레이어는 크기 값만 바뀌어 선명하게 유지됩니다.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.resizeImage(clamp(Math.round(+w.value), 1, 12000), clamp(Math.round(+hh.value), 1, 12000)) }],
  });
}

export function canvasSizeDialog(P) {
  const doc = P.doc;
  const w = num(doc.width, 1, 12000);
  const hh = num(doc.height, 1, 12000);
  let anchor = [1, 1];
  const grid = h('div.ph-anchor', [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => {
    const b = h('button.small', { onclick: () => { anchor = [c, r]; paint(); }, 'aria-label': `기준점 ${r * 3 + c + 1}` }, '');
    b.dataset.c = c;
    b.dataset.r = r;
    return b;
  })));
  const paint = () => grid.querySelectorAll('button').forEach((b) => { b.textContent = +b.dataset.c === anchor[0] && +b.dataset.r === anchor[1] ? '●' : ''; });
  paint();
  openModal({
    title: '캔버스 크기',
    width: '420px',
    body: [formRow('새 폭 × 높이 (px)', w, '×', hh), formRow('기준점', grid), h('div.note', '이미지는 그대로 두고 캔버스(작업 영역)만 늘리거나 줄입니다. 늘어난 곳은 투명합니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const W = clamp(Math.round(+w.value), 1, 12000);
        const H = clamp(Math.round(+hh.value), 1, 12000);
        P.cropTo({ x: Math.round(((doc.width - W) * anchor[0]) / 2), y: Math.round(((doc.height - H) * anchor[1]) / 2), w: W, h: H }, false, '캔버스 크기');
      },
    }],
  });
}

// ---------------------------------------------------------------- param editors (shared by adjustments, filters and the properties panel)

/** Controls for a params definition list. onChange(params, done). */
export function paramEditors(defs, params, onChange) {
  const rows = [];
  for (const [key, label, min, max, , kind] of defs) {
    const type = kind === 'bool' ? 'bool' : kind === 'color' ? 'color' : kind === 'curve' ? 'curve' : 'range';
    if (type === 'bool') {
      const c = chk(!!params[key], label);
      c.box.addEventListener('change', () => {
        params[key] = c.box.checked;
        onChange(params, true);
      });
      rows.push(h('div.ph-prow', c.el));
    } else if (type === 'color') {
      const inp = h('input', { type: 'color', value: params[key] });
      inp.addEventListener('input', () => {
        params[key] = inp.value;
        onChange(params, false);
      });
      inp.addEventListener('change', () => onChange(params, true));
      rows.push(h('label.ph-prow', h('span', label), inp));
    } else if (type === 'curve') {
      rows.push(curveEditor(params[key], (pts, done) => {
        params[key] = pts;
        onChange(params, done);
      }));
    } else {
      const step = kind || (max - min > 20 ? 1 : 0.01);
      const r = h('input', { type: 'range', min, max, step, value: params[key] });
      const n = h('input.ph-num', { type: 'number', min, max, step, value: params[key] });
      const set = (v, done) => {
        params[key] = clamp(+v, min, max);
        r.value = params[key];
        n.value = params[key];
        onChange(params, done);
      };
      r.addEventListener('input', () => set(r.value, false));
      r.addEventListener('change', () => set(r.value, true));
      n.addEventListener('change', () => set(n.value, true));
      rows.push(h('label.ph-prow', h('span', label), r, n));
    }
  }
  return rows;
}

/** A small curves editor: click to add a point, drag to move, double-click a point to remove it. */
export function curveEditor(points, onChange) {
  const S = 220;
  const c = h('canvas.ph-curve', { width: S, height: S, 'aria-label': '곡선' });
  let pts = points.map((p) => [...p]);
  let drag = -1;
  const g = c.getContext('2d');
  const draw = () => {
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = '#30353e';
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo((S * i) / 4, 0);
      g.lineTo((S * i) / 4, S);
      g.moveTo(0, (S * i) / 4);
      g.lineTo(S, (S * i) / 4);
      g.stroke();
    }
    const lut = curveLut(pts);
    g.strokeStyle = '#e8eaed';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x < 256; x++) {
      const px = (x / 255) * S;
      const py = S - (lut[x] / 255) * S;
      if (x) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.stroke();
    g.lineWidth = 1;
    for (const [x, y] of pts) {
      g.fillStyle = '#fff';
      g.fillRect((x / 255) * S - 4, S - (y / 255) * S - 4, 8, 8);
    }
  };
  const at = (e) => {
    const r = c.getBoundingClientRect();
    return [clamp(((e.clientX - r.left) / r.width) * 255, 0, 255), clamp((1 - (e.clientY - r.top) / r.height) * 255, 0, 255)];
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    drag = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 12);
    if (drag < 0) {
      pts.push([Math.round(x), Math.round(y)]);
      pts.sort((a, b) => a[0] - b[0]);
      drag = pts.findIndex(([px]) => px === Math.round(x));
    }
    draw();
    onChange(pts, false);
  });
  c.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = at(e);
    const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
    pts[drag] = [Math.round(drag === 0 ? 0 : drag === pts.length - 1 ? 255 : clamp(x, lo, hi)), Math.round(y)];
    if (drag === 0 || drag === pts.length - 1) pts[drag][0] = drag === 0 ? Math.min(pts[drag][0], lo) : 255;
    draw();
    onChange(pts.map((p) => [...p]), false);
  });
  c.addEventListener('pointerup', () => {
    if (drag >= 0) onChange(pts.map((p) => [...p]), true);
    drag = -1;
  });
  c.addEventListener('dblclick', (e) => {
    const [x, y] = at(e);
    const i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 12);
    if (i > 0 && i < pts.length - 1) {
      pts.splice(i, 1);
      draw();
      onChange(pts.map((p) => [...p]), true);
    }
  });
  draw();
  return h('div.ph-curvewrap', c, h('div.note', '누르면 점 추가 · 끌어서 이동 · 두 번 눌러 삭제'));
}

// ---------------------------------------------------------------- destructive adjustment / filter with live preview

/** Run `compute(baseCanvas, params)` live on the active layer (inside the selection), OK keeps it. */
function liveLayerDialog(P, { title, defs, params, compute, label, slow = false }) {
  const doc = P.doc;
  const l = doc.active;
  if (!l || l.kind !== 'raster' || !l.canvas) {
    toast('이미지(일반) 레이어를 선택하세요. 글자·모양 레이어는 레이어 ▸ 래스터화 후 쓸 수 있고, 조정은 "새 조정 레이어"로도 넣을 수 있습니다.');
    return;
  }
  const before = doc.capture();
  const base = l.canvas;
  const bx = l.x;
  const by = l.y;
  const status = h('div.note', '');
  let timer = null;
  let applied = false;
  const preview = () => {
    try {
      const out = compute(base, params);
      if (doc.selection) {
        // only inside the selection: original outside, result inside
        const g = out.getContext('2d');
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(doc.selection.canvas, -bx, -by);
        const mix = cloneCanvas(base);
        const mg = mix.getContext('2d');
        mg.globalCompositeOperation = 'destination-out';
        mg.drawImage(doc.selection.canvas, -bx, -by);
        mg.globalCompositeOperation = 'source-over';
        mg.drawImage(out, 0, 0);
        l.canvas = mix;
      } else l.canvas = out;
      l.x = bx;
      l.y = by;
      l._styled = null;
      doc.touch(l);
      P.redraw();
      status.textContent = '';
    } catch (err) {
      status.textContent = String(err.message || err);
    }
  };
  const schedule = (now) => {
    clearTimeout(timer);
    if (slow) status.textContent = '미리 보기 계산 중…';
    timer = setTimeout(preview, now ? 0 : slow ? 220 : 40);
  };
  const pv = chk(true, '미리 보기');
  pv.box.addEventListener('change', () => {
    if (pv.box.checked) schedule(true);
    else {
      l.canvas = base;
      doc.touch(l);
      P.redraw();
    }
  });
  openModal({
    title,
    width: '460px',
    body: [...paramEditors(defs, params, () => schedule(false)), h('div.inline', pv.el), status],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        clearTimeout(timer);
        preview();
        applied = true;
        P.commit(label, before);
      },
    }],
    onClose: () => {
      clearTimeout(timer);
      if (!applied) {
        doc.restore(before);
        P.afterHistory();
      }
    },
  });
  schedule(true);
}

export function adjustDialog(P, type) {
  const def = ADJUSTMENTS[type];
  const params = defaultParams(type);
  if (!def.params.length) {
    // instant adjustments (invert, desaturate)
    const doc = P.doc;
    const l = doc.active;
    if (!l || l.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
    P.run(def.name, () => applyToLayer(P, (c) => adjustCanvas(c, type, params)));
    return undefined;
  }
  liveLayerDialog(P, { title: def.name, defs: def.params, params, label: def.name, compute: (c, p) => adjustCanvas(c, type, p), slow: P.doc.width * P.doc.height > 6e6 });
  return undefined;
}

export function adjustCanvas(c, type, params) {
  const out = makeCanvas(c.width, c.height);
  const g = out.getContext('2d');
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  applyAdjustment(img, type, params);
  g.putImageData(img, 0, 0);
  return out;
}

/** Replace the active layer's pixels with fn(canvas), limited to the selection. Raw (inside a run). */
export function applyToLayer(P, fn) {
  const doc = P.doc;
  const l = doc.active;
  const base = l.canvas;
  const out = fn(base);
  if (doc.selection) {
    const g = out.getContext('2d');
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(doc.selection.canvas, -l.x, -l.y);
    const mix = cloneCanvas(base);
    const mg = mix.getContext('2d');
    mg.globalCompositeOperation = 'destination-out';
    mg.drawImage(doc.selection.canvas, -l.x, -l.y);
    mg.globalCompositeOperation = 'source-over';
    mg.drawImage(out, 0, 0);
    l.canvas = mix;
  } else l.canvas = out;
  l._styled = null;
  doc.touch(l);
}

let lastFilter = null;
export function filterDialog(P, id) {
  const f = FILTERS[id];
  const params = lastFilter?.id === id ? { ...lastFilter.params } : defaultFilterParams(id);
  const run = (c, p) => applyFilter(c, id, p, { fg: P.fg, bg: P.bg });
  const remember = () => { lastFilter = { id, params: { ...params } }; };
  if (!f.params.length) {
    if (!P.doc.active || P.doc.active.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
    P.run(f.name, () => applyToLayer(P, (c) => run(c, params)));
    remember();
    return undefined;
  }
  const big = P.doc.width * P.doc.height;
  liveLayerDialog(P, { title: f.name, defs: f.params.map((d) => [...d.slice(0, 5), d[5]]), params, label: f.name, compute: (c, p) => { remember(); return run(c, p); }, slow: big > 2e6 || ['median', 'oil', 'motion', 'twirl', 'spherize', 'pinch', 'wave', 'clouds', 'edges'].includes(id) });
  return undefined;
}

export function repeatFilter(P) {
  if (!lastFilter) return toast('아직 적용한 필터가 없습니다');
  const { id, params } = lastFilter;
  if (!P.doc.active || P.doc.active.kind !== 'raster') return toast('이미지(일반) 레이어를 선택하세요');
  P.run(FILTERS[id].name, () => applyToLayer(P, (c) => applyFilter(c, id, params, { fg: P.fg, bg: P.bg })));
  return undefined;
}

// ---------------------------------------------------------------- layer style

export function layerStyleDialog(P) {
  const doc = P.doc;
  const l = doc.active;
  if (!l || l.kind === 'adjust') return toast('스타일은 일반·글자·모양 레이어에 넣을 수 있습니다');
  const before = doc.capture();
  const fx = structuredClone(l.fx || {});
  const S = {
    shadow: { on: !!fx.shadow, v: fx.shadow || { color: '#000000', opacity: 0.6, angle: 120, distance: 12, blur: 10 } },
    stroke: { on: !!fx.stroke, v: fx.stroke || { color: '#ffffff', size: 4 } },
    glow: { on: !!fx.glow, v: fx.glow || { color: '#ffe680', opacity: 0.8, size: 14 } },
  };
  const apply = () => {
    l.fx = { shadow: S.shadow.on ? { ...S.shadow.v } : null, stroke: S.stroke.on ? { ...S.stroke.v } : null, glow: S.glow.on ? { ...S.glow.v } : null };
    l._styled = null;
    doc.touch(l);
    P.redraw();
  };
  const section = (key, title, defs) => {
    const on = chk(S[key].on, title);
    on.box.addEventListener('change', () => {
      S[key].on = on.box.checked;
      apply();
    });
    const vals = S[key].v;
    const p = { ...vals, opacity: vals.opacity != null ? Math.round(vals.opacity * 100) : undefined };
    const eds = paramEditors(defs, p, () => {
      Object.assign(vals, p, p.opacity != null ? { opacity: p.opacity / 100 } : {});
      S[key].on = true;
      on.box.checked = true;
      apply();
    });
    return h('fieldset.ph-fx', h('legend', on.el), ...eds);
  };
  let ok = false;
  openModal({
    title: '레이어 스타일',
    width: '460px',
    body: [
      section('shadow', '그림자', [['color', '색', null, null, null, 'color'], ['opacity', '불투명도 (%)', 0, 100], ['angle', '각도', -180, 180], ['distance', '거리 (px)', 0, 200], ['blur', '흐림 (px)', 0, 100]]),
      section('stroke', '획 (외곽선)', [['color', '색', null, null, null, 'color'], ['size', '두께 (px)', 1, 50]]),
      section('glow', '외부 광선', [['color', '색', null, null, null, 'color'], ['opacity', '불투명도 (%)', 0, 100], ['size', '크기 (px)', 1, 100]]),
    ],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; apply(); P.commit('레이어 스타일', before); } }],
    onClose: () => {
      if (!ok) {
        doc.restore(before);
        P.redraw();
      }
    },
  });
  return undefined;
}

// ---------------------------------------------------------------- fill / stroke

export function fillDialog(P) {
  const what = sel([['fg', '전경색'], ['bg', '배경색'], ['custom', '색상…'], ['#808080', '50% 회색'], ['#ffffff', '흰색'], ['#000000', '검정']], 'fg');
  const color = h('input', { type: 'color', value: P.fg });
  const op = num(100, 1, 100, 1, '70px');
  openModal({
    title: '칠 (채우기)',
    width: '400px',
    body: [formRow('내용', what, color), formRow('불투명도 (%)', op), h('div.note', P.doc.selection ? '선택 영역을 채웁니다.' : '선택 영역이 없어 레이어 전체를 채웁니다.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const c = what.value === 'fg' ? P.fg : what.value === 'bg' ? P.bg : what.value === 'custom' ? color.value : what.value;
        P.fill(c, +op.value / 100);
      },
    }],
  });
}

export function strokeDialog(P) {
  if (!P.doc.selection) return toast('먼저 선택 영역을 만드세요');
  const width = num(4, 1, 200);
  const color = h('input', { type: 'color', value: P.fg });
  const pos = sel([['outside', '바깥쪽'], ['center', '가운데'], ['inside', '안쪽']], 'center');
  openModal({
    title: '획 (선택 영역 테두리 그리기)',
    width: '400px',
    body: [formRow('두께 (px)', width), formRow('색', color), formRow('위치', pos)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => P.strokeSelection(+width.value, color.value, pos.value) }],
  });
  return undefined;
}

// ---------------------------------------------------------------- export / send to video

export function exportDialog(P) {
  const doc = P.doc;
  const type = sel(EXPORT_TYPES.map(([id, t]) => [id, t]), 'png');
  const q = h('input', { type: 'range', min: 0.3, max: 1, step: 0.01, value: 0.9 });
  const qv = h('span', '90%');
  q.addEventListener('input', () => { qv.textContent = `${Math.round(q.value * 100)}%`; });
  const scale = sel([[1, '원래 크기'], [0.5, '50%'], [0.25, '25%'], [2, '200%']], 1);
  const name = h('input', { type: 'text', value: doc.name, style: { width: '100%' } });
  const qRow = formRow('화질', q, qv);
  const sync = () => { qRow.hidden = type.value === 'png'; };
  type.addEventListener('change', sync);
  sync();
  openModal({
    title: '내보내기 (이미지 파일로 저장)',
    width: '440px',
    body: [formRow('파일 이름', name), formRow('형식', type), qRow, formRow('크기', scale), h('div.note', `${doc.width} × ${doc.height} px · 보이는 레이어를 합쳐 저장합니다.`)],
    buttons: [{ label: '취소' }, { label: '저장', primary: true, action: () => P.exportImage(name.value.trim() || doc.name, type.value, +q.value, +scale.value) }],
  });
}

export function sendToVideoDialog(P) {
  const doc = P.doc;
  const replace = chk(false, '영상 타임라인에서 원래 이미지를 쓰던 클립도 이 이미지로 바꾸기');
  if (!doc.sourceMediaId) replace.box.disabled = true;
  openModal({
    title: '영상 편집으로 보내기',
    width: '460px',
    body: [
      h('div.note', '보이는 레이어를 합친 PNG를 영상 프로젝트의 미디어(프로젝트 패널)에 새 이미지로 넣습니다.'),
      doc.sourceMediaId ? replace.el : h('div.note', '이 문서는 영상 프로젝트의 이미지에서 연 것이 아니어서 새 이미지로만 넣을 수 있습니다.'),
    ],
    buttons: [{ label: '취소' }, { label: '보내기', primary: true, action: () => P.sendToVideo({ replace: replace.box.checked }) }],
  });
}

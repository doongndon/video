// Image adjustments and filters on an alpha channel or the quick mask, as in Photoshop: with an
// alpha channel picked in the Channels panel, Levels (Ctrl+L), Brightness/Contrast, Threshold,
// Invert (Ctrl+I), Gaussian Blur and the like change the channel instead of the layer, the classic
// way to build a mask from a duplicated colour channel. The adjustment and filter dialogs hand
// these over through P.channelEdit (a one-line check in pdialogs.js).

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { ADJUSTMENTS, FILTERS, defaultParams, applyAdjustment, applyFilter } from './adjust.js';

// Levels' sliders live in its own panel in the layer dialog; here they are plain sliders
const LEVELS = [['inBlack', '입력 검정', 0, 253, 0], ['gamma', '중간 톤 (감마)', 0.1, 9.99, 1, 0.01], ['inWhite', '입력 흰색', 2, 255, 255], ['outBlack', '출력 검정', 0, 255, 0], ['outWhite', '출력 흰색', 0, 255, 255]];

/** The channel being edited: {name, canvas, set(canvas)} or null. */
function target(P) {
  const doc = P.doc;
  if (!doc) return null;
  if (doc.quickMask) {
    return { name: '빠른 마스크', canvas: doc.quickMask.canvas, set: (c) => { doc.quickMask = { canvas: c }; } };
  }
  const st = P.chState?.();
  const ch = st?.active && doc.channels.find((c) => c.id === st.active);
  if (!ch) return null;
  return { name: ch.name, canvas: ch.canvas, set: (c) => { doc.channels = doc.channels.map((x) => (x.id === ch.id ? { ...x, canvas: c } : x)); } };
}

/** An alpha canvas as a grey picture (white = selected) and back. */
function toGrey(c) {
  const w = c.width;
  const hh = c.height;
  const src = c.getContext('2d').getImageData(0, 0, w, hh).data;
  const out = makeCanvas(w, hh);
  const g = out.getContext('2d');
  const img = g.createImageData(w, hh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = src[i + 3];
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return out;
}
function toAlpha(c) {
  const w = c.width;
  const hh = c.height;
  const src = c.getContext('2d').getImageData(0, 0, w, hh).data;
  const out = makeCanvas(w, hh);
  const g = out.getContext('2d');
  const img = g.createImageData(w, hh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.round(0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]);
  g.putImageData(img, 0, 0);
  return out;
}

/** Keep the new channel only inside the selection (like any edit in Photoshop). */
function limitTo(sel, before, after) {
  if (!sel) return after;
  const out = makeCanvas(after.width, after.height);
  const g = out.getContext('2d');
  g.drawImage(after, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(sel, 0, 0);
  const keep = makeCanvas(after.width, after.height);
  const kg = keep.getContext('2d');
  kg.drawImage(before, 0, 0);
  kg.globalCompositeOperation = 'destination-out';
  kg.drawImage(sel, 0, 0);
  // both parts are alpha amounts: the outside keeps the old value, the inside takes the new one
  g.globalCompositeOperation = 'lighter';
  g.drawImage(keep, 0, 0);
  return out;
}

/**
 * Open the channel version of an adjustment ('adjust', type) or filter ('filter', id) when an
 * alpha channel (or the quick mask) is being edited. Returns true when it took over.
 */
export function channelEdit(P, kind, id) {
  const t = target(P);
  if (!t) return false;
  const doc = P.doc;
  const def = kind === 'adjust' ? ADJUSTMENTS[id] : FILTERS[id];
  if (!def) return false;
  const run = (canvas, p) => {
    const grey = toGrey(canvas);
    if (kind === 'adjust') {
      const g = grey.getContext('2d');
      const img = g.getImageData(0, 0, grey.width, grey.height);
      applyAdjustment(img, id, p);
      g.putImageData(img, 0, 0);
      return toAlpha(grey);
    }
    return toAlpha(applyFilter(grey, id, p, { fg: P.fg, bg: P.bg }));
  };
  const label = `${def.name} (${t.name})`;
  const sel = doc.selection?.canvas || null;
  // which settings a plain dialog can show
  const rows = [];
  const params = kind === 'adjust' ? defaultParams(id) : {};
  const defs = id === 'levels' && kind === 'adjust' ? LEVELS : def.params || [];
  for (const d of defs) {
    const [key, name, min, max, dv, type] = d;
    if (kind === 'filter') params[key] = structuredClone(dv);
    if (type === 'hidden') continue;
    if (type === 'bool') rows.push({ key, name, type: 'bool' });
    else if (Array.isArray(type)) rows.push({ key, name, type: 'select', list: type });
    else if (typeof min === 'number' && typeof max === 'number' && (type === undefined || typeof type === 'number')) rows.push({ key, name, type: 'num', min, max, step: typeof type === 'number' ? type : Number.isInteger(dv) && Number.isInteger(min) ? 1 : 0.01 });
    else return unsupported(def.name);
  }
  const before = doc.capture();
  const orig = t.canvas;
  if (!rows.length) {
    // instant ones (Invert …)
    P.run(label, () => t.set(limitTo(sel, orig, run(orig, params))));
    P.emit('channels');
    return true;
  }
  // a smaller copy keeps the preview quick on big pictures
  const k = Math.min(1, Math.sqrt(1.5e6 / (orig.width * orig.height)));
  const small = makeCanvas(Math.max(1, Math.round(orig.width * k)), Math.max(1, Math.round(orig.height * k)));
  small.getContext('2d').drawImage(orig, 0, 0, small.width, small.height);
  let frame = 0;
  const preview = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      let out = run(k < 1 ? small : orig, params);
      if (k < 1) {
        const big = makeCanvas(orig.width, orig.height);
        const bg = big.getContext('2d');
        bg.imageSmoothingQuality = 'high';
        bg.drawImage(out, 0, 0, orig.width, orig.height);
        out = big;
      }
      t.set(limitTo(sel, orig, out));
      doc.rev++;
      P.redraw();
    });
  };
  const controls = rows.map((r) => {
    if (r.type === 'bool') {
      const c = h('input', { type: 'checkbox', checked: !!params[r.key] });
      c.addEventListener('change', () => { params[r.key] = c.checked; preview(); });
      return h('div.form-row', h('label', r.name), c);
    }
    if (r.type === 'select') {
      const s = h('select', ...r.list.map(([v, txt]) => h('option', { value: v }, txt)));
      s.value = params[r.key];
      s.addEventListener('change', () => { params[r.key] = s.value; preview(); });
      return h('div.form-row', h('label', r.name), s);
    }
    const range = h('input', { type: 'range', min: r.min, max: r.max, step: r.step, value: params[r.key], 'aria-label': r.name });
    const num = h('input.ph-num', { type: 'number', min: r.min, max: r.max, step: r.step, value: params[r.key], 'aria-label': r.name, style: { width: '72px' } });
    const set = (v) => {
      params[r.key] = clamp(+v || 0, r.min, r.max);
      range.value = params[r.key];
      num.value = params[r.key];
      preview();
    };
    range.addEventListener('input', () => set(range.value));
    num.addEventListener('change', () => set(num.value));
    return h('div.form-row', h('label', r.name), h('div.inline', range, num));
  });
  let done = false;
  openModal({
    title: `${def.name} — ${t.name}`,
    body: h('div', ...controls, h('div.note', `알파 채널 "${t.name}"에 적용합니다 (흰색 = 선택). 레이어에 쓰려면 채널 패널에서 RGB를 누르세요.`)),
    onClose: () => {
      cancelAnimationFrame(frame);
      if (done) return;
      // cancelled: put the channel back as it was
      t.set(orig);
      doc.rev++;
      P.redraw();
    },
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        done = true;
        cancelAnimationFrame(frame);
        t.set(limitTo(sel, orig, run(orig, params)));
        P.commit(label, before);
        P.emit('channels');
      },
    }],
  });
  preview();
  return true;
}

function unsupported(name) {
  toast(`${name}은(는) 알파 채널에 쓸 수 없습니다. 레벨(Ctrl+L)이나 명도/대비, 한계값을 쓰거나, 채널 패널에서 RGB를 눌러 레이어로 돌아가세요.`);
  return true;
}

export function installChannelEdit(P) {
  P.channelEdit = (kind, id) => channelEdit(P, kind, id);
}

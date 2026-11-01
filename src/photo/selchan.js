// Image adjustments and filters on an alpha channel or the quick mask, as in Photoshop: with an
// alpha channel picked in the Channels panel, Levels (Ctrl+L), Brightness/Contrast, Threshold,
// Invert (Ctrl+I), Gaussian Blur and the like change the channel instead of the layer, the classic
// way to build a mask from a duplicated colour channel. The adjustment and filter dialogs hand
// these over through P.channelEdit (a one-line check in pdialogs.js).

import { h } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { ADJUSTMENTS, FILTERS, defaultParams, defaultFilterParams, visibleParams, applyAdjustment, applyFilter } from './adjust.js';
import { paramEditors } from './pdialogs.js';

// the adjustments that work on a grey channel
const GREY_ADJ = new Set(['levels', 'curves', 'brightness', 'exposure', 'invert', 'posterize', 'threshold', 'equalize', 'shadowsHighlights']);

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
  // colour adjustments mean nothing on a grey channel (Photoshop greys them out there)
  if (kind === 'adjust' && !GREY_ADJ.has(id)) return unsupported(def.name);
  const label = `${def.name} (${t.name})`;
  const sel = doc.selection?.canvas || null;
  const params = kind === 'adjust' ? defaultParams(id) : defaultFilterParams(id);
  const before = doc.capture();
  const orig = t.canvas;
  if (!visibleParams(def.params).length) {
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
  // the same controls as on a layer (Levels and Curves with the channel's histogram, sliders …)
  let grey = null;
  const controls = paramEditors(def.params, params, () => preview(), P, { source: () => (grey ||= toGrey(orig)) });
  // the editors' channel pickers (RGB / 빨강 / 녹색 / 파랑) offer only this channel, as in Photoshop
  for (const c of controls) {
    for (const s of c.querySelectorAll?.('select') || []) {
      const v = [...s.options].map((o) => o.value);
      if (v.length === 4 && v[1] === 'r' && v[2] === 'g' && v[3] === 'b') {
        s.options[0].textContent = t.name;
        while (s.options.length > 1) s.remove(1);
      }
    }
  }
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
  toast(`${name}은(는) 알파 채널에 쓸 수 없습니다. 레벨(Ctrl+L)이나 곡선(Ctrl+M), 한계값을 쓰거나, 채널 패널에서 RGB를 눌러 레이어로 돌아가세요.`);
  return true;
}

export function installChannelEdit(P) {
  P.channelEdit = (kind, id) => channelEdit(P, kind, id);
}

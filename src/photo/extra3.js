// Edit ▸ Sky Replacement, Image ▸ Match Colour, Auto Contrast / Auto Colour, Grayscale,
// Select ▸ Focus Area, Edit ▸ Find and Replace Text, and the Layer Comps panel.

import { h, clamp } from '../util.js';
import { toast, openModal, formRow, promptDialog } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas, cloneCanvas, newLayer } from './doc.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';
import { applyToLayer } from './pdialogs.js';

const SKIES = [
  ['day', '맑은 낮', ['#2f6fd6', '#6aa6ea', '#bcdcff']],
  ['sunset', '노을', ['#3a2a6b', '#c2477a', '#f59a4a', '#ffd58a']],
  ['dusk', '보랏빛 황혼', ['#141a3c', '#4a3b7a', '#b06aa0', '#f2b48c']],
  ['overcast', '흐린 날', ['#8d98a6', '#b8c0ca', '#dfe3e8']],
  ['night', '밤하늘 (별)', ['#02040f', '#0b1640', '#1d2f6b']],
];

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function skyCanvas(id, w, hh, img) {
  const c = makeCanvas(w, hh);
  const g = c.getContext('2d');
  if (img) {
    // cover the canvas, keep the top of the photo
    const k = Math.max(w / img.width, hh / img.height);
    g.drawImage(img, (w - img.width * k) / 2, 0, img.width * k, img.height * k);
    return c;
  }
  const sky = SKIES.find((s) => s[0] === id) || SKIES[0];
  const gr = g.createLinearGradient(0, 0, 0, hh);
  sky[2].forEach((col, i) => gr.addColorStop(i / (sky[2].length - 1), col));
  g.fillStyle = gr;
  g.fillRect(0, 0, w, hh);
  if (id === 'night') {
    let s = 99;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (w * hh) / 1800; i++) {
      g.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
      g.fillRect(rnd() * w, rnd() * hh * 0.8, rnd() < 0.1 ? 2 : 1, rnd() < 0.1 ? 2 : 1);
    }
  }
  if (id === 'day' || id === 'overcast') {
    // a few soft clouds
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 18; i++) {
      const x = rnd() * w;
      const y = rnd() * hh * 0.6;
      const r = (0.04 + rnd() * 0.08) * w;
      const cg = g.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, `rgba(255,255,255,${id === 'day' ? 0.55 : 0.35})`);
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = cg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  return c;
}

function avgColor(c) {
  const t = makeCanvas(8, 8);
  t.getContext('2d').drawImage(c, 0, 0, 8, 8);
  const d = t.getContext('2d').getImageData(0, 0, 8, 8).data;
  const s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
  return `rgb(${s.map((v) => Math.round(v / 64)).join(',')})`;
}

// ---------------------------------------------------------------- sky replacement

function skyReplacement(P) {
  const doc = P.doc;
  if (!doc) return;
  const W = doc.width;
  const H = doc.height;
  toast('하늘을 찾는 중…');
  setTimeout(() => {
    const base = SX.selectSky(P.composite());
    if (!base) return toast('하늘을 찾지 못했습니다. 하늘이 사진 위쪽 가장자리에 닿아 있어야 해요. 하늘을 직접 선택한 뒤 다시 해 보세요.');
    const mask0 = doc.selection ? doc.selection.canvas : base;
    let img = null;
    const pick = h('select', SKIES.map(([v, t]) => h('option', { value: v }, t)), h('option', { value: 'file' }, '사진 파일…'));
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const shift = h('input', { type: 'range', min: -40, max: 40, value: 0 });
    const fade = h('input', { type: 'range', min: 0, max: 100, value: 30 });
    const bright = h('input', { type: 'range', min: -100, max: 100, value: 0 });
    const light = h('input', { type: 'range', min: 0, max: 100, value: 35 });
    const before = doc.capture();
    let made = null;
    const build = () => {
      if (made) doc.restore(before);
      const shiftPx = Math.round((+shift.value / 100) * Math.min(W, H) * 0.1);
      let m = mask0;
      if (shiftPx) {
        const tmpDoc = { width: W, height: H, selection: { canvas: m } };
        m = SEL.grow(tmpDoc, shiftPx)?.canvas || m;
      }
      const feather = (+fade.value / 100) * Math.min(W, H) * 0.03;
      const mk = makeCanvas(W, H);
      const mg = mk.getContext('2d');
      if (feather > 0.5) mg.filter = `blur(${feather}px)`;
      mg.drawImage(m, 0, 0);
      const sky = skyCanvas(pick.value, W, H, img);
      if (+bright.value) {
        const t = makeCanvas(W, H);
        const tg = t.getContext('2d');
        tg.filter = `brightness(${100 + +bright.value / 1.5}%)`;
        tg.drawImage(sky, 0, 0);
        sky.getContext('2d').drawImage(t, 0, 0);
      }
      const skyL = newLayer('raster', { name: '하늘 대체', canvas: sky });
      // the layer mask is white where the sky shows (mask alpha = amount shown)
      skyL.mask = { canvas: mk, x: 0, y: 0, enabled: true, linked: true };
      const amt = +light.value / 100;
      const layers = [skyL];
      if (amt > 0) {
        const tint = makeCanvas(W, H);
        const tg = tint.getContext('2d');
        tg.fillStyle = avgColor(sky);
        tg.fillRect(0, 0, W, H);
        const inv = makeCanvas(W, H);
        const ig = inv.getContext('2d');
        ig.fillRect(0, 0, W, H);
        ig.globalCompositeOperation = 'destination-out';
        ig.drawImage(mk, 0, 0);
        layers.unshift(newLayer('raster', { name: '전경 조명 (하늘 색 맞추기)', canvas: tint, blend: 'soft-light', opacity: amt, mask: { canvas: inv, x: 0, y: 0, enabled: true, linked: true } }));
      }
      // above the topmost layer
      const top = doc.layers[doc.layers.length - 1];
      doc.activeId = top.id;
      for (const l of layers) P.addLayer(l);
      made = layers;
      P.redraw();
    };
    for (const e of [shift, fade, bright, light]) e.addEventListener('change', build);
    pick.addEventListener('change', () => {
      if (pick.value === 'file') {
        file.click();
        return;
      }
      img = null;
      build();
    });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      img = await createImageBitmap(f);
      build();
    });
    let ok = false;
    openModal({
      title: '하늘 대체',
      width: '420px',
      body: [formRow('하늘', pick, file), formRow('가장자리 이동', shift), formRow('가장자리 흐리게', fade), formRow('하늘 밝기', bright), formRow('전경 조명 맞추기', light),
        h('div.note', doc.selection ? '지금 선택 영역을 하늘로 씁니다.' : '하늘은 색으로 추정해 찾았어요. 잘못 잡히면 취소하고 하늘을 직접 선택한 뒤 다시 하세요.'),
        h('div.note', '결과는 레이어 마스크가 있는 새 레이어로 들어가서, 마스크를 칠해 다듬을 수 있어요.')],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; P.commit('하늘 대체', before); } }],
      onClose: () => {
        if (ok) return;
        doc.restore(before);
        P.afterHistory();
      },
    });
    build();
    return undefined;
  }, 30);
}

// ---------------------------------------------------------------- match colour

/** Mean and spread of Y, Cb, Cr over opaque pixels (downsampled). */
function ycStats(c) {
  const k = Math.min(1, 256 / Math.max(c.width, c.height));
  const t = makeCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
  const s = [0, 0, 0];
  const q = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const y = lumOf(d[i], d[i + 1], d[i + 2]);
    const v = [y, (d[i + 2] - y) * 0.564, (d[i] - y) * 0.713];
    for (let j = 0; j < 3; j++) {
      s[j] += v[j];
      q[j] += v[j] * v[j];
    }
    n++;
  }
  n = Math.max(1, n);
  const mean = s.map((v) => v / n);
  return { mean, sd: q.map((v, j) => Math.sqrt(Math.max(1e-6, v / n - mean[j] * mean[j]))) };
}

function matchColor(P) {
  const doc = P.doc;
  const l = doc?.active;
  if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 고르세요');
  const others = P.docs.filter((d) => d !== doc);
  if (!others.length) return toast('색을 가져올 사진을 하나 더 여세요 (다른 탭)');
  const srcSel = h('select', others.map((d, i) => h('option', { value: i }, d.name)));
  const lumR = h('input', { type: 'range', min: 0, max: 200, value: 100 });
  const colR = h('input', { type: 'range', min: 0, max: 200, value: 100 });
  const fadeR = h('input', { type: 'range', min: 0, max: 100, value: 0 });
  const before = doc.capture();
  const base = l.canvas;
  const tgt = ycStats(base);
  const apply = () => {
    const sd = others[+srcSel.value];
    const src = ycStats(sd.flatten ? sd.flatten() : base);
    const lk = +lumR.value / 100;
    const ck = +colR.value / 100;
    const fk = 1 - +fadeR.value / 100;
    l.canvas = base;
    applyToLayer(P, (c) => {
      const out = cloneCanvas(c);
      const g = out.getContext('2d');
      const img = g.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const y = lumOf(d[i], d[i + 1], d[i + 2]);
        const v = [y, (d[i + 2] - y) * 0.564, (d[i] - y) * 0.713];
        const o = v.map((x, j) => (x - tgt.mean[j]) * (src.sd[j] / tgt.sd[j]) + src.mean[j]);
        // luminance and colour strength, then fade back toward the original
        const Y = y + (o[0] - y) * lk;
        const cb = o[1] * ck;
        const cr = o[2] * ck;
        const r = Y + cr / 0.713;
        const b = Y + cb / 0.564;
        const gg = (Y - 0.299 * r - 0.114 * b) / 0.587;
        d[i] += (r - d[i]) * fk;
        d[i + 1] += (gg - d[i + 1]) * fk;
        d[i + 2] += (b - d[i + 2]) * fk;
      }
      g.putImageData(img, 0, 0);
      return out;
    });
    P.redraw();
  };
  for (const e of [srcSel, lumR, colR, fadeR]) e.addEventListener('change', apply);
  let ok = false;
  openModal({
    title: '색상 일치',
    width: '400px',
    body: [formRow('색을 가져올 사진', srcSel), formRow('광도', lumR), formRow('색 강도', colR), formRow('희미하게', fadeR), h('div.note', '다른 탭에 연 사진의 밝기와 색감을 지금 레이어에 옮겨요. 영화 장면처럼 맞추고 싶을 때 좋아요.')],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => { ok = true; P.commit('색상 일치', before); } }],
    onClose: () => {
      if (ok) return;
      doc.restore(before);
      P.afterHistory();
    },
  });
  apply();
  return undefined;
}

// ---------------------------------------------------------------- auto contrast / colour, grayscale

function stretch(P, label, perChannel, neutral) {
  const l = P.doc?.active;
  if (!l || l.kind !== 'raster' || !l.canvas) return toast('이미지(일반) 레이어를 고르세요');
  P.run(label, () => applyToLayer(P, (c) => {
    const out = cloneCanvas(c);
    const g = out.getContext('2d');
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const range = (get) => {
      const hist = new Uint32Array(256);
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { hist[Math.round(get(i))]++; n++; }
      let a = 0;
      let acc = 0;
      while (a < 254 && (acc += hist[a]) < n * 0.001) a++;
      let b = 255;
      acc = 0;
      while (b > a + 1 && (acc += hist[b]) < n * 0.001) b--;
      return [a, b];
    };
    let lo = [0, 0, 0];
    let hi = [255, 255, 255];
    if (perChannel) for (let k = 0; k < 3; k++) [lo[k], hi[k]] = range((i) => d[i + k]);
    else {
      const [a, b] = range((i) => lumOf(d[i], d[i + 1], d[i + 2]));
      lo = [a, a, a];
      hi = [b, b, b];
    }
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = ((d[i + k] - lo[k]) * 255) / Math.max(1, hi[k] - lo[k]);
    if (neutral) {
      // auto colour: pull the mid-tones toward grey
      const s = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const y = lumOf(d[i], d[i + 1], d[i + 2]);
        if (!d[i + 3] || y < 50 || y > 205) continue;
        for (let k = 0; k < 3; k++) s[k] += d[i + k];
        n++;
      }
      if (n) {
        const m = s.map((v) => v / n);
        const avg = (m[0] + m[1] + m[2]) / 3;
        for (let i = 0; i < d.length; i += 4) {
          const t = Math.sin((lumOf(d[i], d[i + 1], d[i + 2]) / 255) * Math.PI);
          for (let k = 0; k < 3; k++) d[i + k] += (avg - m[k]) * t * 0.8;
        }
      }
    }
    g.putImageData(img, 0, 0);
    return out;
  }));
  return undefined;
}

function toGrayscale(P) {
  const doc = P.doc;
  if (!doc) return;
  P.run('회색 음영', () => {
    for (const l of doc.layers) {
      if (l.kind !== 'raster' || !l.canvas) continue;
      const c = cloneCanvas(l.canvas);
      const g = c.getContext('2d');
      const img = g.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lumOf(d[i], d[i + 1], d[i + 2]);
      g.putImageData(img, 0, 0);
      l.canvas = c;
      l._styled = null;
      doc.touch(l);
    }
    doc.mode = 'gray';
  });
  toast('모든 이미지 레이어를 회색 음영으로 바꿨어요. 글자·모양 레이어의 색은 그대로예요.');
}

// ---------------------------------------------------------------- focus area

function focusArea(P) {
  const doc = P.doc;
  if (!doc) return;
  const comp = P.composite();
  const k = Math.min(1, 700 / Math.max(doc.width, doc.height));
  const w = Math.max(8, Math.round(doc.width * k));
  const hh = Math.max(8, Math.round(doc.height * k));
  const sm = makeCanvas(w, hh);
  sm.getContext('2d').drawImage(comp, 0, 0, w, hh);
  const d = sm.getContext('2d').getImageData(0, 0, w, hh).data;
  // sharpness: local Laplacian energy, spread over a neighbourhood
  const L = new Float32Array(w * hh);
  for (let i = 0; i < w * hh; i++) L[i] = lumOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const S = makeCanvas(w, hh);
  const sg = S.getContext('2d');
  const simg = sg.createImageData(w, hh);
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]);
      simg.data[i * 4 + 3] = clamp(v * 6, 0, 255);
    }
  }
  sg.putImageData(simg, 0, 0);
  const blurR = Math.max(2, Math.min(w, hh) / 40);
  const B = makeCanvas(w, hh);
  const bg = B.getContext('2d');
  bg.filter = `blur(${blurR}px)`;
  bg.drawImage(S, 0, 0);
  const bd = bg.getImageData(0, 0, w, hh).data;
  const sharp = new Uint8Array(w * hh);
  for (let i = 0; i < w * hh; i++) sharp[i] = bd[i * 4 + 3];
  const sorted = [...sharp].sort((a, b) => a - b);
  const range = h('input', { type: 'range', min: 1, max: 99, value: 55 });
  const soft = h('input', { type: 'range', min: 0, max: 30, value: 6 });
  const pv = h('canvas', { width: w, height: hh, style: { maxWidth: '100%', borderRadius: '6px' } });
  let mask = null;
  const build = () => {
    const th = sorted[Math.floor((sorted.length - 1) * (+range.value / 100))];
    const m = makeCanvas(w, hh);
    const mg = m.getContext('2d');
    const mi = mg.createImageData(w, hh);
    for (let i = 0; i < w * hh; i++) mi.data[i * 4 + 3] = sharp[i] > th ? 255 : 0;
    mg.putImageData(mi, 0, 0);
    // smooth the blobs into regions
    const M = makeCanvas(w, hh);
    const Mg = M.getContext('2d');
    Mg.filter = `blur(${Math.max(1, blurR / 2)}px)`;
    Mg.drawImage(m, 0, 0);
    const md = Mg.getImageData(0, 0, w, hh);
    for (let i = 3; i < md.data.length; i += 4) md.data[i] = md.data[i] > 100 ? 255 : 0;
    Mg.putImageData(md, 0, 0);
    mask = M;
    const g = pv.getContext('2d');
    g.drawImage(sm, 0, 0);
    g.fillStyle = 'rgba(255,40,60,.45)';
    g.globalCompositeOperation = 'source-atop';
    const inv = makeCanvas(w, hh);
    const ig = inv.getContext('2d');
    ig.fillRect(0, 0, w, hh);
    ig.globalCompositeOperation = 'destination-out';
    ig.drawImage(M, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 0.5;
    g.drawImage(inv, 0, 0);
    g.globalAlpha = 1;
  };
  range.addEventListener('input', build);
  openModal({
    title: '초점 영역 선택',
    width: '520px',
    body: [pv, formRow('초점 범위 (높을수록 더 선명한 곳만)', range), formRow('가장자리 부드럽게 (px)', soft), h('div.note', '어둡게 덮인 곳이 선택에서 빠지는 부분이에요. 배경이 흐린(아웃포커스) 사진에서 잘 돼요.')],
    buttons: [{ label: '취소' }, {
      label: '확인', primary: true, action: () => {
        const c = makeCanvas(doc.width, doc.height);
        const g = c.getContext('2d');
        if (+soft.value) g.filter = `blur(${+soft.value}px)`;
        g.imageSmoothingQuality = 'high';
        g.drawImage(mask, 0, 0, doc.width, doc.height);
        P.run('초점 영역', () => { doc.selection = SEL.combine(doc, c, 'new'); });
      },
    }],
  });
  build();
}

// ---------------------------------------------------------------- find and replace text

function findReplace(P) {
  const doc = P.doc;
  const texts = doc?.layers.filter((l) => l.kind === 'text') || [];
  if (!texts.length) return toast('글자 레이어가 없습니다');
  const find = h('input', { type: 'text', style: { width: '100%' } });
  const rep = h('input', { type: 'text', style: { width: '100%' } });
  const cs = h('input', { type: 'checkbox' });
  const info = h('div.note');
  const count = () => {
    if (!find.value) return 0;
    const re = new RegExp(find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs.checked ? 'g' : 'gi');
    let n = 0;
    for (const l of texts) n += (String(l.text.content).match(re) || []).length;
    return n;
  };
  const upd = () => { info.textContent = find.value ? `글자 레이어 ${texts.length}개에서 ${count()}곳 찾음` : ''; };
  find.addEventListener('input', upd);
  cs.addEventListener('change', upd);
  openModal({
    title: '텍스트 찾기 / 바꾸기',
    width: '420px',
    body: [formRow('찾을 내용', find), formRow('바꿀 내용', rep), h('label.inline', cs, ' 대소문자 구분'), info],
    buttons: [{ label: '닫기' }, {
      label: '모두 바꾸기', primary: true, action: () => {
        const n = count();
        if (!n) {
          toast('찾은 곳이 없습니다');
          return false;
        }
        const re = new RegExp(find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs.checked ? 'g' : 'gi');
        P.run('텍스트 바꾸기', () => {
          for (const l of texts) {
            const s = String(l.text.content);
            const t = s.replace(re, rep.value);
            if (t !== s) {
              l.text = { ...l.text, content: t };
              doc.touch(l);
            }
          }
        });
        toast(`${n}곳을 바꿨습니다`);
        return undefined;
      },
    }],
  });
  setTimeout(() => find.focus(), 30);
  return undefined;
}

// ---------------------------------------------------------------- layer comps

const compState = (doc) => Object.fromEntries(doc.layers.map((l) => [l.id, { visible: l.visible, opacity: l.opacity, x: l.x, y: l.y, blend: l.blend, fx: l.fx ? structuredClone(l.fx) : {} }]));

export function buildCompsPanel(P) {
  const el = h('div.ph-panel.ph-actions');
  const render = () => {
    const doc = P.doc;
    if (!doc) {
      el.replaceChildren(h('div.note', '문서를 여세요'));
      return;
    }
    const comps = doc.comps || [];
    const C = P.cmd;
    el.replaceChildren(
      h('div.ph-act-bar',
        h('button.small', { onclick: () => C.newComp(), title: '지금 레이어 상태(보이기·위치·불투명도·스타일)를 저장' }, icon('plus', 14), ' 새로'),
        h('button.small', { disabled: comps.length < 2, onclick: () => C.stepComp(-1) }, '이전'),
        h('button.small', { disabled: comps.length < 2, onclick: () => C.stepComp(1) }, '다음')),
      h('div.ph-act-list', comps.map((c, i) => h(`div.ph-act-row${doc._compOn === c.id ? '.on' : ''}`, { onclick: () => C.applyComp(i) },
        h('span.ph-act-name', c.name),
        h('button.ph-act-x', { title: '지금 상태로 갱신', 'aria-label': '갱신', onclick: (e) => { e.stopPropagation(); C.updateComp(i); } }, icon('reset', 12)),
        h('button.ph-act-x', { title: '지우기', 'aria-label': '지우기', onclick: (e) => { e.stopPropagation(); C.deleteComp(i); } }, icon('close', 12))))),
      h('div.note', '같은 문서 안에서 레이어 보이기·위치·스타일을 여러 버전으로 저장해 두고 눌러서 오가요. 썸네일 시안 A/B 비교에 좋아요.'));
  };
  P.on('history', render);
  P.on('doc', render);
  setTimeout(render, 0);
  return el;
}

// ---------------------------------------------------------------- install

export function installExtra3(P) {
  const C = P.cmd;
  C.skyReplacement = () => skyReplacement(P);
  C.matchColor = () => matchColor(P);
  C.autoContrast = () => stretch(P, '자동 대비', false, false);
  C.autoColor = () => stretch(P, '자동 색상', true, true);
  C.grayscale = () => toGrayscale(P);
  C.focusArea = () => focusArea(P);
  C.findReplace = () => findReplace(P);
  C.newComp = async () => {
    const doc = P.doc;
    if (!doc) return;
    const name = await promptDialog('새 레이어 구성요소', '이름', `구성 ${(doc.comps?.length || 0) + 1}`);
    if (!name) return;
    P.run('새 레이어 구성요소', () => {
      const id = `c${Date.now().toString(36)}`;
      doc.comps = [...(doc.comps || []), { id, name: name.slice(0, 40), state: compState(doc) }];
      doc._compOn = id;
    });
  };
  C.applyComp = (i) => {
    const doc = P.doc;
    const c = doc?.comps?.[i];
    if (!c) return;
    P.run(`레이어 구성요소: ${c.name}`, () => {
      for (const l of doc.layers) {
        const s = c.state[l.id];
        if (!s) continue;
        Object.assign(l, { visible: s.visible, opacity: s.opacity, x: s.x, y: s.y, blend: s.blend, fx: structuredClone(s.fx || {}) });
        l._styled = null;
        doc.touch(l);
      }
      doc._compOn = c.id;
    });
  };
  C.updateComp = (i) => {
    const doc = P.doc;
    if (!doc?.comps?.[i]) return;
    P.run('레이어 구성요소 갱신', () => {
      doc.comps = doc.comps.map((c, k) => (k === i ? { ...c, state: compState(doc) } : c));
    });
  };
  C.deleteComp = (i) => {
    const doc = P.doc;
    if (!doc?.comps?.[i]) return;
    P.run('레이어 구성요소 삭제', () => { doc.comps = doc.comps.filter((_, k) => k !== i); });
  };
  C.stepComp = (dir) => {
    const doc = P.doc;
    const list = doc?.comps || [];
    if (!list.length) return;
    const cur = list.findIndex((c) => c.id === doc._compOn);
    C.applyComp((cur + dir + list.length) % list.length);
  };
}

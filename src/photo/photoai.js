// AI editing in the photo editor with Google Gemini, using the same key as the video editor's AI
// tab. The browser talks to Google directly. What is sent: a small JPEG of the picture (at most
// 768 px) and, for the assistant, a short list of the layers; for generative fill, the part of the
// picture around the selection.
//
//  - Auto enhance: Gemini looks at the picture and picks Camera Raw style settings (plus a look and
//    sharpening, optionally straightening and a crop); they are applied to a new layer. Without a
//    key the settings come from the picture's own histogram instead.
//  - Assistant: a request in plain Korean; Gemini edits with the photo editor's tools.
//  - Generative fill, Generative Expand (crop past the canvas), Generate Image and Generate
//    Background: an image-capable Gemini model paints, the result comes back as a new layer.
// Every request is one undo step.

import { h, clamp } from '../util.js';
import { toast, openModal } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { geminiSettings, saveGeminiSettings, generate, generateWith, listGeminiModels, listAllGeminiModels, API_KEY_PAGE } from '../ai.js';
import { makeCanvas, newLayer } from './doc.js';
import { FILTERS, ADJUSTMENTS, applyFilter, applyAdjustment, defaultParams, defaultFilterParams } from './adjust.js';
import { applyToLayer } from './pdialogs.js';
import * as SEL from './selection.js';
import * as SX from './selectx.js';
import { inpaint } from './inpaint.js';

// ---------------------------------------------------------------- helpers

const CR = () => FILTERS.cameraRaw.params; // [key, label, min, max, default, step]

/** A small JPEG (base64) of a canvas, on white. */
function jpegB64(c, max = 768) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  const t = makeCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const g = t.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, t.width, t.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.85).split(',')[1];
}

function firstCandidate(d) {
  const c = d?.candidates?.[0];
  if (!c?.content) {
    const why = d?.promptFeedback?.blockReason || c?.finishReason;
    throw new Error(why ? `Gemini가 답하지 않았습니다 (${why})` : 'Gemini가 빈 응답을 보냈습니다');
  }
  return c;
}
const textOf = (content) => (content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(t);
}

/** Run fn as one undo step, whatever commands it runs. */
async function oneStep(P, label, fn) {
  const doc = P.doc;
  const hist = doc.history;
  const before = doc.capture();
  // the step on top before: a full history drops its oldest steps, so counting would miss some
  const top = hist.undoStack.at(-1) || null;
  try {
    return await fn();
  } finally {
    if (P.doc === doc && hist.undoStack.at(-1) !== top) {
      hist.undoStack.splice(top ? hist.undoStack.lastIndexOf(top) + 1 : 0);
      hist.push(label, before);
      doc.saved = false;
      P.afterHistory();
    }
  }
}

/** Resolves after the browser has drawn the current state of the page. */
const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const DOC_CHANGED = '응답을 기다리는 동안 다른 문서로 바뀌어 AI 편집을 멈췄습니다';

/** Rotate a picture and scale it just enough that no empty corners show. */
function rotateFill(c, deg) {
  const t = (deg * Math.PI) / 180;
  const W = c.width;
  const H = c.height;
  const cs = Math.abs(Math.cos(t));
  const sn = Math.abs(Math.sin(t));
  const s = Math.max((W * cs + H * sn) / W, (W * sn + H * cs) / H);
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.translate(W / 2, H / 2);
  g.rotate(t);
  g.scale(s, s);
  g.drawImage(c, -W / 2, -H / 2);
  return out;
}

// ---------------------------------------------------------------- enhance settings

export const ENHANCE_STYLES = [
  ['natural', '자연스럽게'], ['vivid', '선명하게'], ['warm', '따뜻하게'], ['cool', '시원하게'], ['cinematic', '영화처럼'],
  ['bw', '흑백'], ['portrait', '인물'], ['landscape', '풍경'], ['food', '음식'],
];
const LOOK_IDS = () => (ADJUSTMENTS.colorLookup?.params?.[0]?.[5] || []).map((x) => x[0]);

const STYLE_OFFSETS = {
  natural: {},
  vivid: { vibrance: 25, saturation: 8, clarity: 15, contrast: 15 },
  warm: { temp: 20, tint: 4, vibrance: 8 },
  cool: { temp: -20, vibrance: 6 },
  cinematic: { contrast: 10, vignette: -20, look: 'tealOrange', lookAmount: 55 },
  bw: { saturation: -100, contrast: 20, clarity: 10 },
  portrait: { texture: -15, clarity: -5, vibrance: 10, temp: 5 },
  landscape: { dehaze: 15, vibrance: 20, clarity: 15 },
  food: { temp: 10, vibrance: 20, saturation: 5, clarity: 5 },
};

/** Settings from the picture's own statistics (no AI): levels, exposure, white balance, colour. */
export function heuristicSettings(c, style = 'natural') {
  const k = Math.min(1, 256 / Math.max(c.width, c.height));
  const t = makeCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
  const hist = new Uint32Array(256);
  let r = 0;
  let b = 0;
  let sat = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const L = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    hist[L]++;
    r += d[i];
    b += d[i + 2];
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - Math.min(d[i], d[i + 1], d[i + 2])) / mx : 0;
    n++;
  }
  if (!n) return { summary: '보이는 픽셀이 없습니다' };
  const pct = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n * p) return v;
    }
    return 255;
  };
  const p1 = pct(0.01);
  const p50 = pct(0.5);
  const p99 = pct(0.99);
  sat /= n;
  const s = {
    exposure: clamp(Math.log2(0.46 / Math.max(0.05, p50 / 255)) * 0.6, -1.5, 1.5),
    blacks: p1 > 8 ? -Math.min(40, p1 * 1.2) : 0,
    whites: p99 < 245 ? Math.min(40, (245 - p99) * 1.2) : 0,
    contrast: p99 - p1 < 180 ? 12 : 0,
    // grey world: a blue cast warms up, a yellow one cools down
    temp: clamp(((b - r) / n / 128) * 60, -30, 30),
    vibrance: sat < 0.25 ? 25 : sat < 0.4 ? 12 : 0,
    clarity: 8,
    sharpen: 20,
  };
  const off = STYLE_OFFSETS[style] || {};
  for (const [key, v] of Object.entries(off)) {
    if (typeof v === 'number') s[key] = (s[key] || 0) + v;
    else s[key] = v;
  }
  const parts = [];
  if (Math.abs(s.exposure) > 0.1) parts.push(s.exposure > 0 ? '밝게' : '어둡게');
  if (s.blacks || s.whites) parts.push('명암 범위를 넓혀');
  if (Math.abs(s.temp) > 4) parts.push(s.temp > 0 ? '따뜻하게' : '시원하게');
  if (s.vibrance > 0) parts.push('색을 살려');
  s.summary = `히스토그램으로 계산했어요: ${parts.length ? parts.join(', ') : '거의 그대로 두고'} 다듬었습니다.`;
  return s;
}

/** Keep only known settings, within their ranges, scaled by strength (0..1). */
function cleanSettings(s, strength = 1) {
  const out = {};
  for (const [key, , min, max] of CR()) {
    const v = Number(s?.[key]);
    if (Number.isFinite(v) && v !== 0) out[key] = clamp(v * strength, min, max);
  }
  const look = LOOK_IDS().includes(s?.look) ? s.look : null;
  return {
    cr: out,
    look,
    lookAmount: look ? clamp(Number(s.lookAmount ?? 60) * strength, 0, 100) : 0,
    sharpen: clamp(Number(s?.sharpen || 0) * strength, 0, 100),
    straighten: clamp(Number(s?.straighten || 0), -15, 15),
    crop: s?.crop && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(s.crop[k]))) ? s.crop : null,
    summary: String(s?.summary || ''),
  };
}

/**
 * Apply cleaned enhance settings: optional crop, then a new layer (the visible picture) or the
 * active layer gets straightening, Camera Raw, a look and sharpening.
 */
function applyEnhance(P, set, { asLayer = true, label = 'AI 자동 보정', allowStraighten = true, allowCrop = false } = {}) {
  const doc = P.doc;
  if (allowCrop && set.crop) {
    const r = { x: Math.round(clamp(set.crop.x, 0, 1) * doc.width), y: Math.round(clamp(set.crop.y, 0, 1) * doc.height) };
    r.w = Math.round(clamp(set.crop.w, 0.2, 1) * doc.width);
    r.h = Math.round(clamp(set.crop.h, 0.2, 1) * doc.height);
    r.w = Math.min(r.w, doc.width - r.x);
    r.h = Math.min(r.h, doc.height - r.y);
    if (r.w > 16 && r.h > 16 && (r.w < doc.width || r.h < doc.height)) P.cropTo(r, false, '구도 자르기');
  }
  let l = doc.active;
  if (asLayer || l?.kind !== 'raster' || !l.canvas) {
    P.run('보정할 레이어', () => {
      l = newLayer('raster', { name: label, canvas: doc.flatten({ fg: P.fg, bg: P.bg }) });
      doc.layers.push(l);
      doc.activeId = l.id;
      doc.selectedIds = [l.id];
    });
  }
  P.run(label, () => {
    let c = l.canvas;
    if (allowStraighten && Math.abs(set.straighten) >= 0.2) c = rotateFill(c, -set.straighten);
    if (Object.keys(set.cr).length) c = FILTERS.cameraRaw.fn(c, { ...defaultFilterParams('cameraRaw'), ...set.cr }, { fg: P.fg, bg: P.bg });
    if (set.look && set.lookAmount > 0) {
      const g = c.getContext('2d');
      const img = g.getImageData(0, 0, c.width, c.height);
      applyAdjustment(img, 'colorLookup', { look: set.look, amount: set.lookAmount });
      if (c === l.canvas) c = makeCanvas(c.width, c.height);
      c.getContext('2d').putImageData(img, 0, 0);
    }
    if (set.sharpen > 0) c = applyFilter(c, 'unsharp', { amount: set.sharpen * 1.5, radius: 1.2, threshold: 2 });
    l.canvas = c;
    l._styled = null;
    doc.touch(l);
  });
  return l;
}

const ENHANCE_SCHEMA = () => ({
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: '무엇을 왜 바꿨는지 한국어 한두 문장' },
    ...Object.fromEntries(CR().map(([key, label, min, max]) => [key, { type: 'NUMBER', description: `${label} (${min}~${max}, 0 = 그대로)` }])),
    look: { type: 'STRING', enum: ['none', ...LOOK_IDS()] },
    lookAmount: { type: 'NUMBER', description: '룩 강도 0~100' },
    sharpen: { type: 'NUMBER', description: '선명하게 0~100' },
    straighten: { type: 'NUMBER', description: '수평이 기울었으면 바로잡을 각도(도, 시계 방향이 +). 기울지 않았으면 0' },
    crop: { type: 'OBJECT', description: '구도를 위해 자를 영역(0~1 비율). 자를 필요가 없으면 생략', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, w: { type: 'NUMBER' }, h: { type: 'NUMBER' } } },
  },
  required: ['summary'],
});

async function askEnhance(P, style, signal) {
  const styleName = ENHANCE_STYLES.find((s) => s[0] === style)?.[1] || '자연스럽게';
  const body = {
    systemInstruction: { parts: [{ text: '당신은 사진 보정 전문가입니다. 사진을 보고 Camera Raw 슬라이더 값을 고릅니다. 과하지 않게, 사진의 문제(노출, 화이트 밸런스, 대비, 기울기)를 먼저 바로잡고 요청한 스타일을 더하세요. 모르는 것은 0으로 두세요.' }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegB64(P.composite()) } }, { text: `이 사진을 "${styleName}" 스타일로 보정할 값을 JSON으로 주세요.` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: ENHANCE_SCHEMA() },
  };
  const d = await generate(body, signal);
  return parseJson(textOf(firstCandidate(d).content));
}

// ---------------------------------------------------------------- assistant tools

const O = (properties, required = []) => ({ type: 'OBJECT', properties, required });
const N = (description) => ({ type: 'NUMBER', description });
const S = (description, e) => ({ type: 'STRING', description, ...(e ? { enum: e } : {}) });
const B = (description) => ({ type: 'BOOLEAN', description });
const FONTS = ['Noto Sans KR', 'Noto Serif KR', 'Black Han Sans', 'Do Hyeon', 'Jua', 'Nanum Pen Script'];

/** The active raster layer, or a new one with the visible picture when there is none. */
function targetLayer(P, name = 'AI 편집') {
  const doc = P.doc;
  const l = doc.active;
  if (l?.kind === 'raster' && l.canvas) return l;
  let nl;
  P.run('보이는 레이어 도장 찍기', () => {
    nl = newLayer('raster', { name, canvas: doc.flatten({ fg: P.fg, bg: P.bg }) });
    doc.layers.push(nl);
    doc.activeId = nl.id;
    doc.selectedIds = [nl.id];
  });
  return nl;
}

function box01(doc, a) {
  const x = clamp(Number(a.x) || 0, 0, 1) * doc.width;
  const y = clamp(Number(a.y) || 0, 0, 1) * doc.height;
  return { x, y, w: clamp(Number(a.w) || 0, 0, 1) * doc.width, h: clamp(Number(a.h) || 0, 0, 1) * doc.height };
}

function parseParams(json) {
  if (!json) return {};
  try {
    const v = typeof json === 'string' ? JSON.parse(json) : json;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function makeTools(P) {
  const C = P.cmd;
  const doc = () => P.doc;
  const adjIds = Object.keys(ADJUSTMENTS);
  const filterIds = Object.keys(FILTERS).filter((id) => id !== 'cameraRaw' && !FILTERS[id].hidden);
  return [
    {
      name: 'camera_raw', label: 'Camera Raw 보정',
      description: '노출·대비·색온도 등 Camera Raw 값으로 사진 전체를 보정합니다(보이는 사진을 새 레이어로 만들어 적용). 0은 그대로입니다.',
      parameters: O({ ...Object.fromEntries(CR().map(([key, label, min, max]) => [key, N(`${label} (${min}~${max})`)])), look: S('색상 룩', ['none', ...LOOK_IDS()]), lookAmount: N('룩 강도 0~100'), sharpen: N('선명하게 0~100') }),
      run(a) {
        const set = cleanSettings(a, 1);
        applyEnhance(P, set, { label: 'AI 보정', allowStraighten: false });
        return { ok: true, applied: set.cr };
      },
    },
    {
      name: 'adjustment_layer', label: '조정 레이어',
      description: `원본을 바꾸지 않는 조정 레이어를 추가합니다. 선택 영역이 있으면 그 부분에만. 종류별 매개변수 이름: ${adjIds.map((id) => `${id}(${(ADJUSTMENTS[id].params || []).map((p) => p[0]).join(',')})`).join('; ')}`,
      parameters: O({ type: S('조정 종류', adjIds), params_json: S('매개변수 JSON 문자열, 예: {"hue":20,"saturation":15}') }, ['type']),
      run(a) {
        const type = a.type;
        if (!ADJUSTMENTS[type]) throw new Error(`없는 조정: ${type}`);
        const params = { ...defaultParams(type), ...parseParams(a.params_json) };
        P.run(`조정 레이어: ${ADJUSTMENTS[type].name}`, () => {
          const l = newLayer('adjust', { name: ADJUSTMENTS[type].name, adjust: { type, params } });
          doc().addMask(l, 'white', !!doc().selection);
          P.addLayer(l);
        });
        return { ok: true, type, params };
      },
    },
    {
      name: 'apply_filter', label: '필터',
      description: '지금 레이어(이미지 레이어가 아니면 보이는 사진을 새 레이어로)에 필터를 적용합니다. 선택 영역이 있으면 그 안에만.',
      parameters: O({ id: S('필터', filterIds), params_json: S('매개변수 JSON 문자열(생략하면 기본값)') }, ['id']),
      run(a) {
        if (!filterIds.includes(a.id)) throw new Error(`없는 필터: ${a.id}`);
        const p = { ...defaultFilterParams(a.id), ...parseParams(a.params_json) };
        const l = targetLayer(P);
        P.doc.activeId = l.id;
        P.run(`필터: ${FILTERS[a.id]?.name || a.id}`, () => applyToLayer(P, (c) => applyFilter(c, a.id, p, { fg: P.fg, bg: P.bg })));
        return { ok: true, id: a.id, params: p };
      },
    },
    {
      name: 'select', label: '선택',
      description: '선택 영역을 만듭니다. subject=주요 피사체, sky=하늘, object=box 안의 물체, box=사각형 그대로, all, none, invert. box는 0~1 비율(x,y는 왼쪽 위).',
      parameters: O({ what: S('무엇을', ['subject', 'sky', 'object', 'box', 'all', 'none', 'invert']), x: N('box x'), y: N('box y'), w: N('box w'), h: N('box h') }, ['what']),
      run(a) {
        const d = doc();
        const comp = P.composite();
        let m = null;
        if (a.what === 'subject') m = SX.selectSubject(comp);
        else if (a.what === 'sky') m = SX.selectSky(comp);
        else if (a.what === 'object') m = SX.objectSelect(comp, box01(d, a));
        else if (a.what === 'box') {
          const r = box01(d, a);
          m = SEL.shapeMask(d, SEL.rectPath(r.x, r.y, r.w, r.h));
        }
        P.run('AI 선택', () => {
          if (a.what === 'all') d.selection = SEL.selectAll(d);
          else if (a.what === 'none') d.selection = null;
          else if (a.what === 'invert') d.selection = SEL.invert(d);
          else d.selection = m ? SEL.combine(d, m, 'new') : null;
        });
        const b = d.selection && SEL.alphaBounds(d.selection.canvas);
        return { ok: !!d.selection || a.what === 'none', bounds01: b && { x: +(b.x / d.width).toFixed(3), y: +(b.y / d.height).toFixed(3), w: +(b.w / d.width).toFixed(3), h: +(b.h / d.height).toFixed(3) } };
      },
    },
    {
      name: 'remove_background', label: '배경 지우기',
      description: '보이는 사진을 새 레이어로 만들어 주요 피사체만 남기고(레이어 마스크) 나머지 레이어는 숨깁니다. 배경이 투명해집니다.',
      parameters: O({}),
      run() {
        const d = doc();
        const m = SX.selectSubject(P.composite());
        if (!m) throw new Error('피사체를 찾지 못했습니다');
        let hidden = 0;
        P.run('배경 지우기', () => {
          const l = newLayer('raster', { name: '피사체 (배경 지움)', canvas: d.flatten({ fg: P.fg, bg: P.bg }) });
          for (const o of d.layers) {
            if (o.parent || o.visible === false) continue;
            o.visible = false;
            hidden++;
          }
          d.layers.push(l);
          d.activeId = l.id;
          d.selectedIds = [l.id];
          d.selection = SEL.combine(d, m, 'new');
          d.addMask(l, 'white', true);
          // a subject cut-out: the task bar offers Generate Background for it
          l.mask.subject = true;
          d.selection = null;
          d.touch(l);
        });
        return { ok: true, hidden_layers: hidden };
      },
    },
    {
      name: 'blur_background', label: '배경 흐리게',
      description: '피사체는 그대로 두고 배경만 흐리게 합니다(새 레이어 + 마스크).',
      parameters: O({ amount: N('흐림 정도(px, 2~60)') }),
      run(a) {
        const d = doc();
        const m = SX.selectSubject(P.composite());
        if (!m) throw new Error('피사체를 찾지 못했습니다');
        const amt = clamp(Number(a.amount) || 12, 1, 80);
        P.run('배경 흐리게', () => {
          const l = newLayer('raster', { name: '흐린 배경', canvas: applyFilter(d.flatten({ fg: P.fg, bg: P.bg }), 'gaussian', { radius: amt }) });
          d.layers.push(l);
          d.activeId = l.id;
          d.selectedIds = [l.id];
          // the mask hides the blur over the subject (a slightly soft edge)
          const sel = SEL.combine(d, m, 'new');
          d.selection = sel;
          d.selection = SEL.invert(d);
          d.addMask(l, 'white', true);
          d.selection = null;
          d.touch(l);
        });
        return { ok: true, amount: amt };
      },
    },
    {
      name: 'remove_object', label: '물체 지우기',
      description: '사각형(0~1 비율) 안의 물체를 지우고 주변으로 메웁니다(내용 인식).',
      parameters: O({ x: N('왼쪽'), y: N('위'), w: N('폭'), h: N('높이') }, ['x', 'y', 'w', 'h']),
      run(a) {
        const d = doc();
        const r = box01(d, a);
        if (r.w < 2 || r.h < 2) throw new Error('영역이 너무 작습니다');
        const obj = SX.objectSelect(P.composite(), r);
        const W = d.width;
        const H = d.height;
        let hole = obj ? SX.alphaOf(obj) : null;
        if (!hole) {
          hole = new Float32Array(W * H);
          for (let y = Math.floor(r.y); y < Math.min(H, r.y + r.h); y++) for (let x = Math.floor(r.x); x < Math.min(W, r.x + r.w); x++) hole[y * W + x] = 1;
        }
        hole = SX.expandAlpha(hole, W, H, 6);
        const l = targetLayer(P);
        P.run('물체 지우기', () => {
          const c = makeCanvas(W, H);
          c.getContext('2d').drawImage(l.canvas, l.x, l.y);
          const g = c.getContext('2d');
          const img = g.getImageData(0, 0, W, H);
          const hm = new Uint8Array(W * H);
          for (let i = 0; i < hm.length; i++) hm[i] = hole[i] > 0.3 ? 1 : 0;
          inpaint(img.data, W, H, hm);
          g.putImageData(img, 0, 0);
          const out = makeCanvas(l.canvas.width, l.canvas.height);
          out.getContext('2d').drawImage(c, -l.x, -l.y);
          l.canvas = out;
          l._styled = null;
          d.touch(l);
        });
        return { ok: true };
      },
    },
    {
      name: 'add_text', label: '글자 넣기',
      description: '글자 레이어를 넣습니다. x,y는 글자 가운데의 위치(0~1), size는 사진 높이에 대한 글자 크기 비율(0.02~0.3).',
      parameters: O({ text: S('글자'), x: N('가운데 x (0~1)'), y: N('가운데 y (0~1)'), size: N('크기 비율'), color: S('#rrggbb'), font: S('글꼴', FONTS), bold: B('굵게'), shadow: B('그림자'), align: S('정렬', ['left', 'center', 'right']) }, ['text']),
      run(a) {
        const d = doc();
        const size = Math.round(clamp(Number(a.size) || 0.1, 0.02, 0.3) * d.height);
        const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#ffffff';
        const t = P.newText({ font: FONTS.includes(a.font) ? a.font : 'Noto Sans KR', size, bold: a.bold !== false, italic: false, align: a.align || 'center' }, color, {});
        t.content = String(a.text || '').slice(0, 300);
        const l = newLayer('text', { name: t.content.split('\n')[0].slice(0, 30) || '텍스트', text: t });
        const b = P.textBox(l);
        l.x = Math.round(clamp(Number(a.x ?? 0.5), 0, 1) * d.width - b.w / 2);
        l.y = Math.round(clamp(Number(a.y ?? 0.15), 0, 1) * d.height - b.h / 2);
        if (a.shadow !== false) l.fx = { dropShadow: { enabled: true, color: '#000000', blend: 'multiply', opacity: 0.5, angle: 120, distance: Math.max(2, size / 20), spread: 0, size: Math.max(4, size / 8), knockout: true } };
        P.run('글자 넣기', () => P.addLayer(l));
        return { ok: true, layer: l.name };
      },
    },
    {
      name: 'crop_ratio', label: '비율로 자르기',
      description: '사진을 정해진 비율로 자릅니다. focus=subject면 피사체가 가운데 오게.',
      parameters: O({ ratio: S('비율', ['1:1', '4:5', '5:4', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']), focus: S('기준', ['center', 'top', 'bottom', 'left', 'right', 'subject']) }, ['ratio']),
      run(a) {
        const d = doc();
        const [rw, rh] = String(a.ratio || '1:1').split(':').map(Number);
        const k = rw / rh;
        let w = d.width;
        let hh = Math.round(w / k);
        if (hh > d.height) {
          hh = d.height;
          w = Math.round(hh * k);
        }
        let cx = d.width / 2;
        let cy = d.height / 2;
        if (a.focus === 'subject') {
          const m = SX.selectSubject(P.composite());
          const b = m && SEL.alphaBounds(m);
          if (b) {
            cx = b.x + b.w / 2;
            cy = b.y + b.h / 2;
          }
        } else if (a.focus === 'top') cy = 0;
        else if (a.focus === 'bottom') cy = d.height;
        else if (a.focus === 'left') cx = 0;
        else if (a.focus === 'right') cx = d.width;
        const r = { x: Math.round(clamp(cx - w / 2, 0, d.width - w)), y: Math.round(clamp(cy - hh / 2, 0, d.height - hh)), w, h: hh };
        P.cropTo(r, false, `${a.ratio}로 자르기`);
        return { ok: true, width: w, height: hh };
      },
    },
    {
      name: 'rotate_flip', label: '회전·뒤집기',
      description: '이미지 전체를 회전하거나 뒤집습니다.',
      parameters: O({ kind: S('방법', ['cw', 'ccw', '180', 'flipH', 'flipV']) }, ['kind']),
      run(a) {
        C.rotateCanvas(a.kind);
        return { ok: true };
      },
    },
    {
      name: 'straighten', label: '수평 맞추기',
      description: '기울어진 수평을 바로잡습니다(지금 레이어 또는 보이는 사진의 새 레이어). 시계 방향으로 기울었으면 +.',
      parameters: O({ degrees: N('기운 각도(도, -15~15)') }, ['degrees']),
      run(a) {
        const deg = clamp(Number(a.degrees) || 0, -15, 15);
        const l = targetLayer(P);
        P.run('수평 맞추기', () => {
          l.canvas = rotateFill(l.canvas, -deg);
          l._styled = null;
          doc().touch(l);
        });
        return { ok: true, degrees: deg };
      },
    },
    {
      name: 'color_overlay', label: '색 덧씌우기',
      description: '단색 칠 레이어를 혼합 모드와 불투명도로 덧씌웁니다(분위기 내기).',
      parameters: O({ color: S('#rrggbb'), blend: S('혼합 모드', ['normal', 'multiply', 'screen', 'overlay', 'soft light', 'color', 'hue', 'luminosity']), opacity: N('불투명도 0~1') }, ['color']),
      run(a) {
        const d = doc();
        const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#ff8800';
        P.run('색 덧씌우기', () => {
          const l = newLayer('fill', { name: '색 덧씌우기', fill: { type: 'solid', color } });
          l.blend = a.blend || 'soft light';
          l.opacity = clamp(Number(a.opacity ?? 0.3), 0, 1);
          d.addMask(l, 'white', !!d.selection);
          P.addLayer(l);
        });
        return { ok: true };
      },
    },
    {
      name: 'auto_fix', label: '자동 보정',
      description: '자동 톤·자동 대비·자동 색상 중 하나를 지금 레이어에 적용합니다.',
      parameters: O({ kind: S('종류', ['tone', 'contrast', 'color']) }, ['kind']),
      run(a) {
        targetLayer(P);
        ({ tone: C.autoTone, contrast: C.autoContrast, color: C.autoColor }[a.kind] || C.autoTone)?.();
        return { ok: true };
      },
    },
  ];
}

function docContext(P) {
  const d = P.doc;
  return {
    width: d.width, height: d.height, selection: !!d.selection,
    layers: d.layers.map((l) => ({ name: l.name, kind: l.kind, visible: l.visible !== false, active: l.id === d.activeId })),
  };
}

const SYSTEM = [
  '당신은 브라우저 사진 편집기 "Montage" 안의 사진 편집 도우미입니다. 사용자는 한국어로 요청합니다.',
  '- 요청과 함께 지금 사진(작게 줄인 JPEG)과 레이어 목록이 옵니다. 사진을 보고 판단하세요.',
  '- 편집은 반드시 도구(함수)로 하세요. 위치와 크기는 사진 폭·높이에 대한 0~1 비율입니다(x는 오른쪽, y는 아래로).',
  '- 여러 도구를 차례로 써도 됩니다. 이번 요청의 모든 편집은 실행 취소(Ctrl+Z) 한 번으로 되돌릴 수 있습니다.',
  '- 새로운 물체를 그려 넣는 일(생성)은 도구로 할 수 없습니다. 그런 요청에는 "생성형 채우기(실험적)"를 쓰라고 안내하세요.',
  '- 끝나면 무엇을 했는지 한국어로 짧게 알려 주세요. 확실하지 않은 것은 확실하지 않다고 말하세요.',
].join('\n');

/** One assistant request (one undo step). Returns {text, edits}. */
export async function runPhotoAssistant(P, prompt, { history = [], onEvent = () => {}, signal, maxRounds = 8 } = {}) {
  const tools = makeTools(P);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const decl = [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }];
  const contents = history.slice(-6).map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegB64(P.composite()) } }, { text: `[문서]\n${JSON.stringify(docContext(P))}` }, { text: `[요청]\n${prompt}` }] });
  let edits = 0;
  const startDoc = P.doc;
  return oneStep(P, `AI 편집: ${prompt.slice(0, 24)}`, async () => {
    for (let round = 0; round < maxRounds; round++) {
      const d = await generate({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: decl, generationConfig: { temperature: 0.2 } }, signal);
      if (P.doc !== startDoc) throw new Error(DOC_CHANGED);
      const cand = firstCandidate(d);
      contents.push(cand.content);
      const calls = (cand.content.parts || []).filter((p) => p.functionCall);
      if (!calls.length) return { text: textOf(cand.content) || '(답이 비어 있습니다)', edits };
      const responses = [];
      for (const { functionCall: fc } of calls) {
        const tool = byName[fc.name];
        let response;
        if (!tool) response = { error: `없는 도구입니다: ${fc.name}` };
        else {
          try {
            const result = (await tool.run(fc.args || {})) || {};
            edits++;
            response = { result };
            onEvent({ name: fc.name, label: tool.label, args: fc.args, result });
          } catch (err) {
            response = { error: String(err?.message || err) };
            onEvent({ name: fc.name, label: tool.label, args: fc.args, error: response.error });
          }
        }
        responses.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } });
      }
      responses[responses.length - 1].functionResponse.response.document_after = docContext(P);
      contents.push({ role: 'user', parts: responses });
    }
    return { text: '요청이 길어져 중간에 멈췄습니다. 지금까지 한 편집은 남아 있습니다.', edits };
  });
}

// ---------------------------------------------------------------- generative fill, expand, image, background

/** The image-capable Gemini model to use, or null. */
async function imageModel(signal) {
  const ids = await listAllGeminiModels(signal);
  const img = ids.filter((id) => /image/.test(id) && !/imagen/.test(id));
  const rank = (id) => (/2\.5-flash-image(?!-preview)/.test(id) ? 4 : /flash-image/.test(id) ? 3 : /image-generation/.test(id) ? 2 : 1);
  return img.sort((a, b) => rank(b) - rank(a))[0] || null;
}
const NO_IMAGE_MODEL = '이 API 키로 쓸 수 있는 이미지 생성 Gemini 모델이 없습니다 (예: gemini-2.5-flash-image)';
const MAGENTA = '#ff00ff';

/** The picture in a Gemini answer as an ImageBitmap. */
async function imageFrom(d) {
  const parts = firstCandidate(d).content.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data && /^image\//.test(p.inlineData.mimeType || ''));
  if (!imgPart) throw new Error(`Gemini가 이미지를 돌려주지 않았습니다${textOf({ parts }) ? `: ${textOf({ parts }).slice(0, 120)}` : ''}`);
  const blob = await (await fetch(`data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`)).blob();
  return createImageBitmap(blob);
}

/** A canvas as base64 PNG, at most `max` pixels on its long side. */
function pngB64(c, max = 1024) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  const send = makeCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const g = send.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, send.width, send.height);
  return send.toDataURL('image/png').split(',')[1];
}

/** Ask the image model to repaint the magenta part of a picture. */
async function repaint(model, picture, instruction, signal) {
  const d = await generateWith(model, {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: pngB64(picture) } }, { text: instruction }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  }, signal);
  return imageFrom(d);
}

/** Gemini's supported picture shapes; the closest one to a document's. */
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export function nearestAspect(r) {
  let best = ASPECTS[0];
  let bd = Infinity;
  for (const a of ASPECTS) {
    const [w, hh] = a.split(':').map(Number);
    const dd = Math.abs(Math.log(w / hh) - Math.log(r));
    if (dd < bd) {
      bd = dd;
      best = a;
    }
  }
  return best;
}

/**
 * Redraw the selected area with an image-capable Gemini model: the area around the selection goes
 * out with the selection painted magenta, and the answer comes back as a new masked layer.
 */
export async function generativeFill(P, prompt, signal) {
  const doc = P.doc;
  if (!doc?.selection) throw new Error('먼저 다시 그릴 곳을 선택하세요');
  const b = SEL.alphaBounds(doc.selection.canvas);
  if (!b) throw new Error('선택 영역이 비어 있습니다');
  const model = await imageModel(signal);
  if (!model) throw new Error(NO_IMAGE_MODEL);
  const pad = Math.max(48, Math.round(Math.max(b.w, b.h) * 0.3));
  const r = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad) };
  r.w = Math.min(doc.width, b.x + b.w + pad) - r.x;
  r.h = Math.min(doc.height, b.y + b.h + pad) - r.y;
  const crop = makeCanvas(r.w, r.h);
  const cg = crop.getContext('2d');
  cg.fillStyle = '#ffffff';
  cg.fillRect(0, 0, r.w, r.h);
  cg.drawImage(P.composite(), -r.x, -r.y);
  const mark = makeCanvas(r.w, r.h);
  const mg = mark.getContext('2d');
  mg.drawImage(doc.selection.canvas, -r.x, -r.y);
  mg.globalCompositeOperation = 'source-in';
  mg.fillStyle = MAGENTA;
  mg.fillRect(0, 0, r.w, r.h);
  cg.drawImage(mark, 0, 0);
  const sel = doc.selection;
  const what = prompt.trim() || '주변과 자연스럽게 이어지는 배경으로 지워 주세요';
  const bmp = await repaint(model, crop, `이 이미지에서 자홍색(#FF00FF)으로 칠한 부분만 다시 그려 채워 주세요: ${what}. 자홍색 바깥은 그대로 두고, 같은 크기와 같은 구도의 이미지 한 장으로 돌려주세요. 자홍색이 남지 않게 하세요.`, signal);
  if (P.doc !== doc) throw new Error(DOC_CHANGED);
  return oneStep(P, `생성형 채우기: ${what.slice(0, 20)}`, () => {
    P.run('생성형 채우기', () => {
      const c = makeCanvas(doc.width, doc.height);
      c.getContext('2d').drawImage(bmp, r.x, r.y, r.w, r.h);
      const l = newLayer('raster', { name: `생성형 채우기: ${what.slice(0, 16)}`, canvas: c });
      P.addLayer(l);
      // only the selected area shows (slightly softened edge)
      const m = makeCanvas(doc.width, doc.height);
      const g = m.getContext('2d');
      g.filter = 'blur(1.5px)';
      g.drawImage(sel.canvas, 0, 0);
      l.mask = { canvas: m, x: 0, y: 0, enabled: true, linked: true };
      doc.selection = null;
      doc.touch(l);
    });
    return { model };
  });
}

/**
 * Generative Expand: the crop box `rect` (doc coords) reaches past the canvas; the canvas grows to it
 * and the new area is painted by the image model to continue the picture (a new masked layer).
 */
export async function generativeExpand(P, rect, prompt, signal) {
  const doc = P.doc;
  if (!doc) throw new Error('문서가 없습니다');
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  const W = doc.width;
  const H = doc.height;
  if (!(r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H)) throw new Error('자르기 상자를 캔버스 밖으로 넓힌 다음에 생성하세요');
  if (r.w < 8 || r.h < 8) throw new Error('자르기 상자가 너무 작습니다');
  if (r.w * r.h > 60e6) throw new Error('결과가 너무 큽니다');
  const model = await imageModel(signal);
  if (!model) throw new Error(NO_IMAGE_MODEL);
  const pic = makeCanvas(r.w, r.h);
  const g = pic.getContext('2d');
  g.fillStyle = MAGENTA;
  g.fillRect(0, 0, r.w, r.h);
  // inside the old canvas: the picture as it shows (see-through parts on white)
  g.fillStyle = '#ffffff';
  g.fillRect(-r.x, -r.y, W, H);
  g.drawImage(P.composite(), -r.x, -r.y);
  const what = prompt.trim();
  const bmp = await repaint(model, pic, `이 이미지의 자홍색(#FF00FF) 부분은 사진이 잘려서 비어 있는 곳입니다. 가운데 사진과 자연스럽게 이어지도록 ${what ? `"${what}"(으)로` : '주변과 어울리게'} 채워 주세요. 자홍색이 아닌 부분은 그대로 두고, 같은 크기와 비율의 이미지 한 장으로 돌려주세요. 자홍색이 남지 않게 하세요.`, signal);
  if (P.doc !== doc) throw new Error(DOC_CHANGED);
  return oneStep(P, '생성형 확장', () => {
    P.cropTo(r, false, '자르기');
    P.run('생성형 확장', () => {
      const c = makeCanvas(r.w, r.h);
      const cg = c.getContext('2d');
      cg.imageSmoothingQuality = 'high';
      cg.drawImage(bmp, 0, 0, r.w, r.h);
      const l = newLayer('raster', { name: `생성형 확장${what ? `: ${what.slice(0, 16)}` : ''}`, canvas: c });
      // shown in the new area only, blending a few pixels into the old picture's edge
      const m = makeCanvas(r.w, r.h);
      const mg = m.getContext('2d');
      mg.fillStyle = '#000';
      mg.fillRect(0, 0, r.w, r.h);
      const f = Math.max(2, Math.round(Math.min(W, H) * 0.008));
      // the soft band only along the sides that grew (elsewhere the hole runs past the edge)
      const far = f * 4;
      const left = r.x < 0 ? -r.x + f : -r.x - far;
      const top = r.y < 0 ? -r.y + f : -r.y - far;
      const right = r.x + r.w > W ? -r.x + W - f : -r.x + W + far;
      const bottom = r.y + r.h > H ? -r.y + H - f : -r.y + H + far;
      mg.globalCompositeOperation = 'destination-out';
      mg.filter = `blur(${f / 2}px)`;
      mg.fillRect(left, top, right - left, bottom - top);
      l.mask = { canvas: m, x: 0, y: 0, enabled: true, linked: true };
      doc.layers.push(l);
      doc.activeId = l.id;
      doc.selectedIds = [l.id];
      doc.touch(l);
    });
    return { model, width: r.w, height: r.h };
  });
}

/** Edit ▸ Generate Image: a picture from a description, as a new layer covering the canvas. */
export async function generateImage(P, prompt, signal) {
  const doc = P.doc;
  if (!doc) throw new Error('먼저 문서를 만드세요');
  const what = prompt.trim();
  if (!what) throw new Error('무엇을 그릴지 적어 주세요');
  const model = await imageModel(signal);
  if (!model) throw new Error(NO_IMAGE_MODEL);
  const aspect = nearestAspect(doc.width / doc.height);
  const body = {
    contents: [{ role: 'user', parts: [{ text: `${what}\n\n가로:세로가 ${aspect}인 이미지 한 장으로 만들어 주세요.` }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } },
  };
  let d;
  try {
    d = await generateWith(model, body, signal);
  } catch (err) {
    if (err?.name === 'AbortError' || !/imageConfig|aspect|Unknown name|Invalid JSON|400/i.test(String(err?.message))) throw err;
    // an older image model without the aspect setting
    delete body.generationConfig.imageConfig;
    d = await generateWith(model, body, signal);
  }
  const bmp = await imageFrom(d);
  if (P.doc !== doc) throw new Error(DOC_CHANGED);
  return oneStep(P, `이미지 생성: ${what.slice(0, 20)}`, () => {
    P.run('이미지 생성', () => {
      // cover the canvas, centred (the picture keeps its proportions)
      const c = makeCanvas(doc.width, doc.height);
      const g = c.getContext('2d');
      const k = Math.max(doc.width / bmp.width, doc.height / bmp.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (doc.width - bmp.width * k) / 2, (doc.height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      P.addLayer(newLayer('raster', { name: `생성된 이미지: ${what.slice(0, 16)}`, canvas: c }));
    });
    return { model };
  });
}

/** The active layer as it shows (its pixels through its mask), document size. */
function shownLayer(P, l) {
  const c = P.layerAsDocCanvas(l);
  if (l.mask && l.mask.enabled !== false) {
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(l.mask.canvas, l.mask.x || 0, l.mask.y || 0);
  }
  return c;
}

/**
 * Generate Background: the active layer is a cut-out subject (Remove Background); a new background
 * is painted behind it, as a layer right below it.
 */
export async function generateBackground(P, prompt, signal) {
  const doc = P.doc;
  const l = doc?.active;
  if (!l || !['raster', 'smart'].includes(l.kind)) throw new Error('배경을 지운 피사체 레이어를 고르세요 (레이어 ▸ 배경 제거)');
  const subj = shownLayer(P, l);
  // how much of the picture is still empty around the subject
  const t = makeCanvas(64, 64);
  const tg = t.getContext('2d');
  tg.drawImage(subj, 0, 0, 64, 64);
  const a = tg.getImageData(0, 0, 64, 64).data;
  let clear = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i] < 128) clear++;
  if (clear < 64 * 64 * 0.03) throw new Error('이 레이어에는 비어 있는 배경이 없습니다. 먼저 레이어 ▸ 배경 제거(또는 마스크)로 배경을 지우세요.');
  if (clear > 64 * 64 * 0.995) throw new Error('이 레이어가 비어 있습니다. 피사체가 있는 레이어를 고르세요.');
  const model = await imageModel(signal);
  if (!model) throw new Error(NO_IMAGE_MODEL);
  const pic = makeCanvas(doc.width, doc.height);
  const g = pic.getContext('2d');
  g.fillStyle = MAGENTA;
  g.fillRect(0, 0, pic.width, pic.height);
  g.drawImage(subj, 0, 0);
  const what = prompt.trim() || '피사체에 어울리는 자연스러운 배경';
  const bmp = await repaint(model, pic, `이 이미지에서 자홍색(#FF00FF) 부분은 비어 있는 배경입니다. 그 부분을 "${what}"(으)로 채워 주세요. 피사체는 모양과 색을 바꾸지 말고 그대로 두고, 빛과 그림자가 피사체와 어울리게 하세요. 같은 크기와 구도의 이미지 한 장으로 돌려주세요. 자홍색이 남지 않게 하세요.`, signal);
  if (P.doc !== doc || !doc.layer(l.id)) throw new Error(DOC_CHANGED);
  return oneStep(P, `배경 생성: ${what.slice(0, 20)}`, () => {
    P.run('배경 생성', () => {
      const c = makeCanvas(doc.width, doc.height);
      const cg = c.getContext('2d');
      cg.imageSmoothingQuality = 'high';
      cg.drawImage(bmp, 0, 0, doc.width, doc.height);
      const bgl = newLayer('raster', { name: `생성된 배경: ${what.slice(0, 16)}`, canvas: c, parent: l.parent || null });
      // right below the subject, in the same group
      doc.layers.splice(doc.index(l.id), 0, bgl);
      doc.touch(bgl);
    });
    return { model };
  });
}

/**
 * A small window for a generative request: a description, a Generate button, the status while
 * Gemini works (it can take a while) and Cancel. run(prompt, signal) does the work.
 */
export function generativeDialog(P, { title, label = '무엇을 만들까요?', placeholder = '', note = '', optional = false, run }) {
  if (!geminiSettings.key) {
    toast('Gemini API 키가 필요합니다 (AI 패널 ▸ 설정)');
    P.showPanel('ai');
    return;
  }
  const input = h('input', { type: 'text', placeholder, 'aria-label': label, style: { width: '100%' } });
  const status = h('div.note', note);
  let ctrl = null;
  const m = openModal({
    title,
    width: '460px',
    body: [h('div.form-row', h('label', label), input), status, h('div.note', '키가 있는 Gemini 이미지 모델로 그립니다. 결과는 새 레이어로 들어가고, 실행 취소 한 번으로 되돌릴 수 있어요.')],
    buttons: [{ label: '취소', action: () => { ctrl?.abort(); } }, {
      label: '생성', primary: true, action: async () => {
        if (ctrl) return false;
        if (!optional && !input.value.trim()) {
          status.textContent = '설명을 적어 주세요';
          input.focus();
          return false;
        }
        ctrl = new AbortController();
        status.textContent = 'Gemini가 그리는 중… (수십 초 걸릴 수 있어요)';
        for (const b of m.footer.querySelectorAll('button.primary')) b.disabled = true;
        try {
          await run(input.value, ctrl.signal);
          toast(`${title}: 새 레이어로 넣었습니다`);
          return undefined;
        } catch (err) {
          if (err?.name === 'AbortError') return undefined;
          status.textContent = String(err?.message || err);
          return false;
        } finally {
          ctrl = null;
          for (const b of m.footer.querySelectorAll('button.primary')) b.disabled = false;
        }
      },
    }],
    onClose: () => ctrl?.abort(),
  });
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- panel

export function buildAiPanel(P) {
  const el = h('div.ph-panel.ph-ai');
  let busy = null;
  const log = h('div.ph-ailog', { 'aria-live': 'polite' });
  const history = [];
  const say = (who, text, cls = '') => {
    log.append(h(`div.ph-aimsg.${who}${cls ? `.${cls}` : ''}`, ...[text].flat()));
    log.scrollTop = log.scrollHeight;
  };
  const status = h('p.ph-aistatus');
  const setBusy = (ctrl, text) => {
    busy = ctrl;
    status.textContent = text || '';
    for (const b of el.querySelectorAll('button[data-ai]')) b.disabled = !!ctrl;
    stopBtn.hidden = !ctrl;
  };
  const stopBtn = h('button.small', { hidden: true, onclick: () => busy?.abort() }, '멈추기');
  const needDoc = () => {
    if (!P.doc) {
      toast('먼저 사진을 열거나 새 문서를 만드세요');
      return false;
    }
    return true;
  };
  const needKey = () => {
    if (!geminiSettings.key) {
      toast('Gemini API 키를 먼저 넣으세요 (아래 설정)');
      keyForm.hidden = false;
      return false;
    }
    return true;
  };

  // key / model
  const keyIn = h('input', { type: 'password', placeholder: 'Gemini API 키', autocomplete: 'off', 'aria-label': 'Gemini API 키' });
  const remember = h('input', { type: 'checkbox', checked: geminiSettings.remember });
  const modelSel = h('select', { 'aria-label': 'Gemini 모델' });
  const fillModels = (list) => {
    modelSel.replaceChildren(h('option', { value: '' }, '자동 (가장 좋은 모델)'), ...list.map((m) => h('option', { value: m.id }, m.label)));
    modelSel.value = geminiSettings.model || '';
  };
  fillModels(geminiSettings.models || []);
  modelSel.addEventListener('change', () => saveGeminiSettings({ model: modelSel.value }));
  // shown only while a key is saved (renderKey keeps it in step)
  const clearKey = h('button.small', { onclick: () => { saveGeminiSettings({ key: '', remember: false }); renderKey(); } }, '키 지우기');
  const keyForm = h('div.ph-aikey', { hidden: true },
    h('p.ph-ainote', '영상 편집의 AI 탭과 같은 키를 씁니다. ', h('a', { href: API_KEY_PAGE, target: '_blank', rel: 'noopener' }, 'Google AI Studio에서 키 받기')),
    keyIn,
    h('label.ph-aichk', remember, ' 이 브라우저에 기억하기'),
    h('div.ph-airow',
      h('button.small.primary', {
        onclick: async () => {
          saveGeminiSettings({ key: keyIn.value, remember: remember.checked });
          keyIn.value = '';
          renderKey();
          try {
            fillModels(await listGeminiModels());
            toast('키를 저장했습니다');
          } catch (err) {
            toast(String(err.message || err));
          }
        },
      }, '저장'),
      clearKey),
    h('label.ph-airow', h('span', '모델'), modelSel));
  const keyState = h('div.ph-airow.ph-aikeystate');
  const renderKey = () => {
    clearKey.hidden = !geminiSettings.key;
    keyState.replaceChildren(
      h('span', geminiSettings.key ? 'Gemini 연결됨' : 'Gemini 키 없음 (키 없이도 자동 보정은 됩니다)'),
      h('button.small', { onclick: () => { keyForm.hidden = !keyForm.hidden; } }, '설정'));
  };
  renderKey();

  // auto enhance
  let style = 'natural';
  const styleBtns = ENHANCE_STYLES.map(([id, name]) => {
    const b = h('button.small.ph-tog', { onclick: () => { style = id; styleBtns.forEach((x) => x.classList.toggle('on', x === b)); } }, name);
    if (id === style) b.classList.add('on');
    return b;
  });
  const strength = h('input', { type: 'range', min: 10, max: 100, value: 70, 'aria-label': '강도' });
  const strengthN = h('span.ph-aival', '70%');
  strength.addEventListener('input', () => { strengthN.textContent = `${strength.value}%`; });
  const asLayer = h('input', { type: 'checkbox', checked: true });
  const allowStraighten = h('input', { type: 'checkbox', checked: true });
  const allowCrop = h('input', { type: 'checkbox' });
  const result = h('p.ph-airesult');
  const runEnhance = async (useAi) => {
    if (!needDoc() || busy) return;
    if (useAi && !needKey()) return;
    const ctrl = new AbortController();
    setBusy(ctrl, useAi ? 'Gemini가 사진을 보는 중…' : '계산하는 중…');
    try {
      const doc = P.doc;
      const raw = useAi ? await askEnhance(P, style, ctrl.signal) : heuristicSettings(P.composite(), style);
      if (P.doc !== doc) throw new Error(DOC_CHANGED);
      const set = cleanSettings(raw, strength.value / 100);
      // big pictures take a moment: let the status show before the work starts
      status.textContent = '보정을 적용하는 중…';
      await painted();
      await oneStep(P, useAi ? 'AI 자동 보정' : '자동 보정', () => {
        applyEnhance(P, set, { asLayer: asLayer.checked, label: useAi ? 'AI 자동 보정' : '자동 보정', allowStraighten: allowStraighten.checked, allowCrop: allowCrop.checked });
      });
      result.textContent = set.summary || '보정했습니다.';
      toast(useAi ? 'AI 자동 보정을 했습니다 (Ctrl+Z로 되돌리기)' : '자동 보정을 했습니다');
    } catch (err) {
      if (err?.name !== 'AbortError') {
        result.textContent = String(err.message || err);
        toast(String(err.message || err));
      }
    } finally {
      setBusy(null);
    }
  };

  // assistant
  const ask = h('textarea.ph-aiask', { rows: 2, placeholder: '예: 배경을 흐리게 하고 위에 "여름 휴가" 글자를 넣어 줘', 'aria-label': 'AI에게 요청' });
  const send = async (text) => {
    const q = (text ?? ask.value).trim();
    if (!q || !needDoc() || !needKey() || busy) return;
    ask.value = '';
    say('me', q);
    const ctrl = new AbortController();
    setBusy(ctrl, 'Gemini가 사진을 보고 생각하는 중…');
    try {
      const r = await runPhotoAssistant(P, q, {
        history,
        signal: ctrl.signal,
        onEvent: (e) => say('tool', [icon(e.error ? 'close' : 'check', 12), ` ${e.label}${e.error ? `: ${e.error}` : ''}`], e.error ? 'err' : ''),
      });
      say('ai', r.text);
      history.push({ role: 'user', text: q }, { role: 'model', text: r.text });
    } catch (err) {
      if (err?.name !== 'AbortError') say('ai', String(err.message || err), 'err');
    } finally {
      setBusy(null);
    }
  };
  ask.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  const quick = [['배경 지우기', '배경을 지워서 피사체만 남겨 줘'], ['배경 흐리게', '피사체는 그대로 두고 배경만 흐리게 해 줘'], ['인스타 정사각형', '피사체가 가운데 오게 1:1로 잘라 줘'], ['감성 보정', '따뜻하고 부드러운 감성 사진처럼 보정해 줘'], ['흑백 고대비', '대비가 강한 흑백 사진으로 만들어 줘'], ['제목 넣기', '사진에 어울리는 짧은 제목을 위쪽에 넣어 줘']];

  // generative fill / expand / image / background
  const genIn = h('input', { type: 'text', placeholder: '무엇을 그릴까요? (채우기는 비우면 주변처럼 지우기)', 'aria-label': '생성형 AI 설명' });
  genIn.addEventListener('keydown', (e) => e.stopPropagation());
  const runGen = async (kind) => {
    if (!needDoc() || !needKey() || busy) return;
    const ctrl = new AbortController();
    setBusy(ctrl, 'Gemini 이미지 모델이 그리는 중… (수십 초 걸릴 수 있어요)');
    try {
      const crop = P.cropExtent?.();
      const r = kind === 'fill' ? await generativeFill(P, genIn.value, ctrl.signal)
        : kind === 'expand' ? await generativeExpand(P, crop || expandBox(P.doc), genIn.value, ctrl.signal)
          : kind === 'image' ? await generateImage(P, genIn.value, ctrl.signal)
            : await generateBackground(P, genIn.value, ctrl.signal);
      toast(`${{ fill: '생성형 채우기', expand: '생성형 확장', image: '이미지 생성', background: '배경 생성' }[kind]}: 새 레이어로 넣었습니다 (${r.model})`);
    } catch (err) {
      if (err?.name !== 'AbortError') toast(String(err.message || err));
    } finally {
      setBusy(null);
    }
  };

  el.append(
    keyState, keyForm,
    h('h4.ph-aih', 'AI 자동 보정'),
    h('div.ph-aistyles', ...styleBtns),
    h('label.ph-airow', h('span', '강도'), strength, strengthN),
    h('label.ph-aichk', asLayer, ' 새 레이어로 (원본 보존)'),
    h('label.ph-aichk', allowStraighten, ' 기울어진 수평 바로잡기'),
    h('label.ph-aichk', allowCrop, ' 구도에 맞게 자르기 (AI)'),
    h('div.ph-airow', h('button.primary.small', { 'data-ai': '1', onclick: () => runEnhance(true) }, icon('ai', 13), ' AI 자동 보정'), h('button.small', { 'data-ai': '1', onclick: () => runEnhance(false), title: 'Gemini 없이 사진의 히스토그램으로 계산' }, '키 없이 자동 보정')),
    result,
    h('h4.ph-aih', 'AI 편집 도우미'),
    log,
    h('div.ph-aichips', ...quick.map(([label, q]) => h('button.small', { 'data-ai': '1', onclick: () => send(q) }, label))),
    ask,
    h('div.ph-airow', h('button.primary.small', { 'data-ai': '1', onclick: () => send() }, '보내기'), stopBtn),
    status,
    h('h4.ph-aih', '생성형 AI (Gemini 이미지 모델)'),
    h('p.ph-ainote', '채우기: 선택한 곳을 다시 그림 · 확장: 자르기 도구(C)로 상자를 캔버스 밖까지 넓힌 만큼 그림을 이어 그림 (상자가 없으면 사방 25%) · 이미지: 설명으로 새 그림 · 배경: 배경을 지운 피사체 레이어 뒤에 새 배경. 키에 이미지 생성 모델이 있어야 하고, 실제 서버로는 시험하지 못했어요.'),
    genIn,
    h('div.ph-airow',
      h('button.small', { 'data-ai': '1', onclick: () => runGen('fill'), title: '선택 영역을 다시 그립니다' }, '생성형 채우기'),
      h('button.small', { 'data-ai': '1', onclick: () => runGen('expand'), title: '캔버스를 넓히고 새 부분을 그립니다' }, '생성형 확장'),
      h('button.small', { 'data-ai': '1', onclick: () => runGen('image'), title: '설명으로 새 그림을 새 레이어로' }, '이미지 생성'),
      h('button.small', { 'data-ai': '1', onclick: () => runGen('background'), title: '피사체 레이어 뒤에 새 배경' }, '배경 생성')),
    h('p.ph-ainote', '보내는 것: 작게 줄인 사진(최대 768px, 생성형 기능은 최대 1024px PNG)과 레이어 이름 목록. 모든 AI 편집은 실행 취소 한 번으로 되돌릴 수 있어요.'));
  return el;
}

// ---------------------------------------------------------------- install

/** Generative Expand without a crop box: a quarter more on every side. */
const expandBox = (doc) => ({ x: -Math.round(doc.width * 0.25), y: -Math.round(doc.height * 0.25), w: Math.round(doc.width * 1.5), h: Math.round(doc.height * 1.5) });

export function installPhotoAI(P) {
  const C = P.cmd;
  C.aiEnhance = () => P.showPanel('ai');
  C.autoEnhanceOffline = async (style = 'natural', strength = 0.7) => {
    if (!P.doc) return;
    const set = cleanSettings(heuristicSettings(P.composite(), style), strength);
    await oneStep(P, '자동 보정', () => applyEnhance(P, set, { label: '자동 보정' }));
  };
  const needDoc = () => {
    if (!P.doc) toast('먼저 사진을 열거나 새 문서를 만드세요');
    return !!P.doc;
  };
  /** Edit ▸ Generative Fill… (a selection to repaint). */
  C.generativeFill = (prompt) => {
    if (!needDoc()) return;
    if (!P.doc.selection) return void toast('먼저 다시 그릴 곳을 선택하세요');
    if (typeof prompt === 'string') return generativeFill(P, prompt);
    generativeDialog(P, { title: '생성형 채우기', label: '무엇으로 채울까요? (비우면 주변처럼 지우기)', placeholder: '예: 해변의 야자수', optional: true, run: (q, signal) => generativeFill(P, q, signal) });
    return undefined;
  };
  /** Generative Expand: the crop box past the canvas (or a quarter more on every side). */
  C.generativeExpand = (rect, prompt) => {
    if (!needDoc()) return;
    const r = rect || P.cropExtent?.() || expandBox(P.doc);
    if (typeof prompt === 'string') return generativeExpand(P, r, prompt);
    generativeDialog(P, { title: '생성형 확장', label: '넓힌 곳에 무엇을 그릴까요? (비우면 이어지게)', placeholder: '예: 노을 지는 하늘', optional: true, note: `캔버스를 ${r.w} × ${r.h} px로 넓히고 새 부분을 그립니다.`, run: (q, signal) => generativeExpand(P, r, q, signal) });
    return undefined;
  };
  /** Edit ▸ Generate Image… */
  C.generateImage = (prompt) => {
    if (!needDoc()) return;
    if (typeof prompt === 'string') return generateImage(P, prompt);
    generativeDialog(P, { title: '이미지 생성', label: '무엇을 그릴까요?', placeholder: '예: 안개 낀 아침의 산과 호수, 사진처럼', run: (q, signal) => generateImage(P, q, signal) });
    return undefined;
  };
  /** Generate Background behind a cut-out subject (after Remove Background). */
  C.generateBackground = (prompt) => {
    if (!needDoc()) return;
    if (typeof prompt === 'string') return generateBackground(P, prompt);
    generativeDialog(P, { title: '배경 생성', label: '어떤 배경을 만들까요?', placeholder: '예: 햇살 비치는 카페 창가', optional: true, run: (q, signal) => generateBackground(P, q, signal) });
    return undefined;
  };
  P.photoAI = {
    runPhotoAssistant: (q, o) => runPhotoAssistant(P, q, o), generativeFill: (q, s) => generativeFill(P, q, s), generativeExpand: (r, q, s) => generativeExpand(P, r, q, s),
    generateImage: (q, s) => generateImage(P, q, s), generateBackground: (q, s) => generateBackground(P, q, s), heuristicSettings, cleanSettings, hasKey: () => !!geminiSettings.key,
  };
  P.aiMenu = () => [
    { label: 'AI 자동 보정…', disabled: !P.doc, action: () => P.showPanel('ai') },
    { label: '자동 보정 (키 없이, 히스토그램)', disabled: !P.doc, action: () => C.autoEnhanceOffline() },
    { label: 'AI 편집 도우미…', disabled: !P.doc, action: () => P.showPanel('ai') },
    '-',
    { label: '생성형 채우기…', disabled: !P.doc?.selection, action: () => C.generativeFill() },
    { label: '생성형 확장… (자르기 상자 또는 사방 25%)', disabled: !P.doc, action: () => C.generativeExpand() },
    { label: '이미지 생성…', disabled: !P.doc, action: () => C.generateImage() },
    { label: '배경 생성… (배경을 지운 레이어 뒤에)', disabled: !P.doc, action: () => C.generateBackground() },
    '-',
    { label: 'AI 설정 (Gemini 키)…', action: () => P.showPanel('ai') },
    { label: 'AI가 보내는 정보', action: () => openModal({ title: '사진 AI가 보내는 정보', body: h('div', h('p', 'AI 자동 보정과 AI 편집 도우미는 지금 사진을 최대 768px JPEG로 줄여 Google Gemini로 보내고, 도우미는 레이어 이름과 종류 목록도 함께 보냅니다. 생성형 채우기·확장·배경 생성은 그릴 곳 주변 사진을 최대 1024px PNG로, 이미지 생성은 설명 글만 보냅니다.'), h('p', '키는 이 브라우저에만 저장되며(기억하기를 끄면 탭을 닫을 때까지만), Montage 서버는 없습니다. "키 없이 자동 보정"은 아무것도 보내지 않습니다.')) }) },
  ];
  // Photoshop's Edit menu has Generative Fill (after Content-Aware Fill) and Generate Image
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['편집'];
    if (!orig) return;
    P.menus['편집'] = () => {
      const items = orig();
      const i = items.findIndex((x) => typeof x === 'object' && x?.label?.startsWith('내용 인식 채우기'));
      const add = [{ label: '생성형 채우기…', disabled: !P.doc?.selection, action: () => C.generativeFill() }, { label: '이미지 생성…', disabled: !P.doc, action: () => C.generateImage() }];
      if (i >= 0) items.splice(i + 1, 0, ...add);
      else items.push('-', ...add);
      return items;
    };
  }];
}

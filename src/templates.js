// Title templates: ready-made animated graphics built from text and shape layers.
// Positions are expressed as fractions of the frame so they adapt to any sequence size.

import { store } from './store.js';
import { createClip, createTrack, videoTracks, clipsOnTrack, clipEnd, renameTracks, findEffect } from './model.js';
import { snapFrame } from './util.js';

const W = (f) => f * store.seq.width;
const H = (f) => f * store.seq.height;

export const TEMPLATES = [
  {
    id: 'lowerThird',
    name: '하단 자막바 (이름·직함)',
    duration: 5,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(0.36), height: H(0.11), radius: H(0.02), fill: '#1d4ed8', gradient: true, fill2: '#7c3aed', gradAngle: 0 },
        motion: { posY: H(0.82) }, kf: { 'motion.posX': [[0, -W(0.2)], [0.6, W(0.25), 'ease']] }, transOut: 0.5 },
      { kind: 'text', start: 0.25, text: { content: '홍길동', size: H(0.05), bold: true, align: 'left' },
        motion: { posY: H(0.805) }, kf: { 'motion.posX': [[0, -W(0.15)], [0.6, W(0.2), 'ease']] }, transOut: 0.5 },
      { kind: 'text', start: 0.45, text: { content: '영상 편집자 · Montage', size: H(0.028), bold: false, align: 'left', color: '#dbe4ff' },
        motion: { posY: H(0.858) }, kf: { 'motion.posX': [[0, -W(0.15)], [0.6, W(0.2), 'ease']] }, transOut: 0.5 },
    ],
  },
  {
    id: 'centerTitle',
    name: '가운데 큰 제목',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: H(0.11), bold: true, tracking: 4 },
        motion: { posY: H(0.45) }, kf: { 'motion.scale': [[0, 85], [1.2, 100, 'ease']] }, transIn: 0.6, transOut: 0.6 },
      { kind: 'shape', start: 0.4, shape: { shape: 'line', width: W(0.2), strokeWidth: 6, fill: '#ffffff' },
        motion: { posY: H(0.53) }, kf: { 'motion.scale': [[0, 0], [0.8, 100, 'ease']] }, transOut: 0.6 },
      { kind: 'text', start: 0.6, text: { content: '부제목', size: H(0.04), bold: false, color: '#cbd5e1' },
        motion: { posY: H(0.6) }, transIn: 0.5, transOut: 0.6 },
    ],
  },
  {
    id: 'endCard',
    name: '엔딩 카드 (시청 감사)',
    duration: 6,
    layers: () => [
      { kind: 'color', start: 0, color: '#0f172a', transIn: 0.8 },
      { kind: 'text', start: 0.5, text: { content: '시청해 주셔서 감사합니다', size: H(0.07), bold: true },
        motion: { posY: H(0.4) }, transIn: 0.6 },
      { kind: 'shape', start: 1.2, shape: { shape: 'rectangle', width: W(0.16), height: H(0.08), radius: H(0.04), fill: '#dc2626' },
        motion: { posX: W(0.4), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0], [0.35, 112, 'ease'], [0.55, 100, 'ease']] } },
      { kind: 'text', start: 1.2, text: { content: '구독', size: H(0.04), bold: true },
        motion: { posX: W(0.4), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0], [0.35, 112, 'ease'], [0.55, 100, 'ease']] } },
      { kind: 'shape', start: 1.5, shape: { shape: 'rectangle', width: W(0.16), height: H(0.08), radius: H(0.04), fill: '#334155', strokeColor: '#94a3b8', strokeWidth: 3 },
        motion: { posX: W(0.6), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0], [0.35, 112, 'ease'], [0.55, 100, 'ease']] } },
      { kind: 'text', start: 1.5, text: { content: '좋아요', size: H(0.04), bold: true },
        motion: { posX: W(0.6), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0], [0.35, 112, 'ease'], [0.55, 100, 'ease']] } },
    ],
  },
  {
    id: 'subscribe',
    name: '구독 버튼 팝업',
    duration: 4,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(0.15), height: H(0.075), radius: H(0.0375), fill: '#e11d48' },
        motion: { posX: W(0.13), posY: H(0.86) }, kf: { 'motion.scale': [[0, 0], [0.3, 115, 'ease'], [0.5, 100, 'ease']] }, transOut: 0.4 },
      { kind: 'text', start: 0, text: { content: '▶ 구독', size: H(0.036), bold: true },
        motion: { posX: W(0.13), posY: H(0.86) }, kf: { 'motion.scale': [[0, 0], [0.3, 115, 'ease'], [0.5, 100, 'ease']] }, transOut: 0.4 },
    ],
  },
  {
    id: 'location',
    name: '장소 표시 (왼쪽 위)',
    duration: 5,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'ellipse', width: H(0.03), height: H(0.03), fill: '#f97316' },
        motion: { posX: W(0.06), posY: H(0.1) }, transIn: 0.3, transOut: 0.5 },
      { kind: 'text', start: 0.2, text: { content: '서울특별시 종로구', size: H(0.035), bold: true, align: 'left', strokeWidth: 0, background: true, bgOpacity: 45, bgPadding: H(0.012) },
        motion: { posY: H(0.1) }, kf: { 'motion.posX': [[0, W(0.12)], [0.5, W(0.2), 'ease']] }, transIn: 0.4, transOut: 0.5 },
    ],
  },
  {
    id: 'chapter',
    name: '챕터 제목',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '01', size: H(0.16), bold: true, font: 'Black Han Sans', color: '#38bdf8', align: 'left' },
        motion: { posX: W(0.2), posY: H(0.48) }, transIn: 0.5, transOut: 0.5 },
      { kind: 'shape', start: 0.2, shape: { shape: 'rectangle', width: 8, height: H(0.16), fill: '#38bdf8' },
        motion: { posX: W(0.3), posY: H(0.48) }, transIn: 0.4, transOut: 0.5 },
      { kind: 'text', start: 0.35, text: { content: '챕터 제목', size: H(0.07), bold: true, align: 'left' },
        motion: { posY: H(0.48) }, kf: { 'motion.posX': [[0, W(0.42)], [0.6, W(0.46), 'ease']] }, transIn: 0.5, transOut: 0.5 },
    ],
  },
  {
    id: 'quote',
    name: '인용문',
    duration: 6,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '“좋은 편집은\n눈에 띄지 않는다”', size: H(0.075), bold: false, italic: true, font: 'Noto Serif KR', lineHeight: 140 },
        motion: { posY: H(0.45) }, transIn: 0.8, transOut: 0.8 },
      { kind: 'text', start: 1, text: { content: '— 어느 편집자', size: H(0.035), bold: false, color: '#cbd5e1' },
        motion: { posY: H(0.66) }, transIn: 0.6, transOut: 0.8 },
    ],
  },
];

function freeTrack(s, start, end) {
  const tracks = videoTracks(s).filter((t) => !t.locked);
  let tr = tracks.find((t, i) => i > 0 && !clipsOnTrack(s, t.id).some((c) => c.start < end && clipEnd(c) > start));
  if (!tr) {
    tr = createTrack('video', videoTracks(s).length);
    const lastVideoIdx = s.tracks.findLastIndex((t) => t.kind === 'video');
    s.tracks.splice(lastVideoIdx + 1, 0, tr);
    renameTracks(s);
  }
  return tr;
}

function setValues(clip, fxType, values) {
  const fx = findEffect(clip, fxType);
  if (!fx || !values) return;
  for (const [k, v] of Object.entries(values)) if (fx.params[k]) fx.params[k].value = v;
}

export function insertTemplate(id, at = store.ui.playhead) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return;
  const s = store.seq;
  const t0 = snapFrame(at, s.fps);
  store.transact(`템플릿: ${tpl.name}`, () => {
    const created = [];
    for (const layer of tpl.layers()) {
      const start = snapFrame(t0 + layer.start, s.fps);
      const end = t0 + tpl.duration;
      const tr = freeTrack(s, start, end);
      const kind = layer.kind;
      const c = createClip(s, { kind, trackId: tr.id, name: kind === 'text' ? layer.text.content.split('\n')[0] : tpl.name, start, duration: end - start, color: layer.color });
      if (kind === 'text') setValues(c, 'text', layer.text);
      if (kind === 'shape') setValues(c, 'shape', layer.shape);
      setValues(c, 'motion', layer.motion);
      for (const [path, keys] of Object.entries(layer.kf || {})) {
        const [fxType, key] = path.split('.');
        const fx = findEffect(c, fxType);
        if (!fx?.params[key]) continue;
        fx.params[key].kf = keys.map(([kt, v, ease = 'linear']) => ({ t: kt, v, ease }));
        fx.params[key].value = keys[keys.length - 1][1];
      }
      if (layer.transIn) c.transIn = { type: 'crossDissolve', duration: layer.transIn };
      if (layer.transOut) c.transOut = { type: 'crossDissolve', duration: layer.transOut };
      s.clips[c.id] = c;
      created.push(c.id);
    }
    store.selectClips(created);
  });
  store.toast(`"${tpl.name}" 템플릿을 넣었습니다. 텍스트를 선택해 효과 컨트롤에서 내용을 바꾸세요.`);
}

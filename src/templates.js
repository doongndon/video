// Title templates (그래픽 및 타이틀 ▸ 타이틀 템플릿): ready-made animated graphics built from text,
// shape and colour layers, grouped like Premiere's Essential Graphics browser. Positions are
// fractions of the frame and sizes fractions of its shorter side, so they adapt to any sequence
// (16:9, 9:16, 1:1). Text that has to line up with something is measured when it is inserted.

import { store } from './store.js';
import { createClip, createTrack, createSequence, videoTracks, clipsOnTrack, clipEnd, renameTracks, findEffect } from './model.js';
import { snapFrame } from './util.js';

const W = (f) => f * store.seq.width;
const H = (f) => f * store.seq.height;
const U = (f) => f * Math.min(store.seq.width, store.seq.height);

let measureCtx = null;
/** Size of a text block as the compositor draws it (font, tracking, padding and strokes). */
export function textBox(t) {
  const p = { size: 96, bold: true, italic: false, font: 'Noto Sans KR', lineHeight: 120, tracking: 0, strokeWidth: 0, background: false, bgPadding: 24, ...t };
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${p.italic ? 'italic ' : ''}${p.bold ? '700' : '400'} ${p.size}px "${p.font}", "Noto Sans KR", sans-serif`;
  if ('letterSpacing' in measureCtx) measureCtx.letterSpacing = `${p.tracking || 0}px`;
  const lines = String(p.content ?? '').split('\n');
  const pad = p.background ? p.bgPadding : 0;
  const stroke = Math.max(0, p.strokeWidth || 0);
  const w = Math.max(1, ...lines.map((l) => measureCtx.measureText(l || ' ').width)) + pad * 2 + stroke * 2 + 4;
  const h = ((p.size * p.lineHeight) / 100) * lines.length + pad * 2 + stroke * 2 + 4;
  return { w, h };
}

/** posX that puts a text block's left edge at x (blocks are centred on their position). */
const leftAt = (x, text) => x + textBox(text).w / 2;

const fadeIn = (d = 0.4, ease = 'outSine') => [[0, 0, ease], [d, 100]];

export const TEMPLATE_CATEGORIES = ['하단 자막', '제목', '소셜 · 정보', '강조', '엔딩'];

export const TEMPLATES = [
  // ---------------------------------------------------------------- 하단 자막 (lower thirds)
  {
    id: 'lowerThird',
    category: '하단 자막',
    name: '하단 자막 1 · 그라데이션 바',
    duration: 5,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(0.36), height: H(0.11), radius: H(0.02), fill: '#1d4ed8', gradient: true, fill2: '#7c3aed', gradAngle: 0 },
        motion: { posY: H(0.82) }, kf: { 'motion.posX': [[0, -W(0.2), 'outCubic'], [0.6, W(0.25)]] }, transOut: 0.5 },
      { kind: 'text', start: 0.25, text: { content: '홍길동', size: H(0.05), bold: true, align: 'left' },
        motion: { posY: H(0.805) }, kf: { 'motion.posX': [[0, -W(0.15), 'outCubic'], [0.6, W(0.2)]] }, transOut: 0.5 },
      { kind: 'text', start: 0.45, text: { content: '영상 편집자 · Montage', size: H(0.028), bold: false, align: 'left', color: '#dbe4ff' },
        motion: { posY: H(0.858) }, kf: { 'motion.posX': [[0, -W(0.15), 'outCubic'], [0.6, W(0.2)]] }, transOut: 0.5 },
    ],
  },
  {
    id: 'lowerThird2',
    category: '하단 자막',
    name: '하단 자막 2 · 세로 강조선',
    duration: 5,
    layers: () => {
      const x0 = W(0.07);
      const name = { content: '홍길동', size: U(0.055), bold: true, align: 'left', shadowOn: true, shadowDistance: 3, shadowBlur: 8, shadowOpacity: 60 };
      const title = { content: '영상 편집자', size: U(0.032), bold: false, align: 'left', color: '#e5e7eb', shadowOn: true, shadowDistance: 2, shadowBlur: 6, shadowOpacity: 60 };
      const tx = x0 + U(0.03);
      return [
        { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: U(0.009), height: U(0.12), fill: '#facc15' },
          motion: { posX: x0, posY: H(0.82) }, kf: { 'shape.height': [[0, 0, 'outCubic'], [0.4, U(0.12)]] }, transOut: 0.4 },
        { kind: 'text', start: 0.2, text: name, motion: { posY: H(0.82) - U(0.027) },
          kf: { 'motion.posX': [[0, leftAt(tx, name) - U(0.05), 'outCubic'], [0.5, leftAt(tx, name)]], 'opacity.opacity': fadeIn(0.4) }, transOut: 0.4 },
        { kind: 'text', start: 0.35, text: title, motion: { posY: H(0.82) + U(0.03) },
          kf: { 'motion.posX': [[0, leftAt(tx, title) - U(0.05), 'outCubic'], [0.5, leftAt(tx, title)]], 'opacity.opacity': fadeIn(0.4) }, transOut: 0.4 },
      ];
    },
  },
  {
    id: 'lowerThird3',
    category: '하단 자막',
    name: '하단 자막 3 · 반투명 상자',
    duration: 5,
    layers: () => {
      const x0 = W(0.06);
      const boxW = Math.max(W(0.34), U(0.6));
      const boxH = U(0.14);
      const cy = H(0.83);
      const name = { content: '홍길동', size: U(0.05), bold: true, align: 'left' };
      const title = { content: '영상 편집자 · Montage', size: U(0.028), bold: false, align: 'left', color: '#d1d5db' };
      const tx = x0 + U(0.03);
      return [
        { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: boxW, height: boxH, radius: U(0.012), fill: '#000000' }, opacity: 62,
          motion: { posX: x0 + boxW / 2, posY: cy }, transIn: 0.35, transOut: 0.4 },
        { kind: 'text', start: 0.15, text: name, motion: { posX: leftAt(tx, name), posY: cy - U(0.022) }, transIn: 0.35, transOut: 0.4 },
        { kind: 'text', start: 0.3, text: title, motion: { posX: leftAt(tx, title), posY: cy + U(0.033) }, transIn: 0.35, transOut: 0.4 },
      ];
    },
  },
  {
    id: 'lowerThird4',
    category: '하단 자막',
    name: '하단 자막 4 · 둥근 알약',
    duration: 5,
    layers: () => {
      const x0 = W(0.07);
      const tag = { content: '인터뷰', size: U(0.026), bold: true, align: 'left', color: '#ffffff', background: true, bgColor: '#ef4444', bgOpacity: 100, bgPadding: U(0.012), bgRadius: U(0.03) };
      const name = { content: '홍길동 · 영상 편집자', size: U(0.042), bold: true, align: 'left', color: '#111827', background: true, bgColor: '#ffffff', bgOpacity: 100, bgPadding: U(0.018), bgRadius: U(0.05) };
      const pop = [[0, 0, 'outBack'], [0.45, 100]];
      return [
        { kind: 'text', start: 0, text: tag, motion: { posX: leftAt(x0, tag), posY: H(0.84) - U(0.065) }, kf: { 'motion.scale': pop }, transOut: 0.35 },
        { kind: 'text', start: 0.15, text: name, motion: { posX: leftAt(x0, name), posY: H(0.84) }, kf: { 'motion.scale': pop }, transOut: 0.35 },
      ];
    },
  },
  {
    id: 'lowerThird5',
    category: '하단 자막',
    name: '하단 자막 5 · 뉴스',
    duration: 6,
    layers: () => {
      const x0 = W(0.05);
      const name = { content: '홍길동 기자', size: U(0.045), bold: true, align: 'left', color: '#ffffff', background: true, bgColor: '#c81e1e', bgOpacity: 100, bgPadding: U(0.016), bgRadius: 0 };
      const title = { content: '서울 종로구에서 전해 드립니다', size: U(0.032), bold: true, align: 'left', color: '#111827', background: true, bgColor: '#ffffff', bgOpacity: 96, bgPadding: U(0.014), bgRadius: 0 };
      const nb = textBox(name);
      const y1 = H(0.86) - nb.h / 2 - textBox(title).h / 2;
      const slide = (text) => [[0, -textBox(text).w / 2, 'outCubic'], [0.45, leftAt(x0, text)]];
      return [
        { kind: 'text', start: 0, text: name, motion: { posY: y1 }, kf: { 'motion.posX': slide(name) }, transOut: 0.35 },
        { kind: 'text', start: 0.2, text: title, motion: { posY: H(0.86) }, kf: { 'motion.posX': slide(title) }, transOut: 0.35 },
      ];
    },
  },

  // ---------------------------------------------------------------- 제목 (titles / openings)
  {
    id: 'opening1',
    category: '제목',
    name: '오프닝 1 · 시네마틱 (자간 좁아지기)',
    duration: 5,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: U(0.09), bold: false, font: 'Noto Serif KR', tracking: U(0.01) },
        motion: { posY: H(0.47) }, kf: { 'text.tracking': [[0, U(0.045), 'outCubic'], [3.5, U(0.01)]], 'opacity.opacity': fadeIn(1.2) }, transOut: 0.8 },
      { kind: 'shape', start: 0.6, shape: { shape: 'line', width: W(0.3), strokeWidth: 2, fill: '#ffffff' },
        motion: { posY: H(0.47) - U(0.1) }, kf: { 'shape.width': [[0, 0, 'outCubic'], [1.2, W(0.3)]] }, transOut: 0.8 },
      { kind: 'shape', start: 0.6, shape: { shape: 'line', width: W(0.3), strokeWidth: 2, fill: '#ffffff' },
        motion: { posY: H(0.47) + U(0.1) }, kf: { 'shape.width': [[0, 0, 'outCubic'], [1.2, W(0.3)]] }, transOut: 0.8 },
      { kind: 'text', start: 1.4, text: { content: 'A MONTAGE FILM', size: U(0.026), bold: false, tracking: U(0.012), color: '#cbd5e1' },
        motion: { posY: H(0.47) + U(0.16) }, kf: { 'opacity.opacity': fadeIn(0.8) }, transOut: 0.8 },
    ],
  },
  {
    id: 'opening2',
    category: '제목',
    name: '오프닝 2 · 확대 등장',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: U(0.11), bold: true, shadowOn: true, shadowDistance: 6, shadowBlur: 18 },
        motion: { posY: H(0.45) }, kf: { 'motion.scale': [[0, 165, 'outExpo'], [0.9, 100]], 'opacity.opacity': fadeIn(0.35) }, transOut: 0.6 },
      { kind: 'text', start: 0.7, text: { content: '부제목', size: U(0.04), bold: false, color: '#e2e8f0' },
        motion: { posY: H(0.58) }, kf: { 'motion.posY': [[0, H(0.58) + U(0.04), 'outCubic'], [0.5, H(0.58)]], 'opacity.opacity': fadeIn(0.5) }, transOut: 0.6 },
    ],
  },
  {
    id: 'opening3',
    category: '제목',
    name: '오프닝 3 · 색 배경 + 제목',
    duration: 5,
    layers: () => [
      { kind: 'color', start: 0, color: '#111827', transIn: 0.4, transOut: 0.6 },
      { kind: 'shape', start: 0.3, shape: { shape: 'rectangle', width: U(0.12), height: U(0.012), fill: '#f97316' },
        motion: { posY: H(0.37) }, kf: { 'shape.width': [[0, 0, 'outCubic'], [0.5, U(0.12)]] }, transOut: 0.6 },
      { kind: 'text', start: 0.4, text: { content: '제목을 입력하세요', size: U(0.1), bold: true },
        motion: { posY: H(0.48) }, kf: { 'motion.posY': [[0, H(0.48) + U(0.08), 'outQuart'], [0.7, H(0.48)]], 'opacity.opacity': fadeIn(0.5) }, transOut: 0.6 },
      { kind: 'text', start: 0.8, text: { content: '부제목 · 2026', size: U(0.035), bold: false, color: '#9ca3af' },
        motion: { posY: H(0.6) }, kf: { 'opacity.opacity': fadeIn(0.6) }, transOut: 0.6 },
    ],
  },
  {
    id: 'opening4',
    category: '제목',
    name: '오프닝 4 · 타자기',
    duration: 5,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: U(0.09), bold: true, font: 'Nanum Gothic Coding' },
        motion: { posY: H(0.46) }, kf: { 'text.reveal': [[0, 0, 'linear'], [1.6, 100]] }, transOut: 0.6 },
      { kind: 'text', start: 1.8, text: { content: '부제목을 입력하세요', size: U(0.035), bold: false, color: '#a7f3d0', font: 'Nanum Gothic Coding' },
        motion: { posY: H(0.58) }, kf: { 'text.reveal': [[0, 0, 'linear'], [1, 100]] }, transOut: 0.6 },
    ],
  },
  {
    id: 'opening5',
    category: '제목',
    name: '오프닝 5 · 떨어지며 착지',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: U(0.1), bold: true, font: 'Black Han Sans', strokeWidth: U(0.006), strokeColor: '#000000' },
        motion: { posY: H(0.45) }, kf: { 'motion.posY': [[0, -U(0.2), 'outBounce'], [1, H(0.45)]] }, transOut: 0.5 },
      { kind: 'shape', start: 0.9, shape: { shape: 'rectangle', width: W(0.28), height: U(0.014), radius: U(0.007), fill: '#22d3ee' },
        motion: { posY: H(0.45) + U(0.1) }, kf: { 'shape.width': [[0, 0, 'outBack'], [0.5, W(0.28)]] }, transOut: 0.5 },
      { kind: 'text', start: 1.2, text: { content: '부제목', size: U(0.04), bold: false, color: '#e0f2fe' },
        motion: { posY: H(0.45) + U(0.18) }, kf: { 'opacity.opacity': fadeIn(0.5) }, transOut: 0.5 },
    ],
  },
  {
    id: 'centerTitle',
    category: '제목',
    name: '가운데 큰 제목',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '제목을 입력하세요', size: H(0.11), bold: true, tracking: 4 },
        motion: { posY: H(0.45) }, kf: { 'motion.scale': [[0, 85, 'outQuart'], [1.2, 100]] }, transIn: 0.6, transOut: 0.6 },
      { kind: 'shape', start: 0.4, shape: { shape: 'line', width: W(0.2), strokeWidth: 6, fill: '#ffffff' },
        motion: { posY: H(0.53) }, kf: { 'motion.scale': [[0, 0, 'outExpo'], [0.8, 100]] }, transOut: 0.6 },
      { kind: 'text', start: 0.6, text: { content: '부제목', size: H(0.04), bold: false, color: '#cbd5e1' },
        motion: { posY: H(0.6) }, transIn: 0.5, transOut: 0.6 },
    ],
  },
  {
    id: 'chapter',
    category: '제목',
    name: '챕터 제목',
    duration: 4,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '01', size: H(0.16), bold: true, font: 'Black Han Sans', color: '#38bdf8', align: 'left' },
        motion: { posX: W(0.2), posY: H(0.48) }, transIn: 0.5, transOut: 0.5 },
      { kind: 'shape', start: 0.2, shape: { shape: 'rectangle', width: 8, height: H(0.16), fill: '#38bdf8' },
        motion: { posX: W(0.3), posY: H(0.48) }, transIn: 0.4, transOut: 0.5 },
      { kind: 'text', start: 0.35, text: { content: '챕터 제목', size: H(0.07), bold: true, align: 'left' },
        motion: { posY: H(0.48) }, kf: { 'motion.posX': [[0, W(0.42), 'outQuart'], [0.6, W(0.46)]] }, transIn: 0.5, transOut: 0.5 },
    ],
  },
  {
    id: 'quote',
    category: '제목',
    name: '인용문',
    duration: 6,
    layers: () => [
      { kind: 'text', start: 0, text: { content: '“좋은 편집은\n눈에 띄지 않는다”', size: H(0.075), bold: false, italic: true, font: 'Noto Serif KR', lineHeight: 140 },
        motion: { posY: H(0.45) }, transIn: 0.8, transOut: 0.8 },
      { kind: 'text', start: 1, text: { content: '— 어느 편집자', size: H(0.035), bold: false, color: '#cbd5e1' },
        motion: { posY: H(0.66) }, transIn: 0.6, transOut: 0.8 },
    ],
  },

  // ---------------------------------------------------------------- 소셜 · 정보
  {
    id: 'social',
    category: '소셜 · 정보',
    name: 'SNS 아이디',
    duration: 5,
    layers: () => {
      const cx = W(0.06) + U(0.035);
      const cy = H(0.88);
      const handle = { content: '@my_channel', size: U(0.036), bold: true, align: 'left', color: '#ffffff', background: true, bgColor: '#111827', bgOpacity: 85, bgPadding: U(0.014), bgRadius: U(0.03) };
      const hx = cx + U(0.05);
      return [
        { kind: 'shape', start: 0, shape: { shape: 'ellipse', width: U(0.07), height: U(0.07), fill: '#e1306c', gradient: true, fill2: '#f59e0b', gradAngle: 45 },
          motion: { posX: cx, posY: cy }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.45, 100]] }, transOut: 0.4 },
        { kind: 'text', start: 0, text: { content: '@', size: U(0.042), bold: true }, motion: { posX: cx, posY: cy },
          kf: { 'motion.scale': [[0, 0, 'outBack'], [0.45, 100]] }, transOut: 0.4 },
        { kind: 'text', start: 0.3, text: handle, motion: { posY: cy },
          kf: { 'motion.posX': [[0, leftAt(hx, handle) - U(0.04), 'outCubic'], [0.5, leftAt(hx, handle)]], 'opacity.opacity': fadeIn(0.4) }, transOut: 0.4 },
      ];
    },
  },
  {
    id: 'subscribe',
    category: '소셜 · 정보',
    name: '구독 버튼 팝업',
    duration: 4,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(0.15), height: H(0.075), radius: H(0.0375), fill: '#e1251b' },
        motion: { posX: W(0.13), posY: H(0.86) }, kf: { 'motion.scale': [[0, 0, 'outElastic'], [0.9, 100]] }, transOut: 0.4 },
      { kind: 'text', start: 0, text: { content: '구독', size: H(0.036), bold: true },
        motion: { posX: W(0.13), posY: H(0.86) }, kf: { 'motion.scale': [[0, 0, 'outElastic'], [0.9, 100]] }, transOut: 0.4 },
    ],
  },
  {
    id: 'location',
    category: '소셜 · 정보',
    name: '장소 표시 (왼쪽 위)',
    duration: 5,
    layers: () => [
      { kind: 'shape', start: 0, shape: { shape: 'ellipse', width: H(0.03), height: H(0.03), fill: '#f97316' },
        motion: { posX: W(0.06), posY: H(0.1) }, transIn: 0.3, transOut: 0.5 },
      { kind: 'text', start: 0.2, text: { content: '서울특별시 종로구', size: H(0.035), bold: true, align: 'left', strokeWidth: 0, background: true, bgOpacity: 45, bgPadding: H(0.012) },
        motion: { posY: H(0.1) }, kf: { 'motion.posX': [[0, W(0.12), 'outCubic'], [0.5, W(0.2)]] }, transIn: 0.4, transOut: 0.5 },
    ],
  },
  {
    id: 'progressBar',
    category: '소셜 · 정보',
    name: '진행 막대 (화면 아래)',
    duration: 10,
    layers: (D) => {
      const bh = Math.max(4, U(0.012));
      const y = store.seq.height - bh / 2;
      return [
        { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(1), height: bh, fill: '#ffffff' }, opacity: 30, motion: { posY: y } },
        // the bar grows from the left edge: its width and centre move together
        { kind: 'shape', start: 0, shape: { shape: 'rectangle', width: W(1), height: bh, fill: '#ef4444' }, motion: { posY: y },
          kf: { 'shape.width': [[0, 1, 'linear'], [D, W(1)]], 'motion.posX': [[0, 0.5, 'linear'], [D, W(0.5)]] } },
      ];
    },
  },
  {
    id: 'countdown',
    category: '소셜 · 정보',
    name: '카운트다운 (5 → 1)',
    duration: 5,
    layers: () => {
      const num = (n, i) => ({
        kind: 'text', start: i, end: i + 1, name: String(n),
        text: { content: String(n), size: U(0.24), bold: true, font: 'Black Han Sans', shadowOn: true, shadowDistance: 6, shadowBlur: 16 },
        motion: { posY: H(0.5) },
        kf: { 'motion.scale': [[0, 170, 'outBack'], [0.35, 100]], 'opacity.opacity': [[0, 0, 'outSine'], [0.12, 100, 'linear'], [0.8, 100, 'inSine'], [1, 0]] },
      });
      return [
        { kind: 'shape', start: 0, shape: { shape: 'ellipse', width: U(0.36), height: U(0.36), fillOn: false, strokeWidth: U(0.012), strokeColor: '#ffffff' }, opacity: 80,
          motion: { posY: H(0.5) }, transIn: 0.3, transOut: 0.3 },
        ...[5, 4, 3, 2, 1].map(num),
      ];
    },
  },

  // ---------------------------------------------------------------- 강조 (callouts)
  {
    id: 'callout',
    category: '강조',
    name: '말풍선 콜아웃',
    duration: 4,
    layers: () => {
      const bubble = { content: '여기를 보세요!', size: U(0.045), bold: true, color: '#111827', background: true, bgColor: '#ffffff', bgOpacity: 100, bgPadding: U(0.025), bgRadius: U(0.03) };
      const b = textBox(bubble);
      const bx = W(0.62);
      const by = H(0.3);
      const tw = U(0.05);
      const th = U(0.06);
      const up = (y) => [[0, y + U(0.04), 'outBack'], [0.4, y]];
      const tailY = by + b.h / 2 + th / 2 - U(0.008);
      return [
        // the tail points down-left from under the bubble
        { kind: 'shape', start: 0, shape: { shape: 'triangle', width: tw, height: th, fill: '#ffffff' },
          motion: { posX: bx - b.w * 0.22, rotation: 200 }, kf: { 'motion.posY': up(tailY), 'opacity.opacity': fadeIn(0.25) }, transOut: 0.3 },
        { kind: 'text', start: 0, text: bubble, motion: { posX: bx }, kf: { 'motion.posY': up(by), 'opacity.opacity': fadeIn(0.25) }, transOut: 0.3 },
      ];
    },
  },
  {
    id: 'arrow',
    category: '강조',
    name: '화살표 강조',
    duration: 4,
    layers: () => {
      const tx = W(0.5);
      const ty = H(0.45);
      const ringR = U(0.11);
      const a = (-35 * Math.PI) / 180; // pointing up and to the right
      const dir = [Math.cos(a), Math.sin(a)];
      const L = U(0.24);
      const headH = U(0.06);
      const color = '#ffd400';
      // the tip stops just short of the ring
      const tip = [tx - dir[0] * (ringR + U(0.02)), ty - dir[1] * (ringR + U(0.02))];
      const head = [tip[0] - (dir[0] * headH) / 2, tip[1] - (dir[1] * headH) / 2];
      const line = [head[0] - dir[0] * (headH / 2 + L / 2 - U(0.004)), head[1] - dir[1] * (headH / 2 + L / 2 - U(0.004))];
      const off = U(0.08);
      const slide = (p, k) => [[0, p[k] - dir[k] * off, 'outCubic'], [0.45, p[k]]];
      const rot = (a * 180) / Math.PI;
      return [
        { kind: 'shape', start: 0, shape: { shape: 'ellipse', width: ringR * 2, height: ringR * 2, fillOn: false, strokeWidth: U(0.01), strokeColor: color },
          motion: { posX: tx, posY: ty }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.4, 100]] }, transOut: 0.3 },
        { kind: 'shape', start: 0.25, shape: { shape: 'line', width: L, strokeWidth: U(0.014), fill: color, strokeColor: color },
          motion: { rotation: rot }, kf: { 'motion.posX': slide(line, 0), 'motion.posY': slide(line, 1), 'opacity.opacity': fadeIn(0.2) }, transOut: 0.3 },
        { kind: 'shape', start: 0.25, shape: { shape: 'triangle', width: headH * 0.95, height: headH, fill: color },
          motion: { rotation: rot + 90 }, kf: { 'motion.posX': slide(head, 0), 'motion.posY': slide(head, 1), 'opacity.opacity': fadeIn(0.2) }, transOut: 0.3 },
      ];
    },
  },

  // ---------------------------------------------------------------- 엔딩
  {
    id: 'endCard',
    category: '엔딩',
    name: '엔딩 카드 (시청 감사)',
    duration: 6,
    layers: () => [
      { kind: 'color', start: 0, color: '#0f172a', transIn: 0.8 },
      { kind: 'text', start: 0.5, text: { content: '시청해 주셔서 감사합니다', size: H(0.07), bold: true },
        motion: { posY: H(0.4) }, transIn: 0.6 },
      { kind: 'shape', start: 1.2, shape: { shape: 'rectangle', width: W(0.16), height: H(0.08), radius: H(0.04), fill: '#dc2626' },
        motion: { posX: W(0.4), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.55, 100]] } },
      { kind: 'text', start: 1.2, text: { content: '구독', size: H(0.04), bold: true },
        motion: { posX: W(0.4), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.55, 100]] } },
      { kind: 'shape', start: 1.5, shape: { shape: 'rectangle', width: W(0.16), height: H(0.08), radius: H(0.04), fill: '#334155', strokeColor: '#94a3b8', strokeWidth: 3 },
        motion: { posX: W(0.6), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.55, 100]] } },
      { kind: 'text', start: 1.5, text: { content: '좋아요', size: H(0.04), bold: true },
        motion: { posX: W(0.6), posY: H(0.6) }, kf: { 'motion.scale': [[0, 0, 'outBack'], [0.55, 100]] } },
    ],
  },
  {
    id: 'creditsRoll',
    category: '엔딩',
    name: '엔딩 크레딧 롤',
    duration: 15,
    thumbAt: 6,
    layers: (D) => {
      const content = ['엔딩 크레딧', '', '연출', '홍길동', '', '편집', '김편집', '', '촬영', '이촬영', '', '음악', '박음악', '', '출연', '최배우 · 정배우', '', '', '시청해 주셔서 감사합니다'].join('\n');
      const text = { content, size: U(0.042), bold: false, lineHeight: 160, color: '#f3f4f6' };
      const hh = textBox(text).h;
      return [
        { kind: 'color', start: 0, color: '#000000', transIn: 0.5 },
        // rolls from just below the frame until it has left the top (linear, like a credit roll)
        { kind: 'text', start: 0, text, name: '엔딩 크레딧', motion: { posY: store.seq.height + hh / 2 },
          kf: { 'motion.posY': [[0, store.seq.height + hh / 2, 'linear'], [D, -hh / 2]] } },
      ];
    },
  },
];

/** 타이틀 템플릿 submenu grouped by category; run(id) inserts. */
export function templateMenu(run = insertTemplate) {
  return TEMPLATE_CATEGORIES.map((cat) => ({
    label: cat,
    submenu: () => TEMPLATES.filter((t) => t.category === cat).map((t) => ({ label: t.name, action: () => run(t.id) })),
  }));
}

function freeTrack(s, start, end) {
  const tracks = videoTracks(s).filter((t) => !t.locked);
  let tr = tracks.find((t, i) => i > 0 && !clipsOnTrack(s, t.id).some((c) => c.start < end - 1e-6 && clipEnd(c) > start + 1e-6));
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

/**
 * Build the clips of a template placed at t0 on sequence s: trackFor(start, end) gives each layer's
 * track and add(clip) puts the clip in (before the next layer looks for a free track).
 */
export function buildTemplate(tpl, s, t0, { trackFor, add }) {
  const out = [];
  for (const layer of tpl.layers(tpl.duration)) {
    const start = snapFrame(t0 + layer.start, s.fps);
    const end = snapFrame(t0 + (layer.end ?? tpl.duration), s.fps);
    if (end - start < 1 / s.fps) continue;
    const tr = trackFor(start, end);
    const kind = layer.kind;
    const name = layer.name || (kind === 'text' ? String(layer.text.content).split('\n')[0].slice(0, 40) : tpl.name);
    const c = createClip(s, { kind, trackId: tr.id, name, start, duration: end - start, color: layer.color });
    if (kind === 'text') setValues(c, 'text', layer.text);
    if (kind === 'shape') setValues(c, 'shape', layer.shape);
    setValues(c, 'motion', layer.motion);
    if (layer.opacity != null) setValues(c, 'opacity', { opacity: layer.opacity });
    for (const [path, keys] of Object.entries(layer.kf || {})) {
      const [fxType, key] = path.split('.');
      const fx = findEffect(c, fxType);
      if (!fx?.params[key]) continue;
      fx.params[key].kf = keys.map(([kt, v, ease = 'linear']) => ({ t: Math.min(kt, end - start), v, ease }));
      fx.params[key].value = keys[keys.length - 1][1];
    }
    if (layer.transIn) c.transIn = { type: 'crossDissolve', duration: Math.min(layer.transIn, end - start) };
    if (layer.transOut) c.transOut = { type: 'crossDissolve', duration: Math.min(layer.transOut, end - start) };
    add(c);
    out.push(c);
  }
  return out;
}

/** Insert a template at the playhead (one undo step); returns the ids of the clips it made. */
export function insertTemplate(id, at = store.ui.playhead) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return [];
  const s = store.seq;
  const created = [];
  store.transact(`템플릿: ${tpl.name}`, () => {
    const clips = buildTemplate(tpl, s, snapFrame(Math.max(0, at), s.fps), {
      trackFor: (start, end) => freeTrack(s, start, end),
      add: (c) => { s.clips[c.id] = c; },
    });
    created.push(...clips.map((c) => c.id));
    store.selectClips(created);
  });
  store.toast(`"${tpl.name}" 템플릿을 넣었습니다. 텍스트를 선택해 효과 컨트롤이나 기본 그래픽 ▸ 편집에서 내용을 바꾸세요.`);
  return created;
}

/** When a template's thumbnail is taken (its title is fully in). */
export const templateThumbTime = (tpl) => tpl.thumbAt ?? Math.min(2.5, tpl.duration / 2);

/**
 * A template drawn alone (black background) at time t of its animation, sized for the current
 * sequence, into a 2D context of the given width (the 기본 그래픽 panel's previews).
 */
export function drawTemplate(ctx, tpl, t, compositor, provider) {
  const s0 = store.seq;
  const s = createSequence({ width: s0.width, height: s0.height, fps: s0.fps, videoTracks: 0, audioTracks: 0 });
  let n = 0;
  buildTemplate(tpl, s, 0, {
    trackFor: () => {
      const tr = createTrack('video', n++);
      s.tracks.push(tr);
      return tr;
    },
    add: (c) => { s.clips[c.id] = c; },
  });
  compositor.render(ctx, s, Math.min(t, tpl.duration - 1 / s.fps), provider, { scale: ctx.canvas.width / s.width, background: '#000000' });
}

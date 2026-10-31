// Photoshop's Contextual Task Bar (상황별 작업 표시줄): a small floating bar under the selection or the
// active layer with the next steps that fit:
//  - a selection: Generative Fill (a prompt right in the bar), Select and Mask, Modify, Invert,
//    Create Mask, Fill, Transform, Deselect
//  - an image layer: Select Subject, Remove Background, Transform, a new adjustment layer, and
//    Generate Background once the background is gone
//  - a text layer: font, size, colour and Warp; a shape layer: fill and stroke colours
//  - the crop tool with the box past the canvas: Generative Expand
// It hides while painting or dragging and while a dialog is open. Window ▸ Contextual Task Bar turns
// it on and off; its ⋯ menu pins it where it was dragged, resets its place or hides it.

import { h } from '../util.js';
import { toast, showMenu, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { TOOL_BY_ID } from './tools.js';
import { fontLabel } from '../fonts.js';
import { openFontPicker } from '../ui/font-picker.js';

export function installTaskbar(P) {
  const C = P.cmd;
  const stage = document.querySelector('.ph-stage');
  if (!stage) return;
  const bar = h('div.ph-ctb', { role: 'toolbar', 'aria-label': '상황별 작업 표시줄', hidden: true });
  stage.append(bar);
  let on = loadPref('photo.taskbar', true);
  // a place the user dragged the bar to and pinned (stage coordinates), or null: it follows
  let pinned = loadPref('photo.taskbar.pin', null);
  let dragged = null;
  let pressing = false;
  let key = '';
  // the prompt field of a generative action is open (and what it does)
  let prompt = null;
  let busy = null;

  /**
   * The crop tool's box (x, y, w, h) when it reaches past the canvas and isn't turned (for
   * Generative Expand), or null. The tool keeps its box as a centre and size ({ cx, cy, w, h, a }).
   */
  P.cropExtent = () => {
    const doc = P.doc;
    const tool = P.tool === 'crop' ? TOOL_BY_ID.crop : null;
    if (!doc || !tool) return null;
    let r = null;
    const b = tool.box ? tool.box(P) : tool.b;
    if (b && Number.isFinite(b.cx)) {
      if (Math.abs(b.a || 0) > 1e-4) return null;
      r = { x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h };
    } else if (tool.r) r = tool.r;
    if (!r || r.w < 2 || r.h < 2) return null;
    const out = r.x < -0.5 || r.y < -0.5 || r.x + r.w > doc.width + 0.5 || r.y + r.h > doc.height + 0.5;
    return out ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null;
  };

  // ---- what the bar shows
  const context = () => {
    const doc = P.doc;
    if (!on || !doc || P.transform || P.editingText || document.querySelector('.modal-backdrop') || document.body.classList.contains('modal-peeking') || document.body.classList.contains('ph-screen-full')) return null;
    if (P.tool === 'crop') return P.cropExtent() ? 'crop' : null;
    if (doc.selection) return 'selection';
    const l = doc.active;
    if (!l) return null;
    if (l.kind === 'text') return 'text';
    if (l.kind === 'shape') return 'shape';
    if (l.kind === 'raster' || l.kind === 'smart') return 'image';
    if (l.kind === 'adjust' || l.kind === 'fill') return 'adjust';
    if (l.kind === 'group') return 'group';
    return null;
  };
  /** The box (doc coords) the bar sits under. */
  const anchorBox = (ctx) => {
    const doc = P.doc;
    if (ctx === 'crop') return P.cropExtent();
    if (ctx === 'selection') return P.selBounds(doc.selection.canvas);
    const l = doc.active;
    const all = { x: 0, y: 0, w: doc.width, h: doc.height };
    // pictures: their canvas' rectangle (no pixel scan after every brush stroke), inside the document
    let b = l && (l.kind === 'raster' || l.kind === 'smart') ? doc.bounds?.(l) : P.layerFrame?.(l)?.box;
    if (!b) return all;
    const x0 = Math.max(0, b.x);
    const y0 = Math.max(0, b.y);
    const x1 = Math.min(doc.width, b.x + b.w);
    const y1 = Math.min(doc.height, b.y + b.h);
    b = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : all;
    return b;
  };

  const btn = (ic, label, action, { title = label, primary = false, disabled = false } = {}) => h(`button.ph-ctb-btn${primary ? '.primary' : ''}`, { title, 'aria-label': title, disabled, onclick: action }, ic ? icon(ic, 15) : null, label ? h('span', label) : null);
  const more = () => btn('more', '', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: '막대 위치 고정', checked: !!pinned, action: () => { pinned = pinned ? null : currentPos(); savePref('photo.taskbar.pin', pinned); update(true); } },
      { label: '막대 위치 재설정', action: () => { pinned = null; savePref('photo.taskbar.pin', null); update(true); } },
      { label: '막대 숨기기', action: () => setOn(false) },
    ], r.left, r.bottom + 4);
  }, { title: '더 보기' });
  const grip = () => {
    const g = h('span.ph-ctb-grip', { title: '끌어서 옮기기', 'aria-hidden': 'true' }, icon('move', 13));
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sr = stage.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      dragged = { dx: e.clientX - br.left, dy: e.clientY - br.top, sr };
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      if (!dragged) return;
      pinned = { x: e.clientX - dragged.sr.left - dragged.dx, y: e.clientY - dragged.sr.top - dragged.dy };
      place();
    });
    const end = () => {
      if (!dragged) return;
      dragged = null;
      savePref('photo.taskbar.pin', pinned);
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    return g;
  };
  const menuBtn = (ic, label, items) => btn(ic, label, (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(typeof items === 'function' ? items() : items, r.left, r.bottom + 4);
  }, { title: label });
  const needKey = () => {
    if (P.photoAI?.hasKey?.()) return true;
    toast('생성형 AI에는 Gemini API 키가 필요합니다 (AI 패널 ▸ 설정)');
    P.showPanel('ai');
    return false;
  };
  const openPrompt = (kind) => {
    if (!needKey()) return;
    prompt = kind;
    update(true);
    setTimeout(() => bar.querySelector('input.ph-ctb-prompt')?.focus(), 0);
  };
  /** The prompt row of a generative action: a description, Generate, and back. */
  const promptRow = () => {
    const labels = { fill: ['생성형 채우기', '무엇으로 채울까요? (비우면 주변처럼 지우기)'], expand: ['생성형 확장', '넓힌 곳에 무엇을? (비우면 이어지게)'], background: ['배경 생성', '어떤 배경을 만들까요?'], image: ['이미지 생성', '무엇을 그릴까요?'] };
    const [title, ph] = labels[prompt] || labels.fill;
    const input = h('input.ph-ctb-prompt', { type: 'text', placeholder: ph, 'aria-label': title });
    const go = async () => {
      if (busy) return;
      const q = input.value;
      if (prompt === 'image' && !q.trim()) return void toast('무엇을 그릴지 적어 주세요');
      busy = new AbortController();
      const kind = prompt;
      update(true);
      try {
        const AI = P.photoAI;
        const r = kind === 'fill' ? await AI.generativeFill(q, busy.signal)
          : kind === 'expand' ? await AI.generativeExpand(P.cropExtent(), q, busy.signal)
            : kind === 'image' ? await AI.generateImage(q, busy.signal)
              : await AI.generateBackground(q, busy.signal);
        toast(`${title}: 새 레이어로 넣었습니다${r?.model ? ` (${r.model})` : ''}`);
        if (kind === 'expand') TOOL_BY_ID.crop?.activate?.(P);
        prompt = null;
      } catch (err) {
        if (err?.name !== 'AbortError') toast(String(err?.message || err));
      } finally {
        busy = null;
        update(true);
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') {
        prompt = null;
        update(true);
      }
    });
    if (busy) {
      return [h('span.ph-ctb-busy', icon('ai', 15), h('span', `${title}: Gemini가 그리는 중…`)), btn('close', '멈추기', () => busy?.abort())];
    }
    return [btn('undo', '', () => { prompt = null; update(true); }, { title: '뒤로' }), input, btn('ai', '생성', go, { primary: true, title: `${title} (Enter)` })];
  };

  const textControls = (l) => {
    const doc = P.doc;
    const t = l.text;
    const live = (label, fn) => P.run(label, () => {
      fn();
      doc.touch(l);
    });
    const fontB = h('button.ph-ctb-btn.ph-ctb-font', { title: '글꼴', 'aria-label': '글꼴', style: { fontFamily: `"${t.font}", sans-serif` } }, h('span', fontLabel(t.font || 'Noto Sans KR')));
    fontB.addEventListener('click', () => {
      const before = doc.capture();
      const orig = l.text;
      // the whole layer takes the font (characters with their own font too, like Photoshop when
      // the layer, not some letters, is selected)
      const withFont = (f) => ({ ...orig, font: f, runs: orig.runs?.map(({ font, ...r }) => r) });
      openFontPicker(fontB, {
        current: orig.font, sample: t.content,
        onPreview: (f) => { l.text = f ? withFont(f) : orig; doc.touch(l); P.redraw(); },
        onPick: (f) => { l.text = withFont(f); doc.touch(l); P.commit('글꼴', before); },
        onCancel: () => { l.text = orig; doc.touch(l); P.redraw(); },
      });
    });
    const size = h('input.ph-num.ph-ctb-size', { type: 'number', min: 1, max: 4000, step: 1, value: Math.round(t.size * 10) / 10, title: '글자 크기 (px)', 'aria-label': '글자 크기' });
    size.addEventListener('keydown', (e) => e.stopPropagation());
    size.addEventListener('change', () => {
      const v = Math.max(1, Math.min(4000, +size.value || t.size));
      live('글자 크기', () => { l.text = { ...l.text, size: v }; });
    });
    const color = h('input.ph-ctb-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#000000', title: '글자 색', 'aria-label': '글자 색' });
    color.addEventListener('change', () => live('글자 색', () => { l.text = { ...l.text, color: color.value, runs: l.text.runs?.map(({ color: _c, ...r }) => r) }; }));
    return [fontB, size, h('small.ph-ctb-unit', 'px'), color,
      btn('type', '뒤틀기', () => P.warpText?.(), { title: '텍스트 뒤틀기' }),
      btn('move', '', () => C.freeTransform(), { title: '변형 (Ctrl+T)' })];
  };
  const shapeControls = (l) => {
    const doc = P.doc;
    const s = l.shape;
    const fill = h('input.ph-ctb-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(s.fill || '') ? s.fill : '#000000', title: '칠 색', 'aria-label': '칠 색' });
    fill.addEventListener('change', () => P.run('모양 칠', () => { l.shape = { ...l.shape, fill: fill.value }; doc.touch(l); }));
    const stroke = h('input.ph-ctb-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(s.stroke || '') ? s.stroke : '#000000', title: '획 색', 'aria-label': '획 색' });
    stroke.addEventListener('change', () => P.run('모양 획', () => { l.shape = { ...l.shape, stroke: stroke.value, strokeWidth: l.shape.strokeWidth || Math.max(2, Math.round(Math.min(l.shape.w, l.shape.h) / 40)) }; doc.touch(l); }));
    return [h('label.ph-ctb-lab', h('span', '칠'), fill), h('label.ph-ctb-lab', h('span', '획'), stroke),
      btn('move', '변형', () => C.freeTransform(), { title: '변형 (Ctrl+T)' }),
      btn('sliders', '속성', () => P.showPanel('props'), { title: '속성 패널' })];
  };
  /** A layer whose background Remove Background took away (its mask is marked): Generate Background fits. */
  const cutOut = (l) => !!l.mask?.subject && l.mask.enabled !== false;
  // Layer ▸ Remove Background (view3.js) leaves a mask: mark it as a subject cut-out
  P.on('history', () => {
    const doc = P.doc;
    const l = doc?.active;
    if (l?.mask && !l.mask.subject && doc.history?.undoStack?.at(-1)?.label === '배경 제거') l.mask.subject = true;
  });

  const buttons = (ctx) => {
    const doc = P.doc;
    const l = doc.active;
    if (prompt || busy) return promptRow();
    if (ctx === 'crop') {
      return [btn('ai', '생성형 확장', () => openPrompt('expand'), { primary: true, title: '넓힌 곳을 AI로 채우기' }),
        btn('check', '자르기', () => TOOL_BY_ID.crop.apply(P), { title: '자르기 적용 (Enter)' }),
        btn('reset', '', () => (TOOL_BY_ID.crop.reset || TOOL_BY_ID.crop.activate).call(TOOL_BY_ID.crop, P), { title: '재설정 (Esc)' })];
    }
    if (ctx === 'selection') {
      return [btn('ai', '생성형 채우기', () => openPrompt('fill'), { primary: true, title: '선택 영역을 AI로 다시 그리기' }),
        btn('mask', '선택 및 마스크', () => C.selectAndMask(), { title: '선택 및 마스크 (Ctrl+Alt+R)' }),
        menuBtn('sliders', '수정', [
          { label: '테두리…', action: () => C.border() }, { label: '매끄럽게…', action: () => C.smooth() },
          { label: '확대…', action: () => C.expand() }, { label: '축소…', action: () => C.contract() }, { label: '페더…', action: () => C.feather() },
        ]),
        btn('reverse', '반전', () => C.inverse(), { title: '선택 영역 반전 (Ctrl+Shift+I)' }),
        btn('mask', '마스크 만들기', () => (l?.mask ? toast('이미 마스크가 있습니다') : C.addMask(false)), { title: '선택 영역으로 레이어 마스크 만들기', disabled: !l }),
        btn('bucket', '칠', () => P.dialogs?.fillDialog?.(P), { title: '칠 (Shift+F5)' }),
        btn('move', '변형', () => C.transformSelection(), { title: '선택 영역 변형' }),
        btn('close', '', () => C.deselect(), { title: '선택 해제 (Ctrl+D)' })];
    }
    if (ctx === 'text') return textControls(l);
    if (ctx === 'shape') return shapeControls(l);
    if (ctx === 'image') {
      const out = [btn('objSel', '피사체 선택', () => C.selectSubject(), { title: '피사체 선택' })];
      if (cutOut(l)) out.push(btn('ai', '배경 생성', () => openPrompt('background'), { primary: true, title: '피사체 뒤에 AI로 새 배경' }));
      else out.push(btn('eraser', '배경 제거', () => C.removeBackground(), { title: '배경 제거 (피사체만 남기기)' }));
      out.push(btn('move', '변형', () => C.freeTransform(), { title: '변형 (Ctrl+T)' }),
        menuBtn('drop', '조정', () => P.newFillOrAdjustMenu?.() || []));
      if (doc.layers.length === 1) out.push(btn('sparkle', '이미지 생성', () => openPrompt('image'), { title: '설명으로 새 그림 (AI)' }));
      return out;
    }
    if (ctx === 'adjust') return [btn('sliders', '속성', () => P.showPanel('props'), { title: '속성 패널에서 설정 바꾸기' }), btn('mask', '마스크 반전', () => C.invertMask?.(), { title: '마스크 반전', disabled: !l?.mask })];
    if (ctx === 'group') return [btn('move', '변형', () => C.freeTransform(), { title: '변형 (Ctrl+T)' }), btn('mask', '마스크 추가', () => C.addMask(false), { disabled: !!l.mask })];
    return [];
  };

  // ---- placing
  const currentPos = () => ({ x: parseFloat(bar.style.left) || 0, y: parseFloat(bar.style.top) || 0 });
  /** A doc point in stage coordinates (the view may be turned with Rotate View). */
  const toStage = (x, y) => {
    const [sx, sy] = P.toScreen(x, y);
    const rot = P.doc?.view?.rot || 0;
    if (!rot) return [sx, sy];
    const r = stage.getBoundingClientRect();
    const a = (rot * Math.PI) / 180;
    const cx = r.width / 2;
    const cy = r.height / 2;
    return [cx + (sx - cx) * Math.cos(a) - (sy - cy) * Math.sin(a), cy + (sx - cx) * Math.sin(a) + (sy - cy) * Math.cos(a)];
  };
  let ctxNow = null;
  const place = () => {
    if (bar.hidden) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    let x;
    let y;
    if (pinned) {
      x = pinned.x;
      y = pinned.y;
    } else {
      const b = anchorBox(ctxNow);
      if (!b) return;
      const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([px, py]) => toStage(px, py));
      const left = Math.min(...pts.map((p) => p[0]));
      const right = Math.max(...pts.map((p) => p[0]));
      const top = Math.min(...pts.map((p) => p[1]));
      const bottom = Math.max(...pts.map((p) => p[1]));
      x = (left + right) / 2 - bw / 2;
      // under the box; above it when there is no room; at the bottom of the screen otherwise
      y = bottom + 14;
      if (y + bh > sh - 8) y = top - bh - 14;
      if (y < 8) y = sh - bh - 12;
    }
    x = Math.max(6, Math.min(sw - bw - 6, x));
    y = Math.max(6, Math.min(sh - bh - 6, y));
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(y)}px`;
  };
  // which context each generative prompt belongs to
  const FITS = { fill: 'selection', expand: 'crop', background: 'image', image: 'image' };
  const update = (force = false) => {
    const ctx = pressing && !prompt && !busy ? null : context();
    if (prompt && !busy && FITS[prompt] !== ctx) prompt = null;
    const doc = P.doc;
    const l = doc?.active;
    // what the buttons depend on: context, layer, its text / shape values, the AI state
    const k = ctx ? `${ctx}|${doc.id}|${l?.id}|${l?.kind === 'text' ? `${l.text.font}|${l.text.size}|${l.text.color}` : l?.kind === 'shape' ? `${l.shape.fill}|${l.shape.stroke}` : ''}|${l ? cutOut(l) : ''}|${doc.layers.length === 1}|${prompt}|${!!busy}|${!!l?.mask}` : '';
    ctxNow = ctx;
    if (!ctx) {
      // a generative request keeps the bar while it runs
      if (!busy) {
        bar.hidden = true;
        key = '';
      }
      return;
    }
    if (k !== key || force) {
      // keep focus in the prompt field when the bar redraws for another reason
      const typing = document.activeElement?.classList?.contains('ph-ctb-prompt') ? document.activeElement.value : null;
      key = k;
      bar.replaceChildren(grip(), ...buttons(ctx), more());
      if (typing != null) {
        const inp = bar.querySelector('input.ph-ctb-prompt');
        if (inp) {
          inp.value = typing;
          inp.focus();
        }
      }
    }
    bar.hidden = false;
    place();
  };
  const setOn = (v) => {
    on = v;
    savePref('photo.taskbar', on);
    if (!on) {
      prompt = null;
      toast('상황별 작업 표시줄을 숨겼습니다 (창 ▸ 상황별 작업 표시줄로 다시 보기)');
    }
    update(true);
  };
  C.toggleTaskbar = () => setOn(!on);
  P.taskbarOn = () => on;

  // the bar is part of the stage: its clicks must not reach the canvas tools
  for (const ev of ['pointerdown', 'dblclick', 'wheel', 'contextmenu']) bar.addEventListener(ev, (e) => e.stopPropagation());
  // hidden while painting or dragging on the canvas
  stage.addEventListener('pointerdown', (e) => {
    if (bar.contains(e.target)) return;
    pressing = true;
    if (!prompt && !busy) bar.hidden = true;
  }, true);
  const release = () => {
    if (!pressing) return;
    pressing = false;
    // after the tool has finished the stroke (selection made, layer moved…)
    setTimeout(() => update(), 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  let raf = 0;
  const soon = () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
  };
  P.on('redraw', () => {
    if (pressing) return;
    if (ctxNow && !bar.hidden && !dragged) {
      // the cheap part every frame: stay under the box as the view or the box moves
      const k = context();
      if (k !== ctxNow) soon();
      else place();
    } else soon();
  });
  for (const ev of ['tool', 'doc', 'layers', 'history', 'opts']) P.on(ev, soon);
  // dialogs opening and closing
  new MutationObserver(soon).observe(document.body, { childList: true });
  new ResizeObserver(soon).observe(stage);

  // ---- Window ▸ Contextual Task Bar
  P.extendMenus = [...(P.extendMenus || []), () => {
    const orig = P.menus['창'];
    if (!orig) return;
    // with the panels (Photoshop lists it among them): before Options / Tools when they are there
    P.menus['창'] = () => {
      const items = orig();
      const item = { label: '상황별 작업 표시줄', checked: on, action: () => setOn(!on) };
      let i = items.findIndex((x) => typeof x === 'object' && (x?.label === '옵션' || x?.label === '도구'));
      if (i > 0 && items[i - 1] === '-') i--;
      if (i >= 0) items.splice(i, 0, item);
      else items.push(item);
      return items;
    };
  }];
}

// Photoshop's Gradient Editor (그레이디언트 편집기): presets (built-in, the user's and imported .grd
// files), name, gradient type (단색 / 노이즈), smoothness, colour and opacity stops with midpoints
// (drag along the bar, drag off it to delete, click under the bar to add), noise gradients
// (roughness, colour model, channel ranges, restrict colours, transparency, randomize), 새로 만들기
// to keep the gradient as a preset, and 가져오기 for Photoshop .grd files.

import { h, clamp } from '../util.js';
import { openModal, toast } from '../ui/common.js';
import { injectStyle } from '../ui/style-inject.js';
import { GRADIENTS, gradientSwatch, gradientLut, resolveStopColor, userGradients, addUserGradients } from './resources.js';
import { colorPickerDialog } from './colorpicker.js';
import { parseGrd } from './psdres.js';

injectStyle('ph-gradedit-css', `
.ge { display: flex; flex-direction: column; gap: 8px; }
.ge-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(46px * var(--ui-scale)), 1fr)); gap: 4px; max-height: calc(132px * var(--ui-scale)); overflow: auto; padding: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; }
.ge-presets button { padding: 1px; min-height: 0; border: 1px solid transparent; background: none; border-radius: 4px; }
.ge-presets button.on { border-color: var(--accent); }
.ge-presets canvas { width: 100%; height: calc(28px * var(--ui-scale)); display: block; border-radius: 2px; }
.ge-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-s); color: var(--text-dim); }
.ge-row input[type=text] { flex: 1; min-width: 120px; }
.ge-row input[type=number] { width: calc(62px * var(--ui-scale)); min-height: 0; height: calc(26px * var(--ui-scale)); }
.ge-row select { min-height: 0; height: calc(26px * var(--ui-scale)); }
.ge-bar { position: relative; margin: 0 8px; }
.ge-bar canvas { width: 100%; height: calc(30px * var(--ui-scale)); display: block; border: 1px solid var(--line-2); border-radius: 2px; }
.ge-strip { position: relative; height: 20px; margin: 0 8px; cursor: copy; touch-action: none; }
.ge-stop { position: absolute; width: 13px; height: 16px; margin-left: -7px; padding: 0; min-height: 0; border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 0 1px #fff; cursor: ew-resize; touch-action: none; }
.ge-strip.alpha .ge-stop { top: 2px; }
.ge-strip.color .ge-stop { top: 2px; }
.ge-stop.on { box-shadow: 0 0 0 2px var(--focus); }
.ge-mid { position: absolute; top: 4px; width: 9px; height: 9px; margin-left: -5px; transform: rotate(45deg); background: var(--bg); border: 1px solid var(--text-dim); cursor: ew-resize; touch-action: none; }
.ge-mid.on { background: var(--value); }
.ge-detail { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; }
.ge-detail legend, .ge-title { color: var(--text-faint); font-size: var(--fs-xs); }
.ge-color { width: 40px; height: 22px; min-height: 0; padding: 0; border: 1px solid var(--line-2); border-radius: 3px; }
.ge-noise { display: grid; grid-template-columns: auto 1fr 1fr; gap: 4px 8px; align-items: center; font-size: var(--fs-s); color: var(--text-dim); }
.ge-noise input[type=number] { width: 100%; min-height: 0; height: calc(24px * var(--ui-scale)); }
`);

const CHANNELS = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] };
const defaultNoise = () => ({ roughness: 50, model: 'rgb', seed: (Math.random() * 1e9) >>> 0, restrict: false, transparency: false, min: [0, 0, 0, 0], max: [100, 100, 100, 100] });

/** Open the Gradient Editor on a gradient; onApply(gradient) when 확인 is pressed. */
export function gradientEditorDialog(P, gr, onApply = () => {}) {
  let g = structuredClone(gr?.stops || gr?.type === 'noise' ? gr : GRADIENTS[0]);
  const fix = () => {
    g.stops = (g.stops?.length ? g.stops : [{ pos: 0, color: 'fg' }, { pos: 1, color: 'bg' }]).map((s) => ({ ...s }));
    g.alphas = (g.alphas?.length ? g.alphas : [{ pos: 0, a: 1 }, { pos: 1, a: 1 }]).map((s) => ({ ...s }));
    if (g.smooth == null) g.smooth = 100;
    if (g.type === 'noise') g.noise = { ...defaultNoise(), ...(g.noise || {}) };
    g.name ||= '사용자 정의';
  };
  fix();
  let sel = { kind: 'c', i: 0 };
  const fg = () => P?.fg || '#000000';
  const bg = () => P?.bg || '#ffffff';
  const W = 400;

  const presetsEl = h('div.ge-presets');
  const nameIn = h('input', { type: 'text', 'aria-label': '이름' });
  nameIn.addEventListener('input', () => {
    g.name = nameIn.value;
  });
  const typeSel = h('select', { 'aria-label': '그레이디언트 유형' }, h('option', { value: 'solid' }, '단색'), h('option', { value: 'noise' }, '노이즈'));
  typeSel.addEventListener('change', () => {
    if (typeSel.value === 'noise') {
      g.type = 'noise';
      g.noise = { ...defaultNoise(), ...(g.noise || {}) };
    } else delete g.type;
    render();
  });
  const smoothIn = h('input', { type: 'number', min: 0, max: 100, 'aria-label': '매끄러움' });
  smoothIn.addEventListener('change', () => {
    g.smooth = clamp(Math.round(+smoothIn.value || 0), 0, 100);
    render();
  });
  const bar = h('div.ge-bar');
  const alphaStrip = h('div.ge-strip.alpha', { title: '불투명도 정지점: 눌러서 추가, 끌어서 옮기기, 바깥으로 끌어내면 삭제' });
  const colorStrip = h('div.ge-strip.color', { title: '색상 정지점: 눌러서 추가, 끌어서 옮기기, 바깥으로 끌어내면 삭제, 두 번 눌러 색 바꾸기' });
  const detail = h('div.ge-detail');
  const solidBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, alphaStrip, bar, colorStrip, detail);
  const noiseBox = h('div.ge-detail');

  const list = (kind) => (kind === 'c' ? g.stops : g.alphas);
  const colorAt = (t) => {
    const lut = gradientLut({ ...g, alphas: [{ pos: 0, a: 1 }, { pos: 1, a: 1 }] }, { fg: fg(), bg: bg() });
    const k = clamp(Math.round(t * 255), 0, 255) * 4;
    return `#${[lut[k], lut[k + 1], lut[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };
  const alphaAt = (t) => gradientLut(g, { fg: fg(), bg: bg() })[clamp(Math.round(t * 255), 0, 255) * 4 + 3] / 255;

  /**
   * Drag a stop (or midpoint) along a strip; pulling a stop far off the strip removes it. Pressing
   * selects it (onDown); the strips are only rebuilt after a real drag, so the element stays for its
   * click and double-click.
   */
  const dragOn = (el, strip, onDown, onMove, onUp, { removable = false } = {}) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      const r = strip.getBoundingClientRect();
      const x0 = e.clientX;
      let off = false;
      let moved = false;
      onDown();
      const mv = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 2 && Math.abs(ev.clientY - e.clientY) < 2) return;
        moved = true;
        off = removable && Math.abs(ev.clientY - (r.top + r.height / 2)) > 40;
        el.style.opacity = off ? '0.3' : '';
        onMove(clamp((ev.clientX - r.left) / r.width, 0, 1));
      };
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (moved) onUp(off);
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };

  const paintBar = () => bar.replaceChildren(gradientSwatch(g, W, 30, fg(), bg()));
  /** Select a stop or midpoint without rebuilding the strips. */
  const select = (s2, el) => {
    sel = s2;
    for (const x of [...alphaStrip.children, ...colorStrip.children]) x.classList.remove('on');
    el.classList.add('on');
    renderDetail();
  };

  function renderStops() {
    for (const [kind, strip] of [['a', alphaStrip], ['c', colorStrip]]) {
      const arr = list(kind);
      const order = arr.map((s, i) => [s, i]).sort((x, y) => x[0].pos - y[0].pos);
      const els = [];
      // midpoints between neighbours (on the stop after them); the selected stop's are highlighted
      for (let k = 1; k < order.length; k++) {
        const [a] = order[k - 1];
        const [b, bi] = order[k];
        const mid = (b.mid ?? 50) / 100;
        const m = h(`div.ge-mid${sel.kind === kind && (sel.i === bi || sel.i === order[k - 1][1]) ? '.on' : ''}`, { style: { left: `${(a.pos + (b.pos - a.pos) * mid) * 100}%` }, title: '중간점: 끌어서 두 색이 반씩 섞이는 곳을 옮깁니다', 'aria-label': '중간점' });
        dragOn(m, strip, () => select({ kind, i: bi, mid: true }, m), (t) => {
          const span = Math.max(1e-6, b.pos - a.pos);
          b.mid = clamp(Math.round(((t - a.pos) / span) * 100), 5, 95);
          m.style.left = `${(a.pos + span * (b.mid / 100)) * 100}%`;
          paintBar();
          sel = { kind, i: bi, mid: true };
          renderDetail();
        }, () => render());
        els.push(m);
      }
      arr.forEach((s, i) => {
        const col = kind === 'c' ? resolveStopColor(s.color, fg(), bg()) : `rgba(0,0,0,${s.a})`;
        const el = h(`button.ge-stop${sel.kind === kind && sel.i === i && !sel.mid ? '.on' : ''}`, { style: { left: `${s.pos * 100}%`, background: kind === 'c' ? col : `linear-gradient(${col}, ${col}), #fff` }, 'aria-label': `${kind === 'c' ? '색상' : '불투명도'} 정지점 ${Math.round(s.pos * 100)}%` });
        dragOn(el, strip, () => select({ kind, i }, el), (t) => {
          s.pos = t;
          el.style.left = `${t * 100}%`;
          sel = { kind, i };
          paintBar();
          renderDetail();
        }, (off) => {
          if (off && arr.length > 2) {
            arr.splice(i, 1);
            sel = { kind, i: 0 };
          }
          render();
        }, { removable: true });
        if (kind === 'c') el.addEventListener('dblclick', () => pickColor(s));
        els.push(el);
      });
      strip.replaceChildren(...els);
    }
  }

  const pickColor = (s) => colorPickerDialog({
    title: '정지점 색상 선택',
    value: resolveStopColor(s.color, fg(), bg()),
    onOk: (hex) => {
      s.color = hex;
      render();
    },
  });

  // clicking a strip adds a stop there, coloured like the gradient at that point
  for (const [kind, strip] of [['a', alphaStrip], ['c', colorStrip]]) {
    strip.addEventListener('pointerdown', (e) => {
      if (e.target !== strip || g.type === 'noise') return;
      const r = strip.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / r.width, 0, 1);
      const arr = list(kind);
      arr.push(kind === 'c' ? { pos: t, color: colorAt(t), mid: 50 } : { pos: t, a: Math.round(alphaAt(t) * 100) / 100, mid: 50 });
      sel = { kind, i: arr.length - 1 };
      render();
    });
  }

  function renderDetail() {
    const arr = list(sel.kind);
    const s = arr[Math.min(sel.i, arr.length - 1)];
    if (!s) return detail.replaceChildren();
    const num = (v, min, max, on) => {
      const n = h('input', { type: 'number', min, max, step: 1, value: v });
      n.addEventListener('change', () => {
        on(clamp(+n.value || 0, min, max));
        render();
      });
      return n;
    };
    const del = h('button.small', { disabled: arr.length <= 2, onclick: () => { arr.splice(arr.indexOf(s), 1); sel = { kind: sel.kind, i: 0 }; render(); } }, '삭제');
    const rows = [h('div.ge-title', sel.mid ? '중간점' : sel.kind === 'c' ? '색상 정지점' : '불투명도 정지점')];
    if (sel.kind === 'c' && !sel.mid) {
      const sw = h('button.ge-color', { style: { background: resolveStopColor(s.color, fg(), bg()) }, title: '색상 피커', 'aria-label': '정지점 색상', onclick: () => pickColor(s) });
      const kindSel = h('select', { 'aria-label': '색상 종류' }, h('option', { value: 'user' }, '사용자 색상'), h('option', { value: 'fg' }, '전경색'), h('option', { value: 'bg' }, '배경색'));
      kindSel.value = s.color === 'fg' || s.color === 'bg' ? s.color : 'user';
      kindSel.addEventListener('change', () => {
        s.color = kindSel.value === 'user' ? resolveStopColor(s.color, fg(), bg()) : kindSel.value;
        render();
      });
      rows.push(h('div.ge-row', h('span', '색상'), sw, kindSel, h('span', '위치'), num(Math.round(s.pos * 100), 0, 100, (v) => { s.pos = v / 100; }), h('small', '%'), del));
    } else if (!sel.mid) {
      rows.push(h('div.ge-row', h('span', '불투명도'), num(Math.round(s.a * 100), 0, 100, (v) => { s.a = v / 100; }), h('small', '%'), h('span', '위치'), num(Math.round(s.pos * 100), 0, 100, (v) => { s.pos = v / 100; }), h('small', '%'), del));
    } else {
      rows.push(h('div.ge-row', h('span', '위치'), num(s.mid ?? 50, 5, 95, (v) => { s.mid = v; }), h('small', '% (두 정지점 사이)')));
    }
    detail.replaceChildren(...rows);
  }

  function renderNoise() {
    const n = g.noise;
    const chs = CHANNELS[n.model] || CHANNELS.rgb;
    const numIn = (get, set, min = 0, max = 100) => {
      const i = h('input', { type: 'number', min, max, step: 1, value: get() });
      i.addEventListener('change', () => {
        set(clamp(Math.round(+i.value || 0), min, max));
        render();
      });
      return i;
    };
    const model = h('select', { 'aria-label': '색상 모델' }, [['rgb', 'RGB'], ['hsb', 'HSB'], ['lab', 'LAB']].map(([v, t]) => h('option', { value: v }, t)));
    model.value = n.model;
    model.addEventListener('change', () => {
      n.model = model.value;
      render();
    });
    const chk = (k, label) => {
      const b = h('input', { type: 'checkbox', checked: !!n[k] });
      b.addEventListener('change', () => {
        n[k] = b.checked;
        render();
      });
      return h('label.ge-row', b, h('span', label));
    };
    noiseBox.replaceChildren(
      h('div.ge-row', h('span', '거칠기'), numIn(() => n.roughness, (v) => { n.roughness = v; }), h('small', '%'), h('span', '색상 모델'), model),
      h('div.ge-noise', h('span'), h('span.ge-title', '최소 (%)'), h('span.ge-title', '최대 (%)'),
        ...chs.flatMap((c, k) => [h('span', c), numIn(() => n.min[k], (v) => { n.min[k] = Math.min(v, n.max[k]); }), numIn(() => n.max[k], (v) => { n.max[k] = Math.max(v, n.min[k]); })])),
      h('div.ge-row', chk('restrict', '색상 제한'), chk('transparency', '투명도 추가'),
        h('button.small', { onclick: () => { n.seed = (Math.random() * 1e9) >>> 0; render(); } }, '무작위화')),
    );
  }

  function renderPresets() {
    const all = [...GRADIENTS, ...userGradients()];
    presetsEl.replaceChildren(...all.map((pr) => h(`button${pr.id && pr.id === g.id ? '.on' : ''}`, {
      title: pr.name, 'aria-label': pr.name,
      onclick: () => {
        g = structuredClone(pr);
        fix();
        sel = { kind: 'c', i: 0 };
        render();
      },
    }, gradientSwatch(pr, 64, 24, fg(), bg()))));
  }

  function render() {
    nameIn.value = g.name || '';
    typeSel.value = g.type === 'noise' ? 'noise' : 'solid';
    smoothIn.value = g.smooth ?? 100;
    smoothRow.hidden = g.type === 'noise';
    flipRow.hidden = g.type === 'noise';
    solidBox.hidden = g.type === 'noise';
    noiseBox.hidden = g.type !== 'noise';
    paintBar();
    if (g.type === 'noise') {
      renderNoise();
      // the noise preview goes above its settings
      noiseBox.prepend(bar);
    } else {
      if (bar.previousSibling !== alphaStrip) alphaStrip.after(bar);
      renderStops();
      renderDetail();
    }
    renderPresets();
  }

  const importGrd = async () => {
    const { pickFiles } = await import('../ui/project-panel.js');
    const files = await pickFiles({ accept: '.grd', multiple: true });
    const n = await importGradientFiles(P, files);
    if (n) renderPresets();
  };
  const saveNew = () => {
    const [added] = addUserGradients([{ ...g, name: (g.name || '사용자 정의').slice(0, 40) }], fg(), bg());
    g.id = added.id;
    P?.emit?.('gradients');
    toast(`"${added.name}" 그레이디언트를 사전 설정에 추가했습니다 (그레이디언트 패널의 내 그레이디언트)`);
    renderPresets();
  };

  const smoothRow = h('label.ge-row', h('span', '매끄러움'), smoothIn, h('small', '%'));
  const flipRow = h('div.ge-row', h('button.small', { onclick: () => { for (const s of [...g.stops, ...g.alphas]) s.pos = 1 - s.pos; render(); } }, '좌우 뒤집기'), h('span.ge-title', '정지점: 눌러서 추가 · 끌어서 옮기기 · 바깥으로 끌어내 삭제 · 두 번 눌러 색 바꾸기'));
  render();
  openModal({
    title: '그레이디언트 편집기',
    width: '470px',
    peek: false,
    body: [h('div.ge',
      h('div.ge-row', h('span.ge-title', '사전 설정'), h('span', { style: { flex: 1 } }), h('button.small', { onclick: importGrd, title: 'Photoshop 그레이디언트 파일 (.grd)' }, '가져오기…')),
      presetsEl,
      h('div.ge-row', h('span', '이름'), nameIn, h('button.small', { onclick: saveNew, title: '지금 그레이디언트를 사전 설정으로 저장' }, '새로 만들기')),
      h('div.ge-row', h('span', '그레이디언트 유형'), typeSel, smoothRow),
      solidBox,
      noiseBox,
      flipRow)],
    buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => onApply(structuredClone(g)) }],
  });
}

/** Photoshop gradient files (.grd) into the user's gradients; returns how many came in. */
export async function importGradientFiles(P, files) {
  let total = 0;
  for (const f of files) {
    try {
      const list = parseGrd(await f.arrayBuffer());
      if (!list.length) {
        toast(`${f.name}: 가져올 그레이디언트가 없습니다`);
        continue;
      }
      const base = f.name.replace(/\.[^.]+$/, '');
      addUserGradients(list.map((g) => ({ ...g, name: (g.name || base).slice(0, 40), group: base })), P?.fg, P?.bg);
      total += list.length;
      toast(`${f.name}: 그레이디언트 ${list.length}개를 가져왔습니다 (그레이디언트 패널의 내 그레이디언트)`);
    } catch (err) {
      toast(`${f.name}: 그레이디언트 파일을 읽을 수 없습니다 (${err.message || err})`);
    }
  }
  if (total) P?.emit?.('gradients');
  return total;
}

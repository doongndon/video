// Camera Raw ▸ 사전 설정 (Shift+P): built-in presets in folders, the 양 (amount) slider and the
// user's own presets (kept in this browser). A preset is a set of Camera Raw settings; applying one
// changes only those settings, and 양 moves them from where they were (0) through the preset (100)
// to twice as strong (200).

import { h } from '../util.js';
import { icon } from '../ui/icons.js';
import { toast, promptDialog } from '../ui/common.js';

const fade = (lo, hi) => [[0, lo], [255, hi]];

/** [folder, [[name, settings], …]] */
export const CR_PRESETS = [
  ['인물', [
    ['자연스러운 피부', { exposure: 0.15, contrast: -10, highlights: -20, shadows: 15, texture: -20, clarity: -10, vibrance: 10, saturation: -5, s_orange: -10, l_orange: 10, temp: 5 }],
    ['밝고 화사하게', { exposure: 0.35, contrast: -15, highlights: -30, shadows: 25, whites: 10, blacks: 10, clarity: -15, vibrance: 15, l_orange: 15, curve: [[0, 15], [128, 136], [255, 255]] }],
    ['부드러운 인물', { texture: -35, clarity: -25, contrast: -10, highlights: -15, shadows: 10, saturation: -10, vignette: -10 }],
    ['따뜻한 인물', { temp: 15, tint: 5, exposure: 0.1, shadows: 10, vibrance: 10, cgHighH: 45, cgHighS: 15, cgShadowH: 30, cgShadowS: 8 }],
  ]],
  ['풍경', [
    ['선명한 풍경', { profile: 'landscape', contrast: 15, highlights: -35, shadows: 30, whites: 15, blacks: -15, texture: 15, clarity: 25, dehaze: 15, vibrance: 30, saturation: 5 }],
    ['노을 강조', { temp: 25, tint: 10, highlights: -30, shadows: 20, vibrance: 25, s_orange: 20, s_red: 10, h_orange: -5, cgHighH: 35, cgHighS: 20, dehaze: 10 }],
    ['안개 걷기', { dehaze: 40, contrast: 10, clarity: 15, blacks: -10, vibrance: 15 }],
    ['푸른 하늘', { highlights: -40, s_blue: 30, l_blue: -25, h_aqua: 10, vibrance: 15, dehaze: 10, temp: -5 }],
    ['초록 숲', { s_green: 25, l_green: -10, h_yellow: 15, s_yellow: 10, clarity: 15, shadows: 20 }],
  ]],
  ['흑백', [
    ['기본 흑백', { treatment: 'bw' }],
    ['고대비 흑백', { treatment: 'bw', contrast: 40, clarity: 25, whites: 20, blacks: -25, bw_blue: -30, bw_red: 20 }],
    ['부드러운 흑백', { treatment: 'bw', contrast: -20, highlights: -20, shadows: 25, curve: fade(25, 235), grain: 15 }],
    ['셀레늄 톤', { treatment: 'bw', contrast: 15, cgShadowH: 280, cgShadowS: 20, cgHighH: 40, cgHighS: 10 }],
    ['세피아', { treatment: 'bw', contrast: -5, cgGlobalH: 35, cgGlobalS: 25 }],
  ]],
  ['빈티지', [
    ['바랜 필름', { curve: [[0, 40], [64, 70], [192, 200], [255, 235]], contrast: -10, saturation: -20, grain: 20, cgShadowH: 200, cgShadowS: 10 }],
    ['따뜻한 빈티지', { temp: 20, saturation: -15, curve: fade(30, 240), cgHighH: 45, cgHighS: 20, vignette: -20, grain: 25 }],
    ['크로스 프로세스', { curveR: [[0, 0], [64, 50], [192, 210], [255, 255]], curveG: [[0, 10], [128, 135], [255, 250]], curveB: fade(40, 215), contrast: 10, saturation: 10 }],
    ['오래된 사진', { treatment: 'bw', cgGlobalH: 38, cgGlobalS: 30, curve: fade(35, 225), grain: 40, grainSize: 40, vignette: -35 }],
  ]],
  ['시네마틱', [
    ['틸 앤 오렌지', { cgShadowH: 190, cgShadowS: 30, cgHighH: 35, cgHighS: 25, contrast: 15, s_orange: 10, h_green: 15, s_blue: -10, vibrance: -5, vignette: -15 }],
    ['차가운 밤', { temp: -25, exposure: -0.3, contrast: 15, cgShadowH: 215, cgShadowS: 30, saturation: -15, blacks: -10 }],
    ['블리치 바이패스', { saturation: -40, contrast: 35, clarity: 20, highlights: -15, blacks: -15, texture: 10 }],
    ['따뜻한 영화', { temp: 12, contrast: 10, curve: [[0, 18], [60, 55], [190, 200], [255, 245]], cgHighH: 40, cgHighS: 18, cgShadowH: 20, cgShadowS: 10, grain: 10, vignette: -15 }],
  ]],
  ['음식', [
    ['맛있게 따뜻하게', { temp: 12, exposure: 0.15, vibrance: 25, s_red: 10, s_orange: 10, clarity: 10, texture: 10 }],
    ['선명한 음식', { contrast: 15, clarity: 20, texture: 20, vibrance: 20, sharpAmount: 40, shadows: 10 }],
    ['밝은 카페', { exposure: 0.4, highlights: -25, shadows: 30, whites: 15, contrast: -10, temp: 5, saturation: -5, curve: fade(20, 255) }],
  ]],
  ['도시', [
    ['도시 야경', { temp: -10, highlights: -30, shadows: 20, clarity: 20, dehaze: 10, vibrance: 20, s_blue: 15, s_orange: 15 }],
    ['거친 도시', { contrast: 25, clarity: 40, texture: 25, saturation: -30, blacks: -15, vignette: -25 }],
  ]],
];

const USER_KEY = 'montage.cameraRawPresets';
function userPresets() {
  try {
    const v = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && x.values) : [];
  } catch {
    return [];
  }
}
function saveUserPresets(list) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * The preset at strength t (0..2) on top of `base` (the settings before it): numbers move from the
 * base value, curves bend from a straight line, everything else switches on at any strength.
 * `defs` gives a missing base value.
 */
export function blendPreset(base, preset, t, defs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(preset)) {
    const b = base[k] ?? defs[k];
    if (typeof v === 'number') {
      const b0 = typeof b === 'number' ? b : 0;
      out[k] = Math.round((b0 + (v - b0) * t) * 100) / 100;
    } else if (Array.isArray(v)) {
      out[k] = t <= 0 ? b ?? null : v.map(([x, y]) => [x, Math.max(0, Math.min(255, Math.round(x + (y - x) * t)))]);
    } else out[k] = t > 0 ? v : b;
  }
  return out;
}

/**
 * The 사전 설정 panel. ui: { p, defs, apply(values) (sets settings and refreshes), commit(),
 * thumb(values) → canvas, current() → the settings worth saving }.
 */
export function presetsPanel(ui) {
  let active = null; // { name, preset, base }
  const amt = h('input', { type: 'range', min: 0, max: 200, step: 1, value: 100, disabled: true, 'aria-label': '양' });
  const amtNum = h('input.ph-num', { type: 'number', min: 0, max: 200, value: 100, disabled: true });
  const amtName = h('span.note', '사전 설정을 고르세요');
  const setAmt = (v, done) => {
    if (!active) return;
    v = Math.max(0, Math.min(200, +v || 0));
    amt.value = v;
    amtNum.value = v;
    ui.apply(blendPreset(active.base, active.preset, v / 100, ui.defs));
    if (done) ui.commit();
  };
  amt.addEventListener('input', () => setAmt(amt.value));
  amt.addEventListener('change', () => setAmt(amt.value, true));
  amtNum.addEventListener('change', () => setAmt(amtNum.value, true));
  amt.addEventListener('dblclick', () => setAmt(100, true));

  const choose = (name, preset, tile) => {
    const base = {};
    for (const k of Object.keys(preset)) base[k] = structuredClone(ui.p[k] ?? ui.defs[k] ?? null);
    active = { name, preset, base };
    amt.disabled = false;
    amtNum.disabled = false;
    amtName.textContent = name;
    list.querySelectorAll('.crp-tile.on').forEach((t) => t.classList.remove('on'));
    tile?.classList.add('on');
    setAmt(100, true);
  };

  const tile = (name, preset, del = null) => {
    const t = h('button.crp-tile', { type: 'button', title: `${name}: 눌러서 적용` });
    const thumb = h('div.crp-thumb');
    t.append(thumb, h('span', name));
    t.addEventListener('click', () => choose(name, preset, t));
    t._fill = () => {
      if (!thumb.firstChild) thumb.append(ui.thumb(preset));
    };
    if (del) {
      const x = h('span.crp-del', { title: '사전 설정 삭제', role: 'button' }, icon('close', 12));
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        del();
      });
      t.append(x);
    }
    return t;
  };
  const folder = (name, items, open = false) => {
    const grid = h('div.crp-grid', ...items);
    const d = h('details.crp-folder', { open }, h('summary', icon('folder', 14), h('span', name), h('span.note', String(items.length))), grid);
    const fill = () => items.forEach((t) => t._fill?.());
    d.addEventListener('toggle', () => d.open && fill());
    if (open) setTimeout(fill, 0);
    return d;
  };

  const list = h('div.crp-list');
  const build = () => {
    const mine = userPresets();
    const userItems = mine.map((u, i) => tile(u.name, u.values, () => {
      const all = userPresets();
      all.splice(i, 1);
      saveUserPresets(all);
      build();
    }));
    list.replaceChildren(
      ...(userItems.length ? [folder('사용자 사전 설정', userItems, true)] : []),
      ...CR_PRESETS.map(([f, items], i) => folder(f, items.map(([n, v]) => tile(n, v)), i === 0 && !userItems.length)));
  };
  build();

  const makeBtn = h('button.small', { type: 'button', title: '지금 설정을 사전 설정으로 저장합니다' }, icon('plus', 14), ' 사전 설정 만들기');
  makeBtn.addEventListener('click', async () => {
    const name = ((await promptDialog('사전 설정 만들기', '이름', `사전 설정 ${userPresets().length + 1}`)) || '').trim();
    if (!name) return;
    const values = ui.current();
    if (!Object.keys(values).length) return toast('바꾼 설정이 없어 저장할 것이 없습니다');
    const all = userPresets();
    all.unshift({ name, values });
    if (!saveUserPresets(all)) return toast('이 브라우저에 저장하지 못했습니다');
    build();
    toast(`사전 설정 "${name}"을(를) 저장했습니다`);
  });

  const el = h('div.crp',
    h('div.cr-line', makeBtn),
    h('div.crp-amount', h('div.cr-line', h('b', '양'), amtName), h('label.cr-row', h('span', '양'), amt, amtNum)),
    list,
    h('div.note', '사전 설정은 그 안에 든 설정만 바꿉니다. 양을 0~200으로 움직여 세기를 고릅니다.'));
  return { el, reset: () => { active = null; amt.disabled = true; amtNum.disabled = true; amtName.textContent = '사전 설정을 고르세요'; } };
}

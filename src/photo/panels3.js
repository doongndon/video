// More Photoshop panels: Swatches (groups, Photoshop .aco / .ase, GIMP .gpl, colours from the picture),
// Glyphs (special characters into text), Adjustments (one-click adjustment layers and looks), Tool
// Presets, and the frame animation Timeline (frames, tweening, playback, animated GIF).

import { h, downloadBlob } from '../util.js';
import { toast, showMenu, promptDialog, confirmDialog, openModal, formRow, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { ADJUSTMENTS, defaultParams } from './adjust.js';
import { TOOL_BY_ID } from './tools.js';
import { makeCanvas, newLayer } from './doc.js';
import { medianCut, encodeIndexedGif } from '../gif.js';

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hexRgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const menuAt = (e, items) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 2);
};
/** Long press on touch screens does what right-click does. */
function onContext(el, fn) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fn(e.clientX, e.clientY);
  });
  let t = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    t = setTimeout(() => {
      t = null;
      el.dataset.longpress = '1';
      fn(e.clientX, e.clientY);
    }, 550);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointermove']) el.addEventListener(ev, () => clearTimeout(t));
}

// ---------------------------------------------------------------- colour conversions (swatch files)

function hsbRgb(hh, s, v) {
  const f = (n) => {
    const k = (n + hh / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
const cmykRgb = (c, m, y, k) => [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
function labRgb(L, a, b) {
  // CIELAB (D65) → sRGB
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = 1 * f(y);
  z = 1.08883 * f(z);
  const lin = [x * 3.2406 + y * -1.5372 + z * -0.4986, x * -0.9689 + y * 1.8758 + z * 0.0415, x * 0.0557 + y * -0.204 + z * 1.057];
  return lin.map((v) => 255 * (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v));
}

/** Photoshop swatches (.aco): version 1 (colours) and version 2 (colours with names). */
export function parseAco(buf) {
  const dv = new DataView(buf);
  let o = 0;
  const u16 = () => {
    const v = dv.getUint16(o);
    o += 2;
    return v;
  };
  const read = (ver) => {
    const n = u16();
    const out = [];
    for (let i = 0; i < n; i++) {
      const space = u16();
      const w = u16();
      const x = u16();
      const y = u16();
      const z = u16();
      let name = '';
      if (ver === 2) {
        const len = dv.getUint32(o);
        o += 4;
        for (let k = 0; k < len; k++) {
          const ch = u16();
          if (ch) name += String.fromCharCode(ch);
        }
      }
      let rgb = null;
      if (space === 0) rgb = [w / 257, x / 257, y / 257];
      else if (space === 1) rgb = hsbRgb((w / 65535) * 360, x / 65535, y / 65535);
      else if (space === 2) rgb = cmykRgb(1 - w / 65535, 1 - x / 65535, 1 - y / 65535, 1 - z / 65535);
      else if (space === 7) rgb = labRgb(w / 100, (x << 16 >> 16) / 100, (y << 16 >> 16) / 100);
      else if (space === 8) rgb = [255 - (w / 10000) * 255, 255 - (w / 10000) * 255, 255 - (w / 10000) * 255].map((v) => 255 - v);
      else if (space === 9) rgb = cmykRgb(w / 10000, x / 10000, y / 10000, z / 10000);
      if (rgb) out.push({ c: rgbHex(...rgb), n: name });
    }
    return out;
  };
  const v = u16();
  let list = read(v);
  if (v === 1 && o + 4 <= dv.byteLength) {
    const v2 = u16();
    if (v2 === 2) list = read(2);
  }
  return list;
}

/** Adobe Swatch Exchange (.ase): groups of named colours. */
export function parseAse(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'ASEF') throw new Error('ASE 파일이 아닙니다');
  let o = 8;
  const blocks = dv.getUint32(o);
  o += 4;
  const groups = [];
  let cur = null;
  const name = () => {
    const len = dv.getUint16(o);
    o += 2;
    let s = '';
    for (let k = 0; k < len; k++) {
      const ch = dv.getUint16(o);
      o += 2;
      if (ch) s += String.fromCharCode(ch);
    }
    return s;
  };
  for (let i = 0; i < blocks && o < dv.byteLength; i++) {
    const type = dv.getUint16(o);
    const len = dv.getUint32(o + 2);
    const start = o + 6;
    o = start;
    if (type === 0xc001) {
      cur = { name: name() || '그룹', colors: [] };
      groups.push(cur);
    } else if (type === 0xc002) cur = null;
    else if (type === 0x0001) {
      const n = name();
      const model = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)).trim();
      o += 4;
      const f = (k) => dv.getFloat32(o + k * 4);
      let rgb = null;
      if (model === 'RGB') rgb = [f(0) * 255, f(1) * 255, f(2) * 255];
      else if (model === 'CMYK') rgb = cmykRgb(f(0), f(1), f(2), f(3));
      else if (model === 'LAB') rgb = labRgb(f(0) <= 1 ? f(0) * 100 : f(0), f(1), f(2));
      else if (model === 'Gray') rgb = [f(0) * 255, f(0) * 255, f(0) * 255];
      if (rgb) {
        if (!cur) {
          cur = { name: '가져온 색', colors: [] };
          groups.push(cur);
        }
        cur.colors.push({ c: rgbHex(...rgb), n });
      }
    }
    o = start + len;
  }
  return groups.filter((g) => g.colors.length);
}

/** GIMP palettes (.gpl) and plain lists of #hex colours. */
export function parseTextPalette(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(.*)$/);
    if (m) out.push({ c: rgbHex(+m[1], +m[2], +m[3]), n: m[4].trim() });
    else for (const hx of line.match(/#?\b[0-9a-f]{6}\b/gi) || []) out.push({ c: `#${hx.replace('#', '').toLowerCase()}`, n: '' });
  }
  return out;
}

/** Photoshop .aco (version 1 + 2, so names survive). */
export function acoBytes(colors) {
  const parts = [];
  const u16 = (v) => parts.push((v >> 8) & 255, v & 255);
  for (const ver of [1, 2]) {
    u16(ver);
    u16(colors.length);
    for (const s of colors) {
      const [r, g, b] = hexRgb(s.c);
      u16(0);
      u16(r * 257);
      u16(g * 257);
      u16(b * 257);
      u16(0);
      if (ver === 2) {
        const nm = s.n || s.c;
        const len = nm.length + 1;
        u16(0);
        u16(len);
        for (const ch of nm) u16(ch.charCodeAt(0));
        u16(0);
      }
    }
  }
  return new Uint8Array(parts);
}

// ---------------------------------------------------------------- swatches

const BASIC = ['#000000', '#ffffff', '#7f7f7f', '#c0c0c0', '#ff0000', '#ff7f00', '#ffd400', '#7fd400', '#00b050', '#00b0b0', '#0070c0', '#3a3aff', '#7030a0', '#ff4fa3', '#8b4513', '#f5deb3', '#ffe680', '#a8e6ff', '#2b2b2b', '#e8eaed'];
const DEFAULT_SWATCHES = () => [
  { name: '기본', colors: BASIC.map((c) => ({ c, n: '' })) },
  { name: '파스텔', colors: ['#ffd1dc', '#ffe5b4', '#fff5ba', '#d4f0c0', '#b5ead7', '#c1e7e3', '#c7d8f5', '#c7ceea', '#dcc6f0', '#f5c6e0', '#f8e1d4', '#e2f0cb'].map((c) => ({ c, n: '' })) },
  { name: '자연', colors: ['#2e4a2f', '#4f7942', '#8fbc8f', '#c2b280', '#8b5a2b', '#d2a679', '#87ceeb', '#4682b4', '#f4a460', '#b22222', '#556b2f', '#deb887'].map((c) => ({ c, n: '' })) },
  { name: '회색', colors: ['#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666', '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6', '#ffffff'].map((c) => ({ c, n: '' })) },
];

export function buildSwatchesPanel(P) {
  let groups = loadPref('photo.swatches', null) || DEFAULT_SWATCHES();
  const save = () => savePref('photo.swatches', groups);
  const list = h('div.ph-swlist');
  const mine = () => {
    let g = groups.find((x) => x.mine);
    if (!g) {
      g = { name: '내 견본', mine: true, colors: [] };
      groups.unshift(g);
    }
    return g;
  };
  const addGroup = (name, colors) => {
    groups.push({ name, colors });
    save();
    render();
  };
  const importFiles = async () => {
    const { pickFiles } = await import('../ui/project-panel.js');
    const files = await pickFiles({ accept: '.aco,.ase,.gpl,.txt,.hex,.css', multiple: true });
    for (const f of files) {
      try {
        const ext = f.name.toLowerCase().split('.').pop();
        const base = f.name.replace(/\.[^.]+$/, '');
        if (ext === 'aco') addGroup(base, parseAco(await f.arrayBuffer()));
        else if (ext === 'ase') for (const g of parseAse(await f.arrayBuffer())) addGroup(g.name || base, g.colors);
        else {
          const cs = parseTextPalette(await f.text());
          if (!cs.length) throw new Error('empty');
          addGroup(base, cs);
        }
        toast(`견본을 가져왔습니다: ${f.name}`);
      } catch {
        toast(`${f.name}: 견본 파일로 읽을 수 없습니다`);
      }
    }
  };
  const all = () => groups.flatMap((g) => g.colors);
  /** The picture's main colours (median cut) as a new group. */
  const fromPicture = (n) => {
    if (!P.doc) return toast('문서가 없습니다');
    const c = P.viewSource ? P.viewSource(Math.min(1, 512 / Math.max(P.doc.width, P.doc.height))) : P.composite();
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const step = Math.max(1, Math.floor((c.width * c.height) / 20000));
    const s = [];
    for (let i = 0; i < c.width * c.height; i += step) if (d[i * 4 + 3] > 128) s.push(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    if (!s.length) return toast('보이는 색이 없습니다');
    const pal = medianCut(new Uint8Array(s), n).sort((a, b) => (a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11) - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11));
    addGroup(`${P.doc.name} 색 (${pal.length})`, pal.map((rgb) => ({ c: rgbHex(...rgb), n: '' })));
    return undefined;
  };
  const exportAs = (kind) => {
    const cs = all();
    if (!cs.length) return toast('견본이 없습니다');
    if (kind === 'aco') downloadBlob(new Blob([acoBytes(cs)], { type: 'application/octet-stream' }), 'Montage 견본.aco');
    else {
      const text = `GIMP Palette\nName: Montage\nColumns: 8\n#\n${cs.map((s) => `${hexRgb(s.c).map((v) => String(v).padStart(3)).join(' ')}\t${s.n || s.c}`).join('\n')}\n`;
      downloadBlob(new Blob([text], { type: 'text/plain' }), 'Montage 견본.gpl');
    }
    return undefined;
  };
  const swatchMenu = (g, s, x, y) => showMenu([
    { label: '전경색으로', action: () => P.setColor(s.c, false) },
    { label: '배경색으로', action: () => P.setColor(s.c, true) },
    { label: '이름 바꾸기…', action: async () => { const v = await promptDialog('견본 이름', '이름', s.n || ''); if (v != null) { s.n = v.trim(); save(); render(); } } },
    { label: '삭제', action: () => { g.colors = g.colors.filter((x) => x !== s); save(); render(); } },
  ], x, y);
  const groupMenu = (g, x, y) => showMenu([
    { label: '그룹 이름 바꾸기…', action: async () => { const v = await promptDialog('그룹 이름', '이름', g.name); if (v?.trim()) { g.name = v.trim(); save(); render(); } } },
    { label: '전경색을 이 그룹에 추가', action: () => { g.colors.push({ c: P.fg, n: '' }); save(); render(); } },
    { label: '그룹 삭제', action: async () => { if (await confirmDialog('그룹 삭제', `"${g.name}" 그룹과 견본 ${g.colors.length}개를 지울까요?`)) { groups = groups.filter((x) => x !== g); save(); render(); } } },
  ], x, y);
  const render = () => {
    list.replaceChildren(...groups.map((g) => {
      const head = h('div.ph-swhead', { title: '오른쪽 클릭: 그룹 메뉴' }, h('button.ph-twist', { 'aria-expanded': String(!g.closed), onclick: () => { g.closed = !g.closed; save(); render(); } }, g.closed ? '▸' : '▾'), h('span', g.name), h('small', ` ${g.colors.length}`));
      onContext(head, (x, y) => groupMenu(g, x, y));
      const grid = g.closed ? null : h('div.ph-swatches', g.colors.map((s) => {
        const b = h('button.ph-swatch', { style: { background: s.c }, title: `${s.n ? `${s.n} · ` : ''}${s.c}\n클릭: 전경색 · Ctrl+클릭: 배경색 · Alt+클릭: 삭제`, 'aria-label': s.n || s.c });
        b.addEventListener('click', (e) => {
          if (b.dataset.longpress) return void delete b.dataset.longpress;
          if (e.altKey) {
            g.colors = g.colors.filter((x) => x !== s);
            save();
            render();
          } else P.setColor(s.c, e.ctrlKey || e.metaKey);
        });
        onContext(b, (x, y) => swatchMenu(g, s, x, y));
        return b;
      }));
      return h('div.ph-swgroup', head, grid);
    }));
  };
  const bar = h('div.ph-swbar',
    h('button.small', { title: '지금 전경색을 "내 견본"에 추가', onclick: () => { mine().colors.push({ c: P.fg, n: '' }); save(); render(); } }, icon('plus', 13), ' 전경색 추가'),
    h('button.small', { onclick: (e) => menuAt(e, [8, 12, 16, 24].map((n) => ({ label: `${n}색`, action: () => fromPicture(n) }))) }, '사진에서 색 뽑기 ▾'),
    h('button.small', { 'aria-label': '견본 메뉴', onclick: (e) => menuAt(e, [
      { label: '견본 가져오기… (.aco · .ase · .gpl · .txt)', action: importFiles },
      { label: '포토샵 견본으로 내보내기 (.aco)', action: () => exportAs('aco') },
      { label: 'GIMP 팔레트로 내보내기 (.gpl)', action: () => exportAs('gpl') },
      '-',
      { label: '새 그룹…', action: async () => { const v = await promptDialog('새 견본 그룹', '이름', '새 그룹'); if (v?.trim()) addGroup(v.trim(), []); } },
      { label: '기본 견본으로 되돌리기', action: async () => { if (await confirmDialog('견본 되돌리기', '추가하거나 가져온 견본을 모두 지우고 기본 견본으로 되돌릴까요?')) { groups = DEFAULT_SWATCHES(); save(); render(); } } },
    ]) }, '⋯'));
  render();
  return h('div.ph-panel.swatchesp', bar, list, h('div.note', '클릭: 전경색 · Ctrl+클릭: 배경색 · Alt+클릭: 삭제 · 오른쪽 클릭(길게 누르기): 메뉴'));
}

// ---------------------------------------------------------------- glyphs

export const GLYPHS = [
  ['자주 쓰는 기호', '※ ★ ☆ ♥ ♡ ♪ ♫ ✓ ✔ ✕ ✗ • · … ° ℃ ℉ ％ ‰ © ® ™ § ¶ † ‡ № ☎ ✉ ☀ ☁ ☂ ☃ ✈ ☺ ✿ ❀ ❝ ❞'],
  ['화살표', '← → ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ⇐ ⇒ ⇑ ⇓ ⇔ ➜ ➔ ➤ ➡ ⬅ ⬆ ⬇ ↻ ↺ ▶ ◀ ▲ ▼ ▷ ◁ △ ▽ ▸ ◂'],
  ['도형', '■ □ ▪ ▫ ● ○ ◎ ◉ ◆ ◇ ◈ ▣ ◐ ◑ ♠ ♤ ♣ ♧ ♦ ♢ ▢ ▤ ▥ ▦ ▧ ▨ ▩ ⬛ ⬜ ◼ ◻'],
  ['괄호 · 문장 부호', '「 」 『 』 【 】 〔 〕 《 》 〈 〉 “ ” ‘ ’ « » ‹ › – — ― ¡ ¿ ‽ ⁂ 〃 ‥ ¨ ˝'],
  ['번호', '① ② ③ ④ ⑤ ⑥ ⑦ ⑧ ⑨ ⑩ ⑪ ⑫ ⑬ ⑭ ⑮ ⑴ ⑵ ⑶ ⑷ ⑸ ㉠ ㉡ ㉢ ㉣ ㉤ ㉮ ㉯ ㉰ ㈀ ㈁ ㈂ Ⅰ Ⅱ Ⅲ Ⅳ Ⅴ Ⅵ Ⅶ Ⅷ Ⅸ Ⅹ ⅰ ⅱ ⅲ ⅳ ⅴ'],
  ['분수 · 첨자', '½ ⅓ ⅔ ¼ ¾ ⅛ ⅜ ⅝ ⅞ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁰ ⁺ ⁻ ⁿ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉'],
  ['수학', '± × ÷ ≠ ≈ ≡ ≤ ≥ ∞ √ ∑ ∏ ∫ ∮ ∂ ∆ ∇ ∈ ∉ ⊂ ⊃ ⊆ ⊇ ∪ ∩ ∧ ∨ ¬ ∀ ∃ ∴ ∵ ∠ ⊥ ∥ π µ Ω ‰'],
  ['통화 · 단위', '₩ $ € £ ¥ ¢ ₿ ₹ ₽ ฿ ㎜ ㎝ ㎞ ㎡ ㎥ ㎏ ㎖ ㎗ ℓ ㏄ ㎐ ㎑ ㎒ ㎾ ㏈'],
  ['그리스 문자', 'α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω Α Β Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω'],
  ['그림 문자 (글꼴에 따라 다름)', '😀 😂 😊 😍 🥰 😎 🤔 😭 👍 👏 🙏 💪 🎉 ✨ 🔥 💯 ❤️ 💙 💚 🌸 🌈 ⭐ 🌙 ☕ 🍰 🎂 📷 🎵 📌 ✅ ❌ ⚠️'],
];

export function installGlyphs(P) {
  let recent = loadPref('photo.glyphs.recent', []);
  /** Type a character: into the text being edited, the picked text layer, or the clipboard. */
  P.insertGlyph = (ch) => {
    recent = [ch, ...recent.filter((x) => x !== ch)].slice(0, 24);
    savePref('photo.glyphs.recent', recent);
    P.emit('glyphs');
    const ta = P.editingText && document.querySelector('.ph-textedit textarea');
    if (ta) {
      const a = ta.selectionStart ?? ta.value.length;
      const b = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ch + ta.value.slice(b);
      ta.selectionStart = ta.selectionEnd = a + ch.length;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      return;
    }
    const l = P.doc?.active;
    if (l?.kind === 'text') {
      P.run('글리프 넣기', () => {
        l.text = { ...l.text, content: l.text.content + ch };
        P.doc.touch(l);
      });
      return;
    }
    navigator.clipboard?.writeText(ch).then(() => toast(`"${ch}" 복사함 — 글자를 입력할 때 붙여 넣으세요`), () => toast('글자 레이어를 고르거나 글자를 입력하는 중에 누르세요'));
  };
  const grid = (chars) => h('div.ph-glyphs', chars.map((ch) => {
    const b = h('button.ph-glyph', { title: `${ch}  U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` }, ch);
    // keep the text box focused (and its caret) while picking
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => P.insertGlyph(ch));
    return b;
  }));
  const split = (s) => [...s.split(' ')].filter(Boolean);
  P.buildGlyphGrid = (compact = false) => {
    const box = h('div.ph-glyphbox');
    let cat = loadPref('photo.glyphs.cat', 0);
    const render = () => {
      const sel = h('select', { 'aria-label': '글리프 분류' }, GLYPHS.map(([name], i) => h('option', { value: i, selected: i === cat }, name)));
      sel.addEventListener('change', () => {
        cat = +sel.value;
        savePref('photo.glyphs.cat', cat);
        render();
      });
      box.replaceChildren(...[sel, recent.length && !compact ? h('div.ph-sub', '최근') : null, recent.length && !compact ? grid(recent) : null, grid(split(GLYPHS[cat][1]))].filter(Boolean));
    };
    P.on('glyphs', () => box.isConnected && render());
    render();
    return box;
  };
  /** The "기호" button in the text box: a small glyph grid under the text field. */
  P.toggleGlyphs = (ta) => {
    const host = ta?.parentElement;
    if (!host) return;
    const old = host.querySelector('.ph-glyphbox');
    if (old) return void old.remove();
    host.append(P.buildGlyphGrid(true));
  };
}

export function buildGlyphsPanel(P) {
  return h('div.ph-panel.glyphsp', h('div.note', '글자를 입력하는 중이면 커서 자리에, 글자 레이어를 골랐으면 끝에 넣습니다. 아니면 클립보드에 복사합니다.'), P.buildGlyphGrid());
}

// ---------------------------------------------------------------- adjustments

const LOOKS = [
  ['따뜻하게', [['photoFilter', { color: '#ec8a00', density: 25 }]]],
  ['차갑게', [['photoFilter', { color: '#0b6bff', density: 22 }]]],
  ['선명한 색', [['vibrance', { vibrance: 45, saturation: 8 }]]],
  ['흑백 (고대비)', [['bw', {}], ['brightness', { contrast: 35 }]]],
  ['세피아', [['gradientMap', { from: '#2a1a0d', to: '#f6e4c4' }]]],
  ['빈티지', [['vibrance', { vibrance: -35, saturation: -10 }], ['photoFilter', { color: '#c8963e', density: 30 }], ['brightness', { brightness: 8, contrast: -18 }]]],
  ['어둡고 차분하게', [['exposure', { exposure: -0.45, gamma: 0.95 }], ['vibrance', { vibrance: -15 }]]],
  ['밝고 화사하게', [['exposure', { exposure: 0.35 }], ['vibrance', { vibrance: 25 }]]],
];

export function buildAdjustmentsPanel(P) {
  const addLook = (name, items) => {
    if (!P.doc) return toast('문서가 없습니다');
    P.run(`룩: ${name}`, () => {
      for (const [type, params] of items) {
        const l = newLayer('adjust', { name: `${name} · ${ADJUSTMENTS[type].name}`, adjust: { type, params: { ...defaultParams(type), ...params } } });
        P.doc.addMask(l, 'white', !!P.doc.selection);
        P.addLayer(l);
      }
    });
    return undefined;
  };
  const types = Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'desaturate');
  return h('div.ph-panel.adjp',
    h('div.ph-sub', '조정 레이어 추가 (원본은 그대로)'),
    h('div.ph-adjgrid', types.map(([k, a]) => h('button.small', { onclick: () => (P.doc ? P.cmd.newAdjustLayer(k) : toast('문서가 없습니다')) }, a.name))),
    h('div.ph-sub', '칠 레이어'),
    h('div.ph-adjgrid', [['solid', '단색'], ['gradient', '그레이디언트'], ['pattern', '패턴']].map(([k, n]) => h('button.small', { onclick: () => (P.doc ? P.dialogs.fillLayerDialog(P, k) : toast('문서가 없습니다')) }, n))),
    h('div.ph-sub', '빠른 룩 (조정 레이어 묶음, 지우면 원래대로)'),
    h('div.ph-adjgrid', LOOKS.map(([n, items]) => h('button.small', { onclick: () => addLook(n, items) }, n))));
}

// ---------------------------------------------------------------- tool presets

const DEFAULT_PRESETS = () => [
  { name: '부드러운 큰 브러시', tool: 'brush', opts: { size: 150, hardness: 0, opacity: 100, flow: 40 } },
  { name: '단단한 작은 브러시', tool: 'brush', opts: { size: 8, hardness: 100, opacity: 100, flow: 100 } },
  { name: '픽셀 연필 1px', tool: 'pencil', opts: { size: 1 } },
  { name: '부드러운 지우개', tool: 'eraser', opts: { size: 90, hardness: 0 } },
  { name: '제목 글자 (굵게 96px)', tool: 'text', opts: { size: 96, bold: true } },
  { name: '본문 글자 (32px)', tool: 'text', opts: { size: 32, bold: false } },
  { name: '살짝 밝게 (닷지 20%)', tool: 'dodge', opts: { size: 120, strength: 20, range: 'midtones' } },
  { name: '채도 빼기 (스펀지)', tool: 'sponge', opts: { size: 120, strength: 40, mode: 'desaturate' } },
];

export function buildToolPresetsPanel(P) {
  let presets = loadPref('photo.toolPresets', null) || DEFAULT_PRESETS();
  let onlyCurrent = loadPref('photo.toolPresets.only', false);
  const save = () => savePref('photo.toolPresets', presets);
  const list = h('div.ph-tplist');
  P.applyToolPreset = (p) => {
    if (!TOOL_BY_ID[p.tool]) return toast('이 도구가 없습니다');
    P.setTool(p.tool);
    const keys = new Set(TOOL_BY_ID[p.tool].options.map((o) => o[0]));
    for (const [k, v] of Object.entries(p.opts)) if (keys.has(k)) P.setOpt(p.tool, k, v);
    toast(`도구 사전 설정: ${p.name}`);
    return undefined;
  };
  const render = () => {
    const shown = presets.filter((p) => TOOL_BY_ID[p.tool] && (!onlyCurrent || p.tool === P.tool));
    list.replaceChildren(...shown.map((p) => {
      const t = TOOL_BY_ID[p.tool];
      const row = h('button.ph-tprow', { title: `${t.name} · 클릭: 이 설정으로 바꾸기 · 오른쪽 클릭: 메뉴` }, icon(t.icon, 15), h('span', p.name), h('small', t.name));
      row.addEventListener('click', () => {
        if (row.dataset.longpress) return void delete row.dataset.longpress;
        P.applyToolPreset(p);
      });
      onContext(row, (x, y) => showMenu([
        { label: '이름 바꾸기…', action: async () => { const v = await promptDialog('사전 설정 이름', '이름', p.name); if (v?.trim()) { p.name = v.trim(); save(); render(); } } },
        { label: '지금 도구 설정으로 덮어쓰기', disabled: P.tool !== p.tool, action: () => { p.opts = { ...P.opts(p.tool) }; save(); toast('덮어썼습니다'); } },
        { label: '삭제', action: () => { presets = presets.filter((x) => x !== p); save(); render(); } },
      ], x, y));
      return row;
    }));
    if (!shown.length) list.append(h('div.empty-hint', onlyCurrent ? '이 도구의 사전 설정이 없습니다' : '사전 설정이 없습니다'));
  };
  const only = h('input', { type: 'checkbox', checked: onlyCurrent });
  only.addEventListener('change', () => {
    onlyCurrent = only.checked;
    savePref('photo.toolPresets.only', onlyCurrent);
    render();
  });
  P.on('tool', () => list.isConnected && render());
  render();
  return h('div.ph-panel.toolpresetsp',
    h('div.ph-swbar',
      h('button.small', { onclick: async () => {
        const t = TOOL_BY_ID[P.tool];
        const v = await promptDialog('도구 사전 설정 저장', `${t.name}의 지금 설정을 저장합니다. 이름`, `${t.name} 1`);
        if (!v?.trim()) return;
        presets.push({ name: v.trim(), tool: P.tool, opts: { ...P.opts(P.tool) } });
        save();
        render();
      } }, icon('plus', 13), ' 지금 설정 저장'),
      h('label.ph-prow', only, h('span', '지금 도구만'))),
    list);
}

// ---------------------------------------------------------------- timeline (frame animation)

const DELAYS = [[0, '0초'], [0.1, '0.1초'], [0.2, '0.2초'], [0.5, '0.5초'], [1, '1초'], [2, '2초'], [5, '5초'], [10, '10초']];
let frameSeq = 0;
const posOf = (l) => (l.kind === 'smart' ? [l.smart.m[4], l.smart.m[5]] : ['group', 'adjust', 'fill'].includes(l.kind) ? null : [l.x || 0, l.y || 0]);

/** What a frame remembers of every layer: shown, opacity and position. */
export function snapFrameState(d) {
  const st = {};
  for (const l of d.layers) st[l.id] = { v: l.visible !== false, o: l.opacity ?? 1, p: posOf(l) };
  return st;
}

/** Put the layers the way a frame remembers them (layers made later keep their look). */
export function applyFrameState(d, st) {
  for (const l of d.layers) {
    const s = st[l.id];
    if (!s) continue;
    let changed = false;
    if ((l.visible !== false) !== s.v) {
      l.visible = s.v;
      changed = true;
    }
    if (Math.abs((l.opacity ?? 1) - s.o) > 1e-4) {
      l.opacity = s.o;
      changed = true;
    }
    const p = posOf(l);
    if (p && s.p && (Math.abs(p[0] - s.p[0]) > 1e-3 || Math.abs(p[1] - s.p[1]) > 1e-3)) d.translateLayers([l], s.p[0] - p[0], s.p[1] - p[1]);
    else if (changed) {
      l._styled = null;
      d.touch(l);
    }
  }
}

function tweenStates(a, b, t) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!x || !y) {
      out[id] = { ...(x || y) };
      continue;
    }
    // a layer that appears or disappears fades in or out
    const ox = x.v ? x.o : 0;
    const oy = y.v ? y.o : 0;
    const o = ox + (oy - ox) * t;
    out[id] = { v: x.v || y.v, o: x.v && y.v ? x.o + (y.o - x.o) * t : o, p: x.p && y.p ? [x.p[0] + (y.p[0] - x.p[0]) * t, x.p[1] + (y.p[1] - x.p[1]) * t] : x.p || y.p };
  }
  return out;
}

export function buildTimelinePanel(P) {
  const el = h('div.ph-panel.timelinep');
  let playing = null;
  let applying = false;
  const thumbs = new Map();
  const d = () => P.doc;
  const frames = () => d()?.frames || [];
  const cur = () => Math.min(frames().length - 1, Math.max(0, d()?.frameIndex || 0));
  const run = (label, fn) => P.run(label, fn);

  /** Show frame i: the layers take its state (not a history step, like Photoshop). */
  const go = (i) => {
    const doc = d();
    if (!doc?.frames?.length) return;
    doc.frameIndex = Math.max(0, Math.min(doc.frames.length - 1, i));
    applying = true;
    applyFrameState(doc, doc.frames[doc.frameIndex].state);
    applying = false;
    P.emit('layers');
    P.redraw();
    render();
  };
  // after a change (moving, hiding, fading a layer), the current frame remembers it
  P.on('history', () => {
    const doc = d();
    if (applying || playing || !doc?.frames?.length) return;
    const i = cur();
    doc.frames = doc.frames.map((f, k) => (k === i ? { ...f, state: snapFrameState(doc) } : f));
    render();
  });
  // a small picture of the frame on screen
  P.on('redraw', () => {
    const doc = d();
    if (!doc?.frames?.length || !el.isConnected) return;
    const f = doc.frames[cur()];
    const k = `${f.id}`;
    const src = P.viewSource ? P.viewSource(96 / Math.max(doc.width, doc.height)) : null;
    if (!src) return;
    let t = thumbs.get(k);
    const w = Math.max(1, Math.round((src.width / Math.max(src.width, src.height)) * 64));
    const hh = Math.max(1, Math.round((src.height / Math.max(src.width, src.height)) * 64));
    if (!t) {
      t = makeCanvas(w, hh);
      thumbs.set(k, t);
    }
    if (t.width !== w || t.height !== hh) {
      t.width = w;
      t.height = hh;
    }
    const g = t.getContext('2d');
    g.clearRect(0, 0, w, hh);
    g.drawImage(src, 0, 0, w, hh);
    const shown = el.querySelector(`canvas[data-frame="${k}"]`);
    if (shown && shown !== t) shown.replaceWith(t);
    t.dataset.frame = k;
  });

  const create = () => {
    const doc = d();
    if (!doc) return toast('문서가 없습니다');
    run('타임라인 만들기', () => {
      doc.frames = [{ id: ++frameSeq + Date.now(), delay: 0.5, state: snapFrameState(doc) }];
      doc.frameIndex = 0;
      doc.frameLoop = doc.frameLoop ?? 0;
    });
    render();
    return undefined;
  };
  const duplicate = () => {
    const doc = d();
    const i = cur();
    const f = doc.frames[i];
    const copy = { ...f, id: ++frameSeq + Date.now(), state: snapFrameState(doc) };
    run('프레임 복제', () => {
      doc.frames = [...doc.frames.slice(0, i + 1), copy, ...doc.frames.slice(i + 1)];
      doc.frameIndex = i + 1;
    });
    const t = thumbs.get(`${f.id}`);
    if (t) {
      const c = makeCanvas(t.width, t.height);
      c.getContext('2d').drawImage(t, 0, 0);
      thumbs.set(`${copy.id}`, c);
    }
    render();
  };
  const remove = () => {
    const doc = d();
    if (doc.frames.length <= 1) {
      run('타임라인 지우기', () => {
        doc.frames = [];
        doc.frameIndex = 0;
      });
      render();
      return;
    }
    const i = cur();
    run('프레임 삭제', () => {
      doc.frames = doc.frames.filter((_, k) => k !== i);
    });
    go(Math.min(i, doc.frames.length - 1));
  };
  const tween = async () => {
    const doc = d();
    const i = cur();
    if (doc.frames.length < 2) return toast('트윈하려면 프레임이 두 개 이상 있어야 합니다');
    const nIn = h('input', { type: 'number', min: 1, max: 60, value: 5, style: { width: '70px' } });
    const withSel = h('select', h('option', { value: 'next' }, '다음 프레임'), h('option', { value: 'prev' }, '이전 프레임'));
    if (i === doc.frames.length - 1) withSel.value = 'prev';
    openModal({
      title: '트윈 (사이 프레임 만들기)',
      body: [formRow('사이에 넣을 프레임 수', nIn), formRow('지금 프레임과', withSel), h('div.note', '위치와 불투명도가 조금씩 바뀌는 프레임을 만듭니다. 나타나거나 사라지는 레이어는 서서히 나타나고 사라집니다.')],
      buttons: [{ label: '취소' }, { label: '만들기', primary: true, action: () => {
        const n = Math.max(1, Math.min(60, Math.round(+nIn.value || 5)));
        const a = withSel.value === 'next' ? i : i - 1;
        if (a < 0 || a + 1 >= doc.frames.length) return toast('그쪽에는 프레임이 없습니다');
        const A = doc.frames[a];
        const B = doc.frames[a + 1];
        const mid = Array.from({ length: n }, (_, k) => ({ id: ++frameSeq + Date.now(), delay: A.delay, state: tweenStates(A.state, B.state, (k + 1) / (n + 1)) }));
        run('트윈', () => {
          doc.frames = [...doc.frames.slice(0, a + 1), ...mid, ...doc.frames.slice(a + 1)];
        });
        go(a + 1);
        return undefined;
      } }],
    });
    return undefined;
  };
  /** One frame per top layer, each showing the bottom layer plus that layer (Make Frames From Layers). */
  const fromLayers = () => {
    const doc = d();
    if (!doc) return toast('문서가 없습니다');
    const tops = doc.layers.filter((l) => !l.parent);
    if (tops.length < 2) return toast('맨 아래 레이어 말고 레이어가 하나 이상 더 있어야 합니다');
    const base = tops[0];
    const now = snapFrameState(doc);
    const list = tops.slice(1).map((l) => {
      const st = {};
      for (const [id, s] of Object.entries(now)) {
        const top = doc.layer(id);
        const topId = top && (doc.ancestors(top).pop()?.id || top.id);
        st[id] = { ...s, v: topId === base.id || topId === l.id ? (doc.layer(id).parent ? s.v : true) : doc.layer(id).parent ? s.v : false };
      }
      return { id: ++frameSeq + Date.now(), delay: 0.5, state: st };
    });
    run('레이어로 프레임 만들기', () => {
      doc.frames = list;
      doc.frameIndex = 0;
      doc.frameLoop = doc.frameLoop ?? 0;
    });
    go(0);
    return undefined;
  };
  const stop = () => {
    if (!playing) return;
    clearTimeout(playing.timer);
    const { back, doc } = playing;
    playing = null;
    // back to the frame shown before playing (only on that document: the user may have switched tabs)
    if (doc === d()) go(back);
  };
  const play = () => {
    const doc = d();
    if (!doc?.frames?.length) return;
    if (playing) return stop();
    playing = { back: cur(), loops: 0, doc };
    let i = cur();
    const step = () => {
      if (!playing || P.doc !== doc) return void (playing = null);
      applying = true;
      doc.frameIndex = i;
      applyFrameState(doc, doc.frames[i].state);
      applying = false;
      P.redraw();
      highlight();
      const delay = Math.max(0.03, doc.frames[i].delay || 0.1);
      i++;
      if (i >= doc.frames.length) {
        i = 0;
        playing.loops++;
        if (doc.frameLoop && playing.loops >= doc.frameLoop) {
          playing.timer = setTimeout(stop, delay * 1000);
          return;
        }
      }
      playing.timer = setTimeout(step, delay * 1000);
    };
    render();
    step();
    return undefined;
  };
  P.timelinePlay = play;

  /** The frames as an animated GIF (one shared palette; see-through kept). */
  const exportGif = async ({ scale = 1, loop = 0 } = {}) => {
    const doc = d();
    const saved = doc.capture();
    const W = Math.max(1, Math.round(doc.width * scale));
    const H = Math.max(1, Math.round(doc.height * scale));
    const full = makeCanvas(doc.width, doc.height);
    const small = makeCanvas(W, H);
    const sg = small.getContext('2d');
    const rgba = [];
    try {
      applying = true;
      for (const f of doc.frames) {
        applyFrameState(doc, f.state);
        const fg = full.getContext('2d');
        fg.clearRect(0, 0, full.width, full.height);
        doc.render(fg, { fg: P.fg, bg: P.bg });
        sg.clearRect(0, 0, W, H);
        sg.imageSmoothingQuality = 'high';
        sg.drawImage(full, 0, 0, W, H);
        rgba.push(sg.getImageData(0, 0, W, H).data);
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      doc.restore(saved);
      applying = false;
      P.redraw();
    }
    // a palette from all frames, then each pixel's nearest colour (index 255 = see-through)
    const want = 30000;
    const per = Math.max(1, Math.floor(want / rgba.length));
    const s = [];
    let clear = false;
    for (const px of rgba) {
      const stepPx = Math.max(1, Math.floor((W * H) / per));
      for (let p = 0; p < W * H; p += stepPx) {
        const i = p * 4;
        if (px[i + 3] < 128) {
          clear = true;
          continue;
        }
        s.push(px[i], px[i + 1], px[i + 2]);
      }
      if (!clear) for (let p = 0; p < W * H; p += 7) if (px[p * 4 + 3] < 128) { clear = true; break; }
    }
    const pal = s.length ? medianCut(new Uint8Array(s), clear ? 255 : 256) : [[0, 0, 0]];
    const T = clear ? pal.length : -1;
    const palette = [...pal];
    if (clear) palette.push([0, 0, 0]);
    const cache = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (cache[key] >= 0) return cache[key];
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < pal.length; k++) {
        const c = pal[k];
        const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      }
      cache[key] = best;
      return best;
    };
    const frames = rgba.map((px, fi) => {
      const idx = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) idx[p] = clear && px[p * 4 + 3] < 128 ? T : nearest(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]);
      return { indices: idx, delay: Math.round((doc.frames[fi].delay || 0) * 100) };
    });
    return encodeIndexedGif(frames, palette, W, H, { transparent: T, loop: loop === 1 ? null : loop === 0 ? 0 : loop - 1 });
  };
  const exportDialog = () => {
    const doc = d();
    if (!doc?.frames?.length) return toast('타임라인에 프레임이 없습니다');
    const size = h('select', [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%']].map(([v, n]) => h('option', { value: v }, `${n} (${Math.round(doc.width * v)}×${Math.round(doc.height * v)})`)));
    if (doc.width * doc.height > 1.5e6) size.value = '0.5';
    const loop = h('select', [[0, '계속 반복'], [1, '한 번만'], [3, '3번']].map(([v, n]) => h('option', { value: v, selected: v === (doc.frameLoop || 0) }, n)));
    openModal({
      title: '애니메이션 GIF로 내보내기',
      body: [formRow('크기', size), formRow('반복', loop), h('div.note', `프레임 ${doc.frames.length}개 · GIF는 256색까지라 사진은 색이 조금 거칠어질 수 있습니다.`)],
      buttons: [{ label: '취소' }, { label: '내보내기', primary: true, action: async () => {
        toast('GIF를 만드는 중…');
        const blob = await exportGif({ scale: +size.value, loop: +loop.value });
        await downloadBlob(blob, `${doc.name || '애니메이션'}.gif`);
        return undefined;
      } }],
    });
    return undefined;
  };
  P.exportAnimatedGif = exportGif;

  const highlight = () => {
    const i = cur();
    el.querySelectorAll('.ph-frame').forEach((x, k) => x.classList.toggle('on', k === i));
  };
  const render = () => {
    const doc = d();
    if (!doc) return void el.replaceChildren(h('div.empty-hint', '문서가 없습니다'));
    if (!doc.frames?.length) {
      el.replaceChildren(
        h('div.note', '레이어를 보이고 숨기고, 옮기고, 흐리게 하는 것을 프레임마다 다르게 해서 움직이는 GIF를 만듭니다.'),
        h('div.ph-swbar', h('button.primary.small', { onclick: create }, '타임라인 만들기 (첫 프레임)'), h('button.small', { onclick: fromLayers }, '레이어로 프레임 만들기')));
      return;
    }
    const i = cur();
    const loop = h('select', { 'aria-label': '반복', title: '반복' }, [[0, '계속'], [1, '한 번'], [3, '3번']].map(([v, n]) => h('option', { value: v, selected: v === (doc.frameLoop || 0) }, n)));
    loop.addEventListener('change', () => run('반복 설정', () => { doc.frameLoop = +loop.value; }));
    const cards = doc.frames.map((f, k) => {
      const t = thumbs.get(`${f.id}`);
      const pic = t || h('div.ph-frame-ph', String(k + 1));
      if (t) t.dataset.frame = `${f.id}`;
      const delay = h('select.ph-frame-delay', { 'aria-label': '시간', title: '이 프레임을 보여 주는 시간' }, DELAYS.map(([v, n]) => h('option', { value: v, selected: Math.abs(v - (f.delay || 0)) < 1e-6 }, n)));
      if (!DELAYS.some(([v]) => Math.abs(v - (f.delay || 0)) < 1e-6)) delay.prepend(h('option', { value: f.delay, selected: true }, `${f.delay}초`));
      delay.append(h('option', { value: 'other' }, '다른 값…'));
      delay.addEventListener('click', (e) => e.stopPropagation());
      delay.addEventListener('change', async () => {
        let v = delay.value;
        if (v === 'other') v = await promptDialog('프레임 시간', '초', String(f.delay || 0.5));
        const sec = Math.max(0, Math.min(60, +v));
        if (!Number.isFinite(sec)) return render();
        run('프레임 시간', () => { doc.frames = doc.frames.map((x) => (x === f ? { ...x, delay: sec } : x)); });
        render();
        return undefined;
      });
      const card = h(`div.ph-frame${k === i ? '.on' : ''}`, { role: 'button', tabindex: 0, title: `프레임 ${k + 1}` }, h('div.ph-frame-pic', pic), h('div.ph-frame-foot', h('b', String(k + 1)), delay));
      card.addEventListener('click', () => go(k));
      onContext(card, (x, y) => showMenu([
        { label: '이 프레임 복제', action: () => { go(k); duplicate(); } },
        { label: '이 프레임 삭제', action: () => { go(k); remove(); } },
        { label: '모든 프레임에 이 시간 쓰기', action: () => run('프레임 시간', () => { doc.frames = doc.frames.map((x) => ({ ...x, delay: f.delay })); }) },
      ], x, y));
      return card;
    });
    el.replaceChildren(
      h('div.ph-swbar.ph-tlbar',
        h('button.small', { title: '처음 프레임', 'aria-label': '처음 프레임', onclick: () => go(0) }, icon('goIn', 14)),
        h('button.small', { title: '이전 프레임', 'aria-label': '이전 프레임', onclick: () => go(i - 1) }, icon('stepBack', 14)),
        h('button.small', { title: playing ? '정지' : '재생', 'aria-label': playing ? '정지' : '재생', onclick: play }, icon(playing ? 'stop' : 'play', 14)),
        h('button.small', { title: '다음 프레임', 'aria-label': '다음 프레임', onclick: () => go(i + 1) }, icon('stepForward', 14)),
        loop,
        h('button.small', { title: '지금 프레임 복제', onclick: duplicate }, icon('plus', 13), ' 프레임'),
        h('button.small', { onclick: tween }, '트윈…'),
        h('button.small', { title: '지금 프레임 삭제', 'aria-label': '프레임 삭제', onclick: remove }, icon('trash', 13)),
        h('button.small', { 'aria-label': '타임라인 메뉴', onclick: (e) => menuAt(e, [
          { label: '애니메이션 GIF로 내보내기…', action: exportDialog },
          { label: '레이어로 프레임 만들기 (기존 프레임 대신)', action: fromLayers },
          { label: '모든 프레임 지우기', action: () => { run('타임라인 지우기', () => { doc.frames = []; doc.frameIndex = 0; }); render(); } },
        ]) }, '⋯')),
      h('div.ph-frames', cards),
      h('div.note', `프레임 ${i + 1}/${doc.frames.length} · 레이어를 보이기/숨기기·옮기기·불투명도를 바꾸면 지금 프레임에 기억됩니다.`),
      h('button.small', { onclick: exportDialog }, '애니메이션 GIF로 내보내기…'));
  };
  P.on('doc', () => {
    stop();
    render();
  });
  P.on('history', () => !applying && !playing && render());
  render();
  return el;
}

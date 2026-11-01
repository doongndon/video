// The Filter menu and Image ▸ Adjustments laid out like Photoshop's (Korean names, order, separators,
// shortcut labels; the keys themselves are in editor.js's key map), Image Size's resampling methods,
// and the editor API for the dialogs. installFilters(P) runs from editor.js before the menus are built.

import { toast } from '../ui/common.js';
import { FILTERS, ADJUSTMENTS, visibleParams } from './adjust.js';
import * as D from './pdialogs.js';
import { resampleCanvas } from './resample.js';
import { neuralFiltersDialog } from './neural.js';

const FILTER_GROUPS = ['흐림 효과', '흐림 효과 갤러리', '왜곡', '노이즈', '픽셀화', '렌더', '선명 효과', '비디오', '스타일화', '기타'];
// groups that are single items at the top of the menu, or windows of their own
const ROOT_GROUPS = new Set(['Camera Raw', '렌즈 교정', '뉴럴 필터', '필터 갤러리']);
const ADJ_ORDER = [
  ['brightness', 'levels', 'curves', 'exposure'],
  ['vibrance', 'hueSat', 'colorBalance', 'bw', 'photoFilter', 'channelMixer', 'colorLookup'],
  ['invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor'],
  ['shadowsHighlights', 'hdrToning'],
  ['desaturate', 'matchColor', 'replaceColor', 'equalize'],
];
const ADJ_KEYS = { levels: 'L', curves: 'M', hueSat: 'U', colorBalance: 'B', bw: 'Alt+Shift+B', invert: 'I', desaturate: 'Shift+U' };
// names of filters other modules register, as in the Korean Photoshop
const RENAME = { pictureFrame: '사진 프레임' };

const modLabel = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+');
const dots = (f) => (visibleParams(f.params).length || f.dialog ? '…' : '');

/** Labels the editor's own Filter menu makes (to tell other modules' additions apart). */
function baseFilterLabels() {
  const set = new Set();
  const groups = {};
  for (const [, f] of Object.entries(FILTERS)) if (!f.gallery && !f.hidden) (groups[f.group] ||= []).push(f);
  for (const [g, list] of Object.entries(groups)) {
    set.add(g);
    if (list.length === 1) set.add(`${list[0].name}${list[0].params?.length ? '…' : ''}`);
  }
  return set;
}

function filterMenu(P, orig) {
  const mod = modLabel();
  const no = !P.doc;
  const last = D.lastFilterInfo();
  const lastName = last ? FILTERS[last.id]?.name : null;
  const base = baseFilterLabels();
  const fixed = ['마지막 필터', '필터 갤러리', '픽셀 유동화'];
  const mine = new Set(['마지막 필터', '고급 필터용으로 변환', '뉴럴 필터', '필터 갤러리', 'Camera Raw 필터', '렌즈 교정', '픽셀 유동화']);
  const bare = (s) => s.replace(/…$/, '').replace(/\s*\(.*\)$/, '').trim();
  const foreign = (orig || []).filter((x) => x && typeof x === 'object' && typeof x.label === 'string' && !base.has(x.label) && !fixed.some((f) => x.label.startsWith(f)) && !mine.has(bare(x.label)));
  const groups = {};
  for (const [id, f] of Object.entries(FILTERS)) {
    if (f.gallery || f.hidden || f.menu === false || f.neural || ROOT_GROUPS.has(f.group)) continue;
    (groups[f.group] ||= []).push({ label: `${f.name}${dots(f)}`, disabled: no, action: () => D.filterDialog(P, id) });
  }
  const order = [...FILTER_GROUPS, ...Object.keys(groups).filter((g) => !FILTER_GROUPS.includes(g))];
  const groupItems = order.filter((g) => groups[g]?.length).map((g) => ({ label: g, disabled: no, submenu: groups[g].sort((a, b) => a.label.localeCompare(b.label, 'ko')) }));
  return [
    { label: lastName ? `마지막 필터 (${lastName})` : '마지막 필터', key: `${mod}F`, disabled: no || !last, action: () => D.repeatFilter(P) },
    '-',
    { label: '고급 필터용으로 변환', disabled: no || !P.cmd.convertToSmart, action: () => P.cmd.convertToSmart() },
    '-',
    { label: '뉴럴 필터…', disabled: no, action: () => neuralFiltersDialog(P) },
    { label: '필터 갤러리…', disabled: no, action: () => P.cmd.filterGallery() },
    { label: 'Camera Raw 필터…', key: `${mod}Shift+A`, disabled: no, action: () => D.filterDialog(P, 'cameraRaw') },
    { label: '렌즈 교정…', key: `${mod}Shift+R`, disabled: no, action: () => D.filterDialog(P, 'lensCorrection') },
    { label: '픽셀 유동화…', key: `${mod}Shift+X`, disabled: no, action: () => P.cmd.liquify() },
    '-',
    ...groupItems,
    ...(foreign.length ? ['-', ...foreign] : []),
  ];
}

function adjustItems(P) {
  const mod = modLabel();
  const no = !P.doc;
  const out = [];
  const used = new Set();
  for (const grp of ADJ_ORDER) {
    const items = [];
    for (const k of grp) {
      if (k === 'matchColor') {
        if (P.cmd.matchColor) items.push({ label: '색상 일치…', disabled: no, action: () => P.cmd.matchColor() });
        continue;
      }
      const a = ADJUSTMENTS[k];
      if (!a) continue;
      used.add(k);
      items.push({ label: `${a.name}${visibleParams(a.params).length ? '…' : ''}`, key: ADJ_KEYS[k] ? `${mod}${ADJ_KEYS[k]}` : undefined, disabled: no, action: () => D.adjustDialog(P, k) });
    }
    if (items.length) out.push(...(out.length ? ['-'] : []), ...items);
  }
  const rest = Object.entries(ADJUSTMENTS).filter(([k]) => !used.has(k));
  if (rest.length) out.push('-', ...rest.map(([k, a]) => ({ label: `${a.name}${visibleParams(a.params).length ? '…' : ''}`, disabled: no, action: () => D.adjustDialog(P, k) })));
  return out;
}

/** Image ▸ Adjustments order for every list of adjustments (new adjustment layer menus, panels). */
function orderAdjustments() {
  const order = ADJ_ORDER.flat().filter((k) => ADJUSTMENTS[k]);
  const entries = [...order, ...Object.keys(ADJUSTMENTS).filter((k) => !order.includes(k))].map((k) => [k, ADJUSTMENTS[k]]);
  for (const k of Object.keys(ADJUSTMENTS)) delete ADJUSTMENTS[k];
  for (const [k, v] of entries) ADJUSTMENTS[k] = v;
}

export function installFilters(P) {
  D.setPhotoApi(P);
  for (const [id, name] of Object.entries(RENAME)) if (FILTERS[id]) FILTERS[id].name = name;
  orderAdjustments();

  // Image Size's resampling methods: the editor resizes everything (masks, text, shapes…), then the
  // image layers are resampled again from their originals with the chosen method, in the same step
  const plainResize = P.resizeImage;
  if (plainResize && !plainResize.withMethods) {
    P.resizeImage = (W, H, method, opts = {}) => {
      const doc = P.doc;
      if (!doc) return undefined;
      if (!method) return plainResize(W, H);
      const srcs = new Map(doc.layers.filter((l) => l.kind === 'raster' && l.canvas).map((l) => [l.id, l.canvas]));
      const r = plainResize(W, H);
      for (const l of doc.layers) {
        const s = srcs.get(l.id);
        if (!s || !l.canvas || l.canvas === s) continue;
        try {
          l.canvas = resampleCanvas(s, l.canvas.width, l.canvas.height, method, opts);
        } catch (err) {
          toast(String(err.message || err));
          break;
        }
        l._styled = null;
        l._cache = null;
        doc.touch(l);
      }
      doc.rev++;
      P.redraw();
      return r;
    };
    P.resizeImage.withMethods = true;
  }

  P.cmd.neuralFilters = () => neuralFiltersDialog(P);
  P.cmd.cameraRawFilter = () => D.filterDialog(P, 'cameraRaw');
  P.cmd.lensCorrection = () => D.filterDialog(P, 'lensCorrection');

  P.extendMenus = [...(P.extendMenus || []), () => {
    const wrap = (name, fn) => {
      const orig = P.menus[name];
      if (orig) P.menus[name] = () => fn(orig());
    };
    wrap('필터', (items) => filterMenu(P, items));
    wrap('이미지', (items) => {
      const i = items.findIndex((x) => x && typeof x === 'object' && x.label === '조정');
      if (i >= 0) items[i] = { ...items[i], submenu: () => adjustItems(P) };
      return items;
    });
  }];

}

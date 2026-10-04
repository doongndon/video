// Font catalogue for text clips. Google Fonts are loaded on demand (one stylesheet per family, so
// a slow or failing family never blocks the others); font files imported into the project and
// fonts installed on this computer are added at run time.
// Every Google family below was checked against the Google Fonts CSS API (2026-10).

export const FONT_CATEGORIES = [
  ['all', '전체'],
  ['gothic', '고딕'],
  ['serif', '명조'],
  ['display', '제목용'],
  ['hand', '손글씨'],
  ['latin', '영문'],
  ['system', '시스템'],
  ['mine', '내 글꼴'],
];

// [family, Korean label (only where the Korean name is well known), category, weights to request]
const G = [
  // 고딕
  ['Noto Sans KR', '본고딕', 'gothic', '400;700'],
  ['Nanum Gothic', '나눔고딕', 'gothic', '400;700'],
  ['Gothic A1', '', 'gothic', '400;700'],
  ['IBM Plex Sans KR', '', 'gothic', '400;700'],
  ['Gowun Dodum', '고운돋움', 'gothic', '400'],
  ['Sunflower', '해바라기', 'gothic', '500;700'],
  ['Orbit', '', 'gothic', '400'],
  ['Nanum Gothic Coding', '나눔고딕코딩', 'gothic', '400;700'],
  // 명조
  ['Noto Serif KR', '본명조', 'serif', '400;700'],
  ['Nanum Myeongjo', '나눔명조', 'serif', '400;700'],
  ['Gowun Batang', '고운바탕', 'serif', '400;700'],
  ['Hahmlet', '함렛', 'serif', '400;700'],
  ['Song Myung', '송명', 'serif', '400'],
  // 제목용
  ['Black Han Sans', '검은고딕', 'display', '400'],
  ['Do Hyeon', '도현', 'display', '400'],
  ['Jua', '주아', 'display', '400'],
  ['Gugi', '구기', 'display', '400'],
  ['Bagel Fat One', '', 'display', '400'],
  ['Gasoek One', '', 'display', '400'],
  ['Moirai One', '', 'display', '400'],
  ['Grandiflora One', '', 'display', '400'],
  ['Diphylleia', '', 'display', '400'],
  ['Black And White Picture', '', 'display', '400'],
  ['Dongle', '동글', 'display', '400;700'],
  ['Stylish', '', 'display', '400'],
  ['Yeon Sung', '연성', 'display', '400'],
  // 손글씨
  ['Nanum Pen Script', '나눔손글씨 펜', 'hand', '400'],
  ['Nanum Brush Script', '나눔손글씨 붓', 'hand', '400'],
  ['Gaegu', '개구', 'hand', '400;700'],
  ['Gamja Flower', '감자꽃', 'hand', '400'],
  ['Hi Melody', '하이멜로디', 'hand', '400'],
  ['Poor Story', '', 'hand', '400'],
  ['Single Day', '', 'hand', '400'],
  ['Cute Font', '', 'hand', '400'],
  ['Dokdo', '독도', 'hand', '400'],
  ['East Sea Dokdo', '동해 독도', 'hand', '400'],
  ['Kirang Haerang', '기랑해랑', 'hand', '400'],
  // 영문 (한글 글자가 없어 한글은 다른 글꼴로 대신 표시됨)
  ['Montserrat', '', 'latin', '400;700'],
  ['Poppins', '', 'latin', '400;700'],
  ['Inter', '', 'latin', '400;700'],
  ['Roboto', '', 'latin', '400;700'],
  ['Lato', '', 'latin', '400;700'],
  ['Raleway', '', 'latin', '400;700'],
  ['Fredoka', '', 'latin', '400;700'],
  ['Bebas Neue', '', 'latin', '400'],
  ['Oswald', '', 'latin', '400;700'],
  ['Anton', '', 'latin', '400'],
  ['Archivo Black', '', 'latin', '400'],
  ['Bungee', '', 'latin', '400'],
  ['Bangers', '', 'latin', '400'],
  ['Righteous', '', 'latin', '400'],
  ['Rubik Mono One', '', 'latin', '400'],
  ['Orbitron', '', 'latin', '400;700'],
  ['Press Start 2P', '', 'latin', '400'],
  ['Abril Fatface', '', 'latin', '400'],
  ['Playfair Display', '', 'latin', '400;700'],
  ['Merriweather', '', 'latin', '400;700'],
  ['Cinzel', '', 'latin', '400;700'],
  ['Lobster', '', 'latin', '400'],
  ['Pacifico', '', 'latin', '400'],
  ['Dancing Script', '', 'latin', '400;700'],
  ['Great Vibes', '', 'latin', '400'],
  ['Satisfy', '', 'latin', '400'],
  ['Caveat', '', 'latin', '400;700'],
  ['Permanent Marker', '', 'latin', '400'],
  ['Shadows Into Light', '', 'latin', '400'],
  ['Source Code Pro', '', 'latin', '400;700'],
];

const SYSTEM = [
  ['sans-serif', '시스템 고딕'],
  ['serif', '시스템 명조'],
  ['monospace', '시스템 고정폭'],
  ['Arial', ''],
  ['Georgia', ''],
  ['Impact', ''],
  ['Courier New', ''],
];

/** Families already requested by index.html (used by the interface itself). */
const PRELOADED = new Set(['Noto Sans KR', 'Noto Serif KR', 'Black Han Sans', 'Do Hyeon', 'Jua', 'Nanum Pen Script']);

const GOOGLE = new Map(G.map(([family, , , weights]) => [family, weights]));
const sheets = new Map(); // family -> Promise (stylesheet loaded)
const localFonts = []; // families installed on this computer (after the user allows access)

export function fontLabel(family) {
  const g = G.find((x) => x[0] === family) || SYSTEM.find((x) => x[0] === family);
  return g && g[1] ? `${g[1]} (${family})` : family;
}

export const isGenericFamily = (family) => /^(sans-serif|serif|monospace)$/.test(family);

/** Whether a family needs a Google Fonts stylesheet that has not finished loading yet. */
export function fontSheetPending(family) {
  if (!GOOGLE.has(family) || PRELOADED.has(family)) return false;
  return sheets.get(family)?.state !== 'done';
}

/** Make sure the stylesheet of a Google family is on the page. Resolves when it has loaded. */
export function ensureFont(family) {
  if (!GOOGLE.has(family) || PRELOADED.has(family) || typeof document === 'undefined') return Promise.resolve();
  let entry = sheets.get(family);
  if (!entry) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${GOOGLE.get(family)}&display=swap`;
    entry = { state: 'loading' };
    entry.promise = new Promise((resolve) => {
      const done = () => {
        entry.state = 'done';
        resolve();
      };
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
      setTimeout(done, 15000);
    });
    sheets.set(family, entry);
    document.head.append(link);
  }
  return entry.promise;
}

/** Load the glyphs a piece of text needs in a family (stylesheet first). */
export async function loadFontFor(family, text = '가A', { bold = false, italic = false } = {}) {
  if (!document.fonts || isGenericFamily(family)) return;
  await ensureFont(family);
  const spec = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} 32px "${family}"`;
  try {
    await document.fonts.load(spec, text || ' ');
  } catch { /* fall back silently */ }
}

/** Register a font file imported into the project. Returns the family name to use. */
export async function registerFontFile(file, wanted) {
  const family = wanted || file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/["\\]/g, '').trim() || '내 글꼴';
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  return family;
}

/** Ask the browser for the fonts installed on this computer (Chrome / Edge; needs permission). */
export async function loadLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function') throw new Error('이 브라우저는 설치된 글꼴 목록을 알려 주지 않습니다 (Chrome·Edge에서 가능)');
  const list = await window.queryLocalFonts();
  const families = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'ko'));
  localFonts.splice(0, localFonts.length, ...families);
  return families.length;
}

export const localFontsAvailable = () => typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';

/**
 * Every choice for the font picker: {family, label, cat, korean}. Project fonts (imported files)
 * and local fonts come first under "내 글꼴".
 */
export function fontChoices(project) {
  const out = [];
  const seen = new Set();
  const add = (family, label, cat, korean) => {
    if (!family || seen.has(family)) return;
    seen.add(family);
    out.push({ family, label, cat, korean });
  };
  for (const id of project?.mediaOrder || []) {
    const m = project.media[id];
    if (m?.kind === 'font' && m.fontFamily) add(m.fontFamily, `${m.fontFamily} (가져온 파일)`, 'mine', true);
  }
  for (const f of localFonts) add(f, `${f} (이 컴퓨터)`, 'mine', true);
  for (const [family, ko, cat] of G) add(family, ko ? `${ko} (${family})` : family, cat, cat !== 'latin');
  for (const [family, ko] of SYSTEM) add(family, ko || family, 'system', true);
  return out;
}

/** Load the stylesheets of every Google font used by text clips (e.g. after opening a project). */
export function ensureProjectFonts(project) {
  for (const seq of Object.values(project?.sequences || {})) {
    for (const c of Object.values(seq.clips)) {
      const fx = c.effects?.find((e) => e.type === 'text');
      const fam = fx?.params.font?.value;
      if (fam) ensureFont(fam);
    }
  }
}

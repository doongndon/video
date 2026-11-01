// Photoshop look for the photo editor: the interface colour themes (Edit ▸ Preferences ▸ Interface,
// Shift+F1 / Shift+F2), the home screen shown when no document is open (New, Open, recent files with
// thumbnails, quick-start presets) and the recent files list (File ▸ Open Recent).

import { h, clamp } from '../util.js';
import { toast, loadPref, savePref } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { makeCanvas } from './doc.js';
import { DOC_CATEGORIES } from './pdialogs.js';

/** [theme, name, panel colour, pasteboard colour]; 2 is Photoshop's default. */
const THEMES = [[1, '가장 어둡게', '#262626', '#1e1e1e'], [2, '어둡게 (기본값)', '#323232', '#282828'], [3, '중간 회색', '#535353', '#494949'], [4, '밝게', '#dcdcdc', '#c2c2c2']];
const pasteOf = (n) => THEMES.find((t) => t[0] === n)[3];
// a pasteboard of one of these colours is the theme's (it follows the theme when that changes)
const THEME_PASTE = new Set(['#1f2125', ...THEMES.map((t) => t[3])]);

export function installTheme(P) {
  P.theme = clamp(loadPref('photo.theme', 2) | 0, 1, 4);
  P.themePasteboard = () => pasteOf(P.theme);
  /** Edit ▸ Preferences ▸ Interface ▸ Color Theme. */
  P.setTheme = (n, { quiet = true } = {}) => {
    n = clamp(n | 0, 1, 4);
    P.theme = n;
    savePref('photo.theme', n);
    document.body.dataset.psTheme = String(n);
    if (!P.prefs.pasteboard || THEME_PASTE.has(P.prefs.pasteboard.toLowerCase())) {
      P.prefs.pasteboard = pasteOf(n);
      savePref('photo.prefs', P.prefs);
    }
    document.body.style.setProperty('--ps-pasteboard', P.prefs.pasteboard);
    P.invalidateView?.();
    P.emit('theme', n);
    if (!quiet) toast(`색상 테마: ${THEMES[n - 1][1]}`);
  };
  /** The four colour swatches of the Interface preferences (they apply at once, like Photoshop). */
  P.themeControl = () => {
    const row = h('span.ph-themes', { role: 'radiogroup', 'aria-label': '색상 테마' });
    const paint = () => row.replaceChildren(...THEMES.map(([n, name, c]) => h(`button.ph-theme${P.theme === n ? '.on' : ''}`, {
      type: 'button', role: 'radio', 'aria-checked': String(P.theme === n), 'aria-label': name, title: name, style: { background: c },
      onclick: () => { P.setTheme(n); paint(); },
    })));
    paint();
    return row;
  };
  // Shift+F1 / Shift+F2: a darker / lighter theme
  const prevKeys = P.viewKeys;
  P.viewKeys = (e, mod) => {
    if (e.shiftKey && !mod && !e.altKey && (e.code === 'F1' || e.code === 'F2')) {
      P.setTheme(P.theme + (e.code === 'F1' ? -1 : 1), { quiet: false });
      return true;
    }
    return prevKeys?.(e, mod) || false;
  };
  P.setTheme(P.theme);
}

// ---------------------------------------------------------------- recent files

const RKEY = 'photo.recentFiles';
const MAX_RECENT = 20;
// the files themselves wait in IndexedDB so a click can open them again
let dbp = null;
const db = () => {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('montage-photo-recent', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
};
const store = async (mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
};

export const recentFiles = () => loadPref(RKEY, []);

/** Remember a file that was just opened (its picture as a small thumbnail). */
export async function rememberFile(P, file, doc) {
  try {
    const id = `${file.name}|${file.size}|${file.lastModified || 0}`;
    // a small picture of the document as opened
    const k = Math.min(1, 220 / Math.max(doc.width, doc.height));
    const full = makeCanvas(doc.width, doc.height);
    doc.render(full.getContext('2d'), { fg: P.fg, bg: P.bg });
    const c = makeCanvas(Math.max(1, Math.round(doc.width * k)), Math.max(1, Math.round(doc.height * k)));
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, c.width, c.height);
    const item = { id, name: file.name, w: doc.width, h: doc.height, size: file.size, time: Date.now(), thumb: c.toDataURL('image/jpeg', 0.72), kept: file.size < 60e6 };
    const old = recentFiles();
    const list = [item, ...old.filter((x) => x.id !== id)].slice(0, MAX_RECENT);
    savePref(RKEY, list);
    const gone = old.filter((x) => !list.some((y) => y.id === x.id));
    await store('readwrite', (s) => {
      if (item.kept) s.put(file, id);
      for (const x of gone) s.delete(x.id);
      return null;
    });
  } catch (err) {
    console.warn('recent file not kept', err);
  }
  P.emit('recent');
}

/** Open a file from the recent list again. */
export async function openRecent(P, item) {
  const open = P.docs.findIndex((d) => d.recentId === item.id);
  if (open >= 0) return P.switchDoc(open);
  const blob = item.kept ? await store('readonly', (s) => s.get(item.id)).catch(() => null) : null;
  if (!blob) {
    toast(`"${item.name}" 파일을 다시 열 수 없습니다. 열기…로 파일을 고르세요.`);
    return undefined;
  }
  const file = blob instanceof File ? blob : new File([blob], item.name, { type: blob.type });
  return P.openFiles([file]);
}

export async function clearRecent(P) {
  savePref(RKEY, []);
  await store('readwrite', (s) => s.clear()).catch(() => {});
  P.emit('recent');
}

/** File ▸ Open Recent. */
export function recentMenu(P) {
  const list = recentFiles();
  return { label: '최근 파일 열기', disabled: !list.length, submenu: () => [
    ...list.slice(0, 12).map((x) => ({ label: x.name, hint: `${x.w} × ${x.h}`, action: () => openRecent(P, x) })),
    '-',
    { label: '최근 파일 목록 지우기', action: () => clearRecent(P) },
  ] };
}

// ---------------------------------------------------------------- home screen

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(t).toLocaleDateString('ko-KR');
};

/** Photoshop's home screen: shown in the document area while no document is open. */
export function buildHome(P, { newDoc, open, openFromVideo }) {
  const recentBox = h('div');
  const quick = [['기본 Photoshop 크기', 2100, 1500, 300], ['HDTV 1080p', 1920, 1080, 72], ['인스타그램 정사각형', 1080, 1080, 72], ['A4', 2480, 3508, 300], ['쇼츠 · 릴스 · 스토리', 1080, 1920, 72], ['웹 일반', 1366, 768, 72]]
    .filter(([n]) => DOC_CATEGORIES.some(([, , l]) => l.some((p) => p[0] === n)));
  const qcard = ([n, w, hh, res]) => {
    const k = 44 / Math.max(w, hh);
    return h('button.ph-home-q', { title: `${n} · ${w} × ${hh} 픽셀`, onclick: () => {
      P.newDoc({ name: `제목 없음-${P.docs.length + 1}`, width: w, height: hh, background: '#ffffff' });
      if (P.doc) P.doc.resolution = res;
    } }, h('i', { style: { width: `${Math.round(w * k)}px`, height: `${Math.round(hh * k)}px` } }), h('b', n), h('span', `${w} × ${hh}`));
  };
  const paint = () => {
    const list = recentFiles();
    recentBox.replaceChildren(
      h('h3', '최근 항목', list.length ? h('button.small.ph-home-clear', { onclick: () => clearRecent(P) }, '목록 지우기') : null),
      list.length
        ? h('div.ph-home-recent', ...list.map((x) => h('button.ph-home-r', { title: `${x.name} · ${x.w} × ${x.h} 픽셀`, onclick: () => openRecent(P, x) },
          h('div.ph-home-th', x.thumb ? h('img', { src: x.thumb, alt: '' }) : icon('image', 28)),
          h('b', x.name), h('small', `${ago(x.time)} · ${x.w} × ${x.h}`))))
        : h('div.ph-home-empty', '최근에 연 파일이 여기에 나옵니다. 사진이나 PSD를 열어 보세요.'));
  };
  P.on('recent', paint);
  paint();
  return h('div.ph-home',
    h('nav.ph-home-nav', { 'aria-label': '시작' },
      h('button.primary', { onclick: newDoc }, icon('fileNew', 16), '새 파일'),
      h('button', { onclick: open }, icon('fileOpen', 16), '열기'),
      h('button.ph-home-video', { onclick: openFromVideo }, icon('film', 16), '영상 프로젝트 이미지'),
      h('p.note', '파일을 이 화면으로 끌어 놓아도 열립니다. 사진, PSD, .mphoto를 열 수 있어요.')),
    h('div.ph-home-main',
      h('h2', '사진 편집에 오신 것을 환영합니다'),
      h('div.ph-home-drop', '포토샵 강의를 보면서 같은 메뉴, 도구, 패널로 따라 해 보세요.'),
      h('h3.ph-home-qh', '새 파일 빠르게 시작'),
      h('div.ph-home-quick', ...quick.map(qcard)),
      recentBox));
}

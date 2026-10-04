// Which editor is on screen: the video editor ("영상") or the photo editor ("사진").
// The photo editor is loaded the first time it is needed, so the video editor starts as before.

import { loadPref, savePref, toast } from './ui/common.js';

const listeners = new Set();
let photo = null;

export const appMode = {
  current: 'video',
  /** The photo editor API once loaded (null before). */
  P: null,
  on(fn) {
    listeners.add(fn);
  },
  isPhoto() {
    return this.current === 'photo';
  },
};

/** Loads and builds the photo editor once; resolves with its API. */
export function photoEditor() {
  if (!photo) {
    photo = import('./photo/editor.js').then(({ createPhotoEditor }) => {
      const P = createPhotoEditor(document.getElementById('photo'));
      appMode.P = P;
      return P;
    }).catch((err) => {
      photo = null;
      throw err;
    });
  }
  return photo;
}

export async function setMode(mode) {
  if (mode !== 'photo') mode = 'video';
  let P = null;
  if (mode === 'photo') {
    try {
      P = await photoEditor();
    } catch (err) {
      console.error(err);
      toast(`사진 편집기를 불러오지 못했습니다: ${err.message || err}`);
      return;
    }
  }
  const changed = appMode.current !== mode;
  appMode.current = mode;
  document.body.classList.toggle('photo-mode', mode === 'photo');
  document.getElementById('photo').hidden = mode !== 'photo';
  savePref('mode', mode);
  document.title = mode === 'photo' ? 'Montage 사진 편집' : 'Montage 영상 편집기';
  if (changed) for (const fn of listeners) fn(mode);
  if (P) {
    P.shown();
    await P.restoreSession();
  }
}

/** Opens a canvas in the photo editor (switching to it). */
export async function openInPhoto(canvas, name, sourceMediaId = null) {
  await setMode('photo');
  appMode.P?.openCanvas(canvas, name, sourceMediaId);
}

export function initialMode() {
  if (/[?&]mode=photo\b/.test(location.search)) return 'photo';
  if (/[?&]mode=video\b/.test(location.search)) return 'video';
  return loadPref('mode', 'video');
}

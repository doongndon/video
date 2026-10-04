// User effect presets: an effect's parameter values (and keyframes) saved under a name in this
// browser, listed in the Effects panel under "사용자 프리셋".

import { store } from '../store.js';
import { uid, deepClone } from '../util.js';
import { loadPref, savePref } from './common.js';

export function listPresets() {
  const list = loadPref('fxPresets', []);
  return Array.isArray(list) ? list : [];
}

export function savePreset(name, fx) {
  const list = listPresets();
  list.push({ id: uid('pre'), name, type: fx.type, enabled: fx.enabled, params: deepClone(fx.params) });
  savePref('fxPresets', list);
  store.emit('presets');
}

export function deletePreset(id) {
  savePref('fxPresets', listPresets().filter((p) => p.id !== id));
  store.emit('presets');
}

export function getPreset(id) {
  return listPresets().find((p) => p.id === id) || null;
}

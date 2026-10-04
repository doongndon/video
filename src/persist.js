// Autosave to IndexedDB (project JSON + imported media files) and project file open/save.

import { store } from './store.js';
import { runtime, getRuntime, attachFile, mediaEvents } from './media.js';
import { debounce, downloadBlob } from './util.js';

const DB_NAME = 'montage-editor';
const DB_VERSION = 1;
let dbPromise = null;
const savedFiles = new Set();
let enabled = true;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    const result = fn(s);
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveProjectNow() {
  if (!enabled) return;
  try {
    await tx('kv', 'readwrite', (s) => s.put(store.snapshot(), 'project'));
    for (const id of store.project.mediaOrder) {
      const rt = runtime.get(id);
      if (rt?.file && !savedFiles.has(id)) {
        savedFiles.add(id);
        await tx('files', 'readwrite', (s) => s.put(rt.file, id)).catch((err) => {
          savedFiles.delete(id);
          console.warn('could not persist media file', err);
          store.toast(`자동 저장: ${rt.file.name} 파일을 브라우저에 저장하지 못했습니다(저장 공간 부족 가능). 새로 고침 후 미디어 다시 연결이 필요할 수 있습니다.`);
        });
      }
    }
    // drop files of media that no longer exist
    const keys = await tx('files', 'readonly', (s) => s.getAllKeys());
    for (const k of keys || []) {
      if (!store.project.media[k]) {
        await tx('files', 'readwrite', (s) => s.delete(k));
        savedFiles.delete(k);
      }
    }
    store.emit('saved', new Date());
  } catch (err) {
    console.warn('autosave failed', err);
  }
}

const scheduleSave = debounce(saveProjectNow, 1000);

export function initAutosave() {
  store.on('change', () => scheduleSave());
  mediaEvents.on('updated', () => scheduleSave());
  window.addEventListener('beforeunload', () => scheduleSave.flush());
}

/** Restore the last session. Returns true if a project was restored. */
export async function restoreSession() {
  try {
    const json = await tx('kv', 'readonly', (s) => s.get('project'));
    if (!json) return false;
    const project = JSON.parse(json);
    if (!project?.sequence && !project?.sequences) return false;
    store.loadProject(project);
    const pending = [];
    for (const id of store.project.mediaOrder) {
      const m = store.project.media[id];
      if (!m || ['color', 'adjustment', 'sequence'].includes(m.kind)) continue;
      const file = await tx('files', 'readonly', (s) => s.get(id)).catch(() => null);
      if (file) {
        savedFiles.add(id);
        pending.push(attachFile(id, file).catch((err) => console.warn('restore failed', m.name, err)));
      } else {
        getRuntime(id).status = 'offline';
      }
    }
    await Promise.all(pending);
    store.changed('media');
    return true;
  } catch (err) {
    console.warn('restore failed', err);
    return false;
  }
}

export async function clearSession() {
  try {
    await tx('kv', 'readwrite', (s) => s.clear());
    await tx('files', 'readwrite', (s) => s.clear());
    savedFiles.clear();
  } catch (err) {
    console.warn(err);
  }
}

export function setAutosave(on) {
  enabled = on;
}

// ---------------------------------------------------------------- project files

export function saveProjectFile() {
  const data = { app: 'montage', savedAt: new Date().toISOString(), project: store.project };
  const name = (store.project.name || 'project').replace(/[^\w\-가-힣 ]+/g, '_');
  downloadBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${name}.montage.json`);
}

export async function openProjectFile(file) {
  const data = JSON.parse(await file.text());
  const project = data.project || data;
  if (!(project?.sequence?.tracks || project?.sequences) || !project.media) throw new Error('Montage 프로젝트 파일이 아닙니다');
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
  store.loadProject(project);
  for (const id of store.project.mediaOrder) getRuntime(id).status = ['color', 'adjustment', 'sequence'].includes(store.project.media[id]?.kind) ? 'ready' : 'offline';
  store.changed('media');
}

/** Relink offline media from a set of files, matching by file name (then size). */
export async function relinkFromFiles(files) {
  let linked = 0;
  for (const id of store.project.mediaOrder) {
    const m = store.project.media[id];
    if (!m || getRuntime(id).status === 'ready' || ['color', 'adjustment', 'sequence'].includes(m.kind)) continue;
    const match = files.find((f) => f.name === m.name && (!m.size || f.size === m.size)) || files.find((f) => f.name === m.name);
    if (match) {
      await attachFile(id, match);
      savedFiles.delete(id);
      linked++;
    }
  }
  store.changed('media');
  return linked;
}

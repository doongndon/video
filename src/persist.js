// Projects kept in this browser (IndexedDB), like Premiere's recent projects: each project has its own
// name, thumbnail (a program monitor frame) and times; the project open now autosaves into its slot.
// Imported media files are stored once per media id and shared by the projects that use them
// (a duplicated project keeps the same ids); files no project uses any more are dropped.
// Also project file open/save (.montage.json) and relinking offline media.

import { store } from './store.js';
import { runtime, getRuntime, attachFile, mediaEvents, analysisCache } from './media.js';
import { debounce, downloadBlob, uid } from './util.js';
import { loadPref, savePref } from './ui/common.js';

const DB_NAME = 'montage-editor';
const DB_VERSION = 3; // 2: 'analysis' (cached waveforms and filmstrips); 3: 'projects' (several projects)
let dbPromise = null;
const savedFiles = new Set();
let enabled = true;
/** Id of the stored project open now (null: not stored yet; the first real edit stores it). */
let currentId = null;
let lastThumb = 0;
/** The open project as last written (or loaded): saving it unchanged keeps its modified time. */
let lastJson = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('analysis')) d.createObjectStore('analysis');
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // another tab still has the old version open: it is asked to close it (see below)
      req.onblocked = () => console.warn('montage-editor database upgrade waits for another tab');
    }).then((d) => {
      d.onversionchange = () => d.close();
      return d;
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

const dataKey = (id) => `p:${id}`;
const SYNTHETIC = ['color', 'adjustment', 'sequence'];

// ---- cached analysis (waveform peaks, filmstrip thumbnails) by file signature
const ANALYSIS_MAX_AGE = 90 * 24 * 3600 * 1000;
analysisCache.get = (key) => tx('analysis', 'readonly', (s) => s.get(key));
analysisCache.put = (key, value) => tx('analysis', 'readwrite', (s) => s.put(value, key));

/** Forget cached analysis of files not used for a long time (once per session). */
async function pruneAnalysis() {
  try {
    const d = await db();
    await new Promise((resolve) => {
      const t = d.transaction('analysis', 'readwrite');
      const req = t.objectStore('analysis').openCursor();
      const now = Date.now();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (!(now - (cur.value?.used || 0) < ANALYSIS_MAX_AGE)) cur.delete();
        cur.continue();
      };
      t.oncomplete = resolve;
      t.onerror = resolve;
      t.onabort = resolve;
    });
  } catch { /* storage unavailable */ }
}

/** 미디어 캐시 지우기: cached waveforms and filmstrips (made again when needed). */
export async function clearAnalysisCache() {
  await tx('analysis', 'readwrite', (s) => s.clear());
}

// ---------------------------------------------------------------- the project list

/** Stored projects, most recently used first: [{id, name, created, modified, opened, thumb, media, bytes}]. */
export async function listProjects() {
  const list = (await tx('projects', 'readonly', (s) => s.getAll())) || [];
  return list.sort((a, b) => Math.max(b.modified, b.opened || 0) - Math.max(a.modified, a.opened || 0));
}

export const currentProjectId = () => currentId;

function setCurrent(id) {
  currentId = id;
  savePref('project.current', id);
}

/** A project with nothing in it yet is stored only once something is added (or it was named). */
const isEmptyProject = (p) => !p.mediaOrder.some((id) => p.media[id] && p.media[id].kind !== 'sequence')
  && !Object.values(p.sequences || {}).some((s) => Object.keys(s.clips || {}).length);

/** The media files a project uses (what the home screen sizes and other projects can import). */
function mediaList(p) {
  return p.mediaOrder.map((id) => p.media[id]).filter((m) => m && !SYNTHETIC.includes(m.kind))
    .map((m) => ({ id: m.id, name: m.name, kind: m.kind, size: m.size || runtime.get(m.id)?.file?.size || 0 }));
}

/** A program monitor frame (what is on screen now) as a small JPEG, or null. */
async function programThumb() {
  const src = document.querySelector('#pg-top-right canvas.frame:not(.pm-ref)');
  if (!src || !src.width || !src.height) return null;
  const w = 320;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.round(w * 9 / 16);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const k = Math.min(c.width / src.width, c.height / src.height);
  const dw = src.width * k;
  const dh = src.height * k;
  try {
    ctx.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  } catch {
    return null;
  }
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
}

/** Writes the open project into its slot (making one if needed). */
async function writeProject({ thumb = false, force = false } = {}) {
  const p = store.project;
  if (!currentId) {
    if (!force && isEmptyProject(p)) return false;
    setCurrent(uid('proj'));
  }
  const json = store.snapshot();
  const old = await tx('projects', 'readonly', (s) => s.get(currentId));
  const now = Date.now();
  let shot = old?.thumb || null;
  // the thumbnail is the frame on screen; taken now and then (and when leaving the project)
  if (thumb || !shot || now - lastThumb > 30000) {
    lastThumb = now;
    shot = (await programThumb()) || shot;
  }
  const same = !!old && json === lastJson;
  if (same && !thumb) return true;
  lastJson = json;
  const rec = { id: currentId, name: p.name || '제목 없는 프로젝트', created: old?.created || now, modified: same ? old.modified : now, opened: old?.opened || now, thumb: shot, media: mediaList(p), bytes: json.length * 2 };
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(['kv', 'projects'], 'readwrite');
    t.objectStore('kv').put(json, dataKey(currentId));
    t.objectStore('projects').put(rec);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return true;
}

/** Drops stored media files that no project uses. */
async function collectFiles() {
  const used = new Set();
  for (const r of await listProjects()) for (const m of r.media || []) used.add(m.id);
  for (const id of store.project.mediaOrder) used.add(id);
  const keys = await tx('files', 'readonly', (s) => s.getAllKeys());
  const gone = (keys || []).filter((k) => !used.has(k));
  if (gone.length) await tx('files', 'readwrite', (s) => { for (const k of gone) s.delete(k); });
  for (const k of gone) savedFiles.delete(k);
}

async function persistCurrent(opts) {
  if (!(await writeProject(opts))) return false;
  for (const id of store.project.mediaOrder) {
    const rt = runtime.get(id);
    if (rt?.file && !savedFiles.has(id)) {
      savedFiles.add(id);
      await tx('files', 'readwrite', (s) => s.put(rt.file, id)).catch((err) => {
        savedFiles.delete(id);
        console.warn('could not persist media file', err);
        store.toast(`자동 저장: ${rt.file.name} 파일을 브라우저에 저장하지 못했습니다(저장 공간 부족 가능). 홈에서 쓰지 않는 프로젝트를 지우거나, 새로 고침 후 미디어 다시 연결이 필요할 수 있습니다.`);
      });
    }
  }
  await collectFiles();
  return true;
}

export async function saveProjectNow(opts) {
  if (!enabled) return;
  try {
    if (await persistCurrent(opts)) store.emit('saved', new Date());
  } catch (err) {
    console.warn('autosave failed', err);
  }
}

const scheduleSave = debounce(saveProjectNow, 1000);

export function initAutosave() {
  setTimeout(pruneAnalysis, 15000);
  store.on('change', () => scheduleSave());
  mediaEvents.on('updated', () => scheduleSave());
  window.addEventListener('beforeunload', () => scheduleSave.flush());
  // phones may close a page in the background without unloading it: save when it is hidden
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') scheduleSave.flushPending(); });
  window.addEventListener('pagehide', () => scheduleSave.flushPending());
}

/** Loads a stored project JSON into the editor with its media files. */
async function loadStored(project) {
  store.loadProject(project);
  const pending = [];
  for (const id of store.project.mediaOrder) {
    const m = store.project.media[id];
    if (!m || SYNTHETIC.includes(m.kind)) continue;
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
  lastJson = store.snapshot();
}

/** The single autosave of older versions becomes the first stored project. */
async function migrateLegacy() {
  const json = await tx('kv', 'readonly', (s) => s.get('project'));
  if (!json) return;
  try {
    const p = JSON.parse(json);
    if (p?.sequence || p?.sequences) {
      const id = uid('proj');
      const now = Date.now();
      const media = Object.values(p.media || {}).filter((m) => m && !SYNTHETIC.includes(m.kind)).map((m) => ({ id: m.id, name: m.name, kind: m.kind, size: m.size || 0 }));
      await tx('kv', 'readwrite', (s) => s.put(json, dataKey(id)));
      await tx('projects', 'readwrite', (s) => s.put({ id, name: p.name || '제목 없는 프로젝트', created: now, modified: now, opened: now, thumb: null, media, bytes: json.length * 2 }));
      savePref('project.current', id);
    }
  } catch (err) {
    console.warn('could not move the old autosave', err);
  }
  await tx('kv', 'readwrite', (s) => s.delete('project'));
}

/** Restore the project used last. Returns true if a project was restored. */
export async function restoreSession() {
  try {
    await migrateLegacy();
    const list = await listProjects();
    if (!list.length) return false;
    const want = loadPref('project.current', null);
    for (const rec of [list.find((r) => r.id === want), ...list].filter(Boolean)) {
      const json = await tx('kv', 'readonly', (s) => s.get(dataKey(rec.id)));
      const project = json ? JSON.parse(json) : null;
      if (!project?.sequence && !project?.sequences) continue;
      setCurrent(rec.id);
      await loadStored(project);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('restore failed', err);
    return false;
  }
}

function releaseRuntime() {
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
}

/**
 * Leaves the open project (saved first) so the next save starts a new stored project. Nothing is
 * deleted: the project stays on the home screen's list.
 */
export async function clearSession() {
  try {
    scheduleSave.flushPending();
    if (currentId) await persistCurrent({ thumb: true });
  } catch (err) {
    console.warn(err);
  }
  setCurrent(null);
  savedFiles.clear();
}

/** Stores the project open now as a new project right away (새 프로젝트 with a name). */
export async function storeAsNewProject() {
  setCurrent(null);
  await persistCurrent({ force: true });
  store.emit('saved', new Date());
}

/** Opens a stored project (the open one is saved first). The caller resets playback. */
export async function openStoredProject(id) {
  const json = await tx('kv', 'readonly', (s) => s.get(dataKey(id)));
  const project = json ? JSON.parse(json) : null;
  if (!project?.sequence && !project?.sequences) throw new Error('프로젝트를 읽을 수 없습니다');
  const was = enabled;
  enabled = false;
  try {
    scheduleSave.flushPending();
    if (currentId && currentId !== id) await persistCurrent({ thumb: true }).catch((err) => console.warn(err));
    releaseRuntime();
    savedFiles.clear();
    setCurrent(id);
    const rec = await tx('projects', 'readonly', (s) => s.get(id));
    if (rec) await tx('projects', 'readwrite', (s) => s.put({ ...rec, opened: Date.now() }));
    await loadStored(project);
  } finally {
    enabled = was;
  }
}

/** Renames a stored project (the open one through the store, so its title updates). */
export async function renameStoredProject(id, name) {
  if (id === currentId) {
    store.transact('프로젝트 이름 바꾸기', () => { store.project.name = name; });
    await saveProjectNow();
    return;
  }
  const rec = await tx('projects', 'readonly', (s) => s.get(id));
  const json = await tx('kv', 'readonly', (s) => s.get(dataKey(id)));
  if (!rec || !json) return;
  const p = JSON.parse(json);
  p.name = name;
  const out = JSON.stringify(p);
  await tx('kv', 'readwrite', (s) => s.put(out, dataKey(id)));
  await tx('projects', 'readwrite', (s) => s.put({ ...rec, name }));
}

/** 복제: a copy of a stored project; it shares the media files. Returns the new id. */
export async function duplicateStoredProject(id, name) {
  if (id === currentId) await saveProjectNow({ force: true });
  const rec = await tx('projects', 'readonly', (s) => s.get(id));
  const json = await tx('kv', 'readonly', (s) => s.get(dataKey(id)));
  if (!rec || !json) return null;
  const p = JSON.parse(json);
  p.name = name;
  const out = JSON.stringify(p);
  const nid = uid('proj');
  const now = Date.now();
  await tx('kv', 'readwrite', (s) => s.put(out, dataKey(nid)));
  await tx('projects', 'readwrite', (s) => s.put({ ...rec, id: nid, name, created: now, modified: now, opened: now, bytes: out.length * 2 }));
  return nid;
}

/** Deletes a stored project and the media files only it used. Not the open one. */
export async function deleteStoredProject(id) {
  if (id === currentId) throw new Error('열려 있는 프로젝트는 지울 수 없습니다');
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(['kv', 'projects'], 'readwrite');
    t.objectStore('kv').delete(dataKey(id));
    t.objectStore('projects').delete(id);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  await collectFiles();
}

/** A media file stored for any project (to import it into the open one), or null. */
export const storedFile = (mediaId) => tx('files', 'readonly', (s) => s.get(mediaId)).catch(() => null);

/** How much this browser stores: {usage, quota} (bytes, from the browser), or null. */
export async function storageEstimate() {
  try {
    return navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  } catch {
    return null;
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

/** Opens a project file as a new project in this browser (the open one stays in the list). */
export async function openProjectFile(file) {
  const data = JSON.parse(await file.text());
  const project = data.project || data;
  if (!(project?.sequence?.tracks || project?.sequences) || !project.media) throw new Error('Montage 프로젝트 파일이 아닙니다');
  await clearSession();
  releaseRuntime();
  store.loadProject(project);
  for (const id of store.project.mediaOrder) getRuntime(id).status = SYNTHETIC.includes(store.project.media[id]?.kind) ? 'ready' : 'offline';
  store.changed('media');
}

/** Relink offline media from a set of files, matching by file name (then size). */
export async function relinkFromFiles(files) {
  let linked = 0;
  for (const id of store.project.mediaOrder) {
    const m = store.project.media[id];
    if (!m || getRuntime(id).status === 'ready' || SYNTHETIC.includes(m.kind)) continue;
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

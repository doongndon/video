// The documents shown on the home screen (Photoshop's Home ▸ Your files): every document worked on in
// the photo editor is kept in this browser's IndexedDB with all its layers (the .mphoto data, canvases
// as PNG blobs), a small picture and the time it was last changed or opened. Removed documents wait
// under 삭제됨 until restored or deleted for good. The store keeps itself under a size limit
// (oldest documents go first, with a notice).

import { uid } from '../util.js';
import { toast, loadPref, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import * as IO from './io.js';

const DB = 'montage-photo-library';
const MB = 1e6;
/** Limit for everything kept here (also the 삭제됨 documents); the pref photo.home.limitMB changes it. */
const limitMB = +loadPref('photo.home.limitMB', 0) || 0;
export const LIMIT = (limitMB > 0 ? limitMB : /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 250 : 600) * MB;
const MAX_ITEMS = 300;
// removed documents are deleted for good after this long (like Photoshop's deleted cloud documents)
const TRASH_DAYS = 30;
// while a document is being edited it is written here at most this often (closing writes at once)
const PUT_EVERY = 15000;

let dbp = null;
const db = () => {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('data');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
};
/** One transaction over both stores; fn(meta, data) returns the request whose result is wanted. */
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['meta', 'data'], mode);
    const req = fn(t.objectStore('meta'), t.objectStore('data'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

/** Every entry (deleted ones too): { id, name, w, h, time, bytes, thumb: Blob, deleted, srcKey, edited, kind }. */
export const items = [];
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };
export const get = (id) => items.find((x) => x.id === id) || null;
/** Documents on the list (not deleted), most recent first. */
export const recent = () => items.filter((x) => !x.deleted).sort((a, b) => b.time - a.time);
export const trash = () => items.filter((x) => x.deleted).sort((a, b) => b.deleted - a.deleted);
export const usage = () => items.reduce((s, x) => s + (x.bytes || 0), 0);

// writes run one after another
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn, fn));

export const ready = (async () => {
  try {
    const list = await tx('readonly', (m) => m.getAll());
    items.push(...(list || []));
    await migrateRecent();
    const old = Date.now() - TRASH_DAYS * 864e5;
    const expired = items.filter((x) => x.deleted && x.deleted < old);
    if (expired.length) await purgeNow(expired.map((x) => x.id));
  } catch (err) {
    console.warn('photo library unavailable', err);
  }
  changed();
})();

// the earlier recent-files list (raw files in their own database) moves in here once
async function migrateRecent() {
  const list = loadPref('photo.recentFiles', null);
  if (!list) return;
  savePref('photo.recentFiles', null);
  if (!list.length) return;
  try {
    const old = await new Promise((resolve, reject) => {
      const r = indexedDB.open('montage-photo-recent', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const files = await Promise.all(list.map((x) => new Promise((resolve) => {
      const q = old.transaction('files').objectStore('files').get(x.id);
      q.onsuccess = () => resolve(q.result || null);
      q.onerror = () => resolve(null);
    })));
    old.close();
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      const file = files[i];
      if (!file) continue;
      const thumb = x.thumb ? await (await fetch(x.thumb)).blob().catch(() => null) : null;
      const meta = { id: uid('doc'), name: x.name.replace(/\.[^.]+$/, ''), w: x.w, h: x.h, time: x.time || Date.now(), bytes: file.size, thumb, deleted: 0, srcKey: x.id, edited: false, kind: 'file' };
      await tx('readwrite', (m, d) => { m.put(meta); d.put({ file }, meta.id); });
      items.push(meta);
    }
    indexedDB.deleteDatabase('montage-photo-recent');
  } catch (err) {
    console.warn('recent files not moved', err);
  }
}

// ---------------------------------------------------------------- writing documents

const blobBytes = (o, seen = new Set()) => {
  if (!o || typeof o !== 'object' || seen.has(o)) return 0;
  seen.add(o);
  if (o instanceof Blob) return o.size;
  let n = 0;
  for (const v of Array.isArray(o) ? o : Object.values(o)) n += blobBytes(v, seen);
  return n;
};

/** A small picture of the document (WebP keeps transparency; PNG where WebP can't be written). */
async function thumbOf(doc, P) {
  const k = Math.min(1, 360 / Math.max(doc.width, doc.height));
  const full = makeCanvas(doc.width, doc.height);
  doc.render(full.getContext('2d'), { fg: P.fg, bg: P.bg });
  const c = makeCanvas(Math.max(1, Math.round(doc.width * k)), Math.max(1, Math.round(doc.height * k)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(full, 0, 0, c.width, c.height);
  full.width = full.height = 0;
  return new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
}

// what each open document looked like when it was last written (so unchanged ones are skipped)
const stamps = new WeakMap();
const lastPut = new WeakMap();
const timers = new WeakMap();
const stampOf = (doc) => {
  const hi = doc.history;
  return `${doc.name}|${doc.width}x${doc.height}|${hi?.serial || 0}|${hi?.undoStack.length || 0}|${hi?.redoStack.length || 0}`;
};
/** Documents that are not kept here: a smart object's contents opened for editing. */
const keepable = (doc) => doc && !doc.smartParent;

/** Write a document now (when it changed since it was last written). Resolves true when it is kept. */
export function put(P, doc, { force = false } = {}) {
  if (!keepable(doc)) return Promise.resolve(false);
  clearTimeout(timers.get(doc));
  timers.delete(doc);
  return queue(async () => {
    const stamp = stampOf(doc);
    if (!force && stamps.get(doc) === stamp && get(doc.id)) return true;
    try {
      const rec = await IO.docToRecord(doc);
      const old = get(doc.id);
      const meta = {
        id: doc.id, name: doc.name, w: doc.width, h: doc.height, time: Date.now(), bytes: 0, thumb: await thumbOf(doc, P),
        deleted: 0, srcKey: doc.recentId || old?.srcKey || null, edited: !!(old?.edited || doc.history?.serial), kind: 'doc',
      };
      meta.bytes = blobBytes(rec) + (meta.thumb?.size || 0);
      // a file opened from disk again replaces its untouched earlier entry
      const twins = meta.srcKey ? items.filter((x) => x.id !== meta.id && x.srcKey === meta.srcKey && !x.edited && !x.deleted && !P.docs.some((d) => d.id === x.id)) : [];
      await room(P, meta.bytes - (old?.bytes || 0), meta.id);
      await tx('readwrite', (m, d) => {
        m.put(meta);
        d.put(rec, meta.id);
        for (const x of twins) { m.delete(x.id); d.delete(x.id); }
      });
      for (const x of [old, ...twins]) if (x) items.splice(items.indexOf(x), 1);
      items.push(meta);
      stamps.set(doc, stamp);
      lastPut.set(doc, Date.now());
      changed();
      return true;
    } catch (err) {
      console.warn('photo library: document not kept', err);
      if (err?.name === 'QuotaExceededError') toast('브라우저 저장 공간이 부족해 문서를 홈 화면에 보관하지 못했습니다. 삭제됨을 비우거나 오래된 문서를 지워 주세요.');
      return false;
    }
  });
}

/** After an autosave: write the open documents that changed, each at most every PUT_EVERY ms. */
export function putSoon(P, docs) {
  for (const doc of docs) {
    if (!keepable(doc) || timers.has(doc) || (stamps.get(doc) === stampOf(doc) && get(doc.id))) continue;
    const wait = Math.max(1500, (lastPut.get(doc) || 0) + PUT_EVERY - Date.now());
    timers.set(doc, setTimeout(() => {
      timers.delete(doc);
      if (P.docs.includes(doc)) put(P, doc);
    }, wait));
  }
}

/** Make room for `need` more bytes: removed documents go first, then the oldest closed ones. */
async function room(P, need, keepId) {
  let used = usage();
  let limit = LIMIT;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) limit = Math.min(LIMIT, est.quota * 0.6);
  } catch { /* no estimate */ }
  const count = items.filter((x) => x.id !== keepId).length + 1;
  if (used + need <= limit && count <= MAX_ITEMS) return;
  const open = new Set(P.docs.map((d) => d.id));
  const order = [...trash().reverse(), ...recent().reverse()].filter((x) => x.id !== keepId && !open.has(x.id));
  const drop = [];
  let n = count;
  for (const x of order) {
    if (used + need <= limit && n <= MAX_ITEMS) break;
    drop.push(x.id);
    used -= x.bytes || 0;
    n--;
  }
  if (!drop.length) return;
  await purgeNow(drop);
  toast(`보관 공간(${Math.round(limit / MB)} MB)이 가득 차서 오래된 문서 ${drop.length}개를 지웠습니다.`);
}

// ---------------------------------------------------------------- reading and managing

const recDoc = (rec, meta) => (rec.file
  ? IO.openFile(rec.file instanceof File ? rec.file : new File([rec.file], `${meta.name}.png`, { type: rec.file.type }))
  : IO.docFromRecord(rec));

/** Opens an entry as a document with all its layers (switches to it when it is already open). */
export async function open(P, id) {
  const meta = get(id);
  if (!meta) return null;
  const at = P.docs.findIndex((d) => d.id === id);
  if (at >= 0) {
    P.switchDoc(at);
    return P.docs[at];
  }
  let rec = null;
  try {
    rec = await tx('readonly', (m, d) => d.get(id));
  } catch (err) {
    console.warn(err);
  }
  if (!rec) {
    toast(`"${meta.name}" 문서를 이 브라우저에서 찾을 수 없습니다.`);
    return null;
  }
  try {
    const doc = await recDoc(rec, meta);
    doc.id = id;
    doc.name = meta.name;
    doc.recentId = meta.srcKey;
    doc.saved = true;
    P.openDoc(doc);
    // a file kept from the earlier list becomes a layered document; others just move to the top
    if (rec.file) put(P, doc, { force: true });
    else await touch(id, { time: Date.now() });
    stamps.set(doc, stampOf(doc));
    lastPut.set(doc, Date.now());
    return doc;
  } catch (err) {
    console.error(err);
    toast(`"${meta.name}" 문서를 열 수 없습니다 (${err.message || err})`);
    return null;
  }
}

/** Changes an entry's fields (name, time, deleted…). */
export function touch(id, fields) {
  return queue(async () => {
    const meta = get(id);
    if (!meta) return;
    Object.assign(meta, fields);
    await tx('readwrite', (m) => m.put(meta)).catch((err) => console.warn(err));
    changed();
  });
}

export const rename = (id, name) => touch(id, { name });
/** Moves entries to 삭제됨. */
export const remove = (ids) => Promise.all([].concat(ids).map((id) => touch(id, { deleted: Date.now() })));
export const restore = (ids) => Promise.all([].concat(ids).map((id) => touch(id, { deleted: 0, time: Date.now() })));

async function purgeNow(ids) {
  await tx('readwrite', (m, d) => { for (const id of ids) { m.delete(id); d.delete(id); } }).catch((err) => console.warn(err));
  for (const id of ids) {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) items.splice(i, 1);
  }
}
/** Deletes entries for good. */
export function purge(ids) {
  return queue(async () => {
    await purgeNow([].concat(ids));
    changed();
  });
}

/** A copy of an entry as a new document on the list. */
export function duplicate(P, id) {
  return queue(async () => {
    const meta = get(id);
    if (!meta) return null;
    const rec = await tx('readonly', (m, d) => d.get(id));
    if (!rec) return null;
    const copy = { ...meta, id: uid('doc'), name: `${meta.name} 복사`, time: Date.now(), deleted: 0, srcKey: null, edited: true };
    await room(P, copy.bytes, copy.id);
    await tx('readwrite', (m, d) => { m.put(copy); d.put({ ...rec, id: copy.id, name: copy.name }, copy.id); });
    items.push(copy);
    changed();
    return copy;
  });
}

/** The entry as a .mphoto file (all layers), for saving to the computer. */
export async function projectBlob(id) {
  const meta = get(id);
  const rec = meta && (await tx('readonly', (m, d) => d.get(id)));
  if (!rec) return null;
  const doc = await recDoc(rec, meta);
  doc.name = meta.name;
  return new Blob([JSON.stringify(await IO.docToProject(doc))], { type: 'application/json' });
}

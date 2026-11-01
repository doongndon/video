// File ▸ Export, like Photoshop's submenu: Quick Export (in the format set in Export Preferences),
// Export As (format, image size and resampling, canvas size, quality, metadata, a preview with the
// file size, extra scales), Export Preferences, Save for Web (Legacy), Layer Comps to Files and
// Render Video. Also the shortcuts: Ctrl+Shift+' quick export, Ctrl+Alt+Shift+W export as,
// Ctrl+Alt+Shift+S save for web.

import { h, downloadBlob } from '../util.js';
import { openModal, toast, formRow, loadPref, savePref } from '../ui/common.js';
import { makeCanvas } from './doc.js';
import { quantize, indexedToImage, gifBlob, png8Blob, pngChunk } from './quantize.js';
import { read, toCanvas, hexRgb } from './fxutil.js';
import { applyCompState, compState } from './extra3.js';

export const EXPORT_FORMATS = [['png', 'PNG'], ['jpg', 'JPG'], ['gif', 'GIF'], ['webp', 'WebP']];
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const RESAMPLE = [['auto', '이중 입방 자동'], ['bilinear', '이중 선형'], ['nearest', '최단입점 (하드 가장자리 유지)']];
const QE_DEFAULT = { format: 'png', transparency: true, small: false, quality: 90, metadata: true };
export const quickExportPrefs = () => ({ ...QE_DEFAULT, ...loadPref('photo.quickExport', {}) });

// ---------------------------------------------------------------- metadata

/** File ▸ File Info of a document, when it has any. */
export function docMeta(doc) {
  const i = doc?.info || {};
  const m = { title: i.title || '', author: i.author || '', description: i.description || '', copyright: i.copyright || '', keywords: i.keywords || '' };
  return Object.values(m).some(Boolean) ? m : null;
}

const utf8 = (s) => new TextEncoder().encode(s);
const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 255);

/** PNG with iTXt chunks (UTF-8, so Korean survives) before IEND. */
export async function pngWithText(blob, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fields = [['Title', meta.title], ['Author', meta.author], ['Description', meta.description], ['Copyright', meta.copyright], ['Keywords', meta.keywords], ['Software', 'Montage']].filter(([, v]) => v);
  const chunks = fields.map(([k, v]) => {
    const key = latin1(k);
    const text = utf8(String(v).slice(0, 4000));
    // keyword \0 compression-flag compression-method language \0 translated-keyword \0 text
    const data = new Uint8Array(key.length + 5 + text.length);
    data.set(key, 0);
    data.set(text, key.length + 5);
    return pngChunk('iTXt', data);
  });
  // IEND is the last 12 bytes of a PNG
  const end = bytes.length - 12;
  return new Blob([bytes.subarray(0, end), ...chunks, bytes.subarray(end)], { type: 'image/png' });
}

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** JPEG with an XMP packet (Dublin Core: title, creator, description, rights, subject) after SOI/APP0. */
export async function jpegWithXmp(blob, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return blob;
  const alt = (tag, v) => (v ? `<dc:${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(v.slice(0, 2000))}</rdf:li></rdf:Alt></dc:${tag}>` : '');
  const kws = String(meta.keywords || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean);
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">${alt('title', meta.title)}${meta.author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEsc(meta.author.slice(0, 500))}</rdf:li></rdf:Seq></dc:creator>` : ''}${alt('description', meta.description)}${alt('rights', meta.copyright)}${kws.length ? `<dc:subject><rdf:Bag>${kws.map((k) => `<rdf:li>${xmlEsc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>` : ''}<xmp:CreatorTool>Montage</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const ns = latin1('http://ns.adobe.com/xap/1.0/\0');
  const body = utf8(xmp);
  const len = 2 + ns.length + body.length;
  if (len > 65535) return blob;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = len >> 8;
  seg[3] = len & 255;
  seg.set(ns, 4);
  seg.set(body, 4 + ns.length);
  // after the JFIF APP0 segment when there is one
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + ((bytes[4] << 8) | bytes[5]);
  return new Blob([bytes.subarray(0, at), seg, bytes.subarray(at)], { type: 'image/jpeg' });
}

// ---------------------------------------------------------------- encoding

/** A canvas resized with a resampling method ('auto' halves step by step for big reductions). */
export function resample(src, W, H, method = 'auto') {
  if (src.width === W && src.height === H) return src;
  let cur = src;
  if (method === 'auto') {
    // big reductions: halve first (each halving averages 2×2 pixels), then the last step
    while (cur.width / 2 >= W && cur.height / 2 >= H && cur.width > 2 && cur.height > 2) {
      const half = makeCanvas(Math.max(W, Math.ceil(cur.width / 2)), Math.max(H, Math.ceil(cur.height / 2)));
      const hg = half.getContext('2d');
      hg.imageSmoothingQuality = 'high';
      hg.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
  }
  const out = makeCanvas(W, H);
  const g = out.getContext('2d');
  if (method === 'nearest') g.imageSmoothingEnabled = false;
  else g.imageSmoothingQuality = method === 'bilinear' ? 'low' : 'high';
  g.drawImage(cur, 0, 0, W, H);
  return out;
}

/**
 * Encode a canvas. o: { format, quality 1..100, transparency, small (8-bit PNG), matte '#rrggbb',
 * meta (docMeta) | null }. Returns { blob, canvas (what the file shows), ext, note }.
 */
export async function encodeImage(c, o) {
  const fmt = o.format || 'png';
  const matte = o.matte || '#ffffff';
  if (fmt === 'gif' || (fmt === 'png' && o.small)) {
    const q = quantize(read(c), { colors: 256, palette: 'adaptive', dither: 'diffusion', amount: 100, transparency: o.transparency !== false, matte: hexRgb(matte) });
    let blob = fmt === 'gif' ? gifBlob(q) : await png8Blob(q);
    if (fmt === 'png' && o.meta) blob = await pngWithText(blob, o.meta);
    return { blob, canvas: toCanvas(indexedToImage(q)), ext: fmt };
  }
  let src = c;
  if (fmt === 'jpg' || o.transparency === false) {
    src = makeCanvas(c.width, c.height);
    const g = src.getContext('2d');
    g.fillStyle = matte;
    g.fillRect(0, 0, src.width, src.height);
    g.drawImage(c, 0, 0);
  }
  let blob = await new Promise((r) => src.toBlob(r, MIME[fmt], fmt === 'png' ? undefined : Math.max(0.01, Math.min(1, (o.quality ?? 90) / 100))));
  if (!blob) throw new Error('이미지를 만들지 못했습니다 (그림이 너무 클 수 있습니다)');
  let ext = fmt;
  let note = '';
  // a browser without a WebP encoder hands back a PNG
  if (fmt === 'webp' && blob.type !== 'image/webp') {
    ext = 'png';
    note = '이 브라우저는 WebP를 만들 수 없어 PNG로 저장합니다';
  }
  if (o.meta && ext === 'png') blob = await pngWithText(blob, o.meta);
  else if (o.meta && ext === 'jpg') blob = await jpegWithXmp(blob, o.meta);
  return { blob, canvas: src, ext, note, lossy: ext === 'jpg' || ext === 'webp' };
}

/** The picture placed (centred) on a canvas of another size, as Export As does. */
function onCanvas(img, CW, CH) {
  if (CW === img.width && CH === img.height) return img;
  const c = makeCanvas(CW, CH);
  c.getContext('2d').drawImage(img, Math.round((CW - img.width) / 2), Math.round((CH - img.height) / 2));
  return c;
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const extName = (doc) => (doc.name || '이미지').replace(/\.(png|jpe?g|gif|webp|psd|mphoto)$/i, '');

// ---------------------------------------------------------------- install

export function installExportAs(P) {
  const C = P.cmd;
  const need = () => {
    if (!P.doc) toast('내보낼 문서가 없습니다. 먼저 사진을 열거나 새 문서를 만드세요.');
    return !!P.doc;
  };
  const flat = () => P.doc.flatten({ fg: P.fg, bg: P.bg });

  /** File ▸ Export ▸ Quick Export as PNG (or the format chosen in Export Preferences). */
  C.quickExport = async () => {
    if (!need()) return;
    const doc = P.doc;
    const pref = quickExportPrefs();
    try {
      const r = await encodeImage(flat(), { ...pref, meta: pref.metadata ? docMeta(doc) : null });
      if (r.note) toast(r.note);
      const name = `${extName(doc)}.${r.ext}`;
      if (await downloadBlob(r.blob, name)) toast(`${name} 저장 (${fmtSize(r.blob.size)})`);
    } catch (err) {
      toast(String(err?.message || err));
    }
  };

  /** File ▸ Export ▸ Export Preferences: what Quick Export makes. */
  C.exportPrefs = () => {
    const p = quickExportPrefs();
    const fmt = h('select', EXPORT_FORMATS.map(([v, n]) => h('option', { value: v, selected: v === p.format }, n)));
    const transp = h('input', { type: 'checkbox', checked: p.transparency });
    const small = h('input', { type: 'checkbox', checked: p.small });
    const quality = h('input', { type: 'range', min: 1, max: 100, value: p.quality });
    const qv = h('span', `${p.quality}%`);
    quality.addEventListener('input', () => { qv.textContent = `${quality.value}%`; });
    const meta = h('input', { type: 'checkbox', checked: p.metadata });
    const rT = formRow('투명도', transp);
    const rS = formRow('더 작은 파일 (8비트)', small);
    const rQ = formRow('품질', quality, qv);
    const sync = () => {
      rT.hidden = fmt.value === 'jpg';
      rS.hidden = fmt.value !== 'png';
      rQ.hidden = !['jpg', 'webp'].includes(fmt.value);
    };
    fmt.addEventListener('change', sync);
    sync();
    openModal({
      title: '내보내기 환경 설정',
      width: '420px',
      body: [h('div.ph-sub', '빠른 내보내기'), formRow('형식', fmt), rT, rS, rQ, formRow('메타데이터 (파일 정보)', meta), h('div.note', '파일 ▸ 내보내기 ▸ 빠른 내보내기가 이 설정으로 바로 저장합니다.')],
      buttons: [{ label: '취소' }, { label: '확인', primary: true, action: () => savePref('photo.quickExport', { format: fmt.value, transparency: transp.checked, small: small.checked, quality: +quality.value, metadata: meta.checked }) }],
    });
  };

  /** File ▸ Export ▸ Export As… */
  C.exportAs = () => {
    if (!need()) return;
    const doc = P.doc;
    // with artboards (artboards.js): one artboard is previewed, and all of them (one file each) or
    // the chosen one are exported, like Photoshop
    const pics = P.artboardPictures?.(doc) || [];
    let src = pics.length ? pics[0].canvas : flat();
    const abSel = pics.length ? h('select', { 'aria-label': '대지' }, h('option', { value: 'all' }, `모든 대지 (${pics.length}개)`), pics.map((p, i) => h('option', { value: String(i) }, p.name))) : null;
    const prev = loadPref('photo.exportAs', {});
    const fmt = h('select', { 'aria-label': '형식' }, EXPORT_FORMATS.map(([v, n]) => h('option', { value: v, selected: v === (prev.format || 'png') }, n)));
    const transp = h('input', { type: 'checkbox', checked: prev.transparency !== false });
    const small = h('input', { type: 'checkbox', checked: !!prev.small });
    const quality = h('input', { type: 'range', min: 1, max: 100, value: prev.quality || 90, 'aria-label': '품질' });
    const qv = h('span.ph-hint', `${quality.value}%`);
    const matte = h('input', { type: 'color', value: prev.matte || '#ffffff', 'aria-label': '매트 색' });
    const wIn = h('input.ph-num', { type: 'number', min: 1, max: 30000, value: src.width, 'aria-label': '폭' });
    const hIn = h('input.ph-num', { type: 'number', min: 1, max: 30000, value: src.height, 'aria-label': '높이' });
    const pct = h('select', { 'aria-label': '비율' }, [25, 33.33, 50, 66.67, 75, 100, 150, 200, 300, 400].map((v) => h('option', { value: v, selected: v === 100 }, `${Math.round(v)}%`)), h('option', { value: 'custom' }, '사용자 정의'));
    const method = h('select', { 'aria-label': '리샘플링' }, RESAMPLE.map(([v, n]) => h('option', { value: v, selected: v === (prev.method || 'auto') }, n)));
    const cwIn = h('input.ph-num', { type: 'number', min: 1, max: 30000, value: src.width, 'aria-label': '캔버스 폭' });
    const chIn = h('input.ph-num', { type: 'number', min: 1, max: 30000, value: src.height, 'aria-label': '캔버스 높이' });
    const meta = h('select', { 'aria-label': '메타데이터' }, h('option', { value: 'none' }, '없음'), h('option', { value: 'info' }, '저작권 및 연락처 정보'));
    meta.value = prev.meta === 'none' ? 'none' : 'info';
    const extra = [0.5, 2, 3].map((k) => ({ k, box: h('input', { type: 'checkbox', checked: (prev.extra || []).includes(k) }) }));
    const zoom = h('select', { 'aria-label': '미리 보기 확대' }, h('option', { value: 'fit' }, '맞추기'), h('option', { value: '1' }, '100%'), h('option', { value: '2' }, '200%'));
    const view = h('canvas.ph-xpview');
    const viewWrap = h('div.ph-xpwrap', view);
    const info = h('div.ph-xpinfo', '');
    const busy = h('span.ph-xpbusy', { hidden: true }, '계산 중…');
    let lockCanvas = true;
    let ratio = src.width / src.height;
    const sizeFromPct = () => {
      if (pct.value === 'custom') return;
      const k = +pct.value / 100;
      wIn.value = Math.max(1, Math.round(src.width * k));
      hIn.value = Math.max(1, Math.round(src.height * k));
    };
    abSel?.addEventListener('change', () => {
      // a custom size keeps its scale on the newly shown artboard
      const k = +wIn.value / src.width;
      src = pics[abSel.value === 'all' ? 0 : +abSel.value].canvas;
      ratio = src.width / src.height;
      if (pct.value === 'custom') {
        wIn.value = Math.max(1, Math.round(src.width * k));
        hIn.value = Math.max(1, Math.round(src.height * k));
      } else sizeFromPct();
      lockCanvas = true;
      canvasFollow();
      refresh();
    });
    const canvasFollow = () => {
      if (!lockCanvas) return;
      cwIn.value = wIn.value;
      chIn.value = hIn.value;
    };
    pct.addEventListener('change', () => { sizeFromPct(); canvasFollow(); refresh(); });
    wIn.addEventListener('input', () => { hIn.value = Math.max(1, Math.round(+wIn.value / ratio)); pct.value = 'custom'; canvasFollow(); refresh(); });
    hIn.addEventListener('input', () => { wIn.value = Math.max(1, Math.round(+hIn.value * ratio)); pct.value = 'custom'; canvasFollow(); refresh(); });
    for (const i of [cwIn, chIn]) i.addEventListener('input', () => { lockCanvas = false; refresh(); });
    quality.addEventListener('input', () => { qv.textContent = `${quality.value}%`; });
    const resetCanvas = h('button.small', { onclick: () => { lockCanvas = true; canvasFollow(); refresh(); } }, '이미지 크기에 맞춤');
    const rowTransp = formRow('투명도', transp);
    const rowSmall = formRow('더 작은 파일 (8비트)', small);
    const rowQ = formRow('품질', quality, qv);
    const rowMatte = formRow('매트 (투명한 곳의 색)', matte);
    const settings = () => ({
      format: fmt.value, transparency: transp.checked, small: small.checked, quality: +quality.value, matte: matte.value,
      W: Math.max(1, Math.min(30000, Math.round(+wIn.value || 1))), H: Math.max(1, Math.min(30000, Math.round(+hIn.value || 1))),
      CW: Math.max(1, Math.min(30000, Math.round(+cwIn.value || 1))), CH: Math.max(1, Math.min(30000, Math.round(+chIn.value || 1))),
      method: method.value, meta: meta.value,
    });
    const sync = () => {
      const f = fmt.value;
      rowTransp.hidden = f === 'jpg';
      rowSmall.hidden = f !== 'png';
      rowQ.hidden = !['jpg', 'webp'].includes(f);
      rowMatte.hidden = !(f === 'jpg' || f === 'gif' || !transp.checked);
    };
    /** The picture at the chosen sizes (before encoding). */
    const build = (s, k = 1) => {
      const W = Math.max(1, Math.round(s.W * k));
      const H = Math.max(1, Math.round(s.H * k));
      const img = resample(src, W, H, s.method);
      return onCanvas(img, Math.max(1, Math.round(s.CW * k)), Math.max(1, Math.round(s.CH * k)));
    };
    const encode = (s, c) => encodeImage(c, { ...s, meta: s.meta === 'info' ? docMeta(doc) : null });
    let token = 0;
    let timer = 0;
    let last = null;
    const draw = () => {
      if (!last) return;
      const c = last.shown;
      const z = zoom.value;
      if (z === 'fit') {
        const k = Math.min(1, 520 / c.width, 360 / c.height);
        view.width = Math.max(1, Math.round(c.width * k));
        view.height = Math.max(1, Math.round(c.height * k));
        view.style.width = '';
      } else {
        // a big preview is cut to what can be scrolled comfortably
        const k = +z;
        view.width = Math.min(4096, Math.round(c.width * k));
        view.height = Math.min(4096, Math.round(c.height * k));
      }
      const g = view.getContext('2d');
      g.clearRect(0, 0, view.width, view.height);
      g.imageSmoothingEnabled = z === 'fit';
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, z === 'fit' ? view.width : c.width * +z, z === 'fit' ? view.height : c.height * +z);
    };
    zoom.addEventListener('change', draw);
    const refresh = () => {
      sync();
      clearTimeout(timer);
      busy.hidden = false;
      timer = setTimeout(async () => {
        const my = ++token;
        const s = settings();
        if (s.CW * s.CH > 120e6 || s.W * s.H > 120e6) {
          busy.hidden = true;
          info.textContent = '너무 큽니다 (1억 2천만 픽셀까지)';
          return;
        }
        try {
          const c = build(s);
          const r = await encode(s, c);
          if (my !== token) return;
          // lossy files are shown as they will look (decoded again)
          const shown = r.lossy ? await createImageBitmap(r.blob) : r.canvas;
          if (my !== token) return;
          last = { shown, r };
          draw();
          info.textContent = `${s.CW} × ${s.CH} px · ${r.ext.toUpperCase()} · ${fmtSize(r.blob.size)}${r.note ? ` · ${r.note}` : ''}`;
        } catch (err) {
          if (my === token) info.textContent = String(err?.message || err);
        } finally {
          if (my === token) busy.hidden = true;
        }
      }, 220);
    };
    for (const e of [fmt, transp, small, matte, method, meta]) e.addEventListener('change', refresh);
    quality.addEventListener('change', refresh);
    const metaNote = h('div.note', docMeta(doc) ? '파일 ▸ 파일 정보의 제목·만든 사람·저작권을 파일에 넣습니다 (PNG·JPG).' : '파일 ▸ 파일 정보에 저작권 등을 적어 두면 파일에 함께 넣습니다 (PNG·JPG).');
    const side = h('div.ph-xpside',
      ...(abSel ? [h('div.ph-sub', '대지'), formRow('내보낼 대지', abSel)] : []),
      h('div.ph-sub', '파일 설정'), formRow('형식', fmt), rowTransp, rowSmall, rowQ, rowMatte,
      h('div.ph-sub', '이미지 크기'), formRow('폭 (px)', wIn), formRow('높이 (px)', hIn), formRow('비율', pct), formRow('리샘플링', method),
      h('div.ph-sub', '캔버스 크기'), formRow('폭 (px)', cwIn), formRow('높이 (px)', chIn), h('div.inline', resetCanvas),
      h('div.ph-sub', '메타데이터'), formRow('넣을 정보', meta), metaNote,
      h('div.ph-sub', '추가 배율 (함께 저장)'), h('div.ph-xpextra', extra.map(({ k, box }) => h('label.ph-xpchk', box, ` ${k}x`))));
    const body = h('div.ph-xp', h('div.ph-xpmain', h('div.ph-xptop', info, busy, h('span.ph-xpspacer'), zoom), viewWrap), side);
    openModal({
      title: '내보내기 형식',
      width: 'min(980px, 96vw)',
      peek: false,
      body,
      buttons: [{ label: '취소' }, {
        label: '내보내기', primary: true, action: async () => {
          const s = settings();
          savePref('photo.exportAs', { format: s.format, transparency: s.transparency, small: s.small, quality: s.quality, matte: s.matte, method: s.method, meta: s.meta, extra: extra.filter((x) => x.box.checked).map((x) => x.k) });
          try {
            if (abSel?.value === 'all') {
              // every artboard at the same scale, a file each (named after the artboard)
              const k0 = s.W / src.width;
              const keep = src;
              let n = 0;
              try {
                for (const pic of pics) {
                  src = pic.canvas;
                  for (const k of [1, ...extra.filter((x) => x.box.checked).map((x) => x.k)]) {
                    const W = Math.max(1, Math.round(src.width * k0));
                    const H = Math.max(1, Math.round(src.height * k0));
                    const r = await encode(s, build({ ...s, W, H, CW: W, CH: H }, k));
                    if (await downloadBlob(r.blob, `${extName(doc)}_${pic.name.replace(/[\\/:*?"<>|]/g, '_')}${k === 1 ? '' : `@${k}x`}.${r.ext}`)) n++;
                  }
                }
              } finally {
                src = keep;
              }
              toast(`대지 ${pics.length}개를 ${n}개 파일로 내보냈습니다`);
              return undefined;
            }
            const base = abSel ? `${extName(doc)}_${pics[+abSel.value].name.replace(/[\\/:*?"<>|]/g, '_')}` : extName(doc);
            const r = await encode(s, build(s));
            if (r.note) toast(r.note);
            if (!(await downloadBlob(r.blob, `${base}.${r.ext}`))) return false;
            let n = 1;
            for (const { k, box } of extra) {
              if (!box.checked) continue;
              const rk = await encode(s, build(s, k));
              await downloadBlob(rk.blob, `${base}@${k}x.${rk.ext}`);
              n++;
            }
            toast(n > 1 ? `${n}개 파일로 내보냈습니다` : `${base}.${r.ext} 저장 (${fmtSize(r.blob.size)})`);
            return undefined;
          } catch (err) {
            toast(String(err?.message || err));
            return false;
          }
        },
      }],
    });
    sizeFromPct();
    refresh();
  };

  /** File ▸ Export ▸ Layer Comps to Files: one picture per layer comp. */
  C.compsToFiles = async () => {
    if (!need()) return;
    const doc = P.doc;
    const comps = doc.comps || [];
    if (!comps.length) return toast('레이어 구성요소가 없습니다 (창 ▸ 레이어 구성요소에서 만드세요)');
    const pref = quickExportPrefs();
    const back = compState(doc);
    const saved = doc.saved;
    const pics = [];
    try {
      for (const c of comps) {
        applyCompState(doc, c.state);
        pics.push([c.name, doc.flatten({ fg: P.fg, bg: P.bg })]);
      }
    } finally {
      applyCompState(doc, back);
      doc.saved = saved;
      P.redraw();
    }
    let n = 0;
    for (const [name, c] of pics) {
      const r = await encodeImage(c, { ...pref, meta: pref.metadata ? docMeta(doc) : null });
      if (await downloadBlob(r.blob, `${extName(doc)}_${name.replace(/[\\/:*?"<>|]/g, '_')}.${r.ext}`)) n++;
    }
    toast(`레이어 구성요소 ${n}개를 파일로 저장했습니다 (${quickExportPrefs().format.toUpperCase()})`);
    return undefined;
  };

  // the top bar's Export button and the phone's
  P.exportDialog = () => (P.doc ? C.exportAs() : toast('내보낼 문서가 없습니다. 먼저 사진을 열거나 새 문서를 만드세요.'));

  // ---- shortcuts (Photoshop's): Ctrl+Shift+' quick export, Ctrl+Alt+Shift+W export as, Ctrl+Alt+Shift+S save for web
  const prevKeys = P.viewKeys;
  P.viewKeys = (e, mod) => {
    if (mod && e.shiftKey && !e.altKey && e.code === 'Quote') return C.quickExport(), true;
    if (mod && e.shiftKey && e.altKey && e.code === 'KeyW') return C.exportAs(), true;
    if (mod && e.shiftKey && e.altKey && e.code === 'KeyS') return C.saveForWeb?.(), true;
    return prevKeys ? prevKeys(e, mod) : false;
  };

  // ---- File ▸ Export: one submenu like Photoshop's. Built after every other module has added its
  // File items (they may look for the old entries), by queueing a last step.
  P.extendMenus = P.extendMenus || [];
  P.extendMenus.push(() => {
    P.extendMenus.push(() => {
      const orig = P.menus['파일'];
      if (!orig) return;
      P.menus['파일'] = () => fileMenu(orig());
    });
  });
  const exportItems = () => {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    const no = !P.doc;
    const qf = quickExportPrefs().format.toUpperCase();
    return [
      { label: `빠른 내보내기 (${qf} 형식)`, key: `${mod}Shift+'`, disabled: no, action: () => C.quickExport() },
      { label: '내보내기 형식…', key: `${mod}Alt+Shift+W`, disabled: no, action: () => C.exportAs() },
      { label: '내보내기 환경 설정…', action: () => C.exportPrefs() },
      '-',
      { label: '웹용으로 저장 (레거시)…', key: `${mod}Alt+Shift+S`, disabled: no || !C.saveForWeb, action: () => C.saveForWeb() },
      '-',
      { label: '대지를 파일로…', disabled: no || !C.artboardsToFiles || !P.doc.layers.some((l) => l.artboard), action: () => C.artboardsToFiles() },
      { label: '레이어를 파일로…', disabled: no || !C.exportLayers, action: () => C.exportLayers() },
      { label: '레이어 구성요소를 파일로…', disabled: no || !P.doc?.comps?.length, action: () => C.compsToFiles() },
      '-',
      { label: '애니메이션 GIF로 내보내기…', disabled: no, action: () => P.timelineExportGif?.() },
      { label: '비디오 렌더… (MP4 · WebM)', disabled: no, action: () => P.timelineRenderVideo?.() },
    ];
  };
  P.exportMenuItems = exportItems;
  const OLD = ['레이어를 파일로 내보내기', '내보내기 (PNG', '빠른 내보내기', '웹용으로 저장'];
  const fileMenu = (items) => {
    const isOld = (x) => typeof x === 'object' && x?.label && OLD.some((o) => x.label.startsWith(o));
    const first = items.findIndex(isOld);
    const out = items.filter((x) => !isOld(x));
    const sub = { label: '내보내기', disabled: false, submenu: exportItems };
    if (first >= 0) out.splice(Math.min(first, out.length), 0, sub);
    else out.push(sub);
    return out;
  };
}

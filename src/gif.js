// Minimal animated GIF89a encoder: one global 256-colour palette (median cut over sampled
// pixels), ordered dithering, LZW compression and an infinite loop.

function medianCut(samples, maxColors) {
  // samples: Uint8Array of r,g,b triplets
  let boxes = [{ idx: Array.from({ length: samples.length / 3 }, (_, i) => i) }];
  const range = (box) => {
    const mn = [255, 255, 255];
    const mx = [0, 0, 0];
    for (const i of box.idx) {
      for (let c = 0; c < 3; c++) {
        const v = samples[i * 3 + c];
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
    }
    const spans = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = spans.indexOf(Math.max(...spans));
    return { ch, span: spans[ch] };
  };
  while (boxes.length < maxColors) {
    let best = -1;
    let bestSpan = 0;
    let bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.idx.length < 2) return;
      const r = range(b);
      const score = r.span * Math.log2(b.idx.length + 1);
      if (score > bestSpan) {
        bestSpan = score;
        best = i;
        bestCh = r.ch;
      }
    });
    if (best < 0) break;
    const box = boxes[best];
    box.idx.sort((a, b) => samples[a * 3 + bestCh] - samples[b * 3 + bestCh]);
    const mid = box.idx.length >> 1;
    boxes.splice(best, 1, { idx: box.idx.slice(0, mid) }, { idx: box.idx.slice(mid) });
  }
  return boxes.map((b) => {
    const sum = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) sum[c] += samples[i * 3 + c];
    return sum.map((v) => Math.round(v / Math.max(1, b.idx.length)));
  });
}

function lzw(indices, minCode) {
  const out = [];
  let cur = 0;
  let curBits = 0;
  const write = (code, size) => {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      curBits -= 8;
    }
  };
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  write(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    write(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      write(clear, size);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  write(prefix, size);
  write(eoi, size);
  if (curBits > 0) out.push(cur & 255);
  return out;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 12);

/** frames: array of RGBA Uint8ClampedArray (w*h*4). Returns a Blob (image/gif). */
export async function encodeGif(frames, w, h, fps, onProgress = () => {}) {
  // palette from pixels sampled across all frames
  const want = 24000;
  const per = Math.max(1, Math.floor(want / frames.length));
  const samples = new Uint8Array(per * frames.length * 3);
  let o = 0;
  for (const f of frames) {
    const stepPx = Math.max(1, Math.floor((w * h) / per));
    for (let k = 0, p = 0; k < per; k++, p += stepPx) {
      const i = (p % (w * h)) * 4;
      samples[o++] = f[i];
      samples[o++] = f[i + 1];
      samples[o++] = f[i + 2];
    }
  }
  const palette = medianCut(samples.subarray(0, o), 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = cache[key];
    if (v >= 0) return v;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const [pr, pg, pb] = palette[i];
      const d = (pr - r) * (pr - r) * 3 + (pg - g) * (pg - g) * 4 + (pb - b) * (pb - b) * 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };

  const bytes = [];
  const push16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  for (const c of 'GIF89a') bytes.push(c.charCodeAt(0));
  push16(w);
  push16(h);
  bytes.push(0xf7, 0, 0); // global colour table, 8 bits
  for (const [r, g, b] of palette) bytes.push(r, g, b);
  // loop forever
  bytes.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 0x03, 0x01, 0, 0, 0);
  const delay = Math.max(2, Math.round(100 / fps));
  const idx = new Uint8Array(w * h);
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const d = BAYER[(y & 3) * 4 + (x & 3)];
        const i = p * 4;
        const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
        idx[p] = nearest(cl(f[i] + d), cl(f[i + 1] + d), cl(f[i + 2] + d));
      }
    }
    bytes.push(0x21, 0xf9, 0x04, 0x04, delay & 255, (delay >> 8) & 255, 0, 0);
    bytes.push(0x2c);
    push16(0);
    push16(0);
    push16(w);
    push16(h);
    bytes.push(0);
    bytes.push(8);
    const data = lzw(idx, 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
    if (fi % 4 === 0) {
      onProgress((fi + 1) / frames.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

export { medianCut };

/**
 * A GIF from frames of palette indices sharing one palette (up to 256 colours). frames:
 * [{ indices: Uint8Array(w*h), delay: hundredths of a second }]; `transparent` is a palette index
 * shown as see-through (-1: none); `loop` 0 = forever, null = play once.
 */
export function encodeIndexedGif(frames, palette, w, h, { transparent = -1, loop = 0 } = {}) {
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const size = 1 << bits;
  const bytes = [];
  const push16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  for (const c of 'GIF89a') bytes.push(c.charCodeAt(0));
  push16(w);
  push16(h);
  bytes.push(0x80 | 0x70 | (bits - 1), 0, 0);
  for (let i = 0; i < size; i++) {
    const c = palette[i] || [0, 0, 0];
    bytes.push(c[0], c[1], c[2]);
  }
  if (frames.length > 1 && loop != null) bytes.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 0x03, 0x01, loop & 255, (loop >> 8) & 255, 0);
  const minCode = Math.max(2, bits);
  for (const f of frames) {
    const delay = Math.max(0, Math.round(f.delay || 0));
    // disposal 2 (restore to background) when frames have see-through parts
    bytes.push(0x21, 0xf9, 0x04, (transparent >= 0 ? 0x08 | 1 : 0x04), delay & 255, (delay >> 8) & 255, transparent >= 0 ? transparent : 0, 0);
    bytes.push(0x2c);
    push16(0);
    push16(0);
    push16(w);
    push16(h);
    bytes.push(0);
    bytes.push(minCode);
    const data = lzw(f.indices, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

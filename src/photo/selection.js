// Selections: a doc-size canvas whose alpha is the selection amount. Selections are replaced, never
// changed in place (undo keeps references to them). Also the marching-ants outline.

import { makeCanvas, alphaBox } from './doc.js';

const blank = (doc) => makeCanvas(doc.width, doc.height);

/** Combine a new shape selection with the current one. mode: 'new' | 'add' | 'sub' | 'inter'. */
export function combine(doc, shape, mode = 'new') {
  const old = doc.selection?.canvas;
  if (mode === 'new' || !old) return shape && hasPixels(shape) ? { canvas: shape } : null;
  const c = blank(doc);
  const g = c.getContext('2d');
  g.drawImage(old, 0, 0);
  g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'sub' ? 'destination-out' : 'destination-in';
  g.drawImage(shape, 0, 0);
  return hasPixels(c) ? { canvas: c } : null;
}

function hasPixels(c) {
  const small = makeCanvas(64, 64);
  const g = small.getContext('2d');
  g.drawImage(c, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  // tiny selections can vanish when shrunk: check the real pixels around the bounds
  return !!alphaBounds(c);
}

/** Selection shape from a path builder (in doc coords), optionally feathered. */
export function shapeMask(doc, build, feather = 0, antialias = true) {
  const c = blank(doc);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = antialias;
  if (feather > 0) g.filter = `blur(${feather / 2}px)`;
  g.fillStyle = '#000';
  const p = new Path2D();
  build(p);
  g.fill(p);
  return c;
}

export const rectPath = (x, y, w, h) => (p) => p.rect(x, y, w, h);
export const ellipsePath = (x, y, w, h) => (p) => p.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
export const polyPath = (pts) => (p) => {
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
};

export function selectAll(doc) {
  const c = blank(doc);
  const g = c.getContext('2d');
  g.fillRect(0, 0, c.width, c.height);
  return { canvas: c };
}

export function invert(doc) {
  const c = blank(doc);
  const g = c.getContext('2d');
  g.fillRect(0, 0, c.width, c.height);
  if (doc.selection) {
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(doc.selection.canvas, 0, 0);
  }
  return hasPixels(c) ? { canvas: c } : null;
}

/**
 * Feather by radius r. Like Photoshop (unless `atBounds`), the canvas edges stay put: the selection
 * is taken to go on beyond them, so a selection touching an edge does not fade there.
 */
export function feather(doc, r, atBounds = false) {
  if (!doc.selection) return null;
  const src = doc.selection.canvas;
  const W = doc.width;
  const H = doc.height;
  const c = blank(doc);
  const g = c.getContext('2d');
  if (atBounds) {
    g.filter = `blur(${r / 2}px)`;
    g.drawImage(src, 0, 0);
    return hasPixels(c) ? { canvas: c } : null;
  }
  // repeat the edge rows and columns outwards before blurring
  const p = Math.ceil(r * 1.5) + 2;
  const big = makeCanvas(W + 2 * p, H + 2 * p);
  const bg = big.getContext('2d');
  bg.imageSmoothingEnabled = false;
  bg.drawImage(src, p, p);
  bg.drawImage(src, 0, 0, 1, H, 0, p, p, H);
  bg.drawImage(src, W - 1, 0, 1, H, W + p, p, p, H);
  bg.drawImage(big, 0, p, W + 2 * p, 1, 0, 0, W + 2 * p, p);
  bg.drawImage(big, 0, H + p - 1, W + 2 * p, 1, 0, H + p, W + 2 * p, p);
  g.filter = `blur(${r / 2}px)`;
  g.drawImage(big, -p, -p);
  return hasPixels(c) ? { canvas: c } : null;
}

/** A selection canvas with its partly selected pixels made all or nothing (no anti-aliasing). */
export function hardEdge(c) {
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  g.putImageData(img, 0, 0);
  return c;
}

/** Grow (n > 0) or shrink (n < 0) by about n pixels. */
export function grow(doc, n) {
  if (!doc.selection) return null;
  const c = blank(doc);
  const g = c.getContext('2d');
  g.filter = `blur(${Math.abs(n) / 2}px)`;
  g.drawImage(doc.selection.canvas, 0, 0);
  g.filter = 'none';
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // after the blur, a low threshold grows the shape and a high one shrinks it
  const th = n > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= th ? 255 : 0;
  g.putImageData(img, 0, 0);
  return hasPixels(c) ? { canvas: c } : null;
}

/** Selection from a layer's opaque pixels (Ctrl+click on a layer thumbnail). */
export function fromLayer(doc, layer) {
  const c = blank(doc);
  const g = c.getContext('2d');
  const cont = doc.content(layer);
  if (cont) g.drawImage(cont.canvas, cont.x, cont.y);
  return hasPixels(c) ? { canvas: c } : null;
}

/**
 * Magic wand: pixels similar to the one at (x, y). source: doc-size canvas to sample. sample: the
 * size of the square averaged for the colour clicked (Photoshop's Sample Size, 1 = point); antialias
 * softens the outline by about a pixel.
 */
export function magicWand(doc, source, x, y, { tolerance = 32, contiguous = true, sample = 1, antialias = false } = {}) {
  const w = doc.width;
  const h = doc.height;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const d = source.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sa = 0;
  let cnt = 0;
  const k = Math.max(0, Math.floor((sample || 1) / 2));
  for (let yy = Math.max(0, y - k); yy <= Math.min(h - 1, y + k); yy++) {
    for (let xx = Math.max(0, x - k); xx <= Math.min(w - 1, x + k); xx++) {
      const o = (yy * w + xx) * 4;
      sr += d[o];
      sg += d[o + 1];
      sb += d[o + 2];
      sa += d[o + 3];
      cnt++;
    }
  }
  sr /= cnt;
  sg /= cnt;
  sb /= cnt;
  sa /= cnt;
  const near = (o) => Math.max(Math.abs(d[o] - sr), Math.abs(d[o + 1] - sg), Math.abs(d[o + 2] - sb), Math.abs(d[o + 3] - sa)) <= tolerance;
  if (contiguous) {
    const stack = [x, y];
    while (stack.length) {
      const py = stack.pop();
      let px = stack.pop();
      while (px >= 0 && !mask[py * w + px] && near((py * w + px) * 4)) px--;
      px++;
      let up = false;
      let down = false;
      while (px < w && !mask[py * w + px] && near((py * w + px) * 4)) {
        mask[py * w + px] = 1;
        if (py > 0) {
          const ok = !mask[(py - 1) * w + px] && near(((py - 1) * w + px) * 4);
          if (ok && !up) stack.push(px, py - 1);
          up = ok;
        }
        if (py < h - 1) {
          const ok = !mask[(py + 1) * w + px] && near(((py + 1) * w + px) * 4);
          if (ok && !down) stack.push(px, py + 1);
          down = ok;
        }
        px++;
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) if (near(i * 4)) mask[i] = 1;
  }
  if (contiguous && !mask[y * w + x]) return null;
  return antialias ? softMaskCanvas(mask, w, h) : maskToCanvas(mask, w, h);
}

/** A 0/1 mask as a selection canvas with a one-pixel soft edge (a 1-2-1 tent across the outline). */
function softMaskCanvas(mask, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const out = img.data;
  const at = (xx, yy) => mask[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
  for (let yy = 0; yy < h; yy++) {
    const inner = yy > 0 && yy < h - 1;
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      const m = mask[i];
      // pixels away from the outline keep their value; only the outline is filtered (away from the
      // picture's border the neighbours are read directly, which is the same as at() there)
      const edge = inner && xx > 0 && xx < w - 1
        ? mask[i - 1] !== m || mask[i + 1] !== m || mask[i - w] !== m || mask[i + w] !== m
        : at(xx - 1, yy) !== m || at(xx + 1, yy) !== m || at(xx, yy - 1) !== m || at(xx, yy + 1) !== m;
      if (!edge) {
        out[i * 4 + 3] = m ? 255 : 0;
        continue;
      }
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) v += at(xx + dx, yy + dy) * (dx ? 1 : 2) * (dy ? 1 : 2);
      }
      out[i * 4 + 3] = Math.round((v / 16) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function maskToCanvas(mask, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) if (mask[i]) img.data[i * 4 + 3] = 255;
  g.putImageData(img, 0, 0);
  return c;
}

/** Bounding box of pixels with alpha > 0 (read from the edges inward, see doc.js alphaBox). */
export function alphaBounds(c) {
  return alphaBox(c);
}

/**
 * Marching ants: edge pixels of the selection at screen resolution. Returns {img, x, y} to draw on
 * the overlay, recomputed when the selection or view changes; `phase` animates the dashes.
 */
export function antsImage(sel, view, w, h, phase) {
  if (!sel) return null;
  const key = `${view.zoom}:${view.x}:${view.y}:${w}:${h}`;
  if (sel._ants?.key !== key) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.setTransform(view.zoom, 0, 0, view.zoom, view.x, view.y);
    g.drawImage(sel.canvas, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    const edges = [];
    const inside = (i) => d[i * 4 + 3] >= 128;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!inside(i)) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inside(i - 1) || !inside(i + 1) || !inside(i - w) || !inside(i + w)) edges.push(i);
      }
    }
    // the box around the edges (the caller can put back just that part)
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (const i of edges) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    sel._ants = { key, edges: Int32Array.from(edges), box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  }
  // the same picture every tick (only the edge pixels change): a new screen-sized one each time kept
  // the garbage collector busy while the ants ran
  let img = sel._ants.img;
  if (!img || img.width !== w || img.height !== h) img = sel._ants.img = new ImageData(w, h);
  img.box = sel._ants.box;
  const out = img.data;
  for (const i of sel._ants.edges) {
    const x = i % w;
    const y = (i / w) | 0;
    const on = (((x + y + phase) >> 2) & 1) === 0;
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = on ? 0 : 255;
    out[o + 3] = 255;
  }
  return img;
}

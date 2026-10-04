// Selections: a doc-size canvas whose alpha is the selection amount. Selections are replaced, never
// changed in place (undo keeps references to them). Also the marching-ants outline.

import { makeCanvas } from './doc.js';

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

export function feather(doc, r) {
  if (!doc.selection) return null;
  const c = blank(doc);
  const g = c.getContext('2d');
  g.filter = `blur(${r / 2}px)`;
  g.drawImage(doc.selection.canvas, 0, 0);
  return { canvas: c };
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

/** Magic wand: pixels similar to the one at (x, y). source: doc-size canvas to sample. */
export function magicWand(doc, source, x, y, { tolerance = 32, contiguous = true } = {}) {
  const w = doc.width;
  const h = doc.height;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const d = source.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  const o0 = (y * w + x) * 4;
  const sr = d[o0];
  const sg = d[o0 + 1];
  const sb = d[o0 + 2];
  const sa = d[o0 + 3];
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
  return maskToCanvas(mask, w, h);
}

export function maskToCanvas(mask, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) if (mask[i]) img.data[i * 4 + 3] = 255;
  g.putImageData(img, 0, 0);
  return c;
}

/** Bounding box of pixels with alpha > 0. */
export function alphaBounds(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        y0 = Math.min(y0, y);
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
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
    sel._ants = { key, edges: Int32Array.from(edges) };
  }
  const img = new ImageData(w, h);
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

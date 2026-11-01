// Worker for Edit ▸ Content-Aware Fill: runs the fill off the main thread so the workspace stays
// responsive while the preview is rebuilt.

import { contentAwareFill } from './inpaint.js';

self.onmessage = (e) => {
  const { id, data, w, h, hole, sample, opts } = e.data;
  try {
    contentAwareFill(data, w, h, hole, sample, opts);
    self.postMessage({ id, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

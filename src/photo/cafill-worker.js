// Worker for content-aware fills: Edit ▸ Content-Aware Fill (cafill.js) and the end of a spot healing
// brush / remove tool stroke (op 'inpaint', brushes.js) run here so the workspace stays responsive.

import { contentAwareFill, inpaint } from './inpaint.js';

self.onmessage = (e) => {
  const { id, op, data, w, h, hole, sample, avoid, opts } = e.data;
  try {
    if (op === 'inpaint') inpaint(data, w, h, hole, { avoid });
    else contentAwareFill(data, w, h, hole, sample, opts);
    self.postMessage({ id, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

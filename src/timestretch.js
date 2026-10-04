// Offline audio retiming for export: renders a clip's audio along an arbitrary time map
// (speed, speed ramps, reverse) either with pitch preserved (WSOLA) or as varispeed.

/**
 * src: AudioBuffer holding the source audio (already reversed when the clip is reversed).
 * posAt(t): source position in seconds within `src` for output time t (seconds from output start).
 * duration: output length in seconds. Returns an AudioBuffer at the source sample rate.
 */
export function retimeAudio(src, posAt, duration, { maintainPitch = true } = {}) {
  const sr = src.sampleRate;
  const n = Math.max(1, Math.ceil(duration * sr));
  const chs = src.numberOfChannels;
  const out = new AudioBuffer({ length: n, numberOfChannels: chs, sampleRate: sr });
  const inData = [...Array(chs)].map((_, c) => src.getChannelData(c));
  const outData = [...Array(chs)].map((_, c) => out.getChannelData(c));
  const len = src.length;

  // sample the time map coarsely and interpolate (the map is smooth)
  const STEP = 64;
  const nCtl = Math.ceil(n / STEP) + 2;
  const ctl = new Float64Array(nCtl);
  for (let k = 0; k < nCtl; k++) ctl[k] = posAt(Math.min(duration, (k * STEP) / sr)) * sr;
  const mapSample = (i) => {
    const f = i / STEP;
    const k = Math.min(nCtl - 2, Math.floor(f));
    const u = f - k;
    return ctl[k] * (1 - u) + ctl[k + 1] * u;
  };

  if (!maintainPitch) {
    // varispeed: linear interpolation along the map (pitch follows speed)
    for (let i = 0; i < n; i++) {
      const p = mapSample(i);
      const i0 = Math.floor(p);
      if (i0 < 0 || i0 >= len - 1) continue;
      const u = p - i0;
      for (let c = 0; c < chs; c++) outData[c][i] = inData[c][i0] * (1 - u) + inData[c][i0 + 1] * u;
    }
    return out;
  }

  // WSOLA: overlap-add Hann windows; each window's source position is nudged (±tolerance) to
  // line up with the natural continuation of the previous window, which keeps pitch intact.
  const Wn = Math.max(256, Math.round(0.04 * sr) & ~1);
  const Hs = Wn / 2;
  const tol = Math.round(0.012 * sr);
  const win = new Float32Array(Wn);
  for (let i = 0; i < Wn; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Wn);
  const mono = inData.length === 1 ? inData[0] : (() => {
    const m = new Float32Array(len);
    for (let c = 0; c < chs; c++) for (let i = 0; i < len; i++) m[i] += inData[c][i] / chs;
    return m;
  })();
  const DEC = 4;
  const corrLen = Hs;
  let prevSrc = null;
  for (let o = -Hs; o < n; o += Hs) {
    const centerOut = o + Hs;
    let s0 = Math.round(mapSample(Math.max(0, centerOut)) - Hs);
    if (prevSrc != null) {
      const natural = prevSrc + Hs;
      // coarse search on decimated samples, then refine
      let best = 0;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += DEC) {
        const cand = s0 + d;
        let acc = 0;
        for (let i = 0; i < corrLen; i += DEC) {
          const a = natural + i;
          const b = cand + i;
          if (a < 0 || b < 0 || a >= len || b >= len) continue;
          acc += mono[a] * mono[b];
        }
        if (acc > bestC) { bestC = acc; best = d; }
      }
      let fine = best;
      bestC = -Infinity;
      for (let d = best - DEC; d <= best + DEC; d++) {
        const cand = s0 + d;
        let acc = 0;
        for (let i = 0; i < corrLen; i += 2) {
          const a = natural + i;
          const b = cand + i;
          if (a < 0 || b < 0 || a >= len || b >= len) continue;
          acc += mono[a] * mono[b];
        }
        if (acc > bestC) { bestC = acc; fine = d; }
      }
      s0 += fine;
    }
    prevSrc = s0;
    for (let i = 0; i < Wn; i++) {
      const oi = o + i;
      const si = s0 + i;
      if (oi < 0 || oi >= n || si < 0 || si >= len) continue;
      const w = win[i];
      for (let c = 0; c < chs; c++) outData[c][oi] += inData[c][si] * w;
    }
  }
  return out;
}

// Readers for Photoshop resource files: brushes (.abr versions 1, 2 and 6+ with their sampled tips,
// presets and textures), patterns (.pat) and gradients (.grd versions 3 and 5), plus the "action
// descriptor" structure the newer formats are built on. Everything is big-endian. No DOM here:
// pictures come back as 8-bit grey (brush tips) or RGBA (patterns) arrays.

class Reader {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    this.p = 0;
  }

  get left() {
    return this.b.length - this.p;
  }

  need(n) {
    if (n < 0 || this.p + n > this.b.length) throw new Error('파일이 잘렸거나 형식이 다릅니다');
  }

  u8() {
    this.need(1);
    return this.b[this.p++];
  }

  u16() {
    this.need(2);
    const x = this.v.getUint16(this.p);
    this.p += 2;
    return x;
  }

  i16() {
    this.need(2);
    const x = this.v.getInt16(this.p);
    this.p += 2;
    return x;
  }

  u32() {
    this.need(4);
    const x = this.v.getUint32(this.p);
    this.p += 4;
    return x;
  }

  i32() {
    this.need(4);
    const x = this.v.getInt32(this.p);
    this.p += 4;
    return x;
  }

  f64() {
    this.need(8);
    const x = this.v.getFloat64(this.p);
    this.p += 8;
    return x;
  }

  bytes(n) {
    this.need(n);
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }

  skip(n) {
    this.need(n);
    this.p += n;
  }

  ascii(n) {
    return String.fromCharCode(...this.bytes(n));
  }

  /** 1-byte length, then that many bytes. */
  pascal() {
    return this.ascii(this.u8());
  }

  /** 4-byte length in UTF-16 units, then the characters (often with a closing 0). */
  unicode() {
    const n = this.u32();
    this.need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.v.getUint16(this.p + i * 2);
      if (c) s += String.fromCharCode(c);
    }
    this.p += n * 2;
    return s;
  }

  /** A descriptor key: a 4-byte length and a string, or a 4-character code when the length is 0. */
  key() {
    const n = this.u32();
    return this.ascii(n || 4);
  }
}

// ---------------------------------------------------------------- descriptors

/** An action descriptor as a plain object: { _class, _name, key: value, … }. */
export function readDescriptor(r) {
  const name = r.unicode();
  const cls = r.key();
  const n = r.u32();
  const out = { _class: cls, _name: name };
  for (let i = 0; i < n; i++) {
    const k = r.key();
    out[k] = readValue(r, r.ascii(4));
  }
  return out;
}

function readReference(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = r.ascii(4);
    switch (t) {
      case 'prop': out.push({ prop: [r.unicode(), r.key(), r.key()] }); break;
      case 'Clss': out.push({ cls: [r.unicode(), r.key()] }); break;
      case 'Enmr': out.push({ enmr: [r.unicode(), r.key(), r.key(), r.key()] }); break;
      case 'rele': out.push({ rele: [r.unicode(), r.key(), r.i32()] }); break;
      case 'Idnt': case 'indx': out.push({ [t]: r.i32() }); break;
      case 'name': out.push({ name: [r.unicode(), r.key(), r.unicode()] }); break;
      default: throw new Error(`알 수 없는 참조 ${t}`);
    }
  }
  return out;
}

function readValue(r, type) {
  switch (type) {
    case 'Objc':
    case 'GlbO': return readDescriptor(r);
    case 'VlLs': {
      const n = r.u32();
      const out = [];
      for (let i = 0; i < n; i++) out.push(readValue(r, r.ascii(4)));
      return out;
    }
    case 'doub': return r.f64();
    case 'UntF': {
      const unit = r.ascii(4);
      return { unit, value: r.f64() };
    }
    case 'UnFl': {
      const unit = r.ascii(4);
      const n = r.u32();
      const values = [];
      for (let i = 0; i < n; i++) values.push(r.f64());
      return { unit, values };
    }
    case 'TEXT': return r.unicode();
    case 'enum': {
      const t = r.key();
      return { type: t, value: r.key() };
    }
    case 'long': return r.i32();
    case 'comp': {
      const hi = r.i32();
      return hi * 4294967296 + r.u32();
    }
    case 'bool': return !!r.u8();
    case 'type':
    case 'GlbC': {
      const nm = r.unicode();
      return { _class: r.key(), _name: nm };
    }
    case 'obj ': return readReference(r);
    case 'ObAr': {
      // an object array (points and the like): version, name, class, then lists of unit floats
      r.u32();
      r.unicode();
      r.key();
      const n = r.u32();
      const out = [];
      for (let i = 0; i < n; i++) {
        const k = r.key();
        r.ascii(4); // 'UnFl'
        out.push({ key: k, ...readValue(r, 'UnFl') });
      }
      return out;
    }
    case 'alis':
    case 'tdta':
    case 'Pth ': return r.bytes(r.u32());
    default: throw new Error(`알 수 없는 값 형식 ${type}`);
  }
}

const num = (v, def = 0) => (v == null ? def : typeof v === 'object' ? v.value ?? def : typeof v === 'boolean' ? +v : v);

// ---------------------------------------------------------------- pixel data

/** PackBits rows (a table of 2-byte row lengths first), like PSD channel data. */
function unpackRows(r, rowBytes, rows) {
  const counts = new Array(rows);
  for (let y = 0; y < rows; y++) counts[y] = r.u16();
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const end = r.p + counts[y];
    r.need(counts[y]);
    let o = y * rowBytes;
    const oEnd = o + rowBytes;
    while (r.p < end && o < oEnd) {
      let n = r.b[r.p++];
      if (n > 127) n -= 256;
      if (n === -128) continue;
      if (n < 0) {
        const v = r.b[r.p++];
        for (let k = 0; k < 1 - n && o < oEnd; k++) out[o++] = v;
      } else {
        for (let k = 0; k <= n && o < oEnd; k++) out[o++] = r.b[r.p++];
      }
    }
    r.p = end;
  }
  return out;
}

/** w×h samples of `depth` bits (8, 16 or 32), raw or PackBits, as 8-bit values. */
function readPixels(r, w, h, depth, comp) {
  const bpp = depth === 1 ? 0 : depth >> 3;
  if (bpp === 0) {
    // 1-bit: rows padded to whole bytes
    const rowBytes = Math.ceil(w / 8);
    const raw = comp ? unpackRows(r, rowBytes, h) : r.bytes(rowBytes * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = raw[y * rowBytes + (x >> 3)] & (128 >> (x & 7)) ? 0 : 255;
    return out;
  }
  const rowBytes = w * bpp;
  const raw = comp ? unpackRows(r, rowBytes, h) : r.bytes(rowBytes * h);
  if (bpp === 1) return raw.slice ? raw.slice() : new Uint8Array(raw);
  const out = new Uint8Array(w * h);
  if (bpp === 2) for (let i = 0; i < w * h; i++) out[i] = raw[i * 2];
  else {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < w * h; i++) out[i] = Math.max(0, Math.min(255, Math.round(dv.getFloat32(i * 4) * 255)));
  }
  return out;
}

const sane = (w, h) => w > 0 && h > 0 && w <= 30000 && h <= 30000 && w * h <= 120e6;

// ---------------------------------------------------------------- patterns

/** A Virtual Memory Array List: the channels of a pattern. */
function readVmal(r) {
  const version = r.u32();
  if (version !== 3) throw new Error('패턴 데이터 형식이 다릅니다');
  const len = r.u32();
  const end = r.p + len;
  const top = r.i32();
  const left = r.i32();
  const bottom = r.i32();
  const right = r.i32();
  const nch = r.u32();
  const chans = [];
  for (let i = 0; i < nch + 2 && r.p + 4 <= end; i++) {
    if (!r.u32()) {
      chans.push(null);
      continue;
    }
    const clen = r.u32();
    if (!clen) {
      chans.push(null);
      continue;
    }
    const cend = r.p + clen;
    r.u32(); // depth
    const t = r.i32();
    const l = r.i32();
    const b = r.i32();
    const rt = r.i32();
    const depth = r.u16();
    const comp = r.u8();
    const cw = rt - l;
    const ch = b - t;
    chans.push(sane(cw, ch) ? { data: readPixels(r, cw, ch, depth, comp), w: cw, h: ch } : null);
    r.p = cend;
  }
  r.p = end;
  return { w: right - left, h: bottom - top, chans, nch };
}

function labRgb(L, a, b) {
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = f(y);
  z = 1.08883 * f(z);
  const g = (c) => 255 * (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  return [g(x * 3.2406 + y * -1.5372 + z * -0.4986), g(x * -0.9689 + y * 1.8758 + z * 0.0415), g(x * 0.0557 + y * -0.204 + z * 1.057)];
}

/** One pattern record: { name, id, w, h, rgba }. */
function readPattern(r) {
  const version = r.u32();
  if (version !== 1) throw new Error('패턴 버전이 다릅니다');
  const mode = r.u32();
  const h = r.u16();
  const w = r.u16();
  const name = r.unicode();
  const id = r.pascal();
  let palette = null;
  if (mode === 2) {
    palette = r.bytes(768);
    r.skip(4);
  }
  const vm = readVmal(r);
  const W = vm.w > 0 ? vm.w : w;
  const H = vm.h > 0 ? vm.h : h;
  if (!sane(W, H)) throw new Error('패턴 크기가 이상합니다');
  // the colour channels come first; a written channel after them (in the next slot or in the
  // mask slots at the end) is the transparency
  const written = vm.chans.filter(Boolean);
  const colours = mode === 3 || mode === 9 ? 3 : mode === 4 ? 4 : 1;
  const alpha = written.length > colours ? written[colours] : null;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const at = (c, i) => (c && c.w === W && c.h === H ? c.data[i] : 255);
  for (let i = 0; i < W * H; i++) {
    let rgb;
    if (mode === 3 && written.length >= 3) rgb = [at(written[0], i), at(written[1], i), at(written[2], i)];
    else if (mode === 2 && palette) {
      const k = at(written[0], i) * 3;
      rgb = [palette[k], palette[k + 1], palette[k + 2]];
    } else if (mode === 4 && written.length >= 4) {
      // stored as 255 = no ink
      const [c, m, y, k] = [0, 1, 2, 3].map((j) => 1 - at(written[j], i) / 255);
      rgb = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
    } else if (mode === 9 && written.length >= 3) rgb = labRgb((at(written[0], i) / 255) * 100, at(written[1], i) - 128, at(written[2], i) - 128);
    else {
      const v = at(written[0], i);
      rgb = [v, v, v];
    }
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = alpha ? at(alpha, i) : 255;
  }
  return { name: name || id || '패턴', id, w: W, h: H, rgba };
}

/** A Photoshop pattern file (.pat): [{ name, id, w, h, rgba }]. */
export function parsePat(buf) {
  const r = new Reader(buf);
  if (r.ascii(4) !== '8BPT') throw new Error('Photoshop 패턴 파일(.pat)이 아닙니다');
  r.u16();
  const count = r.u32();
  const out = [];
  for (let i = 0; i < count && r.left > 8; i++) {
    const start = r.p;
    try {
      out.push(readPattern(r));
    } catch (err) {
      // some writers put each pattern's length first
      r.p = start;
      const len = r.u32();
      const s2 = r.p;
      try {
        out.push(readPattern(r));
      } catch {
        if (!out.length) throw err;
        break;
      }
      r.p = s2 + len;
    }
  }
  return out;
}

/** Patterns stored in an .abr file ('patt' section) or a PSD: each with its length, 4-byte aligned. */
function readPatternBlock(r, end) {
  const out = [];
  while (r.p + 4 < end) {
    const len = r.u32();
    const start = r.p;
    try {
      out.push(readPattern(r));
    } catch {
      // skip a pattern we cannot read
    }
    r.p = start + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

// ---------------------------------------------------------------- brushes

/** One sampled brush tip of an old (v1/v2) brush file. */
function abrSampledV12(r, version, end) {
  r.u32();
  const spacing = r.u16();
  const name = version === 2 ? r.unicode() : '';
  r.u8(); // anti-aliasing
  r.skip(8); // short bounds
  const top = r.i32();
  const left = r.i32();
  const bottom = r.i32();
  const right = r.i32();
  const depth = r.u16();
  const comp = r.u8();
  const w = right - left;
  const h = bottom - top;
  if (!sane(w, h) || r.p > end) return null;
  return { name, spacing, w, h, gray: readPixels(r, w, h, depth, comp) };
}

function abrV12(r, version) {
  const count = r.u16();
  const tips = [];
  const presets = [];
  for (let i = 0; i < count && r.left >= 6; i++) {
    const type = r.u16();
    const size = r.u32();
    const end = r.p + size;
    try {
      if (type === 1) {
        // computed: a round tip described by numbers
        r.u32();
        const spacing = r.u16();
        let name = '';
        if (version === 2 && size > 14) name = r.unicode();
        const diameter = r.u16();
        const roundness = r.u16();
        const angle = r.i16();
        const hardness = r.u16();
        presets.push({ name: name || `둥근 ${diameter}`, tip: 'round', size: diameter, s: { spacing: spacing || 25, roundness: roundness || 100, angle }, hardness });
      } else if (type === 2) {
        const t = abrSampledV12(r, version, end);
        if (t) {
          const key = `s${i}`;
          tips.push({ key, name: t.name, w: t.w, h: t.h, gray: t.gray });
          presets.push({ name: t.name || '', tip: key, size: Math.max(t.w, t.h), s: { spacing: t.spacing || 25 } });
        }
      }
    } catch {
      // a damaged brush is skipped
    }
    r.p = end;
  }
  return { tips, presets, patterns: [] };
}

/** The sampled tips of a v6+ file ('samp' section): each a key and a picture. */
function abrSamples(r, end, sub) {
  const tips = [];
  while (r.p + 4 < end) {
    const len = r.u32();
    const start = r.p;
    const next = start + len + ((4 - (len % 4)) % 4);
    try {
      const key = r.pascal();
      const afterKey = r.p;
      let t = null;
      // tries: the documented layout for this sub-version, then the other one, then fixed offsets
      for (const off of [afterKey + (sub === 1 ? 10 : 264), afterKey + (sub === 1 ? 264 : 10), start + 47, start + 301]) {
        if (off + 19 > next) continue;
        r.p = off;
        const top = r.i32();
        const left = r.i32();
        const bottom = r.i32();
        const right = r.i32();
        const depth = r.u16();
        const comp = r.u8();
        const w = right - left;
        const h = bottom - top;
        if (!sane(w, h) || ![8, 16, 32].includes(depth) || comp > 1) continue;
        t = { key, w, h, gray: readPixels(r, w, h, depth, comp) };
        break;
      }
      if (t) tips.push(t);
    } catch {
      // skip a tip we cannot read
    }
    r.p = next;
  }
  return tips;
}

// Photoshop's bVTy codes: off, fade, pen pressure, pen tilt, stylus wheel, initial direction,
// direction, initial rotation, rotation (the wheel and rotation need a pen this app can't read)
const CTRL = ['off', 'fade', 'pressure', 'tilt', 'off', 'initial', 'direction', 'off', 'off'];
/** A Photoshop brush variation ('brVr'): control, fade steps, jitter, minimum. */
function variation(v, angle = false) {
  if (!v || typeof v !== 'object') return null;
  let ctrl = CTRL[num(v.bVTy)] || 'off';
  // only the angle can follow the stroke direction
  if (!angle && (ctrl === 'initial' || ctrl === 'direction')) ctrl = 'off';
  return { ctrl, fade: num(v.fStp, 25), jitter: num(v.jitter), min: num(v['Mnm ']) };
}

/** Brush settings from a v6+ preset descriptor, in this app's names (see brushengine.js DYN). */
function presetSettings(p, b) {
  const s = {};
  const set = (k, v) => {
    if (v !== undefined && v !== null && !Number.isNaN(v)) s[k] = v;
  };
  set('spacing', b.Spcn != null ? num(b.Spcn) : undefined);
  set('angle', b.Angl != null ? num(b.Angl) : undefined);
  set('roundness', b.Rndn != null ? num(b.Rndn) : undefined);
  if (b.flipX != null) set('flipX', !!b.flipX);
  if (b.flipY != null) set('flipY', !!b.flipY);
  // shape dynamics
  if (p.useTipDynamics) {
    s.shapeDyn = true;
    const sz = variation(p.szVr);
    if (sz) Object.assign(s, { sizeJitter: sz.jitter, sizeCtrl: sz.ctrl, sizeFade: sz.fade });
    set('minDiameter', p.minimumDiameter != null ? num(p.minimumDiameter) : undefined);
    const an = variation(p.angleDynamics, true);
    if (an) Object.assign(s, { angleJitter: an.jitter, angleCtrl: an.ctrl, angleFade: an.fade });
    const rn = variation(p.roundnessDynamics);
    if (rn) Object.assign(s, { roundJitter: rn.jitter, roundCtrl: rn.ctrl, roundFade: rn.fade });
    set('minRoundness', p.minimumRoundness != null ? num(p.minimumRoundness) : undefined);
    if (p.flipX != null) s.flipXJitter = !!p.flipX;
    if (p.flipY != null) s.flipYJitter = !!p.flipY;
  }
  // scattering
  if (p.useScatter) {
    s.scatterOn = true;
    const sc = variation(p.scatterDynamics);
    if (sc) Object.assign(s, { scatter: sc.jitter, scatterCtrl: sc.ctrl, scatterFade: sc.fade });
    if (p.dualDiameter == null) set('bothAxes', p.bothAxes != null ? !!p.bothAxes : undefined);
    set('count', p['Cnt '] != null ? Math.max(1, Math.round(num(p['Cnt ']))) : undefined);
    const cn = variation(p.countDynamics);
    if (cn) Object.assign(s, { countJitter: cn.jitter, countCtrl: cn.ctrl, countFade: cn.fade });
  }
  // colour dynamics
  if (p.useColorDynamics) {
    s.colorDyn = true;
    const fb = variation(p.clVr);
    if (fb) Object.assign(s, { fgbgJitter: fb.jitter, fgbgCtrl: fb.ctrl, fgbgFade: fb.fade });
    set('hueJitter', p['H   '] != null ? num(p['H   ']) : undefined);
    set('satJitter', p.Strt != null ? num(p.Strt) : undefined);
    set('briJitter', p.Brgh != null ? num(p.Brgh) : undefined);
    set('purity', p.purity != null ? num(p.purity) : undefined);
    if (p.colorDynamicsPerTip != null) s.colorEachTip = !!p.colorDynamicsPerTip;
  }
  // transfer
  if (p.usePaintDynamics) {
    s.transferOn = true;
    const op = variation(p.opVr);
    if (op) Object.assign(s, { opacityJitter: op.jitter, opacityCtrl: op.ctrl, opacityFade: op.fade, minOpacity: op.min });
    const fl = variation(p.prVr);
    if (fl) Object.assign(s, { flowJitter: fl.jitter, flowCtrl: fl.ctrl, flowFade: fl.fade, minFlow: fl.min });
  }
  // texture
  if (p.useTexture) {
    s.textureOn = true;
    const tx = p.Txtr;
    if (tx) s.texPatternRef = { name: tx['Nm  '] || '', id: tx.Idnt || '' };
    set('texScale', p.textureScale != null ? num(p.textureScale) : undefined);
    set('texDepth', p.textureDepth != null ? num(p.textureDepth) : undefined);
    set('texMinDepth', p.minimumDepth != null ? num(p.minimumDepth) : undefined);
    set('texBrightness', p.textureBrightness != null ? num(p.textureBrightness) : undefined);
    set('texContrast', p.textureContrast != null ? num(p.textureContrast) : undefined);
    if (p.InvT != null) s.texInvert = !!p.InvT;
    if (p.TxtC != null) s.texEachTip = !!p.TxtC;
    const mode = p.textureBlendMode?.value;
    const modes = { Mltp: 'multiply', Sbtr: 'subtract', Drkn: 'darken', Ovrl: 'overlay', CDdg: 'colorDodge', CBrn: 'colorBurn', linearBurn: 'linearBurn', hardMix: 'hardMix', linearHeight: 'linearHeight', height: 'height' };
    if (modes[mode]) s.texMode = modes[mode];
    const dd = variation(p.textureDepthDynamics);
    if (dd) Object.assign(s, { texDepthJitter: dd.jitter, texDepthCtrl: dd.ctrl, texDepthFade: dd.fade });
  }
  // dual brush: a second tip that cuts into the first
  const db = p.dualBrush;
  if (db && typeof db === 'object' && db.useDualBrush) {
    const tip = db.Brsh && typeof db.Brsh === 'object' ? db.Brsh : {};
    s.dualOn = true;
    s.dualTipRef = tip.sampledData ? `#${tip.sampledData}` : 'round';
    set('dualSize', tip.Dmtr != null ? Math.max(1, Math.round(num(tip.Dmtr))) : undefined);
    set('dualSpacing', db.Spcn != null ? num(db.Spcn) : tip.Spcn != null ? num(tip.Spcn) : undefined);
    if (db.Flip != null) s.dualFlip = !!db.Flip;
    const dm = { Mltp: 'multiply', Drkn: 'darken', Ovrl: 'overlay', CDdg: 'colorDodge', CBrn: 'colorBurn', linearBurn: 'linearBurn', hardMix: 'hardMix', linearHeight: 'linearHeight' }[db.BlnM?.value];
    if (dm) s.dualMode = dm;
    if (db.useScatter) {
      const sc = variation(db.scatterDynamics);
      if (sc) s.dualScatter = sc.jitter;
      if (db.bothAxes != null) s.dualBothAxes = !!db.bothAxes;
    }
    set('dualCount', db['Cnt '] != null ? Math.max(1, Math.round(num(db['Cnt ']))) : undefined);
  }
  if (p.Wtdg) s.wetEdges = true;
  if (p.Nose) s.noise = true;
  if (p['Rpt ']) s.airbrush = true;
  if (p.protectTexture) s.protectTexture = true;
  return s;
}

/** Photoshop painting modes (BlnM) as this app's canvas operations; others paint normally. */
const BLEND = {
  Nrml: 'source-over', Bhnd: 'destination-over', Clar: 'destination-out', Drkn: 'darken', Mltp: 'multiply', CBrn: 'color-burn',
  Lghn: 'lighten', Scrn: 'screen', CDdg: 'color-dodge', linearDodge: 'lighter', Ovrl: 'overlay', SftL: 'soft-light', HrdL: 'hard-light',
  Dfrn: 'difference', Xclu: 'exclusion', 'H   ': 'hue', Strt: 'saturation', 'Clr ': 'color', Lmns: 'luminosity',
};

/** All brush presets in a v6+ 'desc' section. */
function descPresets(desc) {
  const out = [];
  const list = Array.isArray(desc.Brsh) ? desc.Brsh : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const b = p.Brsh && typeof p.Brsh === 'object' ? p.Brsh : {};
    const sampled = b.sampledData || null;
    const preset = {
      name: p['Nm  '] || b['Nm  '] || '',
      tip: sampled ? `#${sampled}` : 'round',
      size: Math.max(1, Math.round(num(b.Dmtr, 30))),
      s: presetSettings(p, b),
    };
    if (!sampled && b.Hrdn != null) preset.hardness = Math.round(num(b.Hrdn));
    // presets saved with their tool settings: flow, opacity, painting mode, smoothing
    const to = p.toolOptions;
    if (to && typeof to === 'object') {
      if (to.flow != null) preset.flow = Math.max(1, Math.min(100, Math.round(num(to.flow))));
      if (to.Opct != null) preset.opacity = Math.max(1, Math.min(100, Math.round(num(to.Opct))));
      const md = BLEND[to['Md  ']?.value];
      if (md) preset.blend = md;
      if (to.smoothingValue != null) preset.s.smoothing = Math.max(0, Math.min(100, Math.round(num(to.smoothingValue))));
      if (to.smoothing != null) preset.s.smoothingOn = !!to.smoothing;
    }
    out.push(preset);
  }
  return out;
}

function abrV6(r) {
  const sub = r.u16();
  let tips = [];
  let patterns = [];
  let desc = null;
  while (r.left >= 12) {
    const sig = r.ascii(4);
    if (sig !== '8BIM' && sig !== '8B64') break;
    const key = r.ascii(4);
    const len = r.u32();
    const start = r.p;
    const end = Math.min(r.b.length, start + len);
    try {
      if (key === 'samp') tips = abrSamples(r, end, sub);
      else if (key === 'patt') patterns = readPatternBlock(r, end);
      else if (key === 'desc') {
        r.u32(); // descriptor version (16)
        desc = readDescriptor(r);
      }
    } catch {
      // a section we cannot read is left out
    }
    // sections are padded to 4 bytes (some writers don't pad: then the next one starts right away)
    const padded = start + len + ((4 - (len % 4)) % 4);
    const sigAt = (p) => p + 4 <= r.b.length && /^8B(IM|64)$/.test(String.fromCharCode(...r.b.subarray(p, p + 4)));
    r.p = padded !== end && !sigAt(end) && sigAt(padded) ? padded : end;
  }
  const presets = desc ? descPresets(desc) : [];
  // tips no preset uses (as its tip or its dual brush tip) still become brushes of their own
  const used = new Set(presets.flatMap((p) => [p.tip, p.s.dualTipRef]));
  for (const t of tips) if (!used.has(`#${t.key}`)) presets.push({ name: '', tip: `#${t.key}`, size: Math.max(t.w, t.h), s: { spacing: 25 } });
  // presets name tips by their key ('#' + key)
  for (const t of tips) t.key = `#${t.key}`;
  const known = (k) => k === 'round' || tips.some((t) => t.key === k);
  for (const p of presets) {
    if (p.s.dualOn && !known(p.s.dualTipRef)) {
      p.s.dualOn = false;
      delete p.s.dualTipRef;
    }
  }
  return { tips, presets: presets.filter((p) => known(p.tip)), patterns };
}

/**
 * A Photoshop brush file (.abr): { tips: [{ key, name, w, h, gray }], presets: [{ name, tip (a tip
 * key or 'round'), size, hardness?, s: brush settings }], patterns }. Grey: 255 = full paint.
 */
export function parseAbr(buf) {
  const r = new Reader(buf);
  const version = r.u16();
  if (version === 1 || version === 2) return abrV12(r, version);
  if (version >= 6 && version <= 10) return abrV6(r);
  throw new Error(`지원하지 않는 브러시 파일 버전입니다 (${version})`);
}

// ---------------------------------------------------------------- gradients

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v) || 0)).toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function hsbHex(hh, s, b) {
  hh = (((hh % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = b * (1 - s);
  const q = b * (1 - s * f);
  const t = b * (1 - s * (1 - f));
  const [r, g, bb] = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][i % 6];
  return toHex(r * 255, g * 255, bb * 255);
}

/** A colour descriptor (RGB, HSB, grey, CMYK, Lab) as #rrggbb. */
function colorOf(c) {
  if (!c || typeof c !== 'object') return '#000000';
  switch (c._class) {
    case 'RGBC': return toHex(num(c['Rd  '] ?? c.redFloat * 255), num(c['Grn '] ?? c.greenFloat * 255), num(c['Bl  '] ?? c.blueFloat * 255));
    case 'HSBC': return hsbHex(num(c['H   ']), num(c.Strt) / 100, num(c.Brgh) / 100);
    case 'Grsc': {
      const v = 255 * (1 - num(c['Gry ']) / 100);
      return toHex(v, v, v);
    }
    case 'CMYC': {
      const [cc, m, y, k] = ['Cyn ', 'Mgnt', 'Ylw ', 'Blck'].map((key) => num(c[key]) / 100);
      return toHex(255 * (1 - cc) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k));
    }
    case 'LbCl': return toHex(...labRgb(num(c.Lmnc), num(c['A   ']), num(c['B   '])));
    default: return '#000000';
  }
}

/** Every object in a descriptor tree that looks like a gradient. */
function findGradients(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const x of node) findGradients(x, out, depth + 1);
    return out;
  }
  if (node.GrdF || node.Clrs) {
    out.push(node);
    return out;
  }
  for (const [k, v] of Object.entries(node)) if (k[0] !== '_') findGradients(v, out, depth + 1);
  return out;
}

function gradientFromDesc(d) {
  const name = d['Nm  '] || '그레이디언트';
  if (d.GrdF?.value === 'ClNs') {
    const model = { RGBC: 'rgb', HSBC: 'hsb', LbCl: 'lab' }[d.ClrS?.value] || 'rgb';
    const four = (v, def) => (Array.isArray(v) && v.length >= 4 ? v.slice(0, 4).map((x) => num(x)) : def);
    return {
      name, type: 'noise', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
      noise: { roughness: Math.round((num(d.Smth, 2048) / 4096) * 100), model, seed: num(d.RndS, 1) >>> 0, restrict: !!d.VctC, transparency: !!d.ShTr, min: four(d['Mnm '], [0, 0, 0, 0]), max: four(d['Mxm '], [100, 100, 100, 100]) },
    };
  }
  const kind = (c) => ({ FrgC: 'fg', BckC: 'bg' })[c?.Type?.value] || null;
  const stops = (Array.isArray(d.Clrs) ? d.Clrs : []).map((c) => ({ pos: num(c.Lctn) / 4096, mid: num(c.Mdpn, 50), color: kind(c) || colorOf(c['Clr ']) }));
  const alphas = (Array.isArray(d.Trns) ? d.Trns : []).map((t) => ({ pos: num(t.Lctn) / 4096, mid: num(t.Mdpn, 50), a: num(t.Opct, 100) / 100 }));
  return { name, stops: stops.length ? stops : [{ pos: 0, color: 'fg' }, { pos: 1, color: 'bg' }], alphas: alphas.length ? alphas : [{ pos: 0, a: 1 }, { pos: 1, a: 1 }], smooth: Math.round((num(d.Intr, 4096) / 4096) * 100) };
}

function grdV3(r) {
  const count = r.u16();
  const out = [];
  const model = (m, c) => {
    switch (m) {
      case 0: return toHex(c[0] / 257, c[1] / 257, c[2] / 257);
      case 1: return hsbHex((c[0] / 65535) * 360, c[1] / 65535, c[2] / 65535);
      case 2: return toHex(255 * (c[0] / 65535) * (c[3] / 65535), 255 * (c[1] / 65535) * (c[3] / 65535), 255 * (c[2] / 65535) * (c[3] / 65535));
      // Lab: lightness 0..10000, chrominance signed -12800..12700
      case 7: return toHex(...labRgb(c[0] / 100, ((c[1] << 16) >> 16) / 100, ((c[2] << 16) >> 16) / 100));
      case 8: {
        const v = 255 - c[0] / 39.0625;
        return toHex(v, v, v);
      }
      default: return '#000000';
    }
  };
  for (let i = 0; i < count && r.left > 4; i++) {
    const name = r.pascal();
    const n = r.u16();
    if (n > 200) break;
    const stops = [];
    for (let k = 0; k < n; k++) {
      const pos = r.u32() / 4096;
      const mid = r.u32();
      const m = r.u16();
      const c = [r.u16(), r.u16(), r.u16(), r.u16()];
      const type = r.u16();
      stops.push({ pos, mid, color: type === 1 ? 'fg' : type === 2 ? 'bg' : model(m, c) });
    }
    const nt = r.u16();
    if (nt > 200) break;
    const alphas = [];
    for (let k = 0; k < nt; k++) {
      const pos = r.u32() / 4096;
      const mid = r.u32();
      alphas.push({ pos, mid, a: r.u16() / 255 });
    }
    r.skip(Math.min(6, r.left));
    out.push({ name: name || `그레이디언트 ${i + 1}`, stops, alphas: alphas.length ? alphas : [{ pos: 0, a: 1 }, { pos: 1, a: 1 }] });
  }
  return out;
}

/** A Photoshop gradient file (.grd): [{ name, stops, alphas, smooth } or noise gradients]. */
export function parseGrd(buf) {
  const r = new Reader(buf);
  if (r.ascii(4) !== '8BGR') throw new Error('Photoshop 그레이디언트 파일(.grd)이 아닙니다');
  const version = r.u16();
  if (version === 3) return grdV3(r);
  if (version !== 5) throw new Error(`지원하지 않는 그레이디언트 파일 버전입니다 (${version})`);
  r.u32(); // descriptor version (16)
  const d = readDescriptor(r);
  // a stop's midpoint is where the blend from the stop before it is half done (as here)
  return findGradients(d).map(gradientFromDesc);
}

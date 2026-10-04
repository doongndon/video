// Declarative definitions of every effect and transition. Rendering lives in compositor.js
// (video) and playback.js / export.js (audio); this file only describes parameters.

export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['darken', 'Darken'],
  ['multiply', 'Multiply'],
  ['color-burn', 'Color Burn'],
  ['lighten', 'Lighten'],
  ['screen', 'Screen'],
  ['color-dodge', 'Color Dodge'],
  ['lighter', 'Linear Dodge (Add)'],
  ['overlay', 'Overlay'],
  ['soft-light', 'Soft Light'],
  ['hard-light', 'Hard Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export const FONTS = [
  ['sans-serif', 'Sans Serif (system)'],
  ['serif', 'Serif (system)'],
  ['monospace', 'Monospace (system)'],
  ['Noto Sans KR', 'Noto Sans KR'],
  ['Noto Serif KR', 'Noto Serif KR'],
  ['Black Han Sans', 'Black Han Sans'],
  ['Do Hyeon', 'Do Hyeon'],
  ['Jua', 'Jua'],
  ['Nanum Pen Script', 'Nanum Pen Script'],
  ['Arial', 'Arial'],
  ['Georgia', 'Georgia'],
  ['Impact', 'Impact'],
  ['Courier New', 'Courier New'],
];

const num = (key, label, def, opts = {}) => ({ key, label, type: 'number', default: def, animatable: true, step: 1, ...opts });
const pct = (key, label, def, opts = {}) => num(key, label, def, { min: 0, max: 100, unit: '%', ...opts });

/**
 * Effects. `kind` is the clip family they apply to. `fixed` effects are created automatically
 * with each clip (like Motion/Opacity/Volume) and cannot be removed.
 */
export const EFFECTS = {
  // ---- fixed video ----
  motion: {
    name: 'Motion', kind: 'video', fixed: true,
    params: [
      num('posX', 'Position X', (seq) => seq.width / 2, { unit: 'px' }),
      num('posY', 'Position Y', (seq) => seq.height / 2, { unit: 'px' }),
      num('scale', 'Scale', 100, { min: 0, max: 2000, unit: '%' }),
      num('rotation', 'Rotation', 0, { unit: '°' }),
      num('anchorX', 'Anchor X', 0, { unit: 'px', hint: 'Offset from the clip centre' }),
      num('anchorY', 'Anchor Y', 0, { unit: 'px' }),
    ],
  },
  opacity: {
    name: 'Opacity', kind: 'video', fixed: true,
    params: [
      pct('opacity', 'Opacity', 100),
      { key: 'blend', label: 'Blend Mode', type: 'select', default: 'source-over', options: BLEND_MODES },
    ],
  },
  text: {
    name: 'Text', kind: 'video', fixed: true,
    params: [
      { key: 'content', label: 'Text', type: 'text', default: 'Your text here' },
      { key: 'font', label: 'Font', type: 'select', default: 'Noto Sans KR', options: FONTS },
      num('size', 'Font Size', 96, { min: 4, max: 1000, unit: 'px' }),
      { key: 'bold', label: 'Bold', type: 'bool', default: true },
      { key: 'italic', label: 'Italic', type: 'bool', default: false },
      { key: 'align', label: 'Align', type: 'select', default: 'center', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
      num('lineHeight', 'Line Spacing', 120, { min: 50, max: 400, unit: '%' }),
      num('tracking', 'Tracking', 0, { min: -50, max: 200, unit: 'px' }),
      pct('reveal', 'Reveal (typewriter)', 100),
      { key: 'color', label: 'Fill', type: 'color', default: '#ffffff' },
      { key: 'strokeColor', label: 'Stroke', type: 'color', default: '#000000' },
      num('strokeWidth', 'Stroke Width', 0, { min: 0, max: 100, unit: 'px' }),
      { key: 'background', label: 'Background', type: 'bool', default: false },
      { key: 'bgColor', label: 'Background Color', type: 'color', default: '#000000' },
      pct('bgOpacity', 'Background Opacity', 60),
      num('bgPadding', 'Background Padding', 24, { min: 0, max: 400, unit: 'px' }),
    ],
  },
  fill: {
    name: 'Color Matte', kind: 'video', fixed: true,
    params: [{ key: 'color', label: 'Color', type: 'color', default: '#1e3a8a' }],
  },
  shape: {
    name: 'Shape', kind: 'video', fixed: true,
    params: [
      { key: 'shape', label: 'Shape', type: 'select', default: 'rectangle', options: [['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['line', 'Line']] },
      num('width', 'Width', 600, { min: 1, max: 8000, unit: 'px' }),
      num('height', 'Height', 200, { min: 1, max: 8000, unit: 'px' }),
      num('radius', 'Corner Radius', 0, { min: 0, max: 2000, unit: 'px' }),
      { key: 'fillOn', label: 'Fill', type: 'bool', default: true },
      { key: 'fill', label: 'Fill Color', type: 'color', default: '#2d8ceb' },
      { key: 'gradient', label: 'Gradient', type: 'bool', default: false },
      { key: 'fill2', label: 'Gradient End Color', type: 'color', default: '#9b5de5' },
      num('gradAngle', 'Gradient Angle', 0, { unit: '°' }),
      { key: 'strokeColor', label: 'Stroke', type: 'color', default: '#ffffff' },
      num('strokeWidth', 'Stroke Width', 0, { min: 0, max: 200, unit: 'px' }),
    ],
  },

  // ---- user video effects ----
  brightnessContrast: {
    name: 'Brightness & Contrast', kind: 'video', category: 'Adjust',
    params: [num('brightness', 'Brightness', 0, { min: -100, max: 100 }), num('contrast', 'Contrast', 0, { min: -100, max: 100 })],
  },
  basicColor: {
    name: 'Basic Color Correction', kind: 'video', category: 'Color Correction',
    params: [
      num('exposure', 'Exposure', 0, { min: -100, max: 100 }),
      num('contrast', 'Contrast', 0, { min: -100, max: 100 }),
      num('saturation', 'Saturation', 100, { min: 0, max: 300, unit: '%' }),
      num('temperature', 'Temperature', 0, { min: -100, max: 100 }),
      num('tint', 'Tint', 0, { min: -100, max: 100 }),
    ],
  },
  hueShift: {
    name: 'Hue Shift', kind: 'video', category: 'Color Correction',
    params: [num('hue', 'Hue', 0, { min: -180, max: 180, unit: '°' })],
  },
  gaussianBlur: {
    name: 'Gaussian Blur', kind: 'video', category: 'Blur & Sharpen',
    params: [num('blurriness', 'Blurriness', 10, { min: 0, max: 300, unit: 'px', step: 0.5 })],
  },
  blackWhite: { name: 'Black & White', kind: 'video', category: 'Image Control', params: [] },
  sepia: { name: 'Sepia', kind: 'video', category: 'Image Control', params: [pct('amount', 'Amount', 100)] },
  invert: { name: 'Invert', kind: 'video', category: 'Channel', params: [pct('amount', 'Amount', 100)] },
  colorKey: {
    name: 'Color Key', kind: 'video', category: 'Keying',
    params: [
      { key: 'keyColor', label: 'Key Color', type: 'color', default: '#00ff00' },
      pct('tolerance', 'Tolerance', 30),
      pct('softness', 'Edge Softness', 10),
      pct('spill', 'Spill Suppression', 50),
    ],
  },
  mosaic: {
    name: 'Mosaic', kind: 'video', category: 'Stylize',
    params: [num('blocks', 'Horizontal Blocks', 40, { min: 1, max: 400 })],
  },
  vignette: {
    name: 'Vignette', kind: 'video', category: 'Stylize',
    params: [pct('amount', 'Amount', 50), pct('midpoint', 'Midpoint', 50), { key: 'color', label: 'Color', type: 'color', default: '#000000' }],
  },
  dropShadow: {
    name: 'Drop Shadow', kind: 'video', category: 'Perspective',
    params: [
      { key: 'color', label: 'Shadow Color', type: 'color', default: '#000000' },
      pct('opacity', 'Opacity', 60),
      num('direction', 'Direction', 135, { unit: '°' }),
      num('distance', 'Distance', 12, { min: 0, max: 400, unit: 'px' }),
      num('softness', 'Softness', 16, { min: 0, max: 400, unit: 'px' }),
    ],
  },
  crop: {
    name: 'Crop', kind: 'video', category: 'Transform',
    params: [pct('left', 'Left', 0), pct('top', 'Top', 0), pct('right', 'Right', 0), pct('bottom', 'Bottom', 0)],
  },
  hFlip: { name: 'Horizontal Flip', kind: 'video', category: 'Transform', params: [] },
  vFlip: { name: 'Vertical Flip', kind: 'video', category: 'Transform', params: [] },

  sharpen: {
    name: 'Sharpen', kind: 'video', category: 'Blur & Sharpen',
    params: [num('amount', 'Sharpen Amount', 50, { min: 0, max: 300 })],
  },
  findEdges: { name: 'Find Edges', kind: 'video', category: 'Stylize', params: [] },
  posterize: {
    name: 'Posterize', kind: 'video', category: 'Stylize',
    params: [num('levels', 'Level', 6, { min: 2, max: 32 })],
  },
  glow: {
    name: 'Glow', kind: 'video', category: 'Stylize',
    params: [num('radius', 'Glow Radius', 20, { min: 0, max: 200, unit: 'px' }), pct('intensity', 'Glow Intensity', 60)],
  },
  filmGrain: {
    name: 'Film Grain', kind: 'video', category: 'Noise & Grain',
    params: [pct('amount', 'Amount', 35), num('size', 'Grain Size', 1, { min: 1, max: 8, step: 0.5 })],
  },
  tint: {
    name: 'Tint', kind: 'video', category: 'Color Correction',
    params: [
      { key: 'black', label: 'Map Black To', type: 'color', default: '#1a1a40' },
      { key: 'white', label: 'Map White To', type: 'color', default: '#ffe8b0' },
      pct('amount', 'Amount to Tint', 100),
    ],
  },
  letterbox: {
    name: 'Letterbox', kind: 'video', category: 'Transform',
    params: [
      num('aspect', 'Aspect Ratio', 2.39, { min: 0.5, max: 4, step: 0.01, animatable: true }),
      { key: 'color', label: 'Bar Color', type: 'color', default: '#000000' },
    ],
  },
  cameraShake: {
    name: 'Camera Shake', kind: 'video', category: 'Distort',
    params: [num('amount', 'Amount', 20, { min: 0, max: 400, unit: 'px' }), num('speed', 'Speed', 8, { min: 0.1, max: 60, unit: 'Hz', step: 0.1 }), num('rotation', 'Rotation', 1, { min: 0, max: 45, unit: '°', step: 0.1 })],
  },

  // ---- fixed audio ----
  volume: {
    name: 'Volume', kind: 'audio', fixed: true,
    params: [num('level', 'Level', 0, { min: -60, max: 15, unit: 'dB', step: 0.1 })],
  },
  panner: {
    name: 'Panner', kind: 'audio', fixed: true,
    params: [num('balance', 'Balance', 0, { min: -100, max: 100 })],
  },

  // ---- user audio effects ----
  gain: {
    name: 'Amplify', kind: 'audio', category: 'Amplitude',
    params: [num('gain', 'Gain', 6, { min: -30, max: 30, unit: 'dB', step: 0.1 })],
  },
  eq3: {
    name: 'Parametric EQ (3-Band)', kind: 'audio', category: 'Filter and EQ',
    params: [
      num('lowFreq', 'Low Shelf Freq', 200, { min: 20, max: 1000, unit: 'Hz' }),
      num('lowGain', 'Low Gain', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
      num('midFreq', 'Mid Freq', 1000, { min: 100, max: 8000, unit: 'Hz', step: 10 }),
      num('midGain', 'Mid Gain', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
      num('midQ', 'Mid Q', 1, { min: 0.1, max: 18, step: 0.1 }),
      num('highFreq', 'High Shelf Freq', 5000, { min: 1000, max: 20000, unit: 'Hz', step: 10 }),
      num('highGain', 'High Gain', 0, { min: -24, max: 24, unit: 'dB', step: 0.1 }),
    ],
  },
  highpass: {
    name: 'Highpass', kind: 'audio', category: 'Filter and EQ',
    params: [num('frequency', 'Cutoff', 120, { min: 20, max: 20000, unit: 'Hz' }), num('q', 'Q', 0.7, { min: 0.1, max: 18, step: 0.1 })],
  },
  lowpass: {
    name: 'Lowpass', kind: 'audio', category: 'Filter and EQ',
    params: [num('frequency', 'Cutoff', 6000, { min: 20, max: 20000, unit: 'Hz', step: 10 }), num('q', 'Q', 0.7, { min: 0.1, max: 18, step: 0.1 })],
  },
  bandpass: {
    name: 'Bandpass (Telephone)', kind: 'audio', category: 'Filter and EQ',
    params: [num('frequency', 'Center', 1500, { min: 20, max: 20000, unit: 'Hz', step: 10 }), num('q', 'Q', 1.2, { min: 0.1, max: 18, step: 0.1 })],
  },
  compressor: {
    name: 'Dynamics (Compressor)', kind: 'audio', category: 'Amplitude',
    params: [
      num('threshold', 'Threshold', -24, { min: -100, max: 0, unit: 'dB' }),
      num('ratio', 'Ratio', 4, { min: 1, max: 20, step: 0.1 }),
      num('knee', 'Knee', 30, { min: 0, max: 40, unit: 'dB' }),
      num('attack', 'Attack', 3, { min: 0, max: 1000, unit: 'ms' }),
      num('release', 'Release', 250, { min: 0, max: 1000, unit: 'ms' }),
      num('makeup', 'Make-up Gain', 0, { min: 0, max: 30, unit: 'dB', step: 0.1 }),
    ],
  },
  reverb: {
    name: 'Reverb', kind: 'audio', category: 'Reverb',
    params: [pct('mix', 'Mix', 30), num('decay', 'Decay', 2, { min: 0.1, max: 10, unit: 's', step: 0.1, animatable: false })],
  },
  delay: {
    name: 'Delay (Echo)', kind: 'audio', category: 'Delay and Echo',
    params: [num('time', 'Delay Time', 0.3, { min: 0.01, max: 5, unit: 's', step: 0.01 }), pct('feedback', 'Feedback', 35), pct('mix', 'Mix', 30)],
  },
};

export const TRANSITIONS = {
  crossDissolve: { name: 'Cross Dissolve', kind: 'video', category: 'Dissolve' },
  dipToBlack: { name: 'Dip to Black', kind: 'video', category: 'Dissolve' },
  dipToWhite: { name: 'Dip to White', kind: 'video', category: 'Dissolve' },
  wipe: { name: 'Wipe', kind: 'video', category: 'Wipe' },
  push: { name: 'Push', kind: 'video', category: 'Slide' },
  irisRound: { name: 'Iris Round', kind: 'video', category: 'Iris' },
  constantPower: { name: 'Constant Power', kind: 'audio', category: 'Crossfade' },
  constantGain: { name: 'Constant Gain', kind: 'audio', category: 'Crossfade' },
};

export const DEFAULT_VIDEO_TRANSITION = 'crossDissolve';
export const DEFAULT_AUDIO_TRANSITION = 'constantPower';

/** Fixed effects created for each clip kind, in display order. */
export function fixedEffectsFor(kind) {
  switch (kind) {
    case 'video':
    case 'image':
    case 'nest':
      return ['motion', 'opacity'];
    case 'text':
      return ['text', 'motion', 'opacity'];
    case 'color':
      return ['fill', 'motion', 'opacity'];
    case 'shape':
      return ['shape', 'motion', 'opacity'];
    case 'adjustment':
      return ['opacity'];
    case 'audio':
      return ['volume', 'panner'];
    default:
      return [];
  }
}

export function effectFamily(clipKind) {
  return clipKind === 'audio' ? 'audio' : 'video';
}

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
      return ['motion', 'opacity'];
    case 'text':
      return ['text', 'motion', 'opacity'];
    case 'color':
      return ['fill', 'motion', 'opacity'];
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

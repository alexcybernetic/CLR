import {
  CLASS_ARITH,
  CLASS_COPY,
  CLASS_HEAD0,
  CLASS_HEAD1,
  CLASS_LOOP,
  OP_CLASS,
} from '../../engine/src/opcodes.ts';

/** Solid background shared by every canvas-backed display. */
export const DISPLAY_FACE_CSS = '#0a0704';

/** RGB triples, warm phosphor family so the whole console stays monochromatic-ish. */
export const CLASS_RGB: [number, number, number][] = [
  [11, 8, 5], // no operation
  [122, 74, 8], // + -
  [255, 122, 26], // < >
  [194, 90, 8], // { }
  [255, 176, 0], // . ,
  [255, 240, 204], // [ ]
];

export const CLASS_CSS: string[] = CLASS_RGB.map(
  ([r, g, b]) => `rgb(${r},${g},${b})`,
);

/** Subdued neutral text used for the exact decimal value below each sampler byte. */
export const BYTE_LABEL_CSS = 'rgba(120,124,136,0.62)';

export interface ValueStop {
  value: number;
  rgb: [number, number, number];
}

/**
 * Numeric byte-value scale. Its cool hue keeps numeric magnitude visually
 * separate from the warm instruction classes used by the operation view.
 */
export const VALUE_STOPS: readonly ValueStop[] = [
  { value: 0, rgb: [29, 48, 60] },
  { value: 64, rgb: [36, 69, 83] },
  { value: 128, rgb: [45, 91, 106] },
  { value: 192, rgb: [61, 115, 128] },
  { value: 255, rgb: [91, 144, 152] },
];

/** little-endian ABGR word for direct ImageData writes */
export function abgr(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Interpolate the shared numeric byte-value scale. */
export function valueRgb(v: number, gain = 1): [number, number, number] {
  const value = Math.max(0, Math.min(255, v));
  let lower = VALUE_STOPS[0];
  let upper = VALUE_STOPS[VALUE_STOPS.length - 1];

  for (let i = 1; i < VALUE_STOPS.length; i++) {
    if (value <= VALUE_STOPS[i].value) {
      lower = VALUE_STOPS[i - 1];
      upper = VALUE_STOPS[i];
      break;
    }
  }

  const span = upper.value - lower.value;
  const t = span === 0 ? 0 : (value - lower.value) / span;
  return lower.rgb.map((channel, i) =>
    Math.min(255, Math.round((channel + (upper.rgb[i] - channel) * t) * gain)),
  ) as [number, number, number];
}

export function buildValuePalette(gain = 1): Uint32Array {
  const p = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = valueRgb(v, gain);
    p[v] = abgr(r, g, b);
  }
  return p;
}

export function buildOpsPalette(): Uint32Array {
  const p = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = operatorRgb(v);
    p[v] = abgr(r, g, b);
  }
  return p;
}

/** Shared byte colour for an operation view; no-op bytes are uniformly dark. */
export function operatorRgb(v: number): [number, number, number] {
  return CLASS_RGB[OP_CLASS[v]];
}

export const KEY_ROWS: { cls: number; glyphs: string; what: string }[] = [
  { cls: CLASS_LOOP, glyphs: '[ ]', what: 'conditional loop' },
  { cls: CLASS_COPY, glyphs: '. ,', what: 'copy between heads' },
  { cls: CLASS_HEAD0, glyphs: '< >', what: 'move head 0' },
  { cls: CLASS_HEAD1, glyphs: '{ }', what: 'move head 1' },
  { cls: CLASS_ARITH, glyphs: '+ -', what: 'increase / decrease value at head 0' },
];

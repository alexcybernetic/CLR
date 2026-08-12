/**
 * BFF instruction set.
 *
 * A tape position holds a byte 0..255 ("gene"). Exactly ten byte values decode to
 * an operation; the other 246 are inert no-ops. The instruction values are the
 * literal ASCII codes of their BFF glyphs, so a tape can be read as text.
 */

export const B_INC = 0x2b; // +   tape[h0]++
export const B_GET = 0x2c; // ,   tape[h0] = tape[h1]
export const B_DEC = 0x2d; // -   tape[h0]--
export const B_PUT = 0x2e; // .   tape[h1] = tape[h0]
export const B_H0L = 0x3c; // <   h0--
export const B_H0R = 0x3e; // >   h0++
export const B_LB = 0x5b; //  [   if tape[h0] == 0 jump past matching ]
export const B_RB = 0x5d; //  ]   if tape[h0] != 0 jump back to matching [
export const B_H1L = 0x7b; // {   h1--
export const B_H1R = 0x7d; // }   h1++

export const OP_BYTES: readonly number[] = [
  B_INC,
  B_GET,
  B_DEC,
  B_PUT,
  B_H0L,
  B_H0R,
  B_LB,
  B_RB,
  B_H1L,
  B_H1R,
];

/** Plain-language operation descriptions used by sampler readouts. */
export const OP_DESCRIPTION: Readonly<Partial<Record<number, string>>> = {
  [B_INC]: 'increase value at head 0',
  [B_GET]: 'copy value from head 1 to head 0',
  [B_DEC]: 'decrease value at head 0',
  [B_PUT]: 'copy value from head 0 to head 1',
  [B_H0L]: 'move head 0 left',
  [B_H0R]: 'move head 0 right',
  [B_LB]: 'jump forward if value at head 0 is zero',
  [B_RB]: 'jump back if value at head 0 is nonzero',
  [B_H1L]: 'move head 1 left',
  [B_H1R]: 'move head 1 right',
};

/** byte -> 1 if it decodes to an operation */
export const IS_OP: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (const b of OP_BYTES) t[b] = 1;
  return t;
})();

/** byte -> display glyph ('' for inert genes) */
export const GLYPH: string[] = (() => {
  const g = new Array<string>(256).fill('');
  for (const b of OP_BYTES) g[b] = String.fromCharCode(b);
  return g;
})();

/** Coarse operation class, used for colouring. */
export const CLASS_INERT = 0;
export const CLASS_ARITH = 1; // + -
export const CLASS_HEAD0 = 2; // < >
export const CLASS_HEAD1 = 3; // { }
export const CLASS_COPY = 4; //  . ,
export const CLASS_LOOP = 5; //  [ ]

export const OP_CLASS: Uint8Array = (() => {
  const t = new Uint8Array(256);
  t[B_INC] = CLASS_ARITH;
  t[B_DEC] = CLASS_ARITH;
  t[B_H0L] = CLASS_HEAD0;
  t[B_H0R] = CLASS_HEAD0;
  t[B_H1L] = CLASS_HEAD1;
  t[B_H1R] = CLASS_HEAD1;
  t[B_PUT] = CLASS_COPY;
  t[B_GET] = CLASS_COPY;
  t[B_LB] = CLASS_LOOP;
  t[B_RB] = CLASS_LOOP;
  return t;
})();

export const CLASS_LABEL: string[] = [
  'inert',
  '+ -',
  '< >',
  '{ }',
  '. ,',
  '[ ]',
];

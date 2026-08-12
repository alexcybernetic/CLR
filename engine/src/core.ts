import { BRAINFUCK_LIFE_WASM_B64 } from './brainfuckLife.wasm.ts';
import { CUBFF_WASM_B64 } from './cubff.wasm.ts';
import type { ReactorEngine } from './soup.ts';

/**
 * The compiled native core.
 *
 * The two native cores expose compatible browser entry points but are compiled
 * from independent C files into independent Wasm modules. Their functions take
 * pointers, so linear-memory layout is decided here rather than in either
 * native module.
 */
export interface Core {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  configure(tapeLen: number): void;
  set_seed(seed: bigint): void;
  initialize(soup: number, nPrograms: number): void;
  evaluate(tape: number, stepcount: number): number;
  last_halt(): number;
  shuffle(idx: number, nPrograms: number, epoch: bigint): void;
  run_epoch(
    soup: number,
    nPrograms: number,
    idx: number,
    mutNum: number,
    stepcount: number,
    counts: number,
    epoch: bigint,
  ): bigint;
  run_packed(
    pairs: number,
    nPairs: number,
    counts: number,
    stepcount: number,
    pairOffset: number,
    nPrograms: number,
    epoch: bigint,
    mutNum: number,
  ): bigint;
}

export interface BrainfuckLifeCore extends Core {
  mutate_soup(soup: number, nPrograms: number, mutNum: number): void;
}

export function instantiate(engine: ReactorEngine = 'cubff'): Core {
  const encoded = engine === 'brainfuck-life' ? BRAINFUCK_LIFE_WASM_B64 : CUBFF_WASM_B64;
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return inst.exports as unknown as Core;
}

/** Brainfuck-Life mutates the complete population after all pairs execute. */
export function mutatePopulation(
  core: Core,
  engine: ReactorEngine,
  soup: number,
  nPrograms: number,
  mutNum: number,
): void {
  if (engine !== 'brainfuck-life') return;
  const mutate = (core as Partial<BrainfuckLifeCore>).mutate_soup;
  if (typeof mutate !== 'function') {
    throw new Error('Brainfuck-Life core does not export mutate_soup');
  }
  mutate(soup, nPrograms, mutNum);
}

const PAGE = 65536;
const align = (n: number, to: number) => (n + to - 1) & ~(to - 1);

/** Where the soup, the permutation and the halt counters live. */
export interface Layout {
  soup: number;
  idx: number;
  counts: number;
}

/**
 * Reserve room for a soup of `nTapes` and hand back the pointers.
 *
 * The native core mutates the soup in place through the pointers it is given, so
 * growing the memory afterwards would leave every typed-array view detached.
 * Everything is sized and grown here, once, before any view is taken.
 */
export function layout(core: Core, nTapes: number, tapeLen: number): Layout {
  const heap = align(core.__heap_base.value as unknown as number, 16);
  const soup = heap;
  const idx = align(soup + nTapes * tapeLen, 4);
  const counts = align(idx + nTapes * 4, 4);
  const need = counts + 64;

  const have = core.memory.buffer.byteLength;
  if (need > have) core.memory.grow(Math.ceil((need - have) / PAGE));
  return { soup, idx, counts };
}

/** CuBFF compares a 30-bit probability value with this numerator. */
export const mutNumerator = (rate: number) => Math.round(rate * (1 << 30));

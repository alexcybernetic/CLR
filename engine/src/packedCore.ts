import { instantiate, type Core } from './core.ts';
import type { ReactorEngine } from './soup.ts';

export interface PackedJob {
  engine: ReactorEngine;
  buf: ArrayBuffer;
  nPairs: number;
  tapeLen: number;
  maxSteps: number;
  /** index of the first pair in the epoch's global permutation */
  pairOffset: number;
  nPrograms: number;
  seed: number;
  epoch: number;
  mutationNumerator: number;
}

export interface PackedReply {
  buf: ArrayBuffer;
  steps: number;
  halts: [number, number, number];
}

const PAGE = 65536;

/**
 * The stateful Wasm executor behind one shard worker.
 *
 * Keeping the memory management separate from worker message wiring lets the
 * coordinator's partitioning be tested in-process against the same executor
 * used by production workers.
 */
export class PackedCore {
  private core: Core | null = null;
  private engine: ReactorEngine | null = null;
  private pairsPtr = 0;
  private countsPtr = 0;
  private capacity = 0;
  private tapeLen = 0;

  /** Room for `nPairs` glued pairs, plus the halt counters after them. */
  private ensure(engine: ReactorEngine, nPairs: number, tapeLen: number): Core {
    if (this.engine !== null && this.engine !== engine) {
      throw new Error(`shard core is fixed to ${this.engine}, cannot run ${engine}`);
    }
    if (!this.core) {
      this.engine = engine;
      this.core = instantiate(engine);
    }
    const bytes = nPairs * tapeLen * 2;
    if (bytes > this.capacity || tapeLen !== this.tapeLen) {
      this.core.configure(tapeLen);
      const heap = (this.core.__heap_base.value as unknown as number) + 15;
      this.pairsPtr = heap & ~15;
      this.countsPtr = (this.pairsPtr + bytes + 15) & ~15;
      const need = this.countsPtr + 64;
      const have = this.core.memory.buffer.byteLength;
      if (need > have) this.core.memory.grow(Math.ceil((need - have) / PAGE));
      this.capacity = bytes;
      this.tapeLen = tapeLen;
    }
    return this.core;
  }

  run({
    engine,
    buf,
    nPairs,
    tapeLen,
    maxSteps,
    pairOffset,
    nPrograms,
    seed,
    epoch,
    mutationNumerator,
  }: PackedJob): PackedReply {
    const core = this.ensure(engine, nPairs, tapeLen);
    // CuBFF derives pair mutation from explicit coordinates. Brainfuck-Life's
    // packed path performs no RNG work; its state remains in the coordinator.
    if (engine === 'cubff') core.set_seed(BigInt(seed >>> 0));
    const packed = new Uint8Array(buf);

    new Uint8Array(core.memory.buffer, this.pairsPtr, packed.length).set(packed);
    const counts = new Uint32Array(core.memory.buffer, this.countsPtr, 3);
    counts.fill(0);
    const steps = Number(
      core.run_packed(
        this.pairsPtr,
        nPairs,
        this.countsPtr,
        maxSteps,
        pairOffset,
        nPrograms,
        BigInt(epoch),
        mutationNumerator,
      ),
    );
    packed.set(new Uint8Array(core.memory.buffer, this.pairsPtr, packed.length));

    return { buf, steps, halts: [counts[0], counts[1], counts[2]] };
  }
}

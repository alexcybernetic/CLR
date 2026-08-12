import { BROTLI_WASM_B64 } from './brotli.wasm.ts';

interface BrotliExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  _initialize(): void;
  brotli_max_compressed_size(inputSize: number): number;
  brotli_compress(
    input: number,
    inputSize: number,
    output: number,
    outputCapacity: number,
    heapStart: number,
    heapLimit: number,
  ): number;
}

const PAGE = 65536;
const ARENA_BYTES = 80 * 1024 * 1024;
const align16 = (value: number) => (value + 15) & ~15;

class PaperBrotliEncoder {
  private readonly exports: BrotliExports;

  constructor() {
    const bytes = Uint8Array.from(atob(BROTLI_WASM_B64), (character) =>
      character.charCodeAt(0),
    );
    const imports = {
      wasi_snapshot_preview1: {
        proc_exit(code: number): never {
          throw new Error(`Brotli Wasm terminated with status ${code}`);
        },
      },
    };
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
    this.exports = instance.exports as unknown as BrotliExports;
    this.exports._initialize();
  }

  compressedSize(input: Uint8Array): number {
    const { memory } = this.exports;
    const inputPointer = align16(this.exports.__heap_base.value as unknown as number);
    const outputCapacity = this.exports.brotli_max_compressed_size(input.length);
    if (outputCapacity === 0) throw new Error('Brotli cannot size this population snapshot');

    const outputPointer = align16(inputPointer + input.length);
    const arenaStart = align16(outputPointer + outputCapacity);
    const arenaLimit = arenaStart + ARENA_BYTES;
    const currentBytes = memory.buffer.byteLength;
    if (arenaLimit > currentBytes) {
      memory.grow(Math.ceil((arenaLimit - currentBytes) / PAGE));
    }

    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    const compressed = this.exports.brotli_compress(
      inputPointer,
      input.length,
      outputPointer,
      outputCapacity,
      arenaStart,
      arenaLimit,
    );
    if (compressed === 0) throw new Error('Brotli quality-2 compression failed');
    return compressed;
  }
}

let encoder: PaperBrotliEncoder | null = null;

/** Brotli 1.1.0 quality-2 compressed size, matching the reference experiment. */
export function brotliCompressedSize(input: Uint8Array): number {
  encoder ??= new PaperBrotliEncoder();
  return encoder.compressedSize(input);
}

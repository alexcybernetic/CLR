# Native modules

## Independent population cores

CLR contains two complete native reactor implementations. They are separate C
files compiled into separate Wasm modules. Neither implementation includes,
links, calls, or generates code from the other. This keeps evaluator behavior,
randomness, population lifecycle, and CLR adaptations independently traceable.

The UI labels CLR's adaptation of Johannes Martin's C port from CuBFF
**V1 — Brainfuck-Life**, and labels CLR's direct port from CuBFF **V2 —
CuBFF**. Their stable configuration and record identifiers remain
`brainfuck-life` and `cubff`, respectively. V1 and V2 identify these two port
paths; they are not application or record-schema versions.

[`cubff_soup.c`](cubff_soup.c) adapts the paper authors' CuBFF
`bff_noheads.cu` evaluator and `common_language.h` population rules, pinned to
[`8e3f774df03d1c895ec6ee0d21b6897ecea46806`](https://github.com/paradigms-of-intelligence/cubff/tree/8e3f774df03d1c895ec6ee0d21b6897ecea46806).
Its random initialization, epoch-indexed Fisher–Yates shuffle, and
pre-execution pair mutation use CuBFF's counter-derived SplitMix64 values. A
completed trajectory is independent of worker partitioning because every
random value is derived from explicit model coordinates.

[`brainfuck_life_soup.c`](brainfuck_life_soup.c) adapts Johannes Martin's
[`mathelehrer/BrainFuckLife`](https://github.com/mathelehrer/BrainFuckLife)
`bff/soup.c` C port, pinned through
[`alexcybernetic/BrainFuckLife@9d263836`](https://github.com/alexcybernetic/BrainFuckLife/tree/9d2638361a0ae5519dfe56539059cfec094cbd6e).
It retains one stateful xorshift64* stream across initialization and epochs.
The coordinator consumes that stream for initialization, Fisher–Yates shuffle,
and a complete-population mutation pass after pair execution. Execution shards
perform evaluation only, so worker partitioning cannot change RNG consumption.
Seed 0 aliases the source implementation's fixed nonzero state.

Both files retain complete evaluators and expose their own initialization,
shuffle, unsharded epoch, and packed-pair paths. CLR's adaptations are kept in
each file separately:

- runtime tape length;
- termination-cause counters;
- phase-separated and packed-pair entry points for sharding;
- a local `memcpy` for `wasm32-freestanding`.

Both sources use 64-byte tapes. CLR's 32-byte and 128-byte settings and
adjustable step limit are experiment extensions; Brainfuck-Life's bit-exact
source-compatibility claim applies to 64-byte tapes.

The TypeScript evaluator exists only for the inspectable sampler. Automated
validation checks it against the native evaluator, checks CuBFF checkpoints
against its pinned CPU source, and checks Brainfuck-Life initialization and
epochs against fixtures captured from the pinned independent source library.
Both native engines are also checked for exact 1/3/7-worker equivalence.

## Compression measurement

[`brotli_bridge.c`](brotli_bridge.c) exposes the minimum encoder API required by
the population-order measurement. The upstream Brotli 1.1.0 common and encoder
sources are pinned in [`vendor/brotli`](vendor/brotli) and compiled to a third,
independent `wasm32-wasi` reactor module. The encoder runs at quality 2, window
bits 24, generic mode, and the input-size hint, matching CuBFF's
`BrotliEncoderCompress(2, 24, BROTLI_MODE_GENERIC, ...)` call.

Run `npm run build:wasm` to compile and embed the two population modules and the
Brotli module. Zig must be available on `PATH`.

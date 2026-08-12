/*
 * Deterministic model-level checks for the compiled core and its sharded path.
 *
 * `tools/conformance.ts` compares the sampler VM with both C evaluators;
 * this file protects complete epochs: independent native trajectories,
 * partitioning across shards, buffer transfers, engine-specific mutation, and
 * state-preserving runtime changes.
 */
import { instantiate, layout, mutNumerator, type Core, type Layout } from '../engine/src/core.ts';
import { PackedCore, type PackedJob } from '../engine/src/packedCore.ts';
import { measureOrder } from '../engine/src/order.ts';
import { ParallelSoup, type WorkerFactory } from '../engine/src/parallelSoup.ts';
import type { EpochStats, SoupConfig } from '../engine/src/soup.ts';
import { HEAD_WRAP, NOMATCH_HALT } from '../engine/src/vm.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`epoch conformance: ${message}`);
}

function firstDifferentByte(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function assertBytes(a: Uint8Array, b: Uint8Array, context: string): void {
  const at = firstDifferentByte(a, b);
  assert(
    at < 0,
    `${context}: byte ${at} differs (${String(a[at])} versus ${String(b[at])}); lengths ${a.length} and ${b.length}`,
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function zeroOrderEntropy(bytes: Uint8Array): number {
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte]++;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** The unsharded C epoch path, used as the oracle for coordinator tests. */
class ReferenceSoup {
  cfg: SoupConfig;
  data: Uint8Array;
  epoch = 0;

  private readonly core: Core;
  private readonly mem: Layout;
  private readonly counts: Uint32Array;

  constructor(cfg: SoupConfig) {
    this.cfg = { ...cfg };
    this.core = instantiate(cfg.engine);
    this.core.configure(cfg.tapeLen);
    this.mem = layout(this.core, cfg.nTapes, cfg.tapeLen);
    this.data = new Uint8Array(
      this.core.memory.buffer,
      this.mem.soup,
      cfg.nTapes * cfg.tapeLen,
    );
    this.counts = new Uint32Array(this.core.memory.buffer, this.mem.counts, 3);
    this.core.set_seed(BigInt(cfg.seed >>> 0));
    this.core.initialize(this.mem.soup, cfg.nTapes);
  }

  runEpoch(): EpochStats {
    this.counts.fill(0);
    const steps = Number(
      this.core.run_epoch(
        this.mem.soup,
        this.cfg.nTapes,
        this.mem.idx,
        mutNumerator(this.cfg.mutationRate),
        this.cfg.maxSteps,
        this.mem.counts,
        BigInt(this.epoch),
      ),
    );
    this.epoch++;
    const execs = this.cfg.nTapes >> 1;
    return {
      execs,
      steps,
      meanSteps: execs ? steps / execs : 0,
      halts: [0, this.counts[0], this.counts[1], 0, this.counts[2]],
      ms: 0,
    };
  }
}

/*
 * These completed-epoch fixtures use an explicit configuration independent of
 * mutable UI defaults. They were captured from an unmodified CPU build of
 * CuBFF's paper-era commit 8e3f774df03d1c895ec6ee0d21b6897ecea46806.
 * Hashing happens after pair-local mutation and evaluation have completed for
 * the epoch.
 */
const REFERENCE_CONFIG: SoupConfig = {
  engine: 'cubff',
  nTapes: 4096,
  tapeLen: 64,
  maxSteps: 8192,
  mutationRate: 1 / 4096,
  headPolicy: HEAD_WRAP,
  noMatch: NOMATCH_HALT,
  seed: 4,
};

const GOLDEN: ReadonlyMap<
  number,
  { hash: string; steps: number }
> = new Map([
  [
    1,
    {
      hash: '0540a1d454f20cd0a058f85f8509787496f2afdf83715c6c3b59ad631f9005b1',
      steps: 127551,
    },
  ],
  [
    10,
    {
      hash: '4fd8c944db82c5b995323368837aa4fca828b4ec08209e09aee32f003ef58933',
      steps: 127948,
    },
  ],
  [
    100,
    {
      hash: 'b0501a7f007849ae4ce0703674982e810c344eff238abad45b1c4f94a739cec6',
      steps: 143976,
    },
  ],
]);

const goldenSoup = new ReferenceSoup(REFERENCE_CONFIG);
for (let epoch = 1; epoch <= 100; epoch++) {
  const stats = goldenSoup.runEpoch();
  const expected = GOLDEN.get(epoch);
  if (!expected) continue;
  const hash = await sha256(goldenSoup.data);
  assert(hash === expected.hash, `epoch ${epoch}: SHA-256 ${hash}, expected ${expected.hash}`);
  assert(stats.steps === expected.steps, `epoch ${epoch}: ${stats.steps} operations, expected ${expected.steps}`);
  if (epoch === 1) {
    const h0 = zeroOrderEntropy(goldenSoup.data);
    const order = await measureOrder(goldenSoup.data.slice(), h0);
    assert(
      order.compressed === 262155,
      `epoch 1: Brotli size ${order.compressed}, expected 262155`,
    );
  }
}

/*
 * Captured from the independent Brainfuck-Life C source at revision
 * 9d2638361a0ae5519dfe56539059cfec094cbd6e.
 *
 * The epoch-zero hash protects random initialization. Later hashes and exact
 * operation counts protect the stateful shuffle, evaluator, and post-epoch
 * mutation trajectory.
 */
const BRAINFUCK_LIFE_CONFIG: SoupConfig = {
  engine: 'brainfuck-life',
  nTapes: 4096,
  tapeLen: 64,
  maxSteps: 8192,
  mutationRate: 1 / 4096,
  headPolicy: HEAD_WRAP,
  noMatch: NOMATCH_HALT,
  seed: 4,
};

const BRAINFUCK_LIFE_GOLDEN = new Map([
  [0, { hash: '4c43f8441d7dabcc294484978e86c6216adf868d5459d9e1ec34e0e10a1ed8cc', steps: 0 }],
  [1, { hash: 'e98622995d5cf26e88cb0f5c66f6bb750581769a295b2ddaf496c9316881f252', steps: 122827 }],
  [10, { hash: 'def79c3948e5dc28ca5b7ae9fd6b31f965403eeb27eef90fff3efaac1ea9926c', steps: 122829 }],
  [100, { hash: 'bebaab9ce288040b6e1a257d3e0dba5d432e001c34152e7eed930b3bad452b8b', steps: 141066 }],
]);

const brainfuckLifeGoldenSoup = new ReferenceSoup(BRAINFUCK_LIFE_CONFIG);
assert(
  (await sha256(brainfuckLifeGoldenSoup.data)) === BRAINFUCK_LIFE_GOLDEN.get(0)?.hash,
  'Brainfuck-Life epoch 0 population differs from the pinned source fixture',
);
for (let epoch = 1; epoch <= 100; epoch++) {
  const stats = brainfuckLifeGoldenSoup.runEpoch();
  const expected = BRAINFUCK_LIFE_GOLDEN.get(epoch);
  if (!expected) continue;
  const hash = await sha256(brainfuckLifeGoldenSoup.data);
  assert(
    hash === expected.hash,
    `Brainfuck-Life epoch ${epoch}: SHA-256 ${hash}, expected ${expected.hash}`,
  );
  assert(
    stats.steps === expected.steps,
    `Brainfuck-Life epoch ${epoch}: ${stats.steps} operations, expected ${expected.steps}`,
  );
}

const brainfuckLifeSeedZero = new ReferenceSoup({ ...BRAINFUCK_LIFE_CONFIG, seed: 0 });
assert(
  (await sha256(brainfuckLifeSeedZero.data)) ===
    'c631206b3198d436c4b0835c6cb6dbc4c65822d42be838200627a03236560a42',
  'Brainfuck-Life seed-zero alias differs from the pinned source fixture',
);

const brainfuckLifeZeroMutation = new ReferenceSoup({
  ...BRAINFUCK_LIFE_CONFIG,
  mutationRate: 0,
});
const zeroMutationFirst = brainfuckLifeZeroMutation.runEpoch();
brainfuckLifeZeroMutation.cfg.mutationRate = 1 / 4096;
const zeroMutationSecond = brainfuckLifeZeroMutation.runEpoch();
assert(zeroMutationFirst.steps === 122827, 'Brainfuck-Life zero-mutation epoch operation count changed');
assert(zeroMutationSecond.steps === 125036, 'Brainfuck-Life post-zero-mutation operation count changed');
assert(
  (await sha256(brainfuckLifeZeroMutation.data)) ===
    'fb13ede3a71a2ff363b25df86cb81d4212da993e3c56fc5669572744bf577397',
  'Brainfuck-Life mutation zero consumed RNG draws or changed the subsequent trajectory',
);

/**
 * Browser-compatible worker behavior backed by the production PackedCore.
 * Both directions use structured-clone transfer, so the coordinator sees the
 * same detached-buffer lifecycle it sees with a real Worker.
 */
class InProcessWorker extends EventTarget {
  private readonly packed = new PackedCore();
  private live = true;

  constructor() {
    super();
    queueMicrotask(() => {
      if (this.live) this.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
    });
  }

  postMessage(message: PackedJob, transfer: Transferable[] = []): void {
    if (!this.live) return;
    const job = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (!this.live) return;
      try {
        const result = this.packed.run(job);
        const reply = structuredClone(result, { transfer: [result.buf] });
        this.dispatchEvent(new MessageEvent('message', { data: reply }));
      } catch (error) {
        const event = new Event('error');
        Object.defineProperty(event, 'message', {
          value: error instanceof Error ? error.message : String(error),
        });
        this.dispatchEvent(event);
      }
    });
  }

  terminate(): void {
    this.live = false;
  }
}

const inProcessWorker: WorkerFactory = () => new InProcessWorker() as unknown as Worker;

function assertStats(actual: EpochStats, expected: EpochStats, context: string): void {
  assert(actual.execs === expected.execs, `${context}: execs ${actual.execs}, expected ${expected.execs}`);
  assert(actual.steps === expected.steps, `${context}: operations ${actual.steps}, expected ${expected.steps}`);
  assert(
    actual.meanSteps === expected.meanSteps,
    `${context}: mean operations ${actual.meanSteps}, expected ${expected.meanSteps}`,
  );
  assert(
    actual.halts.length === expected.halts.length &&
      actual.halts.every((count, halt) => count === expected.halts[halt]),
    `${context}: halt counts ${actual.halts.join(',')}, expected ${expected.halts.join(',')}`,
  );
}

const SHARD_CONFIG: SoupConfig = {
  engine: 'cubff',
  nTapes: 256,
  tapeLen: 64,
  maxSteps: 8192,
  mutationRate: 1 / 4096,
  headPolicy: HEAD_WRAP,
  noMatch: NOMATCH_HALT,
  seed: 4,
};

for (const engine of ['cubff', 'brainfuck-life'] as const) {
  const config = { ...SHARD_CONFIG, engine };
  for (const shards of [1, 3, 7]) {
    const direct = new ReferenceSoup(config);
    const parallel = await ParallelSoup.create(config, shards, inProcessWorker);
    try {
      assert(parallel.workerCount === shards, `${engine} did not construct ${shards} workers`);
      assertBytes(parallel.data, direct.data, `${engine}, ${shards} shards at initialization`);
      for (let epoch = 1; epoch <= 100; epoch++) {
        const expected = direct.runEpoch();
        const actual = await parallel.runEpoch();
        const context = `${engine}, ${shards} shards at epoch ${epoch}`;
        assert(parallel.epoch === epoch, `${context}: coordinator epoch is ${parallel.epoch}`);
        assertStats(actual, expected, context);
        assertBytes(parallel.data, direct.data, context);
      }
    } finally {
      parallel.dispose();
    }
  }
}

// Pool replacement is state-preserving; non-shape configuration changes are
// state-preserving; shape changes and explicit reseeding are deterministic.
async function verifyLifecycle(engine: SoupConfig['engine']): Promise<void> {
  const lifecycleConfig: SoupConfig = {
    ...SHARD_CONFIG,
    engine,
    nTapes: 128,
    tapeLen: 32,
    maxSteps: 2048,
    seed: 19,
  };
  const lifecycle = await ParallelSoup.create(lifecycleConfig, 1, inProcessWorker);
  try {
  const lifecycleOracle = new ReferenceSoup(lifecycleConfig);
  for (let epoch = 1; epoch <= 3; epoch++) {
    assertStats(
      await lifecycle.runEpoch(),
      lifecycleOracle.runEpoch(),
      `${engine} lifecycle epoch ${epoch}`,
    );
  }
  assertBytes(lifecycle.data, lifecycleOracle.data, `${engine} lifecycle before worker change`);

  const beforeWorkers = lifecycle.data.slice();
  const beforeWorkerEpoch = lifecycle.epoch;
  await lifecycle.setShards(3);
  assert(lifecycle.shards === 3, `worker change: shard count is ${lifecycle.shards}`);
  assert(lifecycle.epoch === beforeWorkerEpoch, `${engine} worker change reset the epoch`);
  assertBytes(lifecycle.data, beforeWorkers, `${engine} worker change altered the soup`);

  const changedLimit = { ...lifecycle.cfg, maxSteps: 4096 };
  lifecycle.reshape(changedLimit);
  lifecycleOracle.cfg.maxSteps = changedLimit.maxSteps;
  assert(lifecycle.epoch === beforeWorkerEpoch, `${engine} step-limit change reset the epoch`);
  assertBytes(lifecycle.data, beforeWorkers, `${engine} step-limit change altered the soup`);
  assertStats(
    await lifecycle.runEpoch(),
    lifecycleOracle.runEpoch(),
    `${engine} first epoch after worker and step-limit changes`,
  );
  assertBytes(lifecycle.data, lifecycleOracle.data, `${engine} continuation after runtime changes`);

  const resizedConfig: SoupConfig = {
    ...changedLimit,
    nTapes: 64,
    tapeLen: 64,
  };
  lifecycle.reshape(resizedConfig);
  const resizedOracle = new ReferenceSoup(resizedConfig);
  assert(lifecycle.epoch === 0, `${engine} shape change did not reset the epoch`);
  assert(lifecycle.data.length === 64 * 64, `shape change produced ${lifecycle.data.length} bytes`);
  assertBytes(
    lifecycle.data,
    resizedOracle.data,
    `${engine} shape change did not reseed deterministically`,
  );
  assertStats(
    await lifecycle.runEpoch(),
    resizedOracle.runEpoch(),
    `${engine} first epoch after shape change`,
  );
  assertBytes(lifecycle.data, resizedOracle.data, `${engine} continuation after shape change`);

  lifecycle.cfg.seed = 29;
  lifecycle.randomize();
  const resetOracle = new ReferenceSoup({ ...resizedConfig, seed: 29 });
  assert(lifecycle.epoch === 0, `${engine} explicit reset did not reset the epoch`);
  assertBytes(lifecycle.data, resetOracle.data, `${engine} explicit reset did not reproduce its seed`);
  } finally {
    lifecycle.dispose();
  }
}

await verifyLifecycle('cubff');
await verifyLifecycle('brainfuck-life');

console.log(
  'epoch conformance: CuBFF and Brainfuck-Life source fixtures, shards, transfers, and runtime state changes passed',
);

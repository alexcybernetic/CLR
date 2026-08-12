/* Focused correctness checks for telemetry and scientific readouts. */
import { byteFrequencyOrder, measureOrder } from '../engine/src/order.ts';
import { OP_DESCRIPTION } from '../engine/src/opcodes.ts';
import { ParallelSoup } from '../engine/src/parallelSoup.ts';
import {
  assessAvailableWorkerCount,
  deriveAutoWorkerCount,
  normalizeWorkerSelection,
} from '../engine/src/protocol.ts';
import { longestCommonSubstring, verifyReplication } from '../engine/src/replication.ts';
import { SoupMetrics, type Metrics, type SoupConfig } from '../engine/src/soup.ts';
import { HEAD_WRAP, NOMATCH_HALT } from '../engine/src/vm.ts';
import { FramePacer } from '../appweb/ui/framePacer.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`regression: ${message}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function config(nTapes: number, tapeLen: number): SoupConfig {
  return {
    engine: 'cubff',
    nTapes,
    tapeLen,
    maxSteps: 256,
    mutationRate: 0,
    headPolicy: HEAD_WRAP,
    noMatch: NOMATCH_HALT,
    seed: 4,
  };
}

const automaticWorkerExamples = new Map<number, number>([
  [10, 8],
  [8, 6],
  [4, 3],
  [24, 16],
  [1, 1],
]);
for (const [available, expected] of automaticWorkerExamples) {
  assert(
    deriveAutoWorkerCount(available) === expected,
    `${available} available workers did not derive Auto (${expected})`,
  );
}
assert(
  assessAvailableWorkerCount(undefined) === 4 && deriveAutoWorkerCount(undefined) === 3,
  'unavailable browser concurrency did not use capacity 4 and derive Auto (3)',
);
for (const invalid of [0, -1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert(
    assessAvailableWorkerCount(invalid) === 4 && deriveAutoWorkerCount(invalid) === 3,
    `invalid browser concurrency ${String(invalid)} did not use the fallback`,
  );
}
assert(
  normalizeWorkerSelection({ mode: 'auto', count: 8 }).count === 8 &&
    normalizeWorkerSelection({ mode: 'fixed', count: 8 }).count === 8,
  'valid automatic and fixed worker selections were not retained',
);
for (const invalid of [0, 1.5, 17]) {
  let rejected = false;
  try {
    normalizeWorkerSelection({ mode: 'auto', count: invalid });
  } catch {
    rejected = true;
  }
  assert(rejected, `invalid automatic worker count ${invalid} was accepted`);
}
for (const invalid of [0, 1.5]) {
  let rejected = false;
  try {
    normalizeWorkerSelection({ mode: 'fixed', count: invalid });
  } catch {
    rejected = true;
  }
  assert(rejected, `invalid fixed worker count ${invalid} was accepted`);
}

const expectedOperationDescriptions: Record<number, string> = {
  43: 'increase value at head 0',
  44: 'copy value from head 1 to head 0',
  45: 'decrease value at head 0',
  46: 'copy value from head 0 to head 1',
  60: 'move head 0 left',
  62: 'move head 0 right',
  91: 'jump forward if value at head 0 is zero',
  93: 'jump back if value at head 0 is nonzero',
  123: 'move head 1 left',
  125: 'move head 1 right',
};
assert(Object.keys(OP_DESCRIPTION).length === 10, 'sampler description table is incomplete');
for (const [byte, description] of Object.entries(expectedOperationDescriptions)) {
  assert(
    OP_DESCRIPTION[Number(byte)] === description,
    `sampler description for byte ${byte} is incorrect`,
  );
}

const pacer = new FramePacer();
const tenthSteps = Array.from({ length: 20 }, () => pacer.take(0.1));
assert(
  tenthSteps.join(',') === '0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1',
  '0.1 sampler pacing did not emit one step every ten frames',
);
pacer.reset();
assert(
  [pacer.take(0.5), pacer.take(0.5), pacer.take(0.5), pacer.take(0.5)].join(',') === '0,1,0,1',
  '0.5 sampler pacing did not emit one step every two frames',
);
pacer.reset();
assert(pacer.take(1) === 1, '1.0 sampler pacing did not emit one step per frame');
pacer.reset();
assert(pacer.take(5) === 5, '5.0 sampler pacing did not emit five steps per frame');
pacer.reset();
assert(pacer.take(0.5) === 0, '0.5 sampler pacing advanced on its first frame');
pacer.reset();
assert(pacer.take(0.5) === 0, 'sampler pacing retained fractional work after reset');

// These distinct 8-byte values have the same 32-bit FNV-1a hash. They must not
// become either an identical tape lineage or one repeated motif.
const collisionA = Uint8Array.of(108, 18, 35, 92, 60, 167, 123, 164);
const collisionB = Uint8Array.of(232, 135, 56, 214, 241, 252, 37, 24);
const collisionSoup = new Uint8Array(16);
collisionSoup.set(collisionA, 0);
collisionSoup.set(collisionB, 8);
const collisionMetrics = new SoupMetrics().compute(config(2, 8), collisionSoup);
assert(collisionMetrics.uniqueTapes === 2, 'a hash collision merged distinct tapes');
assert(collisionMetrics.largestLineage === 1, 'a hash collision created a false lineage');
assert(
  collisionMetrics.tapeFrequencies.length === 2 &&
    collisionMetrics.tapeFrequencies.every((group) => group.count === 1),
  'a hash collision created a false tape-frequency group',
);
assert(
  equalBytes(collisionMetrics.tapeFrequencies[0].bytes, collisionA) &&
    equalBytes(collisionMetrics.tapeFrequencies[1].bytes, collisionB),
  'equal content hashes did not retain separate exact tape groups',
);
assert(
  collisionMetrics.motifs.every((motif) => motif.count === 1),
  'a hash collision created a false repeated motif',
);

const duplicateSoup = new Uint8Array(24);
duplicateSoup.set(collisionA, 0);
duplicateSoup.set(collisionA, 8);
duplicateSoup.set(collisionB, 16);
const duplicateMetrics = new SoupMetrics().compute(config(3, 8), duplicateSoup);
assert(duplicateMetrics.uniqueTapes === 2, 'an exact duplicate was not grouped');
assert(duplicateMetrics.largestLineage === 2, 'an exact duplicate lineage was not counted');
assert(
  duplicateMetrics.tapeFrequencies[0].count === 2 &&
    equalBytes(duplicateMetrics.tapeFrequencies[0].bytes, collisionA),
  'the tape-frequency ranking did not place the commonest exact tape first',
);
const repeatedA = duplicateMetrics.motifs.find((motif) => equalBytes(motif.bytes, collisionA));
assert(repeatedA?.count === 2, 'an exact repeated motif was not counted');

const distinctTapeSoup = Uint8Array.from({ length: 65 }, (_, value) => value);
const distinctTapeMetrics = new SoupMetrics().compute(config(65, 1), distinctTapeSoup);
assert(
  distinctTapeMetrics.tapeFrequencies.length === 64,
  'the tape-frequency snapshot did not retain exactly the leading 64 groups',
);
assert(
  distinctTapeMetrics.tapeFrequencies[0].bytes[0] === 0 &&
    distinctTapeMetrics.tapeFrequencies[63].bytes[0] === 63,
  'equal-count tape-frequency groups did not retain population order',
);

const uniformAlphabet = Uint8Array.from({ length: 256 }, (_, value) => value);
const uniformMetrics = new SoupMetrics().compute(config(8, 32), uniformAlphabet);
assert(
  Math.abs(uniformMetrics.entropy - 8) < 1e-12,
  'a uniform byte distribution did not have 8 bits/byte of entropy',
);
assert(
  Math.abs(byteFrequencyOrder(uniformMetrics.entropy)) < 1e-12,
  'a uniform byte distribution did not have zero byte-frequency order',
);
const concentratedMetrics = new SoupMetrics().compute(config(8, 32), new Uint8Array(256));
assert(concentratedMetrics.entropy === 0, 'a one-value population did not have zero entropy');
assert(
  byteFrequencyOrder(concentratedMetrics.entropy) === 8,
  'a one-value population did not have maximal byte-frequency order',
);

assert(
  longestCommonSubstring(Uint8Array.of(1, 2, 3, 4), Uint8Array.of(9, 1, 2, 3, 8)) === 3,
  'copied-run scoring is not offset-independent',
);

const motif = Uint8Array.of(91, 91, 123, 46, 62, 93, 45, 93);
const probeSoup = new Uint8Array(4 * 16);
let random = 0x19a4c3d2;
for (let i = 0; i < probeSoup.length; i++) {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  probeSoup[i] = random & 255;
}
for (let tape = 0; tape < 4; tape++) probeSoup.set(motif, tape * 16);
const probeBefore = probeSoup.slice();
const probeConfig = config(4, 16);
const makeProbeMetrics = (): Metrics => ({
  entropy: 0,
  distinctBytes: 0,
  uniqueTapes: 4,
  largestLineage: 1,
  motifs: [{ bytes: motif.slice(), count: 4, carriers: 0, copiedBytes: 0 }],
  motifTotal: 36,
  tapeFrequencies: [],
  populationFingerprint: '00000000',
});
const probeOne = makeProbeMetrics();
const probeTwo = makeProbeMetrics();
verifyReplication(probeOne, probeConfig, probeSoup, 17);
verifyReplication(probeTwo, probeConfig, probeSoup, 17);
assert(equalBytes(probeSoup, probeBefore), 'replication telemetry mutated the soup');
assert(probeOne.motifs[0].carriers === 4, 'replication telemetry did not test distinct carriers');
assert(
  probeOne.motifs[0].copiedBytes === probeTwo.motifs[0].copiedBytes,
  'replication telemetry is not deterministic',
);

class FailingWorker extends EventTarget {
  static instances: FailingWorker[] = [];
  static failStartupAt = -1;
  terminated = false;

  constructor(..._args: unknown[]) {
    super();
    const index = FailingWorker.instances.length;
    FailingWorker.instances.push(this);
    queueMicrotask(() =>
      this.dispatchEvent(
        index === FailingWorker.failStartupAt
          ? new Event('error')
          : new MessageEvent('message', { data: { ready: true } }),
      ),
    );
  }

  postMessage(..._args: unknown[]): void {
    queueMicrotask(() => this.dispatchEvent(new Event('error')));
  }

  terminate(): void {
    this.terminated = true;
  }
}

// A runtime shard error must reject the epoch immediately and tear down the
// complete pool; it must never leave Promise.all waiting forever.
const failingWorkerFactory = () => new FailingWorker() as unknown as Worker;
FailingWorker.failStartupAt = 1;
let startupRejected = false;
try {
  await ParallelSoup.create(config(2, 8), 2, failingWorkerFactory);
} catch {
  startupRejected = true;
}
assert(startupRejected, 'a partial shard startup failure did not reject pool creation');
assert(
  FailingWorker.instances.every((worker) => worker.terminated),
  'a partial shard startup failure leaked workers',
);

FailingWorker.instances = [];
FailingWorker.failStartupAt = -1;
const failingSoup = await ParallelSoup.create(config(2, 8), 2, failingWorkerFactory);
let rejected = false;
try {
  await failingSoup.runEpoch();
} catch {
  rejected = true;
}
assert(rejected, 'a shard runtime error did not reject the epoch');
assert(
  FailingWorker.instances.every((worker) => worker.terminated),
  'a shard runtime error did not dispose the complete pool',
);

// The old implementation truncated this size to a 2 MiB sample.
const aboveFormerBudget = new Uint8Array((1 << 21) + 257);
const order = await measureOrder(aboveFormerBudget, 0);
assert(order.raw === aboveFormerBudget.length, 'order measurement did not consume the complete soup');

// These populations have exactly the same uniform byte histogram. Only the
// repeated ordering should create a substantial high-order entropy estimate.
const orderedBytes = Uint8Array.from({ length: 1 << 16 }, (_, index) => index & 255);
const shuffledBytes = orderedBytes.slice();
let shuffleState = 0x243f6a88;
for (let index = shuffledBytes.length - 1; index > 0; index--) {
  shuffleState ^= shuffleState << 13;
  shuffleState ^= shuffleState >>> 17;
  shuffleState ^= shuffleState << 5;
  const other = (shuffleState >>> 0) % (index + 1);
  const value = shuffledBytes[index];
  shuffledBytes[index] = shuffledBytes[other];
  shuffledBytes[other] = value;
}
const orderedMeasurement = await measureOrder(orderedBytes, 8);
const shuffledMeasurement = await measureOrder(shuffledBytes, 8);
assert(
  orderedMeasurement.byteOrder === shuffledMeasurement.byteOrder &&
    orderedMeasurement.byteOrder === 0,
  'byte-frequency order changed when only byte positions changed',
);
assert(
  orderedMeasurement.highOrder > shuffledMeasurement.highOrder + 2,
  'high-order entropy did not distinguish repeated ordering from a shuffled histogram',
);

console.log(
  'regression: sampler readouts, exact telemetry, population order, deterministic replication, and shard lifecycle checks passed',
);

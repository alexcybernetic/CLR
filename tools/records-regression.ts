import {
  LEGACY_RECORD_SCHEMA_VERSION,
  PREVIOUS_RECORD_SCHEMA_VERSION,
  RECORD_SCHEMA_VERSION,
  emptyCumulative,
  isComputePath,
  normalizeExperimentRecord,
  normalizeRunEvent,
  normalizeRunMeasurement,
  normalizeRunRecord,
  type ExperimentRecord,
} from '../appweb/records/model.ts';
import { expandSeedRuns, MAX_BATCH_RUNS } from '../appweb/records/batch.ts';
import {
  BRAINFUCK_LIFE_SOURCE_REVISION,
  CUBFF_SOURCE_REVISION,
  modelIdentity,
} from '../appweb/records/identity.ts';
import { RunRecorder } from '../appweb/records/recorder.ts';
import { MemoryRunRepository } from '../appweb/records/repository.ts';
import { COMPUTE_PATHS } from '../engine/src/protocol.ts';
import { HEAD_WRAP, NOMATCH_HALT } from '../engine/src/vm.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`records regression: ${message}`);
}

const repository = new MemoryRunRepository();
const recorder = new RunRecorder(Promise.resolve(repository), (error) => {
  throw error;
});
const config = {
  engine: 'cubff' as const,
  nTapes: 1024,
  tapeLen: 64,
  maxSteps: 8192,
  mutationRate: 1 / 4096,
  headPolicy: HEAD_WRAP,
  noMatch: NOMATCH_HALT,
  seed: 19,
};
const identity = {
  appVersion: 'test',
  core: 'pending',
  sourceRevision: 'test-source',
  compressor: 'test-compressor',
};
const execution = {
  computePath: 'wasm' as const,
  gpuAdapter: null,
  workerMode: 'fixed' as const,
  workerCount: 2,
  epochsPerSecondLimit: 0,
};

const populatedGpuAdapter = {
  vendor: 'test-vendor',
  architecture: 'test-architecture',
  device: 'test-device',
  description: 'test WebGPU adapter',
  isFallbackAdapter: false,
};

assert(COMPUTE_PATHS.join(',') === 'wasm,webgpu', 'compute-path protocol values changed');
assert(isComputePath('wasm'), 'Wasm was rejected as a compute path');
assert(isComputePath('webgpu'), 'WebGPU was rejected as a compute path');
for (const invalid of ['', 'gpu', 'cpu', 'WEBGPU', null, 0]) {
  assert(!isComputePath(invalid), `invalid compute path ${String(invalid)} was accepted`);
}

const expandedSeeds = expandSeedRuns(
  {
    config,
    computePath: 'wasm',
    epochLimit: 20000,
    orderCrossing: 2,
    measurementInterval: 128,
  },
  3,
);
assert(
  expandedSeeds.map((item) => item.config.seed).join(',') === '19,20,21',
  'seed expansion did not materialize consecutive explicit runs',
);
assert(
  expandedSeeds[0].config !== expandedSeeds[1].config,
  'seed expansion shared mutable configuration objects',
);
const expandedGpuSeeds = expandSeedRuns(
  { ...expandedSeeds[0], computePath: 'webgpu' },
  2,
);
assert(
  expandedGpuSeeds.every((item) => item.computePath === 'webgpu'),
  'seed expansion discarded the requested compute path',
);
assert(MAX_BATCH_RUNS === 100, 'batch queue limit changed without updating its policy');
assert(
  (() => {
    try {
      expandSeedRuns({ ...expandedSeeds[0], config: { ...config, seed: 0xffffffff } }, 2);
      return false;
    } catch {
      return true;
    }
  })(),
  'seed expansion wrapped beyond the unsigned 32-bit range',
);

recorder.prepare({
  id: 'manual-1',
  source: 'manual',
  config,
  identity,
  execution,
  highOrderThreshold: 0.45,
  createdAt: 100,
});
recorder.observeSnapshot({
  runId: 'manual-1',
  epoch: 0,
  running: false,
  config,
  cumulative: emptyCumulative(),
  workerMode: 'fixed',
  workerCount: 2,
  computePath: 'wasm',
  gpuAdapter: null,
  populationFingerprint: '00000000',
  core: 'wasm ×2',
  observedAt: 101,
});
await recorder.flush();
assert((await repository.listRuns()).length === 0, 'an unused epoch-zero population was stored');

recorder.setRunning(true, 102);
const epochOne = {
  epochs: 1,
  interactions: 512,
  steps: 4096,
  computeMs: 4,
  halts: [0, 400, 0, 112, 0],
};
recorder.observeSnapshot({
  runId: 'manual-1',
  epoch: 1,
  running: true,
  config,
  cumulative: epochOne,
  workerMode: 'fixed',
  workerCount: 2,
  computePath: 'wasm',
  gpuAdapter: null,
  populationFingerprint: '11111111',
  core: 'wasm ×2',
  observedAt: 103,
});
recorder.recordEvent({
  kind: 'model-parameter',
  requestedAt: 104,
  appliedAt: 105,
  appliedEpoch: 1,
  configRevision: 2,
  changes: { mutationRate: 0.001 },
});
recorder.observeMeasurement({
  epoch: 1,
  configRevision: 2,
  capturedAt: 106,
  highOrder: 0.4,
  byteFrequencyOrder: 0.2,
  zeroOrderEntropy: 7.8,
  compressedBitsPerByte: 7.4,
  compressedBytes: 947,
  rawBytes: 1024,
  population: {
    distinctBytes: 256,
    distinctTapes: 1024,
    largestIdenticalGroup: 1,
    motifWindowCount: 58368,
    motifs: [],
  },
  epochInteractions: 512,
  epochSteps: 4096,
  epochHalts: epochOne.halts,
  cumulative: epochOne,
  populationFingerprint: '11111111',
});
await recorder.flush();

let stored = await repository.getRun('manual-1');
assert(stored?.schemaVersion === RECORD_SCHEMA_VERSION, 'run schema was not stored');
assert(stored.status === 'running', 'first executed epoch did not start the record');
assert(stored.measurementCount === 1, 'measurement count was not updated atomically');
assert(stored.eventCount === 1, 'event count was not updated atomically');
assert((await repository.listMeasurements('manual-1')).length === 1, 'measurement was not stored');
assert((await repository.listEvents('manual-1')).length === 1, 'parameter event was not stored');

const epochTwo = {
  epochs: 2,
  interactions: 1024,
  steps: 9000,
  computeMs: 9,
  halts: [0, 790, 0, 234, 0],
};
recorder.observeSnapshot({
  runId: 'manual-1',
  epoch: 2,
  running: false,
  config: { ...config, mutationRate: 0.001 },
  cumulative: epochTwo,
  workerMode: 'fixed',
  workerCount: 2,
  computePath: 'wasm',
  gpuAdapter: null,
  populationFingerprint: '22222222',
  core: 'wasm ×2',
  observedAt: 110,
});
// An asynchronous compression result from epoch one must not roll the run
// summary back from the newer snapshot.
recorder.observeMeasurement({
  epoch: 1,
  configRevision: 2,
  capturedAt: 111,
  highOrder: 0.5,
  byteFrequencyOrder: 0.2,
  zeroOrderEntropy: 7.8,
  compressedBitsPerByte: 7.3,
  compressedBytes: 934,
  rawBytes: 1024,
  population: {
    distinctBytes: 256,
    distinctTapes: 1024,
    largestIdenticalGroup: 1,
    motifWindowCount: 58368,
    motifs: [],
  },
  epochInteractions: 512,
  epochSteps: 4096,
  epochHalts: epochOne.halts,
  cumulative: epochOne,
  populationFingerprint: '11111111',
});
recorder.finish('restart', 112);
await recorder.flush();
stored = await repository.getRun('manual-1');
assert(stored?.status === 'completed', 'restart did not complete the previous record');
assert(stored.finalEpoch === 2, 'late measurement rolled back the final epoch');
assert(stored.cumulative.steps === 9000, 'late measurement rolled back cumulative steps');
assert(stored.finalPopulationFingerprint === '22222222', 'late measurement replaced fingerprint');
assert(stored.firstThresholdCrossing?.epoch === 1, 'threshold crossing epoch was not retained');
assert(stored.firstThresholdCrossing.steps === 4096, 'threshold crossing work was not retained');

recorder.prepare({
  id: 'manual-2',
  source: 'manual',
  config: { ...config, seed: 20 },
  identity,
  execution,
  createdAt: 200,
});
recorder.setRunning(true, 201);
recorder.observeSnapshot({
  runId: 'manual-2',
  epoch: 1,
  running: true,
  config: { ...config, seed: 20 },
  cumulative: epochOne,
  workerMode: 'fixed',
  workerCount: 2,
  computePath: 'wasm',
  gpuAdapter: null,
  populationFingerprint: '33333333',
  core: 'wasm ×2',
  observedAt: 202,
});
const experiment: ExperimentRecord = {
  schemaVersion: RECORD_SCHEMA_VERSION,
  id: 'batch-1',
  name: 'explicit queue',
  status: 'paused',
  createdAt: 190,
  updatedAt: 202,
  definition: {
    items: [
      {
        config: { ...config, seed: 20 },
        computePath: 'wasm',
        epochLimit: 20000,
        orderCrossing: 2,
        measurementInterval: 128,
      },
    ],
  },
  runIds: ['manual-2'],
};
await repository.putExperiment(experiment);
await recorder.flush();
assert((await repository.markOpenRunsInterrupted(300)) === 1, 'open-run recovery count is wrong');
stored = await repository.getRun('manual-2');
assert(stored?.status === 'interrupted', 'reload recovery did not interrupt an open record');
assert(stored.endReason === 'interrupted', 'reload recovery did not retain its reason');
assert(
  (await repository.getExperiment('batch-1'))?.status === 'interrupted',
  'reload recovery did not interrupt a paused explicit batch',
);

// Schema-1 parents and immutable child rows remain readable. Missing engine
// identifiers mean CuBFF and are upgraded only in the returned in-memory copy.
const legacyRun = structuredClone(stored) as unknown as Record<string, unknown>;
legacyRun.schemaVersion = LEGACY_RECORD_SCHEMA_VERSION;
delete (legacyRun.initialConfig as Record<string, unknown>).engine;
const migratedRun = normalizeRunRecord(legacyRun);
assert(
  migratedRun.schemaVersion === RECORD_SCHEMA_VERSION,
  'legacy run was not normalized to the current schema in memory',
);
assert(migratedRun.initialConfig.engine === 'cubff', 'legacy run did not default to CuBFF');
assert(migratedRun.execution.computePath === 'wasm', 'legacy run did not default to Wasm');
assert(
  !('engine' in (legacyRun.initialConfig as Record<string, unknown>)),
  'legacy run was mutated while being read',
);

// Schema 2 already has an explicit engine but predates compute paths. Ignore
// any unexpected future-looking fields in the old row instead of allowing
// them to reinterpret an existing CPU trajectory.
const schemaTwoRun = structuredClone(stored) as unknown as Record<string, unknown>;
schemaTwoRun.schemaVersion = PREVIOUS_RECORD_SCHEMA_VERSION;
const schemaTwoExecution = schemaTwoRun.execution as Record<string, unknown>;
schemaTwoExecution.computePath = 'webgpu';
schemaTwoExecution.gpuAdapter = populatedGpuAdapter;
const migratedSchemaTwoRun = normalizeRunRecord(schemaTwoRun);
assert(
  migratedSchemaTwoRun.execution.computePath === 'wasm',
  'schema-2 run did not default to Wasm',
);
assert(
  migratedSchemaTwoRun.execution.gpuAdapter === null,
  'schema-2 run retained adapter metadata it could not have recorded',
);
assert(
  (schemaTwoRun.execution as Record<string, unknown>).computePath === 'webgpu',
  'schema-2 run was mutated during normalization',
);

const gpuRunInput = structuredClone(stored);
gpuRunInput.schemaVersion = RECORD_SCHEMA_VERSION;
gpuRunInput.initialConfig = { ...gpuRunInput.initialConfig, engine: 'cubff' };
gpuRunInput.execution = {
  ...gpuRunInput.execution,
  computePath: 'webgpu',
  gpuAdapter: populatedGpuAdapter,
};
const normalizedGpuRun = normalizeRunRecord(gpuRunInput);
assert(normalizedGpuRun.execution.computePath === 'webgpu', 'schema-3 WebGPU path was lost');
assert(
  normalizedGpuRun.execution.gpuAdapter?.description === populatedGpuAdapter.description,
  'schema-3 adapter identity was lost',
);
assert(
  normalizedGpuRun.execution.gpuAdapter !== gpuRunInput.execution.gpuAdapter,
  'schema-3 adapter identity was not cloned',
);

const privacyReducedGpuRun = structuredClone(gpuRunInput);
privacyReducedGpuRun.execution.gpuAdapter = {
  vendor: '',
  architecture: '',
  device: '',
  description: '',
  isFallbackAdapter: false,
};
assert(
  normalizeRunRecord(privacyReducedGpuRun).execution.gpuAdapter?.description === '',
  'privacy-reduced adapter identity was rejected',
);

const invalidAdapterRun = structuredClone(gpuRunInput) as unknown as Record<string, unknown>;
(invalidAdapterRun.execution as Record<string, unknown>).gpuAdapter = {
  ...populatedGpuAdapter,
  vendor: 17,
};
assert(
  (() => {
    try {
      normalizeRunRecord(invalidAdapterRun);
      return false;
    } catch {
      return true;
    }
  })(),
  'invalid adapter identity was accepted',
);

const incompatibleGpuRun = structuredClone(gpuRunInput);
incompatibleGpuRun.initialConfig = {
  ...incompatibleGpuRun.initialConfig,
  engine: 'brainfuck-life',
};
assert(
  (() => {
    try {
      normalizeRunRecord(incompatibleGpuRun);
      return false;
    } catch {
      return true;
    }
  })(),
  'Brainfuck-Life record accepted a WebGPU compute path',
);

const missingComputePathRun = structuredClone(stored) as unknown as Record<string, unknown>;
delete (missingComputePathRun.execution as Record<string, unknown>).computePath;
assert(
  (() => {
    try {
      normalizeRunRecord(missingComputePathRun);
      return false;
    } catch {
      return true;
    }
  })(),
  'schema-3 record without a compute path was accepted',
);

const [storedMeasurement] = await repository.listMeasurements('manual-1');
const legacyMeasurement = {
  ...storedMeasurement,
  schemaVersion: LEGACY_RECORD_SCHEMA_VERSION,
};
assert(
  normalizeRunMeasurement(legacyMeasurement).schemaVersion === RECORD_SCHEMA_VERSION,
  'legacy measurement was rejected',
);
assert(
  normalizeRunMeasurement({
    ...storedMeasurement,
    schemaVersion: PREVIOUS_RECORD_SCHEMA_VERSION,
  }).schemaVersion === RECORD_SCHEMA_VERSION,
  'schema-2 measurement was rejected',
);
const [storedEvent] = await repository.listEvents('manual-1');
const legacyEvent = { ...storedEvent, schemaVersion: LEGACY_RECORD_SCHEMA_VERSION };
assert(
  normalizeRunEvent(legacyEvent).schemaVersion === RECORD_SCHEMA_VERSION,
  'legacy event was rejected',
);
assert(
  normalizeRunEvent({ ...storedEvent, schemaVersion: PREVIOUS_RECORD_SCHEMA_VERSION })
    .schemaVersion === RECORD_SCHEMA_VERSION,
  'schema-2 event was rejected',
);

const legacyExperiment = structuredClone(experiment) as unknown as Record<string, unknown>;
legacyExperiment.schemaVersion = LEGACY_RECORD_SCHEMA_VERSION;
const legacyItems = (legacyExperiment.definition as { items: Array<{ config: Record<string, unknown> }> })
  .items;
delete legacyItems[0].config.engine;
const migratedExperiment = normalizeExperimentRecord(legacyExperiment);
assert(
  migratedExperiment.definition.items[0].config.engine === 'cubff',
  'legacy experiment item did not default to CuBFF',
);
assert(
  migratedExperiment.definition.items[0].computePath === 'wasm',
  'legacy experiment item did not default to Wasm',
);
const schemaTwoExperiment = structuredClone(experiment) as unknown as Record<string, unknown>;
schemaTwoExperiment.schemaVersion = PREVIOUS_RECORD_SCHEMA_VERSION;
const schemaTwoItems = (
  schemaTwoExperiment.definition as { items: Array<Record<string, unknown>> }
).items;
schemaTwoItems[0].computePath = 'webgpu';
const migratedSchemaTwoExperiment = normalizeExperimentRecord(schemaTwoExperiment);
assert(
  migratedSchemaTwoExperiment.definition.items[0].computePath === 'wasm',
  'schema-2 experiment item did not default to Wasm',
);
assert(
  schemaTwoItems[0].computePath === 'webgpu',
  'schema-2 experiment was mutated during normalization',
);

const currentGpuExperiment = structuredClone(experiment);
currentGpuExperiment.definition.items[0] = {
  ...currentGpuExperiment.definition.items[0],
  config: { ...currentGpuExperiment.definition.items[0].config, engine: 'cubff' },
  computePath: 'webgpu',
};
assert(
  normalizeExperimentRecord(currentGpuExperiment).definition.items[0].computePath === 'webgpu',
  'schema-3 experiment lost its WebGPU compute path',
);
const incompatibleGpuExperiment = structuredClone(currentGpuExperiment);
incompatibleGpuExperiment.definition.items[0].config.engine = 'brainfuck-life';
assert(
  (() => {
    try {
      normalizeExperimentRecord(incompatibleGpuExperiment);
      return false;
    } catch {
      return true;
    }
  })(),
  'Brainfuck-Life batch item accepted a WebGPU compute path',
);
const generatedLegacyExperiment = normalizeExperimentRecord({
  ...legacyExperiment,
  definition: { configs: [{ nTapes: [1024] }], seeds: [19, 20] },
});
assert(
  !Array.isArray((generatedLegacyExperiment.definition as { items?: unknown }).items),
  'legacy generated experiment was discarded or rewritten as an executable queue',
);
assert(
  normalizeExperimentRecord(generatedLegacyExperiment).schemaVersion === RECORD_SCHEMA_VERSION,
  'modified legacy generated experiment was unreadable after current-schema rewrite',
);

assert(
  modelIdentity('test', 'cubff').sourceRevision === CUBFF_SOURCE_REVISION,
  'CuBFF record identity has the wrong source revision',
);
assert(
  modelIdentity('test', 'brainfuck-life').sourceRevision === BRAINFUCK_LIFE_SOURCE_REVISION,
  'Brainfuck-Life record identity has the wrong source revision',
);

const gpuRepository = new MemoryRunRepository();
const gpuRecorder = new RunRecorder(Promise.resolve(gpuRepository), (error) => {
  throw error;
});
gpuRecorder.prepare({
  id: 'gpu-1',
  source: 'manual',
  config,
  identity,
  execution: { ...execution, computePath: 'webgpu', gpuAdapter: populatedGpuAdapter },
  createdAt: 400,
});
gpuRecorder.setRunning(true, 401);
gpuRecorder.observeSnapshot({
  runId: 'gpu-1',
  epoch: 1,
  running: true,
  config,
  cumulative: epochOne,
  workerMode: 'fixed',
  workerCount: 0,
  computePath: 'webgpu',
  gpuAdapter: populatedGpuAdapter,
  populationFingerprint: 'abcdef01',
  core: 'CuBFF WebGPU',
  observedAt: 402,
});
gpuRecorder.finish('restart', 403);
await gpuRecorder.flush();
const storedGpuRun = await gpuRepository.getRun('gpu-1');
assert(storedGpuRun?.execution.computePath === 'webgpu', 'recorder lost the WebGPU path');
assert(
  storedGpuRun.execution.gpuAdapter?.vendor === populatedGpuAdapter.vendor,
  'recorder lost the WebGPU adapter identity',
);

gpuRecorder.prepare({
  id: 'gpu-failed-before-epoch',
  source: 'manual',
  config: { ...config, seed: 21 },
  identity,
  execution: { ...execution, computePath: 'webgpu', gpuAdapter: populatedGpuAdapter },
  createdAt: 410,
});
gpuRecorder.setRunning(true, 411);
gpuRecorder.finish('failure', 412, 'injected device loss');
await gpuRecorder.flush();
const failedGpuRun = await gpuRepository.getRun('gpu-failed-before-epoch');
assert(failedGpuRun?.status === 'failed', 'epoch-zero execution failure was not retained');
assert(failedGpuRun.finalEpoch === 0, 'epoch-zero execution failure gained a completed epoch');
assert(
  failedGpuRun.failure === 'injected device loss',
  'epoch-zero execution failure lost its diagnostic',
);

gpuRecorder.prepare({
  id: 'gpu-unused-failure',
  source: 'manual',
  config: { ...config, seed: 22 },
  identity,
  execution: { ...execution, computePath: 'webgpu', gpuAdapter: populatedGpuAdapter },
  createdAt: 420,
});
gpuRecorder.finish('failure', 421, 'failed before execution was requested');
await gpuRecorder.flush();
assert(
  (await gpuRepository.getRun('gpu-unused-failure')) === null,
  'unused epoch-zero population was stored as an executed failure',
);

console.log(
  'records regression: lifecycle, schema 1/2/3 normalization, compute paths, adapter identity, explicit queues, epoch-zero execution failure, atomic children, late measurements, and recovery passed',
);

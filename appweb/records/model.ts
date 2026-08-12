import { isReactorEngine, type SoupConfig } from '../../engine/src/soup.ts';
import {
  COMPUTE_PATHS,
  type ComputePath,
  type GpuAdapterIdentity,
} from '../../engine/src/protocol.ts';
import {
  emptyCumulative,
  type RunCumulative,
} from '../../engine/src/statistics.ts';

export { emptyCumulative };
export type { RunCumulative };

export const RECORD_SCHEMA_VERSION = 3 as const;
export const LEGACY_RECORD_SCHEMA_VERSION = 1 as const;
export const PREVIOUS_RECORD_SCHEMA_VERSION = 2 as const;

export type RunSource = 'manual' | 'batch';
export type RunStatus =
  | 'prepared'
  | 'running'
  | 'paused'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type RunEndReason =
  | 'restart'
  | 'seed-change'
  | 'shape-change'
  | 'engine-change'
  | 'compute-path-change'
  | 'batch-start'
  | 'batch-limit'
  | 'batch-order-crossing'
  /** Retained for records written by the first batch-runner draft. */
  | 'batch-threshold'
  | 'batch-cancelled'
  | 'interrupted'
  | 'failure';

export interface ModelIdentity {
  appVersion: string;
  core: string;
  sourceRevision: string;
  compressor: string;
}

export interface RunExecution {
  computePath: ComputePath;
  gpuAdapter: GpuAdapterIdentity | null;
  workerMode: 'auto' | 'fixed';
  workerCount: number;
  epochsPerSecondLimit: number;
}

export interface ThresholdCrossing {
  threshold: number;
  epoch: number;
  steps: number;
  computeMs: number;
}

export interface RunTermination {
  epochLimit: number;
  orderCrossing: OrderCrossing;
}

export interface RunRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  id: string;
  experimentId: string | null;
  source: RunSource;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  endReason: RunEndReason | null;
  initialConfig: SoupConfig;
  identity: ModelIdentity;
  execution: RunExecution;
  /** Null for an open-ended manual run; explicit for every batch run. */
  termination: RunTermination | null;
  finalEpoch: number;
  cumulative: RunCumulative;
  measurementCount: number;
  eventCount: number;
  maximumHighOrder: number | null;
  firstThresholdCrossing: ThresholdCrossing | null;
  finalPopulationFingerprint: string | null;
  failure: string | null;
}

export interface RecordedMotif {
  bytesHex: string;
  count: number;
  carriers: number;
  copiedBytes: number;
}

export interface RecordedPopulationMetrics {
  distinctBytes: number;
  distinctTapes: number;
  largestIdenticalGroup: number;
  motifWindowCount: number;
  motifs: RecordedMotif[];
}

export interface RunMeasurement {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  epoch: number;
  configRevision: number;
  capturedAt: number;
  highOrder: number;
  byteFrequencyOrder: number;
  zeroOrderEntropy: number;
  compressedBitsPerByte: number;
  compressedBytes: number;
  rawBytes: number;
  population: RecordedPopulationMetrics;
  epochInteractions: number;
  epochSteps: number;
  epochHalts: number[];
  cumulative: RunCumulative;
  populationFingerprint: string;
}

export type RunEventKind = 'model-parameter' | 'execution';

export interface RunEvent {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  kind: RunEventKind;
  requestedAt: number;
  appliedAt: number;
  appliedEpoch: number;
  configRevision: number | null;
  changes: Record<string, number | string | boolean>;
}

export type OrderCrossing = 1 | 2 | 3;

/** One explicitly configured trajectory in an ordered experiment queue. */
export interface BatchRunDefinition {
  config: SoupConfig;
  computePath: ComputePath;
  epochLimit: number;
  orderCrossing: OrderCrossing;
  measurementInterval: number;
}

export interface BatchDefinition {
  items: BatchRunDefinition[];
}

export interface ExperimentRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  id: string;
  name: string;
  status: 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  definition: BatchDefinition;
  runIds: string[];
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function supportedSchema(value: unknown): value is 1 | 2 | 3 {
  return (
    value === LEGACY_RECORD_SCHEMA_VERSION ||
    value === PREVIOUS_RECORD_SCHEMA_VERSION ||
    value === RECORD_SCHEMA_VERSION
  );
}

export function isComputePath(value: unknown): value is ComputePath {
  return typeof value === 'string' && COMPUTE_PATHS.includes(value as ComputePath);
}

function normalizeGpuAdapter(value: unknown): GpuAdapterIdentity | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('record has invalid GPU adapter');
  const input = value as Record<string, unknown>;
  for (const field of ['vendor', 'architecture', 'device', 'description']) {
    if (typeof input[field] !== 'string') throw new Error(`record has invalid GPU ${field}`);
  }
  if (typeof input.isFallbackAdapter !== 'boolean') {
    throw new Error('record has invalid GPU fallback flag');
  }
  return {
    vendor: input.vendor as string,
    architecture: input.architecture as string,
    device: input.device as string,
    description: input.description as string,
    isFallbackAdapter: input.isFallbackAdapter,
  };
}

function normalizeExecution(value: unknown, sourceSchema: 1 | 2 | 3): RunExecution {
  if (!value || typeof value !== 'object') throw new Error('record has no execution identity');
  const input = value as Record<string, unknown>;
  const computePath = sourceSchema < 3 ? 'wasm' : input.computePath;
  if (!isComputePath(computePath)) throw new Error('record has invalid compute path');
  return {
    ...input,
    computePath,
    gpuAdapter: sourceSchema < 3 ? null : normalizeGpuAdapter(input.gpuAdapter),
  } as RunExecution;
}

/** Schema-1 configurations predate selectable engines and always mean CuBFF. */
export function normalizeSoupConfig(value: unknown): SoupConfig {
  if (!value || typeof value !== 'object') throw new Error('record has no soup configuration');
  const input = structuredClone(value) as Partial<SoupConfig>;
  const engine = input.engine ?? 'cubff';
  if (!isReactorEngine(engine)) throw new Error(`record has unknown engine ${String(engine)}`);
  return { ...input, engine } as SoupConfig;
}

export function normalizeRunRecord(value: unknown): RunRecord {
  if (!value || typeof value !== 'object') throw new Error('invalid run record');
  const input = structuredClone(value) as Record<string, unknown>;
  if (!supportedSchema(input.schemaVersion)) {
    throw new Error(`unsupported run-record schema ${String(input.schemaVersion)}`);
  }
  const record = {
    ...input,
    schemaVersion: RECORD_SCHEMA_VERSION,
    initialConfig: normalizeSoupConfig(input.initialConfig),
    execution: normalizeExecution(input.execution, input.schemaVersion),
  } as unknown as RunRecord;
  validateRunRecord(record);
  return record;
}

export function normalizeRunMeasurement(value: unknown): RunMeasurement {
  if (!value || typeof value !== 'object') throw new Error('invalid run measurement');
  const input = structuredClone(value) as Record<string, unknown>;
  if (!supportedSchema(input.schemaVersion)) {
    throw new Error(`unsupported measurement schema ${String(input.schemaVersion)}`);
  }
  const measurement = {
    ...input,
    schemaVersion: RECORD_SCHEMA_VERSION,
  } as unknown as RunMeasurement;
  validateRunMeasurement(measurement);
  return measurement;
}

export function normalizeRunEvent(value: unknown): RunEvent {
  if (!value || typeof value !== 'object') throw new Error('invalid run event');
  const input = structuredClone(value) as Record<string, unknown>;
  if (!supportedSchema(input.schemaVersion)) {
    throw new Error(`unsupported run-event schema ${String(input.schemaVersion)}`);
  }
  const event = { ...input, schemaVersion: RECORD_SCHEMA_VERSION } as unknown as RunEvent;
  validateRunEvent(event);
  return event;
}

export function normalizeExperimentRecord(value: unknown): ExperimentRecord {
  if (!value || typeof value !== 'object') throw new Error('invalid experiment record');
  const input = structuredClone(value) as Record<string, unknown>;
  const sourceSchema = input.schemaVersion;
  if (!supportedSchema(sourceSchema)) {
    throw new Error(`unsupported experiment schema ${String(input.schemaVersion)}`);
  }
  const definition = input.definition as { items?: unknown } | undefined;
  if (!definition || !Array.isArray(definition.items)) {
    // The first batch runner stored generated ranges instead of explicit queue
    // items. Retain those schema-1 summaries for display and export; they are
    // never accepted by putExperiment() as a new definition or executed again.
    const generated = definition as { configs?: unknown; seeds?: unknown } | undefined;
    if (
      !generated ||
      (!('configs' in generated) && !('seeds' in generated)) ||
      typeof input.id !== 'string' ||
      !input.id ||
      !Array.isArray(input.runIds)
    ) {
      throw new Error('experiment has no explicit run queue');
    }
    return { ...input, schemaVersion: RECORD_SCHEMA_VERSION } as unknown as ExperimentRecord;
  }
  const experiment = {
    ...input,
    schemaVersion: RECORD_SCHEMA_VERSION,
    definition: {
      ...definition,
      items: definition.items.map((entry) => {
        if (!entry || typeof entry !== 'object') throw new Error('experiment has invalid run');
        const item = entry as Record<string, unknown>;
        const computePath = sourceSchema < 3 ? 'wasm' : item.computePath;
        if (!isComputePath(computePath)) throw new Error('experiment run has invalid compute path');
        return { ...item, config: normalizeSoupConfig(item.config), computePath };
      }),
    },
  } as unknown as ExperimentRecord;
  validateExperimentRecord(experiment);
  return experiment;
}

export function validateRunRecord(record: RunRecord): void {
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported run-record schema ${record.schemaVersion}`);
  }
  if (!record.id) throw new Error('run record has no id');
  normalizeSoupConfig(record.initialConfig);
  if (!isComputePath(record.execution.computePath)) {
    throw new Error('run record has an invalid compute path');
  }
  if (record.execution.computePath === 'webgpu' && record.initialConfig.engine !== 'cubff') {
    throw new Error('Brainfuck-Life run cannot use WebGPU');
  }
  const adapter = normalizeGpuAdapter(record.execution.gpuAdapter);
  if (record.execution.computePath === 'wasm' && adapter !== null) {
    throw new Error('Wasm run cannot carry a GPU adapter identity');
  }
  if (record.execution.computePath === 'webgpu' && adapter === null) {
    throw new Error('WebGPU run has no adapter identity');
  }
  if (!isFiniteNonNegative(record.createdAt) || !isFiniteNonNegative(record.updatedAt)) {
    throw new Error('run record has an invalid timestamp');
  }
  if (!Number.isInteger(record.finalEpoch) || record.finalEpoch < 0) {
    throw new Error('run record has an invalid final epoch');
  }
  if (record.measurementCount < 0 || record.eventCount < 0) {
    throw new Error('run record has a negative child count');
  }
  if (record.source === 'batch') {
    if (!record.termination) throw new Error('batch run has no termination conditions');
    if (!Number.isInteger(record.termination.epochLimit) || record.termination.epochLimit < 1) {
      throw new Error('batch run has an invalid epoch limit');
    }
    if (
      record.termination.orderCrossing !== 1 &&
      record.termination.orderCrossing !== 2 &&
      record.termination.orderCrossing !== 3
    ) {
      throw new Error('batch run has an invalid order crossing');
    }
  }
}

export function validateRunMeasurement(measurement: RunMeasurement): void {
  if (measurement.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported measurement schema ${measurement.schemaVersion}`);
  }
  if (!measurement.runId) throw new Error('measurement has no run id');
  if (!Number.isInteger(measurement.sequence) || measurement.sequence < 0) {
    throw new Error('measurement has an invalid sequence');
  }
  if (!Number.isInteger(measurement.epoch) || measurement.epoch < 0) {
    throw new Error('measurement has an invalid epoch');
  }
  for (const value of [
    measurement.highOrder,
    measurement.byteFrequencyOrder,
    measurement.zeroOrderEntropy,
    measurement.compressedBitsPerByte,
  ]) {
    if (!Number.isFinite(value)) throw new Error('measurement contains a non-finite order value');
  }
}

export function validateRunEvent(event: RunEvent): void {
  if (event.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported run-event schema ${event.schemaVersion}`);
  }
  if (!event.runId) throw new Error('run event has no run id');
  if (!Number.isInteger(event.sequence) || event.sequence < 0) {
    throw new Error('run event has an invalid sequence');
  }
}

export function validateExperimentRecord(experiment: ExperimentRecord): void {
  if (experiment.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new Error(`unsupported experiment schema ${experiment.schemaVersion}`);
  }
  if (!experiment.id) throw new Error('experiment has no id');
  if (!experiment.definition.items.length) throw new Error('experiment queue is empty');
  if (experiment.runIds.length !== experiment.definition.items.length) {
    throw new Error('experiment run identifiers do not match its queue');
  }
  for (const item of experiment.definition.items) {
    normalizeSoupConfig(item.config);
    if (!isComputePath(item.computePath)) {
      throw new Error('experiment has an invalid compute path');
    }
    if (item.computePath === 'webgpu' && item.config.engine !== 'cubff') {
      throw new Error('Brainfuck-Life experiment cannot use WebGPU');
    }
    if (!Number.isInteger(item.epochLimit) || item.epochLimit < 1) {
      throw new Error('experiment has an invalid epoch limit');
    }
    if (!Number.isInteger(item.measurementInterval) || item.measurementInterval < 1) {
      throw new Error('experiment has an invalid measurement interval');
    }
    if (item.orderCrossing !== 1 && item.orderCrossing !== 2 && item.orderCrossing !== 3) {
      throw new Error('experiment has an invalid order crossing');
    }
  }
}

export function cloneConfig(config: SoupConfig): SoupConfig {
  return { ...config };
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

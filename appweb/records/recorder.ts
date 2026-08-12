import type { SoupConfig } from '../../engine/src/soup.ts';
import {
  RECORD_SCHEMA_VERSION,
  cloneConfig,
  emptyCumulative,
  type ModelIdentity,
  type RunCumulative,
  type RunEndReason,
  type RunEvent,
  type RunExecution,
  type RunMeasurement,
  type RunRecord,
  type RunSource,
  type RunTermination,
} from './model.ts';
import type { RunRepository } from './repository.ts';

export interface PreparedRun {
  id: string;
  experimentId?: string | null;
  source: RunSource;
  config: SoupConfig;
  identity: ModelIdentity;
  execution: RunExecution;
  termination?: RunTermination | null;
  highOrderThreshold?: number | null;
  createdAt?: number;
}

export interface RecordedSnapshot {
  runId: string;
  epoch: number;
  running: boolean;
  config: SoupConfig;
  cumulative: RunCumulative;
  workerMode: RunExecution['workerMode'];
  workerCount: number;
  computePath: RunExecution['computePath'];
  gpuAdapter: RunExecution['gpuAdapter'];
  populationFingerprint: string;
  core: string;
  observedAt?: number;
}

export type MeasurementInput = Omit<
  RunMeasurement,
  'schemaVersion' | 'runId' | 'sequence' | 'capturedAt'
> & { capturedAt?: number };

export interface RecordedEventInput {
  kind: RunEvent['kind'];
  requestedAt: number;
  appliedAt?: number;
  appliedEpoch: number;
  configRevision?: number | null;
  changes: RunEvent['changes'];
}

/**
 * Owns one active trajectory and serializes its writes.
 *
 * Epoch zero is a prepared population, not a recorded result. A record becomes
 * durable only once the trajectory reaches epoch one; this keeps unused seed
 * rolls and shape selections out of the experiment history.
 */
export class RunRecorder {
  private current: RunRecord | null = null;
  private persisted = false;
  private running = false;
  private eventSequence = 0;
  private measurementSequence = 0;
  private lastPersistAt = 0;
  private threshold: number | null = null;
  private writes: Promise<void> = Promise.resolve();
  private writeFailure: unknown = null;

  private readonly repository: Promise<RunRepository>;
  private readonly onError: (error: unknown) => void;

  constructor(
    repository: Promise<RunRepository>,
    onError: (error: unknown) => void = (error) =>
      console.error('[records] run record write failed', error),
  ) {
    this.repository = repository;
    this.onError = onError;
  }

  get runId(): string | null {
    return this.current?.id ?? null;
  }

  get record(): RunRecord | null {
    return this.current ? structuredClone(this.current) : null;
  }

  prepare(input: PreparedRun): void {
    if (this.current) throw new Error('finish the current run before preparing another');
    const now = input.createdAt ?? Date.now();
    this.current = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: input.id,
      experimentId: input.experimentId ?? null,
      source: input.source,
      status: 'prepared',
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      endedAt: null,
      endReason: null,
      initialConfig: cloneConfig(input.config),
      identity: structuredClone(input.identity),
      execution: structuredClone(input.execution),
      termination: input.termination ? structuredClone(input.termination) : null,
      finalEpoch: 0,
      cumulative: emptyCumulative(),
      measurementCount: 0,
      eventCount: 0,
      maximumHighOrder: null,
      firstThresholdCrossing: null,
      finalPopulationFingerprint: null,
      failure: null,
    };
    this.persisted = false;
    this.running = false;
    this.eventSequence = 0;
    this.measurementSequence = 0;
    this.lastPersistAt = 0;
    this.threshold = input.termination?.orderCrossing ?? input.highOrderThreshold ?? null;
  }

  observeSnapshot(input: RecordedSnapshot): void {
    const record = this.match(input.runId);
    const now = input.observedAt ?? Date.now();
    this.running = input.running;
    record.initialConfig = record.startedAt === null ? cloneConfig(input.config) : record.initialConfig;
    record.execution.workerMode = input.workerMode;
    record.execution.workerCount = input.workerCount;
    record.execution.computePath = input.computePath;
    record.execution.gpuAdapter = input.gpuAdapter ? structuredClone(input.gpuAdapter) : null;
    record.identity.core = input.core;
    record.finalEpoch = Math.max(record.finalEpoch, input.epoch);
    record.cumulative = structuredClone(input.cumulative);
    record.finalPopulationFingerprint = input.populationFingerprint;
    record.updatedAt = now;

    if (input.epoch >= 1 && !this.persisted) {
      record.startedAt = now;
      record.status = input.running ? 'running' : 'paused';
      this.persisted = true;
      this.lastPersistAt = now;
      this.putRun(record);
      return;
    }

    if (!this.persisted) return;
    record.status = input.running ? 'running' : 'paused';
    // Persist enough state to classify a reload as interrupted without writing
    // at display-frame frequency.
    if (!input.running || now - this.lastPersistAt >= 1000) {
      this.lastPersistAt = now;
      this.putRun(record);
    }
  }

  setRunning(running: boolean, at = Date.now()): void {
    this.running = running;
    const record = this.current;
    if (!record || !this.persisted) return;
    record.status = running ? 'running' : 'paused';
    record.updatedAt = at;
    this.putRun(record);
  }

  observeMeasurement(input: MeasurementInput): void {
    const record = this.current;
    if (!record || input.epoch < 1) return;
    const capturedAt = input.capturedAt ?? Date.now();
    if (!this.persisted) {
      record.startedAt = capturedAt;
      record.status = this.running ? 'running' : 'paused';
      this.persisted = true;
    }
    const measurement: RunMeasurement = {
      ...structuredClone(input),
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: record.id,
      sequence: this.measurementSequence++,
      capturedAt,
    };
    record.measurementCount = this.measurementSequence;
    if (measurement.epoch >= record.finalEpoch) {
      record.finalEpoch = measurement.epoch;
      record.cumulative = structuredClone(measurement.cumulative);
      record.finalPopulationFingerprint = measurement.populationFingerprint;
    }
    record.maximumHighOrder = Math.max(record.maximumHighOrder ?? -Infinity, measurement.highOrder);
    if (
      this.threshold !== null &&
      record.firstThresholdCrossing === null &&
      measurement.highOrder >= this.threshold
    ) {
      record.firstThresholdCrossing = {
        threshold: this.threshold,
        epoch: measurement.epoch,
        steps: measurement.cumulative.steps,
        computeMs: measurement.cumulative.computeMs,
      };
    }
    record.updatedAt = capturedAt;
    this.saveMeasurement(record, measurement);
  }

  recordEvent(input: RecordedEventInput): void {
    const record = this.current;
    if (!record) return;
    const appliedAt = input.appliedAt ?? Date.now();
    if (!this.persisted && input.kind === 'model-parameter') {
      for (const [key, value] of Object.entries(input.changes)) {
        if (key in record.initialConfig && typeof value === 'number') {
          (record.initialConfig as unknown as Record<string, number>)[key] = value;
        }
      }
      return;
    }
    if (!this.persisted) {
      if (input.kind === 'execution') {
        const workerMode = input.changes.workerMode;
        const workerCount = input.changes.workerCount;
        const limit = input.changes.epochsPerSecondLimit;
        if (workerMode === 'auto' || workerMode === 'fixed') {
          record.execution.workerMode = workerMode;
        }
        if (typeof workerCount === 'number') record.execution.workerCount = workerCount;
        if (typeof limit === 'number') record.execution.epochsPerSecondLimit = limit;
      }
      return;
    }
    const event: RunEvent = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: record.id,
      sequence: this.eventSequence++,
      kind: input.kind,
      requestedAt: input.requestedAt,
      appliedAt,
      appliedEpoch: input.appliedEpoch,
      configRevision: input.configRevision ?? null,
      changes: structuredClone(input.changes),
    };
    record.eventCount = this.eventSequence;
    record.updatedAt = appliedAt;
    this.saveEvent(record, event);
  }

  finish(reason: RunEndReason, at = Date.now(), failure: string | null = null): void {
    const record = this.current;
    // A run that fails after execution was requested is itself an experimental
    // result even when no epoch completed. Retain that epoch-zero failure;
    // unused populations and initialization failures before Run remain absent.
    const retainPreparedFailure = record !== null && failure !== null && this.running;
    if (record && (this.persisted || retainPreparedFailure)) {
      record.status = failure
        ? 'failed'
        : reason === 'interrupted' || reason === 'batch-cancelled'
          ? 'interrupted'
          : 'completed';
      record.endReason = reason;
      record.endedAt = at;
      record.updatedAt = at;
      record.failure = failure;
      this.putRun(record);
    }
    this.current = null;
    this.persisted = false;
    this.running = false;
    this.threshold = null;
  }

  async flush(): Promise<void> {
    await this.writes;
    if (this.writeFailure !== null) throw this.writeFailure;
  }

  private match(runId: string): RunRecord {
    const record = this.current;
    if (!record || record.id !== runId) {
      throw new Error(`received data for inactive run ${runId}`);
    }
    return record;
  }

  private enqueue(operation: (repository: RunRepository) => Promise<void>): void {
    this.writes = this.writes
      .then(async () => operation(await this.repository))
      .catch((error) => {
        this.writeFailure = error;
        this.onError(error);
      });
  }

  private putRun(record: RunRecord): void {
    const copy = structuredClone(record);
    this.enqueue((repository) => repository.putRun(copy));
  }

  private saveMeasurement(record: RunRecord, measurement: RunMeasurement): void {
    const recordCopy = structuredClone(record);
    const measurementCopy = structuredClone(measurement);
    this.enqueue((repository) => repository.saveMeasurement(recordCopy, measurementCopy));
  }

  private saveEvent(record: RunRecord, event: RunEvent): void {
    const recordCopy = structuredClone(record);
    const eventCopy = structuredClone(event);
    this.enqueue((repository) => repository.saveEvent(recordCopy, eventCopy));
  }
}

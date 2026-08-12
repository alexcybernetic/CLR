import { describe, expect, it, vi } from 'vitest';

import type {
  ComputePath,
  ToWorker,
  WorkerSelection,
} from '../../engine/src/protocol.ts';
import { DEFAULT_CONFIG, type SoupConfig } from '../../engine/src/soup.ts';
import {
  BATCH_MEASUREMENT_INTERVAL,
  type BatchRequest,
} from '../records/batch.ts';
import type {
  BatchRunDefinition,
  ExperimentRecord,
  ModelIdentity,
  RunEndReason,
} from '../records/model.ts';
import type { PreparedRun } from '../records/recorder.ts';
import { MemoryRunRepository } from '../records/repository.ts';
import {
  BatchRunner,
  type BatchRunnerEnvironment,
  type BatchRunnerHost,
} from './batchRunner.ts';
import type {
  MeasurementMessage,
  SnapshotMessage,
} from './coordinatorClient.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message = 'condition was not reached'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function definition(
  epochLimit: number,
  orderCrossing: 1 | 2 | 3 = 3,
  overrides: Partial<SoupConfig> = {},
): BatchRunDefinition {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    computePath: 'wasm',
    epochLimit,
    orderCrossing,
    measurementInterval: BATCH_MEASUREMENT_INTERVAL,
  };
}

function request(items: BatchRunDefinition[]): BatchRequest {
  return { name: 'test batch', definition: { items } };
}

function snapshot(runId: string, config: SoupConfig): SnapshotMessage {
  return {
    t: 'snapshot',
    runId,
    epoch: 0,
    soup: new ArrayBuffer(0),
    config: { ...config },
    configRevision: 1,
    nTapes: config.nTapes,
    tapeLen: config.tapeLen,
    stats: { execs: 0, steps: 0, meanSteps: 0, halts: [], ms: 0 },
    metrics: {
      entropy: 0,
      distinctBytes: 0,
      uniqueTapes: 0,
      largestLineage: 0,
      motifs: [],
      motifTotal: 0,
      tapeFrequencies: [],
      populationFingerprint: '',
    },
    running: false,
    epochsPerSec: 0,
    stepsPerSec: 0,
    core: 'test',
    computePath: 'wasm',
    gpuAdapter: null,
    workerMode: 'auto',
    workerCount: 1,
    epochsPerSecondLimit: 0,
    cumulative: { epochs: 0, interactions: 0, steps: 0, computeMs: 0, halts: [] },
  };
}

function measurement(epoch: number, highOrder: number): MeasurementMessage {
  return {
    t: 'measurement',
    requestId: `measurement-${epoch}`,
    runId: 'active-run',
    epoch,
    configRevision: 1,
    highOrder,
    byteOrder: 0,
    h0: 8,
    bpb: 8,
    compressed: 1,
    raw: 1,
    population: {
      distinctBytes: 0,
      distinctTapes: 0,
      largestIdenticalGroup: 0,
      motifWindowCount: 0,
      motifs: [],
    },
    epochStats: { execs: 0, steps: 0, meanSteps: 0, halts: [], ms: 0 },
    cumulative: { epochs: epoch, interactions: 0, steps: 0, computeMs: 0, halts: [] },
    populationFingerprint: '',
  };
}

class TestRepository extends MemoryRunRepository {
  readonly writes: ExperimentRecord[] = [];
  readonly trace: string[];
  onPut: ((record: ExperimentRecord, index: number) => Promise<void> | void) | null = null;

  constructor(trace: string[]) {
    super();
    this.trace = trace;
  }

  override async putExperiment(experiment: ExperimentRecord): Promise<void> {
    const copy = structuredClone(experiment);
    const index = this.writes.length;
    this.writes.push(copy);
    this.trace.push(`repository:${copy.status}`);
    await this.onPut?.(copy, index);
    await super.putExperiment(copy);
    this.trace.push(`repository:done:${copy.status}`);
  }
}

class TestCoordinator {
  readonly trace: string[];
  readonly messages: ToWorker[] = [];
  readonly epochMessages: { runId: string; count: number }[] = [];
  readonly highOrders: number[] = [];
  holdReady = false;
  rejectReplacement: Error | null = null;
  activeRunId = '';
  epoch = 0;

  private readonly creation = new Map<string, Deferred<ComputePath>>();
  private readonly snapshots = new Map<string, Deferred<SnapshotMessage>>();
  private ready: Deferred<number> | null = null;

  constructor(trace: string[]) {
    this.trace = trace;
  }

  waitForRunCreation(runId: string): Promise<ComputePath> {
    this.trace.push(`wait:creation:${runId}`);
    const waiter = deferred<ComputePath>();
    this.creation.set(runId, waiter);
    return waiter.promise;
  }

  waitForSnapshot(runId: string): Promise<SnapshotMessage> {
    this.trace.push(`wait:snapshot:${runId}`);
    const waiter = deferred<SnapshotMessage>();
    this.snapshots.set(runId, waiter);
    return waiter.promise;
  }

  waitForReady(runId: string): Promise<number> {
    if (this.ready) throw new Error('ready waiter already registered');
    this.trace.push(`wait:ready:${runId}`);
    this.ready = deferred<number>();
    return this.ready.promise;
  }

  requestMeasurement(): Promise<MeasurementMessage> {
    this.trace.push(`measurement:${this.activeRunId}:${this.epoch}`);
    return Promise.resolve(measurement(this.epoch, this.highOrders.shift() ?? 0));
  }

  send(message: ToWorker): void {
    this.messages.push(structuredClone(message));
    this.trace.push(`send:${message.t}`);
    if (message.t === 'new-run') {
      const creation = this.creation.get(message.runId);
      const initial = this.snapshots.get(message.runId);
      if (!creation || !initial) throw new Error('new-run sent before both waiters');
      this.activeRunId = message.runId;
      this.epoch = 0;
      queueMicrotask(() => {
        if (this.rejectReplacement) {
          creation.reject(this.rejectReplacement);
          initial.reject(this.rejectReplacement);
          return;
        }
        creation.resolve(message.computePath);
        initial.resolve(snapshot(message.runId, message.cfg));
      });
    } else if (message.t === 'epoch') {
      if (!this.ready) throw new Error('epoch sent before ready waiter');
      this.epochMessages.push({ runId: this.activeRunId, count: message.n });
      if (!this.holdReady) this.resolveReady(this.epoch + message.n);
    }
  }

  resolveReady(epoch: number): void {
    const ready = this.ready;
    if (!ready) throw new Error('no ready waiter');
    this.ready = null;
    this.epoch = epoch;
    queueMicrotask(() => ready.resolve(epoch));
  }
}

class TestRecorder {
  readonly trace: string[];
  readonly prepared: PreparedRun[] = [];
  readonly finished: { reason: RunEndReason; failure: string | null }[] = [];
  readonly running: boolean[] = [];
  onFlush: ((index: number) => Promise<void> | void) | null = null;
  flushCount = 0;

  constructor(trace: string[]) {
    this.trace = trace;
  }

  prepare(input: PreparedRun): void {
    this.prepared.push(structuredClone(input));
    this.trace.push(`recorder:prepare:${input.id}`);
  }

  setRunning(running: boolean): void {
    this.running.push(running);
    this.trace.push(`recorder:running:${running}`);
  }

  finish(reason: RunEndReason, _at?: number, failure: string | null = null): void {
    this.finished.push({ reason, failure });
    this.trace.push(`recorder:finish:${reason}`);
  }

  async flush(): Promise<void> {
    this.trace.push('recorder:flush');
    const index = this.flushCount++;
    await this.onFlush?.(index);
  }
}

interface SavedState {
  readonly marker: string;
}

class TestHost implements BatchRunnerHost<SavedState> {
  readonly trace: string[];
  readonly fatal = vi.fn();
  readonly state: BatchRunnerEnvironment = {
    terminal: false,
    disposed: false,
    recoverableRunFailure: false,
    webGpuAvailable: true,
  };
  restoreError: Error | null = null;
  refreshError: Error | null = null;
  fatalBecomesTerminal = false;
  revision = 0;
  path: ComputePath = 'wasm';

  constructor(trace: string[]) {
    this.trace = trace;
  }

  assertCanStart(): void {
    this.trace.push('host:assert');
  }

  environment(): BatchRunnerEnvironment {
    return this.state;
  }

  captureManualState(): SavedState {
    this.trace.push('host:capture');
    return { marker: 'manual' };
  }

  workerSelection(): WorkerSelection {
    return { mode: 'auto', count: 4 };
  }

  stopManualRunIfRunning(): void {
    this.trace.push('host:stop-manual');
  }

  clearPendingManualEvents(): void {
    this.trace.push('host:clear-events');
  }

  activateBatchRun(runId: string, item: BatchRunDefinition) {
    const previous = this.path;
    this.path = item.computePath;
    this.trace.push(`host:activate:${runId}`);
    return {
      revision: ++this.revision,
      retainCurrentOnFailure: previous !== item.computePath,
      gpuAdapter: null,
    };
  }

  async restoreManualState(state: SavedState): Promise<void> {
    this.trace.push(`host:restore:${state.marker}`);
    if (this.restoreError) throw this.restoreError;
  }

  setBatchControlsLocked(locked: boolean): void {
    this.trace.push(`host:locked:${locked}`);
  }

  async refreshRecords(): Promise<void> {
    this.trace.push('host:refresh');
    if (this.refreshError) throw this.refreshError;
  }

  reportFatal(error: unknown): void {
    this.fatal(error);
    this.trace.push('host:fatal');
    if (this.fatalBecomesTerminal) {
      (this.state as { terminal: boolean }).terminal = true;
    }
  }
}

function fixture() {
  const trace: string[] = [];
  const repository = new TestRepository(trace);
  const coordinator = new TestCoordinator(trace);
  const recorder = new TestRecorder(trace);
  const host = new TestHost(trace);
  let id = 0;
  let now = 1000;
  const identity: ModelIdentity = {
    appVersion: 'test',
    core: 'test',
    sourceRevision: 'test',
    compressor: 'test',
  };
  const runner = new BatchRunner({
    repository: Promise.resolve(repository),
    coordinator,
    recorder,
    host,
    identityFor: () => identity,
    createId: () => `id-${++id}`,
    now: () => ++now,
  });
  return { coordinator, host, recorder, repository, runner, trace };
}

describe('BatchRunner', () => {
  it('resolves start at durable acceptance, clones input, and rejects a concurrent start', async () => {
    const { coordinator, host, repository, runner, trace } = fixture();
    const queuedWrite = deferred<void>();
    repository.onPut = (_record, index) => (index === 0 ? queuedWrite.promise : undefined);
    coordinator.rejectReplacement = new Error('stop after acceptance');
    const input = request([definition(128, 3, { seed: 7 })]);

    let accepted = false;
    const start = runner.start(input).then(() => {
      accepted = true;
    });
    let completed = false;
    const completion = runner.waitForCompletion().then(() => {
      completed = true;
    });
    await waitFor(() => repository.writes.length === 1);

    expect(accepted).toBe(false);
    expect(completed).toBe(false);
    expect(runner.busy).toBe(true);
    expect(runner.getSnapshot().phase).toBe('starting');
    expect(trace).toContain('host:locked:true');
    expect(trace).not.toContain('host:stop-manual');
    await expect(runner.start(input)).rejects.toThrow('already active');
    input.definition.items[0].config.seed = 999;
    expect(repository.writes[0].definition.items[0].config.seed).toBe(7);

    queuedWrite.resolve();
    await start;
    expect(accepted).toBe(true);
    await completion;
    expect(completed).toBe(true);
    expect(runner.getSnapshot().phase).toBe('failed');
    expect(host.fatal).not.toHaveBeenCalled();
  });

  it('runs sequential exact blocks and persists completion before restoration', async () => {
    const { coordinator, recorder, repository, runner, trace } = fixture();
    coordinator.highOrders.push(0, 0, 0, 2);
    const firstRunFlush = deferred<void>();
    const finalExperimentWrite = deferred<void>();
    recorder.onFlush = (index) => (index === 1 ? firstRunFlush.promise : undefined);
    repository.onPut = (record) =>
      record.status === 'completed' ? finalExperimentWrite.promise : undefined;

    await runner.start(request([
      definition(300, 3, { seed: 1 }),
      definition(500, 1, { seed: 2 }),
    ]));
    await waitFor(() => trace.includes('recorder:finish:batch-limit'));
    expect(trace).not.toContain('host:activate:id-2');
    firstRunFlush.resolve();
    await waitFor(() => trace.includes('repository:completed'));
    expect(trace).not.toContain('host:restore:manual');
    finalExperimentWrite.resolve();
    await runner.waitForCompletion();

    expect(coordinator.epochMessages).toEqual([
      { runId: 'id-1', count: 128 },
      { runId: 'id-1', count: 128 },
      { runId: 'id-1', count: 44 },
      { runId: 'id-2', count: 128 },
    ]);
    expect(runner.getSnapshot()).toMatchObject({
      phase: 'completed',
      completedRuns: 2,
      totalRuns: 2,
      currentItemIndex: 1,
      items: [
        { status: 'completed', epoch: 300, reason: 'epoch limit' },
        { status: 'completed', epoch: 128, reason: 'order crossing' },
      ],
    });
    expect(repository.writes.at(-1)?.status).toBe('completed');
    expect(trace.indexOf('wait:creation:id-1')).toBeLessThan(trace.indexOf('send:new-run'));
    expect(trace.indexOf('wait:snapshot:id-1')).toBeLessThan(trace.indexOf('send:new-run'));
    expect(trace.indexOf('recorder:finish:batch-limit')).toBeLessThan(
      trace.indexOf('host:activate:id-2'),
    );
    expect(trace.indexOf('repository:done:completed')).toBeLessThan(
      trace.indexOf('host:restore:manual'),
    );
    expect(trace.at(-1)).toBe('host:locked:false');
    expect(runner.busy).toBe(false);
  });

  it('creates the pause gate before persistence and resumes during that write', async () => {
    const { coordinator, recorder, repository, runner, trace } = fixture();
    const pausedWrite = deferred<void>();
    const resumedWrite = deferred<void>();
    let pausedWrites = 0;
    let blockFirstResumedWrite = true;
    repository.onPut = (record) => {
      if (record.status === 'paused') {
        pausedWrites++;
        return pausedWrites === 1 ? pausedWrite.promise : undefined;
      }
      if (record.status === 'running' && pausedWrites > 0 && blockFirstResumedWrite) {
        blockFirstResumedWrite = false;
        return resumedWrite.promise;
      }
      return undefined;
    };
    coordinator.holdReady = true;

    await runner.start(request([definition(192)]));
    await waitFor(() => coordinator.epochMessages.length === 1);
    runner.setRunning(false);
    expect(runner.getSnapshot().phase).toBe('pausing');
    expect(runner.effectiveRunning).toBe(true);
    expect(coordinator.messages.filter((message) => message.t === 'cancel-pending')).toHaveLength(1);

    coordinator.holdReady = false;
    coordinator.resolveReady(64);
    await waitFor(() => runner.getSnapshot().phase === 'paused');
    runner.setRunning(true);
    expect(runner.getSnapshot().phase).toBe('resuming');
    pausedWrite.resolve();
    await waitFor(
      () => trace.filter((entry) => entry === 'repository:running').length >= 2,
    );
    runner.setRunning(false);
    resumedWrite.resolve();
    await waitFor(() => pausedWrites === 2);
    await waitFor(() => runner.getSnapshot().phase === 'paused');
    expect(coordinator.epochMessages).toHaveLength(1);
    runner.setRunning(true);
    await runner.waitForCompletion();

    expect(recorder.running).toContain(false);
    expect(recorder.running.slice(recorder.running.indexOf(false) + 1)).toContain(true);
    const paused = trace.indexOf('repository:paused');
    const resumed = trace.indexOf('repository:done:running', paused + 1);
    const secondEpoch = trace.indexOf('send:epoch', trace.indexOf('send:epoch') + 1);
    expect(paused).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(paused);
    expect(secondEpoch).toBeGreaterThan(resumed);
  });

  it('stops a durable paused batch and restores the manual setup', async () => {
    const { coordinator, recorder, repository, runner, trace } = fixture();
    coordinator.holdReady = true;

    await runner.start(request([definition(192)]));
    await waitFor(() => coordinator.epochMessages.length === 1);
    runner.setRunning(false);
    coordinator.resolveReady(64);
    await waitFor(() => runner.getSnapshot().phase === 'paused');

    runner.stop();
    expect(runner.getSnapshot().phase).toBe('stopping');
    await runner.waitForCompletion();

    expect(coordinator.epochMessages).toHaveLength(1);
    expect(runner.getSnapshot()).toMatchObject({
      phase: 'stopped',
      currentEpoch: 64,
      items: [{ status: 'stopped', epoch: 64 }],
    });
    expect(recorder.finished.at(-1)).toEqual({
      reason: 'batch-cancelled',
      failure: null,
    });
    expect(repository.writes.at(-1)?.status).toBe('interrupted');
    expect(trace).toContain('host:restore:manual');
    expect(trace).toContain('host:locked:false');
    expect(runner.busy).toBe(false);
  });

  it('honors a pause requested while durable acceptance is still pending', async () => {
    const { coordinator, repository, runner, trace } = fixture();
    const queuedWrite = deferred<void>();
    repository.onPut = (_record, index) => (index === 0 ? queuedWrite.promise : undefined);

    const start = runner.start(request([definition(128)]));
    await waitFor(() => repository.writes.length === 1);
    runner.setRunning(false);
    queuedWrite.resolve();
    await start;
    await waitFor(() => runner.getSnapshot().phase === 'paused');

    expect(runner.getSnapshot()).toMatchObject({
      currentItemIndex: 0,
      currentEpoch: 0,
      items: [{ status: 'paused' }],
    });
    expect(trace).not.toContain('host:activate:id-1');
    expect(coordinator.epochMessages).toHaveLength(0);

    runner.setRunning(true);
    await runner.waitForCompletion();
    expect(runner.getSnapshot().phase).toBe('completed');
  });

  it('cancels a pause request before the boundary without persisting paused state', async () => {
    const { coordinator, recorder, repository, runner } = fixture();
    coordinator.holdReady = true;

    await runner.start(request([definition(192)]));
    await waitFor(() => coordinator.epochMessages.length === 1);
    runner.setRunning(false);
    runner.setRunning(true);
    expect(runner.getSnapshot().phase).toBe('running');
    coordinator.holdReady = false;
    coordinator.resolveReady(64);
    await runner.waitForCompletion();

    expect(repository.writes.some((record) => record.status === 'paused')).toBe(false);
    expect(recorder.running).not.toContain(false);
  });

  it('rejects pre-acceptance failures without mutating runtime ownership', async () => {
    const { host, repository, runner, trace } = fixture();
    repository.onPut = (_record, index) => {
      if (index === 0) throw new Error('IndexedDB unavailable');
    };

    await expect(runner.start(request([definition(128)]))).rejects.toThrow(
      'IndexedDB unavailable',
    );
    expect(runner.busy).toBe(false);
    expect(runner.getSnapshot()).toMatchObject({
      phase: 'failed',
      status: 'batch did not start: IndexedDB unavailable',
    });
    expect(trace).not.toContain('host:stop-manual');
    expect(trace).toContain('host:locked:true');
    expect(trace).toContain('host:locked:false');
    expect(trace).not.toContain('host:restore:manual');
    expect(host.fatal).not.toHaveBeenCalled();
  });

  it('bounds failure presentation for an oversized untrusted queue', async () => {
    const { repository, runner, trace } = fixture();
    const oversized = {
      name: 'oversized',
      definition: { items: Array.from({ length: 10_000 }, () => null) },
    };

    await expect(runner.start(oversized)).rejects.toThrow('exceeds 100 runs');
    expect(runner.getSnapshot().totalRuns).toBe(100);
    expect(runner.getSnapshot().items).toHaveLength(100);
    expect(repository.writes).toHaveLength(0);
    expect(trace).not.toContain('host:stop-manual');
    expect(trace).not.toContain('host:locked:true');
  });

  it('rejects unavailable WebGPU before persistence or control locking', async () => {
    const { host, repository, runner, trace } = fixture();
    (host.state as { webGpuAvailable: boolean }).webGpuAvailable = false;
    const gpuDefinition = definition(128, 3, { engine: 'cubff' });
    gpuDefinition.computePath = 'webgpu';

    await expect(runner.start(request([gpuDefinition]))).rejects.toThrow(
      'WebGPU run cannot start',
    );
    expect(repository.writes).toHaveLength(0);
    expect(trace).not.toContain('host:locked:true');
    expect(trace).not.toContain('host:stop-manual');
  });

  it('keeps post-acceptance failure in progress and restores the manual run', async () => {
    const { coordinator, host, recorder, repository, runner, trace } = fixture();
    coordinator.rejectReplacement = new Error('GPU initialization failed');

    await expect(runner.start(request([definition(128)]))).resolves.toBeUndefined();
    await runner.waitForCompletion();

    expect(runner.getSnapshot()).toMatchObject({
      phase: 'failed',
      status: 'failed: GPU initialization failed',
      items: [{ status: 'failed' }],
    });
    expect(repository.writes.at(-1)?.status).toBe('interrupted');
    expect(recorder.finished.at(-1)).toEqual({
      reason: 'failure',
      failure: 'GPU initialization failed',
    });
    expect(trace).toContain('host:restore:manual');
    expect(trace).toContain('host:locked:false');
    expect(host.fatal).not.toHaveBeenCalled();
  });

  it('does not relabel a durable completion when record refresh fails', async () => {
    const { host, repository, runner } = fixture();
    host.refreshError = new Error('records view failed');

    await runner.start(request([definition(128)]));
    await runner.waitForCompletion();

    expect(repository.writes.at(-1)?.status).toBe('completed');
    expect(runner.getSnapshot()).toMatchObject({ phase: 'completed', status: 'completed' });
  });

  it('restores and clears busy state after a final experiment write failure', async () => {
    const { repository, runner, trace } = fixture();
    repository.onPut = (record) => {
      if (record.status === 'completed') throw new Error('final write failed');
    };

    await runner.start(request([definition(128)]));
    await runner.waitForCompletion();

    expect(runner.getSnapshot()).toMatchObject({
      phase: 'failed',
      status: 'record write failed: final write failed',
    });
    expect(trace).toContain('host:restore:manual');
    expect(trace).toContain('host:locked:false');
    expect(runner.busy).toBe(false);
  });

  it('does not unlock controls when restoration becomes terminal', async () => {
    const { host, runner, trace } = fixture();
    host.restoreError = new Error('manual restoration failed');
    host.fatalBecomesTerminal = true;

    await runner.start(request([definition(128)]));
    await runner.waitForCompletion();

    expect(host.fatal).toHaveBeenCalledOnce();
    expect(trace).toContain('host:fatal');
    expect(trace).not.toContain('host:locked:false');
    expect(runner.busy).toBe(false);
  });

  it('interrupts a durable paused runner without restoring after disposal', async () => {
    const { coordinator, host, repository, runner, trace } = fixture();
    coordinator.holdReady = true;

    await runner.start(request([definition(192)]));
    await waitFor(() => coordinator.epochMessages.length === 1);
    runner.setRunning(false);
    coordinator.resolveReady(64);
    await waitFor(() => repository.writes.some((record) => record.status === 'paused'));
    await waitFor(() => runner.getSnapshot().phase === 'paused');

    (host.state as { disposed: boolean }).disposed = true;
    runner.interrupt(new Error('application disposed'));
    await runner.waitForCompletion();

    expect(runner.getSnapshot().phase).toBe('failed');
    expect(repository.writes.at(-1)?.status).toBe('interrupted');
    expect(trace).not.toContain('host:restore:manual');
    expect(trace).not.toContain('host:locked:false');
  });

  it('publishes stable, recursively frozen progress snapshots', async () => {
    const { coordinator, runner } = fixture();
    coordinator.rejectReplacement = new Error('done');
    const idle = runner.getSnapshot();
    expect(runner.getSnapshot()).toBe(idle);
    expect(Object.isFrozen(idle)).toBe(true);
    expect(Object.isFrozen(idle.items)).toBe(true);

    await runner.start(request([definition(128)]));
    const active = runner.getSnapshot();
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.items)).toBe(true);
    expect(Object.isFrozen(active.items[0])).toBe(true);
    const listener = vi.fn();
    const unsubscribe = runner.subscribe(listener);
    runner.setRunning(runner.requestedRunning);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    await runner.waitForCompletion();
  });
});

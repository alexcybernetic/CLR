import type {
  ComputePath,
  GpuAdapterIdentity,
  ToWorker,
  WorkerSelection,
} from '../../engine/src/protocol.ts';
import type { ReactorEngine } from '../../engine/src/soup.ts';
import {
  MAX_BATCH_RUNS,
  nextBatchEpochCount,
  normalizeBatchRequest,
  type BatchRequest,
} from '../records/batch.ts';
import {
  RECORD_SCHEMA_VERSION,
  type BatchRunDefinition,
  type ExperimentRecord,
  type ModelIdentity,
  type RunEndReason,
} from '../records/model.ts';
import type { PreparedRun } from '../records/recorder.ts';
import type { RunRepository } from '../records/repository.ts';
import type {
  MeasurementMessage,
  SnapshotMessage,
} from './coordinatorClient.ts';

export type BatchRunnerItemPhase =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed';

export type BatchRunnerPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed';

export interface BatchRunnerItemProgress {
  readonly status: BatchRunnerItemPhase;
  readonly epoch: number;
  readonly reason: 'epoch limit' | 'order crossing' | null;
}

export interface BatchRunnerProgress {
  readonly phase: BatchRunnerPhase;
  /** Requested switch state. `effectiveRunning` acknowledges the durable boundary. */
  readonly requestedRunning: boolean;
  readonly experimentId: string | null;
  readonly completedRuns: number;
  readonly totalRuns: number;
  /** Zero-based active queue item, or null before the first item is activated. */
  readonly currentItemIndex: number | null;
  readonly currentEpoch: number;
  readonly status: string;
  readonly items: readonly BatchRunnerItemProgress[];
}

export interface BatchRunnerEnvironment {
  readonly terminal: boolean;
  readonly disposed: boolean;
  readonly recoverableRunFailure: boolean;
  /** A usable WebGPU adapter is currently available for a new run. */
  readonly webGpuAvailable: boolean;
}

export interface BatchRunActivation {
  readonly revision: number;
  readonly retainCurrentOnFailure: boolean;
  readonly gpuAdapter: GpuAdapterIdentity | null;
}

export interface BatchCoordinatorPort {
  send(message: ToWorker): void;
  waitForRunCreation(runId: string): Promise<ComputePath>;
  waitForSnapshot(runId: string): Promise<SnapshotMessage>;
  waitForReady(runId: string): Promise<number>;
  requestMeasurement(): Promise<MeasurementMessage>;
}

export interface BatchRecorderPort {
  prepare(input: PreparedRun): void;
  setRunning(running: boolean): void;
  finish(reason: RunEndReason, at?: number, failure?: string | null): void;
  flush(): Promise<void>;
}

export interface BatchRunnerHost<SavedState> {
  /** Reject application-specific conflicts before the queue is made durable. */
  assertCanStart(): void;
  environment(): BatchRunnerEnvironment;
  captureManualState(): SavedState;
  workerSelection(): WorkerSelection;
  /** Privileged transition; it must not be blocked by the runner's busy guard. */
  stopManualRunIfRunning(): void;
  clearPendingManualEvents(): void;
  activateBatchRun(runId: string, definition: BatchRunDefinition): BatchRunActivation;
  /** Owns the application-specific, order-sensitive manual run replacement. */
  restoreManualState(state: SavedState): Promise<void>;
  setBatchControlsLocked(locked: boolean): void;
  refreshRecords(): Promise<void>;
  reportFatal(error: unknown): void;
}

export interface BatchRunnerOptions<SavedState> {
  repository: Promise<RunRepository>;
  coordinator: BatchCoordinatorPort;
  recorder: BatchRecorderPort;
  host: BatchRunnerHost<SavedState>;
  identityFor(engine: ReactorEngine): ModelIdentity;
  createId?: () => string;
  now?: () => number;
}

interface BatchQueueItem {
  readonly id: string;
  readonly definition: BatchRunDefinition;
}

interface AcceptedBatch<SavedState> {
  readonly repository: RunRepository;
  readonly savedState: SavedState;
  readonly selection: WorkerSelection;
  readonly queue: readonly BatchQueueItem[];
  readonly experiment: ExperimentRecord;
  readonly controlsLocked: boolean;
}

interface VoidDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const IDLE_PROGRESS: BatchRunnerProgress = Object.freeze({
  phase: 'idle',
  requestedRunning: false,
  experimentId: null,
  completedRuns: 0,
  totalRuns: 0,
  currentItemIndex: null,
  currentEpoch: 0,
  status: 'idle',
  items: Object.freeze([]),
});

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class BatchStopped extends Error {
  constructor() {
    super('batch stopped');
  }
}

function requestedItemCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const definition = (value as { definition?: unknown }).definition;
  if (!definition || typeof definition !== 'object') return 0;
  const items = (definition as { items?: unknown }).items;
  return Array.isArray(items) ? Math.min(items.length, MAX_BATCH_RUNS) : 0;
}

function freezeItem(item: BatchRunnerItemProgress): BatchRunnerItemProgress {
  return Object.freeze({ ...item });
}

function freezeProgress(progress: BatchRunnerProgress): BatchRunnerProgress {
  return Object.freeze({
    ...progress,
    items: Object.freeze(progress.items.map((item) => freezeItem(item))),
  });
}

function createVoidDeferred(): VoidDeferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

/**
 * Owns durable sequential batch execution without depending on DOM or React.
 *
 * The host retains browser-specific run activation and manual restoration.
 * Correlated worker messages are resolved only by the application's accepted
 * protocol handler; this runner only registers and awaits those correlations.
 */
export class BatchRunner<SavedState> {
  readonly #repository: Promise<RunRepository>;
  readonly #coordinator: BatchCoordinatorPort;
  readonly #recorder: BatchRecorderPort;
  readonly #host: BatchRunnerHost<SavedState>;
  readonly #identityFor: (engine: ReactorEngine) => ModelIdentity;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();

  #progress = IDLE_PROGRESS;
  #starting = false;
  #accepted = false;
  #executionActive = false;
  #effectiveRunning = false;
  #requestedRunning = false;
  #stopRequested = false;
  #interruptError: Error | null = null;
  #resumeWaiter: VoidDeferred | null = null;
  #activeStatus = 'starting';
  #completion: Promise<void> = Promise.resolve();

  constructor(options: BatchRunnerOptions<SavedState>) {
    this.#repository = options.repository;
    this.#coordinator = options.coordinator;
    this.#recorder = options.recorder;
    this.#host = options.host;
    this.#identityFor = options.identityFor;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
  }

  get busy(): boolean {
    return this.#starting || this.#accepted;
  }

  /** True only while batch execution, rather than a manual run, owns recording. */
  get executionActive(): boolean {
    return this.#executionActive;
  }

  /** True through cooperative pausing until the exact paused boundary is durable. */
  get effectiveRunning(): boolean {
    return this.#effectiveRunning;
  }

  get requestedRunning(): boolean {
    return this.#requestedRunning;
  }

  readonly getSnapshot = (): BatchRunnerProgress => this.#progress;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  };

  /** Resolve after every background write, restoration, and control transition settles. */
  waitForCompletion(): Promise<void> {
    return this.#completion;
  }

  /**
   * Validate and durably accept a queue, then execute it in the background.
   * Post-acceptance failures are represented by progress and do not reject this
   * acceptance promise.
   */
  async start(untrustedRequest: unknown): Promise<void> {
    if (this.busy) throw new Error('a batch is already active');

    const fallbackCount = requestedItemCount(untrustedRequest);
    let request: BatchRequest;
    try {
      this.#host.assertCanStart();
      const environment = this.#host.environment();
      if (environment.terminal || environment.disposed) {
        throw new Error('the simulator is unavailable');
      }
      if (environment.recoverableRunFailure) {
        throw new Error('replace the failed GPU run with CPU / Wasm before starting a batch');
      }
      request = normalizeBatchRequest(untrustedRequest);
      if (
        request.definition.items.some((item) => item.computePath === 'webgpu') &&
        !environment.webGpuAvailable
      ) {
        throw new Error('a queued WebGPU run cannot start on this machine');
      }
    } catch (error) {
      const failure = errorFrom(error);
      this.#publishStartFailure(failure, fallbackCount);
      throw failure;
    }

    this.#starting = true;
    this.#requestedRunning = true;
    this.#stopRequested = false;
    this.#interruptError = null;
    this.#resumeWaiter = null;
    this.#activeStatus = 'starting';
    const completion = createVoidDeferred();
    this.#completion = completion.promise;
    let controlsLocked = false;

    try {
      this.#host.setBatchControlsLocked(true);
      controlsLocked = true;
      const queue: BatchQueueItem[] = request.definition.items.map((definition) => ({
        id: this.#createId(),
        definition: structuredClone(definition),
      }));
      const createdAt = this.#now();
      const experiment: ExperimentRecord = {
        schemaVersion: RECORD_SCHEMA_VERSION,
        id: this.#createId(),
        name: request.name,
        status: 'queued',
        createdAt,
        updatedAt: createdAt,
        definition: structuredClone(request.definition),
        runIds: queue.map((item) => item.id),
      };
      this.#publish({
        phase: 'starting',
        requestedRunning: true,
        experimentId: experiment.id,
        completedRuns: 0,
        totalRuns: queue.length,
        currentItemIndex: null,
        currentEpoch: 0,
        status: 'starting',
        items: queue.map(() => ({ status: 'queued', epoch: 0, reason: null })),
      });

      const repository = await this.#repository;
      const savedState = this.#host.captureManualState();
      const selection = structuredClone(this.#host.workerSelection());
      await this.#putExperiment(repository, experiment);

      this.#starting = false;
      this.#accepted = true;
      void this.#runAcceptedInBackground(
        {
          repository,
          savedState,
          selection,
          queue,
          experiment,
          controlsLocked,
        },
        completion,
      );
    } catch (error) {
      const failure = errorFrom(error);
      this.#starting = false;
      this.#requestedRunning = false;
      this.#stopRequested = false;
      if (controlsLocked && this.#environmentUsable()) {
        try {
          this.#host.setBatchControlsLocked(false);
        } catch {
          // Preserve the original acceptance failure even if presentation
          // cleanup cannot be applied.
        }
      }
      completion.resolve();
      this.#publishStartFailure(failure, request.definition.items.length);
      throw failure;
    }
  }

  /** Request cooperative pause or resume. The progress phase acknowledges it. */
  setRunning(running: boolean): void {
    if (!this.busy || running === this.#requestedRunning) return;
    if (
      this.#stopRequested
      || this.#progress.phase === 'completed'
      || this.#progress.phase === 'failed'
      || this.#progress.phase === 'stopped'
    ) return;

    this.#requestedRunning = running;
    if (!running) {
      if (this.#effectiveRunning) {
        const item = this.#progress.currentItemIndex;
        this.#publish(
          {
            phase: 'pausing',
            requestedRunning: false,
            status: 'pausing after the current epoch',
          },
          item,
          item !== null && this.#progress.items[item]?.status === 'running'
            ? { status: 'pausing' }
            : undefined,
        );
        if (this.#executionActive) this.#coordinator.send({ t: 'cancel-pending' });
      } else {
        this.#ensureResumeWaiter();
        const item = this.#progress.currentItemIndex;
        this.#publish(
          {
            phase: this.#executionActive ? 'paused' : 'pausing',
            requestedRunning: false,
            status: this.#executionActive ? 'paused' : 'pause requested',
          },
          item,
          item !== null &&
            (this.#progress.items[item]?.status === 'resuming' ||
              this.#progress.items[item]?.status === 'pausing')
            ? { status: 'paused' }
            : undefined,
        );
      }
      return;
    }

    const waiter = this.#resumeWaiter;
    this.#resumeWaiter = null;
    waiter?.resolve();
    const item = this.#progress.currentItemIndex;
    if (this.#effectiveRunning) {
      this.#publish(
        {
          phase: 'running',
          requestedRunning: true,
          status: this.#activeStatus,
        },
        item,
        item !== null && this.#progress.items[item]?.status === 'pausing'
          ? { status: 'running' }
          : undefined,
      );
    } else {
      this.#publish(
        {
          phase: 'resuming',
          requestedRunning: true,
          status: 'resuming',
        },
        item,
        item !== null &&
          (this.#progress.items[item]?.status === 'paused' ||
            this.#progress.items[item]?.status === 'pausing')
          ? { status: 'resuming' }
          : undefined,
      );
    }
  }

  /** Stop the accepted experiment at its next exact epoch boundary. */
  stop(): void {
    if (!this.busy || this.#stopRequested) return;
    if (
      this.#progress.phase === 'completed'
      || this.#progress.phase === 'failed'
      || this.#progress.phase === 'stopped'
    ) return;

    const wasPausing = this.#progress.phase === 'pausing';
    const item = this.#progress.currentItemIndex;
    this.#stopRequested = true;
    this.#requestedRunning = false;
    this.#publish(
      {
        phase: 'stopping',
        requestedRunning: false,
        status: this.#effectiveRunning ? 'stopping after the current epoch' : 'stopping',
      },
      item,
      item !== null && this.#progress.items[item]?.status !== 'completed'
        ? { status: 'stopping' }
        : undefined,
    );
    if (this.#executionActive && this.#effectiveRunning && !wasPausing) {
      this.#coordinator.send({ t: 'cancel-pending' });
    }
    const waiter = this.#resumeWaiter;
    this.#resumeWaiter = null;
    waiter?.resolve();
  }

  /** Wake a paused runner so terminal failure or disposal cannot strand it. */
  interrupt(error: unknown): void {
    if (!this.busy) return;
    this.#interruptError = errorFrom(error);
    this.#requestedRunning = false;
    const waiter = this.#resumeWaiter;
    this.#resumeWaiter = null;
    waiter?.resolve();
  }

  async #runAcceptedInBackground(
    context: AcceptedBatch<SavedState>,
    completion: VoidDeferred,
  ): Promise<void> {
    try {
      await this.#executeAccepted(context);
    } catch (error) {
      try {
        this.#handleUnexpectedBackgroundFailure(error);
      } catch {
        // The runner must still settle its lifecycle if the host's terminal
        // reporter itself fails during last-resort containment.
      }
    } finally {
      completion.resolve();
    }
  }

  async #executeAccepted(context: AcceptedBatch<SavedState>): Promise<void> {
    const {
      repository,
      savedState,
      selection,
      queue,
      experiment,
      controlsLocked,
    } = context;
    let transitionStarted = false;

    try {
      this.#throwIfInterrupted();
      this.#throwIfStopped();
      transitionStarted = true;
      this.#host.stopManualRunIfRunning();
      this.#recorder.finish('batch-start');
      this.#executionActive = true;
      this.#host.clearPendingManualEvents();
      this.#effectiveRunning = true;
      this.#coordinator.send({ t: 'measurement-mode', explicit: true });
      this.#coordinator.send({ t: 'rate', epochsPerSec: 0 });

      experiment.status = 'running';
      experiment.updatedAt = this.#now();
      this.#publish({
        phase: this.#requestedRunning ? 'running' : 'pausing',
        requestedRunning: this.#requestedRunning,
        status: this.#requestedRunning ? 'starting' : 'pause requested',
      });

      await this.#recorder.flush();
      await this.#putExperiment(repository, experiment);

      for (let index = 0; index < queue.length; index++) {
        await this.#waitUntilRunning(index, repository, experiment);
        this.#throwIfInterrupted();
        this.#throwIfStopped();
        const item = queue[index];
        const activation = this.#host.activateBatchRun(item.id, item.definition);
        this.#recorder.prepare({
          id: item.id,
          experimentId: experiment.id,
          source: 'batch',
          config: structuredClone(item.definition.config),
          identity: this.#identityFor(item.definition.config.engine),
          execution: {
            computePath: item.definition.computePath,
            gpuAdapter:
              item.definition.computePath === 'webgpu' ? activation.gpuAdapter : null,
            workerMode: selection.mode,
            workerCount: selection.mode === 'fixed' ? selection.count : 0,
            epochsPerSecondLimit: 0,
          },
          termination: {
            epochLimit: item.definition.epochLimit,
            orderCrossing: item.definition.orderCrossing,
          },
        });
        this.#recorder.setRunning(true);
        this.#activeStatus =
          `${item.definition.config.engine}, seed ${item.definition.config.seed}, ` +
          `${item.definition.config.nTapes} tapes × ${item.definition.config.tapeLen} bytes`;
        this.#publish(
          {
            phase: 'running',
            requestedRunning: true,
            currentItemIndex: index,
            currentEpoch: 0,
            status: this.#activeStatus,
          },
          index,
          { status: 'running', epoch: 0, reason: null },
        );

        const replacement = this.#coordinator.waitForRunCreation(item.id);
        const initialSnapshot = this.#coordinator.waitForSnapshot(item.id);
        this.#coordinator.send({
          t: 'new-run',
          cfg: structuredClone(item.definition.config),
          computePath: item.definition.computePath,
          retainCurrentOnFailure: activation.retainCurrentOnFailure,
          revision: activation.revision,
          runId: item.id,
        });
        await Promise.all([replacement, initialSnapshot]);

        let stoppedByOrderCrossing = false;
        let epoch = 0;
        while (epoch < item.definition.epochLimit) {
          await this.#waitUntilRunning(index, repository, experiment);
          this.#throwIfInterrupted();
          const count = nextBatchEpochCount(epoch, item.definition);
          const ready = this.#coordinator.waitForReady(item.id);
          this.#coordinator.send({ t: 'epoch', n: count });
          epoch = await ready;
          const measurement = await this.#coordinator.requestMeasurement();
          this.#publish(
            { currentEpoch: measurement.epoch },
            index,
            { epoch: measurement.epoch },
          );
          this.#throwIfStopped();
          if (measurement.highOrder >= item.definition.orderCrossing) {
            stoppedByOrderCrossing = true;
            break;
          }
        }

        const reason = stoppedByOrderCrossing ? 'order crossing' : 'epoch limit';
        this.#recorder.finish(
          stoppedByOrderCrossing ? 'batch-order-crossing' : 'batch-limit',
        );
        await this.#recorder.flush();
        const completedRuns = this.#progress.completedRuns + 1;
        this.#publish(
          { completedRuns },
          index,
          { status: 'completed', epoch, reason },
        );
        experiment.updatedAt = this.#now();
        await this.#putExperiment(repository, experiment);
      }

      this.#throwIfStopped();
      experiment.status = 'completed';
      this.#requestedRunning = false;
      this.#effectiveRunning = false;
      this.#publish({
        phase: 'completed',
        requestedRunning: false,
        completedRuns: queue.length,
        status: 'completed',
      });
    } catch (error) {
      const failure = errorFrom(error);
      this.#requestedRunning = false;
      this.#effectiveRunning = false;
      const index = this.#progress.currentItemIndex;
      experiment.status = 'interrupted';
      if (failure instanceof BatchStopped) {
        if (this.#executionActive) {
          this.#recorder.finish('batch-cancelled', this.#now());
          await this.#recorder.flush().catch(() => undefined);
        }
        this.#publish(
          {
            phase: 'stopped',
            requestedRunning: false,
            status: 'stopped',
          },
          index,
          index !== null && this.#progress.items[index]?.status !== 'completed'
            ? { status: 'stopped' }
            : undefined,
        );
      } else {
        if (this.#executionActive) {
          this.#recorder.finish('failure', this.#now(), failure.message);
          await this.#recorder.flush().catch(() => undefined);
        }
        this.#publish(
          {
            phase: 'failed',
            requestedRunning: false,
            status: `failed: ${failure.message}`,
          },
          index,
          index !== null && this.#progress.items[index]?.status !== 'completed'
            ? { status: 'failed' }
            : undefined,
        );
      }
    } finally {
      this.#executionActive = false;
      this.#effectiveRunning = false;
      this.#requestedRunning = false;
      const waiter = this.#resumeWaiter;
      this.#resumeWaiter = null;
      waiter?.resolve();
      experiment.updatedAt = this.#now();

      try {
        await this.#putExperiment(repository, experiment);
      } catch (error) {
        const failure = errorFrom(error);
        this.#publish({
          phase: 'failed',
          requestedRunning: false,
          status: `record write failed: ${failure.message}`,
        });
      }
      await this.#host.refreshRecords().catch(() => undefined);

      if (transitionStarted && this.#environmentUsable()) {
        try {
          await this.#host.restoreManualState(savedState);
        } catch (error) {
          if (this.#environmentUsable()) this.#host.reportFatal(error);
        }
      }

      this.#accepted = false;
      this.#stopRequested = false;
      this.#interruptError = null;
      try {
        if (controlsLocked && this.#environmentUsable()) {
          this.#host.setBatchControlsLocked(false);
        }
      } finally {
        // Busy is intentionally kept true through restoration. Republish so
        // adapters can release any derived lock after that private state changes.
        this.#publish({});
      }
    }
  }

  async #waitUntilRunning(
    index: number,
    repository: RunRepository,
    experiment: ExperimentRecord,
  ): Promise<void> {
    this.#throwIfInterrupted();
    this.#throwIfStopped();
    if (this.#requestedRunning) return;

    for (;;) {
      const enteringItem = this.#progress.currentItemIndex !== index;
      // Create the gate before the durable paused write. A resume that arrives
      // while IndexedDB is pending must still release this exact boundary.
      this.#ensureResumeWaiter();
      this.#effectiveRunning = false;
      this.#recorder.setRunning(false);
      experiment.status = 'paused';
      experiment.updatedAt = this.#now();
      this.#publish(
        {
          phase: 'paused',
          requestedRunning: false,
          currentItemIndex: index,
          currentEpoch: enteringItem ? 0 : this.#progress.currentEpoch,
          status: 'paused',
        },
        index,
        { status: 'paused' },
      );
      await this.#putExperiment(repository, experiment);
      this.#throwIfInterrupted();
      this.#throwIfStopped();

      while (!this.#requestedRunning) {
        this.#throwIfInterrupted();
        this.#throwIfStopped();
        await this.#ensureResumeWaiter().promise;
      }
      this.#throwIfInterrupted();
      this.#throwIfStopped();

      this.#effectiveRunning = true;
      this.#recorder.setRunning(true);
      experiment.status = 'running';
      experiment.updatedAt = this.#now();
      this.#publish(
        {
          phase: 'running',
          requestedRunning: true,
          status: this.#activeStatus,
        },
        index,
        { status: 'running' },
      );
      await this.#putExperiment(repository, experiment);
      // A new pause can arrive while the running record is being committed.
      // Do not schedule the next epoch until that request has its own durable
      // paused boundary.
      if (this.#requestedRunning) return;
    }
  }

  #ensureResumeWaiter(): VoidDeferred {
    this.#resumeWaiter ??= createVoidDeferred();
    return this.#resumeWaiter;
  }

  #throwIfInterrupted(): void {
    if (this.#interruptError) throw this.#interruptError;
    const environment = this.#host.environment();
    if (environment.terminal || environment.disposed) {
      throw new Error('simulation coordinator is unavailable');
    }
    if (environment.recoverableRunFailure) {
      throw new Error('the active batch run failed');
    }
  }

  #throwIfStopped(): void {
    if (this.#stopRequested) throw new BatchStopped();
  }

  #environmentUsable(): boolean {
    const environment = this.#host.environment();
    return !environment.terminal && !environment.disposed;
  }

  async #putExperiment(repository: RunRepository, experiment: ExperimentRecord): Promise<void> {
    await repository.putExperiment(structuredClone(experiment));
  }

  #publishStartFailure(error: Error, totalRuns: number): void {
    this.#requestedRunning = false;
    this.#publish({
      phase: 'failed',
      requestedRunning: false,
      experimentId: null,
      completedRuns: 0,
      totalRuns,
      currentItemIndex: null,
      currentEpoch: 0,
      status: `batch did not start: ${error.message}`,
      items: Array.from({ length: totalRuns }, () => ({
        status: 'queued' as const,
        epoch: 0,
        reason: null,
      })),
    });
  }

  #handleUnexpectedBackgroundFailure(error: unknown): void {
    const failure = errorFrom(error);
    this.#starting = false;
    this.#accepted = false;
    this.#executionActive = false;
    this.#effectiveRunning = false;
    this.#requestedRunning = false;
    this.#stopRequested = false;
    this.#publish({
      phase: 'failed',
      requestedRunning: false,
      status: `failed: ${failure.message}`,
    });
    if (this.#environmentUsable()) this.#host.reportFatal(failure);
  }

  #publish(
    patch: Partial<BatchRunnerProgress>,
    itemIndex: number | null = null,
    itemPatch?: Partial<BatchRunnerItemProgress>,
  ): void {
    let items = patch.items ?? this.#progress.items;
    if (itemIndex !== null && itemPatch && items[itemIndex]) {
      items = items.map((item, index) =>
        index === itemIndex ? { ...item, ...itemPatch } : item,
      );
    }
    this.#progress = freezeProgress({
      ...this.#progress,
      ...patch,
      items,
    });
    for (const listener of [...this.#listeners]) listener();
  }
}

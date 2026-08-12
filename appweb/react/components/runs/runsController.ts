import type { ComputePath } from '../../../../engine/src/protocol.ts';
import {
  defaultConfigForEngine,
  isReactorEngine,
  type ReactorEngine,
  type SoupConfig,
} from '../../../../engine/src/soup.ts';
import {
  assertBatchRunDefinition,
  BATCH_MEASUREMENT_INTERVAL,
  expandSeedRuns,
  MAX_BATCH_EPOCH_LIMIT,
  MAX_BATCH_RUNS,
  MAX_SEED,
  type BatchRequest,
} from '../../../records/batch.ts';
import {
  CURRENT_BATCH_DRAFT_VERSION,
  decodeBatchDraft,
  encodeBatchDraft,
  LEGACY_BATCH_DRAFT_VERSION,
} from '../../../records/batchDraft.ts';
import type {
  BatchRunDefinition,
  ExperimentRecord,
  OrderCrossing,
  RunRecord,
} from '../../../records/model.ts';
import type { RunRepository } from '../../../records/repository.ts';
import {
  type ImmutableUiSnapshot,
  UiExternalStore,
  type ReadonlyExternalStore,
} from '../../runtime/externalStore.ts';

export type { BatchRequest } from '../../../records/batch.ts';

export interface BatchItemProgress {
  readonly status:
    | 'queued'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'resuming'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';
  readonly epoch: number;
  readonly reason: 'epoch limit' | 'order crossing' | null;
}

export interface BatchProgress {
  readonly phase:
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
  readonly active: boolean;
  readonly running: boolean;
  readonly experimentId: string | null;
  readonly completedRuns: number;
  readonly totalRuns: number;
  readonly currentRun: number;
  readonly currentEpoch: number;
  readonly status: string;
  readonly items: readonly BatchItemProgress[];
}

export interface BatchEditorState {
  readonly engine: ReactorEngine;
  readonly nTapes: number;
  readonly tapeLen: number;
  readonly seed: string;
  readonly seedCount: string;
  readonly maxSteps: number;
  readonly computePath: ComputePath;
  readonly mutationRate: number;
  readonly epochLimit: string;
  readonly orderCrossing: OrderCrossing;
}

export interface RunsRecordsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly runs: readonly RunRecord[];
  readonly experiments: readonly ExperimentRecord[];
  readonly error: string | null;
}

export interface RunsSnapshot {
  readonly open: boolean;
  readonly tab: 'batch' | 'records';
  readonly queue: readonly BatchRunDefinition[];
  readonly selectedQueueIndex: number;
  readonly batchName: string;
  readonly batchProgress: BatchProgress;
  readonly editor: BatchEditorState;
  readonly editorError: string;
  readonly webGpuAvailable: boolean;
  readonly records: RunsRecordsState;
}

export type RunsViewSnapshot = ImmutableUiSnapshot<RunsSnapshot>;

export interface RunsControllerOptions {
  readonly repository: Promise<RunRepository>;
  readonly currentConfig: () => SoupConfig;
  readonly webGpuAvailable: () => boolean;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly randomSeed?: () => number;
}

const DEFAULT_BATCH_NAME = 'experiment batch';
const DRAFT_KEY = `clr.batch-draft.v${CURRENT_BATCH_DRAFT_VERSION}`;
const LEGACY_DRAFT_KEY = `clr.batch-draft.v${LEGACY_BATCH_DRAFT_VERSION}`;

const EMPTY_PROGRESS: BatchProgress = Object.freeze({
  phase: 'idle',
  active: false,
  running: false,
  experimentId: null,
  completedRuns: 0,
  totalRuns: 0,
  currentRun: 0,
  currentEpoch: 0,
  status: 'idle',
  items: Object.freeze([]),
});

const EMPTY_RECORDS: RunsRecordsState = Object.freeze({
  status: 'idle',
  runs: Object.freeze([]),
  experiments: Object.freeze([]),
  error: null,
});

function cloneDefinition(value: BatchRunDefinition): BatchRunDefinition {
  return { ...value, config: { ...value.config } };
}

function editorFromDefinition(value: BatchRunDefinition): BatchEditorState {
  return Object.freeze({
    engine: value.config.engine,
    nTapes: value.config.nTapes,
    tapeLen: value.config.tapeLen,
    seed: String(value.config.seed),
    seedCount: '1',
    maxSteps: value.config.maxSteps,
    computePath: value.computePath,
    mutationRate: value.config.mutationRate,
    epochLimit: String(value.epochLimit),
    orderCrossing: value.orderCrossing,
  });
}

function editorFromConfig(config: SoupConfig): BatchEditorState {
  return editorFromDefinition({
    config: { ...config },
    computePath: 'wasm',
    epochLimit: 20_000,
    orderCrossing: 1,
    measurementInterval: BATCH_MEASUREMENT_INTERVAL,
  });
}

function freezeProgress(progress: BatchProgress): BatchProgress {
  return Object.freeze({
    ...progress,
    items: Object.freeze(progress.items.map((item) => Object.freeze({ ...item }))),
  });
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** DOM-independent owner of Runs window, batch draft, and records-query state. */
export class RunsController implements ReadonlyExternalStore<RunsViewSnapshot> {
  onStartBatch: ((request: BatchRequest) => void) | null = null;
  onSetBatchRunning: ((running: boolean) => void) | null = null;
  onStopBatch: (() => void) | null = null;
  onChange: (() => void) | null = null;

  readonly #repository: Promise<RunRepository>;
  readonly #currentConfig: () => SoupConfig;
  readonly #webGpuAvailable: () => boolean;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly #randomSeed: () => number;
  readonly #store: UiExternalStore<RunsSnapshot>;

  #open = false;
  #tab: RunsSnapshot['tab'] = 'batch';
  #queue: BatchRunDefinition[] = [];
  #selectedQueueIndex = -1;
  #batchName = DEFAULT_BATCH_NAME;
  #progress: BatchProgress = EMPTY_PROGRESS;
  #editor: BatchEditorState;
  #editorError = '';
  #records: RunsRecordsState = EMPTY_RECORDS;
  #recordsRequest = 0;

  constructor(options: RunsControllerOptions) {
    this.#repository = options.repository;
    this.#currentConfig = options.currentConfig;
    this.#webGpuAvailable = options.webGpuAvailable;
    this.#storage = options.storage === undefined
      ? (typeof localStorage === 'undefined' ? null : localStorage)
      : options.storage;
    this.#randomSeed = options.randomSeed ?? (() => (Math.random() * (MAX_SEED + 1)) >>> 0);
    this.#restoreDraft();
    this.#editor = editorFromConfig(this.#currentConfig());
    this.#store = new UiExternalStore<RunsSnapshot>(this.#createSnapshot());
  }

  readonly getSnapshot = (): RunsViewSnapshot => this.#store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(tab: RunsSnapshot['tab'] = this.#tab): void {
    const changed = !this.#open;
    this.#open = true;
    this.#tab = tab;
    if (tab === 'records') void this.refreshRecords();
    else this.#publish();
    if (changed) this.onChange?.();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#recordsRequest++;
    this.#publish();
    this.onChange?.();
  }

  setTab(tab: RunsSnapshot['tab']): void {
    if (tab === this.#tab) return;
    this.#tab = tab;
    if (tab === 'records') void this.refreshRecords();
    else this.#publish();
  }

  setBatchProgress(progress: BatchProgress): void {
    this.#progress = freezeProgress(progress);
    if (progress.active && progress.currentRun > 0) {
      this.#selectQueueIndex(progress.currentRun - 1);
    }
    this.#publish();
  }

  refreshBatchEditor(): void {
    // Capability/failure changes only affect option availability. Preserve an
    // in-progress editor draft instead of rebuilding it from the manual setup.
    this.#publish();
  }

  updateEditor(patch: Partial<BatchEditorState>): void {
    if (this.#progress.active) return;
    this.#editor = Object.freeze({ ...this.#editor, ...patch });
    this.#editorError = '';
    this.#publish();
  }

  selectEngine(value: string): void {
    if (this.#progress.active || !isReactorEngine(value)) return;
    const config = defaultConfigForEngine(value);
    this.#editor = Object.freeze({
      ...this.#editor,
      engine: value,
      nTapes: config.nTapes,
      tapeLen: config.tapeLen,
      seed: String(config.seed),
      maxSteps: config.maxSteps,
      mutationRate: config.mutationRate,
      computePath: value === 'cubff' ? this.#editor.computePath : 'wasm',
    });
    this.#editorError = '';
    this.#publish();
  }

  rollSeed(): void {
    this.updateEditor({ seed: String(this.#randomSeed()) });
  }

  addEditorRun(): void {
    const parsed = this.#readEditor();
    if (parsed instanceof Error) return this.#showError(parsed.message);
    if (this.#queue.length + parsed.seedCount > MAX_BATCH_RUNS) {
      return this.#showError(
        `adding ${parsed.seedCount} runs would exceed the ${MAX_BATCH_RUNS}-run queue limit`,
      );
    }
    try {
      this.#queue.push(...expandSeedRuns(parsed.definition, parsed.seedCount));
    } catch (error) {
      return this.#showError(error instanceof Error ? error.message : String(error));
    }
    this.#selectedQueueIndex = this.#queue.length - 1;
    this.#editor = editorFromDefinition(this.#queue[this.#selectedQueueIndex]);
    this.#resetProgressForDraft();
    this.#persistDraft();
    this.#publish();
  }

  editSelectedRun(): void {
    const parsed = this.#readEditor();
    if (parsed instanceof Error) return this.#showError(parsed.message);
    if (parsed.seedCount !== 1) {
      return this.#showError('Edit changes one selected run; set number of seeds to 1');
    }
    if (!this.#selectedDefinition()) return this.#showError('select a queue row to edit');
    this.#queue[this.#selectedQueueIndex] = cloneDefinition(parsed.definition);
    this.#editor = editorFromDefinition(parsed.definition);
    this.#resetProgressForDraft();
    this.#persistDraft();
    this.#publish();
  }

  selectQueueIndex(index: number): void {
    if (this.#progress.active || !this.#selectQueueIndex(index)) return;
    this.#editorError = '';
    this.#publish();
  }

  deleteQueueIndex(index: number): void {
    if (this.#progress.active || !Number.isInteger(index) || index < 0 || index >= this.#queue.length) {
      return;
    }
    this.#queue.splice(index, 1);
    if (this.#selectedQueueIndex === index) this.#selectedQueueIndex = -1;
    else if (this.#selectedQueueIndex > index) this.#selectedQueueIndex--;
    this.#editor = this.#selectedDefinition()
      ? editorFromDefinition(this.#selectedDefinition()!)
      : editorFromConfig(this.#currentConfig());
    this.#resetProgressForDraft();
    this.#persistDraft();
    this.#publish();
  }

  clearQueue(): void {
    if (this.#progress.active || !this.#queue.length) return;
    this.#queue = [];
    this.#selectedQueueIndex = -1;
    this.#editor = editorFromConfig(this.#currentConfig());
    this.#resetProgressForDraft();
    this.#persistDraft();
    this.#publish();
  }

  updateBatchName(value: string, persist = false): void {
    if (this.#progress.active) return;
    this.#batchName = value;
    if (persist) {
      this.#batchName = value.trim() || DEFAULT_BATCH_NAME;
      this.#persistDraft();
    }
    this.#publish();
  }

  setBatchRunning(running: boolean): void {
    if (this.#progress.active) {
      this.onSetBatchRunning?.(running);
      return;
    }
    if (!running) return;
    if (!this.#queue.length) return this.#showError('add at least one run to the queue');
    if (this.#queue.length > MAX_BATCH_RUNS) {
      return this.#showError(`queue limit is ${MAX_BATCH_RUNS} runs; remove runs before starting`);
    }
    this.#batchName = this.#batchName.trim() || DEFAULT_BATCH_NAME;
    this.#persistDraft();
    this.#publish();
    this.onStartBatch?.({
      name: this.#batchName,
      definition: { items: this.#queue.map(cloneDefinition) },
    });
  }

  stopBatch(): void {
    if (!this.#progress.active) return;
    this.onStopBatch?.();
  }

  async refreshRecords(): Promise<void> {
    if (!this.#open || this.#tab !== 'records') return;
    const request = ++this.#recordsRequest;
    this.#records = Object.freeze({ ...this.#records, status: 'loading', error: null });
    this.#publish();
    try {
      const repository = await this.#repository;
      const [runs, experiments] = await Promise.all([
        repository.listRuns(),
        repository.listExperiments(),
      ]);
      if (request !== this.#recordsRequest || !this.#open || this.#tab !== 'records') return;
      this.#records = Object.freeze({
        status: 'ready',
        runs: Object.freeze(runs.map((run) => Object.freeze(run))),
        experiments: Object.freeze(experiments.map((experiment) => Object.freeze(experiment))),
        error: null,
      });
      this.#publish();
    } catch (error) {
      if (request !== this.#recordsRequest || !this.#open || this.#tab !== 'records') return;
      this.#records = Object.freeze({
        status: 'failed',
        runs: Object.freeze([]),
        experiments: Object.freeze([]),
        error: error instanceof Error ? error.message : String(error),
      });
      this.#publish();
    }
  }

  async exportRunJson(id: string): Promise<void> {
    const repository = await this.#repository;
    const [run, measurements, events] = await Promise.all([
      repository.getRun(id),
      repository.listMeasurements(id),
      repository.listEvents(id),
    ]);
    if (!run) return;
    download(
      `clr-run-${id}.json`,
      'application/json',
      JSON.stringify({ run, events, measurements }, null, 2),
    );
  }

  async exportAllJson(): Promise<void> {
    const { runs, experiments } = this.#records;
    const repository = await this.#repository;
    const records = await Promise.all(runs.map(async (run) => ({
      run,
      events: await repository.listEvents(run.id),
      measurements: await repository.listMeasurements(run.id),
    })));
    download(
      `clr-records-${new Date().toISOString().slice(0, 10)}.json`,
      'application/json',
      JSON.stringify({ exportedAt: Date.now(), experiments, records }, null, 2),
    );
  }

  exportCsv(): void {
    const header = [
      'run_id', 'experiment_id', 'source', 'status', 'started_at', 'ended_at',
      'engine', 'compute_path', 'gpu_vendor', 'gpu_architecture', 'gpu_device',
      'gpu_description', 'gpu_is_fallback_adapter', 'source_revision', 'tapes',
      'bytes_per_tape', 'step_limit', 'mutation_rate', 'seed', 'epoch_limit',
      'order_crossing', 'final_epoch', 'interactions', 'steps', 'maximum_high_order',
      'first_order_crossing_epoch', 'population_fingerprint',
    ];
    const rows = this.#records.runs.map((run) => [
      run.id,
      run.experimentId,
      run.source,
      run.status,
      run.startedAt,
      run.endedAt,
      run.initialConfig.engine,
      run.execution.computePath,
      run.execution.gpuAdapter?.vendor,
      run.execution.gpuAdapter?.architecture,
      run.execution.gpuAdapter?.device,
      run.execution.gpuAdapter?.description,
      run.execution.gpuAdapter?.isFallbackAdapter,
      run.identity.sourceRevision,
      run.initialConfig.nTapes,
      run.initialConfig.tapeLen,
      run.initialConfig.maxSteps,
      run.initialConfig.mutationRate,
      run.initialConfig.seed,
      run.termination?.epochLimit,
      run.termination?.orderCrossing,
      run.finalEpoch,
      run.cumulative.interactions,
      run.cumulative.steps,
      run.maximumHighOrder,
      run.firstThresholdCrossing?.epoch,
      run.finalPopulationFingerprint,
    ].map(csvCell).join(','));
    download('clr-run-summary.csv', 'text/csv;charset=utf-8', [header.join(','), ...rows].join('\n'));
  }

  #selectedDefinition(): BatchRunDefinition | null {
    return this.#queue[this.#selectedQueueIndex] ?? null;
  }

  #selectQueueIndex(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.#queue.length) return false;
    this.#selectedQueueIndex = index;
    this.#editor = editorFromDefinition(this.#queue[index]);
    return true;
  }

  #readEditor(): { definition: BatchRunDefinition; seedCount: number } | Error {
    try {
      const seed = Number(this.#editor.seed);
      const seedCount = Number(this.#editor.seedCount);
      const epochLimit = Number(this.#editor.epochLimit);
      if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
        throw new Error(`random seed must be an integer from 0 to ${MAX_SEED}`);
      }
      if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > MAX_BATCH_RUNS) {
        throw new Error(`number of seeds must be an integer from 1 to ${MAX_BATCH_RUNS}`);
      }
      if (!Number.isInteger(epochLimit) || epochLimit < 1 || epochLimit > MAX_BATCH_EPOCH_LIMIT) {
        throw new Error(`epoch limit must be an integer from 1 to ${MAX_BATCH_EPOCH_LIMIT}`);
      }
      if (this.#editor.computePath === 'webgpu' && !this.#webGpuAvailable()) {
        throw new Error('WebGPU execution is unavailable');
      }
      const base = defaultConfigForEngine(this.#editor.engine);
      const definition: BatchRunDefinition = {
        config: {
          ...base,
          engine: this.#editor.engine,
          nTapes: this.#editor.nTapes,
          tapeLen: this.#editor.tapeLen,
          maxSteps: this.#editor.maxSteps,
          mutationRate: this.#editor.mutationRate,
          seed,
        },
        computePath: this.#editor.computePath,
        epochLimit,
        orderCrossing: this.#editor.orderCrossing,
        measurementInterval: BATCH_MEASUREMENT_INTERVAL,
      };
      assertBatchRunDefinition(definition);
      return { definition, seedCount };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  #showError(message: string): void {
    this.#editorError = message;
    this.#publish();
  }

  #resetProgressForDraft(): void {
    this.#progress = freezeProgress({
      phase: 'idle',
      active: false,
      running: false,
      experimentId: null,
      completedRuns: 0,
      totalRuns: this.#queue.length,
      currentRun: 0,
      currentEpoch: 0,
      status: 'draft',
      items: this.#queue.map(() => ({ status: 'queued', epoch: 0, reason: null })),
    });
  }

  #persistDraft(): void {
    try {
      this.#storage?.setItem(DRAFT_KEY, encodeBatchDraft({
        name: this.#batchName,
        definition: { items: this.#queue },
      }));
    } catch {
      // Record persistence is independent of optional local draft storage.
    }
  }

  #restoreDraft(): void {
    try {
      const current = this.#storage?.getItem(DRAFT_KEY) ?? null;
      const raw = current ?? this.#storage?.getItem(LEGACY_DRAFT_KEY) ?? null;
      if (!raw) return;
      const draft = decodeBatchDraft(
        raw,
        current ? CURRENT_BATCH_DRAFT_VERSION : LEGACY_BATCH_DRAFT_VERSION,
      );
      this.#batchName = draft.name;
      this.#queue = draft.definition.items.map(cloneDefinition);
      if (!current && this.#queue.length) this.#persistDraft();
    } catch {
      // Invalid or unavailable draft storage starts with a clean editor.
    }
  }

  #createSnapshot(): RunsSnapshot {
    return Object.freeze({
      open: this.#open,
      tab: this.#tab,
      queue: Object.freeze(this.#queue.map((item) => Object.freeze(cloneDefinition(item)))),
      selectedQueueIndex: this.#selectedQueueIndex,
      batchName: this.#batchName,
      batchProgress: this.#progress,
      editor: this.#editor,
      editorError: this.#editorError,
      webGpuAvailable: this.#webGpuAvailable(),
      records: this.#records,
    });
  }

  #publish(): void {
    this.#store.publish(this.#createSnapshot());
  }
}

import { version } from '../package.json';
import { flushSync } from 'react-dom';
import { modelIdentity } from './records/identity.ts';
import {
  bytesToHex,
  type BatchRunDefinition,
  type RunEndReason,
} from './records/model.ts';
import { RunRecorder } from './records/recorder.ts';
import { openRunRepository } from './records/repository.ts';
import {
  BatchRunner,
  type BatchRunnerProgress,
} from './runtime/batchRunner.ts';
import { CoordinatorClient, type SnapshotMessage } from './runtime/coordinatorClient.ts';
import type { CoordinatorTransportFailure } from './runtime/coordinatorTransport.ts';
import {
  DisplayCoordinator,
  type SamplerSelectionMode,
  type SoupDisplayMode,
} from './runtime/displayCoordinator.ts';
import { inspectMeasurement, inspectSnapshot } from './runtime/runProtocol.ts';

import {
  assessAvailableWorkerCount,
  deriveAutoWorkerCount,
  type ComputePath,
  type FromWorker,
  type GpuAdapterIdentity,
  type MeasurementPayload,
  type ToWorker,
  type WorkerSelection,
} from '../engine/src/protocol.ts';
import {
  DEFAULT_CONFIG,
  defaultConfigForEngine,
  isReactorEngine,
  type SoupConfig,
} from '../engine/src/soup.ts';
import {
  mountControlDeck,
  type ControlDeckActions,
  type ControlDeckViewState,
} from './react/components/control-deck/index.ts';
import { mountApplicationHeader } from './react/components/header/index.ts';
import { mountOrder } from './react/components/order/index.ts';
import {
  mountReactionState,
  ReactionStateStore,
} from './react/components/reaction-state/index.ts';
import {
  mountRunsWindow,
  RunsController,
  type BatchProgress,
} from './react/components/runs/index.ts';
import { mountSampler } from './react/components/sampler/index.ts';
import {
  mountApplicationFrame,
  type ApplicationFrameState,
} from './react/components/shell/index.ts';
import { mountSoup } from './react/components/soup/index.ts';
import { mountStartWindow } from './react/components/start/index.ts';
import {
  HelpWindowController,
  mountHelpWindow,
} from './react/help/index.ts';
import {
  COMPUTE_PATH_OPTIONS,
  ENGINE_OPTIONS,
  EXECUTION_RATE_OPTIONS,
  SAMPLER_RATE_OPTIONS,
  SAMPLE_MODE_OPTIONS,
  SOUP_VIEW_OPTIONS,
  STEP_LIMIT_OPTIONS,
  TAPE_COUNT_OPTIONS,
  TAPE_LENGTH_OPTIONS,
  workerOptions,
} from './react/model/controlOptions.ts';
import type { OrderSummaryViewState } from './react/runtime/viewState.ts';
import { UiExternalStore } from './react/runtime/externalStore.ts';
import { calculateConsoleFit } from './ui/consoleFit.ts';
import { loadPrefs, savePrefs } from './ui/prefs.ts';
import { waitForUiFonts } from './ui/typography.ts';

/* ── helpers ─────────────────────────────────────────────────────────────── */

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
}

/* ── React-owned application host ───────────────────────────────────────── */

const applicationFrameStore = new UiExternalStore<ApplicationFrameState>(Object.freeze({
  started: false,
  fatalMessage: null,
}));
let disposeApplicationFrameView: (() => void) | null = mountApplicationFrame(
  $('#appRoot'),
  applicationFrameStore,
);

/* ── instruments ─────────────────────────────────────────────────────────── */

/**
 * `hardwareConcurrency` bounds the manual choices. Auto deterministically
 * uses 80% of that browser-reported capacity, capped for per-tab resources.
 */
let cpuWorkerControlValue = 'auto';
const REPORTED_WORKERS = assessAvailableWorkerCount(
  (navigator as { hardwareConcurrency?: number }).hardwareConcurrency,
);
const AUTO_WORKER_COUNT = deriveAutoWorkerCount(REPORTED_WORKERS);

let resolvedAutoWorkerCount = AUTO_WORKER_COUNT;
let epochsPerSecondLimit = 0;
let epochReadout = '000000';
let rateReadout = '0.0';
let computeControlError: string | null = null;
let computeControlErrorRevision = 0;
let batchControlsLocked = false;

function workerSelectionFromControl(): WorkerSelection {
  const value = cpuWorkerControlValue;
  if (value === 'auto') return { mode: 'auto', count: AUTO_WORKER_COUNT };
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`worker control holds ${JSON.stringify(value)}`);
  }
  return { mode: 'fixed', count };
}

function setAutoWorkerLabel(count = AUTO_WORKER_COUNT): void {
  resolvedAutoWorkerCount = count;
  publishControlDeck();
}

const EMPTY_ORDER_SUMMARY = Object.freeze<OrderSummaryViewState>({
  epoch: null,
  highOrder: null,
  byteFrequencyOrder: null,
  zeroOrderEntropy: null,
  compressedBitsPerByte: null,
});
const orderSummaryStore = new UiExternalStore<OrderSummaryViewState>(EMPTY_ORDER_SUMMARY);
const help = new HelpWindowController();
const mountedOrder = mountOrder($('#orderRoot'), {
  help,
  store: orderSummaryStore,
});
let disposeOrderView: (() => void) | null = mountedOrder.dispose;

/* ── state ───────────────────────────────────────────────────────────────── */

const cfg: SoupConfig = { ...DEFAULT_CONFIG };
const reactionStateStore = new ReactionStateStore(cfg);
let activeComputePath: ComputePath = 'wasm';
let pendingComputeSelection: {
  computePath: ComputePath;
  runId: string;
  revision: number;
} | null = null;
let gpuAdapter: GpuAdapterIdentity | null = null;
let webGpuAvailable = false;
let configRevision = 0;
let activeRunId: string = crypto.randomUUID();
let soupRunning = false;

const display = new DisplayCoordinator({
  sampler: {
    maxSteps: cfg.maxSteps,
    headPolicy: cfg.headPolicy,
    noMatch: cfg.noMatch,
  },
  onError: (error) => {
    console.error('[display]', error);
    const message = error instanceof Error ? error.message : String(error);
    setFatal(`the display could not be updated: ${message}`);
  },
});
const mountedSoup = mountSoup($('#soupRoot'), {
  display,
  help,
  legendContainer: $('#soupLegendRoot'),
  onModeChange: () => {
    syncSoupModePresentation();
    persist();
  },
  onExpandedChange: (expanded) => {
    document.body.classList.toggle('soup-expanded', expanded);
  },
});
let disposeSoupView: (() => void) | null = mountedSoup.dispose;
const mountedSampler = mountSampler($('#samplerRoot'), {
  display,
  help,
  onEnabledChange: (enabled) => {
    syncSamplerEnabledPresentation(enabled);
    persist();
  },
  onSelectionModeChange: (mode) => {
    syncSampleModePresentation(mode);
    persist();
  },
  onSpeedChange: () => persist(),
});
let disposeSamplerView: (() => void) | null = mountedSampler.dispose;
display.attachCanvases({
  soup: mountedSoup.canvas,
  order: mountedOrder.canvas,
  sampler: mountedSampler.canvas,
});

let releaseRecordsRepository: (() => void) | null = null;
const recordsRepositoryGate = new Promise<void>((resolve) => {
  releaseRecordsRepository = resolve;
});
const recordsRepository = recordsRepositoryGate.then(async () => {
  const repository = await openRunRepository();
  await repository.markOpenRunsInterrupted(Date.now());
  return repository;
});

function startRecordsRepository(): void {
  releaseRecordsRepository?.();
  releaseRecordsRepository = null;
}

const runRecorder = new RunRecorder(recordsRepository);
const runsWindow = new RunsController({
  repository: recordsRepository,
  currentConfig: () => ({ ...cfg }),
  webGpuAvailable: () => webGpuAvailable && gpuAdapter !== null,
});
let disposeRunsView: (() => void) | null = mountRunsWindow(
  $('#runsRoot'),
  runsWindow,
  { resolveFocusFallback: () => document.querySelector('#btnRuns') },
);
runsWindow.onChange = () => publishControlDeck();

interface PendingConfigEvent {
  requestedAt: number;
  changes: Record<string, number | string | boolean>;
}
const pendingConfigEvents = new Map<number, PendingConfigEvent>();
const pendingWorkerEvents: {
  requestedAt: number;
  selection: WorkerSelection;
}[] = [];
const pendingRateEvents: { requestedAt: number; limit: number }[] = [];

interface SavedManualBatchState {
  readonly config: SoupConfig;
  readonly computePath: ComputePath;
  readonly rate: string;
}

let batchRunner: BatchRunner<SavedManualBatchState> | null = null;

function batchIsBusy(): boolean {
  return batchRunner?.busy ?? false;
}

let terminalFailure = false;
let recoverableRunFailure: { runId: string; message: string } | null = null;
let applicationStarted = false;
let applicationDisposed = false;
let consoleFitFrame: number | null = null;
let disposeHeaderView: (() => void) | null = null;
let disposeHelpView: (() => void) | null = null;
let disposeReactionStateView: (() => void) | null = null;
let disposeStartView: (() => void) | null = null;
let disposeControlDeckView: (() => void) | null = null;
let clearHelpChangeHandler: (() => void) | null = null;
let controlDeckStore: UiExternalStore<ControlDeckViewState> | null = null;

const coordinator = new CoordinatorClient({
  createWorker: () => new Worker(new URL('../engine/src/worker.ts', import.meta.url), {
    type: 'module',
  }),
  onMessage: (message) => handleWorkerMessage(message),
  onFailure: (failure) => handleCoordinatorFailure(failure),
});

function controlDeckSnapshot(): ControlDeckViewState {
  const pending = pendingComputeSelection !== null;
  const runFailed = recoverableRunFailure !== null;
  const selectedPath = pendingComputeSelection?.computePath ?? activeComputePath;
  const cubff = cfg.engine === 'cubff';
  const gpuEligible = cubff && webGpuAvailable;
  const allLocked = terminalFailure || batchControlsLocked || batchIsBusy();
  const modelControlsDisabled = allLocked || soupRunning || pending || runFailed;
  const computeStatus = runFailed && activeComputePath === 'webgpu'
    ? 'GPU / run failed'
    : activeComputePath === 'webgpu'
      ? adapterLabel(gpuAdapter)
      : 'CPU (Wasm)';
  const computeStatusTitle = runFailed
    ? (recoverableRunFailure?.message ?? '')
    : activeComputePath === 'webgpu' && gpuAdapter?.description
      ? gpuAdapter.description
      : computeStatus;
  const computeOptions = COMPUTE_PATH_OPTIONS.map((option) => option.value === 'webgpu'
    ? {
        ...option,
        label: adapterLabel(gpuAdapter),
        disabled: !gpuEligible,
        hidden: !gpuEligible && selectedPath !== 'webgpu',
      }
    : option);
  const availableWorkers = workerOptions(REPORTED_WORKERS, resolvedAutoWorkerCount);
  const selectedWorkers = selectedPath === 'webgpu' ? 'not-used' : cpuWorkerControlValue;

  return Object.freeze({
    engine: cfg.engine,
    engineOptions: ENGINE_OPTIONS,
    computePath: selectedPath,
    computeOptions,
    computeDisabled: allLocked || soupRunning || pending || !cubff,
    computeError: computeControlError,
    computeErrorRevision: computeControlErrorRevision,
    workers: selectedWorkers,
    workerOptions: selectedPath === 'webgpu'
      ? [...availableWorkers, { value: 'not-used', label: 'not used' }]
      : availableWorkers,
    workersDisabled: allLocked || soupRunning || pending || runFailed || selectedPath === 'webgpu',
    nTapes: cfg.nTapes,
    tapeCountOptions: TAPE_COUNT_OPTIONS,
    tapeLen: cfg.tapeLen,
    tapeLengthOptions: TAPE_LENGTH_OPTIONS,
    seed: cfg.seed,
    maxSteps: cfg.maxSteps,
    stepLimitOptions: STEP_LIMIT_OPTIONS,
    mutationRate: cfg.mutationRate,
    rateLimit: epochsPerSecondLimit,
    rateOptions: EXECUTION_RATE_OPTIONS,
    running: soupRunning,
    runsOpen: runsWindow.isOpen,
    // Runs is a local presentation surface and remains reachable while batch
    // execution owns the model controls, including at a durable pause.
    runsDisabled: false,
    modelControlsDisabled,
    mutationDisabled: allLocked,
    rateDisabled: allLocked,
    runDisabled: allLocked || pending || runFailed,
    resetDisabled: allLocked || pending || runFailed,
    computeStatus,
    computeStatusTitle,
    epochsPerSecond: rateReadout,
    epoch: epochReadout,
  });
}

function publishControlDeck(): void {
  controlDeckStore?.publish(controlDeckSnapshot());
}

const controlDeckActions: ControlDeckActions = {
  onEngineChange: (engine) => selectEngine(engine),
  onComputePathChange: (path) => selectComputePath(path),
  onWorkersChange: (value) => selectWorkers(value),
  onTapeCountChange: (value) => setTapeCount(value),
  onTapeLengthChange: (value) => setTapeLength(value),
  onSeedChange: (value) => restart(value),
  onRandomizeSeed: () => restart((Math.random() * 0xffffffff) >>> 0),
  onStepLimitChange: (value) => setStepLimit(value),
  onMutationRateInput: (value) => setMutationRate(value),
  onMutationRateCommit: () => persist(),
  onRateLimitChange: (value) => setRateLimit(value),
  onRunningChange: (running) => setRun(running),
  onRestart: () => restart(cfg.seed),
  onToggleRuns: () => runsWindow.toggle(),
  onDefaults: () => resetToDefaults(),
  onHelp: (topic) => help.toggle(topic),
};

controlDeckStore = new UiExternalStore<ControlDeckViewState>(controlDeckSnapshot());
disposeControlDeckView = mountControlDeck($('#controlDeckRoot'), {
  store: controlDeckStore,
  help,
  actions: controlDeckActions,
});

/**
 * The core or one of its workers is unavailable, and there is nothing else to
 * run. The failure is terminal: the coordinator seals itself after an error,
 * so controls must not keep presenting commands that can no longer take effect.
 * Local views, help and the sampler remain available to inspect the last valid
 * snapshot.
 */
function setFatal(message: string): void {
  if (terminalFailure) return;
  terminalFailure = true;
  batchRunner?.interrupt(new Error(message));
  runRecorder.finish('failure', Date.now(), message);
  const error = new Error(message);
  coordinator.failTerminal(error);

  soupRunning = false;
  rateReadout = '—';
  publishControlDeck();

  document.body.classList.add('no-wasm');
  applicationFrameStore.publish(Object.freeze({
    started: applicationStarted,
    fatalMessage: message,
  }));
}

/**
 * A failed WebGPU device invalidates one run, not the worker coordinator. Keep
 * the last valid snapshot inspectable and leave the CPU compute-path choice
 * available to create an explicit replacement run.
 */
function setRunFailed(failedRunId: string, message: string): void {
  if (terminalFailure || failedRunId !== activeRunId) return;
  if (recoverableRunFailure?.runId === failedRunId) return;
  recoverableRunFailure = { runId: failedRunId, message };

  batchRunner?.interrupt(new Error(message));
  runRecorder.finish('failure', Date.now(), message);
  const error = new Error(message);
  // Only one run can execute in this coordinator, so the client also rejects
  // every outstanding exact measurement when the active run fails.
  coordinator.failRun(failedRunId, error);

  soupRunning = false;
  rateReadout = '—';
  webGpuAvailable = false;
  gpuAdapter = null;
  const detail = `GPU run failed: ${message}. Select CPU (Wasm) to create a replacement run.`;
  computeControlError = detail;
  if (!batchIsBusy()) setRunParameterLocks(false);
  else publishControlDeck();
  runsWindow.refreshBatchEditor();
}

const send = (m: ToWorker): void => {
  if (!terminalFailure) coordinator.send(m);
};

function prepareManualRun(): void {
  const selection = workerSelectionFromControl();
  runRecorder.prepare({
    id: activeRunId,
    source: 'manual',
    config: cfg,
    identity: modelIdentity(version, cfg.engine),
    execution: {
      computePath: activeComputePath,
      gpuAdapter: activeComputePath === 'webgpu' ? gpuAdapter : null,
      workerMode: selection.mode,
      workerCount: selection.mode === 'fixed' ? selection.count : 0,
      epochsPerSecondLimit,
    },
  });
}

function replaceManualRun(reason: RunEndReason, nextRunId = crypto.randomUUID()): void {
  runRecorder.finish(reason);
  pendingConfigEvents.clear();
  pendingWorkerEvents.length = 0;
  pendingRateEvents.length = 0;
  activeRunId = nextRunId;
  prepareManualRun();
}

function sendConfig(patch: Partial<SoupConfig>): void {
  const engineChange = patch.engine !== undefined;
  const structural = engineChange || patch.nTapes !== undefined || patch.tapeLen !== undefined;
  if (structural) replaceManualRun(engineChange ? 'engine-change' : 'shape-change');
  configRevision++;
  if (!structural) {
    const changes: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        changes[key] = value;
      }
    }
    pendingConfigEvents.set(configRevision, { requestedAt: Date.now(), changes });
  }
  send({
    t: 'config',
    patch,
    computePath: activeComputePath,
    revision: configRevision,
    runId: activeRunId,
  });
}

function sendReset(seed: number, reason: RunEndReason): void {
  replaceManualRun(reason);
  configRevision++;
  send({ t: 'reset', seed, revision: configRevision, runId: activeRunId });
}

/* A worker that throws just stops posting, and the console freezes with stale
   numbers and no indication anything is wrong. Say so instead. Worker creation
   itself is gated by the start window so loading the page does no reactor work. */
function startCoordinator(): void {
  if (terminalFailure) return;
  coordinator.start();
}

function handleCoordinatorFailure(failure: CoordinatorTransportFailure): void {
  setFatal(failure.message);
  if (failure.kind === 'worker-error') {
    console.error('[soup worker]', failure.message, failure.filename, failure.line);
  } else if (failure.cause !== undefined) {
    console.error('[soup worker]', failure.cause);
  }
}

/*
 * Without this, every hot reload during development leaves the previous worker
 * alive: it keeps simulating its own soup and posting snapshots, so the panels
 * show a stale run while the controls talk to the new worker — and each orphan
 * keeps burning a core. Module-level listeners would double-bind too, so a
 * source change takes a full reload rather than a partial swap.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    applicationDisposed = true;
    batchRunner?.interrupt(new Error('application disposed'));
    if (consoleFitFrame !== null) {
      cancelAnimationFrame(consoleFitFrame);
      consoleFitFrame = null;
    }
    coordinator.dispose();
    disposeStartView?.();
    disposeStartView = null;
    clearHelpChangeHandler?.();
    clearHelpChangeHandler = null;
    disposeHelpView?.();
    disposeHelpView = null;
    disposeRunsView?.();
    disposeRunsView = null;
    display.dispose();
    disposeSoupView?.();
    disposeSoupView = null;
    disposeOrderView?.();
    disposeOrderView = null;
    disposeSamplerView?.();
    disposeSamplerView = null;
    disposeControlDeckView?.();
    disposeControlDeckView = null;
    disposeReactionStateView?.();
    disposeReactionStateView = null;
    disposeHeaderView?.();
    disposeHeaderView = null;
    disposeApplicationFrameView?.();
    disposeApplicationFrameView = null;
  });
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}

/* ── readouts ────────────────────────────────────────────────────────────── */

disposeReactionStateView = mountReactionState(
  $('#reactionStateRoot'),
  reactionStateStore,
  {
    help,
    // The synchronous initial mount runs before console measurement variables
    // are initialized. Accepted snapshots arrive only after Start and refit
    // from the committed React layout.
    onLayoutChange: () => {
      if (applicationStarted) refitIfOutgrown();
    },
  },
);

/* ── controls ────────────────────────────────────────────────────────────── */

function setRunParameterLocks(locked: boolean): void {
  void locked;
  syncExecutionControls();
}

function adapterLabel(adapter: GpuAdapterIdentity | null): string {
  if (!adapter) return 'GPU (WebGPU)';
  const name = [adapter.architecture, adapter.device, adapter.vendor, adapter.description].find(
    (part) => part.length > 0,
  );
  return name ? `GPU (${name})` : 'GPU (WebGPU)';
}

function syncExecutionControls(): void {
  const cubff = cfg.engine === 'cubff';
  if (!cubff && activeComputePath !== 'wasm') activeComputePath = 'wasm';
  publishControlDeck();
}

function setRun(on: boolean): void {
  if (terminalFailure || recoverableRunFailure || batchIsBusy() || pendingComputeSelection) return;
  soupRunning = on;
  setRunParameterLocks(on);
  runRecorder.setRunning(on);
  send({ t: 'run', on });
}

/* ── worker traffic ──────────────────────────────────────────────────────── */

function acceptMeasurement(measurement: MeasurementPayload): boolean {
  const decision = inspectMeasurement(measurement, {
    runId: activeRunId,
    configRevision,
    config: cfg,
    computePath: activeComputePath,
  });
  if (decision.kind === 'ignore') return false;
  if (decision.kind === 'fatal') {
    setFatal(decision.message);
    return false;
  }
  runRecorder.observeMeasurement({
    epoch: measurement.epoch,
    configRevision: measurement.configRevision,
    highOrder: measurement.highOrder,
    byteFrequencyOrder: measurement.byteOrder,
    zeroOrderEntropy: measurement.h0,
    compressedBitsPerByte: measurement.bpb,
    compressedBytes: measurement.compressed,
    rawBytes: measurement.raw,
    population: {
      ...measurement.population,
      motifs: measurement.population.motifs.map(({ bytes, ...motif }) => ({
        ...motif,
        bytesHex: bytesToHex(bytes),
      })),
    },
    epochInteractions: measurement.epochStats.execs,
    epochSteps: measurement.epochStats.steps,
    epochHalts: measurement.epochStats.halts,
    cumulative: measurement.cumulative,
    populationFingerprint: measurement.populationFingerprint,
  });
  display.acceptOrder({
    epoch: measurement.epoch,
    highOrder: measurement.highOrder,
    byteOrder: measurement.byteOrder,
    compressedBitsPerByte: measurement.bpb,
  });
  orderSummaryStore.publish(Object.freeze({
    epoch: measurement.epoch,
    highOrder: measurement.highOrder,
    byteFrequencyOrder: measurement.byteOrder,
    zeroOrderEntropy: measurement.h0,
    compressedBitsPerByte: measurement.bpb,
  }));
  return true;
}

const handleWorkerMessage = (m: FromWorker): void => {
  if (terminalFailure) return;
  if (m.t === 'capabilities') {
    // A capability probe describes whether a new context could be requested;
    // it must not revive the context invalidated by an active-run failure.
    webGpuAvailable = recoverableRunFailure ? false : m.webgpu.available;
    gpuAdapter = recoverableRunFailure ? null : m.webgpu.adapter;
    syncExecutionControls();
    runsWindow.refreshBatchEditor();
  } else if (m.t === 'snapshot') {
    const decision = inspectSnapshot(m, {
      runId: activeRunId,
      configRevision,
      config: cfg,
      computePath: activeComputePath,
    });
    // Replaced runs and queued output from a superseded revision are expected.
    if (decision.kind === 'ignore') return;
    if (decision.kind === 'fatal') {
      setFatal(decision.message);
      return;
    }
    if (m.computePath === 'wasm' && m.workerMode === 'auto') {
      setAutoWorkerLabel(m.workerCount);
    }
    if (m.computePath === 'webgpu') gpuAdapter = m.gpuAdapter;
    syncExecutionControls();
    const population = {
      epoch: m.epoch,
      soup: new Uint8Array(m.soup),
      nTapes: m.nTapes,
      tapeLen: m.tapeLen,
      tapeFrequencies: m.metrics.tapeFrequencies,
      uniqueTapes: m.metrics.uniqueTapes,
    };
    const recorderRunId = runRecorder.runId;
    const recordedSnapshot = {
      runId: m.runId,
      epoch: m.epoch,
      config: m.config,
      cumulative: m.cumulative,
      workerMode: m.workerMode,
      workerCount: m.workerCount,
      computePath: m.computePath,
      gpuAdapter: m.gpuAdapter,
      populationFingerprint: m.metrics.populationFingerprint,
      core: m.core,
    };
    if (recorderRunId === m.runId) {
      runRecorder.observeSnapshot({
        ...recordedSnapshot,
        running: batchRunner?.executionActive
          ? batchRunner.effectiveRunning
          : m.running,
      });
    } else if (recorderRunId !== null || !batchIsBusy()) {
      // Preserve the recorder's strict mismatch diagnostic outside the narrow
      // manual-to-batch and batch-to-manual ownership transitions.
      runRecorder.observeSnapshot({
        ...recordedSnapshot,
        running: m.running,
      });
    }
    const workerEvent = pendingWorkerEvents[0];
    if (
      workerEvent &&
      m.workerMode === workerEvent.selection.mode &&
      m.workerCount === workerEvent.selection.count
    ) {
      pendingWorkerEvents.shift();
      runRecorder.recordEvent({
        kind: 'execution',
        requestedAt: workerEvent.requestedAt,
        appliedEpoch: m.epoch,
        changes: { workerMode: m.workerMode, workerCount: m.workerCount },
      });
    }
    const rateEvent = pendingRateEvents[0];
    if (rateEvent && m.epochsPerSecondLimit === rateEvent.limit) {
      pendingRateEvents.shift();
      runRecorder.recordEvent({
        kind: 'execution',
        requestedAt: rateEvent.requestedAt,
        appliedEpoch: m.epoch,
        changes: { epochsPerSecondLimit: rateEvent.limit },
      });
    }
    display.acceptPopulation(population);
    paintMachineReadouts(m);
    reactionStateStore.acceptSnapshot(m);
    coordinator.acceptSnapshot(m);
  } else if (m.t === 'order') {
    // Compression is asynchronous. A result can already be in the browser's
    // event queue when reset clears the chart, so filter again on receipt.
    acceptMeasurement(m);
  } else if (m.t === 'measurement') {
    if (!acceptMeasurement(m)) return;
    coordinator.acceptMeasurement(m);
  } else if (m.t === 'ready') {
    if (!m.runId || m.runId !== activeRunId) return;
    coordinator.acceptReady(m);
  } else if (m.t === 'run-created') {
    coordinator.acceptRunCreation(m);
  } else if (m.t === 'run-rejected') {
    coordinator.rejectRunCreation(m);
  } else if (m.t === 'run-failed') {
    setRunFailed(m.runId, m.message);
  } else if (m.t === 'config-applied') {
    if (m.runId !== activeRunId) return;
    const event = pendingConfigEvents.get(m.configRevision);
    if (!event) return;
    pendingConfigEvents.delete(m.configRevision);
    runRecorder.recordEvent({
      kind: 'model-parameter',
      requestedAt: event.requestedAt,
      appliedEpoch: m.epoch,
      configRevision: m.configRevision,
      changes: event.changes,
    });
  } else if (m.t === 'fatal') {
    setFatal(m.message);
  }
};

function paintMachineReadouts(s: SnapshotMessage): void {
  epochReadout = String(s.epoch).padStart(6, '0');
  rateReadout = s.epochsPerSec.toFixed(1);
  publishControlDeck();
}

/* ── wiring ──────────────────────────────────────────────────────────────── */

/** Every derived history belongs to one run; a new run invalidates all of it. */
function clearHistory(): void {
  // The accepted run identity changes before its first snapshot arrives. Drop
  // the preceding population immediately so no sampler or renderer can read it
  // during that interval.
  display.clearRun();
  orderSummaryStore.publish(EMPTY_ORDER_SUMMARY);

  epochReadout = '000000';
  rateReadout = '—';
  reactionStateStore.reset(cfg);
  publishControlDeck();
}

/**
 * Build a fresh soup and carry on.
 *
 * Restart means start over, not stop: the soup is rebuilt from the seed, the
 * epoch counter returns to zero, and if it was running it keeps running.
 */
function restart(seed: number): void {
  if (recoverableRunFailure || batchIsBusy()) return;
  const wasRunning = soupRunning;
  const nextSeed = seed >>> 0;
  const reason: RunEndReason = nextSeed === cfg.seed ? 'restart' : 'seed-change';
  cfg.seed = nextSeed;
  setRun(false);
  sendReset(cfg.seed, reason);
  clearHistory();
  persist();
  if (wasRunning) setRun(true);
}

function waitForSnapshot(runId: string): Promise<Extract<FromWorker, { t: 'snapshot' }>> {
  return coordinator.waitForSnapshot(runId);
}

function waitForRunReplacement(runId: string): Promise<ComputePath> {
  return coordinator.waitForRunCreation(runId);
}

function setBatchControlLocks(locked: boolean): void {
  batchControlsLocked = locked;
  publishControlDeck();
}

function stopManualRunForBatch(): void {
  if (!soupRunning) return;
  soupRunning = false;
  // BatchRunner already owns the broader control lock. Releasing the manual
  // running lock here would partially unlock the panel during the batch.
  runRecorder.setRunning(false);
  send({ t: 'run', on: false });
  publishControlDeck();
}

async function restoreManualStateAfterBatch(saved: SavedManualBatchState): Promise<void> {
  // Return to a clean manual epoch-zero population using exactly the setup
  // that was active before the batch. Batch records remain immutable.
  send({ t: 'measurement-mode', explicit: false });
  Object.assign(cfg, saved.config);
  activeComputePath = saved.computePath;
  applyToControls(cfg);
  syncExecutionControls();
  epochsPerSecondLimit = Number(saved.rate);
  send({ t: 'rate', epochsPerSec: epochsPerSecondLimit });
  activeRunId = crypto.randomUUID();
  configRevision++;
  clearHistory();

  // Never retry a failed GPU context as part of automatic batch cleanup.
  if (recoverableRunFailure && saved.computePath === 'webgpu') {
    persist();
    return;
  }

  prepareManualRun();
  const replacement = waitForRunReplacement(activeRunId);
  const restored = waitForSnapshot(activeRunId);
  send({
    t: 'new-run',
    cfg: { ...cfg },
    computePath: activeComputePath,
    retainCurrentOnFailure: false,
    revision: configRevision,
    runId: activeRunId,
  });
  await Promise.all([replacement, restored]);
  if (recoverableRunFailure) {
    recoverableRunFailure = null;
    computeControlError = null;
    syncExecutionControls();
  }
  persist();
}

function projectBatchProgress(snapshot: BatchRunnerProgress): BatchProgress {
  return {
    phase: snapshot.phase,
    active: batchIsBusy(),
    running: snapshot.requestedRunning,
    experimentId: snapshot.experimentId,
    completedRuns: snapshot.completedRuns,
    totalRuns: snapshot.totalRuns,
    currentRun: snapshot.currentItemIndex === null ? 0 : snapshot.currentItemIndex + 1,
    currentEpoch: snapshot.currentEpoch,
    status: snapshot.status,
    items: snapshot.items.map((item) => ({ ...item })),
  };
}

batchRunner = new BatchRunner({
  repository: recordsRepository,
  coordinator,
  recorder: runRecorder,
  host: {
    assertCanStart: () => {
      if (pendingComputeSelection) {
        throw new Error('wait for the pending compute-path replacement before starting a batch');
      }
    },
    environment: () => ({
      terminal: terminalFailure,
      disposed: applicationDisposed,
      recoverableRunFailure: recoverableRunFailure !== null,
      webGpuAvailable: webGpuAvailable && gpuAdapter !== null,
    }),
    captureManualState: () => ({
      config: { ...cfg },
      computePath: activeComputePath,
      rate: String(epochsPerSecondLimit),
    }),
    workerSelection: () => workerSelectionFromControl(),
    stopManualRunIfRunning: () => stopManualRunForBatch(),
    clearPendingManualEvents: () => {
      pendingConfigEvents.clear();
      pendingWorkerEvents.length = 0;
      pendingRateEvents.length = 0;
    },
    activateBatchRun: (runId: string, definition: BatchRunDefinition) => {
      const retainCurrentOnFailure = definition.computePath !== activeComputePath;
      activeRunId = runId;
      Object.assign(cfg, definition.config);
      activeComputePath = definition.computePath;
      applyToControls(cfg);
      syncExecutionControls();
      configRevision++;
      clearHistory();
      return {
        revision: configRevision,
        retainCurrentOnFailure,
        gpuAdapter: activeComputePath === 'webgpu' ? gpuAdapter : null,
      };
    },
    restoreManualState: (saved: SavedManualBatchState) =>
      restoreManualStateAfterBatch(saved),
    setBatchControlsLocked: (locked: boolean) => setBatchControlLocks(locked),
    refreshRecords: () => runsWindow.refreshRecords(),
    reportFatal: (error: unknown) =>
      setFatal(error instanceof Error ? error.message : String(error)),
  },
  identityFor: (engine) => modelIdentity(version, engine),
});

const publishBatchProgress = () => {
  if (!batchRunner) return;
  runsWindow.setBatchProgress(projectBatchProgress(batchRunner.getSnapshot()));
  publishControlDeck();
};
batchRunner.subscribe(publishBatchProgress);
publishBatchProgress();

runsWindow.onStartBatch = (request) => {
  void batchRunner?.start(request).catch(() => undefined);
};
runsWindow.onSetBatchRunning = (running) => batchRunner?.setRunning(running);
runsWindow.onStopBatch = () => batchRunner?.stop();

function setRateLimit(limit: number): void {
  if (batchIsBusy()) return;
  if (!EXECUTION_RATE_OPTIONS.some((option) => option.value === limit)) return;
  epochsPerSecondLimit = limit;
  pendingRateEvents.push({ requestedAt: Date.now(), limit });
  send({ t: 'rate', epochsPerSec: limit });
  publishControlDeck();
  persist();
}

/* ── soup view: expand, zoom, pan ────────────────────────────────────────── */

function syncSoupModePresentation(): void {
  const mode = display.getSnapshot().soup.mode;
  document.body.classList.toggle('soup-counts', mode === 'counts');
}

function setSoupMode(mode: SoupDisplayMode): void {
  display.setSoupMode(mode);
  syncSoupModePresentation();
}

/**
 * `next pair` draws one by the current method, and pick mode has no method —
 * the button is disabled there rather than left to do something the label does
 * not describe. Selecting pick keeps whatever is loaded; leaving it draws
 * afresh, as choosing any automatic method always has.
 */
function syncSampleModePresentation(v: SamplerSelectionMode): void {
  syncSoupModePresentation();
  document.body.classList.toggle('pick-mode', v === 'pick');
}

function setSampleMode(v: SamplerSelectionMode): void {
  display.setSelectionMode(v);
  syncSampleModePresentation(v);
}

function syncSamplerEnabledPresentation(on: boolean): void {
  document.body.classList.toggle('sampler-off', !on);
}

function setSampler(on: boolean): void {
  display.setSamplerEnabled(on);
  syncSamplerEnabledPresentation(on);
}

function modelChangeBlocked(): boolean {
  return (
    terminalFailure ||
    soupRunning ||
    batchIsBusy() ||
    pendingComputeSelection !== null ||
    recoverableRunFailure !== null
  );
}

function selectEngine(value: SoupConfig['engine']): void {
  if (modelChangeBlocked()) return;
  if (!isReactorEngine(value)) throw new Error(`unknown simulation engine ${JSON.stringify(value)}`);
  if (value === cfg.engine) return;
  activeComputePath = 'wasm';
  computeControlError = null;
  const profile = defaultConfigForEngine(value);
  Object.assign(cfg, profile);
  applyToControls(profile);
  setAutoWorkerLabel();
  syncExecutionControls();
  sendConfig({ ...cfg });
  clearHistory();
  persist();
}

function selectComputePath(value: ComputePath): void {
  if (soupRunning || batchIsBusy() || pendingComputeSelection) {
    publishControlDeck();
    return;
  }
  if (value !== 'wasm' && value !== 'webgpu') {
    publishControlDeck();
    return;
  }
  if (value === 'webgpu' && (cfg.engine !== 'cubff' || !webGpuAvailable)) {
    publishControlDeck();
    return;
  }
  if (value === activeComputePath) return;
  if (!recoverableRunFailure) computeControlError = null;
  const request = {
    computePath: value,
    runId: crypto.randomUUID(),
    revision: configRevision + 1,
  };
  pendingComputeSelection = request;
  setRunParameterLocks(true);
  const replacement = waitForRunReplacement(request.runId);
  const replacementSnapshot = waitForSnapshot(request.runId);
  void replacementSnapshot.catch(() => undefined);
  send({
    t: 'new-run',
    cfg: { ...cfg },
    computePath: request.computePath,
    retainCurrentOnFailure: true,
    revision: request.revision,
    runId: request.runId,
  });
  void replacement.then(
    async (computePath) => {
      if (pendingComputeSelection?.runId !== request.runId) return;
      activeComputePath = computePath;
      configRevision = request.revision;
      replaceManualRun('compute-path-change', request.runId);
      clearHistory();
      try {
        await replacementSnapshot;
        if (pendingComputeSelection?.runId !== request.runId) return;
        pendingComputeSelection = null;
        recoverableRunFailure = null;
        computeControlError = null;
        setRunParameterLocks(false);
      } catch (error) {
        if (pendingComputeSelection?.runId !== request.runId || terminalFailure) return;
        pendingComputeSelection = null;
        computeControlError = `Compute-path selection failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        computeControlErrorRevision++;
        setRunParameterLocks(false);
      }
    },
    (error: Error) => {
      if (pendingComputeSelection?.runId !== request.runId) return;
      pendingComputeSelection = null;
      computeControlError = `Compute-path selection failed: ${error.message}`;
      computeControlErrorRevision++;
      setRunParameterLocks(false);
    },
  );
}

function setTapeCount(value: number): void {
  if (modelChangeBlocked() || value === cfg.nTapes) return;
  if (!TAPE_COUNT_OPTIONS.some((option) => option.value === value)) return;
  setAutoWorkerLabel();
  cfg.nTapes = value;
  sendConfig({ nTapes: value });
  clearHistory();
  persist();
}

function setTapeLength(value: number): void {
  if (modelChangeBlocked() || value === cfg.tapeLen) return;
  if (!TAPE_LENGTH_OPTIONS.some((option) => option.value === value)) return;
  setAutoWorkerLabel();
  cfg.tapeLen = value;
  sendConfig({ tapeLen: value });
  clearHistory();
  persist();
}

function selectWorkers(value: string): void {
  if (value === 'not-used' || activeComputePath === 'webgpu') return;
  if (soupRunning || batchIsBusy() || pendingComputeSelection || recoverableRunFailure) return;
  if (value === cpuWorkerControlValue) return;
  if (!workerOptions(REPORTED_WORKERS, resolvedAutoWorkerCount).some(
    (option) => option.value === value,
  )) return;
  cpuWorkerControlValue = value;
  if (value === 'auto') setAutoWorkerLabel();
  const selection = workerSelectionFromControl();
  pendingWorkerEvents.push({ requestedAt: Date.now(), selection });
  send({ t: 'workers', selection });
  publishControlDeck();
  persist();
}

function setStepLimit(value: number): void {
  if (modelChangeBlocked() || value === cfg.maxSteps) return;
  if (!STEP_LIMIT_OPTIONS.some((option) => option.value === value)) return;
  setAutoWorkerLabel();
  cfg.maxSteps = value;
  sendConfig({ maxSteps: value });
  display.setSamplerConfiguration({
    maxSteps: cfg.maxSteps,
    headPolicy: cfg.headPolicy,
    noMatch: cfg.noMatch,
  });
  publishControlDeck();
  persist();
}

function setMutationRate(value: number): void {
  if (terminalFailure || batchIsBusy() || !Number.isFinite(value) || value < 0) return;
  cfg.mutationRate = value;
  sendConfig({ mutationRate: value });
  publishControlDeck();
}

/* ── documentation ───────────────────────────────────────────────────────── */

disposeHeaderView = mountApplicationHeader($('#headerRoot'), { version, help });
disposeHelpView = mountHelpWindow($('#helpRoot'), help, {
  resolveFocusFallback: () => $<HTMLButtonElement>('#btnHelp'),
});

/* Every Help trigger is React-owned and talks to this shared controller. */
help.onChange = () => {
  persist();
};
clearHelpChangeHandler = () => {
  help.onChange = null;
};
window.addEventListener('keydown', (ev) => {
  if (!applicationStarted) return;
  const target = ev.target;
  const interactive = target instanceof Element
    ? target.closest('input, select, textarea, button, a, [contenteditable="true"]')
    : null;
  if (interactive) {
    const acceptsText = interactive.matches('input, select, textarea, [contenteditable="true"]');
    // `?` remains a global manual shortcut from ordinary controls. Execution
    // shortcuts never act through a focused button/link, and text-entry
    // controls retain every key they receive.
    if (acceptsText || ev.key !== '?') return;
  }
  switch (ev.key) {
    case '?':
      help.toggle('fundamentals');
      break;
    case ' ':
      if (terminalFailure) break;
      ev.preventDefault();
      setRun(!soupRunning);
      break;
    case 's':
      if (!display.getSnapshot().sampler.enabled) break;
      display.stepSampler();
      break;
    case 'p':
      if (display.getSnapshot().sampler.enabled) display.nextPair();
      break;
    case 'r':
      if (display.getSnapshot().sampler.enabled) display.rewindSampler();
      break;
    default:
      break;
  }
});

/* ── bounded console fitting ─────────────────────────────────────────────────
   The instrument keeps one layout and scales uniformly when the viewport is
   only moderately smaller than that layout. At the scale floor it stops
   shrinking and #fitter scrolls, so text never becomes arbitrarily small. */

const consoleEl = $('#console');
const consoleStage = $('#consoleStage');
const fitterEl = $('#fitter');

function applyConsoleFit(): void {
  if (applicationDisposed) return;
  const style = getComputedStyle(consoleEl);
  const requiredWidth = Number.parseFloat(style.minWidth) || 1520;
  const requiredHeight = Number.parseFloat(style.minHeight) || 800;
  const fit = calculateConsoleFit(
    fitterEl.clientWidth,
    fitterEl.clientHeight,
    requiredWidth,
    requiredHeight,
  );

  // The stage stays at 100% when the scaled minimum fits. If the scale floor
  // is reached first, these minimums make #fitter expose the remaining area by
  // scrolling. Percentage console dimensions are the inverse transform, so
  // the visible console always exactly fills the stage.
  consoleStage.style.minWidth = `${requiredWidth * fit.scale}px`;
  consoleStage.style.minHeight = `${requiredHeight * fit.scale}px`;
  consoleEl.style.width = `${100 / fit.scale}%`;
  consoleEl.style.height = `${100 / fit.scale}%`;
  consoleEl.style.transform = `scale(${fit.scale})`;
  consoleStage.classList.add('fit-ready');
  display.invalidateSoup();
}

function queueConsoleFit(): void {
  if (applicationDisposed || consoleFitFrame !== null) return;
  consoleFitFrame = requestAnimationFrame(() => {
    consoleFitFrame = null;
    if (applicationDisposed) return;
    applyConsoleFit();
  });
}

window.addEventListener('resize', queueConsoleFit);

/**
 * Raise the width assumption if the content ever outgrows it.
 *
 * The readouts are not fixed-width: `2¹⁷` widens every count in soup state, and
 * the shard upgrade lands after startup. If any of that pushes past the stated
 * minimum, the excess would hang off the case with the page background behind
 * it. Widening the console instead keeps everything on the instrument and costs
 * only a little more scroll.
 *
 * `scrollWidth` and `clientWidth` are logical, untransformed dimensions, so the
 * comparison remains exact while the fitted console is visually scaled.
 */
let outgrownAt = -Infinity;
function refitIfOutgrown(force = false): void {
  const now = performance.now();
  if (!force && now - outgrownAt < 400) return;
  outgrownAt = now;
  const need = consoleEl.scrollWidth;
  if (need <= consoleEl.clientWidth + 1) return;
  consoleEl.style.minWidth = `${need}px`;
  applyConsoleFit();
}

/* ── stored panel settings ───────────────────────────────────────────────── */

/** Writes the whole set, so every call site only has to say "something changed". */
function persist(): void {
  const presentation = display.getSnapshot();
  savePrefs({
    mode: presentation.soup.mode,
    sample: presentation.sampler.selectionMode,
    rxrate: String(presentation.sampler.speed),
    sampler: presentation.sampler.enabled,
    help: help.isOpen,
    helpTopic: help.topic,
    helpBox: help.box,
  });
}

function soupModePreference(value: unknown): SoupDisplayMode | null {
  if (typeof value !== 'string') return null;
  return SOUP_VIEW_OPTIONS.some((option) => option.value === value)
    ? value as SoupDisplayMode
    : null;
}

function samplerSelectionPreference(value: unknown): SamplerSelectionMode | null {
  if (typeof value !== 'string') return null;
  return SAMPLE_MODE_OPTIONS.some((option) => option.value === value)
    ? value as SamplerSelectionMode
    : null;
}

function samplerSpeedPreference(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const speed = Number(value);
  return SAMPLER_RATE_OPTIONS.some((option) => option.value === speed) ? speed : null;
}

/** Restore presentation state only; run parameters always retain their defaults. */
function applyPrefs(): void {
  const p = loadPrefs();

  const mode = soupModePreference(p.mode);
  if (mode) setSoupMode(mode);
  // No population has arrived yet; the first accepted snapshot supplies the
  // sampler pair and marks the selected Soup view dirty.
  const sample = samplerSelectionPreference(p.sample);
  if (sample) setSampleMode(sample);
  const speed = samplerSpeedPreference(p.rxrate);
  if (speed !== null) display.setSamplerSpeed(speed);

  if (typeof p.sampler === 'boolean') setSampler(p.sampler);

  // size and position first, so the window does not appear at the default
  // placement and then jump to the stored one
  help.place(p.helpBox);
  if (p.help) {
    help.open(typeof p.helpTopic === 'string' ? p.helpTopic : 'fundamentals');
    // Stored preferences are untrusted and may name a topic removed by a later
    // release. An open manual always has a valid, useful initial topic.
    if (!help.isOpen) help.open('fundamentals');
  }
}

/* ── boot ────────────────────────────────────────────────────────────────── */

/*
 * Defaults have exactly one source per engine: ENGINE_DEFAULT_CONFIGS, exposed
 * here through DEFAULT_CONFIG for the initial engine and
 * defaultConfigForEngine for an explicitly selected engine.
 *
 * The React controls are a projection of this configuration, never a second
 * source read back into the runtime. Stored preferences affect presentation
 * only.
 */
function applyToControls(c: SoupConfig): void {
  if (!ENGINE_OPTIONS.some((option) => option.value === c.engine)) {
    throw new Error(`the control deck cannot represent engine ${JSON.stringify(c.engine)}`);
  }
  if (!TAPE_COUNT_OPTIONS.some((option) => option.value === c.nTapes)) {
    throw new Error(`the control deck cannot represent ${c.nTapes} tapes`);
  }
  if (!TAPE_LENGTH_OPTIONS.some((option) => option.value === c.tapeLen)) {
    throw new Error(`the control deck cannot represent tape length ${c.tapeLen}`);
  }
  if (!STEP_LIMIT_OPTIONS.some((option) => option.value === c.maxSteps)) {
    throw new Error(`the control deck cannot represent step limit ${c.maxSteps}`);
  }
  Object.assign(cfg, c);
  display.setSamplerConfiguration({
    maxSteps: c.maxSteps,
    headPolicy: c.headPolicy,
    noMatch: c.noMatch,
  });
  publishControlDeck();
}

/** Put every soup parameter back to the selected engine's documented profile. */
function resetToDefaults(): void {
  if (recoverableRunFailure || batchIsBusy()) return;
  const wasRunning = soupRunning;
  const workersWereAuto = cpuWorkerControlValue === 'auto';
  const profile = defaultConfigForEngine(cfg.engine);
  const shapeChanged =
    cfg.nTapes !== profile.nTapes || cfg.tapeLen !== profile.tapeLen;
  const seedChanged = cfg.seed !== profile.seed;

  setRun(false);
  activeComputePath = 'wasm';
  computeControlError = null;
  Object.assign(cfg, profile);
  applyToControls(profile);
  setAutoWorkerLabel();
  cpuWorkerControlValue = 'auto';
  syncExecutionControls();
  epochsPerSecondLimit = 0;
  send({ t: 'rate', epochsPerSec: 0 });

  replaceManualRun(
    shapeChanged ? 'shape-change' : seedChanged ? 'seed-change' : 'restart',
  );
  configRevision++;
  clearHistory();
  send({
    t: 'new-run',
    cfg: { ...cfg },
    computePath: activeComputePath,
    retainCurrentOnFailure: false,
    revision: configRevision,
    runId: activeRunId,
  });

  // A manual pool needs this explicit switch after the new soup has been
  // installed. An automatic pool already retains its resolved static count.
  if (!workersWereAuto) send({ t: 'workers', selection: workerSelectionFromControl() });
  persist();
  if (wasRunning) setRun(true);
}

applyToControls(DEFAULT_CONFIG);
applyPrefs();
applyConsoleFit();

function startApplication(): void {
  if (applicationStarted || applicationDisposed) return;
  applicationStarted = true;

  startRecordsRepository();
  startCoordinator();
  prepareManualRun();
  send({
    t: 'init',
    cfg,
    computePath: activeComputePath,
    workers: workerSelectionFromControl(),
    revision: configRevision,
    runId: activeRunId,
  });
  send({ t: 'rate', epochsPerSec: epochsPerSecondLimit });

  flushSync(() => {
    applicationFrameStore.publish(Object.freeze({
      started: true,
      fatalMessage: applicationFrameStore.getSnapshot().fatalMessage,
    }));
  });
  const focusTarget = help.isOpen
    ? $<HTMLButtonElement>('#helpClose')
    : terminalFailure
      ? $<HTMLButtonElement>('#btnHelp')
      : $<HTMLButtonElement>('#swRun');
  focusTarget.focus({ preventScroll: true });

  void waitForUiFonts()
    .catch((error: unknown) => {
      console.warn('[font] Geist Mono unavailable; using the monospace fallback.', error);
    })
    .finally(() => {
      if (applicationDisposed) return;
      refitIfOutgrown(true);
      applyConsoleFit();
      display.start();
    });
}

disposeStartView = mountStartWindow($('#startRoot'), {
  version,
  onStart: startApplication,
});

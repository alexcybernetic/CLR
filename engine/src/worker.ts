/// <reference lib="webworker" />
import { normalizeWorkerSelection } from './protocol.ts';
import type {
  ComputePath,
  FromWorker,
  MeasurementPopulation,
  ToWorker,
  WorkerSelection,
} from './protocol.ts';
import { emptyCumulative, type RunCumulative } from './statistics.ts';
import {
  type EpochStats,
  type Metrics,
  type SoupConfig,
} from './soup.ts';
import { ParallelSoup } from './parallelSoup.ts';
import {
  chooseEpochBatchSize,
  supportsEpochBatch,
  type SoupExecution,
} from './execution.ts';
import {
  GpuBench,
  isProductionWebGpuAdapter,
  type GpuAdapterProbe,
} from './webgpu/gpu.ts';
import { WebGpuCuBffSoup } from './webgpu/webGpuCuBffSoup.ts';
import { verifyReplication } from './replication.ts';
import { measureOrder } from './order.ts';
import { SerialQueue } from './serialQueue.ts';

/**
 * One selected native engine compiled to Wasm, sharded across workers.
 *
 * There is no fallback. A slower substitute that computes a different soup is
 * worse than nothing here — it would be indistinguishable from the real thing
 * on screen while quietly answering a different question.
 */
let soup: SoupExecution | null = null;
let workerSelection: WorkerSelection = { mode: 'fixed', count: 1 };
let gpuContext: GpuBench | null = null;
let gpuProbe: Promise<GpuAdapterProbe | null> | null = null;
let activeGpuGeneration = 0;
let activeRunGeneration = 0;
/** Latest UI configuration revision fully applied to the active soup. */
let configRevision = 0;
/** Identity of the deterministic trajectory currently held by the coordinator. */
let runId = '';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let running = false;
let pending = 0;
let rate = 0; // epochs/sec, 0 = unthrottled
let explicitMeasurements = false;
let orderBusy = false;
interface PendingOrderMeasurement {
  epoch: number;
  soup: Uint8Array;
  h0: number;
  byteOrder: number;
  configRevision: number;
  generation: number;
  forced: boolean;
  population: MeasurementPopulation;
  epochStats: EpochStats;
  cumulative: RunCumulative;
  populationFingerprint: string;
  runId: string;
}
let pendingOrderMeasurement: PendingOrderMeasurement | null = null;
let metricsAt = 0;
let postAt = 0;

let lastStats: EpochStats = {
  execs: 0,
  steps: 0,
  meanSteps: 0,
  halts: [0, 0, 0, 0, 0],
  ms: 0,
};
let lastMetrics: Metrics = {
  entropy: 0,
  distinctBytes: 0,
  uniqueTapes: 0,
  largestLineage: 0,
  motifs: [],
  motifTotal: 0,
  tapeFrequencies: [],
  populationFingerprint: '00000000',
};
let cumulative = emptyCumulative();

function cloneCumulative(value: RunCumulative): RunCumulative {
  return { ...value, halts: value.halts.slice() };
}

function measurementPopulation(metrics: Metrics): MeasurementPopulation {
  return {
    distinctBytes: metrics.distinctBytes,
    distinctTapes: metrics.uniqueTapes,
    largestIdenticalGroup: metrics.largestLineage,
    motifWindowCount: metrics.motifTotal,
    motifs: metrics.motifs.map((motif) => ({
      ...motif,
      bytes: motif.bytes.slice(),
    })),
  };
}

/**
 * Building an execution implementation is asynchronous, so commands are
 * queued behind it rather than racing it. CPU/Wasm and coordinator failures
 * remain fatal; an active WebGPU failure retires only that run and leaves the
 * queue available for an explicit CPU replacement.
 */
function requireProductionGpuProbe(
  probe: GpuAdapterProbe | null,
): asserts probe is GpuAdapterProbe {
  if (!probe) throw new Error('WebGPU is unavailable in this worker');
  if (!isProductionWebGpuAdapter(probe.info)) {
    throw new Error('the browser selected a fallback WebGPU adapter');
  }
}

async function ensureGpuContext(): Promise<GpuBench> {
  if (gpuContext) return gpuContext;
  const pendingProbe = gpuProbe ?? GpuBench.probe('high-performance');
  gpuProbe = pendingProbe;
  const probe = await pendingProbe;
  requireProductionGpuProbe(probe);
  let context: GpuBench;
  try {
    context = await GpuBench.fromProbe(probe);
  } catch (error) {
    // A consumed or failed adapter is not reusable. A later explicit retry may
    // request a fresh browser-selected adapter.
    if (gpuProbe === pendingProbe) gpuProbe = null;
    throw error;
  }
  gpuContext = context;
  const generation = ++activeGpuGeneration;
  void context.device.lost.then((info) => {
    queueGpuFailure(
      generation,
      new Error(`WebGPU device lost: ${info.message || info.reason || 'unknown reason'}`),
    );
  });
  context.device.onuncapturederror = (event) => {
    queueGpuFailure(
      generation,
      new Error(`WebGPU error: ${event.error.message || 'uncaptured GPU error'}`),
    );
  };
  return context;
}

async function reportGpuCapability(): Promise<void> {
  try {
    gpuProbe ??= GpuBench.probe('high-performance');
    const probe = await gpuProbe;
    requireProductionGpuProbe(probe);
    post({
      t: 'capabilities',
      webgpu: { available: true, adapter: { ...probe.info }, reason: null },
    });
  } catch (error) {
    post({
      t: 'capabilities',
      webgpu: {
        available: false,
        adapter: null,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function build(
  cfg: SoupConfig,
  selection: WorkerSelection,
  computePath: ComputePath,
): Promise<void> {
  const normalized = normalizeWorkerSelection(selection);
  const previous = soup;
  const next: SoupExecution =
    computePath === 'webgpu'
      ? await WebGpuCuBffSoup.create(await ensureGpuContext(), cfg)
      : await ParallelSoup.create(cfg, normalized.count);
  try {
    await next.readPopulation();
    const metrics = next.computeMetrics();
    verifyReplication(metrics, next.cfg, next.data, next.epoch);
    soup = next;
    workerSelection = normalized;
    lastMetrics = metrics;
    try {
      previous?.dispose();
    } catch {
      // The verified replacement is already authoritative. Failure to clean
      // an obsolete implementation must not dispose or reject the new run.
    }
  } catch (error) {
    next.dispose();
    throw error;
  }
}

let fatalReported = false;

function reportFatal(error: unknown): void {
  if (fatalReported) return;
  fatalReported = true;
  running = false;
  pending = 0;
  resetThroughput();
  soup?.dispose();
  soup = null;
  if (gpuContext) invalidateGpuContext(activeGpuGeneration);
  post({ t: 'fatal', message: error instanceof Error ? error.message : String(error) });
}

/** Soup reads and writes share one chain; no command can overlap an epoch. */
const serialQueue = new SerialQueue(reportFatal, 'simulation coordinator is unavailable');

interface ActiveGpuScope {
  contextGeneration: number;
  runGeneration: number;
  runId: string;
}

class ActiveGpuOperationError extends Error {
  readonly failure: unknown;
  readonly scope: ActiveGpuScope;

  constructor(failure: unknown, scope: ActiveGpuScope) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = 'ActiveGpuOperationError';
    this.failure = failure;
    this.scope = scope;
  }
}

function captureActiveGpuScope(contextGeneration = activeGpuGeneration): ActiveGpuScope | null {
  if (
    contextGeneration !== activeGpuGeneration ||
    !gpuContext ||
    soup?.computePath !== 'webgpu'
  ) {
    return null;
  }
  return {
    contextGeneration,
    runGeneration: activeRunGeneration,
    runId,
  };
}

function isActiveGpuScope(scope: ActiveGpuScope): boolean {
  return (
    scope.contextGeneration === activeGpuGeneration &&
    scope.runGeneration === activeRunGeneration &&
    scope.runId === runId &&
    soup?.computePath === 'webgpu'
  );
}

async function runExecutionOperation<T>(
  active: SoupExecution,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (active.computePath !== 'webgpu') return operation();
  const scope = captureActiveGpuScope();
  if (!scope) throw new Error('the active WebGPU run has no valid device context');
  try {
    return await operation();
  } catch (error) {
    throw new ActiveGpuOperationError(error, scope);
  }
}

function invalidateGpuContext(contextGeneration: number): boolean {
  if (contextGeneration !== activeGpuGeneration) return false;
  activeGpuGeneration++;
  const invalid = gpuContext;
  if (invalid) invalid.device.onuncapturederror = null;
  gpuContext = null;
  gpuProbe = null;
  try {
    invalid?.destroy();
  } catch {
    // The context is already invalid; disposal cannot replace its run error.
  }
  return true;
}

/**
 * Retire the failed run and its device context without sealing the coordinator.
 * This function only runs inside serialQueue, after every earlier GPU command
 * has settled, so disposal cannot race an epoch or population readback.
 */
function recoverActiveGpuFailure(error: unknown, scope: ActiveGpuScope): boolean {
  if (!isActiveGpuScope(scope)) return false;

  const failedSoup = soup;
  running = false;
  pending = 0;
  orderGen++;
  pendingOrderMeasurement = null;
  orderBusy = false;
  orderAt = 0;
  resetThroughput();

  // Invalidate callbacks before disposing buffers. A loss and a rejected map
  // commonly report the same device failure through two independent channels.
  activeRunGeneration++;
  invalidateGpuContext(scope.contextGeneration);
  soup = null;
  try {
    failedSoup?.dispose();
  } catch {
    // The run is already invalid. Preserve the original GPU error reported to
    // the operator rather than replacing it with a secondary cleanup failure.
  }

  post({
    t: 'run-failed',
    runId: scope.runId,
    computePath: 'webgpu',
    message: error instanceof Error ? error.message : String(error),
  });
  return true;
}

/** Device events are converted into ordinary ordered coordinator work. */
function queueGpuFailure(contextGeneration: number, error: Error): void {
  const scope = captureActiveGpuScope(contextGeneration);
  serialQueue.enqueue(() => {
    if (scope && recoverActiveGpuFailure(error, scope)) return;
    // The event belongs to the run which was active when the browser delivered
    // it. If a replacement GPU run has since become active on the retained
    // context, this stale callback cannot be reassigned to that trajectory. A
    // genuinely lost device will reject the replacement's own scoped command.
    if (!captureActiveGpuScope(contextGeneration)) {
      invalidateGpuContext(contextGeneration);
    }
  });
}

// rolling throughput over the post interval
let winEpochs = 0;
let winSteps = 0;
let winStart = performance.now();
let epochsPerSec = 0;
let stepsPerSec = 0;

/** A published rate and its accumulation window always describe the same run. */
function resetThroughput(): void {
  winEpochs = 0;
  winSteps = 0;
  winStart = performance.now();
  epochsPerSec = 0;
  stepsPerSec = 0;
}

function activateRun(nextRunId: string): void {
  runId = nextRunId;
  activeRunGeneration++;
}

/** setTimeout(0) gets clamped to ~4ms once nested; MessageChannel does not. */
const yieldNow = (() => {
  const ch = new MessageChannel();
  let waiting: (() => void) | null = null;
  ch.port1.onmessage = () => {
    const w = waiting;
    waiting = null;
    w?.();
  };
  ch.port1.start();
  return () =>
    new Promise<void>((res) => {
      waiting = res;
      ch.port2.postMessage(0);
    });
})();

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function post(msg: FromWorker, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

async function postSnapshot(refresh = true): Promise<void> {
  const active = soup;
  if (!active) return;
  if (refresh) await runExecutionOperation(active, () => active.readPopulation());
  const now = performance.now();
  const dt = now - winStart;
  if (dt > 250) {
    epochsPerSec = (winEpochs * 1000) / dt;
    stepsPerSec = (winSteps * 1000) / dt;
    winEpochs = 0;
    winSteps = 0;
    winStart = now;
  }

  const copy = active.data.slice();
  post(
    {
      t: 'snapshot',
      runId,
      epoch: active.epoch,
      soup: copy.buffer,
      config: { ...active.cfg },
      configRevision,
      nTapes: active.cfg.nTapes,
      tapeLen: active.cfg.tapeLen,
      stats: lastStats,
      metrics: lastMetrics,
      running,
      epochsPerSec,
      stepsPerSec,
      core: active.coreDescription,
      computePath: active.computePath,
      gpuAdapter: active.gpuAdapter ? { ...active.gpuAdapter } : null,
      workerMode: workerSelection.mode,
      workerCount: active.workerCount,
      epochsPerSecondLimit: rate,
      cumulative: cloneCumulative(cumulative),
    },
    [copy.buffer],
  );
}

/**
 * high-order entropy = H0 - bpb
 *
 * H0 is the entropy of the byte histogram alone, which sees no structure beyond
 * single-byte frequency. bpb is what a real compressor achieves, which does see
 * repeated sequences. Their gap is a compressor-dependent estimate of repeated
 * structure above the single-byte level. It is near zero for white noise and
 * rises when multi-byte patterns become common.
 */
let orderAt = 0;
/**
 * Bumped whenever the soup is replaced. Compression is async, so a measurement
 * started before a restart can resolve after it — and that one stale point,
 * carrying the old epoch and old value, lands on a freshly cleared chart and
 * drags its axes back to the previous run.
 */
let orderGen = 0;

function retainOrderMeasurement(force: boolean): void {
  if (!soup) return;
  const h0 = lastMetrics.entropy;
  const byteOrder = 8 - h0;
  const retained = pendingOrderMeasurement;

  // Compression can take longer than the interval between population metrics,
  // particularly in Firefox. Keep the strongest intermediate population
  // instead of replacing it with the later, possibly post-transition state.
  if (
    !force &&
    retained?.generation === orderGen &&
    (retained.forced || retained.byteOrder >= byteOrder)
  ) {
    return;
  }

  pendingOrderMeasurement = {
    epoch: soup.epoch,
    soup: soup.data.slice(),
    h0,
    byteOrder,
    configRevision,
    generation: orderGen,
    forced: force,
    population: measurementPopulation(lastMetrics),
    epochStats: { ...lastStats, halts: lastStats.halts.slice() },
    cumulative: cloneCumulative(cumulative),
    populationFingerprint: lastMetrics.populationFingerprint,
    runId,
  };
}

function finishOrderMeasurement(generation: number): void {
  orderBusy = false;
  // A replacement population should be measured immediately; the interval
  // timestamp belonged to the discarded generation.
  if (generation !== orderGen) orderAt = 0;
  maybeMeasureOrder();
}

function maybeMeasureOrder(force = false): void {
  // Time-gated, not epoch-gated: with metrics throttled by soup size, an
  // "every Nth epoch" test can miss forever at large sizes. The try/finally
  // matters just as much — if the measurement throws, a stuck busy flag would
  // silently stop the order parameter for the rest of the run.
  if (!soup || explicitMeasurements) return;
  retainOrderMeasurement(force);
  if (orderBusy) return;

  const measurement = pendingOrderMeasurement;
  if (!measurement) return;
  const now = performance.now();
  // Complete-population compression matches the documented measurement but is
  // intentionally slower than the former sample. Scale the interval with bytes
  // to bound its cost.
  const interval = Math.max(400, soup.data.length / 6000);
  if (!measurement.forced && now - orderAt < interval) return;
  pendingOrderMeasurement = null;
  orderAt = now;
  orderBusy = true;
  try {
    void measureOrder(measurement.soup, measurement.h0)
      .then((result) => {
        if (measurement.generation !== orderGen) return;
        post({
          t: 'order',
          runId: measurement.runId,
          epoch: measurement.epoch,
          configRevision: measurement.configRevision,
          ...result,
          population: measurement.population,
          epochStats: measurement.epochStats,
          cumulative: measurement.cumulative,
          populationFingerprint: measurement.populationFingerprint,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        finishOrderMeasurement(measurement.generation);
      });
  } catch {
    finishOrderMeasurement(measurement.generation);
  }
}

async function postExactMeasurement(requestId: string): Promise<void> {
  const active = soup;
  if (!active) return;
  await runExecutionOperation(active, () => active.readPopulation());
  lastMetrics = active.computeMetrics();
  verifyReplication(lastMetrics, active.cfg, active.data, active.epoch);
  const measurementRunId = runId;
  const measurementRevision = configRevision;
  const measurementEpoch = active.epoch;
  const h0 = lastMetrics.entropy;
  const population = measurementPopulation(lastMetrics);
  const epochStats = { ...lastStats, halts: lastStats.halts.slice() };
  const measuredCumulative = cloneCumulative(cumulative);
  const populationFingerprint = lastMetrics.populationFingerprint;
  const result = await measureOrder(active.data.slice(), h0);
  // The command queue is serialized, but retain the identity check explicitly:
  // it protects this invariant if compression later moves off the queue.
  if (measurementRunId !== runId || measurementRevision !== configRevision) return;
  post({
    t: 'measurement',
    requestId,
    runId: measurementRunId,
    epoch: measurementEpoch,
    configRevision: measurementRevision,
    ...result,
    population,
    epochStats,
    cumulative: measuredCumulative,
    populationFingerprint,
  });
}

function retainEpochStats(stats: EpochStats): void {
  lastStats = stats;
  cumulative.epochs++;
  cumulative.interactions += stats.execs;
  cumulative.steps += stats.steps;
  cumulative.computeMs += stats.ms;
  for (let halt = 0; halt < stats.halts.length; halt++) {
    cumulative.halts[halt] = (cumulative.halts[halt] ?? 0) + (stats.halts[halt] ?? 0);
  }
  winEpochs++;
  winSteps += stats.steps;
  if (pending > 0) pending--;
}

function requestedEpochBatch(active: SoupExecution): number {
  if (rate !== 0 || !supportsEpochBatch(active)) return 1;
  const available = running ? active.maxEpochBatch : Math.min(pending, active.maxEpochBatch);
  return chooseEpochBatchSize(active.maxEpochBatch, available, lastStats.ms);
}

async function loop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (serialQueue.sealed) return;
    if (!soup || (!running && pending <= 0)) {
      await sleep(40);
      continue;
    }

    const t0 = performance.now();
    let batched = 0;

    do {
      let stats: EpochStats[] | null;
      try {
        const result = await serialQueue.run(async () => {
          const active = soup;
          if (!active) return { stats: null };
          // A stop or reset may already be queued ahead of this epoch. Recheck
          // inside the serialized job so a stale loop decision cannot run one
          // extra epoch after that command takes effect.
          if (!running && pending <= 0) return { stats: null };
          try {
            const count = requestedEpochBatch(active);
            const stats = await runExecutionOperation(active, () =>
              supportsEpochBatch(active)
                ? active.runEpochBatch(count)
                : active.runEpoch().then((epoch) => [epoch]),
            );
            for (const epoch of stats) retainEpochStats(epoch);
            return { stats };
          } catch (error) {
            if (
              error instanceof ActiveGpuOperationError &&
              recoverActiveGpuFailure(error.failure, error.scope)
            ) {
              return { stats: null };
            }
            throw error;
          }
        });
        stats = result.stats;
      } catch {
        return; // serialize already published the terminal failure
      }
      if (!stats || stats.length === 0) break;
      batched += stats.length;
      // Early epochs cost almost nothing, so batch until we owe a frame.
    } while (
      rate === 0 &&
      (running || pending > 0) &&
      performance.now() - t0 < 33 &&
      batched < 512
    );

    let telemetryCompleted: boolean;
    try {
      telemetryCompleted = await serialQueue.run(async () => {
        const active = soup;
        if (!active) return false;
        try {
          // Metrics walk the complete soup and snapshots copy it. Keep both on
          // the same serialized ownership chain as epochs and commands.
          const now = performance.now();
          const metricsEvery = Math.max(120, active.data.length / 20000);
          const metricsDue = now - metricsAt > metricsEvery || !running;
          const postEvery = Math.max(45, active.data.length / 6000);
          const postDue = now - postAt > postEvery || !running;
          if (metricsDue || postDue) {
            try {
              await runExecutionOperation(active, () => active.readPopulation());
            } catch (error) {
              if (
                error instanceof ActiveGpuOperationError &&
                recoverActiveGpuFailure(error.failure, error.scope)
              ) {
                return false;
              }
              throw error;
            }
          }
          if (metricsDue) {
            metricsAt = now;
            lastMetrics = active.computeMetrics();
            verifyReplication(lastMetrics, active.cfg, active.data, active.epoch);
            maybeMeasureOrder();
          }
          if (postDue) {
            postAt = now;
            await postSnapshot(false);
          }

          if (!running && pending <= 0) {
            // finished an explicit step-n request
            post({ t: 'ready', runId, epoch: active.epoch });
          }
          return true;
        } catch (error) {
          throw error;
        }
      });
    } catch {
      return; // a CPU/Wasm or coordinator failure remains terminal
    }
    if (!telemetryCompleted) {
      await yieldNow();
      continue;
    }

    if (rate > 0) {
      const budget = 1000 / rate;
      const spent = performance.now() - t0;
      await sleep(Math.max(0, budget - spent));
    } else {
      await yieldNow();
    }
  }
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  if (serialQueue.sealed) return;
  const m = ev.data;
  serialQueue.enqueue(async () => {
    try {
      await processMessage(m);
    } catch (error) {
      if (
        error instanceof ActiveGpuOperationError &&
        recoverActiveGpuFailure(error.failure, error.scope)
      ) {
        return;
      }
      // Invalid protocol data, metrics/verification failures and every
      // CPU/Wasm failure retain the queue's fail-closed semantics.
      throw error;
    }
  });
};

function newRunReplacesAllocation(
  current: SoupExecution,
  m: Extract<ToWorker, { t: 'new-run' }>,
): boolean {
  return (
    m.cfg.engine !== current.cfg.engine ||
    m.computePath !== current.computePath ||
    m.cfg.nTapes !== current.cfg.nTapes ||
    m.cfg.tapeLen !== current.cfg.tapeLen
  );
}

async function processMessage(m: ToWorker): Promise<void> {
  if (m.t === 'init') {
    orderGen++;
    pendingOrderMeasurement = null;
    await build(m.cfg, m.workers, m.computePath);
    activateRun(m.runId);
    cumulative = emptyCumulative();
    lastStats = { execs: 0, steps: 0, meanSteps: 0, halts: [0, 0, 0, 0, 0], ms: 0 };
    configRevision = m.revision;
    orderBusy = false;
    orderAt = 0;
    resetThroughput();
    await postSnapshot(false);
    maybeMeasureOrder(true);
    return;
  }

  const current = soup;
  if (m.t === 'new-run') {
    // A replacement allocation is transactional: failure leaves the current
    // run intact. Prospective WebGPU allocation failures are run-local even
    // between batch items; they must not seal the CPU-capable coordinator.
    // Reinitializing the current GPU allocation is destructive and therefore
    // becomes a run failure if the operation itself fails.
    const replacesAllocation = current ? newRunReplacesAllocation(current, m) : false;
    const rejectProspectiveFailure =
      current && replacesAllocation && (m.retainCurrentOnFailure || m.computePath === 'webgpu');
    if (rejectProspectiveFailure) {
      try {
        await handleNewRun(m, current);
      } catch (error) {
        post({
          t: 'run-rejected',
          runId: m.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      await handleNewRun(m, current);
    }
    return;
  }

  // After a recoverable GPU failure, rate and measurement policy remain valid
  // coordinator state and must be ready for the explicit replacement run.
  if (!current) {
    if (m.t === 'rate') {
      rate = m.epochsPerSec;
      resetThroughput();
    } else if (m.t === 'measurement-mode') {
      explicitMeasurements = m.explicit;
    }
    return;
  }

  if (m.t === 'workers') {
    // the pool changes; the soup and the epoch counter do not
    workerSelection = normalizeWorkerSelection(m.selection);
    if (current instanceof ParallelSoup) {
      await current.setShards(workerSelection.count);
    }
    // Pool replacement pauses dispatch, so the previous throughput window is
    // no longer a continuous measurement.
    resetThroughput();
    await postSnapshot();
    return;
  }

  await handle(m, current);
}

async function handle(
  m: Exclude<ToWorker, { t: 'init' } | { t: 'workers' } | { t: 'new-run' }>,
  current: SoupExecution,
): Promise<void> {
  switch (m.t) {
    case 'config': {
      const next = { ...current.cfg, ...m.patch };
      const engineChanged = next.engine !== current.cfg.engine;
      const computePathChanged = m.computePath !== current.computePath;
      const changed =
        engineChanged ||
        computePathChanged ||
        next.nTapes !== current.cfg.nTapes ||
        next.tapeLen !== current.cfg.tapeLen ||
        next.maxSteps !== current.cfg.maxSteps ||
        next.mutationRate !== current.cfg.mutationRate ||
        next.headPolicy !== current.cfg.headPolicy ||
        next.noMatch !== current.cfg.noMatch ||
        next.seed !== current.cfg.seed;
      const rebuilt =
        engineChanged ||
        computePathChanged ||
        next.nTapes !== current.cfg.nTapes ||
        next.tapeLen !== current.cfg.tapeLen;
      const gpuShapeChanged =
        current.computePath === 'webgpu' &&
        (next.nTapes !== current.cfg.nTapes || next.tapeLen !== current.cfg.tapeLen);
      const builtReplacement = engineChanged || computePathChanged || gpuShapeChanged;
      if (builtReplacement) {
        await build(next, workerSelection, m.computePath);
      } else {
        await runExecutionOperation(current, () => current.reshape(next));
      }
      const active = soup;
      if (!active) throw new Error('simulation coordinator is unavailable after configuration');
      if (rebuilt) {
        activateRun(m.runId);
        cumulative = emptyCumulative();
        lastStats = { execs: 0, steps: 0, meanSteps: 0, halts: [0, 0, 0, 0, 0], ms: 0 };
        orderGen++;
        pendingOrderMeasurement = null;
        orderAt = 0;
      } else if (m.runId !== runId) {
        throw new Error(`configuration command belongs to inactive run ${m.runId}`);
      }
      if (rebuilt && !builtReplacement) {
        // ParallelSoup can reshape its Wasm allocation in place. That creates
        // a new population, so refresh its metrics before publishing it.
        await active.readPopulation();
        lastMetrics = active.computeMetrics();
        verifyReplication(lastMetrics, active.cfg, active.data, active.epoch);
      }
      // A built replacement was already read and verified transactionally by
      // build(). Configuration-only changes do not mutate the population, so
      // a live mutation-rate change needs no GPU readback here.
      configRevision = m.revision;
      post({ t: 'config-applied', runId, configRevision, epoch: active.epoch });
      if (changed) resetThroughput();
      if (!running) await postSnapshot(false);
      if (rebuilt) maybeMeasureOrder(true);
      break;
    }
    case 'run': {
      const changed = running !== m.on;
      running = m.on;
      if (changed) {
        resetThroughput();
        // In particular, a stopped machine must not retain its last measured
        // rate until some later command happens to request another snapshot.
        await postSnapshot();
      }
      break;
    }
    case 'epoch':
      if (!Number.isInteger(m.n) || m.n < 1) throw new Error('invalid explicit epoch count');
      pending += m.n;
      break;
    case 'cancel-pending':
      running = false;
      pending = 0;
      await runExecutionOperation(current, () => current.readPopulation());
      lastMetrics = current.computeMetrics();
      verifyReplication(lastMetrics, current.cfg, current.data, current.epoch);
      resetThroughput();
      await postSnapshot(false);
      post({ t: 'ready', runId, epoch: current.epoch });
      break;
    case 'measurement-mode':
      explicitMeasurements = m.explicit;
      if (!explicitMeasurements) maybeMeasureOrder(true);
      break;
    case 'checkpoint':
      await postExactMeasurement(m.requestId);
      break;
    case 'reset':
      orderGen++;
      pendingOrderMeasurement = null;
      orderAt = 0;
      current.cfg.seed = m.seed;
      activateRun(m.runId);
      await runExecutionOperation(current, () => current.randomize());
      cumulative = emptyCumulative();
      configRevision = m.revision;
      lastStats = { execs: 0, steps: 0, meanSteps: 0, halts: [0, 0, 0, 0, 0], ms: 0 };
      await runExecutionOperation(current, () => current.readPopulation());
      lastMetrics = current.computeMetrics();
      verifyReplication(lastMetrics, current.cfg, current.data, current.epoch);
      running = false;
      pending = 0;
      resetThroughput();
      await postSnapshot(false);
      maybeMeasureOrder(true);
      break;
    case 'rate': {
      const changed = rate !== m.epochsPerSec;
      rate = m.epochsPerSec;
      if (changed) {
        resetThroughput();
        await postSnapshot();
      }
      break;
    }
  }
}

async function handleNewRun(
  m: Extract<ToWorker, { t: 'new-run' }>,
  current: SoupExecution | null,
): Promise<void> {
  const engineChanged = current ? m.cfg.engine !== current.cfg.engine : true;
  const computePathChanged = current ? m.computePath !== current.computePath : true;
  const shapeChanged = current
    ? m.cfg.nTapes !== current.cfg.nTapes || m.cfg.tapeLen !== current.cfg.tapeLen
    : true;
  const replaced = !current || engineChanged || computePathChanged || shapeChanged;

  if (replaced) {
    await build(m.cfg, workerSelection, m.computePath);
  } else {
    // The existing allocation ceases to contain the previous trajectory as
    // soon as reinitialization begins. Scope any failure to the requested run.
    activateRun(m.runId);
    await runExecutionOperation(current, () => current.reshape(m.cfg));
    // reshape initializes a changed shape. Otherwise explicitly initialize the
    // existing allocation so every new trajectory starts from its seed.
    await runExecutionOperation(current, () => current.randomize());
  }

  const active = soup;
  if (!active) throw new Error('simulation coordinator is unavailable after new run');
  if (replaced) activateRun(m.runId);
  configRevision = m.revision;
  orderGen++;
  pendingOrderMeasurement = null;
  orderAt = 0;
  running = false;
  pending = 0;
  cumulative = emptyCumulative();
  lastStats = { execs: 0, steps: 0, meanSteps: 0, halts: [0, 0, 0, 0, 0], ms: 0 };
  // build() completed readback and verification before publishing the new
  // implementation. Avoid a second fallible GPU operation after the old
  // implementation has been disposed: prospective replacement is thereby
  // genuinely transactional.
  if (!replaced) {
    await runExecutionOperation(active, () => active.readPopulation());
    lastMetrics = active.computeMetrics();
    verifyReplication(lastMetrics, active.cfg, active.data, active.epoch);
  }
  resetThroughput();
  post({ t: 'run-created', runId, computePath: active.computePath });
  await postSnapshot(false);
  maybeMeasureOrder(true);
}

post({ t: 'ready' });
void reportGpuCapability();
void loop();

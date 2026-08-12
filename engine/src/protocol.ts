import type { EpochStats, Metrics, SoupConfig } from './soup.ts';
import type { RunCumulative } from './statistics.ts';

/** Bound automatic CPU parallelism and per-tab Wasm memory. */
export const AUTO_WORKER_LIMIT = 16;
export const FALLBACK_REPORTED_WORKERS = 4;

/** Normalize the browser's logical-processor capacity hint. */
export function assessAvailableWorkerCount(reported: number | undefined): number {
  return typeof reported === 'number' && Number.isInteger(reported) && reported >= 1
    ? reported
    : FALLBACK_REPORTED_WORKERS;
}

/** Resolve Auto once from 80% of the assessed browser capacity. */
export function deriveAutoWorkerCount(reported: number | undefined): number {
  const available = assessAvailableWorkerCount(reported);
  return Math.max(1, Math.min(Math.round(available * 0.8), AUTO_WORKER_LIMIT));
}

export const COMPUTE_PATHS = ['wasm', 'webgpu'] as const;
export type ComputePath = (typeof COMPUTE_PATHS)[number];

export interface GpuAdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export interface WebGpuCapability {
  available: boolean;
  adapter: GpuAdapterIdentity | null;
  reason: string | null;
}

export type WorkerSelection =
  | { mode: 'auto'; count: number }
  | { mode: 'fixed'; count: number };

/** Validate worker-protocol input before allocating a CPU execution pool. */
export function normalizeWorkerSelection(selection: WorkerSelection): WorkerSelection {
  if (selection.mode !== 'auto' && selection.mode !== 'fixed') {
    throw new Error('invalid execution worker selection mode');
  }
  const count = selection.count;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`invalid ${selection.mode} execution worker count`);
  }
  if (selection.mode === 'auto' && count > AUTO_WORKER_LIMIT) {
    throw new Error(`automatic execution worker count exceeds ${AUTO_WORKER_LIMIT}`);
  }
  return { mode: selection.mode, count };
}

export type ToWorker =
  | {
      t: 'init';
      cfg: SoupConfig;
      computePath: ComputePath;
      workers: WorkerSelection;
      revision: number;
      runId: string;
    }
  /** change the worker pool without disturbing the soup */
  | { t: 'workers'; selection: WorkerSelection }
  /** replace the complete population and begin a separately identified run */
  | {
      t: 'new-run';
      cfg: SoupConfig;
      computePath: ComputePath;
      /** Report initialization failure without invalidating the retained run. */
      retainCurrentOnFailure: boolean;
      revision: number;
      runId: string;
    }
  /** partial config patch; engine and shape changes reseed the soup */
  | {
      t: 'config';
      patch: Partial<SoupConfig>;
      computePath: ComputePath;
      revision: number;
      runId: string;
    }
  | { t: 'run'; on: boolean }
  /** advance exactly n epochs, then halt */
  | { t: 'epoch'; n: number }
  | { t: 'cancel-pending' }
  | { t: 'measurement-mode'; explicit: boolean }
  | { t: 'checkpoint'; requestId: string }
  | { t: 'reset'; seed: number; revision: number; runId: string }
  | { t: 'rate'; epochsPerSec: number };

export type FromWorker =
  /** the core could not be built; there is no fallback, so nothing will run */
  | { t: 'fatal'; message: string }
  | { t: 'ready'; runId?: string; epoch?: number }
  | { t: 'capabilities'; webgpu: WebGpuCapability }
  | { t: 'run-created'; runId: string; computePath: ComputePath }
  | { t: 'run-rejected'; runId: string; message: string }
  /**
   * The active WebGPU run failed after it had been created. The failed run is
   * no longer executable, but the coordinator remains available for an
   * explicit replacement run on the CPU path.
   */
  | { t: 'run-failed'; runId: string; computePath: 'webgpu'; message: string }
  | {
      t: 'config-applied';
      runId: string;
      configRevision: number;
      epoch: number;
    }
  | {
      t: 'snapshot';
      runId: string;
      epoch: number;
      soup: ArrayBuffer;
      /** complete configuration applied by the simulation coordinator */
      config: SoupConfig;
      /** latest init/config/reset revision fully applied to `config` and `soup` */
      configRevision: number;
      nTapes: number;
      tapeLen: number;
      stats: EpochStats;
      metrics: Metrics;
      running: boolean;
      epochsPerSec: number;
      stepsPerSec: number;
      /** engine and active Wasm execution-shard count */
      core: string;
      computePath: ComputePath;
      gpuAdapter: GpuAdapterIdentity | null;
      /** active CPU execution workers and their selection mode */
      workerMode: WorkerSelection['mode'];
      workerCount: number;
      epochsPerSecondLimit: number;
      cumulative: RunCumulative;
    }
  | ({ t: 'order' } & MeasurementPayload)
  | ({ t: 'measurement'; requestId: string } & MeasurementPayload);

/**
 * One complete-population measurement. High-order entropy follows
 * arXiv:2406.19108 using Brotli 1.1.0 at quality 2. Every reaction and order
 * value below belongs to the same immutable population copy.
 */
export interface MeasurementPayload {
  runId: string;
  epoch: number;
  /** configuration/reset revision of the population copy being measured */
  configRevision: number;
  /** compressor-dependent estimate of repeated multi-byte structure */
  highOrder: number;
  /** 8 - H0, concentration of the byte-frequency distribution */
  byteOrder: number;
  /** H0, empirical zero-order byte entropy */
  h0: number;
  /** bits per byte after Brotli compression of the complete soup */
  bpb: number;
  compressed: number;
  raw: number;
  population: MeasurementPopulation;
  epochStats: EpochStats;
  cumulative: RunCumulative;
  populationFingerprint: string;
}

export interface MeasurementMotif {
  bytes: Uint8Array;
  count: number;
  carriers: number;
  copiedBytes: number;
}

export interface MeasurementPopulation {
  distinctBytes: number;
  distinctTapes: number;
  largestIdenticalGroup: number;
  motifWindowCount: number;
  motifs: MeasurementMotif[];
}

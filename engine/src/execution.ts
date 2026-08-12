import type { ComputePath, GpuAdapterIdentity } from './protocol.ts';
import type { EpochStats, Metrics, SoupConfig } from './soup.ts';

/** Common coordinator boundary for one authoritative reactor trajectory. */
export interface SoupExecution {
  cfg: SoupConfig;
  data: Uint8Array;
  epoch: number;
  readonly computePath: ComputePath;
  readonly gpuAdapter: GpuAdapterIdentity | null;
  readonly workerCount: number;
  readonly coreDescription: string;

  runEpoch(): Promise<EpochStats>;
  readPopulation(): Promise<Uint8Array>;
  computeMetrics(): Metrics;
  reshape(cfg: SoupConfig): void | Promise<void>;
  randomize(): void | Promise<void>;
  dispose(): void;
}

/**
 * Optional execution capability for backends that can queue consecutive
 * epochs before synchronizing with the coordinator.
 *
 * Every returned entry remains the exact statistic record for its epoch and
 * appears in execution order. The population after the call is therefore
 * identical to calling `runEpoch()` the same number of times.
 */
export interface EpochBatchExecution extends SoupExecution {
  readonly maxEpochBatch: number;
  runEpochBatch(count: number): Promise<EpochStats[]>;
}

export function supportsEpochBatch(execution: SoupExecution): execution is EpochBatchExecution {
  const candidate = execution as Partial<EpochBatchExecution>;
  return (
    Number.isInteger(candidate.maxEpochBatch) &&
    (candidate.maxEpochBatch ?? 0) > 0 &&
    typeof candidate.runEpochBatch === 'function'
  );
}

/**
 * Keep an unthrottled GPU queue occupied without making Run/Pause wait on an
 * unbounded command backlog. The first batch is deliberately small; later
 * batches target at most 250 ms from the previous measured epoch duration.
 */
export function chooseEpochBatchSize(
  maxBatch: number,
  availableEpochs: number,
  previousEpochMs: number,
): number {
  const capacity = Math.min(Math.floor(maxBatch), Math.floor(availableEpochs));
  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new Error(`invalid epoch batch capacity ${capacity}`);
  }
  if (!Number.isFinite(previousEpochMs) || previousEpochMs <= 0) {
    return Math.min(2, capacity);
  }
  return Math.max(1, Math.min(capacity, Math.floor(250 / previousEpochMs)));
}

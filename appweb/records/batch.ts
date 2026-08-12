import { isComputePath } from './model.ts';
import type { BatchDefinition, BatchRunDefinition } from './model.ts';
import {
  isReactorEngine,
  SUPPORTED_STEP_LIMITS,
  SUPPORTED_TAPE_COUNTS,
  SUPPORTED_TAPE_LENGTHS,
  type SoupConfig,
} from '../../engine/src/soup.ts';
import {
  HEAD_CLAMP,
  HEAD_HALT,
  HEAD_WRAP,
  NOMATCH_HALT,
  NOMATCH_SKIP,
} from '../../engine/src/vm.ts';

export const MAX_BATCH_RUNS = 100;
export const MAX_SEED = 0xffffffff;
export const MAX_BATCH_EPOCH_LIMIT = 100_000_000;
export const BATCH_MEASUREMENT_INTERVAL = 128;

export interface BatchRequest {
  name: string;
  definition: BatchDefinition;
}

function includesNumber(values: readonly number[], value: unknown): value is number {
  return typeof value === 'number' && values.includes(value);
}

function validateSoupConfig(value: unknown): asserts value is SoupConfig {
  if (!value || typeof value !== 'object') throw new Error('configuration is missing');
  const config = value as Partial<SoupConfig>;
  if (!isReactorEngine(config.engine)) throw new Error('simulation engine is invalid');
  if (!includesNumber(SUPPORTED_TAPE_COUNTS, config.nTapes)) {
    throw new Error(`tape count must be one of ${SUPPORTED_TAPE_COUNTS.join(', ')}`);
  }
  if (!includesNumber(SUPPORTED_TAPE_LENGTHS, config.tapeLen)) {
    throw new Error(`tape length must be one of ${SUPPORTED_TAPE_LENGTHS.join(', ')}`);
  }
  if (!includesNumber(SUPPORTED_STEP_LIMITS, config.maxSteps)) {
    throw new Error(`step limit must be one of ${SUPPORTED_STEP_LIMITS.join(', ')}`);
  }
  if (
    typeof config.mutationRate !== 'number' ||
    !Number.isFinite(config.mutationRate) ||
    config.mutationRate < 0 ||
    config.mutationRate > 1
  ) {
    throw new Error('mutation rate must be between 0 and 1');
  }
  if (
    !Number.isInteger(config.seed) ||
    Number(config.seed) < 0 ||
    Number(config.seed) > MAX_SEED
  ) {
    throw new Error(`random seed must be an integer from 0 to ${MAX_SEED}`);
  }
  if (
    config.headPolicy !== HEAD_WRAP &&
    config.headPolicy !== HEAD_CLAMP &&
    config.headPolicy !== HEAD_HALT
  ) {
    throw new Error('head policy is invalid');
  }
  if (config.noMatch !== NOMATCH_SKIP && config.noMatch !== NOMATCH_HALT) {
    throw new Error('unmatched-bracket policy is invalid');
  }
}

export function assertBatchRunDefinition(
  value: unknown,
): asserts value is BatchRunDefinition {
  if (!value || typeof value !== 'object') throw new Error('run definition is missing');
  const item = value as Partial<BatchRunDefinition>;
  validateSoupConfig(item.config);
  if (!isComputePath(item.computePath)) throw new Error('compute path is invalid');
  if (item.computePath === 'webgpu' && item.config.engine !== 'cubff') {
    throw new Error('WebGPU execution supports CuBFF only');
  }
  if (
    !Number.isInteger(item.epochLimit) ||
    Number(item.epochLimit) < 1 ||
    Number(item.epochLimit) > MAX_BATCH_EPOCH_LIMIT
  ) {
    throw new Error(`epoch limit must be an integer from 1 to ${MAX_BATCH_EPOCH_LIMIT}`);
  }
  if (item.orderCrossing !== 1 && item.orderCrossing !== 2 && item.orderCrossing !== 3) {
    throw new Error('order crossing must be 1, 2, or 3');
  }
  if (item.measurementInterval !== BATCH_MEASUREMENT_INTERVAL) {
    throw new Error(`measurement interval must be ${BATCH_MEASUREMENT_INTERVAL}`);
  }
}

export function isBatchRunDefinition(value: unknown): value is BatchRunDefinition {
  try {
    assertBatchRunDefinition(value);
    return true;
  } catch {
    return false;
  }
}

function cloneRunDefinition(definition: BatchRunDefinition): BatchRunDefinition {
  return { ...definition, config: { ...definition.config } };
}

/** Validate and defensively clone the complete queue at its action boundary. */
export function normalizeBatchRequest(value: unknown): BatchRequest {
  if (!value || typeof value !== 'object') throw new Error('batch request is missing');
  const input = value as { name?: unknown; definition?: unknown };
  if (typeof input.name !== 'string') throw new Error('batch name is invalid');
  if (!input.definition || typeof input.definition !== 'object') {
    throw new Error('batch definition is missing');
  }
  const definition = input.definition as { items?: unknown };
  if (!Array.isArray(definition.items) || definition.items.length < 1) {
    throw new Error('batch queue is empty');
  }
  if (definition.items.length > MAX_BATCH_RUNS) {
    throw new Error(`batch queue exceeds ${MAX_BATCH_RUNS} runs`);
  }

  const items = definition.items.map((item, index) => {
    try {
      assertBatchRunDefinition(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`batch item ${index + 1}: ${message}`);
    }
    return cloneRunDefinition(item);
  });
  return {
    name: input.name.trim() || 'experiment batch',
    definition: { items },
  };
}

/** Exact epoch block size used by the sequential runner. */
export function nextBatchEpochCount(
  currentEpoch: number,
  definition: Pick<BatchRunDefinition, 'epochLimit' | 'measurementInterval'>,
): number {
  if (!Number.isInteger(currentEpoch) || currentEpoch < 0 || currentEpoch > definition.epochLimit) {
    throw new RangeError('current batch epoch is outside its run definition');
  }
  return Math.min(definition.measurementInterval, definition.epochLimit - currentEpoch);
}

/** Materialize consecutive seeds as complete, independently editable runs. */
export function expandSeedRuns(
  definition: BatchRunDefinition,
  count: number,
): BatchRunDefinition[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_RUNS) {
    throw new RangeError(`number of seeds must be an integer from 1 to ${MAX_BATCH_RUNS}`);
  }
  const start = definition.config.seed;
  if (!Number.isInteger(start) || start < 0 || start > MAX_SEED) {
    throw new RangeError('seed start must be an integer from 0 to 4294967295');
  }
  if (start + count - 1 > MAX_SEED) {
    throw new RangeError('seed range exceeds 4294967295');
  }

  return Array.from({ length: count }, (_, offset) => ({
    ...cloneRunDefinition(definition),
    config: { ...definition.config, seed: start + offset },
  }));
}

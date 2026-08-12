import { describe, expect, it } from 'vitest';

import type { BatchRunDefinition } from './model.ts';
import {
  BATCH_MEASUREMENT_INTERVAL,
  expandSeedRuns,
  isBatchRunDefinition,
  MAX_BATCH_RUNS,
  MAX_SEED,
  nextBatchEpochCount,
  normalizeBatchRequest,
} from './batch.ts';

function definition(overrides: Partial<BatchRunDefinition> = {}): BatchRunDefinition {
  return {
    config: {
      engine: 'cubff',
      nTapes: 1024,
      tapeLen: 64,
      maxSteps: 8192,
      mutationRate: 1 / 4096,
      headPolicy: 0,
      noMatch: 0,
      seed: 19,
    },
    computePath: 'wasm',
    epochLimit: 20_000,
    orderCrossing: 2,
    measurementInterval: BATCH_MEASUREMENT_INTERVAL,
    ...overrides,
  };
}

describe('batch domain rules', () => {
  it('expands consecutive seeds into independent definitions without mutation', () => {
    const source = definition();
    const expanded = expandSeedRuns(source, 3);

    expect(expanded.map((item) => item.config.seed)).toEqual([19, 20, 21]);
    expect(expanded[0]).not.toBe(source);
    expect(expanded[0].config).not.toBe(source.config);
    expect(expanded[0].config).not.toBe(expanded[1].config);
    expect(source.config.seed).toBe(19);
  });

  it('rejects invalid seed counts and unsigned overflow', () => {
    expect(() => expandSeedRuns(definition(), 0)).toThrow(
      `number of seeds must be an integer from 1 to ${MAX_BATCH_RUNS}`,
    );
    expect(() => expandSeedRuns(definition(), MAX_BATCH_RUNS + 1)).toThrow();
    expect(() => expandSeedRuns(definition({
      config: { ...definition().config, seed: MAX_SEED },
    }), 2)).toThrow(`seed range exceeds ${MAX_SEED}`);
  });

  it('validates model, compute, termination, and measurement invariants', () => {
    expect(isBatchRunDefinition(definition())).toBe(true);
    expect(isBatchRunDefinition(definition({
      config: { ...definition().config, engine: 'brainfuck-life' },
      computePath: 'webgpu',
    }))).toBe(false);
    expect(isBatchRunDefinition(definition({ epochLimit: 100_000_001 }))).toBe(false);
    expect(isBatchRunDefinition(definition({ measurementInterval: 64 }))).toBe(false);
    expect(isBatchRunDefinition(definition({
      config: { ...definition().config, mutationRate: Number.NaN },
    }))).toBe(false);
  });

  it('rejects unsupported or unsafe runtime configuration values', () => {
    for (const config of [
      { ...definition().config, nTapes: 1 },
      { ...definition().config, nTapes: 4095 },
      { ...definition().config, nTapes: 262144 },
      { ...definition().config, tapeLen: 63 },
      { ...definition().config, maxSteps: 1_000_000 },
      { ...definition().config, headPolicy: 3 },
      { ...definition().config, noMatch: 2 },
    ]) {
      expect(isBatchRunDefinition(definition({ config }))).toBe(false);
    }
  });

  it('normalizes the name and defensively clones an accepted queue', () => {
    const item = definition();
    const request = normalizeBatchRequest({
      name: '   ',
      definition: { items: [item] },
    });

    expect(request.name).toBe('experiment batch');
    expect(request.definition.items).toEqual([item]);
    expect(request.definition.items[0]).not.toBe(item);
    expect(request.definition.items[0].config).not.toBe(item.config);
  });

  it('rejects empty, oversized, and invalid programmatic queues', () => {
    expect(() => normalizeBatchRequest({ name: 'empty', definition: { items: [] } })).toThrow(
      'batch queue is empty',
    );
    expect(() => normalizeBatchRequest({
      name: 'large',
      definition: { items: Array.from({ length: MAX_BATCH_RUNS + 1 }, () => definition()) },
    })).toThrow(`batch queue exceeds ${MAX_BATCH_RUNS} runs`);
    expect(() => normalizeBatchRequest({
      name: 'invalid',
      definition: { items: [definition({ orderCrossing: 4 as 1 })] },
    })).toThrow('batch item 1: order crossing must be 1, 2, or 3');
  });

  it('calculates complete measurement blocks and the final remainder', () => {
    const run = definition({ epochLimit: 300 });
    expect(nextBatchEpochCount(0, run)).toBe(128);
    expect(nextBatchEpochCount(128, run)).toBe(128);
    expect(nextBatchEpochCount(256, run)).toBe(44);
    expect(nextBatchEpochCount(300, run)).toBe(0);
    expect(() => nextBatchEpochCount(301, run)).toThrow(
      'current batch epoch is outside its run definition',
    );
  });
});

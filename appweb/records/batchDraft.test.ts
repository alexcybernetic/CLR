import { describe, expect, it } from 'vitest';

import { BATCH_MEASUREMENT_INTERVAL } from './batch.ts';
import {
  CURRENT_BATCH_DRAFT_VERSION,
  decodeBatchDraft,
  encodeBatchDraft,
  LEGACY_BATCH_DRAFT_VERSION,
  type BatchDraft,
} from './batchDraft.ts';
import type { BatchRunDefinition } from './model.ts';

function runDefinition(): BatchRunDefinition {
  return {
    config: {
      engine: 'brainfuck-life',
      nTapes: 4096,
      tapeLen: 64,
      maxSteps: 8192,
      mutationRate: 1 / 4096,
      headPolicy: 0,
      noMatch: 1,
      seed: 4,
    },
    computePath: 'wasm',
    epochLimit: 20_000,
    orderCrossing: 1,
    measurementInterval: BATCH_MEASUREMENT_INTERVAL,
  };
}

function draft(items: BatchRunDefinition[] = [runDefinition()]): BatchDraft {
  return { name: 'test batch', definition: { items } };
}

describe('batch draft codec', () => {
  it('round-trips the existing v4 payload shape', () => {
    const source = draft();
    const serialized = encodeBatchDraft(source);

    expect(JSON.parse(serialized)).toEqual({
      name: source.name,
      items: source.definition.items,
    });
    expect(decodeBatchDraft(serialized, CURRENT_BATCH_DRAFT_VERSION)).toEqual(source);
  });

  it.each([LEGACY_BATCH_DRAFT_VERSION, CURRENT_BATCH_DRAFT_VERSION])(
    'normalizes schema-1 engine and missing compute path for v%s',
    (version) => {
      const item = runDefinition();
      const { engine: _engine, ...legacyConfig } = item.config;
      const { computePath: _computePath, ...legacyItem } = item;
      const serialized = JSON.stringify({
        name: ' legacy ',
        items: [{ ...legacyItem, config: legacyConfig }],
      });

      const decoded = decodeBatchDraft(serialized, version);

      expect(decoded.name).toBe('legacy');
      expect(decoded.definition.items[0].config.engine).toBe('cubff');
      expect(decoded.definition.items[0].computePath).toBe('wasm');
    },
  );

  it('applies the existing Wasm fallback to an unknown v4 compute path', () => {
    const item = { ...runDefinition(), computePath: 'obsolete-gpu' };
    const serialized = JSON.stringify({ name: 'fallback', items: [item] });

    expect(
      decodeBatchDraft(serialized, CURRENT_BATCH_DRAFT_VERSION).definition.items[0]
        .computePath,
    ).toBe('wasm');
  });

  it('uses the existing default name and accepts an empty draft queue', () => {
    const decoded = decodeBatchDraft(
      JSON.stringify({ name: '   ', items: [] }),
      CURRENT_BATCH_DRAFT_VERSION,
    );

    expect(decoded).toEqual({
      name: 'experiment batch',
      definition: { items: [] },
    });
  });

  it('rejects corrupt payloads and unsupported versions', () => {
    expect(() => decodeBatchDraft('{', CURRENT_BATCH_DRAFT_VERSION)).toThrow(
      'batch draft is not valid JSON',
    );
    expect(() => decodeBatchDraft('null', CURRENT_BATCH_DRAFT_VERSION)).toThrow(
      'batch draft is invalid',
    );
    expect(() => decodeBatchDraft('{}', CURRENT_BATCH_DRAFT_VERSION)).toThrow(
      'batch draft queue is invalid',
    );
    expect(() => decodeBatchDraft('{"items":[]}', 2)).toThrow(
      'unsupported batch draft version 2',
    );
  });

  it('rejects the whole draft when one item is invalid', () => {
    const invalid = {
      ...runDefinition(),
      measurementInterval: BATCH_MEASUREMENT_INTERVAL / 2,
    };
    const serialized = JSON.stringify({
      name: 'partly invalid',
      items: [runDefinition(), invalid],
    });

    expect(() => decodeBatchDraft(serialized, CURRENT_BATCH_DRAFT_VERSION)).toThrow(
      `batch draft item 2: measurement interval must be ${BATCH_MEASUREMENT_INTERVAL}`,
    );
  });

  it('validates before encoding and does not mutate the caller draft', () => {
    const source = draft();
    const before = structuredClone(source);

    encodeBatchDraft(source);

    expect(source).toEqual(before);
    const invalid = draft([{ ...runDefinition(), orderCrossing: 4 as 1 }]);
    expect(() => encodeBatchDraft(invalid)).toThrow(
      'batch draft item 1: order crossing must be 1, 2, or 3',
    );
  });
});

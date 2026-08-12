import { describe, expect, it } from 'vitest';

import type { MeasurementPayload } from '../../engine/src/protocol.ts';
import type { SoupConfig } from '../../engine/src/soup.ts';
import type { SnapshotMessage } from './coordinatorClient.ts';
import {
  configurationDifferences,
  inspectMeasurement,
  inspectSnapshot,
  type ExpectedRunProtocolState,
} from './runProtocol.ts';

const config: SoupConfig = {
  engine: 'brainfuck-life',
  nTapes: 4096,
  tapeLen: 64,
  maxSteps: 8192,
  mutationRate: 1 / 4096,
  headPolicy: 0,
  noMatch: 0,
  seed: 4,
};

const expected: ExpectedRunProtocolState = {
  runId: 'active-run',
  configRevision: 7,
  config,
  computePath: 'wasm',
};

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    t: 'snapshot',
    runId: expected.runId,
    epoch: 0,
    soup: new ArrayBuffer(0),
    config: { ...config },
    configRevision: expected.configRevision,
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
    ...overrides,
  };
}

function measurement(overrides: Partial<MeasurementPayload> = {}): MeasurementPayload {
  return {
    runId: expected.runId,
    epoch: 1,
    configRevision: expected.configRevision,
    highOrder: 0,
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
    cumulative: { epochs: 1, interactions: 0, steps: 0, computeMs: 0, halts: [] },
    populationFingerprint: '',
    ...overrides,
  };
}

describe('run protocol validation', () => {
  it('accepts the exact active run, revision, configuration, shape, and path', () => {
    expect(inspectSnapshot(snapshot(), expected)).toEqual({ kind: 'accept' });
    expect(inspectMeasurement(measurement(), expected)).toEqual({ kind: 'accept' });
  });

  it('ignores replaced runs and queued older revisions', () => {
    expect(inspectSnapshot(snapshot({ runId: 'replaced' }), expected)).toEqual({
      kind: 'ignore',
      reason: 'replaced-run',
    });
    expect(inspectMeasurement(measurement({ configRevision: 6 }), expected)).toEqual({
      kind: 'ignore',
      reason: 'stale-revision',
    });
  });

  it('treats future revisions as terminal protocol failures', () => {
    expect(inspectSnapshot(snapshot({ configRevision: 8 }), expected)).toEqual({
      kind: 'fatal',
      message:
        'the simulation acknowledged unknown configuration revision 8 ' +
        '(latest requested 7)',
    });
    expect(inspectMeasurement(measurement({ configRevision: 8 }), expected)).toEqual({
      kind: 'fatal',
      message:
        'the simulation reported order for unknown configuration revision 8 ' +
        '(latest requested 7)',
    });
  });

  it('rejects inconsistent snapshot shape and compute path', () => {
    expect(inspectSnapshot(snapshot({ nTapes: 2048 }), expected)).toEqual({
      kind: 'fatal',
      message: 'the simulation snapshot contains inconsistent shape metadata',
    });
    expect(inspectSnapshot(snapshot({ computePath: 'webgpu' }), expected)).toEqual({
      kind: 'fatal',
      message: 'simulation compute-path mismatch: expected wasm, received webgpu',
    });
  });

  it('reports every applied configuration difference in stable field order', () => {
    const applied = {
      ...config,
      engine: 'cubff' as const,
      nTapes: 1024,
      maxSteps: 2048,
      seed: 9,
    };

    expect(configurationDifferences(applied, config)).toEqual([
      'engine: requested brainfuck-life, applied cubff',
      'nTapes: requested 4096, applied 1024',
      'maxSteps: requested 8192, applied 2048',
      'seed: requested 4, applied 9',
    ]);
    expect(inspectSnapshot(snapshot({ config: applied, nTapes: applied.nTapes }), expected)).toEqual({
      kind: 'fatal',
      message:
        'simulation configuration mismatch: ' +
        'engine: requested brainfuck-life, applied cubff; ' +
        'nTapes: requested 4096, applied 1024; ' +
        'maxSteps: requested 8192, applied 2048; ' +
        'seed: requested 4, applied 9',
    });
  });
});

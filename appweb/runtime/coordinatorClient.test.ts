import { describe, expect, it, vi } from 'vitest';

import type { FromWorker, ToWorker } from '../../engine/src/protocol.ts';
import {
  CoordinatorClient,
  type MeasurementMessage,
  type SnapshotMessage,
} from './coordinatorClient.ts';

class FakeWorker extends EventTarget {
  readonly messages: ToWorker[] = [];
  onPost: ((message: ToWorker) => void) | null = null;
  terminateCount = 0;

  postMessage(message: ToWorker): void {
    this.messages.push(message);
    this.onPost?.(message);
  }

  terminate(): void {
    this.terminateCount++;
  }

  emit(message: FromWorker): void {
    this.dispatchEvent(new MessageEvent<FromWorker>('message', { data: message }));
  }
}

function snapshot(runId: string): SnapshotMessage {
  return {
    t: 'snapshot',
    runId,
    epoch: 0,
    soup: new ArrayBuffer(0),
    config: {
      engine: 'brainfuck-life',
      nTapes: 2,
      tapeLen: 32,
      maxSteps: 2048,
      mutationRate: 0,
      headPolicy: 0,
      noMatch: 0,
      seed: 4,
    },
    configRevision: 0,
    nTapes: 2,
    tapeLen: 32,
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
  };
}

function measurement(requestId: string, runId = 'run-1'): MeasurementMessage {
  return {
    t: 'measurement',
    requestId,
    runId,
    epoch: 1,
    configRevision: 0,
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
  };
}

function fixture(onMessage?: (message: FromWorker) => void) {
  const worker = new FakeWorker();
  const failures = vi.fn();
  let client!: CoordinatorClient;
  client = new CoordinatorClient({
    createWorker: () => worker as unknown as Worker,
    createRequestId: () => 'request-1',
    onMessage: onMessage ?? (() => undefined),
    onFailure: failures,
  });
  return { client, failures, worker };
}

describe('CoordinatorClient correlations', () => {
  it('settles snapshot and ready waiters only after explicit acceptance', async () => {
    const { client } = fixture();
    const acceptedSnapshot = snapshot('run-1');
    let snapshotSettled = false;
    const snapshotResult = client.waitForSnapshot('run-1').then((value) => {
      snapshotSettled = true;
      return value;
    });
    const readyResult = client.waitForReady('run-1');

    await Promise.resolve();
    expect(snapshotSettled).toBe(false);
    client.acceptSnapshot(snapshot('other-run'));
    client.acceptReady({ t: 'ready' });
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);

    client.acceptSnapshot(acceptedSnapshot);
    client.acceptReady({ t: 'ready', runId: 'run-1', epoch: 12 });
    await expect(snapshotResult).resolves.toBe(acceptedSnapshot);
    await expect(readyResult).resolves.toBe(12);
  });

  it('defaults an accepted run-ready epoch to zero', async () => {
    const { client } = fixture();
    const result = client.waitForReady('run-1');
    client.acceptReady({ t: 'ready', runId: 'run-1' });
    await expect(result).resolves.toBe(0);
  });

  it('rejects both creation and initial-snapshot waits for a rejected run', async () => {
    const { client } = fixture();
    const creation = client.waitForRunCreation('candidate');
    const initialSnapshot = client.waitForSnapshot('candidate');
    client.rejectRunCreation({ t: 'run-rejected', runId: 'candidate', message: 'no adapter' });

    await expect(creation).rejects.toThrow('no adapter');
    await expect(initialSnapshot).rejects.toThrow('no adapter');
  });

  it('registers measurement correlation before posting the checkpoint', async () => {
    let client!: CoordinatorClient;
    const worker = new FakeWorker();
    client = new CoordinatorClient({
      createWorker: () => worker as unknown as Worker,
      createRequestId: () => 'request-1',
      onFailure: () => undefined,
      onMessage: (message) => {
        if (message.t === 'measurement') client.acceptMeasurement(message);
      },
    });
    client.start();
    worker.onPost = (message) => {
      if (message.t === 'checkpoint') worker.emit(measurement(message.requestId));
    };

    const result = client.requestMeasurement();

    await expect(result).resolves.toMatchObject({ requestId: 'request-1' });
    expect(worker.messages).toEqual([{ t: 'checkpoint', requestId: 'request-1' }]);
  });

  it('rejects one failed run without sealing transport for a replacement', async () => {
    const { client, worker } = fixture();
    client.start();
    const failedSnapshot = client.waitForSnapshot('failed-run');
    const failedReady = client.waitForReady('failed-run');
    const failedCreation = client.waitForRunCreation('failed-run');
    const failedMeasurement = client.requestMeasurement();
    const error = new Error('GPU device lost');

    client.failRun('failed-run', error);

    await expect(failedSnapshot).rejects.toBe(error);
    await expect(failedReady).rejects.toBe(error);
    await expect(failedCreation).rejects.toBe(error);
    await expect(failedMeasurement).rejects.toBe(error);
    client.send({ t: 'run', on: false });
    expect(worker.messages.at(-1)).toEqual({ t: 'run', on: false });
  });

  it('terminal failure and disposal reject all correlations and terminate once', async () => {
    const terminal = fixture();
    terminal.client.start();
    const snapshotResult = terminal.client.waitForSnapshot('run-1');
    const creationResult = terminal.client.waitForRunCreation('run-2');
    const error = new Error('protocol mismatch');
    terminal.client.failTerminal(error);
    terminal.client.failTerminal(error);

    await expect(snapshotResult).rejects.toBe(error);
    await expect(creationResult).rejects.toBe(error);
    expect(terminal.worker.terminateCount).toBe(1);

    const disposed = fixture();
    disposed.client.start();
    const readyResult = disposed.client.waitForReady('run-1');
    disposed.client.dispose();
    disposed.client.dispose();
    await expect(readyResult).rejects.toThrow('simulation coordinator disposed');
    expect(disposed.worker.terminateCount).toBe(1);
  });

  it('rejects late and duplicate correlations instead of orphaning promises', async () => {
    const duplicate = fixture();
    const first = duplicate.client.waitForSnapshot('run-1');
    await expect(duplicate.client.waitForSnapshot('run-1')).rejects.toThrow(
      'a coordinator request with this identity is already pending',
    );
    duplicate.client.acceptSnapshot(snapshot('run-1'));
    await expect(first).resolves.toMatchObject({ runId: 'run-1' });

    const terminal = fixture();
    const error = new Error('protocol mismatch');
    terminal.client.failTerminal(error);
    await expect(terminal.client.waitForReady('late-run')).rejects.toBe(error);
    await expect(terminal.client.requestMeasurement()).rejects.toBe(error);
    expect(terminal.worker.messages).toEqual([]);
  });
});

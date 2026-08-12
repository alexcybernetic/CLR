import { describe, expect, it, vi } from 'vitest';

import type { FromWorker, ToWorker } from '../../engine/src/protocol.ts';
import {
  CoordinatorTransport,
  type CoordinatorTransportFailure,
} from './coordinatorTransport.ts';

class FakeWorker extends EventTarget {
  readonly messages: ToWorker[] = [];
  terminateCount = 0;
  sendFailure: Error | null = null;

  postMessage(message: ToWorker): void {
    if (this.sendFailure) throw this.sendFailure;
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount++;
  }

  emitMessage(message: FromWorker): void {
    this.dispatchEvent(new MessageEvent<FromWorker>('message', { data: message }));
  }

  emitError(message: string): void {
    this.dispatchEvent(new ErrorEvent('error', {
      message,
      filename: 'worker.ts',
      lineno: 17,
    }));
  }

  emitMessageError(): void {
    this.dispatchEvent(new MessageEvent('messageerror'));
  }
}

function fixture(onMessage: (message: FromWorker) => void = () => undefined) {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const failures: CoordinatorTransportFailure[] = [];
  const transport = new CoordinatorTransport({
    createWorker,
    onMessage,
    onFailure: (failure) => failures.push(failure),
  });
  return { createWorker, failures, transport, worker };
}

describe('CoordinatorTransport', () => {
  it('does no Worker work before explicit, idempotent startup', () => {
    const { createWorker, transport, worker } = fixture();

    transport.send({ t: 'run', on: true });
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.messages).toEqual([]);

    transport.start();
    transport.start();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(transport.status).toBe('active');
  });

  it('transports typed commands and responses while active', () => {
    const received: FromWorker[] = [];
    const { transport, worker } = fixture((message) => received.push(message));
    transport.start();

    const command: ToWorker = { t: 'rate', epochsPerSec: 10 };
    const response: FromWorker = { t: 'ready', runId: 'run-1', epoch: 4 };
    transport.send(command);
    worker.emitMessage(response);

    expect(worker.messages).toEqual([command]);
    expect(received).toEqual([response]);
  });

  it('fails closed after a Worker error and reports it once', () => {
    const { failures, transport, worker } = fixture();
    transport.start();

    worker.emitError('worker crashed');
    worker.emitMessageError();
    transport.send({ t: 'run', on: true });

    expect(transport.status).toBe('failed');
    expect(worker.terminateCount).toBe(1);
    expect(worker.messages).toEqual([]);
    expect(failures).toEqual([{
      kind: 'worker-error',
      message: 'worker crashed',
      filename: 'worker.ts',
      line: 17,
    }]);
  });

  it('turns message-processing and send exceptions into terminal failures', () => {
    const handler = fixture(() => {
      throw new Error('invalid response');
    });
    handler.transport.start();
    handler.worker.emitMessage({ t: 'ready' });
    expect(handler.failures[0]).toMatchObject({
      kind: 'message-handler',
      message: 'the simulation response could not be processed: invalid response',
    });

    const sender = fixture();
    sender.transport.start();
    sender.worker.sendFailure = new Error('port closed');
    sender.transport.send({ t: 'run', on: false });
    expect(sender.failures[0]).toMatchObject({
      kind: 'send',
      message: 'the simulation core could not receive a command: port closed',
    });
  });

  it('disposes idempotently and ignores late events', () => {
    const received = vi.fn<(message: FromWorker) => void>();
    const { failures, transport, worker } = fixture(received);
    transport.start();

    transport.dispose();
    transport.dispose();
    worker.emitMessage({ t: 'ready' });
    worker.emitError('late failure');

    expect(transport.status).toBe('disposed');
    expect(worker.terminateCount).toBe(1);
    expect(received).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });
});

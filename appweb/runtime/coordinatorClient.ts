import type {
  ComputePath,
  FromWorker,
  ToWorker,
} from '../../engine/src/protocol.ts';
import {
  CoordinatorTransport,
  type CoordinatorTransportFailure,
  type CoordinatorTransportStatus,
} from './coordinatorTransport.ts';

export type SnapshotMessage = Extract<FromWorker, { t: 'snapshot' }>;
export type ReadyMessage = Extract<FromWorker, { t: 'ready' }>;
export type RunCreatedMessage = Extract<FromWorker, { t: 'run-created' }>;
export type RunRejectedMessage = Extract<FromWorker, { t: 'run-rejected' }>;
export type MeasurementMessage = Extract<FromWorker, { t: 'measurement' }>;

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export interface CoordinatorClientOptions {
  createWorker: () => Worker;
  createRequestId?: () => string;
  onMessage: (message: FromWorker) => void;
  onFailure: (failure: CoordinatorTransportFailure) => void;
}

/**
 * Coordinator transport plus explicitly accepted protocol correlations.
 *
 * The presentation/runtime handler remains responsible for validating active
 * run identity, configuration revisions, and payload consistency. It settles
 * a waiter only after the corresponding message has passed those checks and
 * all required recording/display work has completed.
 */
export class CoordinatorClient {
  readonly #transport: CoordinatorTransport;
  readonly #createRequestId: () => string;
  readonly #snapshotWaiters = new Map<string, Waiter<SnapshotMessage>>();
  readonly #readyWaiters = new Map<string, Waiter<number>>();
  readonly #runCreationWaiters = new Map<string, Waiter<ComputePath>>();
  readonly #measurementWaiters = new Map<string, Waiter<MeasurementMessage>>();
  #closed = false;
  #closedError: Error | null = null;

  constructor(options: CoordinatorClientOptions) {
    this.#createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.#transport = new CoordinatorTransport({
      createWorker: options.createWorker,
      onMessage: options.onMessage,
      onFailure: (failure) => {
        if (!this.#closed) {
          this.#seal(new Error(failure.message));
        }
        options.onFailure(failure);
      },
    });
  }

  get status(): CoordinatorTransportStatus {
    return this.#transport.status;
  }

  start(): void {
    if (!this.#closed) this.#transport.start();
  }

  send(message: ToWorker): void {
    if (!this.#closed) this.#transport.send(message);
  }

  waitForSnapshot(runId: string): Promise<SnapshotMessage> {
    return this.#wait(this.#snapshotWaiters, runId);
  }

  waitForReady(runId: string): Promise<number> {
    return this.#wait(this.#readyWaiters, runId);
  }

  waitForRunCreation(runId: string): Promise<ComputePath> {
    return this.#wait(this.#runCreationWaiters, runId);
  }

  /** Register the request correlation before posting its checkpoint command. */
  requestMeasurement(): Promise<MeasurementMessage> {
    const requestId = this.#createRequestId();
    const result = this.#wait(this.#measurementWaiters, requestId);
    this.send({ t: 'checkpoint', requestId });
    return result;
  }

  acceptSnapshot(message: SnapshotMessage): void {
    this.#resolve(this.#snapshotWaiters, message.runId, message);
  }

  acceptReady(message: ReadyMessage): void {
    if (!message.runId) return;
    this.#resolve(this.#readyWaiters, message.runId, message.epoch ?? 0);
  }

  acceptRunCreation(message: RunCreatedMessage): void {
    this.#resolve(this.#runCreationWaiters, message.runId, message.computePath);
  }

  acceptMeasurement(message: MeasurementMessage): void {
    this.#resolve(this.#measurementWaiters, message.requestId, message);
  }

  rejectRunCreation(message: RunRejectedMessage): void {
    const error = new Error(message.message);
    this.#reject(this.#runCreationWaiters, message.runId, error);
    this.#reject(this.#snapshotWaiters, message.runId, error);
  }

  /** Reject one failed run without sealing the still-usable coordinator. */
  failRun(runId: string, error: Error): void {
    this.#reject(this.#snapshotWaiters, runId, error);
    this.#reject(this.#readyWaiters, runId, error);
    this.#reject(this.#runCreationWaiters, runId, error);
    this.#rejectMap(this.#measurementWaiters, error);
  }

  /** Seal traffic and reject every outstanding request with the same cause. */
  failTerminal(error: Error): void {
    if (this.#closed) return;
    this.#seal(error);
    this.#transport.dispose();
  }

  /** Dispose during application/HMR teardown with a stable rejection reason. */
  dispose(): void {
    if (this.#closed) return;
    this.#seal(new Error('simulation coordinator disposed'));
    this.#transport.dispose();
  }

  #wait<T>(waiters: Map<string, Waiter<T>>, key: string): Promise<T> {
    if (this.#closed) {
      return Promise.reject(this.#closedError ?? new Error('simulation coordinator is unavailable'));
    }
    if (waiters.has(key)) {
      return Promise.reject(new Error('a coordinator request with this identity is already pending'));
    }
    return new Promise<T>((resolve, reject) => {
      waiters.set(key, { resolve, reject });
    });
  }

  #resolve<T>(waiters: Map<string, Waiter<T>>, key: string, value: T): void {
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    waiter.resolve(value);
  }

  #reject<T>(waiters: Map<string, Waiter<T>>, key: string, error: Error): void {
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    waiter.reject(error);
  }

  #rejectMap<T>(waiters: Map<string, Waiter<T>>, error: Error): void {
    const pending = [...waiters.values()];
    waiters.clear();
    for (const waiter of pending) waiter.reject(error);
  }

  #rejectAll(error: Error): void {
    this.#rejectMap(this.#snapshotWaiters, error);
    this.#rejectMap(this.#readyWaiters, error);
    this.#rejectMap(this.#runCreationWaiters, error);
    this.#rejectMap(this.#measurementWaiters, error);
  }

  #seal(error: Error): void {
    this.#closed = true;
    this.#closedError = error;
    this.#rejectAll(error);
  }
}

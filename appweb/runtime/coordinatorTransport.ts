import type { FromWorker, ToWorker } from '../../engine/src/protocol.ts';

export type CoordinatorTransportStatus = 'idle' | 'active' | 'failed' | 'disposed';

export type CoordinatorTransportFailureKind =
  | 'construction'
  | 'worker-error'
  | 'message-error'
  | 'message-handler'
  | 'send';

export interface CoordinatorTransportFailure {
  kind: CoordinatorTransportFailureKind;
  message: string;
  cause?: unknown;
  filename?: string;
  line?: number;
}

export interface CoordinatorTransportOptions {
  createWorker: () => Worker;
  onMessage: (message: FromWorker) => void;
  onFailure: (failure: CoordinatorTransportFailure) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start-gated, framework-independent ownership of the coordinator Worker.
 *
 * This class transports typed protocol messages only. Run identity, revision
 * validation, recording, and presentation remain above this boundary.
 */
export class CoordinatorTransport {
  readonly #createWorker: () => Worker;
  readonly #onMessage: (message: FromWorker) => void;
  readonly #onFailure: (failure: CoordinatorTransportFailure) => void;

  #worker: Worker | null = null;
  #status: CoordinatorTransportStatus = 'idle';

  constructor(options: CoordinatorTransportOptions) {
    this.#createWorker = options.createWorker;
    this.#onMessage = options.onMessage;
    this.#onFailure = options.onFailure;
  }

  get status(): CoordinatorTransportStatus {
    return this.#status;
  }

  /** Create and bind the Worker at most once. */
  start(): void {
    if (this.#status !== 'idle') return;

    try {
      const worker = this.#createWorker();
      this.#worker = worker;
      this.#status = 'active';
      worker.addEventListener('message', this.#handleMessage);
      worker.addEventListener('error', this.#handleWorkerError);
      worker.addEventListener('messageerror', this.#handleMessageError);
    } catch (cause) {
      this.#fail({
        kind: 'construction',
        message: errorMessage(cause),
        cause,
      });
    }
  }

  /** Send only while the coordinator is active; preflight sends are ignored. */
  send(message: ToWorker): void {
    if (this.#status !== 'active' || !this.#worker) return;
    try {
      this.#worker.postMessage(message);
    } catch (cause) {
      this.#fail({
        kind: 'send',
        message: `the simulation core could not receive a command: ${errorMessage(cause)}`,
        cause,
      });
    }
  }

  /** Terminate the owned Worker and make the transport permanently inert. */
  dispose(): void {
    if (this.#status === 'disposed') return;
    const worker = this.#worker;
    this.#worker = null;
    this.#status = 'disposed';
    if (!worker) return;
    this.#unbind(worker);
    worker.terminate();
  }

  readonly #handleMessage = (event: MessageEvent<FromWorker>): void => {
    if (this.#status !== 'active') return;
    try {
      this.#onMessage(event.data);
    } catch (cause) {
      this.#fail({
        kind: 'message-handler',
        message: `the simulation response could not be processed: ${errorMessage(cause)}`,
        cause,
      });
    }
  };

  readonly #handleWorkerError = (event: ErrorEvent): void => {
    this.#fail({
      kind: 'worker-error',
      message: event.message || 'the simulation core stopped',
      filename: event.filename,
      line: event.lineno,
    });
  };

  readonly #handleMessageError = (): void => {
    this.#fail({
      kind: 'message-error',
      message: 'the simulation core sent something unreadable',
    });
  };

  #fail(failure: CoordinatorTransportFailure): void {
    if (this.#status === 'failed' || this.#status === 'disposed') return;
    const worker = this.#worker;
    this.#worker = null;
    this.#status = 'failed';
    if (worker) {
      this.#unbind(worker);
      worker.terminate();
    }
    this.#onFailure(failure);
  }

  #unbind(worker: Worker): void {
    worker.removeEventListener('message', this.#handleMessage);
    worker.removeEventListener('error', this.#handleWorkerError);
    worker.removeEventListener('messageerror', this.#handleMessageError);
  }
}

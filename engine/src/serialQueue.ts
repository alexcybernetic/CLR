export type SerialJob<T> = () => Promise<T> | T;

/**
 * A fail-closed command queue.
 *
 * Jobs start in submission order. The first rejection seals the queue, reports
 * the original failure once, and prevents every already-queued or later job
 * from starting.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private readonly onFatal: (error: unknown) => void;
  private readonly sealedMessage: string;

  constructor(
    onFatal: (error: unknown) => void,
    sealedMessage = 'serial queue is unavailable',
  ) {
    this.onFatal = onFatal;
    this.sealedMessage = sealedMessage;
  }

  get sealed(): boolean {
    return this.failed;
  }

  run<T>(job: SerialJob<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.failed) throw new Error(this.sealedMessage);
      return job();
    });
    this.tail = result.then(
      () => undefined,
      (error: unknown) => this.seal(error),
    );
    return result;
  }

  enqueue(job: SerialJob<void>): void {
    void this.run(job).catch(() => undefined);
  }

  private seal(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.onFatal(error);
  }
}

export interface DisplayFrameLoopOptions {
  renderFrame: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onError?: (error: unknown) => void;
}

/** Start-gated, single-owner animation loop for imperative display adapters. */
export class DisplayFrameLoop {
  readonly #renderFrame: () => void;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #onError: ((error: unknown) => void) | undefined;
  #handle: number | null = null;
  #active = false;
  #disposed = false;

  constructor(options: DisplayFrameLoopOptions) {
    this.#renderFrame = options.renderFrame;
    this.#requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.#cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.#onError = options.onError;
  }

  get active(): boolean {
    return this.#active;
  }

  start(): void {
    if (this.#active || this.#disposed) return;
    this.#active = true;
    this.#schedule();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#handle === null) return;
    this.#cancelFrame(this.#handle);
    this.#handle = null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
  }

  readonly #tick: FrameRequestCallback = () => {
    this.#handle = null;
    if (!this.#active) return;
    try {
      this.#renderFrame();
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (this.#active) this.#schedule();
  };

  #schedule(): void {
    if (this.#handle !== null || !this.#active || this.#disposed) return;
    try {
      this.#handle = this.#requestFrame(this.#tick);
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    this.#active = false;
    this.#handle = null;
    if (this.#onError) {
      this.#onError(error);
      return;
    }
    throw error;
  }
}

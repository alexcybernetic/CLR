/** One small sequence leader copied for declarative presentation. */
export interface MotifSummaryViewState {
  /** Eight byte values copied out of the runtime-owned metrics buffer. */
  readonly bytes: readonly number[];
  readonly count: number;
  readonly carriers: number;
  readonly copiedBytes: number;
}

/** Termination counts for the three causes presented by Reaction State. */
export interface TerminationSummaryViewState {
  readonly interactions: number;
  readonly pointerOffTape: number;
  readonly stepLimit: number;
  readonly unmatchedBracket: number;
}

/** Latest small values needed by the Reaction State panel. */
export interface TelemetryViewState {
  readonly epochsPerSecond: number;
  readonly distinctBytes: number | null;
  readonly distinctTapes: number | null;
  readonly largestIdenticalGroup: number | null;
  readonly motifWindowCount: number | null;
  readonly motifs: readonly MotifSummaryViewState[];
  readonly terminations: TerminationSummaryViewState;
}

/** Latest order measurement only; plot history remains in the canvas adapter. */
export interface OrderSummaryViewState {
  readonly epoch: number | null;
  readonly highOrder: number | null;
  readonly byteFrequencyOrder: number | null;
  readonly zeroOrderEntropy: number | null;
  readonly compressedBitsPerByte: number | null;
}

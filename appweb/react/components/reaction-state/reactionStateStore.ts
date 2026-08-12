import type { EpochStats, Metrics, MotifHit, SoupConfig } from '../../../../engine/src/soup.ts';
import type {
  MotifSummaryViewState,
  TelemetryViewState,
} from '../../runtime/viewState.ts';
import {
  type ImmutableUiSnapshot,
  type ReadonlyExternalStore,
  UiExternalStore,
} from '../../runtime/externalStore.ts';

export interface ReactionStateViewState {
  readonly config: Pick<SoupConfig, 'nTapes' | 'tapeLen'>;
  readonly telemetry: TelemetryViewState;
}

export type ReactionStateSnapshot = ImmutableUiSnapshot<ReactionStateViewState>;

export interface ReactionStateInput {
  readonly nTapes: number;
  readonly tapeLen: number;
  readonly epochsPerSec: number;
  readonly metrics: Pick<
    Metrics,
    'distinctBytes' | 'uniqueTapes' | 'largestLineage' | 'motifs' | 'motifTotal'
  >;
  readonly stats: Pick<EpochStats, 'execs' | 'halts'>;
}

type ReactionStateConfig = Pick<SoupConfig, 'nTapes' | 'tapeLen'>;

function freezeMotif(hit: MotifHit): ImmutableUiSnapshot<MotifSummaryViewState> {
  return Object.freeze({
    bytes: Object.freeze(Array.from(hit.bytes)),
    count: hit.count,
    carriers: hit.carriers,
    copiedBytes: hit.copiedBytes,
  });
}

function freezeSnapshot(
  config: ReactionStateConfig,
  telemetry: TelemetryViewState,
): ReactionStateSnapshot {
  return Object.freeze({
    config: Object.freeze({ nTapes: config.nTapes, tapeLen: config.tapeLen }),
    telemetry: Object.freeze({
      ...telemetry,
      motifs: Object.freeze([...telemetry.motifs]),
      terminations: Object.freeze({ ...telemetry.terminations }),
    }),
  });
}

function emptySnapshot(config: ReactionStateConfig): ReactionStateSnapshot {
  return freezeSnapshot(config, {
    epochsPerSecond: 0,
    distinctBytes: null,
    distinctTapes: null,
    largestIdenticalGroup: null,
    motifWindowCount: null,
    motifs: [],
    terminations: {
      interactions: 0,
      pointerOffTape: 0,
      stepLimit: 0,
      unmatchedBracket: 0,
    },
  });
}

/**
 * Small Reaction State publication boundary.
 *
 * Worker-owned motif byte views are copied before publication. The store keeps
 * no protocol message, population buffer, DOM node, or renderer object.
 */
export class ReactionStateStore implements ReadonlyExternalStore<ReactionStateSnapshot> {
  readonly #store: UiExternalStore<ReactionStateViewState>;

  constructor(config: ReactionStateConfig) {
    this.#store = new UiExternalStore<ReactionStateViewState>(emptySnapshot(config));
  }

  readonly getSnapshot = (): ReactionStateSnapshot => this.#store.getSnapshot();

  readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  reset(config: ReactionStateConfig): void {
    this.#store.publish(emptySnapshot(config));
  }

  acceptSnapshot(snapshot: ReactionStateInput): void {
    const motifs = Object.freeze(snapshot.metrics.motifs.map(freezeMotif));
    this.#store.publish(freezeSnapshot(snapshot, {
      epochsPerSecond: snapshot.epochsPerSec,
      distinctBytes: snapshot.metrics.distinctBytes,
      distinctTapes: snapshot.metrics.uniqueTapes,
      largestIdenticalGroup: snapshot.metrics.largestLineage,
      motifWindowCount: snapshot.metrics.motifTotal,
      motifs,
      terminations: {
        interactions: snapshot.stats.execs,
        pointerOffTape: snapshot.stats.halts[1] ?? 0,
        stepLimit: snapshot.stats.halts[2] ?? 0,
        unmatchedBracket: snapshot.stats.halts[4] ?? 0,
      },
    }));
  }
}

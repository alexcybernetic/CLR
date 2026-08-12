/** A callback invoked after an external store publishes a new snapshot. */
export type StoreListener = () => void;

/**
 * The minimal contract consumed by React's `useSyncExternalStore`.
 *
 * Methods are function properties so they remain safe when passed directly to
 * React without binding them to their owner.
 */
export interface ReadonlyExternalStore<TSnapshot> {
  readonly getSnapshot: () => TSnapshot;
  readonly subscribe: (listener: StoreListener) => () => void;
}

type SnapshotPrimitive = string | number | boolean | bigint | null | undefined;
type BinaryData = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;

/**
 * Converts application state into the data permitted in a React UI snapshot.
 *
 * Snapshots contain small, declarative values only. In particular, binary
 * simulation data such as a soup `Uint8Array` resolves to `never`; it belongs
 * in the imperative display/runtime layer rather than React state.
 */
export type ImmutableUiSnapshot<T> =
  T extends BinaryData ? never
  : T extends CallableFunction ? never
  : T extends SnapshotPrimitive ? T
  : T extends readonly unknown[] ? { readonly [Key in keyof T]: ImmutableUiSnapshot<T[Key]> }
  : T extends object ? { readonly [Key in keyof T]: ImmutableUiSnapshot<T[Key]> }
  : never;

/**
 * Small synchronous external store for immutable UI snapshots.
 *
 * Publication replaces the complete snapshot. Callers must treat every
 * published snapshot and all nested values as immutable. Publishing the same
 * reference is a no-op, matching React's `Object.is` snapshot comparison.
 */
export class UiExternalStore<TState extends object>
implements ReadonlyExternalStore<ImmutableUiSnapshot<TState>> {
  readonly #listeners = new Set<StoreListener>();
  #snapshot: ImmutableUiSnapshot<TState>;

  constructor(initialSnapshot: ImmutableUiSnapshot<TState>) {
    this.#snapshot = initialSnapshot;
  }

  readonly getSnapshot = (): ImmutableUiSnapshot<TState> => this.#snapshot;

  readonly subscribe = (listener: StoreListener): (() => void) => {
    this.#listeners.add(listener);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  };

  /** Replace the current immutable snapshot and synchronously notify listeners. */
  publish(nextSnapshot: ImmutableUiSnapshot<TState>): void {
    if (Object.is(this.#snapshot, nextSnapshot)) return;

    this.#snapshot = nextSnapshot;
    for (const listener of this.#listeners) listener();
  }
}

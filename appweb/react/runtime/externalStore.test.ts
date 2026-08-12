import { describe, expect, it, vi } from 'vitest';

import { UiExternalStore, type ImmutableUiSnapshot } from './externalStore.ts';

interface TestState {
  phase: 'starting' | 'ready';
  epoch: number;
  controls: {
    running: boolean;
  };
}

describe('UiExternalStore', () => {
  it('returns a stable initial snapshot', () => {
    const initial: ImmutableUiSnapshot<TestState> = {
      phase: 'starting',
      epoch: 0,
      controls: { running: false },
    };
    const store = new UiExternalStore<TestState>(initial);

    expect(store.getSnapshot()).toBe(initial);
    expect(store.getSnapshot()).toBe(initial);
  });

  it('publishes the replacement before notifying subscribers', () => {
    const store = new UiExternalStore<TestState>({
      phase: 'starting',
      epoch: 0,
      controls: { running: false },
    });
    const next: ImmutableUiSnapshot<TestState> = {
      phase: 'ready',
      epoch: 1,
      controls: { running: true },
    };
    const observed: ImmutableUiSnapshot<TestState>[] = [];
    store.subscribe(() => observed.push(store.getSnapshot()));

    store.publish(next);

    expect(observed).toEqual([next]);
    expect(store.getSnapshot()).toBe(next);
  });

  it('does not notify for publication of the current reference', () => {
    const initial: ImmutableUiSnapshot<TestState> = {
      phase: 'starting',
      epoch: 0,
      controls: { running: false },
    };
    const store = new UiExternalStore<TestState>(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish(initial);

    expect(listener).not.toHaveBeenCalled();
  });

  it('supports independent and idempotent unsubscription', () => {
    const store = new UiExternalStore<TestState>({
      phase: 'starting',
      epoch: 0,
      controls: { running: false },
    });
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = store.subscribe(removed);
    store.subscribe(retained);

    unsubscribe();
    unsubscribe();
    store.publish({
      phase: 'ready',
      epoch: 1,
      controls: { running: true },
    });

    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });
});

type InvalidBinarySnapshot = ImmutableUiSnapshot<{ soup: Uint8Array }>;
type InvalidSharedBinarySnapshot = ImmutableUiSnapshot<{ soup: SharedArrayBuffer }>;

// The compile-time contract keeps large simulation buffers out of UI state.
// @ts-expect-error A soup buffer is intentionally not a valid UI snapshot value.
const invalidBinarySnapshot: InvalidBinarySnapshot = { soup: new Uint8Array(1) };
void invalidBinarySnapshot;

// @ts-expect-error Shared memory is also runtime-owned binary simulation data.
const invalidSharedBinarySnapshot: InvalidSharedBinarySnapshot = { soup: new SharedArrayBuffer(1) };
void invalidSharedBinarySnapshot;

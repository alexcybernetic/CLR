import { useSyncExternalStore } from 'react';

import type { ReadonlyExternalStore } from './externalStore.ts';

/** Subscribe a React component to a framework-independent external store. */
export function useExternalStoreSnapshot<TSnapshot>(
  store: ReadonlyExternalStore<TSnapshot>,
): TSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

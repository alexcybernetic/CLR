import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type {
  ImmutableUiSnapshot,
  ReadonlyExternalStore,
} from '../../runtime/externalStore.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { ApplicationFrame } from './ApplicationFrame.tsx';

export interface ApplicationFrameState {
  readonly started: boolean;
  readonly fatalMessage: string | null;
}

export type ApplicationFrameStore = ReadonlyExternalStore<
  ImmutableUiSnapshot<ApplicationFrameState>
>;

function ConnectedApplicationFrame({ store }: { readonly store: ApplicationFrameStore }) {
  return <ApplicationFrame {...useExternalStoreSnapshot(store)} />;
}

/** Commit every production host before feature roots query or mount into them. */
export function mountApplicationFrame(
  container: HTMLElement,
  store: ApplicationFrameStore,
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(<ConnectedApplicationFrame store={store} />));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

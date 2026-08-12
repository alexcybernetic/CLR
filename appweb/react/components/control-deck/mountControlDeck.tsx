import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { HelpWindowController } from '../../help/helpController.ts';
import type {
  ImmutableUiSnapshot,
  ReadonlyExternalStore,
} from '../../runtime/externalStore.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import {
  ControlDeck,
  type ControlDeckActions,
  type ControlDeckViewState,
} from './ControlDeck.tsx';

export type ControlDeckStore = ReadonlyExternalStore<
  ImmutableUiSnapshot<ControlDeckViewState>
>;

export interface MountControlDeckOptions {
  readonly store: ControlDeckStore;
  readonly help: HelpWindowController;
  readonly actions: ControlDeckActions;
}

function ConnectedControlDeck({ store, help, actions }: MountControlDeckOptions) {
  const state = useExternalStoreSnapshot(store);
  const helpSnapshot = useExternalStoreSnapshot(help);
  return (
    <ControlDeck
      state={state}
      help={{ open: helpSnapshot.open, topic: helpSnapshot.topic }}
      actions={actions}
    />
  );
}

/** Mount the production setup/run-control deck synchronously. */
export function mountControlDeck(
  container: HTMLElement,
  options: MountControlDeckOptions,
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(<ConnectedControlDeck {...options} />));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

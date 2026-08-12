import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { HelpWindowController } from '../../help/helpController.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { ReactionStatePanel } from './ReactionState.tsx';
import type { ReactionStateStore } from './reactionStateStore.ts';

export interface MountReactionStateOptions {
  readonly help: HelpWindowController;
  readonly onLayoutChange?: () => void;
}

function ConnectedReactionState({
  store,
  help,
  onLayoutChange,
}: {
  readonly store: ReactionStateStore;
} & MountReactionStateOptions) {
  const helpSnapshot = useExternalStoreSnapshot(help);
  const toggleHelp = useCallback(() => help.toggle('state'), [help]);
  return (
    <ReactionStatePanel
      snapshot={useExternalStoreSnapshot(store)}
      helpPressed={helpSnapshot.open && helpSnapshot.topic === 'state'}
      onLayoutChange={onLayoutChange}
      onHelp={toggleHelp}
    />
  );
}

/** Mount the complete production Reaction State panel synchronously. */
export function mountReactionState(
  container: HTMLElement,
  store: ReactionStateStore,
  options: MountReactionStateOptions,
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(
    <ConnectedReactionState store={store} {...options} />,
  ));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

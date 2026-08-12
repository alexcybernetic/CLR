import { memo, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { HelpWindowController } from '../../help/helpController.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { ApplicationHeaderContent } from './ApplicationHeader.tsx';

export interface MountApplicationHeaderOptions {
  readonly version: string;
  readonly help: HelpWindowController;
}

type ConnectedApplicationHeaderProps = MountApplicationHeaderOptions;

const StableApplicationHeaderContent = memo(ApplicationHeaderContent);

function ConnectedApplicationHeader({ version, help }: ConnectedApplicationHeaderProps) {
  const snapshot = useExternalStoreSnapshot(help);
  const toggleHelp = useCallback(() => help.toggle('fundamentals'), [help]);

  return (
    <StableApplicationHeaderContent
      version={version}
      helpPressed={snapshot.open && snapshot.topic === 'fundamentals'}
      onHelp={toggleHelp}
    />
  );
}

/** Mount the production header synchronously before imperative startup queries run. */
export function mountApplicationHeader(
  container: HTMLElement,
  options: MountApplicationHeaderOptions,
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(<ConnectedApplicationHeader {...options} />));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import type { RunsController } from './runsController.ts';
import { RunsWindow } from './RunsWindow.tsx';

export interface MountRunsWindowOptions {
  readonly resolveFocusFallback?: () => HTMLElement | null;
}

function ConnectedRunsWindow({
  controller,
  resolveFocusFallback,
}: {
  readonly controller: RunsController;
} & MountRunsWindowOptions) {
  return (
    <RunsWindow
      controller={controller}
      snapshot={useExternalStoreSnapshot(controller)}
      resolveFocusFallback={resolveFocusFallback}
    />
  );
}

/** Mount the production Runs/Records window synchronously. */
export function mountRunsWindow(
  container: HTMLElement,
  controller: RunsController,
  options: MountRunsWindowOptions = {},
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(
    <ConnectedRunsWindow controller={controller} {...options} />,
  ));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

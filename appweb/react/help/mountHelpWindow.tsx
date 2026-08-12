import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { HelpWindow } from './HelpWindow.tsx';
import type { HelpWindowController } from './helpController.ts';

export interface MountHelpWindowOptions {
  readonly resolveFocusFallback?: () => HTMLElement | null;
}

/** Mount the manual synchronously before startup can transfer focus into it. */
export function mountHelpWindow(
  container: HTMLElement,
  controller: HelpWindowController,
  options: MountHelpWindowOptions = {},
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(
    <HelpWindow
      controller={controller}
      resolveFocusFallback={options.resolveFocusFallback}
    />,
  ));

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

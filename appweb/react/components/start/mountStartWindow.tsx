import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { StartWindow } from './StartWindow.tsx';

export interface MountStartWindowOptions {
  readonly version: string;
  readonly onStart: () => void;
}

function ConnectedStartWindow({ version, onStart }: MountStartWindowOptions) {
  const [started, setStarted] = useState(false);
  const start = useCallback(() => {
    onStart();
    setStarted(true);
  }, [onStart]);
  return started ? null : <StartWindow version={version} onStart={start} />;
}

/** Mount the required production preflight synchronously. */
export function mountStartWindow(
  container: HTMLElement,
  options: MountStartWindowOptions,
): () => void {
  const root = createRoot(container);
  flushSync(() => root.render(<ConnectedStartWindow {...options} />));
  document.body.classList.remove('boot-pending');

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
  };
}

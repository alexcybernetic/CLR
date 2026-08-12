import { createRef, memo, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { HelpWindowController } from '../../help/helpController.ts';
import type { OrderSummaryViewState } from '../../runtime/viewState.ts';
import type {
  ImmutableUiSnapshot,
  ReadonlyExternalStore,
} from '../../runtime/externalStore.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { Order } from './Order.tsx';

export type OrderSummaryStore = ReadonlyExternalStore<
  ImmutableUiSnapshot<OrderSummaryViewState>
>;

export interface MountOrderOptions {
  readonly help: HelpWindowController;
  readonly store: OrderSummaryStore;
}

export interface MountedOrder {
  /** Permanent renderer host committed by the synchronous initial render. */
  readonly canvas: HTMLCanvasElement;
  readonly dispose: () => void;
}

const StableOrder = memo(Order);

function ConnectedOrder({
  canvasRef,
  help,
  store,
}: MountOrderOptions & {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  const summary = useExternalStoreSnapshot(store);
  const helpSnapshot = useExternalStoreSnapshot(help);
  const toggleHelp = useCallback(() => help.toggle('order'), [help]);

  return (
    <StableOrder
      canvasRef={canvasRef}
      helpPressed={helpSnapshot.open && helpSnapshot.topic === 'order'}
      summary={summary}
      onHelp={toggleHelp}
    />
  );
}

/** Mount the complete production Order panel synchronously. */
export function mountOrder(container: HTMLElement, options: MountOrderOptions): MountedOrder {
  const root = createRoot(container);
  const canvasRef = createRef<HTMLCanvasElement>();
  flushSync(() => root.render(<ConnectedOrder {...options} canvasRef={canvasRef} />));

  const canvas = canvasRef.current;
  if (!canvas) {
    root.unmount();
    throw new Error('Order mount did not commit its canvas');
  }

  let mounted = true;
  return {
    canvas,
    dispose: () => {
      if (!mounted) return;
      mounted = false;
      root.unmount();
    },
  };
}

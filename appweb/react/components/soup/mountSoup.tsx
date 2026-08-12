import {
  createRef,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  type DisplayCoordinator,
  type SoupDisplayMode,
} from '../../../runtime/displayCoordinator.ts';
import type { HelpWindowController } from '../../help/helpController.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { Soup } from './Soup.tsx';

export interface MountSoupOptions {
  readonly display: DisplayCoordinator;
  readonly help: HelpWindowController;
  readonly legendContainer: HTMLElement;
  /** Called after a user-originated mode request reaches the coordinator. */
  readonly onModeChange?: (mode: SoupDisplayMode) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
}

export interface MountedSoup {
  readonly canvas: HTMLCanvasElement;
  readonly dispose: () => void;
}

type ConnectedSoupProps = MountSoupOptions & {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
};

const StableSoup = memo(Soup);

function ConnectedSoup({
  canvasRef,
  display,
  help,
  legendContainer,
  onModeChange,
  onExpandedChange,
}: ConnectedSoupProps) {
  const displaySnapshot = useExternalStoreSnapshot(display);
  const helpSnapshot = useExternalStoreSnapshot(help);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const downPoint = useRef({ x: 0, y: 0 });

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
    };
  }, [canvasRef]);

  const canvasDelta = useCallback((dx: number, dy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: dx * (canvas.width / Math.max(1, rect.width)),
      y: dy * (canvas.height / Math.max(1, rect.height)),
    };
  }, [canvasRef]);

  const setMode = useCallback((mode: SoupDisplayMode) => {
    display.setSoupMode(mode);
    onModeChange?.(display.getSnapshot().soup.mode);
  }, [display, onModeChange]);

  const setExpandedState = useCallback((next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(next);
  }, [onExpandedChange]);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const onWheel = (event: WheelEvent) => {
      // React delegates wheel events through a passive root listener in
      // Chromium. This native non-passive boundary makes Soup navigation own
      // the gesture, so zooming or ranked-list scrolling cannot scroll #fitter.
      event.preventDefault();
      event.stopPropagation();
      if (display.getSnapshot().soup.mode === 'counts') {
        display.scrollSoup(event.deltaY);
        return;
      }
      const point = canvasPoint(event.clientX, event.clientY);
      display.zoomSoup(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
    };
    screen.addEventListener('wheel', onWheel, { passive: false });
    return () => screen.removeEventListener('wheel', onWheel);
  }, [canvasPoint, display]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (display.getSnapshot().soup.mode === 'counts') {
      const point = canvasPoint(event.clientX, event.clientY);
      if (display.soupPointerDown(point.x, point.y)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    setDragging(true);
    lastPoint.current = { x: event.clientX, y: event.clientY };
    downPoint.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [canvasPoint, display]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (display.getSnapshot().soup.mode === 'counts') {
      const point = canvasPoint(event.clientX, event.clientY);
      display.soupPointerMove(point.x, point.y);
      return;
    }
    if (!dragging) return;
    const delta = canvasDelta(
      event.clientX - lastPoint.current.x,
      event.clientY - lastPoint.current.y,
    );
    display.panSoup(delta.x, delta.y);
    lastPoint.current = { x: event.clientX, y: event.clientY };
  }, [canvasDelta, canvasPoint, display, dragging]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (display.getSnapshot().soup.mode === 'counts') {
      display.soupPointerUp();
      return;
    }
    setDragging(false);
    if (display.getSnapshot().sampler.selectionMode !== 'pick') return;
    if (
      Math.abs(event.clientX - downPoint.current.x) > 4 ||
      Math.abs(event.clientY - downPoint.current.y) > 4
    ) return;
    const point = canvasPoint(event.clientX, event.clientY);
    display.pickTapeAt(point.x, point.y);
  }, [canvasPoint, display]);

  const onPointerCancel = useCallback(() => {
    display.soupPointerUp();
    setDragging(false);
  }, [display]);

  const onDoubleClick = useCallback(() => {
    const snapshot = display.getSnapshot();
    if (snapshot.soup.mode !== 'counts' && snapshot.sampler.selectionMode !== 'pick') {
      display.resetSoupView();
    }
  }, [display]);

  const fit = useCallback(() => display.resetSoupView(), [display]);
  const toggleHelp = useCallback(() => help.toggle('soup'), [help]);

  return (
    <StableSoup
      canvasRef={canvasRef}
      screenRef={screenRef}
      dragging={dragging}
      expanded={expanded}
      helpPressed={helpSnapshot.open && helpSnapshot.topic === 'soup'}
      legendContainer={legendContainer}
      mode={displaySnapshot.soup.mode}
      selectionMode={displaySnapshot.sampler.selectionMode}
      viewNote={displaySnapshot.soup.viewNote}
      onDoubleClick={onDoubleClick}
      onExpandedChange={setExpandedState}
      onFit={fit}
      onHelp={toggleHelp}
      onModeChange={setMode}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

/** Mount the complete production Soup panel synchronously. */
export function mountSoup(
  container: HTMLElement,
  options: MountSoupOptions,
): MountedSoup {
  const root = createRoot(container);
  const canvasRef = createRef<HTMLCanvasElement>();
  flushSync(() => root.render(<ConnectedSoup {...options} canvasRef={canvasRef} />));

  const canvas = canvasRef.current;
  if (!canvas) {
    root.unmount();
    throw new Error('Soup mount did not commit its canvas');
  }

  let mounted = true;
  return {
    canvas,
    dispose: () => {
      if (!mounted) return;
      mounted = false;
      document.body.classList.remove('soup-expanded');
      root.unmount();
    },
  };
}

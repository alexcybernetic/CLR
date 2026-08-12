import {
  type Ref,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export interface FloatingWindowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingWindowIds {
  window?: string;
  bar?: string;
  title?: string;
  close?: string;
  navigation?: string;
  body?: string;
}

export interface FloatingWindowProps {
  open: boolean;
  ariaLabel: string;
  caption: ReactNode;
  title?: ReactNode;
  navigation?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
  ids?: FloatingWindowIds;
  bodyRef?: Ref<HTMLDivElement>;
  initialBox?: Partial<FloatingWindowBox> | null;
  initialSide?: 'left' | 'right';
  resolveFocusFallback?: () => HTMLElement | null;
  onClose: () => void;
  onBoxChange?: (box: FloatingWindowBox) => void;
}

const DEFAULT_W = 430;
const DEFAULT_H = 560;
const MIN_W = 300;
const MIN_H = 200;
const VIEWPORT_GAP = 20;
const INITIAL_EDGE = 22;
const INITIAL_TOP = 84;
/** Minimum horizontal portion of the title bar kept reachable. */
const KEEP_X = 80;
/** Approximate title-bar height kept reachable vertically. */
const KEEP_Y = 28;
const WINDOW_Z = 60;
const FRONT_WINDOW_Z = 61;

let frontWindow: HTMLElement | null = null;
const selectionLocks = new WeakMap<Document, { count: number; prevent: EventListener }>();

function bringToFront(windowElement: HTMLElement): void {
  if (frontWindow === windowElement) return;
  if (frontWindow?.isConnected) frontWindow.style.zIndex = String(WINDOW_Z);
  windowElement.style.zIndex = String(FRONT_WINDOW_Z);
  frontWindow = windowElement;
}

function lockTextSelection(ownerDocument: Document): () => void {
  const existing = selectionLocks.get(ownerDocument);
  if (existing) {
    existing.count += 1;
  } else {
    const prevent: EventListener = (event) => event.preventDefault();
    ownerDocument.addEventListener('selectstart', prevent);
    selectionLocks.set(ownerDocument, { count: 1, prevent });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = selectionLocks.get(ownerDocument);
    if (!current) return;
    if (current.count > 1) {
      current.count -= 1;
      return;
    }
    ownerDocument.removeEventListener('selectstart', current.prevent);
    selectionLocks.delete(ownerDocument);
  };
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function initialGeometry(box: Partial<FloatingWindowBox> | null | undefined): FloatingWindowBox {
  return {
    x: finite(box?.x) ? box.x : 0,
    y: finite(box?.y) ? box.y : INITIAL_TOP,
    w: finite(box?.w) && box.w >= MIN_W ? box.w : DEFAULT_W,
    h: finite(box?.h) && box.h >= MIN_H ? box.h : DEFAULT_H,
  };
}

function viewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: DEFAULT_W, height: DEFAULT_H };
  return { width: window.innerWidth, height: window.innerHeight };
}

function fitSize(w: number, h: number): Pick<FloatingWindowBox, 'w' | 'h'> {
  const viewport = viewportSize();
  const maximumWidth = Math.max(MIN_W, viewport.width - VIEWPORT_GAP);
  const maximumHeight = Math.max(MIN_H, viewport.height - VIEWPORT_GAP);
  return {
    w: Math.min(Math.max(MIN_W, w), maximumWidth),
    h: Math.min(Math.max(MIN_H, h), maximumHeight),
  };
}

function clampPosition(x: number, y: number, w: number): Pick<FloatingWindowBox, 'x' | 'y'> {
  const viewport = viewportSize();
  return {
    x: Math.max(KEEP_X - w, Math.min(viewport.width - KEEP_X, x)),
    y: Math.max(0, Math.min(viewport.height - KEEP_Y, y)),
  };
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return element !== null
    && element.isConnected
    && element !== element.ownerDocument.body
    && element !== element.ownerDocument.documentElement
    && !element.matches(':disabled')
    && element.closest('[hidden], [inert]') === null;
}

/**
 * Shared draggable and pointer-resizable shell for auxiliary CLR windows.
 *
 * Visibility is controlled by the caller. Geometry intentionally remains in
 * the DOM during a drag so pointer movement does not rerender domain content.
 */
export function FloatingWindow({
  open,
  ariaLabel,
  caption,
  title,
  navigation,
  children,
  className,
  bodyClassName,
  closeLabel = `close ${ariaLabel}`,
  ids,
  bodyRef,
  initialBox,
  initialSide = 'right',
  resolveFocusFallback,
  onClose,
  onBoxChange,
}: FloatingWindowProps) {
  const winRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<FloatingWindowBox>(initialGeometry(initialBox));
  const hasInitialPosition = useRef(finite(initialBox?.x) && finite(initialBox?.y));
  const placed = useRef(false);
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const onBoxChangeRef = useRef(onBoxChange);
  const resolveFocusFallbackRef = useRef(resolveFocusFallback);
  const wasOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const releaseSelectionLock = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  const beginInteraction = useCallback((): void => {
    if (releaseSelectionLock.current || !winRef.current) return;
    releaseSelectionLock.current = lockTextSelection(winRef.current.ownerDocument);
  }, []);

  const endInteraction = useCallback((): void => {
    releaseSelectionLock.current?.();
    releaseSelectionLock.current = null;
  }, []);

  useEffect(() => {
    onBoxChangeRef.current = onBoxChange;
  }, [onBoxChange]);

  useLayoutEffect(() => {
    resolveFocusFallbackRef.current = resolveFocusFallback;
  }, [resolveFocusFallback]);

  const restoreFocus = useCallback((): void => {
    const captured = opener.current;
    const target = canRestoreFocus(captured)
      ? captured
      : resolveFocusFallbackRef.current?.() ?? null;
    if (canRestoreFocus(target)) target.focus({ preventScroll: true });
    opener.current = null;
  }, []);

  useLayoutEffect(() => {
    if (placed.current) return;
    boxRef.current = initialGeometry(initialBox);
    hasInitialPosition.current = finite(initialBox?.x) && finite(initialBox?.y);
  }, [initialBox]);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      opener.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (winRef.current) bringToFront(winRef.current);
      closeRef.current?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current) {
      if (frontWindow === winRef.current) frontWindow = null;
      endInteraction();
      restoreFocus();
    }
    wasOpen.current = open;
  }, [endInteraction, open, restoreFocus]);

  useEffect(() => () => {
    if (frontWindow === winRef.current) frontWindow = null;
    endInteraction();
    if (wasOpen.current) restoreFocus();
    else opener.current = null;
    // Keep React Strict Mode's setup/cleanup replay equivalent to a fresh mount.
    wasOpen.current = false;
  }, [endInteraction, restoreFocus]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !winRef.current?.contains(document.activeElement)
      ) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const readBox = useCallback((): FloatingWindowBox => {
    const win = winRef.current;
    if (!win) return { ...boxRef.current };
    return {
      ...boxRef.current,
      w: win.offsetWidth || boxRef.current.w,
      h: win.offsetHeight || boxRef.current.h,
    };
  }, []);

  const writePosition = useCallback((x: number, y: number): void => {
    const win = winRef.current;
    const size = readBox();
    const next = clampPosition(x, y, size.w);
    boxRef.current = { ...size, ...next };
    if (win) {
      win.style.left = `${next.x}px`;
      win.style.top = `${next.y}px`;
    }
  }, [readBox]);

  const reportBox = useCallback((): void => {
    boxRef.current = readBox();
    onBoxChangeRef.current?.({ ...boxRef.current });
  }, [readBox]);

  useLayoutEffect(() => {
    if (!open) return;
    const win = winRef.current;
    if (!win) return;

    let firstPlacement = false;
    if (!placed.current) {
      const fitted = fitSize(boxRef.current.w, boxRef.current.h);
      boxRef.current = { ...boxRef.current, ...fitted };
      win.style.width = `${fitted.w}px`;
      win.style.height = `${fitted.h}px`;
      if (!hasInitialPosition.current) {
        boxRef.current.x = initialSide === 'left'
          ? INITIAL_EDGE
          : viewportSize().width - fitted.w - INITIAL_EDGE;
        boxRef.current.y = INITIAL_TOP;
      }
      placed.current = true;
      firstPlacement = true;
    }

    writePosition(boxRef.current.x, boxRef.current.y);
    if (firstPlacement) reportBox();
  }, [initialSide, open, reportBox, writePosition]);

  useEffect(() => {
    if (!open) return;
    const win = winRef.current;
    if (!win) return;

    const onViewportResize = () => {
      writePosition(boxRef.current.x, boxRef.current.y);
      reportBox();
    };
    window.addEventListener('resize', onViewportResize);

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const next = readBox();
          const sizeChanged = next.w !== boxRef.current.w || next.h !== boxRef.current.h;
          boxRef.current = next;
          if (sizeChanged) {
            writePosition(next.x, next.y);
            reportBox();
          }
        });
    observer?.observe(win);

    return () => {
      window.removeEventListener('resize', onViewportResize);
      observer?.disconnect();
    };
  }, [open, readBox, reportBox, writePosition]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    endInteraction();
    setDragging(false);
    reportBox();
  }, [endInteraction, reportBox]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      event.button !== 0
      || drag.current !== null
      || resize.current !== null
      || (event.target as HTMLElement).closest('button, a, input, select')
    ) {
      return;
    }
    event.preventDefault();
    const box = readBox();
    drag.current = {
      pointerId: event.pointerId,
      dx: event.clientX - box.x,
      dy: event.clientY - box.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginInteraction();
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    writePosition(event.clientX - active.dx, event.clientY - active.dy);
  };

  const handleWindowPointerDownCapture = (event: ReactPointerEvent<HTMLElement>): void => {
    const win = winRef.current;
    if (win) bringToFront(win);
    const target = event.target;
    if (
      target instanceof Element
      && target.closest('button, a, input, select, textarea, [contenteditable="true"]')
    ) return;
    win?.focus({ preventScroll: true });
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag.current !== null || resize.current !== null) return;
    event.preventDefault();
    const box = readBox();
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startW: box.w,
      startH: box.h,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginInteraction();
    event.stopPropagation();
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = resize.current;
    const win = winRef.current;
    if (!active || active.pointerId !== event.pointerId || !win) return;
    event.preventDefault();
    const size = fitSize(
      active.startW + event.clientX - active.startX,
      active.startH + event.clientY - active.startY,
    );
    boxRef.current = { ...boxRef.current, ...size };
    win.style.width = `${size.w}px`;
    win.style.height = `${size.h}px`;
    writePosition(boxRef.current.x, boxRef.current.y);
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = resize.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resize.current = null;
    endInteraction();
    reportBox();
  };

  const box = boxRef.current;

  return (
    <aside
      ref={winRef}
      id={ids?.window}
      className={classNames('helpwin', className, dragging && 'dragging')}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      hidden={!open}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onPointerDownCapture={handleWindowPointerDownCapture}
    >
      <div
        id={ids?.bar}
        className="helpwin-bar"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        <span className="helpwin-cap">{caption}</span>
        <span id={ids?.title} className="helpwin-title">{title}</span>
        <button
          ref={closeRef}
          id={ids?.close}
          className="helpwin-x"
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {navigation === undefined
        ? null
        : <nav id={ids?.navigation} className="helpwin-nav">{navigation}</nav>}
      <div
        ref={bodyRef}
        id={ids?.body}
        className={classNames('helpwin-body', bodyClassName)}
      >
        {children}
      </div>
      <div
        className="helpwin-resize"
        data-window-resize
        aria-hidden="true"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
      />
    </aside>
  );
}

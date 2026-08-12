import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FloatingWindow } from './FloatingWindow.tsx';

describe('FloatingWindow', () => {
  it('restores dimensions and clamps a stored position to the viewport', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });

    try {
      render(
        <FloatingWindow
          open
          ariaLabel="experiment runs"
          caption="runs"
          initialBox={{ x: 900, y: -40, w: 400, h: 500 }}
          onClose={() => undefined}
        >
          Runs
        </FloatingWindow>,
      );

      const dialog = screen.getByRole('dialog', { name: 'experiment runs' });
      expect(dialog.style.width).toBe('400px');
      expect(dialog.style.height).toBe('500px');
      expect(dialog.style.left).toBe('720px');
      expect(dialog.style.top).toBe('0px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  it('uses the latest box supplied before first open and reports its fitted placement', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const onBoxChange = vi.fn();

    try {
      const { rerender } = render(
        <FloatingWindow
          open={false}
          ariaLabel="reactor manual"
          caption="manual"
          initialBox={{ x: 40, y: 50, w: 430, h: 560 }}
          onClose={() => undefined}
          onBoxChange={onBoxChange}
        >
          Manual
        </FloatingWindow>,
      );

      rerender(
        <FloatingWindow
          open
          ariaLabel="reactor manual"
          caption="manual"
          initialBox={{ x: 900, y: -40, w: 900, h: 900 }}
          onClose={() => undefined}
          onBoxChange={onBoxChange}
        >
          Manual
        </FloatingWindow>,
      );

      const dialog = screen.getByRole('dialog', { name: 'reactor manual' });
      expect(dialog.style.width).toBe('780px');
      expect(dialog.style.height).toBe('580px');
      expect(dialog.style.left).toBe('720px');
      expect(dialog.style.top).toBe('0px');
      expect(onBoxChange).toHaveBeenLastCalledWith({ x: 720, y: 0, w: 780, h: 580 });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  it('uses pointer capture for dragging and resizing and reports final geometry', () => {
    const onBoxChange = vi.fn();
    const { container } = render(
      <FloatingWindow
        open
        ariaLabel="reactor manual"
        caption="manual"
        initialBox={{ x: 100, y: 80, w: 430, h: 560 }}
        onClose={() => undefined}
        onBoxChange={onBoxChange}
      >
        Manual
      </FloatingWindow>,
    );
    const dialog = screen.getByRole('dialog', { name: 'reactor manual' });
    const bar = container.querySelector('.helpwin-bar') as HTMLDivElement;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    bar.setPointerCapture = setPointerCapture;
    bar.releasePointerCapture = releasePointerCapture;
    bar.hasPointerCapture = () => true;

    fireEvent.pointerDown(bar, { button: 0, pointerId: 7, clientX: 120, clientY: 100 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    const selectionDuringDrag = new Event('selectstart', { cancelable: true });
    document.dispatchEvent(selectionDuringDrag);
    expect(selectionDuringDrag.defaultPrevented).toBe(true);

    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 220, clientY: 180 });
    expect(dialog.style.left).toBe('200px');
    expect(dialog.style.top).toBe('160px');

    fireEvent.pointerUp(bar, { pointerId: 7, clientX: 220, clientY: 180 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onBoxChange).toHaveBeenLastCalledWith({ x: 200, y: 160, w: 430, h: 560 });
    const selectionAfterDrag = new Event('selectstart', { cancelable: true });
    document.dispatchEvent(selectionAfterDrag);
    expect(selectionAfterDrag.defaultPrevented).toBe(false);

    const resize = container.querySelector('[data-window-resize]') as HTMLDivElement;
    resize.setPointerCapture = setPointerCapture;
    resize.releasePointerCapture = releasePointerCapture;
    resize.hasPointerCapture = () => true;
    fireEvent.pointerDown(resize, { button: 0, pointerId: 8, clientX: 630, clientY: 720 });
    const selectionDuringResize = new Event('selectstart', { cancelable: true });
    document.dispatchEvent(selectionDuringResize);
    expect(selectionDuringResize.defaultPrevented).toBe(true);
    fireEvent.pointerMove(resize, { pointerId: 8, clientX: 730, clientY: 770 });
    expect(dialog.style.width).toBe('530px');
    expect(dialog.style.height).toBe('610px');
    fireEvent.pointerUp(resize, { pointerId: 8, clientX: 730, clientY: 770 });
    expect(onBoxChange).toHaveBeenLastCalledWith({ x: 200, y: 160, w: 530, h: 610 });
    const selectionAfterResize = new Event('selectstart', { cancelable: true });
    document.dispatchEvent(selectionAfterResize);
    expect(selectionAfterResize.defaultPrevented).toBe(false);
  });

  it('reclamps an open window when the viewport shrinks', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const onBoxChange = vi.fn();

    try {
      render(
        <FloatingWindow
          open
          ariaLabel="experiment runs"
          caption="runs"
          initialBox={{ x: 600, y: 500, w: 400, h: 500 }}
          onClose={() => undefined}
          onBoxChange={onBoxChange}
        >
          Runs
        </FloatingWindow>,
      );
      const dialog = screen.getByRole('dialog', { name: 'experiment runs' });

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
      fireEvent(window, new Event('resize'));

      expect(dialog.style.left).toBe('420px');
      expect(dialog.style.top).toBe('272px');
      expect(onBoxChange).toHaveBeenLastCalledWith({ x: 420, y: 272, w: 400, h: 500 });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  it('does not start a drag from the close control', () => {
    const onBoxChange = vi.fn();
    const { container } = render(
      <FloatingWindow
        open
        ariaLabel="reactor manual"
        caption="manual"
        onClose={() => undefined}
        onBoxChange={onBoxChange}
      >
        Manual
      </FloatingWindow>,
    );
    const close = screen.getByRole('button', { name: 'close reactor manual' });
    const bar = container.querySelector('.helpwin-bar');
    if (!bar) throw new Error('window title bar was not rendered');
    onBoxChange.mockClear();

    fireEvent.pointerDown(close, { button: 0, pointerId: 4, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(bar, { pointerId: 4, clientX: 100, clientY: 100 });
    expect(onBoxChange).not.toHaveBeenCalled();
  });

  it('focuses the close control, closes on Escape, and restores opener focus', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open manual</button>
          <FloatingWindow
            open={open}
            ariaLabel="reactor manual"
            caption="manual"
            onClose={() => setOpen(false)}
          >
            Manual
          </FloatingWindow>
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open manual' });
    opener.focus();
    fireEvent.click(opener);

    const close = screen.getByRole('button', { name: 'close reactor manual' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { hidden: true }).hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('uses the focus fallback when the captured opener becomes hidden', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open manual</button>
          <button id="fallback" type="button">reactor run</button>
          <FloatingWindow
            open={open}
            ariaLabel="reactor manual"
            caption="reactor manual"
            resolveFocusFallback={() => document.querySelector<HTMLElement>('#fallback')}
            onClose={() => setOpen(false)}
          >
            Manual
          </FloatingWindow>
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open manual' });
    opener.focus();
    fireEvent.click(opener);
    opener.hidden = true;
    fireEvent.click(screen.getByRole('button', { name: 'close reactor manual' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'reactor run' }));
  });

  it('keeps Escape ownership after non-interactive window content is pressed', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <FloatingWindow
          open={open}
          ariaLabel="reactor manual"
          caption="reactor manual"
          onClose={() => setOpen(false)}
        >
          <p>Manual text</p>
        </FloatingWindow>
      );
    }

    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'reactor manual' });
    fireEvent.pointerDown(screen.getByText('Manual text'));
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { hidden: true }).hidden).toBe(true);
  });

  it('closes only the focused window when multiple dialogs are open', () => {
    function Harness() {
      const [manualOpen, setManualOpen] = useState(false);
      const [runsOpen, setRunsOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setManualOpen(true)}>open manual</button>
          <button type="button" onClick={() => setRunsOpen(true)}>open runs</button>
          <FloatingWindow
            open={manualOpen}
            ariaLabel="reactor manual"
            caption="manual"
            onClose={() => setManualOpen(false)}
          >
            Manual
          </FloatingWindow>
          <FloatingWindow
            open={runsOpen}
            ariaLabel="experiment runs"
            caption="runs"
            onClose={() => setRunsOpen(false)}
          >
            Runs
          </FloatingWindow>
        </>
      );
    }

    render(<Harness />);
    const manualOpener = screen.getByRole('button', { name: 'open manual' });
    manualOpener.focus();
    fireEvent.click(manualOpener);
    const runsOpener = screen.getByRole('button', { name: 'open runs' });
    runsOpener.focus();
    fireEvent.click(runsOpener);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close experiment runs' }));
    const manualDialog = screen.getByRole('dialog', { name: 'reactor manual' });
    const runsDialog = screen.getByRole('dialog', { name: 'experiment runs' });
    expect(Number(runsDialog.style.zIndex)).toBeGreaterThan(Number(manualDialog.style.zIndex));
    fireEvent.pointerDown(manualDialog);
    expect(Number(manualDialog.style.zIndex)).toBeGreaterThan(Number(runsDialog.style.zIndex));
    fireEvent.pointerDown(runsDialog);
    fireEvent.keyDown(window, { key: 'Escape' });

    const closedRunsDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="experiment runs"]',
    );
    expect(closedRunsDialog?.hidden).toBe(true);
    expect(screen.getByRole('dialog', { name: 'reactor manual' }).hidden).toBe(false);
    expect(document.activeElement).toBe(runsOpener);
  });
});

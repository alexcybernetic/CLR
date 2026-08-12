import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StartWindow } from './StartWindow.tsx';

describe('StartWindow', () => {
  it('delegates the explicit start action once and disables repeat submission', () => {
    const onStart = vi.fn<() => void>();
    render(<StartWindow version="fixture" onStart={onStart} />);

    const button = document.querySelector<HTMLButtonElement>('#btnStart');
    if (!button) throw new Error('start control was not rendered');
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledOnce();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('#startWindow')).not.toBeNull();
  });

  it('blocks Escape and cycles focus through the dialog controls', () => {
    render(<StartWindow version="fixture" onStart={() => undefined} />);

    const layer = document.querySelector<HTMLElement>('#startLayer');
    const first = document.querySelector<HTMLAnchorElement>('#startWindow a[href]');
    const last = document.querySelector<HTMLButtonElement>('#btnStart');
    if (!layer || !first || !last) throw new Error('start focus boundary was not rendered');

    expect(fireEvent.keyDown(layer, { key: 'Escape' })).toBe(false);

    last.focus();
    expect(fireEvent.keyDown(layer, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);

    first.focus();
    expect(fireEvent.keyDown(layer, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });
});

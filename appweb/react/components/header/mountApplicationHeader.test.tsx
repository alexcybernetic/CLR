import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HelpWindowController } from '../../help/helpController.ts';
import { mountApplicationHeader } from './mountApplicationHeader.tsx';

describe('mountApplicationHeader', () => {
  it('commits the production header synchronously and derives Help state', () => {
    const container = document.createElement('header');
    container.className = 'head';
    container.id = 'headerRoot';
    document.body.append(container);
    const help = new HelpWindowController({ viewportWidth: 1200 });
    const dispose = mountApplicationHeader(container, { version: 'fixture', help });

    const button = container.querySelector<HTMLButtonElement>('#btnHelp');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button!);
    expect(help.getSnapshot()).toMatchObject({ open: true, topic: 'fundamentals' });
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    act(() => help.open('compute'));
    expect(button?.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button!);
    expect(help.getSnapshot()).toMatchObject({ open: true, topic: 'fundamentals' });
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      dispose();
      dispose();
    });
    expect(container.childElementCount).toBe(0);
    container.remove();
  });
});

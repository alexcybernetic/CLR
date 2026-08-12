import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HelpWindow } from './HelpWindow.tsx';
import { HelpWindowController } from './helpController.ts';
import { mountHelpWindow } from './mountHelpWindow.tsx';

function createController(): HelpWindowController {
  return new HelpWindowController({
    viewportWidth: 1200,
    initialBox: { x: 748, y: 84, w: 430, h: 560 },
  });
}

describe('HelpWindow', () => {
  it('opens, changes topics, resets body scrolling, and closes through the controller', () => {
    const controller = createController();
    render(<HelpWindow controller={controller} />);

    act(() => controller.open('fundamentals'));
    const dialog = document.querySelector<HTMLElement>('#helpWin');
    expect(dialog?.hidden).toBe(false);

    const body = document.querySelector<HTMLDivElement>('#helpBody');
    expect(body).not.toBeNull();
    if (!body) return;
    body.scrollTop = 180;

    const compute = document.querySelector<HTMLButtonElement>('[data-topic="compute"]');
    if (!compute) throw new Error('compute topic control was not rendered');
    fireEvent.click(compute);
    expect(controller.topic).toBe('compute');
    expect(body.scrollTop).toBe(0);
    expect(compute.getAttribute('aria-pressed')).toBe('true');

    body.scrollTop = 90;
    fireEvent.click(compute);
    expect(body.scrollTop).toBe(0);

    const close = document.querySelector<HTMLButtonElement>('#helpClose');
    if (!close) throw new Error('Help close control was not rendered');
    fireEvent.click(close);
    expect(dialog?.hidden).toBe(true);
  });

  it('retains external-link security attributes in rendered reference content', () => {
    const controller = createController();
    render(<HelpWindow controller={controller} />);

    act(() => controller.open('references'));
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#helpBody a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
  });

  it('anchors untouched default geometry to the current viewport on first open', () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    render(<HelpWindow controller={controller} />);

    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
      act(() => controller.open('fundamentals'));

      expect(document.querySelector<HTMLElement>('#helpWin')?.style.left).toBe('448px');
      expect(controller.box.x).toBe(448);
      expect(controller.hasExplicitPosition).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('disposes an open mount, releases focus, and can mount the updated controller again', () => {
    const container = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'open help';
    document.body.append(opener, container);
    opener.focus();
    const controller = createController();
    controller.open('conditions');
    let dispose = mountHelpWindow(container, controller);
    expect(container.querySelector('#helpWin')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('#helpClose'));

    act(() => {
      dispose();
      dispose();
    });
    expect(document.activeElement).toBe(opener);
    expect(container.childElementCount).toBe(0);

    act(() => controller.open('compute'));
    dispose = mountHelpWindow(container, controller);
    expect(document.querySelector('[data-topic="compute"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.querySelector<HTMLElement>('#helpWin')?.hidden).toBe(false);

    act(() => dispose());
    container.remove();
    opener.remove();
  });
});

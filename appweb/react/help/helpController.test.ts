import { describe, expect, it, vi } from 'vitest';

import { HelpWindowController } from './helpController.ts';

describe('HelpWindowController', () => {
  it('starts closed with stable, deeply frozen right-edge geometry', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const snapshot = controller.getSnapshot();

    expect(snapshot).toEqual({
      open: false,
      topic: 'fundamentals',
      box: { x: 748, y: 84, w: 430, h: 560 },
      hasExplicitPosition: false,
      contentRevision: 0,
    });
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.box)).toBe(true);
    expect(controller.isOpen).toBe(false);
    expect(controller.topic).toBe('fundamentals');
    expect(controller.box).toBe(snapshot.box);
  });

  it('exposes stable store methods and supports idempotent unsubscription', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const getSnapshot = controller.getSnapshot;
    const subscribe = controller.subscribe;
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = controller.subscribe(removed);
    controller.subscribe(retained);

    unsubscribe();
    unsubscribe();
    controller.open('compute');

    expect(controller.getSnapshot).toBe(getSnapshot);
    expect(controller.subscribe).toBe(subscribe);
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it('validates topics against the authored topic map', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const initial = controller.getSnapshot();
    const listener = vi.fn();
    const onChange = vi.fn();
    controller.subscribe(listener);
    controller.onChange = onChange;

    controller.open('toString');
    controller.open('missing-topic');

    expect(controller.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    controller.open('compute');
    expect(controller.getSnapshot()).toMatchObject({
      open: true,
      topic: 'compute',
      contentRevision: 1,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('publishes repeated valid open requests so the view can reset its body', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.open('run');
    const first = controller.getSnapshot();
    controller.open('run');
    const second = controller.getSnapshot();

    expect(second).not.toBe(first);
    expect(second.contentRevision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('closes or opens the requested topic through toggle', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const onChange = vi.fn();
    controller.onChange = onChange;

    controller.open('soup');
    controller.toggle('soup');
    expect(controller.getSnapshot()).toMatchObject({ open: false, topic: 'soup' });

    controller.toggle('soup');
    expect(controller.getSnapshot()).toMatchObject({ open: true, topic: 'soup' });

    const beforeInvalidToggle = controller.getSnapshot();
    controller.toggle('__proto__');
    expect(controller.getSnapshot()).toBe(beforeInvalidToggle);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('restores valid partial placement without reporting a user change', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const listener = vi.fn();
    const onChange = vi.fn();
    controller.subscribe(listener);
    controller.onChange = onChange;

    controller.place({ x: -40, y: 32, w: 640, h: 420 });

    expect(controller.box).toEqual({ x: -40, y: 32, w: 640, h: 420 });
    expect(controller.hasExplicitPosition).toBe(true);
    expect(Object.isFrozen(controller.box)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects non-finite placement and undersized dimensions', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });

    controller.place({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: 299, h: 199 });

    expect(controller.box).toEqual({ x: 748, y: 84, w: 430, h: 560 });
    expect(controller.hasExplicitPosition).toBe(false);
  });

  it('publishes authoritative drag or resize geometry only when it changes', () => {
    const controller = new HelpWindowController({ viewportWidth: 1200 });
    const listener = vi.fn();
    const onChange = vi.fn();
    controller.subscribe(listener);
    controller.onChange = onChange;
    const box = { x: 20, y: 30, w: 500, h: 400 };

    controller.setBox(box);
    controller.setBox(box);

    expect(controller.box).toEqual(box);
    expect(controller.hasExplicitPosition).toBe(true);
    expect(controller.box).not.toBe(box);
    expect(Object.isFrozen(controller.box)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('accepts validated constructor state as a complete snapshot', () => {
    const controller = new HelpWindowController({
      viewportWidth: 1000,
      initiallyOpen: true,
      initialTopic: 'references',
      initialBox: { y: 12, w: 500 },
    });

    expect(controller.getSnapshot()).toEqual({
      open: true,
      topic: 'references',
      box: { x: 478, y: 12, w: 500, h: 560 },
      hasExplicitPosition: false,
      contentRevision: 0,
    });
  });
});

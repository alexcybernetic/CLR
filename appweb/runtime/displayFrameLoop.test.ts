import { describe, expect, it, vi } from 'vitest';

import { DisplayFrameLoop } from './displayFrameLoop.ts';

function fixture(options: { onError?: (error: unknown) => void } = {}) {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });
  const renderFrame = vi.fn();
  const loop = new DisplayFrameLoop({
    renderFrame,
    requestFrame,
    cancelFrame,
    onError: options.onError,
  });
  const runNext = () => {
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('no display frame is pending');
    callbacks.delete(entry[0]);
    entry[1](0);
  };
  return { callbacks, cancelFrame, loop, renderFrame, requestFrame, runNext };
}

describe('DisplayFrameLoop', () => {
  it('does not schedule before explicit, idempotent startup', () => {
    const { callbacks, loop, requestFrame } = fixture();

    expect(callbacks.size).toBe(0);
    loop.start();
    loop.start();

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);
    expect(loop.active).toBe(true);
  });

  it('renders and retains exactly one pending frame', () => {
    const { callbacks, loop, renderFrame, runNext } = fixture();
    loop.start();

    runNext();
    expect(renderFrame).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);

    runNext();
    expect(renderFrame).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(1);
  });

  it('stops cooperatively even when rendering requests the stop', () => {
    const { callbacks, loop, renderFrame, runNext } = fixture();
    renderFrame.mockImplementation(() => loop.stop());
    loop.start();

    runNext();

    expect(renderFrame).toHaveBeenCalledOnce();
    expect(loop.active).toBe(false);
    expect(callbacks.size).toBe(0);
  });

  it('cancels a pending frame and can restart before disposal', () => {
    const { callbacks, cancelFrame, loop } = fixture();
    loop.start();
    loop.stop();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);

    loop.start();
    expect(callbacks.size).toBe(1);
    loop.dispose();
    loop.start();
    expect(callbacks.size).toBe(0);
    expect(loop.active).toBe(false);
  });

  it('becomes inactive and reports an initial scheduling failure', () => {
    const failure = new Error('scheduler unavailable');
    const onError = vi.fn();
    const loop = new DisplayFrameLoop({
      renderFrame: vi.fn(),
      requestFrame: () => {
        throw failure;
      },
      onError,
    });

    loop.start();

    expect(loop.active).toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('becomes inactive and reports a rendering failure without rescheduling', () => {
    const failure = new Error('canvas unavailable');
    const onError = vi.fn();
    const { callbacks, loop, renderFrame, runNext } = fixture({ onError });
    renderFrame.mockImplementation(() => {
      throw failure;
    });
    loop.start();

    runNext();

    expect(loop.active).toBe(false);
    expect(callbacks.size).toBe(0);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

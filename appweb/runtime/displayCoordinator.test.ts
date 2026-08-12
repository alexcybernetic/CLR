import { describe, expect, it, vi } from 'vitest';

import type { TapeFrequencyGroup } from '../../engine/src/soup.ts';
import {
  DisplayCoordinator,
  type OrderPlotPort,
  type ReactorPort,
  type SoupMatrixPort,
  type TapeFrequencyViewPort,
} from './displayCoordinator.ts';

class MatrixFake implements SoupMatrixPort {
  mode: 'ops' | 'value' = 'ops';
  dirty = false;
  markA = -1;
  markB = -1;
  note = 'matrix note';
  tapeHits: number[] = [];
  readonly layout = vi.fn();
  readonly resetView = vi.fn(() => { this.dirty = true; });
  readonly zoomAt = vi.fn(() => { this.dirty = true; });
  readonly panBy = vi.fn(() => { this.dirty = true; });
  readonly tapeAt = vi.fn(() => this.tapeHits.shift() ?? -1);
  get viewNote(): string { return this.note; }
  readonly resize = vi.fn();
  readonly draw = vi.fn(() => { this.dirty = false; });
  readonly clearPopulation = vi.fn(() => { this.dirty = false; });
}

class FrequenciesFake implements TapeFrequencyViewPort {
  dirty = false;
  note = 'frequency note';
  pointerCaptured = false;
  pointerChanged = false;
  readonly resize = vi.fn();
  readonly resetView = vi.fn(() => { this.dirty = true; });
  readonly scrollBy = vi.fn(() => { this.dirty = true; });
  readonly pointerDown = vi.fn(() => this.pointerCaptured);
  readonly pointerMove = vi.fn(() => this.pointerChanged);
  readonly pointerUp = vi.fn();
  get viewNote(): string { return this.note; }
  readonly clearPopulation = vi.fn(() => { this.dirty = false; });
  readonly draw = vi.fn(
    (_groups: readonly TapeFrequencyGroup[], _distinct: number, _population: number, _len: number) => {
      this.dirty = false;
    },
  );
}

class PlotFake implements OrderPlotPort {
  readonly reset = vi.fn();
  readonly pushOrder = vi.fn();
  readonly setCurrentEpoch = vi.fn();
  readonly resize = vi.fn();
  readonly draw = vi.fn();
}

class ReactorFake implements ReactorPort {
  vm = { steps: 0, maxSteps: 16, copies: 0, ip: 0, h0: 0, h1: 0 };
  tape = new Uint8Array(0);
  a = -1;
  b = -1;
  running = false;
  speed = 1;
  trace: string[] = [];
  emptyNote = 'press next pair';
  haltedValue = false;
  readonly loads: Array<{ a: number; b: number; pair: number[] }> = [];

  load(
    a: number,
    b: number,
    pair: Uint8Array,
    maxSteps: number,
    _headPolicy: number,
    _noMatch: number,
  ): void {
    this.a = a;
    this.b = b;
    this.tape = pair.slice();
    this.vm = { steps: 0, maxSteps, copies: 0, ip: 0, h0: 0, h1: 0 };
    this.trace = [];
    this.haltedValue = false;
    this.loads.push({ a, b, pair: [...pair] });
  }

  clear(): void {
    this.a = -1;
    this.b = -1;
    this.running = false;
    this.tape = new Uint8Array(0);
    this.vm.steps = 0;
    this.trace = [];
    this.haltedValue = false;
  }

  readonly rewind = vi.fn(() => { this.vm.steps = 0; });
  get halted(): boolean { return this.haltedValue; }
  setSpeed(speed: number): void { this.speed = speed; }
  advanceFrame(): void {
    this.vm.steps++;
    this.trace.push('>');
  }
  advance(steps: number): void { this.vm.steps += steps; }
  readonly resize = vi.fn();
  readonly draw = vi.fn();
}

function fixture(randomValues: number[] = [0, 0.75]) {
  const matrix = new MatrixFake();
  const frequencies = new FrequenciesFake();
  const plot = new PlotFake();
  const reactor = new ReactorFake();
  let handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((id: number) => { frames.delete(id); });
  let randomIndex = 0;
  const coordinator = new DisplayCoordinator({
    sampler: { maxSteps: 16, headPolicy: 0, noMatch: 1 },
    renderers: {
      createSoupMatrix: () => matrix,
      createTapeFrequencyView: () => frequencies,
      createOrderPlot: () => plot,
      createReactor: () => reactor,
    },
    requestFrame,
    cancelFrame,
    random: () => randomValues[randomIndex++ % randomValues.length],
    devicePixelRatio: () => 3,
  });
  const hosts = {
    soup: document.createElement('canvas'),
    order: document.createElement('canvas'),
    sampler: document.createElement('canvas'),
  };
  const runFrame = () => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('no frame pending');
    frames.delete(entry[0]);
    entry[1](0);
  };
  return {
    cancelFrame,
    coordinator,
    frames,
    frequencies,
    hosts,
    matrix,
    plot,
    reactor,
    requestFrame,
    runFrame,
  };
}

function population() {
  return {
    epoch: 12,
    soup: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    nTapes: 4,
    tapeLen: 2,
    tapeFrequencies: [
      { bytes: new Uint8Array([0, 1]), count: 1, contentHash: 123 },
    ],
    uniqueTapes: 4,
  };
}

function containsBinary(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsBinary(Reflect.get(value, key), seen));
}

describe('DisplayCoordinator lifecycle and ownership', () => {
  it('does not schedule before start and starts after late canvas attachment', () => {
    const { coordinator, frames, hosts, requestFrame } = fixture();

    coordinator.start();
    coordinator.start();
    expect(frames.size).toBe(0);

    coordinator.attachCanvases(hosts);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
    expect(coordinator.active).toBe(true);
  });

  it('stops and restarts its permanent attachment, then disposes once', () => {
    const { cancelFrame, coordinator, frames, hosts } = fixture();
    coordinator.attachCanvases(hosts);
    coordinator.start();

    coordinator.stop();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(coordinator.active).toBe(false);

    coordinator.start();
    expect(frames.size).toBe(1);
    coordinator.dispose();
    coordinator.start();
    expect(frames.size).toBe(0);
    expect(() => coordinator.attachCanvases(hosts)).toThrow(/disposed/);
  });

  it('rejects renderer replacement and restores pre-attachment sampler configuration', () => {
    const { coordinator, hosts, reactor } = fixture();
    coordinator.setSamplerConfiguration({ maxSteps: 32, headPolicy: 1, noMatch: 0 });

    coordinator.attachCanvases(hosts);

    expect(reactor.vm.maxSteps).toBe(32);
    expect(coordinator.getSnapshot().sampler.maxSteps).toBe(32);
    expect(() => coordinator.attachCanvases(hosts)).toThrow(/already attached/);
  });

  it('publishes frozen, stable, binary-free presentation snapshots', () => {
    const { coordinator, hosts, runFrame } = fixture();
    const listener = vi.fn();
    coordinator.subscribe(listener);
    coordinator.attachCanvases(hosts);
    coordinator.acceptPopulation(population());
    const before = coordinator.getSnapshot();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.soup)).toBe(true);
    expect(Object.isFrozen(before.sampler)).toBe(true);
    expect(containsBinary(before)).toBe(false);

    coordinator.start();
    runFrame();
    const afterDraw = coordinator.getSnapshot();
    expect(afterDraw.soup.viewNote).toBe('matrix note');
    expect(containsBinary(afterDraw)).toBe(false);
    const calls = listener.mock.calls.length;

    runFrame();
    expect(coordinator.getSnapshot()).toBe(afterDraw);
    expect(listener).toHaveBeenCalledTimes(calls);
  });
});

describe('DisplayCoordinator rendering', () => {
  it('coordinates population layout, pair ownership, DPR, and frame order', () => {
    const { coordinator, frequencies, hosts, matrix, plot, reactor, runFrame } = fixture();
    coordinator.attachCanvases(hosts);
    const raw = population();
    coordinator.acceptPopulation(raw);

    expect(matrix.layout).toHaveBeenCalledWith(4, 2);
    expect(plot.setCurrentEpoch).toHaveBeenCalledWith(12);
    expect(reactor.loads[0]).toEqual({ a: 0, b: 3, pair: [0, 1, 6, 7] });
    expect(coordinator.getSnapshot().sampler).toMatchObject({
      loaded: true,
      tapeA: 0,
      tapeB: 3,
    });

    coordinator.start();
    runFrame();
    expect(matrix.resize).toHaveBeenCalledWith(2);
    expect(plot.resize).toHaveBeenCalledWith(2);
    expect(reactor.resize).toHaveBeenCalledWith(2);
    expect(matrix.draw).toHaveBeenCalledWith(raw.soup);
    expect(plot.draw).toHaveBeenCalledWith(2);
    expect(reactor.draw).toHaveBeenCalledWith(2);
    expect(frequencies.draw).not.toHaveBeenCalled();
  });

  it('routes ranked-frequency interaction independently of matrix navigation', () => {
    const { coordinator, frequencies, hosts, matrix, runFrame } = fixture();
    coordinator.attachCanvases(hosts);
    coordinator.acceptPopulation(population());
    coordinator.setSoupMode('counts');
    frequencies.pointerCaptured = true;
    frequencies.pointerChanged = true;

    coordinator.scrollSoup(24);
    expect(coordinator.soupPointerDown(10, 20)).toBe(true);
    expect(coordinator.soupPointerMove(11, 30)).toBe(true);
    coordinator.soupPointerUp();
    coordinator.zoomSoup(2, 10, 20);
    coordinator.panSoup(4, 5);

    expect(frequencies.scrollBy).toHaveBeenCalledWith(24);
    expect(frequencies.pointerDown).toHaveBeenCalledWith(10, 20);
    expect(frequencies.pointerMove).toHaveBeenCalledWith(11, 30);
    expect(frequencies.pointerUp).toHaveBeenCalledOnce();
    expect(matrix.zoomAt).not.toHaveBeenCalled();
    expect(matrix.panBy).not.toHaveBeenCalled();

    coordinator.start();
    runFrame();
    expect(frequencies.draw).toHaveBeenCalled();
    expect(coordinator.getSnapshot().soup).toEqual({
      mode: 'counts',
      viewNote: 'frequency note',
      fitAvailable: false,
    });

    coordinator.setSelectionMode('pick');
    expect(coordinator.getSnapshot().soup.mode).toBe('ops');
  });

  it('replays order history on attachment and clears every run-derived display', () => {
    const { coordinator, frequencies, hosts, matrix, plot, reactor } = fixture();
    coordinator.acceptOrder({ epoch: 5, highOrder: 1, byteOrder: 2, compressedBitsPerByte: 7 });
    coordinator.attachCanvases(hosts);
    expect(plot.pushOrder).toHaveBeenCalledWith(5, 1, 2, 7);

    coordinator.acceptPopulation(population());
    coordinator.clearRun();
    expect(plot.reset).toHaveBeenCalledOnce();
    expect(matrix.clearPopulation).toHaveBeenCalledOnce();
    expect(frequencies.clearPopulation).toHaveBeenCalledOnce();
    expect(reactor.tape).toHaveLength(0);
    expect(coordinator.getSnapshot().soup.viewNote).toBe('awaiting population');
    expect(coordinator.getSnapshot().sampler.loaded).toBe(false);
  });
});

describe('DisplayCoordinator sampler', () => {
  it('loads an explicitly picked pair without exposing its bytes', () => {
    const { coordinator, hosts, matrix, reactor } = fixture();
    coordinator.attachCanvases(hosts);
    coordinator.setSelectionMode('pick');
    coordinator.acceptPopulation(population());
    matrix.tapeHits.push(1, 3);

    coordinator.pickTapeAt(10, 20);
    expect(matrix.markA).toBe(1);
    expect(matrix.markB).toBe(-1);
    coordinator.pickTapeAt(30, 40);

    expect(reactor.loads[0]).toEqual({ a: 1, b: 3, pair: [2, 3, 6, 7] });
    expect(coordinator.getSnapshot().sampler).toMatchObject({ tapeA: 1, tapeB: 3 });
    expect(containsBinary(coordinator.getSnapshot())).toBe(false);
  });

  it('publishes registers and auto-advances after the preserved halted dwell', () => {
    const { coordinator, hosts, reactor, runFrame } = fixture([0.25, 0.5]);
    coordinator.attachCanvases(hosts);
    coordinator.acceptPopulation(population());
    coordinator.start();

    reactor.running = true;
    reactor.haltedValue = true;
    const loadsBefore = reactor.loads.length;
    for (let frame = 0; frame < 36; frame++) runFrame();
    expect(reactor.loads).toHaveLength(loadsBefore);
    runFrame();
    expect(reactor.loads).toHaveLength(loadsBefore + 1);

    reactor.vm.ip = 0;
    reactor.vm.steps = 9;
    reactor.vm.copies = 2;
    reactor.trace.push('>');
    runFrame();
    expect(coordinator.getSnapshot().sampler).toMatchObject({
      steps: 10,
      copies: 2,
      nextByte: reactor.tape[0],
      trace: '>>',
    });
  });

  it('disables sampler execution while retaining the loaded pair', () => {
    const { coordinator, hosts, matrix, reactor } = fixture();
    coordinator.attachCanvases(hosts);
    coordinator.acceptPopulation(population());
    reactor.running = true;

    coordinator.setSamplerEnabled(false);

    expect(reactor.running).toBe(false);
    expect(reactor.tape).toHaveLength(4);
    expect(matrix.markA).toBe(-1);
    expect(matrix.markB).toBe(-1);
    expect(coordinator.getSnapshot().sampler).toMatchObject({ enabled: false, loaded: true });
  });

  it('preserves active selection-mode reselection as an explicit next draw', () => {
    const { coordinator, hosts, reactor } = fixture([0, 0.25, 0.5, 0.75]);
    coordinator.attachCanvases(hosts);
    coordinator.acceptPopulation(population());
    expect(reactor.loads).toHaveLength(1);

    coordinator.setSelectionMode('random');

    expect(reactor.loads).toHaveLength(2);
    expect(reactor.loads[1]).toMatchObject({ a: 2, b: 3 });
  });

  it('rejects display actions after disposal', () => {
    const { coordinator } = fixture();
    coordinator.dispose();

    expect(() => coordinator.invalidateSoup()).toThrow(/disposed/);
    expect(() => coordinator.nextPair()).toThrow(/disposed/);
    expect(() => coordinator.soupPointerUp()).toThrow(/disposed/);
  });
});

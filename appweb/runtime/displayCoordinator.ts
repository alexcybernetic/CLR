import { GLYPH, OP_CLASS, OP_DESCRIPTION } from '../../engine/src/opcodes.ts';
import type { TapeFrequencyGroup } from '../../engine/src/soup.ts';
import { VM } from '../../engine/src/vm.ts';
import { OrderPlot } from '../ui/orderPlot.ts';
import { Reactor } from '../ui/reactor.ts';
import { SoupMatrix, type SoupMatrixMode } from '../ui/soupMatrix.ts';
import { TapeFrequencyView } from '../ui/tapeFrequencyView.ts';
import { DisplayFrameLoop } from './displayFrameLoop.ts';

export type SoupDisplayMode = SoupMatrixMode | 'counts';
export type SamplerSelectionMode = 'random' | 'busiest' | 'pick';

export interface DisplayCanvasHosts {
  soup: HTMLCanvasElement;
  order: HTMLCanvasElement;
  sampler: HTMLCanvasElement;
}

/** Runtime-owned data. Passing it transfers read-only ownership to the coordinator. */
export interface DisplayPopulation {
  readonly epoch: number;
  readonly soup: Uint8Array;
  readonly nTapes: number;
  readonly tapeLen: number;
  readonly tapeFrequencies: readonly TapeFrequencyGroup[];
  readonly uniqueTapes: number;
}

export interface DisplayOrderMeasurement {
  readonly epoch: number;
  readonly highOrder: number;
  readonly byteOrder: number;
  readonly compressedBitsPerByte: number;
}

export interface SamplerConfiguration {
  readonly maxSteps: number;
  readonly headPolicy: number;
  readonly noMatch: number;
}

export interface SoupPresentationSnapshot {
  readonly mode: SoupDisplayMode;
  readonly viewNote: string;
  readonly fitAvailable: boolean;
}

export interface SamplerPresentationSnapshot {
  readonly enabled: boolean;
  readonly selectionMode: SamplerSelectionMode;
  readonly speed: number;
  readonly running: boolean;
  readonly loaded: boolean;
  readonly tapeA: number | null;
  readonly tapeB: number | null;
  readonly halted: boolean;
  readonly steps: number;
  readonly maxSteps: number;
  readonly copies: number;
  readonly ip: number;
  readonly h0: number;
  readonly h1: number;
  readonly nextByte: number | null;
  readonly nextGlyph: string;
  readonly nextOperationClass: number | null;
  readonly nextDescription: string;
  readonly trace: string;
}

export interface DisplayPresentationSnapshot {
  readonly soup: SoupPresentationSnapshot;
  readonly sampler: SamplerPresentationSnapshot;
}

export type DisplayPresentationListener = () => void;

export interface SoupMatrixPort {
  mode: SoupMatrixMode;
  dirty: boolean;
  markA: number;
  markB: number;
  layout(nTapes: number, tapeLen: number): void;
  resetView(): void;
  zoomAt(factor: number, x: number, y: number): void;
  panBy(dx: number, dy: number): void;
  tapeAt(x: number, y: number): number;
  readonly viewNote: string;
  resize(dpr: number): void;
  draw(soup: Uint8Array): void;
  clearPopulation(): void;
}

export interface TapeFrequencyViewPort {
  dirty: boolean;
  resize(dpr: number): void;
  resetView(): void;
  scrollBy(deltaY: number): void;
  pointerDown(x: number, y: number): boolean;
  pointerMove(x: number, y: number): boolean;
  pointerUp(): void;
  readonly viewNote: string;
  clearPopulation(): void;
  draw(
    groups: readonly TapeFrequencyGroup[],
    distinctGroups: number,
    population: number,
    tapeLen: number,
  ): void;
}

export interface OrderPlotPort {
  reset(): void;
  pushOrder(epoch: number, highOrder: number, byteOrder: number, compressedBpb: number): void;
  setCurrentEpoch(epoch: number): void;
  resize(dpr: number): void;
  draw(dpr: number): void;
}

export interface SamplerVmPort {
  steps: number;
  maxSteps: number;
  copies: number;
  ip: number;
  h0: number;
  h1: number;
}

export interface ReactorPort {
  vm: SamplerVmPort;
  tape: Uint8Array;
  a: number;
  b: number;
  running: boolean;
  speed: number;
  trace: string[];
  emptyNote: string;
  load(
    a: number,
    b: number,
    pair: Uint8Array,
    maxSteps: number,
    headPolicy: number,
    noMatch: number,
  ): void;
  clear(): void;
  rewind(): void;
  readonly halted: boolean;
  setSpeed(speed: number): void;
  advanceFrame(): void;
  advance(steps: number): void;
  resize(dpr: number): void;
  draw(dpr: number): void;
}

export interface DisplayRendererFactories {
  createSoupMatrix(canvas: HTMLCanvasElement): SoupMatrixPort;
  createTapeFrequencyView(canvas: HTMLCanvasElement): TapeFrequencyViewPort;
  createOrderPlot(canvas: HTMLCanvasElement): OrderPlotPort;
  createReactor(canvas: HTMLCanvasElement): ReactorPort;
}

export interface DisplayCoordinatorOptions {
  sampler: SamplerConfiguration;
  renderers?: DisplayRendererFactories;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  random?: () => number;
  devicePixelRatio?: () => number;
  onError?: (error: unknown) => void;
}

interface AttachedRenderers {
  matrix: SoupMatrixPort;
  frequencies: TapeFrequencyViewPort;
  plot: OrderPlotPort;
  reactor: ReactorPort;
}

const DEFAULT_RENDERERS: DisplayRendererFactories = {
  createSoupMatrix: (canvas) => new SoupMatrix(canvas),
  createTapeFrequencyView: (canvas) => new TapeFrequencyView(canvas),
  createOrderPlot: (canvas) => new OrderPlot(canvas),
  createReactor: (canvas) => new Reactor(canvas),
};

function freezeSnapshot(snapshot: DisplayPresentationSnapshot): DisplayPresentationSnapshot {
  Object.freeze(snapshot.soup);
  Object.freeze(snapshot.sampler);
  return Object.freeze(snapshot);
}

function sameSnapshot(
  left: DisplayPresentationSnapshot,
  right: DisplayPresentationSnapshot,
): boolean {
  const a = left.soup;
  const b = right.soup;
  const c = left.sampler;
  const d = right.sampler;
  return (
    a.mode === b.mode &&
    a.viewNote === b.viewNote &&
    a.fitAvailable === b.fitAvailable &&
    c.enabled === d.enabled &&
    c.selectionMode === d.selectionMode &&
    c.speed === d.speed &&
    c.running === d.running &&
    c.loaded === d.loaded &&
    c.tapeA === d.tapeA &&
    c.tapeB === d.tapeB &&
    c.halted === d.halted &&
    c.steps === d.steps &&
    c.maxSteps === d.maxSteps &&
    c.copies === d.copies &&
    c.ip === d.ip &&
    c.h0 === d.h0 &&
    c.h1 === d.h1 &&
    c.nextByte === d.nextByte &&
    c.nextGlyph === d.nextGlyph &&
    c.nextOperationClass === d.nextOperationClass &&
    c.nextDescription === d.nextDescription &&
    c.trace === d.trace
  );
}

/**
 * Owns all imperative CLR displays and their binary data.
 *
 * React may subscribe to the small immutable presentation snapshot and attach
 * stable canvas hosts. Population buffers, renderer objects, the sampler VM,
 * plot history, and animation scheduling never cross that boundary.
 */
export class DisplayCoordinator {
  readonly #factories: DisplayRendererFactories;
  readonly #random: () => number;
  readonly #devicePixelRatio: () => number;
  readonly #loop: DisplayFrameLoop;
  readonly #probe = new VM();
  readonly #listeners = new Set<DisplayPresentationListener>();
  /** Measurements received before the permanent canvas attachment. */
  readonly #orderHistory: DisplayOrderMeasurement[] = [];

  #renderers: AttachedRenderers | null = null;
  #population: DisplayPopulation | null = null;
  #samplerConfig: SamplerConfiguration;
  #soupMode: SoupDisplayMode = 'ops';
  #selectionMode: SamplerSelectionMode = 'random';
  #samplerEnabled = true;
  #samplerSpeed = 1;
  #populationDirty = true;
  #pendingTapeA = -1;
  #wantPair = true;
  #reactorDwell = 0;
  #startRequested = false;
  #disposed = false;
  #snapshot: DisplayPresentationSnapshot;

  constructor(options: DisplayCoordinatorOptions) {
    this.#factories = options.renderers ?? DEFAULT_RENDERERS;
    this.#random = options.random ?? Math.random;
    this.#devicePixelRatio = options.devicePixelRatio ?? (() => window.devicePixelRatio || 1);
    this.#samplerConfig = { ...options.sampler };
    this.#snapshot = freezeSnapshot({
      soup: { mode: 'ops', viewNote: 'awaiting population', fitAvailable: true },
      sampler: {
        enabled: true,
        selectionMode: 'random',
        speed: 1,
        running: false,
        loaded: false,
        tapeA: null,
        tapeB: null,
        halted: false,
        steps: 0,
        maxSteps: options.sampler.maxSteps,
        copies: 0,
        ip: 0,
        h0: 0,
        h1: 0,
        nextByte: null,
        nextGlyph: '',
        nextOperationClass: null,
        nextDescription: '',
        trace: '',
      },
    });
    this.#loop = new DisplayFrameLoop({
      renderFrame: () => this.#renderFrame(),
      requestFrame: options.requestFrame,
      cancelFrame: options.cancelFrame,
      onError: options.onError,
    });
  }

  readonly getSnapshot = (): DisplayPresentationSnapshot => this.#snapshot;

  readonly subscribe = (listener: DisplayPresentationListener): (() => void) => {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  };

  get active(): boolean {
    return this.#loop.active;
  }

  /** Permanently attach the stable canvas elements rendered by the application shell. */
  attachCanvases(hosts: DisplayCanvasHosts): void {
    if (this.#disposed) throw new Error('display coordinator is disposed');
    if (this.#renderers) throw new Error('display canvases are already attached');

    const renderers: AttachedRenderers = {
      matrix: this.#factories.createSoupMatrix(hosts.soup),
      frequencies: this.#factories.createTapeFrequencyView(hosts.soup),
      plot: this.#factories.createOrderPlot(hosts.order),
      reactor: this.#factories.createReactor(hosts.sampler),
    };
    renderers.matrix.mode = this.#soupMode === 'counts' ? 'ops' : this.#soupMode;
    renderers.reactor.vm.maxSteps = this.#samplerConfig.maxSteps;
    renderers.reactor.setSpeed(this.#samplerSpeed);
    renderers.reactor.emptyNote = this.#emptySamplerNote();
    if (this.#population) {
      renderers.matrix.layout(this.#population.nTapes, this.#population.tapeLen);
      renderers.plot.setCurrentEpoch(this.#population.epoch);
    }
    for (const measurement of this.#orderHistory) {
      renderers.plot.pushOrder(
        measurement.epoch,
        measurement.highOrder,
        measurement.byteOrder,
        measurement.compressedBitsPerByte,
      );
    }
    this.#orderHistory.length = 0;
    this.#renderers = renderers;
    if (this.#population && this.#wantPair) {
      this.#wantPair = false;
      this.#pickPair();
    }
    this.#populationDirty = true;
    this.#publish();
    if (this.#startRequested) this.#loop.start();
  }

  /** Open the render gate. Calling this before attachment defers scheduling. */
  start(): void {
    if (this.#disposed) return;
    this.#startRequested = true;
    if (this.#renderers) this.#loop.start();
  }

  stop(): void {
    this.#startRequested = false;
    this.#loop.stop();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#startRequested = false;
    this.#loop.dispose();
    this.#renderers = null;
    this.#population = null;
    this.#orderHistory.length = 0;
    this.#listeners.clear();
  }

  acceptPopulation(population: DisplayPopulation): void {
    this.#assertUsable();
    if (!Number.isInteger(population.nTapes) || population.nTapes < 2) {
      throw new RangeError('display population must contain at least two tapes');
    }
    if (!Number.isInteger(population.tapeLen) || population.tapeLen < 1) {
      throw new RangeError('display population tape length must be positive');
    }
    if (population.soup.length !== population.nTapes * population.tapeLen) {
      throw new RangeError('display population buffer does not match its shape');
    }
    this.#population = { ...population };
    const renderers = this.#renderers;
    if (renderers) {
      renderers.matrix.layout(population.nTapes, population.tapeLen);
      renderers.plot.setCurrentEpoch(population.epoch);
    }
    if (this.#wantPair && this.#renderers) {
      this.#wantPair = false;
      this.#pickPair();
    }
    this.#populationDirty = true;
  }

  acceptOrder(measurement: DisplayOrderMeasurement): void {
    this.#assertUsable();
    const stored = { ...measurement };
    const plot = this.#renderers?.plot;
    if (plot) {
      plot.pushOrder(
        stored.epoch,
        stored.highOrder,
        stored.byteOrder,
        stored.compressedBitsPerByte,
      );
    } else {
      this.#orderHistory.push(stored);
    }
  }

  clearRun(): void {
    this.#assertUsable();
    this.#population = null;
    this.#orderHistory.length = 0;
    const renderers = this.#renderers;
    if (renderers) {
      renderers.plot.reset();
      renderers.matrix.clearPopulation();
      renderers.frequencies.clearPopulation();
      renderers.reactor.clear();
    }
    this.#pendingTapeA = -1;
    this.#wantPair = true;
    this.#reactorDwell = 0;
    this.#populationDirty = false;
    this.#publish('awaiting population');
  }

  setSamplerConfiguration(configuration: SamplerConfiguration): void {
    this.#assertUsable();
    this.#samplerConfig = { ...configuration };
    if (this.#renderers) this.#renderers.reactor.vm.maxSteps = configuration.maxSteps;
    this.#publish();
  }

  setSoupMode(mode: SoupDisplayMode): void {
    this.#assertUsable();
    if (mode === 'counts' && this.#selectionMode === 'pick') return;
    if (this.#soupMode === mode) return;
    this.#soupMode = mode;
    if (mode !== 'counts' && this.#renderers) this.#renderers.matrix.mode = mode;
    this.#populationDirty = true;
    this.#publish();
  }

  resetSoupView(): void {
    this.#assertUsable();
    if (this.#soupMode !== 'counts') this.#renderers?.matrix.resetView();
  }

  invalidateSoup(): void {
    this.#assertUsable();
    this.#populationDirty = true;
  }

  scrollSoup(deltaY: number): void {
    this.#assertUsable();
    if (this.#soupMode !== 'counts') return;
    this.#renderers?.frequencies.scrollBy(deltaY);
    this.#populationDirty = true;
  }

  zoomSoup(factor: number, x: number, y: number): void {
    this.#assertUsable();
    if (this.#soupMode === 'counts') return;
    this.#renderers?.matrix.zoomAt(factor, x, y);
  }

  panSoup(dx: number, dy: number): void {
    this.#assertUsable();
    if (this.#soupMode === 'counts') return;
    this.#renderers?.matrix.panBy(dx, dy);
  }

  soupPointerDown(x: number, y: number): boolean {
    this.#assertUsable();
    if (this.#soupMode !== 'counts') return true;
    const captured = this.#renderers?.frequencies.pointerDown(x, y) ?? false;
    if (captured) this.#populationDirty = true;
    return captured;
  }

  soupPointerMove(x: number, y: number): boolean {
    this.#assertUsable();
    if (this.#soupMode !== 'counts') return false;
    const changed = this.#renderers?.frequencies.pointerMove(x, y) ?? false;
    if (changed) this.#populationDirty = true;
    return changed;
  }

  soupPointerUp(): void {
    this.#assertUsable();
    this.#renderers?.frequencies.pointerUp();
  }

  pickTapeAt(x: number, y: number): void {
    this.#assertUsable();
    if (
      !this.#population ||
      !this.#samplerEnabled ||
      this.#selectionMode !== 'pick' ||
      !this.#renderers
    ) return;
    const tape = this.#renderers.matrix.tapeAt(x, y);
    if (tape < 0) return;
    if (this.#pendingTapeA < 0) {
      this.#pendingTapeA = tape;
      this.#renderers.matrix.markA = tape;
      this.#renderers.matrix.markB = -1;
      this.#populationDirty = true;
      return;
    }
    if (tape === this.#pendingTapeA) return;
    const tapeA = this.#pendingTapeA;
    this.#pendingTapeA = -1;
    this.#loadPair(tapeA, tape);
  }

  setSelectionMode(mode: SamplerSelectionMode): void {
    this.#assertUsable();
    if (mode === 'pick' && this.#soupMode === 'counts') this.setSoupMode('ops');
    this.#selectionMode = mode;
    this.#pendingTapeA = -1;
    if (this.#renderers) this.#renderers.reactor.emptyNote = this.#emptySamplerNote();
    this.#populationDirty = true;
    if (this.#samplerEnabled && mode !== 'pick') this.#pickPair();
    this.#publish();
  }

  setSamplerEnabled(enabled: boolean): void {
    this.#assertUsable();
    if (this.#samplerEnabled === enabled) return;
    this.#samplerEnabled = enabled;
    const renderers = this.#renderers;
    if (!enabled) {
      if (renderers) {
        renderers.reactor.running = false;
        renderers.matrix.markA = -1;
        renderers.matrix.markB = -1;
      }
      this.#pendingTapeA = -1;
      this.#populationDirty = true;
    } else if (this.#population) {
      this.#pickPair();
    }
    this.#publish();
  }

  setSamplerSpeed(speed: number): void {
    this.#assertUsable();
    if (!Number.isFinite(speed) || speed < 0) throw new RangeError('invalid sampler speed');
    this.#samplerSpeed = speed;
    this.#renderers?.reactor.setSpeed(speed);
    this.#publish();
  }

  setSamplerRunning(running: boolean): void {
    this.#assertUsable();
    if (!this.#samplerEnabled || !this.#renderers) return;
    const reactor = this.#renderers.reactor;
    reactor.running = running;
    if (running && reactor.halted) this.#pickPair();
    this.#publish();
  }

  nextPair(): void {
    this.#assertUsable();
    if (this.#samplerEnabled) this.#pickPair();
  }

  rewindSampler(): void {
    this.#assertUsable();
    this.#renderers?.reactor.rewind();
    this.#publish();
  }

  stepSampler(): void {
    this.#assertUsable();
    const reactor = this.#renderers?.reactor;
    if (!reactor) return;
    reactor.running = false;
    reactor.advance(1);
    this.#publish();
  }

  #renderFrame(): void {
    const renderers = this.#renderers;
    if (!renderers) return;
    const dpr = Math.min(2, this.#devicePixelRatio() || 1);
    if (this.#soupMode === 'counts') renderers.frequencies.resize(dpr);
    else renderers.matrix.resize(dpr);
    renderers.plot.resize(dpr);
    renderers.reactor.resize(dpr);

    const activeSoupDirty = this.#soupMode === 'counts'
      ? renderers.frequencies.dirty
      : renderers.matrix.dirty;
    let viewNote: string | undefined;
    if ((this.#populationDirty || activeSoupDirty) && this.#population) {
      const population = this.#population;
      if (this.#soupMode === 'counts') {
        renderers.frequencies.draw(
          population.tapeFrequencies,
          population.uniqueTapes,
          population.nTapes,
          population.tapeLen,
        );
        renderers.frequencies.dirty = false;
        viewNote = renderers.frequencies.viewNote;
      } else {
        renderers.matrix.draw(population.soup);
        renderers.matrix.dirty = false;
        viewNote = renderers.matrix.viewNote;
      }
      this.#populationDirty = false;
    }
    renderers.plot.draw(dpr);

    const reactor = renderers.reactor;
    let samplerChanged = false;
    if (reactor.running && this.#samplerEnabled) {
      const stepsBefore = reactor.vm.steps;
      reactor.advanceFrame();
      samplerChanged = reactor.vm.steps !== stepsBefore;
      if (reactor.halted) {
        if (++this.#reactorDwell > 36) this.#pickPair();
      } else {
        this.#reactorDwell = 0;
      }
    }
    reactor.draw(dpr);
    if (
      samplerChanged ||
      (viewNote !== undefined && viewNote !== this.#snapshot.soup.viewNote)
    ) {
      this.#publish(viewNote);
    }
  }

  #pickPair(): void {
    const population = this.#population;
    if (!population || !this.#renderers || this.#selectionMode === 'pick') return;
    const hunt = this.#selectionMode === 'busiest';
    const scratch = new Uint8Array(population.tapeLen * 2);
    this.#probe.maxSteps = this.#samplerConfig.maxSteps;
    this.#probe.headPolicy = this.#samplerConfig.headPolicy;
    this.#probe.noMatch = this.#samplerConfig.noMatch;
    let bestA = -1;
    let bestB = -1;
    let bestScore = -1;
    for (let index = 0; index < (hunt ? 200 : 1); index++) {
      const tapeA = this.#randomTape(population.nTapes);
      let tapeB = this.#randomTape(population.nTapes);
      if (tapeB === tapeA) tapeB = (tapeB + 1) % population.nTapes;
      if (!hunt) {
        bestA = tapeA;
        bestB = tapeB;
        break;
      }
      this.#fillPair(scratch, tapeA, tapeB, population);
      this.#probe.load(scratch);
      this.#probe.runToHalt();
      if (this.#probe.copies > bestScore) {
        bestScore = this.#probe.copies;
        bestA = tapeA;
        bestB = tapeB;
      }
    }
    this.#loadPair(bestA, bestB);
  }

  #loadPair(tapeA: number, tapeB: number): void {
    const population = this.#population;
    const renderers = this.#renderers;
    if (!population || !renderers) return;
    const pair = new Uint8Array(population.tapeLen * 2);
    this.#fillPair(pair, tapeA, tapeB, population);
    renderers.reactor.load(
      tapeA,
      tapeB,
      pair,
      this.#samplerConfig.maxSteps,
      this.#samplerConfig.headPolicy,
      this.#samplerConfig.noMatch,
    );
    renderers.matrix.markA = this.#samplerEnabled ? tapeA : -1;
    renderers.matrix.markB = this.#samplerEnabled ? tapeB : -1;
    this.#populationDirty = true;
    this.#reactorDwell = 0;
    this.#publish();
  }

  #fillPair(
    target: Uint8Array,
    tapeA: number,
    tapeB: number,
    population: DisplayPopulation,
  ): void {
    const length = population.tapeLen;
    target.set(population.soup.subarray(tapeA * length, tapeA * length + length), 0);
    target.set(population.soup.subarray(tapeB * length, tapeB * length + length), length);
  }

  #randomTape(nTapes: number): number {
    const value = this.#random();
    if (!Number.isFinite(value)) throw new RangeError('random source returned a non-finite value');
    return Math.max(0, Math.min(nTapes - 1, Math.floor(value * nTapes)));
  }

  #emptySamplerNote(): string {
    return this.#selectionMode === 'pick' ? 'click two tapes in the soup' : 'press next pair';
  }

  #publish(viewNote?: string): void {
    const reactor = this.#renderers?.reactor;
    const vm = reactor?.vm;
    const nextByte = reactor && vm && vm.ip >= 0 && vm.ip < reactor.tape.length
      ? reactor.tape[vm.ip]
      : null;
    const next: DisplayPresentationSnapshot = freezeSnapshot({
      soup: {
        mode: this.#soupMode,
        viewNote: viewNote ?? this.#snapshot.soup.viewNote,
        fitAvailable: this.#soupMode !== 'counts',
      },
      sampler: {
        enabled: this.#samplerEnabled,
        selectionMode: this.#selectionMode,
        speed: reactor?.speed ?? this.#samplerSpeed,
        running: reactor?.running ?? false,
        loaded: Boolean(reactor?.tape.length),
        tapeA: reactor && reactor.a >= 0 ? reactor.a : null,
        tapeB: reactor && reactor.b >= 0 ? reactor.b : null,
        halted: reactor?.halted ?? false,
        steps: vm?.steps ?? 0,
        maxSteps: vm?.maxSteps ?? this.#samplerConfig.maxSteps,
        copies: vm?.copies ?? 0,
        ip: vm?.ip ?? 0,
        h0: vm?.h0 ?? 0,
        h1: vm?.h1 ?? 0,
        nextByte,
        nextGlyph: nextByte === null ? '' : GLYPH[nextByte],
        nextOperationClass:
          nextByte !== null && OP_DESCRIPTION[nextByte] ? OP_CLASS[nextByte] : null,
        nextDescription:
          nextByte === null ? '' : (OP_DESCRIPTION[nextByte] ?? 'no operation'),
        trace: reactor?.trace.slice(-110).join('') ?? '',
      },
    });
    if (sameSnapshot(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('display coordinator is disposed');
  }
}

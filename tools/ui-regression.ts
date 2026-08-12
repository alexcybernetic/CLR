/* Focused rendering checks for the sampler's operation view. */
import { B_GET, B_H0L, B_H1L, B_INC, B_LB, GLYPH, OP_CLASS } from '../engine/src/opcodes.ts';
import { DEFAULT_CONFIG, defaultConfigForEngine } from '../engine/src/soup.ts';
import { HEAD_WRAP, NOMATCH_HALT } from '../engine/src/vm.ts';
import {
  BYTE_LABEL_CSS,
  CLASS_CSS,
  DISPLAY_FACE_CSS,
  operatorRgb,
  VALUE_STOPS,
  valueRgb,
} from '../appweb/ui/palette.ts';
import { OrderPlot } from '../appweb/ui/orderPlot.ts';
import { loadPrefs, savePrefs } from '../appweb/ui/prefs.ts';
import { MemoryRunRepository } from '../appweb/records/repository.ts';
import type { BatchRunDefinition } from '../appweb/records/model.ts';
import { Reactor } from '../appweb/ui/reactor.ts';
import { calculateConsoleFit } from '../appweb/ui/consoleFit.ts';
import { formatMutationRate } from '../appweb/ui/formatMutationRate.ts';
import { SoupMatrix } from '../appweb/ui/soupMatrix.ts';
import { TapeFrequencyView } from '../appweb/ui/tapeFrequencyView.ts';
import { CANVAS_FONT_FAMILY } from '../appweb/ui/typography.ts';
import { RunsController } from '../appweb/react/components/runs/runsController.ts';

type PaintOperation = 'fillRect' | 'fillText' | 'fill' | 'stroke' | 'strokeRect';

interface PaintCall {
  operation: PaintOperation;
  style: string;
  font?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  dash?: number[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ui regression: ${message}`);
}

assert(
  DEFAULT_CONFIG.engine === 'brainfuck-life' &&
    DEFAULT_CONFIG.nTapes === 4096 &&
    DEFAULT_CONFIG.seed === 4,
  'a fresh manual session did not use the Brainfuck-Life default profile',
);
const cubffDefaults = defaultConfigForEngine('cubff');
assert(
  cubffDefaults.engine === 'cubff' &&
    cubffDefaults.nTapes === 131072 &&
    cubffDefaults.seed === 0,
  'the CuBFF default profile changed',
);
assert(
  defaultConfigForEngine('brainfuck-life') !== defaultConfigForEngine('brainfuck-life'),
  'engine default lookup exposed shared mutable profile state',
);

function rgbCss([r, g, b]: readonly number[]): string {
  return `rgb(${r},${g},${b})`;
}

function relativeLuminance([r, g, b]: readonly number[]): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

assert(formatMutationRate(0) === 'off', 'zero mutation rate was not labelled off');
assert(
  formatMutationRate(1.1e-6) === '0.00011%',
  'the minimum mutation range was not rendered as a readable percentage',
);
assert(
  formatMutationRate(1 / 4096) === '0.0244%',
  'the source-aligned mutation rate was not rendered accurately',
);
assert(formatMutationRate(1e-3) === '0.1%', 'a 0.1% mutation rate was not rendered directly');
assert(formatMutationRate(1e-2) === '1%', 'a 1% mutation rate was not rendered directly');

const fullConsole = calculateConsoleFit(1600, 900, 1520, 800);
assert(fullConsole.scale === 1, 'a sufficient viewport scaled the console');
assert(
  fullConsole.logicalWidth === 1600 && fullConsole.logicalHeight === 900,
  'an unscaled console did not fill its viewport',
);

const fittedConsole = calculateConsoleFit(1400, 900, 1520, 800);
assert(
  Math.abs(fittedConsole.scale - 1400 / 1520) < 1e-12,
  'a moderately narrow viewport did not fit the console exactly',
);
assert(
  Math.abs(fittedConsole.stageWidth - 1400) < 1e-9,
  'the fitted stage did not match the available width',
);

const flooredConsole = calculateConsoleFit(1200, 700, 1520, 800);
assert(flooredConsole.scale === 0.88, 'the console scaled below its readability floor');
assert(
  flooredConsole.stageWidth > 1200 && flooredConsole.stageHeight > 700,
  'the scale floor did not retain scrolling for a smaller viewport',
);

class RecordingContext {
  calls: PaintCall[] = [];
  fillStyle = '';
  strokeStyle = '';
  font = '';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  lineWidth = 1;
  lineJoin: CanvasLineJoin = 'miter';
  lineDash: number[] = [];
  imageSmoothingEnabled = false;
  globalCompositeOperation = 'source-over';
  globalAlpha = 1;
  filter = 'none';
  shadowColor = '';
  shadowBlur = 0;

  setTransform(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  clearRect(): void {}
  drawImage(): void {}
  putImageData(): void {}

  createImageData(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.calls.push({ operation: 'fillRect', style: this.fillStyle, x, y, width, height });
  }

  fillText(text: string, x: number, y: number): void {
    this.calls.push({ operation: 'fillText', style: this.fillStyle, font: this.font, text, x, y });
  }

  fill(): void {
    this.calls.push({ operation: 'fill', style: this.fillStyle });
  }

  stroke(): void {
    this.calls.push({ operation: 'stroke', style: this.strokeStyle, dash: [...this.lineDash] });
  }

  setLineDash(segments: number[]): void {
    this.lineDash = [...segments];
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.calls.push({ operation: 'strokeRect', style: this.strokeStyle, x, y, width, height });
  }
}

function makeReactor(
  pair: Uint8Array,
  width = 640,
  height = 120,
): { reactor: Reactor; context: RecordingContext } {
  const context = new RecordingContext();
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;
  const reactor = new Reactor(canvas);
  reactor.load(17, 23, pair, 64, HEAD_WRAP, NOMATCH_HALT);
  return { reactor, context };
}

function makeOrderPlot(width = 800, height = 300): {
  plot: OrderPlot;
  context: RecordingContext;
} {
  const context = new RecordingContext();
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;
  return { plot: new OrderPlot(canvas), context };
}

function makeTapeFrequencyView(width = 800, height = 300): {
  view: TapeFrequencyView;
  context: RecordingContext;
} {
  const context = new RecordingContext();
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;
  return { view: new TapeFrequencyView(canvas), context };
}

function makeSoupMatrix(width = 800, height = 300): {
  matrix: SoupMatrix;
  context: RecordingContext;
} {
  const context = new RecordingContext();
  const offscreenContext = new RecordingContext();
  const mutableGlobal = globalThis as unknown as {
    document?: { createElement(tag: string): HTMLCanvasElement };
  };
  const previousDocument = mutableGlobal.document;
  mutableGlobal.document = {
    createElement: () =>
      ({
        width: 1,
        height: 1,
        getContext: (kind: string) => (kind === '2d' ? offscreenContext : null),
      }) as unknown as HTMLCanvasElement,
  };
  try {
    const canvas = {
      width,
      height,
      clientWidth: width,
      clientHeight: height,
      getContext: (kind: string) => (kind === '2d' ? context : null),
    } as unknown as HTMLCanvasElement;
    return { matrix: new SoupMatrix(canvas), context };
  } finally {
    if (previousDocument) mutableGlobal.document = previousDocument;
    else delete mutableGlobal.document;
  }
}

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function loadBatchDraft(
  key: 'clr.batch-draft.v3' | 'clr.batch-draft.v4',
  items: unknown[],
): { queue: BatchRunDefinition[]; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  storage.setItem(key, JSON.stringify({ name: 'migration test', items }));
  const runs = new RunsController({
    repository: Promise.resolve(new MemoryRunRepository()),
    currentConfig: () => defaultConfigForEngine('cubff'),
    webGpuAvailable: () => true,
    storage,
  });
  return {
    queue: structuredClone(runs.getSnapshot().queue) as BatchRunDefinition[],
    storage,
  };
}

const mutableGlobal = globalThis as unknown as { localStorage?: MemoryStorage };
const previousStorage = mutableGlobal.localStorage;
const preferenceStorage = new MemoryStorage();
mutableGlobal.localStorage = preferenceStorage;
try {
  preferenceStorage.setItem(
    'bff-console.params.v1',
    JSON.stringify({
      nTapes: 4096,
      tapeLen: 32,
      maxSteps: 2048,
      seed: 4,
      mutationRate: 0,
      workers: 7,
      rate: '10',
      mode: 'value',
      sample: 'random',
      rxrate: '0.5',
      sampler: false,
      help: false,
      helpTopic: 'soup',
      helpBox: { x: 10, y: 20, w: 400, h: 300 },
    }),
  );
  const migrated = loadPrefs();
  assert(migrated.mode === 'value', 'legacy UI mode was not migrated');
  assert(!('nTapes' in migrated), 'legacy tape count remained a startup preference');
  assert(!('seed' in migrated), 'legacy seed remained a startup preference');
  assert(!('workers' in migrated), 'legacy worker count remained a startup preference');
  assert(!('rate' in migrated), 'legacy epoch rate remained a startup preference');
  assert(
    preferenceStorage.getItem('bff-console.params.v1') === null,
    'legacy experimental preferences were not removed after migration',
  );

  savePrefs({
    mode: 'ops',
    sample: 'busiest',
    rxrate: '1',
    sampler: true,
    help: false,
    helpTopic: 'fundamentals',
    helpBox: { x: 0, y: 0, w: 400, h: 300 },
  });
  const storedUi = JSON.parse(preferenceStorage.getItem('bff-console.ui.v2') ?? '{}');
  assert(!('nTapes' in storedUi), 'the UI preference blob stored experimental parameters');
  assert(!('engine' in storedUi), 'the UI preference blob stored the reactor engine');
  assert(!('rate' in storedUi), 'the UI preference blob stored execution rate');
} finally {
  if (previousStorage) mutableGlobal.localStorage = previousStorage;
  else delete mutableGlobal.localStorage;
}

const legacyBatchItem = {
  config: cubffDefaults,
  epochLimit: 20000,
  orderCrossing: 2,
  measurementInterval: 128,
};
const migratedBatchDraft = loadBatchDraft('clr.batch-draft.v3', [legacyBatchItem]);
assert(migratedBatchDraft.queue.length === 1, 'legacy batch draft was not restored');
assert(
  migratedBatchDraft.queue[0].computePath === 'wasm',
  'legacy batch draft did not default to Wasm',
);
const rewrittenBatchDraft = JSON.parse(
  migratedBatchDraft.storage.getItem('clr.batch-draft.v4') ?? '{}',
) as { items?: BatchRunDefinition[] };
assert(
  rewrittenBatchDraft.items?.[0].computePath === 'wasm',
  'legacy batch draft was not rewritten with an explicit compute path',
);

const currentGpuBatchDraft = loadBatchDraft('clr.batch-draft.v4', [
  { ...legacyBatchItem, computePath: 'webgpu' },
]);
assert(
  currentGpuBatchDraft.queue[0]?.computePath === 'webgpu',
  'current batch draft lost its WebGPU compute path',
);
const incompatibleBatchDraft = loadBatchDraft('clr.batch-draft.v4', [
  {
    ...legacyBatchItem,
    config: defaultConfigForEngine('brainfuck-life'),
    computePath: 'webgpu',
  },
]);
assert(
  incompatibleBatchDraft.queue.length === 0,
  'Brainfuck-Life batch draft accepted a WebGPU compute path',
);

const orderView = makeOrderPlot();
orderView.plot.pushOrder(100, 0.5, 0.1, 7.4);
orderView.plot.setCurrentEpoch(200);
orderView.plot.draw(1);
assert(
  orderView.context.calls
    .filter((call) => call.operation === 'fillText')
    .every((call) => call.font?.endsWith(CANVAS_FONT_FAMILY)),
  'population-order chart did not use the configured UI font',
);
assert(
  orderView.context.calls.some((call) => call.operation === 'fillText' && call.text === '200'),
  'population-order domain did not advance to the current snapshot epoch',
);
assert(
  orderView.context.calls.some(
    (call) => call.operation === 'fillText' && call.text === 'compressed (bits/byte)',
  ),
  'population-order chart did not label the compression axis',
);
const axisTitles = orderView.context.calls.filter(
  (call) =>
    call.operation === 'fillText' &&
    ['order (bits/byte)', 'compressed (bits/byte)', 'epoch'].includes(call.text ?? ''),
);
assert(axisTitles.length === 3, 'population-order chart did not draw all three axis titles');
assert(
  axisTitles.every(
    (call) => call.font === axisTitles[0].font && call.style === axisTitles[0].style,
  ),
  'population-order axis titles do not share one font and colour',
);
assert(
  orderView.context.calls.some(
    (call) => call.operation === 'stroke' && (call.dash?.length ?? 0) > 0,
  ),
  'population-order chart did not distinguish compression with a dashed trace',
);
orderView.plot.reset();
orderView.plot.setCurrentEpoch(10258); // final snapshot from the previous run
orderView.plot.setCurrentEpoch(0); // ordered epoch-0 snapshot from the new run
orderView.context.calls = [];
orderView.plot.draw(1);
assert(
  !orderView.context.calls.some(
    (call) => call.operation === 'fillText' && call.text === '10258',
  ),
  'population-order domain retained the previous run after restart',
);

const frequencyView = makeTapeFrequencyView();
frequencyView.view.draw(
  [{ bytes: new Uint8Array(64), count: 1, contentHash: 0 }],
  4096,
  4096,
  64,
);
assert(
  frequencyView.context.calls.some(
    (call) => call.operation === 'fillText' && call.text === '1',
  ),
  'an all-unique population did not render its count-one frequency row',
);
assert(
  frequencyView.view.viewNote.startsWith('rank 1 of 4096 groups'),
  'the count-one exact-tape view did not identify its visible rank',
);
assert(
  !frequencyView.view.viewNote.includes('·'),
  'the exact-tape measurement note used an ambiguous dot separator',
);

frequencyView.context.calls = [];
frequencyView.view.draw(
  [{ bytes: new Uint8Array(64), count: 17, contentHash: 0x12345678 }],
  4080,
  4096,
  64,
);
assert(
  frequencyView.context.calls.some(
    (call) => call.operation === 'fillText' && call.text === '17',
  ),
  'a repeated exact tape did not render its population count',
);
assert(
  frequencyView.view.viewNote.startsWith('rank 1 of 4080 groups'),
  'the populated exact-tape view did not report rank context',
);
frequencyView.context.calls = [];
frequencyView.view.clearPopulation();
assert(
  frequencyView.view.viewNote === 'no groups',
  'the exact-tape view retained population counts across a run boundary',
);
assert(
  frequencyView.context.calls.some(
    (call) => call.operation === 'fillRect' && call.style === DISPLAY_FACE_CSS,
  ),
  'the exact-tape view retained old pixels across a run boundary',
);

const soupMatrix = makeSoupMatrix();
soupMatrix.matrix.layout(4, 4);
soupMatrix.matrix.draw(Uint8Array.from({ length: 16 }, (_, index) => index));
soupMatrix.context.calls = [];
soupMatrix.matrix.clearPopulation();
assert(
  (soupMatrix.matrix as unknown as { last: Uint8Array | null }).last === null,
  'the soup matrix retained the previous population byte array',
);
assert(
  soupMatrix.context.calls.some(
    (call) => call.operation === 'fillRect' && call.style === DISPLAY_FACE_CSS,
  ),
  'the soup matrix retained old pixels across a run boundary',
);

const expectedValueStops: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [29, 48, 60]],
  [64, [36, 69, 83]],
  [128, [45, 91, 106]],
  [192, [61, 115, 128]],
  [255, [91, 144, 152]],
];
assert(VALUE_STOPS.length === expectedValueStops.length, 'raw-byte scale has the wrong stop count');
for (let i = 0; i < expectedValueStops.length; i++) {
  const [value, rgb] = expectedValueStops[i];
  assert(VALUE_STOPS[i].value === value, `raw-byte stop ${i} has the wrong byte value`);
  assert(
    VALUE_STOPS[i].rgb.every((channel, channelIndex) => channel === rgb[channelIndex]),
    `raw-byte stop ${value} has the wrong colour`,
  );
  assert(
    valueRgb(value).every((channel, channelIndex) => channel === rgb[channelIndex]),
    `raw-byte interpolation does not pass through stop ${value}`,
  );
}

const screenLuminance = relativeLuminance([10, 7, 4]);
let previousValueLuminance = -Infinity;
for (let byte = 0; byte < 256; byte++) {
  const luminance = relativeLuminance(valueRgb(byte));
  assert(luminance >= previousValueLuminance, `raw-byte scale darkens at byte ${byte}`);
  const contrast = (luminance + 0.05) / (screenLuminance + 0.05);
  assert(contrast >= 1.4, `raw-byte colour ${byte} is not visible against the sampler background`);
  previousValueLuminance = luminance;
}

for (let byte = 0; byte < 256; byte++) {
  const [r, g, b] = operatorRgb(byte);
  const colour = `rgb(${r},${g},${b})`;
  assert(colour === CLASS_CSS[OP_CLASS[byte]], `byte ${byte} has an inconsistent class colour`);
}

const pair = Uint8Array.of(0, 255, B_INC, B_H0L, B_H1L, B_GET, B_LB, B_INC);
const { reactor, context } = makeReactor(pair);
reactor.draw(1);
assert(
  context.calls
    .filter((call) => call.operation === 'fillText')
    .every((call) => call.font?.endsWith(CANVAS_FONT_FAMILY)),
  'sampler did not use the configured UI font',
);

const baseBytes = context.calls.filter((call) => call.operation === 'fillRect').slice(1);
assert(baseBytes.length === pair.length, 'sampler did not paint every byte exactly once');
for (let i = 0; i < pair.length; i++) {
  const expectedColour = OP_CLASS[pair[i]] === 0
    ? rgbCss(valueRgb(pair[i]))
    : CLASS_CSS[OP_CLASS[pair[i]]];
  assert(
    baseBytes[i].style === expectedColour,
    `byte ${pair[i]} used ${baseBytes[i].style} instead of ${expectedColour}`,
  );
  assert(baseBytes[i].width === baseBytes[i].height, `byte ${i} is not square`);
}
assert(baseBytes[0].style !== baseBytes[1].style, 'distinct no-operation values look identical');
assert(baseBytes[0].style === rgbCss(valueRgb(0)), 'byte 0 does not use the raw-byte scale');
assert(baseBytes[1].style === rgbCss(valueRgb(255)), 'byte 255 does not use the raw-byte scale');

const byteLabels = context.calls.filter(
  (call) => call.operation === 'fillText' && call.style === BYTE_LABEL_CSS,
);
assert(byteLabels.length === pair.length, 'sampler did not label every byte');
for (let i = 0; i < pair.length; i++) {
  assert(byteLabels[i].text === String(pair[i]), `byte ${i} has the wrong decimal label`);
  assert(
    (byteLabels[i].y ?? -1) > (baseBytes[i].y ?? 0) + (baseBytes[i].height ?? 0),
    `byte ${i} label is not underneath its byte`,
  );
  assert(
    byteLabels[i].x === (baseBytes[i].x ?? 0) + (baseBytes[i].width ?? 0) / 2,
    `byte ${i} label is not centred under its byte`,
  );
}

const positionRanges = context.calls
  .filter((call) => call.operation === 'fillText' && call.text?.startsWith('positions '))
  .map((call) => call.text);
assert(
  positionRanges.join(',') === 'positions 0–3,positions 4–7',
  'sampler position ranges are unclear',
);

function verifyMinimumLayout(tapeLength: 32 | 64 | 128): PaintCall[] {
  const sample = Uint8Array.from({ length: tapeLength * 2 }, (_, index) => index & 255);
  const view = makeReactor(sample, 1480, 91);
  view.reactor.draw(1);
  const labels = view.context.calls.filter(
    (call) => call.operation === 'fillText' && call.style === BYTE_LABEL_CSS,
  );
  const bases = view.context.calls.filter((call) => call.operation === 'fillRect').slice(1);
  assert(labels.length === sample.length, `${tapeLength}-byte tapes lost decimal labels`);
  assert(bases.length === sample.length, `${tapeLength}-byte tapes lost byte backgrounds`);
  for (let i = 0; i < sample.length; i++) {
    assert(bases[i].width === bases[i].height, `${tapeLength}-byte layout byte ${i} is not square`);
    assert(labels[i].text === String(sample[i]), `byte ${i} has the wrong minimum-layout label`);
    assert(
      labels[i].x === (bases[i].x ?? 0) + (bases[i].width ?? 0) / 2,
      `byte ${i} label is not horizontally centred`,
    );
    const expectedPx = tapeLength === 128 ? 9 : 10;
    assert(labels[i].font?.startsWith(`${expectedPx}px `), `byte ${i} label is too small`);
  }
  return labels;
}

verifyMinimumLayout(32);
verifyMinimumLayout(64);
const denseLabels = verifyMinimumLayout(128);
assert(denseLabels[0].y !== denseLabels[1].y, 'adjacent dense labels share one baseline');
assert(denseLabels[0].y === denseLabels[2].y, 'even dense labels do not share a baseline');
assert(denseLabels[1].y === denseLabels[3].y, 'odd dense labels do not share a baseline');

const glyphCalls = context.calls.filter(
  (call) =>
    call.operation === 'fillText' &&
    call.text?.length === 1 &&
    GLYPH[call.text.charCodeAt(0)] === call.text,
);
const expectedGlyphs = Array.from(pair, (byte) => GLYPH[byte]).filter(Boolean);
assert(glyphCalls.length === expectedGlyphs.length, 'sampler omitted an operation glyph');
for (let i = 0; i < glyphCalls.length; i++) {
  assert(glyphCalls[i].text === expectedGlyphs[i], 'sampler drew operation glyphs out of order');
  assert(glyphCalls[i].style === DISPLAY_FACE_CSS, 'sampler operation glyph was not dark');
}

const markerCalls = context.calls.filter(
  (call) => call.operation === 'fill' || call.operation === 'stroke' || call.operation === 'strokeRect',
);
const expectedMarkers: ReadonlyArray<readonly [PaintOperation, string]> = [
  ['fill', '#ff7a1a'],
  ['stroke', '#fff0cc'],
  ['fill', '#ffd88a'],
  ['strokeRect', 'rgba(255,216,138,0.85)'],
];
assert(markerCalls.length === expectedMarkers.length, 'sampler marker paint sequence changed');
for (let i = 0; i < markerCalls.length; i++) {
  const [operation, style] = expectedMarkers[i];
  assert(
    markerCalls[i].operation === operation && markerCalls[i].style === style,
    `sampler marker ${i + 1} used ${markerCalls[i].operation}/${markerCalls[i].style}`,
  );
}
const ipOutline = markerCalls.find((call) => call.operation === 'strokeRect');
assert(ipOutline !== undefined, 'sampler did not outline the instruction-pointer byte');
for (const key of ['x', 'y', 'width', 'height'] as const) {
  assert(ipOutline[key] === baseBytes[0][key], `instruction-pointer outline has a different ${key}`);
}

const writePair = Uint8Array.of(B_INC, 0, 0, 0);
const written = makeReactor(writePair);
written.reactor.advance(1);
written.reactor.draw(1);
const flashStyle = 'rgba(255,232,190,0.85)';
const flashIndex = written.context.calls.findIndex(
  (call) => call.operation === 'fillRect' && call.style === flashStyle,
);
assert(flashIndex >= 0, 'a changed byte did not receive the pale write flash');
const flash = written.context.calls[flashIndex];
const baseIndex = written.context.calls.findIndex(
  (call, index) =>
    index < flashIndex &&
    call.operation === 'fillRect' &&
    call.x === flash.x &&
    call.y === flash.y &&
    call.width === flash.width &&
    call.height === flash.height,
);
assert(baseIndex >= 0, 'write flash had no matching byte');
assert(
  written.context.calls[baseIndex].style === CLASS_CSS[OP_CLASS[B_GET]],
  'written byte did not receive its new operation-class base colour',
);
assert(baseIndex < flashIndex, 'write flash was painted before its byte');

const writtenLabels = written.context.calls
  .filter((call) => call.operation === 'fillText' && call.style === BYTE_LABEL_CSS)
  .map((call) => call.text);
assert(writtenLabels.join(',') === '44,0,0,0', 'a changed byte kept its previous decimal label');

console.log(
  'ui regression: preferences, batch-draft migration, percentages, dual-axis order chart, raw scale, sampler rendering, and markers passed',
);

import {
  UiExternalStore,
  type ReadonlyExternalStore,
} from '../runtime/externalStore.ts';
import {
  isHelpTopicId,
  type HelpTopicId,
  type HelpWindowBox,
} from './helpModel.ts';

const DEFAULT_TOPIC: HelpTopicId = 'fundamentals';
const DEFAULT_WIDTH = 430;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;
const INITIAL_EDGE = 22;
const INITIAL_TOP = 84;
const FALLBACK_VIEWPORT_WIDTH = 1024;

export interface HelpWindowSnapshot {
  readonly open: boolean;
  readonly topic: HelpTopicId;
  readonly box: Readonly<HelpWindowBox>;
  /** False until geometry was restored or measured at the first open. */
  readonly hasExplicitPosition: boolean;
  /** Increments for every valid open request, including the current topic. */
  readonly contentRevision: number;
}

export interface HelpWindowControllerOptions {
  readonly viewportWidth?: number;
  readonly initialBox?: Partial<HelpWindowBox> | null;
  readonly initialTopic?: string;
  readonly initiallyOpen?: boolean;
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function currentViewportWidth(configuredWidth: number | undefined): number {
  if (finite(configuredWidth) && configuredWidth > 0) return configuredWidth;
  if (typeof window !== 'undefined' && finite(window.innerWidth) && window.innerWidth > 0) {
    return window.innerWidth;
  }
  return FALLBACK_VIEWPORT_WIDTH;
}

function freezeBox(box: HelpWindowBox): Readonly<HelpWindowBox> {
  return Object.freeze({
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
  });
}

function initialBox(options: HelpWindowControllerOptions): Readonly<HelpWindowBox> {
  const supplied = options.initialBox;
  const w = finite(supplied?.w) && supplied.w >= MIN_WIDTH
    ? supplied.w
    : DEFAULT_WIDTH;
  const h = finite(supplied?.h) && supplied.h >= MIN_HEIGHT
    ? supplied.h
    : DEFAULT_HEIGHT;
  const viewportWidth = currentViewportWidth(options.viewportWidth);

  return freezeBox({
    x: finite(supplied?.x)
      ? supplied.x
      : Math.max(0, viewportWidth - w - INITIAL_EDGE),
    y: finite(supplied?.y) ? supplied.y : INITIAL_TOP,
    w,
    h,
  });
}

function freezeSnapshot(snapshot: HelpWindowSnapshot): HelpWindowSnapshot {
  return Object.freeze(snapshot);
}

function sameBox(
  left: Readonly<HelpWindowBox>,
  right: Readonly<HelpWindowBox>,
): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.w === right.w
    && left.h === right.h;
}

/**
 * DOM-independent owner of the reactor-manual window's declarative state.
 *
 * React consumes the stable external-store interface. Main-thread action and
 * preference adapters use the same open/close/toggle/place surface.
 */
export class HelpWindowController
implements ReadonlyExternalStore<HelpWindowSnapshot> {
  /** Fired after user-visible state changes, but not while restoring placement. */
  onChange: (() => void) | null = null;

  readonly #store: UiExternalStore<HelpWindowSnapshot>;

  constructor(options: HelpWindowControllerOptions = {}) {
    const topic = typeof options.initialTopic === 'string'
      && isHelpTopicId(options.initialTopic)
      ? options.initialTopic
      : DEFAULT_TOPIC;

    this.#store = new UiExternalStore<HelpWindowSnapshot>(freezeSnapshot({
      open: options.initiallyOpen === true,
      topic,
      box: initialBox(options),
      hasExplicitPosition: finite(options.initialBox?.x) && finite(options.initialBox?.y),
      contentRevision: 0,
    }));
  }

  readonly getSnapshot = (): HelpWindowSnapshot => this.#store.getSnapshot();

  readonly subscribe = (listener: () => void): (() => void) => (
    this.#store.subscribe(listener)
  );

  get isOpen(): boolean {
    return this.getSnapshot().open;
  }

  get topic(): HelpTopicId {
    return this.getSnapshot().topic;
  }

  get box(): Readonly<HelpWindowBox> {
    return this.getSnapshot().box;
  }

  get hasExplicitPosition(): boolean {
    return this.getSnapshot().hasExplicitPosition;
  }

  open(topic: string): void {
    if (!isHelpTopicId(topic)) return;

    const current = this.getSnapshot();
    this.#publish({
      ...current,
      open: true,
      topic,
      contentRevision: current.contentRevision + 1,
    }, true);
  }

  close(): void {
    const current = this.getSnapshot();
    if (!current.open) return;

    this.#publish({ ...current, open: false }, true);
  }

  toggle(topic: string): void {
    if (!isHelpTopicId(topic)) return;

    const current = this.getSnapshot();
    if (current.open && current.topic === topic) this.close();
    else this.open(topic);
  }

  /** Restore persisted geometry during bootstrap, before the first view placement. */
  place(box: Partial<HelpWindowBox> | null | undefined): void {
    if (!box) return;
    this.#updateBox(box, false, finite(box.x) && finite(box.y));
  }

  /** Accept geometry reported after a drag, resize, or viewport clamp. */
  setBox(box: Readonly<HelpWindowBox>): void {
    this.#updateBox(box, true, true);
  }

  #updateBox(
    box: Partial<HelpWindowBox>,
    reportChange: boolean,
    establishesPosition: boolean,
  ): void {
    const current = this.getSnapshot();
    const next = freezeBox({
      x: finite(box.x) ? box.x : current.box.x,
      y: finite(box.y) ? box.y : current.box.y,
      w: finite(box.w) && box.w >= MIN_WIDTH ? box.w : current.box.w,
      h: finite(box.h) && box.h >= MIN_HEIGHT ? box.h : current.box.h,
    });
    const hasExplicitPosition = current.hasExplicitPosition || establishesPosition;
    if (sameBox(current.box, next) && hasExplicitPosition === current.hasExplicitPosition) return;

    this.#publish({ ...current, box: next, hasExplicitPosition }, reportChange);
  }

  #publish(snapshot: HelpWindowSnapshot, reportChange: boolean): void {
    this.#store.publish(freezeSnapshot(snapshot));
    if (reportChange) this.onChange?.();
  }
}

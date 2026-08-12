import type { TapeFrequencyGroup } from '../../engine/src/soup.ts';
import { GLYPH, OP_CLASS } from '../../engine/src/opcodes.ts';
import { CLASS_CSS, DISPLAY_FACE_CSS } from './palette.ts';
import { CANVAS_FONT_FAMILY } from './typography.ts';

const TEXT = 'rgba(166,168,177,0.82)';
const TEXT_DIM = 'rgba(120,124,136,0.66)';
const AMBER = '#ffb000';

export function formatContentHash(hash: number): string {
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function formatPopulationShare(share: number): string {
  const percent = share * 100;
  return `${percent.toFixed(percent < 0.01 ? 3 : 2)} %`;
}

/**
 * Ranked exact whole-tape frequencies on the Soup canvas.
 *
 * This renderer deliberately has no matrix transform. Its only view state is
 * the first visible rank, so entering it cannot alter SoupMatrix zoom or pan.
 */
export class TapeFrequencyView {
  dirty = true;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private firstRow = 0;
  private visibleRows = 0;
  private shownRows = 0;
  private distinctGroups = 0;
  private retainedGroups = 0;
  private scrollTop = 0;
  private scrollHeight = 0;
  private thumbTop = 0;
  private thumbHeight = 0;
  private scrollbarX = 0;
  private draggingThumb = false;
  private thumbGrabY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  resize(dpr: number): void {
    this.dpr = dpr;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.dirty = true;
  }

  resetView(): void {
    if (this.firstRow === 0) return;
    this.firstRow = 0;
    this.dirty = true;
  }

  scrollBy(deltaY: number): void {
    if (!deltaY || this.retainedGroups <= this.visibleRows) return;
    const rows = Math.max(1, Math.round(Math.abs(deltaY) / 18));
    const maximum = Math.max(0, this.retainedGroups - this.visibleRows);
    const next = Math.max(0, Math.min(maximum, this.firstRow + Math.sign(deltaY) * rows));
    if (next === this.firstRow) return;
    this.firstRow = next;
    this.dirty = true;
  }

  /** Begin a thumb drag or page the ranked rows through a track click. */
  pointerDown(x: number, y: number): boolean {
    if (!this.hasScrollbar() || Math.abs(x - this.scrollbarX) > 6 * this.dpr) return false;
    if (y < this.scrollTop || y > this.scrollTop + this.scrollHeight) return false;
    if (y >= this.thumbTop && y <= this.thumbTop + this.thumbHeight) {
      this.draggingThumb = true;
      this.thumbGrabY = y - this.thumbTop;
      return true;
    }
    const direction = y < this.thumbTop ? -1 : 1;
    this.setFirstRow(this.firstRow + direction * this.visibleRows);
    return true;
  }

  /** Move the scrollbar thumb; returns true when the rank changed. */
  pointerMove(_x: number, y: number): boolean {
    if (!this.draggingThumb) return false;
    const maximum = this.retainedGroups - this.visibleRows;
    const travel = this.scrollHeight - this.thumbHeight;
    if (maximum <= 0 || travel <= 0) return false;
    const fraction = (y - this.thumbGrabY - this.scrollTop) / travel;
    return this.setFirstRow(Math.round(fraction * maximum));
  }

  pointerUp(): void {
    this.draggingThumb = false;
  }

  private hasScrollbar(): boolean {
    return this.retainedGroups > this.visibleRows;
  }

  private setFirstRow(row: number): boolean {
    const maximum = Math.max(0, this.retainedGroups - this.visibleRows);
    const next = Math.max(0, Math.min(maximum, row));
    if (next === this.firstRow) return false;
    this.firstRow = next;
    this.dirty = true;
    return true;
  }

  get viewNote(): string {
    if (!this.distinctGroups || !this.shownRows) return 'no groups';
    const first = this.firstRow + 1;
    const last = first + this.shownRows - 1;
    const range = first === last ? `rank ${first}` : `ranks ${first}–${last}`;
    const retained =
      this.retainedGroups < this.distinctGroups
        ? `, top ${this.retainedGroups} retained`
        : '';
    return `${range} of ${this.distinctGroups} groups${retained}`;
  }

  /** Remove run-derived counts while retaining the operator's scroll position. */
  clearPopulation(): void {
    this.visibleRows = 0;
    this.shownRows = 0;
    this.distinctGroups = 0;
    this.retainedGroups = 0;
    this.draggingThumb = false;
    this.scrollHeight = 0;
    this.thumbHeight = 0;

    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.dirty = false;
  }

  draw(
    groups: readonly TapeFrequencyGroup[],
    distinctGroups: number,
    population: number,
    tapeLen: number,
  ): void {
    const { ctx, canvas, dpr } = this;
    const width = canvas.width;
    const height = canvas.height;
    const px = (value: number) => value * dpr;
    const padX = px(12);
    const padY = px(9);
    const headerHeight = px(23);
    const rowHeight = px(18);

    this.distinctGroups = distinctGroups;
    this.retainedGroups = groups.length;
    this.visibleRows = Math.max(1, Math.floor((height - padY * 2 - headerHeight) / rowHeight));
    const maximum = Math.max(0, this.retainedGroups - this.visibleRows);
    this.firstRow = Math.min(this.firstRow, maximum);
    const lastRow = Math.min(this.retainedGroups, this.firstRow + this.visibleRows);
    this.shownRows = Math.max(0, lastRow - this.firstRow);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, width, height);

    const countRight = padX + px(42);
    const shareRight = countRight + px(66);
    const hashRight = shareRight + px(72);
    const tapeX = hashRight + px(12);
    const scrollbarSpace = this.hasScrollbar() ? px(12) : 0;
    const tapeWidth = Math.max(1, width - padX - tapeX - scrollbarSpace);

    ctx.font = `${px(10)}px ${CANVAS_FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'right';
    const headerY = padY + headerHeight / 2;
    ctx.fillText('count', countRight, headerY);
    ctx.fillText('share', shareRight, headerY);
    ctx.fillText('hash', hashRight, headerY);
    ctx.textAlign = 'left';
    ctx.fillText('tape', tapeX, headerY);

    const rowTop = padY + headerHeight;
    ctx.font = `${px(11)}px ${CANVAS_FONT_FAMILY}`;
    for (let visible = 0; visible < this.shownRows; visible++) {
      const group = groups[this.firstRow + visible];
      const top = rowTop + visible * rowHeight;
      const middle = top + rowHeight / 2;
      const share = population > 0 ? group.count / population : 0;

      const shareBarWidth = (width - padX * 2) * share;
      if (shareBarWidth >= px(1)) {
        ctx.fillStyle = 'rgba(122,74,8,0.17)';
        ctx.fillRect(padX, top + px(1), shareBarWidth, rowHeight - px(2));
      }
      ctx.fillStyle = 'rgba(255,176,0,0.055)';
      ctx.fillRect(padX, top + rowHeight - 1, width - padX * 2, 1);

      ctx.textAlign = 'right';
      ctx.fillStyle = AMBER;
      ctx.fillText(String(group.count), countRight, middle);
      ctx.fillStyle = TEXT;
      ctx.fillText(formatPopulationShare(share), shareRight, middle);
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(formatContentHash(group.contentHash), hashRight, middle);

      const cellWidth = tapeLen > 0 ? tapeWidth / tapeLen : 0;
      const glyphPx = Math.min(px(12), rowHeight * 0.72, Math.max(px(7), cellWidth * 1.25));
      ctx.font = `${glyphPx}px ${CANVAS_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      for (let byteIndex = 0; byteIndex < group.bytes.length; byteIndex++) {
        const byte = group.bytes[byteIndex];
        const operationClass = OP_CLASS[byte];
        if (operationClass === 0) continue;
        ctx.fillStyle = CLASS_CSS[operationClass];
        ctx.fillText(GLYPH[byte], tapeX + (byteIndex + 0.5) * cellWidth, middle);
      }
      ctx.font = `${px(11)}px ${CANVAS_FONT_FAMILY}`;
    }

    if (this.hasScrollbar()) {
      this.scrollbarX = width - px(7);
      this.scrollTop = rowTop + px(2);
      this.scrollHeight = Math.max(px(20), height - this.scrollTop - padY - px(2));
      this.thumbHeight = Math.max(
        px(18),
        this.scrollHeight * (this.visibleRows / this.retainedGroups),
      );
      const maximum = this.retainedGroups - this.visibleRows;
      const travel = this.scrollHeight - this.thumbHeight;
      this.thumbTop = this.scrollTop + (maximum > 0 ? (this.firstRow / maximum) * travel : 0);

      ctx.fillStyle = 'rgba(120,124,136,0.16)';
      ctx.fillRect(this.scrollbarX - px(1), this.scrollTop, px(2), this.scrollHeight);
      ctx.fillStyle = 'rgba(166,168,177,0.56)';
      ctx.fillRect(this.scrollbarX - px(2), this.thumbTop, px(4), this.thumbHeight);
    } else {
      this.draggingThumb = false;
      this.scrollHeight = 0;
      this.thumbHeight = 0;
    }
  }
}

import { DISPLAY_FACE_CSS } from './palette.ts';
import { CANVAS_FONT_FAMILY } from './typography.ts';

/**
 * Two complementary population-order components and the compressor result,
 * all measured in bits per byte from the same immutable snapshot:
 *
 *   byte-frequency order = 8 - H0
 *   high-order entropy   = H0 - compressed bits per byte
 *   compressed bits/byte = direct Brotli 1.1.0 quality-2 result
 *
 * The first responds to concentration in the byte-frequency distribution. The
 * second is a compressor-dependent estimate of repeated multi-byte structure,
 * after arXiv:2406.19108. Compression has its own right-hand axis because it
 * begins near 8 and falls as the two order components rise.
 */
export class OrderPlot {
  /** Stable initial range: small pre-transition fluctuations stay visually small. */
  private static readonly Y_FLOOR = 2;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private epochs: number[] = [];
  private highOrder: number[] = [];
  private byteOrder: number[] = [];
  private compressedBpb: number[] = [];
  private yMin = 0;
  private yMax = OrderPlot.Y_FLOOR;
  /** Allow the small Brotli framing overhead of an incompressible population. */
  private compressionMax = 8.1;
  private lastMeasuredEpoch = 0;
  private maxEpoch = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d context unavailable');
    this.ctx = context;
  }

  reset(): void {
    this.epochs = [];
    this.highOrder = [];
    this.byteOrder = [];
    this.compressedBpb = [];
    this.yMin = 0;
    this.yMax = OrderPlot.Y_FLOOR;
    this.compressionMax = 8.1;
    this.lastMeasuredEpoch = 0;
    this.maxEpoch = 1;
  }

  pushOrder(
    epoch: number,
    highOrder: number,
    byteOrder: number,
    compressedBpb: number,
  ): void {
    this.epochs.push(epoch);
    this.highOrder.push(highOrder);
    this.byteOrder.push(byteOrder);
    this.compressedBpb.push(compressedBpb);
    this.lastMeasuredEpoch = Math.max(this.lastMeasuredEpoch, epoch);
    this.maxEpoch = Math.max(this.maxEpoch, epoch);
    this.includeValue(highOrder);
    this.includeValue(byteOrder);
    if (Number.isFinite(compressedBpb)) {
      this.compressionMax = Math.max(
        this.compressionMax,
        Math.ceil(compressedBpb * 10) / 10,
      );
    }
  }

  /** Advance the time domain without implying an unmeasured order value. */
  setCurrentEpoch(epoch: number): void {
    // Snapshot traffic is ordered and may legitimately return to epoch 0 after
    // restart. Keep any already-plotted measurement visible, but do not retain
    // the previous run's domain merely because its final snapshot arrived
    // between clearHistory() and the new run's epoch-0 snapshot.
    this.maxEpoch = Math.max(1, epoch, this.lastMeasuredEpoch);
  }

  resize(dpr: number): void {
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(dpr: number): void {
    const { ctx, canvas } = this;
    const width = canvas.width;
    const height = canvas.height;
    const px = (value: number) => value * dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, width, height);

    const padL = px(66);
    const padR = px(66);
    const padT = px(8);
    const padB = px(34);
    const plotWidth = width - padL - padR;
    const plotHeight = height - padT - padB;
    if (plotWidth <= 4 || plotHeight <= 4) return;

    const ySpan = this.yMax - this.yMin;
    const yAt = (value: number) => padT + ((this.yMax - value) / ySpan) * plotHeight;
    const compressionYAt = (value: number) =>
      padT + ((this.compressionMax - value) / this.compressionMax) * plotHeight;
    const xAt = (epoch: number) =>
      padL + (epoch / Math.max(1, this.maxEpoch)) * plotWidth;

    ctx.lineWidth = Math.max(1, dpr * 0.5);
    const axisFont = `${px(11)}px ${CANVAS_FONT_FAMILY}`;
    const axisLabelColor = 'rgba(150,150,160,0.55)';
    const axisTickColor = 'rgba(150,150,160,0.5)';
    ctx.font = axisFont;

    // A practical compressor can produce a small negative estimate because of
    // framing overhead. Preserve it below the emphasized zero baseline.
    if (this.yMin < 0) {
      const roomForLabel = yAt(this.yMin) - yAt(0) >= px(13);
      this.horizontalRule(
        this.yMin,
        roomForLabel ? this.yMin.toFixed(1) : '',
        false,
        yAt,
        padL,
        plotWidth,
        px,
      );
    }

    const tick = OrderPlot.tickStep(this.yMax);
    for (let value = 0; value <= this.yMax + 1e-9; value += tick) {
      this.horizontalRule(value, value.toFixed(1), value === 0, yAt, padL, plotWidth, px);
    }

    ctx.save();
    ctx.translate(px(10), padT + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = axisFont;
    ctx.fillStyle = axisLabelColor;
    ctx.fillText('order (bits/byte)', 0, 0);
    ctx.restore();

    const rightX = padL + plotWidth;
    ctx.strokeStyle = 'rgba(150,150,160,0.14)';
    ctx.fillStyle = axisTickColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const value of [0, this.compressionMax / 2, this.compressionMax]) {
      const y = compressionYAt(value);
      ctx.beginPath();
      ctx.moveTo(rightX, y);
      ctx.lineTo(rightX + px(4), y);
      ctx.stroke();
      ctx.fillText(value.toFixed(1), rightX + px(7), y);
    }

    ctx.save();
    ctx.translate(width - px(10), padT + plotHeight / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = axisFont;
    ctx.fillStyle = axisLabelColor;
    ctx.fillText('compressed (bits/byte)', 0, 0);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = axisTickColor;
    let previousEpoch = -1;
    for (let index = 0; index <= 4; index++) {
      const epoch = Math.round((this.maxEpoch * index) / 4);
      if (epoch === previousEpoch) continue;
      previousEpoch = epoch;
      ctx.fillText(String(epoch), xAt(epoch), padT + plotHeight + px(3));
    }
    ctx.textBaseline = 'bottom';
    ctx.font = axisFont;
    ctx.fillStyle = axisLabelColor;
    ctx.fillText('epoch', padL + plotWidth / 2, height - px(2));

    this.trace(
      this.compressedBpb,
      'rgba(196,196,204,0.72)',
      px(1.1),
      xAt,
      compressionYAt,
      [px(5), px(4)],
    );
    this.trace(this.byteOrder, 'rgba(150,150,160,0.78)', px(1.25), xAt, yAt);
    this.trace(this.highOrder, '#ffb000', px(1.5), xAt, yAt);
  }

  private includeValue(value: number): void {
    if (!Number.isFinite(value)) return;
    if (value < this.yMin) this.yMin = Math.floor(value * 11) / 10;
    const target = Math.max(OrderPlot.Y_FLOOR, value * 1.15);
    if (target > this.yMax) {
      const step = OrderPlot.tickStep(target);
      this.yMax = Math.ceil(target / step) * step;
    }
  }

  private static tickStep(maximum: number): number {
    if (maximum <= 2.5) return 0.5;
    if (maximum <= 5) return 1;
    return 2;
  }

  private horizontalRule(
    value: number,
    label: string,
    baseline: boolean,
    yAt: (value: number) => number,
    padL: number,
    plotWidth: number,
    px: (value: number) => number,
  ): void {
    const { ctx } = this;
    const y = yAt(value);
    ctx.strokeStyle = baseline ? 'rgba(255,176,0,0.16)' : 'rgba(255,176,0,0.07)';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotWidth, y);
    ctx.stroke();
    if (label) {
      ctx.fillStyle = 'rgba(150,150,160,0.5)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, padL - px(5), y);
    }
  }

  private trace(
    values: number[],
    color: string,
    width: number,
    xAt: (epoch: number) => number,
    yAt: (value: number) => number,
    dash: number[] = [],
  ): void {
    if (values.length === 0) return;
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();

    // Preserve the minimum and maximum in each pixel column so a rapid
    // transition remains visible after a long run compresses the x axis.
    let previousPixel = -1;
    let low = Infinity;
    let high = -Infinity;
    let started = false;
    for (let index = 0; index < values.length; index++) {
      const x = Math.round(xAt(this.epochs[index]));
      if (x !== previousPixel && previousPixel >= 0) {
        if (!started) {
          ctx.moveTo(previousPixel, yAt(high));
          started = true;
        } else {
          ctx.lineTo(previousPixel, yAt(high));
        }
        if (low !== high) ctx.lineTo(previousPixel, yAt(low));
        low = Infinity;
        high = -Infinity;
      }
      previousPixel = x;
      const value = values[index];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    if (previousPixel >= 0 && high >= low) {
      if (!started) ctx.moveTo(previousPixel, yAt(high));
      else ctx.lineTo(previousPixel, yAt(high));
      if (low !== high) ctx.lineTo(previousPixel, yAt(low));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

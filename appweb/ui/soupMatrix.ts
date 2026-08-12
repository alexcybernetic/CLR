import { GLYPH, OP_CLASS } from '../../engine/src/opcodes.ts';
import { abgr, buildOpsPalette, buildValuePalette, DISPLAY_FACE_CSS } from './palette.ts';
import { CANVAS_FONT_FAMILY } from './typography.ts';

export type SoupMatrixMode = 'value' | 'ops';

/**
 * One pixel per byte, every tape at once.
 *
 * Tapes are laid out in columns so the block matches the panel's aspect ratio,
 * with a one-pixel separator between columns baked into the image itself. That
 * keeps the whole thing a single bitmap, which is what makes zooming and
 * panning a plain source-rectangle draw.
 *
 * At the paper's 2^17 tapes the image is ~2900 px square inside a ~1000 px
 * panel, so a fitted view averages sixteen bytes into every screen pixel and
 * discards the structure before it can be seen. Hence the zoom.
 */
export class SoupMatrix {
  mode: SoupMatrixMode = 'ops';
  bloom = true;
  /** set when the pixel layout changed and the caller must repaint */
  dirty = false;
  /** the two tapes currently loaded in the sampler, or -1 */
  markA = -1;
  markB = -1;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private off = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private buf: Uint32Array = new Uint32Array(0);
  private imgW = 0;
  private imgH = 0;
  private colStride = 0;
  private tapesPerRow = 1;
  private nTapes = 0;
  private tapeLen = 0;
  private aspect = 1;

  /** view transform: 1 = fitted, larger = magnified. Pan is in image pixels. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** last computed transform, so screen<->image mapping stays consistent */
  private scale = 1;
  private srcX = 0;
  private srcY = 0;
  private dstX = 0;
  private dstY = 0;

  static readonly MAX_ZOOM = 64;
  /** separator between tape columns, in image pixels */
  private static readonly GAP = 1;
  private static readonly GAP_COLOUR = abgr(16, 11, 6);
  /** screen pixels per byte at which the byte can carry a legible character */
  private static readonly GLYPH_AT = 9;

  /** kept so the glyph overlay can read byte values back at high zoom */
  private last: Uint8Array | null = null;

  private palValue = buildValuePalette();
  private palOps = buildOpsPalette();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d');
    const o = this.off.getContext('2d');
    if (!c || !o) throw new Error('2d context unavailable');
    this.ctx = c;
    this.offCtx = o;
  }

  layout(nTapes: number, tapeLen: number): void {
    if (nTapes === this.nTapes && tapeLen === this.tapeLen) return;
    this.nTapes = nTapes;
    this.tapeLen = tapeLen;
    this.resetView();
    this.relayout();
  }

  private relayout(): void {
    const { nTapes, tapeLen, aspect } = this;
    if (!nTapes || !tapeLen) return;
    const tpr = Math.max(1, Math.min(nTapes, Math.round(Math.sqrt((aspect * nTapes) / tapeLen))));
    if (tpr === this.tapesPerRow && this.img) return;
    this.tapesPerRow = tpr;
    this.colStride = tapeLen + SoupMatrix.GAP;
    this.imgW = tpr * this.colStride - SoupMatrix.GAP;
    this.imgH = Math.ceil(nTapes / tpr);
    this.off.width = this.imgW;
    this.off.height = this.imgH;
    this.img = this.offCtx.createImageData(this.imgW, this.imgH);
    this.buf = new Uint32Array(this.img.data.buffer);
    // separators are constant; tape pixels are written over them each frame
    this.buf.fill(SoupMatrix.GAP_COLOUR);
    this.dirty = true;
  }

  /* ── view ──────────────────────────────────────────────────────────────── */

  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dirty = true;
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  /** Magnify about a point in canvas pixels, keeping that point fixed. */
  zoomAt(factor: number, cx: number, cy: number): void {
    const before = this.screenToImage(cx, cy);
    const next = Math.max(1, Math.min(SoupMatrix.MAX_ZOOM, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // recompute the transform at the new zoom, then shift so `before` stays put
    this.computeTransform();
    const after = this.screenToImage(cx, cy);
    this.panX += before.x - after.x;
    this.panY += before.y - after.y;
    this.dirty = true;
  }

  /** Drag by a canvas-pixel delta. */
  panBy(dx: number, dy: number): void {
    if (this.zoom <= 1) return;
    this.panX -= dx / this.scale;
    this.panY -= dy / this.scale;
    this.dirty = true;
  }

  private screenToImage(cx: number, cy: number): { x: number; y: number } {
    return {
      x: this.srcX + (cx - this.dstX) / this.scale,
      y: this.srcY + (cy - this.dstY) / this.scale,
    };
  }

  /**
   * Which tape lies under a point in canvas pixels, or -1 outside the block.
   *
   * A point on a column separator resolves to the tape on its left rather than
   * to nothing, so a click near an edge still lands somewhere. Fitted, one
   * screen pixel can cover many tapes and the hit is correspondingly coarse —
   * which is what the zoom is for.
   */
  tapeAt(cx: number, cy: number): number {
    if (!this.tapeLen || !this.img) return -1;
    const { x, y } = this.screenToImage(cx, cy);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.imgW || iy >= this.imgH) return -1;
    const t = iy * this.tapesPerRow + Math.floor(ix / this.colStride);
    return t < this.nTapes ? t : -1;
  }

  /**
   * What the view is currently showing.
   *
   * The magnification is stated once, as a density, rather than as both a
   * factor and a density: "3× · 1 byte = 3 px" put a dot between two numbers,
   * which reads as a product.
   */
  get viewNote(): string {
    if (!this.tapeLen) return '';
    const perPixel = 1 / this.scale;
    const density =
      perPixel >= 1.5
        ? `1 px holds ${Math.round(perPixel)} bytes`
        : `1 byte fills ${Math.round(this.scale)} px`;
    const chars = this.scale >= SoupMatrix.GLYPH_AT ? ', characters' : '';
    if (this.zoom <= 1) return `whole soup, ${density}${chars}`;
    const num = (n: number) => String(Math.round(n));
    const first = Math.max(0, Math.floor(this.srcY) * this.tapesPerRow);
    const rows = Math.ceil(this.canvas.height / this.scale);
    const last = Math.min(this.nTapes - 1, (Math.floor(this.srcY) + rows) * this.tapesPerRow - 1);
    return `${density}${chars}, tapes ${num(first)}–${num(last)}`;
  }

  resize(dpr: number): void {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
    const a = w / Math.max(1, h);
    if (Math.abs(a - this.aspect) > 0.02) {
      this.aspect = a;
      this.relayout();
    }
  }

  draw(soup: Uint8Array): void {
    if (!this.img) return;
    this.last = soup;
    const pal = this.mode === 'ops' ? this.palOps : this.palValue;
    const { imgW, colStride, tapesPerRow, tapeLen, nTapes, buf } = this;
    for (let t = 0; t < nTapes; t++) {
      const row = (t / tapesPerRow) | 0;
      const col = (t % tapesPerRow) * colStride;
      let src = t * tapeLen;
      let dst = row * imgW + col;
      for (let k = 0; k < tapeLen; k++) buf[dst++] = pal[soup[src++]];
    }
    this.offCtx.putImageData(this.img, 0, 0);
    this.blit();
  }

  /**
   * Remove population data without changing the operator's zoom or pan.
   *
   * A new run can be accepted before its first snapshot arrives. Clearing both
   * the byte reference and the rendered bitmap prevents the preceding run from
   * remaining visible, or from being read by the high-zoom glyph overlay,
   * during that interval.
   */
  clearPopulation(): void {
    this.last = null;
    this.markA = -1;
    this.markB = -1;
    if (this.img) {
      this.buf.fill(SoupMatrix.GAP_COLOUR);
      this.offCtx.putImageData(this.img, 0, 0);
    }
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.dirty = false;
  }

  /** Resolve zoom and pan into a source rectangle and a destination rectangle. */
  private computeTransform(): void {
    const { canvas, imgW, imgH } = this;
    const W = canvas.width;
    const H = canvas.height;
    const fit = Math.min(W / imgW, H / imgH);
    this.scale = fit * this.zoom;

    const sw = Math.min(imgW, W / this.scale);
    const sh = Math.min(imgH, H / this.scale);
    this.panX = Math.max(0, Math.min(imgW - sw, this.panX));
    this.panY = Math.max(0, Math.min(imgH - sh, this.panY));
    this.srcX = this.panX;
    this.srcY = this.panY;

    this.dstX = ((W - sw * this.scale) / 2) | 0;
    this.dstY = ((H - sh * this.scale) / 2) | 0;
  }

  private blit(): void {
    const { ctx, canvas, imgW, imgH } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, W, H);
    if (!this.tapeLen || !this.img) return;

    this.computeTransform();
    const sw = Math.min(imgW, W / this.scale);
    const sh = Math.min(imgH, H / this.scale);
    const dw = sw * this.scale;
    const dh = sh * this.scale;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, this.srcX, this.srcY, sw, sh, this.dstX, this.dstY, dw, dh);

    const glyphs = this.scale >= SoupMatrix.GLYPH_AT;
    // bloom is a blur pass; it would soften the characters it sits under
    if (this.bloom && !glyphs) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45;
      ctx.filter = 'blur(2.5px)';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.off, this.srcX, this.srcY, sw, sh, this.dstX, this.dstY, dw, dh);
      ctx.restore();
    }

    if (glyphs) this.drawGlyphs(sw, sh);

    this.markTape(this.markA, '#ffb000', 'A');
    this.markTape(this.markB, '#fff0cc', 'B');
  }

  /**
   * Once a byte is wide enough, stamp the instruction character into it.
   *
   * Colour alone says which class a byte belongs to; the character says which
   * of the pair it is — `<` from `>`, `[` from `]` — which is what you need to
   * read a replicator off the screen. Drawn in the screen colour so it reads as
   * a cut-out of the lit byte rather than ink on top of it.
   */
  private drawGlyphs(sw: number, sh: number): void {
    const soup = this.last;
    if (!soup) return;
    const { ctx, colStride, tapeLen, tapesPerRow, nTapes, scale } = this;

    const x0 = Math.max(0, Math.floor(this.srcX));
    const y0 = Math.max(0, Math.floor(this.srcY));
    const x1 = Math.min(this.imgW, Math.ceil(this.srcX + sw));
    const y1 = Math.min(this.imgH, Math.ceil(this.srcY + sh));

    ctx.save();
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.font = `${Math.round(scale * 0.78)}px ${CANVAS_FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let iy = y0; iy < y1; iy++) {
      const rowBase = iy * tapesPerRow;
      const sy = this.dstY + (iy - this.srcY) * scale + scale / 2;
      for (let ix = x0; ix < x1; ix++) {
        const within = ix % colStride;
        if (within >= tapeLen) continue; // column separator
        const t = rowBase + ((ix / colStride) | 0);
        if (t >= nTapes) continue;
        const v = soup[t * tapeLen + within];
        if (OP_CLASS[v] === 0) continue;
        ctx.fillText(GLYPH[v], this.dstX + (ix - this.srcX) * scale + scale / 2, sy);
      }
    }
    ctx.restore();
  }

  /** Ring a tape loaded in the sampler, so "which two" is answerable by eye. */
  private markTape(t: number, colour: string, label: string): void {
    if (t < 0 || t >= this.nTapes) return;
    const ix = (t % this.tapesPerRow) * this.colStride;
    const iy = (t / this.tapesPerRow) | 0;
    const x = this.dstX + (ix - this.srcX) * this.scale;
    const y = this.dstY + (iy - this.srcY) * this.scale;
    const w = this.tapeLen * this.scale;
    const h = Math.max(3, this.scale);
    const { ctx, canvas } = this;
    if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) return;

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 6;
    ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
    ctx.shadowBlur = 0;
    ctx.fillStyle = colour;
    ctx.font = `bold 11px ${CANVAS_FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(label, x - 5, y + h / 2);
    ctx.restore();
  }
}

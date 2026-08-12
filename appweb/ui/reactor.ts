import { GLYPH, OP_CLASS } from '../../engine/src/opcodes.ts';
import { HALT_RUNNING, VM } from '../../engine/src/vm.ts';
import { FramePacer } from './framePacer.ts';
import { BYTE_LABEL_CSS, DISPLAY_FACE_CSS, operatorRgb, valueRgb } from './palette.ts';
import { CANVAS_FONT_FAMILY } from './typography.ts';

/**
 * Single-pair scope. Runs its own VM over a copy of two glued tapes, so the
 * soup can keep going in the worker while this one is hand-stepped.
 */
export class Reactor {
  vm = new VM();
  tape = new Uint8Array(0);
  initial = new Uint8Array(0);
  a = -1;
  b = -1;
  running = false;
  speed = 1;
  /** glyphs of executed operations, oldest first (inert bytes are skipped) */
  trace: string[] = [];
  /** shown when nothing is loaded; the console sets it to name the way in */
  emptyNote = 'press next pair';

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tapeLen = 0;
  private pacer = new FramePacer();
  /** per-byte afterglow, 255 on write, decayed each frame */
  private flash = new Uint8Array(0);
  private shadow = new Uint8Array(0);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2d context unavailable');
    this.ctx = c;
  }

  load(
    a: number,
    b: number,
    pair: Uint8Array,
    maxSteps: number,
    headPolicy: number,
    noMatch: number,
  ): void {
    this.a = a;
    this.b = b;
    this.tapeLen = pair.length >> 1;
    this.initial = pair.slice();
    this.tape = pair.slice();
    this.flash = new Uint8Array(pair.length);
    this.shadow = pair.slice();
    this.vm.maxSteps = maxSteps;
    this.vm.headPolicy = headPolicy;
    this.vm.noMatch = noMatch;
    this.vm.load(this.tape);
    this.trace.length = 0;
    this.pacer.reset();
  }

  /** Empty the scope — what it holds is a copy of a soup that no longer exists. */
  clear(): void {
    this.a = -1;
    this.b = -1;
    this.tapeLen = 0;
    this.running = false;
    this.initial = new Uint8Array(0);
    this.tape = new Uint8Array(0);
    this.flash = new Uint8Array(0);
    this.shadow = new Uint8Array(0);
    this.vm.load(this.tape);
    this.trace.length = 0;
    this.pacer.reset();
  }

  rewind(): void {
    if (this.initial.length === 0) return;
    this.tape.set(this.initial);
    this.shadow.set(this.initial);
    this.flash.fill(0);
    this.vm.load(this.tape);
    this.trace.length = 0;
    this.pacer.reset();
  }

  get halted(): boolean {
    return this.vm.halt !== HALT_RUNNING;
  }

  /** Change playback rate without carrying fractional work from the old rate. */
  setSpeed(speed: number): void {
    this.speed = speed;
    this.pacer.reset();
  }

  /** Advance playback by the configured number of steps for one rendered frame. */
  advanceFrame(): void {
    const steps = this.pacer.take(this.speed);
    if (steps > 0) this.advance(steps);
  }

  /** Execute up to n evaluator steps, recording the operations that fired. */
  advance(n: number): void {
    if (this.tape.length === 0) return;
    for (let i = 0; i < n && !this.halted; i++) {
      this.vm.step();
      const b = this.vm.lastOp;
      if (b >= 0 && OP_CLASS[b] !== 0) {
        this.trace.push(GLYPH[b]);
        if (this.trace.length > 160) this.trace.splice(0, this.trace.length - 160);
      }
    }
    // Anything that changed this frame gets lit; without this the copy loop is
    // invisible — bytes just quietly become other bytes.
    const { tape, shadow, flash } = this;
    for (let i = 0; i < tape.length; i++) {
      if (shadow[i] !== tape[i]) {
        shadow[i] = tape[i];
        flash[i] = 255;
      }
    }
  }

  private decay(): void {
    const f = this.flash;
    for (let i = 0; i < f.length; i++) if (f[i]) f[i] = f[i] > 18 ? f[i] - 18 : 0;
  }

  resize(dpr: number): void {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(dpr: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DISPLAY_FACE_CSS;
    ctx.fillRect(0, 0, W, H);

    const cols = this.tapeLen;
    if (!cols || this.tape.length === 0) {
      ctx.fillStyle = 'rgba(255,176,0,0.35)';
      ctx.font = `${13 * dpr}px ${CANVAS_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyNote, W / 2, H / 2);
      return;
    }

    const padL = 82 * dpr;
    const padR = 4 * dpr;
    const padT = 3 * dpr;
    const padB = 2 * dpr;
    const gap = 5 * dpr;

    const rowH = (H - padT - padB - gap) / 2;
    const byteW = (W - padL - padR) / cols;

    // Four separate vertical lanes keep execution state and byte identity
    // readable without placing one encoding on top of another. At 128 bytes,
    // adjacent three-digit labels cannot fit on one baseline, so alternating
    // bytes use two label rows while remaining centred under their byte.
    const denseValues = cols > 64;
    const ipLane = Math.min(
      (denseValues ? 6 : 9) * dpr,
      rowH * (denseValues ? 0.15 : 0.18),
    );
    const valueLane = Math.min(
      (denseValues ? 18 : 12) * dpr,
      rowH * (denseValues ? 0.45 : 0.3),
    );
    const headLane = Math.min(
      (denseValues ? 6 : 9) * dpr,
      rowH * (denseValues ? 0.15 : 0.18),
    );
    const byteH = rowH - ipLane - valueLane - headLane;

    const nominalByteSide = Math.max(1, Math.min(byteW - dpr, byteH));
    const glyphPx = Math.max(7 * dpr, Math.min(12 * dpr, nominalByteSide * 0.72));
    const valuePx = denseValues
      ? Math.min(9 * dpr, valueLane / 2, Math.max(1, byteW * 2 - dpr) / 1.85)
      : Math.min(10 * dpr, valueLane * 0.84, Math.max(1, byteW - dpr) / 1.85);

    const { ip, h0, h1 } = this.vm;

    for (let row = 0; row < 2; row++) {
      const top = padT + row * (rowH + gap);
      const byteTop = top + ipLane;
      const valueTop = byteTop + byteH;

      // The slot controls horizontal position; the painted byte is a square
      // centred inside it. Snap all four edges to device pixels, then reuse
      // this geometry for glyphs, write flashes, and pointer outlines.
      const byteGeometry = (column: number) => {
        const slotLeft = padL + column * byteW;
        const slotRight = padL + (column + 1) * byteW;
        const side = Math.max(
          1,
          Math.floor(Math.min(slotRight - slotLeft - dpr, byteH)),
        );
        const left = Math.round((slotLeft + slotRight - side) / 2);
        const squareTop = Math.round(byteTop + (byteH - side) / 2);
        return { left, top: squareTop, side, cx: left + side / 2 };
      };

      // row label — the tape's own number in the soup, not an anonymous A/B
      const fs = Math.min(11 * dpr, rowH * 0.3);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = row === 0 ? 'rgba(255,176,0,0.9)' : 'rgba(255,240,204,0.9)';
      ctx.font = `${fs}px ${CANVAS_FONT_FAMILY}`;
      ctx.fillText(row === 0 ? 'A' : 'B', 2 * dpr, byteTop + byteH / 2);
      ctx.fillStyle = 'rgba(150,150,160,0.75)';
      ctx.font = `${fs * 0.95}px ${CANVAS_FONT_FAMILY}`;
      ctx.fillText(
        `tape ${row === 0 ? this.a : this.b}`,
        11 * dpr,
        byteTop + byteH / 2,
      );
      ctx.fillStyle = 'rgba(150,150,160,0.45)';
      ctx.font = `${fs * 0.85}px ${CANVAS_FONT_FAMILY}`;
      ctx.fillText(
        `${row === 0 ? 'positions 0' : `positions ${cols}`}–${row === 0 ? cols - 1 : cols * 2 - 1}`,
        2 * dpr,
        valueTop + valueLane / 2,
      );

      for (let c = 0; c < cols; c++) {
        const i = row * cols + c;
        const v = this.tape[i];
        const cls = OP_CLASS[v];
        const square = byteGeometry(c);

        const [r, g, bl] = cls === 0 ? valueRgb(v) : operatorRgb(v);
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(square.left, square.top, square.side, square.side);

        if (cls !== 0) {
          ctx.fillStyle = DISPLAY_FACE_CSS;
          ctx.font = `${glyphPx}px ${CANVAS_FONT_FAMILY}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(GLYPH[v], square.cx, square.top + square.side / 2 + dpr * 0.5);
        }

        const glow = this.flash[i];
        if (glow > 0) {
          ctx.fillStyle = `rgba(255,232,190,${(glow / 255) * 0.85})`;
          ctx.fillRect(square.left, square.top, square.side, square.side);
        }
      }

      // The exact byte values form a neutral lane below the operation view.
      // A second pass avoids resetting text state for every operation glyph.
      ctx.fillStyle = BYTE_LABEL_CSS;
      ctx.font = `${valuePx}px ${CANVAS_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let c = 0; c < cols; c++) {
        const i = row * cols + c;
        const valueY = denseValues
          ? valueTop + valueLane * (c % 2 === 0 ? 0.25 : 0.75)
          : valueTop + valueLane / 2;
        ctx.fillText(String(this.tape[i]), byteGeometry(c).cx, valueY);
      }

      // every 8th column gets a faint rule so positions are countable
      ctx.strokeStyle = 'rgba(255,176,0,0.09)';
      ctx.lineWidth = Math.max(1, dpr * 0.5);
      for (let c = 8; c < cols; c += 8) {
        const x = Math.round(padL + c * byteW) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, byteTop);
        ctx.lineTo(x, valueTop + valueLane);
        ctx.stroke();
      }

      // markers
      const mark = (pos: number, kind: 'ip' | 'h0' | 'h1') => {
        if (pos < row * cols || pos >= (row + 1) * cols) return;
        const c = pos - row * cols;
        const square = byteGeometry(c);
        const cx = square.cx;
        const w = Math.min(square.side * 0.42, 5 * dpr);
        if (kind === 'ip') {
          ctx.fillStyle = '#ffd88a';
          ctx.beginPath();
          ctx.moveTo(cx - w, top + 0.5 * dpr);
          ctx.lineTo(cx + w, top + 0.5 * dpr);
          ctx.lineTo(cx, top + ipLane - dpr);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,216,138,0.85)';
          ctx.lineWidth = Math.max(1, dpr);
          ctx.strokeRect(square.left, square.top, square.side, square.side);
        } else {
          const yBase = valueTop + valueLane + headLane - dpr;
          const color = kind === 'h0' ? '#ff7a1a' : '#fff0cc';
          ctx.beginPath();
          ctx.moveTo(cx - w, yBase);
          ctx.lineTo(cx + w, yBase);
          ctx.lineTo(cx, yBase - headLane + dpr);
          ctx.closePath();
          if (kind === 'h0') {
            ctx.fillStyle = color;
            ctx.fill();
          } else {
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1, dpr);
            ctx.stroke();
          }
        }
      };

      mark(h0, 'h0');
      mark(h1, 'h1');
      mark(ip, 'ip');
    }

    this.decay();
  }
}

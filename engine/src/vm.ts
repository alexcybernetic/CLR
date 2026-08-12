import { B_DEC, B_GET, B_H0L, B_H0R, B_H1L, B_H1R, B_INC, B_LB, B_PUT, B_RB } from './opcodes.ts';

/** Halt codes. 0 means "still running, budget exhausted". */
export const HALT_RUNNING = 0;
export const HALT_IP_OOB = 1; // instruction pointer walked off the tape
export const HALT_MAX_STEPS = 2; // hit the step cutoff (the halting-problem fence)
export const HALT_HEAD_OOB = 3; // a data head left the tape (only under HEAD_HALT)
export const HALT_NO_MATCH = 4; // bracket with no partner

export const HALT_LABEL = ['RUNNING', 'IP-OOB', 'MAX-STEPS', 'HEAD-OOB', 'NO-MATCH'];

/** the same halt codes, said out loud */
export const HALT_PLAIN = [
  'running',
  'ran off the tape',
  'looped until cutoff',
  'head off the tape',
  'bracket unmatched',
];

/** What happens when a data head steps off the end of the tape. */
export const HEAD_WRAP = 0;
export const HEAD_CLAMP = 1;
export const HEAD_HALT = 2;

export const HEAD_POLICY_LABEL = ['WRAP', 'CLAMP', 'HALT'];

/**
 * What a bracket with no partner does.
 *
 * The native evaluator terminates: the scan for the partner runs off the end
 * and the program stops. NOMATCH_SKIP is kept only so the alternative reading
 * can be re-tested; it is not native behavior.
 */
export const NOMATCH_SKIP = 0;
export const NOMATCH_HALT = 1;

export const NOMATCH_LABEL = ['SKIP', 'HALT'];

/**
 * The BFF machine.
 *
 * One tape is program *and* memory (von Neumann): the instruction pointer reads
 * bytes from the same array the two data heads write to, so execution rewrites
 * the program as it runs. There is no I/O — `.` and `,` move bytes between the
 * two heads instead of a display and a keyboard.
 *
 * `run(budget)` is the sampler's single implementation; `step()` is `run(1)`.
 * Build-time conformance checks keep its results aligned with the native
 * evaluator used by the population.
 */
export class VM {
  tape: Uint8Array = new Uint8Array(0);
  len = 0;
  ip = 0;
  h0 = 0;
  h1 = 0;
  steps = 0;
  /** how many `.`/`,` fired — the signal that this pair is doing something */
  copies = 0;
  halt: number = HALT_RUNNING;
  maxSteps = 8192;
  headPolicy: number = HEAD_WRAP;
  noMatch: number = NOMATCH_HALT;
  /** byte of the instruction executed most recently, -1 before the first step */
  lastOp = -1;

  load(tape: Uint8Array): void {
    this.tape = tape;
    this.len = tape.length;
    this.ip = 0;
    this.h0 = 0;
    this.h1 = 0;
    this.steps = 0;
    this.copies = 0;
    this.halt = HALT_RUNNING;
    this.lastOp = -1;
  }

  step(): number {
    return this.run(1);
  }

  /** Execute at most `budget` evaluator steps. Returns a halt code (0 = still live). */
  run(budget: number): number {
    if (this.halt !== HALT_RUNNING) return this.halt;

    const tape = this.tape;
    const len = this.len;
    const max = this.maxSteps;
    const pol = this.headPolicy;
    const nm = this.noMatch;

    let ip = this.ip;
    let h0 = this.h0;
    let h1 = this.h1;
    let steps = this.steps;
    let copies = this.copies;
    let last = this.lastOp;
    let halt = HALT_RUNNING;

    while (budget-- > 0) {
      if (steps >= max) {
        halt = HALT_MAX_STEPS;
        break;
      }
      if (ip < 0 || ip >= len) {
        halt = HALT_IP_OOB;
        break;
      }

      const b = tape[ip];
      steps++;
      last = b;

      switch (b) {
        case B_INC:
          tape[h0] = (tape[h0] + 1) & 255;
          break;
        case B_DEC:
          tape[h0] = (tape[h0] - 1) & 255;
          break;
        case B_H0L:
          h0--;
          break;
        case B_H0R:
          h0++;
          break;
        case B_H1L:
          h1--;
          break;
        case B_H1R:
          h1++;
          break;
        case B_PUT:
          tape[h1] = tape[h0];
          copies++;
          break;
        case B_GET:
          tape[h0] = tape[h1];
          copies++;
          break;
        case B_LB: {
          if (tape[h0] === 0) {
            let depth = 1;
            let j = ip + 1;
            while (j < len) {
              const c = tape[j];
              if (c === B_LB) depth++;
              else if (c === B_RB && --depth === 0) break;
              j++;
            }
            if (j >= len) {
              if (nm === NOMATCH_HALT) halt = HALT_NO_MATCH;
            } else ip = j;
          }
          break;
        }
        case B_RB: {
          if (tape[h0] !== 0) {
            let depth = 1;
            let j = ip - 1;
            while (j >= 0) {
              const c = tape[j];
              if (c === B_RB) depth++;
              else if (c === B_LB && --depth === 0) break;
              j--;
            }
            // land on the '[' — the ip++ below steps into the loop body. The
            // condition it would re-test is the one we just tested, inverted.
            if (j < 0) {
              if (nm === NOMATCH_HALT) halt = HALT_NO_MATCH;
            } else ip = j;
          }
          break;
        }
        default:
          break; // inert gene
      }

      if (halt !== HALT_RUNNING) break;

      if (h0 < 0 || h0 >= len || h1 < 0 || h1 >= len) {
        if (pol === HEAD_WRAP) {
          if (h0 < 0) h0 += len;
          else if (h0 >= len) h0 -= len;
          if (h1 < 0) h1 += len;
          else if (h1 >= len) h1 -= len;
        } else if (pol === HEAD_CLAMP) {
          h0 = h0 < 0 ? 0 : h0 >= len ? len - 1 : h0;
          h1 = h1 < 0 ? 0 : h1 >= len ? len - 1 : h1;
        } else {
          halt = HALT_HEAD_OOB;
          break;
        }
      }

      ip++;
      // soup.c resolves termination after the instruction it just executed:
      // leaving the program wins over reaching the cutoff on the same step.
      // Recording both here also keeps the step-wise sampler from needing one
      // extra call merely to discover that the previous instruction halted.
      if (ip < 0 || ip >= len) {
        halt = HALT_IP_OOB;
        break;
      }
      if (steps >= max) {
        halt = HALT_MAX_STEPS;
        break;
      }
    }

    this.ip = ip;
    this.h0 = h0;
    this.h1 = h1;
    this.steps = steps;
    this.copies = copies;
    this.lastOp = last;
    if (halt !== HALT_RUNNING) this.halt = halt;
    return halt;
  }

  /** Run to completion (halt code is never 0). */
  runToHalt(): number {
    return this.run(0x7fffffff);
  }
}

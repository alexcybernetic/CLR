import { MOTIF, type Metrics, type SoupConfig } from './soup.ts';
import { VM } from './vm.ts';

/** Match the BrainFuckLife driver's default number of naive-partner trials. */
const REP_TRIALS = 16;
/** Use several carriers so a motif is not judged by one surrounding program. */
const REP_CARRIERS = 4;
/** Bound carrier discovery independently of the soup size. */
const REP_SCAN = 4096;

const probe = new VM();

function occurs(hay: Uint8Array, from: number, to: number, needle: Uint8Array): boolean {
  const last = to - needle.length;
  for (let i = from; i <= last; i++) {
    let j = 0;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

/** Length of the longest contiguous byte sequence present in both inputs. */
export function longestCommonSubstring(a: Uint8Array, b: Uint8Array): number {
  const runs = new Uint16Array(b.length + 1);
  let longest = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j > 0; j--) {
      const run = a[i - 1] === b[j - 1] ? runs[j - 1] + 1 : 0;
      runs[j] = run;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

/** The copied-run score used by the BrainFuckLife self-replication probe. */
export function replicationScore(originalCarrier: Uint8Array, resultingPartner: Uint8Array): number {
  return longestCommonSubstring(originalCarrier, resultingPartner);
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

class ProbeRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
}

function seedForProbe(cfg: SoupConfig, epoch: number, motif: Uint8Array): number {
  let seed = mix32(cfg.seed ^ epoch ^ cfg.nTapes ^ Math.imul(cfg.tapeLen, 0x9e3779b1));
  for (const byte of motif) seed = mix32(seed ^ byte);
  return seed;
}

/**
 * Test the exact motif leaders against deterministic naive partners.
 *
 * Probe randomness is deliberately separate from the model's counter-derived
 * values, so telemetry cannot alter the soup. Deriving it from the run identity
 * and epoch makes a snapshot reproducible without consuming coordinator state.
 */
export function verifyReplication(metrics: Metrics, cfg: SoupConfig, soup: Uint8Array, epoch: number): void {
  const { nTapes, tapeLen } = cfg;
  if (tapeLen < MOTIF) return;

  const program = new Uint8Array(tapeLen * 2);
  const original = new Uint8Array(tapeLen);
  probe.maxSteps = cfg.maxSteps;
  probe.headPolicy = cfg.headPolicy;
  probe.noMatch = cfg.noMatch;

  for (const hit of metrics.motifs) {
    const rng = new ProbeRng(seedForProbe(cfg, epoch, hit.bytes));
    const start = nTapes > 1 ? rng.next() % nTapes : 0;
    const scan = Math.min(nTapes, REP_SCAN);
    const carriers: number[] = [];

    for (let n = 0; n < scan && carriers.length < REP_CARRIERS; n++) {
      const tape = (start + n) % nTapes;
      const base = tape * tapeLen;
      if (occurs(soup, base, base + tapeLen, hit.bytes)) carriers.push(base);
    }
    hit.carriers = carriers.length;
    if (!carriers.length) continue;

    const scores = new Array<number>(REP_TRIALS);
    for (let trial = 0; trial < REP_TRIALS; trial++) {
      const base = carriers[trial % carriers.length];
      original.set(soup.subarray(base, base + tapeLen));
      program.set(original, 0);
      for (let k = 0; k < tapeLen; k++) program[tapeLen + k] = rng.next() & 255;

      probe.load(program);
      probe.runToHalt();
      scores[trial] = replicationScore(original, program.subarray(tapeLen));
    }

    scores.sort((a, b) => a - b);
    const middle = scores.length >> 1;
    hit.copiedBytes = (scores[middle - 1] + scores[middle]) / 2;
  }
}

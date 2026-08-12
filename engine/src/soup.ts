import { HEAD_WRAP, NOMATCH_HALT } from './vm.ts';

export const REACTOR_ENGINES = ['cubff', 'brainfuck-life'] as const;
export type ReactorEngine = (typeof REACTOR_ENGINES)[number];

/** Runtime shapes exposed and supported by the CLR application. */
export const SUPPORTED_TAPE_COUNTS = [
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536,
  131072,
] as const;
export const SUPPORTED_TAPE_LENGTHS = [32, 64, 128] as const;
export const SUPPORTED_STEP_LIMITS = [2048, 4096, 8192, 16384, 32768] as const;

export function isReactorEngine(value: unknown): value is ReactorEngine {
  return typeof value === 'string' && REACTOR_ENGINES.includes(value as ReactorEngine);
}

export interface SoupConfig {
  engine: ReactorEngine;
  nTapes: number;
  tapeLen: number;
  maxSteps: number;
  /** per-byte probability of being replaced by a random byte, per epoch */
  mutationRate: number;
  headPolicy: number;
  noMatch: number;
  seed: number;
}

/**
 * Each native implementation has its own source-aligned baseline. Keeping the
 * profiles separate prevents an engine change from retaining model parameters
 * that were selected for the other implementation.
 */
export const ENGINE_DEFAULT_CONFIGS: Readonly<
  Record<ReactorEngine, Readonly<SoupConfig>>
> = Object.freeze({
  cubff: Object.freeze({
    engine: 'cubff',
    nTapes: 131072,
    tapeLen: 64,
    maxSteps: 8192, // 2**13
    mutationRate: 1 / 4096,
    headPolicy: HEAD_WRAP,
    noMatch: NOMATCH_HALT,
    seed: 0,
  }),
  'brainfuck-life': Object.freeze({
    engine: 'brainfuck-life',
    nTapes: 4096,
    tapeLen: 64,
    maxSteps: 8192, // 2**13
    mutationRate: 1 / 4096,
    headPolicy: HEAD_WRAP,
    noMatch: NOMATCH_HALT,
    seed: 4,
  }),
});

export function defaultConfigForEngine(engine: ReactorEngine): SoupConfig {
  return { ...ENGINE_DEFAULT_CONFIGS[engine] };
}

export const DEFAULT_ENGINE: ReactorEngine = 'brainfuck-life';
export const DEFAULT_CONFIG: SoupConfig = defaultConfigForEngine(DEFAULT_ENGINE);

export interface EpochStats {
  execs: number;
  steps: number;
  meanSteps: number;
  /** indexed by halt code */
  halts: number[];
  ms: number;
}

export interface Metrics {
  /** H0: Shannon entropy of the byte histogram, bits/byte. 8.0 for white noise. */
  entropy: number;
  /**
   * How many of the 256 numeric byte values occur anywhere in the soup.
   * This is not the paper's provenance-token measurement: those tokens identify
   * byte origins and are propagated by copy operations.
   */
  distinctBytes: number;
  /** number of byte-distinct tapes */
  uniqueTapes: number;
  /** how many tapes belong to the single largest set of identical tapes */
  largestLineage: number;
  /** exact sequence leaders in the deterministic motif sample, commonest first */
  motifs: MotifHit[];
  /** whole-soup motif-window count used to scale sampled shares */
  motifTotal: number;
  /** commonest exact whole-tape byte sequences, ranked by population count */
  tapeFrequencies: TapeFrequencyGroup[];
  /** FNV-1a checksum of the complete population in tape order */
  populationFingerprint: string;
}

/** One exact whole-tape group reported by the population-frequency view. */
export interface TapeFrequencyGroup {
  /** complete tape content; equality is decided from these bytes, not the hash */
  bytes: Uint8Array;
  count: number;
  /** FNV-1a content hash, retained only as a compact display identifier */
  contentHash: number;
}

/** Limit snapshot payload and rendering work while retaining the leading groups. */
export const TAPE_FREQUENCY_TOP = 64;

/**
 * One repeated sequence and how much of its carrier it copies.
 *
 * `count` estimates how often the exact sequence occurs across the soup from a
 * deterministic sample, which is evidence that copying happened somewhere —
 * not that this sequence is what did the copying.
 *
 * `copiedBytes` is the BrainFuckLife driver's median copied-run measure: a
 * tape carrying the sequence is run against naive noise, then the longest
 * contiguous part of the original carrier found anywhere in the resulting
 * partner is recorded. A binary "did the sequence appear" is the wrong
 * question — the replicators that emerge here copy partially and by degree.
 * `carriers` is how many distinct tapes were tested; 0 means none was found.
 */
export interface MotifHit {
  bytes: Uint8Array;
  count: number;
  carriers: number;
  /** median longest copied run found in a naive partner, of tapeLen */
  copiedBytes: number;
}

/** length of the repeated sequence the structure monitor looks for */
export const MOTIF = 8;

/** how many of the commonest sequences the monitor keeps */
export const MOTIF_TOP = 6;

/** how many tapes the motif scan samples, whatever the soup size */
const MOTIF_SAMPLE_TAPES = 4096;

/**
 * What the soup looks like, measured.
 *
 * Not part of running the model — the selected independent native population
 * core is the only thing that does that. These are read-only passes over the
 * bytes it produces, kept here because the scratch buffers are large and worth
 * reusing between epochs.
 */
export class SoupMetrics {
  private hist = new Uint32Array(256);
  /** Hashes locate possible tape matches; byte comparison decides identity. */
  private tapeHead = new Map<number, number>();
  private tapeCollisions = new Map<number, number[]>();
  private tapeRep = new Uint32Array(0);
  private tapeCounts = new Uint32Array(0);
  private tapeHashes = new Uint32Array(0);

  /**
   * At most 4096 * 121 motif windows are sampled. A 2^20 open-addressed table
   * therefore stays below 50% load while retaining the full 32-bit hash. Hash
   * buckets with more than one observation are subsequently split by exact
   * byte comparison before any count is reported.
   */
  private readonly motifMask = (1 << 20) - 1;
  private motifKeys = new Uint32Array(1 << 20);
  private motifCounts = new Uint32Array(1 << 20);
  private motifFirst = new Uint32Array(1 << 20);

  private ensureTapeScratch(nTapes: number): void {
    if (this.tapeRep.length >= nTapes) return;
    this.tapeRep = new Uint32Array(nTapes);
    this.tapeCounts = new Uint32Array(nTapes);
    this.tapeHashes = new Uint32Array(nTapes);
  }

  private sameBytes(D: Uint8Array, a: number, b: number, length: number): boolean {
    for (let i = 0; i < length; i++) if (D[a + i] !== D[b + i]) return false;
    return true;
  }

  private motifHash(D: Uint8Array, at: number): number {
    let h = 0x811c9dc5;
    for (let j = 0; j < MOTIF; j++) h = Math.imul(h ^ D[at + j], 0x01000193);
    return h >>> 0;
  }

  /** Find or create the table slot for a full 32-bit motif hash. */
  private motifSlot(hash: number): number {
    const counts = this.motifCounts;
    const keys = this.motifKeys;
    let slot = hash & this.motifMask;
    while (counts[slot] !== 0 && keys[slot] !== hash) slot = (slot + 1) & this.motifMask;
    return slot;
  }

  /**
   * One pass over the soup: byte histogram, per-tape hashes, and a search for
   * the most repeated short sequences.
   *
   * A replicator IS a repeated sequence, so counting the commonest ones finds
   * the replicating structure directly — and it starts moving as soon as
   * copying begins, long before whole tapes become identical.
   */
  compute(cfg: SoupConfig, D: Uint8Array): Metrics {
    const { nTapes, tapeLen } = cfg;
    this.ensureTapeScratch(nTapes);
    const hist = this.hist;
    const tapeHead = this.tapeHead;
    const tapeCollisions = this.tapeCollisions;
    const tapeRep = this.tapeRep;
    const tapeCounts = this.tapeCounts;
    const tapeHashes = this.tapeHashes;
    const mc = this.motifCounts;
    hist.fill(0);
    tapeHead.clear();
    tapeCollisions.clear();
    mc.fill(0);

    let p = 0;
    let populationHash = 0x811c9dc5;
    let largestLineage = 0;
    let uniqueTapes = 0;
    for (let t = 0; t < nTapes; t++) {
      const base = p;
      let hash = 0x811c9dc5;
      for (let k = 0; k < tapeLen; k++) {
        const v = D[p++];
        hist[v]++;
        hash = Math.imul(hash ^ v, 0x01000193);
        populationHash = Math.imul(populationHash ^ v, 0x01000193);
      }
      const h = hash >>> 0;
      const primary = tapeHead.get(h);
      let group = -1;

      if (primary !== undefined) {
        if (this.sameBytes(D, base, tapeRep[primary] * tapeLen, tapeLen)) {
          group = primary;
        } else {
          const alternatives = tapeCollisions.get(h);
          if (alternatives) {
            for (const candidate of alternatives) {
              if (this.sameBytes(D, base, tapeRep[candidate] * tapeLen, tapeLen)) {
                group = candidate;
                break;
              }
            }
          }
          if (group < 0) {
            group = uniqueTapes++;
            tapeRep[group] = t;
            tapeCounts[group] = 0;
            tapeHashes[group] = h;
            if (alternatives) alternatives.push(group);
            else tapeCollisions.set(h, [group]);
          }
        }
      } else {
        group = uniqueTapes++;
        tapeHead.set(h, group);
        tapeRep[group] = t;
        tapeCounts[group] = 0;
        tapeHashes[group] = h;
      }

      const count = ++tapeCounts[group];
      if (count > largestLineage) largestLineage = count;
    }

    // Keep only the leading exact groups instead of sorting every distinct
    // tape. Ties retain first population occurrence, so an unchanged snapshot
    // always produces the same ranking. The complete bytes are copied only for
    // the retained groups; the exact identity pass above remains authoritative.
    const leadingGroups: number[] = [];
    const precedes = (a: number, b: number) =>
      tapeCounts[a] > tapeCounts[b] ||
      (tapeCounts[a] === tapeCounts[b] && tapeRep[a] < tapeRep[b]);
    for (let group = 0; group < uniqueTapes; group++) {
      let at = leadingGroups.length;
      while (at > 0 && precedes(group, leadingGroups[at - 1])) at--;
      if (at >= TAPE_FREQUENCY_TOP) continue;
      leadingGroups.splice(at, 0, group);
      if (leadingGroups.length > TAPE_FREQUENCY_TOP) leadingGroups.pop();
    }
    const tapeFrequencies: TapeFrequencyGroup[] = leadingGroups.map((group) => {
      const base = tapeRep[group] * tapeLen;
      return {
        bytes: D.slice(base, base + tapeLen),
        count: tapeCounts[group],
        contentHash: tapeHashes[group],
      };
    });

    // Motif windows, never straddling a tape boundary.
    //
    // Scanning every window costs nTapes * (tapeLen-7) * 8 hashes, which is 60M
    // operations at 2^17 tapes and swamps the simulation itself. The dominant
    // motif in a large soup is the dominant motif in a sample of it, so stride
    // the tapes to keep the work roughly constant with soup size, then scale
    // the counts back up so they read as whole-soup estimates. Full hashes only
    // select candidate buckets; a second pass separates every bucket by bytes.
    const perTape = tapeLen - MOTIF + 1;
    const stride = Math.max(1, Math.ceil(nTapes / MOTIF_SAMPLE_TAPES));
    let sampledTapes = 0;
    let sampledWindows = 0;
    if (perTape > 0) {
      for (let t = 0; t < nTapes; t += stride) {
        sampledTapes++;
        const base = t * tapeLen;
        for (let k = 0; k < perTape; k++) {
          const at = base + k;
          const h = this.motifHash(D, at);
          const slot = this.motifSlot(h);
          if (mc[slot] === 0) {
            this.motifKeys[slot] = h;
            this.motifFirst[slot] = at;
          }
          mc[slot]++;
          sampledWindows++;
        }
      }
    }

    interface ExactMotif {
      at: number;
      count: number;
    }

    // Only a hash bucket observed more than once can contain a repeated exact
    // sequence. On random data there are only a few dozen such full-hash
    // collisions; in an ordered soup they are precisely the structures wanted.
    const exactBySlot = new Map<number, ExactMotif[]>();
    if (perTape > 0) {
      for (let t = 0; t < nTapes; t += stride) {
        const base = t * tapeLen;
        for (let k = 0; k < perTape; k++) {
          const at = base + k;
          const slot = this.motifSlot(this.motifHash(D, at));
          if (mc[slot] <= 1) continue;
          let groups = exactBySlot.get(slot);
          if (!groups) {
            groups = [];
            exactBySlot.set(slot, groups);
          }
          let exact = groups.find((candidate) => this.sameBytes(D, at, candidate.at, MOTIF));
          if (!exact) {
            exact = { at, count: 0 };
            groups.push(exact);
          }
          exact.count++;
        }
      }
    }

    // Keep only the six exact leaders. Single-observation hash buckets fill any
    // remaining rows, so a noise baseline truthfully reads one occurrence.
    const top: ExactMotif[] = [];
    const offer = (candidate: ExactMotif) => {
      let at = top.length;
      while (
        at > 0 &&
        (top[at - 1].count < candidate.count ||
          (top[at - 1].count === candidate.count && top[at - 1].at > candidate.at))
      ) {
        at--;
      }
      if (at >= MOTIF_TOP) return;
      top.splice(at, 0, candidate);
      if (top.length > MOTIF_TOP) top.pop();
    };

    for (const groups of exactBySlot.values()) for (const group of groups) offer(group);
    if (top.length < MOTIF_TOP || (top[MOTIF_TOP - 1]?.count ?? 0) <= 1) {
      for (let slot = 0; slot <= this.motifMask; slot++) {
        if (mc[slot] === 1) offer({ at: this.motifFirst[slot], count: 1 });
      }
    }

    const scale = sampledTapes ? nTapes / sampledTapes : 0;
    const motifs: MotifHit[] = top.map((candidate) => ({
      bytes: D.slice(candidate.at, candidate.at + MOTIF),
      count: Math.round(candidate.count * scale),
      carriers: 0,
      copiedBytes: 0,
    }));

    const n = nTapes * tapeLen;
    let entropy = 0;
    let distinctBytes = 0;
    for (let i = 0; i < 256; i++) {
      const c = hist[i];
      if (c) {
        distinctBytes++;
        const pr = c / n;
        entropy -= pr * Math.log2(pr);
      }
    }

    return {
      entropy,
      distinctBytes,
      uniqueTapes,
      largestLineage,
      motifs,
      motifTotal: Math.round(sampledWindows * scale),
      tapeFrequencies,
      populationFingerprint: (populationHash >>> 0).toString(16).padStart(8, '0'),
    };
  }
}

import {
  instantiate,
  layout,
  mutatePopulation,
  mutNumerator,
  type Core,
  type Layout,
} from './core.ts';
import type { PackedReply } from './packedCore.ts';
import { SoupMetrics, type EpochStats, type Metrics, type SoupConfig } from './soup.ts';
import type { SoupExecution } from './execution.ts';

type ShardReply = PackedReply;

export type WorkerFactory = () => Worker;

const createShardWorker: WorkerFactory = () =>
  new Worker(new URL('./shard.ts', import.meta.url), { type: 'module' });

const SHARD_START_TIMEOUT_MS = 5000;
const SHARD_JOB_TIMEOUT_MS = 30000;

/**
 * The soup spread across cores.
 *
 * Each engine owns its coordinator lifecycle. CuBFF derives shuffle and pair
 * mutation from explicit coordinates. Brainfuck-Life advances one persistent
 * coordinator RNG through initialization, shuffle, and post-evaluation
 * mutation; its shards perform evaluation only.
 */
export class ParallelSoup implements SoupExecution {
  readonly computePath = 'wasm' as const;
  readonly gpuAdapter = null;
  cfg: SoupConfig;
  data: Uint8Array;
  epoch = 0;
  shards: number;

  get workerCount(): number {
    return this.shards;
  }

  get coreDescription(): string {
    return `${this.cfg.engine} wasm \u00d7${this.shards}`;
  }

  /**
   * A coordinator Wasm instance owns the soup, permutation, and any stateful
   * engine RNG. Shard workers receive complete pairs and never own authoritative
   * lifecycle state, so partitioning cannot change an engine trajectory.
   */
  private core: Core;
  private perm: Uint32Array = new Uint32Array(0);
  private mem: Layout = { soup: 0, idx: 0, counts: 0 };
  private workers: Worker[] = [];
  private bufs: Uint8Array[] = [];
  private metrics = new SoupMetrics();
  private readonly workerFactory: WorkerFactory;

  /**
   * There is no fallback. If the core will not start, or the workers will not,
   * the console has nothing to run and says so — rather than quietly switching
   * to something slower that computes a different soup.
   */
  static async create(
    cfg: SoupConfig,
    shards: number,
    workerFactory: WorkerFactory = createShardWorker,
  ): Promise<ParallelSoup> {
    const s = new ParallelSoup(cfg, Math.max(1, shards), workerFactory);
    s.workers = await s.spawn(s.shards);
    return s;
  }

  private constructor(cfg: SoupConfig, shards: number, workerFactory: WorkerFactory) {
    this.cfg = { ...cfg };
    this.shards = shards;
    this.workerFactory = workerFactory;
    this.core = instantiate(cfg.engine);
    this.data = new Uint8Array(0);
    this.shape();
    this.randomize();
  }

  /** (re)size the coordinator and re-take views — memory.grow invalidates them */
  private shape(): void {
    const { nTapes, tapeLen } = this.cfg;
    this.core.configure(tapeLen);
    this.mem = layout(this.core, nTapes, tapeLen);
    const buf = this.core.memory.buffer;
    this.data = new Uint8Array(buf, this.mem.soup, nTapes * tapeLen);
    this.perm = new Uint32Array(buf, this.mem.idx, nTapes);
  }

  private waitForReady(worker: Worker, shard: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
      };
      const fail = (message: string) => {
        cleanup();
        reject(new Error(`shard ${shard + 1}: ${message}`));
      };
      const onAbort = () => fail('startup cancelled');
      const onMessage = (event: MessageEvent) => {
        if ((event.data as { ready?: unknown } | null)?.ready !== true) {
          fail('invalid startup response');
          return;
        }
        cleanup();
        resolve();
      };
      const onError = (event: ErrorEvent) => fail(event.message || 'startup failed');
      const onMessageError = () => fail('unreadable startup response');
      const timeout = setTimeout(() => fail('startup timeout'), SHARD_START_TIMEOUT_MS);

      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);
      if (signal.aborted) onAbort();
    });
  }

  /** Build a complete pool or terminate every partially started worker. */
  private async spawn(count: number, offset = 0): Promise<Worker[]> {
    const workers: Worker[] = [];
    const abort = new AbortController();
    try {
      for (let i = 0; i < count; i++) {
        workers.push(this.workerFactory());
      }
      await Promise.all(
        workers.map((worker, shard) =>
          this.waitForReady(worker, offset + shard, abort.signal).catch((error: unknown) => {
            abort.abort();
            throw error;
          }),
        ),
      );
      return workers;
    } catch (error) {
      abort.abort();
      for (const worker of workers) worker.terminate();
      throw error;
    }
  }

  randomize(): void {
    this.core.set_seed(BigInt(this.cfg.seed >>> 0));
    this.core.initialize(this.mem.soup, this.cfg.nTapes);
    this.epoch = 0;
  }

  async readPopulation(): Promise<Uint8Array> {
    return this.data;
  }

  reshape(cfg: SoupConfig): void {
    if (cfg.engine !== this.cfg.engine) {
      throw new Error('engine changes require a new coordinator and worker pool');
    }
    const changed = cfg.nTapes !== this.cfg.nTapes || cfg.tapeLen !== this.cfg.tapeLen;
    this.cfg = { ...cfg };
    if (changed) {
      this.bufs = [];
      this.shape();
      this.randomize();
    }
  }

  /**
   * Swap the worker pool, leaving the soup alone.
   *
   * The shards are stateless — they receive packed pairs, run them and hand
   * them back — and the soup lives in the coordinator, so replacing them mid-run
   * costs nothing but the respawn. Rebuilding the soup to change how many
   * workers run it would throw away the run for no reason.
   */
  async setShards(n: number): Promise<void> {
    const want = Math.max(1, n);
    if (want === this.shards) return;
    const next = await this.spawn(want);
    const previous = this.workers;
    this.workers = next;
    this.bufs = [];
    this.shards = want;
    for (const worker of previous) worker.terminate();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.bufs = [];
  }

  private runShard(
    worker: Worker,
    shard: number,
    buf: Uint8Array,
    count: number,
    tapeLen: number,
    maxSteps: number,
    pairOffset: number,
    nPrograms: number,
    seed: number,
    epoch: number,
    mutationNumerator: number,
    signal: AbortSignal,
  ): Promise<ShardReply> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
      };
      const fail = (message: string) => {
        cleanup();
        reject(new Error(`shard ${shard + 1}: ${message}`));
      };
      const onAbort = () => fail('epoch cancelled');
      const onError = (event: ErrorEvent) => fail(event.message || 'execution failed');
      const onMessageError = () => fail('unreadable execution response');
      const onMessage = (event: MessageEvent) => {
        const reply = event.data as Partial<ShardReply> | null;
        if (
          !(reply?.buf instanceof ArrayBuffer) ||
          typeof reply.steps !== 'number' ||
          !Number.isFinite(reply.steps) ||
          !Array.isArray(reply.halts) ||
          reply.halts.length < 3 ||
          reply.halts.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
          fail('invalid execution response');
          return;
        }
        cleanup();
        resolve({
          buf: reply.buf,
          steps: reply.steps,
          halts: [reply.halts[0], reply.halts[1], reply.halts[2]],
        });
      };
      const timeout = setTimeout(() => fail('execution timeout'), SHARD_JOB_TIMEOUT_MS);

      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        worker.postMessage(
          {
            engine: this.cfg.engine,
            buf: buf.buffer,
            nPairs: count,
            tapeLen,
            maxSteps,
            pairOffset,
            nPrograms,
            seed,
            epoch,
            mutationNumerator,
          },
          [buf.buffer],
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async runEpoch(): Promise<EpochStats> {
    const t0 = performance.now();
    const { nTapes, tapeLen, maxSteps, seed } = this.cfg;
    const perm = this.perm;
    const D = this.data;
    const pairBytes = tapeLen * 2;
    const totalPairs = nTapes >> 1;
    if (this.workers.length !== this.shards) {
      throw new Error(`worker pool has ${this.workers.length} of ${this.shards} shards`);
    }

    this.core.shuffle(this.mem.idx, nTapes, BigInt(this.epoch));
    const mutationNumerator =
      this.cfg.engine === 'cubff' ? mutNumerator(this.cfg.mutationRate) : 0;

    const per = Math.ceil(totalPairs / this.shards);
    const jobs: Promise<ShardReply>[] = [];
    const abort = new AbortController();

    for (let s = 0; s < this.shards; s++) {
      const first = s * per;
      const count = Math.max(0, Math.min(per, totalPairs - first));
      if (count === 0) {
        jobs.push(Promise.resolve({ buf: new ArrayBuffer(0), steps: 0, halts: [0, 0, 0] }));
        continue;
      }
      let buf = this.bufs[s];
      if (!buf || buf.length !== count * pairBytes) {
        buf = new Uint8Array(count * pairBytes);
        this.bufs[s] = buf;
      }
      // gather this shard's pairs, already glued
      for (let k = 0; k < count; k++) {
        const a = perm[(first + k) * 2] * tapeLen;
        const b = perm[(first + k) * 2 + 1] * tapeLen;
        const o = k * pairBytes;
        buf.set(D.subarray(a, a + tapeLen), o);
        buf.set(D.subarray(b, b + tapeLen), o + tapeLen);
      }

      const w = this.workers[s];
      if (!w) throw new Error(`shard ${s + 1}: worker is unavailable`);
      jobs.push(
        this.runShard(
          w,
          s,
          buf,
          count,
          tapeLen,
          maxSteps,
          first,
          nTapes,
          seed,
          this.epoch,
          mutationNumerator,
          abort.signal,
        ).catch((error: unknown) => {
          abort.abort();
          throw error;
        }),
      );
    }

    let results: ShardReply[];
    try {
      results = await Promise.all(jobs);
    } catch (error) {
      abort.abort();
      this.dispose();
      throw error;
    }

    // Scatter only after every shard succeeded, so an epoch is all-or-nothing.
    for (let s = 0; s < results.length; s++) {
      const first = s * per;
      const count = Math.max(0, Math.min(per, totalPairs - first));
      if (count === 0) continue;
      const back = new Uint8Array(results[s].buf);
      if (back.length !== count * pairBytes) {
        this.dispose();
        throw new Error(`shard ${s + 1}: returned ${back.length} bytes, expected ${count * pairBytes}`);
      }
      this.bufs[s] = back;
      for (let k = 0; k < count; k++) {
        const a = perm[(first + k) * 2] * tapeLen;
        const b = perm[(first + k) * 2 + 1] * tapeLen;
        const o = k * pairBytes;
        D.set(back.subarray(o, o + tapeLen), a);
        D.set(back.subarray(o + tapeLen, o + pairBytes), b);
      }
    }

    mutatePopulation(
      this.core,
      this.cfg.engine,
      this.mem.soup,
      nTapes,
      mutNumerator(this.cfg.mutationRate),
    );

    let steps = 0;
    const halts = [0, 0, 0, 0, 0];
    for (const r of results) {
      steps += r.steps;
      halts[1] += r.halts[0];
      halts[2] += r.halts[1];
      halts[4] += r.halts[2];
    }
    this.epoch++;

    const execs = totalPairs;
    return {
      execs,
      steps,
      meanSteps: execs ? steps / execs : 0,
      halts,
      ms: performance.now() - t0,
    };
  }

  computeMetrics(): Metrics {
    return this.metrics.compute(this.cfg, this.data);
  }
}

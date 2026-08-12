/*
 * WebGPU host shared by production CuBFF execution and the standalone
 * conformance/throughput benchmark.
 */
import {
  CLEAR_COUNTERS_WGSL,
  makeEvaluatorWGSL,
  makeResidentPairingWGSL,
  makeResidentPermutationWGSL,
  makeResidentReductionWGSL,
  SELFTEST_WGSL,
  type KernelVariant,
} from './shader.ts';

export interface GpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export interface GpuAdapterProbe {
  readonly adapter: GPUAdapter;
  readonly info: GpuInfo;
}

/**
 * Production execution requires a browser-selected hardware adapter. Raw
 * probes remain available to the diagnostic benchmark so fallback behavior
 * can be identified rather than reported as hardware GPU performance.
 */
export function isProductionWebGpuAdapter(info: GpuInfo): boolean {
  return info.isFallbackAdapter !== true;
}

export interface EpochResult {
  /** total executed non-noop operations, the paper's computation measure */
  ops: number;
  /** halt tallies: [pointer off tape, step limit, unmatched bracket] */
  halts: [number, number, number];
  /** host-side upload cost: uniform + pair buffer writes, ms */
  uploadMs: number;
  /** submit to mapped: GPU execution, staging copies, and scheduling, ms */
  gpuMs: number;
  /** mapped-buffer copy-out and state tally, ms */
  readMs: number;
}

const PARAMS_SLOT = 256; // uniform slot stride; Params itself is 32 bytes

export class GpuBench {
  readonly device: GPUDevice;
  readonly info: GpuInfo;
  private readonly residentPipelineCache = new Map<string, Promise<ResidentPipelines>>();

  private constructor(device: GPUDevice, info: GpuInfo) {
    this.device = device;
    this.info = info;
  }

  static async create(
    powerPreference: 'low-power' | 'high-performance' = 'high-performance',
  ): Promise<GpuBench | null> {
    const probe = await GpuBench.probe(powerPreference);
    return probe ? GpuBench.fromProbe(probe) : null;
  }

  static async probe(
    powerPreference: 'low-power' | 'high-performance' = 'high-performance',
  ): Promise<GpuAdapterProbe | null> {
    const gpu = (navigator as { gpu?: GPU }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference });
    if (!adapter) return null;
    const info = adapter.info;
    return {
      adapter,
      info: {
        vendor: info?.vendor ?? '',
        architecture: info?.architecture ?? '',
        device: info?.device ?? '',
        description: info?.description ?? '',
        isFallbackAdapter: info?.isFallbackAdapter ?? false,
      },
    };
  }

  static async fromProbe(probe: GpuAdapterProbe): Promise<GpuBench> {
    return new GpuBench(await probe.adapter.requestDevice(), { ...probe.info });
  }

  destroy(): void {
    this.residentPipelineCache.clear();
    this.device.destroy();
  }

  /** Verify emulated 64-bit SplitMix64 against BigInt on random counters. */
  async selfTest(count = 4096): Promise<{ ok: boolean; failures: number }> {
    const module = this.device.createShaderModule({ code: SELFTEST_WGSL });
    const pipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'selftest' },
    });
    const out = this.device.createBuffer({
      size: count * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const staging = this.device.createBuffer({
      size: count * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const seed = 0x0123456789abcdefn;
    const params = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      params,
      0,
      new Uint32Array([count, 0, Number(seed & 0xffffffffn), Number(seed >> 32n)]),
    );
    const bind = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: out } },
        { binding: 1, resource: { buffer: params } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(out, 0, staging, 0, count * 8);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const got = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    out.destroy();
    staging.destroy();
    params.destroy();

    let failures = 0;
    for (let i = 0; i < count; i++) {
      const expected = splitmix64BigInt(seed + BigInt(i));
      const lo = Number(expected & 0xffffffffn);
      const hi = Number(expected >> 32n);
      if (got[i * 2] !== lo || got[i * 2 + 1] !== hi) failures++;
    }
    return { ok: failures === 0, failures };
  }

  async createEpochRunner(
    nPairs: number,
    tapeLen: number,
    stepLimit: number,
    chunkSteps: number,
    variant: KernelVariant = 'private',
    wgSize = 64,
  ): Promise<EpochRunner> {
    const memWords = (tapeLen * 2) / 4;
    const module = this.device.createShaderModule({
      code: makeEvaluatorWGSL(variant, wgSize, memWords),
    });
    const pipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'epoch_chunk' },
    });
    return new EpochRunner(this.device, pipeline, nPairs, tapeLen, stepLimit, chunkSteps, wgSize);
  }

  async createResidentEpochRunner(
    nTapes: number,
    tapeLen: number,
    stepLimit: number,
    chunkSteps: number,
    variant: KernelVariant = 'storage',
    wgSize = 128,
  ): Promise<ResidentEpochRunner> {
    if (nTapes < 2 || nTapes > 131072 || nTapes % 2 !== 0) {
      throw new Error(`resident CuBFF requires an even tape count from 2 through 131072, got ${nTapes}`);
    }
    if (tapeLen < 4 || tapeLen % 4 !== 0) {
      throw new Error(`resident CuBFF requires a tape length divisible by 4, got ${tapeLen}`);
    }
    const cacheKey = `${tapeLen}:${stepLimit}:${chunkSteps}:${variant}:${wgSize}`;
    this.device.pushErrorScope('validation');
    this.device.pushErrorScope('out-of-memory');
    let pendingPipelines: Promise<ResidentPipelines> | undefined;
    let runner: ResidentEpochRunner | null = null;
    let creationFailure: unknown = null;
    try {
      pendingPipelines = this.residentPipelineCache.get(cacheKey);
      if (!pendingPipelines) {
        pendingPipelines = (async () => {
          const tapeWords = tapeLen / 4;
          const pairWords = tapeWords * 2;
          const permutationModule = this.device.createShaderModule({
            code: makeResidentPermutationWGSL(),
          });
          const pairingModule = this.device.createShaderModule({
            code: makeResidentPairingWGSL(tapeWords, wgSize),
          });
          const evaluatorModule = this.device.createShaderModule({
            code: makeEvaluatorWGSL(variant, wgSize, pairWords),
          });
          const clearModule = this.device.createShaderModule({ code: CLEAR_COUNTERS_WGSL });
          const reductionModule = this.device.createShaderModule({
            code: makeResidentReductionWGSL(wgSize),
          });
          const pipeline = (module: GPUShaderModule, entryPoint: string) =>
            this.device.createComputePipelineAsync({
              layout: 'auto',
              compute: { module, entryPoint },
            });
          const [
            initPermutation,
            shuffle,
            gather,
            evaluate,
            scatter,
            clearCounters,
            reduceCounters,
          ] = await Promise.all([
            pipeline(permutationModule, 'init_permutation'),
            pipeline(permutationModule, 'shuffle_epoch'),
            pipeline(pairingModule, 'gather_pairs'),
            pipeline(evaluatorModule, 'epoch_chunk'),
            pipeline(pairingModule, 'scatter_pairs'),
            pipeline(clearModule, 'clear_counters'),
            pipeline(reductionModule, 'reduce_counters'),
          ]);
          return {
            initPermutation,
            shuffle,
            gather,
            evaluate,
            scatter,
            clearCounters,
            reduceCounters,
          };
        })();
        this.residentPipelineCache.set(cacheKey, pendingPipelines);
      }
      const pipelines = await pendingPipelines;
      runner = new ResidentEpochRunner(
        this.device,
        pipelines,
        nTapes,
        tapeLen,
        stepLimit,
        chunkSteps,
        wgSize,
      );
    } catch (error) {
      creationFailure = error;
    }

    let scopedFailure: { readonly message: string } | null = null;
    try {
      scopedFailure = await this.device.popErrorScope();
    } catch (error) {
      creationFailure ??= error;
    }
    try {
      const validationFailure = await this.device.popErrorScope();
      scopedFailure ??= validationFailure;
    } catch (error) {
      creationFailure ??= error;
    }

    if (creationFailure || scopedFailure) {
      try {
        runner?.destroy();
      } catch {
        // Preserve the construction or scoped WebGPU error.
      }
      if (pendingPipelines && this.residentPipelineCache.get(cacheKey) === pendingPipelines) {
        this.residentPipelineCache.delete(cacheKey);
      }
      if (creationFailure) throw creationFailure;
      throw new Error(`WebGPU resource creation failed: ${scopedFailure?.message || 'unknown error'}`);
    }
    if (!runner) throw new Error('WebGPU runner creation completed without a runner');
    return runner;
  }
}

export class EpochRunner {
  private readonly pairBytes: number;
  private readonly chunks: number;
  private readonly pairs: GPUBuffer;
  private readonly state: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly pairsStaging: GPUBuffer;
  private readonly stateStaging: GPUBuffer;
  private readonly bindGroups: GPUBindGroup[];
  private readonly stateWords: number;

  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  readonly nPairs: number;
  readonly tapeLen: number;
  readonly stepLimit: number;
  readonly chunkSteps: number;
  readonly wgSize: number;

  constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    nPairs: number,
    tapeLen: number,
    stepLimit: number,
    chunkSteps: number,
    wgSize: number,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.nPairs = nPairs;
    this.tapeLen = tapeLen;
    this.stepLimit = stepLimit;
    this.chunkSteps = chunkSteps;
    this.wgSize = wgSize;
    this.pairBytes = tapeLen * 2;
    this.chunks = Math.ceil(stepLimit / chunkSteps);
    const pairsSize = nPairs * this.pairBytes;
    this.stateWords = 8;
    const stateSize = nPairs * this.stateWords * 4;

    this.pairs = device.createBuffer({
      size: pairsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.state = device.createBuffer({
      size: stateSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.uniforms = device.createBuffer({
      size: this.chunks * PARAMS_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pairsStaging = device.createBuffer({
      size: pairsSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.stateStaging = device.createBuffer({
      size: stateSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.bindGroups = [];
    for (let chunk = 0; chunk < this.chunks; chunk++) {
      this.bindGroups.push(
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.pairs } },
            { binding: 1, resource: { buffer: this.state } },
            {
              binding: 2,
              resource: { buffer: this.uniforms, offset: chunk * PARAMS_SLOT, size: 48 },
            },
          ],
        }),
      );
    }
  }

  /**
   * Execute one epoch on `packed` pairs in place. `mutNum` of 0 disables the
   * in-shader mutation. The shader derives CuBFF's counter stream from the
   * user seed, epoch and global pair index.
   */
  async runEpoch(
    packed: Uint8Array,
    mutNum: number,
    userSeed: bigint,
    epoch: bigint,
  ): Promise<EpochResult> {
    const { device } = this;
    const t0 = performance.now();
    for (let chunk = 0; chunk < this.chunks; chunk++) {
      device.queue.writeBuffer(
        this.uniforms,
        chunk * PARAMS_SLOT,
        new Uint32Array([
          this.nPairs,
          this.pairBytes,
          this.stepLimit,
          this.chunkSteps,
          mutNum,
          chunk,
          Number(userSeed & 0xffffffffn),
          Number((userSeed >> 32n) & 0xffffffffn),
          Number(epoch & 0xffffffffn),
          Number((epoch >> 32n) & 0xffffffffn),
          this.nPairs * 2,
          0,
        ]),
      );
    }
    device.queue.writeBuffer(this.pairs, 0, packed);
    const t1 = performance.now();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    const workgroups = Math.ceil(this.nPairs / this.wgSize);
    for (let chunk = 0; chunk < this.chunks; chunk++) {
      pass.setBindGroup(0, this.bindGroups[chunk]);
      pass.dispatchWorkgroups(workgroups);
    }
    pass.end();
    encoder.copyBufferToBuffer(this.pairs, 0, this.pairsStaging, 0, this.pairs.size);
    encoder.copyBufferToBuffer(this.state, 0, this.stateStaging, 0, this.state.size);
    device.queue.submit([encoder.finish()]);

    await Promise.all([
      this.pairsStaging.mapAsync(GPUMapMode.READ),
      this.stateStaging.mapAsync(GPUMapMode.READ),
    ]);
    const t2 = performance.now();
    packed.set(new Uint8Array(this.pairsStaging.getMappedRange()));
    const state = new Uint32Array(this.stateStaging.getMappedRange().slice(0));
    this.pairsStaging.unmap();
    this.stateStaging.unmap();

    let ops = 0;
    const halts: [number, number, number] = [0, 0, 0];
    for (let pair = 0; pair < this.nPairs; pair++) {
      const at = pair * this.stateWords;
      ops += state[at + 6];
      const halt = state[at + 4];
      if (halt === 1) halts[0]++;
      else if (halt === 2) halts[1]++;
      else halts[2]++;
    }
    const t3 = performance.now();
    return { ops, halts, uploadMs: t1 - t0, gpuMs: t2 - t1, readMs: t3 - t2 };
  }

  destroy(): void {
    this.pairs.destroy();
    this.state.destroy();
    this.uniforms.destroy();
    this.pairsStaging.destroy();
    this.stateStaging.destroy();
  }
}

interface ResidentPipelines {
  initPermutation: GPUComputePipeline;
  shuffle: GPUComputePipeline;
  gather: GPUComputePipeline;
  evaluate: GPUComputePipeline;
  scatter: GPUComputePipeline;
  clearCounters: GPUComputePipeline;
  reduceCounters: GPUComputePipeline;
}

export interface ResidentSnapshot {
  population: Uint8Array;
  ops: number;
  halts: [number, number, number];
}

export interface ResidentCounters {
  ops: number;
  halts: [number, number, number];
}

const RESIDENT_COUNTER_WORDS = 4;
const RESIDENT_COUNTER_BYTES = RESIDENT_COUNTER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
export const MAX_RESIDENT_EPOCH_BATCH = 32;

/** Decode consecutive per-epoch reductions copied into one staging buffer. */
export function decodeResidentCounterBatch(
  words: Uint32Array,
  count: number,
): ResidentCounters[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESIDENT_EPOCH_BATCH) {
    throw new Error(`invalid resident counter batch size ${count}`);
  }
  const required = count * RESIDENT_COUNTER_WORDS;
  if (words.length < required) {
    throw new Error(`resident counter batch has ${words.length} words, expected ${required}`);
  }
  const counters: ResidentCounters[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * RESIDENT_COUNTER_WORDS;
    counters.push({
      ops: words[offset],
      halts: [words[offset + 1], words[offset + 2], words[offset + 3]],
    });
  }
  return counters;
}

export interface ResidentPhaseProfile {
  /** Host-observed queue time; each phase is deliberately synchronized. */
  permutationTargetsMs: number;
  permutationSwapsMs: number;
  /** Sum of target generation and exact serial swap execution. */
  shuffleMs: number;
  gatherMs: number;
  mutationEvaluationMs: number;
  scatterMs: number;
  reductionMs: number;
}

/**
 * A complete CuBFF epoch runner. The authoritative population, permutation,
 * packed pairs, interpreter state and reductions remain in GPU buffers across
 * epochs. Only initial population upload and explicit snapshots cross the
 * CPU/GPU boundary.
 */
export class ResidentEpochRunner {
  private readonly device: GPUDevice;
  private readonly pipelines: ResidentPipelines;
  private readonly chunks: number;
  private readonly population: GPUBuffer;
  private readonly permutation: GPUBuffer;
  private readonly swapTargets: GPUBuffer;
  private readonly pairs: GPUBuffer;
  private readonly state: GPUBuffer;
  private readonly counters: GPUBuffer;
  private readonly residentParams: GPUBuffer;
  private readonly evaluatorParams: GPUBuffer;
  private readonly populationStaging: GPUBuffer;
  private readonly countersStaging: GPUBuffer;
  private readonly initPermutationBind: GPUBindGroup;
  private readonly shuffleBind: GPUBindGroup;
  private readonly gatherBind: GPUBindGroup;
  private readonly scatterBind: GPUBindGroup;
  private readonly clearCountersBind: GPUBindGroup;
  private readonly reduceCountersBind: GPUBindGroup;
  private readonly evaluatorBinds: GPUBindGroup[];

  readonly nTapes: number;
  readonly nPairs: number;
  readonly tapeLen: number;
  readonly stepLimit: number;
  readonly chunkSteps: number;
  readonly wgSize: number;

  constructor(
    device: GPUDevice,
    pipelines: ResidentPipelines,
    nTapes: number,
    tapeLen: number,
    stepLimit: number,
    chunkSteps: number,
    wgSize: number,
  ) {
    this.device = device;
    this.pipelines = pipelines;
    this.nTapes = nTapes;
    this.nPairs = nTapes >> 1;
    this.tapeLen = tapeLen;
    this.stepLimit = stepLimit;
    this.chunkSteps = chunkSteps;
    this.wgSize = wgSize;
    this.chunks = Math.ceil(stepLimit / chunkSteps);

    const populationSize = nTapes * tapeLen;
    const permutationSize = nTapes * 4;
    const stateSize = this.nPairs * 8 * 4;
    const allocatedBuffers: GPUBuffer[] = [];
    const allocateBuffer = (descriptor: { size: number; usage: number }): GPUBuffer => {
      const buffer = device.createBuffer(descriptor);
      allocatedBuffers.push(buffer);
      return buffer;
    };

    try {
      this.population = allocateBuffer({
        size: populationSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      this.permutation = allocateBuffer({
        size: permutationSize,
        usage: GPUBufferUsage.STORAGE,
      });
      this.swapTargets = allocateBuffer({
        size: permutationSize,
        usage: GPUBufferUsage.STORAGE,
      });
      this.pairs = allocateBuffer({
        size: populationSize,
        usage: GPUBufferUsage.STORAGE,
      });
      this.state = allocateBuffer({
        size: stateSize,
        usage: GPUBufferUsage.STORAGE,
      });
      this.counters = allocateBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.residentParams = allocateBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.evaluatorParams = allocateBuffer({
        size: this.chunks * PARAMS_SLOT,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.populationStaging = allocateBuffer({
        size: populationSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.countersStaging = allocateBuffer({
        size: MAX_RESIDENT_EPOCH_BATCH * RESIDENT_COUNTER_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const permutationEntries = [
        { binding: 0, resource: { buffer: this.permutation } },
        { binding: 1, resource: { buffer: this.residentParams } },
        { binding: 2, resource: { buffer: this.swapTargets } },
      ];
      this.initPermutationBind = device.createBindGroup({
        layout: pipelines.initPermutation.getBindGroupLayout(0),
        entries: permutationEntries,
      });
      this.shuffleBind = device.createBindGroup({
        layout: pipelines.shuffle.getBindGroupLayout(0),
        entries: permutationEntries,
      });
      const pairingEntries = [
        { binding: 0, resource: { buffer: this.population } },
        { binding: 1, resource: { buffer: this.permutation } },
        { binding: 2, resource: { buffer: this.pairs } },
        { binding: 3, resource: { buffer: this.residentParams } },
      ];
      this.gatherBind = device.createBindGroup({
        layout: pipelines.gather.getBindGroupLayout(0),
        entries: pairingEntries,
      });
      this.scatterBind = device.createBindGroup({
        layout: pipelines.scatter.getBindGroupLayout(0),
        entries: pairingEntries,
      });
      this.clearCountersBind = device.createBindGroup({
        layout: pipelines.clearCounters.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.counters } }],
      });
      this.reduceCountersBind = device.createBindGroup({
        layout: pipelines.reduceCounters.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.state } },
          { binding: 1, resource: { buffer: this.counters } },
          { binding: 2, resource: { buffer: this.residentParams } },
        ],
      });
      this.evaluatorBinds = [];
      for (let chunk = 0; chunk < this.chunks; chunk++) {
        this.evaluatorBinds.push(
          device.createBindGroup({
            layout: pipelines.evaluate.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: this.pairs } },
              { binding: 1, resource: { buffer: this.state } },
              {
                binding: 2,
                resource: { buffer: this.evaluatorParams, offset: chunk * PARAMS_SLOT, size: 48 },
              },
            ],
          }),
        );
      }
    } catch (error) {
      for (let index = allocatedBuffers.length - 1; index >= 0; index--) {
        try {
          allocatedBuffers[index].destroy();
        } catch {
          // Preserve the constructor failure; cleanup errors are secondary.
        }
      }
      throw error;
    }
  }

  uploadPopulation(population: Uint8Array): void {
    if (population.length !== this.population.size) {
      throw new Error(
        `resident population is ${population.length} bytes, expected ${this.population.size}`,
      );
    }
    this.device.queue.writeBuffer(this.population, 0, population);
  }

  private writeEpochParams(epoch: bigint, mutNum: number, userSeed: bigint): void {
    const tapeWords = this.tapeLen / 4;
    const epochLo = Number(epoch & 0xffffffffn);
    const epochHi = Number((epoch >> 32n) & 0xffffffffn);
    const seedLo = Number(userSeed & 0xffffffffn);
    const seedHi = Number((userSeed >> 32n) & 0xffffffffn);
    this.device.queue.writeBuffer(
      this.residentParams,
      0,
      new Uint32Array([
        this.nTapes,
        tapeWords,
        this.nPairs,
        0,
        epochLo,
        epochHi,
        seedLo,
        seedHi,
      ]),
    );
    for (let chunk = 0; chunk < this.chunks; chunk++) {
      this.device.queue.writeBuffer(
        this.evaluatorParams,
        chunk * PARAMS_SLOT,
        new Uint32Array([
          this.nPairs,
          this.tapeLen * 2,
          this.stepLimit,
          this.chunkSteps,
          mutNum,
          chunk,
          seedLo,
          seedHi,
          epochLo,
          epochHi,
          this.nTapes,
          0,
        ]),
      );
    }
  }

  /**
   * Queue one complete epoch without reading authoritative state back.
   * A non-null `counterOffset` adds the 16-byte reduction copy to the same
   * command submission. Consecutive epochs use distinct staging offsets and
   * are mapped together after the complete bounded batch has been queued.
   */
  submitEpoch(
    epoch: bigint,
    mutNum: number,
    userSeed: bigint,
    counterOffset: number | null = null,
  ): void {
    if (
      counterOffset !== null &&
      (!Number.isInteger(counterOffset) ||
        counterOffset < 0 ||
        counterOffset % RESIDENT_COUNTER_BYTES !== 0 ||
        counterOffset + RESIDENT_COUNTER_BYTES > this.countersStaging.size)
    ) {
      throw new Error(`invalid resident counter staging offset ${counterOffset}`);
    }
    this.writeEpochParams(epoch, mutNum, userSeed);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const pairWorkgroups = Math.ceil(this.nPairs / this.wgSize);

    pass.setPipeline(this.pipelines.initPermutation);
    pass.setBindGroup(0, this.initPermutationBind);
    pass.dispatchWorkgroups(Math.ceil(this.nTapes / 64));
    pass.setPipeline(this.pipelines.shuffle);
    pass.setBindGroup(0, this.shuffleBind);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.gather);
    pass.setBindGroup(0, this.gatherBind);
    pass.dispatchWorkgroups(pairWorkgroups);
    pass.setPipeline(this.pipelines.clearCounters);
    pass.setBindGroup(0, this.clearCountersBind);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.evaluate);
    for (let chunk = 0; chunk < this.chunks; chunk++) {
      pass.setBindGroup(0, this.evaluatorBinds[chunk]);
      pass.dispatchWorkgroups(pairWorkgroups);
    }
    pass.setPipeline(this.pipelines.scatter);
    pass.setBindGroup(0, this.scatterBind);
    pass.dispatchWorkgroups(pairWorkgroups);
    pass.setPipeline(this.pipelines.reduceCounters);
    pass.setBindGroup(0, this.reduceCountersBind);
    pass.dispatchWorkgroups(pairWorkgroups);
    pass.end();
    if (counterOffset !== null) {
      encoder.copyBufferToBuffer(
        this.counters,
        0,
        this.countersStaging,
        counterOffset,
        RESIDENT_COUNTER_BYTES,
      );
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /** Execute one epoch and return its reductions using one queue submission. */
  async runEpoch(
    epoch: bigint,
    mutNum: number,
    userSeed: bigint,
  ): Promise<ResidentCounters> {
    return (await this.runEpochBatch(epoch, 1, mutNum, userSeed))[0];
  }

  /**
   * Queue consecutive exact epochs, then synchronize once for every retained
   * per-epoch reduction. Queue writes and submissions remain ordered, so each
   * epoch observes its own seed/epoch uniforms and the preceding population.
   */
  async runEpochBatch(
    firstEpoch: bigint,
    count: number,
    mutNum: number,
    userSeed: bigint,
  ): Promise<ResidentCounters[]> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_RESIDENT_EPOCH_BATCH) {
      throw new Error(`invalid resident epoch batch size ${count}`);
    }
    for (let index = 0; index < count; index++) {
      this.submitEpoch(
        firstEpoch + BigInt(index),
        mutNum,
        userSeed,
        index * RESIDENT_COUNTER_BYTES,
      );
    }
    return this.readStagedCounters(count);
  }

  async finish(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Execute one epoch as synchronized phase submissions for diagnostics.
   * This preserves the model order and state but is intentionally excluded
   * from sustained-throughput measurements because each boundary waits for
   * the queue. The values include browser/queue synchronization overhead.
   */
  async profileEpoch(
    epoch: bigint,
    mutNum: number,
    userSeed: bigint,
  ): Promise<ResidentPhaseProfile> {
    this.writeEpochParams(epoch, mutNum, userSeed);
    const pairWorkgroups = Math.ceil(this.nPairs / this.wgSize);
    const measure = async (encode: (pass: GPUComputePassEncoder) => void): Promise<number> => {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      encode(pass);
      pass.end();
      const started = performance.now();
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      return performance.now() - started;
    };

    const permutationTargetsMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.initPermutation);
      pass.setBindGroup(0, this.initPermutationBind);
      pass.dispatchWorkgroups(Math.ceil(this.nTapes / 64));
    });
    const permutationSwapsMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.shuffle);
      pass.setBindGroup(0, this.shuffleBind);
      pass.dispatchWorkgroups(1);
    });
    const gatherMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.gather);
      pass.setBindGroup(0, this.gatherBind);
      pass.dispatchWorkgroups(pairWorkgroups);
    });
    const mutationEvaluationMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.evaluate);
      for (let chunk = 0; chunk < this.chunks; chunk++) {
        pass.setBindGroup(0, this.evaluatorBinds[chunk]);
        pass.dispatchWorkgroups(pairWorkgroups);
      }
    });
    const scatterMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.scatter);
      pass.setBindGroup(0, this.scatterBind);
      pass.dispatchWorkgroups(pairWorkgroups);
    });
    const reductionMs = await measure((pass) => {
      pass.setPipeline(this.pipelines.clearCounters);
      pass.setBindGroup(0, this.clearCountersBind);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.pipelines.reduceCounters);
      pass.setBindGroup(0, this.reduceCountersBind);
      pass.dispatchWorkgroups(pairWorkgroups);
    });
    return {
      permutationTargetsMs,
      permutationSwapsMs,
      shuffleMs: permutationTargetsMs + permutationSwapsMs,
      gatherMs,
      mutationEvaluationMs,
      scatterMs,
      reductionMs,
    };
  }

  async readSnapshot(): Promise<ResidentSnapshot> {
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      this.population,
      0,
      this.populationStaging,
      0,
      this.population.size,
    );
    encoder.copyBufferToBuffer(
      this.counters,
      0,
      this.countersStaging,
      0,
      RESIDENT_COUNTER_BYTES,
    );
    this.device.queue.submit([encoder.finish()]);
    await Promise.all([
      this.populationStaging.mapAsync(GPUMapMode.READ),
      this.countersStaging.mapAsync(GPUMapMode.READ),
    ]);
    const population = new Uint8Array(this.populationStaging.getMappedRange().slice(0));
    const counters = new Uint32Array(this.countersStaging.getMappedRange().slice(0));
    this.populationStaging.unmap();
    this.countersStaging.unmap();
    return {
      population,
      ops: counters[0],
      halts: [counters[1], counters[2], counters[3]],
    };
  }

  private async readStagedCounters(count: number): Promise<ResidentCounters[]> {
    await this.countersStaging.mapAsync(GPUMapMode.READ);
    const counters = new Uint32Array(this.countersStaging.getMappedRange().slice(0));
    this.countersStaging.unmap();
    return decodeResidentCounterBatch(counters, count);
  }

  destroy(): void {
    this.population.destroy();
    this.permutation.destroy();
    this.swapTargets.destroy();
    this.pairs.destroy();
    this.state.destroy();
    this.counters.destroy();
    this.residentParams.destroy();
    this.evaluatorParams.destroy();
    this.populationStaging.destroy();
    this.countersStaging.destroy();
  }
}

export function splitmix64BigInt(input: bigint): bigint {
  const mask = 0xffffffffffffffffn;
  let z = (input + 0x9e3779b97f4a7c15n) & mask;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
  return (z ^ (z >> 31n)) & mask;
}

/** model_seed as in the native cores: nested SplitMix64 over user seed and coordinate. */
export function modelSeedBigInt(userSeed: bigint, coordinate: bigint): bigint {
  return splitmix64BigInt(splitmix64BigInt(userSeed) ^ splitmix64BigInt(coordinate));
}

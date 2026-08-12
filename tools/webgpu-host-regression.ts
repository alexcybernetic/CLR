import { chooseEpochBatchSize } from '../engine/src/execution.ts';
import {
  decodeResidentCounterBatch,
  GpuBench,
  isProductionWebGpuAdapter,
  MAX_RESIDENT_EPOCH_BATCH,
} from '../engine/src/webgpu/gpu.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`WebGPU host regression: ${message}`);
}

const hardwareAdapter = {
  vendor: '',
  architecture: '',
  device: '',
  description: '',
  isFallbackAdapter: false,
};
assert(
  isProductionWebGpuAdapter(hardwareAdapter),
  'a non-fallback adapter was rejected for production execution',
);
assert(
  !isProductionWebGpuAdapter({ ...hardwareAdapter, isFallbackAdapter: true }),
  'a fallback adapter was accepted for production execution',
);

class FakeBuffer {
  readonly size: number;
  destroyed = false;

  constructor(size: number) {
    this.size = size;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakePipeline {
  getBindGroupLayout(): GPUBindGroupLayout {
    return {} as GPUBindGroupLayout;
  }
}

class FakeDevice {
  readonly queue = {} as GPUQueue;
  readonly lost = new Promise<GPUDeviceLostInfo>(() => undefined);
  onuncapturederror: ((event: GPUUncapturedErrorEvent) => void) | null = null;
  readonly buffers: FakeBuffer[] = [];
  readonly scopeEvents: string[] = [];
  pipelineCreations = 0;
  bufferCreations = 0;
  bindGroupCreations = 0;
  failBufferAt: number | null = null;
  failBindGroupAt: number | null = null;
  private readonly scopes: Array<'validation' | 'out-of-memory' | 'internal'> = [];
  private readonly scopedFailures = new Map<string, Array<{ message: string } | null>>();

  failNextScope(filter: 'validation' | 'out-of-memory', message: string): void {
    const failures = this.scopedFailures.get(filter) ?? [];
    failures.push({ message });
    this.scopedFailures.set(filter, failures);
  }

  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void {
    this.scopes.push(filter);
    this.scopeEvents.push(`push:${filter}`);
  }

  async popErrorScope(): Promise<{ readonly message: string } | null> {
    const filter = this.scopes.pop();
    if (!filter) throw new Error('unbalanced fake error scope');
    this.scopeEvents.push(`pop:${filter}`);
    return this.scopedFailures.get(filter)?.shift() ?? null;
  }

  createShaderModule(): GPUShaderModule {
    return {} as GPUShaderModule;
  }

  async createComputePipelineAsync(): Promise<GPUComputePipeline> {
    this.pipelineCreations++;
    return new FakePipeline() as GPUComputePipeline;
  }

  createBuffer(descriptor: { size: number }): GPUBuffer {
    this.bufferCreations++;
    if (this.bufferCreations === this.failBufferAt) {
      throw new Error('injected buffer allocation failure');
    }
    const buffer = new FakeBuffer(descriptor.size);
    this.buffers.push(buffer);
    return buffer as unknown as GPUBuffer;
  }

  createBindGroup(): GPUBindGroup {
    this.bindGroupCreations++;
    if (this.bindGroupCreations === this.failBindGroupAt) {
      throw new Error('injected bind-group failure');
    }
    return {} as GPUBindGroup;
  }
}

async function benchFor(device: FakeDevice): Promise<GpuBench> {
  return GpuBench.fromProbe({
    adapter: {
      requestDevice: async () => device as unknown as GPUDevice,
    } as GPUAdapter,
    info: {
      vendor: '',
      architecture: '',
      device: '',
      description: '',
      isFallbackAdapter: false,
    },
  });
}

async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

function assertScopeCycles(device: FakeDevice, cycles: number): void {
  const oneCycle = [
    'push:validation',
    'push:out-of-memory',
    'pop:out-of-memory',
    'pop:validation',
  ];
  assert(
    device.scopeEvents.join('|') === Array.from({ length: cycles }, () => oneCycle).flat().join('|'),
    `error scopes were not balanced in LIFO order: ${device.scopeEvents.join(', ')}`,
  );
}

function assertThrows(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`WebGPU host regression: ${message}`);
}

const gpuGlobals = globalThis as unknown as { GPUBufferUsage?: Record<string, number> };
const previousBufferUsage = gpuGlobals.GPUBufferUsage;
gpuGlobals.GPUBufferUsage = {
  STORAGE: 1,
  UNIFORM: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  MAP_READ: 16,
};

try {
  // Production starts with a small queue, then uses the preceding measured
  // epoch duration to fill a bounded response-time budget. Explicit one-epoch
  // requests and slow devices remain single-epoch operations.
  assert(
    chooseEpochBatchSize(MAX_RESIDENT_EPOCH_BATCH, MAX_RESIDENT_EPOCH_BATCH, 0) === 2,
    'initial epoch batch is not conservatively bounded',
  );
  assert(chooseEpochBatchSize(MAX_RESIDENT_EPOCH_BATCH, 1, 0) === 1, 'step-one was batched');
  assert(
    chooseEpochBatchSize(MAX_RESIDENT_EPOCH_BATCH, MAX_RESIDENT_EPOCH_BATCH, 5) ===
      MAX_RESIDENT_EPOCH_BATCH,
    'fast epochs did not fill the retained batch capacity',
  );
  assert(
    chooseEpochBatchSize(MAX_RESIDENT_EPOCH_BATCH, MAX_RESIDENT_EPOCH_BATCH, 100) === 2,
    'measured batch did not honor the response-time budget',
  );
  assert(
    chooseEpochBatchSize(MAX_RESIDENT_EPOCH_BATCH, MAX_RESIDENT_EPOCH_BATCH, 500) === 1,
    'slow epochs retained a multi-epoch queue',
  );

  const decoded = decodeResidentCounterBatch(
    new Uint32Array([11, 1, 2, 3, 22, 4, 5, 6]),
    2,
  );
  assert(
    decoded.length === 2 &&
      decoded[0].ops === 11 &&
      decoded[0].halts.join(',') === '1,2,3' &&
      decoded[1].ops === 22 &&
      decoded[1].halts.join(',') === '4,5,6',
    'batched reductions lost epoch order or counter values',
  );
  assertThrows(
    () => decodeResidentCounterBatch(new Uint32Array(4), 2),
    'truncated batched reductions were accepted',
  );

  // A deferred error-scope result arrives only after all resources have been
  // created. The host must destroy those resources, balance both scopes, and
  // discard the associated cached pipelines before a retry.
  const scopedDevice = new FakeDevice();
  const scopedBench = await benchFor(scopedDevice);
  scopedDevice.failNextScope('out-of-memory', 'injected scoped OOM');
  const scopedFailure = await rejection(() =>
    scopedBench.createResidentEpochRunner(8, 32, 64, 32),
  );
  assert(scopedFailure instanceof Error, 'scoped resource failure was accepted');
  const failedBuffers = scopedDevice.buffers.slice();
  assert(failedBuffers.length > 0, 'scoped failure happened before resource construction');
  assert(
    failedBuffers.every((buffer) => buffer.destroyed),
    'scoped failure leaked a constructed buffer',
  );
  const firstPipelineCount = scopedDevice.pipelineCreations;

  const recoveredRunner = await scopedBench.createResidentEpochRunner(8, 32, 64, 32);
  assert(
    scopedDevice.pipelineCreations > firstPipelineCount,
    'scoped failure left its pipeline set in the retained cache',
  );
  assertScopeCycles(scopedDevice, 2);
  const recoveredBuffers = scopedDevice.buffers.slice(failedBuffers.length);
  assert(
    recoveredBuffers.length > 0 && recoveredBuffers.every((buffer) => !buffer.destroyed),
    'successful retry returned already-destroyed resources',
  );
  recoveredRunner.destroy();
  assert(
    recoveredBuffers.every((buffer) => buffer.destroyed),
    'runner destruction did not release every successful allocation',
  );

  // Constructor allocation failure must clean only the buffers that were
  // successfully created before the throwing allocation.
  const allocationDevice = new FakeDevice();
  allocationDevice.failBufferAt = 4;
  const allocationBench = await benchFor(allocationDevice);
  const allocationFailure = await rejection(() =>
    allocationBench.createResidentEpochRunner(8, 32, 64, 32),
  );
  assert(allocationFailure instanceof Error, 'injected allocation failure was accepted');
  assert(allocationDevice.buffers.length === 3, 'allocation failed at an unexpected boundary');
  assert(
    allocationDevice.buffers.every((buffer) => buffer.destroyed),
    'allocation failure leaked a partial buffer set',
  );
  assertScopeCycles(allocationDevice, 1);

  // Bind groups are created after the complete buffer set. A bind-group error
  // must therefore clean all buffers even though construction progressed past
  // allocation.
  const bindDevice = new FakeDevice();
  bindDevice.failBindGroupAt = 1;
  const bindBench = await benchFor(bindDevice);
  const bindFailure = await rejection(() =>
    bindBench.createResidentEpochRunner(8, 32, 64, 32),
  );
  assert(bindFailure instanceof Error, 'injected bind-group failure was accepted');
  assert(bindDevice.buffers.length > 3, 'bind-group failure did not follow buffer allocation');
  assert(
    bindDevice.buffers.every((buffer) => buffer.destroyed),
    'bind-group failure leaked a constructed buffer',
  );
  assertScopeCycles(bindDevice, 1);
} finally {
  if (previousBufferUsage) gpuGlobals.GPUBufferUsage = previousBufferUsage;
  else delete gpuGlobals.GPUBufferUsage;
}

console.log(
  'WebGPU host regression: adapter eligibility, bounded batches, counter decoding, error scopes, cache invalidation, and cleanup passed',
);

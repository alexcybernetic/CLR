/*
 * Minimal ambient WebGPU declarations for CLR production and benchmark code.
 *
 * TypeScript's DOM lib does not ship WebGPU types and the project does not
 * depend on @webgpu/types; these declarations cover exactly the API surface
 * the benchmark uses, nothing more.
 */

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter?: boolean;
}

interface GPU {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null>;
}

interface GPUAdapter {
  readonly info?: GPUAdapterInfo;
  requestDevice(): Promise<GPUDevice>;
}

interface GPUShaderModule {
  readonly __brand: 'GPUShaderModule';
}

interface GPUBindGroupLayout {
  readonly __brand: 'GPUBindGroupLayout';
}

interface GPUBindGroup {
  readonly __brand: 'GPUBindGroup';
}

interface GPUCommandBuffer {
  readonly __brand: 'GPUCommandBuffer';
}

interface GPUComputePipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUBuffer {
  readonly size: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUQueue {
  writeBuffer(
    buffer: GPUBuffer,
    offset: number,
    data: ArrayBufferView<ArrayBufferLike> | ArrayBufferLike,
  ): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(x: number): void;
  end(): void;
}

interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): GPUCommandBuffer;
}

interface GPUDevice {
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  onuncapturederror: ((event: GPUUncapturedErrorEvent) => void) | null;
  destroy(): void;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<{ readonly message: string } | null>;
  createShaderModule(descriptor: { code: string }): GPUShaderModule;
  createComputePipelineAsync(descriptor: {
    layout: 'auto';
    compute: { module: GPUShaderModule; entryPoint: string };
  }): Promise<GPUComputePipeline>;
  createBuffer(descriptor: { size: number; usage: number }): GPUBuffer;
  createBindGroup(descriptor: {
    layout: GPUBindGroupLayout;
    entries: {
      binding: number;
      resource: { buffer: GPUBuffer; offset?: number; size?: number };
    }[];
  }): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
}

interface GPUDeviceLostInfo {
  readonly reason: string;
  readonly message: string;
}

interface GPUUncapturedErrorEvent {
  readonly error: { readonly message: string };
}

declare var GPUBufferUsage: {
  readonly STORAGE: number;
  readonly UNIFORM: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
};

declare var GPUMapMode: {
  readonly READ: number;
};

interface Navigator {
  readonly gpu?: GPU;
}

interface WorkerNavigator {
  readonly gpu?: GPU;
}

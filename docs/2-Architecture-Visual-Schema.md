# Architecture Visual Schema

```text
Browser main thread
  UI, immutable display snapshot, sampler, BatchRunner, run recorder
       |
       | serialized protocol: configuration, compute path, snapshots, counters
       v
Coordinator Worker
  run identity, command queue, scheduling, measurements, capability reporting
  production GPU eligibility: adapter present and not explicitly fallback
       |
       +-- CPU (Wasm) --------------------------------------------------+
       |   ParallelSoup: authoritative population, permutation, epoch   |
       |      |                                                         |
       |      +-- execution Worker 1 -> selected engine Wasm            |
       |      +-- execution Worker N -> selected engine Wasm            |
       |                                                                 |
       +-- GPU (WebGPU), CuBFF only ------------------------------------+
           WebGpuCuBffSoup: run buffers and epoch coordinator
              |-- CuBFF Wasm initializer -> one epoch-zero upload
              |-- WGSL complete epoch -> resident population
              |-- per-epoch 16-byte counters -> one map per bounded batch
              +-- immutable population readback -> scheduled consumers

Scheduled immutable population snapshot
       |
       +-- Soup and tape-count rendering
       +-- Reaction State metrics
       +-- Population Order and Brotli measurement
       +-- Sampler pair copies
       +-- batch checkpoint and local run record

Local persistence
  localStorage: view preferences and editable batch draft
  IndexedDB: schema-3 runs, measurements, events, experiments
```

The selected reactor engine and selected compute path are independent
identities. `cubff` supports `wasm` and `webgpu`; `brainfuck-life` supports
`wasm` only. CPU and GPU implementations meet at the asynchronous
`SoupExecution` boundary. They do not share authoritative mutable population
storage.

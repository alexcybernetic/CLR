# Development tools

The tools in this directory generate checked-in engine artifacts and verify
scientific and runtime behavior. Run them through the root `package.json`
commands.

## Wasm generation

`build-wasm.mjs` compiles the two independent native reactor cores and the
Brotli measurement encoder, then embeds their Wasm binaries in `engine/src/`.
It requires Zig on `PATH` and is invoked with:

```sh
npm run build:wasm
```

## Verification

The hardware-independent verification tools each protect a distinct boundary:

- `conformance.ts` compares the inspectable TypeScript VM with both native
  evaluators.
- `epoch-conformance.ts` checks native trajectories, sharding, transfers, and
  deterministic runtime changes.
- `engine-regression.ts` checks engine metrics, replication, worker selection,
  failure handling, and scientific readouts.
- `ui-regression.ts` checks canvas renderers, preferences, layout calculations,
  and batch presentation logic.
- `coordinator-regression.ts` checks serialized command ordering and failure
  closure.
- `records-regression.ts` checks recording, migrations, validation, and durable
  experiment behavior.
- `webgpu-host-regression.ts` checks host-side WebGPU lifecycle, batching, and
  counter decoding without requiring GPU hardware.

Run all hardware-independent checks with `npm test`. `npm run build` regenerates
Wasm and creates the production bundle. `npm run verify` regenerates Wasm, runs
the checks, and then creates the web bundle without regenerating Wasm a second
time.

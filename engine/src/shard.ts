/// <reference lib="webworker" />
/*
 * One core's worth of the epoch.
 *
 * The coordinator shuffles the soup, gathers the tapes belonging to this
 * shard's pairs into one packed buffer, and transfers it here. Every pair
 * touches only its own two tapes, so shards never interact — no shared memory,
 * no locks, and no cross-origin isolation requirement. The buffer comes back
 * transferred, so neither direction copies.
 *
 * `run_packed` is the inner loop of the selected C core's `run_epoch`. The
 * coordinator owns the global lifecycle. CuBFF shards apply deterministic
 * pair-local mutation; Brainfuck-Life shards evaluate only.
 */
import { PackedCore, type PackedJob } from './packedCore.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const packedCore = new PackedCore();

ctx.onmessage = (ev: MessageEvent<PackedJob>) => {
  const reply = packedCore.run(ev.data);
  ctx.postMessage(reply, [reply.buf]);
};

ctx.postMessage({ ready: true });

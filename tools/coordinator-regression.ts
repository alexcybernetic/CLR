import { SerialQueue } from '../engine/src/serialQueue.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`coordinator regression: ${message}`);
}

function assertEvents(actual: string[], expected: string[], message: string): void {
  assert(
    actual.length === expected.length && actual.every((event, index) => event === expected[index]),
    `${message}: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Reset, resize and worker-pool changes all arrive through enqueue() in the
// coordinator. None may touch the soup while an epoch is still in flight.
const orderingFatals: unknown[] = [];
const orderingQueue = new SerialQueue((error) => orderingFatals.push(error));
const epochStarted = deferred();
const finishEpoch = deferred();
const events: string[] = [];

const epoch = orderingQueue.run(async () => {
  events.push('epoch:start');
  epochStarted.resolve();
  await finishEpoch.promise;
  events.push('epoch:end');
});

await epochStarted.promise;
orderingQueue.enqueue(() => {
  events.push('reset');
});
orderingQueue.enqueue(() => {
  events.push('resize');
});
orderingQueue.enqueue(() => {
  events.push('thread-swap');
});
const drained = orderingQueue.run(() => undefined);

// Yield a microtask without using clocks: if any queued command could bypass
// the unresolved epoch, it would have run before this continuation.
await Promise.resolve();
assertEvents(events, ['epoch:start'], 'a command overlapped an in-flight epoch');

finishEpoch.resolve();
await Promise.all([epoch, drained]);
assertEvents(
  events,
  ['epoch:start', 'epoch:end', 'reset', 'resize', 'thread-swap'],
  'commands did not retain submission order',
);
assert(orderingFatals.length === 0, 'successful commands reported a fatal error');

// An asynchronous device event must enter the same queue as the epoch which
// currently owns GPU resources. Recovery then disposes the failed run before a
// replacement is allowed to initialize, without sealing the coordinator.
const recoveryFatals: unknown[] = [];
const recoveryQueue = new SerialQueue((error) => recoveryFatals.push(error));
const gpuEpochStarted = deferred();
const finishGpuEpoch = deferred();
const recoveryEvents: string[] = [];
const gpuEpoch = recoveryQueue.run(async () => {
  recoveryEvents.push('gpu-epoch:start');
  gpuEpochStarted.resolve();
  await finishGpuEpoch.promise;
  recoveryEvents.push('gpu-epoch:end');
});
await gpuEpochStarted.promise;
recoveryQueue.enqueue(() => {
  recoveryEvents.push('gpu-run:dispose');
});
recoveryQueue.enqueue(() => {
  recoveryEvents.push('cpu-run:create');
});
const recoveryDrained = recoveryQueue.run(() => undefined);
await Promise.resolve();
assertEvents(
  recoveryEvents,
  ['gpu-epoch:start'],
  'asynchronous GPU recovery overlapped an in-flight epoch',
);
finishGpuEpoch.resolve();
await Promise.all([gpuEpoch, recoveryDrained]);
assertEvents(
  recoveryEvents,
  ['gpu-epoch:start', 'gpu-epoch:end', 'gpu-run:dispose', 'cpu-run:create'],
  'GPU recovery and replacement did not retain resource-owner order',
);
assert(!recoveryQueue.sealed, 'recovering one GPU run sealed the coordinator');
assert(recoveryFatals.length === 0, 'recovering one GPU run reported a coordinator fatal');

// The first failed job reports its own error once. A command already waiting
// behind it, and one submitted after sealing, must both reject without running.
const failure = new Error('epoch failed');
const fatals: unknown[] = [];
const failureQueue = new SerialQueue((error) => fatals.push(error), 'coordinator sealed');
const failingEpochStarted = deferred();
const failEpoch = deferred();
let queuedJobStarted = false;
let lateJobStarted = false;

const failingEpochResult = failureQueue
  .run(async () => {
    failingEpochStarted.resolve();
    await failEpoch.promise;
    throw failure;
  })
  .then(
    () => null,
    (error: unknown) => error,
  );

await failingEpochStarted.promise;
const queuedResult = failureQueue
  .run(() => {
    queuedJobStarted = true;
  })
  .then(
    () => null,
    (error: unknown) => error,
  );

await Promise.resolve();
assert(!queuedJobStarted, 'a queued command started before the failing epoch settled');

failEpoch.resolve();
const originalError = await failingEpochResult;
const queuedError = await queuedResult;
assert(originalError === failure, 'the failing job did not reject with its original error');
assert(!queuedJobStarted, 'an already-queued command started after the queue failed');
assert(
  queuedError instanceof Error && queuedError.message === 'coordinator sealed',
  'an already-queued command did not reject with the sealed error',
);
assert(failureQueue.sealed, 'a failed queue did not remain sealed');
assert(fatals.length === 1 && fatals[0] === failure, 'the original failure was not reported once');

const lateError = await failureQueue
  .run(() => {
    lateJobStarted = true;
  })
  .then(
    () => null,
    (error: unknown) => error,
  );
assert(!lateJobStarted, 'a command submitted after failure was allowed to start');
assert(
  lateError instanceof Error && lateError.message === 'coordinator sealed',
  'a command submitted after failure did not reject with the sealed error',
);
assert(fatals.length === 1, 'a sealed queue reported the fatal error more than once');

console.log('coordinator regression: command serialization and fail-closed behavior passed');

# Architecture

This document describes the software implementation of CLR. Reactor behavior,
parameters, indicators, and measurement limitations are documented in the
application's **? help** window.

## Runtime structure

CLR is a static browser application built with TypeScript and Vite. Runtime work
is divided between the browser main thread and one coordinator worker. CPU/Wasm
execution additionally uses one or more execution workers. CuBFF WebGPU
execution runs inside the coordinator worker and does not use the CPU worker
pool.

```text
appweb/index.html
  └─ appweb/main.ts                         main-thread integration
       ├─ appweb/react/components/shell/     React application frame + stable hosts
       ├─ appweb/react/components/control-deck/ React setup/run controls
       ├─ appweb/react/components/header/    React Header + mount bridge
       ├─ appweb/react/components/order/     React Order panel + permanent canvas
       ├─ appweb/react/components/reaction-state/ React Reaction State panel + store
       ├─ appweb/react/components/runs/      React batch/records window + controller
       ├─ appweb/react/components/sampler/   React Sampler + canvas mount
       ├─ appweb/react/components/soup/      React Soup + canvas/legend mount
       ├─ appweb/react/components/start/     React preflight + mount bridge
       ├─ appweb/react/help/                 React Help + controller/mount bridge
       ├─ appweb/runtime/coordinatorClient.ts
       │    └─ coordinatorTransport.ts      coordinator Worker lifetime
       ├─ appweb/runtime/runProtocol.ts     run/revision validation
       ├─ appweb/runtime/displayCoordinator.ts
       │    └─ displayFrameLoop.ts          animation-frame lifetime
       ├─ appweb/runtime/batchRunner.ts      durable sequential execution
       ├─ appweb/records/batch.ts            batch domain rules
       ├─ appweb/records/batchDraft.ts       versioned draft codec
       └─ engine/src/worker.ts              coordinator worker
            └─ engine/src/execution.ts      asynchronous execution boundary
                 ├─ engine/src/parallelSoup.ts
                 │    ├─ selected engine coordinator Wasm instance
                 │    └─ engine/src/shard.ts × N
                 │         └─ PackedCore + same selected engine Wasm instance
                 └─ engine/src/webgpu/webGpuCuBffSoup.ts
                      ├─ CuBFF Wasm epoch-zero initializer
                      └─ engine/src/webgpu/gpu.ts + shader.ts
                           └─ GPU-resident CuBFF population and WGSL epoch
```

The application does not use `SharedArrayBuffer`. Pair buffers are transferred
to workers and returned through structured cloning, so cross-origin isolation
is not required.

## Main thread

[`appweb/main.ts`](../appweb/main.ts) remains the production main-thread
integration point. It owns runtime configuration, UI action adapters,
preferences, recording order, and accepted-message sequencing. React owns the
complete DOM presentation; runtime configuration and external stores, not form
elements, are authoritative state.
Framework-independent runtime objects own coordinator transport, request
correlation, protocol validation, raw display state, and animation scheduling.
The main thread does not execute reactor epochs.

The static document contains only the application and preflight mount roots.
Module evaluation synchronously commits the complete React application frame as
`inert`, mounts its feature roots, and places the Start window above it. It does
not open the local record repository, create the coordinator worker, initialize
Wasm, or enter the render loop. The start action releases those operations once,
synchronously removes `inert` before transferring focus, and unmounts the
preflight. The gate has no persisted bypass state, so every full document load
follows the same boundary.

[`CoordinatorTransport`](../appweb/runtime/coordinatorTransport.ts) lazily
creates and binds the coordinator Worker after the start action. It owns Worker
listener cleanup, termination, and classification of construction, send,
worker, message-decoding, and message-handler failures.
[`CoordinatorClient`](../appweb/runtime/coordinatorClient.ts) adds typed
correlation for snapshots, epoch completion, run creation, and exact
measurements. Correlated replies are settled explicitly only after the
main-thread handler has validated, recorded, and displayed the message. A
recoverable run failure rejects requests belonging to that run while leaving
the transport available; terminal failure or disposal rejects every pending
request and makes the transport inert.

[`BatchRunner`](../appweb/runtime/batchRunner.ts) owns sequential experiment
execution independently of the DOM and presentation framework. It sequences
durable queue acceptance, run UUIDs, explicit measurement mode, exact epoch
blocks, checkpoints, recorder flushes, experiment status, cooperative pause
gates, cooperative stop boundaries, and final cleanup. A narrow browser host applies an accepted definition
to the active controls and restores the saved manual setup; it does not own the
experiment loop. Worker correlations remain in `CoordinatorClient` and are
settled by the validated main-thread message handler, never by UI callbacks.

[`DisplayCoordinator`](../appweb/runtime/displayCoordinator.ts) owns the latest
accepted population buffer, tape-frequency data, order-plot history, sampler VM
and copied pair, the four imperative canvas adapters, and display interaction
state. Its canvases are attached once for the application lifetime; construction
and attachment schedule no work. The embedded
[`DisplayFrameLoop`](../appweb/runtime/displayFrameLoop.ts) begins only after the
start action, font settlement, and layout preparation. It retains at most one
pending animation frame, supports cooperative stopping, reports rendering or
scheduling failures through the terminal diagnostic path, and cancels its
pending frame during disposal or hot-module replacement.

The display publishes only a frozen, binary-free presentation snapshot of Soup
mode and sampler scalar/string readouts. Complete population data, frequency
tape bytes, renderer objects, plot history, and the sampler VM remain private.
Idle frames do not rebuild or publish that snapshot.

The document links the complete stylesheet directly from its head. CSS is
therefore render-blocking, and a temporary dark boot cover remains until the
application and preflight roots have committed. Styling is not deferred behind
the main TypeScript module graph and the inert console cannot flash first.

The Vite configuration serves the canonical root `LICENSE` and
`THIRD_PARTY_NOTICES.md` files during development and emits them under stable
names in the production bundle. The start window therefore links to local
deployment assets without maintaining duplicate legal text.

The standalone CLR mark is maintained as the vector public asset
[`clr-logo.svg`](../appweb/public/clr-logo.svg). The document declares it using
a deployment-relative favicon URL so development and relocatable production
deployments do not fall back to the website-root favicon. The lossless
[`preview.png`](../appweb/public/preview.png) is the README screenshot; the
smaller [`preview.jpg`](../appweb/public/preview.jpg) is the absolute public
Open Graph and X card image for CLR's canonical deployment.

The main UI components are:

- The React
  [`ApplicationFrame`](../appweb/react/components/shell/ApplicationFrame.tsx)
  for the inert application boundary, console-fitting hosts, terminal diagnostic
  row, and stable feature-root containers. Shell-state updates do not reconcile
  nested feature roots or replace their canvas elements.
- The React
  [`ControlDeck`](../appweb/react/components/control-deck/ControlDeck.tsx) for
  engine, compute path, worker pool, model configuration, execution controls,
  and machine status. Runtime configuration is its source; form elements are
  never read back as application state.
- The React
  [`ApplicationHeader`](../appweb/react/components/header/ApplicationHeader.tsx)
  for global identity, attribution, community links, and the main Help trigger.
- The React [`Soup`](../appweb/react/components/soup/Soup.tsx) for Soup controls,
  pointer interaction, view note, legends, and the permanent canvas host.
  [`SoupMatrix`](../appweb/ui/soupMatrix.ts) retains imperative rendering and
  position-preserving operator/raw-byte viewport ownership.
- [`TapeFrequencyView`](../appweb/ui/tapeFrequencyView.ts) for the ranked exact
  whole-tape frequency view.
- The React [`Order`](../appweb/react/components/order/Order.tsx) panel for the
  current accepted population-order scalars, Help control, and permanent canvas
  host. [`OrderPlot`](../appweb/ui/orderPlot.ts) retains rendering and history
  ownership.
- The React
  [`ReactionState`](../appweb/react/components/reaction-state/ReactionState.tsx)
  for population counts, copied motif summaries, and termination shares. Its
  external store copies runtime motif bytes into frozen plain arrays before
  publication.
- The React [`Sampler`](../appweb/react/components/sampler/Sampler.tsx) for the
  independent pair controls and scalar readouts. Its permanent canvas is
  rendered by [`Reactor`](../appweb/ui/reactor.ts), whose VM and copied tape
  pair remain private to `DisplayCoordinator`.
- The React [`HelpWindow`](../appweb/react/help/HelpWindow.tsx), backed by a
  framework-independent
  [`HelpWindowController`](../appweb/react/help/helpController.ts), for
  in-application reactor documentation.
- The React [`StartWindow`](../appweb/react/components/start/StartWindow.tsx)
  for the required license preflight and keyboard focus boundary. It delegates
  the single accepted action to runtime startup and then unmounts.
- The React [`RunsWindow`](../appweb/react/components/runs/RunsWindow.tsx) for
  explicit sequential batch queues, local records, and export. Its
  framework-independent
  [`RunsController`](../appweb/react/components/runs/runsController.ts) owns the
  versioned draft, editor state, live progress projection, and records-query
  lifecycle; `BatchRunner` remains the execution owner.
- [`prefs.ts`](../appweb/ui/prefs.ts) for local view and window preferences.

The complete UI is React-owned under [`appweb/react`](../appweb/react). The
static document supplies only `#appRoot` and `#startRoot`; it contains no second
copy of controls, panels, windows, legal copy, or Help content. Feature roots
are mounted synchronously into stable hosts created by `ApplicationFrame`.
The Header renders package-versioned
branding, attribution, secured external links, community controls, and a Help
trigger derived directly from Help state. The React version also corrects the
former YouTube icon's erroneous Discord accessible label and title.

Help's typed topic content is rendered directly, and a small external-store
controller preserves its open, topic, geometry, preference, and module-button
contracts used by main-thread integration. A separate small
external store publishes only the five accepted order scalars; complete
measurement population data remains in the recorder/runtime path, while plot
history remains inside `OrderPlot`. Reaction State has its own small store for
accepted configuration dimensions, population counts, copied motif summaries,
and termination counts. It retains no protocol message, typed array, or
complete population data. The Sampler subscribes directly to the
binary-free display snapshot and delegates commands back to
`DisplayCoordinator`; its canvas element is mounted synchronously and attached
to the imperative renderer exactly once. Soup uses the same boundary: React
owns the controls, gestures, note, legends, and stable canvas element, while
`DisplayCoordinator` privately owns matrix and ranked-frequency rendering.
Order and Sampler follow the same permanent-canvas rule: shell and external-store
updates preserve the exact attached DOM nodes for the renderer lifetime.

Reusable React primitives preserve the current CSS and accessibility contracts.
Typed control-option definitions drive both the production control deck and the
batch editor. The Start window owns its inert-boundary focus trap and delegates
the accepted startup action to the runtime. The shared floating-window primitive
owns reusable focus, drag, resize, and geometry behavior for Help and Runs
without starting runtime work. Its explicit resize handle uses pointer capture,
temporarily suppresses document text selection during active drag/resize
gestures, and restores normal selection immediately afterward. Pointer activity
anywhere in either window promotes that window above the other open auxiliary
window.

Focused framework-independent controllers and external stores publish immutable
UI snapshots through `useSyncExternalStore`. Run identifiers, configuration
revisions, worker messages, record transactions, canvas objects, and complete
population buffers remain implementation-private. Presentation snapshots
contain only small declarative values; their compile-time snapshot type rejects
binary and callable state. Reaction State additionally copies motif bytes from
runtime typed arrays into frozen plain arrays before publication. Accepted raw
population data flows from the protocol handler directly into
`DisplayCoordinator`, never through React.
Records browsing and export use the separate `RunsController` rather than
expanding the simulation snapshot. No worker message, record transaction,
canvas object, or complete population buffer enters React presentation state.

[`consoleFit.ts`](../appweb/ui/consoleFit.ts) calculates a uniform viewport fit for
the complete console. The console remains at 100% when its logical minimum fits,
scales down to a floor of 88% for moderately smaller viewports, and uses normal
page scrolling below that floor. A separate sizing stage reports the transformed
dimensions to the scroll container, avoiding overflow from the untransformed
layout box. Canvas pointer coordinates are resolved from each canvas bitmap and
its transformed bounding rectangle, so Soup zooming, panning, and picking remain
accurate at every fitted scale. The Soup screen consumes wheel input through a
native non-passive listener; zooming and ranked-frequency navigation therefore
cannot propagate a scroll gesture into the fitted page viewport.

Snapshots received from the coordinator contain a run identifier, copied soup
buffer, metrics, per-epoch and cumulative execution statistics, epoch number,
throughput, compute path, nullable WebGPU adapter identity, worker count, and
the complete configuration applied by the coordinator. Configuration-changing
commands use monotonic revisions. Snapshots and asynchronous measurements echo
both the run identifier and the revision of the population they describe.

Pure validators in
[`runProtocol.ts`](../appweb/runtime/runProtocol.ts) classify each snapshot or
measurement as accepted, ignored, or terminal. Messages for replaced runs and
older revisions are ignored. A future revision is terminal. Accepted snapshots
must also report consistent shape metadata, the expected compute path, and the
complete requested configuration. Waiters are settled only after an accepted
message has completed recording and display processing.

`SoupMatrix` and `TapeFrequencyView` share the Soup canvas but retain separate
view state. Switching to the ranked view therefore does not modify the matrix
zoom or pan. The ranked view scrolls through rows and never interprets its
coordinates as population tape positions.

The sampler is separate from the reactor state. It executes copied tape pairs
through the TypeScript VM so individual instructions can be displayed without
modifying the current population. Switching it off retains the loaded pair but
uses native disabled controls to prevent pointer or keyboard commands until it
is enabled again; the switch and Help trigger remain available.

While continuous execution is active, the main thread disables controls that
replace the population, change the engine, compute path or step limit, or change
the CPU worker pool. Mutation rate and execution rate remain live. Mutation is
a model parameter and is recorded at the coordinator epoch where its revision
applies. Execution rate changes throughput only. An engine or compute-path
change while halted creates a new run identity and a fresh epoch-0 population.
The prospective implementation is prepared before the coordinator releases the
old one, so a rejected WebGPU initialization retains the current halted run. A
CPU worker-selection command is serialized after the active epoch; pool
replacement completes before execution resumes.

Compute path is an explicit per-run choice and not a persisted presentation
preference. CPU/Wasm is selected on a fresh application load and after applying
an engine default profile. WebGPU is enabled only when the selected engine is
CuBFF and the coordinator has successfully requested an adapter. With WebGPU
selected, the workers control displays `not used`; its previous CPU selection
is retained.

Engine defaults are defined centrally in
[`engine/src/soup.ts`](../engine/src/soup.ts). CuBFF's profile is 131072 × 64, 8192
steps, mutation probability 1/4096, and seed 0. Brainfuck-Life's profile is
4096 × 64, 8192 steps, mutation probability 1/4096, and seed 4. A fresh session
starts with Brainfuck-Life. Selecting an engine applies the complete target
profile before replacing the run; Defaults reapplies the currently selected
engine's profile. The batch editor uses the same profile lookup when its engine
selection changes.

## Coordinator worker

[`engine/src/worker.ts`](../engine/src/worker.ts) owns the active
[`SoupExecution`](../engine/src/execution.ts) implementation, run state, rate
limiting, measurement scheduling, and the public worker protocol. The active
implementation is either [`ParallelSoup`](../engine/src/parallelSoup.ts) for
CPU/Wasm or
[`WebGpuCuBffSoup`](../engine/src/webgpu/webGpuCuBffSoup.ts) for CuBFF WebGPU.
This common asynchronous boundary exposes epoch execution, optional bounded
multi-epoch execution, allowed configuration changes, immutable population
readback, metrics, reset, disposal, and structured execution identity.

At startup the coordinator reports WebGPU capability independently of the
active execution path. Capability requires an adapter returned by
`requestAdapter({ powerPreference: "high-performance" })` in the Worker; the
presence of `navigator.gpu` alone is insufficient. An adapter with
`isFallbackAdapter === true` is classified as unavailable for production and
cannot create a GPU run. The browser still selects the physical adapter.
Descriptive adapter fields may be empty and are never parsed for path
selection.

The exact whole-tape identity pass builds hash buckets and resolves every
candidate match by byte comparison. It also ranks the 64 most frequent exact
groups and copies only those complete tape sequences into the snapshot metrics.
The displayed 32-bit hash is therefore a compact content label, not the basis
of equality and not a lineage identifier. This reuses the existing identity
pass and does not add a second complete-population scan.

All state-changing commands and epoch jobs pass through
[`SerialQueue`](../engine/src/serialQueue.ts). Jobs start in submission order. A
rejected job permanently seals the queue, disposes the active reactor, and
reports one terminal failure to the main thread. Commands already queued behind
the failure and commands received afterwards do not execute.

The coordinator accepts these command groups:

- initialization and worker-count changes;
- model configuration, compute-path selection, and transactional complete run
  replacement;
- start, stop, explicit epoch blocks, cancellation, and restart;
- automatic or explicit measurement mode and exact checkpoints;
- execution-rate changes.

The response protocol contains snapshots, order measurements, readiness,
capability reports, transactional run-created/run-rejected responses, and
terminal failures. The complete type definition is in
[`engine/src/protocol.ts`](../engine/src/protocol.ts).

## State ownership

`ParallelSoup` is the authoritative CPU/Wasm owner of:

- the complete population byte array;
- the current configuration and epoch number;
- the selected engine's coordinator instance and RNG state;
- the global permutation array;
- the execution-worker pool;
- reusable transfer buffers and metric scratch memory.

`WebGpuCuBffSoup` is the authoritative WebGPU owner of:

- the CuBFF population and permutation in GPU buffers;
- pair, mutation, evaluator, scatter, and reduction working buffers;
- the current configuration and epoch number;
- the per-run GPU epoch runner and buffer lifecycle;
- the latest immutable CPU population copy created at an observation boundary.

A coordinator-owned WebGPU context may retain its device and compiled pipelines
between sequential runs. Population and working buffers belong to one run and
are destroyed when that run ends. The CPU and GPU execution implementations do
not share mutable population storage.

For `ParallelSoup`, the selected coordinator Wasm instance performs
initialization and epoch shuffling. CuBFF randomness is counter-derived: every
value is a pure function of the user seed and explicit model coordinates, so it
has no mutable reactor RNG state. Brainfuck-Life owns one persistent xorshift64*
state in its coordinator instance. Initialization, shuffle, and post-epoch
population mutation consume that state in source order.

CPU execution workers do not own persistent population or authoritative RNG
state. Each worker is fixed to one engine for its lifetime and retains that
engine's Wasm instance and allocated memory for reuse. Every job supplies all
tape pairs required for that job. CuBFF jobs also supply the seed, epoch,
population size, and first global pair index needed for pair-local
counter-derived mutation. Brainfuck-Life jobs perform evaluation only and
consume no random values.

## Epoch execution

Both CPU/Wasm engines use the same all-or-nothing
gather/execute/scatter orchestration, but their native lifecycle rules remain
different.

CuBFF CPU/Wasm processes one epoch as follows:

1. The coordinator creates CuBFF's seed- and epoch-indexed Fisher–Yates
   permutation.
2. Consecutive entries define pairs, which are divided into disjoint worker
   groups and gathered into transfer buffers.
3. For each pair, its worker derives CuBFF's mutation values from the seed,
   epoch, population size, global pair index, and byte index, and mutates the
   concatenated pair before execution.
4. Workers evaluate the mutated pairs through the CuBFF `run_packed` entry
   point.
5. The coordinator waits for every worker, scatters all returned bytes, combines
   execution statistics, and increments the epoch.

Brainfuck-Life CPU/Wasm processes one epoch as follows:

1. The coordinator consumes `nTapes - 1` draws from its persistent xorshift64*
   stream to create the source Fisher–Yates permutation.
2. Consecutive entries define pairs, which are divided into disjoint worker
   groups and gathered into transfer buffers.
3. Workers evaluate those pairs through the Brainfuck-Life `run_packed` entry
   point with mutation disabled. Evaluation consumes no random values.
4. The coordinator waits for every worker and scatters all returned bytes.
5. The coordinator applies Brainfuck-Life's mutation pass to the complete
   population in tape order. A zero mutation numerator consumes no draws;
   otherwise each byte consumes one test draw and each replacement consumes one
   additional draw.
6. Execution statistics are combined and the epoch is incremented.

CuBFF WebGPU processes the same complete model epoch in WGSL:

1. CuBFF's native Wasm initializer creates the exact epoch-zero population,
   which is uploaded once when the run is prepared.
2. GPU compute passes create the exact Fisher–Yates permutation and gather
   consecutive shuffled tapes into pairs.
3. Pair-local mutation uses the same CuBFF counter coordinates and mutation
   numerator rule as the native source.
4. The bounded storage-buffer evaluator executes the pair programs in chunks.
5. Scatter writes every completed pair back to the resident population and a
   reduction produces operation and termination counters.
6. Each epoch's 16-byte counter reduction is copied to a distinct staging
   slot. Consecutive unthrottled epochs are submitted in order and all retained
   slots are mapped once after the bounded batch. A full population copy is
   requested separately at an observation boundary.

The production WebGPU evaluator uses workgroup size 128 and interpreter chunks
of 2048 steps. These are execution parameters, not reactor parameters, and do
not appear in the operator configuration.

The WebGPU coordinator initially queues at most two epochs. It then selects a
batch from the preceding mean epoch duration, targeting 250 ms and imposing a
hard limit of 32 epochs. Rate-limited execution remains single-epoch; explicit
epoch requests never exceed their remaining count. State-changing commands
are applied between these bounded batches. CPU/Wasm execution does not use
this queueing capability.

On CPU/Wasm no returned pair data is applied until every execution worker has
completed successfully. A failed worker therefore prevents a partially updated
epoch from becoming the authoritative CPU state. The coordinator exposes a
completed WebGPU epoch only after its counter readback validates completion; a
GPU error ends that trajectory as failed instead of exposing uncertain state.
The coordinator remains available for an explicitly selected replacement run.

Changing the CPU worker count starts and validates the replacement pool before
the old pool is terminated. The population and epoch number remain unchanged.
The UI permits this replacement only while continuous execution is stopped, so
a run uses one fixed worker-pool configuration from start to halt.

Automatic CPU worker selection is a static capacity heuristic. The main thread
normalizes `navigator.hardwareConcurrency` to a positive integer, using 4 when
the value is unavailable or invalid, then resolves:

```
auto = clamp(round(0.8 × available), 1, 16)
```

The resolved count is displayed immediately and sent through the worker
protocol as `{ mode: 'auto', count }`. The coordinator validates the count and
constructs that pool directly. No candidate pools, copied benchmark workload,
or startup timing pass exist. Engine, population-shape, step-limit, and run
changes retain the resolved count. Numbered fixed counts remain explicit manual
overrides.

WebGPU does not derive or use a worker count. CLR does not automatically choose
between CPU/Wasm and WebGPU from worker selection or adapter identity.

Changing engine or compute path constructs a new execution implementation.
Changing tape count or tape length reallocates the implementation's population
storage. Each of these changes regenerates the population from the configured
seed and returns the epoch to 0.
Step-limit and mutation changes retain the current population and, for
Brainfuck-Life, its current RNG continuation.

## Native core

CLR keeps the two C implementations structurally independent:

- [`engine/native/cubff_soup.c`](../engine/native/cubff_soup.c) is the complete browser
  adaptation of CuBFF's `bff_noheads.cu` evaluator and `common_language.h`
  population rules, pinned to
  [`8e3f774df03d1c895ec6ee0d21b6897ecea46806`](https://github.com/paradigms-of-intelligence/cubff/tree/8e3f774df03d1c895ec6ee0d21b6897ecea46806).
- [`engine/native/brainfuck_life_soup.c`](../engine/native/brainfuck_life_soup.c) is the
  complete CLR browser adaptation of Johannes Martin's `bff/soup.c` C port
  from CuBFF, pinned through
  [`alexcybernetic/BrainFuckLife@9d263836`](https://github.com/alexcybernetic/BrainFuckLife/tree/9d2638361a0ae5519dfe56539059cfec094cbd6e).

Neither file includes, links, calls, or generates C code from the other. Each
contains its own evaluator, RNG logic, initialization, shuffle, mutation,
unsharded epoch path, packed-pair path, and halt instrumentation. A change to
one engine can therefore be compared with its source and reviewed without
reading or modifying the other engine. Each file has an independent provenance
header and explicit CLR adaptation list.

Both evaluators implement the ten literal-ASCII BFF instruction bytes. Initial
head positions are not encoded in the tapes; the instruction pointer and both
data heads start at byte 0. `{` and `}` move head 1, while `.` and `,` copy
between the two heads instead of performing output and input.

Both cores compile independently for `wasm32-freestanding`. Runtime tape
length, termination-cause counters, phase-separated and packed execution, and
local `memcpy` are implemented separately in each file. The source-compatible
tape length is 64 bytes. Runtime tape lengths of 32 and 128 bytes, adjustable
step limits, and termination-cause counters are CLR extensions. Exact
Brainfuck-Life compatibility is claimed only for 64-byte tapes.

[`engine/src/core.ts`](../engine/src/core.ts) is the common TypeScript adapter. It
selects and decodes one embedded module, instantiates only that module, and
allocates linear-memory regions for population bytes, permutation indices, and
counters. It does not combine native state or implementation logic.

[`PackedCore`](../engine/src/packedCore.ts) provides the corresponding reusable
memory layout for execution workers and fixes a shard to its first selected
engine for that shard's complete lifetime. [`engine/src/shard.ts`](../engine/src/shard.ts)
contains only worker message handling around `PackedCore`.

## Telemetry and measurements

Population metrics are read-only operations and cannot affect CuBFF's
counter-derived values or Brainfuck-Life's stateful RNG continuation.

CPU/Wasm already owns a CPU population array. WebGPU keeps its authoritative
population on the GPU and copies each epoch's 16-byte operation and termination
reduction into a batch staging slot. One map returns the ordered reductions for
the complete bounded batch. A complete population is read back only when the
existing display snapshot, metrics, order measurement, checkpoint, sampler, or
record schedule requires it. One immutable readback is shared by every consumer
due at that boundary. No metric or compression job reads a buffer that a later
epoch can mutate.

[`SoupMetrics`](../engine/src/soup.ts) calculates byte frequencies, exact complete
tape groups, and deterministic samples of repeated 8-byte sequences. Hashes are
used to locate candidates; byte comparison determines identity.

[`replication.ts`](../engine/src/replication.ts) tests repeated-sequence carriers
against deterministic random partners. Its random generator is derived from the
run identity, epoch, and sequence, and is separate from the reactor generator.

[`order.ts`](../engine/src/order.ts) compresses an immutable complete-population
snapshot with Brotli 1.1.0 at quality 2, the compressor configuration specified
by the paper. [`brotli.ts`](../engine/src/brotli.ts) owns the isolated encoder Wasm
instance; its upstream encoder sources are pinned under
[`engine/native/vendor/brotli`](../engine/native/vendor/brotli). The measurement derives
high-order entropy from the compression result and the complementary
byte-frequency-order component from the same snapshot's zero-order entropy. A
generation identifier prevents a result from a previous population from being
added to a cleared plot. The main thread retains all three histories: both
derived order components share the plot's left axis, while the direct
compressed-bits-per-byte result uses the right axis.

Metric calculation, compression, and snapshot transfer are time-limited by
population size. This prevents display work from consuming an unbounded share
of epoch execution time.

Batch execution switches the coordinator to explicit measurement mode. It runs
one trajectory at a time, advances it in 128-epoch blocks, and requests one
checkpoint after each completed block. The checkpoint response combines order,
compression, reaction-state, epoch-statistic, cumulative-work, and population
fingerprint values captured from the same immutable population copy. Automatic
time-gated compression is disabled during this mode, so it cannot add
unrequested batch measurements or consume batch work between checkpoints.

Every batch item is a complete, explicitly configured trajectory. It contains
one model configuration, one compatible compute path, and two termination
conditions: an epoch limit and a high-order entropy crossing of 1, 2, or 3 bits
per byte. The first condition observed at a checkpoint ends the trajectory. A
WebGPU item can start only when its engine is CuBFF and the coordinator has
reported an adapter. Adapter identity is attached to the executed record rather
than the queue definition.

[`appweb/records/batch.ts`](../appweb/records/batch.ts) is the shared batch
domain boundary. Before execution state changes, it validates and defensively
clones the complete request, including the application-supported population
shape and step limit, VM policies, compute-path compatibility, unsigned seed
range, queue size, termination conditions, the 100,000,000-epoch upper bound,
and the fixed 128-epoch measurement interval. It also owns bounded seed
expansion and final-block sizing; UI and programmatic batch requests therefore
use the same rules.

Seed-count expansion is an editor operation: it materializes consecutive seeds
as separate definitions before execution, and the complete queue is limited to
100 runs. There is no runtime parameter-range or Cartesian-product expansion.

`BatchRunner.start()` resolves after validation and the complete queued
experiment have been written durably. Execution continues as owned background
work; later worker or record failures are published in batch progress rather
than rejecting the already accepted start action. Another start is rejected
until final experiment persistence, record refresh, manual-state restoration,
and control unlocking have all settled.

Batch progress is a recursively frozen, presentation-only snapshot. It carries
the requested Run-switch state separately from the effective running phase, so
an epoch that is still finishing during `pausing` remains recorded as running.
Pausing cancels only pending explicit epochs. The runner publishes `paused` and
writes both the run and experiment pause state only after the exact safe
boundary is reached; resume writes the running experiment state before another
epoch is submitted. The population, queue position, run UUID, and record
lifecycle are retained throughout. Terminal failure and application disposal
release the same pause gate, preventing teardown from leaving background work
unsettled. An explicit Stop request also releases a paused gate, finishes the
active trajectory as `batch-cancelled`, persists the experiment as interrupted,
retains the editable draft queue, and restores the saved manual setup before
unlocking model controls. Local presentation controls, including the Runs
window trigger, remain available while the batch owns those model controls.

## Experiment records

Record schemas are defined in [`appweb/records/model.ts`](../appweb/records/model.ts).
Every trajectory has a UUID independent of its configuration revision. Manual
and batch trajectories use the same `RunRecorder` lifecycle and measurement
format. Epoch-zero populations remain transient; persistence starts when a run
first reaches epoch 1. A requested execution that fails before completing an
epoch is retained as a failed epoch-zero record; an unused epoch-zero
population is still omitted. Schema 3 records the engine in `SoupConfig`, retains the
selected engine's source revision in `ModelIdentity`, and records structured
execution identity. `RunExecution.computePath` is `wasm` or `webgpu`;
`gpuAdapter` is null for CPU/Wasm and contains the opaque adapter fields exposed
by the browser for WebGPU: vendor, architecture, device, description, and the
fallback-adapter flag. Any string field may be empty. Batch definitions store
the requested compute path but not an adapter.

[`repository.ts`](../appweb/records/repository.ts) stores run summaries,
measurements, parameter events, and batch definitions in separate IndexedDB
object stores. Summary and child writes share transactions. A memory repository
is used only when IndexedDB cannot be opened. No record operation makes a
network request.
Readers accept schema 1 and schema 2. A missing engine normalizes to `cubff`;
legacy execution normalizes to `computePath: "wasm"` and `gpuAdapter: null` in
memory. Legacy parents are written as schema 3 only when subsequently modified.
Existing run, measurement, and event rows remain readable and are not walked or
rewritten in an IndexedDB upgrade transaction.
Schema-1 generated-batch summaries that predate explicit queue items remain
available for display and export, but cannot be executed or written as new
batch definitions.

The complete deterministic batch queue, including each full configuration,
engine, compute path, termination conditions, and generated run UUID, is written
before the first batch population starts. The explicitly configured editable
draft queue is retained in its own versioned local-storage entry. The pure
[`batchDraft.ts`](../appweb/records/batchDraft.ts) codec owns its JSON shape,
validation, and migration; `RunsController` supplies only the storage adapter.
Older draft formats are imported with missing engines normalized to `cubff`
and missing compute paths normalized to `wasm`, then written under the new key
on the next draft change. On application startup, records and experiments left
in running or paused state, plus experiments left queued, are marked interrupted.
JSON exports contain versioned
run, event, and measurement objects. CSV export is a run-summary projection.
Both exports include engine and compute path, and CSV includes the
engine-specific source revision and available adapter fields. Complete
population buffers are not retained automatically.

## Failure handling

Worker creation, worker startup, job responses, and message decoding have
explicit failure paths. Execution-worker startup has a 5-second limit and each
epoch job has a 30-second limit.

Preparing a prospective WebGPU run is transactional. Adapter, pipeline, buffer,
or epoch-zero upload failure rejects the new run and retains the current halted
implementation. A rejected manual compute-path selection creates no incomplete
record. An explicitly started batch item retains its failed epoch-zero attempt
and diagnostic. This recoverable rejection is distinct from a failure after a
run has started.

Any coordinator failure is terminal for that worker instance:

- the serial queue is sealed;
- continuous and pending execution stops;
- throughput state is cleared;
- execution workers are terminated;
- the main thread terminates the coordinator worker;
- core-dependent controls are disabled;
- late messages and later commands are ignored.

For an active WebGPU run, device loss, an uncaptured GPU error, invalid
readback, or command failure ends that trajectory as failed. The coordinator
retires its run resources and GPU context without sealing its command queue, so
the operator can explicitly select CPU/Wasm and create a fresh replacement run.
CLR never reconstructs or continues the failed trajectory on CPU.

Device-loss and uncaptured-error callbacks carry the generation of the GPU
context that installed them. When queued, a callback retains the current active
GPU trajectory identity when one exists. Ordered handling recovers only the
active GPU trajectory using that still-current context, after rechecking the
captured run generation and identifier. An event from an invalidated context is
ignored for the active context and cannot fail a replacement trajectory.

The sampler, help, and display navigation remain available so the last valid
snapshot can still be inspected.

## Build pipeline

The supported development runtime is Node.js 24.12 or newer. Several validation
scripts execute erasable TypeScript directly with Node, so older Node releases
are not supported.

[`tools/build-wasm.mjs`](../tools/build-wasm.mjs) invokes Zig three times.
It compiles `engine/native/cubff_soup.c` alone into `engine/src/cubff.wasm.ts`,
compiles `engine/native/brainfuck_life_soup.c` alone into
`engine/src/brainfuckLife.wasm.ts`, and compiles the pinned Brotli encoder into
`engine/src/brotli.wasm.ts`. No population-core link step receives the other
engine's source. All three modules are embedded in the application and are not
fetched separately at runtime.

Vite builds the application for ES2022 with relative asset paths. A build-only
document bootstrap derives the directory base from the current URL before any
generated asset reference is parsed, so the same artifact remains relocatable
when an extensionless website route serves `index.html` without a trailing-slash
redirect. No deployment directory is compiled into the application. Production
source maps are disabled. Main-thread and worker type environments are checked
separately through `tsconfig.json` and `engine/tsconfig.worker.json`.

Production WebGPU host code, ambient API types, and WGSL are under
[`engine/src/webgpu`](../engine/src/webgpu). The complete-epoch benchmark imports this
same host and shader implementation; only benchmark orchestration, retained
split-pipeline diagnostics, samples, and reporting stay under
the internal WebGPU benchmark. WebGPU adds no runtime package or network
dependency.

`npm run build` regenerates the native Wasm artifacts and writes `appweb/dist/`
without running validation. `npm run build:web` writes the same web bundle using
the checked-in Wasm artifacts. `npm test` performs the hardware-independent
validation sequence against those artifacts. `npm run verify` regenerates them,
runs `npm test`, and then creates the web bundle without rebuilding Wasm a
second time. None of these commands requests a real GPU device or executes WGSL.

## Validation structure

The default validation suite is hardware-independent. WebGPU protocol values,
record persistence, UI state, transactional replacement, and recovery ordering
are tested without claiming that a real adapter executed the shader.

- [`tools/conformance.ts`](../tools/conformance.ts) compares the TypeScript
  sampler VM with native C behavior across randomized and focused programs.
- [`tools/epoch-conformance.ts`](../tools/epoch-conformance.ts) protects
  independent CuBFF and Brainfuck-Life source fingerprints, execution
  statistics, static Auto derivation, 1/3/7-shard equivalence, transfers,
  worker-pool replacement invariance, and runtime state changes. Brainfuck-Life
  fixtures include epoch 0 and epochs 1,
  10, and 100 of the 4096 × 64 seed-4 trajectory captured from the pinned source
  library.
- Hardware-dependent WebGPU validation compares complete-population
  fingerprints, operation counts, termination counts, and throughput between
  the production WebGPU implementation and the independent CuBFF Wasm oracle.
  The exactness gate covers epochs 1, 10, and 100 and separates pre-transition
  and post-transition performance samples. This command is hardware-dependent,
  is not part of `npm test` or `npm run build`, and must be run on every browser
  and adapter for which evidence is required.
  Its standalone Vite configuration exposes the same production host and WGSL
  in a local manual page so installed Firefox, Chrome, and Safari can run
  identical configurations. Its JSON result includes browser and adapter
  identity, fallback status, CPU/Wasm and WebGPU rates, exactness,
  counter-map/batch behavior, and a phase profile. The profile times permutation
  target generation and the exact serial swap pass independently; each
  diagnostic phase has an extra queue boundary and is not a
  production-throughput sample.
- [`tools/engine-regression.ts`](../tools/engine-regression.ts) covers telemetry,
  replication scoring, order measurement, and worker lifecycle behavior.
- [`tools/coordinator-regression.ts`](../tools/coordinator-regression.ts)
  covers command ordering, recoverable GPU-run retirement and CPU replacement
  ordering, and fail-closed coordinator behavior. It does not execute WebGPU.
- [`tools/webgpu-host-regression.ts`](../tools/webgpu-host-regression.ts)
  uses a deterministic fake device to cover validation/out-of-memory scope
  order, failed pipeline-cache eviction, retry, and partial GPU-buffer cleanup.
  It does not execute WGSL.
- [`tools/records-regression.ts`](../tools/records-regression.ts) covers
  unused epoch-zero exclusion, requested epoch-zero execution failures, manual
  lifecycle, atomic measurement and event writes, late asynchronous
  measurements, order-crossing records, explicit batch
  definitions, engine- and compute-path-specific identity, schema-1/schema-2
  tolerant reads, schema-3 persistence, adapter metadata, and reload recovery.
- [`appweb/browser/startup.spec.ts`](../appweb/browser/startup.spec.ts) exercises
  the production bundle with real workers, Wasm execution, live configuration,
  throughput transitions, and terminal startup failures.
- Vitest coverage under [`appweb/react`](../appweb/react),
  [`appweb/runtime`](../appweb/runtime), and
  [`appweb/records`](../appweb/records) covers reusable React components and
  store ownership, start-gated Worker transport, protocol correlations,
  run/revision validation, display-loop and canvas ownership, binary-free
  display projection, copied Reaction State motif ownership, batch domain
  rules, and versioned draft migration.

UI tests protect behavior, accessibility, security, state ownership, lifecycle,
and nontrivial transformations. They do not pin mutable editorial copy, the
current package version, or incidental markup and class composition unless that
surface is an explicit production integration contract. Each test must protect
a plausible regression at the cheapest effective layer; a component's existence
alone is not a reason to add a test, and behavior already covered adequately at
one layer is not duplicated at another.

Browser tests are intentionally separate from `npm test` because they require a
downloaded Playwright browser. They execute real Workers and Wasm but do not
establish WebGPU shader exactness.

## Deployment and security

The production output is static. After its static assets load, application logic
does not call external services or send telemetry. UI-only preferences and the
editable batch draft are stored in browser `localStorage`. Experimental
parameters are not restored implicitly: each manual session starts from the
current baseline configuration, while explicitly queued batch definitions and
run records are stored in IndexedDB.
External links use `noopener noreferrer`.

WebGPU is optional and CuBFF CPU/Wasm remains the default. The WebGPU API is
available only in a secure context and must be exposed to the coordinator
Worker. Production deployments that need GPU execution therefore use HTTPS;
browser-local development origins are treated as secure contexts. Capability is
confirmed by `requestAdapter` in the Worker rather than inferred from a global
property.

The response Content Security Policy must allow `wasm-unsafe-eval` in
`script-src` because the application constructs the embedded Wasm module. The
exact hash documented in the README authorizes only the build-generated inline
relative-base bootstrap; arbitrary inline scripts remain disallowed. The policy
must also allow same-origin module workers. Iframe permissions are controlled by
the parent's `frame-src` and the application's `frame-ancestors` response
directive. The current
[WebGPU specification](https://gpuweb.github.io/gpuweb/) does not define a
standardized `webgpu` Permissions Policy feature token, so CLR does not require
or document a nonstandard iframe `allow="webgpu"` attribute. A hosting platform
may still restrict worker or GPU access through browser-specific policy; in
that case CLR reports WebGPU unavailable and continues to offer CPU/Wasm.

Adapter information is stored only in local schema-3 run records and appears in
operator-initiated exports. CLR treats browser-provided adapter strings as
opaque metadata and never uses them for automatic path or model decisions. The
boolean fallback-adapter flag is used only to reject software-backed WebGPU
from the production compute selector; the manual benchmark can still expose
and measure it diagnostically.

No runtime secret belongs in the client bundle. Production source maps are not
published.

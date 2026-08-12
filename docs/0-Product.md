# Product

CLR is a browser environment for running and inspecting computational-life
reactor experiments. It is not a scripted demonstration and it does not label a
run as successful or unsuccessful according to whether a phase transition is
observed. The configured model, executed trajectory, measurements, and
termination conditions define the experimental result.

## Application start

Every full application load begins with a blocking CLR start window. It shows
the project identity, application version, GPL-3.0-or-later status, no-warranty
notice, and links to the complete license, third-party notices, and source. The
reactor becomes available only after the operator selects **I understand — start
CLR**.

This action is an explicit application start, not a stored account agreement.
CLR does not retain an acceptance flag or send an acceptance event. The start
window therefore appears again on the next full page load.

## Reactor engines

CLR contains two separately maintained engines with different port paths from
CuBFF:

1. **V1** is CLR's adaptation of Johannes Martin's C port.
2. **V2** is CLR's direct port from the paper authors' reference
   implementation.

V1 and V2 are the engine names shown in the UI. They do not denote application
releases or record-schema versions. They identify the two source-port paths,
not compatible revisions of one trajectory; the same numeric seed selects
unrelated trajectories in the two engines.

Each engine has its own C source, Wasm artifact, source identity, conformance
fixtures, and default parameter profile. They share browser orchestration and
observation code but do not share native evaluator or RNG code.

## Compute paths

V2 can execute through either **CPU (Wasm)** or **GPU (WebGPU)**. The WebGPU
path executes the complete epoch on the selected browser GPU and keeps the
authoritative population resident there between epochs. It does not change the
V2 model or combine CPU and GPU work within an epoch.

CPU/Wasm is selected on every fresh load and when an engine default profile is
applied. The operator selects WebGPU explicitly for an individual V2 run or
batch item. CLR does not infer a preferred path from hardware names or measured
throughput. V1 remains CPU/Wasm-only.

Changing compute path while halted starts a new epoch-zero trajectory from the
current model configuration. State is not transferred between paths. CPU
workers are not used by WebGPU execution and their previous setting is retained
for the next CPU run.

Both CPU/Wasm engines offer automatic or fixed execution-worker counts. Auto
uses 80% of the logical-processor capacity reported by the browser, rounded to
the nearest worker and capped at 16. The count is resolved immediately and does
not benchmark or alter the reactor population. Fixed counts remain explicit
operator overrides.

## Observation and records

The Soup, Population Order, Reaction State, and Sampler displays observe the
same population semantics on both V2 compute paths. WebGPU retains compact
operation and halt counters for every epoch and maps them to the coordinator in
bounded batches. Complete population readback is performed only when an
existing snapshot or measurement consumer requires it. This boundary keeps
display work separate from epoch execution while preserving the measurement
definitions used by CPU/Wasm.

Manual and batch trajectories use the same local record lifecycle. Every batch
row defines one complete run, including engine, compute path, model parameters,
measurement interval, epoch limit, and order-crossing termination condition.
The record stores the requested compute path and, for an executed WebGPU run,
the adapter fields exposed by the browser. Adapter descriptions are treated as
opaque metadata and are not used to select a path or interpret results.

Pausing a batch preserves its current trajectory and exact checkpoint for
resume, so its queue and model parameters remain immutable. Stopping is a
separate explicit action: it ends the active trajectory at an exact epoch
boundary, marks the experiment interrupted, retains its draft queue and records,
and restores the saved manual setup. Observation, Help, Runs, and records remain
available while batch execution owns the model controls.

Records and editable batch drafts remain in the current browser. CLR performs
no telemetry or run-data network requests. Data leaves the browser only through
an operator-initiated export.

## Availability and failure semantics

WebGPU availability is established by requesting an adapter in the coordinator
worker. An adapter that explicitly reports itself as a fallback adapter is not
accepted for production execution, and GPU selection is not offered on that
browser/machine combination. Missing or privacy-reduced descriptive adapter
fields do not make an otherwise non-fallback adapter unavailable. A rejected
prospective GPU selection leaves the current halted run intact. Once a GPU run
starts, device loss, an uncaptured GPU error, invalid
readback, or command failure ends that run as failed and retires its GPU
resources. The application and coordinator remain available, the last valid
snapshot remains inspectable, and the operator can explicitly select CPU/Wasm
to create a fresh replacement run. CLR never reconstructs or silently
continues the failed trajectory on CPU.

The in-application **? help** window is the operator manual. It documents
reactor parameters, compute selection, indicators, measurement methods,
assumptions, batch operation, and the distinction between model parameters and
observation or throughput controls. Software structure and implementation
constraints belong in [Architecture](1-Architecture.md).

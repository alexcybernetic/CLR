import type { ReactElement } from 'react';

import type { HelpTopicId } from './helpModel.ts';

export { HELP_TOPIC_IDS } from './helpModel.ts';
export type { HelpTopicId } from './helpModel.ts';

export interface HelpTopic {
  readonly id: HelpTopicId;
  readonly title: string;
  readonly content: ReactElement;
}

export const HELP_TOPICS = [
  {
    id: 'fundamentals',
    title: 'reactor',
    content: (
      <article>
        <p>The reactor simulates a population of fixed-length byte arrays called <b>tapes</b>. Each tape contains values from 0 to 255. At the start of a run, every byte is selected uniformly from those values.</p>

        <h4>programs and data</h4>
        <p>This reactor uses <b>BFF</b>, the ten-instruction Brainfuck-derived language defined in the reference paper. Unlike canonical Brainfuck, BFF has two data heads, replaces input and output with copy operations, and adds <b>{'{'}</b> and <b>{'}'}</b> to move head 1.</p>
        <p>The same bytes are both program instructions and writable data. Ten values represent instructions: <b>+ - &lt; &gt; {'{ }'} . , [ ]</b>. The other 246 values perform no operation.</p>
        <p><b>&lt;</b> moves head 0 left and <b>&gt;</b> moves it right. <b>{'{'}</b> moves head 1 left and <b>{'}'}</b> moves it right. <b>.</b> copies the value from head 0 to head 1. <b>,</b> copies the value from head 1 to head 0. <b>+</b> increases the value at head 0 and <b>-</b> decreases it. When the value at head 0 is zero, <b>[</b> jumps forward past its matching <b>]</b>. When that value is nonzero, <b>]</b> jumps back to its matching <b>[</b>.</p>

        <h4>one epoch</h4>
        <p>At the start of each epoch, all tapes are shuffled and divided into pairs. The two tapes in each pair are concatenated in order to form one program. The program executes until it terminates or reaches the configured step limit. Its final first and second halves replace the original tapes. Every tape participates in exactly one pair. The selected engine determines when background mutation occurs: V2 mutates each concatenated pair before execution; V1 mutates the complete population after every pair has executed.</p>

        <h4>self-replication</h4>
        <p>A sequence is self-replicating when its instructions copy that sequence from one part of a pair into another. The reactor does not assign fitness, select tapes, or copy tapes through a separate reproduction rule. After initialization, tapes change only through program execution and mutation.</p>

        <h4>using the reactor</h4>
        <p>Start with the defaults and press <b>run</b>. The initial state has high byte diversity and few repeated sequences. During a transition, step-limit terminations and repeated sequences usually increase first. Groups of identical tapes then increase, high-order entropy rises, and byte diversity can decrease.</p>
        <p>Transition timing depends on the tape count, seed, tape length, step limit, and mutation rate. A transition is not guaranteed within a fixed epoch range for a particular seed or configuration.</p>
      </article>
    ),
  },
  {
    id: 'compute',
    title: 'compute',
    content: (
      <article>
        <p>These controls select the engine and execution resources for a run.</p>

        <p><b>engine</b>: selects the native computation core. <b>V1</b> is CLR's adaptation of Johannes Martin's C port. <b>V2</b> is CLR's direct port from CuBFF and underlying publication. V1 uses one persistent xorshift64* random stream and a complete-population mutation pass after pair execution. V2 uses counter-derived random rules and pair-local mutation before execution. The same numeric seed selects unrelated trajectories in the two engines. Changing the engine loads that engine's default profile, starts a new epoch-0 population, and creates a new run record.</p>

        <p><b>compute</b>: Both V1 and V2 support <b>CPU (Wasm)</b> through the C/Wasm worker pool; this path is selected on every fresh application load. V2 additionally supports <b>GPU (WebGPU)</b> only when the browser supplies a non-fallback WebGPU adapter to the simulation worker. The GPU path executes the complete epoch on the GPU and keeps the authoritative population there between scheduled observations. Changing the compute path while stopped creates a fresh epoch-0 population from the current conditions; state is not transferred between paths. If an active GPU run fails, that trajectory is recorded as failed and stopped. The last valid display remains available; select <b>CPU (Wasm)</b> to create an explicit fresh replacement run. CLR does not reconstruct or silently continue the failed trajectory on CPU.</p>

        <p><b>workers</b>: independent Web Workers that execute tape pairs through separate Wasm instances. <b>auto (N)</b> uses 80% of the browser-reported available logical processors, rounded to the nearest worker and capped at 16. The resolved count is deterministic and shown immediately; no startup benchmark is run. The numbered choices are manual overrides bounded by the browser-reported concurrency. Changing this control does not change a completed epoch result. Pool replacement is available only while the reactor is stopped. Workers are used by the CPU/Wasm paths of both engines. They are not used by WebGPU, so the control displays <b>not used</b> there and retains its CPU selection for the next CPU run.</p>

        <p>Engine, compute path, and workers are unavailable during continuous execution. Stop the reactor before changing them.</p>
      </article>
    ),
  },
  {
    id: 'conditions',
    title: 'soup conditions',
    content: (
      <article>
        <p>These parameters define the initial population. Changing any soup condition generates a new population and resets the epoch to 0.</p>

        <p><b>tapes</b>: the number of tapes in the population. The reactor executes half this many pairs per epoch. A larger value increases the number of interactions and the computation required for each epoch. It can also change the probability and persistence of a transition. The V2 default profile uses 131072 tapes. The V1 default profile uses 4096 tapes.</p>

        <p><b>bytes per tape</b>: the number of bytes in one tape. The available values are 32, 64, and 128. Each executed program contains two tapes, so its length is 64, 128, or 256 bytes. Tape length changes the available program space and the cost of execution. Both source implementations use 64-byte tapes; 32 and 128 bytes are CLR experiment extensions.</p>

        <p><b>random seed</b>: initializes the selected engine's population and random process. The same engine, seed, model parameters, and mutation schedule reproduce the same completed epochs. The V2 default profile uses seed 0; the V1 default profile uses seed 4. In V2, seed 0 is a distinct seed. In V1, seed 0 aliases the source implementation's fixed nonzero RNG state because xorshift64* cannot use an all-zero state. <b>roll</b> selects a new unsigned 32-bit seed. The paper does not define one required seed.</p>

        <p><b>defaults</b> restores the currently selected engine's profile, including tape count, tape length, seed, step limit, and mutation rate. It does not switch engines. It also restores the maximum execution rate and automatic worker selection.</p>

        <p>Tape count, tape length, seed, roll, step limit, and defaults are unavailable during continuous execution. Stop the reactor before changing them. These controls replace or redefine the experiment rather than changing observation speed. Mutation rate remains adjustable while running and takes effect at the next epoch boundary.</p>
      </article>
    ),
  },
  {
    id: 'run',
    title: 'run controls',
    content: (
      <article>
        <p><b>step limit per program</b>: the maximum number of evaluator steps for one tape pair. Each step dispatches the byte at the instruction pointer. A byte that performs no operation still consumes a step. Programs that reach the limit stop at that point. This is a model parameter: changing it can change the resulting tapes. The supplied value is 8192 steps.</p>

        <p><b>mutation per byte per epoch</b>: the probability that a byte is replaced with a new random value during one epoch. V2 applies this probability to each concatenated pair immediately before execution. V1 applies it in tape order to the complete population after all pairs have executed. The supplied value is 1/4096, approximately 0.0244%. Setting it to <b>off</b> disables mutation and consumes no V1 mutation RNG draws. Mutation is not a selection or scoring process.</p>

        <p><b>epochs per second</b>: limits the execution rate to <b>1</b>, <b>10</b>, or the maximum available rate. This setting changes observation speed only; it is not a model parameter and can be changed while running.</p>

        <p><b>run</b> starts or stops continuous execution. <b>restart</b> regenerates the initial population from the current seed and conditions, clears accumulated measurements, and returns to epoch 0. If the reactor was running, it continues after the restart.</p>

        <p>The machine display identifies the active compute path and, when exposed by the browser, the WebGPU adapter. The displayed <b>epoch</b> is the number of completed epochs. <b>epochs per second</b> is recent measured throughput. It is 0.0 while stopped and unavailable if the reactor terminates with an error.</p>

        <p><b>keyboard</b>: press Space to start or stop execution. Press <b>?</b> to open this manual and Escape to close it.</p>
      </article>
    ),
  },
  {
    id: 'soup',
    title: 'soup',
    content: (
      <article>
        <p>This panel displays the current bytes of every tape. It is a direct view of the population, not a sampled measurement.</p>

        <p><b>layout</b>: each tape is a horizontal sequence of bytes. Tapes are arranged in columns to use the panel area. Thin vertical separators mark column boundaries. The view label reports the current scale and visible tape range.</p>

        <p><b>operators</b>: displays only the ten instruction values. The 246 values that perform no operation are suppressed. Colours separate instruction classes, and instruction characters appear when the view is sufficiently magnified. The operation classes are listed in the legend strip above the Sampler.</p>

        <p><b>raw bytes</b>: displays all values using a cool colour scale from 0 to 255. The legend strip above the Sampler shows labelled colour samples at values 0, 64, 128, 192, and 255. Use this mode to inspect the complete byte distribution rather than only executable instructions.</p>

        <p><b>tape counts</b>: displays the ranked whole-tape frequency distribution. Tapes with exactly the same complete byte sequence form one group. Each row reports its population count, population share, an eight-digit hexadecimal content hash, and the positions of its operation bytes. Non-operation bytes are blank. The hash is a compact content label, not a lineage identifier; exact byte comparison determines the groups even if two hashes collide. Up to the 64 most frequent groups are retained in each measurement.</p>

        <p>Tape counts uses the same periodic exact-population measurement as <b>reaction state</b>. It does not add another population scan and can trail the current operator or raw-byte image between measurements.</p>

        <p><b>navigation</b>: in <b>operators</b> and <b>raw bytes</b>, scroll to change scale, drag to move the view, and use <b>fit</b> or double-click to restore the complete population. In <b>tape counts</b>, use the wheel or the scrollbar at the right edge to move through retained ranks; <b>fit</b> is unavailable because this view has no scale transform. <b>expand</b> allocates the main display area to this panel in every mode.</p>

        <p>The <b>A</b> and <b>B</b> markers identify the tapes currently loaded into the sampler. In <b>pick</b> mode, select A and then B in the <b>operators</b> or <b>raw bytes</b> view. Tape counts is disabled while selecting tapes because its rows represent groups rather than individual tape positions.</p>
      </article>
    ),
  },
  {
    id: 'order',
    title: 'population order',
    content: (
      <article>
        <p>This panel separates order in the byte-frequency distribution from order in multi-byte sequences and tracks the direct compression result. All three histories use the complete population and are shown in bits per byte.</p>

        <p>The horizontal axis is the reactor epoch. The left vertical axis belongs to the two order measurements. The right vertical axis belongs to compressed bits per byte.</p>

        <p><b>H₀</b> is the empirical zero-order entropy calculated from individual byte frequencies. It ranges from 0 to 8 bits per byte and does not use byte position or adjacency.</p>

        <p><b>byte-frequency order = 8 − H₀.</b> It is near 0 when all 256 byte values occur at similar frequencies. It increases when the population becomes concentrated on a smaller or unevenly distributed set of values.</p>

        <p><b>compressed bits per byte</b> is the complete population's Brotli 1.1.0 quality-2 compressed size in bits divided by its uncompressed size in bytes. It is the dashed line against the right axis and falls when the population compresses more effectively.</p>

        <p><b>high-order entropy = H₀ − compressed bits per byte.</b> It is a compressor-dependent estimate of repeated multi-byte structure. A random population is close to 0; the value increases when repeated sequences become common.</p>

        <p>All three plotted histories come from the same immutable population snapshot. Compression is calculated periodically rather than after every epoch because it has a measurable processing cost. The displayed measurement epoch identifies the snapshot used. The chart's epoch axis continues to follow the current reactor epoch between compression measurements.</p>

        <p>Reaction State uses separate, faster measurements because its counts are cheaper to calculate. The panels do not need the same refresh frequency: Population Order reports its measurement epoch, while Reaction State presents the latest available reactor telemetry.</p>

        <p>The compressor version and quality match the reference paper. A rapid multi-bit increase indicates a major change in population structure, not by itself proof of self-replication.</p>

        <p>The exact number of distinct byte values remains available under <b>reaction state</b>. It is not plotted here because a value counts as present regardless of whether it occurs once or many times.</p>
      </article>
    ),
  },
  {
    id: 'state',
    title: 'reaction state',
    content: (
      <article>
        <p>This panel combines exact population counts, sampled 8-byte sequence-frequency measurements, and execution termination statistics.</p>

        <h4>counts</h4>
        <p><b>dimensions</b>: the current number of tapes and bytes per tape.</p>
        <p><b>largest group of identical tapes</b>: the number of tapes in the largest byte-identical group. An increasing group is evidence that the same complete tape is being produced repeatedly.</p>
        <p><b>distinct byte values</b>: the number of values, from 0 to 256, present anywhere in the population.</p>
        <p><b>distinct tapes</b>: the number of byte-distinct tapes. A decrease means that complete duplicate tapes exist. Random duplication of a full tape is very unlikely at the supported tape lengths.</p>

        <h4>most frequent 8-byte sequences</h4>
        <p>Up to 4096 evenly distributed tapes are inspected. Every contiguous 8-byte sequence within those tapes is counted. The six most frequent sequences in the sample are displayed. Their byte values are exact; the displayed population counts and shares are estimates.</p>
        <p>If the six rows do not fit in the available panel height, use the visible scrollbar to inspect the remaining rows. The table header stays fixed.</p>
        <p><b>copied run</b> tests whether a tape containing the listed sequence can reproduce part of itself. The original tape is paired with deterministic random data and executed. The measurement is the longest contiguous byte sequence shared by the original tape and the resulting partner. The displayed result is the median of 16 trials across up to four source tapes.</p>
        <p>For a 64-byte tape, <b>57/64</b> means that a contiguous 57-byte part of the source was present in the resulting partner. <b>—</b> means that no source tape containing the sequence was found for the test.</p>
        <p>This test measures copying associated with a source tape. It does not prove that the listed 8-byte sequence caused the copying. Several listed sequences can be parts of the same longer program.</p>

        <h4>termination cause</h4>
        <p>These values report how programs ended in the previous epoch. <b>pointer off tape</b> means that the instruction pointer moved past the program boundary. <b>step limit</b> means that execution was still active after the configured maximum number of evaluator steps. <b>unmatched bracket</b> means that a loop instruction had no matching bracket.</p>
        <p>An increasing step-limit share means that more programs continue executing for long periods. A decreasing unmatched-bracket share means that executable bracket structures are becoming more common.</p>
      </article>
    ),
  },
  {
    id: 'sampler',
    title: 'sampler',
    content: (
      <article>
        <p>The sampler executes a copied tape pair separately from the population. It never modifies the reactor state. The pair is selected from the current population; it is not a replay of a pair that executed during an earlier epoch.</p>

        <p><b>pair order</b>: the A and B row labels identify the selected tapes and their concatenation order. Execution starts at the first byte of A. A+B and B+A can produce different results.</p>

        <p><b>random</b> selects one pair without activity-based filtering. The two tape indices are always different. This includes pairs that execute few or no instructions.</p>

        <p><b>busiest of 200</b> evaluates 200 candidate pairs and selects the pair with the most copy operations. Use it to inspect active execution. It is intentionally not a representative sample.</p>

        <p><b>pick</b> uses two manual selections from the Soup panel. Select A first and B second. The pair remains selected until it is replaced.</p>

        <p><b>next pair</b> loads another pair using the selected method. <b>play</b> executes continuously, <b>step</b> advances one evaluator step, and <b>rewind</b> restores the pair to its initial state. <b>steps per frame</b> controls playback speed only. At 0.1 the sampler advances once every ten rendered frames; at 0.5 it advances once every two rendered frames.</p>

        <p><b>keyboard</b>: press P for the next pair, S for one evaluator step, and R to rewind.</p>

        <p><b>display</b>: row A contains the first tape and row B contains the second. The row labels report byte positions in the combined program. Each byte is shown as a square, with its decimal value from 0 to 255 underneath. At 128 bytes per tape, adjacent values are vertically staggered so all three decimal digits remain readable. Operation bytes use the warm operator colours and characters from the Soup <b>operators</b> view. Bytes that perform no operation use the same cool numeric-value colour scale as the Soup <b>raw bytes</b> view. The legend strip above the Sampler shows both colour mappings.</p>
        <p><b>indicators</b>: <b>▼</b> marks the instruction pointer. <b>▲</b> and <b>△</b> mark data heads 0 and 1. A changed byte is highlighted. The register row reports step count, copy count, pointer positions, and the next byte at the instruction pointer. The next-byte fields show its decimal value, operation glyph, and operation description. For one of the other 246 byte values, the glyph field is empty and the description is <b>no operation</b>. The trace contains executed operations and omits no-operation bytes.</p>

        <p>The sampler switch enables or disables this separate execution display. While it is off, the sampling and execution controls are unavailable, but the loaded pair is retained. The switch does not change the reactor run.</p>
      </article>
    ),
  },
  {
    id: 'runs',
    title: 'runs and batches',
    content: (
      <article>
        <p>The <b>runs</b> window records executed reactor trajectories and controls sequential parameter batches. Records are stored only in this browser. The application does not send run data over the network.</p>

        <h4>manual runs</h4>
        <p>A manual record is created automatically when a population completes epoch 1. If execution was requested but fails before an epoch completes, the epoch-0 failure and its diagnostic are retained instead. Merely selecting conditions, rolling a seed, or inspecting an epoch-0 population does not create a record. Halt and resume continue the same run. Restart, engine change, a successfully applied compute-path change, seed change, tape-count change, and tape-length change end the current run and define a new trajectory. A rejected compute-path selection retains the current halted run.</p>
        <p>Step-limit and mutation changes made after epoch 0 are retained as parameter events with the first coordinator epoch at which the change applied. Worker-count and execution-rate changes are retained as execution events; they do not change completed reactor results.</p>

        <h4>batch runs</h4>
        <p>Each queue row is one explicitly configured trajectory. The editor uses the same engine, tape-count, tape-length, seed, step-limit, mutation, and compute controls as the manual reactor. GPU (WebGPU) rows require V2 and an available non-fallback adapter when the batch starts. Stored GPU rows remain visible when unavailable but cannot start; the editor does not offer GPU for new rows on that machine. Changing its engine loads that engine's default profile before the row is added or edited. <b>Seed start</b> and <b>number of seeds</b> let <b>Add</b> materialize consecutive seeds as separate queue rows. The complete queue is limited to 100 runs. Selecting a queue row loads it into the editor, <b>Edit</b> replaces that one row, and <b>Delete</b> removes it. <b>Clear queue</b> removes the complete draft queue after confirmation; it does not remove records. The ordered draft queue is retained in this browser.</p>
        <p>Every queued trajectory has two termination conditions: an epoch limit and a high-order entropy crossing of 1, 2, or 3 bits/byte. The first condition reached ends that trajectory. Trajectories execute sequentially using the compute path stored in each row. CPU (Wasm) rows use the active worker selection; GPU (WebGPU) rows do not use execution workers.</p>
        <p>Each trajectory advances in blocks of 128 epochs. At every block boundary, population order and reaction metrics are calculated from one immutable complete-population copy. The final block can be shorter at the epoch limit. An order crossing is therefore recorded at the first exact checkpoint at or above its configured value, with resolution determined by the 128-epoch interval.</p>
        <p>The batch <b>Run</b> switch starts or resumes the queue. Switching it off stops pending execution at an epoch boundary, records the current checkpoint, and preserves the active trajectory for later continuation. The queue and model controls remain locked while that trajectory is paused. <b>Stop batch</b> ends the active trajectory at an exact epoch boundary, marks the experiment interrupted, retains the draft queue and completed records, and restores the pre-batch manual parameters as a fresh, halted epoch-0 population. Reloading the page marks an active or paused batch interrupted.</p>

        <h4>record contents</h4>
        <p>Each run stores its source, status, selected engine, compute path, browser-exposed GPU adapter information when applicable, engine source revision, application and compressor identity, initial parameters and seed, execution settings, parameter-event history, configured termination conditions, epoch and work totals, observed order crossing, maximum high-order entropy, and latest population fingerprint. Measurements include order values, compression size, exact tape and byte counts, sequence leaders, termination counts, and cumulative work at the same epoch.</p>
        <p>Complete population bytes are not stored automatically. This keeps record size bounded and avoids duplicating large populations at every checkpoint. JSON export includes run details, events, and measurements. CSV export contains one summary row per run.</p>

        <h4>batch summaries</h4>
        <p>Records groups explicitly queued runs that share model and termination parameters. It reports completed runs, order-crossing proportion with a 95% Wilson interval, first observed crossing epoch median and range, and median steps and compute time at crossing. Interrupted and failed trajectories are not counted as completed observations. The reactor does not select or label a configuration as best.</p>
      </article>
    ),
  },
  {
    id: 'assumptions',
    title: 'assumptions and limits',
    content: (
      <article>
        <h4>fixed execution rules</h4>
        <p>For every pair, the instruction pointer and both data heads start at byte 0, the first byte of tape A. Data heads wrap at the combined-program boundary. The instruction pointer does not wrap; execution ends when it leaves the program. An unmatched loop bracket also ends execution. A program that reaches the step limit ends at its current state.</p>

        <h4>population rules</h4>
        <p>Every tape is paired exactly once per epoch and tape position has no spatial meaning. V2 uses a seed- and epoch-indexed uniform shuffle and mutates each concatenated pair before execution. V1 uses a uniform Fisher–Yates shuffle driven by its persistent RNG stream and mutates the complete population after execution.</p>

        <h4>no external selection</h4>
        <p>The reactor has no fitness value, target pattern, selection step, or separate reproduction operation. A sequence becomes more common only when executed programs produce additional copies of it.</p>

        <h4>repeatability</h4>
        <p>An engine and seed identify one deterministic run when all model parameters and the mutation schedule are unchanged. Seed values are not comparable across engines because their random streams are unrelated. V2's CPU/Wasm and GPU/WebGPU paths implement the same epoch and are required to produce identical bytes and counters; the compute path changes execution placement, not the reactor model. Worker count and epoch-rate limits do not change completed epoch results. Sampler activity, worker-pool replacement, and measurement activity cannot alter either engine's reactor state or RNG continuation.</p>

        <h4>measurement limits</h4>
        <p>Whole-tape counts and byte counts are exact. Repeated 8-byte sequence counts are estimated from a deterministic sample of at most 4096 tapes. The copied-run test measures copying by a complete source tape and does not identify which instruction sequence caused it. Compression measures repeated structure but does not identify a replicator.</p>

        <h4>interpretation</h4>
        <p>A transition is not guaranteed for every seed or configuration. Timing observed for one run does not predict other runs. The reactor models byte programs, execution, pairing, and mutation. It does not model chemistry, metabolism, physical space, or biological fitness.</p>
      </article>
    ),
  },
  {
    id: 'references',
    title: 'references',
    content: (
      <article>
        <p><b>Research paper</b>: Blaise Agüera y Arcas, Jyrki Alakuijala, James Evans, Ben Laurie, Alexander Mordvintsev, Eyvind Niklasson, Ettore Randazzo, and Luca Versari, <a href="https://arxiv.org/abs/2406.19108" target="_blank" rel="noopener noreferrer"><em>Computational Life: How Well-formed, Self-replicating Programs Emerge from Simple Interaction</em>, arXiv:2406.19108</a>. The paper defines the computational-life experiments and reactor model.</p>

        <p><b>V2 source</b>: <a href="https://github.com/paradigms-of-intelligence/cubff" target="_blank" rel="noopener noreferrer">paradigms-of-intelligence/cubff</a>. CuBFF is the paper authors' reference implementation and the direct source of CLR's V2 port; the repository states that most experiments reported in the paper used this code.</p>

        <p><b>V1 source</b>: <a href="https://github.com/mathelehrer/BrainFuckLife" target="_blank" rel="noopener noreferrer">mathelehrer/BrainFuckLife</a> by Johannes Martin. Its C reactor ports CuBFF through Martin's readable BFF implementation and is the source adapted by CLR's V1 engine.</p>

        <p><b>V1 pinned source</b>: <a href="https://github.com/alexcybernetic/BrainFuckLife" target="_blank" rel="noopener noreferrer">alexcybernetic/BrainFuckLife</a>, pinned at commit <b>9d263836</b>, is the fork through which CLR pins Johannes Martin's C port.</p>

        <h4>implementation boundary</h4>
        <p>CLR keeps the two native C ports in separate files and compiles them into separate Wasm modules. V2 is pinned to CuBFF commit <b>8e3f774</b>; V1 is pinned to BrainFuckLife commit <b>9d263836</b>. Complete population checkpoints are validated against separate builds of both pinned sources. V2's default profile uses 131072 tapes, 64 bytes per tape, 8192 steps, mutation probability 1/4096, and seed 0. V1's default profile uses 4096 tapes, 64 bytes per tape, 8192 steps, mutation probability 1/4096, and seed 4; it is the initial profile for a fresh CLR session. V1 compatibility is exact for 64-byte tapes; its 32- and 128-byte modes are CLR extensions.</p>
      </article>
    ),
  },
] satisfies readonly HelpTopic[];

export const HELP_TOPICS_BY_ID: Readonly<Record<HelpTopicId, HelpTopic>> = Object.fromEntries(
  HELP_TOPICS.map((topic) => [topic.id, topic]),
) as Record<HelpTopicId, HelpTopic>;

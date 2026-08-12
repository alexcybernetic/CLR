/*
 * The sampler's interpreter against the core's.
 *
 * Both independent native population cores contain their own evaluator. The
 * sampler needs instruction-by-instruction state that the compiled interface
 * does not expose, so `engine/src/vm.ts` implements the evaluator again and can
 * drift from either native implementation.
 *
 * This runs both over the same programs and compares the resulting bytes and
 * the halt code. It is part of `npm test`, so drift is caught before a release
 * rather than showing up as a sampler that disagrees with the soup it samples.
 */
import {
  HALT_IP_OOB,
  HALT_MAX_STEPS,
  HALT_NO_MATCH,
  HALT_RUNNING,
  HEAD_WRAP,
  NOMATCH_HALT,
  VM,
} from '../engine/src/vm.ts';
import { instantiate, layout } from '../engine/src/core.ts';

const TAPE_LENGTHS = [32, 64, 128] as const;
const STEP_LIMITS = [2048, 4096, 8192, 16384, 32768] as const;
const RANDOM_TRIALS_PER_TAPE = 5000;
const REFERENCE_MAX_STEPS = 8192;
const OPS = [43, 44, 45, 46, 60, 62, 91, 93, 123, 125] as const;

const nativeCores = (['cubff', 'brainfuck-life'] as const).map((engine) => ({
  engine,
  core: instantiate(engine),
  mem: { soup: 0, idx: 0, counts: 0 },
}));
const vm = new VM();
vm.headPolicy = HEAD_WRAP;
vm.noMatch = NOMATCH_HALT;

let activeTapeLen = 0;

interface CaseResult {
  halt: number;
  ops: number;
  steps: number;
  output: Uint8Array;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

function firstDifferentByte(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function configure(tapeLen: number): void {
  if (tapeLen === activeTapeLen) return;
  for (const native of nativeCores) {
    native.core.configure(tapeLen);
    native.mem = layout(native.core, 2, tapeLen);
  }
  activeTapeLen = tapeLen;
}

/** Run one glued pair through both interpreters and require exact agreement. */
function runCase(label: string, tapeLen: number, maxSteps: number, input: Uint8Array): CaseResult {
  const programLen = tapeLen * 2;
  assert(input.length === programLen, `${label}: expected ${programLen} input bytes`);
  configure(tapeLen);

  const nativeResults = nativeCores.map((native) => {
    const bytes = new Uint8Array(native.core.memory.buffer);
    bytes.set(input, native.mem.soup);
    const ops = native.core.evaluate(native.mem.soup, maxSteps);
    return {
      engine: native.engine,
      halt: native.core.last_halt(),
      ops,
      output: bytes.slice(native.mem.soup, native.mem.soup + programLen),
    };
  });

  const js = input.slice();
  vm.maxSteps = maxSteps;
  vm.load(js);
  const jsHalt = vm.runToHalt();

  for (const native of nativeResults) {
    assert(
      jsHalt === native.halt,
      `${label}: halt vm.ts=${jsHalt}, ${native.engine}=${native.halt}`,
    );
    const different = firstDifferentByte(js, native.output);
    assert(
      different < 0,
      `${label}: byte ${different} vm.ts=${js[different]}, ${native.engine}=${native.output[different]}`,
    );
    assert(
      native.ops === nativeResults[0].ops,
      `${label}: operation count ${native.engine}=${native.ops}, cubff=${nativeResults[0].ops}`,
    );
  }
  const primary = nativeResults[0];
  return { halt: primary.halt, ops: primary.ops, steps: vm.steps, output: primary.output };
}

function expectUnchanged(label: string, input: Uint8Array, result: CaseResult): void {
  const different = firstDifferentByte(input, result.output);
  assert(different < 0, `${label}: unexpectedly changed byte ${different}`);
}

/** Require the step-wise API to report termination on the final instruction. */
function expectHaltOnStep(
  label: string,
  input: Uint8Array,
  maxSteps: number,
  instruction: number,
  expected: number,
): void {
  vm.maxSteps = maxSteps;
  vm.load(input.slice());
  for (let step = 1; step <= instruction; step++) {
    const halt = vm.step();
    assert(
      halt === (step === instruction ? expected : HALT_RUNNING),
      `${label}: halt ${halt} after instruction ${step}`,
    );
  }
}

const blankProgram = (tapeLen: number) => new Uint8Array(tapeLen * 2);
let focusedCases = 0;

for (const tapeLen of TAPE_LENGTHS) {
  const inert = blankProgram(tapeLen);
  let result = runCase(`inert/${tapeLen}`, tapeLen, REFERENCE_MAX_STEPS, inert);
  assert(result.halt === HALT_IP_OOB, `inert/${tapeLen}: expected IP-OOB`);
  assert(result.ops === 0, `inert/${tapeLen}: inert bytes counted as operations`);
  expectUnchanged(`inert/${tapeLen}`, inert, result);
  focusedCases++;

  // If the cutoff and the end of the program coincide, soup.c gives the
  // instruction pointer precedence. This also locks down same-step halting.
  result = runCase(`ip-cutoff-tie/${tapeLen}`, tapeLen, tapeLen * 2, inert);
  assert(result.halt === HALT_IP_OOB, `ip-cutoff-tie/${tapeLen}: expected IP-OOB`);
  assert(result.steps === tapeLen * 2, `ip-cutoff-tie/${tapeLen}: wrong step count`);
  expectHaltOnStep(
    `ip-cutoff-tie/${tapeLen}`,
    inert,
    tapeLen * 2,
    tapeLen * 2,
    HALT_IP_OOB,
  );
  focusedCases++;

  const forwardUnmatched = blankProgram(tapeLen);
  forwardUnmatched[1] = 91; // zero at h0 makes '[' scan forward
  result = runCase(
    `forward-unmatched/${tapeLen}`,
    tapeLen,
    REFERENCE_MAX_STEPS,
    forwardUnmatched,
  );
  assert(result.halt === HALT_NO_MATCH, `forward-unmatched/${tapeLen}: expected NO-MATCH`);
  expectUnchanged(`forward-unmatched/${tapeLen}`, forwardUnmatched, result);
  focusedCases++;

  const backwardUnmatched = blankProgram(tapeLen);
  backwardUnmatched[0] = 62; // move h0 onto the unmatched ']'
  backwardUnmatched[1] = 93;
  result = runCase(
    `backward-unmatched/${tapeLen}`,
    tapeLen,
    REFERENCE_MAX_STEPS,
    backwardUnmatched,
  );
  assert(result.halt === HALT_NO_MATCH, `backward-unmatched/${tapeLen}: expected NO-MATCH`);
  expectUnchanged(`backward-unmatched/${tapeLen}`, backwardUnmatched, result);
  focusedCases++;

  const nested = blankProgram(tapeLen);
  nested.set([91, 91, 93, 93], 1); // h0 remains on the zero byte at position 0
  result = runCase(`nested-jump/${tapeLen}`, tapeLen, REFERENCE_MAX_STEPS, nested);
  assert(result.halt === HALT_IP_OOB, `nested-jump/${tapeLen}: expected IP-OOB`);
  expectUnchanged(`nested-jump/${tapeLen}`, nested, result);
  focusedCases++;

  const h0Wrap = blankProgram(tapeLen);
  h0Wrap[0] = 60; // '<'
  h0Wrap[1] = 43; // '+'
  h0Wrap[h0Wrap.length - 1] = 7;
  const h0Expected = h0Wrap.slice();
  h0Expected[h0Expected.length - 1] = 8;
  result = runCase(`h0-wrap/${tapeLen}`, tapeLen, REFERENCE_MAX_STEPS, h0Wrap);
  assert(result.halt === HALT_IP_OOB, `h0-wrap/${tapeLen}: expected IP-OOB`);
  assert(firstDifferentByte(result.output, h0Expected) < 0, `h0-wrap/${tapeLen}: wrong output`);
  focusedCases++;

  const h1Wrap = blankProgram(tapeLen);
  h1Wrap[0] = 123; // '{'
  h1Wrap[1] = 46; // '.'
  h1Wrap[h1Wrap.length - 1] = 7;
  const h1Expected = h1Wrap.slice();
  h1Expected[h1Expected.length - 1] = 123;
  result = runCase(`h1-wrap/${tapeLen}`, tapeLen, REFERENCE_MAX_STEPS, h1Wrap);
  assert(result.halt === HALT_IP_OOB, `h1-wrap/${tapeLen}: expected IP-OOB`);
  assert(firstDifferentByte(result.output, h1Expected) < 0, `h1-wrap/${tapeLen}: wrong output`);
  focusedCases++;
}

// The cutoff is independent of tape length. One stable loop at the baseline
// 64-byte length checks every supported value without multiplying the corpus.
for (const maxSteps of STEP_LIMITS) {
  const loop = blankProgram(64);
  loop[0] = 91;
  loop[1] = 93; // `[]`: byte 0 is non-zero, so `]` loops forever
  const result = runCase(`step-limit/${maxSteps}`, 64, maxSteps, loop);
  assert(result.halt === HALT_MAX_STEPS, `step-limit/${maxSteps}: expected MAX-STEPS`);
  assert(result.ops === maxSteps, `step-limit/${maxSteps}: C executed ${result.ops} operations`);
  assert(result.steps === maxSteps, `step-limit/${maxSteps}: VM executed ${result.steps} steps`);
  expectUnchanged(`step-limit/${maxSteps}`, loop, result);
  expectHaltOnStep(`step-limit/${maxSteps}`, loop, maxSteps, maxSteps, HALT_MAX_STEPS);
  focusedCases++;
}

/* Deterministic, and biased toward operators — a uniformly random program is
   96% inert and would mostly test the same few paths. Each tape length gets an
   independent stream, so adding one parameter cannot perturb the others. */
for (const tapeLen of TAPE_LENGTHS) {
  let x = (0x2f6e2b1 ^ Math.imul(tapeLen, 0x9e3779b1)) >>> 0;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296;
  const js = blankProgram(tapeLen);
  for (let trial = 0; trial < RANDOM_TRIALS_PER_TAPE; trial++) {
    for (let i = 0; i < js.length; i++) {
      js[i] = rnd() < 0.35 ? OPS[(rnd() * OPS.length) | 0] : (rnd() * 256) | 0;
    }
    runCase(`random/${tapeLen}/${trial}`, tapeLen, REFERENCE_MAX_STEPS, js);
  }
}

const randomCases = RANDOM_TRIALS_PER_TAPE * TAPE_LENGTHS.length;
console.log(
  `conformance: vm.ts matches both independent native evaluators on ${randomCases} random programs and ${focusedCases} focused cases`,
);

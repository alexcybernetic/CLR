/*
 * WGSL kernels for the production CuBFF WebGPU compute path and its
 * standalone conformance/throughput benchmark.
 * Copyright 2024 Google LLC
 * CLR modifications Copyright (C) 2026 Alex Borger
 * SPDX-License-Identifier: Apache-2.0
 * Modified for CLR in 2026 as a WebGPU/WGSL implementation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * The evaluator transcribes the `bff_noheads` semantics of
 * `engine/native/cubff_soup.c` exactly: step accounting includes no-ops, bracket
 * scans cost one step, the instruction pointer terminates off-tape, and the
 * halt causes are 1 (pointer off tape), 2 (step limit), 4 (unmatched
 * bracket). Optional pair-local mutation reproduces CuBFF's counter-derived
 * SplitMix64 stream with u64 arithmetic emulated on u32 pairs.
 *
 * Execution is chunked: each dispatch advances every unfinished pair by at
 * most `chunkSteps` interpreter steps, with (pc, heads, steps, ops, halt)
 * persisted per pair between dispatches.
 *
 * The evaluator is generated per (tape placement, workgroup size, tape
 * length) so the kernel-variant sweep can compare:
 *   private   — per-thread private array (dynamically indexed: lives in
 *               per-thread scratch memory)
 *   workgroup — tapes in threadgroup memory, one slice per thread
 *   storage   — bytes read and written directly in the storage buffer
 * All variants share identical semantics; only byte placement differs.
 */

export const KERNEL_VARIANTS = ['private', 'workgroup', 'workgroup-i', 'storage'] as const;
export type KernelVariant = (typeof KERNEL_VARIANTS)[number];

const U64_HELPERS = /* wgsl */ `
fn mul32(a : u32, b : u32) -> vec2<u32> {
  let al = a & 0xffffu; let ah = a >> 16u;
  let bl = b & 0xffffu; let bh = b >> 16u;
  let ll = al * bl;
  let lh = al * bh;
  let hl = ah * bl;
  let hh = ah * bh;
  let mid = lh + hl;
  let midCarry = select(0u, 0x10000u, mid < lh);
  let lo = ll + (mid << 16u);
  let loCarry = select(0u, 1u, lo < ll);
  let hi = hh + (mid >> 16u) + midCarry + loCarry;
  return vec2<u32>(lo, hi);
}

fn mul64(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
  let p = mul32(a.x, b.x);
  return vec2<u32>(p.x, p.y + a.x * b.y + a.y * b.x);
}

fn add64(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
  let lo = a.x + b.x;
  let carry = select(0u, 1u, lo < a.x);
  return vec2<u32>(lo, a.y + b.y + carry);
}

fn xor64(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
  return vec2<u32>(a.x ^ b.x, a.y ^ b.y);
}

fn shr64(a : vec2<u32>, n : u32) -> vec2<u32> {
  // 0 < n < 32 for every use below
  return vec2<u32>((a.x >> n) | (a.y << (32u - n)), a.y >> n);
}

fn splitmix64(x : vec2<u32>) -> vec2<u32> {
  var z = add64(x, vec2<u32>(0x7f4a7c15u, 0x9e3779b9u));
  z = mul64(xor64(z, shr64(z, 30u)), vec2<u32>(0x1ce4e5b9u, 0xbf58476du));
  z = mul64(xor64(z, shr64(z, 27u)), vec2<u32>(0x133111ebu, 0x94d049bbu));
  return xor64(z, shr64(z, 31u));
}

fn model_seed(userSeed : vec2<u32>, coordinate : vec2<u32>) -> vec2<u32> {
  return splitmix64(xor64(splitmix64(userSeed), splitmix64(coordinate)));
}
`;

export function makeEvaluatorWGSL(
  variant: KernelVariant,
  wgSize: number,
  memWords: number,
): string {
  const memBytes = memWords * 4;

  const placement =
    variant === 'private'
      ? /* wgsl */ `
var<private> tape : array<u32, ${memWords}>;

fn getb(i : i32) -> u32 {
  let u = u32(i);
  return (tape[u >> 2u] >> ((u & 3u) << 3u)) & 0xffu;
}

fn setb(i : i32, v : u32) {
  let u = u32(i);
  let shift = (u & 3u) << 3u;
  let word = tape[u >> 2u];
  tape[u >> 2u] = (word & ~(0xffu << shift)) | ((v & 0xffu) << shift);
}
`
      : variant === 'workgroup'
        ? /* wgsl */ `
var<workgroup> tapes : array<u32, ${memWords * wgSize}>;
var<private> lbase : u32;

fn getb(i : i32) -> u32 {
  let u = u32(i);
  return (tapes[lbase + (u >> 2u)] >> ((u & 3u) << 3u)) & 0xffu;
}

fn setb(i : i32, v : u32) {
  let u = u32(i);
  let shift = (u & 3u) << 3u;
  let at = lbase + (u >> 2u);
  let word = tapes[at];
  tapes[at] = (word & ~(0xffu << shift)) | ((v & 0xffu) << shift);
}
`
        : variant === 'workgroup-i'
          ? /* wgsl */ `
// Interleaved threadgroup layout: word w of thread t lives at w*WG + t, so
// SIMD-group lanes touching the same word index hit consecutive banks.
var<workgroup> tapes : array<u32, ${memWords * wgSize}>;
var<private> lidx : u32;

fn getb(i : i32) -> u32 {
  let u = u32(i);
  return (tapes[(u >> 2u) * ${wgSize}u + lidx] >> ((u & 3u) << 3u)) & 0xffu;
}

fn setb(i : i32, v : u32) {
  let u = u32(i);
  let shift = (u & 3u) << 3u;
  let at = (u >> 2u) * ${wgSize}u + lidx;
  let word = tapes[at];
  tapes[at] = (word & ~(0xffu << shift)) | ((v & 0xffu) << shift);
}
`
          : /* wgsl */ `
var<private> sbase : u32;

fn getb(i : i32) -> u32 {
  let u = u32(i);
  return (pairs[sbase + (u >> 2u)] >> ((u & 3u) << 3u)) & 0xffu;
}

fn setb(i : i32, v : u32) {
  let u = u32(i);
  let shift = (u & 3u) << 3u;
  let at = sbase + (u >> 2u);
  let word = pairs[at];
  pairs[at] = (word & ~(0xffu << shift)) | ((v & 0xffu) << shift);
}
`;

  const prologue =
    variant === 'private'
      ? /* wgsl */ `
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { tape[w] = pairs[pairBase + w]; }
`
      : variant === 'workgroup'
        ? /* wgsl */ `
  lbase = lid.x * ${memWords}u;
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { tapes[lbase + w] = pairs[pairBase + w]; }
`
        : variant === 'workgroup-i'
          ? /* wgsl */ `
  lidx = lid.x;
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { tapes[w * ${wgSize}u + lidx] = pairs[pairBase + w]; }
`
          : /* wgsl */ `
  sbase = pairBase;
`;

  const epilogue =
    variant === 'private'
      ? /* wgsl */ `
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { pairs[pairBase + w] = tape[w]; }
`
      : variant === 'workgroup'
        ? /* wgsl */ `
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { pairs[pairBase + w] = tapes[lbase + w]; }
`
        : variant === 'workgroup-i'
          ? /* wgsl */ `
  for (var w = 0u; w < ${memWords}u; w = w + 1u) { pairs[pairBase + w] = tapes[w * ${wgSize}u + lidx]; }
`
          : '';

  return /* wgsl */ `
struct Params {
  nPairs      : u32,
  mem         : u32, // 2 * tapeLen bytes; must equal the baked ${memBytes}
  stepLimit   : u32,
  chunkSteps  : u32,
  mutNum      : u32, // 0 disables in-shader mutation
  chunkIndex  : u32, // 0 initializes state and applies mutation
  userSeedLo  : u32,
  userSeedHi  : u32,
  epochLo     : u32,
  epochHi     : u32,
  nPrograms   : u32,
  _pad        : u32,
}

struct PairState {
  pc     : i32,
  head0  : i32,
  head1  : i32,
  done   : u32,
  halt   : u32,
  steps  : u32,
  ops    : u32,
  _pad   : u32,
}

@group(0) @binding(0) var<storage, read_write> pairs : array<u32>;
@group(0) @binding(1) var<storage, read_write> state : array<PairState>;
@group(0) @binding(2) var<uniform> params : Params;

const MEM : i32 = ${memBytes};
const MASK : i32 = ${memBytes - 1};

${U64_HELPERS}
${placement}

@compute @workgroup_size(${wgSize})
fn epoch_chunk(
  @builtin(global_invocation_id) gid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let pair = gid.x;
  if (pair >= params.nPairs) { return; }

  let pairBase = pair * ${memWords}u;

  var st : PairState;
  if (params.chunkIndex == 0u) {
    st.pc = 0; st.head0 = 0; st.head1 = 0;
    st.done = 0u; st.halt = 2u; st.steps = 0u; st.ops = 0u;
  } else {
    st = state[pair];
    if (st.done != 0u) { return; }
  }
${prologue}
  // CuBFF mutates the concatenated pair before the first step executes.
  if (params.chunkIndex == 0u && params.mutNum != 0u) {
    let epochSeed = model_seed(
      vec2<u32>(params.userSeedLo, params.userSeedHi),
      vec2<u32>(params.epochLo, params.epochHi),
    );
    let base = mul64(
      add64(
        mul64(vec2<u32>(params.nPrograms, 0u), epochSeed),
        vec2<u32>(pair, 0u),
      ),
      vec2<u32>(${memBytes}u, 0u),
    );
    for (var i = 0u; i < ${memBytes}u; i = i + 1u) {
      let rng = splitmix64(add64(base, vec2<u32>(i, 0u)));
      let probability = shr64(rng, 8u).x & 0x3fffffffu;
      if (probability < params.mutNum) {
        setb(i32(i), rng.x & 0xffu);
      }
    }
  }

  var pc = st.pc;
  var head0 = st.head0;
  var head1 = st.head1;
  var steps = st.steps;
  var ops = st.ops;
  var halt = st.halt;
  var done = 0u;

  let end = min(steps + params.chunkSteps, params.stepLimit);

  loop {
    if (steps >= end) { break; }
    head0 = head0 & MASK;
    head1 = head1 & MASK;

    let cmd = getb(pc);
    var did = true;

    switch cmd {
      case 60u: { head0 = head0 - 1; }                       // '<'
      case 62u: { head0 = head0 + 1; }                       // '>'
      case 123u: { head1 = head1 - 1; }                      // '{'
      case 125u: { head1 = head1 + 1; }                      // '}'
      case 43u: { setb(head0, (getb(head0) + 1u) & 0xffu); } // '+'
      case 45u: { setb(head0, (getb(head0) - 1u) & 0xffu); } // '-'
      case 46u: { setb(head1, getb(head0)); }                // '.'
      case 44u: { setb(head0, getb(head1)); }                // ','
      case 91u: {                                            // '['
        if (getb(head0) == 0u) {
          var depth = 1;
          pc = pc + 1;
          loop {
            if (pc >= MEM || depth <= 0) { break; }
            let b = getb(pc);
            if (b == 93u) { depth = depth - 1; }
            else if (b == 91u) { depth = depth + 1; }
            pc = pc + 1;
          }
          pc = pc - 1;
          if (depth != 0) { pc = MEM; halt = 4u; }
        }
      }
      case 93u: {                                            // ']'
        if (getb(head0) != 0u) {
          var depth = 1;
          pc = pc - 1;
          loop {
            if (pc < 0 || depth <= 0) { break; }
            let b = getb(pc);
            if (b == 93u) { depth = depth + 1; }
            else if (b == 91u) { depth = depth - 1; }
            pc = pc - 1;
          }
          pc = pc + 1;
          if (depth != 0) { pc = -1; halt = 4u; }
        }
      }
      default: { did = false; }
    }

    if (did) { ops = ops + 1u; }
    steps = steps + 1u;
    if (pc < 0) {
      if (halt != 4u) { halt = 1u; }
      done = 1u;
      break;
    }
    pc = pc + 1;
    if (pc >= MEM) {
      if (halt != 4u) { halt = 1u; }
      done = 1u;
      break;
    }
  }

  if (done == 0u && steps >= params.stepLimit) {
    done = 1u; // halt stays 2: step limit
  }
${epilogue}
  st.pc = pc; st.head0 = head0; st.head1 = head1;
  st.done = done; st.halt = halt; st.steps = steps; st.ops = ops;
  state[pair] = st;
}
`;
}

/** Exact CuBFF permutation over a GPU-resident index buffer. */
export function makeResidentPermutationWGSL(): string {
  return /* wgsl */ `
struct ResidentParams {
  nTapes     : u32,
  tapeWords  : u32,
  nPairs     : u32,
  _pad0      : u32,
  epochLo    : u32,
  epochHi    : u32,
  userSeedLo : u32,
  userSeedHi : u32,
}

@group(0) @binding(0) var<storage, read_write> permutation : array<u32>;
@group(0) @binding(1) var<uniform> params : ResidentParams;
@group(0) @binding(2) var<storage, read_write> swapTargets : array<u32>;

${U64_HELPERS}

// Exact remainder of a 64-bit value by a non-zero 32-bit divisor. Consume one
// leading 4-bit digit and four 15-bit digits. After every step remainder is
// below the divisor; CLR's maximum divisor is 2^17, so multiplying it by 2^15
// and adding a digit still fits exactly in u32.
fn mod64by32(value : vec2<u32>, divisor : u32) -> u32 {
  var remainder = (value.y >> 28u) % divisor;
  remainder = (remainder * 32768u + ((value.y >> 13u) & 32767u)) % divisor;
  let crossing = ((value.y & 8191u) << 2u) | (value.x >> 30u);
  remainder = (remainder * 32768u + crossing) % divisor;
  remainder = (remainder * 32768u + ((value.x >> 15u) & 32767u)) % divisor;
  remainder = (remainder * 32768u + (value.x & 32767u)) % divisor;
  return remainder;
}

@compute @workgroup_size(64)
fn init_permutation(@builtin(global_invocation_id) gid : vec3<u32>) {
  let index = gid.x;
  if (index >= params.nTapes) { return; }
  permutation[index] = index;
  let epoch = vec2<u32>(params.epochLo, params.epochHi);
  let userSeed = vec2<u32>(params.userSeedLo, params.userSeedHi);
  let epochBase = mul64(epoch, vec2<u32>(params.nTapes, 0u));
  let coordinate = add64(epochBase, vec2<u32>(index, 0u));
  let random = splitmix64(model_seed(userSeed, coordinate));
  swapTargets[index] = mod64by32(random, index + 1u);
}

// CuBFF uses an exact Fisher-Yates swap sequence. Target generation above is
// independent and parallel; the swaps remain serial and run in source order.
@compute @workgroup_size(1)
fn shuffle_epoch(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x != 0u) { return; }
  var count = params.nTapes;
  loop {
    if (count == 0u) { break; }
    count = count - 1u;
    let other = swapTargets[count];
    let value = permutation[count];
    permutation[count] = permutation[other];
    permutation[other] = value;
  }
}
`;
}

/** Gather and scatter complete tape pairs without leaving GPU memory. */
export function makeResidentPairingWGSL(tapeWords: number, wgSize: number): string {
  const pairWords = tapeWords * 2;
  return /* wgsl */ `
struct ResidentParams {
  nTapes     : u32,
  tapeWords  : u32,
  nPairs     : u32,
  _pad0      : u32,
  epochLo    : u32,
  epochHi    : u32,
  userSeedLo : u32,
  userSeedHi : u32,
}

@group(0) @binding(0) var<storage, read_write> population : array<u32>;
@group(0) @binding(1) var<storage, read> permutation : array<u32>;
@group(0) @binding(2) var<storage, read_write> pairs : array<u32>;
@group(0) @binding(3) var<uniform> params : ResidentParams;

@compute @workgroup_size(${wgSize})
fn gather_pairs(@builtin(global_invocation_id) gid : vec3<u32>) {
  let pair = gid.x;
  if (pair >= params.nPairs) { return; }
  let tapeA = permutation[pair * 2u] * ${tapeWords}u;
  let tapeB = permutation[pair * 2u + 1u] * ${tapeWords}u;
  let output = pair * ${pairWords}u;
  for (var word = 0u; word < ${tapeWords}u; word = word + 1u) {
    pairs[output + word] = population[tapeA + word];
    pairs[output + ${tapeWords}u + word] = population[tapeB + word];
  }
}

@compute @workgroup_size(${wgSize})
fn scatter_pairs(@builtin(global_invocation_id) gid : vec3<u32>) {
  let pair = gid.x;
  if (pair >= params.nPairs) { return; }
  let tapeA = permutation[pair * 2u] * ${tapeWords}u;
  let tapeB = permutation[pair * 2u + 1u] * ${tapeWords}u;
  let input = pair * ${pairWords}u;
  for (var word = 0u; word < ${tapeWords}u; word = word + 1u) {
    population[tapeA + word] = pairs[input + word];
    population[tapeB + word] = pairs[input + ${tapeWords}u + word];
  }
}
`;
}

export const CLEAR_COUNTERS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> counters : array<atomic<u32>>;

@compute @workgroup_size(1)
fn clear_counters() {
  atomicStore(&counters[0], 0u);
  atomicStore(&counters[1], 0u);
  atomicStore(&counters[2], 0u);
  atomicStore(&counters[3], 0u);
}
`;

export function makeResidentReductionWGSL(wgSize: number): string {
  return /* wgsl */ `
struct PairState {
  pc     : i32,
  head0  : i32,
  head1  : i32,
  done   : u32,
  halt   : u32,
  steps  : u32,
  ops    : u32,
  _pad   : u32,
}

struct ResidentParams {
  nTapes     : u32,
  tapeWords  : u32,
  nPairs     : u32,
  _pad0      : u32,
  epochLo    : u32,
  epochHi    : u32,
  userSeedLo : u32,
  userSeedHi : u32,
}

@group(0) @binding(0) var<storage, read> state : array<PairState>;
@group(0) @binding(1) var<storage, read_write> counters : array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params : ResidentParams;

@compute @workgroup_size(${wgSize})
fn reduce_counters(@builtin(global_invocation_id) gid : vec3<u32>) {
  let pair = gid.x;
  if (pair >= params.nPairs) { return; }
  let item = state[pair];
  atomicAdd(&counters[0], item.ops);
  if (item.halt == 1u) {
    atomicAdd(&counters[1], 1u);
  } else if (item.halt == 2u) {
    atomicAdd(&counters[2], 1u);
  } else {
    atomicAdd(&counters[3], 1u);
  }
}
`;
}

/** Standalone kernel: out[i] = splitmix64(seed + i), for host verification. */
export const SELFTEST_WGSL = /* wgsl */ `
struct TestParams { count : u32, _pad : u32, seedLo : u32, seedHi : u32 }
@group(0) @binding(0) var<storage, read_write> out : array<vec2<u32>>;
@group(0) @binding(1) var<uniform> params : TestParams;

${U64_HELPERS}

@compute @workgroup_size(64)
fn selftest(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  out[i] = splitmix64(add64(vec2<u32>(params.seedLo, params.seedHi), vec2<u32>(i, 0u)));
}
`;

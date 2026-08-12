/* CuBFF BFF primordial soup — browser C core.
 * Copyright 2024 Google LLC
 * CLR modifications Copyright (C) 2026 Alex Borger
 * SPDX-License-Identifier: Apache-2.0
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
 * Upstream: https://github.com/paradigms-of-intelligence/cubff
 * Revision: 8e3f774df03d1c895ec6ee0d21b6897ecea46806
 * Sources: bff_noheads.cu and common_language.h
 *
 * Modified for CLR in 2026. CLR adaptations: halt-cause counters,
 * runtime 32/64/128-byte tapes,
 * phase-separated epoch entry points, packed-pair execution for sharding, and
 * a freestanding memcpy. Complete population bytes and executed-operation
 * counts are validated against an unmodified CPU build of the pinned source.
 *
 * Build this browser version with `npm run build:wasm`.
 */
#include <stdint.h>
#include <stddef.h>
#ifdef __wasm__
/* Browser adaptation 1/4: the freestanding target has no libc, so provide the
   memcpy used to glue and split pairs locally. */
static void *memcpy(void *dest, const void *src, unsigned long n) {
    unsigned char *d = dest;
    const unsigned char *s = src;
    while (n--) *d++ = *s++;
    return dest;
}
#else
#include <string.h>
#endif

/* The original implementations fix tapes at 64 bytes. The reactor also offers
 * 32 and 128, so TAPE and its derived values are runtime configuration. The
 * 64-byte setting remains the reference-compatible one. */
#define MAX_TAPE 128

static int TAPE = 64;
static int MEM = 128;
static int MASK = 127;

void configure(int tape_len) {
    TAPE = tape_len;
    MEM = 2 * tape_len;
    MASK = MEM - 1;
}

/* how the last evaluate() ended: 1 pointer off tape, 2 step limit,
   4 unmatched bracket */
static int halt_code = 0;
int last_halt(void) { return halt_code; }

/* ---- CuBFF's counter-derived random stream -------------------------------
 *
 * Every random value is a pure function of the user seed and its model-level
 * coordinates. It therefore does not depend on telemetry, worker count or the
 * order in which shards finish. Seed zero is a real seed, not an alias.
 */
static uint64_t user_seed = 0;

static inline uint64_t splitmix64(uint64_t seed) {
    uint64_t z = seed + 0x9e3779b97f4a7c15ULL;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static inline uint64_t model_seed(uint64_t coordinate) {
    return splitmix64(splitmix64(user_seed) ^ splitmix64(coordinate));
}

void set_seed(uint64_t seed) { user_seed = seed; }

/* ---- the interpreter ---- *
 * Returns the number of non-noop operations executed. `tape` is 2 * TAPE bytes
 * and is modified in place. Inactive bytes still consume evaluator steps.
 */
size_t evaluate(uint8_t *tape, size_t stepcount) {
    int pc = 0, head0 = 0, head1 = 0;
    size_t nskip = 0, i = 0;
    halt_code = 2; /* step limit, unless something below says otherwise */

    while (i < stepcount) {
        head0 &= MASK;
        head1 &= MASK;

        uint8_t cmd = tape[pc];
        int did = 1;

        switch (cmd) {
        case '<': head0--; break;
        case '>': head0++; break;
        case '{': head1--; break;
        case '}': head1++; break;
        case '+': tape[head0]++; break;
        case '-': tape[head0]--; break;
        case '.': tape[head1] = tape[head0]; break;
        case ',': tape[head0] = tape[head1]; break;
        case '[':
            if (tape[head0] == 0) {
                int depth = 1;
                pc++;
                while (pc < MEM && depth > 0) {
                    if (tape[pc] == ']') depth--;
                    else if (tape[pc] == '[') depth++;
                    pc++;
                }
                pc--;
                if (depth != 0) { pc = MEM; halt_code = 4; }
            }
            break;
        case ']':
            if (tape[head0] != 0) {
                int depth = 1;
                pc--;
                while (pc >= 0 && depth > 0) {
                    if (tape[pc] == ']') depth++;
                    else if (tape[pc] == '[') depth--;
                    pc--;
                }
                pc++;
                if (depth != 0) { pc = -1; halt_code = 4; }
            }
            break;
        default: did = 0; break;
        }

        if (!did) nskip++;
        i++;
        if (pc < 0) { if (halt_code != 4) halt_code = 1; break; }
        pc++;
        if (pc >= MEM) { if (halt_code != 4) halt_code = 1; break; }
    }
    return i - nskip;
}

/* Fill the soup exactly as CuBFF's InitPrograms does. */
void initialize(uint8_t *soup, uint32_t n_programs) {
    uint64_t initial_seed = model_seed(0);
    uint64_t population_bytes = (uint64_t)n_programs * (uint64_t)TAPE;
    for (uint64_t k = 0; k < population_bytes; k++) {
        soup[k] = (uint8_t)(splitmix64(population_bytes * initial_seed + k) & 0xff);
    }
}

/* CuBFF's Fisher-Yates permutation for one epoch. */
void shuffle(uint32_t *idx, uint32_t n_programs, uint64_t epoch) {
    for (uint32_t i = 0; i < n_programs; i++) idx[i] = i;
    for (uint32_t i = n_programs; i-- > 0;) {
        uint64_t coordinate = epoch * (uint64_t)n_programs + i;
        uint32_t j = (uint32_t)(splitmix64(model_seed(coordinate)) % (i + 1));
        uint32_t t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
}

/* CuBFF mutates the concatenated pair before it is evaluated. */
static void mutate_pair(uint8_t *pair, uint32_t pair_index,
                        uint32_t n_programs, uint64_t epoch,
                        uint32_t mut_num) {
    uint64_t epoch_seed = model_seed(epoch);
    uint64_t base = ((uint64_t)n_programs * epoch_seed + pair_index) * (uint64_t)MEM;
    for (uint32_t i = 0; i < (uint32_t)MEM; i++) {
        uint64_t rng = splitmix64(base + i);
        uint32_t probability = (uint32_t)((rng >> 8) & ((1ULL << 30) - 1));
        if (probability < mut_num) {
            pair[i] = (uint8_t)(rng & 0xff);
        }
    }
}

/* ---- one epoch over the whole soup ----
 *
 * Shuffle the programs, pair them off, mutate each concatenated pair, then run
 * split(exec(AB)). This is the unsharded oracle for the worker implementation.
 *
 * soup:        n_programs * TAPE bytes
 * idx:         scratch buffer of n_programs uint32_t
 * mut_num:     mutation probability numerator, denominator is 1<<30
 * Returns total ops executed this epoch (the paper's "computation" measure).
 */
uint64_t run_epoch(uint8_t *soup, uint32_t n_programs, uint32_t *idx,
                   uint32_t mut_num, size_t stepcount, uint32_t *counts,
                   uint64_t epoch) {
    shuffle(idx, n_programs, epoch);

    uint64_t total_ops = 0;
    uint8_t tape[2 * MAX_TAPE];

    for (uint32_t p = 0; p + 1 < n_programs; p += 2) {
        uint8_t *a = soup + (size_t)idx[p] * TAPE;
        uint8_t *b = soup + (size_t)idx[p + 1] * TAPE;
        memcpy(tape, a, TAPE);
        memcpy(tape + TAPE, b, TAPE);
        mutate_pair(tape, p / 2, n_programs, epoch, mut_num);
        total_ops += evaluate(tape, stepcount);
        counts[halt_code == 1 ? 0 : halt_code == 2 ? 1 : 2]++;
        memcpy(a, tape, TAPE);
        memcpy(b, tape + TAPE, TAPE);
    }
    return total_ops;
}

/* ---- one shard's slice of already-glued pairs ----
 *
 * The caller gathers the pairs it owns into one packed buffer, so shards need
 * no shared memory and no coordination. The global pair offset preserves
 * CuBFF's counter-derived mutation stream across any shard partition.
 * `counts` is three uint32: pointer off tape, step limit, unmatched bracket.
 */
uint64_t run_packed(uint8_t *pairs, uint32_t n_pairs, uint32_t *counts,
                    size_t stepcount, uint32_t pair_offset,
                    uint32_t n_programs, uint64_t epoch,
                    uint32_t mut_num) {
    uint64_t total_ops = 0;
    for (uint32_t p = 0; p < n_pairs; p++) {
        uint8_t *pair = pairs + (size_t)p * MEM;
        mutate_pair(pair, pair_offset + p, n_programs, epoch, mut_num);
        total_ops += evaluate(pair, stepcount);
        counts[halt_code == 1 ? 0 : halt_code == 2 ? 1 : 2]++;
    }
    return total_ops;
}

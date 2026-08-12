/* Brainfuck-Life primordial soup — CLR V1 browser C core.
 * Copyright (C) Johannes Martin and BrainFuckLife contributors
 * CLR modifications Copyright (C) 2026 Alex Borger
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. See the repository's LICENSE file for the complete terms.
 *
 * Original C port: https://github.com/mathelehrer/BrainFuckLife
 * Pinned fork: https://github.com/alexcybernetic/BrainFuckLife
 * Pinned revision: 9d2638361a0ae5519dfe56539059cfec094cbd6e
 * Source: bff/soup.c
 *
 * Modified for CLR in 2026. CLR adaptations: halt-cause counters,
 * runtime 32/64/128-byte tapes,
 * phase-separated shuffle/evaluation/mutation entry points for sharding, and
 * a freestanding memcpy. This file intentionally shares no C source, headers,
 * evaluator helpers, RNG state, or lifecycle code with cubff_soup.c.
 *
 * The 64-byte tape setting is reference-compatible. Runtime tape lengths of
 * 32 and 128 bytes are reactor extensions using the same interpreter rules.
 */
#include <stdint.h>
#include <stddef.h>

#ifdef __wasm__
static void *memcpy(void *dest, const void *src, unsigned long n) {
    unsigned char *d = dest;
    const unsigned char *s = src;
    while (n--) *d++ = *s++;
    return dest;
}
#else
#include <string.h>
#endif

#define MAX_TAPE 128

static int TAPE = 64;
static int MEM = 128;
static int MASK = 127;

void configure(int tape_len) {
    TAPE = tape_len;
    MEM = 2 * tape_len;
    MASK = MEM - 1;
}

static int halt_code = 0;
int last_halt(void) { return halt_code; }

/* Brainfuck-Life's stateful xorshift64* stream. Seed zero aliases the source
 * implementation's fixed non-zero initial state. */
static uint64_t rng_state = 0x853c49e6748fea9bULL;

static inline uint64_t rnd64(void) {
    uint64_t x = rng_state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng_state = x;
    return x * 2685821657736338717ULL;
}

void set_seed(uint64_t seed) {
    rng_state = seed ? seed : 0x853c49e6748fea9bULL;
}

/* Returns the number of active instructions executed. Inactive bytes still
 * consume evaluator steps, matching the source implementation. */
size_t evaluate(uint8_t *tape, size_t stepcount) {
    int pc = 0, head0 = 0, head1 = 0;
    size_t nskip = 0, i = 0;
    halt_code = 2;

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

/* Source lifecycle: one rnd64 draw per population byte, using bits 40-47. */
void initialize(uint8_t *soup, uint32_t n_programs) {
    uint64_t population_bytes = (uint64_t)n_programs * (uint64_t)TAPE;
    for (uint64_t i = 0; i < population_bytes; i++) {
        soup[i] = (uint8_t)(rnd64() >> 40);
    }
}

/* Source Fisher-Yates loop. The epoch argument is ABI-only: Brainfuck-Life's
 * shuffle consumes its persistent RNG stream instead of deriving coordinates. */
void shuffle(uint32_t *idx, uint32_t n_programs, uint64_t epoch) {
    (void)epoch;
    for (uint32_t i = 0; i < n_programs; i++) idx[i] = i;
    for (uint32_t i = n_programs - 1; i > 0; i--) {
        uint32_t j = (uint32_t)(rnd64() % (i + 1));
        uint32_t t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
}

/* Source mutation pass: no draws at all for mut_num zero; otherwise one test
 * draw per byte and one additional replacement draw only after a hit. */
void mutate_soup(uint8_t *soup, uint32_t n_programs, uint32_t mut_num) {
    if (mut_num == 0) return;
    uint64_t population_bytes = (uint64_t)n_programs * (uint64_t)TAPE;
    for (uint64_t i = 0; i < population_bytes; i++) {
        if ((uint32_t)(rnd64() >> 34) < mut_num) {
            soup[i] = (uint8_t)(rnd64() >> 40);
        }
    }
}

/* Unsharded reference lifecycle: shuffle, evaluate pairs, then mutate the
 * resulting population. */
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
        total_ops += evaluate(tape, stepcount);
        counts[halt_code == 1 ? 0 : halt_code == 2 ? 1 : 2]++;
        memcpy(a, tape, TAPE);
        memcpy(b, tape + TAPE, TAPE);
    }
    mutate_soup(soup, n_programs, mut_num);
    return total_ops;
}

/* Shards evaluate already-gathered pairs only. RNG and mutation remain owned
 * by the coordinator so scheduling and worker count cannot alter the source
 * RNG trajectory. Extra arguments retain the common browser ABI. */
uint64_t run_packed(uint8_t *pairs, uint32_t n_pairs, uint32_t *counts,
                    size_t stepcount, uint32_t pair_offset,
                    uint32_t n_programs, uint64_t epoch,
                    uint32_t mut_num) {
    (void)pair_offset;
    (void)n_programs;
    (void)epoch;
    (void)mut_num;
    uint64_t total_ops = 0;
    for (uint32_t p = 0; p < n_pairs; p++) {
        uint8_t *pair = pairs + (size_t)p * MEM;
        total_ops += evaluate(pair, stepcount);
        counts[halt_code == 1 ? 0 : halt_code == 2 ? 1 : 2]++;
    }
    return total_ops;
}

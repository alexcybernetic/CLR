#include <stddef.h>
#include <stdint.h>

#include "brotli/encode.h"

typedef struct {
    uintptr_t next;
    uintptr_t limit;
} Arena;

static void *arena_alloc(void *opaque, size_t size) {
    Arena *arena = (Arena *)opaque;
    uintptr_t aligned = (arena->next + 15u) & ~(uintptr_t)15u;
    if (aligned > arena->limit || size > arena->limit - aligned) return 0;
    arena->next = aligned + size;
    return (void *)aligned;
}

static void arena_free(void *opaque, void *address) {
    (void)opaque;
    (void)address;
}

size_t brotli_max_compressed_size(size_t input_size) {
    return BrotliEncoderMaxCompressedSize(input_size);
}

/* Exact order measurement used by the paper: Brotli 1.1.0, quality 2. */
size_t brotli_compress(const uint8_t *input, size_t input_size,
                       uint8_t *output, size_t output_capacity,
                       uintptr_t heap_start, uintptr_t heap_limit) {
    Arena arena = {heap_start, heap_limit};
    BrotliEncoderState *state =
        BrotliEncoderCreateInstance(arena_alloc, arena_free, &arena);
    if (!state) return 0;

    if (!BrotliEncoderSetParameter(state, BROTLI_PARAM_QUALITY, 2) ||
        !BrotliEncoderSetParameter(state, BROTLI_PARAM_LGWIN, 24) ||
        !BrotliEncoderSetParameter(state, BROTLI_PARAM_MODE,
                                   BROTLI_MODE_GENERIC) ||
        !BrotliEncoderSetParameter(state, BROTLI_PARAM_SIZE_HINT,
                                   (uint32_t)input_size)) {
        BrotliEncoderDestroyInstance(state);
        return 0;
    }

    size_t available_in = input_size;
    const uint8_t *next_in = input;
    size_t available_out = output_capacity;
    uint8_t *next_out = output;
    BROTLI_BOOL ok = BrotliEncoderCompressStream(
        state, BROTLI_OPERATION_FINISH, &available_in, &next_in,
        &available_out, &next_out, 0);
    BROTLI_BOOL finished = BrotliEncoderIsFinished(state);
    BrotliEncoderDestroyInstance(state);

    if (!ok || !finished || available_in != 0) return 0;
    return output_capacity - available_out;
}

import { brotliCompressedSize } from './brotli.ts';

export interface OrderMeasurement {
  highOrder: number;
  byteOrder: number;
  h0: number;
  bpb: number;
  compressed: number;
  raw: number;
}

/**
 * Order visible in the marginal byte-frequency distribution.
 *
 * H0 is at most 8 bits/byte for a 256-value alphabet. Subtracting it from
 * that uniform maximum makes this component increase as the distribution
 * becomes more concentrated, matching the direction of high-order entropy.
 */
export function byteFrequencyOrder(h0: number): number {
  // Entropy cannot exceed 8 mathematically; clamp only possible floating-point
  // overshoot so the displayed order component retains its defined range.
  return Math.max(0, 8 - h0);
}

/**
 * Measure the complete soup with Brotli 1.1.0 at quality 2, matching the
 * paper's order measurement. The caller supplies an immutable snapshot so the
 * synchronous compressor cannot observe a later epoch through shared memory.
 */
export async function measureOrder(fullSoup: Uint8Array, h0: number): Promise<OrderMeasurement> {
  const raw = fullSoup.length;
  if (raw === 0) {
    return { highOrder: 0, byteOrder: 0, h0, bpb: 0, compressed: 0, raw };
  }

  const compressed = brotliCompressedSize(fullSoup);
  const bpb = (compressed * 8) / raw;
  return {
    highOrder: h0 - bpb,
    byteOrder: byteFrequencyOrder(h0),
    h0,
    bpb,
    compressed,
    raw,
  };
}

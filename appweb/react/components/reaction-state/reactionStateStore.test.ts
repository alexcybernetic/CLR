import { describe, expect, it } from 'vitest';

import { ReactionStateStore } from './reactionStateStore.ts';

describe('ReactionStateStore', () => {
  it('copies runtime motif bytes and clears derived state at a run boundary', () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const store = new ReactionStateStore({ nTapes: 4096, tapeLen: 64 });

    store.acceptSnapshot({
      nTapes: 4096,
      tapeLen: 64,
      epochsPerSec: 3.5,
      metrics: {
        distinctBytes: 200,
        uniqueTapes: 3000,
        largestLineage: 4,
        motifTotal: 100,
        motifs: [{ bytes: sourceBytes, count: 12, carriers: 2, copiedBytes: 31.5 }],
      },
      stats: { execs: 20, halts: [0, 3, 5, 0, 12] },
    });

    const accepted = store.getSnapshot();
    sourceBytes[0] = 99;
    expect(accepted.telemetry.motifs[0]?.bytes[0]).toBe(1);
    expect(ArrayBuffer.isView(accepted.telemetry.motifs[0]?.bytes)).toBe(false);
    expect(accepted.telemetry.terminations).toEqual({
      interactions: 20,
      pointerOffTape: 3,
      stepLimit: 5,
      unmatchedBracket: 12,
    });

    store.reset({ nTapes: 1024, tapeLen: 32 });
    expect(store.getSnapshot()).toMatchObject({
      config: { nTapes: 1024, tapeLen: 32 },
      telemetry: {
        distinctBytes: null,
        motifs: [],
        terminations: { interactions: 0 },
      },
    });
  });
});

export interface RunCumulative {
  epochs: number;
  interactions: number;
  steps: number;
  computeMs: number;
  halts: number[];
}

export function emptyCumulative(): RunCumulative {
  return { epochs: 0, interactions: 0, steps: 0, computeMs: 0, halts: [0, 0, 0, 0, 0] };
}

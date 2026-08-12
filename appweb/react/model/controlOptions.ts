import type { ComputePath } from '../../../engine/src/protocol.ts';
import {
  SUPPORTED_STEP_LIMITS,
  SUPPORTED_TAPE_COUNTS,
  SUPPORTED_TAPE_LENGTHS,
  type ReactorEngine,
} from '../../../engine/src/soup.ts';

export interface ControlOption<T extends string | number> {
  value: T;
  label: string;
}

export const ENGINE_OPTIONS = [
  { value: 'brainfuck-life', label: 'V1' },
  { value: 'cubff', label: 'V2' },
] as const satisfies readonly ControlOption<ReactorEngine>[];

export const COMPUTE_PATH_OPTIONS = [
  { value: 'wasm', label: 'CPU (Wasm)' },
  { value: 'webgpu', label: 'GPU (WebGPU)' },
] as const satisfies readonly ControlOption<ComputePath>[];

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'] as const;

function powerOfTwoOption(value: number): ControlOption<number> {
  const exponent = Math.log2(value);
  if (!Number.isInteger(exponent)) throw new Error(`control value ${value} is not a power of two`);
  const superscript = [...String(exponent)]
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)])
    .join('');
  return { value, label: `2${superscript} = ${value}` };
}

export const TAPE_COUNT_OPTIONS = SUPPORTED_TAPE_COUNTS.map(powerOfTwoOption);

export const TAPE_LENGTH_OPTIONS = SUPPORTED_TAPE_LENGTHS.map((value) => ({
  value,
  label: String(value),
})) satisfies readonly ControlOption<number>[];

export const STEP_LIMIT_OPTIONS = SUPPORTED_STEP_LIMITS.map(powerOfTwoOption);

export const EXECUTION_RATE_OPTIONS = [
  { value: 0, label: 'max' },
  { value: 10, label: '10' },
  { value: 1, label: '1' },
] as const satisfies readonly ControlOption<number>[];

export type SoupViewMode = 'ops' | 'value' | 'counts';
export const SOUP_VIEW_OPTIONS = [
  { value: 'ops', label: 'operators' },
  { value: 'value', label: 'raw bytes' },
  { value: 'counts', label: 'tape counts' },
] as const satisfies readonly ControlOption<SoupViewMode>[];

export type SampleMode = 'random' | 'busiest' | 'pick';
export const SAMPLE_MODE_OPTIONS = [
  { value: 'random', label: 'random' },
  { value: 'busiest', label: 'busiest of 200' },
  { value: 'pick', label: 'pick' },
] as const satisfies readonly ControlOption<SampleMode>[];

export const SAMPLER_RATE_OPTIONS = [0.1, 0.5, 1, 5].map((value) => ({
  value,
  label: String(value),
})) satisfies readonly ControlOption<number>[];

export function workerOptions(reportedWorkers: number, autoWorkers: number): ControlOption<string>[] {
  return [
    { value: 'auto', label: `auto (${autoWorkers})` },
    ...Array.from({ length: reportedWorkers }, (_, index) => {
      const count = index + 1;
      return { value: String(count), label: String(count) };
    }),
  ];
}

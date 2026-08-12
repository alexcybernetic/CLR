import type {
  ComputePath,
  MeasurementPayload,
} from '../../engine/src/protocol.ts';
import type { SoupConfig } from '../../engine/src/soup.ts';
import type { SnapshotMessage } from './coordinatorClient.ts';

export interface ExpectedRunProtocolState {
  runId: string;
  configRevision: number;
  config: Readonly<SoupConfig>;
  computePath: ComputePath;
}

export type RunProtocolDecision =
  | { kind: 'accept' }
  | { kind: 'ignore'; reason: 'replaced-run' | 'stale-revision' }
  | { kind: 'fatal'; message: string };

const CONFIG_KEYS: readonly (keyof SoupConfig)[] = [
  'engine',
  'nTapes',
  'tapeLen',
  'maxSteps',
  'mutationRate',
  'headPolicy',
  'noMatch',
  'seed',
];

export function configurationDifferences(
  applied: Readonly<SoupConfig>,
  requested: Readonly<SoupConfig>,
): string[] {
  return CONFIG_KEYS.filter((key) => applied[key] !== requested[key]).map(
    (key) => `${key}: requested ${requested[key]}, applied ${applied[key]}`,
  );
}

function inspectIdentityAndRevision(
  payload: Pick<MeasurementPayload, 'runId' | 'configRevision'>,
  expected: ExpectedRunProtocolState,
  futureRevisionMessage: (received: number, requested: number) => string,
): RunProtocolDecision {
  if (payload.runId !== expected.runId) {
    return { kind: 'ignore', reason: 'replaced-run' };
  }
  if (payload.configRevision > expected.configRevision) {
    return {
      kind: 'fatal',
      message: futureRevisionMessage(payload.configRevision, expected.configRevision),
    };
  }
  if (payload.configRevision < expected.configRevision) {
    return { kind: 'ignore', reason: 'stale-revision' };
  }
  return { kind: 'accept' };
}

/** Validate an order/checkpoint payload before recording or displaying it. */
export function inspectMeasurement(
  measurement: MeasurementPayload,
  expected: ExpectedRunProtocolState,
): RunProtocolDecision {
  return inspectIdentityAndRevision(
    measurement,
    expected,
    (received, requested) =>
      `the simulation reported order for unknown configuration revision ${received} ` +
      `(latest requested ${requested})`,
  );
}

/** Validate a complete population snapshot before any waiter is settled. */
export function inspectSnapshot(
  snapshot: SnapshotMessage,
  expected: ExpectedRunProtocolState,
): RunProtocolDecision {
  const identity = inspectIdentityAndRevision(
    snapshot,
    expected,
    (received, requested) =>
      `the simulation acknowledged unknown configuration revision ${received} ` +
      `(latest requested ${requested})`,
  );
  if (identity.kind !== 'accept') return identity;

  if (snapshot.config.nTapes !== snapshot.nTapes || snapshot.config.tapeLen !== snapshot.tapeLen) {
    return {
      kind: 'fatal',
      message: 'the simulation snapshot contains inconsistent shape metadata',
    };
  }
  if (snapshot.computePath !== expected.computePath) {
    return {
      kind: 'fatal',
      message:
        `simulation compute-path mismatch: expected ${expected.computePath}, ` +
        `received ${snapshot.computePath}`,
    };
  }
  const differences = configurationDifferences(snapshot.config, expected.config);
  if (differences.length > 0) {
    return {
      kind: 'fatal',
      message: `simulation configuration mismatch: ${differences.join('; ')}`,
    };
  }
  return { kind: 'accept' };
}

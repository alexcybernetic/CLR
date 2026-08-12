import {
  assertBatchRunDefinition,
  type BatchRequest,
} from './batch.ts';
import {
  isComputePath,
  normalizeSoupConfig,
  type BatchRunDefinition,
} from './model.ts';

export const LEGACY_BATCH_DRAFT_VERSION = 3 as const;
export const CURRENT_BATCH_DRAFT_VERSION = 4 as const;

export type BatchDraftVersion =
  | typeof LEGACY_BATCH_DRAFT_VERSION
  | typeof CURRENT_BATCH_DRAFT_VERSION;

/** Canonical in-memory form written by the current batch editor. */
export interface BatchDraft extends BatchRequest {}

const DEFAULT_BATCH_NAME = 'experiment batch';

function assertDraftVersion(value: number): asserts value is BatchDraftVersion {
  if (value !== LEGACY_BATCH_DRAFT_VERSION && value !== CURRENT_BATCH_DRAFT_VERSION) {
    throw new Error(`unsupported batch draft version ${value}`);
  }
}

function normalizeDraftItem(value: unknown, index: number): BatchRunDefinition {
  if (!value || typeof value !== 'object') {
    throw new Error(`batch draft item ${index + 1}: run definition is missing`);
  }

  const input = value as Record<string, unknown>;
  const candidate = {
    ...input,
    // Drafts created before engines became selectable are CuBFF drafts.
    config: normalizeSoupConfig(input.config),
    // The v3 draft predates selectable compute paths. The existing v4 reader
    // applies the same fallback to malformed or incomplete current drafts.
    computePath: isComputePath(input.computePath) ? input.computePath : 'wasm',
  };

  try {
    assertBatchRunDefinition(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`batch draft item ${index + 1}: ${message}`);
  }

  return {
    ...candidate,
    config: { ...candidate.config },
  };
}

/**
 * Parse one payload selected from the v3 or v4 storage key.
 *
 * Version is supplied by the storage adapter because the historical payload
 * itself has no version field. Both supported versions are normalized to the
 * current in-memory shape. A queue is accepted wholly or rejected wholly.
 */
export function decodeBatchDraft(serialized: string, version: number): BatchDraft {
  assertDraftVersion(version);

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('batch draft is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('batch draft is invalid');
  }

  const input = parsed as Record<string, unknown>;
  if (!Array.isArray(input.items)) throw new Error('batch draft queue is invalid');

  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : DEFAULT_BATCH_NAME;
  const items = input.items.map((item, index) => normalizeDraftItem(item, index));

  return { name, definition: { items } };
}

/** Serialize the canonical draft using the existing v4 payload shape. */
export function encodeBatchDraft(draft: BatchDraft): string {
  if (!draft || typeof draft !== 'object') throw new Error('batch draft is invalid');
  if (!draft.definition || !Array.isArray(draft.definition.items)) {
    throw new Error('batch draft queue is invalid');
  }

  const name =
    typeof draft.name === 'string' && draft.name.trim()
      ? draft.name.trim()
      : DEFAULT_BATCH_NAME;
  const items = draft.definition.items.map((item, index) => {
    try {
      assertBatchRunDefinition(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`batch draft item ${index + 1}: ${message}`);
    }
    return { ...item, config: { ...item.config } };
  });

  return JSON.stringify({ name, items });
}

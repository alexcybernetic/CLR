/** UI-only preferences survive reloads; experimental configuration does not. */
const KEY = 'bff-console.ui.v2';
const LEGACY_KEY = 'bff-console.params.v1';

export interface Prefs {
  /** view controls, held as their `data-v` strings */
  mode: string;
  sample: string;
  rxrate: string;
  sampler: boolean;
  /** the documentation window: open, which topic, and where it was left */
  help: boolean;
  helpTopic: string;
  helpBox: { x: number; y: number; w: number; h: number };
}

type StoredObject = Record<string, unknown>;

function parseObject(raw: string | null): StoredObject | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as StoredObject)
    : null;
}

/** Select only presentation state, including when reading the legacy blob. */
function selectUiPrefs(value: StoredObject): Partial<Prefs> {
  const prefs: Partial<Prefs> = {};
  if (typeof value.mode === 'string') prefs.mode = value.mode;
  if (typeof value.sample === 'string') prefs.sample = value.sample;
  if (typeof value.rxrate === 'string') prefs.rxrate = value.rxrate;
  if (typeof value.sampler === 'boolean') prefs.sampler = value.sampler;
  if (typeof value.help === 'boolean') prefs.help = value.help;
  if (typeof value.helpTopic === 'string') prefs.helpTopic = value.helpTopic;

  const box = value.helpBox;
  if (box && typeof box === 'object' && !Array.isArray(box)) {
    const candidate = box as Record<string, unknown>;
    if (
      ['x', 'y', 'w', 'h'].every(
        (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
      )
    ) {
      prefs.helpBox = {
        x: candidate.x as number,
        y: candidate.y as number,
        w: candidate.w as number,
        h: candidate.h as number,
      };
    }
  }
  return prefs;
}

/**
 * Storage is unavailable in some contexts (private windows, `file://`) and a
 * stored blob can be anything at all. Neither is a reason to fail to boot, so
 * both degrade to "no stored settings". Individual fields are validated by the
 * caller against the live controls, which is where the truth about which
 * values are still offered lives.
 */
export function loadPrefs(): Partial<Prefs> {
  try {
    const current = parseObject(localStorage.getItem(KEY));
    if (current) {
      localStorage.removeItem(LEGACY_KEY);
      return selectUiPrefs(current);
    }

    const legacy = parseObject(localStorage.getItem(LEGACY_KEY));
    if (!legacy) return {};
    const migrated = selectUiPrefs(legacy);
    localStorage.setItem(KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_KEY);
    return migrated;
  } catch {
    return {};
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* blocked or full — the console still runs, it just forgets */
  }
}

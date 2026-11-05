/**
 * The ON/OFF switch for automatic reviews (contract C4, decision D9). It lives in the shared
 * mcp-notes `app_settings` table, so both machines obey it, written only through SessionsRepo.
 * Absent (or unreadable) means ON. "Review now" ignores it.
 */
export const ADVERSARY_TOGGLE_KEY = 'adversary.auto';

export interface ToggleState {
  on: boolean;
  /** ISO 8601 of the last change, null when never set. */
  changed_at: string | null;
  /** Host that made the last change, null when never set. */
  host: string | null;
}

export const TOGGLE_DEFAULT: ToggleState = { on: true, changed_at: null, host: null };

/** The slice of SessionsRepo the toggle uses. */
export interface SettingsStore {
  getSetting(key: string): Promise<unknown | null>;
  putSetting(key: string, value: unknown): Promise<void>;
}

export function parseToggle(value: unknown): ToggleState {
  if (typeof value !== 'object' || value === null) return TOGGLE_DEFAULT;
  const v = value as Record<string, unknown>;
  if (typeof v.on !== 'boolean') return TOGGLE_DEFAULT;
  return {
    on: v.on,
    changed_at: typeof v.changed_at === 'string' ? v.changed_at : null,
    host: typeof v.host === 'string' ? v.host : null,
  };
}

export async function readToggle(store: SettingsStore): Promise<ToggleState> {
  return parseToggle(await store.getSetting(ADVERSARY_TOGGLE_KEY));
}

export async function writeToggle(store: SettingsStore, on: boolean, host: string, now: Date): Promise<ToggleState> {
  if (host.trim() === '') throw new TypeError('toggle host must be non-empty');
  const state: ToggleState = { on, changed_at: now.toISOString(), host };
  await store.putSetting(ADVERSARY_TOGGLE_KEY, state);
  return state;
}

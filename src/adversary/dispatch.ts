import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SettingsStore } from './toggle.js';

/**
 * Starts Seer's GitHub nightly from this machine, so the picks exist early enough for Seer
 * Adversarial to review them before the US open.
 *
 * Why: the workflow's cron slots (06:17, 09:41, 12:41 UTC) fire hours late, and the first one has
 * been starting around 14:2x-14:3x UTC, i.e. at or after the 14:30 UTC open, so a verdict could never
 * count. A manual dispatch (`gh workflow run`) is not delayed. The nightly cannot run before New
 * York midnight (Massive refuses the grouped aggregate for a date that is still "today" in Eastern
 * time), which is 05:00 UTC in US winter and 04:00 UTC in summer: 12:00 / 11:00 WIB.
 *
 * Safe to repeat or race: the workflow has `concurrency: seer-db-writer` (no cancel), and a second
 * run for a session that already succeeded logs "already succeeded; nothing to do". The shared
 * `app_settings` row below only keeps both laptops from asking over and over.
 */

export const DISPATCH_STATE_KEY = 'adversary.nightly_dispatch';
export const WORKFLOW_FILE = 'nightly.yml';
/** A minute-level margin after New York midnight before the data is fetchable. */
export const SETTLE_AFTER_ET_MIDNIGHT_MS = 5 * 60_000;
/** Time given to one dispatched run (about 20 minutes, plus GitHub queueing) before asking again. */
export const REDISPATCH_AFTER_MS = 90 * 60_000;
/** After an attempt that failed (gh missing, logged out, GitHub down): short, so a fix or a blip does not cost the day. */
export const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** Dispatches per New York date: the first plus two retries after a failed or missing run. */
export const MAX_DISPATCHES_PER_DAY = 3;
/** The workflow's own schedule: New York weekdays Tue-Sat (0 = Sunday). */
const NIGHTLY_WEEKDAYS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6]);

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function newYorkParts(at: Date): { date: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of NEW_YORK.formatToParts(at)) parts[part.type] = part.value;
  return {
    date: `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The New York calendar date of `at`, YYYY-MM-DD. */
export function easternDate(at: Date): string {
  return newYorkParts(at).date;
}

/** 00:00 New York on `date`, as a UTC instant (04:00Z in summer, 05:00Z in winter). */
export function easternMidnightUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  for (const hourUtc of [4, 5]) {
    const at = new Date(Date.UTC(y, m - 1, d, hourUtc, 0));
    const ny = newYorkParts(at);
    if (ny.date === date && ny.hour === 0 && ny.minute === 0) return at;
  }
  throw new Error(`00:00 in New York has no UTC instant on ${date}`);
}

/** The instant from which the night's data can be fetched, for the New York date of `now`. */
export function settleInstant(now: Date): Date {
  return new Date(easternMidnightUtc(easternDate(now)).getTime() + SETTLE_AFTER_ET_MIDNIGHT_MS);
}

/** What the daemon remembers (shared across machines) about today's dispatches. */
export interface DispatchState {
  /** New York date the counters belong to. */
  date: string;
  attempts: number;
  /** ISO 8601 of the last attempt. */
  last_at: string;
  host: string;
  /** Last attempt's result: 'ok' or the error. */
  result: string;
}

export function parseDispatchState(value: unknown): DispatchState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.date !== 'string' || typeof v.attempts !== 'number' || typeof v.last_at !== 'string') return null;
  return {
    date: v.date,
    attempts: v.attempts,
    last_at: v.last_at,
    host: typeof v.host === 'string' ? v.host : '',
    result: typeof v.result === 'string' ? v.result : '',
  };
}

export type DispatchVerdict =
  | { dispatch: true }
  | { dispatch: false; reason: 'no_nightly_today' | 'too_early' | 'already_done' | 'cooling_down' | 'gave_up' };

export interface DispatchDueInput {
  now: Date;
  /** `finished_at` of Seer's newest successful real run, null when there is none. */
  lastSuccessAt: Date | null;
  state: DispatchState | null;
}

/**
 * Whether the nightly should be started now. Pure. A successful run that finished after today's
 * settle instant means today's picks exist, whoever started that run (cron or this daemon).
 */
export function dispatchDue({ now, lastSuccessAt, state }: DispatchDueInput): DispatchVerdict {
  const date = easternDate(now);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (!NIGHTLY_WEEKDAYS.has(weekday)) return { dispatch: false, reason: 'no_nightly_today' };
  const settle = settleInstant(now);
  if (now.getTime() < settle.getTime()) return { dispatch: false, reason: 'too_early' };
  if (lastSuccessAt !== null && lastSuccessAt.getTime() >= settle.getTime()) return { dispatch: false, reason: 'already_done' };
  if (state !== null && state.date === date) {
    if (state.attempts >= MAX_DISPATCHES_PER_DAY) return { dispatch: false, reason: 'gave_up' };
    const last = Date.parse(state.last_at);
    const wait = state.result === 'ok' ? REDISPATCH_AFTER_MS : RETRY_AFTER_FAILURE_MS;
    if (Number.isFinite(last) && now.getTime() - last < wait) return { dispatch: false, reason: 'cooling_down' };
  }
  return { dispatch: true };
}

export interface GhResult {
  ok: boolean;
  /** Trimmed stderr (or the spawn error), empty on success. */
  error: string;
}

/** Runs `gh <args>`. Injectable so tests never start a process. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

/**
 * The `gh` to run. `NOTESD_GH_BIN` wins. Otherwise the first executable `gh` on PATH or in the
 * usual user locations: the systemd unit's PATH has no ~/.local/bin, where `gh` normally lives.
 * Falls back to plain `gh`, so a missing binary shows up as a failed attempt in the log.
 */
export function resolveGhBin(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.NOTESD_GH_BIN?.trim();
  if (explicit) return explicit.startsWith('~') ? path.join(home, explicit.slice(1)) : explicit;
  const dirs = [...(env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'gh');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return 'gh';
}

export function defaultGhRunner(ghBin: string = resolveGhBin(), timeoutMs = 60_000): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(ghBin, [...args], { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
        if (err === null) resolve({ ok: true, error: '' });
        else resolve({ ok: false, error: (String(stderr).trim() || err.message).slice(0, 300) });
      });
    });
}

/** `git@github.com:me/seer.git`, `https://github.com/me/seer(.git)` -> `me/seer`; null for anything else. */
export function repoSlugFromRemote(remote: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m?.[1] ?? null;
}

export type DispatchOutcome =
  | { type: 'skipped'; reason: Extract<DispatchVerdict, { dispatch: false }>['reason'] }
  | { type: 'dispatched' }
  | { type: 'failed'; error: string };

export interface NightlyDispatcherOptions {
  /** `finished_at` of Seer's newest successful real run (SeerReader.lastSuccessfulRunAt). */
  lastSuccessAt: () => Promise<Date | null>;
  /** `owner/name` of Seer's GitHub repo; throws when it cannot be found. */
  repo: () => Promise<string>;
  store: SettingsStore;
  gh: GhRunner;
  host: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export class NightlyDispatcher {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: NightlyDispatcherOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** One look. Dispatches at most once; throws only when Seer or the settings store cannot be read. */
  async tick(): Promise<DispatchOutcome> {
    const now = this.now();
    // Cheap checks first: no database call on a day or hour that cannot dispatch.
    const early = dispatchDue({ now, lastSuccessAt: null, state: null });
    if (!early.dispatch && (early.reason === 'no_nightly_today' || early.reason === 'too_early')) {
      return { type: 'skipped', reason: early.reason };
    }
    const [lastSuccessAt, rawState] = await Promise.all([this.opts.lastSuccessAt(), this.opts.store.getSetting(DISPATCH_STATE_KEY)]);
    const state = parseDispatchState(rawState);
    const verdict = dispatchDue({ now, lastSuccessAt, state });
    if (!verdict.dispatch) return { type: 'skipped', reason: verdict.reason };

    const date = easternDate(now);
    const attempts = state !== null && state.date === date ? state.attempts + 1 : 1;
    let result: GhResult;
    try {
      const repo = await this.opts.repo();
      result = await this.opts.gh(['workflow', 'run', WORKFLOW_FILE, '--repo', repo, '--ref', 'main']);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await this.opts.store.putSetting(DISPATCH_STATE_KEY, {
      date,
      attempts,
      last_at: now.toISOString(),
      host: this.opts.host,
      result: result.ok ? 'ok' : result.error,
    } satisfies DispatchState);
    if (result.ok) {
      this.log(`[notesd] adversary: started Seer's nightly (attempt ${attempts} of ${MAX_DISPATCHES_PER_DAY} for ${date})`);
      return { type: 'dispatched' };
    }
    this.log(`[notesd] adversary: could not start Seer's nightly (attempt ${attempts} of ${MAX_DISPATCHES_PER_DAY}): ${result.error}`);
    return { type: 'failed', error: result.error };
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/db/client.js';
import type { SharedImportState } from '../../../src/db/sharedImport.js';
import { IMPORT_RESTART_CHECK_MS, mergeSharedImportAtStart, startSharedImportRestart } from '../../../src/db/sharedImportStart.js';
import { IMPORT_RESTART_CHECK_MS as FROM_DAEMON } from '../../../src/daemon.js';

const db = {} as Db;
const URL = 'postgres://neon.example/old';

function io(state: SharedImportState | Error, merged: Record<string, number> | Error = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const merge = vi.fn(async () => {
    if (merged instanceof Error) throw merged;
    return merged;
  });
  const stateFn = vi.fn(async () => {
    if (state instanceof Error) throw state;
    return state;
  });
  return { lines, errors, merge, stateFn, io: { state: stateFn, merge, log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) } };
}

describe('mergeSharedImportAtStart', () => {
  it('looks at nothing without IMPORT_DATABASE_URL: nothing pending, nothing staged', async () => {
    const t = io('pending');
    expect(await mergeSharedImportAtStart(null, db, t.io)).toEqual({ pending: false, stageable: false });
    expect(await mergeSharedImportAtStart(undefined, db, t.io)).toEqual({ pending: false, stageable: false });
    expect(t.stateFn).not.toHaveBeenCalled();
  });

  it('a copy already done: nothing pending, nothing to stage, nothing merged', async () => {
    const t = io('done');
    expect(await mergeSharedImportAtStart(URL, db, t.io)).toEqual({ pending: false, stageable: false });
    expect(t.merge).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
  });

  it('a copy not staged yet: pending, and this start stages it behind the daemon', async () => {
    const t = io('pending');
    expect(await mergeSharedImportAtStart(URL, db, t.io)).toEqual({ pending: true, stageable: true });
    expect(t.merge).not.toHaveBeenCalled();
  });

  it('a complete stage is merged at this start, before anything else uses the database, and is then done', async () => {
    const t = io('staged', { notes: 12, movie_titles: 3 });
    expect(await mergeSharedImportAtStart(URL, db, t.io)).toEqual({ pending: false, stageable: false });
    expect(t.merge).toHaveBeenCalledWith(db);
    expect(t.lines).toEqual(['[notesd] shared import: merged notes 12, movie_titles 3']);
  });

  it('a failed merge stays staged for the next start: pending, never staged again, the start goes on', async () => {
    const t = io('staged', new Error('duplicate key'));
    expect(await mergeSharedImportAtStart(URL, db, t.io)).toEqual({ pending: true, stageable: false });
    expect(t.errors).toEqual(['[notesd] shared import: the merge failed, nothing was changed: duplicate key']);
  });

  it('a state that cannot be read counts as a failed merge', async () => {
    const t = io(new Error('no import_stage schema'));
    expect(await mergeSharedImportAtStart(URL, db, t.io)).toEqual({ pending: true, stageable: false });
    expect(t.errors[0]).toContain('no import_stage schema');
  });
});

describe('startSharedImportRestart', () => {
  afterEach(() => vi.useRealTimers());

  function job() {
    let onStaged: (() => void) | null = null;
    const stopJob = vi.fn();
    const start = vi.fn((_url: string, _db: Db, o: { onStaged: () => void }) => {
      onStaged = o.onStaged;
      return stopJob;
    });
    return { start, stopJob, staged: () => onStaged?.() };
  }

  it('keeps the daemon export of the check interval', () => {
    expect(FROM_DAEMON).toBe(IMPORT_RESTART_CHECK_MS);
    expect(IMPORT_RESTART_CHECK_MS).toBe(60_000);
  });

  it('starts no staging when the start found nothing to stage, or no URL', () => {
    const j = job();
    startSharedImportRestart({ importDatabaseUrl: URL, db, stageable: false, busy: () => false, start: j.start })();
    startSharedImportRestart({ importDatabaseUrl: null, db, stageable: true, busy: () => false, start: j.start })();
    expect(j.start).not.toHaveBeenCalled();
  });

  it('stages the old database and asks for a restart at once when nothing plays', () => {
    const j = job();
    const restart = vi.fn();
    const lines: string[] = [];
    startSharedImportRestart({ importDatabaseUrl: URL, db, stageable: true, busy: () => false, onRestartWanted: restart, start: j.start, log: (l) => lines.push(l) });
    expect(j.start).toHaveBeenCalledWith(URL, db, expect.any(Object));
    expect(restart).not.toHaveBeenCalled();
    j.staged();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['[notesd] shared import: restarting to merge the staged rows']);
  });

  it('waits while something plays, looks again every check, and asks only once', () => {
    vi.useFakeTimers();
    const j = job();
    const restart = vi.fn();
    let busy = true;
    startSharedImportRestart({ importDatabaseUrl: URL, db, stageable: true, busy: () => busy, onRestartWanted: restart, start: j.start, checkMs: 1_000, log: () => {} });
    j.staged();
    vi.advanceTimersByTime(3_000);
    expect(restart).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(1_000);
    expect(restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('without onRestartWanted (tests), the stage waits for whoever starts the daemon next', () => {
    vi.useFakeTimers();
    const j = job();
    const busy = vi.fn(() => false);
    startSharedImportRestart({ importDatabaseUrl: URL, db, stageable: true, busy, start: j.start });
    j.staged();
    vi.advanceTimersByTime(IMPORT_RESTART_CHECK_MS * 3);
    expect(busy).not.toHaveBeenCalled();
  });

  it('the stop ends the staging and the wait for a quiet moment', () => {
    vi.useFakeTimers();
    const j = job();
    const restart = vi.fn();
    let busy = true;
    const stop = startSharedImportRestart({ importDatabaseUrl: URL, db, stageable: true, busy: () => busy, onRestartWanted: restart, start: j.start, checkMs: 1_000, log: () => {} });
    j.staged();
    stop();
    expect(j.stopJob).toHaveBeenCalledTimes(1);
    busy = false;
    vi.advanceTimersByTime(5_000);
    expect(restart).not.toHaveBeenCalled();
  });
});

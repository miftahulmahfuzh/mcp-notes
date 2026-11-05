import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_STATE_KEY,
  MAX_DISPATCHES_PER_DAY,
  NightlyDispatcher,
  REDISPATCH_AFTER_MS,
  RETRY_AFTER_FAILURE_MS,
  dispatchDue,
  easternDate,
  easternMidnightUtc,
  parseDispatchState,
  repoSlugFromRemote,
  resolveGhBin,
  settleInstant,
  type GhRunner,
} from '../../../src/adversary/dispatch.js';
import type { SettingsStore } from '../../../src/adversary/toggle.js';

const at = (iso: string): Date => new Date(iso);

function memoryStore(): SettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async getSetting(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async putSetting(key, value) {
      values.set(key, value);
    },
  };
}

// 2026-11-05 is a Thursday in US winter: New York midnight is 05:00Z, so the data settles 05:05Z (12:05 WIB).
const THU_BEFORE = at('2026-11-05T05:04:00Z');
const THU_AFTER = at('2026-11-05T05:05:00Z');

describe('New York clock helpers', () => {
  it('finds New York midnight in winter and in summer', () => {
    expect(easternMidnightUtc('2026-11-05').toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(easternMidnightUtc('2026-07-01').toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('uses the New York date, not the UTC date', () => {
    expect(easternDate(at('2026-11-05T03:00:00Z'))).toBe('2026-11-04');
    expect(easternDate(at('2026-11-05T05:00:00Z'))).toBe('2026-11-05');
  });

  it('settles five minutes after New York midnight', () => {
    expect(settleInstant(at('2026-11-05T12:00:00Z')).toISOString()).toBe('2026-11-05T05:05:00.000Z');
    expect(settleInstant(at('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-07-01T04:05:00.000Z');
  });
});

describe('dispatchDue', () => {
  it('waits for the data: nothing before New York midnight plus five minutes', () => {
    expect(dispatchDue({ now: THU_BEFORE, lastSuccessAt: null, state: null })).toEqual({ dispatch: false, reason: 'too_early' });
    expect(dispatchDue({ now: THU_AFTER, lastSuccessAt: null, state: null })).toEqual({ dispatch: true });
  });

  it('follows the workflow days: Tuesday to Saturday in New York, never Sunday or Monday', () => {
    const noon = (day: string) => dispatchDue({ now: at(`${day}T12:00:00Z`), lastSuccessAt: null, state: null });
    expect(noon('2026-11-07')).toEqual({ dispatch: true }); // Saturday reads Friday
    expect(noon('2026-11-08')).toEqual({ dispatch: false, reason: 'no_nightly_today' }); // Sunday
    expect(noon('2026-11-09')).toEqual({ dispatch: false, reason: 'no_nightly_today' }); // Monday
    expect(noon('2026-11-10')).toEqual({ dispatch: true }); // Tuesday
  });

  it('is done once a run succeeded after the data settled, whoever started it', () => {
    expect(dispatchDue({ now: at('2026-11-05T13:00:00Z'), lastSuccessAt: at('2026-11-05T06:30:00Z'), state: null })).toEqual({
      dispatch: false,
      reason: 'already_done',
    });
  });

  it('does not count yesterday\'s success', () => {
    expect(dispatchDue({ now: at('2026-11-05T13:00:00Z'), lastSuccessAt: at('2026-11-05T02:00:00Z'), state: null })).toEqual({ dispatch: true });
  });

  it('cools down after a dispatch, retries later, and gives up after three', () => {
    const base = { date: '2026-11-05', host: 'GPD', result: 'ok' };
    const last = at('2026-11-05T06:00:00Z');
    const state = (attempts: number) => ({ ...base, attempts, last_at: last.toISOString() });
    const soon = new Date(last.getTime() + REDISPATCH_AFTER_MS - 1);
    const later = new Date(last.getTime() + REDISPATCH_AFTER_MS);
    expect(dispatchDue({ now: soon, lastSuccessAt: null, state: state(1) })).toEqual({ dispatch: false, reason: 'cooling_down' });
    expect(dispatchDue({ now: later, lastSuccessAt: null, state: state(1) })).toEqual({ dispatch: true });
    expect(dispatchDue({ now: later, lastSuccessAt: null, state: state(MAX_DISPATCHES_PER_DAY) })).toEqual({ dispatch: false, reason: 'gave_up' });
  });

  it('retries a failed attempt after fifteen minutes, not ninety', () => {
    const last = at('2026-11-05T06:00:00Z');
    const failed = { date: '2026-11-05', attempts: 1, last_at: last.toISOString(), host: 'GPD', result: 'spawn gh ENOENT' };
    expect(dispatchDue({ now: new Date(last.getTime() + RETRY_AFTER_FAILURE_MS - 1), lastSuccessAt: null, state: failed })).toEqual({
      dispatch: false,
      reason: 'cooling_down',
    });
    expect(dispatchDue({ now: new Date(last.getTime() + RETRY_AFTER_FAILURE_MS), lastSuccessAt: null, state: failed })).toEqual({ dispatch: true });
  });

  it('ignores a state left by an earlier New York date', () => {
    const old = { date: '2026-11-04', attempts: 3, last_at: '2026-11-04T20:00:00Z', host: 'GPD', result: 'ok' };
    expect(dispatchDue({ now: THU_AFTER, lastSuccessAt: null, state: old })).toEqual({ dispatch: true });
  });
});

describe('parseDispatchState and repoSlugFromRemote', () => {
  it('rejects anything that is not a state', () => {
    expect(parseDispatchState(null)).toBeNull();
    expect(parseDispatchState({ date: '2026-11-05' })).toBeNull();
    expect(parseDispatchState({ date: 'd', attempts: 1, last_at: 't' })).toEqual({ date: 'd', attempts: 1, last_at: 't', host: '', result: '' });
  });

  it.each([
    ['git@github.com:me/seer.git', 'me/seer'],
    ['https://github.com/me/seer.git', 'me/seer'],
    ['https://github.com/me/seer', 'me/seer'],
    ['https://x-access-token:abc@github.com/me/seer.git\n', 'me/seer'],
    ['git@gitlab.com:me/seer.git', null],
    ['', null],
  ])('reads %j as %j', (remote, slug) => {
    expect(repoSlugFromRemote(remote)).toBe(slug);
  });
});

describe('NightlyDispatcher', () => {
  function setup(opts: { now: Date; lastSuccessAt?: Date | null; gh?: GhRunner; repo?: () => Promise<string> }) {
    const store = memoryStore();
    const calls: (readonly string[])[] = [];
    const logs: string[] = [];
    let reads = 0;
    const clock = { now: opts.now };
    const dispatcher = new NightlyDispatcher({
      lastSuccessAt: async () => {
        reads += 1;
        return opts.lastSuccessAt ?? null;
      },
      repo: opts.repo ?? (async () => 'me/seer'),
      store,
      gh:
        opts.gh ??
        (async (args) => {
          calls.push(args);
          return { ok: true, error: '' };
        }),
      host: 'GPD',
      now: () => clock.now,
      log: (line) => logs.push(line),
    });
    return { dispatcher, store, calls, logs, clock, reads: () => reads };
  }

  it('starts the workflow on main once the data is fetchable and records it', async () => {
    const t = setup({ now: THU_AFTER });
    expect(await t.dispatcher.tick()).toEqual({ type: 'dispatched' });
    expect(t.calls).toEqual([['workflow', 'run', 'nightly.yml', '--repo', 'me/seer', '--ref', 'main']]);
    expect(t.store.values.get(DISPATCH_STATE_KEY)).toEqual({
      date: '2026-11-05',
      attempts: 1,
      last_at: THU_AFTER.toISOString(),
      host: 'GPD',
      result: 'ok',
    });
    expect(t.logs).toHaveLength(1);
  });

  it('asks only once, then waits out the cooldown (the other laptop shares the state)', async () => {
    const t = setup({ now: THU_AFTER });
    await t.dispatcher.tick();
    t.clock.now = new Date(THU_AFTER.getTime() + 10 * 60_000);
    expect(await t.dispatcher.tick()).toEqual({ type: 'skipped', reason: 'cooling_down' });
    expect(t.calls).toHaveLength(1);
    t.clock.now = new Date(THU_AFTER.getTime() + REDISPATCH_AFTER_MS);
    expect(await t.dispatcher.tick()).toEqual({ type: 'dispatched' });
    expect(t.calls).toHaveLength(2);
  });

  it('touches neither Seer nor the store before the data is fetchable or on a day off', async () => {
    const early = setup({ now: THU_BEFORE });
    expect(await early.dispatcher.tick()).toEqual({ type: 'skipped', reason: 'too_early' });
    const sunday = setup({ now: at('2026-11-08T12:00:00Z') });
    expect(await sunday.dispatcher.tick()).toEqual({ type: 'skipped', reason: 'no_nightly_today' });
    expect(early.reads() + sunday.reads()).toBe(0);
    expect(early.calls.length + sunday.calls.length).toBe(0);
  });

  it('does nothing when today\'s nightly already succeeded', async () => {
    const t = setup({ now: at('2026-11-05T13:00:00Z'), lastSuccessAt: at('2026-11-05T06:40:00Z') });
    expect(await t.dispatcher.tick()).toEqual({ type: 'skipped', reason: 'already_done' });
    expect(t.calls).toHaveLength(0);
  });

  it('counts a failed gh call as an attempt and gives up after three, quietly', async () => {
    const t = setup({ now: THU_AFTER, gh: async () => ({ ok: false, error: 'gh: not logged in' }) });
    for (let i = 0; i < MAX_DISPATCHES_PER_DAY; i++) {
      expect(await t.dispatcher.tick()).toEqual({ type: 'failed', error: 'gh: not logged in' });
      t.clock.now = new Date(t.clock.now.getTime() + RETRY_AFTER_FAILURE_MS);
    }
    expect(await t.dispatcher.tick()).toEqual({ type: 'skipped', reason: 'gave_up' });
    expect((t.store.values.get(DISPATCH_STATE_KEY) as { result: string }).result).toBe('gh: not logged in');
    expect(t.logs).toHaveLength(MAX_DISPATCHES_PER_DAY);
  });

  it('turns an unreadable repo into a failed attempt instead of throwing', async () => {
    const t = setup({
      now: THU_AFTER,
      repo: async () => {
        throw new Error("cannot tell Seer's GitHub repo");
      },
    });
    expect(await t.dispatcher.tick()).toEqual({ type: 'failed', error: "cannot tell Seer's GitHub repo" });
    expect(t.calls).toHaveLength(0);
  });
});

describe('resolveGhBin', () => {
  function fakeHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), 'gh-home-'));
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const gh = path.join(home, '.local', 'bin', 'gh');
    writeFileSync(gh, '#!/bin/sh\n');
    chmodSync(gh, 0o755);
    return home;
  }

  it('finds gh in ~/.local/bin although the daemon PATH lacks it', () => {
    const home = fakeHome();
    expect(resolveGhBin({ PATH: '/nonexistent' }, home)).toBe(path.join(home, '.local', 'bin', 'gh'));
  });

  it('prefers NOTESD_GH_BIN, expanding ~', () => {
    expect(resolveGhBin({ NOTESD_GH_BIN: '/opt/gh' }, '/h')).toBe('/opt/gh');
    expect(resolveGhBin({ NOTESD_GH_BIN: '~/bin/gh' }, '/h')).toBe('/h/bin/gh');
  });

  it('falls back to plain gh when none is found', () => {
    expect(resolveGhBin({ PATH: '/nonexistent' }, mkdtempSync(path.join(tmpdir(), 'gh-empty-')))).toMatch(/gh$/);
  });
});

import { describe, expect, it } from 'vitest';
import { PlayLog } from '../../../../src/directStream/playLog/log.js';
import type { PageStats, PlayAsk } from '../../../../src/directStream/playLog/types.js';
import { SESSION_IDLE_MS, SessionStore, type StreamSession } from '../../../../src/directStream/sessions.js';
import { DirectStreamError, type ResolvedSource } from '../../../../src/directStream/types.js';
import { MemoryPlayLog } from '../../../helpers/memoryPlayLog.js';

const FILM = { kind: 'movie' as const, tmdbId: 550 };
const SOURCE: ResolvedSource = {
  provider: 'Alpha', embed_url: 'https://embed.example/e/1', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls',
  headers: { referer: null, origin: null, user_agent: null },
  subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 1080, en_subtitle: true, took_s: 1,
};
const stats = (load: string, playedMs: number, extra: Partial<PageStats> = {}): PageStats => ({ load, firstFrameMs: 1_200, playedMs, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0, ...extra });

function setup() {
  let now = Date.parse('2026-11-27T10:00:00.000Z');
  const clock = (): Date => new Date(now);
  const repo = new MemoryPlayLog();
  const logged: string[] = [];
  const log = new PlayLog({ repo, host: 'host-a', now: clock, log: (line) => void logged.push(line) });
  const store = new SessionStore(clock);
  const ask = (asked: PlayAsk['asked'] = null): PlayAsk => ({ at: clock(), via: 'play', ref: FILM, asked });
  const play = (): StreamSession => {
    const a = ask();
    now += 2_500;
    const session = store.create(FILM, SOURCE, []);
    log.answered(a, session);
    return session;
  };
  return { repo, log, logged, store, ask, play, clock, advance: (ms: number) => void (now += ms) };
}

describe('the play log', () => {
  it('an answered ask is one row: the session, the channel, the provider, the height and the time to answer', async () => {
    const t = setup();
    const session = t.play();
    await t.log.settled();
    expect(t.repo.rows).toEqual([
      expect.objectContaining({
        host: 'host-a', via: 'play', kind: 'movie', tmdbId: 550, season: null, episode: null, asked: null, outcome: 'no_picture',
        resolveMs: 2_500, session: session.id, channel: 'cloud', providerFirst: 'Alpha', providerLast: 'Alpha', infoHash: null, height: 1080, subtitleSource: 'stream',
      }),
    ]);
  });

  it('a failed ask keeps its word, its detail without secrets, and the word of each channel asked', async () => {
    const t = setup();
    const err = new DirectStreamError('no_source', 'No provider or torrent could stream it (https://up.example/a?tok=SECRET).', {
      attempts: [
        { provider: 'Alpha', outcome: 'no_stream', took_s: 1, detail: '' },
        { provider: 'Index: torrentio', outcome: 'no_stream', took_s: 1, detail: '' },
      ],
    });
    t.log.failed(t.ask(), err);
    await t.log.settled();
    const row = t.repo.rows[0];
    expect(row).toMatchObject({ outcome: 'failed', failure: 'no_source', cloudFailure: 'no_stream', torrentFailure: 'no_source', asked: null });
    expect(row?.session ?? null).toBeNull();
    expect(row?.failureDetail).not.toContain('SECRET');
  });

  it('a streaming site that took the ask is a site row with no session', async () => {
    const t = setup();
    t.log.site(t.ask(), 'idlix');
    await t.log.settled();
    expect(t.repo.rows[0]).toMatchObject({ outcome: 'site', channel: 'site', providerFirst: 'idlix' });
  });

  it('sums the page counters over every page load, the first frame from the first load, and closes the row', async () => {
    const t = setup();
    const session = t.play();
    t.log.report(session.id, { stats: stats('loadAAAA', 10_000, { stalls: 1, stalledMs: 2_000 }), over: null, quiet: false });
    t.log.report(session.id, { stats: stats('loadAAAA', 20_000, { stalls: 2, stalledMs: 3_000 }), over: null, quiet: false });
    t.log.report(session.id, { stats: stats('loadBBBB', 5_000, { firstFrameMs: 900, waits: 1, waitedMs: 4_000, errors: 1 }), over: 'closed', quiet: false });
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({
      outcome: 'played', firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1, ended: 'closed', endedAt: t.clock(),
    });
  });

  it('writes on the first report, then at most every 30 s while it plays', async () => {
    const t = setup();
    const session = t.play();
    await t.log.settled();
    const afterInsert = t.repo.writes;
    t.log.report(session.id, { stats: stats('loadAAAA', 5_000), over: null, quiet: false });
    await t.log.settled();
    expect(t.repo.writes).toBe(afterInsert + 1);
    t.advance(29_999);
    t.log.report(session.id, { stats: stats('loadAAAA', 35_000), over: null, quiet: false });
    await t.log.settled();
    expect(t.repo.writes).toBe(afterInsert + 1);
    t.advance(1);
    t.log.report(session.id, { stats: stats('loadAAAA', 35_001), over: null, quiet: false });
    await t.log.settled();
    expect(t.repo.writes).toBe(afterInsert + 2);
    expect(t.repo.bySession(session.id)?.playedMs).toBe(35_001);
  });

  it('a paused beat for the stream on screen writes nothing, even long past the interval, and the next write carries its counters', async () => {
    const t = setup();
    const session = t.play();
    t.log.report(session.id, { stats: stats('loadAAAA', 5_000), over: null, quiet: false });
    await t.log.settled();
    const before = t.repo.writes;
    t.advance(60_000);
    t.log.report(session.id, { stats: stats('loadAAAA', 9_000), over: null, quiet: true });
    t.log.report(session.id, { stats: stats('loadAAAA', 9_000), over: null, quiet: true });
    await t.log.settled();
    expect(t.repo.writes).toBe(before);
    expect(t.repo.bySession(session.id)?.playedMs).toBe(5_000);
    t.log.report(session.id, { stats: null, over: null, quiet: false });
    await t.log.settled();
    expect(t.repo.bySession(session.id)?.playedMs).toBe(9_000);
  });

  it('counts the switches by who asked, and names the provider the play ended on', async () => {
    const t = setup();
    const store = t.store;
    const session = store.create(FILM, SOURCE, []);
    t.log.answered(t.ask(), session);
    store.replaceSource(session, { ...SOURCE, provider: 'Beta' }, []);
    t.log.switched(session, 'auto');
    t.log.switched(session, 'owner');
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ providerFirst: 'Alpha', providerLast: 'Beta', autoSwitches: 1, ownerSwitches: 1, refreshes: 1 });
  });

  it('a play that lost the screen is replaced, and is open again when its page reports again', async () => {
    const t = setup();
    const session = t.play();
    t.log.replaced(session.id);
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'replaced' });
    t.log.report(session.id, { stats: null, over: null, quiet: false });
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: null, endedAt: null, outcome: 'played' });
  });

  it('a session the store dropped is expired, and its later reports are not heard', async () => {
    const t = setup();
    const session = t.play();
    t.log.ended(session, 'expired');
    await t.log.settled();
    const writes = t.repo.writes;
    t.log.report(session.id, { stats: null, over: 'closed', quiet: false });
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'expired', outcome: 'no_picture' });
    expect(t.repo.writes).toBe(writes);
  });

  it('a page that closed first keeps its reason when the session expires later', async () => {
    const t = setup();
    const session = t.play();
    t.log.report(session.id, { stats: null, over: 'finished', quiet: false });
    t.log.ended(session, 'expired');
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'finished' });
  });

  it('a database that does not answer costs one log line per write and nothing else', async () => {
    const t = setup();
    t.repo.failWith = new Error('connect ECONNREFUSED 127.0.0.1:55437');
    const session = t.play();
    expect(() => t.log.report(session.id, { stats: stats('loadAAAA', 1_000), over: 'closed', quiet: false })).not.toThrow();
    t.log.failed(t.ask(), new Error('boom'));
    await t.log.settled();
    expect(t.logged).toEqual([
      '[notesd] play log: an answered play was not written: connect ECONNREFUSED 127.0.0.1:55437',
      '[notesd] play log: a failed play was not written: connect ECONNREFUSED 127.0.0.1:55437',
    ]);
    expect(await t.log.closeLeftOpen()).toBe(0);
    expect(t.logged.at(-1)).toBe('[notesd] play log: the rows left open were not closed: connect ECONNREFUSED 127.0.0.1:55437');
  });

  it('closes the rows the previous run left open as restart', async () => {
    const t = setup();
    const session = t.play();
    await t.log.settled();
    expect(await new PlayLog({ repo: t.repo, host: 'host-a', now: t.clock }).closeLeftOpen()).toBe(1);
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'restart' });
  });
  it('closes a session that expired while nothing swept the store, as expired at the time it expired (not later as restart)', async () => {
    const t = setup();
    const session = t.play();
    const usedAt = session.lastUsedAt.getTime();
    t.log.report(session.id, { stats: stats('loadAAAA', 10_000), over: null, quiet: false });
    // Nothing touches the store for a day: no new play, no torrent sweep. The row must not wait for a restart.
    t.advance(SESSION_IDLE_MS + 24 * 60 * 60 * 1000);
    t.log.expire();
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'expired', endedAt: new Date(usedAt + SESSION_IDLE_MS), playedMs: 10_000 });
    // The store's own drop later changes nothing.
    t.log.ended(session, 'expired');
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ endedAt: new Date(usedAt + SESSION_IDLE_MS) });
  });

  it('a session the store drops long after it expired ends at the time it expired', async () => {
    const t = setup();
    const session = t.play();
    const usedAt = session.lastUsedAt.getTime();
    t.advance(SESSION_IDLE_MS + 3 * 60 * 60 * 1000);
    t.log.ended(session, 'expired');
    await t.log.settled();
    expect(t.repo.bySession(session.id)).toMatchObject({ ended: 'expired', endedAt: new Date(usedAt + SESSION_IDLE_MS) });
  });

  it('a session still in use is not expired', async () => {
    const t = setup();
    const session = t.play();
    t.advance(SESSION_IDLE_MS - 1_000);
    t.store.get(session.id);
    t.advance(2_000);
    t.log.expire();
    await t.log.settled();
    expect(t.repo.bySession(session.id)?.ended ?? null).toBeNull();
  });
});

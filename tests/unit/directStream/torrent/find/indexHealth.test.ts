import { describe, expect, it } from 'vitest';
import { findCandidates, INDEX_COOL_DOWN_MS, INDEX_FAILURES_TO_SKIP, IndexHealth } from '../../../../../src/directStream/torrent/find/find.js';
import type { IndexAnswer, TorrentIndex, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', year: 2010, originalLanguage: 'en' };

/** An index that answers each of `answers` in turn (the last one for good); `hang` never answers. */
function index(name: string, answers: Array<IndexAnswer | 'hang' | 'throw'>, timeoutMs?: number): TorrentIndex & { asked: number } {
  const self = {
    name,
    asked: 0,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    find: async (): Promise<IndexAnswer> => {
      const answer = answers[Math.min(self.asked++, answers.length - 1)]!;
      if (answer === 'hang') return new Promise<IndexAnswer>(() => undefined);
      if (answer === 'throw') throw new Error('connect ECONNREFUSED');
      return answer;
    },
  };
  return self;
}
const EMPTY: IndexAnswer = { outcome: 'empty', detail: '0 listed', candidates: [] };
const BOT: IndexAnswer = { outcome: 'bot_check', detail: 'Just a moment', candidates: [] };

describe('IndexHealth: an index that keeps timing out is skipped for a while', () => {
  it('asks a dead index three plays in a row, then leaves it out with a skipped attempt that says why', async () => {
    let now = 1_000_000;
    const health = new IndexHealth({ now: () => now });
    const yts = index('yts', ['hang'], 20);
    const good = index('torrentio', [EMPTY]);
    for (let play = 1; play <= INDEX_FAILURES_TO_SKIP; play++) {
      const found = await findCandidates(FILM, { indexes: [good, yts], health });
      expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([['torrentio', 'empty'], ['yts', 'error']]);
      expect(found.indexes[1]!.detail).toMatch(/^timed out after/);
    }
    expect(yts.asked).toBe(INDEX_FAILURES_TO_SKIP);
    const skipped = await findCandidates(FILM, { indexes: [good, yts], health });
    expect(skipped.indexes[1]).toEqual({ index: 'yts', outcome: 'skipped', took_s: 0, listed: 0, detail: 'not asked: it failed or timed out 3 times in a row; asked again in 30 min' });
    expect(yts.asked).toBe(INDEX_FAILURES_TO_SKIP);
    // The index that answers is asked every time.
    expect(good.asked).toBe(INDEX_FAILURES_TO_SKIP + 1);

    // After the cool-down it is asked again; one more failure leaves it out for another cool-down.
    now += INDEX_COOL_DOWN_MS + 1;
    expect((await findCandidates(FILM, { indexes: [yts], health })).indexes[0]!.outcome).toBe('error');
    expect(yts.asked).toBe(INDEX_FAILURES_TO_SKIP + 1);
    expect((await findCandidates(FILM, { indexes: [yts], health })).indexes[0]!.outcome).toBe('skipped');
  });

  it('starts from zero again once the index answers, with torrents or with none', async () => {
    const health = new IndexHealth();
    const flaky = index('apibay', ['throw', 'throw', EMPTY, 'throw', 'throw', EMPTY]);
    for (let play = 0; play < 6; play++) await findCandidates(FILM, { indexes: [flaky], health });
    expect(flaky.asked).toBe(6);
    expect(health.skipReason('apibay')).toBeNull();
  });

  it('never counts and never skips a bot check: it stays the answer bot_check', async () => {
    const health = new IndexHealth();
    const checked = index('ext', [BOT]);
    for (let play = 0; play < 6; play++) {
      expect((await findCandidates(FILM, { indexes: [checked], health })).indexes[0]!.outcome).toBe('bot_check');
    }
    expect(checked.asked).toBe(6);
  });

  it('does not count an index the caller gave up on', async () => {
    const health = new IndexHealth({ failures: 1 });
    const slow = index('eztv', ['hang']);
    const gone = new AbortController();
    const asked = findCandidates(FILM, { indexes: [slow], health, signal: gone.signal, timeoutMs: 100 });
    gone.abort();
    await asked;
    expect(health.skipReason('eztv')).toBeNull();
  });

  it('without a health nothing is ever skipped', async () => {
    const dead = index('yts', ['throw']);
    for (let play = 0; play < 5; play++) await findCandidates(FILM, { indexes: [dead] });
    expect(dead.asked).toBe(5);
  });
});

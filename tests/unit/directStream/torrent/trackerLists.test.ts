import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TORRENT_CONFIG, type TorrentConfig } from '../../../../src/config.js';
import { TORRENT_INDEX_USER_AGENT } from '../../../../src/directStream/torrent/find/find.js';
import type { ConnectTrackers } from '../../../../src/directStream/torrent/find/scrape.js';
import {
  buildTrackerLists,
  parseTrackerList,
  refreshTrackerLists,
  TRACKER_LIST_SOURCES,
  TRACKER_LISTS_FILE,
  TRACKER_LISTS_MAX,
  TrackerLists,
  TrackerListsJob,
  type TrackerListFetch,
} from '../../../../src/directStream/torrent/trackerLists.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/torrent/tracker-lists');
const NGOSANG = readFileSync(join(FIXTURES, 'ngosang-trackers_best.txt'), 'utf8');
const NEWTRACKON = readFileSync(join(FIXTURES, 'newtrackon-stable.txt'), 'utf8');
const NG = TRACKER_LIST_SOURCES[0]!.url;
const NT = TRACKER_LIST_SOURCES[1]!.url;
const DAY = 24 * 60 * 60_000;

/** A fake fetch: a text answers 200 with it, a number answers that status, a missing address throws. */
function fakeFetch(answers: Record<string, string | number>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: TrackerListFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const answer = answers[url];
    if (answer === undefined) throw new Error('getaddrinfo ENOTFOUND');
    if (typeof answer === 'number') return { ok: false, status: answer, text: async () => '' };
    return { ok: true, status: 200, text: async () => answer };
  };
  return { fetch, calls };
}

/** A fake connect check: the trackers whose host is in `alive` answer (every one with 'all'). */
function fakeConnect(alive: readonly string[] | 'all') {
  const asked: string[][] = [];
  const connect: ConnectTrackers = async (trackers) => {
    asked.push([...trackers]);
    return new Set(trackers.filter((t) => alive === 'all' || alive.some((host) => t.includes(`//${host}:`))));
  };
  return { connect, asked };
}

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'notesd-lists-'));

afterEach(() => {
  vi.useRealTimers();
});

describe('the public tracker lists', () => {
  it('reads the distinct UDP trackers of both real lists', () => {
    expect(parseTrackerList(NGOSANG)).toHaveLength(17);
    expect(parseTrackerList(NEWTRACKON)).toHaveLength(31);
    expect([...parseTrackerList(NGOSANG), ...parseTrackerList(NEWTRACKON)].every((t) => t.startsWith('udp://'))).toBe(true);
    expect(parseTrackerList('udp://A.example:1/announce\r\n\r\nudp://a.example:1\nhttp://b.example/announce\nnonsense\n')).toEqual(['udp://A.example:1/announce']);
  });

  it('keeps the new trackers that answer a connect, under the list that named them first, in tracker-lists.json', async () => {
    const dir = freshDir();
    const store = new TrackerLists(join(dir, TRACKER_LISTS_FILE));
    const net = fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON });
    const udp = fakeConnect(['tracker.qu.ax', 'open.tracker.cl', 'evan.im']);
    const r = await refreshTrackerLists({ store, fetch: net.fetch, connect: udp.connect, known: () => ['udp://tracker.bittor.pw:1337'], now: () => new Date('2026-11-19T03:00:00Z') });
    // 31 new, minus the one the tracker book holds.
    expect(r).toMatchObject({ outcome: 'saved', asked: 30, answered: 3, kept: 3, detail: null });
    expect(net.calls.map((c) => c.url)).toEqual([NG, NT]);
    expect(net.calls.every((c) => c.headers['user-agent'] === TORRENT_INDEX_USER_AGENT)).toBe(true);
    // Neither a default tracker nor a tracker-book one is asked again; each is asked once.
    expect(udp.asked).toHaveLength(1);
    expect(udp.asked[0]).not.toContain('udp://tracker.opentrackr.org:1337/announce');
    expect(udp.asked[0]!.some((t) => t.includes('bittor'))).toBe(false);
    expect(new Set(udp.asked[0]).size).toBe(udp.asked[0]!.length);
    const kept = [
      { url: 'udp://open.tracker.cl:1337/announce', source: 'ngosang' },
      { url: 'udp://tracker.qu.ax:6969/announce', source: 'ngosang' },
      { url: 'udp://evan.im:6969/announce', source: 'newtrackon' },
    ];
    expect(JSON.parse(readFileSync(join(dir, TRACKER_LISTS_FILE), 'utf8'))).toEqual({ fetched_at: '2026-11-19T03:00:00.000Z', trackers: kept });
    expect(new TrackerLists(join(dir, TRACKER_LISTS_FILE)).list()).toEqual(kept.map((e) => e.url));
  });

  it('keeps at most TRACKER_LISTS_MAX, the first list first', async () => {
    const store = new TrackerLists(join(freshDir(), TRACKER_LISTS_FILE));
    const r = await refreshTrackerLists({ store, fetch: fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON }).fetch, connect: fakeConnect('all').connect, known: () => [] });
    expect(r).toMatchObject({ outcome: 'saved', asked: 31, answered: 31, kept: TRACKER_LISTS_MAX });
    expect(store.entries().filter((e) => e.source === 'ngosang')).toHaveLength(11);
  });

  it('a list that cannot be read keeps its previous trackers; nothing read or nothing heard keeps the whole file', async () => {
    const file = join(freshDir(), TRACKER_LISTS_FILE);
    const store = new TrackerLists(file);
    const both = fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON }).fetch;
    await refreshTrackerLists({ store, fetch: both, connect: fakeConnect(['open.tracker.cl', 'evan.im']).connect, known: () => [], now: () => new Date('2026-11-18T03:00:00Z') });
    const before = readFileSync(file, 'utf8');

    // Both lists down: nothing is asked and the file is untouched.
    const silent = fakeConnect('all');
    const down = await refreshTrackerLists({ store, fetch: fakeFetch({ [NG]: 503 }).fetch, connect: silent.connect, known: () => [] });
    expect(down).toMatchObject({ outcome: 'kept', asked: 0, kept: 2, detail: 'no list could be read' });
    expect(down.lists).toEqual([
      { source: 'ngosang', outcome: 'error', listed: 0, detail: 'HTTP 503' },
      { source: 'newtrackon', outcome: 'error', listed: 0, detail: 'getaddrinfo ENOTFOUND' },
    ]);
    expect(silent.asked).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Lists read, no tracker answers (a network that drops UDP), or the check itself fails: untouched.
    expect(await refreshTrackerLists({ store, fetch: both, connect: fakeConnect([]).connect, known: () => [] })).toMatchObject({ outcome: 'kept', answered: 0, kept: 2, detail: 'no tracker answered' });
    const broken: ConnectTrackers = async () => {
      throw new Error('EPERM');
    };
    expect((await refreshTrackerLists({ store, fetch: both, connect: broken, known: () => [] })).outcome).toBe('kept');
    expect(readFileSync(file, 'utf8')).toBe(before);

    // newtrackon down, ngosang read: ngosang's trackers are asked again, newtrackon's previous one is carried.
    const half = await refreshTrackerLists({ store, fetch: fakeFetch({ [NG]: NGOSANG }).fetch, connect: fakeConnect(['tracker.qu.ax']).connect, known: () => [], now: () => new Date('2026-11-19T03:00:00Z') });
    expect(half).toMatchObject({ outcome: 'saved', kept: 2 });
    expect(new TrackerLists(file).entries()).toEqual([
      { url: 'udp://tracker.qu.ax:6969/announce', source: 'ngosang' },
      { url: 'udp://evan.im:6969/announce', source: 'newtrackon' },
    ]);
  });

  it('reading never throws: a missing or broken file is no tracker', () => {
    const dir = freshDir();
    expect(new TrackerLists(join(dir, 'missing.json')).list()).toEqual([]);
    expect(new TrackerLists(join(dir, 'missing.json')).fetchedAt()).toBeNull();
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(new TrackerLists(join(dir, 'broken.json')).list()).toEqual([]);
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ fetched_at: 'never', trackers: [{ url: 'http://web.example/announce', source: 'x' }, { url: 'udp://ok.example:1', source: 'x' }, 7] }));
    expect(new TrackerLists(join(dir, 'odd.json')).list()).toEqual(['udp://ok.example:1']);
    expect(new TrackerLists(join(dir, 'odd.json')).fetchedAt()).toBeNull();
  });

  it('runs a minute after start, then once a day (looked at hourly), not again after a restart within the day, and stops on close', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-19T00:00:00Z') });
    const file = join(freshDir(), TRACKER_LISTS_FILE);
    const store = new TrackerLists(file);
    const net = fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON });
    const job = new TrackerListsJob({ store, fetch: net.fetch, connect: fakeConnect('all').connect, known: () => [], log: () => undefined });
    job.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(net.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(net.calls).toHaveLength(2);
    expect(store.list()).toHaveLength(TRACKER_LISTS_MAX);
    await vi.advanceTimersByTimeAsync(DAY - 60 * 60_000);
    expect(net.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(net.calls).toHaveLength(4);
    await job.close();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(net.calls).toHaveLength(4);

    // A daemon started again within the day reads the file and asks nothing. (The clock went two days on above to
    // show the closed job stays quiet, so it is put back to an hour after the last save: plan decision, R3.1.)
    vi.setSystemTime(new Date(store.fetchedAt()!.getTime() + 60 * 60_000));
    const again = fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON });
    const restarted = new TrackerListsJob({ store: new TrackerLists(file), fetch: again.fetch, connect: fakeConnect('all').connect, known: () => [], log: () => undefined });
    restarted.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(again.calls).toHaveLength(0);
    await restarted.close();
  });

  it('fetches no list and asks no tracker with the setting, discovery or torrents off', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-19T00:00:00Z') });
    const dir = freshDir();
    const on: TorrentConfig = { ...DEFAULT_TORRENT_CONFIG, enabled: true, dir, discovery: true, trackerLists: true };
    const net = fakeFetch({ [NG]: NGOSANG, [NT]: NEWTRACKON });
    const udp = fakeConnect('all');
    const overrides = { fetch: net.fetch, connect: udp.connect, log: () => undefined };
    const cases: Array<[TorrentConfig | undefined, boolean, string]> = [
      [{ ...on, trackerLists: false }, true, 'NOTESD_TORRENT_TRACKER_LISTS=off'],
      [DEFAULT_TORRENT_CONFIG, true, 'NOTESD_TORRENT_TRACKER_LISTS=off'],
      [{ ...on, discovery: false }, true, 'NOTESD_TORRENT_DISCOVERY=off'],
      [{ ...on, enabled: false }, true, 'NOTESD_TORRENT=off'],
      [on, false, 'NOTESD_TORRENT=off'],
      [undefined, true, 'NOTESD_TORRENT=off'],
    ];
    for (const [torrent, torrentsOn, reason] of cases) {
      const built = buildTrackerLists(torrent, torrentsOn, overrides);
      expect(built.lists).toBeNull();
      expect(built.job.enabled).toBe(false);
      expect(built.job.startLine()).toContain(reason);
      built.job.start();
    }
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(net.calls).toEqual([]);
    expect(udp.asked).toEqual([]);
    expect(existsSync(join(dir, TRACKER_LISTS_FILE))).toBe(false);

    // On: the job fills the very store TorrentSource is given.
    const built = buildTrackerLists(on, true, overrides);
    expect(built.job.enabled).toBe(true);
    built.job.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.calls.map((c) => c.url)).toEqual([NG, NT]);
    expect(built.lists?.list()).toHaveLength(TRACKER_LISTS_MAX);
    expect(existsSync(join(dir, TRACKER_LISTS_FILE))).toBe(true);
    await built.job.close();
  });
});

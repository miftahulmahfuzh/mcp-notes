# Phase 3: Daily verified public tracker lists

**Plan set:** `WIDER_TORRENT_SOURCES_PLAN.md`
**Analysis:** `.workflows/analyze/20261119-025431-K7QD_code_analyzer.md`
**Satisfies:** R3 — "more tracker lists": every torrent the daemon opens and every scrape it asks gets a daily, verified public tracker list
**Criteria:** R3.1, R3.2, R3.3, R3.4
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/directStream/torrent`

---

## Goal

Once a day (first a minute after start) the daemon reads ngosang's `trackers_best` and newtrackon's `stable`, asks each new UDP tracker on them for a BEP 15 connect only, and keeps up to 20 that answer in `<torrent dir>/tracker-lists.json`. `TorrentSource` adds them to every torrent it opens and every scrape, after the candidate's own trackers and the tracker book's. A list that cannot be read, or a day no tracker answers, keeps the previous file, and nothing of it runs in a play's path. `NOTESD_TORRENT_TRACKER_LISTS=off` (or discovery off, or torrents off) builds nothing and adds nothing.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/torrent/trackerLists.ts` (new file): `TRACKER_LIST_SOURCES`, `TRACKER_LISTS_FILE` (`'tracker-lists.json'`), `TRACKER_LISTS_MAX` (20), `TRACKER_LISTS_ASK_MAX` (60), `TRACKER_LIST_FETCH_TIMEOUT_MS`, `TRACKER_LIST_MAX_CHARS`, `TRACKER_LISTS_INITIAL_DELAY_MS` (60 s), `TRACKER_LISTS_CHECK_MS` (1 h), `TRACKER_LISTS_EVERY_MS` (24 h), `parseTrackerList`, `TrackerListSource`, `TrackerListEntry`, `TrackerLists` (the file store: `list()`, `entries()`, `fetchedAt()`, `save()`), `TrackerListFetch`, `TrackerListRead`, `TrackerListsRefresh`, `RefreshDeps`, `refreshTrackerLists`, `refreshLine`, `TrackerListsHandle`, `TrackerListsOffReason`, `DisabledTrackerLists`, `TrackerListsJobOptions`, `TrackerListsJob`, `TrackerListsOverrides`, `TrackerListsBuild`, `buildTrackerLists`.
- `src/directStream/torrent/find/scrape.ts` (re-exported by the `find/index.ts` barrel's existing `export * from './scrape.js'`; no barrel edit): `ConnectTrackers`, `CONNECT_TIMEOUT_MS` (3 s), `CONNECT_MAX_TRACKERS` (100), `udpConnector`, `SCRAPE_LIST_SLOTS` (6), `scrapeTrackerOrder`. Phases 1 and 2 must not export these names from another `find/` module (the barrel would collide).
- Config: `TorrentConfig.trackerLists?: boolean` (`src/config.ts`, torrent block), read from **`NOTESD_TORRENT_TRACKER_LISTS`** (default on; unset in a `Config` literal = off, so `DEFAULT_TORRENT_CONFIG` is unchanged).
- `AppDeps.trackerLists?: TrackerListsHandle | null` (`src/deps.ts`).
- `TorrentSourceOptions.lists?: Pick<TrackerLists, 'list'> | null` and `buildTorrentSource`'s `wiring.lists?: Pick<TrackerLists, 'list'> | null` (`src/directStream/torrent/source.ts`).
- File `<NOTESD_TORRENT_DIR>/tracker-lists.json`: `{ "fetched_at": ISO, "trackers": [{ "url", "source" }] }`, at most 20.
- Fixtures `tests/fixtures/torrent/tracker-lists/ngosang-trackers_best.txt`, `newtrackon-stable.txt` (copies of the analysis samples); test file `tests/unit/directStream/torrent/trackerLists.test.ts`.

**Signature changes:**
- `SCRAPE_MAX_TRACKERS` 8 -> 16 (`find/scrape.ts`). Every tracker is asked at once on one socket, so `SCRAPE_TIMEOUT_MS` (1.5 s) is unchanged.
- `TorrentSource.trackersOf` (private): candidate + book + lists, deduplicated by `trackerKey` (was an exact-string `Set` of candidate + book).
- `TorrentSource.swarmCounts` (private): the tracker list it hands the scraper is `scrapeTrackerOrder([...DEFAULT_TRACKERS, ...book, ...candidates' trackers], lists)`.

**Requires (from earlier phases):** nothing (no dependency).

**Leaves alone (owned by others):** every index module, `find/find.ts`, `find/types.ts`, `find/rank.ts`, `find/torrentio.ts`, `find/index.ts` (Phases 1, 2); `TORRENT_INDEX_NAMES`, `TORRENT_INDEX_URL_KEYS`, `parseTorrentFinder` and lines :1195-1198 of loadConfig's key-list comment (phase 2 rewrites :1197; this phase only inserts a new line after :1194, Step 4); `indexesOf` and `source.ts` line 5's `./find/index.js` import (Phases 1, 2); `configuration.md` index rows :177-180 and after; `verify.sh` :333-345; `streaming.md` "Playing from a torrent" index list (~:1800); `TrackerBook`, `learnMagnet`, `engine.ts`, `origins.ts` (read, never edited).

**Shared-file regions this phase edits (exact anchors):**

| File | Region | Anchor |
|---|---|---|
| `src/config.ts` | `TorrentConfig` | new field after `peers: string[]` (:439) |
| `src/config.ts` | `parseTorrent` | new line after `peers: parsePeers(env.NOTESD_TORRENT_PEERS),` (:1100) |
| `src/config.ts` | loadConfig's key-list comment | one new line after ` * Torrent keys: NOTESD_TORRENT, …, NOTESD_TORRENT_SUBTITLE_WAIT_MS,` (:1194); :1195-1196 stay unchanged, phase 2 rewrites :1197 |
| `src/directStream/torrent/source.ts` | imports | two new lines after line 6 (`import { readMagnet, TRACKER_BOOK_FILE, TrackerBook, trackerKey } from './origins.js';`) |
| `src/directStream/torrent/source.ts` | `TorrentSourceOptions` | after `book?: TrackerBook | null;` (:114) |
| `src/directStream/torrent/source.ts` | `trackersOf`, `swarmCounts` | :478-494 |
| `src/directStream/torrent/source.ts` | `buildTorrentSource` | wiring type after `sync?` (:1076); `lists:` after `book:` (:1103) |
| `docs/guide/reference/configuration.md` | torrent rows | one row after `NOTESD_TORRENT_PEERS` (:173) |
| `docs/guide/streaming.md` | the "trackers are asked" bullet (:1742-1746); new section after "What a magnet says of its index" (after :2199); the code-table scrape row (:2214) | |
| `CLAUDE.md` | Direct streaming bullets | one bullet after the `/update-cloud-source <magnet>` bullet (:120) |
| `.claude/skills/verify-notesd/scripts/verify.sh` | base `env=(...)` array | after `NOTESD_TORRENT_DIR="$dir/data/movies/torrents"` (:262) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | "Torrent rotation, tracker scrape, RuTracker and a magnet's index" | one bullet after :574 |
| `tests/unit/config.torrent.test.ts` | the two `toEqual` objects (:9, :25) and one new `it` | |
| `tests/unit/directStream/torrentRotation.test.ts` | imports (:1-9), `Fakes` (:30-38), `setup` spread (:77), one new `describe` at the end | |

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/find/scrape.ts` | modify | `SCRAPE_MAX_TRACKERS` 16, `SCRAPE_LIST_SLOTS`, `scrapeTrackerOrder`, the connect-only `udpConnector` on the existing `ScrapeSocket` seam |
| `src/directStream/torrent/trackerLists.ts` | create | fetch, parse, verify, store, keep-previous, the daily job, the switches |
| `src/directStream/torrent/source.ts` | modify | `lists` option; `trackersOf`, `swarmCounts`; `buildTorrentSource` wiring |
| `src/config.ts` | modify | `TorrentConfig.trackerLists`; `parseTorrent` reads `NOTESD_TORRENT_TRACKER_LISTS`; one line in loadConfig's key-list comment |
| `src/deps.ts` | modify | `trackerLists?: TrackerListsHandle | null` |
| `src/daemon.ts` | modify | build the lists once; the store to the torrent source, the job to `deps` |
| `src/background.ts` | modify | start and close the job |
| `tests/fixtures/torrent/tracker-lists/*.txt` | create | the two real list answers |
| `tests/unit/directStream/torrent/trackerLists.test.ts` | create | R3.1, R3.3, R3.4 |
| `tests/unit/directStream/torrent/find/scrape.test.ts` | modify | connect-only check, scrape tracker order |
| `tests/unit/directStream/torrentRotation.test.ts` | modify | R3.2 open/scrape order, R3.3 broken file, R3.4 switched off |
| `tests/unit/config.torrent.test.ts` | modify | the new key in the two whole-object expectations; the switch |
| `docs/guide/reference/configuration.md` | modify | one row |
| `docs/guide/streaming.md` | modify | scrape bullet, new section, code-table row |
| `CLAUDE.md` | modify | one bullet |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | pin `NOTESD_TORRENT_TRACKER_LISTS=off` |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | one bullet |

## Implementation Steps

### Step 1: The connect-only check and the scrape's tracker order
**File:** `src/directStream/torrent/find/scrape.ts`:21-24 (constants) and after `udpScraper` (its closing brace, just before `/** True when enough trackers answered for the hash and none of them knows a seeder. */`)
**Change:** (a) raise the scrape cap and add the list slots; (b) add `scrapeTrackerOrder`; (c) add `udpConnector`, which sends only the connect packet (`connectPacket`, action 0) on the same `ScrapeSocket` seam `udpScraper` uses: no info hash, no announce.

Replace lines 21-24:
```ts
/** The whole scrape answers within this, with whatever arrived. */
export const SCRAPE_TIMEOUT_MS = 1_500;
/** Trackers asked at most per scrape. */
export const SCRAPE_MAX_TRACKERS = 8;
```
with:
```ts
/** The whole scrape answers within this, with whatever arrived. */
export const SCRAPE_TIMEOUT_MS = 1_500;
/**
 * Trackers asked at most per scrape. They are all asked at once on one socket, so more of them cost no time:
 * the scrape still answers within SCRAPE_TIMEOUT_MS.
 */
export const SCRAPE_MAX_TRACKERS = 16;
/** Of those places, the ones kept for the public tracker lists' trackers (trackerLists.ts), asked after the others. */
export const SCRAPE_LIST_SLOTS = 6;
```

Insert after the closing brace of `udpScraper`:
```ts
/** The UDP addresses of `urls` whose tracker is not in `taken` yet, in order, at most `max`; marks them taken. */
function distinctUdp(urls: readonly string[], max: number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (out.length >= max) break;
    const t = udpTrackerOf(url);
    if (t === null || taken.has(t.key)) continue;
    taken.add(t.key);
    out.push(url);
  }
  return out;
}

/**
 * The trackers one scrape asks: the distinct UDP trackers of `first` (the defaults, the tracker book, the
 * candidates' own), then those of `then` (the public lists' trackers), at most `max`. When `then` has any, the
 * last `slots` places are kept for it, so the list trackers are really asked.
 */
export function scrapeTrackerOrder(first: readonly string[], then: readonly string[], max = SCRAPE_MAX_TRACKERS, slots = SCRAPE_LIST_SLOTS): string[] {
  const taken = new Set<string>();
  const listed = then.filter((url) => udpTrackerOf(url) !== null);
  const head = distinctUdp(first, listed.length === 0 ? max : Math.max(0, max - slots), taken);
  return [...head, ...distinctUdp(listed, max - head.length, taken)];
}

/** Asks UDP trackers for a connect only: answers the addresses, as given, whose tracker answered one. */
export type ConnectTrackers = (trackers: readonly string[], options?: { timeoutMs?: number }) => Promise<Set<string>>;

/** The whole connect check answers within this, with whatever arrived. */
export const CONNECT_TIMEOUT_MS = 3_000;
/** Trackers asked at most per connect check. */
export const CONNECT_MAX_TRACKERS = 100;

/**
 * The BEP 15 connect alone, over UDP: tells a tracker that answers from one that does not, and nothing else. No
 * info hash is sent, nothing is announced and no peer is contacted (the public tracker lists, trackerLists.ts).
 * One socket per call; every tracker is asked at once and the call answers when all have answered or the time is
 * up. Never throws.
 */
export function udpConnector(deps: { socket?: () => ScrapeSocket } = {}): ConnectTrackers {
  const open = deps.socket ?? ((): ScrapeSocket => createSocket('udp4') as unknown as ScrapeSocket);
  return (trackers, options = {}) => {
    const asked = udpTrackers(trackers, CONNECT_MAX_TRACKERS);
    /** Tracker key -> the first address given for it. */
    const addressOf = new Map<string, string>();
    for (const url of trackers) {
      const t = udpTrackerOf(url);
      if (t !== null && !addressOf.has(t.key)) addressOf.set(t.key, url);
    }
    const answered = new Set<string>();
    if (asked.length === 0) return Promise.resolve(answered);
    return new Promise((resolve) => {
      let socket: ScrapeSocket;
      try {
        socket = open();
      } catch {
        resolve(answered);
        return;
      }
      /** Transaction id -> the key of the tracker it was sent to. */
      const pending = new Map<number, string>();
      let left = asked.length;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(answered);
      };
      const timer = setTimeout(finish, options.timeoutMs ?? CONNECT_TIMEOUT_MS);
      const gone = (): void => {
        left -= 1;
        if (left <= 0) finish();
      };
      socket.on('error', finish);
      socket.on('message', (message) => {
        if (done || message.length < 8) return;
        const tid = message.readUInt32BE(4);
        const key = pending.get(tid);
        if (key === undefined) return;
        pending.delete(tid);
        const address = addressOf.get(key);
        if (message.readUInt32BE(0) === ACTION_CONNECT && message.length >= 16 && address !== undefined) answered.add(address);
        gone();
      });
      for (const tracker of asked) {
        const tid = transactionId();
        pending.set(tid, tracker.key);
        socket.send(connectPacket(tid), tracker.port, tracker.host, (err) => {
          if (err !== null && err !== undefined && pending.delete(tid)) gone();
        });
      }
    });
  };
}
```
**Impact:** `udpScraper` now asks up to 16 trackers (its own `udpTrackers(trackers)` default follows the constant). The existing scrape test asserts the cap through the constant (`toHaveLength(SCRAPE_MAX_TRACKERS)` on 20 inputs), so it still passes. Nothing else changes until Step 3 calls `scrapeTrackerOrder`.

### Step 2: The tracker lists module
**File:** `src/directStream/torrent/trackerLists.ts` (new)
**Change:** whole file.
**Code:**
```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TorrentConfig } from '../../config.js';
import { DEFAULT_TRACKERS } from './find/candidate.js';
import { TORRENT_INDEX_USER_AGENT } from './find/find.js';
import { CONNECT_TIMEOUT_MS, udpConnector, udpTrackerOf, type ConnectTrackers } from './find/scrape.js';
import { TRACKER_BOOK_FILE, TrackerBook, trackerKey } from './origins.js';

/**
 * The public tracker lists (wider-torrent-sources phase 3). Once a day ngosang's `trackers_best` and newtrackon's
 * `stable` are read, each UDP tracker on them that the daemon does not hold already (DEFAULT_TRACKERS, the tracker
 * book) is asked for a BEP 15 connect only (nothing announced, no info hash sent, no peer contacted), and the ones
 * that answer are kept in `<torrent dir>/tracker-lists.json`. TorrentSource adds them to every torrent it opens and
 * every scrape, after the candidate's own trackers and the book's. A refresh that reads no list or hears no tracker
 * keeps the previous file; nothing here runs in a play's path, and reading the file never throws.
 */

export interface TrackerListSource {
  /** Named in the file and in the log. */
  name: string;
  url: string;
}

/** The lists read, in this order: a tracker on both is kept under the first. Constants, not settings. */
export const TRACKER_LIST_SOURCES: readonly TrackerListSource[] = [
  { name: 'ngosang', url: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt' },
  { name: 'newtrackon', url: 'https://newtrackon.com/api/stable' },
];

/** The file's name inside the torrent folder, beside the tracker book's (trackers.json). */
export const TRACKER_LISTS_FILE = 'tracker-lists.json';
/** Trackers kept at most: each is announced to by every torrent opened. */
export const TRACKER_LISTS_MAX = 20;
/** New trackers asked at most per refresh. */
export const TRACKER_LISTS_ASK_MAX = 60;
/** One list's answer must arrive within this. */
export const TRACKER_LIST_FETCH_TIMEOUT_MS = 15_000;
/** A list longer than this is read only this far. */
export const TRACKER_LIST_MAX_CHARS = 256 * 1024;
/** The first check after the daemon starts: never in the way of a start. */
export const TRACKER_LISTS_INITIAL_DELAY_MS = 60_000;
/** The job looks this often whether the kept trackers are a day old. */
export const TRACKER_LISTS_CHECK_MS = 60 * 60_000;
export const TRACKER_LISTS_EVERY_MS = 24 * 60 * 60_000;
const CLOSE_GRACE_MS = 5_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The distinct UDP trackers of a list's text (one address per line, blank lines between), in order. */
export function parseTrackerList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.slice(0, TRACKER_LIST_MAX_CHARS).split(/\r?\n/)) {
    const url = line.trim();
    if (udpTrackerOf(url) === null) continue;
    const key = trackerKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export interface TrackerListEntry {
  url: string;
  /** The list it was read from (TRACKER_LIST_SOURCES' name). */
  source: string;
}

interface StoredLists {
  fetchedAt: Date | null;
  entries: TrackerListEntry[];
}

/**
 * The kept list trackers: one JSON file per host in the torrent folder, `{ fetched_at, trackers: [{ url, source }] }`.
 * Read once and kept in memory; `save` replaces both. Reading never throws: a missing or broken file is no tracker.
 */
export class TrackerLists {
  private stored: StoredLists | null = null;

  constructor(readonly file: string) {}

  private load(): StoredLists {
    if (this.stored !== null) return this.stored;
    let stored: StoredLists = { fetchedAt: null, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { fetched_at?: unknown; trackers?: unknown };
      const at = typeof parsed.fetched_at === 'string' ? new Date(parsed.fetched_at) : null;
      const entries = Array.isArray(parsed.trackers)
        ? parsed.trackers.filter(
            (e): e is TrackerListEntry =>
              typeof e === 'object' && e !== null && typeof (e as TrackerListEntry).url === 'string' && typeof (e as TrackerListEntry).source === 'string' && udpTrackerOf((e as TrackerListEntry).url) !== null,
          )
        : [];
      stored = { fetchedAt: at !== null && !Number.isNaN(at.getTime()) ? at : null, entries: entries.slice(0, TRACKER_LISTS_MAX) };
    } catch {
      stored = { fetchedAt: null, entries: [] };
    }
    this.stored = stored;
    return stored;
  }

  /** The kept trackers' addresses, in their order. */
  list(): string[] {
    return this.load().entries.map((e) => e.url);
  }

  entries(): TrackerListEntry[] {
    return [...this.load().entries];
  }

  /** When the kept trackers were last saved; null when nothing is kept. */
  fetchedAt(): Date | null {
    return this.load().fetchedAt;
  }

  /** Replaces the kept trackers. Written to a temporary file and renamed, so no reader sees half of it. Throws when the folder cannot be written. */
  save(entries: readonly TrackerListEntry[], fetchedAt: Date): void {
    const kept = entries.slice(0, TRACKER_LISTS_MAX).map((e) => ({ url: e.url, source: e.source }));
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ fetched_at: fetchedAt.toISOString(), trackers: kept }, null, 2)}\n`);
    renameSync(tmp, this.file);
    this.stored = { fetchedAt, entries: kept };
  }
}

/** The part of fetch a refresh uses; tests pass a fake. */
export type TrackerListFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TrackerListRead {
  source: string;
  /** `error`: no answer, not a 2xx, or no UDP tracker in it. */
  outcome: 'ok' | 'error';
  /** UDP trackers the list holds. */
  listed: number;
  detail: string | null;
}

export interface TrackerListsRefresh {
  /** `saved`: the file now holds the trackers that answered (and, for a list that could not be read, its previous ones); `kept`: the file was left as it was. */
  outcome: 'saved' | 'kept';
  lists: TrackerListRead[];
  /** New trackers asked for a connect. */
  asked: number;
  /** Of those, the ones that answered. */
  answered: number;
  /** Trackers in the file afterwards. */
  kept: number;
  detail: string | null;
}

export interface RefreshDeps {
  store: TrackerLists;
  fetch: TrackerListFetch;
  connect: ConnectTrackers;
  /** The tracker book's trackers now: not asked again. */
  known: () => readonly string[];
  sources?: readonly TrackerListSource[];
  now?: () => Date;
  signal?: AbortSignal;
  fetchTimeoutMs?: number;
  connectTimeoutMs?: number;
}

async function readList(source: TrackerListSource, deps: RefreshDeps, signal: AbortSignal): Promise<{ read: TrackerListRead; urls: string[] }> {
  const failed = (detail: string): { read: TrackerListRead; urls: string[] } => ({ read: { source: source.name, outcome: 'error', listed: 0, detail }, urls: [] });
  try {
    const answer = await deps.fetch(source.url, {
      headers: { 'user-agent': TORRENT_INDEX_USER_AGENT, accept: 'text/plain' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.fetchTimeoutMs ?? TRACKER_LIST_FETCH_TIMEOUT_MS)]),
    });
    if (!answer.ok) return failed(`HTTP ${answer.status}`);
    const urls = parseTrackerList(await answer.text());
    if (urls.length === 0) return failed('no udp tracker in the list');
    return { read: { source: source.name, outcome: 'ok', listed: urls.length, detail: null }, urls };
  } catch (err) {
    return failed(messageOf(err));
  }
}

/**
 * One refresh: read every list, ask the new UDP trackers for a connect, keep the ones that answer (in the lists'
 * order), and carry the previous trackers of a list that could not be read. When no tracker answered, or no list
 * was read, the file is left exactly as it was. Never throws.
 */
export async function refreshTrackerLists(deps: RefreshDeps): Promise<TrackerListsRefresh> {
  const sources = deps.sources ?? TRACKER_LIST_SOURCES;
  const signal = deps.signal ?? new AbortController().signal;
  const now = deps.now ?? ((): Date => new Date());
  const reads = await Promise.all(sources.map((source) => readList(source, deps, signal)));
  const lists = reads.map((r) => r.read);
  let known: readonly string[] = [];
  try {
    known = deps.known();
  } catch {
    known = [];
  }
  const taken = new Set([...DEFAULT_TRACKERS, ...known].map(trackerKey));
  const fresh: TrackerListEntry[] = [];
  for (const { read, urls } of reads) {
    for (const url of urls) {
      const key = trackerKey(url);
      if (taken.has(key) || fresh.length >= TRACKER_LISTS_ASK_MAX) continue;
      taken.add(key);
      fresh.push({ url, source: read.source });
    }
  }
  let answered = new Set<string>();
  if (fresh.length > 0) {
    try {
      answered = await deps.connect(
        fresh.map((e) => e.url),
        { timeoutMs: deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS },
      );
    } catch {
      answered = new Set();
    }
  }
  const verified = fresh.filter((e) => answered.has(e.url));
  const failed = new Set(lists.filter((l) => l.outcome === 'error').map((l) => l.source));
  const base = { lists, asked: fresh.length, answered: verified.length };
  const keep = (detail: string): TrackerListsRefresh => ({ ...base, outcome: 'kept', kept: deps.store.list().length, detail });
  if (signal.aborted) return keep('stopped');
  if (verified.length === 0) return keep(failed.size === lists.length ? 'no list could be read' : 'no tracker answered');
  const carried = deps.store.entries().filter((e) => failed.has(e.source) && !taken.has(trackerKey(e.url)));
  const next = [...verified, ...carried].slice(0, TRACKER_LISTS_MAX);
  try {
    deps.store.save(next, now());
  } catch (err) {
    return keep(`the file could not be written: ${messageOf(err)}`);
  }
  return { ...base, outcome: 'saved', kept: next.length, detail: null };
}

/** The daemon log's line for one refresh. */
export function refreshLine(r: TrackerListsRefresh): string {
  const lists = r.lists.map((l) => (l.outcome === 'ok' ? `${l.source} ${l.listed}` : `${l.source}: ${l.detail ?? 'error'}`)).join(', ');
  return r.outcome === 'saved'
    ? `[notesd] tracker lists: ${r.answered} of ${r.asked} new trackers answered, ${r.kept} kept (${lists})`
    : `[notesd] tracker lists: kept the previous ${r.kept} trackers, ${r.detail ?? 'nothing new'} (${lists})`;
}

/** What startBackground starts and closes. */
export interface TrackerListsHandle {
  readonly enabled: boolean;
  startLine(): string;
  start(): void;
  close(): Promise<void>;
}

export type TrackerListsOffReason = 'setting_off' | 'torrent_off' | 'discovery_off';

const OFF_TEXT: Record<TrackerListsOffReason, string> = {
  setting_off: 'NOTESD_TORRENT_TRACKER_LISTS=off',
  torrent_off: 'torrents are off (NOTESD_TORRENT=off or direct streaming off)',
  discovery_off: 'NOTESD_TORRENT_DISCOVERY=off asks no tracker',
};

/** No list is read and no tracker asked. */
export class DisabledTrackerLists implements TrackerListsHandle {
  readonly enabled = false;

  constructor(readonly reason: TrackerListsOffReason) {}

  startLine(): string {
    return `[notesd] tracker lists off: ${OFF_TEXT[this.reason]}`;
  }

  start(): void {}

  async close(): Promise<void> {}
}

export interface TrackerListsJobOptions {
  store: TrackerLists;
  fetch: TrackerListFetch;
  connect: ConnectTrackers;
  known: () => readonly string[];
  now?: () => Date;
  log?: (line: string) => void;
  /** Default TRACKER_LISTS_INITIAL_DELAY_MS. */
  initialDelayMs?: number;
  /** Default TRACKER_LISTS_CHECK_MS. */
  checkMs?: number;
  /** Default TRACKER_LISTS_EVERY_MS. */
  everyMs?: number;
}

/**
 * The daily loop: a minute after start, then every hour, it refreshes when the kept trackers are a day old (or none
 * are kept). Timers are unref'd; close stops the loop and aborts a running refresh.
 */
export class TrackerListsJob implements TrackerListsHandle {
  readonly enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly o: TrackerListsJobOptions) {
    this.now = o.now ?? ((): Date => new Date());
    this.log = o.log ?? ((line: string) => console.log(line));
  }

  startLine(): string {
    return `[notesd] tracker lists on: ${TRACKER_LIST_SOURCES.map((s) => s.name).join(' and ')} read once a day, the UDP trackers that answer kept in ${this.o.store.file}`;
  }

  start(): void {
    this.schedule(this.o.initialDelayMs ?? TRACKER_LISTS_INITIAL_DELAY_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const running = this.running;
    if (running !== null) await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      const at = this.o.store.fetchedAt();
      if (at === null || this.now().getTime() - at.getTime() >= (this.o.everyMs ?? TRACKER_LISTS_EVERY_MS)) {
        this.running = refreshTrackerLists({ store: this.o.store, fetch: this.o.fetch, connect: this.o.connect, known: this.o.known, now: this.now, signal: this.abort.signal }).then((r) => {
          if (!this.closed) this.log(refreshLine(r));
        });
        await this.running;
      }
    } catch (err) {
      this.log(`[notesd] tracker lists: ${messageOf(err)}`);
    } finally {
      this.running = null;
      this.schedule(this.o.checkMs ?? TRACKER_LISTS_CHECK_MS);
    }
  }
}

export interface TrackerListsOverrides {
  fetch?: TrackerListFetch;
  connect?: ConnectTrackers;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Off: no store for TorrentSource and a job that does nothing. On: the store TorrentSource reads and the job that fills it. */
export type TrackerListsBuild = { job: DisabledTrackerLists; lists: null } | { job: TrackerListsJob; lists: TrackerLists };

/**
 * The daemon's tracker lists. The one place the switches are read: NOTESD_TORRENT_TRACKER_LISTS (unset in a Config
 * literal: off), torrents on and built (`torrentsOn`), NOTESD_TORRENT_DISCOVERY.
 */
export function buildTrackerLists(torrent: TorrentConfig | undefined, torrentsOn: boolean, overrides: TrackerListsOverrides = {}): TrackerListsBuild {
  const off = (reason: TrackerListsOffReason): TrackerListsBuild => ({ job: new DisabledTrackerLists(reason), lists: null });
  if (torrent === undefined) return off('torrent_off');
  if (torrent.trackerLists !== true) return off('setting_off');
  if (!torrent.enabled || !torrentsOn) return off('torrent_off');
  if (!torrent.discovery) return off('discovery_off');
  const lists = new TrackerLists(join(torrent.dir, TRACKER_LISTS_FILE));
  const bookFile = join(torrent.dir, TRACKER_BOOK_FILE);
  const job = new TrackerListsJob({
    store: lists,
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    connect: overrides.connect ?? udpConnector(),
    // Read fresh at each refresh: a tracker learned from a magnet since is not asked again.
    known: () => new TrackerBook(bookFile).list(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
  return { job, lists };
}
```
**Impact:** new module, no caller yet. It reads `TorrentConfig.trackerLists`, which Step 4 adds: run `npm run typecheck` after Step 4.

### Step 3: TorrentSource adds the list trackers
**File:** `src/directStream/torrent/source.ts` — after line 6, :113-114, :478-494, :1074-1076, :1103
**Change:**

(a) After line 6 (`import { readMagnet, TRACKER_BOOK_FILE, TrackerBook, trackerKey } from './origins.js';`) add two lines (line 5's `./find/index.js` import is left untouched for phases 1-2):
```ts
import { scrapeTrackerOrder } from './find/scrape.js';
import type { TrackerLists } from './trackerLists.js';
```

(b) In `TorrentSourceOptions`, after
```ts
  /** The public trackers learned from pasted magnets (origins.ts), added to every torrent opened; null or unset: none. */
  book?: TrackerBook | null;
```
add:
```ts
  /**
   * The public tracker lists' trackers that answered a connect (trackerLists.ts), added after the candidate's and the
   * book's to every torrent opened and every scrape; null or unset: none (NOTESD_TORRENT_TRACKER_LISTS or discovery off).
   */
  lists?: Pick<TrackerLists, 'list'> | null;
```

(c) Replace lines 478-494 (`trackersOf` and `swarmCounts`), which today read:
```ts
  /** A candidate's trackers followed by the learned ones (the tracker book), without repeats. */
  private trackersOf(c: Pick<TorrentCandidate, 'trackers'>): string[] {
    return [...new Set([...c.trackers, ...(this.opts.book?.list() ?? [])])];
  }

  /** What the trackers know of each candidate's swarm, asked before any is joined; empty when nobody is asked or answers. */
  private async swarmCounts(candidates: readonly TorrentCandidate[], timeoutMs?: number): Promise<Map<string, SwarmCount>> {
    const scrape = this.opts.scrape ?? null;
    if (scrape === null || candidates.length === 0) return new Map();
    const trackers = [...DEFAULT_TRACKERS, ...(this.opts.book?.list() ?? []), ...candidates.flatMap((c) => c.trackers)];
    try {
      return await scrape(candidates.map((c) => c.infoHash), trackers, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (err) {
      this.log(`[notesd] torrent: the trackers could not be asked: ${messageOf(err)}`);
      return new Map();
    }
  }
```
with:
```ts
  /**
   * A candidate's trackers, then the learned ones (the tracker book), then the public lists' (trackerLists.ts),
   * without repeats: two spellings of one tracker (trackerKey) are one, the first kept.
   */
  private trackersOf(c: Pick<TorrentCandidate, 'trackers'>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of [...c.trackers, ...(this.opts.book?.list() ?? []), ...(this.opts.lists?.list() ?? [])]) {
      const key = trackerKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  /**
   * What the trackers know of each candidate's swarm, asked before any is joined; empty when nobody is asked or
   * answers. The defaults, the book and the candidates' own trackers come first; the list trackers get the last
   * places (scrapeTrackerOrder), so they are asked without making the scrape longer.
   */
  private async swarmCounts(candidates: readonly TorrentCandidate[], timeoutMs?: number): Promise<Map<string, SwarmCount>> {
    const scrape = this.opts.scrape ?? null;
    if (scrape === null || candidates.length === 0) return new Map();
    const trackers = scrapeTrackerOrder([...DEFAULT_TRACKERS, ...(this.opts.book?.list() ?? []), ...candidates.flatMap((c) => c.trackers)], this.opts.lists?.list() ?? []);
    try {
      return await scrape(candidates.map((c) => c.infoHash), trackers, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (err) {
      this.log(`[notesd] torrent: the trackers could not be asked: ${messageOf(err)}`);
      return new Map();
    }
  }
```
(`learnMagnet` at :501 keeps its own tracker lists and is not changed.)

(d) In `buildTorrentSource`'s `wiring` type, after
```ts
    /** Wyzie Synced (buildSubtitleSync); null or unset: no subtitle is re-timed. */
    sync?: { start(request: TorrentSyncRequest): unknown } | null;
```
add:
```ts
    /** The public tracker lists (buildTrackerLists in src/daemon.ts, which reads the switches); null or unset: none. */
    lists?: Pick<TrackerLists, 'list'> | null;
```

(e) Replace line 1103
```ts
    book: new TrackerBook(join(config.torrent.dir, TRACKER_BOOK_FILE)),
```
with:
```ts
    book: new TrackerBook(join(config.torrent.dir, TRACKER_BOOK_FILE)),
    lists: wiring.lists ?? null,
```
**Impact:** with `lists` unset (every existing test, a daemon with the switch off) `trackersOf` answers what it answered before for the same input (the learnMagnet test still expects `['udp://tracker.example:1337/announce', 'udp://p4p.arenabg.com:1337']`). The scrape now asks up to 16 trackers instead of 8 (Step 1).

### Step 4: The switch
**File:** `src/config.ts`:439, :1100 and the loadConfig comment after :1194
**Change:** in `TorrentConfig`, after
```ts
  /** `NOTESD_TORRENT_PEERS`: `host:port` addresses (comma-separated) added as a peer to every torrent. Empty by default. */
  peers: string[]
```
add:
```ts
  /**
   * `NOTESD_TORRENT_TRACKER_LISTS`, default on: once a day the public tracker lists (ngosang `trackers_best`,
   * newtrackon `stable`) are read and the UDP trackers on them that answer a BEP 15 connect are added to every
   * torrent opened and every scrape (src/directStream/torrent/trackerLists.ts). Needs `discovery`. Unset (a Config
   * literal, DEFAULT_TORRENT_CONFIG): off.
   */
  trackerLists?: boolean
```
In `parseTorrent`, after
```ts
    peers: parsePeers(env.NOTESD_TORRENT_PEERS),
```
add:
```ts
    trackerLists: parseSwitch('NOTESD_TORRENT_TRACKER_LISTS', env.NOTESD_TORRENT_TRACKER_LISTS),
```
`DEFAULT_TORRENT_CONFIG` is not changed (the field stays unset there: off).

In loadConfig's header comment, insert one new line immediately after
```ts
 * Torrent keys: NOTESD_TORRENT, NOTESD_TORRENT_DIR, NOTESD_TORRENT_UPLOAD_KBPS, NOTESD_TORRENT_KEEP_DAYS, NOTESD_TORRENT_SUBTITLE_WAIT_MS,
```
(:1194) and change nothing else in that comment:
```ts
 * NOTESD_TORRENT_TRACKER_LISTS (on or off; anything else throws ConfigError),
```
The next two lines (:1195 `NOTESD_TORRENT_DISCOVERY, NOTESD_TORRENT_PEERS …`, :1196 `NOTESD_TORRENT_MIN_SEEDS, …`) stay as they are: phase 2 rewrites :1197 (the index addresses), and the two unchanged lines between keep the hunks apart whichever lands first.
**Impact:** `parseTorrent({}, …)` now carries `trackerLists: true`; the two whole-object expectations in `tests/unit/config.torrent.test.ts` are updated in Step 9. A bad value (`maybe`) throws `ConfigError` like every switch (`parseSwitch`, default on for empty).

### Step 5: AppDeps carries the job
**File:** `src/deps.ts`:24 (imports) and after the `trending?: TrendingHandle | null;` field (:130)
**Change:** after `import type { TrendingHandle } from './directStream/trending/job.js';` add:
```ts
import type { TrackerListsHandle } from './directStream/torrent/trackerLists.js';
```
and after `trending?: TrendingHandle | null;` add:
```ts
  /**
   * The public tracker lists' daily refresh (src/directStream/torrent/trackerLists.ts). The daemon always sets it: a
   * DisabledTrackerLists unless NOTESD_TORRENT_TRACKER_LISTS, torrents and discovery are on. Started and closed by
   * startBackground; absent (tests): nothing runs.
   */
  trackerLists?: TrackerListsHandle | null;
```
**Impact:** optional field; no test that builds `AppDeps` changes.

### Step 6: The daemon builds it once
**File:** `src/daemon.ts` — imports (:39), torrent source wiring (:349-350), after `const torrents = buildTorrentStreams(config, directStream, db);` (:399), after the `deps.trending = buildTrending({...});` statement (:486-492)
**Change:**
(a) After `import { buildTorrentSource, type TorrentSource } from './directStream/torrent/source.js';` add:
```ts
import { buildTrackerLists } from './directStream/torrent/trackerLists.js';
```
(b) In `torrentSourceOf`'s `buildTorrentSource(config, torrents, { ... })` call, replace
```ts
        remux: torrentRemux,
        fallback: torrentSiteFallback,
```
with:
```ts
        remux: torrentRemux,
        fallback: torrentSiteFallback,
        // The public tracker lists' store, filled by startBackground's daily refresh; null when it is off.
        lists: trackerLists.lists,
```
(the closure runs at play time, after `trackerLists` below is set, as it already does for `embeddedSubtitles` and `whisperTier`, which are declared later in the function too).
(c) After
```ts
  const torrents = buildTorrentStreams(config, directStream, db);
```
add:
```ts
  // The public tracker lists (wider-torrent-sources phase 3): one store, read by every torrent opened and every scrape,
  // and the job that refreshes it once a day from startBackground. Off with NOTESD_TORRENT_TRACKER_LISTS, torrents or
  // discovery off: no store, and a job that does nothing.
  const trackerLists = buildTrackerLists(config.torrent, torrents !== null);
```
(d) After the `deps.trending = buildTrending({ ... });` statement add:
```ts
  // Started and closed by startBackground; never in a play's path.
  deps.trackerLists = trackerLists.job;
```
**Impact:** a live daemon with defaults reads the two lists a minute after start and once a day; one with the switch off logs the off line and does nothing.

### Step 7: startBackground starts and closes it
**File:** `src/background.ts` — after the trending block (:216-220), in the stop's `Promise.all` after `trending?.close(),` (:271), and the doc comment of `startBackground`
**Change:** after
```ts
  const trending = deps.trending ?? null;
  if (trending !== null) {
    console.log(trending.startLine());
    trending.start();
  }
```
add:
```ts

  // The public tracker lists (trackerLists.ts): built by the daemon (on with torrents and discovery), refreshed a minute
  // after start and once a day, closed on stop. A disabled one only logs why.
  const trackerLists = deps.trackerLists ?? null;
  if (trackerLists !== null) {
    console.log(trackerLists.startLine());
    trackerLists.start();
  }
```
In the stop function replace
```ts
      trending?.close(),
```
with:
```ts
      trending?.close(),
      trackerLists?.close(),
```
In the doc comment replace `With deps.trending, the daily trending list's loop.` with `With deps.trending, the daily trending list's loop; with deps.trackerLists, the public tracker lists' daily refresh.`
**Impact:** none for tests (they leave `deps.trackerLists` unset).

### Step 8: Fixtures
**Files:** `tests/fixtures/torrent/tracker-lists/ngosang-trackers_best.txt`, `tests/fixtures/torrent/tracker-lists/newtrackon-stable.txt` (new)
**Change:** copy the two real answers the analysis saved, byte for byte:
```sh
cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources
mkdir -p tests/fixtures/torrent/tracker-lists
cp .workflows/analyze/20261119-025431-K7QD-samples/ngosang-trackers_best.txt tests/fixtures/torrent/tracker-lists/ngosang-trackers_best.txt
cp .workflows/analyze/20261119-025431-K7QD-samples/newtrackon-stable.txt tests/fixtures/torrent/tracker-lists/newtrackon-stable.txt
```
Facts the tests rely on (computed from these files): ngosang lists 17 distinct UDP trackers (its 3 http lines are dropped), newtrackon 31; after the 7 `DEFAULT_TRACKERS` and the overlap, 31 are new: 11 first seen on ngosang (`open.tracker.cl` first, then `tracker.qu.ax`, `tracker.ducks.party`, `tracker.corpscorp.online`, `tracker.bittor.pw`, ...) and 20 on newtrackon (`retracker.hotplug.ru`, `evan.im`, ...). `tracker.qu.ax` is on both and is kept under ngosang; `tracker.bittor.pw` is on ngosang only.

### Step 9: Tests
**File A:** `tests/unit/directStream/torrent/trackerLists.test.ts` (new)
```ts
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

    // A daemon started again within the day reads the file and asks nothing.
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
```

**File B:** `tests/unit/directStream/torrent/find/scrape.test.ts` — line 2's import becomes:
```ts
import { connectPacket, deadLast, looksDead, readScrape, SCRAPE_LIST_SLOTS, SCRAPE_MAX_TRACKERS, scrapePacket, scrapeTrackerOrder, udpConnector, udpScraper, udpTrackerOf, udpTrackers, type ScrapeSocket } from '../../../../../src/directStream/torrent/find/scrape.js';
```
and append at the end of the file (it reuses the file's `fakeSocket`: a host whose answer is an array, even an empty one, answers the connect):
```ts

describe('the connect-only check (public tracker lists)', () => {
  it('sends only a connect to each tracker, once, and answers the addresses whose tracker replied', async () => {
    const net = fakeSocket({ 'one.example': [], 'two.example': [], 'mute.example': 'silent' });
    const answered = await udpConnector({ socket: () => net.socket })(
      ['udp://one.example:1337/announce', 'udp://ONE.example:1337', 'udp://two.example:80', 'udp://mute.example:6969', 'http://web.example/announce'],
      { timeoutMs: 30 },
    );
    expect([...answered].sort()).toEqual(['udp://one.example:1337/announce', 'udp://two.example:80']);
    expect(net.sent.every((s) => s.action === 0)).toBe(true);
    expect(net.sent.map((s) => s.host).sort()).toEqual(['mute.example', 'one.example', 'two.example']);
    expect(net.closed()).toBe(1);
  });

  it('opens no socket without a udp tracker, and answers what arrived when the time is up', async () => {
    let opened = 0;
    const connect = udpConnector({ socket: () => ((opened += 1), fakeSocket({}).socket) });
    expect((await connect(['http://web.example/announce'])).size).toBe(0);
    expect(opened).toBe(0);
    const started = Date.now();
    expect((await udpConnector({ socket: () => fakeSocket({ 'mute.example': 'silent' }).socket })(['udp://mute.example:1'], { timeoutMs: 30 })).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('the trackers one scrape asks', () => {
  it('keeps the last SCRAPE_LIST_SLOTS places for the list trackers, after the others, without repeats', () => {
    const first = Array.from({ length: 30 }, (_, i) => `udp://f${i}.example:1`);
    const lists = ['udp://f0.example:1/announce', ...Array.from({ length: 10 }, (_, i) => `udp://l${i}.example:1`)];
    const order = scrapeTrackerOrder(first, lists);
    expect(order).toHaveLength(SCRAPE_MAX_TRACKERS);
    expect(order.slice(0, SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS)).toEqual(first.slice(0, SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS));
    expect(order.slice(SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS)).toEqual(lists.slice(1, 1 + SCRAPE_LIST_SLOTS));
    // Few others: the list trackers fill the rest. No list: the others fill every place. Only UDP is asked.
    expect(scrapeTrackerOrder(first.slice(0, 3), lists)).toEqual([...first.slice(0, 3), ...lists.slice(1)]);
    expect(scrapeTrackerOrder(first, [])).toEqual(first.slice(0, SCRAPE_MAX_TRACKERS));
    expect(scrapeTrackerOrder(['http://web.example/announce', 'udp://a.example:1'], ['http://other.example/announce'])).toEqual(['udp://a.example:1']);
  });
});
```

**File C:** `tests/unit/directStream/torrentRotation.test.ts`
- Line 1: `import { mkdtempSync, readFileSync } from 'node:fs';` becomes `import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';`
- After line 4 (`import { describe, expect, it } from 'vitest';`) add `import { DEFAULT_TORRENT_CONFIG } from '../../../src/config.js';`
- After line 9 (the `source.js` import) add `import { buildTrackerLists, TRACKER_LISTS_FILE, TrackerLists } from '../../../src/directStream/torrent/trackerLists.js';`
- In `interface Fakes`, after `book?: TrackerBook;` add `lists?: { list(): string[] } | null;`
- In `setup`, after `...(o.book === undefined ? {} : { book: o.book }),` add `...(o.lists === undefined ? {} : { lists: o.lists }),`
- Append at the end of the file:
```ts

describe('TorrentSource: the public tracker lists', () => {
  const LISTED = 'udp://open.tracker.cl:1337/announce';

  it("opens and scrapes with the list trackers after the candidate's and the book's, without repeats", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notesd-lists-'));
    const book = new TrackerBook(join(dir, 'trackers.json'));
    book.add(['udp://p4p.arenabg.com:1337'], h(9));
    const asked: string[][] = [];
    const scrape: ScrapeTrackers = async (_hashes, trackers) => {
      asked.push([...trackers]);
      return new Map();
    };
    const lists = { list: () => [LISTED, 'udp://tracker.example:1337', 'udp://P4P.arenabg.com:1337/announce'] };
    const t = setup({ candidates: [candidate(1)], scrape, book, lists, probes: { [h(1)]: MP4_EN } });
    const { out } = await t.play();
    expect(out.ok).toBe(true);
    expect(t.openedWith[h(1)]).toEqual(['udp://tracker.example:1337/announce', 'udp://p4p.arenabg.com:1337', LISTED]);
    const first = asked[0] ?? [];
    expect(first.at(-1)).toBe(LISTED);
    expect(first.indexOf(LISTED)).toBeGreaterThan(first.indexOf('udp://tracker.example:1337/announce'));
    expect(first.indexOf(LISTED)).toBeGreaterThan(first.indexOf('udp://p4p.arenabg.com:1337'));
    expect(first.filter((x) => x.toLowerCase().includes('arenabg'))).toHaveLength(1);
  });

  it('a broken list file adds nothing and the play goes on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notesd-lists-'));
    writeFileSync(join(dir, TRACKER_LISTS_FILE), '{ not json');
    const t = setup({ candidates: [candidate(1)], lists: new TrackerLists(join(dir, TRACKER_LISTS_FILE)), probes: { [h(1)]: MP4_EN } });
    const { out } = await t.play();
    expect(out.ok).toBe(true);
    expect(t.openedWith[h(1)]).toEqual(['udp://tracker.example:1337/announce']);
  });

  it('switched off (the setting or discovery), a kept list file is not used; on, it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notesd-lists-'));
    new TrackerLists(join(dir, TRACKER_LISTS_FILE)).save([{ url: LISTED, source: 'ngosang' }], new Date());
    const torrent = { ...DEFAULT_TORRENT_CONFIG, enabled: true, dir, discovery: true };
    for (const off of [{ ...torrent, trackerLists: false }, { ...torrent, trackerLists: true, discovery: false }]) {
      const t = setup({ candidates: [candidate(1)], lists: buildTrackerLists(off, true).lists, probes: { [h(1)]: MP4_EN } });
      await t.play();
      expect(t.openedWith[h(1)]).toEqual(['udp://tracker.example:1337/announce']);
    }
    const on = setup({ candidates: [candidate(1)], lists: buildTrackerLists({ ...torrent, trackerLists: true }, true).lists, probes: { [h(1)]: MP4_EN } });
    await on.play();
    expect(on.openedWith[h(1)]).toEqual(['udp://tracker.example:1337/announce', LISTED]);
  });
});
```
(`buildTrackerLists` without overrides builds the real fetch and `udpConnector`, but nothing calls `start()` here, so no request is sent.)

**File D:** `tests/unit/config.torrent.test.ts`
- Line 9: in the expected object, after `peers: [],` insert `trackerLists: true,`.
- 'read every variable' (:12-26): in the env, after `NOTESD_TORRENT_PEERS: '127.0.0.1:6881, [::1]:7000,127.0.0.1:6881,seed.local:51413',` add `NOTESD_TORRENT_TRACKER_LISTS: 'off',`; in the expected object, after `peers: ['127.0.0.1:6881', '[::1]:7000', 'seed.local:51413'],` insert `trackerLists: false,`.
- After the `it('read how long a play may wait for its subtitle, and leave it unset by default', ...)` block add:
```ts

  it('read the tracker lists switch: on by default, unset in DEFAULT_TORRENT_CONFIG', () => {
    expect(parseTorrent({}, DATA).trackerLists).toBe(true);
    expect(parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'off' }, DATA).trackerLists).toBe(false);
    expect(parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'on' }, DATA).trackerLists).toBe(true);
    expect(() => parseTorrent({ NOTESD_TORRENT_TRACKER_LISTS: 'maybe' }, DATA)).toThrow(/NOTESD_TORRENT_TRACKER_LISTS must be "on" or "off"/);
    expect(DEFAULT_TORRENT_CONFIG.trackerLists).toBeUndefined();
  });
```
**Impact:** the suites above must pass; the rest of `npm test` is unaffected.

### Step 10: Configuration row
**File:** `docs/guide/reference/configuration.md`:173
**Change:** after the `NOTESD_TORRENT_PEERS` row (the line beginning with that variable's cell, default `unset`) and before the `NOTESD_TORRENT_MIN_SEEDS` row, insert:
```markdown
| `NOTESD_TORRENT_TRACKER_LISTS` | on | A minute after the daemon starts, and once a day after that, the public tracker lists ngosang `trackers_best` and newtrackon `stable` are read (one plain request each, saying it is notesd). Each UDP tracker on them that this machine does not hold yet is asked for a BEP 15 connect only (no torrent named, nothing announced, no peer contacted), and up to 20 that answer are kept in `<NOTESD_TORRENT_DIR>/tracker-lists.json` and added to every torrent opened and every tracker scrape, after the torrent's own trackers and the tracker book's. A list that cannot be read, or a day no tracker answers, keeps the trackers kept before; a play never waits for it. `off`: no list is read and none of its trackers is used. `NOTESD_TORRENT_DISCOVERY=off` does the same. Every `verify.sh` daemon sets it `off`. See [streaming.md](../streaming.md#public-tracker-lists). |
```
**Impact:** satisfies `envVarProblems()` (the code now reads `NOTESD_TORRENT_TRACKER_LISTS`). Not adjacent to the index rows (:177-180) phases 1-2 extend.

### Step 11: The streaming guide
**File:** `docs/guide/streaming.md` — :1742-1746, after :2199, :2214
**Change:**
(a) Replace the bullet at :1742-1746:
```markdown
- **The trackers are asked before a swarm is joined.** An index's seed count is its claim. Before the first torrent
  is opened the daemon asks up to eight UDP trackers what they hold for every candidate at once (a BEP 15 scrape,
  `find/scrape.ts`, 1.5 s at most): nothing is announced, no peer is contacted. A candidate for which at least two
  trackers answered and none knows a seeder is tried after all the others; it is never dropped, since DHT may still
  find peers. One tracker that does not know a torrent says nothing. `NOTESD_TORRENT_DISCOVERY=off` asks no tracker.
```
with:
```markdown
- **The trackers are asked before a swarm is joined.** An index's seed count is its claim. Before the first torrent
  is opened the daemon asks up to sixteen UDP trackers what they hold for every candidate at once (a BEP 15 scrape,
  `find/scrape.ts`, 1.5 s at most): nothing is announced, no peer is contacted. The default trackers, the tracker
  book's and the candidates' own come first; the last six places are kept for the
  [public tracker lists](#public-tracker-lists)' trackers. A candidate for which at least two
  trackers answered and none knows a seeder is tried after all the others; it is never dropped, since DHT may still
  find peers. One tracker that does not know a torrent says nothing. `NOTESD_TORRENT_DISCOVERY=off` asks no tracker.
```
(b) After the last bullet of "### What a magnet says of its index" (the line starting `- **The swarm.**`) and before `## Where the code is`, insert:
```markdown

### Public tracker lists

A torrent finds its first peers through its trackers. Besides the seven default trackers and the tracker book, the
daemon keeps a list read from two public lists that check their trackers themselves: ngosang's `trackers_best` and
newtrackon's `stable` (`src/directStream/torrent/trackerLists.ts`).

- **When.** A minute after the daemon starts, then every hour it looks whether the kept list is a day old, and reads
  the two lists again when it is. A daemon started again within the day reads nothing.
- **What is kept.** Only UDP trackers, and only ones this machine does not hold already. Each is asked for a BEP 15
  connect, the first step of a scrape (`udpConnector` in `find/scrape.ts`): no torrent is named, nothing is
  announced and no peer is contacted. Up to 20 that answer are kept in `<NOTESD_TORRENT_DIR>/tracker-lists.json`
  (`fetched_at`, and each tracker with the list that named it first), per machine.
- **Where they go.** Every torrent opened announces to them after its own trackers and the tracker book's, and every
  scrape before a play asks them in its last six places. Two spellings of one tracker count once.
- **When it fails.** A list that cannot be read keeps the trackers it gave last time; a day both lists are down, or no
  tracker answers (a network that drops UDP), keeps the whole file as it was. It runs beside the daemon, never in a
  play: a play only reads the kept file, and a missing or broken one is no tracker.
- **Off.** `NOTESD_TORRENT_TRACKER_LISTS=off` reads no list and adds none of its trackers, and so does
  `NOTESD_TORRENT_DISCOVERY=off`. The daemon log says which at start (`[notesd] tracker lists off: ...`).
```
(c) In "## Where the code is", replace the row
```markdown
| `src/directStream/torrent/find/scrape.ts`, `src/directStream/torrent/origins.ts` | The tracker scrape before a play (seeders the trackers know); a magnet's index by its trackers (`KNOWN_ORIGINS`) and the tracker book |
```
with:
```markdown
| `src/directStream/torrent/find/scrape.ts`, `src/directStream/torrent/origins.ts`, `src/directStream/torrent/trackerLists.ts` | The tracker scrape before a play (seeders the trackers know) and the connect-only check; a magnet's index by its trackers (`KNOWN_ORIGINS`) and the tracker book; the public tracker lists, read and checked once a day |
```
**Impact:** docs only; the anchor `#public-tracker-lists` is the one the configuration row links.

### Step 12: CLAUDE.md
**File:** `CLAUDE.md`:120
**Change:** after the Direct streaming bullet about `/update-cloud-source <magnet>` (the one naming `TorrentSource.learnMagnet` and the tracker book, :120), insert:
```markdown
  - Public tracker lists (`torrent/trackerLists.ts`, `NOTESD_TORRENT_TRACKER_LISTS`, needs discovery): a minute after start and once a day, ngosang `trackers_best` and newtrackon `stable` are read and each new UDP tracker gets a BEP 15 connect only (`udpConnector` in `find/scrape.ts`: no info hash, no announce); up to 20 that answer go into `<torrent dir>/tracker-lists.json`, added after the candidate's and the book's trackers to every open (`trackersOf`) and every scrape (the last `SCRAPE_LIST_SLOTS` of `SCRAPE_MAX_TRACKERS`, `scrapeTrackerOrder`). A refresh that reads nothing or hears nothing keeps the previous file; it never runs in a play's path. `buildTrackerLists` is the one place the switches are read; tests inject the fetch, the socket and the clock, and `verify.sh` pins it off.
```
**Impact:** docs only.

### Step 13: The verify harness never reads the lists
**File:** `.claude/skills/verify-notesd/scripts/verify.sh`:262
**Change:** in the base `env=(...)` array, after
```sh
    # A throwaway daemon never writes into the owner's torrent folder either.
    NOTESD_TORRENT_DIR="$dir/data/movies/torrents"
```
add:
```sh
    # A throwaway daemon never reads the public tracker lists or asks their trackers (torrent/trackerLists.ts),
    # with or without --torrent (whose discovery is off anyway).
    NOTESD_TORRENT_TRACKER_LISTS=off
```
**Impact:** every `up` (with or without `--torrent`) logs `[notesd] tracker lists off: NOTESD_TORRENT_TRACKER_LISTS=off` and writes no `tracker-lists.json` (Invariant 3).

### Step 14: The feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md`:574
**Change:** in "## Torrent rotation, tracker scrape, RuTracker and a magnet's index", after the `/update-cloud-source <magnet>` bullet (its last line names `origin.index` and `rutracker`) add:
```markdown
- Public tracker lists (`NOTESD_TORRENT_TRACKER_LISTS`, default on, needs `NOTESD_TORRENT_DISCOVERY`): a minute after start and
  once a day ngosang `trackers_best` and newtrackon `stable` are read, each new UDP tracker gets a BEP 15 connect only,
  up to 20 that answer are kept in `<torrent dir>/tracker-lists.json` and added after the candidate's and the book's
  trackers to every torrent opened and every scrape; a failed refresh keeps the previous file. Proven by
  `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts tests/unit/directStream/torrent/find/scrape.test.ts tests/unit/directStream/torrentRotation.test.ts tests/unit/config.torrent.test.ts`
  (fake fetch, socket and clock; the two lists' real answers in `tests/fixtures/torrent/tracker-lists/`). Every throwaway
  daemon pins it off: `$V up` logs `[notesd] tracker lists off: NOTESD_TORRENT_TRACKER_LISTS=off` and its torrent folder
  holds no `tracker-lists.json`. Live: `jq '.trackers | length' <NOTESD_TORRENT_DIR>/tracker-lists.json` a minute after a
  restart, and the daemon log's `[notesd] tracker lists: N of M new trackers answered` line.
```
**Impact:** docs only.

## Principles applied

- Laziness protocol: the connect-only check reuses `find/scrape.ts`'s `ScrapeSocket` seam, `connectPacket`, `udpTrackers` and `trackerKey` instead of a second UDP client; the store is a JSON file beside the tracker book (no table, no migration); the daily loop copies TrendingJob's timer shape instead of adding a scheduler; the two list addresses are constants, not settings.
- Boundary discipline: the three switches (`NOTESD_TORRENT_TRACKER_LISTS`, torrents built, `NOTESD_TORRENT_DISCOVERY`) are read in one place, `buildTrackerLists`; `buildTorrentSource` and `TorrentSource` trust the store they are handed (null = off) and re-check nothing. List text is validated once in `parseTrackerList` (UDP only, through `udpTrackerOf`), the file once in `TrackerLists.load`.
- Make illegal states unrepresentable: `TrackerListsBuild` is the union `{ job: DisabledTrackerLists; lists: null } | { job: TrackerListsJob; lists: TrackerLists }`, so a running job with no store, or a store whose job is off, cannot be built; `trackerLists` is optional on `TorrentConfig` with "unset = off", so no existing `Config` literal in a test can switch it on by accident.
- Test behavior, not implementation: the tests assert observable state: the bytes of `tracker-lists.json` (written, or byte-identical after a failed refresh), the trackers handed to `swarm.open` and to the scraper, the packets a fake socket received, the requests a fake fetch saw; never private calls.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources && npm run typecheck`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/wider-torrent-sources && npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts tests/unit/directStream/torrent/find/scrape.test.ts tests/unit/directStream/torrentRotation.test.ts tests/unit/config.torrent.test.ts tests/unit/docs/reference.test.ts && npm test`
**Proof:** the unit suites drive the real module against the two lists' real answers with an injected fetch, socket and clock (a real refresh would reach the public lists and real trackers, which Invariant 3 forbids); the throwaway daemon proves the switch end to end.
- Harness: `.claude/skills/verify-notesd` (J5); J1-J4 are vitest runs with fakes.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Torrent rotation, tracker scrape, RuTracker and a magnet's index", the new "Public tracker lists" bullet)
- Journeys (run from `/home/miftah/.worktrees/mcp-notes/wider-torrent-sources`):
  - **J1** · traces R3.1 — `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts -t "keeps the new trackers that answer"`, then `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts -t "runs a minute after start"`, then `npx vitest run tests/unit/directStream/torrent/find/scrape.test.ts -t "connect-only"` → passes when all three report every test passed: the fake fetch saw exactly the ngosang and newtrackon addresses with notesd's User-Agent; the file reads `{"fetched_at": "2026-11-19T03:00:00.000Z", "trackers": [open.tracker.cl (ngosang), tracker.qu.ax (ngosang), evan.im (newtrackon)]}` (only the trackers that answered the connect, none of the defaults or the book's); the fake socket received only action-0 (connect) packets; and the job fetched at 60 s, not again 23 h later, again at 24 h, never after `close()`, and not after a restart within the day.
  - **J2** · traces R3.2 — `npx vitest run tests/unit/directStream/torrentRotation.test.ts -t "public tracker lists"` and `npx vitest run tests/unit/directStream/torrent/find/scrape.test.ts -t "the trackers one scrape asks"` → passes when the torrent was opened with exactly `['udp://tracker.example:1337/announce', 'udp://p4p.arenabg.com:1337', 'udp://open.tracker.cl:1337/announce']` (candidate, book, list; the other spellings dropped), the scrape's tracker list ends with `udp://open.tracker.cl:1337/announce` after the candidate's and the book's trackers with `arenabg` once, and `scrapeTrackerOrder` gives the list trackers the last 6 of 16 places.
  - **J3** · traces R3.3 — `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts -t "cannot be read"`, `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts -t "reading never throws"` and `npx vitest run tests/unit/directStream/torrentRotation.test.ts -t "broken list file"` → passes when `tracker-lists.json` is byte-identical after a refresh with both lists down (HTTP 503 and a thrown fetch: outcome `kept`, 0 trackers asked), after one where no tracker answered, and after one whose connect threw; a refresh with only newtrackon down keeps newtrackon's previous `evan.im` beside ngosang's new `tracker.qu.ax`; a missing, broken or odd file lists no or only valid trackers without throwing; and a play with a broken list file answers `ok: true`, opened with the candidate's tracker alone.
  - **J4** · traces R3.4 — `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts -t "fetches no list"`, `npx vitest run tests/unit/directStream/torrentRotation.test.ts -t "switched off"` and `npx vitest run tests/unit/config.torrent.test.ts -t "tracker lists switch"` → passes when, for the setting off, `DEFAULT_TORRENT_CONFIG`, discovery off, torrents off and no torrent config, `buildTrackerLists` answers `lists: null` with a disabled job naming the reason, and two fake days pass with zero fetches, zero connects and no file written; a torrent opened while an existing `tracker-lists.json` lies in the folder, with the setting off or discovery off, carries only its own tracker (with it on, the kept one too); and `NOTESD_TORRENT_TRACKER_LISTS` parses on by default, `off` to false, and `maybe` throws.
  - **J5** · traces R3.4 — `V=.claude/skills/verify-notesd/scripts/verify.sh; OUT=$($V up); echo "$OUT"; RUN=$(echo "$OUT" | sed -n 's/^RUN=//p'); LOG=$(echo "$OUT" | sed -n 's/^LOG=//p'); for i in $(seq 15); do grep -qF '[notesd] tracker lists off: NOTESD_TORRENT_TRACKER_LISTS=off' "$LOG" && break; sleep 1; done; grep -F 'tracker lists' "$LOG"; test ! -e "$(dirname "$LOG")/data/movies/torrents/tracker-lists.json" && echo NO-LIST-FILE; $V down "$RUN"` → passes when the grep prints exactly the line `[notesd] tracker lists off: NOTESD_TORRENT_TRACKER_LISTS=off` (no `tracker lists on` and no `new trackers answered` line) and `NO-LIST-FILE` is printed.
- Neighbor check: the tracker book and the scrape before a play, which the `trackersOf`/`swarmCounts` rewrite and the cap change touch: `npx vitest run tests/unit/directStream/torrentRotation.test.ts tests/unit/directStream/torrent/origins.test.ts tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrent/find/scrape.test.ts` → passes when every pre-existing test passes unchanged (the learnMagnet test still sees the torrent opened with `['udp://tracker.example:1337/announce', 'udp://p4p.arenabg.com:1337']` and the book file holding `['udp://p4p.arenabg.com:1337']`; a dead swarm still goes last).
- Cost: none (no LLM turn, no billed call; J5 is a plain `verify.sh up` with no `--torrent` fixture build).

**Exit criteria:** `npm run typecheck` and `npm test` pass (including `tests/unit/docs/reference.test.ts`); J1-J5 pass; a daemon with `NOTESD_TORRENT_TRACKER_LISTS=off` opens and scrapes with exactly the trackers it used before this phase (only the scrape cap, 8 -> 16, differs).

## Handoffs

- **Trending's swarm probe** (`src/directStream/trending/job.ts`, `peek(hash, TRENDING_TRACKERS, ...)`) opens a swarm with its own tracker list and does not get the list trackers. R3.2 is about the torrents `TorrentSource` opens and scrapes; Trending is out of the plan's scope ("Out of scope: ... Trending"). No phase of this set owns it; a later change can hand `trackerLists.lists` to `buildTrending` if the owner wants it.
- **loadConfig's key-list comment** (reconciled): this phase names `NOTESD_TORRENT_TRACKER_LISTS` on a new line of its own after :1194 (Step 4); phase 1 does not touch the comment and phase 2 rewrites only :1197, so :1195-1196 separate the hunks.
- **CLAUDE.md placement** (reconciled): this phase inserts after :120 (the `/update-cloud-source <magnet>` bullet); phase 1 inserts before :116 and phase 2 directly after phase 1's bullet (also before :116), so :116-120 stay unchanged between them and this hunk.
- **`tests/unit/config.torrent.test.ts`:** this phase adds `trackerLists` to the two whole-object expectations (:9, :25). If Phase 1 or 2 changes `parseTorrent`'s default output too (it should not: `finder: { indexes: {} }` stays empty without env), the reconciler merges both keys into those objects.
- No criterion is handed off: R3.1-R3.4 are all traced here.

## Rollback

Revert this phase's commits: delete `src/directStream/torrent/trackerLists.ts`, its test and fixtures; restore `find/scrape.ts` (cap 8, no connector), `source.ts` (`trackersOf`, `swarmCounts`, the `lists` option and wiring), `config.ts`, `deps.ts`, `daemon.ts`, `background.ts`, the four doc and harness files and the three edited tests. Nothing in the database changes. At run time, without a revert: `NOTESD_TORRENT_TRACKER_LISTS=off` in `.env.local`, restart with `scripts/install.sh --wait`, and delete `<NOTESD_TORRENT_DIR>/tracker-lists.json`.

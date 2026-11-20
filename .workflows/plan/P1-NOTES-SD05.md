> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 5. Source: `.workflows/plan/stream-downloads-season-story/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: The Cache page: Downloading filter, progress bars, why a row downloads

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R4, R5. The Cache page shows what downloads beside what is downloaded, can filter to it, and shows each download's live progress and the reason it downloads
**Criteria:** R4.1, R4.2, R4.3, R5.1
**Depends on:** Phase 4, and through it Phases 1 to 3
**Difficulty:** NORMAL
**Package:** `src/directStream` (cacheShelf), `web/src/components/movies`

---

## Goal

`GET /api/stream/disk` (and `stream_disk`) says, for every film and episode that is downloading now, how far along it is, whether it is queued, running or paused, and why it downloads: `asked` (the owner's download queue or the owner's cloud cache), `ahead` (the next episode the fetch-ahead holds) or `pause` (an `auto` cloud cache a pause started). Seasons and titles roll their episodes up. A download that is queued with nothing on disk yet gets a 0-byte row. On the Cache page, every downloading row has a progress bar and a reason chip in both views. A Downloading toggle with a count lists only what downloads, unfolded, and a second click returns to the default view. While anything downloads, the page reads the disk every 3 s instead of every 15 s.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing. (Inside `CachePage.tsx` the private `RowProps.open: ReadonlySet<string>` becomes `isOpen: (key) => boolean`, plus a new `only: boolean`. It is module-private.)
**Creates:**
- `cacheShelf.ts`: types `DownloadWhy` (`'asked' | 'ahead' | 'pause'`), `DownloadState` (`'queued' | 'running' | 'paused'`), `ShelfDownloading {progress, why, state}`, `ShelfDownloadRollup {count, progress, why: DownloadWhy[], state}`, `ShelfQueued {kind, tmdbId, season, episode, state, progress}`, `ShelfDownloadQueue {list(): Promise<ShelfQueued[]>}`; exported function `rollup(items)`. New fields: `ShelfEpisode.downloading: ShelfDownloading | null`, `ShelfSeason.downloading: ShelfDownloadRollup | null`, `ShelfTitle.downloading: ShelfDownloadRollup | null`, `ShelfView.downloading: number`. New options: `CacheShelfOptions.downloads?: ShelfDownloadQueue | null` and `CacheShelfOptions.ahead?: () => StreamRef | null`. New required member: `ShelfCaches.activity(id): CacheActivity | null`.
- `cache/service.ts`: `export interface CacheActivity {state: 'queued' | 'running'; ahead: boolean; progress: number | null}` and the read-only `StreamCache.activity(id: string): CacheActivity | null`.
- `ahead.ts`: read-only `EpisodeAhead.fetching(): StreamRef | null`.
- `service.ts`: read-only `DirectStreamService.aheadFetching(): StreamRef | null`, which passes `EpisodeAhead.fetching` through.
- `web/src/moviesApi.ts`: types `DiskWhy`, `DiskDownloadState`, `DiskDownloading`, `DiskDownloadRollup`; fields `DiskEpisode.downloading`, `DiskSeason.downloading`, `DiskTitle.downloading`, `DiskView.downloading`.
- `CachePage.tsx`: `export const FAST_REFRESH_MS = 3_000`.

**Signature changes:** `ShelfCaches` gains `activity(id)`. Every implementer has to provide it: `StreamCache` (this phase) and the test fakes (updated here).
**Requires (from earlier phases):**
- Phase 2 (reconciled): `StreamDownloads.list(filter?)` (`src/directStream/downloads/service.ts`), reachable as `AppDeps.streamDownloads` (`StreamDownloads | null | undefined`). Called with no filter, it answers phase 2's `DownloadView[]` (`src/directStream/downloads/types.ts`): **this host's** queued, running, paused and failed rows (never `done`, never cancelled), each with `kind: 'movie' | 'tv'`, `tmdb_id: number`, `season: number | null`, `episode: number | null` (both null for a film), `state` and a live `progress` from 0 to 1 (a torrent's bytes on disk over its file's length, a season pack's episode through phase 3's job, a cloud cache's `progress`). The only code that reads this shape is the adapter in `src/daemon.ts` (Step 5).
- Phase 2: a cloud download it runs goes through `StreamCache.request(ref, {maxHeight: 1080})` as the owner's (`auto: false`). The shelf then reads the cache as `asked` even without the queue row, and when both name the same slot the queue's progress wins.
- Phase 4: `POST /api/stream/downloads` exists. Only the Proof uses it, in J3.

**Leaves alone (owned by others):** `CacheShelf.remove/undo/execute`, `freeable`, `targetInUse`, `watchedTargets`, `UNDO_MS` (deletion rules and the undo window, unchanged); `src/http/streamDiskApi.ts`, whose `c.json(view())` already passes the new fields, so it is left unchanged; `/api/stream/downloads*` and the downloads client in `web/src/moviesApi.ts` (Phase 4); the title page, `MovieDetail.tsx`, `EpisodeList.tsx` (Phases 7, 8); `docs/guide/movies.md` prose, `img/movies/cache.png`, `.claude/skills/verify-notesd/features/*.md` (Phase 9); `src/directStream/downloads/*` (Phases 2, 3); how `EpisodeAhead` and `StreamCache` behave (only getters are added).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/cache/service.ts` | modify | `CacheActivity` type (after `CachePreviewView`, ~line 80); `activity(id)` after `busy` (line 379–383) |
| `src/directStream/ahead.ts` | modify | `fetching()` after `close()` (line 158–162) |
| `src/directStream/service.ts` | modify | `aheadFetching()` after `watched()` (line 576–582) |
| `src/directStream/cacheShelf.ts` | modify | imports (1–8); new types (after line 37); fields on `ShelfEpisode` (39), `ShelfSeason` (54), `ShelfTitle` (68), `ShelfView` (107); `ShelfCaches` (161); `CacheShelfOptions` (174); helpers after `sxe` (204); `Slot` (208); `view()` (268); `read()` (417); `describe()` (499) |
| `src/daemon.ts` | modify | `new CacheShelf({...})` at line 566–576 gains `downloads` and `ahead` |
| `src/mcp/streamDiskTool.ts` | modify | `DESCRIPTION` (12–17), `titleView` (53–81), list summary (101–109) |
| `scripts/docs/httpRoutes.ts` | modify | `'GET /api/stream/disk'` description (329–330) |
| `docs/guide/reference/http-api.md`, `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `web/src/moviesApi.ts` | modify | disk types (865–930) and `fetchStreamDisk` (935–949) |
| `web/src/components/movies/CachePage.tsx` | rewrite | filter toggle, bars, chips, 3 s refresh, fold model |
| `web/src/components/movies/CachePage.css` | modify | `.cp-dl`, `.cp-bar`, `.cp-why`, `.cp-pct`, `.cp-bulkbtn.on` |
| `web/src/components/movies/CachePage.test.tsx` | rewrite | fixtures carry `downloading`; tests for the default view, the filter, the refresh |
| `tests/unit/directStream/cacheShelf.test.ts` | modify | `cloudRow`, `build` fakes; new `describe('what downloads now, and why')` |
| `tests/unit/directStream/ahead.test.ts` | modify | one test for `fetching()` |
| `tests/unit/mcp.streamDiskTool.test.ts` | modify | fixtures carry `downloading`; one test for it |
| `tests/integration/directStream.cache.int.test.ts` | modify | `activity()` asserted in the ahead-gives-way test (line 419) |

## Implementation Steps

### Step 1: `StreamCache.activity`: how a cache downloads now
**File:** `src/directStream/cache/service.ts`. Add the type after `CachePreviewView` (ends line 80) and the method right after `busy` (line 379–383).
**Change:** this is a read-only getter. The `ahead` mark lives only in memory (`aheadRunning`, and `Waiting.ahead` for one waiting or yielded), so the page cannot learn it from the row.
**Code:**
```ts
/**
 * How this host's cache downloads now, for the Cache page: `running` or `queued` (waiting its turn, a yielded ahead
 * download included); `ahead` when it was fetched for the next episode (ahead.ts), which only memory knows;
 * `progress` the running job's share of its segments, null before it knows its plan or while it waits.
 */
export interface CacheActivity {
  state: 'queued' | 'running';
  ahead: boolean;
  progress: number | null;
}
```
```ts
  /** How the cache downloads now (the Cache page's bar and reason); null while it neither runs nor waits. Changes nothing. */
  activity(id: string): CacheActivity | null {
    const key = id.toLowerCase();
    const job = this.running.get(key);
    if (job !== undefined) {
      const p = job.progress();
      return { state: 'running', ahead: this.aheadRunning.has(key), progress: p === null || p.segmentsTotal === 0 ? null : p.segmentsDone / p.segmentsTotal };
    }
    const waiting = this.waiting.find((w) => w.id === key);
    return waiting === undefined ? null : { state: 'queued', ahead: waiting.ahead === true, progress: null };
  }
```
**Impact:** none on behaviour. `StreamCache` now satisfies the widened `ShelfCaches` (Step 4).

### Step 2: `EpisodeAhead.fetching`: the episode a torrent is fetched for
**File:** `src/directStream/ahead.ts`, after `close()` (line 158–162).
**Code:**
```ts
  /** The episode a torrent is being fetched for ahead (the Cache page's `ahead` reason), or null. Changes nothing. */
  fetching(): StreamRef | null {
    return this.held?.ref ?? null;
  }
```
**Impact:** none. `StreamRef` is already imported (line 1).

### Step 3: `DirectStreamService.aheadFetching`
**File:** `src/directStream/service.ts`, right after phase 2's `torrentsOnScreen()` (which phase 2 inserts after `watched(...)`, line 582 today).
**Code:**
```ts
  /** The next episode a torrent is fetched for now (ahead.ts), for the Cache page; null without `ahead` or with none held. */
  aheadFetching(): StreamRef | null {
    return this.ahead?.fetching() ?? null;
  }
```
**Impact:** none. `StreamRef` is already imported (line 43). Phase 2 (an earlier phase) inserts `downloadFacts` and `torrentsOnScreen` right after `watched` too: put `aheadFetching` after phase 2's `torrentsOnScreen()` (the file as phase 2 leaves it), so the two additions stay apart.

### Step 4: The shelf reads what downloads
**File:** `src/directStream/cacheShelf.ts`

**4a. Imports (lines 1–8).** Replace them with:
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StreamCacheRow, StreamTorrentRow } from '../db/schema.js';
import type { SeasonView, TitleListItem } from '../movies/read.js';
import { titleId } from '../movies/types.js';
import type { CacheActivity } from './cache/service.js';
import { TorrentError } from './torrent/types.js';
import { slotId, type SlotKey, type TorrentUsage } from './torrent/usage.js';
import type { StreamRef } from './types.js';
```

**4b. New types**, inserted after `export type ShelfKind = 'torrent' | 'cloud';` (line 37):
```ts
/**
 * Why a film or episode downloads now: `asked`, the owner asked for it (a row of the download queue, or a cloud cache
 * the owner asked for); `ahead`, the next episode fetched while one plays (ahead.ts); `pause`, a cloud cache a pause
 * in the player started. A torrent that downloads only because it plays is not counted: it is `playing`.
 */
export type DownloadWhy = 'asked' | 'ahead' | 'pause';
/** `queued`: waits its turn; `running`: fetches now; `paused`: a download asked for that gives way to a torrent on screen. */
export type DownloadState = 'queued' | 'running' | 'paused';

/** A film's or an episode's download. */
export interface ShelfDownloading {
  /** 0 to 1. */
  progress: number;
  why: DownloadWhy;
  state: DownloadState;
}

/** A season's or a title's downloads rolled up (a film: its own, `count` 1). */
export interface ShelfDownloadRollup {
  /** Films and episodes downloading. */
  count: number;
  /** Their mean progress, 0 to 1. */
  progress: number;
  /** Every reason among them, `asked` first. */
  why: DownloadWhy[];
  /** `running` when any runs, else `queued` when any waits, else `paused`. */
  state: DownloadState;
}

/** One film or episode the download queue (src/directStream/downloads) holds and has not finished. Film: season 0, episode 0. */
export interface ShelfQueued {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season: number;
  episode: number;
  state: DownloadState;
  progress: number;
}

/** What the shelf reads of the download queue: this host's downloads not done and not failed. */
export interface ShelfDownloadQueue {
  list(): Promise<ShelfQueued[]>;
}
```

**4c. View types.** Add the field as the last member of each interface:
- `ShelfEpisode` (after `in_use: boolean;`, line 51):
```ts
  /** Downloading now: how far, why, queued or running; null when it does not. */
  downloading: ShelfDownloading | null;
```
- `ShelfSeason` (after `in_use: boolean;`, line 64, before `episodes`):
```ts
  /** Its episodes that download now, rolled up; null when none does. */
  downloading: ShelfDownloadRollup | null;
```
- `ShelfTitle` (after `shared_bytes: number;`, line 90):
```ts
  /** A film's download, or a series' episodes downloading, rolled up; null when nothing of it downloads. */
  downloading: ShelfDownloadRollup | null;
```
- `ShelfView` (after `titles: ShelfTitle[];`, line 117):
```ts
  /** Films and episodes downloading now (the Downloading filter's count). */
  downloading: number;
```

**4d. `ShelfCaches` (line 161–165).** Replace it with:
```ts
/** What the shelf needs of StreamCache. */
export interface ShelfCaches {
  diskUsage(): Promise<{ row: StreamCacheRow; bytes: number }[]>;
  busy(id: string): boolean;
  /** How the cache downloads now; null while it neither runs nor waits. */
  activity(id: string): CacheActivity | null;
  remove(id: string): Promise<void>;
}
```

**4e. `CacheShelfOptions` (line 174–189).** Replace it with:
```ts
export interface CacheShelfOptions {
  host: string;
  torrents: ShelfTorrents | null;
  caches: ShelfCaches | null;
  /** The download queue (src/directStream/downloads): what the owner asked for and is not done. Null or unset: none. */
  downloads?: ShelfDownloadQueue | null;
  /** The episode the fetch-ahead holds a torrent for (DirectStreamService.aheadFetching). Unset: none. */
  ahead?: () => StreamRef | null;
  /** movies/read.ts titleWatchViews, bound to the database and this host. */
  titles: (ids: readonly string[]) => Promise<Map<string, { item: TitleListItem; seasons: SeasonView[] }>>;
  /** The stream on screen and the plays being started. */
  live: () => LiveSlot[];
  /** The JSON file holding the pending deletions. */
  pendingFile: string;
  undoMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** setTimeout, unref'd. Tests pass their own and fire it. */
  later?: (fn: () => void, ms: number) => () => void;
}
```

**4f. Helpers**, inserted right after the `sxe` arrow (ends line 205):
```ts
const WHY_ORDER: readonly DownloadWhy[] = ['asked', 'ahead', 'pause'];
/** A share kept inside 0..1 and rounded to a tenth of a percent. */
const unit = (n: number): number => (Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000 : 0);

/** One slot named by several sources keeps the strongest reason: the owner's ask, then ahead, then a pause. */
function stronger(was: ShelfDownloading | null, next: ShelfDownloading): ShelfDownloading {
  return was === null || WHY_ORDER.indexOf(next.why) < WHY_ORDER.indexOf(was.why) ? next : was;
}

/** Films' and episodes' downloads rolled up for a season or a title; null when there are none. */
export function rollup(items: readonly ShelfDownloading[]): ShelfDownloadRollup | null {
  if (items.length === 0) return null;
  return {
    count: items.length,
    progress: unit(items.reduce((n, d) => n + d.progress, 0) / items.length),
    why: WHY_ORDER.filter((w) => items.some((d) => d.why === w)),
    state: items.some((d) => d.state === 'running') ? 'running' : items.some((d) => d.state === 'queued') ? 'queued' : 'paused',
  };
}

const downloadingOf = (e: ShelfEpisode): ShelfDownloading[] => (e.downloading === null ? [] : [e.downloading]);

/** The fetch-ahead's episode names this torrent row's slot. */
function sameSlot(ref: StreamRef, row: { kind: 'movie' | 'tv'; tmdbId: number; season: number; episode: number }): boolean {
  return ref.kind === row.kind && ref.tmdbId === row.tmdbId && (ref.kind === 'movie' || (ref.season === row.season && ref.episode === row.episode));
}
```

**4g. `Slot` (line 208–217).** Replace it with:
```ts
/** One film or episode on disk: its bytes per torrent and per cache. */
interface Slot {
  season: number;
  episode: number;
  torrent: number;
  cloud: number;
  byHash: Map<string, number>;
  byCache: Map<string, number>;
  targets: DeletionTarget[];
  inUse: boolean;
  /** Downloading now, and why; a slot downloading with nothing on disk yet has no targets. */
  downloading: ShelfDownloading | null;
}
```

**4h. `view()` (line 268–304).** Replace the whole method with:
```ts
  /** What this host keeps on disk for streaming, largest title first, without what a pending deletion hides. */
  async view(): Promise<ShelfView> {
    await this.load();
    const { holdings, torrentUsage } = await this.read();
    const titles = await this.describe(holdings);
    const torrentBytes = titles.reduce((n, t) => n + t.torrent_bytes, 0) + torrentUsage.unnamedBytes;
    const cloudBytes = titles.reduce((n, t) => n + t.cloud_bytes, 0);
    const bulk = (pick: (t: ShelfTitle) => DeletionTarget[] | null): BulkView => {
      let bytes = 0;
      let count = 0;
      for (const t of titles) {
        const h = holdings.get(t.title_id);
        const targets = pick(t);
        if (h === undefined || targets === null || targets.length === 0) continue;
        const free = this.freeable(h, targets.filter((x) => !this.targetInUse(h, x)));
        if (free > 0) {
          bytes += free;
          count += 1;
        }
      }
      return { bytes, titles: count };
    };
    return {
      host: this.opts.host,
      total_bytes: torrentBytes + cloudBytes,
      torrent_bytes: torrentBytes,
      cloud_bytes: cloudBytes,
      unnamed_bytes: torrentUsage.unnamedBytes,
      budget_bytes: torrentUsage.budgetBytes,
      titles,
      downloading: titles.reduce((n, t) => n + (t.downloading?.count ?? 0), 0),
      bulk: {
        watched: bulk((t) => this.watchedTargets(t, holdings.get(t.title_id))),
        not_interested: bulk((t) => (t.not_interested ? this.allTargets(holdings.get(t.title_id)) : null)),
      },
      pending: this.pending.map(pendingView),
      undo_ms: this.undoMs,
    };
  }
```

**4i. `read()` (line 417–497).** Replace the whole method with the version below and add the private `queued()` right after it. The changes: slots start with `downloading: null`; queue rows come first and make their slot even when nothing is on disk; a `downloading` torrent row the fetch-ahead names is `ahead`; a cache with an `activity` gets its reason from `auto`/`ahead`; a holding is dropped only when it is empty **and** nothing of it downloads.
```ts
  private async read(): Promise<{ holdings: Map<string, Holding>; torrentUsage: { unnamedBytes: number; budgetBytes: number | null } }> {
    const hiddenSlots = new Set<string>();
    const hiddenCaches = new Set<string>();
    for (const r of this.pending)
      for (const t of r.targets) {
        if (t.type === 'torrent') hiddenSlots.add(`${t.info_hash}:${t.season}x${t.episode}`);
        else hiddenCaches.add(t.id);
      }
    const holdings = new Map<string, Holding>();
    const holding = (kind: 'movie' | 'tv', tmdbId: number): Holding => {
      const id = titleId(kind, tmdbId);
      let h = holdings.get(id);
      if (h === undefined) {
        h = { titleId: id, kind, tmdbId, slots: new Map(), seasonShared: new Map(), titleShared: { bytes: 0, inUse: false }, packs: [] };
        holdings.set(id, h);
      }
      return h;
    };
    const slotOf = (h: Holding, season: number, episode: number) => {
      const key = `${season}x${episode}`;
      let s = h.slots.get(key);
      if (s === undefined) {
        s = { season, episode, torrent: 0, cloud: 0, byHash: new Map(), byCache: new Map(), targets: [], inUse: false, downloading: null };
        h.slots.set(key, s);
      }
      return s;
    };
    // What the owner asked for and is not done comes first: its slot is listed even before a byte is on disk, and its
    // progress (the queue's) wins over a cache's for the same slot.
    for (const q of await this.queued()) {
      const s = slotOf(holding(q.kind, q.tmdbId), q.season, q.episode);
      s.downloading = stronger(s.downloading, { progress: unit(q.progress), why: 'asked', state: q.state });
    }
    const ahead = this.opts.ahead?.() ?? null;
    let torrentUsage = { unnamedBytes: 0, budgetBytes: null as number | null };
    if (this.opts.torrents !== null) {
      const usage = await this.opts.torrents.diskUsage();
      torrentUsage = { unnamedBytes: usage.unnamedBytes, budgetBytes: usage.budgetBytes };
      for (const t of usage.torrents) {
        const rows = t.rows.filter((r) => !hiddenSlots.has(`${t.infoHash}:${slotId(r)}`));
        if (rows.length === 0) continue;
        const inUse = this.opts.torrents.inUse(t.infoHash);
        // A torrent's rows are of one title; one opened for two titles counts to the title of its first row.
        const first = rows[0]!;
        const h = holding(first.kind, first.tmdbId);
        const slots = new Set<string>();
        for (const r of rows) {
          const sh = r.kind === first.kind && r.tmdbId === first.tmdbId ? h : holding(r.kind, r.tmdbId);
          const s = slotOf(sh, r.season, r.episode);
          // With episodes hidden, a file one hidden and one visible episode shared counts as shared.
          const own = rows.length === 1 ? t.usage.total : (t.usage.slots.get(slotId(r)) ?? 0);
          s.torrent += own;
          s.byHash.set(t.infoHash, (s.byHash.get(t.infoHash) ?? 0) + own);
          s.targets.push({ type: 'torrent', info_hash: t.infoHash, season: r.season, episode: r.episode, title_id: sh.titleId });
          s.inUse ||= inUse;
          // The next episode fetched ahead: its share of the file on disk (the swarm's live count, kept in memory).
          if (r.state === 'downloading' && ahead !== null && sameSlot(ahead, r)) {
            s.downloading = stronger(s.downloading, { progress: r.fileLength !== null && r.fileLength > 0 ? unit(r.bytesDone / r.fileLength) : 0, why: 'ahead', state: 'running' });
          }
          slots.add(slotId(r));
        }
        if (rows.length > 1) {
          const shared = t.usage.total - rows.reduce((n, r) => n + (t.usage.slots.get(slotId(r)) ?? 0), 0);
          const seasons = new Set(rows.map((r) => r.season));
          const season = seasons.size === 1 ? first.season : null;
          if (season !== null) {
            const was = h.seasonShared.get(season) ?? { bytes: 0, inUse: false };
            h.seasonShared.set(season, { bytes: was.bytes + shared, inUse: was.inUse || inUse });
          } else {
            h.titleShared = { bytes: h.titleShared.bytes + shared, inUse: h.titleShared.inUse || inUse };
          }
          h.packs.push({ infoHash: t.infoHash, shared, season, slots });
        }
      }
    }
    if (this.opts.caches !== null) {
      for (const { row, bytes } of await this.opts.caches.diskUsage()) {
        if (hiddenCaches.has(row.id)) continue;
        const h = holding(row.kind, row.tmdbId);
        const s = slotOf(h, row.season, row.episode);
        s.cloud += bytes;
        s.byCache.set(row.id, bytes);
        s.targets.push({ type: 'cache', id: row.id, title_id: h.titleId, season: row.season, episode: row.episode });
        s.inUse ||= this.opts.caches.busy(row.id);
        const activity = this.opts.caches.activity(row.id);
        if (activity !== null) {
          const progress = activity.progress ?? (row.segmentsTotal > 0 ? row.segmentsDone / row.segmentsTotal : 0);
          s.downloading = stronger(s.downloading, { progress: unit(progress), why: !row.auto ? 'asked' : activity.ahead ? 'ahead' : 'pause', state: activity.state });
        }
      }
    }
    for (const [id, h] of holdings) {
      const total = [...h.slots.values()].reduce((n, s) => n + s.torrent + s.cloud, 0) + [...h.seasonShared.values()].reduce((n, s) => n + s.bytes, 0) + h.titleShared.bytes;
      if (total <= 0 && ![...h.slots.values()].some((s) => s.downloading !== null)) holdings.delete(id);
    }
    return { holdings, torrentUsage };
  }

  /** The download queue's unfinished rows; none when it is off or cannot be read (the page still lists what is on disk). */
  private async queued(): Promise<ShelfQueued[]> {
    if ((this.opts.downloads ?? null) === null) return [];
    try {
      return await this.opts.downloads!.list();
    } catch (err) {
      this.log(`[notesd] cache page: could not read the download queue: ${messageOf(err)}`);
      return [];
    }
  }
```

**4j. `describe()` (line 499–580).** Replace the whole method with:
```ts
  private async describe(holdings: Map<string, Holding>): Promise<ShelfTitle[]> {
    const views = await this.opts.titles([...holdings.keys()]);
    const live = this.opts.live();
    const titles: ShelfTitle[] = [];
    for (const h of holdings.values()) {
      const v = views.get(h.titleId);
      const item = v?.item;
      const liveHere = live.filter((l) => l.titleId === h.titleId);
      const kindsOf = (torrent: number, cloud: number): ShelfKind[] => [...(torrent > 0 ? (['torrent'] as const) : []), ...(cloud > 0 ? (['cloud'] as const) : [])];
      const titleWatched = item !== undefined && (item.watched || item.state === 'finished');
      let torrentBytes = 0;
      let cloudBytes = 0;
      for (const s of h.slots.values()) {
        torrentBytes += s.torrent;
        cloudBytes += s.cloud;
      }
      for (const s of h.seasonShared.values()) torrentBytes += s.bytes;
      torrentBytes += h.titleShared.bytes;
      const seasons: ShelfSeason[] = [];
      if (h.kind === 'tv') {
        const bySeason = new Map<number, ShelfEpisode[]>();
        for (const s of h.slots.values()) {
          const ev = v?.seasons.find((x) => x.season === s.season)?.episodes.find((e) => e.episode === s.episode);
          const playing = liveHere.some((l) => l.season === s.season && l.episode === s.episode);
          const ep: ShelfEpisode = {
            season: s.season,
            episode: s.episode,
            movie_id: ev?.movie_id ?? null,
            name: ev?.name ?? null,
            bytes: s.torrent + s.cloud,
            kinds: kindsOf(s.torrent, s.cloud),
            watched: titleWatched || ev?.state === 'finished',
            playing,
            in_use: playing || s.inUse,
            downloading: s.downloading,
          };
          bySeason.set(s.season, [...(bySeason.get(s.season) ?? []), ep]);
        }
        for (const season of new Set([...bySeason.keys(), ...h.seasonShared.keys()])) {
          const episodes = (bySeason.get(season) ?? []).sort((a, b) => b.bytes - a.bytes || a.episode - b.episode);
          const shared = h.seasonShared.get(season) ?? { bytes: 0, inUse: false };
          const known = v?.seasons.find((x) => x.season === season)?.episodes ?? [];
          const watched = titleWatched || (known.length > 0 ? known.every((e) => e.state === 'finished') : episodes.length > 0 && episodes.every((e) => e.watched));
          const torrent = episodes.reduce((n, e) => n + (e.kinds.includes('torrent') ? 1 : 0), 0) > 0 || shared.bytes > 0;
          const cloud = episodes.some((e) => e.kinds.includes('cloud'));
          seasons.push({
            season,
            bytes: episodes.reduce((n, e) => n + e.bytes, 0) + shared.bytes,
            shared_bytes: shared.bytes,
            kinds: [...(torrent ? (['torrent'] as const) : []), ...(cloud ? (['cloud'] as const) : [])],
            watched,
            playing: episodes.some((e) => e.playing),
            in_use: shared.inUse || episodes.some((e) => e.in_use),
            downloading: rollup(episodes.flatMap(downloadingOf)),
            episodes,
          });
        }
        seasons.sort((a, b) => b.bytes - a.bytes || a.season - b.season);
      }
      const film = h.slots.get('0x0');
      const playing = liveHere.length > 0;
      titles.push({
        title_id: h.titleId,
        movie_id: item?.movie_id ?? null,
        kind: h.kind,
        tmdb_id: h.tmdbId,
        title: item?.title ?? `TMDB ${h.kind === 'tv' ? 'series' : 'movie'} ${h.tmdbId}`,
        year: item?.year ?? null,
        poster_url: item?.poster_url ?? null,
        stored: item !== undefined,
        bytes: torrentBytes + cloudBytes,
        torrent_bytes: torrentBytes,
        cloud_bytes: cloudBytes,
        kinds: kindsOf(torrentBytes, cloudBytes),
        watched: titleWatched,
        not_interested: item?.not_interested ?? false,
        playing,
        in_use: playing || h.titleShared.inUse || [...h.slots.values()].some((s) => s.inUse) || seasons.some((s) => s.in_use) || (film?.inUse ?? false),
        seasons,
        shared_bytes: h.titleShared.bytes,
        downloading: h.kind === 'movie' ? rollup(film === undefined || film.downloading === null ? [] : [film.downloading]) : rollup(seasons.flatMap((s) => s.episodes.flatMap(downloadingOf))),
      });
    }
    return titles.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title));
  }
```
**Impact:** the view gains fields and `ShelfCaches` gains `activity`. The deletion code paths (`remove`, `execute`, `freeable`, `targetInUse`, `allTargets`, `watchedTargets`) are not changed. A 0-byte slot has no targets, so a deletion of it answers `nothing_cached` as before. The page disables its trash (Step 9). Run `npx vitest run tests/unit/directStream/cacheShelf.test.ts` after Step 10.

### Step 5: Wire the queue and the fetch-ahead into the daemon's shelf
**File:** `src/daemon.ts:566–576`
**Change:** add `downloads` and `ahead`. The adapter is the one place that reads Phase 2's `DownloadView` (see **Requires**). It drops `done`/`failed` rows and turns a film's null season/episode into 0/0. `deps.streamDownloads` is read lazily, so it does not matter where Phase 2 builds it in this function.
**Code:**
```ts
  // The Cache page (src/directStream/cacheShelf.ts): this host's torrents and cloud caches on disk, deleted after an undo
  // window, and what downloads now and why. Null with neither torrents nor the stream cache. startBackground carries out
  // what a restart left pending.
  deps.cacheShelf =
    (torrents === null && streamCache === null) || movies === null
      ? null
      : new CacheShelf({
          host: movies.host,
          torrents,
          caches: streamCache,
          // The download queue's unfinished rows (StreamDownloads.list(): this host's only), as `asked` downloads.
          downloads: {
            list: async () => {
              const queue = deps.streamDownloads ?? null;
              if (queue === null) return [];
              return (await queue.list()).flatMap((d) =>
                d.state === 'queued' || d.state === 'running' || d.state === 'paused'
                  ? [{ kind: d.kind, tmdbId: d.tmdb_id, season: d.season ?? 0, episode: d.episode ?? 0, state: d.state, progress: d.progress }]
                  : [],
              );
            },
          },
          ahead: () => deps.directStream?.aheadFetching() ?? null,
          titles: (ids) => titleWatchViews(db, ids, { host: movies.host, imageBase: config.movies.tmdb.imageBase }),
          live: () => liveSlots(streamLive, deps.directStream ?? null),
          pendingFile: join(config.dataDir, 'movies', CACHE_PENDING_FILE),
        });
```
**Impact:** compiles only once Phase 2 has put `streamDownloads` on `AppDeps` (Requires). Check with `npm run typecheck`.

### Step 6: `stream_disk` says what downloads
**File:** `src/mcp/streamDiskTool.ts`

Replace `DESCRIPTION` (line 12–17) with:
```ts
const DESCRIPTION =
  "What this machine keeps on disk for streaming (torrent downloads and the cloud stream cache), per title, season and episode, and deleting it: the wall's Cache page (/movies/cache). " +
  'action list: the total against the torrent budget, split torrents / cloud, and every title holding cache, largest first, with its size, kinds (torrent, cloud), watched and not_interested tags, in_use (it plays or is being fetched: it cannot be deleted now), and for a series its seasons and episodes. Pass title to see one title only ("how much cache does Dandadan take?"). ' +
  'What downloads now: `downloading` at the top counts the films and episodes downloading; such an episode (or film) carries downloading {progress 0 to 1, state queued, running or paused, why: asked (the owner asked: a Download button, direct_stream_cache), ahead (the next episode, fetched while one plays) or pause (cached on a pause in the player)}, and a season or title rolls them up {count, progress (the mean), why (every reason), state}; null when nothing of it downloads. A download asked for with nothing on disk yet is listed at 0 bytes ("what is downloading?"). ' +
  'action delete with title (a name, a movie id such as M-23T4 (an episode\'s id names its episode) or a title key such as tv-1399), plus season, or season and episode: deletes that title\'s (season\'s, episode\'s) cache. action delete_watched: every watched film and series, and a series\' watched episodes ("clear the cache of watched stuff"). action delete_not_interested: every title marked not interested. ' +
  'A deletion is carried out 10 seconds after the call (the Cache page shows an undo for that long); action undo with the id from the answer cancels it inside that window. Nothing is blacklisted: a deleted torrent can be fetched again. Sizes are blocks on disk. ' +
  'Only this machine\'s cache is listed or deleted. Off on this server: stream_disk_off.';
```
Replace `titleView` (line 53–81) with:
```ts
/** A title as the tool answers it: sizes in words beside the bytes. */
function titleView(t: ShelfTitle, wall: string): Record<string, unknown> {
  return {
    title: t.title,
    year: t.year,
    movie_id: t.movie_id,
    title_key: t.title_id,
    link: t.stored ? `${wall}/movies/${t.movie_id ?? t.title_id}?side=stream` : null,
    size: sizeText(t.bytes),
    bytes: t.bytes,
    torrent: sizeText(t.torrent_bytes),
    cloud: sizeText(t.cloud_bytes),
    kinds: t.kinds,
    watched: t.watched,
    not_interested: t.not_interested,
    in_use: t.in_use,
    downloading: t.downloading,
    ...(t.kind === 'tv'
      ? {
          seasons: t.seasons.map((s) => ({
            season: s.season,
            size: sizeText(s.bytes),
            shared: s.shared_bytes > 0 ? sizeText(s.shared_bytes) : undefined,
            watched: s.watched,
            in_use: s.in_use,
            downloading: s.downloading,
            episodes: s.episodes.map((e) => ({ episode: e.episode, movie_id: e.movie_id, name: e.name, size: sizeText(e.bytes), kinds: e.kinds, watched: e.watched, in_use: e.in_use, downloading: e.downloading })),
          })),
        }
      : {}),
  };
}
```
In `diskAction`, replace the `summary` object (line 101–109) with:
```ts
  const summary = {
    host: view.host,
    total: sizeText(view.total_bytes),
    torrents: sizeText(view.torrent_bytes),
    cloud: sizeText(view.cloud_bytes),
    budget: view.budget_bytes === null ? null : sizeText(view.budget_bytes),
    downloading: view.downloading,
    delete_watched_frees: sizeText(view.bulk.watched.bytes),
    delete_not_interested_frees: sizeText(view.bulk.not_interested.bytes),
  };
```
**Impact:** the tool description changes, so `mcp-tools.md` must be regenerated (Step 8).

### Step 7: The route's description
**File:** `scripts/docs/httpRoutes.ts`, the `'GET /api/stream/disk'` entry (lines 329–330 today; phase 4 inserts its "Stream downloads" group above it at line 292, so find it by its key). Replace it with:
```ts
      'GET /api/stream/disk':
        '`{host, total_bytes, torrent_bytes, cloud_bytes, unnamed_bytes, budget_bytes, titles, downloading, bulk: {watched, not_interested}, pending, undo_ms}`. Sizes are blocks on disk, as the torrent budget counts them; `unnamed_bytes` are torrent folders no row names. `titles`, largest first, are `{title_id, movie_id, kind, tmdb_id, title, year, poster_url, stored, bytes, torrent_bytes, cloud_bytes, kinds, watched, not_interested, playing, in_use, seasons, shared_bytes, downloading}`; a series\' `seasons` (largest first) are `{season, bytes, shared_bytes, kinds, watched, playing, in_use, downloading, episodes}` and its episodes `{season, episode, movie_id, name, bytes, kinds, watched, playing, in_use, downloading}`. A season pack\'s files no single episode owns count to the season (`shared_bytes`). An episode that downloads now has `downloading: {progress, why, state}`, else null: `progress` from 0 to 1 (the download queue\'s for one the owner asked for, the file\'s bytes on disk for a torrent fetched ahead, the segments for a cloud cache), `why` `asked` (a download the owner asked for, or a cloud cache the owner asked for), `ahead` (the next episode, fetched while one plays) or `pause` (a cloud cache a pause in the player started), `state` `queued`, `running` or `paused`. A season and a title roll theirs up as `{count, progress, why, state}` (the mean progress, every reason with `asked` first, `running` when any runs, else `queued`, else `paused`), null when nothing of it downloads; a film\'s is its own with `count` 1. A download asked for with nothing on disk yet is listed at 0 bytes. A torrent that downloads only because it plays is `playing`, not downloading. `downloading` counts the films and episodes downloading. `bulk.watched` and `bulk.not_interested` are `{bytes, titles}`: what each bulk button frees. `pending` lists the deletions still inside their undo window (`{id, label, bytes, execute_at, skipped}`); what they delete is left out of everything else.',
```

### Step 8: Regenerate the references
**Command:** `npm run docs:gen`. This rewrites `docs/guide/reference/http-api.md` and `docs/guide/reference/mcp-tools.md`. Do not hand-edit them. Then run `npx vitest run tests/unit/docs/reference.test.ts`. These two files are regenerated, never merged: phases 4, 5 and 6 each regenerate them, and the integrator regenerates them after every merge.

### Step 9: The web client's types
**File:** `web/src/moviesApi.ts:865–949`. Replace from `export type DiskKind` through the end of `fetchStreamDisk` with the block below. `DiskDeletion`, `DiskScope`, `deleteStreamDisk` and `undoStreamDisk` stay as they are. Phase 4's download client is appended after `undoStreamDisk` (the end of the file), so these lines do not move; it is not touched. Phase 7 edits the story block (lines 623–645) and `SeasonView` (147–152) with no dependency edge to this phase: separate places.
```ts
export type DiskKind = 'torrent' | 'cloud';
/** Why a film or episode downloads now: the owner asked, the next episode fetched ahead, or a pause in the player. */
export type DiskWhy = 'asked' | 'ahead' | 'pause';
export type DiskDownloadState = 'queued' | 'running' | 'paused';

export interface DiskDownloading {
  progress: number;
  why: DiskWhy;
  state: DiskDownloadState;
}

export interface DiskDownloadRollup {
  count: number;
  progress: number;
  why: DiskWhy[];
  state: DiskDownloadState;
}

export interface DiskEpisode {
  season: number;
  episode: number;
  movie_id: string | null;
  name: string | null;
  bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  playing: boolean;
  in_use: boolean;
  downloading: DiskDownloading | null;
}

export interface DiskSeason {
  season: number;
  bytes: number;
  shared_bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  playing: boolean;
  in_use: boolean;
  downloading: DiskDownloadRollup | null;
  episodes: DiskEpisode[];
}

export interface DiskTitle {
  title_id: string;
  movie_id: string | null;
  kind: TitleKind;
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  stored: boolean;
  bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  not_interested: boolean;
  playing: boolean;
  in_use: boolean;
  seasons: DiskSeason[];
  shared_bytes: number;
  downloading: DiskDownloadRollup | null;
}

export interface DiskDeletion {
  id: string;
  label: string;
  bytes: number;
  execute_at: string;
  skipped: string[];
}

export interface DiskView {
  host: string;
  total_bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  unnamed_bytes: number;
  budget_bytes: number | null;
  titles: DiskTitle[];
  /** Films and episodes downloading now. */
  downloading: number;
  bulk: { watched: { bytes: number; titles: number }; not_interested: { bytes: number; titles: number } };
  pending: DiskDeletion[];
  undo_ms: number;
}

export type DiskScope = { title_id: string; season?: number; episode?: number } | { bulk: 'watched' | 'not_interested' };

/** What this machine keeps on disk for streaming, and what downloads now. Throws ApiError `stream_disk_off`. */
export async function fetchStreamDisk(signal?: AbortSignal): Promise<DiskView> {
  const v = await getJson<Partial<DiskView>>('/api/stream/disk', signal);
  return {
    host: v.host ?? '',
    total_bytes: v.total_bytes ?? 0,
    torrent_bytes: v.torrent_bytes ?? 0,
    cloud_bytes: v.cloud_bytes ?? 0,
    unnamed_bytes: v.unnamed_bytes ?? 0,
    budget_bytes: v.budget_bytes ?? null,
    titles: list(v.titles).map((t) => ({
      ...t,
      downloading: t.downloading ?? null,
      seasons: list(t.seasons).map((s) => ({ ...s, downloading: s.downloading ?? null, episodes: list(s.episodes).map((e) => ({ ...e, downloading: e.downloading ?? null })) })),
    })),
    downloading: v.downloading ?? 0,
    bulk: v.bulk ?? { watched: { bytes: 0, titles: 0 }, not_interested: { bytes: 0, titles: 0 } },
    pending: list(v.pending),
    undo_ms: v.undo_ms ?? 10_000,
  };
}
```

### Step 10: The shelf's unit tests
**File:** `tests/unit/directStream/cacheShelf.test.ts`

10a. Imports (line 5–6). Replace with:
```ts
import type { StreamCacheRow } from '../../../src/db/schema.js';
import type { CacheActivity } from '../../../src/directStream/cache/service.js';
import { CacheShelf, ShelfError, type LiveSlot, type ShelfCaches, type ShelfQueued, type ShelfTorrents } from '../../../src/directStream/cacheShelf.js';
import type { StreamRef } from '../../../src/directStream/types.js';
```
10b. Replace `cloudRow` (line 112–114) with:
```ts
function cloudRow(id: string, tmdbId: number, over: Partial<StreamCacheRow> = {}): StreamCacheRow {
  return { id, host: HOST, kind: 'movie', tmdbId, season: 0, episode: 0, auto: false, segmentsTotal: 0, segmentsDone: 0, ...over } as StreamCacheRow;
}

/** A cloud cache as the fake stream cache holds it. */
interface CloudSeed {
  row: StreamCacheRow;
  bytes: number;
  activity: CacheActivity | null;
}

const CLOUD = 'c0ffee00-0000-4000-8000-000000000001';
```
10c. Replace `build` (line 126–184) with:
```ts
function build(
  o: { records?: MemoryTorrentRecords; finished?: number[]; filmWatched?: boolean; filmNotInterested?: boolean; live?: LiveSlot[]; busyHash?: string; busyCache?: string; cloud?: CloudSeed[]; queue?: ShelfQueued[]; ahead?: StreamRef | null } = {},
): Built {
  const records = o.records ?? new MemoryTorrentRecords();
  const folder = new TorrentFolder(root);
  const lines: string[] = [];
  const streams = new TorrentStreams({ engine: new FakeTorrentEngine([]), repo: records, folder, host: HOST, uploadKbps: 100, keepDays: 7, budgetBytes: 1024 * KIB, discovery: false, now: () => new Date(clock), log: (l) => lines.push(l), every: () => () => undefined });
  const torrents: ShelfTorrents = {
    diskUsage: () => streams.diskUsage(),
    inUse: (h) => h === o.busyHash || streams.inUse(h),
    removeSlots: async (h, s) => {
      if (h === o.busyHash) throw new TorrentError('in_use', 'held');
      return streams.removeSlots(h, s);
    },
  };
  const removedCaches: string[] = [];
  const cloud = new Map<string, CloudSeed>((o.cloud ?? [{ row: cloudRow(CLOUD, 88), bytes: 40 * KIB, activity: null }]).map((c) => [c.row.id, c]));
  const caches: ShelfCaches = {
    diskUsage: async () => [...cloud.values()].map(({ row, bytes }) => ({ row, bytes })),
    busy: (id) => id === o.busyCache || (cloud.get(id)?.activity ?? null) !== null,
    activity: (id) => cloud.get(id)?.activity ?? null,
    remove: async (id) => {
      removedCaches.push(id);
      cloud.delete(id);
    },
  };
  const timers: (() => void)[] = [];
  const shelf = new CacheShelf({
    host: HOST,
    torrents,
    caches,
    downloads: { list: async () => o.queue ?? [] },
    ahead: () => o.ahead ?? null,
    titles: async (ids) =>
      new Map<string, { item: TitleListItem; seasons: SeasonView[] }>(
        ids.flatMap((id): [string, { item: TitleListItem; seasons: SeasonView[] }][] =>
          id === 'tv-500'
            ? [[id, { item: item(id, 'tv', 'The Show'), seasons: seasons(o.finished ?? []) }]]
            : id === 'movie-77'
              ? [[id, { item: item(id, 'movie', 'Film', { watched: o.filmWatched, not_interested: o.filmNotInterested }), seasons: [] }]]
              : [],
        ),
      ),
    live: () => o.live ?? [],
    pendingFile,
    undoMs: 10_000,
    now: () => new Date(clock),
    log: (l) => lines.push(l),
    later: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const fire = async (): Promise<void> => {
    clock += 10_000;
    for (const fn of timers.splice(0)) fn();
    // execute() is chained: wait for it to settle.
    await new Promise((r) => setTimeout(r, 30));
  };
  return { shelf, streams, records, folder, fire, removedCaches, lines };
}

/** tv-500's season pack still on its way: E01 and E02 chosen, 8 KiB of E02's 32 KiB on disk, nothing of E01. */
async function seedDownloadingPack(records: MemoryTorrentRecords, folder: TorrentFolder): Promise<void> {
  const files = [
    { index: 0, path: `${SHOW}/Show.S01E01.mkv`, length: 64 * KIB },
    { index: 1, path: `${SHOW}/Show.S01E02.mkv`, length: 32 * KIB },
  ];
  for (const [episode, video] of [
    [1, 0],
    [2, 1],
  ] as const) {
    const ref = { kind: 'tv' as const, tmdbId: 500, season: 1, episode };
    await records.record(HOST, { infoHash: PACK, ref, name: SHOW, release: SHOW, trackers: [] }, MADE);
    await records.chosen(HOST, { infoHash: PACK, season: 1, episode }, { files: [files[video]!], fileIndex: video, fileLength: files[video]!.length }, MADE);
  }
  await records.progress(HOST, { infoHash: PACK, season: 1, episode: 2 }, 8 * KIB, MADE);
  await put(folder.diskPath(PACK, files[1]!.path)!, 8 * KIB);
}
```
(The existing tests keep the literal `'c0ffee00-0000-4000-8000-000000000001'`. It equals `CLOUD`.)

10d. Append a new `describe` at the end of the file:
```ts
describe('what downloads now, and why', () => {
  it('lists a download asked for with nothing on disk yet, and rolls a series up: count, mean progress, every reason, running first', async () => {
    const b = build({
      cloud: [
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000011', 700, { kind: 'tv', season: 1, episode: 1, auto: true }), bytes: 10 * KIB, activity: { state: 'running', ahead: true, progress: 0.9 } },
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000012', 700, { kind: 'tv', season: 2, episode: 1, auto: true }), bytes: 10 * KIB, activity: { state: 'queued', ahead: true, progress: null } },
      ],
      queue: [
        { kind: 'tv', tmdbId: 700, season: 1, episode: 1, state: 'running', progress: 0.5 },
        { kind: 'tv', tmdbId: 700, season: 1, episode: 2, state: 'queued', progress: 0 },
        { kind: 'movie', tmdbId: 99, season: 0, episode: 0, state: 'paused', progress: 0.1 },
      ],
    });
    const view = await b.shelf.view();
    const show = view.titles.find((t) => t.title_id === 'tv-700')!;
    const s1 = show.seasons.find((s) => s.season === 1)!;
    const s2 = show.seasons.find((s) => s.season === 2)!;
    // S01E01 is asked for and also a cache fetched ahead: the owner's ask wins, with the queue's progress.
    expect(s1.episodes.find((e) => e.episode === 1)!.downloading).toEqual({ progress: 0.5, why: 'asked', state: 'running' });
    // S01E02 has nothing on disk yet: it is listed all the same.
    expect(s1.episodes.find((e) => e.episode === 2)).toMatchObject({ bytes: 0, kinds: [], downloading: { progress: 0, why: 'asked', state: 'queued' } });
    expect(s1.downloading).toEqual({ count: 2, progress: 0.25, why: ['asked'], state: 'running' });
    expect(s2.downloading).toEqual({ count: 1, progress: 0, why: ['ahead'], state: 'queued' });
    expect(show.downloading).toEqual({ count: 3, progress: 0.167, why: ['asked', 'ahead'], state: 'running' });
    const film = view.titles.find((t) => t.title_id === 'movie-99')!;
    expect(film).toMatchObject({ bytes: 0, title: 'TMDB movie 99', downloading: { count: 1, progress: 0.1, why: ['asked'], state: 'paused' } });
    expect(view.downloading).toBe(4);
  });

  it('labels a torrent fetched ahead "ahead" with the share of its file on disk, and a torrent that only plays not at all', async () => {
    const b = build({ busyHash: PACK, ahead: { kind: 'tv', tmdbId: 500, season: 1, episode: 2 }, cloud: [] });
    await seedDownloadingPack(b.records, b.folder);
    const view = await b.shelf.view();
    const season = view.titles.find((t) => t.title_id === 'tv-500')!.seasons[0]!;
    expect(season.episodes.find((e) => e.episode === 2)!.downloading).toEqual({ progress: 0.25, why: 'ahead', state: 'running' });
    expect(season.episodes.find((e) => e.episode === 1)!.downloading).toBeNull();
    expect(season.downloading).toEqual({ count: 1, progress: 0.25, why: ['ahead'], state: 'running' });
    expect(view.downloading).toBe(1);

    // The same torrent held by a play only: it downloads, but for the play on screen, not for later.
    const played = build({ records: b.records, busyHash: PACK, cloud: [] });
    const quiet = await played.shelf.view();
    expect(quiet.downloading).toBe(0);
    expect(quiet.titles.find((t) => t.title_id === 'tv-500')!.seasons[0]!.episodes.every((e) => e.downloading === null)).toBe(true);
  });

  it('labels a cloud cache by who started it: the owner (asked), the next episode (ahead), a pause (pause)', async () => {
    const b = build({
      cloud: [
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000001', 88), bytes: 0, activity: { state: 'queued', ahead: false, progress: null } },
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000002', 89, { auto: true }), bytes: 40 * KIB, activity: { state: 'running', ahead: false, progress: 0.5 } },
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000003', 600, { kind: 'tv', season: 1, episode: 2, auto: true, segmentsDone: 30, segmentsTotal: 120 }), bytes: 20 * KIB, activity: { state: 'running', ahead: true, progress: null } },
        { row: cloudRow('c0ffee00-0000-4000-8000-000000000004', 90, { auto: true }), bytes: 40 * KIB, activity: null },
      ],
    });
    const view = await b.shelf.view();
    const of = (id: string) => view.titles.find((t) => t.title_id === id)!;
    expect(of('movie-88').downloading).toEqual({ count: 1, progress: 0, why: ['asked'], state: 'queued' });
    expect(of('movie-89').downloading).toEqual({ count: 1, progress: 0.5, why: ['pause'], state: 'running' });
    // No live figure yet: the row's segments say how far it is.
    expect(of('tv-600').seasons[0]!.episodes[0]!.downloading).toEqual({ progress: 0.25, why: 'ahead', state: 'running' });
    expect(of('movie-90').downloading).toBeNull();
    expect(view.downloading).toBe(3);
  });
});
```
Mean for `tv-700`: (0.5 + 0 + 0) / 3 = 0.1667, and `unit` rounds it to `0.167`. S02E01 is a queued ahead cache with no progress, so 0.

### Step 11: `fetching()` test
**File:** `tests/unit/directStream/ahead.test.ts`. Append inside `describe('the next episode, fetched ahead', ...)`, after the test at line 196–212:
```ts
  it('says which episode it fetches from a torrent, until it lets it go', async () => {
    vi.useFakeTimers();
    const t = setup({ onDisk: true });
    expect(t.ahead.fetching()).toBeNull();
    t.ahead.watched(torrentSession, PLAYING);
    await t.watch(torrentSession, 120);
    expect(t.ahead.fetching()).toEqual(E789);
    t.state.torrentReady = true;
    await vi.advanceTimersByTimeAsync(AHEAD_TORRENT_POLL_MS);
    expect(t.calls).toEqual(['fetch', 'release']);
    expect(t.ahead.fetching()).toBeNull();
  });
```

### Step 12: `activity()` asserted against a real stream cache (integration)
**File:** `tests/integration/directStream.cache.int.test.ts:419–439`. Replace the test with:
```ts
  it('a download fetched ahead gives way to one that is asked for, and carries on after it', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 60);
    const { app, cache } = await ready();
    const next: StreamRef = { kind: 'tv', tmdbId: 990010, season: 1, episode: 2 };
    const ahead = await cache.player().ahead(next, { gentle: true });
    expect(ahead).toEqual({ started: true, state: 'downloading' });
    const aheadId = (await cache.find(next))?.id ?? '';
    expect((await cache.get(aheadId))?.auto).toBe(true);
    // The Cache page reads it as fetched ahead (memory only: the row says `auto` alone).
    expect(cache.activity(aheadId)).toMatchObject({ ahead: true });
    await until(async () => ((await cache.get(aheadId))?.segments_done ?? 0) >= 2);
    // The owner asks for a film: it does not wait behind the episode nobody watches yet.
    const asked = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    expect(cache.activity(asked)).toMatchObject({ ahead: false });
    await waitFor(app, asked, 'ready');
    expect(cache.activity(asked)).toBeNull();
    const then = await cache.get(aheadId);
    expect(then?.state).toBe('downloading');
    expect(then?.segments_done ?? 0).toBeLessThan(24);
    // Its turn comes back by itself, from the files already on disk.
    expect((await waitFor(app, aheadId, 'ready')).segments_done).toBe(24);
    expect(cache.activity(aheadId)).toBeNull();
    // Asked again for an episode that is there: nothing starts.
    expect(await cache.player().ahead(next, { gentle: false })).toEqual({ started: false, state: 'ready' });
  });
```

### Step 13: `stream_disk` tool tests
**File:** `tests/unit/mcp.streamDiskTool.test.ts`
- In `title()` (line 14–37), add `downloading: null,` after `shared_bytes: 0,` and before `...over`.
- In `DANDADAN` (line 39–58), add `downloading: null,` to the season object (after `in_use: false,`) and to the episode object literal (after `in_use: false`).
- In `fake()`'s `view` (line 63–74), add `downloading: 0,` after `titles: [...]`.
- Append inside `describe('stream_disk', ...)`:
```ts
  it('says what downloads now, with its progress and why', async () => {
    const oppenheimer = title({ title_id: 'movie-872585', movie_id: 'M-OPPN', title: 'Oppenheimer', bytes: 0, torrent_bytes: 0, kinds: [], watched: false, downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } });
    const base = await fake().api.view();
    const api: StreamDiskApi = {
      view: async () => ({ ...base, titles: [oppenheimer], downloading: 1 }),
      remove: async () => {
        throw new Error('unused');
      },
      undo: async () => {
        throw new Error('unused');
      },
    };
    const body = json(await (await connect(api)).call({ action: 'list' }));
    expect(body.downloading).toBe(1);
    expect(body.titles[0]).toMatchObject({ title: 'Oppenheimer', size: '0 MB', downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } });
  });
```

### Step 14: The Cache page
**File:** `web/src/components/movies/CachePage.tsx`. This is a whole-file replacement.
**Change:** a Downloading toggle (Phosphor `DownloadSimple`, icon plus count, `aria-pressed`) comes first among the bulk buttons. In the Downloading view only rows with `downloading` are listed, and they are unfolded by default (a separate `shut` set holds what the owner folds there). A `Downloading` cell (reason chips, a `role="progressbar"` bar, the percentage) sits before the size on every downloading title, season and episode row in both views. The page reads every `FAST_REFRESH_MS` (3 s) while `view.downloading > 0`, else every 15 s. A row with 0 bytes has its trash disabled with the tip "nothing on disk yet". The deletion rules themselves do not change.
**Code:**
```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, Broom, CaretDown, CaretRight, CheckCircle, Cloud, DownloadSimple, EyeSlash, FilmSlate, MagnetStraight, Trash } from '@phosphor-icons/react';
import {
  deleteStreamDisk,
  errorCode,
  fetchStreamDisk,
  undoStreamDisk,
  type DiskDeletion,
  type DiskDownloadState,
  type DiskEpisode,
  type DiskKind,
  type DiskScope,
  type DiskSeason,
  type DiskTitle,
  type DiskView,
  type DiskWhy,
} from '../../moviesApi';
import './CachePage.css';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** "154 MB", "4.2 GB": the daemon's own wording. */
export function sizeText(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / MIB))} MB`;
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

/** "41.2 of 40 GB · torrents 35.8 · cloud 5.4"; under a gigabyte in all, every figure in its own unit ("154 MB of 40 GB · torrents 120 MB · cloud 34 MB"). */
export function totalLine(v: DiskView): string {
  const budget = v.budget_bytes === null ? null : `${Math.round(v.budget_bytes / GIB)} GB`;
  if (v.total_bytes < GIB) {
    return `${sizeText(v.total_bytes)}${budget === null ? '' : ` of ${budget}`} · torrents ${sizeText(v.torrent_bytes)} · cloud ${sizeText(v.cloud_bytes)}`;
  }
  return `${gb(v.total_bytes)}${budget === null ? ' GB' : ` of ${budget}`} · torrents ${gb(v.torrent_bytes)} · cloud ${gb(v.cloud_bytes)}`;
}

const sxe = (s: number, e?: number): string => `S${String(s).padStart(2, '0')}${e === undefined ? '' : `E${String(e).padStart(2, '0')}`}`;

/** The key a row is hidden under while its deletion is on its way. */
const keyOf = (scope: DiskScope): string => ('bulk' in scope ? `bulk:${scope.bulk}` : [scope.title_id, scope.season, scope.episode].filter((x) => x !== undefined).join(':'));

/** How often the page reads the disk again while it is open (a play that started or stopped, a download that grew). */
const REFRESH_MS = 15_000;
/** How often while anything downloads: the bars move. */
export const FAST_REFRESH_MS = 3_000;

const WHY_TIP: Record<DiskWhy, string> = {
  asked: 'Asked for: a Download button or direct_stream_cache',
  ahead: 'The next episode, fetched while this one plays',
  pause: 'Cached on a pause in the player',
};
const STATE_TEXT: Record<DiskDownloadState, string> = {
  running: 'downloading',
  queued: 'waiting its turn',
  paused: 'paused while a torrent plays',
};

const flip = (prev: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

interface Toast {
  text: string;
  deletion: DiskDeletion | null;
}

export interface CachePageProps {
  /** Open a title's page on the Stream side. */
  onOpen: (id: string) => void;
}

function Kinds({ kinds }: { kinds: DiskKind[] }) {
  return (
    <span className="cp-kinds">
      {kinds.includes('torrent') && (
        <span className="cp-kind" data-tip="Torrent download" aria-label="torrent">
          <MagnetStraight weight="duotone" />
        </span>
      )}
      {kinds.includes('cloud') && (
        <span className="cp-kind" data-tip="Cloud stream cache" aria-label="cloud">
          <Cloud weight="duotone" />
        </span>
      )}
    </span>
  );
}

function Tags({ watched, notInterested = false, playing, inUse }: { watched: boolean; notInterested?: boolean; playing: boolean; inUse: boolean }) {
  return (
    <span className="cp-tags">
      {watched && <span className="mv-chip cp-tag">watched</span>}
      {notInterested && <span className="mv-chip cp-tag">not interested</span>}
      {inUse && <span className="mv-chip cp-tag cp-live">{playing ? 'playing' : 'in use'}</span>}
    </span>
  );
}

/** Why a row downloads (one chip per reason), and how far it is: a bar the page refreshes every 3 s. */
function Downloading({ d, label }: { d: { progress: number; state: DiskDownloadState; why: DiskWhy | DiskWhy[] }; label: string }) {
  const pct = Math.round(d.progress * 100);
  const why = Array.isArray(d.why) ? d.why : [d.why];
  return (
    <span className="cp-dl" data-state={d.state}>
      {why.map((w) => (
        <span key={w} className="mv-chip cp-tag cp-why" data-why={w} data-tip={WHY_TIP[w]}>
          {w}
        </span>
      ))}
      <span className="mv-meter-bar cp-bar" role="progressbar" aria-label={`${label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-tip={`${pct}% · ${STATE_TEXT[d.state]}`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="cp-pct">{pct}%</span>
    </span>
  );
}

function TrashButton({ label, disabled, empty = false, onClick }: { label: string; disabled: boolean; empty?: boolean; onClick: () => void }) {
  const tip = empty ? `${label}: nothing on disk yet` : disabled ? `${label}: in use now` : `Delete ${label}`;
  return (
    <button type="button" className="ibtn hov cp-trash" data-tip={tip} aria-label={tip} disabled={disabled || empty} onClick={onClick}>
      <Trash weight="duotone" />
    </button>
  );
}

function Caret({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  const tip = open ? `Fold ${label}` : `Unfold ${label}`;
  return (
    <button type="button" className="ibtn hov cp-caret" aria-label={tip} aria-expanded={open} data-tip={tip} data-tip-side="right" onClick={onClick}>
      {open ? <CaretDown weight="bold" /> : <CaretRight weight="bold" />}
    </button>
  );
}

/**
 * The Cache page (`/movies/cache`): everything this machine keeps on disk for streaming, largest first, and what is
 * downloading to it, each with a bar and why it downloads. A series unfolds to its seasons and a season to its episodes.
 * The Downloading toggle lists only what downloads now, unfolded; clicked again it is the default view. Every trash button
 * and both bulk buttons delete with no confirmation: the rows go at once and a toast offers Undo while the daemon waits
 * out its window (`undo_ms`).
 */
export function CachePage({ onOpen }: CachePageProps) {
  const [view, setView] = useState<DiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The default view: what is unfolded (everything is folded at first). */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The Downloading view: what is folded (everything is unfolded at first). */
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [only, setOnly] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const v = await fetchStreamDisk();
      setView(v);
      setError(null);
      setHidden(new Set());
    } catch (e) {
      setError(errorCode(e));
    }
  }, []);

  const fast = (view?.downloading ?? 0) > 0;
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void load();
      },
      fast ? FAST_REFRESH_MS : REFRESH_MS,
    );
    return () => window.clearInterval(t);
  }, [load, fast]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = (t: Toast, ms: number) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  const isOpen = (key: string): boolean => (only ? !shut.has(key) : open.has(key));
  const toggle = (key: string) => {
    if (only) setShut((prev) => flip(prev, key));
    else setOpen((prev) => flip(prev, key));
  };

  const remove = async (scope: DiskScope) => {
    const key = keyOf(scope);
    setHidden((prev) => new Set(prev).add(key));
    try {
      const deletion = await deleteStreamDisk(scope);
      showToast({ text: `Deleted ${deletion.label} · ${sizeText(deletion.bytes)}`, deletion }, view?.undo_ms ?? 10_000);
    } catch (e) {
      const code = errorCode(e);
      showToast({ text: code === 'in_use' ? 'It plays or is being fetched now: kept' : `Could not delete (${code})`, deletion: null }, 6000);
    } finally {
      await load();
    }
  };

  const undo = async (d: DiskDeletion) => {
    setToast(null);
    try {
      await undoStreamDisk(d.id);
      showToast({ text: `Kept ${d.label}`, deletion: null }, 4000);
    } catch (e) {
      showToast({ text: errorCode(e) === 'unknown_deletion' ? `${d.label} is deleted already` : `Could not undo (${errorCode(e)})`, deletion: null }, 6000);
    } finally {
      await load();
    }
  };

  const visible = (scope: DiskScope): boolean => {
    const key = keyOf(scope);
    for (const h of hidden) if (key === h || key.startsWith(`${h}:`)) return false;
    return true;
  };

  let body;
  if (error !== null) body = <p className="mv-empty">{error === 'stream_disk_off' ? 'Neither torrents nor the stream cache are on on this machine.' : `Could not read the cache (${error}).`}</p>;
  else if (view === null) body = <p className="mv-empty">reading the disk</p>;
  else {
    const titles = view.titles.filter((t) => visible({ title_id: t.title_id }) && (!only || t.downloading !== null));
    const filterLabel = `Downloading · ${view.downloading}`;
    body = (
      <>
        <div className="cp-head">
          <span className={view.budget_bytes !== null && view.total_bytes > view.budget_bytes ? 'cp-total over' : 'cp-total'} data-testid="cp-total">
            {totalLine(view)}
          </span>
          <div className="cp-bulk">
            <button
              type="button"
              className={only ? 'ibtn on cp-bulkbtn' : 'ibtn hov cp-bulkbtn'}
              data-tip={only ? `${filterLabel} · show everything` : `${filterLabel} · show only these`}
              data-tip-side="below"
              aria-label={filterLabel}
              aria-pressed={only}
              disabled={!only && view.downloading === 0}
              onClick={() => setOnly((x) => !x)}
            >
              <DownloadSimple weight="duotone" />
              <span className="cp-n">{view.downloading}</span>
            </button>
            <button
              type="button"
              className="ibtn hov cp-bulkbtn"
              data-tip={`Delete Watched · ${sizeText(view.bulk.watched.bytes)}`}
              data-tip-side="below"
              aria-label={`Delete Watched · ${sizeText(view.bulk.watched.bytes)}`}
              disabled={view.bulk.watched.bytes <= 0 || hidden.has('bulk:watched')}
              onClick={() => void remove({ bulk: 'watched' })}
            >
              <CheckCircle weight="duotone" />
              <Broom weight="duotone" />
              <span className="cp-n">{sizeText(view.bulk.watched.bytes)}</span>
            </button>
            <button
              type="button"
              className="ibtn hov cp-bulkbtn"
              data-tip={`Delete Not interested · ${sizeText(view.bulk.not_interested.bytes)}`}
              data-tip-side="below"
              aria-label={`Delete Not interested · ${sizeText(view.bulk.not_interested.bytes)}`}
              disabled={view.bulk.not_interested.bytes <= 0 || hidden.has('bulk:not_interested')}
              onClick={() => void remove({ bulk: 'not_interested' })}
            >
              <EyeSlash weight="duotone" />
              <Broom weight="duotone" />
              <span className="cp-n">{sizeText(view.bulk.not_interested.bytes)}</span>
            </button>
          </div>
        </div>
        {titles.length === 0 ? (
          <p className="mv-empty">{only ? 'Nothing downloads now.' : 'Nothing is kept on this machine for streaming.'}</p>
        ) : (
          <ul className="cp-list" aria-label="Titles on disk">
            {titles.map((t) => (
              <TitleRow key={t.title_id} t={t} isOpen={isOpen} toggle={toggle} visible={visible} remove={(s) => void remove(s)} only={only} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="cp mv-content" aria-label="Cache">
      {body}
      {toast !== null && (
        <div className="cp-toast" role="status">
          <span>{toast.text}</span>
          {toast.deletion !== null && (
            <button type="button" className="mv-undo" onClick={() => void undo(toast.deletion!)}>
              Undo
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  visible: (scope: DiskScope) => boolean;
  remove: (scope: DiskScope) => void;
  /** The Downloading view: only rows that download now. */
  only: boolean;
}

function TitleRow({ t, isOpen, toggle, visible, remove, only, onOpen }: RowProps & { t: DiskTitle; onOpen: (id: string) => void }) {
  const unfolded = isOpen(t.title_id);
  const seasons = t.seasons.filter((s) => visible({ title_id: t.title_id, season: s.season }) && (!only || s.downloading !== null));
  const name = t.year === null ? t.title : `${t.title} (${t.year})`;
  return (
    <li className="cp-title" data-title={t.title_id}>
      <div className="cp-row">
        {t.kind === 'tv' ? <Caret open={unfolded} label={t.title} onClick={() => toggle(t.title_id)} /> : <span className="cp-caret-gap" />}
        {t.poster_url !== null ? <img className="cp-poster" src={t.poster_url} alt="" loading="lazy" /> : <span className="cp-poster cp-noposter"><FilmSlate weight="duotone" /></span>}
        <span className="cp-name">{name}</span>
        <Kinds kinds={t.kinds} />
        <Tags watched={t.watched} notInterested={t.not_interested} playing={t.playing} inUse={t.in_use} />
        {t.downloading !== null && <Downloading d={t.downloading} label={t.title} />}
        <span className="cp-size">{sizeText(t.bytes)}</span>
        {t.stored ? (
          <button type="button" className="ibtn hov" data-tip="Go to the title page" aria-label={`Open ${t.title}`} onClick={() => onOpen(t.movie_id ?? t.title_id)}>
            <ArrowSquareOut weight="duotone" />
          </button>
        ) : (
          <span className="cp-btn-gap" />
        )}
        <TrashButton label={t.title} disabled={t.in_use} empty={t.bytes === 0} onClick={() => remove({ title_id: t.title_id })} />
      </div>
      {t.kind === 'tv' && unfolded && (
        <ul className="cp-seasons" aria-label={`${t.title} seasons`}>
          {seasons.map((s) => (
            <SeasonRow key={s.season} t={t} s={s} isOpen={isOpen} toggle={toggle} visible={visible} remove={remove} only={only} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SeasonRow({ t, s, isOpen, toggle, visible, remove, only }: RowProps & { t: DiskTitle; s: DiskSeason }) {
  const key = `${t.title_id}:${s.season}`;
  const unfolded = isOpen(key);
  const episodes = s.episodes.filter((e) => visible({ title_id: t.title_id, season: e.season, episode: e.episode }) && (!only || e.downloading !== null));
  return (
    <li className="cp-season" data-season={s.season}>
      <div className="cp-row">
        <Caret open={unfolded} label={`season ${s.season}`} onClick={() => toggle(key)} />
        <span className="cp-name">Season {s.season}</span>
        <Kinds kinds={s.kinds} />
        <Tags watched={s.watched} playing={s.playing} inUse={s.in_use} />
        {s.downloading !== null && <Downloading d={s.downloading} label={`${t.title} ${sxe(s.season)}`} />}
        <span className="cp-size" data-tip={s.shared_bytes > 0 ? `${sizeText(s.shared_bytes)} the season's episodes share` : undefined}>
          {sizeText(s.bytes)}
        </span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(s.season)}`} disabled={s.in_use} empty={s.bytes === 0} onClick={() => remove({ title_id: t.title_id, season: s.season })} />
      </div>
      {unfolded && (
        <ul className="cp-episodes" aria-label={`Season ${s.season} episodes`}>
          {episodes.map((e) => (
            <EpisodeRow key={e.episode} t={t} e={e} remove={remove} />
          ))}
        </ul>
      )}
    </li>
  );
}

function EpisodeRow({ t, e, remove }: { t: DiskTitle; e: DiskEpisode; remove: (scope: DiskScope) => void }) {
  return (
    <li className="cp-episode" data-episode={e.episode}>
      <div className="cp-row">
        <span className="cp-caret-gap" />
        <span className="cp-name">
          <span className="cp-sxe">{sxe(e.season, e.episode)}</span>
          {e.name !== null && <span className="cp-epname">{e.name}</span>}
        </span>
        <Kinds kinds={e.kinds} />
        <Tags watched={e.watched} playing={e.playing} inUse={e.in_use} />
        {e.downloading !== null && <Downloading d={e.downloading} label={`${t.title} ${sxe(e.season, e.episode)}`} />}
        <span className="cp-size">{sizeText(e.bytes)}</span>
        <span className="cp-btn-gap" />
        <TrashButton label={`${t.title} ${sxe(e.season, e.episode)}`} disabled={e.in_use} empty={e.bytes === 0} onClick={() => remove({ title_id: t.title_id, season: e.season, episode: e.episode })} />
      </div>
    </li>
  );
}
```
**Impact:** the page markup gains elements. Existing aria-labels and tips are kept (`Delete X`, `X: in use now`, `Unfold X`, bulk labels), so the existing tests and any `docs:shots` selectors still match.

### Step 15: Styles
**File:** `web/src/components/movies/CachePage.css`. Insert before `.cp-trash:disabled` (line 32). Then replace the media query (line 35–39) with the one below. The bar reuses `.mv-meter-bar` from `Movies.css` (3 px, `--chip-bg` track, `--fg` fill): monochrome, as the page already is.
```css
.cp-bulkbtn.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.cp-bulkbtn.on:disabled { opacity: 1; }
.cp-dl { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.cp-why { font-size: 10px; }
.cp-bar { flex: none; width: 84px; }
.cp-bar > span { transition: width .6s ease; }
.cp-dl[data-state="queued"] .cp-bar > span, .cp-dl[data-state="paused"] .cp-bar > span { opacity: .45; }
.cp-pct { flex: none; width: 32px; text-align: right; font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--muted); }
```
```css
@media (max-width: 640px) {
  .cp-tags, .cp-kinds { display: none; }
  .cp-bar { width: 44px; }
  .cp-seasons { padding-left: 12px; margin-left: 6px; }
  .cp-episodes { padding-left: 12px; }
}
```

### Step 16: The page's tests
**File:** `web/src/components/movies/CachePage.test.tsx`. This is a whole-file replacement. The four existing tests are kept unchanged in substance (their fixtures gain `downloading: null`), and three tests are added.
**Names phase 9's drive uses, pinned here (reconciled):** the filter is an icon toggle whose accessible name starts `Downloading` (`Downloading · N`) and carries `aria-pressed`; every downloading row's bar is `role="progressbar"` with `aria-valuenow` 0–100, named `<title> download` (`… S01 download`, `… S01E05 download`), inside that row's own `.cp-row`; the list items stay `li.cp-title[data-title]`, `li.cp-season[data-season]`, `li.cp-episode[data-episode]`. Keep these names; phase 9 drives them.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DiskTitle, DiskView } from '../../moviesApi';
import { CachePage, FAST_REFRESH_MS, sizeText, totalLine } from './CachePage';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function episode(e: number, bytes: number, over: Partial<DiskTitle['seasons'][number]['episodes'][number]> = {}) {
  return { season: 1, episode: e, movie_id: `M-DD0${e}`, name: `Episode ${e}`, bytes, kinds: ['torrent' as const], watched: false, playing: false, in_use: false, downloading: null, ...over };
}

const DANDADAN: DiskTitle = {
  title_id: 'tv-240411',
  movie_id: 'M-DDDN',
  kind: 'tv',
  tmdb_id: 240411,
  title: 'Dandadan',
  year: 2024,
  poster_url: null,
  stored: true,
  bytes: 3 * GIB,
  torrent_bytes: 3 * GIB,
  cloud_bytes: 0,
  kinds: ['torrent'],
  watched: false,
  not_interested: false,
  playing: true,
  in_use: true,
  shared_bytes: 0,
  downloading: null,
  seasons: [
    {
      season: 1,
      bytes: 3 * GIB,
      shared_bytes: 100 * MIB,
      kinds: ['torrent'],
      watched: false,
      playing: true,
      in_use: true,
      downloading: null,
      episodes: [episode(3, 1.5 * GIB, { watched: true }), episode(4, 1.4 * GIB, { playing: true, in_use: true })],
    },
  ],
};
const BARBIE: DiskTitle = { ...DANDADAN, title_id: 'movie-346698', movie_id: 'M-BARB', kind: 'movie', tmdb_id: 346698, title: 'Barbie', year: 2023, bytes: 154 * MIB, torrent_bytes: 0, cloud_bytes: 154 * MIB, kinds: ['cloud'], watched: true, playing: false, in_use: false, seasons: [] };
/** A film the owner asked for, 42 % down. */
const OPPENHEIMER: DiskTitle = { ...BARBIE, title_id: 'movie-872585', movie_id: 'M-OPPN', tmdb_id: 872585, title: 'Oppenheimer', bytes: 900 * MIB, torrent_bytes: 900 * MIB, cloud_bytes: 0, kinds: ['torrent'], watched: false, downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } };

let calls: Array<{ url: string; method: string; body: unknown }>;
let pendingIds: Set<string>;
/** True: Oppenheimer downloads, and Dandadan's S01E05 is fetched ahead. */
let downloads: boolean;

function titlesNow(): DiskTitle[] {
  if (!downloads) return [DANDADAN, BARBIE];
  const s1 = DANDADAN.seasons[0]!;
  const ahead = { count: 1, progress: 0.3, why: ['ahead' as const], state: 'running' as const };
  const e05 = episode(5, 300 * MIB, { downloading: { progress: 0.3, why: 'ahead', state: 'running' } });
  return [{ ...DANDADAN, downloading: ahead, seasons: [{ ...s1, downloading: ahead, episodes: [...s1.episodes, e05] }] }, OPPENHEIMER, BARBIE];
}

function view(): DiskView {
  const hidden = (key: string) => pendingIds.has(key);
  const titles = titlesNow()
    .filter((t) => !hidden(t.title_id))
    .map((t) => ({ ...t, seasons: t.seasons.map((s) => ({ ...s, episodes: s.episodes.filter((e) => !hidden(`${t.title_id}:${e.season}:${e.episode}`)) })) }));
  return {
    host: 'pc',
    total_bytes: 41.2 * GIB,
    torrent_bytes: 35.8 * GIB,
    cloud_bytes: 5.4 * GIB,
    unnamed_bytes: 0,
    budget_bytes: 40 * GIB,
    titles,
    downloading: downloads ? 2 : 0,
    bulk: { watched: { bytes: 12.3 * GIB, titles: 4 }, not_interested: { bytes: 2.1 * GIB, titles: 1 } },
    pending: [],
    undo_ms: 10_000,
  };
}

const titleIds = (): (string | null)[] => within(screen.getByRole('list', { name: 'Titles on disk' })).getAllByRole('listitem').filter((li) => li.hasAttribute('data-title')).map((li) => li.getAttribute('data-title'));
const reads = (): number => calls.filter((c) => c.method === 'GET' && c.url === '/api/stream/disk').length;
/** Lets the page's fetch and its render settle (setTimeout stays real). */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  calls = [];
  pendingIds = new Set();
  downloads = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (url === '/api/stream/disk/delete') {
        const key = [body.title_id, body.season, body.episode].filter((x: unknown) => x !== undefined).join(':');
        pendingIds.add(key);
        const label = body.episode !== undefined ? `Dandadan S01E0${body.episode}` : 'Barbie';
        return new Response(JSON.stringify({ deletion: { id: 'abcdef012345', label, bytes: body.episode !== undefined ? 1.5 * GIB : 154 * MIB, execute_at: '', skipped: [] } }), { status: 202 });
      }
      if (url.startsWith('/api/stream/disk/deletions/')) {
        pendingIds.clear();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(view()), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('the Cache page', () => {
  it('says the total against the budget, split by kind, and what each bulk button frees', async () => {
    render(<CachePage onOpen={() => {}} />);
    expect((await screen.findByTestId('cp-total')).textContent).toContain('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect((screen.getByRole('button', { name: 'Delete Watched · 12.3 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Delete Not interested · 2.1 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect(totalLine(view())).toBe('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect(sizeText(154 * MIB)).toBe('154 MB');
    // Nothing downloads: the filter has nothing to show.
    expect((screen.getByRole('button', { name: 'Downloading · 0' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the titles with their tags; a series unfolds to seasons and episodes, collapsed by default', async () => {
    const open = vi.fn();
    render(<CachePage onOpen={open} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-title'))).toEqual(['tv-240411', 'movie-346698']);
    const barbie = rows[1]!;
    expect(within(barbie).getByText('watched')).toBeTruthy();
    expect(within(barbie).getByText('154 MB')).toBeTruthy();
    fireEvent.click(within(barbie).getByRole('button', { name: 'Open Barbie' }));
    expect(open).toHaveBeenCalledWith('M-BARB');

    // The series plays: its trash is disabled, and nothing below it shows until it is unfolded.
    const show = rows[0]!;
    expect((within(show).getByRole('button', { name: 'Dandadan: in use now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(show).getByText('playing')).toBeTruthy();
    expect(screen.queryByText('Season 1')).toBeNull();
    fireEvent.click(within(show).getByRole('button', { name: 'Unfold Dandadan' }));
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.queryByText('S01E03')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    expect(screen.getByText('S01E03')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Dandadan S01E04: in use now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete Dandadan S01E03' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('trashes an episode with no confirmation, hides it at once, and brings it back with Undo', async () => {
    render(<CachePage onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unfold Dandadan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Dandadan S01E03' }));
    expect(screen.queryByText('S01E03')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toContain('Deleted Dandadan S01E03 · 1.5 GB');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title_id: 'tv-240411', season: 1, episode: 3 });
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByText('S01E03')).toBeTruthy());
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/stream/disk/deletions/abcdef012345')).toBe(true);
    expect((await screen.findByRole('status')).textContent).toContain('Kept Dandadan S01E03');
  });

  it('runs a bulk deletion from its button', async () => {
    render(<CachePage onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Watched · 12.3 GB' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && JSON.stringify(c.body) === JSON.stringify({ bulk: 'watched' }))).toBe(true));
  });
});

describe('what downloads, on the Cache page', () => {
  it('lists what downloads together with what is downloaded, each downloading row with its bar and why (default view)', async () => {
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Downloading · 2' });
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585', 'movie-346698']);
    const opp = screen.getByRole('progressbar', { name: 'Oppenheimer download' });
    // Phase 9's drive finds a row's bar inside that row's own .cp-row.
    expect(opp.closest('.cp-row')).not.toBeNull();
    expect(opp.getAttribute('aria-valuenow')).toBe('42');
    const oppRow = screen.getByRole('progressbar', { name: 'Oppenheimer download' }).closest('li')!;
    expect(within(oppRow).getByText('asked')).toBeTruthy();
    // Barbie is downloaded, not downloading: no bar, no reason.
    const barbie = screen.getByText('Barbie (2023)').closest('li')!;
    expect(within(barbie).queryByRole('progressbar')).toBeNull();
    // The series' row, its season's and its episode's: each with its bar and `ahead`; the downloaded episodes stay listed.
    expect(screen.getByRole('progressbar', { name: 'Dandadan download' }).getAttribute('aria-valuenow')).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Dandadan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01E05 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getAllByText('ahead')).toHaveLength(3);
    expect(screen.getByText('S01E03')).toBeTruthy();
    expect(screen.getByText('S01E04')).toBeTruthy();
  });

  it('the Downloading filter lists only what downloads now, unfolded, and a second click brings everything back', async () => {
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    const filter = await screen.findByRole('button', { name: 'Downloading · 2' });
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585']);
    // Unfolded by itself, down to the one episode that downloads.
    expect(screen.getByText('S01E05')).toBeTruthy();
    expect(screen.queryByText('S01E03')).toBeNull();
    expect(screen.queryByText('S01E04')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01E05 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('progressbar', { name: 'Oppenheimer download' }).getAttribute('aria-valuenow')).toBe('42');
    // Folding in this view works too.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dandadan' }));
    expect(screen.queryByText('S01E05')).toBeNull();

    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585', 'movie-346698']);
    // The default view's folds are its own: the series is folded, as it was.
    expect(screen.queryByText('Season 1')).toBeNull();
  });

  it('reads the disk every 3 s while something downloads, and every 15 s once nothing does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Downloading · 2' });
    const first = reads();
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 1);
    await settle();
    // The downloads end: that read says so, and the page slows down.
    downloads = false;
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 2);
    await settle();
    await screen.findByRole('button', { name: 'Downloading · 0' });
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 2);
    act(() => void vi.advanceTimersByTime(15_000 - FAST_REFRESH_MS));
    expect(reads()).toBe(first + 3);
  });
});
```
**Impact:** none outside the file.

## Principles applied

- Laziness protocol: `src/http/streamDiskApi.ts` is left unchanged, because `c.json(view())` already carries the new fields. Seasons, titles and the film row share one `rollup()`. The bar reuses `.mv-meter-bar` rather than a new component style. The ahead reason comes from a one-line getter, not a new event channel.
- Boundary discipline: Phase 2's `DownloadView` is turned into `ShelfQueued` once, in the daemon adapter (Step 5: states filtered, a film's null season/episode becomes 0/0). The shelf trusts that typed value. Every progress figure from the three sources is clamped and rounded in one place (`unit`).
- Make illegal states unrepresentable: "downloading" is a nullable object (`downloading: {...} | null`), not a flag beside a nullable progress. An episode carries exactly one `why`, and a roll-up carries the list. `CacheActivity.state` cannot express "ready" or "failed". The Downloading view's folds live in their own set (`shut`), so leaving the view cannot leak its unfolding into the default view.
- Test behavior, not implementation: the shelf tests assert the view a caller reads, built over a real `TorrentStreams` and folder. The page tests assert roles (`progressbar` with `aria-valuenow`, `aria-pressed`) and count real `GET`s for the refresh rate, not `setInterval` arguments. The cache's `activity()` is asserted against a real `StreamCache` and fixture host in the integration test.
- Sequence into verifiable units: server getters (Steps 1–3), then the shelf, which is checked by its unit test (Step 10), then the tool and docs, checked by the reference test (Step 8), then the web types and page, checked by the page test (Step 16). Each unit ends in a failing-capable check.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npx vitest run tests/unit/directStream/cacheShelf.test.ts tests/unit/directStream/ahead.test.ts tests/unit/mcp.streamDiskTool.test.ts web/src/components/movies/CachePage.test.tsx tests/unit/docs/reference.test.ts && npm test && npm run test:int -- tests/integration/directStream.cache.int.test.ts`
**Proof:** a throwaway daemon with direct streaming on: a slow cloud download beside a finished one, read over HTTP and driven in the wall with Playwright.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`)
- Feature-map entries: `.claude/skills/verify-notesd/features/movies.md` ("Cache page"). Phase 9 updates the entry (see Handoffs); these journeys are the drives it should cite.
- Setup, shared by J1 to J3 (run from the worktree root):
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --web --direct-stream            # note RUN=<id> and URL; --web rebuilds web/dist with this phase's page
  D=~/.local/state/notesd-verify/$RUN/direct
  echo hls_token > $D/mode               # the tokened HLS film the stream cache can hold
  $V api $RUN POST /api/stream/cache '{"kind":"movie","tmdb_id":990004}'      # a film that will be downloaded
  for i in $(seq 1 60); do $V api $RUN GET /api/stream/cache | grep -q '"state":"ready"' && break; sleep 1; done
  echo 4000 > $D/delay_ms                # every media answer now waits 4 s: the next download takes about a minute
  $V api $RUN POST /api/stream/cache '{"kind":"movie","tmdb_id":990005}'      # the owner's cache, downloading (asked)
  $V api $RUN POST /api/stream/cache '{"kind":"tv","tmdb_id":990010,"season":1,"episode":2}'   # queued behind it (asked)
  ```
- Journeys:
  - **J1** · traces R4.1, R5.1. Run `$V api $RUN GET /api/stream/disk`. Then write `cache-default.steps.mjs` (below) to the scratchpad and run `$V ui $RUN cache-default.steps.mjs`. Passes when two things hold. First, the GET answer lists `movie-990004` with `downloading: null` and `bytes > 0`, beside `movie-990005` with `downloading.why == ["asked"]`, `downloading.state == "running"` and `0 <= downloading.progress < 1`, and the top-level `downloading` is `>= 2`. Second, the UI log says `DEFAULT VIEW PASS`: in the default view the finished film's row has no bar, the downloading film's row has a `progressbar` named `TMDB movie 990005 download` with the chip `asked`, and its `aria-valuenow` rose between two reads 8 s apart with no reload. The screenshot is `cache-default-downloading`.
    ```js
    export default async ({ page, base, shot, log }) => {
      await page.goto(base + '/movies/cache')
      const done = page.locator('[data-title="movie-990004"]')
      const row = page.locator('[data-title="movie-990005"]')
      await done.waitFor()
      if ((await done.getByRole('progressbar').count()) !== 0) throw new Error('the downloaded film shows a bar')
      const bar = row.getByRole('progressbar', { name: 'TMDB movie 990005 download' })
      await bar.waitFor()
      await row.getByText('asked', { exact: true }).waitFor()
      const first = Number(await bar.getAttribute('aria-valuenow'))
      await page.waitForTimeout(8000)
      const later = Number(await bar.getAttribute('aria-valuenow'))
      if (!(later > first)) throw new Error(`the bar did not move: ${first} -> ${later}`)
      await shot('cache-default-downloading')
      log(`DEFAULT VIEW PASS movie-990004 downloaded (no bar) beside movie-990005 asked ${first}% -> ${later}% without a reload`)
    }
    ```
  - **J2** · traces R4.2, R5.1. While 990005 still downloads, write `cache-filter.steps.mjs` (below) and run `$V ui $RUN cache-filter.steps.mjs`. Passes when the log says `DOWNLOADING VIEW PASS`. That means: after a click on the `Downloading · N` toggle (`aria-pressed=true`), `movie-990004` is gone; `movie-990005` is listed with its bar; `tv-990010` is listed already unfolded down to its `S01E02` row with a bar. After a second click (`aria-pressed=false`), `movie-990004` is listed again and `tv-990010` is folded. The screenshots are `cache-downloading-view` and `cache-default-again`.
    ```js
    export default async ({ page, base, shot, log }) => {
      await page.goto(base + '/movies/cache')
      const filter = page.getByRole('button', { name: /^Downloading · [1-9]/ })
      await filter.waitFor()
      await page.locator('[data-title="movie-990004"]').waitFor()
      await filter.click()
      if ((await filter.getAttribute('aria-pressed')) !== 'true') throw new Error('the filter is not pressed')
      await page.locator('[data-title="movie-990004"]').waitFor({ state: 'detached' })
      await page.getByRole('progressbar', { name: 'TMDB movie 990005 download' }).waitFor()
      const show = page.locator('[data-title="tv-990010"]')
      await show.locator('[data-episode="2"]').getByRole('progressbar').waitFor()
      await shot('cache-downloading-view')
      await filter.click()
      if ((await filter.getAttribute('aria-pressed')) !== 'false') throw new Error('the filter is still pressed')
      await page.locator('[data-title="movie-990004"]').waitFor()
      if ((await show.locator('[data-episode="2"]').count()) !== 0) throw new Error('the series stayed unfolded in the default view')
      await shot('cache-default-again')
      log('DOWNLOADING VIEW PASS only movie-990005 and tv-990010 S01E02 (unfolded) in the Downloading view; everything back on the second click')
    }
    ```
  - **J3** · traces R4.3. First run `npx vitest run tests/unit/directStream/cacheShelf.test.ts -t "what downloads now"`. Then, on the run, queue a download through the download queue (Phase 4's route) while the stream cache is busy: `$V api $RUN POST /api/stream/downloads '{"kind":"movie","tmdb_id":990006,"via":"cloud"}'`, then `$V api $RUN GET /api/stream/disk`. Passes when the three unit tests pass (an `ahead` torrent, an `ahead` cache, a `pause` cache, two `asked` sources, the owner's ask beating `ahead` on one slot, a torrent that only plays carrying no reason), and the GET answer lists `movie-990006` with `downloading.why == ["asked"]`, `downloading.count == 1` and `downloading.progress < 1`, even if `bytes` is still 0. The `asked` chip seen in J1's screenshot is the same reason drawn on the page.
- Neighbor check (deleting from the Cache page, the existing feature this phase sits beside): after J1 to J3, run `$V api $RUN POST /api/stream/disk/delete '{"title_id":"movie-990004"}'` (expect 202), then `$V api $RUN POST /api/stream/disk/delete '{"title_id":"movie-990005"}'` (expect 409 `in_use` while it downloads), `sleep 13` and `$V api $RUN GET /api/stream/disk`. Passes when `movie-990004` is gone and `movie-990005` is still listed and downloading. Also run `npx vitest run web/src/components/movies/CachePage.test.tsx -t "the Cache page"`, whose four existing tests must pass. Finish with `$V down $RUN`.
- Cost: none. The resolver, the stream host and TMDB are fakes, and no model is called.

**Exit criteria:** `npm run typecheck`, `npm test` (with `tests/unit/docs/reference.test.ts`) and the cache integration test pass. On a throwaway daemon, the Cache page lists a downloading film with a moving bar and an `asked` chip beside a finished one. The Downloading toggle shows only what downloads, unfolded, and a second click shows everything again.

## Handoffs

- **Phase 9 (R4):** the feature map entry `.claude/skills/verify-notesd/features/movies.md` "Cache page" should say that the page lists downloads beside downloaded files, describe the Downloading toggle (`Downloading · N`, `aria-pressed`), the bars (`role=progressbar`, named `<title> download`) and the reasons (`asked`, `ahead`, `pause`), the 3 s refresh while anything downloads, and that a queued download with nothing on disk has a disabled trash. It should cite J1 and J2 above as its drive. The planner's format asks a user-facing phase to edit the feature map itself; the index gives that file to Phase 9, so this phase leaves it there to avoid two phases editing one entry.
- **Phase 9 (R4):** `docs/guide/movies.md` "The Cache page" should gain the filter, the bars and the three reasons in prose, and `img/movies/cache.png` should be retaken read-only with `docs:shots -- --live movies`, which is the owner's real library and never a fixture. A picture of a running download belongs in the streaming guide from the throwaway daemon, as the index says.
- **Phase 2 (R1):** `StreamDownloads.list()` must give this host's rows with `kind`, `tmdb_id`, `season`, `episode`, `state` and a live `progress` from 0 to 1, and be reachable as `AppDeps.streamDownloads`. If the names differ, the reconciler aligns the adapter in Step 5 (`src/daemon.ts`), not the shelf.
- **Phase 2 / Phase 4:** a `failed` download is not listed as downloading on the Cache page; it shows only on the title page (Phase 8) and in `GET /api/stream/downloads`. If a Cache page row for a failed download is wanted, it is a new requirement, not this phase's.
- **Decision (recorded in the index's Decisions):** a torrent that downloads only because it plays on screen is not shown as downloading. It keeps its `playing` tag. R4.3 names exactly three reasons, and a play is none of them. A failed download is not on the Cache page, and a queued download with nothing on disk gets a 0-byte row whose trash is disabled.
- **Integrator:** `docs/guide/reference/http-api.md` and `mcp-tools.md` are regenerated (Step 8), never merged; regenerate them with `npm run docs:gen` after every merge.

## Rollback

Revert this phase's commit. The view loses its `downloading` fields and the page loses the toggle and the bars. No table, migration or setting was added, so there is nothing to undo in the database. Run `npm run docs:gen` again after the revert if the generated references were committed separately.

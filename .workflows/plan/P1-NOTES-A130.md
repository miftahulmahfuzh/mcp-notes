> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 4. Source: `.workflows/plan/torrent-stream-source/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: The player page on a torrent

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R2 — "streaming video using that torrent file": the owner sees, on the player page, that the film comes from a torrent and how the download is going
**Criteria:** R2.7
**Depends on:** Phase 3 (and through it Phase 1)
**Difficulty:** NORMAL
**Package:** `web/src/stream`

---

## Goal

After this phase a torrent session on the player page shows a magnet icon beside the title with the
peer count and the download speed, the timeline's thick grey bar grows with the stretches of the
file on this machine's disk, and a seek past what is downloaded shows that the page waits for those
pieces. A torrent that buffers never makes the page ask for another source by itself; the shuffle
button moves to the next torrent and names it, and `window.notesdStream.torrent` exposes all of it
to scripts.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.
**Renames:** nothing. (`fetchCacheMap`'s body moves into a private `fetchDiskMap` in `web/src/stream/session.ts`; `fetchCacheMap` keeps its name, signature and behaviour.)
**Creates:**
- `web/src/stream/session.ts`: `type TorrentState = 'downloading' | 'ready' | 'failed'`, `interface TorrentInfo { infoHash, name, index, seeds, state }`, `StreamSession.torrent: TorrentInfo | null`, `interface DiskMap { durationS, ranges }`, `interface TorrentStatus { state, peers, downKbps, progress }`, `torrentUrl(hash)`, `torrentMapUrl(hash)`, `fetchTorrentStatus(hash, fetch)`, `fetchTorrentMap(hash, fetch)`.
- `web/src/stream/controller.ts`: `TORRENT_POLL_MS` (2 000), `NO_OTHER_SOURCE`, `interface TorrentView`, `torrentView(info)`, `onDisk(ranges, t)`, `scaleRanges(ranges, mapDurationS, filmDurationS)`, `StreamState.torrent: TorrentView | null` (so `window.notesdStream.torrent`).
- `web/src/stream/StreamApp.tsx`: `formatSpeed(kbps)`, `torrentLabel(view)`, `sourceLine(changing, notice, torrent)`, the `TorrentMark` component, the "Fetching this part from peers" overlay.
- `web/src/stream/stream.css`: `.st-torrent`, `.st-torrent-stat`, `.st-fetching`.
- `.claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs`, `.claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs`.
**Signature changes:** none. `parseSession`'s answer gains the field `torrent`; `cached` is forced to null when `torrent` is set.
**Requires (from earlier phases):**
- Phase 3: `GET /api/stream/sessions/:id` (SessionInfo) carries `torrent: { info_hash, name, index, state, seeds } | null`; `info_hash` is 40 hex characters, `name` the release name, `index` the name of the index that listed it (a string), `state` `downloading` or `ready`, `seeds` a number. A torrent session's `manifest_kind` is `mp4` (phase 5 may make it `hls`) and its `manifest_url` the local file route. `POST /api/stream/sessions/:id/source` on a torrent session answers today's shape (`switched`, `reason`, `from`, `provider` and the SessionInfo of the session) with `torrent` naming the next candidate, or `switched: false, reason: "no_other_source"`. `POST .../cache` refuses a torrent session (the page no longer asks, see Step 4).
- Phase 1: `GET /api/stream/torrent/:hash` answers, at the top level, `state` (`downloading | ready | failed`), `peers` (number), `down_kbps` (kilobits per second, as the stream evidence log's `kbps`: bytes × 8 / ms), `progress` (0 to 1), and needs no same-origin header for a GET; `GET /api/stream/torrent/:hash/map` answers `{ duration_s, ranges: [[from_s, to_s], ...] }` in seconds, like `GET /api/stream/cache/:id/map`. `verify.sh up --torrent` seeds the loopback fixture torrent (journey J1 only).
**Leaves alone (owned by others):** `web/src/stream/hlsEngine.ts` (Phase 5), `web/src/stream/subtitles.ts` (Phase 7), everything under `src/` (Phases 1, 3, 5 to 8), `scripts/docs/httpRoutes.ts` and the generated references (Phase 1 documents the torrent routes), `.claude/skills/verify-notesd/scripts/verify.sh` (Phase 1's `--torrent`). `web/src/stream/nativeEngine.ts` is in this phase's scope but needs no change (see Principles applied).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/stream/session.ts` | modify | `TorrentState`, `TorrentInfo` after `CachedInfo` (line 44); parsers after `cachedInfo` (line 88); `StreamSession.torrent` (line 28); `parseSession` (lines 97-134); `torrentUrl`, `torrentMapUrl` after line 157; `fetchCacheMap` (lines 234-247) split into `fetchDiskMap` + `fetchCacheMap` + `fetchTorrentMap`; `fetchTorrentStatus` |
| `web/src/stream/controller.ts` | modify | imports (lines 11-31), `TORRENT_POLL_MS`/`NO_OTHER_SOURCE` (after line 69), `TorrentView` and helpers (after line 73), `StreamState.torrent` (line 120), `INITIAL_STATE` (line 150), fields (after line 205), `start` (line 268), `open` (lines 288-298), `goToEpisode` (lines 332-333), `dispose` (lines 488-509), `onSeek`/`onWaiting`/`onMoving` (lines 682-710), `changeSource` (lines 724-764), `armPauseCache` (line 789), `refresh` (lines 1023-1026), new `followTorrent`/`stopTorrent`/`readTorrent`/`markFetching`/`onArrived` after `followCache` (line 860) |
| `web/src/stream/StreamApp.tsx` | modify | icon imports (lines 2-23), controller import (line 24), `formatSpeed`/`torrentLabel`/`TorrentMark`/`sourceLine` after `CachedMark` (line 109), `StageOverlay` (lines 344-363), the top line (lines 497-515), the shuffle button (lines 571-575) |
| `web/src/stream/stream.css` | modify | torrent mark, stats and the waiting overlay after `.st-cached[data-state='downloading']` (line 112) |
| `web/src/stream/nativeEngine.ts` | none | plays the local file route as any plain file; nothing torrent-specific is needed |
| `web/src/stream/controller.test.tsx` | modify | import line (line 3), `parseSession` expectation gains `torrent: null` (line 58), new `describe('a torrent session')` at the end |
| `web/src/stream/StreamApp.test.tsx` | modify | import line (line 5), new `describe('the player on a torrent')` at the end |
| `docs/guide/streaming.md` | modify | "How a provider delivers" (lines 434-448), "The player" (after line 595 and lines 642-644), a new torrent subsection under phase 1/3's "Torrents" section, "Proving a change" (after line 1172) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | a sub-feature bullet after "The prober" (line 63-70), two driving bullets after "A pause caches the film" (line ~120) |
| `.claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` | create | J2: the real page build with the session and torrent routes faked |
| `.claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs` | create | J1: the real page on a real torrent session of a `--torrent` run |

## Implementation Steps

### Step 1: Read the session's torrent and the torrent routes in `session.ts`
**File:** `web/src/stream/session.ts:15` (and the line references in each part)
**Change:** The page's boundary with the daemon: validate `SessionInfo.torrent` once, never let a
session be both a cache play and a torrent, and add the two torrent reads (status, map) beside the
cache's. The map reader is shared with the cache's.

**Code (a): `StreamSession`, replace lines 27-29**

Old:
```ts
  /** Played from this machine's stream cache; null: through the pass-through. */
  cached: CachedInfo | null;
}
```
New:
```ts
  /** Played from this machine's stream cache; null: through the pass-through. */
  cached: CachedInfo | null;
  /** Played from a torrent on this machine (torrent-stream-source phase 3); null: not a torrent. Never set together with `cached`. */
  torrent: TorrentInfo | null;
}
```

**Code (b): after `CachedInfo` (insert after line 44, before `/** An audio track as the manifest writes it. */`)**
```ts
/** A torrent download's state, as the session and GET /api/stream/torrent/:hash name it. */
export type TorrentState = 'downloading' | 'ready' | 'failed';

/** SessionInfo.torrent: the torrent the session plays (torrent-stream-source phase 3). */
export interface TorrentInfo {
  /** 40 lower-case hex characters. */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The index that listed it (`Torrentio`, `apibay`); null when the session names none. */
  index: string | null;
  /** The seeds the index counted; null when unknown. */
  seeds: number | null;
  state: TorrentState;
}
```

**Code (c): after `cachedInfo` (insert after line 88, before `function episodeNumber`)**
```ts
const INFO_HASH = /^[0-9a-f]{40}$/i;

/** Any other word is a download still going: a torrent the page cannot name is still a torrent. */
function torrentState(value: unknown): TorrentState {
  return value === 'ready' || value === 'failed' ? value : 'downloading';
}

/** A count the daemon sent (peers, seeds); null when it is not one. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function torrentInfo(value: unknown): TorrentInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { info_hash, name, index, state, seeds } = value as Record<string, unknown>;
  if (typeof info_hash !== 'string' || !INFO_HASH.test(info_hash)) return null;
  const infoHash = info_hash.toLowerCase();
  return { infoHash, name: text(name) ?? infoHash, index: text(index), seeds: count(seeds), state: torrentState(state) };
}
```

**Code (d): `parseSession`, replace the whole function (lines 96-134)**
```ts
/** Phase 3's SessionInfo, checked once. A `source: "manifest"` track is inside the manifest (the engine shows it), so it is not a file. */
export function parseSession(json: unknown): StreamSession {
  if (typeof json !== 'object' || json === null) throw new SessionError('bad_session', 0);
  const o = json as Record<string, unknown>;
  const id = text(o.session_id);
  const manifestUrl = text(o.manifest_url);
  const kind = text(o.manifest_kind);
  if (id === null || manifestUrl === null || kind === null || !KINDS.includes(kind)) {
    throw new SessionError('bad_session', 0);
  }
  const subtitles: SessionSubtitle[] = [];
  if (Array.isArray(o.subtitles)) {
    for (const entry of o.subtitles) {
      if (typeof entry !== 'object' || entry === null) continue;
      const s = entry as Record<string, unknown>;
      if (s.source === 'manifest') continue;
      const url = text(s.url);
      if (url === null) continue;
      const lang = text(s.lang);
      const label = text(s.label) ?? lang ?? 'Subtitle';
      subtitles.push({ url, lang, label, english: typeof s.english === 'boolean' ? s.english : isEnglish(lang, label) });
    }
  }
  const resume = o.resume_s;
  const named = (o.audio as { track?: unknown } | null | undefined)?.track;
  const track = typeof named === 'object' && named !== null ? (named as Record<string, unknown>) : null;
  // A session plays either this machine's stream cache or a torrent, never both.
  const torrent = torrentInfo(o.torrent);
  return {
    id,
    title: text(o.title) ?? 'Stream',
    manifestUrl,
    manifestKind: kind as ManifestKind,
    subtitles,
    resumeS: typeof resume === 'number' && Number.isFinite(resume) && resume > 0 ? resume : 0,
    audioTrack: track === null || (text(track.lang) === null && text(track.label) === null) ? null : { lang: text(track.lang), label: text(track.label) },
    prevEpisode: episodeNumber(o.prev_episode),
    nextEpisode: episodeNumber(o.next_episode),
    cached: torrent === null ? cachedInfo(o.cached) : null,
    torrent,
  };
}
```

**Code (e): the torrent addresses, insert after line 157 (`export const cacheMapUrl = ...`)**
```ts
export const torrentUrl = (infoHash: string): string => `/api/stream/torrent/${encodeURIComponent(infoHash)}`;
export const torrentMapUrl = (infoHash: string): string => `${torrentUrl(infoHash)}/map`;
```

**Code (f): replace `fetchCacheMap` (lines 234-247) with the shared map reader, the cache's and the torrent's**
```ts
/** A map of what is on this machine's disk: its stretches in seconds, and the duration they were counted against (null: not said). */
export interface DiskMap {
  durationS: number | null;
  ranges: TimeRange[];
}

/** GET a `{ duration_s, ranges }` map (a cache's, a torrent's); null when the daemon cannot say. Never throws. */
async function fetchDiskMap(url: string, fetchImpl: typeof fetch): Promise<DiskMap | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { duration_s?: unknown; ranges?: unknown } | null;
    if (body === null || !Array.isArray(body.ranges)) return null;
    const duration = body.duration_s;
    return {
      durationS: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      ranges: body.ranges.flatMap((r): TimeRange[] =>
        Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number' && r[1] > r[0] && r[0] >= 0 ? [[r[0], r[1]]] : [],
      ),
    };
  } catch {
    return null;
  }
}

/** The stretches of a cache that are on this machine's disk; [] when the daemon cannot say. Never throws. */
export async function fetchCacheMap(cacheId: string, fetchImpl: typeof fetch): Promise<TimeRange[]> {
  return (await fetchDiskMap(cacheMapUrl(cacheId), fetchImpl))?.ranges ?? [];
}

/** The stretches of a torrent's file on this machine's disk (GET /api/stream/torrent/:hash/map); null when the daemon cannot say. Never throws. */
export function fetchTorrentMap(infoHash: string, fetchImpl: typeof fetch): Promise<DiskMap | null> {
  return fetchDiskMap(torrentMapUrl(infoHash), fetchImpl);
}

/** GET /api/stream/torrent/:hash as the page uses it: where the download stands and its live numbers. */
export interface TorrentStatus {
  state: TorrentState;
  /** Peers connected now; null when the daemon does not say. */
  peers: number | null;
  /** Download speed in kilobits per second (bytes × 8 / ms, as the stream evidence log counts `kbps`); null when not said. */
  downKbps: number | null;
  /** 0 to 1 of the chosen file on disk; null when not said. */
  progress: number | null;
}

/** Where a torrent's download stands; null when the daemon cannot say (a 404, a network failure). Never throws. */
export async function fetchTorrentStatus(infoHash: string, fetchImpl: typeof fetch): Promise<TorrentStatus | null> {
  try {
    const res = await fetchImpl(torrentUrl(infoHash), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object') return null;
    const down = body.down_kbps;
    const progress = body.progress;
    return {
      state: torrentState(body.state),
      peers: count(body.peers),
      downKbps: typeof down === 'number' && Number.isFinite(down) && down >= 0 ? down : null,
      progress: typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null,
    };
  } catch {
    return null;
  }
}
```
**Impact:** `StreamSession` has a new required field; the only other producer is `parseSession`
itself. The existing `parseSession` test that uses `toEqual` on a whole session gains `torrent: null`
(Step 6). `fetchCacheMap` behaves as before (the cache's poll is unchanged).

### Step 2: The torrent view, its helpers and the state field in `controller.ts`
**File:** `web/src/stream/controller.ts:11`
**Change:** Import the new reads and the existing visible-tab poller; add the poll interval, the
"nothing found" constant, the `TorrentView` (the session's torrent plus its live numbers and the
`fetching` wait, which therefore only a torrent can have), and the state field.

**Code (a): replace the import block (lines 11-31)**
```ts
import {
  fetchSession,
  fetchText,
  postEvents,
  postPosition,
  refreshSession,
  reportStreamBug,
  SessionError,
  switchEpisode,
  switchSource,
  cacheSession,
  fetchCacheMap,
  fetchTorrentMap,
  fetchTorrentStatus,
  type TimeRange,
  type EpisodeNumber,
  type ManifestKind,
  type PlayerLogLine,
  type ReportAnswer,
  type StreamSession,
  type CachedInfo,
  type TorrentInfo,
  type TorrentState,
} from './session';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';
import { isPageVisible, startAdaptivePoll, type AdaptivePoll } from '../lib/pageActive';
```

**Code (b): insert after line 69 (`export const CACHE_POLL_MS = 4_000;`)**
```ts
/** How often a torrent session asks for its peers, its speed and what is on disk, while it downloads and the tab shows. */
export const TORRENT_POLL_MS = 2_000;
/** `sourceNotice` after an ask that found nothing; the page words it for a cloud source or a torrent. */
export const NO_OTHER_SOURCE = 'No other source';
```

**Code (c): insert after line 73 (`  const EVENTS_PER_POST = 50;`), before `/** \`recovering\`: ...`**
```ts
/** A torrent session as the page shows it: the session's torrent, its live numbers once the daemon answered, and the wait for a part not on disk. */
export interface TorrentView {
  /** 40 lower-case hex characters. */
  infoHash: string;
  /** The release name. */
  name: string;
  /** The index that listed it; null when the session named none. */
  index: string | null;
  seeds: number | null;
  state: TorrentState;
  /** Peers connected now; null until the daemon answered. */
  peers: number | null;
  /** Download speed in kilobits per second; null until the daemon answered. */
  downKbps: number | null;
  /** 0 to 1 of the file on disk; null until the daemon answered. */
  progress: number | null;
  /** The play or a seek reached a part that is not on disk yet: the page shows that it waits for it. */
  fetching: boolean;
}

/** The view of a session's torrent before the daemon has said anything about it. */
export function torrentView(info: TorrentInfo | null): TorrentView | null {
  if (info === null) return null;
  return { ...info, peers: null, downKbps: null, progress: info.state === 'ready' ? 1 : null, fetching: false };
}

/** The position is inside a stretch on disk, with the half second of slack loadedGradient joins stretches by. */
export function onDisk(ranges: readonly TimeRange[], t: number): boolean {
  return ranges.some(([from, to]) => t >= from - 0.5 && t < to);
}

/**
 * A map's seconds on the film's own clock. The daemon maps a torrent's bytes to seconds by
 * proportion of the duration it knows, which may not be the one the browser reads from the file.
 */
export function scaleRanges(ranges: readonly TimeRange[], mapDurationS: number | null, filmDurationS: number): TimeRange[] {
  if (mapDurationS === null || !(mapDurationS > 0) || !(filmDurationS > 0) || Math.abs(mapDurationS - filmDurationS) < 0.5) return [...ranges];
  const k = filmDurationS / mapDurationS;
  return ranges.map(([from, to]): TimeRange => [from * k, to * k]);
}
```

**Code (d): `StreamState`, replace lines 119-120**

Old:
```ts
  /** The stretches of the title on this machine's disk (a cached play), in seconds: the timeline's thick grey bar. */
  cachedRanges: TimeRange[];
```
New:
```ts
  /** The stretches of the title on this machine's disk (a cached play or a torrent), in seconds: the timeline's thick grey bar. */
  cachedRanges: TimeRange[];
  /** A torrent session (torrent-stream-source phase 4): the mark beside the title and the wait for a part not on disk. Null: not a torrent. */
  torrent: TorrentView | null;
```

**Code (e): `INITIAL_STATE`, replace lines 150-151**

Old:
```ts
  cachedRanges: [],
  errors: [],
```
New:
```ts
  cachedRanges: [],
  torrent: null,
  errors: [],
```

**Code (f): fields, insert after line 205 (`  private cacheAskedFor: string | null = null;`)**
```ts
  /** The torrent whose numbers and map are being read, and its poll; null once it is complete, failed or left. */
  private torrentHash: string | null = null;
  private torrentPoll: AdaptivePoll | null = null;
```
**Impact:** `window.notesdStream.torrent` exists (null on every cloud play). Nothing reads the
new state yet; Steps 3 and 4 fill it.

### Step 3: Follow a torrent session: read its numbers and map, stop when complete or hidden
**File:** `web/src/stream/controller.ts:264` (and the line references in each part)
**Change:** `open`, `refresh` and the switch of source start the poll; an episode switch and
`dispose` stop it. The poll reuses `startAdaptivePoll` (`web/src/lib/pageActive.ts`), which
schedules nothing while the tab is hidden and runs at once when it shows again. The poll stops once
the daemon says the download is `ready` or `failed`. Reads only: nothing here writes.

**Code (a): `start`, replace lines 264-276 (the listeners part of `start`)**
```ts
  async start(): Promise<void> {
    this.video.addEventListener('timeupdate', this.onTime);
    this.video.addEventListener('seeking', this.onTime);
    this.video.addEventListener('seeking', this.onSeek);
    this.video.addEventListener('seeked', this.readCaption);
    this.video.addEventListener('seeked', this.onArrived);
    this.video.addEventListener('canplay', this.onArrived);
    (this.video.textTracks as TextTrackList | undefined)?.addEventListener?.('change', this.readCaption);
    this.video.addEventListener('waiting', this.onWaiting);
    this.video.addEventListener('playing', this.onMoving);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('play', this.onPlay);
    this.video.addEventListener('ended', this.onEnded);
    this.video.ownerDocument.defaultView?.addEventListener('pagehide', this.onClose);
    this.timer = setInterval(this.onTick, POSITION_INTERVAL_MS);
    let session: StreamSession;
    try {
      session = await fetchSession(this.sessionId, this.deps.fetch);
    } catch (err) {
      if (!this.disposed) this.fail(err);
      return;
    }
    if (this.disposed) return;
    await this.open(session);
  }
```

**Code (b): `open`, replace lines 288-298**
```ts
  /** Plays a session read from the daemon: its name, neighbours, cache or torrent, its subtitle files, then the engine at its resume position. */
  private async open(session: StreamSession): Promise<void> {
    this.session = session;
    this.set({
      title: session.title,
      kind: session.manifestKind,
      prevEpisode: session.prevEpisode,
      nextEpisode: session.nextEpisode,
      cached: session.cached,
      torrent: torrentView(session.torrent),
    });
    if (session.cached !== null) this.note(`from cache ${session.cached.id.slice(0, 8)} (${session.cached.state})`);
    if (session.torrent !== null) this.note(`from torrent ${session.torrent.infoHash.slice(0, 8)} ${session.torrent.name} (${session.torrent.state})`);
    this.restoreSubtitleDelay();
    await this.loadFileSubtitles(session);
    if (this.disposed || this.session !== session) return;
    if (session.cached !== null) this.followCache(session.cached.id);
    if (session.torrent !== null) this.followTorrent(session.torrent.infoHash);
    await this.attach(session, session.resumeS);
  }
```

**Code (c): `goToEpisode`, replace lines 332-333**

Old:
```ts
    this.clearCacheTimers();
    this.set({ cachedRanges: [] });
```
New:
```ts
    this.clearCacheTimers();
    this.stopTorrent();
    this.set({ cachedRanges: [], torrent: null });
```

**Code (d): `dispose`, replace lines 488-509**
```ts
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('seeking', this.onTime);
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('seeked', this.readCaption);
    this.video.removeEventListener('seeked', this.onArrived);
    this.video.removeEventListener('canplay', this.onArrived);
    (this.video.textTracks as TextTrackList | undefined)?.removeEventListener?.('change', this.readCaption);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('playing', this.onMoving);
    this.clearStallTimer();
    this.clearCacheTimers();
    this.stopTorrent();
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.ownerDocument.defaultView?.removeEventListener('pagehide', this.onClose);
    this.engine?.destroy();
    this.engine = null;
    this.clearFileTracks();
  }
```

**Code (e): `refresh`, replace lines 1023-1026**

Old:
```ts
      this.session = session;
      // A refresh of a cached session either keeps the cache or moves to the pass-through (the cache was cleared).
      this.set({ cached: session.cached });
      await this.attach(session, continueAt);
```
New:
```ts
      this.session = session;
      // A refresh of a cached session either keeps the cache or moves to the pass-through (the cache was cleared).
      this.set({ cached: session.cached, torrent: torrentView(session.torrent) });
      if (session.torrent !== null) this.followTorrent(session.torrent.infoHash);
      else this.stopTorrent();
      await this.attach(session, continueAt);
```

**Code (f): the poll, insert after `followCache` (after line 860, before the comment `// Chrome keeps a cue on the picture ...`)**
```ts
  /**
   * Keeps a torrent session's numbers and `cachedRanges` current: now, then every TORRENT_POLL_MS
   * while the tab shows, until the download is complete or failed. A hidden tab asks nothing and
   * asks again as soon as it shows (startAdaptivePoll). Reads only.
   */
  private followTorrent(infoHash: string): void {
    this.stopTorrent();
    this.torrentHash = infoHash;
    const run = async (): Promise<boolean> => {
      const done = await this.readTorrent(infoHash);
      if (done && this.torrentHash === infoHash) this.stopTorrent();
      return true;
    };
    if (isPageVisible()) void run();
    this.torrentPoll = startAdaptivePoll({ baseMs: TORRENT_POLL_MS, run });
  }

  private stopTorrent(): void {
    this.torrentPoll?.stop();
    this.torrentPoll = null;
    this.torrentHash = null;
  }

  /** One read of the torrent's status and map. True once there is nothing more to follow (complete or failed). */
  private async readTorrent(infoHash: string): Promise<boolean> {
    const [status, map] = await Promise.all([fetchTorrentStatus(infoHash, this.deps.fetch), fetchTorrentMap(infoHash, this.deps.fetch)]);
    const torrent = this.state.torrent;
    if (this.disposed || this.torrentHash !== infoHash || torrent === null || torrent.infoHash !== infoHash) return false;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.set({
      // A map the daemon could not give leaves the bar as it was.
      cachedRanges: map === null ? this.state.cachedRanges : scaleRanges(map.ranges, map.durationS, duration),
      torrent: status === null ? torrent : { ...torrent, state: status.state, peers: status.peers, downKbps: status.downKbps, progress: status.progress },
    });
    const state = status?.state ?? torrent.state;
    if (state === 'downloading') return false;
    this.note(state === 'ready' ? `torrent ${infoHash.slice(0, 8)} on disk` : `torrent ${infoHash.slice(0, 8)} failed`);
    return true;
  }

  /**
   * A torrent's play or a seek reached a part that is not on disk yet (`on`), or that part arrived.
   * Only a torrent session waits this way, and a part on disk is never waited for.
   */
  private markFetching(on: boolean): void {
    const torrent = this.state.torrent;
    if (torrent === null || torrent.fetching === on) return;
    if (on && (torrent.state === 'ready' || onDisk(this.state.cachedRanges, this.video.currentTime))) return;
    this.set({ torrent: { ...torrent, fetching: on } });
    if (on) this.note(`waiting for the torrent at ${round1(this.video.currentTime)} s`);
  }

  // The part a torrent's play waited for is here: the seek landed, or the film can play.
  private readonly onArrived = (): void => {
    this.markFetching(false);
  };
```
**Impact:** A torrent session reads `GET /api/stream/torrent/<hash>` and `/map` every 2 s while
the tab is visible and the download goes on, and once when it is already `ready`. A cloud session
and a cache session read nothing new. The position reports and the paused page's `beat` are
untouched, so a paused page still writes nothing.

### Step 4: The wait for a part not on disk, no automatic move, no pause cache
**File:** `web/src/stream/controller.ts:682`
**Change:** A seek or a wait on a torrent session whose position is not on disk marks `fetching`;
`seeked`, `canplay` and `playing` clear it. The stall counting stays (its `stalled at` lines still
go to the evidence log) but `changeSource` returns before asking when the page itself asks for a
torrent session: a torrent that buffers is still filling. The owner's ask (the button, S) still
goes, and the line names the next torrent's release, since every torrent's `provider` is `Torrent`.
A pause on a torrent session asks for no stream cache.

**Code (a): replace `onSeek` (lines 682-685)**
```ts
  private readonly onSeek = (): void => {
    this.lastSeekAt = Date.now();
    this.clearStallTimer();
    this.markFetching(true);
  };
```

**Code (b): replace `onWaiting` (lines 687-693)**
```ts
  // The film ran out of data while it should be playing. A wait that outlasts STALL_MIN_MS is a
  // stall; a seek's own wait, a pause and the first load are not. A torrent's wait for a part that
  // is not on disk yet is also shown as such.
  private readonly onWaiting = (): void => {
    if (this.state.stage === 'ready') this.markFetching(true);
    if (this.state.stage !== 'ready' || this.video.paused) return;
    // A seek's own wait is not a stall, unless it outlasts the grace.
    this.armStall(STALL_MIN_MS + Math.max(0, this.lastSeekAt + SEEK_GRACE_MS - Date.now()));
  };
```

**Code (c): replace `onMoving` (lines 708-710)**
```ts
  private readonly onMoving = (): void => {
    this.clearStallTimer();
    this.markFetching(false);
  };
```

**Code (d): replace `changeSource` with its doc comment (lines 718-764)**
```ts
  /**
   * The film keeps stalling: ask the daemon for another provider of the same title. The film on
   * screen plays on while the daemon resolves; only when another provider answered does the page
   * load its stream, at the position it had reached. A cached play has no provider to leave, a
   * muted check never moves (it measures the provider it was given), and a torrent that buffers is
   * still filling, so only the owner moves a torrent session (to the next torrent).
   */
  private async changeSource(byOwner = false): Promise<void> {
    const now = Date.now();
    if (this.disposed || this.askingSource || this.mutedMode || this.session === null || this.session.cached !== null || !this.onFilm()) return;
    if (!byOwner && this.session.torrent !== null) return;
    // The page's own asks are limited; the owner's (the button, S) are not.
    if (!byOwner && (this.sourceSwitches >= MAX_SOURCE_SWITCHES || (this.lastSourceAskAt > 0 && now - this.lastSourceAskAt < SOURCE_SWITCH_COOLDOWN_MS))) return;
    this.askingSource = true;
    this.lastSourceAskAt = now;
    const asked = this.sessionId;
    this.note(byOwner ? 'asked for another source' : `${this.stalls.length} stalls in ${Math.round(STALL_WINDOW_MS / 1000)} s: asking for another source`);
    this.stalls = [];
    this.set({ changingSource: true, sourceNotice: null });
    try {
      const answer = await switchSource(asked, this.deps.fetch);
      if (this.disposed || this.sessionId !== asked || this.state.stage === 'error') return;
      if (!answer.switched) {
        this.note(`source kept: ${answer.reason ?? 'no_other_source'}`);
        if (byOwner) this.set({ sourceNotice: NO_OTHER_SOURCE });
        return;
      }
      this.sourceSwitches += 1;
      const continueAt = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
      this.generation += 1;
      this.engine?.destroy();
      this.engine = null;
      this.ready = null;
      this.clearFileTracks();
      this.stopTorrent();
      this.session = answer.session;
      this.subtitleChosen = false;
      this.set({
        stage: 'refreshing',
        kind: answer.session.manifestKind,
        qualities: [],
        quality: -1,
        subtitles: [],
        cached: answer.session.cached,
        torrent: torrentView(answer.session.torrent),
        cachedRanges: [],
      });
      this.note(`source: ${answer.from ?? '?'} -> ${answer.provider ?? '?'} at ${round1(continueAt)} s`);
      // Every torrent's provider is `Torrent`: a torrent is named by its release.
      this.set({ sourceNotice: answer.session.torrent?.name ?? answer.provider });
      if (answer.session.torrent !== null) this.followTorrent(answer.session.torrent.infoHash);
      await this.loadFileSubtitles(answer.session);
      if (this.disposed || this.session !== answer.session) return;
      await this.attach(answer.session, continueAt);
    } catch (err) {
      if (!this.disposed && this.sessionId === asked) this.note(`source kept: ${err instanceof SessionError ? err.code : messageOf(err)}`);
    } finally {
      this.askingSource = false;
      if (!this.disposed) this.set({ changingSource: false });
    }
  }
```

**Code (e): `armPauseCache`, replace lines 782-796**
```ts
  // A pause that lasts: the owner waits for the film to load, so the daemon downloads it to this
  // machine meanwhile. Once per session; not for a play that is already a cache, a torrent (its
  // download is already on this machine's disk), a muted check, or DASH (which is never cached).
  private armPauseCache(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const session = this.session;
    if (
      this.mutedMode ||
      session === null ||
      session.cached !== null ||
      session.torrent !== null ||
      session.manifestKind === 'dash' ||
      this.cacheAskedFor === this.sessionId ||
      !this.onFilm() ||
      this.video.ended
    ) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.disposed || !this.video.paused || this.video.ended || !this.onFilm() || this.session !== session) return;
      this.cacheAskedFor = this.sessionId;
      void this.askCache(this.sessionId, true);
    }, PAUSE_CACHE_DELAY_MS);
  }
```
**Impact:** For cloud sessions nothing changes: the guard only returns for `session.torrent !== null`,
`sourceNotice` is still the provider's name or `'No other source'`, and `cachedRanges: []` was
already empty on any session that can switch (a cache session never switches). The existing tests
"a film that keeps stalling" and "a pause caches the film" keep passing unchanged.

### Step 5: The mark, the line about another source and the wait overlay in `StreamApp.tsx` and `stream.css`
**File:** `web/src/stream/StreamApp.tsx:2`
**Change:** Icon-only mark beside the title (Phosphor `Magnet` while downloading, `HardDrive` once
on disk) with two small numbers (`UsersThree` peers, `ArrowDown` speed); its tooltip and accessible
name say everything in words. The shuffle button and the line over the picture speak of torrents on
a torrent session. A spinner with `Fetching this part from peers` over the picture while a seek
waits. The grey bar needs no change: it already draws `cachedRanges`.

**Code (a): replace the icon import (lines 2-23)**
```tsx
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowDown,
  ArrowsIn,
  ArrowsOut,
  Bug,
  CheckCircle,
  CircleNotch,
  ClosedCaptioning,
  CloudArrowDown,
  GearSix,
  HardDrive,
  IconContext,
  Magnet,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react';
```

**Code (b): replace the controller import (line 24)**
```tsx
import { INITIAL_STATE, NO_OTHER_SOURCE, SUBTITLE_DELAY_STEP_MS, StreamController, type BugReportState, type ControllerDeps, type StreamState, type TorrentView } from './controller';
```

**Code (c): insert after `CachedMark` (after line 109, before `export function qualityLabel`)**
```tsx
/** A download speed the daemon gives in kilobits per second, the way a torrent client writes it: `850 kB/s`, `3.4 MB/s`. */
export function formatSpeed(kbps: number): string {
  const bytesPerS = (Math.max(0, kbps) * 1000) / 8;
  return bytesPerS >= 1_000_000 ? `${(bytesPerS / 1_000_000).toFixed(1)} MB/s` : `${Math.round(bytesPerS / 1000)} kB/s`;
}

/** The torrent mark's tooltip and accessible name. */
export function torrentLabel(t: TorrentView): string {
  if (t.state === 'ready') return `Playing a torrent download from this machine's disk (${t.name})`;
  if (t.state === 'failed') return `The torrent download stopped (${t.name})`;
  if (t.peers === null || t.downKbps === null) return `Playing from a torrent (${t.name}), finding peers`;
  const share = t.progress === null ? '' : `, ${Math.round(t.progress * 100)}% on disk`;
  return `Playing from a torrent (${t.name}): ${t.peers} ${t.peers === 1 ? 'peer' : 'peers'}, ${formatSpeed(t.downKbps)}${share}`;
}

/** Icons and two numbers, no words: a magnet with the peers and the speed while it downloads, a drive once the whole file is on disk. */
function TorrentMark({ torrent }: { torrent: TorrentView }) {
  const label = torrentLabel(torrent);
  return (
    <span className="st-torrent" role="img" aria-label={label} title={label} data-state={torrent.state}>
      {torrent.state === 'ready' ? <HardDrive /> : <Magnet />}
      {torrent.state === 'downloading' && torrent.peers !== null && (
        <span className="st-torrent-stat">
          <UsersThree />
          {torrent.peers}
        </span>
      )}
      {torrent.state === 'downloading' && torrent.downKbps !== null && (
        <span className="st-torrent-stat">
          <ArrowDown />
          {formatSpeed(torrent.downKbps)}
        </span>
      )}
    </span>
  );
}

/** The line over the picture about the last ask for another source; a torrent session speaks of torrents. Null: nothing to say. */
export function sourceLine(changing: boolean, notice: string | null, torrent: boolean): string | null {
  if (changing) return torrent ? 'Looking for another torrent…' : 'Looking for another source…';
  if (notice === null) return null;
  if (notice === NO_OTHER_SOURCE) return torrent ? 'No other torrent' : NO_OTHER_SOURCE;
  return torrent ? `Torrent: ${notice}` : `Source: ${notice}`;
}

export const FETCHING_LABEL = 'Fetching this part from peers';
```

**Code (d): replace `StageOverlay` (lines 344-363)**
```tsx
function StageOverlay({ state, onReport }: { state: StreamState; onReport?: () => void }) {
  if (state.stage === 'loading' || state.stage === 'refreshing' || state.stage === 'recovering') {
    return (
      <div className="st-center" role="status" aria-label={BUSY_LABELS[state.stage]}>
        <CircleNotch className="st-spin" />
      </div>
    );
  }
  if (state.stage === 'ready' && state.torrent?.fetching === true) {
    return (
      <div className="st-center st-fetching" role="status" aria-label={FETCHING_LABEL}>
        <CircleNotch className="st-spin" />
        <span>{FETCHING_LABEL}</span>
      </div>
    );
  }
  if (state.stage === 'error') {
    const code = state.error ?? 'unknown';
    return (
      <div className="st-center st-error" role="alert">
        <WarningCircle />
        <span>{ERRORS[code] ?? `Playback stopped (${code}).`}</span>
        {onReport !== undefined && <ReportButton report={state.bugReport} onReport={onReport} />}
      </div>
    );
  }
  return null;
}
```

**Code (e): the top line, replace lines 497-515 (`<div className="st-top">` to its closing `</div>`)**
```tsx
        <div className="st-top">
          <span className="st-title">{state.title}</span>
          {state.cached !== null && <CachedMark cached={state.cached} />}
          {state.torrent !== null && <TorrentMark torrent={state.torrent} />}
          {sourceText !== null && (
            <span className="st-notice" role="status">
              {sourceText}
            </span>
          )}
          {delayShown && (
            <span className="st-notice" role="status">
              {delayText(state.subtitleDelayMs)}
            </span>
          )}
          {state.switchError !== null && (
            <span className="st-notice" role="status">
              {switchErrorText(state.switchError.to === 'prev' ? 'previous' : 'next', state.switchError.code)}
            </span>
          )}
        </div>
```
and, in the body of `StreamApp`, insert after line 491 (`const fill = ...`):
```tsx
  const sourceText = sourceLine(state.changingSource, state.sourceNotice, state.torrent !== null);
```

**Code (f): the shuffle button, replace lines 571-575**
```tsx
          {state.cached === null && !muted && (
            <IconButton label={state.torrent !== null ? 'Another torrent (S)' : 'Another source (S)'} disabled={state.changingSource} onClick={() => controller?.anotherSource()}>
              {state.changingSource ? <CircleNotch className="st-spin" /> : <Shuffle />}
            </IconButton>
          )}
```

**Code (g): `web/src/stream/stream.css`, insert after line 112 (the closing `}` of `.st-cached[data-state='downloading']`)**
```css
/* A torrent session: a magnet with the peers and the speed while it downloads, a drive once on disk. */
.st-torrent {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-left: 10px;
  vertical-align: -3px;
  font-size: 16px;
  color: #e9c46a;
}
.st-torrent[data-state='ready'] {
  color: #9cc5a1;
}
.st-torrent[data-state='failed'] {
  color: #c0473a;
}
.st-torrent-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: #c9c8c0;
}
.st-torrent-stat svg {
  font-size: 14px;
  color: #e9c46a;
}
/* A seek past what is on disk: the page waits for those pieces. */
.st-fetching span {
  font-size: 13px;
  letter-spacing: 0.03em;
  color: #c9c8c0;
}
```
**Impact:** A cloud session's top line, shuffle button and overlays read exactly as before
(`sourceLine(…, false)` gives the old words). The idle fade hides the mark with the rest of `.st-top`;
the waiting overlay is not part of `.st-top`, so it stays while the controls fade.

### Step 6: Tests that drive the page and the controller through the daemon's routes and the video's events
**File:** `web/src/stream/controller.test.tsx:3`, `web/src/stream/StreamApp.test.tsx:5`
**Change:** Fake routes and `<video>` events only; assertions on state and DOM.

**Code (a): `controller.test.tsx`, replace the import on line 3**
```ts
import { CACHE_POLL_MS, SUBTITLE_DELAY_MAX_MS, cueText, MAX_REFRESHES, MAX_SOURCE_SWITCHES, PAUSE_CACHE_DELAY_MS, POSITION_INTERVAL_MS, SEEK_GRACE_MS, SOURCE_SWITCH_COOLDOWN_MS, STALLS_TO_SWITCH, STALL_MIN_MS, STALL_REPEAT_MS, StreamController, TORRENT_POLL_MS, onDisk, scaleRanges } from './controller';
```

**Code (b): `controller.test.tsx`, line 58 inside the first `parseSession` expectation**

Old:
```ts
      cached: null,
    });
```
New:
```ts
      cached: null,
      torrent: null,
    });
```

**Code (c): `controller.test.tsx`, append at the end of the file**
```ts
describe('a torrent session (torrent-stream-source phase 4)', () => {
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const NEXT = '0123456789abcdef0123456789abcdef01234567';
  const STATUS = `GET /api/stream/torrent/${HASH}`;
  const MAP = `GET /api/stream/torrent/${HASH}/map`;
  const torrentJson = (over: Record<string, unknown> = {}) => ({ info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52, ...over });
  const onTorrent = (over: Record<string, unknown> = {}) =>
    streamSessionJson({ provider: 'Torrent', manifest_kind: 'mp4', manifest_url: `/api/stream/torrent/${HASH}/f/0`, torrent: torrentJson(), ...over });
  const downloading = (over: Record<string, unknown> = {}) => jsonResponse({ info_hash: HASH, state: 'downloading', peers: 5, down_kbps: 4000, up_kbps: 800, progress: 0.2, ...over });
  const sixtyOnDisk = () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function playing(routes: Record<string, (call: FetchCall) => Response>, session: Record<string, unknown> = onTorrent()) {
    // Before the page starts: a torrent session sets its poll's timer at once.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(session), ...routes });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    const reads = (hash = HASH) => t.calls.filter((c) => c.method === 'GET' && c.url === `/api/stream/torrent/${hash}`).length;
    return { ...t, reads };
  }

  it('reads the torrent a session plays, and nothing it cannot use', () => {
    expect(parseSession(onTorrent()).torrent).toEqual({ infoHash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', seeds: 52, state: 'downloading' });
    expect(parseSession(onTorrent({ torrent: torrentJson({ info_hash: HASH.toUpperCase(), state: 'ready', seeds: 'x', index: 3 }) })).torrent).toEqual({
      infoHash: HASH,
      name: 'Sintel.2010.1080p.WEB.x264',
      index: null,
      seeds: null,
      state: 'ready',
    });
    expect(parseSession(onTorrent({ torrent: torrentJson({ info_hash: 'magnet:?xt=urn:btih:x' }) })).torrent).toBeNull();
    expect(parseSession(streamSessionJson()).torrent).toBeNull();
    // A session is never both: the torrent wins over a cache it should not name.
    expect(parseSession(onTorrent({ cached: { id: 'c1', state: 'ready', height: 720 } })).cached).toBeNull();
  });

  it('shows the peers, the speed and what is on disk while it downloads, and stops asking once it is complete', async () => {
    let ready = false;
    const t = await playing({
      [STATUS]: () => (ready ? jsonResponse({ info_hash: HASH, state: 'ready', peers: 0, down_kbps: 0, progress: 1 }) : downloading({ peers: 12, down_kbps: 27200, progress: 0.37 })),
      [MAP]: () => jsonResponse({ duration_s: 888, ranges: ready ? [[0, 888]] : [[0, 60], [400, 420]] }),
    });
    await vi.waitFor(() => expect(t.controller.getState().torrent).toMatchObject({ infoHash: HASH, state: 'downloading', peers: 12, downKbps: 27200, progress: 0.37, fetching: false }));
    expect(t.controller.getState().cachedRanges).toEqual([[0, 60], [400, 420]]);
    expect(t.controller.getState().cached).toBeNull();
    expect(t.controller.getState().log).toContain('from torrent 08ada5a7 Sintel.2010.1080p.WEB.x264 (downloading)');
    const before = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS);
    expect(t.reads()).toBeGreaterThan(before);
    ready = true;
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS);
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ torrent: { state: 'ready' }, cachedRanges: [[0, 888]] }));
    expect(t.controller.getState().log).toContain('torrent 08ada5a7 on disk');
    const done = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 5);
    expect(t.reads()).toBe(done);
  });

  it("puts the map on the film's own clock when the daemon counted it against another length", () => {
    expect(scaleRanges([[0, 100], [500, 1000]], 1000, 500)).toEqual([[0, 50], [250, 500]]);
    expect(scaleRanges([[0, 100]], null, 500)).toEqual([[0, 100]]);
    expect(scaleRanges([[0, 100]], 1000, 0)).toEqual([[0, 100]]);
    expect(onDisk([[0, 60]], 59.9)).toBe(true);
    expect(onDisk([[0, 60]], 61)).toBe(false);
  });

  it('asks nothing while the tab is hidden, and asks again as soon as it shows', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const t = await playing({ [STATUS]: () => downloading({ peers: 3 }), [MAP]: sixtyOnDisk });
    await vi.waitFor(() => expect(t.controller.getState().torrent?.peers).toBe(3));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const hidden = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 6);
    expect(t.reads()).toBe(hidden);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(t.reads()).toBe(hidden + 1));
  });

  it('a torrent that buffers never asks for another source by itself; the button moves to the next torrent and names it', async () => {
    const t = await playing({
      [STATUS]: () => downloading(),
      [MAP]: sixtyOnDisk,
      [`GET /api/stream/torrent/${NEXT}`]: () => jsonResponse({ info_hash: NEXT, state: 'ready', peers: 0, down_kbps: 0, progress: 1 }),
      [`GET /api/stream/torrent/${NEXT}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 888]] }),
      [`POST ${S1}/source`]: () =>
        jsonResponse({
          ...onTorrent({ manifest_url: `/api/stream/torrent/${NEXT}/f/0`, torrent: torrentJson({ info_hash: NEXT, name: 'Sintel.2010.720p.BluRay.x264', state: 'ready' }) }),
          switched: true,
          reason: null,
          from: 'Torrent',
          provider: 'Torrent',
        }),
    });
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    for (let i = 0; i < STALLS_TO_SWITCH * 2; i++) {
      t.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_MIN_MS);
      t.fire('playing');
    }
    const asks = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/source`);
    expect(asks()).toHaveLength(0);
    expect(t.controller.getState().log.filter((line) => line.startsWith('stalled at'))).toHaveLength(STALLS_TO_SWITCH * 2);
    expect(t.controller.getState().log.some((line) => line.includes('asking for another source'))).toBe(false);
    t.controller.anotherSource();
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(asks()).toHaveLength(1);
    expect(t.made[1].req).toMatchObject({ kind: 'mp4', src: `/api/stream/torrent/${NEXT}/f/0`, startAt: 30 });
    await vi.waitFor(() => expect(t.controller.getState().torrent).toMatchObject({ infoHash: NEXT, state: 'ready' }));
    expect(t.controller.getState().sourceNotice).toBe('Sintel.2010.720p.BluRay.x264');
    await vi.waitFor(() => expect(t.reads(NEXT)).toBeGreaterThanOrEqual(1));
    const first = t.reads();
    const next = t.reads(NEXT);
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 3);
    // The torrent it left is no longer read, and the next one is complete: nothing more to ask.
    expect(t.reads()).toBe(first);
    expect(t.reads(NEXT)).toBe(next);
  });

  it('a seek past what is on disk waits for it, and the wait ends when the part arrives', async () => {
    const t = await playing({ [STATUS]: () => downloading(), [MAP]: sixtyOnDisk });
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    t.media.currentTime = 400;
    t.fire('seeking');
    expect(t.controller.getState().torrent?.fetching).toBe(true);
    expect(t.controller.getState().log).toContain('waiting for the torrent at 400 s');
    t.fire('seeked');
    expect(t.controller.getState().torrent?.fetching).toBe(false);
    t.media.currentTime = 20;
    t.fire('seeking');
    expect(t.controller.getState().torrent?.fetching).toBe(false);
  });

  it('a cloud stream has no torrent and never waits this way', async () => {
    const t = await playing({}, streamSessionJson());
    t.media.currentTime = 400;
    t.fire('seeking');
    expect(t.controller.getState().torrent).toBeNull();
    expect(t.calls.some((c) => c.url.startsWith('/api/stream/torrent/'))).toBe(false);
  });

  it('a pause asks for no stream cache: the torrent is already on this machine', async () => {
    const t = await playing({ [STATUS]: () => downloading(), [MAP]: sixtyOnDisk, [`POST ${S1}/cache`]: () => jsonResponse({}) });
    t.media.paused = true;
    t.fire('pause');
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS * 2);
    expect(t.calls.filter((c) => c.url === `${S1}/cache`)).toEqual([]);
  });
});
```

**Code (d): `StreamApp.test.tsx`, replace the import on line 5**
```tsx
import { StreamApp, delayText, cachedLabel, episodeLabel, formatClock, formatSpeed, loadedGradient, reportLabel, reportText, sourceLine, switchErrorText, torrentLabel } from './StreamApp';
```

**Code (e): `StreamApp.test.tsx`, append at the end of the file**
```tsx
describe('the player on a torrent (torrent-stream-source phase 4)', () => {
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const torrent = { info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52 };
  const deps = (status: Record<string, unknown>) => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({
      'GET /api/stream/sessions/S1': () =>
        jsonResponse(streamSessionJson({ provider: 'Torrent', manifest_kind: 'mp4', manifest_url: `/api/stream/torrent/${HASH}/f/0`, torrent })),
      [`GET /api/stream/torrent/${HASH}`]: () => jsonResponse(status),
      [`GET /api/stream/torrent/${HASH}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] }),
    });
    return { made, deps: { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} } };
  };

  it('marks a torrent beside the title with its peers and speed, and draws what is on disk on the timeline', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(888);
    const { made, deps: d } = deps({ state: 'downloading', peers: 12, down_kbps: 27200, progress: 0.37 });
    const el = render(<StreamApp sessionId="S1" deps={d} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    act(() => {
      el.querySelector('video')!.dispatchEvent(new Event('durationchange'));
    });
    await settle();
    const mark = el.querySelector('.st-top .st-torrent');
    expect(mark?.getAttribute('aria-label')).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264): 12 peers, 3.4 MB/s, 37% on disk');
    expect(mark?.getAttribute('title')).toBe(mark?.getAttribute('aria-label'));
    expect([...el.querySelectorAll('.st-torrent-stat')].map((s) => s.textContent)).toEqual(['12', '3.4 MB/s']);
    expect(mark?.querySelectorAll('svg')).toHaveLength(3);
    expect(window.notesdStream?.torrent).toMatchObject({ infoHash: HASH, peers: 12, downKbps: 27200, state: 'downloading' });
    expect((el.querySelector('.st-seek') as HTMLInputElement).style.getPropertyValue('--st-loaded-bar')).toBe(
      'linear-gradient(to right, transparent 0%, var(--st-loaded) 0%, var(--st-loaded) 6.76%, transparent 6.76%)',
    );
    expect(button(el, 'Another torrent (S)')).not.toBeNull();
    expect(button(el, 'Another source (S)')).toBeNull();
    expect(el.querySelector('.st-cached')).toBeNull();
  });

  it('says it waits for a part a seek reached before it is on disk', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(888);
    let at = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(() => at);
    const { made, deps: d } = deps({ state: 'downloading', peers: 2, down_kbps: 800, progress: 0.07 });
    const el = render(<StreamApp sessionId="S1" deps={d} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    const video = el.querySelector('video')!;
    at = 400;
    act(() => {
      video.dispatchEvent(new Event('seeking'));
    });
    expect(el.querySelector('[role="status"][aria-label="Fetching this part from peers"]')?.textContent).toBe('Fetching this part from peers');
    act(() => {
      video.dispatchEvent(new Event('seeked'));
    });
    expect(el.querySelector('[aria-label="Fetching this part from peers"]')).toBeNull();
  });

  it('words the speed, the mark and the line about another source', () => {
    expect(formatSpeed(27200)).toBe('3.4 MB/s');
    expect(formatSpeed(800)).toBe('100 kB/s');
    expect(formatSpeed(0)).toBe('0 kB/s');
    const view = { infoHash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', seeds: 52, state: 'downloading' as const, peers: 1, downKbps: 800, progress: null, fetching: false };
    expect(torrentLabel(view)).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264): 1 peer, 100 kB/s');
    expect(torrentLabel({ ...view, peers: null, downKbps: null })).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264), finding peers');
    expect(torrentLabel({ ...view, state: 'ready' })).toBe("Playing a torrent download from this machine's disk (Sintel.2010.1080p.WEB.x264)");
    expect(torrentLabel({ ...view, state: 'failed' })).toBe('The torrent download stopped (Sintel.2010.1080p.WEB.x264)');
    expect(sourceLine(true, null, true)).toBe('Looking for another torrent…');
    expect(sourceLine(false, 'No other source', true)).toBe('No other torrent');
    expect(sourceLine(false, 'Sintel.2010.720p.BluRay.x264', true)).toBe('Torrent: Sintel.2010.720p.BluRay.x264');
    expect(sourceLine(true, null, false)).toBe('Looking for another source…');
    expect(sourceLine(false, 'No other source', false)).toBe('No other source');
    expect(sourceLine(false, 'VidFast', false)).toBe('Source: VidFast');
    expect(sourceLine(false, null, false)).toBeNull();
  });
});
```
**Impact:** `npm test` gains these cases. The existing `StreamApp.test.tsx` `afterEach` already calls
`vi.restoreAllMocks()`, which undoes the `duration`/`currentTime` getters.

### Step 7: The guide
**File:** `docs/guide/streaming.md:434`
**Change:** Describe the torrent player page where a reader of the player and of the stall counting
will look, and in the torrent section (Invariant 10: each phase writes its own subsection under
"Torrents").

**Code (a): "How a provider delivers", replace lines 444-448** (the end of the "While it plays" bullet and the "By hand" bullet)

Old:
```markdown
  (`source kept: no_other_source`). At most two moves per session, one ask per two minutes;
  a play from the cache and a `?muted=1` check never move.
- **By hand.** The shuffle button, or S, asks for another source at once and as often as wanted
  (a poor picture, a cinema recording): the same route, without the page's own limits. The line
  over the picture says `Looking for another source…`, then the new provider or `No other source`.
```
New:
```markdown
  (`source kept: no_other_source`). At most two moves per session, one ask per two minutes;
  a play from the cache, a torrent (it buffers because it is still filling, not failing; its stalls
  are only logged) and a `?muted=1` check never move.
- **By hand.** The shuffle button, or S, asks for another source at once and as often as wanted
  (a poor picture, a cinema recording): the same route, without the page's own limits. The line
  over the picture says `Looking for another source…`, then the new provider or `No other source`.
  On a torrent session the button is `Another torrent (S)` and moves to the next torrent: the line
  says `Looking for another torrent…`, then `Torrent: <release name>` or `No other torrent`.
```

**Code (b): "The player", insert after line 595** (after the bullet `- **From the cache.** ... (see "Playing from the cache").`)
```markdown
- **From a torrent.** A torrent session plays the file from this machine's disk as it downloads,
  with a magnet, the peers and the download speed beside the title (see "The player page on a
  torrent").
```

**Code (c): "The player", replace the closing paragraph (lines 642-644)**

Old:
```markdown
The page keeps its state on `window.notesdStream` (`stage`: `loading`, `ready`, `refreshing`,
`recovering` or `error`; `kind`, `levels`, `level`, subtitle
choice, `refreshes`, `errors`, the last position sent and a short log), for scripts that check a
play, and its `start()`.
```
New:
```markdown
The page keeps its state on `window.notesdStream` (`stage`: `loading`, `ready`, `refreshing`,
`recovering` or `error`; `kind`, `levels`, `level`, subtitle
choice, `refreshes`, `errors`, the last position sent and a short log; `cached`, `torrent` and
`cachedRanges` for a play from this machine's disk), for scripts that check a play, and its
`start()`.
```

**Code (d): the torrent subsection.** Append at the end of the "Torrents" section that phases 1 and
3 add (after their subsections, before the next section at the same level as "Torrents"), one
heading level below "Torrents" (`####` when "Torrents" is `###`):
```markdown
### The player page on a torrent

- **Beside the title** a magnet icon, the peers and the download speed (`7 peers`, `2.0 MB/s`), read
  from `GET /api/stream/torrent/<info hash>` every 2 s while the file downloads. Its tooltip names
  the release and how much of the file is on disk. Once the whole file is on disk the magnet becomes
  a drive and the numbers go.
- **The timeline's thick grey bar** is what the browser holds and what is on disk
  (`GET /api/stream/torrent/<info hash>/map`, read with the status), put on the film's own clock,
  so it grows as pieces arrive, paused or not.
- **The page stops asking** once the download is complete or failed, and asks nothing while its tab
  is hidden (it asks again as soon as the tab shows). These are reads: the position reports are those
  of any play, and a paused page's `beat` still writes nothing.
- **A seek past what is on disk waits.** A spinner and `Fetching this part from peers` show over the
  picture until the pieces arrive (the file route fetches the pieces of the asked range first) and
  the film plays on. The page's log says `waiting for the torrent at 200 s`.
- **No automatic move.** A torrent that buffers is still filling, so the page never asks for another
  source by itself; its `stalled at` lines still go to the stream evidence log. The shuffle button,
  `Another torrent (S)`, moves to the next torrent, and the line over the picture names its release.
- **No pause cache.** A pause asks for no stream cache: the download is already on this machine.
- `window.notesdStream.torrent` holds `infoHash`, `name`, `index`, `seeds`, `state`, `peers`,
  `downKbps` (kilobits per second), `progress` (0 to 1) and `fetching`; `cachedRanges` holds the
  stretches on disk, in seconds. The log says `from torrent <hash start> <release> (<state>)` when
  the page opens it and `torrent <hash start> on disk` when the download completes.
```

**Code (e): "Proving a change", insert after the bullet that ends `...so it is run when you expect it.` (line 1172)**
```markdown
- The player page on a torrent: `torrent-player.steps.mjs` on `verify.sh up --web` (the session and
  the torrent routes faked, a 300 s film made with ffmpeg) and `torrent-live.steps.mjs` on
  `verify.sh up --web --direct-stream --torrent` (a real torrent session); see the feature map entry.
```
**Impact:** None on `npm run docs:check` (no new route, variable or picture; no guide picture shows
the player page, so no `docs:shots` retake).

### Step 8: The feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md:63`
**Change:** The user-facing feature and what proves it.

**Code (a): insert after the "The prober" sub-feature bullet (the bullet that ends `...listed from the fake TMDB, the pass stopped at \`not_idle\`, nothing probed).`), before `## How to get to it (user POV)`**
```markdown
- The player page on a torrent (torrent-stream-source phase 4): beside the title a magnet with the
  peers and the download speed (`GET /api/stream/torrent/<hash>` every 2 s while it downloads and the
  tab shows; a drive once the file is on disk), the timeline's grey bar fed by
  `GET /api/stream/torrent/<hash>/map`, a spinner and `Fetching this part from peers` for a seek past
  what is on disk, no automatic move to another source (its stalls are only logged), the shuffle
  button (`Another torrent (S)`) moving to the next torrent and naming it, no pause cache;
  `window.notesdStream.torrent`. Logic proven by `npx vitest run web/src/stream`; in a real browser by
  `torrent-player.steps.mjs` and `torrent-live.steps.mjs` (below).
```

**Code (b): insert after the driving bullet "A pause caches the film and the timeline shows it" (the bullet that ends `...are in \`tests/integration/directStream.cache.int.test.ts\`.`)**
```markdown
- The player on a torrent, with the session and the torrent routes faked by Playwright (the real page
  build; a 300 s H.264/AAC MP4 made once with ffmpeg under `~/.local/state/notesd-verify/.torrent-film`,
  40% of it "on disk" until the steps release the rest): `$V up --web`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` (about 90 s). The
  transcript has `TORRENT STATUS PASS` (7 peers and 2.0 MB/s beside the title, the grey bar at 40%),
  `HIDDEN PASS` (a hidden tab asks nothing and asks again when it shows), `TORRENT WAIT PASS` (a seek to
  200 s shows `Fetching this part from peers`), `NO AUTO MOVE PASS` (three stalls logged, no
  `POST .../source`), `TORRENT READY PASS` (released: it plays on past 200 s, the bar reaches 100%, the
  drive mark shows, no more asks) and `SHUFFLE PASS` (S moves to the next torrent and the line names it),
  with screenshots `torrent-status`, `torrent-fetching` and `torrent-ready`.
- The player on a real torrent session (phase 1's loopback fixture torrent, phase 3's fake index):
  `$V up --web --direct-stream --torrent`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs`. The transcript has
  `TORRENT LIVE PASS` (the page read the daemon's peers and speed into the mark and
  `window.notesdStream.torrent`) and `TORRENT DISK PASS` (the download completes, the bar covers the
  film, the page stops asking).
```
**Impact:** The verifier finds the journeys from the map.

### Step 9: The two Playwright journeys
**File:** `.claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` (new),
`.claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs` (new)
**Change:** J2 drives the real page build with every daemon answer of a torrent session faked in
the shapes phases 1 and 3 give (deterministic numbers, a held byte range for the seek). J1 drives
the real page on a real torrent session of a `--torrent` run.

**Code (a): `torrent-player.steps.mjs`**
```js
// The player page on a torrent session (torrent-stream-source phase 4) in a throwaway daemon's real
// build (verify.sh up --web). The session, the torrent's status and map and its file route are
// answered here by a fake in the shapes phases 1 and 3 give the page: a 300 s H.264/AAC MP4 made
// once with ffmpeg, of which only the first 40% is "on disk" until the steps release the rest.
// Nothing leaves this machine and no Chrome on Windows is touched.
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs
// TORRENT_FILM_DIR overrides where the film is kept (default ~/.local/state/notesd-verify/.torrent-film).
// Logs "TORRENT STATUS PASS", "HIDDEN PASS", "TORRENT WAIT PASS", "NO AUTO MOVE PASS",
// "TORRENT READY PASS", "SHUFFLE PASS"; the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = process.env.TORRENT_FILM_DIR ?? path.join(os.homedir(), '.local/state/notesd-verify/.torrent-film')
const FILM = path.join(DIR, 'film.mp4')
const DURATION_S = 300
/** The share of the file "on disk" until the steps release the rest. */
const ON_DISK = 0.4
const FIRST = { hash: '08ada5a7a6183aae1e09d831df6748d566095a10', name: 'Fixture.Film.2026.1080p.WEB.x264' }
const NEXT = { hash: '0123456789abcdef0123456789abcdef01234567', name: 'Fixture.Film.2026.720p.BluRay.x264' }
const PEERS = 7
/** 16 000 kilobits per second: 2.0 MB/s. */
const DOWN_KBPS = 16000

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFilm() {
  if (existsSync(FILM)) return
  mkdirSync(DIR, { recursive: true })
  const part = path.join(DIR, 'film.part.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION_S}:size=640x360:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION_S}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', part,
  ])
  renameSync(part, FILM)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await cond()) return
    await page.waitForTimeout(250)
  }
  check(await cond(), what)
}

/** How far the timeline's thick grey bar reaches, in percent of the film (0 without one). */
const loadedTo = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')
    const stops = [...bar.matchAll(/var\(--st-loaded\) ([\d.]+)%/g)].map((m) => Number(m[1]))
    return stops.length === 0 ? 0 : Math.max(...stops)
  })

/** window.notesdStream without its start() (functions do not cross into the steps). */
const streamState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.notesdStream ?? null)))

const setVisibility = (page, state) =>
  page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)

export default async ({ page, base, shot, log }) => {
  makeFilm()
  const film = readFileSync(FILM)
  const size = film.length
  const cut = Math.floor(size * ON_DISK)
  const fake = { current: FIRST, released: false, statusReads: {}, sourceAsks: 0, cacheAsks: 0, held: 0 }
  const reads = (hash = FIRST.hash) => fake.statusReads[hash] ?? 0

  // Phase 3's SessionInfo for a torrent session.
  const sessionJson = () => ({
    session_id: 'T1',
    kind: 'movie',
    tmdb_id: 1,
    season: null,
    episode: null,
    title: 'Fixture Film (2026)',
    provider: 'Torrent',
    manifest_kind: 'mp4',
    manifest_url: `/api/stream/torrent/${fake.current.hash}/f/0`,
    subtitles: [],
    best_height: 360,
    resume_s: 0,
    created_at: null,
    refreshed_at: null,
    expires_at: null,
    cached: null,
    torrent: { info_hash: fake.current.hash, name: fake.current.name, index: 'Fixture', state: fake.released ? 'ready' : 'downloading', seeds: 52 },
  })

  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (req.method() === 'GET' && u.pathname === '/api/stream/sessions/T1') return route.fulfill({ json: sessionJson() })
    if (req.method() === 'POST' && u.pathname === '/api/stream/sessions/T1/source') {
      fake.sourceAsks += 1
      fake.current = NEXT
      return route.fulfill({ json: { ...sessionJson(), switched: true, reason: null, from: 'Torrent', provider: 'Torrent' } })
    }
    if (req.method() === 'POST' && u.pathname === '/api/stream/sessions/T1/cache') fake.cacheAsks += 1
    // Positions and log lines: the page ignores the answer, a 404 included.
    return route.fulfill({ status: 404, json: { error: 'not_found' } })
  })

  // Phase 1's torrent routes: the status, the map and the file with Range.
  await page.route('**/api/stream/torrent/**', async (route) => {
    const req = route.request()
    const m = /^\/api\/stream\/torrent\/([0-9a-f]{40})(\/map|\/f\/0)?$/.exec(new URL(req.url()).pathname)
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } })
    const [, hash, tail] = m
    if (tail === undefined) {
      fake.statusReads[hash] = reads(hash) + 1
      return route.fulfill({
        json: fake.released
          ? { info_hash: hash, state: 'ready', peers: 0, down_kbps: 0, up_kbps: 0, progress: 1 }
          : { info_hash: hash, state: 'downloading', peers: PEERS, down_kbps: DOWN_KBPS, up_kbps: 800, progress: ON_DISK },
      })
    }
    if (tail === '/map') {
      return route.fulfill({ json: { duration_s: DURATION_S, ranges: fake.released ? [[0, DURATION_S]] : [[0, DURATION_S * ON_DISK]] } })
    }
    const asked = /bytes=(\d+)-(\d*)/.exec(req.headers()['range'] ?? '')
    const start = asked ? Number(asked[1]) : 0
    let end = asked && asked[2] !== '' ? Math.min(Number(asked[2]), size - 1) : size - 1
    if (!fake.released) {
      if (start >= cut) {
        // Not on disk yet: the answer waits for the pieces, as phase 1's file route does.
        fake.held += 1
        while (!fake.released) await sleep(250)
      } else {
        end = Math.min(end, cut - 1)
      }
    }
    try {
      await route.fulfill({
        status: 206,
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` },
        body: film.subarray(start, end + 1),
      })
    } catch {
      // The page gave the request up (a seek): nothing to answer.
    }
  })

  await page.goto(`${base}/stream/T1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  // Chromium refuses sound without a gesture: the page plays muted, which is still a play.
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2
  }, null, { timeout: 30_000 })
  await page.mouse.move(400, 400)

  // R2.7: the peers, the speed and the stretches on disk.
  const mark = page.locator('.st-top .st-torrent')
  await mark.waitFor({ state: 'attached', timeout: 10_000 })
  await until(page, async () => ((await mark.getAttribute('aria-label')) ?? '').includes(`${PEERS} peers, 2.0 MB/s`), 10_000, 'the torrent mark names the peers and the speed')
  const stats = await page.locator('.st-torrent-stat').allTextContents()
  check(stats[0] === String(PEERS) && stats[1] === '2.0 MB/s', `the numbers beside the title are ${JSON.stringify(stats)}`)
  const first = await streamState(page)
  check(first.torrent?.infoHash === FIRST.hash && first.torrent.peers === PEERS && first.torrent.downKbps === DOWN_KBPS, `window.notesdStream.torrent is ${JSON.stringify(first.torrent)}`)
  const bar = await loadedTo(page)
  check(bar >= 39.5 && bar <= 45, `the grey bar reaches what is on disk, 40% (to ${bar}%)`)
  await shot('torrent-status')
  log('TORRENT STATUS PASS')

  // Polls stop while the tab is hidden and start again when it shows.
  await setVisibility(page, 'hidden')
  await page.waitForTimeout(500)
  const hiddenFrom = reads()
  await page.waitForTimeout(6_000)
  check(reads() === hiddenFrom, `a hidden tab asked ${reads() - hiddenFrom} times`)
  await setVisibility(page, 'visible')
  await until(page, async () => reads() > hiddenFrom, 3_000, 'the tab asks again as soon as it shows')
  log('HIDDEN PASS')

  // A seek past what is on disk waits for it, through the page's own Position control.
  await page.getByLabel('Position').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '200')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const waiting = page.getByRole('status', { name: 'Fetching this part from peers' })
  await waiting.waitFor({ timeout: 5_000 })
  check((await streamState(page)).torrent?.fetching === true, 'window.notesdStream.torrent.fetching is true while it waits')
  await shot('torrent-fetching')
  log('TORRENT WAIT PASS')

  // One long freeze is counted as a stall every 10 s; on a torrent none of them asks for another source.
  const lines = async (prefix) => ((await streamState(page)).log ?? []).filter((line) => line.startsWith(prefix)).length
  await until(page, async () => (await lines('stalled at')) >= 3, 45_000, 'the frozen film is counted as a stall three times')
  check(fake.sourceAsks === 0, `the page asked for another source by itself (${fake.sourceAsks} asks)`)
  check(!((await streamState(page)).log ?? []).some((line) => line.includes('asking for another source')), 'no "asking for another source" line')
  check(fake.held > 0, 'the page asked for bytes past what is on disk')
  log('NO AUTO MOVE PASS')

  // The pieces arrive: the film plays on, the bar covers it, the page stops asking.
  fake.released = true
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 202
  }, null, { timeout: 30_000 })
  await waiting.waitFor({ state: 'detached', timeout: 5_000 })
  await until(page, async () => (await streamState(page)).torrent?.state === 'ready', 10_000, 'the torrent turns to on disk')
  await until(page, async () => (await loadedTo(page)) === 100, 10_000, 'the grey bar reaches the end once the whole file is on disk')
  check((await page.locator('.st-torrent[data-state="ready"]').count()) === 1, 'the drive mark shows')
  const doneAt = reads()
  await page.waitForTimeout(7_000)
  check(reads() === doneAt, `the page kept asking after the download was complete (${reads() - doneAt} more)`)
  await page.mouse.move(420, 420)
  await shot('torrent-ready')
  log('TORRENT READY PASS')

  // The owner's shuffle (S) moves to the next torrent and the line names its release.
  await page.keyboard.press('s')
  await page.locator('.st-notice', { hasText: `Torrent: ${NEXT.name}` }).waitFor({ state: 'attached', timeout: 10_000 })
  await until(page, async () => (await streamState(page)).torrent?.infoHash === NEXT.hash, 10_000, 'the page plays the next torrent')
  check(fake.sourceAsks === 1, `one ask for another source (${fake.sourceAsks})`)
  check(reads(NEXT.hash) >= 1, "the page reads the next torrent's numbers")
  check((await page.getByRole('button', { name: 'Another torrent (S)' }).count()) === 1, 'the shuffle button is named for torrents')
  check(fake.cacheAsks === 0, 'a torrent session never asks for a stream cache')
  log('SHUFFLE PASS')
}
```

**Code (b): `torrent-live.steps.mjs`**
```js
// The player page on a real torrent session (torrent-stream-source phase 4) in a throwaway daemon
// with torrents on: verify.sh up --web --direct-stream --torrent (phase 1's loopback-seeded fixture
// torrent, phase 3's fake index). The real play, the real torrent routes, the real page; Chromium
// here, never the owner's streaming Chrome, and no swarm beyond loopback.
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs
// TORRENT_PLAY overrides the play's JSON body (default {"kind":"movie","tmdb_id":467905,"provider":"torrent"}).
// Logs "TORRENT LIVE PASS", "TORRENT DISK PASS"; the first failed check throws and fails the run.
const PLAY = process.env.TORRENT_PLAY ? JSON.parse(process.env.TORRENT_PLAY) : { kind: 'movie', tmdb_id: 467905, provider: 'torrent' }

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await cond()) return
    await page.waitForTimeout(250)
  }
  check(await cond(), what)
}

const loadedTo = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')
    const stops = [...bar.matchAll(/var\(--st-loaded\) ([\d.]+)%/g)].map((m) => Number(m[1]))
    return stops.length === 0 ? 0 : Math.max(...stops)
  })

const streamState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.notesdStream ?? null)))

export default async ({ page, base, shot, log }) => {
  const origin = new URL(base).origin
  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: PLAY })
  check(played.ok(), `POST /api/stream/play answered ${played.status()}: ${await played.text()}`)
  const session = (await played.json()).session
  const hash = session?.torrent?.info_hash
  check(typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash), `the session names a torrent (${JSON.stringify(session?.torrent)})`)

  const statuses = []
  page.on('response', async (res) => {
    if (new URL(res.url()).pathname !== `/api/stream/torrent/${hash}`) return
    statuses.push({ status: res.status(), body: await res.json().catch(() => null) })
  })

  await page.goto(`${base}/stream/${session.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.mouse.move(400, 400)
  const mark = page.locator('.st-top .st-torrent')
  await mark.waitFor({ state: 'attached', timeout: 10_000 })
  await until(
    page,
    async () => statuses.some((s) => s.status === 200 && typeof s.body?.peers === 'number' && typeof s.body?.down_kbps === 'number'),
    15_000,
    "the page read the torrent's peers and speed from the daemon",
  )
  const live = await streamState(page)
  check(live.torrent?.infoHash === hash && typeof live.torrent.peers === 'number' && typeof live.torrent.downKbps === 'number', `window.notesdStream.torrent is ${JSON.stringify(live.torrent)}`)
  const label = (await mark.getAttribute('aria-label')) ?? ''
  check(/^Playing (from a torrent|a torrent download)/.test(label), `the mark says "${label}"`)
  await shot('torrent-live')
  log('TORRENT LIVE PASS')

  await until(page, async () => (await streamState(page)).torrent?.state === 'ready', 180_000, 'the download completes')
  await until(page, async () => (await loadedTo(page)) === 100, 10_000, 'the grey bar covers the whole film once it is on disk')
  const map = await (await page.request.get(`${base}/api/stream/torrent/${hash}/map`, { headers: { origin } })).json()
  check(Array.isArray(map.ranges) && map.ranges.length >= 1, `the daemon's map is ${JSON.stringify(map)}`)
  const asked = statuses.length
  await page.waitForTimeout(7_000)
  check(statuses.length === asked, `the page kept asking after the download was complete (${statuses.length - asked} more)`)
  await shot('torrent-on-disk')
  log('TORRENT DISK PASS')
}
```
**Impact:** Harness files only; nothing in `npm test` runs them.

## Principles applied

- Laziness protocol: the grey bar reuses `cachedRanges` and `loadedGradient` (no second ranges field, no StreamApp change for the bar); the hidden-tab rule reuses `startAdaptivePoll` from `web/src/lib/pageActive.ts` instead of a new `visibilitychange` listener; the torrent map shares the cache map's reader (`fetchDiskMap`); `nativeEngine.ts` is left unchanged because a torrent's local file route is a plain file to it.
- Make illegal states unrepresentable: `fetching` lives inside `TorrentView`, so only a torrent session can "wait for a part not on disk"; `parseSession` never answers a session that is both `cached` and `torrent`.
- Boundary discipline: the daemon's torrent JSON (hash format, state words, counts, speed, progress) is validated once in `session.ts` (`torrentInfo`, `fetchTorrentStatus`, `fetchDiskMap`); the controller and the view trust the typed values.
- Test behavior, not implementation: the new tests drive fake daemon routes and `<video>` events and assert `getState()`, the DOM and the requests made, never private methods.
- Prove it works: two Playwright journeys on the real page build (one fully faked and deterministic, one on a real torrent session), not only the unit tests.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run web/src/stream && npm test`
**Proof:** the real player page in Chromium on a throwaway daemon, once with every torrent answer faked in phase 1/3's shapes (deterministic numbers and a held byte range) and once on a real loopback torrent session.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web`, `verify.sh ui`)
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md`
- Journeys:
  - **J1** · traces R2.7 — `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --web --direct-stream --torrent` (note `RUN=`), then `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs`, then `$V down RUN` → passes when the ui transcript holds `TORRENT LIVE PASS` (the page read `GET /api/stream/torrent/<hash>` with numeric `peers` and `down_kbps`, `window.notesdStream.torrent` carries them, the mark beside the title says `Playing from a torrent …`) and `TORRENT DISK PASS` (`window.notesdStream.torrent.state` is `ready`, the grey bar reaches 100%, no status request in the 7 s after)
  - **J2** · traces R2.7 — `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --web` (note `RUN=`), then `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` (about 90 s; makes `~/.local/state/notesd-verify/.torrent-film/film.mp4` with ffmpeg on first use), then `$V down RUN` → passes when the ui transcript holds, in order, `TORRENT STATUS PASS` (the `.st-torrent-stat` texts are `7` and `2.0 MB/s` and the grey bar reaches 39.5-45%), `HIDDEN PASS`, `TORRENT WAIT PASS` (after a seek to 200 s the status `Fetching this part from peers` shows), `NO AUTO MOVE PASS` (three `stalled at` lines and zero `POST .../source`), `TORRENT READY PASS` (the film plays past 202 s, the bar reaches 100%, `data-state="ready"`, no status request in 7 s) and `SHUFFLE PASS` (the line reads `Torrent: Fixture.Film.2026.720p.BluRay.x264`), with screenshots `torrent-status`, `torrent-fetching`, `torrent-ready` in the run's evidence
- Neighbor check: the automatic move of a cloud session and the cache's grey bar are the features most likely to break (`changeSource`'s guard, `fetchCacheMap`'s new body). `npx vitest run web/src/stream` must keep "a film that keeps stalling" and "a pause caches the film" green; on a real browser, `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")`, `$V up --web --direct-stream` (note `DIRECT=`), `DIRECT=<that path> DASH_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/source-switch.steps.mjs` → `SWITCH PASS`; and on a second `up --web --direct-stream` run, `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-film.sh "$HOME/.local/state/notesd-verify/.stream-fixture-hls-film")`, `DIRECT=<that path> HLS_FILM="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/pause-cache.steps.mjs` → `CACHE BAR PASS`
- Cost: none (no LLM turn, no provider, no swarm beyond loopback)
**Exit criteria:** `npm run typecheck` and `npm test` pass; J2's transcript holds all six PASS lines; J1's holds `TORRENT LIVE PASS` and `TORRENT DISK PASS` on a run with phases 1 and 3 landed; the neighbor journeys still pass.

## Handoffs

- **Phase 1 (the torrent routes), R2.7 depends on these exact shapes:** `GET /api/stream/torrent/:hash` answers at the top level `state` (`downloading`, `ready` or `failed`), `peers` (a number), `down_kbps` in kilobits per second (bytes × 8 / ms, like the evidence log's `kbps`; the page shows it as `kB/s`/`MB/s` by dividing by 8), `progress` from 0 to 1; a GET needs no same-origin header (the page sends none, like the cache map's GET). `GET /api/stream/torrent/:hash/map` answers `{ duration_s, ranges: [[from_s, to_s], …] }` in seconds; the page puts the ranges on the browser's own duration when `duration_s` differs (`scaleRanges`), so an estimated `duration_s` is fine. If phase 1 picks kilobytes for `down_kbps`, `formatSpeed` must drop its `/ 8` (one line) and its test values change. J1 needs phase 1's `verify.sh up --torrent` mode.
- **Phase 3 (SessionInfo and the switch), R2.7 depends on:** `SessionInfo.torrent` with `info_hash` (40 hex characters), `name` (the release), `index` (the index's name as a string; a number would be read as null), `state`, `seeds`; never `cached` and `torrent` together. `POST /api/stream/sessions/:id/source` on a torrent session answers the existing shape with the next candidate's `torrent`, or `switched: false` with `reason: "no_other_source"`. J1 needs `POST /api/stream/play` with `{"kind":"movie","tmdb_id":467905,"provider":"torrent"}` to answer a torrent session on a `--torrent` run (or the verifier sets `TORRENT_PLAY` to the body phase 3's fake index answers).
- **Phase 5 (remux, `hlsEngine.ts`):** the controller's torrent handling is engine-agnostic (it keys on `session.torrent`, the `<video>`'s `waiting`/`seeking`/`seeked`/`canplay`/`playing` events and the map), so a torrent session on `manifest_kind: "hls"` gets the mark, the bar, the wait and no automatic move without a change here. A growing playlist's buffer stays `BUFFER_AHEAD_S` (the controller passes it for any session not a ready cache).
- **Phase 7 (`subtitles.ts`, the growing track):** phase 7 depends on this phase (reconciled), so it edits `session.ts` and `controller.ts` as this phase leaves them. Its edits meet this phase's only at the imports; `loadFileSubtitles`, `clearFileTracks` and `FileTrack` are untouched here.
- **Phase 3 (reconciled):** `index` and `seeds` are null on a replay from disk; `/map` answers seconds because phase 3 calls `setDuration` after its probe. J1's live run plays TMDB movie 467905 (a title of the fake TMDB; the fake index names its release after it). Phase 3 owns `scripts/stream/torrent-play.steps.mjs`, so this phase's live journey is `torrent-live.steps.mjs`.
- **Left as found:** the guide's "Controls" bullet in "The player" does not list the shuffle button (true before this plan); not changed here.

## Rollback

Revert this phase's commit: it touches only `web/src/stream/{session,controller,StreamApp}.ts(x)`,
`stream.css`, their two test files, the guide, the feature map and two new step scripts. No database,
route or setting changes. Without it a torrent session still plays in the page (phase 3), only
without the mark, the on-disk bar and the wait, and with the automatic move on.

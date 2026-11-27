# Phase 3: Stream health: route, MCP tool, page

**Plan set:** `STREAM_PLAY_LOG_PLAN.md`
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Satisfies:** R2 — "A small health view on the Stream side and one MCP tool, so 'how did torrents do this week?' is a query instead of a soak."
**Criteria:** R2.1, R2.2, R2.3, R2.4, R2.5
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `src/directStream/playLog`, `src/http`, `src/mcp`, `web/src/components/movies`

---

## Goal

After this phase the play log that phase 1 fills can be read three ways, all built from one function:
`GET /api/stream/health?days=N`, the MCP tool `direct_stream_health` (the chat bar may call it), and the
page `/movies/health`, opened by a Phosphor heartbeat icon beside the Cache drive icon on the Stream side.
Each answers, for this host, per channel and per torrent index or cloud provider: start success
(played / asks; a short play counts as a success), median time to answer, median first frame, stalls per
hour, stalled share and the share at 1080p or better, the failures by word, the latest plays, and every
film or episode that could not be played (all time) with what the cloud and the torrents last answered.

## Assumes from phase 1

Reconciled against phase 1's plan: each item below is what phase 1 builds. Phase 3 reads only; nothing here
writes `stream_play_log`.

1. Table `stream_play_log` exists (migration `0044_stream_play_log`) with exactly the column names of the
   index's contract, **including** `cloud_failure` and `torrent_failure` (text null). Phase 3 reads it with
   raw SQL by those snake_case names, so it does not depend on the Drizzle field names.
2. `src/directStream/playLog/repo.ts` exports `class PlayLogRepo implements PlayLogWriter` with
   `constructor(private readonly db: Db)` (the `Db` of `src/db/client.ts`). Its drizzle import is
   `import { and, eq, isNotNull, isNull } from 'drizzle-orm';` with no `sql`: Step 2 changes that line to
   `import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';`. The file declares no `iso`, `toHealthRow`
   or `toUnhandled`, so Step 2's helpers keep their names. Phase 3 appends three read methods after phase 1's
   `bySession` and the helpers at the end of the file.
3. `host` on every row is `movies.host` (phase 1 builds `new PlayLog({ repo: new PlayLogRepo(db), host:
   movies.host })` in `src/daemon.ts`); `AppDeps.movies.host` is the same value. Phase 3 reads with
   `deps.movies.host`.
4. `kind` and `tmdb_id` are not null on every row (CHECK `stream_play_log_slot_check`: `tmdb_id > 0`, a film
   has null `season` and `episode`, an episode has `season >= 0` and `episode > 0`).
5. On a `failed` row `channel` is **always** null and `session` null (CHECKs `stream_play_log_channel_check`,
   `stream_play_log_session_check`); `cloud_failure` / `torrent_failure` say which channels were asked
   (null: not asked; both null for a title not out yet or a cache/episode failure that asked no channel).
   On every other row `channel` is set: `cloud`, `torrent` or `cache` with a session, `site` (and only
   `site`) on an outcome-`site` row. `channelsOf`'s `channel !== null` branch is therefore the non-failed
   path and its `asked`/`none` branches are the failed-row fallbacks.
6. `outcome = 'site'` is written by phase 1 when `play` answers with a `SitePlayResult` (a streaming site's
   player took the ask), so phase 3 counts it as a play that reached the screen.
7. Phase 1 adds `stream_play_log` at the head of `truncateAll` (`tests/integration/setup.ts`), so the
   integration test's `truncateAll` empties it; no extra truncate is needed.
8. A row with `ended` set has `ended_at` set (CHECK `stream_play_log_ended_check`: `(ended is null) =
   (ended_at is null)`, and `ended` only on a session row). Every seed below that sets `ended` sets
   `ended_at` too.
9. The words phase 1 writes (its Handoffs): `failure` is one of `no_source`, `resolve_failed`, `open_failed`,
   `unknown_session`, `no_episode`, `no_subtitle`, `torrent_off`, `bad_info_hash`, `not_on_this_machine`,
   `cache_failed`, `cache_language`, `error`; `cloud_failure`/`torrent_failure` one of `resolved`, `no_stream`,
   `bot_check`, `error`, `dubbed`, `unplayable`, `skipped`, `skipped_browser_only`, `skipped_no_template`,
   `no_source`, `resolve_failed`, `torrent_off`. Step 8's `failureText` words every one of them.
10. **AppDeps:** phase 3 does **not** read phase 1's `AppDeps.playLog`. Like `/api/movies/trending`
   (`src/http/moviesApi.ts:372`, `new TrendingRepo(db)`), the reader builds `new PlayLogRepo(deps.db)`:
   the repo is stateless and read-only here.
11. Phase 1's guide section is `### The play log` in `docs/guide/streaming.md` (anchor `#the-play-log`, no other
   heading of that name in the file). Phase 3 links it as `streaming.md#the-play-log`.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `src/directStream/playLog/health.ts`: `HEALTH_DEFAULT_DAYS`, `HEALTH_MAX_DAYS`, `HEALTH_RECENT_LIMIT`, `HEALTH_UNHANDLED_LIMIT`, types `HealthRow`, `UnhandledEntry`, `Figures`, `SourceFigures`, `FailureCount`, `RecentPlay`, `HealthAnswer`, `PlayLogReader`, `StreamHealthReader`, functions `channelsOf`, `sourceOf`, `median`, `figures`, `buildHealth`, `readHealth`, `streamHealthReader`
- Methods on `PlayLogRepo` (`src/directStream/playLog/repo.ts`, phase 1's file): `healthRows(host, since)`, `firstAskedAt(host)`, `unhandled(host, limit)`; module-level `toHealthRow`, `toUnhandled`, `iso` helpers in the same file
- `src/http/streamHealthApi.ts`: `streamHealthRoutes`, `STREAM_HEALTH_OFF`
- `src/mcp/streamHealthTool.ts`: `registerStreamHealthTool`
- `src/chat/status.ts`: `STREAM_HEALTH_TOOL_NAME = 'direct_stream_health'`
- `ToolDeps.streamHealth?: StreamHealthReader | null` (`src/mcp/tools.ts`)
- Route `GET /api/stream/health`; MCP tool `direct_stream_health`
- Web: `web/src/components/movies/HealthPage.tsx` (+ `.css`, + `.test.tsx`), `fetchStreamHealth` and `StreamHealth*` types in `web/src/moviesApi.ts`, `MOVIES_HEALTH_SEGMENT`, `HEALTH_ROUTE`, `MoviesRoute.health` in `web/src/lib/route.ts`, `HEALTH_HEADING` in `web/src/lib/movies.ts`
**Contract extension (the reconciler copies it into the index's "Health answer"):** `Figures` gains `success_rate` (played / asks, null with no ask), as the owner asked ("success rate (played / asks) per channel is a headline figure"). `played` in `Figures` counts outcome `played` **and** `site` (a site's player ran). `hd_share` is over played rows whose height is known (null when none). `stalled_share` is `stalled_ms / played_ms`. `totals` always carries `all`, `cloud` and `torrent` (zeros when empty), plus `cache`, `site`, `none` when rows have them. A failed row with a null `channel` is counted under each channel it asked (`cloud_failure` / `torrent_failure` set), and once under `all`; it is in no `by_source` entry. The tool's answer is the route's plus `link` and `next`.
**Signature changes:** none
**Requires (from earlier phases):** phase 1's table with `cloud_failure`/`torrent_failure`, its CHECKs, `class PlayLogRepo(db)`, `truncateAll` emptying `stream_play_log`, and the guide heading `### The play log` (see "Assumes from phase 1"; all are in phase 1's plan).
**Leaves alone (owned by others):** every write to `stream_play_log` and the rest of `PlayLogRepo` (phase 1); `src/directStream/service.ts`, `src/http/directStreamApi.ts`, `src/daemon.ts`, `src/deps.ts` (phase 1); `web/src/stream/*` (phase 2); `src/sessions/*` (phase 4); `src/reminders/*`, `claude/hooks/*`, the `remind` tool (phase 5); ranking, finder, shuffle, auto-switch.
**Shared files (reconciled; phase 1 lands before this phase, phase 5 runs at the same time as this one):**
- `src/directStream/playLog/repo.ts` (phase 1's file): this phase changes only the `drizzle-orm` import line, appends after `bySession`, and appends at the file's end.
- `docs/guide/streaming.md`: phase 1's "### The play log" is already there (before `### Direct streaming answers`); this phase's "### Stream health" goes before `### Reporting a stream bug`, far from it.
- `src/mcp/server.ts` (concurrent with phase 5): this phase owns exactly two lines, the import after `import { registerStreamDiskTool } from './streamDiskTool.js';` and the register call (with its comment) after `registerStreamDiskTool(server, deps);`. Phase 5 owns the import after `import { registerSubtitleCheckTools } ...` and the register after `registerSubtitleCheckTools(server, deps);`. On a merge conflict keep both pairs; neither phase edits the other's lines.
- `docs/guide/reference/mcp-tools.md`, `docs/guide/reference/http-api.md` (generated; concurrent with phase 5): never merged by hand. Whichever of phases 3 and 5 lands second, and the integrator after the wave, reruns `npm run docs:gen` so both files hold `direct_stream_health`, `remind`, `GET /api/stream/health` and phase 5's start-route text. Phase 1 changes no route description, so nothing of phase 1's is regenerated here.
- `scripts/docs/httpRoutes.ts` (concurrent with phase 5): this phase adds the `Stream health` group after the `Cache page` group (:350); phase 5 rewrites only the `'POST /api/sessions/hook/start'` value (:138-139).
- `.claude/skills/verify-notesd/features/README.md`: this phase edits only the Movies row (:19); phase 1 already edited the Direct streaming row (:20); phase 5 adds a Reminders row after the Projects row (:14).
- `tests/unit/chat-status.test.ts`: only this phase changes the length assertion (`+ 1`); phase 5 keeps `remind` off the chat list and does not touch `src/chat/status.ts` or this assertion.

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/playLog/health.ts` | create | the pure Health answer builder, the reader seam, `streamHealthReader` |
| `src/directStream/playLog/repo.ts` | modify (phase 1's file) | append `healthRows`, `firstAskedAt`, `unhandled` and their row mappers |
| `src/http/streamHealthApi.ts` | create | `GET /api/stream/health?days=N` |
| `src/http/app.ts:38`, `:106`, `:167` | modify | import, `streamHealth` in `mcpToolDeps`, mount the routes |
| `src/mcp/streamHealthTool.ts` | create | `direct_stream_health` |
| `src/mcp/tools.ts:1`, `:55` | modify | `ToolDeps.streamHealth` |
| `src/mcp/server.ts:14`, `:46` | modify | register the tool |
| `src/chat/status.ts:90`, `:176`, `:315` | modify | name constant, `allowedChatTools`, caption |
| `src/mcp/instructions.ts:64` | modify | one sentence at the end of the Direct streaming paragraph |
| `src/chat/prompt.ts:40` | modify | the same sentence at the end of the direct-stream paragraph |
| `scripts/docs/httpRoutes.ts:350` | modify | a "Stream health" group |
| `docs/guide/reference/http-api.md`, `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `docs/guide/movies.md:776` | modify | `### Stream health` section before `## Playback` |
| `docs/guide/streaming.md:2086` | modify | `### Stream health` paragraph before "Reporting a stream bug" |
| `web/src/moviesApi.ts:1183` | modify | `StreamHealth` types and `fetchStreamHealth` |
| `web/src/lib/route.ts:25`, `:126-141`, `:159`, `:166` | modify | `/movies/health` |
| `web/src/lib/movies.ts:859-866`, `:877`, `:946` | modify | heading, count line, chat context |
| `web/src/pages/MoviesPage.tsx:2`, `:3`, `:39`, `:98`, `:284-299`, `:312-313`, `:353`, `:383`, `:407`, `:410` | modify | the heartbeat button, the page, Back |
| `web/src/components/movies/HealthPage.tsx` | create | the page |
| `web/src/components/movies/HealthPage.css` | create | the Cache page's look |
| `web/src/components/movies/HealthPage.test.tsx` | create | jsdom test |
| `web/src/lib/route.test.tsx:129` | modify | route test |
| `tests/helpers/playLogRows.ts` | create | the shared seed rows |
| `tests/unit/directStream/playLogHealth.test.ts` | create | `buildHealth` |
| `tests/unit/mcp.streamHealthTool.test.ts` | create | route and tool, same figures, off answer, bad `days` |
| `tests/unit/chat-status.test.ts:20-32` | modify | one more allowed tool |
| `tests/integration/streamPlayLog.health.int.test.ts` | create | the SQL against Postgres |
| `.claude/skills/verify-notesd/features/movies.md:33` | modify | "Stream health page" entry |
| `.claude/skills/verify-notesd/features/README.md:19` | modify | name the Stream health page in the Movies row |

Note on scope: the brief names `MoviesGrid.tsx` and `App.tsx`. The Cache drive icon is built in
`web/src/pages/MoviesPage.tsx:285` and handed to `MoviesGrid` through its existing `afterKinds` prop
(`MoviesPage.tsx:383`), so the new icon goes there and `MoviesGrid.tsx` is unchanged. `App.tsx` parses
movies URLs only through `moviesRouteFromLocation`/`hrefForView` (`App.tsx:98`, `:491`), so `/movies/health`
needs no change there either.

## Implementation Steps

### Step 1: The Health answer, pure
**File:** `src/directStream/playLog/health.ts` (new)
**Change:** One pure builder from rows to the answer, plus the reader seam the route and the tool share
(R2.2: one function, so the figures cannot drift apart).
**Code:**
```ts
import type { AppDeps } from '../../deps.js';
import { PlayLogRepo } from './repo.js';

/**
 * The stream health view (stream-play-log phase 3): GET /api/stream/health, the direct_stream_health tool and the
 * /movies/health page all answer from `readHealth`. Reads only; PlayLogRepo's writes are phase 1's.
 *
 * A play that reached the screen is a successful streaming attempt whatever its length (the owner tests torrents with
 * short plays): `played` counts outcome `played` and `site` (a streaming site's player ran), and nothing here counts a
 * short play as a failure. Watched minutes are no headline: only the per-hour stall rate uses them.
 */

export const HEALTH_DEFAULT_DAYS = 7;
export const HEALTH_MAX_DAYS = 90;
/** How many of the period's plays `recent` lists, newest first. */
export const HEALTH_RECENT_LIMIT = 30;
/** How many films and episodes `unhandled` lists at most (over all time). */
export const HEALTH_UNHANDLED_LIMIT = 200;

export type PlayOutcome = 'failed' | 'no_picture' | 'played' | 'site';

/** One stream_play_log row as the health view reads it, with its title's name and movie id. */
export interface HealthRow {
  id: number;
  asked_at: Date;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asked: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  cloud_failure: string | null;
  torrent_failure: string | null;
  resolve_ms: number | null;
  channel: string | null;
  provider_first: string | null;
  torrent_index: string | null;
  height: number | null;
  first_frame_ms: number | null;
  played_ms: number;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
  /** movie_titles.title, else the title key (`movie-603`) for a title the library does not store. */
  title: string;
  movie_id: string | null;
}

/** A film or episode whose last ask failed and that has not played since (all time). */
export interface UnhandledEntry {
  title: string;
  movie_id: string | null;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  /** Failed asks since its last successful play (all of them when it never played). */
  asks: number;
  last_asked_at: string;
  /** The word of its latest failed ask that asked the cloud providers; null: never asked there. */
  cloud_failure: string | null;
  /** The word of its latest failed ask that asked the torrents; null: never asked there. */
  torrent_failure: string | null;
}

export interface Figures {
  asks: number;
  failed: number;
  no_picture: number;
  /** Plays that reached the screen, however short (outcome played or site). */
  played: number;
  /** played / asks; null with no ask. */
  success_rate: number | null;
  /** Ask to answer, over the asks that got a player (no_picture, played, site). */
  median_resolve_ms: number | null;
  /** Page load to first frame, over the plays that reported one. */
  median_first_frame_ms: number | null;
  played_hours: number;
  /** Stalls per hour played; null when nothing played. */
  stalls_per_hour: number | null;
  /** Time stood still per time played (stalled_ms / played_ms); null when nothing played. */
  stalled_share: number | null;
  /** Share of the plays whose height is known that played at 1080p or better; null when none is known. */
  hd_share: number | null;
}

export interface SourceFigures extends Figures {
  channel: string;
  /** A cloud play's first provider, a torrent play's index (`disk` without one), else the channel. */
  source: string;
}

export interface FailureCount {
  channel: string;
  failure: string;
  count: number;
}

export interface RecentPlay {
  id: number;
  asked_at: string;
  title: string;
  movie_id: string | null;
  season: number | null;
  episode: number | null;
  channel: string | null;
  source: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  height: number | null;
  resolve_ms: number | null;
  first_frame_ms: number | null;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
}

export interface HealthAnswer {
  host: string;
  days: number;
  since: string;
  first_logged_at: string | null;
  totals: Record<string, Figures>;
  by_source: SourceFigures[];
  failures: FailureCount[];
  recent: RecentPlay[];
  unhandled: UnhandledEntry[];
}

/** What readHealth needs of PlayLogRepo; tests pass an in-memory one. */
export interface PlayLogReader {
  healthRows(host: string, since: Date): Promise<HealthRow[]>;
  firstAskedAt(host: string): Promise<Date | null>;
  unhandled(host: string, limit: number): Promise<UnhandledEntry[]>;
}

/** What the route and the tool call: the answer for the last `days` days on this host. */
export interface StreamHealthReader {
  read(days: number): Promise<HealthAnswer>;
}

/** The channels always in `totals`, zeros included, so an empty period still answers per channel (R2.4). */
const ALWAYS = ['all', 'cloud', 'torrent'] as const;
const CHANNEL_ORDER = ['torrent', 'cloud', 'cache', 'site', 'none'];

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

const isPlayed = (r: HealthRow): boolean => r.outcome === 'played' || r.outcome === 'site';

/**
 * The channels a row counts under. A row with a channel counts there. A failed ask with no channel counts under every
 * channel it asked (its cloud_failure / torrent_failure), else under the one `asked` names, else `none`.
 */
export function channelsOf(r: HealthRow): string[] {
  if (r.channel !== null) return [r.channel];
  if (r.outcome !== 'failed') return ['none'];
  const asked: string[] = [];
  if (r.cloud_failure !== null) asked.push('cloud');
  if (r.torrent_failure !== null) asked.push('torrent');
  if (asked.length > 0) return asked;
  if (r.asked === 'torrent') return ['torrent'];
  if (r.asked === 'cloud' || r.asked === 'provider') return ['cloud'];
  return ['none'];
}

/** The provider or index a row played through, or null for a failed ask that never reached a channel. */
export function sourceOf(r: HealthRow): string | null {
  if (r.channel === null) return null;
  if (r.channel === 'torrent') return r.torrent_index ?? 'disk';
  return r.provider_first ?? r.channel;
}

/** The middle value (the mean of the two middle ones, rounded), or null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function figures(rows: readonly HealthRow[]): Figures {
  const asks = rows.length;
  const played = rows.filter(isPlayed);
  const playedMs = rows.reduce((n, r) => n + r.played_ms, 0);
  const stalls = rows.reduce((n, r) => n + r.stalls, 0);
  const stalledMs = rows.reduce((n, r) => n + r.stalled_ms, 0);
  const hours = playedMs / 3_600_000;
  const sized = played.filter((r) => r.height !== null);
  return {
    asks,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    no_picture: rows.filter((r) => r.outcome === 'no_picture').length,
    played: played.length,
    success_rate: asks === 0 ? null : round(played.length / asks, 3),
    median_resolve_ms: median(rows.filter((r) => r.outcome !== 'failed' && r.resolve_ms !== null).map((r) => r.resolve_ms!)),
    median_first_frame_ms: median(played.filter((r) => r.first_frame_ms !== null).map((r) => r.first_frame_ms!)),
    played_hours: round(hours, 2),
    stalls_per_hour: playedMs === 0 ? null : round(stalls / hours, 2),
    stalled_share: playedMs === 0 ? null : round(stalledMs / playedMs, 4),
    hd_share: sized.length === 0 ? null : round(sized.filter((r) => r.height! >= 1080).length / sized.length, 3),
  };
}

const channelRank = (c: string): number => {
  const i = CHANNEL_ORDER.indexOf(c);
  return i === -1 ? CHANNEL_ORDER.length : i;
};

/** The word a failed row ended with on one channel. */
function failureWord(r: HealthRow, channel: string): string {
  if (channel === 'cloud') return r.cloud_failure ?? r.failure ?? 'unknown';
  if (channel === 'torrent') return r.torrent_failure ?? r.failure ?? 'unknown';
  return r.failure ?? 'unknown';
}

/** The Health answer from the period's rows (newest first), the first row's time and the unhandled list. */
export function buildHealth(input: {
  host: string;
  days: number;
  since: Date;
  rows: readonly HealthRow[];
  firstLoggedAt: Date | null;
  unhandled: readonly UnhandledEntry[];
}): HealthAnswer {
  const byChannel = new Map<string, HealthRow[]>();
  const bySource = new Map<string, { channel: string; source: string; rows: HealthRow[] }>();
  const failures = new Map<string, FailureCount>();
  for (const r of input.rows) {
    for (const c of channelsOf(r)) {
      const list = byChannel.get(c) ?? [];
      list.push(r);
      byChannel.set(c, list);
      if (r.outcome === 'failed') {
        const word = failureWord(r, c);
        const key = `${c}\u0000${word}`;
        const f = failures.get(key) ?? { channel: c, failure: word, count: 0 };
        f.count += 1;
        failures.set(key, f);
      }
    }
    const source = sourceOf(r);
    if (source !== null && r.channel !== null) {
      const key = `${r.channel}\u0000${source}`;
      const s = bySource.get(key) ?? { channel: r.channel, source, rows: [] };
      s.rows.push(r);
      bySource.set(key, s);
    }
  }
  const totals: Record<string, Figures> = {};
  totals.all = figures(input.rows);
  for (const c of ALWAYS) if (c !== 'all') totals[c] = figures(byChannel.get(c) ?? []);
  for (const c of [...byChannel.keys()].sort((a, b) => channelRank(a) - channelRank(b))) if (totals[c] === undefined) totals[c] = figures(byChannel.get(c)!);
  return {
    host: input.host,
    days: input.days,
    since: input.since.toISOString(),
    first_logged_at: input.firstLoggedAt === null ? null : input.firstLoggedAt.toISOString(),
    totals,
    by_source: [...bySource.values()]
      .map((s) => ({ channel: s.channel, source: s.source, ...figures(s.rows) }))
      .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || b.asks - a.asks || a.source.localeCompare(b.source)),
    failures: [...failures.values()].sort((a, b) => b.count - a.count || channelRank(a.channel) - channelRank(b.channel) || a.failure.localeCompare(b.failure)),
    recent: input.rows.slice(0, HEALTH_RECENT_LIMIT).map((r) => ({
      id: r.id,
      asked_at: r.asked_at.toISOString(),
      title: r.title,
      movie_id: r.movie_id,
      season: r.season,
      episode: r.episode,
      channel: r.channel,
      source: sourceOf(r),
      outcome: r.outcome,
      failure: r.failure,
      height: r.height,
      resolve_ms: r.resolve_ms,
      first_frame_ms: r.first_frame_ms,
      stalls: r.stalls,
      stalled_ms: r.stalled_ms,
      waits: r.waits,
      waited_ms: r.waited_ms,
      ended: r.ended,
    })),
    unhandled: [...input.unhandled],
  };
}

/** The answer for the `days` days before `now` on `host`. `days` is already 1..HEALTH_MAX_DAYS (the route and the tool check it). */
export async function readHealth(reader: PlayLogReader, host: string, days: number, now: Date): Promise<HealthAnswer> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [rows, firstLoggedAt, unhandled] = await Promise.all([reader.healthRows(host, since), reader.firstAskedAt(host), reader.unhandled(host, HEALTH_UNHANDLED_LIMIT)]);
  return buildHealth({ host, days, since, rows, firstLoggedAt, unhandled });
}

/**
 * The reader the route and the tool share, or null with the movie library off (no host to read for). Builds a
 * PlayLogRepo over the daemon's Db per daemon, as /api/movies/trending builds its TrendingRepo: it holds no state.
 */
export function streamHealthReader(deps: Pick<AppDeps, 'db' | 'movies'>, now: () => Date = () => new Date()): StreamHealthReader | null {
  const movies = deps.movies;
  if (movies === null || movies === undefined) return null;
  const repo = new PlayLogRepo(deps.db);
  return { read: (days) => readHealth(repo, movies.host, days, now()) };
}
```
**Impact:** new module; nothing calls it until Step 3.

### Step 2: The reads on PlayLogRepo
**File:** `src/directStream/playLog/repo.ts` (phase 1's file: append the three methods at the end of `class PlayLogRepo`, the helpers and types at the end of the file, the import with the other imports)
**Change:** Three reads in raw SQL by the contract's column names. `unhandled` holds the R2.5 rule: a film or
episode is listed while it has failed asks after its last `played`/`site` ask.
**Code:**
```ts
// phase 1's line `import { and, eq, isNotNull, isNull } from 'drizzle-orm';` becomes:
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
// and, with the other imports:
import type { HealthRow, PlayOutcome, UnhandledEntry } from './health.js';
```
```ts
  // ---- Reads for the health view (stream-play-log phase 3). Every write above is phase 1's. ----

  /** This host's rows asked at or after `since`, newest first, each with its title's name and movie id. */
  async healthRows(host: string, since: Date): Promise<HealthRow[]> {
    const res = await this.db.execute<HealthDbRow>(sql`
      select l.id, l.asked_at, l.kind, l.tmdb_id, l.season, l.episode, l.asked, l.outcome, l.failure,
             l.cloud_failure, l.torrent_failure, l.resolve_ms, l.channel, l.provider_first, l.torrent_index,
             l.height, l.first_frame_ms, l.played_ms, l.stalls, l.stalled_ms, l.waits, l.waited_ms, l.ended,
             t.title as title_name, mi.id as movie_id
        from stream_play_log l
        left join movie_titles t on t.id = l.kind || '-' || l.tmdb_id::text
        left join movie_ids mi on mi.title_id = t.id
                              and mi.season is not distinct from l.season
                              and mi.episode is not distinct from l.episode
       where l.host = ${host} and l.asked_at >= ${since.toISOString()}::timestamptz
       order by l.asked_at desc, l.id desc`);
    return res.rows.map(toHealthRow);
  }

  /** When this host's first row was asked; null before any. */
  async firstAskedAt(host: string): Promise<Date | null> {
    const res = await this.db.execute<{ at: Date | string | null }>(sql`select min(asked_at) as at from stream_play_log where host = ${host}`);
    const at = res.rows[0]?.at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * Every film and episode on this host, over all time, whose failed asks came after its last play that reached the
   * screen (outcome played or site), newest failure first. `cloud_failure` / `torrent_failure` are the words of its
   * latest failed ask that asked that channel.
   */
  async unhandled(host: string, limit: number): Promise<UnhandledEntry[]> {
    const res = await this.db.execute<UnhandledDbRow>(sql`
      with ok as (
        select kind, tmdb_id, season, episode, max(asked_at) as at
          from stream_play_log
         where host = ${host} and outcome in ('played', 'site')
         group by kind, tmdb_id, season, episode
      ), failed as (
        select l.kind, l.tmdb_id, l.season, l.episode,
               (count(*) filter (where ok.at is null or l.asked_at > ok.at))::int as asks,
               max(l.asked_at) as last_asked_at,
               (array_agg(l.cloud_failure order by l.asked_at desc, l.id desc) filter (where l.cloud_failure is not null))[1] as cloud_failure,
               (array_agg(l.torrent_failure order by l.asked_at desc, l.id desc) filter (where l.torrent_failure is not null))[1] as torrent_failure
          from stream_play_log l
          left join ok on ok.kind = l.kind and ok.tmdb_id = l.tmdb_id
                      and ok.season is not distinct from l.season
                      and ok.episode is not distinct from l.episode
         where l.host = ${host} and l.outcome = 'failed'
         group by l.kind, l.tmdb_id, l.season, l.episode
        having count(*) filter (where ok.at is null or l.asked_at > ok.at) > 0
      )
      select f.kind, f.tmdb_id, f.season, f.episode, f.asks, f.last_asked_at, f.cloud_failure, f.torrent_failure,
             t.title as title_name, mi.id as movie_id
        from failed f
        left join movie_titles t on t.id = f.kind || '-' || f.tmdb_id::text
        left join movie_ids mi on mi.title_id = t.id
                              and mi.season is not distinct from f.season
                              and mi.episode is not distinct from f.episode
       order by f.last_asked_at desc
       limit ${limit}`);
    return res.rows.map(toUnhandled);
  }
```
```ts
// at the end of the file

/** Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>. */
type HealthDbRow = {
  id: number | string;
  asked_at: Date | string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asked: string | null;
  outcome: PlayOutcome;
  failure: string | null;
  cloud_failure: string | null;
  torrent_failure: string | null;
  resolve_ms: number | null;
  channel: string | null;
  provider_first: string | null;
  torrent_index: string | null;
  height: number | null;
  first_frame_ms: number | null;
  played_ms: number;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
  title_name: string | null;
  movie_id: string | null;
};

type UnhandledDbRow = {
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asks: number;
  last_asked_at: Date | string;
  cloud_failure: string | null;
  torrent_failure: string | null;
  title_name: string | null;
  movie_id: string | null;
};

function iso(v: Date | string): string {
  return new Date(v).toISOString();
}

function toHealthRow(r: HealthDbRow): HealthRow {
  return {
    id: Number(r.id),
    asked_at: new Date(r.asked_at),
    kind: r.kind,
    tmdb_id: Number(r.tmdb_id),
    season: r.season,
    episode: r.episode,
    asked: r.asked,
    outcome: r.outcome,
    failure: r.failure,
    cloud_failure: r.cloud_failure,
    torrent_failure: r.torrent_failure,
    resolve_ms: r.resolve_ms,
    channel: r.channel,
    provider_first: r.provider_first,
    torrent_index: r.torrent_index,
    height: r.height,
    first_frame_ms: r.first_frame_ms,
    played_ms: Number(r.played_ms),
    stalls: Number(r.stalls),
    stalled_ms: Number(r.stalled_ms),
    waits: Number(r.waits),
    waited_ms: Number(r.waited_ms),
    ended: r.ended,
    title: r.title_name ?? `${r.kind}-${r.tmdb_id}`,
    movie_id: r.movie_id,
  };
}

function toUnhandled(r: UnhandledDbRow): UnhandledEntry {
  return {
    title: r.title_name ?? `${r.kind}-${r.tmdb_id}`,
    movie_id: r.movie_id,
    kind: r.kind,
    tmdb_id: Number(r.tmdb_id),
    season: r.season,
    episode: r.episode,
    asks: Number(r.asks),
    last_asked_at: iso(r.last_asked_at),
    cloud_failure: r.cloud_failure,
    torrent_failure: r.torrent_failure,
  };
}
```
**Impact:** read-only additions to phase 1's class. Phase 1's file declares no `iso`, `toHealthRow` or
`toUnhandled`, so the names stand.

### Step 3: The route
**File:** `src/http/streamHealthApi.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { HEALTH_DEFAULT_DAYS, HEALTH_MAX_DAYS, streamHealthReader, type StreamHealthReader } from '../directStream/playLog/health.js';

/** How stream plays went on this host (stream-play-log phase 3): the /movies/health page and direct_stream_health read the same answer. */

export const STREAM_HEALTH_OFF = { error: 'direct_stream_off', message: 'The movie library is off on this machine, so nothing is streamed or logged.' } as const;

const daysQuery = z.coerce.number().int().min(1).max(HEALTH_MAX_DAYS);

export interface StreamHealthRouteOptions {
  /** Tests: an in-memory reader. Omitted: the daemon's (streamHealthReader). */
  reader?: StreamHealthReader | null;
}

export function streamHealthRoutes(deps: Pick<AppDeps, 'db' | 'movies'>, options: StreamHealthRouteOptions = {}): Hono {
  const r = new Hono();
  const reader = options.reader !== undefined ? options.reader : streamHealthReader(deps);
  r.get('/api/stream/health', async (c) => {
    if (reader === null) return c.json(STREAM_HEALTH_OFF, 503);
    const raw = c.req.query('days');
    let days = HEALTH_DEFAULT_DAYS;
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = daysQuery.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_query', message: `days: a whole number from 1 to ${HEALTH_MAX_DAYS}` }, 400);
      days = parsed.data;
    }
    return c.json(await reader.read(days));
  });
  return r;
}
```
**File:** `src/http/app.ts`
- `:38` add after `import { streamDiskRoutes } from './streamDiskApi.js';`:
```ts
import { streamHealthRoutes } from './streamHealthApi.js';
import { streamHealthReader } from '../directStream/playLog/health.js';
```
- `:106` in `mcpToolDeps`, after `streamDisk: deps.cacheShelf ?? null,`:
```ts
    streamHealth: streamHealthReader(deps),
```
- `:167` after `app.route('/', streamDiskRoutes(deps));`:
```ts
  app.route('/', streamHealthRoutes(deps));
```
- In the doc comment above `createApp` (`:126`), after `streamDiskRoutes (the Cache page: what this machine keeps on disk for streaming),` add `streamHealthRoutes (stream-play-log phase 3: how stream plays went on this host),`.
**Impact:** new GET route; `npm test`'s docs check fails until Step 6.

### Step 4: The MCP tool
**File:** `src/chat/status.ts`
- `:90`, after `export const STREAM_DISK_TOOL_NAME = 'stream_disk';`:
```ts

/**
 * direct_stream_health (src/mcp/streamHealthTool.ts): how stream plays went on this machine, from the play log, per
 * channel and per torrent index or cloud provider, and the titles that could not be played; the /movies/health page's
 * twin ("how did torrents do this week?"). Read-only; in allowedChatTools().
 */
export const STREAM_HEALTH_TOOL_NAME = 'direct_stream_health';
```
- `allowedChatTools()` (`:176`), after the line `` `${MCP_PREFIX}${STREAM_DISK_TOOL_NAME}`, ``:
```ts
    `${MCP_PREFIX}${STREAM_HEALTH_TOOL_NAME}`,
```
- `captionForToolUse` (`:315`), before `case 'stream_disk': {`:
```ts
    case 'direct_stream_health':
      return 'reading how streams played';
```

**File:** `src/mcp/tools.ts`
- `:1` add `import type { StreamHealthReader } from '../directStream/playLog/health.js';`
- `:55`, after the `streamDisk?: StreamDiskApi | null;` field:
```ts
  /** The play log's health answer behind direct_stream_health (stream-play-log phase 3). Omitted or null: it answers direct_stream_off. */
  streamHealth?: StreamHealthReader | null;
```

**File:** `src/mcp/streamHealthTool.ts` (new)
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STREAM_HEALTH_TOOL_NAME } from '../chat/status.js';
import { HEALTH_DEFAULT_DAYS, HEALTH_MAX_DAYS, type HealthAnswer } from '../directStream/playLog/health.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { jsonResult, type ToolDeps } from './tools.js';

const DESCRIPTION =
  "How direct-stream plays went on this machine, from the play log: the wall's Stream health page (/movies/health) as data. " +
  'days (default 7, at most 90) is the period. totals has one entry per channel (all, cloud, torrent, and cache or site when they played) and by_source one per torrent index or cloud provider, each with asks, played (plays that reached the screen, however short: a short test play is a success, never a failure), success_rate (played / asks), failed, no_picture (a player opened and showed no frame), median_resolve_ms (ask to player), median_first_frame_ms, played_hours, stalls_per_hour, stalled_share (time stood still per time played) and hd_share (share of plays at 1080p or better). ' +
  'failures counts the failed asks per channel by outcome word (no_source, no_stream, bot_check, dubbed, ...). recent lists the latest plays: title, source, first frame, stalls and how each ended. ' +
  'unhandled lists, over all time, every film or episode whose asks failed and that has not played since, with what the cloud providers (cloud_failure) and the torrents (torrent_failure) last answered (null: not asked there). ' +
  'Call it for "how did torrents do this week?", "which torrent index starts fastest?", "what could not be played?". Reads only. Off on this server: direct_stream_off.';

const OFF = JSON.stringify({ error: 'direct_stream_off', message: 'The movie library is off on this machine, so nothing is streamed or logged.' });

/** What to say first: start success, first frame, stalls and 1080p, per channel; never minutes watched. */
function nextFor(a: HealthAnswer): string {
  if (a.totals.all!.asks === 0) {
    return a.unhandled.length === 0
      ? `Say nothing was played on this machine in the last ${a.days} days.`
      : `Say nothing was played in the last ${a.days} days, then list the titles in unhandled with what the cloud and the torrents answered.`;
  }
  return 'Lead with each channel\'s success_rate (played of asks; a short play counts as played), median first frame, stalls per hour and hd_share, then the torrent indexes or providers that differ most; then the failures by word and, when unhandled is not empty, the titles that could not be played. Do not lead with hours watched.';
}

/** direct_stream_health. Without deps.streamHealth it answers direct_stream_off. */
export function registerStreamHealthTool(server: McpServer, deps: Pick<ToolDeps, 'streamHealth' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    STREAM_HEALTH_TOOL_NAME,
    {
      title: 'How stream plays went on this machine',
      description: DESCRIPTION,
      inputSchema: {
        days: z.number().int().min(1).max(HEALTH_MAX_DAYS).optional().describe(`The period in days, 1 to ${HEALTH_MAX_DAYS}; default ${HEALTH_DEFAULT_DAYS}. unhandled is over all time whatever the period.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const reader = deps.streamHealth;
      if (!reader) return { isError: true, content: [{ type: 'text', text: OFF }] };
      const answer = await reader.read(args.days ?? HEALTH_DEFAULT_DAYS);
      return jsonResult({ ...answer, link: `${wall}/movies/health`, next: nextFor(answer) }, true);
    },
  );
}
```

**File:** `src/mcp/server.ts`
- `:14` add after the `registerStreamDiskTool` import: `import { registerStreamHealthTool } from './streamHealthTool.js';`
- `:46` after `registerStreamDiskTool(server, deps);`:
```ts
  // The play log's health (stream-play-log phase 3). Answers direct_stream_off when deps.streamHealth is unset.
  registerStreamHealthTool(server, deps);
```

**File:** `tests/unit/chat-status.test.ts`
- `:20` test name: `... the warp switch, stream_disk, direct_stream_health, the direct-streaming tools, ...`
- `:29` becomes:
```ts
    expect(tools).toHaveLength(19 + 5 + 3 + 8 + 2 + 1 + 1 + 1 + (DIRECT_STREAM_TOOL_NAMES.length - CLAUDE_CODE_ONLY_TOOL_NAMES.length) + 22 + 2);
```
- after `:32` (`expect(tools).toContain('mcp__notes__stream_disk');`):
```ts
    expect(tools).toContain('mcp__notes__direct_stream_health');
```
**Impact:** the chat bar gains one read-only tool (R2.2).

### Step 5: Tell the clients
**File:** `src/mcp/instructions.ts:64` — at the end of the Direct streaming paragraph, replace
`The wall's Cache page (/movies/cache) shows the same.\`,` with:
```ts
The wall's Cache page (/movies/cache) shows the same. direct_stream_health says how stream plays went on this machine (days, default 7): per channel and per torrent index or cloud provider, how many asks reached the screen (a short play counts as a success), the median first frame, stalls per hour and the share at 1080p, the failures by word, and every film or episode that could not be played with what the cloud and the torrents answered; call it for "how did torrents do this week?". The wall's Stream health page (/movies/health) shows the same.`,
```
**File:** `src/chat/prompt.ts:40` — the identical replacement at the end of that paragraph, whose text also ends
with `The wall's Cache page (/movies/cache) shows the same.\`,` (each file holds that sentence once).
**Impact:** no paragraph is added, so `tests/unit/mcp.instructions.test.ts`'s paragraph counts hold.

### Step 6: Route reference and guides
**File:** `scripts/docs/httpRoutes.ts:350` — after the `Cache page` group's closing `},` add:
```ts
  {
    title: 'Stream health',
    intro:
      'How direct-stream plays went on this machine, read from the play log: the Stream health page at `/movies/health` and the `direct_stream_health` tool answer the same. Reads only. 503 `direct_stream_off` with the movie library off. Guide: [movies.md](../movies.md#stream-health).',
    routes: {
      'GET /api/stream/health':
        'Query `days` (1 to 90, default 7; 400 `invalid_query` otherwise). `{host, days, since, first_logged_at, totals, by_source, failures, recent, unhandled}` for this host. `totals` has `all`, `cloud` and `torrent` always (zeros with nothing logged), and `cache`, `site` or `none` when a row has them; `by_source` one entry per channel and torrent index (`disk` for a torrent without one) or cloud provider. Each is `{asks, failed, no_picture, played, success_rate, median_resolve_ms, median_first_frame_ms, played_hours, stalls_per_hour, stalled_share, hd_share}`: `played` counts every play that reached the screen however short (and a streaming site\'s play), `success_rate` is played / asks, the medians and rates are null with nothing to measure, `hd_share` is the share of plays of known height at 1080p or better. A failed ask that reached no channel counts under each channel it asked and in no source. `failures` is `[{channel, failure, count}]`, most first. `recent` is the latest 30 asks `{id, asked_at, title, movie_id, season, episode, channel, source, outcome, failure, height, resolve_ms, first_frame_ms, stalls, stalled_ms, waits, waited_ms, ended}`. `unhandled`, over all time and newest first (at most 200), is every film or episode whose asks failed and that has not played since: `{title, movie_id, kind, tmdb_id, season, episode, asks, last_asked_at, cloud_failure, torrent_failure}`.',
    },
  },
```
Then run `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md` and `mcp-tools.md`).

**File:** `docs/guide/movies.md:776` — insert before `## Playback` (after the Cache page section's last line
"...[http-api.md](reference/http-api.md#cache-page)."), with a blank line on each side:
```markdown
### Stream health

The heartbeat icon beside the Cache drive icon on the Stream side opens `/movies/health`: how direct-stream
plays went on this machine, read from the [play log](streaming.md#the-play-log) the daemon keeps of every
play ask. Only this machine's rows are read. The three buttons at the top choose the period: 7, 30 or 90 days.

- **By channel.** One row for every ask, then Torrents, Cloud, and From disk or Streaming sites when they
  played. Each says how many asks reached the screen (`3/5` and `60%`), the median time to the first frame
  and from the ask to a player, stalls per hour played and the share of plays at 1080p or better. A play
  that reached the screen is a success however short it was: a one-minute test of a torrent counts as a
  play, never as a failure. Under each channel, its torrent indexes or cloud providers with the same
  figures, and the failed asks by what they ended with (`no torrent found ×2`).
- **Could not be played.** Every film or episode whose asks failed and that has not played since, over
  all time and not only the period: what the cloud providers and the torrents each last answered (`no
  cloud source`, `no torrent found`, `bot check`, `dub only`, `not asked`), how many asks failed and
  when the last one was. It leaves the list once it plays.
- **Latest plays.** The newest 30 asks of the period: the title (with its episode), the provider or
  index, the height, the first frame, the stalls with how long the film stood still, and how it ended
  (finished, closed, replaced by another play, session expired, daemon restarted, failed and why).
- With nothing logged in the period the page says `Nothing was played in the last 7 days.`

The page reads `GET /api/stream/health` every 30 seconds while it is visible. From chat or Claude Code the
`direct_stream_health` tool answers the same ("how did torrents do this week?"). The route is in
[http-api.md](reference/http-api.md#stream-health).
```

**File:** `docs/guide/streaming.md:2086` — insert before `### Reporting a stream bug: \`/report-stream-bug\``:
```markdown
### Stream health

What the play log holds is read back per channel and per torrent index or cloud provider: start success
(asks that reached the screen, a short play included), time to answer, time to the first frame, stalls
per hour and the share at 1080p, the failures by word, the latest plays, and every film or episode that
could not be played with what the cloud and the torrents answered. The wall's Stream health page
(`/movies/health`, see [movies.md](movies.md#stream-health)), the `direct_stream_health` tool and
`GET /api/stream/health?days=N` answer the same. They only read: nothing here changes which provider or
torrent a play chooses.
```
**Impact:** `npm run docs:check` passes again; no picture is added (the index keeps `health.png` for the live retake).

### Step 7: The web client: API, route, heading
**File:** `web/src/moviesApi.ts` — append at the end of the file (after `cancelDownload`, `:1183`):
```ts

/** One channel's or one source's figures on the Stream health page (GET /api/stream/health). */
export interface HealthFigures {
  asks: number;
  failed: number;
  no_picture: number;
  played: number;
  success_rate: number | null;
  median_resolve_ms: number | null;
  median_first_frame_ms: number | null;
  played_hours: number;
  stalls_per_hour: number | null;
  stalled_share: number | null;
  hd_share: number | null;
}

export interface HealthSource extends HealthFigures {
  channel: string;
  source: string;
}

export interface HealthFailure {
  channel: string;
  failure: string;
  count: number;
}

export type HealthOutcome = 'failed' | 'no_picture' | 'played' | 'site';

export interface HealthPlay {
  id: number;
  asked_at: string;
  title: string;
  movie_id: string | null;
  season: number | null;
  episode: number | null;
  channel: string | null;
  source: string | null;
  outcome: HealthOutcome;
  failure: string | null;
  height: number | null;
  resolve_ms: number | null;
  first_frame_ms: number | null;
  stalls: number;
  stalled_ms: number;
  waits: number;
  waited_ms: number;
  ended: string | null;
}

export interface HealthUnhandled {
  title: string;
  movie_id: string | null;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  asks: number;
  last_asked_at: string;
  cloud_failure: string | null;
  torrent_failure: string | null;
}

export interface StreamHealth {
  host: string;
  days: number;
  since: string;
  first_logged_at: string | null;
  totals: Record<string, HealthFigures>;
  by_source: HealthSource[];
  failures: HealthFailure[];
  recent: HealthPlay[];
  unhandled: HealthUnhandled[];
}

/** How stream plays went on this machine in the last `days` days. Throws ApiError `direct_stream_off`. */
export async function fetchStreamHealth(days: number, signal?: AbortSignal): Promise<StreamHealth> {
  const v = await getJson<Partial<StreamHealth>>(`/api/stream/health?days=${days}`, signal);
  return {
    host: v.host ?? '',
    days: v.days ?? days,
    since: v.since ?? '',
    first_logged_at: v.first_logged_at ?? null,
    totals: v.totals ?? {},
    by_source: list(v.by_source),
    failures: list(v.failures),
    recent: list(v.recent),
    unhandled: list(v.unhandled),
  };
}
```

**File:** `web/src/lib/route.ts`
- `:25` after `export const MOVIES_CACHE_SEGMENT = 'cache';`:
```ts
/** `/movies/health`: the Stream health page of the Stream side. Never a title id, for the same reason. */
export const MOVIES_HEALTH_SEGMENT = 'health';
```
- `MoviesRoute` (`:133-139`): after the `cache?: boolean;` field add
```ts
  /** `/movies/health`: how stream plays went on this machine (a Stream-side page; `title` null). */
  health?: boolean;
```
- after `export const CACHE_ROUTE ...` (`:141`):
```ts
/** The Stream health page, `/movies/health`. */
export const HEALTH_ROUTE: MoviesRoute = { title: null, unmatched: false, stream: true, health: true };
```
- `moviesRouteFromLocation` (`:159`), after `if (seg === MOVIES_CACHE_SEGMENT) return CACHE_ROUTE;`:
```ts
  if (seg === MOVIES_HEALTH_SEGMENT) return HEALTH_ROUTE;
```
- `moviesHref` (`:166`), after the `cache` line:
```ts
  if (r.health === true) return `${MOVIES_PATH}/${MOVIES_HEALTH_SEGMENT}`;
```

**File:** `web/src/lib/route.test.tsx`
- `:2` add `HEALTH_ROUTE` to the import list from `./route`.
- after the Cache test (ends `:129`):
```ts
  it('reads and writes the Stream health page, /movies/health, on the Stream side', () => {
    expect(moviesRouteFromLocation(loc('/movies/health'))).toEqual(HEALTH_ROUTE);
    expect(moviesHref(HEALTH_ROUTE)).toBe('/movies/health');
    expect(hrefForView('movies', null, loc('/movies?side=stream'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, HEALTH_ROUTE)).toBe('/movies/health');
    expect(hrefForView('movies', null, loc('/movies/health'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, HEALTH_ROUTE)).toBeNull();
  });
```

**File:** `web/src/lib/movies.ts`
- `:859-866`: after `export const CACHE_HEADING = 'Cache.';` add
```ts
/** The Stream health page's heading. */
export const HEALTH_HEADING = 'Stream health.';
```
and in `moviesHeading`, after `if (route.cache === true) return CACHE_HEADING;`:
```ts
  if (route.health === true) return HEALTH_HEADING;
```
- `:877` in `moviesCountLine`, after the cache line:
```ts
  if (route.health === true) return 'How stream plays went on this machine: start success, first frame, stalls and 1080p, per torrent index and cloud provider.';
```
- `:946` in `moviesChatMessage`, after `else if (route.cache === true) where = 'stream cache on disk';`:
```ts
  else if (route.health === true) where = 'stream health';
```

### Step 8: The page
**File:** `web/src/components/movies/HealthPage.tsx` (new)
```tsx
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowSquareOut, CalendarBlank, Cloud, Globe, HardDrives, Heartbeat, MagnetStraight, Warning } from '@phosphor-icons/react';
import { relativeDate } from '../../lib/dates';
import { errorCode, fetchStreamHealth, type HealthFailure, type HealthFigures, type HealthPlay, type HealthSource, type HealthUnhandled, type StreamHealth } from '../../moviesApi';
import './CachePage.css';
import './HealthPage.css';

/** The periods the page offers, in days. */
export const HEALTH_DAYS = [7, 30, 90] as const;
/** How often the page reads the log again while it is visible. */
export const HEALTH_REFRESH_MS = 30_000;

const CHANNEL_ORDER = ['all', 'torrent', 'cloud', 'cache', 'site', 'none'];
const CHANNEL_NAME: Record<string, string> = { all: 'Every ask', torrent: 'Torrents', cloud: 'Cloud', cache: 'From disk', site: 'Streaming sites', none: 'No source named' };

function channelIcon(channel: string | null): ReactNode {
  switch (channel) {
    case 'all':
      return <Heartbeat weight="duotone" />;
    case 'torrent':
      return <MagnetStraight weight="duotone" />;
    case 'cloud':
      return <Cloud weight="duotone" />;
    case 'cache':
      return <HardDrives weight="duotone" />;
    case 'site':
      return <Globe weight="duotone" />;
    default:
      return <Warning weight="duotone" />;
  }
}

/**
 * An outcome word in the owner's words: what was missing. Every word phase 1 writes is named (its `failure`:
 * DirectStreamErrorCode, CachePlayErrorCode, `error`; its `cloud_failure`/`torrent_failure`: ResolveOutcome and
 * `no_source`, `resolve_failed`, `torrent_off`); an unknown word falls back to itself with spaces.
 */
export function failureText(word: string, channel: string | null): string {
  switch (word) {
    case 'no_source':
    case 'no_stream':
      return channel === 'torrent' ? 'no torrent found' : channel === 'cloud' ? 'no cloud source' : 'no source';
    case 'resolved':
      return 'found, did not play';
    case 'bot_check':
      return 'bot check';
    case 'dubbed':
      return 'dub only';
    case 'unplayable':
      return 'file Chrome cannot play';
    case 'error':
      return 'error';
    case 'skipped':
    case 'skipped_browser_only':
    case 'skipped_no_template':
      return 'not tried';
    case 'torrent_off':
      return 'torrents off';
    case 'resolve_failed':
      return 'resolver failed';
    case 'open_failed':
      return 'player did not open';
    case 'bad_info_hash':
      return 'bad magnet';
    case 'no_episode':
      return 'no such episode';
    case 'no_subtitle':
      return 'no subtitle';
    case 'unknown_session':
      return 'session gone';
    case 'not_on_this_machine':
      return 'cache on the other machine';
    case 'cache_failed':
      return 'cache broken';
    case 'cache_language':
      return 'cache is a dub';
    default:
      return word.replace(/_/g, ' ');
  }
}

/** "2.4 s", "38 s", or a dash for nothing measured. */
export function seconds(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function percent(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Severance S02E03", or the film's name. */
export function playLabel(p: { title: string; season: number | null; episode: number | null }): string {
  return p.season !== null && p.episode !== null ? `${p.title} S${pad(p.season)}E${pad(p.episode)}` : p.title;
}

/** How a play ended, in words. A short play that reached the screen is never called a failure. */
export function endedText(p: HealthPlay): string {
  if (p.outcome === 'failed') return p.failure === null ? 'failed' : `failed · ${failureText(p.failure, p.channel)}`;
  if (p.outcome === 'no_picture') return 'no picture';
  if (p.outcome === 'site') return 'played on a site';
  switch (p.ended) {
    case null:
      return 'playing';
    case 'finished':
      return 'finished';
    case 'closed':
      return 'closed';
    case 'replaced':
      return 'replaced by another play';
    case 'expired':
      return 'session expired';
    case 'restart':
      return 'daemon restarted';
    default:
      return p.ended;
  }
}

function stallsText(p: HealthPlay): string {
  if (p.outcome === 'failed') return '—';
  const n = `${p.stalls} ${p.stalls === 1 ? 'stall' : 'stalls'}`;
  return p.stalled_ms > 0 ? `${n} · ${seconds(p.stalled_ms)}` : n;
}

function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <span className="hp-stat" data-tip={tip}>
      <span className="hp-stat-v">{value}</span>
      <span className="hp-stat-l">{label}</span>
    </span>
  );
}

function FigureRow({ icon, name, f, sub = false }: { icon: ReactNode; name: string; f: HealthFigures; sub?: boolean }) {
  return (
    <div className={sub ? 'hp-row hp-sub' : 'hp-row'} data-testid={sub ? undefined : `hp-channel-${name}`}>
      <span className="hp-icon">{icon}</span>
      <span className="hp-name">{name}</span>
      <Stat label="started" value={`${f.played}/${f.asks}`} tip="Asks that reached the screen, of every ask. A short play counts: it started." />
      <Stat label="success" value={percent(f.success_rate)} tip="Share of the asks that reached the screen" />
      <Stat label="first frame" value={seconds(f.median_first_frame_ms)} tip="Median time from the player page's load to the first frame" />
      <Stat label="to answer" value={seconds(f.median_resolve_ms)} tip="Median time from the ask to a player" />
      <Stat label="stalls / h" value={f.stalls_per_hour === null ? '—' : f.stalls_per_hour.toFixed(1)} tip="Stalls per hour played" />
      <Stat label="1080p" value={percent(f.hd_share)} tip="Share of the plays at 1080p or better" />
    </div>
  );
}

function FailureChips({ failures }: { failures: HealthFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <div className="hp-fails">
      {failures.map((f) => (
        <span key={`${f.channel}:${f.failure}`} className="mv-chip hp-tag" data-tip={`${f.count} failed ${f.count === 1 ? 'ask' : 'asks'}: ${f.failure}`}>
          {failureText(f.failure, f.channel)} ×{f.count}
        </span>
      ))}
    </div>
  );
}

function OpenButton({ id, label, onOpen }: { id: string | null; label: string; onOpen: (id: string) => void }) {
  if (id === null) return <span className="cp-btn-gap" />;
  return (
    <button type="button" className="ibtn hov" data-tip="Go to the title page" aria-label={`Open ${label}`} onClick={() => onOpen(id)}>
      <ArrowSquareOut weight="duotone" />
    </button>
  );
}

function UnhandledRow({ u, now, onOpen }: { u: HealthUnhandled; now: Date; onOpen: (id: string) => void }) {
  const label = playLabel(u);
  return (
    <li className="hp-item" data-unhandled={label}>
      <div className="hp-row">
        <span className="hp-icon">
          <Warning weight="duotone" />
        </span>
        <span className="hp-name">{label}</span>
        <span className="mv-chip hp-tag hp-why" data-tip="What the cloud providers last answered">
          <Cloud weight="duotone" /> {u.cloud_failure === null ? 'not asked' : failureText(u.cloud_failure, 'cloud')}
        </span>
        <span className="mv-chip hp-tag hp-why" data-tip="What the torrents last answered">
          <MagnetStraight weight="duotone" /> {u.torrent_failure === null ? 'not asked' : failureText(u.torrent_failure, 'torrent')}
        </span>
        <span className="hp-when">
          {u.asks} {u.asks === 1 ? 'ask' : 'asks'} · {relativeDate(u.last_asked_at, now, true)}
        </span>
        <OpenButton id={u.movie_id} label={label} onOpen={onOpen} />
      </div>
    </li>
  );
}

function PlayRow({ p, now, onOpen }: { p: HealthPlay; now: Date; onOpen: (id: string) => void }) {
  const label = playLabel(p);
  return (
    <li className="hp-item" data-outcome={p.outcome}>
      <div className="hp-row">
        <span className="hp-icon">{channelIcon(p.channel)}</span>
        <span className="hp-name">{label}</span>
        <span className="mv-chip hp-tag">{p.source ?? (p.channel === null ? 'no source' : (CHANNEL_NAME[p.channel] ?? p.channel))}</span>
        <span className="hp-num" data-tip="Height that played">{p.height === null ? '—' : `${p.height}p`}</span>
        <span className="hp-num" data-tip="First frame">{seconds(p.first_frame_ms)}</span>
        <span className="hp-num hp-wide" data-tip="Stalls, and how long the film stood still">{stallsText(p)}</span>
        <span className="hp-ended">{endedText(p)}</span>
        <span className="hp-when">{relativeDate(p.asked_at, now, true)}</span>
        <OpenButton id={p.movie_id} label={label} onOpen={onOpen} />
      </div>
    </li>
  );
}

export interface HealthPageProps {
  /** Open a title's page on the Stream side. */
  onOpen: (id: string) => void;
}

/**
 * The Stream health page (`/movies/health`): how direct-stream plays went on this machine, from the play log.
 * Start success, first frame, stalls and the share at 1080p lead, per channel and per torrent index or cloud provider;
 * a short play is a play. Then the films and episodes that could not be played (all time) and the latest plays.
 */
export function HealthPage({ onOpen }: HealthPageProps) {
  const [days, setDays] = useState<number>(HEALTH_DAYS[0]);
  const [health, setHealth] = useState<StreamHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHealth(await fetchStreamHealth(days));
      setError(null);
    } catch (e) {
      setError(errorCode(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, HEALTH_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const now = new Date();
  let body: ReactNode;
  if (error !== null) body = <p className="mv-empty">{error === 'direct_stream_off' ? 'The movie library is off on this machine, so nothing is streamed or logged.' : `Could not read the play log (${error}).`}</p>;
  else if (health === null || health.days !== days) body = <p className="mv-empty">reading the play log</p>;
  else {
    const nothing = (health.totals.all?.asks ?? 0) === 0;
    const channels = CHANNEL_ORDER.filter((c) => health.totals[c] !== undefined && (c === 'all' || c === 'torrent' || c === 'cloud' || health.totals[c]!.asks > 0));
    const sourcesOf = (c: string): HealthSource[] => health.by_source.filter((s) => s.channel === c);
    body = (
      <>
        {nothing ? (
          <p className="mv-empty" data-testid="hp-nothing">
            Nothing was played in the last {days} days.
          </p>
        ) : (
          <>
            <h3 className="hp-label">By channel</h3>
            <ul className="hp-list" aria-label="Channels">
              {channels.map((c) => (
                <li key={c} className="hp-item" data-channel={c}>
                  <FigureRow icon={channelIcon(c)} name={CHANNEL_NAME[c] ?? c} f={health.totals[c]!} />
                  {c !== 'all' && sourcesOf(c).length > 0 && (
                    <ul className="hp-sources" aria-label={`${CHANNEL_NAME[c] ?? c} sources`}>
                      {sourcesOf(c).map((s) => (
                        <li key={s.source} data-source={s.source}>
                          <FigureRow icon={<span className="hp-dot" />} name={s.source} f={s} sub />
                        </li>
                      ))}
                    </ul>
                  )}
                  {c !== 'all' && <FailureChips failures={health.failures.filter((f) => f.channel === c)} />}
                </li>
              ))}
            </ul>
          </>
        )}
        {health.unhandled.length > 0 && (
          <>
            <h3 className="hp-label">Could not be played</h3>
            <ul className="hp-list" aria-label="Could not be played">
              {health.unhandled.map((u) => (
                <UnhandledRow key={`${u.kind}-${u.tmdb_id}-${u.season ?? ''}-${u.episode ?? ''}`} u={u} now={now} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}
        {!nothing && (
          <>
            <h3 className="hp-label">Latest plays</h3>
            <ul className="hp-list" aria-label="Latest plays">
              {health.recent.map((p) => (
                <PlayRow key={p.id} p={p} now={now} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  const since = health?.first_logged_at ?? null;
  return (
    <section className="hp mv-content" aria-label="Stream health">
      <div className="cp-head">
        <span className="cp-total" data-testid="hp-period">
          Last {days} days{since === null ? ' · nothing logged yet' : ` · logged since ${relativeDate(since, now, true)}`}
        </span>
        <div className="cp-bulk" role="group" aria-label="Period">
          {HEALTH_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === days ? 'ibtn on cp-bulkbtn' : 'ibtn hov cp-bulkbtn'}
              data-tip={`The last ${d} days`}
              data-tip-side="below"
              aria-label={`Last ${d} days`}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              <CalendarBlank weight="duotone" />
              <span className="cp-n">{d}</span>
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}
```

**File:** `web/src/components/movies/HealthPage.css` (new)
```css
/* The Stream health page (/movies/health): the Cache page's look (CachePage.css: .cp-head, .cp-bulk, .cp-bulkbtn). Monochrome, mono numbers, no table. */
.hp { padding-bottom: 96px; }
.hp-label { margin: 22px 0 6px; font-family: var(--mono); font-size: 10.5px; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.hp-list, .hp-sources { list-style: none; margin: 0; padding: 0; }
.hp-item { border-top: 1px solid var(--line); }
.hp-item:last-child { border-bottom: 1px solid var(--line); }
.hp-sources { padding-left: 34px; border-left: 1px dashed var(--line-25); margin-left: 15px; }
.hp-row { display: flex; align-items: center; gap: 10px; min-height: 48px; }
.hp-sub { min-height: 38px; }
.hp-icon { flex: none; width: 30px; display: inline-grid; place-items: center; font-size: 17px; color: var(--fg); }
.hp-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); }
.hp-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.hp-sub .hp-name { font-family: var(--mono); font-size: 12px; letter-spacing: .03em; }
.hp-stat { flex: none; width: 74px; display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.hp-stat-v { font-family: var(--mono); font-size: 13px; letter-spacing: .02em; color: var(--fg); }
.hp-sub .hp-stat-v { font-size: 12px; }
.hp-stat-l { font-family: var(--mono); font-size: 9.5px; letter-spacing: .05em; color: var(--muted); }
.hp-sub .hp-stat-l { display: none; }
.hp-fails { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 0 10px 40px; }
.hp-tag { font-size: 10px; display: inline-flex; align-items: center; gap: 4px; }
.hp-why { white-space: nowrap; }
.hp-num { flex: none; width: 58px; text-align: right; font-family: var(--mono); font-size: 12px; letter-spacing: .02em; }
.hp-wide { width: 96px; }
.hp-ended { flex: none; width: 170px; font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-item[data-outcome="failed"] .hp-ended { color: var(--fg); }
.hp-when { flex: none; width: 110px; text-align: right; font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--muted); }
@media (max-width: 760px) {
  .hp-stat:nth-child(n + 6) { display: none; }
  .hp-num, .hp-when { display: none; }
  .hp-ended { width: auto; }
  .hp-sources { padding-left: 12px; margin-left: 6px; }
}
```

### Step 9: The heartbeat button and the page in MoviesPage
**File:** `web/src/pages/MoviesPage.tsx`
- `:2` the Phosphor import gains `Heartbeat`:
```ts
import { ArrowLeft, ArrowsClockwise, Books, Broadcast, FilmSlate, HardDrives, Heartbeat, Question, Warning } from '@phosphor-icons/react';
```
- `:3` after the `CachePage` import: `import { HealthPage } from '../components/movies/HealthPage';`
- `:39`:
```ts
import { CACHE_ROUTE, HEALTH_ROUTE, NO_MOVIES_ROUTE, STREAM_ROUTE, type MoviesRoute } from '../lib/route';
```
- `:98`:
```ts
  const isGrid = route.title === null && !route.unmatched && !route.cache && !route.health;
```
- `:283-299` (from the comment `// The Cache page's button:` through the `const streamGrid = ...` line) becomes:
```tsx
  // The Cache page's and the Stream health page's buttons: after the Films / Series buttons on the Stream grid, else in the toolbar.
  const onCache = route.cache === true;
  const onHealth = route.health === true;
  const onPage = onCache || onHealth;
  const cacheButton = (
    <button
      type="button"
      className={onCache ? 'ibtn on cp-cachebtn' : 'ibtn hov cp-cachebtn'}
      data-tip="Cache: what this machine keeps on disk for streaming"
      data-tip-side="below"
      aria-label="Cache"
      aria-pressed={onCache}
      disabled={off}
      onClick={() => onRoute(onCache ? STREAM_ROUTE : CACHE_ROUTE)}
    >
      <HardDrives weight="duotone" />
    </button>
  );
  const healthButton = (
    <button
      type="button"
      className={onHealth ? 'ibtn on' : 'ibtn hov'}
      data-tip="Stream health: how plays went on this machine"
      data-tip-side="below"
      aria-label="Stream health"
      aria-pressed={onHealth}
      disabled={off}
      onClick={() => onRoute(onHealth ? STREAM_ROUTE : HEALTH_ROUTE)}
    >
      <Heartbeat weight="duotone" />
    </button>
  );
  const pageButtons = (
    <>
      {cacheButton}
      {healthButton}
    </>
  );
  const streamGrid = side === 'stream' && route.title === null && !onPage && !off && store.streamError === null && store.stream !== null && store.stream.enabled && store.stream.titles.length > 0;
```
- `:312-313`:
```tsx
    {side === 'stream' && !streamGrid && pageButtons}
    {(route.title !== null || route.unmatched || onPage) && (
```
- `:353`, after the `else if (onCache) content = <CachePage ... />;` line:
```tsx
  else if (onHealth) content = <HealthPage onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} />;
```
- `:383`: `afterKinds={cacheButton}` → `afterKinds={pageButtons}`.
- `:407` and `:410`: `!onCache` → `!onPage` (no Site titles or Trending sections under the health page).
**Impact:** a second icon beside the drive icon on the Stream side; Back returns to the Stream grid.

### Step 10: Tests
**File:** `tests/helpers/playLogRows.ts` (new: the seed both unit test files share, also the Proof's seed)
```ts
import type { HealthRow, UnhandledEntry } from '../../src/directStream/playLog/health.js';

export const NOW = new Date('2026-11-27T12:00:00Z');
export const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);

export function row(over: Partial<HealthRow>): HealthRow {
  return {
    id: 1,
    asked_at: ago(10),
    kind: 'movie',
    tmdb_id: 990001,
    season: null,
    episode: null,
    asked: null,
    outcome: 'played',
    failure: null,
    cloud_failure: null,
    torrent_failure: null,
    resolve_ms: null,
    channel: null,
    provider_first: null,
    torrent_index: null,
    height: null,
    first_frame_ms: null,
    played_ms: 0,
    stalls: 0,
    stalled_ms: 0,
    waits: 0,
    waited_ms: 0,
    ended: null,
    title: 'Health Film A',
    movie_id: 'M-AAAA',
    ...over,
  };
}

/** The verify journeys' seed (Proof J2): newest first, as healthRows returns them. */
export const SEED: HealthRow[] = [
  row({ id: 4, asked_at: ago(30), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'no_source', cloud_failure: 'no_stream', torrent_failure: 'no_source', resolve_ms: 30_000, title: 'Health Series', movie_id: null }),
  row({ id: 2, asked_at: ago(60), tmdb_id: 990002, title: 'Health Film B', movie_id: 'M-BBBB', asked: 'torrent', channel: 'torrent', torrent_index: 'apibay', height: 720, resolve_ms: 12_000, first_frame_ms: 5000, played_ms: 60_000, ended: 'closed' }),
  row({ id: 1, asked_at: ago(120), asked: 'torrent', channel: 'torrent', torrent_index: 'apibay', height: 1080, resolve_ms: 8000, first_frame_ms: 3000, played_ms: 1_800_000, stalls: 2, stalled_ms: 6000, ended: 'finished' }),
  row({ id: 3, asked_at: ago(180), channel: 'cloud', provider_first: 'VidFast', height: 1080, resolve_ms: 20_000, first_frame_ms: 2000, played_ms: 1_740_000, stalls: 1, stalled_ms: 2000, ended: 'closed' }),
  row({ id: 5, asked_at: ago(300), tmdb_id: 990002, title: 'Health Film B', movie_id: 'M-BBBB', asked: 'torrent', outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source', resolve_ms: 25_000 }),
];

export const UNHANDLED: UnhandledEntry[] = [
  { title: 'Health Series', movie_id: null, kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: ago(30).toISOString(), cloud_failure: 'no_stream', torrent_failure: 'no_source' },
];
```

**File:** `tests/unit/directStream/playLogHealth.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { buildHealth, channelsOf, median, readHealth, type HealthRow, type PlayLogReader, type UnhandledEntry } from '../../../src/directStream/playLog/health.js';
import { ago, NOW, row, SEED, UNHANDLED } from '../../helpers/playLogRows.js';

const build = (rows: HealthRow[], unhandled: UnhandledEntry[] = []) => buildHealth({ host: 'pc', days: 7, since: ago(7 * 1440), rows, firstLoggedAt: rows.length === 0 ? null : ago(20 * 1440), unhandled });

describe('the Health answer', () => {
  it('leads per channel with start success, first frame, stalls and the share at 1080p; a short play is a success', () => {
    const h = build(SEED, UNHANDLED);
    expect(h.totals.all).toMatchObject({ asks: 5, failed: 2, played: 3, no_picture: 0, success_rate: 0.6 });
    expect(h.totals.torrent).toEqual({
      asks: 4,
      failed: 2,
      no_picture: 0,
      played: 2,
      success_rate: 0.5,
      median_resolve_ms: 10_000,
      median_first_frame_ms: 4000,
      played_hours: 0.52,
      stalls_per_hour: 3.87,
      stalled_share: 0.0032,
      hd_share: 0.5,
    });
    expect(h.totals.cloud).toMatchObject({ asks: 2, failed: 1, played: 1, success_rate: 0.5, median_resolve_ms: 20_000, median_first_frame_ms: 2000, hd_share: 1 });
    expect(h.by_source.map((s) => [s.channel, s.source, s.asks, s.played, s.success_rate])).toEqual([
      ['torrent', 'apibay', 2, 2, 1],
      ['cloud', 'VidFast', 1, 1, 1],
    ]);
    expect(h.failures).toEqual([
      { channel: 'torrent', failure: 'no_source', count: 2 },
      { channel: 'cloud', failure: 'no_stream', count: 1 },
    ]);
    // The one-minute play of Film B is a played row, ended closed, never a failure.
    expect(h.recent.find((p) => p.id === 2)).toMatchObject({ outcome: 'played', ended: 'closed', source: 'apibay' });
    expect(h.recent[0]).toMatchObject({ id: 4, title: 'Health Series', season: 1, episode: 2, outcome: 'failed', source: null });
    expect(h.unhandled).toEqual(UNHANDLED);
  });

  it('answers zero counts and null medians with nothing logged', () => {
    const h = build([]);
    for (const c of ['all', 'cloud', 'torrent']) {
      expect(h.totals[c]).toEqual({ asks: 0, failed: 0, no_picture: 0, played: 0, success_rate: null, median_resolve_ms: null, median_first_frame_ms: null, played_hours: 0, stalls_per_hour: null, stalled_share: null, hd_share: null });
    }
    expect(h.by_source).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.recent).toEqual([]);
    expect(h.first_logged_at).toBeNull();
  });

  it('counts a failed ask under each channel it asked, and a site play as played', () => {
    expect(channelsOf(row({ outcome: 'failed', cloud_failure: 'bot_check', torrent_failure: 'no_source' }))).toEqual(['cloud', 'torrent']);
    expect(channelsOf(row({ outcome: 'failed', asked: 'provider' }))).toEqual(['cloud']);
    expect(channelsOf(row({ outcome: 'failed' }))).toEqual(['none']);
    const h = build([row({ outcome: 'site', channel: 'site', provider_first: 'idlix' })]);
    expect(h.totals.site).toMatchObject({ asks: 1, played: 1, success_rate: 1 });
  });

  it('takes the middle value', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  it('reads the period before now from the reader', async () => {
    const asked: Array<[string, string]> = [];
    const reader: PlayLogReader = {
      healthRows: async (host, since) => {
        asked.push([host, since.toISOString()]);
        return SEED;
      },
      firstAskedAt: async () => ago(20 * 1440),
      unhandled: async (_host, limit) => {
        expect(limit).toBe(200);
        return UNHANDLED;
      },
    };
    const h = await readHealth(reader, 'pc', 7, NOW);
    expect(asked).toEqual([['pc', '2026-11-20T12:00:00.000Z']]);
    expect(h.since).toBe('2026-11-20T12:00:00.000Z');
    expect(h.totals.all!.asks).toBe(5);
  });
});
```
(The numbers: torrent played_ms 1,860,000 → 0.5167 h → `played_hours` 0.52; stalls 2 / 0.5167 = 3.87; stalled 6000 / 1,860,000 = 0.0032.)

**File:** `tests/unit/mcp.streamHealthTool.test.ts` (new)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { readHealth, type PlayLogReader, type StreamHealthReader } from '../../src/directStream/playLog/health.js';
import { streamHealthRoutes } from '../../src/http/streamHealthApi.js';
import { registerStreamHealthTool } from '../../src/mcp/streamHealthTool.js';
import { NOW, SEED } from '../helpers/playLogRows.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const json = (r: ToolResult): any => JSON.parse(r.content.map((c) => c.text ?? '').join('\n'));

function readerOf(rows = SEED): StreamHealthReader {
  const log: PlayLogReader = { healthRows: async () => rows, firstAskedAt: async () => null, unhandled: async () => [] };
  return { read: (days) => readHealth(log, 'pc', days, NOW) };
}

async function connect(reader: StreamHealthReader | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamHealthTool(server, { streamHealth: reader, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'direct_stream_health', arguments: args })) as ToolResult,
    list: async () => (await client.listTools()).tools,
  };
}

const deps = { db: {} as never, movies: null };

describe('direct_stream_health and GET /api/stream/health', () => {
  it('answer the same figures', async () => {
    const reader = readerOf();
    const app = streamHealthRoutes(deps, { reader });
    const res = await app.request('/api/stream/health?days=30');
    expect(res.status).toBe(200);
    const route = await res.json();
    const tool = json(await (await connect(reader)).call({ days: 30 }));
    const { link, next, ...figures } = tool;
    expect(figures).toEqual(route);
    expect(link).toBe('http://localhost:7317/movies/health');
    expect(next).toContain('success_rate');
    expect(route.days).toBe(30);
    expect(route.totals.torrent.success_rate).toBe(0.5);
  });

  it('defaults to 7 days and refuses a period outside 1 to 90', async () => {
    const app = streamHealthRoutes(deps, { reader: readerOf() });
    expect((await (await app.request('/api/stream/health')).json()).days).toBe(7);
    for (const bad of ['0', '91', '2.5', 'week']) {
      const res = await app.request(`/api/stream/health?days=${bad}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_query');
    }
  });

  it('says nothing was played when nothing is logged', async () => {
    const body = json(await (await connect(readerOf([]))).call({}));
    expect(body.totals.all).toMatchObject({ asks: 0, median_first_frame_ms: null });
    expect(body.next).toBe('Say nothing was played on this machine in the last 7 days.');
  });

  it('is read-only, and answers direct_stream_off without the movie library', async () => {
    const c = await connect(null);
    const tools = await c.list();
    expect(tools.find((t) => t.name === 'direct_stream_health')?.annotations?.readOnlyHint).toBe(true);
    const r = await c.call({});
    expect(r.isError).toBe(true);
    expect(json(r).error).toBe('direct_stream_off');
    const res = await streamHealthRoutes(deps).request('/api/stream/health');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('direct_stream_off');
  });
});
```

**File:** `tests/integration/streamPlayLog.health.int.test.ts` (new)
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readHealth } from '../../src/directStream/playLog/health.js';
import { PlayLogRepo } from '../../src/directStream/playLog/repo.js';
import { movieEpisodes } from '../../src/db/schema.js';
import { truncateAll } from './setup.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HERE = 'health-host-a';
const OTHER = 'health-host-b';
const NOW = new Date('2026-11-27T12:00:00Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

let h: ApiHarness;
let repo: PlayLogRepo;

/** One play log row through raw SQL: the test seeds by the contract's column names, never through phase 1's writer. */
async function log(r: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(r);
  await h.deps.db.execute(sql`insert into stream_play_log (${sql.raw(cols.join(', '))}) values (${sql.join(cols.map((c) => sql`${r[c]}`), sql`, `)})`);
}

const base = { via: 'play', kind: 'movie' } as const;

beforeAll(async () => {
  h = await createApiHarness();
  repo = new PlayLogRepo(h.deps.db);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  // truncateAll already empties stream_play_log (phase 1 put it at the head of its list).
  await seedTitle(h.deps.db, { id: 'movie-990001', kind: 'movie', tmdbId: 990001, title: 'Health Film A' });
  await seedTitle(h.deps.db, { id: 'movie-990002', kind: 'movie', tmdbId: 990002, title: 'Health Film B' });
  await seedTitle(h.deps.db, { id: 'tv-990003', kind: 'tv', tmdbId: 990003, title: 'Health Series' });
  await h.deps.db.insert(movieEpisodes).values({ titleId: 'tv-990003', season: 1, episode: 2, name: 'Two' });
  await log({ ...base, host: HERE, asked_at: ago(120), tmdb_id: 990001, asked: 'torrent', outcome: 'played', session: 's1', channel: 'torrent', torrent_index: 'apibay', height: 1080, resolve_ms: 8000, first_frame_ms: 3000, played_ms: 1_800_000, stalls: 2, stalled_ms: 6000, ended: 'finished', ended_at: ago(85) });
  await log({ ...base, host: HERE, asked_at: ago(60), tmdb_id: 990002, asked: 'torrent', outcome: 'played', session: 's2', channel: 'torrent', torrent_index: 'apibay', height: 720, resolve_ms: 12_000, first_frame_ms: 5000, played_ms: 60_000, ended: 'closed', ended_at: ago(58) });
  await log({ ...base, host: HERE, asked_at: ago(180), tmdb_id: 990001, outcome: 'played', session: 's3', channel: 'cloud', provider_first: 'VidFast', height: 1080, resolve_ms: 20_000, first_frame_ms: 2000, played_ms: 1_740_000, stalls: 1, stalled_ms: 2000, ended: 'closed', ended_at: ago(150) });
  // A row with `ended` carries `ended_at` (phase 1's stream_play_log_ended_check).
  await log({ ...base, host: HERE, asked_at: ago(30), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'no_source', cloud_failure: 'no_stream', torrent_failure: 'no_source', resolve_ms: 30_000 });
  await log({ ...base, host: HERE, asked_at: ago(300), tmdb_id: 990002, asked: 'torrent', outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source', resolve_ms: 25_000 });
  // Twenty days ago: outside the 7-day period, inside "all time" for the unhandled list.
  await log({ ...base, host: HERE, asked_at: ago(20 * 1440), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'bot_check', cloud_failure: 'bot_check' });
  // Another host's rows are never read.
  await log({ ...base, host: OTHER, asked_at: ago(10), tmdb_id: 990001, outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source' });
});

describe('PlayLogRepo health reads', () => {
  it('reads this host\'s period newest first, with names and movie ids', async () => {
    const rows = await repo.healthRows(HERE, new Date(ago(7 * 1440)));
    expect(rows.map((r) => [r.title, r.outcome])).toEqual([
      ['Health Series', 'failed'],
      ['Health Film B', 'played'],
      ['Health Film A', 'played'],
      ['Health Film A', 'played'],
      ['Health Film B', 'failed'],
    ]);
    expect(rows[0]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    expect(rows[1]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    expect(rows[0]!.asked_at).toBeInstanceOf(Date);
    expect(await repo.firstAskedAt(HERE)).toEqual(new Date(ago(20 * 1440)));
    expect(await repo.firstAskedAt('nobody')).toBeNull();
  });

  it('lists a film or episode that failed and has not played since, over all time, with what each channel last said', async () => {
    const un = await repo.unhandled(HERE, 200);
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ title: 'Health Series', kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: ago(30), cloud_failure: 'no_stream', torrent_failure: 'no_source' });
    expect(un[0]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    // Film B failed at 300 min and played at 60 min: handled. Once the series plays, it leaves the list.
    await log({ ...base, host: HERE, asked_at: ago(5), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'played', session: 's9', channel: 'torrent', torrent_index: 'apibay' });
    expect(await repo.unhandled(HERE, 200)).toEqual([]);
  });

  it('answers the health of the period', async () => {
    const h7 = await readHealth(repo, HERE, 7, NOW);
    expect(h7.totals.all).toMatchObject({ asks: 5, failed: 2, played: 3, success_rate: 0.6 });
    expect(h7.totals.torrent).toMatchObject({ asks: 4, played: 2, success_rate: 0.5, median_first_frame_ms: 4000, hd_share: 0.5 });
    expect(h7.unhandled.map((u) => u.title)).toEqual(['Health Series']);
    const empty = await readHealth(repo, 'nobody', 7, NOW);
    expect(empty.totals.all).toMatchObject({ asks: 0, median_resolve_ms: null, median_first_frame_ms: null });
    expect(empty.unhandled).toEqual([]);
  });
});
```
(Uses `NOW` in the past relative to the test clock only through `readHealth`'s `since`; `healthRows` rows were seeded relative to `NOW`, so the period filter is exact.)

**File:** `web/src/components/movies/HealthPage.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HealthFigures, StreamHealth } from '../../moviesApi';
import { endedText, failureText, HealthPage } from './HealthPage';

const zero: HealthFigures = { asks: 0, failed: 0, no_picture: 0, played: 0, success_rate: null, median_resolve_ms: null, median_first_frame_ms: null, played_hours: 0, stalls_per_hour: null, stalled_share: null, hd_share: null };
const AT = new Date(Date.now() - 30 * 60_000).toISOString();

function seeded(days: number): StreamHealth {
  return {
    host: 'pc',
    days,
    since: '',
    first_logged_at: AT,
    totals: {
      all: { ...zero, asks: 5, failed: 2, played: 3, success_rate: 0.6, median_first_frame_ms: 3000 },
      cloud: { ...zero, asks: 2, failed: 1, played: 1, success_rate: 0.5, median_first_frame_ms: 2000, hd_share: 1 },
      torrent: { ...zero, asks: 4, failed: 2, played: 2, success_rate: 0.5, median_resolve_ms: 10_000, median_first_frame_ms: 4000, played_hours: 0.52, stalls_per_hour: 3.87, stalled_share: 0.0032, hd_share: 0.5 },
    },
    by_source: [{ channel: 'torrent', source: 'apibay', ...zero, asks: 2, played: 2, success_rate: 1, hd_share: 0.5 }],
    failures: [{ channel: 'torrent', failure: 'no_source', count: 2 }],
    recent: [
      { id: 4, asked_at: AT, title: 'Health Series', movie_id: null, season: 1, episode: 2, channel: null, source: null, outcome: 'failed', failure: 'no_source', height: null, resolve_ms: 30_000, first_frame_ms: null, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, ended: null },
      { id: 2, asked_at: AT, title: 'Health Film B', movie_id: 'M-BBBB', season: null, episode: null, channel: 'torrent', source: 'apibay', outcome: 'played', failure: null, height: 720, resolve_ms: 12_000, first_frame_ms: 5000, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, ended: 'closed' },
      { id: 1, asked_at: AT, title: 'Health Film A', movie_id: 'M-AAAA', season: null, episode: null, channel: 'torrent', source: 'apibay', outcome: 'played', failure: null, height: 1080, resolve_ms: 8000, first_frame_ms: 3000, stalls: 2, stalled_ms: 6000, waits: 0, waited_ms: 0, ended: 'finished' },
    ],
    unhandled: [{ title: 'Health Series', movie_id: 'M-SER2', kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: AT, cloud_failure: 'no_stream', torrent_failure: 'no_source' }],
  };
}

const empty = (days: number): StreamHealth => ({ host: 'pc', days, since: '', first_logged_at: null, totals: { all: zero, cloud: zero, torrent: zero }, by_source: [], failures: [], recent: [], unhandled: [] });

let urls: string[];
let answer: (days: number) => StreamHealth;
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  urls = [];
  answer = seeded;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const days = Number(new URL(url, 'http://x').searchParams.get('days'));
      return new Response(JSON.stringify(answer(days)), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Stream health page', () => {
  it('leads per channel with start success, first frame, stalls and 1080p, then the sources and failures', async () => {
    render(<HealthPage onOpen={() => {}} />);
    const torrents = await screen.findByTestId('hp-channel-Torrents');
    expect(torrents.textContent).toContain('2/4');
    expect(torrents.textContent).toContain('50%');
    expect(torrents.textContent).toContain('4.0 s');
    expect(torrents.textContent).toContain('3.9');
    expect(within(screen.getByRole('list', { name: 'Torrents sources' })).getByText('apibay')).toBeTruthy();
    expect(screen.getByText('no torrent found ×2')).toBeTruthy();
    expect(urls[0]).toBe('/api/stream/health?days=7');
  });

  it('lists what could not be played, with what the cloud and the torrents last answered', async () => {
    const open = vi.fn();
    render(<HealthPage onOpen={open} />);
    const list = await screen.findByRole('list', { name: 'Could not be played' });
    const item = within(list).getAllByRole('listitem')[0]!;
    expect(item.textContent).toContain('Health Series S01E02');
    expect(item.textContent).toContain('no cloud source');
    expect(item.textContent).toContain('no torrent found');
    expect(item.textContent).toContain('2 asks');
    fireEvent.click(within(item).getByRole('button', { name: 'Open Health Series S01E02' }));
    expect(open).toHaveBeenCalledWith('M-SER2');
  });

  it('names each latest play with its source, first frame, stalls and how it ended; a short play is not a failure', async () => {
    render(<HealthPage onOpen={() => {}} />);
    const items = within(await screen.findByRole('list', { name: 'Latest plays' })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-outcome'))).toEqual(['failed', 'played', 'played']);
    expect(items[1]!.textContent).toContain('Health Film B');
    expect(items[1]!.textContent).toContain('apibay');
    expect(items[1]!.textContent).toContain('5.0 s');
    expect(items[1]!.textContent).toContain('closed');
    expect(items[1]!.textContent).not.toContain('failed');
    expect(items[2]!.textContent).toContain('2 stalls · 6.0 s');
    expect(items[2]!.textContent).toContain('finished');
    expect(items[0]!.textContent).toContain('failed · no source');
  });

  it('says nothing was played in an empty period, and asks again for another period', async () => {
    answer = empty;
    render(<HealthPage onOpen={() => {}} />);
    expect((await screen.findByTestId('hp-nothing')).textContent).toBe('Nothing was played in the last 7 days.');
    expect(screen.queryByRole('list', { name: 'Latest plays' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await settle();
    expect(urls).toContain('/api/stream/health?days=30');
    expect((await screen.findByTestId('hp-nothing')).textContent).toBe('Nothing was played in the last 30 days.');
  });

  it('words outcome words as what was missing', () => {
    expect(failureText('no_source', 'torrent')).toBe('no torrent found');
    expect(failureText('no_stream', 'cloud')).toBe('no cloud source');
    expect(failureText('bot_check', 'cloud')).toBe('bot check');
    expect(failureText('dubbed', 'torrent')).toBe('dub only');
    expect(failureText('resolved', 'cloud')).toBe('found, did not play');
    expect(failureText('skipped_browser_only', 'cloud')).toBe('not tried');
    expect(failureText('cache_language', null)).toBe('cache is a dub');
    // Every word phase 1 can write has its own wording (none falls through to the underscore fallback).
    for (const w of ['no_source', 'resolve_failed', 'open_failed', 'unknown_session', 'no_episode', 'no_subtitle', 'torrent_off', 'bad_info_hash', 'not_on_this_machine', 'cache_failed', 'cache_language', 'error', 'resolved', 'no_stream', 'bot_check', 'dubbed', 'unplayable', 'skipped', 'skipped_browser_only', 'skipped_no_template']) {
      expect(failureText(w, 'cloud')).not.toContain('_');
    }
    expect(failureText('something_new', null)).toBe('something new');
    expect(endedText({ ...seeded(7).recent[1]!, ended: 'replaced' })).toBe('replaced by another play');
  });
});
```

### Step 11: The feature map
**File:** `.claude/skills/verify-notesd/features/movies.md:33` — after the Cache page entry (the bullet that ends
`...see \`features/direct-streaming.md\`, "Downloads asked for").`), add:
```markdown
- Stream health page (`/movies/health`): the heartbeat icon beside the Cache drive icon on the Stream side
  (aria-label `Stream health`). `GET /api/stream/health?days=N` (1..90, default 7) and the `direct_stream_health`
  tool answer the same from `stream_play_log`, this host only: per channel (`all`, `cloud`, `torrent` always) and
  per torrent index or cloud provider, asks, played (a short play counts), `success_rate`, medians of time to
  answer and first frame, stalls per hour, `stalled_share`, `hd_share`; failures by word; the latest 30 asks;
  and `unhandled`, over all time, every film or episode whose asks failed and that has not played since, with
  `cloud_failure`/`torrent_failure`. The page: "By channel" with sources and failure chips, "Could not be
  played" (`no torrent found`, `no cloud source`, ...), "Latest plays"; an empty period says `Nothing was played
  in the last 7 days.` Proof: `tests/unit/directStream/playLogHealth.test.ts`, `tests/unit/mcp.streamHealthTool.test.ts`,
  `tests/integration/streamPlayLog.health.int.test.ts`, `web/src/components/movies/HealthPage.test.tsx`; on a
  `$V up --web --direct-stream` run, seed `movie_titles` and `stream_play_log` with `$V exec` (the host from the
  empty answer's `host`) and drive the route, the tool and the page (phase 3's Proof, J1-J5).
```
**File:** `.claude/skills/verify-notesd/features/README.md:19` — in the Movies row's feature cell, replace
`the Cache page and its Downloading view,` with `the Cache page and its Downloading view, the Stream health page (\`direct_stream_health\`),`.

## Principles applied

- Laziness protocol: no new `AppDeps` field and no wiring in `src/daemon.ts`; the reader builds `new PlayLogRepo(deps.db)` as `/api/movies/trending` builds its `TrendingRepo`, so phase 3 touches none of phase 1's wiring.
- Laziness protocol: the drive icon's neighbour goes into `MoviesPage.tsx` through `MoviesGrid`'s existing `afterKinds` prop; `MoviesGrid.tsx` and `App.tsx` are not changed.
- Boundary discipline: `days` is checked once at each entry (zod in the route, zod in the tool's input schema); `readHealth` trusts it. Raw database values are normalised once in `toHealthRow`/`toUnhandled` (ids and counts to numbers, times to `Date`/ISO).
- Make illegal states unrepresentable / single source: the route and the tool both answer `StreamHealthReader.read`, built once by `streamHealthReader`; the tool adds only `link` and `next`, so "the same figures" (R2.2) holds by construction and the unit test compares the two answers whole.
- Test behavior, not implementation: the R2.5 rule lives in SQL and is tested against real Postgres (`streamPlayLog.health.int.test.ts`) through `unhandled` and `readHealth`, not through a mocked query; the unit tests assert the answer's figures, not private helpers.
- Prove it works: Proof drives the throwaway daemon's route, MCP tool and page with seeded rows, and reads the empty case first.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), `npm run test:int -- tests/integration/streamPlayLog.health.int.test.ts`, `npm run docs:check`
**Proof:** a throwaway daemon built from this worktree, with the play log seeded by SQL (phase 1's writer needs a real play; the figures are read-only and the seed is what the reader sees).
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root)
- Feature-map entries: `features/movies.md` ("Stream health page", added by Step 11)
- Setup (once, before J1): `$V up --web --direct-stream` → note `RUN`. `$V doctor RUN` passes.
- Seed (after J1, before J2), with `H` the host J1 printed:
  ```sh
  $V exec RUN "insert into movie_titles (id, kind, tmdb_id, title, original_title) values ('movie-990001','movie',990001,'Health Film A','Health Film A'),('movie-990002','movie',990002,'Health Film B','Health Film B'),('tv-990003','tv',990003,'Health Series','Health Series') on conflict do nothing"
  $V exec RUN "insert into movie_episodes (title_id, season, episode, name) values ('tv-990003',1,2,'Two') on conflict do nothing"
  $V exec RUN "insert into stream_play_log (host, asked_at, via, kind, tmdb_id, season, episode, asked, outcome, failure, cloud_failure, torrent_failure, session, channel, provider_first, torrent_index, height, resolve_ms, first_frame_ms, played_ms, stalls, stalled_ms, ended, ended_at) values
   ('$H', now() - interval '120 minutes', 'play', 'movie', 990001, null, null, 'torrent', 'played', null, null, null, 'v1', 'torrent', null, 'apibay', 1080, 8000, 3000, 1800000, 2, 6000, 'finished', now() - interval '85 minutes'),
   ('$H', now() - interval '60 minutes',  'play', 'movie', 990002, null, null, 'torrent', 'played', null, null, null, 'v2', 'torrent', null, 'apibay', 720, 12000, 5000, 60000, 0, 0, 'closed', now() - interval '58 minutes'),
   ('$H', now() - interval '180 minutes', 'play', 'movie', 990001, null, null, null, 'played', null, null, null, 'v3', 'cloud', 'VidFast', null, 1080, 20000, 2000, 1740000, 1, 2000, 'closed', now() - interval '150 minutes'),
   ('$H', now() - interval '30 minutes',  'play', 'tv', 990003, 1, 2, null, 'failed', 'no_source', 'no_stream', 'no_source', null, null, null, null, null, 30000, null, 0, 0, 0, null, null),
   ('$H', now() - interval '300 minutes', 'play', 'movie', 990002, null, null, 'torrent', 'failed', 'no_source', null, 'no_source', null, null, null, null, null, 25000, null, 0, 0, 0, null, null),
   ('$H', now() - interval '20 days',     'play', 'tv', 990003, 1, 2, null, 'failed', 'bot_check', 'bot_check', null, null, null, null, null, null, null, null, 0, 0, 0, null, null)"
  ```
  (Every row satisfies phase 1's CHECKs: `ended` with `ended_at`, a `failed` row with `failure` and no session or channel, a session row with a channel.)
- Journeys:
  - **J1** · traces R2.4 — `$V api RUN GET '/api/stream/health?days=7' 2>/dev/null | sed -n '3,$p' | jq -c '{host, a: .totals.all, c: .totals.cloud.asks, t: .totals.torrent.median_first_frame_ms, r: (.recent|length), u: (.unhandled|length)}'` on the fresh run (nothing seeded), then `$V ui RUN j1.mjs` with `export default async ({ page, base, shot, log }) => { await page.goto(base + '/movies/health'); await page.getByTestId('hp-nothing').waitFor(); const t = await page.getByTestId('hp-nothing').textContent(); if (t !== 'Nothing was played in the last 7 days.') throw new Error(t); await shot('health-empty'); log('empty period says nothing was played') }` → passes when the JSON shows `a` = `{"asks":0,"failed":0,"no_picture":0,"played":0,"success_rate":null,"median_resolve_ms":null,"median_first_frame_ms":null,"played_hours":0,"stalls_per_hour":null,"stalled_share":null,"hd_share":null}`, `c` 0, `t` null, `r` 0, `u` 0, and the UI step logs without throwing. Keep `host` as `H`.
  - **J2** · traces R2.1 — after the seed, `$V api RUN GET '/api/stream/health?days=7' 2>/dev/null | sed -n '3,$p' | jq -c '{all: .totals.all | {asks, failed, played, success_rate}, torrent: .totals.torrent, cloud: .totals.cloud | {asks, failed, played, success_rate, median_resolve_ms, median_first_frame_ms, hd_share}, src: [.by_source[] | [.channel, .source, .asks, .played]], fails: .failures}'` → passes when `all` is `{"asks":5,"failed":2,"played":3,"success_rate":0.6}`, `torrent` is `{"asks":4,"failed":2,"no_picture":0,"played":2,"success_rate":0.5,"median_resolve_ms":10000,"median_first_frame_ms":4000,"played_hours":0.52,"stalls_per_hour":3.87,"stalled_share":0.0032,"hd_share":0.5}`, `cloud` is `{"asks":2,"failed":1,"played":1,"success_rate":0.5,"median_resolve_ms":20000,"median_first_frame_ms":2000,"hd_share":1}`, `src` is `[["torrent","apibay",2,2],["cloud","VidFast",1,1]]`, and `fails` is `[{"channel":"torrent","failure":"no_source","count":2},{"channel":"cloud","failure":"no_stream","count":1}]`. Then `$V api RUN GET '/api/stream/health?days=0'` → `HTTP 400` with `invalid_query`.
  - **J3** · traces R2.2 — `$V api RUN GET '/api/stream/health?days=7' 2>/dev/null | sed -n '3,$p' | jq -S 'del(.since)' > /tmp/route.json; $V mcp RUN direct_stream_health '{"days":7}' 2>/dev/null | sed -n '2,$p' | jq -S 'del(.since, .link, .next)' > /tmp/tool.json; diff /tmp/route.json /tmp/tool.json && echo SAME`, then `npx vitest run tests/unit/chat-status.test.ts tests/unit/mcp.streamHealthTool.test.ts` → passes when `diff` prints nothing and `SAME` is printed (only `since`, computed at each call's own moment, is left out), and vitest reports both files passed (`allowedChatTools()` contains `mcp__notes__direct_stream_health`). Use the scratchpad instead of `/tmp` when the verifier has one.
  - **J4** · traces R2.3 — `$V ui RUN j4.mjs` with `export default async ({ page, base, shot, log }) => { await page.goto(base + '/movies?side=stream'); await page.getByRole('button', { name: 'Stream health' }).first().click(); await page.waitForURL('**/movies/health'); const torrents = page.getByTestId('hp-channel-Torrents'); await torrents.waitFor(); for (const s of ['2/4', '50%', '4.0 s']) if (!(await torrents.textContent()).includes(s)) throw new Error('torrents row lacks ' + s); const plays = page.getByRole('list', { name: 'Latest plays' }).getByRole('listitem'); if ((await plays.count()) !== 5) throw new Error('plays ' + (await plays.count())); const b = await plays.nth(1).textContent(); for (const s of ['Health Film B', 'apibay', '720p', '5.0 s', '0 stalls', 'closed']) if (!b.includes(s)) throw new Error('Film B row lacks ' + s); const a = await plays.nth(2).textContent(); for (const s of ['Health Film A', '2 stalls · 6.0 s', 'finished']) if (!a.includes(s)) throw new Error('Film A row lacks ' + s); await shot('health-seeded'); log('health page from the Stream side shows figures and latest plays') }` → passes when the step logs without throwing and the screenshot shows the By channel, Could not be played and Latest plays sections.
  - **J5** · traces R2.5 — `$V api RUN GET '/api/stream/health?days=7' 2>/dev/null | sed -n '3,$p' | jq -c '[.unhandled[] | {title, season, episode, asks, cloud_failure, torrent_failure, id: (.movie_id != null)}]'`, then `$V exec RUN "insert into stream_play_log (host, asked_at, via, kind, tmdb_id, season, episode, outcome, session, channel, torrent_index, height) values ('$H', now(), 'play', 'tv', 990003, 1, 2, 'played', 'v9', 'torrent', 'apibay', 1080)"` and the same `jq` again; also `$V ui RUN j5.mjs` (before the insert) with `export default async ({ page, base, shot, log }) => { await page.goto(base + '/movies/health'); const item = page.getByRole('list', { name: 'Could not be played' }).getByRole('listitem').first(); await item.waitFor(); const t = await item.textContent(); for (const s of ['Health Series S01E02', 'no cloud source', 'no torrent found', '2 asks']) if (!t.includes(s)) throw new Error('lacks ' + s); if ((await page.getByRole('list', { name: 'Could not be played' }).getByRole('listitem').count()) !== 1) throw new Error('Film B listed'); await shot('could-not-be-played'); log('could not be played lists the series with what each channel answered') }` → passes when the first `jq` prints `[{"title":"Health Series","season":1,"episode":2,"asks":2,"cloud_failure":"no_stream","torrent_failure":"no_source","id":true}]` (the 20-day-old failure counts, Film B is absent because it played after its failure), the UI step logs without throwing, and after the insert the same `jq` prints `[]`.
- Neighbor check: the Cache page, whose button now shares its slot — `$V ui RUN cache.mjs` with `export default async ({ page, base, log }) => { await page.goto(base + '/movies?side=stream'); await page.getByRole('button', { name: 'Cache' }).first().click(); await page.waitForURL('**/movies/cache'); await page.getByRole('region', { name: 'Cache' }).waitFor(); await page.getByRole('button', { name: 'Back to Stream' }).click(); await page.waitForURL('**/movies?side=stream'); log('cache page still opens and Back returns') }` → passes when it logs without throwing; and `npx vitest run web/src/components/movies/CachePage.test.tsx web/src/lib/route.test.tsx` passes.
- Cleanup: `$V down RUN`.
- Cost: none (no LLM turn, no network; `--direct-stream` uses the fake resolver).
**Exit criteria:** typecheck, `npm test`, the integration file and `docs:check` are green; on the throwaway daemon J1-J5 pass: the empty period answers zeros and nulls and the page says so, the seeded period answers the expected figures through the route and identically through `direct_stream_health`, the heartbeat icon opens `/movies/health` with the figures and latest plays, and the series that failed lists under "Could not be played" until a play follows.

## Handoffs

- **Phase 1 (reconciled, satisfied by its plan):** `cloud_failure` and `torrent_failure` on `stream_play_log`, set on `failed` rows for each channel asked; `PlayLogRepo` constructed with the `Db` alone; `channel` always null on a failed row. Phase 1's "The play log" section is not changed by this phase; this phase links it as `streaming.md#the-play-log`.
- **Phase 5 (concurrent):** see "Shared files" above — two lines each in `src/mcp/server.ts`, the generated references regenerated with `npm run docs:gen` by whichever lands second (never merged by hand), `remind` kept off the chat allow-list so the `chat-status` length assertion has only this phase's `+ 1`. Phase 5's seed body names `/movies/health` and `direct_stream_health`: exactly this phase's page path and tool name.
- **Index contract:** the "Contract extension" (success_rate, `played` includes `site`, `hd_share` over known heights, `stalled_share`, the failed-row channel rule, always-present `all`/`cloud`/`torrent`, `link`/`next` on the tool) is copied into the index's "Health answer".
- **Out of scope (index):** the live `docs:shots -- --live movies` retake for the new icon and a `health.png`: the seeded reminder (phase 5) asks for it once the page has data. No picture is added here.

## Rollback

Revert this phase's commit(s). The phase adds files and appends read methods; deleting `src/directStream/playLog/health.ts`, `src/http/streamHealthApi.ts`, `src/mcp/streamHealthTool.ts`, the web page files and tests, and reverting the edits listed in **Files** (then `npm run docs:gen`) leaves phase 1's log and writer untouched. No data is written or migrated by this phase.

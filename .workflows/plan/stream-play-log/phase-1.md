# Phase 1: Play log: table, writer, daemon wiring

**Plan set:** `STREAM_PLAY_LOG_PLAN.md`
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Satisfies:** R1 — a per-play record of how each stream play went
**Criteria:** R1.1, R1.2, R1.3, R1.4, R1.5
**Depends on:** none
**Difficulty:** HARD
**Package:** `src/directStream/playLog`

---

## Goal

Every stream play ask on this host whose title is known leaves one `stream_play_log` row: answered asks
with the session, channel, provider, time to answer and (for a torrent) info hash, index, seeds and height;
failed asks with the failure word, its redacted detail, and the word each channel (cloud, torrent) ended with.
The player page's optional `stats` key is summed across page loads in memory and written at most every 30 s
(and at once on the first report and at the end); a paused page's `beat` for the stream on screen writes
nothing. The row is closed with `finished`, `closed`, `replaced`, `expired` or `restart`. A row with outcome
`played` is a successful streaming attempt whatever its length: nothing in this phase judges a short play.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- Schema (`src/db/schema.ts`): `streamPlayLog` (table `stream_play_log`, every column of the index's contract
  **plus `cloud_failure` and `torrent_failure`**), `STREAM_PLAY_VIAS`/`StreamPlayVia`,
  `STREAM_PLAY_ASKED`/`StreamPlayAsked`, `STREAM_PLAY_OUTCOMES`/`StreamPlayOutcome`,
  `STREAM_PLAY_CHANNELS`/`StreamPlayChannel`, `STREAM_PLAY_ENDS`/`StreamPlayEnd`, `StreamPlayLogRow`,
  `NewStreamPlayLogRow`. Migration `drizzle/0044_stream_play_log.sql` (+ `drizzle/meta/0044_snapshot.json`, journal entry).
- `src/directStream/playLog/types.ts`: `PLAY_LOG_WRITE_EVERY_MS = 30_000`, `PLAY_LOG_DETAIL_MAX = 500`,
  `PLAY_LOG_MAX_LOADS = 16`, `PlayAsk`, `PageStats`, `PlayTotals`, `PageEnd`, `PageReport`, `ChannelFailures`.
- `src/directStream/playLog/derive.ts`: `RELEASE_DATE_ATTEMPT`, `askedOf(provider, magnet)`, `slotOf(ref)`,
  `channelOf(session)`, `heightOf(session)`, `kbpsOf(v)`, `subtitleSourceOf(session)`, `failureOf(err)`,
  `failureDetailOf(err)`, `channelFailures(asked, err)`.
- `src/directStream/playLog/tally.ts`: `NO_TOTALS`, `class StatsTally { add(stats: PageStats): void; get firstFrameMs(): number | null; totals(): PlayTotals }`.
- `src/directStream/playLog/repo.ts`: `type PlayLogInsert`, `type PlayLogPatch`, `interface PlayLogWriter`,
  `class PlayLogRepo implements PlayLogWriter` with
  - `insert(row: PlayLogInsert, now: Date): Promise<number>` (the row id)
  - `update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void>`
  - `closeLeftOpen(host: string, now: Date): Promise<number>`
  - `bySession(host: string, session: string): Promise<StreamPlayLogRow | null>` (read used by this phase's tests)
  **Phase 3 adds its read methods to this class; every write stays here.**
- `src/directStream/playLog/log.ts`: `class PlayLog` (the in-memory tally per session + throttled, caught writes):
  - `constructor(opts: PlayLogOptions)` with `PlayLogOptions { repo: PlayLogWriter; host: string; now?: () => Date; log?: (line: string) => void; writeEveryMs?: number }`
  - `answered(ask: PlayAsk, session: StreamSession): void`
  - `failed(ask: PlayAsk, err: unknown): void`
  - `site(ask: PlayAsk, site: string): void`
  - `switched(session: StreamSession, by: 'auto' | 'owner'): void`
  - `report(sessionId: string, page: PageReport): void`
  - `replaced(sessionId: string): void`
  - `ended(session: StreamSession, reason: Exclude<StreamPlayEnd, 'restart'>): void`
  - `closeLeftOpen(): Promise<number>` (never throws)
  - `settled(): Promise<void>` (every queued write has ended; tests)
  - `type PlayLogSink = Pick<PlayLog, 'answered' | 'failed' | 'site' | 'switched' | 'ended'>`
  - `type PlayLogFeed = Pick<PlayLog, 'report' | 'replaced'>`
- `src/http/directStreamApi.ts`: `pageStatsBody` (zod), `readPageStats(raw: unknown): PageStats | null`;
  `StreamPositionDeps.playLog?: PlayLogFeed | null`.
- `AppDeps.playLog?: PlayLog | null` (`src/deps.ts`).
- `DirectStreamServiceOptions.playLog?: PlayLogSink | null`, `DirectStreamWiring.playLog?: PlayLogSink | null`.
- `tests/helpers/memoryPlayLog.ts`: `MemoryPlayLog` (a `PlayLogWriter` in memory) — phase 3 may reuse it.
- `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh` (the Proof's driver).

**Signature changes:** `directStreamRoutes(deps: Pick<AppDeps,'directStream'> & Partial<Pick<AppDeps, 'movies' | 'streamLive' | 'titleSubtitles' | 'titleCues' | 'torrents' | 'streamPreviews' | 'playLog'>>)` (adds `'playLog'`).
**Position report:** `positionBody` gains `stats: z.unknown().optional()`; the route parses it with
`readPageStats` and drops a `stats` that does not fit (never the report). Phase 2 sends exactly the index's
contract (`load`, `first_frame_ms`, `played_ms`, `stalls`, `stalled_ms`, `waits`, `waited_ms`, `errors`); numbers
may be fractional (they are rounded), `first_frame_ms` may be null or absent.
**Requires (from earlier phases):** none
**Leaves alone (owned by others):** `web/**` (phase 2); health reads, `GET /api/stream/health`, the MCP tool and the
page (phase 3); `src/sessions/**` (phase 4); `reminders`, migration `0045`, `src/reminders/**`, hooks (phase 5);
`SHARED_IMPORT_TABLES` (unchanged: the table never existed on Neon); every ranking, finder, shuffle and
auto-switch rule.

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | after `streamDownloads` (:1866-1906): the `STREAM_PLAY_*` lists and `streamPlayLog`; row types after `StreamDownloadRow` (:1961) |
| `drizzle/0044_stream_play_log.sql`, `drizzle/meta/0044_snapshot.json`, `drizzle/meta/_journal.json` | create (generated) | `npm run db:generate -- --name stream_play_log` |
| `tests/integration/setup.ts` | modify | `truncateAll` (:50) truncates `stream_play_log` too |
| `src/directStream/playLog/types.ts` | create | constants and types |
| `src/directStream/playLog/derive.ts` | create | pure functions: asked, slot, channel, height, subtitle source, failure words |
| `src/directStream/playLog/tally.ts` | create | `StatsTally`: the page's counters summed across page loads |
| `src/directStream/playLog/repo.ts` | create | `PlayLogRepo`, the only writer of `stream_play_log` |
| `src/directStream/playLog/log.ts` | create | `PlayLog`: memory, throttle, caught writes |
| `src/directStream/service.ts` | modify | option (:357), wiring (:2528, :2567), constructor `onEnd` (:527), `begin` (:753-798), `playCache` (:1324-1332), owner switches (:1555, :1733, :1883), auto switch (:1632), `switchEpisode` (:1744-1759), `continueSession` (:1805-1808), imports (:1-48) |
| `src/http/directStreamApi.ts` | modify | `directStreamRoutes` deps (:89, :259), `positionBody` (:287-294), `StreamPositionDeps` (:300-316), `streamPositionRoutes` (:336-409), `readPageStats` |
| `src/deps.ts` | modify | `playLog?: PlayLog | null` after `streamPreviews` (:148) |
| `src/daemon.ts` | modify | imports (:69), build and close-left-open after the `movieStreams` block (:231), wiring (:415-450), `deps` (:564) |
| `tests/helpers/memoryPlayLog.ts` | create | in-memory `PlayLogWriter` |
| `tests/unit/directStream/playLog/derive.test.ts` | create | pure rules |
| `tests/unit/directStream/playLog/tally.test.ts` | create | the sum across loads |
| `tests/unit/directStream/playLog/log.test.ts` | create | `PlayLog` with the memory writer |
| `tests/unit/directStream/playLogService.test.ts` | create | the service writes the rows |
| `tests/unit/directStream/positionRoute.test.ts` | modify | the route feeds the log |
| `tests/integration/directStream.playLog.int.test.ts` | create | the repo and the table's checks against Postgres |
| `CLAUDE.md` | modify | Single writers line (:102) |
| `docs/guide/architecture.md` | modify | one-writer table: a `stream_play_log` row after `stream_trending` (:74); data model: `stream_play_log` in the Direct streaming row (:98) |
| `docs/guide/streaming.md` | modify | "### The play log" after "### Stream evidence" (before :985 "### Direct streaming answers"); a row in "Where the code is" (:3100) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | "## The play log" before "## Gotchas" (:821) |
| `.claude/skills/verify-notesd/features/README.md` | modify | the direct streaming row names the play log |
| `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh` | create | the Proof's driver (executable) |

## Implementation Steps

### Step 1: The table
**File:** `src/db/schema.ts:1906` (after the closing `)` of `streamDownloads`), and `:1961` (row types)
**Change:** add the lists and the table. `schema.ts` has no semicolons; keep its style.
**Code (after `streamDownloads`):**
```ts
/** Which service entry made a play log row (src/directStream/playLog/). The CHECK below keeps the same list. */
export const STREAM_PLAY_VIAS = ['play', 'cache', 'continue', 'episode'] as const
export type StreamPlayVia = (typeof STREAM_PLAY_VIAS)[number]
/** How the ask named its source: a provider by name, a codename's kind, a magnet (`torrent`). Null: none named. */
export const STREAM_PLAY_ASKED = ['provider', 'cloud', 'torrent'] as const
export type StreamPlayAsked = (typeof STREAM_PLAY_ASKED)[number]
/** `failed`: no session; `no_picture`: a session whose page never reported; `played`: at least one report; `site`: a streaming site took it. */
export const STREAM_PLAY_OUTCOMES = ['failed', 'no_picture', 'played', 'site'] as const
export type StreamPlayOutcome = (typeof STREAM_PLAY_OUTCOMES)[number]
export const STREAM_PLAY_CHANNELS = ['cloud', 'torrent', 'cache', 'site'] as const
export type StreamPlayChannel = (typeof STREAM_PLAY_CHANNELS)[number]
/** Why a session's row was closed. Null while it is open. */
export const STREAM_PLAY_ENDS = ['finished', 'closed', 'replaced', 'expired', 'restart'] as const
export type StreamPlayEnd = (typeof STREAM_PLAY_ENDS)[number]

/**
 * One stream play ask on this host whose title is known (migration 0044): the play, the Cache page's play, a page
 * carrying on after a restart, the player's previous/next episode. Written only by PlayLogRepo
 * (src/directStream/playLog/repo.ts) through PlayLog, which never fails, delays or changes a play. A failed ask
 * keeps its outcome word, its redacted detail and the word each channel ended with (`cloud_failure`,
 * `torrent_failure`; null: that channel was not asked). A session's row holds the page's counters summed over every
 * page load and is closed with `ended`. A `played` row is a successful streaming attempt whatever its length.
 * Neon never held it, so it is not in SHARED_IMPORT_TABLES.
 */
export const streamPlayLog = pgTable(
  'stream_play_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    host: text('host').notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true, mode: 'date' }).notNull(),
    via: text('via').$type<StreamPlayVia>().notNull(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    season: integer('season'),
    episode: integer('episode'),
    asked: text('asked').$type<StreamPlayAsked>(),
    outcome: text('outcome').$type<StreamPlayOutcome>().notNull(),
    failure: text('failure'),
    failureDetail: text('failure_detail'),
    cloudFailure: text('cloud_failure'),
    torrentFailure: text('torrent_failure'),
    resolveMs: integer('resolve_ms'),
    session: text('session'),
    channel: text('channel').$type<StreamPlayChannel>(),
    providerFirst: text('provider_first'),
    providerLast: text('provider_last'),
    infoHash: text('info_hash'),
    torrentIndex: text('torrent_index'),
    seeds: integer('seeds'),
    filmKbps: integer('film_kbps'),
    height: integer('height'),
    firstFrameMs: integer('first_frame_ms'),
    playedMs: integer('played_ms').notNull().default(0),
    stalls: integer('stalls').notNull().default(0),
    stalledMs: integer('stalled_ms').notNull().default(0),
    waits: integer('waits').notNull().default(0),
    waitedMs: integer('waited_ms').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    autoSwitches: integer('auto_switches').notNull().default(0),
    ownerSwitches: integer('owner_switches').notNull().default(0),
    refreshes: integer('refreshes').notNull().default(0),
    switchNote: text('switch_note'),
    subtitleSource: text('subtitle_source'),
    ended: text('ended').$type<StreamPlayEnd>(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stream_play_log_session_idx').on(t.session).where(sql`${t.session} is not null`),
    index('stream_play_log_host_asked_idx').on(t.host, t.askedAt),
    check('stream_play_log_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check(
      'stream_play_log_slot_check',
      sql`${t.tmdbId} > 0 and ((${t.kind} = 'movie' and ${t.season} is null and ${t.episode} is null) or (${t.kind} = 'tv' and ${t.season} >= 0 and ${t.episode} > 0))`,
    ),
    check('stream_play_log_via_check', sql`${t.via} in ('play', 'cache', 'continue', 'episode')`),
    check('stream_play_log_asked_check', sql`${t.asked} is null or ${t.asked} in ('provider', 'cloud', 'torrent')`),
    check('stream_play_log_outcome_check', sql`${t.outcome} in ('failed', 'no_picture', 'played', 'site')`),
    check(
      'stream_play_log_failed_check',
      sql`(${t.outcome} = 'failed') = (${t.failure} is not null) and (${t.outcome} = 'failed' or (${t.failureDetail} is null and ${t.cloudFailure} is null and ${t.torrentFailure} is null))`,
    ),
    check('stream_play_log_session_check', sql`(${t.outcome} in ('no_picture', 'played')) = (${t.session} is not null)`),
    check(
      'stream_play_log_channel_check',
      sql`(${t.channel} is null or ${t.channel} in ('cloud', 'torrent', 'cache', 'site')) and (${t.outcome} = 'failed') = (${t.channel} is null) and (${t.outcome} = 'site') = (${t.channel} is not distinct from 'site')`,
    ),
    check(
      'stream_play_log_ended_check',
      sql`(${t.ended} is null or ${t.ended} in ('finished', 'closed', 'replaced', 'expired', 'restart')) and (${t.ended} is null) = (${t.endedAt} is null) and (${t.ended} is null or ${t.session} is not null)`,
    ),
    check(
      'stream_play_log_counts_check',
      sql`${t.playedMs} >= 0 and ${t.stalls} >= 0 and ${t.stalledMs} >= 0 and ${t.waits} >= 0 and ${t.waitedMs} >= 0 and ${t.errors} >= 0 and ${t.autoSwitches} >= 0 and ${t.ownerSwitches} >= 0 and ${t.refreshes} >= 0 and (${t.resolveMs} is null or ${t.resolveMs} >= 0) and (${t.firstFrameMs} is null or ${t.firstFrameMs} >= 0)`,
    ),
  ],
)
```
**Code (after `export type StreamDownloadRow = typeof streamDownloads.$inferSelect`):**
```ts
export type StreamPlayLogRow = typeof streamPlayLog.$inferSelect
export type NewStreamPlayLogRow = typeof streamPlayLog.$inferInsert
```
Then, in the worktree root: `npm run db:generate -- --name stream_play_log`. It must write
`drizzle/0044_stream_play_log.sql` (one `CREATE TABLE "stream_play_log"` with the 39 columns and 10 checks, then
`CREATE UNIQUE INDEX "stream_play_log_session_idx" ... WHERE "stream_play_log"."session" is not null` and
`CREATE INDEX "stream_play_log_host_asked_idx" ... ("host","asked_at")`), `drizzle/meta/0044_snapshot.json` and
the journal's `idx: 44` entry. If the generated SQL holds anything else (a change to another table), stop: the
schema drifted from `0043`'s snapshot. Never hand-edit the generated file.

**File:** `tests/integration/setup.ts:50`
**Change:** add `stream_play_log` at the front of the truncate list:
```ts
  await db.execute(sql`truncate table stream_play_log, stream_downloads, stream_torrent_marks, stream_torrents, stream_caches, stream_provider_health, stream_providers, movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles, adversary_reviews, note_session_links, cc_session_reply_embeddings, cc_session_replies, cc_session_prompt_images, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
**Impact:** additive table; `npm run typecheck` green; the daemon applies `0044` at its next start.

### Step 2: Types
**File:** `src/directStream/playLog/types.ts` (new)
**Code:**
```ts
import type { StreamPlayAsked, StreamPlayEnd, StreamPlayVia } from '../../db/schema.js';
import type { StreamRef } from '../types.js';

/** An open play's row is written at most this often while its page reports; the first report and the end are written at once. */
export const PLAY_LOG_WRITE_EVERY_MS = 30_000;
/** Characters of a failure's detail kept on the row (as stream_downloads keeps). */
export const PLAY_LOG_DETAIL_MAX = 500;
/** Page loads kept apart per session; older ones are folded into one total (a load never reports after the page that replaced it). */
export const PLAY_LOG_MAX_LOADS = 16;

/** One play ask whose title is known: when it began, which service entry made it, the title, how the source was named. */
export interface PlayAsk {
  at: Date;
  via: StreamPlayVia;
  ref: StreamRef;
  asked: StreamPlayAsked | null;
}

/** The player page's counters since its load (the position report's `stats` key, read once at the route). */
export interface PageStats {
  /** The page load's own random id. */
  load: string;
  /** Page load to first frame; null until there was one. */
  firstFrameMs: number | null;
  playedMs: number;
  stalls: number;
  stalledMs: number;
  /** Torrent waits (`waiting for the torrent`): never counted as stalls. */
  waits: number;
  waitedMs: number;
  errors: number;
}

/** The counters summed over a session's page loads. */
export interface PlayTotals {
  playedMs: number;
  stalls: number;
  stalledMs: number;
  waits: number;
  waitedMs: number;
  errors: number;
}

/** How a page says its play is over: the film ended, or the page closed. */
export type PageEnd = Extract<StreamPlayEnd, 'finished' | 'closed'>;

/** One position report as the play log reads it. `quiet`: a paused page's beat for the stream on screen (memory only). */
export interface PageReport {
  stats: PageStats | null;
  over: PageEnd | null;
  quiet: boolean;
}

/** The outcome word each channel of a failed ask ended with; null: that channel was not asked. */
export interface ChannelFailures {
  cloud: string | null;
  torrent: string | null;
}
```

### Step 3: Pure rules
**File:** `src/directStream/playLog/derive.ts` (new)
**Code:**
```ts
import type { MovieTitleKind, StreamPlayAsked, StreamPlayChannel } from '../../db/schema.js';
import { CachePlayError } from '../cachePlay.js';
import { redactQueries } from '../evidence.js';
import { showsEnglish } from '../outsideSubtitles.js';
import type { StreamSession } from '../sessions.js';
import { namesCloud, namesTorrent, SUBTITLES_PENDING } from '../torrent/source.js';
import { DirectStreamError, type ResolveAttempt, type StreamRef } from '../types.js';
import { PLAY_LOG_DETAIL_MAX, type ChannelFailures } from './types.js';

/** The one attempt of a play refused because the title is not out yet: service.ts's NOT_RELEASED (a test keeps the two equal). */
export const RELEASE_DATE_ATTEMPT = 'Release date';
const SUBTITLE_TIER = 'Subtitles: ';
const SKIPPED = new Set<string>(['skipped', 'skipped_browser_only', 'skipped_no_template']);
/** Which word a channel's attempts end with, the first that any attempt has: a stream found, then what the owner can act on. */
const WORDS = ['resolved', 'bot_check', 'dubbed', 'no_stream', 'unplayable', 'error'] as const;

/** How the ask named its source, as `playDirect` sets the session's lock: a magnet or "torrent", "cloud", a provider by name, or nothing. */
export function askedOf(provider: string | null, magnet: string | null): StreamPlayAsked | null {
  if (magnet !== null) return 'torrent';
  if (provider === null) return null;
  if (namesTorrent(provider)) return 'torrent';
  return namesCloud(provider) ? 'cloud' : 'provider';
}

/** The title's columns: a film has no season or episode. */
export function slotOf(ref: StreamRef): { kind: MovieTitleKind; tmdbId: number; season: number | null; episode: number | null } {
  return ref.kind === 'movie' ? { kind: 'movie', tmdbId: ref.tmdbId, season: null, episode: null } : { kind: 'tv', tmdbId: ref.tmdbId, season: ref.season, episode: ref.episode };
}

/** What a session plays through: a torrent, this host's cache, or a cloud provider through the pass-through. */
export function channelOf(session: StreamSession): Exclude<StreamPlayChannel, 'site'> {
  if (session.torrent !== null) return 'torrent';
  return session.cache !== null ? 'cache' : 'cloud';
}

/** The height that plays: the torrent's file, else the cache's rendition, else the resolver's best. */
export function heightOf(session: StreamSession): number | null {
  return session.torrent?.height ?? session.cache?.height ?? session.source.best_height ?? null;
}

/** A bitrate as the row keeps it: whole kbit/s, or null. */
export function kbpsOf(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value);
}

/**
 * Where the session's English subtitle comes from now: a torrent's subtitle tier (`Subtitles: <tier>`, the tier's
 * name), the torrent's own files (`torrent`), the stream (`stream`), the cache (`cache`), or one from outside the
 * stream (`outside`). Null: none.
 */
export function subtitleSourceOf(session: StreamSession): string | null {
  const torrent = session.torrent;
  if (torrent !== null) {
    const tier = [...session.attempts].reverse().find((a) => a.provider.startsWith(SUBTITLE_TIER) && a.provider !== SUBTITLES_PENDING && a.outcome === 'resolved');
    if (tier !== undefined) return tier.provider.slice(SUBTITLE_TIER.length);
    return showsEnglish(torrent.subtitles) ? 'torrent' : null;
  }
  const own = session.cache === null ? session.source.subtitles : session.cache.subtitles;
  if (showsEnglish(own)) return session.cache === null ? 'stream' : 'cache';
  return session.outside.subtitles.length > 0 ? 'outside' : null;
}

/** The failure's outcome word: a DirectStreamError's or CachePlayError's code, else `error`. */
export function failureOf(err: unknown): string {
  if (err instanceof DirectStreamError || err instanceof CachePlayError) return err.code;
  return 'error';
}

/** The failure's message with every query, fragment and magnet link cut off, at most PLAY_LOG_DETAIL_MAX characters; null when empty. */
export function failureDetailOf(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err);
  const clean = redactQueries(text.replace(/magnet:\?\S*/gi, 'magnet:')).trim();
  return clean === '' ? null : clean.slice(0, PLAY_LOG_DETAIL_MAX);
}

/** Which channel an attempt belongs to; null for a subtitle tier, a streaming site or the release-date refusal. */
function sideOf(provider: string): 'cloud' | 'torrent' | null {
  if (provider === RELEASE_DATE_ATTEMPT || provider.startsWith(SUBTITLE_TIER) || provider.startsWith('Site: ')) return null;
  if (provider === 'WARP' || provider === 'Torrent' || /^(Index|Torrent|Torrents): /.test(provider)) return 'torrent';
  return 'cloud';
}

function wordOf(attempts: readonly ResolveAttempt[]): string {
  for (const word of WORDS) if (attempts.some((a) => a.outcome === word)) return word;
  return attempts[0]?.outcome ?? 'no_source';
}

function cloudWord(all: readonly ResolveAttempt[], code: string, asked: StreamPlayAsked | null): string | null {
  const tried = all.filter((a) => !SKIPPED.has(a.outcome));
  if (tried.length > 0) return wordOf(tried);
  if (all.length > 0) return 'no_source';
  // The cloud resolve could not run (no Chrome): no provider's attempt, and the ask did go to the cloud.
  return code === 'resolve_failed' && asked !== 'torrent' ? 'resolve_failed' : null;
}

function torrentWord(all: readonly ResolveAttempt[], code: string, asked: StreamPlayAsked | null): string | null {
  const tries = all.filter((a) => a.provider.startsWith('Torrent: '));
  if (tries.length > 0) return wordOf(tries);
  const indexes = all.filter((a) => a.provider.startsWith('Index: ') && !SKIPPED.has(a.outcome));
  if (indexes.some((a) => a.outcome === 'bot_check')) return 'bot_check';
  if (indexes.length > 0 && indexes.every((a) => a.outcome === 'error')) return 'error';
  // The indexes answered and no torrent was worth trying: no torrent exists for the title.
  if (all.length > 0) return 'no_source';
  return code === 'torrent_off' && asked !== 'cloud' && asked !== 'provider' ? 'torrent_off' : null;
}

/**
 * The word each channel of a failed ask ended with, read from the failure's attempts (cloud providers by name;
 * `Index:`, `Torrent:`, `Torrents:` and `WARP` for the torrents): so the owner can find, over time, the titles no
 * torrent or no cloud source can play. Null: that channel was not asked. A title not out yet asked neither.
 */
export function channelFailures(asked: StreamPlayAsked | null, err: unknown): ChannelFailures {
  const attempts = err instanceof DirectStreamError ? err.attempts : [];
  if (attempts.some((a) => a.provider === RELEASE_DATE_ATTEMPT)) return { cloud: null, torrent: null };
  const code = failureOf(err);
  const cloud = attempts.filter((a) => sideOf(a.provider) === 'cloud');
  const torrent = attempts.filter((a) => sideOf(a.provider) === 'torrent');
  return { cloud: cloudWord(cloud, code, asked), torrent: torrentWord(torrent, code, asked) };
}
```
**Impact:** none yet (no caller).

### Step 4: The sum across page loads
**File:** `src/directStream/playLog/tally.ts` (new)
**Code:**
```ts
import { PLAY_LOG_MAX_LOADS, type PageStats, type PlayTotals } from './types.js';

export const NO_TOTALS: PlayTotals = { playedMs: 0, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0 };

function totalsOf(s: PageStats): PlayTotals {
  return { playedMs: s.playedMs, stalls: s.stalls, stalledMs: s.stalledMs, waits: s.waits, waitedMs: s.waitedMs, errors: s.errors };
}

function plus(a: PlayTotals, b: PlayTotals): PlayTotals {
  return { playedMs: a.playedMs + b.playedMs, stalls: a.stalls + b.stalls, stalledMs: a.stalledMs + b.stalledMs, waits: a.waits + b.waits, waitedMs: a.waitedMs + b.waitedMs, errors: a.errors + b.errors };
}

/** A load's counters only grow: a late report that arrives after a newer one keeps the larger figures. */
function most(a: PlayTotals, b: PlayTotals): PlayTotals {
  return {
    playedMs: Math.max(a.playedMs, b.playedMs),
    stalls: Math.max(a.stalls, b.stalls),
    stalledMs: Math.max(a.stalledMs, b.stalledMs),
    waits: Math.max(a.waits, b.waits),
    waitedMs: Math.max(a.waitedMs, b.waitedMs),
    errors: Math.max(a.errors, b.errors),
  };
}

/**
 * One session's page counters, in memory. Each report carries its load's figures since that load, so the latest of
 * each load counts once and the session's totals are their sum. The first frame is the first load's that had one.
 */
export class StatsTally {
  private readonly loads = new Map<string, PlayTotals>();
  private folded: PlayTotals = NO_TOTALS;
  private first: number | null = null;

  add(stats: PageStats): void {
    if (this.first === null && stats.firstFrameMs !== null) this.first = stats.firstFrameMs;
    const now = totalsOf(stats);
    const before = this.loads.get(stats.load);
    // Kept in the order loads last reported: the oldest is folded first.
    this.loads.delete(stats.load);
    this.loads.set(stats.load, before === undefined ? now : most(before, now));
    while (this.loads.size > PLAY_LOG_MAX_LOADS) {
      const oldest = this.loads.keys().next().value;
      if (oldest === undefined) break;
      this.folded = plus(this.folded, this.loads.get(oldest) ?? NO_TOTALS);
      this.loads.delete(oldest);
    }
  }

  get firstFrameMs(): number | null {
    return this.first;
  }

  totals(): PlayTotals {
    let sum = this.folded;
    for (const t of this.loads.values()) sum = plus(sum, t);
    return sum;
  }
}
```

### Step 5: The only writer
**File:** `src/directStream/playLog/repo.ts` (new)
**Code:**
```ts
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { streamPlayLog, type NewStreamPlayLogRow, type StreamPlayLogRow } from '../../db/schema.js';

/** A new row: everything but the id and `updated_at` (set to the write's time). */
export type PlayLogInsert = Omit<NewStreamPlayLogRow, 'id' | 'updatedAt'>;

/** What a session's later writes change: how it went, and how it ended. */
export type PlayLogPatch = Partial<
  Pick<
    NewStreamPlayLogRow,
    | 'outcome'
    | 'providerLast'
    | 'filmKbps'
    | 'firstFrameMs'
    | 'playedMs'
    | 'stalls'
    | 'stalledMs'
    | 'waits'
    | 'waitedMs'
    | 'errors'
    | 'autoSwitches'
    | 'ownerSwitches'
    | 'refreshes'
    | 'switchNote'
    | 'subtitleSource'
    | 'ended'
    | 'endedAt'
  >
>;

/** What PlayLog writes through (PlayLogRepo; a memory one in tests). */
export interface PlayLogWriter {
  insert(row: PlayLogInsert, now: Date): Promise<number>;
  update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void>;
  closeLeftOpen(host: string, now: Date): Promise<number>;
}

/** The only writer of `stream_play_log`. Every write acts on one host's rows. Phase 3's reads live here too. */
export class PlayLogRepo implements PlayLogWriter {
  constructor(private readonly db: Db) {}

  /** One row; its id. */
  async insert(row: PlayLogInsert, now: Date): Promise<number> {
    const [made] = await this.db.insert(streamPlayLog).values({ ...row, updatedAt: now }).returning({ id: streamPlayLog.id });
    if (made === undefined) throw new Error('the play log row was not inserted');
    return made.id;
  }

  async update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void> {
    await this.db
      .update(streamPlayLog)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(streamPlayLog.host, host), eq(streamPlayLog.id, id)));
  }

  /** Daemon start: the session rows this host left open (sessions live in memory) are closed as `restart`. How many. */
  async closeLeftOpen(host: string, now: Date): Promise<number> {
    const closed = await this.db
      .update(streamPlayLog)
      .set({ ended: 'restart', endedAt: now, updatedAt: now })
      .where(and(eq(streamPlayLog.host, host), isNull(streamPlayLog.ended), isNotNull(streamPlayLog.session)))
      .returning({ id: streamPlayLog.id });
    return closed.length;
  }

  /** This host's row of one stream session, or null. */
  async bySession(host: string, session: string): Promise<StreamPlayLogRow | null> {
    const [row] = await this.db
      .select()
      .from(streamPlayLog)
      .where(and(eq(streamPlayLog.host, host), eq(streamPlayLog.session, session)))
      .limit(1);
    return row ?? null;
  }
}
```

### Step 6: The log: memory, throttle, caught writes
**File:** `src/directStream/playLog/log.ts` (new)
**Code:**
```ts
import type { StreamPlayEnd } from '../../db/schema.js';
import type { StreamSession } from '../sessions.js';
import { channelFailures, channelOf, failureDetailOf, failureOf, heightOf, kbpsOf, slotOf, subtitleSourceOf } from './derive.js';
import type { PlayLogInsert, PlayLogPatch, PlayLogWriter } from './repo.js';
import { StatsTally } from './tally.js';
import { PLAY_LOG_WRITE_EVERY_MS, type PageReport, type PlayAsk } from './types.js';

export interface PlayLogOptions {
  repo: PlayLogWriter;
  /** os.hostname() (the movies service's host): every row is written under it. */
  host: string;
  now?: () => Date;
  /** One line per write that failed; default console.error. */
  log?: (line: string) => void;
  /** Default PLAY_LOG_WRITE_EVERY_MS. */
  writeEveryMs?: number;
}

/** What DirectStreamService calls. */
export type PlayLogSink = Pick<PlayLog, 'answered' | 'failed' | 'site' | 'switched' | 'ended'>;
/** What the position route calls. */
export type PlayLogFeed = Pick<PlayLog, 'report' | 'replaced'>;

/** One session's row as memory holds it between writes. */
interface SessionTally {
  readonly session: StreamSession;
  /** Set once the insert has run (every later write queues behind it). */
  rowId: number | null;
  outcome: 'no_picture' | 'played';
  readonly stats: StatsTally;
  /** The torrent the ask was answered with: its bitrate is filled in while the session still plays it. */
  readonly infoHash: string | null;
  autoSwitches: number;
  ownerSwitches: number;
  ended: Exclude<StreamPlayEnd, 'restart'> | null;
  endedAt: Date | null;
  /** When the row was last written (ms); null before the first report. */
  lastWriteAt: number | null;
  chain: Promise<void>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** An int4 column's ceiling: a sum over many loads is clamped, never refused. */
const int4 = (n: number): number => Math.min(Math.max(0, Math.round(n)), 2_147_483_647);
const msBetween = (from: Date, to: Date): number => int4(to.getTime() - from.getTime());

function patchOf(t: SessionTally): PlayLogPatch {
  const s = t.session;
  const totals = t.stats.totals();
  const kbps = s.torrent !== null && s.torrent.infoHash === t.infoHash ? kbpsOf(s.torrent.filmKbps) : null;
  return {
    outcome: t.outcome,
    providerLast: s.source.provider,
    ...(kbps === null ? {} : { filmKbps: kbps }),
    firstFrameMs: t.stats.firstFrameMs === null ? null : int4(t.stats.firstFrameMs),
    playedMs: int4(totals.playedMs),
    stalls: int4(totals.stalls),
    stalledMs: int4(totals.stalledMs),
    waits: int4(totals.waits),
    waitedMs: int4(totals.waitedMs),
    errors: int4(totals.errors),
    autoSwitches: t.autoSwitches,
    ownerSwitches: t.ownerSwitches,
    refreshes: s.refreshes,
    switchNote: s.sourceNote,
    subtitleSource: subtitleSourceOf(s),
    ended: t.ended,
    endedAt: t.endedAt,
  };
}

/**
 * This host's play log (stream_play_log): one row per play ask whose title is known, written behind the play. A
 * session's page counters are summed in memory (StatsTally) and written on the first report, at most every
 * `writeEveryMs` while it plays, on a switch and at the end; a quiet report (a paused page's beat for the stream on
 * screen) only updates memory. Every call is synchronous and caught; every write is queued per session and caught:
 * a failure is one log line and is dropped. Nothing here can fail, delay or change a play.
 */
export class PlayLog {
  private readonly repo: PlayLogWriter;
  private readonly host: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly writeEveryMs: number;
  private readonly tallies = new Map<string, SessionTally>();
  private readonly writing = new Set<Promise<void>>();

  constructor(opts: PlayLogOptions) {
    this.repo = opts.repo;
    this.host = opts.host;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.error(line));
    this.writeEveryMs = opts.writeEveryMs ?? PLAY_LOG_WRITE_EVERY_MS;
  }

  /** The ask was answered with a player session: its row, `no_picture` until the page first reports. */
  answered(ask: PlayAsk, session: StreamSession): void {
    this.guard('an answered play', () => {
      if (this.tallies.has(session.id)) return;
      const now = this.now();
      const torrent = session.torrent;
      const t: SessionTally = {
        session,
        rowId: null,
        outcome: 'no_picture',
        stats: new StatsTally(),
        infoHash: torrent?.infoHash ?? null,
        autoSwitches: 0,
        ownerSwitches: 0,
        ended: null,
        endedAt: null,
        lastWriteAt: null,
        chain: Promise.resolve(),
      };
      this.tallies.set(session.id, t);
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'no_picture',
        resolveMs: msBetween(ask.at, now),
        session: session.id,
        channel: channelOf(session),
        providerFirst: session.source.provider,
        providerLast: session.source.provider,
        infoHash: torrent?.infoHash ?? null,
        torrentIndex: torrent?.index ?? null,
        seeds: torrent?.seeds ?? null,
        filmKbps: kbpsOf(torrent?.filmKbps),
        height: heightOf(session),
        refreshes: session.refreshes,
        switchNote: session.sourceNote,
        subtitleSource: subtitleSourceOf(session),
      };
      this.queue(t, 'an answered play', async () => {
        t.rowId = await this.repo.insert(row, now);
      });
    });
  }

  /** The ask ended without a player session: the failure's word, its redacted detail and the word of each channel asked. */
  failed(ask: PlayAsk, err: unknown): void {
    this.guard('a failed play', () => {
      const now = this.now();
      const channels = channelFailures(ask.asked, err);
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'failed',
        failure: failureOf(err),
        failureDetail: failureDetailOf(err),
        cloudFailure: channels.cloud,
        torrentFailure: channels.torrent,
        resolveMs: msBetween(ask.at, now),
      };
      this.queue(null, 'a failed play', async () => {
        await this.repo.insert(row, now);
      });
    });
  }

  /** A streaming site's own player took the ask: there is no session, and no page of this daemon reports. */
  site(ask: PlayAsk, site: string): void {
    this.guard('a site play', () => {
      const now = this.now();
      const row: PlayLogInsert = {
        host: this.host,
        askedAt: ask.at,
        via: ask.via,
        ...slotOf(ask.ref),
        asked: ask.asked,
        outcome: 'site',
        resolveMs: msBetween(ask.at, now),
        channel: 'site',
        providerFirst: site,
        providerLast: site,
      };
      this.queue(null, 'a site play', async () => {
        await this.repo.insert(row, now);
      });
    });
  }

  /** The session moved to another source: by the daemon or the page by itself (`auto`), or on the owner's ask. */
  switched(session: StreamSession, by: 'auto' | 'owner'): void {
    this.guard('a source switch', () => {
      const t = this.tallies.get(session.id);
      if (t === undefined) return;
      if (by === 'auto') t.autoSwitches += 1;
      else t.ownerSwitches += 1;
      this.write(t, 'a source switch');
    });
  }

  /**
   * A position report of the session's page. Its counters always reach memory; a quiet report writes nothing. Else
   * the row is written when the page first reports (`played`), when the play ends or carries on after it was closed
   * (a reload), or when `writeEveryMs` passed since the last write.
   */
  report(sessionId: string, page: PageReport): void {
    this.guard('a position report', () => {
      const t = this.tallies.get(sessionId);
      if (t === undefined) return;
      if (page.stats !== null) t.stats.add(page.stats);
      if (page.quiet) return;
      let now = false;
      if (t.outcome === 'no_picture') {
        t.outcome = 'played';
        now = true;
      }
      if (page.over !== null) {
        if (t.ended === null) {
          t.ended = page.over;
          t.endedAt = this.now();
        }
        now = true;
      } else if (t.ended !== null) {
        // The page reports again after it closed, ended or lost the screen (a reload, a replay): the play is open again.
        t.ended = null;
        t.endedAt = null;
        now = true;
      }
      if (now || t.lastWriteAt === null || this.now().getTime() - t.lastWriteAt >= this.writeEveryMs) this.write(t, 'a position report');
    });
  }

  /** Another session's page reported while this one was the stream on screen: this play lost the screen. */
  replaced(sessionId: string): void {
    this.guard('a replaced play', () => {
      const t = this.tallies.get(sessionId);
      if (t === undefined || t.ended !== null) return;
      t.ended = 'replaced';
      t.endedAt = this.now();
      this.write(t, 'a replaced play');
    });
  }

  /** The session store dropped the session (expired, or past MAX_SESSIONS): its row is written a last time and forgotten. */
  ended(session: StreamSession, reason: Exclude<StreamPlayEnd, 'restart'>): void {
    this.guard('an ended play', () => {
      const t = this.tallies.get(session.id);
      if (t === undefined) return;
      this.tallies.delete(session.id);
      if (t.ended === null) {
        t.ended = reason;
        t.endedAt = this.now();
      }
      this.write(t, 'an ended play');
    });
  }

  /** Daemon start: the rows the previous run left open are closed as `restart`. How many; 0 when the database did not answer. */
  async closeLeftOpen(): Promise<number> {
    try {
      return await this.repo.closeLeftOpen(this.host, this.now());
    } catch (err) {
      this.log(`[notesd] play log: the rows left open were not closed: ${messageOf(err)}`);
      return 0;
    }
  }

  /** Resolves once every write queued so far has ended (tests; nothing in the daemon waits on it). */
  async settled(): Promise<void> {
    while (this.writing.size > 0) await Promise.all([...this.writing]);
  }

  private write(t: SessionTally, what: string): void {
    const now = this.now();
    t.lastWriteAt = now.getTime();
    // Read now, in this call: the queued write must say what was true when it was asked for.
    const patch = patchOf(t);
    this.queue(t, what, async () => {
      if (t.rowId === null) return;
      await this.repo.update(this.host, t.rowId, patch, now);
    });
  }

  private queue(t: SessionTally | null, what: string, job: () => Promise<void>): void {
    const run = (t?.chain ?? Promise.resolve()).then(job).catch((err: unknown) => this.log(`[notesd] play log: ${what} was not written: ${messageOf(err)}`));
    if (t !== null) t.chain = run;
    this.writing.add(run);
    void run.finally(() => this.writing.delete(run));
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`[notesd] play log: ${what} was not logged: ${messageOf(err)}`);
    }
  }
}
```
**Impact:** none yet (no caller). Steps 2-6 are proven by Step 11's unit tests and Step 12's integration test.

### Step 7: The service calls the log
**File:** `src/directStream/service.ts`

7a. Imports (after the `./outsideSubtitles.js` import, :21):
```ts
import { askedOf } from './playLog/derive.js';
import type { PlayLogSink } from './playLog/log.js';
import type { PlayAsk } from './playLog/types.js';
```

7b. `DirectStreamServiceOptions` (:357, after `siteFallback?: SiteFallback | null;`):
```ts
  /**
   * This host's play log (playLog/log.ts): one stream_play_log row per play ask whose title is known, the session's
   * source switches and its end. Every call is caught inside the log: it never fails, delays or changes a play. Null
   * or unset: nothing is logged.
   */
  playLog?: PlayLogSink | null;
```

7c. Constructor (:527, after `this.sessions.onEnd((session) => this.letGoTorrent(session));`):
```ts
    // A session the store drops closes its play log row (`expired`), unless its page closed it first.
    this.sessions.onEnd((session) => this.opts.playLog?.ended(session, 'expired'));
```

7d. Replace `begin` (:752-798) with:
```ts
  /** The play of `ref` in flight, or a new one. Its promise is the play's answer; a rejection nobody waits for is logged, not thrown away. */
  private begin(ref: StreamRef, options: { resumeS?: number | null; provider?: string | null; magnet?: string | null }): PlayInFlight {
    const provider = options.provider ?? null;
    const key = playKey(ref, provider, options.magnet ?? null);
    const running = this.inFlight.get(key);
    if (running !== undefined && this.inFlightNow(key)) return running;
    const entry: PlayInFlight = {
      ref,
      provider,
      title: refLabel(ref),
      since: this.now(),
      stage: 'starting',
      attempts: [],
      promise: Promise.resolve(null as unknown as PlayAnswer),
      waited: false,
      opened: null,
      failed: false,
      naming: false,
    };
    // The play log's row of this ask (playLog/): written behind the answer, never part of it.
    const ask: PlayAsk = { at: entry.since, via: 'play', ref, asked: askedOf(provider, options.magnet ?? null) };
    this.nameIt(entry);
    entry.promise = this.playNow(ref, options, entry).then(
      (result) => {
        if (isSitePlay(result)) {
          // A streaming site's own player plays it: no page of this daemon will report, so the play is no longer starting.
          entry.opened = { sessionId: '', at: this.now().getTime() };
          entry.stage = `playing on ${result.site}`;
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          this.opts.playLog?.site(ask, result.site);
        } else {
          entry.opened = { sessionId: result.session.session_id, at: this.now().getTime() };
          entry.stage = 'opened: waiting for the player page';
          const session = this.sessions.peek(result.session.session_id);
          if (session !== null) this.opts.playLog?.answered(ask, session);
        }
        if (entry.waited) this.keepOutcome(key, result, null);
        return result;
      },
      (err: unknown) => {
        entry.failed = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        this.logFailedPlay(entry, err);
        this.opts.playLog?.failed(ask, err);
        if (entry.waited) this.keepOutcome(key, null, err);
        throw err;
      },
    );
    // A caller answered `pending` no longer waits: the failure was logged above.
    entry.promise.catch(() => undefined);
    this.inFlight.set(key, entry);
    return entry;
  }
```

7e. Replace `playCache` (:1319-1332, with its doc comment) with:
```ts
  /**
   * POST /api/stream/cache/:id/play: plays one cache by its id, with no resolve. Throws
   * CachePlayError `unknown_cache`, `not_on_this_machine` (with the host that holds it),
   * `cache_failed` or `cache_language`; then `open_failed` as `play` does. Once the cache (and so the title) is
   * known, the ask goes to the play log; an unknown cache names no title and is not logged.
   */
  async playCache(cacheId: string, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const at = this.now();
    const caches = this.opts.caches?.() ?? null;
    const view = caches === null || !CACHE_ID_PATTERN.test(cacheId) ? null : await caches.get(cacheId);
    if (view === null) throw new CachePlayError('unknown_cache', 'There is no stream cache with that id.');
    const ask: PlayAsk = { at, via: 'cache', ref: view.ref, asked: null };
    try {
      const audioLang = await this.audioLang(view.ref);
      const check = playable(view, this.host, audioLang);
      if (!check.ok) throw cacheRefusalError(view, check.refusal, audioLang);
      const session = await this.sessionFromCache(view, check.cache, options.resumeS ?? null, audioLang);
      const result = await this.openPage(session);
      this.opts.playLog?.answered(ask, session);
      return result;
    } catch (err) {
      this.opts.playLog?.failed(ask, err);
      throw err;
    }
  }
```

7f. Owner-asked switches — insert one line after each `safeRecord(this.evidence, sessionRecord(session, 'switched', null));` in:
- `switchSource` (:1555, the line before `` this.log(`[notesd] direct stream: ${refLabel(session.ref)} moved from ${from} to ${out.source.provider} (the stream stalled)`) ``),
- `nextTorrent` (:1733, before `` ...moved from the torrent ${torrent.name} to ${out.torrent.name}` ``):
```ts
    this.opts.playLog?.switched(session, 'owner');
```
- `leaveCache` (:1883, before `` ...left the cache ${cache.id} for the stream of ... ``) — the page asks this by itself when a cached play keeps stalling or breaks (controller.ts :952, :1039), so it counts as automatic:
```ts
    this.opts.playLog?.switched(session, 'auto');
```

7g. Automatic switch — in `autoSwitch` after `session.sourceNote = why;` (:1632):
```ts
      this.opts.playLog?.switched(session, 'auto');
```

7h. Replace `switchEpisode` (:1738-1759, with its doc comment) with:
```ts
  /**
   * The player's previous / next button: a new session for the neighbouring episode of the session's
   * (the old one is left to expire; the page reports it closed), from that episode's cache on this
   * host when it can be played, else resolved. Throws `unknown_session`, `no_episode` (a film, or no
   * episode on that side), or what `resolve` throws. Once the episode is known the ask goes to the play log (`episode`).
   */
  async switchEpisode(id: string, to: 'prev' | 'next'): Promise<SessionInfo> {
    const at = this.now();
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const target = (await this.neighborsOf(session.ref))[to];
    if (target === null || session.ref.kind !== 'tv') {
      throw new DirectStreamError('no_episode', to === 'next' ? 'There is no next episode to stream.' : 'There is no previous episode.');
    }
    const ref: StreamRef = { kind: 'tv', tmdbId: session.ref.tmdbId, season: target.season, episode: target.episode };
    const ask: PlayAsk = { at, via: 'episode', ref, asked: null };
    let next: StreamSession;
    try {
      next = await this.sessionFor(ref, null);
    } catch (err) {
      this.opts.playLog?.failed(ask, err);
      throw err;
    }
    this.opts.playLog?.answered(ask, next);
    this.log(
      `[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) ${
        next.torrent !== null ? `from the torrent ${next.torrent.name}` : next.cache === null ? `from ${next.source.provider}` : `from the cache ${next.cache.id}`
      }`,
    );
    return this.sessionInfo(next);
  }
```

7i. `continueSession` — replace the three lines that start the run (:1805-1808):
```ts
      run = this.sessionAgain(ref, from).finally(() => {
        this.continuing.delete(key);
        if (this.inFlight.get(flightKey) === entry) this.inFlight.delete(flightKey);
      });
```
with (one row per new session, however many asks join it):
```ts
      const ask: PlayAsk = { at: entry.since, via: 'continue', ref, asked: null };
      run = this.sessionAgain(ref, from)
        .then(
          (made) => {
            this.opts.playLog?.answered(ask, made);
            return made;
          },
          (err: unknown) => {
            this.opts.playLog?.failed(ask, err);
            throw err;
          },
        )
        .finally(() => {
          this.continuing.delete(key);
          if (this.inFlight.get(flightKey) === entry) this.inFlight.delete(flightKey);
        });
```

7j. `DirectStreamWiring` (:2528, after `warp?: WarpSwitch | null;`):
```ts
  /** This host's play log (playLog/log.ts); null or unset logs nothing. */
  playLog?: PlayLogSink | null;
```
and in `buildDirectStreamService` (:2567, after `siteFallback: wiring.siteFallback ?? null,`):
```ts
    playLog: wiring.playLog ?? null,
```
**Impact:** no behaviour of a play changes: every new call is a void call into a log that catches everything.
`resolve()`'s own sessions (subtitleText, the canary's probes) are never logged, because only `begin`,
`playCache`, `continueSession` and `switchEpisode` call `answered`. `several_matches` and nameless plays never
reach the service, so they stay unrecorded.

### Step 8: The position route feeds the log
**File:** `src/http/directStreamApi.ts`

8a. Imports (top): add
```ts
import type { PlayLogFeed } from '../directStream/playLog/log.js';
import type { PageStats } from '../directStream/playLog/types.js';
```

8b. `directStreamRoutes` signature (:89) adds `'playLog'` to the Partial Pick:
```ts
export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'movies' | 'streamLive' | 'titleSubtitles' | 'titleCues' | 'torrents' | 'streamPreviews' | 'playLog'>>): Hono {
```
and the position routes line (:259):
```ts
  r.route('/', streamPositionRoutes({ movies: deps.movies ?? null, directStream: deps.directStream, live: deps.streamLive ?? null, torrents: deps.torrents ?? null, previews: deps.streamPreviews ?? null, playLog: deps.playLog ?? null }));
```

8c. Replace `positionBody` (:282-294, with its comment) with:
```ts
/**
 * The player page's report: every 5 s while the page is open, on pause and at the end. `paused`
 * says the film is paused; `beat` marks a report sent only to say the paused page is still open;
 * `closed` is the page's last word as it closes; `stats` the page's counters since its load (readPageStats).
 * Unknown keys are dropped.
 */
const positionBody = z.object({
  position_s: z.number().finite().min(0).max(MAX_STREAM_SECONDS),
  duration_s: z.number().finite().positive().max(MAX_STREAM_SECONDS).nullable().optional(),
  ended: z.boolean().optional(),
  paused: z.boolean().optional(),
  beat: z.boolean().optional(),
  closed: z.boolean().optional(),
  stats: z.unknown().optional(),
});

/** Largest count or time (ms) one page load's counters may carry: 11.5 days, a sanity bound. */
const MAX_PAGE_STAT = 1_000_000_000;
const pageStat = z.number().finite().min(0).max(MAX_PAGE_STAT).transform((n) => Math.round(n));

/** The position report's `stats` key, as the player page sends it (STREAM_PLAY_LOG_PLAN's contract). */
export const pageStatsBody = z.object({
  load: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  first_frame_ms: pageStat.nullish(),
  played_ms: pageStat,
  stalls: pageStat,
  stalled_ms: pageStat,
  waits: pageStat,
  waited_ms: pageStat,
  errors: pageStat,
});

/** The page's counters, read once here; null when absent or not of the contract's shape (the report itself still counts). */
export function readPageStats(raw: unknown): PageStats | null {
  if (raw === undefined || raw === null) return null;
  const parsed = pageStatsBody.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  return { load: s.load, firstFrameMs: s.first_frame_ms ?? null, playedMs: s.played_ms, stalls: s.stalls, stalledMs: s.stalled_ms, waits: s.waits, waitedMs: s.waited_ms, errors: s.errors };
}
```

8d. `StreamPositionDeps` (:300-316): add after `torrents?: ...;`:
```ts
  /**
   * The play log (src/directStream/playLog/): every report's counters, how the play ended, and the session it took the
   * screen from. A paused page's beat for the stream on screen only reaches its memory. Null or absent: nothing is logged.
   */
  playLog?: PlayLogFeed | null;
```

8e. In `streamPositionRoutes`, insert after `service.reported?.(session.id, { paused: report.paused === true, over });` (:364) and before `// Seek previews: ...`:
```ts
    // The play log: the page's counters always reach memory; a paused page's beat for the stream on screen writes nothing.
    // `quiet` is the very condition of the early return below (live.has(id) is live.current()?.session_id === id), so
    // such a beat reaches only the session's StatsTally: PlayLog.report returns before it queues any write (R1.5).
    const playLog = deps.playLog ?? null;
    if (playLog !== null) {
      const quiet = live !== null && report.beat === true && report.paused === true && !over && live.has(session.id);
      const onScreen = live?.current()?.session_id ?? null;
      // Another session's page reports while that one is on screen: that play lost the screen.
      if (!over && onScreen !== null && onScreen !== session.id) playLog.replaced(onScreen);
      playLog.report(session.id, { stats: readPageStats(report.stats), over: report.ended === true ? 'finished' : report.closed === true ? 'closed' : null, quiet });
    }
```
Also add one sentence to the route's doc comment (:318-335), after "only keeps it there: the position did not move, so nothing is written.":
```ts
 * The play log hears every report first (its counters, `ended`/`closed`, the session it replaced on screen); it
 * writes in the background and never changes this answer.
```
**Impact:** the answer of every report is unchanged (same bodies, same codes). The play log is called before
the movie store, so a store failure (503) still feeds the log.

`replaced` and `MoviesRepo.recordStreamPosition` (reconciled): the play log's `replaced` is read from the stream on
screen (`StreamLive`) at the moment another session's page reports, never from `movie_plays`. Both are driven by
the same report: `recordStreamPosition` closes this host's other open `movie_plays` rows on that report, and the
log closes the row of the one session that was on screen. They never disagree about a play that comes back: a
`replaced` page that reports again reopens its log row (`PlayLog.report`, `t.ended = null`) just as its next report
opens a new `movie_plays` row. A play that was not on screen (its page gone without `closed`, or past
`STREAM_LIVE_TTL_MS`) is left open here and ends as `expired` when the store drops its session; `movie_plays` closing
it earlier is that table's own rule and is not mirrored. Nothing in this phase reads or changes `movie_plays`.

### Step 9: Daemon wiring
**File:** `src/deps.ts:148` (after `streamPreviews?: StreamPreviews | null;`), and an import beside the other directStream types:
```ts
import type { PlayLog } from './directStream/playLog/log.js';
```
```ts
  /**
   * This host's play log (src/directStream/playLog/): one stream_play_log row per stream play ask whose title is
   * known, the page's counters and how each play ended. Built with direct streaming; null or absent, nothing is logged.
   */
  playLog?: PlayLog | null;
```
**File:** `src/daemon.ts`
- Imports (after :69 `import { StreamReporter } from './directStream/report.js';`):
```ts
import { PlayLog } from './directStream/playLog/log.js';
import { PlayLogRepo } from './directStream/playLog/repo.js';
```
- After the `movieStreams` block (the `if (movieStreams !== null) { ... }` that ends at :231):
```ts
  // The play log (src/directStream/playLog/): one row per stream play ask on this host, written behind the play and
  // never failing it. Sessions live in memory, so the rows the previous run left open are closed as `restart`.
  const playLog = movies === null || config.directStream?.enabled !== true ? null : new PlayLog({ repo: new PlayLogRepo(db), host: movies.host });
  if (playLog !== null) {
    const closed = await playLog.closeLeftOpen();
    if (closed > 0) console.log(`[notesd] play log: closed ${closed} play(s) left open by the previous run (restart)`);
  }
```
- In the `buildDirectStreamService(config, db, { ... })` wiring (:415), after `warp,`:
```ts
    playLog,
```
- In `const deps: AppDeps = { ... }` (:540-565), after `streamEvidence,`:
```ts
    playLog,
```
**Impact:** the throwaway daemon and the live one log from their next start; nothing else reads `deps.playLog` yet (phase 3 reads through `PlayLogRepo`).

### Step 10: Test helper
**File:** `tests/helpers/memoryPlayLog.ts` (new)
**Code:**
```ts
import type { PlayLogInsert, PlayLogPatch, PlayLogWriter } from '../../src/directStream/playLog/repo.js';

export type MemoryPlayLogRow = PlayLogInsert & PlayLogPatch & { id: number; updatedAt: Date };

/** PlayLogRepo in memory: the rows, and how many writes reached it (one per insert, update or close). */
export class MemoryPlayLog implements PlayLogWriter {
  readonly rows: MemoryPlayLogRow[] = [];
  writes = 0;
  /** Set: every write throws it (the database is down). */
  failWith: Error | null = null;

  async insert(row: PlayLogInsert, now: Date): Promise<number> {
    this.reach();
    const made: MemoryPlayLogRow = { ...row, id: this.rows.length + 1, updatedAt: now };
    this.rows.push(made);
    return made.id;
  }

  async update(host: string, id: number, patch: PlayLogPatch, now: Date): Promise<void> {
    this.reach();
    const row = this.rows.find((r) => r.id === id && r.host === host);
    if (row !== undefined) Object.assign(row, patch, { updatedAt: now });
  }

  async closeLeftOpen(host: string, now: Date): Promise<number> {
    this.reach();
    const open = this.rows.filter((r) => r.host === host && r.session != null && (r.ended ?? null) === null);
    for (const r of open) Object.assign(r, { ended: 'restart', endedAt: now, updatedAt: now });
    return open.length;
  }

  bySession(session: string): MemoryPlayLogRow | undefined {
    return this.rows.find((r) => r.session === session);
  }

  private reach(): void {
    this.writes += 1;
    if (this.failWith !== null) throw this.failWith;
  }
}
```

### Step 11: Unit tests
**File:** `tests/unit/directStream/playLog/derive.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { askedOf, channelFailures, failureDetailOf, RELEASE_DATE_ATTEMPT, subtitleSourceOf } from '../../../../src/directStream/playLog/derive.js';
import { NOT_RELEASED } from '../../../../src/directStream/service.js';
import { SessionStore, type SessionTorrent } from '../../../../src/directStream/sessions.js';
import { DirectStreamError, type ResolveAttempt, type ResolvedSource } from '../../../../src/directStream/types.js';
import { siteAttemptName } from '../../../../src/streaming/fallback.js';

const a = (provider: string, outcome: ResolveAttempt['outcome']): ResolveAttempt => ({ provider, outcome, took_s: 1, detail: '' });
const fail = (code: 'no_source' | 'resolve_failed' | 'torrent_off', attempts: ResolveAttempt[]) => new DirectStreamError(code, 'nothing', { attempts });
const SOURCE: ResolvedSource = {
  provider: 'Alpha', embed_url: 'https://embed.example/e/1', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls',
  headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: 1080, en_subtitle: false, took_s: 1,
};

describe('how the ask named its source', () => {
  it('reads a magnet, a codename and a provider as the session lock does', () => {
    expect(askedOf(null, null)).toBeNull();
    expect(askedOf(null, 'magnet:?xt=urn:btih:abc')).toBe('torrent');
    expect(askedOf('Torrent', null)).toBe('torrent');
    expect(askedOf('cloud', null)).toBe('cloud');
    expect(askedOf('VidLink', null)).toBe('provider');
  });
});

describe('the word each channel of a failed ask ended with', () => {
  it('a cloud ask whose providers found nothing, the torrents not asked', () => {
    expect(channelFailures('cloud', fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'no_stream')]))).toEqual({ cloud: 'no_stream', torrent: null });
  });
  it('a bot check outranks nothing found, and a dub outranks nothing found', () => {
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'bot_check')])).cloud).toBe('bot_check');
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Beta', 'dubbed')])).cloud).toBe('dubbed');
  });
  it('indexes that listed nothing worth trying mean no torrent exists', () => {
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'no_stream'), a('Index: yts', 'resolved')]))).toEqual({ cloud: null, torrent: 'no_source' });
  });
  it('torrents tried and failed say how; indexes that all failed say error; an index behind a bot check says so', () => {
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'resolved'), a('Torrent: Film 2022 1080p', 'dubbed')])).torrent).toBe('dubbed');
    expect(channelFailures('torrent', fail('no_source', [a('Index: torrentio', 'error'), a('Index: yts', 'error')])).torrent).toBe('error');
    expect(channelFailures('torrent', fail('no_source', [a('Index: rutracker', 'bot_check'), a('Index: yts', 'no_stream')])).torrent).toBe('bot_check');
  });
  it('the long way: every cloud provider, then the torrents, each with its own word', () => {
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Index: torrentio', 'resolved'), a('Torrent: Film 2022 1080p', 'error'), a('WARP', 'error')]))).toEqual({ cloud: 'no_stream', torrent: 'error' });
  });
  it('a resolve that could not run, and torrents that are off, say so for the channel asked', () => {
    expect(channelFailures(null, fail('resolve_failed', []))).toEqual({ cloud: 'resolve_failed', torrent: null });
    expect(channelFailures('torrent', fail('torrent_off', []))).toEqual({ cloud: null, torrent: 'torrent_off' });
  });
  it('a title not out yet asked neither channel; subtitle tiers and streaming sites belong to neither', () => {
    expect(channelFailures(null, fail('no_source', [a(RELEASE_DATE_ATTEMPT, 'skipped')]))).toEqual({ cloud: null, torrent: null });
    expect(channelFailures(null, fail('no_source', [a('Alpha', 'no_stream'), a('Subtitles: Wyzie', 'resolved'), a(siteAttemptName('idlix'), 'no_stream')]))).toEqual({ cloud: 'no_stream', torrent: null });
  });
  it('keeps the attempt names it reads equal to the ones the service and the site fallback write', () => {
    expect(RELEASE_DATE_ATTEMPT).toBe(NOT_RELEASED);
    expect(siteAttemptName('idlix').startsWith('Site: ')).toBe(true);
  });
});

describe('a failure detail', () => {
  it('keeps no query, no fragment and no magnet, and at most 500 characters', () => {
    const detail = failureDetailOf(new Error(`could not open https://up.example/hls/a.m3u8?tok=SECRET#x nor magnet:?xt=urn:btih:abcdef&tr=udp://t ${'x'.repeat(900)}`));
    expect(detail).not.toContain('SECRET');
    expect(detail).not.toContain('xt=');
    expect(detail).toContain('https://up.example/hls/a.m3u8');
    expect(detail?.length).toBeLessThanOrEqual(500);
  });
});

describe('where the English subtitle comes from', () => {
  it('the stream, a subtitle from outside it, a torrent tier, or nothing', () => {
    const store = new SessionStore();
    const english = store.create({ kind: 'movie', tmdbId: 550 }, { ...SOURCE, subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }] }, []);
    expect(subtitleSourceOf(english)).toBe('stream');
    const none = store.create({ kind: 'movie', tmdbId: 550 }, SOURCE, []);
    expect(subtitleSourceOf(none)).toBeNull();
    none.outside.subtitles = [{ url: '/api/stream/subs/movie-550/outside.vtt', lang: 'en', label: 'English' }];
    expect(subtitleSourceOf(none)).toBe('outside');
    const torrent = store.create({ kind: 'movie', tmdbId: 550 }, { ...SOURCE, provider: 'Torrent' }, [a('Subtitles: Wyzie', 'resolved')]);
    torrent.torrent = { infoHash: 'a'.repeat(40), subtitles: [], height: 1080, index: 'torrentio', seeds: 16 } as unknown as SessionTorrent;
    expect(subtitleSourceOf(torrent)).toBe('Wyzie');
  });
});
```

**File:** `tests/unit/directStream/playLog/tally.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { StatsTally } from '../../../../src/directStream/playLog/tally.js';
import { PLAY_LOG_MAX_LOADS, type PageStats } from '../../../../src/directStream/playLog/types.js';

const s = (load: string, playedMs: number, extra: Partial<PageStats> = {}): PageStats => ({ load, firstFrameMs: null, playedMs, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0, ...extra });

describe('the page counters of one session', () => {
  it('count each load once, at its latest, and sum the loads', () => {
    const t = new StatsTally();
    t.add(s('loadAAAA', 10_000, { stalls: 1, stalledMs: 2_000, firstFrameMs: 1_200 }));
    t.add(s('loadAAAA', 20_000, { stalls: 2, stalledMs: 3_000, firstFrameMs: 1_200 }));
    t.add(s('loadBBBB', 5_000, { waits: 1, waitedMs: 4_000, errors: 1, firstFrameMs: 900 }));
    expect(t.totals()).toEqual({ playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1 });
    expect(t.firstFrameMs).toBe(1_200);
  });

  it('a late report of a load never lowers what that load said', () => {
    const t = new StatsTally();
    t.add(s('loadAAAA', 20_000, { stalls: 2 }));
    t.add(s('loadAAAA', 15_000, { stalls: 1 }));
    expect(t.totals()).toMatchObject({ playedMs: 20_000, stalls: 2 });
  });

  it('keeps the totals when loads past the limit are folded together', () => {
    const t = new StatsTally();
    for (let i = 0; i < PLAY_LOG_MAX_LOADS + 4; i += 1) t.add(s(`load${String(i).padStart(4, '0')}`, 1_000));
    expect(t.totals().playedMs).toBe((PLAY_LOG_MAX_LOADS + 4) * 1_000);
  });
});
```

**File:** `tests/unit/directStream/playLog/log.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { PlayLog } from '../../../../src/directStream/playLog/log.js';
import type { PageStats, PlayAsk } from '../../../../src/directStream/playLog/types.js';
import { SessionStore, type StreamSession } from '../../../../src/directStream/sessions.js';
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
});
```
Note on the failing-database test: the answered row's insert fails, so its `rowId` stays null and the closing
report's update is skipped (no second line); the order of the two lines is the order the writes were queued.

**File:** `tests/unit/directStream/playLogService.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { PlayLog } from '../../../src/directStream/playLog/log.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type DirectStreamHooks, type PlayResult } from '../../../src/directStream/service.js';
import { SESSION_IDLE_MS, SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { DirectStreamError } from '../../../src/directStream/types.js';
import { MemoryPlayLog } from '../../helpers/memoryPlayLog.js';

const FILM = { kind: 'movie' as const, tmdbId: 818647 };
const EPISODE = { kind: 'tv' as const, tmdbId: 1399, season: 1, episode: 1 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const MP4: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 800 }, audio: [{ codec: 'aac', lang: 'spa' }], subtitles: [], durationS: 6802, direct: true };
const RESOLVED = {
  ok: true,
  source: { provider: 'Alpha', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: 'nothing' }] };
const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash, name, fileName: null, fileIdx: null, seeds: 16, sizeBytes: 2_244_598_101, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name),
});

function setup(o: { resolve?: unknown; failOpen?: boolean; hooks?: DirectStreamHooks; failWrites?: boolean } = {}) {
  let now = Date.parse('2026-11-27T10:00:00.000Z');
  const clock = (): Date => new Date(now);
  const logged: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      if (o.failOpen === true) throw new Error('no metadata within 20 s');
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.mp4', name: 'Film.mp4', length: 2_244_598_101 }] };
    },
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = {
    candidates: [candidate(h(1), 'Through My Window 2022 1080p WEBRip')],
    indexes: [{ index: 'torrentio', outcome: 'ok', detail: '53 listed', took_s: 0.3, listed: 53 }],
    excluded: [],
    lastResort: [],
  };
  const torrent = new TorrentSource({ swarm, find: async () => answer, probe: async () => MP4, tiers: [], subtitleHeadMs: 5, localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const repo = new MemoryPlayLog();
  if (o.failWrites === true) repo.failWith = new Error('connect ECONNREFUSED 127.0.0.1:55437');
  const playLog = new PlayLog({ repo, host: 'host-a', now: clock, log: (line) => void logged.push(line) });
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => (args[0] === 'open' ? { ok: true } : (o.resolve ?? RESOLVED)),
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'es', imdbId: async () => 'tt11703710', titleLabel: async () => 'Through My Window (2022)', ...o.hooks },
    torrent: () => torrent,
    sessions: new SessionStore(clock),
    playLog,
    now: clock,
    log: (line) => void logged.push(line),
  });
  return { svc, repo, playLog, logged, advance: (ms: number) => void (now += ms) };
}

describe('the service writes the play log', () => {
  it('a cloud play answered: one row with the ask, the session, the channel, the provider and the height', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    await t.playLog.settled();
    expect(t.repo.rows).toEqual([
      expect.objectContaining({ via: 'play', kind: 'movie', tmdbId: 818647, asked: 'cloud', outcome: 'no_picture', session: played.session.session_id, channel: 'cloud', providerFirst: 'Alpha', height: 1080, resolveMs: 0 }),
    ]);
  });

  it('a torrent play answered: its info hash, the index that listed it, the seeds listed and the height', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'torrent' })) as PlayResult;
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ asked: 'torrent', channel: 'torrent', infoHash: h(1), torrentIndex: 'torrentio', seeds: 16, height: 800 });
  });

  it('a cloud play that found nothing: a failed row, the cloud word, the torrents not asked', async () => {
    const t = setup({ resolve: NO_SOURCE });
    await expect(t.svc.play(FILM, { provider: 'cloud' })).rejects.toBeInstanceOf(DirectStreamError);
    await t.playLog.settled();
    expect(t.repo.rows).toEqual([expect.objectContaining({ outcome: 'failed', failure: 'no_source', asked: 'cloud', cloudFailure: 'no_stream', torrentFailure: null })]);
  });

  it('a torrent play whose torrent did not open: a failed row with the torrent word and no cloud word', async () => {
    const t = setup({ failOpen: true });
    await expect(t.svc.play(FILM, { provider: 'torrent' })).rejects.toBeInstanceOf(DirectStreamError);
    await t.playLog.settled();
    const row = t.repo.rows[0];
    expect(row).toMatchObject({ outcome: 'failed', asked: 'torrent', cloudFailure: null });
    expect(row?.torrentFailure ?? null).not.toBeNull();
  });

  it('a page carrying on after a restart is a continue row; the next episode is an episode row', async () => {
    const t = setup({ hooks: { neighbors: async () => ({ prev: null, next: { season: 1, episode: 2 } }) } });
    const going = await t.svc.continueSession(FILM, { was: 'lost-session', provider: 'Alpha', positionS: 600 });
    const episode = (await t.svc.play(EPISODE, { provider: 'cloud' })) as PlayResult;
    const next = await t.svc.switchEpisode(episode.session.session_id, 'next');
    await t.playLog.settled();
    expect(t.repo.bySession(going.session.session_id)).toMatchObject({ via: 'continue', asked: null, providerFirst: 'Alpha' });
    expect(t.repo.bySession(next.session_id)).toMatchObject({ via: 'episode', kind: 'tv', season: 1, episode: 2 });
  });

  it('the owner asking for another source counts as an owner switch', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    expect((await t.svc.switchSource(played.session.session_id)).switched).toBe(true);
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ ownerSwitches: 1, autoSwitches: 0 });
  });

  it('a session the store drops is closed as expired', async () => {
    const t = setup();
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    t.advance(SESSION_IDLE_MS);
    expect(t.svc.session(played.session.session_id)).toBeNull();
    await t.playLog.settled();
    expect(t.repo.bySession(played.session.session_id)).toMatchObject({ ended: 'expired' });
  });

  it('a log whose database is down never fails, delays or changes the play', async () => {
    const t = setup({ failWrites: true });
    const played = (await t.svc.play(FILM, { provider: 'cloud' })) as PlayResult;
    expect(played.session.provider).toBe('Alpha');
    await t.playLog.settled();
    expect(t.logged.filter((l) => l.startsWith('[notesd] play log:'))).toEqual(['[notesd] play log: an answered play was not written: connect ECONNREFUSED 127.0.0.1:55437']);
  });
});
```
If `height: 800` in the torrent test fails because `SessionTorrent.height` is read from the release name (1080)
rather than the probe, assert the value `played.session` reports nowhere else — read it from the session:
`t.svc.peek(id)?.torrent?.height` — and keep the assertion equal to that (the row must carry the session's height).

**File:** `tests/unit/directStream/positionRoute.test.ts` — append to the `describe('the position route', ...)` block:
```ts
  it('feeds the play log: the page counters read once, how the play ended, and a quiet beat for the stream on screen', async () => {
    const heard: Array<{ id: string; page: unknown }> = [];
    const replaced: string[] = [];
    const playLog = { report: (id: string, page: unknown) => void heard.push({ id, page }), replaced: (id: string) => void replaced.push(id) };
    const live = { has: () => true, current: () => ({ session_id: SESSION.id, title_id: 'movie-550', duration: 7200 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION }, live, playLog: playLog as never }, { log: () => undefined }));
    const post = (body: unknown) => app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    const stats = { load: 'loadAAAA1', first_frame_ms: 1200.4, played_ms: 10000, stalls: 1, stalled_ms: 2000, waits: 0, waited_ms: 0, errors: 0 };
    await post({ position_s: 10, stats });
    await post({ position_s: 10, stats: { ...stats, load: 'x' } });
    await post({ position_s: 10, paused: true, beat: true, stats });
    await post({ position_s: 20, ended: true });
    await post({ position_s: 20, closed: true });
    expect(heard.map((h) => h.page)).toEqual([
      { stats: { load: 'loadAAAA1', firstFrameMs: 1200, playedMs: 10000, stalls: 1, stalledMs: 2000, waits: 0, waitedMs: 0, errors: 0 }, over: null, quiet: false },
      { stats: null, over: null, quiet: false },
      { stats: { load: 'loadAAAA1', firstFrameMs: 1200, playedMs: 10000, stalls: 1, stalledMs: 2000, waits: 0, waitedMs: 0, errors: 0 }, over: null, quiet: true },
      { stats: null, over: 'finished', quiet: false },
      { stats: null, over: 'closed', quiet: false },
    ]);
    expect(replaced).toEqual([]);
  });

  it('a report from another session while one is on screen tells the log that one was replaced', async () => {
    const replaced: string[] = [];
    const playLog = { report: () => undefined, replaced: (id: string) => void replaced.push(id) };
    const OTHER = 'O'.repeat(32);
    const live = { has: () => false, current: () => ({ session_id: OTHER, title_id: 'movie-550', duration: 7200 }), report: () => undefined, end: () => undefined } as unknown as StreamLive;
    const movies = { host: 'host-a', tmdb: null, events: { changed: () => undefined }, repo: { titleById: async () => { throw new Error('down'); } } } as unknown as MovieStreamsSource;
    const app = new Hono();
    app.route('/', streamPositionRoutes({ movies, directStream: { session: () => SESSION }, live, playLog: playLog as never }, { log: () => undefined }));
    const res = await app.request(`/api/stream/sessions/${SESSION.id}/position`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ position_s: 5 }) });
    expect(res.status).toBe(503);
    expect(replaced).toEqual([OTHER]);
  });
```
and add at the top of that file: `import type { StreamLive } from '../../../src/movies/streamLive.js';`.
(`playLog as never` keeps the fake to the two methods the route calls; the existing tests are untouched.)

### Step 12: Integration test of the writer and the table
**File:** `tests/integration/directStream.playLog.int.test.ts` (new)
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamPlayLog } from '../../src/db/schema.js';
import { PlayLogRepo } from '../../src/directStream/playLog/repo.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

let db: Db;

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
});

const AT = new Date('2026-11-27T10:00:00.000Z');
const base = { host: 'host-a', askedAt: AT, via: 'play' as const, kind: 'movie' as const, tmdbId: 550 };
const SID = 'S'.repeat(32);

describe('PlayLogRepo', () => {
  it('inserts a session row, updates it, and reads it back with every column', async () => {
    const repo = new PlayLogRepo(db);
    const id = await repo.insert({ ...base, asked: 'torrent', outcome: 'no_picture', resolveMs: 4_200, session: SID, channel: 'torrent', providerFirst: 'Torrent', providerLast: 'Torrent', infoHash: 'a'.repeat(40), torrentIndex: 'torrentio', seeds: 16, filmKbps: 5_100, height: 1080 }, AT);
    await repo.update('host-a', id, { outcome: 'played', firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1, autoSwitches: 1, ownerSwitches: 0, subtitleSource: 'Wyzie', ended: 'closed', endedAt: AT }, AT);
    await repo.update('host-b', id, { playedMs: 1 }, AT);
    expect(await repo.bySession('host-a', SID)).toMatchObject({ id, outcome: 'played', asked: 'torrent', resolveMs: 4_200, infoHash: 'a'.repeat(40), torrentIndex: 'torrentio', seeds: 16, height: 1080, firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, ended: 'closed', subtitleSource: 'Wyzie' });
    expect(await repo.bySession('host-b', SID)).toBeNull();
  });

  it('keeps a failed row with its word and the word of each channel', async () => {
    const repo = new PlayLogRepo(db);
    const id = await repo.insert({ ...base, outcome: 'failed', failure: 'no_source', failureDetail: 'No provider or torrent could stream it.', cloudFailure: 'no_stream', torrentFailure: 'no_source', resolveMs: 90_000 }, AT);
    const [row] = await db.select().from(streamPlayLog);
    expect(row).toMatchObject({ id, outcome: 'failed', failure: 'no_source', cloudFailure: 'no_stream', torrentFailure: 'no_source', session: null, ended: null });
  });

  it('closes only this host\'s open session rows as restart', async () => {
    const repo = new PlayLogRepo(db);
    await repo.insert({ ...base, outcome: 'played', session: SID, channel: 'cloud' }, AT);
    await repo.insert({ ...base, outcome: 'played', session: 'T'.repeat(32), channel: 'cloud', ended: 'closed', endedAt: AT }, AT);
    await repo.insert({ ...base, host: 'host-b', outcome: 'played', session: 'U'.repeat(32), channel: 'cloud' }, AT);
    await repo.insert({ ...base, outcome: 'failed', failure: 'no_source' }, AT);
    expect(await repo.closeLeftOpen('host-a', AT)).toBe(1);
    expect(await repo.bySession('host-a', SID)).toMatchObject({ ended: 'restart', endedAt: AT });
    expect(await repo.bySession('host-a', 'T'.repeat(32))).toMatchObject({ ended: 'closed' });
    expect(await repo.bySession('host-b', 'U'.repeat(32))).toMatchObject({ ended: null });
  });
});

describe('stream_play_log checks', () => {
  it('refuses a row that contradicts itself', async () => {
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'failed', failure: 'no_source', session: SID }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', cloudFailure: 'no_stream' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', ended: 'closed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'site', channel: 'cloud' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, season: 1, episode: 1, outcome: 'failed', failure: 'no_source' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', stalls: -1 }))).toBe('23514');
  });

  it('holds one row per session', async () => {
    await db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud' });
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'no_picture', session: SID, channel: 'cloud' }))).toBe('23505');
  });
});
```

### Step 13: The rule, the guide and the feature map
**File:** `CLAUDE.md:102` — in the **Single writers** bullet, replace
`` `TrendingRepo` writes `stream_trending`. `` with
`` `TrendingRepo` writes `stream_trending`; `PlayLogRepo` writes `stream_play_log`, only through `PlayLog` (`src/directStream/playLog/`), whose every write is caught and never fails, delays or changes a play. ``

**File:** `docs/guide/streaming.md` — insert before `### Direct streaming answers` (:985):
```markdown
### The play log

Each play this machine is asked for leaves one row in `stream_play_log`, when the title is known
(`several_matches` and a play with no title name nothing, so they leave none). The row is written
behind the play by `PlayLog` (`src/directStream/playLog/`), through `PlayLogRepo`, the table's only
writer. A write that fails is one line in the daemon's log, `[notesd] play log: ...`, and is dropped:
the log never fails, delays or changes a play.

What makes a row: a play (`via: play`: the tools, the play menu, `POST /api/stream/play`), a cache
played from the Cache page (`cache`), a page carrying its play on after a restart (`continue`), and
the player's previous and next buttons (`episode`).

- **Answered.** The row holds when the ask began, the title, how the source was named (`asked`:
  `provider`, `cloud`, `torrent`, or none), the session, the channel (`cloud`, `torrent`, `cache`),
  the provider, the milliseconds from ask to answer and the height that plays. A torrent adds its
  info hash, the index that listed it, the seeds it listed and the film's bitrate. The outcome is
  `no_picture` until the page first reports, then `played`. A `played` row is a play that worked,
  however short: most plays here are tests.
- **Failed.** No session was made: `failure` is the outcome word (`no_source`, `resolve_failed`,
  `open_failed`, `torrent_off`, ...), `failure_detail` its message with every query and magnet cut
  off, and `cloud_failure` and `torrent_failure` the word each channel ended with (`no_stream`,
  `bot_check`, `dubbed`, `no_source` when the indexes listed no torrent worth trying, `error`, ...;
  empty when that channel was not asked). Over time these say which titles no torrent, or no cloud
  source, can play.
- **A streaming site took it.** Outcome `site`, the site as the provider.

The player page adds its counters to every position report (`stats`: first-frame time, playing time,
stalls and stalled time, torrent waits and waited time, player errors, each since the page loaded,
with a random id of the load). The page measures them with `performance.now()`, never the wall
clock. A stall is one freeze the page's stall timer confirms (`STALL_MIN_MS`), however long it lasts,
timed from the moment the film stood still until it moves again; a pause, a seek's own wait within
the grace and the first load are not stalls, and a torrent's wait for a missing part (`waiting for
the torrent`) is a wait, never a stall. Playing time is only the time the film advanced. Errors are
the network errors the player rode out (one per episode of restarts) and the streams it declared
broken. A page load gets a new id when the page loads, and again when the same page moves to
another session (the episode buttons, a carry-on after a restart), so one id never spans two
sessions. The daemon keeps the latest of each page load and sums the loads, so a
reload adds to the play instead of starting it over. The row is written on the first report, then
at most every 30 s while the film plays, on a source switch and at the end. A paused page's `beat`
for the stream on screen writes nothing: its counters wait in memory for the next write.

A row is closed with how the play ended: `finished` (the film ended), `closed` (the page closed),
`replaced` (another play's page took the screen), `expired` (the session ended in memory), or
`restart` (the daemon started and found it open). A closed row whose page reports again is open
again. It also keeps the provider it ended on, the automatic and owner-asked source switches, the
refreshes, why the daemon last moved it, and where the English subtitle came from (the stream, the
cache, a subtitle from outside the stream, a torrent's subtitle tier, or none).
```
and add a row to the **Where the code is** table (after the `src/directStream/canary.ts` row):
```markdown
| `src/directStream/playLog/` | The play log: `PlayLog` (the counters per session in memory, the writes behind the play), `PlayLogRepo` (the only writer of `stream_play_log`), the failure words per channel (`derive.ts`) |
```

**File:** `docs/guide/architecture.md` (reconciled: the table's one-writer and data-model rows were unowned)
- One-writer table: after the row `` | `stream_trending` | `TrendingRepo` (`src/directStream/trending/repo.ts`) | `` (:74) add
```markdown
| `stream_play_log` | `PlayLogRepo` (`src/directStream/playLog/repo.ts`), only through `PlayLog`, whose writes never fail, delay or change a play |
```
- Data model, the `| Direct streaming | ... |` row (:98): in its Tables cell replace `` `stream_downloads`, `stream_trending` |`` with
  `` `stream_downloads`, `stream_trending`, `stream_play_log` |``, and append to its Notes cell, after
  "...or on the owner's stream cache.": ` The play log is one row per play ask on this host whose title is known: how it was answered or why it failed, the page's counters summed over page loads, and how it ended.`
Phase 5 adds its `reminders` rows to the same two tables later, after the `adversary_reviews` row and before the
`Settings` row; this phase touches neither of those lines.

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` — insert before `## Gotchas` (:821):
```markdown
## The play log (`stream_play_log`)
- One row per play ask whose title is known: answered (session, channel, provider, ask-to-answer time, a
  torrent's info hash, index, seeds and height), failed (`failure`, redacted `failure_detail`,
  `cloud_failure`, `torrent_failure`) or taken by a streaming site. The page's `stats` key on its position
  reports is summed over page loads; the row is written on the first report, every 30 s at most while it
  plays, and at the end; a paused beat for the stream on screen writes nothing. Closed as `finished`,
  `closed`, `replaced`, `expired` or `restart`. See `docs/guide/streaming.md` ("The play log").
- Rules: `npx vitest run tests/unit/directStream/playLog tests/unit/directStream/playLogService.test.ts tests/unit/directStream/positionRoute.test.ts`;
  the table and its writer: `npm run test:int -- tests/integration/directStream.playLog.int.test.ts`.
- On a `verify.sh up --direct-stream` run (no `--torrent`; about two minutes, `beat` waits 40 s and `restart`
  restarts the daemon): `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh RUN [ask|stats|failed|beat|replaced|restart ...]`.
  Each stage prints `PASS <stage>`; the run ends with `playlog: PASS`.
```
**File:** `.claude/skills/verify-notesd/features/README.md` — in the Direct streaming row, replace
`seek previews on the player's timeline |` with `seek previews on the player's timeline, the play log (`stream_play_log`) |`.

### Step 14: The Proof's driver
**File:** `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# playlog.sh RUN [ask|stats|failed|beat|replaced|restart ...]: the play log (stream_play_log, src/directStream/playLog/)
# on a `verify.sh up --direct-stream` run (without --torrent). Every stage drives the real daemon over HTTP as the
# player page does (the fake resolver answers; nothing of the owner's is reached) and reads the row back from the
# run's database, read-only. No stage named: all six, in order. Each stage that passes prints `PASS <stage>`; the
# first failed check stops it with `playlog: FAIL at <stage>`. `beat` takes about 45 s; `restart` restarts the daemon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: playlog.sh RUN [ask|stats|failed|beat|replaced|restart ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(ask stats failed beat replaced restart); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "playlog: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
STAGE=start
SID=""
PROVIDER=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "play log $STAGE: $*"; }
pass() { echo "PASS $STAGE"; }
fail() {
  echo "playlog: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "play log FAIL at $STAGE: $*" || true
  exit 1
}
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
post() { curl -sS -X POST -H 'content-type: application/json' -H "Origin: $URL" -d "$2" "$URL$1"; }
status() { curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: $URL" -d "$2" "$URL$1"; }
# until_row SQL WANT: the query reads WANT within 10 s (the log writes behind the answer), else FAIL.
until_row() {
  local got="" i
  for i in $(seq 1 20); do
    got="$(q "$1")"
    [ "$got" = "$2" ] && return 0
    sleep 0.5
  done
  fail "wanted [$2], read [$got] from: $1"
}
# play: film 550 through the fake resolver; sets SID and PROVIDER.
play() {
  local body
  printf 'hls\n' >"$DIRECT/mode"
  rm -f "$DIRECT/no_subtitle"
  body="$(post /api/stream/play '{"kind":"movie","tmdb_id":550}')"
  SID="$(jq -r '.session.session_id // empty' <<<"$body")"
  PROVIDER="$(jq -r '.session.provider // empty' <<<"$body")"
  [ -n "$SID" ] || fail "the film did not play: $body"
}
report() { status "/api/stream/sessions/$SID/position" "$1"; }
row() { echo "select $1 from stream_play_log where session = '$SID'"; }

stage_ask() {
  stage ask
  play
  until_row "$(row "via||'|'||kind||'|'||tmdb_id||'|'||coalesce(asked,'-')||'|'||outcome||'|'||channel||'|'||provider_first||'|'||(resolve_ms >= 0)::text||'|'||coalesce(ended,'-')")" "play|movie|550|-|no_picture|cloud|$PROVIDER|true|-"
  ok "the answered ask is one row: play, film 550, no source named, no_picture, cloud, $PROVIDER, its time to answer"
  pass
}

stage_stats() {
  stage stats
  play
  [ "$(report '{"position_s":10,"duration_s":600,"paused":false,"stats":{"load":"loadAAAA1","first_frame_ms":1200,"played_ms":10000,"stalls":1,"stalled_ms":2000,"waits":0,"waited_ms":0,"errors":0}}')" = 200 ] || fail "the first report was refused"
  until_row "$(row "outcome||'|'||first_frame_ms||'|'||played_ms||'|'||stalls")" "played|1200|10000|1"
  ok "the first report turned the row to played with the page's counters"
  # The page reloads (a new load id, counting from zero) and closes.
  [ "$(report '{"position_s":20,"duration_s":600,"closed":true,"stats":{"load":"loadBBBB2","first_frame_ms":900,"played_ms":5000,"stalls":2,"stalled_ms":3000,"waits":1,"waited_ms":4000,"errors":1}}')" = 200 ] || fail "the closing report was refused"
  until_row "$(row "first_frame_ms||'|'||played_ms||'|'||stalls||'|'||stalled_ms||'|'||waits||'|'||waited_ms||'|'||errors||'|'||ended||'|'||provider_last||'|'||auto_switches||'|'||owner_switches||'|'||coalesce(subtitle_source,'-')||'|'||(ended_at is not null)::text")" "1200|15000|3|5000|1|4000|1|closed|$PROVIDER|0|0|stream|true"
  ok "two page loads summed, the first frame of the first load kept, closed on $PROVIDER with the stream's English subtitle"
  pass
}

stage_failed() {
  stage failed
  printf 'no_source\n' >"$DIRECT/mode"
  [ "$(status /api/stream/play '{"kind":"movie","tmdb_id":550,"provider":"cloud"}')" = 502 ] || fail "a cloud play with no source did not answer 502"
  until_row "select outcome||'|'||failure||'|'||coalesce(cloud_failure,'-')||'|'||coalesce(torrent_failure,'-')||'|'||coalesce(asked,'-')||'|'||(session is null)::text||'|'||(failure_detail is not null)::text from stream_play_log where id = (select max(id) from stream_play_log)" "failed|no_source|no_stream|-|cloud|true|true"
  ok "a cloud ask that found nothing: failed, no_source, the cloud said no_stream, the torrents were not asked"
  printf 'no_chrome\n' >"$DIRECT/mode"
  [ "$(status /api/stream/play '{"kind":"movie","tmdb_id":550}')" = 502 ] || fail "a play with no Chrome did not answer 502"
  until_row "select outcome||'|'||failure||'|'||coalesce(cloud_failure,'-')||'|'||coalesce(torrent_failure,'-')||'|'||coalesce(asked,'-') from stream_play_log where id = (select max(id) from stream_play_log)" "failed|resolve_failed|resolve_failed|-|-"
  ok "an ask whose resolve could not run: failed, resolve_failed for the cloud, torrents off so not asked"
  printf 'hls\n' >"$DIRECT/mode"
  pass
}

stage_beat() {
  stage beat
  play
  local load='"load":"loadCCCC3","first_frame_ms":800,"stalls":0,"stalled_ms":0,"waits":0,"waited_ms":0,"errors":0' before i
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":false,\"stats\":{$load,\"played_ms\":5000}}" >/dev/null
  until_row "$(row "outcome||'|'||played_ms")" "played|5000"
  before="$(q "$(row "updated_at::text")")"
  # The pause itself, then a beat every 5 s past the 30 s write interval (the page stays the stream on screen).
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"stats\":{$load,\"played_ms\":5000}}" >/dev/null
  for i in $(seq 1 8); do
    sleep 5
    report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"beat\":true,\"stats\":{$load,\"played_ms\":9000}}" >/dev/null
  done
  sleep 1
  [ "$(q "$(row "played_ms||'|'||(updated_at::text = '$before')::text")")" = "5000|true" ] || fail "a paused beat wrote the row: $(q "$(row "played_ms||'|'||updated_at::text")") (was 5000|$before)"
  ok "eight paused beats over 40 s wrote nothing"
  report "{\"position_s\":5,\"duration_s\":600,\"paused\":true,\"stats\":{$load,\"played_ms\":9000}}" >/dev/null
  until_row "$(row "played_ms::text")" "9000"
  ok "the next report that is not a beat wrote what the beats carried"
  pass
}

stage_replaced() {
  stage replaced
  local first
  play
  first=$SID
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  play
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  until_row "select coalesce(ended,'-') from stream_play_log where session = '$first'" "replaced"
  until_row "$(row "coalesce(ended,'-')")" "-"
  ok "the play whose page took the screen left the other one replaced, and stays open itself"
  pass
}

stage_restart() {
  stage restart
  play
  report '{"position_s":5,"duration_s":600,"paused":false}' >/dev/null
  until_row "$(row "outcome||'|'||coalesce(ended,'-')")" "played|-"
  "$V" restart "$RUN" >/dev/null
  until_row "$(row "coalesce(ended,'-')||'|'||(ended_at is not null)::text")" "restart|true"
  until_row "select count(*) from stream_play_log where session is not null and ended is null" "0"
  ok "the daemon's start closed the open row as restart, and left no session row open"
  pass
}

for s in "${WANTED[@]}"; do
  case "$s" in
    ask | stats | failed | beat | replaced | restart) "stage_$s" ;;
    *) fail "unknown stage $s" ;;
  esac
done
STAGE=all
echo "playlog: PASS (${WANTED[*]})"
"$V" note "$RUN" "play log: PASS (${WANTED[*]})"
```
**Impact:** none on the daemon; it is the Proof's lever, rerunnable by a verifier.

## Principles applied

- Make illegal states unrepresentable: the table's CHECKs tie `failure` to `failed`, channel failure words and
  `failure_detail` to failed rows only, `session` to `no_picture`/`played`, `channel` to the outcome (`site` exactly
  for site rows), `ended` to `ended_at` and to session rows, and the slot shape to the kind — so a row that
  contradicts itself is refused by Postgres, not by code (Step 1, Step 12's check test).
- Boundary discipline: the page's `stats` is parsed and normalized once, in the route (`readPageStats`), into the
  typed `PageStats`; `PlayLog` trusts it. A `stats` that does not fit is dropped there and never fails the report
  (Step 8c).
- Laziness protocol: one `PlayLog` class with a per-session tally and a write chain instead of a timer or a
  background flusher; throttling is driven by the reports that already arrive every 5 s (Step 6). Switch counts
  live in the tally (`switched`) instead of a new session field, so `StreamSession` is not changed.
- Build the lever: `playlog.sh` drives all six end states against a throwaway daemon and prints `PASS <stage>`,
  so a verifier reruns it instead of reading the diff (Step 14).
- Test behavior, not implementation: the service and route tests assert the rows a `MemoryPlayLog` holds and the
  route's calls, not private state; the integration test asserts Postgres's own refusals (Steps 11-12).

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`); `npm run test:int`; `npm run docs:check`
**Proof:** the throwaway daemon writes and closes the rows a real play, a real page report, a failed ask and a
daemon restart cause, read back from its database.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`; `$V up --direct-stream` prints `RUN=<id>`)
- Feature-map entries: `features/direct-streaming.md` ("The play log", "A play carries on after the daemon restarts", the `journey.sh` seed/hls checks)
- Journeys:
  - **J1** · traces R1.1 — `$V up --direct-stream`, then `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh RUN ask` → passes when it prints `PASS ask` (the row reads `play|movie|550|-|no_picture|cloud|<the play answer's provider>|true|-`)
  - **J2** · traces R1.1 — `npx vitest run tests/unit/directStream/playLogService.test.ts -t "torrent play answered"` → passes when the test passes: the torrent play's row holds `channel: torrent`, its info hash, `torrentIndex: torrentio`, `seeds: 16` and the session's height
  - **J3** · traces R1.2 — `playlog.sh RUN failed` (same run) → passes when it prints `PASS failed` (rows `failed|no_source|no_stream|-|cloud|true|true` and `failed|resolve_failed|resolve_failed|-|-`)
  - **J4** · traces R1.3, R1.4 — `playlog.sh RUN stats` → passes when it prints `PASS stats` (after two page loads and a `closed` report the row reads `1200|15000|3|5000|1|4000|1|closed|<provider>|0|0|stream|true`)
  - **J5** · traces R1.5 — `playlog.sh RUN beat` → passes when it prints `PASS beat` (eight paused beats over 40 s leave `played_ms` 5000 and `updated_at` unchanged; the next non-beat report writes 9000)
  - **J6** · traces R1.4 — `playlog.sh RUN replaced restart` → passes when it prints `PASS replaced` and `PASS restart` (the first play's row `replaced`; after `$V restart RUN` the open row is `restart` with `ended_at` set and no session row is left open)
  - **J7** · traces R1.4 — `npx vitest run tests/unit/directStream/playLogService.test.ts -t "store drops"` and `npx vitest run tests/unit/directStream/playLog/log.test.ts` → passes when both pass (an idle session's row is `expired`; a page's `finished` survives a later expiry; switches counted as `auto`/`owner` with `provider_last` the provider it ended on)
- Neighbor check: the position route and stream plays must answer exactly as before — `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN seed hls` on a fresh `$V up --direct-stream` run prints `journey: PASS (seed hls)`, and `npx vitest run tests/unit/directStream/positionRoute.test.ts tests/unit/directStream/playInFlight.test.ts tests/unit/directStream/autoSwitch.test.ts tests/unit/directStream/continueSession.test.ts` and `npm run test:int -- tests/integration/movies.streams.int.test.ts` pass unchanged.
- Cost: none (no model call, no network outside loopback).
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` are green;
`playlog.sh RUN` on a fresh `$V up --direct-stream` run ends with `playlog: PASS (ask stats failed beat replaced restart)`;
`$V down RUN` afterwards.

## Handoffs

- **Phase 2 (R1.6):** the page sends `stats` exactly as the index's contract; this phase accepts fractional numbers
  (rounded) and a null or absent `first_frame_ms`, and drops a `stats` whose `load` is not 8-32 of `[A-Za-z0-9_-]`
  (the report still counts). A `stats` sent with a `beat` is kept in memory, so phase 2 may send it on every report.
  R1.6 is phase 2's to prove; nothing here traces it.
- **Phase 3 (R2):** reads `stream_play_log` through new read methods on `PlayLogRepo`
  (`src/directStream/playLog/repo.ts`); index `stream_play_log_host_asked_idx (host, asked_at)` is there for its
  period queries. `source` = `provider_first` for cloud/cache rows, `torrent_index` (`disk` when null) for torrent
  rows. Rows with `outcome = 'failed'` carry `cloud_failure`/`torrent_failure` for its `unhandled` list, and their
  `channel` is always null (`stream_play_log_channel_check`). The words this phase can write: `failure` is a
  `DirectStreamErrorCode` (`no_source`, `resolve_failed`, `open_failed`, `unknown_session`, `no_episode`,
  `no_subtitle`, `torrent_off`, `bad_info_hash`), a `CachePlayErrorCode` (`not_on_this_machine`, `cache_failed`,
  `cache_language`; `unknown_cache` is thrown before the ask is known and never logged) or `error`;
  `cloud_failure`/`torrent_failure` are a `ResolveOutcome` (`resolved` — a stream was found and the ask still
  failed — `no_stream`, `bot_check`, `error`, `dubbed`, `unplayable`, `skipped`, `skipped_browser_only`,
  `skipped_no_template`) or `no_source`, `resolve_failed`, `torrent_off`. Phase 3's `failureText` words each of them.
  `tests/helpers/memoryPlayLog.ts` exists if it wants a memory writer. Phase 3 must not write the table.
- **Phase 2 (reconciled):** phase 2 sends a 16-character `load` (inside 8-32), whole numbers, `first_frame_ms`
  null until the first frame, `stats` on every report kind (5 s, pause, `beat`, `ended`, `closed`), and a new `load`
  whenever the same page moves to another session (`goToEpisode`, `swapTo`). `StatsTally` keeps the latest (per-field
  max) of each `(session, load)` and sums over loads; successive reports of one load are never added. Phase 2 adds
  one bullet to `features/direct-streaming.md` at :55 (after the phase-5 `movie_stream_sources` bullet); this phase
  adds its section before `## Gotchas` (:821). The two run concurrently and touch different lines: on a merge,
  keep both.
- **Phase 5:** generates migration `0045` only after `0044_stream_play_log` is on the branch (both touch
  `drizzle/meta/_journal.json` and the snapshot chain). After this phase, phase 5 appends after the last line of
  `src/db/schema.ts` (which is now `export type NewStreamPlayLogRow = ...`), puts `reminders, ` before this phase's
  `stream_play_log, ` at the head of `truncateAll`, adds its imports after `./sessions/events.js` and its seed block
  after the import-merge block in `src/daemon.ts` (this phase's daemon lines are after :69, :231, :415 and :564),
  adds its `CLAUDE.md` bullet after the Claude Code integration bullet (this phase only rewrites the Single writers
  line), and its `architecture.md` rows after `adversary_reviews` and before `Settings` (this phase's rows are the
  `stream_play_log` writer row and the Direct streaming data-model row).
- **Not done here (by design):** flushing the ≤30 s of counters an open play holds in memory when the daemon
  stops; the row is closed as `restart` at the next start with what was last written. A follow-up could call a
  flush from `startBackground`'s stop.

## Rollback

Revert this phase's commit(s). The table is additive: with the code gone, `stream_play_log` is never written or
read. To remove it, add a follow-up migration `DROP TABLE "stream_play_log"` (never delete `0044` from `drizzle/`
once a daemon applied it). No existing row of any other table is changed by this phase.

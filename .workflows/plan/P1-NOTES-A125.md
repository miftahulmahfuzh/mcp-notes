> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-cache-and-bug-report/PLAN.md` phase 5. Source: `.workflows/plan/stream-cache-and-bug-report/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Stream cache: table, downloader, routes, tool

**Plan set:** `STREAM_CACHE_AND_BUG_REPORT_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Satisfies:** R1 — cache a film or an episode to this host's disk before or while it streams, per machine, with a clear route for the later per-episode button
**Criteria:** R1.1, R1.2, R1.3, R1.5, R1.6
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/directStream/cache`

---

## Goal

After this phase the daemon can download one rendition of a film or an episode to this host's disk
(`<dataDir>/movies/stream-cache/<cache id>/`), recorded in a new `stream_caches` table: the HLS
playlists rewritten to local files that list every segment up front, the segments, init sections,
AES-128 keys and the English subtitle as WebVTT, or a plain file by byte ranges. The download
retries with backoff, resolves the title again when the host refuses a token and carries on by
segment index, resumes from disk after a daemon restart, and can be cancelled and cleared. It is
started and read through `POST/GET/DELETE /api/stream/cache[/:id]`, served file by file (with
Range, fetching a missing segment at once) through `GET /api/stream/cache/:id/f/:name`, and driven
from Claude Code with the `direct_stream_cache` MCP tool. Playing from the cache is phase 6.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates:**
- Table `stream_caches` (`src/db/schema.ts`, migration `drizzle/0029_stream_caches.sql`), row type `StreamCacheRow`, constants `STREAM_CACHE_STATES` / `StreamCacheState` (`downloading | ready | failed`), `STREAM_CACHE_KINDS` / `StreamCacheKind` (`hls | mp4`).
  Columns: `id uuid pk default gen_random_uuid()`, `host`, `kind` (`movie|tv`), `tmdb_id`, `season` (0 for a film), `episode` (0 for a film), `max_height` (null = highest), `provider`, `manifest_kind` (`hls|mp4`, never `dash`), `height`, `audio_lang`, `subtitle bool`, `state`, `segments_total`, `segments_done`, `bytes bigint`, `duration_s real`, `resolves int`, `error`, `error_detail`, `created_at`, `updated_at`, `completed_at`. Unique `(kind, tmdb_id, season, episode, host)`: one live cache per title slot and host. CHECKs: film slot 0/0, `failed ⇔ error not null`, `ready ⇔ completed_at not null` and then `provider`, `manifest_kind` set and `segments_done = segments_total`.
- `DirectStreamRepo` methods (`src/directStream/repo.ts`), the only writer of `stream_caches`: `createCache(host, ref, maxHeight, now) -> {row, created}`, `cacheById(id)`, `cacheFor(host, ref)`, `cachesOf(ref)`, `caches()`, `unfinishedCaches(host)`, `cacheResolved(id, now)`, `cachePlanned(id, CachePlanned, now)`, `cacheProgress(id, done, bytes, now)`, `cacheSubtitle(id, saved, now)`, `cacheReady(id, {segments, bytes, subtitle}, now)`, `cacheFailed(id, error, detail, now)`, `cacheRestarted(id, now)`, `deleteCache(id) -> boolean`; helpers `cacheSlot(ref)`, `cacheRef(row)`; type `CachePlanned`.
- `src/directStream/cache/types.ts`: `STREAM_CACHE_SUBDIR` (`movies/stream-cache`), `CACHE_ID_PATTERN`, `StreamCacheView`, `CacheError` (`unknown_cache | not_on_this_machine | cache_exists`), `CacheFailure` + `CacheFailureCode` (`cache_unsupported | no_source | resolve_failed | download_failed | token_refused | source_changed | disk_error`).
- `src/directStream/cache/hls.ts`: `parseAttributes`, `isPlaylist`, `isMaster`, `parseMaster`, `parseMedia`, `pickVariant`, `pickAudio`, `segmentExt`, `segmentName`, `initName`, `keyName`, `localMediaPlaylist`, `localMaster`, `HlsUnsupported`, types `HlsVariant`, `HlsRendition`, `HlsMaster`, `HlsMedia`, `HlsSegment`, `HlsKey`, `HlsMap`, `ByteRange`, `TrackPrefix`, `AudioWanted`.
- `src/directStream/cache/plan.ts`: `CachePlan`, `CacheFile`, `hlsPlan`, `mp4Plan`, `chunkName`, `MP4_CHUNK_BYTES`.
- `src/directStream/cache/upstream.ts`: `fetchUpstream`, `Fetched`, `SEGMENT_MAX_BYTES`, `BODY_TIMEOUT_MS`.
- `src/directStream/cache/store.ts`: `CacheStore`, `SERVED_NAME`, `META_FILE`, `CacheMeta`.
- `src/directStream/cache/serve.ts`: `parseRange`, `contentTypeOf`, `fileResponse`.
- `src/directStream/cache/subtitle.ts`: `englishSubtitle`, `joinVtt`.
- `src/directStream/cache/job.ts`: `CacheJob` (`run`, `cancel`, `fetchNow`, `mp4Answer`, `progress`), `CacheJobDeps`, `CacheRecorder`, `JobOutcome`, `JobProgress`, `backoffMs`, `CACHE_PARALLEL` (4), `SEGMENT_ATTEMPTS` (6), `MAX_REFRESHES` (3), `MAX_RESTARTS` (2), `PROGRESS_FLUSH_MS` (2000).
- `src/directStream/cache/service.ts`: `StreamCache`, `StreamCacheOptions`, `buildStreamCache`, `abortableSleep`, `CACHE_JOBS` (1), `CachePlayData`. **`StreamCache` methods:** `host`, `root`, `start(): Promise<number>` (queue this host's unfinished downloads), `close()`, `request(ref, {maxHeight}) -> {cache: StreamCacheView, started}` (throws `CacheError('cache_exists')`), `list()`, `get(id)`, `find(ref)` (this host, any state, `StreamCacheView | null`), `findReady(ref)` (this host, `ready` only), `forRef(ref)` (every host), `remove(id)` (throws `unknown_cache` / `not_on_this_machine`), `file(id, name, {range}) -> Response`, `player() -> { find(ref), get(id) }` answering `CachePlayData` (phase 6's `CachePlayView` shape).
- `AppDeps.streamCache?: StreamCache | null` (`src/deps.ts`).
- `DirectStreamConfig.cacheDir?: string | null` from `NOTESD_STREAM_CACHE_DIR` (`src/config.ts`).
- Routes (`src/http/streamCacheApi.ts`, `streamCacheRoutes`):
  - `POST /api/stream/cache` (same-origin) `{kind, tmdb_id, season?, episode?, max_height?}` → 202 `{ok: true, started: true, cache}` when a download was queued, 200 `{ok: true, started: false, cache}` when it already runs or is `ready`; 409 `{error: "cache_exists", message, cache}` for another `max_height`; 400 `invalid_json` / `invalid_body`.
  - `GET /api/stream/cache` → `{host, caches: StreamCacheView[]}` (both hosts, newest first).
  - `GET /api/stream/cache/:id` → `StreamCacheView`; 404 `unknown_cache`.
  - `DELETE /api/stream/cache/:id` (same-origin) → `{ok: true, id}`; 404 `unknown_cache`; 404 `{error: "not_on_this_machine", host}`.
  - `GET /api/stream/cache/:id/f/:name` → the file from disk, Range honoured (206 / 416); a file not on disk yet while `downloading` is fetched now (ahead of the queue) and stored; 404 `unknown_cache`, 404 `{error: "not_on_this_machine", host}`, 404 `not_found`, 409 `cache_failed`, 502 `upstream_error`.
    - **Phase 6 relies on two behaviours of this route (reconciled; `StreamCache.file`, Step 12):** (1) a `downloading` row whose download is not running in this daemon process (queued, or left by an earlier run before `start()` picked it up) gets one started at once (`launchNow`) and the file is fetched through it; (2) the route never forwards a stream host's status: an on-demand fetch that the host refuses and that a fresh resolve cannot cure (`token_refused` after `MAX_REFRESHES`, `resolve_failed`, `no_source`, or any other failure) answers **502 `upstream_error`**, a plain `jsonError` without `X-Notesd-Upstream`, never a 401/403/410. A forwarded refusal would make the player page refresh, which for a cached session only re-reads the cache; phase 2's network recovery retries a 502.
- **`StreamCacheView`** (the JSON every route and the tool answer): `{id, kind, tmdb_id, season (null for a film), episode (null for a film), host, available (host is this machine), state, running, queued, provider, manifest_kind, height, max_height, audio_lang, subtitle, segments_total, segments_done, progress (0..1), bytes, duration_s, resolves, error, error_detail, playlist_url, subtitle_url, created_at, updated_at, completed_at}`; `playlist_url` is `/api/stream/cache/<id>/f/master.m3u8` (HLS) or `/api/stream/cache/<id>/f/video.mp4` (plain file), null on the other host or before the source is known; `subtitle_url` is `/api/stream/cache/<id>/f/subtitle.vtt` or null.
- **File layout under `<cache root>/<cache id>/`** (served names; anything else is never served): `master.m3u8` (always for HLS: one `EXT-X-STREAM-INF` → `video.m3u8`, plus one `EXT-X-MEDIA TYPE=AUDIO … URI="audio.m3u8"` when the audio is a separate rendition), `video.m3u8`, `audio.m3u8`, `v-init-<k>.mp4` / `a-init-<k>.mp4` (EXT-X-MAP), `v-key-<k>.key` / `a-key-<k>.key` (AES-128), `v-00001.ts|m4s|aac` … / `a-00001.…` (1-based position in the media playlist, at least 5 digits), `subtitle.vtt`, `video.mp4` (plain file, joined when complete). Not served: `cache.json` (version, signature of the source's shape, provider, kind — no address), `c-00001.bin` … (plain-file chunks while downloading), `*.part` (writes in progress).
- **Playlist address form:** the local playlists name files relatively (`v-00042.ts`, `audio.m3u8`, `v-key-1.key`), so they resolve under `/api/stream/cache/<id>/f/`. They are written in full before the first segment is fetched: every segment by index, `#EXT-X-PLAYLIST-TYPE:VOD`, `#EXT-X-ENDLIST`, the source's `EXT-X-MEDIA-SEQUENCE` (an AES-128 key without IV takes the sequence number as IV), `EXT-X-DISCONTINUITY(-SEQUENCE)`, `EXT-X-PROGRAM-DATE-TIME`, `EXT-X-GAP`, keys with their IV and KEYFORMAT, no `EXT-X-BYTERANGE` (each range is its own file).
- MCP tool `direct_stream_cache` (`src/mcp/streamCacheTools.ts`: `registerStreamCacheTool`, `streamCacheToolDeps`, `StreamCacheApi`, `StreamCacheToolDeps`), arguments `{action: start|status|list|clear, title?, year?, kind?, season?, episode?, absolute_episode?, max_height?, id?}`; `ToolDeps.streamCache`. Constant `STREAM_CACHE_TOOL_NAMES` (`src/chat/status.ts`), deliberately **not** in `allowedChatTools()`.
- Fixture additions (opt-in by state file, nothing existing changes): `tests/fixtures/direct-stream/upstream.mjs` serves a tokened HLS film under `/tok/t<N>/` (state files `token`, `token_uses`, `fail_once`, `delay_ms`); `fake-cli.mjs` mode `hls_token`.
- `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh` (stages `start tool refused other clear`).

**Signature changes:**
- `src/mcp/directStreamTools.ts`: `label`, `candidateView`, `targetFor`, `chooseEpisode`, `chooseAbsolute` gain `export` (bodies unchanged).
- `ToolDeps` gains `streamCache?: StreamCacheToolDeps | null`.

**Requires (from earlier phases):** Phase 1 has landed (it edits `passThrough.ts` and `service.passThrough`; this phase only imports `upstreamHeaders`, `jsonError`, `FetchLike`, `PLAYLIST_MAX_BYTES`, `UPSTREAM_HEADERS_TIMEOUT_MS`, `MAX_REDIRECTS` from `passThrough.ts`, which phase 1 keeps exported with the same signatures). Nothing of `StreamEvidence` is used (see Handoffs).

**Leaves alone (owned by others):** `DirectStreamService.play` / `resolve` / `refresh` behaviour (phase 6; this phase only calls the public `resolve`), `src/directStream/sessions.ts` (phase 6), `src/directStream/evidence.ts`, `passThrough.ts` (phase 1), `web/` entirely (phases 2, 4, 6), the Movies page, `claude/skills/direct-stream/SKILL.md`, `PLAY_DESCRIPTION` and the play tool's `next` texts (phase 6), `src/mcp/instructions.ts` and `src/chat/prompt.ts` (see Handoffs), `claude/skills/report-stream-bug/` (phase 3), `src/directStream/report.ts` (phase 4).

## Which HLS sources are cached

| Source | Cached? | How |
|---|---|---|
| Master playlist | yes | the variant with the tallest `RESOLUTION` height, or the tallest not above `max_height` (none at or under it: the shortest one); variants without `RESOLUTION` rank by `BANDWIDTH` after those with one |
| Media playlist only (no master) | yes | used as is; `height` = the resolver's `best_height`; `max_height` cannot choose |
| VidNest's `master.txt` (an HLS master served as text) | yes | a playlist is recognised by `#EXTM3U`, never by its name or content type; relative addresses resolve against the final (post-redirect) address |
| Relative, root-relative and absolute addresses | yes | `absoluteHttp(ref, playlist address)`, the same rule as `rewrite.ts`; every address a fetched playlist names joins the session's hosts (`learn`), never one it did not name |
| Separate audio renditions (`EXT-X-MEDIA TYPE=AUDIO`, `AUDIO="g"`) | yes, one | the rendition the player would pick: `source.audio.track` (same LANGUAGE and NAME, else same LANGUAGE; a track without language by NAME), else the title's original language (`session.audioLang`, primary subtag), else `DEFAULT=YES`, else the first; downloaded as `audio.m3u8` + `a-*`; a rendition without `URI` means the audio is muxed: no audio playlist |
| `EXT-X-BYTERANGE` segments (with or without `@offset`) | yes | each range is fetched with `Range` and stored as its own file; a host that answers 200 is read up to the range's end and sliced |
| fMP4 init (`EXT-X-MAP`, with or without `BYTERANGE`) | yes | `v-init-<k>.mp4`, re-emitted where it changes |
| `EXT-X-KEY METHOD=AES-128` (KEYFORMAT absent or `identity`), with or without `IV` | yes | the key file is downloaded (`v-key-<k>.key`); `IV`, `KEYFORMAT`, `KEYFORMATVERSIONS` and `EXT-X-MEDIA-SEQUENCE` are kept; a `data:` key URI is kept inline; `METHOD=NONE` switches it off again |
| `EXT-X-DISCONTINUITY`, `EXT-X-DISCONTINUITY-SEQUENCE`, `EXT-X-PROGRAM-DATE-TIME`, `EXT-X-INDEPENDENT-SEGMENTS`, `EXT-X-START` | yes | copied |
| `EXT-X-GAP` segment | yes | listed with its tag, not downloaded, counted done |
| `SAMPLE-AES`, `SAMPLE-AES-CTR`, any other `KEYFORMAT` (FairPlay, Widevine), a non-http key URI | **no** | `cache_unsupported` ("drm") |
| No `EXT-X-ENDLIST` (live or event) | **no** | `cache_unsupported` ("live") |
| DASH (`manifest_kind: dash`) | **no** | `cache_unsupported`, nothing fetched |
| Plain file (`manifest_kind: mp4`) whose host answers byte ranges | yes | 4 MiB chunks `c-*.bin` by `Range`, joined into `video.mp4` at the end |
| Plain file whose host ignores `Range` | **no** | `cache_unsupported` |
| Subtitles inside the master (`TYPE=SUBTITLES`) | not as a rendition | the English track (separate file first, then the manifest's HLS subtitle playlist, whose WebVTT segments are joined under one header) is saved as `subtitle.vtt`; none English: `subtitle: false`, never a failure |

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | `uuid` import (`:23`), header comment (`:65`), `STREAM_CACHE_*` constants and `streamCaches` after `streamProbeTitles` (`:1466`), `StreamCacheRow` (`:1509`) |
| `drizzle/0029_stream_caches.sql`, `drizzle/meta/0029_snapshot.json`, `drizzle/meta/_journal.json` | generate | `npx drizzle-kit generate --name stream_caches` |
| `src/directStream/repo.ts` | modify | imports (`:2`, `:5`), `cacheSlot`/`cacheRef`/`CachePlanned` (after `:171`), class comment (`:182`), cache methods (before `:338`) |
| `src/directStream/cache/types.ts` | create | shared types, errors, constants |
| `src/directStream/cache/hls.ts` | create | HLS parsing, choice, local playlists |
| `src/directStream/cache/plan.ts` | create | the file list a source becomes |
| `src/directStream/cache/upstream.ts` | create | one GET with the session's headers |
| `src/directStream/cache/store.ts` | create | the cache folder on disk |
| `src/directStream/cache/serve.ts` | create | Range answers from disk |
| `src/directStream/cache/subtitle.ts` | create | the English subtitle as WebVTT |
| `src/directStream/cache/job.ts` | create | one download |
| `src/directStream/cache/service.ts` | create | `StreamCache`, queue, views, file route logic, `buildStreamCache` |
| `src/http/streamCacheApi.ts` | create | the five routes |
| `src/mcp/streamCacheTools.ts` | create | `direct_stream_cache` |
| `src/mcp/directStreamTools.ts` | modify | `export` on five helpers (`:293`, `:297`, `:312`, `:355`, `:374`) |
| `src/mcp/tools.ts` | modify | `ToolDeps.streamCache` (`:16`, `:45`) |
| `src/mcp/server.ts` | modify | register the tool (`:11`, `:36`) |
| `src/chat/status.ts` | modify | `STREAM_CACHE_TOOL_NAMES` (after `:110`) |
| `src/http/app.ts` | modify | tool deps (`:89`), mount routes (`:138`), imports |
| `src/deps.ts` | modify | `AppDeps.streamCache` (after `:59`) |
| `src/daemon.ts` | modify | build the cache (after `:192`), deps (`:219`), imports |
| `src/background.ts` | modify | resume on start, close on stop (`:186`, `:209`) |
| `src/config.ts` | modify | `cacheDir` (`:197`–`:223`, `:685`, `:738`) |
| `tests/integration/setup.ts` | modify | truncate `stream_caches` (`:50`) |
| `tests/fixtures/direct-stream/upstream.mjs` | modify | tokened HLS film |
| `tests/fixtures/direct-stream/fake-cli.mjs` | modify | mode `hls_token` |
| `tests/unit/directStream/cache/hls.test.ts` | create | parsers and writers |
| `tests/unit/directStream/cache/job.test.ts` | create | the downloader against a fake stream host |
| `tests/unit/directStream/cache/serve.test.ts` | create | Range answers |
| `tests/unit/mcp.streamCacheTools.test.ts` | create | the tool |
| `tests/unit/config.streamCache.test.ts` | create | `NOTESD_STREAM_CACHE_DIR` |
| `tests/unit/chat-status.test.ts` | modify | the tool stays out of the chat bar (after `:55`) |
| `tests/integration/directStream.cache.int.test.ts` | create | repo, routes, both hosts, delete, restart |
| `scripts/docs/httpRoutes.ts` | modify | five route entries (after `:237`) |
| `docs/guide/reference/http-api.md`, `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md` | modify | `NOTESD_STREAM_CACHE_DIR` row (after the `NOTESD_STREAM_PROBE_MS` row) |
| `docs/guide/streaming.md` | modify | "### Caching a film or an episode" (before `### The prober`, `:729`), code table rows |
| `docs/guide/architecture.md` | modify | writer row (`:70`), data row (`:94`), disk line (`:118`), background row (`:217`) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | "## Stream cache" entry (before `## Gotchas`, `:218`) |
| `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh` | create | the HTTP and MCP journeys |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | pin `NOTESD_STREAM_CACHE_DIR` (`:205`) |
| `.claude/skills/verify-notesd/SKILL.md` | modify | the `hls_token` mode (`:56`) |

## Implementation Steps

Before anything: the worktree has no `node_modules`. Run `npm ci` in
`/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report` first.

**Shared files (reconciled).** Phase 1 has landed before this phase; every quoted line of
`src/deps.ts`, `src/daemon.ts` and `src/http/app.ts` is matched by its text as phase 1 left it
(phase 1 added `streamEvidence` to `AppDeps`, the `streamLive` / `streamEvidence` consts and
`evidence: streamEvidence,` in `src/daemon.ts`, and `streamEvidenceRoutes` in `app.ts`; keep them).
This phase runs beside phases 2 and 3, and beside phase 4 (which follows phases 1 and 2); every edit to
a file one of them also edits is additive and anchored by the quoted text, never by line number:
`src/deps.ts`, `src/daemon.ts`, `src/http/app.ts` (phase 4 adds `streamReporter` / `streamReportRoutes`
next to phase 1's lines), `scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md`,
`docs/guide/architecture.md` (phase 3 edits the skills line), `.claude/skills/verify-notesd/SKILL.md`,
`.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3 also inserts a section before
`## Gotchas`) and `.claude/skills/verify-notesd/scripts/verify.sh` (phase 4 adds `NOTESD_TMUX_BIN` and
`NOTESD_FAKE_TMUX_DIR` to the same `env=(...)` array and a `TMUX_FAKE=` line). Whichever lands second
inserts beside the other's lines and keeps them. The generated `docs/guide/reference/http-api.md` and
`mcp-tools.md` are never merged by hand: after any merge, run `npm run docs:gen`.

Steps 1–2 end with `npm run typecheck` and the migration; steps 3–9 with `npx vitest run tests/unit/directStream/cache`; steps 10–16 with `npm test`; steps 17–19 with `npm run test:int`; steps 20–25 with `npm run docs:check` and the Proof.

### Step 1: The `stream_caches` table
**File:** `src/db/schema.ts:23`, `:65`, `:1466`, `:1509`
**Change:** add `uuid` to the `drizzle-orm/pg-core` import list (between `uniqueIndex,` and `vector,`); extend the header comment; add the table after `streamProbeTitles`; add the row type at the end. Then generate the migration.
**Code:**

Import list (line 23–24 become):
```ts
  uniqueIndex,
  uuid,
  vector,
```

Header comment: after the line ` * (\`DirectStreamRepo\`) is their only writer.` (`:65`) insert:
```ts
 * Migration 0029 (stream cache) adds `stream_caches`: one film or episode downloaded to one host's
 * disk (src/directStream/cache/). `DirectStreamRepo` is its only writer too; its files live only on
 * the host the row names.
```

After the closing `)` of `streamProbeTitles` (before `export type NoteRow`):
```ts
/** What a stream cache is doing (src/directStream/cache/). The CHECK below keeps the same list. */
export const STREAM_CACHE_STATES = ['downloading', 'ready', 'failed'] as const
export type StreamCacheState = (typeof STREAM_CACHE_STATES)[number]
/** What a cache holds: one HLS rendition, or one plain file. DASH is never cached (cache_unsupported). */
export const STREAM_CACHE_KINDS = ['hls', 'mp4'] as const
export type StreamCacheKind = (typeof STREAM_CACHE_KINDS)[number]

/**
 * One film or episode downloaded to one host's disk for playing without the stream host (migration
 * 0029). Written only by DirectStreamRepo (src/directStream/repo.ts). The files live in that host's
 * cache folder (`<dataDir>/movies/stream-cache/<id>/`), so the other machine lists the row with
 * `available: false`. One row per title slot and host; a film is season 0, episode 0, as in
 * movie_stream_sources. A row is deleted with its files (DELETE /api/stream/cache/:id) and by
 * nothing else. `error` is set exactly when the cache failed; `completed_at` exactly when it is ready.
 */
export const streamCaches = pgTable(
  'stream_caches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    host: text('host').notNull(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    season: integer('season').notNull().default(0),
    episode: integer('episode').notNull().default(0),
    /** The tallest rendition asked for; null: the tallest there is. */
    maxHeight: integer('max_height'),
    provider: text('provider'),
    manifestKind: text('manifest_kind').$type<StreamCacheKind>(),
    /** The cached rendition's height (its RESOLUTION, else the resolver's best_height); null when unknown. */
    height: integer('height'),
    /** The cached audio's language: the audio rendition's LANGUAGE, else the title's original language. */
    audioLang: text('audio_lang'),
    subtitle: boolean('subtitle').notNull().default(false),
    state: text('state').$type<StreamCacheState>().notNull().default('downloading'),
    segmentsTotal: integer('segments_total').notNull().default(0),
    segmentsDone: integer('segments_done').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    durationS: real('duration_s'),
    /** Resolves this cache made: the first, and one more each time the host refused a token. */
    resolves: integer('resolves').notNull().default(0),
    error: text('error'),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('stream_caches_slot_host_idx').on(t.kind, t.tmdbId, t.season, t.episode, t.host),
    index('stream_caches_host_state_idx').on(t.host, t.state),
    check('stream_caches_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check(
      'stream_caches_slot_check',
      sql`${t.tmdbId} > 0 and ((${t.kind} = 'movie' and ${t.season} = 0 and ${t.episode} = 0) or (${t.kind} = 'tv' and ${t.season} >= 0 and ${t.episode} > 0))`,
    ),
    check('stream_caches_state_check', sql`${t.state} in ('downloading', 'ready', 'failed')`),
    check('stream_caches_manifest_kind_check', sql`${t.manifestKind} is null or ${t.manifestKind} in ('hls', 'mp4')`),
    check(
      'stream_caches_counts_check',
      sql`${t.segmentsDone} >= 0 and ${t.segmentsDone} <= ${t.segmentsTotal} and ${t.bytes} >= 0 and ${t.resolves} >= 0`,
    ),
    check('stream_caches_max_height_check', sql`${t.maxHeight} is null or ${t.maxHeight} > 0`),
    check('stream_caches_failed_check', sql`(${t.state} = 'failed') = (${t.error} is not null)`),
    check(
      'stream_caches_ready_check',
      sql`(${t.state} = 'ready') = (${t.completedAt} is not null) and (${t.state} <> 'ready' or (${t.provider} is not null and ${t.manifestKind} is not null and ${t.segmentsDone} = ${t.segmentsTotal}))`,
    ),
  ],
)
```

At the end of the file, after `export type StreamProbeTitleRow = ...`:
```ts
export type StreamCacheRow = typeof streamCaches.$inferSelect
```

Then run, from the worktree root:
```sh
npx drizzle-kit generate --name stream_caches
```
It writes `drizzle/0029_stream_caches.sql` (a `CREATE TABLE "stream_caches"` with the ten CHECKs, `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL`, the unique index and the host/state index), `drizzle/meta/0029_snapshot.json` and a journal entry. Do not hand-edit them; if the SQL lacks a CHECK, fix `schema.ts` and regenerate.
**Impact:** a new table only. `gen_random_uuid()` is built into Postgres 13+ (Neon and the pgvector test images).

### Step 2: `DirectStreamRepo` writes `stream_caches`
**File:** `src/directStream/repo.ts:2`, `:5`, after `:171`, `:182`, before `:338`
**Change:** imports; helpers; class comment; methods.
**Code:**

Line 2 becomes:
```ts
import { and, asc, desc, eq, gte, inArray, isNull, max, sql } from 'drizzle-orm';
```
The schema import (`:5`–`:17`) becomes:
```ts
import {
  STREAM_ID_KINDS,
  moviePlays,
  movieTitles,
  streamCaches,
  streamProbeTitles,
  streamProviderHealth,
  streamProviders,
  type StreamCacheKind,
  type StreamCacheRow,
  type StreamHealthOutcome,
  type StreamIdKind,
  type StreamManifestKind,
  type StreamProviderHealthRow,
  type StreamProviderRow,
} from '../db/schema.js';
```
and line 22 becomes:
```ts
import type { ResolvedSource, StreamRef } from './types.js';
```

After `providerView` (after `:171`), add:
```ts
/** A cache's title slot: a film is season 0, episode 0, as in movie_stream_sources. */
export function cacheSlot(ref: StreamRef): { kind: 'movie' | 'tv'; tmdbId: number; season: number; episode: number } {
  return ref.kind === 'movie'
    ? { kind: 'movie', tmdbId: ref.tmdbId, season: 0, episode: 0 }
    : { kind: 'tv', tmdbId: ref.tmdbId, season: ref.season, episode: ref.episode };
}

/** The title a cache row holds. */
export function cacheRef(row: StreamCacheRow): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

/** What a cache learned from its source, written once the download is planned. */
export interface CachePlanned {
  provider: string;
  manifestKind: StreamCacheKind;
  height: number | null;
  audioLang: string | null;
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
  durationS: number | null;
}

function slotWhere(ref: StreamRef) {
  const s = cacheSlot(ref);
  return and(eq(streamCaches.kind, s.kind), eq(streamCaches.tmdbId, s.tmdbId), eq(streamCaches.season, s.season), eq(streamCaches.episode, s.episode));
}
```

Class comment (`:182`) becomes:
```ts
/** The only writer of `stream_providers`, `stream_provider_health` and `stream_caches`. */
```

Before the class's closing brace (after `insertProviders`, `:337`), add:
```ts
  /**
   * This host's cache of a title slot, made now (state downloading) when there is none.
   * `created` is false when the row was already there; its `max_height` is then left as it was.
   */
  async createCache(host: string, ref: StreamRef, maxHeight: number | null, now: Date = new Date()): Promise<{ row: StreamCacheRow; created: boolean }> {
    const slot = cacheSlot(ref);
    const [inserted] = await this.db
      .insert(streamCaches)
      .values({ host, ...slot, maxHeight, state: 'downloading', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [streamCaches.kind, streamCaches.tmdbId, streamCaches.season, streamCaches.episode, streamCaches.host] })
      .returning();
    if (inserted !== undefined) return { row: inserted, created: true };
    const existing = await this.cacheFor(host, ref);
    if (existing === null) throw new Error(`the stream cache of ${slot.kind} ${slot.tmdbId} on ${host} vanished while it was made`);
    return { row: existing, created: false };
  }

  async cacheById(id: string): Promise<StreamCacheRow | null> {
    const [row] = await this.db.select().from(streamCaches).where(eq(streamCaches.id, id));
    return row ?? null;
  }

  /** One host's cache of a title slot, or null. */
  async cacheFor(host: string, ref: StreamRef): Promise<StreamCacheRow | null> {
    const [row] = await this.db.select().from(streamCaches).where(and(slotWhere(ref), eq(streamCaches.host, host)));
    return row ?? null;
  }

  /** Every host's cache of a title slot. */
  async cachesOf(ref: StreamRef): Promise<StreamCacheRow[]> {
    return this.db.select().from(streamCaches).where(slotWhere(ref)).orderBy(asc(streamCaches.host));
  }

  /** Every cache of both hosts, newest first. */
  async caches(): Promise<StreamCacheRow[]> {
    return this.db.select().from(streamCaches).orderBy(desc(streamCaches.createdAt), asc(streamCaches.id));
  }

  /** This host's caches still downloading, oldest first: what a daemon start carries on. */
  async unfinishedCaches(host: string): Promise<StreamCacheRow[]> {
    return this.db
      .select()
      .from(streamCaches)
      .where(and(eq(streamCaches.host, host), eq(streamCaches.state, 'downloading')))
      .orderBy(asc(streamCaches.createdAt));
  }

  async cacheResolved(id: string, now: Date = new Date()): Promise<void> {
    await this.db.update(streamCaches).set({ resolves: sql`${streamCaches.resolves} + 1`, updatedAt: now }).where(eq(streamCaches.id, id));
  }

  async cachePlanned(id: string, p: CachePlanned, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({
        provider: p.provider,
        manifestKind: p.manifestKind,
        height: p.height,
        audioLang: p.audioLang,
        segmentsTotal: p.segmentsTotal,
        segmentsDone: p.segmentsDone,
        bytes: p.bytes,
        durationS: p.durationS,
        updatedAt: now,
      })
      .where(eq(streamCaches.id, id));
  }

  async cacheProgress(id: string, segmentsDone: number, bytes: number, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ segmentsDone, bytes, updatedAt: now })
      .where(and(eq(streamCaches.id, id), eq(streamCaches.state, 'downloading')));
  }

  async cacheSubtitle(id: string, subtitle: boolean, now: Date = new Date()): Promise<void> {
    await this.db.update(streamCaches).set({ subtitle, updatedAt: now }).where(eq(streamCaches.id, id));
  }

  async cacheReady(id: string, done: { segments: number; bytes: number; subtitle: boolean }, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({
        state: 'ready',
        segmentsTotal: done.segments,
        segmentsDone: done.segments,
        bytes: done.bytes,
        subtitle: done.subtitle,
        error: null,
        errorDetail: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(streamCaches.id, id));
  }

  async cacheFailed(id: string, error: string, detail: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ state: 'failed', error, errorDetail: detail.slice(0, MAX_DETAIL), completedAt: null, updatedAt: now })
      .where(eq(streamCaches.id, id));
  }

  /** A failed cache asked for again: downloading, its error cleared; the files on disk stay for the resume. */
  async cacheRestarted(id: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(streamCaches)
      .set({ state: 'downloading', error: null, errorDetail: null, completedAt: null, updatedAt: now })
      .where(eq(streamCaches.id, id));
  }

  async deleteCache(id: string): Promise<boolean> {
    const rows = await this.db.delete(streamCaches).where(eq(streamCaches.id, id)).returning({ id: streamCaches.id });
    return rows.length > 0;
  }
```
**Impact:** `npm run typecheck` passes; no caller yet.

### Step 3: Cache types
**File:** `src/directStream/cache/types.ts` (new)
**Code:**
```ts
import path from 'node:path';
import type { StreamCacheKind, StreamCacheState } from '../../db/schema.js';

/**
 * The stream cache (STREAM_CACHE_AND_BUG_REPORT phase 5): one film or episode downloaded to this
 * host's disk, recorded in stream_caches. These are the shapes its parts, routes and tool share.
 */

/** Where the caches live under the data directory when NOTESD_STREAM_CACHE_DIR is unset. */
export const STREAM_CACHE_SUBDIR = path.join('movies', 'stream-cache');

/** A cache id is the row's uuid. Checked before any lookup, so a malformed id never reaches Postgres. */
export const CACHE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One cache as every route and the tool answer it. */
export interface StreamCacheView {
  id: string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  /** Null for a film. */
  season: number | null;
  /** Null for a film. */
  episode: number | null;
  /** The machine whose disk holds the files. */
  host: string;
  /** True when `host` is this machine: its files can be served and it can be cleared here. */
  available: boolean;
  state: StreamCacheState;
  /** A download runs now on this machine. */
  running: boolean;
  /** Waiting for another download to finish. */
  queued: boolean;
  provider: string | null;
  manifest_kind: StreamCacheKind | null;
  height: number | null;
  max_height: number | null;
  audio_lang: string | null;
  subtitle: boolean;
  segments_total: number;
  segments_done: number;
  /** segments_done / segments_total, 0 to 1. */
  progress: number;
  bytes: number;
  duration_s: number | null;
  resolves: number;
  error: string | null;
  error_detail: string | null;
  /** `/api/stream/cache/<id>/f/master.m3u8` or `.../video.mp4`; null on the other machine or before the source is known. */
  playlist_url: string | null;
  /** `/api/stream/cache/<id>/f/subtitle.vtt`; null without an English subtitle or on the other machine. */
  subtitle_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type CacheErrorCode = 'unknown_cache' | 'not_on_this_machine' | 'cache_exists';

/** A request the cache refuses (src/http/streamCacheApi.ts maps it to HTTP; the tool answers it as JSON). */
export class CacheError extends Error {
  override readonly name = 'CacheError';
  constructor(
    readonly code: CacheErrorCode,
    message: string,
    readonly extra: { host?: string; cache?: StreamCacheView } = {},
  ) {
    super(message);
  }
}

/** Why a download stopped for good: written to stream_caches.error. */
export type CacheFailureCode =
  | 'cache_unsupported'
  | 'no_source'
  | 'resolve_failed'
  | 'download_failed'
  | 'token_refused'
  | 'source_changed'
  | 'disk_error';

export class CacheFailure extends Error {
  override readonly name = 'CacheFailure';
  constructor(
    readonly code: CacheFailureCode,
    message: string,
  ) {
    super(message);
  }
}
```

### Step 4: HLS parsing, choice and local playlists
**File:** `src/directStream/cache/hls.ts` (new)
**Code:**
```ts
import { absoluteHttp } from '../rewrite.js';

/**
 * HLS as the stream cache reads and writes it. Pure functions: a master playlist's renditions; a
 * media playlist's segments with their keys, init sections and byte ranges (every address made
 * absolute against the playlist's own address, the rule rewrite.ts uses for the pass-through); the
 * choice of rendition and audio; and the local playlists that name the cached files. What a cache
 * cannot hold throws HlsUnsupported. Messages never carry an address (they can hold a token).
 */

export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  frameRate: string | null;
  /** The AUDIO group the variant plays with; null: none (the audio is muxed, or there is none). */
  audioGroup: string | null;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  channels: string | null;
  /** Null: no URI (the rendition is muxed into the variant), or not http(s). */
  url: string | null;
}

export interface HlsMaster {
  variants: HlsVariant[];
  media: HlsRendition[];
  independentSegments: boolean;
}

/** An AES-128 key (the only method a cache holds). */
export interface HlsKey {
  /** The key file to download; null for a `data:` URI, kept as it is in `inline`. */
  url: string | null;
  inline: string | null;
  iv: string | null;
  keyFormat: string | null;
  keyFormatVersions: string | null;
}

export interface HlsMap {
  url: string;
  range: ByteRange | null;
}

export interface HlsSegment {
  url: string;
  duration: number;
  /** What follows the comma of #EXTINF. */
  title: string;
  range: ByteRange | null;
  /** Index into HlsMedia.keys; null: not encrypted. */
  key: number | null;
  /** Index into HlsMedia.maps; null: no init section. */
  map: number | null;
  /** #EXT-X-DISCONTINUITY, #EXT-X-PROGRAM-DATE-TIME, #EXT-X-GAP, #EXT-X-BITRATE lines before it, verbatim. */
  tags: string[];
  gap: boolean;
}

export interface HlsMedia {
  version: number | null;
  targetDuration: number;
  mediaSequence: number;
  discontinuitySequence: number | null;
  independentSegments: boolean;
  /** The #EXT-X-START attribute list, verbatim. */
  start: string | null;
  keys: HlsKey[];
  maps: HlsMap[];
  segments: HlsSegment[];
}

export type HlsUnsupportedReason = 'drm' | 'live' | 'not_a_playlist' | 'empty';

export class HlsUnsupported extends Error {
  override readonly name = 'HlsUnsupported';
  constructor(
    readonly reason: HlsUnsupportedReason,
    message: string,
  ) {
    super(message);
  }
}

const ATTRIBUTE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

/** `NAME="x",BANDWIDTH=1` to a map; quotes are taken off. */
export function parseAttributes(list: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of list.matchAll(ATTRIBUTE)) {
    const raw = m[2] ?? '';
    out.set(m[1] ?? '', raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
  }
  return out;
}

function playlistLines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** True for any HLS playlist: it starts with #EXTM3U (after a BOM). Its name and content type do not matter (VidNest's master.txt). */
export function isPlaylist(text: string): boolean {
  return text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

export function isMaster(text: string): boolean {
  return /^\s*#EXT-X-STREAM-INF:/m.test(text);
}

function splitTag(line: string): [string, string] {
  const colon = line.indexOf(':');
  return colon === -1 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1)];
}

function numberOr<T extends number | null>(value: string | undefined, fallback: T): number | T {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseMaster(text: string, base: string): HlsMaster {
  if (!isPlaylist(text)) throw new HlsUnsupported('not_a_playlist', 'the manifest is not an HLS playlist');
  const variants: HlsVariant[] = [];
  const media: HlsRendition[] = [];
  let independentSegments = false;
  let pending: Map<string, string> | null = null;
  for (const line of playlistLines(text)) {
    if (line.startsWith('#')) {
      const [tag, value] = splitTag(line);
      if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') independentSegments = true;
      else if (tag === '#EXT-X-STREAM-INF') pending = parseAttributes(value);
      else if (tag === '#EXT-X-MEDIA') {
        const a = parseAttributes(value);
        const uri = a.get('URI');
        media.push({
          type: a.get('TYPE') ?? '',
          groupId: a.get('GROUP-ID') ?? '',
          name: a.get('NAME') ?? null,
          language: a.get('LANGUAGE') ?? null,
          isDefault: a.get('DEFAULT') === 'YES',
          channels: a.get('CHANNELS') ?? null,
          url: uri === undefined ? null : absoluteHttp(uri, base),
        });
      }
      continue;
    }
    if (pending === null) continue;
    const url = absoluteHttp(line, base);
    if (url !== null) {
      const resolution = /^(\d+)x(\d+)$/.exec(pending.get('RESOLUTION') ?? '');
      variants.push({
        url,
        bandwidth: numberOr(pending.get('BANDWIDTH'), 0),
        averageBandwidth: numberOr(pending.get('AVERAGE-BANDWIDTH'), null),
        width: resolution === null ? null : Number(resolution[1]),
        height: resolution === null ? null : Number(resolution[2]),
        codecs: pending.get('CODECS') ?? null,
        frameRate: pending.get('FRAME-RATE') ?? null,
        audioGroup: pending.get('AUDIO') ?? null,
      });
    }
    pending = null;
  }
  if (variants.length === 0) throw new HlsUnsupported('empty', 'the master playlist names no rendition');
  return { variants, media, independentSegments };
}

/**
 * The rendition to cache: the tallest, or the tallest not above `maxHeight`; among equal heights the
 * widest bandwidth. With no rendition at or under `maxHeight`, the shortest one. Renditions without
 * a RESOLUTION count only when none has one, and then by bandwidth.
 */
export function pickVariant(variants: readonly HlsVariant[], maxHeight: number | null): HlsVariant {
  const better = (a: HlsVariant, b: HlsVariant): number => (b.height ?? -1) - (a.height ?? -1) || b.bandwidth - a.bandwidth;
  const sized = variants.filter((v) => v.height !== null).sort(better);
  const tallest = sized[0];
  if (tallest === undefined) {
    const widest = [...variants].sort(better)[0];
    if (widest === undefined) throw new HlsUnsupported('empty', 'the master playlist names no rendition');
    return widest;
  }
  if (maxHeight === null) return tallest;
  return sized.find((v) => (v.height ?? 0) <= maxHeight) ?? sized[sized.length - 1] ?? tallest;
}

/** What audio a cache wants: the resolver's original-language track, and the title's original language. */
export interface AudioWanted {
  track: { lang: string | null; label: string | null } | null;
  lang: string | null;
}

/**
 * The audio rendition a cache takes from a variant's group, as the player would pick it
 * (web/src/stream/engine.ts audioTrackIndex): the session's original-language track (same LANGUAGE
 * and NAME, else same LANGUAGE; a track without a language by its NAME), else the title's original
 * language by primary subtag, else the group's DEFAULT, else its first. Null: no group, or an empty one.
 */
export function pickAudio(media: readonly HlsRendition[], group: string | null, wanted: AudioWanted): HlsRendition | null {
  if (group === null) return null;
  const tracks = media.filter((m) => m.type === 'AUDIO' && m.groupId === group);
  if (tracks.length === 0) return null;
  const lower = (s: string | null): string => (s ?? '').toLowerCase();
  const track = wanted.track;
  if (track !== null) {
    const exact = tracks.find((m) => lower(m.language) === lower(track.lang) && (m.name ?? '') === (track.label ?? ''));
    if (exact !== undefined) return exact;
    const near = track.lang === null ? tracks.find((m) => m.name === track.label) : tracks.find((m) => lower(m.language) === lower(track.lang));
    if (near !== undefined) return near;
  }
  if (wanted.lang !== null) {
    const want = wanted.lang.toLowerCase();
    const original = tracks.find((m) => (lower(m.language).split(/[-_]/)[0] ?? '') === want);
    if (original !== undefined) return original;
  }
  return tracks.find((m) => m.isDefault) ?? tracks[0] ?? null;
}

function parseRangeTag(value: string): { length: number; offset: number | null } {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (m === null) throw new HlsUnsupported('not_a_playlist', 'a byte range is malformed');
  return { length: Number(m[1]), offset: m[2] === undefined ? null : Number(m[2]) };
}

function keyIndex(media: HlsMedia, a: Map<string, string>, base: string): number | null {
  const method = (a.get('METHOD') ?? 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  const keyFormat = a.get('KEYFORMAT') ?? null;
  if (method !== 'AES-128' || (keyFormat !== null && keyFormat.toLowerCase() !== 'identity')) {
    throw new HlsUnsupported('drm', `the stream is encrypted with ${method}${keyFormat === null ? '' : ` (${keyFormat})`}, which a cache cannot hold`);
  }
  const uri = a.get('URI') ?? '';
  const inline = /^data:/i.test(uri) ? uri : null;
  const url = inline === null ? absoluteHttp(uri, base) : null;
  if (inline === null && url === null) throw new HlsUnsupported('drm', 'an AES-128 key has no http(s) address');
  const key: HlsKey = { url, inline, iv: a.get('IV') ?? null, keyFormat, keyFormatVersions: a.get('KEYFORMATVERSIONS') ?? null };
  const same = media.keys.findIndex(
    (k) => k.url === key.url && k.inline === key.inline && k.iv === key.iv && k.keyFormat === key.keyFormat && k.keyFormatVersions === key.keyFormatVersions,
  );
  if (same !== -1) return same;
  media.keys.push(key);
  return media.keys.length - 1;
}

function mapIndex(media: HlsMedia, a: Map<string, string>, base: string): number {
  const url = absoluteHttp(a.get('URI') ?? '', base);
  if (url === null) throw new HlsUnsupported('not_a_playlist', 'an EXT-X-MAP has no http(s) address');
  const raw = a.get('BYTERANGE');
  let range: ByteRange | null = null;
  if (raw !== undefined) {
    const r = parseRangeTag(raw);
    range = { length: r.length, offset: r.offset ?? 0 };
  }
  const same = media.maps.findIndex((m) => m.url === url && m.range?.offset === range?.offset && m.range?.length === range?.length);
  if (same !== -1) return same;
  media.maps.push({ url, range });
  return media.maps.length - 1;
}

/**
 * A media playlist. Throws HlsUnsupported for DRM (SAMPLE-AES, another KEYFORMAT), a live
 * playlist (no #EXT-X-ENDLIST), no segment, or a playlist that is malformed.
 */
export function parseMedia(text: string, base: string): HlsMedia {
  if (!isPlaylist(text)) throw new HlsUnsupported('not_a_playlist', 'the playlist does not start with #EXTM3U');
  const media: HlsMedia = {
    version: null,
    targetDuration: 0,
    mediaSequence: 0,
    discontinuitySequence: null,
    independentSegments: false,
    start: null,
    keys: [],
    maps: [],
    segments: [],
  };
  let key: number | null = null;
  let map: number | null = null;
  let duration: number | null = null;
  let title = '';
  let range: { length: number; offset: number | null } | null = null;
  let tags: string[] = [];
  let gap = false;
  let ended = false;
  let previous: { url: string; end: number } | null = null;
  for (const line of playlistLines(text)) {
    if (!line.startsWith('#')) {
      const url = absoluteHttp(line, base);
      if (url === null) throw new HlsUnsupported('not_a_playlist', 'a segment address is not http(s)');
      if (duration === null) throw new HlsUnsupported('not_a_playlist', 'a segment has no #EXTINF');
      let segmentRange: ByteRange | null = null;
      if (range !== null) {
        const offset = range.offset ?? (previous !== null && previous.url === url ? previous.end : null);
        if (offset === null) throw new HlsUnsupported('not_a_playlist', 'a byte range without an offset follows no range of the same file');
        segmentRange = { length: range.length, offset };
        previous = { url, end: offset + range.length };
      } else previous = null;
      media.segments.push({ url, duration, title, range: segmentRange, key, map, tags, gap });
      duration = null;
      title = '';
      range = null;
      tags = [];
      gap = false;
      continue;
    }
    const [tag, value] = splitTag(line);
    switch (tag) {
      case '#EXT-X-VERSION':
        media.version = numberOr(value, null);
        break;
      case '#EXT-X-TARGETDURATION':
        media.targetDuration = numberOr(value, 0);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        media.mediaSequence = numberOr(value, 0);
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        media.discontinuitySequence = numberOr(value, null);
        break;
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        media.independentSegments = true;
        break;
      case '#EXT-X-START':
        media.start = value;
        break;
      case '#EXT-X-ENDLIST':
        ended = true;
        break;
      case '#EXTINF': {
        const comma = value.indexOf(',');
        const d = Number(comma === -1 ? value : value.slice(0, comma));
        if (!Number.isFinite(d) || d < 0) throw new HlsUnsupported('not_a_playlist', 'an #EXTINF duration is malformed');
        duration = d;
        title = comma === -1 ? '' : value.slice(comma + 1);
        break;
      }
      case '#EXT-X-BYTERANGE':
        range = parseRangeTag(value);
        break;
      case '#EXT-X-KEY':
        key = keyIndex(media, parseAttributes(value), base);
        break;
      case '#EXT-X-MAP':
        map = mapIndex(media, parseAttributes(value), base);
        break;
      case '#EXT-X-GAP':
        tags.push(line);
        gap = true;
        break;
      case '#EXT-X-DISCONTINUITY':
      case '#EXT-X-PROGRAM-DATE-TIME':
      case '#EXT-X-BITRATE':
        tags.push(line);
        break;
      default:
        // EXT-X-PLAYLIST-TYPE (the copy is always VOD), EXT-X-DATERANGE, cue marks and unknown tags are dropped.
        break;
    }
  }
  if (!ended) throw new HlsUnsupported('live', 'the playlist has no #EXT-X-ENDLIST: a live stream cannot be cached');
  if (media.segments.length === 0) throw new HlsUnsupported('empty', 'the playlist lists no segment');
  return media;
}

/** `v`: the video playlist's files; `a`: the separate audio rendition's. */
export type TrackPrefix = 'v' | 'a';

/** The local name of the i-th segment (1-based position in its playlist). */
export function segmentName(prefix: TrackPrefix, index: number, ext: string): string {
  return `${prefix}-${String(index).padStart(5, '0')}.${ext}`;
}

/** The local name of the k-th init section (k from 0). */
export function initName(prefix: TrackPrefix, k: number): string {
  return `${prefix}-init-${k + 1}.mp4`;
}

/** The local name of the k-th key (k from 0). */
export function keyName(prefix: TrackPrefix, k: number): string {
  return `${prefix}-key-${k + 1}.key`;
}

/** A playlist's segment extension on disk: fMP4 (an init section) is m4s, raw ADTS audio aac, the rest MPEG-TS. */
export function segmentExt(media: HlsMedia): 'm4s' | 'aac' | 'ts' {
  if (media.maps.length > 0) return 'm4s';
  const first = media.segments[0];
  return first !== undefined && /\.aac$/i.test(new URL(first.url).pathname) ? 'aac' : 'ts';
}

function formatDuration(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(Number(d.toFixed(6)));
}

function keyLine(k: HlsKey, index: number, prefix: TrackPrefix): string {
  const attrs = ['METHOD=AES-128', `URI="${k.inline ?? keyName(prefix, index)}"`];
  if (k.iv !== null) attrs.push(`IV=${k.iv}`);
  if (k.keyFormat !== null) attrs.push(`KEYFORMAT="${k.keyFormat}"`);
  if (k.keyFormatVersions !== null) attrs.push(`KEYFORMATVERSIONS="${k.keyFormatVersions}"`);
  return `#EXT-X-KEY:${attrs.join(',')}`;
}

/**
 * The local copy of a media playlist: every segment by its position, named relatively, VOD with
 * ENDLIST. The media sequence is kept (a key without IV uses it), byte ranges become files.
 */
export function localMediaPlaylist(media: HlsMedia, prefix: TrackPrefix): string {
  const ext = segmentExt(media);
  const longest = media.segments.reduce((max, s) => Math.max(max, s.duration), 0);
  const out = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.max(media.version ?? 3, media.maps.length > 0 ? 6 : 3)}`,
    `#EXT-X-TARGETDURATION:${Math.max(media.targetDuration, Math.ceil(longest))}`,
    `#EXT-X-MEDIA-SEQUENCE:${media.mediaSequence}`,
  ];
  if (media.discontinuitySequence !== null) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${media.discontinuitySequence}`);
  out.push('#EXT-X-PLAYLIST-TYPE:VOD');
  if (media.independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (media.start !== null) out.push(`#EXT-X-START:${media.start}`);
  let key: number | null = null;
  let map: number | null = null;
  media.segments.forEach((s, i) => {
    for (const tag of s.tags) if (tag === '#EXT-X-DISCONTINUITY') out.push(tag);
    if (s.key !== key) {
      const k = s.key === null ? undefined : media.keys[s.key];
      out.push(k === undefined ? '#EXT-X-KEY:METHOD=NONE' : keyLine(k, s.key ?? 0, prefix));
      key = s.key;
    }
    if (s.map !== null && s.map !== map) out.push(`#EXT-X-MAP:URI="${initName(prefix, s.map)}"`);
    map = s.map;
    for (const tag of s.tags) if (tag !== '#EXT-X-DISCONTINUITY') out.push(tag);
    out.push(`#EXTINF:${formatDuration(s.duration)},${s.title}`, segmentName(prefix, i + 1, ext));
  });
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}

const quoted = (s: string): string => s.replace(/"/g, "'");

/** What the local master names of the cached variant. */
export type MasterVariant = Pick<HlsVariant, 'bandwidth' | 'averageBandwidth' | 'width' | 'height' | 'codecs' | 'frameRate'>;

/** The local master: the one cached variant (video.m3u8), with its audio rendition (audio.m3u8) when that is separate. */
export function localMaster(variant: MasterVariant, audio: HlsRendition | null, independentSegments: boolean): string {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3'];
  if (independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (audio !== null) {
    const attrs = ['TYPE=AUDIO', 'GROUP-ID="audio"', `NAME="${quoted(audio.name ?? 'Audio')}"`];
    if (audio.language !== null) attrs.push(`LANGUAGE="${quoted(audio.language)}"`);
    attrs.push('DEFAULT=YES', 'AUTOSELECT=YES');
    if (audio.channels !== null) attrs.push(`CHANNELS="${quoted(audio.channels)}"`);
    attrs.push('URI="audio.m3u8"');
    out.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
  }
  const inf = [`BANDWIDTH=${Math.max(1, Math.round(variant.bandwidth))}`];
  if (variant.averageBandwidth !== null) inf.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`);
  if (variant.width !== null && variant.height !== null) inf.push(`RESOLUTION=${variant.width}x${variant.height}`);
  if (variant.codecs !== null) inf.push(`CODECS="${quoted(variant.codecs)}"`);
  if (variant.frameRate !== null) inf.push(`FRAME-RATE=${variant.frameRate}`);
  if (audio !== null) inf.push('AUDIO="audio"');
  out.push(`#EXT-X-STREAM-INF:${inf.join(',')}`, 'video.m3u8', '');
  return out.join('\n');
}
```

### Step 5: The file list a source becomes
**File:** `src/directStream/cache/plan.ts` (new)
**Code:**
```ts
import { createHash } from 'node:crypto';
import {
  initName,
  keyName,
  localMaster,
  localMediaPlaylist,
  segmentExt,
  segmentName,
  type ByteRange,
  type HlsMedia,
  type HlsRendition,
  type HlsVariant,
  type MasterVariant,
  type TrackPrefix,
} from './hls.js';

/** A plain file is downloaded in chunks of this size, each its own resumable file. */
export const MP4_CHUNK_BYTES = 4 * 1024 * 1024;

export function chunkName(index: number): string {
  return `c-${String(index).padStart(5, '0')}.bin`;
}

/** One file of a cache and where it comes from. Addresses live in memory only, never on disk. */
export interface CacheFile {
  url: string;
  range: ByteRange | null;
  /** A media segment (or a plain-file chunk): counted in segments_total. */
  counts: boolean;
  /** Seconds into the title, for the download order; -1 for keys and init sections (first). */
  start: number;
}

/** What one resolve's source becomes on disk. */
export interface CachePlan {
  kind: 'hls' | 'mp4';
  provider: string;
  height: number | null;
  audioLang: string | null;
  durationS: number | null;
  /** A plain file's size; null for HLS. */
  size: number | null;
  /** A plain file's chunk size; null for HLS. */
  chunkBytes: number | null;
  files: Map<string, CacheFile>;
  /** Download order: keys and init sections, then by time, audio beside video. */
  order: string[];
  /** EXT-X-GAP segments: counted done, never downloaded. */
  gaps: number;
  segmentsTotal: number;
  /** Local playlists, written before any segment. */
  playlists: { name: string; text: string }[];
  /**
   * The source's shape (provider, rendition, every segment's duration and range): two resolves
   * with the same signature name the same segments by index, so the files on disk carry over.
   */
  signature: string;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const shape = (m: HlsMedia): unknown[] =>
  m.segments.map((s) => [Math.round(s.duration * 1000), s.range?.offset ?? null, s.range?.length ?? null, s.gap, s.key, s.map]);

export interface HlsPlanInput {
  provider: string;
  /** Null: the manifest was a media playlist. */
  variant: HlsVariant | null;
  /** The separate audio rendition, with `audio` its playlist; both null when the audio is muxed. */
  audioRendition: HlsRendition | null;
  video: HlsMedia;
  audio: HlsMedia | null;
  independentSegments: boolean;
  bestHeight: number | null;
  audioLang: string | null;
}

export function hlsPlan(input: HlsPlanInput): CachePlan {
  const files = new Map<string, CacheFile>();
  let gaps = 0;
  let segmentsTotal = 0;
  const addTrack = (media: HlsMedia, prefix: TrackPrefix): void => {
    const ext = segmentExt(media);
    media.maps.forEach((m, k) => files.set(initName(prefix, k), { url: m.url, range: m.range, counts: false, start: -1 }));
    media.keys.forEach((key, k) => {
      if (key.url !== null) files.set(keyName(prefix, k), { url: key.url, range: null, counts: false, start: -1 });
    });
    let at = 0;
    media.segments.forEach((s, i) => {
      segmentsTotal += 1;
      if (s.gap) gaps += 1;
      else files.set(segmentName(prefix, i + 1, ext), { url: s.url, range: s.range, counts: true, start: at });
      at += s.duration;
    });
  };
  addTrack(input.video, 'v');
  if (input.audio !== null) addTrack(input.audio, 'a');
  const order = [...files.entries()].sort(([an, a], [bn, b]) => a.start - b.start || an.localeCompare(bn)).map(([name]) => name);
  const audioRendition = input.audio === null ? null : input.audioRendition;
  const variant: MasterVariant = input.variant ?? { bandwidth: 1, averageBandwidth: null, width: null, height: null, codecs: null, frameRate: null };
  const height = input.variant?.height ?? input.bestHeight;
  const playlists = [
    { name: 'master.m3u8', text: localMaster(variant, audioRendition, input.independentSegments) },
    { name: 'video.m3u8', text: localMediaPlaylist(input.video, 'v') },
    ...(input.audio === null ? [] : [{ name: 'audio.m3u8', text: localMediaPlaylist(input.audio, 'a') }]),
  ];
  const durationS = Math.round(input.video.segments.reduce((t, s) => t + s.duration, 0) * 1000) / 1000;
  return {
    kind: 'hls',
    provider: input.provider,
    height,
    audioLang: input.audioLang,
    durationS,
    size: null,
    chunkBytes: null,
    files,
    order,
    gaps,
    segmentsTotal,
    playlists,
    signature: digest({ provider: input.provider, kind: 'hls', height, video: shape(input.video), audio: input.audio === null ? null : shape(input.audio) }),
  };
}

export interface Mp4PlanInput {
  provider: string;
  url: string;
  /** Bytes, from the host's Content-Range; above 0. */
  size: number;
  chunkBytes: number;
  bestHeight: number | null;
  audioLang: string | null;
}

export function mp4Plan(input: Mp4PlanInput): CachePlan {
  const files = new Map<string, CacheFile>();
  const chunks = Math.max(1, Math.ceil(input.size / input.chunkBytes));
  for (let i = 1; i <= chunks; i += 1) {
    const offset = (i - 1) * input.chunkBytes;
    files.set(chunkName(i), { url: input.url, range: { offset, length: Math.min(input.chunkBytes, input.size - offset) }, counts: true, start: i });
  }
  return {
    kind: 'mp4',
    provider: input.provider,
    height: input.bestHeight,
    audioLang: input.audioLang,
    durationS: null,
    size: input.size,
    chunkBytes: input.chunkBytes,
    files,
    order: [...files.keys()],
    gaps: 0,
    segmentsTotal: chunks,
    playlists: [],
    signature: digest({ provider: input.provider, kind: 'mp4', size: input.size, chunkBytes: input.chunkBytes }),
  };
}
```

### Step 6: One GET for the cache
**File:** `src/directStream/cache/upstream.ts` (new)
**Change:** the cache's fetch reuses the pass-through's rules (`upstreamHeaders`, `allows`, `learn`, `absoluteHttp`, `MAX_REDIRECTS`, `UPSTREAM_HEADERS_TIMEOUT_MS`) but reads the body into a buffer (a segment is a few MB) instead of streaming it to a player, and sorts every answer into ok / refused / retry / fatal.
**Code:**
```ts
import { MAX_REDIRECTS, UPSTREAM_HEADERS_TIMEOUT_MS, upstreamHeaders, type FetchLike } from '../passThrough.js';
import { absoluteHttp } from '../rewrite.js';
import { allows, learn, type StreamSession } from '../sessions.js';
import type { ByteRange } from './hls.js';

/** A segment, key or chunk must arrive whole within this. */
export const BODY_TIMEOUT_MS = 120_000;
/** A single segment larger than this is refused (a runaway body, not a segment). */
export const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

/** How one request ended, for the downloader. Details never carry the address. */
export type Fetched =
  | { kind: 'ok'; url: string; status: number; body: Buffer; contentRange: string | null }
  | { kind: 'refused'; status: number }
  | { kind: 'retry'; status: number | null; detail: string }
  | { kind: 'fatal'; status: number | null; detail: string };

export interface UpstreamGet {
  range: ByteRange | null;
  maxBytes: number;
  signal: AbortSignal;
}

/** 401, 403, 410: the host refuses the token (a signed address that expired). */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 410]);

function retryable(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readBody(res: Response, cap: number, truncate: boolean): Promise<Buffer | null> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (truncate && size >= cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * One GET for the cache with the session's captured headers, the pass-through's rules: only a host
 * the session may reach, redirects followed here (each target joins the session), no cookie. A
 * byte range is asked with `Range`; a host that answers it with 200 is read up to the range's end
 * and sliced. Throws only when `signal` was aborted (the download was cancelled).
 */
export async function fetchUpstream(fetchImpl: FetchLike, session: StreamSession, target: string, options: UpstreamGet): Promise<Fetched> {
  const first = absoluteHttp(target);
  if (first === null || !allows(session, first)) return { kind: 'fatal', status: null, detail: 'the address is not on a host this source may reach' };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  const headersTimer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const bodyTimer = setTimeout(abort, BODY_TIMEOUT_MS);
  const range = options.range;
  const headers = upstreamHeaders(session.source.headers, range === null ? null : `bytes=${range.offset}-${range.offset + range.length - 1}`);
  try {
    let url = first;
    let res = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    for (let hops = 0; res.status >= 300 && res.status < 400 && res.headers.get('location') !== null; hops += 1) {
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(res.headers.get('location') ?? '', url);
      if (next === null || hops >= MAX_REDIRECTS) {
        return { kind: 'fatal', status: res.status, detail: next === null ? 'redirected to an address that is not http(s)' : `redirected more than ${MAX_REDIRECTS} times` };
      }
      learn(session, next);
      url = next;
      res = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    }
    clearTimeout(headersTimer);
    if (REFUSED.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'refused', status: res.status };
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      return retryable(res.status) ? { kind: 'retry', status: res.status, detail: `HTTP ${res.status}` } : { kind: 'fatal', status: res.status, detail: `HTTP ${res.status}` };
    }
    const end = range === null ? null : range.offset + range.length;
    const whole = end !== null && res.status === 200;
    const body = await readBody(res, whole ? end : options.maxBytes, whole);
    if (body === null) return { kind: 'fatal', status: res.status, detail: `the answer is larger than ${options.maxBytes} bytes` };
    if (range !== null && end !== null) {
      if (whole) {
        if (body.length < end) return { kind: 'retry', status: 200, detail: 'the answer ended before the byte range' };
        return { kind: 'ok', url, status: 200, body: body.subarray(range.offset, end), contentRange: null };
      }
      if (body.length !== range.length) return { kind: 'retry', status: 206, detail: `a byte range answer of ${body.length} bytes, not ${range.length}` };
    }
    return { kind: 'ok', url, status: res.status, body, contentRange: res.headers.get('content-range') };
  } catch (err) {
    if (options.signal.aborted) throw err;
    return { kind: 'retry', status: null, detail: `the stream host did not answer (${messageOf(err)})` };
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(bodyTimer);
    options.signal.removeEventListener('abort', abort);
  }
}
```

### Step 7: The cache folder on disk
**File:** `src/directStream/cache/store.ts` (new)
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The names the file route serves. cache.json, plain-file chunks and *.part writes are never served. */
export const SERVED_NAME =
  /^(?:master|video|audio)\.m3u8$|^[va]-init-\d+\.mp4$|^[va]-key-\d+\.key$|^[va]-\d{5,}\.(?:ts|m4s|aac)$|^subtitle\.vtt$|^video\.mp4$/;

export const META_FILE = 'cache.json';

/** What a cache folder says about the source its files came from. No address: they carry tokens. */
export interface CacheMeta {
  version: 1;
  signature: string;
  provider: string;
  kind: 'hls' | 'mp4';
}

/** `<root>/<cache id>/`. Every write goes to a temporary name and is renamed, so a file is whole or absent. */
export class CacheStore {
  constructor(readonly root: string) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  file(id: string, name: string): string {
    return path.join(this.root, id, name);
  }

  /** Makes the folder and drops writes a stopped run left half done. */
  async prepare(id: string): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    for (const name of await readdir(this.dir(id))) if (name.endsWith('.part')) await rm(this.file(id, name), { force: true });
  }

  async write(id: string, name: string, data: Buffer | string): Promise<void> {
    const final = this.file(id, name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    await writeFile(tmp, data);
    await rename(tmp, final);
  }

  async has(id: string, name: string): Promise<boolean> {
    try {
      return (await stat(this.file(id, name))).isFile();
    } catch {
      return false;
    }
  }

  async size(id: string, name: string): Promise<number> {
    try {
      return (await stat(this.file(id, name))).size;
    } catch {
      return 0;
    }
  }

  /** The whole files in the folder; empty when there is no folder. */
  async names(id: string): Promise<Set<string>> {
    try {
      return new Set((await readdir(this.dir(id))).filter((name) => !name.endsWith('.part')));
    } catch {
      return new Set();
    }
  }

  async readMeta(id: string): Promise<CacheMeta | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(id, META_FILE), 'utf8')) as Partial<CacheMeta>;
      return raw.version === 1 && typeof raw.signature === 'string' && typeof raw.provider === 'string' && (raw.kind === 'hls' || raw.kind === 'mp4')
        ? { version: 1, signature: raw.signature, provider: raw.provider, kind: raw.kind }
        : null;
    } catch {
      return null;
    }
  }

  async writeMeta(id: string, meta: CacheMeta): Promise<void> {
    await this.write(id, META_FILE, `${JSON.stringify(meta)}\n`);
  }

  /** Empties the folder: the source changed, so what is on disk no longer matches it. */
  async clear(id: string): Promise<void> {
    for (const name of await readdir(this.dir(id))) await rm(this.file(id, name), { recursive: true, force: true });
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /** Joins chunk files in order into `name` (temporary name, then rename), then deletes the chunks. */
  async join(id: string, parts: readonly string[], name: string): Promise<void> {
    const final = this.file(id, name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    const out = await open(tmp, 'w');
    try {
      for (const part of parts) await out.appendFile(await readFile(this.file(id, part)));
    } finally {
      await out.close();
    }
    await rename(tmp, final);
    for (const part of parts) await rm(this.file(id, part), { force: true });
  }
}
```

### Step 8: Range answers from disk
**File:** `src/directStream/cache/serve.ts` (new)
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export function contentTypeOf(name: string): string {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.ts')) return 'video/mp2t';
  if (name.endsWith('.m4s')) return 'video/iso.segment';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * One `Range` header against a size: null without one, `invalid` for a range that cannot be
 * served (several ranges, or past the end), else the inclusive byte span.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (header === null || header.trim() === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return 'invalid';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

/** A cache file from disk: 200, 206 for a Range, 416 for one that cannot be served. Playlists are never cached by the browser. */
export async function fileResponse(file: string, name: string, rangeHeader: string | null): Promise<Response> {
  const size = (await stat(file)).size;
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = new Headers({
    'content-type': contentTypeOf(name),
    'accept-ranges': 'bytes',
    'cache-control': name.endsWith('.m3u8') ? 'no-store' : 'private, max-age=3600',
    'content-length': String(size === 0 ? 0 : end - start + 1),
  });
  if (range !== null) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
```

### Step 9: The English subtitle as WebVTT
**File:** `src/directStream/cache/subtitle.ts` (new)
**Change:** the same choice as `DirectStreamService.subtitleText` (English, a separate file first, then a track inside the manifest), through the cache's fetch. An HLS subtitle playlist's WebVTT segments are joined under one header (each segment's own `WEBVTT` block is dropped; `X-TIMESTAMP-MAP` is not applied, as `dialogue.ts` does not either).
**Code:**
```ts
import { PLAYLIST_MAX_BYTES, type FetchLike } from '../passThrough.js';
import { srtToVtt } from '../rewrite.js';
import type { StreamSession } from '../sessions.js';
import { isEnglish, type SubtitleTrack } from '../types.js';
import { parseMedia } from './hls.js';
import { fetchUpstream } from './upstream.js';

/** A subtitle playlist is read up to this many segments, eight at a time. */
const SUBTITLE_MAX_SEGMENTS = 1_500;
const SUBTITLE_PARALLEL = 8;

const decode = (body: Buffer): string => new TextDecoder().decode(body);

/** WebVTT segments of an HLS subtitle playlist as one file: one header, every segment's cues in order. */
export function joinVtt(parts: readonly string[]): string {
  const cues = parts
    .map((part) => {
      const body = part.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (!body.trimStart().startsWith('WEBVTT')) return body.trim();
      const blank = body.indexOf('\n\n');
      return blank === -1 ? '' : body.slice(blank + 2).trim();
    })
    .filter((cue) => cue !== '');
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function readTrack(fetchImpl: FetchLike, session: StreamSession, track: SubtitleTrack, signal: AbortSignal): Promise<string | null> {
  const get = async (url: string): Promise<{ text: string; url: string } | null> => {
    const got = await fetchUpstream(fetchImpl, session, url, { range: null, maxBytes: PLAYLIST_MAX_BYTES, signal });
    return got.kind === 'ok' ? { text: decode(got.body), url: got.url } : null;
  };
  if (track.format === 'hls') {
    const playlist = await get(track.url);
    if (playlist === null) return null;
    const urls = parseMedia(playlist.text, playlist.url)
      .segments.slice(0, SUBTITLE_MAX_SEGMENTS)
      .map((s) => s.url);
    const parts: string[] = [];
    for (let i = 0; i < urls.length; i += SUBTITLE_PARALLEL) {
      const got = await Promise.all(urls.slice(i, i + SUBTITLE_PARALLEL).map((url) => get(url)));
      for (const g of got) if (g !== null) parts.push(g.text);
    }
    return parts.length === 0 ? null : joinVtt(parts);
  }
  if (track.format !== 'vtt' && track.format !== 'srt' && !/\.(vtt|srt)$/i.test(new URL(track.url).pathname)) return null;
  const file = await get(track.url);
  return file === null ? null : srtToVtt(file.text);
}

/** The source's English subtitle as WebVTT, or null when it has none that can be read. Throws only when `signal` was aborted. */
export async function englishSubtitle(fetchImpl: FetchLike, session: StreamSession, signal: AbortSignal): Promise<string | null> {
  const english = session.source.subtitles.filter((t) => isEnglish(t));
  const tracks = [...english.filter((t) => t.source === 'request'), ...english.filter((t) => t.source !== 'request')];
  for (const track of tracks) {
    let vtt: string | null;
    try {
      vtt = await readTrack(fetchImpl, session, track, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      vtt = null;
    }
    if (vtt !== null && /-->/.test(vtt)) return vtt;
  }
  return null;
}
```

### Step 10: One download
**File:** `src/directStream/cache/job.ts` (new)
**Change:** resolve → plan → adopt (compare with what is on disk, write playlists and meta) → download with bounded parallelism, retries with backoff, a single-flight fresh resolve on a refused token that keeps the files by index, a restart when the new source has another shape → join a plain file → outcome. `fetchNow` lets the file route jump the queue; `cancel` stops everything.
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import { jsonError, PLAYLIST_MAX_BYTES, type FetchLike } from '../passThrough.js';
import type { CachePlanned } from '../repo.js';
import { learn, type StreamSession } from '../sessions.js';
import { DirectStreamError, refLabel, type StreamRef } from '../types.js';
import { HlsUnsupported, isMaster, parseMaster, parseMedia, pickAudio, pickVariant, type HlsRendition, type HlsVariant } from './hls.js';
import { chunkName, hlsPlan, MP4_CHUNK_BYTES, mp4Plan, type CachePlan } from './plan.js';
import { parseRange } from './serve.js';
import type { CacheStore } from './store.js';
import { englishSubtitle } from './subtitle.js';
import { CacheFailure, type CacheFailureCode } from './types.js';
import { fetchUpstream, SEGMENT_MAX_BYTES } from './upstream.js';

/** Files fetched at once in one download. */
export const CACHE_PARALLEL = 4;
/** Tries of one file before the download fails (5 waits: 1, 2, 4, 8, 16 s). */
export const SEGMENT_ATTEMPTS = 6;
/** Fresh resolves in a row without a file downloaded in between; one more fails the download (token_refused). */
export const MAX_REFRESHES = 3;
/** Times the source may change shape under one download before it fails (source_changed). */
export const MAX_RESTARTS = 2;
/** Progress is written to the database at most this often. */
export const PROGRESS_FLUSH_MS = 2_000;

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}

/** Where a download writes what it learns (StreamCache binds it to DirectStreamRepo; tests record it). */
export interface CacheRecorder {
  resolved(id: string): Promise<void>;
  planned(id: string, planned: CachePlanned): Promise<void>;
  progress(id: string, segmentsDone: number, bytes: number): Promise<void>;
  subtitle(id: string, saved: boolean): Promise<void>;
}

export interface CacheJobDeps {
  store: CacheStore;
  recorder: CacheRecorder;
  /** DirectStreamService.resolve: a fresh source for the title (the streaming Chrome, out of sight). */
  resolve: (ref: StreamRef) => Promise<StreamSession>;
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  /** Default CACHE_PARALLEL. */
  parallel?: number;
  /** A plain file's chunk size; default MP4_CHUNK_BYTES. */
  chunkBytes?: number;
}

export type JobOutcome =
  | { state: 'ready'; segments: number; bytes: number; subtitle: boolean }
  | { state: 'failed'; error: CacheFailureCode; detail: string }
  | { state: 'cancelled' };

export interface JobProgress {
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
}

interface Source {
  generation: number;
  session: StreamSession;
  plan: CachePlan;
}

/** The host refused a playlist or the probe: resolve again. */
class Refused extends Error {
  constructor(readonly what: string) {
    super(`the stream host refused ${what}`);
  }
}

/** A fresh resolve gave a source of another shape: the files on disk do not match it. */
class SourceChanged extends Error {
  constructor(
    readonly session: StreamSession,
    readonly plan: CachePlan,
  ) {
    super('the stream changed after a fresh resolve');
  }
}

/** Opens once the download knows its files; fails with the download. */
class Gate {
  readonly promise: Promise<void>;
  open: () => void = () => undefined;
  fail: (err: unknown) => void = () => undefined;
  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.open = resolve;
      this.fail = reject;
    });
    this.promise.catch(() => undefined);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function failureOutcome(err: unknown): JobOutcome {
  if (err instanceof CacheFailure) return { state: 'failed', error: err.code, detail: err.message };
  if (err instanceof DirectStreamError) return { state: 'failed', error: err.code === 'no_source' ? 'no_source' : 'resolve_failed', detail: err.message };
  if (err instanceof Refused) return { state: 'failed', error: 'token_refused', detail: err.message };
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return { state: 'failed', error: 'disk_error', detail: messageOf(err) };
  return { state: 'failed', error: 'download_failed', detail: messageOf(err) };
}

/**
 * One cache's download on this host. `run()` resolves the title, turns the source into files
 * (plan.ts), compares them with what the folder already holds (a resume keeps every file whose
 * source has the same shape), writes the local playlists, then fetches the rest with up to
 * `parallel` at once. A file that fails is tried SEGMENT_ATTEMPTS times with backoff. A refused
 * token (401/403/410) resolves the title again, once for every file that saw it, and the download
 * carries on by index; MAX_REFRESHES fresh resolves without a file in between fail it. A new source
 * of another shape empties the folder and starts over (at most MAX_RESTARTS times).
 */
export class CacheJob {
  private readonly abort = new AbortController();
  private gate = new Gate();
  private source: Source | null = null;
  private lastPlan: CachePlan | null = null;
  private generation = 0;
  private present = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private refreshing: Promise<void> | null = null;
  private refreshes = 0;
  private restarts = 0;
  private counted = 0;
  private bytes = 0;
  private lastFlush = 0;

  constructor(
    readonly id: string,
    readonly ref: StreamRef,
    readonly maxHeight: number | null,
    private readonly deps: CacheJobDeps,
  ) {}

  /** The download, start to end. Never throws: a stop is `cancelled`, a failure is `failed`. */
  async run(): Promise<JobOutcome> {
    let subtitle: Promise<boolean> | null = null;
    try {
      await this.deps.store.prepare(this.id);
      let next = await this.planFor(await this.resolveNow());
      for (;;) {
        await this.adopt(next.session, next.plan);
        subtitle ??= this.saveSubtitle(next.session);
        try {
          await this.downloadAll();
          break;
        } catch (err) {
          if (!(err instanceof SourceChanged)) throw err;
          this.restarts += 1;
          if (this.restarts > MAX_RESTARTS) throw new CacheFailure('source_changed', `the stream changed under the download ${this.restarts} times`);
          this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the fresh source is not the one on disk; starting over`);
          await subtitle;
          subtitle = null;
          next = { session: err.session, plan: err.plan };
        }
      }
      const plan = this.current().plan;
      if (plan.kind === 'mp4' && !(await this.deps.store.has(this.id, 'video.mp4'))) await this.deps.store.join(this.id, plan.order, 'video.mp4');
      const saved = await (subtitle ?? Promise.resolve(false));
      return { state: 'ready', segments: plan.segmentsTotal, bytes: this.bytes, subtitle: saved };
    } catch (err) {
      this.gate.fail(err);
      if (subtitle !== null) await subtitle;
      if (this.abort.signal.aborted) return { state: 'cancelled' };
      return failureOutcome(err);
    }
  }

  /** Stops the download: requests in flight are aborted, nothing more is written. */
  cancel(): void {
    this.abort.abort(new Error('the stream cache download was cancelled'));
  }

  /** Counts for the routes' view; null until the source is known. */
  progress(): JobProgress | null {
    const plan = this.source?.plan ?? this.lastPlan;
    if (plan === null) return null;
    return { segmentsDone: this.counted + plan.gaps, segmentsTotal: plan.segmentsTotal, bytes: this.bytes };
  }

  /**
   * The file route's turn: waits for the source, then fetches `name` now (ahead of the queue, or
   * joining its fetch in flight) and stores it. Returns without fetching for a name the cache does
   * not download (a playlist, already on disk once the source is known). Throws what the fetch threw.
   */
  async fetchNow(name: string): Promise<void> {
    for (;;) {
      await this.gate.promise;
      const src = this.source;
      if (src === null) continue;
      if (!src.plan.files.has(name)) return;
      await this.ensure(name);
      return;
    }
  }

  /**
   * `GET .../f/video.mp4` while a plain file downloads: the chunk the range starts in is fetched now
   * if it is missing, and the answer is that range cut at the chunk's end (206; the player asks on).
   */
  async mp4Answer(rangeHeader: string | null): Promise<Response> {
    await this.gate.promise;
    const plan = this.current().plan;
    if (plan.kind !== 'mp4' || plan.size === null || plan.chunkBytes === null) return jsonError(404, 'not_found', 'This cache holds no plain file.');
    const size = plan.size;
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' } });
    const start = range?.start ?? 0;
    const index = Math.floor(start / plan.chunkBytes) + 1;
    const name = chunkName(index);
    await this.ensure(name);
    const chunk = await readFile(this.deps.store.file(this.id, name));
    const chunkStart = (index - 1) * plan.chunkBytes;
    const end = Math.min(range?.end ?? size - 1, chunkStart + chunk.length - 1);
    const body = new Uint8Array(chunk.subarray(start - chunkStart, end - chunkStart + 1));
    return new Response(body, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(body.length),
        'cache-control': 'no-store',
      },
    });
  }

  private current(): Source {
    if (this.source === null) throw new Error('the stream cache download has no source yet');
    return this.source;
  }

  private async resolveNow(): Promise<StreamSession> {
    const session = await this.deps.resolve(this.ref);
    try {
      await this.deps.recorder.resolved(this.id);
    } catch (err) {
      this.deps.log(`[notesd] stream cache: could not count a resolve: ${messageOf(err)}`);
    }
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    return session;
  }

  private bumpRefresh(why: string): void {
    this.refreshes += 1;
    if (this.refreshes > MAX_REFRESHES) throw new CacheFailure('token_refused', `the stream host kept refusing ${why} after ${MAX_REFRESHES} fresh resolves`);
  }

  /** A plan for `session`; a refused playlist resolves again (counted like any refresh). */
  private async planFor(session: StreamSession): Promise<{ session: StreamSession; plan: CachePlan }> {
    let current = session;
    for (;;) {
      try {
        return { session: current, plan: await this.makePlan(current) };
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        this.bumpRefresh(err.what);
        current = await this.resolveNow();
      }
    }
  }

  private async text(session: StreamSession, url: string): Promise<{ text: string; url: string }> {
    for (let attempt = 1; ; attempt += 1) {
      const got = await fetchUpstream(this.deps.fetch, session, url, { range: null, maxBytes: PLAYLIST_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') return { text: new TextDecoder().decode(got.body), url: got.url };
      if (got.kind === 'refused') throw new Refused(`a playlist (HTTP ${got.status})`);
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        continue;
      }
      throw new CacheFailure('download_failed', `a playlist: ${got.detail}`);
    }
  }

  private async makePlan(session: StreamSession): Promise<CachePlan> {
    const src = session.source;
    if (src.manifest_kind === 'dash') throw new CacheFailure('cache_unsupported', `${src.provider} streams this title as DASH, which a cache does not hold`);
    if (src.manifest_kind === 'mp4') return this.mp4(session);
    try {
      const top = await this.text(session, src.manifest_url);
      let variant: HlsVariant | null = null;
      let rendition: HlsRendition | null = null;
      let independent = false;
      let videoText = top;
      if (isMaster(top.text)) {
        const master = parseMaster(top.text, top.url);
        for (const v of master.variants) learn(session, v.url);
        for (const m of master.media) if (m.url !== null) learn(session, m.url);
        variant = pickVariant(master.variants, this.maxHeight);
        rendition = pickAudio(master.media, variant.audioGroup, { track: src.audio?.track ?? null, lang: session.audioLang });
        independent = master.independentSegments;
        videoText = await this.text(session, variant.url);
      }
      const video = parseMedia(videoText.text, videoText.url);
      let audio = null;
      if (rendition !== null && rendition.url !== null) {
        const audioText = await this.text(session, rendition.url);
        audio = parseMedia(audioText.text, audioText.url);
      }
      const plan = hlsPlan({
        provider: src.provider,
        variant,
        audioRendition: audio === null ? null : rendition,
        video,
        audio,
        independentSegments: independent || video.independentSegments,
        bestHeight: src.best_height,
        audioLang: (audio === null ? null : rendition?.language) ?? session.audioLang,
      });
      for (const file of plan.files.values()) learn(session, file.url);
      return plan;
    } catch (err) {
      if (err instanceof HlsUnsupported) throw new CacheFailure('cache_unsupported', `${src.provider}: ${err.message}`);
      throw err;
    }
  }

  private async mp4(session: StreamSession): Promise<CachePlan> {
    const src = session.source;
    for (let attempt = 1; ; attempt += 1) {
      const got = await fetchUpstream(this.deps.fetch, session, src.manifest_url, { range: { offset: 0, length: 1 }, maxBytes: SEGMENT_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') {
        const total = /\/(\d+)\s*$/.exec(got.contentRange ?? '');
        const size = total === null ? 0 : Number(total[1]);
        if (got.status !== 206 || size <= 0) {
          throw new CacheFailure('cache_unsupported', `${src.provider} serves the film as one file without byte ranges, which a cache cannot resume`);
        }
        return mp4Plan({ provider: src.provider, url: got.url, size, chunkBytes: this.deps.chunkBytes ?? MP4_CHUNK_BYTES, bestHeight: src.best_height, audioLang: session.audioLang });
      }
      if (got.kind === 'refused') throw new Refused(`the film (HTTP ${got.status})`);
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        continue;
      }
      throw new CacheFailure('download_failed', `the film: ${got.detail}`);
    }
  }

  /** Makes `plan` the source: drops a folder of another shape, writes meta and playlists, counts what is on disk. */
  private async adopt(session: StreamSession, plan: CachePlan): Promise<void> {
    const { store } = this.deps;
    const meta = await store.readMeta(this.id);
    if (meta !== null && meta.signature !== plan.signature) {
      this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the files on disk came from another source (${meta.provider}); downloading again from ${plan.provider}`);
      await store.clear(this.id);
    }
    await store.writeMeta(this.id, { version: 1, signature: plan.signature, provider: plan.provider, kind: plan.kind });
    for (const p of plan.playlists) await store.write(this.id, p.name, p.text);
    const names = await store.names(this.id);
    const joined = plan.kind === 'mp4' && names.has('video.mp4');
    this.present = new Set();
    this.counted = 0;
    this.bytes = 0;
    for (const [name, file] of plan.files) {
      if (!joined && !names.has(name)) continue;
      this.present.add(name);
      if (file.counts) this.counted += 1;
      if (!joined) this.bytes += await store.size(this.id, name);
    }
    if (joined) this.bytes = await store.size(this.id, 'video.mp4');
    this.generation += 1;
    this.source = { generation: this.generation, session, plan };
    this.lastPlan = plan;
    this.lastFlush = this.deps.now().getTime();
    await this.deps.recorder.planned(this.id, {
      provider: plan.provider,
      manifestKind: plan.kind,
      height: plan.height,
      audioLang: plan.audioLang,
      segmentsTotal: plan.segmentsTotal,
      segmentsDone: this.counted + plan.gaps,
      bytes: this.bytes,
      durationS: plan.durationS,
    });
    this.gate.open();
  }

  private async downloadAll(): Promise<void> {
    const src = this.current();
    const queue = src.plan.order.filter((name) => !this.present.has(name));
    let next = 0;
    let failure: unknown = null;
    const worker = async (): Promise<void> => {
      while (failure === null && !this.abort.signal.aborted) {
        const name = queue[next];
        next += 1;
        if (name === undefined) return;
        try {
          await this.ensure(name);
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.deps.parallel ?? CACHE_PARALLEL) }, () => worker()));
    await Promise.allSettled([...this.inflight.values()]);
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    if (failure !== null) throw failure;
    const missing = src.plan.order.filter((name) => !this.present.has(name)).length;
    if (missing > 0) throw new CacheFailure('download_failed', `${missing} file(s) were not downloaded`);
  }

  /** One fetch per file at a time: a second caller joins the first. */
  private ensure(name: string): Promise<void> {
    if (this.present.has(name)) return Promise.resolve();
    const running = this.inflight.get(name);
    if (running !== undefined) return running;
    const job = this.download(name).finally(() => {
      this.inflight.delete(name);
    });
    this.inflight.set(name, job);
    return job;
  }

  private async download(name: string): Promise<void> {
    let attempt = 1;
    for (;;) {
      if (this.source === null) await this.gate.promise;
      const src = this.current();
      const file = src.plan.files.get(name);
      if (file === undefined) return;
      const got = await fetchUpstream(this.deps.fetch, src.session, file.url, { range: file.range, maxBytes: SEGMENT_MAX_BYTES, signal: this.abort.signal });
      if (got.kind === 'ok') {
        // The source changed shape while this was in flight: the folder is about to be emptied.
        if (this.source === null || this.source.plan.signature !== src.plan.signature) return;
        await this.deps.store.write(this.id, name, got.body);
        this.present.add(name);
        this.bytes += got.body.length;
        if (file.counts) this.counted += 1;
        this.refreshes = 0;
        await this.flush();
        return;
      }
      if (got.kind === 'refused') {
        await this.refresh(src.generation, `${name} (HTTP ${got.status})`);
        continue;
      }
      if (got.kind === 'retry' && attempt < SEGMENT_ATTEMPTS) {
        await this.deps.sleep(backoffMs(attempt), this.abort.signal);
        attempt += 1;
        continue;
      }
      throw new CacheFailure('download_failed', `${name}: ${got.detail}${got.kind === 'retry' ? ` (${attempt} tries)` : ''}`);
    }
  }

  /** A fresh resolve for every file refused under `generation`, run once; later callers wait for it. */
  private refresh(generation: number, why: string): Promise<void> {
    const current = this.source;
    if (current === null) return this.gate.promise;
    if (current.generation !== generation) return Promise.resolve();
    this.refreshing ??= this.renew(current, why).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async renew(current: Source, why: string): Promise<void> {
    this.bumpRefresh(why);
    this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: the stream host refused ${why}; resolving again`);
    const { session, plan } = await this.planFor(await this.resolveNow());
    if (plan.signature === current.plan.signature) {
      this.generation += 1;
      this.source = { generation: this.generation, session, plan };
      return;
    }
    this.source = null;
    this.gate = new Gate();
    throw new SourceChanged(session, plan);
  }

  private async flush(): Promise<void> {
    const at = this.deps.now().getTime();
    if (at - this.lastFlush < PROGRESS_FLUSH_MS) return;
    this.lastFlush = at;
    const p = this.progress();
    if (p === null) return;
    try {
      await this.deps.recorder.progress(this.id, p.segmentsDone, p.bytes);
    } catch (err) {
      this.deps.log(`[notesd] stream cache: could not record progress: ${messageOf(err)}`);
    }
  }

  /** The English subtitle, once per download; never fails it. */
  private async saveSubtitle(session: StreamSession): Promise<boolean> {
    try {
      if (!(await this.deps.store.has(this.id, 'subtitle.vtt'))) {
        const vtt = await englishSubtitle(this.deps.fetch, session, this.abort.signal);
        if (vtt === null) return false;
        await this.deps.store.write(this.id, 'subtitle.vtt', vtt);
      }
      await this.deps.recorder.subtitle(this.id, true);
      return true;
    } catch (err) {
      if (!this.abort.signal.aborted) this.deps.log(`[notesd] stream cache: ${refLabel(this.ref)}: no subtitle saved: ${messageOf(err)}`);
      return false;
    }
  }
}
```
**Impact:** none outside the folder; unit-tested in step 11.

### Step 11: Unit tests for the parsers, the downloader and Range
**Files:** `tests/unit/directStream/cache/hls.test.ts`, `tests/unit/directStream/cache/job.test.ts`, `tests/unit/directStream/cache/serve.test.ts` (new)
**Code:**

`tests/unit/directStream/cache/hls.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  HlsUnsupported,
  isMaster,
  localMaster,
  localMediaPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  pickAudio,
  pickVariant,
  type HlsRendition,
  type HlsVariant,
} from '../../../../src/directStream/cache/hls.js';

const variant = (height: number | null, bandwidth: number, url = `https://cdn.test/${height}.m3u8`): HlsVariant => ({
  url,
  bandwidth,
  averageBandwidth: null,
  width: height === null ? null : Math.round((height * 16) / 9),
  height,
  codecs: null,
  frameRate: null,
  audioGroup: null,
});

const rendition = (language: string | null, name: string | null, isDefault = false): HlsRendition => ({
  type: 'AUDIO',
  groupId: 'aud',
  name,
  language,
  isDefault,
  channels: null,
  url: `https://cdn.test/${language ?? name}.m3u8`,
});

function unsupported(fn: () => unknown): HlsUnsupported {
  try {
    fn();
  } catch (err) {
    if (err instanceof HlsUnsupported) return err;
    throw err;
  }
  throw new Error('expected HlsUnsupported');
}

describe('parseAttributes', () => {
  it('reads quoted values with commas and bare values', () => {
    const a = parseAttributes('BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"');
    expect([...a.entries()]).toEqual([
      ['BANDWIDTH', '800000'],
      ['CODECS', 'avc1.4d401f,mp4a.40.2'],
      ['RESOLUTION', '1280x720'],
      ['AUDIO', 'aud'],
    ]);
  });
});

describe('parseMaster', () => {
  it("resolves a master served as VidNest's master.txt against its own address", () => {
    const text = '﻿#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="aud"\n720/index.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,URI="/audio/ja.m3u8"\n';
    expect(isMaster(text)).toBe(true);
    const master = parseMaster(text, 'https://cdn.vidnest.test/x/y/master.txt?t=1');
    expect(master.variants).toEqual([
      { url: 'https://cdn.vidnest.test/x/y/720/index.m3u8', bandwidth: 900000, averageBandwidth: null, width: 1280, height: 720, codecs: null, frameRate: null, audioGroup: 'aud' },
    ]);
    expect(master.media).toEqual([{ type: 'AUDIO', groupId: 'aud', name: 'Japanese', language: 'ja', isDefault: true, channels: null, url: 'https://cdn.vidnest.test/audio/ja.m3u8' }]);
  });

  it('refuses a text that is no playlist, and a master without a rendition', () => {
    expect(unsupported(() => parseMaster('<html>', 'https://x.test/a')).reason).toBe('not_a_playlist');
    expect(unsupported(() => parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', 'https://x.test/a')).reason).toBe('empty');
  });
});

describe('pickVariant', () => {
  const all = [variant(360, 500), variant(1080, 4000), variant(720, 1500), variant(720, 2000, 'https://cdn.test/720b.m3u8')];
  it('takes the tallest, the widest of equal heights', () => {
    expect(pickVariant(all, null).height).toBe(1080);
    expect(pickVariant(all, 720).url).toBe('https://cdn.test/720b.m3u8');
  });
  it('takes the tallest not above max_height, else the shortest', () => {
    expect(pickVariant(all, 1000).height).toBe(720);
    expect(pickVariant(all, 480).height).toBe(360);
    expect(pickVariant(all, 200).height).toBe(360);
  });
  it('ranks by bandwidth when no rendition names a resolution', () => {
    expect(pickVariant([variant(null, 100, 'https://a.test/a'), variant(null, 300, 'https://a.test/b')], 720).url).toBe('https://a.test/b');
  });
});

describe('pickAudio', () => {
  const tracks = [rendition('en', 'English', true), rendition('ko', 'Korean'), rendition('ko', 'Korean (commentary)'), rendition(null, 'Original')];
  it("takes the resolver's original-language track by language and name, as the player does", () => {
    expect(pickAudio(tracks, 'aud', { track: { lang: 'ko', label: 'Korean (commentary)' }, lang: 'ko' })?.name).toBe('Korean (commentary)');
    expect(pickAudio(tracks, 'aud', { track: { lang: 'KO', label: 'Other' }, lang: null })?.name).toBe('Korean');
    expect(pickAudio(tracks, 'aud', { track: { lang: null, label: 'Original' }, lang: null })?.name).toBe('Original');
  });
  it("falls back to the title's original language, then the default", () => {
    expect(pickAudio([rendition('ko-KR', 'Korean'), rendition('en', 'English', true)], 'aud', { track: null, lang: 'ko' })?.name).toBe('Korean');
    expect(pickAudio(tracks, 'aud', { track: null, lang: 'fr' })?.name).toBe('English');
  });
  it('answers null without a group', () => {
    expect(pickAudio(tracks, null, { track: null, lang: 'ko' })).toBeNull();
    expect(pickAudio(tracks, 'other', { track: null, lang: 'ko' })).toBeNull();
  });
});

describe('parseMedia', () => {
  const BASE = 'https://cdn.test/v/index.m3u8';
  it('reads byte ranges (with and without offset), an init section with a range, keys with and without IV, and discontinuities', () => {
    const media = parseMedia(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-DISCONTINUITY-SEQUENCE:2',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
        '#EXT-X-KEY:METHOD=AES-128,URI="/k?t=1",IV=0x0A',
        '#EXTINF:4.0,first',
        '#EXT-X-BYTERANGE:1000@100',
        'media.mp4',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000',
        'media.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T00:00:00Z',
        '#EXTINF:3.5,',
        'https://other.test/p3.m4s',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXT-X-GAP',
        '#EXTINF:2,',
        'p4.m4s',
        '#EXT-X-ENDLIST',
      ].join('\r\n'),
      BASE,
    );
    expect(media).toMatchObject({ version: 7, targetDuration: 4, mediaSequence: 10, discontinuitySequence: 2 });
    expect(media.maps).toEqual([{ url: 'https://cdn.test/v/init.mp4', range: { length: 100, offset: 0 } }]);
    expect(media.keys).toEqual([
      { url: 'https://cdn.test/k?t=1', inline: null, iv: '0x0A', keyFormat: null, keyFormatVersions: null },
      { url: null, inline: 'data:text/plain;base64,AAAA', iv: null, keyFormat: null, keyFormatVersions: null },
    ]);
    expect(media.segments.map((s) => [s.url, s.duration, s.title, s.range, s.key, s.map, s.tags, s.gap])).toEqual([
      ['https://cdn.test/v/media.mp4', 4, 'first', { length: 1000, offset: 100 }, 0, 0, [], false],
      ['https://cdn.test/v/media.mp4', 4, '', { length: 1000, offset: 1100 }, 0, 0, [], false],
      ['https://other.test/p3.m4s', 3.5, '', null, 1, 0, ['#EXT-X-DISCONTINUITY', '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T00:00:00Z'], false],
      ['https://cdn.test/v/p4.m4s', 2, '', null, null, 0, ['#EXT-X-GAP'], true],
    ]);
  });

  it('refuses DRM, a live playlist, an empty one and a range without a start', () => {
    const head = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
    expect(unsupported(() => parseMedia(`${head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'drm' });
    expect(unsupported(() => parseMedia(`${head}#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'drm' });
    expect(unsupported(() => parseMedia(`${head}#EXTINF:4,\na.ts\n`, BASE))).toMatchObject({ reason: 'live' });
    expect(unsupported(() => parseMedia(`${head}#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'empty' });
    expect(unsupported(() => parseMedia(`${head}#EXTINF:4,\n#EXT-X-BYTERANGE:10\na.ts\n#EXT-X-ENDLIST\n`, BASE))).toMatchObject({ reason: 'not_a_playlist' });
  });
});

describe('local playlists', () => {
  it('name every segment by position, keep the media sequence, IV, discontinuities and gaps, and drop byte ranges', () => {
    const media = parseMedia(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:4',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="k1",IV=0x01,KEYFORMAT="identity"',
        '#EXTINF:4.0,',
        '#EXT-X-BYTERANGE:10@0',
        'a.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:4.5,',
        'b.m4s',
        '#EXT-X-GAP',
        '#EXTINF:4.004,',
        'c.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.test/index.m3u8',
    );
    expect(localMediaPlaylist(media, 'v').split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:5',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key",IV=0x01,KEYFORMAT="identity"',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:4.5,',
      'v-00002.m4s',
      '#EXT-X-GAP',
      '#EXTINF:4.004,',
      'v-00003.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
  });

  it('write a master of the one variant, with its audio rendition when it is separate', () => {
    const v = { bandwidth: 2400000, averageBandwidth: 2000000, width: 1280, height: 720, codecs: 'avc1.4d401f,mp4a.40.2', frameRate: '23.976' };
    expect(localMaster(v, { ...rendition('ko', 'Korean'), channels: '2' }, true).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Korean",LANGUAGE="ko",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=23.976,AUDIO="audio"',
      'video.m3u8',
      '',
    ]);
    expect(localMaster({ ...v, averageBandwidth: null, codecs: null, frameRate: null, width: null, height: null, bandwidth: 0 }, null, false)).toBe(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n',
    );
  });
});
```

`tests/unit/directStream/cache/serve.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileResponse, parseRange } from '../../../../src/directStream/cache/serve.js';

describe('parseRange', () => {
  it('reads one range against a size', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  it('refuses what cannot be served', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=9-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('fileResponse', () => {
  let dir: string;
  let file: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cache-serve-'));
    file = path.join(dir, 'v-00001.ts');
    await writeFile(file, Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers the whole file, a range, and 416 past the end', async () => {
    const whole = await fileResponse(file, 'v-00001.ts', null);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp2t');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect((await whole.arrayBuffer()).byteLength).toBe(100);
    const part = await fileResponse(file, 'v-00001.ts', 'bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const past = await fileResponse(file, 'v-00001.ts', 'bytes=200-');
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */100');
  });
});
```

`tests/unit/directStream/cache/job.test.ts`:
```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheJob, type CacheJobDeps, type CacheRecorder } from '../../../../src/directStream/cache/job.js';
import { CacheStore } from '../../../../src/directStream/cache/store.js';
import type { FetchLike } from '../../../../src/directStream/passThrough.js';
import type { CachePlanned } from '../../../../src/directStream/repo.js';
import { SessionStore, type StreamSession } from '../../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../../src/directStream/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const CDN = 'https://cdn.test';

interface HostRequest {
  path: string;
  range: string | null;
  referer: string | null;
}

/** A stream host in memory: answers by path, honours abort, logs what arrived and what was answered. */
function fakeHost(handle: (req: HostRequest, n: number) => Response | Promise<Response>) {
  const arrivals: string[] = [];
  const answered: { path: string; status: number }[] = [];
  const counts = new Map<string, number>();
  const fetch: FetchLike = (url, init) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const n = (counts.get(u.pathname) ?? 0) + 1;
    counts.set(u.pathname, n);
    arrivals.push(u.pathname);
    const signal = init.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(handle({ path: u.pathname, range: headers.range ?? null, referer: headers.referer ?? null }, n)).then(
        (res) => {
          signal?.removeEventListener('abort', onAbort);
          answered.push({ path: u.pathname, status: res.status });
          resolve(res);
        },
        reject,
      );
    });
  };
  return { fetch, arrivals, answered, ok: (p: string): number => answered.filter((a) => a.path === p && a.status < 300).length };
}
type Host = ReturnType<typeof fakeHost>;

const playlist = (text: string): Response => new Response(text, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const status = (code: number): Response => new Response('no', { status: code });
function bytes(body: Buffer, range: string | null): Response {
  const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
  if (m === null) return new Response(new Uint8Array(body), { status: 200 });
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), body.length - 1);
  return new Response(new Uint8Array(body.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } });
}
const media = (segments: number, prefix = 'seg'): string =>
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', ...Array.from({ length: segments }, (_, i) => ['#EXTINF:4.0,', `${prefix}${i + 1}.ts`]).flat(), '#EXT-X-ENDLIST', ''].join('\n');

function session(manifest: string, over: Partial<ResolvedSource> = {}, audioLang: string | null = null): StreamSession {
  const source: ResolvedSource = {
    provider: 'Bravo',
    embed_url: 'https://embed.test/',
    manifest_url: manifest,
    manifest_kind: 'hls',
    headers: { referer: 'https://embed.test/', origin: null, user_agent: 'UA' },
    subtitles: [],
    best_height: null,
    en_subtitle: false,
    took_s: 1,
    ...over,
  };
  return new SessionStore().create(REF, source, [], null, audioLang);
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface SetupOptions {
  maxHeight?: number | null;
  root?: string;
  chunkBytes?: number;
  parallel?: number;
}

async function setup(host: Host, resolve: (n: number) => StreamSession, options: SetupOptions = {}) {
  const root = options.root ?? (await mkdtemp(path.join(os.tmpdir(), 'cache-job-')));
  if (options.root === undefined) roots.push(root);
  const calls = { resolved: 0, planned: [] as CachePlanned[], progress: [] as number[], subtitle: [] as boolean[] };
  const recorder: CacheRecorder = {
    resolved: async () => {
      calls.resolved += 1;
    },
    planned: async (_id, p) => {
      calls.planned.push(p);
    },
    progress: async (_id, done) => {
      calls.progress.push(done);
    },
    subtitle: async (_id, saved) => {
      calls.subtitle.push(saved);
    },
  };
  const sleeps: number[] = [];
  let resolves = 0;
  const deps: CacheJobDeps = {
    store: new CacheStore(root),
    recorder,
    resolve: async () => {
      resolves += 1;
      return resolve(resolves);
    },
    fetch: host.fetch,
    now: () => new Date('2026-11-16T00:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: () => undefined,
    parallel: options.parallel ?? 1,
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
  };
  const job = new CacheJob(ID, REF, options.maxHeight ?? null, deps);
  return {
    job,
    root,
    calls,
    sleeps,
    resolves: (): number => resolves,
    file: (name: string): Promise<Buffer> => readFile(path.join(root, ID, name)),
    names: async (): Promise<string[]> => (await readdir(path.join(root, ID))).sort(),
  };
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  '360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  '1080/index.m3u8',
  '',
].join('\n');

describe('CacheJob', () => {
  it('caches the highest rendition not above max_height, with its English subtitle, and writes the local playlists first', async () => {
    const host = fakeHost((r) => {
      if (r.path === '/master.m3u8') return playlist(MASTER);
      if (/^\/(360|720|1080)\/index\.m3u8$/.test(r.path)) return playlist(media(3));
      if (/\/seg\d\.ts$/.test(r.path)) return bytes(Buffer.from(r.path), r.range);
      if (r.path === '/en.srt') return new Response('1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
      return status(404);
    });
    const t = await setup(host, () => session(`${CDN}/master.m3u8`, { subtitles: [{ url: `${CDN}/en.srt`, lang: 'en', label: 'English', format: 'srt', source: 'request' }] }), { maxHeight: 720 });
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 3, bytes: 36, subtitle: true });
    expect(host.answered.map((a) => a.path).filter((p) => p.endsWith('.m3u8'))).toEqual(['/master.m3u8', '/720/index.m3u8']);
    expect((await t.file('v-00002.ts')).toString()).toBe('/720/seg2.ts');
    expect(await t.names()).toEqual(['cache.json', 'master.m3u8', 'subtitle.vtt', 'v-00001.ts', 'v-00002.ts', 'v-00003.ts', 'video.m3u8']);
    expect((await t.file('master.m3u8')).toString()).toBe(
      ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"', 'video.m3u8', ''].join('\n'),
    );
    expect((await t.file('subtitle.vtt')).toString()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    expect(t.calls.planned).toEqual([{ provider: 'Bravo', manifestKind: 'hls', height: 720, audioLang: null, segmentsTotal: 3, segmentsDone: 0, bytes: 0, durationS: 12 }]);
    expect(t.calls.subtitle).toEqual([true]);
    expect(t.calls.resolved).toBe(1);
  });

  it('retries a failing segment with backoff', async () => {
    const host = fakeHost((r, n) => (r.path === '/index.m3u8' ? playlist(media(3)) : r.path === '/seg2.ts' && n <= 2 ? status(503) : bytes(Buffer.from(r.path), r.range)));
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(t.sleeps).toEqual([1000, 2000]);
    expect(host.ok('/seg2.ts')).toBe(1);
    expect(host.arrivals.filter((p) => p === '/seg2.ts')).toHaveLength(3);
  });

  it('fails after six tries of one segment', async () => {
    const host = fakeHost((r) => (r.path === '/index.m3u8' ? playlist(media(3)) : r.path === '/seg2.ts' ? status(503) : bytes(Buffer.from(r.path), r.range)));
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect(await t.job.run()).toEqual({ state: 'failed', error: 'download_failed', detail: 'v-00002.ts: HTTP 503 (6 tries)' });
    expect(t.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('resolves again on a refused token and keeps the segments already on disk, matched by index', async () => {
    const host = fakeHost((r) => {
      const m = /^\/t(\d)\/(.+)$/.exec(r.path);
      if (m === null) return status(404);
      if (m[2] === 'index.m3u8') return playlist(media(5));
      const seg = Number(/^seg(\d+)\.ts$/.exec(m[2] ?? '')?.[1] ?? 0);
      if (m[1] === '1' && seg >= 3) return status(403);
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, (n) => session(`${CDN}/t${n}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(t.resolves()).toBe(2);
    expect(t.calls.resolved).toBe(2);
    expect(host.ok('/t1/seg1.ts')).toBe(1);
    expect(host.ok('/t1/seg2.ts')).toBe(1);
    expect(host.arrivals).not.toContain('/t2/seg1.ts');
    expect(host.arrivals).not.toContain('/t2/seg2.ts');
    expect((await t.file('v-00002.ts')).toString()).toBe('/t1/seg2.ts');
    expect((await t.file('v-00005.ts')).toString()).toBe('/t2/seg5.ts');
    expect(t.calls.planned).toHaveLength(1);
  });

  it('starts over when the fresh source has another shape', async () => {
    const host = fakeHost((r) => {
      const m = /^\/t(\d)\/(.+)$/.exec(r.path);
      if (m === null) return status(404);
      if (m[2] === 'index.m3u8') return playlist(media(m[1] === '1' ? 5 : 6));
      const seg = Number(/^seg(\d+)\.ts$/.exec(m[2] ?? '')?.[1] ?? 0);
      if (m[1] === '1' && seg >= 3) return status(403);
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, (n) => session(`${CDN}/t${n}/index.m3u8`));
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 6, bytes: 6 * '/t2/seg1.ts'.length, subtitle: false });
    expect(host.ok('/t2/seg1.ts')).toBe(1);
    expect((await t.file('v-00001.ts')).toString()).toBe('/t2/seg1.ts');
    expect((await t.names()).filter((n) => n.startsWith('v-'))).toHaveLength(6);
    expect(t.calls.planned).toHaveLength(2);
  });

  it('fails as token_refused after three fresh resolves without progress', async () => {
    const host = fakeHost((r) => (r.path === '/t1/index.m3u8' ? playlist(media(3)) : status(403)));
    const t = await setup(host, () => session(`${CDN}/t1/index.m3u8`));
    expect(await t.job.run()).toMatchObject({ state: 'failed', error: 'token_refused' });
    expect(t.resolves()).toBe(4);
  });

  it('stops on cancel, and a new run carries on from the files on disk', async () => {
    let block = true;
    const host = fakeHost((r) =>
      r.path === '/index.m3u8' ? playlist(media(5)) : r.path === '/seg3.ts' && block ? new Promise<Response>(() => undefined) : bytes(Buffer.from(r.path), r.range),
    );
    const a = await setup(host, () => session(`${CDN}/index.m3u8`));
    const running = a.job.run();
    await until(() => host.arrivals.includes('/seg3.ts'));
    a.job.cancel();
    expect(await running).toEqual({ state: 'cancelled' });
    expect(host.arrivals).not.toContain('/seg4.ts');
    expect(await a.names()).toEqual(['cache.json', 'master.m3u8', 'v-00001.ts', 'v-00002.ts', 'video.m3u8']);
    block = false;
    const b = await setup(host, () => session(`${CDN}/index.m3u8`), { root: a.root });
    expect((await b.job.run()).state).toBe('ready');
    expect(host.ok('/seg1.ts')).toBe(1);
    expect(host.ok('/seg2.ts')).toBe(1);
    expect(host.ok('/seg3.ts')).toBe(1);
    expect(b.calls.planned[0]?.segmentsDone).toBe(2);
  });

  it('fetches a file asked for now ahead of the queue, once', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = fakeHost(async (r) => {
      if (r.path === '/index.m3u8') return playlist(media(6));
      if (r.path === '/seg1.ts') await held;
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    const running = t.job.run();
    await until(() => host.arrivals.includes('/seg1.ts'));
    await t.job.fetchNow('v-00005.ts');
    expect((await t.file('v-00005.ts')).toString()).toBe('/seg5.ts');
    expect(host.arrivals).toEqual(['/index.m3u8', '/seg1.ts', '/seg5.ts']);
    release();
    expect((await running).state).toBe('ready');
    expect(host.arrivals.filter((p) => p === '/seg5.ts')).toHaveLength(1);
  });

  it('answers cache_unsupported for DASH, DRM and a live playlist', async () => {
    const dash = fakeHost(() => status(404));
    const t1 = await setup(dash, () => session(`${CDN}/m.mpd`, { manifest_kind: 'dash' }));
    expect(await t1.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported' });
    expect(dash.arrivals).toEqual([]);
    const drm = fakeHost(() => playlist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n'));
    const t2 = await setup(drm, () => session(`${CDN}/index.m3u8`));
    expect(await t2.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported', detail: expect.stringMatching(/SAMPLE-AES/) });
    const live = fakeHost(() => playlist('#EXTM3U\n#EXTINF:4,\na.ts\n'));
    const t3 = await setup(live, () => session(`${CDN}/index.m3u8`));
    expect(await t3.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported', detail: expect.stringMatching(/live/) });
  });

  it('downloads a plain file by ranges and joins it', async () => {
    const film = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
    const host = fakeHost((r) => (r.path === '/film.mp4' ? bytes(film, r.range) : status(404)));
    const t = await setup(host, () => session(`${CDN}/film.mp4`, { manifest_kind: 'mp4' }), { chunkBytes: 1000 });
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 3, bytes: 2500, subtitle: false });
    expect(await t.file('video.mp4')).toEqual(film);
    expect((await t.names()).filter((n) => n.startsWith('c-'))).toEqual([]);
  });

  it('caches byte-range segments, an fMP4 init section, an AES-128 key with its IV, and a discontinuity', async () => {
    const mediaFile = Buffer.from(Array.from({ length: 2100 }, (_, i) => i % 256));
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-MAP:URI="media.mp4",BYTERANGE="100@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1?tok=1",IV=0x0000000000000000000000000000000A',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1000@100',
      'media.mp4',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1000',
      'media.mp4',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:3.5,',
      'part3.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const host = fakeHost((r) => {
      if (r.path === '/index.m3u8') return playlist(text);
      if (r.path === '/media.mp4') return bytes(mediaFile, r.range);
      if (r.path === '/k1') return new Response(new Uint8Array(Buffer.alloc(16, 9)));
      if (r.path === '/part3.m4s') return bytes(Buffer.from('third'), r.range);
      return status(404);
    });
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(await t.file('v-init-1.mp4')).toEqual(mediaFile.subarray(0, 100));
    expect(await t.file('v-00001.m4s')).toEqual(mediaFile.subarray(100, 1100));
    expect(await t.file('v-00002.m4s')).toEqual(mediaFile.subarray(1100, 2100));
    expect(await t.file('v-key-1.key')).toEqual(Buffer.alloc(16, 9));
    expect((await t.file('video.m3u8')).toString().split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key",IV=0x0000000000000000000000000000000A',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXTINF:4.0,',
      'v-00002.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:3.5,',
      'v-00003.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
  });

  it('takes the audio rendition in the original language the session names, never the default dub', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Korean",LANGUAGE="ko",AUTOSELECT=YES,CHANNELS="2",URI="audio/ko.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
      '720.m3u8',
      '',
    ].join('\n');
    const host = fakeHost((r) => {
      if (r.path === '/master.m3u8') return playlist(master);
      if (r.path === '/720.m3u8') return playlist(media(2, 'v'));
      if (r.path === '/audio/ko.m3u8') return playlist(media(2, 'k'));
      if (r.path === '/audio/en.m3u8') return playlist(media(2, 'e'));
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, () => session(`${CDN}/master.m3u8`, { audio: { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'ko', label: 'Korean' } } }, 'ko'));
    expect(await t.job.run()).toMatchObject({ state: 'ready', segments: 4 });
    expect(host.arrivals.some((p) => p.startsWith('/audio/e'))).toBe(false);
    expect((await t.file('a-00002.ts')).toString()).toBe('/audio/k2.ts');
    expect((await t.file('master.m3u8')).toString()).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Korean",LANGUAGE="ko",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="audio"',
        'video.m3u8',
        '',
      ].join('\n'),
    );
    expect(t.calls.planned[0]?.audioLang).toBe('ko');
  });
});
```
**Impact:** `npx vitest run tests/unit/directStream/cache` passes.

### Step 12: `StreamCache`: queue, views, the file route's logic, and its builder
**File:** `src/directStream/cache/service.ts` (new)
**Code:**
```ts
import path from 'node:path';
import type { Config } from '../../config.js';
import type { StreamCacheRow } from '../../db/schema.js';
import { jsonError, type FetchLike } from '../passThrough.js';
import { cacheRef, type DirectStreamRepo } from '../repo.js';
import type { StreamSession } from '../sessions.js';
import { refLabel, type SourceAudio, type StreamRef } from '../types.js';
import { CacheJob, type CacheJobDeps, type CacheRecorder, type JobOutcome } from './job.js';
import { fileResponse } from './serve.js';
import { CacheStore, SERVED_NAME } from './store.js';
import { CACHE_ID_PATTERN, CacheError, CacheFailure, STREAM_CACHE_SUBDIR, type StreamCacheView } from './types.js';

/** Downloads that run at once on this host; the rest wait their turn (`queued`). */
export const CACHE_JOBS = 1;

export interface StreamCacheOptions {
  repo: DirectStreamRepo;
  /** os.hostname(): rows are made under it, and only its rows' files are here. */
  host: string;
  /** The folder holding one folder per cache id. */
  root: string;
  /** DirectStreamService.resolve. */
  resolve: (ref: StreamRef) => Promise<StreamSession>;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  /** Files fetched at once per download (job.ts CACHE_PARALLEL). */
  parallel?: number;
  /** Downloads at once (CACHE_JOBS). */
  jobs?: number;
  /** A plain file's chunk size (plan.ts MP4_CHUNK_BYTES). */
  chunkBytes?: number;
}

/**
 * What a play (phase 6, src/directStream/cachePlay.ts CachePlayView) reads of a cache. Only a
 * cache whose source is known (provider and manifest kind set) is answered.
 */
export interface CachePlayData {
  id: string;
  ref: StreamRef;
  host: string;
  state: 'downloading' | 'ready' | 'failed';
  provider: string;
  height: number | null;
  manifestKind: 'hls' | 'mp4';
  manifestUrl: string;
  subtitles: { url: string; lang: string | null; label: string }[];
  audioLang: string | null;
  audio: SourceAudio | null;
}

interface Waiting {
  id: string;
  ref: StreamRef;
  maxHeight: number | null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A setTimeout that an abort ends early (rejecting with the abort's reason). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The stream cache of this host (STREAM_CACHE_AND_BUG_REPORT phase 5): films and episodes
 * downloaded to `root`, recorded in stream_caches (through DirectStreamRepo). Downloads run one
 * at a time in the daemon (job.ts); a daemon start carries unfinished ones on (`start`). A row of
 * the other host is listed `available: false`; its files and its delete answer not_on_this_machine.
 * Held in AppDeps.streamCache; the routes (src/http/streamCacheApi.ts) and direct_stream_cache call it.
 */
export class StreamCache {
  private readonly repo: DirectStreamRepo;
  private readonly store: CacheStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly jobDeps: CacheJobDeps;
  private readonly jobsAtOnce: number;
  private waiting: Waiting[] = [];
  private readonly running = new Map<string, CacheJob>();
  private readonly settling = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly opts: StreamCacheOptions) {
    this.repo = opts.repo;
    this.store = new CacheStore(opts.root);
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.jobsAtOnce = Math.max(1, opts.jobs ?? CACHE_JOBS);
    const recorder: CacheRecorder = {
      resolved: (id) => this.repo.cacheResolved(id, this.now()),
      planned: (id, planned) => this.repo.cachePlanned(id, planned, this.now()),
      progress: (id, done, bytes) => this.repo.cacheProgress(id, done, bytes, this.now()),
      subtitle: (id, saved) => this.repo.cacheSubtitle(id, saved, this.now()),
    };
    this.jobDeps = {
      store: this.store,
      recorder,
      resolve: opts.resolve,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      now: this.now,
      sleep: opts.sleep ?? abortableSleep,
      log: this.log,
      ...(opts.parallel === undefined ? {} : { parallel: opts.parallel }),
      ...(opts.chunkBytes === undefined ? {} : { chunkBytes: opts.chunkBytes }),
    };
  }

  get host(): string {
    return this.opts.host;
  }

  get root(): string {
    return this.opts.root;
  }

  /** Queues this host's unfinished downloads (a daemon start). Returns how many. */
  async start(): Promise<number> {
    const rows = await this.repo.unfinishedCaches(this.host);
    for (const row of rows) this.enqueue({ id: row.id, ref: cacheRef(row), maxHeight: row.maxHeight });
    return rows.length;
  }

  /** Stops every download (their rows stay `downloading` for the next start) and waits for them. */
  async close(): Promise<void> {
    this.closed = true;
    this.waiting = [];
    for (const job of this.running.values()) job.cancel();
    await Promise.allSettled([...this.settling.values()]);
  }

  /**
   * Caches `ref` on this host: a new row starts downloading; a failed one starts again from what
   * is on disk; a ready or running one is answered as it is (`started: false`). A different
   * `maxHeight` than the existing cache's throws `cache_exists` (clear it first).
   */
  async request(ref: StreamRef, options: { maxHeight: number | null }): Promise<{ cache: StreamCacheView; started: boolean }> {
    if (this.closed) throw new Error('the stream cache is closing');
    const { row, created } = await this.repo.createCache(this.host, ref, options.maxHeight, this.now());
    if (!created && options.maxHeight !== null && row.maxHeight !== options.maxHeight) {
      throw new CacheError(
        'cache_exists',
        `This machine already holds ${refLabel(ref)} ${row.maxHeight === null ? 'at the highest quality' : `at ${row.maxHeight}p or below`}; clear that cache first to cache another quality.`,
        { cache: this.view(row) },
      );
    }
    if (row.state === 'ready') return { cache: this.view(row), started: false };
    if (row.state === 'failed') await this.repo.cacheRestarted(row.id, this.now());
    const started = this.enqueue({ id: row.id, ref, maxHeight: row.maxHeight });
    return { cache: this.view((await this.repo.cacheById(row.id)) ?? row), started };
  }

  /** Every cache of both hosts, newest first. */
  async list(): Promise<StreamCacheView[]> {
    return (await this.repo.caches()).map((row) => this.view(row));
  }

  /** The cache with this id on either host, or null (a malformed id included). */
  async get(id: string): Promise<StreamCacheView | null> {
    const row = await this.rowOf(id);
    return row === null ? null : this.view(row);
  }

  /** This host's cache of `ref` in any state, or null. */
  async find(ref: StreamRef): Promise<StreamCacheView | null> {
    const row = await this.repo.cacheFor(this.host, ref);
    return row === null ? null : this.view(row);
  }

  /** This host's cache of `ref` when it is complete, or null. */
  async findReady(ref: StreamRef): Promise<StreamCacheView | null> {
    const view = await this.find(ref);
    return view !== null && view.state === 'ready' ? view : null;
  }

  /** Every host's cache of `ref`. */
  async forRef(ref: StreamRef): Promise<StreamCacheView[]> {
    return (await this.repo.cachesOf(ref)).map((row) => this.view(row));
  }

  /** Phase 6's reads (cachePlay.ts PlayableCaches): `find` on this host, `get` on any host, as CachePlayData. */
  player(): { find(ref: StreamRef): Promise<CachePlayData | null>; get(id: string): Promise<CachePlayData | null> } {
    return {
      find: async (ref) => {
        const row = await this.repo.cacheFor(this.host, ref);
        return row === null ? null : this.playData(row);
      },
      get: async (id) => {
        const row = await this.rowOf(id);
        return row === null ? null : this.playData(row);
      },
    };
  }

  /** Stops the download, deletes the folder and the row. Throws unknown_cache, or not_on_this_machine for the other host's. */
  async remove(id: string): Promise<void> {
    const row = await this.rowOf(id);
    if (row === null) throw new CacheError('unknown_cache', 'No stream cache has this id.');
    if (row.host !== this.host) throw new CacheError('not_on_this_machine', `This cache was made on ${row.host}; clear it there.`, { host: row.host });
    this.waiting = this.waiting.filter((w) => w.id !== row.id);
    const job = this.running.get(row.id);
    if (job !== undefined) {
      job.cancel();
      await this.settling.get(row.id);
    }
    await this.store.remove(row.id);
    await this.repo.deleteCache(row.id);
    this.log(`[notesd] stream cache: cleared ${refLabel(cacheRef(row))}`);
  }

  /**
   * GET /api/stream/cache/:id/f/:name. A file on disk is served with Range. While the cache
   * downloads, a file not on disk yet is fetched now, ahead of the queue, and stored; a plain
   * file is answered chunk by chunk. 404 unknown_cache / not_on_this_machine / not_found,
   * 409 cache_failed, 502 upstream_error.
   */
  async file(id: string, name: string, request: { range: string | null }): Promise<Response> {
    const row = await this.rowOf(id);
    if (row === null) return jsonError(404, 'unknown_cache', 'No stream cache has this id.');
    if (row.host !== this.host) {
      return new Response(JSON.stringify({ error: 'not_on_this_machine', host: row.host, message: `This cache was made on ${row.host}; its files are only there.` }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!SERVED_NAME.test(name)) return jsonError(404, 'not_found', 'A stream cache has no file of that name.');
    const onDisk = this.store.file(row.id, name);
    if (await this.store.has(row.id, name)) return fileResponse(onDisk, name, request.range);
    if (row.state === 'ready') return jsonError(404, 'not_found', 'That file is not part of this cache.');
    if (row.state === 'failed') return jsonError(409, 'cache_failed', `This cache stopped (${row.error ?? 'failed'}); ask for it again to carry on.`);
    if (this.closed) return jsonError(503, 'closing', 'The daemon is stopping.');
    const job = this.running.get(row.id) ?? this.launchNow(row);
    try {
      if (name === 'video.mp4') return await job.mp4Answer(request.range);
      await job.fetchNow(name);
    } catch (err) {
      return jsonError(502, 'upstream_error', `The file could not be fetched now: ${err instanceof CacheFailure ? `${err.code}: ${err.message}` : messageOf(err)}`);
    }
    return (await this.store.has(row.id, name)) ? fileResponse(onDisk, name, request.range) : jsonError(404, 'not_found', 'That file is not part of this cache.');
  }

  private async rowOf(id: string): Promise<StreamCacheRow | null> {
    return CACHE_ID_PATTERN.test(id) ? this.repo.cacheById(id.toLowerCase()) : null;
  }

  private enqueue(w: Waiting): boolean {
    if (this.closed || this.running.has(w.id) || this.waiting.some((x) => x.id === w.id)) return false;
    this.waiting.push(w);
    this.pump();
    return true;
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.jobsAtOnce) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      this.launch(next);
    }
  }

  /** The file route's turn for a cache that waits (or that no download serves): run it now, beside the others. */
  private launchNow(row: StreamCacheRow): CacheJob {
    this.waiting = this.waiting.filter((w) => w.id !== row.id);
    return this.launch({ id: row.id, ref: cacheRef(row), maxHeight: row.maxHeight });
  }

  private launch(w: Waiting): CacheJob {
    const job = new CacheJob(w.id, w.ref, w.maxHeight, this.jobDeps);
    this.running.set(w.id, job);
    const settled = job
      .run()
      .then((outcome) => this.settle(w, outcome))
      .catch((err: unknown) => this.log(`[notesd] stream cache: ${refLabel(w.ref)}: could not record how the download ended: ${messageOf(err)}`))
      .finally(() => {
        this.running.delete(w.id);
        this.settling.delete(w.id);
        this.pump();
      });
    this.settling.set(w.id, settled);
    return job;
  }

  private async settle(w: Waiting, outcome: JobOutcome): Promise<void> {
    const at = this.now();
    if (outcome.state === 'ready') {
      await this.repo.cacheReady(w.id, outcome, at);
      this.log(`[notesd] stream cache: ${refLabel(w.ref)} is cached (${outcome.segments} segments, ${Math.round(outcome.bytes / 1_048_576)} MB)`);
    } else if (outcome.state === 'failed') {
      await this.repo.cacheFailed(w.id, outcome.error, outcome.detail, at);
      this.log(`[notesd] stream cache: ${refLabel(w.ref)} stopped: ${outcome.error} (${outcome.detail})`);
    }
    // cancelled: the row stays `downloading` (a restart carries it on) unless it was cleared.
  }

  private view(row: StreamCacheRow): StreamCacheView {
    const live = this.running.get(row.id)?.progress() ?? null;
    const available = row.host === this.host;
    const total = live?.segmentsTotal ?? row.segmentsTotal;
    const done = live?.segmentsDone ?? row.segmentsDone;
    const base = `/api/stream/cache/${row.id}/f/`;
    return {
      id: row.id,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      host: row.host,
      available,
      state: row.state,
      running: available && this.running.has(row.id),
      queued: available && this.waiting.some((w) => w.id === row.id),
      provider: row.provider,
      manifest_kind: row.manifestKind,
      height: row.height,
      max_height: row.maxHeight,
      audio_lang: row.audioLang,
      subtitle: row.subtitle,
      segments_total: total,
      segments_done: done,
      progress: total === 0 ? (row.state === 'ready' ? 1 : 0) : Math.round((done / total) * 1000) / 1000,
      bytes: live?.bytes ?? row.bytes,
      duration_s: row.durationS,
      resolves: row.resolves,
      error: row.error,
      error_detail: row.errorDetail,
      playlist_url: available && row.manifestKind !== null ? `${base}${row.manifestKind === 'hls' ? 'master.m3u8' : 'video.mp4'}` : null,
      subtitle_url: available && row.subtitle ? `${base}subtitle.vtt` : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    };
  }

  private playData(row: StreamCacheRow): CachePlayData | null {
    if (row.provider === null || row.manifestKind === null) return null;
    const base = `/api/stream/cache/${row.id}/f/`;
    return {
      id: row.id,
      ref: cacheRef(row),
      host: row.host,
      state: row.state,
      provider: row.provider,
      height: row.height,
      manifestKind: row.manifestKind,
      manifestUrl: `${base}${row.manifestKind === 'hls' ? 'master.m3u8' : 'video.mp4'}`,
      subtitles: row.subtitle ? [{ url: `${base}subtitle.vtt`, lang: 'en', label: 'English' }] : [],
      audioLang: row.audioLang,
      audio: null,
    };
  }
}

/** Test seams for buildStreamCache. */
export interface StreamCacheOverrides {
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's stream cache, or null without direct streaming. The folder is NOTESD_STREAM_CACHE_DIR,
 * else `<dataDir>/movies/stream-cache`; it is made when the first download starts.
 */
export function buildStreamCache(
  config: Config,
  directStream: { readonly host: string; resolve(ref: StreamRef, options: { resumeS?: number | null }): Promise<StreamSession> } | null,
  repo: DirectStreamRepo,
  overrides: StreamCacheOverrides = {},
): StreamCache | null {
  if (directStream === null) return null;
  return new StreamCache({
    repo,
    host: directStream.host,
    root: config.directStream?.cacheDir ?? path.join(config.dataDir, STREAM_CACHE_SUBDIR),
    // resumeS 0: a cache's resolve skips the resume hook (it opens no player).
    resolve: (ref) => directStream.resolve(ref, { resumeS: 0 }),
    ...overrides,
  });
}
```
**Impact:** none until wired (step 15).

### Step 13: The routes
**File:** `src/http/streamCacheApi.ts` (new)
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { StreamCache } from '../directStream/cache/service.js';
import { CacheError } from '../directStream/cache/types.js';
import type { StreamRef } from '../directStream/types.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The stream cache (STREAM_CACHE_AND_BUG_REPORT phase 5): start a download, list, read and clear
 * caches, and serve a cache's files. 503 direct_stream_off without the service or the cache (the
 * directStreamRoutes guard answers first when both are mounted). The POST and the DELETE start or
 * remove something, so they are same-origin only; the file route is what the player page loads.
 */

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const maxHeight = z.number().int().min(100).max(4320);

export const cacheBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), max_height: maxHeight.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    max_height: maxHeight.nullish(),
  }),
]);

type CacheBody = z.infer<typeof cacheBody>;

function refOf(body: CacheBody): StreamRef {
  return body.kind === 'movie' ? { kind: 'movie', tmdbId: body.tmdb_id } : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** CacheError -> its HTTP answer; anything else is rethrown (500). */
export function cacheErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof CacheError)) throw err;
  switch (err.code) {
    case 'unknown_cache':
      return c.json({ error: err.code, message: err.message }, 404);
    case 'not_on_this_machine':
      return c.json({ error: err.code, message: err.message, host: err.extra.host ?? null }, 404);
    case 'cache_exists':
      return c.json({ error: err.code, message: err.message, cache: err.extra.cache ?? null }, 409);
  }
}

export function streamCacheRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'streamCache'>>): Hono {
  const r = new Hono();
  const cacheOf = (): StreamCache | null => ((deps.directStream ?? null) === null ? null : (deps.streamCache ?? null));

  r.post('/api/stream/cache', sameOriginOnly, async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = cacheBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const { cache: view, started } = await cache.request(refOf(body.data), { maxHeight: body.data.max_height ?? null });
      return c.json({ ok: true, started, cache: view }, started ? 202 : 200);
    } catch (err) {
      return cacheErrorResponse(c, err);
    }
  });

  r.get('/api/stream/cache', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    return c.json({ host: cache.host, caches: await cache.list() });
  });

  r.get('/api/stream/cache/:id', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    const view = await cache.get(c.req.param('id'));
    if (view === null) return c.json({ error: 'unknown_cache', message: 'No stream cache has this id.' }, 404);
    return c.json(view);
  });

  r.delete('/api/stream/cache/:id', sameOriginOnly, async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    const id = c.req.param('id');
    try {
      await cache.remove(id);
      return c.json({ ok: true, id: id.toLowerCase() });
    } catch (err) {
      return cacheErrorResponse(c, err);
    }
  });

  r.get('/api/stream/cache/:id/f/:name', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    return cache.file(c.req.param('id'), c.req.param('name'), { range: c.req.header('range') ?? null });
  });

  return r;
}
```
**Note:** the scope said `/f/*`; one path segment `:name` is enough because a cache folder is flat, and it keeps `..` out by construction (the name is also matched against `SERVED_NAME`).

### Step 14: `direct_stream_cache`
**Files:** `src/chat/status.ts` (after `:110`), `src/mcp/directStreamTools.ts` (`:293`, `:297`, `:312`, `:355`, `:374`), `src/mcp/streamCacheTools.ts` (new), `src/mcp/tools.ts` (`:16`, `:45`), `src/mcp/server.ts` (`:11`, `:36`)
**Change:** the tool, kept out of the chat bar. **Decision — not in `allowedChatTools`:** a cache writes gigabytes to this laptop's disk and runs for minutes in the background; the chat bar's prompt (`src/chat/prompt.ts`) does not describe caching; and the wall gets its own per-episode cache and clear buttons later (the owner's words), built on `POST`/`DELETE /api/stream/cache`. "Cache it first" is a Claude Code request through `/direct-stream` (phase 6's skill wording). A test pins the exclusion.
**Code:**

`src/chat/status.ts`, after `CLAUDE_CODE_ONLY_TOOL_NAMES` (`:110`):
```ts
/**
 * direct_stream_cache (src/mcp/streamCacheTools.ts): download a film or an episode to this machine's
 * disk, show a cache's progress, list every cache, clear one. Deliberately NOT in allowedChatTools():
 * a cache writes gigabytes to this laptop's disk and runs for minutes in the background, the chat
 * bar's prompt does not describe it, and the wall gets its own cache and clear buttons (POST and
 * DELETE /api/stream/cache). Claude Code's /direct-stream asks for it.
 */
export const STREAM_CACHE_TOOL_NAMES = ['direct_stream_cache'] as const;
```

`src/mcp/directStreamTools.ts`: add `export` before the five declarations, bodies unchanged:
- `:293` `function label(c: TitleCandidate): string {` → `export function label(c: TitleCandidate): string {`
- `:297` `function candidateView(c: TitleCandidate, wall: string) {` → `export function candidateView(c: TitleCandidate, wall: string) {`
- `:312` `function targetFor(` → `export function targetFor(`
- `:355` `async function chooseEpisode(` → `export async function chooseEpisode(`
- `:374` `async function chooseAbsolute(` → `export async function chooseAbsolute(`

`src/mcp/streamCacheTools.ts` (new):
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STREAM_CACHE_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { CACHE_ID_PATTERN, CacheError, type StreamCacheView } from '../directStream/cache/types.js';
import { LookupError, lookupTitle, parseTitleRequest, type StreamTarget } from '../directStream/lookup.js';
import { candidateView, chooseAbsolute, chooseEpisode, DIRECT_STREAM_OFF, directStreamToolDeps, label, targetFor, type DirectStreamToolDeps } from './directStreamTools.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { movieErrorResult } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [CACHE] = STREAM_CACHE_TOOL_NAMES;

/** What direct_stream_cache calls on the daemon's StreamCache (src/directStream/cache/service.ts); tests pass a fake. */
export interface StreamCacheApi {
  readonly host: string;
  request(ref: StreamTarget, options: { maxHeight: number | null }): Promise<{ cache: StreamCacheView; started: boolean }>;
  list(): Promise<StreamCacheView[]>;
  get(id: string): Promise<StreamCacheView | null>;
  forRef(ref: StreamTarget): Promise<StreamCacheView[]>;
  remove(id: string): Promise<void>;
}

export interface StreamCacheToolDeps {
  /** The direct-stream tools' lookup (titles, TMDB, the episode picks). */
  lookup: DirectStreamToolDeps;
  cache: StreamCacheApi;
}

/** The tool deps of a running daemon, or null when direct streaming (or the cache) is off. */
export function streamCacheToolDeps(deps: AppDeps): StreamCacheToolDeps | null {
  const lookup = directStreamToolDeps(deps);
  const cache = deps.streamCache ?? null;
  return lookup === null || cache === null ? null : { lookup, cache };
}

const DESCRIPTION =
  "Download a film, or one episode of a series, to this machine's disk so it can play from the local copy instead of the stream host (a slow or far host, a bad connection). " +
  'action start resolves a cloud source the way direct_stream_play does (out of sight, nothing plays, 5 to 40 seconds), then downloads one rendition with its segments, keys and the English subtitle in the background: the call answers at once with the cache (state downloading, progress, segments_done of segments_total) and the download goes on after it. ' +
  'Pass title (words without the year, a movie id, or a title key) with year and kind when known; for a series season and episode, or absolute_episode, or neither to take the episode direct_stream_play would (picked). max_height caches the tallest rendition not above it (720 for a smaller copy); without it the tallest. ' +
  'action status shows that title\'s caches (or the one of id) on both machines; list shows every cache; clear stops this machine\'s download of it and deletes its files. ' +
  'A cache belongs to the machine that made it: one made on the other laptop has available false and cannot be played or cleared here (not_on_this_machine). ' +
  'Answers carry cache { id, state downloading | ready | failed, progress, segments_done, segments_total, bytes, height, provider, subtitle, error }. error cache_unsupported means the source cannot be cached (DASH, DRM, a live stream); token_refused that the host kept refusing fresh tokens; cache_exists that this machine holds the title at another max_height: clear it first. ' +
  'Off on this server: direct_stream_off.';

interface CacheArgs {
  action: 'start' | 'status' | 'list' | 'clear';
  title?: string | undefined;
  year?: number | undefined;
  kind?: 'movie' | 'tv' | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  absolute_episode?: number | undefined;
  max_height?: number | undefined;
  id?: string | undefined;
}

type Resolved =
  | { found: true; target: StreamTarget; title: ReturnType<typeof candidateView>; picked: Record<string, unknown> }
  | { found: false; answer: Record<string, unknown> };

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

function cacheErrorResult(err: CacheError): CallToolResult {
  const next =
    err.code === 'cache_exists'
      ? 'This machine already holds that title at another quality. Say so with the cache; to change it, clear it (action clear) and start again.'
      : err.code === 'not_on_this_machine'
        ? 'That cache is on the other laptop. Say so; it can be played or cleared only there.'
        : 'There is no such cache. Say so.';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: err.code, message: err.message, ...(err.extra.host === undefined ? {} : { host: err.extra.host }), ...(err.extra.cache === undefined ? {} : { cache: err.extra.cache }), next }),
      },
    ],
  };
}

/** The film or episode the words name, as direct_stream_play finds it; a series without an episode takes play's pick only for `start`. */
async function resolveTarget(a: CacheArgs, title: string, d: DirectStreamToolDeps, wall: string): Promise<Resolved> {
  const result = await lookupTitle(parseTitleRequest(title, a.year ?? null, a.kind ?? null), d);
  if (result.status === 'none') {
    return {
      found: false,
      answer: { skipped: 'no_match', did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)), next: 'No title has that name (or that name and year). Show did_you_mean with years and ask which is meant; then call again with its title_key.' },
    };
  }
  if (result.status === 'several') {
    return {
      found: false,
      answer: { skipped: 'several_matches', candidates: result.candidates.map((c) => candidateView(c, wall)), next: 'List the candidates with their years and ask which one; then call again with its movie_id or title_key.' },
    };
  }
  const c = result.candidate;
  let target = targetFor(c, result.episode, a.season, a.episode);
  let picked: Record<string, unknown> = {};
  if (a.absolute_episode !== undefined) {
    if (c.kind !== 'tv') throw new LookupError('invalid_input', `${label(c)} is a film: it takes no episode.`);
    if (target !== null || a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', 'pass absolute_episode alone, or season and episode: not both.');
    const { choice } = await chooseAbsolute(c, a.absolute_episode, d);
    if (choice.pick === 'unknown') {
      return { found: false, answer: { skipped: 'no_such_episode', title: candidateView(c, wall), absolute_episode: a.absolute_episode, episodes: choice.episodes, next: `${label(c)} has ${choice.episodes} episodes listed. Say so.` } };
    }
    if (choice.pick === 'unclear') {
      return {
        found: false,
        answer: {
          skipped: 'episode_unclear',
          title: candidateView(c, wall),
          absolute_episode: a.absolute_episode,
          candidates: choice.candidates.map((e) => ({ season: e.season, episode: e.episode, reading: e.reading })),
          next: 'That number can be read two ways. List the candidates as season and episode and ask which; then call again with that season and episode.',
        },
      };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: 'absolute', absolute_episode: a.absolute_episode };
  }
  if (target === null) {
    if (a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', `${label(c)} is a series: pass both season and episode.`);
    if (a.action !== 'start') {
      return { found: false, answer: { skipped: 'needs_episode', title: candidateView(c, wall), next: 'A series is cached per episode: call again with season and episode (or absolute_episode).' } };
    }
    const choice = await chooseEpisode(c, d);
    if (choice.pick === 'caught_up') {
      return { found: false, answer: { skipped: 'caught_up', title: candidateView(c, wall), last: choice.last, next: 'Every episode after the last one played is finished. Say so; name a season and episode to cache one.' } };
    }
    if (choice.pick === 'not_aired') {
      return { found: false, answer: { skipped: 'not_aired', title: candidateView(c, wall), season: choice.season, episode: choice.episode, air_date: choice.airDate, next: 'The next episode has not aired yet. Say which and when.' } };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: choice.pick };
  }
  return { found: true, target, title: candidateView(c, wall), picked: { ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}), ...picked } };
}

async function cacheAction(a: CacheArgs, d: StreamCacheToolDeps, wall: string): Promise<CallToolResult> {
  if (a.action === 'list') {
    const caches = await d.cache.list();
    return ok({
      host: d.cache.host,
      count: caches.length,
      caches,
      next: caches.length === 0 ? 'Nothing is cached on either machine. Say so.' : 'List them with their state and progress; available false is a cache on the other laptop.',
    });
  }
  if (a.id !== undefined) {
    const id = a.id.toLowerCase();
    if (a.action === 'start') throw new LookupError('invalid_input', 'start takes a title, not an id.');
    if (a.action === 'status') {
      const cache = await d.cache.get(id);
      if (cache === null) throw new CacheError('unknown_cache', 'No stream cache has this id.');
      return ok({ caches: [cache], next: "Say the cache's state, progress and machine." });
    }
    await d.cache.remove(id);
    return ok({ cleared: true, id, next: 'Say the cache was cleared and its files deleted from this machine.' });
  }
  if (a.title === undefined) throw new LookupError('invalid_input', `${a.action} needs a title (or an id from an earlier answer).`);
  const found = await resolveTarget(a, a.title, d.lookup, wall);
  if (!found.found) return ok(found.answer);
  const { target, title, picked } = found;
  if (a.action === 'start') {
    const { cache, started } = await d.cache.request(target, { maxHeight: a.max_height ?? null });
    return ok({
      started,
      title,
      ...picked,
      cache,
      next:
        cache.state === 'ready'
          ? 'It is cached on this machine already. Say so.'
          : started
            ? 'Say the download started in the background on this machine (nothing is playing) and that status shows how far it is.'
            : 'It is downloading already. Say how far it is (progress).',
    });
  }
  const caches = await d.cache.forRef(target);
  if (a.action === 'status') {
    return ok({ title, ...picked, caches, next: caches.length === 0 ? 'Nothing of it is cached on either machine. Say so.' : "Say each cache's state, progress and machine." });
  }
  const mine = caches.find((c) => c.available);
  if (mine === undefined) {
    const other = caches[0];
    if (other !== undefined) throw new CacheError('not_on_this_machine', `It is cached on ${other.host} only; clear it there.`, { host: other.host });
    return ok({ cleared: false, title, ...picked, reason: 'no_cache', next: 'Nothing of it is cached on this machine. Say so.' });
  }
  await d.cache.remove(mine.id);
  return ok({ cleared: true, id: mine.id, title, ...picked, next: 'Say the cache was cleared and its files deleted from this machine.' });
}

/** direct_stream_cache. Without deps.streamCache it answers direct_stream_off and starts nothing. */
export function registerStreamCacheTool(server: McpServer, deps: Pick<ToolDeps, 'streamCache' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    CACHE,
    {
      title: 'Cache a film or an episode on this machine',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['start', 'status', 'list', 'clear']).describe('start a download, status of one title (or id), list every cache, clear (stop and delete) one.'),
        title: z.string().trim().min(1).max(200).optional().describe("The film or series title without the year, a movie id (M-23T4; an episode's id names its season and episode), or a title key (movie-550)."),
        year: z.number().int().min(1880).max(2100).optional().describe('The release year, when known.'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: z.number().int().min(0).max(1000).optional().describe('A series only: the season of the episode.'),
        episode: z.number().int().min(0).max(100000).optional().describe('A series only: the episode number within that season.'),
        absolute_episode: z.number().int().min(1).max(100000).optional().describe('A series only, instead of season and episode: an episode named by one number ("One Piece episode 730").'),
        max_height: z.number().int().min(100).max(4320).optional().describe('start only: cache the tallest rendition not above this height (720, 480). Default: the tallest.'),
        id: z.string().trim().regex(CACHE_ID_PATTERN).optional().describe('A cache id from an earlier answer, instead of title (status, clear).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const d = deps.streamCache;
      if (!d) return { isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] };
      try {
        return await cacheAction(args, d, wall);
      } catch (err) {
        return err instanceof CacheError ? cacheErrorResult(err) : movieErrorResult(err);
      }
    },
  );
}
```

`src/mcp/tools.ts`: after line 16 (`import type { DirectStreamToolDeps } ...`) add:
```ts
import type { StreamCacheToolDeps } from './streamCacheTools.js';
```
and after the `directStream?: DirectStreamToolDeps | null;` member (`:45`) add:
```ts
  /** The stream cache behind direct_stream_cache (stream-cache phase 5). Omitted or null: it answers direct_stream_off. */
  streamCache?: StreamCacheToolDeps | null;
```

`src/mcp/server.ts`: after line 11 add
```ts
import { registerStreamCacheTool } from './streamCacheTools.js';
```
and after `registerDirectStreamTools(server, deps);` (`:36`) add:
```ts
  // The stream cache (stream-cache phase 5). Answers direct_stream_off when deps.streamCache is unset.
  registerStreamCacheTool(server, deps);
```
**Impact:** the server registers one more tool; `docs:gen` lists it under the direct-streaming group (prefix `direct_stream_`).

### Step 15: Config and wiring
**Files:** `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/http/app.ts`
**Change:** wiring lines only.
**Code:**

`src/config.ts` — in `DirectStreamConfig` (`:197`–`:215`), after `animeMapUrl?: string | null`:
```ts
  /**
   * `NOTESD_STREAM_CACHE_DIR`, absolute: the folder holding this host's stream caches, one folder per
   * cache id (src/directStream/cache/). Null or unset: `<dataDir>/movies/stream-cache`.
   */
  cacheDir?: string | null
```
`DEFAULT_DIRECT_STREAM_CONFIG` (`:218`) gains `cacheDir: null,` after `cli: DEFAULT_DIRECT_STREAM_CLI,`. `parseDirectStream` (`:685`) gains, after `animeMapUrl: parseAnimeMapUrl(env.NOTESD_ANIME_MAP_URL),`:
```ts
    cacheDir: parseOptionalAbsolutePath('NOTESD_STREAM_CACHE_DIR', env.NOTESD_STREAM_CACHE_DIR),
```
In `loadConfig`'s doc comment (`:738`) the direct streaming line becomes:
```ts
 * Direct streaming keys: NOTESD_DIRECT_STREAM, NOTESD_STREAM_FRESH_DAYS, NOTESD_DIRECT_STREAM_CLI, NOTESD_ANIME_MAP_URL,
 * NOTESD_STREAM_CACHE_DIR (a freshness window below 1, a relative resolver path or a relative cache folder throw ConfigError).
```

`src/deps.ts` — import (after `:12`):
```ts
import type { StreamCache } from './directStream/cache/service.js';
```
and after the `directStream?:` member (`:59`):
```ts
  /**
   * The stream cache (stream-cache phase 5): films and episodes downloaded to this host's disk. Built
   * next to `directStream`; null or absent with direct streaming off. startBackground carries its
   * unfinished downloads on and closes it.
   */
  streamCache?: StreamCache | null;
```

`src/daemon.ts` — imports (after `:31`):
```ts
import { buildStreamCache } from './directStream/cache/service.js';
import { DirectStreamRepo } from './directStream/repo.js';
```
after the seed block (after `:192`):
```ts
  // Stream cache (stream-cache phase 5): null with direct streaming off. Downloads start only when
  // asked; startBackground carries unfinished ones on.
  const streamCache = buildStreamCache(config, directStream, new DirectStreamRepo(db));
```
and in the `deps` literal, after `directStream,` (`:219`):
```ts
    streamCache,
```

`src/background.ts` — after the prober block (after `:186`):
```ts
  // Stream cache (stream-cache phase 5): this host's unfinished downloads carry on; closed on stop.
  const streamCache = deps.streamCache ?? null;
  if (streamCache !== null) {
    void streamCache.start().then(
      (n) => {
        if (n > 0) console.log(`[notesd] stream cache: carrying on ${n} unfinished download(s) on ${streamCache.host}`);
      },
      (err: unknown) => console.error(`[notesd] stream cache: could not carry on downloads: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
```
and in the stop's `Promise.all([...])` list (`:209`), after `prober?.close(),`:
```ts
      streamCache?.close(),
```

`src/http/app.ts` — imports (next to `:10` and `:27`):
```ts
import { streamCacheToolDeps } from '../mcp/streamCacheTools.js';
import { streamCacheRoutes } from './streamCacheApi.js';
```
in `mcpToolDeps`, after `directStream: directStreamToolDeps(deps),` (`:89`):
```ts
    streamCache: streamCacheToolDeps(deps),
```
and after `app.route('/', directStreamRoutes(deps));` (`:138`):
```ts
  app.route('/', streamCacheRoutes(deps));
```
The `createApp` comment's route list gains `streamCacheRoutes (stream-cache phase 5: the stream cache)` after the `streamProberRoutes` mention.
**Impact:** with direct streaming on, the daemon builds the cache and resumes downloads; nothing runs until one is asked for. `listHttpRoutes` (docs) sees five new routes.

### Step 16: Unit tests for the tool, the config and the chat exclusion
**Files:** `tests/unit/mcp.streamCacheTools.test.ts`, `tests/unit/config.streamCache.test.ts` (new), `tests/unit/chat-status.test.ts` (after `:55`)
**Code:**

`tests/unit/mcp.streamCacheTools.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { CacheError, type StreamCacheView } from '../../src/directStream/cache/types.js';
import type { StreamTarget, TitleCandidate, TitleLibrary } from '../../src/directStream/lookup.js';
import { DIRECT_STREAM_OFF, type DirectStreamToolDeps } from '../../src/mcp/directStreamTools.js';
import { registerStreamCacheTool, type StreamCacheApi, type StreamCacheToolDeps } from '../../src/mcp/streamCacheTools.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const SALTBURN: TitleCandidate = { kind: 'movie', tmdbId: 930564, title: 'Saltburn', originalTitle: 'Saltburn', year: 2023, movieId: 'M-5A1T' };
const THE_BEAR: TitleCandidate = { kind: 'tv', tmdbId: 136315, title: 'The Bear', originalTitle: 'The Bear', year: 2022, movieId: 'M-0BEA' };
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function view(over: Partial<StreamCacheView> = {}): StreamCacheView {
  return {
    id: ID,
    kind: 'movie',
    tmdb_id: 930564,
    season: null,
    episode: null,
    host: 'here',
    available: true,
    state: 'downloading',
    running: true,
    queued: false,
    provider: null,
    manifest_kind: null,
    height: null,
    max_height: null,
    audio_lang: null,
    subtitle: false,
    segments_total: 0,
    segments_done: 0,
    progress: 0,
    bytes: 0,
    duration_s: null,
    resolves: 0,
    error: null,
    error_detail: null,
    playlist_url: null,
    subtitle_url: null,
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T00:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

function lookup(): DirectStreamToolDeps {
  const stored = [SALTBURN, THE_BEAR];
  const library: TitleLibrary = {
    search: async (_name, kind) => stored.filter((t) => kind === null || t.kind === kind),
    byKey: async (kind, tmdbId) => stored.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null,
    byMovieId: async () => null,
    seasons: async () => [{ season: 1, episodes: 8 }],
  };
  return {
    library,
    tmdb: null,
    progress: async () => [],
    rememberAlias: async () => false,
    now: () => new Date('2026-11-16T03:00:00Z'),
    play: vi.fn(),
    freshSource: async () => null,
    marks: async () => new Map(),
    freshTitles: async () => new Set<string>(),
    dialogue: vi.fn(),
    providers: vi.fn(async () => []),
    updateSource: vi.fn(),
  };
}

function fakeCache(over: Partial<StreamCacheApi> = {}) {
  const request = vi.fn<StreamCacheApi['request']>(async () => ({ cache: view(), started: true }));
  const remove = vi.fn<StreamCacheApi['remove']>(async () => undefined);
  const forRef = vi.fn<StreamCacheApi['forRef']>(async () => [view()]);
  const cache: StreamCacheApi = { host: 'here', request, list: async () => [view()], get: async () => view(), forRef, remove, ...over };
  return { cache, request, remove, forRef };
}

async function connect(streamCache: StreamCacheToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStreamCacheTool(server, { streamCache, wallUrl: 'http://localhost:7317' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (args: Record<string, unknown>) => (await client.callTool({ name: 'direct_stream_cache', arguments: args })) as ToolResult,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('direct_stream_cache', () => {
  it('is registered with a full description and is not read-only', async () => {
    const c = await connect(null);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['direct_stream_cache']);
    expect(tools[0]?.description?.length ?? 0).toBeGreaterThan(200);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    await c.close();
  });

  it('answers direct_stream_off without the cache and starts nothing', async () => {
    const c = await connect(null);
    const r = await c.call({ action: 'start', title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(DIRECT_STREAM_OFF);
    await c.close();
  });

  it('starts a film with its max_height', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'saltburn', max_height: 720 });
    expect(r.isError).toBeFalsy();
    expect(f.request).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 } satisfies StreamTarget, { maxHeight: 720 });
    expect(json(r)).toMatchObject({ started: true, title: { title: 'Saltburn', tmdb_id: 930564 }, cache: { id: ID, state: 'downloading' } });
    await c.close();
  });

  it("starts a series named without an episode on the episode a play would take", async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'the bear' });
    expect(f.request).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 136315, season: 1, episode: 1 }, { maxHeight: null });
    expect(json(r)).toMatchObject({ started: true, season: 1, episode: 1, picked: 'first' });
    await c.close();
  });

  it('asks for the episode before a status of a series', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'status', title: 'the bear' }))).toMatchObject({ skipped: 'needs_episode' });
    expect(f.forRef).not.toHaveBeenCalled();
    await c.close();
  });

  it('answers cache_exists with the cache that is there', async () => {
    const f = fakeCache({
      request: async () => {
        throw new CacheError('cache_exists', 'already at 1080p', { cache: view({ state: 'ready', max_height: 1080 }) });
      },
    });
    const c = await connect({ lookup: lookup(), cache: f.cache });
    const r = await c.call({ action: 'start', title: 'saltburn', max_height: 720 });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'cache_exists', cache: { max_height: 1080 } });
    await c.close();
  });

  it("clears this machine's cache, and refuses one only the other laptop holds", async () => {
    const f = fakeCache({ forRef: async () => [view({ host: 'other', available: false, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), view()] });
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'clear', title: 'saltburn' }))).toMatchObject({ cleared: true, id: ID });
    expect(f.remove).toHaveBeenCalledWith(ID);
    await c.close();
    const g = fakeCache({ forRef: async () => [view({ host: 'other', available: false })] });
    const d = await connect({ lookup: lookup(), cache: g.cache });
    const r = await d.call({ action: 'clear', title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'not_on_this_machine', host: 'other' });
    expect(g.remove).not.toHaveBeenCalled();
    await d.close();
  });

  it('lists every cache of both machines', async () => {
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache });
    expect(json(await c.call({ action: 'list' }))).toMatchObject({ host: 'here', count: 1, caches: [{ id: ID }] });
    await c.close();
  });
});
```

`tests/unit/config.streamCache.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseDirectStream } from '../../src/config.js';

describe('NOTESD_STREAM_CACHE_DIR', () => {
  it('is null when unset and an absolute path when set', () => {
    expect(parseDirectStream({}).cacheDir).toBeNull();
    expect(parseDirectStream({ NOTESD_STREAM_CACHE_DIR: '/srv/stream-cache/' }).cacheDir).toBe('/srv/stream-cache');
  });
  it('refuses a relative path', () => {
    expect(() => parseDirectStream({ NOTESD_STREAM_CACHE_DIR: 'cache/here' })).toThrow(/NOTESD_STREAM_CACHE_DIR must be an absolute path/);
  });
});
```

`tests/unit/chat-status.test.ts`: add `STREAM_CACHE_TOOL_NAMES` to the import from `../../src/chat/status.js`, and after the `'lets the chat bar list the stream providers but never add one'` test (`:55`):
```ts
  it('keeps direct_stream_cache out of the chat bar', () => {
    expect(STREAM_CACHE_TOOL_NAMES).toEqual(['direct_stream_cache']);
    expect(allowedChatTools()).not.toContain(n('direct_stream_cache'));
  });
```
**Impact:** `npm test` passes (the reference test fails until step 20 runs `docs:gen`; run steps 15–20 before `npm test`).

### Step 17: The fixture stream host's tokened HLS film and the fake resolver's `hls_token`
**Files:** `tests/fixtures/direct-stream/upstream.mjs`, `tests/fixtures/direct-stream/fake-cli.mjs`
**Change:** opt-in by state files; every existing path and mode answers as before.
**Code:**

`upstream.mjs` — extend the header comment with:
```js
// A tokened HLS film for the stream cache (state DIR): /tok/t<N>/master.m3u8 names 480 and 720
// renditions and two audio renditions (en, ko), each 12 segments of 4 s; 720 and 480 carry an
// AES-128 key. It answers only while N is the current token (DIR/token, as for the DASH film).
// DIR/token_uses holding K: each token answers K media requests (keys and segments) and refuses the
// rest with 403, a signed address that expired mid-download. DIR/fail_once lists file names
// (seg3.ts) answered 503 once each. DIR/delay_ms delays every media answer of the tokened film.
```
Add after `SUB_PLAYLIST` (before `function dashManifest`):
```js
export const TOKEN_SEGMENTS = 12;
const MPEGURL = 'application/vnd.apple.mpegurl';
const TOKEN_KEY = Buffer.alloc(16, 7);

function tokMaster() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Korean",LANGUAGE="ko",DEFAULT=NO,AUTOSELECT=YES,URI="audio/ko/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="aud"',
    '480/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
    '720/index.m3u8',
    '',
  ].join('\n');
}

function tokMedia(prefix, keyed) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (keyed) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001');
  for (let i = 1; i <= TOKEN_SEGMENTS; i++) lines.push('#EXTINF:4.0,', `${prefix}${i}.ts`);
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

function stateNumber(state, name) {
  const file = path.join(state, name);
  if (!existsSync(file)) return 0;
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True for a media file (key or segment) of the tokened film. */
function tokMediaPath(pathname) {
  return /^\/tok\/t\d+\/(?:(?:480|720)\/(?:seg\d+\.ts|key\.bin)|audio\/(?:en|ko)\/aseg\d+\.ts)$/.test(pathname);
}

/** /tok/t<N>/...: [status, type, body], or null when the path is not the tokened film's. `memo` counts per token. */
function tokenAnswer(pathname, state, memo) {
  const m = /^\/tok\/t(\d+)\/(.+)$/.exec(pathname);
  if (m === null || state === null) return null;
  const token = Number(m[1]);
  const rest = m[2];
  if (token !== currentFilmToken(state)) return [403, 'text/plain', 'token expired'];
  if (rest === 'master.m3u8') return [200, MPEGURL, tokMaster()];
  if (/^(480|720)\/index\.m3u8$/.test(rest)) return [200, MPEGURL, tokMedia('seg', true)];
  if (/^audio\/(en|ko)\/index\.m3u8$/.test(rest)) return [200, MPEGURL, tokMedia('aseg', false)];
  if (!tokMediaPath(pathname)) return [404, 'text/plain', 'not found'];
  const used = (memo.uses.get(token) ?? 0) + 1;
  memo.uses.set(token, used);
  const limit = stateNumber(state, 'token_uses');
  if (limit > 0 && used > limit) return [403, 'text/plain', 'token expired'];
  const failFile = path.join(state, 'fail_once');
  const failOnce = existsSync(failFile) ? readFileSync(failFile, 'utf8').split(/\s+/).filter(Boolean) : [];
  const name = rest.slice(rest.lastIndexOf('/') + 1);
  if (failOnce.includes(name) && !memo.failed.has(rest)) {
    memo.failed.add(rest);
    return [503, 'text/plain', 'busy'];
  }
  return rest.endsWith('key.bin') ? [200, 'application/octet-stream', TOKEN_KEY] : [200, 'video/mp2t', SEGMENT];
}
```
In `startUpstream`, after `let alt = '';` add:
```js
  const memo = { uses: new Map(), failed: new Set() };
```
replace the line `const found = filmAnswer(url.pathname, state) ?? answer(url.pathname, alt);` with:
```js
    const found = filmAnswer(url.pathname, state) ?? tokenAnswer(url.pathname, state, memo) ?? answer(url.pathname, alt);
```
and replace the closing lines of the handler (from `const [status, type, body] = found;` to the final `return reply(status, type, buf, ...)`) with:
```js
    const [status, type, body] = found;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const send = () => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(entry.range ?? '');
      if (status === 200 && range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] === '' ? buf.length - 1 : Number(range[2]), buf.length - 1);
        return reply(206, type, buf.subarray(start, end + 1), {
          'content-range': `bytes ${start}-${end}/${buf.length}`,
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
        });
      }
      return reply(status, type, buf, { 'accept-ranges': 'bytes', 'content-length': String(buf.length) });
    };
    const delay = state !== null && tokMediaPath(url.pathname) ? stateNumber(state, 'delay_ms') : 0;
    if (delay > 0) setTimeout(send, delay);
    else send();
```

`fake-cli.mjs` — header comment's `mode` line becomes:
```js
//   mode           hls (default) | dash | dash_film | hls_token | no_source | no_chrome: the next resolve's answer
//                  (dash_film: the playable film under <dir>/film, at the address that carries the
//                  token in <dir>/token; upstream.mjs refuses every older token. hls_token: raises
//                  <dir>/token by one and answers upstream.mjs's tokened HLS film under that token,
//                  with a Korean original-language audio track)
```
the import line becomes:
```js
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
```
and in `main()`, replace the final `return print({ ok: true, ... })` block's computation of the manifest with a local first. Just before `return print({` add:
```js
  let manifestUrl = mode === 'dash_film' ? `${origin}/film/t${currentFilmToken(dir)}/manifest.mpd` : mode === 'dash' ? `${origin}/dash/manifest.mpd` : `${origin}/hls/master.m3u8`;
  if (mode === 'hls_token') {
    const next = currentFilmToken(dir) + 1;
    writeFileSync(path.join(dir, 'token'), `${next}\n`);
    manifestUrl = `${origin}/tok/t${next}/master.m3u8`;
  }
```
and in the printed `source`, `manifest_url:` becomes `manifest_url: manifestUrl,` and after `took_s: 2.5,` add:
```js
      ...(mode === 'hls_token' ? { audio: { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'ko', label: 'Korean' } } } : {}),
```
**Impact:** existing modes print the same JSON; existing tests unchanged.

### Step 18: Truncate the new table between integration tests
**File:** `tests/integration/setup.ts:50`
**Change:** `truncateAll`'s statement begins `truncate table stream_caches, stream_provider_health, ...` (prepend `stream_caches, ` to the list).

### Step 19: Integration tests for the repo, routes, both hosts, delete and restart
**File:** `tests/integration/directStream.cache.int.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamCaches } from '../../src/db/schema.js';
import { StreamCache } from '../../src/directStream/cache/service.js';
import type { StreamCacheView } from '../../src/directStream/cache/types.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService } from '../../src/directStream/service.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
import { streamCacheRoutes } from '../../src/http/streamCacheApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const SEED = [{ name: 'Alpha', movie: 'https://alpha.example/movie/{id}', tv: 'https://alpha.example/tv/{id}/{season}/{episode}', en_subtitle: true }];

interface UpstreamRequest {
  path: string;
  status: number;
}
interface Upstream {
  origin: string;
  altOrigin: string;
  requests: UpstreamRequest[];
  close(): Promise<void>;
}
interface Posted {
  ok: true;
  started: boolean;
  cache: StreamCacheView;
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let root: string;
const open: StreamCache[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tokPath = (p: string): string => p.replace(/^\/tok\/t\d+\//, '');

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

async function fake(name: string, value: string | number): Promise<void> {
  await writeFile(path.join(fakeDir, name), `${value}\n`);
}

function build(options: { parallel?: number } = {}) {
  const repo = new DirectStreamRepo(db);
  const svc = new DirectStreamService({
    repo,
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host: 'host-a',
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => 'http://localhost:4321',
    log: () => undefined,
  });
  const cache = new StreamCache({
    repo,
    host: 'host-a',
    root,
    resolve: (ref) => svc.resolve(ref, { resumeS: 0 }),
    sleep: async () => undefined,
    log: () => undefined,
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
  });
  open.push(cache);
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamCacheRoutes({ directStream: svc, streamCache: cache }));
  return { svc, cache, app };
}

async function ready(options: { parallel?: number } = {}) {
  const built = build(options);
  await built.svc.syncSeed();
  return built;
}

function post(app: Hono, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return Promise.resolve(app.request('/api/stream/cache', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
}

async function posted(app: Hono, body: unknown): Promise<Posted> {
  const res = await post(app, body);
  expect(res.status).toBe(202);
  return (await res.json()) as Posted;
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

async function waitFor(app: Hono, id: string, state: 'ready' | 'failed'): Promise<StreamCacheView> {
  const end = Date.now() + 15_000;
  for (;;) {
    const view = (await (await app.request(`/api/stream/cache/${id}`)).json()) as StreamCacheView;
    if (view.state === state) return view;
    if (view.state === 'failed') throw new Error(`the cache failed: ${view.error} ${view.error_detail}`);
    if (Date.now() > end) throw new Error(`cache ${id} is still ${view.state}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  db = openTestDb();
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-cache-'));
  up = (await startUpstream({ state: fakeDir })) as Upstream;
  await writeFile(path.join(fakeDir, 'upstream.json'), JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  await writeFile(path.join(fakeDir, 'seed.json'), JSON.stringify(SEED));
  process.env.DIRECT_STREAM_FAKE_DIR = fakeDir;
});

afterAll(async () => {
  delete process.env.DIRECT_STREAM_FAKE_DIR;
  await up.close();
  await rm(fakeDir, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  for (const name of ['calls.jsonl', 'token_uses', 'fail_once', 'delay_ms']) await rm(path.join(fakeDir, name), { force: true });
  await fake('mode', 'hls');
  up.requests.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'stream-cache-root-'));
});

afterEach(async () => {
  for (const cache of open.splice(0)) await cache.close();
  await sleep(50);
  await rm(root, { recursive: true, force: true });
});

describe('migration 0029 (stream caches)', () => {
  it('keeps one cache per title slot and machine, a film in slot 0/0, and an error exactly on a failed cache', async () => {
    const repo = new DirectStreamRepo(db);
    expect((await repo.createCache('host-a', { kind: 'movie', tmdbId: 550 }, null)).created).toBe(true);
    expect((await repo.createCache('host-a', { kind: 'movie', tmdbId: 550 }, 720)).created).toBe(false);
    expect((await repo.createCache('host-b', { kind: 'movie', tmdbId: 550 }, null)).created).toBe(true);
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 551, season: 1, episode: 1 }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 552, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 553, manifestKind: 'dash' as never }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 554, state: 'ready' }))).toBe('23514');
  });
});

describe('/api/stream/cache', () => {
  it('downloads the rendition under max_height with its subtitle, records it, and serves it from disk', async () => {
    const { app } = await ready();
    const p = await posted(app, { kind: 'movie', tmdb_id: 550, max_height: 720 });
    expect(p).toMatchObject({ ok: true, started: true, cache: { state: 'downloading', host: 'host-a', available: true } });
    const id = p.cache.id;
    const done = await waitFor(app, id, 'ready');
    expect(done).toMatchObject({
      kind: 'movie',
      tmdb_id: 550,
      season: null,
      episode: null,
      provider: 'Alpha',
      manifest_kind: 'hls',
      height: 720,
      max_height: 720,
      subtitle: true,
      segments_total: 2,
      segments_done: 2,
      progress: 1,
      resolves: 1,
      playlist_url: `/api/stream/cache/${id}/f/master.m3u8`,
      subtitle_url: `/api/stream/cache/${id}/f/subtitle.vtt`,
    });
    expect((await readdir(path.join(root, id))).sort()).toEqual(['cache.json', 'master.m3u8', 'subtitle.vtt', 'v-00001.m4s', 'v-00002.m4s', 'v-init-1.mp4', 'video.m3u8']);
    expect(up.requests.some((r) => r.path.startsWith('/hls/1080/'))).toBe(false);
    expect(up.requests.filter((r) => r.path === '/hls/720/index.m3u8')).toHaveLength(1);
    const master = await (await app.request(`/api/stream/cache/${id}/f/master.m3u8`)).text();
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toContain('\nvideo.m3u8\n');
    const video = await (await app.request(`/api/stream/cache/${id}/f/video.m3u8`)).text();
    expect(video.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXTINF:4.0,',
      'v-00002.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
    const part = await app.request(`/api/stream/cache/${id}/f/v-00002.m4s`, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(await (await app.request(`/api/stream/cache/${id}/f/subtitle.vtt`)).text()).toMatch(/^WEBVTT\n\n[\s\S]*00:00:01\.000 --> 00:00:03\.000\nHello\./);
    expect((await app.request(`/api/stream/cache/${id}/f/cache.json`)).status).toBe(404);
    const [row] = await db.select().from(streamCaches);
    expect(row).toMatchObject({ state: 'ready', segmentsDone: 2, segmentsTotal: 2, bytes: 3000, resolves: 1, host: 'host-a' });
  });

  it('answers a cache that exists without a second download, and refuses another max_height', async () => {
    const { app } = await ready();
    const first = await posted(app, { kind: 'movie', tmdb_id: 550, max_height: 720 });
    await waitFor(app, first.cache.id, 'ready');
    const again = await post(app, { kind: 'movie', tmdb_id: 550 });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, started: false, cache: { id: first.cache.id, state: 'ready' } });
    const other = await post(app, { kind: 'movie', tmdb_id: 550, max_height: 1080 });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'cache_exists', cache: { id: first.cache.id, max_height: 720 } });
    expect((await readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('resolves again when the host refuses the token, retries a failing segment, and fetches no segment twice', async () => {
    await fake('mode', 'hls_token');
    await fake('token_uses', 10);
    await fake('fail_once', 'seg3.ts');
    const { app } = await ready();
    const p = await posted(app, { kind: 'movie', tmdb_id: 990004 });
    const done = await waitFor(app, p.cache.id, 'ready');
    expect(done).toMatchObject({ height: 720, audio_lang: 'ko', segments_total: 24, segments_done: 24 });
    expect(done.resolves).toBeGreaterThanOrEqual(3);
    const tok = up.requests.filter((r) => r.path.startsWith('/tok/'));
    expect(tok.some((r) => r.status === 403)).toBe(true);
    expect(tok.filter((r) => r.status === 503).map((r) => tokPath(r.path))).toEqual(['720/seg3.ts']);
    const fetched = tok.filter((r) => r.status === 200 && /seg\d+\.ts$/.test(r.path)).map((r) => tokPath(r.path));
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched).toHaveLength(24);
    expect(fetched.some((f) => f.startsWith('audio/en/'))).toBe(false);
    const files = await readdir(path.join(root, p.cache.id));
    expect(files.filter((f) => /^v-\d{5}\.ts$/.test(f))).toHaveLength(12);
    expect(files.filter((f) => /^a-\d{5}\.ts$/.test(f))).toHaveLength(12);
    expect(files).toContain('v-key-1.key');
    expect(await (await app.request(`/api/stream/cache/${p.cache.id}/f/master.m3u8`)).text()).toContain('LANGUAGE="ko"');
  });

  it("lists the other machine's cache as unavailable and answers not_on_this_machine for its files and its delete", async () => {
    const repo = new DirectStreamRepo(db);
    const { row } = await repo.createCache('host-b', { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 }, null);
    await repo.cachePlanned(row.id, { provider: 'Alpha', manifestKind: 'hls', height: 1080, audioLang: null, segmentsTotal: 10, segmentsDone: 10, bytes: 5000, durationS: 40 });
    await repo.cacheReady(row.id, { segments: 10, bytes: 5000, subtitle: true });
    const { app, cache } = await ready();
    const list = (await (await app.request('/api/stream/cache')).json()) as { host: string; caches: StreamCacheView[] };
    expect(list.host).toBe('host-a');
    expect(list.caches).toEqual([expect.objectContaining({ id: row.id, host: 'host-b', available: false, state: 'ready', season: 1, episode: 2, playlist_url: null, subtitle_url: null })]);
    for (const name of ['master.m3u8', 'v-00001.ts', 'subtitle.vtt']) {
      const res = await app.request(`/api/stream/cache/${row.id}/f/${name}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    }
    const del = await app.request(`/api/stream/cache/${row.id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(del.status).toBe(404);
    expect(await del.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect(await repo.cacheById(row.id)).not.toBeNull();
    expect(await cache.player().find({ kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBeNull();
    expect(await cache.player().get(row.id)).toMatchObject({ host: 'host-b', state: 'ready', manifestUrl: `/api/stream/cache/${row.id}/f/master.m3u8` });
    expect(up.requests).toHaveLength(0);
  });

  it('DELETE stops a running download, removes its files and takes it out of every listing', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 150);
    const { app, cache } = await ready();
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 1);
    const del = await app.request(`/api/stream/cache/${id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, id });
    await expect(stat(path.join(root, id))).rejects.toThrow();
    expect(await new DirectStreamRepo(db).cacheById(id)).toBeNull();
    expect(((await (await app.request('/api/stream/cache')).json()) as { caches: unknown[] }).caches).toEqual([]);
    expect((await app.request(`/api/stream/cache/${id}`)).status).toBe(404);
    await sleep(400);
    const settled = up.requests.length;
    await sleep(600);
    expect(up.requests.length).toBe(settled);
    const again = await app.request(`/api/stream/cache/${id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: 'unknown_cache' });
  });

  it('a restart carries an unfinished download on from the files already on disk', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 50);
    const first = await ready();
    const id = (await posted(first.app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await first.cache.get(id))?.segments_done ?? 0) >= 6);
    await first.cache.close();
    await sleep(200);
    const [row] = await db.select().from(streamCaches);
    expect(row?.state).toBe('downloading');
    const kept = (await readdir(path.join(root, id))).filter((f) => /^[va]-\d{5}\.ts$/.test(f)).length;
    expect(kept).toBeGreaterThanOrEqual(6);
    up.requests.length = 0;
    await rm(path.join(fakeDir, 'delay_ms'), { force: true });
    const second = await ready();
    expect(await second.cache.start()).toBe(1);
    const done = await waitFor(second.app, id, 'ready');
    expect(done.segments_done).toBe(24);
    expect(up.requests.filter((r) => r.status === 200 && /\/tok\/.*seg\d+\.ts$/.test(r.path))).toHaveLength(24 - kept);
  });

  it('fetches a segment the player asks for before its turn', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 100);
    const { app, cache } = await ready({ parallel: 1 });
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 1);
    const res = await app.request(`/api/stream/cache/${id}/f/v-00012.ts`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    const order = up.requests.filter((r) => r.status === 200).map((r) => tokPath(r.path));
    expect(order).toContain('720/seg12.ts');
    expect(order).not.toContain('720/seg11.ts');
    await waitFor(app, id, 'ready');
    expect(up.requests.filter((r) => r.status === 200 && tokPath(r.path) === '720/seg12.ts')).toHaveLength(1);
  });

  it('fails a DASH source as cache_unsupported without fetching it, and a new request starts it again', async () => {
    await fake('mode', 'dash');
    const { app } = await ready();
    const id = (await posted(app, { kind: 'movie', tmdb_id: 550 })).cache.id;
    const failed = await waitFor(app, id, 'failed');
    expect(failed).toMatchObject({ state: 'failed', error: 'cache_unsupported' });
    expect(failed.error_detail).toMatch(/DASH/);
    expect(up.requests).toHaveLength(0);
    await fake('mode', 'hls');
    const again = await post(app, { kind: 'movie', tmdb_id: 550 });
    expect(again.status).toBe(202);
    expect((await waitFor(app, id, 'ready')).error).toBeNull();
  });

  it('refuses a POST or DELETE from another origin, a bad body, and answers direct_stream_off without the cache', async () => {
    const { app } = await ready();
    expect((await post(app, { kind: 'movie', tmdb_id: 550 }, {})).status).toBe(403);
    expect((await app.request('/api/stream/cache/00000000-0000-4000-8000-000000000000', { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, { kind: 'tv', tmdb_id: 1399 })).status).toBe(400);
    expect((await app.request('/api/stream/cache/not-a-uuid')).status).toBe(404);
    const off = new Hono();
    off.route('/', streamCacheRoutes({ directStream: null, streamCache: null }));
    expect((await off.request('/api/stream/cache')).status).toBe(503);
  });
});
```
**Impact:** `npm run test:int` passes.

### Step 20: Route reference and generated docs
**File:** `scripts/docs/httpRoutes.ts` (after the `'POST /api/stream/prober/pass'` entry, `:237`)
**Code:**
```ts
      'POST /api/stream/cache':
        '`{kind, tmdb_id, season?, episode?, max_height?}` (`season` and `episode` together, `tv` only; `max_height` 100 to 4320): cache the film or episode on this machine. Answers at once; the download runs in the daemon, one at a time (the rest wait, `queued`): the title is resolved like a play, out of sight, then one HLS rendition (the tallest, or the tallest not above `max_height`) with the audio rendition in the title\'s original language, its segments, init sections and AES-128 keys, and the English subtitle as WebVTT, or a plain file by byte ranges, go to `<NOTESD_STREAM_CACHE_DIR>/<id>/`. A segment that fails is tried six times with backoff; a refused token (401/403/410) resolves the title again and the download carries on by segment index. 202 `{ok: true, started: true, cache}` when a download was queued (a failed cache starts again from what is on disk); 200 `{ok: true, started: false, cache}` when it is ready or already downloading; 409 `cache_exists` with `cache` when this machine holds the title at another `max_height` (clear it first); 400 `invalid_json` / `invalid_body`. Same-origin only.',
      'GET /api/stream/cache':
        'Every cache of both machines, newest first: `{host, caches}`. A cache is `{id, kind, tmdb_id, season, episode, host, available, state (downloading, ready, failed), running, queued, provider, manifest_kind, height, max_height, audio_lang, subtitle, segments_total, segments_done, progress, bytes, duration_s, resolves, error, error_detail, playlist_url, subtitle_url, created_at, updated_at, completed_at}`. `available` is false for the other machine\'s cache, whose `playlist_url` and `subtitle_url` are null. `error` on a failed one: `cache_unsupported` (DASH, DRM, a live stream, a file without byte ranges), `no_source`, `resolve_failed`, `download_failed`, `token_refused`, `source_changed`, `disk_error`.',
      'GET /api/stream/cache/:id':
        'One cache, in the shape above, with the running download\'s live progress. 404 `unknown_cache`.',
      'DELETE /api/stream/cache/:id':
        'Clear a cache of this machine: its download stops, its folder is deleted and its row removed, so no listing shows it. `{ok: true, id}`. 404 `unknown_cache`; 404 `not_on_this_machine` with `host` for the other machine\'s cache, which stays. Same-origin only.',
      'GET /api/stream/cache/:id/f/:name':
        'A file of a cache, from this machine\'s disk, with `Range` (206, 416): `master.m3u8`, `video.m3u8`, `audio.m3u8`, `v-init-<k>.mp4`, `v-key-<k>.key`, `v-00001.ts` (or `.m4s`, `.aac`; `a-` for the audio rendition), `subtitle.vtt`, `video.mp4`. The playlists name every segment from the start, so a player can seek anywhere while the cache downloads; a file not on disk yet is fetched from the stream host at once, ahead of the queue, and stored (a plain file chunk by chunk). 404 `unknown_cache`, 404 `not_on_this_machine` with `host`, 404 `not_found`, 409 `cache_failed`, 502 `upstream_error`.',
```
Then run `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md` and `mcp-tools.md`; never hand-edit them).

### Step 21: Configuration reference
**File:** `docs/guide/reference/configuration.md` (after the `NOTESD_STREAM_PROBE_MS` row in "## Direct streaming")
**Code:**
```markdown
| `NOTESD_STREAM_CACHE_DIR` | `<NOTES_DATA_DIR>/movies/stream-cache` | Absolute path of the folder where this machine keeps its stream caches, one folder per cache id. The other machine keeps its own; a relative path is rejected. See [streaming.md](../streaming.md#caching-a-film-or-an-episode). |
```

### Step 22: The streaming guide
**File:** `docs/guide/streaming.md` — insert before `### The prober` (`:729`); add two rows to "## Where the code is" (after the `src/http/directStreamApi.ts` row) and one bullet to "## Proving a change"
**Code:**
```markdown
### Caching a film or an episode

A stream that stutters on a slow connection or a far stream host can be downloaded to this laptop
first. `direct_stream_cache` with `action: "start"` in Claude Code, or `POST /api/stream/cache`,
answers at once; the download runs in the daemon, one at a time (the rest wait, `queued`).

1. The title is resolved like a play, out of sight: the same resolver and provider order, the
   title's original language.
2. HLS: one rendition, the tallest, or the tallest not above `max_height` (none at or under it: the
   shortest). Its audio is the rendition the player would pick, in the title's original language.
   Every segment, the fMP4 init sections and the AES-128 keys are downloaded, and the English
   subtitle is saved as WebVTT. A plain-file source is downloaded in 4 MB byte ranges and joined.
3. Four files at a time, each tried up to six times with backoff (1, 2, 4, 8, 16 s). When the host
   refuses a token (401, 403, 410: a signed address that expired), the title is resolved again and
   the download carries on by segment index, keeping what is on disk. Three fresh resolves without
   a file in between stop it (`token_refused`). A fresh source of another shape (another provider,
   other segments) empties the folder and starts over.
4. Every file is written to a temporary name and renamed. A daemon restart carries unfinished
   downloads on from what is on disk.

| Source | Cached |
| --- | --- |
| HLS master or media playlist, VidNest's `master.txt`, relative addresses | yes |
| Separate audio renditions | the original-language one only |
| `EXT-X-BYTERANGE` segments, `EXT-X-MAP` init sections, `EXT-X-KEY` AES-128 (with or without IV), discontinuities, gaps | yes; each range becomes its own file, IV and media sequence are kept |
| `SAMPLE-AES`, a `KEYFORMAT` other than `identity` (DRM) | no: `cache_unsupported` |
| A playlist without `EXT-X-ENDLIST` (live) | no: `cache_unsupported` |
| DASH | no: `cache_unsupported` |
| A plain file whose host ignores byte ranges | no: `cache_unsupported` |

The files are in `<NOTES_DATA_DIR>/movies/stream-cache/<cache id>/` (`NOTESD_STREAM_CACHE_DIR`):
`master.m3u8` (the one rendition, and `audio.m3u8` when the audio is separate), `video.m3u8`,
`v-init-1.mp4`, `v-key-1.key`, `v-00001.ts` and on, `subtitle.vtt`, or `video.mp4`, plus
`cache.json` (the shape of the source; no address, since addresses carry tokens). The local
playlists list every segment by index, with `EXT-X-ENDLIST`, from the start, so a player can seek
anywhere while the cache downloads: `GET /api/stream/cache/<id>/f/<file>` serves a file from disk
with `Range`, and fetches one that is not on disk yet from the stream host at once, ahead of the
queue.

A cache belongs to the machine that made it (`stream_caches`, one per title and machine). The
other machine lists it with `available: false`, and its files and its delete answer 404
`not_on_this_machine`. `DELETE /api/stream/cache/<id>` (or `action: "clear"`) stops the download,
deletes the folder and the row. The chat bar does not cache: it is a Claude Code request, and the
Movies page's cache and clear buttons come later on the same routes.

| Answer | Meaning |
| --- | --- |
| `cache_unsupported` | The source cannot be cached (see the table) |
| `no_source`, `resolve_failed` | The resolve found no provider, or could not run |
| `download_failed` | A file kept failing after six tries, or the host answered something else than a file |
| `token_refused` | The host kept refusing fresh tokens |
| `source_changed` | The source changed shape under the download more than twice |
| `disk_error` | A file could not be written |
| `cache_exists` | This machine holds the title at another `max_height`: clear it first |
| `not_on_this_machine` | The cache is on the other laptop |
| `unknown_cache` | No cache has that id (or it was cleared) |
| `cache_failed` | A file of a failed cache was asked for: ask for the cache again |
```
"## Where the code is" rows:
```markdown
| `src/directStream/cache/` | The stream cache: HLS parsing and local playlists (`hls.ts`, `plan.ts`), one download (`job.ts`), the queue, views and file answers (`service.ts`) |
| `src/http/streamCacheApi.ts`, `src/mcp/streamCacheTools.ts` | The `/api/stream/cache` routes; `direct_stream_cache` |
```
"## Proving a change" bullet (after the "Direct streaming:" bullet):
```markdown
- The stream cache: `cache.sh RUN` on `verify.sh up --direct-stream` drives it against the fixture
  stream host's tokened HLS film (`mode` `hls_token`, `token_uses`, `fail_once`, `delay_ms`); the
  downloader's cases are `npx vitest run tests/unit/directStream/cache`.
```

### Step 23: Architecture guide
**File:** `docs/guide/architecture.md`
**Change:** four lines.
- `:70` becomes `| \`stream_providers\`, \`stream_provider_health\`, \`stream_caches\` | \`DirectStreamRepo\` (\`src/directStream/repo.ts\`) |`
- `:94` (Direct streaming data row): the tables cell becomes `` `stream_providers`, `stream_provider_health`, `stream_probe_titles`, `stream_caches` `` and the text gains at its end ` A stream cache is one film or episode downloaded on one host: one row per title and host, its files only on that host.`
- After `:118` (`movies/vlc-health-<host>.jsonl ...`) add the line `  movies/stream-cache/<id>/          a stream cache: local playlists, segments, keys, subtitle (NOTESD_STREAM_CACHE_DIR)`
- After the "Stream prober" row (`:217`) add `| Stream cache | Direct streaming on | Downloads the films and episodes asked for, one at a time; carries unfinished ones on after a restart. | \`src/directStream/cache/\` |`

### Step 24: The verify harness and the feature map
**Files:** `.claude/skills/verify-notesd/scripts/verify.sh:205`, `.claude/skills/verify-notesd/SKILL.md:56`, `.claude/skills/verify-notesd/features/direct-streaming.md` (before `## Gotchas`, `:218`), `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh` (new, `chmod +x`)
**Code:**

`verify.sh`, in the base `env=(...)` array after `NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"` (`:205`):
```sh
    # A throwaway daemon never writes into the owner's stream cache folder (.env.local may name one).
    NOTESD_STREAM_CACHE_DIR="$dir/data/movies/stream-cache"
```

`SKILL.md:56`: the mode list `(\`hls\`, \`dash\`, \`dash_film\`, \`no_source\`, \`no_chrome\`)` becomes `(\`hls\`, \`dash\`, \`dash_film\`, \`hls_token\`, \`no_source\`, \`no_chrome\`)`.

`features/direct-streaming.md`, before `## Gotchas`:
```markdown
## Stream cache
- `POST /api/stream/cache` (same-origin) and `direct_stream_cache` (Claude Code only; not in the chat
  bar) download one film or episode to this machine: one HLS rendition (the tallest, or the tallest
  not above `max_height`), the original-language audio rendition, segments, init sections, AES-128
  keys and the English subtitle as WebVTT, or a plain file by ranges; DASH, DRM and live answer
  `cache_unsupported`. Retries with backoff, a fresh resolve on a refused token that keeps the
  files by index, resume after a restart. `GET /api/stream/cache[/:id]` lists both machines'
  caches (`available: false` for the other's); `DELETE /api/stream/cache/:id` stops, deletes the
  folder and the row; `GET /api/stream/cache/:id/f/:name` serves files with Range and fetches a
  missing one at once. Files: `<NOTES_DATA_DIR>/movies/stream-cache/<id>/`.
- Proven by `npx vitest run tests/unit/directStream/cache tests/unit/mcp.streamCacheTools.test.ts tests/unit/config.streamCache.test.ts tests/unit/chat-status.test.ts`
  (parsers, the downloader against an in-memory stream host, the tool) and
  `npm run test:int -- tests/integration/directStream.cache.int.test.ts` (table, routes, both
  machines, delete during a download, restart).
- Throwaway daemon: `$V up --direct-stream`, then
  `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh RUN` (stages `start tool refused other clear`;
  `clear` needs `start`; each stage once per fresh run, since a title has one cache per machine and
  `fail_once` fails a file once per host process). It ends with `cache: PASS (...)`. The `refused` stage sets `<run>/direct/mode`
  to `hls_token`, `token_uses` to 10 and `fail_once` to `seg3.ts`: the fixture host's tokened film
  (`/tok/t<N>/`) refuses a token after ten media answers and fails `seg3.ts` once.
- Playing from a cache is phase 6's entry.
```

`.claude/skills/verify-notesd/scripts/direct-stream/cache.sh` (new):
```bash
#!/usr/bin/env bash
# cache.sh RUN [start|tool|refused|other|clear ...]: the stream cache's checks (stream-cache phase 5)
# on a `verify.sh up --direct-stream` run. Every stage drives the real daemon over HTTP or MCP: the
# fake resolver (tests/fixtures/direct-stream/fake-cli.mjs) answers the resolves and the fixture stream
# host (tests/fixtures/direct-stream/upstream.mjs) serves the stream. End states are read over HTTP,
# from the run's database (read-only), from the cache folder and from the fixture host's request log.
# The first failed check stops it with `cache: FAIL at <stage>`. No stage named: all five, in order.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: cache.sh RUN [start|tool|refused|other|clear ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(start tool refused other clear); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "cache: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
ROOT="$DIR/data/movies/stream-cache"
OTHER_ID=00000000-0000-4000-8000-000000000603
STAGE=start
CODE=""
BODY=""
PASSED=()

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "stream cache $STAGE: $*"; }
fail() {
  echo "cache: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "stream cache FAIL at $STAGE: $*" || true
  exit 1
}
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
get() {
  local path=$1 name=$2
  shift 2
  CODE="$(curl -sS -D "$EV/cache-$name.head" -o "$EV/cache-$name.body" -w '%{http_code}' "$@" "$URL$path")"
}
mcp() { "$V" mcp "$RUN" direct_stream_cache "$1" 2>/dev/null | sed '1d;/^< ERROR$/d'; }
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
upstream_since() { if [ -f "$DIRECT/upstream.jsonl" ]; then sed -n "$(($1 + 1)),\$p" "$DIRECT/upstream.jsonl"; fi; }
# wait_state ID STATE: polls GET /api/stream/cache/ID (no evidence per poll) until STATE, at most 90 s.
wait_state() {
  local id=$1 want=$2 state view
  for _ in $(seq 1 360); do
    view="$(curl -sS "$URL/api/stream/cache/$id")"
    state="$(jq -r .state <<<"$view")"
    [ "$state" = "$want" ] && { api GET "/api/stream/cache/$id"; return 0; }
    if [ "$state" = failed ] && [ "$want" != failed ]; then fail "cache $id failed: $(jq -c '{error, error_detail}' <<<"$view")"; fi
    sleep 0.25
  done
  fail "cache $id did not reach $want in 90 s (last: $view)"
}
reset_fixture() { rm -f "$DIRECT/token_uses" "$DIRECT/fail_once" "$DIRECT/delay_ms"; }

stage_start() {
  stage start
  reset_fixture
  printf 'hls\n' >"$DIRECT/mode"
  local before id row log
  before="$(upstream_count)"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":550,"max_height":720}'
  [ "$CODE" = 202 ] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  id="$(jq -r .cache.id <<<"$BODY")"
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "cache id [$id] is not a uuid"
  [ "$(jq -r .cache.state <<<"$BODY")" = downloading ] || fail "a new cache is not downloading: $BODY"
  wait_state "$id" ready
  [ "$(jq -r '[.height, .max_height, .segments_done, .segments_total, .subtitle, .available, .playlist_url] | map(tostring) | join(" ")' <<<"$BODY")" = "720 720 2 2 true true /api/stream/cache/$id/f/master.m3u8" ] \
    || fail "GET /api/stream/cache/$id is $BODY"
  row="$(q "select state || ' ' || height || ' ' || segments_done || '/' || segments_total || ' ' || manifest_kind || ' ' || resolves || ' ' || (provider is not null)::text || ' ' || (host = '$(hostname)')::text from stream_caches where id = '$id'")"
  [ "$row" = "ready 720 2/2 hls 1 true true" ] || fail "stream_caches holds [$row]"
  ok "a cache of movie 550 under 720p is ready and recorded: $row"
  for f in master.m3u8 video.m3u8 v-init-1.mp4 v-00001.m4s v-00002.m4s subtitle.vtt cache.json; do
    [ -s "$ROOT/$id/$f" ] || fail "$f is not in $ROOT/$id"
  done
  ok "the folder holds the playlists, the init section, both segments and the subtitle"
  log="$(upstream_since "$before")"
  [ "$(jq -s '[.[] | select(.path | startswith("/hls/1080/"))] | length' <<<"$log")" = 0 ] || fail "the 1080p rendition was fetched"
  [ "$(jq -s '[.[] | select(.path == "/hls/720/index.m3u8")] | length' <<<"$log")" = 1 ] || fail "the 720p playlist was not fetched once"
  ok "only the 720p rendition was fetched (the master also names 1080p)"
  get "/api/stream/cache/$id/f/video.m3u8" video-playlist
  [ "$CODE" = 200 ] || fail "video.m3u8 answered HTTP $CODE"
  grep -qx 'v-00002.m4s' "$EV/cache-video-playlist.body" && grep -qx '#EXT-X-ENDLIST' "$EV/cache-video-playlist.body" \
    || fail "video.m3u8 does not list the local segments with ENDLIST"
  get "/api/stream/cache/$id/f/v-00001.m4s" segment-range -H 'Range: bytes=0-99'
  [ "$CODE" = 206 ] && [ "$(wc -c <"$EV/cache-segment-range.body" | tr -d ' ')" = 100 ] || fail "a 100-byte range of v-00001.m4s answered HTTP $CODE"
  get "/api/stream/cache/$id/f/subtitle.vtt" subtitle
  head -1 "$EV/cache-subtitle.body" | grep -qx 'WEBVTT' || fail "subtitle.vtt is not WebVTT"
  ok "the files are served from disk: the playlist, a 206 range, the subtitle"
  echo "$id" >"$EV/cache-start.id"
  PASSED+=(start)
}

stage_tool() {
  stage tool
  reset_fixture
  printf 'hls\n' >"$DIRECT/mode"
  local out id
  out="$(mcp '{"action":"start","title":"tv-247718","season":1,"episode":1}')"
  [ "$(jq -r .started <<<"$out")" = true ] || fail "direct_stream_cache start answered $out"
  id="$(jq -r .cache.id <<<"$out")"
  wait_state "$id" ready
  out="$(mcp '{"action":"status","title":"tv-247718","season":1,"episode":1}')"
  [ "$(jq -r '.caches[0] | [.state, .season, .episode, .available] | map(tostring) | join(" ")' <<<"$out")" = "ready 1 1 true" ] \
    || fail "direct_stream_cache status answered $out"
  [ "$(q "select kind || ' ' || season || ' ' || episode || ' ' || state from stream_caches where id = '$id'")" = "tv 1 1 ready" ] \
    || fail "the tool's cache is not recorded as tv S1E1 ready"
  ok "direct_stream_cache started tv 247718 S01E01, which is ready and recorded"
  PASSED+=(tool)
}

stage_refused() {
  stage refused
  reset_fixture
  printf 'hls_token\n' >"$DIRECT/mode"
  printf '10\n' >"$DIRECT/token_uses"
  printf 'seg3.ts\n' >"$DIRECT/fail_once"
  local before id row log files
  before="$(upstream_count)"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":990004}'
  [ "$CODE" = 202 ] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  id="$(jq -r .cache.id <<<"$BODY")"
  wait_state "$id" ready
  reset_fixture
  row="$(q "select state || ' ' || segments_done || '/' || segments_total || ' ' || height || ' ' || audio_lang || ' ' || (resolves >= 3)::text from stream_caches where id = '$id'")"
  [ "$row" = "ready 24/24 720 ko true" ] || fail "stream_caches holds [$row]"
  log="$(upstream_since "$before")"
  [ "$(jq -s '[.[] | select((.path | startswith("/tok/")) and .status == 403)] | length' <<<"$log")" -ge 1 ] || fail "the host never refused a token"
  [ "$(jq -s '[.[] | select(.status == 503 and (.path | endswith("/seg3.ts")))] | length' <<<"$log")" = 1 ] || fail "seg3.ts was not failed exactly once"
  [ "$(jq -s '[.[] | select((.path | startswith("/tok/")) and .status == 200 and (.path | test("seg[0-9]+\\.ts$"))) | (.path | sub("^/tok/t[0-9]+/"; ""))] | group_by(.) | map(select(length > 1)) | length' <<<"$log")" = 0 ] \
    || fail "a segment was downloaded twice: the download did not carry on from disk"
  [ "$(jq -s '[.[] | select(.path | test("/audio/en/"))] | length' <<<"$log")" = 0 ] || fail "the English dub was fetched"
  files="$(find "$ROOT/$id" -maxdepth 1 -name 'v-0*.ts' | wc -l | tr -d ' ') $(find "$ROOT/$id" -maxdepth 1 -name 'a-0*.ts' | wc -l | tr -d ' ')"
  [ "$files" = "12 12" ] && [ -s "$ROOT/$id/v-key-1.key" ] || fail "the folder holds [$files] video/audio segments"
  ok "refused tokens resolved again, seg3.ts retried, no segment fetched twice, Korean audio only: $row"
  PASSED+=(refused)
}

stage_other() {
  stage other
  "$V" exec "$RUN" "insert into stream_caches (id, host, kind, tmdb_id, provider, manifest_kind, height, state, segments_total, segments_done, bytes, resolves, subtitle, completed_at) values ('$OTHER_ID', 'other-laptop', 'movie', 603, 'Alpha', 'hls', 1080, 'ready', 10, 10, 12345, 1, true, now()) on conflict do nothing" >/dev/null
  api GET /api/stream/cache
  [ "$(jq -r --arg id "$OTHER_ID" '.caches[] | select(.id == $id) | [.available, .host, .playlist_url, .subtitle_url] | map(tostring) | join(" ")' <<<"$BODY")" = "false other-laptop null null" ] \
    || fail "the other machine's cache is listed as $BODY"
  for f in master.m3u8 v-00001.ts subtitle.vtt; do
    get "/api/stream/cache/$OTHER_ID/f/$f" "other-$f"
    [ "$CODE" = 404 ] && [ "$(jq -r '.error + " " + .host' "$EV/cache-other-$f.body")" = "not_on_this_machine other-laptop" ] \
      || fail "$f of the other machine's cache answered HTTP $CODE: $(cat "$EV/cache-other-$f.body")"
  done
  api DELETE "/api/stream/cache/$OTHER_ID"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = not_on_this_machine ] || fail "DELETE of the other machine's cache answered HTTP $CODE: $BODY"
  [ "$(q "select count(*) from stream_caches where id = '$OTHER_ID'")" = 1 ] || fail "the other machine's row was removed"
  ok "the other machine's cache is listed available false; its files and its delete answer 404 not_on_this_machine; its row stays"
  PASSED+=(other)
}

stage_clear() {
  stage clear
  reset_fixture
  [ -s "$EV/cache-start.id" ] || fail "run the start stage first"
  local id lid n1 n2
  id="$(cat "$EV/cache-start.id")"
  api DELETE "/api/stream/cache/$id"
  [ "$CODE" = 200 ] && [ "$(jq -r '.ok, .id' <<<"$BODY" | tr '\n' ' ')" = "true $id " ] || fail "DELETE answered HTTP $CODE: $BODY"
  [ ! -e "$ROOT/$id" ] || fail "$ROOT/$id is still there"
  [ "$(q "select count(*) from stream_caches where id = '$id'")" = 0 ] || fail "the row is still there"
  api GET /api/stream/cache
  [ "$(jq -r --arg id "$id" '[.caches[] | select(.id == $id)] | length' <<<"$BODY")" = 0 ] || fail "GET /api/stream/cache still lists it"
  [ "$(mcp '{"action":"list"}' | jq -r --arg id "$id" '[.caches[] | select(.id == $id)] | length')" = 0 ] || fail "direct_stream_cache list still lists it"
  api GET "/api/stream/cache/$id"
  [ "$CODE" = 404 ] && [ "$(jq -r .error <<<"$BODY")" = unknown_cache ] || fail "GET of the cleared cache answered HTTP $CODE: $BODY"
  ok "a ready cache was cleared: folder, row and every listing"
  printf 'hls_token\n' >"$DIRECT/mode"
  printf '300\n' >"$DIRECT/delay_ms"
  api POST /api/stream/cache '{"kind":"movie","tmdb_id":680}'
  [ "$CODE" = 202 ] || fail "POST answered HTTP $CODE: $BODY"
  lid="$(jq -r .cache.id <<<"$BODY")"
  for _ in $(seq 1 120); do
    [ "$(curl -sS "$URL/api/stream/cache/$lid" | jq -r .segments_done)" -ge 1 ] && break
    sleep 0.25
  done
  [ "$(curl -sS "$URL/api/stream/cache/$lid" | jq -r .state)" = downloading ] || fail "the second cache is not downloading"
  api DELETE "/api/stream/cache/$lid"
  [ "$CODE" = 200 ] || fail "DELETE during the download answered HTTP $CODE: $BODY"
  sleep 1
  n1="$(upstream_count)"
  sleep 2
  n2="$(upstream_count)"
  reset_fixture
  [ "$n1" = "$n2" ] || fail "the stream host got $((n2 - n1)) request(s) after the clear"
  [ ! -e "$ROOT/$lid" ] && [ "$(q "select count(*) from stream_caches where id = '$lid'")" = 0 ] || fail "the cleared download left its folder or row"
  ok "a running download was cleared: no request after it, folder and row gone"
  PASSED+=(clear)
}

for s in "${WANTED[@]}"; do
  case "$s" in
    start | tool | refused | other | clear) "stage_$s" ;;
    *) echo "cache: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "cache: PASS (${PASSED[*]})"
"$V" note "$RUN" "stream cache: PASS (${PASSED[*]})"
```

### Step 25: Final checks
Run, in order: `npm run typecheck`, `npm run docs:gen`, `npm test`, `npm run test:int`, `npm run docs:check`, then the Proof.

## Principles applied

- Laziness protocol: the cache's fetch reuses the pass-through's `upstreamHeaders`, `allows`/`learn`, `absoluteHttp`, `MAX_REDIRECTS` and `srtToVtt` instead of a second HTTP client; the tool reuses `direct_stream_play`'s lookup and episode picks by exporting five helpers; the resolve is `DirectStreamService.resolve`, not a second resolver path. No hook into phase 1's evidence (it would need a shape of its own; see Handoffs).
- Make illegal states unrepresentable: `stream_caches` CHECKs make `failed` without an error, `ready` without `completed_at`/provider/manifest kind or with counts short, a film with a season, and a DASH cache impossible; the unique index makes two live caches of one title on one host impossible; `JobOutcome` is a union in which only `failed` carries an error.
- Boundary discipline: the POST body is validated once by zod in the route, the cache id once by `CACHE_ID_PATTERN` before any query (a malformed id never reaches Postgres), a file name once by `SERVED_NAME` (no path ever leaves the cache folder); playlists are parsed once into typed plans that the downloader trusts.
- Build the lever: `cache.sh` drives every user path (start, tool, refused token, the other host, clear during a download) against the real daemon and fixture host and checks the row, the folder and the host's request log, so a reviewer reruns it instead of reading the diff.
- Test behavior, not implementation: the downloader tests assert files on disk, their bytes, the local playlists' text and the fake host's request log (what a user or the host sees), not private calls.
- Sequence into verifiable units: schema and repo (typecheck, migration) → pure parsers (unit) → downloader (unit) → service and routes (integration) → tool → docs; each block ends with a run that can fail.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int && npm run docs:check`
**Proof:** the real daemon downloads a cache from the fixture stream host and serves it from disk
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`; `$V up --direct-stream`, note `RUN=`)
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Stream cache")
- Journeys:
  - **J1** · traces R1.1, R1.3 — `$V up --direct-stream`, then `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh RUN start` → passes when it prints `ok  a cache of movie 550 under 720p is ready and recorded: ready 720 2/2 hls 1 true true`, `ok  only the 720p rendition was fetched (the master also names 1080p)`, `ok  the files are served from disk: ...`, and `~/.local/state/notesd-verify/RUN/data/movies/stream-cache/<id>/` holds `master.m3u8 video.m3u8 v-init-1.mp4 v-00001.m4s v-00002.m4s subtitle.vtt`
  - **J2** · traces R1.1 — `cache.sh RUN tool` (the `direct_stream_cache` MCP tool) → passes when it prints `ok  direct_stream_cache started tv 247718 S01E01, which is ready and recorded` (row `tv 1 1 ready`)
  - **J3** · traces R1.2 — `cache.sh RUN refused` → passes when it prints `ok  refused tokens resolved again, seg3.ts retried, no segment fetched twice, Korean audio only: ready 24/24 720 ko true` (the run's `direct/upstream.jsonl` holds 403s under `/tok/`, exactly one 503 for `seg3.ts`, and no segment answered 200 twice)
  - **J4** · traces R1.5 — `cache.sh RUN other` → passes when it prints `ok  the other machine's cache is listed available false; its files and its delete answer 404 not_on_this_machine; its row stays`
  - **J5** · traces R1.6 — `cache.sh RUN start clear` (or after J1) → passes when it prints `ok  a ready cache was cleared: folder, row and every listing` and `ok  a running download was cleared: no request after it, folder and row gone`, then `cache: PASS (start clear)`
  - **J6** · traces R1.2, R1.3 — `npx vitest run tests/unit/directStream/cache` → passes when every test passes, among them "resolves again on a refused token and keeps the segments already on disk, matched by index", "retries a failing segment with backoff", "stops on cancel, and a new run carries on from the files on disk", "caches the highest rendition not above max_height, with its English subtitle, and writes the local playlists first"
  - **J7** · traces R1.1, R1.2, R1.5, R1.6 — `npm run test:int -- tests/integration/directStream.cache.int.test.ts` → passes when every test passes, among them "a restart carries an unfinished download on from the files already on disk", "DELETE stops a running download, removes its files and takes it out of every listing", "lists the other machine's cache as unavailable and answers not_on_this_machine for its files and its delete"
- Neighbor check: direct streaming's pass-through and play are untouched — on the same run, `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN hls dash refuse` → passes when it ends with `journey: PASS (hls dash refuse)`; and `npx vitest run tests/unit/mcp.directStreamTools.test.ts tests/unit/chat-status.test.ts` passes (the exported helpers and the chat allow list).
- Cost: none (fake resolver, fixture host, no LLM).
**Exit criteria:** `cache.sh RUN` ends `cache: PASS (start tool refused other clear)`; `npm test`, `npm run test:int` and `npm run docs:check` pass; `http-api.md` lists the five `/api/stream/cache` routes and `mcp-tools.md` lists `direct_stream_cache`.

## Handoffs

- **Phase 6 (R1.4, and the "a play from it" part of R1.5), reconciled:** playing from the cache. This phase gives `StreamCache.player()` → `{ find(ref), get(id) }` answering `CachePlayData`, field for field phase 6's `CachePlayView` (`id`, `ref`, `host`, `state`, `provider`, `height`, `manifestKind`, `manifestUrl`, `subtitles [{url, lang: 'en', label: 'English'}]`, `audioLang`, `audio: null`); a cache whose source is not known yet (still resolving) answers null. Phase 6's wiring line is `caches: () => deps.streamCache?.player() ?? null`. The local manifest is `master.m3u8` and the subtitle `subtitle.vtt`; phase 6's fakes and journeys use those names. Phase 6 imports `CACHE_ID_PATTERN` from `src/directStream/cache/types.ts` (one definition). R1.5 is owned by both phases: this phase proves the listing, the files and the delete (J4, J7); phase 6 proves the play by id (its J4). The file route's two behaviours phase 6 relies on are stated in the Interface Contract.
- **Phase 6 (reconciled):** `claude/skills/direct-stream/SKILL.md`, `src/mcp/instructions.ts` ("Direct streaming" paragraph) and `claude/skills/report-stream-bug/SKILL.md` (the "cache it first" advice) name `direct_stream_cache`; phase 6 owns all three edits, this phase changes none of them.
- **Phase 1 (decided: not done):** recording the cache's fetches in `StreamEvidence` with `kind: 'cache'` is not a one-line hook — `fetchUpstream` would have to time the first byte and pass the session id and a host/path record of phase 1's `EvidenceInput` shape. Left out (index Decisions); a play from a cache is visible in a snapshot through phase 6's `source.cache` and the page's `from cache <id>` log line. If wanted later, `fetchUpstream` is the one place to add it.
- **Later (owner's "clear cache button"):** the Movies page's per-episode cache and clear buttons are UI on `POST`/`GET`/`DELETE /api/stream/cache`; no backend change is needed.
- **Chat bar:** `direct_stream_cache` stays out of `allowedChatTools()` (decision in Step 14). Adding it later means a sentence in `src/chat/prompt.ts`, moving it into the allowed list, and its caption in `captionForToolUse`.

## Rollback

Revert this phase's commits. Migration 0029 only adds `stream_caches`; after a revert the table is unused and harmless (drop it with `drop table stream_caches` if wanted; no other table references it). Cache files live under `<NOTES_DATA_DIR>/movies/stream-cache/` (or `NOTESD_STREAM_CACHE_DIR`) and can be deleted. The fixture additions are opt-in by state file, so reverting them changes no other test.

> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 4. Source: `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Routes and the tool: `/api/stream/downloads`, `direct_stream_cache`

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R1, R2, R3: the server side of the Download button (film, episode, season, a chosen source), the tool's torrent option, and the progress the title page reads
**Criteria:** R1.1, R1.3, R1.10, R1.11, R2.1, R2.2, R3.2
**Depends on:** Phase 2, Phase 3
**Difficulty:** NORMAL
**Package:** `src/http`, `src/mcp`, `web/src/moviesApi.ts`

---

## Goal

The download queue built in phases 2 and 3 becomes reachable. `POST /api/stream/downloads` queues exactly the film, episode or season named, from the source named (`via`, or one torrent by `info_hash`) and answers at once. `GET /api/stream/downloads` lists this machine's queued, running, paused and failed downloads with their progress (and, with `?title=`, that title's finished ones still on this machine), and `DELETE /api/stream/downloads/:id` cancels one. `direct_stream_cache` gains `provider: "torrent"` (the same call the button's "Best torrent" makes) and a season without an episode, and its `status` and `list` answers carry downloads. The web app gets the three client functions phases 5 and 8 import.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates:**
- `src/http/streamDownloadsApi.ts`:
  - `streamDownloadsRoutes(deps: Pick<AppDeps, 'streamDownloads'>): Hono`, mounted in `src/http/app.ts` right after `streamCacheRoutes`.
  - `DOWNLOADS_OFF` (`{error: 'downloads_off', message}`), `DOWNLOAD_ID_PATTERN` (a uuid, any case).
  - `type StreamDownloadsPort = Pick<StreamDownloads, 'host' | 'request' | 'requestSeason' | 'cancel' | 'list'>`.
  - `type ListedDownload = DownloadView & { title_id: string }` (phase 2's `DownloadView` plus the title key `movie-<id>`/`tv-<id>`, R3.2's "title"), `listed(d)`.
  - `downloadBody` (zod), `type DownloadAsk` (below), `askOf(body)`, `queueDownload(port, ask): Promise<QueuedDownloads | SeasonRefused>`, `interface QueuedDownloads {created, whole, not_aired, downloads}`, `interface SeasonRefused {refused: 'unknown_season' | 'downloads_off', message}`, `listedDownloads(all, host, only)`, `downloadsActive(list)`, `downloadErrorResponse(c, err)`.
  - `DownloadAsk`:
    ```ts
    | { scope: 'one'; ref: StreamRef; via: 'auto' | 'cloud'; infoHash: null }
    | { scope: 'one'; ref: StreamRef; via: 'torrent'; infoHash: string | null }
    | { scope: 'season'; tmdbId: number; season: number; via: DownloadVia }
    ```
- Routes:
  - `POST /api/stream/downloads`, same-origin only. Body: `{kind: 'movie', tmdb_id, via?, info_hash?}`, `{kind: 'tv', tmdb_id, season, episode, via?, info_hash?}` or `{kind: 'tv', tmdb_id, season, via?}` (a season). `via` is `auto` (the default), `torrent` or `cloud`. `info_hash` is 40 hex characters and means `via: torrent`; sent with another `via`, or on a season, it gets 400 `invalid_body`. Answers: 202 `{ok: true, created, whole, not_aired, downloads}` when `created > 0`, 200 with the same shape otherwise (already queued, or whole here). Other answers: 400 `invalid_json`, 400 `invalid_body` (also `DownloadError('invalid_request')`), 403 `forbidden_origin`, 404 `unknown_season` (the title lists no episode of that season), 503 `downloads_off` (the queue is off, the daemon stops, or no episode list is wired for a season).
  - `GET /api/stream/downloads[?title=movie-<id>|tv-<id>]` answers `{host, active, downloads}`. Without `?title=`, `downloads` holds this host's queued, running, paused and failed rows (never `done`, never a `failed` row whose `error` is `cancelled`), in the order the engine lists them. With `?title=` it narrows to that title and also holds its `done` rows (the latest per film or episode, only while still whole on this machine), so the title page can say "on this machine"; a bad `title` gets 400 `invalid_query`. `active` is true while a listed row is `queued`, `running` or `paused` (never from a `done` or `failed` row). Each row is phase 2's `DownloadView` plus `title_id`.
  - `DELETE /api/stream/downloads/:id`, same-origin only, answers `{ok: true, download}`. A malformed id, another host's id or `DownloadError('unknown_download')` gets 404 `unknown_download`.
- `web/src/moviesApi.ts`: these types:
  - `DownloadVia`, `DownloadState`, `DownloadSource`
  - `DownloadView`, `DownloadsView`, `DownloadRequest`, `DownloadQueued`

  And these functions:
  - `requestDownload(ask: DownloadRequest): Promise<DownloadQueued>`
  - `fetchDownloads(titleId?: string | null, signal?: AbortSignal): Promise<DownloadsView>`
  - `cancelDownload(id: string): Promise<void>`
- `tests/unit/directStream/downloadsFakes.ts`: `dview`, `fakeDownloads`, `HOST`, `DL_ID` (shared fakes).

**Signature changes:**
- `StreamCacheToolDeps` gains `downloads?: StreamDownloadsPort | null`. `streamCacheToolDeps(deps)` fills it from `deps.streamDownloads`.
- `direct_stream_cache` input gains `provider?: 'torrent' | 'cloud'` and `info_hash?: string` (40 hex). `action: "start"` with `season` and no `episode` is now a season download. Before, it got `invalid_input`; it still does for `status` and `clear`.
- `direct_stream_cache` answers:
  - `start` with `provider: "torrent"`, or with a season: `{started, title, ...picked, provider, created, whole, not_aired?, downloads, next}`.
  - `status` of a title: `{title, ...picked, caches, downloads, next}`.
  - `status` by an id that is not a cache: `{downloads: [d], next}`.
  - `list`: `{host, count, caches, downloads, next}`. `count` still counts caches.
  - A start with no provider, or with `provider: "cloud"`, for one film or episode answers exactly as today.

**Requires (from earlier phases)**, as the phase 1, 2 and 3 plans state them (reconciled):
- Phase 2, `src/directStream/downloads/service.ts`, `class StreamDownloads`:
  - `get host(): string`
  - `request(ref: StreamRef, ask: { via: DownloadVia; infoHash?: string | null; batch?: string | null }): Promise<DownloadRequestAnswer>`, answered at once: `{download: DownloadView | null, created: boolean, onDisk: boolean}` (`download` null and `onDisk` true when the film or episode is already whole here; a failed row is queued again with `created: true`). Throws `DownloadError` `invalid_request` or `downloads_off`.
  - `cancel(id: string): Promise<DownloadView>`; throws `DownloadError('unknown_download')` (another host's id is unknown here: the repo reads this host's rows only).
  - `list(filter?: { kind: 'movie' | 'tv'; tmdbId: number }): Promise<DownloadView[]>`, live progress, this host's rows only, never a cancelled one; no `done` row without a filter; with one, the title's latest `done` row per film or episode while it is still whole here.
- Phase 3, on the same class: `requestSeason(tmdbId: number, season: number, options: { via: DownloadVia }): Promise<SeasonAnswer<DownloadRequestAnswer>>` from `src/directStream/downloads/season.ts`: `{ok: true, batch, queued: DownloadRequestAnswer[], left_out: {episode, why: 'not_aired' | 'no_air_date' | 'whole'}[]}` or `{ok: false, error: 'unknown_season' | 'seasons_off', detail}`.
- Phase 2, `src/directStream/downloads/types.ts`:
  - `type DownloadVia = 'auto' | 'torrent' | 'cloud'`, `type DownloadState = 'queued' | 'running' | 'paused' | 'done' | 'failed'`
  - `class DownloadError extends Error { code: 'invalid_request' | 'downloads_off' | 'unknown_download' }`, built `new DownloadError(code, message)`
  - `interface DownloadView` with exactly these snake_case fields: `id`, `host`, `available`, `kind`, `tmdb_id`, `season`, `episode` (`season` and `episode` null for a film), `via`, `info_hash`, `batch`, `state`, `source` (`'torrent' | 'cloud' | null`), `source_id` (the info hash or the stream cache id), `progress` (0..1), `bytes_done`, `bytes_total`, `peers`, `down_kbps`, `error`, `detail`, `created_at`, `updated_at`, `finished_at`.
  - `interface DownloadRequestAnswer { download: DownloadView | null; created: boolean; onDisk: boolean }`.
- Phase 2: `AppDeps.streamDownloads?: StreamDownloads | null` (`src/deps.ts`), set in `src/daemon.ts`; null when `NOTESD_STREAM_DOWNLOADS=off` or direct streaming is off. The configuration rows (`NOTESD_STREAM_DOWNLOADS`, `NOTESD_STREAM_DOWNLOAD_SSID`) are phase 2's, and so is `verify.sh`'s SSID pin.
- Phase 1: `stream_downloads.id` is a uuid made by the database (`defaultRandom`), and the table has the columns `host`, `kind`, `tmdb_id`, `season`, `episode`, `via`, `info_hash`, `batch`, `state`, `source`, `source_id`, `error`, `error_detail`. The Proof's SQL reads them. `truncateAll` empties `stream_downloads`.
- Phase 2's engine for the integration test (Step 9) is built as phase 2's own tests build it: `new StreamDownloads({ host, repo: new DownloadsRepo(db), torrents: null, caches: new FakeCaches(), ssid: async () => null, playingTorrents: () => [], now, log, every: () => () => undefined })` (`FakeCaches` from phase 2's `tests/unit/directStream/downloads/fakes.ts`).

**Leaves alone (owned by others):**
- `src/directStream/downloads/*` (phases 2 and 3).
- `src/directStream/cacheShelf.ts`, `src/http/streamDiskApi.ts`, `src/mcp/streamDiskTool.ts` and the Cache page group of `scripts/docs/httpRoutes.ts` (phase 5).
- The story routes and the Movies group of `scripts/docs/httpRoutes.ts` (phase 6).
- The story types in `web/src/moviesApi.ts` (phase 7).
- Every React component (phases 5, 7, 8).
- `docs/guide/*.md` prose, `.claude/skills/verify-notesd/*` and `CLAUDE.md` (phase 9).
- The codename wording in `src/mcp/instructions.ts`, `src/chat/prompt.ts` and the `n` skill (unchanged).
- `STREAM_CACHE_TOOL_NAMES` and the chat bar's allow list. The chat bar still neither caches nor downloads.

## Files

| File | Action | What changes |
|---|---|---|
| `src/http/streamDownloadsApi.ts` | create | the three routes, the body schema, `DownloadAsk`, `queueDownload`, `listedDownloads`, the error mapping |
| `src/http/app.ts` | modify | import (after line 33), mount after `streamCacheRoutes` (line 158), the doc comment (line 123) |
| `src/mcp/streamCacheTools.ts` | modify (whole file below) | `provider`, `info_hash`, a season start, downloads in `status`/`list`, `downloads_off` |
| `scripts/docs/httpRoutes.ts` | modify | new group "Stream downloads" between "Direct streaming" and "Torrents" (insert at line 292) |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `src/mcp/instructions.ts` | modify | one added sentence in the Direct streaming paragraph (line 64) |
| `claude/skills/direct-stream/SKILL.md` | modify | one bullet in "Caching first" (after line 211) |
| `web/src/moviesApi.ts` | modify | new section at the end of the file (after line 962) |
| `tests/unit/directStream/downloadsFakes.ts` | create | the fake engine and view shared by the two unit tests |
| `tests/unit/directStream/downloadsRoutes.test.ts` | create | route unit tests for every status |
| `tests/unit/mcp.streamCacheTools.test.ts` | modify | new cases for provider, season, downloads, the same call as the button |
| `web/src/moviesApi.downloads.test.tsx` | create | the client functions' URLs, bodies and normalising |
| `tests/integration/streamDownloads.routes.int.test.ts` | create | queue through the route on a real `stream_downloads`, read back, host isolation (phase 1 owns `directStream.downloads.int.test.ts`) |

## Implementation Steps

### Step 1: The routes
**File:** `src/http/streamDownloadsApi.ts` (new)
**Change:** One router guarded by `downloads_off`.
- The body is validated once, as a union where a season cannot carry an episode or a torrent. `askOf` then turns it into a `DownloadAsk`, whose type cannot hold an `info_hash` with any `via` but `torrent`.
- `queueDownload` is the one place a body becomes an engine call. The MCP tool calls it too, so the button and the tool queue the same download (R1.10).
- `listedDownloads` is the one place that decides what is listed. The tool shares it.
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { SeasonAnswer } from '../directStream/downloads/season.js';
import type { StreamDownloads } from '../directStream/downloads/service.js';
import { DownloadError, type DownloadRequestAnswer, type DownloadVia, type DownloadView } from '../directStream/downloads/types.js';
import type { StreamRef } from '../directStream/types.js';
import { parseTitleId, type TitleKind } from '../movies/types.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The download queue (src/directStream/downloads/service.ts): the title page's Download buttons and direct_stream_cache's
 * torrent option queue a film, an episode or a season here; the title page and the Cache page read how far each one is.
 * POST answers at once and the engine downloads after it. The writes are same-origin only. Only this host's downloads
 * are listed: a row of the other machine names files that are not here.
 */

export const DOWNLOADS_OFF = {
  error: 'downloads_off',
  message: 'Downloads are off on this machine (NOTESD_STREAM_DOWNLOADS=off, or direct streaming off).',
} as const;

const UNKNOWN_DOWNLOAD = { error: 'unknown_download', message: 'No download has this id.' } as const;

/** A download id: the uuid `stream_downloads` makes. */
export const DOWNLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the routes and direct_stream_cache call on the daemon's StreamDownloads; tests pass a fake. */
export type StreamDownloadsPort = Pick<StreamDownloads, 'host' | 'request' | 'requestSeason' | 'cancel' | 'list'>;

/** A download as the routes and the tool answer it: the engine's view plus the title key (`movie-550`, `tv-1399`). */
export type ListedDownload = DownloadView & { title_id: string };

export function listed(d: DownloadView): ListedDownload {
  return { ...d, title_id: `${d.kind}-${d.tmdb_id}` };
}

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const season = z.number().int().min(0).max(1000);
const episode = z.number().int().min(1).max(10_000);
const via = z.enum(['auto', 'torrent', 'cloud']);
const infoHash = z.string().regex(/^[0-9a-fA-F]{40}$/, 'an info hash is 40 hexadecimal characters');

/** A film, one episode, or a season (`tv` with `season` and no `episode`; it takes no info_hash). */
export const downloadBody = z.union([
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, via: via.optional(), info_hash: infoHash.optional() }),
  z.strictObject({ kind: z.literal('tv'), tmdb_id: tmdbId, season, episode, via: via.optional(), info_hash: infoHash.optional() }),
  z.strictObject({ kind: z.literal('tv'), tmdb_id: tmdbId, season, via: via.optional() }),
]);

export type DownloadBody = z.infer<typeof downloadBody>;

/**
 * One ask of the queue, as the route and the tool both build it. A torrent named by hand goes with via torrent only, and a
 * season names no torrent: the type cannot hold either mistake.
 */
export type DownloadAsk =
  | { scope: 'one'; ref: StreamRef; via: 'auto' | 'cloud'; infoHash: null }
  | { scope: 'one'; ref: StreamRef; via: 'torrent'; infoHash: string | null }
  | { scope: 'season'; tmdbId: number; season: number; via: DownloadVia };

/** What a queued ask answers. */
export interface QueuedDownloads {
  /** Rows this ask made (or failed rows it queued again). 0: everything asked for was queued already or is whole here. */
  created: number;
  /** Films or episodes left out because they are whole on this machine. */
  whole: number;
  /** A season's episodes left out because they have not aired or TMDB gives them no air date (0 for a film or one episode). */
  not_aired: number;
  /** The rows made or found, in GET /api/stream/downloads' shape. */
  downloads: ListedDownload[];
}

/** A season ask the engine refused: no episode of it is listed (404), or no season download is wired (503 downloads_off). */
export interface SeasonRefused {
  refused: 'unknown_season' | 'downloads_off';
  message: string;
}

function fromOne(answers: readonly DownloadRequestAnswer[]): Pick<QueuedDownloads, 'created' | 'whole' | 'downloads'> {
  return {
    created: answers.filter((a) => a.created).length,
    whole: answers.filter((a) => a.onDisk).length,
    downloads: answers.flatMap((a) => (a.download === null ? [] : [listed(a.download)])),
  };
}

function fromSeason(r: SeasonAnswer<DownloadRequestAnswer>): QueuedDownloads | SeasonRefused {
  if (!r.ok) return { refused: r.error === 'unknown_season' ? 'unknown_season' : 'downloads_off', message: r.detail };
  const one = fromOne(r.queued);
  return {
    ...one,
    whole: one.whole + r.left_out.filter((l) => l.why === 'whole').length,
    not_aired: r.left_out.filter((l) => l.why === 'not_aired' || l.why === 'no_air_date').length,
  };
}

function one(ref: StreamRef, asked: DownloadVia | undefined, hash: string | undefined): DownloadAsk | { refused: string } {
  if (hash === undefined) {
    const v = asked ?? 'auto';
    return v === 'torrent' ? { scope: 'one', ref, via: 'torrent', infoHash: null } : { scope: 'one', ref, via: v, infoHash: null };
  }
  if (asked !== undefined && asked !== 'torrent') return { refused: 'info_hash names one torrent: send it with via "torrent", or with no via.' };
  return { scope: 'one', ref, via: 'torrent', infoHash: hash.toLowerCase() };
}

/** The validated body as an ask, or why it is refused (400 invalid_body). */
export function askOf(body: DownloadBody): DownloadAsk | { refused: string } {
  if (body.kind === 'movie') return one({ kind: 'movie', tmdbId: body.tmdb_id }, body.via, body.info_hash);
  if (!('episode' in body)) return { scope: 'season', tmdbId: body.tmdb_id, season: body.season, via: body.via ?? 'auto' };
  return one({ kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode }, body.via, body.info_hash);
}

/**
 * Queues an ask on the engine (phase 2's `request`, phase 3's `requestSeason`) and says what it queued. The route and
 * direct_stream_cache both come through here, so they queue the same download.
 */
export async function queueDownload(port: StreamDownloadsPort, ask: DownloadAsk): Promise<QueuedDownloads | SeasonRefused> {
  if (ask.scope === 'season') return fromSeason(await port.requestSeason(ask.tmdbId, ask.season, { via: ask.via }));
  const r = await port.request(ask.ref, ask.infoHash === null ? { via: ask.via } : { via: ask.via, infoHash: ask.infoHash });
  return { ...fromOne([r]), not_aired: 0 };
}

/**
 * What is listed: this host's downloads, leaving out the ones the owner cancelled; narrowed to one title when `only`
 * names it, and then with that title's finished ones the engine answered (the title page's "on this machine"), else
 * never a finished one (a finished one is on the Cache page). The engine's order is kept; each row gains `title_id`.
 */
export function listedDownloads(all: readonly DownloadView[], host: string, only: { kind: TitleKind; tmdbId: number } | null): ListedDownload[] {
  return all
    .filter(
      (d) =>
        d.host === host &&
        !(d.state === 'failed' && d.error === 'cancelled') &&
        (only === null ? d.state !== 'done' : d.kind === only.kind && d.tmdb_id === only.tmdbId),
    )
    .map(listed);
}

/** True while a listed download still moves (queued, running, or paused for a play): the title page reads again only then. */
export function downloadsActive(list: readonly DownloadView[]): boolean {
  return list.some((d) => d.state === 'queued' || d.state === 'running' || d.state === 'paused');
}

/** DownloadError -> its HTTP answer; anything else is rethrown (500). */
export function downloadErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof DownloadError)) throw err;
  if (err.code === 'unknown_download') return c.json({ error: err.code, message: err.message }, 404);
  if (err.code === 'downloads_off') return c.json(DOWNLOADS_OFF, 503);
  return c.json({ error: 'invalid_body', message: err.message }, 400);
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

export function streamDownloadsRoutes(deps: Pick<AppDeps, 'streamDownloads'>): Hono {
  const r = new Hono();
  r.use('/api/stream/downloads', async (c, next) => {
    if ((deps.streamDownloads ?? null) === null) return c.json(DOWNLOADS_OFF, 503);
    await next();
  });
  r.use('/api/stream/downloads/*', async (c, next) => {
    if ((deps.streamDownloads ?? null) === null) return c.json(DOWNLOADS_OFF, 503);
    await next();
  });

  r.post('/api/stream/downloads', sameOriginOnly, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = downloadBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    const ask = askOf(body.data);
    if ('refused' in ask) return c.json({ error: 'invalid_body', message: ask.refused }, 400);
    try {
      const queued = await queueDownload(deps.streamDownloads!, ask);
      if ('refused' in queued) {
        return queued.refused === 'unknown_season' ? c.json({ error: 'unknown_season', message: queued.message }, 404) : c.json(DOWNLOADS_OFF, 503);
      }
      return c.json({ ok: true, ...queued }, queued.created > 0 ? 202 : 200);
    } catch (err) {
      return downloadErrorResponse(c, err);
    }
  });

  r.get('/api/stream/downloads', async (c) => {
    const port = deps.streamDownloads!;
    const title = c.req.query('title');
    const only = title === undefined ? null : parseTitleId(title);
    if (title !== undefined && only === null) {
      return c.json({ error: 'invalid_query', message: 'title: a title id is movie-<tmdb id> or tv-<tmdb id>.' }, 400);
    }
    const downloads = listedDownloads(await port.list(only === null ? undefined : { kind: only.kind, tmdbId: only.tmdbId }), port.host, only);
    return c.json({ host: port.host, active: downloadsActive(downloads), downloads });
  });

  r.delete('/api/stream/downloads/:id', sameOriginOnly, async (c) => {
    const id = c.req.param('id');
    if (!DOWNLOAD_ID_PATTERN.test(id)) return c.json(UNKNOWN_DOWNLOAD, 404);
    try {
      const download = await deps.streamDownloads!.cancel(id.toLowerCase());
      return c.json({ ok: true, download });
    } catch (err) {
      return downloadErrorResponse(c, err);
    }
  });

  return r;
}
```
**Impact:** new routes only. Nothing existing changes.

### Step 2: Mount the routes
**File:** `src/http/app.ts:33`, `:123`, `:158`
**Change:**
- After line 33 (`import { streamCacheRoutes } from './streamCacheApi.js';`), add:
```ts
import { streamDownloadsRoutes } from './streamDownloadsApi.js';
```
- After line 158 (`app.route('/', streamCacheRoutes(deps));`), add:
```ts
  app.route('/', streamDownloadsRoutes(deps));
```
- In the doc comment at line 123, after `streamCacheRoutes (stream-cache phase 5: the stream cache), ` insert `streamDownloadsRoutes (stream-downloads phase 4: the download queue the title page and direct_stream_cache fill), `.
**Impact:** The reference test (`tests/unit/docs/reference.test.ts`) now sees three new routes. Step 4 documents them in the same change.

### Step 3: `direct_stream_cache` takes a torrent and a season, and lists downloads
**File:** `src/mcp/streamCacheTools.ts` (whole file; today 228 lines)
**Change:** These are refused where they enter (`argumentProblem`):
- `provider` or `info_hash` outside `start`
- `info_hash` without `provider: "torrent"`
- `max_height` with a torrent
- `info_hash` or `max_height` on a season

`resolveTarget` returns a three-way `scope` (`one`, `season`, `none`). A season reaches `start` only.

With `provider: "torrent"`, a film or episode goes through `queueDownload` with `via: 'torrent'`, the same call the button's "Best torrent" makes. A season goes through `queueDownload` as a season: `via: 'torrent'` with `provider: "torrent"`, otherwise `'cloud'`, so the default stays the cloud everywhere. With no provider, or with `"cloud"`, one film or episode keeps today's `StreamCache.request` path, unchanged. `status` and `list` add `downloads` (`listedDownloads`). `status` by id also finds a download.
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STREAM_CACHE_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { CACHE_ID_PATTERN, CacheError, type StreamCacheView } from '../directStream/cache/types.js';
import { DownloadError } from '../directStream/downloads/types.js';
import { LookupError, lookupTitle, parseTitleRequest, type StreamTarget } from '../directStream/lookup.js';
import { DOWNLOADS_OFF, listedDownloads, queueDownload, type DownloadAsk, type ListedDownload, type StreamDownloadsPort } from '../http/streamDownloadsApi.js';
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
  /**
   * The download queue (src/directStream/downloads/service.ts): provider "torrent", a season, and the downloads in status
   * and list. Omitted or null (NOTESD_STREAM_DOWNLOADS=off): those starts answer downloads_off, and the lists carry none.
   */
  downloads?: StreamDownloadsPort | null;
}

/** The tool deps of a running daemon, or null when direct streaming (or the cache) is off. */
export function streamCacheToolDeps(deps: AppDeps): StreamCacheToolDeps | null {
  const lookup = directStreamToolDeps(deps);
  const cache = deps.streamCache ?? null;
  return lookup === null || cache === null ? null : { lookup, cache, downloads: deps.streamDownloads ?? null };
}

const DESCRIPTION =
  "Download a film, or one episode of a series, to this machine's disk so it can play from the local copy instead of the stream host (a slow or far host, a bad connection). " +
  'action start resolves a cloud source the way direct_stream_play does (out of sight, nothing plays, 5 to 40 seconds), then downloads one rendition with its segments, keys and the English subtitle in the background: the call answers at once with the cache (state downloading, progress, segments_done of segments_total) and the download goes on after it. ' +
  'Pass title (words without the year, a movie id, or a title key) with year and kind when known; for a series season and episode, or absolute_episode, or neither to take the episode direct_stream_play would (picked). max_height caches the tallest rendition not above it (720 for a smaller copy); without it the tallest. ' +
  'provider "torrent" downloads from a torrent instead (the best one with live seeds, 1080p first; info_hash, from direct_stream_torrents, names one torrent), through the same queue as the wall\'s Download button, and keeps it on this machine until it is deleted (stream_disk): the answer carries downloads. A series\' season without an episode (start only) downloads every aired episode of that season not yet whole here, one download each, from torrents with provider "torrent", else from the cloud; the answer says how many were queued (created), already here (whole) and not aired yet or with no air date (not_aired). provider "cloud", or none, for one film or episode is the cache above. ' +
  'action status shows that title\'s caches and downloads (or the one of id); list shows every cache and this machine\'s downloads; clear stops this machine\'s download of a cache and deletes its files. ' +
  'A cache belongs to the machine that made it: one made on the other laptop has available false and cannot be played or cleared here (not_on_this_machine). ' +
  'Answers carry cache { id, state downloading | ready | failed, progress, segments_done, segments_total, bytes, height, provider, subtitle, error, auto }. auto true is a cache a pause in the player started by itself: it clears itself three days after it was last written, and start on it makes it the owner\'s to keep. error cache_unsupported means the source cannot be cached (DASH, DRM, a live stream); token_refused that the host kept refusing fresh tokens; cache_exists that this machine holds the title at another max_height: clear it first. ' +
  'A download is { id, title_id, season, episode, state queued | running | paused | failed, via, source torrent | cloud, progress 0 to 1, bytes_done, bytes_total, error, detail }; paused waits for a torrent play on screen to end; error no_source means no torrent and no cloud source could be downloaded. downloads_off means the download queue is off on this machine; unknown_season that the series lists no episode of that season. ' +
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
  provider?: 'torrent' | 'cloud' | undefined;
  info_hash?: string | undefined;
}

type TitleView = ReturnType<typeof candidateView>;

type Resolved =
  | { scope: 'one'; target: StreamTarget; title: TitleView; picked: Record<string, unknown> }
  | { scope: 'season'; tmdbId: number; season: number; title: TitleView }
  | { scope: 'none'; answer: Record<string, unknown> };

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

function downloadErrorResult(err: DownloadError): CallToolResult {
  const next = err.code === 'unknown_download' ? 'There is no such download on this machine. Say so.' : 'Say the download could not be queued, and why (message).';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message, next }) }],
  };
}

const DOWNLOADS_OFF_RESULT: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ ...DOWNLOADS_OFF, next: 'Downloads are off on this machine. Say so; provider "cloud" (or none) still caches one film or episode.' }) }],
};

/** Arguments that only mean something together, refused where they enter. */
function argumentProblem(a: CacheArgs): string | null {
  if (a.action !== 'start' && (a.provider !== undefined || a.info_hash !== undefined)) return 'provider and info_hash go with action start only.';
  if (a.info_hash !== undefined && a.provider !== 'torrent') return 'info_hash names one torrent: pass provider "torrent" with it.';
  if (a.max_height !== undefined && a.provider === 'torrent') return 'max_height is for the cloud cache: a torrent download takes the best torrent (1080p first).';
  return null;
}

/** The film, episode or (start only) season the words name, as direct_stream_play finds it; a series without an episode takes play's pick only for `start`. */
async function resolveTarget(a: CacheArgs, title: string, d: DirectStreamToolDeps, wall: string): Promise<Resolved> {
  const result = await lookupTitle(parseTitleRequest(title, a.year ?? null, a.kind ?? null), d);
  if (result.status === 'none') {
    return {
      scope: 'none',
      answer: { skipped: 'no_match', did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)), next: 'No title has that name (or that name and year). Show did_you_mean with years and ask which is meant; then call again with its title_key.' },
    };
  }
  if (result.status === 'several') {
    return {
      scope: 'none',
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
      return { scope: 'none', answer: { skipped: 'no_such_episode', title: candidateView(c, wall), absolute_episode: a.absolute_episode, episodes: choice.episodes, next: `${label(c)} has ${choice.episodes} episodes listed. Say so.` } };
    }
    if (choice.pick === 'unclear') {
      return {
        scope: 'none',
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
    // A season with no episode: start downloads the whole season (every aired episode not whole here).
    if (a.action === 'start' && a.season !== undefined && a.episode === undefined) {
      return { scope: 'season', tmdbId: c.tmdbId, season: a.season, title: candidateView(c, wall) };
    }
    if (a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', `${label(c)} is a series: pass both season and episode.`);
    if (a.action !== 'start') {
      return { scope: 'none', answer: { skipped: 'needs_episode', title: candidateView(c, wall), next: 'A series is cached per episode: call again with season and episode (or absolute_episode).' } };
    }
    const choice = await chooseEpisode(c, d);
    if (choice.pick === 'caught_up') {
      return { scope: 'none', answer: { skipped: 'caught_up', title: candidateView(c, wall), last: choice.last, next: 'Every episode after the last one played is finished. Say so; name a season and episode to cache one.' } };
    }
    if (choice.pick === 'not_aired') {
      return { scope: 'none', answer: { skipped: 'not_aired', title: candidateView(c, wall), season: choice.season, episode: choice.episode, air_date: choice.airDate, next: 'The next episode has not aired yet. Say which and when.' } };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: choice.pick };
  }
  return { scope: 'one', target, title: candidateView(c, wall), picked: { ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}), ...picked } };
}

/** This machine's listed downloads (what GET /api/stream/downloads lists without a title); none when the queue is off. */
async function allDownloads(d: StreamCacheToolDeps): Promise<ListedDownload[]> {
  const port = d.downloads ?? null;
  return port === null ? [] : listedDownloads(await port.list(), port.host, null);
}

function sameSlot(x: ListedDownload, target: StreamTarget): boolean {
  if (x.kind !== target.kind || x.tmdb_id !== target.tmdbId) return false;
  return target.kind === 'movie' || (x.season === target.season && x.episode === target.episode);
}

/** Queues a download through the same call as POST /api/stream/downloads, and says what was queued. */
async function startDownload(d: StreamCacheToolDeps, ask: DownloadAsk, title: TitleView, picked: Record<string, unknown>): Promise<CallToolResult> {
  const port = d.downloads ?? null;
  if (port === null) return DOWNLOADS_OFF_RESULT;
  const q = await queueDownload(port, ask);
  const season = ask.scope === 'season';
  if ('refused' in q) {
    if (q.refused === 'downloads_off') return DOWNLOADS_OFF_RESULT;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_season', message: q.message, next: 'That season lists no episode. Say so.' }) }] };
  }
  return ok({
    started: q.created > 0,
    title,
    ...picked,
    provider: ask.via === 'cloud' ? 'cloud' : 'torrent',
    created: q.created,
    whole: q.whole,
    ...(season ? { not_aired: q.not_aired } : {}),
    downloads: q.downloads,
    next:
      q.downloads.length === 0
        ? season
          ? 'Every aired episode of that season is on this machine already (whole), or none has aired (not_aired). Say so.'
          : 'It is on this machine already. Say so.'
        : q.created > 0
          ? 'Say the download is queued on this machine (nothing is playing), that it is kept until it is deleted on the Cache page, and that status shows how far it is.'
          : 'It is queued or downloading already. Say how far it is (progress).',
  });
}

async function cacheAction(a: CacheArgs, d: StreamCacheToolDeps, wall: string): Promise<CallToolResult> {
  const problem = argumentProblem(a);
  if (problem !== null) throw new LookupError('invalid_input', problem);
  if (a.action === 'list') {
    const caches = await d.cache.list();
    const downloads = await allDownloads(d);
    return ok({
      host: d.cache.host,
      count: caches.length,
      caches,
      downloads,
      next: caches.length === 0 && downloads.length === 0 ? 'Nothing is cached or downloading. Say so.' : 'List them with their state and progress; available false is a cache on the other laptop.',
    });
  }
  if (a.id !== undefined) {
    const id = a.id.toLowerCase();
    if (a.action === 'start') throw new LookupError('invalid_input', 'start takes a title, not an id.');
    if (a.action === 'status') {
      const cache = await d.cache.get(id);
      if (cache !== null) return ok({ caches: [cache], next: "Say the cache's state, progress and machine." });
      const download = (await allDownloads(d)).find((x) => x.id === id);
      if (download === undefined) throw new CacheError('unknown_cache', 'No stream cache or download has this id.');
      return ok({ downloads: [download], next: "Say the download's state, progress and source." });
    }
    await d.cache.remove(id);
    return ok({ cleared: true, id, next: 'Say the cache was cleared and its files deleted from this machine.' });
  }
  if (a.title === undefined) throw new LookupError('invalid_input', `${a.action} needs a title (or an id from an earlier answer).`);
  const found = await resolveTarget(a, a.title, d.lookup, wall);
  if (found.scope === 'none') return ok(found.answer);
  if (found.scope === 'season') {
    if (a.info_hash !== undefined || a.max_height !== undefined) {
      throw new LookupError('invalid_input', 'A season downloads one torrent or cache per episode: it takes no info_hash or max_height.');
    }
    return startDownload(d, { scope: 'season', tmdbId: found.tmdbId, season: found.season, via: a.provider === 'torrent' ? 'torrent' : 'cloud' }, found.title, { season: found.season });
  }
  const { target, title, picked } = found;
  if (a.action === 'start') {
    if (a.provider === 'torrent') {
      return startDownload(d, { scope: 'one', ref: target, via: 'torrent', infoHash: a.info_hash === undefined ? null : a.info_hash.toLowerCase() }, title, picked);
    }
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
    const downloads = (await allDownloads(d)).filter((x) => sameSlot(x, target));
    return ok({
      title,
      ...picked,
      caches,
      downloads,
      next: caches.length === 0 && downloads.length === 0 ? 'Nothing of it is cached or downloading. Say so.' : "Say each cache's and download's state, progress and machine.",
    });
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
        action: z.enum(['start', 'status', 'list', 'clear']).describe('start a download, status of one title (or id), list every cache and download, clear (stop and delete) one cache.'),
        title: z.string().trim().min(1).max(200).optional().describe("The film or series title without the year, a movie id (M-23T4; an episode's id names its season and episode), or a title key (movie-550)."),
        year: z.number().int().min(1880).max(2100).optional().describe('The release year, when known.'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: z.number().int().min(0).max(1000).optional().describe('A series only: the season of the episode; with start and no episode, the whole season.'),
        episode: z.number().int().min(0).max(100000).optional().describe('A series only: the episode number within that season.'),
        absolute_episode: z.number().int().min(1).max(100000).optional().describe('A series only, instead of season and episode: an episode named by one number ("One Piece episode 730").'),
        max_height: z.number().int().min(100).max(4320).optional().describe('start from the cloud only: cache the tallest rendition not above this height (720, 480). Default: the tallest.'),
        provider: z.enum(['torrent', 'cloud']).optional().describe('start only: "torrent" downloads from a torrent (kept until deleted); "cloud" or none caches from a cloud source.'),
        info_hash: z.string().trim().regex(/^[0-9a-fA-F]{40}$/).optional().describe('start with provider "torrent", one film or episode: download exactly this torrent (an info_hash from direct_stream_torrents).'),
        id: z.string().trim().regex(CACHE_ID_PATTERN).optional().describe('A cache or download id from an earlier answer, instead of title (status; clear takes a cache id).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const d = deps.streamCache;
      if (!d) return { isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] };
      try {
        return await cacheAction(args, d, wall);
      } catch (err) {
        if (err instanceof CacheError) return cacheErrorResult(err);
        if (err instanceof DownloadError) return downloadErrorResult(err);
        return movieErrorResult(err);
      }
    },
  );
}
```
**Impact:**
- The existing tool tests still pass unchanged. Their deps omit `downloads`, a call with no provider still calls `cache.request(target, {maxHeight})`, and `list` keeps `count`/`caches`. `status` gains `downloads: []`, and `toMatchObject` tolerates the extra field.
- `src/http/app.ts:103` (`streamCache: streamCacheToolDeps(deps)`) needs no change.

### Step 4: Describe the routes and regenerate the references
**File:** `scripts/docs/httpRoutes.ts:292`
**Change:** Insert the new group between the closing `  },` of the "Direct streaming" group (line 291) and the `  {` that opens "Torrents" (line 292). That keeps it clear of the "Cache page" group, which phase 5 edits after this phase (its `'GET /api/stream/disk'` entry moves down by this group's lines), and the "Movies" group, which phase 6 edits (no dependency edge: phase 6's two story entries at lines 204–207 are above this insert, a separate place). The guide link carries no anchor because phase 9 writes the section. Then run `npm run docs:gen`, which rewrites `docs/guide/reference/http-api.md` and `docs/guide/reference/mcp-tools.md` for the route group and the new tool description. Never hand-edit either file. These two files are regenerated, never merged: phases 4, 5 and 6 each regenerate them, and the integrator regenerates them with `npm run docs:gen` after every merge instead of merging their text.
**Code:**
```ts
  {
    title: 'Stream downloads',
    intro:
      'Films and episodes the owner asked to have on this machine for streaming: the title page\'s Download buttons and `direct_stream_cache` with `provider: "torrent"` or a season. A download ends as a torrent download or a cloud cache that is kept until it is deleted on the Cache page, and a restart carries on what was queued. Only this host\'s downloads are listed. Every route answers 503 `downloads_off` when the queue is off (`NOTESD_STREAM_DOWNLOADS=off`, or direct streaming off). Guide: [streaming.md](../streaming.md).',
    routes: {
      'POST /api/stream/downloads':
        '`{kind, tmdb_id, season?, episode?, via?, info_hash?}`: queue a film (`movie`), one episode (`tv` with `season` and `episode`) or a season (`tv` with `season` alone: every aired episode of it that is not whole on this machine, one download each, sharing a `batch`). `via` is `auto` (the default: a 1080p torrent with live seeds, then the cloud at 1080p or lower, then a torrent below 1080p; on the office network the cloud alone), `torrent` or `cloud`, and only that source is used. `info_hash` (40 hexadecimal characters, a film or an episode only) downloads exactly that torrent and means `via: "torrent"`. Answers at once and downloads after: 202 `{ok: true, created, whole, not_aired, downloads}` when it queued something, 200 in the same shape when everything asked for is queued already or whole here. `whole` counts what was left out for being on this machine, `not_aired` the season\'s episodes left out for not having aired or having no air date, and `downloads` are the rows made or found, in the shape `GET /api/stream/downloads` lists. 400 `invalid_body` (also an `info_hash` with another `via`, or on a season); 404 `unknown_season` (the series lists no episode of that season). Same-origin only.',
      'GET /api/stream/downloads':
        '`{host, active, downloads}`: every queued, running, paused and failed download of this machine (a finished one is on the Cache page; a cancelled one is not listed). A download is `{id, host, available, title_id, kind, tmdb_id, season, episode, state, via, info_hash, batch, source, source_id, progress, bytes_done, bytes_total, peers, down_kbps, error, detail, created_at, updated_at, finished_at}`: `season` and `episode` are null for a film; `state` is `queued`, `running`, `paused` (a torrent play on screen comes first), `failed`, or `done` (with `title` only); `source` is `torrent` or `cloud`, null before one is chosen, and `source_id` its info hash or stream cache id; `progress` runs from 0 to 1; `error` is why it failed (`no_source`: no torrent and no cloud source could be downloaded; also `no_peers_here`, `dubbed`, `download_failed`, `torrent_off`, `cloud_off` or the stream cache\'s own code) and `detail` what each source tried saw. `active` is true while one is queued, running or paused. Query: `title` (`movie-<tmdb id>` or `tv-<tmdb id>`) narrows the list to that title and adds its finished downloads still on this machine (the latest per film or episode, `state: done`); 400 `invalid_query` for any other value.',
      'DELETE /api/stream/downloads/:id':
        'Cancel a download of this machine: it leaves the queue and is no longer listed. `{ok: true, download}`. What it already wrote stays (a cancelled cloud download keeps its cache) and is deleted on the Cache page. 404 `unknown_download` (also the other machine\'s id). Same-origin only.',
    },
  },
```
**Impact:** `tests/unit/docs/reference.test.ts` passes again: routes, entries and the generated files agree.

### Step 5: Tell Claude Code a title can be downloaded from a torrent
**File:** `src/mcp/instructions.ts:64`
**Change:** In the Direct streaming template string, replace the exact text `Call it only when the user asks to cache, download first, check or clear one ("cache One Piece episode 790 first", "is it cached?").` with:
```ts
Call it only when the user asks to cache, download first, check or clear one ("cache One Piece episode 790 first", "is it cached?"). With provider "torrent" it downloads from a torrent instead, through the queue the wall's Download buttons use, and keeps the download until it is deleted; a season without an episode downloads every aired episode of it not yet on this machine ("download Severance season 2 from a torrent"); status and list also carry the downloads with their state and progress.
```
**Impact:** One sentence is added, and the codename sentences are untouched. `tests/unit/mcp.instructions.test.ts` asserts only phrases that stay.

**File:** `claude/skills/direct-stream/SKILL.md:211`
**Change:** After the bullet `- **"clear the cache of X":** clear it. Nothing else removes a cache.` (line 211), insert:
```markdown
- **"download X from a torrent", "download season 2 of X":** start with `provider: "torrent"` (a
  season: `season` and no episode; without `provider` a season comes from the cloud). It queues the
  same download the title page's Download button does, kept on this laptop until it is deleted on
  the Cache page; `status` shows its `downloads` with their state and progress.
```
**Impact:** This is the skill text only. The frontmatter description already covers "caching a title on this laptop".

### Step 6: The web client functions
**File:** `web/src/moviesApi.ts:962` (append after `undoStreamDisk`, the end of the file)
**Change:** Add the types and three functions phases 5 and 8 import. Values are normalised once here: `progress` is clamped to 0..1, a missing list becomes `[]`, a missing number becomes 0.
**Code:**
```ts
// ---------- downloads (POST, GET, DELETE /api/stream/downloads) ----------

/** How a download was asked for: `auto` (the Download button: a 1080p torrent, then the cloud, then a lower torrent), or one source. */
export type DownloadVia = 'auto' | 'torrent' | 'cloud';
export type DownloadState = 'queued' | 'running' | 'paused' | 'done' | 'failed';
export type DownloadSource = 'torrent' | 'cloud';

/** One download of this machine, as GET /api/stream/downloads lists it (phase 2's DownloadView plus `title_id`). */
export interface DownloadView {
  id: string;
  host: string;
  available: boolean;
  /** `movie-<tmdb id>` or `tv-<tmdb id>`, the title's `id`. */
  title_id: string;
  kind: TitleKind;
  tmdb_id: number;
  /** Null for a film. */
  season: number | null;
  /** Null for a film. */
  episode: number | null;
  /** `done` only in an answer narrowed to one title (`?title=`): it is on this machine. */
  state: DownloadState;
  via: DownloadVia;
  /** The torrent picked by hand; null otherwise. */
  info_hash: string | null;
  /** What it downloads from; null while no source is chosen yet. */
  source: DownloadSource | null;
  /** The torrent's info hash or the stream cache's id; null while no source is chosen yet. */
  source_id: string | null;
  /** 0 to 1. */
  progress: number;
  bytes_done: number;
  bytes_total: number | null;
  peers: number | null;
  down_kbps: number | null;
  /** Why it failed (`no_source`, ...); null unless `state` is `failed`. */
  error: string | null;
  /** What each source it tried saw, when it failed. */
  detail: string | null;
  /** Shared by the episodes one season's click queued; null for a single film or episode. */
  batch: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface DownloadsView {
  host: string;
  /** Something is queued, running or paused: read again soon. False: nothing moves, so nothing needs reading again. */
  active: boolean;
  downloads: DownloadView[];
}

/** What the Download button asks for: a film, an episode (a torrent may be named), or a whole season. */
export type DownloadRequest =
  | { kind: 'movie'; tmdb_id: number; via?: DownloadVia; info_hash?: string }
  | { kind: 'tv'; tmdb_id: number; season: number; episode: number; via?: DownloadVia; info_hash?: string }
  | { kind: 'tv'; tmdb_id: number; season: number; episode?: never; via?: DownloadVia; info_hash?: never };

export interface DownloadQueued {
  /** Downloads this request made; 0 when everything asked for was queued already or is on this machine. */
  created: number;
  whole: number;
  not_aired: number;
  downloads: DownloadView[];
}

function downloadOf(d: DownloadView): DownloadView {
  const p = typeof d.progress === 'number' && Number.isFinite(d.progress) ? Math.min(1, Math.max(0, d.progress)) : 0;
  return {
    ...d,
    season: d.season ?? null,
    episode: d.episode ?? null,
    info_hash: d.info_hash ?? null,
    source: d.source ?? null,
    source_id: d.source_id ?? null,
    progress: p,
    bytes_done: d.bytes_done ?? 0,
    bytes_total: d.bytes_total ?? null,
    peers: d.peers ?? null,
    down_kbps: d.down_kbps ?? null,
    error: d.error ?? null,
    detail: d.detail ?? null,
    batch: d.batch ?? null,
    finished_at: d.finished_at ?? null,
  };
}

/** Queues a film, an episode or a season; answers at once. Throws ApiError `downloads_off`, `invalid_body`, `unknown_season`. */
export async function requestDownload(ask: DownloadRequest): Promise<DownloadQueued> {
  const r = await postJson<Partial<DownloadQueued>>('/api/stream/downloads', ask);
  return { created: r?.created ?? 0, whole: r?.whole ?? 0, not_aired: r?.not_aired ?? 0, downloads: list(r?.downloads).map(downloadOf) };
}

/** This machine's queued, running, paused and failed downloads; of one title when `titleId` names it, then with its `done` ones still on this machine. Throws ApiError `downloads_off`. */
export async function fetchDownloads(titleId: string | null = null, signal?: AbortSignal): Promise<DownloadsView> {
  const url = titleId === null ? '/api/stream/downloads' : `/api/stream/downloads?title=${enc(titleId)}`;
  const v = await getJson<Partial<DownloadsView>>(url, signal);
  return { host: v.host ?? '', active: v.active === true, downloads: list(v.downloads).map(downloadOf) };
}

/** Cancels a download of this machine. Throws ApiError `unknown_download`. */
export async function cancelDownload(id: string): Promise<void> {
  const res = await fetch(`/api/stream/downloads/${enc(id)}`, { method: 'DELETE', headers: JSON_HEADERS });
  if (!res.ok) throw await failure(res);
}
```
**Impact:** These are additions only. `enc`, `list`, `postJson`, `getJson`, `failure` and `JSON_HEADERS` already exist in the file (lines 494–544).

### Step 7: Shared fakes and the route tests
**File:** `tests/unit/directStream/downloadsFakes.ts` (new)
**Code:**
```ts
import { vi } from 'vitest';
import type { DownloadRequestAnswer, DownloadView } from '../../../src/directStream/downloads/types.js';
import type { StreamDownloadsPort } from '../../../src/http/streamDownloadsApi.js';

export const HOST = 'here';
export const DL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** One download as the engine (phase 2) lists it; a queued film of Saltburn unless told otherwise. */
export function dview(over: Partial<DownloadView> = {}): DownloadView {
  return {
    id: DL_ID,
    host: HOST,
    available: true,
    kind: 'movie',
    tmdb_id: 930564,
    season: null,
    episode: null,
    via: 'auto',
    info_hash: null,
    batch: null,
    state: 'queued',
    source: null,
    source_id: null,
    progress: 0,
    bytes_done: 0,
    bytes_total: null,
    peers: null,
    down_kbps: null,
    error: null,
    detail: null,
    created_at: '2026-11-20T12:00:00.000Z',
    updated_at: '2026-11-20T12:00:00.000Z',
    finished_at: null,
    ...over,
  };
}

/** What `request` answers for a row made now. */
export const made = (d: DownloadView = dview()): DownloadRequestAnswer => ({ download: d, created: true, onDisk: false });

/** A fake engine: request makes one row, requestSeason three, list answers `rows`. */
export function fakeDownloads(rows: DownloadView[] = [dview()]) {
  const request = vi.fn<StreamDownloadsPort['request']>(async () => made());
  const requestSeason = vi.fn<StreamDownloadsPort['requestSeason']>(async () => ({
    ok: true,
    batch: 'b1',
    queued: [1, 2, 3].map((e) => made(dview({ id: `dddddddd-dddd-4ddd-8ddd-00000000000${e}`, kind: 'tv', tmdb_id: 247718, season: 1, episode: e, batch: 'b1' }))),
    left_out: [],
  }));
  const cancel = vi.fn<StreamDownloadsPort['cancel']>(async (id) => dview({ id, state: 'failed', error: 'cancelled' }));
  const list = vi.fn<StreamDownloadsPort['list']>(async () => rows);
  const port: StreamDownloadsPort = { host: HOST, request, requestSeason, cancel, list };
  return { port, request, requestSeason, cancel, list };
}
```

**File:** `tests/unit/directStream/downloadsRoutes.test.ts` (new)
**Change:** Each status and each choice is checked by what the caller sees (status, body) and what the engine was asked (the engine is the seam, not the unit under test).
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { DownloadError } from '../../../src/directStream/downloads/types.js';
import { streamDownloadsRoutes, type StreamDownloadsPort } from '../../../src/http/streamDownloadsApi.js';
import { DL_ID, dview, fakeDownloads } from './downloadsFakes.js';

const SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
const HASH = '67B07B417F6F8F7D367BBDED3CD797A0840724B6';
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);
const app = (port: StreamDownloadsPort | null) => streamDownloadsRoutes({ streamDownloads: port as never });
const post = (port: StreamDownloadsPort | null, body: unknown, headers: Record<string, string> = SAME) =>
  app(port).fetch(req('/api/stream/downloads', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('the download routes', () => {
  it('answer downloads_off on every route when the queue is off', async () => {
    for (const r of [
      await post(null, { kind: 'movie', tmdb_id: 1 }),
      await app(null).fetch(req('/api/stream/downloads')),
      await app(null).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE', headers: SAME })),
    ]) {
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: 'downloads_off' });
    }
  });

  it('queue a film with via auto by default and answer 202 at once with the row', async () => {
    const f = fakeDownloads();
    const r = await post(f.port, { kind: 'movie', tmdb_id: 930564 });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [{ id: DL_ID, kind: 'movie', tmdb_id: 930564 }] });
    expect(f.request).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'auto' });
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('queue one episode only, from the source chosen', async () => {
    const f = fakeDownloads();
    await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, via: 'cloud' });
    expect(f.request).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 247718, season: 1, episode: 2 }, { via: 'cloud' });
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('download exactly the torrent picked: info_hash means via torrent, in lower case', async () => {
    const f = fakeDownloads();
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564, info_hash: HASH })).status).toBe(202);
    expect(f.request).toHaveBeenLastCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'torrent', infoHash: HASH.toLowerCase() });
    await post(f.port, { kind: 'movie', tmdb_id: 930564, via: 'torrent' });
    expect(f.request).toHaveBeenLastCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'torrent' });
  });

  it('queue a whole season when tv names a season and no episode', async () => {
    const f = fakeDownloads();
    const r = await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1, via: 'torrent' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { created: number; downloads: Array<{ season: number; episode: number }> };
    expect(body.created).toBe(3);
    expect(body.downloads.map((d) => [d.season, d.episode])).toEqual([[1, 1], [1, 2], [1, 3]]);
    expect(f.requestSeason).toHaveBeenCalledWith(247718, 1, { via: 'torrent' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('answer 200 when everything asked for is queued already or whole here', async () => {
    const f = fakeDownloads();
    f.request.mockResolvedValueOnce({ download: dview({ state: 'running' }), created: false, onDisk: false });
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564 })).status).toBe(200);
    f.request.mockResolvedValueOnce({ download: null, created: false, onDisk: true });
    const r = await post(f.port, { kind: 'movie', tmdb_id: 930564 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ created: 0, whole: 1, downloads: [] });
  });

  it('refuse a bad body with invalid_body and queue nothing', async () => {
    const f = fakeDownloads();
    for (const body of [
      { kind: 'movie', tmdb_id: 930564, season: 1 },
      { kind: 'tv', tmdb_id: 247718, episode: 2 },
      { kind: 'tv', tmdb_id: 247718, season: 1, info_hash: HASH },
      { kind: 'movie', tmdb_id: 930564, via: 'cloud', info_hash: HASH },
      { kind: 'movie', tmdb_id: 930564, info_hash: 'abc' },
      { kind: 'movie', tmdb_id: 930564, via: 'magnet' },
    ]) {
      const r = await post(f.port, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'invalid_body' });
    }
    expect((await post(f.port, '{not json')).status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('refuse a write from another origin', async () => {
    const f = fakeDownloads();
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564 }, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE' }))).status).toBe(403);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("list this machine's queued, running, paused and failed downloads with their progress, title, source and error", async () => {
    const rows = [
      dview({ id: 'a', state: 'running', source: 'torrent', progress: 0.42, bytes_done: 420, bytes_total: 1000, peers: 3, down_kbps: 900 }),
      dview({ id: 'b', state: 'failed', error: 'no_source', tmdb_id: 990004 }),
      dview({ id: 'c', state: 'paused', kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, batch: 'b1' }),
      dview({ id: 'd', state: 'done', progress: 1 }),
      dview({ id: 'e', state: 'failed', error: 'cancelled' }),
      dview({ id: 'f', host: 'other-laptop', available: false }),
    ];
    const r = await app(fakeDownloads(rows).port).fetch(req('/api/stream/downloads'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { host: string; active: boolean; downloads: Array<Record<string, unknown>> };
    expect(body.host).toBe('here');
    expect(body.active).toBe(true);
    expect(body.downloads.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(body.downloads[0]).toMatchObject({ title_id: 'movie-930564', season: null, episode: null, state: 'running', source: 'torrent', progress: 0.42, bytes_done: 420, bytes_total: 1000, error: null });
    expect(body.downloads[1]).toMatchObject({ state: 'failed', error: 'no_source', title_id: 'movie-990004' });
    expect(body.downloads[2]).toMatchObject({ season: 1, episode: 2, batch: 'b1', title_id: 'tv-247718' });
  });

  it('with a title, also list its finished downloads (on this machine), which never make it active', async () => {
    const f = fakeDownloads([dview({ id: 'a', state: 'done', progress: 1, source: 'torrent' })]);
    const r = await app(f.port).fetch(req('/api/stream/downloads?title=movie-930564'));
    expect(f.list).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 });
    expect(await r.json()).toMatchObject({ active: false, downloads: [{ id: 'a', state: 'done', title_id: 'movie-930564' }] });
    await app(f.port).fetch(req('/api/stream/downloads'));
    expect(f.list).toHaveBeenLastCalledWith(undefined);
  });

  it('answer 404 unknown_season, or 503 downloads_off when no season download is wired', async () => {
    const f = fakeDownloads();
    f.requestSeason.mockResolvedValueOnce({ ok: false, error: 'unknown_season', detail: 'TMDB tv 247718 lists no episode of season 9.' });
    const r = await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 9 });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'unknown_season' });
    f.requestSeason.mockResolvedValueOnce({ ok: false, error: 'seasons_off', detail: 'off' });
    expect((await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1 })).status).toBe(503);
  });

  it('narrow the list to one title, say active false when nothing moves, and refuse a bad title', async () => {
    const rows = [dview({ id: 'a', state: 'failed', error: 'no_source' }), dview({ id: 'b', state: 'running', kind: 'tv', tmdb_id: 247718, season: 1, episode: 1 })];
    const a = app(fakeDownloads(rows).port);
    const film = (await (await a.fetch(req('/api/stream/downloads?title=movie-930564'))).json()) as { active: boolean; downloads: Array<{ id: string }> };
    expect(film.downloads.map((d) => d.id)).toEqual(['a']);
    expect(film.active).toBe(false);
    const show = (await (await a.fetch(req('/api/stream/downloads?title=tv-247718'))).json()) as { active: boolean; downloads: Array<{ id: string }> };
    expect(show.downloads.map((d) => d.id)).toEqual(['b']);
    expect(show.active).toBe(true);
    const bad = await a.fetch(req('/api/stream/downloads?title=M-23T4'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_query' });
  });

  it('cancel a download by id, and answer unknown_download', async () => {
    const f = fakeDownloads();
    const r = await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID.toUpperCase()}`, { method: 'DELETE', headers: SAME }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, download: { id: DL_ID } });
    expect(f.cancel).toHaveBeenCalledWith(DL_ID);
    expect((await app(f.port).fetch(req('/api/stream/downloads/not-an-id', { method: 'DELETE', headers: SAME }))).status).toBe(404);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    f.cancel.mockRejectedValueOnce(new DownloadError('unknown_download', 'No download has this id.'));
    const gone = await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE', headers: SAME }));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: 'unknown_download' });
  });
});
```
**Impact:** These are new tests. `new DownloadError(code, message)` is phase 2's constructor.

### Step 8: The tool's tests
**File:** `tests/unit/mcp.streamCacheTools.test.ts`
**Change:**
- Add imports after line 8:
```ts
import { streamDownloadsRoutes } from '../../src/http/streamDownloadsApi.js';
import { DL_ID, dview, fakeDownloads } from './directStream/downloadsFakes.js';
```
- In `it('starts a film with its max_height', ...)` (line 120), add `const dl = fakeDownloads();`. Connect with `{ lookup: lookup(), cache: f.cache, downloads: dl.port }`. After the existing expectations, add `expect(dl.request).not.toHaveBeenCalled();`. That proves no provider still means the cloud cache.
- Append inside the `describe('direct_stream_cache', ...)` block, before its closing `});` (line 181):
```ts
  it('queues with provider torrent the same download the Download button queues with via torrent', async () => {
    const f = fakeCache();
    const dl = fakeDownloads();
    const c = await connect({ lookup: lookup(), cache: f.cache, downloads: dl.port });
    const r = await c.call({ action: 'start', title: 'saltburn', provider: 'torrent' });
    expect(r.isError).toBeFalsy();
    expect(json(r)).toMatchObject({ started: true, provider: 'torrent', created: 1, title: { tmdb_id: 930564 }, downloads: [{ id: DL_ID }] });
    const route = streamDownloadsRoutes({ streamDownloads: dl.port as never });
    const posted = await route.fetch(
      new Request('http://localhost/api/stream/downloads', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'movie', tmdb_id: 930564, via: 'torrent' }) }),
    );
    expect(posted.status).toBe(202);
    expect(dl.request).toHaveBeenCalledTimes(2);
    expect(dl.request.mock.calls[0]).toEqual([{ kind: 'movie', tmdbId: 930564 }, { via: 'torrent' }]);
    expect(dl.request.mock.calls[1]).toEqual(dl.request.mock.calls[0]);
    expect(f.request).not.toHaveBeenCalled();
    await c.close();
  });

  it('downloads exactly the torrent named by info_hash', async () => {
    const dl = fakeDownloads();
    const c = await connect({ lookup: lookup(), cache: fakeCache().cache, downloads: dl.port });
    await c.call({ action: 'start', title: 'the bear', season: 1, episode: 3, provider: 'torrent', info_hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' });
    expect(dl.request).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 136315, season: 1, episode: 3 }, { via: 'torrent', infoHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' });
    await c.close();
  });

  it('downloads a whole season named without an episode: from the cloud by default, from torrents with provider torrent', async () => {
    const dl = fakeDownloads();
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache, downloads: dl.port });
    const r = await c.call({ action: 'start', title: 'the bear', season: 1 });
    expect(dl.requestSeason).toHaveBeenLastCalledWith(136315, 1, { via: 'cloud' });
    expect(json(r)).toMatchObject({ started: true, provider: 'cloud', season: 1, created: 3, not_aired: 0 });
    await c.call({ action: 'start', title: 'the bear', season: 1, provider: 'torrent' });
    expect(dl.requestSeason).toHaveBeenLastCalledWith(136315, 1, { via: 'torrent' });
    expect(dl.request).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    await c.close();
  });

  it('refuses arguments that do not go together, and queues nothing', async () => {
    const dl = fakeDownloads();
    const f = fakeCache();
    const c = await connect({ lookup: lookup(), cache: f.cache, downloads: dl.port });
    for (const args of [
      { action: 'start', title: 'saltburn', info_hash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      { action: 'start', title: 'saltburn', provider: 'torrent', max_height: 720 },
      { action: 'status', title: 'saltburn', provider: 'torrent' },
      { action: 'start', title: 'the bear', season: 1, provider: 'torrent', info_hash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    ]) {
      const r = await c.call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(/^invalid_input:/);
    }
    expect(dl.request).not.toHaveBeenCalled();
    expect(dl.requestSeason).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    await c.close();
  });

  it('answers downloads_off for a torrent or a season when the queue is off', async () => {
    const c = await connect({ lookup: lookup(), cache: fakeCache().cache, downloads: null });
    for (const args of [{ action: 'start', title: 'saltburn', provider: 'torrent' }, { action: 'start', title: 'the bear', season: 1 }]) {
      const r = await c.call(args);
      expect(r.isError).toBe(true);
      expect(json(r)).toMatchObject({ error: 'downloads_off' });
    }
    await c.close();
  });

  it("carries this machine's downloads in status and list", async () => {
    const rows = [
      dview({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', state: 'running', source: 'torrent', progress: 0.5 }),
      dview({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'tv', tmdb_id: 136315, season: 1, episode: 2, state: 'failed', error: 'no_source' }),
      dview({ id: 'aaaaaaab-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'done' }),
    ];
    const dl = fakeDownloads(rows);
    const c = await connect({ lookup: lookup(), cache: fakeCache().cache, downloads: dl.port });
    const status = json(await c.call({ action: 'status', title: 'saltburn' }));
    expect(status.downloads.map((d: { id: string }) => d.id)).toEqual(['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
    const listed = json(await c.call({ action: 'list' }));
    expect(listed.downloads.map((d: { id: string }) => d.id)).toEqual(['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff']);
    expect(listed.count).toBe(1);
    const byId = await c.call({ action: 'status', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect(json(byId)).toMatchObject({ downloads: [{ state: 'failed', error: 'no_source' }] });
    await c.close();
  });
```
For the "status by id" case to reach the download, the fake cache's `get` must answer null for that id. Change `fakeCache`'s `get` (line 81) from `get: async () => view()` to:
```ts
get: async (id) => (id === ID ? view() : null),
```
Today that `get` is reached only with `ID`.
**Impact:** These are test changes only.

### Step 9: The client test and the integration test
**File:** `web/src/moviesApi.downloads.test.tsx` (new)
**Code:**
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { cancelDownload, fetchDownloads, requestDownload } from './moviesApi';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('the download client', () => {
  it('posts the film, episode or season asked for and returns the rows', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [{ id: 'x', title_id: 'tv-247718', kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, state: 'queued', via: 'auto', progress: 0 }] }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const q = await requestDownload({ kind: 'tv', tmdb_id: 247718, season: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/stream/downloads');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'tv', tmdb_id: 247718, season: 1 });
    expect(q.created).toBe(1);
    expect(q.downloads[0]).toMatchObject({ id: 'x', season: 1, episode: 2, source: null, error: null, batch: null });
  });

  it('reads one title, clamps progress and says whether anything moves', async () => {
    const fetchMock = vi.fn(async () => json({ host: 'gpd', active: true, downloads: [{ id: 'a', state: 'running', progress: 1.7 }, { id: 'b', state: 'failed', progress: -1, error: 'no_source' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const v = await fetchDownloads('movie-550');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/stream/downloads?title=movie-550');
    expect(v.active).toBe(true);
    expect(v.downloads.map((d) => d.progress)).toEqual([1, 0]);
    expect(v.downloads[1]?.error).toBe('no_source');
    vi.stubGlobal('fetch', vi.fn(async () => json({ host: 'gpd' })));
    expect(await fetchDownloads()).toEqual({ host: 'gpd', active: false, downloads: [] });
  });

  it('cancels by id and throws the server code', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await cancelDownload('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(fetchMock.mock.calls[0]).toMatchObject(['/api/stream/downloads/dddddddd-dddd-4ddd-8ddd-dddddddddddd', { method: 'DELETE' }]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'downloads_off', message: 'off' }, 503)));
    await expect(fetchDownloads()).rejects.toEqual(new ApiError(503, 'downloads_off', 'off'));
  });
});
```

**File:** `tests/integration/streamDownloads.routes.int.test.ts` (new; `tests/integration/directStream.downloads.int.test.ts` is phase 1's contract file)
**Change:** The route runs over phase 2's real `StreamDownloads` and phase 1's real `DownloadsRepo` on the test Postgres, built as phase 2's own tests build it. The engine has no torrent side and phase 2's `FakeCaches` as its cloud side, and is never `start()`ed: a request's look hands the row to the fake cache (state `running`, source `cloud`), and nothing downloads. What is proven is the queue row and its read-back, and that one host never lists, or cancels, the other's row. Phase 1's `truncateAll` empties `stream_downloads`.
**Code:**
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { StreamDownloads } from '../../src/directStream/downloads/service.js';
import { streamDownloadsRoutes, type ListedDownload } from '../../src/http/streamDownloadsApi.js';
import { FakeCaches } from '../unit/directStream/downloads/fakes.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
let db: Db;

/** Phase 2's engine over the real repo: no torrents, a fake cloud cache, never started. */
function engine(host: string): StreamDownloads {
  return new StreamDownloads({
    host,
    repo: new DownloadsRepo(db),
    torrents: null,
    caches: new FakeCaches(),
    ssid: async () => null,
    playingTorrents: () => [],
    now: () => new Date('2026-11-20T12:00:00Z'),
    log: () => undefined,
    every: () => () => undefined,
  });
}

function routes(host: string) {
  return streamDownloadsRoutes({ streamDownloads: engine(host) });
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

describe('/api/stream/downloads on a real stream_downloads', () => {
  it('queues a film and reads it back from GET, narrowed to the title', async () => {
    const a = routes('host-a');
    const posted = await a.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'cloud' }) });
    expect(posted.status).toBe(202);
    const made = ((await posted.json()) as { downloads: ListedDownload[] }).downloads;
    expect(made).toHaveLength(1);
    const again = await a.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'cloud' }) });
    expect(again.status).toBe(200);
    const listed = (await (await a.request('/api/stream/downloads?title=movie-467905')).json()) as { host: string; active: boolean; downloads: ListedDownload[] };
    expect(listed.host).toBe('host-a');
    expect(listed.downloads).toHaveLength(1);
    expect(listed.downloads[0]).toMatchObject({ id: made[0]!.id, title_id: 'movie-467905', kind: 'movie', tmdb_id: 467905, season: null, episode: null, via: 'cloud' });
    expect(['queued', 'running']).toContain(listed.downloads[0]!.state);
    expect(listed.active).toBe(true);
    expect(listed.downloads[0]!.progress).toBeGreaterThanOrEqual(0);
    expect(listed.downloads[0]!.progress).toBeLessThanOrEqual(1);
  });

  it("never lists or cancels the other machine's download", async () => {
    const b = routes('host-b');
    const posted = await b.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, episode: 2 }) });
    const id = ((await posted.json()) as { downloads: ListedDownload[] }).downloads[0]!.id;
    const a = routes('host-a');
    expect(((await (await a.request('/api/stream/downloads')).json()) as { downloads: ListedDownload[] }).downloads).toEqual([]);
    const cancel = await a.request(`/api/stream/downloads/${id}`, { method: 'DELETE', headers: SAME });
    expect(cancel.status).toBe(404);
    expect(((await (await b.request('/api/stream/downloads')).json()) as { downloads: ListedDownload[] }).downloads.map((d) => d.id)).toEqual([id]);
  });
});
```
**Impact:** This is a new integration file. It imports phase 2's `FakeCaches` from its unit fakes (as phase 2's own integration test imports `FakeTorrents`).

### Step 10: Regenerate and run
**Change:** Run `npm run docs:gen`, then `npm run typecheck`, `npm test` and `npm run test:int`. Commit the two regenerated reference files with the code.

## Principles applied

- **Boundary discipline.** The HTTP body is validated once, by `downloadBody` and `askOf` in the route, and the tool's arguments once, by `argumentProblem`. Both produce a typed `DownloadAsk`, and `queueDownload` trusts it with no further checks. Filtering, meaning this host only, not done and not cancelled, lives in one function (`listedDownloads`) that the route and the tool share.
- **Make illegal states unrepresentable.** The body is a three-way union, so a season cannot carry an episode or an `info_hash`. `DownloadAsk` cannot hold an `info_hash` with `via` `auto`/`cloud`, and the web `DownloadRequest` type forbids `info_hash` on a season (`never`).
- **Laziness protocol.**
  - The tool reuses `queueDownload`, so it has no second path into the engine (R1.10 holds by construction).
  - The route copies `streamDiskApi.ts`'s off-guard and `streamCacheApi.ts`'s body handling instead of a new helper.
  - The web client reuses `postJson`/`getJson`/`failure`.
  - `provider: "cloud"` for one title keeps today's cache path rather than routing through the new queue.
- **Test behavior, not implementation.** The route tests assert status codes, answer bodies and the one call made on the engine seam. The tool test proves "the same download the button queues" by comparing the engine call from the tool with the one from the route, not by checking that a helper was called.
- **Prove it works.** The Proof drives the real daemon (`verify.sh up --torrent`) over HTTP and MCP and reads the rows back with SQL.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/stream-downloads-season-story && npm run typecheck`
**Tests:**
- `npm test`. This includes `tests/unit/directStream/downloadsRoutes.test.ts`, `tests/unit/mcp.streamCacheTools.test.ts`, `web/src/moviesApi.downloads.test.tsx` and `tests/unit/docs/reference.test.ts`.
- `npm run test:int` (`tests/integration/streamDownloads.routes.int.test.ts`).

**Proof:** a throwaway daemon with torrents on (loopback seeder, fake index, fake cloud resolver), driven over HTTP and MCP, with rows read back from its database.
- Harness: `.claude/skills/verify-notesd`. Run every command below from `/home/miftah/.worktrees/mcp-notes/stream-downloads-season-story`.
- Setup for the journeys:
  1. `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --torrent`.
  2. Set `RUN=<printed RUN>`, `URL=<printed URL>`, `D=$HOME/.local/state/notesd-verify/$RUN`.
  3. Define three helpers:
     - `post() { curl -sS -w '\n%{http_code} %{time_total}\n' -H "Origin: $URL" -H 'content-type: application/json' -d "$1" "$URL/api/stream/downloads"; }`
     - `get() { curl -sS "$URL/api/stream/downloads$1"; }`
     - `mcpc() { "$V" mcp "$RUN" direct_stream_cache "$1" 2>/dev/null | sed '1d;/^< ERROR$/d'; }`

     In each `post` output, line 1 is the body and the last line is `<status> <seconds>`.
  4. Run the journeys in the order listed. J6 switches the fakes to "nothing found", so it runs after J1–J5.
- Feature-map entries: none edited in this phase. Phase 9 owns `features/direct-streaming.md` and `features/movies.md` (see Handoffs). The drives below run on the existing `--torrent` harness.
- Journeys:
  - **J1** · traces R1.1 — `out=$(post '{"kind":"movie","tmdb_id":467905}'); echo "$out"; $V sql $RUN "select count(*) from stream_downloads where kind='movie' and tmdb_id=467905 and via='auto'"` → passes when the last line of `$out` starts with `202` and its time is below `2.0` s, line 1 has `jq '.created'` = `1` and `jq -c '.downloads[0] | [.kind,.tmdb_id,.via]'` = `["movie",467905,"auto"]`, and the SQL count is `1`.
  - **J2** · traces R1.3 — Steps:
    1. `H=$(jq -r .info_hash $D/torrent/fixture.json); out=$(post '{"kind":"movie","tmdb_id":990002,"via":"torrent","info_hash":"'$H'"}')`.
    2. Poll up to 120 s, `$V sql $RUN "select source from stream_downloads where tmdb_id=990002"`, until it prints the row `torrent`.
    3. `$V sql $RUN "select count(*) from stream_caches where tmdb_id=990002"`.
    4. `out2=$(post '{"kind":"movie","tmdb_id":990001,"via":"cloud"}')`.
    5. Poll up to 120 s, `$V sql $RUN "select source from stream_downloads where tmdb_id=990001"`, until it prints `cloud`.
    6. `$V sql $RUN "select (select count(*) from stream_torrents where tmdb_id=990001) as torrents, (select count(*) from stream_caches where tmdb_id=990001 and auto=false) as caches"`.

    → passes when:
    - `$out` is 202 with `.downloads[0].via` = `torrent` and `.downloads[0].info_hash` = `$H`.
    - 990002's source becomes `torrent` and its `stream_caches` count is `0`.
    - `$out2` is 202 with `.downloads[0].via` = `cloud`.
    - 990001's source becomes `cloud`, with `torrents` = `0` and `caches` = `1`.
  - **J3** · traces R1.10 — Steps:
    1. `t=$(mcpc '{"action":"start","title":"movie-990003","provider":"torrent"}'); echo "$t"`.
    2. `out=$(post '{"kind":"movie","tmdb_id":990003,"via":"torrent"}')`.
    3. `$V sql $RUN "select count(*) from stream_downloads where tmdb_id=990003"`.

    → passes when:
    - `jq -r '.provider, .downloads[0].via, .downloads[0].tmdb_id' <<<"$t"` prints `torrent`, `torrent`, `990003`.
    - The route POST of the button's "Best torrent" body answers `200` with `.created` = `0`, meaning it found the tool's download rather than making a second one.
    - The SQL count is `1`.
  - **J4** · traces R2.2 — `out=$(post '{"kind":"tv","tmdb_id":247718,"season":1,"episode":3}'); $V sql $RUN "select season, episode from stream_downloads where tmdb_id=247718"` → passes when `$out` is 202 with `.created` = `1` and `jq -c '[.downloads[] | [.season,.episode]]'` = `[[1,3]]`, and the SQL lists exactly one row, `1 | 3`.
  - **J5** · traces R2.1 — `out=$(post '{"kind":"tv","tmdb_id":247718,"season":1}'); $V sql $RUN "select episode, batch is not null as batched from stream_downloads where tmdb_id=247718 order by episode"` → passes when:
    - `$out` is 202 with `.created` = `2` and `jq -c '[.downloads[] | [.season,.episode]] | sort'` = `[[1,1],[1,2],[1,3]]`. MobLand's season 1 has three aired episodes in the fake TMDB, and E03 was queued by J4.
    - The SQL prints `1 | t`, `2 | t`, `3 | f`, exactly one row per episode.
  - **J6** · traces R1.11 — Steps:
    1. `printf 'empty\n' >$D/torrent/index-mode; printf 'empty\n' >$D/torrent-sites/mode; printf 'no_source\n' >$D/direct/mode`.
    2. `post '{"kind":"movie","tmdb_id":990004}'`.
    3. Poll up to 180 s, `get '?title=movie-990004' | jq -r '.downloads[0].state'`, until it prints `failed`.
    4. `get '?title=movie-990004' | jq -c '.downloads[0] | [.state, .error]'`.

    → passes when the POST answers 202 and the last command prints `["failed","<code>"]` with a non-empty code (expected `no_source`).
  - **J7** · traces R3.2 — Steps:
    1. `all=$(get '')`.
    2. `jq -e 'all(.downloads[]; (has("title_id") and has("kind") and has("tmdb_id") and has("season") and has("episode") and has("state") and has("via") and has("source") and has("progress") and has("bytes_done") and has("bytes_total") and has("error")) and (.state|IN("queued","running","paused","failed")) and (.progress >= 0 and .progress <= 1))' <<<"$all"`.
    3. `jq -c '[.downloads[] | select(.tmdb_id==990004) | [.state,.error]]' <<<"$all"`.
    4. `$V sql $RUN "select count(*) from stream_downloads where host='$(jq -r .host <<<"$all")' and state<>'done' and coalesce(error,'')<>'cancelled'"`.
    5. `get '?title=tv-247718' | jq -e 'all(.downloads[]; .tmdb_id==247718)'`.
    6. `curl -s -o /dev/null -w '%{http_code}' "$URL/api/stream/downloads?title=bogus"`.

    → passes when:
    - The step 2 `jq -e` exits 0.
    - Step 3 prints one entry, `["failed","<non-empty>"]`.
    - `jq '.downloads|length' <<<"$all"` equals the SQL count.
    - The title filter's `jq -e` exits 0.
    - The bad title answers `400`.
- Neighbor check: the existing cloud cache and its tool path, with no provider, must behave as before. Run `$V up --direct-stream`, set `RUN2=<printed RUN>`, then run `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh $RUN2`. It passes when the last line is `cache: PASS (start tool refused other clear)`. Afterwards run `$V down $RUN` and `$V down $RUN2`.
- Cost: none. No LLM turn, and no network beyond loopback fakes.

**Exit criteria:** `npm run typecheck`, `npm test` (reference test included) and `npm run test:int` pass, and J1–J7 and the neighbor check pass on throwaway daemons with evidence under `~/.local/state/notesd-verify/<RUN>/evidence/`.

## Handoffs

- **Phase 2 (reconciled):** this phase calls phase 2's `request`, `cancel`, `list(filter?)`, `host`, `DownloadView`, `DownloadRequestAnswer` and `DownloadError` exactly as phase 2 states them, and phase 3's `requestSeason` (`SeasonAnswer<DownloadRequestAnswer>`); the route adds `title_id` itself (`listed`).
  - A `request` on a slot whose row is `failed` queues it again with `created: true` (phase 1's `create`), so the button's "failed: click asks again" (phase 8) answers 202.
  - `verify.sh` does not pin `NOTESD_STREAM_DOWNLOADS=off`; it pins `NOTESD_STREAM_DOWNLOAD_SSID=verify-home` (phase 2), so J1–J7 are never refused `no_peers_here` on the office network.
- **Phase 1:** `stream_downloads.id` is a uuid with a database default (`DOWNLOAD_ID_PATTERN`, and the tool's `id` uses `CACHE_ID_PATTERN`). `truncateAll` lists `stream_downloads`.
- **Phase 8:** it imports `requestDownload`, `fetchDownloads`, `cancelDownload`, `DownloadView`, `DownloadsView`, `DownloadRequest`, `DownloadQueued` and `DownloadVia` from `web/src/moviesApi.ts`.
  - `fetchDownloads(titleId)` takes the title's `id` (`movie-550`/`tv-1399`), not the `M-` movie id.
  - `active` is true while a row is queued, running or paused (reconciled: accepted for the set, R3.1; phase 8's hook reads paused as live too).
  - With `?title=` the answer also holds the title's `done` rows still on this machine (the latest per film or episode), for the button's "on this machine"; `active` never comes from them.
  - The season form of `requestDownload` is `{kind: 'tv', tmdb_id, season}`. "Pick a torrent" sends `info_hash` with `via: 'torrent'` or no `via`.
  - R1.1, R1.3, R2.1 and R2.2's button half (the click, the menu titled "Choose how to download <name>") is phase 8's to prove in the browser. This phase proves the server queues exactly what is sent.
- **Phase 5:** it may import `DownloadView`/`DownloadState` from `web/src/moviesApi.ts`. This phase appended its section at the end of that file and did not touch the Disk types or `fetchStreamDisk`. It also did not touch the "Cache page" group of `scripts/docs/httpRoutes.ts`.
- **Phase 9:**
  - Feature-map entries for downloads in `.claude/skills/verify-notesd/features/direct-streaming.md` (and `movies.md`). J1–J7 above are ready to lift into a `scripts/direct-stream/downloads.sh`.
  - The `streaming.md` section the "Stream downloads" route group links to. The link has no anchor yet; phase 9 may add `#downloading-a-title` and rerun `npm run docs:gen`.
  - The list of failure codes in the guide. The route doc names only `no_source`.
- **Integrator:** `docs/guide/reference/http-api.md` and `mcp-tools.md` are regenerated by phases 4, 5 and 6 (`npm run docs:gen`). They are never merged: after every merge, regenerate them with `npm run docs:gen` and commit the result.

## Rollback

Revert this phase's commit:
- Delete `src/http/streamDownloadsApi.ts`, the shared fakes and the new tests.
- Restore `src/http/app.ts`, `src/mcp/streamCacheTools.ts`, `scripts/docs/httpRoutes.ts`, `src/mcp/instructions.ts`, `claude/skills/direct-stream/SKILL.md`, `web/src/moviesApi.ts` and `tests/unit/mcp.streamCacheTools.test.ts`.
- Run `npm run docs:gen`.

Nothing in the database changes in this phase. Phases 5 and 8 import the web client functions, so revert them first if they have landed.

# Phase 6: Play from the cache

**Plan set:** `STREAM_CACHE_AND_BUG_REPORT_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Satisfies:** R1 — a film or episode cached on this laptop plays from the local copy, and the other laptop's cache is refused for a play
**Criteria:** R1.4, R1.5
**Depends on:** Phase 2, 3, 4, 5
**Difficulty:** HARD
**Package:** `src/directStream`, `web/src/stream`, `claude/skills/direct-stream`

---

## Goal

Before this phase a cache (phase 5) sits on disk and nothing plays it. After it, `direct_stream_play`,
`POST /api/stream/play` and the player's previous/next buttons look up this host's cache of the
title first: a `ready` cache makes a session with no resolver run and the page plays the cache's
local playlist; a `downloading` cache plays the same playlist while phase 5's file route fetches
missing segments; a failed cache, a cache on the other machine or no cache plays exactly as
today. `POST /api/stream/cache/:id/play` plays one cache by id and answers 404
`not_on_this_machine` for the other machine's. The page marks a cached play beside the title and
lets hls.js buffer without our cap when the cache is complete.

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `src/directStream/cachePlay.ts` (new): `CacheState`, `CacheSubtitleView`, `CachePlayView`,
  `PlayableCaches`, `SessionCache`, `CacheRefusal`, `Playable`, `playable()`, `cacheSource()`,
  `cacheRefusalError()`, `CachePlayError`, `CachePlayErrorCode`; it re-exports phase 5's
  `CACHE_ID_PATTERN` (`src/directStream/cache/types.ts`) and defines no pattern of its own.
- `DirectStreamService.playCache(cacheId, {resumeS})` (`src/directStream/service.ts`).
- `DirectStreamServiceOptions.caches?: () => PlayableCaches | null` and `DirectStreamWiring.caches` (same file).
- `SessionInfo.cached: { id: string; state: 'downloading' | 'ready'; height: number | null } | null`.
- `StreamSession.cache: SessionCache | null` and `SessionStore.useCache(session, cache)` (`src/directStream/sessions.ts`).
- `src/http/streamCachePlayApi.ts` (new): `streamCachePlayRoutes`, route `POST /api/stream/cache/:id/play` (same-origin).
- Error codes on that route: 404 `unknown_cache`, 404 `not_on_this_machine` (+ `host`), 409 `cache_failed`, 409 `cache_language`.
- `web/src/stream/engine.ts`: `CACHED_BUFFER_AHEAD_S` (600), beside phase 2's `BUFFER_AHEAD_S` (120) and `MUTED_BUFFER_AHEAD_S` (30). No new `EngineRequest` field: the controller sets phase 2's `EngineRequest.bufferAheadS`.
- `web/src/stream/session.ts`: `CachedState`, `CachedInfo`, `StreamSession.cached`.
- `web/src/stream/controller.ts`: `StreamState.cached: CachedInfo | null` (so `window.notesdStream.cached`).
- `web/src/stream/StreamApp.tsx`: `cachedLabel()`, the `.st-cached` mark.
- `src/directStream/evidence.ts` (phase 1's): `SessionSource.cache: { id: string; state: 'downloading' | 'ready' } | null`, filled by `sessionSource()` from `session.cache`, so a snapshot's `session.json` names the cache a play came from.
- Text naming `direct_stream_cache`: `src/mcp/instructions.ts` ("Direct streaming" paragraph), `claude/skills/direct-stream/SKILL.md`, and the "What to do" cells of the `connection_slow` / `host_slow` rows of `claude/skills/report-stream-bug/SKILL.md` (phase 3's skill).
- `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh`, `.claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs` (new).

**Signature changes:**
- `SessionStore.create(ref, source, attempts, resumeS = null, audioLang = null)` -> `create(ref, source, attempts, resumeS = null, audioLang = null, cache: SessionCache | null = null)` (phase 1's `refreshes: 0` stays in the literal).
- `SessionStore.replaceSource` now also sets `session.cache = null` (a resolve moves a cached session onto the pass-through); phase 1's `session.refreshes += 1` stays.
- `DirectStreamService.play` no longer always resolves (a playable cache comes first). `resolve()` is unchanged in behaviour and still always resolves (`subtitleText` relies on that).

**Requires (from earlier phases), reconciled against their plans:**
- Phase 5: `AppDeps.streamCache?: StreamCache | null` and `StreamCache.player()` → `{ find(ref), get(id) }` answering `CachePlayData`, which is field for field `CachePlayView` (see **Names this phase depends on**); `CACHE_ID_PATTERN` in `src/directStream/cache/types.ts`. The typechecker enforces the shape at the one wiring line in `src/daemon.ts`.
- Phase 5: the file route `GET /api/stream/cache/:id/f/:name` serves `master.m3u8`, `video.m3u8`, segments and `subtitle.vtt` with no stream-session id; for a `downloading` row it fetches a missing file on demand, starting the download in this daemon process when none runs (`launchNow`); an on-demand fetch the host refuses and a fresh resolve cannot cure answers 502 `upstream_error`, never a forwarded 401/403/410.
- Phase 2: `EngineRequest.bufferAheadS?: number`, `BUFFER_AHEAD_S` (120), `MUTED_BUFFER_AHEAD_S` (30) in `web/src/stream/engine.ts`; `StreamController.attach` passes `bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : BUFFER_AHEAD_S`, and the HLS engine uses it as both `maxBufferLength` and `maxMaxBufferLength`.
- Phase 1: `StreamSession.refreshes`, `SessionStore.peek`, the evidence calls in `DirectStreamService.resolve` / `refresh` (`safeRecord(this.evidence, sessionRecord(...))`), `SessionSource` / `sessionSource()` in `src/directStream/evidence.ts`, and `evidence: streamEvidence,` in the daemon's `buildDirectStreamService` wiring. The steps below quote those files as phase 1 left them.
- Phases 1, 2, 4: the lines of `controller.ts` / `StreamApp.tsx` / `session.ts` quoted in the steps are matched by text as those phases left them.
- Phase 3: `claude/skills/report-stream-bug/SKILL.md` exists with the `connection_slow` / `host_slow` rows whose "What to do" cells Step 14 quotes, and `diagnose.mjs` reads `source.cache` (`FIELDS.source.cache`). This is why phase 6 depends on phase 3 (reconciliation round 2): no other dependency of this phase brings phase 3 in.

**Leaves alone (owned by others):** `src/directStream/cache/*` and the `/api/stream/cache` routes other than `/:id/play` (Phase 5); `src/directStream/evidence.ts` except the one `SessionSource.cache` field, `passThrough.ts`, the events/snapshot routes (Phase 1); `hlsEngine.ts` (Phase 2: the buffer comes in through `bufferAheadS`); the engines' recovery code and the `recovering` stage (Phase 2); `claude/skills/report-stream-bug/` (Phase 3) except the two "What to do" cells named above; `src/directStream/report.ts`, the report route, `StageOverlay` / the error overlay (Phase 4); the Movies page; `direct_stream_cache` tool (Phase 5); `direct_stream_find` (unchanged on purpose, see Principles).

## Names this phase depends on (one place, reconciled)

| Name used here | Owner | What it is (from the owner's plan) |
|---|---|---|
| `AppDeps.streamCache` | Phase 5 | `streamCache?: StreamCache \| null` on `AppDeps` (`src/deps.ts`). |
| `StreamCache.player()` | Phase 5 | `{ find(ref): Promise<CachePlayData \| null>; get(id): Promise<CachePlayData \| null> }`: `find` is this host's cache of `ref` in any state (`failed` included), read fresh; `get` is the cache with that id on any host. A cache whose source is not known yet (still resolving) answers null. This phase still re-checks host and state. The wiring line is `caches: () => deps.streamCache?.player() ?? null`. |
| `CachePlayData` = `CachePlayView` | Phase 5 returns it | `id`, `ref` (`StreamRef`), `host`, `state` (`'downloading' \| 'ready' \| 'failed'`), `provider`, `height` (`number \| null`), `manifestKind` (`'hls' \| 'mp4'`), `manifestUrl` (`/api/stream/cache/<id>/f/master.m3u8`, or `/f/video.mp4` for a plain file), `subtitles` (`[{url: '/api/stream/cache/<id>/f/subtitle.vtt', lang: 'en', label: 'English'}]` or `[]`), `audioLang`, `audio` (always `null` from phase 5). |
| `StreamCache.findReady(ref)` | Phase 5 | Not used: `player().find` plus this phase's `playable()` decides. |
| `CACHE_ID_PATTERN` | Phase 5 (`src/directStream/cache/types.ts`) | The cache id pattern (a uuid); `cachePlay.ts` re-exports it. |
| Table `stream_caches` columns `id`, `host`, `state` | Phase 5 | Used only by the Proof script (`verify.sh exec` updates). |
| `POST /api/stream/cache` `{kind, tmdb_id}` → `{ok, started, cache}`; `GET /api/stream/cache/:id` → `StreamCacheView` (`.state`) | Phase 5 | Used only by the Proof script (it reads `.cache.id // .id` and `.cache.state // .state`, so either shape passes). |
| Cache files under `<run>/data/movies/stream-cache/<cache id>/`, segments `v-00001.ts` / `.m4s` | Phase 5 (`verify.sh` pins `NOTESD_STREAM_CACHE_DIR` there) | Used only by the Proof script (`find -name <id>`). |
| `direct_stream_cache` MCP tool (start, status, list, clear) | Phase 5 | Named in text only; no arguments are spelled out there. |
| `EngineRequest.bufferAheadS`, `BUFFER_AHEAD_S`, `MUTED_BUFFER_AHEAD_S` | Phase 2 (`web/src/stream/engine.ts`) | The one buffer setting; this phase adds `CACHED_BUFFER_AHEAD_S` beside them and sets `bufferAheadS` in `attach`. |
| `StreamSession.refreshes`, `SessionStore.peek`, `safeRecord`, `sessionRecord`, `SessionSource`, `sessionSource` | Phase 1 | Kept as phase 1 wrote them; this phase adds `cache` to `SessionSource` and records a `created` session record for a session made from a cache. |

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/cachePlay.ts` | create | what a play reads from a cache; the playable rule; the stand-in source; the route's error |
| `src/directStream/sessions.ts` | modify | `StreamSession.cache`, `create(..., cache)`, `replaceSource` clears it, `useCache` (phase 1's `refreshes` / `peek` kept) |
| `src/directStream/service.ts` | modify | `SessionInfo.cached`; `caches` option; `play`/`switchEpisode` try the cache first; `playCache`; `refresh` of a cached session; `sessionInfo` local addresses; wiring (phase 1's evidence records kept, one more for a session made from a cache) |
| `src/directStream/evidence.ts` | modify | `SessionSource.cache` and its line in `sessionSource()` |
| `src/http/streamCachePlayApi.ts` | create | `POST /api/stream/cache/:id/play` |
| `src/http/app.ts` | modify | mount `streamCachePlayRoutes` after phase 5's `streamCacheRoutes` |
| `src/daemon.ts` | modify | `caches: () => deps.streamCache?.player() ?? null` after phase 1's `evidence: streamEvidence,` |
| `src/mcp/directStreamTools.ts` | modify | `PLAY_DESCRIPTION` (`:150`), `next` of a started play (`:605`) |
| `src/mcp/instructions.ts` | modify | the "Direct streaming" paragraph names `direct_stream_cache` |
| `web/src/stream/session.ts` | modify | `CachedState`, `CachedInfo`, `StreamSession.cached`, `parseSession` |
| `web/src/stream/engine.ts` | modify | `CACHED_BUFFER_AHEAD_S` beside phase 2's buffer constants |
| `web/src/stream/controller.ts` | modify | `StreamState.cached`; `open`, `refresh` carry it; `attach` sets `bufferAheadS` from it |
| `web/src/stream/StreamApp.tsx` | modify | the mark beside the title |
| `web/src/stream/stream.css` | modify | `.st-cached` |
| `tests/unit/directStream/cachePlay.test.ts` | create | service and routes with a fake cache, fake runner, fake repo |
| `web/src/stream/controller.test.tsx` | modify | `cached: null` in the `toEqual`; parse, engine, refresh, buffer tests |
| `web/src/stream/StreamApp.test.tsx` | modify | the mark |
| `tests/unit/mcp.directStreamTools.test.ts` | modify | the play answer from a cache |
| `scripts/docs/httpRoutes.ts` | modify | the new route; play/session/refresh/episode texts (`:223`–`:232`) |
| `docs/guide/reference/http-api.md`, `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `docs/guide/streaming.md` | modify | "Playing from the cache", answers table, player bullet, code table |
| `claude/skills/direct-stream/SKILL.md` | modify | caching first, "is it cached?", the answer for a cached play |
| `claude/skills/report-stream-bug/SKILL.md` | modify | "cache it first (`direct_stream_cache`)" in the `connection_slow` and `host_slow` rows |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | the "Playing from the cache" entry |
| `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh` | create | the HTTP journeys |
| `.claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs` | create | the page journey |

## Implementation Steps

Before anything: the worktree has no `node_modules`. Run `npm ci` in
`/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report` first.

**Shared files (reconciled).** Phases 1 to 5 have all landed before this phase. Every quoted line is
matched by its text as they left it, never by line number (the line numbers below are today's, for
orientation only): `src/directStream/service.ts`, `sessions.ts` and `evidence.ts` (phase 1),
`src/daemon.ts` and `src/http/app.ts` (phases 1, 4, 5), `src/mcp/directStreamTools.ts` (phase 5 exported
five helpers), `web/src/stream/engine.ts`, `controller.ts`, `session.ts`, `StreamApp.tsx`, `stream.css`
and their tests (phases 1, 2, 4), `scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md` and
`.claude/skills/verify-notesd/features/direct-streaming.md` (phases 1 to 5),
`claude/skills/report-stream-bug/SKILL.md` (phase 3). Keep every line those phases added. The generated
`docs/guide/reference/http-api.md` and `mcp-tools.md` are regenerated with `npm run docs:gen`, never
merged or edited by hand.

### Step 1: What a play reads from a cache
**File:** `src/directStream/cachePlay.ts` (new)
**Change:** One module names the shape the service needs from phase 5 and the rule for playing a cache. The service and the route import only this.
**Code:**
```ts
import { isEnglish, refLabel, type ManifestKind, type ResolvedSource, type SourceAudio, type StreamRef } from './types.js';

/**
 * Playing from the stream cache (STREAM_CACHE_AND_BUG_REPORT phase 6). The cache itself (table
 * stream_caches, the downloader, the file route under /api/stream/cache/<id>/f/) is phase 5's
 * StreamCache in src/directStream/cache/; this module names only what a play reads from it, so the
 * service depends on this shape and not on the downloader.
 */

export type CacheState = 'downloading' | 'ready' | 'failed';

/** One subtitle file of a cache (WebVTT), served by the cache's file route. */
export interface CacheSubtitleView {
  /** Relative to the daemon's origin: `/api/stream/cache/<id>/f/<file>`. */
  url: string;
  lang: string | null;
  label: string;
}

/** One stream cache as a play reads it (phase 5's StreamCache answers it). */
export interface CachePlayView {
  /** The cache's own id (a uuid), never a movie id. */
  id: string;
  ref: StreamRef;
  /** The machine whose disk holds the files (os.hostname()). */
  host: string;
  state: CacheState;
  /** The provider the cache was downloaded from. */
  provider: string;
  /** The cached rendition's height; null when the manifest did not say. */
  height: number | null;
  /** The local manifest: one rendition's HLS playlist, or a plain file. DASH is never cached. */
  manifestKind: Extract<ManifestKind, 'hls' | 'mp4'>;
  /** The local playlist or file, relative to the daemon's origin: `/api/stream/cache/<id>/f/...`. */
  manifestUrl: string;
  subtitles: CacheSubtitleView[];
  /** The original language the cache's resolve was told (`--audio-lang`); null when it was not known. */
  audioLang: string | null;
  /** What that resolve heard in the stream; null when it was not asked. */
  audio: SourceAudio | null;
}

/** What DirectStreamService reads from phase 5's StreamCache (AppDeps.streamCache). */
export interface PlayableCaches {
  /** This host's cache of `ref` in any state (the newest when there are several), or null. */
  find(ref: StreamRef): Promise<CachePlayView | null>;
  /** The cache with this id on any host, or null when there is none or it was deleted. */
  get(id: string): Promise<CachePlayView | null>;
}

/** The cache a stream session plays from. A failed cache cannot be one: a session never holds it. */
export interface SessionCache {
  id: string;
  state: Exclude<CacheState, 'failed'>;
  height: number | null;
  manifestUrl: string;
  subtitles: CacheSubtitleView[];
}

/** Why a cache is not played. */
export type CacheRefusal = 'other_host' | 'failed' | 'other_language';

export type Playable = { ok: true; cache: SessionCache } | { ok: false; refusal: CacheRefusal };

/**
 * Whether this host may play `view`: its files must be on this host's disk, it must not have
 * failed, and when the title's original language is known the cache must have been resolved for
 * exactly that language (a stream plays in the original language only; a cache resolved without
 * it, or for another, could hold a dub).
 */
export function playable(view: CachePlayView, host: string, audioLang: string | null): Playable {
  if (view.host !== host) return { ok: false, refusal: 'other_host' };
  const state = view.state;
  if (state === 'failed') return { ok: false, refusal: 'failed' };
  if (audioLang !== null && view.audioLang !== audioLang) return { ok: false, refusal: 'other_language' };
  return { ok: true, cache: { id: view.id, state, height: view.height, manifestUrl: view.manifestUrl, subtitles: view.subtitles } };
}

/**
 * The ResolvedSource a cached session carries, so whatever reads `session.source` (the provider of
 * movie_plays and of the stream on screen, phase 1's snapshot) reads the cache's. Its manifest
 * address is the local, relative one, so `sourceHosts` finds no stream host: the pass-through
 * refuses every address for a cached session (`forbidden_host`), and nothing here is a token.
 */
export function cacheSource(view: CachePlayView): ResolvedSource {
  return {
    provider: view.provider,
    embed_url: '',
    manifest_url: view.manifestUrl,
    manifest_kind: view.manifestKind,
    headers: { referer: null, origin: null, user_agent: null },
    subtitles: [],
    best_height: view.height,
    en_subtitle: view.subtitles.some((t) => isEnglish(t)),
    audio: view.audio,
    took_s: null,
  };
}

export type CachePlayErrorCode = 'unknown_cache' | 'not_on_this_machine' | 'cache_failed' | 'cache_language';

/** A cache that `POST /api/stream/cache/:id/play` cannot play (src/http/streamCachePlayApi.ts maps it to HTTP). */
export class CachePlayError extends Error {
  override name = 'CachePlayError';

  constructor(
    readonly code: CachePlayErrorCode,
    message: string,
    /** `not_on_this_machine`: the host that holds the files. */
    readonly host: string | null = null,
  ) {
    super(message);
  }
}

/** The error a refusal answers when a cache is asked for by id. */
export function cacheRefusalError(view: CachePlayView, refusal: CacheRefusal, audioLang: string | null): CachePlayError {
  switch (refusal) {
    case 'other_host':
      return new CachePlayError('not_on_this_machine', `That stream cache is on ${view.host}, not on this machine.`, view.host);
    case 'failed':
      return new CachePlayError('cache_failed', 'That stream cache failed to download, so it cannot be played.');
    case 'other_language':
      return new CachePlayError(
        'cache_language',
        `That stream cache was made for ${view.audioLang ?? 'an unknown language'}, and ${refLabel(view.ref)} is in ${audioLang ?? 'an unknown language'}.`,
      );
  }
}

/** A cache id as phase 5 makes them (a uuid); anything else names no cache. One definition: phase 5's. */
export { CACHE_ID_PATTERN } from './cache/types.js';
```
**Impact:** none until imported.

### Step 2: A session can play from a cache
**File:** `src/directStream/sessions.ts`, as phase 1 left it (phase 1 added `refreshes` to
`StreamSession`, `refreshes: 0` to `create`'s literal, `session.refreshes += 1` to `replaceSource`, and
`peek()`; all are kept). Each edit is matched by its text.
**Change:** `StreamSession` carries the cache it plays; a resolve (refresh) drops it; a refresh that keeps the cache updates its state.

Imports (`:1-3`) become:
```ts
import { randomBytes } from 'node:crypto';
import type { SessionCache } from './cachePlay.js';
import { absoluteHttp } from './rewrite.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from './types.js';
```
In the `StreamSession` interface, after `audioLang: string | null;` add:
```ts
  /**
   * The stream cache on this host the session plays from (phase 6); null: through the pass-through.
   * While set, `source` is cacheSource()'s stand-in (the cache's provider, its local manifest), and
   * `attempts` and `allowedHosts` are empty.
   */
  cache: SessionCache | null;
```
`create` becomes (phase 1's `refreshes: 0` kept):
```ts
  create(
    ref: StreamRef,
    source: ResolvedSource,
    attempts: ResolveAttempt[],
    resumeS: number | null = null,
    audioLang: string | null = null,
    cache: SessionCache | null = null,
  ): StreamSession {
    this.sweep();
    const at = this.now();
    const session: StreamSession = {
      id: randomBytes(24).toString('base64url'),
      ref,
      source,
      attempts,
      allowedHosts: sourceHosts(source),
      resumeS,
      audioLang,
      cache,
      createdAt: at,
      refreshedAt: at,
      refreshes: 0,
      lastUsedAt: at,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: StreamSession | null = null;
      for (const s of this.sessions.values()) if (oldest === null || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
      if (oldest === null) break;
      this.sessions.delete(oldest.id);
    }
    return session;
  }
```
(Keep the order of the other members exactly as the file has them after phase 1; the only new
member is `cache`.)
`replaceSource` (phase 1's version) becomes, followed by the new `useCache`:
```ts
  /** A refresh: the new source, its hosts added to the ones the session already had. A resolved source is never a cache's. */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    session.cache = null;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }

  /** A refresh of a session whose cache can still be played: the cache as it is now (a download may have finished). Not counted in `refreshes` (no token was replaced). */
  useCache(session: StreamSession, cache: SessionCache): void {
    session.cache = cache;
    session.refreshedAt = this.now();
  }
```
**Impact:** every `StreamSession` now has `cache`; nothing builds one by literal outside `create` (checked: no test does).

### Step 3: The service plays a cache before it resolves
**File:** `src/directStream/service.ts`, as phase 1 left it (phase 1 imports `safeRecord`, `sessionRecord` and the rest from `./evidence.js`, holds `private readonly evidence: EvidenceSink | null`, records a `created` session record in `resolve`, `refresh_failed` / `refreshed` in `refresh`, observes `passThrough`, and adds `evidenceSource`; every one of those stays). Each edit is matched by its text.
**Change:** (a) imports, (b) `SessionInfo.cached`, (c) `caches` option, (d) `resolve`/`play`/`playCache`/`openPage`/`cachedSession`/`sessionFromCache`/`cacheById`/`startAt`, (e) `refresh`, (f) `switchEpisode`, (g) `sessionInfo`, (h) wiring.

(a) After the import of `./anime.js` (`:7`) add:
```ts
import { CACHE_ID_PATTERN, CachePlayError, cacheRefusalError, cacheSource, playable, type CachePlayView, type PlayableCaches, type SessionCache } from './cachePlay.js';
```

(b) In `SessionInfo` (`:89-114`), after `expires_at: string;` add:
```ts
  /**
   * The stream cache on this host the session plays from (phase 6): `ready` (all on disk; nothing
   * was resolved) or `downloading` (missing segments are fetched by the cache's file route). Then
   * `manifest_url` and each subtitle `url` are that file route's addresses. Null: through the pass-through.
   */
  cached: { id: string; state: SessionCache['state']; height: number | null } | null;
```

(c) In `DirectStreamServiceOptions` (`:129-144`), after `hooks?: DirectStreamHooks;` add:
```ts
  /**
   * This host's stream cache (phase 5's StreamCache, AppDeps.streamCache), read at play time
   * because it is built after this service. Unset or null: no cache, every play resolves.
   */
  caches?: () => PlayableCaches | null;
```

(d) Replace `resolve` (phase 1's version, which ends `safeRecord(this.evidence, sessionRecord(session, 'created', null)); return session;`) and `play` with:
```ts
  /**
   * Resolves the title and makes a session for it. Throws `no_source` (every attempt in `attempts`) or
   * `resolve_failed` (with `reason`; `deadline` when `deadlineS` cut it short). The recordResolve hook
   * has run before this returns or throws. Always resolves: a cache is `play`'s business, and
   * `subtitleText` needs a resolved source.
   */
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const out = await this.resolveSource(ref, options.deadlineS);
    const resumeS = await this.startAt(ref, options.resumeS ?? null);
    const session = this.sessions.create(ref, out.source, out.attempts, resumeS, await this.audioLang(ref));
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /**
   * Opens this daemon's player page for the title full screen in the streaming Chrome. This host's
   * cache of the title (phase 5), when it can be played (`playable`), makes the session with no
   * resolve; otherwise the title is resolved first, as before.
   */
  async play(input: StreamRefInput, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const ref = toStreamRef(input);
    const session = (await this.cachedSession(ref, options.resumeS ?? null)) ?? (await this.resolve(ref, options));
    return this.openPage(session);
  }

  /**
   * POST /api/stream/cache/:id/play: plays one cache by its id, with no resolve. Throws
   * CachePlayError `unknown_cache`, `not_on_this_machine` (with the host that holds it),
   * `cache_failed` or `cache_language`; then `open_failed` as `play` does.
   */
  async playCache(cacheId: string, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const caches = this.opts.caches?.() ?? null;
    const view = caches === null || !CACHE_ID_PATTERN.test(cacheId) ? null : await caches.get(cacheId);
    if (view === null) throw new CachePlayError('unknown_cache', 'There is no stream cache with that id.');
    const audioLang = await this.audioLang(view.ref);
    const check = playable(view, this.host, audioLang);
    if (!check.ok) throw cacheRefusalError(view, check.refusal, audioLang);
    return this.openPage(await this.sessionFromCache(view, check.cache, options.resumeS ?? null, audioLang));
  }

  /** Opens the session's player page full screen in the streaming Chrome (one at a time, like every resolve). */
  private async openPage(session: StreamSession): Promise<PlayResult> {
    const pageUrl = `${this.opts.pageBase()}/stream/${session.id}`;
    const opened = await this.serial(async (): Promise<OpenOutput> => {
      try {
        return parseOpenOutput(await this.runner(['open', pageUrl, '--fullscreen']));
      } catch (err) {
        return { ok: false, error: 'script_failed', detail: messageOf(err) };
      }
    });
    if (!opened.ok) {
      throw new DirectStreamError('open_failed', `The player page could not be opened in the streaming Chrome: ${opened.detail || opened.error}`, {
        reason: opened.error,
        sessionId: session.id,
        pageUrl,
        attempts: session.attempts,
      });
    }
    this.log(
      session.cache === null
        ? `[notesd] direct stream: playing ${refLabel(session.ref)} from ${session.source.provider}`
        : `[notesd] direct stream: playing ${refLabel(session.ref)} from the cache ${session.cache.id} (${session.cache.state}, ${session.source.provider})`,
    );
    return { page_url: pageUrl, session: await this.sessionInfo(session), attempts: session.attempts };
  }

  /**
   * A session on this host's cache of `ref`, or null: no cache wiring, no cache, one that cannot be
   * played (another host's, failed, another language), or the lookup failed. A null makes the play
   * resolve; the cache never fails a play.
   */
  private async cachedSession(ref: StreamRef, resumeS: number | null): Promise<StreamSession | null> {
    const caches = this.opts.caches?.() ?? null;
    if (caches === null) return null;
    let view: CachePlayView | null;
    try {
      view = await caches.find(ref);
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the stream cache of ${refLabel(ref)}: ${messageOf(err)}`);
      return null;
    }
    if (view === null) return null;
    const audioLang = await this.audioLang(ref);
    const check = playable(view, this.host, audioLang);
    if (!check.ok) {
      if (check.refusal !== 'other_host') this.log(`[notesd] direct stream: the cache ${view.id} of ${refLabel(ref)} is not played (${check.refusal})`);
      return null;
    }
    return this.sessionFromCache(view, check.cache, resumeS, audioLang);
  }

  private async sessionFromCache(view: CachePlayView, cache: SessionCache, resumeS: number | null, audioLang: string | null): Promise<StreamSession> {
    const session = this.sessions.create(view.ref, cacheSource(view), [], await this.startAt(view.ref, resumeS), audioLang ?? view.audioLang, cache);
    // Made without resolve(): phase 1's `created` record is written here, so a snapshot of a cached play has a source line.
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /** One cache by id, or null (none, no cache wiring, or the lookup failed). */
  private async cacheById(id: string): Promise<CachePlayView | null> {
    const caches = this.opts.caches?.() ?? null;
    if (caches === null) return null;
    try {
      return await caches.get(id);
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the stream cache ${id}: ${messageOf(err)}`);
      return null;
    }
  }

  /** Where a new session starts: the asked position, else the resumeS hook's, else null. */
  private async startAt(ref: StreamRef, resumeS: number | null): Promise<number | null> {
    const hook = this.opts.hooks?.resumeS;
    if (resumeS !== null || hook === undefined) return resumeS;
    return this.hookValue('resumeS', () => hook(ref));
  }
```

(e) Replace `refresh` (phase 1's version, with its `refresh_failed` / `refreshed` records) with:
```ts
  /**
   * The player's refresh (a token expired) under the same id. A session on a cache that can still be
   * played keeps it and resolves nothing (its state is read again: a download may have finished);
   * once the cache is gone, failed or unreadable, the title is resolved and the session goes on
   * through the pass-through. A failed resolve leaves the session as it was.
   */
  async refresh(id: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    if (session.cache !== null) {
      const view = await this.cacheById(session.cache.id);
      const check = view === null ? null : playable(view, this.host, session.audioLang);
      if (check !== null && check.ok) {
        this.sessions.useCache(session, check.cache);
        return this.sessionInfo(session);
      }
      this.log(`[notesd] direct stream: the cache ${session.cache.id} of ${refLabel(session.ref)} can no longer be played (${check === null ? 'gone' : check.refusal}); resolving`);
    }
    let out: ResolvedOutput;
    try {
      out = await this.resolveSource(session.ref);
    } catch (err) {
      safeRecord(this.evidence, sessionRecord(session, 'refresh_failed', err instanceof DirectStreamError ? `${err.code}: ${err.message}` : messageOf(err)));
      throw err;
    }
    this.sessions.replaceSource(session, out.source, out.attempts);
    safeRecord(this.evidence, sessionRecord(session, 'refreshed', null));
    return this.sessionInfo(session);
  }
```

(f) Replace `switchEpisode` (`:247-262`) with:
```ts
  /**
   * The player's previous / next button: a new session for the neighbouring episode of the session's
   * (the old one is left to expire; the page reports it closed), from that episode's cache on this
   * host when it can be played, else resolved. Throws `unknown_session`, `no_episode` (a film, or no
   * episode on that side), or what `resolve` throws.
   */
  async switchEpisode(id: string, to: 'prev' | 'next'): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const target = (await this.neighborsOf(session.ref))[to];
    if (target === null || session.ref.kind !== 'tv') {
      throw new DirectStreamError('no_episode', to === 'next' ? 'There is no next episode to stream.' : 'There is no previous episode.');
    }
    const ref: StreamRef = { kind: 'tv', tmdbId: session.ref.tmdbId, season: target.season, episode: target.episode };
    const next = (await this.cachedSession(ref, null)) ?? (await this.resolve(ref));
    this.log(
      `[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) ${next.cache === null ? `from ${next.source.provider}` : `from the cache ${next.cache.id}`}`,
    );
    return this.sessionInfo(next);
  }
```

(g) Replace `sessionInfo` (`:466-502`) with:
```ts
  private async sessionInfo(session: StreamSession): Promise<SessionInfo> {
    const { ref, source, cache } = session;
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    const neighbors = await this.neighborsOf(ref);
    return {
      session_id: session.id,
      kind: ref.kind,
      tmdb_id: ref.tmdbId,
      season: ref.kind === 'tv' ? ref.season : null,
      episode: ref.kind === 'tv' ? ref.episode : null,
      title,
      provider: source.provider,
      manifest_kind: source.manifest_kind,
      // A cache's files come from its own route on this daemon, never through the pass-through.
      manifest_url: cache === null ? proxiedUrl(session.id, source.manifest_url) : cache.manifestUrl,
      subtitles:
        cache === null
          ? source.subtitles.map((t) => {
              const srt = t.format === 'srt' || /\.srt$/i.test(new URL(t.url).pathname);
              return {
                url: proxiedUrl(session.id, t.url, { vtt: srt }),
                lang: t.lang,
                label: t.label,
                format: srt ? 'vtt' : t.format,
                source: t.source,
                english: isEnglish(t),
              };
            })
          : cache.subtitles.map((t) => ({ url: t.url, lang: t.lang, label: t.label, format: 'vtt', source: 'request' as const, english: isEnglish(t) })),
      best_height: source.best_height,
      audio_lang: session.audioLang,
      audio: source.audio ?? null,
      resume_s: session.resumeS,
      prev_episode: neighbors.prev,
      next_episode: neighbors.next,
      created_at: session.createdAt.toISOString(),
      refreshed_at: session.refreshedAt.toISOString(),
      expires_at: this.sessions.expiresAt(session).toISOString(),
      cached: cache === null ? null : { id: cache.id, state: cache.state, height: cache.height },
    };
  }
```

(h) In `DirectStreamWiring`, after phase 1's `evidence?: EvidenceSink | null;` (which follows `hooks?: DirectStreamHooks;`) add:
```ts
  /** Phase 6: this host's stream cache, read at play time (phase 5 builds it after this service). */
  caches?: () => PlayableCaches | null;
```
and in `buildDirectStreamService`'s `new DirectStreamService({...})`, after phase 1's `evidence: wiring.evidence ?? null,` add:
```ts
    caches: wiring.caches,
```

(i) **File:** `src/directStream/evidence.ts` (phase 1's). A snapshot names the cache a play came from
(reconciliation decision: the smallest correct way for a stream bug report to see a cached play).
In `interface SessionSource`, after `refreshes: number;` add:
```ts
  /** The stream cache on this host the session plays from (phase 6); null: through the pass-through. */
  cache: { id: string; state: 'downloading' | 'ready' } | null;
```
and in `sessionSource()`'s returned object, after `refreshes: session.refreshes,` add:
```ts
    cache: session.cache === null ? null : { id: session.cache.id, state: session.cache.state },
```
Phase 1's unit test builds sources with `sessionSource()` and matches with `toMatchObject`, so it
keeps passing; phase 3's `diagnose.mjs` already prints `source.cache` when present.
**Impact:** a play with no cache wiring or no cache behaves exactly as before (one resolve, one open, same log line). The original-language rule holds for cached plays through `playable()`'s `other_language`; the stored audio track (phase 5 keeps only the session's original-language track) reaches the page through `audio`. `recordResolve` is not called for a cached play (nothing was resolved; `movie_stream_sources` is untouched). Position reports and `StreamLive` read `session.source.provider`, which is the cache's provider.

### Step 4: Play one cache by id
**File:** `src/http/streamCachePlayApi.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { CachePlayError } from '../directStream/cachePlay.js';
import type { DirectStreamService } from '../directStream/service.js';
import { DIRECT_STREAM_OFF, directStreamErrorResponse } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Playing one stream cache by its id (STREAM_CACHE_AND_BUG_REPORT phase 6): the player page opens
 * on the cache's local copy with no resolve. A cache made on the other machine answers 404
 * `not_on_this_machine`. Same-origin only: it starts the streaming Chrome. Phase 5 owns every
 * other /api/stream/cache route.
 */

const playCacheBody = z.strictObject({ resume_s: z.number().min(0).max(172_800).nullish() });

export function streamCachePlayRoutes(deps: { directStream?: DirectStreamService | null }): Hono {
  const r = new Hono();
  r.post('/api/stream/cache/:id/play', sameOriginOnly, async (c) => {
    const service = deps.directStream ?? null;
    if (service === null) return c.json(DIRECT_STREAM_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = playCacheBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const played = await service.playCache(c.req.param('id'), { resumeS: body.data.resume_s ?? null });
      return c.json({ ok: true, ...played });
    } catch (err) {
      if (err instanceof CachePlayError) {
        if (err.code === 'not_on_this_machine') return c.json({ error: err.code, message: err.message, host: err.host }, 404);
        if (err.code === 'unknown_cache') return c.json({ error: err.code, message: err.message }, 404);
        return c.json({ error: err.code, message: err.message }, 409);
      }
      return directStreamErrorResponse(c, err);
    }
  });
  return r;
}
```
**File:** `src/http/app.ts` — after `import { directStreamRoutes } from './directStreamApi.js';` add:
```ts
import { streamCachePlayRoutes } from './streamCachePlayApi.js';
```
**File:** `src/http/app.ts` — after phase 5's `app.route('/', streamCacheRoutes(deps));` (which follows `app.route('/', directStreamRoutes(deps));`) add:
```ts
  app.route('/', streamCachePlayRoutes(deps));
```
**Impact:** one new route. It is mounted after `directStreamRoutes`, whose `/api/stream/*` off guard already answers 503 first; the route checks again so it stands alone in tests. Phase 5's `/api/stream/cache/:id` (GET, DELETE) and `/:id/f/*` do not collide with `POST /:id/play`.

### Step 5: Wire the cache into the service
**File:** `src/daemon.ts`, as phases 1, 4 and 5 left it
**Change:** in `buildDirectStreamService(config, db, { movies, pageBase: ..., evidence: streamEvidence, hooks: ... })`, after phase 1's `evidence: streamEvidence,` line add:
```ts
    // Phase 6: a play reads this host's stream cache first. Phase 5 builds it after this service, so
    // it is read at play time (deps exists by then).
    caches: () => deps.streamCache?.player() ?? null,
```
**Impact:** `deps` is the `const deps: AppDeps` declared below; the arrow only runs at play time. If phase 5's `StreamCache.player()` does not fit `PlayableCaches`, `npm run typecheck` fails here — that is the contract check.

### Step 6: Server tests
**File:** `tests/unit/directStream/cachePlay.test.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CachePlayView, PlayableCaches } from '../../../src/directStream/cachePlay.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, type DirectStreamHooks } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';
import { streamCachePlayRoutes } from '../../../src/http/streamCachePlayApi.js';

const HOST = 'host-a';
const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const FILM: StreamRef = { kind: 'movie', tmdbId: 550 };
const EP787: StreamRef = { kind: 'tv', tmdbId: 37854, season: 18, episode: 787 };
const CACHE_A = '0b6c7a52-6a0e-4d1e-9d8e-1f2a3b4c5d6e';
const CACHE_B = '7d1f2e3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const PLAY_FILM = { kind: 'movie', tmdb_id: 550 };

const RESOLVED = {
  ok: true,
  source: {
    provider: 'Alpha',
    manifest_url: 'https://up.example/hls/master.m3u8',
    manifest_kind: 'hls',
    subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English' }],
    best_height: 1080,
  },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: '' }] };

function view(over: Partial<CachePlayView> = {}): CachePlayView {
  const id = over.id ?? CACHE_A;
  return {
    id,
    ref: FILM,
    host: HOST,
    state: 'ready',
    provider: 'HyperLink',
    height: 720,
    manifestKind: 'hls',
    manifestUrl: `/api/stream/cache/${id}/f/master.m3u8`,
    subtitles: [{ url: `/api/stream/cache/${id}/f/subtitle.vtt`, lang: 'en', label: 'English' }],
    audioLang: 'en',
    audio: { languages: ['en'], tracks: 0, original: true, track: null },
    ...over,
  };
}

const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));

/** A cache store over `views`. `find` does not filter by host, so the service's own host check is what is tested. */
function cachesOf(views: CachePlayView[]): PlayableCaches {
  return {
    find: async (ref) => views.find((v) => sameRef(v.ref, ref)) ?? null,
    get: async (id) => views.find((v) => v.id === id) ?? null,
  };
}

interface Setup {
  views?: CachePlayView[];
  /** null: no cache wiring at all. Default: cachesOf(views). */
  caches?: PlayableCaches | null;
  resolve?: unknown;
  hooks?: DirectStreamHooks;
}

function setup(o: Setup = {}) {
  const views = o.views ?? [];
  const calls: string[][] = [];
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      calls.push(args);
      return args[0] === 'open' ? { ok: true } : (o.resolve ?? RESOLVED);
    },
    host: HOST,
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: { originalLanguage: async () => 'en', ...o.hooks },
    caches: () => (o.caches === undefined ? cachesOf(views) : o.caches),
    sessions: new SessionStore(),
    log: () => undefined,
  });
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamCachePlayRoutes({ directStream: svc }));
  const count = (verb: string): number => calls.filter((a) => a[0] === verb).length;
  return { app, views, resolves: () => count('resolve'), opens: () => count('open') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, path: string, body: unknown = {}, headers: Record<string, string> = HEADERS): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('playing from the stream cache', () => {
  it('plays a ready cache with no resolve: its local playlist, its subtitle and provider, one page opened', async () => {
    const t = setup({ views: [view()], resolve: NO_SOURCE });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.cached).toEqual({ id: CACHE_A, state: 'ready', height: 720 });
    expect(json.session.manifest_url).toBe(`/api/stream/cache/${CACHE_A}/f/master.m3u8`);
    expect(json.session.subtitles).toEqual([{ url: `/api/stream/cache/${CACHE_A}/f/subtitle.vtt`, lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true }]);
    expect(json.session).toMatchObject({ provider: 'HyperLink', manifest_kind: 'hls', best_height: 720, audio_lang: 'en' });
    expect(json.attempts).toEqual([]);
    expect([t.resolves(), t.opens()]).toEqual([0, 1]);
    const read = await t.app.request(`/api/stream/sessions/${json.session.session_id}`);
    expect(((await read.json()) as { cached: unknown }).cached).toEqual({ id: CACHE_A, state: 'ready', height: 720 });
    // The pass-through serves nothing for it: a cached session may reach no stream host.
    const through = await t.app.request(`/api/stream/sessions/${json.session.session_id}/p?u=${encodeURIComponent('https://up.example/hls/seg1.ts')}`);
    expect(through.status).toBe(403);
    expect(((await through.json()) as { error: string }).error).toBe('forbidden_host');
  });

  it('plays a downloading cache from the same local playlist, with no resolve', async () => {
    const t = setup({ views: [view({ state: 'downloading' })], resolve: NO_SOURCE });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.cached).toEqual({ id: CACHE_A, state: 'downloading', height: 720 });
    expect(json.session.manifest_url).toBe(`/api/stream/cache/${CACHE_A}/f/master.m3u8`);
    expect(t.resolves()).toBe(0);
  });

  it('resolves as before when the cache failed, is on the other machine, was made for another language, or cannot be read', async () => {
    const cases: Setup[] = [
      { views: [view({ state: 'failed' })] },
      { views: [view({ host: 'host-b' })] },
      { views: [view({ audioLang: 'en' })], hooks: { originalLanguage: async () => 'ko' } },
      { views: [view({ audioLang: null })] },
      { caches: { find: async () => { throw new Error('db down'); }, get: async () => null } },
      { caches: null },
      {},
    ];
    for (const c of cases) {
      const t = setup(c);
      const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
      expect(status).toBe(200);
      expect(json.session.cached).toBeNull();
      expect(String(json.session.manifest_url).startsWith(`/api/stream/sessions/${json.session.session_id}/p?u=`)).toBe(true);
      expect(json.session.provider).toBe('Alpha');
      expect([t.resolves(), t.opens()]).toEqual([1, 1]);
    }
  });

  it('starts a cached play where the last one stopped, or where it is asked to', async () => {
    const t = setup({ views: [view()], hooks: { resumeS: async () => 754 } });
    expect((await post(t.app, '/api/stream/play', PLAY_FILM)).json.session.resume_s).toBe(754);
    expect((await post(t.app, '/api/stream/play', { ...PLAY_FILM, resume_s: 30 })).json.session.resume_s).toBe(30);
  });

  it('POST /api/stream/cache/:id/play plays one cache by id, and refuses one it cannot play', async () => {
    const t = setup({ views: [view(), view({ id: CACHE_B, host: 'host-b' })], resolve: NO_SOURCE });
    const played = await post(t.app, `/api/stream/cache/${CACHE_A}/play`, { resume_s: 12 });
    expect(played.status).toBe(200);
    expect(played.json).toMatchObject({ ok: true, attempts: [], session: { cached: { id: CACHE_A, state: 'ready' }, resume_s: 12 } });
    const bare = await t.app.request(`/api/stream/cache/${CACHE_A}/play`, { method: 'POST', headers: HEADERS });
    expect(bare.status).toBe(200);
    const other = await post(t.app, `/api/stream/cache/${CACHE_B}/play`);
    expect(other.status).toBe(404);
    expect(other.json).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    const unknown = await post(t.app, '/api/stream/cache/00000000-0000-4000-8000-000000000000/play');
    expect([unknown.status, unknown.json.error]).toEqual([404, 'unknown_cache']);
    expect((await post(t.app, '/api/stream/cache/a.b/play')).json.error).toBe('unknown_cache');
    expect((await post(t.app, `/api/stream/cache/${CACHE_A}/play`, { resume_s: -1 })).status).toBe(400);
    expect((await post(t.app, `/api/stream/cache/${CACHE_A}/play`, {}, { 'content-type': 'application/json' })).status).toBe(403);
    expect(t.resolves()).toBe(0);
    const failed = setup({ views: [view({ state: 'failed' })] });
    const refused = await post(failed.app, `/api/stream/cache/${CACHE_A}/play`);
    expect([refused.status, refused.json.error]).toEqual([409, 'cache_failed']);
    const korean = setup({ views: [view()], hooks: { originalLanguage: async () => 'ko' } });
    const dub = await post(korean.app, `/api/stream/cache/${CACHE_A}/play`);
    expect([dub.status, dub.json.error]).toEqual([409, 'cache_language']);
    expect(failed.opens() + korean.opens()).toBe(0);
  });

  it('a refresh keeps a cache that can still be played, and resolves once it is gone', async () => {
    const t = setup({ views: [view({ state: 'downloading' })] });
    const sid = (await post(t.app, '/api/stream/play', PLAY_FILM)).json.session.session_id as string;
    t.views[0] = view({ state: 'ready' });
    const kept = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(kept.status).toBe(200);
    expect(kept.json).toMatchObject({ session_id: sid, cached: { id: CACHE_A, state: 'ready', height: 720 } });
    expect(t.resolves()).toBe(0);
    t.views.length = 0;
    const gone = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(gone.status).toBe(200);
    expect(gone.json.session_id).toBe(sid);
    expect(gone.json.cached).toBeNull();
    expect(String(gone.json.manifest_url).startsWith(`/api/stream/sessions/${sid}/p?u=`)).toBe(true);
    expect(t.resolves()).toBe(1);
  });

  it('the previous and next episode buttons play a neighbour from its cache when it has one', async () => {
    const neighbors: NonNullable<DirectStreamHooks['neighbors']> = async (ref) =>
      ref.kind === 'tv' && ref.episode === 787 ? { prev: null, next: { season: 18, episode: 788 } } : { prev: { season: 18, episode: 787 }, next: null };
    const t = setup({ views: [view({ ref: EP787 })], hooks: { neighbors } });
    const first = await post(t.app, '/api/stream/play', { kind: 'tv', tmdb_id: 37854, season: 18, episode: 787 });
    expect(first.json.session.cached.id).toBe(CACHE_A);
    const next = await post(t.app, `/api/stream/sessions/${first.json.session.session_id}/episode`, { to: 'next' });
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({ episode: 788, cached: null });
    expect(t.resolves()).toBe(1);
    const back = await post(t.app, `/api/stream/sessions/${next.json.session_id}/episode`, { to: 'prev' });
    expect(back.json).toMatchObject({ episode: 787, cached: { id: CACHE_A, state: 'ready' } });
    expect(t.resolves()).toBe(1);
  });
});
```
**Check:** `npx vitest run tests/unit/directStream/cachePlay.test.ts` — 7 tests pass. (If the repo has no eslint, drop the disable comment.)

### Step 7: The MCP play answer says it came from the cache
**File:** `src/mcp/directStreamTools.ts:150-166` — in `PLAY_DESCRIPTION`, insert this string as a new `+`-joined line immediately before the line that starts `'Tell the owner it plays in the streaming Chrome window`:
```ts
  'When this machine holds a cache of the film or episode (made with direct_stream_cache), the play comes from it: play.session.cached is { id, state, height }. state ready plays from disk with no provider asked (attempts is empty, and it works with the internet down); state downloading plays what is on disk and fetches each part not there yet as the film reaches it. A failed cache, or one made on the other machine, is not used: the play resolves as usual. ' +
```
**File:** `src/mcp/directStreamTools.ts:408` — after `playFailure`, add:
```ts
/** What a started play's `next` adds when it plays from this machine's cache (play.session.cached); '' otherwise. */
function cacheNext(play: unknown): string {
  const cached = (play as { session?: { cached?: { state?: unknown } | null } } | null)?.session?.cached;
  if (cached === null || cached === undefined || typeof cached !== 'object') return '';
  return cached.state === 'ready'
    ? " Say it plays from this machine's cache (no provider was asked)."
    : " Say it plays from this machine's cache while the cache is still downloading, so a part not downloaded yet is fetched as it is reached.";
}
```
**File:** `src/mcp/directStreamTools.ts:605-611` — the `next:` of the `started: true` answer becomes:
```ts
            next:
              (absolute_episode !== undefined
                ? `Say which season and episode is playing and that it is episode ${absolute_episode} counted from the first, that it plays full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.`
                : choice === null
                  ? 'Say it is playing full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.'
                  : 'Say which season and episode is playing and why (picked: first, resume from where it stopped, or next), that it plays full screen in the streaming Chrome window, and that a double click, F, Esc or F11 leaves full screen.') +
              cacheNext(play),
```
**File:** `tests/unit/mcp.directStreamTools.test.ts` — inside `describe('direct-stream MCP tools', ...)`, after the test `'direct_stream_play starts exactly one matching film through the service'`, add:
```ts
  it("direct_stream_play says when the play came from this machine's cache", async () => {
    const f = fakeDeps({
      play: vi.fn(async () => ({ page_url: 'http://localhost:7317/stream/s1', session: { session_id: 's1', provider: 'HyperLink', cached: { id: 'c1', state: 'ready', height: 720 } }, attempts: [] })),
    });
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'saltburn' }));
    expect(out.play.session.cached).toEqual({ id: 'c1', state: 'ready', height: 720 });
    expect(out.next).toContain("from this machine's cache (no provider was asked)");
    await c.close();
    const plain = await connect(fakeDeps().deps);
    expect(json(await plain.call('direct_stream_play', { title: 'saltburn' })).next).not.toContain('cache');
    await plain.close();
  });
```
**Impact:** the tool's description changes, so `npm run docs:gen` (step 13) is required.

### Step 8: The page reads `cached`
**File:** `web/src/stream/session.ts`
- After `AudioTrackRef` (`:35-38`) add:
```ts
/** A cache's state as a session names it (phase 6): the page plays this machine's local copy. */
export type CachedState = 'downloading' | 'ready';

/** SessionInfo.cached: the stream cache on this machine the session plays from. */
export interface CachedInfo {
  id: string;
  state: CachedState;
  height: number | null;
}
```
- In `StreamSession` (`:15-27`), after `nextEpisode: EpisodeNumber | null;` add:
```ts
  /** Played from this machine's stream cache; null: through the pass-through. */
  cached: CachedInfo | null;
```
- After `episodeNumber` (`:71-75`) add:
```ts
function cachedInfo(value: unknown): CachedInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, state, height } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || (state !== 'downloading' && state !== 'ready')) return null;
  return { id, state, height: typeof height === 'number' && Number.isInteger(height) && height > 0 ? height : null };
}
```
- In `parseSession`'s returned object (`:103-113`), after `nextEpisode: episodeNumber(o.next_episode),` add:
```ts
    cached: cachedInfo(o.cached),
```

**File:** `web/src/stream/engine.ts` (as phase 2 left it) — after phase 2's
`export const MUTED_BUFFER_AHEAD_S = 30;` add:
```ts
/**
 * A complete cache (phase 6): all of it is on this machine's disk, so no cap of ours beyond hls.js's
 * own default ceiling (600 s); its byte cap (maxBufferSize, 60 MB) still holds, so the page's memory
 * stays bounded. A cache still downloading keeps BUFFER_AHEAD_S, and `?muted=1` keeps
 * MUTED_BUFFER_AHEAD_S either way.
 */
export const CACHED_BUFFER_AHEAD_S = 600;
```
There is one buffer setting in the page: phase 2's `EngineRequest.bufferAheadS`, which the HLS engine
uses as `maxBufferLength` and `maxMaxBufferLength`. This phase adds no `EngineRequest` field, no
`buffer.ts`, and does not touch `hlsEngine.ts`; the controller chooses the value (Step 9).
**Impact:** pass-through plays keep 120 s, `?muted=1` keeps 30 s (Invariant 4), a ready cache gets 600 s. DASH and native engines ignore `bufferAheadS` as before (DASH is never cached; a cached `mp4` plays natively from the file route with range requests).

### Step 9: The controller carries `cached`
**File:** `web/src/stream/controller.ts`
- In the `./session` import (`:2-12`), add `type CachedInfo,` after `SessionError,`.
- In `StreamState` (`:21-49`), after `switchError: ...;` add:
```ts
  /** Played from this machine's stream cache (phase 6): the page marks it beside the title. Null: through the pass-through. */
  cached: CachedInfo | null;
```
- In `INITIAL_STATE` (`:51-69`), after `switchError: null,` add:
```ts
  cached: null,
```
- `open` (`:176-182`) becomes:
```ts
  /** Plays a session read from the daemon: its name, neighbours and cache, its subtitle files, then the engine at its resume position. */
  private async open(session: StreamSession): Promise<void> {
    this.session = session;
    this.set({ title: session.title, kind: session.manifestKind, prevEpisode: session.prevEpisode, nextEpisode: session.nextEpisode, cached: session.cached });
    if (session.cached !== null) this.note(`from cache ${session.cached.id.slice(0, 8)} (${session.cached.state})`);
    await this.loadFileSubtitles(session);
    if (this.disposed || this.session !== session) return;
    await this.attach(session, session.resumeS);
  }
```
- The `./engine` import phase 2 wrote (`BUFFER_AHEAD_S, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT, type CreateEngine, ...`) gains `CACHED_BUFFER_AHEAD_S,` before `MUTED_BUFFER_AHEAD_S,`.
- In `attach`, in the object passed to `this.deps.createEngine({...})`, phase 2's two lines
  `// R1.8: 120 s ahead; ?muted=1 keeps 30 s for the expiry checks.` and
  `bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : BUFFER_AHEAD_S,` become:
```ts
        // R1.8: 120 s ahead; ?muted=1 keeps 30 s for the expiry checks; a complete cache (phase 6)
        // is on disk, so it buffers as far as hls.js goes by itself.
        bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : session.cached?.state === 'ready' ? CACHED_BUFFER_AHEAD_S : BUFFER_AHEAD_S,
```
- In `refresh` (`:482`), the line `this.session = session;` becomes:
```ts
      this.session = session;
      // A refresh of a cached session either keeps the cache or moves to the pass-through (the cache was cleared).
      this.set({ cached: session.cached });
```
**Impact:** `window.notesdStream.cached` exists (it spreads `StreamState`). The `from cache ...` line is in `log`, which phase 1 posts to the daemon on an error, refresh or recovery, so the report flow sees that the play was local.

### Step 10: The mark beside the title
**File:** `web/src/stream/StreamApp.tsx`
- In the Phosphor import (`:2-18`), add `CloudArrowDown,` after `ClosedCaptioning,` and `HardDrive,` after `GearSix,`.
- `:22` becomes:
```ts
import type { CachedInfo, EpisodeNumber } from './session';
```
- After `switchErrorText` (`:83-88`) add:
```tsx
/** The cache mark's tooltip and accessible name. */
export function cachedLabel(cached: CachedInfo): string {
  const quality = cached.height === null ? '' : ` (${cached.height}p)`;
  return cached.state === 'ready' ? `Playing from this machine's cache${quality}` : `Playing from this machine's cache while it downloads${quality}`;
}

/** Icon only: a drive when the whole film is on disk, a cloud with an arrow while it still downloads. */
function CachedMark({ cached }: { cached: CachedInfo }) {
  const label = cachedLabel(cached);
  return (
    <span className="st-cached" role="img" aria-label={label} title={label} data-state={cached.state}>
      {cached.state === 'ready' ? <HardDrive /> : <CloudArrowDown />}
    </span>
  );
}
```
- In the JSX (`:349`), after `<span className="st-title">{state.title}</span>` add:
```tsx
          {state.cached !== null && <CachedMark cached={state.cached} />}
```
**File:** `web/src/stream/stream.css` — after the `.st-notice` rule (`:72-75`) add:
```css
.st-cached {
  display: inline-grid;
  place-items: center;
  margin-left: 10px;
  vertical-align: -3px;
  font-size: 16px;
  color: #9cc5a1;
}
.st-cached[data-state='downloading'] {
  color: #e9c46a;
}
```
**Impact:** the top row (which hides with the controls) shows the mark; the error overlay (phase 4's report button) is not touched.

### Step 11: Web tests
**File:** `web/src/stream/controller.test.tsx`
- Imports: phase 2's `./engine` import in this test file gains `CACHED_BUFFER_AHEAD_S`.
- In the `toEqual` of `'maps phase 3\'s SessionInfo ...'` (`:45-58`), after `nextEpisode: null,` add `cached: null,`.
- At the end of `describe('parseSession', ...)` (before its closing `});` at `:108`), add:
```ts
  it('reads the cache a session plays from, and nothing it cannot use', () => {
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'ready', height: 720 } })).cached).toEqual({ id: 'c1', state: 'ready', height: 720 });
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'downloading', height: 'x' } })).cached).toEqual({ id: 'c1', state: 'downloading', height: null });
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'failed', height: 720 } })).cached).toBeNull();
    expect(parseSession(streamSessionJson({ cached: null })).cached).toBeNull();
    expect(parseSession(streamSessionJson()).cached).toBeNull();
  });
```
- After `describe('parseSession', ...)` add:
```ts
const CACHED = { id: 'c1d2e3f4-0000-4000-8000-000000000001', state: 'ready', height: 720 };
const LOCAL = '/api/stream/cache/c1d2e3f4-0000-4000-8000-000000000001/f/master.m3u8';

describe('playing from the cache', () => {
  it("hands a cached session's state to the engine, keeps it in the state and notes it in the log", async () => {
    const { controller, made } = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ manifest_url: LOCAL, cached: CACHED })) });
    await controller.start();
    expect(made[0]?.req.src).toBe(LOCAL);
    expect(made[0]?.req.bufferAheadS).toBe(CACHED_BUFFER_AHEAD_S);
    expect(controller.getState().cached).toEqual(CACHED);
    expect(controller.getState().log).toContain('from cache c1d2e3f4 (ready)');
  });

  it('keeps 120 s ahead for a stream through the pass-through and for a cache still downloading', async () => {
    const plain = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    await plain.controller.start();
    expect(plain.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    expect(plain.controller.getState().cached).toBeNull();
    const downloading = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ manifest_url: LOCAL, cached: { ...CACHED, state: 'downloading' } })) });
    await downloading.controller.start();
    expect(downloading.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
  });

  it('drops the mark when a refresh moves the session onto the pass-through (the cache was cleared)', async () => {
    let reads = 0;
    const { controller, made } = setup({
      'GET /api/stream/sessions/S1': () => jsonResponse(reads++ === 0 ? streamSessionJson({ manifest_url: LOCAL, cached: CACHED }) : streamSessionJson()),
      'POST /api/stream/sessions/S1/refresh': () => jsonResponse({ session_id: 'S1' }),
    });
    await controller.start();
    made[0]!.req.handlers.onReady({ qualities: [], subtitles: [] });
    made[0]!.req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(made).toHaveLength(2));
    expect(made[1]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    expect(controller.getState().cached).toBeNull();
  });
});

describe('the buffer of a cached play', () => {
  it('keeps 30 s under ?muted=1 even for a complete cache, and the numbers are 30 / 120 / 600', () => {
    expect([MUTED_BUFFER_AHEAD_S, BUFFER_AHEAD_S, CACHED_BUFFER_AHEAD_S]).toEqual([30, 120, 600]);
  });
});
```
(The `?muted=1` case of a ready cache is proven in a real page by J2, which opens the cached play
with `?muted=1`; the controller's muted branch comes first in the expression, as phase 2's test of it
already shows.)
**File:** `web/src/stream/StreamApp.test.tsx`
- Import (`:5`): `import { StreamApp, cachedLabel, episodeLabel, formatClock, switchErrorText } from './StreamApp';`
- Inside `describe('StreamApp', ...)`, at its end, add:
```tsx
  it('marks a play from the cache beside the title, and nothing for a stream through the pass-through', async () => {
    const cached = { id: 'c1', state: 'ready', height: 720 };
    const ready = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ cached })) }).fetchImpl, createEngine: fakeEngines().createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    const mark = ready.querySelector('.st-top .st-cached');
    expect(mark?.getAttribute('aria-label')).toBe("Playing from this machine's cache (720p)");
    expect(mark?.getAttribute('title')).toBe("Playing from this machine's cache (720p)");
    expect(window.notesdStream?.cached).toEqual(cached);
    act(() => root?.unmount());
    host?.remove();
    const plain = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) }).fetchImpl, createEngine: fakeEngines().createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    expect(plain.querySelector('.st-cached')).toBeNull();
  });

  it('names a downloading cache in words', () => {
    expect(cachedLabel({ id: 'c1', state: 'downloading', height: 1080 })).toBe("Playing from this machine's cache while it downloads (1080p)");
    expect(cachedLabel({ id: 'c1', state: 'ready', height: null })).toBe("Playing from this machine's cache");
  });
```
**Check:** `npx vitest run web/src/stream` passes.

### Step 12: Route reference
**File:** `scripts/docs/httpRoutes.ts:223-232` (the `Direct streaming` group)
- `'POST /api/stream/play'`: append to its text, before ` Same-origin only.`:
  `When this machine has a cache of the title (\`ready\` or \`downloading\`, made for its original language), the play comes from it and nothing is resolved: \`attempts\` is \`[]\` and \`session.cached\` names the cache. A failed cache, or one made on the other machine, is passed over.`
- `'GET /api/stream/sessions/:id'`: add `, cached` after `expires_at` in the field list, and append:
  ` \`cached\` is \`{id, state, height}\` when the session plays from this machine's stream cache (\`state\` \`ready\` or \`downloading\`), else null; then \`manifest_url\` and each subtitle \`url\` are the cache's file route (\`/api/stream/cache/<id>/f/...\`), not pass-through addresses.`
- `'POST /api/stream/sessions/:id/refresh'`: append before ` Same-origin only.`:
  `A session that plays from a cache reads the cache again: while it can still be played the session keeps it and nothing is resolved; once it is gone or failed the title is resolved and the session goes on through the pass-through.`
- `'POST /api/stream/sessions/:id/episode'`: append before ` Same-origin only.`: `A neighbour with a cache on this machine plays from it, as \`POST /api/stream/play\` does.`
- Add a new entry — in the group that holds phase 5's `/api/stream/cache` routes if it has its own group, else here after the `episode` entry:
```ts
      'POST /api/stream/cache/:id/play':
        '`{resume_s?}` (the body may be empty): play one stream cache by its id, as `POST /api/stream/play` plays a title from its cache: the player page opens full screen in the streaming Chrome and nothing is resolved. 200 `{ok: true, page_url, session, attempts: []}` with `session.cached` naming the cache. 404 `unknown_cache`; 404 `not_on_this_machine` with `host` for a cache made on the other machine; 409 `cache_failed` (its download failed); 409 `cache_language` (it was made for another language than the title\'s original); 502 `open_failed`. 400 `invalid_json` / `invalid_body`. Same-origin only.',
```
**Check:** `npm run docs:gen` then `npm run docs:check` passes; `docs/guide/reference/http-api.md` and `mcp-tools.md` changed only by the generator.

### Step 13: The guide
**File:** `docs/guide/streaming.md`
- New section, immediately after phase 5's stream-cache section (if phase 5 added none, before `### Direct streaming answers` at `:412`):
```markdown
### Playing from the cache

A play looks at this machine's stream cache first (`/direct-stream`, the Movies page's Play on the
Stream side and the player's previous and next buttons alike). When the film or episode has a
cache here that is `ready` or `downloading`, and it was made for the title's original language,
the session plays the local copy:

- **Ready.** No provider is asked and the resolver does not run, so the play starts at once and
  works with the internet down. `attempts` is empty, `session.cached` is
  `{id, state: "ready", height}`, and `manifest_url` and the subtitle addresses are the cache's
  file route (`/api/stream/cache/<id>/f/...`), not the pass-through. The player buffers as far as
  hls.js goes by itself (600 s, inside its 60 MB), where a stream through the pass-through stops at
  120 s; a `?muted=1` check keeps 30 s either way.
- **Downloading.** The same local playlist. A segment not on disk yet is fetched by the file route
  when the player reaches it, so a seek past the downloaded part still plays. The buffer stays at
  120 s.
- **Failed, or none.** The play resolves as it always did. A cache made on the other machine is
  never used here; `POST /api/stream/cache/<id>/play`, which plays one cache by its id, answers it
  with 404 `not_on_this_machine` and the `host` that holds it.
- **Original language only.** A cache keeps the audio track of the stream it was made from, and it
  plays only while the title's original language is the one its resolve was told. A cache made
  before the language was known, or for another one, is passed over and the title resolves.
- **The rest is as for any stream.** The resume position, the position reports, the stream on
  screen and the history are the same; the provider recorded is the one the cache was downloaded
  from. A refresh of a cached session reads the cache again and keeps playing it; once the cache
  is cleared or failed, the refresh resolves the title and the page goes on through the
  pass-through.
- **On the page.** A drive icon beside the title says the film plays from this machine's cache (a
  cloud with an arrow while it still downloads); its tooltip names the quality.
  `window.notesdStream.cached` holds the same.
- **In a stream bug report.** A ready cache makes no pass-through request, so the evidence log has
  no records of its segments (the cache's own downloads are not recorded there either). A snapshot's
  `session.json` names the cache in `source.cache` (`{id, state}`), with the cache's provider and no
  attempts or hosts; the page's log says `from cache <id> (<state>)`, and `/report-stream-bug`'s
  summary says the play came from the cache.
```
- In the `### Direct streaming answers` table add rows (skip `not_on_this_machine` if phase 5 added it):
```markdown
| `unknown_cache` | No stream cache has that id |
| `not_on_this_machine` | The cache was made on the other machine; its files are there. `host` names it |
| `cache_failed` | The cache's download failed; it cannot be played |
| `cache_language` | The cache was made for another language than the title's original |
```
- In `### The player`, after the **Audio.** bullet, add:
```markdown
- **From the cache.** A session on this machine's stream cache plays its local files, with a drive
  icon beside the title (see "Playing from the cache").
```
- In `## Where the code is`, after the `src/directStream/` row, add:
```markdown
| `src/directStream/cachePlay.ts`, `src/http/streamCachePlayApi.ts` | Playing from the stream cache: which cache may play, the session made from it, `POST /api/stream/cache/:id/play` |
```
**Impact:** docs only. No picture: `streaming.md` shows none, and the movies guide's pictures are of the owner's library, not the player page.

### Step 14: The `/direct-stream` skill
**File:** `claude/skills/direct-stream/SKILL.md`
- Frontmatter `description` (`:3`): before ` A question such as "can I stream Saltburn directly?"`, insert:
  ` Also use it to cache one on this laptop before watching it — "cache One Piece episode 790 first", "download the next episode so it doesn't lag", "is it cached?", "clear the cache of that one".`
- After `## Step 1b: no title was named` (before `## Step 2: play, or look`, `:96`), add:
```markdown
## Caching first

A slow connection or a far stream host makes a stream stutter or stop. The daemon can download one
film or episode to this laptop first, with `mcp__notes__direct_stream_cache` (its description names
the arguments). Work out the title as in step 1 first.

- **"cache X first", "download the next episode so it doesn't lag":** start a cache with the same
  title fields `direct_stream_play` takes, and a maximum height when the user named a quality ("in
  720p"). Say it is downloading, and that a play started now already plays from it.
- **"cache it and play it":** start the cache, then call `direct_stream_play`: the play uses the
  cache while it downloads.
- **"is it cached?", "how far is the download?":** ask for its status and say the state
  (`downloading` with its progress, `ready`, `failed` with why) and the quality. A cache made on the
  other laptop answers `available: false` here: say it is on the other laptop and cannot play here.
- **"clear the cache of X":** clear it. Nothing else removes a cache.

A play needs nothing extra: `direct_stream_play` uses this laptop's cache of the title by itself.
```
- In `## Step 3: answer`, at the end of the **`started: true`** bullet (`:116-121`), add:
  ` When \`play.session.cached\` is set, say it plays from this laptop's cache: \`ready\` (no provider was asked; it plays even offline) or \`downloading\` (a part not downloaded yet is fetched as it is reached). Name the provider from \`play.session.provider\`; \`attempts\` is empty.`
**Impact:** text only; `install.sh` already links the skill folder.

**File:** `claude/skills/report-stream-bug/SKILL.md` (phase 3's skill; reconciliation decision: the
"cache it first" advice lands with the tool it names). In the "## 2. Match the evidence" table, the
"What to do" cell of the `connection_slow` row, `A lower quality in the player's menu; another network`,
becomes:
```markdown
A lower quality in the player's menu; another network; or cache it first (`direct_stream_cache`, "cache it first" in `/direct-stream`) and play it from this laptop's disk
```
and that of the `host_slow` row, `A lower quality; another provider for this title`, becomes:
```markdown
A lower quality; another provider for this title; or cache it first (`direct_stream_cache`), which retries and refreshes the token while it downloads
```
No rule, threshold or fixture changes, so phase 3's tests are untouched.

**File:** `src/mcp/instructions.ts` — in the "Direct streaming." paragraph, insert before
` When direct_stream_play answers started: true,`:
```text
 direct_stream_cache downloads one film or episode to this machine first (action start, with the same title fields as direct_stream_play and an optional max_height), and answers status, list and clear; a play then comes from that cache by itself (play.session.cached), and a cache made on the other machine answers available: false. Call it only when the user asks to cache, download first, check or clear one ("cache One Piece episode 790 first", "is it cached?").
```
**Impact:** the server's MCP instructions change (no generated reference reads them); `npx vitest run tests/unit/mcp` passes.

### Step 15: Feature map and proof scripts
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` — before `## Gotchas` (`:218`), add:
```markdown
## Playing from the cache
- A play (`POST /api/stream/play`, `direct_stream_play`, the player's previous/next buttons) uses
  this host's stream cache of the title first: a `ready` cache plays its local playlist with no
  resolve (`attempts: []`, `session.cached.state: "ready"`, `manifest_url` under
  `/api/stream/cache/<id>/f/`); a `downloading` one plays the same playlist and the file route
  fetches missing segments on demand; a failed cache, a cache on the other machine, a cache made
  for another language or none resolves as before. `POST /api/stream/cache/:id/play` plays one
  cache by id; another machine's answers 404 `not_on_this_machine` with `host`. The page shows a
  drive icon beside the title (`.st-cached`, aria-label "Playing from this machine's cache ...")
  and `window.notesdStream.cached`. A refresh keeps a cache that can still play, else resolves.
- Logic: `npx vitest run tests/unit/directStream/cachePlay.test.ts web/src/stream tests/unit/mcp.directStreamTools.test.ts`.
- Throwaway daemon (`$V up --web --direct-stream`, note RUN and `DIRECT=`), in this order on one run:
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN ready`, then
  `DIRECT=<run>/direct $V ui RUN .claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs`
  (`CACHE PAGE PASS`, screenshot `cache-play-page`), then
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN downloading other-host`.
  The script makes a cache of TMDB movie 550 through `POST /api/stream/cache` (fake resolver,
  fixture host), sets the fake resolver to `no_source` to prove nothing resolves, and edits the
  run's `stream_caches` row with `verify.sh exec` for the downloading and other-host cases.
```
**File:** `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# cache-play.sh RUN [ready|downloading|other-host ...]: playing from the stream cache
# (STREAM_CACHE_AND_BUG_REPORT phase 6) on a `verify.sh up --direct-stream` run. Makes (or reuses) a
# cache of TMDB movie 550 through phase 5's POST /api/stream/cache, against the fake resolver and the
# fixture stream host, and waits for it to be ready. Then:
#   ready        the fake resolver is set to fail (no_source); a play answers 200 from the cache with no
#                resolve and one open, and its playlist and a segment come from disk (the fixture host
#                gets no request).
#   downloading  the cache's segment files are removed and its row set to downloading; a play answers
#                cached.state "downloading", and a segment the local playlist names is fetched on demand
#                (the fixture host gets a request) and answered 200.
#   other-host   the cache's row is moved to another host; POST /api/stream/cache/<id>/play answers 404
#                not_on_this_machine with that host, and a play of the title resolves as if there were
#                no cache (502 no_source, one more resolve).
# Stages run in the order given (default: all three). Ends with `cache-play: PASS (<stages>)`; the first
# failed check stops it with `cache-play: FAIL at <stage>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: cache-play.sh RUN [ready|downloading|other-host ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(ready downloading other-host); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "cache-play: $RUN was not started with --direct-stream" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
EV="$DIR/evidence"
STAGE=start
CODE=""
BODY=""
CID=""
FILM='{"kind":"movie","tmdb_id":550}'

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "cache-play $STAGE: $*"; }
fail() {
  echo "cache-play: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "cache-play FAIL at $STAGE: $*" || true
  exit 1
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME: GET as the player does (no Origin); headers and body saved as evidence; sets CODE.
get() {
  CODE="$(curl -sS -D "$EV/cache-$2.head" -o "$EV/cache-$2.body" -w '%{http_code}' "$URL$1")"
}
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
# calls_of VERB: how many times the fake resolver was run with that first argument (resolve, open).
calls_of() {
  if [ -f "$DIRECT/calls.jsonl" ]; then jq -r '.args[0]' "$DIRECT/calls.jsonl" | { grep -cx "$1" || true; }; else echo 0; fi
}
# first_segment PATH: the first media segment the local playlist at PATH names; a master playlist is
# followed to its first rendition. Prints nothing when the playlist names a remote address.
first_segment() {
  local path=$1 body line hops=0
  while :; do
    body="$(curl -sS "$URL$path")"
    line="$(grep -v '^#' <<<"$body" | grep -v '^[[:space:]]*$' | head -1 | tr -d '\r')"
    [ -n "$line" ] || return 0
    case "$line" in
      /*) ;;
      http:* | https:*) return 0 ;;
      *) line="${path%/*}/$line" ;;
    esac
    if grep -q '^#EXT-X-STREAM-INF' <<<"$body" && [ $hops -lt 2 ]; then
      path=$line
      hops=$((hops + 1))
      continue
    fi
    echo "$line"
    return 0
  done
}
# ensure_cache: CID of a ready cache of movie 550 on this run (phase 5's routes; either answer shape).
ensure_cache() {
  [ -z "$CID" ] || return 0
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/cache "$FILM"
  [[ $CODE == 20? ]] || fail "POST /api/stream/cache answered HTTP $CODE: $BODY"
  CID="$(jq -r '.cache.id // .id // empty' <<<"$BODY")"
  [ -n "$CID" ] || fail "POST /api/stream/cache named no cache id: $BODY"
  local state="" i
  for i in $(seq 1 60); do
    api GET "/api/stream/cache/$CID"
    state="$(jq -r '.cache.state // .state // empty' <<<"$BODY")"
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "the cache failed: $BODY"
    sleep 0.5
  done
  [ "$state" = ready ] || fail "the cache is [$state] after 30 s: $BODY"
  ok "cache $CID of movie 550 is ready"
}

stage_ready() {
  stage ready
  ensure_cache
  printf 'no_source\n' >"$DIRECT/mode"
  local resolves opens ups manifest seg
  resolves=$(calls_of resolve)
  opens=$(calls_of open)
  ups=$(upstream_count)
  api POST /api/stream/play "$FILM"
  [ "$CODE" = 200 ] || fail "a play of the cached film answered HTTP $CODE: $BODY"
  [ "$(jq -r '.session.cached.id' <<<"$BODY")" = "$CID" ] || fail "session.cached is not the cache: $(jq -c .session.cached <<<"$BODY")"
  [ "$(jq -r '.session.cached.state' <<<"$BODY")" = ready ] || fail "session.cached.state is not ready: $(jq -c .session.cached <<<"$BODY")"
  [ "$(jq -r '.attempts | length' <<<"$BODY")" = 0 ] || fail "the play carries resolver attempts: $(jq -c .attempts <<<"$BODY")"
  manifest="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $manifest == "/api/stream/cache/$CID/f/"* ]] || fail "manifest_url [$manifest] is not the cache's file route"
  [ "$(calls_of resolve)" = "$resolves" ] || fail "the play ran the resolver"
  [ "$(calls_of open)" = "$((opens + 1))" ] || fail "the play did not open exactly one player page"
  get "$manifest" ready-manifest
  [ "$CODE" = 200 ] || fail "the local playlist answered HTTP $CODE"
  seg="$(first_segment "$manifest")"
  [ -n "$seg" ] || fail "the local playlist $manifest names no local segment"
  get "$seg" ready-segment
  [ "$CODE" = 200 ] || fail "the segment $seg answered HTTP $CODE"
  [ "$(upstream_count)" = "$ups" ] || fail "playing from the ready cache reached the stream host"
  ok "a play of movie 550 came from ready cache $CID: no resolve (resolver set to no_source), one open, playlist and $seg from disk, the stream host untouched"
}

stage_downloading() {
  stage downloading
  ensure_cache
  local cdir removed ups manifest seg
  cdir="$(find "$DIR" -type d -name "$CID" -print -quit)"
  [ -n "$cdir" ] || fail "no folder named $CID under $DIR"
  removed="$(find "$cdir" -type f \( -name '*.ts' -o -name '*.m4s' \) -print -delete | wc -l | tr -d ' ')"
  [ "$removed" -gt 0 ] || fail "the cache folder $cdir holds no segment file"
  # completed_at goes with the state: phase 5's stream_caches_ready_check ties `ready` to completed_at.
  # verify.sh exec does not fail on an SQL error, so the change is read back.
  "$V" exec "$RUN" "update stream_caches set state = 'downloading', completed_at = null where id = '$CID'" >/dev/null
  "$V" exec "$RUN" "select state from stream_caches where id = '$CID'" 2>/dev/null | grep -qw downloading || fail "the row of $CID could not be set to downloading"
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/play "$FILM"
  [ "$CODE" = 200 ] || fail "a play of the downloading cache answered HTTP $CODE: $BODY"
  [ "$(jq -r '.session.cached.state' <<<"$BODY")" = downloading ] || fail "session.cached is $(jq -c .session.cached <<<"$BODY"), wanted state downloading"
  manifest="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $manifest == "/api/stream/cache/$CID/f/"* ]] || fail "manifest_url [$manifest] is not the cache's file route"
  ups=$(upstream_count)
  seg="$(first_segment "$manifest")"
  [ -n "$seg" ] || fail "the local playlist $manifest names no local segment"
  get "$seg" missing-segment
  [ "$CODE" = 200 ] || fail "the segment $seg, not on disk, answered HTTP $CODE (it should be fetched on demand)"
  [ "$(upstream_count)" -gt "$ups" ] || fail "the missing segment was not fetched from the stream host"
  ok "a play of the downloading cache $CID used its local playlist; $seg ($removed segment files removed) was fetched on demand and answered 200"
}

stage_other_host() {
  stage other-host
  ensure_cache
  local resolves
  "$V" exec "$RUN" "update stream_caches set host = 'notesd-other-host' where id = '$CID'" >/dev/null
  api POST "/api/stream/cache/$CID/play" '{}'
  [ "$CODE" = 404 ] || fail "playing the other machine's cache answered HTTP $CODE: $BODY"
  [ "$(jq -r .error <<<"$BODY")" = not_on_this_machine ] || fail "the answer is not not_on_this_machine: $BODY"
  [ "$(jq -r .host <<<"$BODY")" = notesd-other-host ] || fail "the answer does not name the host: $BODY"
  printf 'no_source\n' >"$DIRECT/mode"
  resolves=$(calls_of resolve)
  api POST /api/stream/play "$FILM"
  { [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ]; } || fail "a play with only the other machine's cache answered HTTP $CODE: $BODY (wanted 502 no_source: the cache ignored, the title resolved)"
  [ "$(calls_of resolve)" = "$((resolves + 1))" ] || fail "the play did not resolve the title"
  ok "the other machine's cache answered 404 not_on_this_machine (host notesd-other-host); a play of the title ignored it and resolved"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    ready) stage_ready ;;
    downloading) stage_downloading ;;
    other-host) stage_other_host ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "cache-play: PASS (${WANTED[*]})"
"$V" note "$RUN" "cache-play: PASS (${WANTED[*]})"
```
**File:** `.claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs` (new)
```js
// Playing from the stream cache in the real player page, on a `verify.sh up --web --direct-stream` run
// (STREAM_CACHE_AND_BUG_REPORT phase 6). Needs a ready cache of TMDB movie 550: run
// `scripts/direct-stream/cache-play.sh RUN ready` first. The fake resolver is set to fail, a play starts
// from the cache, and the page is opened at its address (muted, as the playback checks are):
//   DIRECT=<run>/direct verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs
// Logs "CACHE PAGE PASS" when the page names the cache on window.notesdStream, shows the cache mark beside
// the title, fetched the cache's playlist and at least one segment from the cache's file route, and made no
// request through the pass-through. The first failed check throws.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

function check(ok, what) {
  if (!ok) throw new Error(what)
}

export default async ({ page, base, shot, log }) => {
  const direct = process.env.DIRECT
  check(direct, 'DIRECT=<run>/direct is not set')
  writeFileSync(path.join(direct, 'mode'), 'no_source\n')
  const res = await fetch(`${base}/api/stream/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ kind: 'movie', tmdb_id: 550 }),
  })
  const played = await res.json().catch(() => null)
  check(res.status === 200, `play answered ${res.status}: ${JSON.stringify(played)}`)
  const cached = played.session.cached
  check(cached !== null && cached.state === 'ready', `the play is not from a ready cache: ${JSON.stringify(cached)} (run cache-play.sh RUN ready first)`)
  const local = []
  const through = []
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname.startsWith(`/api/stream/cache/${cached.id}/f/`)) local.push(u.pathname)
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) through.push(u.pathname + u.search)
  })
  await page.goto(`${base}/stream/${played.session.session_id}?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.cached != null, null, { timeout: 15_000 })
  const state = await page.evaluate(() => window.notesdStream.cached)
  check(state.id === cached.id && state.state === 'ready', `window.notesdStream.cached is ${JSON.stringify(state)}`)
  const mark = page.locator('.st-top .st-cached')
  await mark.waitFor({ timeout: 15_000 })
  const label = await mark.getAttribute('aria-label')
  check(label !== null && label.startsWith("Playing from this machine's cache") && !label.includes('while it downloads'), `the mark reads "${label}"`)
  const until = Date.now() + 15_000
  const segment = () => local.some((p) => !p.endsWith('.m3u8') && !p.endsWith('.vtt'))
  while (!segment() && Date.now() < until) await page.waitForTimeout(250)
  check(local.some((p) => p.endsWith('.m3u8')), `the page fetched no playlist from the cache: ${local.join(' ')}`)
  check(segment(), `the page fetched no segment from the cache: ${local.join(' ')}`)
  check(through.length === 0, `the page went through the pass-through: ${through.join(' ')}`)
  await page.locator('.st-stage').hover()
  await shot('cache-play-page')
  log(`CACHE PAGE PASS: cache ${cached.id} on window.notesdStream, mark "${label}", ${local.length} requests to the cache's file route, none through the pass-through`)
}
```
**Impact:** proof only; nothing in the daemon reads these files.

## Principles applied

- Laziness protocol: `direct_stream_find` is left unchanged — "is it cached?" is answered by phase 5's `direct_stream_cache` status, so a second "cached" field in find would be a duplicate surface. `resolve()` keeps always resolving; the cache is looked up only in `play` / `switchEpisode`, so `subtitleText` (dialogue) needs no cache branch.
- Make illegal states unrepresentable: `SessionCache.state` is `'downloading' | 'ready'` (a failed cache cannot be in a session), and `playable()` returns a union whose ok branch is the only way to get a `SessionCache`. `SessionInfo.cached` is null exactly when the addresses are pass-through ones. A cached session's stand-in source has a relative manifest, so `allowedHosts` is empty and the pass-through cannot fetch anything for it.
- Boundary discipline: phase 5 is reached through one interface (`PlayableCaches`) checked by the typechecker at one wiring line; the cache id is validated once in `playCache` (`CACHE_ID_PATTERN`) and the body once in the route; the page parses `cached` once in `parseSession`.
- Prove it works: the Proof drives the real daemon (fake resolver set to `no_source` so a resolve would fail the journey, the fixture host's request log as the "no network" witness) and the real page in Chromium, not only unit tests.
- Test behavior, not implementation: the server tests go through the HTTP routes and count resolver runs and page opens; the web tests read the engine request and the rendered mark, not private calls.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npx vitest run tests/unit/directStream/cachePlay.test.ts tests/unit/mcp.directStreamTools.test.ts web/src/stream && npm test && npm run test:int && npm run docs:check`
**Proof:** the real daemon from this checkout plays a cached film with no resolve, plays a half-downloaded cache with on-demand fetches, and refuses the other machine's cache; the real player page plays the local files and shows the mark.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`; `$V up --web --direct-stream`, note `RUN` and `DIRECT=`). Run J1, J2, J3, J4 in that order on that one run.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Playing from the cache", and its neighbours "Play" / pass-through for the neighbour check)
- Journeys:
  - **J1** · traces R1.4 — `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN ready` → passes when it prints `cache-play: PASS (ready)`: with the fake resolver set to `no_source`, `POST /api/stream/play {"kind":"movie","tmdb_id":550}` answered 200 with `session.cached` `{id: <cache>, state: "ready"}`, `attempts: []` and `manifest_url` under `/api/stream/cache/<id>/f/`; `<run>/direct/calls.jsonl` gained one `open` and no `resolve`; the local playlist and its first segment answered 200 and `<run>/direct/upstream.jsonl` did not grow.
  - **J2** · traces R1.4 — `DIRECT=<run>/direct $V ui RUN .claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs` → passes when the transcript has `CACHE PAGE PASS`: the page's `window.notesdStream.cached.state` is `ready`, `.st-top .st-cached` has aria-label starting "Playing from this machine's cache", the page fetched a `.m3u8` and a segment from `/api/stream/cache/<id>/f/` and made zero `/api/stream/sessions/<id>/p` requests; screenshot `cache-play-page` in the evidence folder.
  - **J3** · traces R1.4 — `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN downloading` → passes when it prints `cache-play: PASS (downloading)`: after the cache's segment files were deleted and its row set to `downloading`, a play answered `session.cached.state: "downloading"` with the local `manifest_url`, and a segment the local playlist names (not on disk) answered 200 while `upstream.jsonl` grew (fetched on demand).
  - **J4** · traces R1.4, R1.5 — `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN other-host` → passes when it prints `cache-play: PASS (other-host)`: after the row's host became `notesd-other-host`, `POST /api/stream/cache/<id>/play` answered 404 `{"error":"not_on_this_machine","host":"notesd-other-host"}`, and `POST /api/stream/play` for the title answered 502 `no_source` with one more `resolve` in `calls.jsonl` (the other machine's cache was ignored).
  - **J5** · traces R1.4 — `npx vitest run tests/unit/directStream/cachePlay.test.ts` → passes when its 7 tests pass (refresh keeps a cache then resolves once it is gone; the next/previous buttons play a neighbour's cache; a cache for another language or unreadable lookup resolves; a failed cache answers 409 `cache_failed`).
- Neighbor check: uncached plays must not change. On a separate fresh `$V up --web --direct-stream` run, `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN seed hls dash refuse` prints `journey: PASS (seed hls dash refuse)`; and on a `$V up --web` run, `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` (with `FIX` from `make-hls-fixture.sh`) still logs `J3 PASS` and `MUTED PASS` (the 30 s cap under `?muted=1`).
- Cost: none (no LLM, no real provider, no Windows Chrome: the fake resolver records `open`).
**Exit criteria:** with a `ready` cache and a resolver that would fail, a play starts and the page plays local files (J1, J2); with a half-downloaded cache a missing segment is fetched and played (J3); the other machine's cache is refused by id and ignored by title (J4); without a cache the existing journeys pass unchanged (neighbour check).

## Handoffs

- **Phase 5 (reconciled):** `StreamCache.player()` → `{ find(ref), get(id) }` answering `CachePlayData` = `CachePlayView`, wired as `caches: () => deps.streamCache?.player() ?? null`; local files `master.m3u8` / `subtitle.vtt` under `/api/stream/cache/<id>/f/`; `CACHE_ID_PATTERN` from `src/directStream/cache/types.ts`. Phase 5's plan states the two file-route behaviours J3 needs: a `downloading` row with no download running in this process gets one started (`launchNow`) and the file is fetched on demand; a refused on-demand fetch that a fresh resolve cannot cure answers 502 `upstream_error`, never a forwarded 401/403/410 with `X-Notesd-Upstream` (phase 2's recovery retries the 502).
- **R1.5 (reconciled):** the "a play from it" part of R1.5 is owned here: J4 traces R1.4 and R1.5 (`POST /api/stream/cache/:id/play` → 404 `not_on_this_machine` with `host`). Phase 5 keeps the listing, files and delete parts.
- **Phase 5:** may already add `not_on_this_machine` to the guide's answers table; keep one row.
- **Phase 1 (snapshot), reconciled:** this phase adds `cache` `{id, state}` to phase 1's `SessionSource` (Step 3 (i)) and writes the `created` session record for a session made from a cache (`sessionFromCache`), so a snapshot of a cached play names the cache. The page's posted log also carries `from cache <id8> (<state>)`. The cache's own downloads are not recorded in the evidence log (phase 5's decision, recorded in the index).
- **Phase 3 (report skill), reconciled:** this phase writes the "cache it first" advice into the `connection_slow` / `host_slow` rows of `claude/skills/report-stream-bug/SKILL.md` (Step 14). Phase 3's `diagnose.mjs` already prints `source.cache`. A known-causes row for a failure while playing from a cache is not written (no evidence of such a failure yet); `new` covers it.
- **Phase 2, reconciled:** one buffer setting: phase 2's `EngineRequest.bufferAheadS` with `BUFFER_AHEAD_S` / `MUTED_BUFFER_AHEAD_S`; this phase adds only `CACHED_BUFFER_AHEAD_S` (600) and the choice in `attach`.
- **Later (out of scope):** `direct_stream_dialogue` could read a cache's WebVTT instead of resolving; the Movies page's cache and clear buttons (index: out of scope).

## Rollback

Revert this phase's commits. Nothing in the database or on disk is written by this phase (it only reads phase 5's caches), so a revert leaves caches in place and plays go back to always resolving. The two proof scripts and the feature-map entry go with the revert; run `npm run docs:gen` after reverting so the generated references drop the route and the tool text.

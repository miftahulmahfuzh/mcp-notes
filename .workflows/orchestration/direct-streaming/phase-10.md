# Phase 10: Candidates and the background prober, behind a setting

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R6 — "background prober after", behind a setting (D5: about 300 verified titles re-checked within 7 days, tuned from real timings; D6: out-of-sight tabs only while the laptop is idle)
**Criteria:** R6.1, R6.2, R6.3
**Depends on:** Phase 2, Phase 5 (and, through them, phases 1 and 3)
**Difficulty:** HARD
**Package:** `src/directStream`

---

## Goal

With `NOTESD_STREAM_PROBER=on`, the daemon fills and keeps the Stream catalog by itself: once a day
it lists candidates from TMDB (trending, popular, the owner's genres, and recommendations for what
the owner finished and rated highly), and each pass, only while Windows has had no input for
`NOTESD_STREAM_IDLE_SECONDS` and nothing plays, it re-checks the verified sources nearest the end
of their freshness window, then resolves new candidates until `NOTESD_STREAM_CATALOG_SIZE` titles
are fresh, inside a budget of probes and seconds. Unset or `off` (the default), nothing is built
that could open a tab, and `GET /api/stream/prober` says why it is off.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `TmdbCatalog`, `TmdbGenre`, `TmdbListName`, `DISCOVER_MIN_VOTES` (`src/movies/tmdb.ts`); `createTmdbClient` now returns `TmdbClient & TmdbCatalog`. `TmdbClient` itself is unchanged, so every existing fake of it stays valid.
- Config (`src/config.ts`): `StreamProberConfig`, `DEFAULT_STREAM_PROBER_CONFIG`, `ProbeTimings`, `SPIKE_PROBE_TIMINGS`, `DEFAULT_PROBE_TIMINGS`, `DEFAULT_STREAM_PROBE_MS` (1200000), `DEFAULT_STREAM_CATALOG_SIZE` (300), `DEFAULT_STREAM_IDLE_SECONDS` (600), `probePassSeconds`, `probeSecondsPerTitle`, `defaultProbeBudget`, `parseStreamProber`; field `DirectStreamConfig.prober: StreamProberConfig`. Env vars `NOTESD_STREAM_PROBER` (default off), `NOTESD_STREAM_CATALOG_SIZE`, `NOTESD_STREAM_PROBE_BUDGET`, `NOTESD_STREAM_IDLE_SECONDS`, `NOTESD_STREAM_PROBE_MS`.
- Table `stream_probe_titles` (`src/db/schema.ts` `streamProbeTitles`, `STREAM_PROBE_LIST_SOURCES`, `STREAM_PROBE_OUTCOMES`, `StreamProbeTitleRow`) and migration `drizzle/0022_stream_probe.sql` (+ `drizzle/meta`).
- `ProbeRepo` class appended to `src/directStream/repo.ts` (the only writer of `stream_probe_titles`; reads `movie_stream_sources`, `movie_plays`, `movie_titles`).
- `src/directStream/idle.ts`: `IDLE_SCRIPT`, `parseIdleOutput`, `powershellIdleReader`, `detectIdleReader`, `IdleReader`, `IdleReading`, `IdleDetection`, `IdleOffReason`.
- `src/directStream/candidates.ts`: `SeedTitle`, `ListedCandidate`, `pickSeeds`, `topGenres`, `roundRobin`, `released`, `rankKind`, `gatherCandidates`, constants.
- `src/directStream/prober.ts`: `StreamProber`, `DisabledProber`, `StreamProberHandle`, `ProberStatus`, `PassSummary`, `PassStop`, `ProberOffReason`, `ProbeStore`, `ProbeTarget`, `ProbeRef`, `ProbeRecord`, `ProbeOutcome`, `classifyResolve`, `retryAfter`, `interleave`, `passLine`, `libraryFinishedTitles`, `buildStreamProber`.
- `AppDeps.streamProber?: StreamProberHandle | null` (`src/deps.ts`).
- Route `GET /api/stream/prober` (`src/http/streamProberApi.ts`, `streamProberRoutes`), mounted in `src/http/app.ts`.
- `verify.sh up --direct-stream --prober` / `--prober=off` (on top of phase 3's `--direct-stream`); the fake TMDB serves trending, popular, genre lists, discover and recommendations.

**Signature changes:** `createTmdbClient(config, fetchImpl?, options?): TmdbClient` -> `...: TmdbClient & TmdbCatalog` (a widening; callers unaffected).

**Requires (from earlier phases):**
- Phase 3, `src/config.ts`: `Config.directStream?: DirectStreamConfig` with `{ enabled: boolean; freshDays: number; cli: string }`, `DEFAULT_DIRECT_STREAM_CONFIG`, and `parseDirectStream(env)`, which `loadConfig` calls. This phase adds `prober` to all three, and the `prober` key to phase 3's direct-streaming test in `tests/unit/config.test.ts`.
- Phase 3, `AppDeps.directStream?: DirectStreamService | null` with `resolve(input: StreamRefInput, options?: { resumeS?: number | null; deadlineS?: number }): Promise<StreamSession>`. A failure rejects with `DirectStreamError`: `code` `no_source` (the title has no source; phase 5's hook has marked it stale), or `resolve_failed` with `reason` (`no_chrome`, `chrome_not_reachable`, `script_failed`, `bad_output`, or `deadline` when `deadlineS` cut the resolve short). The prober passes the seconds left in its pass as `deadlineS` (phase 1's `--deadline-s`). `resolve()` awaits phase 5's `recordResolve` hook before it answers; it also makes an in-memory session the prober never uses (phase 3 caps and expires them). Resolving shows no window and plays no sound (invariant 7).
- Phase 3: `src/directStream/repo.ts` exists. This phase appends a separate `ProbeRepo` class to it and does not touch phase 3's class.
- Phase 3: migration `0020`, `stream_provider_health` (read only by the Proof, never by code here); the "Direct streaming" section of `docs/guide/streaming.md`, its configuration rows, its group in `scripts/docs/httpRoutes.ts`, its row in the architecture data model, and `.claude/skills/verify-notesd/features/direct-streaming.md` with its README row.
- Phase 5: migration `0021` with `movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure, updated_at)` (`failure` is set exactly when `stale_at` is), where a film uses season 0, episode 0; `DirectStreamService.resolve` records `verified` / `stale` and ensures the `movie_titles` row on every resolve, through phase 5's hooks. The prober relies on these hooks for all its `movie_*` effects and writes no `movie_*` row itself.
- Phase 5, `src/movies/repo.ts`: the one freshness rule, `freshStreamSourceSql(host, since)` (an `exists` condition inside a query over `movie_titles`), `isFreshStreamSource(row, host, since)` and `streamFreshSince(now, freshDays)`. `ProbeRepo` and the prober use these and define no freshness rule of their own.
- Phase 5: a stream play is a `movie_plays` row on this host with `ended_at` null while it is open and `updated_at` refreshed by every position post (the same as `MoviesRepo.updatePlay` does for VLC).
- Phase 2: `docs/plans/2026-11-15-direct-streaming-findings.md` holds the `campaign:timings` block (between `<!-- campaign:timings:begin -->` and `<!-- campaign:timings:end -->`), a fenced ```json object in phase 2's schema 1, which is the contract: `resolve_s: { n, p50, p90, max }`, `fail_s: { n, p50, p90, max }`, `providers.<name>.{ median_s, fail_median_s, ... }`, `token_lifetime`. This phase reads `resolve_s.p50` as its median resolve seconds and `fail_s.p50` as its median failure seconds; the block has no "failed attempts before the one that resolved" figure, so that one stays the spike's 1. `tests/unit/directStream/proberDefaults.test.ts` fails if there is no such block at all.

**Leaves alone (owned by others):** `web/` (phases 4, 9), MCP tools and `src/chat/*` (phases 7, 8), `claude/streaming/direct/*` (1, 2, 6, 8), phase 3's `DirectStreamRepo` and `DirectStreamService` bodies, `src/movies/{repo,state,read,types}.ts` (phase 5; read through `listTitles` only), `src/http/directStreamApi.ts` (3, 5), `docs/guide/movies.md` (5, 9).

**Decisions this phase makes (stated for the reconciler):**
- Candidate and backoff state lives in a **table**, `stream_probe_titles`, per host, not in `app_settings`. `app_settings` is shared by both machines, and probing and backoff are per host (invariant 5). The table also changes on every probe, and about 600 rows would be one JSON value rewritten whole each time.
- "Related to what the owner watched" means **TMDB recommendations** (`/{kind}/{id}/recommendations`) for up to 20 seed titles. A seed is a title `listTitles` reports as `finished` (so watch state still comes only from `state.ts`): the ones rated 4-5 first, then unrated ones by newest finish. A finished title rated 0-3 is not a seed. "By genre" means TMDB discover over the 3 genres most common among those seeds.
- The candidate listing is refreshed at most once a day, before the idle gate, because TMDB requests open no tab, show nothing and make no sound. Probes alone are gated.
- "Films first": new candidates are probed in film order, with one series slot in every four when a series is eligible (`SERIES_EVERY = 4`). Pure "all films first" would never reach a series at a 300 catalog. A series is verified by S1E1.
- An idle time that cannot be read counts as **not idle** (fail closed).
- Migration number `0022`. The reconciler renumbers if another phase also claims it.

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/tmdb.ts` | modify | `TmdbCatalog` list calls (trending, popular, genre list, discover, recommendations) |
| `src/config.ts` | modify | `StreamProberConfig`, timings, budget rule, `parseStreamProber`; `prober` in phase 3's `directStream` block |
| `src/db/schema.ts` | modify | `stream_probe_titles` table |
| `drizzle/0022_stream_probe.sql`, `drizzle/meta/*` | create (generated) | the table |
| `src/directStream/repo.ts` | modify | append `ProbeRepo` |
| `src/directStream/idle.ts` | create | Windows last-input time through `powershell.exe` |
| `src/directStream/candidates.ts` | create | seeds, ranking, TMDB gathering |
| `src/directStream/prober.ts` | create | the loop, passes, status, factory |
| `src/deps.ts` | modify | `streamProber` field |
| `src/daemon.ts` | modify | build the prober |
| `src/background.ts` | modify | start, log line, close |
| `src/http/streamProberApi.ts` | create | `GET /api/stream/prober` |
| `src/http/app.ts` | modify | mount it |
| `scripts/docs/httpRoutes.ts` | modify | describe the route |
| `docs/guide/reference/http-api.md` | regenerated | `npm run docs:gen` |
| `docs/guide/reference/configuration.md` | modify | five rows |
| `docs/guide/streaming.md` | modify | "The prober" subsection under "Direct streaming" |
| `docs/guide/architecture.md` | modify | background jobs row, data model, wiring |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | `--prober`, the prober pinned off by default, the fake `powershell.exe` reports idle time |
| `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs` | modify | list endpoints |
| `.claude/skills/verify-notesd/SKILL.md` | modify | `--prober` line and gotcha |
| `.claude/skills/verify-notesd/features/direct-streaming.md`, `features/README.md` | modify | the prober sub-feature |
| `tests/unit/movies/tmdb.lists.test.ts` | create | list calls |
| `tests/unit/config.streamProber.test.ts` | create | settings |
| `tests/unit/config.test.ts` | modify | phase 3's direct-streaming test expects `prober: DEFAULT_STREAM_PROBER_CONFIG` |
| `tests/unit/directStream/idle.test.ts` | create | detection and parsing |
| `tests/unit/directStream/candidates.test.ts` | create | seeds, ranking, gathering |
| `tests/unit/directStream/prober.test.ts` | create | R6.1 to R6.3 with a fake clock, idle, TMDB and resolver |
| `tests/unit/directStream/proberDefaults.test.ts` | create | defaults vs the findings' timings |
| `tests/unit/directStream/proberRoute.test.ts` | create | the status route |
| `tests/integration/streamProber.int.test.ts` | create | `ProbeRepo` SQL against Postgres |

## Implementation Steps

### Step 1: TMDB list calls
**File:** `src/movies/tmdb.ts` (types after `TmdbClient`, line 82; schema after `PersonSearchSchema`, line 238; helpers after `searchHit`, line 465; methods inside the object `createTmdbClient` returns, after `personCredits`, line 729; return type at line 495)
**Change:** add a separate `TmdbCatalog` interface and its four methods. `createTmdbClient` returns `TmdbClient & TmdbCatalog`. `TmdbClient` is not widened, so `fakeTmdb()` in `tests/integration/helpers/moviesSeed.ts` and the fakes in `tests/unit/movies/match.test.ts` need no change.
**Code:**

After the `TmdbClient` interface (line 82):
```ts
/** A TMDB genre (`/genre/{kind}/list`): its id, which discover takes, and its English name. */
export interface TmdbGenre {
  id: number;
  name: string;
}

/** The ready-made TMDB lists `TmdbCatalog.list` reads. */
export type TmdbListName = 'trending' | 'popular';

/** Discover keeps titles with at least this many votes, so obscure titles that no provider carries stay out. */
export const DISCOVER_MIN_VOTES = 100;

/**
 * Lists of titles for the direct-streaming prober's candidates (src/directStream/candidates.ts).
 * Each call reads one page (TMDB pages hold 20 titles). Kept apart from TmdbClient, so the
 * library's fakes of TmdbClient stay valid; createTmdbClient returns both.
 */
export interface TmdbCatalog {
  /** `trending`: this week's trending titles of `kind`; `popular`: TMDB's popular list. */
  list(name: TmdbListName, kind: TitleKind, page?: number): Promise<TmdbSearchHit[]>;
  /** TMDB's genres for `kind`. */
  genres(kind: TitleKind): Promise<TmdbGenre[]>;
  /** The most popular titles of one genre with at least DISCOVER_MIN_VOTES votes. */
  discoverByGenre(kind: TitleKind, genreId: number, page?: number): Promise<TmdbSearchHit[]>;
  /** TMDB's recommendations for one title. A title TMDB does not know (404) answers []. */
  recommendations(kind: TitleKind, tmdbId: number, page?: number): Promise<TmdbSearchHit[]>;
}
```

After `PersonSearchSchema` (line 238):
```ts
const GenreListSchema = z.object({ genres: z.array(z.object({ id: intId, name: z.string() })).nullish() });
```

After `searchHit` (line 465):
```ts
function movieHits(raw: z.infer<typeof MovieSearchSchema>): TmdbSearchHit[] {
  return (raw.results ?? []).map((r) =>
    searchHit('movie', {
      id: r.id,
      title: r.title,
      original: r.original_title,
      date: r.release_date,
      overview: r.overview,
      poster: r.poster_path,
      popularity: r.popularity,
    }),
  );
}

function tvHits(raw: z.infer<typeof TvSearchSchema>): TmdbSearchHit[] {
  return (raw.results ?? []).map((r) =>
    searchHit('tv', {
      id: r.id,
      title: r.name,
      original: r.original_name,
      date: r.first_air_date,
      overview: r.overview,
      poster: r.poster_path,
      popularity: r.popularity,
    }),
  );
}

/** A page of titles of `kind` (trending, popular, discover, recommendations share the search shape). */
function hitsOf(kind: TitleKind, json: unknown, what: string): TmdbSearchHit[] {
  return kind === 'movie' ? movieHits(decode(MovieSearchSchema, json, what)) : tvHits(decode(TvSearchSchema, json, what));
}
```

Line 491-495, the signature becomes:
```ts
export function createTmdbClient(
  config: TmdbClientConfig,
  fetchImpl: typeof fetch = fetch,
  options: TmdbClientOptions = {},
): TmdbClient & TmdbCatalog {
```

Inside the returned object, after `personCredits` (line 729, before the closing `};`):
```ts
    async list(name, kind, page = 1) {
      const path = name === 'trending' ? `/trending/${kind}/week` : `/${kind}/popular`;
      return hitsOf(kind, await get(path, { page }), `${kind} ${name} list`);
    },

    async genres(kind) {
      const raw = decode(GenreListSchema, await get(`/genre/${kind}/list`, {}), `${kind} genre list`);
      return (raw.genres ?? []).map((g) => ({ id: g.id, name: g.name }));
    },

    async discoverByGenre(kind, genreId, page = 1) {
      const json = await get(`/discover/${kind}`, {
        with_genres: genreId,
        sort_by: 'popularity.desc',
        'vote_count.gte': DISCOVER_MIN_VOTES,
        include_adult: false,
        page,
      });
      return hitsOf(kind, json, `${kind} discover genre ${genreId}`);
    },

    async recommendations(kind, tmdbId, page = 1) {
      const json = await getOrNull(`/${kind}/${tmdbId}/recommendations`, { page });
      return json === null ? [] : hitsOf(kind, json, `${kind} ${tmdbId} recommendations`);
    },
```
**Impact:** none on existing callers. `searchMovie` and `searchTv` keep their own inline mapping (see Handoffs).

### Step 2: the settings
**File:** `src/config.ts` (constants and types after `StreamingConfig`, line 118; `parseStreamProber` after `parseMovies`, line 563; phase 3's `DirectStreamConfig`, `DEFAULT_DIRECT_STREAM_CONFIG` and parser wherever phase 3 put them; the `loadConfig` doc comment, lines 565-586)
**Change:** the five settings, the timings the defaults come from, and the rule that derives the probe budget. The `const`s must come before `DEFAULT_STREAM_PROBER_CONFIG` in the file, because it calls `defaultProbeBudget` at module load.
**Code:**

After `StreamingConfig` (line 118):
```ts
/**
 * What one resolve costs. SPIKE_PROBE_TIMINGS are the spike's numbers (docs/plans/2026-11-15-
 * direct-streaming-design.md): about 3 s for a provider that resolves, 35 s for one that shows
 * nothing, and one such failure before the one that works.
 */
export interface ProbeTimings {
  /** Seconds from opening an embed to a captured manifest, median over resolved attempts. */
  median_resolve_s: number
  /** Seconds a provider that returns nothing costs before the resolver moves on, median. */
  median_fail_s: number
  /** Failed attempts before the one that resolved, median over titles that resolved. */
  median_failed_before_resolve: number
}

export const SPIKE_PROBE_TIMINGS: ProbeTimings = { median_resolve_s: 3, median_fail_s: 35, median_failed_before_resolve: 1 }

/**
 * The timings the prober defaults come from: the resolve campaign's timings block in
 * docs/plans/2026-11-15-direct-streaming-findings.md (phase 2), a spike number for any key the block
 * lacks. tests/unit/directStream/proberDefaults.test.ts fails when these drift from the block.
 */
export const DEFAULT_PROBE_TIMINGS: ProbeTimings = { median_resolve_s: 3, median_fail_s: 35, median_failed_before_resolve: 1 }

export const DEFAULT_STREAM_PROBE_MS = 1_200_000
export const DEFAULT_STREAM_CATALOG_SIZE = 300
export const DEFAULT_STREAM_IDLE_SECONDS = 600

/** A pass may spend half the pause between passes, so the laptop always rests at least as long as a pass ran. */
export function probePassSeconds(probeMs: number): number {
  return Math.max(1, Math.floor(probeMs / 2000))
}

/** One title's expected seconds: the failing providers tried before the one that resolves, then that one. */
export function probeSecondsPerTitle(t: ProbeTimings): number {
  return t.median_resolve_s + t.median_failed_before_resolve * t.median_fail_s
}

/** NOTESD_STREAM_PROBE_BUDGET's default: the titles that fit in one pass's seconds, at least one. */
export function defaultProbeBudget(probeMs: number, t: ProbeTimings = DEFAULT_PROBE_TIMINGS): number {
  return Math.max(1, Math.floor(probePassSeconds(probeMs) / probeSecondsPerTitle(t)))
}

/** The direct-streaming prober (src/directStream/prober.ts). */
export interface StreamProberConfig {
  /**
   * `NOTESD_STREAM_PROBER`, default OFF (unset or blank is off). `on` lets the daemon open
   * out-of-sight tabs in the streaming Chrome by itself while the laptop is idle (D6).
   */
  enabled: boolean
  /** `NOTESD_STREAM_CATALOG_SIZE`, default 300: fresh verified titles on this host before new candidates stop. */
  catalogSize: number
  /** `NOTESD_STREAM_PROBE_BUDGET`: resolves per pass, re-checks included. Default defaultProbeBudget(probeMs). */
  probeBudget: number
  /** `NOTESD_STREAM_IDLE_SECONDS`, default 600: Windows input-free seconds before a probe may start. */
  idleSeconds: number
  /** `NOTESD_STREAM_PROBE_MS`, default 1200000: pause between passes; a pass spends at most half. */
  probeMs: number
}

/** Prober off, default limits. Tests build `Config` literals with it, so no hand-built config ever probes. */
export const DEFAULT_STREAM_PROBER_CONFIG: StreamProberConfig = {
  enabled: false,
  catalogSize: DEFAULT_STREAM_CATALOG_SIZE,
  probeBudget: defaultProbeBudget(DEFAULT_STREAM_PROBE_MS),
  idleSeconds: DEFAULT_STREAM_IDLE_SECONDS,
  probeMs: DEFAULT_STREAM_PROBE_MS,
}
```

After `parseMovies` (line 563):
```ts
/** A switch that is off when unset or blank; otherwise the same words as parseSwitch. */
function parseSwitchDefaultOff(name: string, raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '' ? false : parseSwitch(name, raw)
}

export function parseStreamProber(env: Record<string, string | undefined>): StreamProberConfig {
  const probeMs = parsePositiveInt('NOTESD_STREAM_PROBE_MS', env.NOTESD_STREAM_PROBE_MS, DEFAULT_STREAM_PROBE_MS)
  return {
    enabled: parseSwitchDefaultOff('NOTESD_STREAM_PROBER', env.NOTESD_STREAM_PROBER),
    catalogSize: parsePositiveInt('NOTESD_STREAM_CATALOG_SIZE', env.NOTESD_STREAM_CATALOG_SIZE, DEFAULT_STREAM_CATALOG_SIZE),
    probeBudget: parsePositiveInt('NOTESD_STREAM_PROBE_BUDGET', env.NOTESD_STREAM_PROBE_BUDGET, defaultProbeBudget(probeMs)),
    idleSeconds: parsePositiveInt('NOTESD_STREAM_IDLE_SECONDS', env.NOTESD_STREAM_IDLE_SECONDS, DEFAULT_STREAM_IDLE_SECONDS),
    probeMs,
  }
}
```

In phase 3's block (phase 3's Step 1: `DirectStreamConfig { enabled; freshDays; cli }`, `DEFAULT_DIRECT_STREAM_CONFIG`, `parseDirectStream`), add one field to each of the three. Phase 3's interface keeps its doc comments; after its `cli: string` member add:
```ts
  /** The background prober (phase 10). Off unless NOTESD_STREAM_PROBER=on. */
  prober: StreamProberConfig
```
`DEFAULT_DIRECT_STREAM_CONFIG` becomes `{ enabled: false, freshDays: DEFAULT_STREAM_FRESH_DAYS, cli: DEFAULT_DIRECT_STREAM_CLI, prober: DEFAULT_STREAM_PROBER_CONFIG }`, and `parseDirectStream(env)` returns `prober: parseStreamProber(env),` after its `cli: ...` line. Because `DEFAULT_DIRECT_STREAM_CONFIG` now reads `DEFAULT_STREAM_PROBER_CONFIG` at module load, this phase's constants block above (from `ProbeTimings` to `DEFAULT_STREAM_PROBER_CONFIG`) goes right after `StreamingConfig` and **before** phase 3's `export const DEFAULT_STREAM_FRESH_DAYS = 7` line; the parser functions may sit anywhere (they are hoisted).

`loadConfig`'s doc comment (lines 565-586): after the movies keys, add `Direct-streaming prober keys: NOTESD_STREAM_PROBER (default off), NOTESD_STREAM_CATALOG_SIZE, NOTESD_STREAM_PROBE_BUDGET, NOTESD_STREAM_IDLE_SECONDS, NOTESD_STREAM_PROBE_MS.`

When the real phase 2 block lands, set `DEFAULT_PROBE_TIMINGS` from it: `median_resolve_s` = `resolve_s.p50`, `median_fail_s` = `fail_s.p50`; `median_failed_before_resolve` keeps the spike's 1 (phase 2's schema has no such figure), as does any key the block leaves null. Step 16's `proberDefaults.test.ts` enforces this.
**Impact:** `Config.directStream.prober` exists. `tests/unit/config.test.ts` (phase 3's state): "applies defaults" uses `{ ...DEFAULT_DIRECT_STREAM_CONFIG, enabled: true }` and keeps passing; phase 3's test "reads the direct streaming switch, freshness window and resolver path" has
`expect(ds({})).toEqual({ enabled: true, freshDays: 7, cli: DEFAULT_DIRECT_STREAM_CLI });`, which becomes
`expect(ds({})).toEqual({ enabled: true, freshDays: 7, cli: DEFAULT_DIRECT_STREAM_CLI, prober: DEFAULT_STREAM_PROBER_CONFIG });`
(add `DEFAULT_STREAM_PROBER_CONFIG` to that file's import list).

### Step 3: the table
**File:** `src/db/schema.ts` (after phase 3's `stream_*` tables; the row type beside the other `$inferSelect` types near line 1246)
**Code:**
```ts
/** Where a prober candidate was listed (src/directStream/candidates.ts). The CHECK below keeps the same list. */
export const STREAM_PROBE_LIST_SOURCES = ['recommended', 'genre', 'trending', 'popular'] as const
export type StreamProbeListSource = (typeof STREAM_PROBE_LIST_SOURCES)[number]
/** What one prober resolve came to. */
export const STREAM_PROBE_OUTCOMES = ['verified', 'no_source', 'error'] as const
export type StreamProbeOutcome = (typeof STREAM_PROBE_OUTCOMES)[number]

/**
 * The direct-streaming prober's candidates and backoff, per host (migration 0022). Written only by
 * ProbeRepo in src/directStream/repo.ts. A row is listed (`list_source`, `list_rank`, `listed_at`
 * all set) while the newest TMDB listing holds the title, and unlisted (all three null) after.
 * `outcome`/`probed_at`/`failures`/`retry_after` are the last probe on this host: a failure sets
 * `retry_after`, and a title is not probed again before it. Verified sources themselves live in
 * phase 5's movie_stream_sources.
 */
export const streamProbeTitles = pgTable(
  'stream_probe_titles',
  {
    host: text('host').notNull(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    listSource: text('list_source').$type<StreamProbeListSource>(),
    listRank: integer('list_rank'),
    listedAt: timestamp('listed_at', { withTimezone: true, mode: 'date' }),
    probedAt: timestamp('probed_at', { withTimezone: true, mode: 'date' }),
    outcome: text('outcome').$type<StreamProbeOutcome>(),
    failures: integer('failures').notNull().default(0),
    retryAfter: timestamp('retry_after', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.host, t.kind, t.tmdbId] }),
    index('stream_probe_titles_listed_idx').on(t.host, t.kind, t.listRank),
    check('stream_probe_titles_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check('stream_probe_titles_tmdb_id_check', sql`${t.tmdbId} > 0`),
    check(
      'stream_probe_titles_source_check',
      sql`${t.listSource} is null or ${t.listSource} in ('recommended', 'genre', 'trending', 'popular')`,
    ),
    check(
      'stream_probe_titles_listed_check',
      sql`(${t.listSource} is null) = (${t.listRank} is null) and (${t.listSource} is null) = (${t.listedAt} is null)`,
    ),
    check(
      'stream_probe_titles_outcome_check',
      sql`(${t.outcome} is null) = (${t.probedAt} is null) and (${t.outcome} is null or ${t.outcome} in ('verified', 'no_source', 'error'))`,
    ),
    check(
      'stream_probe_titles_backoff_check',
      sql`${t.failures} >= 0 and (${t.outcome} is null or (${t.outcome} = 'verified' and ${t.failures} = 0 and ${t.retryAfter} is null) or (${t.outcome} <> 'verified' and ${t.failures} > 0 and ${t.retryAfter} is not null))`,
    ),
  ],
)
```
And beside the other row types:
```ts
export type StreamProbeTitleRow = typeof streamProbeTitles.$inferSelect
```
**Impact:** schema only. Migration in step 4.

### Step 4: the migration
**File:** `drizzle/0022_stream_probe.sql` and `drizzle/meta/_journal.json`, `drizzle/meta/0022_snapshot.json` (generated)
**Change:** generate it, never hand-write the snapshot. `drizzle.config.ts` refuses to run without a direct URL even for `generate`, which never connects, so pass a dummy one:
```sh
DATABASE_URL_UNPOOLED=postgres://gen@127.0.0.1:1/gen npm run db:generate -- --name stream_probe
```
The generated SQL must be this (drizzle's own formatting may differ in whitespace only):
```sql
CREATE TABLE "stream_probe_titles" (
	"host" text NOT NULL,
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"list_source" text,
	"list_rank" integer,
	"listed_at" timestamp with time zone,
	"probed_at" timestamp with time zone,
	"outcome" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	CONSTRAINT "stream_probe_titles_host_kind_tmdb_id_pk" PRIMARY KEY("host","kind","tmdb_id"),
	CONSTRAINT "stream_probe_titles_kind_check" CHECK ("stream_probe_titles"."kind" in ('movie', 'tv')),
	CONSTRAINT "stream_probe_titles_tmdb_id_check" CHECK ("stream_probe_titles"."tmdb_id" > 0),
	CONSTRAINT "stream_probe_titles_source_check" CHECK ("stream_probe_titles"."list_source" is null or "stream_probe_titles"."list_source" in ('recommended', 'genre', 'trending', 'popular')),
	CONSTRAINT "stream_probe_titles_listed_check" CHECK (("stream_probe_titles"."list_source" is null) = ("stream_probe_titles"."list_rank" is null) and ("stream_probe_titles"."list_source" is null) = ("stream_probe_titles"."listed_at" is null)),
	CONSTRAINT "stream_probe_titles_outcome_check" CHECK (("stream_probe_titles"."outcome" is null) = ("stream_probe_titles"."probed_at" is null) and ("stream_probe_titles"."outcome" is null or "stream_probe_titles"."outcome" in ('verified', 'no_source', 'error'))),
	CONSTRAINT "stream_probe_titles_backoff_check" CHECK ("stream_probe_titles"."failures" >= 0 and ("stream_probe_titles"."outcome" is null or ("stream_probe_titles"."outcome" = 'verified' and "stream_probe_titles"."failures" = 0 and "stream_probe_titles"."retry_after" is null) or ("stream_probe_titles"."outcome" <> 'verified' and "stream_probe_titles"."failures" > 0 and "stream_probe_titles"."retry_after" is not null)))
);
--> statement-breakpoint
CREATE INDEX "stream_probe_titles_listed_idx" ON "stream_probe_titles" USING btree ("host","kind","list_rank");
```
If the generated file holds any other statement, the snapshot of `0021` is out of step with `schema.ts`: stop and tell the reconciler.
**Impact:** adds one table. Rolling back the code leaves it harmless.

### Step 5: `ProbeRepo`
**File:** `src/directStream/repo.ts` (appended at the end; merge the imports into the file's import block)
**Change:** a separate class in phase 3's repo file, so invariant 4 holds at file level ("`src/directStream/repo.ts` is the only writer of `stream_*` tables") and phase 3's class is untouched. "Fresh" is phase 5's one rule, `freshStreamSourceSql` (an `exists` over `movie_stream_sources` inside a query over `movie_titles`; phase 5 clears `stale_at` when a resolve verifies a row again); this file defines none of its own. The re-check list reads phase 5's columns with raw SQL.
**Code:**
```ts
import { and, eq, gte, inArray, isNull, max, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { moviePlays, movieTitles, streamProbeTitles } from '../db/schema.js';
import { freshStreamSourceSql } from '../movies/repo.js';
import type { TitleKind } from '../movies/tmdb.js';
import type { ListedCandidate } from './candidates.js';
import type { ProbeRecord, ProbeStore, ProbeTarget } from './prober.js';

/** Rows per INSERT when a listing is written. */
const LISTING_CHUNK = 500;

function toTarget(kind: unknown, tmdbId: unknown, season: unknown, episode: unknown): ProbeTarget {
  const k: TitleKind = kind === 'tv' ? 'tv' : 'movie';
  return {
    kind: k,
    tmdbId: Number(tmdbId),
    season: k === 'tv' ? Number(season) : null,
    episode: k === 'tv' ? Number(episode) : null,
  };
}

/**
 * The direct-streaming prober's storage (phase 10): the only writer of stream_probe_titles, and
 * the prober's reads of movie_stream_sources, movie_plays and movie_titles (never their writer:
 * MoviesRepo is, through DirectStreamService.resolve's hooks).
 */
export class ProbeRepo implements ProbeStore {
  constructor(private readonly db: Db) {}

  /** Titles with a fresh source on `host` as of `since` (phase 5's freshStreamSourceSql), each counted once. */
  async freshCount(host: string, since: Date): Promise<number> {
    const res = await this.db.execute<{ n: number | string }>(
      sql`select count(*) as n from movie_titles where ${freshStreamSourceSql(host, since)}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Verified, not stale sources on `host` verified at or before `dueBefore`, oldest first: what a pass re-checks. */
  async dueRechecks(host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]> {
    const res = await this.db.execute<{ kind: string; tmdb_id: number; season: number; episode: number }>(sql`
      select t.kind, t.tmdb_id, s.season, s.episode
      from movie_stream_sources s
      join movie_titles t on t.id = s.title_id
      where s.host = ${host}
        and s.verified_at is not null
        and s.verified_at <= ${dueBefore}
        and s.stale_at is null
      order by s.verified_at asc, s.title_id asc, s.season asc, s.episode asc
      limit ${limit}`);
    return res.rows.map((r) => toTarget(r.kind, r.tmdb_id, r.season, r.episode));
  }

  /** When this host's candidate listing was last written; null before the first one. */
  async listedAt(host: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(streamProbeTitles.listedAt) })
      .from(streamProbeTitles)
      .where(eq(streamProbeTitles.host, host));
    return row?.at ?? null;
  }

  /**
   * Replaces this host's listing in one transaction: every title is unlisted, then `entries` are
   * listed with their ranks. Probe outcomes and backoff survive, also for titles that left the lists.
   * `entries` hold each (kind, tmdbId) once (rankKind dedupes).
   */
  async replaceListing(host: string, entries: readonly ListedCandidate[], at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(streamProbeTitles)
        .set({ listSource: null, listRank: null, listedAt: null })
        .where(eq(streamProbeTitles.host, host));
      for (let i = 0; i < entries.length; i += LISTING_CHUNK) {
        const chunk = entries.slice(i, i + LISTING_CHUNK);
        await tx
          .insert(streamProbeTitles)
          .values(chunk.map((e) => ({ host, kind: e.kind, tmdbId: e.tmdbId, listSource: e.source, listRank: e.rank, listedAt: at })))
          .onConflictDoUpdate({
            target: [streamProbeTitles.host, streamProbeTitles.kind, streamProbeTitles.tmdbId],
            set: {
              listSource: sql`excluded.list_source`,
              listRank: sql`excluded.list_rank`,
              listedAt: sql`excluded.listed_at`,
            },
          });
      }
    });
  }

  /**
   * Listed titles of `kind` the prober may probe now, best rank first: out of backoff, and with no
   * source on `host` that is fresh as of `freshSince` (never a title already verified fresh).
   */
  async eligible(host: string, kind: TitleKind, now: Date, freshSince: Date, limit: number): Promise<ProbeTarget[]> {
    const res = await this.db.execute<{ tmdb_id: number }>(sql`
      select c.tmdb_id
      from stream_probe_titles c
      where c.host = ${host}
        and c.kind = ${kind}
        and c.list_source is not null
        and (c.retry_after is null or c.retry_after <= ${now})
        and not exists (
          select 1 from movie_titles
          where movie_titles.id = c.kind || '-' || c.tmdb_id::text and ${freshStreamSourceSql(host, freshSince)}
        )
      order by c.list_rank asc
      limit ${limit}`);
    return res.rows.map((r) => ({ kind, tmdbId: Number(r.tmdb_id), season: null, episode: null }));
  }

  /** Failed probes in a row of one title on `host`; 0 when it was never probed. */
  async failures(host: string, kind: TitleKind, tmdbId: number): Promise<number> {
    const [row] = await this.db
      .select({ failures: streamProbeTitles.failures })
      .from(streamProbeTitles)
      .where(and(eq(streamProbeTitles.host, host), eq(streamProbeTitles.kind, kind), eq(streamProbeTitles.tmdbId, tmdbId)));
    return row?.failures ?? 0;
  }

  /** Writes one probe's outcome. A re-check of a title no list holds creates an unlisted row. */
  async record(host: string, r: ProbeRecord): Promise<void> {
    await this.db
      .insert(streamProbeTitles)
      .values({
        host,
        kind: r.kind,
        tmdbId: r.tmdbId,
        probedAt: r.probedAt,
        outcome: r.outcome,
        failures: r.failures,
        retryAfter: r.retryAfter,
      })
      .onConflictDoUpdate({
        target: [streamProbeTitles.host, streamProbeTitles.kind, streamProbeTitles.tmdbId],
        set: { probedAt: r.probedAt, outcome: r.outcome, failures: r.failures, retryAfter: r.retryAfter },
      });
  }

  /**
   * True when a play on `host` is open and was updated at or after `since`: the VLC notesd follows,
   * or a stream whose player page posts its position (phase 5 keeps both on movie_plays).
   */
  async activePlay(host: string, since: Date): Promise<boolean> {
    const rows = await this.db
      .select({ id: moviePlays.id })
      .from(moviePlays)
      .where(and(eq(moviePlays.host, host), isNull(moviePlays.endedAt), gte(moviePlays.updatedAt, since)))
      .limit(1);
    return rows.length > 0;
  }

  /** The TMDB genre names stored on these titles, by title id. */
  async titleGenres(ids: readonly string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: movieTitles.id, genres: movieTitles.genres })
      .from(movieTitles)
      .where(inArray(movieTitles.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.genres]));
  }
}
```
**Impact:** `import type` from `./prober.js` is erased at runtime, so the cycle with `prober.ts` importing `ProbeRepo` is type-only.

### Step 6: the idle check
**File:** `src/directStream/idle.ts` (new)
**Code:**
```ts
import { nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../http/reveal.js';
import { DEFAULT_POWERSHELL_EXE, POWERSHELL_ENV, resolveWindowsExe } from '../movies/vlc/health.js';
import { execCapture, type ExecFn } from '../movies/vlc/http.js';
import { lastJsonLine, powershellArgs } from '../movies/vlc/incidents.js';

/**
 * How long Windows has had no keyboard or mouse input, for the direct-streaming prober (D6: it
 * probes only while the laptop is idle). One powershell.exe run (NOTESD_POWERSHELL_EXE, the same
 * override the VLC code uses) calls user32 GetLastInputInfo. Outside WSL, or without powershell.exe,
 * there is no idle time to read and the prober stays off, saying why.
 */

export const IDLE_TIMEOUT_MS = 15_000;

export type IdleReading = { kind: 'ok'; idleSeconds: number } | { kind: 'error'; message: string };
export type IdleReader = () => Promise<IdleReading>;
export type IdleOffReason = 'not_linux' | 'no_interop' | 'no_powershell';
export type IdleDetection = { available: true; read: IdleReader } | { available: false; reason: IdleOffReason };

/**
 * Prints `{"idle_ms":N}`: milliseconds since the last input of the interactive session. The
 * subtraction is unsigned, so it stays right when the 32-bit tick count wraps (every 49.7 days).
 * N is -1 when GetLastInputInfo fails.
 */
export const IDLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class NotesdIdle {',
  '  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);',
  '  public static long IdleMs() {',
  '    LastInput info = new LastInput(); info.cbSize = (uint)Marshal.SizeOf(typeof(LastInput));',
  '    if (!GetLastInputInfo(ref info)) return -1;',
  '    return (long)unchecked((uint)Environment.TickCount - info.dwTime);',
  '  }',
  '}',
  '"@',
  '$ms = [NotesdIdle]::IdleMs()',
  '"{`"idle_ms`":$ms}"',
].join('\n');

/** Whole idle seconds from the script's last JSON line; null when it is not that line or N < 0. */
export function parseIdleOutput(stdout: string): number | null {
  const line = lastJsonLine(stdout);
  if (line === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const ms = (raw as { idle_ms?: unknown }).idle_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

/** The real reader. Never throws: a failed run is an `error` reading, which the prober treats as "not idle". */
export function powershellIdleReader(powershell: string, exec: ExecFn = execCapture): IdleReader {
  const args = powershellArgs(IDLE_SCRIPT);
  return async () => {
    const r = await exec(powershell, args, IDLE_TIMEOUT_MS);
    if (r.exitCode !== 0) return { kind: 'error', message: `powershell.exe exited ${r.exitCode}` };
    const idleSeconds = parseIdleOutput(r.stdout);
    return idleSeconds === null ? { kind: 'error', message: 'unreadable idle output' } : { kind: 'ok', idleSeconds };
  };
}

/** Linux + WSL interop + powershell.exe, or why not. Never throws. */
export async function detectIdleReader(probe: DetectProbe = nodeProbe(), exec: ExecFn = execCapture): Promise<IdleDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const powershell = await resolveWindowsExe(probe, POWERSHELL_ENV, DEFAULT_POWERSHELL_EXE);
  if (powershell === null) return { available: false, reason: 'no_powershell' };
  return { available: true, read: powershellIdleReader(powershell, exec) };
}
```
**Impact:** none. It reuses the VLC code's PowerShell plumbing (`resolveWindowsExe`, `powershellArgs`, `lastJsonLine`) instead of repeating it.

### Step 7: candidates
**File:** `src/directStream/candidates.ts` (new)
**Code:**
```ts
import type { StreamProbeListSource } from '../db/schema.js';
import { TmdbError, type TitleKind, type TmdbCatalog, type TmdbSearchHit } from '../movies/tmdb.js';

/**
 * Which TMDB titles the prober may try to verify, in what order (direct streaming phase 10). Pure
 * except gatherCandidates, which reads TMDB only. Nothing here opens Chrome.
 *
 * Sources, in the order each round of the merge takes from them: `recommended` (TMDB's
 * recommendations for the owner's finished, highly rated titles), `genre` (discover over the
 * owner's most common genres), `trending` (this week), `popular`. Films and series are ranked
 * separately; the prober interleaves them.
 */

export const CANDIDATE_SOURCE_ORDER: readonly StreamProbeListSource[] = ['recommended', 'genre', 'trending', 'popular'];
/** Seed titles whose recommendations are read. */
export const MAX_SEEDS = 20;
/** A finished title rated this or higher is a seed before any unrated one; rated lower, it is none. */
export const MIN_SEED_RATING = 4;
/** Genres discovered per kind. */
export const GENRES_PER_KIND = 3;
/** Pages of trending and of popular per kind (20 titles a page). */
export const LIST_PAGES = 2;
/** The listing is rebuilt at most this often. */
export const CANDIDATE_REFRESH_MS = 24 * 60 * 60_000;

export interface SeedTitle {
  kind: TitleKind;
  tmdbId: number;
  /** The owner's 0-5 rating; null when unrated. */
  rating: number | null;
  /** ISO 8601, when the title became finished; null when unknown. */
  finishedAt: string | null;
  /** TMDB genre names stored on the title. */
  genres: string[];
}

export interface ListedCandidate {
  kind: TitleKind;
  tmdbId: number;
  source: StreamProbeListSource;
  /** 0-based position among the candidates of its kind; lower is probed first. */
  rank: number;
}

export interface GatheredCandidates {
  entries: ListedCandidate[];
  /** One line per TMDB list that could not be read. The lists that were read still count. */
  errors: string[];
}

/** Rated 4-5 first (higher rating, then newer finish), then unrated (newer finish first). At most `max`. */
export function pickSeeds(finished: readonly SeedTitle[], max: number = MAX_SEEDS): SeedTitle[] {
  const newerFirst = (a: SeedTitle, b: SeedTitle): number => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
  const rated = finished
    .filter((t) => t.rating !== null && t.rating >= MIN_SEED_RATING)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || newerFirst(a, b));
  const unrated = finished.filter((t) => t.rating === null).sort(newerFirst);
  return [...rated, ...unrated].slice(0, max);
}

/** Genre names by how many seeds carry them, most first (ties by name). */
export function topGenres(seeds: readonly SeedTitle[]): string[] {
  const counts = new Map<string, number>();
  for (const s of seeds) for (const g of new Set(s.genres)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

/** One item from each list in turn until every list is spent; an item whose key was seen is skipped. */
export function roundRobin<T>(lists: ReadonlyArray<readonly T[]>, key: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      const k = key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** TMDB says the title is out by `today` (YYYY-MM-DD). A title with no date is not. */
export function released(hit: TmdbSearchHit, today: string): boolean {
  return hit.releaseDate !== null && hit.releaseDate <= today;
}

/**
 * The ranked candidates of one kind. Each source's lists are merged round-robin (one
 * recommendation list per seed, one discover list per genre), then the sources are merged
 * round-robin in CANDIDATE_SOURCE_ORDER. Unreleased titles and titles of the other kind are dropped,
 * each title is kept once, under the first source that reached it.
 */
export function rankKind(
  kind: TitleKind,
  bySource: Readonly<Record<StreamProbeListSource, ReadonlyArray<readonly TmdbSearchHit[]>>>,
  today: string,
): ListedCandidate[] {
  const tagged = CANDIDATE_SOURCE_ORDER.map((source) =>
    roundRobin(bySource[source], (h) => String(h.tmdbId))
      .filter((h) => h.kind === kind && released(h, today))
      .map((h) => ({ tmdbId: h.tmdbId, source })),
  );
  return roundRobin(tagged, (c) => String(c.tmdbId)).map((c, rank) => ({ kind, tmdbId: c.tmdbId, source: c.source, rank }));
}

/**
 * Reads every list, sequentially, and ranks films and series. A TmdbError on one list is recorded
 * in `errors` and that list counts as empty; any other error is thrown.
 */
export async function gatherCandidates(tmdb: TmdbCatalog, seeds: readonly SeedTitle[], today: string): Promise<GatheredCandidates> {
  const errors: string[] = [];
  async function read(what: string, call: () => Promise<TmdbSearchHit[]>): Promise<TmdbSearchHit[]> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof TmdbError)) throw err;
      errors.push(`${what}: ${err.message}`);
      return [];
    }
  }
  const genreNames = topGenres(seeds);
  const entries: ListedCandidate[] = [];
  for (const kind of ['movie', 'tv'] as const) {
    const trending: TmdbSearchHit[] = [];
    const popular: TmdbSearchHit[] = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      trending.push(...(await read(`${kind} trending page ${page}`, () => tmdb.list('trending', kind, page))));
      popular.push(...(await read(`${kind} popular page ${page}`, () => tmdb.list('popular', kind, page))));
    }
    const genre: TmdbSearchHit[][] = [];
    if (genreNames.length > 0) {
      let ids: number[] = [];
      try {
        const known = new Map((await tmdb.genres(kind)).map((g) => [g.name.toLowerCase(), g.id] as const));
        ids = genreNames
          .map((n) => known.get(n.toLowerCase()))
          .filter((id): id is number => id !== undefined)
          .slice(0, GENRES_PER_KIND);
      } catch (err) {
        if (!(err instanceof TmdbError)) throw err;
        errors.push(`${kind} genre list: ${err.message}`);
      }
      for (const id of ids) genre.push(await read(`${kind} genre ${id}`, () => tmdb.discoverByGenre(kind, id, 1)));
    }
    const recommended: TmdbSearchHit[][] = [];
    for (const seed of seeds) {
      if (seed.kind !== kind) continue;
      recommended.push(await read(`${kind} ${seed.tmdbId} recommendations`, () => tmdb.recommendations(kind, seed.tmdbId, 1)));
    }
    entries.push(...rankKind(kind, { recommended, genre, trending: [trending], popular: [popular] }, today));
  }
  return { entries, errors };
}
```
**Impact:** none. Up to about 36 TMDB requests a day (4 trending, 4 popular, 2 genre lists, 6 discover, up to 20 recommendations).

### Step 8: the prober
**File:** `src/directStream/prober.ts` (new)
**Code:**
```ts
import { createTmdbClient, type TitleKind, type TmdbCatalog } from '../movies/tmdb.js';
import { probePassSeconds, type Config, type StreamProberConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { StreamProbeOutcome } from '../db/schema.js';
import type { MoviePlayer } from '../movies/player.js';
import { listTitles, MAX_LIST_LIMIT, type ReadContext } from '../movies/read.js';
import { streamFreshSince } from '../movies/repo.js';
import type { MoviesService } from '../movies/service.js';
import { CANDIDATE_REFRESH_MS, gatherCandidates, pickSeeds, type ListedCandidate, type SeedTitle } from './candidates.js';
import { detectIdleReader, type IdleDetection, type IdleOffReason, type IdleReader } from './idle.js';
import { ProbeRepo } from './repo.js';

/**
 * The direct-streaming prober (phase 10; D5, D6). Off unless NOTESD_STREAM_PROBER=on. Each pass:
 * refresh the TMDB candidate listing when it is a day old (HTTP only), then, only while nothing
 * plays and Windows has been idle for NOTESD_STREAM_IDLE_SECONDS (checked again before every
 * probe), re-check the verified sources nearest the end of their freshness window, then resolve
 * new candidates until NOTESD_STREAM_CATALOG_SIZE titles are fresh, inside NOTESD_STREAM_PROBE_BUDGET
 * probes and half of NOTESD_STREAM_PROBE_MS. Every probe is DirectStreamService.resolve with the
 * seconds left in the pass as its deadline: an out-of-sight tab, no sound, no play. Its hooks
 * (phase 5) ensure the title row and write verified or stale before it answers; the prober writes
 * only its own stream_probe_titles row (outcome and backoff).
 */

const DAY_MS = 86_400_000;
/** First pass after start: after the daemon's own startup work. */
export const INITIAL_DELAY_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
/** A source is re-checked once it is this far through its freshness window (about 4.9 days of 7). */
export const RECHECK_AT_FRACTION = 0.7;
/** An open play updated this recently means someone is watching: no probe. */
export const ACTIVE_PLAY_MS = 15 * 60_000;
/** One series slot in every SERIES_EVERY new-candidate probes, when a series is eligible. */
export const SERIES_EVERY = 4;
/** First wait after a failed probe; it doubles with each failure in a row, up to BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = DAY_MS;
export const BACKOFF_MAX_MS = 30 * DAY_MS;
/** After a refresh that listed nothing (TMDB down), the next try waits this long. */
export const REFRESH_RETRY_MS = 60 * 60_000;
/** resolve() failures (phase 3's `reason` of a resolve_failed) that mean Chrome itself is missing: the pass stops and no title is blamed. */
export const ENVIRONMENT_ERRORS: ReadonlySet<string> = new Set(['no_chrome', 'chrome_not_reachable', 'direct_stream_off']);
/** A resolve cut short by its deadline (phase 1's --deadline-s): the pass's seconds are spent; no title is blamed. */
export const DEADLINE_ERROR = 'deadline';

/** What DirectStreamService.resolve takes (phase 3's `ref`). */
export interface ProbeRef {
  kind: TitleKind;
  tmdbId: number;
  season?: number;
  episode?: number;
}

/** A title to probe. A series candidate has no episode yet (S1E1 is probed); a re-check names its own. */
export interface ProbeTarget {
  kind: TitleKind;
  tmdbId: number;
  season: number | null;
  episode: number | null;
}

export type ProbeOutcome = StreamProbeOutcome;

export interface ProbeRecord {
  kind: TitleKind;
  tmdbId: number;
  outcome: ProbeOutcome;
  probedAt: Date;
  failures: number;
  retryAfter: Date | null;
}

/** ProbeRepo's surface; tests use an in-memory store with the same rules. */
export interface ProbeStore {
  freshCount(host: string, since: Date): Promise<number>;
  dueRechecks(host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]>;
  listedAt(host: string): Promise<Date | null>;
  replaceListing(host: string, entries: readonly ListedCandidate[], at: Date): Promise<void>;
  eligible(host: string, kind: TitleKind, now: Date, freshSince: Date, limit: number): Promise<ProbeTarget[]>;
  failures(host: string, kind: TitleKind, tmdbId: number): Promise<number>;
  record(host: string, r: ProbeRecord): Promise<void>;
  activePlay(host: string, since: Date): Promise<boolean>;
}

/** Why a pass ended. Every pass ends with exactly one. */
export type PassStop =
  | 'catalog_full'
  | 'no_candidates'
  | 'probe_budget'
  | 'time_budget'
  | 'not_idle'
  | 'busy'
  | 'chrome_unavailable'
  | 'closed'
  | 'error';

export interface PassSummary {
  started_at: string;
  finished_at: string | null;
  seconds: number;
  rechecked: number;
  recheck_verified: number;
  probed: number;
  probe_verified: number;
  failed: number;
  /** Candidates listed when this pass refreshed the listing; null when it did not. */
  listed: number | null;
  catalog_fresh: number | null;
  catalog_size: number;
  /** The last idle time read this pass; null when none was read. */
  idle_s: number | null;
  busy: 'vlc' | 'play' | null;
  stopped: PassStop;
  error: string | null;
}

export type ProberOffReason = 'setting_off' | 'movies_off' | 'direct_stream_off' | 'no_tmdb' | IdleOffReason;

export interface ProberStatus {
  enabled: boolean;
  off_reason: ProberOffReason | null;
  host: string | null;
  running: boolean;
  next_pass_at: string | null;
  settings: {
    catalog_size: number;
    probe_budget: number;
    pass_seconds: number;
    idle_seconds: number;
    probe_ms: number;
    fresh_days: number;
  } | null;
  catalog: { size: number; fresh: number | null } | null;
  last_pass: PassSummary | null;
}

/** What background.ts, the daemon and the status route hold. */
export interface StreamProberHandle {
  readonly enabled: boolean;
  /** The one line background.ts logs at start. */
  startLine(): string;
  start(): void;
  status(): Promise<ProberStatus>;
  close(): Promise<void>;
}

const OFF_TEXT: Record<ProberOffReason, string> = {
  setting_off: 'NOTESD_STREAM_PROBER is off (the default)',
  movies_off: 'NOTESD_MOVIES=off',
  direct_stream_off: 'direct streaming is off',
  no_tmdb: 'no TMDB credential (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY)',
  not_linux: 'not running on Linux, so there is no Windows idle time to read',
  no_interop: 'no WSL interop, so there is no Windows idle time to read',
  no_powershell: 'powershell.exe not found (NOTESD_POWERSHELL_EXE), so there is no Windows idle time to read',
};

/** The prober when it must not run: no timer, no tab, no TMDB request, no idle read. */
export class DisabledProber implements StreamProberHandle {
  readonly enabled = false;

  constructor(readonly reason: ProberOffReason) {}

  startLine(): string {
    return `[notesd] stream prober off: ${OFF_TEXT[this.reason]}`;
  }

  start(): void {}

  async status(): Promise<ProberStatus> {
    return {
      enabled: false,
      off_reason: this.reason,
      host: null,
      running: false,
      next_pass_at: null,
      settings: null,
      catalog: null,
      last_pass: null,
    };
  }

  async close(): Promise<void> {}
}

export type ResolveVerdict = ProbeOutcome | 'chrome_unavailable' | 'deadline';

/**
 * The failure's name. Phase 3's DirectStreamError carries `code` (`no_source`, `resolve_failed`,
 * ...) and, for `resolve_failed`, the `reason` that names it (`no_chrome`, `deadline`, ...).
 */
function codeOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { code?: unknown; reason?: unknown; error?: unknown };
  if (o.code === 'resolve_failed' && typeof o.reason === 'string' && o.reason !== '') return o.reason;
  const c = typeof o.code === 'string' ? o.code : o.error;
  return typeof c === 'string' && c !== '' ? c : null;
}

/**
 * What one DirectStreamService.resolve came to. The one place its answer is read: a rejection
 * with a `code` (phase 3's DirectStreamError), or an answer with `ok: false` and an `error` code,
 * are failures; anything else resolved (phase 5's hook has written `verified`).
 */
export function classifyResolve(r: { ok: true; value: unknown } | { ok: false; error: unknown }): ResolveVerdict {
  let code: string | null;
  if (r.ok) {
    const failed = typeof r.value === 'object' && r.value !== null && (r.value as { ok?: unknown }).ok === false;
    code = failed ? (codeOf(r.value) ?? 'error') : null;
  } else {
    code = codeOf(r.error) ?? 'error';
  }
  if (code === null) return 'verified';
  if (ENVIRONMENT_ERRORS.has(code)) return 'chrome_unavailable';
  if (code === DEADLINE_ERROR) return 'deadline';
  return code === 'no_source' ? 'no_source' : 'error';
}

/** When a title may be probed again: never held after `verified`; 1, 2, 4 ... days after failures, at most 30. */
export function retryAfter(outcome: ProbeOutcome, failures: number, at: Date): Date | null {
  if (outcome === 'verified') return null;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return new Date(at.getTime() + wait);
}

/** Films in order, with a series in every `every`-th place while series remain; leftovers at the end. */
export function interleave<T>(films: readonly T[], series: readonly T[], every: number): T[] {
  const out: T[] = [];
  let f = 0;
  let s = 0;
  while (f < films.length || s < series.length) {
    const seriesTurn = (out.length + 1) % every === 0;
    if ((seriesTurn && s < series.length) || f >= films.length) out.push(series[s++]!);
    else out.push(films[f++]!);
  }
  return out;
}

export function passLine(s: PassSummary): string {
  const parts = [
    `${s.rechecked} re-checked (${s.recheck_verified} verified)`,
    `${s.probed} probed (${s.probe_verified} verified)`,
    `${s.failed} failed`,
    `catalog ${s.catalog_fresh ?? '?'}/${s.catalog_size}`,
  ];
  if (s.listed !== null) parts.push(`${s.listed} candidates listed`);
  const why =
    s.stopped === 'not_idle' && s.idle_s !== null
      ? `not_idle (idle ${s.idle_s} s)`
      : s.stopped === 'busy' && s.busy !== null
        ? `busy (${s.busy})`
        : s.stopped;
  return `[notesd] stream prober: pass ${s.seconds} s: ${parts.join(', ')}; stopped: ${why}${s.error === null ? '' : `; ${s.error}`}`;
}

function emptyPass(startedAt: Date, catalogSize: number): PassSummary {
  return {
    started_at: startedAt.toISOString(),
    finished_at: null,
    seconds: 0,
    rechecked: 0,
    recheck_verified: 0,
    probed: 0,
    probe_verified: 0,
    failed: 0,
    listed: null,
    catalog_fresh: null,
    catalog_size: catalogSize,
    idle_s: null,
    busy: null,
    stopped: 'no_candidates',
    error: null,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StreamProberDeps {
  config: StreamProberConfig;
  /** NOTESD_STREAM_FRESH_DAYS (phase 3). */
  freshDays: number;
  host: string;
  store: ProbeStore;
  tmdb: TmdbCatalog;
  /** The owner's finished titles (all of them; pickSeeds chooses). */
  seeds: () => Promise<SeedTitle[]>;
  /** DirectStreamService.resolve, given the seconds left in the pass (phase 1's --deadline-s). */
  resolve: (ref: ProbeRef, options: { deadlineS: number }) => Promise<unknown>;
  idle: IdleReader;
  /** True while the VLC notesd follows is open. */
  vlcPlaying: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export class StreamProber implements StreamProberHandle {
  readonly enabled = true;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextPassAt: Date | null = null;
  private current: Promise<PassSummary> | null = null;
  private lastPass: PassSummary | null = null;
  private lastQuietStop: PassStop | null = null;
  private refreshFailedAt: number | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly deps: StreamProberDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line: string) => console.log(line));
  }

  get host(): string {
    return this.deps.host;
  }

  private get passSeconds(): number {
    return probePassSeconds(this.deps.config.probeMs);
  }

  startLine(): string {
    const c = this.deps.config;
    return (
      `[notesd] stream prober on as ${this.deps.host}: a pass every ${Math.round(c.probeMs / 1000)} s while Windows is idle ${c.idleSeconds} s ` +
      `and nothing plays, up to ${c.probeBudget} probes or ${this.passSeconds} s a pass, catalog ${c.catalogSize} titles fresh for ${this.deps.freshDays} days`
    );
  }

  /** Starts the loop (background.ts). The first pass runs after min(60 s, probeMs). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(Math.min(INITIAL_DELAY_MS, this.deps.config.probeMs));
  }

  /** One pass now, or the one in flight. Never rejects. */
  passNow(): Promise<PassSummary> {
    if (this.current !== null) return this.current;
    const pass = this.runPass();
    this.current = pass;
    void pass.then(() => {
      if (this.current === pass) this.current = null;
    });
    return pass;
  }

  async status(): Promise<ProberStatus> {
    let fresh: number | null;
    try {
      fresh = await this.deps.store.freshCount(this.deps.host, this.freshSince());
    } catch {
      fresh = null;
    }
    const c = this.deps.config;
    return {
      enabled: true,
      off_reason: null,
      host: this.deps.host,
      running: this.current !== null,
      next_pass_at: this.nextPassAt === null ? null : this.nextPassAt.toISOString(),
      settings: {
        catalog_size: c.catalogSize,
        probe_budget: c.probeBudget,
        pass_seconds: this.passSeconds,
        idle_seconds: c.idleSeconds,
        probe_ms: c.probeMs,
        fresh_days: this.deps.freshDays,
      },
      catalog: { size: c.catalogSize, fresh },
      last_pass: this.lastPass,
    };
  }

  /** Stops the loop; a probe in flight is waited for up to 5 s (no new one starts). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPassAt = null;
    const running = this.current ?? Promise.resolve();
    await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
  }

  /** Phase 5's one freshness window (NOTESD_STREAM_FRESH_DAYS before now). */
  private freshSince(): Date {
    return streamFreshSince(this.now(), this.deps.freshDays);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextPassAt = new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPassAt = null;
      void this.passNow().finally(() => this.schedule(this.deps.config.probeMs));
    }, delayMs);
    this.timer.unref();
  }

  private async runPass(): Promise<PassSummary> {
    const startedAt = this.now();
    const s = emptyPass(startedAt, this.deps.config.catalogSize);
    if (this.closed) {
      s.stopped = 'closed';
      return this.finish(s, startedAt);
    }
    try {
      await this.refreshCandidates(s, startedAt);
      if (!(await this.halted(s, startedAt))) await this.probeAll(s, startedAt);
    } catch (err) {
      s.stopped = 'error';
      s.error = messageOf(err);
    }
    try {
      s.catalog_fresh = await this.deps.store.freshCount(this.deps.host, this.freshSince());
    } catch {
      s.catalog_fresh = null;
    }
    return this.finish(s, startedAt);
  }

  /** Rebuilds the listing when it is a day old. TMDB only: it opens no tab, so it does not wait for idle. */
  private async refreshCandidates(s: PassSummary, now: Date): Promise<void> {
    if (this.refreshFailedAt !== null && now.getTime() - this.refreshFailedAt < REFRESH_RETRY_MS) return;
    const last = await this.deps.store.listedAt(this.deps.host);
    if (last !== null && now.getTime() - last.getTime() < CANDIDATE_REFRESH_MS) return;
    const seeds = pickSeeds(await this.deps.seeds());
    const gathered = await gatherCandidates(this.deps.tmdb, seeds, now.toISOString().slice(0, 10));
    if (gathered.errors.length > 0) {
      s.error = `TMDB: ${gathered.errors.length} list(s) unread, first: ${gathered.errors[0]}`;
    }
    if (gathered.entries.length === 0) {
      // Keep the old listing rather than unlist everything because TMDB answered nothing.
      this.refreshFailedAt = now.getTime();
      return;
    }
    this.refreshFailedAt = null;
    await this.deps.store.replaceListing(this.deps.host, gathered.entries, now);
    s.listed = gathered.entries.length;
  }

  /** Asked before the first probe and before every one after it: true (s.stopped set) when the pass must stop. */
  private async halted(s: PassSummary, startedAt: Date): Promise<boolean> {
    const stop = await this.stopReason(s, startedAt);
    if (stop === null) return false;
    s.stopped = stop;
    return true;
  }

  private async stopReason(s: PassSummary, startedAt: Date): Promise<PassStop | null> {
    if (this.closed) return 'closed';
    if (s.rechecked + s.probed >= this.deps.config.probeBudget) return 'probe_budget';
    if (this.now().getTime() - startedAt.getTime() >= this.passSeconds * 1000) return 'time_budget';
    if (this.deps.vlcPlaying()) {
      s.busy = 'vlc';
      return 'busy';
    }
    if (await this.deps.store.activePlay(this.deps.host, new Date(this.now().getTime() - ACTIVE_PLAY_MS))) {
      s.busy = 'play';
      return 'busy';
    }
    const idle = await this.deps.idle();
    if (idle.kind === 'error') {
      // Fail closed: an idle time that cannot be read is never "idle".
      s.error = `idle time unreadable: ${idle.message}`;
      return 'not_idle';
    }
    s.idle_s = idle.idleSeconds;
    return idle.idleSeconds < this.deps.config.idleSeconds ? 'not_idle' : null;
  }

  private async probeAll(s: PassSummary, startedAt: Date): Promise<void> {
    const { host, store, config } = this.deps;
    const dueBefore = new Date(this.now().getTime() - RECHECK_AT_FRACTION * this.deps.freshDays * DAY_MS);
    const due = await store.dueRechecks(host, dueBefore, config.probeBudget);
    for (const [i, target] of due.entries()) {
      if (i > 0 && (await this.halted(s, startedAt))) return;
      const verdict = await this.probe(target, startedAt);
      if (verdict === 'chrome_unavailable') {
        s.stopped = 'chrome_unavailable';
        return;
      }
      if (verdict === 'deadline') {
        s.stopped = 'time_budget';
        return;
      }
      s.rechecked += 1;
      if (verdict === 'verified') s.recheck_verified += 1;
      else s.failed += 1;
    }

    const freshSince = this.freshSince();
    let fresh = await store.freshCount(host, freshSince);
    if (fresh >= config.catalogSize) {
      s.stopped = 'catalog_full';
      return;
    }
    const left = config.probeBudget - s.rechecked;
    if (left <= 0) {
      s.stopped = 'probe_budget';
      return;
    }
    const now = this.now();
    const films = await store.eligible(host, 'movie', now, freshSince, left);
    const series = await store.eligible(host, 'tv', now, freshSince, left);
    for (const target of interleave(films, series, SERIES_EVERY)) {
      if (fresh >= config.catalogSize) {
        s.stopped = 'catalog_full';
        return;
      }
      if ((s.rechecked > 0 || s.probed > 0) && (await this.halted(s, startedAt))) return;
      const verdict = await this.probe(target, startedAt);
      if (verdict === 'chrome_unavailable') {
        s.stopped = 'chrome_unavailable';
        return;
      }
      if (verdict === 'deadline') {
        s.stopped = 'time_budget';
        return;
      }
      s.probed += 1;
      if (verdict === 'verified') {
        s.probe_verified += 1;
        fresh += 1;
      } else {
        s.failed += 1;
      }
    }
    s.stopped = fresh >= config.catalogSize ? 'catalog_full' : s.rechecked + s.probed >= config.probeBudget ? 'probe_budget' : 'no_candidates';
  }

  /** One resolve, bounded by the seconds left in the pass (the budget is otherwise checked only between probes). */
  private async probe(t: ProbeTarget, startedAt: Date): Promise<ResolveVerdict> {
    const ref: ProbeRef =
      t.kind === 'tv'
        ? { kind: 'tv', tmdbId: t.tmdbId, season: t.season ?? 1, episode: t.episode ?? 1 }
        : { kind: 'movie', tmdbId: t.tmdbId };
    const elapsedS = (this.now().getTime() - startedAt.getTime()) / 1000;
    const deadlineS = Math.max(1, Math.floor(this.passSeconds - elapsedS));
    let verdict: ResolveVerdict;
    try {
      verdict = classifyResolve({ ok: true, value: await this.deps.resolve(ref, { deadlineS }) });
    } catch (error) {
      verdict = classifyResolve({ ok: false, error });
    }
    if (verdict === 'chrome_unavailable' || verdict === 'deadline') return verdict;
    const probedAt = this.now();
    const failures = verdict === 'verified' ? 0 : (await this.deps.store.failures(this.deps.host, t.kind, t.tmdbId)) + 1;
    await this.deps.store.record(this.deps.host, {
      kind: t.kind,
      tmdbId: t.tmdbId,
      outcome: verdict,
      probedAt,
      failures,
      retryAfter: retryAfter(verdict, failures, probedAt),
    });
    return verdict;
  }

  /** Stores the summary and logs one line: always for a pass that probed, listed or failed; for a quiet one only when its stop reason changed. */
  private finish(s: PassSummary, startedAt: Date): PassSummary {
    const end = this.now();
    s.finished_at = end.toISOString();
    s.seconds = Math.round((end.getTime() - startedAt.getTime()) / 100) / 10;
    this.lastPass = s;
    const quiet = s.rechecked + s.probed === 0 && s.listed === null && s.error === null;
    if (!quiet) {
      this.lastQuietStop = null;
      this.log(passLine(s));
    } else if (s.stopped !== this.lastQuietStop) {
      this.lastQuietStop = s.stopped;
      this.log(passLine(s));
    }
    return s;
  }
}

/** The owner's finished titles with their genres. Watch state comes from listTitles (state.ts), never from here. */
export async function libraryFinishedTitles(db: Db, repo: Pick<ProbeRepo, 'titleGenres'>, ctx: ReadContext): Promise<SeedTitle[]> {
  const items = await listTitles(db, { state: 'finished', sort: 'rating', limit: MAX_LIST_LIMIT }, ctx);
  const genres = await repo.titleGenres(items.map((i) => i.id));
  return items.map((i) => ({
    kind: i.kind,
    tmdbId: i.tmdb_id,
    rating: i.rating,
    finishedAt: i.finished_at,
    genres: genres.get(i.id) ?? [],
  }));
}

export interface StreamProberInput {
  config: Config;
  db: Db;
  movies: MoviesService | null;
  moviesPlayer?: MoviePlayer | null;
  /** AppDeps.directStream (phase 3): `resolve(input, { deadlineS })`. */
  directStream?: { resolve(ref: ProbeRef, options: { deadlineS?: number }): Promise<unknown> } | null;
}

/** Test seams. The daemon passes none. */
export interface StreamProberOverrides {
  idle?: IdleDetection;
  tmdb?: TmdbCatalog;
  store?: ProbeStore;
  seeds?: () => Promise<SeedTitle[]>;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's prober. A DisabledProber unless every condition holds, checked in this order:
 * NOTESD_STREAM_PROBER=on, movies on, direct streaming on, a TMDB credential, WSL with
 * powershell.exe. The setting comes first, so with it unset or off nothing else is even looked at.
 */
export async function buildStreamProber(input: StreamProberInput, overrides: StreamProberOverrides = {}): Promise<StreamProberHandle> {
  const ds = input.config.directStream;
  if (ds === undefined || !ds.prober.enabled) return new DisabledProber('setting_off');
  const movies = input.movies;
  if (movies === null) return new DisabledProber('movies_off');
  const directStream = input.directStream ?? null;
  if (!ds.enabled || directStream === null) return new DisabledProber('direct_stream_off');
  const tmdbConfig = input.config.movies.tmdb;
  const tmdb =
    overrides.tmdb ?? (tmdbConfig.token !== null || tmdbConfig.apiKey !== null ? createTmdbClient(tmdbConfig) : null);
  if (tmdb === null) return new DisabledProber('no_tmdb');
  const idle = overrides.idle ?? (await detectIdleReader());
  if (!idle.available) return new DisabledProber(idle.reason);
  const repo = new ProbeRepo(input.db);
  const ctx: ReadContext = { host: movies.host, imageBase: tmdbConfig.imageBase };
  const player = input.moviesPlayer ?? null;
  return new StreamProber({
    config: ds.prober,
    freshDays: ds.freshDays,
    host: movies.host,
    store: overrides.store ?? repo,
    tmdb,
    seeds: overrides.seeds ?? (() => libraryFinishedTitles(input.db, repo, ctx)),
    resolve: (ref, options) => directStream.resolve(ref, options),
    idle: idle.read,
    vlcPlaying: () => player !== null && player.current() !== null,
    now: overrides.now,
    log: overrides.log,
  });
}
```
**Impact:** none until wired. Note the host: `movies.host` (`os.hostname()`) is the host phase 5 writes on `movie_stream_sources` and `movie_plays`.

### Step 9: `AppDeps.streamProber`
**File:** `src/deps.ts` (import block at the top; the field after `streaming`, line 49, beside phase 3's `directStream`)
**Code:**
```ts
import type { StreamProberHandle } from './directStream/prober.js';
```
```ts
  /**
   * The direct-streaming prober (phase 10). The daemon always sets it: a DisabledProber unless
   * NOTESD_STREAM_PROBER=on and everything it needs is there. Absent (tests), GET /api/stream/prober
   * reports it off. Started and closed by startBackground.
   */
  streamProber?: StreamProberHandle | null;
```

### Step 10: build it in the daemon
**File:** `src/daemon.ts` (import beside `./movies/...` imports, lines 22-25; the build right after the `const deps: AppDeps = { ... }` line, about line 147, before `createApp(deps, { chat })`)
**Code:**
```ts
import { buildStreamProber } from './directStream/prober.js';
```
```ts
  // Direct streaming phase 10: the background prober. A DisabledProber unless NOTESD_STREAM_PROBER=on;
  // started and closed by startBackground. Built after `deps` so it reads phase 3's deps.directStream.
  deps.streamProber = await buildStreamProber({ config, db, movies, moviesPlayer, directStream: deps.directStream });
```
**Impact:** with the setting unset this only constructs a `DisabledProber`: no detection run, no timer.

### Step 11: start, log, close
**File:** `src/background.ts` (doc comment lines 33-45; after the movies block, line 178; the close list, lines 189-201)
**Code:** after the movies block:
```ts
  // Direct streaming phase 10: the prober, built by the daemon (off by default), started here, closed on stop.
  const prober = deps.streamProber ?? null;
  if (prober !== null) {
    console.log(prober.startLine());
    prober.start();
  }
```
In the `Promise.all([...])` of the returned stop function, after `deps.movies?.close(),`:
```ts
      prober?.close(),
```
In the doc comment, after "With deps.movies, the movies library's poll loop over NOTESD_MOVIES_ROOTS.": `With deps.streamProber enabled (NOTESD_STREAM_PROBER=on), the direct-streaming prober's loop.`

### Step 12: the status route
**File:** `src/http/streamProberApi.ts` (new); `src/http/app.ts` (import after line 20; mount right after phase 3's `app.route('/', directStreamRoutes(deps));`, which phase 3 put after `app.route('/', moviesPlayRoutes(deps));`)
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { DisabledProber } from '../directStream/prober.js';

/**
 * GET /api/stream/prober: the direct-streaming prober of this machine. A read that starts nothing.
 * Like every direct-stream route it answers 503 direct_stream_off without direct streaming (R2.6).
 */
export function streamProberRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/api/stream/prober', async (c) => {
    if (deps.directStream === undefined || deps.directStream === null) return c.json({ error: 'direct_stream_off' }, 503);
    const prober = deps.streamProber ?? new DisabledProber('setting_off');
    return c.json(await prober.status());
  });
  return r;
}
```
In `app.ts`:
```ts
import { streamProberRoutes } from './streamProberApi.js';
```
```ts
  app.route('/', streamProberRoutes(deps));
```
Update the `createApp` doc comment's router list to name `streamProberRoutes` (direct streaming phase 10).

### Step 13: reference docs
**File:** `scripts/docs/httpRoutes.ts` (the group phase 3 adds for direct streaming; create a `{ title: 'Direct streaming', routes: {} }` group before 'Debug' only if phase 3 has none); then `npm run docs:gen`; `docs/guide/reference/configuration.md` (the direct-streaming section phase 3 adds, after `NOTESD_STREAM_FRESH_DAYS`)
**Code:** route entry:
```ts
      'GET /api/stream/prober':
        'The background prober of this machine: `{enabled, off_reason, host, running, next_pass_at, settings, catalog: {size, fresh}, last_pass}`. `off_reason` says why it does not run: `setting_off` (the default), `movies_off`, `direct_stream_off`, `no_tmdb`, or `not_linux` / `no_interop` / `no_powershell` when the Windows idle time cannot be read. `last_pass` counts re-checks, probes and failures, and `stopped` says why the pass ended (`not_idle`, `busy`, `probe_budget`, `time_budget`, `catalog_full`, `no_candidates`, `chrome_unavailable`, `error`, `closed`). Starts nothing. 503 `direct_stream_off` without direct streaming.',
```
Configuration rows (keep `15` and `38 s` equal to `defaultProbeBudget(DEFAULT_STREAM_PROBE_MS)` and `probeSecondsPerTitle(DEFAULT_PROBE_TIMINGS)` after step 2's timings are set):
```markdown
| `NOTESD_STREAM_PROBER` | off | `on` lets the background prober fill the Stream side of `/movies` by itself: while Windows is idle and nothing plays, it resolves TMDB candidates in a tab of the streaming Chrome, out of sight and without sound, and re-checks verified titles before they go stale. Needs direct streaming, movies, a TMDB credential and WSL with `powershell.exe`. See [streaming.md](../streaming.md#the-prober). |
| `NOTESD_STREAM_CATALOG_SIZE` | 300 | How many titles with a fresh verified source the prober keeps on this machine. At this count it stops probing new candidates; re-checks go on. |
| `NOTESD_STREAM_PROBE_BUDGET` | 15 | Resolves per prober pass, re-checks and new candidates together. The default is the titles that fit in a pass's seconds (half of `NOTESD_STREAM_PROBE_MS`) at 38 s a title, from the resolve campaign's timings; it follows `NOTESD_STREAM_PROBE_MS` when that is set. |
| `NOTESD_STREAM_IDLE_SECONDS` | 600 | How long Windows must have had no keyboard or mouse input before the prober starts a resolve. It is read again before every resolve, and the pass stops as soon as it is shorter. |
| `NOTESD_STREAM_PROBE_MS` | 1200000 | Pause between prober passes. A pass spends at most half of it. |
```
**Impact:** `npm run docs:check` stays green (new route and env vars documented).

### Step 14: guides
**File:** `docs/guide/streaming.md` (a new `### The prober` subsection, last under phase 3's `## Direct streaming`); `docs/guide/architecture.md` (Background jobs table after the "VLC play tracking and health log" row, line 212; the data-model row phase 3 adds for direct streaming; the `src/deps.ts` wiring row, line 39)
**Code:** `docs/guide/streaming.md`:
```markdown
### The prober

The Stream side of `/movies` shows only titles verified on this machine within the freshness
window. The prober fills it and keeps it fresh without being asked. It is **off** unless
`NOTESD_STREAM_PROBER=on`, because it widens the rule that a film starts only when asked: it opens
embed pages in the streaming Chrome by itself. Resolving is not playing. Each probe is the same
resolve `/direct-stream` runs: a tab out of sight, closed when the stream address is caught. No
window comes to the front, nothing makes a sound, nothing is played, and no play is recorded.

When it may probe: only while Windows has had no keyboard or mouse input for
`NOTESD_STREAM_IDLE_SECONDS` (one `powershell.exe` call to `GetLastInputInfo`, made again before
every probe), and only while nothing plays (no VLC that notesd follows, no open play the player page
reported in the last 15 minutes). The moment either changes, the pass stops after the probe in
flight. An idle time that cannot be read counts as "not idle". Outside WSL, or without
`powershell.exe`, the prober stays off and `GET /api/stream/prober` says why.

What it probes, each pass (one every `NOTESD_STREAM_PROBE_MS`):

1. Once a day, the candidate list is rebuilt from TMDB: TMDB's recommendations for up to 20 titles
   you finished (rated 4 or 5 first, then unrated ones; a finished title you rated 3 or lower is
   left out), discover lists for the three genres those titles share most, and this week's
   trending and popular titles. Unreleased titles are dropped. This step only talks to TMDB, so it
   runs whether or not the laptop is idle.
2. Re-checks: verified sources at least 70% through the freshness window, the oldest first, so a
   title is checked again before it would leave the grid.
3. New candidates, until `NOTESD_STREAM_CATALOG_SIZE` titles are fresh. Films lead, with a series
   in every fourth slot; a series is verified by its first episode. A title already fresh is
   never probed again. A title that fails waits 1 day, then 2, 4 and so on up to 30 days.

A pass stops at `NOTESD_STREAM_PROBE_BUDGET` probes or half of `NOTESD_STREAM_PROBE_MS`, whichever
comes first. The budget's default follows from the resolve campaign's timings
(`docs/plans/2026-11-15-direct-streaming-findings.md`): a title costs the median failing providers
tried before the one that works, at the median seconds of a failure, plus the median seconds of a
resolve. Each resolve is given the seconds left in the pass, so one title that no provider carries
cannot overrun it; a resolve cut short, or one that cannot reach Chrome, ends the pass without
blaming the title.

Every verified or stale mark is the one a play would write (see [movies.md](movies.md)); the
prober's own state is `stream_probe_titles`: per host, the listing, each title's last outcome and
its backoff. Each pass logs one line (`[notesd] stream prober: pass ...`); a pass that did nothing
logs only when its reason changed. `GET /api/stream/prober` shows the settings, the catalog count
and the last pass.
```
`docs/guide/architecture.md`, Background jobs row:
```markdown
| Stream prober | `NOTESD_STREAM_PROBER` on, with direct streaming, movies, a TMDB credential and WSL `powershell.exe` | Rebuilds the TMDB candidate list once a day; while Windows is idle and nothing plays, re-checks verified sources nearing the end of their window, then resolves new candidates up to the catalog size, within a budget of probes and seconds. Its tabs are out of sight and silent. | `src/directStream/prober.ts` |
```
In the direct-streaming data-model row phase 3 added, append `stream_probe_titles` to the tables cell and this sentence to the notes cell: `The prober's candidates, last outcome and backoff, per host.` In the `src/deps.ts` wiring row, add `streamProber` to the listed fields.
**Impact:** docs only.

### Step 15: the harness
**File:** `.claude/skills/verify-notesd/scripts/verify.sh` **as phase 3 leaves it** (verify.sh is edited by phase 3, then this phase; phase 5 does not touch it): the usage comment (after phase 3's three `--direct-stream` lines), `cmd_up`'s flags (phase 3's `local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0` and its `--direct-stream) direct=1; movies=1 ;;` case), the fake `powershell.exe` (lines 151-153 of `d996abb`, untouched by phase 3), the env (after phase 3's `if [ "$direct" = 1 ]; then env+=(... NOTESD_DIRECT_STREAM_CLI ...) else env+=(NOTESD_DIRECT_STREAM=off) fi` block) and the meta block (after phase 3's `echo "direct_stream=$direct"`).
**Change:** every run pins the prober off. `--prober` goes on top of phase 3's `--direct-stream` (direct streaming on, against phase 3's fake resolver) and turns the prober on, with a pass every 5 s. The fake `powershell.exe` reports an idle time from `<run>/movies/idle_ms`, `0` by default (someone is typing), so a verify run does not get past the idle gate; past it, the prober would resolve through phase 3's fake resolver, never the streaming Chrome.
**Code:** usage comment, after phase 3's `--direct-stream` lines:
```bash
#                                       --prober (needs --direct-stream) turns the stream prober on, a pass every
#                                       5 s; the fake powershell.exe reports $MOVIES/idle_ms (0: someone is
#                                       typing). --prober=off: the prober setting unset. Without either the prober
#                                       is pinned off.
```
In `cmd_up`, phase 3's flags line becomes `local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0 prober=""` and, after phase 3's `--direct-stream) direct=1; movies=1 ;;` case:
```bash
      --prober) prober=on ;;
      --prober=on|--prober=off) prober="${a#--prober=}" ;;
```
after the loop:
```bash
  [ -z "$prober" ] || [ "$direct" = 1 ] || die "up: --prober needs --direct-stream (direct streaming on, its fake resolver, the fake TMDB and fake powershell.exe)"
```
Replace the fake `powershell.exe` lines (151-152, the comment and the `printf`) with:
```bash
    # The fake powershell.exe: notesd runs it to put VLC's window in front (it finds no window) and,
    # with --prober, to read Windows' idle time, which it takes from movies/idle_ms (0: someone is typing).
    echo 0 >"$dir/movies/idle_ms"
    cat >"$dir/movies/bin/powershell.exe" <<EOF
#!/bin/sh
echo "\$(date -Is) \$#" >>"$dir/movies/vlc/powershell.log"
idle=\$(cat "$dir/movies/idle_ms" 2>/dev/null || echo 0)
echo "{\"found\":false,\"idle_ms\":\$idle}"
EOF
```
(the `chmod +x` line after it stays). After phase 3's direct-stream `env+=` block (its closing `fi`):
```bash
  # NOTESD_STREAM_PROBER=off unless --prober: a throwaway daemon never probes on its own. --prober=off
  # leaves the setting blank, which is how "unset" reaches the daemon (the real environment wins over
  # .env.local). Direct streaming itself is phase 3's --direct-stream (fake resolver).
  case "$prober" in
    on) env+=(NOTESD_STREAM_PROBER=on NOTESD_STREAM_PROBE_MS=5000) ;;
    off) env+=(NOTESD_STREAM_PROBER=) ;;
    *) env+=(NOTESD_STREAM_PROBER=off) ;;
  esac
```
In the meta block, after phase 3's `echo "direct_stream=$direct"`: `echo "prober=${prober:-pinned_off}"`.

**File:** `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs` (header comment, lines 1-6; helpers after `notFound`, line 92; routes in `route()` after the `/search/person` line, line 117)
**Code:** header comment, second line becomes `// with credits and videos, seasons, people, the prober's lists) and generated PNG posters on 127.0.0.1, on any free port.` Helpers:
```js
const byPopularity = (list) => [...list].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
// Every list has one page: page 2 and later are empty.
const firstPageOnly = (s, results) => (Number(s.get('page') ?? 1) > 1 ? [] : results)
function listOf(kind, keep = () => true) {
  return kind === 'movie' ? byPopularity(movies.filter(keep)).map(movieSummary) : byPopularity(tvs.filter(keep)).map(tvSummary)
}
function genresOf(kind) {
  const seen = new Map()
  for (const x of kind === 'movie' ? movies : tvs) for (const g of x.genres) seen.set(g.id, g.name)
  return [...seen].map(([id, name]) => ({ id, name }))
}
```
Routes:
```js
  // The stream prober's lists: trending and popular are every title of the kind by popularity,
  // discover keeps one genre, recommendations are the kind's other titles.
  if ((m = p.match(/^\/trending\/(movie|tv)\/(?:day|week)$/))) return [200, page(firstPageOnly(s, listOf(m[1])))]
  if ((m = p.match(/^\/(movie|tv)\/popular$/))) return [200, page(firstPageOnly(s, listOf(m[1])))]
  if ((m = p.match(/^\/genre\/(movie|tv)\/list$/))) return [200, { genres: genresOf(m[1]) }]
  if ((m = p.match(/^\/discover\/(movie|tv)$/))) {
    const want = s.get('with_genres')
    return [200, page(firstPageOnly(s, listOf(m[1], (x) => !want || x.genres.some((g) => String(g.id) === want))))]
  }
  if ((m = p.match(/^\/(movie|tv)\/(\d+)\/recommendations$/))) {
    const x = byId(m[1] === 'movie' ? movies : tvs, m[2])
    if (!x) return notFound()
    return [200, page(firstPageOnly(s, listOf(m[1], (y) => y.id !== x.id)))]
  }
```

**File:** `.claude/skills/verify-notesd/SKILL.md` (Launch block, after the `--movies` line; Gotchas, last bullet)
**Code:**
```sh
$V up --direct-stream --prober  # the stream prober on (a pass every 5 s) over phase 3's fake resolver; --prober=off: setting unset
```
Gotcha bullet:
```markdown
- `--prober` runs read Windows' idle time from `<run>/movies/idle_ms` (0 by default), so a pass stops at
  `not_idle` before any resolve. Raising it lets the prober resolve through the run's resolver, which under
  `--direct-stream` is phase 3's fake; never combine `--prober` with a real `NOTESD_DIRECT_STREAM_CLI`.
  Probing is proven by `tests/unit/directStream/prober.test.ts`.
```

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3's file: a bullet under `## Sub-features`, a block under its driving section) and `features/README.md` (append ", background prober (`--prober`)" to the direct-streaming row's feature cell)
**Code:** sub-feature:
```markdown
- The prober (off unless `NOTESD_STREAM_PROBER=on`): TMDB candidates become verified titles up to the
  catalog size, verified sources are re-checked before they go stale, and nothing is probed while the
  laptop is in use or something plays. Proven by `npx vitest run tests/unit/directStream` (fake clock,
  idle, TMDB and resolver), `npm run test:int -- tests/integration/streamProber.int.test.ts` (the SQL),
  and `GET /api/stream/prober` on `verify.sh up --direct-stream --prober` (candidates listed from the
  fake TMDB, the pass stopped at `not_idle`, nothing probed).
```
Driving:
```markdown
- Prober off: `$V up --direct-stream --prober=off`, then `$V api RUN GET /api/stream/prober` answers
  `enabled: false`, `off_reason: "setting_off"`; `stream_probe_titles` stays empty.
- Prober on: `$V up --direct-stream --prober`; after about 10 s `GET /api/stream/prober` has a `last_pass`
  with `stopped: "not_idle"` and `probed: 0`, and `stream_probe_titles` holds the fake TMDB's 5 films
  and 1 series as listed candidates. Never raise `<run>/movies/idle_ms` (see SKILL.md's gotcha).
```
**Impact:** the movies journey (`scripts/movies/journey.sh`) still sees `powershell.log` grow when VLC is put in front. `parseForegroundOutput` reads `found: false` and ignores the extra `idle_ms` key.

### Step 16: tests
**File:** `tests/unit/movies/tmdb.lists.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { createTmdbClient, DISCOVER_MIN_VOTES, type TmdbClientConfig } from '../../../src/movies/tmdb.js';

const CONFIG: TmdbClientConfig = { token: 't', apiKey: null, apiBase: 'http://tmdb.lists' };

/** Answers by pathname; records every URL. A path not in `routes` answers 404. */
function routedFetch(routes: Record<string, unknown>): { fetch: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    const body = routes[url.pathname];
    return body === undefined
      ? new Response('{"status_code":34}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, urls };
}

const MOVIES = { results: [{ id: 550, title: 'Fight Club', original_title: 'Fight Club', release_date: '1999-10-15', overview: '', poster_path: '/fc.jpg', popularity: 60, media_type: 'movie' }] };
const SHOWS = { results: [{ id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones', first_air_date: '2011-04-17', overview: '', poster_path: null, popularity: 90 }] };

describe('TmdbCatalog', () => {
  it('reads this week\'s trending films and the popular series, one page at a time', async () => {
    const f = routedFetch({ '/trending/movie/week': MOVIES, '/tv/popular': SHOWS });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.list('trending', 'movie', 2)).toEqual([
      { kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club', releaseDate: '1999-10-15', year: 1999, overview: '', posterPath: '/fc.jpg', popularity: 60 },
    ]);
    expect(f.urls[0]?.searchParams.get('page')).toBe('2');
    const [show] = await client.list('popular', 'tv');
    expect(show).toMatchObject({ kind: 'tv', tmdbId: 1399, title: 'Game of Thrones', year: 2011 });
    expect(f.urls[1]?.searchParams.get('page')).toBe('1');
  });

  it('lists genres and discovers one genre by popularity with a vote floor and no adult titles', async () => {
    const f = routedFetch({ '/genre/movie/list': { genres: [{ id: 18, name: 'Drama' }] }, '/discover/movie': MOVIES });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.genres('movie')).toEqual([{ id: 18, name: 'Drama' }]);
    await client.discoverByGenre('movie', 18);
    const q = f.urls[1]!.searchParams;
    expect([q.get('with_genres'), q.get('sort_by'), q.get('vote_count.gte'), q.get('include_adult')]).toEqual([
      '18',
      'popularity.desc',
      String(DISCOVER_MIN_VOTES),
      'false',
    ]);
  });

  it('answers [] for the recommendations of a title TMDB does not know', async () => {
    const f = routedFetch({ '/movie/550/recommendations': MOVIES });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect((await client.recommendations('movie', 550)).map((h) => h.tmdbId)).toEqual([550]);
    expect(await client.recommendations('tv', 42)).toEqual([]);
  });

  it('rejects a list of the wrong shape as bad_response', async () => {
    const f = routedFetch({ '/trending/tv/week': { results: [{ id: 'x' }] } });
    await expect(createTmdbClient(CONFIG, f.fetch).list('trending', 'tv')).rejects.toMatchObject({ name: 'TmdbError', code: 'bad_response' });
  });
});
```

**File:** `tests/unit/config.streamProber.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_STREAM_PROBER_CONFIG,
  defaultProbeBudget,
  loadConfig,
  parseStreamProber,
} from '../../src/config.js';

const DB = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a' };

describe('stream prober settings', () => {
  it('is off when NOTESD_STREAM_PROBER is unset, blank or off, with the default limits', () => {
    for (const env of [{}, { NOTESD_STREAM_PROBER: '' }, { NOTESD_STREAM_PROBER: 'off' }]) {
      expect(parseStreamProber(env)).toEqual(DEFAULT_STREAM_PROBER_CONFIG);
    }
    expect(DEFAULT_STREAM_PROBER_CONFIG).toMatchObject({ enabled: false, catalogSize: 300, idleSeconds: 600, probeMs: 1_200_000 });
    expect(DEFAULT_STREAM_PROBER_CONFIG.probeBudget).toBe(defaultProbeBudget(1_200_000));
  });

  it('reads every setting, and the budget default follows the pause between passes', () => {
    expect(
      parseStreamProber({ NOTESD_STREAM_PROBER: 'on', NOTESD_STREAM_CATALOG_SIZE: '50', NOTESD_STREAM_PROBE_BUDGET: '4', NOTESD_STREAM_IDLE_SECONDS: '120', NOTESD_STREAM_PROBE_MS: '300000' }),
    ).toEqual({ enabled: true, catalogSize: 50, probeBudget: 4, idleSeconds: 120, probeMs: 300_000 });
    expect(parseStreamProber({ NOTESD_STREAM_PROBE_MS: '300000' }).probeBudget).toBe(defaultProbeBudget(300_000));
  });

  it('refuses a bad value', () => {
    expect(() => parseStreamProber({ NOTESD_STREAM_PROBER: 'maybe' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_CATALOG_SIZE: '0' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_PROBE_BUDGET: '-1' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_IDLE_SECONDS: 'ten' })).toThrow(ConfigError);
  });

  it('lands in config.directStream.prober', () => {
    expect(loadConfig({ env: DB, envFile: false }).directStream?.prober.enabled).toBe(false);
    expect(loadConfig({ env: { ...DB, NOTESD_STREAM_PROBER: 'on' }, envFile: false }).directStream?.prober.enabled).toBe(true);
  });
});
```

**File:** `tests/unit/directStream/idle.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { detectIdleReader, IDLE_SCRIPT, IDLE_TIMEOUT_MS, parseIdleOutput, powershellIdleReader } from '../../../src/directStream/idle.js';
import type { DetectProbe } from '../../../src/http/reveal.js';
import { DEFAULT_POWERSHELL_EXE } from '../../../src/movies/vlc/health.js';
import type { ExecFn } from '../../../src/movies/vlc/http.js';
import { powershellArgs } from '../../../src/movies/vlc/incidents.js';

function probe(over: { platform?: NodeJS.Platform; env?: Record<string, string>; files?: string[]; exes?: string[] }): DetectProbe {
  return {
    platform: over.platform ?? 'linux',
    env: over.env ?? {},
    exists: async (p) => (over.files ?? ['/proc/sys/fs/binfmt_misc/WSLInterop']).includes(p),
    executable: async (p) => (over.exes ?? [DEFAULT_POWERSHELL_EXE]).includes(p),
  };
}

describe('idle time', () => {
  it('says why it cannot be read outside WSL or without powershell.exe', async () => {
    expect(await detectIdleReader(probe({ platform: 'darwin' }))).toEqual({ available: false, reason: 'not_linux' });
    expect(await detectIdleReader(probe({ files: [] }))).toEqual({ available: false, reason: 'no_interop' });
    expect(await detectIdleReader(probe({ exes: [] }))).toEqual({ available: false, reason: 'no_powershell' });
  });

  it('runs NOTESD_POWERSHELL_EXE when it is set', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: '{"idle_ms":1000}\r\n' };
    };
    const d = await detectIdleReader(probe({ env: { NOTESD_POWERSHELL_EXE: '/opt/ps' }, exes: ['/opt/ps'] }), exec);
    if (!d.available) throw new Error('expected a reader');
    expect(await d.read()).toEqual({ kind: 'ok', idleSeconds: 1 });
    expect(calls).toEqual(['/opt/ps']);
  });

  it('asks GetLastInputInfo through an encoded script with a timeout', async () => {
    let seen: { args: string[]; timeout: number } | null = null;
    const exec: ExecFn = async (_cmd, args, timeout) => {
      seen = { args, timeout };
      return { exitCode: 0, stdout: 'noise\n{"idle_ms":754999}\n' };
    };
    expect(await powershellIdleReader('/ps', exec)()).toEqual({ kind: 'ok', idleSeconds: 754 });
    expect(seen).toEqual({ args: powershellArgs(IDLE_SCRIPT), timeout: IDLE_TIMEOUT_MS });
    expect(IDLE_SCRIPT).toContain('GetLastInputInfo');
  });

  it('turns a failed or unreadable run into an error reading', async () => {
    expect(await powershellIdleReader('/ps', async () => ({ exitCode: 1, stdout: '' }))()).toEqual({ kind: 'error', message: 'powershell.exe exited 1' });
    expect(await powershellIdleReader('/ps', async () => ({ exitCode: 0, stdout: '{"found":false}' }))()).toEqual({ kind: 'error', message: 'unreadable idle output' });
    expect(parseIdleOutput('{"idle_ms":-1}')).toBeNull();
    expect(parseIdleOutput('{"found":false,"idle_ms":3600000}')).toBe(3600);
  });
});
```

**File:** `tests/unit/directStream/candidates.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { gatherCandidates, pickSeeds, rankKind, roundRobin, topGenres, type SeedTitle } from '../../../src/directStream/candidates.js';
import { TmdbError, type TitleKind, type TmdbCatalog, type TmdbSearchHit } from '../../../src/movies/tmdb.js';

const TODAY = '2026-11-15';
function hit(kind: TitleKind, tmdbId: number, releaseDate: string | null = '2020-01-01'): TmdbSearchHit {
  return { kind, tmdbId, title: `T${tmdbId}`, originalTitle: `T${tmdbId}`, releaseDate, year: 2020, overview: '', posterPath: null, popularity: 1 };
}
function seed(tmdbId: number, rating: number | null, finishedAt: string, genres: string[] = [], kind: TitleKind = 'movie'): SeedTitle {
  return { kind, tmdbId, rating, finishedAt, genres };
}

describe('candidates', () => {
  it('seeds: rated 4-5 first, then unrated by newest finish; 0-3 is no seed', () => {
    const seeds = pickSeeds([
      seed(1, null, '2026-01-01'),
      seed(2, 5, '2025-01-01'),
      seed(3, 3, '2026-06-01'),
      seed(4, null, '2026-09-01'),
      seed(5, 4, '2026-02-01'),
    ]);
    expect(seeds.map((s) => s.tmdbId)).toEqual([2, 5, 4, 1]);
    expect(topGenres([seed(1, null, '', ['Drama', 'Crime']), seed(2, null, '', ['Drama'])])).toEqual(['Drama', 'Crime']);
  });

  it('merges round-robin and keeps each title once', () => {
    expect(roundRobin([[1, 2, 3], [9, 2], [4]], String)).toEqual([1, 9, 4, 2, 3]);
  });

  it('ranks one kind across sources, dropping unreleased titles and the other kind', () => {
    const ranked = rankKind(
      'movie',
      {
        recommended: [[hit('movie', 10), hit('movie', 11)]],
        genre: [[hit('movie', 20, '2027-01-01')]],
        trending: [[hit('movie', 30), hit('tv', 31), hit('movie', 10)]],
        popular: [[hit('movie', 40, null)]],
      },
      TODAY,
    );
    expect(ranked).toEqual([
      { kind: 'movie', tmdbId: 10, source: 'recommended', rank: 0 },
      { kind: 'movie', tmdbId: 30, source: 'trending', rank: 1 },
      { kind: 'movie', tmdbId: 11, source: 'recommended', rank: 2 },
    ]);
  });

  it('reads recommendations per seed and the seeds\' genres, and survives one failing list', async () => {
    const calls: string[] = [];
    const tmdb: TmdbCatalog = {
      async list(name, kind, page = 1) {
        calls.push(`${name}:${kind}:${page}`);
        if (name === 'popular' && kind === 'tv') throw new TmdbError('http', 'TMDB /tv/popular returned 500', 500);
        return page === 1 ? [hit(kind, kind === 'movie' ? 100 : 200)] : [];
      },
      async genres(kind) {
        calls.push(`genres:${kind}`);
        return [{ id: 18, name: 'Drama' }];
      },
      async discoverByGenre(kind, id) {
        calls.push(`discover:${kind}:${id}`);
        return [hit(kind, kind === 'movie' ? 101 : 201)];
      },
      async recommendations(kind, id) {
        calls.push(`rec:${kind}:${id}`);
        return [hit(kind, 102)];
      },
    };
    const got = await gatherCandidates(tmdb, [seed(7, 5, '2026-01-01', ['Drama'])], TODAY);
    expect(calls).toContain('rec:movie:7');
    expect(calls).not.toContain('rec:tv:7');
    expect(calls).toContain('discover:movie:18');
    expect(got.entries.filter((e) => e.kind === 'movie').map((e) => [e.tmdbId, e.source])).toEqual([
      [102, 'recommended'],
      [101, 'genre'],
      [100, 'trending'],
    ]);
    expect(got.entries.filter((e) => e.kind === 'tv').map((e) => e.tmdbId)).toEqual([201, 200]);
    expect(got.errors).toHaveLength(2);
    expect(got.errors[0]).toContain('tv popular page 1');
  });
});
```

**File:** `tests/unit/directStream/prober.test.ts` (new). The resolver fake stands in for `DirectStreamService.resolve` with phase 3's fake runner: on success it writes what phase 5's hook writes (a verified source) into the in-memory store, and on failure it marks the source stale and rejects with a coded error.
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAM_PROBER_CONFIG, loadConfig, type StreamProberConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { StreamProbeListSource } from '../../../src/db/schema.js';
import type { ListedCandidate } from '../../../src/directStream/candidates.js';
import type { IdleReader } from '../../../src/directStream/idle.js';
import {
  BACKOFF_BASE_MS,
  buildStreamProber,
  classifyResolve,
  interleave,
  StreamProber,
  type ProbeOutcome,
  type ProbeRecord,
  type ProbeRef,
  type ProbeStore,
  type ProbeTarget,
} from '../../../src/directStream/prober.js';
import type { MoviesService } from '../../../src/movies/service.js';
import type { TitleKind, TmdbCatalog, TmdbSearchHit } from '../../../src/movies/tmdb.js';

const HOST = 'host-a';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-15T00:00:00Z');

class Clock {
  constructor(public t: number) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Src { titleId: string; kind: TitleKind; tmdbId: number; season: number; episode: number; verifiedAt: Date | null; staleAt: Date | null }
interface Row { kind: TitleKind; tmdbId: number; listSource: StreamProbeListSource | null; listRank: number | null; listedAt: Date | null; outcome: ProbeOutcome | null; failures: number; retryAfter: Date | null }

/** ProbeRepo's rules in memory; tests/integration/streamProber.int.test.ts proves the SQL keeps the same ones. */
class MemoryStore implements ProbeStore {
  sources: Src[] = [];
  rows = new Map<string, Row>();
  playOpen = false;
  private key(kind: TitleKind, id: number): string {
    return `${kind}-${id}`;
  }
  /** Phase 5's isFreshStreamSource rule: verified inside the window and not stale. */
  private isFresh(s: Src, since: Date): boolean {
    return s.verifiedAt !== null && s.verifiedAt >= since && s.staleAt === null;
  }
  row(kind: TitleKind, tmdbId: number): Row {
    const k = this.key(kind, tmdbId);
    let r = this.rows.get(k);
    if (r === undefined) {
      r = { kind, tmdbId, listSource: null, listRank: null, listedAt: null, outcome: null, failures: 0, retryAfter: null };
      this.rows.set(k, r);
    }
    return r;
  }
  verify(kind: TitleKind, tmdbId: number, at: Date, season = 0, episode = 0): void {
    const titleId = this.key(kind, tmdbId);
    const s = this.sources.find((x) => x.titleId === titleId && x.season === season && x.episode === episode);
    if (s === undefined) this.sources.push({ titleId, kind, tmdbId, season, episode, verifiedAt: at, staleAt: null });
    else Object.assign(s, { verifiedAt: at, staleAt: null });
  }
  stale(kind: TitleKind, tmdbId: number, at: Date): void {
    for (const s of this.sources) if (s.titleId === this.key(kind, tmdbId)) s.staleAt = at;
  }
  async freshCount(_host: string, since: Date): Promise<number> {
    return new Set(this.sources.filter((s) => this.isFresh(s, since)).map((s) => s.titleId)).size;
  }
  async dueRechecks(_host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]> {
    return this.sources
      .filter((s) => s.verifiedAt !== null && s.verifiedAt <= dueBefore && s.staleAt === null)
      .sort((a, b) => a.verifiedAt!.getTime() - b.verifiedAt!.getTime())
      .slice(0, limit)
      .map((s) => ({ kind: s.kind, tmdbId: s.tmdbId, season: s.kind === 'tv' ? s.season : null, episode: s.kind === 'tv' ? s.episode : null }));
  }
  async listedAt(): Promise<Date | null> {
    const times = [...this.rows.values()].map((r) => r.listedAt?.getTime() ?? Number.NEGATIVE_INFINITY);
    const latest = Math.max(Number.NEGATIVE_INFINITY, ...times);
    return Number.isFinite(latest) ? new Date(latest) : null;
  }
  async replaceListing(_host: string, entries: readonly ListedCandidate[], at: Date): Promise<void> {
    for (const r of this.rows.values()) Object.assign(r, { listSource: null, listRank: null, listedAt: null });
    for (const e of entries) Object.assign(this.row(e.kind, e.tmdbId), { listSource: e.source, listRank: e.rank, listedAt: at });
  }
  async eligible(_host: string, kind: TitleKind, now: Date, since: Date, limit: number): Promise<ProbeTarget[]> {
    return [...this.rows.values()]
      .filter((r) => r.kind === kind && r.listSource !== null && (r.retryAfter === null || r.retryAfter <= now))
      .filter((r) => !this.sources.some((s) => s.titleId === this.key(r.kind, r.tmdbId) && this.isFresh(s, since)))
      .sort((a, b) => a.listRank! - b.listRank!)
      .slice(0, limit)
      .map((r) => ({ kind: r.kind, tmdbId: r.tmdbId, season: null, episode: null }));
  }
  async failures(_host: string, kind: TitleKind, tmdbId: number): Promise<number> {
    return this.rows.get(this.key(kind, tmdbId))?.failures ?? 0;
  }
  async record(_host: string, r: ProbeRecord): Promise<void> {
    Object.assign(this.row(r.kind, r.tmdbId), { outcome: r.outcome, failures: r.failures, retryAfter: r.retryAfter });
  }
  async activePlay(): Promise<boolean> {
    return this.playOpen;
  }
}

function hit(kind: TitleKind, tmdbId: number): TmdbSearchHit {
  return { kind, tmdbId, title: `T${tmdbId}`, originalTitle: `T${tmdbId}`, releaseDate: '2020-01-01', year: 2020, overview: '', posterPath: null, popularity: 1 };
}

function fakeTmdb(films: number[], series: number[]): TmdbCatalog & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async list(name, kind, page = 1) {
      calls.push(`${name}:${kind}:${page}`);
      return page > 1 ? [] : (kind === 'movie' ? films : series).map((id) => hit(kind, id));
    },
    async genres(kind) {
      calls.push(`genres:${kind}`);
      return [];
    },
    async discoverByGenre() {
      return [];
    },
    async recommendations() {
      return [];
    },
  };
}

type Answer = 'ok' | 'no_source' | 'error' | 'no_chrome' | 'deadline';

function setup(opts: { config?: Partial<StreamProberConfig>; films?: number[]; series?: number[]; resolveSeconds?: number } = {}) {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const idle = { seconds: 3600, reads: 0, fail: false };
  const reader: IdleReader = async () => {
    idle.reads += 1;
    return idle.fail ? { kind: 'error', message: 'boom' } : { kind: 'ok', idleSeconds: idle.seconds };
  };
  const answers = new Map<string, Answer>();
  const calls: ProbeRef[] = [];
  const deadlines: number[] = [];
  const hooks: { afterCall?: (ref: ProbeRef) => void } = {};
  // Phase 3's DirectStreamService.resolve: phase 5's hook writes verified (or stale on no_source) before it answers;
  // a failure rejects like DirectStreamError (code no_source, or resolve_failed with a reason).
  const resolve = async (ref: ProbeRef, options: { deadlineS: number }): Promise<unknown> => {
    calls.push(ref);
    deadlines.push(options.deadlineS);
    clock.advance((opts.resolveSeconds ?? 3) * 1000);
    hooks.afterCall?.(ref);
    const answer = answers.get(`${ref.kind}-${ref.tmdbId}`) ?? 'ok';
    if (answer === 'ok') {
      store.verify(ref.kind, ref.tmdbId, clock.now(), ref.season ?? 0, ref.episode ?? 0);
      return { session_id: 's' };
    }
    if (answer === 'no_source') {
      store.stale(ref.kind, ref.tmdbId, clock.now());
      throw Object.assign(new Error(answer), { code: 'no_source' });
    }
    if (answer === 'error') throw Object.assign(new Error(answer), { code: 'resolve_failed', reason: 'script_failed' });
    throw Object.assign(new Error(answer), { code: 'resolve_failed', reason: answer });
  };
  const tmdb = fakeTmdb(opts.films ?? [], opts.series ?? []);
  const vlc = { playing: false };
  const logs: string[] = [];
  const prober = new StreamProber({
    config: { ...DEFAULT_STREAM_PROBER_CONFIG, enabled: true, ...opts.config },
    freshDays: 7,
    host: HOST,
    store,
    tmdb,
    seeds: async () => [],
    resolve,
    idle: reader,
    vlcPlaying: () => vlc.playing,
    now: clock.now,
    log: (line) => logs.push(line),
  });
  return { clock, store, idle, answers, calls, deadlines, hooks, tmdb, vlc, logs, prober };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('R6.2: off opens nothing', () => {
  const DB_ENV = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a' };

  for (const [label, env] of [
    ['unset', DB_ENV],
    ['off', { ...DB_ENV, NOTESD_STREAM_PROBER: 'off' }],
  ] as const) {
    it(`off starts nothing with NOTESD_STREAM_PROBER ${label}: no timer, no resolve, no idle read, no TMDB call in two days`, async () => {
      vi.useFakeTimers();
      const config = loadConfig({ env, envFile: false });
      const { calls, idle, tmdb, store } = setup();
      let resolves = 0;
      const handle = await buildStreamProber(
        {
          config,
          db: {} as Db,
          movies: { host: HOST } as unknown as MoviesService,
          moviesPlayer: null,
          directStream: {
            resolve: async () => {
              resolves += 1;
              return {};
            },
          },
        },
        { idle: { available: true, read: async () => ({ kind: 'ok', idleSeconds: 99_999 }) }, tmdb, store },
      );
      handle.start();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * DAY);
      expect(handle.enabled).toBe(false);
      expect(resolves + calls.length + idle.reads + tmdb.calls.length).toBe(0);
      expect(await handle.status()).toMatchObject({ enabled: false, off_reason: 'setting_off', last_pass: null });
      expect(handle.startLine()).toBe('[notesd] stream prober off: NOTESD_STREAM_PROBER is off (the default)');
    });
  }

  it('on, it is the setting alone that builds the loop; without powershell.exe it stays off and says why', async () => {
    const config = loadConfig({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a', NOTESD_STREAM_PROBER: 'on', TMDB_API_KEY: 'k' }, envFile: false });
    const base = { config, db: {} as Db, movies: { host: HOST } as unknown as MoviesService, moviesPlayer: null, directStream: { resolve: async () => ({}) } };
    const { tmdb, store } = setup();
    const on = await buildStreamProber(base, { idle: { available: true, read: async () => ({ kind: 'ok', idleSeconds: 0 }) }, tmdb, store });
    expect(on.enabled).toBe(true);
    await on.close();
    const off = await buildStreamProber(base, { idle: { available: false, reason: 'no_powershell' }, tmdb, store });
    expect(await off.status()).toMatchObject({ enabled: false, off_reason: 'no_powershell' });
    expect(await buildStreamProber({ ...base, directStream: null }, { tmdb, store })).toMatchObject({ enabled: false, reason: 'direct_stream_off' });
  });
});

describe('R6.3: no probe while the laptop is in use', () => {
  it('not idle starts nothing', async () => {
    const t = setup({ films: [1, 2, 3] });
    t.idle.seconds = 30;
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([]);
    expect(pass).toMatchObject({ stopped: 'not_idle', idle_s: 30, probed: 0, rechecked: 0 });
    expect(pass.listed).toBe(3);
  });

  it('an idle time that cannot be read counts as not idle', async () => {
    const t = setup({ films: [1] });
    t.idle.fail = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'not_idle', probed: 0, error: 'idle time unreadable: boom' });
    expect(t.calls).toEqual([]);
  });

  it('a VLC play or an open stream play starts nothing', async () => {
    const t = setup({ films: [1] });
    t.vlc.playing = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'busy', busy: 'vlc' });
    t.vlc.playing = false;
    t.store.playOpen = true;
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'busy', busy: 'play' });
    expect(t.calls).toEqual([]);
  });

  it('stops between probes as soon as the laptop is no longer idle', async () => {
    const t = setup({ films: [1, 2, 3] });
    t.hooks.afterCall = () => {
      t.idle.seconds = 5;
    };
    const pass = await t.prober.passNow();
    expect(t.calls).toHaveLength(1);
    expect(pass).toMatchObject({ stopped: 'not_idle', probed: 1, probe_verified: 1 });
  });
});

describe('R6.1: candidates become verified titles within the budget', () => {
  it('turns TMDB candidates into verified titles, films first, a series by its first episode', async () => {
    const t = setup({ films: [1, 2, 3, 4], series: [9] });
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([
      { kind: 'movie', tmdbId: 1 },
      { kind: 'movie', tmdbId: 2 },
      { kind: 'movie', tmdbId: 3 },
      { kind: 'tv', tmdbId: 9, season: 1, episode: 1 },
      { kind: 'movie', tmdbId: 4 },
    ]);
    expect(pass).toMatchObject({ probed: 5, probe_verified: 5, catalog_fresh: 5, stopped: 'no_candidates' });
    expect(t.logs.at(-1)).toContain('5 probed (5 verified)');
  });

  it('the catalog stops at its size', async () => {
    const t = setup({ films: [1, 2, 3, 4, 5], config: { catalogSize: 2 } });
    t.store.verify('movie', 99, new Date(T0 - DAY));
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([{ kind: 'movie', tmdbId: 1 }]);
    expect(pass).toMatchObject({ stopped: 'catalog_full', catalog_fresh: 2 });
  });

  it('a pass stays inside its probe budget', async () => {
    const t = setup({ films: [1, 2, 3, 4, 5, 6], config: { probeBudget: 3 } });
    expect(await t.prober.passNow()).toMatchObject({ probed: 3, stopped: 'probe_budget' });
    expect(t.calls).toHaveLength(3);
  });

  it('a pass stays inside its seconds: half of NOTESD_STREAM_PROBE_MS', async () => {
    const t = setup({ films: [1, 2, 3, 4], config: { probeMs: 60_000 }, resolveSeconds: 20 });
    expect(await t.prober.passNow()).toMatchObject({ probed: 2, stopped: 'time_budget' });
  });

  it('gives each resolve the seconds left in the pass, and a resolve cut by that deadline blames no title', async () => {
    const t = setup({ films: [1, 2], config: { probeMs: 60_000 }, resolveSeconds: 10 });
    t.answers.set('movie-2', 'deadline');
    const pass = await t.prober.passNow();
    expect(t.deadlines).toEqual([30, 20]);
    expect(pass).toMatchObject({ probed: 1, probe_verified: 1, failed: 0, stopped: 'time_budget' });
    expect(t.store.row('movie', 2)).toMatchObject({ outcome: null, failures: 0 });
  });

  it('a source older than the freshness window is re-checked first, then those nearest its end; recent ones are not', async () => {
    const t = setup({ films: [50] });
    t.store.verify('movie', 10, new Date(T0 - 6 * DAY));
    t.store.verify('movie', 11, new Date(T0 - 8 * DAY));
    t.store.verify('tv', 12, new Date(T0 - 5 * DAY), 2, 3);
    t.store.verify('movie', 13, new Date(T0 - 1 * DAY));
    const pass = await t.prober.passNow();
    expect(t.calls).toEqual([
      { kind: 'movie', tmdbId: 11 },
      { kind: 'movie', tmdbId: 10 },
      { kind: 'tv', tmdbId: 12, season: 2, episode: 3 },
      { kind: 'movie', tmdbId: 50 },
    ]);
    expect(pass).toMatchObject({ rechecked: 3, recheck_verified: 3, probed: 1 });
  });

  it('never probes a title already verified fresh', async () => {
    const t = setup({ films: [1, 2] });
    t.store.verify('movie', 1, new Date(T0 - DAY));
    await t.prober.passNow();
    expect(t.calls).toEqual([{ kind: 'movie', tmdbId: 2 }]);
  });

  it('a title that fails waits out its backoff, which doubles', async () => {
    const t = setup({ films: [1] });
    t.answers.set('movie-1', 'no_source');
    expect(await t.prober.passNow()).toMatchObject({ probed: 1, failed: 1 });
    expect(t.store.row('movie', 1)).toMatchObject({ outcome: 'no_source', failures: 1 });
    t.clock.advance(20 * 60_000);
    await t.prober.passNow();
    expect(t.calls).toHaveLength(1);
    t.clock.advance(BACKOFF_BASE_MS);
    await t.prober.passNow();
    expect(t.calls).toHaveLength(2);
    expect(t.store.row('movie', 1).failures).toBe(2);
    expect(t.store.row('movie', 1).retryAfter!.getTime() - t.clock.t).toBe(2 * BACKOFF_BASE_MS);
  });

  it('a resolve that cannot reach Chrome ends the pass and blames no title', async () => {
    const t = setup({ films: [1, 2] });
    t.answers.set('movie-1', 'no_chrome');
    expect(await t.prober.passNow()).toMatchObject({ stopped: 'chrome_unavailable', probed: 0, failed: 0 });
    expect(t.store.row('movie', 1)).toMatchObject({ outcome: null, failures: 0 });
  });

  it('reads both shapes of a failed resolve, and interleaves one series in four', () => {
    expect(classifyResolve({ ok: true, value: { ok: false, error: 'no_source' } })).toBe('no_source');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'chrome_not_reachable' }) })).toBe('chrome_unavailable');
    expect(classifyResolve({ ok: false, error: new Error('boom') })).toBe('error');
    expect(classifyResolve({ ok: true, value: { session_id: 's' } })).toBe('verified');
    // Phase 3's DirectStreamError: resolve_failed names its cause in `reason`.
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'no_chrome' }) })).toBe('chrome_unavailable');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'deadline' }) })).toBe('deadline');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'resolve_failed', reason: 'script_failed' }) })).toBe('error');
    expect(classifyResolve({ ok: false, error: Object.assign(new Error('x'), { code: 'no_source', attempts: [] }) })).toBe('no_source');
    expect(interleave(['a', 'b', 'c', 'd', 'e'], ['X', 'Y'], 4)).toEqual(['a', 'b', 'c', 'X', 'd', 'e', 'Y']);
  });

  it('rebuilds the listing once a day, not every pass', async () => {
    const t = setup({ films: [1] });
    await t.prober.passNow();
    const listCalls = t.tmdb.calls.length;
    t.clock.advance(60 * 60_000);
    await t.prober.passNow();
    expect(t.tmdb.calls.length).toBe(listCalls);
    t.clock.advance(DAY);
    await t.prober.passNow();
    expect(t.tmdb.calls.length).toBeGreaterThan(listCalls);
  });
});
```

**File:** `tests/unit/directStream/proberDefaults.test.ts` (new)
```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIMINGS,
  defaultProbeBudget,
  probePassSeconds,
  probeSecondsPerTitle,
  REPO_ROOT,
  SPIKE_PROBE_TIMINGS,
  type ProbeTimings,
} from '../../../src/config.js';

const FINDINGS = path.join(REPO_ROOT, 'docs', 'plans', '2026-11-15-direct-streaming-findings.md');
const KEYS = ['median_resolve_s', 'median_fail_s', 'median_failed_before_resolve'] as const;

/**
 * Phase 2's `campaign:timings` block (its schema 1 is the contract): `resolve_s.p50` is the median
 * resolve, `fail_s.p50` the median failure. It has no failed-before-resolve figure, so that key
 * stays the spike's. Null when the block is missing.
 */
function timingsBlock(markdown: string): Partial<ProbeTimings> | null {
  const m = /<!-- campaign:timings:begin -->[\s\S]*?```json[^\n]*\n([\s\S]*?)```[\s\S]*?<!-- campaign:timings:end -->/.exec(markdown);
  if (m === null) return null;
  const o = JSON.parse(m[1] ?? '') as { resolve_s?: { p50?: unknown } | null; fail_s?: { p50?: unknown } | null };
  const out: Partial<ProbeTimings> = {};
  if (typeof o.resolve_s?.p50 === 'number') out.median_resolve_s = o.resolve_s.p50;
  if (typeof o.fail_s?.p50 === 'number') out.median_fail_s = o.fail_s.p50;
  return out;
}

describe('prober defaults', () => {
  it('DEFAULT_PROBE_TIMINGS are the resolve campaign\'s timings, a spike number where the block has none', () => {
    expect(existsSync(FINDINGS)).toBe(true);
    const block = timingsBlock(readFileSync(FINDINGS, 'utf8'));
    expect(block, 'the findings file has no ```json timings block').not.toBeNull();
    for (const k of KEYS) expect(DEFAULT_PROBE_TIMINGS[k], k).toBe(block?.[k] ?? SPIKE_PROBE_TIMINGS[k]);
  });

  it('derives the budget: half the pause between passes, divided by one title\'s seconds', () => {
    expect(probeSecondsPerTitle(SPIKE_PROBE_TIMINGS)).toBe(38);
    expect(probePassSeconds(1_200_000)).toBe(600);
    expect(defaultProbeBudget(1_200_000, SPIKE_PROBE_TIMINGS)).toBe(15);
    expect(defaultProbeBudget(10_000, SPIKE_PROBE_TIMINGS)).toBe(1);
  });
});
```

**File:** `tests/unit/directStream/proberRoute.test.ts` (new)
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { DisabledProber } from '../../../src/directStream/prober.js';
import { streamProberRoutes } from '../../../src/http/streamProberApi.js';

function app(deps: Partial<AppDeps>): Hono {
  const a = new Hono();
  a.route('/', streamProberRoutes(deps as AppDeps));
  return a;
}

describe('GET /api/stream/prober', () => {
  it('answers direct_stream_off without direct streaming', async () => {
    const res = await app({ directStream: null } as Partial<AppDeps>).request('/api/stream/prober');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'direct_stream_off' });
  });

  it('reports the prober off with its reason', async () => {
    const deps = { directStream: {}, streamProber: new DisabledProber('no_interop') } as unknown as Partial<AppDeps>;
    const res = await app(deps).request('/api/stream/prober');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, off_reason: 'no_interop', last_pass: null });
  });
});
```

**File:** `tests/integration/streamProber.int.test.ts` (new). Seeds `movie_stream_sources` with raw SQL on the Shared-contracts columns. If phase 5's table has another `NOT NULL` column without a default, add it to `source()` here.
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ProbeRepo } from '../../src/directStream/repo.js';
import { closeTestDb, openTestDb } from './setup.js';
import { seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HERE = 'probe-host-a';
const OTHER = 'probe-host-b';
const DAY = 86_400_000;
const NOW = new Date('2026-11-15T12:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let db: Db;
let repo: ProbeRepo;

/** A phase 5 row; a stale one names its failure (movie_stream_sources_failure_check). */
async function source(titleId: string, host: string, verifiedAt: Date | null, staleAt: Date | null = null, season = 0, episode = 0): Promise<void> {
  const failure = staleAt === null ? null : 'no_source';
  await db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure)
    values (${titleId}, ${season}, ${episode}, ${host}, 'VidFast', 'hls', 1080, true, ${verifiedAt}, ${staleAt}, ${failure})`);
}

beforeAll(() => {
  db = openTestDb();
  repo = new ProbeRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`truncate table stream_probe_titles, movie_stream_sources`);
  await truncateMovies(db);
  for (const [id, kind, tmdbId] of [
    ['movie-1', 'movie', 1],
    ['movie-2', 'movie', 2],
    ['movie-3', 'movie', 3],
    ['movie-4', 'movie', 4],
    ['movie-5', 'movie', 5],
    ['tv-9', 'tv', 9],
  ] as const) {
    await seedTitle(db, { id, kind, tmdbId, title: id });
  }
});

describe('ProbeRepo (R6.1)', () => {
  it('counts fresh titles on this host only, once per title, and not stale or expired ones', async () => {
    await source('movie-1', HERE, ago(1));
    await source('movie-2', OTHER, ago(1));
    await source('movie-3', HERE, ago(2), ago(1));
    await source('movie-4', HERE, ago(8));
    await source('tv-9', HERE, ago(1), null, 1, 1);
    await source('tv-9', HERE, ago(2), null, 1, 2);
    expect(await repo.freshCount(HERE, ago(7))).toBe(2);
  });

  it('lists due re-checks oldest first, with a series episode named, skipping stale and recent ones', async () => {
    await source('movie-1', HERE, ago(1));
    await source('movie-4', HERE, ago(8));
    await source('movie-5', HERE, ago(6));
    await source('movie-3', HERE, ago(9), ago(1));
    await source('tv-9', HERE, ago(5.5), null, 2, 3);
    await source('movie-2', OTHER, ago(9));
    expect(await repo.dueRechecks(HERE, ago(4.9), 10)).toEqual([
      { kind: 'movie', tmdbId: 4, season: null, episode: null },
      { kind: 'movie', tmdbId: 5, season: null, episode: null },
      { kind: 'tv', tmdbId: 9, season: 2, episode: 3 },
    ]);
  });

  it('replaces the listing and offers only listed titles that are out of backoff and not fresh, best rank first', async () => {
    await repo.replaceListing(HERE, [
      { kind: 'movie', tmdbId: 1, source: 'trending', rank: 0 },
      { kind: 'movie', tmdbId: 2, source: 'recommended', rank: 1 },
      { kind: 'movie', tmdbId: 3, source: 'popular', rank: 2 },
      { kind: 'tv', tmdbId: 9, source: 'trending', rank: 0 },
    ], ago(0.1));
    await source('movie-1', HERE, ago(1));
    await repo.record(HERE, { kind: 'movie', tmdbId: 3, outcome: 'no_source', probedAt: NOW, failures: 1, retryAfter: new Date(NOW.getTime() + DAY) });
    expect((await repo.eligible(HERE, 'movie', NOW, ago(7), 10)).map((t) => t.tmdbId)).toEqual([2]);
    expect((await repo.eligible(HERE, 'movie', new Date(NOW.getTime() + DAY + 1), ago(7), 10)).map((t) => t.tmdbId)).toEqual([2, 3]);
    expect(await repo.eligible(HERE, 'tv', NOW, ago(7), 10)).toEqual([{ kind: 'tv', tmdbId: 9, season: null, episode: null }]);
    expect(await repo.eligible(OTHER, 'movie', NOW, ago(7), 10)).toEqual([]);
    expect(await repo.listedAt(HERE)).toEqual(ago(0.1));

    await repo.replaceListing(HERE, [{ kind: 'movie', tmdbId: 3, source: 'genre', rank: 0 }], NOW);
    expect((await repo.eligible(HERE, 'movie', new Date(NOW.getTime() + 2 * DAY), ago(7), 10)).map((t) => t.tmdbId)).toEqual([3]);
    expect(await repo.failures(HERE, 'movie', 3)).toBe(1);
  });

  it('records outcomes: verified clears the backoff', async () => {
    await repo.record(HERE, { kind: 'movie', tmdbId: 4, outcome: 'error', probedAt: NOW, failures: 2, retryAfter: new Date(NOW.getTime() + 2 * DAY) });
    expect(await repo.failures(HERE, 'movie', 4)).toBe(2);
    await repo.record(HERE, { kind: 'movie', tmdbId: 4, outcome: 'verified', probedAt: NOW, failures: 0, retryAfter: null });
    expect(await repo.failures(HERE, 'movie', 4)).toBe(0);
  });

  it('refuses rows the prober must never hold', async () => {
    await expect(db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, list_source) values (${HERE}, 'movie', 7, 'trending')`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, outcome, probed_at, failures) values (${HERE}, 'movie', 7, 'verified', now(), 1)`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, outcome, probed_at, failures) values (${HERE}, 'movie', 7, 'no_source', now(), 1)`),
    ).rejects.toThrow();
  });

  it('sees an open, recently updated play on this host as active', async () => {
    const fileId = await seedFile(db, { titleId: 'movie-1', host: HERE, path: '/v/one.mkv' });
    expect(await repo.activePlay(HERE, ago(1 / 96))).toBe(false);
    await seedPlay(db, { fileId, host: HERE, positionS: 10, durationS: 100, startedAt: NOW, endedAt: null });
    expect(await repo.activePlay(HERE, ago(1 / 96))).toBe(true);
    expect(await repo.activePlay(OTHER, ago(1 / 96))).toBe(false);
    expect(await repo.activePlay(HERE, new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it('reads stored genres for seed titles', async () => {
    await db.execute(sql`update movie_titles set genres = '["Drama","Crime"]'::jsonb where id = 'movie-2'`);
    expect(await repo.titleGenres(['movie-2', 'movie-9'])).toEqual(new Map([['movie-2', ['Drama', 'Crime']]]));
  });
});
```
**Impact:** test-only. `seedPlay` from `moviesPlaySeed.ts` types `source` as `'live' | 'vlc_recents'` and requires `fileId`; that is enough here, because a VLC play is a `movie_plays` row on this host like a stream play.

## Principles applied

- Laziness protocol: `TmdbCatalog` is a separate interface returned beside `TmdbClient`, so the three existing `TmdbClient` fakes need no edit. The idle check reuses the VLC code's `resolveWindowsExe`, `powershellArgs` and `lastJsonLine`. Seeds come from `listTitles`'s `finished` filter (state.ts) instead of a new watch-state query.
- Make illegal states unrepresentable: `stream_probe_titles` CHECKs make "listed" one state of three columns (`list_source`/`list_rank`/`listed_at` all set or all null), tie `outcome` to `probed_at`, and allow only two probed states: `verified` with no failures and no backoff, or a failure with a count above zero and a `retry_after`. The integration test proves the database refuses the bad rows.
- Boundary discipline: env is parsed once in `parseStreamProber`; TMDB lists are validated by zod in `tmdb.ts`; phase 3's resolve answer (its `DirectStreamError` `code` / `reason`) is read once in `classifyResolve`; freshness is phase 5's one rule (`freshStreamSourceSql`, `streamFreshSince`); idle output is parsed once in `parseIdleOutput`. The loop trusts those values.
- Build the lever: `proberDefaults.test.ts` reads the findings file's timings block and fails when `DEFAULT_PROBE_TIMINGS` drift from it, so "defaults from phase 2's timings" is checked by a test, not by reading a diff.
- Prove it works: the real daemon is driven with `verify.sh up --direct-stream --prober` (candidates listed from TMDB, the pass held at `not_idle`) and `--direct-stream --prober=off` (nothing listed, nothing probed). Fail closed on an unreadable idle time keeps those runs safe.
- Test behavior, not implementation: the prober tests drive `passNow()`, `status()` and `buildStreamProber` and observe resolve calls, stored outcomes and summaries. The in-memory store follows the same rules as `ProbeRepo`, and the integration test proves the SQL does too.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int -- tests/integration/streamProber.int.test.ts && npm run docs:check`
**Proof:** the prober's real effects on a throwaway daemon (`verify.sh up --direct-stream`, whose resolver is phase 3's fake), and its probing logic under a fake clock, idle, TMDB and resolver. Real probing (resolving through the streaming Chrome) is not driven: a verify run never opens the owner's Chrome.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh up --direct-stream --prober`, `--direct-stream --prober=off`)
- Feature-map entries: `features/direct-streaming.md` (the prober sub-feature), `features/movies.md` (neighbor)
- Journeys:
  - **J1** · traces R6.2 — `npx vitest run tests/unit/directStream/prober.test.ts -t "R6.2" && npx vitest run tests/unit/config.streamProber.test.ts` → passes when both report every test passed: with `NOTESD_STREAM_PROBER` unset and with `off`, `buildStreamProber` returns a disabled prober whose `start()` leaves `vi.getTimerCount()` at 0, and two simulated days make 0 resolve calls, 0 idle reads and 0 TMDB calls.
  - **J2** · traces R6.2 — `V=.claude/skills/verify-notesd/scripts/verify.sh; eval "$($V up --direct-stream --prober=off | grep -E '^(RUN|URL|MOVIES|LOG)=')"; sleep 15; $V api "$RUN" GET /api/stream/prober; $V sql "$RUN" "select (select count(*) from stream_probe_titles) as probe_rows, (select count(*) from stream_provider_health) as health_rows"; grep -c 'stream prober off: NOTESD_STREAM_PROBER is off' "$LOG"; grep -cE '/(trending|discover|genre)/' "$MOVIES/tmdb.log" || true; $V down "$RUN"` → passes when the API answers 200 with `"enabled":false` and `"off_reason":"setting_off"`, the SQL prints `probe_rows 0` and `health_rows 0` (no resolve ran, so no provider health was written), the log grep prints `1`, and the TMDB-log grep prints `0`.
  - **J3** · traces R6.3 — `npx vitest run tests/unit/directStream/prober.test.ts -t "R6.3"` → passes when all four tests pass: idle 30 s of 600 makes 0 resolve calls with `stopped: "not_idle"`; an unreadable idle time makes 0 calls; a VLC play and an open stream play each make 0 calls with `stopped: "busy"`; and when the idle time drops after the first probe, exactly 1 resolve call is made and the pass ends `not_idle`.
  - **J4** · traces R6.3, R6.1 — `V=.claude/skills/verify-notesd/scripts/verify.sh; eval "$($V up --direct-stream --prober | grep -E '^(RUN|URL|MOVIES|LOG)=')"; for i in $(seq 1 40); do curl -fsS "$URL/api/stream/prober" | jq -e '.last_pass != null' >/dev/null && break; sleep 1; done; $V api "$RUN" GET /api/stream/prober; curl -fsS "$URL/api/stream/prober" | jq -c '{enabled, stopped: .last_pass.stopped, probed: .last_pass.probed, rechecked: .last_pass.rechecked, listed: .last_pass.listed, idle_s: .last_pass.idle_s}'; $V sql "$RUN" "select kind, count(*) as listed, min(list_rank) as best, count(probed_at) as probed from stream_probe_titles where list_source is not null group by kind order by kind"; $V sql "$RUN" "select count(*) as health_rows from stream_provider_health"; grep -c '/trending/movie/week' "$MOVIES/tmdb.log"; $V down "$RUN"` → passes when the jq line prints `{"enabled":true,"stopped":"not_idle","probed":0,"rechecked":0,"listed":6,"idle_s":0}`, the listing SQL returns `movie | 5 | 0 | 0` and `tv | 1 | 0 | 0` (the fake TMDB's films and series became ranked candidates, none probed), `health_rows` is 0, and the trending grep prints a number of at least 1.
  - **J5** · traces R6.1 — `npx vitest run tests/unit/directStream/prober.test.ts -t "R6.1" && npx vitest run tests/unit/directStream/candidates.test.ts tests/unit/directStream/proberDefaults.test.ts tests/unit/movies/tmdb.lists.test.ts` → passes when every test passes, among them: 4 film and 1 series candidates become 5 verified titles in the order film, film, film, series S1E1, film; with catalog size 2 and 1 fresh title exactly 1 probe runs and the pass ends `catalog_full`; a budget of 3 stops at 3 probes (`probe_budget`); a 60 s pause with 20 s resolves stops at 2 (`time_budget`); sources 8, 6 and 5 days old are re-checked in that order before any candidate while a 1-day-old one is not; a failed title is skipped for 1 day, then 2; the defaults equal the findings' timings.
  - **J6** · traces R6.1 — `npm run test:int -- tests/integration/streamProber.int.test.ts` → passes when all 7 tests pass against the Docker Postgres: fresh count 2 of the seeded mix, due re-checks in the order movie 4, movie 5, tv 9 S2E3, eligibility honours listing, freshness, backoff and host, verified clears the backoff, the three illegal rows are refused, an open play on this host is active.
- Neighbor check: the movies play journey, whose fake `powershell.exe` this phase rewrote: `V=.claude/skills/verify-notesd/scripts/verify.sh; eval "$($V up --movies | grep -E '^(RUN)=')"; .claude/skills/verify-notesd/scripts/movies/journey.sh "$RUN"; $V down "$RUN"` → passes when it ends with `journey: PASS (12 stages)`. Also `npx vitest run tests/unit/movies` passes unchanged (the library's TMDB client and its fakes).
- Cost: nothing billed. No journey resolves through Chrome or reaches a provider or the real TMDB.

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the new integration file pass. A throwaway daemon (`--direct-stream`) with the prober setting unset reports `off_reason: "setting_off"` and writes no probe row. With `--direct-stream --prober` it lists the fake TMDB's titles as ranked candidates and holds every pass at `not_idle` with zero probes. The unit tests prove off, not-idle, budget, catalog size and re-check order with a fake clock, idle, TMDB and resolver.

## Handoffs

- **Phase 3** (settled by the reconciler): `resolve(input, { deadlineS })` passes phase 1's `--deadline-s`, so a title no provider carries cannot overrun the pass: each probe gets the seconds left in it, and a resolve cut short answers `resolve_failed` / `deadline`, which ends the pass at `time_budget` and blames no title. `verify.sh up --direct-stream` gives a throwaway run a fake resolver; a verifier may raise `<run>/movies/idle_ms` on a `--direct-stream --prober` run to drive R6.1's probe half against it (J5 and J6 carry it meanwhile).
- **Phase 5** (settled by the reconciler): freshness is phase 5's one rule; `ProbeRepo` uses `freshStreamSourceSql`, the prober `streamFreshSince`, and the in-memory test store mirrors `isFreshStreamSource` (verified inside the window, `stale_at` null), so the Stream grid (phase 9) and the prober agree. Also: invariant 10's Library filter (stream-only titles absent from `listTitles`) means a title the owner finished only by streaming is never a seed. Acceptable for now; noted for whoever revisits seeds.
- **Phase 2** (settled by the reconciler): the timings block's schema 1 is the contract; `resolve_s.p50` and `fail_s.p50` set `DEFAULT_PROBE_TIMINGS`, and the failed-before-resolve count keeps the spike's 1 (phase 2 measures none).
- **Phase 9** (R5 owner): the Stream page could show the prober's status (`GET /api/stream/prober`), for example "catalog 152/300". `web/` is not this phase's.
- Drive-by left alone: `searchMovie`/`searchTv` in `src/movies/tmdb.ts` could use the new `movieHits`/`tvHits` helpers instead of their inline mapping.
- Owner to confirm (from the index's Decisions): D5 and D6 were relayed by session Z2-QN, not typed by the owner here. The prober ships default off, and turning it on is the owner's call.

## Rollback

Revert this phase's commit range. Migration `0022` only adds `stream_probe_titles`, and with the code reverted nothing reads it. Without a revert, leaving `NOTESD_STREAM_PROBER` unset (the default) or setting it to `off` builds only a `DisabledProber`: no timer, no idle read, no TMDB request, no tab.

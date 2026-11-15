# Phase 3: Registry tables, DirectStreamService, sessions and the pass-through

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R1, R2: the provider registry as data with health per host (R1), and the daemon half of "daemon proxy and player page" (R2): resolve, sessions and a pass-through that only reaches what a resolve returned
**Criteria:** R1.4, R2.1, R2.2, R2.6
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/directStream`, `src/http`

---

## Goal

After this phase the daemon has a direct-streaming subsystem. At start it loads
`claude/streaming/direct/providers.seed.json` into the shared `stream_providers` table. On
`POST /api/stream/play` it runs phase 1's resolver with the registry and this host's health,
records health per provider for this host, keeps an in-memory session with an unguessable id, and
opens `http://localhost:<port>/stream/<id>` full screen through the resolver's `open` command. The
player reads `GET /api/stream/sessions/:id` and fetches everything through
`GET /api/stream/sessions/:id/p?u=`. That route sends only the captured headers and `Range`,
rewrites HLS and DASH, turns `.srt` into WebVTT, streams media, and answers 403 before any fetch
for an unknown or ended session or a host the session never learned. With `NOTESD_DIRECT_STREAM=off`,
`NOTESD_MOVIES=off` or no service, every route answers 503 `direct_stream_off` and nothing is built,
so no Chrome can start.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**

- Config (`src/config.ts`): `DirectStreamConfig { enabled: boolean; freshDays: number; cli: string }`,
  `DEFAULT_DIRECT_STREAM_CONFIG` (`enabled: false`, `freshDays: 7`, `cli: DEFAULT_DIRECT_STREAM_CLI`),
  `DEFAULT_STREAM_FRESH_DAYS = 7`, `DEFAULT_DIRECT_STREAM_CLI` (`<REPO_ROOT>/claude/streaming/direct/cli.mjs`),
  `parseDirectStream(env)`, `Config.directStream?: DirectStreamConfig`. Env vars `NOTESD_DIRECT_STREAM`
  (default on), `NOTESD_STREAM_FRESH_DAYS` (default 7), **added:** `NOTESD_DIRECT_STREAM_CLI` (absolute
  path of the resolver script; `verify.sh up --direct-stream` points it at a fake). Phase 10 adds its
  `prober` block as one more field of `DirectStreamConfig`, set in `parseDirectStream` and
  `DEFAULT_DIRECT_STREAM_CONFIG`.
- `AppDeps.directStream?: DirectStreamService | null` (`src/deps.ts`).
- Schema (`src/db/schema.ts`), migration `drizzle/0020_stream_providers.sql`:
  - `STREAM_ID_KINDS = ['tmdb','imdb']`, `STREAM_HEALTH_OUTCOMES = ['resolved','no_stream','bot_check','error']`,
    `STREAM_MANIFEST_KINDS = ['hls','dash','mp4']` and their types `StreamIdKind`, `StreamHealthOutcome`, `StreamManifestKind`.
  - `stream_providers` (`streamProviders`, shared by both machines): `name text PK`, `id_kind text not null default 'tmdb'`
    (check tmdb|imdb), `movie text not null`, `tv text`, `browser_only boolean not null default false`,
    `en_subtitle boolean`, `notes text not null default ''`, `origin_site text` (**null = the checked-in seed**;
    phase 8 writes the site), `added_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
    Drizzle properties: `name, idKind, movie, tv, browserOnly, enSubtitle, notes, originSite, addedAt, updatedAt`.
  - `stream_provider_health` (`streamProviderHealth`, per host): PK `(name, host)`, `name` FK `stream_providers.name`
    on delete/update cascade, `last_outcome text not null` (check in `STREAM_HEALTH_OUTCOMES`), `last_detail text not null default ''`,
    `successes int`, `failures int`, `consecutive_failures int` (not null default 0), `last_success_at`, `last_failure_at`
    (timestamptz null), `recent_s real[] not null default '{}'` (the last 10 times to a stream), `manifest_kind text`
    (check hls|dash|mp4), `best_height int`, `en_subtitle boolean`, `updated_at`.
  - Row types `StreamProviderRow`, `StreamProviderHealthRow`.
- `src/directStream/types.ts`: `StreamRef` (`{kind:'movie', tmdbId} | {kind:'tv', tmdbId, season, episode}`),
  `StreamRefInput` (`{kind, tmdbId, season?, episode?}`, what callers may pass), `toStreamRef(input)`,
  `RESOLVE_OUTCOMES` (phase 1's six, including `skipped_browser_only` and `skipped_no_template`), `ResolveOutcome`,
  `MANIFEST_KINDS`, `ManifestKind`, `ResolveAttempt {provider, outcome, took_s, detail}`, `CapturedHeaders {referer, origin, user_agent: string|null}`,
  `SubtitleTrack {url, lang: string|null, label, format, source: 'request'|'manifest'}`,
  `ResolvedSource {provider, embed_url, manifest_url, manifest_kind, headers, subtitles, best_height, en_subtitle, took_s}`
  (the CLI's `source`, snake_case, normalized), `ResolveOutput` (`{ok:true, source, attempts} | {ok:false, source:null, error, detail, attempts}`),
  `ResolvedOutput`, `DirectStreamError {code, reason, attempts, sessionId, pageUrl}` with
  `DirectStreamErrorCode = 'no_source'|'resolve_failed'|'open_failed'|'unknown_session'`, `isEnglish(track)`, `refLabel(ref)`.
- `src/directStream/runner.ts`: `DirectStreamRunner = (args: string[]) => Promise<unknown>`,
  `directStreamScriptRunner({cliPath, nodeBin?, timeoutMs?})`, `DIRECT_STREAM_TIMEOUT_MS = 1_200_000` (24 providers x 45 s worst case),
  `parseResolveOutput(raw): ResolveOutput`, `parseOpenOutput(raw): OpenOutput`.
- `src/directStream/sessions.ts`: `StreamSession {id, ref, source, attempts, allowedHosts, resumeS, createdAt, refreshedAt, lastUsedAt}`,
  `SessionStore` (`create`, `get`, `replaceSource`, `expiresAt`, `size`), `sourceHosts`, `allows`, `learn`,
  `SESSION_IDLE_MS` (4 h), `SESSION_MAX_MS` (24 h), `MAX_SESSIONS` (32), `SESSION_ID_PATTERN` (32 base64url chars).
- `src/directStream/rewrite.ts`: `proxiedUrl`, `encodeTarget`, `absoluteHttp`, `rewriteHls`, `rewriteDash`, `srtToVtt`, `Rewritten`.
- `src/directStream/passThrough.ts`: `forward(session, req, fetch)`, `ForwardRequest`, `FetchLike`, `jsonError`,
  `upstreamHeaders`, `UPSTREAM_STATUS_HEADER = 'x-notesd-upstream'`, `PLAYLIST_MAX_BYTES`, `MAX_REDIRECTS`, `UPSTREAM_HEADERS_TIMEOUT_MS`.
- `src/directStream/repo.ts`: `DirectStreamRepo` (`syncSeed`, `providers`, `healthFor`, `recordAttempts`), `readSeedFile`,
  `SeedProvider`, `ProviderSeedJson`, `providerSeedJson`, `ProviderHealthJson`, `healthMap`, `median`, `HealthAttempt`,
  `ProviderView`, `providerView`, `RECENT_TIMINGS = 10`.
- `src/directStream/service.ts`: `DirectStreamService`, `buildDirectStreamService(config, db, wiring, overrides?)`,
  `DirectStreamWiring {movies: {readonly host: string}|null, pageBase: () => string, hooks?}`, `DirectStreamHooks`,
  `SessionInfo`, `SessionSubtitle`, `PlayResult`, `SyncSeedResult`, `DEFAULT_SEED_FILE`.
  Public methods: `host`, `syncSeed()`, `resolve(input, {resumeS?, deadlineS?})` returns `StreamSession`,
  `play(input, {resumeS?})` returns `PlayResult {page_url, session: SessionInfo, attempts}`, `session(id)` returns
  `StreamSession | null` (sync; has `id`, `ref`, `source.provider`), `info(id)` returns `Promise<SessionInfo | null>`,
  `refresh(id)` returns `SessionInfo` (same id), `passThrough(id, req)` returns `Response`, `providers()` returns
  `ProviderView[]`, `runResolve(ref, {only?, deadlineS?})` returns `ResolveOutput` (serialized, records health, never calls
  `recordResolve`, never throws for a failed resolve). Fields `repo` and `runner` (private readonly) for phase 8.
  **Added (reconciler):** `deadlineS` is passed to the resolver as `--deadline-s <n>` (phase 1): no further provider is
  tried once it has passed, and the failure is `resolve_failed` with `reason: 'deadline'` (never `no_source`, so the
  recordResolve hook marks nothing stale). Phase 10's prober passes the seconds left in its pass.
- `DirectStreamHooks` (phase 5 implements; names taken from phase 5's plan):
  `recordResolve?(ref: StreamRef, result: ResolveOutput): Promise<void>` is awaited after every resolve that a play,
  a refresh or `resolve()` makes, success or failure, before the caller gets its answer (not after `runResolve` alone).
  `resumeS?(ref): Promise<number | null>` gives a new session its `resume_s` when the caller passed none.
  `titleLabel?(ref): Promise<string | null>` is the title shown by the player (default `TMDB movie 550` / `TMDB tv 1399 S01E02`).
- `src/http/directStreamApi.ts`: `directStreamRoutes(deps: Pick<AppDeps,'directStream'>)`, `DIRECT_STREAM_OFF`, `UNKNOWN_SESSION`,
  `directStreamErrorResponse(c, err)`, `playBody`, `refFromBody`.
- Routes:
  - `POST /api/stream/play` (same-origin) body `{kind:'movie', tmdb_id, resume_s?}` or
    `{kind:'tv', tmdb_id, season, episode, resume_s?}` (**added:** optional `resume_s`; a film may send
    `season`/`episode` only as null). 200 `{ok: true, page_url, session: SessionInfo, attempts}`.
  - `GET /api/stream/sessions/:id`: `SessionInfo = {session_id, kind, tmdb_id, season, episode, title, provider,
    manifest_kind, manifest_url, subtitles: [{url, lang, label, format, source, english}], best_height, resume_s,
    created_at, refreshed_at, expires_at}`. `manifest_url` and subtitle `url`s are daemon-relative pass-through
    addresses; an `.srt` track's url carries `&vtt=1` and its `format` is `vtt`.
  - `GET /api/stream/sessions/:id/p?u=<url>[&vtt=1]`: the pass-through. Forwarded answers carry the upstream status
    and `X-Notesd-Upstream: <status>`; notesd's own refusals do not carry that header.
  - `POST /api/stream/sessions/:id/refresh` (same-origin): resolves again, keeps the id.
- Error codes: `direct_stream_off` 503 (every route, checked before the Origin guard), `no_source` 502 with
  `attempts`, `unknown_session` 403, `forbidden_host` 403, **added:** `resolve_failed` 502 with `reason`
  (`no_chrome`, `chrome_not_reachable`, `unknown_provider`, `script_failed`, `bad_output`) and `attempts`,
  `open_failed` 502 with `reason`, `session_id`, `page_url`, `upstream_error` 502, plus the existing `invalid_json`,
  `invalid_body` 400 and `forbidden_origin` 403.
- Pass-through host rule: a session may fetch the hosts (`URL.host`, with port) of the resolve's manifest and
  subtitle addresses, plus a host that appears in an HLS playlist or DASH manifest fetched through the same session,
  or in the `Location` of a redirect answered to a fetch through the same session. A refresh adds the new
  source's hosts to the set. Nothing else; the check runs before any fetch.
- Test fixtures: `tests/fixtures/direct-stream/upstream.mjs` (fixture stream host: `startUpstream()`,
  `FIXTURE_REFERER`, `FIXTURE_ORIGIN`, `FIXTURE_USER_AGENT`, `SEGMENT_BYTES`), `tests/fixtures/direct-stream/fake-cli.mjs`
  (stands in for the resolver; state in `DIRECT_STREAM_FAKE_DIR`). Same folder as phase 1's fixtures, different names.
- Harness: `verify.sh up --direct-stream` (implies `--movies`), `NOTESD_DIRECT_STREAM=off` pinned on every other run,
  `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN [seed|hls|dash|refuse]`. **Reconciler:** under
  `--direct-stream`, a `NOTESD_DIRECT_STREAM_CLI` set in the caller's environment is passed through (phase 6's
  playcheck wrapper); without one the fake resolver is used. Phases 6 and 9 run `up --direct-stream`; phase 10 adds
  `--prober` on top of it. verify.sh is edited by this phase first, then phase 10 (phase 5 does not edit it).
- `README.md`: one Direct streaming line in the subsystem table, with a link to the guide section (**added by the
  reconciler**, CLAUDE.md's "keep README short: one line per subsystem" rule). `CLAUDE.md` is not edited by any phase.
- Shared helper: `runJsonScript({label, nodeBin, argv, timeoutMs})` exported from `src/streaming/service.ts`;
  `scriptRunner` now calls it (same behaviour, same messages).

**Signature changes:** `scriptRunner` keeps its signature; its body delegates to `runJsonScript`. `truncateAll`
(`tests/integration/setup.ts`) also truncates `stream_provider_health, stream_providers`.

**Requires (from earlier phases):** phase 1's `claude/streaming/direct/cli.mjs` with
`resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]` and
`open <url> [--fullscreen]` (a full-screen open also calls the page's `window.notesdStream.start()` as a user
gesture, so the film starts with sound; its answer gains `started`, which this phase ignores), its JSON answers as
phase 1's plan states them (stdout on exit 1 and 2, `error: "deadline"` for a resolve cut by `--deadline-s`,
`headers.*` may be null, `subtitles[].source`, `source.en_subtitle`, outcome `skipped_no_template`,
`manifest_kind` `mp4`), and `claude/streaming/direct/providers.seed.json` as an array of
`{name, id_kind, movie, tv, browser_only, en_subtitle, notes}`.

**Leaves alone (owned by others):** `movie_*` tables and `src/movies/*` (phase 5); `web/*` and
`src/http/static.ts` for `/stream/<id>` (phase 4); `src/mcp/*` and `src/chat/*` (phases 7 and 8);
`claude/streaming/direct/*` (phases 1, 2, 6, 8: read and run only); `src/background.ts` and the prober
(phase 10); `POST /api/stream/sessions/:id/position` (phase 5 adds it to `src/http/directStreamApi.ts`).

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts:114-118`, `:248-271`, `:565-615` | modify | `DirectStreamConfig`, defaults, `parseDirectStream`, `Config.directStream`, `loadConfig` |
| `src/streaming/service.ts:37-59` | modify | extract `runJsonScript`; `scriptRunner` delegates |
| `src/db/schema.ts:58-59`, `:1216`, `:1255` | modify | header note, the two stream tables, row types |
| `drizzle/0020_stream_providers.sql`, `drizzle/meta/0020_snapshot.json`, `drizzle/meta/_journal.json` | create / modify (generated) | migration 0020 |
| `src/directStream/types.ts` | create | shared shapes, `DirectStreamError` |
| `src/directStream/rewrite.ts` | create | HLS, DASH, SRT rewriting, the proxied address |
| `src/directStream/sessions.ts` | create | in-memory sessions and the host allow list |
| `src/directStream/runner.ts` | create | runs the resolver CLI, parses its answers at the boundary |
| `src/directStream/repo.ts` | create | only writer of `stream_*`; seed file reader |
| `src/directStream/passThrough.ts` | create | the forwarding itself |
| `src/directStream/service.ts` | create | `DirectStreamService`, `buildDirectStreamService` |
| `src/http/directStreamApi.ts` | create | the four routes |
| `src/deps.ts:45-50` | modify | `directStream` field |
| `src/http/app.ts:20`, `:90-102`, `:130` | modify | mount `directStreamRoutes` |
| `src/daemon.ts:26`, `:143-148` | modify | build the service, load the seed, put it on deps |
| `tests/fixtures/direct-stream/upstream.mjs` | create | fixture stream host |
| `tests/fixtures/direct-stream/fake-cli.mjs` | create | fake resolver |
| `tests/integration/setup.ts:50` | modify | truncate the stream tables |
| `tests/unit/config.test.ts:6-17`, `:52`, end | modify | defaults and a new test |
| `tests/unit/directStream/rewrite.test.ts` | create | rewriting |
| `tests/unit/directStream/sessions.test.ts` | create | ids, expiry, hosts |
| `tests/unit/directStream/runner.test.ts` | create | parsing, running the fake |
| `tests/unit/directStream/seed.test.ts` | create | seed reader and the checked-in seed |
| `tests/unit/directStream/build.test.ts` | create | off means not built |
| `tests/integration/directStream.repo.int.test.ts` | create | migration, seed sync, health per host |
| `tests/integration/directStream.api.int.test.ts` | create | routes and pass-through against the fixture host |
| `scripts/docs/httpRoutes.ts:403-425` | modify | "Direct streaming" group |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md:126-127` | modify | "Direct streaming" settings section |
| `docs/guide/streaming.md:16-20`, `:256`, `:258-283` | modify | contents, the "Direct streaming" section, code table, proving |
| `docs/guide/architecture.md:37-39`, `:63-72`, `:91`, `:181-186`, `:251` | modify | wiring, one writer, data model, security, layout |
| `README.md:48` | modify | one Direct streaming row after the Streaming row (reconciler) |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | `--direct-stream` (a caller's `NOTESD_DIRECT_STREAM_CLI` passes through), pin off, stop the fixture host |
| `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh` | create | the feature map's checks |
| `.claude/skills/verify-notesd/SKILL.md` | modify | launch line, paragraph, gotcha |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | create | feature map entry |
| `.claude/skills/verify-notesd/features/README.md` | modify | its row |

## Implementation Steps

Each step ends in a check that can fail. Run `npm ci` once in the worktree first (it has no
`node_modules`).

### Step 1: Config section
**File:** `src/config.ts:114-118` (after `StreamingConfig`), `:268-271` (`Config`), `:577-586` (doc comment), `:613` (`loadConfig`)
**Change:** add the section, its default-off literal and its parser, then wire it into `Config` and `loadConfig`.
**Code:** insert after the `StreamingConfig` interface (after line 118):
```ts
export const DEFAULT_STREAM_FRESH_DAYS = 7
/** `claude/streaming/direct/cli.mjs` in this checkout: the resolver the daemon runs (direct streaming phase 1). */
export const DEFAULT_DIRECT_STREAM_CLI = path.join(REPO_ROOT, 'claude', 'streaming', 'direct', 'cli.mjs')

/** Direct streaming (src/directStream/*): the provider registry, resolves, sessions and the pass-through. */
export interface DirectStreamConfig {
  /**
   * `NOTESD_DIRECT_STREAM`, default on. It also needs NOTESD_MOVIES on. `off`: every /api/stream/*
   * route answers direct_stream_off, the seed is not loaded and the resolver is never run.
   */
  enabled: boolean
  /** `NOTESD_STREAM_FRESH_DAYS`, default 7: how long a stream source verified on this host counts as playable. */
  freshDays: number
  /** `NOTESD_DIRECT_STREAM_CLI`, absolute, default DEFAULT_DIRECT_STREAM_CLI: the resolver script run as `node <cli>`. */
  cli: string
}

/** Direct streaming off. Tests build `Config` literals with it (or leave `directStream` out, which is the same). */
export const DEFAULT_DIRECT_STREAM_CONFIG: DirectStreamConfig = {
  enabled: false,
  freshDays: DEFAULT_STREAM_FRESH_DAYS,
  cli: DEFAULT_DIRECT_STREAM_CLI,
}
```
In `interface Config`, after the `streaming?: StreamingConfig` member (line 270):
```ts
  /** Direct streaming. Absent (a config built by a test) is the same as `enabled: false`. */
  directStream?: DirectStreamConfig
```
Insert after `parseMovies` (after line 563), so `parseOptionalAbsolutePath` and `parsePositiveInt` are in scope:
```ts
export function parseDirectStream(env: Record<string, string | undefined>): DirectStreamConfig {
  return {
    enabled: parseSwitch('NOTESD_DIRECT_STREAM', env.NOTESD_DIRECT_STREAM),
    freshDays: parsePositiveInt('NOTESD_STREAM_FRESH_DAYS', env.NOTESD_STREAM_FRESH_DAYS, DEFAULT_STREAM_FRESH_DAYS),
    cli: parseOptionalAbsolutePath('NOTESD_DIRECT_STREAM_CLI', env.NOTESD_DIRECT_STREAM_CLI) ?? DEFAULT_DIRECT_STREAM_CLI,
  }
}
```
In the `loadConfig` doc comment, after the line ending `NOTESD_CURL_EXE, NOTESD_VLC_HEALTH_MS, NOTESD_VLC_EXTRA_ARGS, NOTESD_MOVIES_FALLBACK_MODEL`, the parenthesised sentence stays; append one sentence before ` * Other keys are ignored.`:
```ts
 * Direct streaming keys: NOTESD_DIRECT_STREAM, NOTESD_STREAM_FRESH_DAYS, NOTESD_DIRECT_STREAM_CLI
 * (a freshness window below 1 or a relative resolver path throw ConfigError).
```
In the object `loadConfig` returns, after `streaming: { enabled: parseSwitch('NOTESD_STREAMING', env.NOTESD_STREAMING) },`:
```ts
    directStream: parseDirectStream(env),
```
**Test:** `tests/unit/config.test.ts`: add `DEFAULT_DIRECT_STREAM_CLI, DEFAULT_DIRECT_STREAM_CONFIG,` to the import list (alphabetical, after `DEFAULT_CHAT_CONFIG,`). In `'applies defaults'`, after `streaming: { enabled: true },` (line 52):
```ts
      directStream: { ...DEFAULT_DIRECT_STREAM_CONFIG, enabled: true },
```
Append as the last test inside `describe('loadConfig', ...)`:
```ts
  it('reads the direct streaming switch, freshness window and resolver path', () => {
    const ds = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).directStream
    expect(DEFAULT_DIRECT_STREAM_CONFIG.enabled).toBe(false)
    expect(DEFAULT_DIRECT_STREAM_CLI.endsWith(path.join('claude', 'streaming', 'direct', 'cli.mjs'))).toBe(true)
    expect(ds({})).toEqual({ enabled: true, freshDays: 7, cli: DEFAULT_DIRECT_STREAM_CLI })
    expect(ds({ NOTESD_DIRECT_STREAM: 'off' })?.enabled).toBe(false)
    expect(ds({ NOTESD_STREAM_FRESH_DAYS: '3' })?.freshDays).toBe(3)
    expect(ds({ NOTESD_DIRECT_STREAM_CLI: '/tmp/fake-cli.mjs' })?.cli).toBe('/tmp/fake-cli.mjs')
    expect(() => ds({ NOTESD_DIRECT_STREAM: 'maybe' })).toThrow(ConfigError)
    expect(() => ds({ NOTESD_STREAM_FRESH_DAYS: '0' })).toThrow(ConfigError)
    expect(() => ds({ NOTESD_DIRECT_STREAM_CLI: 'relative/cli.mjs' })).toThrow(ConfigError)
  })
```
**Check:** `npx vitest run tests/unit/config.test.ts` passes.
**Impact:** `Config` gains an optional field; every hand-built `Config` literal still compiles.

### Step 2: One way to run a JSON-printing script
**File:** `src/streaming/service.ts:37-59`
**Change:** extract the body of `scriptRunner` into `runJsonScript` so the direct-stream runner reuses it instead of copying it. Messages stay `streaming script failed:` / `streaming script printed no JSON:`.
**Code:** replace lines 37-59 (`export function scriptRunner ... }`) with:
```ts
export interface JsonScriptOptions {
  /** Names the script in errors: `<label> failed: ...`, `<label> printed no JSON: ...`. */
  label: string;
  nodeBin: string;
  /** Script path first, then its arguments. */
  argv: string[];
  timeoutMs: number;
}

/**
 * Runs `node <argv...>` and returns the one JSON object it prints. A script that exits non-zero with
 * its answer on stdout still answers (both streaming CLIs do that for a failure they can name).
 * Shared by the streaming sites and direct streaming (src/directStream/runner.ts).
 */
export async function runJsonScript(options: JsonScriptOptions): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run(options.nodeBin, options.argv, { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== 'string' || out.trim() === '') {
      throw new Error(`${options.label} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    stdout = out;
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${options.label} printed no JSON: ${stdout.slice(0, 200)}`);
  }
}

export function scriptRunner(options: ScriptRunnerOptions = {}): StreamingRunner {
  const nodeBin = options.nodeBin ?? process.execPath;
  const cliPath = options.cliPath ?? DEFAULT_STREAMING_CLI;
  const timeoutMs = options.timeoutMs ?? STREAMING_TIMEOUT_MS;
  return (site, args) => runJsonScript({ label: 'streaming script', nodeBin, argv: [cliPath, site, ...args], timeoutMs });
}
```
**Check:** `npx vitest run tests/unit/streaming.test.ts tests/unit/mcp.streamingTools.test.ts` passes unchanged.
**Impact:** none for `/idlix`, `/lk21`, `streaming_*` (invariant 8).

### Step 3: Tables and migration 0020
**File:** `src/db/schema.ts`: header comment before line 59 (`* Change a table here, then ...`), new tables after `moviePlays` (after line 1216), row types after line 1255.
**Change:** add the two stream tables. `real`, `integer`, `boolean`, `primaryKey`, `check` are already imported.
**Code:** header comment, insert before ` * Change a table here, then \`npm run db:generate\`; never edit an applied migration.`:
```ts
 * Migration 0020 (direct streaming) adds `stream_providers` (the provider registry, shared by both
 * machines, loaded from claude/streaming/direct/providers.seed.json at every start) and
 * `stream_provider_health` (one row per provider and host). src/directStream/repo.ts
 * (`DirectStreamRepo`) is their only writer.
```
After the closing `)` of `export const moviePlays = pgTable(...)`:
```ts
/** The closed sets of the stream tables (migration 0020). The CHECK constraints enforce the same lists. */
export const STREAM_ID_KINDS = ['tmdb', 'imdb'] as const
export type StreamIdKind = (typeof STREAM_ID_KINDS)[number]
/** A provider's last outcome on a host. A skipped provider (browser-only, no template) is not one: a skip leaves health alone. */
export const STREAM_HEALTH_OUTCOMES = ['resolved', 'no_stream', 'bot_check', 'error'] as const
export type StreamHealthOutcome = (typeof STREAM_HEALTH_OUTCOMES)[number]
export const STREAM_MANIFEST_KINDS = ['hls', 'dash', 'mp4'] as const
export type StreamManifestKind = (typeof STREAM_MANIFEST_KINDS)[number]

/**
 * The direct-streaming provider registry (migration 0020), shared by both machines. A provider is an
 * embed address template keyed by the TMDB (or IMDb) id: `movie` has `{id}`, `tv` adds `{season}` and
 * `{episode}` (null: no episode template known). `origin_site` null means the row comes from the
 * checked-in seed, which the daemon syncs at every start; a site's address means /update-cloud-source
 * added it, and the seed never rewrites it. Nothing deletes a provider.
 */
export const streamProviders = pgTable(
  'stream_providers',
  {
    name: text('name').primaryKey(),
    idKind: text('id_kind').$type<StreamIdKind>().notNull().default('tmdb'),
    movie: text('movie').notNull(),
    tv: text('tv'),
    browserOnly: boolean('browser_only').notNull().default(false),
    /** What the seed or the site says; this host's measurement is in stream_provider_health. */
    enSubtitle: boolean('en_subtitle'),
    notes: text('notes').notNull().default(''),
    originSite: text('origin_site'),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [check('stream_providers_id_kind_check', sql`${t.idKind} in ('tmdb', 'imdb')`)],
)

/**
 * What resolving a provider through this host's streaming Chrome has shown (migration 0020): one row
 * per provider and host, written after every resolve. `recent_s` keeps the last ten times to a
 * stream, newest last; the median is computed at read time.
 */
export const streamProviderHealth = pgTable(
  'stream_provider_health',
  {
    name: text('name')
      .notNull()
      .references(() => streamProviders.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
    host: text('host').notNull(),
    lastOutcome: text('last_outcome').$type<StreamHealthOutcome>().notNull(),
    lastDetail: text('last_detail').notNull().default(''),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    recentS: real('recent_s').array().notNull().default(sql`'{}'::real[]`),
    manifestKind: text('manifest_kind').$type<StreamManifestKind>(),
    bestHeight: integer('best_height'),
    enSubtitle: boolean('en_subtitle'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.host] }),
    check('stream_provider_health_outcome_check', sql`${t.lastOutcome} in ('resolved', 'no_stream', 'bot_check', 'error')`),
    check('stream_provider_health_manifest_kind_check', sql`${t.manifestKind} in ('hls', 'dash', 'mp4')`),
  ],
)
```
At the end of the file, after `export type MoviePlayRow = typeof moviePlays.$inferSelect`:
```ts
export type StreamProviderRow = typeof streamProviders.$inferSelect
export type StreamProviderHealthRow = typeof streamProviderHealth.$inferSelect
```
Then generate (the worktree has no `.env.local`; `drizzle.config.ts` needs a direct URL even to generate, and generate never connects):
```sh
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name stream_providers
```
It must create `drizzle/0020_stream_providers.sql`, `drizzle/meta/0020_snapshot.json` and the journal entry `{ "idx": 20, "version": "7", "tag": "0020_stream_providers", "breakpoints": true }`. The SQL must contain `CREATE TABLE "stream_providers"`, `CREATE TABLE "stream_provider_health"` with `"recent_s" real[] DEFAULT '{}'::real[] NOT NULL`, `CONSTRAINT "stream_provider_health_name_host_pk" PRIMARY KEY("name","host")`, the three CHECKs, and `ALTER TABLE "stream_provider_health" ADD CONSTRAINT "stream_provider_health_name_stream_providers_name_fk" FOREIGN KEY ("name") REFERENCES "public"."stream_providers"("name") ON DELETE cascade ON UPDATE cascade`. No statement may touch an existing table; if one does, fix the schema step, delete the three generated artifacts and regenerate. Phase 5's `0021` is generated after this one lands.

**File:** `tests/integration/setup.ts:50`: in `truncateAll`, change `sql\`truncate table movie_plays, ` to start with the stream tables:
```ts
  await db.execute(sql`truncate table stream_provider_health, stream_providers, movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles, adversary_reviews, note_session_links, cc_session_reply_embeddings, cc_session_replies, cc_session_prompt_images, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
**Check:** `npm run typecheck`; `npm run test:int -- tests/integration/schema.int.test.ts` still passes (migrations apply).
**Impact:** two new tables; nothing existing changes.

### Step 4: Shared shapes
**File:** `src/directStream/types.ts` (new)
**Code:**
```ts
import { STREAM_HEALTH_OUTCOMES, STREAM_MANIFEST_KINDS, type StreamManifestKind } from '../db/schema.js';

/**
 * The shapes direct streaming passes around (DIRECT_STREAMING_PLAN phase 3). They are validated once
 * where they enter: the routes (src/http/directStreamApi.ts), the tools (phase 7) and the resolver's
 * printed answer (runner.ts). Everything inside trusts them. Data that comes from or goes back out as
 * JSON (attempts, the source) keeps the resolver's snake_case names.
 */

/** What is streamed: one film, or one episode of a series. A film never carries a season or episode. */
export type StreamRef =
  | { kind: 'movie'; tmdbId: number }
  | { kind: 'tv'; tmdbId: number; season: number; episode: number };

/** What a caller may hand the service (phase 7's StreamTarget fits). `toStreamRef` makes it a StreamRef. */
export interface StreamRefInput {
  kind: 'movie' | 'tv';
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
}

/** The one place a loose target becomes a StreamRef. Callers validate first; a series without an episode is a programming error. */
export function toStreamRef(input: StreamRefInput): StreamRef {
  if (input.kind === 'movie') return { kind: 'movie', tmdbId: input.tmdbId };
  if (input.season === undefined || input.season === null || input.episode === undefined || input.episode === null) {
    throw new RangeError(`a series needs a season and an episode (tv ${input.tmdbId})`);
  }
  return { kind: 'tv', tmdbId: input.tmdbId, season: input.season, episode: input.episode };
}

/** How one provider's try ended, as claude/streaming/direct/cli.mjs reports it. The two skips are not health. */
export const RESOLVE_OUTCOMES = [...STREAM_HEALTH_OUTCOMES, 'skipped_browser_only', 'skipped_no_template'] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

export const MANIFEST_KINDS = STREAM_MANIFEST_KINDS;
export type ManifestKind = StreamManifestKind;

export interface ResolveAttempt {
  provider: string;
  outcome: ResolveOutcome;
  took_s: number | null;
  detail: string;
}

/** The request headers the real Chrome's manifest request carried. Null: that header was not sent. */
export interface CapturedHeaders {
  referer: string | null;
  origin: string | null;
  user_agent: string | null;
}

export interface SubtitleTrack {
  /** Absolute http(s) address on the stream host. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt`, `srt`, `hls`, `ttml`, `dash` (lower case). */
  format: string;
  /** `request`: a separate subtitle request; `manifest`: a track inside the manifest. */
  source: 'request' | 'manifest';
}

/** The resolver's `source`, normalized. */
export interface ResolvedSource {
  provider: string;
  embed_url: string;
  manifest_url: string;
  manifest_kind: ManifestKind;
  headers: CapturedHeaders;
  subtitles: SubtitleTrack[];
  best_height: number | null;
  en_subtitle: boolean;
  took_s: number | null;
}

/** One resolve's answer. `error` on failure: `no_source`, or why the resolve could not run. */
export type ResolveOutput =
  | { ok: true; source: ResolvedSource; attempts: ResolveAttempt[] }
  | { ok: false; source: null; error: string; detail: string; attempts: ResolveAttempt[] };

export type ResolvedOutput = Extract<ResolveOutput, { ok: true }>;

export type DirectStreamErrorCode = 'no_source' | 'resolve_failed' | 'open_failed' | 'unknown_session';

export interface DirectStreamErrorExtra {
  reason?: string;
  attempts?: ResolveAttempt[];
  sessionId?: string;
  pageUrl?: string;
}

/** A failure the routes and tools answer by name (src/http/directStreamApi.ts maps it to HTTP). */
export class DirectStreamError extends Error {
  override name = 'DirectStreamError';
  /** `resolve_failed` / `open_failed`: no_chrome, chrome_not_reachable, unknown_provider, script_failed, bad_output, ... */
  readonly reason: string | null;
  /** Every provider's outcome, as the resolver printed them. */
  readonly attempts: ResolveAttempt[];
  readonly sessionId: string | null;
  readonly pageUrl: string | null;

  constructor(
    readonly code: DirectStreamErrorCode,
    message: string,
    extra: DirectStreamErrorExtra = {},
  ) {
    super(message);
    this.reason = extra.reason ?? null;
    this.attempts = extra.attempts ?? [];
    this.sessionId = extra.sessionId ?? null;
    this.pageUrl = extra.pageUrl ?? null;
  }
}

/** True for an English track: a language tag `en`, `eng`, `en-US`..., or a label naming English. */
export function isEnglish(track: { lang: string | null; label: string }): boolean {
  return /^(en|eng)(?:[-_]|$)/i.test((track.lang ?? '').trim()) || /\benglish\b/i.test(track.label);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `TMDB movie 550`, `TMDB tv 1399 S01E02`: the label when no title hook names it better. */
export function refLabel(ref: StreamRef): string {
  return ref.kind === 'movie' ? `TMDB movie ${ref.tmdbId}` : `TMDB tv ${ref.tmdbId} S${pad(ref.season)}E${pad(ref.episode)}`;
}
```
**Check:** `npm run typecheck`.

### Step 5: Rewriting
**File:** `src/directStream/rewrite.ts` (new)
**Code:**
```ts
/**
 * Playlist and manifest rewriting for the pass-through (src/directStream/passThrough.ts). Every
 * address in an HLS playlist or a DASH manifest is made absolute against the address it was fetched
 * from and replaced by the pass-through route, so the player asks notesd for everything and notesd
 * adds the headers the stream host checks. `urls` lists the absolute addresses found, so the session
 * can allow their hosts (a host joins a session only by appearing in something fetched through it).
 */

export interface Rewritten {
  text: string;
  /** Every absolute http(s) address the text named, in order. */
  urls: string[];
}

/** The absolute http(s) address `ref` names (against `base` when given), or null. */
export function absoluteHttp(ref: string, base?: string): string | null {
  try {
    const url = base === undefined ? new URL(ref) : new URL(ref, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** DASH template identifiers: `$RepresentationID$`, `$Number$`, `$Number%05d$`, `$Time$`, `$Bandwidth$`, `$SubNumber$`, `$$`. */
const TEMPLATE_TOKEN = /(\$(?:RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0\d+[dxXo])?\$)/;

/** encodeURIComponent, except DASH template identifiers stay as they are, so the player can still fill them in. */
export function encodeTarget(target: string): string {
  return target
    .split(TEMPLATE_TOKEN)
    .map((part, i) => (i % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}

/** The pass-through address of `target` in session `sessionId`, relative to the daemon's origin. */
export function proxiedUrl(sessionId: string, target: string, options: { vtt?: boolean } = {}): string {
  return `/api/stream/sessions/${sessionId}/p?u=${encodeTarget(target)}${options.vtt === true ? '&vtt=1' : ''}`;
}

/**
 * An HLS playlist (master or media) with every address line and every `URI="..."` attribute
 * (EXT-X-MEDIA, EXT-X-KEY, EXT-X-MAP, EXT-X-I-FRAME-STREAM-INF, ...) sent through the pass-through.
 * A URI that is not http(s) after resolving (`skd://`, `data:`) is left as it is.
 */
export function rewriteHls(text: string, base: string, sessionId: string): Rewritten {
  const urls: string[] = [];
  const through = (ref: string): string | null => {
    const abs = absoluteHttp(ref, base);
    if (abs === null) return null;
    urls.push(abs);
    return proxiedUrl(sessionId, abs);
  };
  const lines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole: string, ref: string) => {
        const proxied = through(ref);
        return proxied === null ? whole : `URI="${proxied}"`;
      });
    }
    return through(trimmed) ?? line;
  });
  return { text: lines.join('\n'), urls };
}

const XML_UNESCAPES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function xmlUnescape(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_UNESCAPES[m] ?? m);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DASH_TAG = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const DASH_ATTR = /(\s)([A-Za-z_][\w.:-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
/** Attributes that hold an address, per element (local name). `xlink:href` counts on every element. */
const URL_ATTRIBUTES: Record<string, readonly string[]> = {
  SegmentTemplate: ['media', 'initialization', 'index'],
  SegmentURL: ['media', 'index'],
  Initialization: ['sourceURL'],
  RepresentationIndex: ['sourceURL'],
  BitstreamSwitching: ['sourceURL'],
};
/** Elements whose text is an address. */
const TEXT_URL_ELEMENTS = new Set(['BaseURL', 'Location']);

/**
 * A DASH manifest with `BaseURL` and `Location` texts, segment templates (`media`, `initialization`,
 * `index`), `SegmentURL`, `Initialization`, `RepresentationIndex`, `BitstreamSwitching` and
 * `xlink:href` sent through the pass-through. A `BaseURL` is resolved against the base in force for
 * its parent element and becomes that element's base, as DASH nests them. Template identifiers
 * (`$Number%05d$`) are kept for the player to fill in.
 */
export function rewriteDash(text: string, base: string, sessionId: string): Rewritten {
  const urls: string[] = [];
  const resolve = (ref: string, against: string): string | null => {
    const abs = absoluteHttp(ref.trim(), against);
    if (abs !== null) urls.push(abs);
    return abs;
  };
  // bases[i] is the base in force inside the i-th open element; bases[0] is the manifest's address.
  const bases: string[] = [base];
  const tag = new RegExp(DASH_TAG.source, 'g');
  let out = '';
  let last = 0;
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const whole = m[0];
    const closing = m[1] === '/';
    const rawName = m[2] ?? '';
    const attrs = m[3] ?? '';
    const selfClosing = m[4] === '/';
    const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    out += text.slice(last, m.index);
    last = m.index + whole.length;
    if (closing) {
      if (bases.length > 1) bases.pop();
      out += whole;
      continue;
    }
    const current = bases[bases.length - 1] ?? base;
    if (TEXT_URL_ELEMENTS.has(name) && !selfClosing) {
      const end = text.indexOf('</', last);
      const closeEnd = end === -1 ? -1 : text.indexOf('>', end);
      if (closeEnd === -1) {
        out += whole;
        continue;
      }
      const inner = text.slice(last, end);
      const abs = resolve(xmlUnescape(inner), current);
      out += whole + (abs === null ? inner : xmlEscape(proxiedUrl(sessionId, abs))) + text.slice(end, closeEnd + 1);
      last = closeEnd + 1;
      tag.lastIndex = last;
      // A BaseURL sets the base of its parent element (the one on top of `bases`) for what follows.
      if (abs !== null && name === 'BaseURL') bases[bases.length - 1] = abs;
      continue;
    }
    const wanted = URL_ATTRIBUTES[name] ?? [];
    const rewritten = attrs.replace(
      DASH_ATTR,
      (attr: string, space: string, attrName: string, eq: string, dq: string | undefined, sq: string | undefined) => {
        if (!wanted.includes(attrName) && attrName !== 'xlink:href') return attr;
        const abs = resolve(xmlUnescape(dq ?? sq ?? ''), current);
        return abs === null ? attr : `${space}${attrName}${eq}"${xmlEscape(proxiedUrl(sessionId, abs))}"`;
      },
    );
    out += `<${rawName}${rewritten}${selfClosing ? '/' : ''}>`;
    if (!selfClosing) bases.push(current);
  }
  return { text: out + text.slice(last), urls };
}

/** SubRip to WebVTT (a page shows only WebVTT). A file that already is WebVTT is returned as it is. */
export function srtToVtt(text: string): string {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (body.trimStart().startsWith('WEBVTT')) return body;
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim()}\n`;
}
```
**Test:** `tests/unit/directStream/rewrite.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import { absoluteHttp, encodeTarget, proxiedUrl, rewriteDash, rewriteHls, srtToVtt } from '../../../src/directStream/rewrite.js';

const SID = 'abcdefghijklmnopqrstuvwxyz012345';
const P = (u: string): string => `/api/stream/sessions/${SID}/p?u=${encodeURIComponent(u)}`;

describe('proxiedUrl and encodeTarget', () => {
  it('round-trips an address through the u parameter', () => {
    const target = 'https://cdn.example/a b/master.m3u8?token=a%2Fb&x=1';
    const proxied = proxiedUrl(SID, target);
    expect(proxied.startsWith(`/api/stream/sessions/${SID}/p?u=`)).toBe(true);
    expect(new URL(proxied, 'http://localhost').searchParams.get('u')).toBe(target);
    expect(proxiedUrl(SID, target, { vtt: true }).endsWith('&vtt=1')).toBe(true);
  });

  it('keeps DASH template identifiers raw so the player can fill them in', () => {
    expect(encodeTarget('https://c.example/v/$RepresentationID$/seg-$Number%05d$.m4s?t=$Time$&s=$$')).toBe(
      `${encodeURIComponent('https://c.example/v/')}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s?t=')}$Time$${encodeURIComponent('&s=')}$$`,
    );
    const filled = proxiedUrl(SID, 'https://c.example/v/$RepresentationID$/seg-$Number%05d$.m4s').replace('$RepresentationID$', 'v1').replace('$Number%05d$', '00007');
    expect(new URL(filled, 'http://localhost').searchParams.get('u')).toBe('https://c.example/v/v1/seg-00007.m4s');
  });

  it('accepts only http(s) addresses', () => {
    expect(absoluteHttp('seg.ts', 'https://c.example/a/b.m3u8')).toBe('https://c.example/a/seg.ts');
    expect(absoluteHttp('skd://key')).toBeNull();
    expect(absoluteHttp('file:///etc/passwd')).toBeNull();
    expect(absoluteHttp('not a url')).toBeNull();
  });
});

describe('rewriteHls', () => {
  it('rewrites address lines and URI attributes, keeps tags, blank lines and keys it cannot fetch', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      '720/index.m3u8',
      '',
      '#EXT-X-STREAM-INF:BANDWIDTH=2',
      'https://other.example/1080.m3u8?token=a%2Fb',
    ].join('\r\n');
    const r = rewriteHls(text, 'https://cdn.example/hls/master.m3u8', SID);
    expect(r.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1"',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="${P('https://cdn.example/hls/subs/en.m3u8')}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      P('https://cdn.example/hls/720/index.m3u8'),
      '',
      '#EXT-X-STREAM-INF:BANDWIDTH=2',
      P('https://other.example/1080.m3u8?token=a%2Fb'),
    ]);
    expect(r.urls).toEqual([
      'https://cdn.example/hls/subs/en.m3u8',
      'https://cdn.example/hls/720/index.m3u8',
      'https://other.example/1080.m3u8?token=a%2Fb',
    ]);
  });

  it('rewrites a media playlist: map, segments by relative and absolute path', () => {
    const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\n/hls/720/seg2.ts\n#EXT-X-ENDLIST\n';
    const r = rewriteHls(text, 'https://cdn.example/hls/720/index.m3u8', SID);
    expect(r.text).toBe(
      `#EXTM3U\n#EXT-X-MAP:URI="${P('https://cdn.example/hls/720/init.mp4')}"\n#EXTINF:4.0,\n${P('https://cdn.example/hls/720/seg1.ts')}\n#EXTINF:4.0,\n${P('https://cdn.example/hls/720/seg2.ts')}\n#EXT-X-ENDLIST\n`,
    );
  });
});

describe('rewriteDash', () => {
  const MPD = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">',
    '  <BaseURL>https://cdn2.example/dash/</BaseURL>',
    '  <Period id="1">',
    '    <AdaptationSet mimeType="video/mp4">',
    '      <SegmentTemplate timescale="1000" duration="4000" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>',
    '      <Representation id="v720" bandwidth="800000"/>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4">',
    '      <Representation id="a1" bandwidth="128000">',
    '        <BaseURL>audio/a1.mp4</BaseURL>',
    '        <SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
  ].join('\n');

  it('rewrites BaseURLs against their parent base and templates with their fields intact', () => {
    const r = rewriteDash(MPD, 'https://cdn.example/x/manifest.mpd', SID);
    expect(r.text).toContain(`<BaseURL>${P('https://cdn2.example/dash/')}</BaseURL>`);
    expect(r.text).toContain(`<BaseURL>${P('https://cdn2.example/dash/audio/a1.mp4')}</BaseURL>`);
    const prefix = `/api/stream/sessions/${SID}/p?u=`;
    expect(r.text).toContain(
      `media="${prefix}${encodeURIComponent('https://cdn2.example/dash/')}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s')}"`,
    );
    expect(r.text).toContain(`initialization="${prefix}${encodeURIComponent('https://cdn2.example/dash/')}$RepresentationID$${encodeURIComponent('/init.mp4')}"`);
    expect(r.text).toContain('<SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>');
    expect(r.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(r.text).not.toContain('https://');
    expect(r.urls.map((u) => new URL(u).host)).toEqual(['cdn2.example', 'cdn2.example', 'cdn2.example', 'cdn2.example']);
  });

  it('leaves a non-http xlink:href alone', () => {
    const text = '<MPD><Period xlink:href="urn:mpeg:dash:resolve-to-zero:2013"/></MPD>';
    expect(rewriteDash(text, 'https://cdn.example/m.mpd', SID).text).toBe(text);
  });
});

describe('srtToVtt', () => {
  it('turns SubRip into WebVTT and leaves WebVTT alone', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello.\r\n')).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello.\n');
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHi.\n';
    expect(srtToVtt(vtt)).toBe(vtt);
  });
});
```
**Check:** `npx vitest run tests/unit/directStream/rewrite.test.ts` passes.

### Step 6: Sessions
**File:** `src/directStream/sessions.ts` (new)
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { absoluteHttp } from './rewrite.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from './types.js';

/** A session ends this long after its last request (the player fetches every few seconds while it plays). */
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
/** ... and this long after it began, whatever happens. */
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** More live sessions than this: the least recently used goes. */
export const MAX_SESSIONS = 32;
/** 24 random bytes, base64url: 32 characters, 192 bits. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** One resolved title the player may stream. In memory only: a daemon restart ends every session. */
export interface StreamSession {
  readonly id: string;
  readonly ref: StreamRef;
  source: ResolvedSource;
  /** The last resolve's attempts, as the resolver printed them. */
  attempts: ResolveAttempt[];
  /** `URL.host` (with port) of every host this session may fetch. */
  allowedHosts: Set<string>;
  /** Where the player starts, in seconds; null: from the start. */
  resumeS: number | null;
  readonly createdAt: Date;
  refreshedAt: Date;
  lastUsedAt: Date;
}

function hostOf(url: string): string | null {
  const abs = absoluteHttp(url);
  return abs === null ? null : new URL(abs).host.toLowerCase();
}

/** The hosts a resolve returned: the manifest's and every subtitle track's. */
export function sourceHosts(source: ResolvedSource): Set<string> {
  const hosts = new Set<string>();
  for (const url of [source.manifest_url, ...source.subtitles.map((t) => t.url)]) {
    const host = hostOf(url);
    if (host !== null) hosts.add(host);
  }
  return hosts;
}

/** True when `url` is http(s) on a host this session may fetch. */
export function allows(session: StreamSession, url: string): boolean {
  const host = hostOf(url);
  return host !== null && session.allowedHosts.has(host);
}

/** Lets the session fetch `url`'s host. Called only with addresses named by an answer fetched through the session. */
export function learn(session: StreamSession, url: string): void {
  const host = hostOf(url);
  if (host !== null) session.allowedHosts.add(host);
}

export class SessionStore {
  private readonly sessions = new Map<string, StreamSession>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(ref: StreamRef, source: ResolvedSource, attempts: ResolveAttempt[], resumeS: number | null = null): StreamSession {
    this.sweep();
    const at = this.now();
    const session: StreamSession = {
      id: randomBytes(24).toString('base64url'),
      ref,
      source,
      attempts,
      allowedHosts: sourceHosts(source),
      resumeS,
      createdAt: at,
      refreshedAt: at,
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

  /** The live session with this id, marked used now; null when the id is malformed, unknown or ended. */
  get(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const now = this.now();
    if (now.getTime() >= this.expiresAt(session).getTime()) {
      this.sessions.delete(id);
      return null;
    }
    session.lastUsedAt = now;
    return session;
  }

  /** A refresh: the new source, its hosts added to the ones the session already had. */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
  }

  expiresAt(session: StreamSession): Date {
    return new Date(Math.min(session.lastUsedAt.getTime() + SESSION_IDLE_MS, session.createdAt.getTime() + SESSION_MAX_MS));
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [id, session] of this.sessions) if (now >= this.expiresAt(session).getTime()) this.sessions.delete(id);
  }
}
```
**Test:** `tests/unit/directStream/sessions.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import { MAX_SESSIONS, SESSION_IDLE_MS, SESSION_MAX_MS, SessionStore, allows, learn } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const SOURCE: ResolvedSource = {
  provider: 'VidFast',
  embed_url: 'https://vidfast.pro/movie/550',
  manifest_url: 'https://cdn.example:8443/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: 'Chrome/130' },
  subtitles: [{ url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 2160,
  en_subtitle: true,
  took_s: 2.3,
};

function clock(start = '2026-11-15T12:00:00Z'): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

describe('SessionStore', () => {
  it('mints 32-character random ids that do not repeat', () => {
    const store = new SessionStore();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(store.create(REF, SOURCE, []).id);
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('ends a session 4 hours after its last use, and keeps it while it is used', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(s.id)).toBe(s);
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(s.id)).toBe(s);
    c.advance(SESSION_IDLE_MS);
    expect(store.get(s.id)).toBeNull();
    expect(store.get(s.id)).toBeNull();
  });

  it('ends a session 24 hours after it began, however often it is used', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    for (let h = 1; h < 24; h++) {
      c.advance(60 * 60 * 1000);
      expect(store.get(s.id)).toBe(s);
    }
    c.advance(SESSION_MAX_MS - 23 * 60 * 60 * 1000);
    expect(store.get(s.id)).toBeNull();
  });

  it('answers null for a malformed or unknown id', () => {
    const store = new SessionStore();
    store.create(REF, SOURCE, []);
    expect(store.get('nope')).toBeNull();
    expect(store.get('A'.repeat(32))).toBeNull();
  });

  it('drops the least recently used session past the cap', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const first = store.create(REF, SOURCE, []);
    for (let i = 0; i < MAX_SESSIONS; i++) {
      c.advance(1000);
      store.create(REF, SOURCE, []);
    }
    expect(store.size).toBe(MAX_SESSIONS);
    expect(store.get(first.id)).toBeNull();
  });
});

describe('the host allow list', () => {
  it('allows the hosts the resolve returned, then a host the session learned, and nothing else', () => {
    const s = new SessionStore().create(REF, SOURCE, []);
    expect(allows(s, 'https://cdn.example:8443/hls/720.m3u8')).toBe(true);
    expect(allows(s, 'https://subs.example/fr.vtt')).toBe(true);
    expect(allows(s, 'https://cdn.example/hls/720.m3u8')).toBe(false);
    expect(allows(s, 'https://seg.example/1.ts')).toBe(false);
    expect(allows(s, 'file:///etc/passwd')).toBe(false);
    learn(s, 'https://seg.example/1.ts');
    expect(allows(s, 'https://SEG.example/2.ts')).toBe(true);
  });

  it('keeps the old hosts and adds the new ones on a refresh', () => {
    const store = new SessionStore();
    const s = store.create(REF, SOURCE, []);
    learn(s, 'https://seg.example/1.ts');
    store.replaceSource(s, { ...SOURCE, manifest_url: 'https://cdn3.example/m.m3u8', subtitles: [] }, []);
    expect(allows(s, 'https://cdn3.example/x.m3u8')).toBe(true);
    expect(allows(s, 'https://seg.example/2.ts')).toBe(true);
    expect(allows(s, 'https://cdn.example:8443/hls/master.m3u8')).toBe(true);
  });
});
```
**Check:** `npx vitest run tests/unit/directStream/sessions.test.ts` passes.

### Step 7: The fixture stream host and the fake resolver
**File:** `tests/fixtures/direct-stream/upstream.mjs` (new)
**Code:**
```js
// The stream host stand-in for direct-streaming tests (tests/integration/directStream.*) and for
// `verify.sh up --direct-stream`. Like VidFast's host it answers 403 unless the request carries the
// embed's Referer. It listens on two ports of 127.0.0.1: the fake resolver returns addresses on the
// first; the second is named only inside the playlists and the manifest, so a test can tell a host
// the resolve returned from one a playlist named.
//
//   node upstream.mjs --info FILE [--log FILE]
//     writes {"origin", "alt_origin"} to FILE once listening; one JSON line per request to the log.
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_REFERER = 'https://embed.fixture/';
export const FIXTURE_ORIGIN = 'https://embed.fixture';
export const FIXTURE_USER_AGENT = 'FixtureChrome/1.0';
export const SEGMENT_BYTES = 1000;

const SEGMENT = Buffer.from(Array.from({ length: SEGMENT_BYTES }, (_, i) => i % 256));
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n';
const SRT = '1\r\n00:00:01,000 --> 00:00:03,000\r\nHello.\r\n';

function hlsMaster(alt) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,SUBTITLES="subs"',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,SUBTITLES="subs"',
    `${alt}/hls/1080/index.m3u8`,
    '',
  ].join('\n');
}

function hlsMedia(quality) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXTINF:4.0,',
    `/hls/${quality}/seg2.ts`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

const SUB_PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:60', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:60.0,', 'en.vtt', '#EXT-X-ENDLIST', ''].join('\n');

function dashManifest(alt) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">',
    `  <BaseURL>${alt}/dash/</BaseURL>`,
    '  <Period id="1">',
    '    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">',
    '      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>',
    '      <Representation id="v720" bandwidth="800000" width="1280" height="720"/>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4" lang="en">',
    '      <Representation id="a1" bandwidth="128000">',
    '        <BaseURL>audio/a1.mp4</BaseURL>',
    '        <SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n');
}

/** [status, content type, body] for a path, or null (404). */
function answer(pathname, alt) {
  if (pathname === '/hls/master.m3u8') return [200, 'application/vnd.apple.mpegurl', hlsMaster(alt)];
  const media = /^\/hls\/(720|1080)\/index\.m3u8$/.exec(pathname);
  if (media) return [200, 'application/vnd.apple.mpegurl', hlsMedia(media[1])];
  if (pathname === '/hls/subs/en.m3u8') return [200, 'application/vnd.apple.mpegurl', SUB_PLAYLIST];
  if (pathname === '/hls/subs/en.vtt' || pathname === '/subs/en.vtt') return [200, 'text/vtt', VTT];
  if (pathname === '/subs/en.srt') return [200, 'application/x-subrip', SRT];
  if (pathname === '/dash/manifest.mpd') return [200, 'application/dash+xml', dashManifest(alt)];
  if (pathname === '/expired.m3u8') return [410, 'text/plain', 'token expired'];
  if (/^\/(hls|dash)\/.+\.(ts|m4s|mp4)$/.test(pathname)) return [200, pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', SEGMENT];
  return null;
}

/** Starts the fixture host on two free ports of 127.0.0.1. `requests` lists every request it got. */
export async function startUpstream({ log = null } = {}) {
  const requests = [];
  let alt = '';
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const entry = {
      method: req.method,
      host: req.headers.host ?? null,
      path: url.pathname,
      referer: req.headers.referer ?? null,
      origin: req.headers.origin ?? null,
      user_agent: req.headers['user-agent'] ?? null,
      range: req.headers.range ?? null,
      cookie: req.headers.cookie ?? null,
      status: 0,
    };
    const reply = (status, type, body, extra = {}) => {
      entry.status = status;
      requests.push(entry);
      if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    if (entry.referer !== FIXTURE_REFERER) return reply(403, 'text/plain', 'referer required');
    const found = answer(url.pathname, alt);
    if (found === null) return reply(404, 'text/plain', 'not found');
    const [status, type, body] = found;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
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
  const listen = () =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  const main = await listen();
  const second = await listen();
  const origin = `http://127.0.0.1:${main.address().port}`;
  alt = `http://127.0.0.1:${second.address().port}`;
  const close = () =>
    Promise.all(
      [main, second].map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    ).then(() => undefined);
  return { origin, altOrigin: alt, requests, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
  };
  const info = arg('--info');
  if (!info) {
    console.error('usage: upstream.mjs --info FILE [--log FILE]');
    process.exit(2);
  }
  const up = await startUpstream({ log: arg('--log') });
  writeFileSync(info, JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  process.on('SIGTERM', () => {
    up.close().then(() => process.exit(0));
  });
}
```
**File:** `tests/fixtures/direct-stream/fake-cli.mjs` (new)
**Code:**
```js
#!/usr/bin/env node
// Stands in for claude/streaming/direct/cli.mjs in tests and in `verify.sh up --direct-stream`: it opens
// no Chrome and reaches no provider. Its state is the folder named by DIRECT_STREAM_FAKE_DIR:
//   upstream.json  {"origin": ...} of the fixture stream host (upstream.mjs) its answers point at
//   mode           hls (default) | dash | no_source | no_chrome: the next resolve's answer
//   calls.jsonl    one line per call, appended: {"at", "args"}
// `resolve` answers like the real CLI, reading --providers and skipping browser-only rows: with two or
// more usable providers the first is a bot_check and the second resolves; with one, it resolves; with
// none, no_source. `open` answers {"ok": true}.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_ORIGIN, FIXTURE_REFERER, FIXTURE_USER_AGENT } from './upstream.mjs';

const dir = process.env.DIRECT_STREAM_FAKE_DIR;
const args = process.argv.slice(2);

function print(value, code = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = code;
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function main() {
  if (!dir) return print({ ok: false, error: 'fake_not_configured', detail: 'set DIRECT_STREAM_FAKE_DIR' }, 2);
  appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args })}\n`);
  if (args[0] === 'open') return print({ ok: true, url: args[1] ?? null, fullscreen: args.includes('--fullscreen') });
  if (args[0] !== 'resolve') return print({ ok: false, error: 'usage', detail: `unknown command ${args[0] ?? ''}` }, 2);
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++;
      continue;
    }
    positional.push(args[i]);
  }
  const [kind, id, season, episode] = positional;
  const ref = {
    kind,
    tmdb_id: Number(id),
    season: season === undefined ? null : Number(season),
    episode: episode === undefined ? null : Number(episode),
  };
  const modeFile = path.join(dir, 'mode');
  const mode = (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : '') || 'hls';
  const providersFile = flag('--providers');
  const providers = providersFile
    ? JSON.parse(readFileSync(providersFile, 'utf8'))
        .filter((p) => !p.browser_only)
        .map((p) => p.name)
    : [];
  if (mode === 'no_chrome') return print({ ok: false, ...ref, source: null, error: 'no_chrome', detail: 'fake: Chrome is not installed', attempts: [] }, 1);
  if (mode === 'no_source' || providers.length === 0) {
    return print(
      {
        ok: false,
        ...ref,
        source: null,
        error: 'no_source',
        attempts: providers.slice(0, 2).map((name) => ({ provider: name, outcome: 'no_stream', took_s: 0.5, detail: 'fake: nothing captured' })),
      },
      1,
    );
  }
  const { origin } = JSON.parse(readFileSync(path.join(dir, 'upstream.json'), 'utf8'));
  const chosen = providers.length > 1 ? providers[1] : providers[0];
  const attempts = providers.length > 1 ? [{ provider: providers[0], outcome: 'bot_check', took_s: 1.2, detail: 'fake: Just a moment...' }] : [];
  attempts.push({ provider: chosen, outcome: 'resolved', took_s: 2.5, detail: '' });
  return print({
    ok: true,
    ...ref,
    source: {
      provider: chosen,
      embed_url: `https://embed.fixture/${kind}/${id}`,
      manifest_url: mode === 'dash' ? `${origin}/dash/manifest.mpd` : `${origin}/hls/master.m3u8`,
      manifest_kind: mode === 'dash' ? 'dash' : 'hls',
      headers: { referer: FIXTURE_REFERER, origin: FIXTURE_ORIGIN, user_agent: FIXTURE_USER_AGENT },
      subtitles: [{ url: `${origin}/subs/en.srt`, lang: 'en', label: 'English', format: 'srt', source: 'request' }],
      best_height: 1080,
      en_subtitle: true,
      took_s: 2.5,
    },
    attempts,
  });
}

main();
```
**Check:** `node tests/fixtures/direct-stream/fake-cli.mjs open http://localhost:1/x` prints `"ok": false` with `fake_not_configured` (no dir set) and exits 2.
**Impact:** test-only files; outside the env scan of `scripts/docs/reference.ts` (which reads `src/`, `claude/`, `scripts/`).

### Step 8: Running the resolver
**File:** `src/directStream/runner.ts` (new)
**Code:**
```ts
import { z } from 'zod';
import { runJsonScript } from '../streaming/service.js';
import { absoluteHttp } from './rewrite.js';
import {
  DirectStreamError,
  MANIFEST_KINDS,
  RESOLVE_OUTCOMES,
  isEnglish,
  type ResolveAttempt,
  type ResolveOutput,
  type SubtitleTrack,
} from './types.js';

/** A whole resolve can try 24 providers at up to ~45 s each (phase 1); a single `--only` try is far shorter. */
export const DIRECT_STREAM_TIMEOUT_MS = 1_200_000;

/**
 * Runs `claude/streaming/direct/cli.mjs <args...>` and returns the one JSON object it prints, also on
 * a non-zero exit. The daemon never talks to a provider or to Chrome itself; tests inject a fake.
 */
export type DirectStreamRunner = (args: string[]) => Promise<unknown>;

export interface DirectStreamScriptOptions {
  cliPath: string;
  /** Default: the node running the daemon. */
  nodeBin?: string;
  timeoutMs?: number;
}

export function directStreamScriptRunner(options: DirectStreamScriptOptions): DirectStreamRunner {
  const nodeBin = options.nodeBin ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DIRECT_STREAM_TIMEOUT_MS;
  return (args) => runJsonScript({ label: 'direct stream script', nodeBin, argv: [options.cliPath, ...args], timeoutMs });
}

const attemptSchema = z.object({
  provider: z.string().min(1),
  outcome: z.enum(RESOLVE_OUTCOMES),
  took_s: z.number().nonnegative().nullish(),
  detail: z.string().nullish(),
});

const subtitleSchema = z.object({
  url: z.string(),
  lang: z.string().nullish(),
  label: z.string().nullish(),
  format: z.string().nullish(),
  source: z.enum(['request', 'manifest']).nullish(),
});

const sourceSchema = z.object({
  provider: z.string().min(1),
  embed_url: z.string().nullish(),
  manifest_url: z.string().refine((u) => absoluteHttp(u) !== null, 'manifest_url must be an http(s) address'),
  manifest_kind: z.enum(MANIFEST_KINDS),
  headers: z.object({ referer: z.string().nullish(), origin: z.string().nullish(), user_agent: z.string().nullish() }).nullish(),
  subtitles: z.array(subtitleSchema).nullish(),
  best_height: z.number().int().positive().nullish(),
  en_subtitle: z.boolean().nullish(),
  took_s: z.number().nonnegative().nullish(),
});

const outputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), source: sourceSchema, attempts: z.array(attemptSchema).nullish() }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    detail: z.string().nullish(),
    message: z.string().nullish(),
    attempts: z.array(attemptSchema).nullish(),
  }),
]);

const openSchema = z.object({ ok: z.boolean(), error: z.string().nullish(), detail: z.string().nullish(), message: z.string().nullish() });

const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value);

function toAttempt(a: z.infer<typeof attemptSchema>): ResolveAttempt {
  return { provider: a.provider, outcome: a.outcome, took_s: a.took_s ?? null, detail: a.detail ?? '' };
}

/**
 * The resolver's printed answer, validated once here (the boundary) and normalized: header values are
 * null when not sent, subtitle tracks that are not http(s) are dropped, `en_subtitle` is computed when
 * the resolver left it out. An answer that does not fit throws `resolve_failed` / `bad_output`.
 */
export function parseResolveOutput(raw: unknown): ResolveOutput {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ');
    throw new DirectStreamError('resolve_failed', `The resolver printed an answer notesd cannot read: ${issues}`, { reason: 'bad_output' });
  }
  const out = parsed.data;
  const attempts = (out.attempts ?? []).map(toAttempt);
  if (!out.ok) return { ok: false, source: null, error: out.error, detail: out.detail ?? out.message ?? '', attempts };
  const s = out.source;
  const subtitles: SubtitleTrack[] = [];
  for (const t of s.subtitles ?? []) {
    const url = absoluteHttp(t.url);
    if (url === null) continue;
    subtitles.push({ url, lang: present(t.lang), label: t.label ?? '', format: (t.format ?? 'vtt').toLowerCase(), source: t.source ?? 'request' });
  }
  return {
    ok: true,
    attempts,
    source: {
      provider: s.provider,
      embed_url: s.embed_url ?? '',
      manifest_url: s.manifest_url,
      manifest_kind: s.manifest_kind,
      headers: { referer: present(s.headers?.referer), origin: present(s.headers?.origin), user_agent: present(s.headers?.user_agent) },
      subtitles,
      best_height: s.best_height ?? null,
      en_subtitle: s.en_subtitle ?? subtitles.some(isEnglish),
      took_s: s.took_s ?? null,
    },
  };
}

export type OpenOutput = { ok: true } | { ok: false; error: string; detail: string };

/** `cli.mjs open`'s answer. One that does not fit is an `open` failure named `bad_output`. */
export function parseOpenOutput(raw: unknown): OpenOutput {
  const parsed = openSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_output', detail: 'the resolver printed an answer notesd cannot read' };
  if (parsed.data.ok) return { ok: true };
  return { ok: false, error: parsed.data.error ?? 'open_failed', detail: parsed.data.detail ?? parsed.data.message ?? '' };
}
```
**Test:** `tests/unit/directStream/runner.test.ts` (new):
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput } from '../../../src/directStream/runner.js';
import { DirectStreamError } from '../../../src/directStream/types.js';

const FAKE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/direct-stream/fake-cli.mjs');

const RESOLVED = {
  ok: true,
  kind: 'movie',
  tmdb_id: 550,
  season: null,
  episode: null,
  source: {
    provider: 'VidFast',
    embed_url: 'https://vidfast.pro/movie/550?autoPlay=true',
    manifest_url: 'https://cdn.example/hls/master.m3u8',
    manifest_kind: 'hls',
    headers: { referer: 'https://vidfast.vc/', origin: null, user_agent: 'Mozilla/5.0 Chrome/130' },
    subtitles: [
      { url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'VTT', source: 'request' },
      { url: 'blob:https://vidfast.pro/abc', lang: 'en', label: 'English', format: 'vtt', source: 'request' },
    ],
    best_height: 2160,
    took_s: 2.3,
  },
  attempts: [
    { provider: 'VidNest', outcome: 'skipped_browser_only', took_s: null, detail: '' },
    { provider: 'VidFast', outcome: 'resolved', took_s: 2.3, detail: '' },
  ],
};

describe('parseResolveOutput', () => {
  it('reads a resolved answer, drops subtitle tracks that are not http(s) and computes en_subtitle', () => {
    const out = parseResolveOutput(RESOLVED);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source.headers).toEqual({ referer: 'https://vidfast.vc/', origin: null, user_agent: 'Mozilla/5.0 Chrome/130' });
    expect(out.source.subtitles).toEqual([{ url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }]);
    expect(out.source.en_subtitle).toBe(true);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['skipped_browser_only', 'resolved']);
  });

  it('reads a failure with every attempt', () => {
    const out = parseResolveOutput({ ok: false, source: null, error: 'no_source', attempts: [{ provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...' }] });
    expect(out).toEqual({ ok: false, source: null, error: 'no_source', detail: '', attempts: [{ provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...' }] });
  });

  it('refuses an answer it cannot read as resolve_failed / bad_output', () => {
    const bad = { ...RESOLVED, source: { ...RESOLVED.source, manifest_url: 'blob:https://x/1' } };
    try {
      parseResolveOutput(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DirectStreamError);
      expect((err as DirectStreamError).code).toBe('resolve_failed');
      expect((err as DirectStreamError).reason).toBe('bad_output');
    }
  });

  it('reads the open answers', () => {
    expect(parseOpenOutput({ ok: true, url: 'http://localhost:7317/stream/x', fullscreen: true })).toEqual({ ok: true });
    expect(parseOpenOutput({ ok: false, url: 'x', error: 'chrome_not_reachable', detail: 'port 9333' })).toEqual({ ok: false, error: 'chrome_not_reachable', detail: 'port 9333' });
    expect(parseOpenOutput('nonsense')).toMatchObject({ ok: false, error: 'bad_output' });
  });
});

describe('directStreamScriptRunner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-runner-'));
  });
  afterEach(async () => {
    delete process.env.DIRECT_STREAM_FAKE_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('passes the arguments and returns the printed JSON, also on a non-zero exit', async () => {
    const ok = path.join(dir, 'ok.mjs');
    await writeFile(ok, 'console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));');
    expect(await directStreamScriptRunner({ cliPath: ok })(['open', 'http://localhost:1/stream/x', '--fullscreen'])).toEqual({ ok: true, argv: ['open', 'http://localhost:1/stream/x', '--fullscreen'] });
    const failing = path.join(dir, 'fail.mjs');
    await writeFile(failing, 'console.log(JSON.stringify({ ok: false, error: "no_source", attempts: [] })); process.exitCode = 1;');
    expect(await directStreamScriptRunner({ cliPath: failing })(['resolve', 'movie', '1'])).toEqual({ ok: false, error: 'no_source', attempts: [] });
    const silent = path.join(dir, 'silent.mjs');
    await writeFile(silent, 'process.exitCode = 1;');
    await expect(directStreamScriptRunner({ cliPath: silent })([])).rejects.toThrow(/direct stream script failed/);
  });

  it('runs the fixture fake resolver end to end', async () => {
    process.env.DIRECT_STREAM_FAKE_DIR = dir;
    await writeFile(path.join(dir, 'upstream.json'), JSON.stringify({ origin: 'http://127.0.0.1:9' }));
    const providers = path.join(dir, 'providers.json');
    await writeFile(providers, JSON.stringify([{ name: 'A', browser_only: false }, { name: 'B', browser_only: false }]));
    const out = parseResolveOutput(await directStreamScriptRunner({ cliPath: FAKE_CLI })(['resolve', 'movie', '550', '--providers', providers]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source.provider).toBe('B');
    expect(out.source.manifest_url).toBe('http://127.0.0.1:9/hls/master.m3u8');
    expect(out.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual(['A:bot_check', 'B:resolved']);
  });

  it('reads a resolve cut short by --deadline-s as a failure that is not no_source', () => {
    const out = parseResolveOutput({ ok: false, source: null, error: 'deadline', detail: 'stopped after 30 s; 20 provider(s) not tried', attempts: [] });
    expect(out).toMatchObject({ ok: false, error: 'deadline' });
  });
});
```
**Check:** `npx vitest run tests/unit/directStream/runner.test.ts` passes.

### Step 9: The registry repo and the seed reader
**File:** `src/directStream/repo.ts` (new)
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  STREAM_ID_KINDS,
  streamProviderHealth,
  streamProviders,
  type StreamHealthOutcome,
  type StreamIdKind,
  type StreamManifestKind,
  type StreamProviderHealthRow,
  type StreamProviderRow,
} from '../db/schema.js';
import type { ResolvedSource } from './types.js';

/** How many of a provider's latest times to a stream are kept per host. */
export const RECENT_TIMINGS = 10;
const MAX_DETAIL = 500;

/** One entry of claude/streaming/direct/providers.seed.json, read and checked. */
export interface SeedProvider {
  name: string;
  idKind: StreamIdKind;
  movie: string;
  tv: string | null;
  browserOnly: boolean;
  enSubtitle: boolean | null;
  notes: string;
}

const template = z
  .string()
  .trim()
  .refine((s) => /^https?:\/\//.test(s) && s.includes('{id}'), 'must be an http(s) address with {id}');

const seedEntry = z.object({
  name: z.string().trim().min(1).max(80),
  id_kind: z.enum(STREAM_ID_KINDS).default('tmdb'),
  movie: template,
  tv: template.nullable().default(null),
  browser_only: z.boolean().default(false),
  en_subtitle: z.boolean().nullable().default(null),
  notes: z.string().default(''),
});

/** Reads and checks the seed file (the boundary for it). Throws with the file name on any problem, a repeated name included. */
export async function readSeedFile(file: string): Promise<SeedProvider[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not readable JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = z.array(seedEntry).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const seen = new Set<string>();
  return parsed.data.map((e) => {
    if (seen.has(e.name)) throw new Error(`${file}: provider "${e.name}" appears twice`);
    seen.add(e.name);
    return { name: e.name, idKind: e.id_kind, movie: e.movie, tv: e.tv, browserOnly: e.browser_only, enSubtitle: e.en_subtitle, notes: e.notes };
  });
}

/** A registry row in the seed file's shape: what `cli.mjs resolve --providers <file>` reads. */
export interface ProviderSeedJson {
  name: string;
  id_kind: StreamIdKind;
  movie: string;
  tv: string | null;
  browser_only: boolean;
  en_subtitle: boolean | null;
  notes: string;
}

export function providerSeedJson(row: StreamProviderRow): ProviderSeedJson {
  return { name: row.name, id_kind: row.idKind, movie: row.movie, tv: row.tv, browser_only: row.browserOnly, en_subtitle: row.enSubtitle, notes: row.notes };
}

/** One provider's health on this host, as `cli.mjs resolve --health <file>` reads it. */
export interface ProviderHealthJson {
  en_subtitle: boolean | null;
  best_height: number | null;
  median_s: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function healthMap(rows: readonly StreamProviderHealthRow[]): Record<string, ProviderHealthJson> {
  const out: Record<string, ProviderHealthJson> = {};
  for (const r of rows) {
    out[r.name] = {
      en_subtitle: r.enSubtitle,
      best_height: r.bestHeight,
      median_s: median(r.recentS),
      last_success_at: iso(r.lastSuccessAt),
      last_failure_at: iso(r.lastFailureAt),
      consecutive_failures: r.consecutiveFailures,
    };
  }
  return out;
}

/** What `providers()` (and phase 8's `direct_stream_sources`) shows of one provider. */
export interface ProviderView extends ProviderSeedJson {
  /** Null: from the checked-in seed. */
  origin_site: string | null;
  added_at: string;
  /** This host's health; null until a resolve tried the provider here. */
  health:
    | (ProviderHealthJson & {
        last_outcome: StreamHealthOutcome;
        last_detail: string;
        successes: number;
        failures: number;
        manifest_kind: StreamManifestKind | null;
      })
    | null;
}

export function providerView(row: StreamProviderRow, health: StreamProviderHealthRow | null): ProviderView {
  return {
    ...providerSeedJson(row),
    origin_site: row.originSite,
    added_at: row.addedAt.toISOString(),
    health:
      health === null
        ? null
        : {
            en_subtitle: health.enSubtitle,
            best_height: health.bestHeight,
            median_s: median(health.recentS),
            last_success_at: iso(health.lastSuccessAt),
            last_failure_at: iso(health.lastFailureAt),
            consecutive_failures: health.consecutiveFailures,
            last_outcome: health.lastOutcome,
            last_detail: health.lastDetail,
            successes: health.successes,
            failures: health.failures,
            manifest_kind: health.manifestKind,
          },
  };
}

/** One provider's try in one resolve, to record. `source` is set on the try that resolved. */
export interface HealthAttempt {
  provider: string;
  outcome: StreamHealthOutcome;
  took_s: number | null;
  detail: string;
  source: ResolvedSource | null;
}

/** The only writer of `stream_providers` and `stream_provider_health`. */
export class DirectStreamRepo {
  constructor(private readonly db: Db) {}

  /**
   * Loads the seed: a missing provider is inserted (`origin_site` null); a seed row whose fields
   * changed in the file is updated. A row a site added (`origin_site` set) is never touched, and
   * nothing is deleted. Returns how many rows were inserted and updated.
   */
  async syncSeed(entries: readonly SeedProvider[], now: Date = new Date()): Promise<{ inserted: number; updated: number }> {
    if (entries.length === 0) return { inserted: 0, updated: 0 };
    const p = streamProviders;
    const rows = await this.db
      .insert(p)
      .values(
        entries.map((e) => ({
          name: e.name,
          idKind: e.idKind,
          movie: e.movie,
          tv: e.tv,
          browserOnly: e.browserOnly,
          enSubtitle: e.enSubtitle,
          notes: e.notes,
          originSite: null,
          addedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: p.name,
        set: {
          idKind: sql`excluded.id_kind`,
          movie: sql`excluded.movie`,
          tv: sql`excluded.tv`,
          browserOnly: sql`excluded.browser_only`,
          enSubtitle: sql`excluded.en_subtitle`,
          notes: sql`excluded.notes`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`${p.originSite} is null and (${p.idKind} is distinct from excluded.id_kind or ${p.movie} is distinct from excluded.movie or ${p.tv} is distinct from excluded.tv or ${p.browserOnly} is distinct from excluded.browser_only or ${p.enSubtitle} is distinct from excluded.en_subtitle or ${p.notes} is distinct from excluded.notes)`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    const inserted = rows.filter((r) => r.inserted).length;
    return { inserted, updated: rows.length - inserted };
  }

  /** Every provider, by name. */
  async providers(): Promise<StreamProviderRow[]> {
    return this.db.select().from(streamProviders).orderBy(asc(streamProviders.name));
  }

  /** This host's health rows. */
  async healthFor(host: string): Promise<StreamProviderHealthRow[]> {
    return this.db.select().from(streamProviderHealth).where(eq(streamProviderHealth.host, host));
  }

  /** Records one resolve's tries for `host`, in one transaction. */
  async recordAttempts(host: string, attempts: readonly HealthAttempt[], now: Date = new Date()): Promise<void> {
    if (attempts.length === 0) return;
    const h = streamProviderHealth;
    await this.db.transaction(async (tx) => {
      for (const a of attempts) {
        const detail = a.detail.slice(0, MAX_DETAIL);
        if (a.outcome === 'resolved') {
          const seen =
            a.source === null
              ? {}
              : { manifestKind: a.source.manifest_kind, bestHeight: a.source.best_height, enSubtitle: a.source.en_subtitle };
          await tx
            .insert(h)
            .values({
              name: a.provider,
              host,
              lastOutcome: 'resolved',
              lastDetail: detail,
              successes: 1,
              failures: 0,
              consecutiveFailures: 0,
              lastSuccessAt: now,
              recentS: a.took_s === null ? [] : [a.took_s],
              ...seen,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [h.name, h.host],
              set: {
                lastOutcome: 'resolved',
                lastDetail: detail,
                successes: sql`${h.successes} + 1`,
                consecutiveFailures: 0,
                lastSuccessAt: now,
                recentS:
                  a.took_s === null
                    ? sql`${h.recentS}`
                    : sql`(array_append(${h.recentS}, ${a.took_s}::real))[greatest(1, cardinality(${h.recentS}) - ${RECENT_TIMINGS - 2}):]`,
                ...seen,
                updatedAt: now,
              },
            });
        } else {
          await tx
            .insert(h)
            .values({
              name: a.provider,
              host,
              lastOutcome: a.outcome,
              lastDetail: detail,
              successes: 0,
              failures: 1,
              consecutiveFailures: 1,
              lastFailureAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [h.name, h.host],
              set: {
                lastOutcome: a.outcome,
                lastDetail: detail,
                failures: sql`${h.failures} + 1`,
                consecutiveFailures: sql`${h.consecutiveFailures} + 1`,
                lastFailureAt: now,
                updatedAt: now,
              },
            });
        }
      }
    });
  }
}
```
**Test:** `tests/unit/directStream/seed.test.ts` (new):
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { median, readSeedFile } from '../../../src/directStream/repo.js';
import { DEFAULT_SEED_FILE } from '../../../src/directStream/service.js';

describe('readSeedFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-seed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const seed = async (value: unknown): Promise<string> => {
    const file = path.join(dir, 'seed.json');
    await writeFile(file, JSON.stringify(value));
    return file;
  };

  it('reads entries and fills the defaults', async () => {
    expect(await readSeedFile(await seed([{ name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true' }]))).toEqual([
      { name: 'VidFast', idKind: 'tmdb', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true', tv: null, browserOnly: false, enSubtitle: null, notes: '' },
    ]);
  });

  it('refuses a repeated name, a template without {id} and a file that is not JSON', async () => {
    await expect(readSeedFile(await seed([{ name: 'A', movie: 'https://a/{id}' }, { name: 'A', movie: 'https://b/{id}' }]))).rejects.toThrow(/appears twice/);
    await expect(readSeedFile(await seed([{ name: 'A', movie: 'https://a/movie' }]))).rejects.toThrow(/\{id\}/);
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '[{');
    await expect(readSeedFile(broken)).rejects.toThrow(/not readable JSON/);
  });

  it('reads the checked-in seed: at least the 24 fmovies providers, each named once', async () => {
    expect(existsSync(DEFAULT_SEED_FILE)).toBe(true);
    const entries = await readSeedFile(DEFAULT_SEED_FILE);
    expect(entries.length).toBeGreaterThanOrEqual(24);
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
  });
});

describe('median', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
```
**Check:** runs with step 10 (it imports `DEFAULT_SEED_FILE` from `service.ts`).

### Step 10: The pass-through
**File:** `src/directStream/passThrough.ts` (new)
**Code:**
```ts
import { absoluteHttp, rewriteDash, rewriteHls, srtToVtt } from './rewrite.js';
import { allows, learn, type StreamSession } from './sessions.js';
import type { CapturedHeaders } from './types.js';

/** A playlist or manifest larger than this is refused (they are kilobytes; this stops a runaway body). */
export const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024;
/** The stream host must start answering within this; a body then streams for as long as it takes. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
/** Carries the stream host's own status on every forwarded answer; notesd's own refusals never carry it. */
export const UPSTREAM_STATUS_HEADER = 'x-notesd-upstream';
const PASSED_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'] as const;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ForwardRequest {
  /** The `u` query parameter: the stream host address to fetch (empty when missing). */
  target: string;
  /** The player's `Range` header, forwarded as is. */
  range: string | null;
  /** `vtt=1`: the answer is a subtitle file to hand back as WebVTT. */
  vtt: boolean;
  /** Aborted when the player goes away; the stream host request is aborted with it. */
  signal: AbortSignal;
}

export function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Only what the real Chrome's manifest request carried, plus the player's Range. No cookie, nothing invented. */
export function upstreamHeaders(captured: CapturedHeaders, range: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (captured.referer !== null) headers.referer = captured.referer;
  if (captured.origin !== null) headers.origin = captured.origin;
  if (captured.user_agent !== null) headers['user-agent'] = captured.user_agent;
  if (range !== null && range !== '') headers.range = range;
  return headers;
}

type TextKind = 'hls' | 'dash' | 'vtt';

function textKind(target: string, contentType: string, vtt: boolean): TextKind | null {
  if (vtt) return 'vtt';
  const pathname = new URL(target).pathname.toLowerCase();
  if (/mpegurl/i.test(contentType) || /\.m3u8?$/.test(pathname)) return 'hls';
  if (/dash\+xml/i.test(contentType) || pathname.endsWith('.mpd')) return 'dash';
  // VidNest serves its master playlist as master.txt.
  if (pathname.endsWith('.txt') && !/^(video|audio|image)\//i.test(contentType)) return 'hls';
  return null;
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Fetches `req.target` for a live session and hands the answer back. Refuses with 403 `forbidden_host`,
 * before any request, an address that is not http(s) or not on a host the session may reach. Follows
 * redirects itself (a redirect answered by the session's host vouches for its target, like a playlist
 * entry). Playlists and manifests are read whole and rewritten, and the hosts they name join the
 * session; everything else streams through as it arrives, with the stream host's status.
 */
export async function forward(session: StreamSession, req: ForwardRequest, fetchImpl: FetchLike): Promise<Response> {
  const first = absoluteHttp(req.target);
  if (first === null || !allows(session, first)) {
    return jsonError(403, 'forbidden_host', 'That address is not on a host this stream session may reach.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (req.signal.aborted) abort();
  else req.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const headers = upstreamHeaders(session.source.headers, req.range);
  let target = first;
  let upstream: Response;
  try {
    let hops = 0;
    for (;;) {
      const res = await fetchImpl(target, { headers, redirect: 'manual', signal: controller.signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location === null) {
        upstream = res;
        break;
      }
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(location, target);
      hops += 1;
      if (next === null || hops > MAX_REDIRECTS) {
        req.signal.removeEventListener('abort', abort);
        return jsonError(
          502,
          'upstream_error',
          next === null ? 'The stream host redirected to an address that is not http(s).' : `The stream host redirected more than ${MAX_REDIRECTS} times.`,
        );
      }
      learn(session, next);
      target = next;
    }
  } catch (err) {
    req.signal.removeEventListener('abort', abort);
    return jsonError(502, 'upstream_error', `The stream host did not answer: ${messageOf(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers({ 'cache-control': 'no-store', [UPSTREAM_STATUS_HEADER]: String(upstream.status) });
  const contentType = upstream.headers.get('content-type') ?? '';
  const nullBody = NULL_BODY_STATUSES.has(upstream.status);
  const kind = textKind(target, contentType, req.vtt);
  if (kind !== null && !nullBody) {
    let text: string | null;
    try {
      text = await readCapped(upstream, PLAYLIST_MAX_BYTES);
    } catch (err) {
      return jsonError(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
    if (text === null) return jsonError(502, 'upstream_error', `The playlist is larger than ${PLAYLIST_MAX_BYTES} bytes.`);
    let body = text;
    let type = contentType === '' ? 'text/plain; charset=utf-8' : contentType;
    if (kind === 'hls' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) {
      const r = rewriteHls(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/vnd.apple.mpegurl';
    } else if (kind === 'dash' && /<MPD[\s>]/.test(text)) {
      const r = rewriteDash(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/dash+xml';
    } else if (kind === 'vtt' && upstream.ok) {
      body = srtToVtt(text);
      type = 'text/vtt; charset=utf-8';
    }
    out.set('content-type', type);
    return new Response(body, { status: upstream.status, headers: out });
  }
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const length = upstream.headers.get('content-length');
  if (length !== null && upstream.headers.get('content-encoding') === null) out.set('content-length', length);
  return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: out });
}
```
**Impact:** Node's `fetch` also sends its own transport headers (`accept`, `accept-encoding`, `accept-language`, `sec-fetch-mode`); no header that names a client or a page is added by notesd. The guide says so.

### Step 11: The service and its builder
**File:** `src/directStream/service.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import { STREAM_HEALTH_OUTCOMES, type StreamHealthOutcome } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { forward, jsonError, type FetchLike, type ForwardRequest } from './passThrough.js';
import { DirectStreamRepo, healthMap, providerSeedJson, providerView, readSeedFile, type HealthAttempt, type ProviderView } from './repo.js';
import { proxiedUrl } from './rewrite.js';
import { directStreamScriptRunner, parseOpenOutput, parseResolveOutput, type DirectStreamRunner, type OpenOutput } from './runner.js';
import { SessionStore, type StreamSession } from './sessions.js';
import {
  DirectStreamError,
  isEnglish,
  refLabel,
  toStreamRef,
  type ManifestKind,
  type ResolveAttempt,
  type ResolveOutcome,
  type ResolveOutput,
  type ResolvedOutput,
  type StreamRef,
  type StreamRefInput,
} from './types.js';

/** The checked-in provider seed (direct streaming phase 1), loaded into stream_providers at every start. */
export const DEFAULT_SEED_FILE = path.join(REPO_ROOT, 'claude', 'streaming', 'direct', 'providers.seed.json');

/**
 * What the movies store hangs on direct streaming (phase 5 implements them; this module never imports
 * src/movies). Each is optional; a hook that throws is logged and ignored.
 */
export interface DirectStreamHooks {
  /**
   * Awaited after every resolve made by `resolve()`, `play()` or `refresh()`, success or failure, before
   * the caller gets its answer. `result.error` is `no_source` when no provider could stream the title;
   * any other error means the resolve could not run (the streaming Chrome is down) and says nothing
   * about the title. Not called by `runResolve` alone (phase 8's probes).
   */
  recordResolve?: (ref: StreamRef, result: ResolveOutput) => Promise<void>;
  /** Where a new session starts, in seconds, when the caller passed no `resumeS`. */
  resumeS?: (ref: StreamRef) => Promise<number | null>;
  /** The title the player shows; default `refLabel(ref)`. */
  titleLabel?: (ref: StreamRef) => Promise<string | null>;
}

export interface SessionSubtitle {
  /** Pass-through address on this daemon; an `.srt` track's carries `&vtt=1`. */
  url: string;
  lang: string | null;
  label: string;
  /** `vtt` for an `.srt` track (served converted); otherwise the resolver's format. */
  format: string;
  source: 'request' | 'manifest';
  english: boolean;
}

/** What GET /api/stream/sessions/:id answers: what the player page needs. */
export interface SessionInfo {
  session_id: string;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  title: string;
  provider: string;
  manifest_kind: ManifestKind;
  /** Pass-through address on this daemon. */
  manifest_url: string;
  subtitles: SessionSubtitle[];
  best_height: number | null;
  resume_s: number | null;
  created_at: string;
  refreshed_at: string;
  expires_at: string;
}

/** What `play` answers (JSON-ready; the route adds `ok: true`). */
export interface PlayResult {
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

export interface SyncSeedResult {
  total: number;
  inserted: number;
  updated: number;
}

export interface DirectStreamServiceOptions {
  repo: DirectStreamRepo;
  runner: DirectStreamRunner;
  /** os.hostname() (the movies service's host): health rows are written under it. */
  host: string;
  seedFile: string;
  /** The daemon's origin as the streaming Chrome reaches it, e.g. `http://localhost:7317`. Read at play time. */
  pageBase: () => string;
  hooks?: DirectStreamHooks;
  sessions?: SessionStore;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isHealthOutcome(outcome: ResolveOutcome): outcome is StreamHealthOutcome {
  return (STREAM_HEALTH_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Direct streaming on this host: the registry, resolves through the resolver CLI, sessions and the
 * pass-through. Every resolve and every `open` runs one at a time, since they share the one streaming
 * Chrome. Held in AppDeps.directStream; the routes (src/http/directStreamApi.ts) and the tools
 * (phase 7, 8) call it.
 */
export class DirectStreamService {
  private readonly repo: DirectStreamRepo;
  private readonly runner: DirectStreamRunner;
  private readonly sessions: SessionStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: FetchLike;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: DirectStreamServiceOptions) {
    this.repo = opts.repo;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
    this.sessions = opts.sessions ?? new SessionStore(this.now);
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get host(): string {
    return this.opts.host;
  }

  /** Loads the seed file into the shared registry (insert missing, update changed seed rows). */
  async syncSeed(): Promise<SyncSeedResult> {
    const entries = await readSeedFile(this.opts.seedFile);
    const { inserted, updated } = await this.repo.syncSeed(entries, this.now());
    return { total: entries.length, inserted, updated };
  }

  /**
   * Resolves the title and makes a session for it. Throws `no_source` (every attempt in `attempts`) or
   * `resolve_failed` (with `reason`; `deadline` when `deadlineS` cut it short). The recordResolve hook
   * has run before this returns or throws.
   */
  async resolve(input: StreamRefInput, options: { resumeS?: number | null; deadlineS?: number } = {}): Promise<StreamSession> {
    const ref = toStreamRef(input);
    const out = await this.resolveSource(ref, options.deadlineS);
    let resumeS = options.resumeS ?? null;
    const hook = this.opts.hooks?.resumeS;
    if (resumeS === null && hook !== undefined) resumeS = await this.hookValue('resumeS', () => hook(ref));
    return this.sessions.create(ref, out.source, out.attempts, resumeS);
  }

  /** Resolves, then opens this daemon's player page for the session full screen in the streaming Chrome. */
  async play(input: StreamRefInput, options: { resumeS?: number | null } = {}): Promise<PlayResult> {
    const session = await this.resolve(input, options);
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
    this.log(`[notesd] direct stream: playing ${refLabel(session.ref)} from ${session.source.provider}`);
    return { page_url: pageUrl, session: await this.sessionInfo(session), attempts: session.attempts };
  }

  /** The live session, or null for an unknown or ended id. Marks it used. */
  session(id: string): StreamSession | null {
    return this.sessions.get(id);
  }

  /** What the player page reads, or null for an unknown or ended id. */
  async info(id: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(id);
    return session === null ? null : this.sessionInfo(session);
  }

  /** Resolves the session's title again (a token expired) and keeps the same id. A failure leaves the session as it was. */
  async refresh(id: string): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (session === null) throw new DirectStreamError('unknown_session', 'That stream session is unknown or has ended.');
    const out = await this.resolveSource(session.ref);
    this.sessions.replaceSource(session, out.source, out.attempts);
    return this.sessionInfo(session);
  }

  /** GET /api/stream/sessions/:id/p: 403 `unknown_session` before anything else, then forward(). */
  async passThrough(id: string, req: ForwardRequest): Promise<Response> {
    const session = this.sessions.get(id);
    if (session === null) return jsonError(403, 'unknown_session', 'That stream session is unknown or has ended.');
    return forward(session, req, this.fetchImpl);
  }

  /** Every provider with this host's health. */
  async providers(): Promise<ProviderView[]> {
    const [rows, health] = await Promise.all([this.repo.providers(), this.repo.healthFor(this.host)]);
    const byName = new Map(health.map((h) => [h.name, h]));
    return rows.map((row) => providerView(row, byName.get(row.name) ?? null));
  }

  /**
   * One resolver run: writes the registry and this host's health to the files `resolve` reads, runs it
   * (one at a time), and records each provider's outcome for this host. Never throws for a failed
   * resolve: `{ok: false}` names why (`no_source`, or `script_failed` / `bad_output` / the resolver's
   * error). Does not call the recordResolve hook. Phase 8 probes one provider with `{ only }`;
   * `deadlineS` becomes the resolver's `--deadline-s` (phase 10's per-pass budget).
   */
  async runResolve(ref: StreamRef, options: { only?: string; deadlineS?: number } = {}): Promise<ResolveOutput> {
    return this.serial(async () => {
      const providers = await this.repo.providers();
      const health = await this.repo.healthFor(this.host);
      const dir = await mkdtemp(path.join(tmpdir(), 'notesd-direct-'));
      let out: ResolveOutput;
      try {
        const providersFile = path.join(dir, 'providers.json');
        const healthFile = path.join(dir, 'health.json');
        await writeFile(providersFile, JSON.stringify(providers.map(providerSeedJson)));
        await writeFile(healthFile, JSON.stringify(healthMap(health)));
        const args = [
          'resolve',
          ref.kind,
          String(ref.tmdbId),
          ...(ref.kind === 'tv' ? [String(ref.season), String(ref.episode)] : []),
          ...(options.only !== undefined ? ['--only', options.only] : []),
          ...(options.deadlineS !== undefined ? ['--deadline-s', String(Math.max(1, Math.floor(options.deadlineS)))] : []),
          '--providers',
          providersFile,
          '--health',
          healthFile,
        ];
        try {
          out = parseResolveOutput(await this.runner(args));
        } catch (err) {
          const reason = err instanceof DirectStreamError ? (err.reason ?? 'bad_output') : 'script_failed';
          out = { ok: false, source: null, error: reason, detail: messageOf(err), attempts: [] };
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      await this.recordHealth(out, new Set(providers.map((p) => p.name)));
      this.log(
        out.ok
          ? `[notesd] direct stream: ${refLabel(ref)} resolved by ${out.source.provider} (${out.source.manifest_kind}${out.source.best_height === null ? '' : `, ${out.source.best_height}p`}) after ${out.attempts.length} tries`
          : `[notesd] direct stream: ${refLabel(ref)} did not resolve: ${out.error}${out.detail === '' ? '' : ` (${out.detail})`}`,
      );
      return out;
    });
  }

  /** runResolve, then the recordResolve hook, then a typed failure. */
  private async resolveSource(ref: StreamRef, deadlineS?: number): Promise<ResolvedOutput> {
    const out = await this.runResolve(ref, deadlineS === undefined ? {} : { deadlineS });
    const hook = this.opts.hooks?.recordResolve;
    if (hook !== undefined) {
      try {
        await hook(ref, out);
      } catch (err) {
        this.log(`[notesd] direct stream: the recordResolve hook failed: ${messageOf(err)}`);
      }
    }
    if (out.ok) return out;
    if (out.error === 'no_source') {
      throw new DirectStreamError('no_source', `No provider could stream ${refLabel(ref)}.`, { attempts: out.attempts });
    }
    throw new DirectStreamError('resolve_failed', out.detail === '' ? `The resolve could not run: ${out.error}.` : out.detail, {
      reason: out.error,
      attempts: out.attempts,
    });
  }

  private async recordHealth(out: ResolveOutput, known: ReadonlySet<string>): Promise<void> {
    const rows: HealthAttempt[] = [];
    for (const a of out.attempts) {
      if (!isHealthOutcome(a.outcome) || !known.has(a.provider)) continue;
      const source = out.ok && a.outcome === 'resolved' && a.provider === out.source.provider ? out.source : null;
      rows.push({ provider: a.provider, outcome: a.outcome, took_s: a.took_s, detail: a.detail, source });
    }
    try {
      await this.repo.recordAttempts(this.host, rows, this.now());
    } catch (err) {
      this.log(`[notesd] direct stream: could not record provider health: ${messageOf(err)}`);
    }
  }

  private async sessionInfo(session: StreamSession): Promise<SessionInfo> {
    const { ref, source } = session;
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    return {
      session_id: session.id,
      kind: ref.kind,
      tmdb_id: ref.tmdbId,
      season: ref.kind === 'tv' ? ref.season : null,
      episode: ref.kind === 'tv' ? ref.episode : null,
      title,
      provider: source.provider,
      manifest_kind: source.manifest_kind,
      manifest_url: proxiedUrl(session.id, source.manifest_url),
      subtitles: source.subtitles.map((t) => {
        const srt = t.format === 'srt' || /\.srt$/i.test(new URL(t.url).pathname);
        return {
          url: proxiedUrl(session.id, t.url, { vtt: srt }),
          lang: t.lang,
          label: t.label,
          format: srt ? 'vtt' : t.format,
          source: t.source,
          english: isEnglish(t),
        };
      }),
      best_height: source.best_height,
      resume_s: session.resumeS,
      created_at: session.createdAt.toISOString(),
      refreshed_at: session.refreshedAt.toISOString(),
      expires_at: this.sessions.expiresAt(session).toISOString(),
    };
  }

  private async hookValue<T>(name: string, call: () => Promise<T | null>): Promise<T | null> {
    try {
      return await call();
    } catch (err) {
      this.log(`[notesd] direct stream: the ${name} hook failed: ${messageOf(err)}`);
      return null;
    }
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export interface DirectStreamWiring {
  /** The movies service (only its host is read; direct streaming needs movies on). Null: movies off. */
  movies: { readonly host: string } | null;
  /** The daemon's origin as the streaming Chrome reaches it; the port is known only after listen. */
  pageBase: () => string;
  /** Phase 5's movie-store hooks. */
  hooks?: DirectStreamHooks;
}

/** Test seams. */
export interface DirectStreamOverrides {
  runner?: DirectStreamRunner;
  seedFile?: string;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's direct-stream service, or null (nothing built, nothing can start Chrome) when
 * NOTESD_DIRECT_STREAM is off or unset in the config, NOTESD_MOVIES is off, or there is no movies service.
 */
export function buildDirectStreamService(
  config: Config,
  db: Db,
  wiring: DirectStreamWiring,
  overrides: DirectStreamOverrides = {},
): DirectStreamService | null {
  const ds = config.directStream;
  if (ds === undefined || !ds.enabled || !config.movies.enabled || wiring.movies === null) return null;
  return new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: overrides.runner ?? directStreamScriptRunner({ cliPath: ds.cli }),
    host: wiring.movies.host,
    seedFile: overrides.seedFile ?? DEFAULT_SEED_FILE,
    pageBase: wiring.pageBase,
    hooks: wiring.hooks,
    fetch: overrides.fetch,
    now: overrides.now,
    log: overrides.log,
  });
}
```
**Test:** `tests/unit/directStream/build.test.ts` (new):
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { DirectStreamRunner } from '../../../src/directStream/runner.js';
import { DirectStreamService, buildDirectStreamService } from '../../../src/directStream/service.js';

const URL_A = 'postgres://u:p@127.0.0.1:5432/a';
const db = {} as Db;
const pageBase = (): string => 'http://localhost:7317';
const config = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false });

describe('buildDirectStreamService', () => {
  it('builds nothing while any switch is off, so nothing can reach the resolver or Chrome', () => {
    const calls: string[][] = [];
    const runner: DirectStreamRunner = async (args) => {
      calls.push(args);
      return { ok: true };
    };
    const movies = { host: 'host-a' };
    expect(buildDirectStreamService(config({ NOTESD_DIRECT_STREAM: 'off' }), db, { movies, pageBase }, { runner })).toBeNull();
    expect(buildDirectStreamService(config({ NOTESD_MOVIES: 'off' }), db, { movies, pageBase }, { runner })).toBeNull();
    expect(buildDirectStreamService(config({}), db, { movies: null, pageBase }, { runner })).toBeNull();
    const { directStream: _absent, ...withoutSection } = config({});
    expect(buildDirectStreamService(withoutSection, db, { movies, pageBase }, { runner })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('builds the service when direct streaming and movies are both on', () => {
    const svc = buildDirectStreamService(config({}), db, { movies: { host: 'host-a' }, pageBase });
    expect(svc).toBeInstanceOf(DirectStreamService);
    expect(svc?.host).toBe('host-a');
  });
});
```
**Check:** `npx vitest run tests/unit/directStream` passes (rewrite, sessions, runner, seed, build).

### Step 12: The routes
**File:** `src/http/directStreamApi.ts` (new)
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { DirectStreamService } from '../directStream/service.js';
import { DirectStreamError, type StreamRef } from '../directStream/types.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Direct streaming (DIRECT_STREAMING_PLAN phase 3): play, the player's session, the pass-through and
 * refresh. Every route answers 503 `direct_stream_off` first when there is no service; the two POSTs
 * start Chrome or a resolve, so they are same-origin only. Input is validated here once.
 */

export const DIRECT_STREAM_OFF = {
  error: 'direct_stream_off',
  message: 'Direct streaming is off on this machine (NOTESD_DIRECT_STREAM=off or NOTESD_MOVIES=off).',
} as const;

export const UNKNOWN_SESSION = { error: 'unknown_session', message: 'That stream session is unknown or has ended.' } as const;

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const resumeS = z.number().min(0).max(172_800);

export const playBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), resume_s: resumeS.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    resume_s: resumeS.nullish(),
  }),
]);

export type PlayBody = z.infer<typeof playBody>;

export function refFromBody(body: PlayBody): StreamRef {
  return body.kind === 'movie'
    ? { kind: 'movie', tmdbId: body.tmdb_id }
    : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** DirectStreamError -> its HTTP answer; anything else is rethrown (500). */
export function directStreamErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof DirectStreamError)) throw err;
  switch (err.code) {
    case 'no_source':
      return c.json({ error: 'no_source', message: err.message, attempts: err.attempts }, 502);
    case 'resolve_failed':
      return c.json({ error: 'resolve_failed', reason: err.reason, message: err.message, attempts: err.attempts }, 502);
    case 'open_failed':
      return c.json(
        { error: 'open_failed', reason: err.reason, message: err.message, session_id: err.sessionId, page_url: err.pageUrl, attempts: err.attempts },
        502,
      );
    case 'unknown_session':
      return c.json(UNKNOWN_SESSION, 403);
  }
}

export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'>): Hono {
  const r = new Hono();
  const service = (): DirectStreamService => {
    const svc = deps.directStream ?? null;
    if (svc === null) throw new Error('direct stream: the off guard did not run');
    return svc;
  };

  // Before the Origin check: while direct streaming is off, every route answers direct_stream_off.
  r.use('/api/stream/*', async (c, next) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    await next();
  });

  r.post('/api/stream/play', sameOriginOnly, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = playBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const played = await service().play(refFromBody(body.data), { resumeS: body.data.resume_s ?? null });
      return c.json({ ok: true, ...played });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  r.get('/api/stream/sessions/:id', async (c) => {
    const info = await service().info(c.req.param('id'));
    if (info === null) return c.json(UNKNOWN_SESSION, 403);
    return c.json(info);
  });

  r.get('/api/stream/sessions/:id/p', (c) =>
    service().passThrough(c.req.param('id'), {
      target: c.req.query('u') ?? '',
      range: c.req.header('range') ?? null,
      vtt: c.req.query('vtt') === '1',
      signal: c.req.raw.signal,
    }),
  );

  r.post('/api/stream/sessions/:id/refresh', sameOriginOnly, async (c) => {
    try {
      return c.json(await service().refresh(c.req.param('id')));
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  return r;
}
```
**Impact:** phase 5 adds its position route to this file and mounts it inside `directStreamRoutes`; the off guard covers it.

### Step 13: Wiring
**File:** `src/deps.ts:1-14` (imports) and `:45-50`
**Change:** add `import type { DirectStreamService } from './directStream/service.js';` after the `StreamingRunner` import, and after the `streaming?: StreamingRunner | null;` member:
```ts
  /**
   * Direct streaming (DIRECT_STREAMING_PLAN phase 3): registry, resolves, sessions and the
   * pass-through. Null or absent when NOTESD_DIRECT_STREAM=off, NOTESD_MOVIES=off or `movies` is
   * null; every /api/stream/* route then answers 503 direct_stream_off.
   */
  directStream?: DirectStreamService | null;
```
**File:** `src/http/app.ts:20` (imports), `:90-102` (doc comment), `:130` (mount)
**Change:** add `import { directStreamRoutes } from './directStreamApi.js';` after the `debugApiRoutes` import (line 25). In the `createApp` doc comment replace `(movies-library phases 4 and 5: library, user state, sync, playback), staticRoutes` with `(movies-library phases 4 and 5: library, user state, sync, playback), directStreamRoutes (direct-streaming phase 3: play, the player's session, the pass-through, refresh), staticRoutes`. After `app.route('/', moviesPlayRoutes(deps));`:
```ts
  app.route('/', directStreamRoutes(deps));
```
**File:** `src/daemon.ts:26` (imports), `:143-148`
**Change:** add `import { buildDirectStreamService } from './directStream/service.js';` after `import { buildMoviesService } from './movies/service.js';`. Replace lines 143-148:
```ts
  // Builds nothing and runs nothing until a streaming tool is called.
  const streaming = config.streaming?.enabled ? scriptRunner() : null;
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, movies, moviesPlayer, moviesHealth, sessionEvents, streaming };
  // The agent reaches notes through this daemon's own /mcp. The port is known only after
  // listen() (config.port may be 0), and the first chat run can only start after that.
  let boundPort: number | null = null;
```
with:
```ts
  // Builds nothing and runs nothing until a streaming tool is called.
  const streaming = config.streaming?.enabled ? scriptRunner() : null;
  // The bound port, known only after listen() (config.port may be 0). The chat agent reaches notes
  // through this daemon's own /mcp, and a direct-stream play opens this daemon's player page.
  let boundPort: number | null = null;
  // Direct streaming: null with NOTESD_DIRECT_STREAM=off or NOTESD_MOVIES=off. The provider seed is
  // loaded into the shared registry here; the resolver and Chrome run only when a play or a tool asks.
  const directStream = buildDirectStreamService(config, db, {
    movies,
    pageBase: () => `http://localhost:${boundPort ?? config.port}`,
  });
  if (directStream !== null) {
    try {
      const seeded = await directStream.syncSeed();
      console.log(`[notesd] direct stream: on, ${seeded.total} providers in the seed (${seeded.inserted} new, ${seeded.updated} updated)`);
    } catch (err) {
      console.error(`[notesd] direct stream: could not load the provider seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const deps: AppDeps = {
    config,
    db,
    events,
    service,
    embedder,
    imageEmbedder,
    chat: chatHistory,
    adversary,
    movies,
    moviesPlayer,
    moviesHealth,
    sessionEvents,
    streaming,
    directStream,
  };
```
`boundPort = port;` after `listen` stays as it is. `localhost`, not `127.0.0.1`: the Windows Chrome reaches the WSL daemon through `localhost` forwarding (the wall is used that way).
**Check:** `npm run typecheck`; `npm test` (includes `tests/unit/docs/reference.test.ts`, which now fails until Step 15 documents the four routes: run Step 15 before calling this green).

### Step 14: Integration tests
**File:** `tests/integration/directStream.repo.int.test.ts` (new)
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamProviderHealth, streamProviders } from '../../src/db/schema.js';
import { DirectStreamRepo, healthMap, providerSeedJson, type SeedProvider } from '../../src/directStream/repo.js';
import type { ResolvedSource } from '../../src/directStream/types.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

async function pgFailure(statement: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return { code: e.code, constraint: typeof e.constraint === 'string' ? e.constraint : undefined };
      cur = e.cause;
    }
    return {};
  }
  throw new Error('expected the statement to fail');
}

const SEED: SeedProvider[] = [
  { name: 'Alpha', idKind: 'tmdb', movie: 'https://alpha.example/movie/{id}', tv: null, browserOnly: false, enSubtitle: true, notes: '' },
  { name: 'Bravo', idKind: 'tmdb', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}', browserOnly: false, enSubtitle: null, notes: '' },
  { name: 'Charlie', idKind: 'tmdb', movie: 'https://charlie.example/e/{id}', tv: null, browserOnly: true, enSubtitle: false, notes: 'plays only in its own page' },
];

const SOURCE: ResolvedSource = {
  provider: 'Bravo',
  embed_url: 'https://bravo.example/movie/550',
  manifest_url: 'https://cdn.example/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://bravo.example/', origin: null, user_agent: 'Chrome/130' },
  subtitles: [{ url: 'https://cdn.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 1080,
  en_subtitle: true,
  took_s: 2.5,
};

let db: Db;
let repo: DirectStreamRepo;

beforeAll(() => {
  db = openTestDb();
  repo = new DirectStreamRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('migration 0020 (stream providers)', () => {
  it('creates both tables with their keys', async () => {
    const res = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' and tablename like 'stream_%' order by indexname`);
    expect(res.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['stream_providers_pkey', 'stream_provider_health_name_host_pk']));
  });

  it('accepts only the known outcomes, kinds and providers', async () => {
    await repo.syncSeed(SEED);
    const row = { name: 'Alpha', host: 'host-a', lastOutcome: 'resolved' as const };
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, lastOutcome: 'skipped_browser_only' as never }))).toEqual({
      code: '23514',
      constraint: 'stream_provider_health_outcome_check',
    });
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, manifestKind: 'rtmp' as never }))).toMatchObject({ code: '23514' });
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, name: 'Nobody' }))).toMatchObject({ code: '23503' });
    expect(await pgFailure(db.insert(streamProviders).values({ name: 'X', idKind: 'imdbx' as never, movie: 'https://x/{id}' }))).toMatchObject({ code: '23514' });
  });
});

describe('DirectStreamRepo.syncSeed', () => {
  it('loads the seed once, updates a changed seed row, and never touches a row a site added', async () => {
    expect(await repo.syncSeed(SEED)).toEqual({ inserted: 3, updated: 0 });
    expect(await repo.syncSeed(SEED)).toEqual({ inserted: 0, updated: 0 });
    const rows = await repo.providers();
    expect(rows.map((r) => [r.name, r.originSite])).toEqual([['Alpha', null], ['Bravo', null], ['Charlie', null]]);
    expect(rows.map(providerSeedJson)[1]).toEqual({
      name: 'Bravo', id_kind: 'tmdb', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}',
      browser_only: false, en_subtitle: null, notes: '',
    });

    const changed = SEED.map((e) => (e.name === 'Alpha' ? { ...e, tv: 'https://alpha.example/tv/{id}/{season}/{episode}' } : e));
    expect(await repo.syncSeed(changed)).toEqual({ inserted: 0, updated: 1 });
    expect((await repo.providers())[0]?.tv).toBe('https://alpha.example/tv/{id}/{season}/{episode}');

    // A provider /update-cloud-source added keeps its own values even when the seed later names it.
    await db.insert(streamProviders).values({ name: 'Delta', movie: 'https://delta.example/{id}', originSite: 'https://ww6-fmovies.com/' });
    expect(await repo.syncSeed([...changed, { name: 'Delta', idKind: 'tmdb', movie: 'https://other.example/{id}', tv: null, browserOnly: true, enSubtitle: null, notes: '' }])).toEqual({ inserted: 0, updated: 0 });
    const delta = (await repo.providers()).find((r) => r.name === 'Delta');
    expect([delta?.movie, delta?.browserOnly, delta?.originSite]).toEqual(['https://delta.example/{id}', false, 'https://ww6-fmovies.com/']);
  });
});

describe('DirectStreamRepo health', () => {
  it('keeps health per host', async () => {
    await repo.syncSeed(SEED);
    await repo.recordAttempts('host-a', [{ provider: 'Bravo', outcome: 'resolved', took_s: 2.5, detail: '', source: SOURCE }]);
    await repo.recordAttempts('host-b', [{ provider: 'Bravo', outcome: 'no_stream', took_s: 35, detail: 'nothing in 35 s', source: null }]);
    const a = await repo.healthFor('host-a');
    const b = await repo.healthFor('host-b');
    expect(a.map((r) => [r.name, r.host, r.lastOutcome, r.successes, r.failures, r.enSubtitle, r.bestHeight, r.manifestKind])).toEqual([
      ['Bravo', 'host-a', 'resolved', 1, 0, true, 1080, 'hls'],
    ]);
    expect(b.map((r) => [r.name, r.host, r.lastOutcome, r.successes, r.failures, r.lastDetail])).toEqual([['Bravo', 'host-b', 'no_stream', 0, 1, 'nothing in 35 s']]);
    expect(Object.keys(healthMap(a))).toEqual(['Bravo']);
  });

  it('counts failures in a row, resets them on a success, and keeps the last ten times', async () => {
    await repo.syncSeed(SEED);
    for (let i = 0; i < 3; i++) await repo.recordAttempts('host-a', [{ provider: 'Alpha', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...', source: null }]);
    expect((await repo.healthFor('host-a'))[0]).toMatchObject({ consecutiveFailures: 3, failures: 3, lastOutcome: 'bot_check' });
    for (let i = 1; i <= 12; i++) await repo.recordAttempts('host-a', [{ provider: 'Alpha', outcome: 'resolved', took_s: i, detail: '', source: null }]);
    const [row] = await repo.healthFor('host-a');
    expect(row).toMatchObject({ consecutiveFailures: 0, failures: 3, successes: 12, lastOutcome: 'resolved' });
    expect(row?.recentS).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(healthMap(row === undefined ? [] : [row]).Alpha?.median_s).toBe(7.5);
  });
});
```
**File:** `tests/integration/directStream.api.int.test.ts` (new)
**Code:**
```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService, type DirectStreamHooks, type SessionInfo } from '../../src/directStream/service.js';
import { SESSION_IDLE_MS, SessionStore } from '../../src/directStream/sessions.js';
import type { ResolveAttempt, ResolveOutput, StreamRef } from '../../src/directStream/types.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const PAGE_BASE = 'http://localhost:4321';
const SEED = [
  { name: 'Alpha', movie: 'https://alpha.example/movie/{id}', en_subtitle: true },
  { name: 'Bravo', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}' },
  { name: 'Charlie', movie: 'https://charlie.example/e/{id}', browser_only: true },
];

interface UpstreamRequest {
  path: string;
  host: string;
  referer: string | null;
  origin: string | null;
  user_agent: string | null;
  range: string | null;
  cookie: string | null;
}
interface Upstream {
  origin: string;
  altOrigin: string;
  requests: UpstreamRequest[];
  close(): Promise<void>;
}
interface PlayJson {
  ok: true;
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let clock: Date;
let records: { ref: StreamRef; result: ResolveOutput }[];

const through = (sid: string, u: string): string => `/api/stream/sessions/${sid}/p?u=${encodeURIComponent(u)}`;

async function mode(m: 'hls' | 'dash' | 'no_source' | 'no_chrome'): Promise<void> {
  await writeFile(path.join(fakeDir, 'mode'), `${m}\n`);
}

async function calls(): Promise<string[][]> {
  try {
    const text = await readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8');
    return text.trim() === '' ? [] : text.trim().split('\n').map((l) => (JSON.parse(l) as { args: string[] }).args);
  } catch {
    return [];
  }
}

function service(host = 'host-a', hooks: DirectStreamHooks = {}): DirectStreamService {
  return new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host,
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => PAGE_BASE,
    hooks: {
      recordResolve: async (ref, result) => {
        records.push({ ref, result });
      },
      ...hooks,
    },
    sessions: new SessionStore(() => clock),
    now: () => clock,
    log: () => undefined,
  });
}

function appFor(svc: DirectStreamService | null): Hono {
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  return app;
}

async function ready(host = 'host-a', hooks: DirectStreamHooks = {}): Promise<{ svc: DirectStreamService; app: Hono }> {
  const svc = service(host, hooks);
  await svc.syncSeed();
  return { svc, app: appFor(svc) };
}

async function play(app: Hono, body: unknown = { kind: 'movie', tmdb_id: 550 }, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return app.request('/api/stream/play', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function played(app: Hono, body?: unknown): Promise<PlayJson> {
  const res = await play(app, body);
  expect(res.status).toBe(200);
  return (await res.json()) as PlayJson;
}

beforeAll(async () => {
  db = openTestDb();
  up = (await startUpstream()) as Upstream;
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-api-'));
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
  await rm(path.join(fakeDir, 'calls.jsonl'), { force: true });
  await mode('hls');
  up.requests.length = 0;
  clock = new Date('2026-11-15T12:00:00Z');
  records = [];
});

describe('POST /api/stream/play', () => {
  it('resolves through the registry, opens the player page full screen and answers the session', async () => {
    const { app } = await ready();
    const json = await played(app);
    const sid = json.session.session_id;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(json.page_url).toBe(`${PAGE_BASE}/stream/${sid}`);
    expect(json.session).toMatchObject({
      kind: 'movie', tmdb_id: 550, season: null, episode: null, title: 'TMDB movie 550', provider: 'Bravo',
      manifest_kind: 'hls', manifest_url: through(sid, `${up.origin}/hls/master.m3u8`), best_height: 1080, resume_s: null,
    });
    expect(json.session.subtitles).toEqual([
      { url: `${through(sid, `${up.origin}/subs/en.srt`)}&vtt=1`, lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true },
    ]);
    expect(json.attempts).toEqual([
      { provider: 'Alpha', outcome: 'bot_check', took_s: 1.2, detail: 'fake: Just a moment...' },
      { provider: 'Bravo', outcome: 'resolved', took_s: 2.5, detail: '' },
    ]);
    const c = await calls();
    expect(c.map((a) => a[0])).toEqual(['resolve', 'open']);
    expect(c[0]?.slice(0, 3)).toEqual(['resolve', 'movie', '550']);
    expect(c[1]).toEqual(['open', `${PAGE_BASE}/stream/${sid}`, '--fullscreen']);
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toMatchObject({ ok: true, source: { provider: 'Bravo' } });
  });

  it('passes an episode to the resolver', async () => {
    const { app } = await ready();
    const json = await played(app, { kind: 'tv', tmdb_id: 1399, season: 1, episode: 2 });
    expect(json.session).toMatchObject({ kind: 'tv', tmdb_id: 1399, season: 1, episode: 2, title: 'TMDB tv 1399 S01E02' });
    expect((await calls())[0]?.slice(0, 5)).toEqual(['resolve', 'tv', '1399', '1', '2']);
  });

  it('records health for this host after every resolve, leaving skipped providers alone', async () => {
    const { svc, app } = await ready('host-a');
    await played(app);
    const view = await svc.providers();
    expect(view.map((p) => [p.name, p.health?.last_outcome ?? null, p.health?.successes ?? null, p.health?.failures ?? null])).toEqual([
      ['Alpha', 'bot_check', 0, 1],
      ['Bravo', 'resolved', 1, 0],
      ['Charlie', null, null, null],
    ]);
    expect(view[1]?.health).toMatchObject({ en_subtitle: true, best_height: 1080, manifest_kind: 'hls', median_s: 2.5 });
    expect((await service('host-b').providers()).every((p) => p.health === null)).toBe(true);
  });

  it('answers no_source with every attempt, opens nothing, and records the failures', async () => {
    const { svc, app } = await ready();
    await mode('no_source');
    const res = await play(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'no_source',
      attempts: [
        { provider: 'Alpha', outcome: 'no_stream' },
        { provider: 'Bravo', outcome: 'no_stream' },
      ],
    });
    expect((await calls()).map((a) => a[0])).toEqual(['resolve']);
    expect(records[0]?.result).toMatchObject({ ok: false, error: 'no_source' });
    expect((await svc.providers()).filter((p) => p.health?.failures === 1).map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('answers resolve_failed with the reason when the streaming Chrome cannot be reached', async () => {
    const { svc, app } = await ready();
    await mode('no_chrome');
    const res = await play(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome' });
    expect((await svc.providers()).every((p) => p.health === null)).toBe(true);
    expect(records[0]?.result).toMatchObject({ ok: false, error: 'no_chrome' });
  });

  it('validates the body and the Origin', async () => {
    const { app } = await ready();
    expect((await play(app, { kind: 'movie', tmdb_id: 550, season: 1 })).status).toBe(400);
    expect((await play(app, { kind: 'tv', tmdb_id: 1399, season: 1 })).status).toBe(400);
    expect((await play(app, { kind: 'movie', tmdb_id: 0 })).status).toBe(400);
    const notJson = await app.request('/api/stream/play', { method: 'POST', headers: SAME_ORIGIN, body: 'nope' });
    expect(((await notJson.json()) as { error: string }).error).toBe('invalid_json');
    const foreign = await play(app, { kind: 'movie', tmdb_id: 550 }, {});
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toBe('forbidden_origin');
    expect(await calls()).toEqual([]);
  });

  it('takes resume_s from the body, else from the resume hook, and the title from its hook', async () => {
    const { app } = await ready('host-a', { resumeS: async () => 1234.5, titleLabel: async () => 'Fight Club (1999)' });
    expect((await played(app)).session).toMatchObject({ resume_s: 1234.5, title: 'Fight Club (1999)' });
    expect((await played(app, { kind: 'movie', tmdb_id: 550, resume_s: 60 })).session.resume_s).toBe(60);
  });
});

describe('the pass-through', () => {
  it('fetches the master playlist with the captured headers and rewrites every address in it', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    const res = await app.request(session.manifest_url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('x-notesd-upstream')).toBe('200');
    expect((await res.text()).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="${through(sid, `${up.origin}/hls/subs/en.m3u8`)}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,SUBTITLES="subs"',
      through(sid, `${up.origin}/hls/720/index.m3u8`),
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,SUBTITLES="subs"',
      through(sid, `${up.altOrigin}/hls/1080/index.m3u8`),
      '',
    ]);
    expect(up.requests.at(-1)).toMatchObject({
      path: '/hls/master.m3u8', referer: 'https://embed.fixture/', origin: 'https://embed.fixture', user_agent: 'FixtureChrome/1.0', cookie: null, range: null,
    });
    const media = await (await app.request(through(sid, `${up.origin}/hls/720/index.m3u8`))).text();
    expect(media).toContain(`#EXT-X-MAP:URI="${through(sid, `${up.origin}/hls/720/init.mp4`)}"`);
    expect(media).toContain(through(sid, `${up.origin}/hls/720/seg1.ts`));
    expect(media).toContain(through(sid, `${up.origin}/hls/720/seg2.ts`));
  });

  it('allows a host only after a playlist fetched through the session named it', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const alt = through(session.session_id, `${up.altOrigin}/hls/1080/index.m3u8`);
    const before = up.requests.length;
    const refused = await app.request(alt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('forbidden_host');
    expect(refused.headers.get('x-notesd-upstream')).toBeNull();
    expect(up.requests.length).toBe(before);
    await (await app.request(session.manifest_url)).text();
    expect((await app.request(alt)).status).toBe(200);
  });

  it('forwards Range and streams the segment back', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(through(session.session_id, `${up.origin}/hls/720/seg1.ts`), { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(up.requests.at(-1)?.range).toBe('bytes=0-99');
  });

  it('answers 403 and fetches nothing for an unknown session, an ended one, or a host the resolve did not return', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    const before = up.requests.length;
    const errorOf = async (p: string): Promise<[number, string]> => {
      const res = await app.request(p);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await errorOf(through('A'.repeat(32), `${up.origin}/hls/master.m3u8`))).toEqual([403, 'unknown_session']);
    expect(await errorOf(through('nope', `${up.origin}/hls/master.m3u8`))).toEqual([403, 'unknown_session']);
    expect(await errorOf(through(sid, 'http://evil.example/x.m3u8'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(through(sid, 'http://127.0.0.1:9/x.m3u8'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(through(sid, 'file:///etc/passwd'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(`/api/stream/sessions/${sid}/p`)).toEqual([403, 'forbidden_host']);
    expect(await errorOf(`/api/stream/sessions/${'A'.repeat(32)}`)).toEqual([403, 'unknown_session']);
    clock = new Date(clock.getTime() + SESSION_IDLE_MS);
    expect(await errorOf(session.manifest_url)).toEqual([403, 'unknown_session']);
    expect(await errorOf(`/api/stream/sessions/${sid}`)).toEqual([403, 'unknown_session']);
    expect(up.requests.length).toBe(before);
  });

  it('rewrites a DASH manifest and keeps the template fields for the player', async () => {
    const { app } = await ready();
    await mode('dash');
    const { session } = await played(app);
    const sid = session.session_id;
    expect(session.manifest_kind).toBe('dash');
    const res = await app.request(session.manifest_url);
    expect(res.headers.get('content-type')).toBe('application/dash+xml');
    const mpd = await res.text();
    const prefix = `/api/stream/sessions/${sid}/p?u=`;
    const base = encodeURIComponent(`${up.altOrigin}/dash/`);
    expect(mpd).toContain(`<BaseURL>${through(sid, `${up.altOrigin}/dash/`)}</BaseURL>`);
    expect(mpd).toContain(`<BaseURL>${through(sid, `${up.altOrigin}/dash/audio/a1.mp4`)}</BaseURL>`);
    expect(mpd).toContain(`media="${prefix}${base}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s')}"`);
    expect(mpd).not.toContain('http://');
    const segment = `${prefix}${base}v720${encodeURIComponent('/seg-')}00001${encodeURIComponent('.m4s')}`;
    const seg = await app.request(segment);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBe(1000);
  });

  it('serves an .srt track as WebVTT', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(session.subtitles[0]?.url ?? '');
    expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await res.text()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello.\n');
  });

  it('forwards the stream host status of an expired token, marked as the host answer', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(through(session.session_id, `${up.origin}/expired.m3u8`));
    expect(res.status).toBe(410);
    expect(res.headers.get('x-notesd-upstream')).toBe('410');
  });
});

describe('POST /api/stream/sessions/:id/refresh', () => {
  it('resolves again under the same id; a failed refresh leaves the session working', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    clock = new Date(clock.getTime() + 60_000);
    const res = await app.request(`/api/stream/sessions/${sid}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(res.status).toBe(200);
    const info = (await res.json()) as SessionInfo;
    expect(info.session_id).toBe(sid);
    expect(info.refreshed_at).toBe('2026-11-15T12:01:00.000Z');
    expect((await calls()).map((a) => a[0])).toEqual(['resolve', 'open', 'resolve']);
    await mode('no_source');
    const failed = await app.request(`/api/stream/sessions/${sid}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe('no_source');
    expect((await app.request(session.manifest_url)).status).toBe(200);
    const unknown = await app.request(`/api/stream/sessions/${'A'.repeat(32)}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(unknown.status).toBe(403);
  });
});

describe('direct_stream_off', () => {
  it('answers direct_stream_off on every route without the service, before any other check', async () => {
    const app = appFor(null);
    const id = 'A'.repeat(32);
    const routes: [string, string][] = [
      ['POST', '/api/stream/play'],
      ['GET', `/api/stream/sessions/${id}`],
      ['GET', `/api/stream/sessions/${id}/p?u=${encodeURIComponent(`${up.origin}/hls/master.m3u8`)}`],
      ['POST', `/api/stream/sessions/${id}/refresh`],
    ];
    for (const [method, p] of routes) {
      const res = await app.request(p, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{"kind":"movie","tmdb_id":550}' } : { method });
      expect([method, p, res.status]).toEqual([method, p, 503]);
      expect(((await res.json()) as { error: string }).error).toBe('direct_stream_off');
    }
    expect(await calls()).toEqual([]);
    expect(up.requests).toHaveLength(0);
  });
});
```
**Check:** `npm run test:int -- tests/integration/directStream.repo.int.test.ts tests/integration/directStream.api.int.test.ts` passes.

### Step 15: HTTP reference and docs
**File:** `scripts/docs/httpRoutes.ts`: insert a group after the "Movies" group (after its closing `},` at line 425, before the "Debug" group):
```ts
  {
    title: 'Direct streaming',
    intro:
      'With `NOTESD_DIRECT_STREAM=off`, `NOTESD_MOVIES=off`, or no direct-stream service, every route here answers 503 `direct_stream_off` before any other check. ' +
      'A session lives in this daemon\'s memory only: its id is 32 random characters, it ends 4 hours after its last request or 24 hours after it began, and a restart ends it; an unknown or ended one answers 403 `unknown_session`. Guide: [streaming.md](../streaming.md#direct-streaming).',
    routes: {
      'POST /api/stream/play':
        '`{kind, tmdb_id, season?, episode?, resume_s?}` (`season` and `episode` together, `tv` only): resolve the title through the provider registry, record each provider\'s health on this machine, then open the player page full screen in the streaming Chrome. 200 `{ok: true, page_url, session, attempts}` with `session` as the route below. 502 `no_source` with every provider\'s `attempts`; 502 `resolve_failed` with `reason` (`no_chrome`, `chrome_not_reachable`, `script_failed`, ...); 502 `open_failed` with `session_id` and `page_url`. 400 `invalid_json` / `invalid_body`. Same-origin only.',
      'GET /api/stream/sessions/:id':
        'What the player page needs: `{session_id, kind, tmdb_id, season, episode, title, provider, manifest_kind, manifest_url, subtitles, best_height, resume_s, created_at, refreshed_at, expires_at}`. `manifest_url` and each subtitle `url` are pass-through addresses on this daemon; an `.srt` track is served as WebVTT, and each track says whether it is `english`. 403 `unknown_session`.',
      'GET /api/stream/sessions/:id/p':
        'The pass-through. Query: `u` (the stream host address), `vtt=1` (hand a subtitle file back as WebVTT). Fetches `u` with only the `Referer`, `Origin` and `User-Agent` the resolve captured and the player\'s `Range`, and streams the answer back with the host\'s status, also in `X-Notesd-Upstream`. HLS playlists and DASH manifests come back with every address rewritten to this route. 403 `unknown_session`; 403 `forbidden_host`, and nothing is fetched, when `u` is not on a host the session\'s resolve returned or that a playlist, manifest or redirect fetched through the session named. 502 `upstream_error`.',
      'POST /api/stream/sessions/:id/refresh':
        'Resolve the session\'s title again (a token expired) and keep the same session id and page: returns the session like the route above. 502 `no_source` / `resolve_failed` leave the session as it was. 403 `unknown_session`. Same-origin only.',
    },
  },
```
Then run `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md`; never hand-edit it).

**File:** `docs/guide/reference/configuration.md`: after the `LK21_ORIGIN` row (line 126) and its blank line, before `## Install script and hooks`:
```markdown
## Direct streaming

Films played straight from a provider's stream host through the daemon, described in
[streaming.md](../streaming.md#direct-streaming). It needs `NOTESD_MOVIES` on.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTESD_DIRECT_STREAM` | on | `off` turns direct streaming off on this machine: the provider seed is not loaded, every `/api/stream/*` route answers 503 `direct_stream_off` and the resolver never runs, so no Chrome tab is opened for it. It is off too whenever `NOTESD_MOVIES=off`. |
| `NOTESD_STREAM_FRESH_DAYS` | `7` | How many days a stream source verified on this machine counts as playable. |
| `NOTESD_DIRECT_STREAM_CLI` | `claude/streaming/direct/cli.mjs` in this checkout | Absolute path of the resolver the daemon runs as `node <path>`. `verify.sh up --direct-stream` points it at a fake; a relative path is rejected. |
```

**File:** `docs/guide/streaming.md`
- Contents (lines 16-20): replace `[Adding a site](#adding-a-site) · [Failure answers](#failure-answers) ·` with `[Adding a site](#adding-a-site) · [Failure answers](#failure-answers) · [Direct streaming](#direct-streaming) ·`.
- After line 256 (`A failure never falls back to a guessed link.`) and before `## Where the code is`, insert:
```markdown
## Direct streaming

Direct streaming plays a film straight from the stream host a provider uses, in a page notesd
serves, with no site, countdown or advert in between. A provider is an embed address keyed by the
TMDB id, such as `https://vidfast.pro/movie/{id}`. Resolving opens that address out of sight in
the streaming Chrome, notes the manifest it asks for and the headers it sent, and closes the tab;
playing hands the manifest to notesd's player page through the daemon. It needs `NOTESD_MOVIES`
on, and `NOTESD_DIRECT_STREAM=off` turns it off: every `/api/stream/*` route then answers
`direct_stream_off` and no Chrome tab is opened for it.

### The resolver

`claude/streaming/direct/cli.mjs resolve <movie|tv> <tmdb id> [season episode]` opens each
provider's embed in a background tab of the streaming Chrome, muted, and keeps the first one that
loads a stream: the manifest, the `Referer`, `Origin` and `User-Agent` its request carried, and the
subtitle tracks seen (separate `.vtt`/`.srt` requests and tracks inside the manifest). Providers are
tried with an English subtitle first, then by health on this host, then by quality (`order.mjs`). A
provider whose page shows a bot check is recorded as `bot_check` and the next one is tried; nothing
is clicked or disguised to get past it. Providers are data, `providers.seed.json`, 24 templates read
from fmovies. `--deadline-s <n>` stops trying providers once `n` seconds have passed (the answer is
`deadline`, which says nothing about the title). `cli.mjs open <url> --fullscreen` puts a daemon page
full screen in the streaming Chrome and starts the player with sound, as a click would.

### Providers and their health

- The providers are data. `claude/streaming/direct/providers.seed.json` is checked in; the daemon
  loads it into the `stream_providers` table at every start, and both machines share that table.
  An entry changed in the file updates its row. A provider added from a site keeps the site's
  address in `origin_site` and is never rewritten by the seed. Nothing deletes a provider.
- Health is per machine, in `stream_provider_health`: for each provider the last outcome
  (`resolved`, `no_stream`, `bot_check`, `error`), counts, failures in a row, the last success and
  failure, the last ten times to a stream, the manifest kind, the best quality and whether an
  English subtitle was seen. It is written after every resolve, and the resolver reads it to
  choose its order.
- A provider skipped because it only plays in its own page (`browser_only`), or because it has no
  episode address, is not a failure: its health is left alone.

### Sessions and the pass-through

A resolve makes a session, kept in the daemon's memory: a 32-character random id, the source, and
the hosts it may reach. It ends 4 hours after its last request or 24 hours after it began, and a
restart ends every session. The player page reads it from `GET /api/stream/sessions/<id>`.

Stream hosts check `Referer`, which a page cannot set, so every request the player makes goes
through `/api/stream/sessions/<id>/p?u=<address>`:

- **Only the session's hosts.** The hosts the resolve returned (the manifest's and the
  subtitles'), plus a host named inside a playlist or manifest fetched through the same session,
  or by a redirect one of them answered. Anything else is refused with 403 `forbidden_host` before
  any request is made, and an unknown or ended session gets 403 `unknown_session`. It is not an
  open proxy.
- **Only the captured headers.** `Referer`, `Origin` and `User-Agent` as the real Chrome sent them,
  plus the player's `Range`. No cookie and nothing invented; Node's fetch adds only its usual
  transport headers (`accept`, `accept-encoding`).
- **Every address comes back through it.** HLS playlists (address lines and `URI="..."`
  attributes) and DASH manifests (`BaseURL`, `Location`, segment templates, `SegmentURL`,
  `Initialization`) are rewritten; a template's `$Number$`-style fields are left for the player to
  fill in. Media streams through as it arrives, with the host's status, which is also in the
  `X-Notesd-Upstream` header, so the player can tell an expired token from a refused session.
- **Subtitles.** An `.srt` track is turned into WebVTT on the way, since a page shows only WebVTT.
- When a token expires mid-film, `POST /api/stream/sessions/<id>/refresh` resolves again and keeps
  the same session and page.

### Direct streaming answers

| Answer | Meaning |
| --- | --- |
| `direct_stream_off` | `NOTESD_DIRECT_STREAM=off`, `NOTESD_MOVIES=off`, or the daemon was started without it. Nothing is resolved and Chrome is not started |
| `no_source` | No provider resolved the title; `attempts` lists each provider's outcome |
| `resolve_failed` | The resolve could not run: `reason` is `no_chrome`, `chrome_not_reachable`, `script_failed`, or what the resolver said |
| `open_failed` | The title resolved, but the player page could not be opened in the streaming Chrome |
| `unknown_session` | The session id is wrong, the session ended, or the daemon restarted since |
| `forbidden_host` | The address is not on a host the session may reach |
| `upstream_error` | The stream host did not answer, or redirected too often |
```
- "Where the code is" table (after the `src/streaming/service.ts` row, line 268), add:
```markdown
| `claude/streaming/direct/` | The resolver: `cli.mjs`, the sniffer, the provider order, `providers.seed.json` |
| `src/directStream/` | The registry (`repo.ts`), resolves and sessions (`service.ts`, `sessions.ts`), the pass-through and its rewriting (`passThrough.ts`, `rewrite.ts`), running the resolver (`runner.ts`) |
| `src/http/directStreamApi.ts` | The `/api/stream/*` routes |
```
- "Proving a change" (end of file), append:
```markdown
- Direct streaming: the feature map entry is `.claude/skills/verify-notesd/features/direct-streaming.md`.
  `verify.sh up --direct-stream` drives it against a fake resolver and a fixture stream host, never
  a provider or Chrome; every other throwaway run has it off.
```

**File:** `README.md` (the subsystem table): after the Streaming row (line 48), add one row, as
CLAUDE.md's docs rule asks (one line per subsystem and a link; the detail stays in the guide):
```markdown
| Direct streaming | A film straight from a provider's stream host in notesd's own player page, no site and no adverts, English subtitle first | [streaming](docs/guide/streaming.md#direct-streaming) |
```

**File:** `docs/guide/architecture.md`
- Line 37 (`src/config.ts` row): replace `have sessions, the adversary and movies off` with `have sessions, the adversary, movies and direct streaming off`.
- Line 38 (`src/daemon.ts` row): replace `the adversary, movies, player and health monitor (each null when off), \`createApp\`` with `the adversary, movies, player and health monitor, direct streaming (each null when off; direct streaming loads the provider seed), \`createApp\``.
- Line 39 (`src/deps.ts` row): replace `` `moviesHealth`, `sessionEvents`) `` with `` `moviesHealth`, `sessionEvents`, `directStream`) ``.
- One-writer table, after the `movie_*` row (line 69):
```markdown
| `stream_providers`, `stream_provider_health` | `DirectStreamRepo` (`src/directStream/repo.ts`) |
```
- Data model table, after the Movies row (line 91):
```markdown
| Direct streaming | `stream_providers`, `stream_provider_health` | The provider registry is shared and loaded from `claude/streaming/direct/providers.seed.json` at every start; health is one row per provider and host. Stream sessions are in memory, never stored. |
```
- Security table: in the Same-origin row (line 182) replace `every movie write and play.` with `every movie write and play, a direct-stream play or refresh.`; after the Served files row (line 185) add:
```markdown
| Stream pass-through | `src/directStream/passThrough.ts`, `GET /api/stream/sessions/:id/p` | Works only for a live session (a 32-character random id held in memory) and only towards hosts that session's resolve returned or that a playlist, manifest or redirect fetched through it named; anything else is refused before a request is made. It sends only the captured `Referer`, `Origin` and `User-Agent` and the player's `Range`. Not an open proxy. |
```
- Repository layout (line 251), after the `movies/` line:
```
  directStream/ provider registry, resolves, sessions, the stream pass-through and its rewriting
```
**Check:** `npm run docs:check` and `npm test` pass.

### Step 16: The verify harness and the feature map
**File:** `.claude/skills/verify-notesd/scripts/verify.sh`
- Usage block, line 8: `#   verify.sh up [--web] [--embed] [--sessions] [--adversary] [--movies] [--direct-stream]`; after the `--movies` lines (13-14) add:
```bash
#                                       --direct-stream turns direct streaming on (implies --movies) against a
#                                       fake resolver and a fixture stream host (tests/fixtures/direct-stream/);
#                                       without it NOTESD_DIRECT_STREAM=off is pinned
```
- `cmd_up` flags (line 77): `local web=0 embed=0 sessions=0 adversary=0 movies=0 direct=0`; in the `case`, after `--movies) movies=1 ;;`:
```bash
      --direct-stream) direct=1; movies=1 ;;
```
- After the `--movies` block (after the `fi` that ends it, line 159):
```bash
  # --direct-stream: a fixture stream host and a fake resolver from tests/fixtures/direct-stream/. Never a
  # provider and never the streaming Chrome: the real resolver opens the owner's Chrome on Windows.
  if [ "$direct" = 1 ]; then
    mkdir -p "$dir/direct"
    setsid node "$root/tests/fixtures/direct-stream/upstream.mjs" --info "$dir/direct/upstream.json" \
      --log "$dir/direct/upstream.jsonl" </dev/null >"$dir/direct/upstream.out" 2>&1 &
    echo $! >"$dir/upstream.pid"
    for _ in $(seq 1 40); do [ -s "$dir/direct/upstream.json" ] && break; sleep 0.25; done
    [ -s "$dir/direct/upstream.json" ] || die "--direct-stream: the fixture stream host did not start (log: $dir/direct/upstream.out; verify.sh down $run)"
  fi
```
- After the movies `if/else` that appends `env+=(...)` (line 208):
```bash
  # NOTESD_DIRECT_STREAM=off unless --direct-stream: a --movies run never runs the real resolver.
  # Under --direct-stream the resolver is the fake, unless the caller set NOTESD_DIRECT_STREAM_CLI
  # (phase 6's playcheck wrapper, run only when the owner expects the streaming Chrome to move).
  if [ "$direct" = 1 ]; then
    env+=(
      NOTESD_DIRECT_STREAM=on
      "NOTESD_DIRECT_STREAM_CLI=${NOTESD_DIRECT_STREAM_CLI:-$root/tests/fixtures/direct-stream/fake-cli.mjs}"
      "DIRECT_STREAM_FAKE_DIR=$dir/direct"
    )
  else
    env+=(NOTESD_DIRECT_STREAM=off)
  fi
```
- In the `meta` block, after `echo "movies=$movies"`: `echo "direct_stream=$direct"`.
- After `if [ "$movies" = 1 ]; then echo "MOVIES=$dir/movies"; fi` (line 236): `if [ "$direct" = 1 ]; then echo "DIRECT=$dir/direct"; fi`.
- `stop_run`, after the `tmdb.pid` block (line 391):
```bash
  # --direct-stream: the fixture stream host was started by `up`; keep its request log and the fake resolver's calls.
  if [ -f "$dir/upstream.pid" ]; then
    kill -TERM -- "-$(cat "$dir/upstream.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/upstream.pid")" 2>/dev/null || true
  fi
  if [ -f "$dir/direct/upstream.jsonl" ]; then cp "$dir/direct/upstream.jsonl" "$dir/evidence/direct-upstream-requests.jsonl"; fi
  if [ -f "$dir/direct/calls.jsonl" ]; then cp "$dir/direct/calls.jsonl" "$dir/evidence/direct-resolver-calls.jsonl"; fi
```
**File:** `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh` (new, `chmod +x`)
**Code:**
```bash
#!/usr/bin/env bash
# journey.sh RUN [seed|hls|dash|refuse ...]: the direct-streaming feature map's checks on a
# `verify.sh up --direct-stream` run. Every stage drives the real daemon over HTTP: the fake resolver
# (tests/fixtures/direct-stream/fake-cli.mjs) answers the resolve and the fixture stream host
# (tests/fixtures/direct-stream/upstream.mjs) serves the stream. End states are read over HTTP, from
# the run's database (read-only) and from the fixture host's request log. The first failed check stops
# it with `journey: FAIL at <stage>`. No stage named: all four, in order; run `seed` first on a fresh run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: journey.sh RUN [seed|hls|dash|refuse ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(seed hls dash refuse); fi
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
[ -s "$DIRECT/upstream.json" ] || { echo "journey: $RUN was not started with --direct-stream" >&2; exit 2; }
DB="$(cat "$DIR/db")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
UP="$(jq -r .origin "$DIRECT/upstream.json")"
ROOT="$(sed -n 's/^repo=//p' "$DIR/meta")"
EV="$DIR/evidence"
STAGE=start
CODE=""
BODY=""
SID=""
MANIFEST=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "direct-stream journey $STAGE: $*"; }
fail() {
  echo "journey: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "direct-stream journey FAIL at $STAGE: $*" || true
  exit 1
}
# q SQL: the query's value(s) from the run's database, in a read-only transaction.
q() {
  printf 'begin read only;\n%s;\nrollback;\n' "$1" \
    | docker exec -i mcp-notes-pg-verify psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
    | sed '/^BEGIN$/d;/^ROLLBACK$/d'
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# get PATH NAME [curl args...]: GET as the player does (no Origin); headers and body saved as evidence; sets CODE.
get() {
  local path=$1 name=$2
  shift 2
  CODE="$(curl -sS -D "$EV/direct-$name.head" -o "$EV/direct-$name.body" -w '%{http_code}' "$@" "$URL$path")"
}
enc() { jq -rn --arg u "$1" '$u|@uri'; }
upstream_count() { if [ -f "$DIRECT/upstream.jsonl" ]; then wc -l <"$DIRECT/upstream.jsonl" | tr -d ' '; else echo 0; fi; }
# play JSON: POST /api/stream/play; sets SID and MANIFEST.
play() {
  api POST /api/stream/play "$1"
  [ "$CODE" = 200 ] || fail "POST /api/stream/play $1 answered HTTP $CODE: $BODY"
  SID="$(jq -r .session.session_id <<<"$BODY")"
  MANIFEST="$(jq -r .session.manifest_url <<<"$BODY")"
  [[ $SID =~ ^[A-Za-z0-9_-]{32}$ ]] || fail "session id [$SID] is not 32 random characters"
  [[ $MANIFEST == "/api/stream/sessions/$SID/p?u="* ]] || fail "manifest_url [$MANIFEST] does not come back through the pass-through"
}

stage_seed() {
  stage seed
  local want got host
  want="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$ROOT/claude/streaming/direct/providers.seed.json")"
  got="$(q "select count(*) || ' ' || count(*) filter (where origin_site is null) from stream_providers")"
  [ "$got" = "$want $want" ] || fail "stream_providers holds [$got] (all, from the seed), wanted [$want $want]"
  ok "the seed's $want providers are in stream_providers, all marked as from the seed"
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  host="$(hostname)"
  got="$(q "select string_agg(last_outcome || ':' || successes || ':' || failures || ':' || coalesce(en_subtitle::text, '-') || ':' || coalesce(best_height::text, '-'), ' ' order by last_outcome) from stream_provider_health where host = '$host'")"
  [ "$got" = "bot_check:0:1:-:- resolved:1:0:true:1080" ] || fail "this host's health rows are [$got]"
  got="$(q "select count(*) from stream_provider_health where host <> '$host'")"
  [ "$got" = 0 ] || fail "$got health row(s) carry another host"
  ok "one resolve wrote this host's health: bot_check for the first provider, resolved with an English subtitle at 1080p for the second"
}

stage_hls() {
  stage hls
  printf 'hls\n' >"$DIRECT/mode"
  local before prefix lines bad req v720 v1080 seg last
  before="$(upstream_count)"
  play '{"kind":"movie","tmdb_id":550}'
  last="$(tail -1 "$DIRECT/calls.jsonl" | jq -c .args)"
  [ "$last" = "[\"open\",\"http://localhost:$(cat "$DIR/port")/stream/$SID\",\"--fullscreen\"]" ] || fail "the resolver was asked to open [$last]"
  ok "the player page http://localhost:<port>/stream/$SID was opened full screen"
  get "$MANIFEST" hls-master
  [ "$CODE" = 200 ] || fail "the master playlist answered $CODE"
  grep -qi '^content-type: application/vnd.apple.mpegurl' "$EV/direct-hls-master.head" || fail "the master playlist is not served as HLS"
  prefix="/api/stream/sessions/$SID/p?u="
  lines="$(grep -v '^#' "$EV/direct-hls-master.body" | grep -v '^[[:space:]]*$' || true)"
  [ "$(grep -c . <<<"$lines")" = 2 ] || fail "the master playlist has [$lines] as address lines, wanted 2"
  bad="$( (grep -v "^$prefix" <<<"$lines" || true) | grep -c . || true)"
  [ "$bad" = 0 ] || fail "$bad address line(s) do not come back through the pass-through"
  [ "$(grep -o 'URI="[^"]*"' "$EV/direct-hls-master.body" | grep -c .)" = 1 ] || fail "the subtitle rendition's URI is missing"
  bad="$( (grep -o 'URI="[^"]*"' "$EV/direct-hls-master.body" | grep -v "^URI=\"$prefix" || true) | grep -c . || true)"
  [ "$bad" = 0 ] || fail "$bad URI attribute(s) do not come back through the pass-through"
  ! grep -q 'http://' "$EV/direct-hls-master.body" || fail "a plain stream host address is left in the playlist"
  ok "every address in the master playlist (2 variants, 1 subtitle rendition) comes back through /api/stream/sessions/$SID/p"
  req="$(sed -n "$((before + 1)),\$p" "$DIRECT/upstream.jsonl" | jq -c 'select(.path == "/hls/master.m3u8") | {referer, origin, user_agent, cookie}' | tail -1)"
  [ "$req" = '{"referer":"https://embed.fixture/","origin":"https://embed.fixture","user_agent":"FixtureChrome/1.0","cookie":null}' ] || fail "the stream host saw [$req]"
  ok "the stream host saw exactly the captured Referer, Origin and User-Agent, and no cookie"
  v720="$(sed -n 1p <<<"$lines")"
  v1080="$(sed -n 2p <<<"$lines")"
  get "$v1080" hls-1080
  [ "$CODE" = 200 ] || fail "the 1080p variant, on a host only the playlist named, answered $CODE"
  ok "the 1080p variant on the second host, named only inside the playlist, answers 200"
  get "$v720" hls-720
  [ "$CODE" = 200 ] || fail "the 720p variant answered $CODE"
  seg="$(grep -v '^#' "$EV/direct-hls-720.body" | grep -v '^[[:space:]]*$' | head -1)"
  [[ $seg == "$prefix"* ]] || fail "the media playlist's segment [$seg] does not come back through the pass-through"
  get "$seg" hls-seg -H 'Range: bytes=0-99'
  [ "$CODE" = 206 ] || fail "a ranged segment request answered $CODE"
  grep -qi '^content-range: bytes 0-99/1000' "$EV/direct-hls-seg.head" || fail "no content-range bytes 0-99/1000"
  [ "$(wc -c <"$EV/direct-hls-seg.body" | tr -d ' ')" = 100 ] || fail "the ranged segment is not 100 bytes"
  ok "a segment fetched with Range: bytes=0-99 answers 206 with 100 bytes"
}

stage_dash() {
  stage dash
  printf 'dash\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  printf 'hls\n' >"$DIRECT/mode"
  local prefix media seg
  get "$MANIFEST" dash-mpd
  [ "$CODE" = 200 ] || fail "the DASH manifest answered $CODE"
  grep -qi '^content-type: application/dash+xml' "$EV/direct-dash-mpd.head" || fail "the manifest is not served as DASH"
  prefix="/api/stream/sessions/$SID/p?u="
  [ "$(grep -c "<BaseURL>$prefix" "$EV/direct-dash-mpd.body")" = 2 ] || fail "the two BaseURLs are not rewritten"
  ! grep -q 'http://' "$EV/direct-dash-mpd.body" || fail "a plain stream host address is left in the manifest"
  media="$(grep -o 'media="[^"]*"' "$EV/direct-dash-mpd.body" | head -1 | sed 's/^media="//;s/"$//')"
  [[ $media == "$prefix"*'$RepresentationID$'*'$Number%05d$'* ]] || fail "the segment template [$media] lost its template fields"
  ok "both BaseURLs and the segment template come back through the pass-through, template fields untouched"
  seg="${media//\$RepresentationID\$/v720}"
  seg="${seg//\$Number%05d\$/00001}"
  get "$seg" dash-seg
  [ "$CODE" = 200 ] || fail "the filled-in segment address answered $CODE"
  [ "$(wc -c <"$EV/direct-dash-seg.body" | tr -d ' ')" = 1000 ] || fail "the DASH segment is not 1000 bytes"
  ok "the player's filled-in segment address, on the host the manifest's BaseURL named, answers 200 with 1000 bytes"
}

stage_refuse() {
  stage refuse
  printf 'hls\n' >"$DIRECT/mode"
  play '{"kind":"movie","tmdb_id":550}'
  local before after
  before="$(upstream_count)"
  get "/api/stream/sessions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p?u=$(enc "$UP/hls/master.m3u8")" refuse-unknown
  { [ "$CODE" = 403 ] && grep -q '"unknown_session"' "$EV/direct-refuse-unknown.body"; } || fail "an unknown session answered $CODE $(cat "$EV/direct-refuse-unknown.body")"
  get "/api/stream/sessions/$SID/p?u=$(enc 'http://evil.example/x.m3u8')" refuse-host
  { [ "$CODE" = 403 ] && grep -q '"forbidden_host"' "$EV/direct-refuse-host.body"; } || fail "a foreign host answered $CODE $(cat "$EV/direct-refuse-host.body")"
  get "/api/stream/sessions/$SID/p?u=$(enc 'http://127.0.0.1:9/x.m3u8')" refuse-port
  { [ "$CODE" = 403 ] && grep -q '"forbidden_host"' "$EV/direct-refuse-port.body"; } || fail "another port answered $CODE $(cat "$EV/direct-refuse-port.body")"
  after="$(upstream_count)"
  [ "$before" = "$after" ] || fail "the stream host got $((after - before)) request(s) for refused addresses"
  ok "an unknown session and two hosts the resolve did not return answer 403, and the stream host got no request"
}

for s in "${WANTED[@]}"; do
  case "$s" in
    seed) stage_seed ;;
    hls) stage_hls ;;
    dash) stage_dash ;;
    refuse) stage_refuse ;;
    *) echo "journey: unknown stage $s" >&2; exit 2 ;;
  esac
done
echo "journey: PASS (${WANTED[*]})"
"$V" note "$RUN" "direct-stream journey PASS (${WANTED[*]})"
```
**File:** `.claude/skills/verify-notesd/SKILL.md`
- In the Launch code block, after the `$V up --movies ...` line:
~~~text
$V up --direct-stream # Direct streaming ON (implies --movies) against a fake resolver and a fixture stream host
~~~
- After the paragraph that ends `drives the whole chain; see \`features/movies.md\`.`, add a paragraph:
~~~markdown
Every run also pins `NOTESD_DIRECT_STREAM=off`, so a `--movies` run never runs the real resolver (it
drives the owner's streaming Chrome on Windows). `--direct-stream` turns it on with
`NOTESD_DIRECT_STREAM_CLI` pointing at `tests/fixtures/direct-stream/fake-cli.mjs` and a fixture stream
host (`tests/fixtures/direct-stream/upstream.mjs`) under `<run>/direct/`: `mode` there picks the fake's
next answer (`hls`, `dash`, `no_source`, `no_chrome`), `calls.jsonl` records every resolve and open,
`upstream.jsonl` every request the host got. `scripts/direct-stream/journey.sh RUN` drives it; see
`features/direct-streaming.md`. A `NOTESD_DIRECT_STREAM_CLI` in the caller's environment replaces the
fake under `--direct-stream` (phase 6's `playcheck.mjs` wrapper uses this).
~~~
- In Gotchas, add a bullet:
~~~markdown
- Never give a throwaway daemon the real `claude/streaming/direct/cli.mjs`: it opens tabs in the owner's
  streaming Chrome. `up --direct-stream` is the only way to drive direct streaming; the one exception is
  `playcheck.mjs`'s wrapper (`NOTESD_DIRECT_STREAM_CLI=<dir>/cli.mjs`), which records `open` and is run
  only when the owner expects the streaming Chrome to come forward, muted.
~~~
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (new)
~~~markdown
# Direct streaming (provider registry, play, sessions, the pass-through)

## Sub-features
- Provider registry: `claude/streaming/direct/providers.seed.json` is loaded into `stream_providers`
  at every start (shared by both machines; seed rows have `origin_site` null); health per provider
  and host in `stream_provider_health`, written after every resolve. Proven by
  `npm run test:int -- tests/integration/directStream.repo.int.test.ts` and `journey.sh RUN seed`.
- Play: `POST /api/stream/play` (same-origin) resolves through the resolver CLI and opens
  `http://localhost:<port>/stream/<session id>` full screen in the streaming Chrome (the page itself
  is phase 4's). Sessions live in memory: a 32-character random id, 4 hours idle, 24 hours at most.
- Pass-through `GET /api/stream/sessions/:id/p?u=`: only the captured `Referer`, `Origin`,
  `User-Agent` and the player's `Range`; HLS and DASH rewritten so every address comes back through
  it; `.srt` served as WebVTT; hosts limited to what the session's resolve returned and what its
  playlists, manifests and redirects named. Proven by `journey.sh RUN hls dash refuse` and
  `npm run test:int -- tests/integration/directStream.api.int.test.ts`.
- Refresh: `POST /api/stream/sessions/:id/refresh` resolves again under the same id.
- Off: `NOTESD_DIRECT_STREAM=off` or `NOTESD_MOVIES=off` answers 503 `direct_stream_off` on every
  `/api/stream/*` route, and nothing is built that could start Chrome
  (`npx vitest run tests/unit/directStream/build.test.ts`).

## How to get to it (user POV)
Play on a stream (phase 9) or `/direct-stream <title>` (phase 7) opens the player page full screen in
the streaming Chrome. Underneath, both call `POST /api/stream/play` from the wall's origin.

## Driving it with verify.sh
- `$V up --direct-stream` (implies `--movies`): `up` prints `DIRECT=<run>/direct`. The fixture stream
  host listens on two ports of 127.0.0.1 and answers 403 without `Referer: https://embed.fixture/`; the
  fake resolver returns addresses on the first port, the second is named only inside the playlists.
  `echo dash > $DIRECT/mode` (or `no_source`, `no_chrome`) picks the next resolve's answer.
- `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN [seed|hls|dash|refuse]`: every check,
  saved as evidence; ends with `journey: PASS (...)`. Run `seed` first on a fresh run (it counts health
  after exactly one play).
- Every run without `--direct-stream` pins `NOTESD_DIRECT_STREAM=off`, so `$V up --movies` alone shows the
  off answer: `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":550}'` answers 503.
- `down` copies `upstream.jsonl` and `calls.jsonl` into the evidence folder.

## Gotchas
- Never point a throwaway daemon at the real resolver: it opens tabs in the owner's streaming Chrome.
  The live resolve is phase 1's check, run when the owner expects it; the live playback probe is
  `playcheck.mjs` (phase 6), which passes its own wrapper as `NOTESD_DIRECT_STREAM_CLI` under `--direct-stream`.
- A session lives in memory: restarting the daemon ends it (403 `unknown_session`).
- A 403 that carries `X-Notesd-Upstream` is the stream host's (an expired token: refresh); one
  without it is notesd's refusal (`unknown_session`, `forbidden_host`).
~~~
**File:** `.claude/skills/verify-notesd/features/README.md`: after the Movies row, add:
~~~markdown
| Direct streaming: provider registry and health, play, sessions, the stream pass-through (`/api/stream/*`) | [direct-streaming.md](direct-streaming.md) | API, fake resolver and fixture stream host (`up --direct-stream`), database |
~~~
**Check:** `bash -n .claude/skills/verify-notesd/scripts/verify.sh .claude/skills/verify-notesd/scripts/direct-stream/journey.sh`; then the Proof journeys below.

## Principles applied

- Laziness protocol: the direct-stream runner reuses the streaming runner's code through an extracted `runJsonScript` instead of a copy; sessions are swept lazily on access, so no timer or background job is added; one router file holds all four routes and phase 5's later fifth.
- Boundary discipline: the resolver's printed JSON is validated once in `runner.ts` (`parseResolveOutput`, `parseOpenOutput`), the seed file once in `readSeedFile`, the play body once in the route (`playBody`), env once in `parseDirectStream`, and a loose caller target once in `toStreamRef`; the service, repo and pass-through trust the typed values.
- Make illegal states unrepresentable: `StreamRef` is a discriminated union (a film cannot carry a season); the play body is a discriminated union with strict objects; `stream_provider_health.last_outcome` has a CHECK that leaves out the two skip outcomes, so a skip can never be stored as health.
- Build the lever: one fake resolver and one fixture stream host serve both the integration tests and `verify.sh up --direct-stream`, and `journey.sh` reruns every daemon check, so a verifier reruns the script instead of reading the diff.
- Test behavior, not implementation: the integration tests drive the HTTP routes against a real stream host process and a real Postgres and assert on what the player and the host see (status, headers, rewritten bodies, request log), not on service internals.
- Encode lessons in structure: the harness pins `NOTESD_DIRECT_STREAM=off` on every run unless `--direct-stream` is passed, the same way `NOTESD_MOVIES` is pinned, so a `--movies` verification can never reach the owner's Chrome.
- Prove it works: the Proof drives the real daemon from source through `verify.sh` with evidence files, not only unit tests.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (unit: config, rewrite, sessions, runner, seed, build, docs reference) and `npm run test:int -- tests/integration/directStream.repo.int.test.ts tests/integration/directStream.api.int.test.ts tests/integration/schema.int.test.ts`; `npm run docs:check`.
**Proof:** a throwaway daemon built from this checkout, driven over HTTP with a fake resolver and a fixture stream host; the database and the host's request log read back.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --direct-stream`, `scripts/direct-stream/journey.sh`)
- Feature-map entries: `features/direct-streaming.md`, `features/movies.md` (neighbor)
- Setup for J1, J3, J4, J5 (one run, in order): `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && V=.claude/skills/verify-notesd/scripts/verify.sh && eval "$($V up --direct-stream | grep -E '^(RUN|URL|DIRECT)=')" && J=.claude/skills/verify-notesd/scripts/direct-stream/journey.sh`; after the last one, `$V down $RUN`.
- Journeys:
  - **J1** · traces R1.4 — `$J $RUN seed` (on the fresh run, before any other stage) → passes when it prints `journey: PASS (seed)` after two `ok` lines: `stream_providers` holds as many rows as `claude/streaming/direct/providers.seed.json` has entries, all with `origin_site` null; after one `POST /api/stream/play` the only health rows are this host's (`hostname`), one `bot_check:0:1:-:-` and one `resolved:1:0:true:1080`, and none carry another host
  - **J2** · traces R1.4 — `npm run test:int -- tests/integration/directStream.repo.int.test.ts` → passes when all five tests pass, including "keeps health per host" (`host-a` and `host-b` rows for the same provider stay apart and `healthFor` returns only its own host's) and "loads the seed once, updates a changed seed row, and never touches a row a site added"
  - **J3** · traces R2.1 — `$J $RUN hls` → passes when it prints `journey: PASS (hls)`: the resolver was asked to `open http://localhost:<port>/stream/<sid> --fullscreen`; the master playlist answers `application/vnd.apple.mpegurl` with both variant lines and the one `URI="..."` starting `/api/stream/sessions/<sid>/p?u=` and no `http://` left; the fixture host's log shows that request with `referer` `https://embed.fixture/`, `origin` `https://embed.fixture`, `user_agent` `FixtureChrome/1.0` and `cookie` null; the 1080p variant on the second port (named only in the playlist) answers 200; a segment with `Range: bytes=0-99` answers 206 with `content-range: bytes 0-99/1000` and 100 bytes
  - **J4** · traces R2.1 — `$J $RUN dash` → passes when it prints `journey: PASS (dash)`: the manifest answers `application/dash+xml` with both `<BaseURL>` rewritten to `/api/stream/sessions/<sid>/p?u=...`, no `http://` left, a `media` template that still holds `$RepresentationID$` and `$Number%05d$`, and the filled-in segment address answers 200 with 1000 bytes
  - **J5** · traces R2.2 — `$J $RUN refuse` → passes when it prints `journey: PASS (refuse)`: an unknown 32-character session id answers 403 `unknown_session`, `u=http://evil.example/x.m3u8` and `u=http://127.0.0.1:9/x.m3u8` on a live session answer 403 `forbidden_host`, and the fixture host's request log has the same number of lines before and after the three requests
  - **J6** · traces R2.2 — `npx vitest run tests/unit/directStream/sessions.test.ts && npm run test:int -- tests/integration/directStream.api.int.test.ts -t "answers 403 and fetches nothing"` → passes when both pass: a session is gone at 4 hours idle and at 24 hours however used, and after the clock moves 4 hours the manifest and session routes answer 403 `unknown_session` with `up.requests` unchanged
  - **J7** · traces R2.6 — `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && V=.claude/skills/verify-notesd/scripts/verify.sh && eval "$($V up --movies | grep -E '^(RUN|URL)=')" && $V api $RUN POST /api/stream/play '{"kind":"movie","tmdb_id":550}' && curl -s -w ' %{http_code}\n' "$URL/api/stream/sessions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p?u=http%3A%2F%2F127.0.0.1%3A9%2Fx.m3u8" && curl -s -w ' %{http_code}\n' -X POST "$URL/api/stream/sessions/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/refresh" && $V sql $RUN "select count(*) from stream_providers" && grep -c 'direct stream: on' ~/.local/state/notesd-verify/$RUN/daemon.log; ls ~/.local/state/notesd-verify/$RUN/direct; $V down $RUN` → passes when the play answers `HTTP 503` with `"error":"direct_stream_off"`, both curl calls (no Origin) print a `direct_stream_off` body and ` 503`, `stream_providers` has `0` rows, `grep -c` prints `0`, and `ls` reports no `direct` folder (nothing was resolved and no resolver was ever configured)
  - **J8** · traces R2.6 — `npx vitest run tests/unit/directStream/build.test.ts && npm run test:int -- tests/integration/directStream.api.int.test.ts -t "direct_stream_off"` → passes when both pass: the builder returns null for `NOTESD_DIRECT_STREAM=off`, `NOTESD_MOVIES=off`, a null movies service and a config without the section, with the runner never called; and all four routes answer 503 `direct_stream_off` without an Origin while the fake resolver's call log stays empty
- Neighbor check: the movies chain on a run with direct streaming on, and the old streaming tools. `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && V=.claude/skills/verify-notesd/scripts/verify.sh && eval "$($V up --web --direct-stream | grep -E '^RUN=')" && .claude/skills/verify-notesd/scripts/movies/journey.sh $RUN; $V down $RUN; npx vitest run tests/unit/streaming.test.ts tests/unit/mcp.streamingTools.test.ts` → passes when the movies journey ends `journey: PASS (12 stages)` and both streaming test files pass unchanged (the `runJsonScript` extraction kept `scriptRunner`'s behaviour).
- Cost: none. No LLM turn, no provider, no Chrome; the fixture library build needs ffmpeg once.

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the two integration files pass; migration `0020_stream_providers` applies on a fresh database (`verify.sh up` succeeds); J1-J8 pass and the neighbor check passes.

## Handoffs

- **Phase 4 (R2.3, R2.5):** serve `/stream/<sessionId>` from `src/http/static.ts` (the page `pageBase` + `/stream/<id>` points at); read `GET /api/stream/sessions/:id` (shape above; `subtitles[].english` and `format: 'vtt'` for converted `.srt`; tracks with `source: 'manifest'` are already inside the rewritten manifest). On a pass-through answer of 401/403/410 that carries `X-Notesd-Upstream`, call `POST /api/stream/sessions/:id/refresh` (same id; the page's own `fetch` sends the Origin the same-origin guard needs), then reload `manifest_url` and seek to the last position. A 403 without that header (`unknown_session`, `forbidden_host`) means the session is over: refresh will not help. Phase 4 also proves R2.5 end to end; this phase only keeps the id across a refresh.
- **Phase 5 (R2.4, R5.4):** implement `DirectStreamHooks` (`recordResolve(ref, result)` gets the whole `ResolveOutput`; mark stale only when `result.error === 'no_source'`; `resumeS(ref)`; optionally `titleLabel(ref)`) and pass them as `hooks` in the third argument of `buildDirectStreamService(config, db, { movies, pageBase, hooks })` in `src/daemon.ts` (the call sits after the movie player block). `session(id)` returns the raw `StreamSession` (sync) with `id`, `ref`, `source.provider`, as phase 5's `StreamSessionRef` needs; `info(id)` is the JSON for the player. Add `POST /api/stream/sessions/:id/position` inside `directStreamRoutes` (the off guard covers it) and widen its `Pick<AppDeps, 'directStream'>` to include `movies`. `truncateAll` already empties `movie_stream_sources` through `movie_titles ... cascade` (its foreign key), so it needs no line of its own. Generate `0021` after `0020`. `config.directStream?.freshDays` is the freshness window.
- **Phase 7 (R3, and R2.6's tools half):** `play(input)` and `resolve(input)` take `StreamRefInput` (`{kind, tmdbId, season?, episode?}`), so phase 7's `StreamTarget` passes as is. Failures throw `DirectStreamError` with top-level `code` (`no_source`, `resolve_failed`, `open_failed`), `attempts` (the CLI's snake_case shape), and `reason` for `resolve_failed` / `open_failed` (`no_chrome`, `chrome_not_reachable`, ...): phase 7's mapper should read `reason` when `code` is not `no_source`. `play` resolves to the JSON-ready `PlayResult {page_url, session, attempts}`. The tools half of R2.6 (`direct_stream_off` from the MCP tools) is phase 7's to build and prove; this phase proves the routes and the service only. Add `directStream` to `mcpToolDeps` (`src/http/app.ts:69`).
- **Phase 8 (R4):** `DirectStreamRepo.providers()`, Drizzle columns `movie`, `tv`, `originSite` (nullable, null for seed rows), service fields `repo` and `runner`, and `runResolve(ref, { only })` (serialized, records health, does not call `recordResolve`, returns `ResolveOutput` rather than throwing) are as phase 8's plan names them. Settled by the reconciler: `syncSeed` is not insert-only; it also updates a seed row (`origin_site` null) whose fields changed in the file, so phase 2's and phase 6's seed values reach a database seeded earlier. A row phase 8 inserts carries its site in `origin_site` and is never touched by the seed.
- **Phase 6 (R7.3):** `up --direct-stream` with `NOTESD_DIRECT_STREAM_CLI=<playcheck dir>/cli.mjs` in the caller's environment runs the playcheck wrapper instead of the fake. The pass-through forwards an upstream 401/403/410 (the expiry gate's 410 included) with `X-Notesd-Upstream`, which is what the page's refresh rule reads.
- **Phase 9 (R5):** `verify.sh up --direct-stream` (implies `--movies`) is the flag that turns direct streaming on in a throwaway run, with a fake resolver, so `GET /api/movies/stream` answers `enabled: true` and phase 9's journeys can drive the real `POST /api/stream/play`. A plain `--movies` run has it off.
- **Phase 10 (R6):** add the `prober` block to `DirectStreamConfig`, `DEFAULT_DIRECT_STREAM_CONFIG` and `parseDirectStream` (one place each), the matching key in `tests/unit/config.test.ts`'s direct-streaming test, and its rows to the "Direct streaming" section of `configuration.md`. Prober resolves go through `resolve(ref, { deadlineS })` (so phase 5's hook records verified/stale before the answer, and the pass's seconds bound each resolve) and are serialized with plays by the service's queue. `--prober` in `verify.sh` goes on top of `--direct-stream`.
- **Phase 1:** this phase writes the "The resolver" subsection of `docs/guide/streaming.md` from phase 1's draft, as phase 1's plan asks; phase 1 does not edit the guide. The runner reads stdout on exit 1 and 2 and waits up to 20 minutes for a whole resolve.
- **Phases 4, 7, 8, 10 (guide):** each appends its own subsection under this phase's `## Direct streaming` ("The player", "`/direct-stream`", "`/update-cloud-source`", "The prober"); `configuration.md` and `scripts/docs/httpRoutes.ts` are also edited by phases 5, 9 and 10, each adding only its own rows.
- **Not for any phase:** `README.md`'s line is this phase's (above). `CLAUDE.md` (an Architecture bullet: `DirectStreamRepo` is the only writer of `stream_*`, the pass-through host rule, the off switches; the `web/stream.html` page) is left to the owner, listed in the index's "Follow-ups for the owner".

## Rollback

Revert this phase's commits. The migration only adds two tables: on a database that applied it,
`drop table stream_provider_health, stream_providers;`, remove the `0020_stream_providers` row from
`drizzle.__drizzle_migrations`, and delete `drizzle/0020_stream_providers.sql`,
`drizzle/meta/0020_snapshot.json` and the journal entry. Without a revert, `NOTESD_DIRECT_STREAM=off`
turns the whole subsystem off (nothing built, every route 503). The `runJsonScript` extraction is
behaviour-neutral and reverts with the rest.

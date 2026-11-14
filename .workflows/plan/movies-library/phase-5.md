# Phase 5: VLC playback: launch, live tracking, recents backfill, continue

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R3, R4, R6 — Play/Resume in the Windows VLC from WSL with live progress, the `[RecentsMRL]` backfill, and "continue <title>"
**Criteria:** R3.7, R4.1, R4.2, R4.3, R4.4, R4.5, R6.1, R6.2
**Depends on:** Phase 3 (and through it Phases 1 and 2)
**Difficulty:** HARD
**Package:** `src/movies` (`src/movies/vlc/*`, `player.ts`, `continue.ts`), `src/http/moviesPlayApi.ts`

---

## Goal

After this phase, `POST /api/movies/files/:fileId/play` starts `vlc.exe` on a file of this host
at its resume position. notesd checks that VLC is playing and seeks if it is not at that
position, polls VLC's HTTP interface through the Windows `curl.exe` into one play event, and
closes the event at the last position it read when VLC exits. Each sync pass turns VLC's
`[RecentsMRL]` list into play observations, including a deleted file under the matched title
for a film that is already gone. `POST /api/movies/continue` resumes or starts the right
episode or film, or names the missing episode. `/api/capabilities` reports whether playback
works on this host.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**

- `src/movies/vlc/launch.ts`: `PlayerEnv` (`{ vlc, curl, wslpath }`), `PlayerUnavailableReason`
  (`'not_linux' | 'no_interop' | 'no_wslpath' | 'no_vlc' | 'no_curl' | 'no_free_port' | 'launch_failed'`),
  `PlayerDetection` (`{ available: true; env } | { available: false; reason }`), `PlayerBinaries`,
  `detectPlayerEnv(bins, probe): Promise<PlayerDetection>`, `VlcLaunch`, `vlcArgs(l): string[]`,
  `VlcLauncher` (`launch(env, l): Promise<void>`), `spawnVlcLauncher(opts?: { scope?: boolean })`,
  `runningAsSystemdService(cgroupText)`, `scopeArgs(vlc, args)`, `newHttpPassword()`, `VLC_HTTP_HOST = '127.0.0.1'`
- `src/movies/vlc/http.ts`: `VlcState`, `VlcStatus` (`{ state, time, length }`), `VlcEndpoint`
  (`{ port, password }`), `VlcReply` (`ok | gone | unauthorized | error`), `VlcCommand`,
  `VlcStatusReader` (`status(curl, ep)`, `command(curl, ep, cmd)`), `ExecResult`, `ExecFn`,
  `execCapture`, `statusUrl`, `curlArgs`, `interpretCurl`, `parseStatusJson`,
  `curlStatusReader(exec?)`, `CURL_EXIT_CONNECT_FAILED = 7`
- `src/movies/vlc/recents.ts`: `RecentsEntry`, `iniSection`, `splitQtList`, `fileUrlToWslPath`,
  `parseRecents(iniText)`, `recentsRelPath`, `shouldRecord`, `RECENTS_SAME_POSITION_S = 10`,
  re-export of phase 3's `TitleResolver` (from `../sync.js`; no second definition), `RecentsRepo`, `RecentsFs`, `nodeRecentsFs`,
  `RecentsHookDeps`, `RecentsReport`, `recentsSyncHook(deps): SyncHook & { run(): Promise<RecentsReport> }`
- `src/movies/player.ts`: `class MoviePlayer` (`host`, `availability()`, `start()`, `play(fileId)`,
  `current()`, `close()`), `PlayError` + `PlayErrorCode`
  (`'not_found' | 'not_on_this_machine' | 'player_unavailable' | 'file_missing'`), `PlayerRepo`,
  `MoviePlayerDeps`, `PlayStarted`, `PlayerSnapshot`, `PlayerAvailability`, `PlaybackService`,
  `PlaybackOverrides`, `buildMoviePlayback(service, config, overrides?)`, constants
  `PORT_CANDIDATES = 10`, `READY_TIMEOUT_MS = 20000`, `READY_INTERVAL_MS = 500`,
  `PLAYING_TIMEOUT_MS = 3000`, `SEEK_TOLERANCE_S = 5`, `MAX_READ_ERRORS = 6`
- `src/movies/continue.ts`: `continueTitle(deps, titleQuery | null): Promise<ContinueResult>`,
  `ContinueDeps`, `ContinueResult`, `ContinueTitleRef`, `ContinueEpisodeRef`, `NothingReason`,
  `ContinueFileView`, `EpisodeSlot`, `ContinueDecision`, `decideContinue(kind, titleWatchedAt, files, episodes)`
- (reconciled) no `src/movies/repo.ts` edit: `closeOpenPlays(host)` and `findTrackedFile(host, path, name)` are
  Phase 1's (moved there so no wave-3 phase edits `repo.ts`), and a gone recents file is created with Phase 1's
  `upsertFile({ ..., source: 'vlc_recents', deletedAt, classification: { status: 'matched', titleId } })`
- `src/deps.ts`: `AppDeps.moviesPlayer?: MoviePlayer | null` (optional, so no existing
  `AppDeps` literal changes)
- `src/http/moviesPlayApi.ts`: the body of `moviesPlayRoutes(deps)` plus `playErrorResponse`
- `/api/capabilities` gains `movies_playback: boolean`
- Test fixtures: `tests/fixtures/movies/fake-vlc.mjs` (a fake `vlc.exe` speaking VLC's HTTP
  status API), `tests/fixtures/movies/memVlc.ts`, `tests/fixtures/movies/rows.ts`,
  `tests/integration/helpers/moviesPlaySeed.ts` (renamed from `moviesSeed.ts` by the reconciler: Phase 4, same wave,
  owns `tests/integration/helpers/moviesSeed.ts`)

**Routes and wire types (Phase 6 and Phase 7 build against these exactly):**

```ts
// POST /api/movies/files/:fileId/play   (sameOriginOnly)
//   202 { ok: true, play: PlayStarted }
//   400 { error: 'invalid_id' }
//   403 { error: 'forbidden_origin' }
//   404 { error: 'not_found', message }
//   404 { error: 'not_on_this_machine', host: string | null, message }
//   409 { error: 'player_unavailable', reason: PlayerUnavailableReason | null, message }
//   410 { error: 'file_missing', message }
//   503 { error: 'movies_off', message }
interface PlayStarted {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;              // file basename
  start_position: number;    // seconds VLC was started at (0 = from the start)
  port: number;              // VLC HTTP port on Windows loopback
  tracking: boolean;         // false: VLC's HTTP interface never answered; play row already closed
  note: 'http_timeout' | null;
}

// POST /api/movies/continue  { title?: string }   (sameOriginOnly)
//   200 ContinueResult; play failures use the same error bodies/statuses as /play;
//   400 { error: 'invalid_body', message }; 403; 503 movies_off
interface ContinueTitleRef { id: string; title: string; kind: 'movie' | 'tv'; year: number | null }
interface ContinueEpisodeRef {
  file_id: number | null; season: number | null; episode: number | null;
  absolute_episode: number | null; name: string | null;
}
type NothingReason = 'finished' | 'caught_up' | 'no_episodes';
type ContinueResult =
  | { action: 'resumed' | 'started'; title: ContinueTitleRef; file: ContinueEpisodeRef; position: number; play: PlayStarted }
  | { action: 'missing'; title: ContinueTitleRef; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; title: ContinueTitleRef; reason: NothingReason; finished_at: string | null; last: ContinueEpisodeRef | null }
  | { action: 'ambiguous'; query: string; candidates: ContinueTitleRef[] }
  | { action: 'no_match'; query: string | null };

// GET /api/movies/player   (no Origin check; read only)
//   200 { available: boolean; reason: PlayerUnavailableReason | 'movies_off' | null; current: PlayerSnapshot | null }
interface PlayerSnapshot {
  play_id: number; file_id: number; title_id: string | null; name: string; port: number;
  state: 'playing' | 'paused' | 'stopped';
  position: number; duration: number | null;
  started_at: string; last_read_at: string | null;   // ISO 8601
}

// GET /api/capabilities  ->  { reveal: boolean, movies_playback: boolean }
```

The contract's `ContinueResult` union is widened with `'ambiguous'` and `'no_match'` (the brief's
"ambiguous -> report candidates" and "no title matches"). `'missing'` always carries a
`missing` ref. For a film with no file on this host, that ref holds only nulls.

**Signature changes:** `revealRoutes`'s `GET /api/capabilities` body goes from `{ reveal }` to
`{ reveal, movies_playback }`. The reveal routes and `detectRevealEnv` / `runWslpath` /
`findOnPath` / `spawnDetached` keep their current behavior.

**Requires (from earlier phases):** these are the exact shapes the code below assumes. If a
landed phase differs, the reconciler maps these call sites, and the logic stays the same.

- Phase 1 `src/db/schema.ts`: `movieTitles`, `movieFiles`, `moviePlays`, `movieEpisodes` with
  camelCase properties for the contract's snake columns (`titleId`, `durationS`, `absoluteEpisode`,
  `deletedAt`, `doneAt`, `watchedAt`, `startedAt`, `endedAt`, `startPositionS`, `positionS`,
  `updatedAt`, `originalTitle`, `runtimeMin`, `metadataFetchedAt`, `firstSeenAt`, `lastSeenAt`,
  `movedAt`, `mtime`, `parsed`, `reason`, `status`, `source`). `bigserial`/`bigint` columns use
  `{ mode: 'number' }`, so row ids and `size` are `number`.
- Phase 1 `src/movies/repo.ts` (reconciled to Phase 1's code): `new MoviesRepo(db: Db)`, and:
  - `fileById(id): Promise<MovieFileRow | null>`, `titleById(id): Promise<MovieTitleRow | null>`
  - `lastPlay(fileId): Promise<MoviePlayRow | null>`: the newest play with a known position, else the newest
  - `startPlay(input: NewPlay)` with `NewPlay = { fileId, host, source, startedAt: Date, startPositionS, durationS }`:
    `position_s = startPositionS`, returns the row
  - `updatePlay(playId, reading: { positionS; durationS }, now?): Promise<boolean>` (false once the play is closed)
  - `endPlay(playId, reading: Partial<PlayReading>, endedAt: Date): Promise<MoviePlayRow | null>`
  - `recordObservation(obs: { fileId; host; positionS; durationS; observedAt }): Promise<{ play; created }>`
    (`source = 'vlc_recents'`, `started_at = ended_at = observedAt`)
  - `closeOpenPlays(host): Promise<number>`, `findTrackedFile(host, path, name): Promise<MovieFileRow | null>`
    (both added to Phase 1 by the reconciler, code as this plan wrote them)
  - `upsertFile(input: NewMovieFile): Promise<{ file; created }>`; with `deletedAt` set it always inserts a new,
    already deleted row
  - `upsertTitle(meta: TitleMetadata): Promise<string>`
- Phase 1 `src/movies/state.ts`: `fileState(file, lastPlay)` and `resumePosition(file, lastPlay)`
  take the `$inferSelect` rows above (or a structural subset of them).
- Phase 1 `src/movies/types.ts`: `TitleKind`, `WatchState`, `TitleMetadata`, `titleId(kind, tmdbId)`.
- Phase 1 `src/config.ts`: `MoviesConfig` with `roots: string[]` and
  `vlc: { bin: string; ini: string | null; httpPort: number; pollMs: number; curlExe: string }`;
  `Config.movies`.
- Phase 1 `src/http/app.ts` mounts `app.route('/', moviesPlayRoutes(deps))`, and `src/http/moviesPlayApi.ts`
  exists as an empty router exporting `moviesPlayRoutes`.
- Phase 2 `src/movies/parse.ts`: `isVideoFile(name)`, `parseVideoPath(relPath): ParsedName` (with
  `season`, `episode`, `absoluteEpisode`); `src/movies/match.ts`: `matchTitle(parsed, client)`
  returning `{ kind: 'matched'; tmdbKind: TitleKind; tmdbId: number; confidence: number } | { kind: 'none'; reason: string }`;
  `src/movies/tmdb.ts`: `TmdbClient` with `movieDetails(id)` / `tvDetails(id)` returning `TitleMetadata`.
- Phase 3 `src/movies/sync.ts`: `SyncHook` = `{ name?; afterScan?(ctx): Promise<number | void> }` (the number of
  rows written; a positive total makes the pass emit `changed('sync')`), and `TitleResolver` / `tmdbResolver(tmdb,
  fallback)`, which this phase reuses instead of defining its own.
- Phase 3 `src/movies/service.ts`: `MoviesService` with `repo: MoviesRepo`, `host: string`,
  `tmdb: TmdbClient | null`, `events: MovieEvents` (`changed(reason, { titleIds?, fileIds? })`),
  `addSyncHook(hook): () => void`. `buildMoviesService` returns null only for `NOTESD_MOVIES=off`, so empty roots
  still give a service (and a player). `src/daemon.ts` builds `const movies = buildMoviesService(config, db)`
  before `const deps: AppDeps = {...}`, and puts `movies` in that literal.

**Leaves alone (owned by others):** `src/http/moviesApi.ts`, `src/movies/read.ts`,
`src/movies/reviewNote.ts` (Phase 4); `web/**` including `web/src/api.ts`'s `Capabilities`
type (Phase 6); `src/mcp/**`, `src/chat/**`, `claude/skills/n` (Phase 7); `drizzle/**`,
`src/db/schema.ts`, `src/config.ts` (Phase 1); `src/movies/sync.ts`, `scan.ts`, `service.ts`,
`src/background.ts` (Phase 3); README, CLAUDE.md, `.claude/skills/verify-notesd/**` (Phase 8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/vlc/launch.ts` | create | player env detection, VLC argv, detached launcher, per-launch password |
| `src/movies/vlc/http.ts` | create | `curl.exe` status/command reader, curl output into `VlcReply` |
| `src/movies/vlc/recents.ts` | create | `[RecentsMRL]` parser and the sync hook |
| `src/movies/player.ts` | create | `MoviePlayer`, `PlayError`, `buildMoviePlayback` |
| `src/movies/continue.ts` | create | `continueTitle`, pure `decideContinue` |
| `src/http/moviesPlayApi.ts` | modify (replace Phase 1's empty body) | three routes |
| `src/http/reveal.ts` | modify (`:282-295`) | `/api/capabilities` adds `movies_playback` |
| `src/deps.ts` | modify (`:24`, after `adversary`) | `moviesPlayer?: MoviePlayer \| null` |
| `src/daemon.ts` | modify (after Phase 3's `movies` build, the `deps` literal, `stop`) | build the player, close stale plays at start, close the player before the DB |
| `tests/integration/reveal.int.test.ts` | modify (`:56-62`) | capabilities keys now `['reveal', 'movies_playback']` |
| `tests/fixtures/movies/fake-vlc.mjs` | create | fake `vlc.exe`: VLC's `/requests/status.json` with Basic auth |
| `tests/fixtures/movies/memVlc.ts` | create | in-memory launcher + status reader for unit/int tests |
| `tests/fixtures/movies/rows.ts` | create | full `movie_files` / `movie_plays` row builders |
| `tests/integration/helpers/moviesPlaySeed.ts` | create | seed and truncate the movie tables (own name: Phase 4 owns `moviesSeed.ts`) |
| `tests/unit/movies/vlc.launch.test.ts` | create | detection reasons, argv |
| `tests/unit/movies/vlc.http.test.ts` | create | curl argv and reply interpretation |
| `tests/unit/movies/vlc.recents.test.ts` | create | ini parsing and hook decisions |
| `tests/unit/movies/player.test.ts` | create | play flow, polling, exit, port pick, errors, close |
| `tests/unit/movies/continue.test.ts` | create | `decideContinue` rules |
| `tests/integration/movies.play.int.test.ts` | create | fake VLC over real curl, routes, DB rows |
| `tests/integration/movies.continue.int.test.ts` | create | `POST /api/movies/continue` against seeded DB |
| `tests/integration/movies.recents.int.test.ts` | create | recents hook writes observations and deleted files |

## Design decisions (read before Step 1)

These came from the analysis's measured facts and the brief's design risks. The code below
carries each one.

1. **Reaching VLC from WSL.** WSL is in NAT mode. A VLC bound to Windows `127.0.0.1` cannot be
   reached from Linux, so every status read and command runs the Windows `curl.exe` (about
   70 ms per call, measured). VLC binds only `--http-host 127.0.0.1`.
2. **Launch flags.** `--no-one-instance` and `--no-one-instance-when-started-from-file` (the
   owner's `vlcrc` has the `one-instance-when-started-from-file=1` default) keep a notesd launch
   out of the owner's running VLC. `--qt-continue=0` turns off VLC's own "Continue playback?"
   prompt. `qt-continue` is an integer option (0 never, 1 ask, 2 always), and there is no
   `--no-qt-continue`. `--no-qt-privacy-ask` stops the first-run dialog. `--extraintf http`
   adds the HTTP interface next to the Qt window. `--start-time=<s>` is still passed.
3. **Confirm, then seek.** The probe showed that launch flags alone are unreliable (`stopped`
   until a command came). After the HTTP interface answers, notesd sends `pl_play` if VLC is
   not `playing`. It waits until VLC reports `playing` with a known length, then sends
   `seek&val=<start>` when the time is more than `SEEK_TOLERANCE_S` (5 s) off.
4. **HTTP interface not up.** The player waits up to `READY_TIMEOUT_MS` (20 s) and polls every
   500 ms. If VLC never answers, the play row (started at the resume position) is closed at once,
   at that position. The response says `tracking: false, note: 'http_timeout'`. The passive
   `[RecentsMRL]` layer still catches the real final position when that VLC exits.
5. **Ports.** Every launch gets a fresh random password (32 hex chars). A port is free only when
   nothing answers on it (`curl` exit 7). The brief's reuse rule ("answers with our password ->
   ours") cannot fire, because no live VLC ever has the new password. So any answer (401, 200,
   other) means the port is taken, and the player tries `httpPort+1 .. httpPort+9`. If all ten
   are taken, the answer is `player_unavailable` / `no_free_port`. A previous notesd VLC that is
   still open (its tracking ended by a newer play) therefore keeps its port.
6. **One tracked play at a time.** `play()` calls are queued. A new play first ends tracking of
   the current one with its last position (`endPlay`) and never sends that VLC a command. notesd
   has no kill path at all: `VlcLauncher` has no stop method.
7. **What a poll records.** `playing`/`paused`: position and length go into `updatePlay`.
   `stopped`: nothing is written, because VLC reports `time 0, length 0` once stopped or at the
   end of the media, and that would overwrite the real last position. `curl` exit 7 (VLC gone),
   or a 401 on our port (a different program now holds it), ends the play with the last position
   read. Other errors (curl timeout 28 and the like) are counted, and the 6th in a row ends the play.
8. **Shutdown and restart keep VLC open.** `MoviePlayer.close()` (daemon stop, before the DB closes)
   ends the tracked play with its last position. VLC must survive the daemon (index Decisions: a
   daemon restart must not interrupt a film). A detached process group is not enough: the live
   daemon is a systemd user unit with `KillMode=control-group`, which kills every process in the
   unit's cgroup, the WSL interop proxy of `vlc.exe` included. So when notesd itself runs as a
   systemd service (`runningAsSystemdService(/proc/self/cgroup)`: the last cgroup segment is a
   `*.service` other than `user@<uid>.service`) and `systemd-run` is on PATH, the launcher starts
   VLC as `systemd-run --user --scope --quiet --collect -- <vlc.exe> <args>`: a transient scope of
   its own, outside `notesd.service`, which a restart of the unit does not touch. Otherwise (tests,
   `verify.sh`, a daemon started by hand) it spawns VLC detached as before. Argument passing is
   unchanged (no `cmd.exe` re-quoting). Phase 8's post-deploy step verifies a VLC survives
   `systemctl --user restart notesd`.
9. **Restart.** `MoviePlayer.start()`, run by the daemon before it listens, closes every live
   play of this host still open: `ended_at = updated_at` (the time of the last position read),
   with `position_s` kept. The old VLC's password died with the old process, so notesd cannot
   re-attach. When that VLC exits, its final position arrives through `[RecentsMRL]`.
10. **Recents.** Entry `i` of `list=` is stamped `observedAt = ini mtime - i seconds`. VLC stores
    no times, and the list is newest first, so this keeps the order. `times <= 0` gives
    position `null`. A known file (same host, same path, else same name, deleted or not) gets an
    observation only when `shouldRecord` says the position moved by more than 10 s since the
    file's last play. This also stops a notesd-launched play from being recorded twice: VLC
    writes the ini when that same VLC exits. A file that is gone and untracked is parsed (the
    path relative to its root, else `<parent>/<name>`), matched, created as a deleted
    `vlc_recents` file under the title (the title is fetched from TMDB first if missing), and
    observed. A file that is on disk but untracked is left to the scanner. Resolver failures
    (TMDB down) are retried next pass. Entries already handled are kept in a per-process memo,
    so the passes do not query TMDB again.
11. **Continue rule.** (a) Of the title's files, the most recently played one that is
    `in_progress` and present on this host (not deleted, on disk) is resumed. (b) For a film:
    if it is finished (title watched flag or any file finished), the answer is `nothing/finished`
    with when. Otherwise a present file is started, else `missing`. (c) For a series, the order
    comes from `movie_episodes` (season >= 1), or the files' own season/episode when that table
    is empty. The anchor is the episode of the newest play of the title, else the highest
    finished episode, else none. The first episode after the anchor that is not finished is
    started if present; otherwise it is `missing`, with the later present episodes. If there is
    no episode after the anchor, the answer is `nothing/caught_up`. Files with only an absolute
    number that Phase 3 could not map to season/episode take no part in (c), though they can
    still be resumed by (a). With no title, the title of this host's newest play is used. A
    query matching several titles takes the unique exact title, else the most recently played
    one, else answers `ambiguous` with candidates.

## Implementation Steps

### Step 1: Player environment and VLC launch
**File:** `src/movies/vlc/launch.ts` (new)
**Change:** Detection reuses `WSL_INTEROP_FILES`, `findOnPath`, `DetectProbe` and `spawnDetached`
from `src/http/reveal.ts` without changing them. It does not need `explorer.exe`, so it does not call `detectRevealEnv`.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findOnPath, nodeProbe, spawnDetached, WSL_INTEROP_FILES, type DetectProbe } from '../../http/reveal.js';

/** What a working playback needs: three binaries, resolved to runnable Linux paths. */
export interface PlayerEnv {
  /** vlc.exe (NOTESD_VLC_BIN). */
  vlc: string;
  /** The Windows curl.exe (NOTESD_CURL_EXE): VLC binds Windows loopback, which WSL NAT cannot reach. */
  curl: string;
  /** wslpath, for the Windows path of the file. */
  wslpath: string;
}

/** Why playback is off on this host. `no_free_port` and `launch_failed` come from a play attempt. */
export type PlayerUnavailableReason =
  | 'not_linux'
  | 'no_interop'
  | 'no_wslpath'
  | 'no_vlc'
  | 'no_curl'
  | 'no_free_port'
  | 'launch_failed';

/** Either a usable env or the reason there is none; never both. */
export type PlayerDetection =
  | { available: true; env: PlayerEnv }
  | { available: false; reason: PlayerUnavailableReason };

/** The two configured Windows binaries (`config.movies.vlc.bin` / `.curlExe`). */
export interface PlayerBinaries {
  bin: string;
  curlExe: string;
}

/** A path is taken as is (must be executable); a bare name is looked up on PATH. */
async function resolveBinary(value: string, probe: DetectProbe): Promise<string | null> {
  const v = value.trim();
  if (v === '') return null;
  if (v.includes('/')) return (await probe.executable(v)) ? v : null;
  return findOnPath(v, probe.env, probe.executable);
}

/** Linux + WSL interop + wslpath on PATH + vlc.exe + curl.exe, checked in that order. */
export async function detectPlayerEnv(bins: PlayerBinaries, probe: DetectProbe): Promise<PlayerDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const wslpath = await findOnPath('wslpath', probe.env, probe.executable);
  if (wslpath === null) return { available: false, reason: 'no_wslpath' };
  const vlc = await resolveBinary(bins.bin, probe);
  if (vlc === null) return { available: false, reason: 'no_vlc' };
  const curl = await resolveBinary(bins.curlExe, probe);
  if (curl === null) return { available: false, reason: 'no_curl' };
  return { available: true, env: { vlc, curl, wslpath } };
}

/** VLC's HTTP interface listens on Windows loopback only; never on the LAN. */
export const VLC_HTTP_HOST = '127.0.0.1';

export interface VlcLaunch {
  /** The file as Windows sees it (`wslpath -w`). */
  winPath: string;
  port: number;
  password: string;
  /** Seconds; floored, never negative. */
  startTime: number;
}

/**
 * vlc.exe's argv. A separate instance (never the owner's running VLC), no "Continue playback?"
 * question (`qt-continue` is 0 never / 1 ask / 2 always), no first-run privacy dialog, the HTTP
 * interface beside the normal Qt window, and the resume second. The file is the last argument.
 */
export function vlcArgs(l: VlcLaunch): string[] {
  return [
    '--no-one-instance',
    '--no-one-instance-when-started-from-file',
    '--qt-continue=0',
    '--no-qt-privacy-ask',
    '--extraintf',
    'http',
    '--http-host',
    VLC_HTTP_HOST,
    '--http-port',
    String(l.port),
    '--http-password',
    l.password,
    `--start-time=${Math.max(0, Math.floor(l.startTime))}`,
    l.winPath,
  ];
}

/** Starts VLC and returns once it has spawned. There is deliberately no stop: notesd never kills a VLC. */
export interface VlcLauncher {
  launch(env: PlayerEnv, l: VlcLaunch): Promise<void>;
}

/**
 * True when /proc/self/cgroup says this process is a systemd service (the last cgroup segment is a
 * `*.service` other than the user manager's `user@<uid>.service`), e.g. `.../app.slice/notesd.service`.
 * A shell in tmux (`...tmux-spawn-<id>.scope`) or a test runner is not.
 */
export function runningAsSystemdService(cgroupText: string): boolean {
  for (const line of cgroupText.split('\n')) {
    const path = line.split(':').slice(2).join(':').trim();
    if (path === '') continue;
    const last = path.split('/').pop() ?? '';
    if (last.endsWith('.service') && !/^user@\d+\.service$/.test(last)) return true;
  }
  return false;
}

/** `systemd-run` argv that starts VLC in its own transient user scope, outside the daemon's cgroup. */
export function scopeArgs(vlc: string, args: string[]): string[] {
  return ['--user', '--scope', '--quiet', '--collect', '--', vlc, ...args];
}

/**
 * The real launcher: detached, stdio ignored, unref'd. Under systemd (`scope` true; default: detected
 * from /proc/self/cgroup) VLC goes through `systemd-run --user --scope` so `systemctl --user restart
 * notesd` (KillMode=control-group) cannot kill it; without systemd-run it falls back to a plain
 * detached spawn.
 */
export function spawnVlcLauncher(opts: { scope?: boolean } = {}): VlcLauncher {
  let scoped: Promise<string | null> | null = null;
  const systemdRun = (): Promise<string | null> => {
    scoped ??= (async () => {
      const scope = opts.scope ?? runningAsSystemdService(await readFile('/proc/self/cgroup', 'utf8').catch(() => ''));
      if (!scope) return null;
      const probe = nodeProbe();
      return findOnPath('systemd-run', probe.env, (p) => probe.executable(p));
    })();
    return scoped;
  };
  return {
    async launch(env, l) {
      const run = await systemdRun();
      if (run !== null) return spawnDetached(run, scopeArgs(env.vlc, vlcArgs(l)));
      return spawnDetached(env.vlc, vlcArgs(l));
    },
  };
}

/** A fresh HTTP password per launch: 32 hex chars (no leading '-', no shell or URL quoting needed). */
export function newHttpPassword(): string {
  return randomBytes(16).toString('hex');
}
```
**Impact:** none on existing code. Unit-tested in Step 11.

### Step 2: VLC status reader over `curl.exe`
**File:** `src/movies/vlc/http.ts` (new)
**Code:**
```ts
import { execFile } from 'node:child_process';
import { VLC_HTTP_HOST } from './launch.js';

export type VlcState = 'playing' | 'paused' | 'stopped';

/** The three fields of `/requests/status.json` notesd uses. `time`/`length` are seconds. */
export interface VlcStatus {
  state: VlcState;
  time: number;
  length: number;
}

export interface VlcEndpoint {
  port: number;
  password: string;
}

/**
 * One read of VLC's HTTP interface. `gone`: nothing listens on the port (curl exit 7: VLC exited,
 * or not up yet). `unauthorized`: something answers, but not with our password.
 */
export type VlcReply =
  | { kind: 'ok'; status: VlcStatus }
  | { kind: 'gone' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

export type VlcCommand = { command: 'pl_play' } | { command: 'seek'; val: number };

export interface VlcStatusReader {
  status(curl: string, ep: VlcEndpoint): Promise<VlcReply>;
  command(curl: string, ep: VlcEndpoint, cmd: VlcCommand): Promise<VlcReply>;
}

/** curl: "Failed to connect to host" (MEASURED 2026-11-14: what curl.exe returns once VLC exits). */
export const CURL_EXIT_CONNECT_FAILED = 7;
/** curl's own `-m` limit, seconds. */
export const CURL_MAX_TIME_S = 2;
/** Node's limit on the curl process (curl.exe startup through interop included). */
export const CURL_EXEC_TIMEOUT_MS = 5000;

export interface ExecResult {
  /** The process exit code; -1 when it could not run or was killed by the timeout. */
  exitCode: number;
  stdout: string;
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** execFile that never rejects: the exit code is data here (7 means "VLC gone"). */
export const execCapture: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err === null) {
        resolve({ exitCode: 0, stdout });
        return;
      }
      const code = (err as { code?: unknown }).code;
      resolve({ exitCode: typeof code === 'number' ? code : -1, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });

export function statusUrl(ep: VlcEndpoint, cmd?: VlcCommand): string {
  const base = `http://${VLC_HTTP_HOST}:${ep.port}/requests/status.json`;
  if (cmd === undefined) return base;
  if (cmd.command === 'pl_play') return `${base}?command=pl_play`;
  return `${base}?command=seek&val=${Math.max(0, Math.floor(cmd.val))}`;
}

/** Silent, time-limited, HTTP status appended after a newline, Basic auth with an empty user. */
export function curlArgs(ep: VlcEndpoint, url: string): string[] {
  return ['-s', '-m', String(CURL_MAX_TIME_S), '-w', '\\n%{http_code}', '-u', `:${ep.password}`, url];
}

/** status.json -> VlcStatus; null when it is not VLC's shape. */
export function parseStatusJson(text: string): VlcStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const state = o.state;
  if (state !== 'playing' && state !== 'paused' && state !== 'stopped') return null;
  const seconds = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { state, time: seconds(o.time), length: seconds(o.length) };
}

/** curl's exit code and `<body>\n<http code>` output -> one VlcReply. */
export function interpretCurl(r: ExecResult): VlcReply {
  if (r.exitCode === CURL_EXIT_CONNECT_FAILED) return { kind: 'gone' };
  if (r.exitCode !== 0) return { kind: 'error', message: `curl exited ${r.exitCode}` };
  const cut = r.stdout.lastIndexOf('\n');
  const code = Number(r.stdout.slice(cut + 1).trim());
  const body = cut < 0 ? '' : r.stdout.slice(0, cut);
  if (code === 401) return { kind: 'unauthorized' };
  if (code !== 200) return { kind: 'error', message: `HTTP ${Number.isFinite(code) ? code : '?'}` };
  const status = parseStatusJson(body);
  return status === null ? { kind: 'error', message: 'unreadable status.json' } : { kind: 'ok', status };
}

/** The real reader: one curl.exe run per call (~70 ms measured on this host). */
export function curlStatusReader(exec: ExecFn = execCapture): VlcStatusReader {
  return {
    async status(curl, ep) {
      return interpretCurl(await exec(curl, curlArgs(ep, statusUrl(ep)), CURL_EXEC_TIMEOUT_MS));
    },
    async command(curl, ep, cmd) {
      return interpretCurl(await exec(curl, curlArgs(ep, statusUrl(ep, cmd)), CURL_EXEC_TIMEOUT_MS));
    },
  };
}
```
**Impact:** none on existing code.

### Step 3: `[RecentsMRL]` parser and sync hook
**File:** `src/movies/vlc/recents.ts` (new)
**Code:**
```ts
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { movieFiles, moviePlays } from '../../db/schema.js';
import type { MatchResult } from '../match.js';
import { isVideoFile, parseVideoPath } from '../parse.js';
import type { MoviesRepo } from '../repo.js';
import type { SyncHook, TitleResolver } from '../sync.js';
import { titleId } from '../types.js';

/** Phase 3's resolver (sync.ts), reused: one definition of name -> title. */
export type { TitleResolver };
type MatchOutcome = MatchResult;

/** One `[RecentsMRL]` entry. `path` is null for anything that is not a `file:///<drive>:/` URL. */
export interface RecentsEntry {
  url: string;
  path: string | null;
  /** Seconds; null when VLC stored 0 or -1 ("opened, position unknown"). */
  positionS: number | null;
}

/** key -> raw value of one `[section]` of a Qt ini file. */
export function iniSection(text: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inside = line.slice(1, -1) === section;
      continue;
    }
    if (!inside || line === '' || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/** A QSettings string list (`a, b, "c, d"`). `@Invalid()` and empty mean no items. Positions are kept. */
export function splitQtList(value: string): string[] {
  const v = value.trim();
  if (v === '' || v.startsWith('@Invalid(')) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === '\\' && quoted && i + 1 < v.length) {
      i += 1;
      cur += v[i]!;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `file:///C:/Users/a%20b/x.mkv` -> `/mnt/c/Users/a b/x.mkv`; anything else -> null. */
export function fileUrlToWslPath(url: string): string | null {
  const m = /^file:\/\/\/([A-Za-z]):\/(.*)$/.exec(url.trim());
  if (m === null) return null;
  let rest: string;
  try {
    rest = m[2]!.split('/').map((seg) => decodeURIComponent(seg)).join('/');
  } catch {
    return null;
  }
  return `/mnt/${m[1]!.toLowerCase()}/${rest}`;
}

/** `[RecentsMRL]` `list=` (newest first) zipped with `times=` (ms). */
export function parseRecents(iniText: string): RecentsEntry[] {
  const section = iniSection(iniText, 'RecentsMRL');
  const list = splitQtList(section.get('list') ?? '');
  const times = splitQtList(section.get('times') ?? '');
  return list.map((url, i) => {
    const ms = Number(times[i] ?? '');
    return { url, path: fileUrlToWslPath(url), positionS: Number.isFinite(ms) && ms > 0 ? ms / 1000 : null };
  });
}

/** What the parser sees: the path below its library root, else `<parent>/<name>` (year-in-folder still works). */
export function recentsRelPath(abs: string, roots: readonly string[]): string {
  for (const root of roots) {
    const rel = path.posix.relative(root, abs);
    if (rel !== '' && !rel.startsWith('..') && !path.posix.isAbsolute(rel)) return rel;
  }
  return path.posix.join(path.posix.basename(path.posix.dirname(abs)), path.posix.basename(abs));
}

/** Positions closer than this to the file's last play are the same observation (a live play VLC also wrote to the ini). */
export const RECENTS_SAME_POSITION_S = 10;

/** Record an entry only when it says something the file's last play does not. */
export function shouldRecord(last: { positionS: number | null } | null, positionS: number | null): boolean {
  if (last === null) return true;
  if (positionS === null) return false;
  if (last.positionS === null) return true;
  return Math.abs(last.positionS - positionS) > RECENTS_SAME_POSITION_S;
}

export type RecentsRepo = Pick<
  MoviesRepo,
  'findTrackedFile' | 'lastPlay' | 'recordObservation' | 'titleById' | 'upsertTitle' | 'upsertFile'
>;

export interface RecentsFs {
  readFile(p: string): Promise<string>;
  mtime(p: string): Promise<Date>;
  exists(p: string): Promise<boolean>;
}

export const nodeRecentsFs: RecentsFs = {
  readFile: (p) => readFile(p, 'utf8'),
  mtime: async (p) => (await stat(p)).mtime,
  async exists(p) {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
};

export interface RecentsHookDeps {
  /** `config.movies.vlc.ini`. */
  iniPath: string;
  /** `config.movies.roots`, for parsing a gone file's name relative to its root. */
  roots: readonly string[];
  host: string;
  repo: RecentsRepo;
  /** Null without TMDB credentials: gone files are then skipped (retried once credentials exist). */
  resolver: TitleResolver | null;
  fs?: RecentsFs;
  log?: (line: string) => void;
}

export interface RecentsReport {
  /** Play observations written. */
  observed: number;
  /** Deleted files created for entries whose file is gone. */
  created: number;
  /** Not files, already handled, same position, or on disk but untracked (the scanner's). */
  skipped: number;
  /** Gone files no title matched. */
  unmatched: number;
  /** Gone files left for the next pass (resolver failed or no credentials). */
  retry: number;
}

type FileRow = typeof movieFiles.$inferSelect;
type PlayRow = typeof moviePlays.$inferSelect;

/**
 * The passive layer: after each sync pass, VLC's `[RecentsMRL]` becomes play observations
 * (R4.4). Never throws into the pass: failures are logged and the entry is retried next pass.
 */
export function recentsSyncHook(deps: RecentsHookDeps): SyncHook & { run(): Promise<RecentsReport> } {
  const fs = deps.fs ?? nodeRecentsFs;
  const log = deps.log ?? ((line: string) => console.log(line));
  /** `<path>\0<position>` already recorded or decided in this process. */
  const handled = new Set<string>();

  async function observe(file: FileRow, last: PlayRow | null, positionS: number | null, durationS: number | null, observedAt: Date): Promise<boolean> {
    if (!shouldRecord(last, positionS)) return false;
    await deps.repo.recordObservation({ fileId: file.id, host: deps.host, positionS, durationS, observedAt });
    return true;
  }

  async function run(): Promise<RecentsReport> {
    const report: RecentsReport = { observed: 0, created: 0, skipped: 0, unmatched: 0, retry: 0 };
    let text: string;
    let mtime: Date;
    try {
      text = await fs.readFile(deps.iniPath);
      mtime = await fs.mtime(deps.iniPath);
    } catch {
      return report; // no ini yet: VLC has never exited on this host
    }
    const entries = parseRecents(text);
    for (const [i, entry] of entries.entries()) {
      if (entry.path === null) {
        report.skipped += 1;
        continue;
      }
      const key = `${entry.path}\u0000${entry.positionS ?? 'unknown'}`;
      if (handled.has(key)) {
        report.skipped += 1;
        continue;
      }
      const observedAt = new Date(mtime.getTime() - i * 1000);
      const name = path.posix.basename(entry.path);
      const known = await deps.repo.findTrackedFile(deps.host, entry.path, name);
      if (known !== null) {
        const last = await deps.repo.lastPlay(known.id);
        if (await observe(known, last, entry.positionS, known.durationS, observedAt)) report.observed += 1;
        else report.skipped += 1;
        handled.add(key);
        continue;
      }
      if (await fs.exists(entry.path)) {
        report.skipped += 1; // on disk but untracked: the scanner registers it (or it is outside the roots)
        continue;
      }
      if (!isVideoFile(name)) {
        handled.add(key);
        report.skipped += 1;
        continue;
      }
      if (deps.resolver === null) {
        report.retry += 1;
        continue;
      }
      const parsed = parseVideoPath(recentsRelPath(entry.path, deps.roots));
      let match: MatchOutcome;
      try {
        match = await deps.resolver.match(parsed);
      } catch (err) {
        log(`[movies] recents: matching ${name} failed, retrying next pass: ${err instanceof Error ? err.message : String(err)}`);
        report.retry += 1;
        continue;
      }
      if (match.kind === 'none') {
        handled.add(key);
        report.unmatched += 1;
        continue;
      }
      const id = titleId(match.tmdbKind, match.tmdbId);
      let title = await deps.repo.titleById(id);
      if (title === null) {
        try {
          await deps.repo.upsertTitle(await deps.resolver.details(match.tmdbKind, match.tmdbId));
        } catch (err) {
          log(`[movies] recents: fetching ${id} failed, retrying next pass: ${err instanceof Error ? err.message : String(err)}`);
          report.retry += 1;
          continue;
        }
        title = await deps.repo.titleById(id);
      }
      // A file only VLC's recents remember: created already deleted under its matched title (Phase 1's upsertFile).
      const { file } = await deps.repo.upsertFile({
        host: deps.host,
        path: entry.path,
        name,
        size: null,
        mtime: null,
        durationS: null,
        season: parsed.season,
        episode: parsed.episode,
        absoluteEpisode: parsed.absoluteEpisode,
        parsed,
        source: 'vlc_recents',
        classification: { status: 'matched', titleId: id },
        seenAt: observedAt,
        deletedAt: observedAt,
      });
      const durationS = match.tmdbKind === 'movie' && title !== null && title.runtimeMin !== null ? title.runtimeMin * 60 : null;
      await observe(file, null, entry.positionS, durationS, observedAt);
      report.created += 1;
      report.observed += 1;
      handled.add(key);
    }
    return report;
  }

  return {
    name: 'vlc-recents',
    run,
    /** Rows written (phase 3 emits `changed('sync')` when a pass's hooks wrote any). Never throws. */
    async afterScan() {
      try {
        const r = await run();
        if (r.observed > 0 || r.retry > 0) {
          log(`[movies] recents: ${r.observed} observation(s), ${r.created} deleted file(s) backfilled, ${r.retry} to retry`);
        }
        return r.observed + r.created;
      } catch (err) {
        log(`[movies] recents pass failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    },
  };
}
```
**Impact:** none until Step 5 registers it.

### Step 4: (moved to Phase 1)
Reconciled: `closeOpenPlays(host)` and `findTrackedFile(host, path, name)` are written by Phase 1 (its Step 5,
same code as this step had), and the gone-file insert uses Phase 1's `upsertFile` with `deletedAt`. This phase
does not edit `src/movies/repo.ts`, so it cannot collide with Phase 4 in the same wave. Nothing to do here.

### Step 5: `MoviePlayer` and `buildMoviePlayback`
**File:** `src/movies/player.ts` (new)
**Code:**
```ts
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { MoviesConfig } from '../config.js';
import type { movieFiles } from '../db/schema.js';
import { nodeProbe, onceAsync, runWslpath, type DetectProbe } from '../http/reveal.js';
import type { MoviesRepo } from './repo.js';
import type { MoviesService } from './service.js';
import { resumePosition } from './state.js';
import { curlStatusReader, type VlcEndpoint, type VlcState, type VlcStatus, type VlcStatusReader } from './vlc/http.js';
import {
  detectPlayerEnv,
  newHttpPassword,
  spawnVlcLauncher,
  type PlayerDetection,
  type PlayerEnv,
  type PlayerUnavailableReason,
  type VlcLauncher,
} from './vlc/launch.js';
import { tmdbResolver } from './sync.js';
import { nodeRecentsFs, recentsSyncHook, type RecentsFs } from './vlc/recents.js';

type FileRow = typeof movieFiles.$inferSelect;

/** Ports tried from `config.movies.vlc.httpPort`: P, P+1 .. P+9. */
export const PORT_CANDIDATES = 10;
/** How long VLC gets to bring its HTTP interface up after launch. */
export const READY_TIMEOUT_MS = 20_000;
export const READY_INTERVAL_MS = 500;
/** After pl_play: how long to wait for `playing` with a known length before seeking anyway. */
export const PLAYING_TIMEOUT_MS = 3_000;
/** VLC within this many seconds of the resume point needs no seek. */
export const SEEK_TOLERANCE_S = 5;
/** Consecutive unreadable polls (curl timeouts etc.) after which the play is ended. */
export const MAX_READ_ERRORS = 6;

export type PlayErrorCode = 'not_found' | 'not_on_this_machine' | 'player_unavailable' | 'file_missing';

export class PlayError extends Error {
  readonly code: PlayErrorCode;
  /** not_on_this_machine: the host that holds the file. */
  readonly host: string | null;
  /** player_unavailable: why. */
  readonly reason: PlayerUnavailableReason | null;

  constructor(code: PlayErrorCode, message: string, detail: { host?: string; reason?: PlayerUnavailableReason } = {}) {
    super(message);
    this.name = 'PlayError';
    this.code = code;
    this.host = detail.host ?? null;
    this.reason = detail.reason ?? null;
  }
}

const UNAVAILABLE_MESSAGE: Record<PlayerUnavailableReason, string> = {
  not_linux: 'Playback needs notesd running in WSL; this is not Linux.',
  no_interop: 'WSL interop is off, so notesd cannot start Windows programs.',
  no_wslpath: 'wslpath is not on PATH.',
  no_vlc: 'vlc.exe was not found (set NOTESD_VLC_BIN).',
  no_curl: 'The Windows curl.exe was not found (set NOTESD_CURL_EXE).',
  no_free_port: 'Every VLC HTTP port notesd may use is taken.',
  launch_failed: 'vlc.exe could not be started.',
};

export type PlayerRepo = Pick<MoviesRepo, 'fileById' | 'lastPlay' | 'startPlay' | 'updatePlay' | 'endPlay' | 'closeOpenPlays'>;

export interface MoviePlayerDeps {
  repo: PlayerRepo;
  /** This machine (`MoviesService.host`). */
  host: string;
  /** `config.movies.vlc.httpPort`: the first port tried. */
  httpPort: number;
  /** `config.movies.vlc.pollMs`. */
  pollMs: number;
  /** Cached detection (buildMoviePlayback wraps detectPlayerEnv in onceAsync). */
  detect: () => Promise<PlayerDetection>;
  launcher: VlcLauncher;
  reader: VlcStatusReader;
  /** Linux path -> Windows path. Default: `wslpath -w`. */
  wslpath?: (wslpathBin: string, abs: string) => Promise<string>;
  /** Default: fs.access. */
  exists?: (abs: string) => Promise<boolean>;
  /** Default: newHttpPassword. */
  password?: () => string;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  playingTimeoutMs?: number;
  /** Called when a play starts or ends, never per poll (buildMoviePlayback emits MovieEvents `changed('play')`). */
  onChange?: (file: FileRow) => void;
  log?: (line: string) => void;
}

/** POST /api/movies/files/:fileId/play -> 202 { ok: true, play }. */
export interface PlayStarted {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;
  start_position: number;
  port: number;
  tracking: boolean;
  note: 'http_timeout' | null;
}

/** GET /api/movies/player -> current. */
export interface PlayerSnapshot {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;
  port: number;
  state: VlcState;
  position: number;
  duration: number | null;
  started_at: string;
  last_read_at: string | null;
}

export interface PlayerAvailability {
  available: boolean;
  reason: PlayerUnavailableReason | null;
}

type EndWhy = 'exited' | 'unreachable' | 'replaced' | 'shutdown';

interface Tracked {
  playId: number;
  file: FileRow;
  env: PlayerEnv;
  ep: VlcEndpoint;
  startedAt: Date;
  state: VlcState;
  position: number;
  duration: number | null;
  lastReadAt: Date | null;
  errors: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  ended: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays movie files in the Windows VLC and tracks one play at a time (R4.1-R4.3). It never stops,
 * kills or reuses a VLC: a new play ends the tracking of the previous one and leaves that VLC open.
 */
export class MoviePlayer {
  readonly host: string;
  private tracked: Tracked | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: MoviePlayerDeps) {
    this.host = deps.host;
  }

  async availability(): Promise<PlayerAvailability> {
    const d = await this.deps.detect();
    return d.available ? { available: true, reason: null } : { available: false, reason: d.reason };
  }

  /** Daemon start, before listening: close the plays a previous process left open. Returns how many. */
  async start(): Promise<number> {
    return this.deps.repo.closeOpenPlays(this.host);
  }

  /** Plays are serialized so two clicks never race for a port or the tracked slot. */
  play(fileId: number): Promise<PlayStarted> {
    const run = this.queue.then(() => this.playNow(fileId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  current(): PlayerSnapshot | null {
    const t = this.tracked;
    if (t === null) return null;
    return {
      play_id: t.playId,
      file_id: t.file.id,
      title_id: t.file.titleId,
      name: t.file.name,
      port: t.ep.port,
      state: t.state,
      position: t.position,
      duration: t.duration,
      started_at: t.startedAt.toISOString(),
      last_read_at: t.lastReadAt === null ? null : t.lastReadAt.toISOString(),
    };
  }

  /** Daemon stop: finish a play in progress, then end the tracked play at its last position. VLC stays open. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    const t = this.tracked;
    if (t !== null) await this.finish(t, 'shutdown');
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  private async playNow(fileId: number): Promise<PlayStarted> {
    if (this.closed) throw new PlayError('player_unavailable', 'notesd is shutting down.', { reason: 'launch_failed' });
    const repo = this.deps.repo;
    const file = await repo.fileById(fileId);
    if (file === null) throw new PlayError('not_found', `No movie file ${fileId}.`);
    if (file.host !== this.host) {
      throw new PlayError('not_on_this_machine', `${file.name} is on ${file.host}; play it there.`, { host: file.host });
    }
    if (file.deletedAt !== null || !(await (this.deps.exists ?? pathExists)(file.path))) {
      throw new PlayError('file_missing', `${file.name} is no longer on disk.`);
    }
    const detection = await this.deps.detect();
    if (!detection.available) {
      throw new PlayError('player_unavailable', UNAVAILABLE_MESSAGE[detection.reason], { reason: detection.reason });
    }
    const env = detection.env;
    const start = resumePosition(file, await repo.lastPlay(file.id));
    let winPath: string;
    try {
      winPath = await (this.deps.wslpath ?? runWslpath)(env.wslpath, file.path);
    } catch (err) {
      throw new PlayError('player_unavailable', `wslpath failed: ${message(err)}`, { reason: 'launch_failed' });
    }

    if (this.tracked !== null) await this.finish(this.tracked, 'replaced');

    const password = (this.deps.password ?? newHttpPassword)();
    const port = await this.freePort(env, password);
    if (port === null) {
      const last = this.deps.httpPort + PORT_CANDIDATES - 1;
      throw new PlayError('player_unavailable', `VLC HTTP ports ${this.deps.httpPort}-${last} are all in use.`, { reason: 'no_free_port' });
    }
    try {
      await this.deps.launcher.launch(env, { winPath, port, password, startTime: start });
    } catch (err) {
      throw new PlayError('player_unavailable', `vlc.exe did not start: ${message(err)}`, { reason: 'launch_failed' });
    }

    const play = await repo.startPlay({ fileId: file.id, host: this.host, source: 'live', startedAt: new Date(), startPositionS: start, durationS: file.durationS });
    this.deps.onChange?.(file);
    const ep: VlcEndpoint = { port, password };
    const base = { play_id: play.id, file_id: file.id, title_id: file.titleId, name: file.name, start_position: start, port };

    const ready = await this.waitReady(env, ep);
    if (ready === null) {
      await repo.endPlay(play.id, { positionS: start, durationS: file.durationS }, new Date());
      this.deps.onChange?.(file);
      this.log(`[movies] VLC on port ${port} never answered; play ${play.id} (${file.name}) kept at ${start} s without tracking`);
      return { ...base, tracking: false, note: 'http_timeout' };
    }
    const status = await this.ensurePlaying(env, ep, ready, start);
    const t: Tracked = {
      playId: play.id,
      file,
      env,
      ep,
      startedAt: play.startedAt,
      state: status.state,
      position: start,
      duration: status.length > 0 ? status.length : file.durationS,
      lastReadAt: null,
      errors: 0,
      timer: null,
      inFlight: null,
      ended: false,
    };
    this.tracked = t;
    if (this.closed) await this.finish(t, 'shutdown');
    else this.schedule(t);
    return { ...base, tracking: true, note: null };
  }

  /** A port is free only when nothing answers on it; any answer (401 included) means taken. */
  private async freePort(env: PlayerEnv, password: string): Promise<number | null> {
    for (let i = 0; i < PORT_CANDIDATES; i++) {
      const port = this.deps.httpPort + i;
      const r = await this.deps.reader.status(env.curl, { port, password });
      if (r.kind === 'gone') return port;
    }
    return null;
  }

  private async waitReady(env: PlayerEnv, ep: VlcEndpoint): Promise<VlcStatus | null> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      const r = await this.deps.reader.status(env.curl, ep);
      if (r.kind === 'ok') return r.status;
      if (r.kind === 'unauthorized') return null; // someone else took the port between the probe and the launch
      if (Date.now() >= deadline) return null;
      await delay(this.deps.readyIntervalMs ?? READY_INTERVAL_MS);
    }
  }

  /** Make sure VLC plays (pl_play when it does not), then seek to the resume point when it is off by more than the tolerance. */
  private async ensurePlaying(env: PlayerEnv, ep: VlcEndpoint, first: VlcStatus, start: number): Promise<VlcStatus> {
    let status = first;
    const interval = this.deps.readyIntervalMs ?? READY_INTERVAL_MS;
    if (status.state !== 'playing') {
      const r = await this.deps.reader.command(env.curl, ep, { command: 'pl_play' });
      if (r.kind === 'ok') status = r.status;
    }
    const deadline = Date.now() + (this.deps.playingTimeoutMs ?? PLAYING_TIMEOUT_MS);
    while (!(status.state === 'playing' && status.length > 0) && Date.now() < deadline) {
      await delay(interval);
      const r = await this.deps.reader.status(env.curl, ep);
      if (r.kind === 'ok') status = r.status;
      else if (r.kind !== 'error') break;
    }
    if (start > 0 && Math.abs(status.time - start) > SEEK_TOLERANCE_S) {
      const r = await this.deps.reader.command(env.curl, ep, { command: 'seek', val: start });
      if (r.kind === 'ok') status = r.status;
    }
    return status;
  }

  private schedule(t: Tracked): void {
    t.timer = setTimeout(() => {
      t.timer = null;
      t.inFlight = this.tick(t)
        .catch((err: unknown) => this.log(`[movies] poll of play ${t.playId} failed: ${message(err)}`))
        .finally(() => {
          t.inFlight = null;
          if (!t.ended) this.schedule(t);
        });
    }, this.deps.pollMs);
    t.timer.unref();
  }

  private async tick(t: Tracked): Promise<void> {
    if (t.ended) return;
    const r = await this.deps.reader.status(t.env.curl, t.ep);
    if (t.ended) return;
    switch (r.kind) {
      case 'ok': {
        t.errors = 0;
        t.state = r.status.state;
        // Stopped (user pressed stop, or the media ended) reads time 0 / length 0: keep the last real position.
        if (r.status.state === 'stopped') return;
        t.position = r.status.time;
        if (r.status.length > 0) t.duration = r.status.length;
        t.lastReadAt = new Date();
        await this.deps.repo.updatePlay(t.playId, { positionS: t.position, durationS: t.duration });
        return;
      }
      case 'gone':
      case 'unauthorized':
        await this.finish(t, 'exited', true);
        return;
      case 'error':
        t.errors += 1;
        if (t.errors >= MAX_READ_ERRORS) await this.finish(t, 'unreachable', true);
        return;
    }
  }

  /** Ends tracking once: stop polling, then close the play row at the last position read. */
  private async finish(t: Tracked, why: EndWhy, fromTick = false): Promise<void> {
    if (t.ended) return;
    t.ended = true;
    if (t.timer !== null) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (this.tracked === t) this.tracked = null;
    if (!fromTick && t.inFlight !== null) await t.inFlight;
    await this.deps.repo.endPlay(t.playId, { positionS: t.position, durationS: t.duration }, new Date());
    this.deps.onChange?.(t.file);
    this.log(`[movies] play ${t.playId} (${t.file.name}) ended at ${Math.round(t.position)} s: ${why}`);
  }
}

/** The parts of MoviesService playback hangs off (Phase 3). */
export type PlaybackService = Pick<MoviesService, 'repo' | 'host' | 'tmdb' | 'events' | 'addSyncHook'>;

/** Seams for tests; the daemon passes none. */
export interface PlaybackOverrides {
  probe?: DetectProbe;
  launcher?: VlcLauncher;
  reader?: VlcStatusReader;
  wslpath?: (wslpathBin: string, abs: string) => Promise<string>;
  recentsFs?: RecentsFs;
}

/**
 * The player for `deps.moviesPlayer`, and the `[RecentsMRL]` sync hook on the service when
 * `config.vlc.ini` is set. Builds nothing that runs: no detection, no process, until a play.
 */
export function buildMoviePlayback(service: PlaybackService, config: MoviesConfig, overrides: PlaybackOverrides = {}): MoviePlayer {
  const probe = overrides.probe ?? nodeProbe();
  const detect = onceAsync(() => detectPlayerEnv({ bin: config.vlc.bin, curlExe: config.vlc.curlExe }, probe));
  const player = new MoviePlayer({
    repo: service.repo,
    host: service.host,
    httpPort: config.vlc.httpPort,
    pollMs: config.vlc.pollMs,
    detect,
    launcher: overrides.launcher ?? spawnVlcLauncher(),
    reader: overrides.reader ?? curlStatusReader(),
    ...(overrides.wslpath !== undefined ? { wslpath: overrides.wslpath } : {}),
    // Play start and end only: the web reloads its whole list on every `changed`.
    onChange: (file) => service.events.changed('play', { fileIds: [file.id], titleIds: file.titleId === null ? [] : [file.titleId] }),
  });
  if (config.vlc.ini !== null) {
    service.addSyncHook(
      recentsSyncHook({
        iniPath: config.vlc.ini,
        roots: config.roots,
        host: service.host,
        repo: service.repo,
        resolver: service.tmdb === null ? null : tmdbResolver(service.tmdb, null),
        fs: overrides.recentsFs ?? nodeRecentsFs,
      }),
    );
  }
  return player;
}
```
**Impact:** none until Step 9 wires it.

### Step 6: Continue
**File:** `src/movies/continue.ts` (new)
**Code:**
```ts
import { access } from 'node:fs/promises';
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieEpisodes, movieFiles, moviePlays, movieTitles } from '../db/schema.js';
import type { MoviePlayer, PlayStarted } from './player.js';
import { fileState } from './state.js';
import type { TitleKind, WatchState } from './types.js';

type FileRow = typeof movieFiles.$inferSelect;
type PlayRow = typeof moviePlays.$inferSelect;
type TitleRow = typeof movieTitles.$inferSelect;

export interface ContinueDeps {
  db: Db;
  player: Pick<MoviePlayer, 'host' | 'play'>;
  /** Default: fs.access. A file counts as present only when it is really on disk. */
  exists?: (abs: string) => Promise<boolean>;
}

export interface ContinueTitleRef {
  id: string;
  title: string;
  kind: TitleKind;
  year: number | null;
}

export interface ContinueEpisodeRef {
  file_id: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  name: string | null;
}

export type NothingReason = 'finished' | 'caught_up' | 'no_episodes';

export type ContinueResult =
  | { action: 'resumed' | 'started'; title: ContinueTitleRef; file: ContinueEpisodeRef; position: number; play: PlayStarted }
  | { action: 'missing'; title: ContinueTitleRef; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; title: ContinueTitleRef; reason: NothingReason; finished_at: string | null; last: ContinueEpisodeRef | null }
  | { action: 'ambiguous'; query: string; candidates: ContinueTitleRef[] }
  | { action: 'no_match'; query: string | null };

/** One file of the title with what continue needs to decide. */
export interface ContinueFileView {
  file: FileRow;
  last: PlayRow | null;
  state: WatchState;
  /** On this host, not deleted, on disk. */
  present: boolean;
}

/** One expected episode (from movie_episodes, season >= 1). */
export interface EpisodeSlot {
  season: number;
  episode: number;
  name: string | null;
}

export type ContinueDecision =
  | { action: 'resume' | 'start'; file: FileRow }
  | { action: 'missing'; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; reason: NothingReason; finishedAt: Date | null; last: ContinueEpisodeRef | null };

/** Titles a query may match before it is "ambiguous". */
const MAX_CANDIDATES = 10;

const NO_EPISODE: ContinueEpisodeRef = { file_id: null, season: null, episode: null, absolute_episode: null, name: null };

function playedAt(v: ContinueFileView): number {
  return v.last === null ? Number.NEGATIVE_INFINITY : v.last.startedAt.getTime();
}

function newestFirst(a: ContinueFileView, b: ContinueFileView): number {
  return playedAt(b) - playedAt(a);
}

function slotOrder(a: { season: number; episode: number }, b: { season: number; episode: number }): number {
  return a.season - b.season || a.episode - b.episode;
}

function fileRef(file: FileRow, name: string | null): ContinueEpisodeRef {
  return { file_id: file.id, season: file.season, episode: file.episode, absolute_episode: file.absoluteEpisode, name };
}

/** The latest of: title flag, file flags, done signals, end of the last finishing play. */
function finishedAt(titleWatchedAt: Date | null, finished: ContinueFileView[]): Date | null {
  const times: number[] = [];
  if (titleWatchedAt !== null) times.push(titleWatchedAt.getTime());
  for (const v of finished) {
    for (const d of [v.file.watchedAt, v.file.doneAt, v.last?.endedAt ?? null]) if (d !== null) times.push(d.getTime());
  }
  return times.length === 0 ? null : new Date(Math.max(...times));
}

/**
 * The continue rule (R6.1), on loaded data, with no I/O. (a) resume the most recently played
 * present in-progress file; (b) a film: finished -> nothing, a present file -> start, else
 * missing; (c) a series: the first unfinished episode after the newest play (else after the
 * highest finished episode, else the first) -> start when present, else missing with the later
 * present episodes; none left -> caught_up.
 */
export function decideContinue(
  kind: TitleKind,
  titleWatchedAt: Date | null,
  files: ContinueFileView[],
  episodes: EpisodeSlot[],
): ContinueDecision {
  const resumable = files.filter((v) => v.present && v.state === 'in_progress').sort(newestFirst);
  if (resumable[0] !== undefined) return { action: 'resume', file: resumable[0].file };

  if (kind === 'movie') {
    const finished = files.filter((v) => v.state === 'finished');
    if (titleWatchedAt !== null || finished.length > 0) {
      return { action: 'nothing', reason: 'finished', finishedAt: finishedAt(titleWatchedAt, finished), last: null };
    }
    const present = files.find((v) => v.present);
    if (present !== undefined) return { action: 'start', file: present.file };
    return { action: 'missing', missing: NO_EPISODE, present: [] };
  }

  const placed = files.filter((v) => v.file.season !== null && v.file.episode !== null);
  const slotOf = (v: ContinueFileView): { season: number; episode: number } => ({ season: v.file.season!, episode: v.file.episode! });
  let seq: EpisodeSlot[] = episodes;
  if (seq.length === 0) {
    const seen = new Map<string, EpisodeSlot>();
    for (const v of placed) seen.set(`${v.file.season}x${v.file.episode}`, { ...slotOf(v), name: null });
    seq = [...seen.values()].sort(slotOrder);
  }
  if (seq.length === 0) return { action: 'nothing', reason: 'no_episodes', finishedAt: null, last: null };

  const filesAt = (s: EpisodeSlot): ContinueFileView[] =>
    placed.filter((v) => v.file.season === s.season && v.file.episode === s.episode);
  const nameOf = (v: ContinueFileView): string | null =>
    seq.find((s) => s.season === v.file.season && s.episode === v.file.episode)?.name ?? null;

  const played = placed.filter((v) => v.last !== null).sort(newestFirst)[0];
  const highestFinished = placed
    .filter((v) => v.state === 'finished')
    .sort((a, b) => slotOrder(slotOf(b), slotOf(a)))[0];
  const anchor = played ?? highestFinished ?? null;
  const after = anchor === null ? seq : seq.filter((s) => slotOrder(s, slotOf(anchor)) > 0);
  const next = after.find((s) => !filesAt(s).some((v) => v.state === 'finished'));

  if (next === undefined) {
    const finished = placed.filter((v) => v.state === 'finished');
    return {
      action: 'nothing',
      reason: 'caught_up',
      finishedAt: finishedAt(null, finished),
      last: anchor === null ? null : fileRef(anchor.file, nameOf(anchor)),
    };
  }
  const here = filesAt(next).find((v) => v.present);
  if (here !== undefined) return { action: 'start', file: here.file };
  const later = seq.slice(seq.indexOf(next) + 1).flatMap((s) => {
    const v = filesAt(s).find((x) => x.present);
    return v === undefined ? [] : [fileRef(v.file, s.name)];
  });
  return {
    action: 'missing',
    missing: { file_id: null, season: next.season, episode: next.episode, absolute_episode: null, name: next.name },
    present: later,
  };
}

function titleRef(t: TitleRow): ContinueTitleRef {
  return { id: t.id, title: t.title, kind: t.kind as TitleKind, year: t.year };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

type Resolved = { kind: 'one'; title: TitleRow } | { kind: 'none' } | { kind: 'ambiguous'; candidates: TitleRow[] };

/** A title id (`tv-247718`, what the web sends), or a case-insensitive substring of the title/original title. */
async function resolveTitle(db: Db, q: string): Promise<Resolved> {
  const lower = q.toLowerCase();
  const pattern = `%${escapeLike(q)}%`;
  const rows = await db
    .select()
    .from(movieTitles)
    .where(or(eq(movieTitles.id, lower), ilike(movieTitles.title, pattern), ilike(movieTitles.originalTitle, pattern)))
    .orderBy(asc(movieTitles.title))
    .limit(MAX_CANDIDATES);
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', title: rows[0]! };
  const exact = rows.filter((r) => r.id === lower || r.title.toLowerCase() === lower);
  if (exact.length === 1) return { kind: 'one', title: exact[0]! };
  const recent = await db
    .select({ titleId: movieFiles.titleId })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .where(inArray(movieFiles.titleId, rows.map((r) => r.id)))
    .groupBy(movieFiles.titleId)
    .orderBy(desc(sql`max(${moviePlays.startedAt})`))
    .limit(1);
  const top = rows.find((r) => r.id === recent[0]?.titleId);
  return top !== undefined ? { kind: 'one', title: top } : { kind: 'ambiguous', candidates: rows };
}

/** R6.2: the title of this host's newest play event. */
async function newestPlayedTitle(db: Db, host: string): Promise<TitleRow | null> {
  const rows = await db
    .select({ title: movieTitles })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .innerJoin(movieTitles, eq(movieTitles.id, movieFiles.titleId))
    .where(eq(moviePlays.host, host))
    .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
    .limit(1);
  return rows[0]?.title ?? null;
}

async function loadFiles(deps: ContinueDeps, titleIdValue: string): Promise<ContinueFileView[]> {
  const files = await deps.db.select().from(movieFiles).where(eq(movieFiles.titleId, titleIdValue));
  if (files.length === 0) return [];
  const lasts = await deps.db
    .selectDistinctOn([moviePlays.fileId])
    .from(moviePlays)
    .where(inArray(moviePlays.fileId, files.map((f) => f.id)))
    // MoviesRepo.lastPlay's order: a play with a known position first, then the newest.
    .orderBy(moviePlays.fileId, sql`(${moviePlays.positionS} is not null) desc`, desc(moviePlays.startedAt), desc(moviePlays.id));
  const lastBy = new Map(lasts.map((p) => [p.fileId, p]));
  const exists = deps.exists ?? pathExists;
  const host = deps.player.host;
  return Promise.all(
    files.map(async (file) => {
      const last = lastBy.get(file.id) ?? null;
      const present = file.host === host && file.deletedAt === null && (await exists(file.path));
      return { file, last, state: fileState(file, last), present };
    }),
  );
}

async function loadEpisodes(db: Db, titleIdValue: string): Promise<EpisodeSlot[]> {
  return db
    .select({ season: movieEpisodes.season, episode: movieEpisodes.episode, name: movieEpisodes.name })
    .from(movieEpisodes)
    .where(and(eq(movieEpisodes.titleId, titleIdValue), gte(movieEpisodes.season, 1)))
    .orderBy(asc(movieEpisodes.season), asc(movieEpisodes.episode));
}

/**
 * "continue <title>" / "continue" (R6.1, R6.2). Plays through the player when the decision is to
 * resume or start; a PlayError from the player propagates to the caller.
 */
export async function continueTitle(deps: ContinueDeps, titleQuery: string | null): Promise<ContinueResult> {
  const q = titleQuery?.trim() ?? '';
  let title: TitleRow;
  if (q === '') {
    const newest = await newestPlayedTitle(deps.db, deps.player.host);
    if (newest === null) return { action: 'no_match', query: null };
    title = newest;
  } else {
    const resolved = await resolveTitle(deps.db, q);
    if (resolved.kind === 'none') return { action: 'no_match', query: q };
    if (resolved.kind === 'ambiguous') return { action: 'ambiguous', query: q, candidates: resolved.candidates.map(titleRef) };
    title = resolved.title;
  }
  const kind = title.kind as TitleKind;
  const views = await loadFiles(deps, title.id);
  const episodes = kind === 'tv' ? await loadEpisodes(deps.db, title.id) : [];
  const decision = decideContinue(kind, title.watchedAt, views, episodes);
  const ref = titleRef(title);
  switch (decision.action) {
    case 'resume':
    case 'start': {
      const play = await deps.player.play(decision.file.id);
      const name = episodes.find((e) => e.season === decision.file.season && e.episode === decision.file.episode)?.name ?? null;
      return {
        action: decision.action === 'resume' ? 'resumed' : 'started',
        title: ref,
        file: fileRef(decision.file, name),
        position: play.start_position,
        play,
      };
    }
    case 'missing':
      return { action: 'missing', title: ref, missing: decision.missing, present: decision.present };
    case 'nothing':
      return {
        action: 'nothing',
        title: ref,
        reason: decision.reason,
        finished_at: decision.finishedAt === null ? null : decision.finishedAt.toISOString(),
        last: decision.last,
      };
  }
}
```
**Impact:** Phase 7's `movies_continue` calls `continueTitle({ db, player: deps.moviesPlayer }, title ?? null)`.

### Step 7: The play router
**File:** `src/http/moviesPlayApi.ts`. Replace Phase 1's whole file (an empty router that
exports `moviesPlayRoutes`). Keep the export name; `src/http/app.ts` already mounts it.
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { continueTitle } from '../movies/continue.js';
import { PlayError } from '../movies/player.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Movies phase 5: play a file in the Windows VLC, "continue <title>", and the player's state.
 * The two POSTs spawn a process, so they are same-origin only (invariant 7). Inputs are validated
 * here once; the player and continueTitle trust them.
 */

const fileIdParam = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number);
const continueBody = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'Movies are off on this machine (NOTESD_MOVIES=off).',
} as const;

/** PlayError -> its HTTP answer; anything else is rethrown (500). */
export function playErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof PlayError)) throw err;
  switch (err.code) {
    case 'not_found':
      return c.json({ error: 'not_found', message: err.message }, 404);
    case 'not_on_this_machine':
      return c.json({ error: 'not_on_this_machine', host: err.host, message: err.message }, 404);
    case 'file_missing':
      return c.json({ error: 'file_missing', message: err.message }, 410);
    case 'player_unavailable':
      return c.json({ error: 'player_unavailable', reason: err.reason, message: err.message }, 409);
  }
}

export function moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer'>): Hono {
  const r = new Hono();

  r.get('/api/movies/player', async (c) => {
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json({ available: false, reason: 'movies_off', current: null });
    const a = await player.availability();
    return c.json({ available: a.available, reason: a.reason, current: player.current() });
  });

  r.post('/api/movies/files/:fileId/play', sameOriginOnly, async (c) => {
    const id = fileIdParam.safeParse(c.req.param('fileId'));
    if (!id.success) return c.json({ error: 'invalid_id' }, 400);
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json(MOVIES_OFF, 503);
    try {
      return c.json({ ok: true, play: await player.play(id.data) }, 202);
    } catch (err) {
      return playErrorResponse(c, err);
    }
  });

  r.post('/api/movies/continue', sameOriginOnly, async (c) => {
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_body', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = continueBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') }, 400);
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json(MOVIES_OFF, 503);
    try {
      return c.json(await continueTitle({ db: deps.db, player }, body.data.title ?? null));
    } catch (err) {
      return playErrorResponse(c, err);
    }
  });

  return r;
}
```
**Impact:** the three routes answer. `moviesPlayRoutes(deps)` in `app.ts` still type-checks,
because `AppDeps` satisfies the `Pick`.

### Step 8: `movies_playback` in `/api/capabilities`
**File:** `src/http/reveal.ts:282-295` (the doc comment above `revealRoutes` and the capabilities handler)
**Change:** the handler also asks the player. Reveal detection and every reveal route stay as they are.
**Code:** replace the first doc line `* GET /api/capabilities -> { reveal }.` with
```ts
 * GET /api/capabilities -> { reveal, movies_playback } (movies_playback: deps.moviesPlayer can play on this host).
```
and replace line 295
```ts
  r.get('/api/capabilities', async (c) => c.json({ reveal: (await reveal.detect()) !== null }));
```
with
```ts
  r.get('/api/capabilities', async (c) => {
    const player = deps.moviesPlayer ?? null;
    const [revealEnv, playback] = await Promise.all([reveal.detect(), player === null ? null : player.availability()]);
    return c.json({ reveal: revealEnv !== null, movies_playback: playback?.available ?? false });
  });
```
**File:** `tests/integration/reveal.int.test.ts:56-62`. The test asserts the exact key list. Replace that `it` with:
```ts
    it('GET /api/capabilities answers { reveal: boolean, movies_playback: boolean }', async () => {
      const res = await h.app.request('/api/capabilities');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reveal: unknown; movies_playback: unknown };
      expect(Object.keys(body)).toEqual(['reveal', 'movies_playback']);
      expect(typeof body.reveal).toBe('boolean');
      expect(body.movies_playback).toBe(false); // the harness has no movies player
    });
```
**Impact:** the web's `fetchCapabilities` ignores the new key until Phase 6 reads it.

### Step 9: Wire the player into `AppDeps` and the daemon
**File:** `src/deps.ts:24`, after the `adversary` member. Add the import at the top:
```ts
import type { MoviePlayer } from './movies/player.js';
```
and the member:
```ts
  /**
   * VLC playback (movies phase 5). The daemon builds it next to `movies`; null or absent when
   * `movies` is null. Read by moviesPlayRoutes, /api/capabilities and (phase 7) movies_continue.
   */
  moviesPlayer?: MoviePlayer | null;
```
**File:** `src/daemon.ts`. All three edits sit next to code Phase 3 adds.
1. Import: `import { buildMoviePlayback, type MoviePlayer } from './movies/player.js';`
2. Directly after the statement where Phase 3 assigns `movies` (the `buildMoviesService(...)`
   result, before `const deps: AppDeps = {`):
```ts
  // Movies phase 5: VLC playback and the [RecentsMRL] hook hang off the movies service.
  const moviesPlayer: MoviePlayer | null = movies === null ? null : buildMoviePlayback(movies, config.movies);
  if (moviesPlayer !== null) {
    try {
      const closed = await moviesPlayer.start();
      if (closed > 0) console.log(`[notesd] movies: closed ${closed} play(s) left open by the previous run at their last position`);
    } catch (err) {
      console.error(`[notesd] movies: could not close stale plays: ${err instanceof Error ? err.message : String(err)}`);
    }
    const playback = await moviesPlayer.availability();
    console.log(
      playback.available
        ? `[notesd] movies: playback via ${config.movies.vlc.bin} on ports ${config.movies.vlc.httpPort}+`
        : `[notesd] movies: playback off (${playback.reason})`,
    );
  }
```
3. In the `const deps: AppDeps = { ... }` literal, add `moviesPlayer,` right after `movies,`.
4. In `stop`, between `agent?.close();` and `await stopBackground();`:
```ts
      // Ends the tracked play at its last read position while the DB is still open; VLC stays open.
      await moviesPlayer?.close();
```
**Impact:** with `NOTESD_MOVIES=off` (and `DEFAULT_MOVIES_CONFIG` in tests) `movies` is null, so no
player is built and nothing is spawned (invariant 5).

### Step 10: Test fixtures
**File:** `tests/fixtures/movies/fake-vlc.mjs` (new). Tests start it through a generated
`#!/bin/sh` wrapper, so its git mode does not matter.
**Code:**
```js
#!/usr/bin/env node
// A fake vlc.exe for tests and verify runs: only VLC's HTTP status interface, on the port and
// password from argv, with Basic auth (empty user) like VLC 3. It does NOT honor --start-time
// unless FAKE_VLC_HONOR_START_TIME=1 and starts `stopped` unless FAKE_VLC_AUTOPLAY=1, which is
// what the 2026-11-14 probe saw from the real one; notesd must pl_play and seek itself.
//
// Env: FAKE_VLC_LOG (append one JSON line {pid, argv} per launch), FAKE_VLC_LENGTH (s, 7200),
// FAKE_VLC_SPEED (media seconds per wall second, 1), FAKE_VLC_HTTP_DELAY_MS (200),
// FAKE_VLC_NO_HTTP=1 (never listen), FAKE_VLC_LIFE_MS (exit after, 120000).
// GET /fake/quit (no auth) makes it exit, as closing the VLC window would.
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const env = process.env;
const port = Number(opt('--http-port'));
const password = opt('--http-password') ?? '';
const host = opt('--http-host') ?? '127.0.0.1';
const startArg = argv.find((a) => a.startsWith('--start-time='));
const startTime = startArg ? Number(startArg.slice('--start-time='.length)) : 0;
const file = argv[argv.length - 1] ?? '';
const LENGTH = Number(env.FAKE_VLC_LENGTH ?? 7200);
const SPEED = Number(env.FAKE_VLC_SPEED ?? 1);

if (env.FAKE_VLC_LOG) appendFileSync(env.FAKE_VLC_LOG, JSON.stringify({ pid: process.pid, argv }) + '\n');

let state = env.FAKE_VLC_AUTOPLAY === '1' ? 'playing' : 'stopped';
let loaded = state === 'playing';
let base = env.FAKE_VLC_HONOR_START_TIME === '1' ? startTime : 0;
let since = Date.now();

function now() {
  if (state !== 'playing') return base;
  const t = base + ((Date.now() - since) / 1000) * SPEED;
  if (t >= LENGTH) {
    state = 'stopped';
    loaded = false;
    base = 0;
    return 0;
  }
  return t;
}

function setTime(t) {
  base = Math.max(0, Math.min(LENGTH, t));
  since = Date.now();
}

function status() {
  const time = now();
  return {
    state,
    time: Math.floor(time),
    length: loaded ? LENGTH : 0,
    position: loaded ? time / LENGTH : 0,
    information: { category: { meta: { filename: file.split('\\').pop() } } },
  };
}

const expected = 'Basic ' + Buffer.from(':' + password).toString('base64');
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  if (url.pathname === '/fake/quit') {
    res.end('bye');
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if ((req.headers.authorization ?? '') !== expected) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (url.pathname !== '/requests/status.json') {
    res.writeHead(404);
    res.end();
    return;
  }
  const cmd = url.searchParams.get('command');
  if (cmd === 'pl_play') {
    const t = now();
    loaded = true;
    state = 'playing';
    setTime(t);
  } else if (cmd === 'pl_pause') {
    const t = now();
    state = state === 'playing' ? 'paused' : 'playing';
    setTime(t);
  } else if (cmd === 'pl_stop') {
    state = 'stopped';
    loaded = false;
    setTime(0);
  } else if (cmd === 'seek') {
    now();
    setTime(Number(url.searchParams.get('val') ?? 0));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status()));
});
server.on('error', () => process.exit(1));

setTimeout(() => process.exit(0), Number(env.FAKE_VLC_LIFE_MS ?? 120000));
if (env.FAKE_VLC_NO_HTTP !== '1') setTimeout(() => server.listen(port, host), Number(env.FAKE_VLC_HTTP_DELAY_MS ?? 200));
```

**File:** `tests/fixtures/movies/rows.ts` (new)
```ts
import type { movieFiles, moviePlays } from '../../../src/db/schema.js';

export type FileRow = typeof movieFiles.$inferSelect;
export type PlayRow = typeof moviePlays.$inferSelect;

export const T0 = new Date('2026-11-01T00:00:00Z');

/** A full movie_files row; every column the contract names, overridable. */
export function fileRow(over: Partial<FileRow> & Pick<FileRow, 'id'>): FileRow {
  return {
    titleId: 'movie-1',
    host: 'this-host',
    path: `/lib/file-${over.id}.mkv`,
    name: `file-${over.id}.mkv`,
    size: 1024,
    mtime: T0,
    durationS: 3000,
    season: null,
    episode: null,
    absoluteEpisode: null,
    status: 'matched',
    reason: null,
    parsed: null,
    source: 'scan',
    firstSeenAt: T0,
    lastSeenAt: T0,
    deletedAt: null,
    movedAt: null,
    doneAt: null,
    watchedAt: null,
    updatedAt: T0,
    ...over,
  };
}

/** A full movie_plays row (ended), overridable. */
export function playRow(over: Partial<PlayRow> & Pick<PlayRow, 'id' | 'fileId'>): PlayRow {
  return {
    host: 'this-host',
    source: 'live',
    startedAt: T0,
    endedAt: T0,
    startPositionS: 0,
    positionS: 0,
    durationS: 3000,
    updatedAt: T0,
    ...over,
  };
}
```

**File:** `tests/fixtures/movies/memVlc.ts` (new): an in-memory VLC for unit tests and for the
continue integration test. Time moves only when a test sets it.
```ts
import type { VlcCommand, VlcEndpoint, VlcReply, VlcState, VlcStatusReader } from '../../../src/movies/vlc/http.js';
import type { PlayerEnv, VlcLaunch, VlcLauncher } from '../../../src/movies/vlc/launch.js';

export interface MemInstance {
  password: string;
  state: VlcState;
  time: number;
  length: number;
  up: boolean;
}

export class MemVlc implements VlcLauncher, VlcStatusReader {
  readonly launches: VlcLaunch[] = [];
  readonly instances = new Map<number, MemInstance>();
  /** The length a pl_play loads. */
  length = 7200;
  /** False: launched instances never answer (HTTP interface not up). */
  httpUp = true;
  failLaunch = false;

  async launch(_env: PlayerEnv, l: VlcLaunch): Promise<void> {
    if (this.failLaunch) throw new Error('spawn vlc.exe ENOENT');
    this.launches.push(l);
    // Like the probe: stopped, length unknown, --start-time not honored.
    this.instances.set(l.port, { password: l.password, state: 'stopped', time: 0, length: 0, up: this.httpUp });
  }

  private reply(ep: VlcEndpoint): VlcReply {
    const i = this.instances.get(ep.port);
    if (i === undefined || !i.up) return { kind: 'gone' };
    if (i.password !== ep.password) return { kind: 'unauthorized' };
    return { kind: 'ok', status: { state: i.state, time: i.time, length: i.length } };
  }

  async status(_curl: string, ep: VlcEndpoint): Promise<VlcReply> {
    return this.reply(ep);
  }

  async command(_curl: string, ep: VlcEndpoint, cmd: VlcCommand): Promise<VlcReply> {
    const i = this.instances.get(ep.port);
    if (i !== undefined && i.up && i.password === ep.password) {
      if (cmd.command === 'pl_play') {
        i.state = 'playing';
        i.length = this.length;
      } else {
        i.time = cmd.val;
      }
    }
    return this.reply(ep);
  }

  /** The VLC on `port` exits (its window was closed). */
  exit(port: number): void {
    this.instances.delete(port);
  }

  /** Some other VLC (not ours) holds `port`. */
  occupy(port: number, password: string): void {
    this.instances.set(port, { password, state: 'playing', time: 10, length: 100, up: true });
  }

  at(port: number): MemInstance {
    const i = this.instances.get(port);
    if (i === undefined) throw new Error(`no VLC on ${port}`);
    return i;
  }
}
```

**File:** `tests/integration/helpers/moviesPlaySeed.ts` (new)
```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';
import { movieEpisodes, movieFiles, moviePlays, movieTitles } from '../../../src/db/schema.js';

export async function truncateMovies(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table movie_plays, movie_files, movie_episodes, movie_credits, movie_title_companies, movie_people, movie_companies, movie_titles restart identity cascade`,
  );
}

export async function seedTitle(
  db: Db,
  t: { id: string; kind: 'movie' | 'tv'; tmdbId: number; title: string; year?: number | null; runtimeMin?: number | null; watchedAt?: Date | null },
): Promise<void> {
  const now = new Date();
  await db.insert(movieTitles).values({
    id: t.id,
    kind: t.kind,
    tmdbId: t.tmdbId,
    title: t.title,
    originalTitle: t.title,
    year: t.year ?? null,
    releaseDate: null,
    overview: '',
    posterPath: null,
    backdropPath: null,
    runtimeMin: t.runtimeMin ?? null,
    genres: [],
    seasonCount: null,
    episodeCount: null,
    watchedAt: t.watchedAt ?? null,
    rating: null,
    reviewNoteId: null,
    metadataFetchedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

export async function seedEpisodes(db: Db, titleId: string, season: number, names: string[]): Promise<void> {
  await db.insert(movieEpisodes).values(
    names.map((name, i) => ({
      titleId,
      season,
      episode: i + 1,
      name,
      airDate: null,
      runtimeMin: null,
      overview: null,
      stillPath: null,
    })),
  );
}

export async function seedFile(
  db: Db,
  f: {
    titleId: string | null;
    host: string;
    path: string;
    durationS?: number | null;
    season?: number | null;
    episode?: number | null;
    deletedAt?: Date | null;
  },
): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(movieFiles)
    .values({
      titleId: f.titleId,
      host: f.host,
      path: f.path,
      name: f.path.split('/').pop()!,
      size: 1024,
      mtime: now,
      durationS: f.durationS ?? 7200,
      season: f.season ?? null,
      episode: f.episode ?? null,
      absoluteEpisode: null,
      status: f.titleId === null ? 'unmatched' : 'matched',
      reason: null,
      parsed: null,
      source: 'scan',
      firstSeenAt: now,
      lastSeenAt: now,
      deletedAt: f.deletedAt ?? null,
      movedAt: null,
      doneAt: null,
      watchedAt: null,
      updatedAt: now,
    })
    .returning({ id: movieFiles.id });
  return row!.id;
}

export async function seedPlay(
  db: Db,
  p: { fileId: number; host: string; positionS: number | null; durationS: number | null; startedAt: Date; endedAt?: Date | null; source?: 'live' | 'vlc_recents' },
): Promise<number> {
  const [row] = await db
    .insert(moviePlays)
    .values({
      fileId: p.fileId,
      host: p.host,
      source: p.source ?? 'live',
      startedAt: p.startedAt,
      endedAt: p.endedAt === undefined ? p.startedAt : p.endedAt,
      startPositionS: 0,
      positionS: p.positionS,
      durationS: p.durationS,
      updatedAt: p.startedAt,
    })
    .returning({ id: moviePlays.id });
  return row!.id;
}
```

### Step 11: Unit tests
**File:** `tests/unit/movies/vlc.launch.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import type { DetectProbe } from '../../../src/http/reveal.js';
import { detectPlayerEnv, newHttpPassword, runningAsSystemdService, scopeArgs, vlcArgs } from '../../../src/movies/vlc/launch.js';

describe('VLC outlives a daemon restart (Design decision 8)', () => {
  it('detects a systemd service from /proc/self/cgroup, not a tmux shell or the user manager', () => {
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/notesd.service\n')).toBe(true);
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.slice/tmux-spawn-1.scope\n')).toBe(false);
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service\n')).toBe(false);
    expect(runningAsSystemdService('')).toBe(false);
  });
  it('puts VLC in its own transient user scope', () => {
    expect(scopeArgs('/mnt/c/vlc.exe', ['--x', 'C:\\f.mkv'])).toEqual(['--user', '--scope', '--quiet', '--collect', '--', '/mnt/c/vlc.exe', '--x', 'C:\\f.mkv']);
  });
});

const VLC = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe';
const CURL = '/mnt/c/Windows/System32/curl.exe';
const BINS = { bin: VLC, curlExe: CURL };

function probe(o: { platform?: NodeJS.Platform; files?: string[]; execs?: string[] } = {}): DetectProbe {
  const files = new Set(o.files ?? ['/proc/sys/fs/binfmt_misc/WSLInterop']);
  const execs = new Set(o.execs ?? ['/usr/bin/wslpath', VLC, CURL]);
  return {
    platform: o.platform ?? 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    exists: async (p) => files.has(p) || execs.has(p),
    executable: async (p) => execs.has(p),
  };
}

describe('detectPlayerEnv', () => {
  it('is available with interop, wslpath, vlc.exe and curl.exe', async () => {
    expect(await detectPlayerEnv(BINS, probe())).toEqual({ available: true, env: { vlc: VLC, curl: CURL, wslpath: '/usr/bin/wslpath' } });
  });

  it('accepts the -late interop entry of newer WSL builds', async () => {
    const d = await detectPlayerEnv(BINS, probe({ files: ['/proc/sys/fs/binfmt_misc/WSLInterop-late'] }));
    expect(d.available).toBe(true);
  });

  it.each([
    ['not_linux', probe({ platform: 'darwin' })],
    ['no_interop', probe({ files: [] })],
    ['no_wslpath', probe({ execs: [VLC, CURL] })],
    ['no_vlc', probe({ execs: ['/usr/bin/wslpath', CURL] })],
    ['no_curl', probe({ execs: ['/usr/bin/wslpath', VLC] })],
  ] as const)('reports %s', async (reason, p) => {
    expect(await detectPlayerEnv(BINS, p)).toEqual({ available: false, reason });
  });

  it('looks a bare binary name up on PATH', async () => {
    const d = await detectPlayerEnv({ bin: 'vlc.exe', curlExe: CURL }, probe({ execs: ['/usr/bin/wslpath', '/usr/bin/vlc.exe', CURL] }));
    expect(d).toMatchObject({ available: true, env: { vlc: '/usr/bin/vlc.exe' } });
  });
});

describe('vlcArgs', () => {
  it('starts a separate instance with loopback HTTP, no resume prompt, the start second and the file last', () => {
    expect(vlcArgs({ winPath: 'C:\\Videos\\A (2015)\\A.mkv', port: 47318, password: 'abc123', startTime: 1200.7 })).toEqual([
      '--no-one-instance',
      '--no-one-instance-when-started-from-file',
      '--qt-continue=0',
      '--no-qt-privacy-ask',
      '--extraintf',
      'http',
      '--http-host',
      '127.0.0.1',
      '--http-port',
      '47318',
      '--http-password',
      'abc123',
      '--start-time=1200',
      'C:\\Videos\\A (2015)\\A.mkv',
    ]);
  });

  it('never passes a negative start', () => {
    expect(vlcArgs({ winPath: 'C:\\a.mkv', port: 1, password: 'p', startTime: -3 })).toContain('--start-time=0');
  });
});

describe('newHttpPassword', () => {
  it('is 32 hex chars and differs per launch', () => {
    const a = newHttpPassword();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newHttpPassword()).not.toBe(a);
  });
});
```

**File:** `tests/unit/movies/vlc.http.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { curlStatusReader, interpretCurl, parseStatusJson, type ExecFn } from '../../../src/movies/vlc/http.js';

const EP = { port: 47318, password: 'pw' };
const STATUS = JSON.stringify({ state: 'playing', time: 1210, length: 7198, position: 0.168, information: {} });

describe('interpretCurl', () => {
  it('exit 7 means VLC is gone', () => {
    expect(interpretCurl({ exitCode: 7, stdout: '' })).toEqual({ kind: 'gone' });
  });
  it('401 means the port is someone else\'s', () => {
    expect(interpretCurl({ exitCode: 0, stdout: '\n401' })).toEqual({ kind: 'unauthorized' });
  });
  it('200 with status.json is a status', () => {
    expect(interpretCurl({ exitCode: 0, stdout: `${STATUS}\n200` })).toEqual({ kind: 'ok', status: { state: 'playing', time: 1210, length: 7198 } });
  });
  it('a timeout or junk is an error, not gone', () => {
    expect(interpretCurl({ exitCode: 28, stdout: '' })).toEqual({ kind: 'error', message: 'curl exited 28' });
    expect(interpretCurl({ exitCode: 0, stdout: 'nope\n200' })).toEqual({ kind: 'error', message: 'unreadable status.json' });
  });
});

describe('parseStatusJson', () => {
  it('rejects an unknown state and clamps junk numbers to 0', () => {
    expect(parseStatusJson(JSON.stringify({ state: 'buffering' }))).toBeNull();
    expect(parseStatusJson(JSON.stringify({ state: 'stopped', time: -1, length: 'x' }))).toEqual({ state: 'stopped', time: 0, length: 0 });
  });
});

describe('curlStatusReader', () => {
  it('runs curl.exe against Windows loopback with Basic auth and the command in the query', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { exitCode: 0, stdout: `${STATUS}\n200` };
    };
    const reader = curlStatusReader(exec);
    await reader.status('/mnt/c/Windows/System32/curl.exe', EP);
    await reader.command('/mnt/c/Windows/System32/curl.exe', EP, { command: 'seek', val: 1200.9 });
    await reader.command('/mnt/c/Windows/System32/curl.exe', EP, { command: 'pl_play' });
    expect(calls).toEqual([
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json'],
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json?command=seek&val=1200'],
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json?command=pl_play'],
    ]);
  });
});
```

**File:** `tests/unit/movies/vlc.recents.test.ts` (new)
```ts
import { describe, expect, it, vi } from 'vitest';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';
import type { NewMovieFile } from '../../../src/movies/types.js';
import {
  fileUrlToWslPath,
  parseRecents,
  recentsRelPath,
  recentsSyncHook,
  shouldRecord,
  splitQtList,
  type RecentsFs,
  type RecentsRepo,
  type TitleResolver,
} from '../../../src/movies/vlc/recents.js';

/** The real file's shape (synthetic names), including -1 and 0 times and a non-file MRL. */
const INI = [
  '[General]',
  'filedialog-path=@Variant(\\0\\0\\0\\x11\\0\\0\\0\\x10)',
  '',
  '[RecentsMRL]',
  'list=file:///C:/Users/u/Videos/Pak%20Bernard/Absolutely%20Anything%20(2015)/Absolutely%20Anything.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv, "file:///C:/Users/u/Videos/a,b.mkv", https://example.com/live, file:///C:/Users/u/Videos/Opened.Only.2024.mkv',
  'times=1307375, 6684192, 0, -1',
  '',
  '[MainWindow]',
  'geometry=@ByteArray(x)',
].join('\r\n');

describe('parseRecents', () => {
  it('zips list= and times=, decodes paths and maps 0 / -1 / missing to unknown', () => {
    expect(parseRecents(INI)).toEqual([
      { url: 'file:///C:/Users/u/Videos/Pak%20Bernard/Absolutely%20Anything%20(2015)/Absolutely%20Anything.mkv', path: '/mnt/c/Users/u/Videos/Pak Bernard/Absolutely Anything (2015)/Absolutely Anything.mkv', positionS: 1307.375 },
      { url: 'file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', path: '/mnt/c/Users/u/Downloads/Telegram Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', positionS: 6684.192 },
      { url: 'file:///C:/Users/u/Videos/a,b.mkv', path: '/mnt/c/Users/u/Videos/a,b.mkv', positionS: null },
      { url: 'https://example.com/live', path: null, positionS: null },
      { url: 'file:///C:/Users/u/Videos/Opened.Only.2024.mkv', path: '/mnt/c/Users/u/Videos/Opened.Only.2024.mkv', positionS: null },
    ]);
  });

  it('reads nothing from a file without the section or with @Invalid()', () => {
    expect(parseRecents('[General]\nx=1')).toEqual([]);
    expect(parseRecents('[RecentsMRL]\nlist=@Invalid()\ntimes=@Invalid()')).toEqual([]);
  });
});

describe('helpers', () => {
  it('splitQtList keeps positions and unquotes', () => {
    expect(splitQtList('a, "b, c", d')).toEqual(['a', 'b, c', 'd']);
  });
  it('fileUrlToWslPath rejects non-drive URLs and lowercases the drive', () => {
    expect(fileUrlToWslPath('file:///D:/x%20y.mkv')).toBe('/mnt/d/x y.mkv');
    expect(fileUrlToWslPath('file://server/share/x.mkv')).toBeNull();
    expect(fileUrlToWslPath('file:///C:/bad%E0%A4%A.mkv')).toBeNull();
  });
  it('recentsRelPath is relative to a root, else parent/name', () => {
    expect(recentsRelPath('/mnt/c/V/Pak Bernard/A (2015)/A.mkv', ['/mnt/c/V'])).toBe('Pak Bernard/A (2015)/A.mkv');
    expect(recentsRelPath('/mnt/e/usb/A (2015)/A.mkv', ['/mnt/c/V'])).toBe('A (2015)/A.mkv');
  });
  it('shouldRecord skips a position within 10 s of the last play and an unknown one after any play', () => {
    expect(shouldRecord(null, null)).toBe(true);
    expect(shouldRecord({ positionS: 1300 }, 1307)).toBe(false);
    expect(shouldRecord({ positionS: 1200 }, 1307)).toBe(true);
    expect(shouldRecord({ positionS: 1200 }, null)).toBe(false);
    expect(shouldRecord({ positionS: null }, 50)).toBe(true);
  });
});

class MemRecentsRepo {
  files: FileRow[] = [];
  plays: PlayRow[] = [];
  titles = new Map<string, { id: string; runtimeMin: number | null }>();
  upserted: unknown[] = [];

  async findTrackedFile(host: string, p: string, name: string): Promise<FileRow | null> {
    return this.files.find((f) => f.host === host && f.path === p) ?? this.files.find((f) => f.host === host && f.name === name) ?? null;
  }
  async lastPlay(fileId: number): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.fileId === fileId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
  }
  async recordObservation(i: { fileId: number; host: string; positionS: number | null; durationS: number | null; observedAt: Date }): Promise<PlayRow> {
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: 'vlc_recents', startedAt: i.observedAt, endedAt: i.observedAt, positionS: i.positionS, durationS: i.durationS });
    this.plays.push(row);
    return row;
  }
  async titleById(id: string) {
    return (this.titles.get(id) ?? null) as never;
  }
  async upsertTitle(meta: unknown) {
    this.upserted.push(meta);
    this.titles.set('movie-1001', { id: 'movie-1001', runtimeMin: 120 });
  }
  async upsertFile(i: NewMovieFile): Promise<{ file: FileRow; created: boolean }> {
    const titleId = i.classification.status === 'matched' ? i.classification.titleId : null;
    const row = fileRow({ id: 100 + this.files.length, host: i.host, path: i.path, name: i.name, titleId, deletedAt: i.deletedAt ?? null, source: i.source, durationS: null });
    this.files.push(row);
    return { file: row, created: true };
  }
}

const MTIME = new Date('2026-11-14T04:20:00Z');
function memFs(text: string): RecentsFs {
  return { readFile: async () => text, mtime: async () => MTIME, exists: async () => false };
}

describe('recentsSyncHook', () => {
  it('observes a tracked file, backfills a gone one under a freshly fetched title, and is idempotent', async () => {
    const repo = new MemRecentsRepo();
    repo.files.push(fileRow({ id: 1, path: '/mnt/c/Users/u/Videos/Pak Bernard/Absolutely Anything (2015)/Absolutely Anything.mkv', name: 'Absolutely Anything.mkv', durationS: 5100 }));
    const resolver: TitleResolver = {
      match: vi.fn(async () => ({ kind: 'matched', tmdbKind: 'movie', tmdbId: 1001, confidence: 0.95 }) as never),
      details: vi.fn(async () => ({ opaque: 'metadata' }) as never),
    };
    const hook = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver, fs: memFs(INI), log: () => {} });

    const first = await hook.run();
    expect(first).toMatchObject({ observed: 4, created: 3 });
    expect(repo.plays.find((p) => p.fileId === 1)).toMatchObject({ positionS: 1307.375, durationS: 5100, startedAt: MTIME });
    const dog = repo.files.find((f) => f.name.startsWith('The.Dog.Stars'))!;
    expect(dog).toMatchObject({ titleId: 'movie-1001', source: 'vlc_recents' });
    expect(dog.deletedAt).not.toBeNull();
    expect(repo.plays.find((p) => p.fileId === dog.id)).toMatchObject({ positionS: 6684.192, durationS: 7200, startedAt: new Date(MTIME.getTime() - 1000) });
    expect(repo.upserted).toEqual([{ opaque: 'metadata' }]);

    const before = repo.plays.length;
    expect((await hook.run()).observed).toBe(0);
    const fresh = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver, fs: memFs(INI), log: () => {} });
    expect((await fresh.run()).observed).toBe(0);
    expect(repo.plays.length).toBe(before);
  });

  it('retries gone files next pass when the resolver fails or there are no credentials', async () => {
    const repo = new MemRecentsRepo();
    const failing: TitleResolver = { match: async () => { throw new Error('TMDB unreachable'); }, details: async () => ({}) as never };
    const hook = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver: failing, fs: memFs(INI), log: () => {} });
    expect(await hook.run()).toMatchObject({ observed: 0, created: 0, retry: 4 });
    const none = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'this-host', repo: repo as unknown as RecentsRepo, resolver: null, fs: memFs(INI), log: () => {} });
    expect(await none.run()).toMatchObject({ observed: 0, retry: 4 });
    expect(repo.files).toEqual([]);
  });

  it('a missing ini is a quiet no-op, and afterScan never throws into the sync pass', async () => {
    const repo = new MemRecentsRepo();
    const fs: RecentsFs = { readFile: async () => { throw new Error('ENOENT'); }, mtime: async () => MTIME, exists: async () => false };
    const hook = recentsSyncHook({ iniPath: '/none.ini', roots: [], host: 'h', repo: repo as unknown as RecentsRepo, resolver: null, fs });
    expect(await hook.run()).toEqual({ observed: 0, created: 0, skipped: 0, unmatched: 0, retry: 0 });
    const broken = { ...repo, findTrackedFile: async () => { throw new Error('db down'); } } as unknown as RecentsRepo;
    const lines: string[] = [];
    const bad = recentsSyncHook({ iniPath: '/x.ini', roots: [], host: 'h', repo: broken, resolver: null, fs: memFs(INI), log: (l) => lines.push(l) });
    await expect(bad.afterScan!({} as never)).resolves.toBe(0);
    expect(lines.join('\n')).toContain('recents pass failed: db down');
  });
});
```
In the first test, `observed: 4, created: 3` counts the tracked file (1 observation), Dog Stars,
`a,b.mkv` and `Opened.Only.2024.mkv`. The last three are gone, and the fake resolver matches
every name, so each becomes a deleted file. `https://...` is skipped. Change those counts only
if the INI fixture changes.

**File:** `tests/unit/movies/player.test.ts` (new)
```ts
import { describe, expect, it, vi } from 'vitest';
import { MoviePlayer, PlayError, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, T0, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };
const PORT = 47318;

class MemRepo {
  files = new Map<number, FileRow>();
  plays: PlayRow[] = [];
  async fileById(id: number): Promise<FileRow | null> {
    return this.files.get(id) ?? null;
  }
  async lastPlay(fileId: number): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.fileId === fileId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id - a.id)[0] ?? null;
  }
  async startPlay(i: { fileId: number; host: string; source: 'live'; startPositionS: number; durationS: number | null }): Promise<PlayRow> {
    const now = new Date();
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: i.source, startedAt: now, endedAt: null, startPositionS: i.startPositionS, positionS: i.startPositionS, durationS: i.durationS, updatedAt: now });
    this.plays.push(row);
    return row;
  }
  async updatePlay(id: number, i: { positionS: number | null; durationS: number | null }): Promise<boolean> {
    Object.assign(this.play(id), { positionS: i.positionS, durationS: i.durationS, updatedAt: new Date() });
    return true;
  }
  async endPlay(id: number, i: { positionS?: number | null; durationS?: number | null }, endedAt: Date = new Date()): Promise<PlayRow | null> {
    Object.assign(this.play(id), { positionS: i.positionS ?? null, durationS: i.durationS ?? null, endedAt });
    return this.play(id);
  }
  async closeOpenPlays(host: string): Promise<number> {
    const open = this.plays.filter((p) => p.host === host && p.source === 'live' && p.endedAt === null);
    for (const p of open) p.endedAt = p.updatedAt;
    return open.length;
  }
  play(id: number): PlayRow {
    const p = this.plays.find((x) => x.id === id);
    if (p === undefined) throw new Error(`no play ${id}`);
    return p;
  }
}

function setup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new MemVlc();
  repo.files.set(1, fileRow({ id: 1, path: '/lib/A.mkv', name: 'A.mkv', durationS: 7200 }));
  repo.files.set(2, fileRow({ id: 2, path: '/lib/B.mkv', name: 'B.mkv', durationS: 7200 }));
  const player = new MoviePlayer({
    repo: repo as unknown as PlayerRepo,
    host: 'this-host',
    httpPort: PORT,
    pollMs: 10,
    detect: async () => ENV_OK,
    launcher: vlc,
    reader: vlc,
    wslpath: async (_bin, abs) => `C:${abs.replaceAll('/', '\\')}`,
    exists: async (abs) => !abs.includes('gone'),
    readyTimeoutMs: 100,
    readyIntervalMs: 5,
    playingTimeoutMs: 50,
    log: () => {},
    ...over,
  });
  return { repo, vlc, player };
}

describe('MoviePlayer.play', () => {
  it('launches at the resume position, presses play and seeks there (R4.1)', async () => {
    const { repo, vlc, player } = setup();
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 1200, durationS: 7200 }));
    const started = await player.play(1);
    expect(started).toMatchObject({ file_id: 1, start_position: 1200, port: PORT, tracking: true, note: null });
    expect(vlc.launches[0]).toMatchObject({ winPath: 'C:\\lib\\A.mkv', port: PORT, startTime: 1200 });
    expect(vlc.at(PORT)).toMatchObject({ state: 'playing', time: 1200, length: 7200 });
    expect(repo.play(started.play_id)).toMatchObject({ startPositionS: 1200, endedAt: null });
    await player.close();
  });

  it('starts a finished file from 0 without seeking', async () => {
    const { repo, vlc, player } = setup();
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 7000, durationS: 7200 }));
    const started = await player.play(1);
    expect(started.start_position).toBe(0);
    expect(vlc.at(PORT).time).toBe(0);
    await player.close();
  });

  it('records each poll and ends with the last position when VLC exits (R4.2, R4.3)', async () => {
    const { repo, vlc, player } = setup();
    const started = await player.play(1);
    vlc.at(PORT).time = 1300;
    await vi.waitFor(() => expect(repo.play(started.play_id).positionS).toBe(1300));
    expect(player.current()).toMatchObject({ play_id: started.play_id, position: 1300, duration: 7200, state: 'playing' });
    vlc.at(PORT).state = 'stopped';
    vlc.at(PORT).time = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(repo.play(started.play_id).positionS).toBe(1300); // stopped reads are not recorded
    vlc.exit(PORT);
    await vi.waitFor(() => expect(repo.play(started.play_id).endedAt).not.toBeNull());
    expect(repo.play(started.play_id).positionS).toBe(1300);
    expect(player.current()).toBeNull();
  });

  it('a second play ends the first, leaves its VLC running and takes the next port', async () => {
    const { repo, vlc, player } = setup();
    const a = await player.play(1);
    const b = await player.play(2);
    expect(repo.play(a.play_id).endedAt).not.toBeNull();
    expect(vlc.instances.has(PORT)).toBe(true);
    expect(b.port).toBe(PORT + 1);
    expect(player.current()?.play_id).toBe(b.play_id);
    await player.close();
  });

  it('skips a port another VLC holds, and fails with no_free_port when all ten are held', async () => {
    const { vlc, player } = setup();
    vlc.occupy(PORT, 'theirs');
    expect((await player.play(1)).port).toBe(PORT + 1);
    await player.close();
    const second = setup();
    for (let i = 0; i < 10; i++) second.vlc.occupy(PORT + i, 'theirs');
    await expect(second.player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'no_free_port' });
  });

  it('closes the play untracked at the start position when HTTP never answers', async () => {
    const { repo, vlc, player } = setup();
    vlc.httpUp = false;
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 600, durationS: 7200 }));
    const started = await player.play(1);
    expect(started).toMatchObject({ tracking: false, note: 'http_timeout', start_position: 600 });
    expect(repo.play(started.play_id)).toMatchObject({ positionS: 600 });
    expect(repo.play(started.play_id).endedAt).not.toBeNull();
    expect(player.current()).toBeNull();
  });

  it('refuses other hosts, deleted or vanished files, unknown ids and a missing player', async () => {
    const { repo, vlc, player } = setup();
    repo.files.set(3, fileRow({ id: 3, host: 'other-laptop' }));
    repo.files.set(4, fileRow({ id: 4, deletedAt: T0 }));
    repo.files.set(5, fileRow({ id: 5, path: '/lib/gone.mkv' }));
    await expect(player.play(3)).rejects.toMatchObject({ code: 'not_on_this_machine', host: 'other-laptop' });
    await expect(player.play(4)).rejects.toMatchObject({ code: 'file_missing' });
    await expect(player.play(5)).rejects.toMatchObject({ code: 'file_missing' });
    await expect(player.play(404)).rejects.toBeInstanceOf(PlayError);
    expect(vlc.launches).toEqual([]);
    const off = setup({ detect: async () => ({ available: false, reason: 'no_curl' }) });
    await expect(off.player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'no_curl' });
    expect(await off.player.availability()).toEqual({ available: false, reason: 'no_curl' });
  });

  it('a failed launch writes no play row', async () => {
    const { repo, vlc, player } = setup();
    vlc.failLaunch = true;
    await expect(player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'launch_failed' });
    expect(repo.plays).toEqual([]);
  });
});

describe('MoviePlayer.close and start', () => {
  it('close ends the tracked play at its last position and leaves VLC running', async () => {
    const { repo, vlc, player } = setup();
    const started = await player.play(1);
    vlc.at(PORT).time = 2500;
    await vi.waitFor(() => expect(repo.play(started.play_id).positionS).toBe(2500));
    await player.close();
    expect(repo.play(started.play_id)).toMatchObject({ positionS: 2500 });
    expect(repo.play(started.play_id).endedAt).not.toBeNull();
    expect(vlc.instances.has(PORT)).toBe(true);
  });

  it('start closes plays a previous process left open', async () => {
    const { repo, player } = setup();
    repo.plays.push(playRow({ id: 7, fileId: 1, endedAt: null, positionS: 500, updatedAt: T0 }));
    expect(await player.start()).toBe(1);
    expect(repo.play(7)).toMatchObject({ endedAt: T0, positionS: 500 });
  });
});
```

**File:** `tests/unit/movies/continue.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { decideContinue, type ContinueFileView, type EpisodeSlot } from '../../../src/movies/continue.js';
import { fileRow, playRow, T0 } from '../../fixtures/movies/rows.js';

const day = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);
const EPS: EpisodeSlot[] = [1, 2, 3, 4, 5].map((e) => ({ season: 1, episode: e, name: `Episode ${e}` }));

function ep(id: number, e: number, o: { state: ContinueFileView['state']; present?: boolean; playedDay?: number }): ContinueFileView {
  const file = fileRow({ id, titleId: 'tv-1', season: 1, episode: e });
  const last = o.playedDay === undefined ? null : playRow({ id: id * 10, fileId: id, startedAt: day(o.playedDay), endedAt: day(o.playedDay) });
  return { file, last, state: o.state, present: o.present ?? true };
}

describe('decideContinue: series', () => {
  it('resumes the most recently played unfinished episode', () => {
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'in_progress', playedDay: 2 })], EPS);
    expect(d).toMatchObject({ action: 'resume', file: { id: 2 } });
  });

  it('starts the next present episode after the last played one', () => {
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'unwatched' })], EPS);
    expect(d).toMatchObject({ action: 'start', file: { id: 2 } });
  });

  it('names the missing next episode and the later present ones', () => {
    const d = decideContinue(
      'tv',
      null,
      [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(2, 2, { state: 'finished', playedDay: 2 }), ep(4, 4, { state: 'unwatched' }), ep(5, 5, { state: 'unwatched', present: false })],
      EPS,
    );
    expect(d).toEqual({
      action: 'missing',
      missing: { file_id: null, season: 1, episode: 3, absolute_episode: null, name: 'Episode 3' },
      present: [{ file_id: 4, season: 1, episode: 4, absolute_episode: null, name: 'Episode 4' }],
    });
  });

  it('skips episodes already finished after the anchor, and is caught up past the last one', () => {
    const skip = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 3 }), ep(2, 2, { state: 'finished' }), ep(3, 3, { state: 'unwatched' })], EPS);
    expect(skip).toMatchObject({ action: 'start', file: { id: 3 } });
    const done = decideContinue('tv', null, [ep(5, 5, { state: 'finished', playedDay: 4 })], EPS);
    expect(done).toMatchObject({ action: 'nothing', reason: 'caught_up', last: { file_id: 5, episode: 5 } });
  });

  it('with no plays, starts from the first episode; with no episode list, orders by the files', () => {
    expect(decideContinue('tv', null, [ep(1, 1, { state: 'unwatched' })], EPS)).toMatchObject({ action: 'start', file: { id: 1 } });
    const d = decideContinue('tv', null, [ep(1, 1, { state: 'finished', playedDay: 1 }), ep(3, 3, { state: 'unwatched' })], []);
    expect(d).toMatchObject({ action: 'start', file: { id: 3 } });
    expect(decideContinue('tv', null, [], [])).toMatchObject({ action: 'nothing', reason: 'no_episodes' });
  });
});

describe('decideContinue: film', () => {
  const film = (o: { state: ContinueFileView['state']; present?: boolean }): ContinueFileView => ({
    file: fileRow({ id: 1 }),
    last: o.state === 'unwatched' ? null : playRow({ id: 1, fileId: 1, startedAt: day(1), endedAt: day(1) }),
    state: o.state,
    present: o.present ?? true,
  });

  it('resumes, starts, reports finished, or missing', () => {
    expect(decideContinue('movie', null, [film({ state: 'in_progress' })], [])).toMatchObject({ action: 'resume' });
    expect(decideContinue('movie', null, [film({ state: 'unwatched' })], [])).toMatchObject({ action: 'start' });
    expect(decideContinue('movie', null, [film({ state: 'finished' })], [])).toMatchObject({ action: 'nothing', reason: 'finished', finishedAt: day(1) });
    expect(decideContinue('movie', day(9), [], [])).toMatchObject({ action: 'nothing', reason: 'finished', finishedAt: day(9) });
    expect(decideContinue('movie', null, [film({ state: 'dropped', present: false })], [])).toMatchObject({ action: 'missing', present: [] });
  });
});
```

### Step 12: Integration tests
**File:** `tests/integration/movies.play.int.test.ts` (new): the fake VLC process, reached
through the real `/usr/bin/curl` (WSL loopback is the fake's loopback), real routes, real rows.
```ts
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moviePlays } from '../../src/db/schema.js';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { revealRoutes, type RevealDeps } from '../../src/http/reveal.js';
import { MoviePlayer } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { curlStatusReader } from '../../src/movies/vlc/http.js';
import { spawnVlcLauncher, type PlayerDetection } from '../../src/movies/vlc/launch.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const CURL = '/usr/bin/curl';
const FAKE_VLC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/movies/fake-vlc.mjs');
const HOST = 'this-host';
const NO_REVEAL: RevealDeps = { detect: async () => null, wslpath: async (p) => p, spawn: async () => undefined };

interface Launch {
  pid: number;
  argv: string[];
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function freePortBlock(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = await portFree(base + i);
    if (ok) return base;
  }
  throw new Error('no free block of ports');
}

function argOf(argv: string[], name: string): string {
  return argv[argv.indexOf(name) + 1]!;
}

describe.skipIf(!existsSync(CURL))('movies playback with a fake VLC', () => {
  let h: ApiHarness;
  let dir: string;
  let log: string;
  let basePort: number;
  const players: MoviePlayer[] = [];

  async function launches(): Promise<Launch[]> {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch);
    } catch {
      return [];
    }
  }

  async function vlcBin(extra: Record<string, string> = {}): Promise<string> {
    const env = { FAKE_VLC_LOG: log, FAKE_VLC_SPEED: '60', FAKE_VLC_LIFE_MS: '30000', ...extra };
    const bin = path.join(dir, `vlc-${Object.keys(extra).join('-') || 'default'}.exe`);
    const lines = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`);
    await writeFile(bin, `#!/bin/sh\n${lines.join('\n')}\nexec "${process.execPath}" "${FAKE_VLC}" "$@"\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  async function makePlayer(o: { detection?: PlayerDetection; vlcEnv?: Record<string, string>; readyTimeoutMs?: number } = {}): Promise<MoviePlayer> {
    const vlc = await vlcBin(o.vlcEnv);
    const player = new MoviePlayer({
      repo: new MoviesRepo(h.deps.db),
      host: HOST,
      httpPort: basePort,
      pollMs: 100,
      detect: async () => o.detection ?? { available: true, env: { vlc, curl: CURL, wslpath: '/usr/bin/wslpath' } },
      launcher: spawnVlcLauncher({ scope: false }),
      reader: curlStatusReader(),
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      readyTimeoutMs: o.readyTimeoutMs ?? 5000,
      readyIntervalMs: 50,
      playingTimeoutMs: 2000,
      log: () => {},
    });
    players.push(player);
    return player;
  }

  function appFor(player: MoviePlayer | null): Hono {
    const app = new Hono();
    app.route('/', moviesPlayRoutes({ db: h.deps.db, moviesPlayer: player }));
    app.route('/', revealRoutes({ ...h.deps, moviesPlayer: player }, { reveal: NO_REVEAL }));
    return app;
  }

  async function post(app: Hono, url: string, body?: unknown): Promise<Response> {
    return app.request(url, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function playRow(id: number) {
    const [row] = await h.deps.db.select().from(moviePlays).where(eq(moviePlays.id, id));
    return row!;
  }

  async function fakeStatus(port: number, password: string): Promise<{ state: string; time: number }> {
    const res = await fetch(`http://127.0.0.1:${port}/requests/status.json`, {
      headers: { authorization: 'Basic ' + Buffer.from(':' + password).toString('base64') },
    });
    return (await res.json()) as { state: string; time: number };
  }

  async function seedFilm(o: { lastPosition?: number; host?: string } = {}): Promise<number> {
    await seedTitle(h.deps.db, { id: 'movie-900001', kind: 'movie', tmdbId: 900001, title: 'Fake Film', year: 2026 }).catch(() => undefined);
    const file = path.join(dir, `Fake.Film.2026.${Math.random().toString(36).slice(2)}.mkv`);
    await writeFile(file, 'x');
    const fileId = await seedFile(h.deps.db, { titleId: 'movie-900001', host: o.host ?? HOST, path: file, durationS: 7200 });
    if (o.lastPosition !== undefined) {
      await seedPlay(h.deps.db, { fileId, host: o.host ?? HOST, positionS: o.lastPosition, durationS: 7200, startedAt: new Date(Date.now() - 86_400_000) });
    }
    return fileId;
  }

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-play-'));
    log = path.join(dir, 'launches.jsonl');
    basePort = await freePortBlock(3);
  });
  afterEach(async () => {
    for (const p of players.splice(0)) await p.close();
    for (const l of await launches()) {
      try {
        process.kill(l.pid);
      } catch {
        // already exited
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('starts VLC at the last recorded position and seeks there (R4.1)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    const { play } = (await res.json()) as { play: { play_id: number; start_position: number; tracking: boolean; port: number } };
    expect(play).toMatchObject({ start_position: 1200, tracking: true, port: basePort });
    const [launch] = await launches();
    expect(launch!.argv).toEqual([
      '--no-one-instance',
      '--no-one-instance-when-started-from-file',
      '--qt-continue=0',
      '--no-qt-privacy-ask',
      '--extraintf',
      'http',
      '--http-host',
      '127.0.0.1',
      '--http-port',
      String(basePort),
      '--http-password',
      expect.stringMatching(/^[0-9a-f]{32}$/),
      '--start-time=1200',
      expect.stringMatching(/^C:\\fake\\Fake\.Film\.2026\..+\.mkv$/),
    ]);
    // The fake ignores --start-time and starts stopped: playing at >= 1200 proves pl_play + seek.
    const st = await fakeStatus(basePort, argOf(launch!.argv, '--http-password'));
    expect(st.state).toBe('playing');
    expect(st.time).toBeGreaterThanOrEqual(1200);
  });

  it('starts a finished file from the beginning (R4.1)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 7000 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { play: { start_position: number } }).play.start_position).toBe(0);
    const [launch] = await launches();
    expect(launch!.argv).toContain('--start-time=0');
    expect((await fakeStatus(basePort, argOf(launch!.argv, '--http-password'))).time).toBeLessThan(600);
  });

  it('records position and duration into the play every poll while VLC plays (R4.2)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(
      async () => {
        const row = await playRow(play.play_id);
        expect(row.positionS).toBeGreaterThan(1260);
        expect(row.durationS).toBe(7200);
        expect(row.endedAt).toBeNull();
      },
      { timeout: 5000, interval: 100 },
    );
    const state = (await (await app.request('/api/movies/player')).json()) as { available: boolean; current: { play_id: number; state: string } | null };
    expect(state).toMatchObject({ available: true, current: { play_id: play.play_id, state: 'playing' } });
  });

  it('closes the play at the last position read when VLC exits (R4.3)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(async () => expect((await playRow(play.play_id)).positionS).toBeGreaterThan(1260), { timeout: 5000, interval: 100 });
    const before = (await playRow(play.play_id)).positionS!;
    await fetch(`http://127.0.0.1:${basePort}/fake/quit`);
    await vi.waitFor(async () => expect((await playRow(play.play_id)).endedAt).not.toBeNull(), { timeout: 5000, interval: 100 });
    const row = await playRow(play.play_id);
    expect(row.positionS).toBeGreaterThanOrEqual(before);
    expect(row.positionS).toBeLessThan(before + 120);
    expect(((await (await app.request('/api/movies/player')).json()) as { current: unknown }).current).toBeNull();
  });

  it('answers not_on_this_machine for a file of another host and starts nothing (R3.7)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ host: 'other-laptop', lastPosition: 100 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'other-laptop' });
    expect(await launches()).toEqual([]);
  });

  it('answers player_unavailable and reports playback off when vlc.exe is missing (R4.5)', async () => {
    const off = appFor(await makePlayer({ detection: { available: false, reason: 'no_vlc' } }));
    const fileId = await seedFilm();
    const res = await post(off, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'player_unavailable', reason: 'no_vlc' });
    expect(await (await off.request('/api/capabilities')).json()).toEqual({ reveal: false, movies_playback: false });
    expect(await (await off.request('/api/movies/player')).json()).toEqual({ available: false, reason: 'no_vlc', current: null });
    expect(await launches()).toEqual([]);
    const on = appFor(await makePlayer());
    expect(await (await on.request('/api/capabilities')).json()).toEqual({ reveal: false, movies_playback: true });
    const none = appFor(null);
    expect((await post(none, `/api/movies/files/${fileId}/play`)).status).toBe(503);
  });

  it('a new play ends tracking of the previous one, leaves that VLC running and takes the next port', async () => {
    const app = appFor(await makePlayer());
    const a = await seedFilm({ lastPosition: 100 });
    const b = await seedFilm({ lastPosition: 200 });
    const first = ((await (await post(app, `/api/movies/files/${a}/play`)).json()) as { play: { play_id: number } }).play;
    const second = ((await (await post(app, `/api/movies/files/${b}/play`)).json()) as { play: { play_id: number; port: number } }).play;
    expect(second.port).toBe(basePort + 1);
    expect((await playRow(first.play_id)).endedAt).not.toBeNull();
    const [launchA] = await launches();
    expect((await fakeStatus(basePort, argOf(launchA!.argv, '--http-password'))).state).toBe('playing');
  });

  it('ends the play untracked when the HTTP interface never comes up', async () => {
    const app = appFor(await makePlayer({ vlcEnv: { FAKE_VLC_NO_HTTP: '1' }, readyTimeoutMs: 600 }));
    const fileId = await seedFilm({ lastPosition: 900 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    const { play } = (await res.json()) as { play: { play_id: number; tracking: boolean; note: string } };
    expect(play).toMatchObject({ tracking: false, note: 'http_timeout' });
    const row = await playRow(play.play_id);
    expect(row.endedAt).not.toBeNull();
    expect(row.positionS).toBe(900);
  });

  it('close() ends the play at its last position and leaves VLC open; start() closes a play left open', async () => {
    const player = await makePlayer();
    const app = appFor(player);
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(async () => expect((await playRow(play.play_id)).positionS).toBeGreaterThan(1260), { timeout: 5000, interval: 100 });
    await player.close();
    const closed = await playRow(play.play_id);
    expect(closed.endedAt).not.toBeNull();
    const [launch] = await launches();
    expect((await fakeStatus(basePort, argOf(launch!.argv, '--http-password'))).state).toBe('playing');

    const stale = await seedPlay(h.deps.db, { fileId, host: HOST, positionS: 500, durationS: 7200, startedAt: new Date('2026-11-13T10:00:00Z'), endedAt: null });
    const restarted = await makePlayer();
    expect(await restarted.start()).toBe(1);
    const row = await playRow(stale);
    expect(row.positionS).toBe(500);
    expect(row.endedAt?.toISOString()).toBe('2026-11-13T10:00:00.000Z');
  });

  it('answers file_missing for a deleted file, and refuses a foreign Origin', async () => {
    const app = appFor(await makePlayer());
    const gone = await seedFile(h.deps.db, { titleId: null, host: HOST, path: path.join(dir, 'gone.mkv'), deletedAt: new Date() });
    expect((await post(app, `/api/movies/files/${gone}/play`)).status).toBe(410);
    const res = await app.request(`/api/movies/files/${gone}/play`, { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect((await post(app, '/api/movies/files/abc/play')).status).toBe(400);
  });
});
```

**File:** `tests/integration/movies.continue.int.test.ts` (new)
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { MoviePlayer } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { MemVlc } from '../fixtures/movies/memVlc.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { seedEpisodes, seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HOST = 'this-host';
const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

describe('POST /api/movies/continue', () => {
  let h: ApiHarness;
  let dir: string;
  let vlc: MemVlc;
  let player: MoviePlayer;
  let app: Hono;

  async function present(name: string): Promise<string> {
    const p = path.join(dir, name);
    await writeFile(p, 'x');
    return p;
  }

  async function cont(body: unknown): Promise<Record<string, unknown>> {
    const res = await app.request('/api/movies/continue', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** MobLand S1: E1 finished, E2 in progress at 1000 s, E4 present and unwatched; E3 and E5 have no file. */
  async function seedMobland(): Promise<{ e2: number; e4: number }> {
    await seedTitle(h.deps.db, { id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025 });
    await seedEpisodes(h.deps.db, 'tv-247718', 1, ['Stick or Twist', 'Gimme Shelter', 'Alliance', 'Funeral', 'Remorse']);
    const e1 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E01.mkv'), durationS: 3000, season: 1, episode: 1 });
    const e2 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E02.mkv'), durationS: 3000, season: 1, episode: 2 });
    const e4 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E04.mkv'), durationS: 3000, season: 1, episode: 4 });
    await seedPlay(h.deps.db, { fileId: e1, host: HOST, positionS: 2950, durationS: 3000, startedAt: daysAgo(3) });
    await seedPlay(h.deps.db, { fileId: e2, host: HOST, positionS: 1000, durationS: 3000, startedAt: daysAgo(2) });
    return { e2, e4 };
  }

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-continue-'));
    vlc = new MemVlc();
    vlc.length = 3000;
    player = new MoviePlayer({
      repo: new MoviesRepo(h.deps.db),
      host: HOST,
      httpPort: 47318,
      pollMs: 60_000,
      detect: async () => ({ available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } }),
      launcher: vlc,
      reader: vlc,
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      readyTimeoutMs: 200,
      readyIntervalMs: 5,
      playingTimeoutMs: 50,
      log: () => {},
    });
    app = new Hono();
    app.route('/', moviesPlayRoutes({ db: h.deps.db, moviesPlayer: player }));
  });
  afterEach(async () => {
    await player.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('resumes the latest unfinished episode from its position (R6.1)', async () => {
    const { e2 } = await seedMobland();
    const out = await cont({ title: 'mobland' });
    expect(out).toMatchObject({ action: 'resumed', title: { id: 'tv-247718' }, file: { file_id: e2, season: 1, episode: 2, name: 'Gimme Shelter' }, position: 1000 });
    expect(vlc.launches).toHaveLength(1);
    expect(vlc.launches[0]!.startTime).toBe(1000);
  });

  it('names the missing next episode and the later present one, then starts it once present (R6.1)', async () => {
    const { e2, e4 } = await seedMobland();
    await seedPlay(h.deps.db, { fileId: e2, host: HOST, positionS: 2990, durationS: 3000, startedAt: daysAgo(1) });
    expect(await cont({ title: 'MobLand' })).toEqual({
      action: 'missing',
      title: { id: 'tv-247718', title: 'MobLand', kind: 'tv', year: 2025 },
      missing: { file_id: null, season: 1, episode: 3, absolute_episode: null, name: 'Alliance' },
      present: [{ file_id: e4, season: 1, episode: 4, absolute_episode: null, name: 'Funeral' }],
    });
    expect(vlc.launches).toHaveLength(0);
    const e3 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E03.mkv'), durationS: 3000, season: 1, episode: 3 });
    expect(await cont({ title: 'mobland' })).toMatchObject({ action: 'started', file: { file_id: e3, episode: 3 }, position: 0 });
  });

  it('continues the title of the newest play when no title is given (R6.2)', async () => {
    await seedMobland();
    await seedTitle(h.deps.db, { id: 'movie-555', kind: 'movie', tmdbId: 555, title: 'Runner', year: 2026 });
    const runner = await seedFile(h.deps.db, { titleId: 'movie-555', host: HOST, path: await present('Runner.2026.mkv'), durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: runner, host: HOST, positionS: 1896, durationS: 6000, startedAt: daysAgo(0.5) });
    expect(await cont({})).toMatchObject({ action: 'resumed', title: { id: 'movie-555' }, position: 1896 });
    await player.close();
  });

  it('reports a finished film, an ambiguous query and no match', async () => {
    await seedTitle(h.deps.db, { id: 'movie-1', kind: 'movie', tmdbId: 1, title: 'Bad Apples', year: 2025 });
    await seedTitle(h.deps.db, { id: 'movie-2', kind: 'movie', tmdbId: 2, title: 'Bad Boys', year: 2020 });
    const apples = await seedFile(h.deps.db, { titleId: 'movie-1', host: HOST, path: await present('Bad.Apples.mkv'), durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: apples, host: HOST, positionS: 5900, durationS: 6000, startedAt: daysAgo(4) });
    expect(await cont({ title: 'bad apples' })).toMatchObject({ action: 'nothing', reason: 'finished' });
    // Two matches, one played: the played one wins.
    expect(await cont({ title: 'bad' })).toMatchObject({ action: 'nothing', title: { id: 'movie-1' } });
    await seedTitle(h.deps.db, { id: 'movie-3', kind: 'movie', tmdbId: 3, title: 'Badlands', year: 1973 });
    // Badlands has no file on this host: a film that is not finished and not present is missing.
    expect(await cont({ title: 'badl' })).toMatchObject({ action: 'missing', title: { id: 'movie-3' } });
    expect(await cont({ title: 'nothing like this' })).toEqual({ action: 'no_match', query: 'nothing like this' });
  });

  it('answers ambiguous when several unplayed titles match', async () => {
    await seedTitle(h.deps.db, { id: 'movie-10', kind: 'movie', tmdbId: 10, title: 'Over Your Dead Body', year: 2026 });
    await seedTitle(h.deps.db, { id: 'movie-11', kind: 'movie', tmdbId: 11, title: 'Over the Hedge', year: 2006 });
    const out = await cont({ title: 'over' });
    expect(out).toMatchObject({ action: 'ambiguous', query: 'over' });
    expect((out.candidates as unknown[]).length).toBe(2);
  });
});
```

**File:** `tests/integration/movies.recents.int.test.ts` (new)
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { movieFiles, moviePlays } from '../../src/db/schema.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { nodeRecentsFs, recentsSyncHook, type TitleResolver } from '../../src/movies/vlc/recents.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedFile, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HOST = 'this-host';
const INI = [
  '[RecentsMRL]',
  'list=file:///C:/Users/u/Videos/Known.Film.2026.1080p.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv, file:///C:/Users/u/Downloads/Telegram%20Desktop/Moved.Film.2025.mkv, https://example.com/live',
  'times=1307375, 6684192, -1, 0',
].join('\n');

const resolver: TitleResolver = {
  match: async () => ({ kind: 'matched', tmdbKind: 'movie', tmdbId: 1001, confidence: 0.97 }) as never,
  details: async () => {
    throw new Error('the title is seeded; details must not be fetched');
  },
};

describe('[RecentsMRL] sync hook', () => {
  let h: ApiHarness;
  let dir: string;

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-recents-'));
  });

  it('records positions for known files, keeps a gone film under its title, and records nothing twice (R4.4)', async () => {
    const db = h.deps.db;
    await seedTitle(db, { id: 'movie-1', kind: 'movie', tmdbId: 1, title: 'Known Film', year: 2026 });
    await seedTitle(db, { id: 'movie-1001', kind: 'movie', tmdbId: 1001, title: 'The Dog Stars', year: 2026, runtimeMin: 120 });
    await seedTitle(db, { id: 'movie-2', kind: 'movie', tmdbId: 2, title: 'Moved Film', year: 2025 });
    const known = await seedFile(db, { titleId: 'movie-1', host: HOST, path: '/mnt/c/Users/u/Videos/Known.Film.2026.1080p.mkv', durationS: 7200 });
    const moved = await seedFile(db, { titleId: 'movie-2', host: HOST, path: '/mnt/c/Users/u/Videos/Done/Moved.Film.2025.mkv', durationS: 6000 });
    const iniPath = path.join(dir, 'vlc-qt-interface.ini');
    await writeFile(iniPath, INI);
    const deps = { iniPath, roots: ['/mnt/c/Users/u/Videos', '/mnt/c/Users/u/Downloads/Telegram Desktop'], host: HOST, repo: new MoviesRepo(db), resolver, fs: { ...nodeRecentsFs, exists: async () => false }, log: () => {} };

    const first = await recentsSyncHook(deps).run();
    expect(first).toMatchObject({ observed: 3, created: 1 });

    const plays = await db.select().from(moviePlays).orderBy(asc(moviePlays.id));
    expect(plays.find((p) => p.fileId === known)).toMatchObject({ source: 'vlc_recents', positionS: 1307.375, durationS: 7200 });
    expect(plays.find((p) => p.fileId === moved)).toMatchObject({ source: 'vlc_recents', positionS: null });
    const [dog] = await db.select().from(movieFiles).where(eq(movieFiles.titleId, 'movie-1001'));
    expect(dog).toMatchObject({ host: HOST, source: 'vlc_recents', name: 'The.Dog.Stars.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv' });
    expect(dog!.deletedAt).not.toBeNull();
    expect(plays.find((p) => p.fileId === dog!.id)).toMatchObject({ positionS: 6684.192, durationS: 7200 });
    expect(await db.select().from(movieFiles)).toHaveLength(3); // the moved file was found by name, no duplicate

    expect((await recentsSyncHook(deps).run()).observed).toBe(0); // a fresh process: positions unchanged
    expect(await db.select().from(moviePlays)).toHaveLength(plays.length);
    await rm(dir, { recursive: true, force: true });
  });
});
```

## Principles applied

- Laziness protocol: playback reuses `src/http/reveal.ts`'s `WSL_INTEROP_FILES`, `findOnPath`, `nodeProbe`, `onceAsync`, `runWslpath` and `spawnDetached` unchanged. `MoviePlayer` takes no media-change detection. The brief's port "reuse" rule collapses to "free = nothing answers" (Design decision 5), because a fresh per-launch password can never be answered by a live VLC.
- Boundary discipline: route params and the continue body are validated once with zod in `moviesPlayApi.ts`. curl's exit code and output become a typed `VlcReply` in one place (`interpretCurl`). The ini becomes typed `RecentsEntry` rows in `parseRecents`. The player and the hook trust those types.
- Make illegal states unrepresentable: `PlayerDetection` is either `{ available: true, env }` or `{ available: false, reason }`, and `VlcReply` and `ContinueResult` are discriminated unions. A `missing` result always names its episode ref, and `VlcLauncher` has no stop method, so "notesd never kills a VLC" is a type fact, not a rule.
- Test behavior, not implementation: the player is tested through fakes at the process boundary (`MemVlc` as launcher and reader, an in-memory repo), and the tests assert the rows and argv a caller sees. The integration tests drive a real child process over real `curl`. The continue rule is the pure `decideContinue`, tested on data.
- Prove it works: `fake-vlc.mjs` speaks VLC's real status API (Basic auth, `pl_play`, `seek`, `stopped` reads 0/0, exit means connection refused), so the routes, curl and the rows are proven end to end. One manual journey covers the real `vlc.exe`.
- Sequence into verifiable units: Steps 1-3 (pure modules plus unit tests), then Step 4 (repo), Step 5 (player plus unit test), Step 6 (continue plus unit test), Steps 7-9 (routes, capabilities, wiring), Step 12 (integration). Each step has a test that can fail.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: `tests/unit/movies/*.test.ts` among them) and `npm run test:int` (includes
`tests/integration/movies.play.int.test.ts`, `movies.continue.int.test.ts`, `movies.recents.int.test.ts`,
and the updated `reveal.int.test.ts`)
**Proof:** the integration journeys drive the real routes, a real child process (the fake
`vlc.exe`) and the real `curl` against the test Postgres. The harness journeys drive a throwaway
daemon built from this checkout, with the fake VLC behind `NOTESD_VLC_BIN`.

- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`) for J9-J11; the `npm run test:int` journeys need Docker only.
- Feature-map entries: none in this phase. `features/movies.md` is Phase 8's (see Handoffs), and no existing entry covers movies.
- Journeys:
  - **J1** · traces R4.1 — `npm run test:int -- tests/integration/movies.play.int.test.ts -t "R4.1"` → passes when both tests pass: the fake VLC's argv carries `--start-time=1200`, our port and a 32-hex password, the fake (which starts stopped and ignores `--start-time`) then reports `playing` at `time >= 1200` (so notesd sent `pl_play` and `seek`), and a file last played at 7000/7200 s launches with `--start-time=0`
  - **J2** · traces R4.2 — `npm run test:int -- tests/integration/movies.play.int.test.ts -t "R4.2"` → passes when the `movie_plays` row reaches `position_s > 1260`, `duration_s = 7200` with `ended_at` null while the fake plays, and `GET /api/movies/player` shows that `play_id` as `playing`
  - **J3** · traces R4.3 — `npm run test:int -- tests/integration/movies.play.int.test.ts -t "R4.3"` → passes when, after `GET /fake/quit` makes the fake VLC exit, the row gets `ended_at` with `position_s` >= the last polled value (and < +120 s), and `GET /api/movies/player` returns `current: null`
  - **J4** · traces R3.7 — `npm run test:int -- tests/integration/movies.play.int.test.ts -t "R3.7"` → passes when `POST /api/movies/files/<id>/play` for a file with `host = 'other-laptop'` answers 404 `{ error: 'not_on_this_machine', host: 'other-laptop' }` and the fake VLC launch log stays empty
  - **J5** · traces R4.5 — `npm run test:int -- tests/integration/movies.play.int.test.ts -t "R4.5"` plus `npx vitest run tests/unit/movies/vlc.launch.test.ts` → passes when play answers 409 `{ error: 'player_unavailable', reason: 'no_vlc' }`, `GET /api/capabilities` is `{ reveal: false, movies_playback: false }` (and `true` with a working player), `GET /api/movies/player` is `{ available: false, reason: 'no_vlc', current: null }`, and the unit test reports `no_interop`, `no_wslpath`, `no_vlc` and `no_curl` for each missing piece
  - **J6** · traces R4.4 — `npm run test:int -- tests/integration/movies.recents.int.test.ts` → passes when the known file gets a `vlc_recents` play at 1307.375 s, the moved file (found by name) gets one with `position_s` null, The Dog Stars becomes a deleted `vlc_recents` file under `movie-1001` with a play at 6684.192 s of 7200, `movie_files` has 3 rows, and a second hook process records nothing
  - **J7** · traces R6.1 — `npm run test:int -- tests/integration/movies.continue.int.test.ts -t "R6.1"` → passes when `{ "title": "mobland" }` resumes S1E2 at 1000 s (launch `startTime` 1000). After E2 finishes it answers `missing` S1E3 "Alliance" with `present` [S1E4], and once an E3 file exists it answers `started` S1E3 at 0
  - **J8** · traces R6.2 — `npm run test:int -- tests/integration/movies.continue.int.test.ts -t "R6.2"` → passes when `POST /api/movies/continue {}` resumes `movie-555` (the title of the newest play) at 1896 s
  - **J9** · traces R4.1, R4.2, R4.3, R3.7 — on a throwaway daemon with the fake VLC (commands below, "Harness setup") → passes when `$V api $RUN POST /api/movies/files/501/play` answers 202 with `"start_position":1200,"tracking":true`. `$V sql $RUN "select position_s, duration_s, ended_at from movie_plays where file_id=501 order by id desc limit 1"` then shows `position_s > 1200`, `duration_s = 7200` and `ended_at` empty, and after `curl -s http://127.0.0.1:47390/fake/quit` the same query shows `ended_at` set within 3 s. `$V api $RUN POST /api/movies/files/502/play` answers 404 `not_on_this_machine` with `"host":"other-laptop"`, and `wc -l < $S/launches.jsonl` stays `1`
  - **J10** · traces R6.1, R6.2 — on the J9 run, after J9 → passes when `$V api $RUN POST /api/movies/continue '{}'` answers 200 `"action":"resumed"`, `"title":{"id":"movie-900001",...}` with `position` equal to the `position_s` J9 left, `$S/launches.jsonl` gains a line whose argv has `--start-time=<that position, floored>`, and `$V api $RUN POST /api/movies/continue '{"title":"fake film"}'` answers `resumed` for the same title
  - **J11** · traces R4.5 — a second throwaway daemon with `NOTESD_VLC_BIN=$S/no-such-vlc.exe` (other exports as J9) → passes when `$V api $RUN2 GET /api/capabilities` prints `"movies_playback":false`, `$V api $RUN2 GET /api/movies/player` prints `"available":false,"reason":"no_vlc"`, and `$V api $RUN2 POST /api/movies/files/501/play` (after seeding the same rows) answers 409 `player_unavailable` / `no_vlc`
  - **J12** · traces R4.1, R4.2, R4.3 — **MANUAL, owner only, real machine and real `vlc.exe`** (it opens a VLC window; a verifier agent marks it `inconclusive`, never runs it). Run "Harness setup" without the `NOTESD_VLC_BIN`, `NOTESD_CURL_EXE`, `NOTESD_VLC_HTTP_PORT` and `FAKE_VLC_*` exports, so the defaults are the real `vlc.exe` and `curl.exe` on 47318. Seed row 501 with `path` = one real film under `/mnt/c/Users/mahfu/Videos/` (read-only use) and its real `duration_s`, then `$V api $RUN POST /api/movies/files/501/play` → passes when a new VLC window opens on that film at 20:00 and plays, with no "Continue playback?" bar and no privacy dialog, and an already open VLC of the owner's is untouched. 15 s later `position_s` is about 1215. Closing the window sets `ended_at` within 10 s at about the closing second. Play again, then `$V down $RUN`: the VLC window stays open
- Harness setup (J9-J11):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/movies-library
  V=.claude/skills/verify-notesd/scripts/verify.sh
  S=<your scratchpad>/movies-p5 && mkdir -p "$S/roots" "$S/lib"
  head -c 1024 /dev/zero > "$S/lib/Fake.Film.2026.1080p.mkv"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$PWD/tests/fixtures/movies/fake-vlc.mjs" > "$S/vlc.exe" && chmod +x "$S/vlc.exe"
  export NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$S/roots" NOTESD_MOVIES_SCAN_MS=86400000 \
         TMDB_API_READ_ACCESS_TOKEN= TMDB_API_KEY= \
         NOTESD_VLC_BIN="$S/vlc.exe" NOTESD_CURL_EXE=/usr/bin/curl NOTESD_VLC_HTTP_PORT=47390 NOTESD_VLC_POLL_MS=500 \
         FAKE_VLC_LOG="$S/launches.jsonl" FAKE_VLC_SPEED=60
  $V up                                  # note RUN=...
  H=$(hostname)
  $V exec $RUN "insert into movie_titles (id, kind, tmdb_id, title, original_title, year, overview, genres, metadata_fetched_at, created_at, updated_at) values ('movie-900001','movie',900001,'Fake Film','Fake Film',2026,'','[]'::jsonb,now(),now(),now())"
  $V exec $RUN "insert into movie_files (id, title_id, host, path, name, size, duration_s, status, source, first_seen_at, last_seen_at, updated_at) values (501,'movie-900001','$H','$S/lib/Fake.Film.2026.1080p.mkv','Fake.Film.2026.1080p.mkv',1024,7200,'matched','scan',now(),now(),now()), (502,'movie-900001','other-laptop','/mnt/c/x/Fake.Film.2026.1080p.mkv','Fake.Film.2026.1080p.mkv',1024,7200,'matched','scan',now(),now(),now())"
  $V exec $RUN "insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at) values (501,'$H','live',now()-interval '1 day',now()-interval '1 day',0,1200,7200,now()-interval '1 day')"
  $V sql $RUN "select id, deleted_at from movie_files order by id"   # both deleted_at empty before driving
  ```
  `$V down $RUN` when done. J11's run uses the same commands with `NOTESD_VLC_BIN="$S/no-such-vlc.exe"`.
- Neighbor check: reveal and capabilities. `npx vitest run tests/unit/reveal.test.ts` and `npm run test:int -- tests/integration/reveal.int.test.ts` pass, and `$V api $RUN GET /api/capabilities` on the J9 run prints both `"reveal":` and `"movies_playback":true`.
- Cost: none (no LLM turns, no network; TMDB is blanked in the harness runs).

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass, J1-J11 pass, and J12 is
listed for the owner. On a throwaway daemon, a play of a file of this host starts the fake VLC at the
resume second, the play row advances while it plays and closes when it exits, and continue resumes the
title of the newest play.

## Handoffs

- **Phase 6 (web):** read `movies_playback` from `GET /api/capabilities`. Today
  `web/src/api.ts` `Capabilities` is `{ reveal }`, and `useCapabilities.ts`'s `publish` only
  compares `reveal`, so both need the new key. Disable Play/Resume with a tip when it is false,
  or when the file's `available` is false (Phase 4's read model). Call
  `POST /api/movies/files/:fileId/play` and `POST /api/movies/continue` with the wire types in
  the Interface Contract. Show `tracking: false` (`note: 'http_timeout'`) as "VLC opened but
  notesd cannot follow it". Poll `GET /api/movies/player` while a detail page is open. The
  server emits MovieEvents `changed` only when a play starts or ends.
- **Phase 7 (MCP):** `movies_continue` calls `continueTitle({ db: deps.db, player }, title ?? null)`,
  with `player = deps.moviesPlayer`. Without a player it answers `movies_off`, and it maps
  `PlayError.code` like `playErrorResponse` does. This means `mcpToolDeps` / `ToolDeps.movies`
  must carry `deps.moviesPlayer`, which is the `AppDeps.moviesPlayer` field this phase adds.
  The MCP half of R6.1/R6.2 is proven there.
- **Phase 8 (docs/verify):** write `features/movies.md` playback journeys from J9-J11 and the
  "Harness setup" block. The fixture `tests/fixtures/movies/fake-vlc.mjs` is the fake VLC for
  `verify.sh` (a `--movies` flag could write the wrapper and the exports). Document
  `NOTESD_VLC_*`, `NOTESD_CURL_EXE`, the three routes and `movies_playback` in the README, and
  put `NOTESD_VLC_INI=/mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini` into the live
  `.env.local`. The passive layer is off while it is null.
- **Phase 8 (post-deploy):** the launcher starts VLC through `systemd-run --user --scope` when notesd
  runs as a systemd service (Design decision 8), so `systemctl --user restart notesd` must leave a
  notesd-started VLC playing. Phase 8's post-merge step checks it once on the live daemon.
- **Phases 1 and 3:** reconciled. Phase 1 owns `closeOpenPlays` / `findTrackedFile`; Phase 3's
  `MovieEvents.changed('play', ...)`, `SyncHook.afterScan` returning a row count, and its `TitleResolver`
  are used as quoted under Requires. The service is not null merely because roots are empty.

## Rollback

Revert this phase's commit. It adds `src/movies/vlc/*`, `player.ts`, `continue.ts`, tests and
fixtures. It fills the body of `moviesPlayApi.ts` (Phase 1's empty router comes back), and it
reverses the small edits to `reveal.ts` (capabilities back to `{ reveal }`), `deps.ts`,
`daemon.ts`, `repo.ts` (three appended methods) and `reveal.int.test.ts`. No migration, no data
change: play rows written by the player stay valid `movie_plays` rows. To stop playback without
a revert, set `NOTESD_VLC_BIN` to a path that does not exist (capabilities report
`movies_playback: false`), and unset `NOTESD_VLC_INI` to stop the recents backfill.

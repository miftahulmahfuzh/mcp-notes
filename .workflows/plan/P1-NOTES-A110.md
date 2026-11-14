> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/movies-library/PLAN.md` phase 9. Source: `.workflows/plan/movies-library/phase-9.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 9: VLC health log, hang detection, crash incidents

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R8 — let the owner tell a VLC memory leak during a long pause apart from a Windows fault (graphics driver, Terminal) after the next WSL crash
**Criteria:** R8.1, R8.2, R8.3, R8.4, R8.5
**Depends on:** Phase 5 (and through it Phases 1, 2 and 3)
**Difficulty:** NORMAL
**Package:** `src/movies/vlc` (`health.ts`, `incidents.ts`), `src/movies/player.ts`, `src/http/moviesPlayApi.ts`

---

## Goal

After this phase, while any `vlc.exe` runs on this host, notesd appends one JSON line per VLC every
`NOTESD_VLC_HEALTH_MS` (default 30 s) to `<NOTES_DATA_DIR>/movies/vlc-health-<host>.jsonl`, with
pid, working set, private bytes, handle count and, for the VLC whose play notesd is following, its
state and seconds paused. Every line is fsync'd, so a VM crash keeps it. When the daemon starts after
a run that died while it was sampling a VLC, it writes one incident line. The incident holds the
last samples and the Windows "Application Error" (1000) and "Application Hang" (1002) events from
10 minutes before the last sample to 15 minutes after it. A VLC that notesd started and that stops
answering while its process still exists gets a `hang` line, and its play stays open at the last
position. `NOTESD_VLC_EXTRA_ARGS` reaches every VLC launch. `GET /api/movies/player/health` returns
this host's recent samples, per-VLC run summaries (including growth per paused minute), hangs and
incidents.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**

- `src/movies/vlc/health.ts`:
  - constants `TASKLIST_ENV = 'NOTESD_TASKLIST_EXE'`, `POWERSHELL_ENV = 'NOTESD_POWERSHELL_EXE'`,
    `DEFAULT_TASKLIST_EXE = '/mnt/c/Windows/System32/tasklist.exe'`,
    `DEFAULT_POWERSHELL_EXE = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'`,
    `TASKLIST_TIMEOUT_MS`, `POWERSHELL_TIMEOUT_MS`, `MAX_LOG_BYTES = 5 MiB`, `TAIL_BYTES = 256 KiB`,
    `REPORT_BYTES = 4 MiB`, `DEFAULT_REPORT_SAMPLES = 200`, `MAX_REPORT_SAMPLES = 2000`,
    `REPORT_HANGS = 50`, `REPORT_INCIDENTS = 20`, `INCIDENT_WAIT_ON_CLOSE_MS = 3000`, `CMD_MAX_CHARS = 600`,
    `PROCESS_SCRIPT`
  - record types (zod-inferred, snake_case, the log line and wire format): `SamplePlay`, `SampleRecord`,
    `StartRecord`, `IdleRecord`, `HangRecord`, `CleanStopRecord`, `WinFaultEvent`, `IncidentRecord`,
    `HealthRecord`, `PreviousRunKind`, `HangOutcome`
  - `HealthOffReason` (`'disabled' | 'not_linux' | 'no_interop' | 'no_tasklist'`), `HealthEnv`,
    `HealthDetection`, `VlcProcess`, `ProcessListing`, `ProcessLister`, `TrackedVlc`, `PidCheck`,
    `HangEvent`, `PlayerHealthLink`, `HealthStatus`, `VlcRunSummary`, `HealthReport`,
    `HealthMonitorDeps`, `VlcHealthOptions`
  - functions `safeHostName`, `healthLogPath`, `previousHealthLogPath`, `parseHealthLine`,
    `parseTasklistCsv`, `parsePowerShellProcesses`, `redactCommandLine`, `startedByNotesd`,
    `windowsProcessLister(env, exec?)`, `detectHealthEnv(probe)`, `sampleRecord`, `hangRecord`,
    `summarizeRuns`, `healthReport`, `buildVlcHealth(options)`
  - classes `HealthLog` (`file`, `previousFile`, `append(record)`, `readTail(maxBytes)`) and
    `HealthMonitor` (`start()`, `settled()`, `sampleNow()`, `processAlive(ep)`, `onHang(e)`,
    `status()`, `report(limit)`, `close()`)
- `src/movies/vlc/incidents.ts`: `INCIDENT_SAMPLES = 40`, `EVENTS_BEFORE_MS = 10 min`,
  `EVENTS_AFTER_MS = 15 min`, `EVENTS_TIMEOUT_MS`, `EVENT_MESSAGE_CHARS = 500`, `PreviousRun`,
  `UncleanSampling`, `EventsResult`, `EventLogReader`, `analyzePreviousRun(records)`,
  `incidentWindow(previous, now)`, `lastJsonLine(stdout)`, `powershellArgs(script)`,
  `eventsScript(from, to)`, `exceptionCode(v)`, `parseWinEvents(stdout)`,
  `powershellEventLogReader(bin, exec?)`, `buildIncident(input)`
- `src/movies/player.ts` (Phase 5's file): `HANG_AFTER_SILENT_POLLS = 2`,
  `MoviePlayerDeps.health?: PlayerHealthLink`, `MoviePlayerDeps.now?: () => Date`,
  `MoviePlayer.healthView(): TrackedVlc | null`, `PlaybackOverrides.health?: PlayerHealthLink`
- `src/config.ts`: `DEFAULT_VLC_HEALTH_MS = 30_000`, `MIN_VLC_HEALTH_MS = 5_000`,
  `VlcConfig.healthMs: number`, `VlcConfig.extraArgs: string[]` (the index's Shared contract rows)
- `src/deps.ts`: `AppDeps.moviesHealth?: HealthMonitor | null` (optional, so no `AppDeps` literal changes)
- route `GET /api/movies/player/health` in `src/http/moviesPlayApi.ts`
- env vars `NOTESD_VLC_HEALTH_MS`, `NOTESD_VLC_EXTRA_ARGS` (contract), and `NOTESD_TASKLIST_EXE`,
  `NOTESD_POWERSHELL_EXE` (read through `DetectProbe.env`, like `NOTESD_EXPLORER_BIN`; not in `Config`)
- log files `<dataDir>/movies/vlc-health-<host>.jsonl` and `<dataDir>/movies/vlc-health-<host>.1.jsonl`
- test fixtures `tests/fixtures/movies/fake-windows.mjs`; `GET /fake/hang?ms=` in Phase 5's
  `tests/fixtures/movies/fake-vlc.mjs`

**Wire format (Phase 8 documents it; nothing else consumes it in this plan set):**

```ts
// GET /api/movies/player/health?limit=1..2000   (read only, no Origin check)
//   200 HealthReport
//   400 { error: 'invalid_limit', message }
//   503 { error: 'movies_off', message }        // deps.moviesHealth is null (NOTESD_MOVIES=off)
interface HealthReport {
  host: string;
  sampling: boolean;                                         // the monitor runs and writes samples
  reason: 'disabled' | 'not_linux' | 'no_interop' | 'no_tasklist' | 'not_started' | null;
  interval_ms: number;                                       // NOTESD_VLC_HEALTH_MS
  process_detail: boolean;                                   // powershell.exe found: private bytes, handles, command line
  log_file: string;
  samples: SampleRecord[];                                   // the newest `limit` (default 200), oldest first
  runs: VlcRunSummary[];                                     // one per VLC process seen in the read window
  hangs: HangRecord[];                                       // newest 50
  incidents: IncidentRecord[];                               // newest 20
  last_start: StartRecord | null;
}
interface SampleRecord {
  kind: 'sample'; ts: string; host: string; pid: number;
  ws_bytes: number; private_bytes: number | null; handles: number | null; proc_started_at: string | null;
  ours: boolean | null;          // started by notesd (its command line has notesd's HTTP flags); null: no command line
  play: SamplePlay | null;       // only on the VLC of the play notesd is following now
  cmd: string | null;            // the redacted command line, on the first sample of each pid only
}
interface SamplePlay {
  play_id: number; file_id: number; name: string; state: 'playing' | 'paused' | 'stopped';
  position_s: number; paused_s: number | null; http_silent_s: number | null; hung: boolean;
}
interface HangRecord {
  kind: 'hang'; ts: string; host: string; phase: 'start' | 'end'; pid: number | null; port: number;
  play_id: number; file_id: number; name: string; position_s: number; silent_s: number;
  outcome: 'answered' | 'exited' | 'tracking_ended' | null;   // null on 'start'
}
interface IncidentRecord {
  kind: 'incident'; ts: string; host: string;
  previous_start_at: string | null; last_record_at: string; last_sample_at: string;
  window: { from: string; to: string };
  samples: SampleRecord[];      // the last 40 samples of the dead run, oldest first
  hangs: HangRecord[];          // the dead run's hang lines
  open_play: SamplePlay | null; // the play notesd followed at the last sample: its play row lost the tail after that
  events: WinFaultEvent[];
  events_error: string | null;
}
interface WinFaultEvent {
  time: string; event_id: number; provider: string;
  application: string | null; module: string | null; exception_code: string | null; message: string | null;
}
interface VlcRunSummary {
  pid: number; proc_started_at: string | null; ours: boolean | null;
  first_at: string; last_at: string; samples: number;
  ws_first: number; ws_last: number; ws_max: number;
  private_first: number | null; private_last: number | null; private_max: number | null; handles_max: number | null;
  paused_s_max: number | null;
  ws_growth_per_min: number | null; private_growth_per_min: number | null;                 // bytes per minute over the run
  ws_growth_per_paused_min: number | null; private_growth_per_paused_min: number | null;   // over paused-to-paused samples only
}
```

Log line kinds: `start`, `sample`, `idle` (the last `vlc.exe` went away), `hang`, `clean_stop`,
`incident`. One JSON object per line, each with `kind`, `ts` (ISO 8601 UTC) and `host`.

**Signature changes (all in Phase 5's code, additive, defaults keep Phase 5's behavior):**

- `vlcArgs(l: VlcLaunch)` -> `vlcArgs(l: VlcLaunch, extraArgs: readonly string[] = [])`
- `spawnVlcLauncher(opts: { scope?: boolean } = {})` -> `spawnVlcLauncher(opts: { scope?: boolean; extraArgs?: readonly string[] } = {})`
- `moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer'>)` -> `moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer' | 'moviesHealth'>)`
  (`moviesHealth` is optional on `AppDeps`, so every Phase 5 call site still compiles)
- `MoviePlayer`'s poll: with a `health` link, a silent poll (curl error, or exit 7 while the
  process lives) no longer ends the play. Without one, Phase 5's rules are unchanged.

**Requires (from earlier phases):** the code below assumes these exact shapes.

- Phase 1 `src/config.ts`: `VlcConfig` `{ bin, ini, httpPort, pollMs, curlExe }`, `DEFAULT_MOVIES_CONFIG`,
  `parseMovies` with the `vlc: { ... }` block, `parsePositiveInt`, `ConfigError`, no semicolons.
  Phase 1's `tests/unit/config.test.ts` `describe('movies config')` with its two `toEqual` cases and
  the `it.each` rejects list.
- Phase 1 README env rows, ending with the `NOTESD_CURL_EXE` and `NOTESD_MOVIES_FALLBACK_MODEL` rows.
- Phase 3 `src/movies/service.ts`: `MOVIES_SUBDIR = 'movies'`, `MoviesService.host`; `src/daemon.ts`
  builds `const movies = buildMoviesService(config, db);` before the `deps` literal.
- Phase 5 (as `phase-5.md` reads after reconciliation): `src/movies/vlc/launch.ts` `vlcArgs`,
  `spawnVlcLauncher({ scope? })`, `VlcLaunch`; `src/movies/vlc/http.ts` `ExecFn`, `execCapture`,
  `VlcEndpoint`, `VlcState`; `src/movies/player.ts` exactly as Phase 5 Step 5 (the `Tracked`
  interface, `tick`, `finish`, `MoviePlayerDeps`, `PlaybackOverrides`, `buildMoviePlayback` with
  `spawnVlcLauncher()` and `onChange: (file) => service.events.changed('play', ...)`);
  `src/http/moviesPlayApi.ts` with `MOVIES_OFF` and `moviesPlayRoutes`; `src/deps.ts`
  `moviesPlayer?: MoviePlayer | null`; the daemon block `const moviesPlayer: MoviePlayer | null = ...`
  and `await moviesPlayer?.close();` in `stop`; test fixtures `tests/fixtures/movies/fake-vlc.mjs`,
  `memVlc.ts`, `rows.ts` and `tests/integration/helpers/moviesPlaySeed.ts`
  (`truncateMovies`, `seedTitle`, `seedFile`). If Phase 5 lands with different names, the
  reconciler maps the call sites; the logic stays the same.

**Leaves alone (owned by others):** `web/**` (Phase 6), `src/mcp/**`, `src/chat/**`,
`claude/skills/**` (Phase 7), `src/http/app.ts`, `src/db/schema.ts`, `drizzle/**` (no table: the log
must survive an unreachable database and a dead VM), `CLAUDE.md`, README tour and HTTP API table,
`.claude/skills/verify-notesd/**` (Phase 8). It never kills, pauses or restarts a VLC: the monitor
only runs `tasklist.exe` and read-only PowerShell queries.

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts` | modify (Phase 1's movie block: constants after `DEFAULT_CURL_EXE`, `VlcConfig`, `DEFAULT_MOVIES_CONFIG.vlc`, helpers after `parseTcpPort`, `parseMovies` `vlc:` block, `loadConfig` doc) | `healthMs`, `extraArgs` |
| `src/movies/vlc/incidents.ts` | create | previous-run analysis, Windows event reader, incident record |
| `src/movies/vlc/health.ts` | create | log file, process lister, monitor, report |
| `src/movies/vlc/launch.ts` | modify (Phase 5 Step 1: `vlcArgs`, `spawnVlcLauncher`) | extra args before the file |
| `src/movies/player.ts` | modify (Phase 5 Step 5: imports, constants, `MoviePlayerDeps`, `Tracked`, the `Tracked` literal in `playNow`, `current()` neighbour, `tick`, `finish`, `PlaybackOverrides`, `buildMoviePlayback`) | hang rule, paused clock, `healthView()` |
| `src/http/moviesPlayApi.ts` | modify (Phase 5 Step 7: imports, signature, one route before `return r;`) | `GET /api/movies/player/health` |
| `src/deps.ts` | modify (after Phase 5's `moviesPlayer` member) | `moviesHealth?: HealthMonitor \| null` |
| `src/daemon.ts` | modify (Phase 5's player block, the `deps` literal, after `boundPort = port;`, `stop`) | build, start and close the monitor |
| `README.md` | modify (env table, after Phase 1's `NOTESD_CURL_EXE` row) | four rows |
| `tests/fixtures/movies/fake-windows.mjs` | create | fake `tasklist.exe` / `powershell.exe` |
| `tests/fixtures/movies/fake-vlc.mjs` | modify (Phase 5 Step 10: header comment, request handler) | `GET /fake/hang?ms=` |
| `tests/unit/config.test.ts` | modify (Phase 1's `describe('movies config')`) | new fields, parse and reject cases |
| `tests/unit/movies/vlc.extraArgs.test.ts` | create | argv order |
| `tests/unit/movies/vlc.health.test.ts` | create | lister parsing, log, monitor, report |
| `tests/unit/movies/vlc.incidents.test.ts` | create | previous-run rules, event parsing, incident at start |
| `tests/unit/movies/player.hang.test.ts` | create | the hang rule against `MemVlc` |
| `tests/integration/movies.health.int.test.ts` | create | fake VLC over real curl: extra args, paused sample, hang, route |
| `tests/integration/movies.healthCrash.int.test.ts` | create | a real daemon SIGKILLed while sampling, then restarted |

## Design decisions (read before Step 1)

1. **What the 13:03 crash leaves to distinguish.** The index's Decisions row says the leak is a
   hypothesis. A leak shows as private bytes and working set growing between consecutive samples
   while the tracked VLC is `paused` (`private_growth_per_paused_min`). A driver fault shows as
   Application Error events naming a module (`igd10umt64xe.DLL`, 0xc0000005) in the incident, and
   no growth. Hang events (1002) name the application that stopped pumping messages.
2. **Cheapest steady state (MEASURED 2026-11-14 on this host).** `tasklist.exe /FI "IMAGENAME eq vlc.exe" /FO CSV /NH`
   takes 0.16 s and prints `INFO: No tasks are running ...` when there is no VLC.
   `powershell.exe -NoProfile -NonInteractive -EncodedCommand` with `Get-CimInstance Win32_Process`
   takes 0.32-0.47 s. Each tick runs tasklist only. PowerShell runs only when tasklist lists a
   `vlc.exe`, once per tick for all of them (`ConvertTo-Json -InputObject @(...)` keeps the array).
   With no VLC open, which is most of the day, a tick is one 0.16 s process every 30 s and writes nothing.
3. **Units (MEASURED).** `Win32_Process.PrivatePageCount` equals `Get-Process PrivateMemorySize64`
   in bytes (267444224 = 267444224 for explorer.exe). `WorkingSetSize` is bytes. tasklist's
   "Mem Usage" is KB with a locale separator, so only its digits are used, times 1024.
4. **Script transport.** Scripts go as `-EncodedCommand` (base64 of UTF-16LE), so no quote survives
   WSL interop's command-line rebuild. `$ProgressPreference='SilentlyContinue'` keeps CLIXML
   progress records out (seen on the first probe). The parser takes the last line that starts
   with `[` or `{`.
5. **Event time window (MEASURED).** `Get-WinEvent -FilterHashtable` with `StartTime` as a UTC
   `DateTime` returned nothing for the 13:03 crash. The same window as
   `[DateTimeOffset]::Parse('<iso>').LocalDateTime` returned the three events. The script uses
   `LocalDateTime`. For event 1000 the measured `Properties` are `[0]` application, `[3]` faulting
   module, `[6]` exception code (`c0000005`), `[8]` pid. For 1002 only `[0]` application is read.
   Codes are normalized to `0xc0000005`. The message is kept, cut to 500 chars.
6. **Window.** From 10 min before the last sample to 15 min after the last line the dead run
   wrote. If the daemon starts earlier than that, the window ends at its start. A WSL crash
   restarts the VM within minutes (uptime 3 min after the 13:03 crash). Days later the window
   still ends 15 min after the death, so later noise stays out. Events are also filtered by this
   window in TypeScript (`buildIncident`), so the fake event log can prove it.
7. **"Unclean stop while sampling".** `start` reads the last 256 KiB of the log (falling back into
   the rotated file). Of the lines after the last `start`, it takes the newest `sample`, `idle` or
   `clean_stop`. `clean_stop` means clean. `idle`, or nothing at all, means unclean but not while a
   VLC was sampled: no incident, and `start.previous` says `unclean_idle`. `sample` means an
   incident. Hang and incident lines do not count as state. A heartbeat line every tick without a
   VLC is not needed: `idle` is written once, when the last VLC disappears.
8. **Durability.** Each line is written with `open('a+')`, `writeSync`, `fsyncSync`, `close`. The
   page cache dies with the VM, and fsync of ~400 bytes every 30 s costs nothing. A crash
   mid-write can leave a torn last line. Before the next append, a missing final `\n` is added, and
   the reader skips lines that do not parse.
9. **Rotation.** When an append would push the file past 5 MiB, the file is renamed to
   `.1.jsonl` (replacing the previous one) first. 5 MiB is about 4 days of one VLC playing
   continuously at 30 s (~400 B per sample), and twice that with the previous file.
10. **Our VLC, the tracked VLC, redaction.** A VLC is `ours` when its command line has
    `--extraintf http` and a 32-hex `--http-password` (Phase 5's flags). The tracked one is the
    VLC whose command line contains the current play's password: the password is matched in
    memory and never written. `cmd` is logged once per pid, with `--http-password ***`, cut to
    600 chars. Without PowerShell there is no command line, so `ours` is `null` and no sample has
    a `play`.
11. **Seconds paused.** The player stamps `pausedSince` on the first poll that reads `paused` and
    clears it on any other state. A sample reports `paused_s = now - pausedSince`. The error is
    under one poll interval (5 s).
12. **Hang rule (R8.3).** A poll is silent when curl fails (timeout 28: a hung VLC whose socket the
    OS still accepts) or answers exit 7 while the process still exists. With a health link, after
    `HANG_AFTER_SILENT_POLLS` (2) silent polls the player asks the monitor whether the VLC's
    process (found by password in its command line) lives. Alive: one `hang` start line, and the
    play stays open at its last position for as long as the VLC stays silent, past Phase 5's
    `MAX_READ_ERRORS`. Gone: the play ends `exited`, as in Phase 5. Unknown (no PowerShell, list
    failed): a silent exit-7 poll ends the play at once and curl errors count to `MAX_READ_ERRORS`,
    which is Phase 5's rule. The next answering poll writes `hang` end `answered`, and polling
    records again. An exit while hung writes `hang` end `exited`, and a replace or shutdown writes
    `tracking_ended`. Two silent polls, rather than one, keep a VLC that is closing (socket shut,
    process not yet gone) from logging a false hang. notesd never sends a hung VLC a command.
13. **Health off.** `NOTESD_VLC_HEALTH_MS=0`, not Linux, no WSL interop or no `tasklist.exe`: the
    monitor logs one line and writes nothing. `processAlive` answers `unknown`, so the player keeps
    Phase 5's rules. A missing `powershell.exe` keeps sampling (pid and working set only) and
    writes incidents with `events_error`. With `NOTESD_MOVIES=off` no monitor is built, and with no
    `NOTESD_MOVIES_ROOTS` `buildVlcHealth` passes interval 0, so the monitor is off (invariant 5,
    reconciled). `DEFAULT_MOVIES_CONFIG` is off, so tests never build one unless they construct it.
14. **Start order.** The monitor is built before the player (the player needs its link) and reads
    the tracked play back through `moviesPlayer.healthView()`. It starts after the server listens,
    so a failed `listen` leaks no timer. The incident is written in the background (`settled()`
    awaits it), so a slow PowerShell never delays startup. `stop` closes the player first (its hang
    end line is still written), then the monitor (`clean_stop`). A pending incident gets at most 3 s.
15. **The open play after a crash.** Phase 5's `MoviePlayer.start()` closes the dead run's open play
    at its last written position (`ended_at = updated_at`). The incident names that play
    (`open_play`: play id, file id, file name, state, position, seconds paused) from the last
    sample, so the owner can see which film was open and paused for how long when the VM died.
    The play row itself loses at most one poll interval.

## Implementation Steps

### Step 1: `healthMs` and `extraArgs` in the config
**File:** `src/config.ts`, Phase 1's movie block (Phase 1 Step 7: constants after `DEFAULT_CURL_EXE`,
`interface VlcConfig`, `DEFAULT_MOVIES_CONFIG`, the helpers after `parseTcpPort`, `parseMovies`, the
`loadConfig` doc comment).
**Change 1a:** after `export const DEFAULT_CURL_EXE = '/mnt/c/Windows/System32/curl.exe'` insert:
```ts
/** NOTESD_VLC_HEALTH_MS default: one vlc.exe sample every 30 s (src/movies/vlc/health.ts). */
export const DEFAULT_VLC_HEALTH_MS = 30_000
/** A non-zero NOTESD_VLC_HEALTH_MS below this is rejected: one PowerShell detail read takes ~0.5 s. */
export const MIN_VLC_HEALTH_MS = 5_000
```
**Change 1b:** in `interface VlcConfig`, after the `curlExe: string` member add:
```ts
  /**
   * `NOTESD_VLC_HEALTH_MS`: how often every vlc.exe on this host is sampled into the health log.
   * 0 turns the health log, crash incidents and hang detection off.
   */
  healthMs: number
  /**
   * `NOTESD_VLC_EXTRA_ARGS`, split on whitespace (no quoting): appended to every VLC notesd starts,
   * before the file. Never `--http-*`, `--extraintf`, `--intf` or `-I` (notesd owns the HTTP interface).
   */
  extraArgs: string[]
```
**Change 1c:** in `DEFAULT_MOVIES_CONFIG.vlc`, after `curlExe: DEFAULT_CURL_EXE,` add:
```ts
    healthMs: DEFAULT_VLC_HEALTH_MS,
    extraArgs: [],
```
**Change 1d:** after `function parseTcpPort(...)` insert:
```ts
function parseVlcHealthMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_VLC_HEALTH_MS
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || (value !== 0 && value < MIN_VLC_HEALTH_MS)) {
    throw new ConfigError(`NOTESD_VLC_HEALTH_MS must be 0 (off) or an integer of at least ${MIN_VLC_HEALTH_MS}, got "${raw}"`)
  }
  return value
}

/** notesd's own VLC flags: an extra argument may not replace them, or tracking breaks. */
const RESERVED_VLC_ARG = /^(--http-|--extraintf(=|$)|--intf(=|$)|-I$)/

function parseVlcExtraArgs(raw: string | undefined): string[] {
  const args = (raw ?? '')
    .trim()
    .split(/\s+/)
    .filter((a) => a !== '')
  for (const a of args) {
    if (RESERVED_VLC_ARG.test(a)) {
      throw new ConfigError(`NOTESD_VLC_EXTRA_ARGS must not set ${a}: notesd owns VLC's HTTP interface`)
    }
  }
  return args
}
```
**Change 1e:** in `parseMovies`, in the `vlc: { ... }` block, after
`curlExe: parseBin(env.NOTESD_CURL_EXE, DEFAULT_CURL_EXE),` add:
```ts
      healthMs: parseVlcHealthMs(env.NOTESD_VLC_HEALTH_MS),
      extraArgs: parseVlcExtraArgs(env.NOTESD_VLC_EXTRA_ARGS),
```
**Change 1f:** in the `loadConfig` doc comment, replace Phase 1's movie-keys sentence
```ts
 * NOTESD_CURL_EXE, NOTESD_MOVIES_FALLBACK_MODEL (relative roots or ini, a path as a Done folder
 * name, a non-http TMDB base or a port above 65535 throw ConfigError).
```
with
```ts
 * NOTESD_CURL_EXE, NOTESD_VLC_HEALTH_MS, NOTESD_VLC_EXTRA_ARGS, NOTESD_MOVIES_FALLBACK_MODEL
 * (relative roots or ini, a path as a Done folder name, a non-http TMDB base, a port above 65535,
 * a health interval of 1-4999 ms or an extra VLC arg that sets the HTTP interface throw ConfigError).
```
**Impact:** `VlcConfig` gains two required fields. Every `VlcConfig` value in the plan set is
`DEFAULT_MOVIES_CONFIG.vlc`, a spread of it, or `parseMovies`'s output, so no other literal breaks.
The only hand-written expectations are Phase 1's `toEqual` cases in `tests/unit/config.test.ts`,
which Step 9 updates in the same change.

### Step 2: incidents: previous-run analysis, Windows events, the incident record
**File:** `src/movies/vlc/incidents.ts` (new)
**Code:**
```ts
import { z } from 'zod';
import { execCapture, type ExecFn } from './http.js';
import type { HangRecord, HealthRecord, IncidentRecord, SamplePlay, SampleRecord, WinFaultEvent } from './health.js';

/** Samples of the dead run an incident keeps (20 min at the default 30 s). */
export const INCIDENT_SAMPLES = 40;
/** Windows events are read from this long before the last sample ... */
export const EVENTS_BEFORE_MS = 10 * 60_000;
/** ... to this long after the dead run's last line (or the daemon start, if sooner). */
export const EVENTS_AFTER_MS = 15 * 60_000;
export const EVENTS_TIMEOUT_MS = 20_000;
export const EVENT_MESSAGE_CHARS = 500;
/** Windows "Application Error" (a process crashed) and "Application Hang" (stopped responding). */
export const APPLICATION_ERROR_ID = 1000;
export const APPLICATION_HANG_ID = 1002;

/** How the previous daemon run ended, judged from the tail of the health log. */
export type PreviousRun =
  | { kind: 'none' }
  | { kind: 'clean'; stoppedAt: string }
  | { kind: 'unclean_idle'; lastRecordAt: string }
  | UncleanSampling;

/** The run died while a vlc.exe was being sampled: the case R8.2 writes an incident for. */
export interface UncleanSampling {
  kind: 'unclean_sampling';
  previousStartAt: string | null;
  lastRecordAt: string;
  lastSampleAt: string;
  samples: SampleRecord[];
  hangs: HangRecord[];
}

/**
 * Of the lines after the last `start`, the newest `sample` / `idle` / `clean_stop` decides:
 * clean_stop -> clean; idle or none -> unclean_idle (no VLC was being sampled); sample -> unclean_sampling.
 * Hang and incident lines are not state. An empty log is `none`.
 */
export function analyzePreviousRun(records: readonly HealthRecord[]): PreviousRun {
  if (records.length === 0) return { kind: 'none' };
  let startIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.kind === 'start') {
      startIdx = i;
      break;
    }
  }
  const run = records.slice(startIdx + 1);
  const previousStartAt = startIdx >= 0 ? (records[startIdx]?.ts ?? null) : null;
  const lastRecordAt = (run.length > 0 ? run[run.length - 1] : records[records.length - 1])?.ts ?? '';
  let lastState: HealthRecord | null = null;
  for (let i = run.length - 1; i >= 0; i--) {
    const r = run[i];
    if (r !== undefined && (r.kind === 'sample' || r.kind === 'idle' || r.kind === 'clean_stop')) {
      lastState = r;
      break;
    }
  }
  if (lastState === null || lastState.kind === 'idle') return { kind: 'unclean_idle', lastRecordAt };
  if (lastState.kind === 'clean_stop') return { kind: 'clean', stoppedAt: lastState.ts };
  const samples = run.filter((r): r is SampleRecord => r.kind === 'sample').slice(-INCIDENT_SAMPLES);
  const hangs = run.filter((r): r is HangRecord => r.kind === 'hang');
  return { kind: 'unclean_sampling', previousStartAt, lastRecordAt, lastSampleAt: lastState.ts, samples, hangs };
}

/** [last sample - 10 min, min(now, last line + 15 min)]; never empty. */
export function incidentWindow(prev: Pick<UncleanSampling, 'lastSampleAt' | 'lastRecordAt'>, now: Date): { from: Date; to: Date } {
  const from = Date.parse(prev.lastSampleAt) - EVENTS_BEFORE_MS;
  let to = Math.min(now.getTime(), Date.parse(prev.lastRecordAt) + EVENTS_AFTER_MS);
  if (!(to > from)) to = from + EVENTS_BEFORE_MS + EVENTS_AFTER_MS;
  return { from: new Date(from), to: new Date(to) };
}

/** The JSON a PowerShell script printed: its last line that starts with `[` or `{`. */
export function lastJsonLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (t.startsWith('[') || t.startsWith('{')) return t;
  }
  return null;
}

/** powershell.exe argv: the script as -EncodedCommand (UTF-16LE base64), so no quote is lost through WSL interop. */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/**
 * Application Error / Application Hang events between two instants as one JSON array.
 * MEASURED 2026-11-14: FilterHashtable needs local DateTimes (a UTC DateTime matched nothing).
 */
export function eventsScript(from: Date, to: Date): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$from = [DateTimeOffset]::Parse('${from.toISOString()}').LocalDateTime`,
    `$to = [DateTimeOffset]::Parse('${to.toISOString()}').LocalDateTime`,
    "$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error', 'Application Hang'; StartTime = $from; EndTime = $to } -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 1000 -or $_.Id -eq 1002 } | ForEach-Object { [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = [int]$_.Id; provider = $_.ProviderName; props = @($_.Properties | ForEach-Object { [string]$_.Value }); message = $_.Message } })",
    'ConvertTo-Json -InputObject $ev -Compress -Depth 3',
  ].join('\n');
}

/** `c0000005` / `0xC0000005` -> `0xc0000005`; anything else is kept as written. */
export function exceptionCode(v: string | null): string | null {
  if (v === null) return null;
  const hex = v.toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{1,8}$/.test(hex) ? `0x${hex.padStart(8, '0')}` : v;
}

const rawEventSchema = z.object({
  time: z.string(),
  id: z.number().int(),
  provider: z.string(),
  props: z.array(z.string().nullable()).nullable().optional(),
  message: z.string().nullable().optional(),
});
type RawEvent = z.infer<typeof rawEventSchema>;

function toFaultEvent(e: RawEvent): WinFaultEvent {
  const props = e.props ?? [];
  const at = (i: number): string | null => {
    const v = props[i];
    return v === undefined || v === null || v.trim() === '' ? null : v.trim();
  };
  const message = e.message === undefined || e.message === null ? null : e.message.slice(0, EVENT_MESSAGE_CHARS);
  if (e.id === APPLICATION_ERROR_ID) {
    // MEASURED 2026-11-14: [0] application, [3] faulting module, [6] exception code, [8] pid.
    return { time: e.time, event_id: e.id, provider: e.provider, application: at(0), module: at(3), exception_code: exceptionCode(at(6)), message };
  }
  return { time: e.time, event_id: e.id, provider: e.provider, application: at(0), module: null, exception_code: null, message };
}

/** eventsScript's stdout -> events (1000 and 1002 only); null when it is not that JSON. */
export function parseWinEvents(stdout: string): WinFaultEvent[] | null {
  const json = lastJsonLine(stdout);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = z.union([z.array(rawEventSchema), rawEventSchema]).safeParse(raw);
  if (!parsed.success) return null;
  const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return list.filter((e) => e.id === APPLICATION_ERROR_ID || e.id === APPLICATION_HANG_ID).map(toFaultEvent);
}

export type EventsResult = { kind: 'ok'; events: WinFaultEvent[] } | { kind: 'error'; message: string };

/** Reads the Windows Application log. Read only; never throws. */
export interface EventLogReader {
  read(from: Date, to: Date): Promise<EventsResult>;
}

export function powershellEventLogReader(powershell: string, exec: ExecFn = execCapture): EventLogReader {
  return {
    async read(from, to) {
      const r = await exec(powershell, powershellArgs(eventsScript(from, to)), EVENTS_TIMEOUT_MS);
      if (r.exitCode !== 0) return { kind: 'error', message: `powershell.exe exited ${r.exitCode}` };
      const events = parseWinEvents(r.stdout);
      return events === null ? { kind: 'error', message: 'unreadable Get-WinEvent output' } : { kind: 'ok', events };
    },
  };
}

/** One incident line: the dead run's last samples, its hangs, the play it followed, and the in-window events. */
export function buildIncident(input: {
  host: string;
  now: Date;
  previous: UncleanSampling;
  window: { from: Date; to: Date };
  events: EventsResult;
}): IncidentRecord {
  const fromMs = input.window.from.getTime();
  const toMs = input.window.to.getTime();
  const events =
    input.events.kind === 'ok'
      ? input.events.events
          .filter((e) => {
            const t = Date.parse(e.time);
            return t >= fromMs && t <= toMs;
          })
          .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      : [];
  let openPlay: SamplePlay | null = null;
  for (const s of input.previous.samples) {
    if (s.ts === input.previous.lastSampleAt && s.play !== null) openPlay = s.play;
  }
  return {
    kind: 'incident',
    ts: input.now.toISOString(),
    host: input.host,
    previous_start_at: input.previous.previousStartAt,
    last_record_at: input.previous.lastRecordAt,
    last_sample_at: input.previous.lastSampleAt,
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    samples: input.previous.samples,
    hangs: input.previous.hangs,
    open_play: openPlay,
    events,
    events_error: input.events.kind === 'error' ? input.events.message : null,
  };
}
```
**Impact:** none on existing code. Unit-tested in Step 11.

### Step 3: the health log, the Windows process lister and the monitor
**File:** `src/movies/vlc/health.ts` (new)
**Code:**
```ts
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MoviesConfig } from '../../config.js';
import { findOnPath, nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../../http/reveal.js';
import { MOVIES_SUBDIR } from '../service.js';
import { execCapture, type ExecFn, type VlcEndpoint, type VlcState } from './http.js';
import {
  analyzePreviousRun,
  buildIncident,
  incidentWindow,
  lastJsonLine,
  powershellArgs,
  powershellEventLogReader,
  type EventLogReader,
  type EventsResult,
  type UncleanSampling,
} from './incidents.js';

/** Override for tasklist.exe (authoritative when set, like NOTESD_EXPLORER_BIN). */
export const TASKLIST_ENV = 'NOTESD_TASKLIST_EXE';
/** Override for powershell.exe. */
export const POWERSHELL_ENV = 'NOTESD_POWERSHELL_EXE';
/** The systemd unit's PATH has no /mnt/c, so the absolute paths are the defaults. */
export const DEFAULT_TASKLIST_EXE = '/mnt/c/Windows/System32/tasklist.exe';
export const DEFAULT_POWERSHELL_EXE = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const TASKLIST_TIMEOUT_MS = 10_000;
export const POWERSHELL_TIMEOUT_MS = 20_000;
/** Current file cap; one previous file is kept (`.1.jsonl`). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** What start() reads to judge how the previous run ended. */
export const TAIL_BYTES = 256 * 1024;
/** What the health route reads. */
export const REPORT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REPORT_SAMPLES = 200;
export const MAX_REPORT_SAMPLES = 2000;
export const REPORT_HANGS = 50;
export const REPORT_INCIDENTS = 20;
/** close() waits this long at most for a start-up incident still reading the Windows event log. */
export const INCIDENT_WAIT_ON_CLOSE_MS = 3000;
export const CMD_MAX_CHARS = 600;

// ---- Log records: one JSON object per line. The schemas are the boundary for reading the file back.

const stamp = { ts: z.string(), host: z.string() };
const vlcState = z.enum(['playing', 'paused', 'stopped']);
const samplePlaySchema = z.object({
  play_id: z.number(),
  file_id: z.number(),
  name: z.string(),
  state: vlcState,
  position_s: z.number(),
  paused_s: z.number().nullable(),
  http_silent_s: z.number().nullable(),
  hung: z.boolean(),
});
const sampleSchema = z.object({
  kind: z.literal('sample'),
  ...stamp,
  pid: z.number(),
  ws_bytes: z.number(),
  private_bytes: z.number().nullable(),
  handles: z.number().nullable(),
  proc_started_at: z.string().nullable(),
  ours: z.boolean().nullable(),
  play: samplePlaySchema.nullable(),
  cmd: z.string().nullable(),
});
const hangOutcomeSchema = z.enum(['answered', 'exited', 'tracking_ended']);
const hangSchema = z.object({
  kind: z.literal('hang'),
  ...stamp,
  phase: z.enum(['start', 'end']),
  pid: z.number().nullable(),
  port: z.number(),
  play_id: z.number(),
  file_id: z.number(),
  name: z.string(),
  position_s: z.number(),
  silent_s: z.number(),
  outcome: hangOutcomeSchema.nullable(),
});
const previousRunKindSchema = z.enum(['none', 'clean', 'unclean_idle', 'unclean_sampling']);
const startSchema = z.object({
  kind: z.literal('start'),
  ...stamp,
  daemon_pid: z.number(),
  interval_ms: z.number(),
  process_detail: z.boolean(),
  previous: previousRunKindSchema,
});
const idleSchema = z.object({ kind: z.literal('idle'), ...stamp });
const cleanStopSchema = z.object({ kind: z.literal('clean_stop'), ...stamp });
const winFaultEventSchema = z.object({
  time: z.string(),
  event_id: z.number(),
  provider: z.string(),
  application: z.string().nullable(),
  module: z.string().nullable(),
  exception_code: z.string().nullable(),
  message: z.string().nullable(),
});
const incidentSchema = z.object({
  kind: z.literal('incident'),
  ...stamp,
  previous_start_at: z.string().nullable(),
  last_record_at: z.string(),
  last_sample_at: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  samples: z.array(sampleSchema),
  hangs: z.array(hangSchema),
  open_play: samplePlaySchema.nullable(),
  events: z.array(winFaultEventSchema),
  events_error: z.string().nullable(),
});
const recordSchema = z.discriminatedUnion('kind', [startSchema, sampleSchema, idleSchema, hangSchema, cleanStopSchema, incidentSchema]);

export type SamplePlay = z.infer<typeof samplePlaySchema>;
export type SampleRecord = z.infer<typeof sampleSchema>;
export type HangOutcome = z.infer<typeof hangOutcomeSchema>;
export type HangRecord = z.infer<typeof hangSchema>;
export type PreviousRunKind = z.infer<typeof previousRunKindSchema>;
export type StartRecord = z.infer<typeof startSchema>;
export type IdleRecord = z.infer<typeof idleSchema>;
export type CleanStopRecord = z.infer<typeof cleanStopSchema>;
export type WinFaultEvent = z.infer<typeof winFaultEventSchema>;
export type IncidentRecord = z.infer<typeof incidentSchema>;
export type HealthRecord = z.infer<typeof recordSchema>;

/** One log line -> a record; null for a blank, torn or foreign line. */
export function parseHealthLine(line: string): HealthRecord | null {
  const text = line.trim();
  if (text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = recordSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---- The file.

export function safeHostName(host: string): string {
  const s = host.replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' ? 'host' : s;
}

export function healthLogPath(logDir: string, host: string): string {
  return path.join(logDir, `vlc-health-${safeHostName(host)}.jsonl`);
}

export function previousHealthLogPath(logDir: string, host: string): string {
  return path.join(logDir, `vlc-health-${safeHostName(host)}.1.jsonl`);
}

interface Tail {
  text: string;
  bytes: number;
  /** The whole file was read (no partial first line). */
  whole: boolean;
}

function readLastBytes(file: string, max: number): Tail {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { text: '', bytes: 0, whole: true };
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(0, max));
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), bytes: len, whole: len === size };
  } finally {
    closeSync(fd);
  }
}

/**
 * The per-host append-only log. Every append is fsync'd before it returns, so the last line
 * survives the WSL VM dying a moment later (the page cache does not).
 */
export class HealthLog {
  readonly file: string;
  readonly previousFile: string;

  constructor(
    readonly logDir: string,
    readonly host: string,
    private readonly maxBytes: number = MAX_LOG_BYTES,
  ) {
    this.file = healthLogPath(logDir, host);
    this.previousFile = previousHealthLogPath(logDir, host);
  }

  /** Rotates first when this line would pass maxBytes; repairs a torn last line (crash mid-write). */
  append(record: HealthRecord): void {
    mkdirSync(this.logDir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      renameSync(this.file, this.previousFile);
      size = 0;
    }
    const fd = openSync(this.file, 'a+');
    try {
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) writeSync(fd, '\n');
      }
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The newest records, oldest first, from the last maxBytes of the current file, then the previous one. */
  readTail(maxBytes: number): HealthRecord[] {
    const cur = readLastBytes(this.file, maxBytes);
    let text = cur.text;
    let whole = cur.whole;
    if (cur.whole && cur.bytes < maxBytes) {
      const prev = readLastBytes(this.previousFile, maxBytes - cur.bytes);
      if (prev.bytes > 0) {
        text = `${prev.text}${prev.text.endsWith('\n') ? '' : '\n'}${cur.text}`;
        whole = prev.whole;
      }
    }
    const lines = text.split('\n');
    if (!whole) lines.shift();
    const out: HealthRecord[] = [];
    for (const line of lines) {
      const r = parseHealthLine(line);
      if (r !== null) out.push(r);
    }
    return out;
  }
}

// ---- The Windows side.

/** One vlc.exe. Without PowerShell only pid and working set are known. */
export interface VlcProcess {
  pid: number;
  wsBytes: number;
  privateBytes: number | null;
  handles: number | null;
  /** ISO 8601 UTC. */
  startedAt: string | null;
  commandLine: string | null;
}

/** `detail`: command lines are known, so "no VLC with this password" means gone. */
export type ProcessListing = { kind: 'ok'; detail: boolean; processes: VlcProcess[] } | { kind: 'error'; message: string };

export interface ProcessLister {
  list(): Promise<ProcessListing>;
}

export interface HealthEnv {
  tasklist: string;
  /** null: no detail (private bytes, handles, command line) and no Windows events. */
  powershell: string | null;
}

export type HealthOffReason = 'disabled' | 'not_linux' | 'no_interop' | 'no_tasklist';

export type HealthDetection = { available: true; env: HealthEnv } | { available: false; reason: HealthOffReason };

async function resolveWindowsExe(probe: DetectProbe, envName: string, fallback: string): Promise<string | null> {
  const value = probe.env[envName]?.trim() || fallback;
  if (value.includes('/')) return (await probe.executable(value)) ? value : null;
  return findOnPath(value, probe.env, probe.executable);
}

/** Linux + WSL interop + tasklist.exe (required) + powershell.exe (optional). Never throws. */
export async function detectHealthEnv(probe: DetectProbe): Promise<HealthDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const tasklist = await resolveWindowsExe(probe, TASKLIST_ENV, DEFAULT_TASKLIST_EXE);
  if (tasklist === null) return { available: false, reason: 'no_tasklist' };
  const powershell = await resolveWindowsExe(probe, POWERSHELL_ENV, DEFAULT_POWERSHELL_EXE);
  return { available: true, env: { tasklist, powershell } };
}

/**
 * `tasklist /FO CSV /NH` rows of vlc.exe -> pid and working set. "Mem Usage" is KB with a locale
 * separator ("512,000 K" / "512.000 K"), so only its digits count. The INFO line yields [].
 */
export function parseTasklistCsv(stdout: string): Array<{ pid: number; wsBytes: number }> {
  const out: Array<{ pid: number; wsBytes: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"') || !line.endsWith('"')) continue;
    const f = line.slice(1, -1).split('","');
    if (f.length < 5 || (f[0] ?? '').toLowerCase() !== 'vlc.exe') continue;
    const pid = Number(f[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const kb = Number((f[4] ?? '').replace(/[^0-9]/g, ''));
    out.push({ pid, wsBytes: Number.isFinite(kb) ? kb * 1024 : 0 });
  }
  return out;
}

/** Every vlc.exe with the fields R8.1 needs, as one JSON array (MEASURED 2026-11-14: PrivatePageCount is bytes). */
export const PROCESS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='vlc.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ws = [int64]$_.WorkingSetSize; priv = [int64]$_.PrivatePageCount; handles = [int]$_.HandleCount; started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); cmd = $_.CommandLine } })",
  'ConvertTo-Json -InputObject $p -Compress -Depth 2',
].join('\n');

const psProcessSchema = z.object({
  pid: z.number().int().positive(),
  ws: z.number().nonnegative(),
  priv: z.number().nonnegative().nullable().optional(),
  handles: z.number().int().nonnegative().nullable().optional(),
  started: z.string().nullable().optional(),
  cmd: z.string().nullable().optional(),
});

/** PROCESS_SCRIPT's stdout -> processes; null when it is not that JSON. */
export function parsePowerShellProcesses(stdout: string): VlcProcess[] | null {
  const json = lastJsonLine(stdout);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = z.union([z.array(psProcessSchema), psProcessSchema]).safeParse(raw);
  if (!parsed.success) return null;
  const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return list.map((p) => ({
    pid: p.pid,
    wsBytes: p.ws,
    privateBytes: p.priv ?? null,
    handles: p.handles ?? null,
    startedAt: p.started ?? null,
    commandLine: p.cmd ?? null,
  }));
}

/** tasklist every call; PowerShell only when tasklist lists a vlc.exe. Never throws. */
export function windowsProcessLister(env: HealthEnv, exec: ExecFn = execCapture): ProcessLister {
  return {
    async list() {
      const t = await exec(env.tasklist, ['/FI', 'IMAGENAME eq vlc.exe', '/FO', 'CSV', '/NH'], TASKLIST_TIMEOUT_MS);
      if (t.exitCode !== 0 && !t.stdout.includes('INFO:')) return { kind: 'error', message: `tasklist.exe exited ${t.exitCode}` };
      const rows = parseTasklistCsv(t.stdout);
      if (rows.length === 0) return { kind: 'ok', detail: true, processes: [] };
      const basic: VlcProcess[] = rows.map((r) => ({
        pid: r.pid,
        wsBytes: r.wsBytes,
        privateBytes: null,
        handles: null,
        startedAt: null,
        commandLine: null,
      }));
      if (env.powershell === null) return { kind: 'ok', detail: false, processes: basic };
      const p = await exec(env.powershell, powershellArgs(PROCESS_SCRIPT), POWERSHELL_TIMEOUT_MS);
      const detailed = p.exitCode === 0 ? parsePowerShellProcesses(p.stdout) : null;
      if (detailed === null) return { kind: 'ok', detail: false, processes: basic };
      return { kind: 'ok', detail: true, processes: detailed };
    },
  };
}

/** The per-launch password never reaches the log. */
export function redactCommandLine(cmd: string): string {
  const red = cmd.replace(/(--http-password(?:=|\s+)"?)[^\s"]+/gi, '$1***');
  return red.length > CMD_MAX_CHARS ? `${red.slice(0, CMD_MAX_CHARS)}…` : red;
}

/** Phase 5's launch flags: `--extraintf http` and a 32-hex `--http-password`. */
export function startedByNotesd(cmd: string): boolean {
  return /--extraintf(?:=|\s+)"?http\b/i.test(cmd) && /--http-password(?:=|\s+)"?[0-9a-f]{32}\b/i.test(cmd);
}

// ---- The player's side.

/** What the player tells the monitor about the play it follows (MoviePlayer.healthView()). */
export interface TrackedVlc {
  playId: number;
  fileId: number;
  name: string;
  port: number;
  /** Matched against command lines in memory; never logged. */
  password: string;
  state: VlcState;
  positionS: number;
  pausedSince: Date | null;
  silentSince: Date | null;
  hung: boolean;
}

/** Whether the vlc.exe behind an endpoint still exists. `unknown`: no command lines to match. */
export type PidCheck = { kind: 'alive'; pid: number } | { kind: 'gone' } | { kind: 'unknown'; reason: string };

interface HangEventBase {
  pid: number | null;
  port: number;
  playId: number;
  fileId: number;
  name: string;
  positionS: number;
  silentSince: Date;
}

export type HangEvent = (HangEventBase & { phase: 'start' }) | (HangEventBase & { phase: 'end'; outcome: HangOutcome });

/** What MoviePlayer needs from the monitor for the hang rule (R8.3). */
export interface PlayerHealthLink {
  processAlive(ep: VlcEndpoint): Promise<PidCheck>;
  onHang(e: HangEvent): void;
}

function secondsSince(since: Date | null, now: Date): number | null {
  return since === null ? null : Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** One sample line. `play` only on the VLC whose command line carries the tracked play's password. */
export function sampleRecord(host: string, now: Date, p: VlcProcess, tracked: TrackedVlc | null, withCmd: boolean): SampleRecord {
  const t = tracked !== null && p.commandLine !== null && p.commandLine.includes(tracked.password) ? tracked : null;
  return {
    kind: 'sample',
    ts: now.toISOString(),
    host,
    pid: p.pid,
    ws_bytes: p.wsBytes,
    private_bytes: p.privateBytes,
    handles: p.handles,
    proc_started_at: p.startedAt,
    ours: p.commandLine === null ? null : startedByNotesd(p.commandLine),
    play:
      t === null
        ? null
        : {
            play_id: t.playId,
            file_id: t.fileId,
            name: t.name,
            state: t.state,
            position_s: round1(t.positionS),
            paused_s: t.state === 'paused' ? secondsSince(t.pausedSince, now) : null,
            http_silent_s: secondsSince(t.silentSince, now),
            hung: t.hung,
          },
    cmd: withCmd && p.commandLine !== null ? redactCommandLine(p.commandLine) : null,
  };
}

export function hangRecord(host: string, now: Date, e: HangEvent): HangRecord {
  return {
    kind: 'hang',
    ts: now.toISOString(),
    host,
    phase: e.phase,
    pid: e.pid,
    port: e.port,
    play_id: e.playId,
    file_id: e.fileId,
    name: e.name,
    position_s: round1(e.positionS),
    silent_s: secondsSince(e.silentSince, now) ?? 0,
    outcome: e.phase === 'end' ? e.outcome : null,
  };
}

// ---- The report.

export interface VlcRunSummary {
  pid: number;
  proc_started_at: string | null;
  ours: boolean | null;
  first_at: string;
  last_at: string;
  samples: number;
  ws_first: number;
  ws_last: number;
  ws_max: number;
  private_first: number | null;
  private_last: number | null;
  private_max: number | null;
  handles_max: number | null;
  paused_s_max: number | null;
  /** Bytes per minute from the first to the last sample. */
  ws_growth_per_min: number | null;
  private_growth_per_min: number | null;
  /** Bytes per minute over consecutive samples that were both paused: the leak signal. */
  ws_growth_per_paused_min: number | null;
  private_growth_per_paused_min: number | null;
}

function maxOf(values: Array<number | null>): number | null {
  let m: number | null = null;
  for (const v of values) if (v !== null && (m === null || v > m)) m = v;
  return m;
}

function summarize(list: SampleRecord[]): VlcRunSummary {
  const first = list[0] as SampleRecord;
  const last = list[list.length - 1] as SampleRecord;
  const minutes = (Date.parse(last.ts) - Date.parse(first.ts)) / 60_000;
  let pausedMin = 0;
  let pausedWs = 0;
  let pausedPrivMin = 0;
  let pausedPriv = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] as SampleRecord;
    const b = list[i] as SampleRecord;
    if (a.play?.state !== 'paused' || b.play?.state !== 'paused') continue;
    const m = (Date.parse(b.ts) - Date.parse(a.ts)) / 60_000;
    if (!(m > 0)) continue;
    pausedMin += m;
    pausedWs += b.ws_bytes - a.ws_bytes;
    if (a.private_bytes !== null && b.private_bytes !== null) {
      pausedPrivMin += m;
      pausedPriv += b.private_bytes - a.private_bytes;
    }
  }
  let ours: boolean | null = null;
  for (const s of list) if (s.ours !== null) ours = s.ours;
  return {
    pid: first.pid,
    proc_started_at: first.proc_started_at,
    ours,
    first_at: first.ts,
    last_at: last.ts,
    samples: list.length,
    ws_first: first.ws_bytes,
    ws_last: last.ws_bytes,
    ws_max: maxOf(list.map((s) => s.ws_bytes)) ?? first.ws_bytes,
    private_first: first.private_bytes,
    private_last: last.private_bytes,
    private_max: maxOf(list.map((s) => s.private_bytes)),
    handles_max: maxOf(list.map((s) => s.handles)),
    paused_s_max: maxOf(list.map((s) => s.play?.paused_s ?? null)),
    ws_growth_per_min: minutes > 0 ? Math.round((last.ws_bytes - first.ws_bytes) / minutes) : null,
    private_growth_per_min:
      minutes > 0 && first.private_bytes !== null && last.private_bytes !== null
        ? Math.round((last.private_bytes - first.private_bytes) / minutes)
        : null,
    ws_growth_per_paused_min: pausedMin > 0 ? Math.round(pausedWs / pausedMin) : null,
    private_growth_per_paused_min: pausedPrivMin > 0 ? Math.round(pausedPriv / pausedPrivMin) : null,
  };
}

/** One summary per VLC process (pid + start time), in order of first appearance. */
export function summarizeRuns(samples: readonly SampleRecord[]): VlcRunSummary[] {
  const runs = new Map<string, SampleRecord[]>();
  for (const s of samples) {
    const key = `${s.pid}|${s.proc_started_at ?? ''}`;
    const list = runs.get(key);
    if (list === undefined) runs.set(key, [s]);
    else list.push(s);
  }
  return [...runs.values()].map(summarize);
}

export interface HealthStatus {
  sampling: boolean;
  reason: HealthOffReason | 'not_started' | null;
  interval_ms: number;
  process_detail: boolean;
  log_file: string;
}

export interface HealthReport extends HealthStatus {
  host: string;
  samples: SampleRecord[];
  runs: VlcRunSummary[];
  hangs: HangRecord[];
  incidents: IncidentRecord[];
  last_start: StartRecord | null;
}

/** GET /api/movies/player/health: the newest `limit` samples, run summaries over every sample read, hangs, incidents. */
export function healthReport(records: readonly HealthRecord[], o: { host: string; limit: number; status: HealthStatus }): HealthReport {
  const samples = records.filter((r): r is SampleRecord => r.kind === 'sample');
  const hangs = records.filter((r): r is HangRecord => r.kind === 'hang');
  const incidents = records.filter((r): r is IncidentRecord => r.kind === 'incident');
  let lastStart: StartRecord | null = null;
  for (const r of records) if (r.kind === 'start') lastStart = r;
  return {
    ...o.status,
    host: o.host,
    samples: samples.slice(-o.limit),
    runs: summarizeRuns(samples),
    hangs: hangs.slice(-REPORT_HANGS),
    incidents: incidents.slice(-REPORT_INCIDENTS),
    last_start: lastStart,
  };
}

// ---- The monitor.

export interface HealthMonitorDeps {
  /** MoviesService.host (os.hostname()). */
  host: string;
  /** `<dataDir>/movies`. */
  logDir: string;
  /** NOTESD_VLC_HEALTH_MS; 0 = off. */
  intervalMs: number;
  detect: () => Promise<HealthDetection>;
  /** The play the player follows now (MoviePlayer.healthView()). */
  tracked: () => TrackedVlc | null;
  /** Default: windowsProcessLister. */
  makeLister?: (env: HealthEnv) => ProcessLister;
  /** Default: powershellEventLogReader when powershell.exe exists, else null. */
  makeEvents?: (env: HealthEnv) => EventLogReader | null;
  now?: () => Date;
  log?: (line: string) => void;
  maxLogBytes?: number;
}

type Mode =
  | { kind: 'not_started' }
  | { kind: 'off'; reason: HealthOffReason }
  | { kind: 'on'; env: HealthEnv; lister: ProcessLister; events: EventLogReader | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Samples every vlc.exe on this host into the health log (R8.1), writes an incident at start when
 * the previous run died while sampling (R8.2), records the player's hangs (R8.3) and answers the
 * health route (R8.5). Read only on the Windows side: it never kills, pauses or restarts a VLC.
 */
export class HealthMonitor implements PlayerHealthLink {
  readonly store: HealthLog;
  private mode: Mode = { kind: 'not_started' };
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private incident: Promise<void> | null = null;
  private closed = false;
  private sampling = false;
  private listErrorLogged = false;
  private cmdLogged = new Set<number>();

  constructor(private readonly deps: HealthMonitorDeps) {
    this.store = new HealthLog(deps.logDir, deps.host, deps.maxLogBytes ?? MAX_LOG_BYTES);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private say(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Detect, judge the previous run, write `start`, start ticking. The incident is written in the background (settled()). */
  async start(): Promise<void> {
    if (this.mode.kind !== 'not_started' || this.closed) return;
    if (this.deps.intervalMs === 0) {
      this.mode = { kind: 'off', reason: 'disabled' };
      this.say('[notesd] vlc health off (NOTESD_VLC_HEALTH_MS=0 or no NOTESD_MOVIES_ROOTS)');
      return;
    }
    const d = await this.deps.detect();
    if (this.closed) return;
    if (!d.available) {
      this.mode = { kind: 'off', reason: d.reason };
      this.say(`[notesd] vlc health off (${d.reason})`);
      return;
    }
    const lister = (this.deps.makeLister ?? ((env: HealthEnv) => windowsProcessLister(env)))(d.env);
    const events =
      this.deps.makeEvents !== undefined
        ? this.deps.makeEvents(d.env)
        : d.env.powershell === null
          ? null
          : powershellEventLogReader(d.env.powershell);
    const startedAt = this.now();
    const previous = analyzePreviousRun(this.store.readTail(TAIL_BYTES));
    this.store.append({
      kind: 'start',
      ts: startedAt.toISOString(),
      host: this.deps.host,
      daemon_pid: process.pid,
      interval_ms: this.deps.intervalMs,
      process_detail: d.env.powershell !== null,
      previous: previous.kind,
    });
    this.mode = { kind: 'on', env: d.env, lister, events };
    this.say(
      `[notesd] vlc health: sampling vlc.exe every ${Math.round(this.deps.intervalMs / 1000)} s into ${this.store.file}` +
        (d.env.powershell === null ? ' (no powershell.exe: pid and working set only)' : ''),
    );
    if (previous.kind === 'unclean_sampling') {
      this.say(`[notesd] vlc health: the previous run stopped uncleanly at ${previous.lastRecordAt} while vlc.exe was sampled; writing an incident`);
      this.incident = this.recordIncident(previous, events, startedAt).catch((err: unknown) =>
        this.say(`[notesd] vlc health: incident failed: ${message(err)}`),
      );
    }
    this.schedule();
  }

  /** Resolves once the start-up incident (if any) is in the log. */
  async settled(): Promise<void> {
    if (this.incident !== null) await this.incident;
  }

  private async recordIncident(previous: UncleanSampling, events: EventLogReader | null, startedAt: Date): Promise<void> {
    const window = incidentWindow(previous, startedAt);
    const result: EventsResult =
      events === null ? { kind: 'error', message: 'no powershell.exe: Windows events not read' } : await events.read(window.from, window.to);
    const record = buildIncident({ host: this.deps.host, now: this.now(), previous, window, events: result });
    this.store.append(record);
    this.say(
      `[notesd] vlc health: incident written: ${record.samples.length} sample(s), ${record.events.length} Windows fault event(s)` +
        (record.events_error === null ? '' : ` (${record.events_error})`),
    );
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.sampleNow()
        .then(
          () => undefined,
          (err: unknown) => this.say(`[notesd] vlc health: sample failed: ${message(err)}`),
        )
        .finally(() => {
          this.inFlight = null;
          this.schedule();
        });
    }, this.deps.intervalMs);
    this.timer.unref();
  }

  /** One tick: a sample line per vlc.exe, an `idle` line when the last one went away. Returns the samples written. */
  async sampleNow(): Promise<number> {
    if (this.mode.kind !== 'on' || this.closed) return 0;
    const listing = await this.mode.lister.list();
    if (this.closed) return 0;
    if (listing.kind === 'error') {
      if (!this.listErrorLogged) this.say(`[notesd] vlc health: listing vlc.exe failed: ${listing.message}`);
      this.listErrorLogged = true;
      return 0;
    }
    this.listErrorLogged = false;
    const now = this.now();
    if (listing.processes.length === 0) {
      if (this.sampling) this.store.append({ kind: 'idle', ts: now.toISOString(), host: this.deps.host });
      this.sampling = false;
      this.cmdLogged.clear();
      return 0;
    }
    const tracked = this.deps.tracked();
    const logged = new Set<number>();
    for (const p of listing.processes) {
      const withCmd = p.commandLine !== null && !this.cmdLogged.has(p.pid);
      this.store.append(sampleRecord(this.deps.host, now, p, tracked, withCmd));
      if (p.commandLine !== null || this.cmdLogged.has(p.pid)) logged.add(p.pid);
    }
    this.cmdLogged = logged;
    this.sampling = true;
    return listing.processes.length;
  }

  async processAlive(ep: VlcEndpoint): Promise<PidCheck> {
    const mode = this.mode;
    if (mode.kind !== 'on') return { kind: 'unknown', reason: mode.kind === 'off' ? mode.reason : 'not_started' };
    const listing = await mode.lister.list();
    if (listing.kind === 'error') return { kind: 'unknown', reason: listing.message };
    if (listing.processes.length === 0) return { kind: 'gone' };
    if (!listing.detail) return { kind: 'unknown', reason: 'no_process_detail' };
    const p = listing.processes.find((x) => x.commandLine !== null && x.commandLine.includes(ep.password));
    return p === undefined ? { kind: 'gone' } : { kind: 'alive', pid: p.pid };
  }

  onHang(e: HangEvent): void {
    if (this.mode.kind !== 'on' || this.closed) return;
    try {
      this.store.append(hangRecord(this.deps.host, this.now(), e));
    } catch (err) {
      this.say(`[notesd] vlc health: could not write a hang line: ${message(err)}`);
    }
  }

  status(): HealthStatus {
    const m = this.mode;
    return {
      sampling: m.kind === 'on' && !this.closed,
      reason: m.kind === 'off' ? m.reason : m.kind === 'not_started' ? 'not_started' : null,
      interval_ms: this.deps.intervalMs,
      process_detail: m.kind === 'on' && m.env.powershell !== null,
      log_file: this.store.file,
    };
  }

  report(limit: number): HealthReport {
    return healthReport(this.store.readTail(REPORT_BYTES), { host: this.deps.host, limit, status: this.status() });
  }

  /** Daemon stop, after the player closed: finish a tick, give a pending incident up to 3 s, write `clean_stop`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
    if (this.incident !== null) {
      let waiter: NodeJS.Timeout | undefined;
      await Promise.race([
        this.incident,
        new Promise<void>((resolve) => {
          waiter = setTimeout(resolve, INCIDENT_WAIT_ON_CLOSE_MS);
        }),
      ]);
      if (waiter !== undefined) clearTimeout(waiter);
    }
    if (this.mode.kind === 'on') this.store.append({ kind: 'clean_stop', ts: this.now().toISOString(), host: this.deps.host });
  }
}

export interface VlcHealthOptions {
  config: MoviesConfig;
  dataDir: string;
  host: string;
  tracked: () => TrackedVlc | null;
  probe?: DetectProbe;
  makeLister?: (env: HealthEnv) => ProcessLister;
  makeEvents?: (env: HealthEnv) => EventLogReader | null;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The daemon's monitor: `<dataDir>/movies`, `config.vlc.healthMs`, real WSL detection. Builds nothing that runs until start(). */
export function buildVlcHealth(o: VlcHealthOptions): HealthMonitor {
  const probe = o.probe ?? nodeProbe();
  return new HealthMonitor({
    host: o.host,
    logDir: path.join(o.dataDir, MOVIES_SUBDIR),
    // Invariant 5: with no library roots nothing runs on its own, so the sampler stays off (as NOTESD_VLC_HEALTH_MS=0).
    intervalMs: o.config.roots.length === 0 ? 0 : o.config.vlc.healthMs,
    detect: () => detectHealthEnv(probe),
    tracked: o.tracked,
    ...(o.makeLister !== undefined ? { makeLister: o.makeLister } : {}),
    ...(o.makeEvents !== undefined ? { makeEvents: o.makeEvents } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.log !== undefined ? { log: o.log } : {}),
  });
}
```
**Impact:** none until Step 7 wires it. The first sample is taken one interval after `start()`.

### Step 4: extra args on the VLC argv (R8.4)
**File:** `src/movies/vlc/launch.ts` (Phase 5 Step 1), `vlcArgs` and `spawnVlcLauncher`.
**Change:** replace Phase 5's `vlcArgs` (doc comment included) with:
```ts
/**
 * vlc.exe's argv. A separate instance (never the owner's running VLC), no "Continue playback?"
 * question (`qt-continue` is 0 never / 1 ask / 2 always), no first-run privacy dialog, the HTTP
 * interface beside the normal Qt window, and the resume second. Then NOTESD_VLC_EXTRA_ARGS
 * (movies phase 9; config.ts rejects any that would set the HTTP interface), and the file last.
 */
export function vlcArgs(l: VlcLaunch, extraArgs: readonly string[] = []): string[] {
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
    ...extraArgs,
    l.winPath,
  ];
}
```
and replace Phase 5's `spawnVlcLauncher` (doc comment included) with:
```ts
/**
 * The real launcher: detached, stdio ignored, unref'd. Under systemd (`scope` true; default: detected
 * from /proc/self/cgroup) VLC goes through `systemd-run --user --scope` so `systemctl --user restart
 * notesd` (KillMode=control-group) cannot kill it; without systemd-run it falls back to a plain
 * detached spawn. `extraArgs` (config.movies.vlc.extraArgs) go on every launch.
 */
export function spawnVlcLauncher(opts: { scope?: boolean; extraArgs?: readonly string[] } = {}): VlcLauncher {
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
  const extra = opts.extraArgs ?? [];
  return {
    async launch(env, l) {
      const run = await systemdRun();
      if (run !== null) return spawnDetached(run, scopeArgs(env.vlc, vlcArgs(l, extra)));
      return spawnDetached(env.vlc, vlcArgs(l, extra));
    },
  };
}
```
**Impact:** with no extras both functions behave exactly as Phase 5's (Phase 5's `vlc.launch.test.ts`
assertions still hold). Step 5 passes the config's extras.

### Step 5: the hang rule, the paused clock and `healthView()` in the player
**File:** `src/movies/player.ts` (Phase 5 Step 5). Eight edits; everything else stays.

**5a. Imports.** After `import { nodeRecentsFs, recentsSyncHook, type RecentsFs } from './vlc/recents.js';` add:
```ts
import type { HangEvent, HangOutcome, PidCheck, PlayerHealthLink, TrackedVlc } from './vlc/health.js';
```

**5b. Constant.** After `export const MAX_READ_ERRORS = 6;` add:
```ts
/**
 * Movies phase 9: silent polls in a row (curl timeout, or exit 7 while the vlc.exe still exists)
 * before a VLC whose process is alive counts as hung. A hung VLC keeps its play open at the last
 * position read, however long it stays silent. Two, not one, so a VLC that is closing (socket shut,
 * process not yet gone) does not log a false hang.
 */
export const HANG_AFTER_SILENT_POLLS = 2;
```

**5c. `MoviePlayerDeps`.** After the `onChange?: (file: FileRow) => void;` member add:
```ts
  /**
   * Movies phase 9: the VLC health monitor. Asked whether a silent VLC's process still exists, and
   * told when a hang starts and ends (R8.3). Absent: Phase 5's rules (exit 7 ends the play at once,
   * MAX_READ_ERRORS curl errors end it).
   */
  health?: PlayerHealthLink;
  /** Default `new Date()`: the paused and silent clocks. */
  now?: () => Date;
```

**5d. `Tracked`.** Replace Phase 5's `interface Tracked { ... }` with:
```ts
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
  /** Silent polls in a row (curl errors, and exit 7 while the process lives). */
  errors: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  ended: boolean;
  /** The first poll of the current pause that read `paused`; null while not paused. */
  pausedSince: Date | null;
  /** The first silent poll of the current silence; null while VLC answers. */
  silentSince: Date | null;
  /** Between a hang's start and end lines. */
  hung: boolean;
  /** The vlc.exe pid the monitor matched when the hang started. */
  hangPid: number | null;
}
```

**5e. The `Tracked` literal in `playNow`.** Replace
```ts
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
```
with
```ts
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
      pausedSince: status.state === 'paused' ? this.now() : null,
      silentSince: null,
      hung: false,
      hangPid: null,
    };
```

**5f. `healthView()` and the clock.** Directly after the `current(): PlayerSnapshot | null { ... }` method add:
```ts
  /**
   * Movies phase 9: the followed play as the health monitor samples it. Holds the per-launch
   * password, which the monitor matches against vlc.exe command lines in memory and never logs.
   * Not a wire type: GET /api/movies/player keeps current().
   */
  healthView(): TrackedVlc | null {
    const t = this.tracked;
    if (t === null) return null;
    return {
      playId: t.playId,
      fileId: t.file.id,
      name: t.file.name,
      port: t.ep.port,
      password: t.ep.password,
      state: t.state,
      positionS: t.position,
      pausedSince: t.pausedSince,
      silentSince: t.silentSince,
      hung: t.hung,
    };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
```

**5g. `tick` and `finish`.** Replace Phase 5's `tick` and `finish` methods with:
```ts
  private async tick(t: Tracked): Promise<void> {
    if (t.ended) return;
    const r = await this.deps.reader.status(t.env.curl, t.ep);
    if (t.ended) return;
    switch (r.kind) {
      case 'ok': {
        t.errors = 0;
        this.endHang(t, 'answered');
        t.silentSince = null;
        t.state = r.status.state;
        if (r.status.state === 'paused') t.pausedSince ??= this.now();
        else t.pausedSince = null;
        // Stopped (user pressed stop, or the media ended) reads time 0 / length 0: keep the last real position.
        if (r.status.state === 'stopped') return;
        t.position = r.status.time;
        if (r.status.length > 0) t.duration = r.status.length;
        t.lastReadAt = new Date();
        await this.deps.repo.updatePlay(t.playId, { positionS: t.position, durationS: t.duration });
        return;
      }
      case 'unauthorized':
        await this.finish(t, 'exited', true);
        return;
      case 'gone':
        if (this.deps.health === undefined) {
          await this.finish(t, 'exited', true);
          return;
        }
        await this.onSilent(t, 'refused');
        return;
      case 'error':
        await this.onSilent(t, 'error');
        return;
    }
  }

  /**
   * Movies phase 9, the hang rule (R8.3). A silent poll never writes a position. With the monitor:
   * process gone -> the play ends `exited`; alive for HANG_AFTER_SILENT_POLLS polls -> one hang
   * start line, and the play stays open at its last position; unknown -> Phase 5's rules.
   */
  private async onSilent(t: Tracked, how: 'refused' | 'error'): Promise<void> {
    t.errors += 1;
    t.silentSince ??= this.now();
    const health = this.deps.health;
    if (health !== undefined && (how === 'refused' || t.errors >= HANG_AFTER_SILENT_POLLS)) {
      const check: PidCheck = await health.processAlive(t.ep);
      if (t.ended) return;
      if (check.kind === 'gone' || (check.kind === 'unknown' && how === 'refused')) {
        await this.finish(t, 'exited', true);
        return;
      }
      if (check.kind === 'alive') {
        if (t.errors >= HANG_AFTER_SILENT_POLLS && !t.hung) this.startHang(t, check.pid);
        return;
      }
    }
    if (t.errors >= MAX_READ_ERRORS) await this.finish(t, 'unreachable', true);
  }

  private hangBase(t: Tracked): Omit<HangEvent, 'phase' | 'outcome'> {
    return {
      pid: t.hangPid,
      port: t.ep.port,
      playId: t.playId,
      fileId: t.file.id,
      name: t.file.name,
      positionS: t.position,
      silentSince: t.silentSince ?? this.now(),
    };
  }

  private startHang(t: Tracked, pid: number): void {
    t.hung = true;
    t.hangPid = pid;
    this.deps.health?.onHang({ ...this.hangBase(t), phase: 'start' });
    this.log(`[movies] VLC pid ${pid} of play ${t.playId} (${t.file.name}) stopped answering on port ${t.ep.port}; play kept at ${Math.round(t.position)} s`);
  }

  /** Writes the hang's end line once; a no-op when the play is not hung. */
  private endHang(t: Tracked, outcome: HangOutcome): void {
    if (!t.hung) return;
    this.deps.health?.onHang({ ...this.hangBase(t), phase: 'end', outcome });
    this.log(`[movies] VLC of play ${t.playId} (${t.file.name}) hang ended: ${outcome}`);
    t.hung = false;
    t.hangPid = null;
  }

  /** Ends tracking once: stop polling, close a hang, then close the play row at the last position read. */
  private async finish(t: Tracked, why: EndWhy, fromTick = false): Promise<void> {
    if (t.ended) return;
    t.ended = true;
    if (t.timer !== null) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (this.tracked === t) this.tracked = null;
    this.endHang(t, why === 'exited' ? 'exited' : 'tracking_ended');
    if (!fromTick && t.inFlight !== null) await t.inFlight;
    await this.deps.repo.endPlay(t.playId, { positionS: t.position, durationS: t.duration }, new Date());
    this.deps.onChange?.(t.file);
    this.log(`[movies] play ${t.playId} (${t.file.name}) ended at ${Math.round(t.position)} s: ${why}`);
  }
```
`Omit` over the `HangEvent` union keeps the shared base fields; the two call sites add `phase`
(and `outcome`), which TypeScript checks against the union.

**5h. `PlaybackOverrides` and `buildMoviePlayback`.** Replace Phase 5's `PlaybackOverrides` with:
```ts
/** Seams for tests; the daemon passes `health` only. */
export interface PlaybackOverrides {
  probe?: DetectProbe;
  launcher?: VlcLauncher;
  reader?: VlcStatusReader;
  wslpath?: (wslpathBin: string, abs: string) => Promise<string>;
  recentsFs?: RecentsFs;
  /** Movies phase 9: the health monitor (the hang rule). */
  health?: PlayerHealthLink;
}
```
and in `buildMoviePlayback`, replace the `new MoviePlayer({ ... })` call with:
```ts
  const player = new MoviePlayer({
    repo: service.repo,
    host: service.host,
    httpPort: config.vlc.httpPort,
    pollMs: config.vlc.pollMs,
    detect,
    launcher: overrides.launcher ?? spawnVlcLauncher({ extraArgs: config.vlc.extraArgs }),
    reader: overrides.reader ?? curlStatusReader(),
    ...(overrides.wslpath !== undefined ? { wslpath: overrides.wslpath } : {}),
    ...(overrides.health !== undefined ? { health: overrides.health } : {}),
    // Play start and end only: the web reloads its whole list on every `changed`.
    onChange: (file) => service.events.changed('play', { fileIds: [file.id], titleIds: file.titleId === null ? [] : [file.titleId] }),
  });
```
**Impact:** without `health` (every Phase 5 test) a poll behaves exactly as Phase 5's: `gone` and
`unauthorized` end the play, and errors count to `MAX_READ_ERRORS`. With it, Design decision 12
applies. `current()` and `PlayerSnapshot` are unchanged.

### Step 6: the health route
**File:** `src/http/moviesPlayApi.ts` (Phase 5 Step 7)
**Change 6a:** after `import { PlayError } from '../movies/player.js';` add:
```ts
import { DEFAULT_REPORT_SAMPLES, MAX_REPORT_SAMPLES } from '../movies/vlc/health.js';
```
**Change 6b:** after `const continueBody = ...;` add:
```ts
const healthLimit = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/)
  .transform(Number)
  .refine((n) => n <= MAX_REPORT_SAMPLES);
```
**Change 6c:** replace the signature line
```ts
export function moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer'>): Hono {
```
with
```ts
export function moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer' | 'moviesHealth'>): Hono {
```
**Change 6d:** directly before the final `return r;` of `moviesPlayRoutes` add:
```ts
  /**
   * Movies phase 9 (R8.5): this host's VLC health log. Read only, no Origin check. `limit` caps the
   * samples (default 200, max 2000); run summaries, hangs and incidents come from the whole read window.
   */
  r.get('/api/movies/player/health', (c) => {
    const raw = c.req.query('limit');
    let limit = DEFAULT_REPORT_SAMPLES;
    if (raw !== undefined) {
      const parsed = healthLimit.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_limit', message: `limit must be an integer 1-${MAX_REPORT_SAMPLES}` }, 400);
      limit = parsed.data;
    }
    const health = deps.moviesHealth ?? null;
    if (health === null) return c.json(MOVIES_OFF, 503);
    return c.json(health.report(limit));
  });
```
**Impact:** one new GET. `/api/movies/player` and the two POSTs are unchanged. The path has two
segments after `/api/movies/`, so Phase 4's `GET /api/movies/:id` cannot match it.

### Step 7: wire the monitor into `AppDeps` and the daemon
**File:** `src/deps.ts`, after Phase 5's `moviesPlayer?: MoviePlayer | null;` member. Add the import
next to Phase 5's `import type { MoviePlayer } from './movies/player.js';`:
```ts
import type { HealthMonitor } from './movies/vlc/health.js';
```
and the member:
```ts
  /**
   * The VLC health log (movies phase 9): built next to `moviesPlayer`; null or absent when `movies`
   * is null. Read by GET /api/movies/player/health.
   */
  moviesHealth?: HealthMonitor | null;
```
**File:** `src/daemon.ts` (after Phases 3 and 5).
1. Import, next to Phase 5's player import:
```ts
import { buildVlcHealth, type HealthMonitor } from './movies/vlc/health.js';
```
2. Replace Phase 5's two lines
```ts
  // Movies phase 5: VLC playback and the [RecentsMRL] hook hang off the movies service.
  const moviesPlayer: MoviePlayer | null = movies === null ? null : buildMoviePlayback(movies, config.movies);
```
with
```ts
  // Movies phase 9: the VLC health log. Built before the player, whose hang rule asks it whether a
  // silent VLC still exists; it reads the followed play back through the player. Started after listen.
  let moviesPlayer: MoviePlayer | null = null;
  const moviesHealth: HealthMonitor | null =
    movies === null
      ? null
      : buildVlcHealth({ config: config.movies, dataDir: config.dataDir, host: movies.host, tracked: () => moviesPlayer?.healthView() ?? null });
  // Movies phase 5: VLC playback and the [RecentsMRL] hook hang off the movies service.
  moviesPlayer = movies === null ? null : buildMoviePlayback(movies, config.movies, moviesHealth === null ? {} : { health: moviesHealth });
```
(The rest of Phase 5's block, `if (moviesPlayer !== null) { ... }`, stays as it is.)
3. In the `const deps: AppDeps = { ... }` literal, add `moviesHealth,` right after Phase 5's `moviesPlayer,`.
4. Directly after `boundPort = port;` add:
```ts
  // Movies phase 9: sampling starts once the daemon serves; the incident of a crashed run is written in the background.
  if (moviesHealth !== null) {
    try {
      await moviesHealth.start();
    } catch (err) {
      console.error(`[notesd] vlc health: could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```
5. In `stop`, directly after Phase 5's `await moviesPlayer?.close();` add:
```ts
      // After the player (its last hang line), before the DB: writes `clean_stop`.
      await moviesHealth?.close();
```
**Impact:** with `NOTESD_MOVIES=off` (and `DEFAULT_MOVIES_CONFIG` in tests) no monitor is built. With
movies on, startup logs one `[notesd] vlc health ...` line. Off: `NOTESD_VLC_HEALTH_MS=0`, not WSL, or
no tasklist.exe.

### Step 8: README env rows
**File:** `README.md`, the environment table. Directly after Phase 1's `NOTESD_CURL_EXE` row insert:
```markdown
| `NOTESD_VLC_HEALTH_MS` | `30000` | How often every `vlc.exe` on this machine is sampled into `<NOTES_DATA_DIR>/movies/vlc-health-<host>.jsonl` (pid, working set, private bytes, handles, and for a VLC notesd started its play state and seconds paused); one fsync'd JSON line per VLC, 5 MB plus one previous file. After a crash the next start adds an incident with the last samples and the Windows Application Error / Application Hang events around them. `GET /api/movies/player/health` reads it. `0` turns the log, incidents and hang detection off (so does an empty `NOTESD_MOVIES_ROOTS`); 1-4999 is rejected. |
| `NOTESD_VLC_EXTRA_ARGS` | — | Extra `vlc.exe` arguments for every VLC notesd starts, split on whitespace (no quoting), placed before the file, e.g. `--avcodec-hw=none`. `--http-*`, `--extraintf`, `--intf` and `-I` are rejected: notesd owns VLC's HTTP interface. |
| `NOTESD_TASKLIST_EXE` | `/mnt/c/Windows/System32/tasklist.exe` | The Windows tasklist the VLC health log runs each interval. Missing: the health log is off (one startup log line). |
| `NOTESD_POWERSHELL_EXE` | `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` | Reads private bytes, handles and the command line of each `vlc.exe` (only while one runs), and the Windows events for a crash incident. Missing: samples keep pid and working set only, and incidents carry no Windows events. |
```
**Impact:** docs only. Phase 8 documents the route, the log file and the tour.

### Step 9: config tests
**File:** `tests/unit/config.test.ts` (Phase 1 Step 12's `describe('movies config')`).
**Change 9a:** in `it('defaults to on with no roots, ...')`, in the expected `vlc: { ... }` object, after
`curlExe: '/mnt/c/Windows/System32/curl.exe',` add:
```ts
        healthMs: 30_000,
        extraArgs: [],
```
**Change 9b:** in `it('reads every key', ...)`, in the env object after `NOTESD_CURL_EXE: 'curl.exe',` add:
```ts
        NOTESD_VLC_HEALTH_MS: '0',
        NOTESD_VLC_EXTRA_ARGS: '  --avcodec-hw=none   --no-video-title-show ',
```
and in its expected `vlc: { ... }` after `curlExe: 'curl.exe',` add:
```ts
        healthMs: 0,
        extraArgs: ['--avcodec-hw=none', '--no-video-title-show'],
```
**Change 9c:** in the `it.each([...])('rejects %s=%j', ...)` list, after `['NOTESD_VLC_POLL_MS', '1.5'],` add:
```ts
    ['NOTESD_VLC_HEALTH_MS', '1000'],
    ['NOTESD_VLC_HEALTH_MS', '-1'],
    ['NOTESD_VLC_HEALTH_MS', '30s'],
    ['NOTESD_VLC_EXTRA_ARGS', '--http-port 9999'],
    ['NOTESD_VLC_EXTRA_ARGS', '--avcodec-hw=none --http-password=x'],
    ['NOTESD_VLC_EXTRA_ARGS', '--extraintf=rc'],
    ['NOTESD_VLC_EXTRA_ARGS', '-I dummy'],
```
**Change 9d:** at the end of `describe('movies config', ...)`, before its closing `})`, add:
```ts
  it('R8.4: NOTESD_VLC_EXTRA_ARGS is split on whitespace, and a 5 s health interval is the smallest accepted', () => {
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '--avcodec-hw=none' }).vlc.extraArgs).toEqual(['--avcodec-hw=none'])
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '   ' }).vlc.extraArgs).toEqual([])
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '--intf-foo --no-http-forward-cookies' }).vlc.extraArgs).toEqual(['--intf-foo', '--no-http-forward-cookies'])
    expect(movies({ NOTESD_VLC_HEALTH_MS: '5000' }).vlc.healthMs).toBe(5000)
    expect(DEFAULT_MOVIES_CONFIG.vlc).toMatchObject({ healthMs: 30_000, extraArgs: [] })
  })
```
**Impact:** Phase 1's two `toEqual` cases now name the new fields.

### Step 10: test fixtures
**File:** `tests/fixtures/movies/fake-windows.mjs` (new). Tests and harness runs start it through a
generated `#!/bin/sh` wrapper (`exec node fake-windows.mjs tasklist "$@"`), so its git mode does not matter.
```js
#!/usr/bin/env node
// A fake Windows side for the VLC health monitor (src/movies/vlc/health.ts). It prints what
// tasklist.exe and powershell.exe printed on this machine (MEASURED 2026-11-14), from a JSON state
// file that is read again on every call, so a test changes "Windows" by rewriting the file.
//   node fake-windows.mjs tasklist <tasklist args>
//        -> one CSV row per vlc.exe ("vlc.exe","<pid>","Console","1","<KB> K"), or the INFO line
//   node fake-windows.mjs powershell -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>
//        -> a script with Get-WinEvent: the events as one JSON array; otherwise the process detail array
// Env: FAKE_WIN_STATE  JSON file { "vlc": [{ pid, ws, priv, handles, started, cmd }],
//                                  "events": [{ time, id, provider, props, message }] }
//      FAKE_WIN_CALLS  optional: append one line per call (tasklist | powershell:processes | powershell:events)
import { appendFileSync, readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
let state = { vlc: [], events: [] };
try {
  state = JSON.parse(readFileSync(process.env.FAKE_WIN_STATE ?? '', 'utf8'));
} catch {
  // no state file: no VLC, no events
}
const vlc = Array.isArray(state.vlc) ? state.vlc : [];
const events = Array.isArray(state.events) ? state.events : [];
const note = (what) => {
  if (process.env.FAKE_WIN_CALLS) appendFileSync(process.env.FAKE_WIN_CALLS, `${what}\n`);
};

if (mode === 'tasklist') {
  note('tasklist');
  if (vlc.length === 0) {
    process.stdout.write('INFO: No tasks are running which match the specified criteria.\r\n');
  } else {
    for (const p of vlc) {
      const kb = Math.round(Number(p.ws ?? 0) / 1024).toLocaleString('en-US');
      process.stdout.write(`"vlc.exe","${p.pid}","Console","1","${kb} K"\r\n`);
    }
  }
  process.exit(0);
}

if (mode === 'powershell') {
  const i = args.indexOf('-EncodedCommand');
  const script = i >= 0 ? Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le') : '';
  if (script.includes('Get-WinEvent')) {
    note('powershell:events');
    process.stdout.write(`${JSON.stringify(events)}\r\n`);
  } else {
    note('powershell:processes');
    const out = vlc.map((p) => ({
      pid: p.pid,
      ws: p.ws,
      priv: p.priv ?? null,
      handles: p.handles ?? null,
      started: p.started ?? null,
      cmd: p.cmd ?? null,
    }));
    process.stdout.write(`${JSON.stringify(out)}\r\n`);
  }
  process.exit(0);
}

console.error(`fake-windows: unknown mode ${mode}`);
process.exit(2);
```
**File:** `tests/fixtures/movies/fake-vlc.mjs` (Phase 5 Step 10).
**Change 10a:** in the header comment, after the line `// GET /fake/quit (no auth) makes it exit, as closing the VLC window would.` add:
```js
// GET /fake/hang?ms=N (no auth): for N ms every other request is accepted and never answered, as a
// hung VLC does (curl.exe -m 2 then exits 28), and is dropped when the hang ends.
```
**Change 10b:** after `const expected = 'Basic ' + Buffer.from(':' + password).toString('base64');` add:
```js
let hungUntil = 0;
```
**Change 10c:** in the request handler, directly after the `/fake/quit` block (its closing `}`), add:
```js
  if (url.pathname === '/fake/hang') {
    hungUntil = Date.now() + Number(url.searchParams.get('ms') ?? 60000);
    res.end('hung');
    return;
  }
  if (Date.now() < hungUntil) {
    setTimeout(() => res.destroy(), hungUntil - Date.now());
    return;
  }
```
**Impact:** Phase 5's tests never call `/fake/hang`, so their fake behaves as before.

### Step 11: unit tests
**File:** `tests/unit/movies/vlc.extraArgs.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { vlcArgs } from '../../../src/movies/vlc/launch.js';

const L = { winPath: 'C:\\Users\\x\\Videos\\Film.mkv', port: 47318, password: 'f'.repeat(32), startTime: 1200.7 };

describe('NOTESD_VLC_EXTRA_ARGS on the VLC argv', () => {
  it('R8.4: puts the extra args after notesd flags and right before the file', () => {
    const argv = vlcArgs(L, ['--avcodec-hw=none', '--no-video-title-show']);
    expect(argv.slice(-4)).toEqual(['--start-time=1200', '--avcodec-hw=none', '--no-video-title-show', 'C:\\Users\\x\\Videos\\Film.mkv']);
    expect(argv.slice(0, 2)).toEqual(['--no-one-instance', '--no-one-instance-when-started-from-file']);
  });

  it('without extras the argv is Phase 5 argv', () => {
    expect(vlcArgs(L)).toEqual(vlcArgs(L, []));
    expect(vlcArgs(L).slice(-2)).toEqual(['--start-time=1200', 'C:\\Users\\x\\Videos\\Film.mkv']);
  });
});
```

**File:** `tests/unit/movies/vlc.health.test.ts` (new)
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetectProbe } from '../../../src/http/reveal.js';
import {
  DEFAULT_POWERSHELL_EXE,
  DEFAULT_TASKLIST_EXE,
  HealthLog,
  HealthMonitor,
  detectHealthEnv,
  healthReport,
  parsePowerShellProcesses,
  parseTasklistCsv,
  redactCommandLine,
  startedByNotesd,
  summarizeRuns,
  type HangRecord,
  type HealthDetection,
  type HealthRecord,
  type ProcessListing,
  type SampleRecord,
  type TrackedVlc,
  type VlcProcess,
} from '../../../src/movies/vlc/health.js';

const HOST = 'this-host';
const PW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OURS_CMD = `"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --no-one-instance --extraintf http --http-host 127.0.0.1 --http-port 47318 --http-password ${PW} --start-time=1200 C:\\Users\\x\\Videos\\Film.mkv`;
const FOREIGN_CMD = '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "C:\\Users\\x\\Videos\\Other.mkv"';
const ENV_OK: HealthDetection = { available: true, env: { tasklist: '/t.exe', powershell: '/p.exe' } };
const T = new Date('2026-11-14T06:00:00.000Z');

function proc(o: Partial<VlcProcess> & { pid: number }): VlcProcess {
  return { wsBytes: 500_000_000, privateBytes: 700_000_000, handles: 1500, startedAt: '2026-11-14T05:00:00.000Z', commandLine: FOREIGN_CMD, ...o };
}

class FakeLister {
  listing: ProcessListing = { kind: 'ok', detail: true, processes: [] };
  calls = 0;
  async list(): Promise<ProcessListing> {
    this.calls += 1;
    return this.listing;
  }
}

const TRACKED: TrackedVlc = {
  playId: 7,
  fileId: 3,
  name: 'Film.mkv',
  port: 47318,
  password: PW,
  state: 'paused',
  positionS: 1234.56,
  pausedSince: new Date(T.getTime() - 90_000),
  silentSince: null,
  hung: false,
};

let dir: string;
const monitors: HealthMonitor[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vlc-health-'));
});
afterEach(async () => {
  for (const m of monitors.splice(0)) await m.close();
  await rm(dir, { recursive: true, force: true });
});

function setup(o: { tracked?: TrackedVlc | null; intervalMs?: number; detection?: HealthDetection; maxLogBytes?: number } = {}) {
  const lister = new FakeLister();
  const clock = { now: T };
  const lines: string[] = [];
  let tracked = o.tracked ?? null;
  const m = new HealthMonitor({
    host: HOST,
    logDir: dir,
    intervalMs: o.intervalMs ?? 60_000,
    detect: async () => o.detection ?? ENV_OK,
    tracked: () => tracked,
    makeLister: () => lister,
    makeEvents: () => null,
    now: () => clock.now,
    log: (l) => lines.push(l),
    ...(o.maxLogBytes !== undefined ? { maxLogBytes: o.maxLogBytes } : {}),
  });
  monitors.push(m);
  return { m, lister, clock, lines, setTracked: (t: TrackedVlc | null) => (tracked = t) };
}

function records(): HealthRecord[] {
  return new HealthLog(dir, HOST).readTail(50_000_000);
}

function samples(): SampleRecord[] {
  return records().filter((r): r is SampleRecord => r.kind === 'sample');
}

describe('HealthMonitor samples', () => {
  it('R8.1: appends one sample per vlc.exe per tick, the notesd-started one with its play state and seconds paused', async () => {
    const { m, lister, clock } = setup({ tracked: TRACKED });
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 100, commandLine: OURS_CMD }), proc({ pid: 200 })] };
    await m.start();
    expect(await m.sampleNow()).toBe(2);
    expect(records().map((r) => r.kind)).toEqual(['start', 'sample', 'sample']);
    const [ours, foreign] = samples();
    expect(ours).toMatchObject({
      pid: 100,
      ws_bytes: 500_000_000,
      private_bytes: 700_000_000,
      handles: 1500,
      ours: true,
      play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 1234.6, paused_s: 90, http_silent_s: null, hung: false },
    });
    expect(ours!.cmd).toContain('--http-password ***');
    expect(JSON.stringify(records())).not.toContain(PW);
    expect(foreign).toMatchObject({ pid: 200, ours: false, play: null });
    expect(foreign!.cmd).toContain('Other.mkv');

    clock.now = new Date(T.getTime() + 30_000);
    await m.sampleNow();
    const later = samples().slice(-2);
    expect(later.map((s) => s.cmd)).toEqual([null, null]);
    expect(later[0]!.play!.paused_s).toBe(120);
    await m.close();
    expect(records().at(-1)!.kind).toBe('clean_stop');
  });

  it('R8.1: writes nothing while no vlc.exe runs, and one idle line when the last one exits', async () => {
    const { m, lister } = setup();
    await m.start();
    await m.sampleNow();
    expect(records().map((r) => r.kind)).toEqual(['start']);
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 5 })] };
    await m.sampleNow();
    lister.listing = { kind: 'ok', detail: true, processes: [] };
    await m.sampleNow();
    await m.sampleNow();
    expect(records().map((r) => r.kind)).toEqual(['start', 'sample', 'idle']);
  });

  it('keeps sampling without PowerShell detail: ours unknown, no play', async () => {
    const { m, lister } = setup({ tracked: TRACKED });
    lister.listing = { kind: 'ok', detail: false, processes: [proc({ pid: 5, privateBytes: null, handles: null, startedAt: null, commandLine: null })] };
    await m.start();
    await m.sampleNow();
    expect(samples()[0]).toMatchObject({ pid: 5, private_bytes: null, handles: null, ours: null, play: null, cmd: null });
  });

  it('stays off and writes nothing with NOTESD_VLC_HEALTH_MS=0 or without tasklist.exe, saying so once', async () => {
    const zero = setup({ intervalMs: 0 });
    await zero.m.start();
    expect(zero.m.status()).toMatchObject({ sampling: false, reason: 'disabled' });
    expect(await zero.m.sampleNow()).toBe(0);
    expect(zero.lines).toEqual(['[notesd] vlc health off (NOTESD_VLC_HEALTH_MS=0)']);

    const none = setup({ detection: { available: false, reason: 'no_tasklist' } });
    await none.m.start();
    expect(none.m.status()).toMatchObject({ sampling: false, reason: 'no_tasklist' });
    expect(none.lines).toEqual(['[notesd] vlc health off (no_tasklist)']);
    await zero.m.close();
    await none.m.close();
    expect(existsSync(new HealthLog(dir, HOST).file)).toBe(false);
  });

  it('logs a failed listing once and keeps going', async () => {
    const { m, lister, lines } = setup();
    await m.start();
    lister.listing = { kind: 'error', message: 'tasklist.exe exited 1' };
    await m.sampleNow();
    await m.sampleNow();
    expect(lines.filter((l) => l.includes('listing vlc.exe failed'))).toHaveLength(1);
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 9 })] };
    expect(await m.sampleNow()).toBe(1);
  });
});

describe('HealthLog', () => {
  it('rotates past maxBytes into one previous file and still reads across both', async () => {
    const { m, lister, clock } = setup({ maxLogBytes: 2000 });
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 5 })] };
    await m.start();
    for (let i = 0; i < 30; i++) {
      clock.now = new Date(T.getTime() + i * 30_000);
      await m.sampleNow();
    }
    const log = new HealthLog(dir, HOST);
    expect((await stat(log.file)).size).toBeLessThanOrEqual(2000);
    expect(existsSync(log.previousFile)).toBe(true);
    const all = samples();
    expect(all.at(-1)!.ts).toBe(new Date(T.getTime() + 29 * 30_000).toISOString());
    expect(all.length).toBeGreaterThan(log.readTail(2000).filter((r) => r.kind === 'sample').length - 1);
  });

  it('repairs a torn last line (a crash mid-write) before the next append', async () => {
    const log = new HealthLog(dir, HOST);
    log.append({ kind: 'idle', ts: T.toISOString(), host: HOST });
    await writeFile(log.file, `${JSON.stringify({ kind: 'idle', ts: T.toISOString(), host: HOST })}\n{"kind":"sample","ts":"2026`);
    log.append({ kind: 'clean_stop', ts: T.toISOString(), host: HOST });
    expect(log.readTail(1_000_000).map((r) => r.kind)).toEqual(['idle', 'clean_stop']);
  });
});

describe('the player link', () => {
  it('processAlive finds the tracked VLC by its password, says gone when no vlc.exe runs, unknown without detail', async () => {
    const { m, lister } = setup();
    await m.start();
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 100, commandLine: OURS_CMD }), proc({ pid: 200 })] };
    expect(await m.processAlive({ port: 47318, password: PW })).toEqual({ kind: 'alive', pid: 100 });
    expect(await m.processAlive({ port: 47319, password: 'b'.repeat(32) })).toEqual({ kind: 'gone' });
    lister.listing = { kind: 'ok', detail: true, processes: [] };
    expect(await m.processAlive({ port: 47318, password: PW })).toEqual({ kind: 'gone' });
    lister.listing = { kind: 'ok', detail: false, processes: [proc({ pid: 100, commandLine: null })] };
    expect(await m.processAlive({ port: 47318, password: PW })).toMatchObject({ kind: 'unknown' });
  });

  it('R8.3: onHang writes start and end lines with the seconds VLC has been silent', async () => {
    const { m, clock } = setup();
    await m.start();
    const base = { pid: 100, port: 47318, playId: 7, fileId: 3, name: 'Film.mkv', positionS: 1234.56, silentSince: new Date(T.getTime() - 10_000) };
    m.onHang({ ...base, phase: 'start' });
    clock.now = new Date(T.getTime() + 50_000);
    m.onHang({ ...base, phase: 'end', outcome: 'answered' });
    const hangs = records().filter((r): r is HangRecord => r.kind === 'hang');
    expect(hangs.map((h) => [h.phase, h.silent_s, h.outcome, h.position_s, h.pid])).toEqual([
      ['start', 10, null, 1234.6, 100],
      ['end', 60, 'answered', 1234.6, 100],
    ]);
  });
});

describe('detectHealthEnv', () => {
  function probe(o: { platform?: NodeJS.Platform; interop?: boolean; execs?: string[]; env?: Record<string, string> } = {}): DetectProbe {
    const execs = new Set(o.execs ?? [DEFAULT_TASKLIST_EXE, DEFAULT_POWERSHELL_EXE]);
    return {
      platform: o.platform ?? 'linux',
      env: { PATH: '/usr/bin:/bin', ...(o.env ?? {}) },
      exists: async (p) => (o.interop ?? true) && p === '/proc/sys/fs/binfmt_misc/WSLInterop',
      executable: async (p) => execs.has(p),
    };
  }

  it('finds both Windows binaries at their absolute defaults, honours overrides, and says why it is off', async () => {
    expect(await detectHealthEnv(probe())).toEqual({ available: true, env: { tasklist: DEFAULT_TASKLIST_EXE, powershell: DEFAULT_POWERSHELL_EXE } });
    expect(await detectHealthEnv(probe({ execs: ['/x/t.exe'], env: { NOTESD_TASKLIST_EXE: '/x/t.exe' } }))).toEqual({
      available: true,
      env: { tasklist: '/x/t.exe', powershell: null },
    });
    expect(await detectHealthEnv(probe({ execs: [] }))).toEqual({ available: false, reason: 'no_tasklist' });
    expect(await detectHealthEnv(probe({ interop: false }))).toEqual({ available: false, reason: 'no_interop' });
    expect(await detectHealthEnv(probe({ platform: 'darwin' }))).toEqual({ available: false, reason: 'not_linux' });
  });
});

describe('reading the Windows side', () => {
  it('parses tasklist CSV (MEASURED INFO line, both locale separators) and ignores other images', () => {
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([]);
    expect(parseTasklistCsv('"vlc.exe","13572","Console","1","512,000 K"\r\n"vlc.exe","2048","Console","1","1.024 K"\r\n"explorer.exe","5044","Console","1","409,188 K"\r\n')).toEqual([
      { pid: 13572, wsBytes: 512_000 * 1024 },
      { pid: 2048, wsBytes: 1024 * 1024 },
    ]);
  });

  it('parses the PowerShell process JSON (MEASURED shape), a single object, and refuses garbage', () => {
    const one = '{"pid":5044,"ws":419008512,"priv":267444224,"handles":3170,"started":"2026-11-14T06:04:49.2149510Z","cmd":"C:\\\\Windows\\\\Explorer.EXE"}';
    expect(parsePowerShellProcesses(`[${one}]\r\n`)).toEqual([
      { pid: 5044, wsBytes: 419008512, privateBytes: 267444224, handles: 3170, startedAt: '2026-11-14T06:04:49.2149510Z', commandLine: 'C:\\Windows\\Explorer.EXE' },
    ]);
    expect(parsePowerShellProcesses(`#< CLIXML\r\n${one}\r\n`)).toHaveLength(1);
    expect(parsePowerShellProcesses('[]')).toEqual([]);
    expect(parsePowerShellProcesses('Get-CimInstance : Access denied')).toBeNull();
    expect(parsePowerShellProcesses('[{"pid":"x"}]')).toBeNull();
  });

  it('redacts the HTTP password in both flag forms and recognises a notesd launch', () => {
    expect(redactCommandLine(OURS_CMD)).not.toContain(PW);
    expect(redactCommandLine(`vlc.exe --http-password=${PW} f.mkv`)).toBe('vlc.exe --http-password=*** f.mkv');
    expect(startedByNotesd(OURS_CMD)).toBe(true);
    expect(startedByNotesd(FOREIGN_CMD)).toBe(false);
    expect(redactCommandLine('x'.repeat(700))).toHaveLength(601);
  });
});

describe('the health report', () => {
  function sample(minute: number, o: Partial<SampleRecord> = {}): SampleRecord {
    return {
      kind: 'sample',
      ts: new Date(T.getTime() + minute * 60_000).toISOString(),
      host: HOST,
      pid: 100,
      ws_bytes: 500_000_000 + minute * 1_000_000,
      private_bytes: 700_000_000 + minute * 10_485_760,
      handles: 1500 + minute,
      proc_started_at: '2026-11-14T05:00:00.000Z',
      ours: true,
      play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 1200, paused_s: minute * 60, http_silent_s: null, hung: false },
      cmd: null,
      ...o,
    };
  }

  it('R8.5: summarizes each VLC run with its growth per paused minute', () => {
    const run = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => sample(m));
    run[0] = sample(0, { play: { ...run[0]!.play!, state: 'playing', paused_s: null } });
    const foreign = [sample(0, { pid: 200, ours: false, play: null, private_bytes: null }), sample(10, { pid: 200, ours: false, play: null, private_bytes: null })];
    const [ours, theirs] = summarizeRuns([...run, ...foreign]);
    expect(ours).toMatchObject({
      pid: 100,
      ours: true,
      samples: 11,
      ws_max: 510_000_000,
      private_max: 700_000_000 + 10 * 10_485_760,
      handles_max: 1510,
      paused_s_max: 600,
      private_growth_per_paused_min: 10_485_760,
      ws_growth_per_paused_min: 1_000_000,
      private_growth_per_min: 10_485_760,
    });
    expect(theirs).toMatchObject({ pid: 200, ours: false, private_growth_per_paused_min: null, ws_growth_per_paused_min: null, ws_growth_per_min: 1_000_000 });
  });

  it('R8.5: returns the newest `limit` samples, the hangs, incidents and the last start', () => {
    const recs: HealthRecord[] = [
      { kind: 'start', ts: T.toISOString(), host: HOST, daemon_pid: 1, interval_ms: 30_000, process_detail: true, previous: 'none' },
      sample(0),
      sample(1),
      sample(2),
    ];
    const status = { sampling: true, reason: null, interval_ms: 30_000, process_detail: true, log_file: '/x' };
    const r = healthReport(recs, { host: HOST, limit: 2, status });
    expect(r.samples.map((s) => s.ts)).toEqual([sample(1).ts, sample(2).ts]);
    expect(r.runs[0]!.samples).toBe(3);
    expect(r.last_start?.kind).toBe('start');
    expect(r).toMatchObject({ host: HOST, sampling: true, hangs: [], incidents: [] });
  });
});
```

**File:** `tests/unit/movies/vlc.incidents.test.ts` (new)
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthLog, HealthMonitor, type HangRecord, type HealthRecord, type IncidentRecord, type SampleRecord, type StartRecord } from '../../../src/movies/vlc/health.js';
import {
  INCIDENT_SAMPLES,
  analyzePreviousRun,
  eventsScript,
  exceptionCode,
  incidentWindow,
  parseWinEvents,
  type EventLogReader,
} from '../../../src/movies/vlc/incidents.js';

const HOST = 'this-host';
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

/** MEASURED 2026-11-14: eventsScript's output for the 13:03 WIB crash on this machine (messages cut). */
const MEASURED_STDOUT =
  JSON.stringify([
    { time: '2026-11-14T06:03:45.7356997Z', id: 1000, provider: 'Application Error', props: ['Explorer.EXE', '10.0.22621.6199', '89967d6d', 'Windows.UI.Xaml.dll', '10.0.22621.6133', 'd64b13a4', 'c000027b', '00000000004cae0f', '10444'], message: 'Faulting application name: Explorer.EXE' },
    { time: '2026-11-14T06:03:47.0286178Z', id: 1000, provider: 'Application Error', props: ['WindowsTerminal.exe', '1.24.2610.1001', '6abeb4ee', 'igd10umt64xe.DLL', '32.0.101.6733', '67ed76ed', 'c0000005', '00000000008d9409', '23248'], message: 'Faulting application name: WindowsTerminal.exe' },
    { time: '2026-11-14T06:04:53.7853510Z', id: 1000, provider: 'Application Error', props: ['WindowsTerminal.exe', '1.24.2610.1001', '6abeb4ee', 'ucrtbase.dll', '10.0.22621.3593', '10c46e71', 'c0000409', '000000000007f6fe', '11692'], message: 'Faulting application name: WindowsTerminal.exe' },
    { time: '2026-11-14T06:04:00.0000000Z', id: 1002, provider: 'Application Hang', props: ['vlc.exe', '3.0.21.0', '3a5c', '01db5a1c'], message: 'The program vlc.exe version 3.0.21.0 stopped interacting with Windows' },
    { time: '2026-11-14T04:00:00.0000000Z', id: 1000, provider: 'Application Error', props: ['old.exe', '1', '0', 'old.dll', '1', '0', 'c0000409'], message: 'outside the window' },
  ]) + '\r\n';

function start(ts: string): StartRecord {
  return { kind: 'start', ts, host: HOST, daemon_pid: 1, interval_ms: 30_000, process_detail: true, previous: 'none' };
}

function sample(ts: string, play: boolean): SampleRecord {
  return {
    kind: 'sample',
    ts,
    host: HOST,
    pid: 4242,
    ws_bytes: 600_000_000,
    private_bytes: 800_000_000,
    handles: 1500,
    proc_started_at: '2026-11-14T05:30:00.000Z',
    ours: true,
    play: play ? { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 3600, paused_s: 900, http_silent_s: null, hung: false } : null,
    cmd: null,
  };
}

const T0 = at('2026-11-14T05:38:30.000Z');
const LAST_SAMPLE = '2026-11-14T06:03:30.000Z';
function crashedRun(): HealthRecord[] {
  const recs: HealthRecord[] = [start('2026-11-14T05:38:00.000Z')];
  for (let i = 0; i <= 50; i++) recs.push(sample(iso(T0 + i * 30_000), true));
  const hang: HangRecord = { kind: 'hang', ts: '2026-11-14T06:02:00.000Z', host: HOST, phase: 'start', pid: 4242, port: 47318, play_id: 7, file_id: 3, name: 'Film.mkv', position_s: 3600, silent_s: 10, outcome: null };
  recs.push(hang);
  return recs;
}

describe('analyzePreviousRun', () => {
  it('R8.2: a run whose newest state line is a sample died while sampling', () => {
    const prev = analyzePreviousRun(crashedRun());
    expect(prev).toMatchObject({ kind: 'unclean_sampling', previousStartAt: '2026-11-14T05:38:00.000Z', lastSampleAt: LAST_SAMPLE, lastRecordAt: '2026-11-14T06:02:00.000Z' });
    if (prev.kind !== 'unclean_sampling') throw new Error('unreachable');
    expect(prev.samples).toHaveLength(INCIDENT_SAMPLES);
    expect(prev.samples.at(-1)!.ts).toBe(LAST_SAMPLE);
    expect(prev.hangs).toHaveLength(1);
  });

  it('clean_stop is clean; idle, or a start with nothing after it, is unclean but not while sampling; an empty log is none', () => {
    expect(analyzePreviousRun([...crashedRun(), { kind: 'clean_stop', ts: '2026-11-14T06:10:00.000Z', host: HOST }]).kind).toBe('clean');
    expect(analyzePreviousRun([...crashedRun(), { kind: 'idle', ts: '2026-11-14T06:05:00.000Z', host: HOST }]).kind).toBe('unclean_idle');
    expect(analyzePreviousRun([...crashedRun(), start('2026-11-14T06:07:00.000Z')]).kind).toBe('unclean_idle');
    expect(analyzePreviousRun([]).kind).toBe('none');
  });
});

describe('the event window and parsing', () => {
  it('spans 10 min before the last sample to the daemon start, capped at 15 min after the last line', () => {
    const prev = { lastSampleAt: LAST_SAMPLE, lastRecordAt: '2026-11-14T06:03:30.000Z' };
    const soon = incidentWindow(prev, new Date('2026-11-14T06:07:00.000Z'));
    expect([soon.from.toISOString(), soon.to.toISOString()]).toEqual(['2026-11-14T05:53:30.000Z', '2026-11-14T06:07:00.000Z']);
    const days = incidentWindow(prev, new Date('2026-11-16T09:00:00.000Z'));
    expect(days.to.toISOString()).toBe('2026-11-14T06:18:30.000Z');
  });

  it('R8.2: reads application, faulting module and exception code from the MEASURED 13:03 crash events', () => {
    const events = parseWinEvents(MEASURED_STDOUT)!;
    expect(events.map((e) => [e.event_id, e.application, e.module, e.exception_code])).toEqual([
      [1000, 'Explorer.EXE', 'Windows.UI.Xaml.dll', '0xc000027b'],
      [1000, 'WindowsTerminal.exe', 'igd10umt64xe.DLL', '0xc0000005'],
      [1000, 'WindowsTerminal.exe', 'ucrtbase.dll', '0xc0000409'],
      [1002, 'vlc.exe', null, null],
      [1000, 'old.exe', 'old.dll', '0xc0000409'],
    ]);
    expect(parseWinEvents('[]')).toEqual([]);
    expect(parseWinEvents('Get-WinEvent : error')).toBeNull();
    expect(exceptionCode('0xC0000005')).toBe('0xc0000005');
    expect(exceptionCode('not a code')).toBe('not a code');
  });

  it('asks Windows in local time (MEASURED: a UTC DateTime matched nothing)', () => {
    const s = eventsScript(new Date('2026-11-14T05:53:30.000Z'), new Date('2026-11-14T06:07:00.000Z'));
    expect(s).toContain("[DateTimeOffset]::Parse('2026-11-14T05:53:30.000Z').LocalDateTime");
    expect(s).toContain("ProviderName = 'Application Error', 'Application Hang'");
  });
});

describe('HealthMonitor.start after a crash', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vlc-incident-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function monitor(events: EventLogReader | null, now: string): { m: HealthMonitor; asked: Array<[string, string]> } {
    const asked: Array<[string, string]> = [];
    const reader: EventLogReader | null =
      events === null
        ? null
        : {
            read: async (from, to) => {
              asked.push([from.toISOString(), to.toISOString()]);
              return events.read(from, to);
            },
          };
    const m = new HealthMonitor({
      host: HOST,
      logDir: dir,
      intervalMs: 60_000,
      detect: async () => ({ available: true, env: { tasklist: '/t.exe', powershell: '/p.exe' } }),
      tracked: () => null,
      makeLister: () => ({ list: async () => ({ kind: 'ok', detail: true, processes: [] }) }),
      makeEvents: () => reader,
      now: () => new Date(now),
      log: () => {},
    });
    return { m, asked };
  }

  const measured: EventLogReader = { read: async () => ({ kind: 'ok', events: parseWinEvents(MEASURED_STDOUT)! }) };

  function seed(recs: HealthRecord[]): HealthLog {
    const log = new HealthLog(dir, HOST);
    for (const r of recs) log.append(r);
    return log;
  }

  it('R8.2: writes one incident with the last samples, the open play, the hang and the in-window Windows events', async () => {
    const log = seed(crashedRun());
    const { m, asked } = monitor(measured, '2026-11-14T06:07:00.000Z');
    await m.start();
    await m.settled();
    await m.close();
    const recs = log.readTail(10_000_000);
    const incidents = recs.filter((r): r is IncidentRecord => r.kind === 'incident');
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(asked).toEqual([['2026-11-14T05:53:30.000Z', '2026-11-14T06:07:00.000Z']]);
    expect(inc).toMatchObject({
      last_sample_at: LAST_SAMPLE,
      previous_start_at: '2026-11-14T05:38:00.000Z',
      window: { from: '2026-11-14T05:53:30.000Z', to: '2026-11-14T06:07:00.000Z' },
      open_play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', paused_s: 900 },
      events_error: null,
    });
    expect(inc.samples).toHaveLength(INCIDENT_SAMPLES);
    expect(inc.hangs.map((h) => h.phase)).toEqual(['start']);
    expect(inc.events.map((e) => [e.time, e.application, e.module, e.exception_code])).toEqual([
      ['2026-11-14T06:03:45.7356997Z', 'Explorer.EXE', 'Windows.UI.Xaml.dll', '0xc000027b'],
      ['2026-11-14T06:03:47.0286178Z', 'WindowsTerminal.exe', 'igd10umt64xe.DLL', '0xc0000005'],
      ['2026-11-14T06:04:00.0000000Z', 'vlc.exe', null, null],
      ['2026-11-14T06:04:53.7853510Z', 'WindowsTerminal.exe', 'ucrtbase.dll', '0xc0000409'],
    ]);
    const starts = recs.filter((r): r is StartRecord => r.kind === 'start');
    expect(starts.at(-1)!.previous).toBe('unclean_sampling');
  });

  it('writes no incident after a clean stop or an unclean stop with no VLC open', async () => {
    seed([...crashedRun(), { kind: 'clean_stop', ts: '2026-11-14T06:05:00.000Z', host: HOST }]);
    const a = monitor(measured, '2026-11-14T06:07:00.000Z');
    await a.m.start();
    await a.m.settled();
    await a.m.close();
    seed([{ kind: 'idle', ts: '2026-11-14T06:08:00.000Z', host: HOST }]);
    const b = monitor(measured, '2026-11-14T06:09:00.000Z');
    await b.m.start();
    await b.m.settled();
    await b.m.close();
    const recs = new HealthLog(dir, HOST).readTail(10_000_000);
    expect(recs.some((r) => r.kind === 'incident')).toBe(false);
    expect(a.asked).toEqual([]);
  });

  it('records the incident with events_error when Windows events cannot be read', async () => {
    const log = seed(crashedRun());
    const { m } = monitor(null, '2026-11-14T06:07:00.000Z');
    await m.start();
    await m.settled();
    await m.close();
    const inc = log.readTail(10_000_000).find((r): r is IncidentRecord => r.kind === 'incident')!;
    expect(inc).toMatchObject({ events: [], events_error: 'no powershell.exe: Windows events not read' });
    expect(inc.samples.length).toBeGreaterThan(0);
  });
});
```

**File:** `tests/unit/movies/player.hang.test.ts` (new)
```ts
import { describe, expect, it, vi } from 'vitest';
import { HANG_AFTER_SILENT_POLLS, MAX_READ_ERRORS, MoviePlayer, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import type { VlcEndpoint, VlcReply } from '../../../src/movies/vlc/http.js';
import type { HangEvent, PidCheck, PlayerHealthLink } from '../../../src/movies/vlc/health.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };
const PORT = 47318;

/** A VLC that stops answering on some ports (curl.exe -m 2 exits 28). */
class SilentVlc extends MemVlc {
  readonly silent = new Set<number>();
  /** Ports that miss exactly one status read. */
  readonly silentOnce = new Set<number>();
  override async status(curl: string, ep: VlcEndpoint): Promise<VlcReply> {
    if (this.silentOnce.delete(ep.port)) return { kind: 'error', message: 'curl exited 28' };
    if (this.silent.has(ep.port)) return { kind: 'error', message: 'curl exited 28' };
    return super.status(curl, ep);
  }
}

class FakeHealth implements PlayerHealthLink {
  check: PidCheck = { kind: 'alive', pid: 4242 };
  checks = 0;
  readonly events: HangEvent[] = [];
  async processAlive(): Promise<PidCheck> {
    this.checks += 1;
    return this.check;
  }
  onHang(e: HangEvent): void {
    this.events.push(e);
  }
}

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
  async closeOpenPlays(): Promise<number> {
    return 0;
  }
  play(id: number): PlayRow {
    const p = this.plays.find((x) => x.id === id);
    if (p === undefined) throw new Error(`no play ${id}`);
    return p;
  }
}

function setup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new SilentVlc();
  const health = new FakeHealth();
  repo.files.set(1, fileRow({ id: 1, path: '/lib/A.mkv', name: 'A.mkv', durationS: 7200 }));
  const player = new MoviePlayer({
    repo: repo as unknown as PlayerRepo,
    host: 'this-host',
    httpPort: PORT,
    pollMs: 5,
    detect: async () => ENV_OK,
    launcher: vlc,
    reader: vlc,
    wslpath: async (_bin, abs) => `C:${abs.replaceAll('/', '\\')}`,
    exists: async () => true,
    readyTimeoutMs: 100,
    readyIntervalMs: 5,
    playingTimeoutMs: 50,
    health,
    log: () => {},
    ...over,
  });
  return { repo, vlc, health, player };
}

async function playingAt1300(s: ReturnType<typeof setup>): Promise<number> {
  const started = await s.player.play(1);
  s.vlc.at(PORT).time = 1300;
  await vi.waitFor(() => expect(s.repo.play(started.play_id).positionS).toBe(1300));
  return started.play_id;
}

describe('the hang rule (R8.3)', () => {
  it('R8.3: a VLC silent with its process alive gets one hang line and keeps its play open at the last position past MAX_READ_ERRORS', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.checks).toBeGreaterThanOrEqual(MAX_READ_ERRORS + 3));
    expect(s.health.events).toHaveLength(1);
    expect(s.health.events[0]).toMatchObject({ phase: 'start', pid: 4242, port: PORT, playId, positionS: 1300 });
    expect(s.repo.play(playId)).toMatchObject({ endedAt: null, positionS: 1300 });
    expect(s.player.current()?.play_id).toBe(playId);
    expect(s.player.healthView()).toMatchObject({ hung: true, positionS: 1300 });
    expect(s.player.healthView()!.silentSince).toBeInstanceOf(Date);

    s.vlc.silent.delete(PORT);
    await vi.waitFor(() => expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'answered' }));
    expect(s.player.healthView()).toMatchObject({ hung: false, silentSince: null });
    s.vlc.at(PORT).time = 1400;
    await vi.waitFor(() => expect(s.repo.play(playId).positionS).toBe(1400));
    await s.player.close();
  });

  it('R8.3: silent and then gone ends the play exited at the position read before the silence', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    s.health.check = { kind: 'gone' };
    await vi.waitFor(() => expect(s.repo.play(playId).endedAt).not.toBeNull());
    expect(s.repo.play(playId).positionS).toBe(1300);
    expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'exited' });
    expect(s.player.current()).toBeNull();
  });

  it('R8.3: connection refused while the process still exists is a hang, not an exit', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.at(PORT).up = false;
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    expect(s.health.events[0]!.phase).toBe('start');
    expect(s.repo.play(playId).endedAt).toBeNull();
    s.health.check = { kind: 'gone' };
    await vi.waitFor(() => expect(s.repo.play(playId).endedAt).not.toBeNull());
    expect(s.repo.play(playId).positionS).toBe(1300);
  });

  it('does not call a single silent poll a hang', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silentOnce.add(PORT);
    await vi.waitFor(() => expect(s.vlc.silentOnce.size).toBe(0));
    s.vlc.at(PORT).time = 1350;
    await vi.waitFor(() => expect(s.repo.play(playId).positionS).toBe(1350));
    expect(HANG_AFTER_SILENT_POLLS).toBe(2);
    expect(s.health.checks).toBe(0);
    expect(s.health.events).toEqual([]);
    await s.player.close();
  });

  it('with the process unknown, keeps Phase 5 rules: a refused poll ends at once, curl errors end after MAX_READ_ERRORS', async () => {
    const a = setup();
    a.health.check = { kind: 'unknown', reason: 'no_process_detail' };
    const pa = await playingAt1300(a);
    a.vlc.at(PORT).up = false;
    await vi.waitFor(() => expect(a.repo.play(pa).endedAt).not.toBeNull());
    expect(a.health.events).toEqual([]);

    const b = setup();
    b.health.check = { kind: 'unknown', reason: 'no_process_detail' };
    const pb = await playingAt1300(b);
    b.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(b.repo.play(pb).endedAt).not.toBeNull());
    expect(b.repo.play(pb).positionS).toBe(1300);
    expect(b.health.events).toEqual([]);
  });

  it('a hang that is still open when tracking ends is closed as tracking_ended', async () => {
    const s = setup();
    await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    await s.player.close();
    expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'tracking_ended' });
  });
});

describe('the paused clock (R8.1)', () => {
  it('R8.1: stamps the first paused poll and clears it when VLC plays again', async () => {
    let clock = new Date('2026-11-14T06:00:00.000Z');
    const s = setup({ now: () => clock });
    await playingAt1300(s);
    expect(s.player.healthView()!.pausedSince).toBeNull();
    s.vlc.at(PORT).state = 'paused';
    await vi.waitFor(() => expect(s.player.healthView()!.state).toBe('paused'));
    const since = s.player.healthView()!.pausedSince;
    expect(since?.toISOString()).toBe('2026-11-14T06:00:00.000Z');
    clock = new Date('2026-11-14T06:10:00.000Z');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.player.healthView()!.pausedSince).toEqual(since);
    s.vlc.at(PORT).state = 'playing';
    await vi.waitFor(() => expect(s.player.healthView()!.pausedSince).toBeNull());
    await s.player.close();
  });
});
```
`MemVlc.at(port).up` is the field Phase 5's `MemVlc` reads for "nothing listens" (its `reply`
returns `gone` when `!up`).

### Step 12: integration tests
**File:** `tests/integration/movies.health.int.test.ts` (new): the fake VLC process over real
`/usr/bin/curl`, the real `buildMoviePlayback` (so the config's extra args take the daemon's path),
real `movie_plays` rows, the real route. The Windows process list comes from the fake VLC's launch
log: every launch whose process is alive.
```ts
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG, type MoviesConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { moviePlays } from '../../src/db/schema.js';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../../src/http/reveal.js';
import { buildMoviePlayback, type MoviePlayer, type PlaybackService, type PlayStarted } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import {
  HealthMonitor,
  parseHealthLine,
  type HangRecord,
  type HealthRecord,
  type HealthReport,
  type ProcessLister,
  type SampleRecord,
  type VlcProcess,
} from '../../src/movies/vlc/health.js';
import { seedFile, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';
import { closeTestDb, openTestDb } from './setup.js';

const execFileAsync = promisify(execFile);
const CURL = '/usr/bin/curl';
const FAKE_VLC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/movies/fake-vlc.mjs');
const HOST = 'health-host';
const EXTRA = ['--avcodec-hw=none', '--no-video-title-show'];

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
  return argv[argv.indexOf(name) + 1] ?? '';
}

/** Alive and not a zombie (an exited, unreaped child still answers kill -0). */
function alive(pid: number): boolean {
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

/** "Windows" as the health monitor sees it: every fake VLC launch still running, with its argv as the command line. */
function launchLogLister(logFile: string): ProcessLister {
  return {
    async list() {
      let text = '';
      try {
        text = await readFile(logFile, 'utf8');
      } catch {
        text = '';
      }
      const processes: VlcProcess[] = [];
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const l = JSON.parse(line) as Launch;
        if (!alive(l.pid)) continue;
        processes.push({
          pid: l.pid,
          wsBytes: 300_000_000,
          privateBytes: 400_000_000,
          handles: 900,
          startedAt: null,
          commandLine: `"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" ${l.argv.join(' ')}`,
        });
      }
      return { kind: 'ok', detail: true, processes };
    },
  };
}

/** WSL as detectPlayerEnv needs it, on any Linux: interop "registered", wslpath "on PATH", real files otherwise. */
function wslProbe(): DetectProbe {
  const real = nodeProbe();
  const interop: readonly string[] = WSL_INTEROP_FILES;
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    exists: async (p) => interop.includes(p) || real.exists(p),
    executable: async (p) => p === '/usr/bin/wslpath' || real.executable(p),
  };
}

describe.skipIf(!existsSync(CURL))('VLC health with a fake VLC over curl', () => {
  let db: Db;
  let dir: string;
  let launchLog: string;
  let player: MoviePlayer;
  let monitor: HealthMonitor;
  let app: Hono;
  let fileId: number;
  let started: PlayStarted;
  let launch: Launch;
  let port: number;
  let position: number;

  async function launches(): Promise<Launch[]> {
    try {
      return (await readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch);
    } catch {
      return [];
    }
  }

  function records(): HealthRecord[] {
    try {
      return readFileSync(monitor.store.file, 'utf8')
        .split('\n')
        .map(parseHealthLine)
        .filter((r): r is HealthRecord => r !== null);
    } catch {
      return [];
    }
  }

  async function playRow() {
    const [row] = await db.select().from(moviePlays).where(eq(moviePlays.id, started.play_id));
    return row!;
  }

  beforeAll(async () => {
    db = openTestDb();
    await truncateMovies(db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-vlc-health-'));
    launchLog = path.join(dir, 'launches.jsonl');
    const basePort = await freePortBlock(10);
    const vlcBin = path.join(dir, 'vlc.exe');
    await writeFile(
      vlcBin,
      `#!/bin/sh\nexport FAKE_VLC_LOG='${launchLog}' FAKE_VLC_SPEED='1' FAKE_VLC_LIFE_MS='120000'\nexec "${process.execPath}" "${FAKE_VLC}" "$@"\n`,
    );
    await chmod(vlcBin, 0o755);
    const film = path.join(dir, 'Health.Film.2026.mkv');
    await writeFile(film, 'x');
    await seedTitle(db, { id: 'movie-990001', kind: 'movie', tmdbId: 990001, title: 'Health Film' });
    fileId = await seedFile(db, { titleId: 'movie-990001', host: HOST, path: film, durationS: 7200 });
    const config: MoviesConfig = {
      ...DEFAULT_MOVIES_CONFIG,
      enabled: true,
      vlc: { ...DEFAULT_MOVIES_CONFIG.vlc, bin: vlcBin, curlExe: CURL, httpPort: basePort, pollMs: 200, healthMs: 60_000, extraArgs: EXTRA },
    };
    monitor = new HealthMonitor({
      host: HOST,
      logDir: path.join(dir, 'movies'),
      intervalMs: 60_000,
      detect: async () => ({ available: true, env: { tasklist: '/fake/tasklist.exe', powershell: '/fake/powershell.exe' } }),
      tracked: () => player.healthView(),
      makeLister: () => launchLogLister(launchLog),
      makeEvents: () => null,
      log: () => {},
    });
    const service = {
      repo: new MoviesRepo(db),
      host: HOST,
      tmdb: null,
      events: { changed: () => undefined },
      addSyncHook: () => undefined,
    } as unknown as PlaybackService;
    player = buildMoviePlayback(service, config, {
      probe: wslProbe(),
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      health: monitor,
    });
    await monitor.start();
    app = new Hono();
    app.route('/', moviesPlayRoutes({ db, moviesPlayer: player, moviesHealth: monitor }));
  });

  afterAll(async () => {
    await player.close();
    await monitor.close();
    for (const l of await launches()) {
      if (alive(l.pid)) process.kill(l.pid, 'SIGKILL');
    }
    await truncateMovies(db);
    await closeTestDb(db);
    await rm(dir, { recursive: true, force: true });
  });

  it('R8.4: the VLC notesd starts carries NOTESD_VLC_EXTRA_ARGS right before the file', async () => {
    started = await player.play(fileId);
    expect(started.tracking).toBe(true);
    const all = await launches();
    expect(all).toHaveLength(1);
    launch = all[0]!;
    const fileAt = launch.argv.length - 1;
    expect(launch.argv[fileAt]).toBe('C:\\fake\\Health.Film.2026.mkv');
    expect(launch.argv.slice(fileAt - EXTRA.length, fileAt)).toEqual(EXTRA);
    port = Number(argOf(launch.argv, '--http-port'));
  });

  it('R8.1: a sample of the notesd-started VLC carries its play, its paused state and seconds paused', async () => {
    const pw = argOf(launch.argv, '--http-password');
    await execFileAsync(CURL, ['-s', '-m', '2', '-u', `:${pw}`, `http://127.0.0.1:${port}/requests/status.json?command=pl_pause`]);
    await vi.waitFor(() => expect(player.current()?.state).toBe('paused'), { timeout: 5000, interval: 50 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await monitor.sampleNow()).toBe(1);
    const sample = records().filter((r): r is SampleRecord => r.kind === 'sample').at(-1)!;
    expect(sample).toMatchObject({ pid: launch.pid, ours: true, play: { play_id: started.play_id, file_id: fileId, state: 'paused', hung: false } });
    expect(sample.play!.paused_s).toBeGreaterThanOrEqual(1);
    expect(sample.cmd).toContain('--http-password ***');
    expect(readFileSync(monitor.store.file, 'utf8')).not.toContain(pw);
    position = player.current()!.position;
  });

  it('R8.3: a VLC that stops answering while its process lives gets a hang line, and its play stays open at the last position', async () => {
    await fetch(`http://127.0.0.1:${port}/fake/hang?ms=7000`);
    await vi.waitFor(() => expect(records().some((r) => r.kind === 'hang' && r.phase === 'start')).toBe(true), { timeout: 15_000, interval: 200 });
    const hangStart = records().find((r): r is HangRecord => r.kind === 'hang' && r.phase === 'start')!;
    expect(hangStart).toMatchObject({ pid: launch.pid, port, play_id: started.play_id, file_id: fileId, outcome: null });
    expect(hangStart.position_s).toBeCloseTo(position, 0);
    const row = await playRow();
    expect(row.endedAt).toBeNull();
    expect(row.positionS).toBeCloseTo(position, 0);
    expect(player.healthView()?.hung).toBe(true);

    await vi.waitFor(() => expect(records().some((r) => r.kind === 'hang' && r.phase === 'end' && r.outcome === 'answered')).toBe(true), {
      timeout: 20_000,
      interval: 250,
    });
    expect(player.current()?.play_id).toBe(started.play_id);
  }, 45_000);

  it('R8.3: when that VLC exits, the play closes at the position it had before the hang', async () => {
    await fetch(`http://127.0.0.1:${port}/fake/quit`);
    await vi.waitFor(async () => expect((await playRow()).endedAt).not.toBeNull(), { timeout: 15_000, interval: 200 });
    expect((await playRow()).positionS).toBeCloseTo(position, 0);
    expect(player.current()).toBeNull();
  }, 30_000);

  it('R8.5: GET /api/movies/player/health returns the samples, the hang, the run summary; 400 on a bad limit; 503 with movies off', async () => {
    const res = await app.request('/api/movies/player/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body).toMatchObject({ host: HOST, sampling: true, reason: null, interval_ms: 60_000, process_detail: true, incidents: [] });
    expect(body.samples.map((s) => s.pid)).toEqual([launch.pid]);
    expect(body.hangs.map((h) => [h.phase, h.outcome])).toEqual([
      ['start', null],
      ['end', 'answered'],
    ]);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ pid: launch.pid, ours: true, samples: 1 });
    expect(body.last_start?.kind).toBe('start');
    expect((await app.request('/api/movies/player/health?limit=0')).status).toBe(400);
    expect((await app.request('/api/movies/player/health?limit=2001')).status).toBe(400);
    const off = new Hono();
    off.route('/', moviesPlayRoutes({ db, moviesPlayer: null, moviesHealth: null }));
    const offRes = await off.request('/api/movies/player/health');
    expect(offRes.status).toBe(503);
    expect(await offRes.json()).toMatchObject({ error: 'movies_off' });
  });
});
```

**File:** `tests/integration/movies.healthCrash.int.test.ts` (new): two real daemons from this
checkout, as child processes (`node --import tsx src/main.ts`, one process, so SIGKILL leaves no
grandchild), against the test database, with the fake Windows side behind `NOTESD_TASKLIST_EXE` /
`NOTESD_POWERSHELL_EXE`. The first is SIGKILLed while it samples a VLC. The second must write the
incident and serve it over HTTP. Skipped where WSL interop is not registered (detection needs it).
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WSL_INTEROP_FILES } from '../../src/http/reveal.js';
import { healthLogPath, parseHealthLine, type HealthRecord, type HealthReport, type IncidentRecord, type SampleRecord } from '../../src/movies/vlc/health.js';
import { testDatabaseUrl } from './setup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_WINDOWS = path.join(ROOT, 'tests/fixtures/movies/fake-windows.mjs');
const WSL = WSL_INTEROP_FILES.some((f) => existsSync(f));

interface Child {
  proc: ChildProcess;
  port: number;
  exited: Promise<number | null>;
}

async function startChild(env: NodeJS.ProcessEnv): Promise<Child> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not listen within 30 s:\n${out}`)), 30_000);
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.stderr?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited ${code} during startup:\n${out}`));
    });
  });
  return { proc, port, exited };
}

async function records(file: string): Promise<HealthRecord[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .map(parseHealthLine)
      .filter((r): r is HealthRecord => r !== null);
  } catch {
    return [];
  }
}

describe.skipIf(!WSL)('VLC health across a daemon crash', () => {
  let dir = '';
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('R8.2: a daemon SIGKILLed while sampling a vlc.exe leaves its samples; the next start writes one incident with the Windows events and serves it (R8.1, R8.5)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-health-crash-'));
    const dataDir = path.join(dir, 'data');
    const state = path.join(dir, 'win.json');
    const now = Date.now();
    await writeFile(
      state,
      JSON.stringify({
        vlc: [
          {
            pid: 4242,
            ws: 524_288_000,
            priv: 734_003_200,
            handles: 1500,
            started: new Date(now - 3_600_000).toISOString(),
            cmd: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "C:\\Users\\x\\Videos\\Film.mkv"',
          },
        ],
        events: [
          { time: new Date(now - 60_000).toISOString(), id: 1000, provider: 'Application Error', props: ['vlc.exe', '3.0.21.0', '6abeb4ee', 'libdirect3d11_filters_plugin.dll', '3.0.21.0', '0', 'c0000005', '0000000000012345', '4242'], message: 'Faulting application name: vlc.exe' },
          { time: new Date(now - 30_000).toISOString(), id: 1002, provider: 'Application Hang', props: ['vlc.exe', '3.0.21.0', '1092'], message: 'The program vlc.exe version 3.0.21.0 stopped interacting with Windows' },
          { time: new Date(now - 3 * 3_600_000).toISOString(), id: 1000, provider: 'Application Error', props: ['old.exe', '1', '0', 'old.dll', '1', '0', 'c0000409'], message: 'outside the window' },
        ],
      }),
    );
    const wrap = async (mode: string): Promise<string> => {
      const f = path.join(dir, `${mode}.exe`);
      await writeFile(f, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WINDOWS}" ${mode} "$@"\n`);
      await chmod(f, 0o755);
      return f;
    };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: testDatabaseUrl(),
      NOTESD_PORT: '0',
      NOTES_DATA_DIR: dataDir,
      CLAUDE_HOME: path.join(dir, 'claude'),
      NOTES_WORKTREES_DIR: path.join(dir, 'worktrees'),
      NOTESD_SWARM_SCRIPT: path.join(dir, 'no-swarm.py'),
      OPENROUTER_API_KEY: '',
      CHAT_BRAIN: 'claude',
      NOTESD_SESSIONS: 'off',
      NOTESD_ADVERSARY: 'off',
      NOTESD_SEER_DISPATCH: 'off',
      NOTESD_MOVIES: 'on',
      NOTESD_MOVIES_ROOTS: '',
      TMDB_API_READ_ACCESS_TOKEN: '',
      TMDB_API_KEY: '',
      NOTESD_VLC_INI: '',
      NOTESD_VLC_BIN: path.join(dir, 'no-such-vlc.exe'),
      NOTESD_VLC_HEALTH_MS: '5000',
      NOTESD_TASKLIST_EXE: await wrap('tasklist'),
      NOTESD_POWERSHELL_EXE: await wrap('powershell'),
      FAKE_WIN_STATE: state,
    };
    const log = healthLogPath(path.join(dataDir, 'movies'), os.hostname());

    const first = await startChild(env);
    children.push(first.proc);
    await vi.waitFor(async () => expect((await records(log)).filter((r) => r.kind === 'sample').length).toBeGreaterThanOrEqual(2), {
      timeout: 25_000,
      interval: 250,
    });
    first.proc.kill('SIGKILL');
    await first.exited;
    const before = await records(log);
    expect(before.map((r) => r.kind)).not.toContain('clean_stop');
    expect(before.at(-1)?.kind).toBe('sample');
    const lastSample = before.filter((r): r is SampleRecord => r.kind === 'sample').at(-1)!;

    const second = await startChild(env);
    children.push(second.proc);
    await vi.waitFor(async () => expect((await records(log)).some((r) => r.kind === 'incident')).toBe(true), { timeout: 20_000, interval: 250 });
    const incidents = (await records(log)).filter((r): r is IncidentRecord => r.kind === 'incident');
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.last_sample_at).toBe(lastSample.ts);
    expect(inc.samples.length).toBeGreaterThanOrEqual(2);
    expect(inc.samples.at(-1)).toMatchObject({ pid: 4242, ws_bytes: 524_288_000, private_bytes: 734_003_200, handles: 1500, ours: false, play: null });
    expect(inc.events.map((e) => [e.event_id, e.application, e.module, e.exception_code])).toEqual([
      [1000, 'vlc.exe', 'libdirect3d11_filters_plugin.dll', '0xc0000005'],
      [1002, 'vlc.exe', null, null],
    ]);
    expect(inc.events_error).toBeNull();

    const res = await fetch(`http://127.0.0.1:${second.port}/api/movies/player/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body).toMatchObject({ sampling: true, interval_ms: 5000, process_detail: true });
    expect(body.samples.length).toBeGreaterThanOrEqual(2);
    expect(body.incidents).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ pid: 4242, ours: false });
    expect(body.last_start?.previous).toBe('unclean_sampling');

    second.proc.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    expect((await records(log)).at(-1)?.kind).toBe('clean_stop');
  }, 120_000);
});
```
**Impact:** both files need Docker (`npm run test:int`). The crash test needs WSL interop registered
(this machine) and adds about 25 s.

## Principles applied

- Laziness protocol: the log is one JSONL file, with no table and no migration. The Windows binaries are found through `src/http/reveal.ts`'s `DetectProbe` / `findOnPath` / `WSL_INTEROP_FILES` and read through Phase 5's `execCapture` (`ExecFn`). `NOTESD_TASKLIST_EXE` / `NOTESD_POWERSHELL_EXE` are probe env overrides like `NOTESD_EXPLORER_BIN`, not new `Config` fields. The hang rule is a branch inside Phase 5's `tick`, with no second poller. `MOVIES_SUBDIR` is reused for the log directory.
- Boundary discipline: env is validated once in `config.ts` (`NOTESD_VLC_HEALTH_MS` is 0 or at least 5000, and `NOTESD_VLC_EXTRA_ARGS` may not set `--http-*` / `--extraintf` / `--intf` / `-I`, so an owner's flag cannot break tracking). tasklist CSV, PowerShell JSON, `Get-WinEvent` JSON and the log's own lines are each parsed in one function (`parseTasklistCsv`, `parsePowerShellProcesses`, `parseWinEvents`, `parseHealthLine` with zod), and everything after them trusts the typed values. The route validates `limit` once.
- Make illegal states unrepresentable: `HealthDetection`, `PidCheck`, `ProcessListing` and `EventsResult` are discriminated unions. `HangEvent` carries `outcome` only on `end`. A sample's play fields live in one nullable `play` object, so a foreign VLC cannot carry a play state. Record types are `z.infer` of the schemas that read them back, so the writer and the reader cannot drift.
- Fix root causes / attack the premise: the owner's premise (a VLC leak during a long pause) is not taken as fact. The 13:03 Windows log shows Explorer and WindowsTerminal faulting in a graphics driver module and no vlc.exe event. So the plan records both signals (memory per paused minute, and fault events naming a module), and `NOTESD_VLC_EXTRA_ARGS` lets the owner test `--avcodec-hw=none` without a deploy.
- Prove it works: the crash journey runs two real daemons from the checkout and SIGKILLs the first. The hang journey drives a real child VLC fake over real curl into real `movie_plays` rows. The Windows commands, property indices, units and the local-time filter were measured on this machine before planning, and the unit fixtures hold that measured output.
- Test behavior, not implementation: tests assert log lines, route bodies, play rows and argv, which is what the owner reads. The fakes sit at the process boundary (`ProcessLister`, `EventLogReader`, `fake-windows.mjs`, `fake-vlc.mjs`), never inside the monitor.
- Sequence into verifiable units: Step 1 + Step 9 (config + its tests), Step 2 (incidents + their unit test), Step 3 (monitor + unit test), Steps 4-5 (launch and player + extraArgs and hang unit tests), Steps 6-7 (route and wiring + the integration journeys). Each ends in a test that can fail.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/config.test.ts`, `tests/unit/movies/vlc.extraArgs.test.ts`,
`vlc.health.test.ts`, `vlc.incidents.test.ts`, `player.hang.test.ts`) and `npm run test:int` (includes
`tests/integration/movies.health.int.test.ts` and `movies.healthCrash.int.test.ts`)
**Proof:** the integration journeys run real daemons and a real child-process VLC against the test
Postgres, with Windows faked at the process boundary. The harness journey runs a throwaway daemon
built from this checkout with the fake Windows side behind the two env overrides. One manual journey
is for the owner on the real machine.

- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`) for J7. The `npm run test:int` journeys need Docker only.
- Feature-map entries: none in this phase. `features/movies.md` is Phase 8's (see Handoffs).
- Journeys:
  - **J1** · traces R8.1 — `npx vitest run tests/unit/movies/vlc.health.test.ts -t "R8.1"` → passes when all three tests pass: the notesd-started VLC's sample has `ours: true` and `play.state "paused"`, with `paused_s` 90 then 120. The foreign VLC has `ours: false, play: null`. No line contains the password. A tick with no `vlc.exe` writes nothing, and the tick after the last one exits writes exactly one `idle`. The idle check is that kinds are `['start','sample','idle']`.
  - **J2** · traces R8.2 — `npx vitest run tests/unit/movies/vlc.incidents.test.ts` → passes when the MEASURED 2026-11-14 events parse to `Windows.UI.Xaml.dll 0xc000027b`, `igd10umt64xe.DLL 0xc0000005` and `ucrtbase.dll 0xc0000409`. A monitor started over a log whose last state line is a sample writes exactly one `incident`, with 40 samples, `open_play.paused_s` 900, the open hang, and only the four events inside `05:53:30Z-06:07:00Z`. A clean or idle previous run writes none.
  - **J3** · traces R8.3 — `npx vitest run tests/unit/movies/player.hang.test.ts` → passes when a VLC silent with its process alive yields exactly one hang `start` and its play keeps `endedAt` null at position 1300 after more than `MAX_READ_ERRORS + 3` checks. Answering again ends the hang `answered`, and the next poll records 1400. Silent then gone ends the play `exited` at 1300. A refused connection with the process alive is a hang. With the process unknown, Phase 5's rules hold.
  - **J4** · traces R8.4 — `npx vitest run tests/unit/movies/vlc.extraArgs.test.ts tests/unit/config.test.ts -t "R8.4|rejects|reads every key"` → passes when the argv ends `--start-time=1200, --avcodec-hw=none, --no-video-title-show, <file>`, `NOTESD_VLC_EXTRA_ARGS` splits on whitespace, and `--http-port 9999`, `--extraintf=rc`, `-I dummy` and `NOTESD_VLC_HEALTH_MS=1000` throw `ConfigError`.
  - **J5** · traces R8.1, R8.3, R8.4, R8.5 — `npm run test:int -- tests/integration/movies.health.int.test.ts` → passes when all five tests pass. The fake VLC's logged argv has the two extra args right before `C:\fake\Health.Film.2026.mkv`. After `pl_pause`, a sample of that pid has `ours: true`, `play.state "paused"`, `paused_s >= 1` and a redacted `cmd`. After `/fake/hang?ms=7000` the log gets a hang `start` naming that pid while the `movie_plays` row has `ended_at` null and the pre-hang position, then a hang `end` `answered`. After `/fake/quit` the row gets `ended_at` at that position. `GET /api/movies/player/health` answers 200 with that sample, hangs `[start, end]` and one run with `ours: true`, 400 for `limit=0` and `limit=2001`, and 503 `movies_off` without a monitor.
  - **J6** · traces R8.1, R8.2, R8.5 — `npm run test:int -- tests/integration/movies.healthCrash.int.test.ts` → passes when the first real daemon writes at least 2 `sample` lines for pid 4242 (524288000 / 734003200 / 1500) and, once SIGKILLed, its log ends with a `sample` and holds no `clean_stop`. The second daemon writes exactly one `incident` whose `last_sample_at` is that last sample's `ts` and whose events are exactly `[1000 vlc.exe libdirect3d11_filters_plugin.dll 0xc0000005]` and `[1002 vlc.exe]`; the 3-hour-old event is left out. Its `GET /api/movies/player/health` returns that incident, `last_start.previous: "unclean_sampling"` and a run for pid 4242, and after SIGTERM the log's last line is `clean_stop`. **WSL-only:** on a host without WSL interop the test is skipped, and a verifier off WSL reports this journey `inconclusive`, never `failed` (and never passed). R8.2 keeps an automated journey that runs everywhere: J2 (the incident rules over a fake log and fake event reader).
  - **J7** · traces R8.1, R8.5 — throwaway daemon with the fake Windows side ("Harness setup" below; valid until phase 8 lands, which makes a plain `verify.sh up` a movies-off run and pins the monitor off on `--movies`; the feature map uses J5/J6 instead) → passes when, 12 s after `$V up`, `$V api $RUN GET /api/movies/player/health` answers 200 with `"sampling":true`, `"interval_ms":5000` and at least 2 `samples` of `"pid":4242` with `"ws_bytes":524288000,"private_bytes":734003200,"handles":1500,"ours":false`. `grep -c '"kind":"sample"' "$F"` prints at least 2, and `head -1 "$F"` is a `"kind":"start"` line. Then `$V down $RUN`.
  - **J8** · traces R8.1, R8.3 — **MANUAL, owner only, live daemon and real `vlc.exe`**. A verifier agent marks it `inconclusive` and never runs it. After deploy (`scripts/install.sh`), press Play on a film in the wall, pause it in VLC, wait 10+ minutes, then run `curl -s localhost:7317/api/movies/player/health | jq '{sampling, process_detail, run: .runs[-1], last: .samples[-1]}'` → passes when `sampling` and `process_detail` are true, `last.ours` is true, `last.play.state` is `"paused"` with `paused_s >= 600`, `run.samples >= 20`, and `run.private_growth_per_paused_min` is a number (near 0 means no leak while paused). `tail -n 2 ~/mcp-notes-data/movies/vlc-health-$(hostname).jsonl` shows two sample lines 30 s apart. After any later WSL crash, `curl -s localhost:7317/api/movies/player/health | jq '.incidents[-1] | {last_sample_at, open_play, events}'` shows the paused film and the Windows fault events (application, module, exception code) of those minutes.
- Harness setup (J7):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/movies-library
  V=.claude/skills/verify-notesd/scripts/verify.sh
  S=<your scratchpad>/movies-p9 && mkdir -p "$S/roots"
  for m in tasklist powershell; do
    printf '#!/bin/sh\nexec "%s" "%s" %s "$@"\n' "$(command -v node)" "$PWD/tests/fixtures/movies/fake-windows.mjs" "$m" > "$S/$m.exe"
    chmod +x "$S/$m.exe"
  done
  cat > "$S/win.json" <<'EOF'
  {"vlc":[{"pid":4242,"ws":524288000,"priv":734003200,"handles":1500,"started":"2026-11-14T05:00:00.000Z","cmd":"\"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe\" --started-from-file \"C:\\Users\\x\\Videos\\Film.mkv\""}],"events":[]}
  EOF
  export NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$S/roots" NOTESD_MOVIES_SCAN_MS=86400000 \
         TMDB_API_READ_ACCESS_TOKEN= TMDB_API_KEY= NOTESD_VLC_INI= NOTESD_VLC_BIN="$S/no-such-vlc.exe" \
         NOTESD_VLC_HEALTH_MS=5000 NOTESD_TASKLIST_EXE="$S/tasklist.exe" NOTESD_POWERSHELL_EXE="$S/powershell.exe" \
         FAKE_WIN_STATE="$S/win.json"
  $V up                                   # note RUN=...
  sleep 12
  F=~/.local/state/notesd-verify/$RUN/data/movies/vlc-health-$(hostname | sed 's/[^A-Za-z0-9._-]/_/g').jsonl
  $V api $RUN GET /api/movies/player/health
  grep -c '"kind":"sample"' "$F"; head -1 "$F"
  $V down $RUN
  ```
- Neighbor check: Phase 5 playback. `npx vitest run tests/unit/movies/player.test.ts tests/unit/movies/vlc.launch.test.ts` and `npm run test:int -- tests/integration/movies.play.int.test.ts` pass unchanged. Those tests build the player without a `health` link and the launcher without extras, so exit 7 still ends a play at once and the argv is unchanged. `GET /api/movies/player` still answers `{ available, reason, current }` with no new keys.
- Cost: none. No LLM turns and no network. The fake Windows side stands in for `tasklist.exe` / `powershell.exe` in every automated journey.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass, and J1-J7 pass (J6 may be
`inconclusive` only off WSL). J8 is listed for the owner. On a throwaway daemon a running (fake)
`vlc.exe` gets a fsync'd sample line every interval. A SIGKILLed daemon that was sampling leads to
exactly one incident with the in-window Windows events on the next start. A silent VLC whose
process lives keeps its play open and logs a hang. The extra args reach the launch line. The health
route returns all of it.

## Handoffs

- **Phase 8 (docs, verify):** document `GET /api/movies/player/health` in the README HTTP API table
  (wire format in this plan's Interface Contract), the health log (path, line kinds, 5 MiB + one
  previous file, fsync) in the README tour and the CLAUDE.md movies paragraph, and the four env rows
  this phase adds. Write the `features/movies.md` health journeys from J5-J7 and the "Harness
  setup" above. Phase 8's `verify.sh up --movies` must pin `NOTESD_VLC_HEALTH_MS=0` or point
  `NOTESD_TASKLIST_EXE` / `NOTESD_POWERSHELL_EXE` at `tests/fixtures/movies/fake-windows.mjs`
  wrappers. Otherwise a throwaway daemon on WSL samples the owner's real `vlc.exe` every 30 s. That
  is read only but nondeterministic, and it writes the owner's real Windows process list into
  verify evidence. A feature-map entry for this phase cannot exist before Phase 8 creates
  `features/movies.md`, which is why it is a handoff and not a step here.
- **Phase 6 (web, parallel):** nothing required. If the owner later wants a health view on the
  Movies page, it reads `GET /api/movies/player/health`. `GET /api/movies/player` and
  `PlayerSnapshot` are unchanged.
- **Phase 7 (MCP, parallel):** nothing required. A `movies_health` tool for `/n` ("did VLC leak
  last night?") would call `deps.moviesHealth.report(limit)`. That needs `ToolDeps` to carry
  `moviesHealth`, and it is out of this plan set's scope.
- **Phase 5 (reconciled 2026-11-14, round 2):** every quoted anchor was checked against the final
  `phase-5.md` (the `systemd-run --user --scope` launcher, `onChange(file)`, `endPlay(..., new Date())`,
  the daemon's two `moviesPlayer` lines, `moviesPlayRoutes`'s `Pick` signature); extra args land in the
  same argv inside the scope, before the file. This phase edits Phase 5's `vlcArgs`, `spawnVlcLauncher`, `player.ts`
  (`Tracked`, `tick`, `finish`, `PlaybackOverrides`, `buildMoviePlayback`), `moviesPlayRoutes`'s
  signature, `src/deps.ts` and the daemon block, all by additive edits quoted against
  `phase-5.md` as reconciled on 2026-11-14 (`spawnVlcLauncher({ scope })`,
  `onChange: (file) => service.events.changed('play', ...)`, `endPlay(..., new Date())`). If
  Phase 5's final text differs, map these edits onto it. The rule stays: without a `health` link
  the player behaves exactly as Phase 5 specifies.
- **Phase 1 (reconciled):** the config half stays in this phase (Steps 1 and 9). No phase of wave
  {6, 7, 9} edits `src/config.ts` or `tests/unit/config.test.ts`, and phase 1's plan, README block
  and config tests do not name the two fields; this phase adds them after phase 1 has landed.
- **Owner, after deploy (no code):** to test the driver hypothesis without a code change, add
  `NOTESD_VLC_EXTRA_ARGS=--avcodec-hw=none` (or `--vout=direct3d9`) to `/home/miftah/mcp-notes/.env.local`,
  restart notesd, and compare `private_growth_per_paused_min` and incidents across a few evenings.

## Rollback

Revert this phase's commit. It adds `src/movies/vlc/health.ts`, `incidents.ts`, the fake Windows
fixture and five test files. It removes the hang branch and `healthView()` from `player.ts`, after
which Phase 5's exact poll rules return. It also removes the extra-args parameter from `vlcArgs` /
`spawnVlcLauncher`, the health route, `AppDeps.moviesHealth`, the daemon wiring, the two config
fields and their test lines, the four README rows and `/fake/hang` in `fake-vlc.mjs`. There is no
migration and no data change. Leftover `<dataDir>/movies/vlc-health-*.jsonl` files are inert and
can be deleted. To stop the monitor without a revert, set `NOTESD_VLC_HEALTH_MS=0`. That also turns
the hang rule back into Phase 5's.

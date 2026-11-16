> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-cache-and-bug-report/PLAN.md` phase 4. Source: `.workflows/plan/stream-cache-and-bug-report/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Report button and its tmux session

**Plan set:** `STREAM_CACHE_AND_BUG_REPORT_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Satisfies:** R4 — a "report" button in the player's error state that snapshots the evidence and starts `/report-stream-bug` in a new tmux Claude Code window, once per failed session
**Criteria:** R4.1, R4.2, R4.3, R4.4
**Depends on:** Phase 1, Phase 2
**Difficulty:** NORMAL
**Package:** `src/directStream`, `src/http`, `web/src/stream`

---

## Goal

When the player page stops with an error, an icon-only bug button sits under the message. A click
makes the daemon take phase 1's evidence snapshot of that stream session at once, write a
`report.json` marker (with the page's own error and log lines) into the snapshot folder, and open a
new window in the owner's tmux running Claude Code in the mcp-notes checkout on
`/report-stream-bug <snapshot folder>`. A session is reported once (remembered in memory and by the
marker across restarts); without tmux or a runnable claude binary the snapshot is kept and the page
says the report was saved but not opened.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/report.ts`: `StreamReporter` (class), `StreamReporterOptions`, `EvidenceSnapshotter`, `EvidenceSnapshot`, `PageReport`, `ReportMarker`, `MarkerResult`, `ReportOutcome`, `REPORT_MARKER` (`'report.json'`), `REPORT_SKILL` (`'/report-stream-bug'`), `REPORT_PERMISSION_MODE` (`'auto'`), `streamReportsDir(dataDir)`, `reportWindowName(sessionId)`, `readMarkers(reportsDir)`, `parseMarker(json)`.
- `src/http/streamReportApi.ts`: `streamReportRoutes(deps)`, `reportBody` (zod), `scrubLine(line)`, `REPORT_OFF`.
- Route `POST /api/stream/sessions/:id/report` (same-origin only): 200 `{ok: true, dir, window, complete}` | 409 `already_reported {dir}` | 409 `no_tmux {dir, complete}` | 500 `spawn_failed {dir, message, complete}` | 500 `snapshot_failed {message}` | 403 `unknown_session` | 503 `direct_stream_off` / `report_off` | 400 `invalid_json` / `invalid_body`.
- `src/sessions/resume.ts`: exported types `TmuxDeps`, `ClaudeWindowDeps`, `DefaultClaudeWindowDepsInput`; exported function `defaultClaudeWindowDeps(input)`; `openClaudeWindow` becomes exported.
- `AppDeps.streamReporter?: StreamReporter | null` (`src/deps.ts`).
- File `report.json` inside a phase 1 snapshot folder (one per reported session). Phase 4 never writes or edits `session.json`, `evidence.jsonl` or `player.json`.
- Web: `reportStreamBug`, `reportUrl`, `PageReport`, `ReportAnswer` in `web/src/stream/session.ts`; `BugReportState`, `StreamState.bugReport`, `StreamController.reportBug()` in `web/src/stream/controller.ts`; `reportLabel`, `reportText` in `web/src/stream/StreamApp.tsx`.
- Verify harness: `.claude/skills/verify-notesd/scripts/stream/fake-tmux.sh`, `.claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs`; every `verify.sh up` pins `NOTESD_TMUX_BIN` to the fake and prints `TMUX_FAKE=<run>/tmux`.

**Signature changes (type narrowing only, no behaviour change):**
- `function tmux(deps: ResumeDeps, …)` -> `function tmux(deps: TmuxDeps, …)`
- `pickTmuxSession(deps: ResumeDeps)` -> `pickTmuxSession(deps: TmuxDeps)`
- `tmuxGlobalPath(deps: ResumeDeps)` -> `tmuxGlobalPath(deps: TmuxDeps)`
- `pickClient(deps: ResumeDeps)` -> `pickClient(deps: TmuxDeps)`
- `switchMostRecentClient(deps: ResumeDeps, …)` -> `switchMostRecentClient(deps: TmuxDeps, …)`
- `async function openClaudeWindow(deps: ResumeDeps, …)` -> `export async function openClaudeWindow(deps: ClaudeWindowDeps, …)`
- `defaultResumeDeps(input)` keeps its signature; its tmux/claude fields now come from `defaultClaudeWindowDeps`.

**Requires (from earlier phases):**
- Phase 1 (confirmed against phase 1's plan): `AppDeps.streamEvidence?: StreamEvidence | null` (`src/directStream/evidence.ts`), whose `snapshot(sessionId: string | null): Promise<SnapshotResult>` answers `{ dir, session_id, complete, records, player_lines }` (a superset of `EvidenceSnapshot`), writes the folder under `StreamEvidence.reportsDir` (`<dataDir>/movies/` + `STREAM_REPORTS_SUBDIR`), and answers `complete: false` (it throws only when the folder cannot be written) for a session id the daemon no longer holds. `DirectStreamService.evidenceSource(id)` (null once the session ended, does not mark it used). Phase 1 builds `streamEvidence` in `src/daemon.ts` before `buildDirectStreamService` and puts it in the `deps` literal, so it is set before the line this phase adds.
- Phase 2: the controller's stages are `loading | ready | refreshing | recovering | error`; `StageOverlay` still has its `if (state.stage === 'error') { … }` branch with the `WarningCircle` and the message `<span>`.

**Leaves alone (owned by others):** `src/directStream/evidence.ts` and the snapshot's three files (Phase 1); `claude/skills/report-stream-bug/` (Phase 3); the engines and the `recovering` stage/overlay branch (Phase 2); `src/directStream/cache/*`, `stream_caches`, `/api/stream/cache` (Phase 5); `SessionInfo.cached`, the "from cache" mark (Phase 6); `src/directStream/service.ts`, `src/http/directStreamApi.ts` (no edit at all).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/resume.ts:116-171`, `:340-410`, `:517-538`, `:700-740` | modify | `TmuxDeps` / `ClaudeWindowDeps` types; the tmux helpers take the narrow types; `openClaudeWindow` exported; `defaultClaudeWindowDeps` extracted from `defaultResumeDeps` |
| `src/directStream/report.ts` | create | `StreamReporter`: snapshot, marker, one window per session |
| `src/http/streamReportApi.ts` | create | `POST /api/stream/sessions/:id/report` |
| `src/deps.ts:12-14`, `:73` | modify | `streamReporter?: StreamReporter \| null` |
| `src/daemon.ts:12`, `:225` | modify | build `deps.streamReporter` after `deps.streamProber` |
| `src/http/app.ts:28`, `:139` | modify | mount `streamReportRoutes(deps)` |
| `web/src/stream/session.ts:135`, end of file | modify | `reportUrl`, `PageReport`, `ReportAnswer`, `reportStreamBug` |
| `web/src/stream/controller.ts:1-12`, `:44-69`, `:217`, after `goToEpisode` | modify | `BugReportState`, `StreamState.bugReport`, `reportBug()`, reset on an episode switch |
| `web/src/stream/StreamApp.tsx:2-18`, `:222-240`, `:302-307`, `:356` | modify | `ReportButton` in the error branch of `StageOverlay`, `reportLabel`, `reportText` |
| `web/src/stream/stream.css:170` | modify | `.st-report` styles |
| `tests/unit/directStream/report.test.ts` | create | reporter behaviour with a fake tmux and a fake snapshot |
| `tests/unit/directStream/reportRoute.test.ts` | create | route: origin, off answers, body, scrubbing, pass-through of outcomes |
| `web/src/stream/controller.test.tsx` | modify | `reportBug()` tests |
| `web/src/stream/StreamApp.test.tsx` | modify | the button in the error stage, its texts |
| `scripts/docs/httpRoutes.ts:233` | modify | describe the route |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` (never hand-edited) |
| `docs/guide/streaming.md:420-422`, `:482`, `:798` | modify | the report bullet, its answers, the code map row |
| `.claude/skills/verify-notesd/scripts/stream/fake-tmux.sh` | create | recording fake tmux (executable) |
| `.claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs` | create | Playwright journey J1–J3 |
| `.claude/skills/verify-notesd/scripts/verify.sh:199-206`, `:316` | modify | pin `NOTESD_TMUX_BIN` + `NOTESD_FAKE_TMUX_DIR`; print `TMUX_FAKE=` |
| `.claude/skills/verify-notesd/SKILL.md:142` | modify | one Gotchas bullet: every run's tmux is the fake |
| `.claude/skills/verify-notesd/features/direct-streaming.md` (end) | modify | new section "Reporting a stream bug from the player" |

No new environment variable in `src/`, `claude/` or `scripts/` (the env scan of `scripts/docs/reference.ts` walks those three): `NOTESD_FAKE_TMUX_DIR` is read only by the fake under `.claude/skills/verify-notesd/`. No picture: no `scripts/docs/shots/*.mjs` takes the player page, and `docs/guide/streaming.md` shows none.

## Implementation Steps

Run `npm ci` first if `node_modules` is missing in the worktree (it is, in a fresh worktree).

**Shared files (reconciled).** Phases 1 and 2 have landed before this phase: every quoted line of
`src/deps.ts`, `src/daemon.ts`, `src/http/app.ts`, `web/src/stream/session.ts`, `controller.ts` and
`StreamApp.tsx` is matched by its text as phases 1 and 2 left it (the anchors below name phase 1's
lines where it inserted next to them). Phase 5 may land before or after this phase (both follow phase
1 only), and edits the same shared files: `src/deps.ts`, `src/daemon.ts`, `src/http/app.ts`,
`scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md`, `.claude/skills/verify-notesd/SKILL.md`,
`.claude/skills/verify-notesd/features/direct-streaming.md` and
`.claude/skills/verify-notesd/scripts/verify.sh` (phase 5 adds `NOTESD_STREAM_CACHE_DIR` to the same
`env=(...)` array after `NOTESD_SWARM_SCRIPT`). Both phases' edits there are additive, each anchored
by text, and keep each other's lines: whichever lands second inserts beside the other's. The
generated `docs/guide/reference/http-api.md` is never merged by hand: after a merge, run
`npm run docs:gen`.

### Step 1: Narrow the tmux helpers and export the window opener
**File:** `src/sessions/resume.ts:116` (after `export type CommandRunner …`, and the `ResumeDeps` interface that follows it), `:169`, `:340`, `:364`, `:373`, `:402`, `:521`, `:700-740`
**Change:** Add two type aliases right after the `ResumeDeps` interface (after line 142). Change the parameter type of six functions. Export `openClaudeWindow`. Extract `defaultClaudeWindowDeps` and make `defaultResumeDeps` use it. No statement inside any function body changes, so every resume test keeps passing.

**Code (insert after the closing `}` of `interface ResumeDeps`, line 142):**
```ts
/** The part of ResumeDeps that reaches tmux. */
export type TmuxDeps = Pick<ResumeDeps, 'run' | 'tmuxBin' | 'tmuxSocket'>;

/**
 * What opening a Claude Code window needs: tmux and the claude binary. The player's report button
 * (src/directStream/report.ts) opens its window with this alone.
 */
export type ClaudeWindowDeps = TmuxDeps & Pick<ResumeDeps, 'claudeBin'>;
```

**Code (line 169, replaces `function tmux(deps: ResumeDeps, …)`):**
```ts
function tmux(deps: TmuxDeps, args: readonly string[]): Promise<string> {
  return deps.run(deps.tmuxBin, tmuxArgs(deps, args));
}
```

**Code (line 339-346, replaces `pickTmuxSession`):**
```ts
/** The most recently attached tmux session's name, or null when no server is running. */
export async function pickTmuxSession(deps: TmuxDeps): Promise<string | null> {
  try {
    return parseLatest(await tmux(deps, ['list-sessions', '-F', '#{session_last_attached} #{session_name}']));
  } catch {
    return null;
  }
}
```

**Code (line 359-370, replaces `tmuxGlobalPath`):**
```ts
/**
 * The tmux server's global PATH, or null. new-window hands the window the environment of the
 * tmux client that asked for it, which here is the daemon's (a systemd unit with a bare PATH),
 * so a resumed claude could not find tools like $EDITOR that the user's shell puts on PATH.
 */
export async function tmuxGlobalPath(deps: TmuxDeps): Promise<string | null> {
  try {
    return parseTmuxPath(await tmux(deps, ['show-environment', '-g', 'PATH']));
  } catch {
    return null;
  }
}
```

**Code (line 372-379, replaces `pickClient`):**
```ts
/** The most recently active client (its tty name), or null. */
export async function pickClient(deps: TmuxDeps): Promise<string | null> {
  try {
    return parseLatest(await tmux(deps, ['list-clients', '-F', '#{client_activity} #{client_name}']));
  } catch {
    return null;
  }
}
```

**Code (line 401-410, replaces `switchMostRecentClient`):**
```ts
/** Best effort: show `target` on the most recently active client. */
async function switchMostRecentClient(deps: TmuxDeps, target: string): Promise<void> {
  const client = await pickClient(deps);
  if (client === null) return;
  try {
    await tmux(deps, ['switch-client', '-c', client, '-t', target]);
  } catch {
    // the window is open either way; failing to switch a client is not a failed resume
  }
}
```

**Code (line 517-538, replaces `openClaudeWindow`):**
```ts
/**
 * A new window in tmux session `session` at `cwd`, named `name`, running claude with `claudeArgs`,
 * tmux's global PATH and `extraEnv`; shown on the most recently active client. Shared by resume and
 * the player's report button (src/directStream/report.ts).
 */
export async function openClaudeWindow(
  deps: ClaudeWindowDeps,
  session: string,
  cwd: string,
  name: string,
  claudeArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ window: string; paneId: string | null }> {
  const globalPath = await tmuxGlobalPath(deps);
  const argv = claudeCommand(deps.claudeBin, claudeArgs, {
    ...(globalPath !== null ? { PATH: globalPath } : {}),
    ...extraEnv,
  });
  const out = await tmux(deps, ['new-window', '-t', `=${session}:`, '-c', cwd, '-n', name, '-P', '-F', NEW_WINDOW_FORMAT, ...argv]);
  const created = parseNewWindow(out);
  if (created.paneId !== null) await switchMostRecentClient(deps, created.paneId);
  return created;
}
```

**Code (line 700-740: replace the `DefaultResumeDepsInput` interface through the end of `defaultResumeDeps`; `isDirectory` stays between them as it is):**
```ts
export interface DefaultClaudeWindowDepsInput {
  /** config.chat.claudeBin (NOTESD_CLAUDE_BIN); resolved against PATH to an absolute path. */
  claudeBin: string;
  /** Defaults to process.env (NOTESD_TMUX_SOCKET, NOTESD_TMUX_BIN, PATH). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** This machine's tmux (NOTESD_TMUX_BIN, NOTESD_TMUX_SOCKET) and claude binary: what opening a Claude Code window needs. */
export function defaultClaudeWindowDeps(input: DefaultClaudeWindowDepsInput): ClaudeWindowDeps {
  const env = input.env ?? process.env;
  const socket = env[TMUX_SOCKET_ENV]?.trim();
  return {
    run: (cmd, args) => runCommand(cmd, args),
    tmuxBin: env[TMUX_BIN_ENV]?.trim() || 'tmux',
    tmuxSocket: socket !== undefined && socket !== '' ? socket : null,
    claudeBin: resolveExecutable(input.claudeBin, env.PATH),
  };
}

export interface DefaultResumeDepsInput {
  /** config.chat.claudeBin (NOTESD_CLAUDE_BIN); resolved against PATH to an absolute path. */
  claudeBin: string;
  worktreesDir: string;
  /** config.dataDir (NOTES_DATA_DIR): handoffs go under `<dataDir>/handoffs/`. */
  dataDir: string;
  live: ResumeDeps['live'];
  repoCwds: ResumeDeps['repoCwds'];
  loadHandoff: ResumeDeps['loadHandoff'];
  /** Defaults to process.env (NOTESD_TMUX_SOCKET, NOTESD_TMUX_BIN, PATH). */
  env?: Readonly<Record<string, string | undefined>>;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The real ResumeDeps for the daemon. */
export function defaultResumeDeps(input: DefaultResumeDepsInput): ResumeDeps {
  return {
    host: os.hostname(),
    ...defaultClaudeWindowDeps({ claudeBin: input.claudeBin, env: input.env }),
    homeDir: os.homedir(),
    worktreesDir: input.worktreesDir,
    dataDir: input.dataDir,
    live: input.live,
    isDir: isDirectory,
    repoCwds: input.repoCwds,
    loadHandoff: input.loadHandoff,
    now: () => Date.now(),
  };
}
```
**Impact:** None at runtime: `ResumeDeps` satisfies both narrow types structurally, every existing caller compiles unchanged. Check: `npx vitest run tests/unit/sessions` and `npm run typecheck` pass before going on.

### Step 2: The reporter
**File:** `src/directStream/report.ts` (new)
**Change:** The whole decision for one click. Order: malformed id → 403; a marker for the session → 409 `already_reported` (or, when its window never opened, open it now on the same folder); an ended session with no page log → 403; snapshot (phase 1) → marker written (`pending`) → tmux session picked (`no_tmux`) → claude runnable (`spawn_failed`) → window opened → marker rewritten with the result. Concurrent clicks share one in-flight promise.
**Code:**
```ts
import { constants } from 'node:fs';
import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openClaudeWindow, pickTmuxSession, promptArgs, type ClaudeWindowDeps } from '../sessions/resume.js';
import { STREAM_REPORTS_SUBDIR } from './evidence.js';
import { SESSION_ID_PATTERN } from './sessions.js';

/*
 * The player's report button (STREAM_CACHE_AND_BUG_REPORT phase 4). A click takes phase 1's
 * evidence snapshot at once (sessions live in memory and tokens expire), then opens a new tmux
 * window running Claude Code in the mcp-notes checkout on `/report-stream-bug <snapshot folder>`
 * (phase 3's skill). One report per stream session: remembered in memory and by REPORT_MARKER in
 * the snapshot folder, so a restarted daemon does not make a second. The daemon writes no note;
 * the spawned session does, through the notes MCP server.
 */

/** Written by this module only, into a phase 1 snapshot folder, beside its own files. */
export const REPORT_MARKER = 'report.json';
/** Phase 3's skill. The prompt is exactly `${REPORT_SKILL} <absolute snapshot folder>`. */
export const REPORT_SKILL = '/report-stream-bug';
/**
 * The spawned session runs unattended (a collect script, a network measurement, a notes MCP
 * write): left on the default mode it would stop at its first Bash call and wait for the owner.
 * `auto` rather than `bypassPermissions`: the evidence holds text from third-party stream hosts
 * (error messages, host names, paths), so the permission classifier stays between that text and
 * the shell. Resume passes no mode because a resumed session is the owner's to drive.
 */
export const REPORT_PERMISSION_MODE = 'auto';

/**
 * `<dataDir>/movies/stream-reports/`: where phase 1 writes snapshot folders (phase 1's
 * STREAM_REPORTS_SUBDIR; the daemon passes StreamEvidence.reportsDir itself, this is for tests).
 */
export function streamReportsDir(dataDir: string): string {
  return path.join(dataDir, 'movies', STREAM_REPORTS_SUBDIR);
}

/** tmux window name of a report: `stream-bug-<first 6 characters of the session id>`. */
export function reportWindowName(sessionId: string): string {
  return `stream-bug-${sessionId.slice(0, 6)}`.replace(/[\s:.]+/g, '-');
}

/** What phase 1's snapshot answers. */
export interface EvidenceSnapshot {
  dir: string;
  session_id: string | null;
  /** False when the daemon no longer knew the session (its source is missing from the folder). */
  complete: boolean;
}

/** Phase 1's StreamEvidence, as far as the reporter uses it. */
export interface EvidenceSnapshotter {
  snapshot(sessionId: string | null): Promise<EvidenceSnapshot> | EvidenceSnapshot;
}

/** The page's own view of the failure, sent with the click (validated and scrubbed by the route). */
export interface PageReport {
  stage: string;
  error: string | null;
  errors: string[];
  log: string[];
  title: string | null;
  position_s: number | null;
}

/** How the window part ended. `pending`: the marker was written and the daemon stopped before the answer. */
export type MarkerResult =
  | { outcome: 'pending' }
  | { outcome: 'opened'; window: string }
  | { outcome: 'no_tmux' }
  | { outcome: 'spawn_failed'; message: string };

/** `report.json`. */
export interface ReportMarker {
  session_id: string;
  dir: string;
  reported_at: string;
  complete: boolean;
  prompt: string;
  page: PageReport | null;
  result: MarkerResult;
}

export type ReportOutcome =
  | { status: 200; body: { ok: true; dir: string; window: string; complete: boolean } }
  | { status: 409; body: { error: 'already_reported'; dir: string } }
  | { status: 409; body: { error: 'no_tmux'; dir: string; complete: boolean } }
  | { status: 500; body: { error: 'spawn_failed'; dir: string; message: string; complete: boolean } }
  | { status: 500; body: { error: 'snapshot_failed'; message: string } }
  | { status: 403; body: { error: 'unknown_session'; message: string } };

export interface StreamReporterOptions {
  evidence: EvidenceSnapshotter;
  /** True while the daemon knows the session (DirectStreamService.evidenceSource(id) !== null: does not mark it used). */
  isLive(sessionId: string): boolean;
  /** Phase 1's StreamEvidence.reportsDir (`<dataDir>/movies/stream-reports`): scanned once for markers left by an earlier run. */
  reportsDir: string;
  /** Where claude runs: the mcp-notes checkout (REPO_ROOT). */
  cwd: string;
  /** tmux and claude; a factory is called once, on the first window. */
  window: ClaudeWindowDeps | (() => ClaudeWindowDeps);
  /** True when the claude binary can be executed. Default: fs.access with X_OK. */
  canRun?: (bin: string) => Promise<boolean>;
  now?: () => Date;
}

const UNKNOWN: ReportOutcome = {
  status: 403,
  body: { error: 'unknown_session', message: 'That stream session is unknown or has ended, and the page sent no log to report.' },
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function executable(bin: string): Promise<boolean> {
  try {
    await access(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function parsePage(v: unknown): PageReport | null {
  if (!isRecord(v) || typeof v.stage !== 'string') return null;
  return {
    stage: v.stage,
    error: typeof v.error === 'string' ? v.error : null,
    errors: strings(v.errors),
    log: strings(v.log),
    title: typeof v.title === 'string' ? v.title : null,
    position_s: typeof v.position_s === 'number' && Number.isFinite(v.position_s) ? v.position_s : null,
  };
}

function parseResult(v: unknown): MarkerResult | null {
  if (!isRecord(v)) return null;
  switch (v.outcome) {
    case 'pending':
    case 'no_tmux':
      return { outcome: v.outcome };
    case 'opened':
      return { outcome: 'opened', window: typeof v.window === 'string' ? v.window : '' };
    case 'spawn_failed':
      return { outcome: 'spawn_failed', message: typeof v.message === 'string' ? v.message : '' };
    default:
      return null;
  }
}

/** A `report.json` read back from disk, or null when it is not one. */
export function parseMarker(json: unknown): ReportMarker | null {
  if (!isRecord(json)) return null;
  const result = parseResult(json.result);
  if (typeof json.session_id !== 'string' || typeof json.dir !== 'string' || result === null) return null;
  return {
    session_id: json.session_id,
    dir: json.dir,
    reported_at: typeof json.reported_at === 'string' ? json.reported_at : '',
    complete: json.complete === true,
    prompt: typeof json.prompt === 'string' ? json.prompt : `${REPORT_SKILL} ${json.dir}`,
    page: parsePage(json.page),
    result,
  };
}

/** Every marker under `reportsDir`, by session id. A missing folder or a broken marker is skipped. */
export async function readMarkers(reportsDir: string): Promise<Map<string, ReportMarker>> {
  const out = new Map<string, ReportMarker>();
  let entries: string[];
  try {
    entries = (await readdir(reportsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    let marker: ReportMarker | null;
    try {
      marker = parseMarker(JSON.parse(await readFile(path.join(reportsDir, name, REPORT_MARKER), 'utf8')) as unknown);
    } catch {
      continue;
    }
    if (marker === null) continue;
    const known = out.get(marker.session_id);
    // An opened report wins over one that was only saved.
    if (known === undefined || (known.result.outcome !== 'opened' && marker.result.outcome === 'opened')) out.set(marker.session_id, marker);
  }
  return out;
}

async function writeMarker(marker: ReportMarker): Promise<void> {
  const file = path.join(marker.dir, REPORT_MARKER);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export class StreamReporter {
  private readonly opts: StreamReporterOptions;
  private markers: Promise<Map<string, ReportMarker>> | null = null;
  private readonly inflight = new Map<string, Promise<ReportOutcome>>();
  private windowDeps: ClaudeWindowDeps | null = null;

  constructor(opts: StreamReporterOptions) {
    this.opts = opts;
  }

  /**
   * One click of the report button for `sessionId`, with the page's own log (null when the caller
   * sent none). A click while another for the same session is running waits for it and answers
   * `already_reported` with its folder (or its failure when it made no folder).
   */
  async report(sessionId: string, page: PageReport | null): Promise<ReportOutcome> {
    if (!SESSION_ID_PATTERN.test(sessionId)) return UNKNOWN;
    const running = this.inflight.get(sessionId);
    if (running !== undefined) {
      const first = await running;
      return 'dir' in first.body ? { status: 409, body: { error: 'already_reported', dir: first.body.dir } } : first;
    }
    const work = this.run(sessionId, page);
    this.inflight.set(sessionId, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  private loadMarkers(): Promise<Map<string, ReportMarker>> {
    this.markers ??= readMarkers(this.opts.reportsDir);
    return this.markers;
  }

  private deps(): ClaudeWindowDeps {
    this.windowDeps ??= typeof this.opts.window === 'function' ? this.opts.window() : this.opts.window;
    return this.windowDeps;
  }

  private async run(sessionId: string, page: PageReport | null): Promise<ReportOutcome> {
    const markers = await this.loadMarkers();
    const known = markers.get(sessionId);
    if (known !== undefined) {
      if (known.result.outcome === 'opened' || known.result.outcome === 'pending') {
        return { status: 409, body: { error: 'already_reported', dir: known.dir } };
      }
      // Saved but never opened (no tmux, or claude could not start): open it now, on the same folder.
      return this.open(known, markers);
    }
    // An ended session is still reported from the page's own log; with nothing from the page there is nothing to report.
    if (!this.opts.isLive(sessionId) && page === null) return UNKNOWN;
    let snap: EvidenceSnapshot;
    try {
      snap = await this.opts.evidence.snapshot(sessionId);
    } catch (err) {
      return { status: 500, body: { error: 'snapshot_failed', message: messageOf(err) } };
    }
    const marker: ReportMarker = {
      session_id: sessionId,
      dir: snap.dir,
      reported_at: (this.opts.now?.() ?? new Date()).toISOString(),
      complete: snap.complete,
      prompt: `${REPORT_SKILL} ${snap.dir}`,
      page,
      result: { outcome: 'pending' },
    };
    try {
      await writeMarker(marker);
    } catch (err) {
      return { status: 500, body: { error: 'snapshot_failed', message: `the report marker could not be written: ${messageOf(err)}` } };
    }
    markers.set(sessionId, marker);
    return this.open(marker, markers);
  }

  private async open(marker: ReportMarker, markers: Map<string, ReportMarker>): Promise<ReportOutcome> {
    const { dir, complete } = marker;
    const settle = async (result: MarkerResult, outcome: ReportOutcome): Promise<ReportOutcome> => {
      const next: ReportMarker = { ...marker, result };
      markers.set(marker.session_id, next);
      try {
        await writeMarker(next);
      } catch (err) {
        // Remembered in memory either way; only a restart could forget it.
        console.error(`[notesd] stream report: could not update ${path.join(dir, REPORT_MARKER)}: ${messageOf(err)}`);
      }
      return outcome;
    };
    const deps = this.deps();
    const session = await pickTmuxSession(deps);
    if (session === null) return settle({ outcome: 'no_tmux' }, { status: 409, body: { error: 'no_tmux', dir, complete } });
    if (!(await (this.opts.canRun ?? executable)(deps.claudeBin))) {
      const message = `the claude binary "${deps.claudeBin}" cannot be run (NOTESD_CLAUDE_BIN)`;
      return settle({ outcome: 'spawn_failed', message }, { status: 500, body: { error: 'spawn_failed', dir, message, complete } });
    }
    try {
      const created = await openClaudeWindow(deps, session, this.opts.cwd, reportWindowName(marker.session_id), [
        '--permission-mode',
        REPORT_PERMISSION_MODE,
        ...promptArgs(marker.prompt),
      ]);
      return settle({ outcome: 'opened', window: created.window }, { status: 200, body: { ok: true, dir, window: created.window, complete } });
    } catch (err) {
      const message = messageOf(err);
      return settle({ outcome: 'spawn_failed', message }, { status: 500, body: { error: 'spawn_failed', dir, message, complete } });
    }
  }
}
```
**Impact:** New module, no caller yet; the tree still builds. Check: Step 7's `tests/unit/directStream/report.test.ts` can be written and run right after this step.

### Step 3: The route
**File:** `src/http/streamReportApi.ts` (new)
**Change:** Validate the body once (boundary), dropping every address query from the page's lines (invariant 3), and pass the reporter's outcome through.
**Code:**
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { PageReport } from '../directStream/report.js';
import { describeIssues } from './api.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * POST /api/stream/sessions/:id/report (STREAM_CACHE_AND_BUG_REPORT phase 4): the player page's
 * report button. Same-origin only: it opens a window in the owner's tmux.
 */

const LINE_MAX = 500;
const LINES_MAX = 50;

export const REPORT_OFF = {
  error: 'report_off',
  message: 'Stream reports are off in this daemon (no evidence log).',
} as const;

/**
 * A page line with the query and fragment of every address dropped: stream addresses carry signed
 * tokens, and a report folder holds host and path only. Capped at 500 characters.
 */
export function scrubLine(line: string): string {
  return line.replace(/((?:https?:\/\/|\/api\/stream\/)[^\s?#]*)[?#]\S*/g, '$1').slice(0, LINE_MAX);
}

const pageLines = z
  .array(z.string().max(4_000))
  .max(500)
  .transform((lines) => lines.slice(-LINES_MAX).map(scrubLine));

export const reportBody = z.object({
  page: z
    .object({
      stage: z.string().max(40),
      error: z
        .string()
        .max(4_000)
        .nullable()
        .transform((v) => (v === null ? null : scrubLine(v))),
      errors: pageLines,
      log: pageLines,
      title: z
        .string()
        .max(300)
        .nullish()
        .transform((v) => v ?? null),
      position_s: z
        .number()
        .min(0)
        .max(172_800)
        .nullish()
        .transform((v) => v ?? null),
    })
    .nullish(),
});

export function streamReportRoutes(deps: Pick<AppDeps, 'directStream' | 'streamReporter'>): Hono {
  const r = new Hono();

  // 200 {ok, dir, window, complete} | 409 already_reported {dir} | 409 no_tmux {dir, complete}
  // | 500 spawn_failed {dir, message, complete} | 500 snapshot_failed | 403 unknown_session
  // | 503 direct_stream_off / report_off | 400 invalid_json / invalid_body | 403 forbidden_origin.
  r.post('/api/stream/sessions/:id/report', sameOriginOnly, async (c) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    const reporter = deps.streamReporter ?? null;
    if (reporter === null) return c.json(REPORT_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = reportBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: describeIssues(body.error) }, 400);
    const page: PageReport | null = body.data.page ?? null;
    const out = await reporter.report(c.req.param('id'), page);
    return c.json(out.body, out.status);
  });

  return r;
}
```
**Impact:** New module. It reads `AppDeps.streamReporter`, which Step 4 adds; write Steps 3 and 4 together before typechecking.

### Step 4: Wiring
**File:** `src/deps.ts:14` (imports) and `:73` (after `streamProber?`)
**Code (add to the import block, after phase 1's line `import type { StreamEvidence } from './directStream/evidence.js';`, which follows `import type { StreamProberHandle } …`):**
```ts
import type { StreamReporter } from './directStream/report.js';
```
**Code (insert after phase 1's `streamEvidence?: StreamEvidence | null;` member, which follows `streamProber?: StreamProberHandle | null;`; phase 5, which may land before or after this phase, adds `streamCache?` after `directStream?:`, elsewhere in the interface):**
```ts
  /**
   * The player's report button (stream-cache-and-bug-report phase 4): one evidence snapshot and one
   * tmux Claude Code window per stream session. The daemon sets it while direct streaming and the
   * evidence log are on; null or absent, POST /api/stream/sessions/:id/report answers 503 report_off.
   */
  streamReporter?: StreamReporter | null;
```

**File:** `src/daemon.ts:12` (import), `:31-32` (imports), `:225` (after `deps.streamProber = …`)
**Code (line 12, replaces `import type { Config } from './config.js';`):**
```ts
import { REPO_ROOT, type Config } from './config.js';
```
**Code (add after line 32 `import { buildStreamProber } …`):**
```ts
import { StreamReporter } from './directStream/report.js';
import { defaultClaudeWindowDeps } from './sessions/resume.js';
```
**Code (insert right after the line `deps.streamProber = await buildStreamProber({ … });`):**
```ts
  // The player's report button (stream-cache-and-bug-report phase 4): phase 1's snapshot, then a
  // tmux window running claude on /report-stream-bug in this checkout. Nothing runs until a click.
  const reportStream = deps.directStream ?? null;
  const reportEvidence = deps.streamEvidence ?? null;
  deps.streamReporter =
    reportStream === null || reportEvidence === null
      ? null
      : new StreamReporter({
          evidence: reportEvidence,
          // Phase 1's evidenceSource peeks without marking the session used.
          isLive: (id) => reportStream.evidenceSource(id) !== null,
          reportsDir: reportEvidence.reportsDir,
          cwd: REPO_ROOT,
          window: () => defaultClaudeWindowDeps({ claudeBin: config.chat.claudeBin }),
        });
```
If `src/daemon.ts` already imports from `./sessions/resume.js` after phases 1–2, merge `defaultClaudeWindowDeps` into that import instead of adding a second one.

**File:** `src/http/app.ts:28` (import), `:139` (mount)
**Code (after phase 1's line `import { streamEvidenceRoutes } from './streamEvidenceApi.js';`, which follows `import { streamProberRoutes } …`):**
```ts
import { streamReportRoutes } from './streamReportApi.js';
```
**Code (after phase 1's line `app.route('/', streamEvidenceRoutes(deps));`, which follows `app.route('/', streamProberRoutes(deps));`):**
```ts
  app.route('/', streamReportRoutes(deps));
```
**Impact:** The route is served. `npm run typecheck` passes; `tests/unit/docs/reference.test.ts` fails until Step 9 describes the route (do Step 9 before running `npm test`).

### Step 5: The page's report call
**File:** `web/src/stream/session.ts:135` (after `episodeUrl`) and the end of the file
**Code (after phase 1's line `export const eventsUrl = …`, which follows `export const episodeUrl = …`):**
```ts
export const reportUrl = (id: string): string => `${sessionUrl(id)}/report`;
```
**Code (append at the end of the file):**
```ts
/** What the page sends with a report: its own view of the failure (the daemon may no longer know the session). */
export interface PageReport {
  stage: string;
  error: string | null;
  errors: string[];
  log: string[];
  title: string;
  position_s: number | null;
}

/** The daemon's answer to a report, as the page shows it. */
export type ReportAnswer =
  | { status: 'opened'; dir: string; window: string }
  | { status: 'already'; dir: string }
  | { status: 'saved'; dir: string; reason: 'no_tmux' | 'spawn_failed' }
  | { status: 'failed'; code: string };

/**
 * The report button: POST /api/stream/sessions/:id/report with the page's log. Never throws: a
 * window opened, a report made before, a snapshot saved but not opened (`no_tmux`,
 * `spawn_failed`), or a failure with the daemon's code.
 */
export async function reportStreamBug(id: string, page: PageReport, fetchImpl: typeof fetch): Promise<ReportAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(reportUrl(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page }) });
  } catch {
    return { status: 'failed', code: 'network' };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const dir = body !== null && typeof body.dir === 'string' && body.dir !== '' ? body.dir : null;
  const error = body !== null && typeof body.error === 'string' ? body.error : null;
  const window = body !== null && typeof body.window === 'string' ? body.window : '';
  if (res.ok && dir !== null) return { status: 'opened', dir, window };
  if (dir !== null && error === 'already_reported') return { status: 'already', dir };
  if (dir !== null && (error === 'no_tmux' || error === 'spawn_failed')) return { status: 'saved', dir, reason: error };
  return { status: 'failed', code: error ?? `http_${res.status}` };
}
```
**Impact:** New exports only.

### Step 6: The controller method and state
**File:** `web/src/stream/controller.ts`
**Change:** Add `bugReport` to `StreamState` (last member) and `INITIAL_STATE` (last entry); add `reportBug()` right after `goToEpisode`; reset `bugReport` in the episode switch's `set`. The `Stage` type and every stage transition stay as phase 2 left them.

**Code (import block from `./session`, as phase 1 left it: add `reportStreamBug` and `type ReportAnswer`):**
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
  type EpisodeNumber,
  type ManifestKind,
  type PlayerLogLine,
  type ReportAnswer,
  type StreamSession,
} from './session';
```

**Code (insert before `export interface StreamState`):**
```ts
/** The report button (only shown in the error stage): nothing sent, being sent, or the daemon's answer. */
export type BugReportState = { status: 'idle' } | { status: 'sending' } | ReportAnswer;
```

**Code (last member of `StreamState`, after `log: string[];`):**
```ts
  /** The report button's state for this session; back to idle when the page plays another session. */
  bugReport: BugReportState;
```

**Code (last entry of `INITIAL_STATE`, after `log: [],`):**
```ts
  bugReport: { status: 'idle' },
```

**Code (line 217 in `goToEpisode`, replaces the `this.set({ stage: 'loading', … })` line):**
```ts
    this.set({ stage: 'loading', switching: null, error: null, refreshes: 0, qualities: [], quality: -1, subtitles: [], reportedS: null, bugReport: { status: 'idle' } });
```

**Code (new method, insert after the closing `}` of `goToEpisode`):**
```ts
  /**
   * The report button: asks the daemon to snapshot this session's evidence and open a Claude Code
   * window on it, sending the page's own log (the daemon may have lost the session). One report per
   * session: a click while one is being sent, after a window opened, or after the daemon said it
   * was reported before does nothing. A report saved but not opened may be sent again; the daemon
   * reuses its folder.
   */
  async reportBug(): Promise<void> {
    if (this.disposed) return;
    const now = this.state.bugReport.status;
    if (now === 'sending' || now === 'opened' || now === 'already') return;
    const sessionId = this.sessionId;
    this.set({ bugReport: { status: 'sending' } });
    const answer = await reportStreamBug(
      sessionId,
      {
        stage: this.state.stage,
        error: this.state.error,
        errors: this.state.errors,
        log: this.state.log,
        title: this.state.title,
        position_s: this.lastPositionS > 0 ? round1(this.lastPositionS) : null,
      },
      this.deps.fetch,
    );
    if (this.disposed || sessionId !== this.sessionId) return;
    this.set({ bugReport: answer });
    this.note(answer.status === 'failed' ? `report: failed ${answer.code}` : `report: ${answer.status} ${answer.dir}`);
  }
```
**Impact:** `window.notesdStream.bugReport` appears through `notesdStreamOf`'s spread (scripts read it). No stage changes.

### Step 7: The button in the error overlay
**File:** `web/src/stream/StreamApp.tsx`
**Change:** Import `Bug` and `CheckCircle`; add `reportLabel`, `reportText`, `ReportButton`; give `StageOverlay` an optional `onReport`; render the button in the error branch only; pass `onReport` from `StreamApp` while a controller exists.

**Code (phosphor import, lines 2-18: add `Bug` and `CheckCircle`; keep any icon phase 2 added):**
```tsx
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowsIn,
  ArrowsOut,
  Bug,
  CheckCircle,
  CircleNotch,
  ClosedCaptioning,
  GearSix,
  IconContext,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  WarningCircle,
} from '@phosphor-icons/react';
import { INITIAL_STATE, StreamController, type BugReportState, type ControllerDeps, type StreamState } from './controller';
```

**Code (insert right before `function StageOverlay`):**
```tsx
/** The report button's name (its aria-label and title): it has no visible text. */
export function reportLabel(report: BugReportState): string {
  switch (report.status) {
    case 'sending':
      return 'Sending the report';
    case 'opened':
      return 'Report opened in tmux';
    case 'already':
      return 'Already reported';
    case 'saved':
      return 'Open the report again';
    default:
      return 'Report this stream bug';
  }
}

/** The line under the report button once the daemon answered; null before. */
export function reportText(report: BugReportState): string | null {
  switch (report.status) {
    case 'opened':
      return report.window !== '' ? `Report opened in tmux window ${report.window}: ${report.dir}` : `Report opened in tmux: ${report.dir}`;
    case 'already':
      return `Already reported: ${report.dir}`;
    case 'saved':
      return report.reason === 'no_tmux'
        ? `Report saved but not opened, no tmux is running: ${report.dir}`
        : `Report saved but not opened, Claude Code could not be started: ${report.dir}`;
    case 'failed':
      return `The report could not be made (${report.code}).`;
    default:
      return null;
  }
}

function ReportButton({ report, onReport }: { report: BugReportState; onReport: () => void }) {
  const label = reportLabel(report);
  const text = reportText(report);
  const spent = report.status === 'sending' || report.status === 'opened' || report.status === 'already';
  return (
    <div className="st-report">
      <button type="button" className="st-btn" aria-label={label} title={label} disabled={spent} onClick={onReport}>
        {report.status === 'sending' ? <CircleNotch className="st-spin" /> : report.status === 'opened' || report.status === 'already' ? <CheckCircle /> : <Bug />}
      </button>
      {text !== null && (
        <span className="st-report-text" role="status">
          {text}
        </span>
      )}
    </div>
  );
}
```

**Code (error branch of `StageOverlay`; change only the function's parameter list and the `if (state.stage === 'error')` block, leaving phase 2's loading/refreshing/recovering branch as it is):**
```tsx
function StageOverlay({ state, onReport }: { state: StreamState; onReport?: () => void }) {
```
```tsx
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
```

**Code (in `StreamApp`, insert after the `goToEpisode` `useCallback`, line 307):**
```tsx
  const reportBug = useCallback(() => {
    void controller?.reportBug();
  }, [controller]);
```

**Code (line 356, replaces `<StageOverlay state={state} />`):**
```tsx
        <StageOverlay state={state} onReport={controller !== null && sessionId !== null ? reportBug : undefined} />
```
**Impact:** The button exists only in the error stage and only when a session id and a controller exist (`/stream/` with no id shows none). `noUnusedLocals` holds: every new symbol is used.

### Step 8: Styles
**File:** `web/src/stream/stream.css:170` (after the `.st-error span { … }` rule)
**Code:**
```css
.st-report {
  display: grid;
  justify-items: center;
  gap: 8px;
  pointer-events: auto;
}
.st-report .st-btn {
  color: #ecebe4;
}
.st-error .st-report-text {
  max-width: 60ch;
  overflow-wrap: anywhere;
}
```
**Impact:** `.st-center` has `pointer-events: none`; `.st-report` turns it back on for the button only. The status line takes the existing `.st-error span` look (13 px, centred, grey); long folder paths wrap.

### Step 9: Route description and generated reference
**File:** `scripts/docs/httpRoutes.ts:233` (after the `'POST /api/stream/sessions/:id/position'` entry, in the direct-streaming group)
**Code:**
```ts
      'POST /api/stream/sessions/:id/report':
        '`{page?: {stage, error, errors, log, title?, position_s?}}` from the player page\'s report button (the page\'s own view of the failure; every address in it loses its query): writes the evidence snapshot of the session at once, then opens a new window in the most recently attached tmux session running Claude Code (`--permission-mode auto`) in the mcp-notes checkout on `/report-stream-bug <folder>`, named `stream-bug-<first 6 characters of the id>`. 200 `{ok: true, dir, window, complete}` (`complete: false` when the daemon no longer knows the session and the page\'s log stands in for it). One report per session, remembered by `report.json` in the folder across restarts: 409 `already_reported` `{dir}`. When the window cannot open the snapshot is kept: 409 `no_tmux` `{dir, complete}`, 500 `spawn_failed` `{dir, message, complete}`; a later call opens it on the same folder. 403 `unknown_session` (a malformed id, or an ended session sent with no `page`), 500 `snapshot_failed`, 503 `report_off`, 400 `invalid_json` / `invalid_body`. Same-origin only.',
```
Then run `npm run docs:gen` (rewrites `docs/guide/reference/http-api.md`; never edit it by hand).
**Impact:** `tests/unit/docs/reference.test.ts` passes again.

### Step 10: Tests (server)
**File:** `tests/unit/directStream/report.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_MARKER,
  REPORT_PERMISSION_MODE,
  StreamReporter,
  type EvidenceSnapshotter,
  type PageReport,
} from '../../../src/directStream/report.js';
import type { CommandRunner } from '../../../src/sessions/resume.js';

const SID = 'AbCdEf0123456789_-AbCdEf01234567';
const ENDED = 'ZyXwVu0123456789_-ZyXwVu01234567';
const CLAUDE = '/opt/claude/claude';
const CWD = '/home/owner/mcp-notes';
const PAGE: PageReport = {
  stage: 'error',
  error: 'networkError fragLoadError',
  errors: ['networkError fragLoadError'],
  log: ['error: networkError fragLoadError'],
  title: 'One Piece S18E787',
  position_s: 612.4,
};

let root = '';
let reportsDir = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'stream-report-'));
  reportsDir = path.join(root, 'movies', 'stream-reports');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Phase 1's snapshot, faked: a new folder per call, `complete` while the session is live. */
function fakeEvidence(live: Set<string>, flags: { fail?: boolean } = {}) {
  const calls: (string | null)[] = [];
  const evidence: EvidenceSnapshotter = {
    async snapshot(sessionId) {
      calls.push(sessionId);
      if (flags.fail === true) throw new Error('disk full');
      const dir = path.join(reportsDir, `20261116-12000${calls.length}-${(sessionId ?? 'last00').slice(0, 6)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'session.json'), '{}\n');
      return { dir, session_id: sessionId, complete: sessionId !== null && live.has(sessionId) };
    },
  };
  return { evidence, calls };
}

/** A tmux that records every call; `down` answers like a tmux with no server. */
function fakeTmux(state: { down?: boolean; failNewWindow?: boolean } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    expect(cmd).toBe('tmux');
    calls.push([...args]);
    if (state.down === true) throw new Error('no server running on /tmp/tmux-1000/default');
    switch (args[0]) {
      case 'list-sessions':
        return '100 work\n200 note\n';
      case 'show-environment':
        return 'PATH=/usr/local/bin:/usr/bin\n';
      case 'list-clients':
        return '90 /dev/pts/2\n';
      case 'new-window':
        if (state.failNewWindow === true) throw new Error('create window failed: index in use');
        return 'note:3 %12\n';
      default:
        return '';
    }
  };
  const newWindows = (): string[][] => calls.filter((c) => c[0] === 'new-window');
  return { run, calls, newWindows, state };
}

function makeReporter(
  tmux: ReturnType<typeof fakeTmux>,
  ev: ReturnType<typeof fakeEvidence>,
  live: Set<string>,
  opts: { canRun?: boolean } = {},
): StreamReporter {
  return new StreamReporter({
    evidence: ev.evidence,
    isLive: (id) => live.has(id),
    reportsDir,
    cwd: CWD,
    window: { run: tmux.run, tmuxBin: 'tmux', tmuxSocket: null, claudeBin: CLAUDE },
    canRun: async () => opts.canRun ?? true,
    now: () => new Date('2026-11-16T05:00:00Z'),
  });
}

async function marker(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, REPORT_MARKER), 'utf8')) as Record<string, unknown>;
}

function dirOf(body: object): string {
  const dir = (body as { dir?: unknown }).dir;
  if (typeof dir !== 'string') throw new Error(`no dir in ${JSON.stringify(body)}`);
  return dir;
}

describe('StreamReporter (R4.2)', () => {
  it('snapshots at once and opens one window running /report-stream-bug on the folder, in the checkout, named after the session', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(SID, PAGE);
    expect(out.status).toBe(200);
    const dir = dirOf(out.body);
    expect(out.body).toEqual({ ok: true, dir, window: 'note:3', complete: true });
    expect(ev.calls).toEqual([SID]);
    expect(tmux.newWindows()).toHaveLength(1);
    const argv = tmux.newWindows()[0]!;
    expect(argv.slice(0, 7)).toEqual(['new-window', '-t', '=note:', '-c', CWD, '-n', `stream-bug-${SID.slice(0, 6)}`]);
    expect(argv.slice(-4)).toEqual([CLAUDE, '--permission-mode', REPORT_PERMISSION_MODE, `/report-stream-bug ${dir}`]);
    expect(REPORT_PERMISSION_MODE).toBe('auto');
    // The markers a Claude Code parent would leak are scrubbed, and tmux's PATH is handed on.
    expect(argv).toEqual(expect.arrayContaining(['env', '-u', 'CLAUDECODE', 'PATH=/usr/local/bin:/usr/bin']));
    expect(await marker(dir)).toEqual({
      session_id: SID,
      dir,
      reported_at: '2026-11-16T05:00:00.000Z',
      complete: true,
      prompt: `/report-stream-bug ${dir}`,
      page: PAGE,
      result: { outcome: 'opened', window: 'note:3' },
    });
  });

  it("reports a session the daemon no longer knows from the page's own log, marked incomplete", async () => {
    const live = new Set<string>();
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(ENDED, PAGE);
    expect(out).toMatchObject({ status: 200, body: { ok: true, complete: false } });
    expect(await marker(dirOf(out.body))).toMatchObject({ complete: false, page: PAGE });
  });

  it('an ended session sent with no page log, or a malformed id, is unknown_session and snapshots nothing', async () => {
    const live = new Set<string>();
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    expect(await reporter.report(ENDED, null)).toMatchObject({ status: 403, body: { error: 'unknown_session' } });
    expect(await reporter.report('../../etc', PAGE)).toMatchObject({ status: 403, body: { error: 'unknown_session' } });
    expect(ev.calls).toEqual([]);
    expect(tmux.calls).toEqual([]);
  });

  it('a failed snapshot answers snapshot_failed, remembers nothing, and a later click reports', async () => {
    const live = new Set([SID]);
    const flags = { fail: true };
    const tmux = fakeTmux();
    const ev = fakeEvidence(live, flags);
    const reporter = makeReporter(tmux, ev, live);
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 500, body: { error: 'snapshot_failed', message: 'disk full' } });
    expect(tmux.newWindows()).toHaveLength(0);
    flags.fail = false;
    expect((await reporter.report(SID, PAGE)).status).toBe(200);
  });
});

describe('StreamReporter: one report per session (R4.3)', () => {
  it('a second click opens no second window and answers already_reported with the first folder', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const first = await reporter.report(SID, PAGE);
    const dir = dirOf(first.body);
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 409, body: { error: 'already_reported', dir } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('two clicks at once make one snapshot and one window', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const outs = await Promise.all([reporter.report(SID, PAGE), reporter.report(SID, PAGE)]);
    expect(outs.map((o) => o.status).sort()).toEqual([200, 409]);
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('a restarted daemon remembers the report by its marker file', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const dir = dirOf((await makeReporter(tmux, ev, live).report(SID, PAGE)).body);
    const afterRestart = makeReporter(tmux, ev, live);
    expect(await afterRestart.report(SID, PAGE)).toEqual({ status: 409, body: { error: 'already_reported', dir } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });
});

describe('StreamReporter: the snapshot is kept when no window opens (R4.4)', () => {
  it('no tmux: answers no_tmux with the folder, keeps it, and a later click opens it on the same folder', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux({ down: true });
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const first = await reporter.report(SID, PAGE);
    const dir = dirOf(first.body);
    expect(first).toEqual({ status: 409, body: { error: 'no_tmux', dir, complete: true } });
    expect((await stat(path.join(dir, 'session.json'))).isFile()).toBe(true);
    expect(await marker(dir)).toMatchObject({ result: { outcome: 'no_tmux' } });
    tmux.state.down = false;
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 200, body: { ok: true, dir, window: 'note:3', complete: true } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('a claude binary that cannot be run: spawn_failed with the folder, and no window is tried', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live, { canRun: false }).report(SID, PAGE);
    expect(out).toMatchObject({ status: 500, body: { error: 'spawn_failed', complete: true } });
    expect((out.body as { message: string }).message).toContain(CLAUDE);
    expect(tmux.newWindows()).toHaveLength(0);
    expect(await marker(dirOf(out.body))).toMatchObject({ result: { outcome: 'spawn_failed' } });
  });

  it('new-window fails: spawn_failed with tmux\'s message and the folder kept', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux({ failNewWindow: true });
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(SID, PAGE);
    const dir = dirOf(out.body);
    expect(out).toEqual({ status: 500, body: { error: 'spawn_failed', dir, message: 'create window failed: index in use', complete: true } });
    expect((await stat(path.join(dir, 'session.json'))).isFile()).toBe(true);
  });
});
```

**File:** `tests/unit/directStream/reportRoute.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../src/directStream/service.js';
import type { PageReport, ReportOutcome, StreamReporter } from '../../../src/directStream/report.js';
import { scrubLine, streamReportRoutes } from '../../../src/http/streamReportApi.js';

const SID = 'AbCdEf0123456789_-AbCdEf01234567';
const URL_ = `http://localhost/api/stream/sessions/${SID}/report`;
const ON = {} as DirectStreamService;

function fakeReporter(outcome: ReportOutcome) {
  const calls: { id: string; page: PageReport | null }[] = [];
  const reporter = {
    report: async (id: string, page: PageReport | null) => {
      calls.push({ id, page });
      return outcome;
    },
  } as unknown as StreamReporter;
  return { reporter, calls };
}

const OPENED: ReportOutcome = { status: 200, body: { ok: true, dir: '/d/r1', window: 'note:3', complete: true } };

function post(app: ReturnType<typeof streamReportRoutes>, body: string | undefined, origin: string | null = 'http://localhost') {
  return app.request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
    ...(body === undefined ? {} : { body }),
  });
}

const PAGE = { stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'], log: [] };

describe('POST /api/stream/sessions/:id/report', () => {
  it("refuses a request without the page's own Origin and reports nothing", async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), '{}', null);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    expect(calls).toHaveLength(0);
  });

  it('answers direct_stream_off without direct streaming and report_off without a reporter', async () => {
    const { reporter } = fakeReporter(OPENED);
    const off = await post(streamReportRoutes({ directStream: null, streamReporter: reporter }), '{}');
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'direct_stream_off' });
    const noReporter = await post(streamReportRoutes({ directStream: ON, streamReporter: null }), '{}');
    expect(noReporter.status).toBe(503);
    expect(await noReporter.json()).toMatchObject({ error: 'report_off' });
  });

  it("hands the page's log to the reporter with every address's query dropped", async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const body = JSON.stringify({
      page: {
        ...PAGE,
        log: ['retry 2: https://cdn.host.example/hls/seg-12.ts?token=SECRET&e=1 timed out', `GET /api/stream/sessions/${SID}/p?u=https%3A%2F%2Fcdn%2Fx%3Ftoken%3DSECRET`],
        title: 'One Piece S18E787',
        position_s: 612.4,
      },
    });
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OPENED.body);
    expect(calls[0]!.id).toBe(SID);
    expect(calls[0]!.page!.log).toEqual(['retry 2: https://cdn.host.example/hls/seg-12.ts timed out', `GET /api/stream/sessions/${SID}/p`]);
    expect(calls[0]!.page).toMatchObject({ stage: 'error', title: 'One Piece S18E787', position_s: 612.4 });
    expect(JSON.stringify(calls)).not.toContain('SECRET');
  });

  it('an empty body is a report without the page log; a page without title or position gets nulls', async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const app = streamReportRoutes({ directStream: ON, streamReporter: reporter });
    expect((await post(app, undefined)).status).toBe(200);
    expect((await post(app, JSON.stringify({ page: PAGE }))).status).toBe(200);
    expect(calls[0]!.page).toBeNull();
    expect(calls[1]!.page).toEqual({ ...PAGE, title: null, position_s: null });
  });

  it.each<ReportOutcome>([
    { status: 409, body: { error: 'already_reported', dir: '/d/r1' } },
    { status: 409, body: { error: 'no_tmux', dir: '/d/r1', complete: false } },
    { status: 500, body: { error: 'spawn_failed', dir: '/d/r1', message: 'boom', complete: true } },
    { status: 403, body: { error: 'unknown_session', message: 'gone' } },
  ])('passes the reporter answer $status $body.error through', async (outcome) => {
    const { reporter } = fakeReporter(outcome);
    const res = await post(streamReportRoutes({ directStream: ON, streamReporter: reporter }), JSON.stringify({ page: PAGE }));
    expect(res.status).toBe(outcome.status);
    expect(await res.json()).toEqual(outcome.body);
  });

  it('refuses a body that is not JSON, or not a report', async () => {
    const { reporter, calls } = fakeReporter(OPENED);
    const app = streamReportRoutes({ directStream: ON, streamReporter: reporter });
    const bad = await post(app, '{nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_json' });
    const wrong = await post(app, JSON.stringify({ page: { stage: 3 } }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });
});

describe('scrubLine', () => {
  it('keeps host and path, drops query and fragment, caps the length', () => {
    expect(scrubLine('x https://a.example/p/q.m3u8?sig=1#t y')).toBe('x https://a.example/p/q.m3u8 y');
    expect(scrubLine('no address here')).toBe('no address here');
    expect(scrubLine('z'.repeat(900))).toHaveLength(500);
  });
});
```

### Step 11: Tests (web)
**File:** `web/src/stream/controller.test.tsx` (append a new `describe` at the end of the file; the file's `setup`, `S1`, `jsonResponse`, `streamSessionJson` are already in scope)
**Code:**
```tsx
describe('StreamController: the report button (R4)', () => {
  const failed = async (report: () => Response) => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()), [`POST ${S1}/report`]: report });
    await t.controller.start();
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('error');
    const reports = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/report`);
    return { ...t, reports };
  };

  it("sends the page's own log once; after the window opened a second click sends nothing", async () => {
    const { controller, reports } = await failed(() => jsonResponse({ ok: true, dir: '/d/r1', window: 'note:3', complete: true }));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'opened', dir: '/d/r1', window: 'note:3' });
    await controller.reportBug();
    expect(reports()).toHaveLength(1);
    expect(reports()[0].body).toMatchObject({
      page: { stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'], title: 'Fight Club (1999)' },
    });
  });

  it('a report saved but not opened says so and may be sent again', async () => {
    let n = 0;
    const { controller, reports } = await failed(() =>
      ++n === 1 ? jsonResponse({ error: 'no_tmux', dir: '/d/r1', complete: true }, 409) : jsonResponse({ ok: true, dir: '/d/r1', window: 'note:4', complete: true }),
    );
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'saved', dir: '/d/r1', reason: 'no_tmux' });
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'opened', dir: '/d/r1', window: 'note:4' });
    expect(reports()).toHaveLength(2);
  });

  it('keeps the first folder when the daemon says the session was reported before', async () => {
    const { controller } = await failed(() => jsonResponse({ error: 'already_reported', dir: '/d/r0' }, 409));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'already', dir: '/d/r0' });
  });

  it("an answer without a folder is a failure with the daemon's code", async () => {
    const { controller } = await failed(() => jsonResponse({ error: 'unknown_session' }, 403));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'failed', code: 'unknown_session' });
  });
});
```

**File:** `web/src/stream/StreamApp.test.tsx` (insert these `it`s inside `describe('StreamApp', …)`, after `'says so when the address has no session'`; extend the import of `./StreamApp` with `reportLabel, reportText`)
**Code (import line 5):**
```tsx
import { StreamApp, episodeLabel, formatClock, reportLabel, reportText, switchErrorText } from './StreamApp';
```
**Code:**
```tsx
  it('shows an icon-only report button beside the error and says when the report was saved but not opened', async () => {
    const { createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403),
      'POST /api/stream/sessions/S1/report': () => jsonResponse({ error: 'no_tmux', dir: '/data/movies/stream-reports/r1', complete: false }, 409),
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    const alert = el.querySelector('[role="alert"]')!;
    const report = alert.querySelector('button[aria-label="Report this stream bug"]');
    expect(report).not.toBeNull();
    expect(report!.textContent).toBe('');
    expect(report!.querySelector('svg')).not.toBeNull();
    click(report);
    await settle();
    const status = alert.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('Report saved but not opened');
    expect(status).toContain('/data/movies/stream-reports/r1');
    expect(button(alert, 'Open the report again')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/stream/sessions/S1/report')).toHaveLength(1);
  });

  it('after the window opened the button is spent', async () => {
    const { createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403),
      'POST /api/stream/sessions/S1/report': () => jsonResponse({ ok: true, dir: '/d/r1', window: 'note:3', complete: false }),
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    click(button(el, 'Report this stream bug'));
    await settle();
    const spent = button(el, 'Report opened in tmux') as HTMLButtonElement | null;
    expect(spent?.disabled).toBe(true);
    expect(el.querySelector('[role="alert"] [role="status"]')?.textContent).toContain('note:3');
    click(spent);
    await settle();
    expect(calls.filter((c) => c.url === '/api/stream/sessions/S1/report')).toHaveLength(1);
  });

  it('shows no report button while the film plays, nor when the address has no session', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    expect(button(el, 'Report this stream bug')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const none = render(<StreamApp sessionId={null} />);
    expect(button(none, 'Report this stream bug')).toBeNull();
  });
```
A disabled button ignores the click, so the request count stays at one.
**Code (add a new `describe` at the end of the file):**
```tsx
describe('reportLabel and reportText', () => {
  it('name every state of the report button', () => {
    expect(reportLabel({ status: 'idle' })).toBe('Report this stream bug');
    expect(reportText({ status: 'idle' })).toBeNull();
    expect(reportText({ status: 'already', dir: '/d/r0' })).toBe('Already reported: /d/r0');
    expect(reportText({ status: 'saved', dir: '/d/r1', reason: 'spawn_failed' })).toBe('Report saved but not opened, Claude Code could not be started: /d/r1');
    expect(reportText({ status: 'failed', code: 'snapshot_failed' })).toBe('The report could not be made (snapshot_failed).');
  });
});
```
The `onReady` payload must match `EngineReady` as the existing first test sends it (`qualities`, `subtitles`); if phase 2 added a member, copy the shape the first `StreamApp` test uses.
**Impact:** Behaviour tests only (observable state, DOM, requests sent).

### Step 12: Guide
**File:** `docs/guide/streaming.md`
**Change 1 (`:482`, after the "**Previous and next episode.**" bullet of "### The player", before the `window.notesdStream` paragraph):**
```markdown
- **Report.** When the page stops with an error, a bug icon sits under the message. A click asks
  the daemon (`POST /api/stream/sessions/<id>/report`) to write the session's evidence snapshot at
  once (sessions live in memory and tokens expire), then to open a new window in the most recently
  used tmux session, named `stream-bug-<first 6 characters of the session id>`, running Claude Code
  in the mcp-notes checkout on `/report-stream-bug <snapshot folder>`. It runs in `auto` permission
  mode, so it collects, diagnoses and saves its note without waiting for you, while the permission
  classifier still checks what it runs (the evidence holds text from the stream hosts). The page
  sends its own error and log lines with the click, kept in the folder as `report.json`, so a
  session the daemon has lost (a restart) is still reported, marked incomplete. One report per
  session: `report.json` remembers it across restarts, and a second click opens nothing (`Already
  reported`). With no tmux running, or a claude binary that cannot be run, the snapshot is kept and
  the page says the report was saved but not opened, with the folder; a later click opens it on the
  same folder.
```
**Change 2 (`:420-422`, rows appended to the "Direct streaming answers" table after `upstream_error`):**
```markdown
| `already_reported` | The report button: this stream session was reported before; `dir` is the first report's folder and no window opens |
| `no_tmux` | The report button: the snapshot was written to `dir`, but no tmux server is running to open Claude Code in |
| `spawn_failed` | The report button: the snapshot was written to `dir`, but the claude binary could not be run or tmux refused the window (`message`) |
| `snapshot_failed` | The report button: the evidence snapshot could not be written; nothing is remembered, so a later click tries again |
| `report_off` | The report button: this daemon has no evidence log to snapshot |
```
**Change 3 (`:798`, a row in "Where the code is", after the `src/http/directStreamApi.ts` row):**
```markdown
| `src/directStream/report.ts`, `src/http/streamReportApi.ts` | The player's report button: the snapshot, `report.json`, one tmux window per stream session (the opener is `openClaudeWindow` in `src/sessions/resume.ts`) |
```

### Step 13: Verify harness: a fake tmux in every throwaway run
**File:** `.claude/skills/verify-notesd/scripts/stream/fake-tmux.sh` (new; `chmod +x` it so git records mode 100755)
**Code:**
```bash
#!/usr/bin/env bash
# The tmux of every verify-notesd run (verify.sh pins NOTESD_TMUX_BIN to this file): it never
# reaches a tmux server. Each call is appended to $NOTESD_FAKE_TMUX_DIR/calls.log, one line per
# call, the arguments separated by tabs. `touch $NOTESD_FAKE_TMUX_DIR/down` makes it answer like a
# tmux with no server; `touch $NOTESD_FAKE_TMUX_DIR/fail-new-window` makes new-window fail.
set -u
dir="${NOTESD_FAKE_TMUX_DIR:?NOTESD_FAKE_TMUX_DIR is not set}"
mkdir -p "$dir"
(
  IFS=$'\t'
  printf '%s\n' "$*"
) >>"$dir/calls.log"
if [ "${1:-}" = "-S" ]; then shift 2; fi
if [ -e "$dir/down" ]; then
  echo "no server running on /tmp/tmux-fake/default" >&2
  exit 1
fi
case "${1:-}" in
  list-sessions) echo "100 verify" ;;
  show-environment) echo "PATH=/usr/local/bin:/usr/bin:/bin" ;;
  list-clients) ;;
  new-window)
    if [ -e "$dir/fail-new-window" ]; then
      echo "create window failed: fake tmux was told to fail" >&2
      exit 1
    fi
    n="$(grep -c "new-window" "$dir/calls.log")"
    echo "verify:$n %$n"
    ;;
  *) ;;
esac
exit 0
```

**File:** `.claude/skills/verify-notesd/scripts/verify.sh:199-206` (the `local -a env=(` block of `cmd_up`) and `:316` (the printed lines)
**Code (insert `mkdir -p "$dir/tmux"` on the line before `local -a env=(`, and add the last two entries to the array):**
```bash
  mkdir -p "$dir/tmux"
  local -a env=(
    DATABASE_URL="$(db_url "$db")"
    NOTESD_PORT=0
    NOTES_DATA_DIR="$dir/data"
    CLAUDE_HOME="$dir/claude"
    NOTES_WORKTREES_DIR="$dir/worktrees"
    NOTESD_SWARM_SCRIPT="$dir/no-swarm.py"
    # Every run's tmux is the recording fake: the report button and resume never open a window in
    # the owner's tmux. TMUX_FAKE (printed below) is where its calls.log and switches live.
    NOTESD_TMUX_BIN="$HERE/stream/fake-tmux.sh"
    NOTESD_FAKE_TMUX_DIR="$dir/tmux"
  )
```
**Code (after the line `echo "LOG=$dir/daemon.log"` in `cmd_up`):**
```bash
  echo "TMUX_FAKE=$dir/tmux"
```

**File:** `.claude/skills/verify-notesd/SKILL.md:142` (first bullet under `## Gotchas`)
**Code:**
```markdown
- Every run's tmux is a recording fake (`scripts/stream/fake-tmux.sh`, `NOTESD_TMUX_BIN`), so the
  player's report button opens nothing on the owner's screen: its calls are in
  `$TMUX_FAKE/calls.log` (`up` prints `TMUX_FAKE=`); `touch $TMUX_FAKE/down` acts as no tmux
  server, `touch $TMUX_FAKE/fail-new-window` as a refused window.
```

**File:** `.claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs` (new)
**Code:**
```js
// The player's report button, end to end on a throwaway daemon (verify.sh up --web --direct-stream):
// the real page in its error stage, the daemon's report route, phase 1's snapshot, and the fake
// tmux every run uses (scripts/stream/fake-tmux.sh). Chromium here; no real tmux, no claude starts.
//   verify.sh up --web --direct-stream                   (note TMUX_FAKE=)
//   TMUX_FAKE=<that path> verify.sh ui RUN <this file>
// Logs "BUTTON PASS", "REPORT PASS", "ALREADY PASS", "NO_TMUX PASS", "SPAWN_FAILED PASS"; the first
// failed check throws and fails the run.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TMUX = process.env.TMUX_FAKE

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const tmuxCalls = () => {
  const file = path.join(TMUX, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : []
}
const newWindows = () => tmuxCalls().filter((a) => (a[0] === '-S' ? a[2] : a[0]) === 'new-window')
const marker = (dir) => JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'))

export default async ({ page, base, shot, log }) => {
  check(TMUX && existsSync(TMUX), 'set TMUX_FAKE to the path `verify.sh up` printed')
  for (const f of ['down', 'fail-new-window']) rmSync(path.join(TMUX, f), { force: true })
  const origin = new URL(base).origin
  const play = async () => {
    const res = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 550 } })
    check(res.ok(), `POST /api/stream/play answered ${res.status()} ${await res.text()}`)
    return (await res.json()).session.session_id
  }
  // The error stage at once: the page's read of its session answers what it cannot play
  // (bad_session). Only that GET is faked; the session stays live in the daemon.
  const failingPage = async (sid) => {
    await page.route(`${base}/api/stream/sessions/${sid}`, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue(),
    )
    await page.goto(`${base}/stream/${sid}?muted=1`)
    await page.waitForFunction(() => window.notesdStream?.stage === 'error', null, { timeout: 20_000 })
  }
  const answer = async () => {
    await page.waitForFunction(
      () => {
        const s = window.notesdStream?.bugReport?.status
        return s !== undefined && s !== 'idle' && s !== 'sending'
      },
      null,
      { timeout: 20_000 },
    )
    return page.evaluate(() => window.notesdStream.bugReport)
  }

  // J1: the icon-only button beside the error; a click snapshots and opens one window.
  const sid = await play()
  await failingPage(sid)
  const alert = page.getByRole('alert')
  const report = alert.getByRole('button', { name: 'Report this stream bug', exact: true })
  await report.waitFor()
  check((await report.innerText()).trim() === '', 'the report button is icon only')
  await shot('report-button')
  log('BUTTON PASS the error stage shows an icon-only "Report this stream bug" button')
  await report.click()
  const first = await answer()
  check(first.status === 'opened', `the report opened a window (got ${JSON.stringify(first)})`)
  check(existsSync(path.join(first.dir, 'session.json')), `phase 1's snapshot is in ${first.dir}`)
  const m = marker(first.dir)
  check(m.session_id === sid && m.result.outcome === 'opened' && m.page?.stage === 'error', `report.json names the session and the window (got ${JSON.stringify(m)})`)
  const windows = newWindows()
  check(windows.length === 1, `one new-window call (got ${windows.length})`)
  const argv = windows[0]
  check(argv.includes(`/report-stream-bug ${first.dir}`), `the window runs /report-stream-bug ${first.dir} (got ${argv.join(' ')})`)
  check(argv[argv.indexOf('--permission-mode') + 1] === 'auto', 'claude runs in auto permission mode')
  check(argv.includes(`stream-bug-${sid.slice(0, 6)}`), 'the window is named after the session')
  await alert.getByRole('status').filter({ hasText: 'Report opened in tmux' }).waitFor()
  await shot('report-opened')
  log(`REPORT PASS one window: ${argv.join(' ')}`)

  // J2: the same session again opens nothing.
  const again = await page.request.post(`${base}/api/stream/sessions/${sid}/report`, { headers: { origin }, data: {} })
  const againBody = await again.json()
  check(again.status() === 409 && againBody.error === 'already_reported' && againBody.dir === first.dir, `already_reported with the first folder (got ${again.status()} ${JSON.stringify(againBody)})`)
  check(newWindows().length === 1, 'still one new-window call')
  check(await alert.getByRole('button', { name: 'Report opened in tmux', exact: true }).isDisabled(), 'the spent button is disabled')
  log(`ALREADY PASS 409 already_reported ${first.dir}, no second window`)

  // J3: no tmux server: the snapshot is kept and the page says so.
  writeFileSync(path.join(TMUX, 'down'), '')
  const sid2 = await play()
  await failingPage(sid2)
  await page.getByRole('alert').getByRole('button', { name: 'Report this stream bug', exact: true }).click()
  const second = await answer()
  check(second.status === 'saved' && second.reason === 'no_tmux', `saved but not opened, no_tmux (got ${JSON.stringify(second)})`)
  check(existsSync(path.join(second.dir, 'session.json')) && marker(second.dir).result.outcome === 'no_tmux', `the snapshot is kept in ${second.dir}`)
  await page.getByRole('alert').getByRole('status').filter({ hasText: 'Report saved but not opened' }).waitFor()
  check(newWindows().length === 1, 'no window was opened')
  await shot('report-saved')
  log(`NO_TMUX PASS saved but not opened: ${second.dir}`)
  rmSync(path.join(TMUX, 'down'), { force: true })

  // J3: tmux refuses the window: spawn_failed, the snapshot kept.
  writeFileSync(path.join(TMUX, 'fail-new-window'), '')
  const sid3 = await play()
  const failed = await page.request.post(`${base}/api/stream/sessions/${sid3}/report`, { headers: { origin }, data: {} })
  const failedBody = await failed.json()
  rmSync(path.join(TMUX, 'fail-new-window'), { force: true })
  check(failed.status() === 500 && failedBody.error === 'spawn_failed' && existsSync(path.join(failedBody.dir, 'session.json')), `spawn_failed with the kept folder (got ${failed.status()} ${JSON.stringify(failedBody)})`)
  log(`SPAWN_FAILED PASS 500 spawn_failed (${failedBody.message}), folder kept: ${failedBody.dir}`)
}
```

### Step 14: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (append at the end)
**Code:**
```markdown
## Reporting a stream bug from the player
- The player's error stage shows an icon-only bug button (`Report this stream bug`). A click posts
  the page's own log to `POST /api/stream/sessions/:id/report` (same-origin): the daemon writes
  phase 1's evidence snapshot at once, adds `report.json` (the page's view, the outcome) to the
  folder, and opens one tmux window `stream-bug-<id6>` running claude `--permission-mode auto` on
  `/report-stream-bug <folder>` in the mcp-notes checkout. One report per session, also after a
  restart (`409 already_reported {dir}`); no tmux or no runnable claude keeps the snapshot
  (`409 no_tmux` / `500 spawn_failed`, both with `dir`) and the page says "Report saved but not
  opened". An ended session is still reported from the page's log (`complete: false`).
- Proven by `npx vitest run tests/unit/directStream/report.test.ts tests/unit/directStream/reportRoute.test.ts web/src/stream`
  (fake tmux and snapshot; restart; concurrent clicks; address queries dropped).
- Throwaway daemon (every run's tmux is the fake `scripts/stream/fake-tmux.sh`; nothing opens on
  the owner's screen): `$V up --web --direct-stream` (note `TMUX_FAKE=`), then
  `TMUX_FAKE=<that path> $V ui RUN .claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs`.
  The transcript has `BUTTON PASS`, `REPORT PASS` (one `new-window` carrying the prompt),
  `ALREADY PASS`, `NO_TMUX PASS` and `SPAWN_FAILED PASS`. Needs `claude` on PATH (the daemon checks
  the binary can run before asking tmux); elsewhere start `up` with `NOTESD_CLAUDE_BIN=$(command -v true)`.
- Live: a click on the owner's daemon opens a real Claude Code window that runs the skill and
  writes a `#stream-bug` note; it is the owner's to click.
```
**Impact:** Documentation only.

## Principles applied

- Laziness protocol: no second tmux opener; `openClaudeWindow` and the tmux helpers are reused by narrowing their parameter types (`TmuxDeps`, `ClaudeWindowDeps`) and exporting the opener, and `defaultClaudeWindowDeps` is extracted from `defaultResumeDeps` instead of copying its env reading. No new env variable.
- Boundary discipline: the route validates the body once with zod and drops every address query from the page's lines there (`scrubLine` in a zod transform); `StreamReporter` trusts the typed `PageReport`. A `report.json` read back from disk is parsed once by `parseMarker`.
- Make illegal states unrepresentable: the marker's outcome is the `MarkerResult` union (a `window` exists only on `opened`, a `message` only on `spawn_failed`); the HTTP answers are the `ReportOutcome` union (every `no_tmux` / `spawn_failed` carries `dir`); the page's button state is `BugReportState`, so "saved" without a folder or "opened" without a window cannot be built.
- Encode lessons in structure: "never drive resume, it spawns real tmux windows" was only a sentence in `verify-notesd/SKILL.md`; every `verify.sh up` now pins `NOTESD_TMUX_BIN` to a recording fake, so no throwaway daemon can open a window on the owner's screen through this button or resume.
- Sequence into verifiable units: Step 1 is checked alone by the existing resume tests before anything uses it; Step 2's reporter is testable with Step 10 before any route or UI exists.
- Test behavior, not implementation: the reporter tests drive `report()` and assert the tmux argv a real tmux would receive, the files on disk and the HTTP outcome; the web tests assert the DOM and the requests sent, not private calls.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), `npm run test:int`, `npm run docs:check`
**Proof:** the real daemon with the real page drives the button; tmux is the recording fake.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --direct-stream`, `verify.sh ui`)
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` ("Reporting a stream bug from the player")
- Journeys:
  - **J1** · traces R4.1, R4.2 — `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --web --direct-stream` (note `RUN=` and `TMUX_FAKE=`), then `TMUX_FAKE=<that path> $V ui RUN .claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs` → passes when the ui transcript has `BUTTON PASS` and `REPORT PASS`, `<TMUX_FAKE>/calls.log` holds exactly one line starting `new-window` that ends with the tab-separated `--permission-mode auto /report-stream-bug <dir>`, and `<dir>` holds phase 1's `session.json` and a `report.json` with `"outcome": "opened"`
  - **J2** · traces R4.3 — the same steps file (its second part), plus `npx vitest run tests/unit/directStream/report.test.ts -t "one report per session"` → passes when the transcript has `ALREADY PASS` (409 `already_reported` with the first folder, still one `new-window` line) and the three tests of that describe pass, among them "a restarted daemon remembers the report by its marker file"
  - **J3** · traces R4.4 — the same steps file (its third part: `touch $TMUX_FAKE/down`, then `fail-new-window`) → passes when the transcript has `NO_TMUX PASS` (the page's status line reads "Report saved but not opened", the folder has `session.json` and `report.json` with `"outcome": "no_tmux"`) and `SPAWN_FAILED PASS` (500 `spawn_failed` with an existing `dir`), and `calls.log` still has one `new-window` line
  - **J4** · traces R4.1, R4.2, R4.3, R4.4 — `npx vitest run tests/unit/directStream/report.test.ts tests/unit/directStream/reportRoute.test.ts web/src/stream` → passes when every test passes, including "shows an icon-only report button beside the error…", "snapshots at once and opens one window…", "two clicks at once make one snapshot and one window", "no tmux: answers no_tmux with the folder…" and "hands the page's log to the reporter with every address's query dropped"
- Neighbor check: resume shares the window opener. `npx vitest run tests/unit/sessions/resume.test.ts tests/unit/sessions/sessionResumeRoute.test.ts tests/unit/sessions/sessionResumeTool.test.ts && npm run test:int -- tests/integration/sessions.resume.int.test.ts` → all pass unchanged; and the player's existing journey `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` (with `FIX` from `make-hls-fixture.sh`) still logs `J1 PASS`, `J3 PASS`, `MUTED PASS`.
- Cost: none billed. No claude process is started anywhere (the fake tmux never runs its argv). Afterwards `$V down RUN`.
**Exit criteria:** with the recording fake tmux, a click in the player's error stage produces one `new-window` call carrying `/report-stream-bug <snapshot folder>` and a folder with `report.json`; a second report of that session yields 409 `already_reported` and no call; with no tmux the page says the report was saved but not opened and the folder stays; `npm test`, `npm run test:int`, `npm run typecheck` and `npm run docs:check` pass.

## Handoffs

**Assumptions about earlier phases (quoted code above is today's; these must hold after phases 1 and 2):**
- Phase 1 (reconciled): `AppDeps.streamEvidence` is the field name, set in `src/daemon.ts` before `deps.streamProber` is built (Step 4 reads it after that line). `snapshot(sessionId)` answers `complete: false` for an id the daemon no longer holds, with a folder holding what the log has; it throws only when the folder cannot be written (then the button answers 500 `snapshot_failed`). `report.ts` imports phase 1's `STREAM_REPORTS_SUBDIR` for `streamReportsDir`, and the daemon passes `StreamEvidence.reportsDir` itself, so the path is defined once. `StreamEvidence` satisfies the structural `EvidenceSnapshotter`.
- Phase 1 also has `controller.note` / `fail` post log lines to `POST /api/stream/sessions/:id/events`; `reportBug()` adds one `note` line (`report: opened <dir>`), which phase 1 then posts like any other. In the web tests that request answers the `routeFetch` default 404, which the page ignores.
- Phase 2: the error branch of `StageOverlay` and `fail()` behave as today; the `recovering` stage shows no report button (only `error` does). If phase 2 changed `EngineReady`, the `onReady` payload in Step 11's third StreamApp test follows the shape phase 2's tests use.

**Left for other phases:**
- Phase 3 (R3), reconciled: the folder the skill receives also holds `report.json` (`session_id`, `complete`, `page` with the page's `stage`/`error`/`errors`/`log`/`title`/`position_s`, and `result`); phase 3's `diagnose.mjs` reads it when present (its `FIELDS.report`). Phase 3's SKILL.md runs unattended under `--permission-mode auto` from cwd = the mcp-notes checkout: no question back to the owner, only its own scripts and the notes tools, no repository edit, and no new snapshot when handed a folder (index contract).
- Phase 6 (R1): nothing required; a play from the cache that fails shows the same button.
- Not done, deliberately: relaxing the verify-notesd gotcha "never drive `POST /api/sessions/:id/resume`" now that tmux is faked (resume also runs git and reads the registry; out of R4 scope).
- No docs picture: no `scripts/docs/shots/*.mjs` captures the player page and `docs/guide/streaming.md` has no player picture.

**Untraced criteria:** none.

## Rollback

Revert this phase's commits. That removes `src/directStream/report.ts`, `src/http/streamReportApi.ts`, the button, the wiring and the docs, and restores `resume.ts`'s private opener (the narrowed types have no other user). Run `npm run docs:gen` after reverting so `http-api.md` loses the route. `report.json` files already written stay in their snapshot folders under `<dataDir>/movies/stream-reports/`, where nothing reads them. Delete them by hand if you want them gone. No database change.

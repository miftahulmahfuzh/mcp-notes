# Phase 4: Resume and focus of live background jobs

**Plan set:** `SESSION_FORK_AWARENESS_PLAN.md`
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Satisfies:** R3 — resume/focus of a live Claude Code background job gives an actionable result instead of 409 `live_outside_tmux`
**Criteria:** R3.1, R3.2, R3.3, R3.4
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/sessions`

---

## Goal

A node that is live as a Claude Code background job (registry `kind: "bg"` with a `jobId`) can be
resumed or focused: the daemon opens a tmux window running `claude attach <jobId>` and answers
`action: "attached"`, or focuses (and types the prompt into) the attach pane it finds alive. A
prompt that cannot be delivered is reported as `prompt_delivered: false`. Every other live session
outside tmux still answers 409 `live_outside_tmux`.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `LiveSession.kind: string | null`, `LiveSession.jobId: string | null` (`src/sessions/registry.ts`) — raw registry fields
- `backgroundJobId(session: Pick<LiveSession, 'kind' | 'jobId'>): string | null` (`src/sessions/registry.ts`) — the one place that decides "this live entry is a background job"; returns the job id only for `kind === 'bg'` with a safe id (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`). Phase 5 should use it too instead of re-checking `kind`.
- `LiveEntry.jobId?: string | null` (`src/sessions/resume.ts`)
- `PANE_COMMAND_FORMAT`, `attachKey`, `isAttachCommand`, `parsePaneCommands`, `findAttachPane` (`src/sessions/resume.ts`)
- `registryLive(claudeHome, isAlive?)` (`src/http/sessionResume.ts`)
**Signature changes:**
- `ResumeAction` gains `'attached'`.
- `ResumeResult` becomes a discriminated union on `action`:
  `{action:'focused'|'messaged'; window?; job_id?}` | `{action:'resumed'|'spawned'; window?; cwd?; original_cwd?}` | `{action:'attached'; job_id; window?; prompt_delivered?: false}`.
  Wire shape (what phase 6 reads): `attached` always carries `job_id`; `prompt_delivered: false` is present only when a prompt was given; `focused`/`messaged` carry `job_id` when the pane is a background job's attach pane.
- `ResumeOutcome` keeps every existing error variant unchanged (`no_tmux`, `live_outside_tmux {pid}`, ...); no new error code.
- `resumeToolResult(out, nodeId)` returns two text items for `attached` (the JSON, then a sentence naming `claude attach <jobId>`).
**Requires (from earlier phases):** nothing.
**Leaves alone (owned by others):** `src/sessions/view.ts` incl. its own `LiveEntry` and `formatContext` (phase 5), `src/sessions/readModel.ts` (phase 5), `src/http/sessionsApi.ts` (phase 5), `session_get`/`sessions_search`/`session_transcript` text in `src/mcp/sessionTools.ts` (phase 5), all of `web/src` (phase 6), ingest/transcript/repo/fork code (phases 1–3), README sessions paragraph about forks and CLAUDE.md (phase 3).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/registry.ts` | modify | `LiveSession` gains `kind`, `jobId` (:18-33); `parseLiveEntry` fills them (:88-104); new `backgroundJobId` after `parseLiveEntry` (:105) |
| `src/sessions/resume.ts` | modify | `ResumeAction` (:43), `LiveEntry` (:69-74), `ResumeResult` (:76-84); new attach-pane helpers after `focusPane`/`messagePane` (:410); new `openClaudeWindow` helper; `LiveTarget`/`liveTarget` (:445-462); `resumeNode` (:468-540) |
| `src/http/sessionResume.ts` | modify | imports (:6, :8-15); new `registryLive` (after :36); `defaultSessionResumer` uses it (:53-56); route doc comment (:76-81) |
| `src/mcp/sessionTools.ts` | modify | `resumeToolResult` (:276-292) gets the `attached` text; `session_resume` description (:300) |
| `tests/unit/sessions/registry.test.ts` | modify | `kind`/`jobId` parse + `backgroundJobId` tests |
| `tests/unit/sessions/resume.test.ts` | modify | new `describe('background jobs …')` block |
| `tests/unit/sessions/sessionResumeRoute.test.ts` | modify | `registryLive` test; `attached` pass-through case |
| `tests/unit/sessions/sessionResumeTool.test.ts` | modify | `attached` text test |
| `README.md` | modify | "Resume from the wall" (:716-728), MCP table row (:1063), HTTP table row (:1153) |
| `.claude/skills/verify-notesd/features/projects.md` | modify | sub-feature line (:6) and a new "Resume of a live background job (fake tmux)" drive section before `## Gotchas` (:222) |

## Implementation Steps

### Step 1: Registry carries `kind` and `jobId`, and one function decides "background job"
**File:** `src/sessions/registry.ts:18-33`, `:82-105`
**Change:** add the two raw fields to `LiveSession`, fill them in `parseLiveEntry`, and add
`backgroundJobId`. The id is validated here, where registry JSON enters the program, because it
later becomes a `claude` argv word and a token matched in tmux output; a leading dash would be read
as a flag.
**Code:** replace the `LiveSession` interface:
```ts
export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string | null;
  /** `busy` | `idle` as Claude Code writes it; null when absent. */
  status: string | null;
  /** `session:@window.%pane`, e.g. `note:@0.%7`; null outside tmux. */
  tmux: string | null;
  name: string | null;
  nameSource: string | null;
  entrypoint: string | null;
  version: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
  messagingSocketPath: string | null;
  /** Registry `kind`: `interactive`, or `bg` for a background job (`claude --bg`, agent view); null when absent. */
  kind: string | null;
  /** Registry `jobId` of a background job, e.g. `e3650501` (what `claude attach` takes); null when absent. */
  jobId: string | null;
}
```
Replace `parseLiveEntry` and add `backgroundJobId` right after it:
```ts
/** One registry file's JSON to an entry plus its `procStart`; null when it is not a session entry. */
export function parseLiveEntry(raw: unknown): { session: LiveSession; procStart: string | null } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  const sessionId = str(r.sessionId);
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || sessionId === null) return null;
  return {
    procStart: typeof r.procStart === 'string' ? r.procStart : typeof r.procStart === 'number' ? String(r.procStart) : null,
    session: {
      sessionId,
      pid,
      cwd: str(r.cwd),
      status: str(r.status),
      tmux: str(r.tmux),
      name: str(r.name),
      nameSource: str(r.nameSource),
      entrypoint: str(r.entrypoint),
      version: str(r.version),
      startedAt: msDate(r.startedAt),
      updatedAt: msDate(r.updatedAt),
      messagingSocketPath: str(r.messagingSocketPath),
      kind: str(r.kind),
      jobId: str(r.jobId),
    },
  };
}

/** A job id safe to pass to `claude attach` and to match in tmux output: no spaces, no leading dash. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The job id of a live Claude Code background job (registry `kind: "bg"` with a `jobId`, e.g.
 * `{"kind":"bg","jobId":"e3650501",...}`, measured 2026-11-11), else null. The only place that
 * reads `kind`: callers ask this instead of comparing strings themselves.
 */
export function backgroundJobId(session: Pick<LiveSession, 'kind' | 'jobId'>): string | null {
  if (session.kind !== 'bg' || session.jobId === null) return null;
  return JOB_ID.test(session.jobId) ? session.jobId : null;
}
```
**Impact:** additive. No other code builds a `LiveSession` literal (checked: only `parseLiveEntry`),
so nothing else needs the new fields. Phase 5 reads `kind`/`jobId` through `backgroundJobId`.

### Step 2: Resume types — `attached`, `LiveEntry.jobId`, `ResumeResult` as a union
**File:** `src/sessions/resume.ts:43`, `:69-84`
**Change:** replace `ResumeAction`, `LiveEntry` and `ResumeResult`. `ResumeResult` becomes a union
so `prompt_delivered` and a required `job_id` can only appear on `attached`, and `cwd` /
`original_cwd` only on `resumed` / `spawned`. `jobId` is optional on `LiveEntry` so every existing
`{ pid, tmux }` literal (tests, callers) still means "not a background job".
**Code:**
```ts
export type ResumeAction = 'focused' | 'messaged' | 'resumed' | 'spawned' | 'attached';
```
```ts
/** A live registry entry for the node's session on this host. */
export interface LiveEntry {
  pid: number;
  /** Registry `tmux` field, e.g. "note:@0.%7"; null when the session is not in tmux. */
  tmux: string | null;
  /**
   * Set only when the session is a live Claude Code background job: the id `claude attach` takes
   * (built with registry.ts `backgroundJobId`). Absent or null: not a background job.
   */
  jobId?: string | null;
}

/** What a successful resume did. `job_id` names the background job when the pane is its attach pane. */
export type ResumeResult =
  | {
      action: 'focused' | 'messaged';
      /** "<tmux session>:<window index>" the session is in. */
      window?: string;
      job_id?: string;
    }
  | {
      action: 'resumed' | 'spawned';
      window?: string;
      /** The directory claude runs in. */
      cwd?: string;
      /** Present only when the node's own cwd is gone and `cwd` is a fallback. */
      original_cwd?: string;
    }
  | {
      /** A live background job had no attach pane: a new window runs `claude attach <job_id>`. */
      action: 'attached';
      job_id: string;
      window?: string;
      /** Present (always false) when a prompt was given: the new attach window cannot take it yet. */
      prompt_delivered?: false;
    };
```
**Impact:** type-only for existing callers. `tests/unit/sessions/sessionResumeRoute.test.ts` and
`sessionResumeTool.test.ts` build `{ action: 'resumed', window, cwd }` / `{ action: 'messaged', window }`
literals, which fit the union unchanged.

### Step 3: Attach-pane lookup helpers
**File:** `src/sessions/resume.ts`, insert after `messagePane` (ends :410), before `resolveCwd` (:412).
`RecentSpawns` (:443) is a type alias, so referencing it above its declaration is fine in TS.
**Change:** one `list-panes -a` call that returns pane ids with their start commands. A pane
attaches to job J when its command has the word `attach` followed by `J`. Measured on tmux 3.4
(private `-L` socket): `new-window ... env -u FOO PATH=/usr/bin sh -c 'sleep 30' attach e3650501`
lists as `%1 env -u FOO PATH=/usr/bin sh -c "sleep 30" attach e3650501` (words joined by spaces,
a word holding a space is double-quoted). The pane this resumer opened (kept in `recent` under
`attach:<jobId>`) wins while it is still listed and its command is empty or matches; otherwise the
first matching pane wins, which also finds an attach window the user opened by hand.
**Code:**
```ts
/** `list-panes -a` format for the attach lookup: the pane id, then the command the pane started with. */
export const PANE_COMMAND_FORMAT = '#{pane_id} #{pane_start_command}';

/** RecentSpawns key of a background job's attach pane (session ids are uuids, so this cannot collide). */
export function attachKey(jobId: string): string {
  return `attach:${jobId}`;
}

/**
 * True when a pane's `#{pane_start_command}` runs `... attach <jobId>`: some word is `attach` and
 * the next word is the job id. tmux joins the words with spaces and double-quotes a word that holds
 * a space (tmux 3.4: `env -u FOO PATH=/usr/bin sh -c "sleep 30" attach e3650501`).
 */
export function isAttachCommand(command: string, jobId: string): boolean {
  const words = command
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^"(.*)"$/, '$1'));
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (words[i] === 'attach' && words[i + 1] === jobId) return true;
  }
  return false;
}

/** `list-panes -a -F PANE_COMMAND_FORMAT` output -> pane id and start command, in listed order. */
export function parsePaneCommands(stdout: string): Array<{ paneId: string; command: string }> {
  const out: Array<{ paneId: string; command: string }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line.startsWith('%')) continue;
    const sp = line.indexOf(' ');
    out.push(sp < 0 ? { paneId: line, command: '' } : { paneId: line.slice(0, sp), command: line.slice(sp + 1) });
  }
  return out;
}

/**
 * The live pane attached to background job `jobId`, or null. The pane this resumer opened for it
 * comes first while tmux still lists it (and its command is empty or still the attach); else the
 * first pane started as `... attach <jobId>`. One tmux call; no tmux server means no pane.
 */
export async function findAttachPane(deps: ResumeDeps, jobId: string, recent: RecentSpawns): Promise<string | null> {
  let panes: Array<{ paneId: string; command: string }>;
  try {
    panes = parsePaneCommands(await tmux(deps, ['list-panes', '-a', '-F', PANE_COMMAND_FORMAT]));
  } catch {
    return null;
  }
  const key = attachKey(jobId);
  const opened = recent.get(key)?.paneId;
  if (opened !== undefined) {
    const listed = panes.find((p) => p.paneId === opened);
    if (listed !== undefined && (listed.command === '' || isAttachCommand(listed.command, jobId))) return opened;
    recent.delete(key);
  }
  return panes.find((p) => isAttachCommand(p.command, jobId))?.paneId ?? null;
}
```
**Impact:** new exports only.

### Step 4: One window opener for resume, fresh and attach
**File:** `src/sessions/resume.ts`, insert right before `/** Pane of a session spawned moments ago ...` (:442).
**Change:** the new-window + tmux global PATH + switch-client sequence currently inlined in
`resumeNode` (:505-530) becomes one helper, so the attach window gets the same PATH fix
(`ec68ba6`) without copying it. Call order and argv stay byte-identical to today
(`show-environment`, `new-window`, `switch-client`; env `PATH=` first, then `extraEnv`).
**Code:**
```ts
/**
 * A new window in tmux session `session` at `cwd`, named `name`, running claude with `claudeArgs`,
 * tmux's global PATH and `extraEnv`; shown on the most recently active client.
 */
async function openClaudeWindow(
  deps: ResumeDeps,
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
**Impact:** internal; covered by the existing `resumeNode` tests (`not live`, `tmux's global PATH`,
`fresh`, `NOTESD_TMUX_SOCKET`), which must stay green unchanged.

### Step 5: `liveTarget` and `resumeNode` take the job path
**File:** `src/sessions/resume.ts:445-540` (replace `LiveTarget`, `liveTarget`, `ok`, `resumeNode`)
**Change:** a live entry whose registry pane is not reachable is a `job` target when it carries a
`jobId`, else `outside` (409 as today). A job with an attach pane is focused / messaged like any
pane (plus `job_id`); a job without one gets a new `claude attach <jobId>` window (409 `no_tmux`
without a tmux server). A prompt for a job without an attach pane is not typed anywhere: the window
just started, so it answers `prompt_delivered: false`. `fresh` keeps today's path for every node.
**Code:**
```ts
type LiveTarget =
  | { kind: 'none' }
  | { kind: 'pane'; paneId: string }
  | { kind: 'outside'; pid: number }
  | { kind: 'job'; jobId: string; paneId: string | null };

async function liveTarget(deps: ResumeDeps, node: ResumeNode, recent: RecentSpawns): Promise<LiveTarget> {
  const entry = await deps.live(node.sessionId);
  if (entry !== null) {
    const paneId = entry.tmux !== null ? (parseRegistryTmux(entry.tmux)?.paneId ?? null) : null;
    if (paneId !== null && (await paneAlive(deps, paneId))) return { kind: 'pane', paneId };
    const jobId = entry.jobId ?? null;
    if (jobId !== null) return { kind: 'job', jobId, paneId: await findAttachPane(deps, jobId, recent) };
    return { kind: 'outside', pid: entry.pid };
  }
  const spawned = recent.get(node.sessionId);
  if (spawned !== undefined) {
    if (deps.now() - spawned.at < RECENT_SPAWN_MS && (await paneAlive(deps, spawned.paneId))) {
      return { kind: 'pane', paneId: spawned.paneId };
    }
    recent.delete(node.sessionId);
  }
  return { kind: 'none' };
}

function ok(body: ResumeResult): ResumeOutcome {
  return { status: 200, body };
}

/**
 * The whole decision for one node:
 * other host -> 404 not_on_this_machine (no tmux call at all);
 * not fresh and live in a reachable pane (its registry pane, or a background job's attach pane)
 *   -> focus it (and message it with a prompt);
 * not fresh, a live background job with no attach pane -> a new window running
 *   `claude attach <jobId>`, answer attached (+ prompt_delivered false when a prompt was given);
 * not fresh and live elsewhere -> 409 live_outside_tmux (never resume twice);
 * otherwise a new window in the most recently attached tmux session (409 no_tmux without one):
 * `claude --resume <sid> [prompt]`, or with fresh a new claude whose first prompt is the node's context.
 */
export async function resumeNode(
  deps: ResumeDeps,
  node: ResumeNode,
  req: ResumeRequest,
  recent: RecentSpawns = new Map(),
): Promise<ResumeOutcome> {
  if (node.host !== deps.host) return { status: 404, body: { error: 'not_on_this_machine', host: node.host } };
  const trimmed = req.prompt?.trim();
  const prompt = trimmed === undefined || trimmed === '' ? undefined : clipUtf8(trimmed, TMUX_TEXT_MAX_BYTES);
  const fresh = req.fresh === true;
  try {
    if (!fresh) {
      const target = await liveTarget(deps, node, recent);
      if (target.kind === 'outside') return { status: 409, body: { error: 'live_outside_tmux', pid: target.pid } };
      const paneId = target.kind === 'pane' || target.kind === 'job' ? target.paneId : null;
      const job = target.kind === 'job' ? { job_id: target.jobId } : {};
      if (paneId !== null) {
        await focusPane(deps, paneId);
        const window = await windowLabel(deps, paneId);
        const where = window !== null ? { window } : {};
        if (prompt !== undefined) {
          await messagePane(deps, paneId, prompt);
          return ok({ action: 'messaged', ...where, ...job });
        }
        return ok({ action: 'focused', ...where, ...job });
      }
      if (target.kind === 'job') {
        const session = await pickTmuxSession(deps);
        if (session === null) return { status: 409, body: { error: 'no_tmux' } };
        const place = await resolveCwd(deps, node);
        const created = await openClaudeWindow(deps, session, place.cwd, windowName(node, false), ['attach', target.jobId]);
        if (created.paneId !== null) recent.set(attachKey(target.jobId), { at: deps.now(), paneId: created.paneId });
        return ok({
          action: 'attached',
          job_id: target.jobId,
          ...(created.window !== '' ? { window: created.window } : {}),
          ...(prompt !== undefined ? { prompt_delivered: false as const } : {}),
        });
      }
    }

    const session = await pickTmuxSession(deps);
    if (session === null) return { status: 409, body: { error: 'no_tmux' } };
    const place = await resolveCwd(deps, node);
    const created = fresh
      ? await openClaudeWindow(deps, session, place.cwd, windowName(node, true), promptArgs(freshPrompt(node, prompt)), {
          CC_PARENT_SESSION: node.sessionId,
        })
      : await openClaudeWindow(deps, session, place.cwd, windowName(node, false), [
          '--resume',
          node.sessionId,
          ...promptArgs(prompt),
        ]);
    if (!fresh && created.paneId !== null) recent.set(node.sessionId, { at: deps.now(), paneId: created.paneId });
    return ok({
      action: fresh ? 'spawned' : 'resumed',
      ...(created.window !== '' ? { window: created.window } : {}),
      cwd: place.cwd,
      ...(place.missing && node.cwd !== null ? { original_cwd: node.cwd } : {}),
    });
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: errorMessage(err) } };
  }
}
```
Note: the old local `const path = await tmuxGlobalPath(deps)` (which shadowed the `path` import)
goes away with this step.
**Impact:** behavior changes only for a live entry with a `jobId`. With no `jobId` every path makes
the same tmux calls in the same order as before. Run
`npx vitest run tests/unit/sessions/resume.test.ts` now: the existing tests must pass unchanged
before step 9 adds the new ones.

### Step 6: Route boundary maps the registry to `LiveEntry`
**File:** `src/http/sessionResume.ts:6`, `:8-15`, after `:36`, `:53-56`, `:76-81`
**Change:** extract the registry lookup into an exported `registryLive` (testable with an injected
registry dir and pid check), which sets `jobId` through `backgroundJobId`. `defaultSessionResumer`
uses it. Update the route's doc comment.
**Code:** imports (replace lines 6 and 8-15):
```ts
import { backgroundJobId, readLiveSessions, type PidAliveCheck } from '../sessions/registry.js';
```
```ts
import {
  createSessionResumer,
  defaultResumeDeps,
  RESUME_PROMPT_MAX_CHARS,
  toResumeNode,
  type ResumeDeps,
  type ResumeNode,
  type SessionResumer,
} from '../sessions/resume.js';
```
New function, after `sessionLookup` (:36):
```ts
/**
 * ResumeDeps.live from Claude Code's registry under `claudeHome`: the pid, the tmux pane, and the
 * job id when the session is a live background job (`kind: "bg"`). `isAlive` is for tests.
 */
export function registryLive(claudeHome: string, isAlive?: PidAliveCheck): ResumeDeps['live'] {
  return async (sessionId) => {
    const entry = (await readLiveSessions(claudeHome, isAlive)).find((s) => s.sessionId === sessionId);
    return entry === undefined ? null : { pid: entry.pid, tmux: entry.tmux, jobId: backgroundJobId(entry) };
  };
}
```
`defaultSessionResumer` (replace :39-63):
```ts
/** The daemon's resumer: cc_sessions via SessionsRepo, live status via the registry, real tmux. */
export function defaultSessionResumer(deps: AppDeps): SessionResumer {
  let sessions: SessionsRepo | undefined;
  const repo = (): SessionsRepo => {
    sessions ??= new SessionsRepo(deps.db);
    return sessions;
  };
  const host = os.hostname();
  return createSessionResumer({
    normalize: normalizeNodeId,
    lookup: (nodeId) => sessionLookup(repo())(nodeId),
    deps: () =>
      defaultResumeDeps({
        claudeBin: deps.config.chat.claudeBin,
        worktreesDir: deps.config.sessions.worktreesDir,
        live: registryLive(deps.config.sessions.claudeHome),
        repoCwds: async (name) =>
          (await repo().listForRepo(name, { limit: 200 }))
            .filter((item) => item.host === host && item.cwd !== null)
            .map((item) => item.cwd as string),
      }),
  });
}
```
Route doc comment (replace :76-81):
```ts
/**
 * POST /api/sessions/:nodeId/resume {prompt?, fresh?} (own Origin only)
 * -> 200 {action: focused|messaged|resumed|spawned|attached, window?, cwd?, original_cwd?, job_id?, prompt_delivered?}
 *    (attached: a live background job got a new `claude attach <job_id>` window; prompt_delivered:false
 *    when a prompt was given, since that window cannot take it yet)
 * | 404 not_found | 404 not_on_this_machine {host} | 409 no_tmux | 409 live_outside_tmux {pid}
 * | 500 spawn_failed {message} | 400 invalid_json | 400 invalid_body {message} | 403 forbidden_origin.
 */
```
**Impact:** `readLiveSessions` was already called per resume (no cache); unchanged cost.

### Step 7: MCP `session_resume` — description and `attached` text
**File:** `src/mcp/sessionTools.ts:276-292` (`resumeToolResult`), `:300` (description)
**Change:** for `attached`, the tool answers the JSON plus a sentence that names
`claude attach <jobId>` and, when a prompt was given, says it was not delivered and how to deliver
it (call again: the attach pane is then alive and the prompt is typed into it). The description
mentions background jobs. Nothing else in the file changes (phase 5 owns the other tools' text).
**Code:** replace `resumeToolResult` and add `attachedText` above it:
```ts
type AttachedResult = Extract<ResumeResult, { action: 'attached' }>;

/** The sentence after an `attached` answer: where the job is attached, and an undelivered prompt. */
function attachedText(r: AttachedResult, nodeId: string): string {
  const where = r.window !== undefined ? ` in tmux window ${r.window}` : '';
  const head = `${nodeId} is running as a Claude Code background job; opened \`claude attach ${r.job_id}\`${where}.`;
  if (r.prompt_delivered !== false) return head;
  return `${head} The prompt was not delivered: a background job takes input only through its attach window. Call session_resume again with the prompt once that window is up (it is then typed into it), or type it there yourself.`;
}

/** ResumeOutcome -> the tool's answer: the JSON result on success, a "<code>: <what to do>" error otherwise. */
export function resumeToolResult(out: ResumeOutcome, nodeId: string): CallToolResult {
  if (out.status === 200) {
    const result = out.body;
    if (result.action !== 'attached') return jsonResult(result);
    return { content: [...jsonResult(result).content, { type: 'text', text: attachedText(result, nodeId) }] };
  }
  const body = out.body;
  switch (body.error) {
    case 'not_found':
      return fail(`not_found: no session with node id ${nodeId}`);
    case 'not_on_this_machine':
      return fail(`not_on_this_machine: session ${nodeId} ran on ${body.host}; resume it on that machine`);
    case 'no_tmux':
      return fail('no_tmux: no tmux server is running on this machine, so there is nowhere to open the session');
    case 'live_outside_tmux':
      return fail(`live_outside_tmux: session ${nodeId} is already running (pid ${body.pid}) outside tmux; switch to its terminal`);
    case 'spawn_failed':
      return fail(`spawn_failed: ${body.message}`);
  }
}
```
Import change (line 5):
```ts
import { RESUME_PROMPT_MAX_CHARS, type ResumeOutcome, type ResumeResult } from '../sessions/resume.js';
```
New description string (line 300):
```ts
        "Open a Claude Code session from the session graph in the user's tmux, on this machine. node_id is a session node id like A0-3G (two characters, a dash, two characters; not a note id). If that session is already running, its tmux window is focused and prompt (if given) is typed into it; it is never resumed twice. If it is running as a Claude Code background job (claude --bg, a forked job), its attach window is focused (prompt typed into it), or, when none is open, a new window runs `claude attach <job>` and the answer is action attached with job_id; a prompt given then is not delivered (prompt_delivered: false), so call again with it once the window is up. Otherwise a new window in the most recently attached tmux session runs `claude --resume <session> [prompt]` in the session's directory; if that directory is gone (a removed worktree) it runs from the repository checkout and returns original_cwd. fresh=true starts a new session whose first prompt is this node's summary, commits and plan docs (plus prompt) instead of resuming. A session whose transcript lives on the other machine answers not_on_this_machine. Returns { action: focused | messaged | resumed | spawned | attached, window, job_id? }.",
```
**Impact:** a client that reads only `content[0]` still gets the JSON.

### Step 8: Registry tests
**File:** `tests/unit/sessions/registry.test.ts` — import line :4, append a describe at the end (:99)
**Code:** import:
```ts
import { backgroundJobId, createLiveRegistry, isPidAlive, parseLiveEntry, readLiveRegistry, readLiveSessions } from '../../../src/sessions/registry.js';
```
Append:
```ts
describe('background jobs in the registry', () => {
  it('parseLiveEntry keeps kind and jobId (the measured background-job entry)', () => {
    const entry = parseLiveEntry({
      pid: 3318108,
      sessionId: 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8',
      kind: 'bg',
      jobId: 'e3650501',
      messagingSocketPath: '/run/user/1000/cc-socks/3318108.sock',
    });
    expect(entry?.session).toMatchObject({ kind: 'bg', jobId: 'e3650501', tmux: null });
    expect(parseLiveEntry({ pid: 1, sessionId: 'x' })?.session).toMatchObject({ kind: null, jobId: null });
  });

  it('backgroundJobId is the job id only for kind bg with a plain id', () => {
    expect(backgroundJobId({ kind: 'bg', jobId: 'e3650501' })).toBe('e3650501');
    expect(backgroundJobId({ kind: 'interactive', jobId: 'e3650501' })).toBeNull();
    expect(backgroundJobId({ kind: null, jobId: 'e3650501' })).toBeNull();
    expect(backgroundJobId({ kind: 'bg', jobId: null })).toBeNull();
    expect(backgroundJobId({ kind: 'bg', jobId: 'a b' })).toBeNull();
    expect(backgroundJobId({ kind: 'bg', jobId: '-rf' })).toBeNull();
  });
});
```

### Step 9: Resume decision tests (fake `CommandRunner`)
**File:** `tests/unit/sessions/resume.test.ts` — import block :2-24, append a describe after the
`resumeNode` describe (after :329, before `describe('resolveCwd (deleted worktree)'`)
**Code:** add to the import list from `../../../src/sessions/resume.js`:
```ts
  isAttachCommand,
  PANE_COMMAND_FORMAT,
  parsePaneCommands,
```
(keep alphabetical-ish placement next to the existing names; `type LiveEntry` is already imported).
Append:
```ts
describe('background jobs (registry kind "bg")', () => {
  const JOB = 'e3650501';
  const bgEntry: LiveEntry = { pid: 3318108, tmux: null, jobId: JOB };

  /** A tmux whose pane list grows when a window opens, with each pane's start command, like the real server. */
  function jobTmux(initial: string[] = ['%1 -zsh']) {
    const panes = [...initial];
    const t = fakeTmux({
      'list-panes': (a) =>
        a.includes(PANE_COMMAND_FORMAT)
          ? `${panes.join('\n')}\n`
          : `${panes.map((p) => p.split(' ')[0]).join('\n')}\n`,
      'new-window': (a) => {
        const id = `%${12 + panes.length - initial.length}`;
        panes.push(`${id} ${a.slice(a.indexOf(NEW_WINDOW_FORMAT) + 1).join(' ')}`);
        return `note:3 ${id}\n`;
      },
    });
    return { ...t, panes };
  }

  it('isAttachCommand reads the command line tmux prints for a pane (tmux 3.4)', () => {
    expect(isAttachCommand('env -u FOO PATH=/usr/bin sh -c "sleep 30" attach e3650501', JOB)).toBe(true);
    expect(isAttachCommand(`/opt/claude/claude.exe attach "${JOB}"`, JOB)).toBe(true);
    expect(isAttachCommand('claude attach 3fa61d8c', JOB)).toBe(false);
    expect(isAttachCommand(`claude --resume ${JOB}`, JOB)).toBe(false);
    expect(isAttachCommand('', JOB)).toBe(false);
    expect(parsePaneCommands('%1 -zsh\n%9\n\njunk\n')).toEqual([
      { paneId: '%1', command: '-zsh' },
      { paneId: '%9', command: '' },
    ]);
  });

  it('R3.1: no attach pane -> a new window runs claude attach <jobId>; answer attached', async () => {
    const t = jobTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'attached', job_id: JOB, window: 'note:3' } });
    expect(t.sub('new-window')).toEqual([
      newWindowArgv('/home/u/mcp-notes', 'impl-x-p1', claudeCommand(CLAUDE, ['attach', JOB])),
    ]);
    expect(t.sub('switch-client')).toEqual([['switch-client', '-c', '/dev/pts/2', '-t', '%12']]);
    expect(t.sub('select-window')).toEqual([]);
  });

  it("R3.1: the attach window gets tmux's global PATH, like a resume", async () => {
    const t = fakeTmux({ 'show-environment': () => 'PATH=/opt/nvim/bin:/usr/bin\n' });
    await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), {});
    expect(t.sub('new-window')[0]!.slice(-4)).toEqual(['PATH=/opt/nvim/bin:/usr/bin', CLAUDE, 'attach', JOB]);
  });

  it('R3.2: asked again while its attach pane is alive -> focus it, type a prompt into it, never a second window', async () => {
    const t = jobTmux();
    const r = createSessionResumer({
      normalize: () => 'A0-3G',
      lookup: async () => node(),
      deps: makeDeps(t.run, { liveEntry: bgEntry }),
    });
    expect((await r.resume('A0-3G', {})).body).toEqual({ action: 'attached', job_id: JOB, window: 'note:3' });
    expect(await r.resume('A0-3G', {})).toEqual({
      status: 200,
      body: { action: 'focused', window: 'note:1', job_id: JOB },
    });
    expect(t.sub('select-pane')).toEqual([['select-pane', '-t', '%12']]);
    expect(await r.resume('A0-3G', { prompt: 'status?' })).toEqual({
      status: 200,
      body: { action: 'messaged', window: 'note:1', job_id: JOB },
    });
    const [set] = t.sub('set-buffer');
    expect(set!.slice(3)).toEqual(['--', 'status?']);
    expect(t.sub('paste-buffer')[0]!.slice(-2)).toEqual(['-t', '%12']);
    expect(t.sub('new-window')).toHaveLength(1);
  });

  it('R3.2: an attach window the user opened by hand is found by its command and focused', async () => {
    const t = jobTmux(['%1 -zsh', `%9 claude attach ${JOB}`]);
    const out = await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), {});
    expect(out).toEqual({ status: 200, body: { action: 'focused', window: 'note:1', job_id: JOB } });
    expect(t.sub('select-pane')).toEqual([['select-pane', '-t', '%9']]);
    expect(t.sub('new-window')).toEqual([]);
  });

  it('R3.2: once the attach pane is gone, the next ask opens a new one', async () => {
    const t = jobTmux();
    const r = createSessionResumer({
      normalize: () => 'A0-3G',
      lookup: async () => node(),
      deps: makeDeps(t.run, { liveEntry: bgEntry }),
    });
    await r.resume('A0-3G', {});
    t.panes.splice(1); // the user closed the attach window
    expect((await r.resume('A0-3G', {})).body).toMatchObject({ action: 'attached', job_id: JOB });
    expect(t.sub('new-window')).toHaveLength(2);
  });

  it('R3.3: a prompt with no attach pane opens the window and answers prompt_delivered false; nothing is typed', async () => {
    const t = jobTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), { prompt: 'run the tests' });
    expect(out).toEqual({
      status: 200,
      body: { action: 'attached', job_id: JOB, window: 'note:3', prompt_delivered: false },
    });
    expect(t.sub('new-window')[0]!.slice(-2)).toEqual(['attach', JOB]);
    expect(t.sub('set-buffer')).toEqual([]);
    expect(t.sub('paste-buffer')).toEqual([]);
  });

  it('R3.4: live outside tmux and not a background job still answers 409 live_outside_tmux', async () => {
    const t = jobTmux();
    const entries: LiveEntry[] = [
      { pid: 42, tmux: null },
      { pid: 42, tmux: null, jobId: null },
    ];
    for (const entry of entries) {
      expect(await resumeNode(makeDeps(t.run, { liveEntry: entry }), node(), {})).toEqual({
        status: 409,
        body: { error: 'live_outside_tmux', pid: 42 },
      });
    }
    expect(t.sub('new-window')).toEqual([]);
    expect(t.calls.some((c) => c.includes(PANE_COMMAND_FORMAT))).toBe(false);
  });

  it('a background job with no tmux server answers 409 no_tmux', async () => {
    const down = () => {
      throw new Error('no server running on /tmp/tmux-1000/default');
    };
    const t = fakeTmux({ 'list-sessions': down, 'list-panes': down });
    expect(await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), {})).toEqual({
      status: 409,
      body: { error: 'no_tmux' },
    });
  });

  it('fresh on a live background job still spawns a new session with the node context', async () => {
    const t = jobTmux();
    const out = await resumeNode(makeDeps(t.run, { liveEntry: bgEntry }), node(), { fresh: true });
    expect(out.body).toMatchObject({ action: 'spawned' });
    expect(t.sub('new-window')[0]).toContain(`CC_PARENT_SESSION=${SID}`);
  });
});
```

### Step 10: Route and MCP tests
**File:** `tests/unit/sessions/sessionResumeRoute.test.ts` — imports :1-4, `it.each` table :61-67, append a describe at the end (:74)
**Code:** imports become:
```ts
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../../src/deps.js';
import { registryLive, sessionResumeRoutes } from '../../../src/http/sessionResume.js';
import type { ResumeOutcome, ResumeRequest, SessionResumer } from '../../../src/sessions/resume.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';
```
Add a row to the `it.each` table (first row):
```ts
    [{ status: 200, body: { action: 'attached', job_id: 'e3650501', window: 'note:5', prompt_delivered: false } }],
```
Append:
```ts
describe('registryLive (registry -> LiveEntry)', () => {
  it('gives a live background job its jobId, and an interactive session none', async () => {
    const home = await copyFixtureClaudeHome();
    try {
      const sid = 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8';
      await writeFile(
        path.join(home, 'sessions', '3318108.json'),
        JSON.stringify({
          pid: 3318108,
          sessionId: sid,
          kind: 'bg',
          jobId: 'e3650501',
          messagingSocketPath: '/run/user/1000/cc-socks/3318108.sock',
          updatedAt: 1793585600000,
        }),
      );
      const live = registryLive(home, (pid) => pid === 4242 || pid === 3318108);
      expect(await live(sid)).toEqual({ pid: 3318108, tmux: null, jobId: 'e3650501' });
      expect(await live(FIXTURE.main)).toEqual({ pid: 4242, tmux: 'note:@0.%7', jobId: null });
      expect(await live('not-live')).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
```
**File:** `tests/unit/sessions/sessionResumeTool.test.ts` — insert before the `without a resumer` test (:52)
**Code:**
```ts
  it('attached: the JSON, then a sentence naming claude attach <jobId> and the undelivered prompt', async () => {
    const { client, close } = await connect({
      resume: async () => ({
        status: 200,
        body: { action: 'attached', job_id: 'e3650501', window: 'note:5', prompt_delivered: false },
      }),
    });
    const res = await client.callTool({ name: 'session_resume', arguments: { node_id: 'JM-UJ', prompt: 'go' } });
    expect(res.isError).toBeFalsy();
    const content = (res as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0]!.text)).toEqual({
      action: 'attached',
      job_id: 'e3650501',
      window: 'note:5',
      prompt_delivered: false,
    });
    expect(content[1]!.text).toContain('claude attach e3650501');
    expect(content[1]!.text).toContain('not delivered');
    await close();
  });
```

### Step 11: README
**File:** `README.md:716-728`, `:1063`, `:1153`
**Change:** insert a paragraph after the first "Resume from the wall" paragraph (after :722, before
"`claude --resume` finds a transcript…" at :724):
```markdown
A session that is running as a Claude Code background job (`claude --bg`, or a fork started from
the agent view) has no terminal of its own. Resume opens a tmux window running
`claude attach <job>` for it and answers `attached` with the `job_id`; pressing it again focuses
that window, and a prompt is typed into it. A prompt given while no attach window is open cannot
be delivered yet, and the answer says so (`prompt_delivered: false`). A live session outside tmux
that is not a background job still answers `live_outside_tmux`: switch to its terminal.
```
MCP table row (:1063):
```markdown
| `session_resume` | Open a session again in a new tmux window (`claude --resume`), with an optional first `prompt`, or switch to it when it is still running. A live background job opens or focuses a `claude attach <job>` window (`attached`). Same machine only |
```
HTTP table row (:1153):
```markdown
| `POST /api/sessions/:nodeId/resume` | `{prompt?, fresh?}`: resume (or start fresh from) a session in a new tmux window, or switch to it when it is live. A live background job gets a `claude attach <job>` window: `action: "attached"`, `job_id`, and `prompt_delivered: false` when a prompt could not be typed yet. Reports `original_cwd` when the session's directory is gone and a fallback was used. 404 `not_on_this_machine` for the other machine's sessions. Same-origin only |
```

### Step 12: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md:6` and a new section before `## Gotchas` (:222)
**Change:** line 6 becomes:
```markdown
- Session search, usage (tokens), transcript (owning host only), resume (real tmux NOT driven here; background-job attach driven with a fake tmux, below).
```
Insert before `## Gotchas`:
````markdown
## Resume of a live background job (fake tmux)
A session live as a Claude Code background job (registry `kind: "bg"`, `jobId`) resumes by opening
a tmux window running `claude attach <jobId>` (`action: "attached"`, `job_id`), then focuses that
pane on the next ask (`focused`/`messaged` + `job_id`). A prompt with no attach pane answers
`prompt_delivered: false`. A live non-background session outside tmux stays 409 `live_outside_tmux`.

Never run real tmux or claude from a verify run. Point `NOTESD_TMUX_BIN` at a fake that logs argv
and keeps a pane list, and `NOTESD_CLAUDE_BIN` nowhere; `up` passes the caller's env through:
```sh
F=$SCRATCH/faketmux; mkdir -p $F && : >$F/panes && : >$F/calls.log
cat >$F/tmux <<'EOF'
#!/usr/bin/env bash
D="${FAKE_TMUX_DIR:?}"; printf '%s\n' "$*" >>"$D/calls.log"
[ "$1" = -S ] && shift 2
case "$1" in
  list-sessions) echo "100 note" ;;
  list-clients) echo "1 /dev/pts/9" ;;
  show-environment) echo "PATH=/usr/bin:/bin" ;;
  list-panes) if [[ "$*" == *pane_start_command* ]]; then cat "$D/panes"; else cut -d' ' -f1 "$D/panes"; fi ;;
  new-window) n="%$(( 50 + $(wc -l <"$D/panes") ))"; while [ "$#" -gt 0 ] && [ "$1" != "-F" ]; do shift; done; shift 2
              echo "$n $*" >>"$D/panes"; echo "note:5 $n" ;;
  display-message) if [[ "$*" == *pane_in_mode* ]]; then echo 0; else echo note:5; fi ;;
esac
EOF
chmod +x $F/tmux
FAKE_TMUX_DIR=$F NOTESD_TMUX_BIN=$F/tmux NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
sleep 600 & JOBPID=$!     # stands in for the background job's process (pid must be alive)
SID=5e55a001-0000-4000-8000-000000000005
NODE=$($V sql RUN "select node_id from cc_sessions where session_id='$SID'" | grep -oE '[0-9A-Z]{2}-[0-9A-Z]{2}' | head -1)
echo "{\"pid\":$JOBPID,\"sessionId\":\"$SID\",\"kind\":\"bg\",\"jobId\":\"5e55a001\",\"updatedAt\":9999999999999}" \
  >~/.local/state/notesd-verify/RUN/claude/sessions/$JOBPID.json
$V api RUN POST /api/sessions/$NODE/resume '{}'            # attached, job_id 5e55a001; panes gains "%50 ... attach 5e55a001"
$V api RUN POST /api/sessions/$NODE/resume '{"prompt":"hi"}'  # messaged, job_id; calls.log: paste-buffer ... -t %50
```
`kill $JOBPID` afterwards. The same flow is unit-tested in `tests/unit/sessions/resume.test.ts`
(`background jobs`).
````

## Principles applied

- Boundary discipline: registry JSON is turned into "is this a background job, and with which id" once, in `registry.ts` `backgroundJobId` (validating the id against `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` because it becomes a `claude` argv word and a tmux-output token); `resume.ts` never reads `kind`, it trusts `LiveEntry.jobId`. Phase 5 is pointed at the same function.
- Make illegal states unrepresentable: `ResumeResult` became a union on `action`, so `prompt_delivered` and a required `job_id` exist only on `attached` and `cwd`/`original_cwd` only on `resumed`/`spawned`; `LiveEntry` got one `jobId` (null = not a job) instead of a `kind` + `jobId` pair that could disagree.
- Laziness protocol: no messaging-socket client, no new error code, no new dependency; the attach lookup is one `list-panes` call reusing the existing `recent` map, and the tmux-PATH/new-window/switch-client sequence was extracted into `openClaudeWindow` and reused rather than copied into an attach branch.
- Prove it works: besides fake-runner unit tests, the Proof drives the real daemon's HTTP route and MCP tool with a fake `NOTESD_TMUX_BIN`, so the registry read, route mapping and tool text are exercised end to end without touching real tmux.
- Test behavior, not implementation: the new tests assert the outcome body and the tmux commands a real server would receive (argv of `new-window`, the pane targeted by `select-pane`/`paste-buffer`), with a fake tmux whose pane list grows like the real one; they do not mock `resumeNode`'s internals.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-fork-awareness && npm run typecheck`
**Tests:** `npm test` (and focused: `npx vitest run tests/unit/sessions/resume.test.ts tests/unit/sessions/registry.test.ts tests/unit/sessions/sessionResumeRoute.test.ts tests/unit/sessions/sessionResumeTool.test.ts`). No SQL changes, so `test:int` is not required by invariant 1.
**Proof:** the real daemon, with tmux replaced by a logging fake so nothing reaches the user's tmux or spawns claude.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`). Its gotcha "never drive resume" is about real tmux/claude; here `NOTESD_TMUX_BIN` is a fake that execs nothing and `NOTESD_CLAUDE_BIN=/nonexistent/claude`, so driving resume is safe. Setup is exactly the snippet in Step 12 (`features/projects.md`, "Resume of a live background job (fake tmux)"): create `$F/tmux`, `$V up --sessions` with `FAKE_TMUX_DIR=$F NOTESD_TMUX_BIN=$F/tmux NOTESD_CLAUDE_BIN=/nonexistent/claude` in the environment, start `sleep 600 & JOBPID=$!`, read `NODE` for session `5e55a001-0000-4000-8000-000000000005` with `$V sql`, and write the `kind:"bg"`, `jobId:"5e55a001"` registry file into `~/.local/state/notesd-verify/<RUN>/claude/sessions/$JOBPID.json`. Run `$V doctor RUN` before the first drive. `$SCRATCH` is any scratch dir outside the repo.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (new section "Resume of a live background job (fake tmux)")
- Journeys:
  - **J1** · traces R3.1 — `npx vitest run tests/unit/sessions/resume.test.ts -t "R3.1"`, then on the harness `$V api RUN POST /api/sessions/$NODE/resume '{}'` and `cat $F/panes; grep '^new-window' $F/calls.log` → passes when the tests pass, the API answers 200 `{"action":"attached","job_id":"5e55a001","window":"note:5"}`, `calls.log` has exactly one `new-window` line whose argv ends with `PATH=/usr/bin:/bin /nonexistent/claude attach 5e55a001`, and `panes` lists `%50 ... attach 5e55a001`
  - **J2** · traces R3.2 — after J1: `$V api RUN POST /api/sessions/$NODE/resume '{"prompt":"hi"}'`, then `$V mcp RUN session_resume "{\"node_id\":\"$NODE\"}"`, then `grep -c '^new-window' $F/calls.log; grep -E '^(select-pane|paste-buffer)' $F/calls.log`; also `npx vitest run tests/unit/sessions/resume.test.ts -t "R3.2"` → passes when the API answers 200 `{"action":"messaged","window":"note:5","job_id":"5e55a001"}`, the MCP tool returns JSON with `"action": "focused"` and `"job_id": "5e55a001"`, the `new-window` count is still 1, `calls.log` shows `select-pane -t %50` and `paste-buffer -p -d -b notesd-resume-… -t %50`, and the unit tests pass
  - **J3** · traces R3.3 — `B=$(grep -c '^set-buffer' $F/calls.log); : > $F/panes` (the attach window is gone), then `$V mcp RUN session_resume "{\"node_id\":\"$NODE\",\"prompt\":\"run the tests\"}"`, then `grep -c '^set-buffer' $F/calls.log` (compare with `$B`) and `grep '^new-window' $F/calls.log | tail -1`; also `npx vitest run tests/unit/sessions/resume.test.ts -t "R3.3"` and `npx vitest run tests/unit/sessions/sessionResumeTool.test.ts -t "attached"` → passes when the MCP result's first text is JSON `{"action":"attached","job_id":"5e55a001","window":"note:5","prompt_delivered":false}`, its second text contains `claude attach 5e55a001` and `not delivered`, the `set-buffer` count did not grow, a second `new-window` line ends with `attach 5e55a001` (no prompt word after it), and the unit tests pass
  - **J4** · traces R3.4 — rewrite the registry file without background fields: `echo "{\"pid\":$JOBPID,\"sessionId\":\"$SID\",\"kind\":\"interactive\",\"updatedAt\":9999999999999}" > ~/.local/state/notesd-verify/<RUN>/claude/sessions/$JOBPID.json`, then `$V api RUN POST /api/sessions/$NODE/resume '{}'` and `$V mcp RUN session_resume "{\"node_id\":\"$NODE\"}"`; also `npx vitest run tests/unit/sessions/resume.test.ts -t "R3.4"` → passes when the API answers 409 `{"error":"live_outside_tmux","pid":<JOBPID>}`, the MCP tool is an error starting `live_outside_tmux: session <NODE> is already running (pid <JOBPID>) outside tmux`, the `new-window` count in `calls.log` did not grow, and the unit tests pass
- Neighbor check: plain resume of a session that is not live. `kill $JOBPID` (the registry entry is then dead), `$V api RUN POST /api/sessions/$NODE/resume '{}'` → 200 `{"action":"resumed","window":"note:5","cwd":...}` and the newest `new-window` line in `calls.log` ends with `PATH=/usr/bin:/bin /nonexistent/claude --resume 5e55a001-0000-4000-8000-000000000005`; plus every pre-existing test in `tests/unit/sessions/resume.test.ts` passes unchanged. Then `$V down RUN`.
- Cost: none (no LLM turns; `NOTESD_CLAUDE_BIN` points nowhere, so the summary worker cannot bill).
**Exit criteria:** `npm run typecheck` and `npm test` pass; J1–J4 and the neighbor check pass on a verify-notesd run with the fake tmux, with the evidence files under `~/.local/state/notesd-verify/<RUN>/evidence/` plus `$F/calls.log` and `$F/panes` copied into it (`cp $F/calls.log $F/panes ~/.local/state/notesd-verify/<RUN>/evidence/`).

## Handoffs

- **Phase 5 (R4.3):** `formatContext`'s `attach with: claude attach <jobId>` line and `session_get`'s way-back-in text are phase 5's. Use `backgroundJobId(liveSession)` from `src/sessions/registry.ts` (created here) instead of comparing `kind === 'bg'` again; `LiveSession.kind`/`jobId` exist after this phase. `view.ts`'s own `LiveEntry` (:334) and `readModel.ts liveFromRegistry` (:126) are untouched here.
- **Phase 6 (R3.5):** the wall's `resumeNotice` currently falls through to `Resume: attached in note:5` for the new action. Phase 6 owns the notice: read `job_id` and `prompt_delivered` from the 200 body (shape in the Interface Contract above) and say `claude attach <job_id>`; `focused`/`messaged` may also carry `job_id`. No new error code exists for a background job: a live job never answers 409 any more unless tmux is missing (`no_tmux`).
- **README overlap with phase 3:** this phase edits only the "Resume from the wall" section (:716-728) and the `session_resume` / `POST …/resume` table rows (:1063, :1153). Phase 3 owns the sessions/fork paragraph; the reconciler should check the two do not edit the same lines.
- **Feature-map overlap with phase 6:** this phase edits `features/projects.md` line 6 and adds one section before `## Gotchas`; phase 6 adds its fork-graph drive to the same file. Different sections.
- Not done (out of scope per the index's Decisions): messaging a background job through `messagingSocketPath` (needs `CLAUDE_CODE_MESSAGING_TOKEN`); typing a prompt into a just-opened attach window after a delay (it answers `prompt_delivered: false` instead).

## Rollback

Revert this phase's commit. There is no schema or data change: the registry is only read, and the
`recent` map is in memory. After the revert a live background job answers 409 `live_outside_tmux`
again; any attach windows opened meanwhile are ordinary tmux windows the user can close.

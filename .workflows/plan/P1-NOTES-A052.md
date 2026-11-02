> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 4. Source: `.workflows/plan/project-session-graph/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Heuristic parent links from transcripts

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R3 — historical swarm children hang off the session that spawned them, marked `heuristic`
**Depends on:** Phase 3 (and through it Phase 1)
**Difficulty:** NORMAL
**Package:** `src/sessions`

---

## Goal

After this phase, every `cc_sessions` row on this host whose session was started by another
session through `swarm.py spawn|launch` (or was addressed by it with `SendMessage {to: X}`) gets
`parent_session_id` set with `parent_link_source = 'heuristic'`, unless a better source (`env`,
`hook`) or an earlier heuristic link is already there. A one-time backfill scan per host links
everything already on disk once the ingest backfill finishes, and an in-memory live path links
children spawned while the daemon runs, from the records the ingester hands over.

## Measured on this machine (read-only, 2026-11-02) — the facts this plan is built on

All read from `~/.claude/projects/**/*.jsonl` with a throwaway script in the scratchpad; nothing
in `~/.claude` was written.

1. **The brief's example holds.** `cc6491fc-2dc1-4f2d-9d28-db3fbf6baa0a`
   (`agent-name`/`custom-title` `orch-wall-editing`, dir `-home-miftah--worktrees-mcp-notes-wall-editing`,
   first record `2026-10-30T09:16:23.809Z`, `entrypoint: cli`) carries:
   - 8 Bash tool_uses that run `swarm.py spawn` (1 of them `--dry-run`), resolving to the 11
     children `impl-wall-editing-p1` … `-p11`. Every child's first record is **2–4 s after** the
     tool_use timestamp (p1 and p11: intent `09:19:49.264Z`, children `09:19:53.072Z` / `09:19:53.502Z`;
     p3/p5/p6: intent `09:35:45.299Z`, children `09:35:48.0–48.4Z`).
   - 6 `SendMessage` tool_uses with `to: impl-wall-editing-p1|p11|p2|p3|p5|p6`, each **30–40 s
     after** the child started (p3 started `09:35:48.325Z`, message `09:36:25.606Z`).
   - Its own parent, `930c1249…` (`analyze-wall-editing`, cwd `/home/miftah/mcp-notes`), launched
     it at `09:16:21.489Z` with
     `python3 ~/.claude/skills/swarm/swarm.py launch --name "orch-wall-editing" --cwd "$HOME/.worktrees/mcp-notes/wall-editing" …`;
     the orch's first record is 2.3 s later.
2. **Record shapes.** A tool_use lives in an `assistant` record:
   `{"type":"assistant","sessionId","cwd","timestamp","entrypoint","isSidechain",…,"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"…"}}]}}`.
   SendMessage input is `{to, recipient, summary, message|content, type, notify_when_idle?, recipient_kind?}`;
   `to` usually equals `recipient`. 12 of 890 had no `to`; some carry only
   `{"__unparsedToolInput":{"raw":"{\"to\": \"impl-uatp-4258-remaining-p1\", …"}}` (malformed JSON
   in `raw`). `to` values also include agent ids (`ab115fb44e7832cf9`), `uds:/run/user/…sock`
   socket addresses, and parent names (children report up to `orch-*`). None of the 890 was `isSidechain: true`.
3. **Commands are real shell, not one flag line.** Measured forms across 408 commands mentioning
   swarm spawn/launch: `S=~/.claude/skills/swarm/swarm.py; … python3 $S spawn …` (variable
   assigned in the same command), `for n in 1 11; do … --phase $n …; done` and
   `for N in 1 4 5 6; do …`, `--name "quoted"`, `$HOME/…` and `~/…` paths, `\`-newline
   continuations, `read -r -d '' EXTRA <<'EOF' … EOF` heredocs whose bodies quote swarm commands,
   `--dry-run` and `--help` calls, and `report|verify|reap|waves` subcommands that also carry
   `--phase`. A tmux child does not inherit shell state between tool calls, so a `$S` is always
   assigned in the same command string.
4. **Naming rule (`~/claude-commands/skills/swarm/swarm.py`).** `spawn` takes `--slug S --phase N
   [--prefix impl]` (flags, not positionals) and names the child `child_name(prefix, slug, n)`:
   `head = f"{prefix}-{slugify(slug)}"; return head[:MAX_NAME - len(tail)] + tail` with
   `tail = f"-p{n}"`, `MAX_NAME = 60` (`swarm.py:76`, `:534`). `launch --name X` names it
   `slugify(X)` (`:1789`). `slugify` = `re.sub(r"[^A-Za-z0-9._-]+", "-", s.strip()).strip("-.")[:60] or "swarm"` (`:101`).
5. **Names are reused and renamed.** 15 names belong to more than one session (e.g.
   `impl-portfolio-access-grant-p3` ×4 within ~1 h, relaunched with `--force`;
   `orch-honest-control-redraw` ×3 across two days). 46 sessions carry more than one name. So
   name alone is never enough: the time window and the start ordering decide.
6. **Where intents live after Phase 3.** The Phase 1 schema has no column for spawn intents
   (`cc_sessions` stores prompts/commits/files/plan docs, not tool_uses), so the per-session data
   Phase 3 extracts does **not** keep them. Decision: this phase does not add a column or a
   migration (all schema is Phase 1's, by the index). Instead
   - the **backfill** re-reads this host's transcripts once (streamed, line-prefiltered by
     substring before `JSON.parse`), gated by an `app_settings` marker so it never runs twice; and
   - the **live path** takes the parsed records of each ingested batch from Phase 3's ingest
     observer (no second read) and keeps unresolved intents in memory for a bounded time.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `src/sessions/links.ts`:
  - constants `LINKS_BACKFILL_VERSION`, `LINKS_MARKER_PREFIX` (`'sessions.links.backfill.'`),
    `SPAWN_BEFORE_MS`, `SPAWN_AFTER_MS`, `MESSAGE_BEFORE_MS`, `MESSAGE_AFTER_MS`,
    `PENDING_RETAIN_MS`, `PENDING_CAP`, `DEFAULT_LINK_DEBOUNCE_MS`, `DEFAULT_LINK_CLOSE_GRACE_MS`, `SWARM_MAX_NAME`
  - types `IntentKind`, `SpawnIntent`, `ParsedSwarmLaunch`, `LinkSession`, `PlannedLink`, `LinkPlan`,
    `TranscriptRef`, `LinkStore`, `HeuristicParentWriter`, `LinkReport`, `IngestBatchLike`,
    `LinkWorker`, `LinkWorkerOptions`
  - functions `swarmSlugify`, `swarmChildName`, `stripHeredocs`, `tokenizeShell`,
    `parseSwarmCommand`, `sendMessageTarget`, `extractIntents`, `intentWindow`,
    `isPlausibleChild`, `matchIntent`, `planLinks`, `scanTranscriptForIntents`, `dbLinkStore`,
    `startLinkWorker`
- `app_settings` key `sessions.links.backfill.<host>` (value `{version, finishedAt, transcripts, intents, matched, linked}`)
- `tests/unit/sessions/links.test.ts`, `tests/unit/sessions/linkWorker.test.ts`,
  `tests/integration/sessions.links.int.test.ts`

**Signature changes:** none to existing symbols. Phase 3's ingester gains (or already has) an observer list — see Requires.

**Requires (from earlier phases):**
- Phase 1: table `cc_sessions` with the snake_case columns from the index contract
  (`session_id, node_id, host, repo, cwd, name, custom_title, started_at, parent_session_id,
  parent_link_source, transcript_path`, `created_at`/`updated_at` defaulted); table
  `app_settings (key text pk, value jsonb, updated_at)`; class `SessionsRepo` in
  `src/sessions/repo.ts`, constructed as `new SessionsRepo(db)`, with
  `setParent(sessionId: string, parentSessionId: string, source: 'env' | 'hook' | 'heuristic'): Promise<SetParentResult>`
  that never lets `heuristic` replace `env`/`hook`, and `getSetting(key)` / `putSetting(key, value)`
  for the `app_settings` marker (reconciled: no raw SQL on `app_settings` here). Only the integration test and
  `background.ts` name `SessionsRepo`; `links.ts` takes the structural `HeuristicParentWriter`.
  If Phase 1 exports a factory instead of a constructor, only those two call sites change.
- Phase 3: `cc_sessions.repo` resolved the same way for worktree and main-checkout sessions
  (`mcp-notes` for both `~/mcp-notes` and `~/.worktrees/mcp-notes/<slug>`), `name` filled from
  `agent-name` (or the registry name), `custom_title` from `custom-title`, `started_at` = the
  session's first record timestamp, `transcript_path` absolute, `host` = the same string this
  phase passes as `host` (`os.hostname()` unless Phase 3 makes it injectable — then pass the same value).
- Phase 3 (as published in its plan): `src/sessions/ingest.ts` exports `IngestObserver`
  (`onBatch?(batch: IngestBatch)` with `{sessionId, host, transcriptPath, fromOffset, toOffset, records: readonly TranscriptRecord[]}`,
  `onPassComplete?(pass: IngestPass)` with `{initial, reason, sessionIds, report}`) and
  `startSessionIngest({ ..., observers?: IngestObserver[] })`. `LinkWorker` satisfies it
  structurally (it reads only `sessionId`, `host`, `records`, `initial`). No `ingest.ts` edit is needed.
- Phase 3: `src/background.ts` declares `let sessionIngest: SessionIngester | null = null;` and,
  in the `else` branch of `if (!deps.config.sessions.enabled)`, builds `const sessionsRepo = new SessionsRepo(deps.db);`
  and `const sessionsHost = hostname();` (`hostname` already imported from `node:os`) before
  `sessionIngest = startSessionIngest({...})`; the closer ends with
  `await Promise.all([embeddings?.close(), imageEmbeddings?.close(), sessionIngest?.close()]);`.

**Leaves alone (owned by others):** `src/sessions/transcript.ts` (Phase 3, unchanged by this
phase), `src/sessions/repo.ts` + schema + migrations (Phase 1), hooks and `scripts/*` (Phase 5),
`src/http/*`, `src/mcp/*`, `web/*` (Phases 7–13), summaries/embeddings (Phase 6).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/links.ts` | create | intent extraction (shell + SendMessage), swarm naming port, matching, DB store, backfill scan, live worker |
| `src/background.ts` | modify | start the link worker beside the session ingester, register it as an observer, close it on stop (Phase 3's session block, after line ~70 as it stands after Phase 3) |
| `tests/unit/sessions/links.test.ts` | create | pure parsing/naming/matching tests incl. the verbatim measured commands |
| `tests/unit/sessions/linkWorker.test.ts` | create | worker with an in-memory store and temp transcript files |
| `tests/integration/sessions.links.int.test.ts` | create | fixture Claude home + Postgres: backfill, precedence, marker, live path |

## Implementation Steps

### Step 1: Create `src/sessions/links.ts`
**File:** `src/sessions/links.ts` (new)
**Change:** The whole heuristic linker. Pure functions first (testable without I/O), then the
DB-backed store, the transcript scan and the worker.

Matching rules, all of which must hold for an intent to link a child:
- same `host` as the parent (tmux spawns and SendMessage sockets are local);
- `name` or `custom_title` equals the intent's name;
- child `started_at` strictly after the parent's `started_at` (so a child messaging its
  coordinator, e.g. `impl-x-p3` → `SendMessage {to: orch-x}`, never makes the orch its child);
- child `started_at` inside the intent's window: spawn/launch `[at − 10 s, at + 5 min]` (measured
  2–4 s; commands run `report/verify/reap` before spawning and can `sleep`), message
  `[at − 6 h, at + 10 s]` (the recipient is already running; measured 30–40 s);
- place: for a `launch` whose `--cwd` (or the `cd` before it) is known, `child.cwd === intent.cwd`
  accepts; otherwise the resolved repos must be equal when both are known.

Among the plausible children of one intent, spawn/launch takes the **earliest** started (a
relaunch under the same name minutes later gets its own intent), a message takes the **latest
started before the message** (the live recipient). Across intents for one child, spawn/launch
beats message, then the smallest time gap wins. A child that already has any parent is counted
as matched and left alone, so env/hook links and earlier heuristic links are never touched, and
`SessionsRepo.setParent` enforces the same precedence a second time.

**Code:**
```ts
/**
 * Heuristic parent links (iteration 8, R3).
 *
 * Claude Code does not record who started a session. For sessions spawned before CC_PARENT_SESSION
 * and the SessionStart hook existed (phases 2 and 5), the parent is recovered from the parent's own
 * transcript: a Bash tool_use running `swarm.py spawn --slug S --phase N` / `swarm.py launch --name X`,
 * or a `SendMessage {to: X}`. The child is the session named X on the same host that started inside
 * a bounded window around that tool_use, after the parent itself started, in the same cwd or repo.
 * Links are written through SessionsRepo.setParent(child, parent, 'heuristic'), which never
 * replaces an env or hook link; this module also skips any child that already has a parent.
 *
 * Two paths:
 * - backfill: once per host (app_settings marker), after the ingester's first full pass, re-read
 *   every transcript of this host (streamed, substring-prefiltered) and link everything at once.
 *   Spawn intents are not stored in cc_sessions, so this is the only way to see historical ones.
 * - live: the ingester hands each committed batch's parsed records to onBatch; intents found there
 *   wait in memory until their child shows up or their window has passed.
 *
 * Naming mirrors ~/claude-commands/skills/swarm/swarm.py (slugify, child_name, MAX_NAME).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

/** Bump to make every host re-run the backfill scan once (e.g. after the matching rules improve). */
export const LINKS_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${LINKS_MARKER_PREFIX}${host}`. */
export const LINKS_MARKER_PREFIX = 'sessions.links.backfill.';

/** A spawned child's first record comes 2-4 s after the tool_use (measured); allow clock slop before... */
export const SPAWN_BEFORE_MS = 10_000;
/** ...and slow commands (report/verify/reap run first, trust checks, `sleep`) after. */
export const SPAWN_AFTER_MS = 5 * 60_000;
/** A message goes to a session that is already running: it started at most this long before. */
export const MESSAGE_BEFORE_MS = 6 * 60 * 60_000;
export const MESSAGE_AFTER_MS = 10_000;
/** Live path: an unresolved intent is kept this long after its window closes, then dropped. */
export const PENDING_RETAIN_MS = 10 * 60_000;
/** Live path: never hold more unresolved intents than this (oldest dropped first). */
export const PENDING_CAP = 2_000;
export const DEFAULT_LINK_DEBOUNCE_MS = 2_000;
/** close() waits this long for an in-flight drain or backfill; well under main.ts's 10 s exit. */
export const DEFAULT_LINK_CLOSE_GRACE_MS = 5_000;
/** swarm.py MAX_NAME: session.py's cap on a session name. */
export const SWARM_MAX_NAME = 60;

export type IntentKind = 'spawn' | 'launch' | 'message';

/** One "this session started (or addressed) a session named `name`" fact from a transcript. */
export interface SpawnIntent {
  parentSessionId: string;
  kind: IntentKind;
  name: string;
  /** Timestamp of the assistant record carrying the tool_use. */
  at: Date;
  /** The child's cwd when the command states it (`launch --cwd`, or the `cd` before `launch`). */
  cwd: string | null;
}

export interface ParsedSwarmLaunch {
  kind: 'spawn' | 'launch';
  name: string;
  cwd: string | null;
}

/** The cc_sessions columns the linker reads. */
export interface LinkSession {
  sessionId: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  customTitle: string | null;
  startedAt: Date | null;
  parentSessionId: string | null;
  parentLinkSource: string | null;
}

export interface PlannedLink {
  childSessionId: string;
  parentSessionId: string;
  intent: SpawnIntent;
}

export interface LinkPlan {
  links: PlannedLink[];
  /** Intents that found their child (linked now, or the child already had a parent). */
  resolved: Set<SpawnIntent>;
}

export interface TranscriptRef {
  sessionId: string;
  transcriptPath: string;
}

/** Everything the linker needs from the database; dbLinkStore is the real one, tests fake it. */
export interface LinkStore {
  sessionsByIds(ids: readonly string[]): Promise<LinkSession[]>;
  sessionsByNames(host: string, names: readonly string[]): Promise<LinkSession[]>;
  transcriptsOnHost(host: string): Promise<TranscriptRef[]>;
  setParent(childSessionId: string, parentSessionId: string): Promise<void>;
  readSetting(key: string): Promise<unknown>;
  writeSetting(key: string, value: unknown): Promise<void>;
}

/**
 * The slice of SessionsRepo the linker writes through (phase 1 owns the precedence rule and the
 * app_settings accessors; `SessionsRepo` satisfies this structurally).
 */
export interface HeuristicParentWriter {
  setParent(sessionId: string, parentSessionId: string, source: 'heuristic'): Promise<unknown>;
  getSetting(key: string): Promise<unknown | null>;
  putSetting(key: string, value: unknown): Promise<void>;
}

export interface LinkReport {
  intents: number;
  matched: number;
  linked: number;
}

/** What the ingester hands an observer after a batch commits (phase 3's IngestObserver.onBatch). */
export interface IngestBatchLike {
  sessionId: string;
  host?: string;
  records: readonly unknown[];
}

export interface LinkWorker {
  /** Ingest observer: extract intents from a committed batch and schedule a drain. Never throws. */
  onBatch(batch: IngestBatchLike): void;
  /** Ingest observer: a full pass finished. Runs the once-per-host backfill, then drains. Never rejects. */
  onPassComplete(pass?: { initial?: boolean }): Promise<void>;
  /** The backfill scan; null when the marker says it already ran (or the worker closed mid-way). */
  backfill(): Promise<LinkReport | null>;
  /** Resolve pending live intents now (tests; the debounce calls it otherwise). */
  drainNow(): Promise<LinkReport>;
  pendingCount(): number;
  /** Stops scheduling, then waits at most closeGraceMs for the in-flight drain/backfill. */
  close(): Promise<void>;
}

export interface LinkWorkerOptions {
  store: LinkStore;
  /** This daemon's host, as written in cc_sessions.host by the ingester. */
  host: string;
  /** Home used to expand `~` and `$HOME` in commands. Default os.homedir(). */
  home?: string;
  now?: () => Date;
  debounceMs?: number;
  closeGraceMs?: number;
  log?: (line: string) => void;
  onError?: (what: string, err: unknown) => void;
}

// ---------------------------------------------------------------------------------------------
// swarm.py naming

/** swarm.py `slugify`: runs of disallowed characters become '-', '-' and '.' trimmed, capped. */
export function swarmSlugify(name: string): string {
  const out = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return out.slice(0, SWARM_MAX_NAME) || 'swarm';
}

/** swarm.py `child_name`: the slug is truncated, never the `-pN` tail. */
export function swarmChildName(prefix: string, slug: string, phase: number): string {
  const tail = `-p${phase}`;
  const head = `${prefix}-${swarmSlugify(slug)}`;
  return head.slice(0, SWARM_MAX_NAME - tail.length) + tail;
}

// ---------------------------------------------------------------------------------------------
// shell parsing (only as much bash as the measured commands use)

interface ShellState {
  cwd: string | null;
  home: string;
  vars: Map<string, string>;
  loops: Map<string, string[]>;
}

const HEREDOC_RE = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const PYTHON_RE = /(^|\/)python[0-9.]*$/;
const SWARM_SCRIPT_RE = /(^|\/)swarm\.py$/;
const BRACE_RANGE_RE = /^\{(\d+)\.\.(\d+)\}$/;
const PHASE_RE = /^\d+$/;
const SEGMENT_OPS = new Set(['\n', ';', '&', '|', '(', ')']);
/** Words that may precede the command in a segment and change nothing we care about. */
const SKIP_LEADING = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', '!', '{', '}', 'exec', 'command', 'nohup', 'env', 'export', 'builtin']);
const VALUE_FLAGS = new Set(['name', 'slug', 'phase', 'prefix', 'cwd', 'prompt', 'repo', 'permission-mode', 'model']);
const MAX_RANGE = 200;

/** Drops heredoc bodies (they quote whole briefs, swarm commands included) up to their terminator. */
export function stripHeredocs(command: string): string {
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = HEREDOC_RE.exec(line);
    if (m) terminator = m[2]!;
  }
  return out.join('\n');
}

/**
 * Splits a command into segments (at newline ; & | ( )) of words, honouring single and double
 * quotes, backslash escapes, backslash-newline continuations and `#` comments. Redirections stay
 * as ordinary words; the flag parser ignores anything that is not a flag it knows.
 */
export function tokenizeShell(input: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  const flushWord = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end < 0 ? input.length : end;
      cur += input.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        const d = input[j]!;
        if (d === '\\' && j + 1 < input.length) {
          const next = input[j + 1]!;
          if (next === '\n') {
            // continuation inside quotes: removed
          } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
            cur += next;
          } else {
            cur += d + next;
          }
          j += 2;
          continue;
        }
        cur += d;
        j += 1;
      }
      has = true;
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const next = input[i + 1];
      if (next !== undefined && next !== '\n') {
        cur += next;
        has = true;
      }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flushWord();
      i += 1;
      continue;
    }
    if (SEGMENT_OPS.has(c)) {
      flushSegment();
      i += 1;
      continue;
    }
    if (c === '#' && !has) {
      const nl = input.indexOf('\n', i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    cur += c;
    has = true;
    i += 1;
  }
  flushSegment();
  return segments;
}

function lookupVar(name: string, state: ShellState): string[] | null {
  const v = state.vars.get(name);
  if (v !== undefined) return [v];
  const loop = state.loops.get(name);
  if (loop) return loop;
  if (name === 'HOME') return [state.home];
  return null;
}

/** Expands `~`, `$VAR`, `${VAR}` (loop variables fan out). Null when a variable is unknown. */
function expandWord(word: string, state: ShellState): string[] | null {
  let w = word;
  if (w === '~' || w.startsWith('~/')) w = state.home + w.slice(1);
  const refs = [...w.matchAll(VAR_REF_RE)];
  if (refs.length === 0) return [w];
  let results = [w];
  for (const ref of refs) {
    const name = ref[1] ?? ref[2];
    if (name === undefined) return null;
    const values = lookupVar(name, state);
    if (values === null) return null;
    const token = ref[0];
    results = results.flatMap((r) => values.map((v) => r.replace(token, () => v)));
  }
  return results;
}

function expandOne(word: string | undefined, state: ShellState): string | null {
  if (word === undefined) return null;
  const values = expandWord(word, state);
  return values && values.length === 1 ? values[0]! : null;
}

function resolveDir(word: string, state: ShellState): string | null {
  const dir = expandOne(word, state);
  if (dir === null || dir === '') return null;
  if (path.posix.isAbsolute(dir)) return path.posix.resolve(dir);
  if (state.cwd === null) return null;
  return path.posix.resolve(state.cwd, dir);
}

function applyCd(target: string | undefined, state: ShellState): void {
  if (target === undefined) {
    state.cwd = state.home;
    return;
  }
  if (target === '-') {
    state.cwd = null;
    return;
  }
  state.cwd = resolveDir(target, state);
}

function recordLoop(rest: readonly string[], state: ShellState): void {
  const name = rest[0];
  if (name === undefined || !VAR_NAME_RE.test(name) || rest[1] !== 'in') return;
  const values: string[] = [];
  for (const word of rest.slice(2)) {
    const range = BRACE_RANGE_RE.exec(word);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Math.abs(b - a) > MAX_RANGE) continue;
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) values.push(String(n));
      continue;
    }
    const expanded = expandWord(word, state);
    if (expanded) values.push(...expanded);
  }
  state.vars.delete(name);
  state.loops.set(name, values);
}

/** Index of the swarm.py word when the segment runs it (directly or via python), else -1. */
function swarmScriptIndex(words: readonly string[], start: number, state: ShellState): number {
  const first = words[start];
  if (first === undefined) return -1;
  let i = start;
  if (PYTHON_RE.test(first)) {
    i = start + 1;
    while (i < words.length && words[i]!.startsWith('-')) i += 1;
  }
  const script = expandOne(words[i], state);
  return script !== null && SWARM_SCRIPT_RE.test(script) ? i : -1;
}

function parseSwarmArgs(args: readonly string[], state: ShellState): ParsedSwarmLaunch[] {
  const sub = args[0];
  if (sub !== 'spawn' && sub !== 'launch') return [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 1; i < args.length; i += 1) {
    const w = args[i]!;
    if (w === '-h') {
      bools.add('help');
      continue;
    }
    if (!w.startsWith('--')) continue;
    const eq = w.indexOf('=');
    const key = eq < 0 ? w.slice(2) : w.slice(2, eq);
    if (VALUE_FLAGS.has(key)) {
      if (eq >= 0) {
        flags.set(key, w.slice(eq + 1));
      } else if (i + 1 < args.length) {
        flags.set(key, args[i + 1]!);
        i += 1;
      }
    } else {
      bools.add(key);
    }
  }
  if (bools.has('dry-run') || bools.has('help')) return [];

  if (sub === 'launch') {
    const raw = expandOne(flags.get('name'), state);
    if (raw === null || raw.trim() === '') return [];
    const cwdFlag = flags.get('cwd');
    const cwd = cwdFlag !== undefined ? resolveDir(cwdFlag, state) : state.cwd;
    return [{ kind: 'launch', name: swarmSlugify(raw), cwd }];
  }

  const slug = expandOne(flags.get('slug'), state);
  const prefixFlag = flags.get('prefix');
  const prefix = prefixFlag !== undefined ? expandOne(prefixFlag, state) : 'impl';
  const phaseWord = flags.get('phase');
  if (slug === null || prefix === null || phaseWord === undefined) return [];
  const phases = (expandWord(phaseWord, state) ?? []).filter((p) => PHASE_RE.test(p)).map(Number);
  const cwdFlag = flags.get('cwd');
  const cwd = cwdFlag !== undefined ? resolveDir(cwdFlag, state) : null;
  return phases.map((n) => ({ kind: 'spawn' as const, name: swarmChildName(prefix, slug, n), cwd }));
}

/**
 * The sessions a Bash command starts through swarm.py (`spawn` or `launch`, not `--dry-run` or
 * `--help`). `cwd` is the tool call's working directory; `cd` segments before the launch move it.
 */
export function parseSwarmCommand(command: string, opts: { cwd: string | null; home: string }): ParsedSwarmLaunch[] {
  if (!command.includes('swarm.py')) return [];
  const state: ShellState = { cwd: opts.cwd, home: opts.home, vars: new Map(), loops: new Map() };
  const out: ParsedSwarmLaunch[] = [];
  for (const words of tokenizeShell(stripHeredocs(command))) {
    let k = 0;
    while (k < words.length && SKIP_LEADING.has(words[k]!)) k += 1;
    while (k < words.length) {
      const m = ASSIGN_RE.exec(words[k]!);
      if (!m) break;
      const value = expandOne(m[2]!, state);
      if (value !== null) state.vars.set(m[1]!, value);
      else state.vars.delete(m[1]!);
      state.loops.delete(m[1]!);
      k += 1;
      while (k < words.length && SKIP_LEADING.has(words[k]!)) k += 1;
    }
    const cmd = words[k];
    if (cmd === undefined) continue;
    if (cmd === 'for') {
      recordLoop(words.slice(k + 1), state);
      continue;
    }
    if (cmd === 'cd') {
      applyCd(words[k + 1], state);
      continue;
    }
    if (cmd === 'unset') {
      for (const name of words.slice(k + 1)) {
        state.vars.delete(name);
        state.loops.delete(name);
      }
      continue;
    }
    const at = swarmScriptIndex(words, k, state);
    if (at < 0) continue;
    out.push(...parseSwarmArgs(words.slice(at + 1), state));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// transcript records -> intents

const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const IGNORED_TARGETS = new Set(['main', 'parent', 'user', 'all', 'lead', 'team-lead']);
const UNPARSED_TO_RE = /"to"\s*:\s*"([^"]+)"/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The session name a SendMessage addresses, or null for sockets, agent ids we cannot name, 'main'... */
export function sendMessageTarget(input: unknown): string | null {
  if (!isObject(input)) return null;
  let to: string | null = null;
  if (typeof input.to === 'string') to = input.to;
  else if (typeof input.recipient === 'string') to = input.recipient;
  else if (isObject(input.__unparsedToolInput) && typeof input.__unparsedToolInput.raw === 'string') {
    to = UNPARSED_TO_RE.exec(input.__unparsedToolInput.raw)?.[1] ?? null;
  }
  if (to === null) return null;
  const name = to.trim();
  if (!TARGET_NAME_RE.test(name) || IGNORED_TARGETS.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Spawn intents in one transcript record (an `assistant` record's Bash and SendMessage tool_uses).
 * `parentSessionId` defaults to the record's sessionId; callers pass the transcript's owner.
 */
export function extractIntents(record: unknown, ctx: { parentSessionId?: string; home: string }): SpawnIntent[] {
  if (!isObject(record) || record.type !== 'assistant') return [];
  const message = record.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  const parent = ctx.parentSessionId ?? (typeof record.sessionId === 'string' ? record.sessionId : null);
  if (!parent) return [];
  const at = parseTimestamp(record.timestamp);
  if (!at) return [];
  const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null;
  const out: SpawnIntent[] = [];
  for (const item of message.content) {
    if (!isObject(item) || item.type !== 'tool_use') continue;
    const input = item.input;
    if (item.name === 'Bash' && isObject(input) && typeof input.command === 'string') {
      for (const p of parseSwarmCommand(input.command, { cwd, home: ctx.home })) {
        out.push({ parentSessionId: parent, kind: p.kind, name: p.name, at, cwd: p.cwd });
      }
    } else if (item.name === 'SendMessage') {
      const name = sendMessageTarget(input);
      if (name !== null) out.push({ parentSessionId: parent, kind: 'message', name, at, cwd: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// matching

const KIND_RANK: Record<IntentKind, number> = { spawn: 2, launch: 2, message: 1 };

export function intentWindow(intent: SpawnIntent): { from: Date; to: Date } {
  const t = intent.at.getTime();
  return intent.kind === 'message'
    ? { from: new Date(t - MESSAGE_BEFORE_MS), to: new Date(t + MESSAGE_AFTER_MS) }
    : { from: new Date(t - SPAWN_BEFORE_MS), to: new Date(t + SPAWN_AFTER_MS) };
}

/** Could `child` be the session `intent` (found in `parent`'s transcript) started or addressed? */
export function isPlausibleChild(intent: SpawnIntent, parent: LinkSession, child: LinkSession): boolean {
  if (child.sessionId === parent.sessionId) return false;
  if (child.host !== parent.host) return false;
  if (child.name !== intent.name && child.customTitle !== intent.name) return false;
  if (child.startedAt === null || parent.startedAt === null) return false;
  const started = child.startedAt.getTime();
  if (started <= parent.startedAt.getTime()) return false;
  if (parent.parentSessionId === child.sessionId) return false;
  const w = intentWindow(intent);
  if (started < w.from.getTime() || started > w.to.getTime()) return false;
  if (intent.cwd !== null && child.cwd === intent.cwd) return true;
  if (parent.repo !== null && child.repo !== null && parent.repo !== child.repo) return false;
  return true;
}

/** The child an intent points at: earliest after a spawn/launch, latest before a message. */
export function matchIntent(intent: SpawnIntent, parent: LinkSession, candidates: readonly LinkSession[]): LinkSession | null {
  const ok = candidates.filter((c) => isPlausibleChild(intent, parent, c));
  if (ok.length === 0) return null;
  ok.sort((a, b) =>
    intent.kind === 'message'
      ? b.startedAt!.getTime() - a.startedAt!.getTime()
      : a.startedAt!.getTime() - b.startedAt!.getTime(),
  );
  return ok[0]!;
}

/**
 * Turns intents into at most one link per child. Children that already have a parent count as
 * resolved but get no link. Intents whose parent row is missing stay unresolved.
 */
export function planLinks(
  intents: readonly SpawnIntent[],
  parents: ReadonlyMap<string, LinkSession>,
  candidates: readonly LinkSession[],
): LinkPlan {
  const byName = new Map<string, LinkSession[]>();
  const add = (key: string | null, s: LinkSession): void => {
    if (key === null) return;
    const list = byName.get(key);
    if (list) list.push(s);
    else byName.set(key, [s]);
  };
  for (const s of candidates) {
    add(s.name, s);
    if (s.customTitle !== s.name) add(s.customTitle, s);
  }

  const best = new Map<string, { link: PlannedLink; rank: number; gap: number }>();
  const resolved = new Set<SpawnIntent>();
  for (const intent of intents) {
    const parent = parents.get(intent.parentSessionId);
    if (!parent) continue;
    const child = matchIntent(intent, parent, byName.get(intent.name) ?? []);
    if (!child) continue;
    resolved.add(intent);
    if (child.parentSessionId !== null) continue;
    const rank = KIND_RANK[intent.kind];
    const gap = Math.abs(child.startedAt!.getTime() - intent.at.getTime());
    const prev = best.get(child.sessionId);
    if (!prev || rank > prev.rank || (rank === prev.rank && gap < prev.gap)) {
      best.set(child.sessionId, {
        link: { childSessionId: child.sessionId, parentSessionId: parent.sessionId, intent },
        rank,
        gap,
      });
    }
  }
  return { links: [...best.values()].map((b) => b.link), resolved };
}

// ---------------------------------------------------------------------------------------------
// transcript scan (backfill)

function mightCarryIntent(line: string): boolean {
  return line.includes('"tool_use"') && (line.includes('"SendMessage"') || line.includes('swarm.py'));
}

/**
 * Streams one transcript and returns its spawn intents. A missing or unreadable file yields [];
 * a trailing partial line fails JSON.parse and is skipped. `shouldStop` aborts between lines.
 */
export async function scanTranscriptForIntents(
  file: string,
  parentSessionId: string,
  opts: { home: string; shouldStop?: () => boolean },
): Promise<SpawnIntent[]> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  const out: SpawnIntent[] = [];
  try {
    for await (const line of handle.readLines({ encoding: 'utf8' })) {
      if (opts.shouldStop?.()) break;
      if (!mightCarryIntent(line)) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      out.push(...extractIntents(record, { parentSessionId, home: opts.home }));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// database

// Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>.
type SessionRow = {
  session_id: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  name: string | null;
  custom_title: string | null;
  started_at: Date | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
};
type TranscriptRow = { session_id: string; transcript_path: string };

const SESSION_COLUMNS = sql.raw(
  'session_id, host, repo, cwd, name, custom_title, started_at, parent_session_id, parent_link_source',
);

function textArray(values: readonly string[]) {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

function toLinkSession(r: SessionRow): LinkSession {
  return {
    sessionId: r.session_id,
    host: r.host,
    repo: r.repo,
    cwd: r.cwd,
    name: r.name,
    customTitle: r.custom_title,
    startedAt: r.started_at === null ? null : new Date(r.started_at),
    parentSessionId: r.parent_session_id,
    parentLinkSource: r.parent_link_source,
  };
}

/** Reads cc_sessions directly; every write (parent links and the marker setting) goes through `writer` (SessionsRepo). */
export function dbLinkStore(db: Db, writer: HeuristicParentWriter): LinkStore {
  return {
    async sessionsByIds(ids) {
      if (ids.length === 0) return [];
      const res = await db.execute<SessionRow>(sql`
        select ${SESSION_COLUMNS} from cc_sessions where session_id = any(${textArray(ids)})
      `);
      return res.rows.map(toLinkSession);
    },
    async sessionsByNames(host, names) {
      if (names.length === 0) return [];
      const res = await db.execute<SessionRow>(sql`
        select ${SESSION_COLUMNS} from cc_sessions
        where host = ${host}
          and started_at is not null
          and (name = any(${textArray(names)}) or custom_title = any(${textArray(names)}))
      `);
      return res.rows.map(toLinkSession);
    },
    async transcriptsOnHost(host) {
      const res = await db.execute<TranscriptRow>(sql`
        select session_id, transcript_path from cc_sessions
        where host = ${host} and transcript_path is not null
        order by started_at asc nulls last, session_id asc
      `);
      return res.rows.map((r) => ({ sessionId: r.session_id, transcriptPath: r.transcript_path }));
    },
    async setParent(childSessionId, parentSessionId) {
      await writer.setParent(childSessionId, parentSessionId, 'heuristic');
    },
    async readSetting(key) {
      return writer.getSetting(key);
    },
    async writeSetting(key, value) {
      await writer.putSetting(key, value);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// worker

interface Pending {
  intent: SpawnIntent;
  /** How many full ingest passes had completed when the intent arrived. */
  seenPass: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function keepPending(p: Pending, resolved: ReadonlySet<SpawnIntent>, nowMs: number, passes: number): boolean {
  if (resolved.has(p.intent)) return false;
  const end = intentWindow(p.intent).to.getTime();
  if (nowMs > end + PENDING_RETAIN_MS) return false;
  // A full pass finished since it arrived, so every child on disk is ingested: no point waiting.
  if (passes > p.seenPass && nowMs > end) return false;
  return true;
}

export function startLinkWorker(opts: LinkWorkerOptions): LinkWorker {
  const home = opts.home ?? homedir();
  const now = opts.now ?? ((): Date => new Date());
  const debounceMs = opts.debounceMs ?? DEFAULT_LINK_DEBOUNCE_MS;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_LINK_CLOSE_GRACE_MS;
  const log = opts.log ?? ((line: string): void => console.log(`[notesd] ${line}`));
  const onError =
    opts.onError ??
    ((what: string, err: unknown): void => {
      console.error(`[notesd] session links: ${what} failed: ${errorMessage(err)}`);
    });

  let pending: Pending[] = [];
  let passes = 0;
  let closed = false;
  let backfillDone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** One drain or backfill at a time; a failed task does not poison the chain. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function resolveAndApply(
    intents: readonly SpawnIntent[],
  ): Promise<{ report: LinkReport; resolved: Set<SpawnIntent> }> {
    if (intents.length === 0) return { report: { intents: 0, matched: 0, linked: 0 }, resolved: new Set() };
    const parentRows = await opts.store.sessionsByIds([...new Set(intents.map((i) => i.parentSessionId))]);
    const parents = new Map(parentRows.map((p) => [p.sessionId, p] as const));
    const candidates = await opts.store.sessionsByNames(opts.host, [...new Set(intents.map((i) => i.name))]);
    const plan = planLinks(intents, parents, candidates);
    let linked = 0;
    for (const link of plan.links) {
      if (closed) break;
      await opts.store.setParent(link.childSessionId, link.parentSessionId);
      linked += 1;
    }
    return { report: { intents: intents.length, matched: plan.resolved.size, linked }, resolved: plan.resolved };
  }

  function drainNow(): Promise<LinkReport> {
    return enqueue(async () => {
      if (closed || pending.length === 0) return { intents: 0, matched: 0, linked: 0 };
      const batch = pending.slice();
      const { report, resolved } = await resolveAndApply(batch.map((p) => p.intent));
      const t = now().getTime();
      const inBatch = new Set(batch);
      pending = pending.filter((p) => !inBatch.has(p) || keepPending(p, resolved, t, passes));
      return report;
    });
  }

  function schedule(): void {
    // Before the first full pass the backfill scan will see everything anyway.
    if (closed || timer !== null || passes === 0 || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      drainNow().catch((err: unknown) => onError('drain', err));
    }, debounceMs);
    timer.unref();
  }

  function backfill(): Promise<LinkReport | null> {
    return enqueue(async () => {
      if (closed) return null;
      const key = `${LINKS_MARKER_PREFIX}${opts.host}`;
      const marker = await opts.store.readSetting(key);
      if (isObject(marker) && marker.version === LINKS_BACKFILL_VERSION) return null;
      const startedMs = Date.now();
      const refs = await opts.store.transcriptsOnHost(opts.host);
      const intents: SpawnIntent[] = [];
      for (const ref of refs) {
        if (closed) return null;
        intents.push(
          ...(await scanTranscriptForIntents(ref.transcriptPath, ref.sessionId, { home, shouldStop: () => closed })),
        );
      }
      if (closed) return null;
      const { report } = await resolveAndApply(intents);
      // Interrupted while applying: no marker, so the next start re-runs it (idempotent).
      if (closed) return null;
      await opts.store.writeSetting(key, {
        version: LINKS_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        transcripts: refs.length,
        ...report,
      });
      const secs = Math.round((Date.now() - startedMs) / 1000);
      log(
        `session links backfilled on ${opts.host}: ${report.linked} heuristic parent links from ${report.intents} intents in ${refs.length} transcripts (${secs} s)`,
      );
      return report;
    });
  }

  return {
    onBatch(batch: IngestBatchLike): void {
      if (closed) return;
      try {
        for (const record of batch.records) {
          for (const intent of extractIntents(record, { parentSessionId: batch.sessionId, home })) {
            pending.push({ intent, seenPass: passes });
          }
        }
        if (pending.length > PENDING_CAP) pending = pending.slice(pending.length - PENDING_CAP);
      } catch (err) {
        onError('extract', err);
      }
      // Even a batch without intents may be the child a pending intent waits for.
      schedule();
    },

    async onPassComplete(): Promise<void> {
      if (closed) return;
      passes += 1;
      if (!backfillDone) {
        try {
          await backfill();
          backfillDone = true;
        } catch (err) {
          onError('backfill', err);
        }
      }
      try {
        await drainNow();
      } catch (err) {
        onError('drain', err);
      }
    },

    backfill,
    drainNow,
    pendingCount: () => pending.length,

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        chain,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      clearTimeout(grace);
    },
  };
}
```
**Impact:** New module only. Reads `cc_sessions`/`app_settings`, writes `cc_sessions` only through
`SessionsRepo.setParent` (invariant 3) and `app_settings` for its own marker key.

### Step 2: Wire the worker into `startBackground`
**File:** `src/background.ts` as it stands after Phase 3 (Phase 3 Step 6 quotes the whole file).
**Change:** three insertions into Phase 3's session block. Post-Phase-3 code, with this phase's
lines marked `// + phase 4`:

(a) import, next to Phase 3's `./sessions/*` imports (`hostname` is already imported by Phase 3; do not import it again):
```ts
import { dbLinkStore, startLinkWorker, type LinkWorker } from './sessions/links.js'; // + phase 4
```

(b) the session block:
```ts
  let sessionIngest: SessionIngester | null = null;
  let sessionLinks: LinkWorker | null = null; // + phase 4
  if (!deps.config.sessions.enabled) {
    console.log('[notesd] session ingest off: NOTESD_SESSIONS=off');
  } else {
    const sessionsRepo = new SessionsRepo(deps.db);
    const sessionsHost = hostname();
    sessionLinks = startLinkWorker({ store: dbLinkStore(deps.db, sessionsRepo), host: sessionsHost }); // + phase 4
    sessionIngest = startSessionIngest({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
      observers: [sessionLinks], // + phase 4
    });
    console.log(`[notesd] ingesting Claude Code sessions from ${deps.config.sessions.claudeHome}/projects as ${sessionsHost}`);
  }
```

(c) the returned closer: the linker closes after the ingester's close resolved (no more batches can arrive):
```ts
  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([
      embeddings?.close(),
      imageEmbeddings?.close(),
      (async () => {
        await sessionIngest?.close();
        await sessionLinks?.close(); // + phase 4
      })(),
    ]);
  };
```
**Impact:** With sessions disabled (`NOTESD_SESSIONS=off`, and every test `Config` built with
`DEFAULT_SESSIONS_CONFIG`) nothing changes. With them on, the first full ingest pass triggers one
backfill scan per host; later passes and batches only touch in-memory pending intents. Shutdown
stays bounded (5 s grace each). Phase 6 edits the same function after this phase (index edge 4 -> 6)
and keeps this block and this closer.

### Step 3: (removed in reconciliation)
Phase 3 publishes `IngestObserver` with `records` and pass completion (`observers?:` on
`startSessionIngest`), so this phase does not edit `src/sessions/ingest.ts`.

### Step 4: Unit tests — parsing, naming, matching
**File:** `tests/unit/sessions/links.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';

import {
  extractIntents,
  intentWindow,
  matchIntent,
  parseSwarmCommand,
  planLinks,
  sendMessageTarget,
  stripHeredocs,
  swarmChildName,
  swarmSlugify,
  type LinkSession,
  type SpawnIntent,
} from '../../../src/sessions/links.js';

const HOME = '/home/miftah';
const WT = '/home/miftah/.worktrees/mcp-notes/wall-editing';
const parse = (cmd: string, cwd: string | null = WT) => parseSwarmCommand(cmd, { cwd, home: HOME });
const names = (cmd: string, cwd: string | null = WT) => parse(cmd, cwd).map((p) => p.name);

describe('swarm.py naming', () => {
  it('names a phase child like child_name', () => {
    expect(swarmChildName('impl', 'wall-editing', 3)).toBe('impl-wall-editing-p3');
    expect(swarmChildName('fix', 'a b/c', 12)).toBe('fix-a-b-c-p12');
  });

  it('truncates the slug, never the phase tail, at 60 characters', () => {
    const name = swarmChildName('impl', 'x'.repeat(80), 12);
    expect(name).toHaveLength(60);
    expect(name.endsWith('-p12')).toBe(true);
    expect(name.startsWith('impl-xxx')).toBe(true);
  });

  it('slugifies like swarm.py', () => {
    expect(swarmSlugify('  orch wall/editing  ')).toBe('orch-wall-editing');
    expect(swarmSlugify('.-orch-x-.')).toBe('orch-x');
    expect(swarmSlugify('---')).toBe('swarm');
    expect(swarmSlugify('y'.repeat(70))).toHaveLength(60);
  });
});

describe('parseSwarmCommand on commands measured in cc6491fc (orch-wall-editing)', () => {
  it('ignores --help calls', () => {
    expect(
      parse(
        'S=~/.claude/skills/swarm/swarm.py; python3 $S init --help | sed -n 1,30p; python3 $S spawn --help | sed -n 1,40p; python3 $S report --help | sed -n 1,30p',
      ),
    ).toEqual([]);
  });

  it('ignores --dry-run', () => {
    expect(
      parse(
        'python3 ~/.claude/skills/swarm/swarm.py spawn --slug wall-editing --phase 1 --permission-mode bypassPermissions --dry-run; python3 ~/.claude/skills/task/session.py rename "orch-wall-editing" --no-widen',
      ),
    ).toEqual([]);
  });

  it('expands $S and a for-loop over phases', () => {
    const cmd =
      'S=~/.claude/skills/swarm/swarm.py; for n in 1 11; do python3 $S spawn --slug wall-editing --phase $n --permission-mode bypassPermissions | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in (\'name\',\'window\',\'pane\',\'spawned\',\'error\')})"; done';
    expect(parse(cmd)).toEqual([
      { kind: 'spawn', name: 'impl-wall-editing-p1', cwd: null },
      { kind: 'spawn', name: 'impl-wall-editing-p11', cwd: null },
    ]);
  });

  it('skips report/verify/reap/waves and finds the spawn loop after them', () => {
    const cmd = [
      'S=~/.claude/skills/swarm/swarm.py; python3 $S report --slug wall-editing --phase 2 --status done --commit 42f05d5 --task P1-NOTES-A024 --note "server cut over; unit 641, int 253" >/dev/null; python3 $S verify --slug wall-editing --apply >/dev/null; python3 $S reap --slug wall-editing | grep -E \'"how"\'; python3 $S waves --slug wall-editing | python3 -c "import json,sys;print(1)"; for n in 3 5 6; do python3 $S spawn --slug wall-editing --phase $n --permission-mode bypassPermissions | grep -E \'"name"|"window"|error\'; done; git pull -q --ff-only; L=.workflows/orchestration/wall-editing/ledger.json; cp /home/miftah/mcp-notes/$L $L && export GIT_INDEX_FILE=/tmp/claude-1000/orchidx.$$ && git read-tree HEAD && git add $L && git commit -q -m "orchestration(wall-editing): phase 2 done (42f05d5); phases 3, 5, 6 spawned',
      '',
      'Co-Authored-By: Someone <someone@example.com>" && rm -f $GIT_INDEX_FILE && unset GIT_INDEX_FILE && git push -q; sleep 25',
    ].join('\n');
    expect(names(cmd)).toEqual(['impl-wall-editing-p3', 'impl-wall-editing-p5', 'impl-wall-editing-p6']);
  });

  it('reads launch --name/--cwd with $HOME after a cd (930c1249 launching the orch)', () => {
    const cmd = [
      'cd $HOME/.worktrees/mcp-notes/wall-editing && git add docs && git commit -q -m "plan(wall-editing): iteration 7',
      '',
      'Co-Authored-By: Someone <someone@example.com>" && git log --oneline -1 && python3 ~/.claude/skills/swarm/swarm.py launch --name "orch-wall-editing" --cwd "$HOME/.worktrees/mcp-notes/wall-editing" --permission-mode bypassPermissions --prompt "/analyze-orchestrator -f docs/plans/WALL_EDITING_PLAN.md"',
    ].join('\n');
    expect(parse(cmd, '/home/miftah/mcp-notes')).toEqual([
      { kind: 'launch', name: 'orch-wall-editing', cwd: WT },
    ]);
  });
});

describe('parseSwarmCommand, other measured shapes', () => {
  it('handles `for N in` with echo in the body', () => {
    const cmd =
      'cd /home/miftah/agentic_golang && for N in 1 4 5 6; do echo "=== phase $N ==="; python3 ~/.claude/skills/swarm/swarm.py spawn --slug uatp-4258-remaining --phase $N --permission-mode bypassPermissions 2>&1 | grep -v "FakeAssoc"; done';
    expect(names(cmd)).toEqual([
      'impl-uatp-4258-remaining-p1',
      'impl-uatp-4258-remaining-p4',
      'impl-uatp-4258-remaining-p5',
      'impl-uatp-4258-remaining-p6',
    ]);
  });

  it('drops heredoc bodies that quote swarm commands', () => {
    const cmd = [
      "cd /home/miftah/seer && read -r -d '' EXTRA <<'EOF' || true",
      'Brief: never run python3 ~/.claude/skills/swarm/swarm.py spawn --slug nope --phase 9 yourself.',
      'EOF',
      'python3 ~/.claude/skills/swarm/swarm.py spawn --slug lab-shortfall --phase 2 --prompt "$EXTRA"',
    ].join('\n');
    expect(names(cmd)).toEqual(['impl-lab-shortfall-p2']);
  });

  it('follows line continuations and --flag=value', () => {
    const cmd =
      'python3 ~/.claude/skills/swarm/swarm.py launch \\\n    --name "orch-popup-data-refactor" \\\n    --cwd "/home/miftah/.worktrees/agentic/popup-data-refactor" \\\n    --prompt "/analyze-orchestrator"';
    expect(parse(cmd, '/home/miftah/agentic')).toEqual([
      { kind: 'launch', name: 'orch-popup-data-refactor', cwd: '/home/miftah/.worktrees/agentic/popup-data-refactor' },
    ]);
    expect(names('python3 ~/.claude/skills/swarm/swarm.py spawn --slug=x --phase=4 --prefix fix')).toEqual(['fix-x-p4']);
  });

  it('expands brace ranges in loops', () => {
    expect(names('for n in {1..3}; do python3 ~/.claude/skills/swarm/swarm.py spawn --slug s --phase $n; done')).toEqual([
      'impl-s-p1',
      'impl-s-p2',
      'impl-s-p3',
    ]);
  });

  it('defaults a launch cwd to the tool call cwd, moved by cd', () => {
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py launch --name analyze-x --prompt p', '/home/miftah/seer')).toEqual([
      { kind: 'launch', name: 'analyze-x', cwd: '/home/miftah/seer' },
    ]);
    expect(parse('cd ../seer && python3 ~/.claude/skills/swarm/swarm.py launch --name a --prompt p', '/home/miftah/notes')).toEqual([
      { kind: 'launch', name: 'a', cwd: '/home/miftah/seer' },
    ]);
  });

  it('gives up on unknown variables and on swarm.py that is not executed', () => {
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase $UNKNOWN')).toEqual([]);
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py launch --name "$NAME" --prompt p')).toEqual([]);
    expect(parse('grep -n spawn ~/.claude/skills/swarm/swarm.py')).toEqual([]);
    expect(parse('python3 -c "print(\'swarm.py spawn --slug x --phase 1\')"')).toEqual([]);
    expect(parse('ls ~/.claude/skills/swarm/')).toEqual([]);
  });

  it('treats an executable swarm.py as the command itself', () => {
    expect(names('~/.claude/skills/swarm/swarm.py spawn --slug x --phase 2')).toEqual(['impl-x-p2']);
  });
});

describe('stripHeredocs', () => {
  it('keeps here-strings and unterminated text intact', () => {
    expect(stripHeredocs('cat <<<"abc"; echo hi')).toBe('cat <<<"abc"; echo hi');
    expect(stripHeredocs("cat <<-'X'\nbody\n  X\nafter")).toBe("cat <<-'X'\nafter");
  });
});

describe('sendMessageTarget', () => {
  it('reads to, then recipient, then the unparsed raw input', () => {
    expect(sendMessageTarget({ to: 'impl-wall-editing-p3', recipient: 'impl-wall-editing-p3' })).toBe('impl-wall-editing-p3');
    expect(sendMessageTarget({ recipient: 'orch-x' })).toBe('orch-x');
    expect(
      sendMessageTarget({ __unparsedToolInput: { raw: '{"to": "impl-uatp-4258-remaining-p1", "summary": "x' } }),
    ).toBe('impl-uatp-4258-remaining-p1');
  });

  it('rejects sockets, main, blanks and garbage', () => {
    expect(sendMessageTarget({ to: 'uds:/run/user/1000/cc-socks/1925001.sock' })).toBeNull();
    expect(sendMessageTarget({ to: 'main' })).toBeNull();
    expect(sendMessageTarget({ to: '' })).toBeNull();
    expect(sendMessageTarget({ to: 42 })).toBeNull();
    expect(sendMessageTarget(null)).toBeNull();
  });
});

describe('extractIntents', () => {
  const base = {
    type: 'assistant',
    sessionId: 'cc6491fc-2dc1-4f2d-9d28-db3fbf6baa0a',
    cwd: WT,
    timestamp: '2026-10-30T09:36:25.606Z',
    entrypoint: 'cli',
    isSidechain: false,
  };

  it('returns SendMessage and Bash intents with the record time', () => {
    const rec = {
      ...base,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sending' },
          { type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'impl-wall-editing-p3', message: 'rules' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug wall-editing --phase 4' } },
        ],
      },
    };
    expect(extractIntents(rec, { home: HOME })).toEqual([
      { parentSessionId: base.sessionId, kind: 'message', name: 'impl-wall-editing-p3', at: new Date(base.timestamp), cwd: null },
      { parentSessionId: base.sessionId, kind: 'spawn', name: 'impl-wall-editing-p4', at: new Date(base.timestamp), cwd: null },
    ]);
  });

  it('uses the caller-given parent over the record sessionId', () => {
    const rec = { ...base, message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'a-b' } }] } };
    expect(extractIntents(rec, { home: HOME, parentSessionId: 'owner' })[0]?.parentSessionId).toBe('owner');
  });

  it('ignores other record types, missing timestamps and other tools', () => {
    expect(extractIntents({ ...base, type: 'user', message: { content: [] } }, { home: HOME })).toEqual([]);
    expect(
      extractIntents({ ...base, timestamp: undefined, message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'x' } }] } }, { home: HOME }),
    ).toEqual([]);
    expect(
      extractIntents({ ...base, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'swarm.py' } }] } }, { home: HOME }),
    ).toEqual([]);
    expect(extractIntents('not a record', { home: HOME })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const T = Date.parse('2026-10-30T09:19:49.264Z');
const at = (ms: number) => new Date(T + ms);

function session(over: Partial<LinkSession> & { sessionId: string }): LinkSession {
  return {
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: WT,
    name: null,
    customTitle: null,
    startedAt: at(0),
    parentSessionId: null,
    parentLinkSource: null,
    ...over,
  };
}

const ORCH = session({ sessionId: 'orch', name: 'orch-wall-editing', customTitle: 'orch-wall-editing', startedAt: at(-200_000) });

function intent(over: Partial<SpawnIntent>): SpawnIntent {
  return { parentSessionId: 'orch', kind: 'spawn', name: 'impl-wall-editing-p1', at: at(0), cwd: null, ...over };
}

describe('intentWindow', () => {
  it('opens after a spawn and before a message', () => {
    const s = intentWindow(intent({}));
    expect(s.from.getTime()).toBe(T - 10_000);
    expect(s.to.getTime()).toBe(T + 300_000);
    const m = intentWindow(intent({ kind: 'message' }));
    expect(m.from.getTime()).toBe(T - 6 * 3_600_000);
    expect(m.to.getTime()).toBe(T + 10_000);
  });
});

describe('matchIntent', () => {
  const p1 = session({ sessionId: 'p1', name: 'impl-wall-editing-p1', startedAt: at(3_808) });
  const p1Old = session({ sessionId: 'p1-old', name: 'impl-wall-editing-p1', startedAt: at(-86_400_000) });
  const p1Relaunch = session({ sessionId: 'p1-again', name: 'impl-wall-editing-p1', startedAt: at(120_000) });

  it('takes the earliest child inside a spawn window, not an older session with the same name', () => {
    expect(matchIntent(intent({}), ORCH, [p1Old, p1Relaunch, p1])?.sessionId).toBe('p1');
  });

  it('takes the latest child started before a message', () => {
    expect(matchIntent(intent({ kind: 'message', at: at(150_000) }), ORCH, [p1, p1Relaunch, p1Old])?.sessionId).toBe('p1-again');
  });

  it('never links a session that started before the parent (a child messaging its coordinator)', () => {
    const child = session({ sessionId: 'p3', name: 'impl-wall-editing-p3', startedAt: at(0) });
    const reply = intent({ parentSessionId: 'p3', kind: 'message', name: 'orch-wall-editing', at: at(60_000) });
    expect(matchIntent(reply, child, [ORCH])).toBeNull();
  });

  it('requires the same host, and the same repo when both are known', () => {
    expect(matchIntent(intent({}), ORCH, [{ ...p1, host: 'gpd' }])).toBeNull();
    expect(matchIntent(intent({}), ORCH, [{ ...p1, repo: 'seer' }])).toBeNull();
    expect(matchIntent(intent({}), ORCH, [{ ...p1, repo: null }])?.sessionId).toBe('p1');
  });

  it('accepts a launch into another repo when the cwd matches', () => {
    const child = session({ sessionId: 'a', name: 'analyze-x', repo: 'seer', cwd: '/home/miftah/seer', startedAt: at(2_000) });
    expect(matchIntent(intent({ kind: 'launch', name: 'analyze-x', cwd: '/home/miftah/seer' }), ORCH, [child])?.sessionId).toBe('a');
  });

  it('matches custom_title when name differs', () => {
    const child = session({ sessionId: 'c', name: 'renamed', customTitle: 'impl-wall-editing-p1', startedAt: at(4_000) });
    expect(matchIntent(intent({}), ORCH, [child])?.sessionId).toBe('c');
  });
});

describe('planLinks', () => {
  const parents = new Map([[ORCH.sessionId, ORCH]]);

  it('links each child once, preferring a spawn over a message', () => {
    const p3 = session({ sessionId: 'p3', name: 'impl-wall-editing-p3', startedAt: at(3_000) });
    const spawn = intent({ name: 'impl-wall-editing-p3' });
    const msg = intent({ kind: 'message', name: 'impl-wall-editing-p3', at: at(40_000) });
    const plan = planLinks([msg, spawn], parents, [p3]);
    expect(plan.links).toEqual([{ childSessionId: 'p3', parentSessionId: 'orch', intent: spawn }]);
    expect(plan.resolved.size).toBe(2);
  });

  it('resolves but does not relink a child that already has a parent', () => {
    const p2 = session({ sessionId: 'p2', name: 'impl-wall-editing-p2', startedAt: at(2_000), parentSessionId: 'x', parentLinkSource: 'hook' });
    const i = intent({ name: 'impl-wall-editing-p2' });
    const plan = planLinks([i], parents, [p2]);
    expect(plan.links).toEqual([]);
    expect(plan.resolved.has(i)).toBe(true);
  });

  it('leaves an intent unresolved when its parent or child is not ingested yet', () => {
    const orphan = intent({ parentSessionId: 'unknown' });
    const early = intent({ name: 'impl-wall-editing-p9' });
    const plan = planLinks([orphan, early], parents, []);
    expect(plan.links).toEqual([]);
    expect(plan.resolved.size).toBe(0);
  });
});
```

### Step 5: Unit tests — the worker
**File:** `tests/unit/sessions/linkWorker.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LINKS_BACKFILL_VERSION,
  LINKS_MARKER_PREFIX,
  scanTranscriptForIntents,
  startLinkWorker,
  type LinkSession,
  type LinkStore,
  type LinkWorker,
  type TranscriptRef,
} from '../../../src/sessions/links.js';

const HOST = 'lenovo';
const HOME = '/home/u';
const WT = '/home/u/.worktrees/demo/x';
const T = Date.parse('2026-10-30T09:19:49.264Z');
const at = (ms: number) => new Date(T + ms);

function session(over: Partial<LinkSession> & { sessionId: string }): LinkSession {
  return {
    host: HOST,
    repo: 'demo',
    cwd: WT,
    name: null,
    customTitle: null,
    startedAt: at(0),
    parentSessionId: null,
    parentLinkSource: null,
    ...over,
  };
}

function bash(sessionId: string, ms: number, command: string): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    cwd: WT,
    timestamp: at(ms).toISOString(),
    message: { content: [{ type: 'tool_use', id: `t${ms}`, name: 'Bash', input: { command } }] },
  };
}

function fakeStore(sessions: LinkSession[], transcripts: TranscriptRef[] = []) {
  const settings = new Map<string, unknown>();
  const calls = { transcripts: 0, setParent: [] as Array<[string, string]> };
  const store: LinkStore = {
    async sessionsByIds(ids) {
      return sessions.filter((s) => ids.includes(s.sessionId));
    },
    async sessionsByNames(host, names) {
      return sessions.filter(
        (s) => s.host === host && ((s.name !== null && names.includes(s.name)) || (s.customTitle !== null && names.includes(s.customTitle))),
      );
    },
    async transcriptsOnHost() {
      calls.transcripts += 1;
      return transcripts;
    },
    async setParent(child, parent) {
      calls.setParent.push([child, parent]);
      const s = sessions.find((x) => x.sessionId === child);
      if (s && s.parentSessionId === null) {
        s.parentSessionId = parent;
        s.parentLinkSource = 'heuristic';
      }
    },
    async readSetting(key) {
      return settings.get(key) ?? null;
    },
    async writeSetting(key, value) {
      settings.set(key, value);
    },
  };
  return { store, settings, calls };
}

let dir: string;
let workers: LinkWorker[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'links-'));
  workers = [];
});

afterEach(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

function start(store: LinkStore, over: Partial<Parameters<typeof startLinkWorker>[0]> = {}): LinkWorker {
  const w = startLinkWorker({ store, host: HOST, home: HOME, debounceMs: 60_000, log: () => {}, onError: () => {}, ...over });
  workers.push(w);
  return w;
}

async function writeTranscript(name: string, records: unknown[], partialTail = ''): Promise<string> {
  const file = path.join(dir, `${name}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n' + partialTail);
  return file;
}

describe('scanTranscriptForIntents', () => {
  it('reads intents, skips a partial last line, and returns [] for a missing file', async () => {
    const file = await writeTranscript(
      'orch',
      [{ type: 'user', message: { content: 'hi' } }, bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 1')],
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"to":"impl-x-p9"',
    );
    const intents = await scanTranscriptForIntents(file, 'orch', { home: HOME });
    expect(intents.map((i) => i.name)).toEqual(['impl-x-p1']);
    expect(await scanTranscriptForIntents(path.join(dir, 'gone.jsonl'), 'gone', { home: HOME })).toEqual([]);
  });
});

describe('startLinkWorker backfill', () => {
  it('links from transcripts once, writes the marker, and skips the scan next time', async () => {
    const file = await writeTranscript('orch', [
      bash('orch', 0, 'S=~/.claude/skills/swarm/swarm.py; for n in 1 2; do python3 $S spawn --slug x --phase $n; done'),
    ]);
    const sessions = [
      session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'p1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'p2', name: 'impl-x-p2', startedAt: at(4_000), parentSessionId: 'y', parentLinkSource: 'env' }),
    ];
    const { store, settings, calls } = fakeStore(sessions, [{ sessionId: 'orch', transcriptPath: file }]);
    const w = start(store);
    await w.onPassComplete({ initial: true });

    expect(calls.setParent).toEqual([['p1', 'orch']]);
    expect(sessions[2]!.parentSessionId).toBe('y');
    expect(settings.get(`${LINKS_MARKER_PREFIX}${HOST}`)).toMatchObject({ version: LINKS_BACKFILL_VERSION, linked: 1, intents: 2, matched: 2 });

    const again = start(store);
    await again.onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(1);
  });

  it('re-runs when the marker carries an older version', async () => {
    const { store, settings, calls } = fakeStore([], []);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION - 1 });
    await start(store).onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(1);
    expect(settings.get(`${LINKS_MARKER_PREFIX}${HOST}`)).toMatchObject({ version: LINKS_BACKFILL_VERSION });
  });

  it('never rejects when the store fails, and writes no marker', async () => {
    const { store, settings } = fakeStore([], []);
    store.transcriptsOnHost = async () => {
      throw new Error('db down');
    };
    const onError = vi.fn();
    await expect(start(store, { onError }).onPassComplete({ initial: true })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('backfill', expect.any(Error));
    expect(settings.size).toBe(0);
  });
});

describe('startLinkWorker live path', () => {
  it('holds an intent until its child is ingested, then links it', async () => {
    const sessions = [session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) })];
    const { store, settings, calls } = fakeStore(sessions);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION });
    const w = start(store, { now: () => at(5_000) });
    await w.onPassComplete({ initial: true });

    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 3')] });
    expect(w.pendingCount()).toBe(1);
    await w.drainNow();
    expect(w.pendingCount()).toBe(1);
    expect(calls.setParent).toEqual([]);

    sessions.push(session({ sessionId: 'p3', name: 'impl-x-p3', startedAt: at(3_000) }));
    w.onBatch({ sessionId: 'p3', records: [] });
    await w.drainNow();
    expect(calls.setParent).toEqual([['p3', 'orch']]);
    expect(w.pendingCount()).toBe(0);
  });

  it('drops an intent whose window has long passed', async () => {
    const sessions = [session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) })];
    const { store, settings } = fakeStore(sessions);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION });
    const w = start(store, { now: () => at(30 * 60_000) });
    await w.onPassComplete({ initial: true });
    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 3')] });
    await w.drainNow();
    expect(w.pendingCount()).toBe(0);
  });

  it('does nothing after close', async () => {
    const { store, calls } = fakeStore([session({ sessionId: 'orch', startedAt: at(-1) })]);
    const w = start(store);
    await w.close();
    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 1')] });
    expect(w.pendingCount()).toBe(0);
    await w.onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(0);
  });

  it('survives a record that is not an object', () => {
    const { store } = fakeStore([]);
    const w = start(store);
    expect(() => w.onBatch({ sessionId: 's', records: [null, 7, 'x', { type: 'assistant', message: 'nope' }] })).not.toThrow();
  });
});
```

### Step 6: Integration test over a fixture Claude home
**File:** `tests/integration/sessions.links.int.test.ts` (new)
**Change:** Seeds `cc_sessions` rows with raw SQL (the test, like other integration tests, writes
fixture rows directly; production code goes through the repo), writes real JSONL transcripts in a
temp Claude home laid out like `~/.claude/projects/<dir>/<uuid>.jsonl`, and runs the worker
against Postgres with the real `SessionsRepo`.
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { LINKS_BACKFILL_VERSION, LINKS_MARKER_PREFIX, dbLinkStore, startLinkWorker } from '../../src/sessions/links.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'links-int-host';
const HOME = '/home/u';
const MAIN = '/home/u/demo';
const WT = '/home/u/.worktrees/demo/x';
const T0 = Date.parse('2026-10-30T09:16:21.489Z');
const at = (ms: number) => new Date(T0 + ms);

const ANALYZE = '00000000-0000-4000-8000-0000000000a1';
const ORCH = '00000000-0000-4000-8000-0000000000b1';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P1_OLD = '00000000-0000-4000-8000-0000000000c0';
const P1_GPD = '00000000-0000-4000-8000-0000000000c9';
const P2 = '00000000-0000-4000-8000-0000000000c2';
const P3 = '00000000-0000-4000-8000-0000000000c3';
const P4 = '00000000-0000-4000-8000-0000000000c4';
const HAND = '00000000-0000-4000-8000-0000000000d1';

function assistant(sessionId: string, cwd: string, ms: number, name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    sessionId,
    cwd,
    entrypoint: 'cli',
    isSidechain: false,
    timestamp: at(ms).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${ms}`, name, input }] },
  };
}

async function writeTranscript(home: string, dirName: string, sessionId: string, records: unknown[]): Promise<string> {
  const dir = path.join(home, 'projects', dirName);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

interface Seed {
  sessionId: string;
  nodeId: string;
  host?: string;
  repo: string;
  cwd: string;
  name: string;
  startedAt: Date;
  transcriptPath?: string | null;
  parent?: { id: string; source: 'env' | 'hook' | 'heuristic' };
}

async function insertSession(db: Db, s: Seed): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, custom_title, entrypoint,
                             started_at, last_active_at, transcript_path, parent_session_id, parent_link_source)
    values (${s.sessionId}, ${s.nodeId}, ${s.host ?? HOST}, ${s.repo}, ${s.cwd}, ${s.name}, ${s.name}, 'cli',
            ${s.startedAt.toISOString()}::timestamptz, ${s.startedAt.toISOString()}::timestamptz,
            ${s.transcriptPath ?? null}, ${s.parent?.id ?? null}, ${s.parent?.source ?? null})
  `);
}

async function parentOf(db: Db, sessionId: string): Promise<{ parent: string | null; source: string | null }> {
  const res = await db.execute<{ parent_session_id: string | null; parent_link_source: string | null }>(sql`
    select parent_session_id, parent_link_source from cc_sessions where session_id = ${sessionId}
  `);
  const row = res.rows[0];
  return { parent: row?.parent_session_id ?? null, source: row?.parent_link_source ?? null };
}

describe('heuristic parent links over a fixture Claude home', () => {
  let db: Db;
  let repo: SessionsRepo;
  let home: string;

  beforeAll(() => {
    db = openTestDb();
    repo = new SessionsRepo(db);
  });

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    await closeTestDb(db);
  });

  beforeEach(async () => {
    await truncateAll(db); // phase 1 extended it to the cc_* tables and app_settings
    await db.execute(sql`delete from app_settings where key like ${`${LINKS_MARKER_PREFIX}%`}`);
    if (home) await rm(home, { recursive: true, force: true });
    home = await mkdtemp(path.join(tmpdir(), 'claude-home-'));

    const analyzeFile = await writeTranscript(home, '-home-u-demo', ANALYZE, [
      { type: 'custom-title', customTitle: 'analyze-demo-x', sessionId: ANALYZE },
      assistant(ANALYZE, MAIN, 0, 'Bash', {
        command:
          'cd $HOME/.worktrees/demo/x && git log --oneline -1 && python3 ~/.claude/skills/swarm/swarm.py launch --name "orch-demo-x" --cwd "$HOME/.worktrees/demo/x" --permission-mode bypassPermissions --prompt "/analyze-orchestrator -f docs/plans/X_PLAN.md"',
      }),
    ]);
    const orchFile = await writeTranscript(home, '-home-u--worktrees-demo-x', ORCH, [
      { type: 'agent-name', agentName: 'orch-demo-x', sessionId: ORCH },
      assistant(ORCH, WT, 180_000, 'Bash', {
        command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug demo-x --phase 3 --dry-run',
      }),
      assistant(ORCH, WT, 200_000, 'Bash', {
        command: 'S=~/.claude/skills/swarm/swarm.py; for n in 1 2; do python3 $S spawn --slug demo-x --phase $n | tail -3; done',
      }),
      assistant(ORCH, WT, 240_000, 'SendMessage', { to: 'impl-demo-x-p1', recipient: 'impl-demo-x-p1', message: 'rules' }),
    ]);

    await insertSession(db, { sessionId: ANALYZE, nodeId: 'L4-A1', repo: 'demo', cwd: MAIN, name: 'analyze-demo-x', startedAt: at(-60_000), transcriptPath: analyzeFile });
    await insertSession(db, { sessionId: ORCH, nodeId: 'L4-B1', repo: 'demo', cwd: WT, name: 'orch-demo-x', startedAt: at(2_300), transcriptPath: orchFile });
    await insertSession(db, { sessionId: P1, nodeId: 'L4-C1', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(203_808), transcriptPath: path.join(home, 'projects', 'gone', `${P1}.jsonl`) });
    await insertSession(db, { sessionId: P1_OLD, nodeId: 'L4-C0', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(-86_400_000) });
    await insertSession(db, { sessionId: P1_GPD, nodeId: 'L4-C9', host: 'other-host', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(204_000) });
    await insertSession(db, { sessionId: HAND, nodeId: 'L4-D1', repo: 'demo', cwd: MAIN, name: 'by-hand', startedAt: at(100_000) });
    await insertSession(db, { sessionId: P2, nodeId: 'L4-C2', repo: 'demo', cwd: WT, name: 'impl-demo-x-p2', startedAt: at(204_500), parent: { id: HAND, source: 'hook' } });
    await insertSession(db, { sessionId: P3, nodeId: 'L4-C3', repo: 'demo', cwd: WT, name: 'impl-demo-x-p3', startedAt: at(183_000) });
  });

  it('links launched and spawned children as heuristic, and nothing else', async () => {
    const worker = startLinkWorker({ store: dbLinkStore(db, repo), host: HOST, home: HOME, debounceMs: 60_000, log: () => {} });
    try {
      await worker.onPassComplete({ initial: true });
    } finally {
      await worker.close();
    }

    expect(await parentOf(db, ORCH)).toEqual({ parent: ANALYZE, source: 'heuristic' });
    expect(await parentOf(db, P1)).toEqual({ parent: ORCH, source: 'heuristic' });
    expect(await parentOf(db, P2)).toEqual({ parent: HAND, source: 'hook' });
    expect(await parentOf(db, P3)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, P1_OLD)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, P1_GPD)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, ANALYZE)).toEqual({ parent: null, source: null });

    const marker = await db.execute<{ value: { version: number; linked: number } }>(sql`
      select value from app_settings where key = ${`${LINKS_MARKER_PREFIX}${HOST}`}
    `);
    expect(marker.rows[0]?.value).toMatchObject({ version: LINKS_BACKFILL_VERSION, linked: 2 });
  });

  it('never replaces an env link on a re-run', async () => {
    await repo.setParent(P1, HAND, 'env');
    const worker = startLinkWorker({ store: dbLinkStore(db, repo), host: HOST, home: HOME, debounceMs: 60_000, log: () => {} });
    try {
      await worker.onPassComplete({ initial: true });
    } finally {
      await worker.close();
    }
    expect(await parentOf(db, P1)).toEqual({ parent: HAND, source: 'env' });
    expect(await parentOf(db, ORCH)).toEqual({ parent: ANALYZE, source: 'heuristic' });
  });

  it('links a child spawned while the daemon runs, from the batch records', async () => {
    const worker = startLinkWorker({
      store: dbLinkStore(db, repo),
      host: HOST,
      home: HOME,
      debounceMs: 60_000,
      log: () => {},
      now: () => at(605_000),
    });
    try {
      await worker.onPassComplete({ initial: true });
      worker.onBatch({
        sessionId: ORCH,
        host: HOST,
        records: [assistant(ORCH, WT, 600_000, 'Bash', { command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug demo-x --phase 4' })],
      });
      await insertSession(db, { sessionId: P4, nodeId: 'L4-C4', repo: 'demo', cwd: WT, name: 'impl-demo-x-p4', startedAt: at(603_000) });
      worker.onBatch({ sessionId: P4, host: HOST, records: [] });
      const report = await worker.drainNow();
      expect(report.linked).toBe(1);
    } finally {
      await worker.close();
    }
    expect(await parentOf(db, P4)).toEqual({ parent: ORCH, source: 'heuristic' });
  });
});
```
**Impact:** Runs in `npm run test:int` against the Docker Postgres; no network, no real `~/.claude`.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/sessions/links.test.ts tests/unit/sessions/linkWorker.test.ts`, then `npm test`; `npm run test:int` (includes `tests/integration/sessions.links.int.test.ts`)
**Manual check:** with the daemon running on this machine after landing (sessions on), wait for
the log line `session links backfilled on <host>: …`, then in psql:
`select name, parent_link_source from cc_sessions where parent_session_id = 'cc6491fc-2dc1-4f2d-9d28-db3fbf6baa0a' order by name;`
should list `impl-wall-editing-p1` … `-p11` (11 rows, `heuristic`), and
`select parent_session_id from cc_sessions where session_id = 'cc6491fc-2dc1-4f2d-9d28-db3fbf6baa0a';`
should be `930c1249…` (`analyze-wall-editing`). Restart the daemon: the line does not appear again.
**Exit criteria:** the fixture where an orch session launches `impl-demo-x-p1` links the child to
the orch as `heuristic`; a child with an `env` or `hook` parent keeps it; the backfill scan runs
once per host (marker in `app_settings`); typecheck, unit and integration suites green.

## Handoffs

- **Phase 3 (recall, optional):** 46 sessions carry more than one name (renamed after launch).
  The matcher only sees the current `name`/`custom_title`. Keeping the launch name (the first
  `agent-name`) would let renamed children link too. Not required for R3; left to Phase 3 or a follow-up.
- **Phase 3 (possible tidy-up):** `scanTranscriptForIntents` has its own `readLines` loop; if
  Phase 3 exports a streaming line reader, the scan can use it. Behaviour is identical either way.
- **Phase 1 (API):** the marker goes through `SessionsRepo.getSetting/putSetting` (reconciled).
- **Phases 7, 10, 11:** `parent_link_source = 'heuristic'` is a guess; the read API should carry
  the source and the graph may draw these edges differently (e.g. dashed). Not done here.
- **Phase 6:** edits `startBackground` after this phase (not `ingest.ts`); keep the linker's close in
  the stop function and the `observers` option.
- **Phase 14:** document heuristic links, the windows, and the once-per-host marker
  `sessions.links.backfill.<host>` (deleting that row forces a re-scan) in the README.

## Rollback

Revert this phase's commit: deletes `src/sessions/links.ts` and its tests, and removes the three
insertions in `src/background.ts`.
Data: links it wrote are `parent_link_source = 'heuristic'` and can be cleared with
`update cc_sessions set parent_session_id = null, parent_link_source = null where parent_link_source = 'heuristic';`
and `delete from app_settings where key like 'sessions.links.backfill.%';`. Env/hook links are untouched.

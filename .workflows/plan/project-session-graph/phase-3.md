# Phase 3: Transcript ingest, repo resolution, live registry, backfill

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R1 — every Claude Code terminal session on this machine becomes (and stays) a `cc_sessions` row: backfilled at landing, tailed incrementally, both hosts writing with their own `host`
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/sessions`, `src/config.ts`, `src/background.ts`

---

## Goal

After this phase the daemon reads every `~/.claude/projects/<dir>/<uuid>.jsonl` of this machine
at startup (backfill), keeps reading only the bytes appended since the stored offset (watcher +
60 s sweep), and keeps one `cc_sessions` row per `cli` session current through phase 1's
`SessionsRepo.upsertFromTranscript`: repo (also for deleted worktrees), cwd, branch, name, titles,
first/last prompt, prompts, times, tokens/cost/models, commits, files edited, plan docs, final
message, transcript path/offset. `sdk-ts`/`sdk-cli` sessions are skipped. A read-only live
registry (`~/.claude/sessions/*.json` with pid liveness) is available for phases 6/7, and an
`IngestObserver` extension point is available for phase 4 (and anyone later).

## Measurements this plan is built on (read-only, this machine, 2026-11-02)

- 596 top-level transcripts today (628 when the brief was written: Claude Code pruned some),
  166 project dirs; `<dir>/<uuid>/subagents/agent-*.jsonl` (1 100+ more files) and `<dir>/memory/`
  live beside them and must be ignored. Longest single line: 1.6 MB.
- File stem == every record's `sessionId` (0 files with more than one). The first `cwd` of every
  file encodes (non-alnum -> `-`) to its project dir name (0 mismatches); 239 files later carry
  other cwds (`cd` into a worktree/subdir), so cwd comes only from a read at byte 0.
- `entrypoint` counts: cli 161 591, sdk-cli 963, sdk-ts 543 records; no file mixes them. sdk dirs
  include `-home-miftah-mcp-notes-data-chat`, `/tmp/...-data-chat`, and plain repo dirs (`/n` helper).
- 71 873 assistant records, 35 438 of them repeat an earlier `message.id` with identical `usage`
  (one record per content block) -> usage must be counted once per message id.
- `cost-state` (635 records): cumulative `totalCostUSD`; 25 files have several (resume), the
  latest is the running total.
- Human prompts: `origin.kind` is `human` or absent for typed prompts; `peer` (SendMessage from
  another session), `task-notification`, `sdk` are not prompts; `[Request interrupted by user]` and
  bare `/model`-style commands are noise.
- Commits: `git commit` tool_results read `[<branch> <sha>] <subject>` (verified on real results).
- `~/.claude/sessions/`: 39 `<pid>.json` (+ `<pid>.<hash>.key` files), only 5 alive; `procStart`
  equals field 22 of `/proc/<pid>/stat` for the live ones.
- A prototype of exactly the code below, run read-only against the real `~/.claude` with an
  in-memory store: backfill 838 MB in 2.2-5.1 s, +66-70 MB RSS, 565 rows, 14 repo keys, 0 nulls,
  143 commits; the following sweep 13 ms / 0 bytes. The parent session `d5c27d87-...` resolves to
  repo `mcp-notes`, name `session-graph-discussion`, ai title `Project session graph`.
- The whole tree with this phase applied (phase 1's `types.ts`/`merge.ts` copied from its plan, its
  `repo.ts`/schema stubbed to the published signatures) typechecks and `vitest run tests/unit`
  passes (67 files, 838 tests); the session tests were run 3x with no flake.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/config.ts`: `interface SessionsConfig { claudeHome: string; worktreesDir: string; enabled: boolean }`,
  `DEFAULT_SESSIONS_CONFIG` (default paths, `enabled: false`), `DEFAULT_CLAUDE_HOME = '~/.claude'`,
  `DEFAULT_WORKTREES_DIR = '~/.worktrees'`, `parseSessions(env): SessionsConfig`; env
  `CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SESSIONS` (`on|off|1|0|true|false|yes|no`, default on).
- `src/sessions/transcript.ts`: `IGNORED_RECORD_TYPES`, `EXCLUDED_ENTRYPOINTS`, `EDIT_TOOLS`,
  `PLAN_DOC_PATH`, `DEFAULT_READ_CHUNK_BYTES`, types `TranscriptRecord`, `TranscriptCarry`,
  `TranscriptDelta`, `PatchContext`, `ReadJsonlOptions`, `ReadJsonlResult`; functions `isObject`,
  `parseRecord`, `readJsonlFrom`, `typedFromCommandXml`, `isHumanPrompt`, `promptText`,
  `toolResultText`, `parseCommitLines`, `emptyCarry`, `accumulateText`, `buildTranscriptPatch`;
  class `TranscriptAccumulator`.
- `src/sessions/repoResolve.ts`: `GitRoots`, `RepoResolverOptions`, `RepoResolver`,
  `encodeProjectDir`, `repoFromWorktreePath`, `repoFromClaudeWorktree`, `repoFromGitRoots`,
  `repoFromPath`, `repoFromProjectDir`, `gitRepoRoots`, `createRepoResolver`.
- `src/sessions/registry.ts`: `LiveSession`, `PidAliveCheck`, `RegistryOptions`, `LiveRegistry`,
  `DEFAULT_REGISTRY_TTL_MS`, `procStartTime`, `isPidAlive`, `parseLiveEntry`,
  `readLiveRegistry(opts): Promise<Map<sessionId, LiveSession>>`,
  `readLiveSessions(claudeHome, isAlive?): Promise<LiveSession[]>` (the name phase 6 imports),
  `createLiveRegistry(opts & {ttlMs?, now?}): LiveRegistry` (2 s cache, for phase 7).
- `src/sessions/ingest.ts`: `IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'>`,
  `IngestReason`, `IngestReport`, `IngestBatch`, `IngestPass`, **`IngestObserver`** (extension
  point), `SessionIngestOptions`, `SessionIngester`, `DEFAULT_SWEEP_MS`, `DEFAULT_WATCH_DEBOUNCE_MS`,
  `DEFAULT_INGEST_CONCURRENCY`, `DEFAULT_CLOSE_GRACE_MS`, `TranscriptFile`, `sessionIdFromPath`,
  `isExcludedProjectDir`, `listTranscripts`, `isIgnoredWatchPath`, `startSessionIngest`, `formatReport`.
- Tests/fixtures: `tests/fixtures/claude-home/**`, `tests/helpers/claudeHome.ts`,
  `tests/helpers/memoryIngestStore.ts` (`MemoryIngestStore`, `blankSessionRow`),
  `tests/unit/sessions/{transcript,repoResolve,registry,ingest}.test.ts`,
  `tests/integration/sessions.ingest.int.test.ts`.

**The extension point (published for phases 4 and 6):**
```ts
// src/sessions/ingest.ts
export interface IngestBatch {
  sessionId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  /** Parsed records of the complete lines read, in file order (ignored record types excluded). */
  records: readonly TranscriptRecord[];
}
export interface IngestPass {
  initial: boolean;                 // first full pass this process completed (the startup backfill)
  reason: 'backfill' | 'sweep';
  sessionIds: string[];             // rows written during the pass (may be empty)
  report: IngestReport;
}
export interface IngestObserver {
  onBatch?(batch: IngestBatch): void;                          // after each committed write
  onPassComplete?(pass: IngestPass): void | Promise<void>;     // after every full sweep
}
// startSessionIngest({ ..., observers?: IngestObserver[] }) and ingester.addObserver(o) => unsubscribe
```
This is exactly phase 4's requested `IngestObserver` shape (`onBatch({sessionId, host, records})`,
`onPassComplete({initial})`, `observers?: IngestObserver[]` on the start options), widened with
extra fields that its `LinkWorker` accepts structurally, so **phase 4's Step 3 ("observer hook in
ingest.ts, only if phase 3 lacks it") is not needed**. Observers are called after the commit, never
awaited; throws and rejections are logged (`[notesd] sessions: observer failed: ...`) and dropped.
Watcher-driven reads fire `onBatch` only; `onPassComplete` fires after the backfill and after every
60 s sweep. Phase 6 (summaries) needs no ingest trigger (its own plan polls `last_active_at`); it
can still `addObserver` later if it wants one.

**Signature changes:** `interface Config` gains the required field `sessions: SessionsConfig`
(every hand-built `Config` literal changes, Step 9). `startBackground(deps)` keeps its signature.
**Requires (from earlier phases):** Phase 1, as published in its plan:
- `src/sessions/types.ts`: `TranscriptPatch` (with `fromOffset`/`toOffset`/`size`, delta
  `tokens`/`models`, absolute `costUsd`, `SessionPrompt[]` prompts, `SessionCommit[]` commits,
  null-means-keep scalars), `TranscriptUpsertResult`, `TranscriptOffset {offset,size,path}`,
  `SessionRow`, `TokenCounts {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`,
  `ModelUsage`, `SessionPrompt {text, at}`, `SessionCommit {sha, subject, at}`,
  `SessionsRepoOptions`, and the constants `MAX_PROMPTS`, `MAX_PROMPT_CHARS`, `MAX_TITLE_CHARS`,
  `MAX_COMMITS`, `MAX_FILES_EDITED`, `MAX_PLAN_DOCS`, `MAX_FINAL_MESSAGE_CHARS`.
- `src/sessions/merge.ts`: `mergeTranscriptPatch(row, patch)` (used by the test helper only).
- `src/sessions/repo.ts`: `new SessionsRepo(db)`, `offsets(host)`, `upsertFromTranscript(patch)`
  as a compare-and-set on `transcript_offset` (`fromOffset === 0` replaces accumulators), returning
  `offset_mismatch`/`other_host` without writing, and `getBySessionId` (integration test).
- `tests/integration/setup.ts` `truncateAll` covering the cc tables is NOT required: the
  integration test deletes its own fixture session ids.

**Leaves alone (owned by others):** `src/db/schema.ts`, `drizzle/*`, `src/sessions/{ids,types,merge,repo}.ts`
(phase 1); `src/sessions/links.ts` (phase 4); `claude/hooks/*`, `src/http/sessionHooks.ts`,
`scripts/*` (phase 5); `src/sessions/{summarize,redact,summaryWorker,search}.ts` and the summary
block in `startBackground` (phase 6); `src/http/*`, `src/mcp/*`, `src/chat/*` (7, 9, 12);
`web/*` (10-13); `SessionsConfig.swarmScript` (phase 13 adds it to the interface, the default
object and `parseSessions`); docs (14).

## Design decisions (and why)

1. **Deltas through phase 1's compare-and-set, not read-modify-write.** Each read produces a
   patch for exactly bytes `[fromOffset, toOffset)`; the repo adds it under a row lock only if the
   stored offset still equals `fromOffset`. A replay, a crash between write and memory update, or
   a second ingester changes nothing; on `offset_mismatch` ingest adopts `storedOffset` and reads
   once more. A file that shrank is re-read with `fromOffset: 0`, which replaces the accumulators.
2. **cwd / entrypoint / repo only from a read at byte 0.** The launch cwd is the first record's;
   a later read's first cwd may be a `cd` target (239 files). Later reads send null (= keep).
3. **Tokens are summed from assistant `usage`, deduped by `message.id`** (with a 16-id carry
   across reads); `cost_usd` is the latest `cost-state.totalCostUSD` (absolute). Phase 1's patch
   contract has delta tokens and absolute cost; this matches it without mixing the two.
4. **Entrypoint exclusion needs the first message.** A file whose first read has no entrypoint and
   no row yet is deferred (re-read from 0 when it grows); one with an `sdk-*` entrypoint is never
   written and not re-read in this process. `-data-chat` project dirs are not even listed.
   A row created earlier by phase 5's hook (offset 0, entrypoint null) is still filled in.
5. **Repo key rules** (most specific first, no disk needed for worktrees): `~/.worktrees/<repo>/...`
   -> `<repo>`; `<root>/.claude/worktrees/...` -> basename(root); `~` -> `~`; existing git dir ->
   main checkout name via `--git-common-dir`; under home -> first segment; else basename. The
   brief's "else basename" is refined to "first segment under home" because `~/agentic/docs/plans`
   (a real cwd here) must be `agentic`, not `plans`.
6. **`Config.sessions` is required, `DEFAULT_SESSIONS_CONFIG` is off.** Phases 4/6/13 plan
   against `deps.config.sessions.enabled` (non-optional) and `DEFAULT_SESSIONS_CONFIG`; making the
   test default `enabled: false` means no hand-built test config can ever ingest the real `~/.claude`
   (invariant 2). `loadConfig` defaults to on for the real daemon. The live chat test, the only test
   that calls `loadConfig` and then `startDaemon`, sets `NOTESD_SESSIONS=off`.
7. **Watcher + sweep.** chokidar (already a dependency; the inbox uses it) on depth 1 with an
   `ignored` that keeps only project dirs and `<uuid>.jsonl` inside them, debounced 500 ms per burst;
   a 60 s sweep (stat of ~600 files, ~13 ms) catches anything missed and drives `onPassComplete`.

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts:63` | modify | `SessionsConfig`, `DEFAULT_SESSIONS_CONFIG`, `DEFAULT_CLAUDE_HOME`, `DEFAULT_WORKTREES_DIR` after `DEFAULT_EMBEDDINGS_CONFIG` |
| `src/config.ts:77` | modify | `Config.sessions: SessionsConfig` |
| `src/config.ts:204-207` | modify | `parseSwitch`, `parseSessions` after `parseEmbeddings` |
| `src/config.ts:209-217` | modify | `loadConfig` doc lists the sessions keys |
| `src/config.ts:239` | modify | `sessions: parseSessions(env)` |
| `src/sessions/transcript.ts` | create | reader, parser, accumulator, patch builder |
| `src/sessions/repoResolve.ts` | create | repo key resolution |
| `src/sessions/registry.ts` | create | live registry |
| `src/sessions/ingest.ts` | create | backfill, tail, watcher, sweep, observers |
| `src/background.ts:1-11, 61-67` | modify | imports; session ingest block; close in parallel |
| `tests/fixtures/claude-home/**` (9 files) | create | redacted fixture Claude home |
| `tests/helpers/claudeHome.ts` | create | fixture constants + temp copy |
| `tests/helpers/memoryIngestStore.ts` | create | in-memory `IngestStore` using phase 1's merge |
| `tests/unit/sessions/transcript.test.ts` | create | unit |
| `tests/unit/sessions/repoResolve.test.ts` | create | unit |
| `tests/unit/sessions/registry.test.ts` | create | unit |
| `tests/unit/sessions/ingest.test.ts` | create | unit (temp fixture homes only) |
| `tests/integration/sessions.ingest.int.test.ts` | create | integration against the real repo |
| `tests/unit/config.test.ts:6, :36, end` | modify | import, defaults expectation, sessions describe |
| `tests/unit/embeddings/embedBackfillCli.test.ts:3, :38` | modify | `sessions: DEFAULT_SESSIONS_CONFIG` |
| `tests/integration/daemon.int.test.ts:5, :20` | modify | same |
| `tests/integration/mcp.tools.int.test.ts:9, :21` | modify | same |
| `tests/integration/connectors/mcp.int.test.ts:8, :18` | modify | same |
| `tests/integration/related.int.test.ts:9, :43` | modify | same |
| `tests/integration/images.int.test.ts:9, :139, :170` | modify | same |
| `tests/integration/imageHarness.ts:8, :47` | modify | same |
| `tests/integration/helpers/api-harness.ts:10, :53` | modify | same |
| `tests/integration/embeddings.worker.int.test.ts:9, :102` | modify | same |
| `tests/live/chat.live.test.ts:53` | modify | `NOTESD_SESSIONS: 'off'` |

## Implementation Steps

Step 0 (environment): the worktree has no `node_modules`; run `npm ci` in the worktree first
(phase 1's Step 0 does the same). No new dependency is added: `chokidar` is already in `package.json`.


### Step 1: Session config
**File:** `src/config.ts:63`, `:77`, `:204-207`, `:209-217`, `:239`
**Change:** Add `SessionsConfig`, `DEFAULT_SESSIONS_CONFIG` (off), `DEFAULT_CLAUDE_HOME`, `DEFAULT_WORKTREES_DIR`, `parseSessions(env)`, the required `Config.sessions` field, and `sessions: parseSessions(env)` in `loadConfig`. Below is the whole file after the change (it is short; every hunk is visible in context).
**Code:**
```ts
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'
import type { ChatBrain } from './chat/backend.js'

/**
 * Repo root, resolved from this module's own location so the daemon finds
 * `.env.local` no matter which cwd systemd or a test runner starts it from.
 * `src/config.ts` (tsx, vitest) and `dist/config.js` (built) both sit one
 * level below the root.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_PORT = 7317
export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_DATA_DIR = '~/mcp-notes-data'
export const DEFAULT_CHAT_MAX_TURNS = 24
export const DEFAULT_CHAT_TIMEOUT_MS = 180_000
/** A bare name is looked up on PATH by the SDK; the systemd unit sets an absolute path. */
export const DEFAULT_CLAUDE_BIN = 'claude'

/** The GLM endpoint for the fallback brain (z.ai), from `.env.local`'s `LLM_*` keys. */
export interface GlmConfig {
  /** `LLM_BASE_URL` -> the child's `ANTHROPIC_BASE_URL`. */
  baseUrl: string
  /** `LLM_API_KEY` -> the child's `ANTHROPIC_AUTH_TOKEN`. Never logged. */
  apiKey: string
  /** `LLM_MODEL`, e.g. `glm-5.3`. */
  model: string
}

export interface ChatConfig {
  /** `CHAT_BRAIN`, default `claude`. `glm` runs GLM only (no fallback). */
  brain: ChatBrain
  /** `CHAT_MAX_TURNS`, default 24. Integer >= 1. */
  maxTurns: number
  /** `CHAT_TIMEOUT_MS`, default 180000. Wall clock per chat message. Integer >= 1. */
  timeoutMs: number
  /** `NOTESD_CLAUDE_BIN`, default `claude`. A path is ~-expanded and made absolute. */
  claudeBin: string
  /** Set when all three `LLM_*` keys are; null otherwise (Claude runs then have no fallback). */
  glm: GlmConfig | null
}

/** What `loadConfig` returns for `chat` when no chat key is set. Tests build `Config` literals with it. */
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  brain: 'claude',
  maxTurns: DEFAULT_CHAT_MAX_TURNS,
  timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  claudeBin: DEFAULT_CLAUDE_BIN,
  glm: null,
}

/** OpenRouter embeddings: semantic search, `related`, and the embedding worker. */
export interface EmbeddingsConfig {
  /** `OPENROUTER_API_KEY`, trimmed; null when unset or blank (semantic features off). Never logged. */
  apiKey: string | null
}

/** What `loadConfig` returns for `embeddings` without OPENROUTER_API_KEY. Tests build `Config` literals with it. */
export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = { apiKey: null }

export const DEFAULT_CLAUDE_HOME = '~/.claude'
export const DEFAULT_WORKTREES_DIR = '~/.worktrees'

/** Claude Code session ingest (src/sessions/ingest.ts) and the live registry (src/sessions/registry.ts). */
export interface SessionsConfig {
  /** Absolute. `CLAUDE_HOME`, default ~/.claude: transcripts in `projects/`, live registry in `sessions/`. Read only. */
  claudeHome: string
  /** Absolute. `NOTES_WORKTREES_DIR`, default ~/.worktrees: `<dir>/<repo>/<slug>` maps a worktree session to `<repo>`. */
  worktreesDir: string
  /** `NOTESD_SESSIONS`, default on. `off` (or 0/false/no) starts no session ingest. */
  enabled: boolean
}

/**
 * Sessions off, default paths. Tests build `Config` literals with it, so no test that builds a
 * Config by hand ever reads the real ~/.claude.
 */
export const DEFAULT_SESSIONS_CONFIG: SessionsConfig = {
  claudeHome: path.join(homedir(), '.claude'),
  worktreesDir: path.join(homedir(), '.worktrees'),
  enabled: false,
}

export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
  /** Note embeddings via OpenRouter. `apiKey: null` turns semantic features off. */
  embeddings: EmbeddingsConfig
  /** Claude Code session ingest. `enabled: false` starts nothing (DEFAULT_SESSIONS_CONFIG in tests). */
  sessions: SessionsConfig
}

export interface LoadConfigOptions {
  /** Environment to read. Defaults to `process.env`. Never mutated. */
  env?: NodeJS.ProcessEnv
  /**
   * Dotenv file merged under `env` (real env wins). Defaults to
   * `<REPO_ROOT>/.env.local`; `false` skips it. A missing file is not an error.
   */
  envFile?: string | false
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function readEnvFile(file: string | false): Record<string, string> {
  if (file === false || !existsSync(file)) return {}
  return parseDotenv(readFileSync(file))
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  const port = Number(trimmed)
  if (port > 65535) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  return port
}

/** True when `url` parses and its host is a Neon pooler host (`...-pooler...`). */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).host.includes('-pooler')
  } catch {
    return false
  }
}

/**
 * The runtime database URL.
 * 1. `DATABASE_URL` in the real environment (`options.env` / `process.env`) wins outright:
 *    tests and test-port runs point the daemon at the Docker Postgres this way.
 * 2. Otherwise, of `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (file merged under env), the
 *    pooled one if either is pooled, else whichever exists. The owner's `.env.local` has the two
 *    key names swapped, so the choice goes by host, never by name.
 */
function pickDatabaseUrl(
  realEnv: Record<string, string | undefined>,
  merged: Record<string, string | undefined>,
): string | undefined {
  const explicit = realEnv.DATABASE_URL?.trim()
  if (explicit) return explicit
  const candidates = [merged.DATABASE_URL, merged.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
  return candidates.find(isPooledUrl) ?? candidates[0]
}

function parseHost(raw: string | undefined): typeof LOOPBACK_HOST {
  if (raw === undefined || raw.trim() === '' || raw.trim() === LOOPBACK_HOST) return LOOPBACK_HOST
  throw new ConfigError(
    `NOTESD_HOST is "${raw}". notesd has no auth and binds ${LOOPBACK_HOST} only; ` +
      'unset NOTESD_HOST or set it to 127.0.0.1.',
  )
}

function parseBrain(raw: string | undefined): ChatBrain {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'claude') return 'claude'
  if (value === 'glm') return 'glm'
  throw new ConfigError(`CHAT_BRAIN must be "claude" or "glm", got "${raw}"`)
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
  }
  return Number(trimmed)
}

function parseClaudeBin(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_CLAUDE_BIN
  // A bare command name stays a PATH lookup; anything with a slash is a path.
  return value.includes('/') ? path.resolve(expandHome(value)) : value
}

const GLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const

function parseGlm(env: Record<string, string | undefined>): { glm: GlmConfig | null; missing: string[] } {
  const values = GLM_KEYS.map((key) => env[key]?.trim() ?? '')
  const missing = GLM_KEYS.filter((_, i) => values[i] === '')
  if (missing.length > 0) return { glm: null, missing }
  const [baseUrl = '', apiKey = '', model = ''] = values
  return { glm: { baseUrl, apiKey, model }, missing }
}

function parseChat(env: Record<string, string | undefined>): ChatConfig {
  const brain = parseBrain(env.CHAT_BRAIN)
  const { glm, missing } = parseGlm(env)
  if (brain === 'glm' && glm === null) {
    throw new ConfigError(
      `CHAT_BRAIN=glm needs ${missing.join(', ')} (set them in ${path.join(REPO_ROOT, '.env.local')}).`,
    )
  }
  return {
    brain,
    maxTurns: parsePositiveInt('CHAT_MAX_TURNS', env.CHAT_MAX_TURNS, DEFAULT_CHAT_MAX_TURNS),
    timeoutMs: parsePositiveInt('CHAT_TIMEOUT_MS', env.CHAT_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
    claudeBin: parseClaudeBin(env.NOTESD_CLAUDE_BIN),
    glm,
  }
}

function parseEmbeddings(env: Record<string, string | undefined>): EmbeddingsConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? ''
  return { apiKey: apiKey === '' ? null : apiKey }
}

function parseSwitch(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'on' || value === '1' || value === 'true' || value === 'yes') return true
  if (value === 'off' || value === '0' || value === 'false' || value === 'no') return false
  throw new ConfigError(`${name} must be "on" or "off", got "${raw}"`)
}

export function parseSessions(env: Record<string, string | undefined>): SessionsConfig {
  return {
    claudeHome: path.resolve(expandHome(env.CLAUDE_HOME?.trim() || DEFAULT_CLAUDE_HOME)),
    worktreesDir: path.resolve(expandHome(env.NOTES_WORKTREES_DIR?.trim() || DEFAULT_WORKTREES_DIR)),
    enabled: parseSwitch('NOTESD_SESSIONS', env.NOTESD_SESSIONS),
  }
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Sessions keys: CLAUDE_HOME, NOTES_WORKTREES_DIR, NOTESD_SESSIONS. Other keys are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, on CHAT_BRAIN=glm without LLM_*,
 * or on a NOTESD_SESSIONS value other than on/off.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
    sessions: parseSessions(env),
  }
}
```
**Impact:** `Config` gains a required field: every hand-built `Config` literal must add `sessions` (Step 9). `loadConfig()` now throws `ConfigError` on a bad `NOTESD_SESSIONS`. The real daemon (`src/main.ts` -> `loadConfig`) gets sessions **on** by default.

### Step 2: Transcript parser and accumulator
**File:** `src/sessions/transcript.ts` (new)
**Change:** Streaming byte-offset JSONL reader, record parser with a pre-JSON.parse type filter, TS port of the hook's human-prompt rules, the per-read `TranscriptAccumulator`, and `buildTranscriptPatch` (phase 1's `TranscriptPatch`).
**Code:**
```ts
import { open } from 'node:fs/promises';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type ModelUsage,
  type SessionCommit,
  type SessionPrompt,
  type TokenCounts,
  type TranscriptPatch,
} from './types.js';

/**
 * Claude Code transcript reading for session ingest (`~/.claude/projects/<dir>/<uuid>.jsonl`).
 * Pure parsing plus one streaming byte-offset reader; `ingest.ts` walks the files and writes rows
 * through `SessionsRepo.upsertFromTranscript`, whose merge (`merge.ts`, phase 1) adds this
 * module's per-read deltas onto the stored row. The hooks have a JS copy of the prompt helpers
 * in `claude/hooks/lib/transcript.mjs`; the rules here are the same, ported to TypeScript.
 *
 * Shapes this relies on (measured 2026-11-02 over 628 transcripts, Claude Code 2.1.150-2.1.311):
 * - One file per session; the file stem is the session id and every record's `sessionId` matches.
 * - Envelope records (`user`, `assistant`, `attachment`, `system`) carry `timestamp` (ISO UTC),
 *   `cwd`, `gitBranch`, `entrypoint` (`cli` | `sdk-cli` | `sdk-ts`), `version`. The first `cwd` of a
 *   file always encodes to its project dir name (the launch dir); 239 files later carry other
 *   cwds (`cd` into a worktree or subdir), so cwd and entrypoint come only from a read at byte 0.
 * - Metadata records: `custom-title.customTitle`, `agent-name.agentName`, `ai-title.aiTitle`,
 *   `last-prompt.lastPrompt`, and `cost-state` (cumulative: `totalCostUSD` is the session's
 *   running total; the latest one wins).
 * - An assistant API message is written as one record per content block; every record of one
 *   message repeats the same `message.id` and the same `message.usage` (35 438 of 71 873 records
 *   are such repeats), so usage is counted once per message id.
 * - `git commit` output arrives as a tool_result whose text has a `[branch sha] subject` line.
 * - Peer messages (`origin.kind: 'peer'`, from SendMessage), task notifications and sdk turns are
 *   `type: 'user'` records too; only `origin.kind` `human` or absent counts as a prompt.
 * - `api-request*`, `file-history-*` and a few bookkeeping types are most of the bytes and carry
 *   nothing a session row needs; they are dropped before JSON.parse.
 */

/** Record types that never feed a session row. Skipped from the leading `{"type":"..."` before JSON.parse. */
export const IGNORED_RECORD_TYPES: ReadonlySet<string> = new Set([
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'mode',
  'permission-mode',
  'queue-operation',
  'tools-used',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'isolation-latch',
  'worktree-state',
  'relocated',
]);

/** Entry points that are not a person at a terminal: the wall chat agent and the `/n` helper runs. */
export const EXCLUDED_ENTRYPOINTS: ReadonlySet<string> = new Set(['sdk-ts', 'sdk-cli']);

/** Tools whose `file_path` (`notebook_path` for NotebookEdit) is a file the session changed. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A plan document: `docs/plans/*`, `.workflows/plan/*`, `docs/analyzer/*`, read or edited. */
export const PLAN_DOC_PATH = /(?:^|\/)(?:docs\/plans|\.workflows\/plan|docs\/analyzer)\//;

export const DEFAULT_READ_CHUNK_BYTES = 1 << 20;
/** Message ids remembered across reads, to count a message's usage once when its records straddle a read. */
const RECENT_MESSAGE_IDS = 16;
/** `git commit` tool_use ids remembered across reads, waiting for their result. */
const PENDING_COMMIT_IDS = 32;

const LEADING_TYPE = /^\{"type":"([^"]{1,64})"/;
const LOCAL_WRAPPERS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];
const COMMAND_START = /^\s*<command-(?:message|name)>/;
const COMMAND_NAME = /<command-name>\s*\/?([^<\s]*)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const INTERRUPTED = /^\[Request interrupted by user/;
/** `/model`, `/clear`, `/exit`: a slash command with no arguments says nothing about the work. */
const BARE_COMMAND = /^\/[\w:.-]+$/;
const GIT_COMMIT_COMMAND = /\bgit\b[^\n]*\bcommit\b/;
const COMMIT_LINE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;

export type TranscriptRecord = Record<string, unknown>;

/** State the accumulator carries from one read of a file to the next, in memory only. */
export interface TranscriptCarry {
  recentMessageIds: string[];
  pendingCommitIds: string[];
}

/** What one read of a transcript (from a byte offset to the last complete line) contributed. */
export interface TranscriptDelta {
  sessionId: string;
  /** Records parsed (ignored types excluded). */
  records: number;
  /** First cwd seen in this read. Meaningful as the session cwd only for a read from byte 0. */
  cwd: string | null;
  /** First entrypoint seen in this read. */
  entrypoint: string | null;
  /** Latest non-empty values seen in this read; null when the read had none. */
  branch: string | null;
  version: string | null;
  name: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  firstAt: Date | null;
  lastAt: Date | null;
  /** First human prompt of this read. */
  firstPrompt: string | null;
  /** Human prompts of this read, oldest first, the newest MAX_PROMPTS. */
  prompts: SessionPrompt[];
  /** Assistant usage of this read, one count per message id. */
  tokens: TokenCounts;
  /** The same usage by `message.model` (`<synthetic>` excluded). */
  models: Record<string, ModelUsage>;
  /** `totalCostUSD` of the latest cost-state of this read (an absolute session total), or null. */
  costUsd: number | null;
  commits: SessionCommit[];
  filesEdited: string[];
  planDocs: string[];
  /** Assistant text after the last tool_use / human prompt of this read; null when there is none. */
  finalMessage: string | null;
}

/** Where a read sits in its file, and the repo key resolved for it (read from byte 0 only). */
export interface PatchContext {
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  size: number;
  repo: string | null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function zeroTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addInto(target: TokenCounts, add: TokenCounts): void {
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheWriteTokens += add.cacheWriteTokens;
}

/** One JSONL line to a record. Blank, torn, non-object and ignored-type lines give null. */
export function parseRecord(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const lead = LEADING_TYPE.exec(trimmed);
  if (lead?.[1] !== undefined && IGNORED_RECORD_TYPES.has(lead[1])) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ReadJsonlOptions {
  /** Bytes per read() call. Default DEFAULT_READ_CHUNK_BYTES (1 MiB). Lines may be longer. */
  chunkBytes?: number;
  /** Checked before every chunk; true stops the read (the result still covers the lines read). */
  shouldStop?: () => boolean;
}

export interface ReadJsonlResult {
  /** Byte offset just past the last complete line read: where the next read starts. */
  endOffset: number;
  /** File size when the read began. Bytes appended after that are left for the next read. */
  size: number;
  /** Complete lines handed to `onLine`. */
  lines: number;
  /** True when `shouldStop` cut the read short. */
  stopped: boolean;
}

/**
 * Streams the complete lines of `file` from byte `start` to the size it had when opened, in fixed
 * chunks (memory stays O(chunk + longest line), whatever the file size). A trailing line without
 * its `\n` is still being written: it is not handed out and `endOffset` stops before it.
 */
export async function readJsonlFrom(
  file: string,
  start: number,
  onLine: (line: string) => void,
  options: ReadJsonlOptions = {},
): Promise<ReadJsonlResult> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    let endOffset = Math.min(Math.max(start, 0), size);
    let position = endOffset;
    let lines = 0;
    let stopped = false;
    const pending: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (position < size) {
      if (options.shouldStop?.() === true) {
        stopped = true;
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, size - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, from);
        if (newline === -1) break;
        const piece = chunk.subarray(from, newline);
        const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending.length = 0;
        onLine(line.toString('utf8'));
        lines += 1;
        endOffset = position + newline + 1;
        from = newline + 1;
      }
      if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from)));
      position += bytesRead;
    }
    return { endOffset, size, lines, stopped };
  } finally {
    await handle.close();
  }
}

/** `<command-name>/x</command-name>...<command-args>a</command-args>` -> `/x a`. Other text is returned as is. */
export function typedFromCommandXml(text: string): string {
  if (!COMMAND_START.test(text)) return text;
  const name = COMMAND_NAME.exec(text);
  if (!name || name[1] === undefined || name[1] === '') return text;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return args === '' ? `/${name[1]}` : `/${name[1]} ${args}`;
}

/** True for a record the user typed or pasted: not a tool result, not meta, not a sidechain, not a peer message. */
export function isHumanPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return false;
  if (record.toolUseResult !== undefined) return false;
  const kind = isObject(record.origin) ? record.origin.kind : undefined;
  if (kind !== undefined && kind !== 'human') return false;
  const message = record.message;
  if (!isObject(message) || message.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trimStart();
    return text.length > 0 && !LOCAL_WRAPPERS.some((prefix) => text.startsWith(prefix));
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((block) => isObject(block) && block.type === 'tool_result')) return false;
  return content.some((block) => isObject(block) && (block.type === 'text' || block.type === 'image'));
}

/** The prompt as typed: `/cmd args` for a command record, the joined text blocks for an array record. */
export function promptText(record: TranscriptRecord): string {
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (typeof content === 'string') return typedFromCommandXml(content).trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => typedFromCommandXml(block.text))
    .join('\n')
    .trim();
}

/** The text of a tool_result block's `content` (a string or an array of text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Every `[branch sha] subject` line of `git commit` output, in order. */
export function parseCommitLines(text: string, at: string | null): SessionCommit[] {
  const commits: SessionCommit[] = [];
  for (const match of text.matchAll(COMMIT_LINE)) {
    const sha = match[2];
    const subject = match[3];
    if (sha === undefined || subject === undefined) continue;
    commits.push({ sha, subject: cut(subject.trim(), MAX_TITLE_CHARS), at });
  }
  return commits;
}

export function emptyCarry(): TranscriptCarry {
  return { recentMessageIds: [], pendingCommitIds: [] };
}

/**
 * Folds the records of one read of one transcript into a `TranscriptDelta`. Feed it records in
 * file order with `add`, then take `delta()`; pass `carry()` on to the accumulator of the next read
 * of the same file so a message or a commit that straddles the two reads is counted once.
 */
export class TranscriptAccumulator {
  readonly sessionId: string;
  private records = 0;
  private cwd: string | null = null;
  private entrypoint: string | null = null;
  private branch: string | null = null;
  private version: string | null = null;
  private name: string | null = null;
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  private lastPrompt: string | null = null;
  private firstMs: number | null = null;
  private lastMs: number | null = null;
  private firstPrompt: string | null = null;
  private prompts: SessionPrompt[] = [];
  private readonly tokens: TokenCounts = zeroTokens();
  private readonly models = new Map<string, TokenCounts>();
  private costUsd: number | null = null;
  private readonly commits = new Map<string, SessionCommit>();
  private readonly filesEdited = new Set<string>();
  private readonly planDocs = new Set<string>();
  private segment: string[] = [];
  private readonly toolIdsThisRead = new Set<string>();
  private readonly recentMessageIds: string[];
  private readonly pendingCommitIds: string[];

  constructor(sessionId: string, carry: TranscriptCarry = emptyCarry()) {
    this.sessionId = sessionId;
    this.recentMessageIds = [...carry.recentMessageIds];
    this.pendingCommitIds = [...carry.pendingCommitIds];
  }

  /** State to hand to the next read's accumulator. */
  carry(): TranscriptCarry {
    return {
      recentMessageIds: this.recentMessageIds.slice(-RECENT_MESSAGE_IDS),
      pendingCommitIds: this.pendingCommitIds.slice(-PENDING_COMMIT_IDS),
    };
  }

  add(record: TranscriptRecord): void {
    this.records += 1;
    if (record.isSidechain === true) return;
    this.observeEnvelope(record);
    switch (record.type) {
      case 'custom-title':
        this.customTitle = nonEmpty(record.customTitle) ?? this.customTitle;
        return;
      case 'agent-name':
        this.name = nonEmpty(record.agentName) ?? this.name;
        return;
      case 'ai-title':
        this.aiTitle = nonEmpty(record.aiTitle) ?? this.aiTitle;
        return;
      case 'last-prompt': {
        const text = nonEmpty(record.lastPrompt);
        if (text !== null) this.lastPrompt = cut(text, MAX_PROMPT_CHARS);
        return;
      }
      case 'cost-state':
        if (typeof record.totalCostUSD === 'number' && Number.isFinite(record.totalCostUSD)) this.costUsd = record.totalCostUSD;
        return;
      case 'user':
        this.addUser(record);
        return;
      case 'assistant':
        this.addAssistant(record);
        return;
      default:
        return;
    }
  }

  delta(): TranscriptDelta {
    const models: Record<string, ModelUsage> = {};
    for (const [model, usage] of this.models) models[model] = { ...usage };
    return {
      sessionId: this.sessionId,
      records: this.records,
      cwd: this.cwd,
      entrypoint: this.entrypoint,
      branch: this.branch,
      version: this.version,
      name: this.name,
      customTitle: this.customTitle,
      aiTitle: this.aiTitle,
      lastPrompt: this.lastPrompt,
      firstAt: this.firstMs === null ? null : new Date(this.firstMs),
      lastAt: this.lastMs === null ? null : new Date(this.lastMs),
      firstPrompt: this.firstPrompt,
      prompts: this.prompts.slice(-MAX_PROMPTS),
      tokens: { ...this.tokens },
      models,
      costUsd: this.costUsd,
      commits: [...this.commits.values()].slice(-MAX_COMMITS),
      filesEdited: [...this.filesEdited],
      planDocs: [...this.planDocs],
      finalMessage: this.segment.length > 0 ? cut(this.segment.join('\n\n').trim(), MAX_FINAL_MESSAGE_CHARS) : null,
    };
  }

  private observeEnvelope(record: TranscriptRecord): void {
    if (typeof record.timestamp === 'string') {
      const ms = Date.parse(record.timestamp);
      if (Number.isFinite(ms)) {
        if (this.firstMs === null || ms < this.firstMs) this.firstMs = ms;
        if (this.lastMs === null || ms > this.lastMs) this.lastMs = ms;
      }
    }
    const cwd = nonEmpty(record.cwd);
    if (cwd !== null && this.cwd === null) this.cwd = cwd;
    const entrypoint = nonEmpty(record.entrypoint);
    if (entrypoint !== null && this.entrypoint === null) this.entrypoint = entrypoint;
    const branch = nonEmpty(record.gitBranch);
    if (branch !== null) this.branch = branch;
    const version = nonEmpty(record.version);
    if (version !== null) this.version = version;
  }

  private addUsage(model: string | null, usage: unknown): void {
    if (!isObject(usage)) return;
    const tokens: TokenCounts = {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
    };
    addInto(this.tokens, tokens);
    if (model === null) return;
    let perModel = this.models.get(model);
    if (perModel === undefined) {
      perModel = zeroTokens();
      this.models.set(model, perModel);
    }
    addInto(perModel, tokens);
  }

  private addUser(record: TranscriptRecord): void {
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (isHumanPrompt(record)) {
      const text = promptText(record);
      if (text !== '' && !INTERRUPTED.test(text) && !BARE_COMMAND.test(text)) {
        const clipped = cut(text, MAX_PROMPT_CHARS);
        this.firstPrompt ??= clipped;
        this.prompts.push({ text: clipped, at });
        if (this.prompts.length > MAX_PROMPTS * 2) this.prompts = this.prompts.slice(-MAX_PROMPTS);
        this.segment = [];
      }
      return;
    }
    const message = record.message;
    const content = isObject(message) ? message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      this.scanCommit(id, toolResultText(block.content), record.toolUseResult, at);
    }
  }

  private scanCommit(id: string | null, text: string, toolUseResult: unknown, at: string | null): void {
    if (!text.includes('] ')) return;
    const pendingIndex = id === null ? -1 : this.pendingCommitIds.indexOf(id);
    if (pendingIndex >= 0) {
      this.pendingCommitIds.splice(pendingIndex, 1);
    } else {
      // A tool_use seen in this read that was not a `git commit`: its output is not a commit.
      if (id !== null && this.toolIdsThisRead.has(id)) return;
      // Its tool_use was in an earlier read we no longer remember: accept Bash-shaped output only.
      if (!isObject(toolUseResult) || typeof toolUseResult.stdout !== 'string') return;
    }
    for (const commit of parseCommitLines(text, at)) {
      if (!this.commits.has(commit.sha)) this.commits.set(commit.sha, commit);
    }
  }

  private addAssistant(record: TranscriptRecord): void {
    const message = record.message;
    if (!isObject(message)) return;
    const rawModel = nonEmpty(message.model);
    const model = rawModel === '<synthetic>' ? null : rawModel;
    const id = nonEmpty(message.id);
    if (id === null) {
      this.addUsage(model, message.usage);
    } else if (!this.recentMessageIds.includes(id)) {
      this.addUsage(model, message.usage);
      this.recentMessageIds.push(id);
      if (this.recentMessageIds.length > RECENT_MESSAGE_IDS * 2) {
        this.recentMessageIds.splice(0, this.recentMessageIds.length - RECENT_MESSAGE_IDS);
      }
    }
    const content = message.content;
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use') {
        this.segment = [];
        this.addToolUse(block);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        this.segment.push(block.text);
      }
    }
  }

  private addToolUse(block: Record<string, unknown>): void {
    const name = typeof block.name === 'string' ? block.name : '';
    const id = typeof block.id === 'string' ? block.id : null;
    const input = isObject(block.input) ? block.input : {};
    if (id !== null) this.toolIdsThisRead.add(id);
    if (name === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (id !== null && GIT_COMMIT_COMMAND.test(command)) this.pendingCommitIds.push(id);
      return;
    }
    const file = nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path);
    if (file === null) return;
    const edits = EDIT_TOOLS.has(name);
    if (edits && this.filesEdited.size < MAX_FILES_EDITED) this.filesEdited.add(file);
    if ((edits || name === 'Read') && PLAN_DOC_PATH.test(file) && this.planDocs.size < MAX_PLAN_DOCS) this.planDocs.add(file);
  }
}

/** Folds every complete record of `text` (a whole transcript, or one read of it). For tests and tools. */
export function accumulateText(sessionId: string, text: string, carry?: TranscriptCarry): TranscriptAccumulator {
  const acc = new TranscriptAccumulator(sessionId, carry);
  for (const line of text.split('\n')) {
    const record = parseRecord(line);
    if (record !== null) acc.add(record);
  }
  return acc;
}

/**
 * The `SessionsRepo.upsertFromTranscript` patch for one read. Accumulators are this read's deltas
 * (the repo adds them, or replaces on `fromOffset === 0`). cwd, entrypoint and repo are sent only
 * for a read from byte 0, where the first cwd is the launch dir; a later read's first cwd may be a
 * `cd` target. Null scalars leave the stored value alone (repo merge rule).
 */
export function buildTranscriptPatch(delta: TranscriptDelta, ctx: PatchContext): TranscriptPatch {
  const fromStart = ctx.fromOffset === 0;
  return {
    sessionId: delta.sessionId,
    host: ctx.host,
    transcriptPath: ctx.transcriptPath,
    fromOffset: ctx.fromOffset,
    toOffset: ctx.toOffset,
    size: ctx.size,
    repo: fromStart ? ctx.repo : null,
    cwd: fromStart ? delta.cwd : null,
    entrypoint: fromStart ? delta.entrypoint : null,
    branch: delta.branch,
    name: delta.name,
    customTitle: delta.customTitle,
    aiTitle: delta.aiTitle,
    firstPrompt: delta.firstPrompt,
    lastPrompt: delta.lastPrompt,
    version: delta.version,
    finalMessage: delta.finalMessage,
    startedAt: delta.firstAt,
    lastActiveAt: delta.lastAt,
    tokens: delta.tokens,
    models: delta.models,
    costUsd: delta.costUsd,
    prompts: delta.prompts,
    commits: delta.commits,
    filesEdited: delta.filesEdited,
    planDocs: delta.planDocs,
  };
}
```
**Impact:** New module. Imports only phase 1's `./types.js` (constants + types). Caps reuse phase 1's `MAX_*` constants so there is one source of truth.

### Step 3: Repo resolution
**File:** `src/sessions/repoResolve.ts` (new)
**Change:** Repo key from cwd (worktree conventions first, then git, then path), and from the project dir name when there is no cwd.
**Code:**
```ts
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Which repository a Claude Code session belongs to, as a short key (`mcp-notes`,
 * `agentic_golang`). Measured 2026-11-02: 126 of 166 project dirs are worktree sessions whose
 * directory is usually deleted after landing, so the path conventions come first and need no disk:
 *
 * 1. `<worktreesDir>/<repo>/<slug>[/...]` (swarm and /analyze worktrees)       -> `<repo>`
 * 2. `<root>/.claude/worktrees/<slug>[/...]` (Claude Code's own worktrees)        -> basename(`<root>`)
 * 3. the home dir itself                                                           -> `~`
 * 4. an existing directory inside a git repo: the main checkout's directory name
 *    (`--git-common-dir`, so a linked worktree resolves to its repo, not its slug)
 * 5. a path under home: its first segment (`~/agentic/docs/plans` -> `agentic`; repos live at `~/<repo>`)
 * 6. anything else: the cwd's basename
 *
 * Without a cwd (no record carried one; never seen on this machine) the project dir name is
 * decoded instead. That encoding replaces every non-alphanumeric character with `-`, so it is
 * lossy (`agentic_golang` -> `agentic-golang`); it is matched against the directory names that
 * exist under home and the worktrees dir, longest first.
 */

export interface GitRoots {
  /** `git rev-parse --show-toplevel`. */
  toplevel: string;
  /** `git rev-parse --git-common-dir`, absolute. `<main checkout>/.git` for a linked worktree too. */
  commonDir: string;
}

export interface RepoResolverOptions {
  homeDir: string;
  worktreesDir: string;
  /** Default: `fs.stat(p).isDirectory()`. */
  isDirectory?: (p: string) => Promise<boolean>;
  /** Default: `gitRepoRoots` (runs git). Tests inject a fake. */
  gitRoots?: (cwd: string) => Promise<GitRoots | null>;
  /** Directory names that may be repo keys, for decoding project dir names. Default: entries of homeDir and worktreesDir. */
  listRepoNames?: () => Promise<string[]>;
}

export interface RepoResolver {
  /** The repo key for a session, or null when there is nothing to go on. Results are cached per cwd. */
  resolve(cwd: string | null, projectDirName: string): Promise<string | null>;
}

/** Claude Code's project dir name for a cwd: every character outside [a-zA-Z0-9] becomes `-`. */
export function encodeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function isInside(child: string, parent: string): string | null {
  const rel = path.relative(parent, child);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** Rule 1: `<worktreesDir>/<repo>/...` -> `<repo>`. */
export function repoFromWorktreePath(cwd: string, worktreesDir: string): string | null {
  const rel = isInside(path.resolve(cwd), path.resolve(worktreesDir));
  if (rel === null) return null;
  const first = rel.split(path.sep)[0];
  return first === undefined || first === '' ? null : first;
}

/** Rule 2: `<root>/.claude/worktrees/<slug>/...` -> basename(`<root>`). */
export function repoFromClaudeWorktree(cwd: string): string | null {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const at = path.resolve(cwd).indexOf(marker);
  if (at <= 0) return null;
  const root = path.resolve(cwd).slice(0, at);
  const name = path.basename(root);
  return name === '' ? null : name;
}

/** The repo key from git roots: the main checkout's directory name. */
export function repoFromGitRoots(roots: GitRoots): string {
  const common = path.resolve(roots.commonDir);
  if (path.basename(common) === '.git') return path.basename(path.dirname(common));
  return path.basename(path.resolve(roots.toplevel));
}

/** Rules 3, 5 and 6 (no disk): `~`, the first segment under home, else the basename. */
export function repoFromPath(cwd: string, homeDir: string): string | null {
  const abs = path.resolve(cwd);
  const home = path.resolve(homeDir);
  if (abs === home) return '~';
  const rel = isInside(abs, home);
  if (rel !== null) {
    const first = rel.split(path.sep)[0];
    if (first !== undefined && first !== '') return first;
  }
  const base = path.basename(abs);
  return base === '' ? null : base;
}

/**
 * The repo key from a project dir name alone (`-home-u--worktrees-mcp-notes-wall-editing`).
 * `knownNames` are real directory names; the longest whose encoding prefixes the rest wins.
 */
export function repoFromProjectDir(name: string, homeDir: string, worktreesDir: string, knownNames: string[]): string | null {
  const byLength = [...new Set(knownNames)].sort((a, b) => b.length - a.length);
  const match = (rest: string): string => {
    for (const known of byLength) {
      const enc = encodeProjectDir(known);
      if (rest === enc || rest.startsWith(`${enc}-`)) return known;
    }
    const first = rest.split('-').find((part) => part !== '');
    return first ?? rest;
  };
  const wt = `${encodeProjectDir(path.resolve(worktreesDir))}-`;
  if (name.startsWith(wt) && name.length > wt.length) return match(name.slice(wt.length));
  const home = encodeProjectDir(path.resolve(homeDir));
  if (name === home) return '~';
  if (name.startsWith(`${home}-`) && name.length > home.length + 1) return match(name.slice(home.length + 1));
  return null;
}

/** `git rev-parse` in `cwd`; null when it is not a git directory or git fails. */
export async function gitRepoRoots(cwd: string): Promise<GitRoots | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { timeout: 3_000, windowsHide: true },
    );
    const [toplevel, commonDir] = stdout.split('\n').map((line) => line.trim());
    if (!toplevel || !commonDir) return null;
    return { toplevel, commonDir };
  } catch {
    return null;
  }
}

async function isDirectoryOnDisk(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirNames(dirs: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.push(entry.name);
      }
    } catch {
      // A missing dir contributes nothing.
    }
  }
  return names;
}

export function createRepoResolver(options: RepoResolverOptions): RepoResolver {
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  const gitRoots = options.gitRoots ?? gitRepoRoots;
  const listRepoNames = options.listRepoNames ?? (() => listDirNames([options.homeDir, options.worktreesDir]));
  const byCwd = new Map<string, Promise<string | null>>();
  let known: Promise<string[]> | null = null;

  const fromCwd = async (cwd: string): Promise<string | null> => {
    const conventional = repoFromWorktreePath(cwd, options.worktreesDir) ?? repoFromClaudeWorktree(cwd);
    if (conventional !== null) return conventional;
    if (path.resolve(cwd) === path.resolve(options.homeDir)) return '~';
    if (await isDirectory(cwd)) {
      const roots = await gitRoots(cwd);
      if (roots !== null) {
        const viaGit = repoFromWorktreePath(roots.toplevel, options.worktreesDir);
        return viaGit ?? repoFromGitRoots(roots);
      }
    }
    return repoFromPath(cwd, options.homeDir);
  };

  return {
    async resolve(cwd, projectDirName) {
      if (cwd !== null && cwd.trim() !== '') {
        const key = path.resolve(cwd);
        let hit = byCwd.get(key);
        if (hit === undefined) {
          hit = fromCwd(key);
          byCwd.set(key, hit);
        }
        return hit;
      }
      known ??= listRepoNames();
      return repoFromProjectDir(projectDirName, options.homeDir, options.worktreesDir, await known);
    },
  };
}
```
**Impact:** New module, no imports from the app. Measured on the real 596 transcripts: 565 sessions resolve to 14 repo keys (seer 379, agentic_golang 67, mcp-notes 58, ...), zero nulls.

### Step 4: Live registry
**File:** `src/sessions/registry.ts` (new)
**Change:** Read `<claudeHome>/sessions/<pid>.json`, keep entries whose pid is alive with the same `/proc` start time, map by session id. `readLiveSessions` is the list form phase 6 imports; `createLiveRegistry` is the cached form phase 7 should use.
**Code:**
```ts
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Claude Code's live-session registry: one `~/.claude/sessions/<pid>.json` per running (or
 * crashed) session, e.g.
 * `{"pid":173606,"sessionId":"d5c2...","cwd":"/home/miftah/mcp-notes","startedAt":1793585571866,
 *   "procStart":"303782","version":"2.1.311","kind":"interactive","entrypoint":"cli",
 *   "tmux":"note:@0.%7","messagingSocketPath":"/run/user/1000/cc-socks/173606.sock",
 *   "name":"...","nameSource":"derived","status":"busy","updatedAt":1793585600000}`.
 * Files of dead processes stay behind (34 of 39 on 2026-11-02), so an entry counts as live only
 * when its pid is alive AND, where `/proc` exists, that pid's start time equals `procStart`
 * (field 22 of `/proc/<pid>/stat`; a recycled pid fails this). `<pid>.<hash>.key` files are skipped.
 * Read-only; nothing here writes to the database. Phase 7 serves `live` from it.
 */

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
}

export type PidAliveCheck = (pid: number, procStart: string | null) => boolean;

export interface RegistryOptions {
  /** The Claude home (`config.sessions.claudeHome`); entries are read from `<claudeHome>/sessions`. */
  claudeHome: string;
  /** Default `isPidAlive`. Tests inject one. */
  isAlive?: PidAliveCheck;
}

const ENTRY_FILE = /^\d+\.json$/;
export const DEFAULT_REGISTRY_TTL_MS = 2_000;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function msDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

/** Field 22 (starttime, clock ticks since boot) of `/proc/<pid>/stat`, or null without /proc. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // Fields after the parenthesised comm start at field 3; field 22 is index 19.
    return stat.slice(close + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** True when `pid` exists and, where /proc can tell, started at `procStart`. */
export function isPidAlive(pid: number, procStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (procStart === null) return true;
  const actual = procStartTime(pid);
  return actual === null || actual === procStart;
}

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
    },
  };
}

/** Live sessions on this machine by session id. A missing registry dir is an empty map. */
export async function readLiveRegistry(options: RegistryOptions): Promise<Map<string, LiveSession>> {
  const dir = path.join(options.claudeHome, 'sessions');
  const isAlive = options.isAlive ?? isPidAlive;
  const live = new Map<string, LiveSession>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    if (!ENTRY_FILE.test(name)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue; // being rewritten, or not JSON
    }
    const entry = parseLiveEntry(raw);
    if (entry === null || !isAlive(entry.session.pid, entry.procStart)) continue;
    const existing = live.get(entry.session.sessionId);
    const newer = (entry.session.updatedAt?.getTime() ?? 0) >= (existing?.updatedAt?.getTime() ?? 0);
    if (existing === undefined || newer) live.set(entry.session.sessionId, entry.session);
  }
  return live;
}

export interface LiveRegistry {
  /** The live map, re-read at most once per `ttlMs`; concurrent callers share one read. */
  get(): Promise<Map<string, LiveSession>>;
  /** Forget the cached map; the next `get` re-reads. */
  invalidate(): void;
}

export function createLiveRegistry(options: RegistryOptions & { ttlMs?: number; now?: () => number }): LiveRegistry {
  const ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: Promise<Map<string, LiveSession>> } | null = null;
  return {
    get() {
      const t = now();
      if (cached !== null && t - cached.at < ttlMs) return cached.value;
      const value = readLiveRegistry(options);
      cached = { at: t, value };
      value.catch(() => {
        if (cached?.value === value) cached = null;
      });
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** Live sessions on this machine as a list. The summary worker's "is it still running" check (phase 6). */
export async function readLiveSessions(claudeHome: string, isAlive?: PidAliveCheck): Promise<LiveSession[]> {
  return [...(await readLiveRegistry({ claudeHome, ...(isAlive !== undefined ? { isAlive } : {}) })).values()];
}
```
**Impact:** New module, read-only, no DB.

### Step 5: Ingester
**File:** `src/sessions/ingest.ts` (new)
**Change:** Backfill + offset tail + chokidar watcher + periodic sweep, writing through `SessionsRepo.upsertFromTranscript`, with the `IngestObserver` extension point.
**Code:**
```ts
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { SessionsRepo } from './repo.js';
import { createRepoResolver, type RepoResolver } from './repoResolve.js';
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type TranscriptCarry,
  type TranscriptRecord,
} from './transcript.js';

/**
 * Session ingest: keeps one `cc_sessions` row per Claude Code terminal session of this machine
 * in step with `<claudeHome>/projects/<dir>/<uuid>.jsonl`.
 *
 * - Backfill: the first pass reads every transcript on disk (628 files / ~895 MB measured on
 *   2026-11-02; ~2-5 s and ~70 MB RSS for the whole set), newest first, `concurrency` files at a
 *   time, each streamed in 1 MiB chunks.
 * - Tail: every later read starts at the byte offset stored on the row (`transcript_offset`), so a
 *   restart or an append costs only the new bytes. A trailing line without `\n` is not consumed.
 *   A file that shrank below its offset is re-read from 0 (`fromOffset: 0` replaces the row's
 *   accumulated values). The repo's write is a compare-and-set on the stored offset, so a replayed
 *   or stale read changes nothing; ingest then resumes from the offset the repo reports.
 * - Change detection: a chokidar watcher on the project dirs (debounced per burst) plus a full
 *   sweep every `sweepMs` that stats every file and catches anything the watcher missed.
 * - Excluded: project dirs ending `-data-chat` (the wall chat agent's cwd), files whose
 *   entrypoint is `sdk-ts`/`sdk-cli`, subagent transcripts (`<dir>/<uuid>/subagents/*.jsonl`),
 *   and anything that is not `<uuid>.jsonl` directly inside a project dir.
 * - Rows are written only through `SessionsRepo.upsertFromTranscript` (phase 1), with
 *   `host = os.hostname()`. Ingest never writes parent links, tmux or summaries.
 *
 * EXTENSION POINT (phase 4 heuristic links; any later consumer): `IngestObserver`, passed as
 * `observers` or added with `addObserver`. `onBatch` runs after each committed write with the
 * parsed records of exactly the bytes that write covered; `onPassComplete` runs after every full
 * sweep (the startup backfill is `initial: true`) with the ids written in it. Observers are called
 * synchronously after the commit, never awaited, and a throw or rejection is logged and dropped,
 * so an observer can neither slow nor fail ingest.
 */

export const DEFAULT_SWEEP_MS = 60_000;
export const DEFAULT_WATCH_DEBOUNCE_MS = 500;
export const DEFAULT_INGEST_CONCURRENCY = 4;
/** close() waits this long for in-flight reads (each stops at its next chunk). Matches the embedding workers. */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
const LOG_ERROR_CHARS = 200;

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CHAT_PROJECT_DIR = /-data-chat$/;

/** The two `SessionsRepo` methods ingest uses. Unit tests pass an in-memory implementation. */
export type IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'>;

export type IngestReason = 'backfill' | 'sweep' | 'watch';

export interface IngestReport {
  reason: IngestReason;
  /** Transcript files considered. */
  files: number;
  /** Rows written. */
  upserted: number;
  /** Bytes consumed (complete lines). */
  bytes: number;
  failed: number;
  ms: number;
}

/** One committed write: the records of bytes [fromOffset, toOffset) of one transcript. */
export interface IngestBatch {
  sessionId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  /** Parsed records of the complete lines read, in file order (ignored record types excluded). */
  records: readonly TranscriptRecord[];
}

/** The end of one full sweep over `<claudeHome>/projects`. */
export interface IngestPass {
  /** True for the first full pass this process completed (the startup backfill). */
  initial: boolean;
  reason: 'backfill' | 'sweep';
  /** Sessions whose row was written during the pass, each once (may be empty). */
  sessionIds: string[];
  report: IngestReport;
}

export interface IngestObserver {
  /** After a write committed. Must not block; a throw is logged and dropped. */
  onBatch?(batch: IngestBatch): void;
  /** After every full sweep. Not awaited; a throw or rejection is logged and dropped. */
  onPassComplete?(pass: IngestPass): void | Promise<void>;
}

export interface SessionIngestOptions {
  /** `config.sessions.claudeHome`; transcripts are under `<claudeHome>/projects`. */
  claudeHome: string;
  /** `config.sessions.worktreesDir`, for repo resolution. */
  worktreesDir: string;
  store: IngestStore;
  /** See EXTENSION POINT above. */
  observers?: IngestObserver[];
  /** Default os.homedir(). */
  homeDir?: string;
  /** Default os.hostname(). */
  hostname?: () => string;
  /** Default `createRepoResolver({ homeDir, worktreesDir })`. */
  resolver?: RepoResolver;
  /** Watch the project dirs with chokidar. Default true. Tests that drive `sweep()` turn it off. */
  watch?: boolean;
  /** Default DEFAULT_SWEEP_MS. 0 disables the periodic sweep (the backfill still runs). */
  sweepMs?: number;
  /** Default DEFAULT_WATCH_DEBOUNCE_MS. */
  debounceMs?: number;
  /** Files read at once. Default DEFAULT_INGEST_CONCURRENCY. */
  concurrency?: number;
  /** Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  /** Read chunk size, for tests. Default 1 MiB. */
  chunkBytes?: number;
  /** Default console.log. */
  log?: (line: string) => void;
}

export interface SessionIngester {
  /** Settles when the startup backfill pass has finished (never rejects). */
  ready: Promise<IngestReport>;
  /** Adds an observer (see EXTENSION POINT above). Returns the function that removes it. */
  addObserver(observer: IngestObserver): () => void;
  /** One full sweep now. Concurrent calls share the running sweep. */
  sweep(): Promise<IngestReport>;
  /** Resolves when no sweep, watcher burst or file read is running or scheduled. For tests. */
  idle(): Promise<void>;
  /** Stops watching and sweeping; waits at most `closeGraceMs` for in-flight reads. */
  close(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, LOG_ERROR_CHARS);
}

/** The session id of a top-level transcript path, or null for anything else. */
export function sessionIdFromPath(file: string): string | null {
  const base = path.basename(file);
  return SESSION_FILE.test(base) ? base.slice(0, -'.jsonl'.length).toLowerCase() : null;
}

/** Project dirs never ingested: the wall chat agent's sessions. */
export function isExcludedProjectDir(name: string): boolean {
  return CHAT_PROJECT_DIR.test(name);
}

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

/** Every `<projectsDir>/<dir>/<uuid>.jsonl`, newest first. A missing projects dir is an empty list. */
export async function listTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || isExcludedProjectDir(dir.name)) continue;
    const dirPath = path.join(projectsDir, dir.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const file = path.join(dirPath, entry.name);
      try {
        files.push({ path: file, mtimeMs: (await stat(file)).mtimeMs });
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** chokidar `ignored`: keep the projects dir, its project dirs, and `<uuid>.jsonl` directly inside them. */
export function isIgnoredWatchPath(projectsDir: string, p: string): boolean {
  const rel = path.relative(projectsDir, path.resolve(p));
  if (rel === '') return false;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep);
  if (parts.length === 1) return isExcludedProjectDir(parts[0] ?? '');
  if (parts.length === 2) return !SESSION_FILE.test(parts[1] ?? '');
  return true;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export function startSessionIngest(options: SessionIngestOptions): SessionIngester {
  const projectsDir = path.join(options.claudeHome, 'projects');
  const homeDir = options.homeDir ?? os.homedir();
  const host = (options.hostname ?? os.hostname)();
  const resolver = options.resolver ?? createRepoResolver({ homeDir, worktreesDir: options.worktreesDir });
  const log = options.log ?? ((line: string) => console.log(line));
  const concurrency = options.concurrency ?? DEFAULT_INGEST_CONCURRENCY;
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;

  const observers = new Set<IngestObserver>(options.observers ?? []);
  /** Stored offsets by session id (seeded from the store once, then kept current here). */
  const offsets = new Map<string, number>();
  let seeded: Promise<void> | null = null;
  /** Read-to-read carry per session (message ids, pending commits). Memory only. */
  const carries = new Map<string, TranscriptCarry>();
  /** Files of excluded entry points or of another host's row: never read again in this process. */
  const excluded = new Set<string>();
  /** Files with no entry point yet and no row: size at the last look, re-read only when it changes. */
  const deferred = new Map<string, number>();
  /** Per-file serialization: the running read, and whether another was asked for meanwhile. */
  const inflight = new Map<string, Promise<number>>();
  const again = new Set<string>();
  let closed = false;
  let passesCompleted = 0;
  let sweeping: Promise<IngestReport> | null = null;
  let watchQueue = new Set<string>();
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchDrain: Promise<void> | null = null;

  const observerFailed = (err: unknown): void => {
    log(`[notesd] sessions: observer failed: ${errorMessage(err)}`);
  };

  const notifyBatch = (batch: IngestBatch): void => {
    for (const observer of observers) {
      try {
        observer.onBatch?.(batch);
      } catch (err) {
        observerFailed(err);
      }
    }
  };

  const notifyPass = (pass: IngestPass): void => {
    for (const observer of observers) {
      try {
        const result = observer.onPassComplete?.(pass);
        if (result instanceof Promise) result.catch(observerFailed);
      } catch (err) {
        observerFailed(err);
      }
    }
  };

  const seed = (): Promise<void> => {
    seeded ??= options.store.offsets(host).then(
      (stored) => {
        for (const [sessionId, entry] of stored) offsets.set(sessionId, entry.offset);
      },
      (err: unknown) => {
        seeded = null; // retry on the next pass
        throw err;
      },
    );
    return seeded;
  };

  /**
   * Reads what is new in one file and writes the row. Returns the bytes consumed (0: nothing
   * written). A compare-and-set miss (`offset_mismatch`) adopts the repo's offset and reads once more.
   */
  const readFile = async (file: string): Promise<number> => {
    const sessionId = sessionIdFromPath(file);
    if (sessionId === null) return 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (excluded.has(file) || closed) return 0;
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return 0; // deleted (Claude Code prunes old transcripts)
      }
      const known = offsets.get(sessionId) ?? 0;
      if (size === known || deferred.get(file) === size) return 0;
      const fromOffset = size < known ? 0 : known;
      const acc = new TranscriptAccumulator(sessionId, fromOffset === 0 ? undefined : carries.get(sessionId));
      const keepRecords = [...observers].some((o) => o.onBatch !== undefined);
      const records: TranscriptRecord[] = [];
      const read = await readJsonlFrom(
        file,
        fromOffset,
        (line) => {
          const record = parseRecord(line);
          if (record === null) return;
          acc.add(record);
          if (keepRecords) records.push(record);
        },
        { shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.endOffset <= fromOffset) {
        if (size < known) offsets.set(sessionId, read.endOffset);
        return 0;
      }
      const delta = acc.delta();
      let repo: string | null = null;
      if (fromOffset === 0) {
        if (delta.entrypoint !== null && EXCLUDED_ENTRYPOINTS.has(delta.entrypoint)) {
          excluded.add(file);
          return 0;
        }
        if (delta.entrypoint === null && !offsets.has(sessionId)) {
          // Only bookkeeping records so far and no row: wait for the first message.
          deferred.set(file, size);
          return 0;
        }
        repo = await resolver.resolve(delta.cwd, path.basename(path.dirname(file)));
      }
      const result = await options.store.upsertFromTranscript(
        buildTranscriptPatch(delta, { host, transcriptPath: file, fromOffset, toOffset: read.endOffset, size: read.size, repo }),
      );
      if (result.applied) {
        offsets.set(sessionId, read.endOffset);
        carries.set(sessionId, acc.carry());
        deferred.delete(file);
        notifyBatch({ sessionId, host, transcriptPath: file, fromOffset, toOffset: read.endOffset, records });
        return Math.max(1, read.endOffset - fromOffset);
      }
      if (result.reason === 'other_host') {
        excluded.add(file);
        log(`[notesd] sessions: ${sessionId} belongs to host ${result.row.host}; not ingesting ${file}`);
        return 0;
      }
      offsets.set(sessionId, result.storedOffset);
      carries.delete(sessionId);
    }
    return 0;
  };

  /** `readFile`, serialized per file: a request during a read runs once more right after it. */
  const runFile = (file: string): Promise<number> => {
    const running = inflight.get(file);
    if (running !== undefined) {
      again.add(file);
      return running.then(() => 0);
    }
    const task = (async () => {
      let bytes = 0;
      do {
        again.delete(file);
        bytes += await readFile(file);
      } while (again.has(file) && !closed);
      return bytes;
    })().finally(() => inflight.delete(file));
    inflight.set(file, task);
    return task;
  };

  const pass = async (files: string[], reason: IngestReason): Promise<{ report: IngestReport; written: string[] } | null> => {
    const started = Date.now();
    const report: IngestReport = { reason, files: files.length, upserted: 0, bytes: 0, failed: 0, ms: 0 };
    const written: string[] = [];
    try {
      await seed();
    } catch (err) {
      log(`[notesd] sessions: could not load offsets: ${errorMessage(err)}`);
      return null;
    }
    await forEachLimit(files, concurrency, async (file) => {
      if (closed) return;
      try {
        const bytes = await runFile(file);
        if (bytes > 0) {
          report.upserted += 1;
          report.bytes += bytes;
          const id = sessionIdFromPath(file);
          if (id !== null) written.push(id);
        }
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: ${path.basename(file)}: ${errorMessage(err)}`);
      }
    });
    report.ms = Date.now() - started;
    return { report, written };
  };

  const fullSweep = (reason: 'backfill' | 'sweep'): Promise<IngestReport> => {
    if (sweeping !== null) return sweeping;
    const run = (async (): Promise<IngestReport> => {
      const files = (await listTranscripts(projectsDir)).map((f) => f.path);
      const result = await pass(files, reason);
      if (result === null) return { reason, files: files.length, upserted: 0, bytes: 0, failed: files.length, ms: 0 };
      if (!closed) {
        notifyPass({ initial: passesCompleted === 0, reason, sessionIds: [...new Set(result.written)], report: result.report });
        passesCompleted += 1;
      }
      return result.report;
    })().finally(() => {
      if (sweeping === run) sweeping = null;
    });
    sweeping = run;
    return run;
  };

  const drainWatch = (): void => {
    watchTimer = null;
    if (closed || watchQueue.size === 0) return;
    const files = [...watchQueue];
    watchQueue = new Set();
    const run = pass(files, 'watch').then(
      (result) => {
        if (result !== null && result.report.failed > 0) log(formatReport(result.report));
      },
      (err: unknown) => log(`[notesd] sessions: watch pass failed: ${errorMessage(err)}`),
    );
    const tracked: Promise<void> = run.finally(() => {
      if (watchDrain === tracked) watchDrain = null;
    });
    watchDrain = tracked;
  };

  const queueWatch = (p: string): void => {
    if (closed) return;
    const file = path.resolve(p);
    if (sessionIdFromPath(file) === null) return;
    watchQueue.add(file);
    watchTimer ??= setTimeout(drainWatch, debounceMs);
  };

  let watcher: FSWatcher | null = null;
  if (options.watch !== false && existsSync(projectsDir)) {
    watcher = watch(projectsDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: (p: string) => isIgnoredWatchPath(projectsDir, p),
    });
    watcher.on('add', queueWatch);
    watcher.on('change', queueWatch);
    watcher.on('error', (err: unknown) => log(`[notesd] sessions: watcher error: ${errorMessage(err)}`));
  }

  const ready = fullSweep('backfill').then(
    (report) => {
      log(formatReport(report));
      return report;
    },
    (err: unknown) => {
      log(`[notesd] sessions: backfill failed: ${errorMessage(err)}`);
      return { reason: 'backfill' as const, files: 0, upserted: 0, bytes: 0, failed: 1, ms: 0 };
    },
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  if (sweepMs > 0) {
    timer = setInterval(() => {
      if (closed) return;
      fullSweep('sweep').then(
        (report) => {
          if (report.failed > 0) log(formatReport(report));
        },
        (err: unknown) => log(`[notesd] sessions: sweep failed: ${errorMessage(err)}`),
      );
    }, sweepMs);
    timer.unref();
  }

  return {
    ready,
    addObserver(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    sweep: () => fullSweep('sweep'),
    async idle() {
      for (;;) {
        if (watchTimer !== null) {
          clearTimeout(watchTimer);
          drainWatch();
        }
        const pending = [sweeping, watchDrain, ...inflight.values()].filter((p) => p !== null);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearInterval(timer);
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = null;
      const closing = watcher?.close().catch(() => undefined);
      const pending = Promise.allSettled([closing, sweeping, watchDrain, ...inflight.values()]);
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      if (grace !== undefined) clearTimeout(grace);
    },
  };
}

/** e.g. `[notesd] sessions: backfill 628 files, 612 rows written, 838.2 MB, 0 failed, 2205ms` */
export function formatReport(report: IngestReport): string {
  const mb = (report.bytes / (1024 * 1024)).toFixed(1);
  return `[notesd] sessions: ${report.reason} ${report.files} files, ${report.upserted} rows written, ${mb} MB, ${report.failed} failed, ${report.ms}ms`;
}
```
**Impact:** New module. Measured against the real `~/.claude` with an in-memory store (read-only): backfill of 596 files / 838 MB in 2.2-5.1 s, +66-70 MB RSS, 565 rows; the next sweep reads 0 bytes in 13 ms.

### Step 6: Wire into startBackground
**File:** `src/background.ts:1-68` (whole file shown; additions: imports at the top, the session block after the image-embedding block at `:61`, `sessionIngest?.close()` in the parallel close at `:66`)
**Change:** Start the ingester when `config.sessions.enabled`, never awaiting the backfill; close it in parallel with the embedding workers (each bounded by 5 s).
**Code:**
```ts
import { hostname } from 'node:os';
import type { AppDeps } from './deps.js';
import { dbEmbeddingStore } from './embeddings/backfill.js';
import { dbImageEmbeddingStore } from './embeddings/imageBackfill.js';
import { startImageEmbeddingWorker } from './embeddings/imageWorker.js';
import { startEmbeddingWorker, type EmbeddingWorker } from './embeddings/worker.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { reconcileLegacyImages } from './images/legacy.js';
import { ensureDataDirs } from './images/store.js';
import { startSessionIngest, type SessionIngester } from './sessions/ingest.js';
import { SessionsRepo } from './sessions/repo.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server: the inbox watcher (iteration 2) and, when
 * OPENROUTER_API_KEY is set, the note embedding worker (iteration 6) and the image embedding
 * worker (image similarity search); with `config.sessions.enabled`, the Claude Code session
 * ingester (iteration 8: backfill, then tail `<claudeHome>/projects`).
 * Creates images/, cache/, inbox/, inbox/failed/, chat-images/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon). Then copies any legacy
 * image (notes.image_path/image_meta without a note_images row, e.g. ingested by an older daemon
 * after migration 0002 ran) into note_images, once, before the inbox can dedupe against it.
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  try {
    const copied = await reconcileLegacyImages(deps.db);
    console.log(`[notesd] legacy images reconciled into note_images: ${copied}`);
  } catch (err) {
    // Never block the daemon on it: the next start retries (the copy is idempotent).
    console.error(`[notesd] legacy image reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const inbox = await startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest: (absPath) => ingestImage(img, { path: absPath, move: true, origin: { source: 'inbox' } }),
  });
  console.log(`[notesd] watching ${dirs.inbox}`);

  let embeddings: EmbeddingWorker | null = null;
  if (!deps.embedder) {
    console.log('[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text');
  } else {
    embeddings = startEmbeddingWorker({
      store: dbEmbeddingStore(deps.db),
      events: deps.events,
      embedder: deps.embedder,
    });
    console.log(`[notesd] embedding notes with ${deps.embedder.model}`);
  }

  let imageEmbeddings: EmbeddingWorker | null = null;
  if (!deps.imageEmbedder) {
    console.log('[notesd] image search off: OPENROUTER_API_KEY is not set, similar_images cannot compare pictures');
  } else {
    imageEmbeddings = startImageEmbeddingWorker({
      store: dbImageEmbeddingStore(deps.db, img.dataDir),
      events: deps.events,
      embedder: deps.imageEmbedder,
    });
    console.log(`[notesd] embedding images with ${deps.imageEmbedder.model}`);
  }

  // Session ingest (iteration 8). The backfill runs in the background: startBackground does not
  // wait for it, and a failure is logged, never thrown. Later session work (phase 4 links, phase 6
  // summaries) hangs off `sessionIngest` / `sessionsRepo` / `sessionsHost` here.
  let sessionIngest: SessionIngester | null = null;
  if (!deps.config.sessions.enabled) {
    console.log('[notesd] session ingest off: NOTESD_SESSIONS=off');
  } else {
    const sessionsRepo = new SessionsRepo(deps.db);
    const sessionsHost = hostname();
    sessionIngest = startSessionIngest({
      claudeHome: deps.config.sessions.claudeHome,
      worktreesDir: deps.config.sessions.worktreesDir,
      store: sessionsRepo,
      hostname: () => sessionsHost,
    });
    console.log(`[notesd] ingesting Claude Code sessions from ${deps.config.sessions.claudeHome}/projects as ${sessionsHost}`);
  }

  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([embeddings?.close(), imageEmbeddings?.close(), sessionIngest?.close()]);
  };
}
```
**Impact:** With `enabled: false` (every hand-built test config, via `DEFAULT_SESSIONS_CONFIG`) the only change is one log line `[notesd] session ingest off: NOTESD_SESSIONS=off` (the existing "logs once" test filters on `embeddings off`, unaffected). Phase 4 inserts its link worker inside the `else` block before `startSessionIngest` and passes `observers: [sessionLinks]`; phase 6 adds its block after this one and reuses `sessionsHost`/`SessionsRepo` as it sees fit.

### Step 7: Fixture Claude home
**File:** `tests/fixtures/claude-home/**` (new, committed)
**Change:** A small redacted Claude home whose record shapes are copied from the real parent session `d5c27d87-c38b-4fb8-83b5-1b1afaa5991f` (Claude Code 2.1.311): text shortened, thinking signatures and request blobs replaced with `redacted`, home rewritten to `/home/u` (a path that never exists, so repo resolution is exercised without disk). Contents:

- `projects/-home-u-mcp-notes/5e55a001-...-0001.jsonl`: main `cli` session: `/model` bare command, caveat meta, a typed prompt, a `git commit` (Bash tool_use + `[main abc1234] ...` result), Edit/Write/Read of plan docs, an Edit result that contains a fake `[main 0000000]` line (must not count), a peer message (`origin.kind: 'peer'`), the final assistant text, `custom-title`, `agent-name`, an interrupted marker, `cost-state`. Assistant messages repeat `message.id` like the real files.
- `projects/-home-u--worktrees-mcp-notes-wall-editing/5e55a001-...-0002.jsonl`: a swarm child in a deleted worktree; one message written as two records (usage repeated).
- `projects/-home-u-mcp-notes/5e55a001-...-0003.jsonl`: `/n` helper run, `entrypoint: sdk-cli` (must be skipped).
- `projects/-home-u-mcp-notes-data-chat/5e55a001-...-0004.jsonl`: wall chat agent, `sdk-ts`, in a `-data-chat` dir (never read).
- `projects/-home-u-mcp-notes/5e55a001-...-0001/subagents/agent-a1.jsonl` and `projects/-home-u-mcp-notes/memory/MEMORY.md`: must be ignored.
- `sessions/4242.json` (live in tests), `sessions/999.json` (dead), `sessions/4242.0123456789abcdef.key` (not an entry).

Each file below must end with exactly one trailing newline (`\n`) after its last line.

**`tests/fixtures/claude-home/projects/-home-u--worktrees-mcp-notes-wall-editing/5e55a001-0000-4000-8000-000000000002.jsonl`**
```jsonl
{"type":"custom-title","customTitle":"impl-wall-editing-p1","sessionId":"5e55a001-0000-4000-8000-000000000002"}
{"type":"agent-name","agentName":"impl-wall-editing-p1","sessionId":"5e55a001-0000-4000-8000-000000000002"}
{"parentUuid":null,"isSidechain":false,"promptId":"p-1","type":"user","message":{"role":"user","content":"/implement -f docs/plans/WALL_EDITING_PLAN.md --phase 1"},"uuid":"w-0","origin":{"kind":"human"},"timestamp":"2026-10-30T08:00:00.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/.worktrees/mcp-notes/wall-editing","sessionId":"5e55a001-0000-4000-8000-000000000002","version":"2.1.311","gitBranch":"feature/wall-editing"}
{"parentUuid":"w-0","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_X","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"redacted"}],"stop_reason":"tool_use","usage":{"input_tokens":10,"cache_creation_input_tokens":40,"cache_read_input_tokens":300,"output_tokens":20,"service_tier":"standard"}},"type":"assistant","uuid":"wa-0","timestamp":"2026-10-30T08:00:05.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/.worktrees/mcp-notes/wall-editing","sessionId":"5e55a001-0000-4000-8000-000000000002","version":"2.1.311","gitBranch":"feature/wall-editing"}
{"parentUuid":"wa-0","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_X","type":"message","role":"assistant","content":[{"type":"text","text":"Phase 1 implemented."}],"stop_reason":"tool_use","usage":{"input_tokens":10,"cache_creation_input_tokens":40,"cache_read_input_tokens":300,"output_tokens":20,"service_tier":"standard"}},"type":"assistant","uuid":"wa-1","timestamp":"2026-10-30T08:00:05.100Z","userType":"external","entrypoint":"cli","cwd":"/home/u/.worktrees/mcp-notes/wall-editing","sessionId":"5e55a001-0000-4000-8000-000000000002","version":"2.1.311","gitBranch":"feature/wall-editing"}
```

**`tests/fixtures/claude-home/projects/-home-u-mcp-notes-data-chat/5e55a001-0000-4000-8000-000000000004.jsonl`**
```jsonl
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"wall chat turn"},"uuid":"c-0","timestamp":"2026-11-01T01:00:00.000Z","userType":"external","entrypoint":"sdk-ts","cwd":"/home/u/mcp-notes-data/chat","sessionId":"5e55a001-0000-4000-8000-000000000004","version":"2.1.311","gitBranch":"main"}
```

**`tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001.jsonl`**
```jsonl
{"type":"mode","mode":"normal","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"type":"file-history-snapshot","messageId":"m-0","snapshot":{"messageId":"m-0","trackedFileBackups":{},"timestamp":"2026-11-02T02:12:57.807Z"},"isSnapshotUpdate":false}
{"parentUuid":null,"isSidechain":false,"promptId":"p-0","type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: the command below was run directly in Claude Code.</local-command-caveat>"},"isMeta":true,"uuid":"u-0","timestamp":"2026-11-02T02:12:57.806Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"u-0","isSidechain":false,"promptId":"p-0","type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"},"uuid":"u-1","timestamp":"2026-11-02T02:12:57.807Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"u-1","isSidechain":false,"promptId":"p-0","type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to Opus</local-command-stdout>"},"uuid":"u-2","timestamp":"2026-11-02T02:12:57.808Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"type":"api-request-blob","sessionId":"5e55a001-0000-4000-8000-000000000001","hash":"h-0","message":{"role":"user","content":"redacted"}}
{"parentUuid":"u-2","isSidechain":false,"promptId":"p-1","type":"user","message":{"role":"user","content":"sketch the project-session-graph feature"},"uuid":"u-3","origin":{"kind":"human"},"promptSource":"typed","timestamp":"2026-11-02T02:21:51.300Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"u-3","isSidechain":false,"attachment":{"type":"environment","snapshot":{"workingDirectory":"/home/u/mcp-notes","isWorktree":false,"isGitRepo":true}},"type":"attachment","uuid":"a-0","timestamp":"2026-11-02T02:21:51.310Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"type":"last-prompt","lastPrompt":"sketch the project-session-graph feature","leafUuid":"u-3","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"type":"ai-title","aiTitle":"Project session graph","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"parentUuid":"a-0","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_A","type":"message","role":"assistant","content":[{"type":"text","text":"I will read the swarm code first."}],"stop_reason":"tool_use","usage":{"input_tokens":2,"cache_creation_input_tokens":20795,"cache_read_input_tokens":29065,"output_tokens":544,"service_tier":"standard"}},"type":"assistant","uuid":"as-0","timestamp":"2026-11-02T02:21:55.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"as-0","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_A","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"git add -A && git commit -m \"feat(sessions): ingest transcripts\"","description":"Commit"}}],"stop_reason":"tool_use","usage":{"input_tokens":2,"cache_creation_input_tokens":20795,"cache_read_input_tokens":29065,"output_tokens":544,"service_tier":"standard"}},"type":"assistant","uuid":"as-1","timestamp":"2026-11-02T02:21:55.100Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"as-1","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"[main abc1234] feat(sessions): ingest transcripts\n 2 files changed, 10 insertions(+)","is_error":false}]},"uuid":"u-4","timestamp":"2026-11-02T02:21:58.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main","toolUseResult":{"stdout":"[main abc1234] feat(sessions): ingest transcripts\n 2 files changed, 10 insertions(+)","stderr":"","interrupted":false},"sourceToolAssistantUUID":"as-1"}
{"parentUuid":"u-4","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_B","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"replace_all":false,"file_path":"/home/u/mcp-notes/docs/plans/PROJECT_SESSION_GRAPH_PLAN.md","old_string":"a","new_string":"b"}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"cache_creation_input_tokens":500,"cache_read_input_tokens":30000,"output_tokens":300,"service_tier":"standard"}},"type":"assistant","uuid":"as-2","timestamp":"2026-11-02T02:22:01.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"as-2","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_B","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"Write","input":{"file_path":"/home/u/mcp-notes/src/sessions/ingest.ts","content":"redacted"}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"cache_creation_input_tokens":500,"cache_read_input_tokens":30000,"output_tokens":300,"service_tier":"standard"}},"type":"assistant","uuid":"as-3","timestamp":"2026-11-02T02:22:01.100Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"as-2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"The file has been updated. [main 0000000] not a commit","is_error":false}]},"uuid":"u-5","timestamp":"2026-11-02T02:22:02.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main","toolUseResult":{"type":"update","filePath":"x"},"sourceToolAssistantUUID":"as-2"}
{"parentUuid":"as-3","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_3","type":"tool_result","content":"File created successfully","is_error":false}]},"uuid":"u-6","timestamp":"2026-11-02T02:22:02.100Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main","toolUseResult":{"type":"update","filePath":"x"},"sourceToolAssistantUUID":"as-3"}
{"parentUuid":"u-6","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_C","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_4","name":"Read","input":{"file_path":"/home/u/mcp-notes/.workflows/plan/project-session-graph/phase-3.md"}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":31000,"output_tokens":50,"service_tier":"standard"}},"type":"assistant","uuid":"as-4","timestamp":"2026-11-02T02:22:05.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"as-4","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_4","type":"tool_result","content":"1\t# Phase 3","is_error":false}]},"uuid":"u-7","timestamp":"2026-11-02T02:22:05.500Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main","toolUseResult":{"type":"update","filePath":"x"},"sourceToolAssistantUUID":"as-4"}
{"parentUuid":"u-7","isSidechain":false,"type":"user","message":{"role":"user","content":"DONE: phase 1 landed"},"uuid":"u-8","origin":{"kind":"peer","from":"uds:/run/user/1000/cc-socks/1.sock","name":"impl-x-p1"},"timestamp":"2026-11-02T02:23:00.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"parentUuid":"u-8","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_D","type":"message","role":"assistant","content":[{"type":"text","text":"Done: the plan is written."}],"stop_reason":"tool_use","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":32000,"output_tokens":20,"service_tier":"standard"}},"type":"assistant","uuid":"as-5","timestamp":"2026-11-02T02:23:10.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"type":"custom-title","customTitle":"session-graph-discussion","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"type":"agent-name","agentName":"session-graph-discussion","sessionId":"5e55a001-0000-4000-8000-000000000001"}
{"parentUuid":"as-5","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"u-9","timestamp":"2026-11-02T02:23:20.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
{"type":"cost-state","sessionId":"5e55a001-0000-4000-8000-000000000001","totalCostUSD":1.25,"totalAPIDuration":1000,"totalDuration":2000,"startTime":1793585571866,"modelUsage":{"claude-opus-5[1m]":{"inputTokens":100,"outputTokens":800,"thinkingTokens":10,"cacheReadInputTokens":45000,"cacheCreationInputTokens":2000,"webSearchRequests":0,"costUSD":1.2},"claude-haiku-4-5-20251001":{"inputTokens":20,"outputTokens":100,"thinkingTokens":0,"cacheReadInputTokens":5000,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.05}},"hasUnknownModelCost":false}
```

**`tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001/subagents/agent-a1.jsonl`**
```jsonl
{"parentUuid":null,"isSidechain":true,"type":"user","message":{"role":"user","content":"subagent prompt"},"uuid":"s-0","timestamp":"2026-11-02T02:22:00.000Z","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000001","version":"2.1.311","gitBranch":"main"}
```

**`tests/fixtures/claude-home/projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000003.jsonl`**
```jsonl
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"/n how much did i spend"},"uuid":"n-0","timestamp":"2026-11-01T01:00:00.000Z","userType":"external","entrypoint":"sdk-cli","cwd":"/home/u/mcp-notes","sessionId":"5e55a001-0000-4000-8000-000000000003","version":"2.1.311","gitBranch":"main"}
```

**`tests/fixtures/claude-home/projects/-home-u-mcp-notes/memory/MEMORY.md`**
```text
- memory index
```

**`tests/fixtures/claude-home/sessions/4242.0123456789abcdef.key`**
```text
not json
```

**`tests/fixtures/claude-home/sessions/4242.json`**
```json
{"pid":4242,"sessionId":"5e55a001-0000-4000-8000-000000000001","cwd":"/home/u/mcp-notes","startedAt":1793585571866,"procStart":"303782","version":"2.1.311","peerProtocol":1,"kind":"interactive","entrypoint":"cli","tmux":"note:@0.%7","messagingSocketPath":"/run/user/1000/cc-socks/4242.sock","name":"session-graph-discussion","nameSource":"user","status":"busy","updatedAt":1793585600000}
```

**`tests/fixtures/claude-home/sessions/999.json`**
```json
{"pid":999,"sessionId":"5e55a001-0000-4000-8000-000000000002","cwd":"/home/u/.worktrees/mcp-notes/wall-editing","startedAt":1793400000000,"procStart":"1000","version":"2.1.311","kind":"interactive","entrypoint":"cli","status":"idle","updatedAt":1793400005000}
```

**Impact:** Test data only. Never read by the daemon.

### Step 8: Test helpers

**File:** `tests/helpers/claudeHome.ts` (new)
**Change:** Fixture constants and `copyFixtureClaudeHome()` (a private temp copy; tests append to it).
**Code:**
```ts
import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The committed, redacted fixture Claude home (shapes measured from real 2.1.311 transcripts). */
export const FIXTURE_CLAUDE_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claude-home');

/** Fixture session ids and paths. Cwds live under the fake home `/home/u`, which never exists on disk. */
export const FIXTURE = {
  homeDir: '/home/u',
  worktreesDir: '/home/u/.worktrees',
  main: '5e55a001-0000-4000-8000-000000000001',
  worktreeChild: '5e55a001-0000-4000-8000-000000000002',
  sdkCli: '5e55a001-0000-4000-8000-000000000003',
  sdkTs: '5e55a001-0000-4000-8000-000000000004',
  mainFile: 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-000000000001.jsonl',
  worktreeFile: 'projects/-home-u--worktrees-mcp-notes-wall-editing/5e55a001-0000-4000-8000-000000000002.jsonl',
} as const;

/** A private copy of the fixture Claude home in a temp dir (tests append to it). Never the real ~/.claude. */
export async function copyFixtureClaudeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-claude-home-'));
  await cp(FIXTURE_CLAUDE_HOME, dir, { recursive: true });
  return dir;
}
```

**File:** `tests/helpers/memoryIngestStore.ts` (new)
**Change:** `SessionsRepo`'s two ingest methods over a Map, using phase 1's real `mergeTranscriptPatch` and compare-and-set rule, so unit tests assert the same values the database would hold.
**Code:**
```ts
import type { IngestStore } from '../../src/sessions/ingest.js';
import { mergeTranscriptPatch } from '../../src/sessions/merge.js';
import type { SessionRow, TranscriptOffset, TranscriptPatch, TranscriptUpsertResult } from '../../src/sessions/types.js';

/** A `cc_sessions` row with every column empty, as `SessionsRepo.ensureSession` would insert it. */
export function blankSessionRow(sessionId: string, host: string, over: Partial<SessionRow> = {}): SessionRow {
  const at = new Date(0);
  return {
    sessionId,
    nodeId: 'ZZ-ZZ',
    host,
    repo: null,
    cwd: null,
    branch: null,
    name: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    lastPrompt: null,
    entrypoint: null,
    version: null,
    startedAt: null,
    lastActiveAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    models: {},
    parentSessionId: null,
    parentLinkSource: null,
    tmux: null,
    transcriptPath: null,
    transcriptOffset: 0,
    transcriptSize: null,
    prompts: [],
    commits: [],
    filesEdited: [],
    planDocs: [],
    finalMessage: null,
    summary: null,
    summarySha: null,
    summarizedAt: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/**
 * `SessionsRepo`'s two ingest methods over a Map, with the repo's own merge (`mergeTranscriptPatch`)
 * and its compare-and-set rule, so unit tests see the same row values the database would hold.
 * `patches` records every call in order.
 */
export class MemoryIngestStore implements IngestStore {
  readonly rows = new Map<string, SessionRow>();
  readonly patches: TranscriptPatch[] = [];

  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const out = new Map<string, TranscriptOffset>();
    for (const row of this.rows.values()) {
      if (row.host === host) out.set(row.sessionId, { offset: row.transcriptOffset, size: row.transcriptSize, path: row.transcriptPath });
    }
    return out;
  }

  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    this.patches.push(patch);
    const row = this.rows.get(patch.sessionId) ?? blankSessionRow(patch.sessionId, patch.host);
    this.rows.set(patch.sessionId, row);
    if (row.host !== patch.host) return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row };
    if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
      return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row };
    }
    const next: SessionRow = { ...row, ...mergeTranscriptPatch(row, patch) };
    this.rows.set(patch.sessionId, next);
    return { applied: true, row: next };
  }

  /** A row a hook would have made before the transcript had any message (phase 5's upsertFromHook). */
  seedRow(sessionId: string, host: string, over: Partial<SessionRow> = {}): void {
    this.rows.set(sessionId, blankSessionRow(sessionId, host, over));
  }
}
```

**Impact:** Test-only.

### Step 9: Hand-built `Config` literals get `sessions: DEFAULT_SESSIONS_CONFIG`
**Change:** `Config.sessions` is required (Step 1), so every literal adds it, with the off default.
Each edit is: add `DEFAULT_SESSIONS_CONFIG` to the existing `../../src/config.js` import, and add
the field. Exact replacements:

**File:** `tests/unit/embeddings/embedBackfillCli.test.ts:3` and `:37-38`
```ts
import { ConfigError, DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../../src/config.js';
```
```ts
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  sessions: DEFAULT_SESSIONS_CONFIG,
});
```

**File:** `tests/integration/daemon.int.test.ts:5` and `:20`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
```
```ts
  return { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG };
```

**File:** `tests/integration/mcp.tools.int.test.ts:9` and `:21`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
```
```ts
const config: Config = { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG };
```

**File:** `tests/integration/connectors/mcp.int.test.ts:8` and `:18`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../../src/config.js';
```
```ts
const config: Config = { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG };
```

**File:** `tests/integration/related.int.test.ts:9` and `:42-44`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
```
```ts
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  sessions: DEFAULT_SESSIONS_CONFIG,
};
```

**File:** `tests/integration/images.int.test.ts:9`, `:139` and `:170` (both literals are identical; replace both)
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../src/config.js';
```
```ts
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG },
```

**File:** `tests/integration/imageHarness.ts:8` and `:47`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../src/config.js';
```
```ts
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG },
```

**File:** `tests/integration/helpers/api-harness.ts:10` and `:53`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../../src/config.js';
```
```ts
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG },
```

**File:** `tests/integration/embeddings.worker.int.test.ts:9` and `:101-103`
```ts
import { DEFAULT_CHAT_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
```
```ts
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: { apiKey },
    sessions: DEFAULT_SESSIONS_CONFIG,
  };
```

**File:** `tests/live/chat.live.test.ts:53` (the only test that builds its config with `loadConfig`
and then starts a daemon; without this it would ingest the real `~/.claude` into the test DB)
```ts
      CHAT_BRAIN: 'claude',
      // Never ingest the real ~/.claude into the test database.
      NOTESD_SESSIONS: 'off',
```

Not changed: `tests/integration/imageEmbeddings.worker.int.test.ts:147` spreads `h.deps.config`
(gets `sessions` from `imageHarness.ts`); `tests/unit/mcp.instructions.test.ts:174` casts a
partial object. A `grep -rn "chat: DEFAULT_CHAT_CONFIG" src tests` after this step must show every
hit also carrying `sessions:` (or lines 37/101/42 of the multi-line literals above).
**Impact:** Mechanical; no behaviour change in any existing test.

### Step 10: Config unit tests
**File:** `tests/unit/config.test.ts:6` (import), `:30-37` (defaults expectation), end of file (new describe)
**Code:** replace the import line with
```ts
import {
  ConfigError,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SESSIONS_CONFIG,
  loadConfig,
  REPO_ROOT,
} from '../../src/config.js'
```
in `it('applies defaults')` the `toEqual` object gains one line after `embeddings: DEFAULT_EMBEDDINGS_CONFIG,`:
```ts
      sessions: { claudeHome: path.join(homedir(), '.claude'), worktreesDir: path.join(homedir(), '.worktrees'), enabled: true },
```
and append at the end of the file:
```ts

describe('loadConfig sessions', () => {
  const sessions = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).sessions

  it('defaults to ~/.claude and ~/.worktrees, on', () => {
    expect(sessions({})).toEqual({
      claudeHome: path.join(homedir(), '.claude'),
      worktreesDir: path.join(homedir(), '.worktrees'),
      enabled: true,
    })
  })

  it('expands ~ and resolves CLAUDE_HOME and NOTES_WORKTREES_DIR', () => {
    expect(sessions({ CLAUDE_HOME: '~/alt-claude', NOTES_WORKTREES_DIR: '/srv/wt/' })).toMatchObject({
      claudeHome: path.join(homedir(), 'alt-claude'),
      worktreesDir: '/srv/wt',
    })
  })

  it('turns ingest off with NOTESD_SESSIONS=off and rejects other words', () => {
    for (const off of ['off', 'OFF', '0', 'false', 'no']) expect(sessions({ NOTESD_SESSIONS: off }).enabled).toBe(false)
    for (const on of ['', 'on', '1', 'true', 'yes']) expect(sessions({ NOTESD_SESSIONS: on }).enabled).toBe(true)
    expect(() => sessions({ NOTESD_SESSIONS: 'maybe' })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_SESSIONS_CONFIG off so hand-built test configs never read ~/.claude', () => {
    expect(DEFAULT_SESSIONS_CONFIG.enabled).toBe(false)
  })
})
```
**Impact:** Test-only.


### Step 11: Unit tests: transcript
**File:** `tests/unit/sessions/transcript.test.ts` (new)
**Change:** Reader (partial line, offsets, multi-byte across chunks, stop), parser filter, accumulator on the fixture (every field), cross-read carry, commit matching, sidechains, prompt cap, patch building.
**Code:**
```ts
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accumulateText,
  buildTranscriptPatch,
  parseCommitLines,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type PatchContext,
} from '../../../src/sessions/transcript.js';
import { MAX_PROMPTS } from '../../../src/sessions/types.js';
import { FIXTURE, FIXTURE_CLAUDE_HOME } from '../../helpers/claudeHome.js';

const user = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-02T00:00:00Z', cwd: '/c', entrypoint: 'cli', ...extra });
const assistant = (id: string, usage: Record<string, number>, block: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [block], usage }, timestamp: '2026-11-02T00:00:01Z' });

describe('parseRecord', () => {
  it('drops blank, torn, non-object and ignored-type lines', () => {
    expect(parseRecord('')).toBeNull();
    expect(parseRecord('{"type":"user","mess')).toBeNull();
    expect(parseRecord('[1,2]')).toBeNull();
    expect(parseRecord('{"type":"api-request-blob","x":1}')).toBeNull();
    expect(parseRecord('{"type":"file-history-snapshot"}')).toBeNull();
    expect(parseRecord('{"type":"agent-name","agentName":"x"}')).toEqual({ type: 'agent-name', agentName: 'x' });
  });
});

describe('readJsonlFrom', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notes-jsonl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hands out complete lines only and stops before a trailing partial line', async () => {
    const file = path.join(dir, 's.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":');
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.endOffset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'));
    expect(r.size).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":'));

    await appendFile(file, '3}\n');
    const more: string[] = [];
    const r2 = await readJsonlFrom(file, r.endOffset, (l) => more.push(l));
    expect(more).toEqual(['{"c":3}']);
    expect(r2.endOffset).toBe(r2.size);
  });

  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const file = path.join(dir, 'u.jsonl');
    const text = `${JSON.stringify({ t: 'héllo wörld ✓ 日本語'.repeat(20) })}\n${JSON.stringify({ t: '✓' })}\n`;
    await writeFile(file, text);
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l), { chunkBytes: 7 });
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(text.trim().split('\n').map((l) => JSON.parse(l) as unknown));
    expect(r.endOffset).toBe(Buffer.byteLength(text));
  });

  it('stops at a chunk boundary when asked and reports how far it got', async () => {
    const file = path.join(dir, 'v.jsonl');
    await writeFile(file, '{"a":1}\n'.repeat(10));
    let calls = 0;
    const r = await readJsonlFrom(file, 0, () => undefined, { chunkBytes: 16, shouldStop: () => ++calls > 1 });
    expect(r.stopped).toBe(true);
    expect(r.endOffset).toBe(16);
  });
});

describe('TranscriptAccumulator on the fixture', () => {
  it('extracts the session fields from the main fixture transcript', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.mainFile), 'utf8');
    const d = accumulateText(FIXTURE.main, text).delta();
    expect(d.cwd).toBe('/home/u/mcp-notes');
    expect(d.branch).toBe('main');
    expect(d.entrypoint).toBe('cli');
    expect(d.version).toBe('2.1.311');
    expect(d.name).toBe('session-graph-discussion');
    expect(d.customTitle).toBe('session-graph-discussion');
    expect(d.aiTitle).toBe('Project session graph');
    expect(d.lastPrompt).toBe('sketch the project-session-graph feature');
    // `/model` (bare command), the peer message and "[Request interrupted by user]" are not prompts.
    expect(d.firstPrompt).toBe('sketch the project-session-graph feature');
    expect(d.prompts).toEqual([{ text: 'sketch the project-session-graph feature', at: '2026-11-02T02:21:51.300Z' }]);
    expect(d.firstAt?.toISOString()).toBe('2026-11-02T02:12:57.806Z');
    expect(d.lastAt?.toISOString()).toBe('2026-11-02T02:23:20.000Z');
    // The Edit result that happens to contain "[main 0000000] ..." is not a commit.
    expect(d.commits).toEqual([{ sha: 'abc1234', subject: 'feat(sessions): ingest transcripts', at: '2026-11-02T02:21:58.000Z' }]);
    expect(d.filesEdited).toEqual(['/home/u/mcp-notes/docs/plans/PROJECT_SESSION_GRAPH_PLAN.md', '/home/u/mcp-notes/src/sessions/ingest.ts']);
    expect(d.planDocs).toEqual([
      '/home/u/mcp-notes/docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
      '/home/u/mcp-notes/.workflows/plan/project-session-graph/phase-3.md',
    ]);
    expect(d.finalMessage).toBe('Done: the plan is written.');
    // Usage once per message id: msg_A, msg_B, msg_C, msg_D.
    const usage = { inputTokens: 5, outputTokens: 914, cacheReadTokens: 122065, cacheWriteTokens: 21295 };
    expect(d.tokens).toEqual(usage);
    expect(d.models).toEqual({ 'claude-opus-5-5': usage });
    expect(d.costUsd).toBe(1.25);
  });

  it('counts a message once when its records straddle two reads (carry)', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.worktreeFile), 'utf8');
    const lines = text.trim().split('\n');
    const first = accumulateText(FIXTURE.worktreeChild, `${lines.slice(0, 4).join('\n')}\n`);
    const second = accumulateText(FIXTURE.worktreeChild, `${lines.slice(4).join('\n')}\n`, first.carry());
    expect(first.delta().tokens).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(second.delta().tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(second.delta().finalMessage).toBe('Phase 1 implemented.');
  });

  it('matches a git commit result to its tool_use across reads', () => {
    const acc = new TranscriptAccumulator('s');
    acc.add(JSON.parse(assistant('m1', {}, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m x' } })) as Record<string, unknown>);
    const next = new TranscriptAccumulator('s', acc.carry());
    next.add({
      type: 'user',
      timestamp: '2026-11-02T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[feature/x (root-commit) 1a2b3c4d] first commit' }] }] },
      toolUseResult: { stdout: '...' },
    });
    expect(next.delta().commits).toEqual([{ sha: '1a2b3c4d', subject: 'first commit', at: '2026-11-02T00:00:02Z' }]);
  });

  it('ignores sidechain records and resets the final message on a tool_use', () => {
    const d = accumulateText(
      's',
      [
        user('hello'),
        assistant('m1', {}, { type: 'text', text: 'before tools' }),
        assistant('m1', {}, { type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/r.ts' } }),
        JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'side prompt' } }),
      ].join('\n'),
    ).delta();
    expect(d.prompts.map((p) => p.text)).toEqual(['hello']);
    expect(d.finalMessage).toBeNull();
    expect(d.filesEdited).toEqual([]);
  });

  it('keeps the newest prompts and the first one when a read has many', () => {
    const text = Array.from({ length: MAX_PROMPTS + 30 }, (_, i) => user(`p${i}`)).join('\n');
    const d = accumulateText('s', text).delta();
    expect(d.prompts).toHaveLength(MAX_PROMPTS);
    expect(d.prompts.at(-1)?.text).toBe(`p${MAX_PROMPTS + 29}`);
    expect(d.firstPrompt).toBe('p0');
  });
});

describe('parseCommitLines', () => {
  it('reads every [branch sha] subject line', () => {
    expect(parseCommitLines('[main abc1234] one\n 1 file changed\n[main def5678] two', null).map((c) => c.sha)).toEqual(['abc1234', 'def5678']);
    expect(parseCommitLines('nothing here', null)).toEqual([]);
  });
});

describe('buildTranscriptPatch', () => {
  const ctx = (over: Partial<PatchContext> = {}): PatchContext => ({
    host: 'test-host',
    transcriptPath: '/x/s.jsonl',
    fromOffset: 0,
    toOffset: 100,
    size: 120,
    repo: 'mcp-notes',
    ...over,
  });

  it('sends cwd, entrypoint and repo only for a read from byte 0', () => {
    const d = accumulateText('s', `${user('hi', { cwd: '/home/u/mcp-notes/web' })}\n`).delta();
    expect(buildTranscriptPatch(d, ctx())).toMatchObject({
      sessionId: 's',
      host: 'test-host',
      fromOffset: 0,
      toOffset: 100,
      size: 120,
      cwd: '/home/u/mcp-notes/web',
      entrypoint: 'cli',
      repo: 'mcp-notes',
      firstPrompt: 'hi',
    });
    const later = buildTranscriptPatch(d, ctx({ fromOffset: 50, repo: null }));
    expect(later.cwd).toBeNull();
    expect(later.entrypoint).toBeNull();
    expect(later.repo).toBeNull();
    expect(later.name).toBeNull();
  });
});
```
**Impact:** Test-only.

### Step 12: Unit tests: repo resolution
**File:** `tests/unit/sessions/repoResolve.test.ts` (new)
**Change:** Every rule, the lossy project-dir decoding, and that git runs only for an existing dir, once per cwd.
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  createRepoResolver,
  encodeProjectDir,
  repoFromClaudeWorktree,
  repoFromGitRoots,
  repoFromPath,
  repoFromProjectDir,
  repoFromWorktreePath,
  type GitRoots,
} from '../../../src/sessions/repoResolve.js';

const HOME = '/home/u';
const WT = '/home/u/.worktrees';

describe('path conventions', () => {
  it('maps a worktree path to its repo whether or not the dir exists', () => {
    expect(repoFromWorktreePath('/home/u/.worktrees/mcp-notes/wall-editing', WT)).toBe('mcp-notes');
    expect(repoFromWorktreePath('/home/u/.worktrees/agentic_golang/uatp-4258/tools/x', WT)).toBe('agentic_golang');
    expect(repoFromWorktreePath('/home/u/mcp-notes', WT)).toBeNull();
    expect(repoFromWorktreePath(WT, WT)).toBeNull();
  });

  it('maps a Claude Code worktree to the repo that holds it', () => {
    expect(repoFromClaudeWorktree('/home/u/seer/.claude/worktrees/ui-copy-spacing')).toBe('seer');
    expect(repoFromClaudeWorktree('/home/u/seer')).toBeNull();
  });

  it('falls back to ~, the first segment under home, then the basename', () => {
    expect(repoFromPath('/home/u', HOME)).toBe('~');
    expect(repoFromPath('/home/u/agentic/docs/plans', HOME)).toBe('agentic');
    expect(repoFromPath('/srv/tools/thing', HOME)).toBe('thing');
  });

  it('names the main checkout from git roots, also for a linked worktree', () => {
    expect(repoFromGitRoots({ toplevel: '/home/u/mcp-notes', commonDir: '/home/u/mcp-notes/.git' })).toBe('mcp-notes');
    expect(repoFromGitRoots({ toplevel: '/elsewhere/feature-x', commonDir: '/home/u/seer/.git' })).toBe('seer');
    expect(repoFromGitRoots({ toplevel: '/srv/bare-co', commonDir: '/srv/bare.git' })).toBe('bare-co');
  });
});

describe('repoFromProjectDir', () => {
  const known = ['agentic', 'agentic_golang', 'mcp-notes'];
  it('decodes worktree and home project dirs against real directory names', () => {
    expect(encodeProjectDir('/home/u/.worktrees/agentic_golang/x')).toBe('-home-u--worktrees-agentic-golang-x');
    expect(repoFromProjectDir('-home-u--worktrees-agentic-golang-fix-stream', HOME, WT, known)).toBe('agentic_golang');
    expect(repoFromProjectDir('-home-u--worktrees-agentic-popup-data', HOME, WT, known)).toBe('agentic');
    expect(repoFromProjectDir('-home-u-mcp-notes', HOME, WT, known)).toBe('mcp-notes');
    expect(repoFromProjectDir('-home-u', HOME, WT, known)).toBe('~');
    expect(repoFromProjectDir('-home-u-unknown-thing', HOME, WT, known)).toBe('unknown');
    expect(repoFromProjectDir('-tmp-scratch', HOME, WT, known)).toBeNull();
  });
});

describe('createRepoResolver', () => {
  it('uses git only for a directory that exists, and caches per cwd', async () => {
    const gitCalls: string[] = [];
    const resolver = createRepoResolver({
      homeDir: HOME,
      worktreesDir: WT,
      isDirectory: async (p) => p === '/home/u/mcp-notes/web',
      gitRoots: async (cwd): Promise<GitRoots | null> => {
        gitCalls.push(cwd);
        return { toplevel: '/home/u/mcp-notes', commonDir: '/home/u/mcp-notes/.git' };
      },
      listRepoNames: async () => ['mcp-notes'],
    });
    expect(await resolver.resolve('/home/u/mcp-notes/web', '-home-u-mcp-notes-web')).toBe('mcp-notes');
    expect(await resolver.resolve('/home/u/mcp-notes/web', '-home-u-mcp-notes-web')).toBe('mcp-notes');
    expect(gitCalls).toEqual(['/home/u/mcp-notes/web']);
    expect(await resolver.resolve('/home/u/.worktrees/mcp-notes/gone', 'x')).toBe('mcp-notes');
    expect(await resolver.resolve('/home/u/deleted-repo/sub', 'x')).toBe('deleted-repo');
    expect(await resolver.resolve(null, '-home-u--worktrees-mcp-notes-wall-editing')).toBe('mcp-notes');
    expect(gitCalls).toHaveLength(1);
  });
});
```
**Impact:** Test-only.

### Step 13: Unit tests: live registry
**File:** `tests/unit/sessions/registry.test.ts` (new)
**Change:** Live/dead filtering, `.key` and junk files, newest entry wins, `readLiveSessions`, pid start-time check, TTL cache.
**Code:**
```ts
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLiveRegistry, isPidAlive, parseLiveEntry, readLiveRegistry, readLiveSessions } from '../../../src/sessions/registry.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';

let home: string;
beforeEach(async () => {
  home = await copyFixtureClaudeHome();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readLiveRegistry', () => {
  it('returns live entries by session id and skips dead pids, .key files and junk', async () => {
    await writeFile(path.join(home, 'sessions', '777.json'), '{not json');
    const checked: Array<[number, string | null]> = [];
    const live = await readLiveRegistry({
      claudeHome: home,
      isAlive: (pid, procStart) => {
        checked.push([pid, procStart]);
        return pid === 4242;
      },
    });
    expect([...live.keys()]).toEqual([FIXTURE.main]);
    expect(live.get(FIXTURE.main)).toMatchObject({
      pid: 4242,
      tmux: 'note:@0.%7',
      name: 'session-graph-discussion',
      status: 'busy',
      cwd: '/home/u/mcp-notes',
      messagingSocketPath: '/run/user/1000/cc-socks/4242.sock',
    });
    expect(live.get(FIXTURE.main)?.updatedAt?.getTime()).toBe(1793585600000);
    expect(checked).toContainEqual([4242, '303782']);
    expect(checked).toContainEqual([999, '1000']);
  });

  it('lists the same entries for the summary worker', async () => {
    const list = await readLiveSessions(home, (pid) => pid === 4242);
    expect(list.map((s) => s.sessionId)).toEqual([FIXTURE.main]);
  });

  it('is empty without a sessions dir', async () => {
    expect((await readLiveRegistry({ claudeHome: path.join(home, 'nope') })).size).toBe(0);
  });

  it('prefers the most recently updated entry for a session id', async () => {
    await writeFile(
      path.join(home, 'sessions', '5000.json'),
      JSON.stringify({ pid: 5000, sessionId: FIXTURE.main, status: 'idle', updatedAt: 1793585700000 }),
    );
    const live = await readLiveRegistry({ claudeHome: home, isAlive: (pid) => pid !== 999 });
    expect(live.get(FIXTURE.main)?.pid).toBe(5000);
  });
});

describe('parseLiveEntry', () => {
  it('rejects entries without a pid or session id', () => {
    expect(parseLiveEntry({ sessionId: 'x' })).toBeNull();
    expect(parseLiveEntry({ pid: 1 })).toBeNull();
    expect(parseLiveEntry([])).toBeNull();
    expect(parseLiveEntry({ pid: 1, sessionId: 'x', procStart: 12 })?.procStart).toBe('12');
  });
});

describe('isPidAlive', () => {
  it('sees this process as alive and a recycled pid as dead', () => {
    expect(isPidAlive(process.pid, null)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345, null)).toBe(false);
    if (process.platform === 'linux') expect(isPidAlive(process.pid, 'not-the-start-time')).toBe(false);
  });
});

describe('createLiveRegistry', () => {
  it('re-reads only after the ttl', async () => {
    let t = 0;
    let reads = 0;
    const registry = createLiveRegistry({
      claudeHome: home,
      ttlMs: 1000,
      now: () => t,
      isAlive: (pid) => {
        reads += 1;
        return pid === 4242;
      },
    });
    await registry.get();
    await registry.get();
    const afterFirst = reads;
    t = 1500;
    await registry.get();
    expect(reads).toBe(afterFirst * 2);
    registry.invalidate();
    await registry.get();
    expect(reads).toBe(afterFirst * 3);
  });
});
```
**Impact:** Test-only.

### Step 14: Unit tests: ingester
**File:** `tests/unit/sessions/ingest.test.ts` (new)
**Change:** Backfill rows and exclusions, observer batches/passes, incremental tail with a partial line, restart without re-reading, shrink -> reset, deferred session, hook-created rows, compare-and-set miss, other-host rows, real chokidar watcher, a new project dir, observer failures, bounded close.
**Code:**
```ts
import { appendFile, mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isIgnoredWatchPath,
  listTranscripts,
  sessionIdFromPath,
  startSessionIngest,
  type IngestBatch,
  type IngestPass,
  type SessionIngester,
  type SessionIngestOptions,
} from '../../../src/sessions/ingest.js';
import { createRepoResolver } from '../../../src/sessions/repoResolve.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

let home: string;
let store: MemoryIngestStore;
const running: SessionIngester[] = [];
const quiet = (): void => undefined;

function start(over: Partial<SessionIngestOptions> = {}): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store,
    hostname: () => 'test-host',
    resolver: createRepoResolver({
      homeDir: FIXTURE.homeDir,
      worktreesDir: FIXTURE.worktreesDir,
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: quiet,
    ...over,
  });
  running.push(ingester);
  return ingester;
}

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const mainPath = (): string => path.join(home, FIXTURE.mainFile);

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  home = await copyFixtureClaudeHome();
  store = new MemoryIngestStore();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('helpers', () => {
  it('recognises top-level session transcripts only', async () => {
    expect(sessionIdFromPath('/x/-home-u/5E55A001-0000-4000-8000-000000000001.jsonl')).toBe(FIXTURE.main);
    expect(sessionIdFromPath('/x/-home-u/agent-a1.jsonl')).toBeNull();
    const files = (await listTranscripts(path.join(home, 'projects'))).map((f) => path.relative(home, f.path)).sort();
    expect(files).toEqual([FIXTURE.worktreeFile, FIXTURE.mainFile, `projects/-home-u-mcp-notes/${FIXTURE.sdkCli}.jsonl`].sort());
  });

  it('watches project dirs and their transcripts, nothing deeper', () => {
    const root = path.join(home, 'projects');
    expect(isIgnoredWatchPath(root, root)).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes'))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes-data-chat'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', `${FIXTURE.main}.jsonl`))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', 'memory'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'subagents', 'agent-a1.jsonl'))).toBe(true);
  });
});

describe('startSessionIngest', () => {
  it('backfills one row per cli session, with repo resolved, and skips sdk sessions', async () => {
    const batches: IngestBatch[] = [];
    const passes: IngestPass[] = [];
    const ingester = start({
      observers: [
        {
          onBatch: (b) => batches.push(b),
          onPassComplete: (p) => {
            passes.push(p);
          },
        },
      ],
    });
    const report = await ingester.ready;
    expect(report).toMatchObject({ reason: 'backfill', files: 3, upserted: 2, failed: 0 });
    expect([...store.rows.keys()].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());

    const main = store.rows.get(FIXTURE.main);
    expect(main).toMatchObject({
      host: 'test-host',
      repo: 'mcp-notes',
      cwd: '/home/u/mcp-notes',
      entrypoint: 'cli',
      name: 'session-graph-discussion',
      firstPrompt: 'sketch the project-session-graph feature',
      costUsd: 1.25,
      inputTokens: 5,
      outputTokens: 914,
      transcriptPath: mainPath(),
    });
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234']);
    expect(main?.transcriptOffset).toBe((await stat(mainPath())).size);
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({ repo: 'mcp-notes', branch: 'feature/wall-editing', name: 'impl-wall-editing-p1' });

    expect(batches.map((b) => b.sessionId).sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());
    const mainBatch = batches.find((b) => b.sessionId === FIXTURE.main);
    expect(mainBatch).toMatchObject({ host: 'test-host', fromOffset: 0, transcriptPath: mainPath() });
    // Every parsed record of the read, ignored types (mode, api-request-blob, ...) excluded.
    expect(mainBatch?.records.some((r) => r.type === 'agent-name')).toBe(true);
    expect(mainBatch?.records.some((r) => r.type === 'api-request-blob')).toBe(false);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ initial: true, reason: 'backfill' });
    expect([...(passes[0]?.sessionIds ?? [])].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());

    await ingester.sweep();
    expect(passes[1]).toMatchObject({ initial: false, reason: 'sweep', sessionIds: [] });
  });

  it('reads only appended bytes, holds back a partial line, and adds usage without double counting', async () => {
    const ingester = start();
    await ingester.ready;
    const before = store.rows.get(FIXTURE.worktreeChild);
    const file = path.join(home, FIXTURE.worktreeFile);
    const offset = before?.transcriptOffset ?? 0;

    const next = line({
      type: 'assistant',
      timestamp: '2026-10-30T09:00:00.000Z',
      sessionId: FIXTURE.worktreeChild,
      message: { id: 'msg_Y', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }], usage: { input_tokens: 1, output_tokens: 2 } },
    });
    await appendFile(file, next.slice(0, 40));
    await ingester.sweep();
    expect(store.rows.get(FIXTURE.worktreeChild)?.transcriptOffset).toBe(offset);

    await appendFile(file, next.slice(40));
    const report = await ingester.sweep();
    expect(report.upserted).toBe(1);
    expect(report.bytes).toBe(Buffer.byteLength(next));
    const after = store.rows.get(FIXTURE.worktreeChild);
    expect(after?.transcriptOffset).toBe(offset + Buffer.byteLength(next));
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 22, finalMessage: 'Second answer.' });
    expect(after?.models['claude-opus-5-5']).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(store.patches.at(-1)).toMatchObject({ fromOffset: offset, cwd: null, repo: null });
    expect(after?.lastActiveAt?.toISOString()).toBe('2026-10-30T09:00:00.000Z');
    expect(after?.startedAt?.toISOString()).toBe('2026-10-30T08:00:00.000Z');
  });

  it('resumes from stored offsets after a restart without re-reading', async () => {
    await start().ready;
    const writes = store.patches.length;
    const second = start();
    const report = await second.ready;
    expect(report.upserted).toBe(0);
    expect(store.patches.length).toBe(writes);
  });

  it('re-reads a file that shrank and replaces its accumulated values', async () => {
    const ingester = start();
    await ingester.ready;
    const file = path.join(home, FIXTURE.worktreeFile);
    await truncate(file, 0);
    await writeFile(
      file,
      line({ type: 'user', sessionId: FIXTURE.worktreeChild, entrypoint: 'cli', cwd: '/home/u/.worktrees/mcp-notes/wall-editing', timestamp: '2026-10-31T00:00:00.000Z', message: { role: 'user', content: 'rewritten' } }),
    );
    await ingester.sweep();
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({
      prompts: [{ text: 'rewritten', at: '2026-10-31T00:00:00.000Z' }],
      inputTokens: 0,
      name: 'impl-wall-editing-p1',
    });
  });

  it('waits for the first message before writing a session with no entry point', async () => {
    const dir = path.join(home, 'projects', '-home-u-mcp-notes');
    const id = '5e55a001-0000-4000-8000-0000000000aa';
    const file = path.join(dir, `${id}.jsonl`);
    await writeFile(file, line({ type: 'custom-title', customTitle: 'early', sessionId: id }));
    const ingester = start();
    await ingester.ready;
    expect(store.rows.has(id)).toBe(false);
    await appendFile(file, line({ type: 'user', sessionId: id, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: '2026-11-02T03:00:00.000Z', message: { role: 'user', content: 'go' } }));
    await ingester.sweep();
    expect(store.rows.get(id)).toMatchObject({ customTitle: 'early', firstPrompt: 'go', repo: 'mcp-notes' });
  });

  it('updates a row a hook created first without clearing what the hook wrote', async () => {
    store.seedRow(FIXTURE.main, 'test-host', { tmux: 'note:@0.%7', name: 'from-hook' });
    store.seedRow(FIXTURE.worktreeChild, 'test-host', { tmux: 'note:@3.%9', name: 'from-hook' });
    await start().ready;
    // The transcript's agent-name is newer truth than the hook's name; tmux is never touched.
    expect(store.rows.get(FIXTURE.main)).toMatchObject({ name: 'session-graph-discussion', tmux: 'note:@0.%7', repo: 'mcp-notes' });
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({ name: 'impl-wall-editing-p1', tmux: 'note:@3.%9' });
  });

  it('adopts the stored offset after a compare-and-set miss and reads only the rest', async () => {
    const ingester = start();
    await ingester.ready;
    const file = path.join(home, FIXTURE.worktreeFile);
    const row = store.rows.get(FIXTURE.worktreeChild);
    if (!row) throw new Error('no row');
    // Another ingester (an earlier run that crashed after writing) already stored a later offset.
    const extra = line({ type: 'user', sessionId: FIXTURE.worktreeChild, timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'third' } });
    const extra2 = line({ type: 'user', sessionId: FIXTURE.worktreeChild, timestamp: '2026-10-30T11:00:00.000Z', message: { role: 'user', content: 'fourth' } });
    await appendFile(file, extra);
    store.rows.set(FIXTURE.worktreeChild, { ...row, transcriptOffset: row.transcriptOffset + Buffer.byteLength(extra) });
    await appendFile(file, extra2);
    await ingester.sweep();
    const prompts = store.rows.get(FIXTURE.worktreeChild)?.prompts.map((p) => p.text);
    expect(prompts).toEqual(['/implement -f docs/plans/WALL_EDITING_PLAN.md --phase 1', 'fourth']);
  });

  it('never writes a row that belongs to another host', async () => {
    const lines: string[] = [];
    store.seedRow(FIXTURE.main, 'other-laptop');
    await start({ log: (l) => lines.push(l) }).ready;
    expect(store.rows.get(FIXTURE.main)?.host).toBe('other-laptop');
    expect(store.rows.get(FIXTURE.main)?.firstPrompt).toBeNull();
    expect(lines.some((l) => l.includes('belongs to host other-laptop'))).toBe(true);
  });

  it('picks up an appended transcript through the watcher', async () => {
    const batches: IngestBatch[] = [];
    const ingester = start({ watch: true, debounceMs: 50 });
    ingester.addObserver({ onBatch: (b) => batches.push(b) });
    await ingester.ready;
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    await appendFile(
      mainPath(),
      line({ type: 'user', sessionId: FIXTURE.main, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: '2026-11-02T04:00:00.000Z', message: { role: 'user', content: 'one more thing' } }),
    );
    await until(() => batches.some((b) => b.sessionId === FIXTURE.main && b.fromOffset > 0));
    expect(store.rows.get(FIXTURE.main)?.prompts.map((p) => p.text)).toEqual(['sketch the project-session-graph feature', 'one more thing']);
  });

  it('picks up a new project dir and transcript through the sweep', async () => {
    const ingester = start();
    await ingester.ready;
    const id = '5e55a001-0000-4000-8000-0000000000bb';
    const dir = path.join(home, 'projects', '-home-u-seer');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), line({ type: 'user', sessionId: id, entrypoint: 'cli', cwd: '/home/u/seer', timestamp: '2026-11-02T05:00:00.000Z', message: { role: 'user', content: 'hi seer' } }));
    await ingester.sweep();
    expect(store.rows.get(id)).toMatchObject({ repo: 'seer', firstPrompt: 'hi seer' });
  });

  it('logs an observer failure and keeps ingesting', async () => {
    const lines: string[] = [];
    const ingester = start({ log: (l) => lines.push(l) });
    ingester.addObserver({
      onBatch: () => {
        throw new Error('boom');
      },
    });
    ingester.addObserver({
      onPassComplete: async () => {
        throw new Error('async boom');
      },
    });
    await ingester.ready;
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.filter((l) => l.includes('observer failed: boom'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('observer failed: async boom'))).toHaveLength(1);
    expect(store.rows.size).toBe(2);
  });

  it('closes within the grace period while a store write hangs', async () => {
    const hanging = new MemoryIngestStore();
    hanging.upsertFromTranscript = () => new Promise(() => undefined);
    store = hanging;
    const ingester = start({ closeGraceMs: 100 });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await ingester.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
```
**Impact:** Test-only.

### Step 15: Integration test
**File:** `tests/integration/sessions.ingest.int.test.ts` (new)
**Change:** Against phase 1's real `SessionsRepo` on the Docker Postgres: backfill rows with node ids, sdk sessions absent, tail + restart, and `startBackground` with sessions enabled ingesting a fixture home and stopping inside the grace period.
**Code:**
```ts
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBackground } from '../../src/background.js';
import { ChatService } from '../../src/chat/service.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { copyFixtureClaudeHome, FIXTURE } from '../helpers/claudeHome.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from './setup.js';

const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const IDS = [FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.sdkCli, FIXTURE.sdkTs];

let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store: repo,
    hostname: () => 'test-host',
    resolver: createRepoResolver({
      homeDir: FIXTURE.homeDir,
      worktreesDir: FIXTURE.worktreesDir,
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: () => undefined,
  });
  running.push(ingester);
  return ingester;
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`delete from cc_sessions where session_id in (${sql.join(IDS.map((id) => sql`${id}`), sql`, `)})`);
  home = await copyFixtureClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('session ingest into cc_sessions', () => {
  it('backfills one row per cli session with a node id and a resolved repo', async () => {
    const report = await start().ready;
    expect(report).toMatchObject({ upserted: 2, failed: 0 });

    const main = await repo.getBySessionId(FIXTURE.main);
    expect(main?.nodeId).toMatch(NODE_ID);
    expect(main).toMatchObject({
      host: 'test-host',
      repo: 'mcp-notes',
      cwd: '/home/u/mcp-notes',
      branch: 'main',
      name: 'session-graph-discussion',
      customTitle: 'session-graph-discussion',
      aiTitle: 'Project session graph',
      firstPrompt: 'sketch the project-session-graph feature',
      entrypoint: 'cli',
      version: '2.1.311',
      inputTokens: 5,
      outputTokens: 914,
      costUsd: 1.25,
      transcriptPath: path.join(home, FIXTURE.mainFile),
      finalMessage: 'Done: the plan is written.',
      parentSessionId: null,
    });
    expect(main?.startedAt?.toISOString()).toBe('2026-11-02T02:12:57.806Z');
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234']);
    expect(main?.planDocs).toHaveLength(2);

    const child = await repo.getBySessionId(FIXTURE.worktreeChild);
    expect(child).toMatchObject({ repo: 'mcp-notes', branch: 'feature/wall-editing', name: 'impl-wall-editing-p1' });
    expect(child?.nodeId).not.toBe(main?.nodeId);

    expect(await repo.getBySessionId(FIXTURE.sdkCli)).toBeNull();
    expect(await repo.getBySessionId(FIXTURE.sdkTs)).toBeNull();
  });

  it('tails appended bytes and resumes from stored offsets after a restart', async () => {
    const first = start();
    await first.ready;
    const before = await repo.getBySessionId(FIXTURE.worktreeChild);
    await appendFile(
      path.join(home, FIXTURE.worktreeFile),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-30T09:00:00.000Z',
        sessionId: FIXTURE.worktreeChild,
        message: { id: 'msg_Y', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }], usage: { input_tokens: 1, output_tokens: 2 } },
      })}\n`,
    );
    await first.sweep();
    const after = await repo.getBySessionId(FIXTURE.worktreeChild);
    expect(after?.inputTokens).toBe((before?.inputTokens ?? 0) + 1);
    expect(after?.finalMessage).toBe('Second answer.');
    expect(after?.nodeId).toBe(before?.nodeId);
    await first.close();

    const second = start();
    const report = await second.ready;
    expect(report.upserted).toBe(0);
    expect((await repo.getBySessionId(FIXTURE.worktreeChild))?.updatedAt.getTime()).toBe(after?.updatedAt.getTime());
  });
});

describe('startBackground with sessions enabled', () => {
  it('ingests the configured Claude home and stops within the grace period', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'notes-bg-sessions-'));
    const config: Config = {
      databaseUrl: testDatabaseUrl(),
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
      sessions: { claudeHome: home, worktreesDir: FIXTURE.worktreesDir, enabled: true },
    };
    const events = new NoteEvents();
    const deps: AppDeps = {
      config,
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder: null,
      imageEmbedder: null,
      chat: new ChatService({ db }),
    };
    const stop = await startBackground(deps);
    try {
      await until(async () => (await repo.getBySessionId(FIXTURE.main)) !== null);
      const row = await repo.getBySessionId(FIXTURE.main);
      expect(row?.host).toBe(os.hostname());
      expect(row?.repo).toBe('mcp-notes');
    } finally {
      const t0 = Date.now();
      await stop();
      expect(Date.now() - t0).toBeLessThan(6_000);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
```
**Impact:** Test-only.

## Verification

**Build:** `npm run typecheck` (server + web; this phase touches no web file) and `npm run build:server`.
**Tests:** `npm test` (unit: the four new `tests/unit/sessions/*.test.ts` files plus `config.test.ts`;
all use temp copies of `tests/fixtures/claude-home`, never the real `~/.claude`) and
`npm run test:int` (adds `sessions.ingest.int.test.ts`; the existing integration tests still pass
because every hand-built config has sessions off). One file: `npx vitest run tests/unit/sessions/ingest.test.ts`.
**Manual check:** after `npm run build && npm start` (or a daemon restart via `scripts/install.sh`),
the log shows `[notesd] ingesting Claude Code sessions from /home/miftah/.claude/projects as <host>`
then, a few seconds later, `[notesd] sessions: backfill N files, M rows written, ~840 MB, 0 failed, ...ms`.
Then in the DB: `select repo, count(*) from cc_sessions group by 1 order by 2 desc;` lists `seer`,
`agentic_golang`, `mcp-notes`, ...; `select node_id, name, ai_title from cc_sessions where session_id = 'd5c27d87-c38b-4fb8-83b5-1b1afaa5991f';`
returns a node id, `session-graph-discussion`, `Project session graph`. Send one prompt in any
Claude Code session and its row's `last_active_at` moves within ~1 s; restart the daemon and the
backfill line reports `0 rows written`. `NOTESD_SESSIONS=off` logs `session ingest off` and writes nothing.
**Exit criteria:** pointing the ingester at the fixture Claude home produces one row per `cli`
session (two) with repo resolved (`mcp-notes` for the deleted worktree too), the `sdk-cli` and
`sdk-ts` sessions have no row, appended bytes are picked up by sweep and by the watcher without
double counting, a restart resumes from stored offsets and reads nothing, and the daemon's stop
returns within the 5 s grace. typecheck, `npm test`, `npm run test:int` green.

## Handoffs

- **Phase 4 (heuristic links):** the extension point is in place as `IngestObserver` with exactly
  your requested shape (`onBatch({sessionId, host, records, ...})`, `onPassComplete({initial, ...})`,
  `observers?: IngestObserver[]` on `startSessionIngest`'s options, plus `addObserver`). Skip your
  Step 3. In `src/background.ts`, the ingest block is `else { const sessionsRepo = ...; const sessionsHost = hostname(); sessionIngest = startSessionIngest({...}) }`:
  `hostname` is already imported from `node:os` (do not import it again), `sessionsRepo` and
  `sessionsHost` are block-scoped consts inside that `else`, so create the link worker in the same
  block (before `startSessionIngest`) with `host: sessionsHost`, declare `let sessionLinks` next to
  `let sessionIngest` (outside the block), add `observers: [sessionLinks]` to the options object,
  and close it after `sessionIngest?.close()` resolves. The `if` tests `!deps.config.sessions.enabled`
  first (log line), so the "enabled" branch is the `else`.
- **Phase 5 (hooks):** a SessionStart hook that fires inside SDK sessions (the wall chat agent,
  `/n` helper runs) would create `cc_sessions` rows that ingest never fills (ingest skips
  `sdk-ts`/`sdk-cli`) and phase 1's listings include `entrypoint IS NULL` rows. Skip the post when
  the session's entrypoint is not `cli` (env `CLAUDE_CODE_ENTRYPOINT`, or the registry entry's
  `entrypoint`). Ingest itself fills any hook-created `cli` row (offset 0) on its next read and
  never clears the hook's `name`/`tmux` (the repo's null-keeps rule); the transcript's `agent-name`,
  when present, does replace the hook's name (it is the later rename).
- **Phase 6 (summaries):** `readLiveSessions(claudeHome)` exists in `src/sessions/registry.ts` with
  the signature your plan imports (returns `LiveSession[]`, a superset of `{ sessionId }`).
  `config.sessions` is required and `DEFAULT_SESSIONS_CONFIG.enabled` is `false`, so your
  `if (deps.config.sessions.enabled)` block stays off in every existing test. `last_active_at` is
  the max record timestamp seen.
- **Phase 7 (read API):** use `createLiveRegistry({ claudeHome: deps.config.sessions.claudeHome })`
  once per app (2 s cache) and `live = registry.has(sessionId) && row.host === os.hostname()`;
  `LiveSession` carries `status`, `tmux`, `name`, `pid`, `messagingSocketPath` for phase 9 too.
- **Phase 13:** add `swarmScript` to `SessionsConfig`, `DEFAULT_SESSIONS_CONFIG` and
  `parseSessions` (the helper exists under that name, as your plan expects).
- **Phase 14 (docs):** README env table gets `CLAUDE_HOME` (default `~/.claude`),
  `NOTES_WORKTREES_DIR` (default `~/.worktrees`), `NOTESD_SESSIONS` (`off` disables); the CLAUDE.md
  architecture bullet can say "ingest is `src/sessions/ingest.ts`: backfill, offset tail, watcher +
  60 s sweep; sdk sessions skipped; repo key rules in `repoResolve.ts`".
- **Not done here, deliberately:** parent links (4, 5), summaries/embeddings (6), HTTP/MCP (7+),
  writing `tmux` or live status to the DB (the registry is read on demand), and Claude Code's
  `relocated` records (sessions that moved into a Claude-native worktree keep their launch cwd and
  repo; 25 records on this machine).

## Rollback

Revert this phase's commit. Nothing it writes needs cleanup beyond data: `cc_sessions` rows it
created are derived and can stay (or `delete from cc_sessions where parent_link_source is null and summary is null;`
before phase 4/5/6 land). To stop ingest without a revert, set `NOTESD_SESSIONS=off` in
`.env.local` and restart the daemon.

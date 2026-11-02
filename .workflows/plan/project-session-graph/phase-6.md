# Phase 6: Summaries (Haiku), redaction, embeddings, session search

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R4 — idle Claude Code sessions get a redacted Haiku summary and an embedding, backfilled newest first, and are findable through the existing hybrid blend
**Depends on:** Phase 4 (and transitively 1, 3)
**Difficulty:** HARD
**Package:** `src/sessions`

---

## Goal

After this phase, a background worker inside the daemon finds sessions on this host that went
idle (no activity for 15 min and not in the live registry), builds a redacted summary input from
the columns phase 3 fills, asks Haiku for a short summary through the Agent SDK (no tools, one
turn, no persisted session), stores it, and embeds summary + titles + prompts into
`cc_session_embeddings`. The work is keyed by sha, so an unchanged session costs nothing.
`searchSessions()` ranks `cc_sessions` with the same `rankCandidates`/`BLEND` that note search
uses, and falls back to full text with a `fallback` sentence when no embedder is configured.
Nothing here is reachable over HTTP or MCP yet; phase 7 calls `searchSessions()`.

## Interface Contract

**Deletes:** none
**Renames:** none

**Creates:**
- `src/sessions/redact.ts`: `REDACTED`, `redactSecrets(text: string): string`
- `src/sessions/summarize.ts`:
  - `interface SummarizeRequest { sessionId: string; input: string; signal: AbortSignal }`
  - `interface Summarizer { readonly model: string; summarize(req: SummarizeRequest): Promise<string> }`
  - `interface SessionSummarySource` (the cc_sessions columns the summarizer reads)
  - `SUMMARY_MODEL = 'haiku'`, `SUMMARY_PROMPT_VERSION`, `SUMMARY_SYSTEM_PROMPT`, `SUMMARIES_SUBDIR = 'session-summaries'`, `DEFAULT_SUMMARY_TIMEOUT_MS`
  - `buildSummaryInput(s): string | null`, `summaryInputSha(input): string`, `cleanSummary(raw): string`
  - `buildEmbedText(s): string | null`, `embedTextSha(text): string`
  - `findClaudeBin(bin, pathEnv): string | null`
  - `interface AgentSummarizerOptions`, `createAgentSummarizer(opts): Summarizer | null`
- `src/sessions/summaryWorker.ts`: `SummaryCandidate`, `SummaryStore`, `dbSummaryStore(db, repo)`, `SummaryWorkerOptions`, `SummaryWorker`, `SummaryDrainReport`, `formatSummaryReport`, `startSummaryWorker(opts)`, `DEFAULT_SUMMARY_IDLE_MS`, `DEFAULT_SUMMARY_SWEEP_MS`, `DEFAULT_SUMMARY_MIN_INTERVAL_MS`, `DEFAULT_SUMMARY_BATCH`, `SUMMARY_SCAN_LIMIT`
- `src/sessions/search.ts`: `SessionSearchHit`, `SessionSearchPage`, `SessionSearchFilter`, `SessionSearchOptions`, `SessionSearchDeps`, `searchSessions(...)`, `SESSION_SEARCH_DEFAULT_LIMIT`, `SESSION_SEARCH_MAX_LIMIT`, `SESSIONS_SEMANTIC_OFF_FALLBACK`, `sessionEmbedFailedFallback(err)`, `SESSION_TSV_COLUMN`
- `src/background.ts`: `interface BackgroundOptions { sessionSummarizer?: Summarizer | null }` and an optional second parameter on `startBackground` (omitted or null = summaries off; embeddings still run)
- `src/daemon.ts`: the production daemon builds the Agent SDK summarizer (`createAgentSummarizer`) and passes it to `startBackground` (reconciled: tests never get a real summarizer by construction, no `process.env.VITEST` check)
- `tests/helpers/fakeSummarizer.ts`: `FakeSummarizer`, `createFakeSummarizer()`

**Published signatures (phase 7 calls these):**

```ts
// src/sessions/search.ts
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  filter?: SessionSearchFilter,
  opts?: SessionSearchOptions,
): Promise<SessionSearchPage>;

export interface SessionSearchDeps {
  db: Db;
  embedder: Embedder | null;
  /** Default: one cache shared by every caller in the process. */
  queryVectors?: QueryVectorCache;
  /** This machine; `available` is `host === thisHost`. Default os.hostname(). */
  host?: string;
}
export interface SessionSearchFilter {
  repo?: string; host?: string; from?: string; to?: string; limit?: number; cursor?: string;
}
export interface SessionSearchOptions { mode?: SearchMode; queryTimeoutMs?: number; now?: Date }
export interface SessionSearchPage {
  sessions: SessionSearchHit[]; next_cursor: string | null; mode: SearchMode; fallback?: string;
}

// src/sessions/summarize.ts
export interface SummarizeRequest { sessionId: string; input: string; signal: AbortSignal }
export interface Summarizer { readonly model: string; summarize(req: SummarizeRequest): Promise<string> }
export function createAgentSummarizer(opts: AgentSummarizerOptions): Summarizer | null;
```

**Signature changes:** `startBackground(deps: AppDeps)` -> `startBackground(deps: AppDeps, options: BackgroundOptions = {})` (phase 3 kept the one-parameter signature, so this phase creates `BackgroundOptions`). Every existing caller keeps compiling (the parameter is optional); `src/daemon.ts:117` passes the summarizer.

**Requires (from earlier phases):**
- Phase 1, migration `0007`: tables `cc_sessions` and `cc_session_embeddings` with the column names in the plan index's contract (snake_case, read here with raw SQL): `session_id, node_id, host, repo, cwd, branch, name, custom_title, ai_title, first_prompt, prompts jsonb, commits jsonb, files_edited jsonb, plan_docs jsonb, final_message, summary, summary_sha, summarized_at, started_at, last_active_at, parent_session_id, parent_link_source, created_at, updated_at`; `cc_session_embeddings(session_id, sha, model, embedding vector(1536) null, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)` — phase 1 refreshes `embedded_at` on every successful save, so staleness is judged on `embedded_at` (not `created_at`).
- Phase 1: the generated `tsvector` column on `cc_sessions` (over name/titles/prompts/summary, `simple` config) is named **`search_tsv`**. Search reads it through the single constant `SESSION_TSV_COLUMN`; if phase 1 picked another name, change that constant only.
- Phase 1, `SessionsRepo` (`src/sessions/repo.ts`), constructed as `new SessionsRepo(db, opts?)`, with (as published in phase 1's plan):
  - `setSummary(sessionId: string, input: { summary: string; sha: string; at?: Date }): Promise<boolean>`: sets `summary`, `summary_sha`, `summarized_at = at ?? now`, `updated_at`.
  - `saveEmbedding(sessionId: string, input: { sha: string; model: string; embedding: number[] }): Promise<boolean>`: insert or replace the vector row, clearing failure columns and setting `embedded_at = now()`.
  - `recordEmbeddingFailure(sessionId, { sha, model, error })` exists; this phase does not call it (the worker's own backoff covers failures).
  Both writes are called only from `dbSummaryStore` in `summaryWorker.ts`.
- Phase 1, `src/sessions/ids.ts`: `findNodeIdCandidates(text: string): string[]` returning canonical `XX-XX` ids.
- Phase 1: `truncateAll` in `tests/integration/setup.ts` truncates `cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings` too; this phase's integration tests call it in `beforeEach` (reconciled: no hand-rolled truncate lists).
- Phase 3: `config.sessions = { claudeHome, worktreesDir, enabled }` on `Config`, and test `Config` literals with `DEFAULT_SESSIONS_CONFIG` (`enabled: false`), so existing `startBackground` tests never start session work. Phase 3's `tests/integration/sessions.ingest.int.test.ts` calls `startBackground(deps)` with sessions enabled and `embedder: null`; with no summarizer passed it starts nothing new here.
- Phase 3, `src/sessions/registry.ts`: `readLiveSessions(claudeHome: string): Promise<Array<{ sessionId: string }>>` (live = pid alive on this host). Only the adapter lambda in `background.ts` touches it.
- Phase 3: ingest writes `host = os.hostname()` and keeps `last_active_at` as the last record's timestamp.
- Phase 4: its edits to `src/background.ts` are in place (the `sessionLinks` worker inside phase 3's `else` block, and the closer `await Promise.all([embeddings?.close(), imageEmbeddings?.close(), (async () => { await sessionIngest?.close(); await sessionLinks?.close(); })()])`). This phase does not edit `ingest.ts` at all (see Step 5 on why no ingest trigger is needed).

**Leaves alone (owned by others):** `src/http/*`, `src/mcp/*`, `web/*`, `src/chat/*` (only imported: `resolveExecutable`, `claudeEnv`, type `QueryFn`), `src/sessions/{ids,repo,types,transcript,repoResolve,registry,ingest,links}.ts` (phases 1, 3, 4), `src/config.ts` (phase 3 owns `config.sessions`), `src/search/blend.ts` and `src/search/queryVector.ts` (reused unchanged, weights not forked), `claude/hooks/*`.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/redact.ts` | create | secret redaction applied before summarizing, embedding and storing |
| `src/sessions/summarize.ts` | create | `Summarizer` seam, input/embed-text builders, Agent SDK Haiku summarizer |
| `src/sessions/summaryWorker.ts` | create | idle detection, sha-keyed summary + embedding, rate limit, backoff, 5 s close; `dbSummaryStore` |
| `src/sessions/search.ts` | create | hybrid session search over `search_tsv` + `cc_session_embeddings` + recency via `rankCandidates` |
| `src/background.ts` | modify (imports at top; new block after the session ingest block phases 3/4 added, before `return`; close list in the returned function) | start/stop the summary worker |
| `src/daemon.ts:117` | modify | build the Agent SDK summarizer and pass `{ sessionSummarizer }` to `startBackground` |
| `tests/helpers/fakeSummarizer.ts` | create | deterministic summarizer for unit + integration tests |
| `tests/unit/sessions/redact.test.ts` | create | each secret family redacted; ordinary text untouched |
| `tests/unit/sessions/summarize.test.ts` | create | builders, caps, sha stability, Agent SDK options, bin detection |
| `tests/unit/sessions/summaryWorker.test.ts` | create | worker against an in-memory store with fakes |
| `tests/integration/sessions.summaries.int.test.ts` | create | `dbSummaryStore` + worker against Postgres |
| `tests/integration/sessions.search.int.test.ts` | create | hybrid ranking, text fallback, filters, node-id exact hit |

## Implementation Steps

### Step 1: Redaction
**File:** `src/sessions/redact.ts` (new)
**Change:** One pure function. Applied to the summarizer input, the summarizer output, and the embed text, so no secret leaves the machine (Anthropic, OpenRouter) or lands in `summary`. It over-redacts rather than under-redacts. Hex-only strings (commit shas, sha256) are left alone on purpose: they are useful and not secrets.
**Code:**
```ts
/**
 * Secret redaction for everything session summaries send off the machine (the Haiku summarizer,
 * the OpenRouter embedder) or store (`cc_sessions.summary`). Pure; no I/O.
 *
 * Over-redacting is fine: the output is only used for a summary and a search vector. Hex-only
 * strings (commit shas, sha256 digests) are kept on purpose, they are useful and not secrets.
 */

export const REDACTED = '[redacted]';

/** PEM private keys, whole block. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** scheme://user:password@host -> scheme://[redacted]@host (postgres, mysql, redis, amqp, mongodb, https...). */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/'"`]+:[^\s@/'"`]+@/gi;

/** Authorization / Proxy-Authorization header values, any scheme. */
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi;

/** Bare bearer tokens anywhere ("-H 'Bearer abc'"). */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Well-known token shapes. Order matters only for readability; each is replaced whole. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{10,}/g, // OpenRouter
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/**
 * KEY=value / KEY: value where the key names a secret: .env lines, shell exports, YAML, JSON,
 * query strings. Group 1 keeps the key and separator, the value is replaced.
 */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?token|session[_-]?key|dsn|database[_-]?url|connection[_-]?string|signing[_-]?key)[A-Za-z0-9_.-]*`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`((?:^|[\s{,;&?(])(?:export\s+)?["']?${SECRET_KEY}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&)}]+)`,
  'gim',
);

/** UPPER_CASE=value lines from .env files whose value looks like a credential (long, mixed). */
const ENV_LINE = /^((?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*)(["']?)([^\s"'#]{16,})\2/gm;

/** Long opaque tokens: >= 32 chars of [A-Za-z0-9_+=-] with upper, lower and digit, not pure hex. */
const OPAQUE = /(?<![A-Za-z0-9_+=/-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=/-])/g;

function looksOpaque(s: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(s)) return false;
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

/** `text` with every recognised secret replaced by `[redacted]`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, `${REDACTED} private key`);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(AUTH_HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SECRET_ASSIGNMENT, (_m, head: string, value: string) =>
    value === REDACTED || value === `"${REDACTED}"` || value === `'${REDACTED}'` ? `${head}${value}` : `${head}${REDACTED}`,
  );
  out = out.replace(ENV_LINE, (m, head: string, quote: string, value: string) =>
    looksOpaque(value) || /[a-z]/.test(value) && /\d/.test(value) && value.length >= 24 ? `${head}${quote}${REDACTED}${quote}` : m,
  );
  out = out.replace(OPAQUE, (m) => (looksOpaque(m) ? REDACTED : m));
  return out;
}
```
**Impact:** none outside this phase; pure module.

### Step 2: Summarizer seam, input builders, Agent SDK implementation
**File:** `src/sessions/summarize.ts` (new)
**Change:** Mirrors `src/chat/agent.ts`'s SDK use (`pathToClaudeCodeExecutable`, `claudeEnv` that strips keys and parent-session markers, `settingSources: []`, `strictMcpConfig`, `persistSession: false`) but with `model: 'haiku'`, `tools: []`, `allowedTools: []`, `mcpServers: {}`, `maxTurns: 1`, thinking off. cwd is `<dataDir>/session-summaries`, created on first use. `persistSession: false` means the run writes no transcript, so ingest never sees it (and its entrypoint would be `sdk-ts`, which phase 3 skips anyway).
The jsonb shapes of `prompts`, `commits`, `files_edited`, `plan_docs` are phase 3's; `asLines` accepts strings or objects (picks `sha`/`subject`/`message`/`path`/`text`/`prompt` fields), so this module does not depend on the exact shape.
**Code:**
```ts
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv, resolveExecutable } from '../chat/env.js';
import { embedInput } from '../embeddings/state.js';
import { redactSecrets } from './redact.js';

/** The Agent SDK model alias for summaries. */
export const SUMMARY_MODEL = 'haiku';
/** Bump when the system prompt or input layout changes: every session is then re-summarized once. */
export const SUMMARY_PROMPT_VERSION = 'v1';
/** `<dataDir>/session-summaries`: the fixed cwd of every summarizer run (nothing is persisted there). */
export const SUMMARIES_SUBDIR = 'session-summaries';
/** Wall clock per summary call. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 90_000;

/** Caps on the summarizer input; the whole input never exceeds MAX_INPUT_CHARS. */
const MAX_PROMPTS = 40;
const HEAD_PROMPTS = 10;
const MAX_PROMPT_CHARS = 1_500;
const MAX_LIST_ITEMS = 60;
const MAX_ITEM_CHARS = 300;
const MAX_FINAL_CHARS = 4_000;
const MAX_INPUT_CHARS = 24_000;
/** Stored summary cap. */
const MAX_SUMMARY_CHARS = 1_500;
/** Per-prompt cap inside the embed text (embedInput then clamps the whole to 8000). */
const MAX_EMBED_PROMPT_CHARS = 500;

export const SUMMARY_SYSTEM_PROMPT = [
  'You summarize one Claude Code session for its owner\'s personal index of past sessions.',
  'The user message lists the session\'s repository, titles, the human prompts in order, the commits it made, the files it edited, the plan documents it touched and the final assistant message.',
  'Write 2 to 4 plain sentences, no heading, no bullet list, no preamble such as "This session".',
  'Say what the user wanted, what was actually done (name features, files, commands, plan or task ids), and where it ended: finished, abandoned, or what was left open.',
  'Never repeat secrets, keys, tokens or passwords; the input already shows them as [redacted].',
  'Answer with the summary only.',
].join(' ');

/** The cc_sessions columns a summary and an embedding are built from (phase 3 fills them). */
export interface SessionSummarySource {
  sessionId: string;
  nodeId: string;
  repo: string | null;
  branch: string | null;
  name: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  /** jsonb: human prompts, oldest first (strings, or objects with a text/prompt field). */
  prompts: unknown;
  /** jsonb: commits made (strings, or objects with sha/subject/message). */
  commits: unknown;
  /** jsonb: paths edited. */
  filesEdited: unknown;
  /** jsonb: plan docs touched. */
  planDocs: unknown;
  finalMessage: string | null;
  summary: string | null;
  summarySha: string | null;
}

export interface SummarizeRequest {
  sessionId: string;
  /** Output of buildSummaryInput: already redacted and capped. */
  input: string;
  /** Aborts the call (daemon shutdown). */
  signal: AbortSignal;
}

/**
 * The one seam between session summaries and a model. Production: createAgentSummarizer
 * (Haiku through the Agent SDK). Tests: tests/helpers/fakeSummarizer.ts.
 * Rejects on any failure; the worker records it and retries later.
 */
export interface Summarizer {
  /** Model id or alias, for logs. */
  readonly model: string;
  /** The raw model answer; the worker cleans and redacts it with cleanSummary. */
  summarize(req: SummarizeRequest): Promise<string>;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max);
}

const ITEM_FIELDS = ['sha', 'hash', 'subject', 'message', 'path', 'file', 'text', 'prompt'] as const;

/** A jsonb list (or single value) as display lines; tolerant of strings and objects. */
export function asLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push(item.trim());
      continue;
    }
    if (item !== null && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of ITEM_FIELDS) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim() !== '') parts.push(key === 'sha' || key === 'hash' ? v.trim().slice(0, 10) : v.trim());
      }
      out.push(parts.length > 0 ? parts.join(' ') : JSON.stringify(item));
      continue;
    }
    if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item));
  }
  return out;
}

function pickPrompts(prompts: string[]): { shown: string[]; skipped: number } {
  if (prompts.length <= MAX_PROMPTS) return { shown: prompts, skipped: 0 };
  const tail = MAX_PROMPTS - HEAD_PROMPTS;
  return {
    shown: [...prompts.slice(0, HEAD_PROMPTS), ...prompts.slice(prompts.length - tail)],
    skipped: prompts.length - MAX_PROMPTS,
  };
}

function titleOf(s: SessionSummarySource): string | null {
  return s.customTitle ?? s.aiTitle ?? s.name ?? null;
}

/**
 * The summarizer's user message: repo, titles, prompts, commits, files, plan docs, final
 * message; capped and redacted. Null when the session has nothing a summary could say (no
 * prompt and no final message), so the worker skips it.
 */
export function buildSummaryInput(s: SessionSummarySource): string | null {
  let prompts = asLines(s.prompts);
  if (prompts.length === 0 && s.firstPrompt !== null && s.firstPrompt.trim() !== '') prompts = [s.firstPrompt.trim()];
  const final = s.finalMessage?.trim() ?? '';
  if (prompts.length === 0 && final === '') return null;

  const lines: string[] = [];
  lines.push(`Node: ${s.nodeId}`);
  if (s.repo !== null) lines.push(`Repository: ${s.repo}`);
  if (s.branch !== null) lines.push(`Branch: ${s.branch}`);
  if (s.name !== null) lines.push(`Session name: ${s.name}`);
  if (s.customTitle !== null) lines.push(`Title: ${s.customTitle}`);
  if (s.aiTitle !== null && s.aiTitle !== s.customTitle) lines.push(`Auto title: ${s.aiTitle}`);

  const { shown, skipped } = pickPrompts(prompts);
  if (shown.length > 0) {
    lines.push('', 'Human prompts, in order:');
    shown.forEach((p, i) => {
      if (skipped > 0 && i === HEAD_PROMPTS) lines.push(`(${skipped} more prompts omitted)`);
      lines.push(`${i + 1}. ${clip(p, MAX_PROMPT_CHARS)}`);
    });
  }
  const sections: Array<[string, string[]]> = [
    ['Commits made:', asLines(s.commits)],
    ['Files edited:', asLines(s.filesEdited)],
    ['Plan documents touched:', asLines(s.planDocs)],
  ];
  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    lines.push('', heading);
    for (const item of items.slice(0, MAX_LIST_ITEMS)) lines.push(`- ${oneLine(item, MAX_ITEM_CHARS)}`);
    if (items.length > MAX_LIST_ITEMS) lines.push(`- (${items.length - MAX_LIST_ITEMS} more)`);
  }
  if (final !== '') lines.push('', 'Final assistant message:', clip(final, MAX_FINAL_CHARS));

  return clip(redactSecrets(lines.join('\n')), MAX_INPUT_CHARS);
}

/** Hex sha256 of the prompt version and the input: equal sha = nothing new to summarize. */
export function summaryInputSha(input: string): string {
  return createHash('sha256').update(`${SUMMARY_PROMPT_VERSION}\n${input}`, 'utf8').digest('hex');
}

/** The stored summary: trimmed, no "Summary:" lead-in, blank runs collapsed, capped, redacted. */
export function cleanSummary(raw: string): string {
  const t = raw
    .trim()
    .replace(/^\**\s*summary\s*\**\s*:\s*\**\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return redactSecrets(clip(t, MAX_SUMMARY_CHARS));
}

/**
 * What gets embedded for a session: title/name/repo, the summary, then the prompts; redacted,
 * then trimmed and clamped by embedInput. Null when nothing is left.
 */
export function buildEmbedText(s: SessionSummarySource): string | null {
  const head = [titleOf(s), s.name !== titleOf(s) ? s.name : null, s.repo].filter(
    (v): v is string => v !== null && v.trim() !== '',
  );
  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join(' | '));
  if (s.summary !== null && s.summary.trim() !== '') parts.push(s.summary.trim());
  let prompts = asLines(s.prompts);
  if (prompts.length === 0 && s.firstPrompt !== null) prompts = [s.firstPrompt];
  for (const p of prompts) parts.push(oneLine(p, MAX_EMBED_PROMPT_CHARS));
  return embedInput(redactSecrets(parts.join('\n')));
}

/** Hex sha256 of the embed text; stored in cc_session_embeddings.sha. */
export function embedTextSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Absolute path of an executable claude binary, or null. A bare name is looked up on PATH
 * (chat's resolveExecutable); a path must exist and be executable.
 */
export function findClaudeBin(bin: string, pathEnv: string | undefined): string | null {
  const resolved = resolveExecutable(bin, pathEnv);
  if (!resolved.includes('/')) return null;
  try {
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export interface AgentSummarizerOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/session-summaries`; created on first use. */
  cwd: string;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default DEFAULT_SUMMARY_TIMEOUT_MS. */
  timeoutMs?: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Haiku through the Claude Agent SDK, on the owner's login like the chat brain: no tools, no
 * MCP servers, no settings, one turn, no persisted session. Null when the claude binary cannot
 * be found; the caller logs that once and runs without summaries.
 */
export function createAgentSummarizer(opts: AgentSummarizerOptions): Summarizer | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
  let cwdReady: Promise<unknown> | null = null;

  function optionsFor(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      model: SUMMARY_MODEL,
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      persistSession: false,
    };
  }

  return {
    model: SUMMARY_MODEL,
    async summarize(req: SummarizeRequest): Promise<string> {
      if (req.signal.aborted) throw new Error('summary aborted');
      cwdReady ??= mkdir(opts.cwd, { recursive: true });
      await cwdReady;
      const controller = new AbortController();
      const relay = (): void => controller.abort(req.signal.reason);
      req.signal.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, timeoutMs);
      timer.unref();

      let result: string | null = null;
      let failure: string | null = null;
      try {
        for await (const message of query({ prompt: req.input, options: optionsFor(controller) })) {
          if (message.type !== 'result') continue;
          if (message.subtype === 'success' && !message.is_error) result = message.result;
          else if (message.subtype === 'success') failure = message.result.trim() || 'the summarizer failed without saying why';
          else failure = message.errors.join('; ').trim() || `the summarizer failed (${message.subtype})`;
        }
      } catch (err) {
        // A CLI that exits non-zero after its result still produced that result: trust it.
        if (result === null && failure === null) failure = errorText(err);
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', relay);
      }
      if (result !== null) return result;
      if (req.signal.aborted) throw new Error('summary aborted');
      if (timedOut) throw new Error(`the summarizer gave no answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new Error(failure ?? 'the summarizer ended without a result');
    },
  };
}
```
**Impact:** none outside this phase. Uses `strictMcpConfig`/`thinking`/`tools` exactly as typed in `@anthropic-ai/claude-agent-sdk` 0.3.311 (`sdk.d.ts:1686`, `:1952`).

### Step 3: Summary worker and its database store
**File:** `src/sessions/summaryWorker.ts` (new)
**Change:** A drain loop shaped like `src/embeddings/worker.ts` (sweep interval, single in-flight drain, `idle()` for tests, `close()` bounded by a 5 s grace that aborts the in-flight summarizer/embedder call). Rules:
- Only sessions with `host = this host` (the owning daemon summarizes; two laptops never pay twice).
- Idle = `last_active_at < now - 15 min` AND not in the live set.
- Newest first (`order by last_active_at desc`); summarizer calls spaced by `minIntervalMs` (5 s), embedder calls by 1 s.
- Summary skipped when `summaryInputSha(input) === summary_sha` (restart-safe). When the input is unchanged but `summarized_at < last_active_at`, the existing summary is re-saved to bump `summarized_at`, so the row stops being a candidate.
- Embedding skipped when `embedTextSha(text)` equals the stored `sha` for the embedder's model.
- In-process `seen` map (session id -> `last_active_at` processed) keeps a sweep from re-loading rows it already handled; per-session exponential backoff (`retryDelayMs`) on failure; after 3 consecutive summarizer failures (usage limit, auth) summaries pause globally with the same backoff, and a paused drain does nothing until the pause ends.
- Every error is caught and logged; nothing propagates to ingest or the daemon.
- All writes go through `SessionsRepo` (invariant 3) inside `dbSummaryStore`; reads are raw SQL against the contract's column names.
**Code:**
```ts
import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { RateLimiter, errorMessage, realClock, type Clock } from '../embeddings/backfill.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { embeddingErrorText, type Embedder } from '../embeddings/embedder.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import type { SessionsRepo } from './repo.js';
import {
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  embedTextSha,
  summaryInputSha,
  type SessionSummarySource,
  type Summarizer,
} from './summarize.js';

/** A session must be quiet this long (and not live) before it is summarized. */
export const DEFAULT_SUMMARY_IDLE_MS = 15 * 60_000;
/** Sweep period: new idle sessions are picked up within this. */
export const DEFAULT_SUMMARY_SWEEP_MS = 60_000;
/** Minimum spacing between two summarizer calls (backlog rate limit). */
export const DEFAULT_SUMMARY_MIN_INTERVAL_MS = 5_000;
/** Minimum spacing between two embedder calls. */
export const DEFAULT_SUMMARY_EMBED_INTERVAL_MS = 1_000;
/** Full rows loaded per round trip. */
export const DEFAULT_SUMMARY_BATCH = 20;
/** Most candidates one sweep looks at. */
export const SUMMARY_SCAN_LIMIT = 5_000;
/** close() waits this long for the in-flight call, like the embedding workers. */
export const DEFAULT_SUMMARY_CLOSE_GRACE_MS = 5_000;
/** Consecutive summarizer failures before summaries pause globally (usage limit, logged out). */
const PAUSE_AFTER_FAILURES = 3;
const LOG_ERROR_CHARS = 200;

/** One idle session as the light candidate query returns it. */
export interface SummaryCandidate {
  sessionId: string;
  lastActiveAt: Date;
  summarySha: string | null;
  summarizedAt: Date | null;
  /** Stored embedding's sha / model; null when there is none. */
  embeddingSha: string | null;
  embeddingModel: string | null;
}

/** The reads and writes the worker needs. `dbSummaryStore` is the real one; tests use memory. */
export interface SummaryStore {
  /**
   * Idle sessions of `host` (last_active_at < idleBefore) that may need work, newest first.
   * May return rows that turn out up to date; the worker re-checks by sha.
   */
  listIdle(opts: {
    host: string;
    idleBefore: Date;
    limit: number;
    /** Include rows whose summary may be stale. */
    wantSummary: boolean;
    /** Include rows whose embedding for this model may be stale; null = no embedder. */
    embeddingModel: string | null;
  }): Promise<SummaryCandidate[]>;
  load(sessionIds: readonly string[]): Promise<SessionSummarySource[]>;
  saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void>;
  saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void>;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

type CandidateDbRow = {
  session_id: string;
  last_active_at: Date | string;
  summary_sha: string | null;
  summarized_at: Date | string | null;
  embedding_sha: string | null;
  embedding_model: string | null;
};

type SourceDbRow = {
  session_id: string;
  node_id: string;
  repo: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  prompts: unknown;
  commits: unknown;
  files_edited: unknown;
  plan_docs: unknown;
  final_message: string | null;
  summary: string | null;
  summary_sha: string | null;
};

/** Reads by raw SQL on the phase-1 column names; writes only through SessionsRepo (invariant 3). */
export function dbSummaryStore(db: Db, repo: SessionsRepo): SummaryStore {
  return {
    async listIdle(o) {
      const needSummary = o.wantSummary
        ? sql`(s.summarized_at is null or s.summarized_at < s.last_active_at)`
        : sql`false`;
      const needEmbedding =
        o.embeddingModel !== null
          ? sql`(e.session_id is null or e.embedding is null or e.embedded_at is null or e.model <> ${o.embeddingModel} or e.embedded_at < s.last_active_at or (s.summarized_at is not null and e.embedded_at < s.summarized_at))`
          : sql`false`;
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id, s.last_active_at, s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.last_active_at is not null
          and s.last_active_at < ${o.idleBefore.toISOString()}::timestamptz
          and (${needSummary} or ${needEmbedding})
        order by s.last_active_at desc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      const out: SummaryCandidate[] = [];
      for (const r of res.rows) {
        const lastActiveAt = toDate(r.last_active_at);
        if (lastActiveAt === null) continue;
        out.push({
          sessionId: r.session_id,
          lastActiveAt,
          summarySha: r.summary_sha,
          summarizedAt: toDate(r.summarized_at),
          embeddingSha: r.embedding_sha,
          embeddingModel: r.embedding_model,
        });
      }
      return out;
    },
    async load(sessionIds) {
      if (sessionIds.length === 0) return [];
      const res = await db.execute<SourceDbRow>(sql`
        select session_id, node_id, repo, branch, name, custom_title, ai_title, first_prompt,
               prompts, commits, files_edited, plan_docs, final_message, summary, summary_sha
        from cc_sessions
        where session_id in (${idList(sessionIds)})
      `);
      return res.rows.map((r) => ({
        sessionId: r.session_id,
        nodeId: r.node_id,
        repo: r.repo,
        branch: r.branch,
        name: r.name,
        customTitle: r.custom_title,
        aiTitle: r.ai_title,
        firstPrompt: r.first_prompt,
        prompts: r.prompts,
        commits: r.commits,
        filesEdited: r.files_edited,
        planDocs: r.plan_docs,
        finalMessage: r.final_message,
        summary: r.summary,
        summarySha: r.summary_sha,
      }));
    },
    async saveSummary(v) {
      await repo.setSummary(v.sessionId, { summary: v.summary, sha: v.summarySha });
    },
    async saveEmbedding(v) {
      await repo.saveEmbedding(v.sessionId, { sha: v.sha, model: v.model, embedding: v.embedding });
    },
  };
}

export interface SummaryWorkerOptions {
  store: SummaryStore;
  /** Null: summaries off (no claude binary); embeddings still run when an embedder is set. */
  summarizer: Summarizer | null;
  /** Null: embeddings off (no OPENROUTER_API_KEY). */
  embedder: Embedder | null;
  /** This machine. Default os.hostname(). */
  host?: string;
  /** Session ids live in the registry right now. Default: none. A throw counts as none. */
  liveSessionIds?: () => Promise<ReadonlySet<string>>;
  idleMs?: number;
  sweepMs?: number;
  minIntervalMs?: number;
  embedMinIntervalMs?: number;
  batchSize?: number;
  closeGraceMs?: number;
  clock?: Clock;
  /** One line per drain that did work, and per failed drain. Default console.log. */
  log?: (line: string) => void;
}

export interface SummaryWorker {
  /** Schedule a drain now (no-op while one runs: it re-runs once after). No-op after close. */
  kick(): void;
  /** Resolves once no drain is running. For tests. */
  idle(): Promise<void>;
  /** Stops sweeping, aborts the in-flight call, waits at most closeGraceMs. */
  close(): Promise<void>;
}

export interface SummaryDrainReport {
  considered: number;
  summarized: number;
  embedded: number;
  failed: number;
  failures: Array<{ sessionId: string; error: string }>;
  ms: number;
}

/** e.g. `[notesd] session summaries: 3 summarized, 5 embedded, 1 failed (abc...: timeout), 2310ms` */
export function formatSummaryReport(r: SummaryDrainReport): string {
  const parts = [`[notesd] session summaries: ${r.summarized} summarized`, `${r.embedded} embedded`];
  if (r.failed > 0) {
    const first = r.failures[0];
    const detail = first === undefined ? '' : ` (${first.sessionId}: ${first.error.slice(0, LOG_ERROR_CHARS)})`;
    parts.push(`${r.failed} failed${detail}`);
  }
  parts.push(`${r.ms}ms`);
  return parts.join(', ');
}

/**
 * Summarizes and embeds idle sessions of this host in the background. Starts a drain at once
 * (the backlog, newest first), then one per sweep. Never throws into its caller.
 */
export function startSummaryWorker(opts: SummaryWorkerOptions): SummaryWorker {
  const { store, summarizer, embedder } = opts;
  const host = opts.host ?? hostname();
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? realClock;
  const idleMs = opts.idleMs ?? DEFAULT_SUMMARY_IDLE_MS;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_SUMMARY_BATCH);
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_SUMMARY_CLOSE_GRACE_MS;
  const readLive = opts.liveSessionIds ?? (async () => new Set<string>());
  const summaryLimiter = new RateLimiter(opts.minIntervalMs ?? DEFAULT_SUMMARY_MIN_INTERVAL_MS, clock);
  const embedLimiter = new RateLimiter(opts.embedMinIntervalMs ?? DEFAULT_SUMMARY_EMBED_INTERVAL_MS, clock);
  const abort = new AbortController();

  /** session id -> last_active_at (ms) already handled in this process. */
  const seen = new Map<string, number>();
  const attempts = new Map<string, number>();
  const retryAt = new Map<string, number>();
  let consecutiveSummaryFailures = 0;
  let pausedUntil = 0;
  let closed = false;
  let running: Promise<void> | null = null;
  let again = false;

  const summariesPaused = (): boolean => summarizer !== null && clock.now() < pausedUntil;

  async function liveSet(): Promise<ReadonlySet<string>> {
    try {
      return await readLive();
    } catch (err) {
      log(`[notesd] session summaries: live registry unreadable (${errorMessage(err).slice(0, LOG_ERROR_CHARS)}); treating no session as live`);
      return new Set<string>();
    }
  }

  function fail(report: SummaryDrainReport, sessionId: string, error: string): void {
    report.failed += 1;
    report.failures.push({ sessionId, error: clampError(error) });
    const n = (attempts.get(sessionId) ?? 0) + 1;
    attempts.set(sessionId, n);
    retryAt.set(sessionId, clock.now() + retryDelayMs(n));
  }

  async function processOne(row: SessionSummarySource, c: SummaryCandidate, report: SummaryDrainReport): Promise<void> {
    const id = row.sessionId;
    const signal = abort.signal;
    let summary = row.summary;
    let failure: string | null = null;
    const summarize = summarizer !== null && !summariesPaused();
    const deferred = summarizer !== null && !summarize;

    if (summarize && summarizer !== null) {
      const input = buildSummaryInput(row);
      if (input !== null) {
        const sha = summaryInputSha(input);
        if (sha === row.summarySha && row.summary !== null) {
          if (c.summarizedAt === null || c.summarizedAt.getTime() < c.lastActiveAt.getTime()) {
            await store.saveSummary({ sessionId: id, summary: row.summary, summarySha: sha });
          }
        } else {
          if (!(await summaryLimiter.acquire(signal))) return;
          try {
            const clean = cleanSummary(await summarizer.summarize({ sessionId: id, input, signal }));
            if (clean === '') throw new Error('the summarizer returned an empty summary');
            await store.saveSummary({ sessionId: id, summary: clean, summarySha: sha });
            summary = clean;
            report.summarized += 1;
            consecutiveSummaryFailures = 0;
          } catch (err) {
            if (signal.aborted) return;
            failure = errorMessage(err);
            consecutiveSummaryFailures += 1;
            if (consecutiveSummaryFailures >= PAUSE_AFTER_FAILURES) {
              const wait = retryDelayMs(consecutiveSummaryFailures - PAUSE_AFTER_FAILURES + 1);
              pausedUntil = clock.now() + wait;
              log(`[notesd] session summaries: ${consecutiveSummaryFailures} failures in a row, pausing summaries for ${Math.round(wait / 1000)} s`);
            }
          }
        }
      }
    }

    if (embedder !== null) {
      const text = buildEmbedText({ ...row, summary });
      if (text !== null) {
        const sha = embedTextSha(text);
        if (sha !== c.embeddingSha || c.embeddingModel !== embedder.model) {
          if (!(await embedLimiter.acquire(signal))) return;
          try {
            const vectors = await embedder.embed([text]);
            const vector = vectors[0];
            if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new Error(`the embedder returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
            }
            await store.saveEmbedding({ sessionId: id, sha, model: embedder.model, embedding: vector });
            report.embedded += 1;
          } catch (err) {
            if (signal.aborted) return;
            failure ??= embeddingErrorText(err);
          }
        }
      }
    }

    if (failure !== null) {
      fail(report, id, failure);
      return;
    }
    // A row whose summary step was skipped by the pause is picked up again after it.
    if (deferred) return;
    seen.set(id, c.lastActiveAt.getTime());
    attempts.delete(id);
    retryAt.delete(id);
  }

  async function drainOnce(): Promise<void> {
    const started = clock.now();
    if (summariesPaused()) return;
    const report: SummaryDrainReport = { considered: 0, summarized: 0, embedded: 0, failed: 0, failures: [], ms: 0 };
    try {
      const live = await liveSet();
      const candidates = await store.listIdle({
        host,
        idleBefore: new Date(started - idleMs),
        limit: SUMMARY_SCAN_LIMIT,
        wantSummary: summarizer !== null,
        embeddingModel: embedder?.model ?? null,
      });
      const now = clock.now();
      const due = candidates.filter(
        (c) =>
          !live.has(c.sessionId) &&
          seen.get(c.sessionId) !== c.lastActiveAt.getTime() &&
          (retryAt.get(c.sessionId) ?? 0) <= now,
      );
      report.considered = due.length;
      for (let i = 0; i < due.length && !abort.signal.aborted; i += batchSize) {
        if (summariesPaused()) break;
        const batch = due.slice(i, i + batchSize);
        const byId = new Map(batch.map((c) => [c.sessionId, c]));
        const rows = await store.load([...byId.keys()]);
        for (const row of rows) {
          if (abort.signal.aborted) break;
          const c = byId.get(row.sessionId);
          if (c === undefined) continue;
          try {
            await processOne(row, c, report);
          } catch (err) {
            if (abort.signal.aborted) break;
            fail(report, row.sessionId, errorMessage(err));
          }
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) log(`[notesd] session summaries: drain failed: ${errorMessage(err).slice(0, LOG_ERROR_CHARS)}`);
    }
    report.ms = clock.now() - started;
    if (report.summarized + report.embedded + report.failed > 0) log(formatSummaryReport(report));
  }

  const drain = (): void => {
    if (closed) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !closed);
    })().finally(() => {
      running = null;
    });
  };

  const sweep = setInterval(drain, opts.sweepMs ?? DEFAULT_SUMMARY_SWEEP_MS);
  sweep.unref();
  drain();

  return {
    kick: drain,
    async idle(): Promise<void> {
      for (;;) {
        const current = running;
        if (current === null) return;
        await current;
      }
    },
    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        clearInterval(sweep);
        abort.abort();
      }
      const current = running;
      if (current === null) return;
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        current,
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
**Impact:** none outside this phase. Reuses `RateLimiter`, `realClock`, `errorMessage` (`src/embeddings/backfill.ts:40,34,132`), `retryDelayMs`/`clampError` (`src/embeddings/state.ts:64,76`), `embeddingErrorText` (`src/embeddings/embedder.ts`).

### Step 4: Hybrid session search
**File:** `src/sessions/search.ts` (new)
**Change:** Same structure as `NotesService.search` (`src/notes/service.ts:267`) and `searchCandidates` (`src/notes/repo.ts:224`): text candidates ∪ nearest vectors ∪ node ids named in the query, each under the same filters, ranked by `rankCandidates` with `BLEND` (not forked). Mapping of signals:
- `textRank`: `ts_rank(search_tsv, websearch_to_tsquery('simple', q))`.
- `similarity`: `1 - (embedding <=> qvec)` for the embedder's model.
- `tagMatch`: the session's repo key treated as its one tag (`tagMatch([repo], terms)`), so "mcp-notes wall editing" lifts mcp-notes sessions the way a tag lifts notes.
- `updatedAt` (recency): `last_active_at`, else `started_at`.
- `exactId`: the query names the session's node id (`findNodeIdCandidates(query.toUpperCase())`: the shared candidate rule is upper-case-only for prompts, but a search query is deliberate, so it is upper-cased first).
No HNSW index exists on `cc_session_embeddings` (not in the contract, and ~1000 rows need none), so the vector query is a plain ordered scan, no `iterative_scan` transaction.
Filters: `repo`, `host` exact; `from`/`to` (YYYY-MM-DD local day or ISO, via `parseDateBound`) select sessions whose active span overlaps the range: `coalesce(last_active_at, started_at) >= from` and `coalesce(started_at, last_active_at) < to`.
Paging: offset cursor (`encodeCursor`/`decodeCursor` from `src/notes/repo.ts`), default 20, max 200. Errors are `NoteError('invalid_input')`, which phase 7's routes and tools already map.
**Code:**
```ts
import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from '../notes/dates.js';
import { decodeCursor, encodeCursor } from '../notes/repo.js';
import { NoteError, type SearchMode } from '../notes/types.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import { QUERY_EMBED_TIMEOUT_MS, QueryVectorCache, embedQuery } from '../search/queryVector.js';
import { findNodeIdCandidates } from './ids.js';

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 200;
/** Phase 1's generated tsvector column on cc_sessions (name, titles, prompts, summary; 'simple'). */
export const SESSION_TSV_COLUMN = 'search_tsv';
/** first_prompt is cut to this many characters in hits. */
const HIT_PROMPT_CHARS = 500;

export const SESSIONS_SEMANTIC_OFF_FALLBACK =
  'Meaning search is off on this server (OPENROUTER_API_KEY is not set), so these are full-text results only: sessions that share words with the query.';

export function sessionEmbedFailedFallback(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `The query could not be embedded (${reason}), so these are full-text results only: sessions that share words with the query.`;
}

export interface SessionSearchDeps {
  db: Db;
  embedder: Embedder | null;
  /** Default: one cache shared by every caller in the process. */
  queryVectors?: QueryVectorCache;
  /** This machine; `available` is `host === thisHost`. Default os.hostname(). */
  host?: string;
}

export interface SessionSearchFilter {
  /** Resolved repo key, e.g. `mcp-notes`. */
  repo?: string;
  /** Only sessions whose transcript lives on this host. */
  host?: string;
  /** Inclusive lower bound on the session's activity: YYYY-MM-DD (local day) or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (whole local day) or ISO datetime. */
  to?: string;
  /** 1..SESSION_SEARCH_MAX_LIMIT, default SESSION_SEARCH_DEFAULT_LIMIT. */
  limit?: number;
  /** Opaque value from a previous page's next_cursor. */
  cursor?: string;
}

export interface SessionSearchOptions {
  /** Default 'hybrid'. 'text' is the full-text ranking only. */
  mode?: SearchMode;
  queryTimeoutMs?: number;
  /** Recency reference. Default new Date(). */
  now?: Date;
}

/** One search result, wire-ready (snake_case, ISO strings). */
export interface SessionSearchHit {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  /** False when the transcript lives on another machine (invariant 7). */
  available: boolean;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  /** custom title, else AI title, else name. */
  title: string | null;
  /** Cut to 500 characters. */
  first_prompt: string | null;
  summary: string | null;
  started_at: string | null;
  last_active_at: string | null;
  parent_session_id: string | null;
  parent_link_source: 'env' | 'hook' | 'heuristic' | null;
  /** Ranking score: the blended score in hybrid mode, ts_rank in text mode (phase 7 rounds and returns it). */
  score: number;
}

export interface SessionSearchPage {
  sessions: SessionSearchHit[];
  next_cursor: string | null;
  /** The ranking actually used. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run. */
  fallback?: string;
}

type HitDbRow = {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  summary: string | null;
  started_at: Date | string | null;
  last_active_at: Date | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
  text_rank: number | string | null;
  similarity: number | string | null;
};

const defaultQueryVectors = new QueryVectorCache();

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampSessionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function tsv(): SQL {
  return sql.raw(`s.${SESSION_TSV_COLUMN}`);
}

function hitFields(): SQL {
  return sql`s.session_id, s.node_id, s.repo, s.host, s.cwd, s.branch, s.name, s.custom_title, s.ai_title,
    left(s.first_prompt, ${HIT_PROMPT_CHARS}) as first_prompt, s.summary, s.started_at, s.last_active_at,
    s.parent_session_id, s.parent_link_source`;
}

function filterSql(filter: SessionSearchFilter): SQL {
  const conds: SQL[] = [sql`true`];
  if (filter.repo !== undefined && filter.repo !== '') conds.push(sql`s.repo = ${filter.repo}`);
  if (filter.host !== undefined && filter.host !== '') conds.push(sql`s.host = ${filter.host}`);
  if (filter.from !== undefined && filter.from !== '') {
    conds.push(sql`coalesce(s.last_active_at, s.started_at) >= ${parseDateBound(filter.from, 'from').toISOString()}::timestamptz`);
  }
  if (filter.to !== undefined && filter.to !== '') {
    conds.push(sql`coalesce(s.started_at, s.last_active_at) < ${parseDateBound(filter.to, 'to').toISOString()}::timestamptz`);
  }
  return sql.join(conds, sql` and `);
}

function toHit(r: HitDbRow, thisHost: string, score: number): SessionSearchHit {
  const source = r.parent_link_source;
  return {
    session_id: r.session_id,
    node_id: r.node_id,
    repo: r.repo,
    host: r.host,
    available: r.host === thisHost,
    cwd: r.cwd,
    branch: r.branch,
    name: r.name,
    title: r.custom_title ?? r.ai_title ?? r.name,
    first_prompt: r.first_prompt,
    summary: r.summary,
    started_at: toDate(r.started_at)?.toISOString() ?? null,
    last_active_at: toDate(r.last_active_at)?.toISOString() ?? null,
    parent_session_id: r.parent_session_id,
    parent_link_source: source === 'env' || source === 'hook' || source === 'heuristic' ? source : null,
    score,
  };
}

async function textSearch(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter,
  offset: number,
  limit: number,
  fallback?: string,
): Promise<SessionSearchPage> {
  const tsq = sql`websearch_to_tsquery('simple', ${query})`;
  const res = await deps.db.execute<HitDbRow>(sql`
    select ${hitFields()}, ts_rank(${tsv()}, ${tsq})::float8 as text_rank, null::float8 as similarity
    from cc_sessions s
    where ${tsv()} @@ ${tsq} and ${filterSql(filter)}
    order by text_rank desc, s.last_active_at desc nulls last, s.session_id desc
    limit ${limit + 1} offset ${offset}
  `);
  const thisHost = deps.host ?? hostname();
  const rows = res.rows;
  const page: SessionSearchPage = {
    sessions: rows.slice(0, limit).map((r) => toHit(r, thisHost, toNumberOrNull(r.text_rank) ?? 0)),
    next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    mode: 'text',
  };
  if (fallback !== undefined) page.fallback = fallback;
  return page;
}

interface HybridQuery {
  query: string;
  vector: readonly number[];
  model: string;
  nodeIds: readonly string[];
  excluded: readonly string[];
}

async function hybridCandidates(db: Db, q: HybridQuery, filter: SessionSearchFilter): Promise<HitDbRow[]> {
  const tsq = sql`websearch_to_tsquery('simple', ${q.query})`;
  const qvec = sql`${toVectorLiteral(q.vector)}::vector`;
  const fields = sql`${hitFields()},
    (case when ${tsv()} @@ ${tsq} then ts_rank(${tsv()}, ${tsq}) end)::float8 as text_rank,
    (1 - (e.embedding <=> ${qvec}))::float8 as similarity`;
  const joinCurrent = sql`e.session_id = s.session_id and e.model = ${q.model} and e.embedding is not null`;
  const filters = filterSql(filter);

  // 1. Full-text matches, best ts_rank first, with their similarity when they have a vector.
  const textRows = await db.execute<HitDbRow>(sql`
    select ${fields}
    from cc_sessions s
    left join cc_session_embeddings e on ${joinCurrent}
    where ${tsv()} @@ ${tsq} and ${filters}
    order by ts_rank(${tsv()}, ${tsq}) desc, s.last_active_at desc nulls last, s.session_id desc
    limit ${BLEND.textCandidates}
  `);

  // 2. Nearest vectors (exclusions apply here too, as in note search).
  const excluded =
    q.excluded.length > 0
      ? sql`not (${tsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const vectorRows = await db.execute<HitDbRow>(sql`
    select ${fields}
    from cc_sessions s
    join cc_session_embeddings e on ${joinCurrent}
    where ${filters} and ${excluded}
    order by e.embedding <=> ${qvec}
    limit ${BLEND.vectorCandidates}
  `);

  // 3. Sessions the query names by node id.
  const idRows =
    q.nodeIds.length > 0
      ? await db.execute<HitDbRow>(sql`
          select ${fields}
          from cc_sessions s
          left join cc_session_embeddings e on ${joinCurrent}
          where s.node_id in (${sql.join(
            q.nodeIds.map((id) => sql`${id}`),
            sql`, `,
          )}) and ${filters}
        `)
      : { rows: [] as HitDbRow[] };

  const byId = new Map<string, HitDbRow>();
  for (const r of [...textRows.rows, ...vectorRows.rows, ...idRows.rows]) {
    if (!byId.has(r.session_id)) byId.set(r.session_id, r);
  }
  return [...byId.values()];
}

/**
 * Hybrid search over cc_sessions: full-text rank on the generated tsvector, closeness in
 * meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id, blended by src/search/blend.ts (same weights as note search). Falls back to
 * full text, with `fallback` saying why, without an embedder or when the query cannot be
 * embedded in time. The cursor is an offset into whichever ranking produced the page.
 */
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter = {},
  opts: SessionSearchOptions = {},
): Promise<SessionSearchPage> {
  if (query.trim() === '') throw new NoteError('invalid_input', 'sessions search needs a non-empty query.');
  const offset = decodeCursor(filter.cursor);
  const limit = clampSessionLimit(filter.limit);
  // Validate dates before spending an embedding call.
  filterSql(filter);
  if (opts.mode === 'text') return textSearch(deps, query, filter, offset, limit);
  const embedder = deps.embedder;
  if (embedder === null) return textSearch(deps, query, filter, offset, limit, SESSIONS_SEMANTIC_OFF_FALLBACK);

  let vector: number[];
  try {
    vector = await embedQuery(
      embedder,
      deps.queryVectors ?? defaultQueryVectors,
      query,
      opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    );
  } catch (err) {
    return textSearch(deps, query, filter, offset, limit, sessionEmbedFailedFallback(err));
  }

  const terms = queryTerms(query);
  const nodeIds = findNodeIdCandidates(query.toUpperCase());
  const rows = await hybridCandidates(
    deps.db,
    { query, vector, model: embedder.model, nodeIds, excluded: terms.excluded },
    filter,
  );
  const epoch = new Date(0);
  const ranked = rankCandidates(
    rows.map((r) => ({
      id: r.session_id,
      textRank: toNumberOrNull(r.text_rank),
      similarity: toNumberOrNull(r.similarity),
      tagMatch: tagMatch(r.repo !== null ? [r.repo.toLowerCase()] : [], terms),
      updatedAt: toDate(r.last_active_at) ?? toDate(r.started_at) ?? epoch,
      exactId: nodeIds.includes(r.node_id),
      row: r,
    })),
    { now: opts.now ?? new Date() },
  );
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  return {
    sessions: ranked.slice(offset, end).map((c) => toHit(c.row, thisHost, c.score)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'hybrid',
  };
}
```
**Impact:** none until phase 7 calls it. `decodeCursor`/`encodeCursor` (`src/notes/repo.ts:79,83`), `parseDateBound` (`src/notes/dates.ts:15`), `toVectorLiteral` (`src/embeddings/repo.ts:48`), `rankCandidates`/`queryTerms`/`tagMatch`/`BLEND` (`src/search/blend.ts`), `embedQuery`/`QueryVectorCache` (`src/search/queryVector.ts`) are imported, not changed.

### Step 5: Wire the worker into `startBackground`, build the summarizer in the daemon
**Files:** `src/background.ts` as it stands after phases 3 and 4 (phase 3 Step 6 quotes the whole
file; phase 4 Step 2 adds `sessionLinks`), and `src/daemon.ts:117`.
**Change:** Start the summary worker when `config.sessions.enabled` is true and at least one of
summarizer/embedder is available. The summarizer is **injected**: `startBackground` never builds
one itself; omitted or null means summaries off (embeddings still run). The production daemon
(`src/daemon.ts`) is the only place that builds the Agent SDK summarizer. That keeps
`npm test`/`test:int` off the network by construction (invariant 2): phase 3's
`sessions.ingest.int.test.ts` calls `startBackground(deps)` with sessions enabled and gets no
summarizer and no embedder, so nothing here starts. No `process.env.VITEST` check (reconciled).
No ingest trigger is wired: idleness is a 15-minute property, so the 60 s sweep finds every newly
idle session within a minute of it qualifying, and phase 3's `ingest.ts` stays untouched.

**(a) `src/background.ts`.** Imports to add next to phase 3/4's (`SessionsRepo` and `hostname` are
already imported by phase 3; do not import them again):
```ts
import { readLiveSessions } from './sessions/registry.js';
import type { Summarizer } from './sessions/summarize.js';
import { dbSummaryStore, startSummaryWorker, type SummaryWorker } from './sessions/summaryWorker.js';
```

Options type, above `startBackground`:
```ts
export interface BackgroundOptions {
  /**
   * Session summarizer (phase 6). Omitted or null: summaries off, session embeddings still run
   * when an embedder is configured. The daemon passes the Agent SDK Haiku summarizer; tests pass
   * a fake or nothing.
   */
  sessionSummarizer?: Summarizer | null;
}
```

Signature:
```ts
export async function startBackground(deps: AppDeps, options: BackgroundOptions = {}): Promise<StopBackground> {
```

New block, after phase 3/4's session block (the `if (!deps.config.sessions.enabled) {...} else {...}`) and before `return`:
```ts
  let sessionSummaries: SummaryWorker | null = null;
  if (deps.config.sessions.enabled) {
    const summarizer = options.sessionSummarizer ?? null;
    if (summarizer === null && deps.embedder === null) {
      console.log('[notesd] session summaries and session embeddings off');
    } else {
      const claudeHome = deps.config.sessions.claudeHome;
      sessionSummaries = startSummaryWorker({
        store: dbSummaryStore(deps.db, new SessionsRepo(deps.db)),
        summarizer,
        embedder: deps.embedder,
        liveSessionIds: async () => new Set((await readLiveSessions(claudeHome)).map((s) => s.sessionId)),
      });
      console.log(
        `[notesd] session summaries: ${summarizer === null ? 'off' : summarizer.model}, session embeddings: ${deps.embedder === null ? 'off' : deps.embedder.model}`,
      );
    }
  }
```

Returned closer (post-phase-4 shape, `sessionSummaries?.close()` added to the parallel list):
```ts
  return async () => {
    await inbox.close();
    // In parallel: each close is bounded by its grace (5 s), well under main.ts's 10 s exit.
    await Promise.all([
      embeddings?.close(),
      imageEmbeddings?.close(),
      (async () => {
        await sessionIngest?.close();
        await sessionLinks?.close();
      })(),
      sessionSummaries?.close(),
    ]);
  };
```

**(b) `src/daemon.ts`.** Imports:
```ts
import { SUMMARIES_SUBDIR, createAgentSummarizer, type Summarizer } from './sessions/summarize.js';
```
(`join` from `node:path` is already imported there for `CHAT_SUBDIR`.) Replace line 117
`const stopBackground = await startBackground(deps);` with:
```ts
  let sessionSummarizer: Summarizer | null = null;
  if (config.sessions.enabled) {
    sessionSummarizer = createAgentSummarizer({
      claudeBin: config.chat.claudeBin,
      cwd: join(config.dataDir, SUMMARIES_SUBDIR),
    });
    if (sessionSummarizer === null) {
      console.log(`[notesd] session summaries off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
    }
  }
  const stopBackground = await startBackground(deps, { sessionSummarizer });
```
The only test that runs `startDaemon` with a real config is `tests/live/chat.live.test.ts`, which
phase 3 already runs with `NOTESD_SESSIONS=off`; `tests/integration/daemon.int.test.ts` builds its
config with `DEFAULT_SESSIONS_CONFIG` (off). Neither builds a summarizer.
**Impact:** `startBackground` gains an optional parameter; existing callers compile unchanged. With
`NOTESD_SESSIONS=off` (or a test config built with `DEFAULT_SESSIONS_CONFIG`) nothing new starts.

### Step 6: Fake summarizer
**File:** `tests/helpers/fakeSummarizer.ts` (new)
**Code:**
```ts
import type { SummarizeRequest, Summarizer } from '../../src/sessions/summarize.js';

/**
 * Deterministic offline Summarizer. The summary is "Summary of <node line>: <first prompt line>",
 * built from the input so tests can assert what the model saw.
 */
export class FakeSummarizer implements Summarizer {
  readonly model = 'fake-haiku';
  /** Every request, in call order (failed ones included). */
  readonly calls: SummarizeRequest[] = [];
  delayMs = 0;
  private failuresLeft = 0;
  private failure: Error = new Error('fake summarizer: scripted failure');
  /** Fixed answer; null = derive from the input. */
  answer: string | null = null;

  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? new Error('fake summarizer: scripted failure');
  }

  async summarize(req: SummarizeRequest): Promise<string> {
    this.calls.push(req);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        req.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('summary aborted'));
          },
          { once: true },
        );
      });
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    if (this.answer !== null) return this.answer;
    const lines = req.input.split('\n');
    const node = lines[0] ?? '';
    const firstPrompt = lines.find((l) => /^1\. /.test(l))?.slice(3) ?? '';
    return `Summary of ${node}: ${firstPrompt}`;
  }
}

export function createFakeSummarizer(): FakeSummarizer {
  return new FakeSummarizer();
}
```

### Step 7: Unit tests — redaction
**File:** `tests/unit/sessions/redact.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../../src/sessions/redact.js';

describe('redactSecrets', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic key', 'key is sk-ant-api03-AbCdEf1234567890xyz', 'sk-ant-api03'],
    ['openrouter key', 'OPENROUTER sk-or-v1-0123456789abcdef0123', 'sk-or-v1'],
    ['github token', 'push with ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz0123', 'ghp_ABCD'],
    ['gitlab token', 'glpat-abcdefghij0123456789xx', 'glpat-abc'],
    ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234'],
    ['aws key id', 'AKIAABCDEFGHIJKLMNOP is the id', 'AKIAABCD'],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSy'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGci'],
    ['bearer header', 'curl -H "Authorization: Bearer abc.def.ghi123"', 'abc.def.ghi123'],
    ['basic header', 'authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['postgres url', 'DATABASE_URL=postgres://neondb_owner:p4ssw0rd@ep-x.neon.tech/neondb', 'p4ssw0rd'],
    ['redis url in prose', 'connect to redis://default:hunter2@localhost:6379', 'hunter2'],
    ['env secret', 'OPENROUTER_API_KEY=whatever-value-here', 'whatever-value-here'],
    ['export secret', 'export GITHUB_TOKEN="plain"', 'plain'],
    ['yaml password', 'password: correct horse', 'correct'],
    ['json secret', '{"client_secret": "s3cr3t-value"}', 's3cr3t-value'],
    ['query string', 'https://x.test/cb?api_key=abc123&x=1', 'abc123'],
    ['opaque env value', 'SOME_THING=Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0A', 'Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0A'],
    ['opaque token in prose', 'use Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0Aq to log in', 'Zx8kP2qLm9Rt4Vw7Yb3Nc6Hd1Jf5Gs0Aq'],
  ];

  for (const [label, input, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    });
  }

  it('redacts a whole PEM private key block', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const out = redactSecrets(`here:\n${pem}\nthanks`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out).toContain(`${REDACTED} private key`);
    expect(out).toContain('thanks');
  });

  it('keeps ordinary text, paths, commit shas and harmless env lines', () => {
    const text = [
      'fix the wall editor in src/sessions/summaryWorker.ts',
      'commit 8c259df0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
      'NODE_ENV=production',
      'NOTESD_SESSIONS=off',
      'used 500 input tokens',
      'https://github.com/miftahulmahfuzh/mcp-notes/pull/12',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets('OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123 and Bearer abcdef');
    expect(redactSecrets(once)).toBe(once);
  });
});
```

### Step 8: Unit tests — summarizer
**File:** `tests/unit/sessions/summarize.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  SUMMARY_MODEL,
  asLines,
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  createAgentSummarizer,
  embedTextSha,
  findClaudeBin,
  summaryInputSha,
  type SessionSummarySource,
} from '../../../src/sessions/summarize.js';

function source(over: Partial<SessionSummarySource> = {}): SessionSummarySource {
  return {
    sessionId: 's-1',
    nodeId: 'A0-3G',
    repo: 'mcp-notes',
    branch: 'feature/x',
    name: 'impl-x-p1',
    customTitle: 'wall editing',
    aiTitle: null,
    firstPrompt: 'make the wall editable',
    prompts: ['make the wall editable', 'also delete photos'],
    commits: [{ sha: '8c259df0b1c2d3e4', subject: 'feat(web): edit on the wall' }],
    filesEdited: ['web/src/App.tsx'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    finalMessage: 'Done: the wall is editable.',
    summary: null,
    summarySha: null,
    ...over,
  };
}

function result(text: string, isError = false): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: 'x',
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'summarize-'));
  bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('asLines', () => {
  it('accepts strings and objects', () => {
    expect(asLines(['a', ' ', { sha: '0123456789abcdef', subject: 'fix' }, { path: 'x.ts' }, 3])).toEqual([
      'a',
      '0123456789 fix',
      'x.ts',
      '3',
    ]);
    expect(asLines(null)).toEqual([]);
    expect(asLines('one')).toEqual(['one']);
  });
});

describe('buildSummaryInput', () => {
  it('lists repo, titles, prompts, commits, files, plan docs and the final message', () => {
    const input = buildSummaryInput(source());
    expect(input).not.toBeNull();
    expect(input).toContain('Node: A0-3G');
    expect(input).toContain('Repository: mcp-notes');
    expect(input).toContain('1. make the wall editable');
    expect(input).toContain('2. also delete photos');
    expect(input).toContain('- 8c259df0b1 feat(web): edit on the wall');
    expect(input).toContain('- web/src/App.tsx');
    expect(input).toContain('- docs/plans/WALL_PLAN.md');
    expect(input).toContain('Done: the wall is editable.');
  });

  it('redacts secrets before the model sees them', () => {
    const input = buildSummaryInput(
      source({ prompts: ['connect with postgres://u:hunter2@db/x and OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123'] }),
    );
    expect(input).not.toContain('hunter2');
    expect(input).not.toContain('sk-or-v1-0123456789abcdef0123');
    expect(input).toContain('[redacted]');
  });

  it('is null when there is nothing to summarize', () => {
    expect(buildSummaryInput(source({ prompts: [], firstPrompt: null, finalMessage: null }))).toBeNull();
  });

  it('keeps the first 10 and last 30 of many prompts', () => {
    const prompts = Array.from({ length: 100 }, (_, i) => `prompt ${i} end`);
    const input = buildSummaryInput(source({ prompts })) ?? '';
    expect(input).toContain('prompt 0 end');
    expect(input).toContain('prompt 99 end');
    expect(input).not.toContain('prompt 50 end');
    expect(input).toContain('(60 more prompts omitted)');
  });

  it('never exceeds the input cap', () => {
    const prompts = Array.from({ length: 100 }, (_, i) => `prompt ${i} ${'x'.repeat(2000)}`);
    const input = buildSummaryInput(source({ prompts })) ?? '';
    expect(input.length).toBeLessThanOrEqual(24_000);
  });
});

describe('shas', () => {
  it('summaryInputSha is stable and changes with the input', () => {
    const a = buildSummaryInput(source()) ?? '';
    expect(summaryInputSha(a)).toBe(summaryInputSha(a));
    expect(summaryInputSha(a)).not.toBe(summaryInputSha(`${a}!`));
  });

  it('embed text includes title, summary and prompts, redacted', () => {
    const text = buildEmbedText(source({ summary: 'Made the wall editable.', prompts: ['token=abc123secret'] })) ?? '';
    expect(text).toContain('wall editing');
    expect(text).toContain('Made the wall editable.');
    expect(text).not.toContain('abc123secret');
    expect(embedTextSha(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cleanSummary', () => {
  it('drops a Summary: lead-in, caps and redacts', () => {
    expect(cleanSummary('**Summary:** Did X with Bearer abcdef here.')).toBe('Did X with Bearer [redacted] here.');
    expect(cleanSummary('x'.repeat(5000)).length).toBeLessThanOrEqual(1500);
  });
});

describe('findClaudeBin', () => {
  it('finds an executable path and rejects a missing one', () => {
    expect(findClaudeBin(bin, '')).toBe(bin);
    expect(findClaudeBin(path.join(dir, 'nope'), '')).toBeNull();
    expect(findClaudeBin('claude', dir)).toBe(bin);
    expect(findClaudeBin('claude', path.join(dir, 'empty'))).toBeNull();
  });
});

describe('createAgentSummarizer', () => {
  it('returns null when the claude binary is missing', () => {
    expect(createAgentSummarizer({ claudeBin: path.join(dir, 'nope'), cwd: dir })).toBeNull();
  });

  it('runs haiku with no tools, one turn, no persisted session, and returns the result', async () => {
    const seen: Options[] = [];
    const query: QueryFn = ({ options }) => {
      seen.push(options);
      return (async function* () {
        yield result('Made the wall editable.');
      })();
    };
    const s = createAgentSummarizer({
      claudeBin: bin,
      cwd: path.join(dir, 'session-summaries'),
      query,
      baseEnv: { PATH: '', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'parent' },
    });
    expect(s).not.toBeNull();
    const out = await s!.summarize({ sessionId: 's-1', input: 'Node: A0-3G', signal: new AbortController().signal });
    expect(out).toBe('Made the wall editable.');
    const o = seen[0]!;
    expect(o.model).toBe(SUMMARY_MODEL);
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.maxTurns).toBe(1);
    expect(o.persistSession).toBe(false);
    expect(o.settingSources).toEqual([]);
    expect(o.pathToClaudeCodeExecutable).toBe(bin);
    expect(o.cwd).toBe(path.join(dir, 'session-summaries'));
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('rejects on an error result', async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield result('usage limit reached', true);
      })();
    const s = createAgentSummarizer({ claudeBin: bin, cwd: dir, query, baseEnv: { PATH: '' } })!;
    await expect(s.summarize({ sessionId: 's', input: 'x', signal: new AbortController().signal })).rejects.toThrow(
      /usage limit/,
    );
  });

  it('rejects when aborted', async () => {
    const query: QueryFn = ({ options }) =>
      (async function* () {
        await new Promise<void>((resolve) => options.abortController?.signal.addEventListener('abort', () => resolve()));
        throw new Error('aborted by caller');
      })();
    const s = createAgentSummarizer({ claudeBin: bin, cwd: dir, query, baseEnv: { PATH: '' } })!;
    const ac = new AbortController();
    const p = s.summarize({ sessionId: 's', input: 'x', signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
```

### Step 9: Unit tests — worker (in-memory store)
**File:** `tests/unit/sessions/summaryWorker.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import type { SessionSummarySource } from '../../../src/sessions/summarize.js';
import {
  startSummaryWorker,
  type SummaryCandidate,
  type SummaryStore,
  type SummaryWorker,
} from '../../../src/sessions/summaryWorker.js';
import { createFakeEmbedder } from '../../helpers/fakeEmbedder.js';
import { createFakeSummarizer } from '../../helpers/fakeSummarizer.js';

const HOST = 'lenovo';
const OLD = new Date(Date.now() - 60 * 60_000);

interface MemRow extends SessionSummarySource {
  host: string;
  lastActiveAt: Date;
  summarizedAt: Date | null;
  embedding: { sha: string; model: string; vector: number[] } | null;
}

class MemoryStore implements SummaryStore {
  readonly rows = new Map<string, MemRow>();
  summarySaves = 0;
  embeddingSaves = 0;

  add(over: Partial<MemRow> & { sessionId: string }): MemRow {
    const row: MemRow = {
      nodeId: 'A0-3G',
      repo: 'mcp-notes',
      branch: null,
      name: null,
      customTitle: 'wall editing',
      aiTitle: null,
      firstPrompt: null,
      prompts: ['make the wall editable'],
      commits: [],
      filesEdited: [],
      planDocs: [],
      finalMessage: 'done',
      summary: null,
      summarySha: null,
      host: HOST,
      lastActiveAt: OLD,
      summarizedAt: null,
      embedding: null,
      ...over,
    };
    this.rows.set(row.sessionId, row);
    return row;
  }

  async listIdle(o: Parameters<SummaryStore['listIdle']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === o.host && r.lastActiveAt < o.idleBefore)
      .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
      .slice(0, o.limit)
      .map((r) => ({
        sessionId: r.sessionId,
        lastActiveAt: r.lastActiveAt,
        summarySha: r.summarySha,
        summarizedAt: r.summarizedAt,
        embeddingSha: r.embedding?.sha ?? null,
        embeddingModel: r.embedding?.model ?? null,
      }));
  }

  async load(ids: readonly string[]): Promise<SessionSummarySource[]> {
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r === undefined ? [] : [{ ...r }];
    });
  }

  async saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void> {
    const r = this.rows.get(v.sessionId)!;
    r.summary = v.summary;
    r.summarySha = v.summarySha;
    r.summarizedAt = new Date();
    this.summarySaves += 1;
  }

  async saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void> {
    this.rows.get(v.sessionId)!.embedding = { sha: v.sha, model: v.model, vector: v.embedding };
    this.embeddingSaves += 1;
  }
}

function start(store: MemoryStore, over: Partial<Parameters<typeof startSummaryWorker>[0]> = {}): SummaryWorker {
  return startSummaryWorker({
    store,
    summarizer: createFakeSummarizer(),
    embedder: createFakeEmbedder(),
    host: HOST,
    minIntervalMs: 0,
    embedMinIntervalMs: 0,
    sweepMs: 3_600_000,
    log: () => {},
    ...over,
  });
}

describe('summary worker', () => {
  it('summarizes and embeds an idle session once', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const summarizer = createFakeSummarizer();
    const embedder = createFakeEmbedder();
    const w = start(store, { summarizer, embedder });
    await w.idle();
    const row = store.rows.get('s-1')!;
    expect(row.summary).toMatch(/^Summary of Node: A0-3G/);
    expect(row.summarySha).toMatch(/^[0-9a-f]{64}$/);
    expect(row.embedding?.vector.length).toBe(embedder.dimensions);
    expect(summarizer.calls).toHaveLength(1);
    expect(embedder.calls).toHaveLength(1);

    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    expect(embedder.calls).toHaveLength(1);
    await w.close();
  });

  it('does not re-summarize an unchanged session after a restart', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const first = start(store);
    await first.idle();
    await first.close();

    const summarizer = createFakeSummarizer();
    const embedder = createFakeEmbedder();
    const second = start(store, { summarizer, embedder });
    await second.idle();
    expect(summarizer.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);
    await second.close();
  });

  it('re-summarizes when the input changed', async () => {
    const store = new MemoryStore();
    const row = store.add({ sessionId: 's-1' });
    const w = start(store);
    await w.idle();
    const firstSha = row.summarySha;
    row.prompts = ['make the wall editable', 'and add a recycle bin'];
    row.lastActiveAt = new Date(OLD.getTime() + 1000);
    w.kick();
    await w.idle();
    expect(row.summarySha).not.toBe(firstSha);
    await w.close();
  });

  it('skips live sessions, other hosts and sessions that are not idle yet', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'live' });
    store.add({ sessionId: 'other', host: 'gpd' });
    store.add({ sessionId: 'fresh', lastActiveAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer, liveSessionIds: async () => new Set(['live']) });
    await w.idle();
    expect(summarizer.calls).toHaveLength(0);
    await w.close();
  });

  it('sends only redacted input to the summarizer and the embedder', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1', prompts: ['use OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123 now'] });
    const summarizer = createFakeSummarizer();
    const embedder = createFakeEmbedder();
    const w = start(store, { summarizer, embedder });
    await w.idle();
    expect(summarizer.calls[0]?.input).not.toContain('sk-or-v1-0123456789abcdef0123');
    expect(embedder.calls.flat().join('\n')).not.toContain('sk-or-v1-0123456789abcdef0123');
    await w.close();
  });

  it('processes newest first', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'older', nodeId: 'B0-000', lastActiveAt: new Date(OLD.getTime() - 60_000) });
    store.add({ sessionId: 'newer', nodeId: 'C0-000' });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['newer', 'older']);
    await w.close();
  });

  it('a failed summary is retried later, not in the same drain', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const summarizer = createFakeSummarizer();
    summarizer.failNext(1);
    const logs: string[] = [];
    const w = start(store, { summarizer, log: (l) => logs.push(l) });
    await w.idle();
    expect(store.rows.get('s-1')?.summary).toBeNull();
    expect(logs.some((l) => l.includes('1 failed'))).toBe(true);
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    await w.close();
  });

  it('without a summarizer still embeds; without an embedder still summarizes', async () => {
    const a = new MemoryStore();
    a.add({ sessionId: 's-1' });
    const w1 = start(a, { summarizer: null });
    await w1.idle();
    expect(a.rows.get('s-1')?.summary).toBeNull();
    expect(a.rows.get('s-1')?.embedding).not.toBeNull();
    await w1.close();

    const b = new MemoryStore();
    b.add({ sessionId: 's-1' });
    const w2 = start(b, { embedder: null });
    await w2.idle();
    expect(b.rows.get('s-1')?.summary).not.toBeNull();
    expect(b.rows.get('s-1')?.embedding).toBeNull();
    await w2.close();
  });

  it('close() aborts an in-flight summary within the grace', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const summarizer = createFakeSummarizer();
    summarizer.delayMs = 60_000;
    const w = start(store, { summarizer, closeGraceMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(store.rows.get('s-1')?.summary).toBeNull();
  });
});
```

### Step 10: Integration test — worker against Postgres
**File:** `tests/integration/sessions.summaries.int.test.ts` (new)
**Change:** Inserts fixture rows with raw SQL (test fixtures, not product code; invariant 3 binds `src/`), runs the worker through `dbSummaryStore` + the real `SessionsRepo`.
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { dbSummaryStore, startSummaryWorker } from '../../src/sessions/summaryWorker.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { createFakeSummarizer } from '../helpers/fakeSummarizer.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
let db: Db;

async function insertSession(v: {
  sessionId: string;
  nodeId: string;
  host?: string;
  lastActiveMinutesAgo: number;
  prompts: string[];
}): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, custom_title, first_prompt,
      prompts, commits, files_edited, plan_docs, final_message, started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${v.host ?? HOST}, 'mcp-notes', '/home/u/mcp-notes', 'impl-x', 'wall editing',
      ${v.prompts[0] ?? null}, ${JSON.stringify(v.prompts)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'done',
      now() - make_interval(mins => ${v.lastActiveMinutesAgo + 30}),
      now() - make_interval(mins => ${v.lastActiveMinutesAgo}), now(), now())
  `);
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db); // phase 1 extended it to the cc_* tables
});

describe('session summary worker (Postgres)', () => {
  it('summarizes and embeds an idle session once, redacted, and skips fresh and foreign ones', async () => {
    await insertSession({
      sessionId: '11111111-1111-1111-1111-111111111111',
      nodeId: 'A0-3G',
      lastActiveMinutesAgo: 60,
      prompts: ['fix the login, password: hunter2'],
    });
    await insertSession({ sessionId: '22222222-2222-2222-2222-222222222222', nodeId: 'B1-4H', lastActiveMinutesAgo: 1, prompts: ['fresh'] });
    await insertSession({
      sessionId: '33333333-3333-3333-3333-333333333333',
      nodeId: 'C2-5J',
      host: 'other-host',
      lastActiveMinutesAgo: 60,
      prompts: ['elsewhere'],
    });

    const summarizer = createFakeSummarizer();
    const embedder = createFakeEmbedder();
    const store = dbSummaryStore(db, new SessionsRepo(db));
    const opts = { store, summarizer, embedder, host: HOST, minIntervalMs: 0, embedMinIntervalMs: 0, sweepMs: 3_600_000, log: () => {} };
    const w = startSummaryWorker(opts);
    await w.idle();
    await w.close();

    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(summarizer.calls[0]?.input).not.toContain('hunter2');

    const rows = await db.execute<{ session_id: string; summary: string | null; summary_sha: string | null; has_vec: boolean | null }>(sql`
      select s.session_id, s.summary, s.summary_sha, e.embedding is not null as has_vec
      from cc_sessions s left join cc_session_embeddings e on e.session_id = s.session_id
      order by s.session_id
    `);
    const byId = new Map(rows.rows.map((r) => [r.session_id, r]));
    expect(byId.get('11111111-1111-1111-1111-111111111111')?.summary).toMatch(/^Summary of Node: A0-3G/);
    expect(byId.get('11111111-1111-1111-1111-111111111111')?.has_vec).toBe(true);
    expect(byId.get('22222222-2222-2222-2222-222222222222')?.summary).toBeNull();
    expect(byId.get('33333333-3333-3333-3333-333333333333')?.summary).toBeNull();

    // A new worker (daemon restart) does nothing for the unchanged session.
    const summarizer2 = createFakeSummarizer();
    const embedder2 = createFakeEmbedder();
    const w2 = startSummaryWorker({ ...opts, summarizer: summarizer2, embedder: embedder2 });
    await w2.idle();
    await w2.close();
    expect(summarizer2.calls).toHaveLength(0);
    expect(embedder2.calls).toHaveLength(0);
  });
});
```

### Step 11: Integration test — session search
**File:** `tests/integration/sessions.search.int.test.ts` (new)
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { SESSIONS_SEMANTIC_OFF_FALLBACK, searchSessions } from '../../src/sessions/search.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
let db: Db;
let embedder: FakeEmbedder;

async function insertSession(v: {
  sessionId: string;
  nodeId: string;
  repo: string;
  host?: string;
  summary: string;
  daysAgo: number;
  embed?: boolean;
}): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, prompts, summary,
      started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${v.host ?? HOST}, ${v.repo}, '/tmp', null, 'start', '["start"]'::jsonb, ${v.summary},
      now() - make_interval(days => ${v.daysAgo}, hours => 1), now() - make_interval(days => ${v.daysAgo}), now(), now())
  `);
  if (v.embed !== false) {
    const vec = embedder.vectorFor(v.summary);
    await db.execute(sql`
      insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
      values (${v.sessionId}, 'sha', ${embedder.model}, ${toVectorLiteral(vec)}::vector, now(), now(), now())
    `);
  }
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db); // phase 1 extended it to the cc_* tables
  await insertSession({ sessionId: 's-literal', nodeId: 'A0-3G', repo: 'mcp-notes', summary: 'Wall photo delete button added to the editor.', daysAgo: 30 });
  await insertSession({ sessionId: 's-meaning', nodeId: 'B1-4H', repo: 'mcp-notes', summary: 'The login broke after the laptop slept.', daysAgo: 2 });
  await insertSession({ sessionId: 's-other', nodeId: 'C2-5J', repo: 'seer', host: 'gpd', summary: 'Leaderboard ranking tweaks.', daysAgo: 1 });
});

describe('searchSessions', () => {
  it('hybrid: a literal hit ranks first', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe('s-literal');
    expect(page.sessions[0]?.node_id).toBe('A0-3G');
    expect(page.sessions[0]?.available).toBe(true);
  });

  it('hybrid: finds a session by meaning with no shared word', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions.map((s) => s.session_id)).toContain('s-meaning');
    expect(page.sessions[0]?.session_id).toBe('s-meaning');
  });

  it('a node id in the query goes first', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'C2-5J photo delete');
    expect(page.sessions[0]?.session_id).toBe('s-other');
    expect(page.sessions[0]?.available).toBe(false);
  });

  it('without an embedder: full text with a fallback', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, 'photo delete');
    expect(page.mode).toBe('text');
    expect(page.fallback).toBe(SESSIONS_SEMANTIC_OFF_FALLBACK);
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal']);
  });

  it('mode text has no fallback', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'leaderboard', {}, { mode: 'text' });
    expect(page.mode).toBe('text');
    expect(page.fallback).toBeUndefined();
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-other']);
  });

  it('filters by repo, host and date', async () => {
    const byRepo = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { repo: 'seer' });
    expect(byRepo.sessions.map((s) => s.session_id)).toEqual(['s-other']);
    const byHost = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { host: HOST });
    expect(byHost.sessions.map((s) => s.session_id).sort()).toEqual(['s-literal', 's-meaning']);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const recent = await searchSessions({ db, embedder, host: HOST }, 'photo or delete or login', { from });
    expect(recent.sessions.map((s) => s.session_id)).not.toContain('s-literal');
  });

  it('pages with next_cursor and rejects an empty query', async () => {
    const first = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = await searchSessions({ db, embedder, host: HOST }, 'leaderboard or login or photo', { limit: 1, cursor: first.next_cursor ?? undefined });
    expect(second.sessions[0]?.session_id).not.toBe(first.sessions[0]?.session_id);
    await expect(searchSessions({ db, embedder, host: HOST }, '   ')).rejects.toThrow(/non-empty/);
  });
});
```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (adds `tests/unit/sessions/{redact,summarize,summaryWorker}.test.ts`), `npm run test:int` (adds `tests/integration/sessions.{summaries,search}.int.test.ts`). One file: `npx vitest run tests/unit/sessions/summaryWorker.test.ts`.
**Manual check:** `npm run dev` on a machine with transcripts: within a minute of startup the log shows `[notesd] session summaries: haiku, session embeddings: openai/text-embedding-3-small`, then `[notesd] session summaries: N summarized, M embedded, ...` lines every ~5 s per session through the backlog; `select node_id, summary from cc_sessions where summary is not null order by last_active_at desc limit 5;` shows short summaries with no secrets. Restarting the daemon produces no new summary calls for unchanged sessions. With `NOTESD_CLAUDE_BIN=/nonexistent` the log says once that summaries are off and embeddings still run.
**Exit criteria:** fake summarizer + fake embedder give an idle session a summary and a vector exactly once (and not again after restart); secrets in prompts never reach the summarizer or embedder; `searchSessions` returns hybrid-ranked sessions with `mode: 'hybrid'`, and `mode: 'text'` + `fallback` without an embedder; `npm run typecheck`, `npm test`, `npm run test:int` pass; `close()` returns within 5 s with a call in flight.

## Handoffs

- **Phase 7 (R6):** expose `searchSessions` as `sessions_search` (MCP, chat allowlist) and `GET /api/sessions/search?q=&repo=&limit=`. Build `SessionSearchDeps` as `{ db: deps.db, embedder: deps.embedder }` (one shared query-vector cache is the module default). Map `NoteError('invalid_input')` like note search does. Hits are already wire-shaped (snake_case, ISO dates, `available`, `score`); phase 7 re-reads its own `GraphNode` projection by `session_id` and keeps this order and score.
- **Phase 7 / 9:** `session_get` and the prompt-hook context (`/api/sessions/context`, phase 8's consumer) should include `cc_sessions.summary`, which this phase fills.
- **Phase 14 (docs):** README env table: no new env var; mention that summaries need the `claude` binary (`NOTESD_CLAUDE_BIN`) and embeddings need `OPENROUTER_API_KEY`, that summaries run 15 min after a session goes idle and are not live, at most one Haiku call per 5 s, owning host only; CLAUDE.md architecture bullet for `src/sessions/summaryWorker.ts` + `search.ts`.
- Not done here, deliberately: no HNSW index on `cc_session_embeddings` (schema is phase 1's; ~1000 rows do not need one). If the graph grows past ~20k sessions, add one in a later migration.

## Rollback

Revert this phase's commit. It adds four modules, one helper, five test files and an additive block in `src/background.ts`; no migration, no config change. Summaries and embeddings already written stay in `cc_sessions.summary*` and `cc_session_embeddings`; they are derived data and harmless (`update cc_sessions set summary = null, summary_sha = null, summarized_at = null; truncate cc_session_embeddings;` clears them if wanted).

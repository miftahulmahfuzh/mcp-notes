import type {
  CcPendingSpawnRow,
  CcSessionRow,
  ModelUsage,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';

export type { ModelUsage, ParentLinkSource, SessionCommit, SessionPrompt } from '../db/schema.js';
export { PARENT_LINK_SOURCES } from '../db/schema.js';

/** A `cc_sessions` row as the app sees it: every column except the generated `search_tsv`. */
export type SessionRow = Omit<CcSessionRow, 'searchTsv'>;

/** The light projection used by listings (graph payloads): no prompts/commits/files/final message. */
export type SessionListItem = Pick<
  SessionRow,
  | 'sessionId'
  | 'nodeId'
  | 'host'
  | 'repo'
  | 'cwd'
  | 'branch'
  | 'name'
  | 'customTitle'
  | 'aiTitle'
  | 'firstPrompt'
  | 'entrypoint'
  | 'startedAt'
  | 'lastActiveAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'parentSessionId'
  | 'parentLinkSource'
  | 'tmux'
  | 'transcriptPath'
  | 'summary'
>;

export type PendingSpawnRow = CcPendingSpawnRow;

/** Settings key of the repo selected in the wall's project sidebar (a JSON string). */
export const SELECTED_PROJECT_KEY = 'projects.selected';

/** A child's SessionStart claims a pending spawn recorded at most this long before it. */
export const PENDING_SPAWN_WINDOW_MS = 30_000;
/** Tolerated clock skew: a spawn recorded up to this long AFTER the claim time still matches. */
export const PENDING_SPAWN_SKEW_MS = 5_000;

/** Parent-link precedence. A link is replaced only by a source of equal or higher rank. */
export const PARENT_LINK_RANK: Readonly<Record<ParentLinkSource, number>> = { env: 3, hook: 2, heuristic: 1 };

/** Inserts tried before ensureSession gives up on finding a free node id. */
export const NODE_ID_ATTEMPTS = 8;

export const MAX_PROMPTS = 100;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_TITLE_CHARS = 300;
export const MAX_COMMITS = 200;
export const MAX_FILES_EDITED = 500;
export const MAX_PLAN_DOCS = 100;
export const MAX_FINAL_MESSAGE_CHARS = 8000;
export const LIST_DEFAULT_LIMIT = 1000;
export const LIST_MAX_LIMIT = 5000;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * What one ingest pass read from a transcript, from byte `fromOffset` to `toOffset` (both on
 * line boundaries). `fromOffset === 0` means the patch describes the whole file so far:
 * accumulators are replaced. Otherwise the stored offset must equal `fromOffset` and
 * accumulators are added to. Scalars: undefined or null = keep the stored value.
 */
export interface TranscriptPatch {
  sessionId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  /** File size when read. */
  size: number;
  repo?: string | null;
  cwd?: string | null;
  branch?: string | null;
  name?: string | null;
  customTitle?: string | null;
  aiTitle?: string | null;
  /** Only the earliest first prompt is kept. */
  firstPrompt?: string | null;
  lastPrompt?: string | null;
  entrypoint?: string | null;
  version?: string | null;
  finalMessage?: string | null;
  /** Merged as the minimum with the stored value. */
  startedAt?: Date | null;
  /** Merged as the maximum with the stored value. */
  lastActiveAt?: Date | null;
  /** Deltas for the bytes in this patch. */
  tokens?: Partial<TokenCounts>;
  /** Per-model deltas for the bytes in this patch. */
  models?: Record<string, Partial<ModelUsage>>;
  /** Absolute total from the latest `cost-state` record in this patch. */
  costUsd?: number | null;
  /** Appended (or, on fromOffset 0, replacing), capped to the newest MAX_PROMPTS. */
  prompts?: SessionPrompt[];
  /** Appended, deduped by sha, capped to the newest MAX_COMMITS. */
  commits?: SessionCommit[];
  /** Union, first-seen order, capped to MAX_FILES_EDITED. */
  filesEdited?: string[];
  /** Union, first-seen order, capped to MAX_PLAN_DOCS. */
  planDocs?: string[];
}

/** Columns a transcript patch writes. */
export type TranscriptSet = Pick<
  SessionRow,
  | 'repo'
  | 'cwd'
  | 'branch'
  | 'name'
  | 'customTitle'
  | 'aiTitle'
  | 'firstPrompt'
  | 'lastPrompt'
  | 'entrypoint'
  | 'version'
  | 'finalMessage'
  | 'startedAt'
  | 'lastActiveAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'models'
  | 'prompts'
  | 'commits'
  | 'filesEdited'
  | 'planDocs'
  | 'transcriptPath'
  | 'transcriptOffset'
  | 'transcriptSize'
>;

export type TranscriptUpsertResult =
  | { applied: true; row: SessionRow }
  | { applied: false; reason: 'offset_mismatch' | 'other_host'; storedOffset: number; row: SessionRow };

/** What the SessionStart hook reports (Phase 5). */
export interface HookStart {
  sessionId: string;
  host: string;
  cwd?: string | null;
  repo?: string | null;
  name?: string | null;
  tmux?: string | null;
  startedAt?: Date | null;
  /** From `CC_PARENT_SESSION`. */
  parentSessionId?: string | null;
  /** Default 'env'. */
  parentSource?: ParentLinkSource;
}

export interface HookStartResult {
  session: SessionRow;
  /** The parent's row (created if it did not exist), or null when no parent was given. */
  parent: SessionRow | null;
  /** Outcome of linking the parent, or null when no parent was given. */
  parentLink: SetParentResult | null;
}

export type SetParentResult = 'set' | 'kept' | 'missing' | 'self' | 'cycle';

export interface PendingSpawnInput {
  parentSessionId: string;
  host: string;
  cwd: string;
  name?: string | null;
  /** Default: the repo clock. */
  createdAt?: Date;
}

export interface SpawnClaim {
  childSessionId: string;
  host: string;
  cwd: string;
  name?: string | null;
  /** Default: the repo clock. */
  at?: Date;
  /** Default PENDING_SPAWN_WINDOW_MS. */
  windowMs?: number;
}

export interface SpawnClaimResult {
  spawn: PendingSpawnRow;
  parentLink: SetParentResult;
}

export interface ProjectSummary {
  repo: string;
  sessionCount: number;
  /** Newest of last_active_at / started_at / created_at over the repo's sessions. */
  lastActiveAt: Date;
  /** Distinct hosts holding the repo's transcripts, sorted. */
  hosts: string[];
}

export interface ListForRepoOptions {
  /** Exclusive upper bound on coalesce(started_at, created_at): the previous page's last value. */
  before?: Date;
  /** 1..LIST_MAX_LIMIT, default LIST_DEFAULT_LIMIT. */
  limit?: number;
}

export interface ListByNameOptions {
  /** Inclusive bounds on coalesce(started_at, created_at). */
  from?: Date;
  to?: Date;
  host?: string;
}

export interface TranscriptOffset {
  offset: number;
  size: number | null;
  path: string | null;
}

export interface SummaryInput {
  summary: string;
  sha: string;
  /** Default: the repo clock. */
  at?: Date;
}

export interface SessionEmbeddingInput {
  sha: string;
  model: string;
  embedding: number[];
}

export interface SessionEmbeddingFailure {
  sha: string;
  model: string;
  error: string;
}

export interface SessionsRepoOptions {
  /** Node id randomness, `(max) => int in [0, max)`. Default crypto.randomInt. */
  random?: (max: number) => number;
  /** Clock for updated_at / claimed_at / default times. Default `() => new Date()`. */
  now?: () => Date;
}

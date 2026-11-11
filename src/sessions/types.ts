import type {
  CcPendingSpawnRow,
  CcSessionRow,
  ForkDetectedBy,
  ModelUsage,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';

export type {
  CcSessionPromptRow,
  CcSessionReplyEmbeddingRow,
  CcSessionReplyRow,
  ForkDetectedBy,
  ModelUsage,
  NewCcSessionPromptRow,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';
export { FORK_DETECTED_BY, PARENT_LINK_SOURCES } from '../db/schema.js';

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
  | 'forkedAt'
  | 'forkPromptCount'
  | 'forkDetectedBy'
>;

export type PendingSpawnRow = CcPendingSpawnRow;

/** Settings key of the repo selected in the wall's project sidebar (a JSON string). */
export const SELECTED_PROJECT_KEY = 'projects.selected';

/** A child's SessionStart claims a pending spawn recorded at most this long before it. */
export const PENDING_SPAWN_WINDOW_MS = 30_000;
/** Tolerated clock skew: a spawn recorded up to this long AFTER the claim time still matches. */
export const PENDING_SPAWN_SKEW_MS = 5_000;

/**
 * Parent-link precedence. A link is replaced only by a source of equal or higher rank. `fork` is
 * highest: Claude Code's own fork record is ground truth, while a background fork's
 * `CC_PARENT_SESSION` comes from whichever session started Claude Code's background daemon.
 * src/sessions/repo.ts STORED_RANK is generated from this table.
 */
export const PARENT_LINK_RANK: Readonly<Record<ParentLinkSource, number>> = { fork: 4, env: 3, hook: 2, heuristic: 1 };

/**
 * What fork detection (src/sessions/fork.ts) learned about one session; Phase 2 stores it in the
 * cc_sessions fork columns (migration 0015). `cutOffset` is the byte offset of the fork's first
 * own record that carries a uuid: every reader skips uuid records before it and always reads
 * records without one. While the transcript holds only copied records the cut is not `final`, and
 * `cutOffset` is the end of the last complete line read, so a stored `fork_cut_offset` equal to
 * `transcript_offset` means the cut is still pending. `forkedAt` is the job's `forkBoundaryAt`,
 * else the latest timestamp among the copied records. `promptCount` counts the human prompts
 * among the copied records: the fork continues "after prompt N" of its parent.
 */
export interface ForkInfo {
  parentSessionId: string;
  detectedBy: ForkDetectedBy;
  cutOffset: number;
  final: boolean;
  forkedAt: Date | null;
  promptCount: number;
}

/** Inserts tried before ensureSession gives up on finding a free node id. */
export const NODE_ID_ATTEMPTS = 8;

/** `cc_sessions.prompts` is the excerpt list: the newest MAX_PROMPTS prompts, each clipped to MAX_PROMPT_CHARS (redacted first). */
export const MAX_PROMPTS = 100;
export const MAX_PROMPT_CHARS = 2000;
/**
 * Ceiling on one stored prompt (`cc_session_prompts.text`, UTF-16 code units). A longer prompt is cut
 * here and stored with `truncated = true`. Measured 2026-11-03: the largest typed prompt was 46 KB.
 */
export const MAX_PROMPT_STORE_CHARS = 256 * 1024;
/** At most this many pasted images are kept per prompt; later ones in the same paste are dropped. */
export const MAX_IMAGES_PER_PROMPT = 8;
/**
 * `cc_sessions.prompts_version` of a row whose transcript was gone when the prompts backfill
 * reached it: the stored excerpts, first and last prompt were redacted in place and
 * `cc_session_prompts` was rebuilt from those excerpts (≤ MAX_PROMPTS, each ≤ MAX_PROMPT_CHARS).
 * Nothing unredacted is left, but the full text is unrecoverable: never report such a row as
 * complete. Still a backfill candidate (below PROMPTS_VERSION): upgraded if the transcript is
 * readable again, otherwise skipped without a write.
 */
export const PROMPTS_VERSION_EXCERPTS = 1;
/**
 * `cc_sessions.prompts_version` of a row whose prompts are stored in full and redacted
 * (`cc_session_prompts` holds every prompt; the excerpts, first and last prompt are redacted).
 * 0 = written before that: truncated, unredacted excerpts only. The owning host's ingester brings
 * such rows up once (`SessionsRepo.replacePrompts`, or `redactStoredPrompts` to
 * PROMPTS_VERSION_EXCERPTS when the transcript is gone).
 *
 * 2 -> 3 (migration 0012, pasted-image support): a row below 3 may have pasted images sitting
 * un-extracted in its still-on-disk transcript, so the one-time backfill re-reads it once more
 * (cheap: `chat_images` dedupes by sha256) to collect them into `cc_session_prompt_images`. A row
 * whose transcript is gone cannot gain images either way and is simply redacted up to
 * PROMPTS_VERSION_EXCERPTS as before.
 */
export const PROMPTS_VERSION = 3;

/**
 * `cc_sessions.replies_version` of a row whose `cc_session_replies` were written by a read of its
 * transcript from byte 0 (the tail ingester's first read of a file, or the one-time backfill;
 * migration 0014). 0 = ingested before replies were stored: the owning host's prompts backfill
 * re-reads such a row once (`SessionsRepo.replacePrompts` writes prompts and replies together).
 * A row whose transcript is gone stays at 0 with no replies: Claude Code pruned the only copy.
 *
 * Its own counter rather than a PROMPTS_VERSION bump: `GET /api/sessions/:nodeId/prompts` reports a
 * row below PROMPTS_VERSION as `transcript_pruned`, so a bump would mislabel every complete row
 * whose transcript is gone, and every row of a host that has not upgraded yet (a UI change, R5).
 */
export const REPLIES_VERSION = 1;
export const MAX_TITLE_CHARS = 300;
export const MAX_COMMITS = 200;
export const MAX_FILES_EDITED = 500;
export const MAX_PLAN_DOCS = 100;
export const MAX_FINAL_MESSAGE_CHARS = 8000;

/**
 * Ceiling on one stored reply (`cc_session_replies.text`, UTF-16 code units), applied after
 * redaction; a longer reply is cut here and stored with `truncated = true`. Measured 2026-11-06
 * over 2511 replies: median 1.4k chars, p90 3.2k, max 20k.
 */
export const MAX_REPLY_STORE_CHARS = 16 * 1024;
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
  /**
   * Every human prompt of the read, full text (cut only at MAX_PROMPT_STORE_CHARS), not yet
   * redacted: SessionsRepo redacts before writing. Appended to `cc_session_prompts` (replacing it on
   * fromOffset 0); the excerpt list keeps the newest MAX_PROMPTS, each clipped to MAX_PROMPT_CHARS.
   */
  prompts?: PatchPrompt[];
  /**
   * Claude's reply to prompts of this read (each the assistant text after its turn's last
   * tool_use), raw: SessionsRepo redacts and caps them. `prompt` indexes `prompts`. Written to
   * `cc_session_replies` with that prompt's seq, in the same transaction as the prompts (the whole
   * list on fromOffset 0).
   */
  replies?: PatchReply[];
  /**
   * What this read does to the reply of the last prompt stored before it, when a turn straddles
   * two reads. Ignored on fromOffset 0.
   */
  leadingReply?: LeadingReply | null;
  /** Appended, deduped by sha, capped to the newest MAX_COMMITS. */
  commits?: SessionCommit[];
  /** Union, first-seen order, capped to MAX_FILES_EDITED. */
  filesEdited?: string[];
  /** Union, first-seen order, capped to MAX_PLAN_DOCS. */
  planDocs?: string[];
}

/** One image pasted on a prompt, as ingest read it from the transcript's base64 content block. */
export interface PatchPromptImage {
  mediaType: string;
  dataBase64: string;
  /** The `[Image #N]` Claude Code assigned, or the 1-based position in the prompt when absent. */
  pasteId: number;
}

/** One image already stored as a `chat_images` row (SessionsRepo.ingestPromptImages), linked to a prompt. */
export interface PromptImageLink {
  imageId: string;
  pasteId: number;
}

/** One human prompt as ingest read it. `truncated`: cut at MAX_PROMPT_STORE_CHARS (absent = false). */
export interface PatchPrompt {
  text: string;
  at: string | null;
  truncated?: boolean;
  /** Pasted images, in paste order, capped to MAX_IMAGES_PER_PROMPT. */
  images?: PatchPromptImage[];
}

/** Claude's reply to one prompt, as ingest read it: raw text, not redacted, not capped. */
export interface PatchReply {
  /** 0-based index of the prompt it answers in the same patch's `prompts`. */
  prompt: number;
  /** The turn's final text blocks, each trimmed, joined by a blank line. Never blank. */
  text: string;
  /** Timestamp of the record that holds the reply's last text block. */
  at: string | null;
}

/**
 * The reply to the session's last stored prompt, as a read that starts mid-turn sees it.
 * `append`: only assistant text came before this read's first prompt (or its end), so it continues
 * the stored reply. `replace`: a tool_use came first, so the stored reply was narration; `reply`
 * (the text after that tool_use) replaces it, and null deletes it.
 */
export type LeadingReply =
  | { kind: 'append'; text: string; at: string | null }
  | { kind: 'replace'; reply: { text: string; at: string | null } | null };

/** One `cc_session_replies` row's content, redacted and capped, as SessionsRepo writes it. */
export interface ReplyContent {
  text: string;
  at: Date | null;
  truncated: boolean;
}

/** A reply ready to write. `prompt` indexes the stored prompts (`storedPrompts`) it answers. */
export interface StoredReply extends ReplyContent {
  prompt: number;
}

/** A LeadingReply redacted. An `append` text is capped only once it is joined to the stored reply. */
export type StoredLeadingReply =
  | { kind: 'append'; text: string; at: Date | null }
  | { kind: 'replace'; reply: ReplyContent | null };

/** One `cc_session_prompts` row's content, redacted, as SessionsRepo writes it. */
export interface StoredPrompt {
  text: string;
  at: Date | null;
  truncated: boolean;
  /** Pasted images not yet ingested into `chat_images`; empty when the prompt carried none. */
  images: PatchPromptImage[];
}

/**
 * A row of this host below PROMPTS_VERSION (legacy, or redacted in place from excerpts) or below
 * REPLIES_VERSION (ingested before replies were stored).
 */
export interface PromptsBackfillCandidate {
  sessionId: string;
  transcriptPath: string | null;
  transcriptOffset: number;
  /** The row's prompts_version when listed: a gone transcript at PROMPTS_VERSION_EXCERPTS or above is skipped without a write. */
  promptsVersion: number;
}

/** The prompts (and replies) of a transcript re-read from byte 0 up to `upToOffset` (the row's stored offset). */
export interface PromptsReplacement {
  /** Must equal the stored transcript_offset when the write happens (compare-and-set). */
  upToOffset: number;
  prompts: PatchPrompt[];
  /** Claude's replies to `prompts` (`prompt` indexes it); they replace every stored reply of the session. */
  replies?: PatchReply[];
  /** First human prompt of the file; null keeps the stored one (redacted). */
  firstPrompt: string | null;
  /** Latest `last-prompt` record of the file; null keeps the stored one (redacted). */
  lastPrompt: string | null;
}

export type ReplacePromptsResult =
  | { status: 'applied' }
  | { status: 'offset_mismatch'; storedOffset: number }
  | { status: 'other_host' }
  | { status: 'missing' };

/** `current`: the row was already at PROMPTS_VERSION_EXCERPTS or above, nothing written. */
export type RedactStoredPromptsResult = 'applied' | 'current' | 'other_host' | 'missing';

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

/** What the ingester needs back from a transcript write. */
export type SessionRef = Pick<SessionRow, 'sessionId' | 'nodeId' | 'host' | 'transcriptOffset' | 'transcriptSize'>;

export type TranscriptUpsertResult =
  | { applied: true; row: SessionRef }
  | { applied: false; reason: 'offset_mismatch' | 'other_host'; storedOffset: number; row: SessionRef };

/**
 * One read of a subagent transcript (`<dir>/<session uuid>/subagents/agent-<id>.jsonl`). Same
 * offset rules as TranscriptPatch, against the subagent row's own offset. The deltas are added to
 * the subagent row and to its parent session's totals; `fromOffset === 0` replaces the subagent
 * row's values and takes its old ones back out of the parent first.
 */
export interface SubagentTranscriptPatch {
  /** The parent session. */
  sessionId: string;
  agentId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  size: number;
  /** Merged as the maximum with the parent's last_active_at. */
  lastActiveAt?: Date | null;
  tokens?: Partial<TokenCounts>;
  models?: Record<string, Partial<ModelUsage>>;
  /** Merged into the subagent row and the parent, deduped by sha. */
  commits?: SessionCommit[];
}

/** `no_session`: the parent has no row yet (or is not ingested at all); try again on a later pass. */
export type SubagentUpsertResult =
  | { applied: true }
  | { applied: false; reason: 'offset_mismatch' | 'other_host' | 'no_session'; storedOffset: number };

/** The subagent share of one session: what a re-read of its own transcript from byte 0 starts from. */
export interface SubagentTotals {
  tokens: TokenCounts;
  models: Record<string, ModelUsage>;
  commits: SessionCommit[];
}

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

/** A pending summary request (`cc_sessions.summary_requested_at`): when it was first made. */
export interface SummaryRequest {
  requestedAt: Date;
}

export interface SessionEmbeddingInput {
  sha: string;
  model: string;
  embedding: number[];
  /** Layout version of the embed text (src/sessions/summarize.ts SESSION_EMBED_TEXT_VERSION). */
  textVersion: number;
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
  /**
   * `config.dataDir`, so a prompt's pasted images can be stored as `chat_images`. Omitted: a
   * transcript patch's images are dropped (no table write, no file write), as for every
   * `SessionsRepo` built for something other than ingest (read models, hooks, resume, adversary).
   */
  dataDir?: string;
  /** `os.hostname()` of the machine ingesting, stamped on images it stores. Default os.hostname. */
  hostname?: () => string;
}

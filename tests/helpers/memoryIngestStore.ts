import type { IngestStore } from '../../src/sessions/ingest.js';
import {
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  nextLeadingReply,
  redactedPromptColumns,
  replacedPromptColumns,
  storedLeadingReply,
  storedPrompts,
  storedPromptsFromExcerpts,
  storedReplies,
  subtractModels,
} from '../../src/sessions/merge.js';
import {
  PARENT_LINK_RANK,
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  REPLIES_VERSION,
  type ForkCandidateRow,
  type ParentLinkSource,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type ReplyContent,
  type SessionRow,
  type SetParentResult,
  type StoredLeadingReply,
  type StoredPrompt,
  type StoredReply,
  type SubagentTotals,
  type SubagentTranscriptPatch,
  type SubagentUpsertResult,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from '../../src/sessions/types.js';

/** One `cc_subagent_transcripts` row, as the memory store keeps it. */
export interface MemorySubagentRow extends SubagentTotals {
  sessionId: string;
  host: string;
  offset: number;
}

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
    summaryRequestedAt: null,
    promptsVersion: 0,
    repliesVersion: 0,
    headUuid: null,
    forkCutOffset: null,
    forkedAt: null,
    forkPromptCount: null,
    forkDetectedBy: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/**
 * `SessionsRepo`'s ingest and prompts-backfill methods over Maps, with the repo's own merge (`mergeTranscriptPatch`,
 * `mergeModels`, `mergeCommits`) and its compare-and-set rules, so unit tests see the same row
 * values the database would hold. `patches` records every session call in order.
 */
export class MemoryIngestStore implements IngestStore {
  readonly rows = new Map<string, SessionRow>();
  readonly patches: TranscriptPatch[] = [];
  /** Subagent rows by transcript path. */
  readonly subagents = new Map<string, MemorySubagentRow>();
  /** `cc_session_prompts` by session id, in seq order. */
  readonly sidePrompts = new Map<string, StoredPrompt[]>();
  /** `cc_session_replies` by session id, then seq. */
  readonly sideReplies = new Map<string, Map<number, ReplyContent>>();

  async subagentOffsets(host: string): Promise<Map<string, number>> {
    return new Map([...this.subagents].filter(([, r]) => r.host === host).map(([file, r]) => [file, r.offset]));
  }

  async upsertFromSubagentTranscript(patch: SubagentTranscriptPatch): Promise<SubagentUpsertResult> {
    const parent = this.rows.get(patch.sessionId);
    const prev = this.subagents.get(patch.transcriptPath) ?? null;
    const storedOffset = prev?.offset ?? 0;
    if (!parent) return { applied: false, reason: 'no_session', storedOffset };
    if (parent.host !== patch.host) return { applied: false, reason: 'other_host', storedOffset };
    if (patch.fromOffset !== 0 && storedOffset !== patch.fromOffset) return { applied: false, reason: 'offset_mismatch', storedOffset };
    const old = patch.fromOffset === 0 ? prev : null;
    const base = old === null ? prev : null;
    const t = patch.tokens ?? {};
    const d = { inputTokens: t.inputTokens ?? 0, outputTokens: t.outputTokens ?? 0, cacheReadTokens: t.cacheReadTokens ?? 0, cacheWriteTokens: t.cacheWriteTokens ?? 0 };
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const bt = base?.tokens ?? zero;
    const ot = old?.tokens ?? zero;
    this.subagents.set(patch.transcriptPath, {
      sessionId: patch.sessionId,
      host: patch.host,
      offset: patch.toOffset,
      tokens: {
        inputTokens: bt.inputTokens + d.inputTokens,
        outputTokens: bt.outputTokens + d.outputTokens,
        cacheReadTokens: bt.cacheReadTokens + d.cacheReadTokens,
        cacheWriteTokens: bt.cacheWriteTokens + d.cacheWriteTokens,
      },
      models: mergeModels(base?.models ?? {}, patch.models, false),
      commits: mergeCommits(base?.commits ?? [], patch.commits, false),
    });
    this.rows.set(patch.sessionId, {
      ...parent,
      inputTokens: Math.max(0, parent.inputTokens - ot.inputTokens) + d.inputTokens,
      outputTokens: Math.max(0, parent.outputTokens - ot.outputTokens) + d.outputTokens,
      cacheReadTokens: Math.max(0, parent.cacheReadTokens - ot.cacheReadTokens) + d.cacheReadTokens,
      cacheWriteTokens: Math.max(0, parent.cacheWriteTokens - ot.cacheWriteTokens) + d.cacheWriteTokens,
      models: mergeModels(old === null ? parent.models : subtractModels(parent.models, old.models), patch.models, false),
      commits: mergeCommits(parent.commits, patch.commits, false),
      lastActiveAt: latest(parent.lastActiveAt, patch.lastActiveAt),
    });
    return { applied: true };
  }

  /** What the session's subagent rows add up to (the repo's `subagentTotals`). */
  subagentTotals(sessionId: string): SubagentTotals {
    const totals: SubagentTotals = { tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, models: {}, commits: [] };
    for (const r of this.subagents.values()) {
      if (r.sessionId !== sessionId) continue;
      totals.tokens.inputTokens += r.tokens.inputTokens;
      totals.tokens.outputTokens += r.tokens.outputTokens;
      totals.tokens.cacheReadTokens += r.tokens.cacheReadTokens;
      totals.tokens.cacheWriteTokens += r.tokens.cacheWriteTokens;
      totals.models = mergeModels(totals.models, r.models, false);
      totals.commits = mergeCommits(totals.commits, r.commits, false);
    }
    return totals;
  }

  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const out = new Map<string, TranscriptOffset>();
    for (const row of this.rows.values()) {
      if (row.host === host) {
        out.set(row.sessionId, { offset: row.transcriptOffset, size: row.transcriptSize, path: row.transcriptPath, forkCutOffset: row.forkCutOffset });
      }
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
    const reset = patch.fromOffset === 0;
    const fork = reset ? (patch.fork ?? null) : null;
    if (fork !== null && fork.parentSessionId !== patch.sessionId && !this.rows.has(fork.parentSessionId)) {
      this.rows.set(fork.parentSessionId, blankSessionRow(fork.parentSessionId, patch.host));
    }
    const subagents = reset ? this.subagentTotals(patch.sessionId) : null;
    const added = storedPrompts(patch.prompts);
    const before = reset ? [] : (this.sidePrompts.get(patch.sessionId) ?? []);
    this.writeReplies(
      patch.sessionId,
      before.length + 1,
      storedReplies(patch.prompts, patch.replies),
      reset ? null : storedLeadingReply(patch.leadingReply),
      reset,
    );
    this.sidePrompts.set(patch.sessionId, [...before, ...added]);
    const next: SessionRow = {
      ...row,
      ...mergeTranscriptPatch(row, patch, subagents),
      ...(reset ? { promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION } : {}),
    };
    this.rows.set(patch.sessionId, next);
    const forkLink = fork === null ? null : this.setParent(patch.sessionId, fork.parentSessionId, 'fork');
    return { applied: true, row: next, forkLink };
  }

  /** SessionsRepo.forkCandidates over the Map: same host and head, no descendants, none created later. */
  async forkCandidates(host: string, headUuid: string, excludeSessionId: string): Promise<ForkCandidateRow[]> {
    const descendants = new Set<string>();
    let frontier = [excludeSessionId];
    for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const r of this.rows.values()) {
        if (r.parentSessionId !== null && frontier.includes(r.parentSessionId) && !descendants.has(r.sessionId)) {
          descendants.add(r.sessionId);
          next.push(r.sessionId);
        }
      }
      frontier = next;
    }
    const selfCreated = (this.rows.get(excludeSessionId)?.createdAt ?? new Date()).getTime();
    return [...this.rows.values()].flatMap((r) =>
      r.host === host &&
      r.headUuid === headUuid &&
      r.sessionId !== excludeSessionId &&
      r.transcriptPath !== null &&
      !descendants.has(r.sessionId) &&
      r.createdAt.getTime() <= selfCreated
        ? [{ sessionId: r.sessionId, transcriptPath: r.transcriptPath, startedAt: r.startedAt, createdAt: r.createdAt, forkDetectedBy: r.forkDetectedBy }]
        : [],
    );
  }

  /** SessionsRepo.setParentIn over the Map: self and cycles refused, a better stored source kept. */
  setParent(childId: string, parentId: string, source: ParentLinkSource): SetParentResult {
    if (childId === parentId) return 'self';
    let id: string | null = parentId;
    for (let depth = 0; id !== null && depth <= 64; depth += 1) {
      if (id === childId) return 'cycle';
      id = this.rows.get(id)?.parentSessionId ?? null;
    }
    const child = this.rows.get(childId);
    if (child === undefined) return 'missing';
    const stored = child.parentLinkSource === null ? 0 : PARENT_LINK_RANK[child.parentLinkSource];
    if (stored > PARENT_LINK_RANK[source]) return 'kept';
    this.rows.set(childId, { ...child, parentSessionId: parentId, parentLinkSource: source });
    return 'set';
  }

  /** The repo's writeLeadingReply + writeReplyRows over a Map, with the same pure helpers. */
  private writeReplies(sessionId: string, first: number, replies: readonly StoredReply[], leading: StoredLeadingReply | null, replace: boolean): void {
    const map = replace ? new Map<number, ReplyContent>() : new Map(this.sideReplies.get(sessionId) ?? []);
    if (leading !== null && first > 1) {
      const next = nextLeadingReply(map.get(first - 1) ?? null, leading);
      if (next === null) map.delete(first - 1);
      else map.set(first - 1, next);
    }
    for (const r of replies) map.set(first + r.prompt, { text: r.text, at: r.at, truncated: r.truncated });
    this.sideReplies.set(sessionId, map);
  }

  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === host && (r.promptsVersion < PROMPTS_VERSION || r.repliesVersion < REPLIES_VERSION))
      .map((r) => ({
        sessionId: r.sessionId,
        transcriptPath: r.transcriptPath,
        transcriptOffset: r.transcriptOffset,
        promptsVersion: r.promptsVersion,
        forkCutOffset: r.forkCutOffset,
      }));
  }

  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return { status: 'missing' };
    if (row.host !== host) return { status: 'other_host' };
    if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
    this.sidePrompts.set(sessionId, storedPrompts(input.prompts));
    this.writeReplies(sessionId, 1, storedReplies(input.prompts, input.replies), null, true);
    this.rows.set(sessionId, { ...row, ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION });
    return { status: 'applied' };
  }

  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    const row = this.rows.get(sessionId);
    if (!row) return 'missing';
    if (row.host !== host) return 'other_host';
    if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
    this.sidePrompts.set(sessionId, storedPromptsFromExcerpts(row.prompts));
    this.sideReplies.delete(sessionId);
    this.rows.set(sessionId, { ...row, ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS });
    return 'applied';
  }

  /** A row a hook would have made before the transcript had any message (phase 5's upsertFromHook). */
  seedRow(sessionId: string, host: string, over: Partial<SessionRow> = {}): void {
    this.rows.set(sessionId, blankSessionRow(sessionId, host, over));
  }
}

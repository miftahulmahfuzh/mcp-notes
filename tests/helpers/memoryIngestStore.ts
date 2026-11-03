import type { IngestStore } from '../../src/sessions/ingest.js';
import { latest, mergeCommits, mergeModels, mergeTranscriptPatch, subtractModels } from '../../src/sessions/merge.js';
import type {
  SessionRow,
  SubagentTotals,
  SubagentTranscriptPatch,
  SubagentUpsertResult,
  TranscriptOffset,
  TranscriptPatch,
  TranscriptUpsertResult,
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
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/**
 * `SessionsRepo`'s ingest methods over Maps, with the repo's own merge (`mergeTranscriptPatch`,
 * `mergeModels`, `mergeCommits`) and its compare-and-set rules, so unit tests see the same row
 * values the database would hold. `patches` records every session call in order.
 */
export class MemoryIngestStore implements IngestStore {
  readonly rows = new Map<string, SessionRow>();
  readonly patches: TranscriptPatch[] = [];
  /** Subagent rows by transcript path. */
  readonly subagents = new Map<string, MemorySubagentRow>();

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
    const subagents = patch.fromOffset === 0 ? this.subagentTotals(patch.sessionId) : null;
    const next: SessionRow = { ...row, ...mergeTranscriptPatch(row, patch, subagents) };
    this.rows.set(patch.sessionId, next);
    return { applied: true, row: next };
  }

  /** A row a hook would have made before the transcript had any message (phase 5's upsertFromHook). */
  seedRow(sessionId: string, host: string, over: Partial<SessionRow> = {}): void {
    this.rows.set(sessionId, blankSessionRow(sessionId, host, over));
  }
}

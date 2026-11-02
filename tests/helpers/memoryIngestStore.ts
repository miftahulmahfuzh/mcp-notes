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

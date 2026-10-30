import type { EmbeddingStore } from '../../src/embeddings/backfill.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import type { PendingNote } from '../../src/embeddings/repo.js';
import { bodySha256, retryDelayMs } from '../../src/embeddings/state.js';

export interface MemoryEmbeddingRow {
  bodySha256: string;
  model: string;
  embedding: number[] | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
}

/** Phase 1's pending/save/failure rules over two maps. Listing order is insertion order. */
export class MemoryEmbeddingStore implements EmbeddingStore {
  readonly bodies = new Map<string, string>();
  readonly rows = new Map<string, MemoryEmbeddingRow>();
  listCalls = 0;
  /** When set, listPending throws it (a database outage). */
  failList: Error | null = null;
  now: () => number = () => Date.now();

  setBody(id: string, body: string): void {
    this.bodies.set(id, body);
  }

  isCurrent(id: string, model: string): boolean {
    const body = this.bodies.get(id);
    const row = this.rows.get(id);
    return (
      body !== undefined &&
      row !== undefined &&
      row.embedding !== null &&
      row.model === model &&
      row.bodySha256 === bodySha256(body)
    );
  }

  async listPending(opts: { model: string; limit: number; ignoreBackoff?: boolean }): Promise<PendingNote[]> {
    this.listCalls += 1;
    if (this.failList !== null) throw this.failList;
    const out: PendingNote[] = [];
    for (const [id, body] of this.bodies) {
      if (out.length >= opts.limit) break;
      if (body.trim() === '') continue;
      const sha = bodySha256(body);
      const row = this.rows.get(id);
      const pending =
        row === undefined ||
        row.bodySha256 !== sha ||
        row.model !== opts.model ||
        (row.embedding === null && (opts.ignoreBackoff === true || (row.nextAttemptAt ?? 0) <= this.now()));
      if (pending) out.push({ id, body, bodySha256: sha });
    }
    return out;
  }

  async saveEmbedding(v: { noteId: string; bodySha256: string; model: string; embedding: number[] }): Promise<boolean> {
    const body = this.bodies.get(v.noteId);
    if (body === undefined || bodySha256(body) !== v.bodySha256) return false;
    this.rows.set(v.noteId, {
      bodySha256: v.bodySha256,
      model: v.model,
      embedding: v.embedding,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    return true;
  }

  async recordFailure(v: { noteId: string; bodySha256: string; model: string; error: string }): Promise<void> {
    const prev = this.rows.get(v.noteId);
    const attempts = prev !== undefined && prev.bodySha256 === v.bodySha256 ? prev.attempts + 1 : 1;
    this.rows.set(v.noteId, {
      bodySha256: v.bodySha256,
      model: v.model,
      embedding: null,
      attempts,
      lastError: v.error.slice(0, 500),
      nextAttemptAt: this.now() + retryDelayMs(attempts),
    });
  }
}

/** A 3-wide embedder whose behaviour each test scripts. */
export class ScriptedEmbedder implements Embedder {
  readonly model = 'test/scripted';
  readonly dimensions = 3;
  readonly calls: string[][] = [];
  /** A call fails when any of its inputs matches. */
  failIf: ((input: string) => boolean) | null = null;
  /** When set, every call waits for it before answering. */
  gate: Promise<void> | null = null;
  /** Runs at the start of every call, before the gate. */
  onCall: ((inputs: readonly string[]) => void) | null = null;

  async embed(inputs: readonly string[]): Promise<number[][]> {
    this.calls.push([...inputs]);
    this.onCall?.(inputs);
    if (this.gate !== null) await this.gate;
    const failIf = this.failIf;
    if (failIf !== null && inputs.some((s) => failIf(s))) {
      throw new Error(`scripted failure on ${inputs.length} input(s)`);
    }
    return inputs.map((s) => [s.length, 1, 0]);
  }
}

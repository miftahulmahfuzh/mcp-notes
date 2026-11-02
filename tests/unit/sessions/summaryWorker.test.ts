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

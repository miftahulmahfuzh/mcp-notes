import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/embeddings/backfill.js';
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
  requestedAt: Date | null;
  embedding: { sha: string; model: string; vector: number[] } | null;
}

class MemoryStore implements SummaryStore {
  readonly rows = new Map<string, MemRow>();
  summarySaves = 0;
  embeddingSaves = 0;
  requestClears = 0;

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
      requestedAt: null,
      embedding: null,
      ...over,
    };
    this.rows.set(row.sessionId, row);
    return row;
  }

  private candidate(r: MemRow): SummaryCandidate {
    return {
      sessionId: r.sessionId,
      lastActiveAt: r.lastActiveAt,
      summarySha: r.summarySha,
      summarizedAt: r.summarizedAt,
      embeddingSha: r.embedding?.sha ?? null,
      embeddingModel: r.embedding?.model ?? null,
    };
  }

  async listIdle(o: Parameters<SummaryStore['listIdle']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === o.host && r.lastActiveAt < o.idleBefore)
      .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async listRequested(o: Parameters<SummaryStore['listRequested']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r): r is MemRow & { requestedAt: Date } => r.host === o.host && r.requestedAt !== null)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async load(ids: readonly string[]): Promise<SessionSummarySource[]> {
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r === undefined ? [] : [{ ...r }];
    });
  }

  /** Like SessionsRepo.setSummary: a saved summary also clears a pending request. */
  async saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void> {
    const r = this.rows.get(v.sessionId)!;
    r.summary = v.summary;
    r.summarySha = v.summarySha;
    r.summarizedAt = new Date();
    r.requestedAt = null;
    this.summarySaves += 1;
  }

  async saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[] }): Promise<void> {
    this.rows.get(v.sessionId)!.embedding = { sha: v.sha, model: v.model, vector: v.embedding };
    this.embeddingSaves += 1;
  }

  async clearRequest(sessionId: string): Promise<void> {
    this.rows.get(sessionId)!.requestedAt = null;
    this.requestClears += 1;
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

/** A clock whose sleep only advances time, so rate-limit waits are observable and instant. */
function fakeClock(): Clock & { slept: number[] } {
  let t = Date.now();
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

describe('summary requests', () => {
  it('summarizes a requested session that is live and not idle, and clears the request', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'live-now', nodeId: 'B1-22', lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer, liveSessionIds: async () => new Set(['live-now']) });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['live-now']);
    const row = store.rows.get('live-now')!;
    expect(row.summary).toMatch(/^Summary of Node: B1-22/);
    expect(row.requestedAt).toBeNull();
    await w.close();
  });

  it('serves requests before the idle backlog, oldest request first', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'idle', nodeId: 'C0-000' });
    store.add({ sessionId: 'asked-second', nodeId: 'D0-000', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 1_000) });
    store.add({ sessionId: 'asked-first', nodeId: 'E0-000', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 60_000) });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['asked-first', 'asked-second', 'idle']);
    await w.close();
  });

  it("never serves another host's request", async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'theirs', host: 'gpd', requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(0);
    expect(store.rows.get('theirs')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('a request on an up-to-date summary is answered by re-saving it, without a model call', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    const row = store.rows.get('s-1')!;
    row.requestedAt = new Date();
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    expect(row.requestedAt).toBeNull();
    expect(store.summarySaves).toBe(2);
    await w.close();
  });

  it('drops a request for a session with nothing to summarize', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'blank', prompts: [], firstPrompt: null, finalMessage: null, lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(0);
    expect(store.rows.get('blank')?.requestedAt).toBeNull();
    expect(store.requestClears).toBe(1);
    await w.close();
  });

  it('a failed request keeps the request and waits for its backoff', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1', lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    summarizer.failNext(1);
    const w = start(store, { summarizer });
    await w.idle();
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(1);
    expect(store.rows.get('s-1')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('requests respect the global pause after three failures in a row', async () => {
    const store = new MemoryStore();
    for (const id of ['r-1', 'r-2', 'r-3']) store.add({ sessionId: id, lastActiveAt: new Date(), requestedAt: new Date() });
    const summarizer = createFakeSummarizer();
    summarizer.failNext(3);
    const w = start(store, { summarizer });
    await w.idle();
    expect(summarizer.calls).toHaveLength(3);
    store.add({ sessionId: 'r-4', lastActiveAt: new Date(), requestedAt: new Date() });
    w.kick();
    await w.idle();
    expect(summarizer.calls).toHaveLength(3);
    expect(store.rows.get('r-4')?.requestedAt).not.toBeNull();
    await w.close();
  });

  it('requests go through the summary rate limiter', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 'r-1', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 2_000) });
    store.add({ sessionId: 'r-2', lastActiveAt: new Date(), requestedAt: new Date(Date.now() - 1_000) });
    const clock = fakeClock();
    const summarizer = createFakeSummarizer();
    const w = start(store, { summarizer, embedder: null, clock, minIntervalMs: 5_000 });
    await w.idle();
    expect(summarizer.calls.map((c) => c.sessionId)).toEqual(['r-1', 'r-2']);
    expect(clock.slept).toEqual([5_000]);
    await w.close();
  });

  it('without a summarizer a request waits (not cleared)', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1', lastActiveAt: new Date(), requestedAt: new Date() });
    const w = start(store, { summarizer: null });
    await w.idle();
    expect(store.rows.get('s-1')?.requestedAt).not.toBeNull();
    await w.close();
  });
});

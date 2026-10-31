import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { embedBackfill } from '../../src/cli/embedBackfill.js';
import { DEFAULT_CHAT_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { dbEmbeddingStore, runBackfill } from '../../src/embeddings/backfill.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import { bodySha256 } from '../../src/embeddings/state.js';
import { startEmbeddingWorker, type EmbeddingWorker } from '../../src/embeddings/worker.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import type { ImageMeta } from '../../src/notes/types.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
import { ChatService } from '../../src/chat/service.js';

interface Probe extends Embedder {
  inputs: string[][];
  failIf: ((input: string) => boolean) | null;
  delayMs: number;
}

function probe(inner: Embedder = createFakeEmbedder()): Probe {
  const p: Probe = {
    model: inner.model,
    dimensions: inner.dimensions,
    inputs: [],
    failIf: null,
    delayMs: 0,
    async embed(inputs, opts) {
      p.inputs.push([...inputs]);
      if (p.delayMs > 0) await new Promise((r) => setTimeout(r, p.delayMs));
      const failIf = p.failIf;
      if (failIf !== null && inputs.some((s) => failIf(s))) throw new Error('probe: embedding refused');
      return inner.embed(inputs, opts);
    },
  };
  return p;
}

// A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
type EmbRow = {
  body_sha256: string;
  model: string;
  has_vector: boolean;
  attempts: number;
  last_error: string | null;
  due: boolean;
};

let db: Db;
let dataDir: string;
let worker: EmbeddingWorker | null = null;

async function embRow(id: string): Promise<EmbRow | null> {
  const res = await db.execute<EmbRow>(sql`
    select body_sha256, model, embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_embeddings where note_id = ${id}
  `);
  return res.rows[0] ?? null;
}

async function expectCurrent(id: string, body: string, model: string): Promise<void> {
  expect(await embRow(id)).toMatchObject({ body_sha256: bodySha256(body), model, has_vector: true, attempts: 0 });
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function imageMeta(): ImageMeta {
  return {
    sha256: randomBytes(32).toString('hex'),
    mime: 'image/jpeg',
    width: 10,
    height: 10,
    bytes: 100,
    taken_at: null,
    original_name: 'x.jpg',
    host: 'test-host',
  };
}

function config(apiKey: string | null): Config {
  return {
    databaseUrl: testDatabaseUrl(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: { apiKey },
  };
}

/** A service whose writes nobody listens to (notes written "before" the worker or by the other laptop). */
function quietService(): NotesService {
  return new NotesService({ db, dataDir, events: new NoteEvents() });
}

function rig(sweepMs = 3_600_000): { notes: NotesService; embedder: Probe; logs: string[]; worker: EmbeddingWorker } {
  const events = new NoteEvents();
  const notes = new NotesService({ db, dataDir, events });
  const embedder = probe();
  const logs: string[] = [];
  worker = startEmbeddingWorker({
    store: dbEmbeddingStore(db),
    events,
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs,
    log: (line) => logs.push(line),
  });
  return { notes, embedder, logs, worker };
}

beforeAll(async () => {
  db = openTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-emb-'));
});

afterAll(async () => {
  await closeTestDb(db);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(async () => {
  await worker?.close();
  worker = null;
});

describe('embedding worker against Postgres', () => {
  it('create, update, append and revert each end with a current vector', async () => {
    const { notes, embedder, logs, worker: w } = rig();
    await w.idle();
    expect(logs).toEqual([]);

    const a = await notes.create({ body: 'arango root password is in the vault #ops' });
    await w.idle();
    await expectCurrent(a.id, a.body, embedder.model);

    const u = await notes.update(a.id, 'arango root password moved to the team vault');
    await w.idle();
    await expectCurrent(a.id, u.body, embedder.model);

    const ap = await notes.append(a.id, 'rotated on friday');
    await w.idle();
    await expectCurrent(a.id, ap.body, embedder.model);

    const original = (await notes.revisions(a.id)).find((r) => r.body === a.body);
    expect(original).toBeDefined();
    const rv = await notes.revert(a.id, original!.revision);
    expect(rv.body).toBe(a.body);
    await w.idle();
    await expectCurrent(a.id, rv.body, embedder.model);

    expect(embedder.inputs).toHaveLength(4);
    expect(logs).toHaveLength(4);
  });

  it('embeds an image note by its text and leaves a textless photo alone', async () => {
    const { notes, embedder, worker: w } = rig();
    const withText = await notes.create({
      body: 'whiteboard of the arango cluster layout',
      allowEmpty: true,
      image: { path: 'images/2026/10/t1.jpg', meta: imageMeta() },
    });
    const bare = await notes.create({
      body: '',
      allowEmpty: true,
      image: { path: 'images/2026/10/t2.jpg', meta: imageMeta() },
    });
    await w.idle();
    await expectCurrent(withText.id, withText.body, embedder.model);
    expect(await embRow(bare.id)).toBeNull();
    expect(embedder.inputs.flat()).toEqual(['whiteboard of the arango cluster layout']);
  });

  it('a failing embedder never fails the write; the note is marked and retried after backoff', async () => {
    const { notes, embedder, logs, worker: w } = rig();
    await w.idle();
    embedder.failIf = () => true;

    const n = await notes.create({ body: 'the login broke after the laptop slept' });
    expect((await notes.getOne(n.id))?.body).toBe(n.body);
    await w.idle();

    const failed = await embRow(n.id);
    expect(failed).toMatchObject({ body_sha256: bodySha256(n.body), has_vector: false, attempts: 1, due: false });
    expect(failed?.last_error).toMatch(/refused/);
    expect(logs.some((l) => l.includes(n.id) && l.includes('1 failed'))).toBe(true);

    embedder.failIf = null;
    const callsAfterFailure = embedder.inputs.length;
    w.kick();
    await w.idle();
    expect(embedder.inputs.length).toBe(callsAfterFailure);

    await db.execute(sql`update note_embeddings set next_attempt_at = now() - interval '1 second' where note_id = ${n.id}`);
    w.kick();
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('an edit after a failure is embedded at once (the body changed since the failure)', async () => {
    const { notes, embedder, worker: w } = rig();
    embedder.failIf = () => true;
    const n = await notes.create({ body: 'auth failures after resume' });
    await w.idle();
    expect(await embRow(n.id)).toMatchObject({ has_vector: false, due: false });

    embedder.failIf = null;
    const u = await notes.update(n.id, 'auth failures after resume, fixed by restarting the agent');
    await w.idle();
    await expectCurrent(n.id, u.body, embedder.model);
  });

  it('a slow embedder does not slow a write', async () => {
    const { notes, embedder, worker: w } = rig();
    await w.idle();
    embedder.delayMs = 1500;
    const t0 = Date.now();
    const n = await notes.create({ body: 'written while the embedder is slow' });
    expect(Date.now() - t0).toBeLessThan(500);
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('an idle worker makes no call and logs nothing', async () => {
    const { embedder, logs } = rig(20);
    await new Promise((r) => setTimeout(r, 150));
    expect(embedder.inputs).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('picks up writes it got no event for (the other laptop) on the sweep', async () => {
    const other = quietService();
    const { embedder } = rig(50);
    const n = await other.create({ body: 'written on the GPD' });
    await until(async () => (await embRow(n.id))?.has_vector === true);
    await expectCurrent(n.id, n.body, embedder.model);
  });

  it('keeps a deleted note\'s vector, embeds a note deleted before it was embedded, and restore makes no call', async () => {
    const early = await quietService().create({ body: 'deleted before any embedding' });
    await quietService().delete(early.id);

    const { notes, embedder, worker: w } = rig();
    await w.idle();
    await expectCurrent(early.id, early.body, embedder.model);

    const n = await notes.create({ body: 'kept through delete and restore' });
    await w.idle();
    const calls = embedder.inputs.length;

    await notes.delete(n.id);
    await w.idle();
    await expectCurrent(n.id, n.body, embedder.model);

    await notes.restore(n.id);
    await notes.restore(early.id);
    w.kick();
    await w.idle();
    expect(embedder.inputs.length).toBe(calls);
    await expectCurrent(n.id, n.body, embedder.model);
    await expectCurrent(early.id, early.body, embedder.model);
  });
});

describe('runBackfill against Postgres', () => {
  it('a backfill stopped mid-way resumes without re-embedding finished notes', async () => {
    const notes = quietService();
    const created: Array<{ id: string; body: string }> = [];
    for (let i = 0; i < 40; i += 1) {
      const n = await notes.create({ body: `backfill note ${i} about topic ${i % 7}` });
      created.push({ id: n.id, body: n.body });
    }
    const embedder = probe();
    const store = dbEmbeddingStore(db);
    const stop = new AbortController();
    const first = await runBackfill({
      store,
      embedder,
      batchSize: 16,
      minIntervalMs: 0,
      signal: stop.signal,
      onBatch: () => stop.abort(),
    });
    expect(first).toMatchObject({ aborted: true, embedded: 16, failed: 0 });

    const second = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(second).toMatchObject({ aborted: false, embedded: 24, failed: 0 });

    const sent = embedder.inputs.flat();
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    for (const n of created) await expectCurrent(n.id, n.body, embedder.model);

    const third = await runBackfill({ store, embedder, batchSize: 16, minIntervalMs: 0 });
    expect(third.calls).toBe(0);
  });
});

describe('startBackground', () => {
  function deps(embedder: Embedder | null): AppDeps {
    const events = new NoteEvents();
    return {
      config: config(null),
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder,
      imageEmbedder: null,
      chat: new ChatService({ db }),
    };
  }

  it('runs the worker when an embedder is configured and stops it on shutdown', async () => {
    const embedder = probe();
    const d = deps(embedder);
    const stop = await startBackground(d);
    try {
      const n = await d.service.create({ body: 'from the daemon path' });
      await until(async () => (await embRow(n.id))?.has_vector === true);
      await expectCurrent(n.id, n.body, embedder.model);
    } finally {
      await stop();
    }
  });

  it('logs once and embeds nothing without an embedder', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps(null);
    const stop = await startBackground(d);
    try {
      const n = await d.service.create({ body: 'no key, no vector' });
      await new Promise((r) => setTimeout(r, 200));
      expect(await embRow(n.id)).toBeNull();
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('embeddings off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
    }
  });
});

describe('npm run embed:backfill', () => {
  function cli(embedder: Probe, out: string[], err: string[], closed: { n: number }) {
    return {
      loadConfig: () => config('test-key'),
      createDb: () => openTestDb(),
      closeDb: async (d: Db) => {
        closed.n += 1;
        await closeTestDb(d);
      },
      createEmbedder: (key: string) => {
        expect(key).toBe('test-key');
        return embedder;
      },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      minIntervalMs: 0,
    };
  }

  it('prints progress, finishes, and closes the database', async () => {
    const notes = quietService();
    for (let i = 0; i < 20; i += 1) await notes.create({ body: `cli note ${i}` });
    const embedder = probe();
    const out: string[] = [];
    const err: string[] = [];
    const closed = { n: 0 };
    const code = await embedBackfill([], cli(embedder, out, err, closed));
    expect(code).toBe(0);
    expect(closed.n).toBe(1);
    expect(out[0]).toMatch(/20 pending/);
    expect(out).toContain('embedded 16/20, failed 0');
    expect(out).toContain('embedded 20/20, failed 0');
    expect(out.at(-1)).toBe('done: embedded 20, failed 0; 0 pending');
    expect(err).toEqual([]);
  });

  it('--retry-failed retries a failed note without waiting for its backoff', async () => {
    const n = await quietService().create({ body: 'flaky note' });
    const failing = probe();
    failing.failIf = () => true;
    await runBackfill({ store: dbEmbeddingStore(db), embedder: failing, minIntervalMs: 0 });
    expect(await embRow(n.id)).toMatchObject({ has_vector: false, due: false });

    const healthy = probe();
    const out1: string[] = [];
    expect(await embedBackfill([], cli(healthy, out1, [], { n: 0 }))).toBe(0);
    expect(healthy.inputs).toEqual([]);
    expect(out1.join('\n')).toMatch(/--retry-failed/);

    const stillFailing = probe();
    stillFailing.failIf = () => true;
    const err2: string[] = [];
    expect(await embedBackfill(['--retry-failed'], cli(stillFailing, [], err2, { n: 0 }))).toBe(1);
    expect(err2).toEqual([`failed ${n.id}: probe: embedding refused`]);

    const out3: string[] = [];
    expect(await embedBackfill(['--retry-failed'], cli(healthy, out3, [], { n: 0 }))).toBe(0);
    await expectCurrent(n.id, 'flaky note', healthy.model);
  });
});

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { BLEND, type BlendTuning } from '../../src/search/blend.js';
import { QueryVectorCache } from '../../src/search/queryVector.js';
import { searchSessions, type SessionSearchPage } from '../../src/sessions/search.js';
import {
  LABELLED_SESSIONS,
  LABELLED_SESSION_QUERIES,
  SESSION_LEXICON,
  SESSION_STOPWORDS,
  type LabelledSessionQuery,
} from '../fixtures/semantic/sessionsLabelled.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
const NOW = new Date('2026-11-01T00:00:00.000Z');
let db: Db;
let embedder: FakeEmbedder;

const sessionId = (key: string): string => `lab-${key}`;
const daysBefore = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function seed(): Promise<void> {
  for (const [i, s] of LABELLED_SESSIONS.entries()) {
    const id = sessionId(s.key);
    const last = daysBefore(s.ageDays);
    const started = daysBefore(s.ageDays + 1 / 24);
    await db.execute(sql`
      insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, last_prompt, prompts, summary,
        started_at, last_active_at, created_at, updated_at)
      values (${id}, ${`L${i}-0${i}`}, ${HOST}, 'mcp-notes', '/tmp', null, ${s.prompts[0] ?? null}, ${s.prompts[s.prompts.length - 1] ?? null},
        ${JSON.stringify(s.prompts.map((text) => ({ text, at: null })))}::jsonb, ${s.summary},
        ${started}::timestamptz, ${last}::timestamptz, ${last}::timestamptz, ${last}::timestamptz)
    `);
    await db.execute(sql`
      insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
      values (${id}, 'sha', ${embedder.model}, ${toVectorLiteral(embedder.vectorFor(s.summary))}::vector,
        ${last}::timestamptz, ${last}::timestamptz, ${last}::timestamptz)
    `);
    for (const [n, text] of s.replies.entries()) {
      const seq = n + 1;
      await db.execute(sql`
        insert into cc_session_prompts (session_id, seq, at, text, truncated)
        values (${id}, ${seq}, ${last}::timestamptz, ${s.prompts[n] ?? 'go on'}, false)
      `);
      await db.execute(sql`
        insert into cc_session_replies (session_id, seq, at, text, truncated)
        values (${id}, ${seq}, ${last}::timestamptz, ${text}, false)
      `);
      await db.execute(sql`
        insert into cc_session_reply_embeddings (session_id, seq, sha, model, embedding, embedded_at, updated_at)
        values (${id}, ${seq}, encode(sha256(convert_to(${text}, 'UTF8')), 'hex'), ${embedder.model},
          ${toVectorLiteral(embedder.vectorFor(text))}::vector, ${last}::timestamptz, ${last}::timestamptz)
      `);
    }
  }
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder({ lexicon: SESSION_LEXICON, stopwords: SESSION_STOPWORDS });
  await truncateAll(db);
  await seed();
});

afterAll(async () => {
  await truncateAll(db);
  await closeTestDb(db);
});

async function search(query: string, tuning: BlendTuning = BLEND): Promise<SessionSearchPage> {
  return searchSessions({ db, embedder, host: HOST, queryVectors: new QueryVectorCache() }, query, {}, { now: NOW, tuning });
}

/** Labelled queries whose answer does not rank first under `tuning`. */
async function failures(tuning: BlendTuning): Promise<LabelledSessionQuery[]> {
  const out: LabelledSessionQuery[] = [];
  for (const q of LABELLED_SESSION_QUERIES) {
    const page = await search(q.query, tuning);
    if (page.sessions[0]?.session_id !== sessionId(q.answer)) out.push(q);
  }
  return out;
}

describe('BLEND.related on the labelled sessions (hybrid; real ts_rank, fake vectors)', () => {
  it('ranks every query\'s answer first with BLEND as shipped', async () => {
    expect((await failures(BLEND)).map((q) => q.query)).toEqual([]);
  });

  it('without a discount (related = 1) a chatty reply beats a session whose own summary answers', async () => {
    const failed = await failures({ ...BLEND, related: 1 });
    expect(failed.filter((q) => q.kind === 'over-match').length).toBeGreaterThan(0);
  });

  it('with too strong a discount (related = 0.3) the only session whose reply answers is buried', async () => {
    const failed = await failures({ ...BLEND, related: 0.3 });
    expect(failed.filter((q) => q.kind === 'reply-only').length).toBeGreaterThan(0);
  });

  it('BLEND.related sits strictly inside one contiguous passing range', async () => {
    const passing: number[] = [];
    for (let i = 0; i <= 20; i += 1) {
      const related = i / 20;
      if ((await failures({ ...BLEND, related })).length === 0) passing.push(i);
    }
    expect(passing.length, 'no value of related passes every labelled query').toBeGreaterThan(0);
    const lo = passing[0]!;
    const hi = passing[passing.length - 1]!;
    expect(passing, `passing related values (x/20): ${passing.join(', ')}`).toEqual(
      Array.from({ length: hi - lo + 1 }, (_, k) => lo + k),
    );
    expect(BLEND.related).toBeGreaterThan(lo / 20);
    expect(BLEND.related).toBeLessThan(hi / 20);
  });

  it('lists the replies a hit matched through, with the passage around the match', async () => {
    const quokka = await search('quokka');
    expect(quokka.sessions[0]?.session_id).toBe(sessionId('quokka-reply'));
    expect(quokka.sessions[0]?.via_replies).toEqual([{ seq: 1, excerpt: expect.stringContaining('quokka') }]);

    const wifi = await search('connection problems after waking the laptop');
    expect(wifi.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);

    const photo = await search('photo delete');
    expect(photo.sessions[0]?.session_id).toBe(sessionId('photo-own'));
    expect(photo.sessions[0]?.via_replies).toEqual([]);
    expect(photo.sessions.find((s) => s.session_id === sessionId('photo-chatty'))?.via_replies.map((r) => r.seq)).toEqual([1]);

    const scorecard = await search('adversarial zero trades');
    const chatty = scorecard.sessions.find((s) => s.session_id === sessionId('adv-scorecard'));
    expect(chatty?.via_replies.length).toBe(3);
    expect(chatty?.via_replies.every((r) => /trades/i.test(r.excerpt))).toBe(true);
  });
});

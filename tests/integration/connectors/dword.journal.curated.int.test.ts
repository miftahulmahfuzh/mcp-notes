import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnector } from '../../../src/connectors/connector.js';
import type { Connector } from '../../../src/connectors/types.js';
import { DwordWriter } from '../../../src/dword/writer.js';
import { normShaFor, textShaFor } from '../../../src/dword/journalSimilarity.js';
import { registerDwordJournalCurated, type JournalDuplicateResult, type JournalMatchEntry } from '../../../src/mcp/dwordJournalTools.js';
import { createFakeEmbedder, type FakeEmbedder } from '../../../tests/helpers/fakeEmbedder.js';
import { describeWithRepo, seedSystem, systemDbUrl, truncateSystem } from './harness.js';

const OWNER_EMAIL = 'journal-int@example.test';
const OWNER_ID = randomUUID();

async function seedOwner(): Promise<void> {
  await truncateSystem('dword');
  await seedSystem('dword', 'INSERT INTO users (id, email) VALUES ($1, $2)', [OWNER_ID, OWNER_EMAIL]);
}

/** A temp daily-words repo dir whose .env.local points at the harness's throwaway Postgres. Used by both the connector and the writer, so they share one database. */
function dwordRepoDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-dword-journal-'));
  writeFileSync(path.join(dir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('dword')}\n`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function text(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function connect(connector: Connector, writer: DwordWriter, embedder: FakeEmbedder | null): Promise<Client> {
  const server = new McpServer({ name: 'dword-journal-int', version: '0.0.0' });
  registerDwordJournalCurated(server, connector, { writer, embedder, userEmail: () => OWNER_EMAIL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dword-journal-int-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describeWithRepo('dword', 'dword journal curated tools', () => {
  let repo: { dir: string; cleanup: () => void };
  let connector: Connector;
  let writer: DwordWriter;
  let embedder: FakeEmbedder;
  let client: Client;

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(text(result));
    return JSON.parse(text(result)) as T;
  }

  beforeAll(async () => {
    repo = dwordRepoDir();
  });

  afterAll(async () => {
    repo.cleanup();
  });

  beforeEach(async () => {
    await seedOwner();
    connector = createConnector('dword', { repoDir: repo.dir, settings: { envFile: false } });
    // userEmail is a required DwordWriterOptions field (phase 2's actual shape) — passed explicitly
    // here rather than via process.env.DWORD_USER_EMAIL, matching how registerDwordJournalCurated's
    // own userEmail override is threaded through `connect()` below, with no global state.
    writer = new DwordWriter({ repoDir: () => repo.dir, userEmail: () => OWNER_EMAIL });
    embedder = createFakeEmbedder();
    client = await connect(connector, writer, embedder);
  });

  afterEach(async () => {
    await client.close();
  });

  it('dword_journal_find_similar reports none when the journal is empty', async () => {
    const out = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: 'the early bird catches the worm, every single morning without fail',
    });
    expect(out.verdict).toBe('none');
    expect(out.entries).toEqual([]);
  });

  it('dword_journal_find_similar finds an exact norm_sha match (Layer 1)', async () => {
    const original = 'Nothing to be done.';
    const entryId = randomUUID();
    await seedSystem(
      'dword',
      'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)',
      [entryId, OWNER_ID, original],
    );
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    // Different whitespace, same normalized text -> Layer 1 hit, no embedding call made.
    const out = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: '  Nothing   to be\ndone. ',
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.id).toBe(entryId);
    expect(embedder.calls).toHaveLength(0);
  });

  it('dword_journal_add with no duplicate inserts both the entry and its embedding', async () => {
    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; entry: JournalMatchEntry }>(
      'dword_journal_add',
      {
        text: 'the squeaky wheel gets the grease when nobody else speaks up first',
        insight: {
          meaning: 'The person who complains or asks loudest is the one who gets attention or help.',
          whenItApplies: [
            'Asking your manager directly for a raise instead of waiting to be noticed',
            'Flagging a bug repeatedly until it gets fixed',
          ],
        },
      },
    );
    expect(out.verdict).toBe('none');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(true);
    expect(out.entry.insight_status).toBe('ready');

    // Readback proves BOTH rows landed: Layer 1's SQL joins journal_entries to
    // journal_entry_embeddings and requires a matching text_sha/norm_sha, so it can only find
    // this entry if the embeddings insert also succeeded.
    const check = await call<JournalDuplicateResult>('dword_journal_find_similar', {
      text: 'the squeaky wheel gets the grease when nobody else speaks up first',
    });
    expect(check.verdict).toBe('duplicate');
    expect(check.entries[0]?.id).toBe(out.entry.id);
  });

  it('dword_journal_add with a duplicate and no force inserts nothing', async () => {
    const original = 'time heals all wounds';
    const entryId = randomUUID();
    await seedSystem('dword', 'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)', [entryId, OWNER_ID, original]);
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    const out = await call<{ verdict: string; inserted: boolean; entries: JournalMatchEntry[] }>('dword_journal_add', {
      text: 'time heals all wounds',
      insight: {
        meaning: 'Painful feelings fade and become easier to bear as time passes.',
        whenItApplies: ['Grieving the end of a long relationship', 'Getting over a humiliating mistake at work'],
      },
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.inserted).toBe(false);
    expect(out.entries[0]?.id).toBe(entryId);
  });

  it('dword_journal_add with a duplicate and force=true inserts anyway, with no embedding row', async () => {
    const original = 'actions speak louder than words';
    const entryId = randomUUID();
    await seedSystem('dword', 'INSERT INTO journal_entries (id, user_id, text) VALUES ($1, $2, $3)', [entryId, OWNER_ID, original]);
    await seedSystem(
      'dword',
      "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha) VALUES ($1, $2, 'failed', $3, $4)",
      [entryId, OWNER_ID, textShaFor(original), normShaFor(original)],
    );

    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; entry: JournalMatchEntry }>('dword_journal_add', {
      text: original,
      force: true,
      insight: {
        meaning: 'What someone does matters more than what they say they will do.',
        whenItApplies: ['A friend who promises to help you move but never shows up', 'A company that advertises values it does not practice'],
      },
    });
    expect(out.verdict).toBe('duplicate');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(false); // Layer 1 hit never computes a vector, forced or not
    expect(out.entry.id).not.toBe(entryId);
  });

  it('dword_journal_add still inserts the entry when the embedding call fails, with no embeddings row', async () => {
    embedder.failNext(1);
    const out = await call<{ verdict: string; inserted: boolean; embedded: boolean; layer2_skipped?: true }>('dword_journal_add', {
      text: 'a watched pot never boils, no matter how long you stare at it',
      insight: {
        meaning: 'Time feels like it passes more slowly when you are anxiously waiting for something.',
        whenItApplies: ['Refreshing your inbox while waiting for a job offer email', 'Standing by the microwave counting down the seconds'],
      },
    });
    expect(out.verdict).toBe('none');
    expect(out.inserted).toBe(true);
    expect(out.embedded).toBe(false);
    expect(out.layer2_skipped).toBe(true);
  });
});

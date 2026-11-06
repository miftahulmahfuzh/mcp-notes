import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerDwordVocabCurated } from '../../../src/mcp/dwordVocabTools.js';
import type { Connector } from '../../../src/connectors/types.js';
import { DwordWriter } from '../../../src/dword/writer.js';
import { cleanupHarness, connectorFor, describeWithRepo, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

const VOCAB_EMAIL = 'vocab-test@example.test';
const VOCAB_USER_ID = randomUUID();
const LIMIT_EMAIL = 'vocab-limit-test@example.test';
const LIMIT_USER_ID = randomUUID();

const GENTEEL_ID = randomUUID();
const SMEAR_ID = randomUUID();
const MELUMURI_ID = randomUUID();

async function seed(): Promise<void> {
  await truncateSystem('dword');
  await withAdmin(systemDbUrl('dword'), async (db) => {
    await db.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [VOCAB_USER_ID, VOCAB_EMAIL, LIMIT_USER_ID, LIMIT_EMAIL]);

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status)
       VALUES ($1, $2, 'Genteel', 'manual', 'active', 'adjective', 'jen-TEEL', 'polite in a refined way',
               '["She had a genteel manner.","The genteel part of town.","He spoke with genteel calm."]'::jsonb, 'ready')`,
      [GENTEEL_ID, VOCAB_USER_ID],
    );

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status)
       VALUES ($1, $2, 'Smear', 'manual', 'active', 'verb', 'smeer', 'to spread a substance across a surface',
               '["He tried to smear paint on the wall.","Do not smear the ink.","The chef smeared sauce on the plate."]'::jsonb, 'ready')`,
      [SMEAR_ID, VOCAB_USER_ID],
    );

    await db.query(
      `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status,
               origin_term, origin_language, origin_context)
       VALUES ($1, $2, 'Smudge', 'manual', 'active', 'verb', 'smuhj', 'to spread or rub dirt, making a mark',
               '["The pencil left a smudge.","He smudged the chalk line.","A smudge of ink on the page."]'::jsonb, 'ready',
               'melumuri', 'Indonesian', NULL)`,
      [MELUMURI_ID, VOCAB_USER_ID],
    );

    for (let i = 0; i < 50; i++) {
      await db.query(
        `INSERT INTO vocab_entries (id, user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status, created_at)
         VALUES ($1, $2, $3, 'manual', 'active', 'noun', 'x', 'x', '["x","x","x"]'::jsonb, 'ready', now())`,
        [randomUUID(), LIMIT_USER_ID, `limit-word-${i}`],
      );
    }
  });
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

/** Writes go to the Docker connectors_dword database through a temp repo dir, never DAILY_WORDS_DIR. */
let writerRepoDir: string;

async function connect(connector: Connector, email: string): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'dword-vocab-curated-int', version: '0.0.0' });
  const writer = new DwordWriter({ repoDir: () => writerRepoDir, userEmail: () => email });
  registerDwordVocabCurated(server, connector, { userEmail: () => email, writer });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dword-vocab-curated-int-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describeWithRepo('dword', 'dword vocab curated tools', () => {
  let client: Client;
  let server: McpServer;
  let limitClient: Client;
  let limitServer: McpServer;

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(textOf(result));
    return JSON.parse(textOf(result)) as T;
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  beforeAll(async () => {
    await seed();
    writerRepoDir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-dword-vocab-'));
    writeFileSync(path.join(writerRepoDir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('dword')}\n`);
    const connector = connectorFor('dword');
    ({ client, server } = await connect(connector, VOCAB_EMAIL));
    ({ client: limitClient, server: limitServer } = await connect(connector, LIMIT_EMAIL));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await limitClient?.close();
    await limitServer?.close();
    if (writerRepoDir) rmSync(writerRepoDir, { recursive: true, force: true });
    cleanupHarness();
  });

  it('dword_vocab_lookup: exact term hit returns the full row', async () => {
    const out = await call<{ found: boolean; entry?: { id: string; definition: string | null } }>('dword_vocab_lookup', { term: 'genteel' });
    expect(out.found).toBe(true);
    expect(out.entry?.id).toBe(GENTEEL_ID);
    expect(out.entry?.definition).toBe('polite in a refined way');
  });

  it('dword_vocab_lookup: origin_term match finds the row by its original non-English word', async () => {
    const out = await call<{ found: boolean; entry?: { id: string } }>('dword_vocab_lookup', { term: 'melumuri' });
    expect(out.found).toBe(true);
    expect(out.entry?.id).toBe(MELUMURI_ID);
  });

  it('dword_vocab_lookup: an unrelated word is a miss with no candidates', async () => {
    const out = await call<{ found: boolean; candidates?: unknown[] }>('dword_vocab_lookup', { term: 'xenophobia' });
    expect(out.found).toBe(false);
    expect(out.candidates ?? []).toEqual([]);
  });

  it('dword_vocab_add: a brand-new term is created and then found by lookup', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { id: string; term: string } }>('dword_vocab_add', {
      term: 'lucent',
      part_of_speech: 'adjective',
      pronunciation: 'LOO-suhnt',
      definition: 'giving off light; shining',
      examples: ['The lucent moon.', 'Her lucent eyes.', 'A lucent glow filled the room.'],
    });
    expect(out.created).toBe(true);
    expect(out.origin_attached).toBe(false);
    expect(out.entry.term).toBe('lucent');

    const found = await call<{ found: boolean; entry?: { id: string } }>('dword_vocab_lookup', { term: 'Lucent' });
    expect(found.found).toBe(true);
    expect(found.entry?.id).toBe(out.entry.id);
  });

  it('dword_vocab_add: an existing term (different case) returns the existing row, no new row', async () => {
    const out = await call<{ created: boolean; entry: { id: string; definition: string | null } }>('dword_vocab_add', {
      term: 'GENTEEL',
      part_of_speech: 'noun',
      pronunciation: 'x',
      definition: 'a different definition that must not overwrite the existing one',
      examples: ['x', 'x', 'x'],
    });
    expect(out.created).toBe(false);
    expect(out.entry.id).toBe(GENTEEL_ID);
    expect(out.entry.definition).toBe('polite in a refined way');
  });

  it('dword_vocab_add: a context on a term with no prior origin attaches origin (5.7)', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { origin_term: string | null; origin_language: string | null; origin_context: string | null } }>(
      'dword_vocab_add',
      {
        term: 'Smear',
        part_of_speech: 'verb',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        context: 'as in he tried to smear his rival',
      },
    );
    expect(out.created).toBe(false);
    expect(out.origin_attached).toBe(true);
    expect(out.entry.origin_term).toBe('Smear');
    expect(out.entry.origin_language).toBe('English');
    expect(out.entry.origin_context).toBe('as in he tried to smear his rival');
  });

  it('dword_vocab_add: a context on a term that already has an origin leaves it untouched (D4)', async () => {
    const out = await call<{ created: boolean; origin_attached: boolean; entry: { origin_term: string | null; origin_language: string | null } }>(
      'dword_vocab_add',
      {
        term: 'Smudge',
        part_of_speech: 'verb',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        context: 'as in he smudged the drawing',
      },
    );
    expect(out.created).toBe(false);
    expect(out.origin_attached).toBe(false);
    expect(out.entry.origin_term).toBe('melumuri');
    expect(out.entry.origin_language).toBe('Indonesian');
  });

  it('dword_vocab_add: refuses past the 50/24h limit and writes nothing', async () => {
    const result = (await limitClient.callTool({
      name: 'dword_vocab_add',
      arguments: { term: 'one-too-many', part_of_speech: 'noun', pronunciation: 'x', definition: 'x', examples: ['x', 'x', 'x'] },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/50 words in a day/);

    const lookup = await limitClient.callTool({ name: 'dword_vocab_lookup', arguments: { term: 'one-too-many' } });
    const parsed = JSON.parse(textOf(lookup as CallToolResult)) as { found: boolean };
    expect(parsed.found).toBe(false);
  });

  it('dword_vocab_add: rejects origin and context together', async () => {
    expect(
      await callError('dword_vocab_add', {
        term: 'ambiguous',
        part_of_speech: 'noun',
        pronunciation: 'x',
        definition: 'x',
        examples: ['x', 'x', 'x'],
        origin: { term: 'ambigu', language: 'French' },
        context: 'as in an ambiguous sentence',
      }),
    ).toMatch(/either origin or context/);
  });
});

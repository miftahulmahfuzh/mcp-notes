import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../../src/config.js';
import type { AppDeps } from '../../../src/deps.js';
import { createApp } from '../../../src/http/app.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { NotesService } from '../../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from '../setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-connectors-mcp-'));
const config: Config = { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG };
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const deps: AppDeps = { config, db, events, service, embedder: null };
const app = createApp(deps);
let client: Client;

function text(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

beforeAll(async () => {
  client = new Client({ name: 'connectors-mcp-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.request(String(input), init),
    }),
  );
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('connector tools on the real /mcp route', () => {
  it('lists the six generic tools next to the notes tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['expenses_schema', 'expenses_sql', 'runs_schema', 'runs_sql', 'seer_schema', 'seer_sql', 'list', 'create']),
    );
    expect(client.getInstructions()).toMatch(/Connectors\./);
  });

  it('an unreachable system is a tool error for that call only; notes tools keep working', async () => {
    const saved = process.env.EXPENSE_TRACKING_DIR;
    process.env.EXPENSE_TRACKING_DIR = join(dataDir, 'no-such-repo');
    try {
      const failed = (await client.callTool({ name: 'expenses_schema', arguments: {} })) as CallToolResult;
      expect(failed.isError).toBe(true);
      expect(text(failed)).toMatch(/^expense-tracking is not reachable: no repository at /);
      const listed = (await client.callTool({ name: 'list', arguments: { limit: 1 } })) as CallToolResult;
      expect(listed.isError).toBeFalsy();
    } finally {
      if (saved === undefined) delete process.env.EXPENSE_TRACKING_DIR;
      else process.env.EXPENSE_TRACKING_DIR = saved;
    }
  });
});

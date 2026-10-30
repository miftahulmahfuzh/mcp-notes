import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createConnector } from '../../../src/connectors/connector.js';
import { runLabQuery } from '../../../src/connectors/lab.js';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../../src/connectors/names.js';
import { registerConnectorTools } from '../../../src/connectors/register.js';
import { ConnectorError, type Connectors } from '../../../src/connectors/types.js';
import { errorResult } from '../../../src/mcp/tools.js';

const root = mkdtempSync(path.join(tmpdir(), 'mcp-notes-failsoft-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = { envFile: false as const };

function textOf(r: CallToolResult): string {
  const first = r.content[0];
  return first && first.type === 'text' ? first.text : '';
}

describe('fail-soft connectors', () => {
  it('a missing repo rejects with a ConnectorError, not a crash', async () => {
    const c = createConnector('expenses', { repoDir: path.join(root, 'missing'), settings });
    await expect(c.query('select 1')).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.query('select 1')).rejects.toThrow(/^expense-tracking is not reachable: no repository at /);
  });

  it('an unreachable database is "not reachable" and leaks no credential', async () => {
    const repo = path.join(root, 'repo-unreachable');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.env.local'), 'DATABASE_URL=postgres://alice:s3cretpw@127.0.0.1:1/db\n');
    const c = createConnector('runs', { repoDir: repo, settings, timeoutMs: 2000 });
    const err = await c.query('select 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^run-insights is not reachable: /);
    expect(msg).not.toContain('s3cretpw');
    expect(msg).not.toContain('alice');
  });

  it('errorResult shows a ConnectorError message as is', () => {
    expect(errorResult(new ConnectorError('seer is not reachable: x'))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'seer is not reachable: x' }],
    });
  });

  it('tools return isError results and the server keeps answering', async () => {
    const missing = (id: 'expenses' | 'runs' | 'seer') => createConnector(id, { repoDir: path.join(root, `none-${id}`), settings });
    const connectors: Connectors = { expenses: missing('expenses'), runs: missing('runs'), seer: missing('seer') };
    const server = new McpServer({ name: 't', version: '0' });
    registerConnectorTools(server, connectors);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tc', version: '0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const schema = (await client.callTool({ name: 'expenses_schema', arguments: {} })) as CallToolResult;
      expect(schema.isError).toBe(true);
      expect(textOf(schema)).toMatch(/^expense-tracking is not reachable: /);
      const write = (await client.callTool({ name: 'seer_sql', arguments: { sql: 'insert into t values (1)' } })) as CallToolResult;
      expect(write.isError).toBe(true);
      expect(textOf(write)).toMatch(/^seer query failed: refused before reaching the database: only SELECT/);
      // Robust to phases 2-4 landing in any order: the generic six are always there, and every
      // registered tool is one of the 15 contract names (curated ones appear as each phase lands).
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['expenses_schema', 'expenses_sql', 'runs_schema', 'runs_sql', 'seer_schema', 'seer_sql']),
      );
      for (const name of names) expect(ALL_CONNECTOR_TOOL_NAMES).toContain(name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('lab runner', () => {
  const file = path.join(root, 'lab.sqlite');
  const db = new DatabaseSync(file);
  db.exec('create table t (x integer); insert into t values (1), (2), (3), (9007199254740993);');
  db.close();
  const opts = { cap: 2, timeoutMs: 5000 };

  it('reads read-only with the cap, params and bigint safety', async () => {
    const r = await runLabQuery('seer', file, 'select x from t order by x', [], opts);
    expect(r).toEqual({ columns: ['x'], rows: [[1], [2]], row_count: 2, truncated: true });
    const big = await runLabQuery('seer', file, 'select x from t where x > ?', [3], opts);
    expect(big.rows).toEqual([['9007199254740993']]);
  });

  it('refuses writes at the file', async () => {
    await expect(runLabQuery('seer', file, 'insert into t values (5)', [], { ...opts, wrap: false })).rejects.toThrow(
      /^seer query failed: attempt to write a readonly database/,
    );
  });

  it('a missing file is not reachable', async () => {
    await expect(runLabQuery('seer', path.join(root, 'none.sqlite'), 'select 1', [], opts)).rejects.toThrow(
      /^seer is not reachable: no lab database at /,
    );
  });

  it('kills a runaway query at the timeout', async () => {
    const sql = 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c';
    await expect(runLabQuery('seer', file, sql, [], { cap: 2, timeoutMs: 500 })).rejects.toThrow(
      /^seer query failed: lab query timed out after 500 ms/,
    );
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretsOf } from '../../../src/connectors/env.js';
import { runLabQuery } from '../../../src/connectors/lab.js';
import { runPgQuery, startupOptions } from '../../../src/connectors/pg.js';
import type { QueryResult } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorClient, connectorFor, connectorsAdminUrl, makeLab, withAdmin, type ConnectorClient } from './harness.js';

const admin = connectorsAdminUrl();

async function probeCount(): Promise<number> {
  return withAdmin(admin, async (c) => Number((await c.query('select count(*) as n from mcp_notes_probe')).rows[0].n));
}

beforeAll(async () => {
  await withAdmin(admin, async (c) => {
    await c.query(`
      DROP TABLE IF EXISTS mcp_notes_probe;
      CREATE TABLE mcp_notes_probe (x integer);
      COMMENT ON TABLE mcp_notes_probe IS 'probe table for connector tests';
      COMMENT ON COLUMN mcp_notes_probe.x IS 'a number';
      DROP SEQUENCE IF EXISTS mcp_notes_probe_seq;
      CREATE SEQUENCE mcp_notes_probe_seq;
    `);
  });
});

afterAll(() => cleanupHarness());

describe('read-only, at the database', () => {
  it('every connection is read-only, on Jakarta time, with the statement timeout', async () => {
    const connector = connectorFor('expenses', { databaseUrl: admin, timeoutMs: 4321 });
    const r = await connector.query(
      `select current_setting('default_transaction_read_only'), current_setting('transaction_read_only'), current_setting('TimeZone'), current_setting('statement_timeout')`,
    );
    expect(r.rows[0]).toEqual(['on', 'on', 'Asia/Jakarta', '4321ms']);
  });

  it('an INSERT through the unguarded executor fails inside the database', async () => {
    const target = { url: admin, secrets: secretsOf(admin) };
    await expect(
      runPgQuery('expense-tracking', target, 'insert into mcp_notes_probe values (1)', [], { cap: 10, timeoutMs: 5000, wrap: false }),
    ).rejects.toThrow(/^expense-tracking query failed: cannot execute INSERT in a read-only transaction/);
    expect(await probeCount()).toBe(0);
  });

  it('the session default alone refuses writes, even outside BEGIN READ ONLY', async () => {
    const client = new pg.Client({ connectionString: admin, options: startupOptions(5000) });
    await client.connect();
    try {
      await expect(client.query('insert into mcp_notes_probe values (2)')).rejects.toThrow(/read-only transaction/);
    } finally {
      await client.end();
    }
    expect(await probeCount()).toBe(0);
  });
});

describe('expenses_sql on the probe database', () => {
  let client: ConnectorClient;
  beforeAll(async () => {
    client = await connectorClient({ expenses: connectorFor('expenses', { databaseUrl: admin }) });
  });
  afterAll(async () => client.close());

  it('select nextval(...) passes the guard and fails inside the database', async () => {
    const msg = await client.callError('expenses_sql', { sql: "select nextval('mcp_notes_probe_seq')" });
    expect(msg).toMatch(/^expense-tracking query failed: cannot execute nextval\(\) in a read-only transaction/);
  });

  it('writes and multi-statements are refused before the database', async () => {
    expect(await client.callError('expenses_sql', { sql: 'insert into mcp_notes_probe values (3)' })).toMatch(
      /^expense-tracking query failed: refused before reaching the database: only SELECT/,
    );
    expect(await client.callError('expenses_sql', { sql: 'select 1; drop table mcp_notes_probe' })).toMatch(/only one statement/);
    expect(await probeCount()).toBe(0);
  });

  it('caps rows: default 200, max_rows up to 1000, truncated flag', async () => {
    const sql = 'select g from generate_series(1, 1500) g';
    const def = await client.call<QueryResult>('expenses_sql', { sql });
    expect(def.columns).toEqual(['g']);
    expect([def.row_count, def.truncated]).toEqual([200, true]);
    const max = await client.call<QueryResult>('expenses_sql', { sql, max_rows: 1000 });
    expect([max.row_count, max.truncated]).toEqual([1000, true]);
    const few = await client.call<QueryResult>('expenses_sql', { sql: 'select g from generate_series(1, 5) g;' });
    expect(few).toEqual({ columns: ['g'], rows: [[1], [2], [3], [4], [5]], row_count: 5, truncated: false });
  });

  it('returns dates and times as text, int8 as a number when safe, numeric as a number', async () => {
    const r = await client.call<QueryResult>('expenses_sql', {
      sql: `select '2026-10-30'::date d, '07:15:00'::time t, '2026-10-30 05:00:00+00'::timestamptz ts, 9007199254740993::int8 big, 42::int8 small, 12.50::numeric n`,
    });
    expect(r.rows[0]).toEqual(['2026-10-30', '07:15:00', '2026-10-30 12:00:00+07', '9007199254740993', 42, 12.5]);
  });

  it('expenses_schema reads tables, types and comments', async () => {
    const r = await client.call<{ system: string; tables: { name: string; comment?: string; columns: unknown[] }[] }>(
      'expenses_schema',
      { tables: ['mcp_notes_probe'] },
    );
    expect(r.system).toBe('expense-tracking');
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]).toMatchObject({
      name: 'mcp_notes_probe',
      comment: 'probe table for connector tests',
      columns: [{ name: 'x', type: 'integer', nullable: true, comment: 'a number' }],
    });
  });
});

describe('timeout and fail-soft', () => {
  it('a slow statement is cancelled by statement_timeout', async () => {
    const connector = connectorFor('expenses', { databaseUrl: admin, timeoutMs: 300 });
    await expect(connector.query('select pg_sleep(2)')).rejects.toThrow(
      /^expense-tracking query failed: canceling statement due to statement timeout/,
    );
  });

  it('missing repo, missing .env.local, no URL and an unreachable DB are short errors; other systems keep working', async () => {
    const working = connectorFor('runs', { databaseUrl: admin });
    const cases: [ReturnType<typeof connectorFor>, RegExp][] = [
      [connectorFor('expenses', { repoDir: null }), /^expense-tracking is not reachable: no repository at /],
      [connectorFor('expenses', { envLocal: null }), /^expense-tracking is not reachable: no \.env\.local in /],
      [connectorFor('expenses', { envLocal: 'OTHER=1\n' }), /^expense-tracking is not reachable: .*has no DATABASE_URL/],
      [connectorFor('expenses', { databaseUrl: 'postgres://someone:hunter22pw@127.0.0.1:1/x' }), /^expense-tracking is not reachable: /],
    ];
    for (const [broken, expected] of cases) {
      const client = await connectorClient({ expenses: broken, runs: working });
      try {
        const msg = await client.callError('expenses_schema');
        expect(msg).toMatch(expected);
        expect(msg).not.toContain('hunter22pw');
        expect(msg).not.toContain('someone');
        const ok = await client.call<{ tables: unknown[] }>('runs_schema', { tables: ['mcp_notes_probe'] });
        expect(ok.tables).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  });
});

describe('seer lab.sqlite', () => {
  it('seer_sql source lab reads the lab; writes fail in the guard and in the file', async () => {
    const lab = makeLab({
      methods: [{ id: 'M0001', name: 'gap fade', family: 'reversal', hypothesis: 'h', status: 'dev-eligible' }],
      trials: [{ method_id: 'M0001', candidate_id: 'c1', window: 'dev', mar: 1.25, trades: 40 }],
      trial_funding: [{ trial_n: 1, mwr: 0.12, spy_tr_mwr: 0.1 }],
    });
    const seer = connectorFor('seer', { databaseUrl: admin, labPath: lab.path });
    const client = await connectorClient({ seer });
    try {
      const r = await client.call<QueryResult>('seer_sql', { source: 'lab', sql: 'select m.id, t.mar from methods m join trials t on t.method_id = m.id' });
      expect(r.rows).toEqual([['M0001', 1.25]]);
      expect(await client.callError('seer_sql', { source: 'lab', sql: "insert into methods (id) values ('M0002')" })).toMatch(
        /^seer query failed: refused before reaching the database/,
      );
      const schema = await client.call<{ db: { tables: { name: string }[] }; lab: { tables: { name: string }[] } }>('seer_schema', {});
      expect(schema.db.tables.map((t) => t.name)).toContain('mcp_notes_probe');
      expect(schema.lab.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['methods', 'trials', 'trial_funding']));
    } finally {
      await client.close();
    }
    await expect(
      runLabQuery('seer', lab.path, "insert into methods (id) values ('M0003')", [], { cap: 10, timeoutMs: 5000, wrap: false }),
    ).rejects.toThrow(/^seer query failed: attempt to write a readonly database/);
  });

  it('a missing lab file is a short error and the db half of seer_schema still answers', async () => {
    const seer = connectorFor('seer', { databaseUrl: admin });
    const client = await connectorClient({ seer });
    try {
      const schema = await client.call<{ db: { tables: unknown[] }; lab: { error: string } }>('seer_schema', {});
      expect(schema.db.tables.length).toBeGreaterThan(0);
      expect(schema.lab.error).toMatch(/^seer is not reachable: no lab database at /);
    } finally {
      await client.close();
    }
  });
});

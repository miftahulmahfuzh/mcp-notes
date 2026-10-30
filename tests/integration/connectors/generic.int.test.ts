import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SystemId } from '../../../src/connectors/names.js';
import type { QueryResult } from '../../../src/connectors/types.js';
import { cleanupHarness, connectorClient, connectorFor, describeWithRepo, type ConnectorClient } from './harness.js';

interface Expectation {
  tables: string[];
  column: { table: string; name: string; type: RegExp };
  countSql: string;
}

const EXPECT: Record<SystemId, Expectation> = {
  expenses: {
    tables: ['expense_groups', 'expense_items', 'expense_photos'],
    column: { table: 'expense_items', name: 'amount_idr', type: /^bigint$/ },
    countSql: 'select count(*) as n from expense_groups',
  },
  runs: {
    tables: ['runs', 'run_splits', 'run_zones', 'insights'],
    column: { table: 'runs', name: 'occurred_on', type: /^date$/ },
    countSql: 'select count(*) as n from runs',
  },
  seer: {
    tables: ['strategies', 'orders', 'equity_snapshots', 'book_positions'],
    column: { table: 'equity_snapshots', name: 'equity_usd', type: /^numeric/ },
    countSql: 'select count(*) as n from strategies',
  },
};

afterAll(() => cleanupHarness());

for (const id of Object.keys(EXPECT) as SystemId[]) {
  const e = EXPECT[id];
  describeWithRepo(id, `${id}_schema / ${id}_sql on the migrated schema`, () => {
    let client: ConnectorClient;
    beforeAll(async () => {
      client = await connectorClient({ [id]: connectorFor(id) });
    });
    afterAll(async () => client.close());

    it(`${id}_schema lists the app's tables with their types`, async () => {
      const args = id === 'seer' ? { source: 'db' } : {};
      const r = await client.call<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>(`${id}_schema`, args);
      const names = r.tables.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(e.tables));
      const col = r.tables.find((t) => t.name === e.column.table)?.columns.find((c) => c.name === e.column.name);
      expect(col?.type).toMatch(e.column.type);
    });

    it(`${id}_sql runs a SELECT and refuses a write`, async () => {
      const r = await client.call<QueryResult>(`${id}_sql`, { sql: e.countSql });
      expect(r.columns).toEqual(['n']);
      expect(typeof r.rows[0]![0]).toBe('number');
      const msg = await client.callError(`${id}_sql`, { sql: `delete from ${e.tables[0]}` });
      expect(msg).toMatch(/refused before reaching the database/);
    });
  });
}

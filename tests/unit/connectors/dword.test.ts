import { describe, expect, it } from 'vitest';
import { createDwordConnector, DWORD_ABOUT } from '../../../src/connectors/dword/index.js';
import {
  dwordUserNotConfiguredMessage,
  dwordUserNotFoundMessage,
  resolveDwordUserId,
} from '../../../src/connectors/dword/user.js';
import { ConnectorError, type Connector, type QueryResult } from '../../../src/connectors/types.js';

function fakeConnector(rows: unknown[][]): Connector {
  return {
    id: 'dword',
    label: 'daily-words',
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
      expect(sql).toBe('SELECT id FROM users WHERE email = $1');
      expect(params).toEqual([expect.any(String)]);
      return { columns: ['id'], rows, row_count: rows.length, truncated: false };
    },
  };
}

describe('resolveDwordUserId', () => {
  it('refuses when DWORD_USER_EMAIL is unset or blank', async () => {
    const connector = fakeConnector([]);
    await expect(resolveDwordUserId(connector, null)).rejects.toThrow(ConnectorError);
    await expect(resolveDwordUserId(connector, null)).rejects.toThrow(/^daily-words user not configured/);
  });

  it('refuses when the email has no matching row', async () => {
    const connector = fakeConnector([]);
    await expect(resolveDwordUserId(connector, 'nobody@example.com')).rejects.toThrow(
      'daily-words user nobody@example.com not found',
    );
  });

  it('resolves to the row\'s id on a match', async () => {
    const connector = fakeConnector([['11111111-1111-1111-1111-111111111111']]);
    await expect(resolveDwordUserId(connector, 'owner@example.com')).resolves.toBe('11111111-1111-1111-1111-111111111111');
  });
});

describe('createDwordConnector', () => {
  it('wraps createConnector with id "dword" and the daily-words label', () => {
    const connector = createDwordConnector({ repoDir: '/nonexistent' });
    expect(connector.id).toBe('dword');
    expect(connector.label).toBe('daily-words');
    expect(connector.lab).toBeUndefined();
  });
});

describe('dword user refusal messages (shared verbatim with src/dword/writer.ts)', () => {
  it('builds the not-configured and not-found messages resolveDwordUserId throws', () => {
    expect(dwordUserNotConfiguredMessage()).toBe('daily-words user not configured: set DWORD_USER_EMAIL in .env.local');
    expect(dwordUserNotFoundMessage('nobody@example.com')).toBe('daily-words user nobody@example.com not found');
  });
});

describe('DWORD_ABOUT', () => {
  it('names the tables this connector reads and writes', () => {
    expect(DWORD_ABOUT.db).toMatch(/vocab_entries/);
    expect(DWORD_ABOUT.db).toMatch(/journal_entries/);
    expect(DWORD_ABOUT.db).toMatch(/journal_entry_embeddings/);
    expect(DWORD_ABOUT.lab).toBeUndefined();
  });
});

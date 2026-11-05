import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdversaryWriteError, SeerWriter, assertWritable } from '../../../src/adversary/seerWriter.js';

describe('assertWritable (contract C4 allow-list)', () => {
  it.each([
    ['INSERT INTO adversary_leases (strategy_id) VALUES ($1) ON CONFLICT (strategy_id, session_date) DO UPDATE SET host = EXCLUDED.host RETURNING host', 'adversary_leases'],
    ['UPDATE adversary_leases SET expires_at = now() WHERE host = $3 RETURNING host', 'adversary_leases'],
    ['DELETE FROM adversary_leases WHERE host = $3', 'adversary_leases'],
    ['INSERT INTO adversary_verdicts (strategy_id) VALUES ($1) RETURNING id', 'adversary_verdicts'],
    ['UPDATE adversary_verdicts SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL', 'adversary_verdicts'],
    ["INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES ($1, $2, 'paused', $3) ON CONFLICT (strategy_id, session_date) DO NOTHING", 'adversary_marks'],
  ])('allows %s', (sql, table) => {
    expect(assertWritable(sql)).toBe(table);
  });

  it.each([
    'INSERT INTO strategies (id) VALUES ($1)',
    'UPDATE strategies SET status = $1',
    'DELETE FROM adversary_verdicts WHERE id = $1',
    'DELETE FROM adversary_marks WHERE strategy_id = $1',
    'UPDATE adversary_verdicts SET reason = $1 WHERE id = $2',
    'UPDATE adversary_marks SET mark = $1 WHERE strategy_id = $2',
    'INSERT INTO public.adversary_verdicts (id) VALUES ($1)',
    'SELECT * FROM adversary_verdicts',
    'INSERT INTO adversary_marks (strategy_id) VALUES ($1); DROP TABLE strategies',
  ])('refuses %s', (sql) => {
    expect(() => assertWritable(sql)).toThrow(AdversaryWriteError);
  });
});

describe('SeerWriter', () => {
  it('names the missing Seer repository instead of connecting anywhere', async () => {
    const writer = new SeerWriter({ repoDir: () => path.join(tmpdir(), `no-seer-here-${process.pid}`) });
    await expect(writer.insertMark('A-GT', '2031-01-14', 'lenovo')).rejects.toThrow(/seer is not reachable: no repository/);
  });
});

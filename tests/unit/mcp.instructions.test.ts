import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loopbackOnly } from '../../src/http/app.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { toFilter } from '../../src/mcp/tools.js';

describe('buildInstructions', () => {
  it('explains ids, lookup, tags, dates and who does comparisons', () => {
    const text = buildInstructions('Asia/Jakarta');
    expect(text).toContain('A-B32');
    expect(text).toMatch(/case-insensitive/);
    expect(text).toMatch(/missing dash/);
    expect(text).toMatch(/#hashtags/);
    expect(text).toContain('Asia/Jakarta');
    expect(text).toMatch(/Comparisons and summaries/);
  });

  it('has exactly one connectors paragraph: read-only, the three systems, curated tools first', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Connectors.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toMatch(/read-only/);
    for (const word of ['expense-tracking', 'run-insights', 'Seer', 'lab.sqlite', 'Asia/Jakarta', 'rupiah']) expect(p).toContain(word);
    expect(p).toContain('Prefer the curated tools');
    expect(p).toContain("only when they don't answer");
    expect(p).toContain('_schema before writing SQL');
    for (const name of ['expenses_spending', 'runs_review', 'seer_sera_best']) expect(p).toContain(name);
    expect(p).not.toContain('expenses_schema,');
  });
});

describe('toFilter', () => {
  it('maps snake_case args and applies the MCP default limit', () => {
    expect(toFilter({})).toEqual({ limit: 50 });
    expect(
      toFilter({ tags_any: ['a'], tags_all: ['b'], date_field: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' }),
    ).toEqual({ tagsAny: ['a'], tagsAll: ['b'], dateField: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' });
  });
});

describe('loopbackOnly', () => {
  const app = new Hono();
  app.use('*', loopbackOnly);
  app.post('/mcp', (c) => c.text('ok'));

  it('allows loopback hosts without or with a loopback Origin', async () => {
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST' })).status).toBe(200);
    expect((await app.request('http://127.0.0.1:7317/mcp', { method: 'POST', headers: { origin: 'http://localhost:7317' } })).status).toBe(200);
  });

  it('blocks other hosts and foreign origins', async () => {
    expect((await app.request('http://notes.attacker.test/mcp', { method: 'POST' })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'https://attacker.test' } })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { excerptAround, messageText, queryTerms, searchTranscript } from '../../src/sessions/transcriptSearch.js';

let dir: string;
let file: string;

const lines = [
  { type: 'user', timestamp: '2026-11-01T01:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
  { type: 'assistant', timestamp: '2026-11-01T01:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', timestamp: '2026-11-01T01:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'photo delete in tool output' }] } },
  { type: 'user', isMeta: true, timestamp: '2026-11-01T01:03:00Z', message: { role: 'user', content: 'photo delete meta' } },
  { type: 'custom-title', customTitle: 'x', sessionId: 's' },
  { type: 'assistant', timestamp: '2026-11-01T01:04:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the photo is in the bin.' }] } },
];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-search-'));
  file = path.join(dir, 's.jsonl');
  // The last line is partial (Claude Code mid-write): it must be skipped, not fail the scan.
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"user","message":{"content":"photo del`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('messageText', () => {
  it('takes user/assistant text only', () => {
    expect(messageText(lines[0])).toEqual({ role: 'user', text: 'Plan the wall photo delete flow', at: '2026-11-01T01:00:00.000Z' });
    expect(messageText(lines[1])?.text).toBe('Photo delete goes to the recycle bin.');
    expect(messageText(lines[2])).toBeNull();
    expect(messageText(lines[3])).toBeNull();
    expect(messageText(lines[4])).toBeNull();
  });
});

describe('queryTerms', () => {
  it('lower-cases, keeps quoted phrases whole, dedupes', () => {
    expect(queryTerms('Photo "recycle bin" photo')).toEqual(['photo', 'recycle bin']);
    expect(queryTerms(null)).toEqual([]);
  });
});

describe('excerptAround', () => {
  it('centres on the first hit with ellipses', () => {
    const text = `${'a '.repeat(500)}needle ${'b '.repeat(500)}`;
    const ex = excerptAround(text, ['needle'], 100);
    expect(ex).toContain('needle');
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('…')).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(102);
  });
});

describe('searchTranscript', () => {
  it('matches every term, skips tool results, meta and the partial line', async () => {
    const r = await searchTranscript(file, { query: 'photo delete', limit: 10 });
    expect(r.matches.map((m) => m.line)).toEqual([1, 2]);
    expect(r.total_matches).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('keeps the last N matches', async () => {
    const r = await searchTranscript(file, { query: 'photo', limit: 1 });
    expect(r.matches.map((m) => m.line)).toEqual([6]);
    expect(r.total_matches).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('without a query returns the tail', async () => {
    const r = await searchTranscript(file, { query: null, limit: 2 });
    expect(r.matches.map((m) => m.role)).toEqual(['assistant', 'assistant']);
    expect(r.total_matches).toBe(3);
  });

  it('stops at the scan cap', async () => {
    const r = await searchTranscript(file, { query: 'photo', limit: 10, maxScanBytes: 200 });
    expect(r.truncated).toBe(true);
    expect(r.scanned_bytes).toBeLessThanOrEqual(200);
  });

  it('throws ENOENT for a missing file', async () => {
    await expect(searchTranscript(path.join(dir, 'gone.jsonl'), { query: null, limit: 5 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

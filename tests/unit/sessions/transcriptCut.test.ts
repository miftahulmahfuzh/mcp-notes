import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCopiedRecord, readJsonlFrom, TranscriptAccumulator } from '../../../src/sessions/transcript.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'notes-cut-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonlFrom line offsets', () => {
  it('hands every complete line the byte offset it starts at, across chunk borders and multi-byte text', async () => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, 'a\n⑂b\nccc\npartial');
    const seen: Array<[string, number]> = [];
    const read = await readJsonlFrom(file, 0, (line, lineStart) => seen.push([line, lineStart]), { chunkBytes: 3 });
    expect(seen).toEqual([
      ['a', 0],
      ['⑂b', 2],
      ['ccc', 7],
    ]);
    expect(read.endOffset).toBe(11);
    const tail: number[] = [];
    await readJsonlFrom(file, 2, (_line, lineStart) => tail.push(lineStart));
    expect(tail).toEqual([2, 7]);
  });
});

const ENV = { cwd: '/home/u/x', entrypoint: 'cli', gitBranch: 'main', version: '2.1.311' };
const copiedPrompt = { ...ENV, type: 'user', uuid: 'u1', timestamp: '2026-11-01T01:00:00.000Z', message: { role: 'user', content: 'copied prompt' } };
const copiedReply = {
  ...ENV,
  type: 'assistant',
  uuid: 'u2',
  timestamp: '2026-11-01T01:00:05.000Z',
  message: { id: 'msg_c', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'copied reply' }], usage: { input_tokens: 100, output_tokens: 10 } },
};
const ownPrompt = { type: 'user', uuid: 'u3', timestamp: '2026-11-01T02:00:00.000Z', cwd: '/home/u/x', message: { role: 'user', content: 'own prompt' } };
const ownReply = {
  type: 'assistant',
  uuid: 'u4',
  timestamp: '2026-11-01T02:00:05.000Z',
  cwd: '/home/u/x',
  message: { id: 'msg_o', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'own reply' }], usage: { input_tokens: 7, output_tokens: 1 } },
};

describe('fork cut', () => {
  it('treats a record as copied only when it has a uuid and starts before the cut', () => {
    expect(isCopiedRecord(copiedPrompt, 0, 100)).toBe(true);
    expect(isCopiedRecord(copiedPrompt, 100, 100)).toBe(false);
    expect(isCopiedRecord({ type: 'ai-title', aiTitle: 'x ⑂' }, 0, 100)).toBe(false);
    expect(isCopiedRecord(copiedPrompt, 0, null)).toBe(false);
  });

  it("takes only identity from copied records and counts the fork's own", () => {
    const acc = new TranscriptAccumulator('s');
    acc.addCopied(copiedPrompt);
    acc.addCopied(copiedReply);
    acc.add(ownPrompt);
    acc.add(ownReply);
    const d = acc.delta();
    expect(d.tokens).toEqual({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(Object.keys(d.models)).toEqual(['claude-opus-5-5']);
    expect(d.prompts.map((p) => p.text)).toEqual(['own prompt']);
    expect(d.replies.map((r) => r.text)).toEqual(['own reply']);
    expect(d.firstAt?.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(d).toMatchObject({ firstPrompt: 'own prompt', finalMessage: 'own reply', cwd: '/home/u/x', entrypoint: 'cli', branch: 'main', version: '2.1.311' });
  });

  it('a read of copied records alone reports identity and nothing else', () => {
    const acc = new TranscriptAccumulator('s');
    acc.addCopied(copiedPrompt);
    acc.addCopied(copiedReply);
    expect(acc.delta()).toMatchObject({
      prompts: [],
      replies: [],
      firstPrompt: null,
      finalMessage: null,
      firstAt: null,
      lastAt: null,
      commits: [],
      models: {},
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cwd: '/home/u/x',
      entrypoint: 'cli',
    });
  });
});

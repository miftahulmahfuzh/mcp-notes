import { describe, expect, it } from 'vitest';
import { nextLeadingReply, replyCut, storedLeadingReply, storedReplies } from '../../../src/sessions/merge.js';
import { accumulateText, buildTranscriptPatch, parseRecord, TranscriptAccumulator, type PatchContext } from '../../../src/sessions/transcript.js';
import { MAX_REPLY_STORE_CHARS, type ReplyContent } from '../../../src/sessions/types.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

const SID = '5e55a001-0000-4000-8000-0000000000f1';
const KEY = 'sk-ant-api03-FAKE-not-a-real-key-0000000000';
const usage = { input_tokens: 1, output_tokens: 1 };
const at = (s: number): string => `2026-11-06T00:00:${String(s).padStart(2, '0')}.000Z`;
const prompt = (s: number, text: string): string =>
  JSON.stringify({ type: 'user', sessionId: SID, cwd: '/home/u/mcp-notes', entrypoint: 'cli', origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: at(s) });
const say = (s: number, id: string, ...texts: string[]): string =>
  JSON.stringify({ type: 'assistant', sessionId: SID, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: texts.map((text) => ({ type: 'text', text })), usage }, timestamp: at(s) });
const tool = (s: number, id: string, toolId: string): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/home/u/mcp-notes/README.md' } }], usage },
    timestamp: at(s),
  });
const result = (s: number, toolId: string): string =>
  JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] }, toolUseResult: { stdout: 'ok' }, timestamp: at(s) });
const side = (s: number, text: string): string =>
  JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: SID, message: { id: `side_${s}`, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], usage }, timestamp: at(s) });

/** Four turns: tool use then a two-block answer; a text-only answer; a turn that ends in a tool call; an answer in two records. */
const LINES = [
  prompt(0, 'why does resume break?'),
  say(1, 'm1', 'Let me check the resume code.'),
  tool(2, 'm1', 't1'),
  result(3, 't1'),
  say(4, 'm2', 'Resume breaks because the tmux target is stale.', `Fix: re-read it on attach. ${KEY}`),
  prompt(5, 'and the hook?'),
  say(6, 'm3', 'The hook only fires on SessionStart.'),
  side(7, 'subagent chatter that is not a reply'),
  prompt(8, 'run the tests'),
  tool(9, 'm4', 't2'),
  result(10, 't2'),
  prompt(11, 'summarize'),
  say(12, 'm5', 'First part.'),
  say(13, 'm6', 'Second part.'),
];

const chunk = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');

function ctx(fromOffset: number, toOffset: number): PatchContext {
  return { host: 'h', transcriptPath: '/t.jsonl', fromOffset, toOffset, size: toOffset, repo: null };
}

/** Ingests LINES as consecutive reads cut at `cuts` (line indexes), each with a fresh accumulator (as after a restart). */
async function repliesAfterReads(cuts: readonly number[]): Promise<Array<[number, ReplyContent]>> {
  const store = new MemoryIngestStore();
  const bounds = [0, ...cuts, LINES.length];
  let offset = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const text = chunk(LINES.slice(bounds[i], bounds[i + 1]));
    const toOffset = offset + Buffer.byteLength(text);
    const res = await store.upsertFromTranscript(buildTranscriptPatch(accumulateText(SID, text).delta(), ctx(offset, toOffset)));
    expect(res.applied).toBe(true);
    offset = toOffset;
  }
  return [...(store.sideReplies.get(SID) ?? new Map<number, ReplyContent>()).entries()].sort((a, b) => a[0] - b[0]);
}

describe('TranscriptAccumulator replies', () => {
  it('gives each prompt the text after its last tool call, from byte 0', () => {
    const d = accumulateText(SID, chunk(LINES)).delta();
    expect(d.prompts.map((p) => p.text)).toEqual(['why does resume break?', 'and the hook?', 'run the tests', 'summarize']);
    expect(d.replies).toEqual([
      { prompt: 0, text: `Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. ${KEY}`, at: at(4) },
      { prompt: 1, text: 'The hook only fires on SessionStart.', at: at(6) },
      { prompt: 3, text: 'First part.\n\nSecond part.', at: at(13) },
    ]);
    expect(d.leadingReply).toBeNull();
  });

  it('gives the main fixture session its final message, not the narration before its tool calls', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { FIXTURE, FIXTURE_CLAUDE_HOME } = await import('../../helpers/claudeHome.js');
    const d = accumulateText(FIXTURE.main, await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.mainFile), 'utf8')).delta();
    expect(d.replies).toEqual([{ prompt: 0, text: 'Done: the plan is written.', at: '2026-11-02T02:23:10.000Z' }]);
  });

  it('reports what a read that starts mid-turn does to the earlier reply', () => {
    const lead = (from: number, to: number) => accumulateText(SID, chunk(LINES.slice(from, to))).delta();
    expect(lead(1, 2).leadingReply).toEqual({ kind: 'append', text: 'Let me check the resume code.', at: at(1) });
    expect(lead(2, 4).leadingReply).toEqual({ kind: 'replace', reply: null });
    expect(lead(2, 5).leadingReply).toEqual({
      kind: 'replace',
      reply: { text: `Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. ${KEY}`, at: at(4) },
    });
    expect(lead(3, 4).leadingReply).toBeNull();
    const toNextPrompt = lead(1, 6);
    expect(toNextPrompt.leadingReply).toMatchObject({ kind: 'replace' });
    expect(toNextPrompt.replies).toEqual([]);
  });

  it('never produces a reply from a subagent transcript', () => {
    const acc = new TranscriptAccumulator(SID, undefined, { sidechain: true });
    for (const line of [side(0, 'subagent says hi'), side(1, 'and more')]) {
      const record = parseRecord(line);
      if (record !== null) acc.add(record);
    }
    expect(acc.delta().replies).toEqual([]);
    expect(acc.delta().leadingReply).toBeNull();
  });

  it('sends leadingReply only for a read that does not start at byte 0', () => {
    const d = accumulateText(SID, chunk(LINES.slice(1, 2))).delta();
    expect(buildTranscriptPatch(d, ctx(0, 10)).leadingReply).toBeNull();
    expect(buildTranscriptPatch(d, ctx(50, 60)).leadingReply).toEqual({ kind: 'append', text: 'Let me check the resume code.', at: at(1) });
  });
});

describe('stored replies equal one read from byte 0, however the reads are cut', () => {
  it('stores redacted replies keyed to their prompt seq', async () => {
    const whole = await repliesAfterReads([]);
    expect(whole.map(([seq, r]) => [seq, r.text, r.truncated])).toEqual([
      [1, 'Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. [redacted]', false],
      [2, 'The hook only fires on SessionStart.', false],
      [4, 'First part.\n\nSecond part.', false],
    ]);
  });

  it('at every single split point', async () => {
    const whole = await repliesAfterReads([]);
    for (let k = 1; k < LINES.length; k += 1) {
      expect(await repliesAfterReads([k]), `split at line ${k}`).toEqual(whole);
    }
  });

  it('at every pair of split points', async () => {
    const whole = await repliesAfterReads([]);
    for (let a = 1; a < LINES.length - 1; a += 1) {
      for (let b = a + 1; b < LINES.length; b += 1) {
        expect(await repliesAfterReads([a, b]), `split at lines ${a}, ${b}`).toEqual(whole);
      }
    }
  });
});

describe('reply helpers', () => {
  it('redacts, caps, and follows the prompts that are kept', () => {
    const long = 'word '.repeat(MAX_REPLY_STORE_CHARS);
    const out = storedReplies(
      [{ text: 'a', at: null }, { text: '   ', at: null }, { text: 'b', at: null }],
      [
        { prompt: 0, text: `use ${KEY} now`, at: '2026-11-06T00:00:00.000Z' },
        { prompt: 1, text: 'answer to a blank prompt', at: null },
        { prompt: 2, text: long, at: null },
      ],
    );
    expect(out).toEqual([
      { prompt: 0, text: 'use [redacted] now', at: new Date('2026-11-06T00:00:00.000Z'), truncated: false },
      { prompt: 1, text: long.slice(0, MAX_REPLY_STORE_CHARS), at: null, truncated: true },
    ]);
  });

  it('never cuts through a surrogate pair', () => {
    const text = `${'a'.repeat(MAX_REPLY_STORE_CHARS - 1)}\u{1F600}`;
    expect(replyCut(text)).toEqual({ text: 'a'.repeat(MAX_REPLY_STORE_CHARS - 1), truncated: true });
  });

  it('appends to, replaces or deletes the earlier reply', () => {
    const t1 = new Date('2026-11-06T00:00:01.000Z');
    const t2 = new Date('2026-11-06T00:00:02.000Z');
    const stored: ReplyContent = { text: 'first', at: t1, truncated: false };
    const append = storedLeadingReply({ kind: 'append', text: 'second', at: t2.toISOString() });
    if (append === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, append)).toEqual({ text: 'first\n\nsecond', at: t2, truncated: false });
    expect(nextLeadingReply(null, append)).toEqual({ text: 'second', at: t2, truncated: false });
    expect(nextLeadingReply({ text: 'x'.repeat(MAX_REPLY_STORE_CHARS), at: t1, truncated: true }, append)).toEqual({
      text: 'x'.repeat(MAX_REPLY_STORE_CHARS),
      at: t2,
      truncated: true,
    });
    const replace = storedLeadingReply({ kind: 'replace', reply: { text: `new ${KEY}`, at: t2.toISOString() } });
    if (replace === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, replace)).toEqual({ text: 'new [redacted]', at: t2, truncated: false });
    const drop = storedLeadingReply({ kind: 'replace', reply: null });
    if (drop === null) throw new Error('no leading reply');
    expect(nextLeadingReply(stored, drop)).toBeNull();
    expect(storedLeadingReply(null)).toBeNull();
  });
});

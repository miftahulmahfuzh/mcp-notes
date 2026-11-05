import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accumulateText,
  buildTranscriptPatch,
  extractImages,
  parseCommitLines,
  parseCommitRanges,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type PatchContext,
} from '../../../src/sessions/transcript.js';
import { MAX_PROMPT_STORE_CHARS } from '../../../src/sessions/types.js';
import { FIXTURE, FIXTURE_CLAUDE_HOME, MANY_PROMPTS, manyPromptsText } from '../../helpers/claudeHome.js';

const user = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-02T00:00:00Z', cwd: '/c', entrypoint: 'cli', ...extra });
const assistant = (id: string, usage: Record<string, number>, block: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [block], usage }, timestamp: '2026-11-02T00:00:01Z' });

describe('parseRecord', () => {
  it('drops blank, torn, non-object and ignored-type lines', () => {
    expect(parseRecord('')).toBeNull();
    expect(parseRecord('{"type":"user","mess')).toBeNull();
    expect(parseRecord('[1,2]')).toBeNull();
    expect(parseRecord('{"type":"api-request-blob","x":1}')).toBeNull();
    expect(parseRecord('{"type":"file-history-snapshot"}')).toBeNull();
    expect(parseRecord('{"type":"agent-name","agentName":"x"}')).toEqual({ type: 'agent-name', agentName: 'x' });
  });
});

describe('readJsonlFrom', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notes-jsonl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hands out complete lines only and stops before a trailing partial line', async () => {
    const file = path.join(dir, 's.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":');
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.endOffset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'));
    expect(r.size).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":'));

    await appendFile(file, '3}\n');
    const more: string[] = [];
    const r2 = await readJsonlFrom(file, r.endOffset, (l) => more.push(l));
    expect(more).toEqual(['{"c":3}']);
    expect(r2.endOffset).toBe(r2.size);
  });

  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const file = path.join(dir, 'u.jsonl');
    const text = `${JSON.stringify({ t: 'héllo wörld ✓ 日本語'.repeat(20) })}\n${JSON.stringify({ t: '✓' })}\n`;
    await writeFile(file, text);
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l), { chunkBytes: 7 });
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(text.trim().split('\n').map((l) => JSON.parse(l) as unknown));
    expect(r.endOffset).toBe(Buffer.byteLength(text));
  });

  it('stops at a chunk boundary when asked and reports how far it got', async () => {
    const file = path.join(dir, 'v.jsonl');
    await writeFile(file, '{"a":1}\n'.repeat(10));
    let calls = 0;
    const r = await readJsonlFrom(file, 0, () => undefined, { chunkBytes: 16, shouldStop: () => ++calls > 1 });
    expect(r.stopped).toBe(true);
    expect(r.endOffset).toBe(16);
  });

  it('stops at `until` when it is before the end of the file', async () => {
    const file = path.join(dir, 'w.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const lines: string[] = [];
    const r = await readJsonlFrom(file, 0, (l) => lines.push(l), { until: Buffer.byteLength('{"a":1}\n{"b":2}\n'), chunkBytes: 5 });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.endOffset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'));
    expect(r.size).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}\n'));
  });
});

describe('TranscriptAccumulator on the fixture', () => {
  it('extracts the session fields from the main fixture transcript', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.mainFile), 'utf8');
    const d = accumulateText(FIXTURE.main, text).delta();
    expect(d.cwd).toBe('/home/u/mcp-notes');
    expect(d.branch).toBe('main');
    expect(d.entrypoint).toBe('cli');
    expect(d.version).toBe('2.1.311');
    expect(d.name).toBe('session-graph-discussion');
    expect(d.customTitle).toBe('session-graph-discussion');
    expect(d.aiTitle).toBe('Project session graph');
    expect(d.lastPrompt).toBe('sketch the project-session-graph feature');
    // `/model` (bare command), the peer message and "[Request interrupted by user]" are not prompts.
    expect(d.firstPrompt).toBe('sketch the project-session-graph feature');
    expect(d.prompts).toEqual([{ text: 'sketch the project-session-graph feature', at: '2026-11-02T02:21:51.300Z', truncated: false }]);
    expect(d.firstAt?.toISOString()).toBe('2026-11-02T02:12:57.806Z');
    expect(d.lastAt?.toISOString()).toBe('2026-11-02T02:23:20.000Z');
    // The Edit result that happens to contain "[main 0000000] ..." is not a commit.
    expect(d.commits).toEqual([{ sha: 'abc1234', subject: 'feat(sessions): ingest transcripts', at: '2026-11-02T02:21:58.000Z' }]);
    expect(d.filesEdited).toEqual(['/home/u/mcp-notes/docs/plans/PROJECT_SESSION_GRAPH_PLAN.md', '/home/u/mcp-notes/src/sessions/ingest.ts']);
    expect(d.planDocs).toEqual([
      '/home/u/mcp-notes/docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
      '/home/u/mcp-notes/.workflows/plan/project-session-graph/phase-3.md',
    ]);
    expect(d.finalMessage).toBe('Done: the plan is written.');
    // Usage once per message id: msg_A, msg_B, msg_C, msg_D.
    const usage = { inputTokens: 5, outputTokens: 914, cacheReadTokens: 122065, cacheWriteTokens: 21295 };
    expect(d.tokens).toEqual(usage);
    expect(d.models).toEqual({ 'claude-opus-5-5': usage });
    expect(d.costUsd).toBe(1.25);
  });

  it('keeps a bare skill call as the first prompt, but not a bare built-in command', () => {
    const cmd = (name: string): string => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`;
    const skillBody = user('Base directory for this skill: /x/.claude/skills/sera\n\n# Sera', { isMeta: true });
    const text = [
      user(cmd('model')),
      user('<local-command-stdout>Set model</local-command-stdout>'),
      user(cmd('sera-the-explorer')),
      skillBody,
      user('wait until all done. then "a"'),
    ].join('\n');
    const d = accumulateText('s', `${text}\n`).delta();
    expect(d.prompts.map((p) => p.text)).toEqual(['/sera-the-explorer', 'wait until all done. then "a"']);
    expect(d.firstPrompt).toBe('/sera-the-explorer');
  });

  it('counts a message once when its records straddle two reads (carry)', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.worktreeFile), 'utf8');
    const lines = text.trim().split('\n');
    const first = accumulateText(FIXTURE.worktreeChild, `${lines.slice(0, 4).join('\n')}\n`);
    const second = accumulateText(FIXTURE.worktreeChild, `${lines.slice(4).join('\n')}\n`, first.carry());
    expect(first.delta().tokens).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(second.delta().tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(second.delta().finalMessage).toBe('Phase 1 implemented.');
  });

  it('matches a git commit result to its tool_use across reads', () => {
    const acc = new TranscriptAccumulator('s');
    acc.add(JSON.parse(assistant('m1', {}, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m x' } })) as Record<string, unknown>);
    const next = new TranscriptAccumulator('s', acc.carry());
    next.add({
      type: 'user',
      timestamp: '2026-11-02T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[feature/x (root-commit) 1a2b3c4d] first commit' }] }] },
      toolUseResult: { stdout: '...' },
    });
    expect(next.delta().commits).toEqual([{ sha: '1a2b3c4d', subject: 'first commit', at: '2026-11-02T00:00:02Z' }]);
  });

  it('keeps push and fast-forward merge ranges of a git command, not fetched ones or other output', () => {
    const run = (id: string, command: string, output: string): string =>
      [
        assistant(`m_${id}`, {}, { type: 'tool_use', id, name: 'Bash', input: { command } }),
        user('', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }, toolUseResult: { stdout: output } }),
      ].join('\n');
    const d = accumulateText(
      's',
      [
        run('t1', 'git commit -q -F - && git push origin main', 'To github.com:u/r\n   427cb61..81c7f3d  main -> main'),
        run('t2', 'git fetch && git merge --ff-only origin/main', 'From github.com:u/r\n   1111111..2222222  main -> origin/main\nUpdating 3333333..4444444\nFast-forward'),
        run('t3', 'cat notes.txt', 'To github.com:u/r\n   5555555..6666666  main -> main'),
        run('t4', 'git push -f', 'To github.com:u/r\n + 7777777...8888888 feat -> feat (forced update)'),
      ].join('\n'),
    ).delta();
    expect(d.commits).toEqual([]);
    expect(d.commitRanges.map((r) => `${r.from}..${r.to}`)).toEqual(['427cb61..81c7f3d', '3333333..4444444', '7777777..8888888']);
    expect(d.commitRanges[0]).toMatchObject({ cwd: '/c', at: '2026-11-02T00:00:00Z' });
  });

  it('takes commits from `git log --oneline` only when the same command committed (quiet -q commits)', () => {
    const run = (id: string, command: string, output: string): string =>
      [
        assistant(`m_${id}`, {}, { type: 'tool_use', id, name: 'Bash', input: { command } }),
        user('', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }, toolUseResult: { stdout: output } }),
      ].join('\n');
    const d = accumulateText(
      's',
      [
        run('t1', 'git commit -q -m a && git commit -q -m b && git push -q origin main && git log --oneline -2', 'a91b816 (HEAD -> main, origin/main) feat(web): Alt+Z\nb478a2a fix(sessions): bare skill'),
        run('t2', 'git log --oneline -3', 'ccccccc someone else\nddddddd older'),
        run('t3', 'git commit -m x', '[main eeeeeee] loud commit\n 1 file changed'),
      ].join('\n'),
    ).delta();
    expect(d.commits.map((c) => `${c.sha} ${c.subject}`)).toEqual(['a91b816 feat(web): Alt+Z', 'b478a2a fix(sessions): bare skill', 'eeeeeee loud commit']);
  });

  it('parses a push range only under its To header', () => {
    expect(parseCommitRanges('   aaaaaaa..bbbbbbb  main -> main', null, null)).toEqual([]);
    expect(parseCommitRanges('To x\n   aaaaaaa..bbbbbbb  main -> main\n * [new branch]      f -> f', '/r', null)).toEqual([
      { from: 'aaaaaaa', to: 'bbbbbbb', cwd: '/r', at: null },
    ]);
  });

  it('ignores sidechain records and resets the final message on a tool_use', () => {
    const d = accumulateText(
      's',
      [
        user('hello'),
        assistant('m1', {}, { type: 'text', text: 'before tools' }),
        assistant('m1', {}, { type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/r.ts' } }),
        JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'side prompt' } }),
      ].join('\n'),
    ).delta();
    expect(d.prompts.map((p) => p.text)).toEqual(['hello']);
    expect(d.finalMessage).toBeNull();
    expect(d.filesEdited).toEqual([]);
  });

  it('keeps every prompt of a read, in order, with the first one', () => {
    const text = Array.from({ length: 130 }, (_, i) => user(`p${i}`)).join('\n');
    const d = accumulateText('s', text).delta();
    expect(d.prompts).toHaveLength(130);
    expect(d.prompts[0]?.text).toBe('p0');
    expect(d.prompts.at(-1)?.text).toBe('p129');
    expect(d.firstPrompt).toBe('p0');
  });

  it('stores a long prompt whole, cut only at the ceiling and marked truncated', () => {
    const long = `start\n    indented\n${'x'.repeat(5000)}`;
    const huge = 'y'.repeat(MAX_PROMPT_STORE_CHARS + 10);
    const d = accumulateText('s', [user(long), user(huge), JSON.stringify({ type: 'last-prompt', lastPrompt: huge })].join('\n')).delta();
    expect(d.prompts[0]).toEqual({ text: long, at: '2026-11-02T00:00:00Z', truncated: false });
    expect(d.prompts[1]?.text).toHaveLength(MAX_PROMPT_STORE_CHARS);
    expect(d.prompts[1]?.truncated).toBe(true);
    expect(d.firstPrompt).toBe(long);
    expect(d.lastPrompt).toHaveLength(MAX_PROMPT_STORE_CHARS);
  });

  it('reads all 106 prompts of the many-prompts fixture, the long one whole', async () => {
    const text = await readFile(path.join(FIXTURE_CLAUDE_HOME, FIXTURE.manyPromptsFile), 'utf8');
    const d = accumulateText(FIXTURE.manyPrompts, text).delta();
    expect(d.prompts).toHaveLength(MANY_PROMPTS.count);
    expect(d.prompts[MANY_PROMPTS.long - 1]?.text).toBe(await manyPromptsText(MANY_PROMPTS.long));
    expect(d.prompts[MANY_PROMPTS.long - 1]?.text.length).toBeGreaterThan(2000);
    expect(d.prompts.every((p) => p.truncated === false)).toBe(true);
  });
});

describe('extractImages', () => {
  const imageBlock = (data: string, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });

  it('reads base64 image blocks in order, numbered by imagePasteIds', () => {
    const record = {
      type: 'user',
      imagePasteIds: [2],
      message: { role: 'user', content: [{ type: 'text', text: '[Image #2] look' }, imageBlock('AAA', 'image/jpeg')] },
    };
    expect(extractImages(record)).toEqual([{ mediaType: 'image/jpeg', dataBase64: 'AAA', pasteId: 2 }]);
  });

  it('falls back to the 1-based content position when imagePasteIds is absent', () => {
    const record = { type: 'user', message: { role: 'user', content: [imageBlock('AAA'), { type: 'text', text: 'two pics' }, imageBlock('BBB')] } };
    expect(extractImages(record)).toEqual([
      { mediaType: 'image/png', dataBase64: 'AAA', pasteId: 1 },
      { mediaType: 'image/png', dataBase64: 'BBB', pasteId: 2 },
    ]);
  });

  it('skips a non-base64 source and caps at MAX_IMAGES_PER_PROMPT', () => {
    const urlBlock = { type: 'image', source: { type: 'url', url: 'https://x/y.png' } };
    const many = Array.from({ length: 10 }, (_, i) => imageBlock(`img${i}`));
    const record = { type: 'user', message: { role: 'user', content: [urlBlock, ...many] } };
    const images = extractImages(record);
    expect(images).toHaveLength(8);
    expect(images[0]).toEqual({ mediaType: 'image/png', dataBase64: 'img0', pasteId: 2 });
  });

  it('is empty for string content, no content, or no image blocks', () => {
    expect(extractImages({ type: 'user', message: { role: 'user', content: 'just text' } })).toEqual([]);
    expect(extractImages({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })).toEqual([]);
    expect(extractImages({ type: 'user' })).toEqual([]);
  });

  it('TranscriptAccumulator attaches a prompt record\'s images to its PatchPrompt', () => {
    const acc = new TranscriptAccumulator('s');
    acc.add({
      type: 'user',
      timestamp: '2026-11-05T00:00:00Z',
      imagePasteIds: [1],
      message: { role: 'user', content: [{ type: 'text', text: 'see this' }, imageBlock('AAA', 'image/jpeg')] },
    });
    expect(acc.delta().prompts).toEqual([{ text: 'see this', at: '2026-11-05T00:00:00Z', truncated: false, images: [{ mediaType: 'image/jpeg', dataBase64: 'AAA', pasteId: 1 }] }]);
  });

  it('a prompt with no images has no images field', () => {
    const acc = new TranscriptAccumulator('s');
    acc.add({ type: 'user', timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: 'plain text' } });
    expect(acc.delta().prompts).toEqual([{ text: 'plain text', at: '2026-11-05T00:00:00Z', truncated: false }]);
  });
});

describe('parseCommitLines', () => {
  it('reads every [branch sha] subject line', () => {
    expect(parseCommitLines('[main abc1234] one\n 1 file changed\n[main def5678] two', null).map((c) => c.sha)).toEqual(['abc1234', 'def5678']);
    expect(parseCommitLines('nothing here', null)).toEqual([]);
  });
});

describe('buildTranscriptPatch', () => {
  const ctx = (over: Partial<PatchContext> = {}): PatchContext => ({
    host: 'test-host',
    transcriptPath: '/x/s.jsonl',
    fromOffset: 0,
    toOffset: 100,
    size: 120,
    repo: 'mcp-notes',
    ...over,
  });

  it('sends cwd, entrypoint and repo only for a read from byte 0', () => {
    const d = accumulateText('s', `${user('hi', { cwd: '/home/u/mcp-notes/web' })}\n`).delta();
    expect(buildTranscriptPatch(d, ctx())).toMatchObject({
      sessionId: 's',
      host: 'test-host',
      fromOffset: 0,
      toOffset: 100,
      size: 120,
      cwd: '/home/u/mcp-notes/web',
      entrypoint: 'cli',
      repo: 'mcp-notes',
      firstPrompt: 'hi',
    });
    const later = buildTranscriptPatch(d, ctx({ fromOffset: 50, repo: null }));
    expect(later.cwd).toBeNull();
    expect(later.entrypoint).toBeNull();
    expect(later.repo).toBeNull();
    expect(later.name).toBeNull();
  });
});

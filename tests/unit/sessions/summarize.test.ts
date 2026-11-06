import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  MAX_EMBED_COMMITS,
  SUMMARY_MODEL,
  asLines,
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  commitSubjects,
  createAgentSummarizer,
  embedTextSha,
  findClaudeBin,
  summaryInputSha,
  type SessionSummarySource,
} from '../../../src/sessions/summarize.js';

function source(over: Partial<SessionSummarySource> = {}): SessionSummarySource {
  return {
    sessionId: 's-1',
    nodeId: 'A0-3G',
    repo: 'mcp-notes',
    branch: 'feature/x',
    name: 'impl-x-p1',
    customTitle: 'wall editing',
    aiTitle: null,
    firstPrompt: 'make the wall editable',
    prompts: ['make the wall editable', 'also delete photos'],
    commits: [{ sha: '8c259df0b1c2d3e4', subject: 'feat(web): edit on the wall' }],
    filesEdited: ['web/src/App.tsx'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    finalMessage: 'Done: the wall is editable.',
    summary: null,
    summarySha: null,
    ...over,
  };
}

function result(text: string, isError = false): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: 'x',
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'summarize-'));
  bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('asLines', () => {
  it('accepts strings and objects', () => {
    expect(asLines(['a', ' ', { sha: '0123456789abcdef', subject: 'fix' }, { path: 'x.ts' }, 3])).toEqual([
      'a',
      '0123456789 fix',
      'x.ts',
      '3',
    ]);
    expect(asLines(null)).toEqual([]);
    expect(asLines('one')).toEqual(['one']);
  });
});

describe('buildSummaryInput', () => {
  it('lists repo, titles, prompts, commits, files, plan docs and the final message', () => {
    const input = buildSummaryInput(source());
    expect(input).not.toBeNull();
    expect(input).toContain('Node: A0-3G');
    expect(input).toContain('Repository: mcp-notes');
    expect(input).toContain('1. make the wall editable');
    expect(input).toContain('2. also delete photos');
    expect(input).toContain('- 8c259df0b1 feat(web): edit on the wall');
    expect(input).toContain('- web/src/App.tsx');
    expect(input).toContain('- docs/plans/WALL_PLAN.md');
    expect(input).toContain('Done: the wall is editable.');
  });

  it('redacts secrets before the model sees them', () => {
    const input = buildSummaryInput(
      source({ prompts: ['connect with postgres://u:hunter2@db/x and OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123'] }),
    );
    expect(input).not.toContain('hunter2');
    expect(input).not.toContain('sk-or-v1-0123456789abcdef0123');
    expect(input).toContain('[redacted]');
  });

  it('is null when there is nothing to summarize', () => {
    expect(buildSummaryInput(source({ prompts: [], firstPrompt: null, finalMessage: null }))).toBeNull();
  });

  it('keeps the first 10 and last 30 of many prompts', () => {
    const prompts = Array.from({ length: 100 }, (_, i) => `prompt ${i} end`);
    const input = buildSummaryInput(source({ prompts })) ?? '';
    expect(input).toContain('prompt 0 end');
    expect(input).toContain('prompt 99 end');
    expect(input).not.toContain('prompt 50 end');
    expect(input).toContain('(60 more prompts omitted)');
  });

  it('never exceeds the input cap', () => {
    const prompts = Array.from({ length: 100 }, (_, i) => `prompt ${i} ${'x'.repeat(2000)}`);
    const input = buildSummaryInput(source({ prompts })) ?? '';
    expect(input.length).toBeLessThanOrEqual(24_000);
  });
});

describe('shas', () => {
  it('summaryInputSha is stable and changes with the input', () => {
    const a = buildSummaryInput(source()) ?? '';
    expect(summaryInputSha(a)).toBe(summaryInputSha(a));
    expect(summaryInputSha(a)).not.toBe(summaryInputSha(`${a}!`));
  });

  it('embed text includes title, summary and prompts, redacted', () => {
    const text = buildEmbedText(source({ summary: 'Made the wall editable.', prompts: ['token=abc123secret'] })) ?? '';
    expect(text).toContain('wall editing');
    expect(text).toContain('Made the wall editable.');
    expect(text).not.toContain('abc123secret');
    expect(embedTextSha(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('commit subjects in the embed text', () => {
  it('commitSubjects takes subjects (or messages, or strings), never shas', () => {
    expect(
      commitSubjects([{ sha: '0123456789abcdef', subject: ' fix(wall): spinner ' }, { message: 'chore: bump' }, 'docs: readme', { sha: 'x' }, null, 3]),
    ).toEqual(['fix(wall): spinner', 'chore: bump', 'docs: readme']);
    expect(commitSubjects(null)).toEqual([]);
    expect(commitSubjects({ subject: 'not a list' })).toEqual([]);
  });

  it('puts commit subjects after the summary and before the prompts, without the sha', () => {
    const text = buildEmbedText(source({ summary: 'Made the wall editable.' })) ?? '';
    const summaryAt = text.indexOf('Made the wall editable.');
    const commitAt = text.indexOf('feat(web): edit on the wall');
    const promptAt = text.indexOf('also delete photos');
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(summaryAt);
    expect(promptAt).toBeGreaterThan(commitAt);
    expect(text).not.toContain('8c259df0');
  });

  it('keeps commit subjects when long prompts fill the 8000-char clamp', () => {
    const prompts = Array.from({ length: 40 }, (_, i) => `prompt ${i} ${'x'.repeat(480)}`);
    const text = buildEmbedText(source({ prompts, commits: [{ sha: 'abc', subject: 'fix: zanzibar spinner' }] })) ?? '';
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('fix: zanzibar spinner');
    expect(text).not.toContain('prompt 39');
  });

  it('keeps only the newest MAX_EMBED_COMMITS subjects', () => {
    const commits = Array.from({ length: MAX_EMBED_COMMITS + 5 }, (_, i) => ({ sha: `s${i}`, subject: `subject-${String(i + 1).padStart(2, '0')}` }));
    const text = buildEmbedText(source({ commits })) ?? '';
    expect(text).toContain(`subject-${String(MAX_EMBED_COMMITS + 5).padStart(2, '0')}`);
    expect(text).toContain('subject-06');
    expect(text).not.toContain('subject-05');
  });

  it('a commit changes the embed sha', () => {
    const a = buildEmbedText(source({ commits: [] })) ?? '';
    const b = buildEmbedText(source()) ?? '';
    expect(embedTextSha(a)).not.toBe(embedTextSha(b));
  });
});

describe('cleanSummary', () => {
  it('drops a Summary: lead-in, caps and redacts', () => {
    expect(cleanSummary('**Summary:** Did X with Bearer abcdef here.')).toBe('Did X with Bearer [redacted] here.');
    expect(cleanSummary('x'.repeat(5000)).length).toBeLessThanOrEqual(1500);
  });
});

describe('findClaudeBin', () => {
  it('finds an executable path and rejects a missing one', () => {
    expect(findClaudeBin(bin, '')).toBe(bin);
    expect(findClaudeBin(path.join(dir, 'nope'), '')).toBeNull();
    expect(findClaudeBin('claude', dir)).toBe(bin);
    expect(findClaudeBin('claude', path.join(dir, 'empty'))).toBeNull();
  });
});

describe('createAgentSummarizer', () => {
  it('returns null when the claude binary is missing', () => {
    expect(createAgentSummarizer({ claudeBin: path.join(dir, 'nope'), cwd: dir })).toBeNull();
  });

  it('runs haiku with no tools, one turn, no persisted session, and returns the result', async () => {
    const seen: Options[] = [];
    const query: QueryFn = ({ options }) => {
      seen.push(options);
      return (async function* () {
        yield result('Made the wall editable.');
      })();
    };
    const s = createAgentSummarizer({
      claudeBin: bin,
      cwd: path.join(dir, 'session-summaries'),
      query,
      baseEnv: { PATH: '', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'parent' },
    });
    expect(s).not.toBeNull();
    const out = await s!.summarize({ sessionId: 's-1', input: 'Node: A0-3G', signal: new AbortController().signal });
    expect(out).toBe('Made the wall editable.');
    const o = seen[0]!;
    expect(o.model).toBe(SUMMARY_MODEL);
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.maxTurns).toBe(1);
    expect(o.persistSession).toBe(false);
    expect(o.settingSources).toEqual([]);
    expect(o.pathToClaudeCodeExecutable).toBe(bin);
    expect(o.cwd).toBe(path.join(dir, 'session-summaries'));
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('rejects on an error result', async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield result('usage limit reached', true);
      })();
    const s = createAgentSummarizer({ claudeBin: bin, cwd: dir, query, baseEnv: { PATH: '' } })!;
    await expect(s.summarize({ sessionId: 's', input: 'x', signal: new AbortController().signal })).rejects.toThrow(
      /usage limit/,
    );
  });

  it('rejects when aborted', async () => {
    const query: QueryFn = ({ options }) =>
      (async function* () {
        await new Promise<void>((resolve) => options.abortController?.signal.addEventListener('abort', () => resolve()));
        throw new Error('aborted by caller');
      })();
    const s = createAgentSummarizer({ claudeBin: bin, cwd: dir, query, baseEnv: { PATH: '' } })!;
    const ac = new AbortController();
    const p = s.summarize({ sessionId: 's', input: 'x', signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../../src/chat/agent.js';
import {
  DEFAULT_FALLBACK_MODEL,
  FALLBACK_SYSTEM_PROMPT,
  buildFallbackInput,
  createHaikuFallback,
  parseFallbackAnswer,
} from '../../../src/movies/fallback.js';

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

function answering(text: string, seen: Array<{ prompt: unknown; options: Options }> = []): QueryFn {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    return (async function* () {
      yield result(text);
    })();
  };
}

let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'movies-fallback-'));
  bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseFallbackAnswer', () => {
  it('reads the JSON object, fenced or bare, with a string year', () => {
    expect(parseFallbackAnswer('{"title":"Ne Zha 2","year":2025,"kind":"movie"}')).toEqual({ title: 'Ne Zha 2', year: 2025, kind: 'movie' });
    expect(parseFallbackAnswer('```json\n{"title":"MobLand","year":"2025","kind":"tv"}\n```')).toEqual({
      title: 'MobLand',
      year: 2025,
      kind: 'tv',
    });
    expect(parseFallbackAnswer('Sure: {"title":"Oldboy","year":null,"kind":"film"}')).toEqual({ title: 'Oldboy', year: null, kind: null });
  });

  it('answers null for null, prose, broken JSON and an empty title', () => {
    for (const raw of ['null', 'NULL.', 'I cannot tell.', '{"title":', '{"title":"  ","year":2020}', '{"year":2020}']) {
      expect(parseFallbackAnswer(raw)).toBeNull();
    }
  });

  it('drops an impossible year', () => {
    expect(parseFallbackAnswer('{"title":"X","year":20220222}')).toEqual({ title: 'X', year: null, kind: null });
  });
});

describe('createHaikuFallback', () => {
  it('returns null when the claude binary is missing', () => {
    expect(createHaikuFallback({ claudeBin: path.join(dir, 'nope'), cwd: dir })).toBeNull();
  });

  it('asks haiku with no tools, one turn, no persisted session, and returns the parsed answer', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const cwd = path.join(dir, 'movies-fallback');
    const fb = createHaikuFallback({
      claudeBin: bin,
      cwd,
      query: answering('{"title":"Ne Zha 2","year":2025,"kind":"movie"}', seen),
      baseEnv: { PATH: '', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'parent' },
    });
    expect(fb).not.toBeNull();
    expect(fb!.model).toBe(DEFAULT_FALLBACK_MODEL);
    expect(await fb!.resolve('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', 'Nezha (2019)')).toEqual({
      title: 'Ne Zha 2',
      year: 2025,
      kind: 'movie',
    });
    const { prompt, options } = seen[0]!;
    expect(prompt).toBe(buildFallbackInput('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv', 'Nezha (2019)'));
    expect(options.model).toBe('haiku');
    expect(options.systemPrompt).toBe(FALLBACK_SYSTEM_PROMPT);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.pathToClaudeCodeExecutable).toBe(bin);
    expect(options.cwd).toBe(cwd);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it('uses the configured model', async () => {
    const seen: Array<{ prompt: unknown; options: Options }> = [];
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, model: 'sonnet', query: answering('null', seen) });
    expect(await fb!.resolve('a.mkv', null)).toBeNull();
    expect(seen[0]?.options.model).toBe('sonnet');
    expect(seen[0]?.prompt).toBe('File name: a.mkv\nFolder: (library root)');
  });

  it('answers null and logs one line on an error result', async () => {
    const lines: string[] = [];
    const query: QueryFn = () =>
      (async function* () {
        yield result('quota exceeded', true);
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', 'Done')).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('quota exceeded');
    expect(lines[0]).toContain('x.mkv');
  });

  it('answers null and logs when the SDK throws', async () => {
    const lines: string[] = [];
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        throw new Error('spawn failed');
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', null)).toBeNull();
    expect(lines[0]).toContain('spawn failed');
  });

  it('answers null after the timeout', async () => {
    const lines: string[] = [];
    const query: QueryFn = ({ options }) =>
      (async function* (): AsyncGenerator<SDKMessage> {
        await new Promise<void>((resolve) => options.abortController?.signal.addEventListener('abort', () => resolve()));
        throw new Error('aborted');
      })();
    const fb = createHaikuFallback({ claudeBin: bin, cwd: dir, query, timeoutMs: 20, log: (l) => lines.push(l) });
    expect(await fb!.resolve('x.mkv', null)).toBeNull();
    expect(lines[0]).toContain('no answer within');
  });
});

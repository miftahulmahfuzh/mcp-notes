import { appendFile, mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_BACKFILL_VERSION,
  CONTEXT_MARKER_PREFIX,
  isIgnoredWatchPath,
  listTranscripts,
  sessionIdFromPath,
  subagentFromPath,
  startSessionIngest,
  type IngestBatch,
  type IngestPass,
  type SessionIngester,
  type SessionIngestOptions,
} from '../../../src/sessions/ingest.js';
import { contextWindowFor } from '../../../src/sessions/contextWindow.js';
import { createRepoResolver } from '../../../src/sessions/repoResolve.js';
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS, type SessionRow } from '../../../src/sessions/types.js';
import { copyFixtureClaudeHome, FIXTURE, MANY_PROMPTS } from '../../helpers/claudeHome.js';
import { MemoryIngestStore, MemorySettingsIngestStore } from '../../helpers/memoryIngestStore.js';

let home: string;
let store: MemoryIngestStore;
const running: SessionIngester[] = [];
const quiet = (): void => undefined;

function start(over: Partial<SessionIngestOptions> = {}): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store,
    hostname: () => 'test-host',
    resolver: createRepoResolver({
      homeDir: FIXTURE.homeDir,
      worktreesDir: FIXTURE.worktreesDir,
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: quiet,
    gitLog: async () => [],
    ...over,
  });
  running.push(ingester);
  return ingester;
}

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const mainPath = (): string => path.join(home, FIXTURE.mainFile);
const SUBAGENT_FILE = `projects/-home-u-mcp-notes/${FIXTURE.main}/subagents/agent-a1.jsonl`;
const subPath = (name = 'agent-a1.jsonl'): string => path.join(home, `projects/-home-u-mcp-notes/${FIXTURE.main}/subagents/${name}`);

/** A subagent's assistant reply with usage, and its `git commit` tool call + result. */
function subagentWork(n: number, sha: string, at: string): string {
  const base = { isSidechain: true, sessionId: FIXTURE.main, timestamp: at };
  return (
    line({
      ...base,
      type: 'assistant',
      message: {
        id: `msg_sub_${n}`,
        model: 'claude-haiku-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id: `tu_${n}`, name: 'Bash', input: { command: 'git commit -m "x"' } }],
        usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
      },
    }) +
    line({
      ...base,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: `[main ${sha}] feat: subagent work ${n}` }] },
      toolUseResult: { stdout: `[main ${sha}] feat: subagent work ${n}` },
    })
  );
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  home = await copyFixtureClaudeHome();
  store = new MemoryIngestStore();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('helpers', () => {
  it('recognises top-level session transcripts and their subagent transcripts', async () => {
    expect(sessionIdFromPath('/x/-home-u/5E55A001-0000-4000-8000-000000000001.jsonl')).toBe(FIXTURE.main);
    expect(sessionIdFromPath('/x/-home-u/agent-a1.jsonl')).toBeNull();
    expect(subagentFromPath(`/x/-home-u/${FIXTURE.main}/subagents/agent-a1.jsonl`)).toEqual({ sessionId: FIXTURE.main, agentId: 'a1' });
    expect(subagentFromPath('/x/-home-u/agent-a1.jsonl')).toBeNull();
    expect(subagentFromPath(`/x/-home-u/${FIXTURE.main}/other/agent-a1.jsonl`)).toBeNull();
    const files = (await listTranscripts(path.join(home, 'projects'))).map((f) => path.relative(home, f.path));
    // Sessions first, subagents after them.
    expect(files.slice(0, 4).sort()).toEqual(
      [FIXTURE.worktreeFile, FIXTURE.mainFile, FIXTURE.manyPromptsFile, `projects/-home-u-mcp-notes/${FIXTURE.sdkCli}.jsonl`].sort(),
    );
    expect(files.slice(4)).toEqual([SUBAGENT_FILE]);
  });

  it('watches project dirs, their transcripts and subagent transcripts, nothing else', () => {
    const root = path.join(home, 'projects');
    expect(isIgnoredWatchPath(root, root)).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes'))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes-data-chat'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', `${FIXTURE.main}.jsonl`))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', 'memory'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'subagents'))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'subagents', 'agent-a1.jsonl'))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'subagents', 'agent-a1.meta.json'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'tool-results'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', 'not-a-session', 'subagents', 'agent-a1.jsonl'))).toBe(true);
  });
});

describe('startSessionIngest', () => {
  it('backfills one row per cli session, with repo resolved, and skips sdk sessions', async () => {
    const batches: IngestBatch[] = [];
    const passes: IngestPass[] = [];
    const ingester = start({
      observers: [
        {
          onBatch: (b) => batches.push(b),
          onPassComplete: (p) => {
            passes.push(p);
          },
        },
      ],
    });
    const report = await ingester.ready;
    // 4 sessions (one sdk, skipped) and the main session's one subagent.
    expect(report).toMatchObject({ reason: 'backfill', files: 5, upserted: 4, failed: 0 });
    expect([...store.rows.keys()].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts].sort());

    const main = store.rows.get(FIXTURE.main);
    expect(main).toMatchObject({
      host: 'test-host',
      repo: 'mcp-notes',
      cwd: '/home/u/mcp-notes',
      entrypoint: 'cli',
      name: 'session-graph-discussion',
      firstPrompt: 'sketch the project-session-graph feature',
      costUsd: 1.25,
      inputTokens: 5,
      outputTokens: 914,
      transcriptPath: mainPath(),
    });
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234']);
    expect(main?.transcriptOffset).toBe((await stat(mainPath())).size);
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({ repo: 'mcp-notes', branch: 'feature/wall-editing', name: 'impl-wall-editing-p1' });

    expect(batches.map((b) => b.sessionId).sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts].sort());
    const mainBatch = batches.find((b) => b.sessionId === FIXTURE.main);
    expect(mainBatch).toMatchObject({ host: 'test-host', fromOffset: 0, transcriptPath: mainPath() });
    // Every parsed record of the read, ignored types (mode, api-request-blob, ...) excluded.
    expect(mainBatch?.records.some((r) => r.type === 'agent-name')).toBe(true);
    expect(mainBatch?.records.some((r) => r.type === 'api-request-blob')).toBe(false);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ initial: true, reason: 'backfill' });
    expect([...(passes[0]?.sessionIds ?? [])].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.manyPrompts].sort());

    await ingester.sweep();
    expect(passes[1]).toMatchObject({ initial: false, reason: 'sweep', sessionIds: [] });
  });

  it('reads only appended bytes, holds back a partial line, and adds usage without double counting', async () => {
    const ingester = start();
    await ingester.ready;
    const before = store.rows.get(FIXTURE.worktreeChild);
    const file = path.join(home, FIXTURE.worktreeFile);
    const offset = before?.transcriptOffset ?? 0;

    const next = line({
      type: 'assistant',
      timestamp: '2026-10-30T09:00:00.000Z',
      sessionId: FIXTURE.worktreeChild,
      message: { id: 'msg_Y', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }], usage: { input_tokens: 1, output_tokens: 2 } },
    });
    await appendFile(file, next.slice(0, 40));
    await ingester.sweep();
    expect(store.rows.get(FIXTURE.worktreeChild)?.transcriptOffset).toBe(offset);

    await appendFile(file, next.slice(40));
    const report = await ingester.sweep();
    expect(report.upserted).toBe(1);
    expect(report.bytes).toBe(Buffer.byteLength(next));
    const after = store.rows.get(FIXTURE.worktreeChild);
    expect(after?.transcriptOffset).toBe(offset + Buffer.byteLength(next));
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 22, finalMessage: 'Second answer.' });
    expect(after?.models['claude-opus-5-5']).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(store.patches.at(-1)).toMatchObject({ fromOffset: offset, cwd: null, repo: null });
    expect(after?.lastActiveAt?.toISOString()).toBe('2026-10-30T09:00:00.000Z');
    expect(after?.startedAt?.toISOString()).toBe('2026-10-30T08:00:00.000Z');
  });

  it('expands a push range into its commits with git log, in the cwd that printed it', async () => {
    const asked: unknown[] = [];
    const ingester = start({
      gitLog: async (range) => {
        asked.push(range);
        return [
          { sha: 'abc1234', subject: 'already seen as a commit line', at: '2026-10-30T09:00:00.000Z' },
          { sha: '81c7f3d', subject: 'fix(web): quiet commit', at: '2026-10-30T09:00:01.000Z' },
        ];
      },
    });
    await ingester.ready;
    const base = { sessionId: FIXTURE.main, timestamp: '2026-10-30T09:00:02.000Z', cwd: '/home/u/mcp-notes' };
    await appendFile(
      mainPath(),
      line({
        ...base,
        type: 'assistant',
        message: { id: 'msg_push', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_push', name: 'Bash', input: { command: 'git commit -q -m x && git push' } }] },
      }) +
        line({
          ...base,
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_push', content: 'To github.com:u/mcp-notes\n   427cb61..81c7f3d  main -> main' }] },
          toolUseResult: { stdout: '' },
        }),
    );
    await ingester.sweep();
    expect(asked).toEqual([{ from: '427cb61', to: '81c7f3d', cwd: '/home/u/mcp-notes', at: '2026-10-30T09:00:02.000Z' }]);
    expect(store.rows.get(FIXTURE.main)?.commits.map((c) => c.sha).sort()).toEqual(['81c7f3d', 'abc1234']);
  });

  it('resumes from stored offsets after a restart without re-reading', async () => {
    await start().ready;
    const writes = store.patches.length;
    const second = start();
    const report = await second.ready;
    expect(report.upserted).toBe(0);
    expect(store.patches.length).toBe(writes);
  });

  it('re-reads a file that shrank and replaces its accumulated values', async () => {
    const ingester = start();
    await ingester.ready;
    const file = path.join(home, FIXTURE.worktreeFile);
    await truncate(file, 0);
    await writeFile(
      file,
      line({ type: 'user', sessionId: FIXTURE.worktreeChild, entrypoint: 'cli', cwd: '/home/u/.worktrees/mcp-notes/wall-editing', timestamp: '2026-10-31T00:00:00.000Z', message: { role: 'user', content: 'rewritten' } }),
    );
    await ingester.sweep();
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({
      prompts: [{ text: 'rewritten', at: '2026-10-31T00:00:00.000Z' }],
      inputTokens: 0,
      name: 'impl-wall-editing-p1',
    });
  });

  it('waits for the first message before writing a session with no entry point', async () => {
    const dir = path.join(home, 'projects', '-home-u-mcp-notes');
    const id = '5e55a001-0000-4000-8000-0000000000aa';
    const file = path.join(dir, `${id}.jsonl`);
    await writeFile(file, line({ type: 'custom-title', customTitle: 'early', sessionId: id }));
    const ingester = start();
    await ingester.ready;
    expect(store.rows.has(id)).toBe(false);
    await appendFile(file, line({ type: 'user', sessionId: id, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: '2026-11-02T03:00:00.000Z', message: { role: 'user', content: 'go' } }));
    await ingester.sweep();
    expect(store.rows.get(id)).toMatchObject({ customTitle: 'early', firstPrompt: 'go', repo: 'mcp-notes' });
  });

  it('updates a row a hook created first without clearing what the hook wrote', async () => {
    store.seedRow(FIXTURE.main, 'test-host', { tmux: 'note:@0.%7', name: 'from-hook' });
    store.seedRow(FIXTURE.worktreeChild, 'test-host', { tmux: 'note:@3.%9', name: 'from-hook' });
    await start().ready;
    // The transcript's agent-name is newer truth than the hook's name; tmux is never touched.
    expect(store.rows.get(FIXTURE.main)).toMatchObject({ name: 'session-graph-discussion', tmux: 'note:@0.%7', repo: 'mcp-notes' });
    expect(store.rows.get(FIXTURE.worktreeChild)).toMatchObject({ name: 'impl-wall-editing-p1', tmux: 'note:@3.%9' });
  });

  it('adopts the stored offset after a compare-and-set miss and reads only the rest', async () => {
    const ingester = start();
    await ingester.ready;
    const file = path.join(home, FIXTURE.worktreeFile);
    const row = store.rows.get(FIXTURE.worktreeChild);
    if (!row) throw new Error('no row');
    // Another ingester (an earlier run that crashed after writing) already stored a later offset.
    const extra = line({ type: 'user', sessionId: FIXTURE.worktreeChild, timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'third' } });
    const extra2 = line({ type: 'user', sessionId: FIXTURE.worktreeChild, timestamp: '2026-10-30T11:00:00.000Z', message: { role: 'user', content: 'fourth' } });
    await appendFile(file, extra);
    store.rows.set(FIXTURE.worktreeChild, { ...row, transcriptOffset: row.transcriptOffset + Buffer.byteLength(extra) });
    await appendFile(file, extra2);
    await ingester.sweep();
    const prompts = store.rows.get(FIXTURE.worktreeChild)?.prompts.map((p) => p.text);
    expect(prompts).toEqual(['/implement -f docs/plans/WALL_EDITING_PLAN.md --phase 1', 'fourth']);
  });

  it('never writes a row that belongs to another host', async () => {
    const lines: string[] = [];
    store.seedRow(FIXTURE.main, 'other-laptop');
    await start({ log: (l) => lines.push(l) }).ready;
    expect(store.rows.get(FIXTURE.main)?.host).toBe('other-laptop');
    expect(store.rows.get(FIXTURE.main)?.firstPrompt).toBeNull();
    expect(lines.some((l) => l.includes('belongs to host other-laptop'))).toBe(true);
  });

  it('picks up an appended transcript through the watcher', async () => {
    const batches: IngestBatch[] = [];
    const ingester = start({ watch: true, debounceMs: 50 });
    ingester.addObserver({ onBatch: (b) => batches.push(b) });
    await ingester.ready;
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    await appendFile(
      mainPath(),
      line({ type: 'user', sessionId: FIXTURE.main, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: '2026-11-02T04:00:00.000Z', message: { role: 'user', content: 'one more thing' } }),
    );
    await until(() => batches.some((b) => b.sessionId === FIXTURE.main && b.fromOffset > 0));
    expect(store.rows.get(FIXTURE.main)?.prompts.map((p) => p.text)).toEqual(['sketch the project-session-graph feature', 'one more thing']);
  });

  it('picks up a new project dir and transcript through the sweep', async () => {
    const ingester = start();
    await ingester.ready;
    const id = '5e55a001-0000-4000-8000-0000000000bb';
    const dir = path.join(home, 'projects', '-home-u-seer');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), line({ type: 'user', sessionId: id, entrypoint: 'cli', cwd: '/home/u/seer', timestamp: '2026-11-02T05:00:00.000Z', message: { role: 'user', content: 'hi seer' } }));
    await ingester.sweep();
    expect(store.rows.get(id)).toMatchObject({ repo: 'seer', firstPrompt: 'hi seer' });
  });

  it('logs an observer failure and keeps ingesting', async () => {
    const lines: string[] = [];
    const ingester = start({ log: (l) => lines.push(l) });
    ingester.addObserver({
      onBatch: () => {
        throw new Error('boom');
      },
    });
    ingester.addObserver({
      onPassComplete: async () => {
        throw new Error('async boom');
      },
    });
    await ingester.ready;
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.filter((l) => l.includes('observer failed: boom'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('observer failed: async boom'))).toHaveLength(1);
    expect(store.rows.size).toBe(3);
  });

  it('closes within the grace period while a store write hangs', async () => {
    const hanging = new MemoryIngestStore();
    hanging.upsertFromTranscript = () => new Promise(() => undefined);
    store = hanging;
    const ingester = start({ closeGraceMs: 100 });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await ingester.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('startSessionIngest: subagents', () => {
  it("adds a subagent's tokens, models and commits to its parent session", async () => {
    await appendFile(subPath(), subagentWork(1, 'def5678', '2026-11-02T05:00:00.000Z'));
    await start().ready;
    const main = store.rows.get(FIXTURE.main);
    expect(main).toMatchObject({ inputTokens: 5 + 1, outputTokens: 914 + 100 });
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234', 'def5678']);
    expect(main?.models['claude-haiku-5-5']).toEqual({ inputTokens: 1, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 10 });
    expect(main?.lastActiveAt?.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(store.subagents.get(subPath())).toMatchObject({ sessionId: FIXTURE.main, offset: (await stat(subPath())).size });
  });

  it('tails appended subagent bytes, and a restart resumes from the stored offset', async () => {
    const ingester = start();
    await ingester.ready;
    await appendFile(subPath(), subagentWork(2, 'aaa1111', '2026-11-02T02:24:00.000Z'));
    await ingester.sweep();
    await appendFile(subPath(), subagentWork(3, 'bbb2222', '2026-11-02T02:25:00.000Z'));
    await ingester.sweep();
    await start().ready; // a restart: nothing read twice
    const main = store.rows.get(FIXTURE.main);
    expect(main).toMatchObject({ outputTokens: 914 + 200 });
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234', 'aaa1111', 'bbb2222']);
  });

  it('waits for the parent row before reading a subagent', async () => {
    const orphan = `projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-0000000000ff/subagents/agent-z9.jsonl`;
    await mkdir(path.dirname(path.join(home, orphan)), { recursive: true });
    await writeFile(path.join(home, orphan), subagentWork(4, 'ccc3333', '2026-11-02T02:26:00.000Z'));
    await start().ready;
    expect(store.subagents.has(path.join(home, orphan))).toBe(false);
    expect(store.rows.has('5e55a001-0000-4000-8000-0000000000ff')).toBe(false);
  });

  it("a main transcript re-read from byte 0 keeps the subagents' share", async () => {
    await appendFile(subPath(), subagentWork(5, 'ddd4444', '2026-11-02T02:27:00.000Z'));
    const ingester = start();
    await ingester.ready;
    const before = store.rows.get(FIXTURE.main);
    // Shrink the main transcript: it is read again from 0 and its own values replaced.
    const size = (await stat(mainPath())).size;
    await truncate(mainPath(), size - 1);
    await appendFile(mainPath(), '\n');
    await ingester.sweep();
    const after = store.rows.get(FIXTURE.main);
    expect(after).toMatchObject({ inputTokens: before?.inputTokens, outputTokens: before?.outputTokens });
    expect(after?.commits.map((c) => c.sha).sort()).toEqual(['abc1234', 'ddd4444']);
  });

  it('a subagent transcript that shrank is re-read, its old share taken out of the parent first', async () => {
    await appendFile(subPath(), subagentWork(6, 'eee5555', '2026-11-02T02:28:00.000Z'));
    const ingester = start();
    await ingester.ready;
    expect(store.rows.get(FIXTURE.main)?.outputTokens).toBe(914 + 100);
    // Rewritten shorter: one reply of 7 output tokens, no commit.
    await writeFile(
      subPath(),
      line({
        isSidechain: true,
        sessionId: FIXTURE.main,
        timestamp: '2026-11-02T02:29:00.000Z',
        type: 'assistant',
        message: { id: 'msg_sub_7', model: 'claude-haiku-5-5', role: 'assistant', content: [], usage: { output_tokens: 7 } },
      }),
    );
    await ingester.sweep();
    const main = store.rows.get(FIXTURE.main);
    expect(main?.outputTokens).toBe(914 + 7);
    expect(main?.models['claude-haiku-5-5']).toEqual({ inputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Commits are only ever added.
    expect(main?.commits.map((c) => c.sha)).toContain('eee5555');
  });
});

describe('startSessionIngest: prompts backfill', () => {
  const KEY = MANY_PROMPTS.fakeKey;
  const withoutPrompts = (r: SessionRow | undefined): Partial<SessionRow> => {
    if (r === undefined) return {};
    const { prompts, firstPrompt, lastPrompt, promptsVersion, ...rest } = r;
    void prompts;
    void firstPrompt;
    void lastPrompt;
    void promptsVersion;
    return rest;
  };

  it('stores every prompt of a fresh session and marks it current, so the backfill has nothing to do', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
    expect(store.rows.get(FIXTURE.manyPrompts)?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(store.rows.get(FIXTURE.manyPrompts)?.prompts).toHaveLength(100);
  });

  it("replaces a legacy row's prompts from its transcript and changes nothing else", async () => {
    await start().promptsBackfill; // the first start's one-time backfills are done before the row is aged
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: 0, prompts: [{ text: `legacy ${KEY}`, at: null }], lastPrompt: `legacy ${KEY}` });
    store.sidePrompts.delete(FIXTURE.manyPrompts);
    const writes = store.patches.length;
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(store.patches.length).toBe(writes);
    const after = store.rows.get(FIXTURE.manyPrompts);
    expect(after?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(withoutPrompts(after)).toEqual(withoutPrompts(row));
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
    expect(JSON.stringify([after, store.sidePrompts.get(FIXTURE.manyPrompts)])).not.toContain(KEY);
  });

  it('retries once with the stored offset after a compare-and-set miss', async () => {
    await start().promptsBackfill; // the first start's one-time backfills are done before the row is aged
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: 0 });
    const real = store.replacePrompts.bind(store);
    let calls = 0;
    store.replacePrompts = async (id, host, input) => {
      calls += 1;
      return calls === 1 ? { status: 'offset_mismatch', storedOffset: row.transcriptOffset } : real(id, host, input);
    };
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ filled: 1 });
    expect(calls).toBe(2);
  });

  it('redacts stored prompts in place when the transcript is gone, marks them excerpts-only, and skips them next time', async () => {
    const id = '5e55a001-0000-4000-8000-0000000000dd';
    store.seedRow(id, 'test-host', {
      transcriptPath: path.join(home, `projects/-home-u-mcp-notes/${id}.jsonl`),
      transcriptOffset: 50,
      prompts: [{ text: `use ${KEY} now…`, at: null }],
    });
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ redacted: 1 });
    expect(store.rows.get(id)).toMatchObject({ promptsVersion: PROMPTS_VERSION_EXCERPTS, prompts: [{ text: 'use [redacted] now…', at: null }], transcriptOffset: 50 });
    expect(store.sidePrompts.get(id)).toEqual([{ text: 'use [redacted] now…', at: null, truncated: true, images: [] }]);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, skipped: 1, redacted: 0, filled: 0 });
    expect(store.rows.get(id)?.promptsVersion).toBe(PROMPTS_VERSION_EXCERPTS);
  });

  it('fills a row redacted in place once its transcript is readable again', async () => {
    await start().promptsBackfill; // the first start's one-time backfills are done before the row is aged
    const row = store.rows.get(FIXTURE.manyPrompts);
    if (!row) throw new Error('no row');
    store.rows.set(FIXTURE.manyPrompts, { ...row, promptsVersion: PROMPTS_VERSION_EXCERPTS });
    store.sidePrompts.set(FIXTURE.manyPrompts, [{ text: 'excerpt…', at: null, truncated: true, images: [] }]);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1 });
    expect(store.rows.get(FIXTURE.manyPrompts)?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(store.sidePrompts.get(FIXTURE.manyPrompts)).toHaveLength(MANY_PROMPTS.count);
  });

  it("never reads outside its own Claude home and never touches another host's rows", async () => {
    store.seedRow('5e55a001-0000-4000-8000-0000000000de', 'test-host', { transcriptPath: '/elsewhere/x.jsonl', transcriptOffset: 10, prompts: [{ text: `a ${KEY}`, at: null }] });
    store.seedRow('5e55a001-0000-4000-8000-0000000000df', 'other-laptop', { prompts: [{ text: `b ${KEY}`, at: null }] });
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 1, deferred: 1 });
    expect(store.rows.get('5e55a001-0000-4000-8000-0000000000de')?.promptsVersion).toBe(0);
    expect(store.rows.get('5e55a001-0000-4000-8000-0000000000df')?.prompts[0]?.text).toBe(`b ${KEY}`);
  });
});

describe('startSessionIngest: prompts backfill honours the fork cut (R2.2)', () => {
  it('re-reads a fork row without the records copied before fork_cut_offset', async () => {
    const sid = 'f0f0f0f0-0000-4000-8000-00000000f0f0';
    const file = path.join(home, 'projects/-home-u-mcp-notes', `${sid}.jsonl`);
    const base = { sessionId: sid, cwd: '/home/u/mcp-notes', entrypoint: 'cli', version: '2.1.0' };
    const copied = line({ ...base, type: 'user', uuid: 'cp-1', parentUuid: null, timestamp: '2026-11-11T01:00:00.000Z', message: { role: 'user', content: 'copied parent prompt' } });
    const loose = line({ type: 'custom-title', sessionId: sid, customTitle: 'forked work' });
    const own = line({ ...base, type: 'user', uuid: 'own-1', parentUuid: 'cp-1', timestamp: '2026-11-11T01:20:00.000Z', message: { role: 'user', content: 'the fork own prompt' } });
    await writeFile(file, copied + loose + own);
    await start().promptsBackfill; // the first start's one-time backfills are done before the row is aged
    const row = store.rows.get(sid);
    if (!row) throw new Error('no row');
    // A fork row as phase 2 stores it, left below PROMPTS_VERSION so the backfill re-reads it.
    store.rows.set(sid, { ...row, promptsVersion: 0, forkCutOffset: Buffer.byteLength(copied + loose) });
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(store.sidePrompts.get(sid)?.map((p) => p.text)).toEqual(['the fork own prompt']);
    expect(store.rows.get(sid)?.firstPrompt).toBe('the fork own prompt');
  });
});

/** The main fixture's context as ingest reads it: msg_D (1 + 32,000 + 0 + 20) is the latest, msg_A (2 + 29,065 + 20,795 + 544) the first and largest. */
const MAIN_CONTEXT = {
  contextTokens: 32_021,
  contextModel: 'claude-opus-5-5',
  contextAt: new Date('2026-11-02T02:23:10.000Z'),
  contextPeakTokens: 50_406,
  contextFirstTokens: 50_406,
  contextLongBeta: false,
};
const NO_CONTEXT = { contextTokens: null, contextModel: null, contextAt: null, contextPeakTokens: null, contextFirstTokens: null, contextLongBeta: false };

function mainAssistant(id: string, usage: Record<string, number>, at: string, model = 'claude-opus-5-5'): string {
  return line({
    type: 'assistant',
    sessionId: FIXTURE.main,
    uuid: `u-${id}`,
    timestamp: at,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }], usage },
  });
}

function apiRequest(querySource: string, betas: string[]): string {
  return line({ type: 'api-request', sessionId: FIXTURE.main, id: `req-${querySource}`, timestamp: '2026-11-02T03:00:00.000Z', querySource, params: { model: 'claude-sonnet-4-6', betas }, tail: [] });
}

describe('startSessionIngest: context capture', () => {
  const main = (): SessionRow => {
    const r = store.rows.get(FIXTURE.main);
    if (r === undefined) throw new Error('no main row');
    return r;
  };

  it('stores the latest main-chain context; sidechain records and subagent transcripts never move it (R1.2)', async () => {
    const ingester = start();
    await ingester.ready;
    expect(main()).toMatchObject(MAIN_CONTEXT);
    const inputBefore = main().inputTokens;
    await appendFile(mainPath(), subagentWork(7, 'aaaa111', '2026-11-02T03:00:00.000Z'));
    await appendFile(subPath(), subagentWork(8, 'bbbb222', '2026-11-02T03:00:01.000Z'));
    await ingester.sweep();
    expect(main().inputTokens).toBe(inputBefore + 1); // the subagent transcript was read
    expect(main()).toMatchObject(MAIN_CONTEXT);
  });

  it('stores the later, smaller context after a compaction and keeps the peak and the first message (R1.3)', async () => {
    const ingester = start();
    await ingester.ready;
    await appendFile(mainPath(), mainAssistant('msg_E', { input_tokens: 1, cache_read_input_tokens: 4_000, output_tokens: 10 }, '2026-11-02T03:10:00.000Z'));
    await ingester.sweep();
    expect(main()).toMatchObject({ ...MAIN_CONTEXT, contextTokens: 4_011, contextAt: new Date('2026-11-02T03:10:00.000Z') });
  });

  it('keeps a peak above 200,000 after the context falls, which infers a 1M window (R2.2)', async () => {
    const ingester = start();
    await ingester.ready;
    await appendFile(
      mainPath(),
      mainAssistant('msg_F', { input_tokens: 1, cache_read_input_tokens: 249_000, cache_creation_input_tokens: 999 }, '2026-11-02T03:20:00.000Z', 'claude-sonnet-4-6') +
        mainAssistant('msg_G', { input_tokens: 5_000 }, '2026-11-02T03:21:00.000Z', 'claude-sonnet-4-6'),
    );
    await ingester.sweep();
    const r = main();
    expect(r).toMatchObject({ contextTokens: 5_000, contextModel: 'claude-sonnet-4-6', contextPeakTokens: 250_000, contextLongBeta: false });
    expect(contextWindowFor({ model: r.contextModel, peakTokens: r.contextPeakTokens, longBeta: r.contextLongBeta })).toEqual({ window: 1_000_000, source: 'peak' });
  });

  it('flags a context-1m beta from a main-thread api-request line only, without parsing it into the batch (R2.3)', async () => {
    const batches: IngestBatch[] = [];
    const ingester = start({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await ingester.ready;
    await appendFile(
      mainPath(),
      apiRequest('agent:builtin:Explore', ['claude-code-20250219', 'context-1m-2025-08-07']) +
        line({ type: 'user', sessionId: FIXTURE.main, uuid: 'u-q', timestamp: '2026-11-02T03:30:00.000Z', cwd: '/home/u/mcp-notes', entrypoint: 'cli', message: { role: 'user', content: 'what does "context-1m-2025-08-07" do?' } }) +
        apiRequest('repl_main_thread', ['claude-code-20250219']) +
        mainAssistant('msg_H', { input_tokens: 92_484 }, '2026-11-02T03:30:05.000Z', 'claude-sonnet-4-6'),
    );
    await ingester.sweep();
    expect(main()).toMatchObject({ contextTokens: 92_484, contextLongBeta: false });
    expect(contextWindowFor({ model: main().contextModel, peakTokens: main().contextPeakTokens, longBeta: main().contextLongBeta })).toEqual({ window: 200_000, source: 'model' });

    await appendFile(mainPath(), apiRequest('repl_main_thread:outputStyle:Explanatory', ['claude-code-20250219', 'context-1m-2025-08-07']));
    await ingester.sweep();
    const r = main();
    expect(r).toMatchObject({ contextTokens: 92_484, contextLongBeta: true });
    expect(contextWindowFor({ model: r.contextModel, peakTokens: r.contextPeakTokens, longBeta: r.contextLongBeta })).toEqual({ window: 1_000_000, source: 'beta' });
    expect(batches.flatMap((b) => b.records).some((rec) => rec.type === 'api-request')).toBe(false);
  });
});

describe('startSessionIngest: context backfill', () => {
  const marker = `${CONTEXT_MARKER_PREFIX}test-host`;
  const age = (s: MemorySettingsIngestStore): void => {
    for (const [id, r] of s.rows) s.rows.set(id, { ...r, ...NO_CONTEXT });
  };

  it("fills each of the host's rows once from its transcript and writes its marker (R1.5)", async () => {
    const s = new MemorySettingsIngestStore();
    store = s;
    const first = start();
    expect(await first.contextBackfill).toMatchObject({ ran: true, failed: 0, deferred: 0 });
    await first.close();
    age(s); // what a daemon without context capture left behind
    await s.putSetting(marker, null);

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, rows: 3, filled: 3, missing: 0, deferred: 0, failed: 0 });
    expect(s.rows.get(FIXTURE.main)).toMatchObject(MAIN_CONTEXT);
    expect(s.rows.get(FIXTURE.worktreeChild)).toMatchObject({ contextTokens: 370, contextFirstTokens: 370, contextPeakTokens: 370 });
    expect(await s.getSetting(marker)).toMatchObject({ version: CONTEXT_BACKFILL_VERSION, rows: 3, filled: 3 });
    await second.close();

    age(s);
    expect(await start().contextBackfill).toMatchObject({ ran: false });
    expect(s.rows.get(FIXTURE.main)?.contextTokens).toBeNull(); // once per host: the marker stops a second run
  });

  it('skips a transcript that is gone without a write, and still writes the marker', async () => {
    const s = new MemorySettingsIngestStore();
    store = s;
    const first = start();
    await first.contextBackfill;
    await first.close();
    age(s);
    await s.putSetting(marker, null);
    await rm(mainPath());

    const second = start();
    expect(await second.contextBackfill).toMatchObject({ ran: true, rows: 3, filled: 2, missing: 1, failed: 0 });
    expect(s.rows.get(FIXTURE.main)).toMatchObject(NO_CONTEXT);
    expect(await s.getSetting(marker)).toMatchObject({ version: CONTEXT_BACKFILL_VERSION, missing: 1 });
  });
});

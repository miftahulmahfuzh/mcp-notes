import { appendFile, mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isIgnoredWatchPath,
  listTranscripts,
  sessionIdFromPath,
  startSessionIngest,
  type IngestBatch,
  type IngestPass,
  type SessionIngester,
  type SessionIngestOptions,
} from '../../../src/sessions/ingest.js';
import { createRepoResolver } from '../../../src/sessions/repoResolve.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

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
    ...over,
  });
  running.push(ingester);
  return ingester;
}

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const mainPath = (): string => path.join(home, FIXTURE.mainFile);

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
  it('recognises top-level session transcripts only', async () => {
    expect(sessionIdFromPath('/x/-home-u/5E55A001-0000-4000-8000-000000000001.jsonl')).toBe(FIXTURE.main);
    expect(sessionIdFromPath('/x/-home-u/agent-a1.jsonl')).toBeNull();
    const files = (await listTranscripts(path.join(home, 'projects'))).map((f) => path.relative(home, f.path)).sort();
    expect(files).toEqual([FIXTURE.worktreeFile, FIXTURE.mainFile, `projects/-home-u-mcp-notes/${FIXTURE.sdkCli}.jsonl`].sort());
  });

  it('watches project dirs and their transcripts, nothing deeper', () => {
    const root = path.join(home, 'projects');
    expect(isIgnoredWatchPath(root, root)).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes'))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes-data-chat'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', `${FIXTURE.main}.jsonl`))).toBe(false);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', 'memory'))).toBe(true);
    expect(isIgnoredWatchPath(root, path.join(root, '-home-u-mcp-notes', FIXTURE.main, 'subagents', 'agent-a1.jsonl'))).toBe(true);
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
    expect(report).toMatchObject({ reason: 'backfill', files: 3, upserted: 2, failed: 0 });
    expect([...store.rows.keys()].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());

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

    expect(batches.map((b) => b.sessionId).sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());
    const mainBatch = batches.find((b) => b.sessionId === FIXTURE.main);
    expect(mainBatch).toMatchObject({ host: 'test-host', fromOffset: 0, transcriptPath: mainPath() });
    // Every parsed record of the read, ignored types (mode, api-request-blob, ...) excluded.
    expect(mainBatch?.records.some((r) => r.type === 'agent-name')).toBe(true);
    expect(mainBatch?.records.some((r) => r.type === 'api-request-blob')).toBe(false);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ initial: true, reason: 'backfill' });
    expect([...(passes[0]?.sessionIds ?? [])].sort()).toEqual([FIXTURE.main, FIXTURE.worktreeChild].sort());

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
    expect(lines.filter((l) => l.includes('observer failed: boom'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('observer failed: async boom'))).toHaveLength(1);
    expect(store.rows.size).toBe(2);
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

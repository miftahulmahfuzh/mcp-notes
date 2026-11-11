import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LINKS_BACKFILL_VERSION,
  LINKS_MARKER_PREFIX,
  scanTranscriptForIntents,
  startLinkWorker,
  type LinkSession,
  type LinkStore,
  type LinkWorker,
  type TranscriptRef,
} from '../../../src/sessions/links.js';

const HOST = 'lenovo';
const HOME = '/home/u';
const WT = '/home/u/.worktrees/demo/x';
const T = Date.parse('2026-10-30T09:19:49.264Z');
const at = (ms: number) => new Date(T + ms);

function session(over: Partial<LinkSession> & { sessionId: string }): LinkSession {
  return {
    host: HOST,
    repo: 'demo',
    cwd: WT,
    name: null,
    customTitle: null,
    startedAt: at(0),
    parentSessionId: null,
    parentLinkSource: null,
    ...over,
  };
}

function bash(sessionId: string, ms: number, command: string): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    cwd: WT,
    timestamp: at(ms).toISOString(),
    message: { content: [{ type: 'tool_use', id: `t${ms}`, name: 'Bash', input: { command } }] },
  };
}

function fakeStore(sessions: LinkSession[], transcripts: TranscriptRef[] = []) {
  const settings = new Map<string, unknown>();
  const calls = { transcripts: 0, setParent: [] as Array<[string, string]> };
  const store: LinkStore = {
    async sessionsByIds(ids) {
      return sessions.filter((s) => ids.includes(s.sessionId));
    },
    async sessionsByNames(host, names) {
      return sessions.filter(
        (s) => s.host === host && ((s.name !== null && names.includes(s.name)) || (s.customTitle !== null && names.includes(s.customTitle))),
      );
    },
    async transcriptsOnHost() {
      calls.transcripts += 1;
      return transcripts;
    },
    async setParent(child, parent) {
      calls.setParent.push([child, parent]);
      const s = sessions.find((x) => x.sessionId === child);
      if (s && s.parentSessionId === null) {
        s.parentSessionId = parent;
        s.parentLinkSource = 'heuristic';
      }
    },
    async readSetting(key) {
      return settings.get(key) ?? null;
    },
    async writeSetting(key, value) {
      settings.set(key, value);
    },
  };
  return { store, settings, calls };
}

let dir: string;
let workers: LinkWorker[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'links-'));
  workers = [];
});

afterEach(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

function start(store: LinkStore, over: Partial<Parameters<typeof startLinkWorker>[0]> = {}): LinkWorker {
  const w = startLinkWorker({ store, host: HOST, home: HOME, debounceMs: 60_000, log: () => {}, onError: () => {}, ...over });
  workers.push(w);
  return w;
}

async function writeTranscript(name: string, records: unknown[], partialTail = ''): Promise<string> {
  const file = path.join(dir, `${name}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n' + partialTail);
  return file;
}

describe('scanTranscriptForIntents', () => {
  it('reads intents, skips a partial last line, and returns [] for a missing file', async () => {
    const file = await writeTranscript(
      'orch',
      [{ type: 'user', message: { content: 'hi' } }, bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 1')],
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"to":"impl-x-p9"',
    );
    const intents = await scanTranscriptForIntents(file, 'orch', { home: HOME });
    expect(intents.map((i) => i.name)).toEqual(['impl-x-p1']);
    expect(await scanTranscriptForIntents(path.join(dir, 'gone.jsonl'), 'gone', { home: HOME })).toEqual([]);
  });
});

describe('startLinkWorker backfill', () => {
  it('links from transcripts once, writes the marker, and skips the scan next time', async () => {
    const file = await writeTranscript('orch', [
      bash('orch', 0, 'S=~/.claude/skills/swarm/swarm.py; for n in 1 2; do python3 $S spawn --slug x --phase $n; done'),
    ]);
    const sessions = [
      session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'p1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'p2', name: 'impl-x-p2', startedAt: at(4_000), parentSessionId: 'y', parentLinkSource: 'env' }),
    ];
    const { store, settings, calls } = fakeStore(sessions, [{ sessionId: 'orch', transcriptPath: file }]);
    const w = start(store);
    await w.onPassComplete({ initial: true });

    expect(calls.setParent).toEqual([['p1', 'orch']]);
    expect(sessions[2]!.parentSessionId).toBe('y');
    expect(settings.get(`${LINKS_MARKER_PREFIX}${HOST}`)).toMatchObject({ version: LINKS_BACKFILL_VERSION, linked: 1, intents: 2, matched: 2 });

    const again = start(store);
    await again.onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(1);
  });

  it('re-runs when the marker carries an older version', async () => {
    const { store, settings, calls } = fakeStore([], []);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION - 1 });
    await start(store).onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(1);
    expect(settings.get(`${LINKS_MARKER_PREFIX}${HOST}`)).toMatchObject({ version: LINKS_BACKFILL_VERSION });
  });

  it('never rejects when the store fails, and writes no marker', async () => {
    const { store, settings } = fakeStore([], []);
    store.transcriptsOnHost = async () => {
      throw new Error('db down');
    };
    const onError = vi.fn();
    await expect(start(store, { onError }).onPassComplete({ initial: true })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('backfill', expect.any(Error));
    expect(settings.size).toBe(0);
  });
});

describe('startLinkWorker live path', () => {
  it('holds an intent until its child is ingested, then links it', async () => {
    const sessions = [session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) })];
    const { store, settings, calls } = fakeStore(sessions);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION });
    const w = start(store, { now: () => at(5_000) });
    await w.onPassComplete({ initial: true });

    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 3')] });
    expect(w.pendingCount()).toBe(1);
    await w.drainNow();
    expect(w.pendingCount()).toBe(1);
    expect(calls.setParent).toEqual([]);

    sessions.push(session({ sessionId: 'p3', name: 'impl-x-p3', startedAt: at(3_000) }));
    w.onBatch({ sessionId: 'p3', records: [] });
    await w.drainNow();
    expect(calls.setParent).toEqual([['p3', 'orch']]);
    expect(w.pendingCount()).toBe(0);
  });

  it('drops an intent whose window has long passed', async () => {
    const sessions = [session({ sessionId: 'orch', name: 'orch-x', startedAt: at(-60_000) })];
    const { store, settings } = fakeStore(sessions);
    settings.set(`${LINKS_MARKER_PREFIX}${HOST}`, { version: LINKS_BACKFILL_VERSION });
    const w = start(store, { now: () => at(30 * 60_000) });
    await w.onPassComplete({ initial: true });
    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 3')] });
    await w.drainNow();
    expect(w.pendingCount()).toBe(0);
  });

  it('does nothing after close', async () => {
    const { store, calls } = fakeStore([session({ sessionId: 'orch', startedAt: at(-1) })]);
    const w = start(store);
    await w.close();
    w.onBatch({ sessionId: 'orch', records: [bash('orch', 0, 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase 1')] });
    expect(w.pendingCount()).toBe(0);
    await w.onPassComplete({ initial: true });
    expect(calls.transcripts).toBe(0);
  });

  it('survives a record that is not an object', () => {
    const { store } = fakeStore([]);
    const w = start(store);
    expect(() => w.onBatch({ sessionId: 's', records: [null, 7, 'x', { type: 'assistant', message: 'nope' }] })).not.toThrow();
  });
});

describe('fork cut (R2.2)', () => {
  const SPAWN = (n: number): string => `python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase ${n}`;

  /** header (no uuid) + a copied spawn of p1 (uuid) + a uuid-less spawn of p3 + the fork's own spawn of p2 (cut lands here). */
  async function forkTranscript(): Promise<{ file: string; cut: number }> {
    const header = { type: 'ai-title', aiTitle: 'fork', sessionId: 'fork' };
    const copied = { ...bash('fork', 0, SPAWN(1)), uuid: 'c-1', parentUuid: null };
    const loose = bash('fork', 1_000, SPAWN(3));
    const own = { ...bash('fork', 2_000, SPAWN(2)), uuid: 'o-1', parentUuid: 'c-1' };
    const file = await writeTranscript('fork', [header, copied, loose, own]);
    const cut = Buffer.byteLength([header, copied, loose].map((r) => `${JSON.stringify(r)}\n`).join(''));
    return { file, cut };
  }

  it('scanTranscriptForIntents skips records with a uuid before the cut and reads every other record', async () => {
    const { file, cut } = await forkTranscript();
    const names = async (forkCutOffset: number | null) =>
      (await scanTranscriptForIntents(file, 'fork', { home: HOME, forkCutOffset })).map((i) => i.name);
    expect(await names(cut)).toEqual(['impl-x-p3', 'impl-x-p2']);
    expect(await names(null)).toEqual(['impl-x-p1', 'impl-x-p3', 'impl-x-p2']);
  });

  it("the backfill links no child from a fork's copied history", async () => {
    const { file, cut } = await forkTranscript();
    const sessions = [
      session({ sessionId: 'fork', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'c1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'c2', name: 'impl-x-p2', startedAt: at(5_000) }),
    ];
    const { store, calls } = fakeStore(sessions, [{ sessionId: 'fork', transcriptPath: file, forkCutOffset: cut }]);
    await start(store).onPassComplete({ initial: true });
    expect(calls.setParent).toEqual([['c2', 'fork']]);
  });

  it('the backfill scan waits for backfillAfter, then reads the cut it left', async () => {
    const { file, cut } = await forkTranscript();
    const sessions = [
      session({ sessionId: 'fork', name: 'orch-x', startedAt: at(-60_000) }),
      session({ sessionId: 'c1', name: 'impl-x-p1', startedAt: at(3_000) }),
      session({ sessionId: 'c2', name: 'impl-x-p2', startedAt: at(5_000) }),
    ];
    // The fork backfill stores the cut only when it settles; before that the ref has none.
    const refs = [{ sessionId: 'fork', transcriptPath: file, forkCutOffset: null as number | null }];
    const { store, calls } = fakeStore(sessions, refs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        refs[0]!.forkCutOffset = cut;
        resolve();
      };
    });
    const pass = start(store, { backfillAfter: () => gate }).onPassComplete({ initial: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.setParent).toEqual([]);
    release();
    await pass;
    expect(calls.setParent).toEqual([['c2', 'fork']]);
  });
});

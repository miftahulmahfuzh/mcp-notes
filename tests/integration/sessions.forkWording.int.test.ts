import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpToolDeps } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { resetGraphCache, type SessionsReadOverrides } from '../../src/sessions/readModel.js';
import type { ContextPayload, GraphPayload, SearchPayload, SessionDetail, TranscriptPayload } from '../../src/sessions/view.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, seedGraph, seedSession, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

/**
 * session-fork-awareness phase 5: the read surfaces describe a fork and a live background job.
 * F5-55 (sess-f5) is a fork of A0-3G (sess-root) made after A0-3G's first prompt, live as
 * background job f5f5f5f5. Its transcript starts with the two records it copied from A0-3G
 * (after a uuid-less agent-name line), then its own two.
 */
const JOB_ID = 'f5f5f5f5';
const FORKED_AT = '2026-10-31T19:00:00Z'; // 2026-11-01 02:00 in Asia/Jakarta
const FORK_OF = 'fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)';

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  commitLinks: async () => new Map(),
  live: async () => [{ sessionId: 'sess-f5', status: 'idle', tmux: null, jobId: JOB_ID }],
  search: async () => ({
    mode: 'hybrid',
    fallback: null,
    hits: [
      { sessionId: 'sess-f5', score: 0.9 },
      { sessionId: 'sess-root', score: 0.5 },
    ],
  }),
};

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let h: ApiHarness;
let app: Hono;
let client: Client;
let rootTranscript: { file: string; cleanup: () => Promise<void> };
let forkDir: string;
let forkFile: string;
let cut: number;

async function get<T>(pathname: string): Promise<T> {
  const res = await app.request(pathname);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(r.content.map((c) => c.text ?? '').join('\n')) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', sessionsApiRoutes(h.deps, overrides));
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'fork-wording', version: '0.0.0' });
  await client.connect(clientSide);
  rootTranscript = await writeTranscript();
  forkDir = await mkdtemp(path.join(os.tmpdir(), 'cc-fork-'));
  forkFile = path.join(forkDir, 'sess-f5.jsonl');
  const beforeCut = [
    { type: 'agent-name', agentName: 'fork-fixture', sessionId: 'sess-f5' },
    { type: 'user', uuid: 'u-1', timestamp: '2026-10-31T18:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
    { type: 'assistant', uuid: 'a-1', timestamp: '2026-10-31T18:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }] } },
  ];
  const own = [
    { type: 'user', uuid: 'u-2', timestamp: '2026-10-31T19:05:00Z', message: { role: 'user', content: 'Add an undo toast for photo delete' } },
    { type: 'assistant', uuid: 'a-2', timestamp: '2026-10-31T19:06:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The undo toast is in.' }] } },
  ];
  const head = beforeCut.map((r) => `${JSON.stringify(r)}\n`).join('');
  cut = Buffer.byteLength(head, 'utf8');
  await writeFile(forkFile, head + own.map((r) => `${JSON.stringify(r)}\n`).join(''));
});

afterAll(async () => {
  await client.close();
  await clearSessions(h.deps.db);
  await rootTranscript.cleanup();
  await rm(forkDir, { recursive: true, force: true });
  await h.close();
});

beforeEach(async () => {
  resetGraphCache();
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, rootTranscript.file);
  await seedSession(h.deps.db, {
    sessionId: 'sess-f5',
    nodeId: 'F5-55',
    firstPrompt: 'Add an undo toast for photo delete',
    startedAt: '2026-10-31T19:05:00Z',
    lastActiveAt: '2026-10-31T19:06:00Z',
    inputTokens: 5,
    transcriptPath: forkFile,
  });
  await h.deps.db.execute(sql`
    update cc_sessions
    set parent_session_id = 'sess-root', parent_link_source = 'fork',
        forked_at = ${FORKED_AT}::timestamptz, fork_prompt_count = 1, fork_cut_offset = ${cut},
        fork_detected_by = 'uuid'
    where session_id = 'sess-f5'`);
});

describe('fork and background-job wording', () => {
  it('API: the fork point and the job id are on every node shape', async () => {
    const forkPoint = { parent_node_id: 'A0-3G', forked_at: '2026-10-31T19:00:00.000Z', prompt_count: 1 };
    const fork = await get<SessionDetail>('/api/sessions/F5-55');
    expect(fork.session).toMatchObject({ parent_link_source: 'fork', fork: forkPoint, live: true, job_id: JOB_ID });
    expect(fork.parent).toMatchObject({ node_id: 'A0-3G', fork: null, job_id: null });

    const root = await get<SessionDetail>('/api/sessions/A0-3G');
    expect(root.session).toMatchObject({ fork: null, job_id: null });
    expect(root.children.find((c) => c.node_id === 'F5-55')).toMatchObject({ fork: forkPoint, job_id: JOB_ID });

    const graph = await get<GraphPayload>('/api/projects/mcp-notes/sessions');
    expect(graph.nodes.find((n) => n.node_id === 'F5-55')).toMatchObject({ fork: forkPoint, job_id: JOB_ID });
    expect(graph.nodes.find((n) => n.node_id === 'B1-22')).toMatchObject({ parent_link_source: 'env', fork: null });

    const search = await get<SearchPayload>('/api/sessions/search?q=undo');
    expect(search.hits[0]).toMatchObject({ node_id: 'F5-55', fork: forkPoint });
  });

  it('hook context: "Fork of <parent>" with the fork point, and claude attach for the live job', async () => {
    const forkCtx = await get<ContextPayload>('/api/sessions/context?ids=F5-55');
    const text = forkCtx.nodes[0]!.text;
    expect(text).toContain('Fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)');
    expect(text).not.toContain('Parent:');
    expect(text).toContain(`Transcript: ${forkFile} (attach with: claude attach ${JOB_ID})`);
    expect(text).not.toContain('claude --resume');

    const rootCtx = await get<ContextPayload>('/api/sessions/context?ids=A0-3G');
    expect(rootCtx.nodes[0]!.text).toContain(`(resume with: claude --resume sess-root)`);
    expect(rootCtx.nodes[0]!.text).not.toContain('Fork of');
  });

  it('MCP session_get and sessions_search say "fork of <parent>"; session_get gives the way back in', async () => {
    const fork = await callJson<{ session: { fork_of: string | null; resume_command: string | null; job_id: string | null } }>('session_get', { node_id: 'f555' });
    expect(fork.session).toMatchObject({ fork_of: FORK_OF, resume_command: `claude attach ${JOB_ID}`, job_id: JOB_ID });

    const root = await callJson<{ session: { fork_of: string | null; resume_command: string | null } }>('session_get', { node_id: 'A0-3G' });
    expect(root.session).toMatchObject({ fork_of: null, resume_command: 'claude --resume sess-root' });

    const remote = await callJson<{ session: { resume_command: string | null } }>('session_get', { node_id: 'C2-33' });
    expect(remote.session.resume_command).toBeNull();

    const hits = await callJson<{ hits: Array<{ node_id: string; fork_of: string | null }> }>('sessions_search', { query: 'undo toast' });
    expect(hits.hits.map((x) => [x.node_id, x.fork_of])).toEqual([
      ['F5-55', FORK_OF],
      ['A0-3G', null],
    ]);
  });

  it('session_transcript on a fork searches only what the fork added', async () => {
    const copied = await callJson<TranscriptPayload>('session_transcript', { node_id: 'F5-55', query: 'recycle bin' });
    expect(copied).toMatchObject({ starts_at_fork_point: true, total_matches: 0, matches: [] });

    const own = await callJson<TranscriptPayload>('session_transcript', { node_id: 'F5-55', query: 'photo delete' });
    expect(own.total_matches).toBe(1);
    expect(own.matches[0]).toMatchObject({ line: 4, role: 'user' });
    expect(own.matches[0]!.excerpt).toContain('undo toast');

    const api = await get<TranscriptPayload>('/api/sessions/F5-55/transcript?query=recycle%20bin');
    expect(api).toMatchObject({ starts_at_fork_point: true, total_matches: 0 });

    const root = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?query=recycle%20bin');
    expect(root).toMatchObject({ starts_at_fork_point: false, total_matches: 1 });
  });
});

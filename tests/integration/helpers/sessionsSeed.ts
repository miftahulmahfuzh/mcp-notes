import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';

export const THIS_HOST = 'this-host-test';
export const OTHER_HOST = 'gpd-test';

export interface SeedSession {
  sessionId: string;
  nodeId: string;
  host?: string;
  repo?: string | null;
  cwd?: string | null;
  branch?: string | null;
  name?: string | null;
  customTitle?: string | null;
  aiTitle?: string | null;
  firstPrompt?: string | null;
  startedAt?: string | null;
  lastActiveAt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  parentSessionId?: string | null;
  parentLinkSource?: 'env' | 'hook' | 'heuristic' | null;
  transcriptPath?: string | null;
  prompts?: unknown;
  commits?: unknown;
  filesEdited?: unknown;
  planDocs?: unknown;
  finalMessage?: string | null;
  summary?: string | null;
}

/** jsonb list columns are `not null default '[]'`, so an omitted list seeds as `[]`. */
const json = (v: unknown): string => JSON.stringify(v ?? []);

export async function clearSessions(db: Db): Promise<void> {
  await db.execute(sql`delete from cc_sessions`);
  await db.execute(sql`delete from app_settings where key = 'projects.selected'`);
}

export async function seedSession(db: Db, s: SeedSession): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (
      session_id, node_id, host, repo, cwd, branch, name, custom_title, ai_title, first_prompt,
      entrypoint, started_at, last_active_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      parent_session_id, parent_link_source, transcript_path,
      prompts, commits, files_edited, plan_docs, final_message, summary
    ) values (
      ${s.sessionId}, ${s.nodeId}, ${s.host ?? THIS_HOST}, ${s.repo === undefined ? 'mcp-notes' : s.repo},
      ${s.cwd ?? null}, ${s.branch ?? null}, ${s.name ?? null}, ${s.customTitle ?? null}, ${s.aiTitle ?? null},
      ${s.firstPrompt ?? null}, 'cli',
      ${s.startedAt ?? null}::timestamptz, ${s.lastActiveAt ?? null}::timestamptz,
      ${s.inputTokens ?? 0}, ${s.outputTokens ?? 0}, ${s.cacheReadTokens ?? 0}, ${s.cacheWriteTokens ?? 0}, ${s.costUsd ?? null},
      ${s.parentSessionId ?? null}, ${s.parentLinkSource ?? null}, ${s.transcriptPath ?? null},
      ${json(s.prompts)}::jsonb, ${json(s.commits)}::jsonb, ${json(s.filesEdited)}::jsonb, ${json(s.planDocs)}::jsonb,
      ${s.finalMessage ?? null}, ${s.summary ?? null}
    )`);
}

/** A small transcript JSONL in a temp dir; `cleanup` removes it. */
export async function writeTranscript(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-transcript-'));
  const file = path.join(dir, 'sess-root.jsonl');
  const records = [
    { type: 'user', timestamp: '2026-10-31T18:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
    { type: 'assistant', timestamp: '2026-10-31T18:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }] } },
    { type: 'assistant', timestamp: '2026-10-31T18:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Unrelated closing words.' }] } },
  ];
  await writeFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The fixture graph used by the sessions API and MCP tests:
 *   A0-3G sess-root  mcp-notes  this host   2026-10-31 18:00Z (2026-11-01 01:00 WIB), summary, plan doc, commit, transcript
 *   B1-22 sess-b1    mcp-notes  this host   child of root (env), name impl-wall-p1, LIVE in the fake registry
 *   C2-33 sess-c2    mcp-notes  other host  child of root (heuristic)
 *   D4-44 sess-d4    seer       this host   2026-09-15, the biggest token user
 */
export async function seedGraph(db: Db, transcriptPath: string): Promise<void> {
  await seedSession(db, {
    sessionId: 'sess-root',
    nodeId: 'A0-3G',
    branch: 'main',
    firstPrompt: 'Plan the wall photo delete flow',
    startedAt: '2026-10-31T18:00:00Z',
    lastActiveAt: '2026-10-31T20:00:00Z',
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheWriteTokens: 50,
    costUsd: 1.25,
    transcriptPath,
    prompts: [{ text: 'Plan the wall photo delete flow', at: '2026-10-31T18:00:00Z' }],
    commits: [{ sha: 'abc1234def', subject: 'feat(web): photo delete' }],
    filesEdited: ['web/src/components/NoteEditor.tsx'],
    planDocs: ['docs/plans/WALL_EDITING_PLAN.md'],
    finalMessage: 'Done.',
    summary: 'Planned the wall editing photo delete flow and wrote the plan.',
  });
  await seedSession(db, {
    sessionId: 'sess-b1',
    nodeId: 'B1-22',
    name: 'impl-wall-p1',
    startedAt: '2026-11-01T01:00:00Z',
    lastActiveAt: '2026-11-01T02:00:00Z',
    inputTokens: 10,
    outputTokens: 20,
    parentSessionId: 'sess-root',
    parentLinkSource: 'env',
  });
  await seedSession(db, {
    sessionId: 'sess-c2',
    nodeId: 'C2-33',
    host: OTHER_HOST,
    name: 'impl-wall-p2',
    startedAt: '2026-11-01T02:00:00Z',
    lastActiveAt: '2026-11-01T03:00:00Z',
    parentSessionId: 'sess-root',
    parentLinkSource: 'heuristic',
    transcriptPath: '/home/gpd/.claude/projects/x/sess-c2.jsonl',
  });
  await seedSession(db, {
    sessionId: 'sess-d4',
    nodeId: 'D4-44',
    repo: 'seer',
    customTitle: 'seer leaderboard',
    startedAt: '2026-09-15T00:00:00Z',
    lastActiveAt: '2026-09-15T01:00:00Z',
    inputTokens: 5000,
    outputTokens: 5000,
    cacheReadTokens: 90000,
    costUsd: 9.5,
  });
}

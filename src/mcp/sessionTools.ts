import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { normalizeNodeId } from '../sessions/ids.js';
import { RESUME_PROMPT_MAX_CHARS, type ResumeOutcome } from '../sessions/resume.js';
import { readTranscript, searchNodes, sessionDetail, usage, type SessionsReadDeps } from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import { nodeUrl, type NodeRef } from '../sessions/view.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';

export const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
export const SESSIONS_SEARCH_MAX_LIMIT = 50;
export const SESSIONS_USAGE_DEFAULT_LIMIT = 20;
export const SESSIONS_USAGE_MAX_LIMIT = 200;

export const SESSIONS_OFF = 'Claude Code sessions are not available on this server (it was started without the session read model).';

const nodeIdField = z
  .string()
  .min(1)
  .describe('Session node id like A0-3G: two characters, a dash, two characters. Case-insensitive; the dash may be omitted. Not a note id (A-B32).');

function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function badNodeId(input: string): CallToolResult {
  return fail(`invalid_node_id: "${input}" is not a session node id. Node ids look like A0-3G (two characters, a dash, two characters); note ids like A-B32 are a different thing.`);
}

function notFound(nodeId: string): CallToolResult {
  return fail(`not_found: no session ${nodeId}. Node ids come from sessions_search, session_get, a SessionStart note in the conversation, or the wall's project graph.`);
}

function withUrl<T extends { node_id: string; repo: string | null }>(rd: SessionsReadDeps, item: T): T & { url: string | null } {
  return { ...item, url: nodeUrl(rd.wallUrl, item.repo, item.node_id) };
}

export function registerSessionTools(server: McpServer, deps: ToolDeps): void {
  const rd = deps.sessions;

  server.registerTool(
    'sessions_search',
    {
      title: 'Search Claude Code sessions',
      description:
        "Find the user's past Claude Code sessions (both laptops) by meaning and words in their summaries, names, titles and prompts, e.g. \"when did I fix photo delete in the wall?\". " +
        'Optional repo narrows to one repository (e.g. "mcp-notes"). Returns { query, mode, fallback, hits: [{ node_id, repo, title, started_at, last_active_at, host, available, live, status, parent_node_id, summary, score, url }] }, best first. ' +
        'fallback set means meaning search was unavailable and only word matches came back. Then call session_get(node_id) for the full record.',
      inputSchema: {
        query: z.string().min(1).describe('What the session was about, in plain words.'),
        repo: z.string().min(1).optional().describe('Only sessions of this repository, e.g. "mcp-notes". Omit for every repository.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSIONS_SEARCH_MAX_LIMIT)
          .optional()
          .describe(`How many sessions, 1-${SESSIONS_SEARCH_MAX_LIMIT}. Default ${SESSIONS_SEARCH_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const query = args.query.trim();
      if (query === '') return fail('query is empty: describe what the session was about.');
      try {
        const res = await searchNodes(rd, {
          query,
          repo: args.repo?.trim() || null,
          limit: args.limit ?? SESSIONS_SEARCH_DEFAULT_LIMIT,
        });
        return jsonResult({
          query: res.query,
          mode: res.mode,
          fallback: res.fallback,
          hits: res.hits.map((h) =>
            withUrl(rd, {
              node_id: h.node_id,
              repo: h.repo,
              title: h.title,
              started_at: h.started_at,
              last_active_at: h.last_active_at,
              host: h.host,
              available: h.available,
              live: h.live,
              status: h.status,
              parent_node_id: h.parent_node_id,
              summary: h.summary_excerpt,
              score: h.score,
            }),
          ),
          next:
            res.hits.length > 0
              ? 'Call session_get with a node_id for its summary, prompts, commits, plan docs and children; link node ids with their url.'
              : 'No session matched. Try other words, drop repo, or ask which repository it was in.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_get',
    {
      title: 'Get a Claude Code session',
      description:
        'One Claude Code session by node id (like A0-3G): { session: { node_id, session_id, repo, title, name, branch, cwd, started_at, last_active_at, host, available, live, status, tokens, cost_usd, summary, first_prompt, last_prompt, final_message, transcript_path, url, ... }, ' +
        'prompts, commits, files_edited, plan_docs, notes (notes saved from that session), parent, children (sessions it spawned) }. available: false means it ran on the other machine (host).',
      inputSchema: { node_id: nodeIdField },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const nodeId = normalizeNodeId(args.node_id);
      if (nodeId === null) return badNodeId(args.node_id);
      try {
        const detail = await sessionDetail(rd, nodeId);
        if (detail === null) return notFound(nodeId);
        return jsonResult({
          ...detail,
          session: withUrl(rd, detail.session),
          parent: detail.parent === null ? null : withUrl(rd, detail.parent),
          children: detail.children.map((c: NodeRef) => withUrl(rd, c)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_transcript',
    {
      title: 'Search a session transcript',
      description:
        "Search one Claude Code session's own transcript for words and get the matching messages: { node_id, session_id, query, transcript_path, matches: [{ line, at, role, excerpt }], total_matches, truncated }. " +
        'Every word must appear; "quoted phrases" stay together. Without query, the last messages come back. Works only on the machine that ran the session; elsewhere it answers not_on_this_machine (use session_get there).',
      inputSchema: {
        node_id: nodeIdField,
        query: z.string().optional().describe('Words to find in the transcript. Omit for the last messages.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TRANSCRIPT_MAX_LIMIT)
          .optional()
          .describe(`How many matching messages (the most recent ones), 1-${TRANSCRIPT_MAX_LIMIT}. Default ${TRANSCRIPT_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const nodeId = normalizeNodeId(args.node_id);
      if (nodeId === null) return badNodeId(args.node_id);
      try {
        const out = await readTranscript(rd, nodeId, { query: args.query ?? null, limit: args.limit ?? TRANSCRIPT_DEFAULT_LIMIT });
        if (out.ok) return jsonResult(out.payload);
        switch (out.error) {
          case 'not_found':
            return notFound(nodeId);
          case 'not_on_this_machine':
            return fail(
              `not_on_this_machine: session ${out.node_id} ran on ${out.host}; its transcript is only on that machine, so it cannot be searched from here. session_get still returns its summary, prompts and commits.`,
            );
          case 'transcript_missing':
            return fail(
              `transcript_missing: the transcript of ${out.node_id} is no longer on disk (Claude Code prunes old transcripts). session_get still returns what was recorded.`,
            );
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'sessions_usage',
    {
      title: 'Claude Code token usage',
      description:
        'Token and cost totals of Claude Code sessions. by "month" (default): one row per month { month, sessions, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd }, newest first. ' +
        'by "node": the sessions that used the most tokens, with node_id, title and url. Optional repo and month (YYYY-MM, in the daemon timezone) filter both; totals covers every matching session.',
      inputSchema: {
        by: z.enum(['month', 'node']).optional().describe('"month" (default) or "node".'),
        repo: z.string().min(1).optional().describe('Only this repository, e.g. "mcp-notes".'),
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional()
          .describe('Only sessions started in this month, YYYY-MM.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSIONS_USAGE_MAX_LIMIT)
          .optional()
          .describe(`by "node": how many sessions, 1-${SESSIONS_USAGE_MAX_LIMIT}. Default ${SESSIONS_USAGE_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      try {
        const res = await usage(rd, {
          by: args.by ?? 'month',
          repo: args.repo?.trim() || null,
          month: args.month ?? null,
          limit: args.limit ?? SESSIONS_USAGE_DEFAULT_LIMIT,
        });
        if (res.by === 'node') return jsonResult({ ...res, rows: res.rows.map((r) => withUrl(rd, r)) });
        return jsonResult(res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
  registerSessionResumeTool(server, deps);
}

/** ResumeOutcome -> the tool's answer: the JSON result on success, a "<code>: <what to do>" error otherwise. */
export function resumeToolResult(out: ResumeOutcome, nodeId: string): CallToolResult {
  if (out.status === 200) return jsonResult(out.body);
  const body = out.body;
  switch (body.error) {
    case 'not_found':
      return fail(`not_found: no session with node id ${nodeId}`);
    case 'not_on_this_machine':
      return fail(`not_on_this_machine: session ${nodeId} ran on ${body.host}; resume it on that machine`);
    case 'no_tmux':
      return fail('no_tmux: no tmux server is running on this machine, so there is nowhere to open the session');
    case 'live_outside_tmux':
      return fail(`live_outside_tmux: session ${nodeId} is already running (pid ${body.pid}) outside tmux; switch to its terminal`);
    case 'spawn_failed':
      return fail(`spawn_failed: ${body.message}`);
  }
}

export function registerSessionResumeTool(server: McpServer, deps: Pick<ToolDeps, 'sessionResume'>): void {
  server.registerTool(
    'session_resume',
    {
      title: 'Resume a Claude Code session',
      description:
        "Open a Claude Code session from the session graph in the user's tmux, on this machine. node_id is a session node id like A0-3G (two characters, a dash, two characters; not a note id). If that session is already running, its tmux window is focused and prompt (if given) is typed into it; it is never resumed twice. Otherwise a new window in the most recently attached tmux session runs `claude --resume <session> [prompt]` in the session's directory; if that directory is gone (a removed worktree) it runs from the repository checkout and returns original_cwd. fresh=true starts a new session whose first prompt is this node's summary, commits and plan docs (plus prompt) instead of resuming. A session whose transcript lives on the other machine answers not_on_this_machine. Returns { action: focused | messaged | resumed | spawned, window }.",
      inputSchema: {
        node_id: z.string().min(1).describe('Session node id like A0-3G. Case-insensitive; the dash may be omitted.'),
        prompt: z
          .string()
          .max(RESUME_PROMPT_MAX_CHARS)
          .optional()
          .describe('Optional message: typed into the running session, or sent as the first turn after resuming.'),
        fresh: z
          .boolean()
          .optional()
          .describe("true: start a new session seeded with this node's context instead of resuming it. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ node_id, prompt, fresh }) => {
      const resumer = deps.sessionResume;
      if (resumer === undefined) return fail('session_resume is not available in this server');
      try {
        return resumeToolResult(await resumer.resume(node_id, { prompt, fresh }), node_id);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

import type { SessionNode } from '../types';

/** 12:00 UTC = 19:00 Jakarta: a few hours of minutes stay on one Jakarta day. */
export const SESSION_BASE = Date.UTC(2026, 9, 1, 12, 0, 0);

/** A wire session node started `minute` minutes after SESSION_BASE; session id is `s-<nodeId>`. */
export function makeSession(nodeId: string, minute: number, opts: Partial<SessionNode> = {}): SessionNode {
  const at = new Date(SESSION_BASE + minute * 60_000).toISOString();
  return {
    session_id: `s-${nodeId}`,
    node_id: nodeId,
    repo: 'mcp-notes',
    parent_session_id: null,
    parent_node_id: null,
    parent_link_source: null,
    title: opts.custom_title ?? opts.name ?? nodeId,
    name: null,
    custom_title: null,
    ai_title: null,
    first_prompt: null,
    branch: null,
    cwd: '/home/u/mcp-notes',
    started_at: at,
    last_active_at: at,
    host: 'lenovo',
    available: true,
    live: false,
    status: null,
    tmux: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
    cost_usd: null,
    summary_excerpt: null,
    child_count: 0,
    unfinished: null,
    ...opts,
  };
}

export function childOf(parent: SessionNode, nodeId: string, minute: number, opts: Partial<SessionNode> = {}): SessionNode {
  return makeSession(nodeId, minute, { parent_session_id: parent.session_id, parent_node_id: parent.node_id, parent_link_source: 'env', ...opts });
}

/** Distinct node ids for bulk fixtures: 0 → `00-00`, 37 → `00-11`. */
export function nodeIdAt(i: number): string {
  const s = i.toString(36).toUpperCase().padStart(4, '0');
  return `${s.slice(0, 2)}-${s.slice(2)}`;
}

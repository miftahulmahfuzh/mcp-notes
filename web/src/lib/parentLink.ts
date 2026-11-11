import type { ForkPoint, ParentLinkSource } from '../types';

const SOURCES: readonly ParentLinkSource[] = ['fork', 'env', 'hook', 'heuristic'];

/** A wire `parent_link_source`, or null for a missing or unknown one. */
export function parseParentLinkSource(v: unknown): ParentLinkSource | null {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v) ? (v as ParentLinkSource) : null;
}

/** A wire `fork` object, or null when it is absent or names no parent node. */
export function parseForkPoint(v: unknown): ForkPoint | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const parent = typeof o.parent_node_id === 'string' && o.parent_node_id.trim() !== '' ? o.parent_node_id : null;
  if (parent === null) return null;
  const at = typeof o.forked_at === 'string' && o.forked_at.trim() !== '' ? o.forked_at : null;
  const n = o.prompt_count;
  const count = typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  return { parent_node_id: parent, forked_at: at, prompt_count: count };
}

/** A background job id only means something while the session runs: null unless `live`. */
export function liveJobId(v: unknown, live: boolean): string | null {
  return live && typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The fork point as the parent's prompt count: " after prompt N", " before its first prompt", or "". */
export function forkAfter(f: ForkPoint): string {
  if (f.prompt_count === null) return '';
  return f.prompt_count === 0 ? ' before its first prompt' : ` after prompt ${f.prompt_count}`;
}

/** "forked from <id> after prompt N": the graph badge's hover text. */
export function forkLabel(f: ForkPoint): string {
  return `forked from ${f.parent_node_id}${forkAfter(f)}`;
}

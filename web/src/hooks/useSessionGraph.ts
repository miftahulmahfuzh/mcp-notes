import { useEffect, useState } from 'react';
import { startAdaptivePoll } from '../lib/pageActive';
import { fetchSessionGraph } from '../sessionsApi';
import type { SessionNode } from '../types';

/**
 * Poll cadence while the projects page is visible: 30 s, doubling per unchanged answer up to
 * GRAPH_POLL_MAX_MS. Each poll sends If-None-Match, so an unchanged graph costs one 304. There is no
 * SSE event for sessions (phase 7's decision).
 */
export const GRAPH_POLL_MS = 30_000;
export const GRAPH_POLL_MAX_MS = 120_000;

export interface SessionGraphStore {
  nodes: SessionNode[];
  loaded: boolean;
  error: string | null;
}

/**
 * One repo's graph nodes. Loads on mount, then polls every GRAPH_POLL_MS (backing off to GRAPH_POLL_MAX_MS while
 * nothing changes) only while the tab is visible, and once when it becomes visible again. ProjectsPage is keyed by repo, so a repo switch remounts.
 */
export function useSessionGraph(repo: string | null): SessionGraphStore {
  const [state, setState] = useState<SessionGraphStore>({ nodes: [], loaded: repo === null, error: null });

  useEffect(() => {
    if (repo === null) return;
    let alive = true;
    let inFlight = false;
    let etag: string | null = null;
    const ctrl = new AbortController();

    /** Resolves true when the graph changed (a 304 or an identical etag is "unchanged"). */
    const load = async (): Promise<boolean> => {
      if (inFlight) return false;
      inFlight = true;
      try {
        const res = await fetchSessionGraph(repo, { signal: ctrl.signal, etag });
        const changed = res.payload !== null && res.etag !== etag;
        etag = res.etag;
        const payload = res.payload;
        if (alive && payload !== null) setState({ nodes: payload.nodes, loaded: true, error: null });
        return changed;
      } catch (e) {
        if (alive && !ctrl.signal.aborted) setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
        return false;
      } finally {
        inFlight = false;
      }
    };

    void load();
    const poll = startAdaptivePoll({ baseMs: GRAPH_POLL_MS, maxMs: GRAPH_POLL_MAX_MS, staleMs: GRAPH_POLL_MS, run: load });
    return () => {
      alive = false;
      ctrl.abort();
      poll.stop();
    };
  }, [repo]);

  return state;
}

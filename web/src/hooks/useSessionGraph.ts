import { useEffect, useState } from 'react';
import { fetchSessionGraph } from '../sessionsApi';
import type { SessionNode } from '../types';

/**
 * Phase 7's suggested poll while the projects page is visible. Each poll sends If-None-Match, so an
 * unchanged graph costs one 304. There is no SSE event for sessions (phase 7's decision).
 */
export const GRAPH_POLL_MS = 10_000;

export interface SessionGraphStore {
  nodes: SessionNode[];
  loaded: boolean;
  error: string | null;
}

/**
 * One repo's graph nodes. Loads on mount, then polls every GRAPH_POLL_MS while the tab is visible
 * (and once when it becomes visible again). ProjectsPage is keyed by repo, so a repo switch remounts.
 */
export function useSessionGraph(repo: string | null): SessionGraphStore {
  const [state, setState] = useState<SessionGraphStore>({ nodes: [], loaded: repo === null, error: null });

  useEffect(() => {
    if (repo === null) return;
    let alive = true;
    let inFlight = false;
    let etag: string | null = null;
    const ctrl = new AbortController();

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetchSessionGraph(repo, { signal: ctrl.signal, etag });
        etag = res.etag;
        const payload = res.payload;
        if (alive && payload !== null) setState({ nodes: payload.nodes, loaded: true, error: null });
      } catch (e) {
        if (alive && !ctrl.signal.aborted) setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
      }
    };
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };

    void load();
    const poll = window.setInterval(tick, GRAPH_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [repo]);

  return state;
}

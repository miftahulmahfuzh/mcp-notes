import { useEffect, useState } from 'react';
import {
  fetchHandoffEstimate,
  fetchSessionContext,
  parseContextEvent,
  type HandoffEstimate,
  type SessionContext,
} from '../sessionDetailApi';

/**
 * How the Context Rot view keeps a session's context current:
 * - `stream`: live on this machine, so ingest feeds `GET /api/sessions/:nodeId/context/stream`.
 * - `poll`: the other machine's session; its ingest never reaches this daemon, so `GET .../context` every 60 s.
 * - `detail`: idle on this machine; the panel's detail (re-fetched on the graph's stamp) carries it.
 */
export type ContextFeed = 'stream' | 'poll' | 'detail';

/** Poll period for another machine's session. */
export const CONTEXT_POLL_MS = 60_000;

export function contextFeed(live: boolean, available: boolean): ContextFeed {
  if (!available) return 'poll';
  return live ? 'stream' : 'detail';
}

/** The later of two readings by `at`; a known context never goes back to null. Equal or unknown times take `next`. */
export function newerContext(cur: SessionContext | null, next: SessionContext | null): SessionContext | null {
  if (next === null) return cur;
  if (cur === null) return next;
  const a = Date.parse(cur.at ?? '');
  const b = Date.parse(next.at ?? '');
  if (Number.isFinite(a) && Number.isFinite(b) && b < a) return cur;
  return next;
}

export interface UseSessionContextArgs {
  nodeId: string;
  live: boolean;
  available: boolean;
  /** The session detail's `context`; it changes whenever the panel re-fetches the detail. */
  initial: SessionContext | null;
}

interface Held {
  key: string;
  ctx: SessionContext | null;
}

/** The node's current context while the view is mounted. Closes its stream or poll on unmount and on node change. */
export function useSessionContext({ nodeId, live, available, initial }: UseSessionContextArgs): SessionContext | null {
  const key = nodeId.toUpperCase();
  const [held, setHeld] = useState<Held>(() => ({ key, ctx: initial }));

  useEffect(() => {
    setHeld((h) => {
      if (h.key !== key) return { key, ctx: initial };
      const ctx = newerContext(h.ctx, initial);
      return ctx === h.ctx ? h : { key, ctx };
    });
  }, [key, initial]);

  const feed = contextFeed(live, available);

  useEffect(() => {
    if (feed === 'detail') return undefined;
    const take = (ctx: SessionContext | null): void => {
      setHeld((h) => {
        if (h.key !== key) return h;
        const next = newerContext(h.ctx, ctx);
        return next === h.ctx ? h : { key, ctx: next };
      });
    };

    if (feed === 'stream') {
      if (typeof EventSource === 'undefined') return undefined;
      const es = new EventSource(`/api/sessions/${encodeURIComponent(key)}/context/stream`);
      es.addEventListener('context', (e: Event) => {
        const p = parseContextEvent((e as MessageEvent).data);
        if (p !== null) take(p.context);
      });
      return () => es.close();
    }

    const ac = new AbortController();
    const load = (): void => {
      fetchSessionContext(key, ac.signal).then(
        (p) => {
          if (p !== null && !ac.signal.aborted) take(p.context);
        },
        () => {
          // a failed poll keeps the last reading; the next tick tries again
        },
      );
    };
    load();
    const timer = window.setInterval(load, CONTEXT_POLL_MS);
    return () => {
      ac.abort();
      window.clearInterval(timer);
    };
  }, [key, feed]);

  return held.key === key ? held.ctx : initial;
}

interface HeldEstimate {
  key: string;
  est: HandoffEstimate | null;
}

/**
 * Phase 3's dry-run estimate for "Spawn fresh with this context", loaded on mount and again whenever
 * `refreshKey` changes (the view passes the current context's tokens and time). Null while loading
 * and when the route fails: the view hides the bar quietly.
 */
export function useHandoffEstimate(nodeId: string, refreshKey: string): HandoffEstimate | null {
  const key = nodeId.toUpperCase();
  const [held, setHeld] = useState<HeldEstimate>({ key, est: null });

  useEffect(() => {
    const ac = new AbortController();
    fetchHandoffEstimate(key, ac.signal).then(
      (est) => {
        if (!ac.signal.aborted) setHeld({ key, est });
      },
      () => {
        if (!ac.signal.aborted) setHeld({ key, est: null });
      },
    );
    return () => ac.abort();
  }, [key, refreshKey]);

  return held.key === key ? held.est : null;
}

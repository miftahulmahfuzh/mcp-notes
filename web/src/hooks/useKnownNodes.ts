import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchKnownNodes, type KnownNode } from '../sessionsApi';

/** Ids asked per request (the server reads at most 100). */
const BATCH = 100;

export interface KnownNodes {
  /** The node, null when the server said no such id, undefined while not asked yet. */
  lookup: (id: string) => KnownNode | null | undefined;
  /** Ask the server about canonical ids not asked yet; batched with other calls in the same tick. */
  request: (ids: readonly string[]) => void;
  /** Remember a node learned elsewhere (a wall link already names it). */
  remember: (node: KnownNode) => void;
}

/**
 * Which node ids exist, for the chat linkifier: CI-CD and UI-UX share the node-id shape, so an id is
 * linked only once the server knows it. One answer per id for the page's life (a session never
 * changes its id); a failed request is forgotten, so the next text that names the id asks again.
 */
export function useKnownNodes(): KnownNodes {
  const cache = useRef(new Map<string, KnownNode | null>());
  const queued = useRef(new Set<string>());
  const asking = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const flush = useCallback(() => {
    const ids = [...queued.current];
    queued.current.clear();
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      for (const id of batch) asking.current.add(id);
      fetchKnownNodes(batch).then(
        (found) => {
          const byId = new Map(found.map((n) => [n.node_id, n]));
          for (const id of batch) {
            asking.current.delete(id);
            cache.current.set(id, byId.get(id) ?? null);
          }
          if (alive.current) setVersion((v) => v + 1);
        },
        (e: unknown) => {
          for (const id of batch) asking.current.delete(id);
          console.error('node links: lookup failed', e);
        },
      );
    }
  }, []);

  const request = useCallback(
    (ids: readonly string[]) => {
      const before = queued.current.size;
      for (const id of ids) {
        if (!cache.current.has(id) && !asking.current.has(id)) queued.current.add(id);
      }
      if (before === 0 && queued.current.size > 0) queueMicrotask(flush);
    },
    [flush],
  );

  const remember = useCallback((node: KnownNode) => {
    if (cache.current.get(node.node_id)?.repo === node.repo) return;
    cache.current.set(node.node_id, node);
    setVersion((v) => v + 1);
  }, []);

  // A new function per answer, so memoised segmentations that depend on it run again.
  const lookup = useCallback((id: string) => cache.current.get(id), [version]);

  return useMemo(() => ({ lookup, request, remember }), [lookup, request, remember]);
}

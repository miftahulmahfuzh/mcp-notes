import { useEffect, useRef } from 'react';
import { deepLinkFromLocation } from '../lib/deepLink';

/** popstate and hashchange both fire for one fragment navigation; the same href inside this window counts once. */
const COALESCE_MS = 100;

/**
 * Calls `onLink(id)` with the note id in the URL (`#<id>` or `?note=<id>`, see lib/deepLink) once
 * `ready` is true, then on every hashchange / popstate that carries one. The effect depends on
 * `ready` only, so background refetches (SSE, poll) never re-select the note. The URL is not changed.
 */
export function useDeepLink(ready: boolean, onLink: (id: string) => void): void {
  const cb = useRef(onLink);
  cb.current = onLink;

  useEffect(() => {
    if (!ready) return;
    let lastHref = '';
    let lastAt = Number.NEGATIVE_INFINITY;
    const fire = (): void => {
      const href = window.location.href;
      const at = Date.now();
      if (href === lastHref && at - lastAt < COALESCE_MS) return;
      lastHref = href;
      lastAt = at;
      const id = deepLinkFromLocation(window.location);
      if (id !== null) cb.current(id);
    };
    fire();
    window.addEventListener('hashchange', fire);
    window.addEventListener('popstate', fire);
    return () => {
      window.removeEventListener('hashchange', fire);
      window.removeEventListener('popstate', fire);
    };
  }, [ready]);
}

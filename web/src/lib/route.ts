import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';

export interface Route {
  history: boolean;
  thread: string | null;
}

/** What the URL asks for. A trailing slash is tolerated; an empty `thread` is no thread. */
export function routeFromLocation(loc: Pick<Location, 'pathname' | 'search'>): Route {
  const path = loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname;
  if (path !== HISTORY_PATH) return { history: false, thread: null };
  const t = new URLSearchParams(loc.search).get('thread');
  const thread = t !== null && t.trim() !== '' ? t.trim() : null;
  return { history: true, thread };
}

export function historyHref(thread: string | null): string {
  return thread ? `${HISTORY_PATH}?thread=${encodeURIComponent(thread)}` : HISTORY_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history URL as it is (a `/?note=` link stays put); only leaving `/history` pushes `/`.
 */
export function hrefForView(view: View, thread: string | null, loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const r = routeFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  return r.history ? '/' : null;
}

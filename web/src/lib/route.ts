import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The projects view (project-session-graph phase 10): `/projects`, `/projects?repo=<repo>`, and
 * `/projects?repo=<repo>&node=<NODE-ID>` with one graph node selected. `&focus=1` is graph focus
 * mode: the page alone, without rail, sidebar and header. `/projects?node=<NODE-ID>` (no repo) is how
 * Claude Code links a node: the app looks up the node's repo.
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history or projects page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';
export const PROJECTS_PATH = '/projects';

export interface Route {
  history: boolean;
  thread: string | null;
}

/** What `/projects` asks for. `repo` null = the server-side selection; `node` is canonical (`A0-3G`). */
export interface ProjectsRoute {
  repo: string | null;
  node: string | null;
  /** Graph focus mode: only the page (graph or project chat, toolbar, pill) is shown. */
  focus: boolean;
}

export const NO_PROJECT_ROUTE: ProjectsRoute = { repo: null, node: null, focus: false };

type Loc = Pick<Location, 'pathname' | 'search'>;

/** The path without trailing slashes (`/` stays `/`). */
function pathOf(loc: Loc): string {
  return loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname;
}

/** A trimmed query value; empty counts as absent. */
function param(search: string, key: string): string | null {
  const v = new URLSearchParams(search).get(key);
  return v !== null && v.trim() !== '' ? v.trim() : null;
}

/** What the URL asks for. A trailing slash is tolerated; an empty `thread` is no thread. */
export function routeFromLocation(loc: Loc): Route {
  if (pathOf(loc) !== HISTORY_PATH) return { history: false, thread: null };
  return { history: true, thread: param(loc.search, 'thread') };
}

export function historyHref(thread: string | null): string {
  return thread ? `${HISTORY_PATH}?thread=${encodeURIComponent(thread)}` : HISTORY_PATH;
}

const NODE_ID_LOOSE = /^([0-9A-Z]{2})-?([0-9A-Z]{2})$/;

/** `a03g`, `A0-3g` → `A0-3G`; anything not shaped like a node id → null. Never checks existence. */
export function canonicalNodeId(input: string): string | null {
  const m = NODE_ID_LOOSE.exec(input.trim().toUpperCase());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** The projects route, or null when the URL is not `/projects`. A malformed `node` is dropped. */
export function projectsRouteFromLocation(loc: Loc): ProjectsRoute | null {
  if (pathOf(loc) !== PROJECTS_PATH) return null;
  const node = param(loc.search, 'node');
  return { repo: param(loc.search, 'repo'), node: node === null ? null : canonicalNodeId(node), focus: param(loc.search, 'focus') === '1' };
}

export function projectsHref(r: ProjectsRoute): string {
  const p = new URLSearchParams();
  if (r.repo) p.set('repo', r.repo);
  if (r.node) p.set('node', r.node);
  if (r.focus) p.set('focus', '1');
  const q = p.toString();
  return q ? `${PROJECTS_PATH}?${q}` : PROJECTS_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history, non-projects URL as it is (a `/?note=` link stays put); only leaving
 * `/history` or `/projects` pushes `/`.
 */
export function hrefForView(view: View, thread: string | null, loc: Loc, projects: ProjectsRoute = NO_PROJECT_ROUTE): string | null {
  const r = routeFromLocation(loc);
  const p = projectsRouteFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  if (view === 'projects') return p !== null && p.repo === projects.repo && p.node === projects.node && p.focus === projects.focus ? null : projectsHref(projects);
  return r.history || p !== null ? '/' : null;
}

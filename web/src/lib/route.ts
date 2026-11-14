import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The projects view (project-session-graph phase 10): `/projects`, `/projects?repo=<repo>`, and
 * `/projects?repo=<repo>&node=<NODE-ID>` with one graph node selected. `&focus=1` is graph focus
 * mode: the page alone, without rail, sidebar and header. `/projects?node=<NODE-ID>` (no repo) is how
 * Claude Code links a node: the app looks up the node's repo.
 * Seer Adversarial (seer-adversarial phase 6): `/adversary` (overview) and `/adversary/<strategy_id>`
 * (one roster method, the id exactly as Seer stores it), each with `?focus=1` for focus mode.
 * Movies (movies-library phase 6): `/movies` (the poster grid), `/movies/<title id>` (`movie-<n>` /
 * `tv-<n>`, never altered) and `/movies/unmatched` (the files that matched no title).
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history, projects, adversary or movies page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';
export const PROJECTS_PATH = '/projects';
export const ADVERSARY_PATH = '/adversary';
export const MOVIES_PATH = '/movies';
/** `/movies/unmatched`. Title ids are `movie-<n>` / `tv-<n>`, so this segment never names a title. */
export const MOVIES_UNMATCHED_SEGMENT = 'unmatched';

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

/** The one segment after `<base>/`, decoded and trimmed: '' for the bare base, null when the path is not `<base>[/<one segment>]`. */
function oneSegment(p: string, base: string): string | null {
  if (p === base) return '';
  if (!p.startsWith(`${base}/`)) return null;
  const rest = p.slice(base.length + 1);
  if (rest === '' || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest).trim();
  } catch {
    return null;
  }
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

/** What `/adversary` asks for. `strategy` null = the overview; else a Seer strategy id, never altered. */
export interface AdversaryRoute {
  strategy: string | null;
  /** Focus mode: the page alone, without rail, sidebar and header. */
  focus: boolean;
}

export const NO_ADVERSARY_ROUTE: AdversaryRoute = { strategy: null, focus: false };

/** The adversary route, or null when the URL is not `/adversary[/<id>]`. A deeper path is not this page. */
export function adversaryRouteFromLocation(loc: Loc): AdversaryRoute | null {
  const id = oneSegment(pathOf(loc), ADVERSARY_PATH);
  if (id === null) return null;
  return { strategy: id === '' ? null : id, focus: param(loc.search, 'focus') === '1' };
}

export function adversaryHref(r: AdversaryRoute): string {
  const base = r.strategy ? `${ADVERSARY_PATH}/${encodeURIComponent(r.strategy)}` : ADVERSARY_PATH;
  return r.focus ? `${base}?focus=1` : base;
}

/**
 * What `/movies` asks for: the grid (`title` null, `unmatched` false), one title, or the unmatched
 * list. The parser never builds `title` and `unmatched` together; `moviesHref` gives `unmatched` precedence.
 */
export interface MoviesRoute {
  title: string | null;
  unmatched: boolean;
}

export const NO_MOVIES_ROUTE: MoviesRoute = { title: null, unmatched: false };

/** The movies route, or null when the URL is not `/movies[/<title id> | /unmatched]`. A deeper path is not this page. */
export function moviesRouteFromLocation(loc: Loc): MoviesRoute | null {
  const seg = oneSegment(pathOf(loc), MOVIES_PATH);
  if (seg === null) return null;
  if (seg === '') return { title: null, unmatched: false };
  if (seg === MOVIES_UNMATCHED_SEGMENT) return { title: null, unmatched: true };
  return { title: seg, unmatched: false };
}

export function moviesHref(r: MoviesRoute): string {
  if (r.unmatched) return `${MOVIES_PATH}/${MOVIES_UNMATCHED_SEGMENT}`;
  return r.title ? `${MOVIES_PATH}/${encodeURIComponent(r.title)}` : MOVIES_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history, non-projects, non-adversary, non-movies URL as it is (a `/?note=` link stays put);
 * only leaving `/history`, `/projects`, `/adversary` or `/movies` pushes `/`.
 */
export function hrefForView(
  view: View,
  thread: string | null,
  loc: Loc,
  projects: ProjectsRoute = NO_PROJECT_ROUTE,
  adversary: AdversaryRoute = NO_ADVERSARY_ROUTE,
  movies: MoviesRoute = NO_MOVIES_ROUTE,
): string | null {
  const r = routeFromLocation(loc);
  const p = projectsRouteFromLocation(loc);
  const a = adversaryRouteFromLocation(loc);
  const m = moviesRouteFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  if (view === 'projects') return p !== null && p.repo === projects.repo && p.node === projects.node && p.focus === projects.focus ? null : projectsHref(projects);
  if (view === 'adversary') return a !== null && a.strategy === adversary.strategy && a.focus === adversary.focus ? null : adversaryHref(adversary);
  if (view === 'movies') return m !== null && moviesHref(m) === moviesHref(movies) ? null : moviesHref(movies);
  return r.history || p !== null || a !== null || m !== null ? '/' : null;
}

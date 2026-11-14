import { describe, expect, it } from 'vitest';
import { adversaryHref, adversaryRouteFromLocation, canonicalNodeId, historyHref, hrefForView, moviesHref, moviesRouteFromLocation, NO_ADVERSARY_ROUTE, NO_PROJECT_ROUTE, projectsHref, projectsRouteFromLocation, routeFromLocation } from './route';

const loc = (url: string) => {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, search: u.search };
};

describe('route', () => {
  it('reads /history with and without a thread', () => {
    expect(routeFromLocation(loc('/history'))).toEqual({ history: true, thread: null });
    expect(routeFromLocation(loc('/history/'))).toEqual({ history: true, thread: null });
    expect(routeFromLocation(loc('/history?thread=T-1'))).toEqual({ history: true, thread: 'T-1' });
    expect(routeFromLocation(loc('/history?thread=%20'))).toEqual({ history: true, thread: null });
  });

  it('anything else is not the history page', () => {
    expect(routeFromLocation(loc('/'))).toEqual({ history: false, thread: null });
    expect(routeFromLocation(loc('/?note=A-B32'))).toEqual({ history: false, thread: null });
    expect(routeFromLocation(loc('/historyx'))).toEqual({ history: false, thread: null });
  });

  it('builds the history href, encoding the thread', () => {
    expect(historyHref(null)).toBe('/history');
    expect(historyHref('a b')).toBe('/history?thread=a%20b');
  });

  it('pushes only when the URL disagrees with the view', () => {
    expect(hrefForView('history', null, loc('/'))).toBe('/history');
    expect(hrefForView('history', 'T-1', loc('/history'))).toBe('/history?thread=T-1');
    expect(hrefForView('history', 'T-1', loc('/history?thread=T-1'))).toBeNull();
    expect(hrefForView('wall', null, loc('/history?thread=T-1'))).toBe('/');
    expect(hrefForView('bin', null, loc('/history'))).toBe('/');
    expect(hrefForView('wall', 'T-1', loc('/?note=A-B32'))).toBeNull();
    expect(hrefForView('bin', null, loc('/'))).toBeNull();
  });

  it('never rewrites a wall deep link: /?note=ID survives a switch to the wall (phase 11 relies on this)', () => {
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
    expect(hrefForView('bin', null, loc('/?note=A-B32'))).toBeNull();
  });

  it('reads /projects with repo and node, canonicalising the node id', () => {
    expect(projectsRouteFromLocation(loc('/projects'))).toEqual({ repo: null, node: null, focus: false });
    expect(projectsRouteFromLocation(loc('/projects/'))).toEqual({ repo: null, node: null, focus: false });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes'))).toEqual({ repo: 'mcp-notes', node: null, focus: false });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes&node=a03g'))).toEqual({ repo: 'mcp-notes', node: 'A0-3G', focus: false });
    expect(projectsRouteFromLocation(loc('/projects?node=not-an-id'))).toEqual({ repo: null, node: null, focus: false });
    expect(projectsRouteFromLocation(loc('/'))).toBeNull();
    expect(projectsRouteFromLocation(loc('/history'))).toBeNull();
    expect(projectsRouteFromLocation(loc('/projectsx'))).toBeNull();
  });

  it('a node id is two-dash-two; note ids are not node ids', () => {
    expect(canonicalNodeId('A0-3G')).toBe('A0-3G');
    expect(canonicalNodeId(' a0-3g ')).toBe('A0-3G');
    expect(canonicalNodeId('A-B32')).toBeNull();
    expect(canonicalNodeId('A0-3G1')).toBeNull();
  });

  it('builds the projects href', () => {
    expect(projectsHref({ repo: null, node: null, focus: false })).toBe('/projects');
    expect(projectsHref({ repo: 'mcp-notes', node: null, focus: false })).toBe('/projects?repo=mcp-notes');
    expect(projectsHref({ repo: 'mcp-notes', node: 'A0-3G', focus: false })).toBe('/projects?repo=mcp-notes&node=A0-3G');
    expect(projectsHref({ repo: 'mcp-notes', node: null, focus: true })).toBe('/projects?repo=mcp-notes&focus=1');
  });

  it('reads focus mode, and a node with no repo', () => {
    expect(projectsRouteFromLocation(loc('/projects?repo=a&focus=1'))).toEqual({ repo: 'a', node: null, focus: true });
    expect(projectsRouteFromLocation(loc('/projects?focus=0'))).toEqual({ repo: null, node: null, focus: false });
    expect(projectsRouteFromLocation(loc('/projects?node=be-xu'))).toEqual({ repo: null, node: 'BE-XU', focus: false });
    expect(hrefForView('projects', null, loc('/projects?repo=a'), { repo: 'a', node: null, focus: true })).toBe('/projects?repo=a&focus=1');
    expect(hrefForView('projects', null, loc('/projects?repo=a&focus=1'), { repo: 'a', node: null, focus: true })).toBeNull();
  });

  it('syncs the projects view and leaves it for /', () => {
    expect(hrefForView('projects', null, loc('/'), { repo: null, node: null, focus: false })).toBe('/projects');
    expect(hrefForView('projects', null, loc('/projects'), { repo: null, node: null, focus: false })).toBeNull();
    expect(hrefForView('projects', null, loc('/projects?repo=a'), { repo: 'a', node: 'A0-3G', focus: false })).toBe('/projects?repo=a&node=A0-3G');
    expect(hrefForView('projects', null, loc('/projects?repo=a&node=a03g'), { repo: 'a', node: 'A0-3G', focus: false })).toBeNull();
    expect(hrefForView('wall', null, loc('/projects?repo=a'))).toBe('/');
    expect(hrefForView('bin', null, loc('/projects'))).toBe('/');
    expect(hrefForView('history', null, loc('/projects'))).toBe('/history');
    expect(hrefForView('projects', null, loc('/history'), { repo: 'a', node: null, focus: false })).toBe('/projects?repo=a');
  });
});

describe('adversary route', () => {
  it('reads /adversary, /adversary/<id> and focus', () => {
    expect(adversaryRouteFromLocation(loc('/adversary'))).toEqual({ strategy: null, focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/'))).toEqual({ strategy: null, focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/RAW35-FR-GT'))).toEqual({ strategy: 'RAW35-FR-GT', focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/A-GT?focus=1'))).toEqual({ strategy: 'A-GT', focus: true });
    expect(adversaryRouteFromLocation(loc('/adversary/a%20b'))).toEqual({ strategy: 'a b', focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/a/b'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/adversaryx'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/projects'))).toBeNull();
  });

  it('keeps the strategy id exactly (no case change)', () => {
    expect(adversaryRouteFromLocation(loc('/adversary/raw35-fr-gt'))?.strategy).toBe('raw35-fr-gt');
  });

  it('builds the href', () => {
    expect(adversaryHref({ strategy: null, focus: false })).toBe('/adversary');
    expect(adversaryHref({ strategy: 'RAW35-FR-GT', focus: false })).toBe('/adversary/RAW35-FR-GT');
    expect(adversaryHref({ strategy: 'A-GT', focus: true })).toBe('/adversary/A-GT?focus=1');
    expect(adversaryHref({ strategy: 'a b', focus: false })).toBe('/adversary/a%20b');
  });

  it('syncs the adversary view and leaves it for /', () => {
    expect(hrefForView('adversary', null, loc('/'), undefined, { strategy: null, focus: false })).toBe('/adversary');
    expect(hrefForView('adversary', null, loc('/adversary'), undefined, { strategy: null, focus: false })).toBeNull();
    expect(hrefForView('adversary', null, loc('/adversary'), undefined, { strategy: 'A-GT', focus: false })).toBe('/adversary/A-GT');
    expect(hrefForView('adversary', null, loc('/adversary/A-GT'), undefined, { strategy: 'A-GT', focus: true })).toBe('/adversary/A-GT?focus=1');
    expect(hrefForView('wall', null, loc('/adversary/A-GT'))).toBe('/');
    expect(hrefForView('bin', null, loc('/adversary'))).toBe('/');
    expect(hrefForView('projects', null, loc('/adversary'), { repo: 'a', node: null, focus: false })).toBe('/projects?repo=a');
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
  });
});

describe('movies route', () => {
  it('reads the grid, a title and the unmatched list', () => {
    expect(moviesRouteFromLocation(loc('/movies'))).toEqual({ title: null, unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/'))).toEqual({ title: null, unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/tv-247718'))).toEqual({ title: 'tv-247718', unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/unmatched'))).toEqual({ title: null, unmatched: true });
  });

  it('anything else is not the movies page', () => {
    expect(moviesRouteFromLocation(loc('/'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/moviesx'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/movies/a/b'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/movies/%E0%A4%A'))).toBeNull();
  });

  it('builds hrefs and pushes only when the URL disagrees with the view', () => {
    expect(moviesHref({ title: null, unmatched: false })).toBe('/movies');
    expect(moviesHref({ title: 'movie-467905', unmatched: false })).toBe('/movies/movie-467905');
    expect(moviesHref({ title: null, unmatched: true })).toBe('/movies/unmatched');
    expect(hrefForView('movies', null, loc('/'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: 'tv-1', unmatched: false })).toBe('/movies/tv-1');
    expect(hrefForView('movies', null, loc('/movies/tv-1'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: 'tv-1', unmatched: false })).toBeNull();
    expect(hrefForView('movies', null, loc('/movies/tv-1'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: null, unmatched: true })).toBe('/movies/unmatched');
    expect(hrefForView('wall', null, loc('/movies/tv-1'))).toBe('/');
    expect(hrefForView('adversary', null, loc('/movies'))).toBe('/adversary');
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
  });
});

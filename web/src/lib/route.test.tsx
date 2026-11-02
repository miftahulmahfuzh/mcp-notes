import { describe, expect, it } from 'vitest';
import { canonicalNodeId, historyHref, hrefForView, projectsHref, projectsRouteFromLocation, routeFromLocation } from './route';

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
    expect(projectsRouteFromLocation(loc('/projects'))).toEqual({ repo: null, node: null });
    expect(projectsRouteFromLocation(loc('/projects/'))).toEqual({ repo: null, node: null });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes'))).toEqual({ repo: 'mcp-notes', node: null });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes&node=a03g'))).toEqual({ repo: 'mcp-notes', node: 'A0-3G' });
    expect(projectsRouteFromLocation(loc('/projects?node=not-an-id'))).toEqual({ repo: null, node: null });
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
    expect(projectsHref({ repo: null, node: null })).toBe('/projects');
    expect(projectsHref({ repo: 'mcp-notes', node: null })).toBe('/projects?repo=mcp-notes');
    expect(projectsHref({ repo: 'mcp-notes', node: 'A0-3G' })).toBe('/projects?repo=mcp-notes&node=A0-3G');
  });

  it('syncs the projects view and leaves it for /', () => {
    expect(hrefForView('projects', null, loc('/'), { repo: null, node: null })).toBe('/projects');
    expect(hrefForView('projects', null, loc('/projects'), { repo: null, node: null })).toBeNull();
    expect(hrefForView('projects', null, loc('/projects?repo=a'), { repo: 'a', node: 'A0-3G' })).toBe('/projects?repo=a&node=A0-3G');
    expect(hrefForView('projects', null, loc('/projects?repo=a&node=a03g'), { repo: 'a', node: 'A0-3G' })).toBeNull();
    expect(hrefForView('wall', null, loc('/projects?repo=a'))).toBe('/');
    expect(hrefForView('bin', null, loc('/projects'))).toBe('/');
    expect(hrefForView('history', null, loc('/projects'))).toBe('/history');
    expect(hrefForView('projects', null, loc('/history'), { repo: 'a', node: null })).toBe('/projects?repo=a');
  });
});

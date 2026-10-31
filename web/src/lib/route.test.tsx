import { describe, expect, it } from 'vitest';
import { historyHref, hrefForView, routeFromLocation } from './route';

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
});

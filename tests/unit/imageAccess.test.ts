import { describe, expect, it } from 'vitest';
import { etagMatches, expandHome } from '../../src/http/imageAccess.js';

describe('expandHome', () => {
  it('expands ~ and ~/', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/Pictures/a.png', '/home/u')).toBe('/home/u/Pictures/a.png');
  });
  it('leaves other paths alone', () => {
    expect(expandHome('/tmp/a.png', '/home/u')).toBe('/tmp/a.png');
    expect(expandHome('~other/a.png', '/home/u')).toBe('~other/a.png');
    expect(expandHome('rel/a.png', '/home/u')).toBe('rel/a.png');
  });
});

describe('etagMatches', () => {
  it('matches exact, weak, listed and *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
  });
  it('rejects missing or different tags', () => {
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
  });
});

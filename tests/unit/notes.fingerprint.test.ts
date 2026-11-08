import { describe, expect, it } from 'vitest';
import { listEtag } from '../../src/notes/fingerprint.js';

describe('listEtag', () => {
  it('is stable for equal inputs', () => {
    expect(listEtag('abc', 'limit=2000')).toBe(listEtag('abc', 'limit=2000'));
  });
  it('differs on request shape and on fingerprint', () => {
    expect(listEtag('abc', 'limit=2000')).not.toBe(listEtag('abc', 'limit=10'));
    expect(listEtag('abc', 'tags')).not.toBe(listEtag('abd', 'tags'));
  });
  it('is a weak etag', () => {
    expect(listEtag('abc', 'x')).toMatch(/^W\/"n-abc-[0-9a-f]{8}"$/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseDirectStream } from '../../src/config.js';

describe('NOTESD_STREAM_CACHE_DIR', () => {
  it('is null when unset and an absolute path when set', () => {
    expect(parseDirectStream({}).cacheDir).toBeNull();
    expect(parseDirectStream({ NOTESD_STREAM_CACHE_DIR: '/srv/stream-cache/' }).cacheDir).toBe('/srv/stream-cache');
  });
  it('refuses a relative path', () => {
    expect(() => parseDirectStream({ NOTESD_STREAM_CACHE_DIR: 'cache/here' })).toThrow(/NOTESD_STREAM_CACHE_DIR must be an absolute path/);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECT_STREAM_CONFIG, parseDirectStream } from '../../src/config.js';

describe('NOTESD_STREAM_CACHE_DIR', () => {
  it('is null when unset and an absolute path when set', () => {
    expect(parseDirectStream({}).cacheDir).toBeNull();
    expect(parseDirectStream({ NOTESD_STREAM_CACHE_DIR: '/srv/stream-cache/' }).cacheDir).toBe('/srv/stream-cache');
  });
  it('refuses a relative path', () => {
    expect(() => parseDirectStream({ NOTESD_STREAM_CACHE_DIR: 'cache/here' })).toThrow(/NOTESD_STREAM_CACHE_DIR must be an absolute path/);
  });
});

describe('NOTESD_STREAM_PREVIEWS', () => {
  it('is on unless set off, and off in DEFAULT_DIRECT_STREAM_CONFIG', () => {
    expect(parseDirectStream({}).previews).toBe(true);
    expect(parseDirectStream({ NOTESD_STREAM_PREVIEWS: 'off' }).previews).toBe(false);
    expect(DEFAULT_DIRECT_STREAM_CONFIG.previews).toBe(false);
    expect(() => parseDirectStream({ NOTESD_STREAM_PREVIEWS: 'sometimes' })).toThrow(/NOTESD_STREAM_PREVIEWS must be "on" or "off"/);
  });
});

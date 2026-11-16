import { describe, expect, it } from 'vitest';
import { MAX_SESSIONS, SESSION_IDLE_MS, SESSION_MAX_MS, SessionStore, allows, learn } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const SOURCE: ResolvedSource = {
  provider: 'VidFast',
  embed_url: 'https://vidfast.pro/movie/550',
  manifest_url: 'https://cdn.example:8443/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: 'Chrome/130' },
  subtitles: [{ url: 'https://subs.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 2160,
  en_subtitle: true,
  took_s: 2.3,
};

function clock(start = '2026-11-15T12:00:00Z'): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

describe('SessionStore', () => {
  it('mints 32-character random ids that do not repeat', () => {
    const store = new SessionStore();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(store.create(REF, SOURCE, []).id);
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('ends a session 4 hours after its last use, and keeps it while it is used', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(s.id)).toBe(s);
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(s.id)).toBe(s);
    c.advance(SESSION_IDLE_MS);
    expect(store.get(s.id)).toBeNull();
    expect(store.get(s.id)).toBeNull();
  });

  it('ends a session 24 hours after it began, however often it is used', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    for (let h = 1; h < 24; h++) {
      c.advance(60 * 60 * 1000);
      expect(store.get(s.id)).toBe(s);
    }
    c.advance(SESSION_MAX_MS - 23 * 60 * 60 * 1000);
    expect(store.get(s.id)).toBeNull();
  });

  it('answers null for a malformed or unknown id', () => {
    const store = new SessionStore();
    store.create(REF, SOURCE, []);
    expect(store.get('nope')).toBeNull();
    expect(store.get('A'.repeat(32))).toBeNull();
  });

  it('drops the least recently used session past the cap', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const first = store.create(REF, SOURCE, []);
    for (let i = 0; i < MAX_SESSIONS; i++) {
      c.advance(1000);
      store.create(REF, SOURCE, []);
    }
    expect(store.size).toBe(MAX_SESSIONS);
    expect(store.get(first.id)).toBeNull();
  });

  it('counts refreshes, and peek() reads a session without keeping it alive', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const s = store.create(REF, SOURCE, []);
    expect(s.refreshes).toBe(0);
    store.replaceSource(s, SOURCE, []);
    store.replaceSource(s, SOURCE, []);
    expect(s.refreshes).toBe(2);
    c.advance(SESSION_IDLE_MS - 1000);
    expect(store.peek(s.id)).toBe(s);
    c.advance(1000);
    expect(store.peek(s.id)).toBeNull();
    expect(store.peek('nope')).toBeNull();
  });
});

describe('the host allow list', () => {
  it('allows the hosts the resolve returned, then a host the session learned, and nothing else', () => {
    const s = new SessionStore().create(REF, SOURCE, []);
    expect(allows(s, 'https://cdn.example:8443/hls/720.m3u8')).toBe(true);
    expect(allows(s, 'https://subs.example/fr.vtt')).toBe(true);
    expect(allows(s, 'https://cdn.example/hls/720.m3u8')).toBe(false);
    expect(allows(s, 'https://seg.example/1.ts')).toBe(false);
    expect(allows(s, 'file:///etc/passwd')).toBe(false);
    learn(s, 'https://seg.example/1.ts');
    expect(allows(s, 'https://SEG.example/2.ts')).toBe(true);
  });

  it('keeps the old hosts and adds the new ones on a refresh', () => {
    const store = new SessionStore();
    const s = store.create(REF, SOURCE, []);
    learn(s, 'https://seg.example/1.ts');
    store.replaceSource(s, { ...SOURCE, manifest_url: 'https://cdn3.example/m.m3u8', subtitles: [] }, []);
    expect(allows(s, 'https://cdn3.example/x.m3u8')).toBe(true);
    expect(allows(s, 'https://seg.example/2.ts')).toBe(true);
    expect(allows(s, 'https://cdn.example:8443/hls/master.m3u8')).toBe(true);
  });
});

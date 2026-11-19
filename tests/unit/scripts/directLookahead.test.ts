import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { LOOKAHEAD_AFTER, LOOKAHEAD_WIDTH, resolveTitle } from '../../../claude/streaming/direct/resolve.mjs';

type Json = Record<string, any>;

const capture = (over: Json = {}): Json => ({ url: '', took_s: 2, user_agent: 'UA', bot_check: false, bot_check_reason: null, requests: 8, clicks: 0, popups_closed: 0, tabs_left_open: 0, frames: [], hosts: [], media: { elements: 0, audible: 0 }, hits: [], ...over });
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080\n1080/index.m3u8';
const stream = (): Json => capture({ hits: [{ at_s: 2, type: 'XHR', url: 'https://cdn.example/hls/master.m3u8', referer: 'https://p.example/', origin: 'https://p.example', user_agent: 'UA', document: null, status: 200, mime: 'application/vnd.apple.mpegurl', body: MASTER }] });
const provider = (name: string): Json => ({ name, id_kind: 'tmdb', movie: `https://${name.toLowerCase()}.example/movie/{id}`, tv: null, browser_only: false, en_subtitle: null, notes: '' });
const FILM = { kind: 'movie', tmdbId: 550 };

/** A sniffer on a fake clock: each sniff takes `ms` of it, and what runs side by side is counted. */
function world(answers: Record<string, Json> = {}, ms = 39_000) {
  let t = 0;
  let running = 0;
  let most = 0;
  const begun: string[] = [];
  const stopped: string[] = [];
  const timers: Array<{ at: number; run: () => void }> = [];
  let stop = false;
  const sniff = (url: string): Promise<Json> => {
    const host = new URL(url).host;
    begun.push(host);
    running += 1;
    most = Math.max(most, running);
    return new Promise((resolve) => {
      timers.push({ at: t + ms, run: () => { running -= 1; if (stop && !(host in answers)) stopped.push(host); resolve(answers[host] ?? capture()); } });
    });
  };
  /** Moves the clock to the next sniff's end, again and again, until `done`. */
  const run = async (work: Promise<Json>): Promise<Json> => {
    let out: { v: Json } | null = null;
    void work.then((v) => (out = { v }));
    for (let i = 0; i < 500 && out === null; i += 1) {
      await new Promise((r) => setImmediate(r));
      if (out !== null) break;
      timers.sort((a, b) => a.at - b.at);
      const next = stop ? timers.splice(0) : timers.splice(0, 1);
      for (const timer of next) { t = Math.max(t, stop ? t : timer.at); timer.run(); }
    }
    if (out === null) throw new Error('the resolve did not end');
    return (out as { v: Json }).v;
  };
  return { sniff, run, clock: () => t, begun, stopped, most: () => most, stop: () => { stop = true; } };
}
const TEN = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(provider);

describe('resolveTitle: providers asked side by side once the play goes badly', () => {
  it('the first providers are asked one at a time: a title the first one has costs one sniff and no tab beside it', async () => {
    const w = world({ 'a.example': stream() });
    const out = await w.run(resolveTitle(FILM, { providers: TEN, sniff: w.sniff, clock: w.clock, stop: w.stop }));
    expect(out.ok && out.source.provider).toBe('A');
    expect(w.begun).toEqual(['a.example']);
    expect(w.most()).toBe(1);
  });

  it(`after ${LOOKAHEAD_AFTER} misses the rest are asked ${LOOKAHEAD_WIDTH} at a time; a title nobody has is told in a fraction of the time`, async () => {
    const w = world();
    const out = await w.run(resolveTitle(FILM, { providers: TEN, sniff: w.sniff, clock: w.clock, stop: w.stop }));
    expect(out).toMatchObject({ ok: false, error: 'no_source' });
    expect(out.attempts.map((a: Json) => a.provider)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(out.attempts.every((a: Json) => a.outcome === 'no_stream')).toBe(true);
    expect(w.most()).toBe(LOOKAHEAD_WIDTH);
    // One after another: 10 x 39 s = 390 s. Now: A, B, then C..J as a window of four that slides by one.
    expect(w.clock()).toBeLessThanOrEqual(39_000 * 5);
    // Each provider's seconds are its own, not the wait for the ones before it.
    expect(out.attempts.every((a: Json) => a.took_s === 39)).toBe(true);
  });

  it('the answer is the one the order gives: the earlier provider wins even when a later one, asked beside it, has a stream too', async () => {
    const w = world({ 'd.example': stream(), 'e.example': stream() });
    const out = await w.run(resolveTitle(FILM, { providers: TEN, sniff: w.sniff, clock: w.clock, stop: w.stop }));
    expect(out.ok && out.source.provider).toBe('D');
    expect(out.attempts.map((a: Json) => `${a.provider} ${a.outcome}`)).toEqual(['A no_stream', 'B no_stream', 'C no_stream', 'D resolved']);
  });

  it('what was begun ahead and not needed is told to stop, and has ended before the answer goes out', async () => {
    const w = world({ 'c.example': stream() });
    let stops = 0;
    const out = await w.run(resolveTitle(FILM, { providers: TEN, sniff: w.sniff, clock: w.clock, stop: () => { stops += 1; w.stop(); } }));
    expect(out.ok && out.source.provider).toBe('C');
    expect(w.begun).toEqual(['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example']);
    expect(stops).toBe(1);
    expect(w.stopped.sort()).toEqual(['d.example', 'e.example', 'f.example']);
    // Nothing of D, E, F is in the answer: they were never the order's turn, and their health is not touched.
    expect(out.attempts.map((a: Json) => a.provider)).toEqual(['A', 'B', 'C']);
  });

  it('--only never asks anything beside the one provider', async () => {
    const w = world();
    await w.run(resolveTitle(FILM, { providers: TEN, sniff: w.sniff, clock: w.clock, only: 'C' }));
    expect(w.begun).toEqual(['c.example']);
  });

  it('a resting provider is not begun ahead either', async () => {
    const down = { en_subtitle: null, best_height: null, median_s: null, last_success_at: null, last_failure_at: '2026-11-19T10:00:00.000Z', consecutive_failures: 9, last_outcome: 'bot_check', last_detail: 'request cap.x' };
    const w = world();
    const out = await w.run(resolveTitle(FILM, { providers: TEN, health: { D: down, E: down }, sniff: w.sniff, clock: w.clock, now: () => Date.parse('2026-11-19T11:00:00.000Z'), stop: w.stop }));
    expect(w.begun).not.toContain('d.example');
    expect(w.begun).not.toContain('e.example');
    expect(out.attempts.filter((a: Json) => a.outcome === 'skipped').map((a: Json) => a.provider).sort()).toEqual(['D', 'E']);
  });
});

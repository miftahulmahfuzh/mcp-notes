import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { readHealth } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { DEAD_AFTER, REST_MAX_MS, REST_MS, restingUntil, restReason, UNREACHABLE } from '../../../claude/streaming/direct/order.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { resolveTitle } from '../../../claude/streaming/direct/resolve.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { parseSniffReply } from '../../../claude/streaming/direct/sniff.mjs';

type Json = Record<string, any>;

const FAILED_AT = '2026-11-19T10:00:00.000Z';
const T0 = Date.parse(FAILED_AT);
const down = (over: Json = {}): Json => ({ en_subtitle: null, best_height: null, median_s: null, last_success_at: null, last_failure_at: FAILED_AT, consecutive_failures: DEAD_AFTER, last_outcome: 'no_stream', last_detail: `${UNREACHABLE}HTTP 523; 8 requests, 0 media hits, 4 clicks, 4 advert tabs closed`, ...over });
const capture = (over: Json = {}): Json => ({ url: '', took_s: 2, user_agent: 'UA', bot_check: false, bot_check_reason: null, requests: 8, clicks: 0, popups_closed: 0, tabs_left_open: 0, frames: [], hosts: [], media: { elements: 0, audible: 0 }, hits: [], ...over });
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080\n1080/index.m3u8';
const stream = (): Json => capture({ hits: [{ at_s: 2, type: 'XHR', url: 'https://cdn.example/hls/master.m3u8', referer: 'https://good.example/', origin: 'https://good.example', user_agent: 'UA', document: null, status: 200, mime: 'application/vnd.apple.mpegurl', body: MASTER }] });
const provider = (name: string): Json => ({ name, id_kind: 'tmdb', movie: `https://${name.toLowerCase()}.example/movie/{id}`, tv: null, browser_only: false, en_subtitle: null, notes: '' });
function sniffer(byHost: Record<string, Json>) {
  const asked: string[] = [];
  return { asked, sniff: async (url: string) => { const host = new URL(url).host; asked.push(host); return byHost[host] ?? capture(); } };
}
const FILM = { kind: 'movie', tmdbId: 550 };

describe('restingUntil', () => {
  it('a provider whose page does not load, never a stream here, DEAD_AFTER failures in a row: rests a day from its last failure', () => {
    expect(restingUntil(down())).toBe(T0 + REST_MS);
  });
  it('a provider behind a bot check rests the same way', () => {
    expect(restingUntil(down({ last_outcome: 'bot_check', last_detail: 'request cap.hexa.su' }))).toBe(T0 + REST_MS);
  });
  it('each further failure doubles the rest, up to a week', () => {
    expect(restingUntil(down({ consecutive_failures: DEAD_AFTER + 1 }))).toBe(T0 + 2 * REST_MS);
    expect(restingUntil(down({ consecutive_failures: DEAD_AFTER + 2 }))).toBe(T0 + 4 * REST_MS);
    expect(restingUntil(down({ consecutive_failures: 400 }))).toBe(T0 + REST_MAX_MS);
  });
  it('a provider that loads and has no stream, DEAD_AFTER times in a row, rests too', () => {
    expect(restingUntil(down({ last_detail: '60 requests, 0 media hits, 4 clicks, 0 advert tabs closed' }))).toBe(T0 + REST_MS);
  });
  it('an old success does not keep a provider awake: VidLink, one stream then 16 failures in a row', () => {
    expect(restingUntil(down({ last_success_at: '2026-11-01T00:00:00.000Z', consecutive_failures: 16 }))).toBe(T0 + REST_MAX_MS);
    expect(restingUntil(down({ last_success_at: '2026-11-01T00:00:00.000Z', last_outcome: 'bot_check', last_detail: '' }))).toBe(T0 + REST_MS);
  });
  it('never rests on an error of this machine (the sniffer, Chrome), a fresh provider, or one with fewer failures', () => {
    expect(restingUntil(down({ last_outcome: 'error', last_detail: 'the sniffer timed out' }))).toBeNull();
    expect(restingUntil(down({ consecutive_failures: DEAD_AFTER - 1 }))).toBeNull();
    expect(restingUntil(null)).toBeNull();
    expect(restingUntil(down({ last_failure_at: null }))).toBeNull();
  });
  it('says why it rests', () => {
    expect(restReason(down())).toBe('its page does not load');
    expect(restReason(down({ last_outcome: 'bot_check' }))).toBe('it shows a bot check');
    expect(restReason(down({ last_detail: '60 requests, 0 media hits' }))).toBe('it gave no stream');
  });
});

describe('resolveTitle: a resting provider', () => {
  const providers = [provider('Dead'), provider('Good')];
  const health = { Dead: down() };

  it('a title nobody carries: the resting provider is not asked and costs nothing; its attempt says why and until when', async () => {
    const s = sniffer({});
    const out = await resolveTitle(FILM, { providers, health, sniff: s.sniff, now: () => T0 + 3_600_000 });
    expect(out).toMatchObject({ ok: false, error: 'no_source' });
    expect(s.asked).toEqual(['good.example']);
    const dead = out.attempts.find((a: Json) => a.provider === 'Dead');
    expect(dead).toMatchObject({ outcome: 'skipped', took_s: 0 });
    expect(dead.detail).toBe('resting: it failed 5 times in a row (its page does not load); asked again after 2026-11-20 10:00 UTC');
    expect(out.attempts.find((a: Json) => a.provider === 'Good')).toMatchObject({ outcome: 'no_stream' });
  });

  it('a provider resting behind a bot check says so', async () => {
    const s = sniffer({});
    const out = await resolveTitle(FILM, { providers, health: { Dead: down({ last_outcome: 'bot_check', last_detail: 'request cap.hexa.su' }) }, sniff: s.sniff, now: () => T0 + 1 });
    expect(out.attempts.find((a: Json) => a.provider === 'Dead').detail).toContain('(it shows a bot check)');
  });

  it('is asked again once its rest is over, and plays when it came back', async () => {
    const s = sniffer({ 'dead.example': stream() });
    const out = await resolveTitle(FILM, { providers: [provider('Dead')], health, sniff: s.sniff, now: () => T0 + REST_MS + 1 });
    expect(s.asked).toEqual(['dead.example']);
    expect(out.ok && out.source.provider).toBe('Dead');
  });

  it('--only asks it at any time', async () => {
    const s = sniffer({});
    await resolveTitle(FILM, { providers, health, sniff: s.sniff, only: 'Dead', now: () => T0 + 1 });
    expect(s.asked).toEqual(['dead.example']);
  });

  it('a page that did not load is said first in the no_stream detail, which is what makes the provider rest', async () => {
    const s = sniffer({ 'dead.example': capture({ page: { status: 523, error: null, down: true } }), 'good.example': capture({ page: { status: null, error: 'net::ERR_NAME_NOT_RESOLVED', down: true } }) });
    const out = await resolveTitle(FILM, { providers, health: {}, sniff: s.sniff });
    expect(out.attempts.map((a: Json) => a.detail)).toEqual([
      'unreachable: HTTP 523; 8 requests, 0 media hits, 0 clicks, 0 advert tabs closed',
      'unreachable: net::ERR_NAME_NOT_RESOLVED; 8 requests, 0 media hits, 0 clicks, 0 advert tabs closed',
    ]);
    expect(restingUntil(down({ last_detail: out.attempts[0].detail }))).not.toBeNull();
  });
});

describe('the health file and the sniffer reply carry what the rest reads', () => {
  it('readHealth keeps last_outcome and last_detail', () => {
    const health = readHealth(JSON.stringify({ Dead: down() }));
    expect(health.Dead).toMatchObject({ last_outcome: 'no_stream', consecutive_failures: DEAD_AFTER });
    expect(restingUntil(health.Dead)).toBe(T0 + REST_MS);
    expect(readHealth(JSON.stringify({ Old: { consecutive_failures: 9 } })).Old).toMatchObject({ last_outcome: null, last_detail: null });
  });
  it('parseSniffReply reads page, and a reply without one (an older sniffer) is not down', () => {
    expect(parseSniffReply(JSON.stringify({ requests: 4, page: { status: 522, error: null, down: true } })).page).toEqual({ status: 522, error: null, down: true });
    expect(parseSniffReply(JSON.stringify({ requests: 4 })).page).toEqual({ status: null, error: null, down: false });
  });
});

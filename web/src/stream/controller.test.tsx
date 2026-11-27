// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_POLL_MS, RECONNECT_GIVE_UP_MS, RECONNECT_RETRY_MS, SUBTITLE_DELAY_MAX_MS, cueText, MAX_REFRESHES, MAX_SOURCE_SWITCHES, PAUSE_CACHE_DELAY_MS, POSITION_INTERVAL_MS, SEEK_GRACE_MS, SOURCE_SWITCH_COOLDOWN_MS, STALLS_TO_SWITCH, STALL_WINDOW_MS, TORRENT_STALLS_TO_SWITCH, SUBTITLE_HOLD_MS, STALL_MIN_MS, STALL_REPEAT_MS, StreamController, TORRENT_POLL_MS, onDisk, scaleRanges } from './controller';
import { audioTrackIndex, BUFFER_AHEAD_S, CACHED_BUFFER_AHEAD_S, classifyRefusal, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT } from './engine';
import { NO_PREVIEWS, SessionError, fetchPreviews, mutedFromLocation, parsePreviews, parseSession, sessionIdFromLocation } from './session';
import { fakeEngines, fakeVideo, jsonResponse, previewCueJson, previewsJson, routeFetch, sessionTrack, streamSessionJson, type FetchCall } from '../testing/streamFakes';
import { CUE_FEED_POLL_MS } from './subtitles';

const S1 = '/api/stream/sessions/S1';
const controllers: StreamController[] = [];

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.useRealTimers();
});

function setup(
  routes: Record<string, (call: FetchCall) => Response>,
  opts: { muted?: boolean; memory?: Pick<Storage, 'getItem' | 'setItem'>; onSession?: (id: string) => void; now?: () => number } = {},
) {
  const { made, createEngine } = fakeEngines();
  const { fetchImpl, calls } = routeFetch(routes);
  const { video, media, play, fire } = fakeVideo();
  const texts: string[] = [];
  const controller = new StreamController('S1', video, {
    fetch: fetchImpl,
    createEngine,
    textUrl: (vtt) => {
      texts.push(vtt);
      return `blob:vtt-${texts.length}`;
    },
    revokeTextUrl: () => {},
    muted: opts.muted,
    memory: opts.memory,
    onSession: opts.onSession,
    now: opts.now,
  });
  controllers.push(controller);
  // A position body without its `stats` (the counters have their own describe, R1.6); other bodies as sent.
  const withoutStats = (url: string, body: unknown): unknown => {
    if (!url.endsWith('/position') || body === null || typeof body !== 'object') return body;
    const rest = { ...(body as Record<string, unknown>) };
    delete rest.stats;
    return rest;
  };
  const posts = (url = `${S1}/position`) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => withoutStats(url, c.body));
  return { controller, made, calls, video, media, play, fire, texts, posts };
}

const english = { index: 0, label: 'English', lang: 'en' };

describe('parseSession', () => {
  it('maps phase 3\'s SessionInfo and fills what is optional; tracks inside the manifest are not files', () => {
    const subtitles = [
      sessionTrack('/x', 'en', '', { english: true }),
      sessionTrack('/m.m3u8', 'en', 'English', { format: 'hls', source: 'manifest' }),
      { url: '/y', lang: null, label: 'English (CC)', format: 'vtt' },
    ];
    expect(parseSession(streamSessionJson({ resume_s: 42.5, subtitles }))).toEqual({
      id: 'S1',
      title: 'Fight Club (1999)',
      manifestUrl: '/api/stream/sessions/S1/p?u=m1',
      manifestKind: 'hls',
      subtitles: [
        { url: '/x', lang: 'en', label: 'en', english: true },
        { url: '/y', lang: null, label: 'English (CC)', english: true },
      ],
      resumeS: 42.5,
      audioTrack: null,
      prevEpisode: null,
      nextEpisode: null,
      cached: null,
      torrent: null,
      subtitleRev: 0,
      sourceRev: 0,
      previewRev: 0,
      sourceNote: null,
      ref: { kind: 'movie', tmdbId: 550 },
      provider: 'VidFast',
    });
    expect(parseSession(streamSessionJson({ source_rev: 1, source_note: 'dubbed audio' }))).toMatchObject({ sourceRev: 1, sourceNote: 'dubbed audio' });
    expect(parseSession(streamSessionJson({ subtitle_rev: 2 })).subtitleRev).toBe(2);
    // The title the session plays, which a page whose session a restart ended asks to continue by.
    expect(parseSession(streamSessionJson({ kind: 'tv', tmdb_id: 37854, season: 18, episode: 787 })).ref).toEqual({ kind: 'tv', tmdbId: 37854, season: 18, episode: 787 });
    expect(parseSession(streamSessionJson({ kind: 'tv', season: null })).ref).toBeNull();
    // A series' session names its neighbours; anything else there is no neighbour.
    expect(parseSession(streamSessionJson({ prev_episode: { season: 17, episode: 729 }, next_episode: { season: 'x', episode: 1 } }))).toMatchObject({
      prevEpisode: { season: 17, episode: 729 },
      nextEpisode: null,
    });
    expect(parseSession({ session_id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toMatchObject({ title: 'Stream', subtitles: [], resumeS: 0, audioTrack: null });
    // The manifest's original-language audio track, as the resolve named it.
    const audio = { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'kor', label: 'Korean' } };
    expect(parseSession(streamSessionJson({ audio })).audioTrack).toEqual({ lang: 'kor', label: 'Korean' });
    expect(parseSession(streamSessionJson({ audio: { ...audio, track: null } })).audioTrack).toBeNull();
    expect(() => parseSession({ id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toThrow('bad_session');
  });

  it('finds the original-language audio track among a manifest\'s, by tag and name', () => {
    const tracks = [{ lang: 'en', label: 'English' }, { lang: 'kor', label: 'Korean' }, { lang: 'kor', label: 'Korean (Commentary)' }];
    expect(audioTrackIndex(tracks, { lang: 'kor', label: 'Korean' })).toBe(1);
    expect(audioTrackIndex(tracks, { lang: 'KOR', label: 'Korean (Commentary)' })).toBe(2);
    // The name moved on (a refreshed manifest): the tag still finds it.
    expect(audioTrackIndex(tracks, { lang: 'kor', label: 'Original' })).toBe(1);
    expect(audioTrackIndex([{ lang: null, label: 'Korean' }], { lang: null, label: 'Korean' })).toBe(0);
    expect(audioTrackIndex(tracks, { lang: 'ja', label: 'Japanese' })).toBe(-1);
    expect(audioTrackIndex(tracks, null)).toBe(-1);
  });

  it('hands the session\'s audio track to the engine', async () => {
    const audio = { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'kor', label: 'Korean' } };
    const { controller, made } = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ audio })) });
    await controller.start();
    expect(made[0]?.req.audioTrack).toEqual({ lang: 'kor', label: 'Korean' });
  });

  it('reads ?muted=1, and tells an expired token from a session notesd refused', () => {
    expect(mutedFromLocation({ search: '?muted=1' })).toBe(true);
    expect(mutedFromLocation({ search: '' })).toBe(false);
    expect(classifyRefusal(403, '403')).toBe('expired');
    expect(classifyRefusal(410, '410')).toBe('expired');
    expect(classifyRefusal(403, null)).toBe('over');
    expect(classifyRefusal(404, '404')).toBeNull();
  });

  it('refuses a session without a manifest or with an unknown kind', () => {
    expect(() => parseSession(streamSessionJson({ manifest_url: undefined }))).toThrow(SessionError);
    expect(() => parseSession(streamSessionJson({ manifest_kind: 'smooth' }))).toThrow('bad_session');
  });

  it('reads the cache a session plays from, and nothing it cannot use', () => {
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'ready', height: 720 } })).cached).toEqual({ id: 'c1', state: 'ready', height: 720 });
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'downloading', height: 'x' } })).cached).toEqual({ id: 'c1', state: 'downloading', height: null });
    expect(parseSession(streamSessionJson({ cached: { id: 'c1', state: 'failed', height: 720 } })).cached).toBeNull();
    expect(parseSession(streamSessionJson({ cached: null })).cached).toBeNull();
    expect(parseSession(streamSessionJson()).cached).toBeNull();
  });

  it('reads the id from /stream/<id>', () => {
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m/' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/' })).toBeNull();
    expect(sessionIdFromLocation({ pathname: '/stream/a/b' })).toBeNull();
  });
});

const CACHED = { id: 'c1d2e3f4-0000-4000-8000-000000000001', state: 'ready', height: 720 };
const LOCAL = '/api/stream/cache/c1d2e3f4-0000-4000-8000-000000000001/f/master.m3u8';

describe('playing from the cache', () => {
  it("hands a cached session's state to the engine, keeps it in the state and notes it in the log", async () => {
    const { controller, made } = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ manifest_url: LOCAL, cached: CACHED })) });
    await controller.start();
    expect(made[0]?.req.src).toBe(LOCAL);
    expect(made[0]?.req.bufferAheadS).toBe(CACHED_BUFFER_AHEAD_S);
    expect(controller.getState().cached).toEqual(CACHED);
    expect(controller.getState().log).toContain('from cache c1d2e3f4 (ready)');
  });

  it('keeps 120 s ahead for a stream through the pass-through and for a cache still downloading', async () => {
    const plain = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    await plain.controller.start();
    expect(plain.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    expect(plain.controller.getState().cached).toBeNull();
    const downloading = setup({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ manifest_url: LOCAL, cached: { ...CACHED, state: 'downloading' } })) });
    await downloading.controller.start();
    expect(downloading.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
  });

  it('drops the mark when a refresh moves the session onto the pass-through (the cache was cleared)', async () => {
    let reads = 0;
    const { controller, made } = setup({
      'GET /api/stream/sessions/S1': () => jsonResponse(reads++ === 0 ? streamSessionJson({ manifest_url: LOCAL, cached: CACHED }) : streamSessionJson()),
      'POST /api/stream/sessions/S1/refresh': () => jsonResponse({ session_id: 'S1' }),
    });
    await controller.start();
    made[0]!.req.handlers.onReady({ qualities: [], subtitles: [] });
    made[0]!.req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(made).toHaveLength(2));
    expect(made[1]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    expect(controller.getState().cached).toBeNull();
  });
});

describe('the buffer of a cached play', () => {
  it('keeps 30 s under ?muted=1 even for a complete cache, and the numbers are 30 / 120 / 600', () => {
    expect([MUTED_BUFFER_AHEAD_S, BUFFER_AHEAD_S, CACHED_BUFFER_AHEAD_S]).toEqual([30, 120, 600]);
  });
});

describe('StreamController: subtitles and quality (R2.3)', () => {
  it('starts at resume_s and shows the English track inside the manifest over a French one', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ resume_s: 42 })) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const engine = t.made[0];
    expect(engine.req).toMatchObject({ kind: 'hls', src: `${S1}/p?u=m1`, startAt: 42 });

    engine.req.handlers.onReady({
      qualities: [
        { index: 0, height: 720, bitrate: null },
        { index: 1, height: 1080, bitrate: null },
        { index: 2, height: 480, bitrate: null },
      ],
      subtitles: [
        { index: 0, label: 'Français', lang: 'fr' },
        { index: 1, label: 'English', lang: 'en' },
      ],
    });

    const s = t.controller.getState();
    expect(s).toMatchObject({ stage: 'ready', title: 'Fight Club (1999)', subtitle: 'manifest-1', quality: -1 });
    expect(engine.setEmbeddedSubtitle).toHaveBeenLastCalledWith(1);
    expect(s.qualities.map((q) => q.height)).toEqual([1080, 720, 480]);
    await vi.waitFor(() => expect(t.play).toHaveBeenCalled());
  });

  it('shows a separate English .srt, converted to WebVTT, when the manifest has no English track', async () => {
    const FR = `${S1}/p?u=fr.vtt`;
    const EN = `${S1}/p?u=en.srt`;
    const t = setup({
      [`GET ${S1}`]: () =>
        jsonResponse(
          streamSessionJson({
            subtitles: [sessionTrack(FR, 'fr', 'French'), sessionTrack(EN, 'en', 'English', { format: 'srt' })],
          }),
        ),
      [`GET ${FR}`]: () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n'),
      [`GET ${EN}`]: () => new Response('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n'),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [{ index: 0, label: 'Deutsch', lang: 'de' }] });

    expect(t.texts[1]).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n');
    const tracks = [...t.video.querySelectorAll('track')];
    expect(tracks.map((el) => [el.kind, el.srclang, el.label, el.default, el.getAttribute('src')])).toEqual([
      ['subtitles', 'fr', 'French', false, 'blob:vtt-1'],
      ['subtitles', 'en', 'English', true, 'blob:vtt-2'],
    ]);
    const s = t.controller.getState();
    expect(s.subtitle).toBe('file-1');
    expect(s.subtitles.map((o) => o.label)).toEqual(['Deutsch', 'French', 'English']);
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);
  });

  it('asks again for a subtitle file whose first answer failed, and gives up after the second', async () => {
    const EN = `${S1}/p?u=en.vtt`;
    const FR = `${S1}/p?u=fr.vtt`;
    let enAsked = 0;
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ subtitles: [sessionTrack(FR, 'fr', 'French'), sessionTrack(EN, 'en', 'English')] })),
      // Phase 6's finding: the stream host failed once (the pass-through's 502), then answered.
      [`GET ${EN}`]: () => (++enAsked === 1 ? new Response('', { status: 502 }) : new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n')),
      [`GET ${FR}`]: () => new Response('', { status: 502 }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });

    expect(t.calls.filter((c) => c.url === EN)).toHaveLength(2);
    expect(t.calls.filter((c) => c.url === FR)).toHaveLength(2);
    const s = t.controller.getState();
    expect(s.subtitles.map((o) => o.label)).toEqual(['English']);
    expect(s.subtitle).toBe('file-1');
    expect(s.log).toEqual(['subtitle French: http_502']);
  });

  it('holds the film for its subtitle files a few seconds only: a file that stalls joins the menu when it arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const AR = `${S1}/p?u=ar.vtt`;
    const EN = `${S1}/p?u=en.vtt`;
    const { made, createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ subtitles: [sessionTrack(AR, 'ar', 'Arabic'), sessionTrack(EN, 'en', 'English')] })),
      [`GET ${EN}`]: () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'),
    });
    // The subtitle host holds the first file (Fake Profile S02E01: 18 s, then a 522).
    let answerArabic: (res: Response) => void = () => undefined;
    const slowFetch: typeof fetch = (input, init) => (String(input) === AR ? new Promise<Response>((resolve) => (answerArabic = resolve)) : fetchImpl(input, init));
    const { video } = fakeVideo();
    const controller = new StreamController('S1', video, { fetch: slowFetch, createEngine, textUrl: (vtt) => `blob:${vtt.length}`, revokeTextUrl: () => {} });
    controllers.push(controller);
    void controller.start();
    // Both files were asked for at once, and the film waits for the slow one no longer than the hold.
    await vi.advanceTimersByTimeAsync(SUBTITLE_HOLD_MS - 1);
    expect(calls.map((c) => c.url)).toContain(EN);
    expect(made).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(made).toHaveLength(1);
    made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(controller.getState().subtitles.map((o) => o.label)).toEqual(['English']);
    expect(controller.getState().subtitle).toBe('file-1');
    expect(controller.getState().log).toContain('subtitles: 1 of 2 file(s) in after 3 s, the rest join as they arrive');

    answerArabic(new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMarhaba\n'));
    await vi.advanceTimersByTimeAsync(0);
    // In the session's order, and the subtitle on screen stays the English one.
    expect(controller.getState().subtitles.map((o) => o.label)).toEqual(['Arabic', 'English']);
    expect([...video.querySelectorAll('track')].map((el) => el.label)).toEqual(['Arabic', 'English']);
    expect(controller.getState().subtitle).toBe('file-1');
  });

  it('shows no subtitle when none is English, and a pick reaches the engine', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [{ index: 0, label: 'Español', lang: 'es' }] });
    expect(t.controller.getState().subtitle).toBeNull();
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);

    t.controller.selectSubtitle('manifest-0');
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(0);
    expect(t.controller.getState().subtitle).toBe('manifest-0');
    t.controller.selectSubtitle('manifest-9');
    expect(t.controller.getState().subtitle).toBe('manifest-0');
  });

  it('offers the qualities and switches on a choice; an unknown one is ignored', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({
      qualities: [
        { index: 0, height: 360, bitrate: null },
        { index: 1, height: 2160, bitrate: null },
      ],
      subtitles: [],
    });
    t.controller.selectQuality(0);
    expect(t.made[0].setQuality).toHaveBeenLastCalledWith(0);
    expect(t.controller.getState().quality).toBe(0);
    t.controller.selectQuality(7);
    expect(t.controller.getState().quality).toBe(0);
    t.controller.selectQuality(-1);
    expect(t.made[0].setQuality).toHaveBeenLastCalledWith(-1);
    expect(t.controller.getState().quality).toBe(-1);
  });
});

describe('StreamController: positions', () => {
  it('posts every 5 s while the page is open, on pause, on play and at the end; a 404 changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 12.34, duration: 600, paused: false });

    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts()).toEqual([{ position_s: 12.3, duration_s: 600, ended: false, paused: false }]);

    // Paused: the pause itself is reported, then a beat every 5 s says the page is still open.
    Object.assign(t.media, { currentTime: 15, paused: true });
    t.fire('pause');
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts().slice(1)).toEqual([
      { position_s: 15, duration_s: 600, ended: false, paused: true },
      { position_s: 15, duration_s: 600, ended: false, paused: true, beat: true },
    ]);

    // Play again is said at once.
    t.media.paused = false;
    t.fire('play');
    Object.assign(t.media, { currentTime: 600, ended: true });
    t.fire('ended');
    await vi.waitFor(() => expect(t.posts()).toHaveLength(5));
    expect(t.posts().slice(3)).toEqual([
      { position_s: 15, duration_s: 600, ended: false, paused: false },
      { position_s: 600, duration_s: 600, ended: true, paused: false },
    ]);
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', reportedS: 600, error: null });
  });

  it('says the page is closing with its last position, in a request that outlives it', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 90, duration: 600, paused: true });
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(t.posts()).toEqual([{ position_s: 90, duration_s: 600, ended: false, paused: true, closed: true }]));
    // After dispose the page says nothing more.
    t.controller.dispose();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.posts()).toHaveLength(1);
  });
});

describe('StreamController: refresh and continue (R2.5)', () => {
  it.each([401, 403, 410])('a %i from the stream host refreshes the session and continues from the last position', async (status) => {
    let gets = 0;
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_url: `${S1}/p?u=m${++gets}` })),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ manifest_url: `${S1}/p?u=m2` })),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const first = t.made[0];
    first.req.handlers.onReady({ qualities: [], subtitles: [english] });
    t.media.currentTime = 77.5;
    t.fire('timeupdate');

    first.req.handlers.onAuthError(status);
    expect(t.controller.getState().stage).toBe('refreshing');
    expect(first.destroy).toHaveBeenCalled();
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    const second = t.made[1];
    expect(second.req).toMatchObject({ src: `${S1}/p?u=m2`, startAt: 77.5 });
    expect(t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/refresh`)).toHaveLength(1);

    first.req.handlers.onFatal('a late error from the replaced engine');
    second.req.handlers.onReady({ qualities: [], subtitles: [english] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', refreshes: 1, subtitle: 'manifest-0', error: null });
    expect(second.setEmbeddedSubtitle).toHaveBeenLastCalledWith(0);
  });

  it('reads the session the refresh answer names, and reports positions to it', async () => {
    const S2 = '/api/stream/sessions/S2';
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ session_id: 'S2' })),
      [`GET ${S2}`]: () => jsonResponse(streamSessionJson({ session_id: 'S2', manifest_url: `${S2}/p?u=m1` })),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.src).toBe(`${S2}/p?u=m1`);
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 30;
    t.fire('pause');
    await vi.waitFor(() => expect(t.posts(`${S2}/position`)).toEqual([{ position_s: 30, duration_s: null, ended: false, paused: false }]));
  });

  it('continues from resume_s when the token is refused before anything played', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ resume_s: 600 })),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onAuthError(410);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.startAt).toBe(600);
  });

  it('gives up when the refreshed stream is refused again before it plays', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    t.made[1].req.handlers.onAuthError(403);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'stream_expired', refreshes: 1 });
    expect(t.calls.filter((c) => c.url === `${S1}/refresh`)).toHaveLength(1);
  });

  it(`stops after ${MAX_REFRESHES} refreshes`, async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    for (let i = 0; i < MAX_REFRESHES; i++) {
      t.made[i].req.handlers.onReady({ qualities: [], subtitles: [] });
      t.made[i].req.handlers.onAuthError(403);
      await vi.waitFor(() => expect(t.made).toHaveLength(i + 2));
    }
    t.made[MAX_REFRESHES].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[MAX_REFRESHES].req.handlers.onAuthError(403);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'stream_expired', refreshes: MAX_REFRESHES });
  });

  it("ends with the daemon's code when the refresh fails", async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({ error: 'no_source', attempts: [] }, 502),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(401);
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'no_source' }));
    expect(t.made).toHaveLength(1);
  });

  it('shows an unknown session as an error and starts nothing', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse({ error: 'unknown_session' }, 403) });
    await t.controller.start();
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'unknown_session' });
    expect(t.made).toHaveLength(0);
  });

  it('a 403 notesd sent (no X-Notesd-Upstream) ends the play as session_over, with no refresh and no loop', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson()),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onSessionOver(403);
    t.made[0].req.handlers.onSessionOver(403);
    // The daemon still holds the session, so the refusal was not a restart: nothing is carried on.
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'session_over', refreshes: 0, errors: ['session_over'] }));
    expect(t.calls.filter((c) => c.url === `${S1}/refresh` || c.url === '/api/stream/continue')).toHaveLength(0);
    expect(t.made).toHaveLength(1);
  });
});

describe('StreamController: sound (D2) and the muted check', () => {
  it('playWithSound waits for the stream, unmutes and plays (phase 1\'s start() after a full-screen open)', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.media.muted = true;
    const started = t.controller.playWithSound();
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(await started).toBe(true);
    expect(t.media.muted).toBe(false);
    expect(t.play).toHaveBeenCalled();
  });

  it('?muted=1 is muted before any play, never unmuted, and start() does nothing', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) }, { muted: true });
    expect(t.media.muted).toBe(true);
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.play).toHaveBeenCalled());
    expect(await t.controller.playWithSound()).toBe(false);
    expect(t.media.muted).toBe(true);
    expect(t.controller.getState().muted).toBe(true);
  });
});

describe('StreamController: the previous and next episode', () => {
  const S2 = '/api/stream/sessions/S2';
  const EP730 = { kind: 'tv', season: 17, episode: 730, title: 'One Piece S17E730', prev_episode: { season: 17, episode: 729 }, next_episode: { season: 17, episode: 731 } };
  const EP731 = { session_id: 'S2', kind: 'tv', season: 17, episode: 731, title: 'One Piece S17E731', manifest_url: `${S2}/p?u=m731`, prev_episode: { season: 17, episode: 730 }, next_episode: null, resume_s: 0 };

  function playing(routes: Record<string, (call: FetchCall) => Response>) {
    const onSession = vi.fn();
    const { made, createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson(EP730)), ...routes });
    const { video, media, fire } = fakeVideo();
    const controller = new StreamController('S1', video, { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {}, onSession });
    controllers.push(controller);
    return { controller, made, calls, media, fire, onSession };
  }

  it('keeps playing while the daemon resolves the next episode, then plays its session from the start and says so to the old one', async () => {
    let answer: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const t = playing({ [`GET ${S2}`]: () => jsonResponse(streamSessionJson(EP731)) });
    // The episode route answers only when the test lets it: the resolve takes seconds.
    const fetchWas = (t.controller as unknown as { deps: { fetch: typeof fetch } }).deps.fetch;
    (t.controller as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === `${S1}/episode` ? (await fetchWas(input, init), pending) : fetchWas(input, init)) as typeof fetch;
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', prevEpisode: { season: 17, episode: 729 }, nextEpisode: { season: 17, episode: 731 }, switching: null });
    t.media.currentTime = 600;
    t.media.paused = false;
    t.fire('timeupdate');

    const going = t.controller.goToEpisode('next');
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', switching: 'next' });
    expect(t.made[0].destroy).not.toHaveBeenCalled();
    // A second press while it resolves does nothing.
    void t.controller.goToEpisode('next');
    void t.controller.goToEpisode('prev');
    await vi.waitFor(() => expect(t.calls.filter((c) => c.url === `${S1}/episode`)).toHaveLength(1));
    expect(t.calls.find((c) => c.url === `${S1}/episode`)).toMatchObject({ method: 'POST', body: { to: 'next' } });

    answer(jsonResponse(streamSessionJson(EP731)));
    await going;
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.onSession).toHaveBeenCalledWith('S2');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req).toMatchObject({ src: `${S2}/p?u=m731`, startAt: 0 });
    // The last word about episode 730 went to its own session, as a closing report.
    expect(t.calls.filter((c) => c.url === `${S1}/position`).at(-1)?.body).toMatchObject({ position_s: 600, closed: true });
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', title: 'One Piece S17E731', switching: null, switchError: null, prevEpisode: { season: 17, episode: 730 }, nextEpisode: null });
    // Positions now go to the new session; there is no further episode to go to.
    t.media.currentTime = 12;
    t.fire('pause');
    expect(t.calls.filter((c) => c.url === `${S2}/position`).at(-1)?.body).toMatchObject({ position_s: 12 });
    await t.controller.goToEpisode('next');
    expect(t.calls.filter((c) => c.url === `${S2}/episode`)).toHaveLength(0);
  });

  it('changes nothing when the other episode cannot be streamed, and says why', async () => {
    const t = playing({ [`POST ${S1}/episode`]: () => jsonResponse({ error: 'no_source', attempts: [] }, 502) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await t.controller.goToEpisode('prev');
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', title: 'One Piece S17E730', switching: null, switchError: { to: 'prev', code: 'no_source' } });
    expect(t.made).toHaveLength(1);
    expect(t.made[0].destroy).not.toHaveBeenCalled();
    expect(t.onSession).not.toHaveBeenCalled();
  });

  it('a film has no episode to go to', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    const controller = new StreamController('S1', fakeVideo().video, { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} });
    controllers.push(controller);
    void controller.start();
    await vi.waitFor(() => expect(made).toHaveLength(1));
    await controller.goToEpisode('next');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(controller.getState().switching).toBeNull();
  });
  it("switches the episode's subtitle track off before it is taken away, so its last line does not stay on the picture", async () => {
    // jsdom has no TextTrack: give each <track> one, as a browser does.
    const modes = new Map<HTMLTrackElement, { mode: string }>();
    const had = Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'track');
    Object.defineProperty(HTMLTrackElement.prototype, 'track', {
      configurable: true,
      get(this: HTMLTrackElement) {
        if (!modes.has(this)) modes.set(this, { mode: 'disabled' });
        return modes.get(this);
      },
    });
    try {
      const vtt = () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHowever, on that island...\n', { status: 200 });
      const t = playing({
        [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ ...EP730, subtitles: [sessionTrack('/sub730', 'en', 'English')] })),
        'GET /sub730': vtt,
        [`POST ${S1}/episode`]: () => jsonResponse(EP731),
        [`GET ${S2}`]: () => jsonResponse(streamSessionJson({ ...EP731, subtitles: [sessionTrack('/sub731', 'en', 'English')] })),
        'GET /sub731': vtt,
      });
      void t.controller.start();
      await vi.waitFor(() => expect(t.made).toHaveLength(1));
      t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
      await vi.waitFor(() => expect([...modes.values()].map((m) => m.mode)).toEqual(['hidden']));
      const [old] = [...modes.keys()];
      let modeWhenRemoved: string | undefined;
      const remove = old.remove.bind(old);
      old.remove = () => {
        modeWhenRemoved = modes.get(old)?.mode;
        remove();
      };
      await t.controller.goToEpisode('next');
      expect(modeWhenRemoved).toBe('disabled');
      expect(old.isConnected).toBe(false);
    } finally {
      if (had) Object.defineProperty(HTMLTrackElement.prototype, 'track', had);
      else delete (HTMLTrackElement.prototype as { track?: unknown }).track;
    }
  });
});

describe('the page log reaches the daemon (R2.2)', () => {
  const lines = (t: ReturnType<typeof setup>) => t.posts(`${S1}/events`).flatMap((b) => (b as { lines: Record<string, unknown>[] }).lines);

  it('posts a refresh line and the error that followed, with the stage and the position', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({ error: 'no_source' }, 502),
      [`POST ${S1}/events`]: () => jsonResponse({ ok: true, recorded: 1 }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 42;
    t.fire('timeupdate');
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.controller.getState().stage).toBe('error'));
    await vi.waitFor(() => expect(lines(t)).toHaveLength(2));
    expect(lines(t)).toEqual([
      expect.objectContaining({ text: 'refresh after 403 at 42 s', stage: 'refreshing', position_s: 42 }),
      expect.objectContaining({ text: 'error: no_source', stage: 'error', position_s: 42 }),
    ]);
    expect(typeof lines(t)[0].at).toBe('string');
  });

  it('posts a fatal engine error as the page shows it', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(t.controller.getState().stage).toBe('error'));
    await vi.waitFor(() => expect(lines(t).at(-1)).toMatchObject({ text: 'error: networkError fragLoadError', stage: 'error' }));
    // Another provider was asked for first; none answered.
    expect(lines(t)[0]).toMatchObject({ text: 'networkError fragLoadError: asking for another source' });
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'networkError fragLoadError' });
  });

  it('a daemon that refuses the lines changes nothing on the page', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/events`]: () => {
        throw new Error('daemon gone');
      },
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', errors: ['networkError fragLoadError'] }));
    expect(t.posts(`${S1}/events`).length).toBeGreaterThan(0);
  });
});

describe('StreamController: a network error (R1.7) and the buffer (R1.8)', () => {
  it('asks the engine for 120 s ahead, and 30 s under ?muted=1', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    await t.controller.start();
    expect(t.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    const m = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) }, { muted: true });
    await m.controller.start();
    expect(m.made[0]?.req.bufferAheadS).toBe(MUTED_BUFFER_AHEAD_S);
  });

  it('stays on the film while the engine retries, reports positions meanwhile, and plays on when it recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const engine = t.made[0];
    engine.req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');

    engine.req.handlers.onRecovering(1, 'networkError fragLoadError');
    expect(t.controller.getState()).toMatchObject({ stage: 'recovering', error: null, errors: [] });
    expect(t.controller.getState().log.at(-1)).toBe(`recovering 1/${NETWORK_RETRY_LIMIT} after networkError fragLoadError at 300 s`);
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(t.made).toHaveLength(1);

    // The film plays on from its buffer: its position still reaches the daemon.
    t.media.currentTime = 305;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts().at(-1)).toEqual({ position_s: 305, duration_s: 1440, ended: false, paused: false });

    engine.req.handlers.onRecovering(2, 'networkError fragLoadError');
    engine.req.handlers.onRecovered();
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null, errors: [] });
    expect(t.controller.getState().log.at(-1)).toBe('recovered at 305 s');
  });

  it("stops with the engine's message once the retries are spent, and a late word changes nothing", async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const { handlers } = t.made[0].req;
    handlers.onReady({ qualities: [], subtitles: [] });
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) handlers.onRecovering(attempt, 'networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('recovering');
    handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'] }));
    handlers.onRecovering(1, 'networkError fragLoadError');
    handlers.onRecovered();
    expect(t.controller.getState().stage).toBe('error');
  });

  it('a refused token while it recovers still refreshes, and the replaced engine is not heard', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson()),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 200;
    t.fire('timeupdate');
    t.made[0].req.handlers.onRecovering(1, 'networkError fragLoadError');
    t.made[0].req.handlers.onAuthError(403);
    expect(t.controller.getState().stage).toBe('refreshing');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.startAt).toBe(200);
    t.made[0].req.handlers.onRecovering(2, 'networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('refreshing');
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', refreshes: 1 });
  });
});

describe('StreamController: the report button (R4)', () => {
  const failed = async (report: () => Response) => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()), [`POST ${S1}/report`]: report });
    await t.controller.start();
    // No other provider answers (the daemon has no /source here): the play stops with the error.
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    await vi.waitFor(() => expect(t.controller.getState().stage).toBe('error'));
    const reports = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/report`);
    return { ...t, reports };
  };

  it("sends the page's own log once; after the window opened a second click sends nothing", async () => {
    const { controller, reports } = await failed(() => jsonResponse({ ok: true, dir: '/d/r1', window: 'note:3', complete: true }));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'opened', dir: '/d/r1', window: 'note:3' });
    await controller.reportBug();
    expect(reports()).toHaveLength(1);
    expect(reports()[0].body).toMatchObject({
      page: { stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'], title: 'Fight Club (1999)' },
    });
  });

  it('a report saved but not opened says so and may be sent again', async () => {
    let n = 0;
    const { controller, reports } = await failed(() =>
      ++n === 1 ? jsonResponse({ error: 'no_tmux', dir: '/d/r1', complete: true }, 409) : jsonResponse({ ok: true, dir: '/d/r1', window: 'note:4', complete: true }),
    );
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'saved', dir: '/d/r1', reason: 'no_tmux' });
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'opened', dir: '/d/r1', window: 'note:4' });
    expect(reports()).toHaveLength(2);
  });

  it('keeps the first folder when the daemon says the session was reported before', async () => {
    const { controller } = await failed(() => jsonResponse({ error: 'already_reported', dir: '/d/r0' }, 409));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'already', dir: '/d/r0' });
  });

  it("an answer without a folder is a failure with the daemon's code", async () => {
    const { controller } = await failed(() => jsonResponse({ error: 'unknown_session' }, 403));
    await controller.reportBug();
    expect(controller.getState().bugReport).toEqual({ status: 'failed', code: 'unknown_session' });
  });
});

describe('a film that keeps stalling', () => {
  const SOURCE = `POST ${S1}/source`;
  const moved = (over: Record<string, unknown> = {}) =>
    jsonResponse({ ...streamSessionJson({ manifest_url: `${S1}/p?u=m2`, provider: 'VidNest Anime' }), switched: true, reason: null, from: 'HyperLink', ...over });

  async function playing(routes: Record<string, (call: FetchCall) => Response>, session: Record<string, unknown> = {}, opts: { muted?: boolean } = {}) {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson(session)), ...routes }, opts);
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stall = async (ms = STALL_MIN_MS) => {
      t.fire('waiting');
      await vi.advanceTimersByTimeAsync(ms);
      t.fire('playing');
    };
    const asks = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/source`);
    return { ...t, stall, asks };
  }

  it('asks for another source after three stalls and plays it from where the film was', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    for (let i = 1; i < STALLS_TO_SWITCH; i++) await t.stall();
    expect(t.asks()).toHaveLength(0);
    t.media.currentTime = 312;
    await t.stall();
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.asks()).toHaveLength(1);
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.made[1].req).toMatchObject({ src: `${S1}/p?u=m2`, startAt: 312 });
    expect(t.controller.getState().log).toEqual(expect.arrayContaining(['stalled at 312 s', '3 stalls in 120 s: asking for another source', 'source: HyperLink -> VidNest Anime at 312 s']));
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null });
  });

  it('a stream that cannot be played at all moves to another provider before the play stops', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    t.made[0].req.handlers.onFatal('mediaError fragParsingError');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.asks()).toHaveLength(1);
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.controller.getState().log).toEqual(expect.arrayContaining(['mediaError fragParsingError: asking for another source']));
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null });
  });

  it('a broken stream stops with its error when no other provider answers, or the session has moved as often as it may', async () => {
    const none = await playing({ [SOURCE]: () => moved({ switched: false, reason: 'no_other_source' }) });
    none.made[0].req.handlers.onFatal('mediaError fragParsingError');
    await vi.waitFor(() => expect(none.controller.getState()).toMatchObject({ stage: 'error', error: 'mediaError fragParsingError' }));
    expect(none.controller.getState().log).toEqual(expect.arrayContaining(['source kept: no_other_source']));

    const t = await playing({ [SOURCE]: () => moved() });
    for (let n = 1; n <= MAX_SOURCE_SWITCHES; n++) {
      t.made[n - 1].req.handlers.onFatal('mediaError fragParsingError');
      await vi.waitFor(() => expect(t.made).toHaveLength(n + 1));
    }
    t.made[MAX_SOURCE_SWITCHES].req.handlers.onFatal('mediaError fragParsingError');
    await vi.waitFor(() => expect(t.controller.getState().stage).toBe('error'));
    expect(t.asks()).toHaveLength(MAX_SOURCE_SWITCHES);
  });

  it('keeps the film when no other source answers, and does not ask again inside the cooldown', async () => {
    const t = await playing({ [SOURCE]: () => moved({ switched: false, reason: 'no_other_source' }) });
    for (let i = 0; i < STALLS_TO_SWITCH * 2; i++) await t.stall();
    await vi.waitFor(() => expect(t.controller.getState().log).toContain('source kept: no_other_source'));
    expect(t.asks()).toHaveLength(1);
    expect(t.made).toHaveLength(1);
    expect(t.made[0].destroy).not.toHaveBeenCalled();
    expect(t.controller.getState().stage).toBe('ready');
    await vi.advanceTimersByTimeAsync(SOURCE_SWITCH_COOLDOWN_MS);
    for (let i = 0; i < STALLS_TO_SWITCH; i++) await t.stall();
    expect(t.asks()).toHaveLength(2);
  });

  it('moves at most twice in one session', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    for (let n = 1; n <= MAX_SOURCE_SWITCHES + 1; n++) {
      for (let i = 0; i < STALLS_TO_SWITCH; i++) await t.stall();
      if (n <= MAX_SOURCE_SWITCHES) {
        await vi.waitFor(() => expect(t.made).toHaveLength(n + 1));
        t.made[n].req.handlers.onReady({ qualities: [], subtitles: [] });
      }
      await vi.advanceTimersByTimeAsync(SOURCE_SWITCH_COOLDOWN_MS);
    }
    expect(t.asks()).toHaveLength(MAX_SOURCE_SWITCHES);
  });

  it('does not count a short wait, a wait after a seek or a wait while paused', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    for (let i = 0; i < 5; i++) await t.stall(STALL_MIN_MS - 100);
    for (let i = 0; i < 5; i++) {
      t.fire('seeking');
      await t.stall();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    t.media.paused = true;
    for (let i = 0; i < 5; i++) await t.stall();
    expect(t.asks()).toHaveLength(0);
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled'))).toBe(false);
  });

  it('counts one long freeze again and again, a freeze after a seek once the grace is over', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    t.fire('seeking');
    t.fire('waiting');
    await vi.advanceTimersByTimeAsync(SEEK_GRACE_MS + STALL_MIN_MS - 100);
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled'))).toBe(false);
    await vi.advanceTimersByTimeAsync(100 + STALL_REPEAT_MS);
    expect(t.asks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STALL_REPEAT_MS);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.asks()).toHaveLength(1);
  });

  it('a cached play that keeps stalling goes back to the live stream, and a muted check never moves', async () => {
    const LOCAL_C1 = '/api/stream/cache/c1/f/master.m3u8';
    const cached = await playing({ [SOURCE]: () => moved({ from: 'cache', provider: 'HyperLink' }) }, { cached: { id: 'c1', state: 'ready', height: 480 }, manifest_url: LOCAL_C1 });
    for (let i = 0; i < STALLS_TO_SWITCH; i++) await cached.stall();
    await vi.waitFor(() => expect(cached.made).toHaveLength(2));
    expect(cached.asks().map((c) => c.body)).toEqual([{ leave_cache: true }]);
    expect(cached.made[1].req).toMatchObject({ src: `${S1}/p?u=m2`, startAt: 300 });
    expect(cached.controller.getState().cached).toBeNull();
    expect(cached.controller.getState().log).toContain(`${STALLS_TO_SWITCH} stalls in 120 s: leaving the cache for the live stream`);
    // A pause no longer moves the play back onto the cache that starved.
    cached.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    cached.media.paused = true;
    cached.fire('pause');
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    expect(cached.calls.filter((c) => c.url === `${S1}/cache`)).toHaveLength(0);
    vi.useRealTimers();
    const muted = await playing({ [SOURCE]: () => moved() }, {}, { muted: true });
    for (let i = 0; i < STALLS_TO_SWITCH; i++) await muted.stall();
    expect(muted.asks()).toHaveLength(0);
  });

  it('the owner asks for another source as often as they like, and is told what came of it', async () => {
    let left = 3;
    const t = await playing({ [SOURCE]: () => (left-- > 0 ? moved({ provider: `P${left}` }) : moved({ switched: false, reason: 'no_other_source' })) });
    for (let n = 1; n <= 3; n++) {
      t.controller.anotherSource();
      expect(t.controller.getState().changingSource).toBe(true);
      await vi.waitFor(() => expect(t.made).toHaveLength(n + 1));
      t.made[n].req.handlers.onReady({ qualities: [], subtitles: [] });
      await vi.waitFor(() => expect(t.controller.getState().changingSource).toBe(false));
    }
    expect(t.controller.getState().sourceNotice).toBe('P0');
    expect(t.controller.getState().log).toContain('asked for another source');
    t.controller.anotherSource();
    await vi.waitFor(() => expect(t.controller.getState().sourceNotice).toBe('No other source'));
    expect(t.asks()).toHaveLength(4);
    expect(t.made).toHaveLength(4);
  });

  it('counts a network recovery as a stall', async () => {
    const t = await playing({ [SOURCE]: () => moved() });
    for (let i = 1; i <= STALLS_TO_SWITCH; i++) {
      t.made[0].req.handlers.onRecovering(1, 'networkError fragLoadError');
      t.made[0].req.handlers.onRecovered();
    }
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.asks()).toHaveLength(1);
  });
});

describe('the daemon moves the play by itself (a check behind the play, a torrent that keeps stalling)', () => {
  it("a stall ask is the page's own (auto), and a move the daemon made says why over the picture", async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/source`]: () =>
        jsonResponse({ ...streamSessionJson({ manifest_url: `${S1}/p?u=m2`, provider: 'VidNest', source_rev: 1, source_note: 'the stream kept stalling' }), switched: true, reason: null, from: 'HyperLink' }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    for (let i = 0; i < STALLS_TO_SWITCH; i++) {
      t.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_MIN_MS);
      t.fire('playing');
    }
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.calls.filter((c) => c.url === `${S1}/source`).map((c) => c.body)).toEqual([{ auto: 'stalled' }]);
    expect(t.controller.getState().switchedWhy).toBe('the stream kept stalling');
    expect(t.controller.getState().log).toContain('switched by the daemon: the stream kept stalling');
  });

  it('a position answer whose source_rev went up loads the new source at the position the film reached', async () => {
    const daemon = { rev: 0 };
    const t = setup({
      [`GET ${S1}`]: () =>
        jsonResponse(
          daemon.rev === 0
            ? streamSessionJson()
            : streamSessionJson({ manifest_url: `${S1}/p?u=m2`, provider: 'VidNest', source_rev: 1, source_note: 'dubbed audio' }),
        ),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: daemon.rev }),
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 612, duration: 1440, paused: false });
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.made).toHaveLength(1);
    daemon.rev = 1;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    // The same session id: the address and the play's memory stay; only the stream changes.
    expect(t.made[1].req).toMatchObject({ src: `${S1}/p?u=m2`, startAt: 612 });
    expect(t.controller.getState()).toMatchObject({ sourceNotice: 'VidNest', switchedWhy: 'dubbed audio' });
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.made).toHaveLength(2);
  });
});

describe('a pause caches the film on this machine', () => {
  const CACHE = `POST ${S1}/cache`;
  const CID = 'cb36a1ba-2c30-458e-8a8a-12475511d510';
  const standing = (over: Record<string, unknown> = {}) => ({ id: CID, state: 'downloading', error: null, progress: 0.1, ...over });
  const onCache = (state: 'downloading' | 'ready') =>
    streamSessionJson({ manifest_url: `/api/stream/cache/${CID}/f/master.m3u8`, cached: { id: CID, state, height: 1080 } });

  const FAKED = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };

  async function paused(routes: Record<string, (call: FetchCall) => Response>, session: Record<string, unknown> = {}, opts: { muted?: boolean } = {}) {
    // Before the page starts: a play that opens on a cache sets its first poll timer at once.
    vi.useFakeTimers({ toFake: [...FAKED.toFake] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson(session)), ...routes }, opts);
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');
    const pause = () => {
      t.media.paused = true;
      t.fire('pause');
    };
    const asks = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/cache`).map((c) => c.body);
    return { ...t, pause, asks };
  }

  it('asks once the pause has lasted, follows the download, then loads the film from the cache where it was, still paused', async () => {
    let n = 0;
    const t = await paused({
      // The first asks find the cache still resolving; the third moves the session onto it.
      [CACHE]: () => (++n < 3 ? jsonResponse({ ...streamSessionJson(), moved: false, cache: standing() }) : jsonResponse({ ...onCache('downloading'), moved: n === 3, cache: standing({ progress: 0.4 }) })),
      [`GET /api/stream/cache/${CID}/map`]: () => jsonResponse({ duration_s: 1440, ranges: [[0, 12], [296, 420.5], ['x', 3], [9, 2]] }),
    });
    t.play.mockClear();
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS - 100);
    expect(t.asks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.asks()).toEqual([{ start: true }]);
    await vi.advanceTimersByTimeAsync(CACHE_POLL_MS * 2);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.asks().slice(0, 3)).toEqual([{ start: true }, { start: false }, { start: false }]);
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.made[1].req).toMatchObject({ src: `/api/stream/cache/${CID}/f/master.m3u8`, startAt: 300 });
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    // The owner paused: loading the local copy must not start the film.
    expect(t.play).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 12], [296, 420.5]]));
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', cached: { id: CID, state: 'downloading' } });
    expect(t.controller.getState().log).toEqual(expect.arrayContaining(['paused: caching on this machine (cb36a1ba)', 'from cache cb36a1ba (downloading) at 300 s']));
  });

  it('a stray session_over from the outgoing engine, raised while the move to the cache is still answering, does not stop the move', async () => {
    const t = await paused({
      [CACHE]: () => {
        // The daemon's answer confirms the move, but notesd's own refusal for a segment the old
        // engine was still buffering arrives (and is handled) before this POST's promise resolves -
        // the exact race that used to end the session instead of moving it onto the cache.
        t.made[0].req.handlers.onSessionOver(403);
        return jsonResponse({ ...onCache('downloading'), moved: true, cache: standing({ progress: 0.4 }) });
      },
      [`GET /api/stream/cache/${CID}/map`]: () => jsonResponse({ duration_s: 1440, ranges: [[0, 300]] }),
    });
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.made[1].req).toMatchObject({ src: `/api/stream/cache/${CID}/f/master.m3u8`, startAt: 300 });
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', cached: { id: CID, state: 'downloading' } });
  });

  it('marks the cache complete when the download ends, and then stops asking', async () => {
    let ready = false;
    const t = await paused(
      {
        [CACHE]: () => jsonResponse({ ...onCache(ready ? 'ready' : 'downloading'), moved: false, cache: standing(ready ? { state: 'ready', progress: 1 } : {}) }),
        [`GET /api/stream/cache/${CID}/map`]: () => jsonResponse({ duration_s: 1440, ranges: ready ? [[0, 1440]] : [[0, 100]] }),
      },
      { manifest_url: `/api/stream/cache/${CID}/f/master.m3u8`, cached: { id: CID, state: 'downloading', height: 1080 } },
    );
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 100]]));
    ready = true;
    await vi.advanceTimersByTimeAsync(CACHE_POLL_MS);
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ cached: { state: 'ready' }, cachedRanges: [[0, 1440]] }));
    const asked = t.calls.length;
    await vi.advanceTimersByTimeAsync(CACHE_POLL_MS * 5);
    expect(t.calls.filter((c) => c.url.includes('/cache')).length).toBe(t.calls.slice(0, asked).filter((c) => c.url.includes('/cache')).length);
    // A cached play is never asked to cache again on a pause.
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    expect(t.asks().every((b) => (b as { start: boolean }).start === false)).toBe(true);
  });

  it('a quick pause asks nothing; a failed cache is said once and the film stays; one ask per session', async () => {
    const t = await paused({ [CACHE]: () => jsonResponse({ ...streamSessionJson(), moved: false, cache: standing({ state: 'failed', error: 'download_failed' }) }) });
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS / 2);
    t.media.paused = false;
    t.fire('play');
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    expect(t.asks()).toEqual([]);
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS);
    await vi.waitFor(() => expect(t.controller.getState().log).toContain('cache: download_failed'));
    await vi.advanceTimersByTimeAsync(CACHE_POLL_MS * 3);
    t.media.paused = false;
    t.fire('play');
    t.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS + CACHE_POLL_MS);
    expect(t.asks()).toEqual([{ start: true }]);
    expect(t.made).toHaveLength(1);
    expect(t.controller.getState().stage).toBe('ready');
  });

  it('never asks for a DASH stream or under ?muted=1', async () => {
    const dash = await paused({ [CACHE]: () => jsonResponse({}) }, { manifest_kind: 'dash' });
    dash.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS * 2);
    expect(dash.asks()).toEqual([]);
    vi.useRealTimers();
    const muted = await paused({ [CACHE]: () => jsonResponse({}) }, {}, { muted: true });
    muted.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS * 2);
    expect(muted.asks()).toEqual([]);
  });
});

describe('the subtitle delay (G and H)', () => {
  /** A <video> with one text track of the given cues, as a browser has them. */
  function withCues(times: [number, number][]) {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    const cues = times.map(([startTime, endTime]) => ({ startTime, endTime }));
    Object.defineProperty(t.video, 'textTracks', { configurable: true, value: Object.assign([{ cues }], {}) });
    return { ...t, cues };
  }
  const store = () => {
    const kept = new Map<string, string>();
    return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  };

  it('moves every cue later or earlier from its own time, never before zero, and back exactly', async () => {
    const t = withCues([[0.02, 1], [95.791, 96.375]]);
    await t.controller.start();
    t.controller.shiftSubtitles(250);
    expect(t.cues).toEqual([{ startTime: 0.27, endTime: 1.25 }, { startTime: 96.041, endTime: 96.625 }]);
    t.controller.shiftSubtitles(-350);
    expect(t.controller.getState().subtitleDelayMs).toBe(-100);
    expect(t.cues[0].startTime).toBe(0);
    expect(t.cues[0].endTime).toBeCloseTo(0.9);
    expect(t.cues[1].startTime).toBeCloseTo(95.691);
    t.controller.shiftSubtitles(100);
    expect(t.cues.map((c) => [c.startTime, c.endTime])).toEqual([[0.02, 1], [95.791, 96.375]]);
    t.controller.shiftSubtitles(10 * SUBTITLE_DELAY_MAX_MS);
    expect(t.controller.getState().subtitleDelayMs).toBe(SUBTITLE_DELAY_MAX_MS);
  });

  it('applies the delay to cues that arrive later, as the film plays', async () => {
    const t = withCues([[10, 11]]);
    await t.controller.start();
    t.controller.shiftSubtitles(500);
    t.cues.push({ startTime: 20, endTime: 21 });
    t.fire('timeupdate');
    expect(t.cues).toEqual([{ startTime: 10.5, endTime: 11.5 }, { startTime: 20.5, endTime: 21.5 }]);
  });

it('reads the lines to show from the tracks, keeps every track hidden, and clears them with the track', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    const track = { kind: 'subtitles', mode: 'showing', activeCues: [] as { text: string }[], cues: [] };
    const off = { kind: 'subtitles', mode: 'disabled', activeCues: [{ text: 'not shown' }], cues: [] };
    const chapters = { kind: 'chapters', mode: 'hidden', activeCues: [{ text: 'Chapter 1' }], cues: [] };
    Object.defineProperty(t.video, 'textTracks', { configurable: true, value: [track, off, chapters] });
    await t.controller.start();
    track.activeCues = [{ text: '<i>- Sorry</i>\n<c.yellow>- It&#39;s fine &amp; done</c>' }, { text: '<v Wong>Copy that.' }];
    t.fire('timeupdate');
    // An engine turned the track on: the page takes the drawing over.
    expect(track.mode).toBe('hidden');
    expect(t.controller.getState().caption).toBe("- Sorry\n- It's fine & done\nCopy that.");
    track.activeCues = [];
    t.fire('timeupdate');
    expect(t.controller.getState().caption).toBe('');
    expect(cueText('<00:01.000>a  \n\n <b>b</b> &lt;3&nbsp;')).toBe('a\nb <3');
  });

  it('keeps the delay per title and starts the next play of it with it', async () => {
    const storage = store();
    const routes = { [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) };
    const make = () => {
      const { fetchImpl } = routeFetch(routes);
      const c = new StreamController('S1', fakeVideo().video, { fetch: fetchImpl, createEngine: fakeEngines().createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {}, storage });
      controllers.push(c);
      return c;
    };
    const first = make();
    await first.start();
    first.shiftSubtitles(-150);
    expect([...storage.kept]).toEqual([['notesd-subtitle-delay:Fight Club (1999)', '-150']]);
    const second = make();
    await second.start();
    expect(second.getState().subtitleDelayMs).toBe(-150);
    second.shiftSubtitles(150);
    expect(storage.kept.size).toBe(0);
  });
});

describe('a torrent session (torrent-stream-source phase 4)', () => {
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const NEXT = '0123456789abcdef0123456789abcdef01234567';
  const STATUS = `GET /api/stream/torrent/${HASH}`;
  const MAP = `GET /api/stream/torrent/${HASH}/map`;
  const torrentJson = (over: Record<string, unknown> = {}) => ({ info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52, ...over });
  const onTorrent = (over: Record<string, unknown> = {}) =>
    streamSessionJson({ provider: 'Torrent', manifest_kind: 'mp4', manifest_url: `/api/stream/torrent/${HASH}/f/0`, torrent: torrentJson(), ...over });
  const downloading = (over: Record<string, unknown> = {}) => jsonResponse({ info_hash: HASH, state: 'downloading', peers: 5, down_kbps: 4000, up_kbps: 800, progress: 0.2, ...over });
  const sixtyOnDisk = () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function playing(routes: Record<string, (call: FetchCall) => Response>, session: Record<string, unknown> = onTorrent()) {
    // Before the page starts: a torrent session sets its poll's timer at once.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(session), ...routes });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    const reads = (hash = HASH) => t.calls.filter((c) => c.method === 'GET' && c.url === `/api/stream/torrent/${hash}`).length;
    return { ...t, reads };
  }

  describe('a subtitle the daemon re-timed while the film plays (Wyzie Synced)', () => {
    const OLD = `/api/stream/torrent/${HASH}/sub/service-wyzie-9.vtt`;
    const NEW = `/api/stream/torrent/${HASH}/sub/synced-0.vtt`;
    const vtt = (line: string) => new Response(`WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${line}\n`, { status: 200 });
    const store = () => {
      const kept = new Map<string, string>();
      return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    };

    /** A torrent session with a Wyzie subtitle; `rev` is what the daemon says now, in the session and in the answer to a position report. */
    async function synced(storage?: ReturnType<typeof store>, next: { url: string; label: string } = { url: NEW, label: 'English (Wyzie, synced)' }) {
      const daemon = { rev: 0 };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      const { made, createEngine } = fakeEngines();
      const { fetchImpl, calls } = routeFetch({
        [`GET ${S1}`]: () =>
          jsonResponse(
            onTorrent({
              subtitle_rev: daemon.rev,
              subtitles: [daemon.rev === 0 ? sessionTrack(OLD, 'en', 'English (Wyzie)') : sessionTrack(next.url, 'en', next.label)],
            }),
          ),
        [`GET ${OLD}`]: () => vtt('Out of step.'),
        [`GET ${next.url}`]: () => vtt('In step.'),
        [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: daemon.rev }),
        [STATUS]: () => downloading(),
        [MAP]: sixtyOnDisk,
      });
      const { video, media, fire } = fakeVideo();
      const texts: string[] = [];
      const controller = new StreamController('S1', video, { fetch: fetchImpl, createEngine, textUrl: (t) => `blob:vtt-${texts.push(t)}`, revokeTextUrl: () => {}, ...(storage === undefined ? {} : { storage }) });
      controllers.push(controller);
      void controller.start();
      await vi.waitFor(() => expect(made).toHaveLength(1));
      made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
      Object.assign(media, { currentTime: 30, duration: 888, paused: false });
      fire('timeupdate');
      const tracks = () => [...video.querySelectorAll('track')].map((el) => el.label);
      const sessionReads = () => calls.filter((c) => c.method === 'GET' && c.url === S1).length;
      return { controller, daemon, made, video, media, fire, texts, tracks, sessionReads };
    }

    it('loads the synced file in place of the old one: the film, the position and the choice stay, and the delay goes back to 0', async () => {
      const storage = store();
      const t = await synced(storage);
      expect(t.tracks()).toEqual(['English (Wyzie)']);
      expect(t.controller.getState()).toMatchObject({ subtitle: 'file-0', subtitleSyncs: 0 });
      t.controller.shiftSubtitles(-900);
      expect(storage.kept.size).toBe(1);
      // A report whose answer says nothing new changes nothing.
      await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
      expect(t.sessionReads()).toBe(1);
      t.daemon.rev = 1;
      await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
      await vi.waitFor(() => expect(t.tracks()).toEqual(['English (Wyzie, synced)']));
      expect(t.texts.at(-1)).toContain('In step.');
      expect(t.controller.getState()).toMatchObject({ stage: 'ready', subtitle: 'file-0', subtitleSyncs: 1, subtitleDelayMs: 0 });
      expect(t.controller.getState().subtitles.map((o) => o.label)).toEqual(['English (Wyzie, synced)']);
      expect(storage.kept.size).toBe(0);
      // The film was never loaded again.
      expect(t.made).toHaveLength(1);
      expect(t.made[0].destroy).not.toHaveBeenCalled();
      expect(t.media.currentTime).toBe(30);
      expect(t.controller.getState().log.at(-1)).toBe('subtitles synced: English (Wyzie, synced)');
      // The same number again: read once, not on every report.
      await vi.advanceTimersByTimeAsync(3 * POSITION_INTERVAL_MS);
      expect(t.sessionReads()).toBe(2);
      expect(t.controller.getState().subtitleSyncs).toBe(1);
    });

    it('a subtitle /sync-subtitle checked and re-timed resets the delay too', async () => {
      const storage = store();
      const t = await synced(storage, { url: `/api/stream/torrent/${HASH}/sub/checked-0-ab12.vtt`, label: 'English (checked)' });
      t.controller.shiftSubtitles(-900);
      t.daemon.rev = 1;
      await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
      await vi.waitFor(() => expect(t.tracks()).toEqual(['English (checked)']));
      expect(t.controller.getState()).toMatchObject({ subtitleDelayMs: 0 });
      expect(storage.kept.size).toBe(0);
    });

    it('subtitles the viewer turned off stay off', async () => {
      const t = await synced();
      t.controller.selectSubtitle(null);
      t.daemon.rev = 1;
      await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
      await vi.waitFor(() => expect(t.tracks()).toEqual(['English (Wyzie, synced)']));
      expect(t.controller.getState()).toMatchObject({ subtitle: null, subtitleSyncs: 1 });
      // Turned on again, it is the synced one.
      t.controller.selectSubtitle('file-0');
      expect(t.controller.getState().subtitle).toBe('file-0');
    });
  });

  it('a cloud stream with no subtitle shows the outside one that arrives behind the play, with no "synced" line', async () => {
    const URL_ = '/api/stream/subs/movie-550/outside.vtt';
    let rev = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ subtitle_rev: rev, subtitles: rev === 0 ? [] : [sessionTrack(URL_, 'en', 'English (Wyzie)')] })),
      [`GET ${URL_}`]: () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nFrom outside.\n', { status: 200 }),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: rev }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    expect(t.controller.getState()).toMatchObject({ subtitles: [], subtitle: null });
    t.controller.shiftSubtitles(200);
    rev = 1;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(t.controller.getState().subtitle).toBe('file-0'));
    // Not a re-timed file: nothing says "synced", and the delay is the owner's still.
    expect(t.controller.getState()).toMatchObject({ subtitleSyncs: 0, subtitleDelayMs: 200 });
    expect(t.controller.getState().log.at(-1)).toBe('subtitles changed: English (Wyzie)');
    expect(t.made).toHaveLength(1);
  });

  it('reads the torrent a session plays, and nothing it cannot use', () => {
    expect(parseSession(onTorrent()).torrent).toEqual({ infoHash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', seeds: 52, state: 'downloading' });
    expect(parseSession(onTorrent({ torrent: torrentJson({ info_hash: HASH.toUpperCase(), state: 'ready', seeds: 'x', index: 3 }) })).torrent).toEqual({
      infoHash: HASH,
      name: 'Sintel.2010.1080p.WEB.x264',
      index: null,
      seeds: null,
      state: 'ready',
    });
    expect(parseSession(onTorrent({ torrent: torrentJson({ info_hash: 'magnet:?xt=urn:btih:x' }) })).torrent).toBeNull();
    expect(parseSession(streamSessionJson()).torrent).toBeNull();
    // A session is never both: the torrent wins over a cache it should not name.
    expect(parseSession(onTorrent({ cached: { id: 'c1', state: 'ready', height: 720 } })).cached).toBeNull();
  });

  it('shows the peers, the speed and what is on disk while it downloads, and stops asking once it is complete', async () => {
    let ready = false;
    const t = await playing({
      [STATUS]: () => (ready ? jsonResponse({ info_hash: HASH, state: 'ready', peers: 0, down_kbps: 0, progress: 1 }) : downloading({ peers: 12, down_kbps: 27200, progress: 0.37 })),
      [MAP]: () => jsonResponse({ duration_s: 888, ranges: ready ? [[0, 888]] : [[0, 60], [400, 420]] }),
    });
    await vi.waitFor(() => expect(t.controller.getState().torrent).toMatchObject({ infoHash: HASH, state: 'downloading', peers: 12, downKbps: 27200, progress: 0.37, fetching: false }));
    expect(t.controller.getState().cachedRanges).toEqual([[0, 60], [400, 420]]);
    expect(t.controller.getState().cached).toBeNull();
    expect(t.controller.getState().log).toContain('from torrent 08ada5a7 Sintel.2010.1080p.WEB.x264 (downloading)');
    const before = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS);
    expect(t.reads()).toBeGreaterThan(before);
    ready = true;
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS);
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ torrent: { state: 'ready' }, cachedRanges: [[0, 888]] }));
    expect(t.controller.getState().log).toContain('torrent 08ada5a7 on disk');
    const done = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 5);
    expect(t.reads()).toBe(done);
  });

  it("puts the map on the film's own clock when the daemon counted it against another length", () => {
    expect(scaleRanges([[0, 100], [500, 1000]], 1000, 500)).toEqual([[0, 50], [250, 500]]);
    expect(scaleRanges([[0, 100]], null, 500)).toEqual([[0, 100]]);
    expect(scaleRanges([[0, 100]], 1000, 0)).toEqual([[0, 100]]);
    expect(onDisk([[0, 60]], 59.9)).toBe(true);
    expect(onDisk([[0, 60]], 61)).toBe(false);
  });

  it('asks nothing while the tab is hidden, and asks again as soon as it shows', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const t = await playing({ [STATUS]: () => downloading({ peers: 3 }), [MAP]: sixtyOnDisk });
    await vi.waitFor(() => expect(t.controller.getState().torrent?.peers).toBe(3));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const hidden = t.reads();
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 6);
    expect(t.reads()).toBe(hidden);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(t.reads()).toBe(hidden + 1));
  });

  it('a torrent that buffers now and then does not ask for another source by itself; the button moves to the next torrent and names it', async () => {
    const t = await playing({
      [STATUS]: () => downloading(),
      [MAP]: sixtyOnDisk,
      [`GET /api/stream/torrent/${NEXT}`]: () => jsonResponse({ info_hash: NEXT, state: 'ready', peers: 0, down_kbps: 0, progress: 1 }),
      [`GET /api/stream/torrent/${NEXT}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 888]] }),
      [`POST ${S1}/source`]: () =>
        jsonResponse({
          ...onTorrent({ manifest_url: `/api/stream/torrent/${NEXT}/f/0`, torrent: torrentJson({ info_hash: NEXT, name: 'Sintel.2010.720p.BluRay.x264', state: 'ready' }) }),
          switched: true,
          reason: null,
          from: 'Torrent',
          provider: 'Torrent',
        }),
    });
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    // Fewer than TORRENT_STALLS_TO_SWITCH within the window, spread out: a torrent filling, not failing.
    for (let i = 0; i < TORRENT_STALLS_TO_SWITCH * 2; i++) {
      t.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_MIN_MS);
      t.fire('playing');
      await vi.advanceTimersByTimeAsync(STALL_WINDOW_MS / (TORRENT_STALLS_TO_SWITCH - 1));
    }
    const asks = () => t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/source`);
    expect(asks()).toHaveLength(0);
    expect(t.controller.getState().log.filter((line) => line.startsWith('stalled at'))).toHaveLength(TORRENT_STALLS_TO_SWITCH * 2);
    expect(t.controller.getState().log.some((line) => line.includes('asking for another source'))).toBe(false);
    t.controller.anotherSource();
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(asks()).toHaveLength(1);
    expect(t.made[1].req).toMatchObject({ kind: 'mp4', src: `/api/stream/torrent/${NEXT}/f/0`, startAt: 30 });
    await vi.waitFor(() => expect(t.controller.getState().torrent).toMatchObject({ infoHash: NEXT, state: 'ready' }));
    expect(t.controller.getState().sourceNotice).toBe('Sintel.2010.720p.BluRay.x264');
    await vi.waitFor(() => expect(t.reads(NEXT)).toBeGreaterThanOrEqual(1));
    const first = t.reads();
    const next = t.reads(NEXT);
    await vi.advanceTimersByTimeAsync(TORRENT_POLL_MS * 3);
    // The torrent it left is no longer read, and the next one is complete: nothing more to ask.
    expect(t.reads()).toBe(first);
    expect(t.reads(NEXT)).toBe(next);
  });

  it('a torrent that keeps stalling asks the daemon by itself, and plays the torrent it moved to from where the film was', async () => {
    const t = await playing({
      [STATUS]: () => downloading({ peers: 2, down_kbps: 300 }),
      [MAP]: sixtyOnDisk,
      [`GET /api/stream/torrent/${NEXT}`]: () => jsonResponse({ info_hash: NEXT, state: 'downloading', peers: 30, down_kbps: 9000, progress: 0.1 }),
      [`GET /api/stream/torrent/${NEXT}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 40]] }),
      [`POST ${S1}/source`]: () =>
        jsonResponse({
          ...onTorrent({ manifest_url: `/api/stream/torrent/${NEXT}/f/0`, torrent: torrentJson({ info_hash: NEXT, name: 'Sintel.2010.1080p.BluRay.x264' }), source_rev: 1, source_note: 'the torrent kept stalling' }),
          switched: true,
          reason: null,
          from: 'Torrent: Sintel.2010.1080p.WEB.x264',
          provider: 'Torrent',
        }),
    });
    for (let i = 0; i < TORRENT_STALLS_TO_SWITCH; i++) {
      t.fire('waiting');
      await vi.advanceTimersByTimeAsync(STALL_MIN_MS);
      t.fire('playing');
    }
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/source`).map((c) => c.body)).toEqual([{ auto: 'stalled' }]);
    expect(t.made[1].req).toMatchObject({ src: `/api/stream/torrent/${NEXT}/f/0`, startAt: 30 });
    expect(t.controller.getState().switchedWhy).toBe('the torrent kept stalling');
  });

  it('a seek past what is on disk waits for it, and the wait ends when the part arrives', async () => {
    const t = await playing({ [STATUS]: () => downloading(), [MAP]: sixtyOnDisk });
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    t.media.currentTime = 400;
    t.fire('seeking');
    expect(t.controller.getState().torrent?.fetching).toBe(true);
    expect(t.controller.getState().log).toContain('waiting for the torrent at 400 s');
    t.fire('seeked');
    expect(t.controller.getState().torrent?.fetching).toBe(false);
    t.media.currentTime = 20;
    t.fire('seeking');
    expect(t.controller.getState().torrent?.fetching).toBe(false);
  });

  it('a cloud stream has no torrent and never waits this way', async () => {
    const t = await playing({}, streamSessionJson());
    t.media.currentTime = 400;
    t.fire('seeking');
    expect(t.controller.getState().torrent).toBeNull();
    expect(t.calls.some((c) => c.url.startsWith('/api/stream/torrent/'))).toBe(false);
  });

  it('a pause asks for no stream cache: the torrent is already on this machine', async () => {
    const t = await playing({ [STATUS]: () => downloading(), [MAP]: sixtyOnDisk, [`POST ${S1}/cache`]: () => jsonResponse({}) });
    t.media.paused = true;
    t.fire('pause');
    await vi.advanceTimersByTimeAsync(PAUSE_CACHE_DELAY_MS * 2);
    expect(t.calls.filter((c) => c.url === `${S1}/cache`)).toEqual([]);
  });
});

describe('a growing subtitle (a cue feed)', () => {
  it('starts the track empty, reads the feed once the track has loaded, adds each cue as it arrives, and stops at complete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const added: { startTime: number; endTime: number; text: string }[] = [];
    const fakeTrack = { mode: 'disabled', addCue: (cue: { startTime: number; endTime: number; text: string }) => added.push(cue) };
    const had = Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'track');
    Object.defineProperty(HTMLTrackElement.prototype, 'track', { configurable: true, get: () => fakeTrack });
    vi.stubGlobal(
      'VTTCue',
      class {
        constructor(
          public startTime: number,
          public endTime: number,
          public text: string,
        ) {}
      },
    );
    try {
      const FEED = `/api/stream/torrent/${'a'.repeat(40)}/cues/embedded-2`;
      const t = setup({
        [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_kind: 'mp4', manifest_url: '/api/stream/torrent/x/f/0', subtitles: [sessionTrack(FEED, 'en', 'English', { format: 'cues', growing: true })] })),
        [`GET ${FEED}?after=0`]: () => jsonResponse({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false }),
        [`GET ${FEED}?after=2`]: () => jsonResponse({ cues: [{ start_s: 7, end_s: 9, text: 'Line 3' }], next: 3, complete: true }),
      });
      void t.controller.start();
      await vi.waitFor(() => expect(t.made).toHaveLength(1));
      // The track starts as an empty WebVTT file; nothing was fetched for it yet.
      expect(t.texts).toEqual(['WEBVTT\n\n']);
      expect(t.calls.some((c) => c.url.startsWith(FEED))).toBe(false);
      t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
      expect(t.controller.getState().subtitle).toBe('file-0');
      expect(fakeTrack.mode).toBe('hidden');
      t.video.querySelector('track')?.dispatchEvent(new Event('load'));
      await vi.waitFor(() => expect(added.map((c) => c.text)).toEqual(['Line 1', 'Line 2']));
      await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
      await vi.waitFor(() => expect(added.map((c) => [c.startTime, c.endTime, c.text])).toEqual([[1, 3, 'Line 1'], [4, 6, 'Line 2'], [7, 9, 'Line 3']]));
      await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
      expect(t.calls.filter((c) => c.url.startsWith(FEED)).map((c) => c.url)).toEqual([`${FEED}?after=0`, `${FEED}?after=2`]);
      expect(t.controller.getState().log).toContain('subtitle English: complete, 3 cues');
    } finally {
      if (had) Object.defineProperty(HTMLTrackElement.prototype, 'track', had);
      else delete (HTMLTrackElement.prototype as { track?: unknown }).track;
      vi.unstubAllGlobals();
    }
  });

  it('parses growing only when the daemon says so', () => {
    const FEED = '/api/stream/torrent/x/cues/embedded-2';
    expect(parseSession(streamSessionJson({ subtitles: [sessionTrack(FEED, 'en', 'English', { format: 'cues', growing: true })] })).subtitles).toEqual([{ url: FEED, lang: 'en', label: 'English', english: true, growing: true }]);
    expect(parseSession(streamSessionJson({ subtitles: [sessionTrack('/x', 'en', 'English', { growing: 'yes' })] })).subtitles).toEqual([{ url: '/x', lang: 'en', label: 'English', english: true }]);
  });
});

describe('a play carries on after the daemon restarts', () => {
  const S2 = '/api/stream/sessions/S2';
  const CONTINUE = 'POST /api/stream/continue';
  const fresh = (over: Record<string, unknown> = {}) => jsonResponse({ ...streamSessionJson({ session_id: 'S2', manifest_url: `${S2}/p?u=m9`, resume_s: 300 }), continued: true, ...over });
  const tabStore = () => {
    const kept = new Map<string, string>();
    return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  };

  async function playing(routes: Record<string, (call: FetchCall) => Response>, session: Record<string, unknown> = {}) {
    const memory = tabStore();
    const sessions: string[] = [];
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson(session)), ...routes }, { memory, onSession: (id) => void sessions.push(id) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');
    const continues = () => t.calls.filter((c) => c.method === 'POST' && c.url === '/api/stream/continue').map((c) => c.body);
    return { ...t, memory, sessions, continues };
  }

  it('a position report the daemon no longer knows gets a fresh session for the same play, at the same place', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = await playing({ [`POST ${S1}/position`]: () => jsonResponse({ error: 'unknown_session' }, 404), [CONTINUE]: () => fresh() });
    t.media.currentTime = 305;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.continues()).toEqual([{ kind: 'movie', tmdb_id: 550, session_id: 'S1', provider: 'VidFast', info_hash: null, position_s: 305 }]);
    expect(t.made[0].destroy).toHaveBeenCalled();
    expect(t.made[1].req).toMatchObject({ src: `${S2}/p?u=m9`, startAt: 305 });
    expect(t.sessions).toEqual(['S2']);
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', reconnecting: false });
    // Reports go to the new session from then on; the tab remembers it for a reload.
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts(`${S2}/position`).length).toBeGreaterThan(0);
    expect(JSON.parse(t.memory.kept.get('notesd-stream-play:S2')!)).toMatchObject({ ref: { kind: 'movie', tmdb_id: 550 }, provider: 'VidFast' });
    expect(t.controller.getState().log).toContain('carried on in session S2 at 305 s');
  });

  it('while the daemon is down it says it is reconnecting and asks again, a torrent by its info hash', async () => {
    const HASH = 'ab'.repeat(20);
    let down = true;
    const t = await playing(
      {
        [`POST ${S1}/position`]: () => {
          throw new Error('connection refused');
        },
        [CONTINUE]: () => {
          if (down) throw new Error('connection refused');
          return fresh({ provider: 'Torrent', torrent: { info_hash: HASH, file_index: 0, name: 'Film', index: null, state: 'ready', seeds: null } });
        },
      },
      { provider: 'Torrent', torrent: { info_hash: HASH, file_index: 0, name: 'Film', index: 'torrentio', state: 'downloading', seeds: 9 } },
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Play after a pause reports at once.
    t.fire('play');
    await vi.waitFor(() => expect(t.controller.getState().reconnecting).toBe(true));
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 3);
    expect(t.continues().length).toBeGreaterThanOrEqual(3);
    expect(t.continues()[0]).toMatchObject({ provider: 'Torrent', info_hash: HASH });
    expect(t.controller.getState().stage).not.toBe('error');
    down = false;
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.controller.getState()).toMatchObject({ reconnecting: false, torrent: { infoHash: HASH, state: 'ready' } });
  });

  it('gives up after three minutes with the ended message', async () => {
    const t = await playing({
      [`POST ${S1}/position`]: () => jsonResponse({ error: 'unknown_session' }, 404),
      [CONTINUE]: () => {
        throw new Error('connection refused');
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Play after a pause reports at once.
    t.fire('play');
    await vi.waitFor(() => expect(t.controller.getState().reconnecting).toBe(true));
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS - 10_000);
    expect(t.controller.getState().stage).not.toBe('error');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'session_over', reconnecting: false });
  });

  it('a reload of the page after the restart carries the play on from what the tab remembers', async () => {
    const memory = tabStore();
    memory.setItem('notesd-stream-play:S1', JSON.stringify({ ref: { kind: 'tv', tmdb_id: 37854, season: 18, episode: 787 }, provider: 'Beta', infoHash: null, positionS: 1312.4 }));
    const t = setup({ [`GET ${S1}`]: () => jsonResponse({ error: 'unknown_session' }, 403), [CONTINUE]: () => fresh({ resume_s: 1312.4 }) }, { memory });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    expect(t.calls.find((c) => c.url === '/api/stream/continue')?.body).toEqual({ kind: 'tv', tmdb_id: 37854, season: 18, episode: 787, session_id: 'S1', provider: 'Beta', info_hash: null, position_s: 1312.4 });
    expect(t.made[0].req).toMatchObject({ src: `${S2}/p?u=m9`, startAt: 1312.4 });
  });

  it('a title nothing streams any more stops with no_source', async () => {
    const t = await playing({ [`POST ${S1}/position`]: () => jsonResponse({ error: 'unknown_session' }, 404), [CONTINUE]: () => jsonResponse({ error: 'no_source' }, 502) });
    t.fire('pause');
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'no_source' }));
    expect(t.made).toHaveLength(1);
  });
});

describe('StreamController: seek previews (seek-preview-thumbnails phase 4)', () => {
  const PREVIEWS = `${S1}/previews`;
  const SHEET = `${S1}/previews/sheet-00000.jpg`;
  const reads = (t: { calls: FetchCall[] }, url = PREVIEWS) => t.calls.filter((c) => c.method === 'GET' && c.url === url).length;

  it('reads the answer once and keeps only what it can draw', () => {
    const cues = [
      previewCueJson(SHEET, 10, 1),
      previewCueJson(SHEET, 0, 0),
      { ...previewCueJson(SHEET, 20, 2), url: '//elsewhere.example/x.jpg' },
      { ...previewCueJson(SHEET, 30, 3), w: 0 },
      previewCueJson(SHEET, 5, 0),
      { start_s: 40, end_s: 40, url: SHEET, x: 0, y: 0, w: 240, h: 135 },
    ];
    expect(parsePreviews(previewsJson({ rev: 3, cues }))).toEqual({
      state: 'partial',
      rev: 3,
      source: 'local',
      cues: [
        { startS: 0, endS: 10, url: SHEET, x: 0, y: 0, w: 240, h: 135 },
        { startS: 10, endS: 20, url: SHEET, x: 240, y: 0, w: 240, h: 135 },
      ],
    });
    // `none` is no cue and no source, whatever the answer said.
    expect(parsePreviews({ state: 'ready', rev: 1, source: 'provider', cues: [] })).toEqual({ state: 'none', rev: 1, source: null, cues: [] });
    expect(parsePreviews({ state: 'ready', rev: 1 })).toBeNull();
    expect(parsePreviews(null)).toBeNull();
    expect(parseSession(streamSessionJson()).previewRev).toBe(0);
    expect(parseSession(streamSessionJson({ preview_rev: 4 })).previewRev).toBe(4);
  });

  it('never throws: a 404, a network failure and a body it cannot read are null', async () => {
    expect(await fetchPreviews('S1', routeFetch({}).fetchImpl)).toBeNull();
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchPreviews('S1', down)).toBeNull();
    expect(await fetchPreviews('S1', routeFetch({ [`GET ${PREVIEWS}`]: () => new Response('<html>', { status: 200 }) }).fetchImpl)).toBeNull();
  });

  it('reads the frames once the session loads and again only when a position answer carries a higher preview_rev; a failed read keeps them (R1.5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const daemon = { rev: 0, cues: [previewCueJson(SHEET, 0, 0)], down: false };
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ preview_rev: daemon.rev })),
      [`GET ${PREVIEWS}`]: () => (daemon.down ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(previewsJson({ rev: daemon.rev, cues: daemon.cues }))),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: daemon.rev }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.controller.getState().previews.cues).toHaveLength(1));
    expect(reads(t)).toBe(1);
    expect(t.controller.getState().log).toContain('previews: partial, 1 frame (local, rev 0)');
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    // Reports that carry the same number read nothing, and nothing reads on a timer.
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 6);
    expect(t.posts().length).toBeGreaterThanOrEqual(5);
    expect(reads(t)).toBe(1);
    daemon.rev = 1;
    daemon.cues = [previewCueJson(SHEET, 0, 0), previewCueJson(SHEET, 10, 1)];
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(t.controller.getState().previews).toMatchObject({ rev: 1, cues: [{ startS: 0 }, { startS: 10 }] }));
    expect(reads(t)).toBe(2);
    expect(t.controller.getState().log).toContain('previews: partial, 2 frames (local, rev 1)');
    // A read that fails keeps the frames the page had and puts nothing on the page.
    daemon.rev = 2;
    daemon.down = true;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(reads(t)).toBe(3));
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null, previews: { rev: 1, cues: [{ startS: 0 }, { startS: 10 }] } });
    // The same rev is not asked again; the film was never loaded again.
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 3);
    expect(reads(t)).toBe(3);
    expect(t.made).toHaveLength(1);
  });

  it('works against a daemon with no previews: no preview_rev, a 404, nothing said', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0 }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 3);
    expect(reads(t)).toBe(1);
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', previews: NO_PREVIEWS, errors: [] });
    expect(t.controller.getState().log.some((line) => line.startsWith('previews'))).toBe(false);
  });

  it("drops the frames of the episode it leaves and reads the next one's", async () => {
    const S2 = '/api/stream/sessions/S2';
    const t = setup(
      {
        [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ kind: 'tv', season: 1, episode: 1, next_episode: { season: 1, episode: 2 } })),
        [`GET ${PREVIEWS}`]: () => jsonResponse(previewsJson({ state: 'ready', cues: [previewCueJson(SHEET, 0, 0)] })),
        [`POST ${S1}/episode`]: () => jsonResponse({ session_id: 'S2' }),
        [`GET ${S2}`]: () => jsonResponse(streamSessionJson({ session_id: 'S2', manifest_url: `${S2}/p?u=m2`, kind: 'tv', season: 1, episode: 2, prev_episode: { season: 1, episode: 1 } })),
      },
      { onSession: () => {} },
    );
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.controller.getState().previews.state).toBe('ready'));
    await t.controller.goToEpisode('next');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    // Episode 2's previews answer 404: the page shows none, never episode 1's.
    await vi.waitFor(() => expect(reads(t, `${S2}/previews`)).toBe(1));
    expect(t.controller.getState().previews).toEqual(NO_PREVIEWS);
  });
});

describe('the counters in every position report (R1.6)', () => {
  const LOAD_ID = /^[A-Za-z0-9_-]{8,32}$/;
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const S2 = '/api/stream/sessions/S2';
  type Stats = { load: string; first_frame_ms: number | null; played_ms: number; stalls: number; stalled_ms: number; waits: number; waited_ms: number; errors: number };

  /** A page whose counters' clock moves only when the test says; `elapse` moves it and the timers together. */
  function counted(session: Record<string, unknown> = streamSessionJson(), routes: Record<string, (call: FetchCall) => Response> = {}) {
    const clock = { ms: 0 };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(session), ...routes }, { now: () => clock.ms });
    const elapse = async (ms: number) => {
      clock.ms += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    /** The film plays `seconds` on: a time update every 250 ms. */
    const play = async (seconds: number) => {
      for (let i = 0; i < seconds * 4; i++) {
        await elapse(250);
        t.media.currentTime += 0.25;
        t.fire('timeupdate');
      }
    };
    /** The page reports at once: a closing tab says its last position each time it is told, and changes no counter. */
    const reportNow = () => window.dispatchEvent(new Event('pagehide'));
    const bodiesTo = (url = `${S1}/position`) => t.calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body as Record<string, unknown> & { stats: Stats });
    const last = (url = `${S1}/position`) => bodiesTo(url).at(-1)?.stats;
    return { ...t, clock, elapse, play, reportNow, bodiesTo, last };
  }

  async function ready(t: ReturnType<typeof counted>, engine = 0) {
    await vi.waitFor(() => expect(t.made).toHaveLength(engine + 1));
    t.made[engine].req.handlers.onReady({ qualities: [], subtitles: [] });
  }

  it('times the first frame from the page load, counts play only while the film moves, and sends it all under one load id in every kind of report', async () => {
    const t = counted();
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    await t.elapse(1_200);
    await ready(t);
    t.fire('playing');
    await t.play(10);
    t.reportNow();
    const first = t.last();
    // The first update only starts the count: 39 gaps of 250 ms.
    expect(first).toEqual({ load: expect.stringMatching(LOAD_ID), first_frame_ms: 1_200, played_ms: 9_750, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });

    // Paused: the pause report and the beat carry the counters, and play stops counting.
    t.media.paused = true;
    t.fire('pause');
    await t.elapse(POSITION_INTERVAL_MS);
    const [pausedReport, beat] = t.bodiesTo().slice(-2);
    expect(pausedReport).toMatchObject({ paused: true, stats: first });
    expect(beat).toMatchObject({ beat: true, stats: first });

    // Play again, then the end: the first update after the pause only starts the count again.
    t.media.paused = false;
    t.fire('play');
    await t.play(2);
    Object.assign(t.media, { duration: 600, ended: true });
    t.fire('ended');
    expect(t.bodiesTo().at(-1)).toMatchObject({ ended: true, stats: { ...first, played_ms: 9_750 + 1_750 } });
    expect(new Set(t.bodiesTo().map((b) => b.stats.load))).toEqual(new Set([first?.load]));
  });

  it('counts a stall once the wait outlasts STALL_MIN_MS, timed from the moment the film stood still until it moves again', async () => {
    const t = counted();
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(2);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS);
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled at'))).toBe(true);
    await t.elapse(2_500);
    // Still frozen: the report counts it up to now.
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: 4_000 });
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    // Played: 7 gaps before the freeze, 3 after it; the frozen time is not play.
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: 4_000, played_ms: 2_500 });
  });

  it('counts one long freeze as one stall, though the switch rule counts it every STALL_REPEAT_MS', async () => {
    const t = counted();
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(1);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS + STALL_REPEAT_MS + 500);
    t.fire('playing');
    t.reportNow();
    expect(t.controller.getState().log.filter((line) => line.startsWith('stalled at'))).toHaveLength(2);
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: STALL_MIN_MS + STALL_REPEAT_MS + 500 });
  });

  it("does not count the first load, a short wait, a seek's own wait within the grace or a wait while paused", async () => {
    const t = counted();
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    // The first load: the engine is not ready yet.
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS * 2);
    await ready(t);
    t.fire('playing');
    await t.play(1);
    // A short wait.
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS - 100);
    t.fire('playing');
    // A seek's own wait, inside the grace.
    t.media.currentTime = 900;
    t.fire('seeking');
    t.fire('waiting');
    await t.elapse(SEEK_GRACE_MS);
    t.fire('playing');
    await t.play(1);
    // A wait while paused.
    t.media.paused = true;
    t.fire('pause');
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS * 3);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0 });
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled'))).toBe(false);
  });

  it("counts a torrent's wait for a missing part as a wait, never as a stall, though the stall timer fires during it", async () => {
    const t = counted(
      streamSessionJson({
        provider: 'Torrent',
        manifest_kind: 'mp4',
        manifest_url: `/api/stream/torrent/${HASH}/f/0`,
        torrent: { info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52 },
      }),
      {
        [`GET /api/stream/torrent/${HASH}`]: () => jsonResponse({ info_hash: HASH, state: 'downloading', peers: 5, down_kbps: 4000, up_kbps: 800, progress: 0.2 }),
        [`GET /api/stream/torrent/${HASH}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] }),
      },
    );
    void t.controller.start();
    await ready(t);
    t.media.duration = 888;
    t.fire('playing');
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    await t.play(1);
    t.media.currentTime = 400;
    t.fire('seeking');
    t.fire('waiting');
    await t.elapse(SEEK_GRACE_MS + STALL_MIN_MS + 1_000);
    expect(t.controller.getState().log).toContain('waiting for the torrent at 400 s');
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled at'))).toBe(true);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 1, waited_ms: SEEK_GRACE_MS + STALL_MIN_MS + 1_000 });
    // The part arrives: the wait ends there.
    t.fire('seeked');
    t.fire('playing');
    await t.elapse(1_000);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 1, waited_ms: SEEK_GRACE_MS + STALL_MIN_MS + 1_000 });
  });

  it('counts each network error the engine rides out and each stream it declared broken', async () => {
    const t = counted(streamSessionJson(), {
      [`POST ${S1}/source`]: () => jsonResponse({ ...streamSessionJson({ manifest_url: `${S1}/p?u=m2`, provider: 'VidNest Anime' }), switched: true, reason: null, from: 'VidFast' }),
    });
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(1);
    // One network error, ridden out over two restarts.
    t.made[0].req.handlers.onRecovering(1, 'networkError fragLoadError');
    t.made[0].req.handlers.onRecovering(2, 'networkError fragLoadError');
    t.made[0].req.handlers.onRecovered();
    // A stream that cannot be played at all: the page moves to another provider and plays on.
    t.made[0].req.handlers.onFatal('mediaError bufferAppendError');
    await ready(t, 1);
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    expect(t.last()).toMatchObject({ errors: 2 });
  });

  it('starts a new load id and fresh counters when the page plays another session without loading again', async () => {
    const ep = (over: Record<string, unknown>) => streamSessionJson({ kind: 'tv', tmdb_id: 37854, season: 17, ...over });
    const next = ep({ session_id: 'S2', episode: 731, manifest_url: `${S2}/p?u=m731`, prev_episode: { season: 17, episode: 730 } });
    const t = counted(ep({ episode: 730, next_episode: { season: 17, episode: 731 } }), {
      [`POST ${S1}/episode`]: () => jsonResponse(next),
      [`GET ${S2}`]: () => jsonResponse(next),
    });
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(2);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS);
    t.fire('playing');
    await t.controller.goToEpisode('next');
    // The old session's last word carries its own counters.
    const old = t.last();
    expect(t.bodiesTo().at(-1)).toMatchObject({ closed: true });
    expect(old).toMatchObject({ stalls: 1, stalled_ms: STALL_MIN_MS });
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    await t.elapse(800);
    await ready(t, 1);
    t.media.currentTime = 0;
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    const fresh = t.last(`${S2}/position`);
    expect(fresh).toEqual({ load: expect.stringMatching(LOAD_ID), first_frame_ms: 800, played_ms: 750, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });
    expect(fresh?.load).not.toBe(old?.load);
  });
});

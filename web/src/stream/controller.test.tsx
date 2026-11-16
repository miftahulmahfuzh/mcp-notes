// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REFRESHES, MAX_SOURCE_SWITCHES, POSITION_INTERVAL_MS, SEEK_GRACE_MS, SOURCE_SWITCH_COOLDOWN_MS, STALLS_TO_SWITCH, STALL_MIN_MS, STALL_REPEAT_MS, StreamController } from './controller';
import { audioTrackIndex, BUFFER_AHEAD_S, CACHED_BUFFER_AHEAD_S, classifyRefusal, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT } from './engine';
import { SessionError, mutedFromLocation, parseSession, sessionIdFromLocation } from './session';
import { fakeEngines, fakeVideo, jsonResponse, routeFetch, sessionTrack, streamSessionJson, type FetchCall } from '../testing/streamFakes';

const S1 = '/api/stream/sessions/S1';
const controllers: StreamController[] = [];

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.useRealTimers();
});

function setup(routes: Record<string, (call: FetchCall) => Response>, opts: { muted?: boolean } = {}) {
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
  });
  controllers.push(controller);
  const posts = (url = `${S1}/position`) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);
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
    });
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
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'session_over', refreshes: 0, errors: ['session_over'] });
    expect(t.calls.filter((c) => c.url === `${S1}/refresh`)).toHaveLength(0);
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
      await vi.waitFor(() => expect([...modes.values()].map((m) => m.mode)).toEqual(['showing']));
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
    await vi.waitFor(() => expect(lines(t)).toHaveLength(1));
    expect(lines(t)[0]).toMatchObject({ text: 'error: networkError fragLoadError', stage: 'error' });
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
    await vi.waitFor(() => expect(t.posts(`${S1}/events`)).toHaveLength(1));
    expect(t.controller.getState()).toMatchObject({ stage: 'error', errors: ['networkError fragLoadError'] });
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
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'] });
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
    t.made[0].req.handlers.onFatal('networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('error');
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

  it('never leaves a cache, and a muted check never moves', async () => {
    const cached = await playing({ [SOURCE]: () => moved() }, { cached: { id: 'c1', state: 'ready', height: 480 } });
    for (let i = 0; i < STALLS_TO_SWITCH; i++) await cached.stall();
    expect(cached.asks()).toHaveLength(0);
    vi.useRealTimers();
    const muted = await playing({ [SOURCE]: () => moved() }, {}, { muted: true });
    for (let i = 0; i < STALLS_TO_SWITCH; i++) await muted.stall();
    expect(muted.asks()).toHaveLength(0);
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

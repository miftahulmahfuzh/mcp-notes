// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REFRESHES, POSITION_INTERVAL_MS, StreamController } from './controller';
import { classifyRefusal } from './engine';
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
    });
    expect(parseSession({ session_id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toMatchObject({ title: 'Stream', subtitles: [], resumeS: 0 });
    expect(() => parseSession({ id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toThrow('bad_session');
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

  it('reads the id from /stream/<id>', () => {
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m/' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/' })).toBeNull();
    expect(sessionIdFromLocation({ pathname: '/stream/a/b' })).toBeNull();
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
  it('posts every 5 s while playing, on pause and at the end; a 404 changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 12.34, duration: 600, paused: false });

    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts()).toEqual([{ position_s: 12.3, duration_s: 600, ended: false }]);

    t.media.paused = true;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts()).toHaveLength(1);

    t.media.currentTime = 15;
    t.fire('pause');
    Object.assign(t.media, { currentTime: 600, ended: true });
    t.fire('ended');
    await vi.waitFor(() => expect(t.posts()).toHaveLength(3));
    expect(t.posts().slice(1)).toEqual([
      { position_s: 15, duration_s: 600, ended: false },
      { position_s: 600, duration_s: 600, ended: true },
    ]);
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', reportedS: 600, error: null });
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
    await vi.waitFor(() => expect(t.posts(`${S2}/position`)).toEqual([{ position_s: 30, duration_s: null, ended: false }]));
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

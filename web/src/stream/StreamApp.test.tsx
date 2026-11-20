// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StreamApp, delayText, cachedLabel, episodeLabel, formatClock, formatSpeed, loadedGradient, reportLabel, reportText, sourceLine, switchErrorText, RECONNECTING_NOTICE, SYNCED_NOTICE, SYNCED_NOTICE_MS, torrentLabel } from './StreamApp';
import { fakeEngines, jsonResponse, routeFetch, streamSessionJson } from '../testing/streamFakes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(ui: ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => {});
}

function click(el: Element | null) {
  if (el === null) throw new Error('nothing to click');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const button = (el: Element, label: string) => el.querySelector(`button[aria-label="${label}"]`);
const radios = (el: Element) =>
  [...el.querySelectorAll('[role="menuitemradio"]')].map((r) => [r.textContent, r.getAttribute('aria-checked')]);
const radio = (el: Element, text: string) =>
  [...el.querySelectorAll('[role="menuitemradio"]')].find((r) => r.textContent === text) ?? null;

beforeEach(() => {
  // The page remembers its play in this tab's storage; every test starts in a fresh tab.
  window.sessionStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  delete window.notesdStream;
});

describe('StreamApp', () => {
  it('shows the title, a quality menu highest first and English checked; a choice reaches the engine', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    expect(made).toHaveLength(1);
    act(() =>
      made[0].req.handlers.onReady({
        qualities: [
          { index: 0, height: 720, bitrate: null },
          { index: 1, height: 1080, bitrate: null },
        ],
        subtitles: [{ index: 0, label: 'English', lang: 'en' }],
      }),
    );
    await settle();

    expect(document.title).toBe('Fight Club (1999)');
    expect(el.querySelector('.st-title')?.textContent).toBe('Fight Club (1999)');
    expect(window.notesdStream?.stage).toBe('ready');
    expect(el.querySelectorAll('.st-bar button[aria-label]').length).toBeGreaterThanOrEqual(7);
    for (const b of el.querySelectorAll('.st-bar > button, .st-bar > .st-pop > button')) {
      expect(b.textContent).toBe('');
      expect(b.querySelector('svg')).not.toBeNull();
    }

    click(button(el, 'Quality'));
    expect(radios(el)).toEqual([
      ['Auto', 'true'],
      ['1080p', 'false'],
      ['720p', 'false'],
    ]);
    click(radio(el, '720p'));
    expect(made[0].setQuality).toHaveBeenLastCalledWith(0);
    expect(el.querySelector('[role="menu"]')).toBeNull();

    click(button(el, 'Subtitles'));
    expect(radios(el)).toEqual([
      ['Off', 'false'],
      ['English', 'true'],
    ]);
    click(radio(el, 'Off'));
    expect(made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);
    expect(window.notesdStream?.subtitle).toBeNull();
  });

  it('publishes what phase 6 reads and start() on window.notesdStream, with a title that is not the address', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [{ index: 0, height: 720, bitrate: null }, { index: 1, height: 1080, bitrate: null }], subtitles: [] }));
    await settle();
    expect(window.notesdStream).toMatchObject({ kind: 'hls', levels: [1080, 720], level: -1, errors: [], refreshes: 0, muted: false });
    expect(typeof window.notesdStream?.start).toBe('function');
    expect(document.title).not.toBe('');
    expect(document.title).not.toBe(location.href);
    expect(document.title).not.toBe(location.host);
  });

  it("start() takes the page's own full screen before it plays, so a double click leaves it again", async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const order: string[] = [];
    document.documentElement.requestFullscreen = vi.fn(async () => {
      order.push('fullscreen');
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    const video = el.querySelector('video')!;
    video.play = vi.fn(async () => {
      order.push('play');
    });
    await act(async () => {
      await window.notesdStream?.start();
    });
    expect(order[0]).toBe('fullscreen');
    expect(order).toContain('play');
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('under ?muted=1 the mute and full-screen controls do nothing and start() resolves false', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const fullscreen = vi.fn(async () => {});
    document.documentElement.requestFullscreen = fullscreen;
    const el = render(<StreamApp sessionId="S1" muted deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    const video = el.querySelector('video')!;
    expect(video.muted).toBe(true);
    click(button(el, 'Unmute') ?? button(el, 'Mute'));
    click(button(el, 'Full screen'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });
    expect(video.muted).toBe(true);
    expect(fullscreen).not.toHaveBeenCalled();
    expect(await window.notesdStream?.start()).toBe(false);
  });

  it('says why when the session is unknown', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('This stream has ended');
    expect(made).toHaveLength(0);
  });

  it('shows a reconnecting spinner on the film while the player retries, and the error once it gives up (R1.7)', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    act(() => made[0].req.handlers.onRecovering(1, 'networkError fragLoadError'));
    expect(el.querySelector('.st-stage')?.getAttribute('data-stage')).toBe('recovering');
    expect(el.querySelector('[role="status"][aria-label="Reconnecting after a network error"] svg')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('video')).not.toBeNull();
    expect(window.notesdStream?.stage).toBe('recovering');
    // Another provider is asked for first; here none answers, and the error shows.
    act(() => made[0].req.handlers.onFatal('networkError fragLoadError'));
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Playback stopped (networkError fragLoadError).');
  });

  it('a reload after a daemon restart says it is reconnecting, then plays the fresh session and names it in the address', async () => {
    const { made, createEngine } = fakeEngines();
    window.sessionStorage.setItem('notesd-stream-play:S1', JSON.stringify({ ref: { kind: 'movie', tmdb_id: 550 }, provider: 'VidFast', infoHash: null, positionS: 600 }));
    let answer: (r: Response) => void = () => {};
    const { fetchImpl } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403),
      'POST /api/stream/continue': () => jsonResponse({ ...streamSessionJson({ session_id: 'S2', resume_s: 600 }), continued: true }),
    });
    const held: typeof fetch = (input, init) =>
      String(input) === '/api/stream/continue' ? new Promise<Response>((resolve) => (answer = (r) => resolve(r))).then(async () => fetchImpl(input, init)) : fetchImpl(input, init);
    const replace = vi.spyOn(window.history, 'replaceState');
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: held, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    expect(el.querySelector('.st-notice')?.textContent).toBe(RECONNECTING_NOTICE);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    answer(new Response());
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0].req.startAt).toBe(600);
    expect(replace).toHaveBeenCalledWith(null, '', '/stream/S2');
    expect(el.querySelector('.st-notice')).toBeNull();
  });

  it('says so when the address has no session', () => {
    const el = render(<StreamApp sessionId={null} />);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('no stream in this address');
  });

  it('shows an icon-only report button beside the error and says when the report was saved but not opened', async () => {
    const { createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403),
      'POST /api/stream/sessions/S1/report': () => jsonResponse({ error: 'no_tmux', dir: '/data/movies/stream-reports/r1', complete: false }, 409),
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    const alert = el.querySelector('[role="alert"]')!;
    const report = alert.querySelector('button[aria-label="Report this stream bug"]');
    expect(report).not.toBeNull();
    expect(report!.textContent).toBe('');
    expect(report!.querySelector('svg')).not.toBeNull();
    click(report);
    await settle();
    const status = alert.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('Report saved but not opened');
    expect(status).toContain('/data/movies/stream-reports/r1');
    expect(button(alert, 'Open the report again')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/stream/sessions/S1/report')).toHaveLength(1);
  });

  it('after the window opened the button is spent', async () => {
    const { createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403),
      'POST /api/stream/sessions/S1/report': () => jsonResponse({ ok: true, dir: '/d/r1', window: 'note:3', complete: false }),
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    click(button(el, 'Report this stream bug'));
    await settle();
    const spent = button(el, 'Report opened in tmux') as HTMLButtonElement | null;
    expect(spent?.disabled).toBe(true);
    expect(el.querySelector('[role="alert"] [role="status"]')?.textContent).toContain('note:3');
    click(spent);
    await settle();
    expect(calls.filter((c) => c.url === '/api/stream/sessions/S1/report')).toHaveLength(1);
  });

  it('shows no report button while the film plays, nor when the address has no session', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    expect(button(el, 'Report this stream bug')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const none = render(<StreamApp sessionId={null} />);
    expect(button(none, 'Report this stream bug')).toBeNull();
  });

  it('marks a play from the cache beside the title, and nothing for a stream through the pass-through', async () => {
    const cached = { id: 'c1', state: 'ready', height: 720 };
    const ready = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ cached })) }).fetchImpl, createEngine: fakeEngines().createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    const mark = ready.querySelector('.st-top .st-cached');
    expect(mark?.getAttribute('aria-label')).toBe("Playing from this machine's cache (720p)");
    expect(mark?.getAttribute('title')).toBe("Playing from this machine's cache (720p)");
    expect(window.notesdStream?.cached).toEqual(cached);
    act(() => root?.unmount());
    host?.remove();
    const plain = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) }).fetchImpl, createEngine: fakeEngines().createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    expect(plain.querySelector('.st-cached')).toBeNull();
  });

  it('names a downloading cache in words', () => {
    expect(cachedLabel({ id: 'c1', state: 'downloading', height: 1080 })).toBe("Playing from this machine's cache while it downloads (1080p)");
    expect(cachedLabel({ id: 'c1', state: 'ready', height: null })).toBe("Playing from this machine's cache");
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [9.9, '0:09'],
    [75, '1:15'],
    [3725, '1:02:05'],
    [Number.NaN, '0:00'],
  ])('%s -> %s', (s, text) => {
    expect(formatClock(s)).toBe(text);
  });

  describe('the previous and next episode buttons', () => {
    const EPISODE = { kind: 'tv', season: 17, episode: 730, title: 'One Piece S17E730', prev_episode: { season: 17, episode: 729 }, next_episode: { season: 17, episode: 731 } };
    const button = (el: HTMLElement, label: RegExp) => [...el.querySelectorAll('button')].find((b) => label.test(b.getAttribute('aria-label') ?? ''));

    it('a film has neither; a series has both, named by the episode they go to, and one without a neighbour is disabled', async () => {
      const film = fakeEngines();
      const filmEl = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) }).fetchImpl, createEngine: film.createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
      await settle();
      expect(button(filmEl, /episode/i)).toBeUndefined();

      const first = fakeEngines();
      const el = render(<StreamApp sessionId="S1" deps={{ fetch: routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ ...EPISODE, prev_episode: null })) }).fetchImpl, createEngine: first.createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
      await settle();
      expect(button(el, /^No previous episode$/)?.disabled).toBe(true);
      expect(button(el, /^Next episode \(S17E731\)$/)?.disabled).toBe(false);
    });

    it('a click, or Shift+N, asks the daemon for the next episode and says why when it cannot be streamed', async () => {
      const { made, createEngine } = fakeEngines();
      const { fetchImpl, calls } = routeFetch({
        'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson(EPISODE)),
        'POST /api/stream/sessions/S1/episode': () => jsonResponse({ error: 'no_source', attempts: [] }, 502),
      });
      const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
      await settle();
      act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
      await settle();
      await act(async () => {
        button(el, /^Next episode/)?.click();
      });
      await settle();
      expect(calls.filter((c) => c.url.endsWith('/episode')).map((c) => c.body)).toEqual([{ to: 'next' }]);
      expect(el.querySelector('.st-notice')?.textContent).toBe('No provider could stream the next episode.');
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', shiftKey: true }));
      });
      await settle();
      expect(calls.filter((c) => c.url.endsWith('/episode')).map((c) => c.body)).toEqual([{ to: 'next' }, { to: 'prev' }]);
      expect(el.querySelector('.st-notice')?.textContent).toBe('No provider could stream the previous episode.');
      // A plain n or p is not the shortcut.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
      });
      expect(calls.filter((c) => c.url.endsWith('/episode'))).toHaveLength(2);
    });

    it('names an episode and a failure in words', () => {
      expect(episodeLabel({ season: 1, episode: 2 })).toBe('S01E02');
      expect(episodeLabel({ season: 17, episode: 731 })).toBe('S17E731');
      expect(switchErrorText('next', 'no_episode')).toBe('There is no next episode.');
      expect(switchErrorText('previous', 'resolve_failed')).toBe('The previous episode could not be started (resolve_failed).');
    });
  });
});

describe('reportLabel and reportText', () => {
  it('name every state of the report button', () => {
    expect(reportLabel({ status: 'idle' })).toBe('Report this stream bug');
    expect(reportText({ status: 'idle' })).toBeNull();
    expect(reportText({ status: 'already', dir: '/d/r0' })).toBe('Already reported: /d/r0');
    expect(reportText({ status: 'saved', dir: '/d/r1', reason: 'spawn_failed' })).toBe('Report saved but not opened, Claude Code could not be started: /d/r1');
    expect(reportText({ status: 'failed', code: 'snapshot_failed' })).toBe('The report could not be made (snapshot_failed).');
  });
});

describe("the timeline's loaded bar", () => {
  it('draws every loaded stretch as a share of the film, joining the ones that meet or overlap', () => {
    expect(loadedGradient([[100, 200], [0, 50], [199.8, 400], [800, 800]], 1000)).toBe(
      'linear-gradient(to right, transparent 0%, var(--st-loaded) 0%, var(--st-loaded) 5%, transparent 5%, transparent 10%, var(--st-loaded) 10%, var(--st-loaded) 40%, transparent 40%)',
    );
    // What runs past the end is cut there.
    expect(loadedGradient([[900, 1200]], 1000)).toContain('var(--st-loaded) 100%, transparent 100%');
  });

  it('draws nothing without a duration or a stretch', () => {
    expect(loadedGradient([[0, 10]], 0)).toBe('none');
    expect(loadedGradient([], 1000)).toBe('none');
  });
});

describe('the subtitle delay line', () => {
  it('says how far and which way', () => {
    expect(delayText(250)).toBe('Subtitle delay +250 ms');
    expect(delayText(-50)).toBe('Subtitle delay −50 ms');
    expect(delayText(0)).toBe('Subtitle delay 0 ms');
  });
});

describe('the line after Wyzie Synced re-timed the subtitle', () => {
  it('says "Subtitles synced" once, for a moment', async () => {
    const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
    let rev = 0;
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson({ subtitle_rev: rev, subtitles: rev === 0 ? [] : [{ url: '/s.vtt', lang: 'en', label: 'English (Wyzie, synced)', format: 'vtt', source: 'request', english: true }], torrent: { info_hash: HASH, name: 'Film', index: null, state: 'ready', seeds: null }, manifest_kind: 'mp4' })),
      'GET /s.vtt': () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nIn step.\n', { status: 200 }),
      'POST /api/stream/sessions/S1/position': () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: rev }),
    });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    const notices = () => [...el.querySelectorAll('.st-notice')].map((n) => n.textContent);
    const video = el.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 30 });
    const report = async () => {
      act(() => void video.dispatchEvent(new Event('pause')));
      await settle();
    };
    await report();
    expect(notices()).toEqual([]);
    rev = 1;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await report();
      expect(notices()).toEqual([SYNCED_NOTICE]);
      expect(SYNCED_NOTICE).toBe('Subtitles synced');
      await act(async () => void vi.advanceTimersByTime(SYNCED_NOTICE_MS + 10));
      expect(notices()).toEqual([]);
      // Later reports carry the same number: the line does not come back.
      await report();
      expect(notices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the player on a torrent (torrent-stream-source phase 4)', () => {
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const torrent = { info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52 };
  const deps = (status: Record<string, unknown>) => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({
      'GET /api/stream/sessions/S1': () =>
        jsonResponse(streamSessionJson({ provider: 'Torrent', manifest_kind: 'mp4', manifest_url: `/api/stream/torrent/${HASH}/f/0`, torrent })),
      [`GET /api/stream/torrent/${HASH}`]: () => jsonResponse(status),
      [`GET /api/stream/torrent/${HASH}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] }),
    });
    return { made, deps: { fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} } };
  };

  it('marks a torrent beside the title with its peers and speed, and draws what is on disk on the timeline', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(888);
    const { made, deps: d } = deps({ state: 'downloading', peers: 12, down_kbps: 27200, progress: 0.37 });
    const el = render(<StreamApp sessionId="S1" deps={d} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    act(() => {
      el.querySelector('video')!.dispatchEvent(new Event('durationchange'));
    });
    await settle();
    const mark = el.querySelector('.st-top .st-torrent');
    expect(mark?.getAttribute('aria-label')).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264): 12 peers, 3.4 MB/s, 37% on disk');
    expect(mark?.getAttribute('title')).toBe(mark?.getAttribute('aria-label'));
    expect([...el.querySelectorAll('.st-torrent-stat')].map((s) => s.textContent)).toEqual(['12', '3.4 MB/s']);
    expect(mark?.querySelectorAll('svg')).toHaveLength(3);
    expect(window.notesdStream?.torrent).toMatchObject({ infoHash: HASH, peers: 12, downKbps: 27200, state: 'downloading' });
    expect((el.querySelector('.st-seek') as HTMLInputElement).style.getPropertyValue('--st-loaded-bar')).toBe(
      'linear-gradient(to right, transparent 0%, var(--st-loaded) 0%, var(--st-loaded) 6.76%, transparent 6.76%)',
    );
    expect(button(el, 'Another torrent (S)')).not.toBeNull();
    expect(button(el, 'Another source (S)')).toBeNull();
    expect(el.querySelector('.st-cached')).toBeNull();
  });

  it('says it waits for a part a seek reached before it is on disk', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(888);
    let at = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(() => at);
    const { made, deps: d } = deps({ state: 'downloading', peers: 2, down_kbps: 800, progress: 0.07 });
    const el = render(<StreamApp sessionId="S1" deps={d} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    const video = el.querySelector('video')!;
    at = 400;
    act(() => {
      video.dispatchEvent(new Event('seeking'));
    });
    expect(el.querySelector('[role="status"][aria-label="Fetching this part from peers"]')?.textContent).toBe('Fetching this part from peers');
    act(() => {
      video.dispatchEvent(new Event('seeked'));
    });
    expect(el.querySelector('[aria-label="Fetching this part from peers"]')).toBeNull();
  });

  it('words the speed, the mark and the line about another source', () => {
    expect(formatSpeed(27200)).toBe('3.4 MB/s');
    expect(formatSpeed(800)).toBe('100 kB/s');
    expect(formatSpeed(0)).toBe('0 kB/s');
    const view = { infoHash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', seeds: 52, state: 'downloading' as const, peers: 1, downKbps: 800, progress: null, fetching: false };
    expect(torrentLabel(view)).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264): 1 peer, 100 kB/s');
    expect(torrentLabel({ ...view, peers: null, downKbps: null })).toBe('Playing from a torrent (Sintel.2010.1080p.WEB.x264), finding peers');
    expect(torrentLabel({ ...view, state: 'ready' })).toBe("Playing a torrent download from this machine's disk (Sintel.2010.1080p.WEB.x264)");
    expect(torrentLabel({ ...view, state: 'failed' })).toBe('The torrent download stopped (Sintel.2010.1080p.WEB.x264)');
    expect(sourceLine(true, null, true)).toBe('Looking for another torrent…');
    expect(sourceLine(false, 'No other source', true)).toBe('No other torrent');
    expect(sourceLine(false, 'Sintel.2010.720p.BluRay.x264', true)).toBe('Torrent: Sintel.2010.720p.BluRay.x264');
    expect(sourceLine(true, null, false)).toBe('Looking for another source…');
    expect(sourceLine(false, 'No other source', false)).toBe('No other source');
    expect(sourceLine(false, 'VidFast', false)).toBe('Source: VidFast');
    // A move the daemon made by itself says why.
    expect(sourceLine(false, 'VidFast', false, 'dubbed audio')).toBe('Switched to another source: dubbed audio');
    expect(sourceLine(true, 'VidFast', true, 'the torrent kept stalling')).toBe('Looking for another torrent…');
    expect(sourceLine(false, null, false)).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StreamApp, delayText, cachedLabel, episodeLabel, formatClock, loadedGradient, reportLabel, reportText, switchErrorText } from './StreamApp';
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
    act(() => made[0].req.handlers.onFatal('networkError fragLoadError'));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Playback stopped (networkError fragLoadError).');
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

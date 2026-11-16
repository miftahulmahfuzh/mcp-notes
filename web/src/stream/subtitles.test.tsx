// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUE_FEED_POLL_MS, followCueFeed, isEnglish, parseCueFeed, pickDefaultSubtitle, toWebVtt, type FeedCue, type SubtitleOption } from './subtitles';

const opt = (source: 'manifest' | 'file', index: number, label: string, lang: string | null): SubtitleOption => ({
  id: `${source}-${index}`,
  source,
  index,
  label,
  lang,
  english: isEnglish(lang, label),
});

describe('toWebVtt', () => {
  it('turns SRT into WebVTT: header, dot milliseconds, two-digit hours, LF line ends', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n0:01:00,5 --> 0:01:02,000\r\nBye, then\r\n';
    expect(toWebVtt(srt)).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n\n2\n00:01:00.500 --> 00:01:02.000\nBye, then\n',
    );
  });

  it('returns WebVTT as it came', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n';
    expect(toWebVtt(vtt)).toBe(vtt);
  });
});

describe('isEnglish', () => {
  it.each([
    ['en', null, true],
    ['eng', null, true],
    ['en-US', null, true],
    [null, 'English (CC)', true],
    ['fr', 'Français', false],
    [null, 'Bengali', false],
    [null, null, false],
  ])('lang %s, label %s -> %s', (lang, label, expected) => {
    expect(isEnglish(lang, label)).toBe(expected);
  });
});

describe('pickDefaultSubtitle', () => {
  it('prefers an English track inside the manifest over an English file', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Français', 'fr'), opt('file', 0, 'English', 'en'), opt('manifest', 1, 'English', 'en')])).toBe('manifest-1');
  });

  it('falls back to an English file', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Français', 'fr'), opt('file', 0, 'English', 'en')])).toBe('file-0');
  });

  it('shows nothing when no track is English', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Español', 'es')])).toBeNull();
    expect(pickDefaultSubtitle([])).toBeNull();
  });

  it("shows a source's only subtitle when it names no language", () => {
    // What parseSession makes of a file with no label and no language.
    expect(pickDefaultSubtitle([opt('file', 0, 'Subtitle', null)])).toBe('file-0');
    expect(pickDefaultSubtitle([opt('manifest', 0, '', 'und')])).toBe('manifest-0');
    expect(pickDefaultSubtitle([opt('file', 0, 'Track 1', null)])).toBe('file-0');
    // A name is a language it is not ours to guess; two unnamed ones are no single choice.
    expect(pickDefaultSubtitle([opt('file', 0, 'Español', null)])).toBeNull();
    expect(pickDefaultSubtitle([opt('file', 0, 'Subtitle', 'es')])).toBeNull();
    expect(pickDefaultSubtitle([opt('file', 0, 'Subtitle', null), opt('file', 1, 'Subtitle', null)])).toBeNull();
    // English still wins over an unnamed one.
    expect(pickDefaultSubtitle([opt('file', 0, 'English', 'en')])).toBe('file-0');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseCueFeed', () => {
  it('reads a feed answer and leaves out cues without text or length', () => {
    expect(parseCueFeed({ cues: [{ start_s: 1, end_s: 3, text: 'Hi' }, { start_s: 4, end_s: 4, text: 'zero' }, { start_s: 5, end_s: 6, text: ' ' }, 'x'], next: 4, complete: false })).toEqual({
      cues: [{ start_s: 1, end_s: 3, text: 'Hi' }],
      next: 4,
      complete: false,
    });
  });

  it('refuses what is not a feed answer', () => {
    expect(parseCueFeed(null)).toBeNull();
    expect(parseCueFeed({ cues: [], next: -1, complete: false })).toBeNull();
    expect(parseCueFeed({ cues: [], next: 1.5, complete: false })).toBeNull();
    expect(parseCueFeed({ cues: {}, next: 0, complete: true })).toBeNull();
    expect(parseCueFeed({ cues: [], next: 0 })).toBeNull();
  });
});

describe('followCueFeed', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('adds the cues that arrive in later reads, from where it stopped, until the feed is complete', async () => {
    vi.useFakeTimers();
    const answers: Record<string, Response | (() => Response)> = {
      '/cues?after=0': json({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }], next: 1, complete: false }),
      '/cues?after=1': json({ cues: [], next: 1, complete: false }),
    };
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const answer = answers[url];
      return typeof answer === 'function' ? answer() : (answer ?? json({ error: 'not_found' }, 404));
    }) as typeof fetch;
    const added: FeedCue[] = [];
    let completeAt: number | null = null;
    followCueFeed('/cues', { fetch: fetchImpl, add: (c) => added.push(c), onComplete: (n) => (completeAt = n) });
    await vi.waitFor(() => expect(added.map((c) => c.text)).toEqual(['Line 1']));
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(asked).toEqual(['/cues?after=0', '/cues?after=1']);
    answers['/cues?after=1'] = json({ cues: [{ start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: true });
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(added.map((c) => c.text)).toEqual(['Line 1', 'Line 2']);
    expect(completeAt).toBe(2);
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 5);
    expect(asked).toHaveLength(3);
  });

  it('tries again after a failed read, says so once, and stops on a 404 or stop()', async () => {
    vi.useFakeTimers();
    let status = 500;
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return json({ error: 'x' }, status);
    }) as typeof fetch;
    const errors: string[] = [];
    followCueFeed('/cues', { fetch: fetchImpl, add: () => {}, onError: (m) => errors.push(m) });
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 2);
    expect(asked).toHaveLength(3);
    expect(errors).toEqual(['http_500']);
    status = 404;
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS);
    expect(errors).toEqual(['http_500', 'http_404']);
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
    expect(asked).toHaveLength(4);
    const stopped: string[] = [];
    const follower = followCueFeed('/other', { fetch: (async (input: RequestInfo | URL) => { stopped.push(String(input)); return json({ cues: [], next: 0, complete: false }); }) as typeof fetch, add: () => {} });
    await vi.waitFor(() => expect(stopped).toHaveLength(1));
    follower.stop();
    await vi.advanceTimersByTimeAsync(CUE_FEED_POLL_MS * 3);
    expect(stopped).toHaveLength(1);
  });
});

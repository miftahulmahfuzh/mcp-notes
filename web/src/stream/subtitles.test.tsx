// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';

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
});

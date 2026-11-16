import { describe, expect, it } from 'vitest';
import { dialogueBody, dialoguePage, parseCues, playlistTarget } from '../../../src/directStream/dialogue.js';

const VTT = `WEBVTT

1
00:00:17.720 --> 00:00:20.020
<i>Fight, crash in, rise up</i>

00:00:17.720 --> 00:00:20.020
<i>Fight, crash in, rise up</i>

00:12:03.500 --> 00:12:06.000 align:start position:10%
The deadly gas was filling the whole
country at the speed of a blast wave!

01:02:03.000 --> 01:02:04.000
Tom &amp; Jerry {\\an8}said &quot;hi&quot;

NOTE a comment

00:00:05.000 --> 00:00:06.000

`;

describe('parseCues', () => {
  it('reads cues in time order, joins a cue\'s lines, strips tags and entities, and drops a cue that repeats the one before', () => {
    expect(parseCues(VTT)).toEqual([
      { startS: 17.72, text: 'Fight, crash in, rise up' },
      { startS: 723.5, text: 'The deadly gas was filling the whole country at the speed of a blast wave!' },
      { startS: 3723, text: 'Tom & Jerry said "hi"' },
    ]);
  });

  it('reads SubRip timings and minutes without hours, and nothing from a placeholder', () => {
    expect(parseCues('1\r\n00:00:01,000 --> 00:00:03,000\r\nHello.\r\n\r\n2\r\n01:05.250 --> 01:07.000\r\nBye.\r\n')).toEqual([
      { startS: 1, text: 'Hello.' },
      { startS: 65.25, text: 'Bye.' },
    ]);
    expect(parseCues('WEBVTT')).toEqual([]);
    expect(parseCues('')).toEqual([]);
  });
});

describe('dialogueBody and dialoguePage', () => {
  const body = dialogueBody([
    { startS: 17.72, text: 'Fight' },
    { startS: 59, text: 'Still minute zero' },
    { startS: 723.5, text: 'The gas' },
    { startS: 3723, text: 'Past the hour' },
  ]);

  it('stores one line per cue with its minute, running on past the hour', () => {
    expect(body).toBe('00:17\tFight\n00:59\tStill minute zero\n12:03\tThe gas\n62:03\tPast the hour');
  });

  it('gives every line from a minute on, and says there is no more', () => {
    expect(dialoguePage(body, 0)).toEqual({ from_minute: 0, next_from_minute: null, lines: 4, text: '[00:17] Fight\n[00:59] Still minute zero\n[12:03] The gas\n[62:03] Past the hour' });
    expect(dialoguePage(body, 12).text).toBe('[12:03] The gas\n[62:03] Past the hour');
    expect(dialoguePage(body, 99)).toEqual({ from_minute: 99, next_from_minute: null, lines: 0, text: '' });
  });

  it('ends a page on a whole minute when the text is too long, and names the minute to go on from', () => {
    const first = dialoguePage(body, 0, 20);
    // The second line of minute 0 does not fit, but a minute is never cut in two.
    expect(first).toEqual({ from_minute: 0, next_from_minute: 12, lines: 2, text: '[00:17] Fight\n[00:59] Still minute zero' });
    const second = dialoguePage(body, first.next_from_minute ?? 0, 20);
    expect(second).toMatchObject({ next_from_minute: 62, text: '[12:03] The gas' });
    expect(dialoguePage(body, 62, 20)).toMatchObject({ next_from_minute: null, lines: 1 });
  });
});

describe('playlistTarget', () => {
  it('reads the address a rewritten playlist line points back at, and nothing from a tag', () => {
    expect(playlistTarget('/api/stream/sessions/S1/p?u=https%3A%2F%2Fcdn.example%2Fsubs%2Fseg-0.vtt')).toBe('https://cdn.example/subs/seg-0.vtt');
    expect(playlistTarget('/api/stream/sessions/S1/p?u=https%3A%2F%2Fcdn.example%2Fa.vtt&vtt=1')).toBe('https://cdn.example/a.vtt');
    expect(playlistTarget('https://cdn.example/subs/seg-1.vtt')).toBe('https://cdn.example/subs/seg-1.vtt');
    expect(playlistTarget('#EXTINF:6.0,')).toBeNull();
    expect(playlistTarget('  ')).toBeNull();
    expect(playlistTarget('seg-2.vtt')).toBeNull();
  });
});

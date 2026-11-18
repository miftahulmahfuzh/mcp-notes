import { describe, expect, it } from 'vitest';
import { commonWords, judge, matchLines, parseSubCues, retime, wordsOf, type HeardLine } from '../../../../src/directStream/subtitleCheck/match.js';

/** A film of 120 lines, one every 20 s, each of its own words. */
const WORDS = ['river', 'candle', 'stone', 'window', 'garden', 'letter', 'silver', 'morning', 'winter', 'doctor', 'kitchen', 'brother', 'engine', 'yellow', 'paper', 'north'];
/** Line `i` of film `salt`: another film speaks other words. */
const lineOf = (i: number, salt = 0): string => [0, 1, 2, 3, 4, 5].map((k) => WORDS[(i * (k + 3) + k * 7 + ((i * i) % 11)) % WORDS.length]! + (salt === 0 ? '' : 'q' + salt)).join(' ') + ' ' + (i + salt * 1000);
const stamp = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return p(Math.floor(ms / 3_600_000)) + ':' + p(Math.floor(ms / 60_000) % 60) + ':' + p(Math.floor(ms / 1000) % 60) + '.' + p(ms % 1000, 3);
};
const film = (salt = 0, at: (t: number) => number = (t) => t): string =>
  'WEBVTT\n\n' + Array.from({ length: 120 }, (_, i) => stamp(at(10 + i * 20)) + ' --> ' + stamp(at(10 + i * 20) + 3) + '\n' + lineOf(i, salt) + '\n').join('\n');
/** What Whisper would hear in six windows of the film: every line inside them, at its true time. */
const heard: HeardLine[] = [1, 2, 3, 20, 21, 22, 40, 41, 42, 60, 61, 62, 80, 81, 82, 100, 101, 102, 115, 116].map((i) => ({ startS: 10 + i * 20 + 0.1, endS: 10 + i * 20 + 2.8, text: lineOf(i) }));
const DURATION = 2420;

describe('the words of a line', () => {
  it('drops tags, sound descriptions, song lines and apostrophes', () => {
    expect(wordsOf("<i>- Don't</i> [door slams] go (sighs) there, Maria!")).toEqual(['dont', 'go', 'there', 'maria']);
    expect(wordsOf('# When the moon #')).toEqual([]);
    expect(wordsOf('♪ and love will steer ♪')).toEqual([]);
  });

  it('counts the words two lines share in order', () => {
    expect(commonWords(['a', 'b', 'c', 'd'], ['x', 'a', 'c', 'd', 'y'])).toBe(3);
    expect(commonWords([], ['a'])).toBe(0);
  });
});

describe('parseSubCues', () => {
  it('reads WebVTT and SubRip timings with their ends', () => {
    const cues = parseSubCues('1\n00:00:01,500 --> 00:00:03,000\nHello there\nfriend\n\n2\n01:02:03.250 --> 01:02:05.000 line:90%\nBye\n');
    expect(cues).toEqual([
      { startS: 1.5, endS: 3, text: 'Hello there friend' },
      { startS: 3723.25, endS: 3725, text: 'Bye' },
    ]);
  });
});

describe('judge', () => {
  it('says good of the right subtitle in step', () => {
    const j = judge(film(), heard, DURATION);
    expect(j).toMatchObject({ grade: 'good', text: 'correct', timing: 'in_step', heard_lines: 20, found_lines: 20 });
    expect(Math.abs(j.off_start_s!)).toBeLessThan(0.3);
  });

  it('says bad of another film: its lines are not the ones heard', () => {
    const j = judge(film(1), heard, DURATION);
    expect(j).toMatchObject({ grade: 'bad', text: 'wrong' });
    expect(j.text_share).toBeLessThanOrEqual(0.2);
  });

  it('finds the right text 12 s late fixable, and good once re-timed', () => {
    const late = film(0, (t) => t + 12);
    const j = judge(late, heard, DURATION);
    expect(j).toMatchObject({ grade: 'fixable', text: 'correct', timing: 'off' });
    expect(j.off_start_s).toBeCloseTo(11.9, 0);
    expect(judge(retime(late, j.fit!), heard, DURATION).grade).toBe('good');
  });

  it('finds a drift (another frame rate) and re-times it with a stretch', () => {
    const drifting = film(0, (t) => t * (25 / 23.976));
    const j = judge(drifting, heard, DURATION);
    expect(j).toMatchObject({ grade: 'fixable', timing: 'off' });
    expect(j.fit!.stretch).toBeCloseTo(25 / 23.976, 3);
    expect(j.off_end_s!).toBeGreaterThan(90);
    const fixed = judge(retime(drifting, j.fit!), heard, DURATION);
    expect(fixed.grade).toBe('good');
    expect(Math.abs(fixed.off_end_s!)).toBeLessThan(0.6);
  });

  it('says bad of the right text cut for another edit: no one shift fits', () => {
    // Every scene sits somewhere else: the offsets jump by tens of seconds from one stretch to the next.
    const recut = film(0, (t) => t + [0, 37, -19, 64, 8, -41][Math.floor(t / 420) % 6]!);
    expect(judge(recut, heard, DURATION)).toMatchObject({ grade: 'bad', text: 'correct', timing: 'scattered' });
  });

  it('is unsure with too little heard', () => {
    expect(judge(film(), heard.slice(0, 4), DURATION)).toMatchObject({ grade: 'unsure', text: 'unsure' });
  });

  it('finds a heard line that runs over two cues, and one that is half a cue', () => {
    const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nMrs. Langdon, I am calling\n\n00:00:12.100 --> 00:00:14.000\nbecause I cannot treat your son anymore.\n\n00:00:20.000 --> 00:00:23.000\n- Hey, Troy. You are a dork. - Oh, shut up right now.\n';
    const m = matchLines(
      [
        { startS: 10.2, endS: 13.9, text: 'Mrs. Langdon, I am calling because I cannot treat your son anymore.' },
        { startS: 20.1, endS: 21.5, text: 'Hey Troy, you are a dork.' },
      ],
      parseSubCues(vtt),
    );
    expect(m.found).toBe(2);
    expect(m.anchors.map((a) => a.cueS)).toEqual([10, 20]);
  });

  it('anchors a line said twice to the place the other lines agree on', () => {
    const twice = film().replace(lineOf(110), lineOf(41));
    const j = judge(twice, heard, DURATION);
    expect(j).toMatchObject({ grade: 'good', timing: 'in_step' });
    expect(j.agree).toBe(1);
  });
});

describe('retime', () => {
  it('moves every cue, keeps its text, and drops one that would start before the film', () => {
    const out = parseSubCues(retime('WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nearly\n\n00:01:00.000 --> 00:01:02.000\n<i>kept</i>\n', { shiftS: 10, stretch: 1 }));
    expect(out).toEqual([{ startS: 49.85, endS: 51.85, text: '<i>kept</i>' }]);
  });
});

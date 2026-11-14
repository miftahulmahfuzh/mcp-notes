import { describe, expect, it } from 'vitest';
import { compactTitle, isVideoFile, normalizeTitle, parseVideoPath } from '../../../src/movies/parse.js';
import { FILENAME_CASES } from '../../fixtures/movies/filenames.js';

describe('parseVideoPath on the names found on disk', () => {
  it.each(FILENAME_CASES.map((c) => [c.shape, c.relPath, c] as const))('%s: %s', (_shape, relPath, c) => {
    const { fileName: _fileName, dirName: _dirName, ...parsed } = parseVideoPath(relPath);
    expect(parsed).toEqual(c.expected);
  });

  it('covers all six shapes of the request', () => {
    const shapes = new Set(FILENAME_CASES.map((c) => c.shape));
    for (const shape of ['pahe-dots', 'pahe-underscores', 'year-in-folder', 'season-folder', 'absolute', 'two-films']) {
      expect(shapes.has(shape as never)).toBe(true);
    }
  });

  it('keeps the raw file and folder names for the fallback', () => {
    const p = parseVideoPath('Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(p.fileName).toBe('Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(p.dirName).toBe('Nezha (2019)');
    expect(parseVideoPath('Oldboy.mkv').dirName).toBeNull();
  });

  it('never takes a done folder or a collection folder into the title', () => {
    expect(parseVideoPath('Done/Your.Eyes.Tell.2020.1080p.mkv').title).toBe('Your Eyes Tell');
    expect(parseVideoPath('Pak Bernard/Oldboy (2003)/Oldboy.mkv').title).toBe('Oldboy');
  });

  it('accepts Windows separators', () => {
    expect(parseVideoPath('Pak Bernard\\Oldboy (2003)\\Oldboy.mkv')).toMatchObject({ title: 'Oldboy', year: 2003 });
  });

  it.each(['', '/', '.mkv', 'a/b/', '[]', '....mkv', '-.mkv', 'S01.mkv', '2019.mkv', '((((('])('never throws on %j', (odd) => {
    expect(() => parseVideoPath(odd)).not.toThrow();
  });
});

describe('isVideoFile', () => {
  it('accepts the five video extensions in any case', () => {
    for (const name of ['a.mkv', 'a.MP4', 'a.avi', 'a.m4v', 'a.webm']) expect(isVideoFile(name)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const name of ['a.srt', 'a.nfo', 'a.jpg', 'mkv', '.mkv', 'a.mkv.part', 'a.']) expect(isVideoFile(name)).toBe(false);
  });
});

describe('normalizeTitle / compactTitle', () => {
  it('folds punctuation, case and accents', () => {
    expect(normalizeTitle('WALL·E')).toBe('wall e');
    expect(normalizeTitle('WALL-E')).toBe('wall e');
    expect(normalizeTitle('Batman: The Killing Joke')).toBe(normalizeTitle('Batman - The Killing Joke'));
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
  });
  it('compactTitle ignores spaces', () => {
    expect(compactTitle('Nezha')).toBe(compactTitle('Ne Zha'));
  });
});

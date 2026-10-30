import { describe, expect, it } from 'vitest';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody, tagsOf } from './text';

describe('fontSizeFor', () => {
  it('sizes text by length: <36 → 26, <80 → 17, else 13.5', () => {
    expect(fontSizeFor('a'.repeat(35), false)).toBe(26);
    expect(fontSizeFor('a'.repeat(36), false)).toBe(17);
    expect(fontSizeFor('a'.repeat(79), false)).toBe(17);
    expect(fontSizeFor('a'.repeat(80), false)).toBe(13.5);
  });
  it('uses 13 for image cards regardless of length', () => {
    expect(fontSizeFor('', true)).toBe(13);
    expect(fontSizeFor('a'.repeat(200), true)).toBe(13);
  });
  it('tightens letter-spacing above 20px', () => {
    expect(letterSpacingFor(26)).toBe('-0.03em');
    expect(letterSpacingFor(17)).toBe('-0.005em');
  });
  it('gives the editor at least 3 rows', () => {
    expect(rowsFor(0)).toBe(3);
    expect(rowsFor(28 * 5)).toBe(5);
  });
});

describe('tagsOf', () => {
  it('parses, lower-cases and dedupes tags, ignoring # inside words', () => {
    expect(tagsOf('#Seer and #seer, C# a#b #from_phone #v250 #ai-image')).toEqual(['seer', 'from_phone', 'v250', 'ai-image']);
  });
});

describe('segmentBody', () => {
  it('splits text and tag chips in order', () => {
    expect(segmentBody('#seer onboarding is long #UX!')).toEqual([
      { kind: 'tag', text: '#seer', tag: 'seer' },
      { kind: 'text', text: ' onboarding is long ' },
      { kind: 'tag', text: '#UX', tag: 'ux' },
      { kind: 'text', text: '!' },
    ]);
  });
  it('keeps a # inside a word as plain text', () => {
    expect(segmentBody('C# rocks #dev')).toEqual([
      { kind: 'text', text: 'C# rocks ' },
      { kind: 'tag', text: '#dev', tag: 'dev' },
    ]);
  });
  it('returns nothing for an empty body', () => {
    expect(segmentBody('')).toEqual([]);
  });
});

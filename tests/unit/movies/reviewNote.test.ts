import { describe, expect, it } from 'vitest';
import { parseTags } from '../../../src/notes/tags.js';
import { reviewBody, reviewHeader, reviewText } from '../../../src/movies/reviewNote.js';

describe('review note body', () => {
  const header = reviewHeader('How to Make a Killing', 2026);

  it('names the title and year in the header', () => {
    expect(header).toBe('Review of How to Make a Killing (2026)');
    expect(reviewHeader('MobLand', null)).toBe('Review of MobLand');
  });

  it('round-trips the text and carries #movie', () => {
    const body = reviewBody(header, '  Great twist.\n\nSecond paragraph.  ');
    expect(body).toBe('Review of How to Make a Killing (2026)\n\nGreat twist.\n\nSecond paragraph.\n\n#movie');
    expect(parseTags(body)).toEqual(['movie']);
    expect(reviewText(body)).toBe('Great twist.\n\nSecond paragraph.');
  });

  it('an emptied review keeps a non-empty, tagged body with no text', () => {
    const body = reviewBody(header, '   ');
    expect(body).toBe('Review of How to Make a Killing (2026)\n\n#movie');
    expect(parseTags(body)).toEqual(['movie']);
    expect(reviewText(body)).toBe('');
  });

  it('shows a note edited elsewhere as it is, keeping inline hashtags', () => {
    expect(reviewText('Rewatched it, still #great\n\n#movie #rewatch')).toBe('Rewatched it, still #great');
    expect(reviewText('no header, no tag line')).toBe('no header, no tag line');
  });
});

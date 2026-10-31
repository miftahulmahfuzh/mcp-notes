import { describe, expect, it } from 'vitest';
import {
  IMAGE_SEARCH_OFF,
  PASTED_IMAGE_NEEDS_HOOK,
  SIMILAR_SNIPPET_CHARS,
  bodySnippet,
  countSources,
} from '../../src/mcp/similarTools.js';

describe('similar_images helpers', () => {
  it('countSources counts the four mutually exclusive inputs, not limit', () => {
    expect(countSources({})).toBe(0);
    expect(countSources({ image_id: 'A-B32', limit: 5 })).toBe(1);
    expect(countSources({ image_id: 'A-B32', query: 'red' })).toBe(2);
    expect(countSources({ upload_id: 'K-7F2', pasted_image: 1, query: 'x', image_id: 'y' })).toBe(4);
  });

  it('bodySnippet collapses whitespace and cuts at 200 characters with an ellipsis', () => {
    expect(bodySnippet('  red top\n\nin a car  #pics ')).toBe('red top in a car #pics');
    const long = 'x'.repeat(250);
    const cut = bodySnippet(long);
    expect(cut).toHaveLength(SIMILAR_SNIPPET_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    const emoji = `${'a'.repeat(198)}😀tail`;
    expect(bodySnippet(emoji)).toBe(`${'a'.repeat(198)}…`);
  });

  it('the fixed answers name the fix', () => {
    expect(PASTED_IMAGE_NEEDS_HOOK).toContain('scripts/install.sh');
    expect(PASTED_IMAGE_NEEDS_HOOK).toContain('image_id');
    expect(IMAGE_SEARCH_OFF).toContain('OPENROUTER_API_KEY');
  });
});

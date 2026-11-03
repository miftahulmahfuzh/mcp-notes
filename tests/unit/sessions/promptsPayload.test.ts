import { describe, expect, it } from 'vitest';
import { toPromptsPayload } from '../../../src/sessions/view.js';

const HEAD = { node_id: 'A0-3G', host: 'pc' };

describe('toPromptsPayload', () => {
  it('numbers side-table rows from 1 in the given order and keeps text byte for byte', () => {
    const spaced = '  indented\n\n\tcode  block\n[redacted] kept  ';
    const out = toPromptsPayload(HEAD, 'pc', {
      kind: 'full',
      rows: [
        { text: spaced, at: new Date('2026-11-01T01:00:00Z'), truncated: false },
        { text: 'cut', at: null, truncated: true },
      ],
    });
    expect(out).toEqual({
      node_id: 'A0-3G',
      host: 'pc',
      available: true,
      complete: true,
      incomplete_reason: null,
      prompts: [
        { n: 1, text: spaced, at: '2026-11-01T01:00:00.000Z', truncated: false },
        { n: 2, text: 'cut', at: null, truncated: true },
      ],
    });
  });

  it('falls back to the excerpt jsonb, not_backfilled, on another host', () => {
    const out = toPromptsPayload(HEAD, 'lenovo', {
      kind: 'legacy',
      excerpts: [{ text: 'old excerpt…', at: '2026-11-01T02:00:00Z' }, { text: '   ' }, 'bare string'],
    });
    expect(out).toEqual({
      node_id: 'A0-3G',
      host: 'pc',
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [
        { n: 1, text: 'old excerpt…', at: '2026-11-01T02:00:00.000Z', truncated: false },
        { n: 2, text: 'bare string', at: null, truncated: false },
      ],
    });
  });

  it('a row rebuilt from excerpts (transcript pruned) is never complete', () => {
    const out = toPromptsPayload(HEAD, 'pc', { kind: 'pruned', rows: [{ text: 'kept excerpt…', at: null, truncated: true }] });
    expect(out).toMatchObject({
      complete: false,
      incomplete_reason: 'transcript_pruned',
      prompts: [{ n: 1, text: 'kept excerpt…', at: null, truncated: true }],
    });
  });
});

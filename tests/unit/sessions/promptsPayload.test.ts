import { describe, expect, it } from 'vitest';
import { toPromptsPayload } from '../../../src/sessions/view.js';

const HEAD = { node_id: 'A0-3G', host: 'pc' };

describe('toPromptsPayload', () => {
  it('numbers side-table rows from 1 in the given order and keeps text byte for byte', () => {
    const spaced = '  indented\n\n\tcode  block\n[redacted] kept  ';
    const out = toPromptsPayload(HEAD, 'pc', {
      kind: 'full',
      rows: [
        { seq: 1, text: spaced, at: new Date('2026-11-01T01:00:00Z'), truncated: false },
        { seq: 2, text: 'cut', at: null, truncated: true },
      ],
      images: [],
    });
    expect(out).toEqual({
      node_id: 'A0-3G',
      host: 'pc',
      available: true,
      complete: true,
      incomplete_reason: null,
      prompts: [
        { n: 1, text: spaced, at: '2026-11-01T01:00:00.000Z', truncated: false, images: [] },
        { n: 2, text: 'cut', at: null, truncated: true, images: [] },
      ],
    });
  });

  it('attaches each prompt its own images, in position order, by matching seq', () => {
    const out = toPromptsPayload(HEAD, 'pc', {
      kind: 'full',
      rows: [
        { seq: 1, text: 'no pictures', at: null, truncated: false },
        { seq: 2, text: 'two pictures', at: null, truncated: false },
      ],
      images: [
        { prompt_seq: 2, id: 'A-AA2', width: 20, height: 10, host: 'pc' },
        { prompt_seq: 2, id: 'A-AA1', width: 30, height: 15, host: 'lenovo' },
      ],
    });
    expect(out.prompts).toEqual([
      { n: 1, text: 'no pictures', at: null, truncated: false, images: [] },
      {
        n: 2,
        text: 'two pictures',
        at: null,
        truncated: false,
        images: [
          { id: 'A-AA2', width: 20, height: 10, available: true, urls: { thumb: '/api/chat/images/A-AA2/thumb', display: '/api/chat/images/A-AA2/display' } },
          { id: 'A-AA1', width: 30, height: 15, available: false, urls: { thumb: '/api/chat/images/A-AA1/thumb', display: '/api/chat/images/A-AA1/display' } },
        ],
      },
    ]);
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
        { n: 1, text: 'old excerpt…', at: '2026-11-01T02:00:00.000Z', truncated: false, images: [] },
        { n: 2, text: 'bare string', at: null, truncated: false, images: [] },
      ],
    });
  });

  it('a row rebuilt from excerpts (transcript pruned) is never complete, and never carries images', () => {
    const out = toPromptsPayload(HEAD, 'pc', { kind: 'pruned', rows: [{ seq: 1, text: 'kept excerpt…', at: null, truncated: true }] });
    expect(out).toMatchObject({
      complete: false,
      incomplete_reason: 'transcript_pruned',
      prompts: [{ n: 1, text: 'kept excerpt…', at: null, truncated: true, images: [] }],
    });
  });
});

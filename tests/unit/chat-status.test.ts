import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES } from '../../src/connectors/names.js';
import { NOTES_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 18 notes tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(18);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(18 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    expect(tools).toContain('mcp__notes__similar_images');
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });

  it('offers no tool that deletes permanently', () => {
    expect(NOTES_TOOL_NAMES.filter((name) => /purge|forever|destroy/.test(name))).toEqual([]);
  });
});

describe('captionForToolUse', () => {
  it.each([
    [n('search'), {}, 'searching notes'],
    [n('list'), {}, 'searching notes'],
    [n('tags'), {}, 'searching notes'],
    [n('related'), { id: 'A-B32' }, 'finding related notes'],
    [n('similar_images'), { image_id: 'A-B32' }, 'finding similar photos'],
    [n('get'), { ids: ['A-B32'] }, 'reading a note'],
    [n('get'), { ids: ['A-B32', 'B-C43', 'C-D54'] }, 'reading 3 notes'],
    [n('get'), {}, 'reading notes'],
    [n('view_images'), { ids: ['A-B32'] }, 'looking at a photo'],
    [n('view_images'), { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }, 'looking at 4 photos'],
    [n('view_images'), null, 'looking at photos'],
    [n('revisions'), {}, 'reading history'],
    [n('create'), {}, 'saving a note'],
    [n('create_image'), {}, 'saving a note'],
    [n('update'), {}, 'editing a note'],
    [n('append'), {}, 'editing a note'],
    [n('revert'), {}, 'editing a note'],
    [n('delete'), {}, 'deleting a note'],
    [n('restore'), {}, 'restoring a note'],
    [n('attach_image'), { id: 'A-B32', path: '/tmp/a.png' }, 'attaching a photo'],
    [n('remove_image'), { image_id: 'C-D54' }, 'removing a photo'],
    [n('restore_image'), { image_id: 'C-D54' }, 'restoring a photo'],
    ['WebSearch', { query: 'Verity' }, 'searching the web'],
    ['WebFetch', { url: 'https://example.com' }, 'reading a web page'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it.each([
    [n('expenses_schema'), {}, 'reading expenses'],
    [n('expenses_sql'), { sql: 'select 1' }, 'reading expenses'],
    [n('expenses_spending'), { from: '2026-10-01', to: '2026-10-31' }, 'reading expenses'],
    [n('expenses_get'), { id: 'g1' }, 'reading expenses'],
    [n('expenses_months'), {}, 'reading expenses'],
    [n('runs_schema'), {}, 'reading runs'],
    [n('runs_sql'), { sql: 'select 1' }, 'reading runs'],
    [n('runs_list'), { from: '2026-10-01', to: '2026-10-31' }, 'reading runs'],
    [n('runs_get'), { date: '2026-10-29' }, 'reading runs'],
    [n('runs_review'), {}, 'reading runs'],
    [n('seer_schema'), {}, 'reading seer'],
    [n('seer_sql'), { sql: 'select 1', source: 'lab' }, 'reading seer'],
    [n('seer_leaderboard'), {}, 'reading seer'],
    [n('seer_positions'), {}, 'reading seer'],
    [n('seer_sera_best'), {}, 'reading seer'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it('captions every connector tool in the contract', () => {
    for (const name of ALL_CONNECTOR_TOOL_NAMES) {
      expect(captionForToolUse(n(name), {})).toMatch(/^reading (expenses|runs|seer)$/);
    }
  });

  it('names nothing outside the surface', () => {
    expect(captionForToolUse('Bash', { command: 'ls' })).toBeNull();
    expect(captionForToolUse('mcp__other__search', {})).toBeNull();
    expect(captionForToolUse('mcp__other__expenses_sql', {})).toBeNull();
    expect(captionForToolUse(n('unknown'), {})).toBeNull();
    expect(captionForToolUse(n('expenses_unknown'), {})).toBeNull();
  });
});

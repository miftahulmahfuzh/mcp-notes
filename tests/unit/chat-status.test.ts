import { describe, expect, it } from 'vitest';
import { NOTES_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';

const n = (name: string): string => `mcp__notes__${name}`;

describe('allowedChatTools', () => {
  it('is exactly the 13 notes tools plus WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(13);
    expect(tools).toHaveLength(15);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
});

describe('captionForToolUse', () => {
  it.each([
    [n('search'), {}, 'searching notes'],
    [n('list'), {}, 'searching notes'],
    [n('tags'), {}, 'searching notes'],
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
    ['WebSearch', { query: 'Verity' }, 'searching the web'],
    ['WebFetch', { url: 'https://example.com' }, 'reading a web page'],
  ])('%s %j -> %s', (name, input, caption) => {
    expect(captionForToolUse(name, input)).toBe(caption);
  });

  it('names nothing outside the surface', () => {
    expect(captionForToolUse('Bash', { command: 'ls' })).toBeNull();
    expect(captionForToolUse('mcp__other__search', {})).toBeNull();
    expect(captionForToolUse(n('unknown'), {})).toBeNull();
  });
});

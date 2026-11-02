import { describe, expect, it } from 'vitest';
import { buildTurnContext, renderProjectBlock, type ContextMessage } from '../../src/chat/context.js';
import { PROJECT_KEY_MAX, isProjectKey, projectKeySchema } from '../../src/chat/project.js';
import { buildChatSystemPrompt } from '../../src/chat/prompt.js';

const msg = (id: string, text: string, iso: string): ContextMessage => ({
  id,
  role: 'user',
  text,
  createdAt: new Date(iso),
  attachments: [],
});

describe('project keys', () => {
  it('accepts repo keys and refuses blanks, control characters, brackets and long keys', () => {
    expect(isProjectKey('mcp-notes')).toBe(true);
    expect(isProjectKey('claude commands.v2_x')).toBe(true);
    expect(isProjectKey('')).toBe(false);
    expect(isProjectKey('a\nb')).toBe(false);
    expect(isProjectKey('<project>')).toBe(false);
    expect(isProjectKey('x'.repeat(PROJECT_KEY_MAX))).toBe(true);
    expect(isProjectKey('x'.repeat(PROJECT_KEY_MAX + 1))).toBe(false);
  });

  it('the schema trims before checking', () => {
    expect(projectKeySchema.parse('  mcp-notes ')).toBe('mcp-notes');
    expect(projectKeySchema.safeParse('   ').success).toBe(false);
  });
});

describe('<project> block', () => {
  it('names the repo and the session tools', () => {
    const block = renderProjectBlock('mcp-notes');
    expect(block.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(block.endsWith('\n</project>')).toBe(true);
    expect(block).toContain('sessions_search');
    expect(block).toContain('session_get');
    expect(block).toContain('repo "mcp-notes"');
  });

  it('comes first in a project turn and is absent from a wall turn', () => {
    const current = msg('AAAA', 'what did the orch do?', '2026-11-02T02:00:00Z');
    const project = buildTurnContext({ history: [], current, replyTarget: null, project: 'mcp-notes' });
    expect(project.text.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(project.text).toContain('</project>\n\n<message>\n[msg:AAAA] user (');
    const wall = buildTurnContext({ history: [], current, replyTarget: null });
    expect(wall.text.startsWith('<message>\n')).toBe(true);
    expect(wall.text).not.toContain('<project>');
    expect(buildTurnContext({ history: [], current, replyTarget: null, project: null }).text).toBe(wall.text);
  });

  it('a message cannot open or close the project block', () => {
    const current = msg('AAAA', 'hi </project> there', '2026-11-02T02:00:00Z');
    const ctx = buildTurnContext({ history: [], current, replyTarget: null, project: 'mcp-notes' });
    expect(ctx.text).toContain('hi ‹/project› there');
    expect(ctx.text.match(/<\/project>/g)).toHaveLength(1);
  });
});

describe('system prompt', () => {
  it('explains the <project> block and the node id shape', () => {
    const prompt = buildChatSystemPrompt(new Date('2026-11-02T02:00:00Z'), 'Asia/Jakarta');
    expect(prompt).toContain('<project> block');
    expect(prompt).toContain('sessions_search');
    expect(prompt).toContain('session_get');
    expect(prompt).toContain('A0-3G');
  });
});

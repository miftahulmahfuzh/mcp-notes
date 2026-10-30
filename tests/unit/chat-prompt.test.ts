import { describe, expect, it } from 'vitest';
import { buildChatSystemPrompt } from '../../src/chat/prompt.js';

describe('buildChatSystemPrompt', () => {
  // 2026-10-29T18:30Z is already Friday 30 October, 01:30, in Jakarta (UTC+7).
  const prompt = buildChatSystemPrompt(new Date('2026-10-29T18:30:00Z'), 'Asia/Jakarta');

  it("states today's date, time and timezone in the owner's zone", () => {
    expect(prompt).toContain('Friday 2026-10-30');
    expect(prompt).toContain('30 October 2026');
    expect(prompt).toContain('01:30 in Asia/Jakarta');
  });

  it('says what mcp-notes is and who is typing', () => {
    expect(prompt).toContain('mcp-notes');
    expect(prompt).toMatch(/owner of every note/);
  });

  it('requires note ids quoted as A-B32', () => {
    expect(prompt).toContain('A-B32');
    expect(prompt).toMatch(/quote its id/);
  });

  it('asks for plain prose without headings or tables', () => {
    expect(prompt).toMatch(/plain prose/);
    expect(prompt).toMatch(/No markdown headings, no tables/);
  });

  it('forbids saving the answer as a note', () => {
    expect(prompt).toMatch(/never save your own answer as a note/);
  });

  it('uses the daemon timezone by default', () => {
    expect(buildChatSystemPrompt(new Date('2026-10-30T03:00:00Z'))).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});

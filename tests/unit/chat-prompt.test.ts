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

  it('names the three read-only apps and how to reach them', () => {
    expect(prompt).toContain('expense-tracking');
    expect(prompt).toContain('run-insights');
    expect(prompt).toContain('Seer');
    expect(prompt).toContain('Sera');
    expect(prompt).toContain('Nina');
    expect(prompt).toMatch(/read-only/);
    expect(prompt).toContain('expenses_*');
    expect(prompt).toContain('runs_*');
    expect(prompt).toContain('seer_*');
  });

  it('prefers curated tools and keeps _sql last, after _schema', () => {
    expect(prompt).toMatch(/curated tools first/);
    expect(prompt).toMatch(/_sql tool only when the curated tools do not answer/);
    expect(prompt).toMatch(/_schema tool before you write SQL/);
  });

  it('asks data answers for what the data shows and an opinion, not a tally', () => {
    expect(prompt).toMatch(/what the data shows and what you think about it, not just a tally/);
    expect(prompt).toMatch(/one concrete suggestion/);
  });

  it("asks for the apps' own units", () => {
    expect(prompt).toContain('Rp 38.500');
    expect(prompt).toContain('m:ss /km');
    expect(prompt).toContain('USD');
  });

  it('forbids guessing numbers when an app fails', () => {
    expect(prompt).toMatch(/say which app could not be read and do not guess its numbers/);
  });

  it('leaves link formatting to the panel', () => {
    expect(prompt).not.toMatch(/markdown link|bare URL/i);
  });

  it('says note files are visible by name, type and size but cannot be opened', () => {
    expect(prompt).toMatch(/files that are not pictures/);
    expect(prompt).toMatch(/cannot open them/);
  });
});

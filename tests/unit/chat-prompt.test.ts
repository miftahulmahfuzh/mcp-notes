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

  it('tells the agent how pasted images appear and to use similar_images, then view_images', () => {
    expect(prompt).toContain('[image upload:ID]');
    expect(prompt).toMatch(/similar_images with upload_id/);
    expect(prompt).toMatch(/then call view_images on the top hits/);
  });

  it('saves or attaches a pasted image by its ID, resolves "that image", and never asks for a path', () => {
    expect(prompt).toMatch(/call create_image with image_id set to its ID/);
    expect(prompt).toMatch(/call attach_image with that note's id and image_id set to its ID/);
    expect(prompt).toContain('"That image" is the one whose ID the owner names');
    expect(prompt).toContain('otherwise the picture in <message>');
    expect(prompt).toContain('otherwise the most recent [image upload:ID] in <chat_history>');
    expect(prompt).toMatch(/Never ask the owner for a file path to a picture they pasted/);
    expect(prompt).toMatch(/created: false, or attached: false for attach_image/);
  });

  it('explains the context layout the turn arrives in', () => {
    expect(prompt).toContain('<chat_history>');
    expect(prompt).toContain('<reply_to>');
    expect(prompt).toContain('<message>');
    expect(prompt).toContain('[earlier messages omitted]');
    expect(prompt).toContain('WIB (Asia/Jakarta)');
    expect(prompt).toContain('[image upload:ID]');
  });

  it('teaches the optional leading [msg:ID] reply', () => {
    expect(prompt).toContain('[msg:K7F2]');
    expect(prompt).toMatch(/starting your answer with its label/);
    expect(prompt).toMatch(/Replying is optional/);
    expect(prompt).toMatch(/never for the current message, and never invent a label/);
  });

  it('names daily-words as the one writable app and gives its tool prefix', () => {
    expect(prompt).toContain('daily-words');
    expect(prompt).toMatch(/you may write to daily-words as well as read it/);
    expect(prompt).toContain('dword_*');
  });

  it('triggers a vocab lookup-then-add flow from natural language, never a slash command', () => {
    expect(prompt).toContain('what does X mean');
    expect(prompt).toContain('add the word X');
    expect(prompt).toContain('X as in <sentence>');
    expect(prompt).toMatch(/call dword_vocab_lookup with that term first/);
    expect(prompt).toMatch(/call dword_vocab_add with everything you wrote/);
    expect(prompt).toMatch(/the chat bar never parses \/v or \/j/);
  });

  it('mirrors the vocab register rules from the /v skill: pronunciation, definition and example limits', () => {
    expect(prompt).toMatch(/British RP pronunciation/);
    expect(prompt).toMatch(/definition aiming under 60 characters \(hard ceiling 80\)/);
    expect(prompt).toMatch(/three example sentences, each containing the term and aiming under 100 characters \(hard ceiling 120\)/);
  });

  it('passes origin as the tool takes it: an origin object for a non-English term, context for an English one', () => {
    expect(prompt).toMatch(/put the natural English word in term/);
    expect(prompt).toContain('origin.term');
    expect(prompt).toContain('origin.language');
    expect(prompt).toContain('origin.context');
    expect(prompt).toMatch(/pass that sentence as context instead \(never both\)/);
    expect(prompt).not.toMatch(/pass origin_term|set origin_term/);
  });

  it('never overwrites an existing vocab origin', () => {
    expect(prompt).toMatch(/it never overwrites an origin that is already set/);
  });

  it('triggers a journal find-similar-then-add flow and shows a duplicate before inserting', () => {
    expect(prompt).toMatch(/call dword_journal_find_similar with the text first/);
    expect(prompt).toMatch(/show the owner the existing entry and its insight and insert nothing/);
    expect(prompt).toMatch(/force: true/);
    expect(prompt).toMatch(/meaning under 220 characters/);
    expect(prompt).toMatch(/2 to 3 concrete everyday situations/);
    expect(prompt).toMatch(/no advice, no praise/);
  });

  it('names the movie tools and keeps movies_continue for explicit play requests', () => {
    for (const name of ['movies_list', 'movies_get', 'movies_history', 'movies_continue', 'movies_person', 'movies_mark']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toMatch(/movies_continue opens VLC on the owner's screen, so call it only when the owner asks to play, resume or continue something/);
    expect(prompt).toMatch(/"continue what I watched last night" is movies_continue with no title/);
  });

  it('reads "this film" on a title page as the open title and says how to answer about it', () => {
    expect(prompt).toMatch(/"this film", "this show", "here", "this director" and "the main character" all mean that title, so never ask which one/);
    expect(prompt).toMatch(/Call movies_get with that id first/);
    expect(prompt).toMatch(/Trivia, production stories and reception are a WebSearch/);
    expect(prompt).toMatch(/"Films like this" is a WebSearch for similar films/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  extractImages,
  findLatestImagePrompt,
  findTurn,
  isHumanPrompt,
  isNotesPrompt,
  isNotesPromptText,
  listImagePrompts,
  parseTranscript,
  pickPastedImage,
  promptImages,
  findLatestPromptImages,
  promptText,
} from '../../../claude/hooks/lib/transcript.mjs';
import {
  BLUE_DATA,
  RED_PNG_16,
  assistantText,
  assistantToolUse,
  attachmentEntry,
  skillBodyWithImagesEntry,
  commandEntry,
  imagePromptEntry,
  jsonl,
  localCommandEntries,
  plainPromptEntry,
  skillBodyEntry,
  toolResultEntry,
} from './fixtures.js';

describe('parseTranscript', () => {
  it('skips blank, malformed and torn lines', () => {
    const text = `${jsonl([commandEntry('a')])}\nnot json\n{"type":"user","message":{"ro`;
    const entries = parseTranscript(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('user');
  });
});

describe('promptText / isNotesPrompt', () => {
  it('turns the string-form /n command entry into what was typed', () => {
    const entry = commandEntry('show me the notes tagged #agentic');
    expect(isHumanPrompt(entry)).toBe(true);
    expect(promptText(entry)).toBe('/n show me the notes tagged #agentic');
    expect(isNotesPrompt(entry)).toBe(true);
  });

  it('handles /n with no args and the other tag order', () => {
    expect(promptText(commandEntry(''))).toBe('/n');
    const swapped = commandEntry('x', {
      message: { role: 'user', content: '<command-name>/n</command-name>\n<command-message>n</command-message>\n<command-args>find red cars</command-args>' },
    });
    expect(promptText(swapped)).toBe('/n find red cars');
    expect(isNotesPrompt(swapped)).toBe(true);
  });

  it('reads an array-form prompt typed as /n with a pasted image', () => {
    const entry = imagePromptEntry('/n find photos like this\n[Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    expect(promptText(entry)).toBe('/n find photos like this\n[Image #1]');
    expect(isNotesPrompt(entry)).toBe(true);
  });

  it('does not take other commands or a mid-text /n for /n', () => {
    expect(isNotesPrompt(plainPromptEntry('/notes list'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('/new thing'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('please run /n later'))).toBe(false);
    expect(isNotesPrompt(plainPromptEntry('  /n leading spaces'))).toBe(true);
    const other = commandEntry('x', { message: { role: 'user', content: '<command-message>migrate</command-message>\n<command-name>/migrate</command-name>\n<command-args>dir #t</command-args>' } });
    expect(isNotesPrompt(other)).toBe(false);
  });

  it('never treats tool results, meta entries, sidechains or compact summaries as prompts', () => {
    expect(isHumanPrompt(toolResultEntry('t1', 'ok'))).toBe(false);
    expect(isHumanPrompt(skillBodyEntry())).toBe(false);
    expect(isHumanPrompt(commandEntry('x', { isSidechain: true }))).toBe(false);
    expect(isHumanPrompt(plainPromptEntry('summary', { isCompactSummary: true }))).toBe(false);
    expect(isHumanPrompt(plainPromptEntry('<local-command-stdout>done</local-command-stdout>'))).toBe(false);
    expect(isHumanPrompt(commandEntry('x', { origin: { kind: 'task-notification' } }))).toBe(false);
  });
});

describe('extractImages / pickPastedImage', () => {
  it('pairs image blocks with imagePasteIds in order', () => {
    const entry = imagePromptEntry('two', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ], [3, 4]);
    const images = extractImages(entry);
    expect(images.map((i) => [i.media_type, i.paste_id])).toEqual([['image/png', 3], ['image/jpeg', 4]]);
    expect(pickPastedImage(images, 4)?.data_base64).toBe(BLUE_DATA);
    expect(pickPastedImage(images, 1)?.data_base64).toBe(RED_PNG_16);
    expect(pickPastedImage(images, 2)?.data_base64).toBe(BLUE_DATA);
    expect(pickPastedImage(images, 9)).toBeNull();
    expect(pickPastedImage(images, 0)).toBeNull();
  });

  it('falls back to block order without imagePasteIds', () => {
    const entry = imagePromptEntry('two', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ], null);
    expect(extractImages(entry).map((i) => i.paste_id)).toEqual([1, 2]);
  });
});

describe('findTurn', () => {
  it('finds the /n command across the skill body, tool calls and attachments, and keeps only the final text', () => {
    const entries = parseTranscript(
      jsonl([
        ...localCommandEntries(),
        commandEntry('show me the notes tagged #agentic'),
        skillBodyEntry(),
        attachmentEntry(),
        assistantText('Let me look.'),
        assistantToolUse('t1', 'mcp__notes__list', { tags_any: ['agentic'] }),
        toolResultEntry('t1', '{"notes":[]}'),
        assistantText('Two notes are tagged #agentic.'),
        assistantText('A-B32 and C-D45.'),
      ]),
    );
    const turn = findTurn(entries);
    expect(turn).not.toBeNull();
    expect(promptText(turn!.prompt)).toBe('/n show me the notes tagged #agentic');
    expect(turn!.answer).toBe('Two notes are tagged #agentic.\n\nA-B32 and C-D45.');
    expect(turn!.answeredAt).not.toBeNull();
  });

  it('picks the latest prompt: a later non-/n turn is not a notes turn', () => {
    const entries = parseTranscript(
      jsonl([commandEntry('first'), assistantText('one'), plainPromptEntry('thanks, now fix the build'), assistantText('done')]),
    );
    const turn = findTurn(entries)!;
    expect(isNotesPrompt(turn.prompt)).toBe(false);
    expect(turn.answer).toBe('done');
  });

  it('a later /n turn after an ordinary one is found', () => {
    const entries = parseTranscript(jsonl([plainPromptEntry('hello'), assistantText('hi'), commandEntry('second'), assistantText('two')]));
    const turn = findTurn(entries)!;
    expect(promptText(turn.prompt)).toBe('/n second');
    expect(turn.answer).toBe('two');
  });

  it('a lagging transcript (prompt written, answer not yet) gives an empty answer', () => {
    const turn = findTurn(parseTranscript(jsonl([commandEntry('x'), skillBodyEntry()])))!;
    expect(turn.answer).toBe('');
    expect(turn.answeredAt).toBeNull();
  });

  it('ignores sidechain assistant text', () => {
    const turn = findTurn(parseTranscript(jsonl([commandEntry('x'), assistantText('sub', { isSidechain: true }), assistantText('main')])))!;
    expect(turn.answer).toBe('main');
  });

  it('returns null without any human prompt', () => {
    expect(findTurn(parseTranscript(jsonl([skillBodyEntry(), toolResultEntry('t', 'r')])))).toBeNull();
  });
});

describe('findLatestImagePrompt', () => {
  it('returns the latest image-carrying human prompt even when later prompts have none', () => {
    const older = imagePromptEntry('old [Image #1]', [{ media_type: 'image/png', data: BLUE_DATA }]);
    const newer = imagePromptEntry('/n like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    const entries = parseTranscript(jsonl([older, assistantText('ok'), newer, assistantText('ok'), plainPromptEntry('and now?')]));
    expect(findLatestImagePrompt(entries)?.uuid).toBe(newer.uuid);
  });
});

describe('isNotesPromptText', () => {
  it('accepts /n typed or as command XML, nothing else', () => {
    expect(isNotesPromptText('/n')).toBe(true);
    expect(isNotesPromptText('/n make that image a note')).toBe(true);
    expect(isNotesPromptText('  /n leading spaces')).toBe(true);
    expect(isNotesPromptText('/n\n[Image #1]')).toBe(true);
    expect(isNotesPromptText('<command-message>n</command-message>\n<command-name>/n</command-name>\n<command-args>save it</command-args>')).toBe(true);
    expect(isNotesPromptText('/notes list')).toBe(false);
    expect(isNotesPromptText('/new thing')).toBe(false);
    expect(isNotesPromptText('please run /n later')).toBe(false);
    expect(isNotesPromptText('')).toBe(false);
    expect(isNotesPromptText(undefined)).toBe(false);
    expect(isNotesPromptText(42)).toBe(false);
  });
});

describe('listImagePrompts', () => {
  it('lists every image-carrying human prompt oldest first, /n or not', () => {
    const first = imagePromptEntry('look [Image #1] [Image #2]', [
      { media_type: 'image/png', data: RED_PNG_16 },
      { media_type: 'image/jpeg', data: BLUE_DATA },
    ]);
    const second = imagePromptEntry('/n and this [Image #3]', [{ media_type: 'image/png', data: BLUE_DATA }], [3]);
    const entries = parseTranscript(
      jsonl([
        first,
        assistantText('ok'),
        plainPromptEntry('no picture here'),
        toolResultEntry('t1', 'result'),
        imagePromptEntry('sub [Image #9]', [{ media_type: 'image/png', data: RED_PNG_16 }], [9], { isSidechain: true }),
        second,
        attachmentEntry(),
      ]),
    );
    const listed = listImagePrompts(entries);
    expect(listed.map((p) => p.entry.uuid)).toEqual([first.uuid, second.uuid]);
    expect(listed[0]!.images.map((i) => i.paste_id)).toEqual([1, 2]);
    expect(listed[0]!.images[1]!.media_type).toBe('image/jpeg');
    expect(listed[1]!.images).toEqual([{ media_type: 'image/png', data_base64: BLUE_DATA, paste_id: 3 }]);
  });

  it('lists a rewritten line (same uuid) once, and is empty without images', () => {
    const entry = imagePromptEntry('x [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]);
    expect(listImagePrompts(parseTranscript(jsonl([entry, entry])))).toHaveLength(1);
    expect(listImagePrompts(parseTranscript(jsonl([commandEntry('hi'), assistantText('ok')])))).toEqual([]);
  });
});

describe('pictures of a slash-command prompt (they sit on the isMeta entry after it)', () => {
  const png = { media_type: 'image/png', data: RED_PNG_16 };

  it('promptImages counts the meta entry\'s pictures as the command\'s, numbered from 1, skipping attachments', () => {
    const entries = [commandEntry('save this [Image #1]'), attachmentEntry(), skillBodyWithImagesEntry([png])];
    expect(promptImages(entries, 0).map((i) => [i.paste_id, i.data_base64])).toEqual([[1, RED_PNG_16]]);
    expect(extractImages(entries[0])).toEqual([]);
  });

  it('stops at the assistant and does not borrow a later turn\'s meta pictures', () => {
    const entries = [commandEntry('save it'), skillBodyEntry(), assistantText('ok'), skillBodyWithImagesEntry([png])];
    expect(promptImages(entries, 0)).toEqual([]);
  });

  it('listImagePrompts and findLatestPromptImages see the command prompt with its pictures', () => {
    const entries = [commandEntry('save this [Image #1]'), skillBodyWithImagesEntry([png]), assistantText('ok')];
    const listed = listImagePrompts(entries);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.entry).toBe(entries[0]);
    expect(findLatestImagePrompt(entries)).toBe(entries[0]);
    expect(pickPastedImage(findLatestPromptImages(entries)!.images, 1)?.data_base64).toBe(RED_PNG_16);
  });

  it('findTurn carries the command prompt\'s pictures', () => {
    const turn = findTurn([commandEntry('save this [Image #1]'), skillBodyWithImagesEntry([png]), assistantText('done')]);
    expect(turn?.images).toHaveLength(1);
  });
});

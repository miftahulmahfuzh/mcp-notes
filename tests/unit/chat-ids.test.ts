import { describe, expect, it } from 'vitest';
import { generateMessageId, isMessageId, messageLabel, normalizeMessageId } from '../../src/chat/ids.js';
import { ID_ALPHABET } from '../../src/notes/ids.js';

describe('chat message ids', () => {
  it('generates 4 characters from [0-9A-Z]', () => {
    for (let i = 0; i < 200; i += 1) expect(generateMessageId()).toMatch(/^[0-9A-Z]{4}$/);
  });

  it('uses the injected random source', () => {
    const picks = ['K', '7', 'F', '2'].map((ch) => ID_ALPHABET.indexOf(ch));
    expect(generateMessageId(() => picks.shift() ?? 0)).toBe('K7F2');
  });

  it('refuses an out-of-range random index', () => {
    expect(() => generateMessageId(() => 99)).toThrow(RangeError);
  });

  it('normalizes the forms people and models write', () => {
    expect(normalizeMessageId('k7f2')).toBe('K7F2');
    expect(normalizeMessageId(' K7F2 ')).toBe('K7F2');
    expect(normalizeMessageId('msg:k7f2')).toBe('K7F2');
    expect(normalizeMessageId('[msg:K7F2]')).toBe('K7F2');
  });

  it('rejects anything else, including note ids', () => {
    for (const bad of ['', 'K7F', 'K7F23', 'A-B32', '[msg:K7F2', 'msg K7F2', '[MSG:K7F]']) {
      expect(normalizeMessageId(bad)).toBeNull();
    }
    expect(isMessageId('K7F2')).toBe(true);
    expect(isMessageId('k7f2')).toBe(false);
  });

  it('labels ids as [msg:ID]', () => {
    expect(messageLabel('K7F2')).toBe('[msg:K7F2]');
  });
});

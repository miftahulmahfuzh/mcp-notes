import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { composePromptText, composeUserTurn, toSdkPrompt, uploadTag, userTurnContent } from '../../src/chat/compose.js';

const IMG = { id: 'U-PL1', previewMime: 'image/jpeg' as const };
const IMG2 = { id: 'V-QM2', previewMime: 'image/jpeg' as const };

describe('composePromptText', () => {
  it('leaves a text-only message unchanged', () => {
    expect(composePromptText('what did I save?', [])).toBe('what did I save?');
  });
  it('appends one [image upload:ID] line per image after a blank line', () => {
    expect(composePromptText('what is this?', ['U-PL1'])).toBe(
      'what is this?\n\nThe owner attached 1 image to this message. It is shown above, and its upload id is:\n[image upload:U-PL1]',
    );
    expect(composePromptText('compare', ['U-PL1', 'V-QM2']).split('\n').slice(-2)).toEqual([
      '[image upload:U-PL1]',
      '[image upload:V-QM2]',
    ]);
  });
  it('an image-only message is the image block alone', () => {
    expect(composePromptText('', ['U-PL1']).startsWith('The owner attached 1 image')).toBe(true);
  });
  it('uploadTag is the one spelling', () => {
    expect(uploadTag('A-B32')).toBe('[image upload:A-B32]');
  });
});

describe('composeUserTurn', () => {
  it('pairs each image with its preview, in order', () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG, IMG2] }, ['AAA', 'BBB']);
    expect(turn.images).toEqual([
      { id: 'U-PL1', mediaType: 'image/jpeg', data: 'AAA' },
      { id: 'V-QM2', mediaType: 'image/jpeg', data: 'BBB' },
    ]);
    expect(turn.text).toContain('[image upload:V-QM2]');
  });
  it('refuses a preview count that does not match', () => {
    expect(() => composeUserTurn({ message: 'hi', images: [IMG] }, [])).toThrow(/1 images but 0 previews/);
  });
});

describe('userTurnContent / toSdkPrompt', () => {
  it('puts the image blocks before the text block', () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG] }, ['AAA']);
    expect(userTurnContent(turn).map((b) => b.type)).toEqual(['image', 'text']);
  });
  it('is the plain string for a text-only turn', () => {
    expect(toSdkPrompt(composeUserTurn({ message: 'hi', images: [] }, []))).toBe('hi');
  });
  it('is a one-message stream for a turn with images, each call a fresh stream', async () => {
    const turn = composeUserTurn({ message: 'hi', images: [IMG] }, ['AAA']);
    const read = async (p: string | AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> => {
      if (typeof p === 'string') throw new Error('expected a stream');
      const out: SDKUserMessage[] = [];
      for await (const m of p) out.push(m);
      return out;
    };
    const a = await read(toSdkPrompt(turn));
    const b = await read(toSdkPrompt(turn));
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a[0]).toEqual({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: userTurnContent(turn) },
    });
  });
});

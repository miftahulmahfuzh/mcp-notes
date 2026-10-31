import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatTurnImage } from './backend.js';

/** One content block of a user message, as the Agent SDK takes it (an Anthropic `ContentBlockParam`). */
export type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];

/** How a chat image is named to the model and in chat text: `[image upload:A-B32]`. */
export function uploadTag(id: string): string {
  return `[image upload:${id}]`;
}

export interface ComposedImage {
  id: string;
  mediaType: ChatTurnImage['previewMime'];
  /** Base64 of the preview file. */
  data: string;
}

/** What the model receives for one turn: image blocks (in order) and then this text. */
export interface UserTurn {
  text: string;
  images: readonly ComposedImage[];
}

export interface ComposeInput {
  message: string;
  images: readonly Pick<ChatTurnImage, 'id' | 'previewMime'>[];
}

/**
 * The text block: the message, then a short note and one `[image upload:ID]` line per image so
 * the model can pass the id to tools. A text-only turn is the message unchanged.
 */
export function composePromptText(message: string, imageIds: readonly string[]): string {
  if (imageIds.length === 0) return message;
  const header =
    imageIds.length === 1
      ? 'The owner attached 1 image to this message. It is shown above, and its upload id is:'
      : `The owner attached ${imageIds.length} images to this message. They are shown above in this order, with these upload ids:`;
  const block = [header, ...imageIds.map(uploadTag)].join('\n');
  return message === '' ? block : `${message}\n\n${block}`;
}

/** Pure. `previews[i]` is the base64 of `input.images[i]`'s preview file. */
export function composeUserTurn(input: ComposeInput, previews: readonly string[]): UserTurn {
  if (previews.length !== input.images.length) {
    throw new Error(`composeUserTurn: ${input.images.length} images but ${previews.length} previews`);
  }
  return {
    text: composePromptText(
      input.message,
      input.images.map((image) => image.id),
    ),
    images: input.images.map((image, i) => ({ id: image.id, mediaType: image.previewMime, data: previews[i] as string })),
  };
}

/** Image blocks first (the order the owner pasted them), then the text block. */
export function userTurnContent(turn: UserTurn): UserContentBlock[] {
  const blocks = turn.images.map(
    (image): UserContentBlock => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }),
  );
  blocks.push({ type: 'text', text: turn.text });
  return blocks;
}

/**
 * The `prompt` for the SDK's `query`: the plain string for a text-only turn (unchanged behaviour),
 * else a stream of exactly one user message. The SDK closes the CLI's stdin when the stream ends
 * (this run has no hooks, no canUseTool and no in-process MCP server), and the CLI finishes that
 * one turn. A stream can be read once: build a fresh one per attempt.
 */
export function toSdkPrompt(turn: UserTurn): string | AsyncIterable<SDKUserMessage> {
  if (turn.images.length === 0) return turn.text;
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: userTurnContent(turn) },
    parent_tool_use_id: null,
  };
  return (async function* oneMessage(): AsyncGenerator<SDKUserMessage> {
    yield message;
  })();
}

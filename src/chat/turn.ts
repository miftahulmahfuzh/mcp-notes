import type { ChatTurnImage, ComposedTurn } from './backend.js';
import { buildTurnContext } from './context.js';
import { resolveTurnImages, type ChatImageStoreDeps } from './images.js';
import type { ChatService } from './service.js';

export type ImageSource = Pick<ChatImageStoreDeps, 'db' | 'dataDir'>;

export interface WallTurnInput {
  threadId: string;
  /** The user row just written by ChatService.addUserMessage. */
  currentMessageId: string;
  /** That row's images, already resolved (and validated) by the route with phase 3's resolveTurnImages. */
  currentImages: readonly ChatTurnImage[];
}

/**
 * Our rows -> context text (src/chat/context.ts) -> the images sent as blocks. Images of the reply
 * target are resolved here; one that cannot be (not on this machine, gone, unreadable) stays a label
 * in the text only. Preview bytes are read later by the agent (phase 3's `readPreview`).
 */
export async function composeWallTurn(chat: ChatService, source: ImageSource, input: WallTurnInput): Promise<ComposedTurn> {
  const context = await chat.loadTurnContext(input.threadId, input.currentMessageId);
  const built = buildTurnContext(context);
  const byId = new Map<string, ChatTurnImage>(input.currentImages.map((image) => [image.id, image]));
  for (const wanted of built.images) {
    if (byId.has(wanted.id)) continue;
    try {
      const [loaded] = await resolveTurnImages(source, [wanted.id]);
      if (loaded !== undefined) byId.set(wanted.id, loaded);
    } catch {
      // Label only: the model is told the picture exists but cannot see it.
    }
  }
  const images: ChatTurnImage[] = [];
  for (const wanted of built.images) {
    const loaded = byId.get(wanted.id);
    if (loaded !== undefined) images.push({ ...loaded, messageId: wanted.messageId });
  }
  return { text: built.text, images };
}

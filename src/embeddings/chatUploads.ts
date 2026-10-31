import { locateChatImage } from '../chat/images.js';
import type { Db } from '../db/client.js';

/** A chat upload (an image pasted into the chat bar) as `similar_images` reads it. */
export interface ChatUploadFile {
  /** Canonical upload id (A-B32 form, in its own table). */
  id: string;
  /** Absolute path of the stored original under this machine's data dir (may be absent here). */
  absPath: string;
}

/** Looks up an upload id (any case, dash optional). Null when unknown. Never throws for a bad id. */
export type ChatUploadSource = (uploadId: string) => Promise<ChatUploadFile | null>;

/** The daemon's source: phase 3's chat image store (`chat_images`). Lazy: nothing is read until it is called. */
export function dbChatUploadSource(db: Db, dataDir: string): ChatUploadSource {
  return async (input: string): Promise<ChatUploadFile | null> => {
    const loc = await locateChatImage({ db, dataDir }, input);
    if (loc === null) return null;
    return { id: loc.row.id, absPath: loc.source.originalPath };
  };
}

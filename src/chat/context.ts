import type { ChatRole } from '../db/schema.js';
import type { AttachmentRef } from './types.js';

/**
 * Rebuilds the model's prompt for one wall turn from our own rows (the Agent SDK keeps no session).
 * Pure: ChatService.loadTurnContext supplies the rows, src/chat/turn.ts loads the image bytes.
 *
 * Layout (the system prompt in src/chat/prompt.ts explains it to the model):
 *
 *   <project>                       (phase 12: only for a thread started on the Projects page)
 *   repo: mcp-notes
 *   The owner is asking from the page of the repository "mcp-notes" ...
 *   </project>
 *
 *   <chat_history>
 *   [earlier messages omitted]
 *   [msg:K7F2] user (2026-10-31 09:12 WIB): what did I save? [image upload:C-AB12]
 *   [msg:P0Q1] assistant (2026-10-31 09:12 WIB): You saved A-B32.
 *   </chat_history>
 *
 *   <reply_to>
 *   [msg:Z1Y2] assistant (2026-10-30 20:01 WIB): ...
 *   </reply_to>
 *
 *   <message>
 *   [msg:N3W4] user (2026-10-31 09:15 WIB): and last month?
 *   </message>
 */

/** History characters kept per turn (about 6k tokens). The newest lines win. */
export const CONTEXT_CHAR_BUDGET = 24_000;
/** One history or reply-target line is cut to this many characters of text. The current message is never cut. */
export const CONTEXT_LINE_CHAR_CAP = 4_000;
export const OMITTED_LINE = '[earlier messages omitted]';
/** Chat times are always shown in WIB, whatever the daemon's own zone (Invariant 7). */
export const CHAT_TIME_ZONE = 'Asia/Jakarta';

export interface ContextMessage {
  id: string;
  role: ChatRole;
  /** The current (edited) text. */
  text: string;
  createdAt: Date;
  attachments: readonly AttachmentRef[];
}

export interface TurnContextInput {
  /** Live messages of the thread before the current one, ascending. */
  history: readonly ContextMessage[];
  /** The user message being answered now. */
  current: ContextMessage;
  /** The live message the current one replies to (any thread), or null. */
  replyTarget: ContextMessage | null;
  /** Repo key of a project-scoped thread (phase 12). Null or absent: wall chat, no <project> block. */
  project?: string | null;
  /** Default CONTEXT_CHAR_BUDGET. */
  budgetChars?: number;
}

export interface TurnContext {
  text: string;
  /** Chat images to send as image blocks: the current message's, then the reply target's. Deduped. */
  images: Array<{ id: string; messageId: string }>;
  /** History messages dropped by the budget. */
  omitted: number;
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHAT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `2026-10-31 09:15 WIB`. */
export function formatWib(date: Date): string {
  const parts = TIME_FORMAT.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} WIB`;
}

export function attachmentLabel(ref: AttachmentRef): string {
  switch (ref.kind) {
    case 'chat_image':
      return `[image upload:${ref.id}]`;
    case 'note_image':
      return `[note image:${ref.id}]`;
    case 'note_file':
      return `[note file:${ref.id}]`;
  }
}

const BLOCK_TAG = /<(\/?)(chat_history|reply_to|message|project)>/gi;

/** A message cannot close or open one of our blocks: `<message>` in text becomes `‹message›`. */
function neutralize(text: string): string {
  return text.replace(BLOCK_TAG, (_match, slash: string, name: string) => `‹${slash}${name}›`);
}

/**
 * Phase 12: the first block of a project-scoped turn. It names the repo and says how to reach its
 * sessions (phase 7's tools). The key is validated at the route; it is neutralized here as well.
 */
export function renderProjectBlock(project: string): string {
  const repo = neutralize(project);
  return [
    '<project>',
    `repo: ${repo}`,
    `The owner is asking from the page of the repository "${repo}" in the wall's Projects view. Their questions are about the Claude Code sessions run in that repository: find them with sessions_search restricted to repo "${repo}", read one with session_get before you describe it, and quote each session by its node id (like A0-3G).`,
    '</project>',
  ].join('\n');
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)} [cut]`;
}

/** `[msg:ID] role (YYYY-MM-DD HH:mm WIB): text [image upload:X] ...`. `cap` null: never cut. */
export function renderMessageLine(message: ContextMessage, cap: number | null = CONTEXT_LINE_CHAR_CAP): string {
  const body = neutralize(cap === null ? message.text : clip(message.text, cap));
  const tail = [body, ...message.attachments.map(attachmentLabel)].filter((part) => part !== '').join(' ');
  return `[msg:${message.id}] ${message.role} (${formatWib(message.createdAt)}): ${tail}`;
}

function chatImages(message: ContextMessage): Array<{ id: string; messageId: string }> {
  return message.attachments
    .filter((ref) => ref.kind === 'chat_image')
    .map((ref) => ({ id: ref.id, messageId: message.id }));
}

export function buildTurnContext(input: TurnContextInput): TurnContext {
  const budget = input.budgetChars ?? CONTEXT_CHAR_BUDGET;
  const lines = input.history.map((message) => renderMessageLine(message));
  const kept: string[] = [];
  const keptIds = new Set<string>();
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    const cost = line.length + 1;
    if (used + cost > budget) break;
    kept.unshift(line);
    keptIds.add((input.history[i] as ContextMessage).id);
    used += cost;
  }
  const omitted = lines.length - kept.length;

  const sections: string[] = [];
  const project = input.project ?? null;
  if (project !== null && project !== '') sections.push(renderProjectBlock(project));
  if (lines.length > 0) {
    sections.push(['<chat_history>', ...(omitted > 0 ? [OMITTED_LINE] : []), ...kept, '</chat_history>'].join('\n'));
  }
  const target = input.replyTarget;
  if (target !== null) {
    const body = keptIds.has(target.id)
      ? `The owner is replying to [msg:${target.id}] above.`
      : renderMessageLine(target);
    sections.push(['<reply_to>', body, '</reply_to>'].join('\n'));
  }
  sections.push(['<message>', renderMessageLine(input.current, null), '</message>'].join('\n'));

  const images: Array<{ id: string; messageId: string }> = [];
  const seen = new Set<string>();
  for (const image of [...chatImages(input.current), ...(target !== null ? chatImages(target) : [])]) {
    if (seen.has(image.id)) continue;
    seen.add(image.id);
    images.push(image);
  }
  return { text: sections.join('\n\n'), images, omitted };
}

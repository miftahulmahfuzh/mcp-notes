import type { ChatAttachment, ChatMessage } from '../types';

export const HISTORY_HEADING = 'History.';
export const HISTORY_HINT = 'Every wall chat and /n exchange, oldest at the top. Times are Jakarta time (UTC+7).';

/**
 * A message the history page shows before (or instead of) its server row: the user's question
 * right after send, the assistant reply while it streams, or an error bubble. `serverId` is set
 * from `accepted` / `done`; once the server list holds that id the local bubble is hidden and pruned.
 */
export interface LocalBubble {
  key: string;
  role: 'user' | 'assistant';
  serverId: string | null;
  threadId: string | null;
  text: string;
  createdAt: string;
  attachments: ChatAttachment[];
  streaming: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  brain: string | null;
  /** Shown instead of (or after) the text: 'Chat failed: …' on the reply, 'not sent' on a question that never reached the server. */
  error: string | null;
}

/** One row of the page. `local` is null for a server message. */
export interface TimelineItem {
  key: string;
  msg: ChatMessage;
  local: LocalBubble | null;
}

/** ms since epoch; an unparseable time sorts first. */
export function timeOf(m: Pick<ChatMessage, 'created_at'>): number {
  const t = Date.parse(m.created_at);
  return Number.isFinite(t) ? t : 0;
}

const roleRank = (m: ChatMessage): number => (m.role === 'user' ? 0 : 1);

/** Ascending time; same instant: question before answer, then id. */
export function sortMessages(ms: ChatMessage[]): ChatMessage[] {
  return ms.slice().sort((a, b) => timeOf(a) - timeOf(b) || roleRank(a) - roleRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Oldest `created_at` in a page, as ms; +Infinity for an empty page. */
export function oldestMs(ms: ChatMessage[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const m of ms) min = Math.min(min, timeOf(m));
  return min;
}

/**
 * Merge a fetched page into what is loaded, by id (the fetched copy wins). `authoritativeFrom`
 * (ms) says the page is the complete truth for everything newer than that instant: loaded messages
 * newer than it that the page lacks were deleted and are dropped. `-Infinity` = the page is the
 * whole history; null = an older page, nothing is dropped.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[], authoritativeFrom: number | null): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) {
    if (authoritativeFrom !== null && timeOf(m) > authoritativeFrom) continue;
    byId.set(m.id, m);
  }
  for (const m of incoming) byId.set(m.id, m);
  return sortMessages([...byId.values()]);
}

/** A local bubble as a wire message, so one component renders both. */
export function localToMessage(l: LocalBubble): ChatMessage {
  return {
    id: l.serverId ?? '',
    thread_id: l.threadId ?? '',
    role: l.role,
    text: l.text,
    source: 'wall',
    brain: l.brain,
    reply_to: null,
    created_at: l.createdAt,
    edited_at: null,
    deleted_at: null,
    attachments: l.attachments,
  };
}

/** Server messages in order, then the local bubbles the server does not hold yet. */
export function timelineOf(server: ChatMessage[], local: LocalBubble[]): TimelineItem[] {
  const ids = new Set(server.map((m) => m.id));
  const items: TimelineItem[] = server.map((m) => ({ key: m.id, msg: m, local: null }));
  for (const l of local) {
    if (l.serverId !== null && ids.has(l.serverId)) continue;
    items.push({ key: l.key, msg: localToMessage(l), local: l });
  }
  return items;
}

/** Drop local bubbles whose server row has arrived (never one still streaming). */
export function pruneLocal(local: LocalBubble[], server: ChatMessage[]): LocalBubble[] {
  const ids = new Set(server.map((m) => m.id));
  const kept = local.filter((l) => l.streaming || l.serverId === null || !ids.has(l.serverId));
  return kept.length === local.length ? local : kept;
}

/**
 * Decision "which thread a history-page message joins": the newest live message of the timeline
 * decides. A wall message → continue its thread; a claude_code message (or nothing) → new thread.
 * Error-only local bubbles and deleted messages do not count.
 */
export function threadForSend(items: TimelineItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.local?.error) continue;
    if (it.msg.deleted_at) continue;
    return it.msg.source === 'wall' && it.msg.thread_id ? it.msg.thread_id : undefined;
  }
  return undefined;
}

/** Header count line on the history page. */
export function historyCountLine(items: TimelineItem[], hasMore: boolean): string {
  // Phase 10 keeps deleted rows loaded for "Show deleted"; the header counts live messages only.
  const shown = items.filter((i) => !i.local?.error && !i.msg.deleted_at);
  const threads = new Set(shown.map((i) => i.msg.thread_id).filter((t) => t !== '')).size;
  const lead = hasMore ? `Latest ${shown.length} messages` : `${shown.length} messages`;
  return `${lead} in ${threads} threads.`;
}

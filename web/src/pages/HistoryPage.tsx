import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bubble, type BubbleProps } from '../components/Bubble';
import { ChatBar } from '../components/ChatBar';
import { HistoryTools } from '../components/HistoryTools';
import { Lightbox, type LightboxItem } from '../components/Lightbox';
import { MessageItem } from '../components/MessageItem';
import { ReplyChip } from '../components/ReplyChip';
import { useChatImages } from '../hooks/useChatImages';
import { useHistoryActions } from '../hooks/useHistoryActions';
import type { UndoEntry } from '../hooks/useUndo';
import { chatTime } from '../lib/chatTime';
import type { TimelineItem } from '../lib/timeline';
import type { HistoryStore } from '../hooks/useHistory';
import type { ChatMessage } from '../types';
import './HistoryPage.css';

/** Within this many px of the bottom counts as "at the bottom": new messages keep the page pinned there. */
const STICK_PX = 80;
/** Scrolling within this many px of the top pages older messages. */
const OLDER_PX = 240;
/** Older pages fetched at most while looking for the `?thread=` target. */
const FOCUS_PAGES = 5;
const FLASH_MS = 2400;

export interface HistoryPageProps {
  store: HistoryStore;
  /** `/history?thread=ID`: scroll to that thread and outline it once it is loaded. */
  focusThread: string | null;
  now: Date;
  /**
   * App's single undo store (one UndoBar on screen): bubble deletes push their restore here. App
   * always passes it; optional only so P9's `HistoryPage.test.tsx` renders keep compiling (no undo bar there).
   */
  pushUndo?: (entry: UndoEntry) => void;
  /**
   * A note image to attach to the composer ("chat about this image" in the photo modal): referenced
   * by id, never uploaded. `nonce` makes attaching the same image twice a second event.
   */
  seedImage?: { imageId: string; nonce: number } | null;
  /** The composer's placeholder (phase 12's project chat names the repo). Default: ChatBar's. */
  placeholder?: string;
}

const NO_UNDO = (): void => {};

/**
 * The page's composer: Phase 3's `ChatBar` in its `page` variant (laid out here, sticky at the
 * bottom of the column; it does not publish --chatbar-h), with its own draft and its own
 * `useChatImages()` instance, so the wall bar's draft and pasted images are untouched by a visit.
 * The draft lives as long as the page is shown.
 */
function HistoryComposer({
  store,
  replyTo,
  onCancelReply,
  seedImage = null,
  placeholder,
}: {
  store: HistoryStore;
  seedImage?: { imageId: string; nonce: number } | null;
  /** Phase 10: the bubble being replied to (the chip above the bar), or null. */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  placeholder?: string;
}) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const { addNote } = images;
  const seedNonce = seedImage?.nonce;
  const seedId = seedImage?.imageId;
  useEffect(() => {
    if (seedId !== undefined) addNote(seedId);
  }, [seedId, seedNonce, addNote]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // An image still uploading (or failed and not removed) holds the message back, as on the wall.
    if (images.blocked) return;
    const ids = images.readyIds;
    const noteIds = images.noteIds;
    if (!draft.trim() && ids.length === 0 && noteIds.length === 0) return;
    // Two arguments when not replying: P9's callers and tests see the call they always saw.
    const sent =
      noteIds.length > 0
        ? store.send(draft, ids, replyTo ?? undefined, noteIds)
        : replyTo
          ? store.send(draft, ids, replyTo)
          : store.send(draft, ids);
    if (sent) {
      setDraft('');
      images.clear();
      onCancelReply();
    }
  };
  return (
    <div className="hist-composer">
      {replyTo && <ReplyChip target={replyTo} onCancel={onCancelReply} />}
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={placeholder}
      />
    </div>
  );
}

function ThreadDivider({ item, now }: { item: TimelineItem; now: Date }) {
  const label = item.msg.source === 'claude_code' ? 'claude code' : item.local && !item.msg.thread_id ? 'new thread' : 'wall chat';
  return (
    <li className="hist-divider" role="separator" data-thread-start={item.msg.thread_id || undefined}>
      <span>
        {label} · {chatTime(item.msg.created_at, now)}
      </span>
    </li>
  );
}

const atBottom = (): boolean => {
  const el = document.documentElement;
  return window.innerHeight + window.scrollY >= el.scrollHeight - STICK_PX;
};

const scrollToBottom = (): void => {
  window.scrollTo(0, document.documentElement.scrollHeight);
};

export function HistoryPage({ store, focusThread, now, pushUndo = NO_UNDO, seedImage = null, placeholder }: HistoryPageProps) {
  const { items, loaded, error, hasMore, loadingOlder, loadOlder } = store;
  const ha = useHistoryActions({ history: store, pushUndo });
  // Deleted server rows are loaded (App fetches include_deleted=1) and shown only with "Show deleted".
  const shown = useMemo(() => items.filter((it) => it.local !== null || ha.isShown(it.msg)), [items, ha.isShown]);
  const [box, setBox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const ready = useRef(false);
  const anchor = useRef<{ first: string | null; height: number }>({ first: null, height: 0 });
  const focus = useRef<{ thread: string | null; tries: number; done: boolean }>({ thread: null, tries: 0, done: true });
  const older = useRef(loadOlder);
  older.current = loadOlder;

  // Track "pinned to the bottom" and page older messages near the top.
  useEffect(() => {
    const onScroll = () => {
      stick.current = atBottom();
      if (ready.current && window.scrollY < OLDER_PX) void older.current();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A new ?thread= target (declared before the scroll effect so it is in place when that runs).
  useLayoutEffect(() => {
    focus.current = { thread: focusThread, tries: 0, done: focusThread === null };
  }, [focusThread]);

  // After each change of the list: keep the reading position when older messages were prepended,
  // follow new messages when pinned, or bring the focused thread into view once it is loaded.
  useLayoutEffect(() => {
    if (!loaded) return;
    const el = document.documentElement;
    const first = items[0]?.key ?? null;
    const prev = anchor.current;
    const prepended = prev.first !== null && first !== prev.first && items.some((it, i) => i > 0 && it.key === prev.first);
    const f = focus.current;
    if (!f.done && f.thread !== null) {
      let target = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]?.msg.thread_id === f.thread) {
          target = i;
          break;
        }
      }
      if (target >= 0) {
        f.done = true;
        const node = listRef.current?.querySelector<HTMLElement>(`[data-msg-key="${items[target]?.key ?? ''}"]`);
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
        stick.current = target === items.length - 1;
        setFlash(f.thread);
      } else if (hasMore && f.tries < FOCUS_PAGES) {
        f.tries += 1;
        void older.current();
      } else {
        f.done = true;
        scrollToBottom();
      }
    } else if (prepended) {
      window.scrollTo(0, window.scrollY + (el.scrollHeight - prev.height));
    } else if (stick.current) {
      scrollToBottom();
    }
    anchor.current = { first, height: el.scrollHeight };
    ready.current = true;
  }, [items, loaded, hasMore]);

  useEffect(() => {
    if (flash === null) return;
    const t = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flash]);

  return (
    <section className="history" aria-label="Chat history">
      <HistoryTools showDeleted={ha.showDeleted} onToggleDeleted={ha.toggleShowDeleted} notice={ha.notice} />
      {hasMore && (
        <button type="button" className="hist-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? 'Loading earlier messages' : 'Earlier messages'}
        </button>
      )}
      {error && (
        <p className="hist-note" role="status">
          Could not load the chat history: {error}
        </p>
      )}
      {!loaded && <p className="hist-note">Loading…</p>}
      {loaded && items.length === 0 && !error && <p className="hist-note">No chats yet. Ask something below.</p>}
      <ol className="hist-list" ref={listRef}>
        {shown.map((it, i) => {
          const prev = i > 0 ? shown[i - 1] : undefined;
          const divider = prev === undefined || prev.msg.thread_id !== it.msg.thread_id;
          const bubble: BubbleProps = {
            item: it,
            now,
            focused: flash !== null && it.msg.thread_id === flash,
            onOpenImages: (lbItems, index) => setBox({ items: lbItems, index }),
          };
          return (
            <Fragment key={it.key}>
              {divider && <ThreadDivider item={it} now={now} />}
              {/* Server rows get the phase 10 actions; local (sending / streaming / failed) bubbles stay plain. */}
              {it.local === null ? <MessageItem {...ha.itemProps(it.msg)} bubble={bubble} /> : <Bubble {...bubble} />}
            </Fragment>
          );
        })}
      </ol>
      <HistoryComposer store={store} replyTo={ha.replyTo} onCancelReply={ha.cancelReply} seedImage={seedImage} placeholder={placeholder} />
      {box && (
        <Lightbox
          items={box.items}
          index={box.index}
          onIndex={(index) => setBox((b) => (b ? { ...b, index } : b))}
          onClose={() => setBox(null)}
        />
      )}
    </section>
  );
}

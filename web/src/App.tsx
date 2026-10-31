import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconContext } from '@phosphor-icons/react';
import { ApiError, attachRouted, createNote, deleteNote, DuplicateFileError, DuplicateImageError, fetchBin, fetchImageInfo, fetchNote, removeFile, removeImage, restoreFile, restoreImage, restoreNote, updateNote, type AttachResult } from './api';
import type { Mode, Note, NoteFile, NoteImage as NoteImageData, View } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useChatImages } from './hooks/useChatImages';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { useNotice } from './hooks/useNotice';
import { useUndo } from './hooks/useUndo';
import { useBin } from './hooks/useBin';
import { useDeepLink } from './hooks/useDeepLink';
import { useHistory } from './hooks/useHistory';
import { normalizeNoteId, noteHref } from './lib/deepLink';
import { hrefForView, routeFromLocation } from './lib/route';
import { HISTORY_HEADING, historyCountLine } from './lib/timeline';
import { HistoryPage } from './pages/HistoryPage';
import { BIN_HEADING, binCountLine, countLineFor, headingFor, imageCount, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
import { extractUsedIds } from './lib/usedIds';
import { relativeDate } from './lib/dates';
import { tagsOf } from './lib/text';
import { binNoteSelector, flashSelector, noteSelector, type FlashOptions } from './lib/flash';
import { planReveal, tagsKeeping } from './lib/reveal';
import { hasAttachments, routeFiles } from './lib/files';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Wall } from './components/Wall';
import { AnswerPanel } from './components/AnswerPanel';
import { ChatBar } from './components/ChatBar';
import { Tooltip } from './components/Tooltip';
import { NoteLinkContext, type NoteLinks } from './components/ChatText';
import { Gallery } from './components/Gallery';
import { DropOverlay } from './components/DropOverlay';
import { NoteEditor } from './components/NoteEditor';
import { Lightbox, noteImageItems, type LightboxItem } from './components/Lightbox';
import { Bin } from './components/Bin';
import { UndoBar } from './components/UndoBar';
import { LinkNotice } from './components/LinkNotice';

const ICONS = { weight: 'duotone' as const, size: '1em', color: 'currentColor', mirrored: false };

/** Deep-link flash: after the view/mode switch renders; wait for a card that needs a fetch or the bin to load. */
const LINK_FLASH: FlashOptions = { delayMs: 60, waitMs: 3000 };

function scrollToNote(id: string): void {
  const el = document.querySelector(`[data-note="${id}"]`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' });
}

export function App() {
  const { notes, tags, loaded, refetch, upsertLocal, removeLocal } = useNotes();
  const now = useNow();
  const chat = useChat();
  const chatImages = useChatImages();
  const { copied, copy } = useCopied();

  const [side, setSide] = useState(false);
  const [mode, setMode] = useState<Mode>('text');
  const [active, setActive] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { notice, show: showNotice } = useNotice();
  // `/history[?thread=ID]` opens straight into the chat history page (served by the SPA fallback).
  const [view, setView] = useState<View>(() => (routeFromLocation(window.location).history ? 'history' : 'wall'));
  const [historyThread, setHistoryThread] = useState<string | null>(() => routeFromLocation(window.location).thread);
  // Lives in App so a reply keeps streaming while the user is on the wall; fetches only while shown.
  // Deleted rows are loaded too: the page's "Show deleted" toggle (phase 10) filters on the client.
  const history = useHistory(view === 'history', { includeDeleted: true });
  const { entry: undoEntry, push: pushUndo, undo: runUndo } = useUndo();
  const binStore = useBin(active, view === 'bin');
  // Deep link (?note=<id> / #<id>): its own quiet notice (App's other notice is shown in the big
  // editor), a way to close the big editor through its normal path, and the newest-link guard.
  const { notice: linkNotice, show: showLinkNotice } = useNotice(6000);
  const [closeSignal, setCloseSignal] = useState(0);
  /** The lightbox opened by an image id in chat text (note ids open the editor instead). */
  const [viewer, setViewer] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const linkSeq = useRef(0);
  const cancelFlash = useRef<() => void>(() => {});

  // Synchronous mirrors for event handlers that run before React re-renders.
  const expandedRef = useRef<string | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const wallRef = useRef({ view, mode, active, editing, expanded });
  wallRef.current = { view, mode, active, editing, expanded };

  const visible = useMemo(() => visibleOnWall(notes, mode, active, [editing, expanded]), [notes, mode, active, editing, expanded]);
  // The big editor's note. A note opened from a chat link may lie past the wall's 2000-note page:
  // the next refetch drops it from the store, and the editor keeps its last version instead of
  // unmounting mid-edit (phase 11). Closing or deleting clears `expanded`, so this never revives one.
  const lastExpanded = useRef<Note | null>(null);
  const expandedNote = useMemo(() => {
    if (!expanded) return null;
    const live = notes.find((n) => n.id === expanded);
    if (live) return live;
    const last = lastExpanded.current;
    return last !== null && last.id === expanded ? last : null;
  }, [notes, expanded]);
  lastExpanded.current = expandedNote;
  const photos = useMemo(() => photosOf(notes, active), [notes, active]);
  const photoCount = useMemo(() => imageCount(notes), [notes]);
  const last = useMemo(() => lastEdited(notes), [notes]);
  const used = useMemo(() => extractUsedIds(chat.text, notes.map((n) => n.id)), [chat.text, notes]);
  const highlight = chat.open && chat.text.length > 0 && used.length > 0;
  const usedSet = useMemo(() => (highlight ? new Set(used) : null), [highlight, used]);

  const mainLeft = side ? 296 : 56;
  const chatLeft = mainLeft + 16;

  const toggleTag = useCallback((t: string) => {
    setActive((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
  }, []);

  const jump = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id);
      const plan = planReveal(note, { view, mode, active, keep: [] });
      if (plan.view !== view) setView(plan.view);
      if (plan.mode !== mode) setMode(plan.mode);
      if (plan.changed) window.setTimeout(() => scrollToNote(id), 50);
      else scrollToNote(id);
    },
    [notes, mode, view, active],
  );

  const addNote = useCallback(async () => {
    try {
      const n = await createNote('');
      upsertLocal(n, true);
      setEditing(n.id);
      setView('wall');
      setMode((m) => (m === 'images' ? 'text' : m));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.error('create note failed', e);
    } finally {
      refetch();
    }
  }, [upsertLocal, refetch]);

  const save = useCallback(
    async (note: Note, draft: string) => {
      if (draft === note.body) return;
      upsertLocal({ ...note, body: draft, tags: tagsOf(draft), updated_at: new Date().toISOString() });
      try {
        upsertLocal(await updateNote(note.id, draft));
      } catch (e) {
        console.error('update note failed', e);
      } finally {
        refetch();
      }
    },
    [upsertLocal, refetch],
  );

  const commit = useCallback(
    async (note: Note, draft: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      // The big editor owns this note now (expand unmounts the inline editor); it applies the rules on close.
      if (expandedRef.current === note.id) return;
      // Empty = no text, no images and no files (R2): a note holding only files is kept.
      if (!draft.trim() && !hasAttachments(note)) {
        removeLocal(note.id);
        try {
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
        return;
      }
      await save(note, draft);
    },
    [removeLocal, refetch, save],
  );

  const onImageAdded = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      setMode((m) => (m === 'text' ? 'all' : m));
      setView('wall');
      refetch();
    },
    [upsertLocal, refetch],
  );

  /** Expand icon on a card. `draft` = unsaved inline text (card was being edited), saved first, never deleted. */
  const expand = useCallback(
    (note: Note, draft: string | null) => {
      expandedRef.current = note.id;
      setExpanded(note.id);
      setEditing((cur) => (cur === note.id ? null : cur));
      if (draft !== null) void save(note, draft);
    },
    [save],
  );

  /** Big editor closed (X, backdrop, Esc). The empty rule (no text, images or files) applies only here; Notes. -> Everything. when it now has images. */
  const closeEditor = useCallback(
    async (note: Note, draft: string, dirty: boolean) => {
      expandedRef.current = null;
      setExpanded(null);
      const latest = notesRef.current.find((n) => n.id === note.id) ?? note;
      if (!draft.trim() && !hasAttachments(latest)) {
        removeLocal(note.id);
        try {
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
        return;
      }
      if (latest.images.length > 0) setMode((m) => (m === 'text' ? 'all' : m));
      if (dirty) await save(latest, draft);
    },
    [removeLocal, refetch, save],
  );

  /** A drop/paste while the editor is open. A dedupe hit says so quietly; the holder (maybe restored) joins the store. */
  const onAttached = useCallback(
    (result: AttachResult) => {
      upsertLocal(result.note, true);
      if (!result.attached) showNotice(`already in ${result.note.id}`);
      refetch();
    },
    [upsertLocal, refetch, showNotice],
  );

  /** An attach to the open note failed (413, 415, 409 race, offline). Said quietly in the editor; nothing else changes. */
  const onAttachFailed = useCallback(
    (file: File, err: unknown) => {
      if (err instanceof DuplicateFileError || err instanceof DuplicateImageError) {
        showNotice(`already in ${err.noteId}`);
        return;
      }
      const why = err instanceof ApiError && err.status === 413 ? ' (too large)' : '';
      showNotice(`could not attach ${file.name || 'file'}${why}`);
    },
    [showNotice],
  );

  // The paperclip picker's own serial queue (DropOverlay keeps one for drop/paste): one upload at a time, in pick order.
  const attachQueue = useRef<Promise<void>>(Promise.resolve());

  /** Files picked in the big editor: images to /images, everything else to /files (lib/files routeFiles). */
  const attachFiles = useCallback(
    (noteId: string, files: File[]) => {
      for (const job of routeFiles(files)) {
        attachQueue.current = attachQueue.current.then(async () => {
          try {
            onAttached(await attachRouted(noteId, job));
          } catch (err) {
            console.error('[attach]', job.file.name, err);
            onAttachFailed(job.file, err);
          }
        });
      }
    },
    [onAttached, onAttachFailed],
  );

  const toggleBin = useCallback(() => setView((v) => (v === 'bin' ? 'wall' : 'bin')), []);

  /** Rail / sidebar chat-history icon: open the page (no thread focus); a second press returns to the wall. */
  const toggleHistory = useCallback(() => {
    setHistoryThread(null);
    setView((v) => (v === 'history' ? 'wall' : 'history'));
  }, []);

  /** Answer panel "Chat in full screen": the history page on this conversation's thread. */
  const openHistoryThread = useCallback(() => {
    setHistoryThread(chat.threadId);
    setView('history');
  }, [chat.threadId]);

  // The address bar follows the view (pathname guard, lib/route.ts hrefForView): entering the
  // history page pushes /history[?thread=]; leaving it pushes / only when the path is /history.
  // Wall and bin never rewrite a non-history URL, so /?note=ID survives a switch to the wall
  // (Phase 11's show-on-wall relies on this). This is the one URL-sync owner; no other phase adds one.
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread]);

  // Back / forward between /history and the wall. A /?note= target is handled by useDeepLink's own
  // popstate listener (planReveal moves the view to the wall).
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      setHistoryThread(r.thread);
      setView((v) => (r.history ? 'history' : v === 'history' ? 'wall' : v));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const pickMode = useCallback((m: Mode) => {
    setMode(m);
    setView('wall');
  }, []);

  /** Soft delete from a card, the editor (with its draft) or the photo modal. No confirmation; 6 s undo. */
  const removeNote = useCallback(
    (note: Note, draft?: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      if (expandedRef.current === note.id) expandedRef.current = null;
      setExpanded((cur) => (cur === note.id ? null : cur));
      removeLocal(note.id);
      const done = (async () => {
        try {
          if (draft !== undefined && draft !== note.body) await updateNote(note.id, draft);
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: `deleted ${note.id}`,
        run: async () => {
          await done;
          upsertLocal(await restoreNote(note.id), true);
          refetch();
        },
      });
    },
    [removeLocal, upsertLocal, refetch, pushUndo],
  );

  /** The editor strip's remove icon (phase 7): soft remove one image, 6 s undo puts it back at its old position. */
  const removeImageWithUndo = useCallback(
    (image: NoteImageData) => {
      const owner = notesRef.current.find((n) => n.id === image.note_id);
      if (owner) upsertLocal({ ...owner, images: owner.images.filter((i) => i.id !== image.id) });
      const done = (async () => {
        try {
          upsertLocal(await removeImage(image.id));
        } catch (e) {
          console.error('remove image failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: 'removed image',
        run: async () => {
          await done;
          try {
            upsertLocal(await restoreImage(image.id));
          } catch (e) {
            if (e instanceof DuplicateImageError) console.warn(`image already in ${e.noteId}`);
            else throw e;
          } finally {
            refetch();
          }
        },
      });
    },
    [upsertLocal, refetch, pushUndo],
  );

  /** A file chip's remove icon (R2): soft remove one file, 6 s undo puts it back. Mirrors removeImageWithUndo. */
  const removeFileWithUndo = useCallback(
    (file: NoteFile) => {
      const owner = notesRef.current.find((n) => n.id === file.note_id);
      if (owner) upsertLocal({ ...owner, files: (owner.files ?? []).filter((f) => f.id !== file.id) });
      const done = (async () => {
        try {
          upsertLocal(await removeFile(file.id));
        } catch (e) {
          console.error('remove file failed', e);
        } finally {
          refetch();
        }
      })();
      pushUndo({
        label: 'removed file',
        run: async () => {
          await done;
          try {
            upsertLocal(await restoreFile(file.id));
          } catch (e) {
            if (e instanceof DuplicateFileError) console.warn(`file already in ${e.noteId}`);
            else throw e;
          } finally {
            refetch();
          }
        },
      });
    },
    [upsertLocal, refetch, pushUndo],
  );

  /** A note restored from the bin goes back on the wall at once; the refetch puts it in its place. */
  const onRestored = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      refetch();
    },
    [upsertLocal, refetch],
  );

  /** Put a live note on screen for a deep link, then scroll to and outline its card. */
  const revealLinked = useCallback((note: Note) => {
    const s = wallRef.current;
    if (s.expanded !== null && s.expanded !== note.id) setCloseSignal((n) => n + 1);
    const keep = [s.editing, s.expanded === note.id ? note.id : null];
    const plan = planReveal(note, { view: s.view, mode: s.mode, active: s.active, keep }, { tags: true });
    if (plan.view !== s.view) setView(plan.view);
    if (plan.mode !== s.mode) setMode(plan.mode);
    if (plan.active !== s.active) setActive(plan.active);
    cancelFlash.current();
    cancelFlash.current = flashSelector(noteSelector(note.id), LINK_FLASH);
  }, []);

  /**
   * ?note=<id> / #<id>: a loaded note is revealed; else GET /api/notes/:id (past the 2000-note page);
   * a 404 that the bin holds opens the bin on its card; else a quiet "no note <id>". Only the newest
   * link acts (a second link while one is still fetching wins).
   */
  const openLinked = useCallback(
    async (id: string) => {
      const seq = ++linkSeq.current;
      const stale = () => seq !== linkSeq.current;
      const known = notesRef.current.find((n) => n.id === id);
      if (known) {
        revealLinked(known);
        return;
      }
      let note: Note | null;
      try {
        note = await fetchNote(id);
      } catch (e) {
        if (stale()) return;
        console.error('deep link: fetch note failed', e);
        showLinkNotice(`could not open ${id}`);
        return;
      }
      if (stale()) return;
      if (note) {
        upsertLocal(note);
        revealLinked(note);
        return;
      }
      let deleted: Note | undefined;
      try {
        deleted = (await fetchBin()).notes.find((n) => n.id === id);
      } catch (e) {
        console.error('deep link: bin lookup failed', e);
      }
      if (stale()) return;
      if (deleted) {
        const binNote = deleted;
        if (wallRef.current.expanded !== null) setCloseSignal((n) => n + 1);
        setActive((a) => tagsKeeping(binNote, a));
        setView('bin');
        cancelFlash.current();
        cancelFlash.current = flashSelector(binNoteSelector(id), LINK_FLASH);
        showLinkNotice(`${id} is deleted. Restore it from the bin.`);
        return;
      }
      showLinkNotice(`no note ${id}`);
    },
    [revealLinked, upsertLocal, showLinkNotice],
  );

  useDeepLink(loaded, (id) => {
    void openLinked(id);
  });

  // Note links in chat text (phase 11): open the big editor over whatever page is showing.
  const modalSeq = useRef(0);
  /** A link clicked while another note's editor is open: opened once that editor has closed. */
  const pendingModal = useRef<string | null>(null);

  /**
   * A note id clicked in chat text. A loaded note opens at once (`expand`, no draft); else
   * GET /api/notes/:id and upsert; an image id opens the lightbox on it; a 404 the bin holds or an unknown id gets
   * the deep link's quiet notice. Never changes the view, the URL or the scroll position. Only the newest click acts.
   */
  const openNoteModal = useCallback(
    async (raw: string) => {
      const id = normalizeNoteId(raw);
      if (id === null) return;
      const seq = ++modalSeq.current;
      const stale = () => seq !== modalSeq.current;
      const open = (note: Note) => {
        const cur = expandedRef.current;
        if (cur === note.id) return;
        if (cur !== null) {
          // Close the open editor the normal way (draft saved, empty rule) before swapping notes.
          pendingModal.current = note.id;
          setCloseSignal((n) => n + 1);
          return;
        }
        expand(note, null);
      };
      const known = notesRef.current.find((n) => n.id === id);
      if (known) {
        open(known);
        return;
      }
      let note: Note | null;
      try {
        note = await fetchNote(id);
      } catch (e) {
        if (stale()) return;
        console.error('note link: fetch note failed', e);
        showLinkNotice(`could not open ${id}`);
        return;
      }
      if (stale()) return;
      if (note) {
        upsertLocal(note);
        open(note);
        return;
      }
      let deleted = false;
      try {
        deleted = (await fetchBin()).notes.some((n) => n.id === id);
      } catch (e) {
        console.error('note link: bin lookup failed', e);
      }
      if (stale()) return;
      if (deleted) {
        showLinkNotice(`${id} is deleted. Restore it from the bin.`);
        return;
      }
      // Image ids look like note ids, and the model quotes them ("image 5-RI4 in note B-SMK"):
      // an image id opens that image in the lightbox, with the arrows walking its note's other images.
      let info: NoteImageData | null = null;
      try {
        info = await fetchImageInfo(id);
      } catch (e) {
        console.error('note link: image lookup failed', e);
      }
      if (stale()) return;
      if (info) {
        let images: NoteImageData[] = [info];
        try {
          const owner = await fetchNote(info.note_id);
          if (owner?.images.some((img) => img.id === info.id)) images = owner.images;
        } catch (e) {
          console.error('note link: owner lookup failed', e);
        }
        if (stale()) return;
        const items = noteImageItems(images);
        const at = items.findIndex((it) => it.id === info.id);
        if (at < 0) {
          showLinkNotice(`image ${id} is not on this machine`);
          return;
        }
        setViewer({ items, index: at });
        return;
      }
      showLinkNotice(`no note ${id}`);
    },
    [expand, upsertLocal, showLinkNotice],
  );

  useEffect(() => {
    if (expanded !== null) return;
    const id = pendingModal.current;
    if (id === null) return;
    pendingModal.current = null;
    const note = notesRef.current.find((n) => n.id === id);
    if (note) expand(note, null);
  }, [expanded, expand]);

  /**
   * The editor's "Show on wall" icon. The editor has already closed itself (closeEditor ran), but
   * the wall mirror still says it is open until the next render. Without the reset, revealLinked
   * would treat the note as kept by the editor and skip the tag/mode reveal. Then push the wall
   * URL (a pushState fires no popstate, so the deep link is acted on here, not by useDeepLink;
   * Back and Forward later fire popstate, which useDeepLink and P9's view sync already follow) and
   * reveal: planReveal switches history/bin to the wall, fixes mode and tags, and flashes the card.
   */
  const showOnWall = useCallback(
    (note: Note) => {
      wallRef.current = { ...wallRef.current, expanded: null };
      pendingModal.current = null;
      const href = noteHref(note.id);
      const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (here !== href) window.history.pushState(null, '', href);
      void openLinked(note.id);
    },
    [openLinked],
  );

  const knownIds = useMemo(() => new Set(notes.map((n) => n.id.toUpperCase())), [notes]);
  const noteLinks = useMemo<NoteLinks>(
    () => ({
      isKnown: (id: string) => knownIds.has(id.toUpperCase()),
      open: (id: string) => {
        void openNoteModal(id);
      },
    }),
    [knownIds, openNoteModal],
  );

  useEffect(() => () => cancelFlash.current(), []);

  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // An image still uploading (or failed and not yet removed) holds the message back.
    if (chatImages.blocked) return;
    const imageIds = chatImages.readyIds;
    if (!q.trim() && imageIds.length === 0) return;
    setMode((m) => (m === 'images' ? 'all' : m));
    void chat.ask(q, imageIds);
    setQ('');
    chatImages.clear();
  };

  const { open: chatOpen, pinned, close: closeChat } = chat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // The answer panel is hidden on the history page; Esc there must not end the wall conversation.
      if (e.key === 'Escape' && chatOpen && !pinned && view !== 'history') closeChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatOpen, pinned, closeChat, view]);

  return (
    <IconContext.Provider value={ICONS}>
      <NoteLinkContext.Provider value={noteLinks}>
        <div className="app">
          <Rail
            mode={mode}
            view={view}
            active={active}
            onToggleSide={() => setSide((s) => !s)}
            onAdd={() => void addNote()}
            onCycleMode={() => {
              setMode(nextMode);
              setView('wall');
            }}
            onToggleHistory={toggleHistory}
            onToggleBin={toggleBin}
            onToggleTag={toggleTag}
            onClear={() => setActive([])}
          />
          {side && (
            <Sidebar
              mode={mode}
              view={view}
              photoCount={photoCount}
              tags={tags}
              active={active}
              onMode={pickMode}
              onToggleHistory={toggleHistory}
              onToggleBin={toggleBin}
              onToggleTag={toggleTag}
            />
          )}
          <main className="main" style={{ marginLeft: mainLeft }}>
            <Header
              heading={view === 'history' ? HISTORY_HEADING : view === 'bin' ? BIN_HEADING : headingFor(mode, active)}
              countLine={
                view === 'history'
                  ? historyCountLine(history.items, history.hasMore)
                  : view === 'bin'
                    ? binCountLine(binStore.bin, active)
                    : countLineFor(mode, active, notes, visible, photos)
              }
              last={last}
              lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
              showSticker={view === 'wall' && mode !== 'images'}
              bin={view === 'bin'}
              history={view === 'history'}
              onJumpLast={() => last && jump(last.id)}
              onAdd={() => void addNote()}
            />
            <div className="rule" />
            {view === 'history' ? (
              <HistoryPage store={history} focusThread={historyThread} now={now} pushUndo={pushUndo} />
            ) : view === 'bin' ? (
              <Bin store={binStore} now={now} onRestored={onRestored} />
            ) : mode === 'images' ? (
              <Gallery items={photos} copiedId={copied} onCopy={copy} onDelete={removeNote} />
            ) : (
              <Wall
                notes={visible}
                now={now}
                editingId={editing}
                usedIds={usedSet}
                copiedId={copied}
                onCopy={copy}
                onEdit={setEditing}
                onCommit={commit}
                onDelete={removeNote}
                onToggleTag={toggleTag}
                onExpand={expand}
              />
            )}
          </main>
          {chat.open && view !== 'history' && (
            <AnswerPanel
              left={chatLeft}
              query={chat.query}
              images={chat.images}
              text={chat.text}
              done={chat.done}
              status={chat.status}
              brain={chat.brain}
              pinned={chat.pinned}
              collapsed={chat.collapsed}
              usedIds={used}
              onTogglePin={chat.togglePin}
              onToggleCollapse={chat.toggleCollapsed}
              onClose={chat.close}
              onJump={jump}
              onFullScreen={openHistoryThread}
            />
          )}
          {view !== 'history' && (
            <ChatBar
              left={chatLeft}
              value={q}
              onChange={setQ}
              onSubmit={send}
              images={chatImages.images}
              onPasteFiles={chatImages.add}
              onRemoveImage={chatImages.remove}
              sendBlocked={chatImages.blocked}
            />
          )}
          <DropOverlay onImageAdded={onImageAdded} target={expandedNote ? expandedNote.id : null} onAttached={onAttached} onAttachFailed={onAttachFailed} />
          {expandedNote &&
            createPortal(
              <NoteEditor
                key={expandedNote.id}
                note={expandedNote}
                copied={copied === expandedNote.id}
                notice={notice}
                onCopy={copy}
                onSave={save}
                onClose={closeEditor}
                onRemoveImage={removeImageWithUndo}
                onAttachFiles={(files) => attachFiles(expandedNote.id, files)}
                onRemoveFile={removeFileWithUndo}
                onShowOnWall={showOnWall}
                onDelete={removeNote}
                tags={tags}
                closeSignal={closeSignal}
              />,
              document.body,
            )}
          {viewer && (
            <Lightbox
              items={viewer.items}
              index={viewer.index}
              onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))}
              onClose={() => setViewer(null)}
            />
          )}
          <UndoBar entry={undoEntry} onUndo={runUndo} />
          <LinkNotice text={linkNotice} />
          <Tooltip />
        </div>
      </NoteLinkContext.Provider>
    </IconContext.Provider>
  );
}

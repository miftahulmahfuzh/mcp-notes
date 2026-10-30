import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconContext } from '@phosphor-icons/react';
import { createNote, deleteNote, DuplicateImageError, removeImage, restoreImage, restoreNote, updateNote, type AttachResult } from './api';
import type { Mode, Note, NoteImage as NoteImageData, View } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { useNotice } from './hooks/useNotice';
import { useUndo } from './hooks/useUndo';
import { useBin } from './hooks/useBin';
import { BIN_HEADING, binCountLine, countLineFor, headingFor, imageCount, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
import { extractUsedIds } from './lib/usedIds';
import { relativeDate } from './lib/dates';
import { tagsOf } from './lib/text';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Wall } from './components/Wall';
import { AnswerPanel } from './components/AnswerPanel';
import { ChatBar } from './components/ChatBar';
import { Tooltip } from './components/Tooltip';
import { Gallery } from './components/Gallery';
import { DropOverlay } from './components/DropOverlay';
import { NoteEditor } from './components/NoteEditor';
import { Bin } from './components/Bin';
import { UndoBar } from './components/UndoBar';

const ICONS = { weight: 'duotone' as const, size: '1em', color: 'currentColor', mirrored: false };

function scrollToNote(id: string): void {
  const el = document.querySelector(`[data-note="${id}"]`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' });
}

export function App() {
  const { notes, tags, refetch, upsertLocal, removeLocal } = useNotes();
  const now = useNow();
  const chat = useChat();
  const { copied, copy } = useCopied();

  const [side, setSide] = useState(false);
  const [mode, setMode] = useState<Mode>('text');
  const [active, setActive] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { notice, show: showNotice } = useNotice();
  const [view, setView] = useState<View>('wall');
  const { entry: undoEntry, push: pushUndo, undo: runUndo } = useUndo();
  const binStore = useBin(active, view === 'bin');

  // Synchronous mirrors for event handlers that run before React re-renders.
  const expandedRef = useRef<string | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const visible = useMemo(() => visibleOnWall(notes, mode, active, [editing, expanded]), [notes, mode, active, editing, expanded]);
  const expandedNote = useMemo(() => (expanded ? (notes.find((n) => n.id === expanded) ?? null) : null), [notes, expanded]);
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
      const leaving = view === 'bin';
      if (leaving) setView('wall');
      if (isHiddenByMode(note, mode)) {
        setMode('all');
        window.setTimeout(() => scrollToNote(id), 50);
      } else if (leaving) {
        window.setTimeout(() => scrollToNote(id), 50);
      } else {
        scrollToNote(id);
      }
    },
    [notes, mode, view],
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
      if (!draft.trim() && note.images.length === 0) {
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

  /** Big editor closed (X, backdrop, Esc). The empty rule applies only here; Notes. -> Everything. when it now has images. */
  const closeEditor = useCallback(
    async (note: Note, draft: string, dirty: boolean) => {
      expandedRef.current = null;
      setExpanded(null);
      const latest = notesRef.current.find((n) => n.id === note.id) ?? note;
      if (!draft.trim() && latest.images.length === 0) {
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

  const toggleBin = useCallback(() => setView((v) => (v === 'bin' ? 'wall' : 'bin')), []);

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

  /** A note restored from the bin goes back on the wall at once; the refetch puts it in its place. */
  const onRestored = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      refetch();
    },
    [upsertLocal, refetch],
  );

  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!q.trim()) return;
    setMode((m) => (m === 'images' ? 'all' : m));
    void chat.ask(q);
    setQ('');
  };

  const { open: chatOpen, pinned, close: closeChat } = chat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && chatOpen && !pinned) closeChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatOpen, pinned, closeChat]);

  return (
    <IconContext.Provider value={ICONS}>
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
            onToggleBin={toggleBin}
            onToggleTag={toggleTag}
          />
        )}
        <main className="main" style={{ marginLeft: mainLeft }}>
          <Header
            heading={view === 'bin' ? BIN_HEADING : headingFor(mode, active)}
            countLine={view === 'bin' ? binCountLine(binStore.bin, active) : countLineFor(mode, active, notes, visible, photos)}
            last={last}
            lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
            showSticker={view === 'wall' && mode !== 'images'}
            bin={view === 'bin'}
            onJumpLast={() => last && jump(last.id)}
            onAdd={() => void addNote()}
          />
          <div className="rule" />
          {view === 'bin' ? (
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
        {chat.open && (
          <AnswerPanel
            left={chatLeft}
            query={chat.query}
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
          />
        )}
        <ChatBar left={chatLeft} value={q} onChange={setQ} onSubmit={send} />
        <DropOverlay onImageAdded={onImageAdded} target={expandedNote ? expandedNote.id : null} onAttached={onAttached} />
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
              onDelete={removeNote}
              tags={tags}
            />,
            document.body,
          )}
        <UndoBar entry={undoEntry} onUndo={runUndo} />
        <Tooltip />
      </div>
    </IconContext.Provider>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { IconContext } from '@phosphor-icons/react';
import { createNote, deleteNote, updateNote } from './api';
import type { Mode, Note } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { countLineFor, headingFor, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
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
  const [q, setQ] = useState('');

  const visible = useMemo(() => visibleOnWall(notes, mode, active, editing), [notes, mode, active, editing]);
  const photos = useMemo(() => photosOf(notes, active), [notes, active]);
  const photoCount = useMemo(() => notes.filter((n) => n.image).length, [notes]);
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
      if (isHiddenByMode(note, mode)) {
        setMode('all');
        window.setTimeout(() => scrollToNote(id), 50);
      } else {
        scrollToNote(id);
      }
    },
    [notes, mode],
  );

  const addNote = useCallback(async () => {
    try {
      const n = await createNote('');
      upsertLocal(n, true);
      setEditing(n.id);
      setMode((m) => (m === 'images' ? 'text' : m));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.error('create note failed', e);
    } finally {
      refetch();
    }
  }, [upsertLocal, refetch]);

  const commit = useCallback(
    async (note: Note, draft: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      if (!draft.trim() && !note.image) {
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
    [removeLocal, upsertLocal, refetch],
  );

  const onImageAdded = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      setMode((m) => (m === 'text' ? 'all' : m));
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
          active={active}
          onToggleSide={() => setSide((s) => !s)}
          onAdd={() => void addNote()}
          onCycleMode={() => setMode(nextMode)}
          onToggleTag={toggleTag}
          onClear={() => setActive([])}
        />
        {side && (
          <Sidebar mode={mode} photoCount={photoCount} tags={tags} active={active} onMode={setMode} onToggleTag={toggleTag} />
        )}
        <main className="main" style={{ marginLeft: mainLeft }}>
          <Header
            heading={headingFor(mode, active)}
            countLine={countLineFor(mode, active, notes, visible, photos)}
            last={last}
            lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
            showSticker={mode !== 'images'}
            onJumpLast={() => last && jump(last.id)}
            onAdd={() => void addNote()}
          />
          <div className="rule" />
          {mode === 'images' ? (
            <Gallery photos={photos} copiedId={copied} onCopy={copy} />
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
              onToggleTag={toggleTag}
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
        <DropOverlay onImageAdded={onImageAdded} />
        <Tooltip />
      </div>
    </IconContext.Provider>
  );
}

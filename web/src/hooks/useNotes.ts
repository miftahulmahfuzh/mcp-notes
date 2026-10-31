import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotes, fetchTags } from '../api';
import { subscribeEvents } from '../lib/events';
import type { Note, TagCount } from '../types';

export interface NotesStore {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
  /** Debounced (250 ms) refetch of notes + tags. */
  refetch: () => void;
  /** Replace a note in place, or insert it (at the top when `atTop`). */
  upsertLocal: (note: Note, atTop?: boolean) => void;
  removeLocal: (id: string) => void;
}

interface State {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;
const POLL_MS = 60_000;

export function useNotes(): NotesStore {
  const [state, setState] = useState<State>({ notes: [], tags: [], loaded: false, error: null });
  // Bumped on every local mutation; a fetch that started before a mutation is discarded and retried.
  const gen = useRef(0);
  const refetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), DEBOUNCE_MS);
    };

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const g = gen.current;
      try {
        const [notes, tags] = await Promise.all([fetchNotes(), fetchTags()]);
        if (!alive) return;
        if (gen.current === g) setState({ notes, tags, loaded: true, error: null });
        else again = true;
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };

    refetchRef.current = schedule;
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);

    // The page's one /api/events connection (lib/events.ts), shared with the history page.
    const offNote = subscribeEvents('note', schedule);
    // After a daemon restart the browser reconnects; refetch what was missed.
    const offOpen = subscribeEvents('open', schedule);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      offNote();
      offOpen();
      refetchRef.current = () => {};
    };
  }, []);

  const refetch = useCallback(() => refetchRef.current(), []);

  const upsertLocal = useCallback((note: Note, atTop = false) => {
    gen.current += 1;
    setState((s) => {
      const i = s.notes.findIndex((n) => n.id === note.id);
      if (i >= 0) {
        const notes = s.notes.slice();
        notes[i] = note;
        return { ...s, notes };
      }
      return { ...s, notes: atTop ? [note, ...s.notes] : [...s.notes, note] };
    });
  }, []);

  const removeLocal = useCallback((id: string) => {
    gen.current += 1;
    setState((s) => ({ ...s, notes: s.notes.filter((n) => n.id !== id) }));
  }, []);

  return { ...state, refetch, upsertLocal, removeLocal };
}

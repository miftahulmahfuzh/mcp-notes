import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBin } from '../api';
import type { Bin } from '../types';

export interface BinStore {
  bin: Bin;
  loaded: boolean;
  error: string | null;
  /** Debounced (250 ms) refetch. No-op while disabled. */
  refetch: () => void;
  /** Optimistically drop a deleted note: its card and its 'note' tiles. */
  dropNote: (id: string) => void;
  /** Optimistically drop one tile by image id. */
  dropImage: (imageId: string) => void;
}

interface State {
  bin: Bin;
  loaded: boolean;
  error: string | null;
}

const EMPTY: Bin = { notes: [], images: [] };
const DEBOUNCE_MS = 250;
const SEP = '\u0000';

/** The recycle bin, fetched with the active tag filters, refetched on every SSE note event while `enabled`. */
export function useBin(active: string[], enabled: boolean): BinStore {
  const [state, setState] = useState<State>({ bin: EMPTY, loaded: false, error: null });
  // Bumped on every local drop; a fetch that started before a drop is discarded and retried.
  const gen = useRef(0);
  const refetchRef = useRef<() => void>(() => {});
  const tagKey = active.join(SEP);

  useEffect(() => {
    if (!enabled) return;
    const tags = tagKey === '' ? [] : tagKey.split(SEP);
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
        const bin = await fetchBin(tags);
        if (!alive) return;
        if (gen.current === g) setState({ bin, loaded: true, error: null });
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

    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/events');
      es.addEventListener('note', schedule);
      es.addEventListener('open', schedule);
    }

    return () => {
      alive = false;
      window.clearTimeout(timer);
      es?.close();
      refetchRef.current = () => {};
    };
  }, [enabled, tagKey]);

  const refetch = useCallback(() => refetchRef.current(), []);

  const dropNote = useCallback((id: string) => {
    gen.current += 1;
    setState((s) => ({
      ...s,
      bin: {
        notes: s.bin.notes.filter((n) => n.id !== id),
        images: s.bin.images.filter((b) => !(b.kind === 'note' && b.note_id === id)),
      },
    }));
  }, []);

  const dropImage = useCallback((imageId: string) => {
    gen.current += 1;
    setState((s) => ({ ...s, bin: { ...s.bin, images: s.bin.images.filter((b) => b.image.id !== imageId) } }));
  }, []);

  return { ...state, refetch, dropNote, dropImage };
}

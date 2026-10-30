import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the undo label stays (R3: "a quiet undo … for a few seconds"). */
export const UNDO_MS = 6000;

export interface UndoEntry {
  /** Geist Mono label: `deleted A-B32`, `removed image`. */
  label: string;
  /** Reverses the action. A failure is logged, never shown. */
  run: () => Promise<void>;
}

/** `seq` changes on every push, so the bar re-mounts (and re-fades) for each new entry. */
export type UndoItem = UndoEntry & { seq: number };

export interface UndoStore {
  entry: UndoItem | null;
  /** Show `entry` for `ms`, replacing any entry still showing (that action simply stays done). */
  push: (entry: UndoEntry) => void;
  /** Run the current entry once and hide it. No-op when nothing is showing. */
  undo: () => void;
  dismiss: () => void;
}

export function useUndo(ms = UNDO_MS): UndoStore {
  const [entry, setEntry] = useState<UndoItem | null>(null);
  const current = useRef<UndoItem | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const set = useCallback((e: UndoItem | null) => {
    current.current = e;
    setEntry(e);
  }, []);

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current);
    set(null);
  }, [set]);

  const push = useCallback(
    (e: UndoEntry) => {
      window.clearTimeout(timer.current);
      seq.current += 1;
      set({ ...e, seq: seq.current });
      timer.current = window.setTimeout(() => set(null), ms);
    },
    [ms, set],
  );

  const undo = useCallback(() => {
    const e = current.current;
    dismiss();
    if (e) void e.run().catch((err: unknown) => console.error('undo failed', err));
  }, [dismiss]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { entry, push, undo, dismiss };
}

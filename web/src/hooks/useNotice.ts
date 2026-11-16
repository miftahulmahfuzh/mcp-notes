import { useCallback, useEffect, useRef, useState } from 'react';

/** What a notice offers beside its text, e.g. Undo. Running it clears the notice. */
export interface NoticeAction {
  label: string;
  run: () => void;
}

/**
 * A quiet status label (the "copied" style) shown for `ms`, e.g. "already in K-F07". A notice
 * with an action (Undo) stays twice as long, so a misclick can be taken back.
 */
export function useNotice(ms = 2400): { notice: string | null; action: NoticeAction | null; show: (text: string, action?: NoticeAction) => void } {
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<NoticeAction | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setNotice(null);
    setAction(null);
  }, []);
  const show = useCallback(
    (text: string, act?: NoticeAction) => {
      setNotice(text);
      setAction(
        act === undefined
          ? null
          : {
              label: act.label,
              run: () => {
                clear();
                act.run();
              },
            },
      );
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(clear, act === undefined ? ms : ms * 2);
    },
    [ms, clear],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { notice, action, show };
}

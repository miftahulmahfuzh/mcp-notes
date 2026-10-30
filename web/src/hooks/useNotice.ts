import { useCallback, useEffect, useRef, useState } from 'react';

/** A quiet status label (the "copied" style) shown for `ms`, e.g. "already in K-F07". */
export function useNotice(ms = 2400): { notice: string | null; show: (text: string) => void } {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback(
    (text: string) => {
      setNotice(text);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setNotice(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { notice, show };
}

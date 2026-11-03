import { useCallback, useEffect, useRef, useState } from 'react';

export function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      ta.remove();
    }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

/**
 * The key last copied, cleared after `ms` (design: 1.4 s "copied" fade). `copy(id)` copies the id
 * itself; `copy(key, text)` copies `text` and flags `key` (a prompt's text under "prompt-3").
 */
export function useCopied(ms = 1400): { copied: string | null; copy: (key: string, text?: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(
    (key: string, text?: string) => {
      copyText(text ?? key);
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { copied, copy };
}

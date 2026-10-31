import { useCallback, useEffect, useState } from 'react';

/** sessionStorage key: the toggle survives reloads and view switches in this tab, not new tabs. */
export const SHOW_DELETED_KEY = 'mcp-notes:history:show-deleted';

function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SHOW_DELETED_KEY) === '1';
  } catch {
    return false;
  }
}

/** [on, toggle]. Storage failures (blocked storage, private mode) leave a working in-memory toggle. */
export function useShowDeleted(): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(readFlag);
  useEffect(() => {
    try {
      if (on) window.sessionStorage.setItem(SHOW_DELETED_KEY, '1');
      else window.sessionStorage.removeItem(SHOW_DELETED_KEY);
    } catch {
      // storage unavailable: the toggle still works for this page
    }
  }, [on]);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return [on, toggle];
}

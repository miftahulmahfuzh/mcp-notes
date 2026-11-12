import { useEffect } from 'react';

/**
 * Binds one Alt+<key> chord on the whole page. The wall's shortcuts are all two keys, Alt plus a
 * letter, picked so that no browser binds them: Alt+F/E/D/H/S open menus or the address bar, and
 * Alt+1..9 switch tabs on Linux. Taken so far: Alt+Z focus mode (useFocusShortcut), Alt+B the
 * sidebar (App), Alt+C the project chat history <-> session graph (ProjectsPage).
 *
 * Listens in the capture phase and calls preventDefault so the browser's own handling of the chord
 * never runs, even while a text field has focus. `code` rather than `key` because macOS Option
 * turns Alt+<letter> into another character. Ctrl/Meta/Shift variants and key repeat are not the
 * chord. Without `onPress` nothing is bound.
 */
export function useAltShortcut(code: string, onPress: (() => void) | undefined): void {
  useEffect(() => {
    if (!onPress) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== code || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();
      onPress();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [code, onPress]);
}

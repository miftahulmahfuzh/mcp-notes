import { useEffect } from 'react';

export interface FocusShortcutOptions {
  /** Focus mode is on: Esc may leave it. */
  focus: boolean;
  /**
   * Esc leaves focus mode only while this is true. Projects passes `node === null`, so with a node
   * selected Esc clears the node first. Default true.
   */
  escapeLeaves?: boolean;
}

/**
 * Focus mode's keyboard, shared by the Projects and Seer Adversarial pages.
 *
 * Alt+Z toggles focus mode from anywhere on the page. It listens in the capture phase and calls
 * preventDefault so the browser's own handling of the chord never runs. `z` as in vim's `zen`: no
 * browser binds Alt+Z, whereas Alt+F/E/D/H/S open menus or the address bar. `code` rather than `key`
 * because macOS Option turns Alt+Z into another character. Ctrl/Meta/Shift variants and key repeat
 * are not the chord.
 *
 * In focus mode, Esc leaves it (bubble phase, and only when nothing earlier handled the key).
 * Without `onToggle` the page has no focus mode and nothing is bound.
 */
export function useFocusShortcut(onToggle: (() => void) | undefined, { focus, escapeLeaves = true }: FocusShortcutOptions): void {
  useEffect(() => {
    if (!focus || !escapeLeaves || !onToggle) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') onToggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focus, escapeLeaves, onToggle]);

  useEffect(() => {
    if (!onToggle) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyZ' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();
      onToggle();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onToggle]);
}

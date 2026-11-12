import { useEffect } from 'react';
import { useAltShortcut } from './useAltShortcut';

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
 * Alt+Z toggles focus mode from anywhere on the page (useAltShortcut). `z` as in vim's `zen`.
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

  useAltShortcut('KeyZ', onToggle);
}

/** What a key press on the player page does. */
export type KeyAction =
  | 'togglePlay'
  | 'back'
  | 'forward'
  | 'toggleMute'
  | 'toggleSubtitles'
  | 'anotherSource'
  | 'subtitlesEarlier'
  | 'subtitlesLater'
  | 'toggleFullscreen'
  | 'nextEpisode'
  | 'prevEpisode'
  | 'closeMenu';

/**
 * The player page's keys: Space or K play and pause, the arrows seek, M mutes, C turns the subtitles
 * on and off, S asks for another source (not with Shift, Ctrl or Meta), G and H move the subtitles
 * earlier and later as VLC has them, F is full screen, Shift+N and Shift+P the next and previous
 * episode, Escape closes a menu. Null: the page leaves the key alone.
 */
export function keyAction(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>): KeyAction | null {
  const key = e.key.toLowerCase();
  if (key === ' ' || key === 'k') return 'togglePlay';
  if (key === 'arrowleft') return 'back';
  if (key === 'arrowright') return 'forward';
  if (key === 'm') return 'toggleMute';
  if (key === 'c') return 'toggleSubtitles';
  if (key === 's' && !e.shiftKey && !e.ctrlKey && !e.metaKey) return 'anotherSource';
  if (key === 'g') return 'subtitlesEarlier';
  if (key === 'h') return 'subtitlesLater';
  if (key === 'f') return 'toggleFullscreen';
  if (key === 'n' && e.shiftKey) return 'nextEpisode';
  if (key === 'p' && e.shiftKey) return 'prevEpisode';
  if (key === 'escape') return 'closeMenu';
  return null;
}

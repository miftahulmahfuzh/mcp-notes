// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { keyAction } from './keys';

const press = (key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) => keyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

describe('keyAction', () => {
  it('maps the player keys, whatever their case', () => {
    expect([' ', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'm', 'c', 's', 'g', 'h', 'f', 'Escape'].map((k) => press(k))).toEqual([
      'togglePlay',
      'togglePlay',
      'togglePlay',
      'back',
      'forward',
      'toggleMute',
      'toggleSubtitles',
      'anotherSource',
      'subtitlesEarlier',
      'subtitlesLater',
      'toggleFullscreen',
      'closeMenu',
    ]);
  });

  it('asks for another source only on a bare S, and goes to an episode only with Shift', () => {
    expect(press('S', { shiftKey: true })).toBeNull();
    expect(press('s', { ctrlKey: true })).toBeNull();
    expect(press('s', { metaKey: true })).toBeNull();
    expect(press('N', { shiftKey: true })).toBe('nextEpisode');
    expect(press('P', { shiftKey: true })).toBe('prevEpisode');
    expect(press('n')).toBeNull();
    expect(press('p')).toBeNull();
    expect(press('x')).toBeNull();
    expect(press('Tab')).toBeNull();
  });
});

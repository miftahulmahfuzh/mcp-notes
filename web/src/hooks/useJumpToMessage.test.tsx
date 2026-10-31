// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { JUMP_MAX_PAGES, NOT_FOUND_NOTICE, useJumpToMessage } from './useJumpToMessage';
import { makeMessage } from '../testing/chatFixtures';

let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('useJumpToMessage', () => {
  it('a loaded target is pulsed without loading anything', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div data-msg="K7F2" tabindex="-1"></div>');
    const loadOlder = vi.fn(async () => []);
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useJumpToMessage({ messages: [makeMessage('K7F2')], loadOlder, notify, showDeleted: false }),
    );
    await act(() => result.current('K7F2'));
    expect(loadOlder).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('stops after JUMP_MAX_PAGES non-empty pages and says so', async () => {
    const loadOlder = vi.fn(async () => [makeMessage('Y001')]);
    const notify = vi.fn();
    const { result } = renderHook(() => useJumpToMessage({ messages: [], loadOlder, notify, showDeleted: false }));
    await act(() => result.current('Z001'));
    expect(loadOlder).toHaveBeenCalledTimes(JUMP_MAX_PAGES);
    expect(notify).toHaveBeenCalledWith(NOT_FOUND_NOTICE);
  });

  it('a deleted target with "Show deleted" off is reported, not scrolled to', async () => {
    const loadOlder = vi.fn(async () => []);
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useJumpToMessage({
        messages: [makeMessage('K7F2', { deleted_at: '2026-10-31T02:00:00.000Z' })],
        loadOlder,
        notify,
        showDeleted: false,
      }),
    );
    await act(() => result.current('K7F2'));
    expect(notify).toHaveBeenCalledWith('message deleted');
    expect(animate).not.toHaveBeenCalled();
  });

  it('a failed page load is a quiet notice', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadOlder = vi.fn(async () => {
      throw new Error('offline');
    });
    const notify = vi.fn();
    const { result } = renderHook(() => useJumpToMessage({ messages: [], loadOlder, notify, showDeleted: false }));
    await act(() => result.current('Z001'));
    expect(notify).toHaveBeenCalledWith('could not load older messages');
    err.mockRestore();
  });
});

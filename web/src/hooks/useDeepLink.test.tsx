// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useDeepLink } from './useDeepLink';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const popTo = (url: string) => {
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

describe('useDeepLink', () => {
  it('waits for ready, then reads the URL once (rerenders do not re-fire)', () => {
    window.history.replaceState(null, '', '/?note=a-b32');
    const onLink = vi.fn();
    const { rerender } = renderHook(({ ready }) => useDeepLink(ready, onLink), { initialProps: { ready: false } });
    expect(onLink).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith('A-B32');
    rerender({ ready: true });
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('does nothing on load without a target', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('follows hashchange', async () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => {
      window.location.hash = '#cd45';
    });
    await waitFor(() => expect(onLink).toHaveBeenCalledWith('C-D45'));
  });

  it('follows popstate, and counts popstate + hashchange of one navigation once', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => {
      popTo('/#E-F56');
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith('E-F56');
    act(() => popTo('/?note=k-f07'));
    expect(onLink).toHaveBeenCalledTimes(2);
    expect(onLink).toHaveBeenLastCalledWith('K-F07');
  });

  it('ignores ids that cannot be note ids', () => {
    const onLink = vi.fn();
    renderHook(() => useDeepLink(true, onLink));
    act(() => popTo('/?note=hello#top'));
    expect(onLink).not.toHaveBeenCalled();
  });

  it('calls the latest callback and stops listening when unmounted', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useDeepLink(true, fn), { initialProps: { fn: first } });
    rerender({ fn: second });
    act(() => popTo('/?note=A-B32'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('A-B32');
    unmount();
    act(() => popTo('/?note=C-D45'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

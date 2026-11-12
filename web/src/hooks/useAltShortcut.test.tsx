// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useAltShortcut } from './useAltShortcut';

afterEach(cleanup);

function Harness({ code, onPress }: { code: string; onPress?: () => void }) {
  useAltShortcut(code, onPress);
  return null;
}

const key = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};

describe('useAltShortcut', () => {
  it('fires on Alt+<code> only, and cancels it', () => {
    const p = vi.fn();
    render(<Harness code="KeyB" onPress={p} />);
    expect(key({ code: 'KeyB', altKey: true }).defaultPrevented).toBe(true);
    expect(p).toHaveBeenCalledTimes(1);
    expect(key({ code: 'KeyC', altKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyB' }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyB', altKey: true, metaKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyB', altKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(p).toHaveBeenCalledTimes(1);
  });

  it('binds nothing without a handler', () => {
    render(<Harness code="KeyB" />);
    expect(key({ code: 'KeyB', altKey: true }).defaultPrevented).toBe(false);
  });
});

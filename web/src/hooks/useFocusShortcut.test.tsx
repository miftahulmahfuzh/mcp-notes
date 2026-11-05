// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useFocusShortcut } from './useFocusShortcut';

afterEach(cleanup);

function Harness({ onToggle, focus, escapeLeaves }: { onToggle?: () => void; focus: boolean; escapeLeaves?: boolean }) {
  useFocusShortcut(onToggle, { focus, escapeLeaves });
  return null;
}

const key = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};

describe('useFocusShortcut', () => {
  it('Alt+Z toggles and is cancelled; other chords are not', () => {
    const t = vi.fn();
    render(<Harness onToggle={t} focus={false} />);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true }).defaultPrevented).toBe(true);
    expect(t).toHaveBeenCalledTimes(1);
    expect(key({ code: 'KeyZ', key: 'z' }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('Esc leaves focus mode only in focus and only while escapeLeaves', () => {
    const t = vi.fn();
    const { rerender } = render(<Harness onToggle={t} focus={false} />);
    key({ key: 'Escape' });
    expect(t).not.toHaveBeenCalled();
    rerender(<Harness onToggle={t} focus escapeLeaves={false} />);
    key({ key: 'Escape' });
    expect(t).not.toHaveBeenCalled();
    rerender(<Harness onToggle={t} focus />);
    key({ key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('binds nothing without a toggle', () => {
    render(<Harness focus />);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true }).defaultPrevented).toBe(false);
  });
});

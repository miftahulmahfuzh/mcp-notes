// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UNDO_MS, useUndo, type UndoStore } from '../hooks/useUndo';
import { UndoBar } from './UndoBar';

let store: UndoStore;
function Harness() {
  store = useUndo();
  return <UndoBar entry={store.entry} onUndo={store.undo} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UndoBar + useUndo', () => {
  it('renders nothing until something is pushed', () => {
    render(<Harness />);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('shows the Geist Mono label and an icon-only Undo button (placed by .undo in UndoBar.css, no inline left)', () => {
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run: vi.fn(async () => {}) }));
    const bar = document.querySelector('.undo') as HTMLElement;
    expect(bar.textContent).toBe('deleted A-B32');
    expect(bar.style.left).toBe('');
    const btn = screen.getByRole('button', { name: 'Undo' });
    expect(btn.getAttribute('data-tip')).toBe('Undo');
    expect(btn.textContent).toBe('');
  });

  it('runs the entry once and hides when Undo is clicked', () => {
    const run = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'removed image', run }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('disappears after 6 s without running', () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run }));
    act(() => {
      vi.advanceTimersByTime(UNDO_MS - 1);
    });
    expect(document.querySelector('.undo')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('.undo')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a new push replaces the previous entry and restarts the clock', () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    render(<Harness />);
    act(() => store.push({ label: 'deleted A-B32', run: first }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    act(() => store.push({ label: 'deleted C-D45', run: second }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(document.querySelector('.undo')?.textContent).toBe('deleted C-D45');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('logs a failed undo instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Harness />);
    act(() =>
      store.push({
        label: 'deleted A-B32',
        run: async () => {
          throw new Error('offline');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(err).toHaveBeenCalledWith('undo failed', expect.any(Error)));
  });
});

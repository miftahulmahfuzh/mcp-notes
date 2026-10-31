// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { View } from '../types';
import { Rail } from './Rail';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

const rail = (view: View, onToggleHistory = vi.fn()) =>
  render(
    <Rail
      mode="text"
      view={view}
      active={[]}
      onToggleSide={vi.fn()}
      onAdd={vi.fn()}
      onCycleMode={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      onClear={vi.fn()}
    />,
  );

const side = (view: View, onToggleHistory = vi.fn()) =>
  render(
    <Sidebar
      mode="text"
      view={view}
      photoCount={0}
      tags={[]}
      active={[]}
      onMode={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
    />,
  );

/** Labels of the icon buttons in DOM order. */
const order = (root: Element) => Array.from(root.querySelectorAll('button.ibtn')).map((b) => b.getAttribute('aria-label'));

describe('chat-history icon', () => {
  it('sits directly above the recycle bin in the rail', () => {
    const { container } = rail('wall');
    const labels = order(container.querySelector('.rail') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('sits directly before the recycle bin in the sidebar', () => {
    const { container } = side('wall');
    const labels = order(container.querySelector('.side-modes') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('is pressed on the history page and calls the toggle', () => {
    const toggle = vi.fn();
    rail('history', toggle);
    const btn = screen.getByRole('button', { name: 'Chat history' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(btn.getAttribute('data-tip')).toBe('Chat history');
    expect(screen.getByRole('button', { name: 'Recycle bin' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('is not pressed on the wall; the sidebar mirrors the rail', () => {
    const toggle = vi.fn();
    side('history', toggle);
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    cleanup();
    rail('wall');
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('false');
  });
});

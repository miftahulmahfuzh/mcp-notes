// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectSummary, View } from '../types';
import { Rail } from './Rail';
import { Sidebar, type SidebarProps } from './Sidebar';

afterEach(cleanup);

const rail = (view: View, onToggleHistory = vi.fn(), onToggleProjects = vi.fn()) =>
  render(
    <Rail
      mode="text"
      view={view}
      active={[]}
      onToggleSide={vi.fn()}
      onAdd={vi.fn()}
      onCycleMode={vi.fn()}
      onToggleProjects={onToggleProjects}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      onClear={vi.fn()}
    />,
  );

const side = (view: View, onToggleHistory = vi.fn(), extra: Partial<SidebarProps> = {}) =>
  render(
    <Sidebar
      mode="text"
      view={view}
      photoCount={0}
      tags={[]}
      active={[]}
      onMode={vi.fn()}
      onToggleProjects={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      {...extra}
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

describe('projects icon', () => {
  it('sits directly above chat history, in the rail and in the sidebar', () => {
    const r = rail('wall');
    const railLabels = order(r.container.querySelector('.rail') as Element);
    expect(railLabels.indexOf('Projects')).toBe(railLabels.indexOf('Chat history') - 1);
    cleanup();
    const s = side('wall');
    const sideLabels = order(s.container.querySelector('.side-modes') as Element);
    expect(sideLabels.indexOf('Projects')).toBe(sideLabels.indexOf('Chat history') - 1);
  });

  it('is icon-only, pressed on the projects view, and calls its toggle', () => {
    const toggle = vi.fn();
    rail('projects', vi.fn(), toggle);
    const btn = screen.getByRole('button', { name: 'Projects' });
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('sidebar repo list', () => {
  const projects: ProjectSummary[] = [
    { repo: 'seer', sessions: 4, live: 0, last_active_at: '2026-10-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
    { repo: 'mcp-notes', sessions: 12, live: 2, last_active_at: '2026-11-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
  ];

  it('replaces the tags with repos, most recent first, the shown one marked', () => {
    const pick = vi.fn();
    const { container } = side('projects', vi.fn(), { projects, repo: 'seer', onPickRepo: pick, tags: [{ tag: 'kitchen', count: 3, last_used: null }] });
    expect(container.querySelector('.side-tags')).toBeNull();
    expect(screen.queryByText('#kitchen')).toBeNull();
    const list = screen.getByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-repo'))).toEqual(['mcp-notes', 'seer']);
    expect(rows[1]!.className).toBe('tagrow on');
    expect(rows[0]!.querySelector('.repo-live')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('12');
    fireEvent.click(rows[0]!);
    expect(pick).toHaveBeenCalledWith('mcp-notes');
  });

  it('says loading before the list arrives and keeps tags outside the projects view', () => {
    side('projects', vi.fn(), { projects: null });
    expect(screen.getByText('loading')).toBeTruthy();
    cleanup();
    const { container } = side('wall', vi.fn(), { projects, tags: [{ tag: 'kitchen', count: 3, last_used: null }] });
    expect(container.querySelector('.side-repos')).toBeNull();
    expect(screen.getByText('#kitchen')).toBeTruthy();
  });
});

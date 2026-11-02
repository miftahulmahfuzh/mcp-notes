import { describe, expect, it } from 'vitest';
import { projectHeading, projectsCountLine, sortProjects } from './projects';
import type { ProjectSummary } from '../types';

const p = (repo: string, sessions: number, live: number, last: string | null): ProjectSummary => ({
  repo,
  sessions,
  live,
  last_active_at: last,
  first_started_at: null,
  hosts: ['lenovo'],
});

describe('projects text', () => {
  it('heading and count line', () => {
    expect(projectHeading(null)).toBe('Projects.');
    expect(projectHeading('seer')).toBe('seer.');
    expect(projectsCountLine(null, null)).toBe('Loading projects.');
    expect(projectsCountLine([p('a', 1, 0, null)], null)).toBe('1 project.');
    expect(projectsCountLine([p('a', 1, 0, null)], 'a')).toBe('1 session.');
    expect(projectsCountLine([p('a', 5, 2, null)], 'a')).toBe('5 sessions, 2 running.');
    expect(projectsCountLine([], 'gone')).toBe('No sessions in gone.');
  });

  it('sorts most recently active first, then by name', () => {
    const list = [p('b', 1, 0, null), p('a', 1, 0, null), p('old', 1, 0, '2026-01-01T00:00:00Z'), p('new', 1, 0, '2026-11-01T00:00:00Z')];
    expect(sortProjects(list).map((x) => x.repo)).toEqual(['new', 'old', 'a', 'b']);
  });
});

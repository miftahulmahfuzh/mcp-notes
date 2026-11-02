import type { ProjectSummary } from '../types';

export const PROJECTS_HINT = 'Every Claude Code session of the repo, newest at the top. +N opens a branch.';

/** The page's big heading: the repo, or "Projects." while none is chosen. */
export function projectHeading(repo: string | null): string {
  return repo ? `${repo}.` : 'Projects.';
}

/** Header count line for the projects view. */
export function projectsCountLine(list: ProjectSummary[] | null, repo: string | null): string {
  if (list === null) return 'Loading projects.';
  if (repo === null) return list.length === 1 ? '1 project.' : `${list.length} projects.`;
  const hit = list.find((p) => p.repo === repo);
  if (!hit) return `No sessions in ${repo}.`;
  const n = hit.sessions === 1 ? '1 session' : `${hit.sessions} sessions`;
  return hit.live > 0 ? `${n}, ${hit.live} running.` : `${n}.`;
}

/** Most recently active first; ties and never-active repos by name. */
export function sortProjects(list: readonly ProjectSummary[]): ProjectSummary[] {
  const t = (p: ProjectSummary) => {
    const ms = p.last_active_at ? Date.parse(p.last_active_at) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return list.slice().sort((a, b) => {
    const ta = t(a);
    const tb = t(b);
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.repo.localeCompare(b.repo);
  });
}

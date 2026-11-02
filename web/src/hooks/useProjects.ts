import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProjects, fetchSelectedProject, saveSelectedProject } from '../sessionsApi';
import type { ProjectSummary } from '../types';

/** The repo list changes slowly; no SSE event exists for sessions (phase 7), so poll. */
export const PROJECTS_POLL_MS = 60_000;

export interface ProjectsStore {
  /** Repos with sessions; null until the first load. */
  projects: ProjectSummary[] | null;
  /** Server-side selection (`app_settings` key `projects.selected`, shared by both laptops). */
  selected: string | null;
  /** The selection GET has answered (or failed) for this visit. */
  selectedLoaded: boolean;
  error: string | null;
  /** Show `repo` and store it server-side. Fire-and-forget: a failed PUT keeps the local choice. */
  pick: (repo: string) => void;
}

/**
 * The sidebar's repo list and the shared selection. Fetches only while `enabled` (the projects view
 * is shown); every entry re-reads the selection, so a pick on the other laptop shows up next visit.
 */
export function useProjects(enabled: boolean): ProjectsStore {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLoaded, setSelectedLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A pick made during this visit wins over a slower selection GET. */
  const picked = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    picked.current = false;
    setSelectedLoaded(false);

    const loadList = async (): Promise<void> => {
      try {
        const list = await fetchProjects();
        if (!alive) return;
        setProjects(list);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void loadList();
    void (async () => {
      try {
        const repo = await fetchSelectedProject();
        if (alive && !picked.current) setSelected(repo);
      } catch {
        // no selection stored or the route failed: fall back to the most recent project
      } finally {
        if (alive) setSelectedLoaded(true);
      }
    })();
    const poll = window.setInterval(() => void loadList(), PROJECTS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [enabled]);

  const pick = useCallback((repo: string) => {
    picked.current = true;
    setSelected(repo);
    setSelectedLoaded(true);
    void saveSelectedProject(repo).catch(() => {});
  }, []);

  return { projects, selected, selectedLoaded, error, pick };
}

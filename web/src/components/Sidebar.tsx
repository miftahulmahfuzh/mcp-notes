import { ChatsCircle, Trash, TreeStructure } from '@phosphor-icons/react';
import type { Mode, ProjectSummary, TagCount, View } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { sortProjects } from '../lib/projects';
import { BIN_TIP, HISTORY_TIP, MODE_ICON, PROJECTS_TIP } from './Rail';

export interface SidebarProps {
  mode: Mode;
  view: View;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  /** Projects view: repos with sessions (null while loading). */
  projects?: ProjectSummary[] | null;
  /** Projects view: the repo shown. */
  repo?: string | null;
  onPickRepo?: (repo: string) => void;
}

export function Sidebar({
  mode,
  view,
  photoCount,
  tags,
  active,
  onMode,
  onToggleProjects,
  onToggleHistory,
  onToggleBin,
  onToggleTag,
  projects = null,
  repo = null,
  onPickRepo,
}: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const inProjects = view === 'projects';
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              className={view === 'wall' && m === mode ? 'ibtn on' : 'ibtn'}
              data-tip={MODE_TIP[m]}
              data-tip-side="below"
              aria-label={MODE_TIP[m]}
              onClick={() => onMode(m)}
            >
              <I weight="duotone" />
            </button>
          );
        })}
        <button
          type="button"
          className={inProjects ? 'ibtn on' : 'ibtn'}
          data-tip={PROJECTS_TIP}
          data-tip-side="below"
          aria-label={PROJECTS_TIP}
          aria-pressed={inProjects}
          onClick={onToggleProjects}
        >
          <TreeStructure weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'history' ? 'ibtn on' : 'ibtn'}
          data-tip={HISTORY_TIP}
          data-tip-side="below"
          aria-label={HISTORY_TIP}
          aria-pressed={view === 'history'}
          onClick={onToggleHistory}
        >
          <ChatsCircle weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'bin' ? 'ibtn on' : 'ibtn'}
          data-tip={BIN_TIP[view]}
          data-tip-side="below"
          aria-label={BIN_TIP[view]}
          aria-pressed={view === 'bin'}
          onClick={onToggleBin}
        >
          <Trash weight="duotone" />
        </button>
        {!inProjects && <span className="side-count">{photoCount} photos</span>}
      </div>
      <div className="side-sep" />
      {inProjects ? (
        <div className="side-repos" role="list" aria-label="Projects">
          {projects === null ? (
            <span className="side-note">loading</span>
          ) : projects.length === 0 ? (
            <span className="side-note">no sessions yet</span>
          ) : (
            sortProjects(projects).map((p) => (
              <div
                key={p.repo}
                role="listitem"
                data-repo={p.repo}
                className={p.repo === repo ? 'tagrow on' : 'tagrow'}
                aria-current={p.repo === repo ? 'true' : undefined}
                onClick={() => onPickRepo?.(p.repo)}
              >
                <span className="repo-name">
                  {p.live > 0 && <span className="repo-live" data-tip={`${p.live} running`} aria-label={`${p.live} running`} />}
                  {p.repo}
                </span>
                <span className="n">{p.sessions}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="side-tags">
          {sorted.map((t) => (
            <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
              <span>#{t.tag}</span>
              <span className="n">{t.count}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

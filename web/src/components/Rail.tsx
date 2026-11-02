import { ChatsCircle, Images, NotePencil, SidebarSimple, SquaresFour, TextAa, Trash, TreeStructure, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall', history: 'Recycle bin', projects: 'Recycle bin' };

/** Tooltip / label of the chat-history toggle (phase 9). Pressed state says when it is open; a second press returns to the wall. */
export const HISTORY_TIP = 'Chat history';

/** Tooltip / label of the projects toggle (project-session-graph phase 10): the session graph, with the repo list in the sidebar. */
export const PROJECTS_TIP = 'Projects';

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleProjects, onToggleHistory, onToggleBin, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'projects' ? 'ibtn on' : 'ibtn hov'}
        data-tip={PROJECTS_TIP}
        data-tip-side="right"
        aria-label={PROJECTS_TIP}
        aria-pressed={view === 'projects'}
        onClick={onToggleProjects}
      >
        <TreeStructure weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'history' ? 'ibtn on' : 'ibtn hov'}
        data-tip={HISTORY_TIP}
        data-tip-side="right"
        aria-label={HISTORY_TIP}
        aria-pressed={view === 'history'}
        onClick={onToggleHistory}
      >
        <ChatsCircle weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'bin' ? 'ibtn on' : 'ibtn hov'}
        data-tip={BIN_TIP[view]}
        data-tip-side="right"
        aria-label={BIN_TIP[view]}
        aria-pressed={view === 'bin'}
        onClick={onToggleBin}
      >
        <Trash weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}

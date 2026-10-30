import { Images, NotePencil, SidebarSimple, SquaresFour, TextAa, Trash, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall' };

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleBin, onToggleTag, onClear }: RailProps) {
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

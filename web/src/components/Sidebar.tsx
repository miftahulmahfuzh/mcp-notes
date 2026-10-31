import { ChatsCircle, Trash } from '@phosphor-icons/react';
import type { Mode, TagCount, View } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { BIN_TIP, HISTORY_TIP, MODE_ICON } from './Rail';

export interface SidebarProps {
  mode: Mode;
  view: View;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
}

export function Sidebar({ mode, view, photoCount, tags, active, onMode, onToggleHistory, onToggleBin, onToggleTag }: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
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
        <span className="side-count">{photoCount} photos</span>
      </div>
      <div className="side-sep" />
      <div className="side-tags">
        {sorted.map((t) => (
          <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
            <span>#{t.tag}</span>
            <span className="n">{t.count}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

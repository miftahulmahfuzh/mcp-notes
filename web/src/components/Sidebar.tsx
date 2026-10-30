import type { Mode, TagCount } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { MODE_ICON } from './Rail';

export interface SidebarProps {
  mode: Mode;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleTag: (tag: string) => void;
}

export function Sidebar({ mode, photoCount, tags, active, onMode, onToggleTag }: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button key={m} type="button" className={m === mode ? 'ibtn on' : 'ibtn'} data-tip={MODE_TIP[m]} aria-label={MODE_TIP[m]} onClick={() => onMode(m)}>
              <I weight="duotone" />
            </button>
          );
        })}
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

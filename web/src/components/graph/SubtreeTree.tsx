import type { SubtreeRow } from '../../lib/subtree';

export interface SubtreeTreeProps {
  rows: readonly SubtreeRow[];
  /** The panel's node (highlighted). */
  current: string;
  onSelect: (nodeId: string) => void;
}

/** The subtree as an indented list; a row opens that node (`?node=`). */
export function SubtreeTree({ rows, current, onSelect }: SubtreeTreeProps) {
  return (
    <ul className="np-tree">
      {rows.map((r) => {
        const cur = r.node_id === current;
        const cls = ['np-tree-row', cur ? 'cur' : '', r.live ? 'live' : '', r.available ? '' : 'away'].filter(Boolean).join(' ');
        return (
          <li key={r.node_id}>
            <button
              type="button"
              className={cls}
              style={{ paddingLeft: 6 + r.depth * 14 }}
              aria-label={`Open ${r.node_id}`}
              aria-current={cur ? 'true' : undefined}
              onClick={() => onSelect(r.node_id)}
            >
              <span className="np-dot" aria-hidden="true" />
              <span className="np-tree-id">{r.node_id}</span>
              <span className="np-tree-label">{r.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

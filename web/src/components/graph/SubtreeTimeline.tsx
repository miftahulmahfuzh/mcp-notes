import { useMemo, type KeyboardEvent } from 'react';
import { GANTT, timelineLayout, type SubtreeRow } from '../../lib/subtree';

export interface SubtreeTimelineProps {
  rows: readonly SubtreeRow[];
  current: string;
  now: Date;
  onSelect: (nodeId: string) => void;
}

/** The subtree as Gantt bars on one time axis (custom SVG). */
export function SubtreeTimeline({ rows, current, now, onSelect }: SubtreeTimelineProps) {
  const layout = useMemo(() => timelineLayout(rows, now), [rows, now]);
  if (layout.bars.length === 0) return <p className="np-dim">No times recorded for this subtree</p>;
  const plotBottom = layout.height - GANTT.axisH;
  const onKey = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onSelect(id);
  };
  return (
    <figure className="np-gantt">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" role="group" aria-label="Subtree timeline">
        {layout.ticks.map((t) => (
          <g key={t.anchor}>
            <line className="np-gantt-grid" x1={t.x} x2={t.x} y1={0} y2={plotBottom} />
            <text className="np-gantt-tick" x={t.x} y={layout.height - 7} textAnchor={t.anchor}>
              {t.label}
            </text>
          </g>
        ))}
        {layout.bars.map((b) => {
          const cls = ['np-gantt-row', b.node_id === current ? 'cur' : '', b.live ? 'live' : '', b.available ? '' : 'away'].filter(Boolean).join(' ');
          return (
            <g
              key={b.node_id}
              className={cls}
              data-bar={b.node_id}
              data-tip={b.tip}
              role="button"
              tabIndex={0}
              aria-label={`Open ${b.node_id}`}
              onClick={() => onSelect(b.node_id)}
              onKeyDown={onKey(b.node_id)}
            >
              <rect className="np-gantt-hit" x={0} y={b.y} width={layout.width} height={GANTT.rowH} />
              <text className="np-gantt-label" x={4 + b.depth * GANTT.indent} y={b.y + GANTT.rowH / 2 + 4}>
                {b.node_id}
              </text>
              <rect className="np-gantt-bar" x={b.x} y={b.y + (GANTT.rowH - GANTT.barH) / 2} width={b.width} height={GANTT.barH} rx={2} />
            </g>
          );
        })}
      </svg>
      {layout.undated > 0 && <figcaption className="np-dim">{layout.undated} without times</figcaption>}
    </figure>
  );
}

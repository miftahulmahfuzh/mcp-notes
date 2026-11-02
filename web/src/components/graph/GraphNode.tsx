import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Devices } from '@phosphor-icons/react';
import { BADGE_W, CHIP_W, GUTTER_W, ID_W, REMOTE_W, ROW_H, fmtDay, fmtTime, nodeTitle, type LaidNode } from '../../lib/sessionGraph';

export interface GraphNodeProps {
  laid: LaidNode;
  /** Dot centre. */
  x: number;
  y: number;
  /** Start of the label column (shared by every row). */
  labelX: number;
  /** Full row width (hit area). */
  width: number;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  onToggle: (sessionId: string) => void;
  /**
   * Phase 13 slot (the "unfinished" badge): SVG content drawn in its own BADGE_W column after the
   * chip, inside a <g> translated to (column start, row centre). Absent → the column collapses.
   */
  badge?: ReactNode;
}

/** One graph row: gutter time, dot (halo when live), node id, +N chip, badge slot, other-host mark, title. */
export const GraphNode = memo(function GraphNode({ laid, x, y, labelX, width, selected, onSelect, onToggle, badge }: GraphNodeProps) {
  const { node, root, childCount, descendants, expanded, firstOfDay } = laid;
  const remote = !node.available;
  const top = y - ROW_H / 2;
  const r = root ? 6 : 4.5;
  const cls = ['gnode', root ? 'root' : '', node.live ? 'live' : '', remote ? 'remote' : '', selected ? 'sel' : ''].filter(Boolean).join(' ');
  const title = nodeTitle(node);
  const chipX = labelX + ID_W;
  const hasBadge = badge !== undefined && badge !== null && badge !== false;
  const badgeX = chipX + CHIP_W;
  const remoteX = badgeX + (hasBadge ? BADGE_W : 0);
  const titleX = remoteX + (remote ? REMOTE_W : 0);
  const label = `${node.node_id} ${title}${node.live ? ', running' : ''}${remote ? `, on ${node.host || 'another device'}` : ''}`;

  const select = () => onSelect(node.node_id);
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  };
  const toggleClick = (e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    onToggle(node.session_id);
  };
  const toggleKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onToggle(node.session_id);
  };

  return (
    <g className={cls} data-node={node.node_id} role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onClick={select} onKeyDown={onKey}>
      <rect className="gnode-hit" x={0} y={top} width={width} height={ROW_H} />
      {firstOfDay && <line className="gnode-dayrule" x1={0} x2={width} y1={top + 0.5} y2={top + 0.5} />}
      {firstOfDay ? (
        <>
          <text className="gnode-day" x={GUTTER_W - 12} y={y - 3} textAnchor="end">
            {fmtDay(node)}
          </text>
          <text className="gnode-time" x={GUTTER_W - 12} y={y + 10} textAnchor="end">
            {fmtTime(node)}
          </text>
        </>
      ) : (
        <text className="gnode-time" x={GUTTER_W - 12} y={y + 4} textAnchor="end">
          {fmtTime(node)}
        </text>
      )}
      {node.live && <circle className="gnode-halo" cx={x} cy={y} r={r + 4} />}
      <circle className="gnode-dot" cx={x} cy={y} r={r} />
      <text className="gnode-id" x={labelX} y={y + 4}>
        {node.node_id}
      </text>
      {childCount > 0 && (
        <g
          className={expanded ? 'gchip open' : 'gchip'}
          role="button"
          tabIndex={0}
          aria-label={expanded ? `Hide ${descendants} sessions` : `Show ${descendants} more sessions`}
          aria-expanded={expanded}
          data-tip={expanded ? 'Collapse branch' : 'Expand branch'}
          onClick={toggleClick}
          onKeyDown={toggleKey}
        >
          <rect x={chipX} y={y - 9} width={CHIP_W - 8} height={18} rx={9} />
          <text x={chipX + (CHIP_W - 8) / 2} y={y + 4} textAnchor="middle">
            {expanded ? '−' : `+${descendants}`}
          </text>
        </g>
      )}
      {hasBadge && (
        <g className="gnode-badge" transform={`translate(${badgeX} ${y})`}>
          {badge}
        </g>
      )}
      {remote && (
        <g className="gnode-remote" data-tip={`Transcript is on ${node.host || 'another device'}`}>
          <Devices x={remoteX} y={y - 7} size={14} weight="duotone" color="#bdbcb4" />
          <text x={remoteX + 18} y={y + 4}>
            on {node.host || 'another device'}
          </text>
        </g>
      )}
      <text className="gnode-title" x={titleX} y={y + 4}>
        {title}
      </text>
    </g>
  );
});

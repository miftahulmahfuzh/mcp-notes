import { memo } from 'react';
import { ROW_H, edgePath, edgesInRange, laneX, rowY, type GraphLayout } from '../../lib/sessionGraph';

export interface GraphEdgesProps {
  layout: GraphLayout;
  /** Mounted rows, inclusive. */
  first: number;
  last: number;
}

/** The thick trunk (clipped to the window, reaching the top row) and the edges crossing the window. */
export const GraphEdges = memo(function GraphEdges({ layout, first, last }: GraphEdgesProps) {
  if (last < first) return null;
  const trunk = layout.trunk;
  let trunkLine = null;
  // The trunk grows upward to the top of the graph (settled: newest at the top), not only to the
  // newest root: newer child branches above it still hang off it, and lane 0 holds roots only.
  if (trunk !== null && trunk.bottom >= first) {
    const x = laneX(0);
    const y1 = first === 0 ? Math.max(2, rowY(0) - ROW_H * 0.75) : rowY(first) - ROW_H;
    const y2 = trunk.bottom <= last ? rowY(trunk.bottom) : rowY(last) + ROW_H;
    trunkLine = <line className="gtrunk" x1={x} x2={x} y1={y1} y2={y2} />;
  }
  return (
    <g className="gedges">
      {trunkLine}
      {edgesInRange(layout, first, last).map((e) => (
        <path key={e.child} className={e.heuristic ? 'gedge heur' : 'gedge'} d={edgePath(e)} data-edge={e.child} />
      ))}
    </g>
  );
});

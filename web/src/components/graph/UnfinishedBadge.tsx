import { HourglassMedium } from '@phosphor-icons/react';
import './UnfinishedBadge.css';

/** Hover text for both badges. */
export const UNFINISHED_TIP = 'Swarm ledger still has pending phases and no session is running it';

const LABEL = 'unfinished';
/** Width of the SVG pill: icon (10) + gaps + 10 chars of 9px Geist Mono. */
const PILL_W = 78;
const PILL_H = 14;

/** Graph node badge (SVG). Top-left corner at (x, y) inside GraphNode's badge slot. */
export function UnfinishedBadgeSvg({ unfinished, x, y }: { unfinished: boolean | null | undefined; x: number; y: number }) {
  if (unfinished !== true) return null;
  return (
    <g className="gnode-unfinished" transform={`translate(${x} ${y})`} data-testid="unfinished-badge" role="img" aria-label={LABEL}>
      <title>{UNFINISHED_TIP}</title>
      <rect className="gnode-unfinished-bg" width={PILL_W} height={PILL_H} rx={PILL_H / 2} ry={PILL_H / 2} />
      <HourglassMedium x={4} y={2} width={10} height={10} weight="bold" aria-hidden="true" />
      <text className="gnode-unfinished-text" x={17} y={PILL_H / 2} dominantBaseline="central">
        {LABEL}
      </text>
    </g>
  );
}

/** Node panel header pill (HTML). */
export function UnfinishedPill({ unfinished }: { unfinished: boolean | null | undefined }) {
  if (unfinished !== true) return null;
  return (
    <span className="unfinished-pill" data-tip={UNFINISHED_TIP} title={UNFINISHED_TIP} data-testid="unfinished-pill">
      <HourglassMedium size={12} weight="bold" aria-hidden="true" />
      {LABEL}
    </span>
  );
}

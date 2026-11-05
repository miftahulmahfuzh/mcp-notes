import type { Curves } from '../../adversaryApi';
import { shortDate } from '../../lib/adversary';

const W = 800;
const H = 220;
const TOP = 12;
const BOTTOM = 208;

function lastValue(vals: readonly (number | null)[]): number | null {
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Original (dashed), Claude twin (solid) and SPY (dotted), growth of 100 with deposits taken out. */
export function CurvesChart({ curves }: { curves: Curves | null }) {
  // Phase 5 sends null until the twin has a snapshot.
  if (curves === null) return <p className="adv-empty">The curves start once the twin has two sessions on paper.</p>;
  const n = curves.dates.length;
  const values = [...curves.twin, ...curves.original, ...curves.spy].filter((v): v is number => v !== null);
  if (n < 2 || values.length === 0) return <p className="adv-empty">The curves start once the twin has two sessions on paper.</p>;
  const lo = Math.min(100, ...values);
  const hi = Math.max(100, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => BOTTOM - ((v - lo) / span) * (BOTTOM - TOP);
  const points = (vals: readonly (number | null)[]) =>
    vals.flatMap((v, i) => (v === null ? [] : [`${x(i).toFixed(1)},${y(v).toFixed(1)}`])).join(' ');
  const fmt = (v: number | null) => (v === null ? 'no value' : v.toFixed(1));
  const label = `Claude twin ends at ${fmt(lastValue(curves.twin))}, original at ${fmt(lastValue(curves.original))}, SPY at ${fmt(lastValue(curves.spy))}`;
  const first = curves.dates[0] ?? '';
  const mid = curves.dates[Math.floor((n - 1) / 2)] ?? '';
  const last = curves.dates[n - 1] ?? '';
  return (
    <figure className="adv-chart">
      <div className="adv-legend">
        <span className="adv-key-row">
          <span className="adv-key twin" />
          Claude twin
        </span>
        <span className="adv-key-row">
          <span className="adv-key orig" />
          original
        </span>
        <span className="adv-key-row">
          <span className="adv-key spy" />
          SPY
        </span>
        <span className="adv-push">
          growth of 100, deposits taken out · {shortDate(first)} → {shortDate(last)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line className="adv-base" x1="0" x2={W} y1={y(100)} y2={y(100)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line spy" points={points(curves.spy)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line orig" points={points(curves.original)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line twin" points={points(curves.twin)} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="adv-axis">
        <span>{shortDate(first)}</span>
        <span>{shortDate(mid)}</span>
        <span>{shortDate(last)}</span>
      </div>
    </figure>
  );
}

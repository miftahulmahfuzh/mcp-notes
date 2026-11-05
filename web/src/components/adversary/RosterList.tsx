import type { AdversaryMethod } from '../../adversaryApi';
import { shortDate } from '../../lib/adversary';

export interface RosterListProps {
  /** null while loading. */
  roster: AdversaryMethod[] | null;
  /** The method shown; null = Overview. */
  strategy: string | null;
  onPick: (strategyId: string | null) => void;
}

/** Seer's roster in the sidebar, as Projects lists repos: Overview first, active methods, retired greyed below. */
export function RosterList({ roster, strategy, onPick }: RosterListProps) {
  if (roster === null) return <span className="side-note">loading</span>;
  const active = roster.filter((r) => r.status === 'active');
  const retired = roster
    .filter((r) => r.status === 'retired')
    .slice()
    .sort((a, b) => (b.paper_end ?? '').localeCompare(a.paper_end ?? ''));
  const row = (r: AdversaryMethod, tip: string | undefined) => (
    <div
      key={r.strategy_id}
      role="listitem"
      data-strategy={r.strategy_id}
      className={r.strategy_id === strategy ? 'tagrow on' : 'tagrow'}
      aria-current={r.strategy_id === strategy ? 'true' : undefined}
      onClick={() => onPick(r.strategy_id)}
    >
      <span className="repo-name" data-tip={tip}>
        {r.name}
      </span>
    </div>
  );
  return (
    <>
      <div className="side-repos" role="list" aria-label="Seer roster">
        <div role="listitem" data-strategy="" className={strategy === null ? 'tagrow on' : 'tagrow'} aria-current={strategy === null ? 'true' : undefined} onClick={() => onPick(null)}>
          <span>Overview</span>
          <span className="n">{active.length}</span>
        </div>
        {active.map((r) => row(r, r.cadence ?? undefined))}
      </div>
      {retired.length > 0 && (
        <div className="side-retired">
          <span className="side-note">retired</span>
          <div className="side-repos" role="list" aria-label="Retired methods">
            {retired.map((r) => row(r, r.paper_end ? `retired on ${shortDate(r.paper_end)}` : undefined))}
          </div>
        </div>
      )}
    </>
  );
}

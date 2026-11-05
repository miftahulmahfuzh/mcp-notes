import type { MouseEvent } from 'react';
import type { MethodRow, OverviewPayload } from '../../adversaryApi';
import { causeTiles, objectionsLine, pct, rosterNames, shortDate } from '../../lib/adversary';
import { adversaryHref } from '../../lib/route';
import { ChecklistDots, CoverageBar, CoverageLegend, Divider, DotLegend, VerdictCard } from './parts';

export interface AdversaryOverviewProps {
  overview: OverviewPayload;
  onPick: (strategyId: string) => void;
}

/** A plain click opens the method in place; Ctrl/Meta/Shift/middle click keeps the browser's own link behaviour. */
function pickHandler(id: string, onPick: (strategyId: string) => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onPick(id);
  };
}

function twinClass(m: MethodRow): string {
  const { original, twin } = m.returns;
  return original !== null && twin !== null && twin > original ? 'adv-num hi' : 'adv-num lo';
}

export function AdversaryOverview({ overview, onPick }: AdversaryOverviewProps) {
  const names = rosterNames(overview.roster);
  const tiles = causeTiles(overview.cause, names);
  return (
    <div className="adv-overview">
      <section className="adv-cause" aria-label="Seer's cause">
        {tiles.map((t) => (
          <div key={t.key} className="adv-tile" data-tile={t.key}>
            <span className="adv-meta">{t.label}</span>
            <span className="adv-big">{t.value}</span>
            <span className="adv-text">{t.text}</span>
          </div>
        ))}
      </section>

      <section className="adv-methods" aria-label="Methods">
        <div className="adv-thead adv-grid7">
          <span>method</span>
          <span>original</span>
          <span>Claude twin</span>
          <span>SPY</span>
          <span>objections</span>
          <span>reviewed · absent · paused · pending</span>
          <span>go-live, orig / twin</span>
        </div>
        {overview.methods.length === 0 ? (
          <p className="adv-empty">No method on Seer's roster has a Claude twin yet. A twin appears the night after a method is admitted.</p>
        ) : (
          overview.methods.map((m) => (
            <a
              key={m.strategy_id}
              className="adv-row adv-grid7"
              href={adversaryHref({ strategy: m.strategy_id, focus: false })}
              data-strategy={m.strategy_id}
              onClick={pickHandler(m.strategy_id, onPick)}
            >
              <span className="adv-name">
                <span className="adv-title">
                  {m.name}
                  {m.cadence && <span className="adv-chip ok">{m.cadence}</span>}
                </span>
                {m.sub && <span className="adv-sub">{m.sub}</span>}
              </span>
              <span className="adv-num">{pct(m.returns.original)}</span>
              <span className={twinClass(m)}>{pct(m.returns.twin)}</span>
              <span className="adv-num lo">{pct(m.returns.spy)}</span>
              <span className="adv-obj">
                {objectionsLine(m.objections)}
                {m.objections.fell_after !== null && <span className="adv-meta">{m.objections.fell_after} fell after</span>}
              </span>
              <CoverageBar coverage={m.coverage} engine={m.engine} cadence={m.cadence} />
              <span className="adv-checks2">
                <ChecklistDots items={m.checklist.original} who="original" />
                <ChecklistDots items={m.checklist.twin} who="Claude twin" />
              </span>
            </a>
          ))
        )}
        <div className="adv-legend">
          <span>returns are money-weighted, deposits included, over each twin's own record</span>
          <DotLegend />
        </div>
        <div className="adv-legend">
          <CoverageLegend />
        </div>
      </section>

      <section className="adv-latest" aria-label="Latest objections">
        <Divider>latest objections</Divider>
        {overview.latest.length === 0 ? (
          <p className="adv-empty">No objections yet.</p>
        ) : (
          <div className="adv-cards">
            {overview.latest.map((v) => (
              <VerdictCard key={v.id} v={v} tag={`${names.get(v.strategy_id) ?? v.strategy_id} · ${shortDate(v.session_date)}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

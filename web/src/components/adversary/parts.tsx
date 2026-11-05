import type { ReactNode } from 'react';
import type { AdversarySource, AdversaryVerdict, ChecklistItem, Coverage, VerdictKind } from '../../adversaryApi';
import { CHECK_WORD, clockTime, coverageLabel, coverageTotal, sourceHost, sourceLabel, weightChange } from '../../lib/adversary';

export const VERDICT_WORD: Record<VerdictKind, string> = { object: 'object', agree: 'agree', unsure: "can't tell" };
const VERDICT_CLASS: Record<VerdictKind, string> = { object: 'adv-chip obj', agree: 'adv-chip ok', unsure: 'adv-chip unsure' };

export function VerdictChip({ verdict }: { verdict: VerdictKind }) {
  return <span className={VERDICT_CLASS[verdict]}>{VERDICT_WORD[verdict]}</span>;
}

/** A section label with a hairline running to the right edge. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="adv-divider">
      <span>{children}</span>
    </div>
  );
}

function SourceLink({ s, children }: { s: AdversarySource; children: ReactNode }) {
  return (
    <a href={s.url} target="_blank" rel="noreferrer" data-tip={s.fetched_at === null ? 'fetched' : `fetched ${clockTime(s.fetched_at)}`}>
      {children}
    </a>
  );
}

/** Compact sources: one domain per link. */
export function SourceLinks({ sources }: { sources: readonly AdversarySource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="adv-src">
      {sources.map((s, i) => (
        <SourceLink key={`${i}-${s.url}`} s={s}>
          {sourceHost(s)}
        </SourceLink>
      ))}
    </div>
  );
}

/** Numbered sources: `publisher · title`. */
export function NumberedSources({ sources }: { sources: readonly AdversarySource[] }) {
  if (sources.length === 0) return null;
  return (
    <ol className="adv-srcs">
      {sources.map((s, i) => (
        <li key={`${i}-${s.url}`}>
          <SourceLink s={s}>{sourceLabel(s)}</SourceLink>
        </li>
      ))}
    </ol>
  );
}

export interface VerdictCardProps {
  v: AdversaryVerdict;
  /** Right of the chip: `A · Nov 4` on the overview, `held · sell` on a method page. */
  tag: string;
  /** Method page: numbered sources and the weight / time / host footer. */
  detailed?: boolean;
}

export function VerdictCard({ v, tag, detailed = false }: VerdictCardProps) {
  return (
    <article className={v.late ? 'adv-card late' : 'adv-card'} data-verdict={v.verdict} data-symbol={v.symbol}>
      <div className="adv-card-head">
        <span className="adv-sym">{v.symbol}</span>
        <VerdictChip verdict={v.verdict} />
        <span className="adv-push adv-meta">{tag}</span>
      </div>
      <p className="adv-reason">{v.reason}</p>
      {detailed ? <NumberedSources sources={v.sources} /> : <SourceLinks sources={v.sources} />}
      {detailed && (
        <div className="adv-card-foot">
          <span>{weightChange(v)}</span>
          <span className="adv-push">
            {v.late ? 'late · not used · ' : ''}
            {clockTime(v.decided_at)} · {v.host}
          </span>
        </div>
      )}
    </article>
  );
}

/** reviewed · absent · paused · pending (session not open yet), as one bar with its label under it. */
export function CoverageBar({ coverage, engine, cadence }: { coverage: Coverage; engine: 'bracket' | 'book'; cadence: string | null }) {
  const total = coverageTotal(coverage) + coverage.pending;
  const label = coverageLabel(coverage, engine, cadence);
  return (
    <span className="adv-cov">
      <span className="adv-cov-bar" role="img" aria-label={`reviewed ${coverage.reviewed}, absent ${coverage.absent}, paused ${coverage.paused}, pending ${coverage.pending}`}>
        {total === 0 ? (
          <span className="adv-cov-empty" />
        ) : (
          <>
            {coverage.reviewed > 0 && <span className="adv-cov-reviewed" style={{ flex: coverage.reviewed }} />}
            {coverage.absent > 0 && <span className="adv-cov-absent" style={{ flex: coverage.absent }} />}
            {coverage.paused > 0 && <span className="adv-cov-paused" style={{ flex: coverage.paused }} />}
            {coverage.pending > 0 && <span className="adv-cov-pending" style={{ flex: coverage.pending }} />}
          </>
        )}
      </span>
      <span className="adv-meta">{label}</span>
    </span>
  );
}

/** Five go-live rules as dots, in rule order. */
export function ChecklistDots({ items, who }: { items: readonly ChecklistItem[]; who: string }) {
  const sorted = items.slice().sort((a, b) => a.rule - b.rule);
  const passed = sorted.filter((i) => i.state === 'pass').length;
  return (
    <span className="adv-dots" role="img" aria-label={`${who}: ${passed} of ${sorted.length} go-live rules passed`} data-who={who}>
      {sorted.map((i) => (
        <span key={i.rule} className={`adv-dot ${i.state}`} data-tip={`${i.rule} · ${i.label}: ${CHECK_WORD[i.state]}`} />
      ))}
    </span>
  );
}

export function DotLegend() {
  return (
    <>
      <span className="adv-key-row">
        <span className="adv-dot pass" />
        passed
      </span>
      <span className="adv-key-row">
        <span className="adv-dot fail" />
        not yet / failed
      </span>
      <span className="adv-key-row">
        <span className="adv-dot na" />
        no backtest possible for Claude
      </span>
    </>
  );
}

export function CoverageLegend() {
  return (
    <>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-reviewed" />
        reviewed
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-absent" />
        absent: no laptop had WSL up
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-paused" />
        paused: you turned auto-runs off
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-pending" />
        pending: the session has not opened yet
      </span>
    </>
  );
}

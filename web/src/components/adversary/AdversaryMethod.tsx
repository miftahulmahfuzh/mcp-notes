import { useState } from 'react';
import type { AdversaryDecision, ChecklistItem, MethodPayload, MethodStats, VerdictKind } from '../../adversaryApi';
import { checkValue, clockTime, dropPct, heldTag, pct, ratio, shortDate, shortName, TWIN_BACKTEST_NOTE, usd } from '../../lib/adversary';
import { CurvesChart } from './CurvesChart';
import { Divider, VERDICT_WORD, VerdictCard } from './parts';

const FILTER_ORDER: VerdictKind[] = ['object', 'unsure', 'agree'];
const AGREE_CHIPS = 15;

function StatsTable({ stats }: { stats: MethodPayload['stats'] }) {
  // Each column is null until that book has a record over the twin's window (phase 5): it reads '—'.
  const cell = (s: MethodStats | null, f: (s: MethodStats) => string) => (s === null ? '—' : f(s));
  const row = (label: string, f: (s: MethodStats) => string) => (
    <div className="adv-stat">
      <span className="adv-stat-l">{label}</span>
      <span>{cell(stats.original, f)}</span>
      <span className="hi">{cell(stats.twin, f)}</span>
      <span className="lo">{cell(stats.spy, f)}</span>
    </div>
  );
  const fees = (s: MethodStats) => (s.fees_usd === null ? '—' : usd(s.fees_usd).replace(/^\+/, ''));
  const twinFees = stats.twin?.fees_usd ?? null;
  const origFees = stats.original?.fees_usd ?? null;
  const moreFees = twinFees !== null && origFees !== null && twinFees > origFees;
  return (
    <div className="adv-stats">
      <div className="adv-stat adv-stat-h">
        <span />
        <span>original</span>
        <span>twin</span>
        <span>SPY</span>
      </div>
      {row('return', (s) => pct(s.return))}
      {row('worst drop', (s) => dropPct(s.worst_drop))}
      {row('wins ÷ losses', (s) => ratio(s.profit_factor))}
      {row('fees paid', fees)}
      {moreFees && <p className="adv-note-p">The twin pays more in fees: every objection to a stock the book already holds is a sale.</p>}
    </div>
  );
}

function CheckCard({ original, twin }: { original: ChecklistItem; twin: ChecklistItem | undefined }) {
  return (
    <div className="adv-check" data-rule={original.rule}>
      <span className="adv-meta">
        {original.rule} · {original.label}
      </span>
      <div className="adv-check-row">
        <span>original</span>
        <span className="adv-mono">{checkValue(original)}</span>
      </div>
      {twin && (
        <div className="adv-check-row">
          <span>twin</span>
          <span className="adv-mono">{checkValue(twin)}</span>
        </div>
      )}
      {original.progress !== null && (
        <div className="adv-progress">
          <div style={{ width: `${Math.round(Math.min(1, Math.max(0, original.progress)) * 100)}%` }} />
        </div>
      )}
      {twin?.state === 'na' && <span className="adv-check-note">{TWIN_BACKTEST_NOTE}</span>}
    </div>
  );
}

function decisionLine(d: AdversaryDecision): string {
  const parts = [`${shortDate(d.session_date).toLowerCase()} decision`];
  if (d.first_started_at && d.last_decided_at) parts.push(`reviewed ${clockTime(d.first_started_at).toLowerCase()} – ${clockTime(d.last_decided_at).toLowerCase()}`);
  if (d.models.length > 0) parts.push(d.models.join(', '));
  if (d.prompt_versions.length > 0) parts.push(`prompt ${d.prompt_versions.join(', ')}`);
  return parts.join(' · ');
}

function initialFilter(d: AdversaryDecision): VerdictKind {
  return FILTER_ORDER.find((k) => d.verdicts.some((v) => v.verdict === k)) ?? 'object';
}

function Decision({ d }: { d: AdversaryDecision }) {
  const [filter, setFilter] = useState<VerdictKind>(() => initialFilter(d));
  const shown = d.verdicts.filter((v) => v.verdict === filter);
  const agree = d.verdicts.filter((v) => v.verdict === 'agree');
  const weights = new Set(agree.map((v) => v.twin_weight).filter((w): w is number => w !== null));
  const each = weights.size === 1 ? `, each to ${(([...weights][0] ?? 0) * 100).toFixed(1)}%` : '';
  return (
    <section className="adv-decision" aria-label={`${shortDate(d.session_date)} decision`}>
      <Divider>{decisionLine(d)}</Divider>
      {d.verdicts.length === 0 ? (
        <p className="adv-empty">
          {d.coverage === 'paused'
            ? 'Paused: auto-runs were off, so the twin copies the original.'
            : d.coverage === 'pending'
              ? 'Not reviewed yet. Claude has until the session opens.'
              : 'No review before the open, so the twin copies the original.'}
        </p>
      ) : (
        <>
          <div className="adv-filter" role="group" aria-label="Filter verdicts">
            {FILTER_ORDER.map((k) => (
              <button key={k} type="button" className={filter === k ? 'adv-fpill on' : 'adv-fpill'} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {VERDICT_WORD[k]} {d.verdicts.filter((v) => v.verdict === k).length}
              </button>
            ))}
          </div>
          <div className="adv-verdicts">
            {shown.map((v) => (
              <VerdictCard key={v.id} v={v} tag={heldTag(v)} detailed />
            ))}
          </div>
          {filter !== 'agree' && agree.length > 0 && (
            <div className="adv-agree">
              <span className="adv-meta">agree{each}</span>
              {agree.slice(0, AGREE_CHIPS).map((v) => (
                <span key={v.id} className="adv-chip ok">
                  {v.symbol}
                </span>
              ))}
              {agree.length > AGREE_CHIPS && <span className="adv-chip ok">+{agree.length - AGREE_CHIPS}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RecordDots({ record, name }: { record: MethodPayload['record']; name: string }) {
  const pts = record.points;
  if (pts.length === 0) {
    return (
      <section className="adv-record" aria-label="Claude's record">
        <Divider>claude's record on {name.toLowerCase()} · each dot is one objection</Divider>
        <p className="adv-empty">No objection has run its course yet.</p>
      </section>
    );
  }
  const right = pts.filter((p) => p.gap_pts < 0).length;
  const avg = pts.reduce((s, p) => s + p.gap_pts, 0) / pts.length;
  const maxAbs = Math.max(1, ...pts.map((p) => Math.abs(p.gap_pts)));
  const cx = (gap: number) => 400 + (Math.max(-maxAbs, Math.min(maxAbs, gap)) / maxAbs) * 380;
  return (
    <section className="adv-record" aria-label="Claude's record">
      <Divider>claude's record on {name.toLowerCase()} · each dot is one objection</Divider>
      <div className="adv-record-body">
        <div className="adv-record-plot">
          <svg viewBox="0 0 800 70" role="img" aria-label={`${right} of ${pts.length} objected stocks did worse than the picks that were kept`}>
            <line x1="400" y1="6" x2="400" y2="64" className="adv-mid" />
            {pts.map((p, i) => (
              <circle key={`${p.symbol}-${p.session_date}-${i}`} cx={cx(p.gap_pts)} cy="35" r="5" className={p.gap_pts < 0 ? 'adv-hit' : 'adv-miss'}>
                <title>{`${p.symbol} · ${shortDate(p.session_date)} · ${p.gap_pts.toFixed(1)} pts`}</title>
              </circle>
            ))}
          </svg>
          <div className="adv-axis">
            <span>did worse than the kept picks</span>
            <span>same</span>
            <span>did better</span>
          </div>
        </div>
        <div className="adv-record-sum">
          <span className="adv-big">
            {right} of {pts.length} right
          </span>
          <span className="adv-text">
            Over {record.horizon || 'the horizon'} after each objection, the stocks Claude dropped {avg <= 0 ? 'trailed' : 'beat'} the ones it kept by {Math.abs(avg).toFixed(1)} points on average.
            {pts.length < 30 ? ` ${pts.length} calls is still too few to tell skill from luck.` : ''}
          </span>
        </div>
      </div>
    </section>
  );
}

export function Revisions({ revisions }: { revisions: MethodPayload['revisions'] }) {
  return (
    <section className="adv-revs" aria-label="Prompt and model revisions">
      <Divider>revisions · a new line starts whenever the model or the instructions change</Divider>
      {revisions.length === 0 ? (
        <p className="adv-empty">No review has run yet.</p>
      ) : (
        revisions.map((r, i) => (
          <div key={`${r.prompt_version}-${r.since}`} className={i === 0 ? 'adv-rev' : 'adv-rev old'}>
            <span className="adv-dim">{r.until ? `${shortDate(r.since)} – ${shortDate(r.until)}` : `since ${shortDate(r.since)}`}</span>
            <span>
              {r.prompt_version} · {r.model}
            </span>
            {/* Revision.note is always null (phase 5 stores no change note); show what is stored instead. */}
            <span className="adv-rev-note">
              lens {r.lens} · {r.verdicts} {r.verdicts === 1 ? 'verdict' : 'verdicts'}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

export function AdversaryMethod({ detail }: { detail: MethodPayload }) {
  const name = shortName(detail.method.name);
  const twinItems = new Map(detail.checklist.twin.map((i) => [i.rule, i]));
  const original = detail.checklist.original.slice().sort((a, b) => a.rule - b.rule);
  return (
    <div className="adv-method">
      <section className="adv-h2h" aria-label="Original against Claude twin">
        <CurvesChart curves={detail.curves} />
        <StatsTable stats={detail.stats} />
      </section>
      <section className="adv-checklist" aria-label="Go-live checklist">
        <Divider>go-live checklist · Seer's bar for real money</Divider>
        <div className="adv-checks">
          {original.map((item) => (
            <CheckCard key={item.rule} original={item} twin={twinItems.get(item.rule)} />
          ))}
        </div>
      </section>
      {detail.decision === null ? (
        <section className="adv-decision" aria-label="Decision">
          <Divider>decision</Divider>
          <p className="adv-empty">No verdicts yet. Claude reviews this method's next decision after Seer's nightly.</p>
        </section>
      ) : (
        <Decision key={detail.decision.session_date} d={detail.decision} />
      )}
      <RecordDots record={detail.record} name={name} />
      <Revisions revisions={detail.revisions} />
    </div>
  );
}

import type { CVerdict, MethodPayload, ThreeWay, ThreeWayBook } from '../../adversaryApi';
import { claudeBlocks, criticBlocks, disagreement, dropPct, pct, plainName, ratio, shortDate, shortName } from '../../lib/adversary';
import { Revisions } from './AdversaryMethod';
import { Divider, SourceLinks, VerdictChip } from './parts';

const C_CLASS: Record<CVerdict, string> = { veto: 'adv-chip obj', allow: 'adv-chip ok', failed: 'adv-chip unsure' };

/** One of the three books. `book` is null until that book has a record (the twin decides a night late). */
function Book({ id, title, sub, book, inverted = false }: { id: string | null; title: string; sub: string; book: ThreeWayBook | null; inverted?: boolean }) {
  return (
    <div className={inverted ? 'adv-book inv' : 'adv-book'} data-strategy={book?.strategy_id ?? id ?? ''}>
      <div className="adv-book-head">
        <span className="adv-book-t">{title}</span>
        <span className="adv-book-s">{sub}</span>
      </div>
      {book === null ? (
        <span className="adv-meta">no record yet</span>
      ) : (
        <>
          <span className="adv-book-n">{pct(book.return)}</span>
          <div className="adv-book-stats">
            <span>trades</span>
            <span>{book.trades}</span>
            <span>wins ÷ losses</span>
            <span>{ratio(book.profit_factor)}</span>
            <span>worst drop</span>
            <span>{dropPct(book.worst_drop)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** A book's order for this name: true buys, false does not, null has not decided the session yet. */
function BuyDot({ who, buys }: { who: string; buys: boolean | null }) {
  if (buys === null) return <span className="adv-buy-pending" data-tip={`${who} has not decided yet`} />;
  return <span className={buys ? 'adv-buy' : 'adv-nobuy'} data-tip={`${who} ${buys ? 'buys' : 'does not buy'}`} />;
}

function Cell({ n, symbols, inverted }: { n: number; symbols: string[]; inverted: boolean }) {
  return (
    <div className={inverted ? 'adv-cell inv' : 'adv-cell'}>
      <span className="adv-cell-n">{n}</span>
      <span className="adv-cell-s">{symbols.join(' ')}</span>
    </div>
  );
}

function Grid({ tw }: { tw: ThreeWay }) {
  const d = disagreement(tw.rows);
  const critic = shortName(tw.critic.name);
  return (
    <div className="adv-grid-wrap">
      <Divider>tonight · where they disagree</Divider>
      <div className="adv-grid" role="table" aria-label="Where the critics disagree">
        <span />
        <span className="adv-meta">{critic} vetoes</span>
        <span className="adv-meta">{critic} allows</span>
        <span className="adv-meta adv-grid-l">Claude objects</span>
        <Cell n={d.bothBlock.length} symbols={d.bothBlock} inverted={false} />
        <Cell n={d.claudeOnly.length} symbols={d.claudeOnly} inverted />
        <span className="adv-meta adv-grid-l">Claude lets it in</span>
        <Cell n={d.criticOnly.length} symbols={d.criticOnly} inverted />
        <Cell n={d.bothKeep.length} symbols={d.bothKeep} inverted={false} />
      </div>
    </div>
  );
}

function WhoWasRight({ tw, horizon }: { tw: ThreeWay; horizon: string }) {
  const critic = shortName(tw.critic.name);
  const s = tw.settled;
  return (
    <div className="adv-right">
      <Divider>after {horizon || 'the horizon'} · who was right when they disagreed</Divider>
      {s === null || s.disagreements === 0 ? (
        <p className="adv-empty">No disagreement has run its course yet.</p>
      ) : (
        <>
          <div className="adv-bar-row">
            <div className="adv-bar-l">
              <span>Claude's calls against {critic}</span>
              <span className="adv-mono">
                {s.claude_right} of {s.disagreements}
              </span>
            </div>
            <div className="adv-meter">
              <div style={{ width: `${Math.round((s.claude_right / s.disagreements) * 100)}%` }} />
            </div>
          </div>
          <div className="adv-bar-row">
            <div className="adv-bar-l">
              <span>
                {critic}'s calls against Claude
              </span>
              <span className="adv-mono">
                {s.critic_right} of {s.disagreements}
              </span>
            </div>
            <div className="adv-meter dim">
              <div style={{ width: `${Math.round((s.critic_right / s.disagreements) * 100)}%` }} />
            </div>
          </div>
        </>
      )}
      <p className="adv-note-p">Only the nights they disagree can tell them apart. A stock counts as rightly blocked if it did worse over {horizon || 'the horizon'} than the picks that were bought.</p>
    </div>
  );
}

/** A bracket original with a C sibling: three books, one ranked list, two critics side by side. */
export function AdversaryDaily({ detail, tw }: { detail: MethodPayload; tw: ThreeWay }) {
  const name = shortName(detail.method.name);
  const critic = shortName(tw.critic.name);
  const criticSub = plainName(tw.critic.name).toLowerCase() || 'vetoes';
  return (
    <div className="adv-daily">
      <section className="adv-three" aria-label={`${name}, ${critic} and Claude compared`}>
        <Divider>three books, one list · money-weighted over each book's own record</Divider>
        <div className="adv-books">
          <Book id={tw.original.strategy_id} title={name} sub="buys the list as ranked" book={tw.books.original} />
          <Book id={tw.critic.strategy_id} title={critic} sub={criticSub} book={tw.books.critic} />
          <Book id={tw.twin_id} title={`${name} + Claude`} sub="Claude objects" book={tw.books.twin} inverted />
        </div>
      </section>

      <section className="adv-list" aria-label={tw.session_date ? `Ranked list for ${shortDate(tw.session_date)}` : 'Ranked list'}>
        <Divider>
          {tw.session_date ? `${shortDate(tw.session_date).toLowerCase()} · ` : ''}
          {name.toLowerCase()}'s ranked {tw.rows.length} · decided before the open
        </Divider>
        {tw.rows.length === 0 ? (
          <p className="adv-empty">No candidates yet. They arrive with Seer's nightly.</p>
        ) : (
          <>
            <div className="adv-cand adv-cand-h">
              <span>#</span>
              <span>stock</span>
              <span>{critic} · its checks</span>
              <span>Claude</span>
              <span>buys · {name} {critic} +</span>
            </div>
            {tw.rows.map((r) => (
              <div key={r.symbol} className="adv-cand" data-symbol={r.symbol} data-claude-blocks={claudeBlocks(r)} data-critic-blocks={criticBlocks(r)}>
                <span className="adv-meta">{r.rank}</span>
                <span className="adv-cand-sym">{r.symbol}</span>
                <div className="adv-cand-v">
                  {r.c === null ? (
                    <span className="adv-meta">no verdict</span>
                  ) : (
                    <>
                      <span className={C_CLASS[r.c.verdict]}>{r.c.verdict}</span>
                      <span className="adv-cand-r dim">{r.c.reason}</span>
                    </>
                  )}
                </div>
                <div className="adv-cand-v">
                  {r.claude === null ? (
                    <span className="adv-meta">absent</span>
                  ) : (
                    <>
                      <VerdictChip verdict={r.claude.verdict} />
                      <span className="adv-cand-r">{r.claude.reason}</span>
                      <SourceLinks sources={r.claude.sources} />
                      {r.claude.late && <span className="adv-meta">late · not used</span>}
                    </>
                  )}
                </div>
                <span className="adv-buys">
                  <BuyDot who={name} buys={r.buys.original} />
                  <BuyDot who={critic} buys={r.buys.critic} />
                  <BuyDot who={`${name} + Claude`} buys={r.buys.twin} />
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="adv-split" aria-label="Where the critics disagree">
        <Grid tw={tw} />
        <WhoWasRight tw={tw} horizon={detail.record.horizon} />
      </section>
      <Revisions revisions={detail.revisions} />
    </div>
  );
}

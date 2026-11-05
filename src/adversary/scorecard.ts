/**
 * Is Claude useful? (brief §4.2 Scorecard). For each counted objection: the stock's return over the
 * method's own horizon against the mean of the picks Claude kept on the same decision; for a bracket
 * method with a C sibling, Claude against C on the nights they disagree. Read-only, from Seer's bars.
 *
 * Horizon: bracket = the stock's own BRACKET_HORIZON_SESSIONS-th bar from the decision session (A's
 * 5-session time stop); book = the last bar before the original's next decision in strategy_candidates
 * (pending until it exists). Return = horizon close / close on the decision's data_date - 1 (bars are
 * split-adjusted; dividends are not counted). "same" = within SAME_BAND.
 */
import { num, numOrNull, round, str, ymdOrNull, type Row } from '../connectors/seer/rows.js';
import type { ReadOnlySource } from '../connectors/types.js';
import { countedCte, queryAll, toVerdictKind, type RosterEntry } from './readSql.js';
import type { AdversaryRecord, CriticDuel, DuelRow, RecordSummary, ScoreOutcome, VerdictKind } from './readTypes.js';

export const BRACKET_HORIZON_SESSIONS = 5;
export const SAME_BAND = 0.005;

const entryLateral = (a: string): string => `LEFT JOIN LATERAL (
  SELECT e.date, e.close FROM bars e
  WHERE e.symbol = ${a}.symbol AND e.date <= ${a}.data_date
  ORDER BY e.date DESC LIMIT 1
) en ON true`;

/** $1 original id, $2 bracket horizon. Every candidate of every decision that has a counted objection. */
const OBJECTION_ROWS_SQL = `WITH ${countedCte('v.strategy_id = $1')},
dec AS (SELECT DISTINCT session_date FROM counted WHERE verdict = 'object'),
nxt AS (
  SELECT d.session_date,
    (SELECT min(c2.session_date) FROM strategy_candidates c2
      WHERE c2.strategy_id = $1 AND c2.session_date > d.session_date) AS next_session
  FROM dec d
),
cand AS (
  SELECT c.session_date, c.data_date, c.kind, c.rank, c.symbol, k.verdict, n.next_session
  FROM strategy_candidates c
  JOIN nxt n ON n.session_date = c.session_date
  LEFT JOIN counted k ON k.session_date = c.session_date AND k.symbol = c.symbol
  WHERE c.strategy_id = $1
)
SELECT cand.session_date::text AS session_date, cand.data_date::text AS data_date, cand.kind, cand.rank, cand.symbol,
  cand.verdict, cand.next_session::text AS next_session,
  en.date::text AS entry_date, en.close AS entry_close,
  ex.date::text AS exit_date, ex.close AS exit_close, ex.n AS exit_n
FROM cand
${entryLateral('cand')}
LEFT JOIN LATERAL (
  SELECT x.date, x.close, x.n FROM (
    SELECT b.date, b.close, (row_number() OVER (ORDER BY b.date))::int AS n
    FROM bars b
    WHERE b.symbol = cand.symbol AND b.date >= cand.session_date
      AND (cand.kind = 'bracket' OR (cand.next_session IS NOT NULL AND b.date < cand.next_session))
  ) x
  WHERE cand.kind <> 'bracket' OR x.n <= $2::int
  ORDER BY x.date DESC
  LIMIT 1
) ex ON true
ORDER BY cand.session_date, cand.rank`;

/** $1 bracket original, $2 its C sibling, $3 horizon. Both critics' calls on nights they disagree. */
const DUEL_ROWS_SQL = `WITH ${countedCte('v.strategy_id = $1')},
nv AS (
  SELECT session_date, symbol, verdict FROM news_vetoes
  WHERE strategy_id = $2 AND verdict IN ('allow', 'veto')
),
both_ AS (
  SELECT c.session_date, c.data_date, c.rank, c.symbol, k.verdict AS claude, nv.verdict AS c_verdict
  FROM strategy_candidates c
  JOIN counted k ON k.session_date = c.session_date AND k.symbol = c.symbol
  JOIN nv ON nv.session_date = c.session_date AND nv.symbol = c.symbol
  WHERE c.strategy_id = $1
),
nights AS (
  SELECT session_date FROM both_ GROUP BY session_date
  HAVING bool_or((c_verdict = 'veto') <> (claude = 'object'))
)
SELECT b.session_date::text AS session_date, b.data_date::text AS data_date, b.rank, b.symbol, b.claude, b.c_verdict,
  en.date::text AS entry_date, en.close AS entry_close,
  ex.date::text AS exit_date, ex.close AS exit_close, ex.n AS exit_n
FROM both_ b
JOIN nights ON nights.session_date = b.session_date
${entryLateral('b')}
LEFT JOIN LATERAL (
  SELECT x.date, x.close, x.n FROM (
    SELECT b2.date, b2.close, (row_number() OVER (ORDER BY b2.date))::int AS n
    FROM bars b2 WHERE b2.symbol = b.symbol AND b2.date >= b.session_date
  ) x
  WHERE x.n <= $3::int
  ORDER BY x.date DESC
  LIMIT 1
) ex ON true
ORDER BY b.session_date, b.rank`;

export interface HorizonRow {
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  rank: number;
  symbol: string;
  /** Claude's counted verdict; null = not reviewed in time (kept). */
  verdict: VerdictKind | null;
  next_session: string | null;
  entry_date: string | null;
  entry_close: number | null;
  exit_date: string | null;
  exit_close: number | null;
  exit_n: number | null;
}

export interface DuelInputRow {
  session_date: string;
  data_date: string;
  rank: number;
  symbol: string;
  claude: VerdictKind;
  c_verdict: 'allow' | 'veto';
  entry_date: string | null;
  entry_close: number | null;
  exit_date: string | null;
  exit_close: number | null;
  exit_n: number | null;
}

export interface ObjectionScore {
  session_date: string;
  symbol: string;
  rank: number;
  from: string | null;
  to: string | null;
  sessions: number | null;
  stock_return: number | null;
  kept_return: number | null;
  kept: number;
  diff: number | null;
  /** null = pending (its horizon, or every kept pick's, has not passed). */
  outcome: ScoreOutcome | null;
  fell: boolean | null;
}

export function toHorizonRow(r: Row): HorizonRow {
  return {
    session_date: str(r.session_date),
    data_date: str(r.data_date),
    kind: str(r.kind) === 'book' ? 'book' : 'bracket',
    rank: num(r.rank),
    symbol: str(r.symbol),
    verdict: toVerdictKind(r.verdict),
    next_session: ymdOrNull(r.next_session),
    entry_date: ymdOrNull(r.entry_date),
    entry_close: numOrNull(r.entry_close),
    exit_date: ymdOrNull(r.exit_date),
    exit_close: numOrNull(r.exit_close),
    exit_n: numOrNull(r.exit_n),
  };
}

function toDuelInputRow(r: Row): DuelInputRow | null {
  const claude = toVerdictKind(r.claude);
  const c = str(r.c_verdict);
  if (claude === null || (c !== 'allow' && c !== 'veto')) return null;
  return {
    session_date: str(r.session_date),
    data_date: str(r.data_date),
    rank: num(r.rank),
    symbol: str(r.symbol),
    claude,
    c_verdict: c,
    entry_date: ymdOrNull(r.entry_date),
    entry_close: numOrNull(r.entry_close),
    exit_date: ymdOrNull(r.exit_date),
    exit_close: numOrNull(r.exit_close),
    exit_n: numOrNull(r.exit_n),
  };
}

/** The horizon return when the horizon has passed, else null; plus the window it covers. */
export function horizonReturn(r: HorizonRow, horizon: number): { ret: number | null; from: string | null; to: string | null; sessions: number | null } {
  const complete = r.kind === 'bracket' ? r.exit_n === horizon : r.next_session !== null && r.exit_date !== null;
  const ok = complete && r.entry_close !== null && r.entry_close > 0 && r.exit_close !== null;
  return {
    ret: ok ? r.exit_close! / r.entry_close! - 1 : null,
    from: r.entry_date,
    to: r.exit_date,
    sessions: r.exit_n,
  };
}

export function outcomeOf(diff: number | null): ScoreOutcome | null {
  if (diff === null) return null;
  if (diff < -SAME_BAND) return 'worse';
  if (diff > SAME_BAND) return 'better';
  return 'same';
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, v) => a + v, 0) / xs.length);

function bySession<T extends { session_date: string }>(rows: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.session_date, [...(groups.get(r.session_date) ?? []), r]);
  return [...groups.values()];
}

export function scoreObjections(rows: readonly HorizonRow[], horizon: number = BRACKET_HORIZON_SESSIONS): ObjectionScore[] {
  const out: ObjectionScore[] = [];
  for (const group of bySession(rows)) {
    const kept = group
      .filter((r) => r.verdict !== 'object')
      .map((r) => horizonReturn(r, horizon).ret)
      .filter((x): x is number => x !== null);
    const keptReturn = mean(kept);
    for (const r of group) {
      if (r.verdict !== 'object') continue;
      const h = horizonReturn(r, horizon);
      const diff = h.ret !== null && keptReturn !== null ? h.ret - keptReturn : null;
      out.push({
        session_date: r.session_date,
        symbol: r.symbol,
        rank: r.rank,
        from: h.from,
        to: h.to,
        sessions: h.sessions,
        stock_return: round(h.ret, 6),
        kept_return: round(keptReturn, 6),
        kept: kept.length,
        diff: round(diff, 6),
        outcome: outcomeOf(diff),
        fell: h.ret === null ? null : h.ret < 0,
      });
    }
  }
  return out;
}

export function summarize(scores: readonly ObjectionScore[]): RecordSummary {
  const scored = scores.filter((s) => s.outcome !== null);
  const gaps = scored.map((s) => (s.diff ?? 0) * 100);
  return {
    objections: scores.length,
    scored: scored.length,
    worse: scored.filter((s) => s.outcome === 'worse').length,
    same: scored.filter((s) => s.outcome === 'same').length,
    better: scored.filter((s) => s.outcome === 'better').length,
    pending: scores.length - scored.length,
    fell: scored.filter((s) => s.fell === true).length,
    mean_gap_pts: round(mean(gaps), 4),
  };
}

export function recordOf(engine: 'bracket' | 'book', scores: readonly ObjectionScore[]): AdversaryRecord {
  return {
    horizon: engine === 'bracket' ? `the ${BRACKET_HORIZON_SESSIONS} sessions after the decision` : 'until the next rebalance',
    horizon_sessions: engine === 'bracket' ? BRACKET_HORIZON_SESSIONS : null,
    same_band_pts: SAME_BAND * 100,
    points: scores.flatMap((s) =>
      s.outcome === null || s.stock_return === null || s.kept_return === null || s.diff === null
        ? []
        : [
            {
              symbol: s.symbol,
              session_date: s.session_date,
              rank: s.rank,
              gap_pts: round(s.diff * 100, 4) ?? 0,
              outcome: s.outcome,
              stock_return: s.stock_return,
              kept_return: s.kept_return,
              kept: s.kept,
              horizon_from: s.from,
              horizon_to: s.to,
              sessions: s.sessions,
              fell: s.fell === true,
            },
          ],
    ),
    pending: scores.filter((s) => s.outcome === null).map((s) => ({ symbol: s.symbol, session_date: s.session_date })),
    summary: summarize(scores),
  };
}

/** Claude against C (see the module doc). Every disagreement credits exactly one side. */
export function scoreDuel(criticId: string, rows: readonly DuelInputRow[], horizon: number = BRACKET_HORIZON_SESSIONS): CriticDuel {
  const out: DuelRow[] = [];
  const asHorizon = (r: DuelInputRow): HorizonRow => ({ ...r, kind: 'bracket', verdict: r.claude, next_session: null });
  const groups = bySession(rows);
  for (const night of groups) {
    const rets = night.map((r) => horizonReturn(asHorizon(r), horizon).ret);
    const neither = night.flatMap((r, i) => (r.c_verdict !== 'veto' && r.claude !== 'object' && rets[i] !== null ? [rets[i]!] : []));
    const all = rets.filter((x): x is number => x !== null);
    const baseline = mean(neither) ?? mean(all);
    night.forEach((r, i) => {
      const cBlocks = r.c_verdict === 'veto';
      const claudeBlocks = r.claude === 'object';
      if (cBlocks === claudeBlocks) return;
      const blockedBy: 'critic' | 'claude' = cBlocks ? 'critic' : 'claude';
      const ret = rets[i] ?? null;
      const right = ret === null || baseline === null ? null : ret < baseline ? blockedBy : blockedBy === 'critic' ? 'claude' : 'critic';
      out.push({
        session_date: r.session_date,
        symbol: r.symbol,
        rank: r.rank,
        c: r.c_verdict,
        claude: r.claude,
        blocked_by: blockedBy,
        stock_return: round(ret, 6),
        baseline: round(baseline, 6),
        right,
      });
    });
  }
  const scored = out.filter((r) => r.right !== null);
  return {
    critic_id: criticId,
    nights: groups.length,
    disagreements: out.length,
    scored: scored.length,
    claude_right: scored.filter((r) => r.right === 'claude').length,
    critic_right: scored.filter((r) => r.right === 'critic').length,
    pending: out.length - scored.length,
    rows: out,
  };
}

export async function loadObjectionScores(db: ReadOnlySource, original: RosterEntry): Promise<ObjectionScore[]> {
  const rows = await queryAll(db, OBJECTION_ROWS_SQL, [original.id, BRACKET_HORIZON_SESSIONS]);
  return scoreObjections(rows.map(toHorizonRow), BRACKET_HORIZON_SESSIONS);
}

export async function loadDuel(db: ReadOnlySource, original: RosterEntry, critic: RosterEntry): Promise<CriticDuel> {
  const rows = await queryAll(db, DUEL_ROWS_SQL, [original.id, critic.id, BRACKET_HORIZON_SESSIONS]);
  return scoreDuel(
    critic.id,
    rows.flatMap((r) => {
      const d = toDuelInputRow(r);
      return d === null ? [] : [d];
    }),
    BRACKET_HORIZON_SESSIONS,
  );
}

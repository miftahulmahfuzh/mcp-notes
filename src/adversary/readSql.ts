/**
 * Shared pieces of the Seer Adversarial read model (phase 5): SQL fragments, paging, the roster and
 * verdict parsing. Every query goes through a connector ReadOnlySource (a READ ONLY transaction on the
 * direct host from SEER_DIR/.env.local, re-read per call). Nothing here writes; phase 4's SeerWriter is
 * the only writer of the adversary tables. Rows are parsed once here and trusted downstream.
 */
import { engineOf, statusOf, type Engine, type StrategyStatus } from '../connectors/seer/ranking.js';
import { bool, json, num, numOrNull, str, strOrNull, toObjects, ymdOrNull, type Row } from '../connectors/seer/rows.js';
import type { ReadOnlySource } from '../connectors/types.js';
import type { AdversaryMethod, AdversarySource, AdversaryVerdict, Cadence, VerdictKind } from './readTypes.js';

/** The connector's row cap (CONNECTOR_MAX_ROWS); queryAll pages past it. */
export const PAGE_ROWS = 1000;
const MAX_PAGES = 100;

/** session_open_utc(d) (C3): 09:30 America/New_York on d, as timestamptz. Postgres applies DST. */
export function openAt(dateExpr: string): string {
  return `(((${dateExpr})::date + time '09:30') AT TIME ZONE 'America/New_York')`;
}

/** A timestamptz as ISO 8601 UTC with milliseconds, independent of the session TimeZone. */
export function isoOf(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * CTE `counted`: per (strategy, session, symbol) the verdict the engine reads (C3): the greatest
 * decided_at before the session's open. superseded_by is history only and is not consulted.
 */
export function countedCte(filter: string): string {
  return `counted AS (
  SELECT DISTINCT ON (v.strategy_id, v.session_date, v.symbol) v.*
  FROM adversary_verdicts v
  WHERE v.decided_at < ${openAt('v.session_date')} AND (${filter})
  ORDER BY v.strategy_id, v.session_date, v.symbol, v.decided_at DESC, v.id DESC
)`;
}

/** The verdict columns every card needs, from table alias `a`. */
export function verdictColumns(a: string): string {
  return `${a}.id, ${a}.strategy_id, ${a}.session_date::text AS session_date, ${a}.symbol, ${a}.verdict, ${a}.reason,
  ${a}.sources, ${a}.lens, ${a}.model, ${a}.prompt_version, ${a}.host,
  ${isoOf(`${a}.started_at`)} AS started_at, ${isoOf(`${a}.decided_at`)} AS decided_at,
  (${a}.decided_at >= ${openAt(`${a}.session_date`)}) AS late`;
}

/** The same columns as one json object, for json_agg inside a one-row query. */
export function verdictJson(a: string): string {
  return `json_build_object(
    'id', ${a}.id, 'strategy_id', ${a}.strategy_id, 'session_date', ${a}.session_date::text, 'symbol', ${a}.symbol,
    'verdict', ${a}.verdict, 'reason', ${a}.reason, 'sources', ${a}.sources, 'lens', ${a}.lens, 'model', ${a}.model,
    'prompt_version', ${a}.prompt_version, 'host', ${a}.host,
    'started_at', ${isoOf(`${a}.started_at`)}, 'decided_at', ${isoOf(`${a}.decided_at`)},
    'late', ${a}.decided_at >= ${openAt(`${a}.session_date`)})`;
}

/**
 * Every row of `sql`, which must end with an ORDER BY that orders rows completely: pages of PAGE_ROWS
 * through LIMIT/OFFSET (each page is its own read-only transaction).
 */
export async function queryAll(db: ReadOnlySource, sql: string, params: readonly unknown[] = []): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await db.query(`${sql}\nLIMIT ${PAGE_ROWS} OFFSET ${page * PAGE_ROWS}`, params, { maxRows: PAGE_ROWS });
    const rows = toObjects(res);
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
  throw new Error(`query returned more than ${MAX_PAGES * PAGE_ROWS} rows`);
}

/** A json array of objects (json_agg output), parsed or text; anything else reads as []. */
export function records(v: unknown): Row[] {
  const raw = json(v);
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** A json array of strings; anything else reads as []. */
export function strings(v: unknown): string[] {
  const raw = json(v);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** A json array of [text, number] pairs (dates or symbols with an amount). */
export function pairsOf(v: unknown): [string | null, number][] {
  const raw = json(v);
  if (!Array.isArray(raw)) return [];
  const out: [string | null, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    out.push([p[0] === null || p[0] === undefined ? null : String(p[0]), Number(p[1])]);
  }
  return out;
}

/** What the read model needs from a strategies row. */
export interface RosterEntry {
  id: string;
  name: string;
  sub: string;
  engine: Engine;
  isBenchmark: boolean;
  status: StrategyStatus;
  sort: number;
  twinOf: string | null;
  objectName: string | null;
  rulesId: string | null;
  paperStart: string | null;
  paperEnd: string | null;
  /** params->'backtest_gate', unparsed (golive.parseGate reads it). */
  gate: unknown;
}

export const ROSTER_SQL = `SELECT id, name, sub, engine, is_benchmark, status, sort, twin_of, object_name, rules_id,
  paper_start::text AS paper_start, paper_end::text AS paper_end, params->'backtest_gate' AS gate
FROM strategies
ORDER BY sort, id`;

export function toRosterEntry(r: Row): RosterEntry {
  const isBenchmark = bool(r.is_benchmark);
  return {
    id: str(r.id),
    name: str(r.name),
    sub: str(r.sub),
    engine: engineOf(r.engine, isBenchmark),
    isBenchmark,
    status: statusOf(r.status),
    sort: num(r.sort),
    twinOf: strOrNull(r.twin_of),
    objectName: strOrNull(r.object_name),
    rulesId: strOrNull(r.rules_id),
    paperStart: ymdOrNull(r.paper_start),
    paperEnd: ymdOrNull(r.paper_end),
    gate: json(r.gate),
  };
}

export async function readRoster(db: ReadOnlySource): Promise<RosterEntry[]> {
  return toObjects(await db.query(ROSTER_SQL, [], { maxRows: PAGE_ROWS })).map(toRosterEntry);
}

/**
 * RESOLVER keys of LLM critics (Seer's NewsVeto, i.e. C): never reviewed, never twinned (C2), shown only
 * as the three-way's critic. Seer web's checksNews reads the same key. RESOLVER keys are stable forever.
 */
export const NEWS_VETO_OBJECTS: readonly string[] = ['STRATEGY_C'];

/** Display cadence: a bracket decides daily; a book's comes from its own description. */
export function cadenceOf(engine: Engine, sub: string): Cadence | null {
  if (engine === 'bracket') return 'daily';
  if (/quarter/i.test(sub)) return 'quarterly';
  if (/month/i.test(sub)) return 'monthly';
  if (/week/i.test(sub)) return 'weekly';
  if (/\bdaily\b|each day|every day/i.test(sub)) return 'daily';
  return null;
}

/** Seer web lib/strategy.ts shortLabel: the name's head before ' · ', else the id. */
export function shortLabel(name: string, id: string): string {
  const head = (name.split('·')[0] ?? '').trim();
  return head === '' ? id : head;
}

export interface Pairing {
  original: RosterEntry;
  twin: RosterEntry | null;
}

export interface RosterView {
  /** Every original: active by sort then id, then retired by paper_end desc. */
  pairs: Pairing[];
  spy: RosterEntry | null;
  all: RosterEntry[];
}

export function methodOf(p: Pairing): AdversaryMethod {
  const o = p.original;
  return {
    strategy_id: o.id,
    twin_id: p.twin?.id ?? null,
    name: o.name,
    short: shortLabel(o.name, o.id),
    sub: o.sub === '' ? null : o.sub,
    engine: o.engine === 'book' ? 'book' : 'bracket',
    cadence: cadenceOf(o.engine, o.sub),
    status: o.status,
    paper_start: o.paperStart,
    paper_end: o.paperEnd,
  };
}

const bySortThenId = (a: RosterEntry, b: RosterEntry): number =>
  a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isCritic = (r: RosterEntry): boolean => NEWS_VETO_OBJECTS.includes(r.objectName ?? '');

/**
 * Originals are research rows that are not twins and not critics; a retired one is listed only when it
 * traded (paper_end set, Seer's boardStrategies rule). Never hard-codes an id (invariant 5).
 */
export function pairRoster(roster: readonly RosterEntry[]): RosterView {
  const twinsOf = new Map<string, RosterEntry[]>();
  for (const r of roster) {
    if (r.twinOf === null) continue;
    twinsOf.set(r.twinOf, [...(twinsOf.get(r.twinOf) ?? []), r]);
  }
  const twinOf = (id: string): RosterEntry | null => {
    const twins = twinsOf.get(id) ?? [];
    const active = twins.find((t) => t.status === 'active');
    if (active !== undefined) return active;
    const retired = [...twins].sort((a, b) => ((b.paperStart ?? '') < (a.paperStart ?? '') ? -1 : (b.paperStart ?? '') > (a.paperStart ?? '') ? 1 : 0));
    return retired[0] ?? null;
  };
  const originals = roster.filter(
    (r) => !r.isBenchmark && r.twinOf === null && !isCritic(r) && (r.status === 'active' || r.paperEnd !== null),
  );
  const active = originals.filter((r) => r.status === 'active').sort(bySortThenId);
  const retired = originals
    .filter((r) => r.status === 'retired')
    .sort((a, b) => ((b.paperEnd ?? '') < (a.paperEnd ?? '') ? -1 : (b.paperEnd ?? '') > (a.paperEnd ?? '') ? 1 : bySortThenId(a, b)));
  const benchmarks = roster
    .filter((r) => r.isBenchmark)
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || bySortThenId(a, b));
  return {
    pairs: [...active, ...retired].map((original) => ({ original, twin: twinOf(original.id) })),
    spy: benchmarks[0] ?? null,
    all: [...roster],
  };
}

/** The pairing for an id in any case; a twin's id resolves to its original. */
export function findPairing(view: RosterView, id: string): Pairing | null {
  const want = id.trim().toUpperCase();
  const row = view.all.find((r) => r.id.toUpperCase() === want);
  if (row === undefined) return null;
  const originalId = row.twinOf ?? row.id;
  return view.pairs.find((p) => p.original.id === originalId) ?? null;
}

/** The C sibling of a bracket original: a critic on the same rule set (prefer the active one). */
export function criticOf(view: RosterView, original: RosterEntry): RosterEntry | null {
  if (original.engine !== 'bracket') return null;
  const critics = view.all.filter((r) => r.engine === 'bracket' && r.twinOf === null && isCritic(r) && r.rulesId === original.rulesId);
  return critics.find((r) => r.status === 'active') ?? critics[0] ?? null;
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** adversary_verdicts.sources: entries without a url are dropped. */
export function parseSources(v: unknown): AdversarySource[] {
  const out: AdversarySource[] = [];
  for (const s of records(v)) {
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (url === '') continue;
    out.push({
      url,
      title: textOrNull(s.title),
      publisher: textOrNull(s.publisher),
      published_at: textOrNull(s.published_at),
      fetched_at: textOrNull(s.fetched_at),
    });
  }
  return out;
}

export function toVerdictKind(v: unknown): VerdictKind | null {
  return v === 'agree' || v === 'object' || v === 'unsure' ? v : null;
}

/** One verdict row (verdictColumns or verdictJson) as a card with no decision context. */
export function toAdversaryVerdict(r: Row, rank: number | null): AdversaryVerdict | null {
  const verdict = toVerdictKind(r.verdict);
  const id = numOrNull(r.id);
  if (verdict === null || id === null) return null;
  return {
    id,
    strategy_id: str(r.strategy_id),
    session_date: str(r.session_date).slice(0, 10),
    symbol: str(r.symbol),
    rank,
    verdict,
    reason: str(r.reason),
    sources: parseSources(r.sources),
    lens: str(r.lens),
    model: str(r.model),
    prompt_version: str(r.prompt_version),
    host: str(r.host),
    started_at: str(r.started_at),
    decided_at: str(r.decided_at),
    late: bool(r.late),
    weight: null,
    twin_weight: null,
    twin_weight_source: null,
    held: null,
    action: null,
  };
}

export type AdversaryReadErrorCode = 'not_found' | 'not_bracket' | 'invalid_session';

/** A read the caller asked wrongly (HTTP 404/400, MCP error text). Message is user-facing. */
export class AdversaryReadError extends Error {
  override name = 'AdversaryReadError';
  constructor(
    readonly code: AdversaryReadErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** A real calendar date written YYYY-MM-DD. */
export function isSessionDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function assertSession(s: string): string {
  if (!isSessionDate(s)) throw new AdversaryReadError('invalid_session', `"${s}" is not a date like 2026-11-04`);
  return s;
}

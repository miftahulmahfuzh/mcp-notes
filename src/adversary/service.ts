import { join } from 'node:path';
import type { AdversaryConfig } from '../config.js';
import { createConnector } from '../connectors/connector.js';
import { connectorSettings, resolveRepoDir } from '../connectors/env.js';
import { reasonOf } from '../connectors/errors.js';
import type { Db } from '../db/client.js';
import type { AdversaryStoredVerdict } from '../db/schema.js';
import { SessionsRepo } from '../sessions/repo.js';
import { ADVERSARY_SUBDIR, createAgentReviewer } from './agent.js';
import { AdversaryEvents } from './events.js';
import { BRIEFS_DIR, buildLens, readBrief } from './lens.js';
import {
  DRAFT_WINDOW_MS,
  decisionKey,
  planWork,
  reviewableOriginals,
  toDecisions,
  toPreviewDecisions,
  type PlannedAction,
} from './plan.js';
import { promptVersion } from './prompt.js';
import { ReviewsRepo, type NewReview } from './reviewsRepo.js';
import { SeerReader } from './seerReader.js';
import { SeerWriter } from './seerWriter.js';
import { addDays, utcDate, wibDayStartUtc } from './sessions.js';
import { readToggle, writeToggle, type ToggleState } from './toggle.js';
import { adversaryServer, createTickerCikLookup, defaultLimiters, loadSeerKeys } from './tools.js';
import { ReviewFailure, type Decision, type Lens, type ReviewOutcome, type RosterRow, type StockReviewer } from './types.js';

export type RunTrigger = 'auto' | 'manual';
export type SchemaState = 'unknown' | 'ready' | 'missing' | 'unreachable';

export interface ReviewNowOptions {
  strategyId?: string;
  sessionDate?: string;
  /** Re-review symbols that already have a verdict; the new verdict supersedes the old. */
  rereview?: boolean;
}

export interface RunSummary {
  trigger: RunTrigger;
  host: string;
  started_at: string;
  finished_at: string | null;
  /** Final verdicts written to Seer after a deep review. */
  reviewed: number;
  /** Final verdicts written to Seer from an earlier draft (no tokens). */
  reused: number;
  /** Draft reviews of a book's next rebalance (never written to Seer). */
  drafted: number;
  failed: number;
  /** Written, but decided after the session opened (the engine ignores them). */
  late: number;
  skipped_budget: number;
  /** Paused marks written while auto runs were off. */
  marks: number;
  /** Decisions another host was reviewing. */
  leases_lost: number;
  error: string | null;
}

export interface AdversaryStatus {
  host: string;
  auto: ToggleState;
  running: RunTrigger | null;
  schema: SchemaState;
  daily_cap: number;
  used_today: number;
  next_poll_at: string | null;
  last_run: RunSummary | null;
  models: { gather: string; verdict: string };
}

export interface AdversaryServiceOptions {
  config: AdversaryConfig;
  db: Db;
  /** os.hostname(): written on leases, verdicts, marks and review rows. */
  host: string;
  reviewer: StockReviewer;
  seer: SeerReader;
  writer: SeerWriter;
  now?: () => Date;
  log?: (line: string) => void;
  briefsDir?: string;
}

const CLOSE_GRACE_MS = 5_000;
const INITIAL_DELAY_MS = 30_000;

type ReviewAction = Exclude<PlannedAction, { type: 'skip_budget' }>;

function emptySummary(trigger: RunTrigger, host: string, now: Date): RunSummary {
  return {
    trigger,
    host,
    started_at: now.toISOString(),
    finished_at: null,
    reviewed: 0,
    reused: 0,
    drafted: 0,
    failed: 0,
    late: 0,
    skipped_budget: 0,
    marks: 0,
    leases_lost: 0,
    error: null,
  };
}

/**
 * Seer Adversarial's reviewer (R4). Reads Seer through SeerReader, writes only through SeerWriter
 * (contract C4), logs every attempt in adversary_reviews, and emits AdversaryEvents after each
 * committed write. Phase 5 calls reviewNow / getToggle / setToggle / status.
 */
export class AdversaryService {
  readonly events = new AdversaryEvents();
  private readonly settings: SessionsRepo;
  private readonly reviews: ReviewsRepo;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly briefsDir: string;
  private readonly controller = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextPollAt: Date | null = null;
  private started = false;
  private closed = false;
  private running: RunTrigger | null = null;
  private schema: SchemaState = 'unknown';
  private lastRun: RunSummary | null = null;
  private lastLogged: string | null = null;

  constructor(private readonly opts: AdversaryServiceOptions) {
    this.settings = new SessionsRepo(opts.db);
    this.reviews = new ReviewsRepo(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.briefsDir = opts.briefsDir ?? BRIEFS_DIR;
  }

  get host(): string {
    return this.opts.host;
  }

  /** A lease outlives one stock's review with room to spare; it is renewed after every stock. */
  private get leaseMs(): number {
    return 2 * this.opts.config.stockTimeoutMs + 60_000;
  }

  /** Starts the poll loop (background.ts). The first pass runs after min(30 s, pollMs). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(Math.min(INITIAL_DELAY_MS, this.opts.config.pollMs));
  }

  /** One automatic pass now (obeys the toggle). */
  pollNow(): Promise<RunSummary> {
    return this.enqueue('auto', {});
  }

  /** One manual pass now: runs even while auto runs are off ("Review now"). Do not await it in a request handler. */
  reviewNow(options: ReviewNowOptions = {}): Promise<RunSummary> {
    return this.enqueue('manual', options);
  }

  async getToggle(): Promise<ToggleState> {
    return readToggle(this.settings);
  }

  async setToggle(on: boolean, host: string): Promise<ToggleState> {
    const state = await writeToggle(this.settings, on, host, this.now());
    this.events.emit({ op: 'toggle' });
    if (on && this.started) this.schedule(0);
    return state;
  }

  async status(): Promise<AdversaryStatus> {
    const [auto, used] = await Promise.all([this.getToggle(), this.reviews.countDeepSince(wibDayStartUtc(this.now()))]);
    return {
      host: this.opts.host,
      auto,
      running: this.running,
      schema: this.schema,
      daily_cap: this.opts.config.dailyCap,
      used_today: used,
      next_poll_at: this.nextPollAt === null ? null : this.nextPollAt.toISOString(),
      last_run: this.lastRun,
      models: { gather: this.opts.reviewer.gatherModel, verdict: this.opts.reviewer.verdictModel },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
    this.controller.abort('closed');
    await Promise.race([this.chain, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextPollAt = new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollNow().finally(() => this.schedule(this.opts.config.pollMs));
    }, delayMs);
    this.timer.unref();
  }

  private enqueue(trigger: RunTrigger, options: ReviewNowOptions): Promise<RunSummary> {
    const run = this.chain.then(() => this.pass(trigger, options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private logChanged(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.log(line);
  }

  private async pass(trigger: RunTrigger, options: ReviewNowOptions): Promise<RunSummary> {
    const summary = emptySummary(trigger, this.opts.host, this.now());
    if (this.closed) {
      summary.error = 'notesd is shutting down';
      summary.finished_at = this.now().toISOString();
      return summary;
    }
    this.running = trigger;
    this.events.emit({ op: 'run' });
    try {
      await this.passBody(trigger, options, summary);
      this.logChanged('[notesd] adversary: Seer is reachable and ready');
    } catch (err) {
      summary.error = reasonOf(err);
      this.logChanged(`[notesd] adversary: ${summary.error}`);
    } finally {
      this.running = null;
      summary.finished_at = this.now().toISOString();
      this.lastRun = summary;
      this.events.emit({ op: 'run' });
    }
    const did = summary.reviewed + summary.reused + summary.drafted + summary.failed + summary.skipped_budget + summary.marks;
    if (did > 0) {
      this.log(
        `[notesd] adversary ${trigger} pass: ${summary.reviewed} reviewed, ${summary.reused} reused, ${summary.drafted} drafted, ${summary.failed} failed, ${summary.late} late, ${summary.skipped_budget} over the cap, ${summary.marks} paused marks`,
      );
    }
    return summary;
  }

  private async passBody(trigger: RunTrigger, options: ReviewNowOptions, summary: RunSummary): Promise<void> {
    const { seer } = this.opts;
    let ready: boolean;
    try {
      ready = await seer.schemaReady();
    } catch (err) {
      this.schema = 'unreachable';
      throw err;
    }
    if (!ready) {
      this.schema = 'missing';
      throw new Error("Seer's database has no adversary tables yet (Seer migration 027 is not applied); idling");
    }
    this.schema = 'ready';

    const now = this.now();
    const fromDate = addDays(utcDate(now), -1);
    const originals = reviewableOriginals(await seer.roster());
    if (originals.length === 0) return;
    const ids = originals.map((r) => r.id);
    const [candidateRows, verdictRefs] = await Promise.all([seer.candidates(fromDate, ids), seer.verdictsFrom(fromDate, ids)]);
    const decisions = toDecisions(candidateRows, now);
    const verdicts = new Map<string, Map<string, number>>();
    for (const v of verdictRefs) {
      const key = decisionKey(v.strategyId, v.sessionDate);
      let bySymbol = verdicts.get(key);
      if (bySymbol === undefined) {
        bySymbol = new Map();
        verdicts.set(key, bySymbol);
      }
      bySymbol.set(v.symbol, v.id);
    }

    if (trigger === 'auto' && !(await this.getToggle()).on) {
      await this.writePausedMarks(decisions, verdicts, fromDate, ids, summary);
      return;
    }

    const decided = new Set(candidateRows.map((r) => decisionKey(r.strategyId, r.sessionDate)));
    const previews = toPreviewDecisions(await seer.previews(fromDate, ids), decided, now);
    const lenses = await this.lensesFor(originals);
    const promptVersions = new Map<string, string>();
    for (const [id, lens] of lenses) {
      promptVersions.set(id, promptVersion(lens, this.opts.reviewer.gatherModel, this.opts.reviewer.verdictModel));
    }
    const recent = await this.reviews.recent(new Date(now.getTime() - DRAFT_WINDOW_MS), wibDayStartUtc(now));
    const actions = planWork({
      decisions,
      previews,
      promptVersions,
      verdicts,
      drafts: recent.drafts,
      failures: recent.failures,
      skippedToday: recent.skippedToday,
      used: recent.usedToday,
      cap: this.opts.config.dailyCap,
      rereview: options.rereview === true,
      only: { strategyId: options.strategyId, sessionDate: options.sessionDate },
    });
    const byId = new Map(originals.map((r) => [r.id, r] as const));
    await this.execute(actions, byId, lenses, promptVersions, summary);
  }

  /**
   * A lens per original. A strategy whose lab method cannot be read right now is left out of this
   * pass rather than reviewed under a different lens (which would show as a spurious revision).
   */
  private async lensesFor(originals: readonly RosterRow[]): Promise<Map<string, Lens>> {
    const out = new Map<string, Lens>();
    for (const row of originals) {
      try {
        const [lab, brief] = await Promise.all([
          row.promotedFrom === null ? Promise.resolve(null) : this.opts.seer.labMethod(row.promotedFrom),
          readBrief(row.objectName, this.briefsDir),
        ]);
        out.set(row.id, buildLens(row, lab, brief));
      } catch (err) {
        this.log(`[notesd] adversary: skipping ${row.id} this pass, its lens could not be built: ${reasonOf(err)}`);
      }
    }
    return out;
  }

  private async writePausedMarks(
    decisions: readonly Decision[],
    verdicts: ReadonlyMap<string, ReadonlyMap<string, number>>,
    fromDate: string,
    ids: readonly string[],
    summary: RunSummary,
  ): Promise<void> {
    const marked = new Set((await this.opts.seer.marksFrom(fromDate, ids)).map((m) => decisionKey(m.strategyId, m.sessionDate)));
    for (const decision of decisions) {
      const key = decisionKey(decision.strategyId, decision.sessionDate);
      if (verdicts.has(key) || marked.has(key)) continue;
      if (await this.opts.writer.insertMark(decision.strategyId, decision.sessionDate, this.opts.host)) {
        summary.marks += 1;
        this.events.emit({ op: 'mark', strategy_id: decision.strategyId, session_date: decision.sessionDate });
      }
    }
  }

  private async execute(
    actions: readonly PlannedAction[],
    originals: ReadonlyMap<string, RosterRow>,
    lenses: ReadonlyMap<string, Lens>,
    promptVersions: ReadonlyMap<string, string>,
    summary: RunSummary,
  ): Promise<void> {
    const groups: PlannedAction[][] = [];
    for (const action of actions) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last[0]?.decision === action.decision) last.push(action);
      else groups.push([action]);
    }
    const { writer } = this.opts;
    for (const group of groups) {
      if (this.closed) return;
      const decision = group[0]?.decision;
      if (decision === undefined) continue;
      const strategy = originals.get(decision.strategyId);
      const lens = lenses.get(decision.strategyId);
      const pv = promptVersions.get(decision.strategyId);
      if (strategy === undefined || lens === undefined || pv === undefined) continue;

      for (const action of group) if (action.type === 'skip_budget') await this.recordSkip(action.decision, action.pick.symbol, pv, summary);
      const work = group.filter((a): a is ReviewAction => a.type !== 'skip_budget');
      if (work.length === 0) continue;

      if (!(await writer.claimLease(decision.strategyId, decision.sessionDate, this.opts.host, this.leaseMs))) {
        summary.leases_lost += 1;
        continue;
      }
      try {
        const held = decision.kind === 'book' ? new Set(await this.opts.seer.heldSymbols(decision.strategyId)) : null;
        for (const action of work) {
          if (this.closed) break;
          // Never start a review once its session has opened: it could not count (honesty §5).
          if (decision.stage === 'final' && this.now().getTime() >= decision.openUtc.getTime()) break;
          await this.runAction(action, strategy, lens, pv, held, summary);
          if (!(await writer.renewLease(decision.strategyId, decision.sessionDate, this.opts.host, this.leaseMs))) {
            summary.leases_lost += 1;
            break;
          }
        }
      } finally {
        await writer
          .releaseLease(decision.strategyId, decision.sessionDate, this.opts.host)
          .catch((err: unknown) => this.log(`[notesd] adversary: could not release the lease of ${decision.strategyId} ${decision.sessionDate}: ${reasonOf(err)}`));
      }
    }
  }

  private async recordSkip(decision: Decision, symbol: string, pv: string, summary: RunSummary): Promise<void> {
    const at = this.now();
    await this.reviews.insert({
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol,
      stage: decision.stage,
      status: 'skipped_budget',
      verdict: null,
      promptVersion: pv,
      gatherModel: null,
      verdictModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
      error: `daily cap of ${this.opts.config.dailyCap} deep reviews reached`,
      host: this.opts.host,
      reusedFrom: null,
      startedAt: at,
      finishedAt: at,
    });
    summary.skipped_budget += 1;
  }

  private async runAction(action: ReviewAction, strategy: RosterRow, lens: Lens, pv: string, held: ReadonlySet<string> | null, summary: RunSummary): Promise<void> {
    if (action.type === 'reuse') {
      await this.reuseDraft(action, pv, summary);
      return;
    }
    const { decision, pick } = action;
    const base = {
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol: pick.symbol,
      stage: decision.stage,
      promptVersion: pv,
      host: this.opts.host,
    };
    const startedAt = this.now();
    let outcome: ReviewOutcome;
    try {
      outcome = await this.opts.reviewer.review(
        { strategy, lens, promptVersion: pv, decision, pick, held: held === null ? null : held.has(pick.symbol), now: startedAt },
        this.controller.signal,
      );
    } catch (err) {
      const usage = err instanceof ReviewFailure ? err.usage : null;
      await this.reviews.insert({
        ...base,
        status: 'failed',
        verdict: null,
        gatherModel: usage?.gatherModel ?? this.opts.reviewer.gatherModel,
        verdictModel: usage?.verdictModel ?? null,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage?.costUsd ?? 0,
        turns: usage?.turns ?? 0,
        error: reasonOf(err),
        reusedFrom: null,
        startedAt,
        finishedAt: this.now(),
      });
      summary.failed += 1;
      this.log(`[notesd] adversary: ${decision.strategyId} ${decision.sessionDate} ${pick.symbol} failed: ${reasonOf(err)}`);
      return;
    }

    const stored: AdversaryStoredVerdict = {
      verdict: outcome.verdict.verdict,
      reason: outcome.verdict.reason,
      sources: outcome.verdict.sources,
      lens: lens.id,
      seer_verdict_id: null,
      downgraded: outcome.downgraded,
    };
    const spent = {
      gatherModel: outcome.usage.gatherModel,
      verdictModel: outcome.usage.verdictModel,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: outcome.usage.costUsd,
      turns: outcome.usage.turns,
    };

    if (decision.stage === 'draft') {
      await this.reviews.insert({ ...base, ...spent, status: 'ok', verdict: stored, error: null, reusedFrom: null, startedAt, finishedAt: this.now() });
      summary.drafted += 1;
      return;
    }

    let written: { id: number; decidedAt: string };
    try {
      written = await this.opts.writer.insertVerdict(
        {
          strategyId: decision.strategyId,
          sessionDate: decision.sessionDate,
          symbol: pick.symbol,
          verdict: stored.verdict,
          reason: stored.reason,
          sources: stored.sources,
          lens: lens.id,
          model: outcome.usage.verdictModel,
          promptVersion: pv,
          host: this.opts.host,
          startedAt,
        },
        action.supersedes,
      );
    } catch (err) {
      await this.reviews.insert({
        ...base,
        ...spent,
        status: 'failed',
        verdict: stored,
        error: `the verdict could not be written to Seer: ${reasonOf(err)}`,
        reusedFrom: null,
        startedAt,
        finishedAt: this.now(),
      });
      summary.failed += 1;
      return;
    }
    const late = Date.parse(written.decidedAt) >= decision.openUtc.getTime();
    await this.reviews.insert({
      ...base,
      ...spent,
      status: late ? 'late' : 'ok',
      verdict: { ...stored, seer_verdict_id: written.id },
      error: null,
      reusedFrom: null,
      startedAt,
      finishedAt: this.now(),
    });
    summary.reviewed += 1;
    if (late) summary.late += 1;
    this.events.emit({ op: 'verdict', strategy_id: decision.strategyId, session_date: decision.sessionDate });
    this.log(
      `[notesd] adversary: ${decision.strategyId} ${decision.sessionDate} ${pick.symbol} -> ${stored.verdict}${late ? ' (late)' : ''} (${spent.turns} turns, $${spent.costUsd.toFixed(2)})`,
    );
  }

  private async reuseDraft(action: Extract<PlannedAction, { type: 'reuse' }>, pv: string, summary: RunSummary): Promise<void> {
    const { decision, pick, draft } = action;
    const at = this.now();
    const model = draft.verdictModel ?? this.opts.reviewer.verdictModel;
    const base: Omit<NewReview, 'status' | 'verdict' | 'error'> = {
      strategyId: decision.strategyId,
      sessionDate: decision.sessionDate,
      symbol: pick.symbol,
      stage: 'final',
      promptVersion: pv,
      gatherModel: draft.gatherModel,
      verdictModel: model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
      host: this.opts.host,
      reusedFrom: draft.id,
      startedAt: at,
      finishedAt: at,
    };
    let written: { id: number; decidedAt: string };
    try {
      written = await this.opts.writer.insertVerdict(
        {
          strategyId: decision.strategyId,
          sessionDate: decision.sessionDate,
          symbol: pick.symbol,
          verdict: draft.verdict.verdict,
          reason: draft.verdict.reason,
          sources: draft.verdict.sources,
          lens: draft.verdict.lens,
          model,
          promptVersion: pv,
          host: this.opts.host,
          startedAt: draft.startedAt,
        },
        action.supersedes,
      );
    } catch (err) {
      await this.reviews.insert({ ...base, status: 'failed', verdict: draft.verdict, error: `the draft could not be written to Seer: ${reasonOf(err)}` });
      summary.failed += 1;
      return;
    }
    const late = Date.parse(written.decidedAt) >= decision.openUtc.getTime();
    await this.reviews.insert({ ...base, status: late ? 'late' : 'ok', verdict: { ...draft.verdict, seer_verdict_id: written.id }, error: null });
    summary.reused += 1;
    if (late) summary.late += 1;
    this.events.emit({ op: 'verdict', strategy_id: decision.strategyId, session_date: decision.sessionDate });
  }
}

export interface CreateAdversaryServiceOptions {
  config: AdversaryConfig;
  db: Db;
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  dataDir: string;
  host: string;
  log?: (line: string) => void;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * The production wiring: Seer found through SEER_DIR (src/connectors/env.ts, re-read on every
 * call), data-tool keys from SEER_DIR/.env.local, the Agent SDK reviewer. Null when the claude
 * binary cannot be found.
 */
export function createAdversaryService(opts: CreateAdversaryServiceOptions): AdversaryService | null {
  const seerDir = (): string => resolveRepoDir('seer', connectorSettings());
  const seer = new SeerReader(createConnector('seer'));
  const limiters = defaultLimiters();
  const tickerCik = createTickerCikLookup(seerDir);
  const reviewer = createAgentReviewer({
    claudeBin: opts.claudeBin,
    cwd: join(opts.dataDir, ADVERSARY_SUBDIR),
    gatherModel: opts.config.gatherModel,
    verdictModel: opts.config.verdictModel,
    gatherMaxTurns: opts.config.gatherMaxTurns,
    timeoutMs: opts.config.stockTimeoutMs,
    baseEnv: opts.baseEnv,
    tools: (scope) =>
      adversaryServer(
        { fetch: (input, init) => fetch(input, init), keys: loadSeerKeys(seerDir()), limiters, seer, tickerCik, now: () => new Date() },
        scope,
      ),
  });
  if (reviewer === null) return null;
  return new AdversaryService({
    config: opts.config,
    db: opts.db,
    host: opts.host,
    reviewer,
    seer,
    writer: new SeerWriter({ repoDir: seerDir }),
    log: opts.log,
  });
}

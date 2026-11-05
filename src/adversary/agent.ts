import { mkdir } from 'node:fs/promises';
import { query as sdkQuery, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { QueryFn } from '../chat/agent.js';
import { claudeEnv } from '../chat/env.js';
import { findClaudeBin } from '../sessions/summarize.js';
import { GATHER_SYSTEM, REASON_MAX_CHARS, VERDICT_SYSTEM, gatherPrompt, verdictPrompt } from './prompt.js';
import { ADVERSARY_MCP_SERVER, SourceLedger, type ReviewTools, type ToolScope } from './tools.js';
import { ReviewFailure, type ReviewContext, type ReviewOutcome, type ReviewUsage, type ReviewVerdict, type Source, type StockReviewer } from './types.js';

/** `<dataDir>/adversary`: the fixed cwd of every reviewer run (nothing is persisted there). */
export const ADVERSARY_SUBDIR = 'adversary';
/** The verdict stage has no tools; structured output may take a retry turn. */
export const VERDICT_MAX_TURNS = 4;
export const MAX_DOSSIER_CHARS = 12_000;
export const MAX_CITED_URLS = 10;

export const VerdictSchema = z.object({
  verdict: z.enum(['agree', 'object', 'unsure']),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
  source_urls: z.array(z.string()).max(MAX_CITED_URLS),
});
export type RawVerdict = z.infer<typeof VerdictSchema>;
// draft-07, not zod's default 2020-12: the Claude Code CLI refuses `--json-schema` whose
// $schema it cannot resolve ("no schema with key or ref .../draft/2020-12/schema"), found by the
// phase 4 paid Proof journey.
export const VERDICT_JSON_SCHEMA = z.toJSONSchema(VerdictSchema, { target: 'draft-7' }) as Record<string, unknown>;

export interface AgentReviewerOptions {
  /** `config.chat.claudeBin`. */
  claudeBin: string;
  /** `<dataDir>/adversary`; created on first use. */
  cwd: string;
  gatherModel: string;
  verdictModel: string;
  gatherMaxTurns: number;
  /** Wall clock per stock, both stages. */
  timeoutMs: number;
  /** Builds the in-process data tools for one review; they record fetched pages into scope.ledger. */
  tools: (scope: ToolScope) => ReviewTools;
  /** Default: the SDK's query. Tests inject a fake. */
  query?: QueryFn;
  /** Env the child env is derived from (keys and parent-session markers stripped). Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Keeps only citations of pages the review actually fetched. An agree or object left with none
 * becomes unsure (brief §4.2: unverifiable claims become "can't tell").
 */
export function finalizeVerdict(raw: RawVerdict, ledger: SourceLedger): { verdict: ReviewVerdict; downgraded: boolean } {
  const cited: Source[] = [];
  for (const url of raw.source_urls) {
    const source = ledger.get(url);
    if (source !== undefined && !cited.includes(source)) cited.push(source);
  }
  const reason = raw.reason.trim();
  if (raw.verdict !== 'unsure' && cited.length === 0) {
    return {
      verdict: {
        verdict: 'unsure',
        reason: clip(`No page that was actually read backs this call, so the pick stays. ${reason}`, REASON_MAX_CHARS),
        sources: [],
      },
      downgraded: true,
    };
  }
  return { verdict: { verdict: raw.verdict, reason: clip(reason, REASON_MAX_CHARS), sources: cited }, downgraded: false };
}

interface StageResult {
  text: string;
  structured: unknown;
  /** The model that produced most output in this stage, from modelUsage. */
  model: string | null;
}

function addUsage(usage: ReviewUsage, message: SDKResultMessage): string | null {
  usage.costUsd += message.total_cost_usd ?? 0;
  usage.turns += message.num_turns ?? 0;
  let top: string | null = null;
  let topOutput = -1;
  for (const [model, mu] of Object.entries(message.modelUsage ?? {})) {
    usage.inputTokens += mu.inputTokens + mu.cacheReadInputTokens + mu.cacheCreationInputTokens;
    usage.outputTokens += mu.outputTokens;
    if (mu.outputTokens > topOutput) {
      top = model;
      topOutput = mu.outputTokens;
    }
  }
  return top;
}

async function runStage(query: QueryFn, prompt: string, options: Options, usage: ReviewUsage): Promise<StageResult> {
  let result: StageResult | null = null;
  let failure: string | null = null;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type !== 'result') continue;
      const model = addUsage(usage, message);
      if (message.subtype === 'success' && !message.is_error) {
        result = { text: message.result, structured: message.structured_output, model };
      } else if (message.subtype === 'success') {
        failure = message.result.trim() || 'the agent failed without saying why';
      } else {
        failure = message.errors.join('; ').trim() || `the agent failed (${message.subtype})`;
      }
    }
  } catch (err) {
    // A CLI that exits non-zero after its result still produced that result: trust it.
    if (result === null && failure === null) failure = errorText(err);
  }
  if (result !== null) return result;
  throw new Error(failure ?? 'the agent ended without a result');
}

/**
 * The production reviewer: two Claude Agent SDK runs per stock on the owner's login. Null when the
 * claude binary cannot be found; the daemon logs that once and runs without a reviewer.
 */
export function createAgentReviewer(opts: AgentReviewerOptions): StockReviewer | null {
  const baseEnv = opts.baseEnv ?? process.env;
  const claudeBin = findClaudeBin(opts.claudeBin, baseEnv.PATH);
  if (claudeBin === null) return null;
  const query: QueryFn = opts.query ?? sdkQuery;
  let cwdReady: Promise<unknown> | null = null;

  function common(abortController: AbortController): Options {
    return {
      abortController,
      cwd: opts.cwd,
      env: claudeEnv(baseEnv),
      pathToClaudeCodeExecutable: claudeBin as string,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      persistSession: false,
    };
  }

  function gatherOptions(abortController: AbortController, tools: ReviewTools): Options {
    return {
      ...common(abortController),
      model: opts.gatherModel,
      mcpServers: { [ADVERSARY_MCP_SERVER]: tools.server },
      tools: ['WebSearch'],
      allowedTools: tools.allowedTools,
      disallowedTools: ['WebFetch'],
      maxTurns: opts.gatherMaxTurns,
      systemPrompt: GATHER_SYSTEM,
    };
  }

  function verdictOptions(abortController: AbortController): Options {
    return {
      ...common(abortController),
      model: opts.verdictModel,
      mcpServers: {},
      tools: [],
      allowedTools: [],
      disallowedTools: ['WebFetch', 'WebSearch'],
      maxTurns: VERDICT_MAX_TURNS,
      systemPrompt: VERDICT_SYSTEM,
      outputFormat: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA },
    };
  }

  return {
    gatherModel: opts.gatherModel,
    verdictModel: opts.verdictModel,
    async review(ctx: ReviewContext, signal: AbortSignal): Promise<ReviewOutcome> {
      if (signal.aborted) throw new ReviewFailure('review stopped: notesd is shutting down', null);
      cwdReady ??= mkdir(opts.cwd, { recursive: true });
      await cwdReady;
      const controller = new AbortController();
      const relay = (): void => controller.abort(signal.reason);
      signal.addEventListener('abort', relay, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, opts.timeoutMs);
      timer.unref();
      const usage: ReviewUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, gatherModel: opts.gatherModel, verdictModel: opts.verdictModel };
      const ledger = new SourceLedger();
      try {
        const tools = opts.tools({ symbol: ctx.pick.symbol, dataDate: ctx.decision.dataDate, ledger });
        const gather = await runStage(query, gatherPrompt(ctx), gatherOptions(controller, tools), usage);
        if (gather.model !== null) usage.gatherModel = gather.model;
        const dossier = clip(gather.text.trim(), MAX_DOSSIER_CHARS);
        if (dossier === '') throw new Error('the gathering stage returned no dossier');
        const decided = await runStage(query, verdictPrompt(ctx, dossier, ledger.list()), verdictOptions(controller), usage);
        if (decided.model !== null) usage.verdictModel = decided.model;
        const parsed = VerdictSchema.safeParse(decided.structured);
        if (!parsed.success) {
          throw new Error(`the verdict did not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        }
        const { verdict, downgraded } = finalizeVerdict(parsed.data, ledger);
        return { verdict, usage, downgraded };
      } catch (err) {
        if (timedOut) throw new ReviewFailure(`no verdict within ${Math.round(opts.timeoutMs / 1000)} s`, usage);
        if (signal.aborted) throw new ReviewFailure('review stopped: notesd is shutting down', usage);
        throw new ReviewFailure(errorText(err), usage);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
      }
    },
  };
}

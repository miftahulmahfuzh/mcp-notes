import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { VERDICT_JSON_SCHEMA, createAgentReviewer, finalizeVerdict } from '../../../src/adversary/agent.js';
import { sessionOpenUtc } from '../../../src/adversary/sessions.js';
import { SourceLedger, type ReviewTools } from '../../../src/adversary/tools.js';
import { ReviewFailure, type ReviewContext, type StockReviewer } from '../../../src/adversary/types.js';
import type { QueryFn } from '../../../src/chat/agent.js';

const PAGE = {
  url: 'https://news.example.com/acme-cut',
  title: 'Acme cuts its outlook',
  publisher: 'Example News',
  published_at: '2026-11-04T12:00:00.000Z',
  fetched_at: '2026-11-05T09:00:00.000Z',
};

function ctx(): ReviewContext {
  const pick = { symbol: 'ACME', rank: 1, weight: null, evidence: null };
  return {
    strategy: {
      id: 'T-BRK',
      name: 'TB · Dip test',
      sub: 'Buys a short dip',
      engine: 'bracket',
      rulesId: 'design-v0-gotrade',
      objectName: 'STRATEGY_A',
      gateNote: null,
      promotedFrom: null,
      status: 'active',
      twinOf: null,
      isBenchmark: false,
    },
    lens: { id: 'STRATEGY_A@00000000', text: 'Method: TB' },
    promptVersion: 'adv-v1-000000000000',
    decision: { strategyId: 'T-BRK', sessionDate: '2026-11-06', dataDate: '2026-11-05', kind: 'bracket', stage: 'final', openUtc: sessionOpenUtc('2026-11-06'), picks: [pick] },
    pick,
    held: null,
    now: new Date('2026-11-05T09:00:00Z'),
  };
}

function result(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    stop_reason: null,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: 'adv-test',
    ...fields,
  } as unknown as SDKMessage;
}

function usageOf(model: string, input: number, output: number): Record<string, unknown> {
  return {
    [model]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000 },
  };
}

function scripted(stages: SDKMessage[][]): { query: QueryFn; calls: Options[] } {
  const calls: Options[] = [];
  const query: QueryFn = ({ options }) => {
    calls.push(options);
    const messages = stages[calls.length - 1] ?? [];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { query, calls };
}

function reviewer(query: QueryFn, opts: { recordPage?: boolean; timeoutMs?: number } = {}): StockReviewer {
  const r = createAgentReviewer({
    claudeBin: process.execPath,
    cwd: path.join(tmpdir(), `mcp-notes-adversary-test-${process.pid}`),
    gatherModel: 'sonnet',
    verdictModel: 'opus',
    gatherMaxTurns: 7,
    timeoutMs: opts.timeoutMs ?? 5_000,
    query,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'must-not-reach-the-child' },
    tools: ({ ledger }): ReviewTools => {
      if (opts.recordPage !== false) ledger.record(PAGE);
      return {
        server: { type: 'sdk', name: 'adversary', instance: {} } as unknown as McpSdkServerConfigWithInstance,
        allowedTools: ['WebSearch', 'mcp__adversary__fetch_url'],
      };
    },
  });
  if (r === null) throw new Error('reviewer not built');
  return r;
}

const GATHERED = result({ result: `Acme cut its outlook on 4 Nov (${PAGE.url}).`, num_turns: 5, total_cost_usd: 0.25, modelUsage: usageOf('claude-sonnet-4-9', 1_000, 300) });
const decided = (structured: unknown): SDKMessage =>
  result({ structured_output: structured, num_turns: 1, total_cost_usd: 0.5, modelUsage: usageOf('claude-opus-5-5', 2_000, 100) });

describe('createAgentReviewer', () => {
  it('gathers with tools, decides with structured output and no tools, and records exact models and usage', async () => {
    const reason = 'Acme lowered its forecast, so the fall is the market re-pricing the company, not a passing dip.';
    const { query, calls } = scripted([[GATHERED], [decided({ verdict: 'object', reason, source_urls: [PAGE.url] })]]);
    const out = await reviewer(query).review(ctx(), new AbortController().signal);
    expect(out.verdict).toEqual({ verdict: 'object', reason, sources: [PAGE] });
    expect(out.downgraded).toBe(false);
    expect(out.usage).toMatchObject({ inputTokens: 1_015 + 2_015, outputTokens: 400, turns: 6, gatherModel: 'claude-sonnet-4-9', verdictModel: 'claude-opus-5-5' });
    expect(out.usage.costUsd).toBeCloseTo(0.75);

    const [gather, verdict] = calls;
    expect(gather).toMatchObject({ model: 'sonnet', tools: ['WebSearch'], maxTurns: 7, persistSession: false, settingSources: [], strictMcpConfig: true });
    expect(gather?.disallowedTools).toContain('WebFetch');
    expect(Object.keys(gather?.mcpServers ?? {})).toEqual(['adversary']);
    expect(gather?.allowedTools).toEqual(['WebSearch', 'mcp__adversary__fetch_url']);
    expect(gather?.outputFormat).toBeUndefined();
    expect(gather?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(verdict).toMatchObject({ model: 'opus', tools: [], allowedTools: [], mcpServers: {} });
    expect(verdict?.outputFormat).toEqual({ type: 'json_schema', schema: VERDICT_JSON_SCHEMA });
  });

  it('hands the CLI a draft-07 schema, the one --json-schema accepts', () => {
    // The CLI exits 1 on zod's default draft 2020-12 $schema ("no schema with key or ref").
    expect(VERDICT_JSON_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(VERDICT_JSON_SCHEMA).toMatchObject({ type: 'object', required: ['verdict', 'reason', 'source_urls'] });
  });

  it('turns an objection that cites no fetched page into unsure', async () => {
    const { query } = scripted([[GATHERED], [decided({ verdict: 'object', reason: 'Bad news.', source_urls: [PAGE.url] })]]);
    const out = await reviewer(query, { recordPage: false }).review(ctx(), new AbortController().signal);
    expect(out.downgraded).toBe(true);
    expect(out.verdict.verdict).toBe('unsure');
    expect(out.verdict.sources).toEqual([]);
    expect(out.verdict.reason).toMatch(/^No page that was actually read backs this call/);
    expect(out.verdict.reason.length).toBeLessThanOrEqual(600);
  });

  it('fails a verdict that breaks the schema, keeping what it spent', async () => {
    const { query } = scripted([[GATHERED], [decided({ verdict: 'object', reason: 'x'.repeat(601), source_urls: [] })]]);
    const err = await reviewer(query).review(ctx(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewFailure);
    expect((err as ReviewFailure).message).toMatch(/schema/);
    expect((err as ReviewFailure).usage?.turns).toBe(6);
  });

  it('fails when the gathering stage hits its turn cap', async () => {
    const { query } = scripted([[result({ subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (7)'] })]]);
    await expect(reviewer(query).review(ctx(), new AbortController().signal)).rejects.toThrow(/maximum number of turns/);
  });

  it('gives up after the per-stock timeout', async () => {
    const hang: QueryFn = ({ options }) =>
      (async function* () {
        await new Promise<never>((_, reject) => options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      })();
    await expect(reviewer(hang, { timeoutMs: 30 }).review(ctx(), new AbortController().signal)).rejects.toThrow(/no verdict within/);
  });

  it('is not built without a claude binary', () => {
    expect(
      createAgentReviewer({
        claudeBin: '/nonexistent/claude',
        cwd: tmpdir(),
        gatherModel: 'sonnet',
        verdictModel: 'opus',
        gatherMaxTurns: 1,
        timeoutMs: 1,
        tools: () => {
          throw new Error('unused');
        },
      }),
    ).toBeNull();
  });
});

describe('finalizeVerdict', () => {
  it('matches citations to the ledger ignoring fragments and trailing slashes, once each', () => {
    const ledger = new SourceLedger();
    ledger.record(PAGE);
    const out = finalizeVerdict({ verdict: 'agree', reason: ' Fine. ', source_urls: [`${PAGE.url}/`, `${PAGE.url}#x`, 'https://never.example.com/'] }, ledger);
    expect(out).toEqual({ verdict: { verdict: 'agree', reason: 'Fine.', sources: [PAGE] }, downgraded: false });
  });
});

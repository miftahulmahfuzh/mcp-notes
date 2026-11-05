import { createHash } from 'node:crypto';
import type { Lens, ReviewContext, Source } from './types.js';

/** Bump when a prompt below changes shape; the hash in prompt_version moves anyway. */
export const PROMPT_REVISION = 'adv-v1';
/** Seer's adversary_verdicts.reason CHECK (char_length 1..600). */
export const REASON_MAX_CHARS = 600;
const MAX_EVIDENCE_CHARS = 1_500;
const MAX_BASKET_NAMES = 40;

export const GATHER_SYSTEM = [
  'You gather facts for a review of one stock that a trading method wants to buy or keep. Another model decides later from your notes; you do not decide.',
  "Work only through the method's lens given in the message.",
  "Start with seer_price_context (the method's own prices, no network). Then look for news, scheduled events and filings with the finnhub_*, massive_news and sec_filings tools when they are offered, and with WebSearch for coverage they miss.",
  'A page counts only once you open it with fetch_url: only pages opened with fetch_url can be cited, so open every page you mean to rely on, and never rely on a search snippet alone.',
  "Use only what was published before now, and nothing about how the stock traded after the method's decision night.",
  'Open at most about 8 pages, then stop.',
  "Answer with a dossier in plain sentences: each fact followed by the URL of the fetch_url page it came from, then a last line naming anything scheduled before the method's horizon ends, or 'nothing scheduled found'.",
].join(' ');

export const VERDICT_SYSTEM = [
  "You are the adversary of a trading method: before its pick is bought or kept, you decide whether the owner should let it through.",
  "Answer agree when the method's own reason for the pick stands, object when something the method cannot see makes this pick a mistake under its own lens, and unsure when the evidence is thin, mixed or could not be checked; unsure keeps the pick.",
  "Judge only through the method's lens and the dossier; do not invent facts.",
  'Every agree or object must cite at least one URL from the numbered list of pages that were actually opened, copied exactly. Cite nothing outside that list. If no page on the list supports your call, answer unsure.',
  `Write the reason for an owner who is not a trader: at most ${REASON_MAX_CHARS} characters, plain everyday words, name the company rather than its ticker symbol, and no trading jargon: never write RSI, oversold, overbought, momentum, mean reversion, alpha, beta or support level.`,
  'Answer only through the structured output.',
].join(' ');

/** `adv-v1-<12 hex>` over the revision, both system prompts, both models and the lens. */
export function promptVersion(lens: Lens, gatherModel: string, verdictModel: string): string {
  const hash = createHash('sha256')
    .update([PROMPT_REVISION, GATHER_SYSTEM, VERDICT_SYSTEM, gatherModel, verdictModel, lens.text].join('\n\u0000\n'), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${PROMPT_REVISION}-${hash}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function percent(weight: number): string {
  return `${(weight * 100).toFixed(1)}%`;
}

/** The facts of one pick, shared by both stages. */
export function decisionFacts(ctx: ReviewContext): string {
  const { decision, pick } = ctx;
  const others = decision.picks
    .filter((p) => p.symbol !== pick.symbol)
    .slice(0, MAX_BASKET_NAMES)
    .map((p) => p.symbol);
  const lines: string[] = [`Stock under review: ${pick.symbol}`, `Method: ${ctx.strategy.name} (${ctx.strategy.id})`];
  lines.push(
    decision.stage === 'draft'
      ? `This is an early look: the method's next rebalance is the US session of ${decision.sessionDate}; its list may still change before then.`
      : `Decision: what the method will do in the US session of ${decision.sessionDate}.`,
  );
  lines.push(`That session opens at ${decision.openUtc.toISOString()}. The method decided on prices up to the close of ${decision.dataDate}.`);
  if (decision.kind === 'bracket') {
    lines.push(`Its place: candidate ${pick.rank} of ${decision.picks.length} in the method's ranking; the top ones take the free slots.`);
  } else {
    const weight = pick.weight === null ? 'weight not given' : `${percent(pick.weight)} of the book`;
    const holding =
      ctx.held === true
        ? 'the book holds it now, so objecting means selling it and paying the fees'
        : ctx.held === false
          ? 'the book does not hold it now, so objecting means not buying it'
          : 'whether the book holds it now is not known';
    lines.push(`Its place: target ${pick.rank} of ${decision.picks.length}, ${weight}; ${holding}.`);
  }
  lines.push(`Other names in this decision: ${others.length === 0 ? 'none' : others.join(', ')}`);
  if (pick.evidence !== null && pick.evidence !== undefined) {
    lines.push(`What the method's rule read: ${clip(JSON.stringify(pick.evidence), MAX_EVIDENCE_CHARS)}`);
  }
  lines.push(`Now: ${ctx.now.toISOString()}. Use only what was published before now.`);
  return lines.join('\n');
}

export function gatherPrompt(ctx: ReviewContext): string {
  return [decisionFacts(ctx), '', "The method's lens:", ctx.lens.text].join('\n');
}

export function verdictPrompt(ctx: ReviewContext, dossier: string, opened: readonly Source[]): string {
  const pages =
    opened.length === 0
      ? ['(none: no page was opened, so the answer must be unsure)']
      : opened.map((s, i) => {
          const meta = [s.publisher, s.published_at === null ? null : `published ${s.published_at}`].filter((x): x is string => x !== null);
          return `${i + 1}. ${s.url} | ${s.title ?? 'untitled'}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`;
        });
  return [
    decisionFacts(ctx),
    '',
    "The method's lens:",
    ctx.lens.text,
    '',
    'Dossier from the gathering stage:',
    dossier,
    '',
    'Pages actually opened (cite only these URLs):',
    ...pages,
  ].join('\n');
}

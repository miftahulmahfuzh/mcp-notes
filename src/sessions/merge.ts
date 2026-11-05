import type { ModelUsage, SessionCommit, SessionPrompt } from '../db/schema.js';
import { redactSecrets } from './redact.js';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_IMAGES_PER_PROMPT,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type PatchPrompt,
  type PromptsReplacement,
  type SessionRow,
  type StoredPrompt,
  type SubagentTotals,
  type TranscriptPatch,
  type TranscriptSet,
} from './types.js';

/** `value` cut to at most `max` characters, the last one an ellipsis when cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clipOrKeep(value: string | null | undefined, max: number): string | null | undefined {
  return value === null || value === undefined ? value : clip(value, max);
}

/**
 * A prompt as `cc_sessions` keeps it (the excerpt list, first_prompt, last_prompt): redacted, then
 * clipped to MAX_PROMPT_CHARS. Redacting first means a clip can never leave behind the head of a
 * secret that is too short to match a pattern any more.
 */
export function promptExcerpt(text: string): string {
  return clip(redactSecrets(text), MAX_PROMPT_CHARS);
}

function excerptOrKeep(value: string | null | undefined): string | null | undefined {
  return value === null || value === undefined ? value : promptExcerpt(value);
}

/**
 * A stored prompt text written back. redactSecrets is idempotent: text stored redacted comes back
 * unchanged, text stored before redaction existed comes back redacted.
 */
function redactStored(value: string | null): string | null {
  return value === null ? null : redactSecrets(value);
}

function parseAt(at: string | null | undefined): Date | null {
  if (at === null || at === undefined) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The earlier of two times; a missing one never wins. */
export function earliest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() < a.getTime() ? b : a;
}

/** The later of two times; a missing one never wins. */
export function latest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() > a.getTime() ? b : a;
}

/** A path without trailing slashes (`/` stays `/`), trimmed. Used for spawn matching. */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (t.length <= 1) return t;
  const stripped = t.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function count(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function mergeModels(
  prev: Record<string, ModelUsage>,
  delta: Record<string, Partial<ModelUsage>> | undefined,
  reset: boolean,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = reset ? {} : { ...prev };
  for (const [model, d] of Object.entries(delta ?? {})) {
    const base = out[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    out[model] = {
      inputTokens: base.inputTokens + count(d.inputTokens),
      outputTokens: base.outputTokens + count(d.outputTokens),
      cacheReadTokens: base.cacheReadTokens + count(d.cacheReadTokens),
      cacheWriteTokens: base.cacheWriteTokens + count(d.cacheWriteTokens),
    };
  }
  return out;
}

/** `prev` minus `take`, per model and counter, never below zero; models left at all zeros are dropped. */
export function subtractModels(prev: Record<string, ModelUsage>, take: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = { ...prev };
  for (const [model, t] of Object.entries(take)) {
    const base = out[model];
    if (base === undefined) continue;
    const left = {
      inputTokens: Math.max(0, base.inputTokens - count(t.inputTokens)),
      outputTokens: Math.max(0, base.outputTokens - count(t.outputTokens)),
      cacheReadTokens: Math.max(0, base.cacheReadTokens - count(t.cacheReadTokens)),
      cacheWriteTokens: Math.max(0, base.cacheWriteTokens - count(t.cacheWriteTokens)),
    };
    if (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens === 0) delete out[model];
    else out[model] = left;
  }
  return out;
}

/**
 * The excerpt list: the stored excerpts (written back redacted, a no-op for redacted text) then the
 * new prompts as excerpts, keeping the newest MAX_PROMPTS. Blank prompts are dropped.
 */
function mergePrompts(prev: SessionPrompt[], next: readonly PatchPrompt[] | undefined, reset: boolean): SessionPrompt[] {
  const incoming = (next ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: promptExcerpt(p.text), at: p.at ?? null }));
  const kept = reset ? [] : prev.map((p) => ({ text: redactSecrets(p.text), at: p.at ?? null }));
  const all = [...kept, ...incoming];
  return all.length > MAX_PROMPTS ? all.slice(all.length - MAX_PROMPTS) : all;
}

/**
 * `cc_session_prompts` rows for `prompts`, in order: the full text as ingest cut it, redacted.
 * Blank prompts are dropped (the same rule as the excerpt list).
 */
export function storedPrompts(prompts: readonly PatchPrompt[] | undefined): StoredPrompt[] {
  return (prompts ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      text: redactSecrets(p.text),
      at: parseAt(p.at),
      truncated: p.truncated === true,
      images: (p.images ?? []).slice(0, MAX_IMAGES_PER_PROMPT),
    }));
}

/**
 * `cc_session_prompts` rows rebuilt from a row's stored excerpts, for a session whose transcript is
 * gone: each excerpt redacted, `truncated` where the excerpt was clipped (it ends in `…`).
 */
export function storedPromptsFromExcerpts(excerpts: readonly SessionPrompt[]): StoredPrompt[] {
  return excerpts
    .filter((p) => p.text.trim().length > 0)
    .map((p) => {
      const text = redactSecrets(p.text);
      return { text, at: parseAt(p.at), truncated: text.endsWith('…'), images: [] };
    });
}

/** The three `cc_sessions` columns that hold prompt text. */
export type PromptColumns = Pick<SessionRow, 'prompts' | 'firstPrompt' | 'lastPrompt'>;

/**
 * The prompt columns after a transcript was re-read from byte 0 (the prompts backfill). A first or
 * last prompt the re-read did not find keeps the stored one, redacted.
 */
export function replacedPromptColumns(
  row: PromptColumns,
  input: Pick<PromptsReplacement, 'prompts' | 'firstPrompt' | 'lastPrompt'>,
): PromptColumns {
  return {
    prompts: mergePrompts([], input.prompts, true),
    firstPrompt: input.firstPrompt === null ? redactStored(row.firstPrompt) : promptExcerpt(input.firstPrompt),
    lastPrompt: input.lastPrompt === null ? redactStored(row.lastPrompt) : promptExcerpt(input.lastPrompt),
  };
}

/** The prompt columns of a row whose transcript is gone: what is stored, redacted in place. */
export function redactedPromptColumns(row: PromptColumns): PromptColumns {
  return {
    prompts: row.prompts.map((p) => ({ text: redactSecrets(p.text), at: p.at ?? null })),
    firstPrompt: redactStored(row.firstPrompt),
    lastPrompt: redactStored(row.lastPrompt),
  };
}

/**
 * Union by sha, capped to the newest MAX_COMMITS. When every commit has a time they are put in time
 * order (a session's and its subagents' commits interleave); otherwise first-seen order stays.
 */
export function mergeCommits(prev: SessionCommit[], next: SessionCommit[] | undefined, reset: boolean): SessionCommit[] {
  const bySha = new Map<string, SessionCommit>();
  for (const c of [...(reset ? [] : prev), ...(next ?? [])]) {
    if (c.sha.length === 0 || bySha.has(c.sha)) continue;
    bySha.set(c.sha, { sha: c.sha, subject: clip(c.subject, MAX_TITLE_CHARS), at: c.at ?? null });
  }
  const all = [...bySha.values()];
  if (all.every((c) => c.at !== null)) all.sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''));
  return all.length > MAX_COMMITS ? all.slice(all.length - MAX_COMMITS) : all;
}

function unionStrings(prev: string[], next: string[] | undefined, reset: boolean, max: number): string[] {
  const out = new Set<string>(reset ? [] : prev);
  for (const s of next ?? []) {
    if (out.size >= max) break;
    if (s.length > 0) out.add(s);
  }
  return [...out].slice(0, max);
}

/**
 * The column values `row` takes after applying `patch`. Pure; the caller (SessionsRepo) has
 * already checked the offset precondition. See TranscriptPatch for the rules. A re-read from byte 0
 * replaces tokens, models and commits, starting from `subagents` (the session's subagent share,
 * which lives in other files) instead of from zero. Every prompt text written (excerpts, first and
 * last prompt) is redacted, so a row written before redaction existed is cleaned on its next write.
 */
export function mergeTranscriptPatch(row: SessionRow, patch: TranscriptPatch, subagents: SubagentTotals | null = null): TranscriptSet {
  const reset = patch.fromOffset === 0;
  if (reset && subagents !== null) {
    const t = subagents.tokens;
    row = {
      ...row,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      models: subagents.models,
      commits: subagents.commits,
    };
  }
  const keep = reset && subagents !== null;
  const tokens = patch.tokens ?? {};
  const firstPrompt = excerptOrKeep(patch.firstPrompt);
  const storedFirst = redactStored(row.firstPrompt);
  return {
    repo: patch.repo ?? row.repo,
    cwd: patch.cwd ?? row.cwd,
    branch: patch.branch ?? row.branch,
    name: clipOrKeep(patch.name, MAX_TITLE_CHARS) ?? row.name,
    customTitle: clipOrKeep(patch.customTitle, MAX_TITLE_CHARS) ?? row.customTitle,
    aiTitle: clipOrKeep(patch.aiTitle, MAX_TITLE_CHARS) ?? row.aiTitle,
    firstPrompt: reset ? (firstPrompt ?? storedFirst) : (storedFirst ?? firstPrompt ?? null),
    lastPrompt: excerptOrKeep(patch.lastPrompt) ?? redactStored(row.lastPrompt),
    entrypoint: patch.entrypoint ?? row.entrypoint,
    version: patch.version ?? row.version,
    finalMessage: clipOrKeep(patch.finalMessage, MAX_FINAL_MESSAGE_CHARS) ?? row.finalMessage,
    startedAt: earliest(row.startedAt, patch.startedAt),
    lastActiveAt: latest(row.lastActiveAt, patch.lastActiveAt),
    inputTokens: (reset && !keep ? 0 : row.inputTokens) + count(tokens.inputTokens),
    outputTokens: (reset && !keep ? 0 : row.outputTokens) + count(tokens.outputTokens),
    cacheReadTokens: (reset && !keep ? 0 : row.cacheReadTokens) + count(tokens.cacheReadTokens),
    cacheWriteTokens: (reset && !keep ? 0 : row.cacheWriteTokens) + count(tokens.cacheWriteTokens),
    costUsd:
      patch.costUsd !== undefined && patch.costUsd !== null && Number.isFinite(patch.costUsd)
        ? patch.costUsd
        : row.costUsd,
    models: mergeModels(row.models, patch.models, reset && !keep),
    prompts: mergePrompts(row.prompts, patch.prompts, reset),
    commits: mergeCommits(row.commits, patch.commits, reset && !keep),
    filesEdited: unionStrings(row.filesEdited, patch.filesEdited, reset, MAX_FILES_EDITED),
    planDocs: unionStrings(row.planDocs, patch.planDocs, reset, MAX_PLAN_DOCS),
    transcriptPath: patch.transcriptPath,
    transcriptOffset: patch.toOffset,
    transcriptSize: patch.size,
  };
}

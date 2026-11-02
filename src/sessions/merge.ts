import type { ModelUsage, SessionCommit, SessionPrompt } from '../db/schema.js';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type SessionRow,
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

function mergeModels(
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

function mergePrompts(prev: SessionPrompt[], next: SessionPrompt[] | undefined, reset: boolean): SessionPrompt[] {
  const incoming = (next ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: clip(p.text, MAX_PROMPT_CHARS), at: p.at ?? null }));
  const all = [...(reset ? [] : prev), ...incoming];
  return all.length > MAX_PROMPTS ? all.slice(all.length - MAX_PROMPTS) : all;
}

function mergeCommits(prev: SessionCommit[], next: SessionCommit[] | undefined, reset: boolean): SessionCommit[] {
  const bySha = new Map<string, SessionCommit>();
  for (const c of [...(reset ? [] : prev), ...(next ?? [])]) {
    if (c.sha.length === 0 || bySha.has(c.sha)) continue;
    bySha.set(c.sha, { sha: c.sha, subject: clip(c.subject, MAX_TITLE_CHARS), at: c.at ?? null });
  }
  const all = [...bySha.values()];
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
 * already checked the offset precondition. See TranscriptPatch for the rules.
 */
export function mergeTranscriptPatch(row: SessionRow, patch: TranscriptPatch): TranscriptSet {
  const reset = patch.fromOffset === 0;
  const tokens = patch.tokens ?? {};
  const firstPrompt = clipOrKeep(patch.firstPrompt, MAX_PROMPT_CHARS);
  return {
    repo: patch.repo ?? row.repo,
    cwd: patch.cwd ?? row.cwd,
    branch: patch.branch ?? row.branch,
    name: clipOrKeep(patch.name, MAX_TITLE_CHARS) ?? row.name,
    customTitle: clipOrKeep(patch.customTitle, MAX_TITLE_CHARS) ?? row.customTitle,
    aiTitle: clipOrKeep(patch.aiTitle, MAX_TITLE_CHARS) ?? row.aiTitle,
    firstPrompt: reset ? (firstPrompt ?? row.firstPrompt) : (row.firstPrompt ?? firstPrompt ?? null),
    lastPrompt: clipOrKeep(patch.lastPrompt, MAX_PROMPT_CHARS) ?? row.lastPrompt,
    entrypoint: patch.entrypoint ?? row.entrypoint,
    version: patch.version ?? row.version,
    finalMessage: clipOrKeep(patch.finalMessage, MAX_FINAL_MESSAGE_CHARS) ?? row.finalMessage,
    startedAt: earliest(row.startedAt, patch.startedAt),
    lastActiveAt: latest(row.lastActiveAt, patch.lastActiveAt),
    inputTokens: (reset ? 0 : row.inputTokens) + count(tokens.inputTokens),
    outputTokens: (reset ? 0 : row.outputTokens) + count(tokens.outputTokens),
    cacheReadTokens: (reset ? 0 : row.cacheReadTokens) + count(tokens.cacheReadTokens),
    cacheWriteTokens: (reset ? 0 : row.cacheWriteTokens) + count(tokens.cacheWriteTokens),
    costUsd:
      patch.costUsd !== undefined && patch.costUsd !== null && Number.isFinite(patch.costUsd)
        ? patch.costUsd
        : row.costUsd,
    models: mergeModels(row.models, patch.models, reset),
    prompts: mergePrompts(row.prompts, patch.prompts, reset),
    commits: mergeCommits(row.commits, patch.commits, reset),
    filesEdited: unionStrings(row.filesEdited, patch.filesEdited, reset, MAX_FILES_EDITED),
    planDocs: unionStrings(row.planDocs, patch.planDocs, reset, MAX_PLAN_DOCS),
    transcriptPath: patch.transcriptPath,
    transcriptOffset: patch.toOffset,
    transcriptSize: patch.size,
  };
}

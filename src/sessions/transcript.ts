import { open } from 'node:fs/promises';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type ModelUsage,
  type SessionCommit,
  type SessionPrompt,
  type TokenCounts,
  type TranscriptPatch,
} from './types.js';

/**
 * Claude Code transcript reading for session ingest (`~/.claude/projects/<dir>/<uuid>.jsonl`).
 * Pure parsing plus one streaming byte-offset reader; `ingest.ts` walks the files and writes rows
 * through `SessionsRepo.upsertFromTranscript`, whose merge (`merge.ts`, phase 1) adds this
 * module's per-read deltas onto the stored row. The hooks have a JS copy of the prompt helpers
 * in `claude/hooks/lib/transcript.mjs`; the rules here are the same, ported to TypeScript.
 *
 * Shapes this relies on (measured 2026-11-02 over 628 transcripts, Claude Code 2.1.150-2.1.311):
 * - One file per session; the file stem is the session id and every record's `sessionId` matches.
 * - Envelope records (`user`, `assistant`, `attachment`, `system`) carry `timestamp` (ISO UTC),
 *   `cwd`, `gitBranch`, `entrypoint` (`cli` | `sdk-cli` | `sdk-ts`), `version`. The first `cwd` of a
 *   file always encodes to its project dir name (the launch dir); 239 files later carry other
 *   cwds (`cd` into a worktree or subdir), so cwd and entrypoint come only from a read at byte 0.
 * - Metadata records: `custom-title.customTitle`, `agent-name.agentName`, `ai-title.aiTitle`,
 *   `last-prompt.lastPrompt`, and `cost-state` (cumulative: `totalCostUSD` is the session's
 *   running total; the latest one wins).
 * - An assistant API message is written as one record per content block; every record of one
 *   message repeats the same `message.id` and the same `message.usage` (35 438 of 71 873 records
 *   are such repeats), so usage is counted once per message id.
 * - `git commit` output arrives as a tool_result whose text has a `[branch sha] subject` line.
 * - Peer messages (`origin.kind: 'peer'`, from SendMessage), task notifications and sdk turns are
 *   `type: 'user'` records too; only `origin.kind` `human` or absent counts as a prompt.
 * - `api-request*`, `file-history-*` and a few bookkeeping types are most of the bytes and carry
 *   nothing a session row needs; they are dropped before JSON.parse.
 */

/** Record types that never feed a session row. Skipped from the leading `{"type":"..."` before JSON.parse. */
export const IGNORED_RECORD_TYPES: ReadonlySet<string> = new Set([
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'mode',
  'permission-mode',
  'queue-operation',
  'tools-used',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'isolation-latch',
  'worktree-state',
  'relocated',
]);

/** Entry points that are not a person at a terminal: the wall chat agent and the `/n` helper runs. */
export const EXCLUDED_ENTRYPOINTS: ReadonlySet<string> = new Set(['sdk-ts', 'sdk-cli']);

/** Tools whose `file_path` (`notebook_path` for NotebookEdit) is a file the session changed. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A plan document: `docs/plans/*`, `.workflows/plan/*`, `docs/analyzer/*`, read or edited. */
export const PLAN_DOC_PATH = /(?:^|\/)(?:docs\/plans|\.workflows\/plan|docs\/analyzer)\//;

export const DEFAULT_READ_CHUNK_BYTES = 1 << 20;
/** Message ids remembered across reads, to count a message's usage once when its records straddle a read. */
const RECENT_MESSAGE_IDS = 16;
/** `git commit` tool_use ids remembered across reads, waiting for their result. */
const PENDING_COMMIT_IDS = 32;

const LEADING_TYPE = /^\{"type":"([^"]{1,64})"/;
const LOCAL_WRAPPERS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];
const COMMAND_START = /^\s*<command-(?:message|name)>/;
const COMMAND_NAME = /<command-name>\s*\/?([^<\s]*)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const INTERRUPTED = /^\[Request interrupted by user/;
/** `/model`, `/clear`, `/exit`: a slash command with no arguments says nothing about the work. */
const BARE_COMMAND = /^\/[\w:.-]+$/;
const GIT_COMMIT_COMMAND = /\bgit\b[^\n]*\bcommit\b/;
const COMMIT_LINE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;

export type TranscriptRecord = Record<string, unknown>;

/** State the accumulator carries from one read of a file to the next, in memory only. */
export interface TranscriptCarry {
  recentMessageIds: string[];
  pendingCommitIds: string[];
}

/** What one read of a transcript (from a byte offset to the last complete line) contributed. */
export interface TranscriptDelta {
  sessionId: string;
  /** Records parsed (ignored types excluded). */
  records: number;
  /** First cwd seen in this read. Meaningful as the session cwd only for a read from byte 0. */
  cwd: string | null;
  /** First entrypoint seen in this read. */
  entrypoint: string | null;
  /** Latest non-empty values seen in this read; null when the read had none. */
  branch: string | null;
  version: string | null;
  name: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  firstAt: Date | null;
  lastAt: Date | null;
  /** First human prompt of this read. */
  firstPrompt: string | null;
  /** Human prompts of this read, oldest first, the newest MAX_PROMPTS. */
  prompts: SessionPrompt[];
  /** Assistant usage of this read, one count per message id. */
  tokens: TokenCounts;
  /** The same usage by `message.model` (`<synthetic>` excluded). */
  models: Record<string, ModelUsage>;
  /** `totalCostUSD` of the latest cost-state of this read (an absolute session total), or null. */
  costUsd: number | null;
  commits: SessionCommit[];
  filesEdited: string[];
  planDocs: string[];
  /** Assistant text after the last tool_use / human prompt of this read; null when there is none. */
  finalMessage: string | null;
}

/** Where a read sits in its file, and the repo key resolved for it (read from byte 0 only). */
export interface PatchContext {
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  size: number;
  repo: string | null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function zeroTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addInto(target: TokenCounts, add: TokenCounts): void {
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheWriteTokens += add.cacheWriteTokens;
}

/** One JSONL line to a record. Blank, torn, non-object and ignored-type lines give null. */
export function parseRecord(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const lead = LEADING_TYPE.exec(trimmed);
  if (lead?.[1] !== undefined && IGNORED_RECORD_TYPES.has(lead[1])) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ReadJsonlOptions {
  /** Bytes per read() call. Default DEFAULT_READ_CHUNK_BYTES (1 MiB). Lines may be longer. */
  chunkBytes?: number;
  /** Checked before every chunk; true stops the read (the result still covers the lines read). */
  shouldStop?: () => boolean;
}

export interface ReadJsonlResult {
  /** Byte offset just past the last complete line read: where the next read starts. */
  endOffset: number;
  /** File size when the read began. Bytes appended after that are left for the next read. */
  size: number;
  /** Complete lines handed to `onLine`. */
  lines: number;
  /** True when `shouldStop` cut the read short. */
  stopped: boolean;
}

/**
 * Streams the complete lines of `file` from byte `start` to the size it had when opened, in fixed
 * chunks (memory stays O(chunk + longest line), whatever the file size). A trailing line without
 * its `\n` is still being written: it is not handed out and `endOffset` stops before it.
 */
export async function readJsonlFrom(
  file: string,
  start: number,
  onLine: (line: string) => void,
  options: ReadJsonlOptions = {},
): Promise<ReadJsonlResult> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    let endOffset = Math.min(Math.max(start, 0), size);
    let position = endOffset;
    let lines = 0;
    let stopped = false;
    const pending: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (position < size) {
      if (options.shouldStop?.() === true) {
        stopped = true;
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, size - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, from);
        if (newline === -1) break;
        const piece = chunk.subarray(from, newline);
        const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending.length = 0;
        onLine(line.toString('utf8'));
        lines += 1;
        endOffset = position + newline + 1;
        from = newline + 1;
      }
      if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from)));
      position += bytesRead;
    }
    return { endOffset, size, lines, stopped };
  } finally {
    await handle.close();
  }
}

/** `<command-name>/x</command-name>...<command-args>a</command-args>` -> `/x a`. Other text is returned as is. */
export function typedFromCommandXml(text: string): string {
  if (!COMMAND_START.test(text)) return text;
  const name = COMMAND_NAME.exec(text);
  if (!name || name[1] === undefined || name[1] === '') return text;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return args === '' ? `/${name[1]}` : `/${name[1]} ${args}`;
}

/** True for a record the user typed or pasted: not a tool result, not meta, not a sidechain, not a peer message. */
export function isHumanPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return false;
  if (record.toolUseResult !== undefined) return false;
  const kind = isObject(record.origin) ? record.origin.kind : undefined;
  if (kind !== undefined && kind !== 'human') return false;
  const message = record.message;
  if (!isObject(message) || message.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trimStart();
    return text.length > 0 && !LOCAL_WRAPPERS.some((prefix) => text.startsWith(prefix));
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((block) => isObject(block) && block.type === 'tool_result')) return false;
  return content.some((block) => isObject(block) && (block.type === 'text' || block.type === 'image'));
}

/** The prompt as typed: `/cmd args` for a command record, the joined text blocks for an array record. */
export function promptText(record: TranscriptRecord): string {
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (typeof content === 'string') return typedFromCommandXml(content).trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => typedFromCommandXml(block.text))
    .join('\n')
    .trim();
}

/** The text of a tool_result block's `content` (a string or an array of text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Every `[branch sha] subject` line of `git commit` output, in order. */
export function parseCommitLines(text: string, at: string | null): SessionCommit[] {
  const commits: SessionCommit[] = [];
  for (const match of text.matchAll(COMMIT_LINE)) {
    const sha = match[2];
    const subject = match[3];
    if (sha === undefined || subject === undefined) continue;
    commits.push({ sha, subject: cut(subject.trim(), MAX_TITLE_CHARS), at });
  }
  return commits;
}

export function emptyCarry(): TranscriptCarry {
  return { recentMessageIds: [], pendingCommitIds: [] };
}

/**
 * Folds the records of one read of one transcript into a `TranscriptDelta`. Feed it records in
 * file order with `add`, then take `delta()`; pass `carry()` on to the accumulator of the next read
 * of the same file so a message or a commit that straddles the two reads is counted once.
 */
export class TranscriptAccumulator {
  readonly sessionId: string;
  private records = 0;
  private cwd: string | null = null;
  private entrypoint: string | null = null;
  private branch: string | null = null;
  private version: string | null = null;
  private name: string | null = null;
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  private lastPrompt: string | null = null;
  private firstMs: number | null = null;
  private lastMs: number | null = null;
  private firstPrompt: string | null = null;
  private prompts: SessionPrompt[] = [];
  private readonly tokens: TokenCounts = zeroTokens();
  private readonly models = new Map<string, TokenCounts>();
  private costUsd: number | null = null;
  private readonly commits = new Map<string, SessionCommit>();
  private readonly filesEdited = new Set<string>();
  private readonly planDocs = new Set<string>();
  private segment: string[] = [];
  private readonly toolIdsThisRead = new Set<string>();
  private readonly recentMessageIds: string[];
  private readonly pendingCommitIds: string[];

  constructor(sessionId: string, carry: TranscriptCarry = emptyCarry()) {
    this.sessionId = sessionId;
    this.recentMessageIds = [...carry.recentMessageIds];
    this.pendingCommitIds = [...carry.pendingCommitIds];
  }

  /** State to hand to the next read's accumulator. */
  carry(): TranscriptCarry {
    return {
      recentMessageIds: this.recentMessageIds.slice(-RECENT_MESSAGE_IDS),
      pendingCommitIds: this.pendingCommitIds.slice(-PENDING_COMMIT_IDS),
    };
  }

  add(record: TranscriptRecord): void {
    this.records += 1;
    if (record.isSidechain === true) return;
    this.observeEnvelope(record);
    switch (record.type) {
      case 'custom-title':
        this.customTitle = nonEmpty(record.customTitle) ?? this.customTitle;
        return;
      case 'agent-name':
        this.name = nonEmpty(record.agentName) ?? this.name;
        return;
      case 'ai-title':
        this.aiTitle = nonEmpty(record.aiTitle) ?? this.aiTitle;
        return;
      case 'last-prompt': {
        const text = nonEmpty(record.lastPrompt);
        if (text !== null) this.lastPrompt = cut(text, MAX_PROMPT_CHARS);
        return;
      }
      case 'cost-state':
        if (typeof record.totalCostUSD === 'number' && Number.isFinite(record.totalCostUSD)) this.costUsd = record.totalCostUSD;
        return;
      case 'user':
        this.addUser(record);
        return;
      case 'assistant':
        this.addAssistant(record);
        return;
      default:
        return;
    }
  }

  delta(): TranscriptDelta {
    const models: Record<string, ModelUsage> = {};
    for (const [model, usage] of this.models) models[model] = { ...usage };
    return {
      sessionId: this.sessionId,
      records: this.records,
      cwd: this.cwd,
      entrypoint: this.entrypoint,
      branch: this.branch,
      version: this.version,
      name: this.name,
      customTitle: this.customTitle,
      aiTitle: this.aiTitle,
      lastPrompt: this.lastPrompt,
      firstAt: this.firstMs === null ? null : new Date(this.firstMs),
      lastAt: this.lastMs === null ? null : new Date(this.lastMs),
      firstPrompt: this.firstPrompt,
      prompts: this.prompts.slice(-MAX_PROMPTS),
      tokens: { ...this.tokens },
      models,
      costUsd: this.costUsd,
      commits: [...this.commits.values()].slice(-MAX_COMMITS),
      filesEdited: [...this.filesEdited],
      planDocs: [...this.planDocs],
      finalMessage: this.segment.length > 0 ? cut(this.segment.join('\n\n').trim(), MAX_FINAL_MESSAGE_CHARS) : null,
    };
  }

  private observeEnvelope(record: TranscriptRecord): void {
    if (typeof record.timestamp === 'string') {
      const ms = Date.parse(record.timestamp);
      if (Number.isFinite(ms)) {
        if (this.firstMs === null || ms < this.firstMs) this.firstMs = ms;
        if (this.lastMs === null || ms > this.lastMs) this.lastMs = ms;
      }
    }
    const cwd = nonEmpty(record.cwd);
    if (cwd !== null && this.cwd === null) this.cwd = cwd;
    const entrypoint = nonEmpty(record.entrypoint);
    if (entrypoint !== null && this.entrypoint === null) this.entrypoint = entrypoint;
    const branch = nonEmpty(record.gitBranch);
    if (branch !== null) this.branch = branch;
    const version = nonEmpty(record.version);
    if (version !== null) this.version = version;
  }

  private addUsage(model: string | null, usage: unknown): void {
    if (!isObject(usage)) return;
    const tokens: TokenCounts = {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
    };
    addInto(this.tokens, tokens);
    if (model === null) return;
    let perModel = this.models.get(model);
    if (perModel === undefined) {
      perModel = zeroTokens();
      this.models.set(model, perModel);
    }
    addInto(perModel, tokens);
  }

  private addUser(record: TranscriptRecord): void {
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (isHumanPrompt(record)) {
      const text = promptText(record);
      if (text !== '' && !INTERRUPTED.test(text) && !BARE_COMMAND.test(text)) {
        const clipped = cut(text, MAX_PROMPT_CHARS);
        this.firstPrompt ??= clipped;
        this.prompts.push({ text: clipped, at });
        if (this.prompts.length > MAX_PROMPTS * 2) this.prompts = this.prompts.slice(-MAX_PROMPTS);
        this.segment = [];
      }
      return;
    }
    const message = record.message;
    const content = isObject(message) ? message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      this.scanCommit(id, toolResultText(block.content), record.toolUseResult, at);
    }
  }

  private scanCommit(id: string | null, text: string, toolUseResult: unknown, at: string | null): void {
    if (!text.includes('] ')) return;
    const pendingIndex = id === null ? -1 : this.pendingCommitIds.indexOf(id);
    if (pendingIndex >= 0) {
      this.pendingCommitIds.splice(pendingIndex, 1);
    } else {
      // A tool_use seen in this read that was not a `git commit`: its output is not a commit.
      if (id !== null && this.toolIdsThisRead.has(id)) return;
      // Its tool_use was in an earlier read we no longer remember: accept Bash-shaped output only.
      if (!isObject(toolUseResult) || typeof toolUseResult.stdout !== 'string') return;
    }
    for (const commit of parseCommitLines(text, at)) {
      if (!this.commits.has(commit.sha)) this.commits.set(commit.sha, commit);
    }
  }

  private addAssistant(record: TranscriptRecord): void {
    const message = record.message;
    if (!isObject(message)) return;
    const rawModel = nonEmpty(message.model);
    const model = rawModel === '<synthetic>' ? null : rawModel;
    const id = nonEmpty(message.id);
    if (id === null) {
      this.addUsage(model, message.usage);
    } else if (!this.recentMessageIds.includes(id)) {
      this.addUsage(model, message.usage);
      this.recentMessageIds.push(id);
      if (this.recentMessageIds.length > RECENT_MESSAGE_IDS * 2) {
        this.recentMessageIds.splice(0, this.recentMessageIds.length - RECENT_MESSAGE_IDS);
      }
    }
    const content = message.content;
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use') {
        this.segment = [];
        this.addToolUse(block);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        this.segment.push(block.text);
      }
    }
  }

  private addToolUse(block: Record<string, unknown>): void {
    const name = typeof block.name === 'string' ? block.name : '';
    const id = typeof block.id === 'string' ? block.id : null;
    const input = isObject(block.input) ? block.input : {};
    if (id !== null) this.toolIdsThisRead.add(id);
    if (name === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (id !== null && GIT_COMMIT_COMMAND.test(command)) this.pendingCommitIds.push(id);
      return;
    }
    const file = nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path);
    if (file === null) return;
    const edits = EDIT_TOOLS.has(name);
    if (edits && this.filesEdited.size < MAX_FILES_EDITED) this.filesEdited.add(file);
    if ((edits || name === 'Read') && PLAN_DOC_PATH.test(file) && this.planDocs.size < MAX_PLAN_DOCS) this.planDocs.add(file);
  }
}

/** Folds every complete record of `text` (a whole transcript, or one read of it). For tests and tools. */
export function accumulateText(sessionId: string, text: string, carry?: TranscriptCarry): TranscriptAccumulator {
  const acc = new TranscriptAccumulator(sessionId, carry);
  for (const line of text.split('\n')) {
    const record = parseRecord(line);
    if (record !== null) acc.add(record);
  }
  return acc;
}

/**
 * The `SessionsRepo.upsertFromTranscript` patch for one read. Accumulators are this read's deltas
 * (the repo adds them, or replaces on `fromOffset === 0`). cwd, entrypoint and repo are sent only
 * for a read from byte 0, where the first cwd is the launch dir; a later read's first cwd may be a
 * `cd` target. Null scalars leave the stored value alone (repo merge rule).
 */
export function buildTranscriptPatch(delta: TranscriptDelta, ctx: PatchContext): TranscriptPatch {
  const fromStart = ctx.fromOffset === 0;
  return {
    sessionId: delta.sessionId,
    host: ctx.host,
    transcriptPath: ctx.transcriptPath,
    fromOffset: ctx.fromOffset,
    toOffset: ctx.toOffset,
    size: ctx.size,
    repo: fromStart ? ctx.repo : null,
    cwd: fromStart ? delta.cwd : null,
    entrypoint: fromStart ? delta.entrypoint : null,
    branch: delta.branch,
    name: delta.name,
    customTitle: delta.customTitle,
    aiTitle: delta.aiTitle,
    firstPrompt: delta.firstPrompt,
    lastPrompt: delta.lastPrompt,
    version: delta.version,
    finalMessage: delta.finalMessage,
    startedAt: delta.firstAt,
    lastActiveAt: delta.lastAt,
    tokens: delta.tokens,
    models: delta.models,
    costUsd: delta.costUsd,
    prompts: delta.prompts,
    commits: delta.commits,
    filesEdited: delta.filesEdited,
    planDocs: delta.planDocs,
  };
}

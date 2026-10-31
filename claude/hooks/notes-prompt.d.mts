import type { PastedImage, TranscriptEntry } from './lib/transcript.mjs';
export { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BASE64_CHARS } from './notes-capture.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One pasted picture of the session, with its memo key `<user_uuid>:<k>` (null without a uuid). */
export interface PromptImage extends PastedImage {
  key: string | null;
}

export interface SelectedImage extends PromptImage {
  /** Index in the `collectImages` list (transcript order). */
  order: number;
  /** Chat image id once stored (memo or upload), else null. */
  id: string | null;
}

export interface ContextImage {
  paste_id: number;
  id: string;
}

export interface MissingLatest {
  paste_id: number | null;
}

export interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export interface PromptIo {
  readText: (file: string) => Promise<string>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}

export const HOOK_EVENT: 'UserPromptSubmit';
export function pastedCall(n: number): string;
export function buildPendingContext(n: number): string;
export const TRANSCRIPT_WAIT_MS: number;
export const TRANSCRIPT_POLL_MS: number;
export const UPLOAD_BUDGET_MS: number;
export const MIN_UPLOAD_TIMEOUT_MS: number;
export const MEMO_DIR: string;
export const MEMO_MAX_AGE_MS: number;
export const LOG_FILE: string;
export const CONTEXT_HEADER: string;
export const TOOLS_HINT: string;

export function isNotesPromptInput(input: unknown): boolean;
export function placeholderNumbers(prompt: string): number[];
export function imagesSettled(entries: TranscriptEntry[], wanted: number[]): boolean;
export function readSettled(
  transcriptPath: string,
  wanted: number[],
  io: PromptIo,
): Promise<{ entries: TranscriptEntry[]; settled: boolean } | null>;
export function collectImages(entries: TranscriptEntry[]): PromptImage[];
export function selectForContext(candidates: PromptImage[], memo: Map<string, string>): SelectedImage[];
export function memoFile(env: Env, session: unknown): string | null;
export function readMemo(file: string | null): Promise<Map<string, string>>;
export function writeMemo(file: string, memo: Map<string, string>): Promise<void>;
export function pruneMemos(dir: string, nowMs: number): Promise<number>;
export function uploadMissing(
  selected: SelectedImage[],
  opts: {
    fetchImpl: FetchLike;
    baseUrl: string;
    now: () => number;
    log: (message: string) => Promise<void>;
    deadline: number;
  },
): Promise<SelectedImage[]>;
export function buildContext(images: ContextImage[], missing: MissingLatest | null): string | null;
export function runPrompt(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<UserPromptSubmitOutput | null>;

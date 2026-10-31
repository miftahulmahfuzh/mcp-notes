import type { PastedImage } from './lib/transcript.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export const TOOL_NAME: string;
export const UPLOAD_PATH: string;
export const DEFAULT_STRATEGY: 'updatedInput' | 'deny';
export const UPLOAD_TIMEOUT_MS: number;
export const TRANSCRIPT_RETRY_MS: number;
export const LOG_FILE: string;

export function pastedImageNumber(toolInput: unknown): number | null;
export function strategyFrom(env: Env): 'updatedInput' | 'deny';
export function allowUnchanged(): PreToolUseOutput;
export function rewriteOutput(toolInput: Record<string, unknown>, uploadId: string): PreToolUseOutput;
export function denyOutput(toolInput: Record<string, unknown>, uploadId: string): PreToolUseOutput;
export function uploadIdFrom(body: unknown): string | null;
export function uploadImage(image: PastedImage, opts: { fetchImpl: FetchLike; baseUrl: string; n: number }): Promise<string>;
export function findPastedImage(
  transcriptPath: unknown,
  n: number,
  io: { readText: (file: string) => Promise<string>; sleep: (ms: number) => Promise<unknown> },
): Promise<PastedImage | null>;
export function runPaste(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<PreToolUseOutput | null>;

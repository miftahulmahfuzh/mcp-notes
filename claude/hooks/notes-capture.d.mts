import type { Turn } from './lib/transcript.mjs';
export { extractImages, findTurn, isNotesPrompt, parseTranscript, promptText } from './lib/transcript.mjs';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CapturePayload {
  claude_session: string;
  user_uuid: string;
  prompt: string;
  answer: string;
  prompt_timestamp: string;
  answered_at: string;
  cwd: string | null;
  images: { media_type: string; data_base64: string }[];
}

export interface DeliverResult {
  outcome: 'delivered' | 'retry' | 'drop';
  status?: number;
  detail?: string;
}

export interface DrainSummary {
  delivered: number;
  dropped: number;
  kept: number;
  stoppedEarly: boolean;
}

export interface PayloadIo {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  readText: (file: string) => Promise<string>;
}

export const CAPTURE_PATH: string;
export const CAPTURE_HEADER: string;
export const MAX_IMAGES: number;
export const MAX_IMAGE_BYTES: number;
export const MAX_IMAGES_BASE64_CHARS: number;
export const IMAGE_MEDIA_TYPES: Set<string>;
export const TRANSCRIPT_WAIT_MS: number;
export const TRANSCRIPT_POLL_MS: number;
export const SETTLE_PROBE_CHARS: number;
export const FETCH_TIMEOUT_MS: number;
export const OUTBOX_MAX_PER_RUN: number;
export const OUTBOX_MAX_AGE_MS: number;
export const LOG_FILE: string;

export function buildPayload(hookInput: Record<string, unknown>, turn: Turn, answer: string, nowIso: string): CapturePayload | null;
export function turnSettled(turn: Turn, lastAssistantMessage: string): boolean;
export function capturePayload(input: unknown, io: PayloadIo): Promise<CapturePayload | null>;
export function deliver(payload: unknown, opts: { fetchImpl: FetchLike; baseUrl: string }): Promise<DeliverResult>;
export function outboxDir(env: Env): string;
export function spool(dir: string, payload: CapturePayload): Promise<string>;
export function drainOutbox(opts: {
  dir: string;
  fetchImpl: FetchLike;
  baseUrl: string;
  now: () => number;
  log: (message: string) => Promise<void>;
  skip?: string | null;
}): Promise<DrainSummary>;
export function runCapture(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  readText?: (file: string) => Promise<string>;
}): Promise<{ outcome: 'skipped' | 'delivered' | 'dropped' | 'spooled'; drained: DrainSummary }>;

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string };
}

export interface StartReply {
  session_id?: string;
  node_id: string;
  parent_session_id?: string | null;
  parent_node_id?: string | null;
  parent_link_source?: string | null;
  claimed?: boolean;
}

export const HOOK_EVENT: 'SessionStart';
export const START_PATH: string;
export const POST_TIMEOUT_MS: number;
export const TMUX_TIMEOUT_MS: number;
export const LOG_FILE: string;
export const PARENT_ENV: string;
export const FRESH_SOURCES: string[];
export const TMUX_TARGET_FORMAT: string;

export function isCliSession(env: Env): boolean;
export function sessionIdOf(input: unknown): string | null;
export function parentFrom(env: Env, sessionId: string): string | null;
export function claudeHome(env: Env): string;
export function candidatePids(env: Env, ppid: number | string | null | undefined): string[];
export function cleanName(value: unknown): string | null;
export function isClaudeWord(word: unknown): boolean;
export function nameFromArgv(argv: unknown): string | null;
export function registryEntry(
  home: string,
  pids: string[],
  sessionId: string,
  readText: (file: string) => Promise<string>,
): Promise<{ pid: string; name: string | null; tmux: string | null } | null>;
export function nameFromProcesses(pids: string[], readText: (file: string) => Promise<string>): Promise<string | null>;
export function tmuxTarget(env: Env, runTmux: (args: string[]) => Promise<string>): Promise<string | null>;
export function buildContext(reply: StartReply): string;
export function runSession(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  readText?: (file: string) => Promise<string>;
  runTmux?: (args: string[]) => Promise<string>;
  now?: () => number;
  ppid?: number | string | null;
  hostname?: () => string;
}): Promise<SessionStartOutput | null>;

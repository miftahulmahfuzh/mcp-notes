export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ShellToken = { word: string; op?: undefined } | { op: string; word?: undefined };
export interface SpawnContext {
  cwd: string;
  home: string;
}
export interface DetectedSpawn {
  cwd: string;
  name: string | null;
}

export const TOOL_NAME: 'Bash';
export const SPAWN_PATH: string;
export const POST_TIMEOUT_MS: number;
export const LOG_FILE: string;

export function mayLaunchClaude(command: unknown): boolean;
export function shellTokens(text: string): ShellToken[];
export function segmentsOf(tokens: ShellToken[]): string[][];
export function parseFlags(
  words: string[],
  argLetters: string,
): { values: Map<string, string[]>; flags: Set<string>; rest: string[] };
export function resolveDir(value: unknown, base: string, ctx: SpawnContext): string | null;
export function claudeLaunchIn(text: string, cwd: string, ctx: SpawnContext): DetectedSpawn | symbol | null;
export function detectSpawn(command: unknown, ctx: SpawnContext): DetectedSpawn | null;
export function runSpawn(opts: {
  input: unknown;
  env: Env;
  fetchImpl?: FetchLike;
  hostname?: () => string;
}): Promise<null>;

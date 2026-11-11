export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const TOOL_NOTE_ID: Record<string, 'id' | 'result'>;
export const LINK_PATH: string;
export const POST_TIMEOUT_MS: number;
export const LOG_FILE: string;

export function resultObjects(response: unknown): object[];
export function noteIdOf(input: unknown): string | null;
export function runLink(opts: { input: unknown; env: Env; fetchImpl?: FetchLike }): Promise<null>;

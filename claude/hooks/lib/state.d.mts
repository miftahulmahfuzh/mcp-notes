export type Env = Record<string, string | undefined>;
export const DEFAULT_PORT: number;
export const LOG_MAX_BYTES: number;
export function daemonBaseUrl(env: Env): string;
export function stateDir(env: Env): string;
export function writeLog(dir: string, file: string, message: string): Promise<void>;
export function errorText(err: unknown): string;
export function readStdin(): Promise<string>;
export function isMainModule(moduleUrl: string): boolean;

export interface HookOptions {
  nodeBin: string;
  hooksDir: string;
  pasteStrategy?: 'updatedInput' | 'deny';
}
export interface SettingsFile {
  exists: boolean;
  text: string | null;
  value: Record<string, unknown>;
}
export type HookEvent = 'Stop' | 'PreToolUse' | 'UserPromptSubmit' | 'SessionStart';
export const OUR_SCRIPT: RegExp;
export const HOOK_SCRIPTS: string[];
export const PASTE_MATCHER: string;
export const SPAWN_MATCHER: string;
export const BACKUP_SUFFIX: string;
export const STOP_TIMEOUT_S: number;
export const PASTE_TIMEOUT_S: number;
export const PROMPT_TIMEOUT_S: number;
export const SESSION_TIMEOUT_S: number;
export const SPAWN_TIMEOUT_S: number;
export const DEFAULT_RETENTION_DAYS: number;
export const PASTE_STRATEGIES: string[];
export const STATUS_ROWS: [HookEvent, string][];
export function shQuote(value: string): string;
export function hookCommand(nodeBin: string, script: string, env?: Record<string, string>): string;
export function isOurHandler(handler: unknown): boolean;
export function ourGroups(options: HookOptions): Record<HookEvent, Record<string, unknown>[]>;
export function mergeHooks(settings: unknown, options: HookOptions): Record<string, unknown>;
export function removeHooks<T>(settings: T): T;
export function ourHandlers(settings: unknown): Record<string, string>;
export function raiseCleanupPeriod<T>(settings: T, minDays: number): T | (T & { cleanupPeriodDays: number });
export function readSettings(file: string): Promise<SettingsFile>;
export function serialize(value: unknown): string;
export function writeSettings(file: string, current: SettingsFile, next: unknown): Promise<'unchanged' | 'written'>;

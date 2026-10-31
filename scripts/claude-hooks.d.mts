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
export const OUR_SCRIPT: RegExp;
export const PASTE_MATCHER: string;
export const BACKUP_SUFFIX: string;
export const STOP_TIMEOUT_S: number;
export const PASTE_TIMEOUT_S: number;
export const PASTE_STRATEGIES: string[];
export function shQuote(value: string): string;
export function hookCommand(nodeBin: string, script: string, env?: Record<string, string>): string;
export function isOurHandler(handler: unknown): boolean;
export function ourGroups(options: HookOptions): Record<'Stop' | 'PreToolUse', Record<string, unknown>>;
export function mergeHooks(settings: unknown, options: HookOptions): Record<string, unknown>;
export function removeHooks<T>(settings: T): T;
export function ourHandlers(settings: unknown): Record<string, string>;
export function readSettings(file: string): Promise<SettingsFile>;
export function serialize(value: unknown): string;
export function writeSettings(file: string, current: SettingsFile, next: unknown): Promise<'unchanged' | 'written'>;

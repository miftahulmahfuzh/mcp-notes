import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The streaming sites the tools know. The sites themselves live in claude/streaming/sites/*.mjs
 * (one module each, shared with the /idlix, /lk21, /flicksy and /dramacool skills); tests/unit/streaming.test.ts checks
 * this list against that folder's registry.
 */
export const STREAMING_SITES = ['idlix', 'lk21', 'flicksy', 'dramacool'] as const;

export type StreamingSite = (typeof STREAMING_SITES)[number];

/** `claude/streaming/cli.mjs`, two folders up from src/streaming or dist/streaming. */
export const DEFAULT_STREAMING_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'claude', 'streaming', 'cli.mjs');

/** Playing waits through a site's countdown and advert, and for Chrome to start. */
export const STREAMING_TIMEOUT_MS = 180_000;

/**
 * Runs `cli.mjs <site> <args...>` and returns the one JSON object it prints. The tools never
 * talk to a site or to Chrome themselves; tests inject a fake.
 */
export type StreamingRunner = (site: StreamingSite, args: string[]) => Promise<unknown>;

export interface ScriptRunnerOptions {
  /** The node binary. Default: the one running the daemon. */
  nodeBin?: string;
  /** Path of cli.mjs. Default: DEFAULT_STREAMING_CLI. */
  cliPath?: string;
  timeoutMs?: number;
}

export interface JsonScriptOptions {
  /** Names the script in errors: `<label> failed: ...`, `<label> printed no JSON: ...`. */
  label: string;
  nodeBin: string;
  /** Script path first, then its arguments. */
  argv: string[];
  timeoutMs: number;
}

/**
 * Runs `node <argv...>` and returns the one JSON object it prints. A script that exits non-zero with
 * its answer on stdout still answers (both streaming CLIs do that for a failure they can name).
 * Shared by the streaming sites and direct streaming (src/directStream/runner.ts).
 */
export async function runJsonScript(options: JsonScriptOptions): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run(options.nodeBin, options.argv, { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== 'string' || out.trim() === '') {
      throw new Error(`${options.label} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    stdout = out;
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${options.label} printed no JSON: ${stdout.slice(0, 200)}`);
  }
}

export function scriptRunner(options: ScriptRunnerOptions = {}): StreamingRunner {
  const nodeBin = options.nodeBin ?? process.execPath;
  const cliPath = options.cliPath ?? DEFAULT_STREAMING_CLI;
  const timeoutMs = options.timeoutMs ?? STREAMING_TIMEOUT_MS;
  return (site, args) => runJsonScript({ label: 'streaming script', nodeBin, argv: [cliPath, site, ...args], timeoutMs });
}

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The streaming sites the tools know. The sites themselves live in claude/streaming/sites/*.mjs
 * (one module each, shared with the /idlix and /lk21 skills); tests/unit/streaming.test.ts checks
 * this list against that folder's registry.
 */
export const STREAMING_SITES = ['idlix', 'lk21'] as const;

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

export function scriptRunner(options: ScriptRunnerOptions = {}): StreamingRunner {
  const nodeBin = options.nodeBin ?? process.execPath;
  const cliPath = options.cliPath ?? DEFAULT_STREAMING_CLI;
  const timeout = options.timeoutMs ?? STREAMING_TIMEOUT_MS;
  return async (site, args) => {
    let stdout: string;
    try {
      ({ stdout } = await run(nodeBin, [cliPath, site, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }));
    } catch (err) {
      // The script exits 1 with its answer on stdout when a site cannot be read or a film did not start.
      const out = (err as { stdout?: unknown }).stdout;
      if (typeof out !== 'string' || out.trim() === '') {
        throw new Error(`streaming script failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      stdout = out;
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error(`streaming script printed no JSON: ${stdout.slice(0, 200)}`);
    }
  };
}

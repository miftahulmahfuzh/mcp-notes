import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { redactQueries } from '../directStream/evidence.js';
import { redactSecrets } from '../sessions/redact.js';

const run = promisify(execFile);

/** Free text from a script with no secret left: magnets, address queries, and what redactSecrets knows. */
function scrub(text: string): string {
  return redactQueries(redactSecrets(text.replace(/magnet:\?\S*/gi, 'magnet:')));
}

/** How many of a failed script's last stderr lines its error keeps, and at most how many characters of them. */
export const STDERR_TAIL_LINES = 8;
export const STDERR_TAIL_CHARS = 1_000;

/**
 * The last lines of a failed script's stderr, for its error: a crash's cause (a stack's first lines come last
 * from a thrown error) instead of only "Command failed". Never a secret: magnets, address queries (a download's
 * `tok`, the Wyzie key) and anything redactSecrets knows are cut. Empty when it wrote nothing.
 */
export function stderrTail(stderr: unknown): string {
  if (typeof stderr !== 'string') return '';
  const lines = stderr
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-STDERR_TAIL_LINES);
  const text = scrub(lines.join(' | '));
  return text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

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
  /**
   * This daemon's port, read at each run (it is known only after listen()): the command reports a
   * play that started to `127.0.0.1:<NOTESD_PORT>`, so a daemon on another port is told its own plays.
   */
  port?: () => number | null;
}

export interface JsonScriptOptions {
  /** Names the script in errors: `<label> failed: ...`, `<label> printed no JSON: ...`. */
  label: string;
  nodeBin: string;
  /** Script path first, then its arguments. */
  argv: string[];
  timeoutMs: number;
  /** Variables added to the daemon's own environment for the script. */
  env?: Record<string, string>;
}

/**
 * Runs `node <argv...>` and returns the one JSON object it prints. A script that exits non-zero with
 * its answer on stdout still answers (both streaming CLIs do that for a failure they can name).
 * Shared by the streaming sites and direct streaming (src/directStream/runner.ts).
 */
export async function runJsonScript(options: JsonScriptOptions): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run(options.nodeBin, options.argv, { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }) }));
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== 'string' || out.trim() === '') {
      const tail = stderrTail((err as { stderr?: unknown }).stderr);
      const first = scrub(err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err));
      throw new Error(`${options.label} failed: ${first}${tail === '' ? '' : `; stderr: ${tail}`}`);
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
  return (site, args) => {
    const port = options.port?.() ?? null;
    return runJsonScript({ label: 'streaming script', nodeBin, argv: [cliPath, site, ...args], timeoutMs, ...(port === null ? {} : { env: { NOTESD_PORT: String(port) } }) });
  };
}

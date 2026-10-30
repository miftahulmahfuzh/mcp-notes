import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'

/**
 * Repo root, resolved from this module's own location so the daemon finds
 * `.env.local` no matter which cwd systemd or a test runner starts it from.
 * `src/config.ts` (tsx, vitest) and `dist/config.js` (built) both sit one
 * level below the root.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_PORT = 7317
export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_DATA_DIR = '~/mcp-notes-data'

export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
}

export interface LoadConfigOptions {
  /** Environment to read. Defaults to `process.env`. Never mutated. */
  env?: NodeJS.ProcessEnv
  /**
   * Dotenv file merged under `env` (real env wins). Defaults to
   * `<REPO_ROOT>/.env.local`; `false` skips it. A missing file is not an error.
   */
  envFile?: string | false
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function readEnvFile(file: string | false): Record<string, string> {
  if (file === false || !existsSync(file)) return {}
  return parseDotenv(readFileSync(file))
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  const port = Number(trimmed)
  if (port > 65535) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  return port
}

/** True when `url` parses and its host is a Neon pooler host (`...-pooler...`). */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).host.includes('-pooler')
  } catch {
    return false
  }
}

/**
 * The runtime database URL.
 * 1. `DATABASE_URL` in the real environment (`options.env` / `process.env`) wins outright:
 *    tests and test-port runs point the daemon at the Docker Postgres this way.
 * 2. Otherwise, of `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (file merged under env), the
 *    pooled one if either is pooled, else whichever exists. The owner's `.env.local` has the two
 *    key names swapped, so the choice goes by host, never by name.
 */
function pickDatabaseUrl(
  realEnv: Record<string, string | undefined>,
  merged: Record<string, string | undefined>,
): string | undefined {
  const explicit = realEnv.DATABASE_URL?.trim()
  if (explicit) return explicit
  const candidates = [merged.DATABASE_URL, merged.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
  return candidates.find(isPooledUrl) ?? candidates[0]
}

function parseHost(raw: string | undefined): typeof LOOPBACK_HOST {
  if (raw === undefined || raw.trim() === '' || raw.trim() === LOOPBACK_HOST) return LOOPBACK_HOST
  throw new ConfigError(
    `NOTESD_HOST is "${raw}". notesd has no auth and binds ${LOOPBACK_HOST} only; ` +
      'unset NOTESD_HOST or set it to 127.0.0.1.',
  )
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Unknown keys (LLM_*, OPENROUTER_API_KEY) are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port or on a non-loopback host.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR

  return {
    databaseUrl,
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir: path.resolve(expandHome(dataDirRaw)),
  }
}

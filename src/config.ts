import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'
import type { ChatBrain } from './chat/backend.js'

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
export const DEFAULT_CHAT_MAX_TURNS = 24
export const DEFAULT_CHAT_TIMEOUT_MS = 180_000
/** A bare name is looked up on PATH by the SDK; the systemd unit sets an absolute path. */
export const DEFAULT_CLAUDE_BIN = 'claude'

/** The GLM endpoint for the fallback brain (z.ai), from `.env.local`'s `LLM_*` keys. */
export interface GlmConfig {
  /** `LLM_BASE_URL` -> the child's `ANTHROPIC_BASE_URL`. */
  baseUrl: string
  /** `LLM_API_KEY` -> the child's `ANTHROPIC_AUTH_TOKEN`. Never logged. */
  apiKey: string
  /** `LLM_MODEL`, e.g. `glm-5.3`. */
  model: string
}

export interface ChatConfig {
  /** `CHAT_BRAIN`, default `claude`. `glm` runs GLM only (no fallback). */
  brain: ChatBrain
  /** `CHAT_MAX_TURNS`, default 24. Integer >= 1. */
  maxTurns: number
  /** `CHAT_TIMEOUT_MS`, default 180000. Wall clock per chat message. Integer >= 1. */
  timeoutMs: number
  /** `NOTESD_CLAUDE_BIN`, default `claude`. A path is ~-expanded and made absolute. */
  claudeBin: string
  /** Set when all three `LLM_*` keys are; null otherwise (Claude runs then have no fallback). */
  glm: GlmConfig | null
}

/** What `loadConfig` returns for `chat` when no chat key is set. Tests build `Config` literals with it. */
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  brain: 'claude',
  maxTurns: DEFAULT_CHAT_MAX_TURNS,
  timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  claudeBin: DEFAULT_CLAUDE_BIN,
  glm: null,
}

/** OpenRouter embeddings: semantic search, `related`, and the embedding worker. */
export interface EmbeddingsConfig {
  /** `OPENROUTER_API_KEY`, trimmed; null when unset or blank (semantic features off). Never logged. */
  apiKey: string | null
}

/** What `loadConfig` returns for `embeddings` without OPENROUTER_API_KEY. Tests build `Config` literals with it. */
export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = { apiKey: null }

export interface Config {
  /** Runtime connection string: the pooled Neon host in production (see `loadConfig`). */
  databaseUrl: string
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
  /** Note embeddings via OpenRouter. `apiKey: null` turns semantic features off. */
  embeddings: EmbeddingsConfig
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

function parseBrain(raw: string | undefined): ChatBrain {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'claude') return 'claude'
  if (value === 'glm') return 'glm'
  throw new ConfigError(`CHAT_BRAIN must be "claude" or "glm", got "${raw}"`)
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
  }
  return Number(trimmed)
}

function parseClaudeBin(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_CLAUDE_BIN
  // A bare command name stays a PATH lookup; anything with a slash is a path.
  return value.includes('/') ? path.resolve(expandHome(value)) : value
}

const GLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const

function parseGlm(env: Record<string, string | undefined>): { glm: GlmConfig | null; missing: string[] } {
  const values = GLM_KEYS.map((key) => env[key]?.trim() ?? '')
  const missing = GLM_KEYS.filter((_, i) => values[i] === '')
  if (missing.length > 0) return { glm: null, missing }
  const [baseUrl = '', apiKey = '', model = ''] = values
  return { glm: { baseUrl, apiKey, model }, missing }
}

function parseChat(env: Record<string, string | undefined>): ChatConfig {
  const brain = parseBrain(env.CHAT_BRAIN)
  const { glm, missing } = parseGlm(env)
  if (brain === 'glm' && glm === null) {
    throw new ConfigError(
      `CHAT_BRAIN=glm needs ${missing.join(', ')} (set them in ${path.join(REPO_ROOT, '.env.local')}).`,
    )
  }
  return {
    brain,
    maxTurns: parsePositiveInt('CHAT_MAX_TURNS', env.CHAT_MAX_TURNS, DEFAULT_CHAT_MAX_TURNS),
    timeoutMs: parsePositiveInt('CHAT_TIMEOUT_MS', env.CHAT_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
    claudeBin: parseClaudeBin(env.NOTESD_CLAUDE_BIN),
    glm,
  }
}

function parseEmbeddings(env: Record<string, string | undefined>): EmbeddingsConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? ''
  return { apiKey: apiKey === '' ? null : apiKey }
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Other keys are ignored.
 * Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, or on CHAT_BRAIN=glm without LLM_*.
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
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
  }
}

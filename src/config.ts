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

/** The dword (daily-words) connector's write identity: src/connectors/dword/user.ts resolves it. */
export interface DwordConfig {
  /** `DWORD_USER_EMAIL`, trimmed; null when unset or blank. Every dword tool then refuses with
   * "daily-words user not configured" instead of writing. Never logged. */
  userEmail: string | null
}

/** What `loadConfig` returns for `dword` without DWORD_USER_EMAIL. Tests build `Config` literals with it. */
export const DEFAULT_DWORD_CONFIG: DwordConfig = { userEmail: null }

export const DEFAULT_CLAUDE_HOME = '~/.claude'
export const DEFAULT_WORKTREES_DIR = '~/.worktrees'
/** Relative to `claudeHome`: where the swarm skill installs its script (`install.sh` in ~/claude-commands). */
export const DEFAULT_SWARM_SCRIPT_REL = path.join('skills', 'swarm', 'swarm.py')

/** Claude Code session ingest (src/sessions/ingest.ts) and the live registry (src/sessions/registry.ts). */
export interface SessionsConfig {
  /** Absolute. `CLAUDE_HOME`, default ~/.claude: transcripts in `projects/`, live registry in `sessions/`. Read only. */
  claudeHome: string
  /** Absolute. `NOTES_WORKTREES_DIR`, default ~/.worktrees: `<dir>/<repo>/<slug>` maps a worktree session to `<repo>`. */
  worktreesDir: string
  /** `NOTESD_SESSIONS`, default on. `off` (or 0/false/no) starts no session ingest. */
  enabled: boolean
  /**
   * `NOTESD_SWARM_SCRIPT`, default `<claudeHome>/skills/swarm/swarm.py`. Absolute. Not checked here:
   * a missing file makes every orch node's `unfinished` null, never an error. Null turns the
   * check off (the test literal `DEFAULT_SESSIONS_CONFIG` uses null).
   */
  swarmScript: string | null
}

/**
 * Sessions off, default paths. Tests build `Config` literals with it, so no test that builds a
 * Config by hand ever reads the real ~/.claude.
 */
export const DEFAULT_SESSIONS_CONFIG: SessionsConfig = {
  claudeHome: path.join(homedir(), '.claude'),
  worktreesDir: path.join(homedir(), '.worktrees'),
  enabled: false,
  swarmScript: null,
}

export const DEFAULT_ADVERSARY_DAILY_CAP = 15
export const DEFAULT_ADVERSARY_GATHER_MODEL = 'sonnet'
export const DEFAULT_ADVERSARY_VERDICT_MODEL = 'opus'
export const DEFAULT_ADVERSARY_GATHER_MAX_TURNS = 20
export const DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS = 420_000
export const DEFAULT_ADVERSARY_POLL_MS = 600_000

/** Seer Adversarial reviewer (src/adversary/*). */
export interface AdversaryConfig {
  /** `NOTESD_ADVERSARY`, default on. `off` starts no reviewer (deps.adversary is null). */
  enabled: boolean
  /** `ADVERSARY_DAILY_CAP`, default 15. Deep reviews per WIB day, both machines together. */
  dailyCap: number
  /** `ADVERSARY_GATHER_MODEL`, default `sonnet`. Agent SDK alias or model id for the gathering stage. */
  gatherModel: string
  /** `ADVERSARY_VERDICT_MODEL`, default `opus`. Agent SDK alias or model id for the verdict. */
  verdictModel: string
  /** `ADVERSARY_GATHER_MAX_TURNS`, default 20. Turn cap of the gathering stage per stock. */
  gatherMaxTurns: number
  /** `ADVERSARY_STOCK_TIMEOUT_MS`, default 420000. Wall clock per stock, both stages. */
  stockTimeoutMs: number
  /** `ADVERSARY_POLL_MS`, default 600000. Pause between automatic passes. */
  pollMs: number
  /** `NOTESD_SEER_DISPATCH`, default on. Start Seer's GitHub nightly from this machine once its data is fetchable. */
  dispatchNightly: boolean
}

/** Reviewer off, default limits. Tests build `Config` literals with it, so no hand-built config ever reviews. */
export const DEFAULT_ADVERSARY_CONFIG: AdversaryConfig = {
  enabled: false,
  dailyCap: DEFAULT_ADVERSARY_DAILY_CAP,
  gatherModel: DEFAULT_ADVERSARY_GATHER_MODEL,
  verdictModel: DEFAULT_ADVERSARY_VERDICT_MODEL,
  gatherMaxTurns: DEFAULT_ADVERSARY_GATHER_MAX_TURNS,
  stockTimeoutMs: DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS,
  pollMs: DEFAULT_ADVERSARY_POLL_MS,
  dispatchNightly: false,
}

export const DEFAULT_MOVIES_SCAN_MS = 120_000
export const DEFAULT_MOVIES_MIN_SECONDS = 900
export const DEFAULT_MOVIES_DONE_DIRS: readonly string[] = ['Done']
export const DEFAULT_TMDB_API_BASE = 'https://api.themoviedb.org/3'
export const DEFAULT_TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'
export const DEFAULT_FFPROBE_BIN = 'ffprobe'
export const DEFAULT_VLC_BIN = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
export const DEFAULT_VLC_HTTP_PORT = 47318
export const DEFAULT_VLC_POLL_MS = 5_000
export const DEFAULT_CURL_EXE = '/mnt/c/Windows/System32/curl.exe'
/** NOTESD_VLC_HEALTH_MS default: one vlc.exe sample every 30 s (src/movies/vlc/health.ts). */
export const DEFAULT_VLC_HEALTH_MS = 30_000
/** A non-zero NOTESD_VLC_HEALTH_MS below this is rejected: one PowerShell detail read takes ~0.5 s. */
export const MIN_VLC_HEALTH_MS = 5_000
export const DEFAULT_MOVIES_FALLBACK_MODEL = 'haiku'

/** TMDB credentials and hosts (src/movies/tmdb.ts). Secrets are never logged. */
export interface TmdbConfig {
  /** `TMDB_API_READ_ACCESS_TOKEN` (v4 bearer), trimmed; null when unset or blank. Preferred. */
  token: string | null
  /** `TMDB_API_KEY` (v3 `api_key=`), trimmed; null when unset or blank. Used when there is no token. */
  apiKey: string | null
  /** `TMDB_API_BASE`, no trailing slash. Tests point it at a fixture server. */
  apiBase: string
  /** `TMDB_IMAGE_BASE`, no trailing slash. Poster URLs are `<imageBase>/<size><poster_path>`. */
  imageBase: string
}

/** The Windows VLC notesd launches and reads (src/movies/vlc/*). */
export interface VlcConfig {
  /** `NOTESD_VLC_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  bin: string
  /** `NOTESD_VLC_INI`: VLC's `vlc-qt-interface.ini`, absolute. Null turns the recents backfill off. */
  ini: string | null
  /** `NOTESD_VLC_HTTP_PORT`, 1-65535: the port of the HTTP interface of a VLC notesd starts. */
  httpPort: number
  /** `NOTESD_VLC_POLL_MS`: how often a playing VLC is read. */
  pollMs: number
  /** `NOTESD_CURL_EXE`: the Windows curl that reaches VLC's loopback-only HTTP interface. */
  curlExe: string
  /**
   * `NOTESD_VLC_HEALTH_MS`: how often every vlc.exe on this host is sampled into the health log.
   * 0 turns the health log, crash incidents and hang detection off.
   */
  healthMs: number
  /**
   * `NOTESD_VLC_EXTRA_ARGS`, split on whitespace (no quoting): appended to every VLC notesd starts,
   * before the file. Never `--http-*`, `--extraintf`, `--intf` or `-I` (notesd owns the HTTP interface).
   */
  extraArgs: string[]
}

/** The movies library (src/movies/*). */
export interface MoviesConfig {
  /** `NOTESD_MOVIES`, default on. `off` scans nothing and spawns nothing. */
  enabled: boolean
  /** `NOTESD_MOVIES_ROOTS`, `:`-separated absolute directories, scanned recursively. Empty: nothing is scanned. */
  roots: string[]
  /** `NOTESD_MOVIES_DONE_DIRS`, `:`-separated folder names (not paths), matched case-insensitively below a root. */
  doneDirs: string[]
  /** `NOTESD_MOVIES_SCAN_MS`: pause between sync passes. */
  scanMs: number
  /** `NOTESD_MOVIES_MIN_SECONDS`: shorter videos stay out of the library (unmatched, too_short). */
  minSeconds: number
  tmdb: TmdbConfig
  /** `NOTESD_FFPROBE_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  ffprobeBin: string
  vlc: VlcConfig
  /**
   * `NOTESD_MOVIES_FALLBACK_MODEL`: Agent SDK alias or model id that names a file TMDB could not match.
   * `off` gives null: no Haiku fallback (phase 3 then builds none; verify.sh pins it off).
   */
  fallbackModel: string | null
}

/** Movies off, no roots, no TMDB credentials, no VLC ini. Tests build `Config` literals with it. */
export const DEFAULT_MOVIES_CONFIG: MoviesConfig = {
  enabled: false,
  roots: [],
  doneDirs: [...DEFAULT_MOVIES_DONE_DIRS],
  scanMs: DEFAULT_MOVIES_SCAN_MS,
  minSeconds: DEFAULT_MOVIES_MIN_SECONDS,
  tmdb: { token: null, apiKey: null, apiBase: DEFAULT_TMDB_API_BASE, imageBase: DEFAULT_TMDB_IMAGE_BASE },
  ffprobeBin: DEFAULT_FFPROBE_BIN,
  vlc: {
    bin: DEFAULT_VLC_BIN,
    ini: null,
    httpPort: DEFAULT_VLC_HTTP_PORT,
    pollMs: DEFAULT_VLC_POLL_MS,
    curlExe: DEFAULT_CURL_EXE,
    healthMs: DEFAULT_VLC_HEALTH_MS,
    extraArgs: [],
  },
  fallbackModel: DEFAULT_MOVIES_FALLBACK_MODEL,
}

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
  /** Claude Code session ingest. `enabled: false` starts nothing (DEFAULT_SESSIONS_CONFIG in tests). */
  sessions: SessionsConfig
  /** Seer Adversarial reviewer. `enabled: false` starts nothing (DEFAULT_ADVERSARY_CONFIG in tests). */
  adversary: AdversaryConfig
  /** The dword (daily-words) connector's write identity. `userEmail: null` means every dword write refuses. */
  dword: DwordConfig
  /** The movies library. `enabled: false` starts nothing (DEFAULT_MOVIES_CONFIG in tests). */
  movies: MoviesConfig
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

function parseBin(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback
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
    claudeBin: parseBin(env.NOTESD_CLAUDE_BIN, DEFAULT_CLAUDE_BIN),
    glm,
  }
}

function parseEmbeddings(env: Record<string, string | undefined>): EmbeddingsConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? ''
  return { apiKey: apiKey === '' ? null : apiKey }
}

function parseDword(env: Record<string, string | undefined>): DwordConfig {
  const userEmail = env.DWORD_USER_EMAIL?.trim() ?? ''
  return { userEmail: userEmail === '' ? null : userEmail }
}

function parseSwitch(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'on' || value === '1' || value === 'true' || value === 'yes') return true
  if (value === 'off' || value === '0' || value === 'false' || value === 'no') return false
  throw new ConfigError(`${name} must be "on" or "off", got "${raw}"`)
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/

function parseModel(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  if (!MODEL_NAME.test(value)) throw new ConfigError(`${name} must be a model alias or id such as "opus", got "${raw}"`)
  return value
}

export function parseAdversary(env: Record<string, string | undefined>): AdversaryConfig {
  return {
    enabled: parseSwitch('NOTESD_ADVERSARY', env.NOTESD_ADVERSARY),
    dailyCap: parsePositiveInt('ADVERSARY_DAILY_CAP', env.ADVERSARY_DAILY_CAP, DEFAULT_ADVERSARY_DAILY_CAP),
    gatherModel: parseModel('ADVERSARY_GATHER_MODEL', env.ADVERSARY_GATHER_MODEL, DEFAULT_ADVERSARY_GATHER_MODEL),
    verdictModel: parseModel('ADVERSARY_VERDICT_MODEL', env.ADVERSARY_VERDICT_MODEL, DEFAULT_ADVERSARY_VERDICT_MODEL),
    gatherMaxTurns: parsePositiveInt('ADVERSARY_GATHER_MAX_TURNS', env.ADVERSARY_GATHER_MAX_TURNS, DEFAULT_ADVERSARY_GATHER_MAX_TURNS),
    stockTimeoutMs: parsePositiveInt('ADVERSARY_STOCK_TIMEOUT_MS', env.ADVERSARY_STOCK_TIMEOUT_MS, DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS),
    pollMs: parsePositiveInt('ADVERSARY_POLL_MS', env.ADVERSARY_POLL_MS, DEFAULT_ADVERSARY_POLL_MS),
    dispatchNightly: parseSwitch('NOTESD_SEER_DISPATCH', env.NOTESD_SEER_DISPATCH),
  }
}

function parseSwarmScript(raw: string | undefined, claudeHome: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return path.join(claudeHome, DEFAULT_SWARM_SCRIPT_REL)
  return path.resolve(expandHome(value))
}

export function parseSessions(env: Record<string, string | undefined>): SessionsConfig {
  const claudeHome = path.resolve(expandHome(env.CLAUDE_HOME?.trim() || DEFAULT_CLAUDE_HOME))
  return {
    claudeHome,
    worktreesDir: path.resolve(expandHome(env.NOTES_WORKTREES_DIR?.trim() || DEFAULT_WORKTREES_DIR)),
    enabled: parseSwitch('NOTESD_SESSIONS', env.NOTESD_SESSIONS),
    swarmScript: parseSwarmScript(env.NOTESD_SWARM_SCRIPT, claudeHome),
  }
}

function parseSecret(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  return value === '' ? null : value
}

function parseAbsolutePaths(name: string, raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(':')) {
    const value = part.trim()
    if (value === '') continue
    const expanded = expandHome(value)
    if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} takes absolute paths separated by ":", got "${value}"`)
    const resolved = path.resolve(expanded)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

function parseFolderNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  const names = (raw ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (names.length === 0) return [...fallback]
  for (const n of names) {
    if (n.includes('/') || n === '.' || n === '..') throw new ConfigError(`${name} takes folder names, not paths, got "${n}"`)
  }
  return names
}

function parseOptionalAbsolutePath(name: string, raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  if (value === '') return null
  const expanded = expandHome(value)
  if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} must be an absolute path, got "${raw}"`)
  return path.resolve(expanded)
}

function parseHttpBase(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  return value.replace(/\/+$/, '')
}

function parseTcpPort(name: string, raw: string | undefined, fallback: number): number {
  const port = parsePositiveInt(name, raw, fallback)
  if (port > 65535) throw new ConfigError(`${name} must be an integer 1-65535, got "${raw}"`)
  return port
}

function parseVlcHealthMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_VLC_HEALTH_MS
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || (value !== 0 && value < MIN_VLC_HEALTH_MS)) {
    throw new ConfigError(`NOTESD_VLC_HEALTH_MS must be 0 (off) or an integer of at least ${MIN_VLC_HEALTH_MS}, got "${raw}"`)
  }
  return value
}

/** notesd's own VLC flags: an extra argument may not replace them, or tracking breaks. */
const RESERVED_VLC_ARG = /^(--http-|--extraintf(=|$)|--intf(=|$)|-I$)/

function parseVlcExtraArgs(raw: string | undefined): string[] {
  const args = (raw ?? '')
    .trim()
    .split(/\s+/)
    .filter((a) => a !== '')
  for (const a of args) {
    if (RESERVED_VLC_ARG.test(a)) {
      throw new ConfigError(`NOTESD_VLC_EXTRA_ARGS must not set ${a}: notesd owns VLC's HTTP interface`)
    }
  }
  return args
}

export function parseMovies(env: Record<string, string | undefined>): MoviesConfig {
  return {
    enabled: parseSwitch('NOTESD_MOVIES', env.NOTESD_MOVIES),
    roots: parseAbsolutePaths('NOTESD_MOVIES_ROOTS', env.NOTESD_MOVIES_ROOTS),
    doneDirs: parseFolderNames('NOTESD_MOVIES_DONE_DIRS', env.NOTESD_MOVIES_DONE_DIRS, DEFAULT_MOVIES_DONE_DIRS),
    scanMs: parsePositiveInt('NOTESD_MOVIES_SCAN_MS', env.NOTESD_MOVIES_SCAN_MS, DEFAULT_MOVIES_SCAN_MS),
    minSeconds: parsePositiveInt('NOTESD_MOVIES_MIN_SECONDS', env.NOTESD_MOVIES_MIN_SECONDS, DEFAULT_MOVIES_MIN_SECONDS),
    tmdb: {
      token: parseSecret(env.TMDB_API_READ_ACCESS_TOKEN),
      apiKey: parseSecret(env.TMDB_API_KEY),
      apiBase: parseHttpBase('TMDB_API_BASE', env.TMDB_API_BASE, DEFAULT_TMDB_API_BASE),
      imageBase: parseHttpBase('TMDB_IMAGE_BASE', env.TMDB_IMAGE_BASE, DEFAULT_TMDB_IMAGE_BASE),
    },
    ffprobeBin: parseBin(env.NOTESD_FFPROBE_BIN, DEFAULT_FFPROBE_BIN),
    vlc: {
      bin: parseBin(env.NOTESD_VLC_BIN, DEFAULT_VLC_BIN),
      ini: parseOptionalAbsolutePath('NOTESD_VLC_INI', env.NOTESD_VLC_INI),
      httpPort: parseTcpPort('NOTESD_VLC_HTTP_PORT', env.NOTESD_VLC_HTTP_PORT, DEFAULT_VLC_HTTP_PORT),
      pollMs: parsePositiveInt('NOTESD_VLC_POLL_MS', env.NOTESD_VLC_POLL_MS, DEFAULT_VLC_POLL_MS),
      curlExe: parseBin(env.NOTESD_CURL_EXE, DEFAULT_CURL_EXE),
      healthMs: parseVlcHealthMs(env.NOTESD_VLC_HEALTH_MS),
      extraArgs: parseVlcExtraArgs(env.NOTESD_VLC_EXTRA_ARGS),
    },
    fallbackModel:
      env.NOTESD_MOVIES_FALLBACK_MODEL?.trim().toLowerCase() === 'off'
        ? null
        : parseModel('NOTESD_MOVIES_FALLBACK_MODEL', env.NOTESD_MOVIES_FALLBACK_MODEL, DEFAULT_MOVIES_FALLBACK_MODEL),
  }
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Sessions keys: CLAUDE_HOME, NOTES_WORKTREES_DIR, NOTESD_SESSIONS,
 * NOTESD_SWARM_SCRIPT. Adversary keys: NOTESD_ADVERSARY, ADVERSARY_DAILY_CAP,
 * ADVERSARY_GATHER_MODEL, ADVERSARY_VERDICT_MODEL, ADVERSARY_GATHER_MAX_TURNS,
 * ADVERSARY_STOCK_TIMEOUT_MS, ADVERSARY_POLL_MS, NOTESD_SEER_DISPATCH. Egress key: NOTESD_EGRESS_METER
 * (read by src/db/client.ts; `off` disables the query meter and the Neon quota breaker). Dword key: DWORD_USER_EMAIL
 * (unset or blank: every dword_vocab_add / dword_journal_add write tool refuses with "daily-words
 * user not configured"; dword_schema/dword_sql are unaffected, since they need no user id).
 * Movies keys: NOTESD_MOVIES, NOTESD_MOVIES_ROOTS, NOTESD_MOVIES_DONE_DIRS, NOTESD_MOVIES_SCAN_MS,
 * NOTESD_MOVIES_MIN_SECONDS, TMDB_API_READ_ACCESS_TOKEN, TMDB_API_KEY, TMDB_API_BASE, TMDB_IMAGE_BASE,
 * NOTESD_FFPROBE_BIN, NOTESD_VLC_BIN, NOTESD_VLC_INI, NOTESD_VLC_HTTP_PORT, NOTESD_VLC_POLL_MS,
 * NOTESD_CURL_EXE, NOTESD_VLC_HEALTH_MS, NOTESD_VLC_EXTRA_ARGS, NOTESD_MOVIES_FALLBACK_MODEL
 * (relative roots or ini, a path as a Done folder name, a non-http TMDB base, a port above 65535,
 * a health interval of 1-4999 ms or an extra VLC arg that sets the HTTP interface throw ConfigError).
 * Other keys are ignored. Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, on CHAT_BRAIN=glm without LLM_*,
 * or on a NOTESD_SESSIONS value other than on/off.
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
    sessions: parseSessions(env),
    adversary: parseAdversary(env),
    dword: parseDword(env),
    movies: parseMovies(env),
  }
}

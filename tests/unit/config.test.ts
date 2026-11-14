import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ConfigError,
  DEFAULT_ADVERSARY_CONFIG,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_DWORD_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_MOVIES_CONFIG,
  DEFAULT_PORT,
  DEFAULT_SESSIONS_CONFIG,
  loadConfig,
  REPO_ROOT,
} from '../../src/config.js'

const URL_A = 'postgres://u:p@127.0.0.1:5432/a'

describe('loadConfig', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function envFile(contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-config-'))
    tmpDirs.push(dir)
    const file = path.join(dir, '.env.local')
    writeFileSync(file, contents)
    return file
  }

  it('resolves REPO_ROOT to the directory holding package.json', () => {
    expect(existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true)
  })

  it('applies defaults', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false })
    expect(cfg).toEqual({
      databaseUrl: URL_A,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      dataDir: path.join(homedir(), 'mcp-notes-data'),
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
      sessions: { claudeHome: path.join(homedir(), '.claude'), worktreesDir: path.join(homedir(), '.worktrees'), enabled: true, swarmScript: path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py') },
      adversary: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true, dispatchNightly: true },
      dword: DEFAULT_DWORD_CONFIG,
      movies: { ...DEFAULT_MOVIES_CONFIG, enabled: true },
    })
    expect(cfg.chat).toEqual({ brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: 'claude', glm: null })
    expect(cfg.embeddings).toEqual({ apiKey: null })
    expect(cfg.dword).toEqual({ userEmail: null })
  })

  it('reads the env file and lets the real environment win', () => {
    const file = envFile(
      ['LLM_API_KEY=ignored', 'DATABASE_URL=postgres://file/db', 'NOTESD_PORT=7400', 'OPENROUTER_API_KEY=x'].join('\n'),
    )
    expect(loadConfig({ env: {}, envFile: file })).toMatchObject({ databaseUrl: 'postgres://file/db', port: 7400 })
    expect(loadConfig({ env: {}, envFile: file }).embeddings).toEqual({ apiKey: 'x' })
    expect(loadConfig({ env: { NOTESD_PORT: '7401' }, envFile: file }).port).toBe(7401)
    expect(loadConfig({ env: { OPENROUTER_API_KEY: 'y' }, envFile: file }).embeddings.apiKey).toBe('y')
  })

  it('prefers the pooled host of the two file URLs, whatever their key names', () => {
    const pooled = 'postgresql://u:p@ep-x-pooler.c-2.aws.neon.tech/db'
    const direct = 'postgresql://u:p@ep-x.c-2.aws.neon.tech/db'
    // the owner's file today: names swapped
    expect(
      loadConfig({ env: {}, envFile: envFile(`DATABASE_URL=${direct}\nDATABASE_URL_UNPOOLED=${pooled}\n`) }).databaseUrl,
    ).toBe(pooled)
    // a corrected file
    expect(
      loadConfig({ env: {}, envFile: envFile(`DATABASE_URL=${pooled}\nDATABASE_URL_UNPOOLED=${direct}\n`) }).databaseUrl,
    ).toBe(pooled)
    // only one key present
    expect(loadConfig({ env: {}, envFile: envFile(`DATABASE_URL_UNPOOLED=${direct}\n`) }).databaseUrl).toBe(direct)
  })

  it('lets a real-env DATABASE_URL override both file URLs', () => {
    const file = envFile('DATABASE_URL=postgresql://u:p@ep-x.neon.tech/db\nDATABASE_URL_UNPOOLED=postgresql://u:p@ep-x-pooler.neon.tech/db\n')
    expect(loadConfig({ env: { DATABASE_URL: URL_A }, envFile: file }).databaseUrl).toBe(URL_A)
  })

  it('treats a missing env file as empty', () => {
    expect(() => loadConfig({ env: {}, envFile: '/nonexistent/.env.local' })).toThrow(ConfigError)
  })

  it('throws when DATABASE_URL is missing or blank', () => {
    expect(() => loadConfig({ env: {}, envFile: false })).toThrow(/DATABASE_URL is not set/)
    expect(() => loadConfig({ env: { DATABASE_URL: '  ' }, envFile: false })).toThrow(ConfigError)
  })

  it('parses NOTESD_PORT, including 0 for tests', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: '0' }, envFile: false }).port).toBe(0)
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: ' 7399 ' }, envFile: false }).port).toBe(7399)
  })

  it.each(['abc', '-1', '65536', '7317.5'])('rejects NOTESD_PORT=%j', (port) => {
    expect(() => loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_PORT: port }, envFile: false })).toThrow(ConfigError)
  })

  it('accepts only the loopback host', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_HOST: '127.0.0.1' }, envFile: false }).host).toBe('127.0.0.1')
    for (const host of ['0.0.0.0', 'localhost', '::', '192.168.1.5']) {
      expect(() => loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_HOST: host }, envFile: false })).toThrow(
        /binds 127\.0\.0\.1 only/,
      )
    }
  })

  it('expands ~ and resolves NOTES_DATA_DIR to an absolute path', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: '~/x/y' }, envFile: false }).dataDir).toBe(
      path.join(homedir(), 'x', 'y'),
    )
    expect(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: '/tmp/notes-data' }, envFile: false }).dataDir).toBe(
      '/tmp/notes-data',
    )
    expect(path.isAbsolute(loadConfig({ env: { DATABASE_URL: URL_A, NOTES_DATA_DIR: 'rel' }, envFile: false }).dataDir)).toBe(
      true,
    )
  })

  it('does not mutate the env it was given', () => {
    const env = { DATABASE_URL: URL_A }
    const file = envFile('NOTESD_PORT=7500\n')
    loadConfig({ env, envFile: file })
    expect(env).toEqual({ DATABASE_URL: URL_A })
  })
})

describe('loadConfig chat', () => {
  const GLM = { LLM_BASE_URL: 'https://api.z.ai/api/anthropic', LLM_API_KEY: 'k-123', LLM_MODEL: 'glm-5.3' }

  function chat(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).chat
  }

  it('reads CHAT_BRAIN case-insensitively, default claude', () => {
    expect(chat({}).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: '' }).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: ' Claude ' }).brain).toBe('claude')
    expect(chat({ CHAT_BRAIN: 'GLM', ...GLM }).brain).toBe('glm')
  })

  it.each(['gpt', 'claude,glm', 'opus'])('rejects CHAT_BRAIN=%j', (brain) => {
    expect(() => chat({ CHAT_BRAIN: brain })).toThrow(/CHAT_BRAIN must be "claude" or "glm"/)
  })

  it('builds glm only when all three LLM_* keys are set', () => {
    expect(chat(GLM).glm).toEqual({ baseUrl: GLM.LLM_BASE_URL, apiKey: 'k-123', model: 'glm-5.3' })
    expect(chat({ LLM_API_KEY: 'k', LLM_MODEL: 'm' }).glm).toBeNull()
    expect(chat({ ...GLM, LLM_MODEL: '  ' }).glm).toBeNull()
  })

  it('reads LLM_* from the env file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-config-'))
    try {
      const file = path.join(dir, '.env.local')
      writeFileSync(file, `DATABASE_URL=${URL_A}\nLLM_BASE_URL=https://x\nLLM_API_KEY=k\nLLM_MODEL=glm-5.3\n`)
      expect(loadConfig({ env: {}, envFile: file }).chat.glm).toEqual({ baseUrl: 'https://x', apiKey: 'k', model: 'glm-5.3' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses CHAT_BRAIN=glm without the LLM_* keys and names the missing ones, not the key value', () => {
    expect(() => chat({ CHAT_BRAIN: 'glm' })).toThrow(ConfigError)
    expect(() => chat({ CHAT_BRAIN: 'glm', LLM_API_KEY: 'secret-key' })).toThrow(/LLM_BASE_URL, LLM_MODEL/)
    try {
      chat({ CHAT_BRAIN: 'glm', LLM_API_KEY: 'secret-key' })
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-key')
    }
  })

  it('parses CHAT_MAX_TURNS and CHAT_TIMEOUT_MS as positive integers', () => {
    expect(chat({ CHAT_MAX_TURNS: ' 8 ', CHAT_TIMEOUT_MS: '60000' })).toMatchObject({ maxTurns: 8, timeoutMs: 60_000 })
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      expect(() => chat({ CHAT_MAX_TURNS: bad })).toThrow(/CHAT_MAX_TURNS must be a positive integer/)
      expect(() => chat({ CHAT_TIMEOUT_MS: bad })).toThrow(/CHAT_TIMEOUT_MS must be a positive integer/)
    }
  })

  it('keeps a bare NOTESD_CLAUDE_BIN as a PATH name and resolves a path', () => {
    expect(chat({ NOTESD_CLAUDE_BIN: 'claude' }).claudeBin).toBe('claude')
    expect(chat({ NOTESD_CLAUDE_BIN: '/opt/node/bin/claude' }).claudeBin).toBe('/opt/node/bin/claude')
    expect(chat({ NOTESD_CLAUDE_BIN: '~/tools/bin/claude' }).claudeBin).toBe(path.join(homedir(), 'tools', 'bin', 'claude'))
  })
})

describe('loadConfig embeddings', () => {
  function embeddings(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).embeddings
  }

  it('is off without OPENROUTER_API_KEY, or with a blank one', () => {
    expect(embeddings({})).toEqual({ apiKey: null })
    expect(embeddings({ OPENROUTER_API_KEY: '' })).toEqual({ apiKey: null })
    expect(embeddings({ OPENROUTER_API_KEY: '   ' })).toEqual({ apiKey: null })
  })

  it('trims the key', () => {
    expect(embeddings({ OPENROUTER_API_KEY: '  sk-or-v1-abc \n' })).toEqual({ apiKey: 'sk-or-v1-abc' })
  })

  it('keeps DEFAULT_EMBEDDINGS_CONFIG off', () => {
    expect(DEFAULT_EMBEDDINGS_CONFIG).toEqual({ apiKey: null })
  })
})

describe('loadConfig dword', () => {
  function dword(env: Record<string, string>) {
    return loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).dword
  }

  it('is unconfigured without DWORD_USER_EMAIL, or with a blank one', () => {
    expect(dword({})).toEqual({ userEmail: null })
    expect(dword({ DWORD_USER_EMAIL: '' })).toEqual({ userEmail: null })
    expect(dword({ DWORD_USER_EMAIL: '   ' })).toEqual({ userEmail: null })
  })

  it('trims DWORD_USER_EMAIL', () => {
    expect(dword({ DWORD_USER_EMAIL: '  owner@example.com \n' })).toEqual({ userEmail: 'owner@example.com' })
  })

  it('keeps DEFAULT_DWORD_CONFIG unconfigured', () => {
    expect(DEFAULT_DWORD_CONFIG).toEqual({ userEmail: null })
  })
})

describe('loadConfig sessions', () => {
  const sessions = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).sessions

  it('reads NOTESD_SWARM_SCRIPT, defaulting under CLAUDE_HOME', () => {
    const home = loadConfig({ env: { DATABASE_URL: URL_A, CLAUDE_HOME: '/tmp/cc-home' }, envFile: false })
    expect(home.sessions.swarmScript).toBe('/tmp/cc-home/skills/swarm/swarm.py')

    const custom = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '~/bin/swarm.py' }, envFile: false })
    expect(custom.sessions.swarmScript).toBe(path.join(homedir(), 'bin', 'swarm.py'))

    const blank = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '  ' }, envFile: false })
    expect(blank.sessions.swarmScript).toBe(path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py'))
  })

  it('does not require the swarm script to exist', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '/nope/swarm.py' }, envFile: false })
    expect(cfg.sessions.swarmScript).toBe('/nope/swarm.py')
  })

  it('defaults to ~/.claude and ~/.worktrees, on', () => {
    expect(sessions({})).toEqual({
      claudeHome: path.join(homedir(), '.claude'),
      worktreesDir: path.join(homedir(), '.worktrees'),
      enabled: true,
      swarmScript: path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py'),
    })
  })

  it('expands ~ and resolves CLAUDE_HOME and NOTES_WORKTREES_DIR', () => {
    expect(sessions({ CLAUDE_HOME: '~/alt-claude', NOTES_WORKTREES_DIR: '/srv/wt/' })).toMatchObject({
      claudeHome: path.join(homedir(), 'alt-claude'),
      worktreesDir: '/srv/wt',
    })
  })

  it('turns ingest off with NOTESD_SESSIONS=off and rejects other words', () => {
    for (const off of ['off', 'OFF', '0', 'false', 'no']) expect(sessions({ NOTESD_SESSIONS: off }).enabled).toBe(false)
    for (const on of ['', 'on', '1', 'true', 'yes']) expect(sessions({ NOTESD_SESSIONS: on }).enabled).toBe(true)
    expect(() => sessions({ NOTESD_SESSIONS: 'maybe' })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_SESSIONS_CONFIG off so hand-built test configs never read ~/.claude', () => {
    expect(DEFAULT_SESSIONS_CONFIG.enabled).toBe(false)
  })
})

describe('adversary config', () => {
  it('defaults to on, 15 deep reviews a day, sonnet gathers and opus decides', () => {
    expect(loadConfig({ env: { DATABASE_URL: URL_A }, envFile: false }).adversary).toEqual({
      enabled: true,
      dailyCap: 15,
      gatherModel: 'sonnet',
      verdictModel: 'opus',
      gatherMaxTurns: 20,
      stockTimeoutMs: 420_000,
      pollMs: 600_000,
      dispatchNightly: true,
    })
  })

  it('reads every key', () => {
    const env = {
      DATABASE_URL: URL_A,
      NOTESD_ADVERSARY: 'off',
      ADVERSARY_DAILY_CAP: '3',
      ADVERSARY_GATHER_MODEL: 'haiku',
      ADVERSARY_VERDICT_MODEL: 'claude-opus-5-5',
      ADVERSARY_GATHER_MAX_TURNS: '9',
      ADVERSARY_STOCK_TIMEOUT_MS: '60000',
      ADVERSARY_POLL_MS: '5000',
      NOTESD_SEER_DISPATCH: 'off',
    }
    expect(loadConfig({ env, envFile: false }).adversary).toEqual({
      enabled: false,
      dailyCap: 3,
      gatherModel: 'haiku',
      verdictModel: 'claude-opus-5-5',
      gatherMaxTurns: 9,
      stockTimeoutMs: 60_000,
      pollMs: 5_000,
      dispatchNightly: false,
    })
  })

  it.each([
    ['NOTESD_ADVERSARY', 'maybe'],
    ['ADVERSARY_DAILY_CAP', '0'],
    ['ADVERSARY_POLL_MS', '-5'],
    ['NOTESD_SEER_DISPATCH', 'sometimes'],
    ['ADVERSARY_VERDICT_MODEL', 'op us'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadConfig({ env: { DATABASE_URL: URL_A, [key]: value }, envFile: false })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_ADVERSARY_CONFIG off so hand-built test configs never review', () => {
    expect(DEFAULT_ADVERSARY_CONFIG.enabled).toBe(false)
  })
})

describe('movies config', () => {
  const movies = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).movies

  it('defaults to on with no roots, Done as the done folder, no TMDB credentials and no VLC ini', () => {
    expect(movies({})).toEqual({
      enabled: true,
      roots: [],
      doneDirs: ['Done'],
      scanMs: 120_000,
      minSeconds: 900,
      tmdb: { token: null, apiKey: null, apiBase: 'https://api.themoviedb.org/3', imageBase: 'https://image.tmdb.org/t/p' },
      ffprobeBin: 'ffprobe',
      vlc: {
        bin: '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe',
        ini: null,
        httpPort: 47318,
        pollMs: 5000,
        curlExe: '/mnt/c/Windows/System32/curl.exe',
        healthMs: 30_000,
        extraArgs: [],
      },
      fallbackModel: 'haiku',
    })
  })

  it('reads every key', () => {
    expect(
      movies({
        NOTESD_MOVIES: 'off',
        NOTESD_MOVIES_ROOTS: '/mnt/c/Users/x/Videos/:/mnt/c/Users/x/Downloads/Telegram Desktop:~/films:/mnt/c/Users/x/Videos',
        NOTESD_MOVIES_DONE_DIRS: 'Done: Watched ',
        NOTESD_MOVIES_SCAN_MS: '60000',
        NOTESD_MOVIES_MIN_SECONDS: '600',
        TMDB_API_READ_ACCESS_TOKEN: ' tok ',
        TMDB_API_KEY: 'key',
        TMDB_API_BASE: 'http://127.0.0.1:9999/3/',
        TMDB_IMAGE_BASE: 'http://127.0.0.1:9999/img',
        NOTESD_FFPROBE_BIN: '/usr/bin/ffprobe',
        NOTESD_VLC_BIN: '/tmp/fake vlc/vlc.exe',
        NOTESD_VLC_INI: '~/vlc/vlc-qt-interface.ini',
        NOTESD_VLC_HTTP_PORT: '48000',
        NOTESD_VLC_POLL_MS: '250',
        NOTESD_CURL_EXE: 'curl.exe',
        NOTESD_VLC_HEALTH_MS: '0',
        NOTESD_VLC_EXTRA_ARGS: '  --avcodec-hw=none   --no-video-title-show ',
        NOTESD_MOVIES_FALLBACK_MODEL: 'claude-haiku-4-5',
      }),
    ).toEqual({
      enabled: false,
      roots: ['/mnt/c/Users/x/Videos', '/mnt/c/Users/x/Downloads/Telegram Desktop', path.join(homedir(), 'films')],
      doneDirs: ['Done', 'Watched'],
      scanMs: 60_000,
      minSeconds: 600,
      tmdb: { token: 'tok', apiKey: 'key', apiBase: 'http://127.0.0.1:9999/3', imageBase: 'http://127.0.0.1:9999/img' },
      ffprobeBin: '/usr/bin/ffprobe',
      vlc: {
        bin: '/tmp/fake vlc/vlc.exe',
        ini: path.join(homedir(), 'vlc', 'vlc-qt-interface.ini'),
        httpPort: 48000,
        pollMs: 250,
        curlExe: 'curl.exe',
        healthMs: 0,
        extraArgs: ['--avcodec-hw=none', '--no-video-title-show'],
      },
      fallbackModel: 'claude-haiku-4-5',
    })
  })

  it('turns the Haiku fallback off with NOTESD_MOVIES_FALLBACK_MODEL=off', () => {
    expect(movies({ NOTESD_MOVIES_FALLBACK_MODEL: 'off' }).fallbackModel).toBeNull()
    expect(movies({ NOTESD_MOVIES_FALLBACK_MODEL: 'OFF' }).fallbackModel).toBeNull()
  })

  it('treats blank TMDB credentials as unset', () => {
    expect(movies({ TMDB_API_READ_ACCESS_TOKEN: '  ', TMDB_API_KEY: '' }).tmdb).toMatchObject({ token: null, apiKey: null })
  })

  it.each([
    ['NOTESD_MOVIES', 'maybe'],
    ['NOTESD_MOVIES_ROOTS', 'relative/films'],
    ['NOTESD_MOVIES_DONE_DIRS', 'Videos/Done'],
    ['NOTESD_MOVIES_SCAN_MS', '0'],
    ['NOTESD_MOVIES_MIN_SECONDS', '-1'],
    ['TMDB_API_BASE', 'ftp://tmdb.example'],
    ['TMDB_IMAGE_BASE', 'not a url'],
    ['NOTESD_VLC_INI', 'vlc-qt-interface.ini'],
    ['NOTESD_VLC_HTTP_PORT', '70000'],
    ['NOTESD_VLC_POLL_MS', '1.5'],
    ['NOTESD_VLC_HEALTH_MS', '1000'],
    ['NOTESD_VLC_HEALTH_MS', '-1'],
    ['NOTESD_VLC_HEALTH_MS', '30s'],
    ['NOTESD_VLC_EXTRA_ARGS', '--http-port 9999'],
    ['NOTESD_VLC_EXTRA_ARGS', '--avcodec-hw=none --http-password=x'],
    ['NOTESD_VLC_EXTRA_ARGS', '--extraintf=rc'],
    ['NOTESD_VLC_EXTRA_ARGS', '-I dummy'],
    ['NOTESD_MOVIES_FALLBACK_MODEL', 'ha iku'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => movies({ [key]: value })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_MOVIES_CONFIG off, with no roots, no credentials and no VLC ini, so hand-built test configs never scan', () => {
    expect(DEFAULT_MOVIES_CONFIG).toMatchObject({ enabled: false, roots: [], tmdb: { token: null, apiKey: null }, vlc: { ini: null } })
  })

  it('R8.4: NOTESD_VLC_EXTRA_ARGS is split on whitespace, and a 5 s health interval is the smallest accepted', () => {
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '--avcodec-hw=none' }).vlc.extraArgs).toEqual(['--avcodec-hw=none'])
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '   ' }).vlc.extraArgs).toEqual([])
    expect(movies({ NOTESD_VLC_EXTRA_ARGS: '--intf-foo --no-http-forward-cookies' }).vlc.extraArgs).toEqual(['--intf-foo', '--no-http-forward-cookies'])
    expect(movies({ NOTESD_VLC_HEALTH_MS: '5000' }).vlc.healthMs).toBe(5000)
    expect(DEFAULT_MOVIES_CONFIG.vlc).toMatchObject({ healthMs: 30_000, extraArgs: [] })
  })
})

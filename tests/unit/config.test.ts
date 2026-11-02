import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ConfigError,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
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
      sessions: { claudeHome: path.join(homedir(), '.claude'), worktreesDir: path.join(homedir(), '.worktrees'), enabled: true },
    })
    expect(cfg.chat).toEqual({ brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: 'claude', glm: null })
    expect(cfg.embeddings).toEqual({ apiKey: null })
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

describe('loadConfig sessions', () => {
  const sessions = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).sessions

  it('defaults to ~/.claude and ~/.worktrees, on', () => {
    expect(sessions({})).toEqual({
      claudeHome: path.join(homedir(), '.claude'),
      worktreesDir: path.join(homedir(), '.worktrees'),
      enabled: true,
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

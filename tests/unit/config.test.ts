import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError, DEFAULT_PORT, loadConfig, REPO_ROOT } from '../../src/config.js'

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
    })
  })

  it('reads the env file and lets the real environment win', () => {
    const file = envFile(
      ['LLM_API_KEY=ignored', 'DATABASE_URL=postgres://file/db', 'NOTESD_PORT=7400', 'OPENROUTER_API_KEY=x'].join('\n'),
    )
    expect(loadConfig({ env: {}, envFile: file })).toMatchObject({ databaseUrl: 'postgres://file/db', port: 7400 })
    expect(loadConfig({ env: { NOTESD_PORT: '7401' }, envFile: file }).port).toBe(7401)
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

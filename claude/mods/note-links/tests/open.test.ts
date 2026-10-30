import { describe, expect, test } from 'claude-code/testing'

import { EXPLORER_FALLBACK, idArgument, openCommand, openUrl, USAGE } from '../hooks/open'
import type { Run, RunInit } from '../hooks/open'

const WALL = 'http://localhost:7317'

type Call = { argv: readonly string[]; init: RunInit | undefined }

/** A fake `$.process.run`: each executable either exits with a code or cannot start. */
function fakeRun(behaviour: Record<string, number | 'missing'>): { run: Run; calls: Call[] } {
  const calls: Call[] = []
  const run: Run = async (argv, init) => {
    calls.push({ argv, init })
    const b = behaviour[argv[0] ?? '']
    if (b === undefined || b === 'missing') throw new Error(`spawn ${argv[0]} ENOENT`)
    return { exitCode: b, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('openUrl', () => {
  test('explorer.exe exiting 1 counts as opened', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openUrl(run, `${WALL}/?note=A-B32`)).toEqual({ isOpened: true, via: 'explorer.exe' })
    expect(calls.map(c => c.argv)).toEqual([['explorer.exe', `${WALL}/?note=A-B32`]])
  })

  test('falls back to the absolute explorer path, then powershell, then cmd', async () => {
    const { run, calls } = fakeRun({ [EXPLORER_FALLBACK]: 'missing', 'powershell.exe': 1, 'cmd.exe': 0 })
    const out = await openUrl(run, `${WALL}/?note=A-B32`)
    expect(out).toEqual({ isOpened: true, via: 'cmd.exe' })
    expect(calls.map(c => c.argv[0])).toEqual(['explorer.exe', EXPLORER_FALLBACK, 'powershell.exe', 'cmd.exe'])
    expect(calls[2]?.argv).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process '${WALL}/?note=A-B32'`,
    ])
    expect(calls[3]?.argv).toEqual(['cmd.exe', '/c', 'start', `${WALL}/?note=A-B32`])
    expect(calls[3]?.init?.cwd).toBe('/mnt/c')
  })

  test('nothing starts: every failure is reported', async () => {
    const { run } = fakeRun({})
    const out = await openUrl(run, `${WALL}/?note=A-B32`)
    expect(out.isOpened).toBe(false)
    if (!out.isOpened) expect(out.failures.length).toBe(4)
  })
})

describe('idArgument', () => {
  const rows: readonly (readonly [string, string])[] = [
    ['a-b32', 'a-b32'],
    ['  A-B32  extra words', 'A-B32'],
    ['#A-B32', 'A-B32'],
    ['`A-B32`', 'A-B32'],
    ['[A-B32]', 'A-B32'],
    ['', ''],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(idArgument(input)).toBe(expected)
    })
  }
})

describe('openCommand', () => {
  test('normalises the id and opens the canonical URL', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openCommand(' ab32 ', WALL, run)).toBe(`Opened A-B32 on the wall: ${WALL}/?note=A-B32`)
    expect(calls[0]?.argv).toEqual(['explorer.exe', `${WALL}/?note=A-B32`])
  })

  test('no argument: usage, nothing run', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    expect(await openCommand('   ', WALL, run)).toBe(USAGE)
    expect(calls).toEqual([])
  })

  test('not an id: says what an id looks like, nothing run', async () => {
    const { run, calls } = fakeRun({ 'explorer.exe': 1 })
    const text = await openCommand('hello', WALL, run)
    expect(text).toContain('"hello" is not a note id')
    expect(text).toContain('A-B32')
    expect(calls).toEqual([])
  })

  test('no browser: hands the URL back', async () => {
    const { run } = fakeRun({})
    const text = await openCommand('A-B32', WALL, run)
    expect(text).toContain('Could not open a browser from here')
    expect(text).toContain(`Open ${WALL}/?note=A-B32 yourself.`)
  })
})

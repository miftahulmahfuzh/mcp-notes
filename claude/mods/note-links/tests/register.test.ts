import { describe, expect, test } from 'claude-code/testing'
import type { On, RenderInput } from 'claude-code'

// Made-up ids only.
const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const MESSAGE = (text: string): RenderInput<'AssistantMessage'> => ({
  component: 'AssistantMessage',
  surface: 'terminal',
  requestId: 'msg-1',
  viewport: { columns: 120, rows: 40 },
  props: { text, isFirstOfReply: true },
})

const OPEN = (args: string) => ({
  command: 'open',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

type World = { commands: string[]; runs: (readonly string[])[]; drawn: string[] }

/** The engine beneath the plugin: commands, host commands and the transcript's own drawing. */
function worldOf(on: On, mcpGet: { exitCode: number; stdout: string } | 'missing'): World {
  const world: World = { commands: [], runs: [], drawn: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', ($, e) => {
    world.runs.push(e.argv)
    if (e.argv[0] === 'claude') {
      if (mcpGet === 'missing') return { deny: 'spawn claude ENOENT' }
      return { value: { ...mcpGet, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'explorer.exe') {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { deny: `spawn ${e.argv[0]} ENOENT` }
  })
  on('ui.render', ($, e) => {
    if (e.component === 'AssistantMessage') world.drawn.push(e.props.text)
    return { type: 'Text', children: [''] }
  })
  return world
}

const MCP_7400 = { exitCode: 0, stdout: 'notes:\n  Type: http\n  URL: http://localhost:7400/mcp\n' }

describe('session start', () => {
  test('registers /open', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['open'])
  })
})

describe('redraw', () => {
  test('links an id in a reply to the discovered wall', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    await $.command.run(OPEN('A-B32')) // waits for discovery when it has not landed yet
    await $.ui.render(MESSAGE('Saved as A-B32.'))
    expect(world.drawn.at(-1)).toBe('Saved as [A-B32](http://localhost:7400/?note=A-B32).')
  })

  test('without discovery the default wall is used', async ($, on) => {
    const world = worldOf(on, 'missing')
    await $.ui.render(MESSAGE('Saved as A-B32.'))
    expect(world.drawn.at(-1)).toBe('Saved as [A-B32](http://localhost:7317/?note=A-B32).')
  })

  test('a text with no id reaches the engine unchanged', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.ui.render(MESSAGE('run `X-123` in ./X-123.ts'))
    expect(world.drawn.at(-1)).toBe('run `X-123` in ./X-123.ts')
  })

  test('a wall set by hand wins and no discovery runs', { options: { wallUrl: 'http://127.0.0.1:9000/' } }, async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    await $.ui.render(MESSAGE('A-B32'))
    expect(world.drawn.at(-1)).toBe('[A-B32](http://127.0.0.1:9000/?note=A-B32)')
    expect(world.runs.filter(argv => argv[0] === 'claude')).toEqual([])
  })

  test('linkifyReplies off leaves replies alone', { options: { linkifyReplies: false } }, async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.ui.render(MESSAGE('A-B32'))
    expect(world.drawn.at(-1)).toBe('A-B32')
  })
})

describe('/open', () => {
  test('opens the normalised id with explorer.exe', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    await $.session.start(SESSION)
    const out = await $.command.run(OPEN('a-b32'))
    expect(out.text).toBe('Opened A-B32 on the wall: http://localhost:7400/?note=A-B32')
    expect(world.runs.at(-1)).toEqual(['explorer.exe', 'http://localhost:7400/?note=A-B32'])
  })

  test('rejects a word that is not an id', async ($, on) => {
    const world = worldOf(on, MCP_7400)
    const out = await $.command.run(OPEN('e-mail'))
    expect(out.text).toContain('"e-mail" is not a note id')
    expect(world.runs.filter(argv => argv[0] !== 'claude')).toEqual([])
  })
})

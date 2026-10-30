/**
 * note-links: note ids in Claude's replies become links to the mcp-notes wall, and `/open <id>`
 * opens a note on the wall in the Windows browser from WSL.
 *
 * The redraw changes only what the transcript draws; the stored message, and what the model
 * reads, stay as they were.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { DEFAULT_WALL, hasCandidate, linkify, normalizeWallUrl, wallFromMcpGet } from './linkify'
import { openCommand } from './open'

/** The wall found from `claude mcp get notes` this session; '' while unknown. */
const discovered = atom({ plugin: 'note-links', key: 'wall' } as const, '')

export const DISCOVERY_TIMEOUT_MS = 15_000

/** What the options settle to once, at load. */
type Settings = {
  /** The wall from `wallUrl`, normalised; the default when unset or unusable. */
  configured: string
  /** Whether `claude mcp get notes` may replace the default. */
  discover: boolean
  linkifyReplies: boolean
}

export function settingsOf(options: PluginOptions): Settings {
  const configured = normalizeWallUrl(String(options.wallUrl ?? DEFAULT_WALL)) ?? DEFAULT_WALL
  return {
    configured,
    // A wall set by hand wins; discovery only ever replaces the default.
    discover: options.discoverWallUrl !== false && configured === DEFAULT_WALL,
    linkifyReplies: options.linkifyReplies !== false,
  }
}

/** The wall links point at now. */
async function wallOf($: EngineInterface, settings: Settings): Promise<string> {
  if (!settings.discover) return settings.configured
  const found = await read($, discovered)
  return found === '' ? settings.configured : found
}

/** Reads the notes server's URL off `claude mcp get notes`; keeps the configured wall on any failure. */
async function runDiscovery($: EngineInterface): Promise<void> {
  try {
    const out = await $.process.run(['claude', 'mcp', 'get', 'notes'], { timeoutMs: DISCOVERY_TIMEOUT_MS })
    if (out.exitCode !== 0) return
    const wall = wallFromMcpGet(out.stdout)
    if (wall !== null) await update($, discovered, () => wall)
  } catch {
    // No `claude` on PATH, or it timed out: the configured wall stands.
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'open',
      description: 'Open a note on the mcp-notes wall in the browser',
      argumentHint: '<note id>',
    })
    if (settings.discover) void runDiscovery($)
    return next(e)
  })

  on('command.run', { command: 'open' }, async ($, e) => {
    if (settings.discover && (await read($, discovered)) === '') await runDiscovery($)
    const wall = await wallOf($, settings)
    return { text: await openCommand(e.args, wall, (argv, init) => $.process.run(argv, init)) }
  }).catch(() => ({ text: `note-links: /open failed. Ids look like A-B32; the wall is at ${settings.configured}.` }))

  if (settings.linkifyReplies) {
    on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
      const text = e.props.text
      if (!hasCandidate(text)) return next(e)
      const linked = linkify(text, await wallOf($, settings))
      return linked === text ? next(e) : next({ ...e, props: { ...e.props, text: linked } })
    })
  }
}

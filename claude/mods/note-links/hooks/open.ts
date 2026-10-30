/**
 * `/open <id>`: the answer text and the browser launch, with the host command injected.
 *
 * Pure apart from `run`, which the hooks module binds to `$.process.run` and the tests fake.
 * From WSL the Windows default browser is reached through Windows binaries (`wslview` and
 * `xdg-open` are not installed here). `explorer.exe <url>` opens it and exits 1 even on
 * success, so its exit code is never read (the same rule as `src/http/reveal.ts`); only a
 * failure to start moves on to the next opener.
 */
import { normalizeId, noteUrl } from './linkify'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunInit = { cwd?: string; timeoutMs?: number }
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

export type Opener = {
  /** What the failure message calls it. */
  name: string
  argv: (url: string) => string[]
  cwd?: string
  /** Whether this exit code means the browser was asked to open the URL. */
  isOpened: (exitCode: number) => boolean
}

/** Where explorer.exe lives when /mnt/c/WINDOWS is not on PATH. */
export const EXPLORER_FALLBACK = '/mnt/c/WINDOWS/explorer.exe'

export const OPEN_TIMEOUT_MS = 10_000

/** Tried in order; the first that starts (and, past explorer, exits 0) wins. */
export const OPENERS: readonly Opener[] = [
  { name: 'explorer.exe', argv: url => ['explorer.exe', url], isOpened: () => true },
  { name: EXPLORER_FALLBACK, argv: url => [EXPLORER_FALLBACK, url], isOpened: () => true },
  {
    name: 'powershell.exe',
    argv: url => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`],
    isOpened: code => code === 0,
  },
  // cmd.exe refuses a UNC working directory (\\wsl$\...), so it starts from C:\.
  { name: 'cmd.exe', argv: url => ['cmd.exe', '/c', 'start', url], cwd: '/mnt/c', isOpened: code => code === 0 },
]

export type OpenOutcome = { isOpened: true; via: string } | { isOpened: false; failures: string[] }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs the openers in order until one opens `url`. Never throws. */
export async function openUrl(run: Run, url: string, openers: readonly Opener[] = OPENERS): Promise<OpenOutcome> {
  const failures: string[] = []
  for (const opener of openers) {
    try {
      const init: RunInit = { timeoutMs: OPEN_TIMEOUT_MS }
      if (opener.cwd !== undefined) init.cwd = opener.cwd
      const result = await run(opener.argv(url), init)
      if (opener.isOpened(result.exitCode)) return { isOpened: true, via: opener.name }
      failures.push(`${opener.name} exited ${result.exitCode}`)
    } catch (err) {
      failures.push(`${opener.name}: ${messageOf(err)}`)
    }
  }
  return { isOpened: false, failures }
}

export const USAGE = 'Usage: /open <note id>, for example /open A-B32 (case and the dash do not matter).'

/** The id-ish word of the arguments: the first word, without a leading `#` or wrapping `` ` ``, `[ ]`. */
export function idArgument(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? ''
  return first.replace(/^[#`[]+/, '').replace(/[`\]]+$/, '')
}

/** The text `/open` answers with; opens the browser when the argument is a note id. */
export async function openCommand(args: string, wall: string, run: Run): Promise<string> {
  const word = idArgument(args)
  if (word === '') return USAGE
  const id = normalizeId(word)
  if (id === null) {
    return `"${word}" is not a note id. Ids look like A-B32: one letter or digit, a dash, three letters or digits (the dash is optional, case does not matter).`
  }
  const url = noteUrl(wall, id)
  const outcome = await openUrl(run, url)
  if (outcome.isOpened) return `Opened ${id} on the wall: ${url}`
  return `Could not open a browser from here (${outcome.failures.join('; ')}). Open ${url} yourself.`
}

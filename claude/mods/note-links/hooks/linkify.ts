/**
 * Note ids in markdown become links to the mcp-notes wall.
 *
 * Pure: no engine, no `$`, no imports. The hooks module and the tests import it.
 *
 * A note id is one character, a dash, three characters, all from [0-9A-Z] (`A-B32`), the same
 * rule as `src/notes/ids.ts`. In a reply only the upper-case, dashed form is linked, and only
 * where it stands alone: not inside a fenced code block, an inline code span, a markdown link,
 * an autolink, a bare URL, a path, a file name, a hash, a UUID or a longer dashed word.
 * `normalizeId` (used by `/open`) is looser: any case, dash optional.
 */

/** The wall the daemon serves when nothing else is known. */
export const DEFAULT_WALL = 'http://localhost:7317'

/** Canonical form only. */
export const ID_PATTERN = /^[0-9A-Z]-[0-9A-Z]{3}$/

const LOOSE_ID = /^([0-9A-Z])-?([0-9A-Z]{3})$/

/** A candidate anywhere in a text: the fast path skips texts without one. */
const ANY_CANDIDATE = /[0-9A-Z]-[0-9A-Z]{3}/

/** True when `text` holds something id-shaped, before any boundary rule. */
export function hasCandidate(text: string): boolean {
  return ANY_CANDIDATE.test(text)
}

/** A character right before a candidate that makes it part of something longer. */
const BAD_BEFORE = /[0-9A-Za-z_\-./\\@#$%&=+~:]/

/** A character right after a candidate that makes it part of something longer. */
const BAD_AFTER = /[0-9A-Za-z_\-/\\@#$%&=+~([]/

/** After a candidate, `.` or `:` followed by a letter or digit is a file name, host or port. */
const JOINER = /[.:]/
const ALNUM = /[0-9A-Za-z]/

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** `[text](url "title")`, `![alt](url)`, `[text][ref]`: the whole construct is left alone. */
const LINK_AT = /!?\[(?:[^[\]\\\n]|\\.)*\](?:\((?:<[^<>\n]*>|[^()\\\s]|\\.|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|\[[^[\]\n]*\])/y

/** `<scheme:...>` autolinks. */
const AUTOLINK_AT = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y

/** `scheme://...` and `www....` up to the next space or angle bracket. */
const URL_AT = /(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|www\.)[^\s<>]*/y

/** `[label]: url` reference definitions, at the start of a line. */
const REFDEF_AT = /[ \t]{0,3}\[[^[\]\n]+\]:[^\n]*/y

/** Case-insensitive, dash-tolerant: `ab32`, `a-b32`, ` A-B32 ` -> `A-B32`; null for anything else. */
export function normalizeId(input: string): string | null {
  const m = LOOSE_ID.exec(input.trim().toUpperCase())
  if (m === null) return null
  return `${m[1]}-${m[2]}`
}

/**
 * The wall's base URL from a setting or from the MCP URL: trimmed, `/mcp` and trailing slashes
 * dropped. Null unless it is http(s) with a host and no query, fragment, space, parenthesis
 * or quote (a parenthesis ends the markdown link early, a quote breaks the PowerShell fallback).
 */
export function normalizeWallUrl(raw: string): string | null {
  let s = raw.trim()
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/mcp$/i, '')
  s = s.replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/?#()<>'"`]+(?:\/[^\s?#()<>'"`]*)?$/i.test(s)) return null
  return s
}

/** `<wall>/?note=<ID>`. `wall` is already normalised; `id` is canonical. */
export function noteUrl(wall: string, id: string): string {
  return `${wall}/?note=${id}`
}

/** `[<ID>](<wall>/?note=<ID>)`, the link form every phase writes. */
export function noteLink(wall: string, id: string): string {
  return `[${id}](${noteUrl(wall, id)})`
}

/**
 * The `URL:` line of `claude mcp get notes`, as the wall's base URL; null when there is none
 * or it is not an http(s) URL.
 */
export function wallFromMcpGet(stdout: string): string | null {
  const m = /^\s*URL:\s*(\S+)\s*$/m.exec(stdout)
  if (m === null || m[1] === undefined) return null
  return normalizeWallUrl(m[1])
}

type Segment = { isCode: boolean; text: string }

/** The lines of a text, each with its own line break. */
function linesOf(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const k = text.indexOf('\n', from)
    if (k === -1) {
      if (from < text.length) out.push(text.slice(from))
      return out
    }
    out.push(text.slice(from, k + 1))
    from = k + 1
  }
}

/**
 * Splits a markdown text into fenced code blocks (``` or ~~~, closed by a fence of the same
 * character at least as long; an unclosed fence runs to the end) and everything else.
 */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { isCode: false, text: '' }
  let fence: { char: string; length: number } | null = null
  const flush = (isCode: boolean) => {
    if (current.text !== '') out.push(current)
    current = { isCode, text: '' }
  }
  for (const line of linesOf(text)) {
    const body = line.replace(/\r?\n$/, '')
    if (fence === null) {
      const open = FENCE_OPEN.exec(body)
      const marker = open?.[1]
      const info = open === null ? '' : body.slice(open[0].length)
      const isFence = marker !== undefined && !(marker.startsWith('`') && info.includes('`'))
      if (isFence) {
        flush(true)
        fence = { char: marker.charAt(0), length: marker.length }
      }
      current.text += line
      continue
    }
    current.text += line
    const close = FENCE_CLOSE.exec(body)
    const marker = close?.[1]
    if (marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length) {
      fence = null
      flush(false)
    }
  }
  flush(false)
  return out
}

function startsCandidate(text: string, i: number): boolean {
  if (!ID_PATTERN.test(text.slice(i, i + 5))) return false
  const before = i > 0 ? text[i - 1]! : ''
  if (before !== '' && BAD_BEFORE.test(before)) return false
  const after = text[i + 5]
  if (after === undefined) return true
  if (BAD_AFTER.test(after)) return false
  if (JOINER.test(after)) {
    const next = text[i + 6]
    if (next !== undefined && ALNUM.test(next)) return false
  }
  return true
}

function matchAt(re: RegExp, text: string, i: number): string | null {
  re.lastIndex = i
  const m = re.exec(text)
  return m === null ? null : m[0]
}

/** Length of the run of `ch` starting at i. */
function runAt(text: string, i: number, ch: string): number {
  let j = i
  while (text[j] === ch) j++
  return j - i
}

/** End index (exclusive) of the inline code span opened by the backtick run at i, or -1. */
function codeSpanEnd(text: string, i: number): number {
  const n = runAt(text, i, '`')
  let j = i + n
  while (j < text.length) {
    const k = text.indexOf('`', j)
    if (k === -1) return -1
    const m = runAt(text, k, '`')
    if (m === n) return k + m
    j = k + m
  }
  return -1
}

/** Linkify one stretch of markdown that holds no fenced code block. */
function linkifyProse(text: string, wall: string): string {
  let out = ''
  let plainFrom = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      i = Math.min(text.length, i + 2)
      continue
    }
    if (ch === '`') {
      const end = codeSpanEnd(text, i)
      i = end === -1 ? i + runAt(text, i, '`') : end
      continue
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      if (i === 0 || text[i - 1] === '\n') {
        const def = matchAt(REFDEF_AT, text, i)
        if (def !== null) {
          i += def.length
          continue
        }
      }
      const link = matchAt(LINK_AT, text, i)
      if (link !== null) {
        i += link.length
        continue
      }
    }
    if (ch === '<') {
      const auto = matchAt(AUTOLINK_AT, text, i)
      if (auto !== null) {
        i += auto.length
        continue
      }
    }
    if (ALNUM.test(ch) && (i === 0 || !ALNUM.test(text[i - 1]!))) {
      const url = matchAt(URL_AT, text, i)
      if (url !== null) {
        i += url.length
        continue
      }
    }
    if (startsCandidate(text, i)) {
      const id = text.slice(i, i + 5)
      out += text.slice(plainFrom, i) + noteLink(wall, id)
      i += 5
      plainFrom = i
      continue
    }
    i++
  }
  return out + text.slice(plainFrom)
}

/**
 * Every free-standing upper-case note id in `markdown` becomes `[ID](<wall>/?note=ID)`.
 * Idempotent: an id already inside a link is left alone, so linkify(linkify(x)) === linkify(x).
 */
export function linkify(markdown: string, wall: string): string {
  if (!hasCandidate(markdown)) return markdown
  return splitFences(markdown)
    .map(seg => (seg.isCode ? seg.text : linkifyProse(seg.text, wall)))
    .join('')
}

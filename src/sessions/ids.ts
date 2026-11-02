import { randomInt } from 'node:crypto'

import { ID_ALPHABET } from '../notes/ids.js'

/**
 * Node ids name one Claude Code session in the project graph: two characters, a dash, two
 * characters, all from [0-9A-Z] (`A0-3G`). Same alphabet as note ids (`A-B32`) but a different
 * shape, so neither linkifier mistakes one for the other. Generated only here; uniqueness is
 * the caller's job (src/sessions/repo.ts inserts and retries on a unique-index clash).
 */
export const NODE_ID_ALPHABET = ID_ALPHABET

/** Canonical form only. Use `normalizeNodeId` for user input. */
export const NODE_ID_PATTERN = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/

/** 36^4 = 1,679,616 distinct ids. */
export const NODE_ID_SPACE = NODE_ID_ALPHABET.length ** 4

const LOOSE_NODE_ID = /^([0-9A-Z]{2})-?([0-9A-Z]{2})$/

/**
 * Regex source (flags `g`) for spotting node ids in free text: upper case as typed, dash required,
 * a whole token (no letter, digit, _, -, /, \, . or : before it; no letter, digit, _, -, / or \
 * after it, and no "." or ":" followed by a letter or digit). Dates 2026-11-02, times
 * 10:30-11:00, versions 1.12-RC1, paths a/A0-3G, files A0-3G.md, keys UATP-2960, UUIDs and note
 * ids (A-B32) never match; "A0-3G." ending a sentence does. claude/hooks/notes-prompt.mjs
 * (Phase 8) holds this exact source as its NODE_ID_CANDIDATE literal; a test there asserts
 * `NODE_ID_CANDIDATE.source === NODE_ID_CANDIDATE_SOURCE`.
 */
export const NODE_ID_CANDIDATE_SOURCE = String.raw`(?<![0-9A-Za-z_.\/:\\-])([0-9A-Z]{2}-[0-9A-Z]{2})(?![0-9A-Za-z_\/\\-]|[.:][0-9A-Za-z])`

/** At most this many candidates are returned per text (same as the hook's MAX_NODE_IDS). */
export const MAX_NODE_ID_CANDIDATES = 5

const HAS_LETTER = /[A-Z]/

/**
 * A fresh random node id in canonical form, never all digits (an all-digit pair reads as a page
 * range or score, so the candidate rule skips it; redrawing keeps every id quotable in a prompt).
 * `random(n)` must return an integer in [0, n); it defaults to `crypto.randomInt` and is
 * injectable for tests.
 */
export function generateNodeId(random: (max: number) => number = randomInt): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    let raw = ''
    for (let i = 0; i < 4; i++) {
      const ch = NODE_ID_ALPHABET[random(NODE_ID_ALPHABET.length)]
      if (ch === undefined) throw new RangeError('generateNodeId: random() returned an out-of-range index')
      raw += ch
    }
    if (HAS_LETTER.test(raw)) return `${raw.slice(0, 2)}-${raw.slice(2)}`
  }
  throw new RangeError('generateNodeId: random() kept producing all-digit ids')
}

/** True only for the canonical form (`A0-3G`). */
export function isValidNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value)
}

/**
 * Case-insensitive, dash-tolerant lookup form: `a03g`, `a0-3g`, ` A0-3G ` -> `A0-3G`.
 * Returns null for anything that cannot be a node id.
 */
export function normalizeNodeId(input: string): string | null {
  const m = LOOSE_NODE_ID.exec(input.trim().toUpperCase())
  if (!m) return null
  return `${m[1]}-${m[2]}`
}

export class InvalidNodeIdError extends Error {
  override name = 'InvalidNodeIdError'
  constructor(readonly input: string) {
    super(`"${input}" is not a node id. Node ids look like A0-3G (the dash is optional, case does not matter).`)
  }
}

/** `normalizeNodeId` that throws `InvalidNodeIdError` instead of returning null. */
export function parseNodeId(input: string): string {
  const id = normalizeNodeId(input)
  if (id === null) throw new InvalidNodeIdError(input)
  return id
}

/**
 * Node ids that `text` may mention (the NODE_ID_CANDIDATE_SOURCE rule plus "at least one
 * letter"), in order of first appearance, deduped, at most MAX_NODE_ID_CANDIDATES. Same result
 * as the prompt hook's `nodeIdCandidates`. Candidates are not checked against the database;
 * resolve them with SessionsRepo.getManyByNodeIds.
 */
export function findNodeIdCandidates(text: string): string[] {
  const out: string[] = []
  if (text.length < 5 || !text.includes('-')) return out
  const re = new RegExp(NODE_ID_CANDIDATE_SOURCE, 'g')
  for (const m of text.matchAll(re)) {
    const id = m[1]
    if (id === undefined || !HAS_LETTER.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_NODE_ID_CANDIDATES) break
  }
  return out
}

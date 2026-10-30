/**
 * Tags are `#hashtags` inside the note body, re-parsed on every write.
 * A tag is `#` + one or more of [A-Za-z0-9_-], where the `#` is not preceded by a
 * word character (so `C#` and `a#b` are not tags). Stored lower-cased, deduped,
 * in order of first appearance.
 *
 * This module is pure (no Node imports) so the web app can share it.
 */

const TAG_REGEX_SOURCE = '(?<![A-Za-z0-9_])#([A-Za-z0-9_-]+)'

export interface TagSpan {
  /** Index of the `#`. */
  start: number
  /** Index one past the last tag character. */
  end: number
  /** The tag lower-cased, without `#`. */
  tag: string
}

/** Every tag occurrence in `body`, in order, including repeats. */
export function tagSpans(body: string): TagSpan[] {
  const re = new RegExp(TAG_REGEX_SOURCE, 'g')
  const spans: TagSpan[] = []
  for (const m of body.matchAll(re)) {
    const name = m[1]
    if (name === undefined || m.index === undefined) continue
    spans.push({ start: m.index, end: m.index + m[0].length, tag: name.toLowerCase() })
  }
  return spans
}

/** The `tags` column value for `body`: lower-cased, deduped, first-appearance order. */
export function parseTags(body: string): string[] {
  const seen = new Set<string>()
  for (const span of tagSpans(body)) seen.add(span.tag)
  return [...seen]
}

/**
 * Normalises a tag given as a filter argument (`#Seer`, `seer`, ` SEER `) to the stored
 * form (`seer`). Returns null when nothing tag-like is left.
 */
export function normalizeTag(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, '').toLowerCase()
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null
}

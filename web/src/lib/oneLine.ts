/**
 * The chat query on one line, for the answer panel header (R7): every run of line breaks,
 * together with the spaces and tabs around it, becomes a single space; the ends are trimmed.
 * Spaces inside a line are left as typed.
 */
export function oneLine(s: string): string {
  return s.replace(/[ \t]*(?:\r\n|\r|\n)+[ \t]*/g, ' ').trim();
}

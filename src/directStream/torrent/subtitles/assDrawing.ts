/**
 * ASS vector drawings. A typeset release draws the shapes behind a translated sign (a board, a
 * screen) as events in drawing mode: `{\p1}m 385.98 0 l 4.55 64.75 ...{\p0}`, one per frame while
 * the sign moves. ffmpeg's ASS to WebVTT conversion takes the `{\p1}` tag out and keeps the
 * coordinates as the cue's text, so the player would show rows of numbers. Such a cue is never
 * text: it is dropped wherever cues are made or read.
 */

/** One token of a drawing: a command (m n l b s p c) or a coordinate. */
const TOKEN = /^(?:[mnlbspc]|-?\d+(?:\.\d+)?)$/i;
/** Coordinates the shortest drawing has: a move and a line (`m 0 0 l 10 10`). */
const MIN_COORDINATES = 4;

/**
 * True when a cue's text is an ASS drawing and nothing else: only drawing commands and coordinates, at least one
 * command and four coordinates (a drawing may reach us without its first `m`). Tags around it do not count: `<b>`,
 * and a brace block the conversion left in (`{=6}`, a typesetting tool's own mark, which has no backslash).
 */
export function isAssDrawing(text: string): boolean {
  const tokens = text.replace(/<[^>]*>|\{[^}]*\}/g, '').trim().split(/\s+/);
  if (!tokens.every((token) => TOKEN.test(token))) return false;
  const commands = tokens.filter((token) => /^[a-z]$/i.test(token)).length;
  return commands >= 1 && tokens.length - commands >= MIN_COORDINATES;
}

/** A WebVTT text without its drawing cues; the header and every other block stay as they are. */
export function stripAssDrawings(vtt: string): string {
  return vtt
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => {
      const lines = block.split('\n');
      const at = lines.findIndex((line) => line.includes('-->'));
      return at === -1 || !isAssDrawing(lines.slice(at + 1).join('\n'));
    })
    .join('\n\n');
}

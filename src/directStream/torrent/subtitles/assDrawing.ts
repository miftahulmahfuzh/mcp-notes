/**
 * ASS vector drawings. A typeset release draws the shapes behind a translated sign (a board, a
 * screen) as events in drawing mode: `{\p1}m 385.98 0 l 4.55 64.75 ...{\p0}`, one per frame while
 * the sign moves. ffmpeg's ASS to WebVTT conversion takes the `{\p1}` tag out and keeps the
 * coordinates as the cue's text, so the player would show rows of numbers. Such a cue is never
 * text: it is dropped wherever cues are made or read. The same conversion leaves ASS comments in the
 * text (stripAssComments).
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

/**
 * A cue's text without its ASS brace blocks. In ASS nothing between braces is ever shown: a block is override tags
 * or a comment. ffmpeg's conversion takes out the blocks that start with a backslash and leaves the rest as text: a
 * translator's note (`{not very readable}`), a typesetting tool's mark (`{=6}`), and the honorifics switch of a
 * release (`{*}Mr. Ijichi{*Ijichi-san}, question.`, which shows "Mr. Ijichi, question.").
 */
export function stripAssComments(text: string): string {
  return text
    .replace(/\{[^{}]*\}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** True when nothing of a cue's text is left to show once its tags (`<b>`) are taken out. */
const isBlank = (text: string): boolean => text.replace(/<[^>]*>/g, '').trim() === '';

/**
 * A WebVTT text converted from ASS, as it is kept: no drawing cue, no brace block in a cue's text, and no cue that
 * was only a brace block. The header and every other block stay as they are.
 */
export function cleanAssVtt(vtt: string): string {
  const blocks: string[] = [];
  for (const block of vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at === -1) {
      blocks.push(block);
      continue;
    }
    const text = stripAssComments(lines.slice(at + 1).join('\n'));
    if (isBlank(text) || isAssDrawing(text)) continue;
    blocks.push([...lines.slice(0, at + 1), text].join('\n'));
  }
  return blocks.join('\n\n');
}

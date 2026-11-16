/**
 * A film's or an episode's dialogue: the text of its English subtitle, read from the stream
 * source the resolver found. It is what the people on screen say, line by line with the minute
 * it is said, so a question about the story can be answered from the title itself and not from
 * a two-line synopsis. Pure: the service fetches the file (service.ts subtitleText) and
 * MoviesRepo stores the result.
 */

/** One subtitle cue. */
export interface DialogueCue {
  startS: number;
  text: string;
}

/** Characters of dialogue one tool answer carries; a film's is paged by minute past this. */
export const DIALOGUE_PAGE_CHARS = 40_000;
/** A file with fewer cues than this is no subtitle: a page hands its player an empty placeholder track first. */
export const DIALOGUE_MIN_CUES = 1;

const TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+/;
const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lrm;': '', '&rlm;': '' };

function clean(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(?:amp|lt|gt|nbsp|quot|#39|lrm|rlm);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The cues of a WebVTT (or SubRip) text, in time order, each cue's lines joined. A cue that
 * repeats the one before it (a line held over two cues, a karaoke line written twice) is dropped.
 */
export function parseCues(text: string): DialogueCue[] {
  const cues: DialogueCue[] = [];
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const timing = TIMING.exec(lines[i]!.trim());
    if (timing === null) continue;
    const startS = Number(timing[1] ?? 0) * 3600 + Number(timing[2]) * 60 + Number(timing[3]) + Number(`0.${timing[4]}`);
    const parts: string[] = [];
    for (i += 1; i < lines.length && lines[i]!.trim() !== ''; i++) {
      if (TIMING.test(lines[i]!.trim())) {
        i -= 1;
        break;
      }
      const part = clean(lines[i]!);
      if (part !== '') parts.push(part);
    }
    const said = parts.join(' ');
    if (said !== '') cues.push({ startS, text: said });
  }
  cues.sort((a, b) => a.startS - b.startS);
  return cues.filter((cue, index) => index === 0 || cue.text !== cues[index - 1]!.text);
}

/** 754 -> "12:34", 4000 -> "66:40": minutes run on past the hour, so a line's minute reads at a glance. */
function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The stored form: one line per cue, `mm:ss<TAB>text`. */
export function dialogueBody(cues: readonly DialogueCue[]): string {
  return cues.map((cue) => `${stamp(cue.startS)}\t${cue.text}`).join('\n');
}

export interface DialoguePage {
  from_minute: number;
  /** The minute after the last line given; null when the page reaches the end. */
  next_from_minute: number | null;
  lines: number;
  text: string;
}

/**
 * The lines of a stored body from `fromMinute` on, as `[mm:ss] text`, up to `maxChars`. A page
 * always ends on a whole minute, so the next one starts where it stopped.
 */
export function dialoguePage(body: string, fromMinute: number, maxChars: number = DIALOGUE_PAGE_CHARS): DialoguePage {
  const out: string[] = [];
  let size = 0;
  let next: number | null = null;
  let lastMinute = fromMinute;
  for (const line of body.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const minute = Number(line.slice(0, line.indexOf(':')));
    if (!Number.isFinite(minute) || minute < fromMinute) continue;
    const text = `[${line.slice(0, tab)}] ${line.slice(tab + 1)}`;
    if (size + text.length + 1 > maxChars && out.length > 0 && minute > lastMinute) {
      next = minute;
      break;
    }
    out.push(text);
    size += text.length + 1;
    lastMinute = minute;
  }
  return { from_minute: fromMinute, next_from_minute: next, lines: out.length, text: out.join('\n') };
}

/** The address a line of a rewritten subtitle playlist points back at (`...?u=<address>`), or null for a tag or a blank. */
export function playlistTarget(line: string): string | null {
  const text = line.trim();
  if (text === '' || text.startsWith('#')) return null;
  const at = text.indexOf('u=');
  if (at === -1) return /^https?:\/\//.test(text) ? text : null;
  try {
    return decodeURIComponent(text.slice(at + 2).split('&')[0] ?? '');
  } catch {
    return null;
  }
}

export interface SubtitleOption {
  /** `manifest-<index>` or `file-<index>`: a stable key for menus and state. */
  id: string;
  /** A track inside the manifest (the engine shows it) or a separate file from the resolve (a <track>). */
  source: 'manifest' | 'file';
  index: number;
  label: string;
  lang: string | null;
  english: boolean;
}

const ENGLISH_LANG = /^(en|eng)(?:[-_].*)?$/i;

export function isEnglish(lang: string | null, label: string | null): boolean {
  if (lang !== null && ENGLISH_LANG.test(lang.trim())) return true;
  return label !== null && /\benglish\b/i.test(label);
}

/** A label that says nothing about the language ("", "Subtitle", "Track 1"; parseSession names an unlabelled file "Subtitle"). */
const NO_NAME = /^(subtitles?|captions?|cc|default|unknown|und|track ?\d*)?$/i;

/** True for a track that names no language at all: no language tag and a label that is empty or generic. */
export function isUnnamed(option: Pick<SubtitleOption, 'lang' | 'label'>): boolean {
  return (option.lang === null || option.lang.trim() === '' || /^und$/i.test(option.lang.trim())) && NO_NAME.test(option.label.trim());
}

/**
 * English on by default: the first English track inside the manifest, else the first English file.
 * Without one, a source's only subtitle is shown when it names no language: a provider that hands
 * out one unnamed file means it for the viewer (Fake Profile S02E01 on VidLink). A track that
 * names another language, or several tracks none of which is English, stay off.
 */
export function pickDefaultSubtitle(options: readonly SubtitleOption[]): string | null {
  const english = options.filter((o) => o.english);
  const chosen = english.find((o) => o.source === 'manifest') ?? english[0];
  if (chosen) return chosen.id;
  const [only] = options;
  return options.length === 1 && only !== undefined && isUnnamed(only) ? only.id : null;
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

/** WebVTT from an SRT or WebVTT file. WebVTT comes back as it came (BOM and CR removed). */
export function toWebVtt(input: string): string {
  const clean = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(clean)) return clean;
  const body = clean
    .split('\n')
    .map((line) =>
      line.includes('-->')
        ? line.replace(SRT_TIME, (_all: string, h: string, m: string, s: string, ms: string) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
        : line,
    )
    .join('\n');
  return `WEBVTT\n\n${body.trim()}\n`;
}

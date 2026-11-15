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

/** English on by default: the first English track inside the manifest, else the first English file, else none. */
export function pickDefaultSubtitle(options: readonly SubtitleOption[]): string | null {
  const english = options.filter((o) => o.english);
  const chosen = english.find((o) => o.source === 'manifest') ?? english[0];
  return chosen ? chosen.id : null;
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

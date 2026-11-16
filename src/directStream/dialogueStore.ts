import type { MoviesRepo } from '../movies/repo.js';
import { dialogueBody, parseCues } from './dialogue.js';
import { targetKey, type StreamTarget } from './lookup.js';
import type { DirectStreamService } from './service.js';

/** A title's dialogue as its readers get it (the MCP tool, the story writer). */
export interface StoredDialogue {
  provider: string;
  cues: number;
  /** The second the last line is said at. */
  lastCueS: number;
  /** One line per cue, `mm:ss<TAB>text` (dialogueBody). */
  body: string;
  fetchedAt: Date;
  /** True when it came from the store and nothing was resolved. */
  cached: boolean;
  /** The story written from it (src/movies/story.ts), when there is one. */
  story: { text: string; model: string | null; writtenAt: Date | null } | null;
}

/** The film's slot (season 0, episode 0) or the episode's, as movie_dialogues keys it. */
export function dialogueSlot(target: StreamTarget): { titleId: string; season: number; episode: number } {
  return { titleId: targetKey(target), season: target.kind === 'tv' ? target.season : 0, episode: target.kind === 'tv' ? target.episode : 0 };
}

/**
 * The dialogue of a film or an episode: the stored one, else read from the English subtitle of a
 * stream source resolved out of sight (DirectStreamService.subtitleText; no player opens) and then
 * stored. `refresh` reads it again. Without a service only the store can answer: null then means
 * there is none. Throws what subtitleText throws (`no_source`, `no_subtitle`, `resolve_failed`).
 */
export async function loadDialogue(
  repo: Pick<MoviesRepo, 'dialogue' | 'saveDialogue' | 'titleById'>,
  service: Pick<DirectStreamService, 'subtitleText'> | null,
  target: StreamTarget,
  options: { refresh?: boolean; now?: () => Date } = {},
): Promise<StoredDialogue | null> {
  const slot = dialogueSlot(target);
  const stored = options.refresh === true && service !== null ? null : await repo.dialogue(slot.titleId, slot.season, slot.episode);
  if (stored !== null) {
    return {
      provider: stored.provider,
      cues: stored.cues,
      lastCueS: stored.lastCueS,
      body: stored.body,
      fetchedAt: stored.fetchedAt,
      cached: true,
      story: stored.story === null ? null : { text: stored.story, model: stored.storyModel, writtenAt: stored.storyAt },
    };
  }
  if (service === null) return null;
  const read = await service.subtitleText(target, { outside: true });
  const cues = parseCues(read.vtt);
  const row = {
    ...slot,
    lang: 'en',
    provider: read.provider,
    cues: cues.length,
    lastCueS: Math.round(cues[cues.length - 1]?.startS ?? 0),
    body: dialogueBody(cues),
    fetchedAt: (options.now ?? (() => new Date()))(),
  };
  // The resolve stored the title; without a TMDB credential it could not, and the dialogue is answered unstored.
  if ((await repo.titleById(slot.titleId)) !== null) await repo.saveDialogue(row);
  return { provider: row.provider, cues: row.cues, lastCueS: row.lastCueS, body: row.body, fetchedAt: row.fetchedAt, cached: false, story: null };
}

import type { NotesService } from '../notes/service.js';
import type { MoviesService } from './service.js';

/** The tag every review note carries (R3.6: "a normal note linked to the title"). */
export const REVIEW_TAG = 'movie';
/** Longest review text the API accepts. */
export const MAX_REVIEW_CHARS = 20_000;

const HEADER_PREFIX = 'Review of ';

/** First line of a review note: names the title so full-text search and /n find it. */
export function reviewHeader(title: string, year: number | null): string {
  return `${HEADER_PREFIX}${title}${year !== null ? ` (${year})` : ''}`;
}

/** The whole note body for `text`. An empty text keeps the header and the tag, so the note stays non-empty. */
export function reviewBody(header: string, text: string): string {
  const t = text.trim();
  return t === '' ? `${header}\n\n#${REVIEW_TAG}` : `${header}\n\n${t}\n\n#${REVIEW_TAG}`;
}

function isReviewTagLine(line: string): boolean {
  const words = line.trim().split(/\s+/).filter((w) => w !== '');
  return (
    words.length > 0 &&
    words.every((w) => /^#[A-Za-z0-9_-]+$/.test(w)) &&
    words.some((w) => w.toLowerCase() === `#${REVIEW_TAG}`)
  );
}

/**
 * The review text shown in the detail page's one field: the body without our header line and without the trailing
 * tags-only line that holds #movie. A note edited elsewhere (/n, the wall) shows whatever text it now has.
 */
export function reviewText(body: string): string {
  const lines = body.split('\n');
  if (lines[0] !== undefined && lines[0].startsWith(HEADER_PREFIX)) lines.shift();
  for (;;) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (last.trim() === '' || isReviewTagLine(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

export interface SavedReview {
  review: string;
  review_note_id: string | null;
}

/**
 * Creates or updates the title's review note through NotesService (invariant 6) and stores its id with
 * MoviesRepo.setTitleUser. Returns null when the title does not exist.
 * - linked note live: update it (no write when the body is unchanged); an empty text clears the text, keeps the note.
 * - no live linked note and empty text: nothing is written.
 * - no live linked note and some text: create a note (origin source 'movies') and link it.
 */
export async function saveReview(
  service: Pick<MoviesService, 'repo'>,
  notes: NotesService,
  titleId: string,
  text: string,
): Promise<SavedReview | null> {
  const title = await service.repo.titleById(titleId);
  if (title === null) return null;
  const body = reviewBody(reviewHeader(title.title, title.year), text);
  const current = title.reviewNoteId !== null ? await notes.getOne(title.reviewNoteId) : null;
  if (current !== null) {
    const note = current.body === body ? current : await notes.update(current.id, body);
    return { review: reviewText(note.body), review_note_id: note.id };
  }
  if (text.trim() === '') return { review: '', review_note_id: null };
  const note = await notes.create({ body, origin: { source: 'movies' } });
  await service.repo.setTitleUser(titleId, { reviewNoteId: note.id });
  return { review: reviewText(note.body), review_note_id: note.id };
}

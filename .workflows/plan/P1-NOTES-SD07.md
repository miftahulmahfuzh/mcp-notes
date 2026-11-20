> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 7. Source: `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: The story on the page: the season row's button, sections and sources in the modal

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R6 — "Narrate the full story of SXX" on the season row, written from the web, not from a subtitle
**Criteria:** R6.1, R6.3
**Depends on:** Phase 6 (and through it phase 1)
**Difficulty:** NORMAL
**Package:** `web/src/components/movies`

---

## Goal

Each numbered season head on a series' page carries a book icon ("Narrate the full story of S02"), filled when the
season's story is stored. Clicking it opens the story pop-up for the whole season: one section per episode under a
`S02E03 · name` heading, an episode no source covers saying "No published recap was found for this episode.", and,
under any story written from the web, a "Sources" list of links that open in a new tab. The client reads the new
story shape once, at the API boundary, and the wait text no longer says the story comes from a subtitle.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/moviesApi.ts`: `type StoryOrigin = 'web' | 'dialogue'`, `interface StorySource {url, title, site}`, `interface StorySection {episode, name, text, found}`, `function normalizeStory(s: StoryWire): StoryView` (exported for the test), `SeasonView.has_story?: boolean`.
- `web/src/lib/movies.ts`: `seasonCode(season: number): string` (`S02`), beside `episodeCode`.
- `web/src/components/movies/StoryModal.tsx`: `storyWaitText(episode, stored)`, `STORY_NOT_FOUND_TEXT`.
- `web/src/components/movies/EpisodeList.tsx`: internal `SeasonStoryButton`; prop `onSeasonStory?: (s: SeasonView) => void` on `EpisodeListProps`.
- `web/src/components/movies/MovieDetail.tsx`: internal `interface StoryTarget {season, episode: number | null, name, stored}`.
- `web/src/components/movies/MovieModal.css`: `.mm-story-sec`, `.mm-story-h`, `.mm-story-none`, `.mm-story-sources`.

**Signature changes:**
- `writeStory(titleId: string, season: number, episode: number)` -> `writeStory(titleId: string, season: number, episode: number | null)`; `null` posts `{season}` (the season's story), a number posts `{season, episode}` as today.
- `StoryView` (web) gains `origin`, `sources`, `sections`; `provider: string` -> `string | null`; `cues: number` -> `number | null`.
- `StoryModalProps.episode: number` -> `number | null` (null: the whole season).
- `MovieDetail`'s `story` state: `EpisodeView | null` -> `StoryTarget | null`.

**Requires (from earlier phases) — what this plan assumes of phase 6; the reconciler must align these:**
1. `POST /api/movies/:id/story` with body `{season: N}` (no `episode`, N > 0) answers the season's story: stored -> `{story, cached: true}` with no model call; else writes it -> `{story, cached: false}`. With `{season, episode}` it answers an episode's story as today (web-first). Errors are `{error: <code>, message}` as today; a new code `no_story_source` (404, phase 6; the client only reads the code). With `NOTESD_MOVIES_STORY_MODEL=off` a stored story is still answered (`cached: true`); only writing a new one answers 503 `story_off` (phase 6, reconciled).
2. The answer's `story` object, in JSON:
   ```json
   {
     "season": 2, "episode": 0,
     "text": "all sections joined, or an episode's story",
     "model": "sonnet", "written_at": "2026-11-20T10:00:00.000Z",
     "origin": "web",
     "sources": [{"url": "https://…", "title": "…", "site": "Wikipedia"}],
     "sections": [{"episode": 1, "name": "Pilot", "text": "…", "found": true},
                  {"episode": 2, "name": "…", "text": "", "found": false}],
     "provider": null, "cues": null
   }
   ```
   `episode` is 0 for a season's story. `sections` is `[]` for an episode's or a film's story. `provider`/`cues` are the subtitle provider and line count for `origin: "dialogue"`, null (or absent) for `origin: "web"`. When `sections` is non-empty the modal shows the sections and **not** `text` (so every episode's content must be in its section). The client tolerates any of `origin`, `sources`, `sections`, `provider`, `cues` being absent (an older daemon): absent `origin` reads as `dialogue`, absent lists as `[]`.
3. Per-season `has_story` sits on each element of the title detail's `seasons` array: `GET /api/movies/:id` -> `seasons: [{season, trailer_key, has_story: boolean, episodes: [...]}]`, true when a season story (`movie_stories` row with that season and episode 0) is stored. Absent reads as false.
4. A new season story emits the movies `changed` event as a new episode story does today (`moviesApi.ts` POST story route), so the open page re-reads the detail and the season's icon fills.
5. Phase 1's `movie_stories` columns (used only by the Proof seed): `title_id, season, episode, text, sections jsonb, sources jsonb, origin, model, written_at`.

**Leaves alone (owned by others):**
- Every server file: `src/movies/story.ts`, `src/http/moviesApi.ts`, `scripts/docs/httpRoutes.ts` (phase 6).
- The download functions and types in `web/src/moviesApi.ts` (phase 4) — this phase edits only the story block (today lines 623–645) and `SeasonView` (lines 147–152).
- Download buttons in `EpisodeList.tsx` / `MovieDetail.tsx` (phase 8, which edits both files after this phase).
- `docs/guide/*`, pictures, `.claude/skills/verify-notesd/features/*` (phase 9).

**Names phase 9's drive uses, pinned by this phase's tests (reconciled):** the season head's book button is named exactly `Narrate the full story of S01` (`data-stored="true"` when stored); the pop-up is `role="dialog"` named `Story of <title> S01` (an episode's: `Story of <title> S01E01 · <name>`); a season's sections are `<section>` regions named and headed (`<h3>`, role `heading`) `S01E01 · <episode name>`; an untold one says exactly `No published recap was found for this episode.` (`STORY_NOT_FOUND_TEXT`); the sources are links in a region named `Sources`, `target="_blank"`, `rel="noreferrer"`; a story from dialogue's foot reads `written by <model> from <n> subtitle lines (<provider>)`, a web story's `written by <model> from <n> web sources`. `StoryModal.test.tsx` and `EpisodeList.test.tsx` assert each of these strings; keep them.

**What phase 8 will find in the season head** (`EpisodeList.tsx`, `<div className="mv-season-head">`), in this order:
`SeasonFoldButton` · `<h3 className="mv-season-h">` · `TrailerButton` (season > 0) · `SeasonStoryButton` (season > 0 and `onSeasonStory` given; class `pbtn hov mv-season-story`, aria-label `Narrate the full story of S02`) · `SeasonWatchedButton` · the folded summary span. Phase 8 can add its season `DownloadButton` after `SeasonWatchedButton` and before the summary span without touching the story button. `EpisodeListProps` gains `onSeasonStory` after `onStory`.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/moviesApi.ts` | modify | lines 147–152 `SeasonView.has_story`; lines 623–645 story types, `normalizeStory`, `writeStory`'s season form |
| `web/src/lib/movies.ts` | modify | after line 134: `seasonCode` |
| `web/src/components/movies/StoryModal.tsx` | modify (whole file) | season form, sections, not-found line, Sources links, web wait text, `no_story_source`, footer by origin |
| `web/src/components/movies/MovieModal.css` | modify | after line 25: section, heading, not-found and sources styles |
| `web/src/components/movies/EpisodeList.tsx` | modify | lines 2–4 imports; lines 31–33 prop; new `SeasonStoryButton` after line 51; lines 91–164 `EpisodeList` (head button); line 212 episode tip wording |
| `web/src/components/movies/MovieDetail.tsx` | modify | lines 3, 33 imports; line 81 state; lines 395–396 handlers; lines 412–421 modal |
| `web/src/components/movies/StoryModal.test.tsx` | modify (whole file) | new story shape, season sections, not-found line, source links, `writeStory` body and normalization |
| `web/src/components/movies/EpisodeList.test.tsx` | modify | new `describe('EpisodeList: the season story button')` appended |

## Implementation Steps

### Step 1: The story types, the boundary normalizer, `writeStory`'s season form
**File:** `web/src/moviesApi.ts:623` (replace from the `/** The story of a film or an episode …` comment through the end of `writeStory`, today lines 623–645)
**Change:** the web `StoryView` takes phase 6's shape; every story read from the daemon goes through `normalizeStory` once (sources limited to `http(s)` links and deduplicated, sections sorted and `found` false when there is no text, absent fields defaulted), so the modal trusts the typed value. `episode: null` asks for a season.
**Code:**
```ts
/** Where a story was written from: published recaps found on the web, or the episode's subtitle. */
export type StoryOrigin = 'web' | 'dialogue';

/** A web page a story was written from. */
export interface StorySource {
  url: string;
  title: string;
  /** The site's name ("Wikipedia", "Vulture"). */
  site: string;
}

/** One episode of a season's story. `found: false`: no source told this episode, and its text is empty. */
export interface StorySection {
  episode: number;
  name: string | null;
  text: string;
  found: boolean;
}

/** The story of a film, an episode or a whole season (`POST /api/movies/:id/story`). */
export interface StoryView {
  season: number;
  /** 0 for a season's story and a film's. */
  episode: number;
  /** Plain paragraphs, separated by a blank line. A season's story shows its sections instead. */
  text: string;
  model: string | null;
  written_at: string | null;
  origin: StoryOrigin;
  /** The pages it was written from; empty for a story written from a subtitle. */
  sources: StorySource[];
  /** A season's story, one per episode in episode order; empty for an episode's or a film's. */
  sections: StorySection[];
  /** The stream provider whose subtitle it was written from, and how many lines that was; null for a web story. */
  provider: string | null;
  cues: number | null;
}

/** A story as the daemon sends it: an older daemon leaves out origin, sources and sections. */
interface StoryWire {
  season?: number;
  episode?: number;
  text?: string | null;
  model?: string | null;
  written_at?: string | null;
  origin?: string | null;
  sources?: Partial<StorySource>[] | null;
  sections?: Partial<StorySection>[] | null;
  provider?: string | null;
  cues?: number | null;
}

function webUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || p === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** Reads a story off the wire once: only http(s) sources, each once; sections in episode order; defaults for what an older daemon leaves out. */
export function normalizeStory(s: StoryWire): StoryView {
  const seen = new Set<string>();
  const sources: StorySource[] = [];
  for (const x of list(s.sources)) {
    const url = webUrl(x?.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const title = typeof x.title === 'string' && x.title.trim() !== '' ? x.title.trim() : url;
    const site = typeof x.site === 'string' && x.site.trim() !== '' ? x.site.trim() : new URL(url).hostname;
    sources.push({ url, title, site });
  }
  const sections: StorySection[] = list(s.sections)
    .filter((x): x is Partial<StorySection> & { episode: number } => typeof x?.episode === 'number' && Number.isInteger(x.episode))
    .map((x) => {
      const text = typeof x.text === 'string' ? x.text : '';
      const name = typeof x.name === 'string' && x.name.trim() !== '' ? x.name.trim() : null;
      return { episode: x.episode, name, text, found: x.found === true && text.trim() !== '' };
    })
    .sort((a, b) => a.episode - b.episode);
  return {
    season: s.season ?? 0,
    episode: s.episode ?? 0,
    text: s.text ?? '',
    model: s.model ?? null,
    written_at: s.written_at ?? null,
    origin: s.origin === 'web' ? 'web' : 'dialogue',
    sources,
    sections,
    provider: s.provider ?? null,
    cues: typeof s.cues === 'number' ? s.cues : null,
  };
}

/**
 * The story of one episode (`episode` a number) or of a whole season (`episode` null): the stored
 * one, else the daemon writes it from published recaps on the web (an episode falls back to its
 * subtitle when the web has none), a model call of up to a few minutes, then keeps it. `cached` is
 * false only for a story this call had written. Throws ApiError: `story_off`, `no_story_source`,
 * `no_subtitle`, `no_source`, `story_failed`, ...
 */
export async function writeStory(titleId: string, season: number, episode: number | null): Promise<{ story: StoryView; cached: boolean }> {
  const body = episode === null ? { season } : { season, episode };
  const j = await postJson<{ story?: StoryWire | null; cached?: boolean }>(`/api/movies/${enc(titleId)}/story`, body);
  if (j === null || j.story === null || j.story === undefined) throw new ApiError(502, 'story_failed', 'The daemon answered no story.');
  return { story: normalizeStory(j.story), cached: j.cached === true };
}
```
**Impact:** `StoryModal` is the only caller (`grep -rn writeStory web/src`); it is updated in Step 4.

### Step 2: `has_story` on a season
**File:** `web/src/moviesApi.ts:147`
**Change:** replace `SeasonView`.
**Code:**
```ts
export interface SeasonView {
  season: number;
  /** YouTube video id of this season's trailer; null when TMDB lists none. */
  trailer_key: string | null;
  /** The season's whole story is stored: opening it calls no model. Absent from a server older than season stories. */
  has_story?: boolean;
  episodes: EpisodeView[];
}
```
**Impact:** optional field; `normalizeDetail` (line 558) spreads seasons and keeps it; fixtures compile unchanged.

### Step 3: `seasonCode`
**File:** `web/src/lib/movies.ts:135` (right after `episodeCode`, which ends at line 134)
**Code:**
```ts
/** `S02`: a season as the owner reads it on the page. */
export function seasonCode(season: number): string {
  return `S${pad(season)}`;
}
```
**Impact:** none; additive.

### Step 4: The modal: season sections, the not-found line, Sources, the wait text
**File:** `web/src/components/movies/StoryModal.tsx` (whole file, 118 lines today)
**Change:** `episode: number | null`; the wait text says it searches the web; `no_story_source` in words; a story with sections renders one `<section>` per episode under its heading; a `found: false` section says so; any story with sources lists them as links (`target="_blank"`, `rel="noreferrer"`); the footer names web sources or subtitle lines by `origin`.
**Code:**
```tsx
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { ApiError } from '../../api';
import { writeStory, type StorySection, type StoryView } from '../../moviesApi';
import { episodeCode } from '../../lib/movies';
import './MovieModal.css';

export interface StoryModalProps {
  titleId: string;
  season: number;
  /** The episode; null: the whole season's story, one section per episode. */
  episode: number | null;
  /** What the story is of: "One Piece S18E760 · Destruction of the Capital", "MobLand S01". */
  name: string;
  /** A story is stored: it opens at once and no model is called. */
  stored: boolean;
  onClose: () => void;
  /** Default: the daemon's story route. Tests pass a fake. */
  load?: typeof writeStory;
}

/** What an episode of a season's story says when no web source told it. */
export const STORY_NOT_FOUND_TEXT = 'No published recap was found for this episode.';

/** Why there is no story, in words. */
export function storyErrorText(code: string, detail: string | null): string {
  switch (code) {
    case 'no_story_source':
      return 'No published recap of this was found on the web, and no subtitle could stand in for it, so no story was written.';
    case 'no_subtitle':
      return 'A stream of this episode was found, but it has no English subtitle to write the story from.';
    case 'no_source':
      return 'No stream provider has this episode, so its subtitle could not be read.';
    case 'story_off':
      return 'Stories are off on this machine (NOTESD_MOVIES_STORY_MODEL=off, or Claude Code is not installed here).';
    case 'no_dialogue':
    case 'direct_stream_off':
      return 'The dialogue of this episode is not stored, and direct streaming is off on this machine, so it cannot be read here.';
    case 'resolve_failed':
      return 'The streaming Chrome could not be used to read the subtitle.';
    default:
      return detail ?? `The story could not be written (${code}).`;
  }
}

/** What the pop-up says while the story opens or is being written. */
export function storyWaitText(episode: number | null, stored: boolean): string {
  if (stored) return 'Opening the story…';
  return episode === null
    ? 'Searching the web for published recaps of this season, then writing its story episode by episode. This can take a minute or two, once; after that it opens at once.'
    : 'Searching the web for a published recap of this episode, then writing its story (from its subtitle only when the web has none). This can take a minute or two, once; after that it opens at once.';
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function sectionHeading(season: number, s: StorySection): string {
  const code = episodeCode(season, s.episode);
  return s.name === null ? code : `${code} · ${s.name}`;
}

/** Who wrote it, from what, and whether it was just written. */
function storyFoot(story: StoryView, cached: boolean): string {
  const by = story.model === null ? 'written' : `written by ${story.model}`;
  const from =
    story.origin === 'web'
      ? `from ${story.sources.length} web ${story.sources.length === 1 ? 'source' : 'sources'}`
      : `from ${story.cues ?? 0} subtitle lines${story.provider === null ? '' : ` (${story.provider})`}`;
  return `${by} ${from}${cached ? ' · stored' : ' · just now, and stored'}`;
}

type Phase = { at: 'writing' } | { at: 'done'; story: StoryView; cached: boolean } | { at: 'failed'; text: string };

/**
 * The whole story of one episode, or of a whole season, every spoiler included, in a pop-up over
 * the title's page. Opening it is the request: the daemon writes the story once from published
 * recaps on the web (an episode falls back to its subtitle when the web has none) and keeps it;
 * after that the stored story opens at once. A season's story has one section per episode; the
 * pages it was written from are listed as links under it. Esc and a click outside close it; a
 * story being written is still finished and kept by the daemon.
 */
export function StoryModal({ titleId, season, episode, name, stored, onClose, load = writeStory }: StoryModalProps) {
  const [phase, setPhase] = useState<Phase>({ at: 'writing' });
  useEffect(() => {
    let gone = false;
    setPhase({ at: 'writing' });
    load(titleId, season, episode).then(
      (r) => {
        if (!gone) setPhase({ at: 'done', story: r.story, cached: r.cached });
      },
      (err: unknown) => {
        if (gone) return;
        const code = err instanceof ApiError ? err.message : 'story_failed';
        setPhase({ at: 'failed', text: storyErrorText(code, err instanceof ApiError ? err.detail : err instanceof Error ? err.message : null) });
      },
    );
    return () => {
      gone = true;
    };
  }, [titleId, season, episode, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="mm" data-modal="story" onClick={onClose}>
      <div className="mm-panel mm-story" role="dialog" aria-label={`Story of ${name}`} onClick={(e) => e.stopPropagation()}>
        <header className="mm-head">
          <span className="mm-notice">story · full spoilers · {name}</span>
          <span className="mm-head-actions">
            <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
              <X weight="duotone" />
            </button>
          </span>
        </header>
        {phase.at === 'writing' && (
          <p className="mm-empty mm-story-wait" role="status">
            <CircleNotch className="mm-spin" weight="bold" />
            {storyWaitText(episode, stored)}
          </p>
        )}
        {phase.at === 'failed' && (
          <p className="mm-empty mm-story-wait" role="alert">
            <WarningCircle weight="duotone" />
            {phase.text}
          </p>
        )}
        {phase.at === 'done' && (
          <div className="mm-story-text">
            {phase.story.sections.length > 0
              ? phase.story.sections.map((s) => {
                  const heading = sectionHeading(phase.story.season, s);
                  return (
                    <section key={s.episode} className="mm-story-sec" aria-label={heading} data-found={s.found ? undefined : 'false'}>
                      <h3 className="mm-story-h">{heading}</h3>
                      {s.found ? paragraphs(s.text).map((p, i) => <p key={i}>{p}</p>) : <p className="mm-story-none">{STORY_NOT_FOUND_TEXT}</p>}
                    </section>
                  );
                })
              : paragraphs(phase.story.text).map((p, i) => <p key={i}>{p}</p>)}
            {phase.story.sources.length > 0 && (
              <section className="mm-story-sources" aria-label="Sources">
                <h3 className="mm-story-h">Sources</h3>
                <ul>
                  {phase.story.sources.map((src) => (
                    <li key={src.url}>
                      <a href={src.url} target="_blank" rel="noreferrer">
                        {src.title}
                      </a>
                      <span className="mm-notice"> · {src.site}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mm-notice mm-story-foot">{storyFoot(phase.story, phase.cached)}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```
**Impact:** `MovieDetail` (Step 7) passes `episode` as `number | null`. A dialogue story's paragraphs and footer render exactly as before (same `.mm-story-text p` list).

### Step 5: Styles for sections and sources
**File:** `web/src/components/movies/MovieModal.css:25` (after `.mm-story-wait svg { … }`, before `.mm-spin`)
**Change:** headings and section spacing in the panel's existing palette; the not-found line in the muted mono the modal's notices use; the sources under a hairline. No new colours.
**Code:**
```css
.mm-story-sec + .mm-story-sec { margin-top: 26px; }
.mm-story-text .mm-story-h { margin: 0 0 10px; font-size: 16px; font-weight: 500; line-height: 1.35; letter-spacing: -.005em; color: var(--text); }
.mm-story-text .mm-story-none { font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--muted); }
.mm-story-sources { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); }
.mm-story-sources .mm-story-h { font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .03em; color: var(--muted); }
.mm-story-sources ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.mm-story-sources a { color: var(--text); font-size: 13.5px; text-decoration: underline; text-decoration-color: var(--line-14); text-underline-offset: 3px; }
.mm-story-sources a:hover { text-decoration-color: currentColor; }
```
**Impact:** none outside the story modal (all selectors are `mm-story-*`).

### Step 6: The season head's book icon, and the episode tip's wording
**File:** `web/src/components/movies/EpisodeList.tsx`

**6a. Imports, lines 2–4.** Replace with:
```tsx
import { BookOpenText, CaretDown, CaretRight, CheckCircle, Checks } from '@phosphor-icons/react';
import type { EpisodeView, FileView, PlayerState, SeasonView, TitleDetail } from '../../moviesApi';
import { episodeAction, episodeCode, episodeLive, filePlayLabel, primaryFile, seasonCode, seasonsShown, streamLabel, streamSourceText, TILE_LIVE_LABEL, trailerTarget, type MoviesSide, type PlayButtonState, type StreamTarget, type TrailerTarget } from '../../lib/movies';
```

**6b. Prop, lines 31–33.** Replace the `onStory` member with:
```tsx
  /** Opens an episode's story (StoryModal). Left out, the rows have no book icon. */
  onStory?: (e: EpisodeView) => void;
  /** Opens a season's whole story (StoryModal, one section per episode). Left out, the season heads have no book icon. */
  onSeasonStory?: (s: SeasonView) => void;
```

**6c. New component, after `SeasonWatchedButton` (line 51).** Icon-only, the season head's `pbtn hov`, Phosphor `BookOpenText` like the episode's, `fill` when stored. The aria-label is the owner's words exactly.
```tsx
function SeasonStoryButton({ season, onOpen }: { season: SeasonView; onOpen: () => void }) {
  const code = seasonCode(season.season);
  const stored = season.has_story === true;
  const label = `Narrate the full story of ${code}`;
  const tip = stored ? `${label} (stored; full spoilers)` : `${label} (full spoilers; written once from published recaps on the web)`;
  return (
    <button type="button" className="pbtn hov mv-season-story" data-tip={tip} aria-label={label} data-stored={stored ? 'true' : undefined} onClick={onOpen}>
      <BookOpenText weight={stored ? 'fill' : 'duotone'} />
    </button>
  );
}
```

**6d. `EpisodeList`, lines 91–164.** Replace the whole function:
```tsx
/** A series' seasons (Library: those with a file on any machine; Stream: all), each with its trailer and every episode with its progress, flags and play icons; then files with no episode. */
export function EpisodeList({ detail, player, focus = null, busy, side, streamEnabled, onPlay, onStream, onRun, starting = null, onWatched, onSeasonWatched, onEpisodeWatched, onTrailer, onStory, onSeasonStory }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail, focus, side);
  const list = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => readCollapsed(detail.id));
  useEffect(() => setCollapsed(readCollapsed(detail.id)), [detail.id]);
  const toggleSeason = useCallback(
    (season: number) => {
      setCollapsed((was) => {
        const next = new Set(was);
        if (!next.delete(season)) next.add(season);
        keepCollapsed(detail.id, next);
        return next;
      });
    },
    [detail.id],
  );
  // The season of the episode the address names stays open, so the page can scroll to it.
  const isFolded = (s: { season: number; episodes: readonly EpisodeView[] }): boolean =>
    collapsed.has(s.season) && !(focus !== null && s.episodes.some((e) => e.movie_id === focus));
  // Once per (title, focus): a refresh of the detail must not pull the page back to the episode.
  const found = focus !== null && seasons.some((s) => s.episodes.some((e) => e.movie_id === focus));
  useEffect(() => {
    if (!found || focus === null) return;
    list.current?.querySelector(`[data-movie-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [detail.id, focus, found]);
  return (
    <section className="mv-sec" aria-label="Episodes" ref={list}>
      <h2 className="mv-h2">Episodes</h2>
      {seasons.map((s) => (
        <div key={s.season} className="mv-season" data-season={s.season} data-folded={isFolded(s) ? 'true' : undefined}>
          <div className="mv-season-head">
            <SeasonFoldButton name={s.season === 0 ? 'Specials' : `season ${s.season}`} folded={isFolded(s)} onToggle={() => toggleSeason(s.season)} />
            <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
            {s.season > 0 && <TrailerButton target={trailerTarget(detail, s.season)} onWatch={onTrailer} />}
            {s.season > 0 && onSeasonStory !== undefined && <SeasonStoryButton season={s} onOpen={() => onSeasonStory(s)} />}
            <SeasonWatchedButton name={s.season === 0 ? 'Specials' : `season ${s.season}`} episodes={s.episodes} busy={busy} onChange={(watched) => onSeasonWatched(s.season, watched)} />
            {isFolded(s) && <span className="mv-dim mv-season-sum">{foldedSummary(s.episodes)}</span>}
          </div>
          <ol className="mv-eps" hidden={isFolded(s)}>
            {s.episodes.map((e) => (
              <EpisodeItem
                key={e.episode}
                detail={detail}
                episode={e}
                focused={focus !== null && e.movie_id === focus}
                player={player}
                busy={busy}
                side={side}
                streamEnabled={streamEnabled}
                onPlay={onPlay}
                onStream={onStream}
                onRun={onRun}
                starting={starting !== null && starting.at === episodeCode(e.season, e.episode) ? starting.text : null}
                onWatched={onWatched}
                onEpisodeWatched={onEpisodeWatched}
                onStory={onStory}
              />
            ))}
          </ol>
        </div>
      ))}
      {hidden > 0 && <p className="mv-dim">{hidden === 1 ? '1 more season has' : `${hidden} more seasons have`} no file on any machine.</p>}
      {detail.unplaced_files.length > 0 && (
        <div className="mv-season">
          <h3 className="mv-season-h">Other files</h3>
          <ul className="mv-files">
            {detail.unplaced_files.map((f) => (
              <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={onPlay} onWatched={onWatched} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
```

**6e. The episode book icon's tip, line 212.** The episode story is web-first now (phase 6), so the tip stops promising a subtitle. Replace the `data-tip` line only (aria-labels unchanged, so existing tests and phase 9's drives still find it):
```tsx
          data-tip={e.has_story === true ? `The story of ${code} (stored; full spoilers)` : `Write the story of ${code} from published recaps on the web (full spoilers; Claude writes it once)`}
```
**Impact:** the season head gains one button between the trailer and the season-watched button; Specials (season 0) gets none. `.mv-season-head > .pbtn:first-child` (Movies.css:130) still matches the fold button only.

### Step 7: The title page opens the modal for a season
**File:** `web/src/components/movies/MovieDetail.tsx`

**7a. Line 3**, the `moviesApi` import: add `type SeasonView` after `type PlayerState`:
```tsx
import { continueTitle, errorCode, errorDetail, playFile, saveTitleUser, setEpisodesWatched, setFileWatched, streamPlay, type CastCredit, type EpisodeView, type FileView, type PlayerState, type SeasonView, type TitleDetail } from '../../moviesApi';
```
**7b. Line 33**, in the `../../lib/movies` import list: replace `  episodeCode,` with
```tsx
  episodeCode,
  seasonCode,
```
**7c. Above `export function MovieDetail` (line 72)** add the target type and its two builders; one state can hold either an episode or a season, never both:
```tsx
/** What the story pop-up is open on: one episode, or a whole season (`episode` null). */
interface StoryTarget {
  season: number;
  episode: number | null;
  name: string;
  stored: boolean;
}

function episodeStory(title: string, e: EpisodeView): StoryTarget {
  return { season: e.season, episode: e.episode, name: `${title} ${episodeCode(e.season, e.episode)}${e.name === null ? '' : ` · ${e.name}`}`, stored: e.has_story === true };
}

function seasonStory(title: string, s: SeasonView): StoryTarget {
  return { season: s.season, episode: null, name: `${title} ${seasonCode(s.season)}`, stored: s.has_story === true };
}
```
**7d. Lines 80–81:** replace
```tsx
  /** The episode or season whose story is open in the pop-up. */
  const [story, setStory] = useState<StoryTarget | null>(null);
```
**7e. Line 396:** replace `onStory={setStory}` with
```tsx
          onStory={(e) => setStory(episodeStory(d.title, e))}
          onSeasonStory={(s) => setStory(seasonStory(d.title, s))}
```
**7f. Lines 412–421:** replace the modal block with
```tsx
      {story !== null && (
        <StoryModal titleId={d.id} season={story.season} episode={story.episode} name={story.name} stored={story.stored} onClose={() => setStory(null)} />
      )}
```
**Impact:** the episode modal's name is unchanged (`MobLand S01E01 · Stick or Twist`); a season's is `MobLand S01`, so its dialog is named `Story of MobLand S01`. `EpisodeView` stays imported (used at line 395).

### Step 8: Tests for the modal and the client boundary
**File:** `web/src/components/movies/StoryModal.test.tsx` (whole file)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../api';
import { normalizeStory, writeStory, type StoryView } from '../../moviesApi';
import { PLAYER_IDLE, SERIES } from '../../testing/movieFixtures';
import { EpisodeList, type EpisodeListProps } from './EpisodeList';
import { STORY_NOT_FOUND_TEXT, StoryModal, storyErrorText } from './StoryModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STORY: StoryView = {
  season: 18,
  episode: 760,
  text: 'Jack gasses Zou.\n\nSanji arrives the next day.',
  model: 'sonnet',
  written_at: '2026-11-16T06:00:00.000Z',
  origin: 'dialogue',
  sources: [],
  sections: [],
  provider: 'VidNest Anime',
  cues: 292,
};
const SEASON_STORY: StoryView = {
  season: 1,
  episode: 0,
  text: 'Harry is called in.\n\nThe families clash.',
  model: 'sonnet',
  written_at: '2026-11-20T10:00:00.000Z',
  origin: 'web',
  sources: [
    { url: 'https://en.wikipedia.org/wiki/MobLand', title: 'MobLand - Wikipedia', site: 'Wikipedia' },
    { url: 'https://www.vulture.com/article/mobland-recap-season-1-episode-1.html', title: 'MobLand Recap: Stick or Twist', site: 'Vulture' },
  ],
  sections: [
    { episode: 1, name: 'Stick or Twist', text: 'Harry Da Souza is called in.\n\nA body turns up.', found: true },
    { episode: 2, name: 'Eye for an Eye', text: 'The families clash.', found: true },
    { episode: 3, name: 'Lie Down with Dogs', text: '', found: false },
  ],
  provider: null,
  cues: null,
};
const noop = () => {};

describe('StoryModal', () => {
  it('asks for an episode\'s story when it opens, says it searches the web, then shows it as paragraphs with where it came from', async () => {
    let answer: (r: { story: StoryView; cached: boolean }) => void = () => {};
    const load = vi.fn(() => new Promise<{ story: StoryView; cached: boolean }>((resolve) => { answer = resolve; }));
    render(<StoryModal titleId="tv-37854" season={18} episode={760} name="One Piece S18E760" stored={false} onClose={noop} load={load} />);
    expect(load).toHaveBeenCalledWith('tv-37854', 18, 760);
    expect(screen.getByRole('status').textContent).toMatch(/Searching the web for a published recap of this episode/);
    expect(screen.getByRole('status').textContent).toMatch(/a minute or two/);
    answer({ story: STORY, cached: false });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Story of One Piece S18E760' });
    expect([...dialog.querySelectorAll('.mm-story-text p')].map((p) => p.textContent)).toEqual([
      'Jack gasses Zou.',
      'Sanji arrives the next day.',
      'written by sonnet from 292 subtitle lines (VidNest Anime) · just now, and stored',
    ]);
    expect(within(dialog).queryByRole('region', { name: 'Sources' })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks for a whole season, then shows one section per episode under its heading, the not-found line, and the sources as links', async () => {
    let answer: (r: { story: StoryView; cached: boolean }) => void = () => {};
    const load = vi.fn(() => new Promise<{ story: StoryView; cached: boolean }>((resolve) => { answer = resolve; }));
    render(<StoryModal titleId="tv-247718" season={1} episode={null} name="MobLand S01" stored={false} onClose={noop} load={load} />);
    expect(load).toHaveBeenCalledWith('tv-247718', 1, null);
    expect(screen.getByRole('status').textContent).toMatch(/Searching the web for published recaps of this season/);
    answer({ story: SEASON_STORY, cached: false });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Story of MobLand S01' });
    expect([...dialog.querySelectorAll('.mm-story-sec > h3')].map((h) => h.textContent)).toEqual([
      'S01E01 · Stick or Twist',
      'S01E02 · Eye for an Eye',
      'S01E03 · Lie Down with Dogs',
    ]);
    expect([...within(dialog).getByRole('region', { name: 'S01E01 · Stick or Twist' }).querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Harry Da Souza is called in.',
      'A body turns up.',
    ]);
    const third = within(dialog).getByRole('region', { name: 'S01E03 · Lie Down with Dogs' });
    expect(third.textContent).toContain(STORY_NOT_FOUND_TEXT);
    expect(third.getAttribute('data-found')).toBe('false');
    // The season's flat text is not shown beside its sections.
    expect(dialog.textContent).not.toContain('Harry is called in.');
    const links = within(within(dialog).getByRole('region', { name: 'Sources' })).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['MobLand - Wikipedia', 'https://en.wikipedia.org/wiki/MobLand', '_blank', 'noreferrer'],
      ['MobLand Recap: Stick or Twist', 'https://www.vulture.com/article/mobland-recap-season-1-episode-1.html', '_blank', 'noreferrer'],
    ]);
    expect(dialog.querySelector('.mm-story-foot')?.textContent).toBe('written by sonnet from 2 web sources · just now, and stored');
  });

  it('opens a stored story without the long wait text, and says why when there is none', async () => {
    const stored = render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored onClose={noop} load={async () => ({ story: STORY, cached: true })} />);
    expect(screen.getByRole('status').textContent).toBe('Opening the story…');
    await waitFor(() => expect(stored.baseElement.querySelector('.mm-story-foot')?.textContent).toMatch(/· stored$/));
    cleanup();
    render(<StoryModal titleId="tv-1" season={1} episode={1} name="X S01E01" stored={false} onClose={noop} load={async () => Promise.reject(new ApiError(502, 'no_subtitle', 'VidFast streams it without an English subtitle.'))} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A stream of this episode was found, but it has no English subtitle to write the story from.'));
    cleanup();
    render(<StoryModal titleId="tv-1" season={2} episode={null} name="X S02" stored={false} onClose={noop} load={async () => Promise.reject(new ApiError(502, 'no_story_source', 'nothing found'))} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(storyErrorText('no_story_source', null)));
    expect(storyErrorText('no_story_source', null)).toMatch(/No published recap of this was found on the web/);
    expect(storyErrorText('story_failed', 'The story could not be written: no story within 240 s')).toBe('The story could not be written: no story within 240 s');
    expect(storyErrorText('weird', null)).toBe('The story could not be written (weird).');
  });

  it('closes on Esc, on its button and on a click outside', () => {
    const onClose = vi.fn();
    render(<StoryModal titleId="tv-1" season={1} episode={1} name="X" stored onClose={onClose} load={() => new Promise(() => {})} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('[data-modal="story"]')!);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('writeStory and the story read off the wire', () => {
  const answering = (story: unknown) => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ story, cached: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sent = (fetchMock: ReturnType<typeof answering>) => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    return [url, JSON.parse(init.body) as unknown];
  };

  it('posts {season} for a season and {season, episode} for an episode', async () => {
    let f = answering({ season: 2, episode: 0, text: '' });
    await writeStory('tv-1', 2, null);
    expect(sent(f)).toEqual(['/api/movies/tv-1/story', { season: 2 }]);
    vi.unstubAllGlobals();
    f = answering({ season: 2, episode: 3, text: 'x' });
    await writeStory('tv-1', 2, 3);
    expect(sent(f)).toEqual(['/api/movies/tv-1/story', { season: 2, episode: 3 }]);
  });

  it('keeps only web links, each once, puts sections in episode order, and reads an older daemon\'s story as a subtitle one', async () => {
    answering({
      season: 2,
      episode: 0,
      text: 'x',
      origin: 'web',
      sources: [
        { url: 'javascript:alert(1)', title: 'bad', site: 'x' },
        { url: 'https://example.org/a', title: '', site: '' },
        { url: 'https://example.org/a', title: 'again', site: 'Example' },
      ],
      sections: [
        { episode: 2, name: 'Two', text: '   ', found: true },
        { episode: 1, name: '', text: 'One.', found: true },
        { name: 'no number', text: 'y', found: true },
      ],
    });
    const { story } = await writeStory('tv-1', 2, null);
    expect(story.sources).toEqual([{ url: 'https://example.org/a', title: 'https://example.org/a', site: 'example.org' }]);
    expect(story.sections).toEqual([
      { episode: 1, name: null, text: 'One.', found: true },
      { episode: 2, name: 'Two', text: '   ', found: false },
    ]);
    expect(normalizeStory({ season: 1, episode: 1, text: 't', provider: 'VidFast', cues: 10 })).toEqual({
      season: 1, episode: 1, text: 't', model: null, written_at: null, origin: 'dialogue', sources: [], sections: [], provider: 'VidFast', cues: 10,
    });
  });
});

describe('EpisodeList: the story button', () => {
  const props = (over: Partial<EpisodeListProps> = {}): EpisodeListProps => ({
    detail: SERIES, player: PLAYER_IDLE, busy: false, side: 'library', streamEnabled: false, onPlay: noop, onStream: noop, onWatched: noop, onSeasonWatched: noop, onEpisodeWatched: noop, onTrailer: noop, ...over,
  });

  it('sits between the episode code and its name, opens that episode, and is filled once a story is stored', () => {
    const [first, second] = SERIES.seasons[0]!.episodes;
    const detail = { ...SERIES, seasons: [{ ...SERIES.seasons[0]!, episodes: SERIES.seasons[0]!.episodes.map((e, i) => (i === 1 ? { ...e, has_story: true } : e)) }] };
    const onStory = vi.fn();
    render(<EpisodeList {...props({ detail, onStory })} />);
    const row = document.querySelector('[data-testid="movie-file"]')!;
    expect([...row.children].slice(0, 3).map((c) => c.className.split(' ')[0])).toEqual(['mv-code', 'pbtn', 'mv-row-t']);
    const write = screen.getByRole('button', { name: /^Write the story of S01E01$/ });
    expect(write.getAttribute('data-stored')).toBeNull();
    expect(write.getAttribute('data-tip')).toMatch(/published recaps on the web/);
    expect(screen.getByRole('button', { name: /^The story of S01E02$/ }).getAttribute('data-stored')).toBe('true');
    fireEvent.click(write);
    expect(onStory).toHaveBeenCalledWith(expect.objectContaining({ season: first!.season, episode: first!.episode }));
    expect(second).toBeDefined();
  });

  it('is not there when the page gives no handler', () => {
    render(<EpisodeList {...props()} />);
    expect(screen.queryByRole('button', { name: /story/i })).toBeNull();
  });
});
```
**Impact:** the fake `fetch` answers `{ok, status, json}`, which is all `postJson` reads (`moviesApi.ts:532`).

### Step 9: Tests for the season button
**File:** `web/src/components/movies/EpisodeList.test.tsx` (append after the last `describe`, line 91; the file's `props`, `noop`, `SERIES`, `vi`, `render`, `screen` and `fireEvent` are already in scope from lines 1–16; no import changes)
**Code:**
```tsx
describe('EpisodeList: the season story button', () => {
  // Stream side lists every season with episodes; a Specials season is added to prove it gets no button.
  const specials = { ...SERIES.seasons[1]!, season: 0, episodes: SERIES.seasons[1]!.episodes.map((e) => ({ ...e, season: 0 })) };
  const detail = { ...SERIES, seasons: [specials, { ...SERIES.seasons[0]!, has_story: true }, SERIES.seasons[1]!] };

  it('puts a book icon on each numbered season head, named in the owner\'s words, filled when the season\'s story is stored, and opens that season', () => {
    const onSeasonStory = vi.fn();
    render(<EpisodeList {...props({ detail, side: 'stream', onSeasonStory })} />);
    const s1 = screen.getByRole('button', { name: 'Narrate the full story of S01' });
    const s2 = screen.getByRole('button', { name: 'Narrate the full story of S02' });
    expect(s1.closest('.mv-season-head')).toBe(document.querySelector('[data-season="1"] .mv-season-head'));
    expect(s1.getAttribute('data-stored')).toBe('true');
    expect(s1.getAttribute('data-tip')).toMatch(/^Narrate the full story of S01 \(stored/);
    expect(s2.getAttribute('data-stored')).toBeNull();
    expect(s2.getAttribute('data-tip')).toMatch(/^Narrate the full story of S02 \(full spoilers/);
    expect(s1.className).toBe('pbtn hov mv-season-story');
    expect(document.querySelector('[data-season="0"] .mv-season-story')).toBeNull();
    fireEvent.click(s2);
    expect(onSeasonStory).toHaveBeenCalledTimes(1);
    expect(onSeasonStory).toHaveBeenCalledWith(expect.objectContaining({ season: 2 }));
  });

  it('stays on a folded season and is not there when the page gives no handler', () => {
    const { unmount } = render(<EpisodeList {...props({ detail, side: 'stream', onSeasonStory: noop })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the episodes of season 1' }));
    expect(screen.getByRole('button', { name: 'Narrate the full story of S01' })).toBeTruthy();
    unmount();
    render(<EpisodeList {...props({ detail, side: 'stream' })} />);
    expect(screen.queryByRole('button', { name: /Narrate the full story/ })).toBeNull();
  });
});
```
**Impact:** none on the existing fold tests (they use the library side and no `onSeasonStory`).

## Principles applied

- Boundary discipline: the daemon's story is read once in `normalizeStory` (`moviesApi.ts`): only `http(s)` source links survive (a model-written `javascript:` URL never reaches an `href`), sources are deduplicated, sections sorted with `found` false when they carry no text, and an older daemon's answer gets defaults; the modal renders the typed value without re-checking.
- Make illegal states unrepresentable: `MovieDetail` holds one `StoryTarget | null` (season, `episode: number | null`, name, stored) instead of a second `seasonStory` state beside `story`, so two story pop-ups cannot be open at once; `writeStory`'s `episode: number | null` replaces a magic `0`.
- Laziness protocol: the season button is a small function in `EpisodeList.tsx` reusing `pbtn hov`, `BookOpenText` and the episode button's `data-stored`/`fill` convention; the season story opens in the existing `StoryModal`, no new modal or component file.
- Test behavior, not implementation: tests assert what the owner sees and what is sent (button names, `data-stored`, headings, the not-found line, link `href`/`target`/`rel`, the POST body), not internal state.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run web/src/components/movies/StoryModal.test.tsx web/src/components/movies/EpisodeList.test.tsx && npm test`
**Proof:** a throwaway daemon with this phase's web build, a stored web-written season story seeded into `movie_stories` (the throwaway pins `NOTESD_MOVIES_STORY_MODEL=off`, so a stored story is the only way to show one, as `features/movies.md` already does for episode stories), and a Playwright drive of the real title page.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `features/movies.md` (the title page's story entry; phase 9 rewrites it for the season story)
- Setup (the verifier runs this first, from the worktree root):
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --web --movies                      # note RUN=...
  RUN=<the RUN printed>
  for i in $(seq 1 12); do
    $V sql "$RUN" "select count(*) as n from movie_episodes where title_id = 'tv-247718' and season = 1" | grep -qE '(^|[^0-9])3([^0-9]|$)' && break
    $V api "$RUN" POST /api/movies/sync >/dev/null; sleep 10
  done
  ```
  Then write `$SCRATCH/seed-season-story.sql` (any scratch directory) with:
  ```sql
  insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at)
  values (
    'tv-247718', 1, 0,
    'Harry Da Souza is called in.',
    '[{"episode":1,"name":"Stick or Twist","text":"Harry Da Souza is called in.\n\nA body turns up.","found":true},
      {"episode":2,"name":"Eye for an Eye","text":"The families clash.","found":true},
      {"episode":3,"name":"Lie Down with Dogs","text":"","found":false}]'::jsonb,
    '[{"url":"https://en.wikipedia.org/wiki/MobLand","title":"MobLand - Wikipedia","site":"Wikipedia"},
      {"url":"https://www.vulture.com/article/mobland-recap-season-1-episode-1.html","title":"MobLand Recap: Stick or Twist","site":"Vulture"}]'::jsonb,
    'web', 'sonnet', now()
  );
  ```
  and run `$V exec "$RUN" "$(cat "$SCRATCH/seed-season-story.sql")"`, then `$V api "$RUN" GET '/api/movies/tv-247718/story?season=1'` (expects `story.sections` of length 3 and `cached: true`; this is phase 6's route, read here only to confirm the seed). Write `$SCRATCH/season-story.steps.mjs`:
  ```js
  export default async ({ page, base, shot, log }) => {
    await page.goto(base + '/')
    await page.getByRole('button', { name: 'Movies' }).first().click()
    await page.waitForURL((url) => url.pathname === '/movies')
    await page.getByRole('img', { name: 'MobLand' }).first().click()
    await page.waitForURL((url) => /^\/movies\/M-[0-9A-Z]{4}$/.test(url.pathname))
    const btn = page.getByRole('button', { name: 'Narrate the full story of S01', exact: true })
    await btn.waitFor()
    if ((await btn.getAttribute('data-stored')) !== 'true') throw new Error('the S01 story button is not filled though its story is stored')
    log('season 1 head: "Narrate the full story of S01", filled')
    await btn.click()
    const dialog = page.getByRole('dialog', { name: 'Story of MobLand S01' })
    await dialog.waitFor()
    await dialog.locator('.mm-story-sec').first().waitFor()
    const heads = await dialog.locator('.mm-story-sec > h3').allInnerTexts()
    const want = ['S01E01 · Stick or Twist', 'S01E02 · Eye for an Eye', 'S01E03 · Lie Down with Dogs']
    if (JSON.stringify(heads) !== JSON.stringify(want)) throw new Error(`sections: ${JSON.stringify(heads)}`)
    const third = await dialog.getByRole('region', { name: 'S01E03 · Lie Down with Dogs' }).innerText()
    if (!third.includes('No published recap was found for this episode.')) throw new Error(`S01E03 says: ${third}`)
    log('R6.1: one section per episode under S01E0n headings; S01E03 says no published recap was found')
    await shot('season-story-sections')
    const links = dialog.getByRole('region', { name: 'Sources' }).getByRole('link')
    const n = await links.count()
    if (n !== 2) throw new Error(`expected 2 source links, found ${n}`)
    const got = []
    for (let i = 0; i < n; i++) {
      const a = links.nth(i)
      got.push([await a.innerText(), await a.getAttribute('href'), await a.getAttribute('target'), await a.getAttribute('rel')])
    }
    const wantLinks = [
      ['MobLand - Wikipedia', 'https://en.wikipedia.org/wiki/MobLand', '_blank', 'noreferrer'],
      ['MobLand Recap: Stick or Twist', 'https://www.vulture.com/article/mobland-recap-season-1-episode-1.html', '_blank', 'noreferrer'],
    ]
    if (JSON.stringify(got) !== JSON.stringify(wantLinks)) throw new Error(`sources: ${JSON.stringify(got)}`)
    await dialog.getByRole('region', { name: 'Sources' }).scrollIntoViewIfNeeded()
    log('R6.3: the two web sources are links opening in a new tab, rel=noreferrer')
    await shot('season-story-sources')
  }
  ```
- Journeys:
  - **J1** · traces R6.1 — after the setup, `$V ui "$RUN" "$SCRATCH/season-story.steps.mjs"` → passes when the run ends without an error and its log has the line "R6.1: one section per episode…": the MobLand page's season 1 head has a filled button named exactly `Narrate the full story of S01`, and clicking it opens the dialog `Story of MobLand S01` whose section headings are exactly `S01E01 · Stick or Twist`, `S01E02 · Eye for an Eye`, `S01E03 · Lie Down with Dogs`, the third saying "No published recap was found for this episode." (screenshot `season-story-sections`).
  - **J2** · traces R6.3 — the same drive (J1's run) → passes when its log has the line "R6.3: the two web sources…": the dialog's `Sources` region holds exactly two links, `MobLand - Wikipedia` → `https://en.wikipedia.org/wiki/MobLand` and `MobLand Recap: Stick or Twist` → the Vulture URL, each with `target="_blank"` and `rel="noreferrer"` (screenshot `season-story-sources`).
  - **J3** · traces R6.1, R6.3 — `npx vitest run web/src/components/movies/StoryModal.test.tsx web/src/components/movies/EpisodeList.test.tsx` → passes when every test passes, including "asks for a whole season, then shows one section per episode…" (`load` called with `('tv-247718', 1, null)`, three headings, the not-found line, two links with `_blank`/`noreferrer`), "posts {season} for a season…" and "puts a book icon on each numbered season head…".
- Neighbor check: the episode story still opens. `npx vitest run web/src/components/movies/StoryModal.test.tsx -t "asks for an episode"` and `-t "the story button"` pass (paragraphs and the subtitle footer unchanged for an `origin: dialogue` story; the episode button's aria-labels unchanged), and `npx vitest run web/src/App.movies.test.tsx web/src/App.stream.test.tsx` passes (the title page still renders with the changed `MovieDetail` state). Then `$V down "$RUN"`.
- Cost: none (no model call; `NOTESD_MOVIES_STORY_MODEL=off` is pinned on the throwaway daemon).

**Exit criteria:** `npm run typecheck` and `npm test` pass; `StoryModal.test.tsx` and `EpisodeList.test.tsx` cover the season button, the sections, the not-found line and the source links; J1 and J2 pass on a throwaway daemon with the screenshots saved.

## Handoffs

- **Phase 6** (reconciler: align): the five assumptions under **Requires** — `POST /api/movies/:id/story {season}` for a season; the story JSON with `origin`, `sources[{url,title,site}]`, `sections[{episode,name,text,found}]`, `episode: 0` for a season, `provider`/`cues` null for a web story; every episode's content in its section (the modal does not show `text` beside sections); per-season `has_story` on `seasons[]` of `GET /api/movies/:id`; the `changed` event after a new season story; the error code `no_story_source`. Phase 6 should also refuse non-`http(s)` source URLs server-side; the client filters them anyway.
- **Phase 9**: `.claude/skills/verify-notesd/features/movies.md` (the story entry: the season head's "Narrate the full story of SXX", sections, not-found line, Sources; proof `StoryModal.test.tsx`, `EpisodeList.test.tsx` and J1/J2's drive above, which can be kept as a script under `scripts/movies/`), `docs/guide/movies.md` and `docs/guide/streaming.md` ("What a title says") prose, and the movies guide's pictures (a `--live` retake of the title page shows the new season button). This phase changes the UI but does not retake pictures or edit the feature map, because phase 9 owns both.
- **Phase 8**: the season head layout in **Interface Contract**; the `DownloadButton` goes after `SeasonWatchedButton`. Phase 8 must keep `onSeasonStory` and `SeasonStoryButton` as they are.
- Not done here: a film's book icon on the page (none exists today; out of scope per the index).

## Rollback

Revert this phase's commit. It touches only web files; the server's season story route (phase 6) keeps working without a button (reachable through the API), and the episode book icon returns to its earlier wording.

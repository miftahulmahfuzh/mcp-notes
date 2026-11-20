/**
 * Voice-over and dub groups known by name. A release that carries one of these names is a dub into the group's
 * language even when nothing else in the name says so: `Eternally.Yours.S01E07.1080p.ColdFilm.mkv` is a Russian
 * voice-over of an English series, and its file tags no audio language, so nothing else would refuse it.
 *
 * parseRelease (release.ts) reads the name after the title, like every other marker: a group's name makes the
 * release `dub` and adds the group's language, so rank.ts sends it to the last-resort (dub-named) round exactly as a
 * name that says "dub", where the header probe still decides by the real audio (a dual-audio release that also names
 * the original is not `dubbed`). This list is the one place the groups are named; add a group here only once it is
 * known to be a voice-over or dub studio, with what it is.
 */

export interface DubGroup {
  /** As the group writes its own name. */
  name: string;
  /** ISO 639-1 code of the language the group dubs into. */
  language: string;
  /** What the group is, in a few words. */
  what: string;
  /** Its name as release names spell it: lower case, letters and digits only, words joined (`kubikvkube`). */
  spellings: readonly string[];
}

export const DUB_GROUPS: readonly DubGroup[] = [
  { name: 'ColdFilm', language: 'ru', what: 'Russian voice-over studio for series', spellings: ['coldfilm'] },
  { name: 'LostFilm', language: 'ru', what: 'Russian voice-over studio for series (LostFilm.TV)', spellings: ['lostfilm'] },
  { name: 'HDRezka', language: 'ru', what: 'Russian streaming site and its HDrezka Studio voice-overs', spellings: ['hdrezka', 'rezka'] },
  { name: 'NewStudio', language: 'ru', what: 'Russian voice-over studio for series (NewStudio.TV)', spellings: ['newstudio'] },
  { name: 'Jaskier', language: 'ru', what: 'Russian voice-over studio for series', spellings: ['jaskier'] },
  { name: 'AlexFilm', language: 'ru', what: 'Russian voice-over studio', spellings: ['alexfilm'] },
  { name: 'BaibaKo', language: 'ru', what: 'Russian voice-over studio for series (BaibaKo.tv)', spellings: ['baibako'] },
  { name: 'Kubik v Kube', language: 'ru', what: 'Russian voice-over studio (Кубик в Кубе)', spellings: ['kubikvkube', 'kubik3'] },
  { name: 'IdeaFilm', language: 'ru', what: 'Russian voice-over studio', spellings: ['ideafilm'] },
  { name: 'TVShows', language: 'ru', what: 'Russian voice-over studio for series', spellings: ['tvshows'] },
  { name: 'NovaMedia', language: 'ru', what: 'Russian voice-over studio for series', spellings: ['novamedia'] },
];

const BY_SPELLING: ReadonlyMap<string, DubGroup> = new Map(DUB_GROUPS.flatMap((g) => g.spellings.map((s) => [s, g] as const)));
/** The most words one spelling is split into in a name (`kubik v kube`). */
const MAX_WORDS = 3;

/**
 * The first known dub group among `tokens` (a name's lower-case words, as release.ts splits them), or null. A group
 * matches as one word (`coldfilm`) or as up to three words in a row that spell it (`kubik v kube`).
 */
export function dubGroupIn(tokens: readonly string[]): DubGroup | null {
  for (let i = 0; i < tokens.length; i++) {
    let spelled = '';
    for (let j = i; j < Math.min(tokens.length, i + MAX_WORDS); j++) {
      spelled += (tokens[j] ?? '').replace(/[^a-z0-9]/g, '');
      const group = BY_SPELLING.get(spelled);
      if (group !== undefined) return group;
    }
  }
  return null;
}

/** The known dub group a release name carries anywhere, or null: for a name read without a title (a pasted magnet's `dn`, the candidates list). */
export function dubGroupOfName(name: string): DubGroup | null {
  const tokens = name
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  return dubGroupIn(tokens);
}

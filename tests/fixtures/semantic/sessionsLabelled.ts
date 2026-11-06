import type { Lexicon } from '../../helpers/fakeEmbedder.js';
import { SEMANTIC_LEXICON } from './labelled.js';

/**
 * A labelled set for the related-evidence weight (BLEND.related in src/search/blend.ts): Claude
 * Code sessions with their own summary and prompts, and Claude's replies in them.
 * tests/integration/sessions.relatedEvidence.int.test.ts loads it into cc_sessions /
 * cc_session_replies with fake-embedder vectors (SESSION_LEXICON, SESSION_STOPWORDS) and runs
 * the real searchSessions, so text ranks are Postgres's own ts_rank.
 *
 * The query kinds pull BLEND.related in opposite directions:
 *   over-match  a session whose own summary answers, against one that only repeats the words in
 *               long replies: too high a weight lets the chatty one win.
 *   reply-only  the only session that answers does so in a reply, against a session whose own
 *               text is loosely related: too low a weight buries the answer.
 *   own         the answer is in the session's own text only (a sanity check).
 */
export interface LabelledSession {
  key: string;
  summary: string;
  prompts: readonly string[];
  /** Claude's reply to prompts[i] (seq i + 1). */
  replies: readonly string[];
  ageDays: number;
}

export interface LabelledSessionQuery {
  query: string;
  /** Key of the session that must rank first in hybrid mode. */
  answer: string;
  kind: 'over-match' | 'reply-only' | 'own';
  why: string;
}

const SCORECARD_REPLIES = [
  'The scorecard now has one row per method. The trades column shows zero when a method has no closed trades yet, and the adversarial book gets its own column beside the twin book. Zero trades is not an error there: it only means nothing closed in the window. I narrowed the trades column, right-aligned the numbers and moved the adversarial win rate next to it so the two books line up.',
  'I checked the layout at 1400 px. The adversarial columns wrap when the method name is long, so I gave the name column a max width. Rows with zero trades are greyed so they do not compete with methods that traded. The trades header now has a tooltip that says closed trades only.',
  'Last pass on the scorecard: zero trades rows sort to the bottom, the adversarial and twin trades counts share one header, and the page keeps its scroll position on refresh.',
];

const PURGE_REPLIES = [
  'A photo delete from the editor is soft: the photo goes to the recycle bin with its note. The purge job hard-deletes photo rows older than 30 days and removes the derived copies. A photo delete that was restored keeps its position. I made the purge skip any photo delete that is younger than the grace period, and logged every photo it removes.',
];

export const LABELLED_SESSIONS: ReadonlyArray<LabelledSession> = [
  {
    key: 'adv-cutoff',
    ageDays: 10,
    summary: 'Seer Adversarial showed zero trades: verdicts were dated after the session open, so the cutoff dropped every pick. Fixed by comparing against session_open_utc.',
    prompts: ['why does adversarial show zero trades?'],
    replies: ['The cutoff now compares against session_open_utc, and a regression test covers it.'],
  },
  {
    key: 'adv-scorecard',
    ageDays: 2,
    summary: 'Scorecard page layout for the Adversarial view.',
    prompts: ['make the scorecard columns narrower', 'check it at 1400 px', 'one more pass'],
    replies: SCORECARD_REPLIES,
  },
  {
    key: 'wifi-ingest',
    ageDays: 30,
    summary: 'Refactored the session ingest tail loop and its byte offsets.',
    prompts: ['clean up the tail loop'],
    replies: ['Separate from the ingest work: the wifi drops after resume were the GPD driver; reloading it fixed the connection.'],
  },
  {
    key: 'laptop-battery',
    ageDays: 1,
    summary: 'Laptop battery report script for the GPD.',
    prompts: ['write a battery report script'],
    replies: [],
  },
  {
    key: 'quokka-reply',
    ageDays: 60,
    summary: 'Drizzle migration cleanup.',
    prompts: ['tidy the migrations'],
    replies: ['The quokka flag is gone; nothing reads it now.'],
  },
  {
    key: 'photo-own',
    ageDays: 20,
    summary: 'Wall photo delete button added to the editor.',
    prompts: ['add a delete button for photos'],
    replies: [],
  },
  {
    key: 'photo-chatty',
    ageDays: 3,
    summary: 'Recycle bin purge job.',
    prompts: ['purge the bin nightly'],
    replies: PURGE_REPLIES,
  },
];

export const LABELLED_SESSION_QUERIES: ReadonlyArray<LabelledSessionQuery> = [
  {
    query: 'adversarial zero trades',
    answer: 'adv-cutoff',
    kind: 'over-match',
    why: 'the cutoff fix says it in its summary; the scorecard session repeats every word in three long replies',
  },
  {
    query: 'why did adversarial show no trades',
    answer: 'adv-cutoff',
    kind: 'own',
    why: 'no literal match anywhere (websearch AND); the fix wins on its own vector',
  },
  {
    query: 'connection problems after waking the laptop',
    answer: 'wifi-ingest',
    kind: 'reply-only',
    why: 'only a reply holds the wifi-after-resume fix; the battery session is a loose own match (laptop, GPD)',
  },
  {
    query: 'quokka',
    answer: 'quokka-reply',
    kind: 'reply-only',
    why: 'a word that only one reply has',
  },
  {
    query: 'photo delete',
    answer: 'photo-own',
    kind: 'over-match',
    why: 'the delete-button session says it in its summary; the purge session repeats "photo delete" in a long reply',
  },
];

/** SEMANTIC_LEXICON plus the concepts these sessions need. */
export const SESSION_LEXICON: Lexicon = [
  ...SEMANTIC_LEXICON,
  ['trade', 'trades', 'trading', 'pick*', 'position*'],
  ['adversar*', 'verdict*', 'critic*', 'review*'],
  ['zero', 'none', 'no', 'empty', 'nothing', 'missing'],
  ['cutoff*', 'deadline*', 'late'],
  ['photo*', 'image*', 'picture*'],
  ['delete*', 'remov*', 'purge*', 'bin'],
  ['scorecard*', 'column*', 'layout*', 'page'],
];

/** Function words dropped before embedding (replaces the fake embedder's default list). */
export const SESSION_STOPWORDS: readonly string[] = [
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'in', 'on', 'at', 'of', 'to', 'for', 'and',
  'or', 'it', 'this', 'that', 'with', 'we', 'have', 'has', 'my', 'me', 'i', 'you', 'do', 'did',
  'does', 'any', 'about', 'what', 'which', 'so', 'as', 'by', 'from', 'if', 'not', 'why', 'show',
  'showed', 'after', 'when', 'each', 'its', 'their', 'them', 'they', 'one', 'now', 'yet', 'every',
];

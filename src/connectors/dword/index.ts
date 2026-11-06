import { createConnector, type ConnectorOptions } from '../connector.js';
import type { Connector, SystemAbout } from '../types.js';

/**
 * daily-words' own schema (~/daily-words/src/lib/db/schema.ts), summarised for dword_schema.
 * mcp-notes reads this database read-only through dword_sql, exactly like every other connector's
 * *_sql tool; it never writes through dword_sql. Writes go only through the allow-listed
 * src/dword/writer.ts (phase 2), which resolves the owner's row via DWORD_USER_EMAIL
 * (src/connectors/dword/user.ts) fresh on every call.
 */
export const DWORD_ABOUT: SystemAbout = {
  summary:
    "the owner's vocabulary and wise-words app (daily-words, dword.site): vocab entries with " +
    'origin/translation metadata, journal entries with an insight and a near-duplicate check, ' +
    'one row per Auth.js user',
  db:
    'users: one row per Auth.js account (id uuid, email unique not null — DWORD_USER_EMAIL is resolved against this). ' +
    'vocab_entries: term (always the English headword); source (manual|suggested|shared); status (active|mastered); ' +
    'part_of_speech, pronunciation (British RP), definition, examples (jsonb array of 3 strings, each containing the term); ' +
    "enrichment_status (pending|ready|failed); origin_term/origin_language/origin_context record a non-English lookup's " +
    'foreign word, language and the sentence it was found in, or an attached "as in" sentence for an English term — ' +
    'origin_context may only be set when origin_term is (CHECK vocab_entries_origin_context_needs_term); unique index on ' +
    '(user_id, lower(term)). journal_entries: text, source_note, insight jsonb {meaning, whenItApplies[]}, ' +
    'insight_status (none|pending|ready|failed). journal_entry_embeddings: one row per journal entry, text_sha/norm_sha ' +
    '(sha256 hex of the text and of its normalized form), embedding vector(1536) nullable, model, status (ready|failed) — ' +
    "a row with no embedding is backfilled later by dword itself, never by mcp-notes. Several more tables back dword's own " +
    'web app (accounts, sessions, daily_cards, badges, shares, ...) and are outside this connector\'s write scope.',
};

export function createDwordConnector(options: ConnectorOptions = {}): Connector {
  return createConnector('dword', options);
}

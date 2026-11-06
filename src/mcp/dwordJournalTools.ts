import { existsSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { resolveDwordUserId } from '../connectors/dword/user.js';
import { CONNECTOR_SETTINGS_FILE, connectorSettings, resolveRepoDir } from '../connectors/env.js';
import { toObjects } from '../connectors/rows.js';
import type { Connector } from '../connectors/types.js';
import {
  INSIGHT_MEANING_MAX_CHARS,
  INSIGHT_MEANING_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS,
  INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS,
  JOURNAL_SOURCE_NOTE_MAX,
  JOURNAL_TEXT_MAX,
  JOURNAL_TEXT_MIN,
} from '../dword/rules.js';
import { DwordWriter } from '../dword/writer.js';
import { NEAR_DUPLICATE_MAX_DISTANCE, normShaFor, textShaFor } from '../dword/journalSimilarity.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import type { Embedder } from '../embeddings/embedder.js';
import { createOpenRouterEmbedder } from '../embeddings/openrouter.js';
import { run } from './tools.js';

const FIND_SIMILAR = 'dword_journal_find_similar';
const ADD = 'dword_journal_add';

/* ------------------------------------------------------------- shapes ------------------------------------------------------------- */

export interface JournalInsight {
  meaning: string;
  whenItApplies: string[];
}

export interface JournalMatchEntry {
  id: string;
  text: string;
  source_note: string | null;
  insight: JournalInsight | null;
  insight_status: string;
  created_at: string;
}

interface JournalSiblingFacts {
  textSha: string;
  normSha: string;
  status: 'ready' | 'failed';
  model?: string;
  embedding?: number[];
}

export interface JournalDuplicateResult {
  verdict: 'duplicate' | 'none';
  entries: JournalMatchEntry[];
  layer2Skipped?: true;
  sibling: JournalSiblingFacts;
}

type Row = Record<string, unknown>;

function toMatchEntry(row: Row): JournalMatchEntry {
  return {
    id: String(row.id),
    text: String(row.text),
    source_note: row.source_note === null || row.source_note === undefined ? null : String(row.source_note),
    insight: (row.insight as JournalInsight | null) ?? null,
    insight_status: String(row.insight_status),
    created_at: String(row.created_at),
  };
}

/* --------------------------------------------------------------- SQL -------------------------------------------------------------- */

const MATCH_COLUMNS = `je.id, je.text, je.source_note, je.insight, je.insight_status,
  to_char(je.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

/** Layer 1: exact norm_sha match. No status filter — mirrors dword's own findByNormSha. */
const LAYER1_SQL = `
SELECT ${MATCH_COLUMNS}
FROM journal_entry_embeddings jee
JOIN journal_entries je ON je.id = jee.entry_id
WHERE jee.user_id = $1
  AND jee.norm_sha = $2
  AND jee.text_sha = encode(sha256(je.text::bytea), 'hex')
ORDER BY je.created_at DESC
LIMIT 1`;

/** Layer 2: nearest ready, non-stale vector. Mirrors dword's own findNearest (limit 1: this phase shows only the top match). */
const LAYER2_SQL = `
SELECT ${MATCH_COLUMNS}, (jee.embedding <=> $2::vector) AS distance
FROM journal_entry_embeddings jee
JOIN journal_entries je ON je.id = jee.entry_id
WHERE jee.user_id = $1
  AND jee.status = 'ready'
  AND jee.embedding IS NOT NULL
  AND jee.text_sha = encode(sha256(je.text::bytea), 'hex')
ORDER BY jee.embedding <=> $2::vector
LIMIT 1`;

async function findByNormSha(connector: Connector, userId: string, normSha: string): Promise<JournalMatchEntry | null> {
  const result = await connector.query(LAYER1_SQL, [userId, normSha], { maxRows: 1 });
  const [row] = toObjects(result);
  return row ? toMatchEntry(row) : null;
}

async function findNearestJournalEntry(
  connector: Connector,
  userId: string,
  vector: number[],
): Promise<(JournalMatchEntry & { distance: number }) | null> {
  const result = await connector.query(LAYER2_SQL, [userId, toVectorLiteral(vector)], { maxRows: 1 });
  const [row] = toObjects(result);
  if (!row) return null;
  return { ...toMatchEntry(row), distance: Number(row.distance) };
}

/* ------------------------------------------------------ the shared dedup check ------------------------------------------------------ */

/**
 * The one duplicate check, called by both tools below (the brief's "call it, don't reimplement").
 * Always returns `sibling`: when Layer 2 ran and the result was 'none', the vector it computed is
 * reused by dword_journal_add for journal_entry_embeddings instead of embedding the text twice —
 * "the vector has been paid for", exactly as dword's own route comments it.
 *
 * Deliberately does NOT special-case `force` by skipping the check (dword's own route does skip
 * it entirely on a forced save, and therefore never embeds a forced save at all). This phase's
 * brief asks for the check to always run, so a forced save still gets a computed embedding
 * whenever Layer 1 missed — strictly better coverage than dword's own behavior, and the ONE
 * place this port deliberately differs from dword's code path rather than its data shape.
 */
export async function findSimilarJournalEntries(
  connector: Connector,
  userId: string,
  text: string,
  embedder: Embedder | null,
): Promise<JournalDuplicateResult> {
  const textSha = textShaFor(text);
  const normSha = normShaFor(text);
  const unembedded: JournalSiblingFacts = { textSha, normSha, status: 'failed' };

  const layer1 = await findByNormSha(connector, userId, normSha);
  if (layer1 !== null) {
    return { verdict: 'duplicate', entries: [layer1], sibling: unembedded };
  }

  if (embedder === null) {
    return { verdict: 'none', entries: [], layer2Skipped: true, sibling: unembedded };
  }

  let vector: number[];
  try {
    const vectors = await embedder.embed([text]);
    const first = vectors[0];
    if (first === undefined) throw new Error('embedder returned no vector');
    vector = first;
  } catch {
    // Provider down, unconfigured, timed out: never block the save (dword's own Product Principle 5).
    return { verdict: 'none', entries: [], layer2Skipped: true, sibling: unembedded };
  }

  const sibling: JournalSiblingFacts = { textSha, normSha, status: 'ready', model: embedder.model, embedding: vector };
  const nearest = await findNearestJournalEntry(connector, userId, vector);
  // Strict '<', mirroring dword's own isNearDuplicate ("distance < T warns, distance === T does
  // not" — ~/daily-words/src/lib/journal/similarity.ts). "Mirror, do not invent" wins here even
  // though this phase's own brief said "<=": a boundary-exact distance is a real measured edge
  // case in dword's own corpus notes, not a rounding nicety, so dword's own code is the fact.
  if (nearest !== null && nearest.distance < NEAR_DUPLICATE_MAX_DISTANCE) {
    const { distance: _distance, ...entry } = nearest;
    return { verdict: 'duplicate', entries: [entry], sibling };
  }
  return { verdict: 'none', entries: [], sibling };
}

/* ---------------------------------------------------------- the embedder ---------------------------------------------------------- */

/**
 * registerDwordCurated(server, connectors.dword) passes only a Connector — no AppDeps, no
 * Config — so this cannot reuse the daemon's shared `deps.embedder`. It reads mcp-notes' own
 * OPENROUTER_API_KEY itself, the same real-env-over-.env.local precedence connectorSettings()
 * already uses for sibling repo settings. Cheap: construction touches no network.
 */
function resolveOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(CONNECTOR_SETTINGS_FILE)) return null;
  try {
    const fromFile = parseDotenv(readFileSync(CONNECTOR_SETTINGS_FILE)).OPENROUTER_API_KEY?.trim();
    return fromFile ? fromFile : null;
  } catch {
    return null;
  }
}

/** null means "no OPENROUTER_API_KEY configured" — Layer 2 is reported skipped, never an error. */
export function defaultJournalEmbedder(): Embedder | null {
  const apiKey = resolveOpenRouterApiKey();
  return apiKey === null ? null : createOpenRouterEmbedder({ apiKey });
}

/* ------------------------------------------------------------ zod fields ------------------------------------------------------------ */

const textField = z
  .string()
  .trim()
  .min(JOURNAL_TEXT_MIN)
  .max(JOURNAL_TEXT_MAX)
  .describe(`The journal line (the saying), ${JOURNAL_TEXT_MIN}-${JOURNAL_TEXT_MAX} characters.`);

const sourceNoteField = z
  .string()
  .trim()
  .max(JOURNAL_SOURCE_NOTE_MAX)
  .optional()
  .describe(`Where it came from, e.g. a book title. At most ${JOURNAL_SOURCE_NOTE_MAX} characters. Omit if unknown.`);

const insightField = z
  .object({
    meaning: z
      .string()
      .trim()
      .min(INSIGHT_MEANING_MIN_CHARS)
      .max(INSIGHT_MEANING_MAX_CHARS)
      .describe(`The saying's meaning, ${INSIGHT_MEANING_MIN_CHARS}-${INSIGHT_MEANING_MAX_CHARS} characters, dictionary register, no advice, no praise.`),
    whenItApplies: z
      .array(z.string().trim().min(INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS).max(INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS))
      .min(INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS)
      .max(INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS)
      .describe(`${INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS}-${INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS} concrete everyday situations it applies to, each ${INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS}-${INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS} characters.`),
  })
  .describe("Claude's own explanation (D2: dword's GLM prompts are not called).");

const FIND_SIMILAR_DESCRIPTION =
  "Checks whether the owner's daily-words journal already has this saying or something close to it. Layer 1: an exact match after " +
  "normalizing whitespace, smart quotes and accents (a re-paste of the same line). Layer 2, only on a Layer 1 miss: cosine distance " +
  `of a fresh embedding against the owner's own entries, verdict 'duplicate' when distance < ${NEAR_DUPLICATE_MAX_DISTANCE}. A failed ` +
  "or unavailable embedding call never errors - it reports layer2_skipped: true and verdict 'none', since Layer 1 already ran and a " +
  "provider outage must never block a save (dword's own rule). Returns { verdict: 'duplicate' | 'none', entries, layer2_skipped? }; " +
  'entries holds the matching line(s) with their stored insight. Call this before dword_journal_add to decide what to tell the user; ' +
  'dword_journal_add runs the identical check itself, so this tool is for showing the user what would happen, not a required first call.';

const ADD_DESCRIPTION =
  'Adds a journal entry to daily-words, after running the same duplicate check as dword_journal_find_similar. If a duplicate is found ' +
  "and force is not true, nothing is inserted and the match is returned (D3 - 'show it, insert nothing unless the user says save " +
  "anyway'). Otherwise inserts with insight_status='ready' and, when an embedding was computed during the check, a " +
  'journal_entry_embeddings row too - a failed or unavailable embedding never blocks the entry insert; it is simply skipped and ' +
  "dword's own backfill picks it up later. insight is written by Claude (D2): meaning plus 2-3 concrete everyday situations, English, " +
  'dictionary register, no advice, no praise. Returns { verdict, inserted, entries, entry?, embedded, layer2_skipped? }.';

/* ---------------------------------------------------------- registration ---------------------------------------------------------- */

export interface DwordJournalOptions {
  /** Default: defaultJournalEmbedder(). Pass null to force Layer 2 off; tests inject a FakeEmbedder, including one set to fail. */
  embedder?: Embedder | null;
  /** Default: a DwordWriter pointed at DAILY_WORDS_DIR, resolved fresh. Tests inject one pointed at the throwaway Postgres. */
  writer?: DwordWriter;
  /** DWORD_USER_EMAIL override (tests). Default: loadConfig().dword.userEmail, read fresh per call — same pattern as src/mcp/dwordVocabTools.ts. */
  userEmail?: () => string | null;
}

export function registerDwordJournalCurated(server: McpServer, connector: Connector, options: DwordJournalOptions = {}): void {
  const embedder = options.embedder === undefined ? defaultJournalEmbedder() : options.embedder;
  const emailOf = options.userEmail ?? ((): string | null => loadConfig().dword.userEmail);
  const writer =
    options.writer ??
    new DwordWriter({ repoDir: () => resolveRepoDir('dword', connectorSettings()), userEmail: () => emailOf() ?? undefined });

  server.registerTool(
    FIND_SIMILAR,
    {
      title: 'Find a similar daily-words journal entry',
      description: FIND_SIMILAR_DESCRIPTION,
      inputSchema: { text: textField },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) =>
      run(async () => {
        const userId = await resolveDwordUserId(connector, emailOf());
        const result = await findSimilarJournalEntries(connector, userId, text, embedder);
        return {
          verdict: result.verdict,
          entries: result.entries,
          ...(result.layer2Skipped ? { layer2_skipped: true as const } : {}),
        };
      }, { compact: true }),
  );

  server.registerTool(
    ADD,
    {
      title: 'Add a daily-words journal entry',
      description: ADD_DESCRIPTION,
      inputSchema: {
        text: textField,
        source_note: sourceNoteField,
        insight: insightField,
        force: z.boolean().optional().describe('Insert even though a duplicate was found. Default false.'),
      },
    },
    async ({ text, source_note, insight, force }) =>
      run(async () => {
        const userId = await resolveDwordUserId(connector, emailOf());
        const check = await findSimilarJournalEntries(connector, userId, text, embedder);

        if (check.verdict === 'duplicate' && force !== true) {
          return {
            verdict: 'duplicate' as const,
            inserted: false,
            entries: check.entries,
            ...(check.layer2Skipped ? { layer2_skipped: true as const } : {}),
          };
        }

        const sourceNote = source_note !== undefined && source_note.length > 0 ? source_note : null;
        // NewJournalEntry has no userId field (the writer resolves it itself, fresh, against its
        // own connection) — see the Interface Contract's Requires (from Phase 2, actual).
        const insertedRow = await writer.insertJournalEntry({ text, sourceNote, insight });

        let embedded = false;
        if (check.sibling.status === 'ready' && check.sibling.model !== undefined && check.sibling.embedding !== undefined) {
          try {
            await writer.insertJournalEmbedding({
              entryId: insertedRow.id,
              textSha: check.sibling.textSha,
              normSha: check.sibling.normSha,
              model: check.sibling.model,
              embedding: check.sibling.embedding,
            });
            embedded = true;
          } catch {
            // Best-effort, same as dword's own route: the entry is already saved and shown;
            // dword's own backfill (selectPendingForBackfill) picks this entry up later.
            embedded = false;
          }
        }

        return {
          verdict: check.verdict,
          inserted: true,
          entries: check.verdict === 'duplicate' ? check.entries : [],
          entry: {
            id: insertedRow.id,
            text: insertedRow.text,
            source_note: insertedRow.sourceNote,
            insight: insertedRow.insight,
            insight_status: insertedRow.insightStatus,
            created_at: insertedRow.createdAt,
          },
          embedded,
          ...(check.layer2Skipped ? { layer2_skipped: true as const } : {}),
        };
      }),
  );
}

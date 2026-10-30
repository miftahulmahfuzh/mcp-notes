import type { Lexicon } from '../../helpers/fakeEmbedder.js';

/**
 * A small labelled set for tuning and checking hybrid search (src/search/blend.ts).
 *
 * Integration tests (tests/integration/search.hybrid.int.test.ts) embed it with the
 * concept-bag fake embedder and SEMANTIC_LEXICON; phase 6's live test embeds the same notes
 * and queries with openai/text-embedding-3-small. Keys are stable names; tests map them to
 * the generated note ids. ageDays backdates created_at/updated_at so recency is realistic.
 */
export interface LabelledNote {
  key: string;
  body: string;
  ageDays?: number;
}

export interface LabelledQuery {
  query: string;
  /** Keys of the notes that answer the query. */
  relevant: readonly string[];
  /** One of the brief's usage examples: its best relevant note must rank first in hybrid. */
  usage?: boolean;
  why: string;
}

export const LABELLED_NOTES: ReadonlyArray<LabelledNote> = [
  { key: 'arango-vault', body: 'arango root password is in the vault #infra', ageDays: 420 },
  { key: 'arango-backup', body: 'ArangoDB nightly backup goes out at 02:00 via arangodump to the NAS #infra', ageDays: 15 },
  { key: 'vault-unseal', body: 'vault unseal keys are split between the two yubikeys #infra', ageDays: 60 },
  { key: 'k8s-secret', body: 'rotate the postgres password secret in k8s after offboarding #infra', ageDays: 5 },
  { key: 'ssh-key', body: 'ssh key for the build box lives in ~/.ssh/id_ed25519, passphrase in bitwarden #infra', ageDays: 120 },
  { key: 'login-sleep', body: 'the login broke after the laptop slept; logging out and back in fixed it', ageDays: 200 },
  { key: 'wifi-resume', body: 'wifi drops after resume from suspend on the GPD, fixed by reloading the driver #gpd', ageDays: 3 },
  { key: 'resume-docker', body: 'docker loses its network after the laptop wakes up; fixed with wsl --shutdown #wsl', ageDays: 40 },
  {
    key: 'seer-incident',
    body: 'postmortem: seer order router double-submitted orders after the broker timeout; fix was an idempotency key #seer',
    ageDays: 300,
  },
  {
    key: 'neon-outage',
    body: 'Neon outage took notesd down for an hour; workaround: retry with backoff and keep the pooled url #notes',
    ageDays: 30,
  },
  { key: 'pgx-pool', body: 'pgx connection pool tuning for seer: MaxConns 20 and a 5s acquire timeout #seer', ageDays: 10 },
  { key: 'db-pool', body: 'notesd connection pool: neon pooled url with max 10 clients #notes', ageDays: 2 },
  {
    key: 'sleep-tired',
    body: 'sleep has been bad all week, exhausted on every run; coach says drop the intervals #running',
    ageDays: 7,
  },
  { key: 'run-pr', body: 'new 10k PR 52:10, negative split #running', ageDays: 1 },
  { key: 'groceries', body: 'buy oat milk, eggs and coffee beans', ageDays: 0 },
  { key: 'react-memo', body: 'useMemo did nothing because the deps array changed every render #web', ageDays: 20 },
];

export const LABELLED_QUERIES: ReadonlyArray<LabelledQuery> = [
  {
    query: 'ArangoDB credentials',
    relevant: ['arango-vault'],
    usage: true,
    why: 'brief usage example: no word in common with "arango root password is in the vault"',
  },
  {
    query: 'have we seen auth failures after resume before?',
    relevant: ['login-sleep'],
    usage: true,
    why: 'brief usage example: login/auth, broke/failures, slept/resume',
  },
  {
    query: 'have we met this kind of accidents before? maybe we already have a solution for this',
    relevant: ['seer-incident', 'neon-outage'],
    usage: true,
    why: 'brief usage example: incident notes that record a fix or workaround',
  },
  {
    query: 'anything in my notes about sleep and tiredness?',
    relevant: ['sleep-tired'],
    why: 'chat-bar acceptance question',
  },
  { query: 'where is the ssh passphrase', relevant: ['ssh-key'], why: 'meaning query; "where" defeats the full-text AND' },
  { query: 'pgx pool', relevant: ['pgx-pool'], why: 'literal query: hybrid must keep the word match first' },
  {
    query: 'connection problems after waking the laptop',
    relevant: ['wifi-resume', 'resume-docker'],
    why: 'two paraphrased answers, neither sharing the query wording',
  },
  { query: 'database password rotation', relevant: ['k8s-secret'], why: 'postgres/database, rotate/rotation' },
  { query: '#running', relevant: ['run-pr', 'sleep-tired'], why: 'tag query: both modes find it' },
  { query: 'backup', relevant: ['arango-backup'], why: 'single literal word' },
];

/**
 * Concept groups for tests/helpers/fakeEmbedder.ts: each group is one axis; `*` is a prefix.
 * A stand-in for the real model's sense of "same meaning", only as rich as this set needs.
 * Exact entries beat prefixes (arangodump is backup, not arango).
 */
export const SEMANTIC_LEXICON: Lexicon = [
  ['arango*'],
  ['credential*', 'password*', 'passphrase*', 'secret*', 'vault*', 'bitwarden', 'keys'],
  ['auth*', 'login*', 'logging', 'logon', 'signin'],
  ['fail*', 'broke', 'broken', 'drops', 'dies', 'error*', 'problem*', 'timeout*', 'loses'],
  ['resume*', 'suspend*', 'slept', 'wake*', 'waking', 'woke', 'hibernat*'],
  ['accident*', 'incident*', 'postmortem*', 'outage*'],
  ['solution*', 'fix', 'fixed', 'fixes', 'workaround*', 'resolved'],
  ['sleep', 'sleeping', 'tired*', 'exhaust*', 'fatigue*', 'insomnia'],
  ['run', 'runs', 'running', 'interval*', '10k', 'pace'],
  ['network*', 'connection*', 'wifi', 'internet', 'reconnect*'],
  ['database*', 'postgres*', 'neon', 'pgx', 'pool', 'pooled', 'db'],
  ['rotate', 'rotation', 'rotating', 'offboarding'],
  ['backup*', 'arangodump', 'dump'],
  ['laptop*', 'gpd', 'lenovo'],
  ['ssh', 'sshd', 'ed25519'],
];

export interface RankingRun {
  /** Result ids (or keys), best first. */
  ranked: readonly string[];
  /** Ids (or keys) that answer the query. */
  relevant: readonly string[];
}

export interface RankingScore {
  /** Mean reciprocal rank of the first relevant result (0 when none is returned). */
  mrr: number;
  /** Mean share of the relevant notes found in the top 3. */
  recallAt3: number;
}

export function evaluateRanking(runs: readonly RankingRun[]): RankingScore {
  if (runs.length === 0) return { mrr: 0, recallAt3: 0 };
  let rr = 0;
  let recall = 0;
  for (const run of runs) {
    const first = run.ranked.findIndex((id) => run.relevant.includes(id));
    rr += first === -1 ? 0 : 1 / (first + 1);
    const top3 = run.ranked.slice(0, 3);
    recall += run.relevant.length === 0 ? 0 : run.relevant.filter((id) => top3.includes(id)).length / run.relevant.length;
  }
  return { mrr: rr / runs.length, recallAt3: recall / runs.length };
}

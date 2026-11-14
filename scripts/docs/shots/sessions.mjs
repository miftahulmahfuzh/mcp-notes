// Pictures for docs/guide/sessions.md: the project session graph (/projects).
//
//   node scripts/docs/capture.mjs sessions
//
// Nothing here is billed and nothing leaves the sandbox: the summarizer is off (NOTESD_CLAUDE_BIN
// points nowhere, set below before `verify.sh up` runs), no chat message is sent, and resume and
// "Spawn fresh" are never clicked (they open tmux windows). The graph is a made-up project,
// `tidepool`, written straight into the throwaway database with `verify.sh exec`:
//
//   - a trunk of hand-started sessions, two swarms (analyze- -> orch- -> impl-...-pN), a child
//     linked by the spawn hook, a fork, a guessed (heuristic) swarm and two sessions of another host
//   - one running session (a registry file in the run's own CLAUDE_HOME that names the daemon's pid)
//   - an "unfinished" orchestrator (the run's swarm script, `<run>/no-swarm.py`, is written here as
//     a fake that reports one pending phase for the `offline-cache` slug)
//   - context evidence for a green, an amber and a red session, prompts and replies for the
//     handoff estimate, summaries, commits, costs, and notes made in and linked to sessions
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read by `verify.sh up` through the environment: no Haiku summaries on the fixture sessions.
process.env.NOTESD_CLAUDE_BIN = '/nonexistent/claude';

export const up = ['--sessions'];

const REPO = 'tidepool';
const HOST = os.hostname();
const OTHER_HOST = 'mini';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-4-6';

/** The run's state dir (`$VERIFY_HOME/<run>`), found by the port the instance listens on. */
function runDir(base) {
  const home = process.env.VERIFY_HOME ?? path.join(os.homedir(), '.local/state/notesd-verify');
  const port = new URL(base).port;
  for (const name of readdirSync(home)) {
    const dir = path.join(home, name);
    try {
      if (readFileSync(path.join(dir, 'port'), 'utf8').trim() !== port) continue;
      process.kill(Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim()), 0);
      return dir;
    } catch {
      // not this run, or a run that is already down
    }
  }
  throw new Error(`no live verify run listens on port ${port}`);
}

const sid = (n) => `71de0001-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const ago = (minutes) => `now() - interval '${Math.round(minutes)} minutes'`;
const H = 60;
const D = 24 * 60;

/**
 * One row of cc_sessions. `start` and `end` are minutes ago. `tok` is [input, output, cache read,
 * cache write]. `ctx` is [latest context tokens, peak, first reply's context].
 */
const SESSIONS = [
  // Today: a running session and a fork of it.
  {
    n: 1, node: 'K4-7Q', title: 'Rank station search by distance and popularity', start: 1.4 * H, end: 2, model: OPUS,
    tok: [5210, 148300, 61240000, 2130000], cost: null, ctx: [462000, 462000, 31200], live: true,
    prompts: [
      'station search returns results in insertion order. rank them: distance from the query point first, then how often a station is opened. look at src/stations/search.ts and the stations table before you propose anything',
      'the popularity counter does not exist yet. where would you keep it so a hot station does not write a row on every request?',
      'ok, a daily rollup table. write the migration and the rollup job',
      'the geohash prefix query misses stations just across a cell border. show me a failing test first',
      'fix it with the 8 neighbour cells, keep the index',
      'p95 for "san" went from 40 ms to 310 ms. profile it before changing anything',
      'try the trigram index only on name, keep geohash for distance',
      'run the whole search suite and the load script again',
      'write down what we measured in docs/plans/station-search.md',
    ],
    commits: [['4be19a7', 'feat(stations): daily popularity rollup'], ['c02d5e1', 'fix(stations): search the 8 neighbour geohash cells']],
    plans: ['docs/plans/station-search.md'],
  },
  {
    n: 2, node: '2M-X8', title: 'Try a GiST index on station position instead of geohash', start: 34, end: 9, model: OPUS,
    tok: [820, 21400, 9300000, 310000], cost: null, ctx: [118000, 455000, 452000], parent: 1, src: 'fork', fork: { count: 6, at: 34 },
    prompts: ['before we keep geohash: branch off here and measure a GiST index on a point column for the same three queries', 'same load script, 5 minutes, report p50 and p95 side by side'],
    summary: 'Forked from K4-7Q to compare a GiST index on a point column with the geohash prefix index. GiST was 12% slower on the radius query and no faster on the name query, so the fork stops here and K4-7Q keeps geohash.',
  },

  // Yesterday: the tide-alerts swarm.
  {
    n: 3, node: 'R7-2C', name: 'analyze-tide-alerts', title: 'Tide alerts: analysis and plan set', start: 30 * H, end: 29 * H, model: OPUS,
    tok: [9120, 212400, 48100000, 3920000], cost: 31.84, ctx: [388000, 388000, 34800],
    prompts: [
      '/analyze users want an alert when the tide at a saved station crosses a height they set (push and email). read the tides module and the notification stub, then split the work into phases that can run in parallel',
      'phase 4 should not know about push vs email. move the channel choice behind one interface',
      'good. write the plan set',
    ],
    summary: 'Analysed tide alerts end to end and wrote a six-phase plan set in three waves: schema and threshold rules first, then the scheduler, delivery and settings UI side by side, then integration tests. Decided alerts are evaluated from the precomputed tide table, never from live harmonic fits, so one pass per station per hour is enough.',
    plans: ['.workflows/plan/tide-alerts/index.md', '.workflows/plan/tide-alerts/phase-1.md', '.workflows/plan/tide-alerts/phase-4.md'],
    subagents: 6,
  },
  {
    n: 4, node: 'Q9-D3', name: 'orch-tide-alerts', title: 'Orchestrate the tide-alerts plan set', start: 29 * H - 4, end: 24.4 * H, model: OPUS,
    tok: [6400, 58200, 22700000, 1240000], cost: 9.12, ctx: [214000, 214000, 33900], parent: 3, src: 'env',
    prompts: ['/analyze-orchestrator tide-alerts', 'wave 2 is done except p4. what is it waiting on?', 'land wave 3 and run the full suite on the set branch'],
    summary: 'Ran the tide-alerts plan set in three waves and merged all six phases into the set branch. Phase 4 (delivery) ran twice as long as its wave because the email provider sandbox rate-limited the retries test; the fix was a fake transport. Full suite green, set landed on main.',
    commits: [['9a41c30', 'merge: tide-alerts wave 1'], ['e7f20b8', 'merge: tide-alerts wave 2'], ['51c6d2a', 'merge: tide-alerts wave 3']],
    plans: ['.workflows/plan/tide-alerts/index.md'],
  },
  {
    n: 5, node: 'A0-3G', name: 'impl-tide-alerts-p1', title: 'Phase 1: alert_rules schema and migration', start: 28.8 * H, end: 28.2 * H, model: SONNET,
    tok: [2100, 31800, 7400000, 520000], cost: 3.94, ctx: [88000, 88000, 30100], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 1'],
    summary: 'Added the alert_rules table (station, direction, height in cm, channels, quiet hours) with its migration and repository. One rule per user, station and direction, enforced by a unique index.',
    commits: [['1d8e4f2', 'feat(alerts): alert_rules schema and repository']],
    plans: ['.workflows/plan/tide-alerts/phase-1.md'],
  },
  {
    n: 6, node: '7K-2Q', name: 'impl-tide-alerts-p2', title: 'Phase 2: threshold crossing rules', start: 28.75 * H, end: 27.9 * H, model: SONNET,
    tok: [2480, 44100, 9900000, 610000], cost: 4.71, ctx: [104000, 104000, 30400], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 2'],
    summary: 'Wrote the pure crossing detector: given two consecutive tide heights and a rule, say whether the rule fired. A tide that touches the threshold without crossing it does not fire. Property tests cover rising, falling and flat tides.',
    commits: [['b53a7c9', 'feat(alerts): threshold crossing detector']],
    plans: ['.workflows/plan/tide-alerts/phase-2.md'],
  },
  {
    n: 7, node: '24-ZK', name: 'impl-tide-alerts-p3', title: 'Phase 3: hourly evaluation job', start: 27.8 * H, end: 27.1 * H, model: SONNET,
    tok: [2950, 39700, 8800000, 580000], cost: 4.22, ctx: [97000, 97000, 30900], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 3'],
    summary: 'Added the hourly job that walks every station with at least one rule, reads the next two rows of the tide table and enqueues an alert per fired rule. A station is locked while it is evaluated so two workers never send the same alert.',
    commits: [['6c0b9e4', 'feat(alerts): hourly evaluation job']],
    plans: ['.workflows/plan/tide-alerts/phase-3.md'],
  },
  {
    n: 8, node: 'P3-C4', name: 'impl-tide-alerts-p4', title: 'Phase 4: push and email delivery', start: 27.75 * H, end: 25.6 * H, model: SONNET,
    tok: [5300, 118600, 27400000, 1480000], cost: 12.66, ctx: [171000, 171000, 31000], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 4', 'the retries test hits the real sandbox and gets rate limited. use a fake transport in tests'],
    summary: 'Built delivery behind one Channel interface with push and email transports, retries with backoff and a dead-letter table. Lost an hour to the email sandbox rate limit before the tests moved to a fake transport.',
    commits: [['f1a26d7', 'feat(alerts): Channel interface, push and email transports'], ['08c3e5b', 'test(alerts): fake transport for the retries test']],
    plans: ['.workflows/plan/tide-alerts/phase-4.md'],
    subagents: 2,
  },
  {
    n: 9, node: '9E-E0', name: 'impl-tide-alerts-p5', title: 'Phase 5: alert settings page', start: 27.7 * H, end: 26.8 * H, model: SONNET,
    tok: [3120, 52900, 11200000, 690000], cost: 5.38, ctx: [112000, 112000, 30600], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 5'],
    summary: 'Added the alert settings page: a rule list per saved station, a height slider with the station chart behind it, and quiet hours. The form posts to the routes from phase 1.',
    commits: [['a94d1c6', 'feat(web): alert settings page']],
    plans: ['.workflows/plan/tide-alerts/phase-5.md'],
  },
  {
    n: 10, node: 'W6-1H', name: 'impl-tide-alerts-p6', title: 'Phase 6: integration tests and docs', start: 25.5 * H, end: 24.6 * H, model: SONNET,
    tok: [2710, 47300, 10500000, 640000], cost: 4.97, ctx: [109000, 109000, 30800], parent: 4, src: 'env',
    prompts: ['/implement tide-alerts phase 6'],
    summary: 'Integration tests drive a rule from the settings route through the hourly job to the fake transport, including quiet hours and a retried send. README gained an Alerts section.',
    commits: [['3e7b0a5', 'test(alerts): rule to delivery integration tests'], ['d26f8c1', 'docs: alerts']],
    plans: ['.workflows/plan/tide-alerts/phase-6.md'],
  },

  // Three days ago: a long debugging session, nearly out of context, with a hook-linked child.
  {
    n: 11, node: 'B3-W5', title: 'Why is the tide chart one hour off during DST?', start: 3 * D + 5 * H, end: 3 * D + 0.6 * H, model: SONNET,
    tok: [7400, 96200, 41800000, 1960000], cost: null, ctx: [156400, 163200, 29700], long: 34,
    prompts: [
      'the tide chart for Port Aransas is one hour late since the clocks changed. find out where the hour goes',
      'the API returns UTC. so it is the chart. show me what the chart does with the timestamps',
      'no, the labels are right, the curve is shifted. look at the harmonic fit',
      'the constituents file has phases in local standard time. who converts them?',
      'write a test with a station in a zone that has DST and one that does not',
      'the test passes for Honolulu and fails for Port Aransas. good. now fix the conversion, not the chart',
      'the fit is slow now. start a second session to benchmark it, I will keep going here',
      'compare our prediction with the published table for 14 March',
    ],
    summary: 'The chart was right and the tide table was wrong: constituent phases are published in local standard time, and the fit converted them with the zone\'s current offset, so every prediction moved by an hour once DST began. Fixed by converting with the standard offset only. Predictions now match the published table within 2 cm. Notes: the measurements are in the linked notes.',
    commits: [['72c9d0e', 'fix(tides): convert constituent phases with the standard offset'], ['be4410f', 'test(tides): DST and non-DST stations against published tables']],
    plans: ['docs/plans/harmonic-fit.md'],
  },
  {
    n: 12, node: 'H1-9P', name: 'bench-harmonic-fit', title: 'Benchmark the harmonic fit', start: 3 * D + 2.2 * H, end: 3 * D + 1.5 * H, model: SONNET,
    tok: [1640, 18900, 4100000, 290000], cost: 1.87, ctx: [61000, 61000, 29900], parent: 11, src: 'hook',
    prompts: ['benchmark predictTides for one station over 30 days, before and after commit 72c9d0e. hyperfine, 20 runs each'],
    summary: 'The fix made the fit 3% slower (41.2 ms to 42.5 ms for 30 days of one station), inside the noise. The slowdown seen in the parent session came from the test runner starting cold.',
  },

  // Four days ago: a swarm that stopped after wave 1.
  {
    n: 13, node: 'E5-L2', name: 'analyze-offline-cache', title: 'Offline cache: analysis and plan set', start: 4 * D + 6 * H, end: 4 * D + 5.2 * H, model: OPUS,
    tok: [7300, 164000, 35200000, 2870000], cost: 23.1, ctx: [301000, 301000, 34100],
    prompts: ['/analyze the mobile web app should show the last fetched tide table when there is no signal. plan a service worker cache with a 7 day horizon per saved station'],
    summary: 'Planned the offline cache as five phases in three waves: cache schema and the fetch wrapper, then the service worker and the stale banner, then eviction. Open question left in the plan: whether to cache chart tiles or redraw from the table.',
    plans: ['.workflows/plan/offline-cache/index.md'],
  },
  {
    n: 14, node: 'U8-4N', name: 'orch-offline-cache', title: 'Orchestrate the offline-cache plan set', start: 4 * D + 5.1 * H, end: 4 * D + 3.6 * H, model: OPUS,
    tok: [3100, 21700, 8600000, 540000], cost: 3.52, ctx: [96000, 96000, 33700], parent: 13, src: 'env', orch: true,
    prompts: ['/analyze-orchestrator offline-cache'],
    summary: 'Spawned wave 1 of offline-cache and merged both phases. Stopped before wave 2: the laptop went to sleep and the session was not resumed. Phases 3 to 5 are still pending in the ledger.',
    commits: [['c8815fa', 'merge: offline-cache wave 1']],
    plans: ['.workflows/plan/offline-cache/index.md'],
  },
  {
    n: 15, node: 'N2-8V', name: 'impl-offline-cache-p1', title: 'Phase 1: cache schema in IndexedDB', start: 4 * D + 5 * H, end: 4 * D + 4.3 * H, model: SONNET,
    tok: [2200, 33400, 7900000, 510000], cost: 3.81, ctx: [91000, 91000, 30200], parent: 14, src: 'env',
    prompts: ['/implement offline-cache phase 1'],
    summary: 'Added the IndexedDB store for tide tables keyed by station and day, with a version field so a later schema change can drop old entries.',
    commits: [['5fa02b3', 'feat(web): IndexedDB store for tide tables']],
  },
  {
    n: 16, node: 'J6-0T', name: 'impl-offline-cache-p2', title: 'Phase 2: fetch wrapper with cache fallback', start: 4 * D + 4.95 * H, end: 4 * D + 3.9 * H, model: SONNET,
    tok: [2600, 41200, 9200000, 560000], cost: 4.4, ctx: [99000, 99000, 30500], parent: 14, src: 'env',
    prompts: ['/implement offline-cache phase 2'],
    summary: 'Wrapped the tide fetch: network first, cache on failure, and the response says which one answered so the page can show the stale banner.',
    commits: [['e19c7d4', 'feat(web): fetch wrapper with cache fallback']],
  },

  // Five days ago: sessions run on the other machine.
  {
    n: 17, node: 'Z2-6F', title: 'Draft the NOAA station importer', start: 5 * D + 4 * H, end: 5 * D + 2.5 * H, model: OPUS, host: OTHER_HOST,
    tok: [4100, 71200, 16400000, 980000], cost: 8.9, ctx: [143000, 143000, 32800],
    prompts: ['write an importer for the NOAA station list: id, name, lat, lon, time zone, datum. idempotent, keyed by station id', 'stations without a datum should be skipped and counted, not fail the run'],
    summary: 'Wrote the NOAA station importer as an idempotent upsert keyed by station id. 3,214 stations imported, 61 skipped for a missing datum and listed in the run report.',
    commits: [['0b7de92', 'feat(stations): NOAA station importer']],
  },
  {
    n: 18, node: 'G5-3Y', title: 'Importer: handle renamed stations', start: 5 * D + 1.8 * H, end: 5 * D + 1.1 * H, model: SONNET, host: OTHER_HOST,
    tok: [1500, 20300, 5100000, 330000], cost: 2.2, ctx: [72000, 72000, 30000],
    prompts: ['a station that was renamed upstream shows up twice. match on id only and update the name'],
    summary: 'Renamed stations no longer duplicate: the upsert matches on station id alone and keeps the previous name in a history column.',
    commits: [['97a3c1e', 'fix(stations): match renamed stations by id']],
  },

  // Six days ago: a swarm from before the hooks, linked by reading transcripts.
  {
    n: 19, node: 'L8-5M', name: 'orch-csv-export', title: 'Orchestrate the csv-export plan set', start: 6 * D + 3 * H, end: 6 * D + 1.2 * H, model: OPUS,
    tok: [2800, 19600, 7700000, 480000], cost: 3.05, ctx: [84000, 84000, 33200],
    prompts: ['run the csv-export plan: one session per phase'],
    summary: 'Ran the two csv-export phases side by side and merged them. Export streams rows, so a year of one station stays under 20 MB of memory.',
    commits: [['2c64f0b', 'merge: csv-export']],
  },
  {
    n: 20, node: 'D7-9S', name: 'impl-csv-export-p1', title: 'Phase 1: streaming CSV writer', start: 6 * D + 2.8 * H, end: 6 * D + 2.1 * H, model: SONNET,
    tok: [1900, 26800, 6200000, 410000], cost: 2.95, ctx: [79000, 79000, 30300], parent: 19, src: 'heuristic',
    prompts: ['/implement csv-export phase 1'],
    summary: 'Streaming CSV writer with a header row, ISO timestamps in UTC and heights in centimetres.',
    commits: [['8d1f3a7', 'feat(export): streaming CSV writer']],
  },
  {
    n: 21, node: 'X4-2B', name: 'impl-csv-export-p2', title: 'Phase 2: export route and download button', start: 6 * D + 2.75 * H, end: 6 * D + 1.7 * H, model: SONNET,
    tok: [2300, 30100, 6900000, 450000], cost: 3.3, ctx: [83000, 83000, 30100], parent: 19, src: 'heuristic',
    prompts: ['/implement csv-export phase 2'],
    summary: 'Added GET /stations/:id/export.csv with a date range and the download button on the station page.',
    commits: [['41be9c5', 'feat(export): export route and download button']],
  },

  // Older trunk.
  {
    n: 22, node: 'C1-7R', title: 'CI: run the tests against a Postgres service container', start: 7 * D + 2 * H, end: 7 * D + 1.3 * H, model: SONNET,
    tok: [1300, 17200, 3900000, 270000], cost: 1.74, ctx: [58000, 58000, 29800],
    prompts: ['set up GitHub Actions: lint, typecheck, unit tests, then integration tests against a postgres service container'],
    summary: 'Added the CI workflow with a Postgres 16 service container. Integration tests run in 2m10s. Caching node_modules by lockfile hash cut the install step from 48 s to 6 s.',
    commits: [['ab30e61', 'ci: lint, typecheck, unit and integration jobs']],
  },
  {
    n: 23, node: 'M9-4D', title: 'Bootstrap tidepool: Hono API, Drizzle, Vitest', start: 8 * D + 5 * H, end: 8 * D + 3.4 * H, model: OPUS,
    tok: [3600, 64800, 14100000, 860000], cost: 7.62, ctx: [131000, 131000, 32500],
    prompts: ['new project: an API that serves tide tables for saved stations. Hono, Drizzle on Postgres, Vitest. set up the skeleton and one health route with a test', 'add the stations and tide_rows tables'],
    summary: 'Set up the project skeleton: Hono API, Drizzle schema with stations and tide_rows, Vitest, and a health route with its test.',
    commits: [['e0d4b17', 'chore: project skeleton'], ['6a92f58', 'feat(db): stations and tide_rows']],
  },
  {
    n: 24, node: 'F3-0J', title: 'Read the harmonic constituents format', start: 8 * D + 1 * H, end: 8 * D + 0.7 * H, model: SONNET,
    tok: [600, 5200, 900000, 110000], cost: null, ctx: [41000, 41000, 29600],
    prompts: ['explain the columns of the NOAA harmonic constituents file, with one station as the example'],
  },
];

/** Two small projects beside it, so the sidebar reads like a machine that is used. */
const OTHER_PROJECTS = [
  { n: 40, node: 'T5-1A', repo: 'harbor-docs', title: 'Restructure the API reference by resource', start: 2 * D, end: 2 * D - 40 },
  { n: 41, node: 'V2-8E', repo: 'harbor-docs', title: 'Fix broken anchors after the rename', start: 9 * D, end: 9 * D - 25 },
  { n: 42, node: 'S6-3U', repo: 'dotfiles', title: 'tmux: one status line for every session', start: 5 * D, end: 5 * D - 30 },
];

const FILLER = 'Checked the next station against the published table and the difference stayed under two centimetres. ';

function sessionRow(s, cwd, claudeHome) {
  const [inTok, outTok, cacheRead, cacheWrite] = s.tok ?? [900, 9000, 2100000, 160000];
  const model = s.model ?? SONNET;
  const [ctxTokens, ctxPeak, ctxFirst] = s.ctx ?? [52000, 52000, 29900];
  const prompts = s.prompts ?? [s.title];
  const total = s.long ?? prompts.length;
  const span = s.start - s.end;
  const at = (i) => new Date(Date.now() - (s.start - (span * i) / Math.max(1, total)) * 60_000).toISOString();
  const commits = (s.commits ?? []).map(([sha, subject], i) => ({ sha, subject, at: at(Math.max(1, total - (s.commits.length - i))) }));
  const host = s.host ?? HOST;
  const cols = {
    session_id: q(sid(s.n)),
    node_id: q(s.node),
    host: q(host),
    repo: q(s.repo ?? REPO),
    cwd: q(s.orch ? cwd : `/home/dev/${s.repo ?? REPO}`),
    branch: q(s.name?.startsWith('impl-') ? s.name.replace('impl-', 'set/') : 'main'),
    name: q(s.name ?? null),
    ai_title: q(s.title),
    first_prompt: q(prompts[0]),
    last_prompt: q(prompts[prompts.length - 1]),
    entrypoint: q('cli'),
    version: q('2.1.311'),
    started_at: ago(s.start),
    last_active_at: ago(s.end),
    input_tokens: inTok,
    output_tokens: outTok,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: s.cost ?? 'null',
    models: `${q(JSON.stringify({ [model]: { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } }))}::jsonb`,
    parent_session_id: q(s.parent ? sid(s.parent) : null),
    parent_link_source: q(s.src ?? null),
    transcript_path: q(path.join(claudeHome, 'projects', `-home-dev-${s.repo ?? REPO}`, `${sid(s.n)}.jsonl`)),
    fork_cut_offset: s.fork ? 184320 : 'null',
    forked_at: s.fork ? ago(s.fork.at) : 'null',
    fork_prompt_count: s.fork ? s.fork.count : 'null',
    fork_detected_by: q(s.fork ? 'uuid' : null),
    context_tokens: ctxTokens,
    context_model: q(model),
    context_at: ago(s.end),
    context_peak_tokens: ctxPeak,
    context_first_tokens: ctxFirst,
    prompts: `${q(JSON.stringify(prompts.map((text, i) => ({ text, at: at(i) }))))}::jsonb`,
    commits: `${q(JSON.stringify(commits))}::jsonb`,
    files_edited: `${q(JSON.stringify((s.commits ?? []).map((_, i) => `src/${['tides', 'alerts', 'stations'][i % 3]}/index.ts`)))}::jsonb`,
    plan_docs: `${q(JSON.stringify(s.plans ?? []))}::jsonb`,
    final_message: q(s.summary ?? null),
    summary: q(s.summary ?? null),
    summary_sha: q(s.summary ? 'seeded' : null),
    summarized_at: s.summary ? ago(Math.max(1, s.end - 16)) : 'null',
    prompts_version: 3,
    replies_version: 1,
  };
  const out = [`insert into cc_sessions (${Object.keys(cols).join(', ')}) values (${Object.values(cols).join(', ')});`];

  // Full prompts and Claude's replies: what the Prompts pop-up and the handoff estimate read.
  for (let i = 0; i < total; i++) {
    const text = prompts[i] ?? `next station: compare our prediction with the published table for station ${8770000 + i * 137}`;
    // A long session's replies are padded in SQL (repeat), so the statement stays small enough for one argv.
    const reply = s.long
      ? `${q(`Station ${8770000 + i * 137} matches. `)} || repeat(${q(FILLER)}, 110)`
      : q(`Done: ${text.slice(0, 80)}. The tests pass and the change is committed.`);
    out.push(`insert into cc_session_prompts (session_id, seq, at, text) values (${q(sid(s.n))}, ${i + 1}, ${q(at(i))}, ${q(text)});`);
    out.push(`insert into cc_session_replies (session_id, seq, at, text) values (${q(sid(s.n))}, ${i + 1}, ${q(at(i + 0.5))}, ${reply});`);
  }
  for (let a = 0; a < (s.subagents ?? 0); a++) {
    const usage = { inputTokens: 400, outputTokens: 6200 + a * 900, cacheReadTokens: 1400000, cacheWriteTokens: 90000 };
    out.push(
      `insert into cc_subagent_transcripts (transcript_path, session_id, agent_id, host, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, models, last_active_at) values (` +
        `${q(path.join(claudeHome, 'projects', `-home-dev-${REPO}`, sid(s.n), 'subagents', `agent-a${a}.jsonl`))}, ${q(sid(s.n))}, ${q(`a${a}`)}, ${q(host)}, ` +
        `${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, ${q(JSON.stringify({ 'claude-haiku-4-5': usage }))}::jsonb, ${ago(s.end)});`,
    );
  }
  return out.join('\n');
}

/** Notes saved from a session (`from`) and notes linked to one afterwards (`link`), by session number. */
const NOTES = [
  { from: 11, body: 'Tide chart was an hour off after DST: constituent phases are in local STANDARD time. Convert with the standard offset, never the current one. Fixed in 72c9d0e. #tidepool #tides' },
  { from: 11, body: 'Port Aransas, 14 March: our high tide 03:42 at 41 cm, published 03:40 at 43 cm. Within 2 cm at every turn after the fix. #tidepool #tides' },
  { link: 11, body: 'NOAA publishes harmonic constituents per station as amplitude and phase; phase is "local" unless the file says GMT. Check the header before trusting a station. #tides #reference' },
  { from: 4, body: 'tide-alerts swarm: phase 4 ran 2h09 while its wave took 55 min. Cause: retries test against the real email sandbox. Next time give delivery its own wave or fake the transport in the plan. #tidepool #swarm' },
  { from: 3, body: 'Decision: alerts are evaluated from the precomputed tide table, once per station per hour. No live harmonic fit in the alert path. #tidepool #decision' },
  { link: 14, body: 'offline-cache is half done: wave 1 merged (c8815fa), phases 3 to 5 never spawned. Open question: cache chart tiles or redraw from the table? #tidepool #todo' },
  { from: 22, body: 'CI: caching node_modules by lockfile hash took the install step from 48 s to 6 s. Postgres service container needs the health check or the first test races it. #ci' },
  { body: 'Surf check Saturday: low tide 06:10, wind turns onshore by 10. Go early. #surf' },
  { body: 'Idea: station page could show the next three turns as plain text above the chart, most people only want "when is high tide". #tidepool #idea' },
  { body: 'Postgres: geohash prefix search needs the 8 neighbour cells or it misses points across a border. #postgres' },
  { body: 'Book list: The Wave by Susan Casey, Tides by Jonathan White. #reading' },
  { body: 'Standup: importer done on the other laptop, 61 stations skipped for a missing datum. Ask whether we care about them. #tidepool #work' },
];

/** `python3 <script> verify --slug <slug>`: one pending phase for offline-cache, no ledger for anything else. */
const FAKE_SWARM = `import json, sys
slug = sys.argv[sys.argv.index('--slug') + 1] if '--slug' in sys.argv else ''
if slug == 'offline-cache':
    print(json.dumps({'swarm': True, 'phases': [{'id': 'p1', 'derived': 'done'}, {'id': 'p2', 'derived': 'done'}, {'id': 'p3', 'derived': 'pending'}]}))
else:
    print(json.dumps({'swarm': False, 'repo': 'tidepool'}))
`;

export async function seed({ v, base, fetchJson }) {
  const dir = runDir(base);
  const claudeHome = path.join(dir, 'claude');
  const checkout = path.join(dir, 'work', REPO);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(dir, 'no-swarm.py'), FAKE_SWARM);

  // Let the fixture transcripts land first, so their ingest and the one-time backfills are over.
  for (let i = 0; i < 60; i++) {
    const projects = await fetchJson('GET', '/api/projects').catch(() => null);
    if (projects?.projects?.some((p) => p.repo === 'mcp-notes')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const rows = [...SESSIONS, ...OTHER_PROJECTS];
  // Parents before children: a child row names its parent.
  for (const s of rows) await v('exec', sessionRow(s, checkout, claudeHome));

  const mcp = async (tool, args) => JSON.parse((await v('mcp', tool, JSON.stringify(args))).split('\n').slice(1).join('\n'));
  for (const note of NOTES) {
    const origin = note.from ? { cwd: `/home/dev/${REPO}`, repo: REPO, claude_session: sid(note.from) } : undefined;
    const made = await mcp('create', { body: note.body, ...(origin ? { origin } : {}) });
    if (note.link) {
      const node = SESSIONS.find((s) => s.n === note.link).node;
      await mcp('link_note', { note_id: made.note.id, node_id: node });
    }
  }
}

/** The runner's window (capture.mjs); two shots use a taller one and put this back. */
const VIEWPORT = { width: 1280, height: 800 };
const nodeOf = (n) => SESSIONS.find((s) => s.n === n).node;

export default async ({ page, base, shot, clip }) => {
  const dir = runDir(base);
  // A running session: Claude Code's registry lists a live pid for it. The daemon's own pid is one.
  const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim());
  const registry = path.join(dir, 'claude', 'sessions', '900001.json');
  writeFileSync(registry, JSON.stringify({ pid, sessionId: sid(1), cwd: `/home/dev/${REPO}`, kind: 'interactive', entrypoint: 'cli', status: 'busy', updatedAt: Date.now() }));

  const graph = (p = page) => p.getByRole('group', { name: 'Session graph' });
  const row = (node, p = page) => p.locator(`g[data-node="${node}"]`);
  const panel = (node, p = page) => p.locator(`aside.np[data-node="${node}"]`);
  const region = (node, name, p = page) => panel(node, p).getByRole('region', { name });
  /** `focus`: the graph's focus mode (Alt+Z), which hides the rail, the sidebar and the header. */
  const open = async (node, { p = page, focus = true } = {}) => {
    await p.goto(`${base}/projects?repo=${REPO}${node ? `&node=${node}` : ''}${focus ? '&focus=1' : ''}`);
    await graph(p).waitFor();
    if (node) await region(node, 'Tokens', p).waitFor();
  };
  /** The panel's Subtree / Context Rot toggle. The choice is stored, so every shot sets its own. */
  const view = (node, name, p = page) => panel(node, p).getByRole('button', { name, exact: true }).click();
  /** Park the pointer where it hovers nothing (no tooltip in the picture), then let transitions end. */
  const settle = async (p = page) => {
    await p.mouse.move(0, 0);
    await p.waitForTimeout(600);
  };
  const expandAll = async (p = page) => {
    await p.getByRole('button', { name: 'Expand all' }).click();
    await row(nodeOf(10), p).waitFor();
  };

  try {
    // 1. The page as it opens: the project list, branches folded into +N chips, the project chat pill.
    await open(null, { focus: false });
    await page.getByRole('list', { name: 'Projects' }).getByText(REPO).waitFor();
    await page.locator('g.gnode.live').first().waitFor();
    await settle();
    await shot('overview');

    // 2. The whole graph, every branch open: two swarms, the unfinished badge, the fork, the other host.
    // A taller, narrower window than the runner's, so all 24 rows fit without the empty right half.
    await page.setViewportSize({ width: 900, height: 1010 });
    await open(null);
    await expandAll();
    await page.getByTestId('unfinished-badge').waitFor();
    await page.getByTestId('fork-badge').waitFor();
    await settle();
    await shot('graph');

    // 3. A node's panel beside the graph: the orchestrator of the finished swarm.
    await page.setViewportSize({ width: 1280, height: 1010 });
    await open(nodeOf(4));
    await expandAll();
    await view(nodeOf(4), 'Tree');
    await panel(nodeOf(4)).getByRole('button', { name: `Open ${nodeOf(10)}` }).waitFor();
    await panel(nodeOf(4)).locator('.np-head').scrollIntoViewIfNeeded();
    await settle();
    await shot('node-panel');
    await page.setViewportSize(VIEWPORT);

    // 4. Its subtree as a timeline: six phases in three waves, one of them long.
    await view(nodeOf(4), 'Timeline');
    await panel(nodeOf(4)).getByRole('group', { name: 'Subtree timeline' }).waitFor();
    await region(nodeOf(4), 'Subtree').scrollIntoViewIfNeeded();
    await settle();
    await shot('timeline', { locator: region(nodeOf(4), 'Subtree') });

    // 5. Notes made in and linked to a session, its tokens and cost.
    await open(nodeOf(11));
    await view(nodeOf(11), 'Tree');
    await panel(nodeOf(11)).getByRole('img', { name: 'Linked note' }).waitFor();
    await region(nodeOf(11), 'Subtree').scrollIntoViewIfNeeded();
    await settle();
    await shot('notes-and-tokens', { locator: panel(nodeOf(11)) });

    // 6. Context Rot, red: a 200k session that would hand over only its newest exchanges.
    await view(nodeOf(11), 'Context Rot');
    await region(nodeOf(11), 'Context Rot').getByRole('meter', { name: 'Fresh session estimate' }).waitFor();
    await region(nodeOf(11), 'Context Rot').scrollIntoViewIfNeeded();
    await settle();
    await shot('context-rot-red', { locator: region(nodeOf(11), 'Context Rot') });

    // 7. Context Rot, amber: the running session on a 1M window.
    await open(nodeOf(1));
    await view(nodeOf(1), 'Context Rot');
    await region(nodeOf(1), 'Context Rot').getByRole('meter', { name: 'Fresh session estimate' }).waitFor();
    await region(nodeOf(1), 'Context Rot').scrollIntoViewIfNeeded();
    await settle();
    await shot('context-rot-amber', { locator: region(nodeOf(1), 'Context Rot') });

    // 8. Every prompt of a session.
    await panel(nodeOf(1)).getByRole('button', { name: 'Expand prompts' }).click();
    await page.getByRole('dialog', { name: `Prompts of ${nodeOf(1)}` }).locator('li.prm-item[data-n="3"]').waitFor();
    await settle();
    await shot('prompts');
    await page.keyboard.press('Escape');

    // 9. A fork: the badge on its row and the parent line in its panel.
    await open(nodeOf(2));
    await view(nodeOf(2), 'Tree');
    await panel(nodeOf(2)).locator('.np-parent').waitFor();
    await region(nodeOf(2), 'Summary').scrollIntoViewIfNeeded();
    await settle();
    await shot('fork');

    /** A clip starts in a new tab with its own storage: pin the panel view it should open on. */
    const startOn = (tab, panelView) =>
      tab.addInitScript((value) => {
        try {
          window.localStorage.setItem('mcp-notes:projects:panel-view', value);
        } catch {
          // without storage the panel opens on Tree
        }
      }, panelView);

    // The one clip: open a swarm's +N chips, open the orchestrator's panel, switch to its timeline.
    await clip('tour', async (tab) => {
      await startOn(tab, 'tree');
      await open(null, { p: tab });
      await tab.waitForTimeout(900);
      await row(nodeOf(3), tab).getByRole('button', { name: /^Show \d+ more sessions$/ }).click();
      await row(nodeOf(4), tab).waitFor();
      await tab.waitForTimeout(900);
      await row(nodeOf(4), tab).getByRole('button', { name: /^Show \d+ more sessions$/ }).click();
      await row(nodeOf(8), tab).waitFor();
      await tab.waitForTimeout(1100);
      await row(nodeOf(4), tab).locator('.gnode-title').click();
      await region(nodeOf(4), 'Tokens', tab).waitFor();
      await tab.waitForTimeout(1500);
      await view(nodeOf(4), 'Timeline', tab);
      await tab.mouse.move(0, 0);
      await panel(nodeOf(4), tab).getByRole('group', { name: 'Subtree timeline' }).scrollIntoViewIfNeeded();
      await tab.waitForTimeout(1700);
    });
  } finally {
    rmSync(registry, { force: true });
  }
};

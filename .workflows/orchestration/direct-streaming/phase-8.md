# Phase 8: `/update-cloud-source`: template reader, registry tools, skill

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R4 — "and /update-cloud-source skills first": the owner points at an aggregator site and the registry gains the providers it lacks, each probed
**Criteria:** R4.1, R4.2
**Depends on:** Phase 2, Phase 7 (and through them 1, 3, 4, 5). Phase 2 is a true edge (reconciler): `loadKnownTitles` reads `claude/streaming/direct/known-titles.json`, which phase 2 creates, and this phase's test loads it.
**Difficulty:** NORMAL
**Package:** `claude/streaming/direct`, `src/directStream`, `src/mcp`

---

## Goal

`/update-cloud-source <site url>` reads an aggregator site's provider templates with plain
requests (the page, the scripts it names, and the Gatsby/webpack chunks they load, within fixed
bounds), inserts into the shared `stream_providers` table only the providers the registry lacks
(matched by normalized template host+path, not only by name), probes each new one against the
known titles through `resolve --only`, records its health on this host, and answers one report
per provider. A site whose templates cannot be read answers with the reason and the registry is
not touched. `direct_stream_sources` lists the registry with this host's health.

## Interface Contract

**Deletes:** none
**Renames:** none

**Creates:**
- `claude/streaming/direct/templates.mjs`: `USER_AGENT`, `LIMITS`, `templateFromParts`,
  `extractTemplates`, `mergeProviders`, `scriptUrls`, `chunkUrls`, `isBotCheck`,
  `readSiteTemplates`, `templatesCommand`.
- CLI command `node claude/streaming/direct/cli.mjs templates <site url>` (in phase 1's `cli.mjs`).
  Prints one JSON object, exit 0 found / 1 not / 2 usage:
  - `{ "ok": true, "site", "scripts_read", "providers": [{ "name", "movie", "tv", "found_in" }], "skipped": [{ "name", "reason" }] }`
    (`movie` holds `{id}`; `tv` holds `{id}`, `{season}`, `{episode}` or is null)
  - `{ "ok": false, "site", "error": "bad_url" | "unreachable" | "bot_check" | "no_templates" | "usage", "detail", "scripts_read" }`
- `src/directStream/updateSource.ts`: `TemplatesAnswerSchema`, `KnownTitle`, `ProbeResult`,
  `AddedProvider`, `UpdateSourceAnswer`, `ProviderRegistry`, `UpdateSourceDeps`, `providerKey`,
  `planInsert`, `toProbeResult`, `loadKnownTitles`, `DEFAULT_KNOWN_TITLES_PATH`, `updateSource`.
- `DirectStreamRepo.insertProviders(rows: NewStreamProvider[], now?: Date): Promise<string[]>` and
  type `NewStreamProvider` (`src/directStream/repo.ts`).
- `DirectStreamService.updateSource(site: string): Promise<UpdateSourceAnswer>` (`src/directStream/service.ts`).
- MCP tools `direct_stream_sources` (read-only, no arguments) and `direct_stream_update_source`
  (`{ site }`), registered by `registerDirectStreamSourceTools` inside phase 7's
  `registerDirectStreamTools` (`src/mcp/directStreamTools.ts`).
- **Reconciler:** `DirectStreamToolDeps` (phase 7's tool deps, `src/mcp/directStreamTools.ts`) gains
  `providers(): Promise<ProviderView[]>` and `updateSource(site: string): Promise<UpdateSourceAnswer>`,
  bound in phase 7's `directStreamToolDeps` to the service; phase 7's test `fakeDeps` gains the two.
- `CLAUDE_CODE_ONLY_TOOL_NAMES = ['direct_stream_update_source']` (`src/chat/status.ts`).
- `claude/skills/update-cloud-source/SKILL.md`.

**Signature changes:**
- `DIRECT_STREAM_TOOL_NAMES` (phase 7: `['direct_stream_find', 'direct_stream_play']`) gains
  `'direct_stream_sources', 'direct_stream_update_source'` at the end. Order of the first two
  unchanged, so phase 7's `const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES` still holds.
- `allowedChatTools()` spreads `DIRECT_STREAM_TOOL_NAMES` minus `CLAUDE_CODE_ONLY_TOOL_NAMES`:
  the chat bar gets `direct_stream_sources`, never `direct_stream_update_source`.

**Requires (from earlier phases):**
- Phase 1: `claude/streaming/direct/cli.mjs` as phase 1's plan writes it (Step 6 of `phase-1.md`):
  `parseArgs(argv)` validates per command in a `switch` and throws `InputError('usage', ...)` for an
  unknown command; `main(argv, io)` reads the providers file for every command but `open`, then
  dispatches with `if (args.command === ...)` branches and prints one JSON object through `print`;
  `resolve` accepts `--only <name>`, `--providers <file>` and `--deadline-s <n>`.
- Phase 2: the known titles in one shared file, `claude/streaming/direct/known-titles.json`
  (created by phase 2, read by its `campaign.mjs`), an array of
  `{ "label": string, "kind": "movie" | "tv", "tmdb_id": number, "season"?: number, "episode"?: number }`:
  Fight Club (`550`), Sinners (`1233413`), Breaking Bad S02E03 (`1396`).
- Phase 3:
  - table `stream_providers` in `src/db/schema.ts` as `streamProviders`, columns (Drizzle
    property names) `name` (primary key, text), `idKind`, `movie`, `tv` (nullable), `browserOnly`,
    `enSubtitle` (nullable), `notes`, `originSite` (nullable; null for the seed), `addedAt`.
  - `DirectStreamRepo` (`src/directStream/repo.ts`), constructed `new DirectStreamRepo(db)`, with
    `providers(): Promise<StreamProviderRow[]>` returning at least `name`, `movie`, `tv`.
  - **seed load (phase 3's rule, settled by the reconciler):** at every start `syncSeed` inserts
    missing seed rows and updates seed rows (`origin_site` null) whose fields changed in the file,
    so phase 2's and phase 6's seed edits reach the table; a row with `origin_site` set (one this
    phase adds) is never touched, and nothing is deleted. This phase needs only the second half.
  - `DirectStreamRunner = (args: string[]) => Promise<unknown>` (`src/directStream/runner.ts`)
    returns the printed JSON also when the CLI exits 1, with a 20-minute timeout
    (`DIRECT_STREAM_TIMEOUT_MS`; the reader stops starting requests at 90 s).
  - `DirectStreamService` holds `private readonly repo: DirectStreamRepo` and
    `private readonly runner: DirectStreamRunner`, and has
    `runResolve(ref: StreamRef, options: { only?: string; deadlineS?: number }): Promise<ResolveOutput>`,
    which writes the table's providers and this host's health to the files `resolve` takes, runs
    it serialized with plays, records the health of every attempt for this host, and returns the
    answer (never throwing for a failed resolve), **without** creating a session and **without**
    phase 5's `recordResolve` hook (phase 3 calls that only from `resolve()` / `play()` /
    `refresh()`). A probe of a new provider never marks a title stale.
  - `DirectStreamService.providers()` returns `ProviderView[]`: the registry with this host's health.
  - types exported from `src/directStream/types.ts`: `StreamRef`
    (`{ kind: 'movie'; tmdbId } | { kind: 'tv'; tmdbId; season; episode }`) and `ResolveOutput`
    (`{ ok: true; source: ResolvedSource; attempts } | { ok: false; source: null; error; detail; attempts }`,
    snake_case; `source` has `provider`, `manifest_kind`, `best_height`, `en_subtitle`, `took_s`, `subtitles`).
  - `.claude/skills/verify-notesd/features/direct-streaming.md` and the `## Direct streaming`
    section of `docs/guide/streaming.md`.
- Phase 7 (as phase 7's plan writes it):
  - `src/mcp/directStreamTools.ts` with `DIRECT_STREAM_OFF` (a string starting `direct_stream_off:`),
    `DirectStreamToolDeps` (`{ library, tmdb, play, freshSource }`), `directStreamToolDeps(appDeps)`
    (null while direct streaming or movies is off), the helpers `ok`, `respond` and the local
    `off()` inside `registerDirectStreamTools(server, deps: Pick<ToolDeps, 'directStream' | 'wallUrl'>)`,
    called from `src/mcp/server.ts`; `ToolDeps.directStream?: DirectStreamToolDeps | null`. There is
    no `requireService` and no `run`: the tools check `deps.directStream` and answer `off()` as
    phase 7's do.
  - `DIRECT_STREAM_TOOL_NAMES` in `src/chat/status.ts`, spread into `allowedChatTools()`, with
    captions; the chat-status test's `DIRECT_STREAM_TOOL_NAMES.slice(0, 2)` check and its
    `DIRECT_STREAM_TOOL_NAMES.length` term; phase 7's caption and allow-list rows in
    `docs/guide/chat.md`; `SKILL_NAMES` in `scripts/install.sh` ending in `direct-stream`; a
    `TOOL_GROUPS` entry in `scripts/docs/reference.ts` matching `direct_stream_` if the generator
    groups tools (else nothing); the `### /direct-stream` subsection under `## Direct streaming`.

**Leaves alone (owned by others):**
- `claude/streaming/direct/providers.seed.json` (phases 1, 2, 6): no entry is changed or added.
- `claude/streaming/direct/{sniff.*,order.mjs,resolve.mjs}` (phase 1), `campaign.mjs` and the
  findings file (phase 2), `playcheck.mjs` (phase 6).
- `src/directStream/{service,repo,runner}.ts` beyond the two methods named above (phase 3);
  health recording (phase 3); verified/stale hooks (phase 5).
- `direct_stream_find`, `direct_stream_play`, `src/chat/prompt.ts`, `src/mcp/instructions.ts`,
  `claude/skills/direct-stream/` (phase 7).
- `web/`, `src/movies/*`, `movie_*` tables (phases 4, 5, 9).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/streaming/direct/templates.mjs` | create | the template reader |
| `claude/streaming/direct/cli.mjs` | modify | `templates <site url>` command, one import, one usage line |
| `src/directStream/updateSource.ts` | create | answer schema, provider key, insert plan, probe loop, known titles |
| `src/directStream/repo.ts` | modify | `NewStreamProvider`, `insertProviders` |
| `src/directStream/service.ts` | modify | `updateSource(site)` with an in-flight guard |
| `src/mcp/directStreamTools.ts` | modify | `direct_stream_sources`, `direct_stream_update_source`; `DirectStreamToolDeps` gains `providers`, `updateSource` |
| `tests/unit/mcp.directStreamTools.test.ts` | modify | phase 7's `fakeDeps` gains `providers` and `updateSource` (reconciler) |
| `src/chat/status.ts` | modify | two names, `CLAUDE_CODE_ONLY_TOOL_NAMES`, allow-list filter, two captions |
| `claude/skills/update-cloud-source/SKILL.md` | create | the skill |
| `scripts/install.sh:39` | modify | `update-cloud-source` appended to `SKILL_NAMES` after phase 7's `direct-stream` (reconciler) |
| `docs/guide/streaming.md` | modify | top table row; `### /update-cloud-source` under `## Direct streaming` |
| `docs/guide/chat.md` | modify | one caption in phase 7's direct-stream caption row; `direct_stream_sources` in phase 7's allow-list row |
| `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | sub-feature and driving lines |
| `tests/unit/scripts/directTemplates.test.ts` | create | the reader over the real fmovies chunk and a fake site |
| `tests/unit/directStream.updateSource.test.ts` | create | provider key, probe result, known titles, schema over the reader's real output |
| `tests/unit/mcp.directStreamSourceTools.test.ts` | create | the two tools with a fake service |
| `tests/unit/chat-status.test.ts` | modify | counts, the chat bar exclusion, captions |
| `tests/integration/directStream.updateSource.int.test.ts` | create | insert once, existing untouched, probes, unreadable site changes nothing |

## Implementation Steps

### Step 1: The template reader
**File:** `claude/streaming/direct/templates.mjs` (new)
**Change:** A plain-request reader. It fetches the given page with an honest user agent (not a
browser's: a site that refuses a plain client answers `bot_check` or `unreachable`, it is never
disguised past), scans the page and every script for provider entries, follows `<script src>`,
script preloads, webpack runtime chunk maps and hashed chunk names on the site's own host only
(adverts and analytics on other hosts are never fetched), reads likely chunks first
(`movie|detail|watch|player|embed|server|stream|tv|series|episode`), and stops at 40 scripts,
4 MB per script, 30 MB in all, 20 s per request and 90 s overall. Film templates have one
id variable; episode templates have three (id, season, episode, in source order); both are
merged by name. A name with only an episode template is skipped (`no_film_template`); a
one-variable series page, an IMDb-keyed address (`tt${id}`), an image or a non-https address is
not a template; a key such as `src` or `href` is an attribute, not a provider.

The Chrome-frames strategy of the brief (read the frames a site's server buttons load) is **not
built**: it needs, per site, a title page with a known TMDB id, the selector of its server
buttons, real clicks on an advert-laden page in the streaming Chrome, and a way to turn each
embed address back into a template; none of that can be tested without the live site, and it
would be a second sniffer beside phase 1's. Every failure answer says so in `detail`. Measured
2026-11-15 while planning: this reader, run once against `https://ww6-fmovies.com/`, answered
`ok: true` with all 24 providers, each with a film **and** an episode template, in 40 scripts.

**Code:**
```js
// Reads an aggregator site's provider templates with plain requests, no browser: the site's page,
// the scripts it names, and the webpack/Gatsby chunks those scripts load, up to fixed bounds. A
// provider template is an object entry whose value builds an https address around one id
// variable (a film) or three (an episode: id, season, episode, in that order), keyed by the
// provider's name. Prints what it found; the daemon decides what is new
// (src/directStream/updateSource.ts).
//
// Reading the frames a site's server buttons load through the streaming Chrome (the brief's
// second way) is not built: a site whose scripts hold no readable template answers no_templates.

/** Sent as is: this is a plain request, not a browser, and it does not pretend to be one. */
export const USER_AGENT = 'notesd-update-cloud-source (plain request; reads public scripts)';

export const LIMITS = Object.freeze({
  /** Scripts read after the page itself. */
  maxScripts: 40,
  /** One answer is cut here; a Gatsby app bundle is about 1 MB. */
  maxScriptBytes: 4_000_000,
  maxTotalBytes: 30_000_000,
  fetchTimeoutMs: 20_000,
  /** The whole read stops starting new requests after this. */
  deadlineMs: 90_000,
});

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const KEY = String.raw`(?:(?<k1>[A-Za-z_$][\w$]*)|"(?<k2>[^"\\\n]{1,60})"|'(?<k3>[^'\\\n]{1,60})')`;
// An object entry: preceded by `{` or `,`, so `a ? b : c` and `case x:` never count.
const ENTRY_HEAD = String.raw`(?<=[{,]\s*)${KEY}\s*:\s*`;
const TEMPLATE_ENTRY = new RegExp(String.raw`${ENTRY_HEAD}\x60(?<body>https:\/\/[^\x60]{1,500})\x60`, 'g');
const CONCAT_ENTRY = new RegExp(
  String.raw`${ENTRY_HEAD}(?<q>["'])(?<head>https:\/\/[^"'\n\\]{1,500})\k<q>(?<tail>(?:\s*\+\s*(?:[A-Za-z_$][\w$]*|"[^"\n\\]{0,300}"|'[^'\n\\]{0,300}'))+)`,
  'g',
);
/** Keys that name an attribute, not a provider (a poster's `src`, a link's `href`). */
const GENERIC_KEYS = new Set(['src', 'href', 'url', 'link', 'poster', 'image', 'img', 'backdrop', 'logo', 'icon', 'action', 'canonical', 'background', 'thumbnail', 'avatar']);
/** A one-variable address that points at a series' page, not a film. */
const SHOW_PAGE = /\/(?:tv|series|show)(?:\/|$)|[?&]type=(?:tv|series)\b/i;
/** Chunk names worth reading first: where a site keeps its player servers. */
const LIKELY_CHUNK = /movie|detail|watch|player|embed|server|stream|tv|series|episode/i;

/** A template literal's body as text and variables; null when an expression is not a bare name. */
function partsFromTemplate(body) {
  const parts = [];
  let last = 0;
  for (const m of body.matchAll(/\$\{([^{}]*)\}/g)) {
    parts.push({ text: body.slice(last, m.index) });
    const expr = m[1].trim();
    if (!IDENT_RE.test(expr)) return null;
    parts.push({ variable: expr });
    last = m.index + m[0].length;
  }
  parts.push({ text: body.slice(last) });
  return parts.some((p) => 'text' in p && p.text.includes('${')) ? null : parts;
}

/** `"https://a/" + e + "?x=1"` as text and variables; null when the tail is anything else. */
function partsFromConcat(head, tail) {
  const parts = [{ text: head }];
  const part = /\s*\+\s*(?:(?<id>[A-Za-z_$][\w$]*)|"(?<dq>[^"\n\\]*)"|'(?<sq>[^'\n\\]*)')/y;
  while (part.lastIndex < tail.length) {
    const m = part.exec(tail);
    if (m === null) return null;
    parts.push(m.groups.id !== undefined ? { variable: m.groups.id } : { text: m.groups.dq ?? m.groups.sq ?? '' });
  }
  return parts;
}

/**
 * Text and variables -> `{ kind, url }` with `{id}` (and `{season}`, `{episode}`) in the
 * registry's form, or null when it is not a provider address.
 */
export function templateFromParts(parts) {
  const variables = [...new Set(parts.filter((p) => 'variable' in p).map((p) => p.variable))];
  let names;
  if (variables.length === 1) names = { [variables[0]]: '{id}' };
  else if (variables.length === 3) names = { [variables[0]]: '{id}', [variables[1]]: '{season}', [variables[2]]: '{episode}' };
  else return null;
  const url = parts.map((p) => ('variable' in p ? names[p.variable] : p.text)).join('');
  const kind = variables.length === 3 ? 'tv' : SHOW_PAGE.test(url) ? null : 'movie';
  // An IMDb-keyed address (`tt${id}`) cannot take the TMDB id the registry holds.
  if (kind === null || /tt\{id\}/.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url.replace('{id}', '550').replace('{season}', '1').replace('{episode}', '1'));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || /\.(?:png|jpe?g|webp|gif|svg|avif|ico|css|js)$/i.test(parsed.pathname)) return null;
  return { kind, url };
}

/** Every provider template in one script, in source order: `{ name, kind, url, found_in }`. */
export function extractTemplates(source, foundIn = null) {
  const entries = [];
  const take = (m, parts) => {
    const name = (m.groups.k1 ?? m.groups.k2 ?? m.groups.k3 ?? '').trim();
    if (name === '' || GENERIC_KEYS.has(name.toLowerCase()) || parts === null) return;
    const template = templateFromParts(parts);
    if (template !== null) entries.push({ name, ...template, at: m.index, found_in: foundIn });
  };
  for (const m of source.matchAll(TEMPLATE_ENTRY)) take(m, partsFromTemplate(m.groups.body));
  for (const m of source.matchAll(CONCAT_ENTRY)) take(m, partsFromConcat(m.groups.head, m.groups.tail));
  return entries.sort((a, b) => a.at - b.at).map(({ at, ...entry }) => entry);
}

/**
 * Film and episode entries -> one provider per name, in first-seen order. The first film
 * template of a name wins; a name with only an episode template is skipped (the registry needs
 * a film template).
 */
export function mergeProviders(entries) {
  const byName = new Map();
  for (const e of entries) {
    const p = byName.get(e.name) ?? { name: e.name, movie: null, tv: null, found_in: e.found_in };
    if (e.kind === 'movie' && p.movie === null) {
      p.movie = e.url;
      p.found_in = e.found_in;
    }
    if (e.kind === 'tv' && p.tv === null) p.tv = e.url;
    byName.set(e.name, p);
  }
  const providers = [];
  const skipped = [];
  for (const p of byName.values()) {
    if (p.movie === null) skipped.push({ name: p.name, reason: 'no_film_template' });
    else providers.push(p);
  }
  return { providers, skipped };
}

/** The script addresses a page names: `<script src>`, and `<link>` preloads of scripts. */
export function scriptUrls(html, pageUrl) {
  const found = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) found.push(m[2]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bas\s*=\s*["']?script\b/i.test(tag) && !/\brel\s*=\s*["']?modulepreload\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    if (href) found.push(href[2]);
  }
  return absolute(found, pageUrl);
}

/**
 * The chunks a webpack runtime can load: its `{id: "name"}` and `{id: "<hex hash>"}` maps
 * become `<public path><name or id>-<hash>.js` (Gatsby's naming), plus every hashed script
 * file name the text mentions (Gatsby's inline `___chunkMapping`), taken from the site root.
 */
export function chunkUrls(source, scriptUrl) {
  const names = new Map();
  const hashes = new Map();
  for (const m of source.matchAll(/\{\s*(\d+\s*:\s*"[^"\n]*"(?:\s*,\s*\d+\s*:\s*"[^"\n]*")*)\s*\}/g)) {
    const pairs = [...m[1].matchAll(/(\d+)\s*:\s*"([^"\n]*)"/g)].map((p) => [p[1], p[2]]);
    const target = pairs.every(([, v]) => /^[0-9a-f]{8,}$/.test(v)) ? hashes : names;
    for (const [id, value] of pairs) if (!target.has(id)) target.set(id, value);
  }
  const found = [];
  if (hashes.size > 0) {
    const publicPath = /\.p\s*=\s*"([^"\n]*)"/.exec(source)?.[1] ?? '/';
    for (const [id, hash] of hashes) found.push(`${publicPath}${names.get(id) ?? id}-${hash}.js`);
  }
  for (const m of source.matchAll(/(?<![\w-])([A-Za-z0-9_-]+-[0-9a-f]{16,24}\.js)(?![\w.])/g)) found.push(`/${m[1]}`);
  return absolute(found, scriptUrl);
}

function absolute(paths, base) {
  const out = [];
  for (const p of paths) {
    try {
      const url = new URL(p, base);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.href);
    } catch {
      // not an address
    }
  }
  return [...new Set(out)];
}

/** The site's own host or one under it; adverts and analytics on other hosts are never read. */
function onSite(url, page) {
  const root = page.hostname.replace(/^www\./, '');
  const host = new URL(url).hostname;
  return host === root || host.endsWith(`.${root}`);
}

/** A Cloudflare-style challenge page instead of the content. */
export function isBotCheck(answer) {
  if (answer.headers?.get?.('cf-mitigated') === 'challenge') return true;
  const head = answer.text.slice(0, 20_000);
  return /<title>\s*(?:Just a moment|Attention Required|Checking your browser)/i.test(head) || /_cf_chl_opt|challenge-platform/.test(head);
}

async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

async function get(fetchImpl, url, limits) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });
    return { status: res.status, headers: res.headers, text: await readCapped(res, limits.maxScriptBytes) };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

const NOT_BUILT = 'Reading the frames its server buttons load through the streaming Chrome is not built.';

/**
 * Reads one site. Answers `{ ok: true, site, scripts_read, providers, skipped }` or
 * `{ ok: false, site, error, detail, scripts_read }` with error `bad_url`, `unreachable`,
 * `bot_check` or `no_templates`.
 */
export async function readSiteTemplates(siteUrl, { fetch: fetchImpl = globalThis.fetch, limits = LIMITS, now = Date.now } = {}) {
  let page;
  try {
    page = new URL(siteUrl);
  } catch {
    return { ok: false, site: String(siteUrl), error: 'bad_url', detail: `not an address: ${siteUrl}`, scripts_read: 0 };
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') {
    return { ok: false, site: page.href, error: 'bad_url', detail: 'only an http or https address can be read', scripts_read: 0 };
  }
  const site = page.href;
  const started = now();
  const home = await get(fetchImpl, site, limits);
  if (home.error !== undefined) return { ok: false, site, error: 'unreachable', detail: home.error, scripts_read: 0 };
  if (isBotCheck(home)) {
    return { ok: false, site, error: 'bot_check', detail: `the page answered HTTP ${home.status} with a bot check. ${NOT_BUILT}`, scripts_read: 0 };
  }
  if (home.status >= 400) return { ok: false, site, error: 'unreachable', detail: `the page answered HTTP ${home.status}`, scripts_read: 0 };

  const entries = extractTemplates(home.text, site);
  const queue = [];
  const seen = new Set();
  const enqueue = (urls) => {
    const fresh = [...new Set(urls)].filter((u) => !seen.has(u) && onSite(u, page));
    for (const u of fresh) seen.add(u);
    queue.unshift(...fresh.filter((u) => LIKELY_CHUNK.test(new URL(u).pathname)));
    queue.push(...fresh.filter((u) => !LIKELY_CHUNK.test(new URL(u).pathname)));
  };
  enqueue([...scriptUrls(home.text, site), ...chunkUrls(home.text, site)]);

  let read = 0;
  let bytes = 0;
  let challenged = 0;
  while (queue.length > 0 && read < limits.maxScripts && bytes < limits.maxTotalBytes && now() - started < limits.deadlineMs) {
    const url = queue.shift();
    const answer = await get(fetchImpl, url, limits);
    if (answer.error !== undefined) continue;
    if (isBotCheck(answer)) {
      challenged += 1;
      continue;
    }
    if (answer.status >= 400) continue;
    read += 1;
    bytes += answer.text.length;
    entries.push(...extractTemplates(answer.text, url));
    enqueue(chunkUrls(answer.text, url));
  }

  const { providers, skipped } = mergeProviders(entries);
  if (providers.length > 0) return { ok: true, site, scripts_read: read, providers, skipped };
  if (read === 0 && challenged > 0) {
    return { ok: false, site, error: 'bot_check', detail: `every script answered with a bot check. ${NOT_BUILT}`, scripts_read: 0 };
  }
  return {
    ok: false,
    site,
    error: 'no_templates',
    detail: `read the page and ${read} scripts (${Math.round(bytes / 1024)} kB) and found no provider template. ${NOT_BUILT}`,
    scripts_read: read,
  };
}

/** `cli.mjs templates <site url>`: the answer to print and the exit code (0 found, 1 not, 2 usage). */
export async function templatesCommand(argv, options = {}) {
  const site = argv[0];
  if (site === undefined || site.trim() === '') {
    return { code: 2, answer: { ok: false, site: null, error: 'usage', detail: 'usage: templates <site url>', scripts_read: 0 } };
  }
  const answer = await readSiteTemplates(site.trim(), options);
  return { code: answer.ok ? 0 : 1, answer };
}
```
**Impact:** new file; nothing imports it until Step 2. The code above was run while planning
against the fmovies chunk (24 entries, image `src` templates excluded) and against the live site.

### Step 2: `templates` in the direct CLI
**File:** `claude/streaming/direct/cli.mjs` (phase 1's file, as `phase-1.md` Step 6 writes it):
the import block, the usage comment, `USAGE`, `parseArgs`'s `switch` and `main`.
**Change:** Five insertions, quoted against phase 1's code; nothing else in the file changes.
`templates` must get through `parseArgs` (which answers `usage` for an unknown command) and must
not read the providers file in `main`.
**Code:**

Import, after phase 1's `import { sniffEmbed } from './sniff.mjs';`:
```js
import { templatesCommand } from './templates.mjs';
```
Usage comment, after phase 1's `//   cli.mjs open <http://localhost:<port>/...> [--fullscreen]` line:
```js
//   cli.mjs templates <site url>   read a site's provider templates (plain requests, no browser)
```
`USAGE`: append ` | templates <site url>` before its closing quote (after `... [--fullscreen]`).

`parseArgs`: phase 1's `switch (command)` ends with `case 'open': { ... }` and then
`default: throw new InputError('usage', ...)`. Insert before the `default:`:
```js
    case 'templates':
      allow([]);
      // templatesCommand checks the address itself (usage, bad_url) and answers in its own shape.
      return { command, rest };
```
`main`: phase 1's try block reads the providers file with
`if (args.command !== 'open') {`; make it
`if (args.command !== 'open' && args.command !== 'templates') {`. Then, before phase 1's
`if (args.command === 'providers') {` branch:
```js
  if (args.command === 'templates') {
    const { code, answer } = await templatesCommand(args.rest);
    print(answer);
    return code;
  }
```
(`print` is phase 1's one-JSON-object printer from `io`.)
**Test:** in `tests/unit/scripts/directTemplates.test.ts` (Step 3), the `templatesCommand` cases
run through the module; add one case through phase 1's `main` so the dispatch is covered:
```ts
  it('is reachable through the direct CLI without a providers file', async () => {
    const printed: unknown[] = [];
    const code = await main(['templates'], { print: (v: unknown) => printed.push(v), readText: () => { throw new Error('read'); } });
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ ok: false, error: 'usage' });
  });
```
with `import { main } from '../../../claude/streaming/direct/cli.mjs';` (a `// @ts-expect-error` line
above it, as for `templates.mjs`, if the test file needs one).
**Impact:** `node claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/` works.
Phase 1's other commands are unchanged (phase 1's "refuses bad input" test still sees
`['providers', '--only', 'x']` and `[]` answer `usage`).

### Step 3: Reader tests
**File:** `tests/unit/scripts/directTemplates.test.ts` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script without type declarations
import { LIMITS, USER_AGENT, extractTemplates, mergeProviders, readSiteTemplates, templatesCommand } from '../../../claude/streaming/direct/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHUNK = readFileSync(path.join(ROOT, 'docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js'), 'utf8');

/** The 24 servers of ww6-fmovies.com's movie-details chunk, as the analysis lists them. */
const FMOVIES: Array<[string, string]> = [
  ['VidNest', 'https://vidnest.fun/movie/{id}'],
  ['Videasy', 'https://player.videasy.net/movie/{id}'],
  ['VidKing', 'https://www.vidking.net/embed/movie/{id}'],
  ['Peachify', 'https://peachify.top/embed/movie/{id}'],
  ['Smashy', 'https://player.smashystream.com/movie/{id}'],
  ['VidUp', 'https://vidup.to/movie/{id}?autoPlay=true'],
  ['VidFast', 'https://vidfast.pro/movie/{id}?autoPlay=true'],
  ['VidLink', 'https://vidlink.pro/movie/{id}?autoplay=true&title=true'],
  ['VidMov', 'https://vidsrc.mov/embed/movie/{id}'],
  ['VidFyi', 'https://vidsrc.fyi/embed/movie/{id}'],
  ['VidRock', 'https://vidrock.net/movie/{id}'],
  ['Movies111', 'https://111movies.com/movie/{id}'],
  ['NonTongo', 'https://www.nontongo.win/embed/movie/{id}'],
  ['VidSrc', 'https://vidsrc.me/embed/movie?tmdb={id}'],
  ['HyperLink', 'https://vidsrc.wtf/api/1/movie/?id={id}&color=215fb3'],
  ['NexaStream', 'https://vidsrc.wtf/api/2/movie/?id={id}&color=215fb3'],
  ['UltraBox', 'https://player.vidplus.to/embed/movie/{id}'],
  ['CloudBox', 'https://vidify.top/embed/movie/{id}'],
  ['UpCloud', 'https://player.vidsrc.co/embed/movie/{id}'],
  ['StreamVault', 'https://hexa.watch/watch/movie/{id}'],
  ['MediaHub', 'https://spencerdevs.xyz/movie/{id}?theme=215fb3'],
  ['CloudPlay', 'https://vidsrc.cc/v2/embed/movie/{id}'],
  ['StreamBoxHD', 'https://test.autoembed.cc/embed/movie/{id}'],
  ['MovieVault', 'https://rivestream.org/embed?type=movie&id={id}'],
];

const HASH = '0123456789abcdef0123';
const CHUNK_PATH = `/component---src-pages-movie-details-js-${HASH}.js`;

type Route = { status?: number; body: string; headers?: Record<string, string> } | Error;

/** A fetch that serves only the given addresses and records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const asked: Array<{ url: string; userAgent: string | null }> = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
    asked.push({ url, userAgent: init?.headers?.['user-agent'] ?? null });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route instanceof Error) throw route;
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch, asked };
}

/** A Gatsby-shaped site: a page naming its webpack runtime, which maps chunk 623 to the movie-details chunk. */
function gatsbySite(origin: string): Record<string, Route> {
  return {
    [`${origin}/`]: {
      body: `<html><head><script src="/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head></html>`,
    },
    [`${origin}/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js`]: {
      body: `o.p="/",o.u=e=>({125:"component---src-pages-index-js",623:"component---src-pages-movie-details-js"}[e]||e)+"-"+{125:"ffffffffffffffffffff",623:"${HASH}"}[e]+".js"`,
    },
    [`${origin}${CHUNK_PATH}`]: { body: CHUNK },
  };
}

describe('direct streaming: reading provider templates', () => {
  it('finds the 24 named film templates in the fmovies movie-details chunk, and not its poster addresses', () => {
    const { providers, skipped } = mergeProviders(extractTemplates(CHUNK));
    expect(providers.map((p: { name: string; movie: string }) => [p.name, p.movie])).toEqual(FMOVIES);
    expect(providers.every((p: { tv: string | null }) => p.tv === null)).toBe(true);
    expect(skipped).toEqual([]);
    expect(JSON.stringify(providers)).not.toContain('image.tmdb.org');
  });

  it('reads concatenations, merges an episode template by name, and skips what is not a film provider', () => {
    const source = [
      'const a={Alpha:"https://alpha.example/embed/movie/"+e,Beta:"https://beta.example/e?id="+e+"&x=1",src:"https://img.example/"+e};',
      'const b={Alpha:`https://alpha.example/tv/${e}/${t}/${n}`,Show:`https://show.example/tv/${e}`,OnlyTv:`https://o.example/tv/${e}?s=${s}&e=${n}`,Imdb:`https://i.example/movie/tt${e}`,Two:`https://two.example/${e}/${t}`,Expr:`https://x.example/${e.id}`};',
      'const c=ok?x:`https://ternary.example/movie/${e}`;',
    ].join('\n');
    const { providers, skipped } = mergeProviders(extractTemplates(source, 'https://s.example/app.js'));
    expect(providers).toEqual([
      { name: 'Alpha', movie: 'https://alpha.example/embed/movie/{id}', tv: 'https://alpha.example/tv/{id}/{season}/{episode}', found_in: 'https://s.example/app.js' },
      { name: 'Beta', movie: 'https://beta.example/e?id={id}&x=1', tv: null, found_in: 'https://s.example/app.js' },
    ]);
    expect(skipped).toEqual([{ name: 'OnlyTv', reason: 'no_film_template' }]);
  });

  it('follows the page to its webpack runtime and the movie-details chunk, on the site only, as a plain client', async () => {
    const { fetch, asked } = fakeFetch(gatsbySite('https://fm.example'));
    const answer = await readSiteTemplates('https://fm.example/', { fetch });
    expect(answer.ok).toBe(true);
    expect(answer.providers.map((p: { name: string; movie: string }) => [p.name, p.movie])).toEqual(FMOVIES);
    expect(answer.providers[0].found_in).toBe(`https://fm.example${CHUNK_PATH}`);
    expect(asked.map((a) => a.url)).not.toContain('https://www.googletagmanager.com/gtag/js?id=G-1');
    expect(new Set(asked.map((a) => a.userAgent))).toEqual(new Set([USER_AGENT]));
    expect(USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('reads the likely chunk first and stops at the script bound', async () => {
    const routes = gatsbySite('https://b.example');
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const hex = (i: number): string => String(i).padStart(20, 'a');
    routes['https://b.example/webpack-runtime-aaaaaaaaaaaaaaaaaaaa.js'] = {
      body: `o.u=e=>({${ids.map((i) => `${i}:"chunk-${i}"`).join(',')},623:"component---src-pages-movie-details-js"}[e]||e)+"-"+{${ids.map((i) => `${i}:"${hex(i)}"`).join(',')},623:"${HASH}"}[e]+".js"`,
    };
    for (const i of ids) routes[`https://b.example/chunk-${i}-${hex(i)}.js`] = { body: 'var x=1' };
    const { fetch, asked } = fakeFetch(routes);
    const answer = await readSiteTemplates('https://b.example/', { fetch, limits: { ...LIMITS, maxScripts: 3 } });
    expect(answer.ok).toBe(true);
    expect(answer.providers).toHaveLength(24);
    expect(answer.scripts_read).toBeLessThanOrEqual(3);
    expect(asked.length).toBeLessThanOrEqual(4);
  });

  it('answers bot_check for a challenge page and reads nothing further', async () => {
    const { fetch, asked } = fakeFetch({ 'https://cf.example/': { status: 403, body: '<html><head><title>Just a moment...</title></head></html>' } });
    const answer = await readSiteTemplates('https://cf.example/', { fetch });
    expect(answer).toMatchObject({ ok: false, error: 'bot_check', scripts_read: 0 });
    expect(answer.detail).toContain('not built');
    expect(asked).toHaveLength(1);
  });

  it('answers no_templates for a page with no provider, unreachable for a host that does not answer, bad_url and usage', async () => {
    expect(await readSiteTemplates('https://plain.example/', fakeFetch({ 'https://plain.example/': { body: '<html><p>hi</p></html>' } })))
      .toMatchObject({ ok: false, error: 'no_templates' });
    const down = async (): Promise<Response> => {
      throw new Error('getaddrinfo ENOTFOUND down.example');
    };
    expect(await readSiteTemplates('https://down.example/', { fetch: down })).toMatchObject({ ok: false, error: 'unreachable', detail: 'getaddrinfo ENOTFOUND down.example' });
    expect(await readSiteTemplates('not a url', { fetch: down })).toMatchObject({ ok: false, error: 'bad_url' });
    expect(await templatesCommand([])).toMatchObject({ code: 2, answer: { error: 'usage' } });
    expect(await templatesCommand(['https://plain.example/'], fakeFetch({ 'https://plain.example/': { body: '' } }))).toMatchObject({ code: 1 });
  });
});
```
**Impact:** proves R4.1's read half and R4.2's "say so" half with no network.

### Step 4: Insert into the registry
**File:** `src/directStream/repo.ts` (phase 3's file): one exported type beside phase 3's
`StreamProvider`, one method at the end of the class `DirectStreamRepo`.
**Change:** The only writer of `stream_providers` gains an insert-only method. Existing rows are
never updated: a name already present is skipped by the database (`on conflict do nothing`).
**Code:**
```ts
/** A provider /update-cloud-source adds: its film and episode templates and the site it came from. */
export interface NewStreamProvider {
  name: string;
  movie: string;
  tv: string | null;
  /** The aggregator site's origin, `https://ww6-fmovies.com`; null for a seed row. */
  originSite: string | null;
}
```
```ts
  /**
   * Adds providers the registry lacks and returns the names inserted. A name already present is
   * left exactly as it is (on conflict do nothing): this never rewrites a seed row or one another
   * machine added. What the probe learns goes to stream_provider_health, not here.
   */
  async insertProviders(rows: NewStreamProvider[], now: Date = new Date()): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await this.db
      .insert(streamProviders)
      .values(
        rows.map((row) => ({
          name: row.name,
          idKind: 'tmdb' as const,
          movie: row.movie,
          tv: row.tv,
          browserOnly: false,
          enSubtitle: null,
          notes: '',
          originSite: row.originSite,
          addedAt: now,
        })),
      )
      .onConflictDoNothing({ target: streamProviders.name })
      .returning({ name: streamProviders.name });
    return inserted.map((row) => row.name);
  }
```
(`streamProviders` is already imported by phase 3's repo; if `idKind` is a plain text column the
`as const` is harmless.)
**Impact:** additive.

### Step 5: The update logic
**File:** `src/directStream/updateSource.ts` (new)
**Change:** One function the service delegates to, with its dependencies passed in so the
integration test drives it with the real repo and a fake runner. The reader's JSON is parsed
once here, at the boundary; everything after trusts the typed value. Known titles load before
anything is written, so a missing titles file changes nothing. A probe only runs for a row this
call inserted. Episodes are probed only for a provider with an episode template that resolved a
film (a provider that resolves no film is not worth a minute per episode).
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NewStreamProvider } from './repo.js';
import type { DirectStreamRunner } from './runner.js';
import type { ResolveOutcome, ResolveOutput, StreamRef } from './types.js';

/** `claude/streaming/direct/known-titles.json`, two folders up from src/directStream or dist/directStream. */
export const DEFAULT_KNOWN_TITLES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'claude',
  'streaming',
  'direct',
  'known-titles.json',
);

/** A title every provider is probed against (phase 2's list; Fight Club, TMDB 550, among them). */
export interface KnownTitle {
  label: string;
  ref: StreamRef;
}

const KnownTitlesFile = z
  .array(
    z.object({
      label: z.string().min(1),
      kind: z.enum(['movie', 'tv']),
      tmdb_id: z.number().int().positive(),
      season: z.number().int().positive().optional(),
      episode: z.number().int().positive().optional(),
    }),
  )
  .min(1);

export async function loadKnownTitles(file: string = DEFAULT_KNOWN_TITLES_PATH): Promise<KnownTitle[]> {
  const rows = KnownTitlesFile.parse(JSON.parse(await readFile(file, 'utf8')));
  return rows.map((row) => ({
    label: row.label,
    ref:
      row.kind === 'movie'
        ? { kind: 'movie', tmdbId: row.tmdb_id }
        : { kind: 'tv', tmdbId: row.tmdb_id, season: row.season ?? 1, episode: row.episode ?? 1 },
  }));
}

const filmTemplate = z.string().startsWith('https://').includes('{id}');
const episodeTemplate = z.string().startsWith('https://').includes('{id}').includes('{season}').includes('{episode}');

/** What `cli.mjs templates <site>` prints (claude/streaming/direct/templates.mjs). */
export const TemplatesAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    site: z.string().url(),
    scripts_read: z.number().int().nonnegative(),
    providers: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(60),
          movie: filmTemplate,
          tv: episodeTemplate.nullable(),
          found_in: z.string().nullable(),
        }),
      )
      .min(1),
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  z.object({
    ok: z.literal(false),
    site: z.string().nullable(),
    error: z.enum(['bad_url', 'unreachable', 'bot_check', 'no_templates', 'usage']),
    detail: z.string(),
    scripts_read: z.number().int().nonnegative(),
  }),
]);

/** Phase 3's ResolveOutcome (attempt outcomes), plus not_probed for a probe this phase did not run. */
export type ProbeOutcome = ResolveOutcome | 'not_probed';

/** One known title tried against one new provider. */
export interface ProbeResult {
  title: string;
  outcome: ProbeOutcome;
  took_s: number | null;
  manifest_kind: string | null;
  best_height: number | null;
  en_subtitle: boolean | null;
  detail: string;
}

export interface AddedProvider {
  name: string;
  movie: string;
  tv: string | null;
  /** The site's name for it when that name was already taken by another provider. */
  renamed_from: string | null;
  /** True when at least one known film resolved through it. */
  resolves: boolean;
  probes: ProbeResult[];
}

export type UpdateSourceError = 'bad_url' | 'unreachable' | 'bot_check' | 'no_templates' | 'usage' | 'reader_failed' | 'busy';

export type UpdateSourceAnswer =
  | {
      ok: true;
      site: string;
      scripts_read: number;
      found: number;
      added: AddedProvider[];
      /** Found on the site and already in the registry (same template host and path), under registry_name. */
      known: Array<{ name: string; registry_name: string }>;
      skipped: Array<{ name: string; reason: string }>;
    }
  | { ok: false; site: string; error: UpdateSourceError; detail: string; registry_changed: false };

/** The two registry calls this needs (DirectStreamRepo through the service). */
export interface ProviderRegistry {
  list(): Promise<Array<{ name: string; movie: string; tv: string | null }>>;
  insert(rows: NewStreamProvider[]): Promise<string[]>;
}

export interface UpdateSourceDeps {
  runner: DirectStreamRunner;
  registry: ProviderRegistry;
  knownTitles: () => Promise<KnownTitle[]>;
  /** Resolves one known title with only this provider and records its health on this host. */
  probe: (provider: string, title: KnownTitle) => Promise<ProbeResult>;
}

const PLACEHOLDER = /\{(id|season|episode)\}/g;

/**
 * Two templates are the same provider when they reach the same host (without `www.`) and path
 * (without a trailing slash), with the id in the same query parameters. Other query parameters
 * (`autoPlay`, `color`, `theme`) are cosmetic and do not count.
 */
export function providerKey(template: string): string {
  const url = new URL(template.replace(PLACEHOLDER, '__$1__'));
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
  const idParams = [...url.searchParams]
    .filter(([, value]) => value.includes('__id__'))
    .map(([key]) => key.toLowerCase())
    .sort();
  return idParams.length === 0 ? `${host}${pathname}` : `${host}${pathname}?${idParams.join('&')}`;
}

function hostOf(template: string): string {
  return new URL(template.replace(PLACEHOLDER, '__$1__')).hostname.replace(/^www\./, '');
}

/**
 * Which found providers are new. Known: the registry (or an earlier entry of this site) has the
 * same provider key. New with a taken name: stored as `<name> (<host>)`, or skipped when that is
 * taken too.
 */
export function planInsert(
  found: Array<{ name: string; movie: string; tv: string | null }>,
  existing: Array<{ name: string; movie: string }>,
  originSite: string,
): {
  rows: NewStreamProvider[];
  renamed: Map<string, string>;
  known: Array<{ name: string; registry_name: string }>;
  skipped: Array<{ name: string; reason: string }>;
} {
  const byKey = new Map(existing.map((p) => [providerKey(p.movie), p.name]));
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  const rows: NewStreamProvider[] = [];
  const renamed = new Map<string, string>();
  const known: Array<{ name: string; registry_name: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const p of found) {
    const key = providerKey(p.movie);
    const match = byKey.get(key);
    if (match !== undefined) {
      known.push({ name: p.name, registry_name: match });
      continue;
    }
    let name = p.name;
    if (names.has(name.toLowerCase())) {
      name = `${p.name} (${hostOf(p.movie)})`;
      if (names.has(name.toLowerCase())) {
        skipped.push({ name: p.name, reason: 'name_taken' });
        continue;
      }
      renamed.set(name, p.name);
    }
    names.add(name.toLowerCase());
    byKey.set(key, name);
    rows.push({ name, movie: p.movie, tv: p.tv, originSite });
  }
  return { rows, renamed, known, skipped };
}

/** One resolve answer (phase 3's ResolveOutput), read for the provider that was asked about. */
export function toProbeResult(title: KnownTitle, provider: string, answer: ResolveOutput): ProbeResult {
  if (answer.ok && answer.source.provider === provider) {
    return {
      title: title.label,
      outcome: 'resolved',
      took_s: answer.source.took_s,
      manifest_kind: answer.source.manifest_kind,
      best_height: answer.source.best_height,
      en_subtitle: answer.source.en_subtitle,
      detail: '',
    };
  }
  const attempt = answer.attempts.find((a) => a.provider === provider);
  return {
    title: title.label,
    outcome: attempt?.outcome ?? 'error',
    took_s: attempt?.took_s ?? null,
    manifest_kind: null,
    best_height: null,
    en_subtitle: null,
    detail: attempt?.detail ?? (answer.ok ? 'the resolve did not try this provider' : answer.error),
  };
}

function notProbed(title: KnownTitle, detail: string): ProbeResult {
  return { title: title.label, outcome: 'not_probed', took_s: null, manifest_kind: null, best_height: null, en_subtitle: null, detail };
}

async function probeProvider(
  row: NewStreamProvider,
  renamedFrom: string | null,
  titles: KnownTitle[],
  probe: UpdateSourceDeps['probe'],
): Promise<AddedProvider> {
  const probes: ProbeResult[] = [];
  for (const title of titles.filter((t) => t.ref.kind === 'movie')) probes.push(await probe(row.name, title));
  const resolves = probes.some((p) => p.outcome === 'resolved');
  if (row.tv !== null) {
    for (const title of titles.filter((t) => t.ref.kind === 'tv')) {
      probes.push(resolves ? await probe(row.name, title) : notProbed(title, 'no known film resolved through it'));
    }
  }
  return { name: row.name, movie: row.movie, tv: row.tv, renamed_from: renamedFrom, resolves, probes };
}

function failed(site: string, error: UpdateSourceError, detail: string): UpdateSourceAnswer {
  return { ok: false, site, error, detail, registry_changed: false };
}

/**
 * /update-cloud-source: read the site's templates, add the providers the registry lacks, probe
 * each new one against the known titles, and report per provider. Nothing is written unless the
 * read succeeded.
 */
export async function updateSource(site: string, deps: UpdateSourceDeps): Promise<UpdateSourceAnswer> {
  const titles = await deps.knownTitles();
  let raw: unknown;
  try {
    raw = await deps.runner(['templates', site]);
  } catch (err) {
    return failed(site, 'reader_failed', err instanceof Error ? err.message : String(err));
  }
  const parsed = TemplatesAnswerSchema.safeParse(raw);
  if (!parsed.success) return failed(site, 'reader_failed', `the template reader answered something unexpected: ${parsed.error.message.slice(0, 300)}`);
  const answer = parsed.data;
  if (!answer.ok) return failed(answer.site ?? site, answer.error, answer.detail);

  const origin = new URL(answer.site).origin;
  const plan = planInsert(answer.providers, await deps.registry.list(), origin);
  const inserted = new Set(await deps.registry.insert(plan.rows));
  const added: AddedProvider[] = [];
  const known = [...plan.known];
  for (const row of plan.rows) {
    // Inserted meanwhile by the other machine: it is known now, and that machine probes it.
    if (!inserted.has(row.name)) {
      known.push({ name: plan.renamed.get(row.name) ?? row.name, registry_name: row.name });
      continue;
    }
    added.push(await probeProvider(row, plan.renamed.get(row.name) ?? null, titles, deps.probe));
  }
  return {
    ok: true,
    site: answer.site,
    scripts_read: answer.scripts_read,
    found: answer.providers.length,
    added,
    known,
    skipped: [...answer.skipped, ...plan.skipped],
  };
}
```
**Impact:** new module; the service wires it in Step 6.

### Step 6: `DirectStreamService.updateSource`
**File:** `src/directStream/service.ts` (phase 3's file): one import line, one field and one public
method in class `DirectStreamService`.
**Change:** The service passes its repo, runner and `runResolve` to `updateSource`. A second call
while one runs answers `busy` instead of probing twice through the one streaming Chrome.
**Code:**

Import:
```ts
import { loadKnownTitles, toProbeResult, updateSource, type UpdateSourceAnswer } from './updateSource.js';
```
Field, beside phase 3's fields:
```ts
  /** The running /update-cloud-source, if any: one at a time through the one streaming Chrome. */
  private updatingSource: Promise<UpdateSourceAnswer> | null = null;
```
Method:
```ts
  /**
   * /update-cloud-source: reads a site's provider templates, adds the providers the registry
   * lacks and probes each against the known titles (resolve --only, health recorded for this
   * host). The probes open tabs in the streaming Chrome out of sight; nothing plays. A failed
   * probe marks no title stale: it goes through runResolve, not resolve().
   */
  async updateSource(site: string): Promise<UpdateSourceAnswer> {
    if (this.updatingSource !== null) {
      return { ok: false, site, error: 'busy', detail: 'another /update-cloud-source is still probing; ask again when it has answered', registry_changed: false };
    }
    const running = updateSource(site, {
      runner: this.runner,
      registry: {
        list: () => this.repo.providers(),
        insert: (rows) => this.repo.insertProviders(rows),
      },
      knownTitles: () => loadKnownTitles(),
      probe: async (provider, title) => {
        try {
          return toProbeResult(title, provider, await this.runResolve(title.ref, { only: provider }));
        } catch (err) {
          return { title: title.label, outcome: 'error', took_s: null, manifest_kind: null, best_height: null, en_subtitle: null, detail: err instanceof Error ? err.message : String(err) };
        }
      },
    });
    this.updatingSource = running;
    try {
      return await running;
    } finally {
      this.updatingSource = null;
    }
  }
```
**Impact:** additive; phase 3's other methods unchanged.

### Step 7: Update-logic unit tests
**File:** `tests/unit/directStream.updateSource.test.ts` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolveOutput } from '../../src/directStream/types.js';
import { TemplatesAnswerSchema, loadKnownTitles, providerKey, toProbeResult, type KnownTitle } from '../../src/directStream/updateSource.js';
// @ts-expect-error -- a plain .mjs script without type declarations
import { extractTemplates, mergeProviders } from '../../claude/streaming/direct/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIGHT_CLUB: KnownTitle = { label: 'Fight Club (1999)', ref: { kind: 'movie', tmdbId: 550 } };

describe('providerKey', () => {
  it('ignores www, a trailing slash and cosmetic query parameters', () => {
    expect(providerKey('https://www.vidking.net/embed/movie/{id}')).toBe(providerKey('https://vidking.net/embed/movie/{id}/'));
    expect(providerKey('https://vidfast.pro/movie/{id}?autoPlay=true')).toBe(providerKey('https://vidfast.pro/movie/{id}?autoPlay=false'));
    expect(providerKey('https://vidsrc.wtf/api/1/movie/?id={id}&color=215fb3')).toBe('vidsrc.wtf/api/1/movie?id');
  });

  it('tells apart providers on one host by path or by the parameter that carries the id', () => {
    expect(providerKey('https://vidsrc.wtf/api/1/movie/?id={id}')).not.toBe(providerKey('https://vidsrc.wtf/api/2/movie/?id={id}'));
    expect(providerKey('https://vidsrc.me/embed/movie?tmdb={id}')).not.toBe(providerKey('https://vidsrc.me/embed/movie?imdb={id}'));
    expect(providerKey('https://vidsrc.me/embed/movie?tmdb={id}')).not.toBe(providerKey('https://vidsrc.xyz/embed/movie?tmdb={id}'));
  });
});

describe('toProbeResult', () => {
  // Phase 3's ResolveOutput (what runResolve returns after parseResolveOutput).
  const resolved: ResolveOutput = {
    ok: true,
    source: {
      provider: 'Fresh',
      embed_url: 'https://fresh.example/movie/550',
      manifest_url: 'https://cdn.fresh.example/master.m3u8',
      manifest_kind: 'hls',
      headers: { referer: 'https://fresh.example/', origin: 'https://fresh.example', user_agent: 'Chrome' },
      subtitles: [{ url: 'https://cdn.fresh.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
      best_height: 1080,
      en_subtitle: true,
      took_s: 3.1,
    },
    attempts: [{ provider: 'Fresh', outcome: 'resolved', took_s: 3.1, detail: '' }],
  };

  it('reads a resolved answer for the asked provider', () => {
    expect(toProbeResult(FIGHT_CLUB, 'Fresh', resolved)).toEqual({
      title: 'Fight Club (1999)',
      outcome: 'resolved',
      took_s: 3.1,
      manifest_kind: 'hls',
      best_height: 1080,
      en_subtitle: true,
      detail: '',
    });
  });

  it('reads the attempt of a provider that did not resolve', () => {
    const answer: ResolveOutput = { ok: false, source: null, error: 'no_source', detail: '', attempts: [{ provider: 'Fresh', outcome: 'bot_check', took_s: 4, detail: 'Just a moment' }] };
    expect(toProbeResult(FIGHT_CLUB, 'Fresh', answer)).toMatchObject({ outcome: 'bot_check', took_s: 4, detail: 'Just a moment', manifest_kind: null });
  });
});

describe('known titles and the reader answer', () => {
  it('loads the shared known titles, Fight Club among them', async () => {
    const titles = await loadKnownTitles();
    expect(titles.some((t) => t.ref.kind === 'movie' && t.ref.tmdbId === 550)).toBe(true);
  });

  it('the schema accepts what the reader makes of the real fmovies chunk', () => {
    const chunk = readFileSync(path.join(ROOT, 'docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js'), 'utf8');
    const { providers, skipped } = mergeProviders(extractTemplates(chunk, 'https://ww6-fmovies.com/x.js'));
    const parsed = TemplatesAnswerSchema.safeParse({ ok: true, site: 'https://ww6-fmovies.com/', scripts_read: 1, providers, skipped });
    expect(parsed.success).toBe(true);
  });
});
```
**Impact:** none on runtime. The two fixtures are phase 3's `ResolveOutput` as `runResolve` returns it.

### Step 8: Integration test: the registry, read back
**File:** `tests/integration/directStream.updateSource.int.test.ts` (new)
**Change:** Real Postgres, real `DirectStreamRepo`, a fake runner and a fake probe. Proves
inserted once, existing untouched, `origin_site` set, each new one probed, and a site that
cannot be read changes nothing.
**Code:**
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamProviders } from '../../src/db/schema.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { updateSource, type KnownTitle, type ProbeResult, type UpdateSourceDeps } from '../../src/directStream/updateSource.js';
import { closeTestDb, openTestDb } from './setup.js';

const SITE = 'https://ww6-fmovies.example/';
const ORIGIN = 'https://ww6-fmovies.example';
const FILMS: KnownTitle[] = [
  { label: 'Fight Club (1999)', ref: { kind: 'movie', tmdbId: 550 } },
  { label: 'A recent film', ref: { kind: 'movie', tmdbId: 1_100_000 } },
];
const EPISODE: KnownTitle = { label: 'A series S01E01', ref: { kind: 'tv', tmdbId: 1399, season: 1, episode: 1 } };
const KNOWN: KnownTitle[] = [...FILMS, EPISODE];

const READ = {
  ok: true,
  site: SITE,
  scripts_read: 2,
  skipped: [],
  providers: [
    // The registry has it under another query string: known, not added.
    { name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=false', tv: null, found_in: null },
    // The name is taken by another host: added as "VidSrc (vidsrc.xyz)".
    { name: 'VidSrc', movie: 'https://vidsrc.xyz/embed/movie/{id}', tv: 'https://vidsrc.xyz/embed/tv/{id}/{season}/{episode}', found_in: null },
    { name: 'Fresh', movie: 'https://fresh.example/movie/{id}', tv: null, found_in: null },
  ],
};

let db: Db;
let repo: DirectStreamRepo;

async function rows() {
  return (await db.select().from(streamProviders)).sort((a, b) => a.name.localeCompare(b.name));
}

function probeFake() {
  return vi.fn(async (provider: string, title: KnownTitle): Promise<ProbeResult> =>
    provider === 'Fresh'
      ? { title: title.label, outcome: 'no_stream', took_s: 35, manifest_kind: null, best_height: null, en_subtitle: null, detail: 'nothing in 35 s' }
      : { title: title.label, outcome: 'resolved', took_s: 2.5, manifest_kind: 'hls', best_height: 1080, en_subtitle: true, detail: '' },
  );
}

function deps(runnerAnswer: unknown, probe = probeFake()): UpdateSourceDeps & { probe: ReturnType<typeof probeFake>; runner: ReturnType<typeof vi.fn> } {
  const runner = vi.fn(async (args: string[]) => {
    expect(args).toEqual(['templates', SITE]);
    if (runnerAnswer instanceof Error) throw runnerAnswer;
    return runnerAnswer;
  });
  return {
    runner,
    registry: { list: () => repo.providers(), insert: (r) => repo.insertProviders(r) },
    knownTitles: async () => KNOWN,
    probe,
  };
}

beforeAll(() => {
  db = openTestDb();
  repo = new DirectStreamRepo(db);
});

afterAll(async () => {
  await db.delete(streamProviders);
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.delete(streamProviders);
  await repo.insertProviders(
    [
      { name: 'VidFast', movie: 'https://vidfast.pro/movie/{id}?autoPlay=true', tv: null, originSite: null },
      { name: 'VidSrc', movie: 'https://vidsrc.me/embed/movie?tmdb={id}', tv: null, originSite: null },
    ],
    new Date('2026-11-01T00:00:00.000Z'),
  );
});

describe('/update-cloud-source against the registry', () => {
  it('adds only what the registry lacks, leaves existing rows untouched, and probes each new one', async () => {
    const before = await rows();
    const d = deps(READ);
    const answer = await updateSource(SITE, d);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.known).toEqual([{ name: 'VidFast', registry_name: 'VidFast' }]);
    expect(answer.added.map((a) => [a.name, a.renamed_from, a.resolves])).toEqual([
      ['VidSrc (vidsrc.xyz)', 'VidSrc', true],
      ['Fresh', null, false],
    ]);

    const after = await rows();
    expect(after).toHaveLength(4);
    for (const old of before) expect(after.find((r) => r.name === old.name)).toEqual(old);
    const fresh = after.find((r) => r.name === 'Fresh');
    expect(fresh).toMatchObject({ movie: 'https://fresh.example/movie/{id}', tv: null, originSite: ORIGIN, browserOnly: false });
    expect(fresh?.addedAt).toBeInstanceOf(Date);
    expect(after.find((r) => r.name === 'VidSrc (vidsrc.xyz)')).toMatchObject({ tv: 'https://vidsrc.xyz/embed/tv/{id}/{season}/{episode}', originSite: ORIGIN });

    // Films for both; the episode only for the one that has an episode template and resolved a film.
    expect(d.probe.mock.calls.map(([provider, title]) => [provider, title.label])).toEqual([
      ['VidSrc (vidsrc.xyz)', 'Fight Club (1999)'],
      ['VidSrc (vidsrc.xyz)', 'A recent film'],
      ['VidSrc (vidsrc.xyz)', 'A series S01E01'],
      ['Fresh', 'Fight Club (1999)'],
      ['Fresh', 'A recent film'],
    ]);
    expect(answer.added[1]?.probes.map((p) => p.outcome)).toEqual(['no_stream', 'no_stream']);
  });

  it('inserts once: a second read of the same site adds and probes nothing', async () => {
    await updateSource(SITE, deps(READ));
    const once = await rows();
    const d = deps(READ);
    const again = await updateSource(SITE, d);
    expect(again).toMatchObject({ ok: true, added: [] });
    if (again.ok) expect(again.known.map((k) => k.registry_name).sort()).toEqual(['Fresh', 'VidFast', 'VidSrc (vidsrc.xyz)']);
    expect(d.probe).not.toHaveBeenCalled();
    expect(await rows()).toEqual(once);
  });

  it.each([
    ['a bot check', { ok: false, site: SITE, error: 'bot_check', detail: 'the page answered HTTP 403 with a bot check', scripts_read: 0 }, 'bot_check'],
    ['no template', { ok: false, site: SITE, error: 'no_templates', detail: 'read the page and 12 scripts and found no provider template', scripts_read: 12 }, 'no_templates'],
    ['a reader that crashed', new Error('direct stream script failed: timeout'), 'reader_failed'],
    ['a reader that printed something else', { hello: 'world' }, 'reader_failed'],
  ])('says so and leaves the registry unchanged on %s', async (_label, runnerAnswer, error) => {
    const before = await rows();
    const d = deps(runnerAnswer);
    const answer = await updateSource(SITE, d);
    expect(answer).toMatchObject({ ok: false, error, registry_changed: false });
    expect(await rows()).toEqual(before);
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('writes nothing when the known titles cannot be read', async () => {
    const before = await rows();
    const d = { ...deps(READ), knownTitles: async () => Promise.reject(new Error('ENOENT known-titles.json')) };
    await expect(updateSource(SITE, d)).rejects.toThrow('ENOENT');
    expect(await rows()).toEqual(before);
    expect(d.runner).not.toHaveBeenCalled();
  });
});
```
**Impact:** none on runtime. If phase 3's integration tests rely on `truncateAll` covering
`stream_providers`, this file's own `delete` keeps it independent either way.

### Step 9: The two MCP tools
**File:** `src/mcp/directStreamTools.ts` (phase 7's file, as `phase-7.md` Step 4 writes it): the
`DirectStreamToolDeps` interface and `directStreamToolDeps` (two members each), one destructuring
line under phase 7's `const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES;`, two description constants
and one function after phase 7's description constants, and one call as the last statement of
`registerDirectStreamTools`.
**Change:** phase 7's tools reach the daemon only through `DirectStreamToolDeps` (there is no
`DirectStreamService` in `ToolDeps`), so the two registry calls are added there and bound to the
service in `directStreamToolDeps`. `direct_stream_sources` (read-only) returns `providers()` as
phase 3 shapes it. `direct_stream_update_source` validates the address once (zod) and returns the
service's answer, also when it is `ok: false` (that is the "say so" of R4.2, not a tool error).
Both answer phase 7's `direct_stream_off` without deps, as phase 7's tools do.
**Code:** in phase 7's `DirectStreamToolDeps`, after `freshSource(...)`:
```ts
  /** DirectStreamService.providers(): the registry with this host's health (direct_stream_sources). */
  providers(): Promise<ProviderView[]>;
  /** DirectStreamService.updateSource: read a site's templates, add and probe the new providers (/update-cloud-source). */
  updateSource(site: string): Promise<UpdateSourceAnswer>;
```
with `import type { ProviderView } from '../directStream/repo.js';` and
`import type { UpdateSourceAnswer } from '../directStream/updateSource.js';`. In phase 7's
`directStreamToolDeps`, after its `freshSource: async (target) => { ... },` member:
```ts
    providers: () => service.providers(),
    updateSource: (site) => service.updateSource(site),
```
Under phase 7's `const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES;`:
```ts
const [, , SOURCES, UPDATE_SOURCE] = DIRECT_STREAM_TOOL_NAMES;
```
```ts
const SOURCES_DESCRIPTION =
  'List the direct-streaming providers in the registry both machines share: each one\'s name, film and episode address templates ' +
  '({id} is the TMDB id), whether it plays only in its own page (browser_only), whether it is known to offer an English subtitle, ' +
  'the aggregator site it was added from (origin_site, null for the checked-in seed) and when, and this machine\'s health for it ' +
  '(last success and failure, consecutive failures, median seconds to a stream, best quality). Health is per machine: the other ' +
  'laptop measures its own. Read-only: nothing opens and nothing is probed.';

const UPDATE_SOURCE_DESCRIPTION =
  'Add the providers an aggregator streaming site uses that the registry lacks, and probe each new one. Use it for ' +
  '"/update-cloud-source <site url>" in Claude Code. It reads the site\'s page and scripts with plain requests (no browser) for ' +
  'provider address templates, keeps the ones whose host and path the registry does not have (a name already taken by another host ' +
  'is stored as "<name> (<host>)"; existing providers are never changed), inserts them, then resolves each known title (Fight Club ' +
  'and the others) with only that provider, recording its health on this machine. Probing opens tabs in the streaming Chrome out ' +
  'of sight, plays nothing and makes no sound; a provider that finds nothing takes about 35 seconds per title, so the call can take ' +
  'minutes. Answers ok: true with added (per provider: resolves, and per title the outcome, seconds, manifest kind, best height, ' +
  'English subtitle), known (found but already in the registry) and skipped; or ok: false with error bot_check, no_templates, ' +
  'unreachable, bad_url, reader_failed or busy, and the registry unchanged. Reading the frames a site\'s server buttons load is not built.';

const siteField = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), 'an http or https address');

/**
 * The registry tools (/update-cloud-source): list the providers with this host's health, and
 * add a site's new providers. Without deps.directStream both answer direct_stream_off, as phase 7's do.
 */
function registerDirectStreamSourceTools(server: McpServer, deps: Pick<ToolDeps, 'directStream'>): void {
  const off = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] });

  server.registerTool(
    SOURCES,
    {
      title: 'List the direct-streaming providers',
      description: SOURCES_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const providers = await d.providers();
        return ok({ count: providers.length, providers });
      });
    },
  );

  server.registerTool(
    UPDATE_SOURCE,
    {
      title: 'Add an aggregator site\'s new stream providers',
      description: UPDATE_SOURCE_DESCRIPTION,
      inputSchema: {
        site: siteField.describe('The aggregator site\'s address, such as https://ww6-fmovies.com/ (its home page or a film page).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ site }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => ok(await d.updateSource(site)));
    },
  );
}
```
Last statement of `registerDirectStreamTools` (after phase 7's `server.registerTool(PLAY, ...)`):
```ts
  registerDirectStreamSourceTools(server, deps);
```
(`z`, `CallToolResult`, `ToolDeps`, `McpServer`, `DIRECT_STREAM_OFF`, `ok` and `respond` are
already imported or defined in phase 7's file.)

**File:** `tests/unit/mcp.directStreamTools.test.ts` (phase 7's): its `fakeDeps` builds a full
`DirectStreamToolDeps`, so add the two new members before `...over`:
```ts
  const deps: DirectStreamToolDeps = { library, tmdb, play, freshSource, providers: vi.fn(async () => []), updateSource: vi.fn(), ...over };
```
(replacing phase 7's `const deps: DirectStreamToolDeps = { library, tmdb, play, freshSource, ...over };`).
Phase 7's "registers every DIRECT_STREAM_TOOL_NAMES name" test then sees the four names.
**Impact:** the server registers four direct-stream tools.

### Step 10: Tool names, chat allow list, captions
**File:** `src/chat/status.ts`: phase 7's `DIRECT_STREAM_TOOL_NAMES` declaration (its doc comment,
`export const DIRECT_STREAM_TOOL_NAMES = ['direct_stream_find', 'direct_stream_play'] as const;`
and `export type DirectStreamToolName = ...`, all replaced by the block below); the
`allowedChatTools` body (phase 7's `...DIRECT_STREAM_TOOL_NAMES.map((name) => \`${MCP_PREFIX}${name}\`),`
line) and its doc comment (phase 7's "the direct-streaming tools" wording); the
`captionForToolUse` switch (after phase 7's `direct_stream_play` case).
**Change:** Decision: **the chat bar may call `direct_stream_sources` but not
`direct_stream_update_source`.** Update writes the provider list both machines share and opens
tabs in the streaming Chrome for minutes; it is the owner's `/update-cloud-source` in Claude
Code. The exclusion is a named list the allow list filters, and a test pins it.
**Code:**
```ts
/**
 * The direct-streaming tools (src/mcp/directStreamTools.ts): direct_stream_find and
 * direct_stream_play (/direct-stream); direct_stream_sources lists the provider registry,
 * direct_stream_update_source adds a site's new providers (/update-cloud-source).
 */
export const DIRECT_STREAM_TOOL_NAMES = [
  'direct_stream_find',
  'direct_stream_play',
  'direct_stream_sources',
  'direct_stream_update_source',
] as const;

export type DirectStreamToolName = (typeof DIRECT_STREAM_TOOL_NAMES)[number];

/**
 * Tools the daemon registers that the chat bar may not call. direct_stream_update_source writes
 * the provider list both machines share and opens tabs in the streaming Chrome for minutes while
 * it probes: it is Claude Code's /update-cloud-source only.
 */
export const CLAUDE_CODE_ONLY_TOOL_NAMES: readonly DirectStreamToolName[] = ['direct_stream_update_source'];
```
In `allowedChatTools`, phase 7's direct-stream line becomes:
```ts
    ...DIRECT_STREAM_TOOL_NAMES.filter((name) => !CLAUDE_CODE_ONLY_TOOL_NAMES.includes(name)).map((name) => `${MCP_PREFIX}${name}`),
```
Captions, after phase 7's `direct_stream_play` case:
```ts
    case 'direct_stream_sources':
      return 'reading the stream providers';
    case 'direct_stream_update_source':
      return 'adding stream providers';
```
If phase 7 already declared `DirectStreamToolName`, keep one declaration. Update the
`allowedChatTools` doc comment's list to say "the 3 direct-stream tools the chat bar may call
(not direct_stream_update_source)".
**Impact:** the chat agent's allow list grows by one (`direct_stream_sources`).

### Step 11: Tool tests
**File:** `tests/unit/mcp.directStreamSourceTools.test.ts` (new)
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_STREAM_OFF, registerDirectStreamTools } from '../../src/mcp/directStreamTools.js';
import type { UpdateSourceAnswer } from '../../src/directStream/updateSource.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type RegisterDeps = Parameters<typeof registerDirectStreamTools>[1];

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

async function connect(directStream: unknown) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerDirectStreamTools(server, { directStream } as RegisterDeps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const ADDED: UpdateSourceAnswer = {
  ok: true,
  site: 'https://ww6-fmovies.com/',
  scripts_read: 40,
  found: 25,
  added: [{ name: 'Fresh', movie: 'https://fresh.example/movie/{id}', tv: null, renamed_from: null, resolves: false, probes: [] }],
  known: [{ name: 'VidFast', registry_name: 'VidFast' }],
  skipped: [],
};

describe('direct-stream registry tools', () => {
  it('registers direct_stream_sources read-only and direct_stream_update_source as a write', async () => {
    const c = await connect(null);
    const { tools } = await c.client.listTools();
    const sources = tools.find((t) => t.name === 'direct_stream_sources');
    const update = tools.find((t) => t.name === 'direct_stream_update_source');
    expect(sources?.annotations?.readOnlyHint).toBe(true);
    expect(update?.annotations?.readOnlyHint).toBe(false);
    for (const t of [sources, update]) expect(t?.description?.length ?? 0).toBeGreaterThan(200);
    await c.close();
  });

  it('answers direct_stream_off from both without a service', async () => {
    const c = await connect(null);
    for (const [name, args] of [
      ['direct_stream_sources', {}],
      ['direct_stream_update_source', { site: 'https://ww6-fmovies.com/' }],
    ] as const) {
      const r = await c.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(DIRECT_STREAM_OFF);
    }
    await c.close();
  });

  it('direct_stream_update_source passes the address and returns the report, failures included', async () => {
    const updateSource = vi
      .fn<(site: string) => Promise<UpdateSourceAnswer>>()
      .mockResolvedValueOnce(ADDED)
      .mockResolvedValueOnce({ ok: false, site: 'https://cf.example/', error: 'bot_check', detail: 'HTTP 403', registry_changed: false });
    const c = await connect({ updateSource, providers: vi.fn() });
    const ok = await c.call('direct_stream_update_source', { site: '  https://ww6-fmovies.com/ ' });
    expect(updateSource).toHaveBeenNthCalledWith(1, 'https://ww6-fmovies.com/');
    expect(JSON.parse(text(ok))).toEqual(ADDED);
    const refused = await c.call('direct_stream_update_source', { site: 'https://cf.example/' });
    expect(refused.isError).not.toBe(true);
    expect(JSON.parse(text(refused))).toMatchObject({ ok: false, error: 'bot_check', registry_changed: false });
    await c.close();
  });

  it('refuses an address that is not http or https, and calls nothing', async () => {
    const updateSource = vi.fn();
    const c = await connect({ updateSource, providers: vi.fn() });
    for (const site of ['not a url', 'ftp://ww6-fmovies.com/']) {
      expect((await c.call('direct_stream_update_source', { site })).isError).toBe(true);
    }
    expect(updateSource).not.toHaveBeenCalled();
    await c.close();
  });

  it('direct_stream_sources returns the registry with its count', async () => {
    const providers = vi.fn(async () => [{ name: 'VidFast' }, { name: 'Fresh' }]);
    const c = await connect({ providers, updateSource: vi.fn() });
    expect(JSON.parse(text(await c.call('direct_stream_sources', {})))).toEqual({ count: 2, providers: [{ name: 'VidFast' }, { name: 'Fresh' }] });
    await c.close();
  });
});
```
**File:** `tests/unit/chat-status.test.ts`: in phase 7's version of the `allowedChatTools` count
test, phase 7's two lines
```ts
    expect(DIRECT_STREAM_TOOL_NAMES.slice(0, 2)).toEqual(['direct_stream_find', 'direct_stream_play']);
    expect(tools).toHaveLength(19 + 5 + 3 + 6 + 2 + DIRECT_STREAM_TOOL_NAMES.length + 22 + 2);
```
become
```ts
    expect(DIRECT_STREAM_TOOL_NAMES).toEqual(['direct_stream_find', 'direct_stream_play', 'direct_stream_sources', 'direct_stream_update_source']);
    expect(tools).toHaveLength(19 + 5 + 3 + 6 + 2 + (DIRECT_STREAM_TOOL_NAMES.length - CLAUDE_CODE_ONLY_TOOL_NAMES.length) + 22 + 2);
```
and phase 7's loop `for (const name of DIRECT_STREAM_TOOL_NAMES) expect(tools).toContain(n(name));`
becomes
`for (const name of DIRECT_STREAM_TOOL_NAMES.filter((x) => !CLAUDE_CODE_ONLY_TOOL_NAMES.includes(x))) expect(tools).toContain(n(name));`.
Add `CLAUDE_CODE_ONLY_TOOL_NAMES` to the import and these two tests inside `describe('allowedChatTools', ...)`:
```ts
  it('lets the chat bar list the stream providers but never add one', () => {
    const tools = allowedChatTools();
    expect(CLAUDE_CODE_ONLY_TOOL_NAMES).toEqual(['direct_stream_update_source']);
    expect(tools).toContain(n('direct_stream_sources'));
    expect(tools).not.toContain(n('direct_stream_update_source'));
  });

  it('captions the provider tools', () => {
    expect(captionForToolUse(n('direct_stream_sources'), {})).toBe('reading the stream providers');
    expect(captionForToolUse(n('direct_stream_update_source'), { site: 'https://ww6-fmovies.com/' })).toBe('adding stream providers');
  });
```
**Impact:** none on runtime.

### Step 12: The skill
**File:** `claude/skills/update-cloud-source/SKILL.md` (new); `scripts/install.sh:39`
**Change:** `install.sh` links only the names in `SKILL_NAMES` (and `check_preconditions` requires
each one's `SKILL.md`), so `update-cloud-source` is appended there. Phase 7 left the line as
```sh
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo v j trace-vlc-bug pahe idlix lk21 create-streaming-skill direct-stream)
```
and it becomes
```sh
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo v j trace-vlc-bug pahe idlix lk21 create-streaming-skill direct-stream update-cloud-source)
```
**Code:** `claude/skills/update-cloud-source/SKILL.md`:
````markdown
---
name: update-cloud-source
description: Add the stream providers an aggregator streaming site uses to mcp-notes' direct-streaming registry, and probe each new one. Use whenever the user types "/update-cloud-source <site url>" in any Claude Code session — e.g. "/update-cloud-source https://ww6-fmovies.com/" — and for a plain-English request to the same effect, such as "add the servers ww6-fmovies uses", "does this site have providers we lack?", "update the cloud sources from <site>". Also use for "which stream providers do we have?" and "is VidFast working?", which only list the registry. Reads the site's scripts for provider address templates, adds the ones the registry lacks, probes each against known titles out of sight, and reports per provider.
argument-hint: <site url>
---

# /update-cloud-source — add an aggregator site's stream providers

Direct streaming plays films from "providers": embed addresses keyed by a TMDB id, such as
`https://vidfast.pro/movie/{id}`. Aggregator sites (ww6-fmovies.com and its kind) are lists of
them. This skill reads such a site's list and adds to the registry the providers it lacks. How
it works is in `docs/guide/streaming.md` of the mcp-notes repo, section "Direct streaming".

## Step 1: the address

The text after `/update-cloud-source` is the site's address: its home page, or a film page on it.
Without `https://`, add it. Without any address, answer with the usage line
`/update-cloud-source <site url>` and stop.

## Step 2: add and probe

Call the `notes` MCP tool `direct_stream_update_source` with `site` set to the address. Before the
call, say in one line that new providers are probed in the streaming Chrome out of sight (no
window, no sound, nothing plays) and that it can take a few minutes.

Only to look at what a site offers, without adding anything, run the reader directly:

```sh
node ~/mcp-notes/claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/
```

For "which providers do we have?" or "is VidFast working?", call `direct_stream_sources`
instead: it lists the registry with this machine's health and changes nothing.

## Step 3: answer

- **`ok: true`:** one line with the counts: found, already known, added, skipped. Then one line
  per added provider: its name (and `renamed_from` when the site called it something else
  because the name was taken), whether it `resolves`, and per probed title the outcome with the
  seconds, the best height and whether it had an English subtitle. A provider that resolved
  nothing is still in the registry: say so, and that the resolver tries it last. Nothing added:
  say the registry already had every provider the site uses.
- **`ok: false`:** the registry is unchanged; say why in one line:
  - `bot_check`: the site answers a plain request with a bot check. It is not got past, and
    reading the frames its server buttons load is not built.
  - `no_templates`: the site's scripts hold no provider template a plain request can read.
  - `unreachable`: the address does not answer; check it.
  - `busy`: another `/update-cloud-source` is still probing; ask again after it answers.
  - `reader_failed`, `bad_url`: report the detail.
- **`direct_stream_off`:** direct streaming is off on this daemon (`NOTESD_DIRECT_STREAM=off`,
  `NOTESD_MOVIES=off`) or the daemon runs without it.

Never add a provider by hand, never edit `providers.seed.json` for this, and never probe again
on your own: the owner asks.
````
**Impact:** new skill, linked by the next `scripts/install.sh` (`~/.claude/skills/update-cloud-source`).

### Step 13: Guide, chat captions, reference docs
**File:** `docs/guide/streaming.md`
**Change 1:** the table at the top (line 6-11 today): one row after phase 7's `/direct-stream` row
(or, if phase 7 adds none, after the `/lk21` row):
```markdown
| An aggregator site's providers | `/update-cloud-source <site url>` | Reads the site's provider templates, adds the ones the registry lacks, probes each | No: it writes the provider list both machines share |
```
**Change 2:** a subsection under `## Direct streaming`, after phase 7's `### /direct-stream`
subsection (and before phase 10's, if it has landed):
````markdown
### `/update-cloud-source`: providers from another site

```text
/update-cloud-source https://ww6-fmovies.com/
which stream providers do we have?
```

Aggregator sites are lists of provider templates. `/update-cloud-source` reads one site's list,
adds the providers the registry lacks and tries each new one on the known titles (Fight Club and
the others in `claude/streaming/direct/known-titles.json`). It runs in Claude Code only; the chat
bar can list the providers (`direct_stream_sources`) but not add one, because adding writes the
provider list both machines share and probes for minutes.

1. **Read the templates, no browser.** `cli.mjs templates <site>` fetches the page as a plain
   client that says what it is, then the scripts the page names and the webpack (Gatsby) chunks
   they load, on the site's own host only, likely chunks (`movie`, `details`, `player`, ...)
   first. It stops at 40 scripts, 4 MB a script, 30 MB in all and 90 seconds. A template is an
   object entry whose value builds an `https` address around one id (a film) or three (an
   episode: id, season, episode), keyed by the provider's name. ww6-fmovies.com gave all 24 of
   its servers, each with a film and an episode template.
2. **Keep the new ones.** A provider is already known when the registry has a template with the
   same host (without `www.`), path and id parameter; `?autoPlay=true` and colours do not count.
   A new provider whose name is taken by another host is stored as `VidSrc (vidsrc.xyz)`.
   Existing rows are never changed, and nothing is written when the read failed.
3. **Probe each new one.** Each known film is resolved with only that provider
   (`resolve --only`), in the streaming Chrome out of sight; the episode only when the provider
   has an episode template and resolved a film. Health is recorded for this machine, so the
   resolver orders the new provider like the others. A probe never marks a title stale.
4. **Report** per provider: resolves or not, and per title the outcome, seconds, manifest kind,
   best height and English subtitle.

| Answer | Meaning |
| --- | --- |
| `ok: true`, `added: []` | The registry already has every provider the site uses |
| `bot_check` | The site answers a plain request with a bot check. It is not got past |
| `no_templates` | The page and the scripts read hold no provider template |
| `unreachable` | The address does not answer, or answers an error |
| `busy` | Another update is still probing |
| `direct_stream_off` | Direct streaming is off, or the daemon runs without it |

**Not built:** reading the frames a site's server buttons load through the streaming Chrome. It
needs, per site, a film page with a known TMDB id, the selector of its server buttons and real
clicks on a page full of adverts; a site that needs it answers `no_templates` or `bot_check`.

**The seed and the table.** New providers go to the `stream_providers` table, which both
machines share, with the site they came from (`origin_site`) and when (`added_at`);
`providers.seed.json` is not changed. The other laptop sees them on its next resolve and
measures its own health. The daemon loads the seed at every start: it adds seed providers the
table lacks and updates seed rows (`origin_site` empty) whose entry changed in the file, but never
touches a provider a site added and never deletes one. To make a site's provider part of the
seed, copy its entry into `providers.seed.json` by hand.

| Path | What |
| --- | --- |
| `claude/streaming/direct/templates.mjs` | The template reader (`cli.mjs templates`) |
| `src/directStream/updateSource.ts` | What is new, the probes, the report |
| `src/mcp/directStreamTools.ts` | `direct_stream_sources`, `direct_stream_update_source` |
| `claude/skills/update-cloud-source/` | The skill |
````
**File:** `docs/guide/chat.md`: phase 7 added, in the caption table,
`| looking for a stream, starting a stream | using the direct-streaming tools |`; it becomes
`| looking for a stream, starting a stream, reading the stream providers | using the direct-streaming tools |`
(the chat bar never shows "adding stream providers": that tool is not on its allow list). Phase 7
added, in the allow-list table,
`| Direct streaming | \`direct_stream_find\`, \`direct_stream_play\` | \`direct_stream_play\` opens the player page full screen in the streaming Chrome |`;
it becomes
`| Direct streaming | \`direct_stream_find\`, \`direct_stream_play\`, \`direct_stream_sources\` | \`direct_stream_play\` opens the player page full screen in the streaming Chrome; \`direct_stream_update_source\` is Claude Code's \`/update-cloud-source\` only |`.
**File:** `docs/guide/reference/mcp-tools.md`: run `npm run docs:gen`; never hand-edit.
**Impact:** `npm run docs:check` stays green (no route, no env var).

### Step 14: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3's file): one bullet at
the end of its `## Sub-features` list and one at the end of `## Driving it`.
**Code:**
```markdown
- `/update-cloud-source <site url>` (`direct_stream_update_source`) and `direct_stream_sources`:
  read an aggregator site's provider templates, add the ones the registry lacks (matched by
  template host and path), probe each new one against the known titles, report per provider; a
  site that cannot be read changes nothing. Reader proven over the real fmovies chunk by
  `npx vitest run tests/unit/scripts/directTemplates.test.ts`; insert-once, untouched rows,
  probes and the unchanged registry by
  `npm run test:int -- tests/integration/directStream.updateSource.int.test.ts`; the tools and
  the chat bar's exclusion by `tests/unit/mcp.directStreamSourceTools.test.ts` and
  `tests/unit/chat-status.test.ts`.
```
```markdown
- Live template read, free, no browser:
  `node claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/` prints `ok: true`
  and the 24 providers. Never run `direct_stream_update_source` against the live daemon for a
  site with new providers unless the owner asked: it writes the shared registry and probes in
  the streaming Chrome.
```
**Impact:** the verifier finds this phase's proof.

## Principles applied

- Laziness protocol: the brief's second strategy (Chrome frames behind server buttons) is not built and is named as such in every failure answer; no `chunk-map.json` reader; the probe reuses phase 3's `runResolve` and phase 1's `resolve --only` instead of a probe command.
- Boundary discipline: the reader's JSON is parsed once by `TemplatesAnswerSchema` in `updateSource`; the site address is validated once by zod in the tool; inside, both are trusted.
- Make illegal states unrepresentable: `UpdateSourceAnswer` is a union where failure carries `registry_changed: false` as a literal; insertion can only happen on the `ok: true` branch, after the known titles loaded.
- Test behavior, not implementation: the registry claims are proven by reading `stream_providers` rows back from Postgres (not by spying on an insert), and the reader is tested on the real fmovies chunk and a fake site served over a fake `fetch`.
- Encode lessons in structure: "the chat bar never calls update_source" is `CLAUDE_CODE_ONLY_TOOL_NAMES`, filtered in `allowedChatTools` and pinned by a test, not a prompt sentence.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test && npm run test:int -- tests/integration/directStream.updateSource.int.test.ts && npm run docs:check`
**Proof:** the reader against the real fmovies chunk and the live site; the update logic against
real Postgres with a fake runner; the tools through a throwaway daemon's MCP list.
- Harness: `.claude/skills/verify-notesd` (the MCP list and the off answer on a throwaway
  daemon); the live template read is a plain CLI run (free, no browser, no daemon)
- Feature-map entries: `features/direct-streaming.md`, `features/streaming.md` (neighbor)
- Journeys:
  - **J1** · traces R4.1 — `node claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/ > "$SCRATCH/fm.json"; echo "exit=$?"; jq -r '.ok, (.providers|length), (.providers[]|select(.name=="VidFast")|.movie)' "$SCRATCH/fm.json"` → passes when it prints `exit=0`, `true`, a number of at least `24`, and `https://vidfast.pro/movie/{id}?autoPlay=true` (inconclusive, not failed, when the site itself does not answer: then run J2's first file alone)
  - **J2** · traces R4.1 — `npx vitest run tests/unit/scripts/directTemplates.test.ts tests/unit/directStream.updateSource.test.ts` → passes when every test passes, including "finds the 24 named film templates in the fmovies movie-details chunk" over `docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js` and "follows the page to its webpack runtime and the movie-details chunk"
  - **J3** · traces R4.1 — `npm run test:int -- tests/integration/directStream.updateSource.int.test.ts -t "adds only what the registry lacks|inserts once"` → passes when both tests pass: after one run `stream_providers` holds 4 rows, the 2 planted rows read back equal to before, `Fresh` has `originSite = https://ww6-fmovies.example`, the probe ran 5 times in the asserted order, and a second run adds and probes nothing
  - **J4** · traces R4.2 — `node claude/streaming/direct/cli.mjs templates https://example.com/; echo "exit=$?"` → passes when the printed JSON has `"ok": false` and `"error": "no_templates"` with a `detail` containing `not built`, and the last line is `exit=1`
  - **J5** · traces R4.2 — `npm run test:int -- tests/integration/directStream.updateSource.int.test.ts -t "leaves the registry unchanged|writes nothing"` → passes when all five cases pass: for a bot check, no template, a crashed reader, a reader that printed other JSON and unreadable known titles, the answer is `ok: false` with the named error (or a rejection), the `stream_providers` rows read back identical, and no probe ran
  - **J6** · traces R4.1 — `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up` then `$V mcp RUN --list | grep -E 'direct_stream_(sources|update_source)'` and `$V mcp RUN direct_stream_update_source '{"site":"not a url"}'`, then `$V down RUN` → passes when both tool names are listed and the bad address answers a validation error (the daemon serves the tools the skill calls)
- Neighbor check: the existing streaming tools and the chat allow list — `npx vitest run tests/unit/mcp.streamingTools.test.ts tests/unit/streaming.test.ts tests/unit/chat-status.test.ts tests/unit/chat-agent.test.ts` passes, and on the J6 run `$V mcp RUN --list` still lists `streaming_find`, `streaming_play`, `direct_stream_find` and `direct_stream_play`
- Cost: none billed. J1 makes about 41 plain requests to ww6-fmovies.com; nothing opens Chrome
**Exit criteria:** the reader prints the 24 fmovies providers from the real chunk and from the
live site; with a fake runner against real Postgres, new providers are inserted once with
`origin_site`, existing rows read back unchanged, each new one is probed against the known
titles, and every unreadable-site case leaves the table identical; `direct_stream_sources` and
`direct_stream_update_source` are registered, the chat bar's allow list has the first and not
the second; `npm test`, `npm run typecheck` and `npm run docs:check` pass.

## Handoffs

- **Phase 2 (settled by the reconciler):** phase 2 creates `claude/streaming/direct/known-titles.json`
  in the shape under Requires; its `campaign.mjs` and this phase's `loadKnownTitles` both read it.
- **Phase 2 (information):** this phase's reader, run against the live ww6-fmovies.com on
  2026-11-15, found an episode template for every one of the 24 providers (e.g.
  `https://vidfast.pro/tv/{id}/{season}/{episode}?autoPlay=true`,
  `https://vidsrc.me/embed/tv?tmdb={id}&season={season}&episode={episode}`,
  `https://vidsrc.wtf/api/1/tv/?id={id}&s={season}&e={episode}&color=215fb3`). Phase 2's
  "candidate episode templates per provider" can start from the site's own, not guesses. The
  scratch script that produced it is the code in Step 1.
- **Phase 3 (settled by the reconciler):** `runResolve(ref, { only })` records health and never runs
  phase 5's `recordResolve` hook; seed load follows phase 3's rule (seed rows inserted and updated,
  rows with `origin_site` never touched), which keeps every provider this phase adds; the runner
  hands back stdout on exit 1 with a 20-minute timeout. Names as phase 3 writes them: `providers()`,
  `runResolve`, `StreamRef`, `ResolveOutput`, the Drizzle columns.
- **Phase 3 (feature map / guide):** this phase appends to `features/direct-streaming.md` and to the
  `## Direct streaming` section; both must exist.
- **Phase 7 (settled by the reconciler):** this phase extends `DIRECT_STREAM_TOOL_NAMES` to four,
  filters the allow list through `CLAUDE_CODE_ONLY_TOOL_NAMES`, extends phase 7's
  `DirectStreamToolDeps` / `directStreamToolDeps` with `providers` and `updateSource` (and its
  test's `fakeDeps`), edits phase 7's chat-status count test, both of its `chat.md` rows and its
  `SKILL_NAMES` line, and adds one call at the end of `registerDirectStreamTools`. Phase 7's chat
  prompt and MCP instructions name only `direct_stream_find` / `direct_stream_play`, so they
  promise nothing about adding providers.
- **Phase 10:** a provider added here starts with no health on either machine; the prober may
  want to re-probe providers whose `origin_site` is set and whose health is empty on its host
  (the other laptop's view of a provider this laptop added).
- **Later task (not in this set):** the Chrome-frames reader for sites whose scripts hold no
  readable template; a CRA/Next.js chunk discovery (`static/js/*.chunk.js`, `_buildManifest.js`)
  beside the Gatsby one.

## Rollback

Revert the phase's commits. No migration is added: `stream_providers` rows this phase inserted
stay and are harmless (they are ordinary registry rows); to remove them,
`delete from stream_providers where origin_site is not null` on the shared database. The skill
link under `~/.claude/skills/update-cloud-source` goes away on the next `scripts/install.sh`
after the folder is gone.

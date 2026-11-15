import { z } from 'zod';
import { runJsonScript } from '../streaming/service.js';
import { absoluteHttp } from './rewrite.js';
import {
  DirectStreamError,
  MANIFEST_KINDS,
  RESOLVE_OUTCOMES,
  isEnglish,
  type ResolveAttempt,
  type ResolveOutput,
  type SubtitleTrack,
} from './types.js';

/** A whole resolve can try 24 providers at up to ~45 s each (phase 1); a single `--only` try is far shorter. */
export const DIRECT_STREAM_TIMEOUT_MS = 1_200_000;

/**
 * Runs `claude/streaming/direct/cli.mjs <args...>` and returns the one JSON object it prints, also on
 * a non-zero exit. The daemon never talks to a provider or to Chrome itself; tests inject a fake.
 */
export type DirectStreamRunner = (args: string[]) => Promise<unknown>;

export interface DirectStreamScriptOptions {
  cliPath: string;
  /** Default: the node running the daemon. */
  nodeBin?: string;
  timeoutMs?: number;
}

export function directStreamScriptRunner(options: DirectStreamScriptOptions): DirectStreamRunner {
  const nodeBin = options.nodeBin ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DIRECT_STREAM_TIMEOUT_MS;
  return (args) => runJsonScript({ label: 'direct stream script', nodeBin, argv: [options.cliPath, ...args], timeoutMs });
}

const attemptSchema = z.object({
  provider: z.string().min(1),
  outcome: z.enum(RESOLVE_OUTCOMES),
  took_s: z.number().nonnegative().nullish(),
  detail: z.string().nullish(),
});

const subtitleSchema = z.object({
  url: z.string(),
  lang: z.string().nullish(),
  label: z.string().nullish(),
  format: z.string().nullish(),
  source: z.enum(['request', 'manifest']).nullish(),
});

const sourceSchema = z.object({
  provider: z.string().min(1),
  embed_url: z.string().nullish(),
  manifest_url: z.string().refine((u) => absoluteHttp(u) !== null, 'manifest_url must be an http(s) address'),
  manifest_kind: z.enum(MANIFEST_KINDS),
  headers: z.object({ referer: z.string().nullish(), origin: z.string().nullish(), user_agent: z.string().nullish() }).nullish(),
  subtitles: z.array(subtitleSchema).nullish(),
  best_height: z.number().int().positive().nullish(),
  en_subtitle: z.boolean().nullish(),
  took_s: z.number().nonnegative().nullish(),
});

const outputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), source: sourceSchema, attempts: z.array(attemptSchema).nullish() }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    detail: z.string().nullish(),
    message: z.string().nullish(),
    attempts: z.array(attemptSchema).nullish(),
  }),
]);

const openSchema = z.object({ ok: z.boolean(), error: z.string().nullish(), detail: z.string().nullish(), message: z.string().nullish() });

const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value);

function toAttempt(a: z.infer<typeof attemptSchema>): ResolveAttempt {
  return { provider: a.provider, outcome: a.outcome, took_s: a.took_s ?? null, detail: a.detail ?? '' };
}

/**
 * The resolver's printed answer, validated once here (the boundary) and normalized: header values are
 * null when not sent, subtitle tracks that are not http(s) are dropped, `en_subtitle` is computed when
 * the resolver left it out. An answer that does not fit throws `resolve_failed` / `bad_output`.
 */
export function parseResolveOutput(raw: unknown): ResolveOutput {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ');
    throw new DirectStreamError('resolve_failed', `The resolver printed an answer notesd cannot read: ${issues}`, { reason: 'bad_output' });
  }
  const out = parsed.data;
  const attempts = (out.attempts ?? []).map(toAttempt);
  if (!out.ok) return { ok: false, source: null, error: out.error, detail: out.detail ?? out.message ?? '', attempts };
  const s = out.source;
  const subtitles: SubtitleTrack[] = [];
  for (const t of s.subtitles ?? []) {
    const url = absoluteHttp(t.url);
    if (url === null) continue;
    subtitles.push({ url, lang: present(t.lang), label: t.label ?? '', format: (t.format ?? 'vtt').toLowerCase(), source: t.source ?? 'request' });
  }
  return {
    ok: true,
    attempts,
    source: {
      provider: s.provider,
      embed_url: s.embed_url ?? '',
      manifest_url: s.manifest_url,
      manifest_kind: s.manifest_kind,
      headers: { referer: present(s.headers?.referer), origin: present(s.headers?.origin), user_agent: present(s.headers?.user_agent) },
      subtitles,
      best_height: s.best_height ?? null,
      en_subtitle: s.en_subtitle ?? subtitles.some(isEnglish),
      took_s: s.took_s ?? null,
    },
  };
}

export type OpenOutput = { ok: true } | { ok: false; error: string; detail: string };

/** `cli.mjs open`'s answer. One that does not fit is an `open` failure named `bad_output`. */
export function parseOpenOutput(raw: unknown): OpenOutput {
  const parsed = openSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_output', detail: 'the resolver printed an answer notesd cannot read' };
  if (parsed.data.ok) return { ok: true };
  return { ok: false, error: parsed.data.error ?? 'open_failed', detail: parsed.data.detail ?? parsed.data.message ?? '' };
}

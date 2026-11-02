/**
 * Secret redaction for everything session summaries send off the machine (the Haiku summarizer,
 * the OpenRouter embedder) or store (`cc_sessions.summary`). Pure; no I/O.
 *
 * Over-redacting is fine: the output is only used for a summary and a search vector. Hex-only
 * strings (commit shas, sha256 digests) are kept on purpose, they are useful and not secrets.
 */

export const REDACTED = '[redacted]';

/** PEM private keys, whole block. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** scheme://user:password@host -> scheme://[redacted]@host (postgres, mysql, redis, amqp, mongodb, https...). */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/'"`]+:[^\s@/'"`]+@/gi;

/** Authorization / Proxy-Authorization header values, any scheme. */
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi;

/** Bare bearer tokens anywhere ("-H 'Bearer abc'"). */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Well-known token shapes. Order matters only for readability; each is replaced whole. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{10,}/g, // OpenRouter
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/**
 * KEY=value / KEY: value where the key names a secret: .env lines, shell exports, YAML, JSON,
 * query strings. Group 1 keeps the key and separator, the value is replaced.
 */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?token|session[_-]?key|dsn|database[_-]?url|connection[_-]?string|signing[_-]?key)[A-Za-z0-9_.-]*`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`((?:^|[\s{,;&?(])(?:export\s+)?["']?${SECRET_KEY}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&)}]+)`,
  'gim',
);

/** UPPER_CASE=value lines from .env files whose value looks like a credential (long, mixed). */
const ENV_LINE = /^((?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*)(["']?)([^\s"'#]{16,})\2/gm;

/** Long opaque tokens: >= 32 chars of [A-Za-z0-9_+=-] with upper, lower and digit, not pure hex. */
const OPAQUE = /(?<![A-Za-z0-9_+=/-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=/-])/g;

function looksOpaque(s: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(s)) return false;
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

/** `text` with every recognised secret replaced by `[redacted]`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, `${REDACTED} private key`);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(AUTH_HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SECRET_ASSIGNMENT, (_m, head: string, value: string) =>
    value === REDACTED || value === `"${REDACTED}"` || value === `'${REDACTED}'` ? `${head}${value}` : `${head}${REDACTED}`,
  );
  out = out.replace(ENV_LINE, (m, head: string, quote: string, value: string) =>
    looksOpaque(value) || /[a-z]/.test(value) && /\d/.test(value) && value.length >= 24 ? `${head}${quote}${REDACTED}${quote}` : m,
  );
  out = out.replace(OPAQUE, (m) => (looksOpaque(m) ? REDACTED : m));
  return out;
}

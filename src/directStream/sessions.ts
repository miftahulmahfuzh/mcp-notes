import { randomBytes } from 'node:crypto';
import { absoluteHttp } from './rewrite.js';
import type { ResolveAttempt, ResolvedSource, StreamRef } from './types.js';

/** A session ends this long after its last request (the player fetches every few seconds while it plays). */
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
/** ... and this long after it began, whatever happens. */
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** More live sessions than this: the least recently used goes. */
export const MAX_SESSIONS = 32;
/** 24 random bytes, base64url: 32 characters, 192 bits. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** One resolved title the player may stream. In memory only: a daemon restart ends every session. */
export interface StreamSession {
  readonly id: string;
  readonly ref: StreamRef;
  source: ResolvedSource;
  /** The last resolve's attempts, as the resolver printed them. */
  attempts: ResolveAttempt[];
  /** `URL.host` (with port) of every host this session may fetch. */
  allowedHosts: Set<string>;
  /** Where the player starts, in seconds; null: from the start. */
  resumeS: number | null;
  readonly createdAt: Date;
  refreshedAt: Date;
  lastUsedAt: Date;
}

function hostOf(url: string): string | null {
  const abs = absoluteHttp(url);
  return abs === null ? null : new URL(abs).host.toLowerCase();
}

/** The hosts a resolve returned: the manifest's and every subtitle track's. */
export function sourceHosts(source: ResolvedSource): Set<string> {
  const hosts = new Set<string>();
  for (const url of [source.manifest_url, ...source.subtitles.map((t) => t.url)]) {
    const host = hostOf(url);
    if (host !== null) hosts.add(host);
  }
  return hosts;
}

/** True when `url` is http(s) on a host this session may fetch. */
export function allows(session: StreamSession, url: string): boolean {
  const host = hostOf(url);
  return host !== null && session.allowedHosts.has(host);
}

/** Lets the session fetch `url`'s host. Called only with addresses named by an answer fetched through the session. */
export function learn(session: StreamSession, url: string): void {
  const host = hostOf(url);
  if (host !== null) session.allowedHosts.add(host);
}

export class SessionStore {
  private readonly sessions = new Map<string, StreamSession>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(ref: StreamRef, source: ResolvedSource, attempts: ResolveAttempt[], resumeS: number | null = null): StreamSession {
    this.sweep();
    const at = this.now();
    const session: StreamSession = {
      id: randomBytes(24).toString('base64url'),
      ref,
      source,
      attempts,
      allowedHosts: sourceHosts(source),
      resumeS,
      createdAt: at,
      refreshedAt: at,
      lastUsedAt: at,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: StreamSession | null = null;
      for (const s of this.sessions.values()) if (oldest === null || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
      if (oldest === null) break;
      this.sessions.delete(oldest.id);
    }
    return session;
  }

  /** The live session with this id, marked used now; null when the id is malformed, unknown or ended. */
  get(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const now = this.now();
    if (now.getTime() >= this.expiresAt(session).getTime()) {
      this.sessions.delete(id);
      return null;
    }
    session.lastUsedAt = now;
    return session;
  }

  /** A refresh: the new source, its hosts added to the ones the session already had. */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
  }

  expiresAt(session: StreamSession): Date {
    return new Date(Math.min(session.lastUsedAt.getTime() + SESSION_IDLE_MS, session.createdAt.getTime() + SESSION_MAX_MS));
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [id, session] of this.sessions) if (now >= this.expiresAt(session).getTime()) this.sessions.delete(id);
  }
}

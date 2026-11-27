import { PlayStats } from './playStats';
import { INITIAL_STATE, type ControllerDeps, type PlayerHost, type StreamState } from './playerState';
import type { StreamSession } from './session';

/**
 * A PlayerHost for the module tests (*.test.tsx beside each module): the state and session the test
 * sets, every note and failure recorded. Never imported by the page itself.
 */
export interface FakeHost extends PlayerHost {
  notes: string[];
  failures: unknown[];
  current: StreamState;
  currentSession: StreamSession | null;
  currentId: string;
  isDisposed: boolean;
  lastPosition: number;
  stats(): PlayStats;
}

export function fakeHost(video: HTMLVideoElement, deps: Partial<ControllerDeps> = {}, over: { muted?: boolean; now?: () => number } = {}): FakeHost {
  const playStats = new PlayStats(over.now ?? (() => 0), 'L');
  const host: FakeHost = {
    video,
    deps: {
      fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
      createEngine: async () => {
        throw new Error('no engine in a module test');
      },
      textUrl: () => 'blob:x',
      revokeTextUrl: () => {},
      ...deps,
    },
    muted: over.muted === true,
    notes: [],
    failures: [],
    current: INITIAL_STATE,
    currentSession: null,
    currentId: 'S1',
    isDisposed: false,
    lastPosition: 0,
    sessionId: () => host.currentId,
    session: () => host.currentSession,
    state: () => host.current,
    set: (patch) => {
      host.current = { ...host.current, ...patch };
    },
    note: (line) => {
      host.notes.push(line);
    },
    fail: (err) => {
      host.failures.push(err);
      host.current = { ...host.current, stage: 'error' };
    },
    disposed: () => host.isDisposed,
    onFilm: () => host.current.stage === 'ready' || host.current.stage === 'recovering',
    stats: () => playStats,
    lastPositionS: () => host.lastPosition,
  };
  return host;
}

/** A session as parseSession gives it, for the module tests. */
export function fakeSession(over: Partial<StreamSession> = {}): StreamSession {
  return {
    id: 'S1',
    title: 'Fight Club (1999)',
    manifestUrl: '/m.m3u8',
    manifestKind: 'hls',
    subtitles: [],
    resumeS: 0,
    audioTrack: null,
    prevEpisode: null,
    nextEpisode: null,
    cached: null,
    torrent: null,
    subtitleRev: 0,
    sourceRev: 0,
    previewRev: 0,
    sourceNote: null,
    ref: { kind: 'movie', tmdbId: 550 },
    provider: 'VidFast',
    ...over,
  };
}

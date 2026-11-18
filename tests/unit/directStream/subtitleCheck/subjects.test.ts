import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { CHECKED_LABEL } from '../../../../src/directStream/subtitleCheck/checker.js';
import { CheckError, CheckSubjects, type SubjectDeps } from '../../../../src/directStream/subtitleCheck/subjects.js';
import { TITLE_OUTSIDE_NAME, TitleSubtitleShelf } from '../../../../src/directStream/titleSubtitles.js';
import { SubtitleShelf } from '../../../../src/directStream/torrent/subtitles/disk.js';
import type { StreamRef } from '../../../../src/directStream/types.js';

const HASH = 'a'.repeat(40);
const REF: StreamRef = { kind: 'tv', tmdbId: 1413, season: 1, episode: 2 };
const vtt = (line: string): string => 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n' + line + '\n\n00:00:04.000 --> 00:00:06.000\n' + line + ' again\n\n00:00:07.000 --> 00:00:09.000\n' + line + ' once more\n';

describe('CheckSubjects', () => {
  let dir: string;
  let torrentShelf: SubtitleShelf;
  let titleShelf: TitleSubtitleShelf;
  let cancelled: string[];
  let sessions: Map<string, StreamSession>;
  let screen: { sessionId: string; durationS: number | null } | null;
  let resolved: number;
  let onDisk: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'subjects-'));
    torrentShelf = new SubtitleShelf(path.join(dir, 'torrents'));
    titleShelf = new TitleSubtitleShelf(path.join(dir, 'titles'));
    cancelled = [];
    sessions = new Map();
    screen = null;
    resolved = 0;
    onDisk = true;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const torrentSession = (id: string, subtitles: StreamSession['torrent'] extends infer T ? (T extends { subtitles: infer S } ? S : never) : never): StreamSession =>
    ({
      id,
      ref: REF,
      audioLang: 'en',
      source: { provider: 'Torrent', subtitles: [] },
      cache: null,
      torrent: { infoHash: HASH, fileIndex: 1, name: 'Show S01 1080p BluRay', durationS: 2564, imdbId: 'tt1844624', subtitles, subtitleRev: 1 },
      outside: { subtitles: [], subtitleRev: 0, stop: new AbortController() },
    }) as unknown as StreamSession;
  const cloudSession = (id: string): StreamSession =>
    ({ id, ref: REF, audioLang: 'ko', source: { provider: 'VidLink', subtitles: [] }, cache: null, torrent: null, outside: { subtitles: [], subtitleRev: 0, stop: new AbortController() } }) as unknown as StreamSession;

  const subjects = (own: { label: string; vtt: string } | null = null): CheckSubjects => {
    const deps: SubjectDeps = {
      directStream: {
        session: (id: string) => sessions.get(id) ?? null,
        resolve: async () => {
          resolved += 1;
          const s = cloudSession('resolved');
          sessions.set(s.id, s);
          return s;
        },
        audioInput: (id: string) => ({ url: 'https://host.fixture/' + id + '.m3u8', inputArgs: ['-user_agent', 'UA'] }),
        ownSubtitleText: async () => own,
      } as unknown as SubjectDeps['directStream'],
      torrents: {
        find: async () => ({ infoHash: HASH, host: 'here', name: 'Show S01', release: 'Show S01 1080p BluRay', fileIndex: 1, fileLength: 1, state: 'ready', durationS: 2564 }),
        filePath: async () => (onDisk ? '/data/torrents/show.mkv' : null),
        localUrl: (hash: string, index: number) => '/api/stream/torrent/' + hash + '/f/' + index,
      } as unknown as SubjectDeps['torrents'],
      torrentShelf,
      titleShelf,
      services: { baseUrl: null, wyzie: null, fetch: async () => new Response('', { status: 500 }) },
      localBase: () => 'http://127.0.0.1:7317',
      onScreen: () => screen,
      imdbId: async () => 'tt1844624',
      audioLang: async () => 'en',
      titleLabel: async () => 'Show S01E02',
      cancelSync: (key) => cancelled.push(key),
    };
    return new CheckSubjects(deps);
  };

  it("a torrent session on screen: reads its shown subtitle, and a kept one replaces it on the session", async () => {
    const shown = await torrentShelf.save(HASH, 'service-wyzie-1.vtt', vtt('the pilot'), { lang: 'en', label: 'English (Wyzie)' });
    const session = torrentSession('live', [shown]);
    sessions.set('live', session);
    screen = { sessionId: 'live', durationS: 2564 };
    const s = await subjects().build({ ref: REF });
    expect(s).toMatchObject({ mode: 'live', source: 'torrent', sessionId: 'live', durationS: 2564, audioLang: 'en', title: 'Show S01E02', key: HASH + '-1' });
    expect(await s.input()).toEqual({ url: '/data/torrents/show.mkv' });
    expect(await s.current()).toEqual({ label: 'English (Wyzie)', vtt: vtt('the pilot') });
    const view = await s.keep(vtt('home invasion'));
    expect(view.label).toBe(CHECKED_LABEL);
    expect(view.url).toMatch(/\/sub\/checked-1-[0-9a-f]{8}\.vtt$/);
    expect(session.torrent!.subtitles).toEqual([view]);
    expect(session.torrent!.subtitleRev).toBe(2);
    expect(cancelled).toEqual([HASH + '-1']);
    // The next play's kept tier answers it.
    expect(await torrentShelf.kept(HASH)).toEqual([view]);
  });

  it('a torrent still downloading is heard through the file route, and a growing track is not read', async () => {
    onDisk = false;
    sessions.set('live', torrentSession('live', [{ url: '/api/stream/torrent/' + HASH + '/cues/whisper-1', lang: 'en', label: 'English (Whisper)', growing: true }]));
    const s = await subjects().build({ session: 'live' });
    expect(s.mode).toBe('idle');
    expect(await s.input()).toEqual({ url: 'http://127.0.0.1:7317/api/stream/torrent/' + HASH + '/f/1' });
    expect(await s.current()).toMatchObject({ label: 'English (Whisper)', skip: expect.stringContaining('grows') });
  });

  it("idle: this machine's finished download is checked from disk, with its kept subtitle", async () => {
    await torrentShelf.save(HASH, 'synced-1.vtt', vtt('kept'), { lang: 'en', label: 'English (Wyzie, synced)' });
    const s = await subjects().build({ ref: REF });
    expect(s).toMatchObject({ mode: 'idle', source: 'torrent', sessionId: null });
    expect(await s.current()).toEqual({ label: 'English (Wyzie, synced)', vtt: vtt('kept') });
    expect(resolved).toBe(0);
  });

  it('idle with no finished download: a torrent asked for is no_audio, otherwise a cloud source is resolved out of sight', async () => {
    onDisk = false;
    await expect(subjects().build({ ref: REF, source: 'torrent' })).rejects.toMatchObject({ code: 'no_audio' });
    const s = await subjects().build({ ref: REF });
    expect(resolved).toBe(1);
    expect(s).toMatchObject({ mode: 'idle', source: 'cloud', provider: 'VidLink', sessionId: 'resolved', audioLang: 'ko' });
    expect(await s.input()).toEqual({ url: 'https://host.fixture/resolved.m3u8', inputArgs: ['-user_agent', 'UA'] });
  });

  it("a cloud session: the provider's own English track is what is shown, and a kept file stands in for it from then on", async () => {
    const session = cloudSession('cloud');
    sessions.set('cloud', session);
    screen = { sessionId: 'cloud', durationS: 5400 };
    const s = await subjects({ label: 'English', vtt: vtt('the provider') }).build({ session: 'cloud' });
    expect(s).toMatchObject({ mode: 'live', source: 'cloud', durationS: 5400, key: 'tv-1413-s1e2' });
    expect(await s.current()).toEqual({ label: 'English', vtt: vtt('the provider') });
    const view = await s.keep(vtt('checked'));
    expect(session.outside.subtitles).toEqual([view]);
    expect(session.outside.subtitleRev).toBe(1);
    expect(await titleShelf.replaces(REF)).toBe('VidLink');
    expect(cancelled).toEqual(['tv-1413-s1e2']);
    // Checked again: the kept file is now the one shown.
    expect(await (await subjects({ label: 'English', vtt: vtt('the provider') }).build({ session: 'cloud' })).current()).toEqual({ label: CHECKED_LABEL, vtt: vtt('checked') });
    expect(JSON.parse(await readFile(path.join(dir, 'titles', 'tv-1413-s1e2', 'chosen.json'), 'utf8'))).toMatchObject({ label: CHECKED_LABEL, replaces: 'VidLink' });
  });

  it("a cloud session with no English track of its own: the title's outside file is shown, and a kept one replaces no provider's", async () => {
    await titleShelf.save(REF, TITLE_OUTSIDE_NAME, vtt('outside'), 'English (Wyzie)');
    sessions.set('cloud', cloudSession('cloud'));
    const s = await subjects(null).build({ session: 'cloud' });
    expect(await s.current()).toEqual({ label: 'English (Wyzie)', vtt: vtt('outside') });
    await s.keep(vtt('checked'));
    expect(await titleShelf.replaces(REF)).toBeNull();
    expect((await titleShelf.kept(REF))?.label).toBe(CHECKED_LABEL);
  });

  it('an unknown session is an error', async () => {
    await expect(subjects().build({ session: 'gone' })).rejects.toBeInstanceOf(CheckError);
  });

  it('names one job for a title and for its session on screen', () => {
    sessions.set('live', torrentSession('live', []));
    const s = subjects();
    expect(s.keyOf({ ref: REF })).toBe('tv-1413-s1e2-any');
    screen = { sessionId: 'live', durationS: null };
    expect(s.keyOf({ ref: REF })).toBe('session-live');
    expect(s.keyOf({ session: 'live' })).toBe('session-live');
  });
});

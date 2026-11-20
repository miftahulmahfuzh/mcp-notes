import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { DUB_GROUPS, dubGroupIn, dubGroupOfName } from '../../../../../src/directStream/torrent/find/dubGroups.js';
import { rankCandidates } from '../../../../../src/directStream/torrent/find/rank.js';
import { parseRelease } from '../../../../../src/directStream/torrent/find/release.js';
import type { TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const ETERNALLY: TorrentQuery = { kind: 'tv', imdbId: 'tt0000001', season: 1, episode: 7, title: 'Eternally Yours', originalLanguage: 'en' };
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex');

describe('dub groups by name', () => {
  it('lists every group once, each spelled in lower-case letters and digits', () => {
    const spellings = DUB_GROUPS.flatMap((g) => g.spellings);
    expect(new Set(spellings).size).toBe(spellings.length);
    for (const s of spellings) expect(s).toMatch(/^[a-z0-9]+$/);
    for (const g of DUB_GROUPS) expect(g.language).toMatch(/^[a-z]{2}$/);
  });

  it.each([
    ['Eternally.Yours.S01E07.1080p.ColdFilm.mkv', 'ColdFilm'],
    ['Eternally Yours S01E07 1080p WEB-DL LostFilm.TV', 'LostFilm'],
    ['Eternally.Yours.S01.1080p.HDRezka.Studio', 'HDRezka'],
    ['Eternally.Yours.S01E07.WEBRip.1080p.NewStudio', 'NewStudio'],
    ['Eternally Yours S01E07 Kubik v Kube 1080p', 'Kubik v Kube'],
    ['Eternally.Yours.S01E07.1080p.BaibaKo', 'BaibaKo'],
  ])('reads %s as a dub by %s', (name, group) => {
    const release = parseRelease(name, { title: 'Eternally Yours', originalLanguage: 'en' });
    expect(release.dubGroup).toBe(group);
    expect(release.dubbed).toBe(true);
    expect(release.languages).toContain('ru');
    expect(dubGroupOfName(name)?.name).toBe(group);
  });

  it('is no dub when the name also says the original is there (dual audio)', () => {
    const release = parseRelease('Eternally.Yours.S01E07.1080p.LostFilm.Rus.Eng', { title: 'Eternally Yours', originalLanguage: 'en' });
    expect(release.dubGroup).toBe('LostFilm');
    expect(release.dubbed).toBe(false);
    expect(release.multiAudio).toBe(true);
  });

  it('is no dub for a title made in the group language', () => {
    expect(parseRelease('Slovo.Patsana.S01E01.1080p.ColdFilm', { title: 'Slovo Patsana', originalLanguage: 'ru' }).dubbed).toBe(false);
  });

  it('never reads a group out of the title itself or out of a plain release', () => {
    expect(parseRelease('Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL', { title: 'Eternally Yours', originalLanguage: 'en' }).dubGroup).toBeNull();
    expect(dubGroupIn(['the', 'coldfilm', 'story'])?.name).toBe('ColdFilm');
    expect(parseRelease('Coldfilm.2020.1080p.WEB.x264', { title: 'Coldfilm', originalLanguage: 'en' }).dubGroup).toBeNull();
  });

  it('sends a group release to the last-resort round, as a name that says dub', () => {
    const proper = candidateFrom({ infoHash: hashOf('a'), name: 'Eternally.Yours.S01E07.1080p.WEB.h264-ETHEL', seeds: 40, sizeBytes: 1e9 }, 'torrentio', ETERNALLY, true);
    const cold = candidateFrom({ infoHash: '67b07b417f6f8f7d367bbded3cd797a0840724b6', name: 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv', seeds: 90, sizeBytes: 1e9 }, 'torrentio', ETERNALLY, true);
    const ranked = rankCandidates([proper, cold], ETERNALLY);
    expect(ranked.kept.map((c) => c.name)).toEqual([proper.name]);
    expect(ranked.lastResort.map((c) => c.infoHash)).toEqual([cold.infoHash]);
    expect(ranked.excluded).toEqual([expect.objectContaining({ infoHash: cold.infoHash, reason: 'dubbed' })]);
  });
});

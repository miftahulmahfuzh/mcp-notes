import { describe, expect, it } from 'vitest';
import { episodeFit, parseEpisodeRef, parseRelease } from '../../../../../src/directStream/torrent/find/release.js';

const DUNE = { title: 'Dune: Part Two', originalLanguage: 'en' };

describe('parseRelease', () => {
  it.each([['Dune.Part.Two.2024.HDCAM.x264-GRP'], ['Dune Part Two 2024 1080p TELESYNC'], ['Dune.Part.Two.2024.HDTS.x264'], ['Dune.Part.Two.2024.TS.x264'], ['Dune Part Two 2024 CAM']])(
    'marks a cinema recording: %s',
    (name) => {
      expect(parseRelease(name, DUNE).cam).toBe(true);
    },
  );

  it.each([['Avatar.2009.1080p.3D.HSBS.BluRay.x264'], ['Avatar 2009 1080p Half-SBS']])('marks 3D: %s', (name) => {
    expect(parseRelease(name, { title: 'Avatar', originalLanguage: 'en' }).threeD).toBe(true);
  });

  it.each([
    ['Dune.Part.Two.2024.1080p.Hindi.Dubbed.WEB-DL'],
    ['Dune Part Two (2024) 1080p Latino'],
    ['Dune.Part.Two.2024.TRUEFRENCH.1080p.WEB'],
    ['Dune.Part.Two.2024.iTALiAN.1080p.WEBRip'],
    ['Dune.Part.Two.2024.GERMAN.1080p.WEB'],
    ['Dune Part Two 2024 1080p PT-BR'],
  ])('marks a dub: %s', (name) => {
    expect(parseRelease(name, DUNE).dubbed).toBe(true);
  });

  it('treats a dub marker as a dub even when the original language is unknown', () => {
    expect(parseRelease('Dune.Part.Two.2024.1080p.DUBBED', { title: 'Dune: Part Two' }).dubbed).toBe(true);
    expect(parseRelease('Dune.Part.Two.2024.FRENCH.1080p', { title: 'Dune: Part Two' }).dubbed).toBe(false);
  });

  it.each([
    ['Dune.Part.Two.2024.MULTi.1080p.WEB.x264', DUNE, true],
    ['Dune Part Two 2024 1080p Dual-Audio Hindi English', DUNE, true],
    ['Dune.Part.Two.2024.GERMAN.DL.1080p.WEB', DUNE, true],
    ['Breaking.Bad.S01.720p.BRRip.Hindi-English.ESUB', { title: 'Breaking Bad', originalLanguage: 'en' }, true],
    ['Sintel.2010.720p.SWESUB.x264-SMS', { title: 'Sintel', originalLanguage: 'en' }, false],
    ['Breaking Bad PT-BR Legendado 720p', { title: 'Breaking Bad', originalLanguage: 'en' }, false],
    ['Amelie.2001.FRENCH.1080p.BluRay', { title: 'Amelie', originalLanguage: 'fr' }, false],
  ])('keeps a release that carries the original track: %s', (name, context, multiAudio) => {
    const info = parseRelease(name, context);
    expect(info.dubbed).toBe(false);
    expect(info.multiAudio).toBe(multiAudio);
  });

  it('never reads a title word as a marker', () => {
    expect(parseRelease('The French Dispatch 2021 1080p WEB', { originalLanguage: 'en' }).dubbed).toBe(false);
    expect(parseRelease('Cam.2018.1080p.WEB.x264', { title: 'Cam', originalLanguage: 'en' }).cam).toBe(false);
    expect(parseRelease('Step Up 3D 2010 1080p BluRay', { title: 'Step Up 3D', originalLanguage: 'en' }).threeD).toBe(false);
    expect(parseRelease('Hindi Medium 2017 1080p WEB', { title: 'Hindi Medium', originalLanguage: 'hi' }).dubbed).toBe(false);
  });

  it('says a release plays in Chrome as is only for H.264 with AAC in MP4', () => {
    const yts = parseRelease('Sintel 2010 720p BluRay', { fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4' });
    expect(yts).toMatchObject({ direct: true, height: 720, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', source: 'bluray' });
    expect(parseRelease('Sintel.1080p.h264.AAC').direct).toBe(false);
    expect(parseRelease('Breaking.Bad.S01.1080p.BluRay.x265-RARBG', { fileName: 'Breaking.Bad.S01E01.1080p.BluRay.x265-RARBG.mp4' }).direct).toBe(false);
    expect(parseRelease('Movie.2020.1080p.WEB.x264.AAC.MULTi', { fileName: 'Movie.2020.1080p.WEB.x264.AAC.MULTi.mp4' }).direct).toBe(false);
    expect(parseRelease('Sintel (2010) [720p] [bluray] [x264] [YTS]', { hints: { container: 'mp4', audioCodec: 'aac' } }).direct).toBe(true);
  });

  it.each([
    ['Sintel.2010.1080p.WEB.H264', 1080],
    ['Sintel 4K UHD', 2160],
    ['Sintel 1744p X264', 2160],
    ['Sintel.2010.820p.H264', 720],
    ['Sintel (2010) Retina edition - h.264 2880x1226', 2160],
    ['Sintel.2010.2K.SURROUND.x264', 1080],
    ['Sintel.2010.HDRip.XviD', null],
  ])('reads the picture height of %s', (name, height) => {
    expect(parseRelease(name).height).toBe(height);
  });
});

describe('parseEpisodeRef', () => {
  it.each([
    ['Breaking.Bad.S01E01.Pilot', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Breaking.Bad.S01E01-07.1080p', { season: 1, seasonTo: null, episode: 1, episodeTo: 7, complete: false }],
    ['Breaking Bad S01 E01-07 BluRay', { season: 1, seasonTo: null, episode: 1, episodeTo: 7, complete: false }],
    ['BB 1x02 Cat', { season: 1, seasonTo: null, episode: 2, episodeTo: null, complete: false }],
    ['Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265)', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: false }],
    ['Breaking.Bad.S01.S02.S03.S04.S05.FRENCH.HDTV', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: false }],
    ['Breaking Bad S01-S05e01-62 (Serie Completa Extra)', { season: 1, seasonTo: 5, episode: null, episodeTo: null, complete: true }],
    ['Breaking Bad 1ª Temporada (2008) BluRay 720p', { season: 1, seasonTo: null, episode: null, episodeTo: null, complete: false }],
    ['Breaking Bad Complete 1080p', { season: null, seasonTo: null, episode: null, episodeTo: null, complete: true }],
    ['Ep 01 - Pilot', { season: null, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['[S01.E01] Breaking Bad - Pilot', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Breaking.Bad.S1.Ep01', { season: 1, seasonTo: null, episode: 1, episodeTo: null, complete: false }],
    ['Sintel.2010.1080p.WEB.H264', { season: null, seasonTo: null, episode: null, episodeTo: null, complete: false }],
  ])('reads %s', (text, ref) => {
    expect(parseEpisodeRef(text)).toEqual(ref);
  });
});

describe('episodeFit', () => {
  it('tells an episode, a pack that holds it, another episode and a name that says nothing apart', () => {
    expect(episodeFit('Breaking.Bad.S01E01.720p', null, 1, 1)).toBe('match');
    expect(episodeFit('Breaking.Bad.S01E02.720p', null, 1, 1)).toBe('other');
    expect(episodeFit('Breaking.Bad.S01-S05.1080p', null, 3, 4)).toBe('pack');
    expect(episodeFit('Breaking.Bad.S01-S05.1080p', null, 6, 1)).toBe('other');
    expect(episodeFit('Breaking Bad Complete 1080p', null, 2, 1)).toBe('pack');
    expect(episodeFit('Breaking Bad S01 Complete - 1080p', 'Ep 01 - Pilot.mkv', 1, 1)).toBe('match');
    expect(episodeFit('Breaking Bad S01 Complete - 1080p', 'Ep 01 - Pilot.mkv', 1, 2)).toBe('other');
    expect(episodeFit('Breaking Bad 1080p', null, 1, 1)).toBe('unknown');
  });
});

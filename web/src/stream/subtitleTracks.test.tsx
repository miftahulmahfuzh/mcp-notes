// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeEngines, fakeVideo, routeFetch } from '../testing/streamFakes';
import { Captions } from './captions';
import { fakeHost, fakeSession } from './fakeHost';
import { PreviewFrames } from './previewFrames';
import { SubtitleTracks, SYNCED_LABEL } from './subtitleTracks';

function setup(files: Record<string, string>) {
  const routes = Object.fromEntries(Object.entries(files).map(([url, text]) => [`GET ${url}`, () => new Response(text)]));
  const { fetchImpl } = routeFetch(routes);
  const { video } = fakeVideo();
  const host = fakeHost(video, { fetch: fetchImpl });
  const captions = new Captions(host);
  const engine = fakeEngines();
  let made: Awaited<ReturnType<typeof engine.createEngine>> | null = null;
  const tracks = new SubtitleTracks({ ...host, engine: () => made, engineReady: () => made !== null }, captions, new PreviewFrames(host));
  return { host, video, tracks, engine: async () => (made = await engine.createEngine({} as never)), made: engine.made };
}

const ready = (subs: { index: number; label: string; lang: string | null }[]) => ({ qualities: [], subtitles: subs });

describe('SubtitleTracks', () => {
  it("puts the files on the video in the session's order and names a file that failed", async () => {
    const t = setup({ '/fr.vtt': 'WEBVTT\n\n', '/en.srt': '1\n00:00:01,000 --> 00:00:02,000\nHi\n' });
    const session = fakeSession({
      subtitles: [
        { url: '/fr.vtt', lang: 'fr', label: 'French', english: false },
        { url: '/en.srt', lang: 'en', label: 'English', english: true },
        { url: '/gone.vtt', lang: 'de', label: 'German', english: false },
      ],
    });
    await t.tracks.loadFiles(session);
    expect([...t.video.querySelectorAll('track')].map((e) => e.label)).toEqual(['French', 'English']);
    expect(t.host.notes).toEqual(['subtitle German: http_404']);
  });

  it("chooses the default English subtitle until the viewer picks, and keeps the viewer's pick while it is there", async () => {
    const t = setup({});
    await t.engine();
    const r = ready([
      { index: 0, label: 'Spanish', lang: 'es' },
      { index: 1, label: 'English', lang: 'en' },
    ]);
    expect(t.tracks.choose(r)).toMatchObject({ subtitle: 'manifest-1' });
    t.host.set({ subtitles: t.tracks.choose(r).subtitles });
    t.tracks.select('manifest-0');
    expect(t.made[0]?.setEmbeddedSubtitle).toHaveBeenLastCalledWith(0);
    expect(t.tracks.choose(r).subtitle).toBe('manifest-0');
    // Off stays off.
    t.tracks.select(null);
    expect(t.tracks.choose(r).subtitle).toBeNull();
    // An id the menu does not hold changes nothing.
    t.tracks.select('file-9');
    expect(t.host.current.subtitle).toBeNull();
  });

  it('recognises a re-timed subtitle by its label', () => {
    expect(SYNCED_LABEL.test('English (Wyzie, synced)')).toBe(true);
    expect(SYNCED_LABEL.test('English (checked)')).toBe(true);
    expect(SYNCED_LABEL.test('English (synced) SDH')).toBe(false);
  });
});

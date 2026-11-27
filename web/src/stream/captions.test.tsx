// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';
import { Captions, cueText, delayKeyOf, SUBTITLE_DELAY_MAX_MS } from './captions';
import { fakeHost, fakeSession } from './fakeHost';

function store(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** A <video> with text tracks, which jsdom does not have: one subtitles track holding `cues`. */
function withTracks(cues: { startTime: number; endTime: number; text: string }[]) {
  const { video } = fakeVideo();
  const track = { kind: 'subtitles', mode: 'showing' as TextTrackMode, cues, activeCues: [] as { text: string }[], addEventListener: () => {} };
  Object.defineProperty(video, 'textTracks', { configurable: true, value: Object.assign([track], {}) });
  return { video, track };
}

describe('cueText', () => {
  it("takes WebVTT's tags out and reads its entities", () => {
    expect(cueText('<00:01.000>a  \n\n <b>b</b> &lt;3&nbsp;')).toBe('a\nb <3');
    expect(cueText('<i>- Sorry</i>\n<c.yellow>- It&#39;s fine &amp; done</c>')).toBe("- Sorry\n- It's fine & done");
    expect(cueText('<v Wong>&quot;Copy&quot; &gt; that')).toBe('"Copy" > that');
  });
});

describe('Captions', () => {
  it('hides a track Chrome would draw and reads its active cues into the caption, each line once', () => {
    const { video, track } = withTracks([]);
    const host = fakeHost(video);
    const captions = new Captions(host);
    track.activeCues = [{ text: '<i>Hi</i>' }, { text: 'Hi' }, { text: 'there' }];
    captions.read();
    expect(track.mode).toBe('hidden');
    expect(host.current.caption).toBe('Hi\nthere');
  });

  it("moves every cue by the delay from its file's own times, however often it is applied", () => {
    const cue = { startTime: 10, endTime: 12, text: 'a' };
    const { video } = withTracks([cue]);
    const host = fakeHost(video);
    const captions = new Captions(host);
    captions.shift(500);
    expect(cue).toMatchObject({ startTime: 10.5, endTime: 12.5 });
    captions.shift(-1500);
    expect(cue).toMatchObject({ startTime: 9, endTime: 11 });
    captions.shift(1000);
    expect(cue).toMatchObject({ startTime: 10, endTime: 12 });
  });

  it('keeps the delay per title, within ±SUBTITLE_DELAY_MAX_MS, and forgets a delay of 0', () => {
    const storage = store();
    const host = fakeHost(fakeVideo().video, { storage });
    host.currentSession = fakeSession();
    const captions = new Captions(host);
    captions.shift(SUBTITLE_DELAY_MAX_MS * 2);
    expect(host.current.subtitleDelayMs).toBe(SUBTITLE_DELAY_MAX_MS);
    expect(storage.data.get(delayKeyOf('Fight Club (1999)'))).toBe(String(SUBTITLE_DELAY_MAX_MS));
    host.set({ subtitleDelayMs: 0 });
    captions.restoreDelay();
    expect(host.current.subtitleDelayMs).toBe(SUBTITLE_DELAY_MAX_MS);
    captions.shift(-SUBTITLE_DELAY_MAX_MS);
    expect(storage.data.has(delayKeyOf('Fight Club (1999)'))).toBe(false);
    // Nonsense in the storage is no delay.
    storage.data.set(delayKeyOf('Fight Club (1999)'), 'abc');
    captions.restoreDelay();
    expect(host.current.subtitleDelayMs).toBe(0);
  });
});

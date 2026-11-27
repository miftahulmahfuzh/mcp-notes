// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeVideo, jsonResponse, previewCueJson, previewsJson, routeFetch } from '../testing/streamFakes';
import { fakeHost } from './fakeHost';
import { PreviewFrames } from './previewFrames';
import { NO_PREVIEWS } from './session';

const URL = 'GET /api/stream/sessions/S1/previews';

describe('PreviewFrames', () => {
  it('reads the frames once per rev, never a rev already asked for, and starts a new session from none', async () => {
    let rev = 1;
    const { fetchImpl, calls } = routeFetch({ [URL]: () => jsonResponse(previewsJson({ rev, cues: [previewCueJson('/s0.jpg', 0, 0)] })) });
    const host = fakeHost(fakeVideo().video, { fetch: fetchImpl });
    const frames = new PreviewFrames(host);
    frames.follow('S1', 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.current.previews).toMatchObject({ rev: 1, cues: [{ url: '/s0.jpg' }] });
    expect(host.notes).toEqual(['previews: partial, 1 frame (local, rev 1)']);
    frames.follow('S1', 1);
    frames.follow('S1', 0);
    expect(calls).toHaveLength(1);
    rev = 2;
    frames.follow('S1', 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);
    // The same frames under a higher rev: nothing new to say.
    expect(host.notes).toHaveLength(1);
    // A session the page does not play is not read; a new one starts from no frames.
    frames.follow('S2', 5);
    expect(calls).toHaveLength(2);
    host.currentId = 'S2';
    frames.forget();
    frames.follow('S2', 0);
    expect(host.current.previews).toBe(NO_PREVIEWS);
  });

  it('keeps the frames it had when a read fails', async () => {
    const { fetchImpl } = routeFetch({});
    const host = fakeHost(fakeVideo().video, { fetch: fetchImpl });
    new PreviewFrames(host).follow('S1', 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.current.previews).toBe(NO_PREVIEWS);
    expect(host.notes).toEqual([]);
  });
});

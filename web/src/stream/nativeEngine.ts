import { networkRecovery, reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/** MediaError.MEDIA_ERR_NETWORK: the browser lost the file while loading it. */
const MEDIA_ERR_NETWORK = 2;

export function createNativeEngine({ video, src, startAt, handlers }: EngineRequest, fetchImpl: typeof fetch = fetch): PlayerEngine {
  let live = true;
  let readied = false;
  /** Where the next loadedmetadata puts the picture: the start, then where a network error stopped the film. */
  let resumeAt = startAt;
  let resumePlaying = false;
  // R1.7: load the file again; onMeta continues from resumeAt.
  const network = networkRecovery(handlers, () => {
    if (live) video.src = src;
  });
  const onMeta = () => {
    if (!live) return;
    if (resumeAt > 0) video.currentTime = resumeAt;
    if (readied) {
      network.loaded();
      if (resumePlaying) void Promise.resolve(video.play()).catch(() => {});
      return;
    }
    readied = true;
    handlers.onReady({
      qualities: video.videoHeight > 0 ? [{ index: 0, height: video.videoHeight, bitrate: null }] : [],
      subtitles: [],
    });
  };
  const onError = () => {
    if (!live) return;
    const code = video.error?.code ?? 0;
    const why = `media error ${code}`;
    if (video.currentTime > 0) resumeAt = video.currentTime;
    resumePlaying = !video.paused;
    fetchImpl(src, { headers: { range: 'bytes=0-0' } })
      .then((res) => {
        if (!live) return;
        if (reportRefusal(handlers, res.status, res.headers.get(UPSTREAM_HEADER))) {
          network.stop();
          return;
        }
        if (code === MEDIA_ERR_NETWORK) network.fail(why);
        else handlers.onFatal(why);
      })
      .catch(() => {
        // The probe could not reach the daemon either: the network, not the file.
        if (live) network.fail(why);
      });
  };
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('error', onError);
  video.src = src;

  return {
    setQuality() {},
    setEmbeddedSubtitle() {},
    destroy() {
      live = false;
      network.stop();
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    },
  };
}

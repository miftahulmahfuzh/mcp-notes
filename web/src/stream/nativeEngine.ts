import { reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

export function createNativeEngine({ video, src, startAt, handlers }: EngineRequest, fetchImpl: typeof fetch = fetch): PlayerEngine {
  let live = true;
  const onMeta = () => {
    if (!live) return;
    if (startAt > 0) video.currentTime = startAt;
    handlers.onReady({
      qualities: video.videoHeight > 0 ? [{ index: 0, height: video.videoHeight, bitrate: null }] : [],
      subtitles: [],
    });
  };
  const onError = () => {
    if (!live) return;
    const why = `media error ${video.error?.code ?? 0}`;
    fetchImpl(src, { headers: { range: 'bytes=0-0' } })
      .then((res) => {
        if (!live) return;
        if (!reportRefusal(handlers, res.status, res.headers.get(UPSTREAM_HEADER))) handlers.onFatal(why);
      })
      .catch(() => {
        if (live) handlers.onFatal(why);
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
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    },
  };
}

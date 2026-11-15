// Spike: play a sniffed manifest in the streaming Chrome through the local proxy, full screen,
// and report what the <video> is doing. node play.mjs <manifest> <referer> [hls|dash] [--keep]
import { evaluateInChrome, sleep } from '/home/miftah/mcp-notes/claude/streaming/chrome.mjs';
const [manifest, referer, kind = 'hls', keep] = process.argv.slice(2);
const ORIGIN = 'http://localhost:7399';
const t0 = Date.now();
const path = `/play?kind=${kind}&ref=${encodeURIComponent(referer)}&src=${encodeURIComponent(manifest)}`;
await evaluateInChrome(ORIGIN, `location.assign(${JSON.stringify(path)}); 'ok'`, { show: true, windowState: 'fullscreen' });
const STATE = `(async () => { const v = document.querySelector('video'); if (!v) return { stage: 'no_video' };
  if (v.paused) { try { await v.play(); } catch (e) {} }
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
  return { playing: !v.paused && v.currentTime > 0, t: +v.currentTime.toFixed(1), duration_s: Math.round(v.duration), w: v.videoWidth, h: v.videoHeight, muted: v.muted,
    frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, buffered_s: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) : 0,
    levels: window.spike?.levels, errors: window.spike?.errors, fullscreen: innerHeight >= screen.height - 2 }; })()`;
let first = null;
for (let i = 0; i < 12; i++) {
  await sleep(1500);
  const s = await evaluateInChrome(ORIGIN, STATE, { timeoutS: 20 }).catch((e) => ({ error: String(e.message) }));
  if (s.playing && first === null) first = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(JSON.stringify(s));
  if (s.playing && s.t > 12) break;
}
console.log(JSON.stringify({ seconds_to_first_frame: first }));
if (keep !== '--keep') {
  await evaluateInChrome(ORIGIN, `document.querySelector('video')?.pause(); 'paused'`, { show: true, windowState: 'normal' }).catch(() => {});
}

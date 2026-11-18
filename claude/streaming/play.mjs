// Playing a title on a streaming site: the part every site shares. A site module (sites/*.mjs)
// says how its own player is started; this opens the page, runs that, and fills the screen.
import { ChromeError, evaluateInChrome, sleep } from './chrome.mjs';

/**
 * Stretches the player over the page, for a window that is already full screen. A page's own
 * full-screen button is refused when the click does not come from the keyboard or mouse, so this
 * is the F11 kind of full screen. Esc, or leaving full screen with F11, puts the page back.
 *
 * The player is left two pixels short of the screen's height. A video that covers the whole screen
 * exactly is handed by Chrome to a full-screen overlay, which draws nothing of the page over it:
 * the player's own subtitles and controls are in the page and yet not on screen (measured on idlix,
 * 2026-11-18: a subtitle line present and styled, absent from the screen until the player was 898
 * of 900 pixels high).
 */
export function fillScreenExpression(selector) {
  const css = `${selector}{position:fixed!important;inset:0!important;width:100vw!important;height:calc(100vh - 2px)!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;border-radius:0!important;background:#000!important}html{overflow:hidden!important}`;
  return `(async () => {
  const player = document.querySelector(${JSON.stringify(selector)});
  if (!player) return { filled: false };
  if (!document.getElementById('notesd-stream-fill')) {
    const style = document.createElement('style');
    style.id = 'notesd-stream-fill';
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    const undo = () => { style.remove(); removeEventListener('resize', onResize); removeEventListener('keydown', onKey, true); };
    const onResize = () => { if (innerHeight < screen.height - 40) undo(); };
    const onKey = (e) => { if (e.key === 'Escape') undo(); };
    addEventListener('resize', onResize);
    addEventListener('keydown', onKey, true);
  }
  await new Promise((r) => setTimeout(r, 600));
  const rect = player.getBoundingClientRect();
  return { filled: rect.width >= screen.width - 2 && rect.height >= screen.height - 4 };
})()`;
}

/**
 * Opens a title page in the streaming Chrome, in front of everything, starts the film and fills
 * the screen with it. Answers what happened; never throws.
 */
export async function playTitle(site, url) {
  const pathname = site.titlePath(url);
  if (pathname === null) return { playing: false, error: `not a title page on ${site.origin}: ${url}` };
  const evalPage = (expression, options) => evaluateInChrome(site.origin, expression, options);
  try {
    const open = () => evalPage(`location.assign(${JSON.stringify(pathname)}); 'ok'`, { show: true, closeOtherTabs: true });
    // A Chrome that is just closing still answers its port and then drops the call. Once more
    // starts a fresh one.
    await open().catch(async (err) => {
      if (!(err instanceof ChromeError)) throw err;
      await sleep(2500);
      return open();
    });
    await sleep(1500);
    const film = await site.start({ evalPage, sleep, pathname });
    if (!film?.playing) return { ...film, playing: false };
    const filled = await evalPage(fillScreenExpression(site.playerSelector), { show: true, windowState: 'fullscreen', closeOtherTabs: true });
    return { ...film, fullscreen: filled?.filled === true };
  } catch (err) {
    return { playing: false, error: String(err?.message ?? err) };
  }
}

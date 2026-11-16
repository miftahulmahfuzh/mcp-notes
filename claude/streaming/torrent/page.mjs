// Page readers shared by the torrent sites. Each function here uses nothing from outside itself: it
// is written into the expressions evaluated in the streaming Chrome (fn.toString()) and run in tests
// on the saved pages.

/** True for a bot-check page (Cloudflare's "Just a moment..." and its kin), which is never clicked through. */
export function isBotCheckPage(doc) {
  const title = String(doc.title || '').trim();
  if (/^just a moment/i.test(title) || /^attention required/i.test(title)) return true;
  return doc.querySelector('#challenge-form, #challenge-error-text, #cf-challenge-running, script[src*="challenges.cloudflare.com"]') !== null;
}

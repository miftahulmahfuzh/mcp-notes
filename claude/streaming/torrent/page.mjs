// Page readers shared by the torrent sites. Each function here uses nothing from outside itself: it
// is written into the expressions evaluated in the streaming Chrome (fn.toString()) and run in tests
// on the saved pages.

/**
 * True for a bot-check page (Cloudflare's "Just a moment..." and its kin), which is never clicked
 * through: the owner solves it by hand in the streaming Chrome (the `gate` command foregrounds it),
 * and the cf_clearance cookie the profile keeps lets later searches through. Covers the old
 * #challenge-form interstitial and the current Turnstile managed challenge (_cf_chl_opt, the widget).
 */
export function isBotCheckPage(doc) {
  const title = String(doc.title || '').trim();
  if (/^just a moment/i.test(title) || /^attention required/i.test(title)) return true;
  if (doc.querySelector('#challenge-form, #challenge-error-text, #cf-challenge-running, #cf-chl-widget, .cf-turnstile, script[src*="challenges.cloudflare.com"]') !== null) return true;
  // The managed challenge carries its options in an inline `window._cf_chl_opt = {...}` script.
  for (const script of doc.querySelectorAll('script:not([src])')) {
    if (/_cf_chl_opt\s*=/.test(script.textContent || '')) return true;
  }
  return false;
}

// Force-update helper for stuck PWA installs.
//
// iOS Safari can hold onto an old service worker shell for hours, even
// after the new SW is technically deployed and a SHELL_CACHE bump should
// have evicted the old files. This module's forceUpdate() routes around
// the stickiness with a four-step bust-and-reload:
//
//   1. registration.update()        — kicks the browser to refetch sw.js
//   2. caches.keys() + delete-all   — purges every cached response
//   3. waiting SW gets SKIP_WAITING — promotes it to active immediately
//   4. location.reload()            — fresh fetch of everything
//
// Triggered by the user tapping the ↻ button in the header.

/**
 * Force the PWA to update its service worker + reload. Always reloads,
 * even on error, so the user is never stuck.
 *
 * Optionally shows a toast via window.showToast before the reload happens
 * (mostly so the user sees something happening on the brief moment
 * between tap and reload).
 */
export async function forceUpdate() {
  if (window.showToast) window.showToast('Updating…', 'ok', 900);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      try { await reg.update(); } catch (e) { console.warn('reg.update threw:', e); }
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    }
  } catch (e) {
    console.error('forceUpdate hit an error (will reload anyway):', e);
  } finally {
    // Hard reload (location.reload(true) is deprecated; bypassing cache
    // via this trick works around it on iOS).
    setTimeout(() => {
      const url = new URL(location.href);
      url.searchParams.set('_t', Date.now().toString());
      location.replace(url.toString());
    }, 250);
  }
}

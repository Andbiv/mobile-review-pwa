// Juniper Review PWA — entry point.
//
// Tiny hash router with two views (library, review/<package_id>). Imports
// view modules on demand so first-load JS stays small.

import { ensurePersistence, openDb } from './state.js';
import { renderLibrary } from './views/library.js';
import { renderReview } from './views/review.js';

/** @type {HTMLElement} */
const appEl = document.getElementById('app');

/**
 * Render a view based on the current hash.
 * Routes:
 *   #library              -> library
 *   #review/<package_id>  -> review session for that pack
 *   (anything else)       -> library (default)
 */
async function route() {
  const hash = location.hash.replace(/^#/, '');
  try {
    if (hash.startsWith('review/')) {
      const packageId = decodeURIComponent(hash.slice('review/'.length));
      await renderReview(appEl, packageId);
    } else {
      await renderLibrary(appEl);
    }
  } catch (err) {
    console.error('route failed:', err);
    appEl.innerHTML = `
      <div class="empty">
        <div class="big">Something went wrong.</div>
        <div>${err.message}</div>
        <div class="btn-row" style="justify-content:center">
          <button class="subtle" onclick="location.hash='#library'">Back to library</button>
        </div>
      </div>`;
  }
}

/** Small toast helper available to every view via the global window. */
window.showToast = function showToast(message, kind = 'ok', ms = 2200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
};

/**
 * Persistent progress toast — returns handles so the caller can update
 * the text as work proceeds, then dismiss with a final status. Used by
 * the multi-select pack import so the user sees "Importing 2 of 4…"
 * rather than a frozen UI for ~30 seconds.
 */
window.showProgress = function showProgress(initialText) {
  const t = document.createElement('div');
  t.className = 'toast progress';
  t.textContent = initialText;
  document.body.appendChild(t);
  return {
    update(text) { t.textContent = text; },
    done(text, kind = 'ok', ms = 2800) {
      t.className = `toast ${kind}`;
      t.textContent = text;
      setTimeout(() => t.remove(), ms);
    },
    dismiss() { t.remove(); },
  };
};

window.addEventListener('hashchange', route);

(async () => {
  // Register the service worker and request persistent storage on first run.
  // Both are best-effort; the app must still function if either fails.
  try {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('./sw.js');
    }
  } catch (e) {
    console.warn('SW registration failed:', e);
  }
  try {
    await openDb();
    await ensurePersistence();
  } catch (e) {
    console.warn('persistence setup failed:', e);
  }
  if (!location.hash) location.hash = '#library';
  await route();
})();

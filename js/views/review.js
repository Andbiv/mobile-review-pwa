// Review view — TP/FP/SKIP card swiper.
//
// CHM visible by default per plan §F (drives recall on short junipers).
// Tap "RGB-only" / "CHM" chips to switch views.
//
// Input methods (all routed through the same applyVerdict() function):
//   - Tap big TP/FP/SKIP buttons
//   - Swipe right (TP), left (FP), up (SKIP)  — PointerEvents (NOT touch+mouse;
//     PointerEvents avoid the iOS Safari preventDefault quirks)
//   - Keyboard T/F/S (or 1/2/3 — both work)
//
// Resume: re-opening a pack puts the cursor on the first detection without
// a verdict in IDB. Undo rolls back one decision.

import { BUILD } from '../build.js';
import { forceUpdate } from '../update.js';
import {
  getCrop, getPack, listPacks, loadVerdictsForPack, putVerdict, deleteVerdict,
} from '../state.js';

const SWIPE_THRESHOLD_PX = 60;

/**
 * @param {HTMLElement} container
 * @param {string} package_id
 */
export async function renderReview(container, package_id) {
  const pack = await getPack(package_id);
  if (!pack) {
    container.innerHTML = `
      <header class="app-header">
        <div class="title">Review</div>
        <div class="actions">
          <button class="subtle" onclick="location.hash='#library'">Back</button>
        </div>
      </header>
      <div class="empty">
        <div class="big">Pack not found</div>
        <div>package_id=${package_id}</div>
      </div>`;
    return;
  }

  const verdicts = await loadVerdictsForPack(package_id);

  // Find resume position: first detection without a verdict.
  let cursor = 0;
  for (let i = 0; i < pack.detections.length; i++) {
    if (!verdicts.has(pack.detections[i].det_id)) { cursor = i; break; }
    if (i === pack.detections.length - 1) cursor = pack.detections.length; // all done
  }

  const state = {
    pack,
    verdicts,
    cursor,
    chmFirst: true,        // CHM default-on per plan §F
    lastApplied: null,     // {det_id, prev_decision} for Undo
  };

  container.innerHTML = `
    <header class="app-header">
      <div class="title" id="hud-title">…</div>
      <div class="actions">
        <span class="version-chip" title="PWA build identifier">${escapeHtml(BUILD)}</span>
        <button class="subtle refresh-btn" id="refresh-btn-r" title="Force update from server" aria-label="Update">↻</button>
        <button class="subtle nav-btn" id="prev-btn" aria-label="Previous">◀</button>
        <button class="subtle nav-btn" id="next-btn" aria-label="Next">▶</button>
        <button class="subtle" id="undo-btn" disabled>Undo</button>
        <button class="subtle" onclick="location.hash='#library'">Done</button>
      </div>
    </header>
    <div class="progress-bar"><div class="bar" id="progress-bar"></div></div>
    <section class="review">
      <div class="hud" id="hud-badges"></div>
      <div class="card-area" id="card-area">
        <div class="swipe-hint">⇽ Prev &nbsp;·&nbsp; Next ⇾ &nbsp;·&nbsp; keys: A / D / S</div>
        <img class="card-img" id="card-img" alt="">
      </div>
      <div class="toggle-row" id="toggle-row">
        <button id="tg-chm" class="on">CHM</button>
        <button id="tg-rgb">RGB</button>
      </div>
      <div class="verdict-row" id="verdict-row">
        <button class="fp" id="btn-fp">FP</button>
        <button class="skip" id="btn-skip">SKIP</button>
        <button class="tp" id="btn-tp">TP</button>
      </div>
    </section>
  `;

  document.getElementById('btn-tp').addEventListener('click', () => applyVerdict(state, 'TP'));
  document.getElementById('btn-fp').addEventListener('click', () => applyVerdict(state, 'FP'));
  document.getElementById('btn-skip').addEventListener('click', () => applyVerdict(state, 'SKIP'));
  document.getElementById('tg-chm').addEventListener('click', () => { state.chmFirst = true; refresh(state); });
  document.getElementById('tg-rgb').addEventListener('click', () => { state.chmFirst = false; refresh(state); });
  document.getElementById('undo-btn').addEventListener('click', () => undo(state));
  document.getElementById('prev-btn').addEventListener('click', () => goPrev(state));
  document.getElementById('next-btn').addEventListener('click', () => goNext(state));
  document.getElementById('refresh-btn-r').addEventListener('click', forceUpdate);

  bindKeyboard(state);
  bindSwipeNav(document.getElementById('card-area'), state);

  await refresh(state);
}

async function refresh(state) {
  const { pack, cursor, verdicts } = state;
  const total = pack.detections.length;

  // Progress + HUD
  const reviewed = verdicts.size;
  document.getElementById('progress-bar').style.width =
    `${Math.min(100, Math.round(reviewed / Math.max(1, total) * 100))}%`;
  document.getElementById('undo-btn').disabled = !state.lastApplied;

  // Nav button state — Prev disabled at start, Next disabled at the
  // sentinel "end" position. End-state can be reached either by reviewing
  // through, or via Next from the last card; from end-state the user can
  // Prev back to audit.
  document.getElementById('prev-btn').disabled = cursor <= 0;
  document.getElementById('next-btn').disabled = cursor >= total;

  // End state — keep nav usable so the user can Prev back to audit. Also
  // offer to jump to the next unfinished pack so the reviewer doesn't
  // have to bounce through the library between packs.
  if (cursor >= total) {
    document.getElementById('hud-title').textContent =
      `${reviewed}/${total} reviewed`;
    document.getElementById('hud-badges').innerHTML =
      '<span class="badge">end of pack</span>';
    const nextPack = await findNextUnfinishedPack(pack.package_id);
    const nextPackBtn = nextPack
      ? `<button class="primary" id="goto-next-pack">→ Next pack (${escapeHtml(nextPack.package_id)})</button>`
      : '';
    const cardArea = document.getElementById('card-area');
    cardArea.innerHTML = `
      <div class="done-state">
        <div class="big">🎉 Pack complete</div>
        <div>${reviewed} of ${total} reviewed.</div>
        <div class="btn-row" style="justify-content:center; gap:0.6em; flex-wrap:wrap">
          ${nextPackBtn}
          <button class="subtle" id="audit-from-start">Review from start</button>
          <button class="subtle" onclick="location.hash='#library'">Back to library</button>
        </div>
      </div>`;
    document.getElementById('audit-from-start')?.addEventListener('click', () => {
      state.cursor = 0;
      refresh(state);
    });
    document.getElementById('goto-next-pack')?.addEventListener('click', () => {
      location.hash = `#review/${encodeURIComponent(nextPack.package_id)}`;
    });
    document.getElementById('toggle-row').style.display = 'none';
    document.getElementById('verdict-row').style.display = 'none';
    return;
  }

  // Ensure the card UI is back if we navigated away from end-state.
  document.getElementById('toggle-row').style.display = '';
  document.getElementById('verdict-row').style.display = '';
  const cardArea = document.getElementById('card-area');
  if (!cardArea.querySelector('img.card-img')) {
    cardArea.innerHTML = `
      <div class="swipe-hint">⇽ FP &nbsp;·&nbsp; SKIP ⤴ &nbsp;·&nbsp; TP ⇾</div>
      <img class="card-img" id="card-img" alt="">`;
  }

  const det = pack.detections[cursor];
  const existing = verdicts.get(det.det_id);

  // Title: cursor position
  document.getElementById('hud-title').textContent =
    `card ${cursor + 1}/${total} · ${reviewed} reviewed`;

  // Badges — show class/conf/area + a strong "Current: X" chip when the
  // card already has a verdict, so the user can audit at a glance.
  const cls = det.cls || '?';
  const conf = det.conf !== undefined ? det.conf.toFixed(2) : '?';
  const area = det.area_m2 !== undefined ? `${det.area_m2.toFixed(1)} m²` : '?';
  const prior = det.prior_decision;
  const priorChip = prior
    ? `<span class="badge prior${prior}">prior: ${prior}</span>` : '';
  const currentChip = existing
    ? `<span class="badge current-${existing.decision}">current: ${existing.decision}</span>`
    : '';
  document.getElementById('hud-badges').innerHTML = `
    <span class="badge">${escapeHtml(cls)}</span>
    <span class="badge">conf ${conf}</span>
    <span class="badge">${area}</span>
    ${priorChip}
    ${currentChip}
  `;

  // Image — verdict colors the outline so the polygon's "color" reflects
  // the decision (TP green, FP red, SKIP gray, undecided no outline).
  const key = state.chmFirst ? `${det.det_id}_chm` : `${det.det_id}_rgb`;
  const blob = await getCrop(pack.package_id, key);
  const img = document.getElementById('card-img');
  if (img._url) URL.revokeObjectURL(img._url);
  if (blob) {
    img._url = URL.createObjectURL(blob);
    img.src = img._url;
  } else {
    img.src = '';
    img.alt = `missing crop ${key}`;
  }
  img.classList.remove('verdict-TP', 'verdict-FP', 'verdict-SKIP');
  if (existing) img.classList.add(`verdict-${existing.decision}`);

  // Toggle highlights
  document.getElementById('tg-chm').classList.toggle('on', state.chmFirst);
  document.getElementById('tg-rgb').classList.toggle('on', !state.chmFirst);

  // Highlight the verdict button that matches the current decision so the
  // user sees what they decided last time without reading the badge.
  for (const id of ['btn-tp', 'btn-fp', 'btn-skip']) {
    document.getElementById(id).classList.remove('active');
  }
  if (existing) {
    const map = { TP: 'btn-tp', FP: 'btn-fp', SKIP: 'btn-skip' };
    document.getElementById(map[existing.decision])?.classList.add('active');
  }
}

async function findNextUnfinishedPack(currentPackId) {
  const packs = await listPacks();
  // Stable order = oldest imported first; matches how the library shows them.
  packs.sort((a, b) => (a.imported_at || '').localeCompare(b.imported_at || ''));
  for (const p of packs) {
    if (p.package_id === currentPackId) continue;
    const v = await loadVerdictsForPack(p.package_id);
    if (v.size < p.detections.length) return p;
  }
  return null;
}

async function goPrev(state) {
  if (state.cursor > 0) {
    state.cursor--;
    state.lastApplied = null;   // navigation clears the undo target
    await refresh(state);
  }
}

async function goNext(state) {
  if (state.cursor < state.pack.detections.length) {
    state.cursor++;
    state.lastApplied = null;
    await refresh(state);
  }
}

async function applyVerdict(state, decision) {
  const { pack, cursor, verdicts } = state;
  if (cursor >= pack.detections.length) return;
  const det = pack.detections[cursor];

  const prev = verdicts.get(det.det_id) || null;
  const v = {
    det_id: det.det_id,
    package_id: pack.package_id,
    decision,
    decided_at: new Date().toISOString(),
  };
  await putVerdict(v);
  verdicts.set(det.det_id, v);
  state.lastApplied = { det_id: det.det_id, cursor, prev };

  // Auto-advance
  state.cursor = cursor + 1;
  await refresh(state);
}

async function undo(state) {
  if (!state.lastApplied) return;
  const { det_id, cursor, prev } = state.lastApplied;
  if (prev) {
    await putVerdict(prev);
    state.verdicts.set(det_id, prev);
  } else {
    await deleteVerdict(det_id, state.pack.package_id);
    state.verdicts.delete(det_id);
  }
  state.cursor = cursor;
  state.lastApplied = null;
  await refresh(state);
}

function bindKeyboard(state) {
  window.addEventListener('keydown', (ev) => {
    if (location.hash.indexOf('#review/') !== 0) return;
    const k = ev.key.toLowerCase();
    // Verdict keys — A/D/S match the desktop reviewer; T/F/S kept as
    // alternates from the original spec; 1/2/3 for keyboard heavy users.
    if (k === 'a' || k === 't' || k === '1') { ev.preventDefault(); applyVerdict(state, 'TP'); }
    else if (k === 'd' || k === 'f' || k === '2') { ev.preventDefault(); applyVerdict(state, 'FP'); }
    else if (k === 's' || k === '3') { ev.preventDefault(); applyVerdict(state, 'SKIP'); }
    else if (k === 'u') { ev.preventDefault(); undo(state); }
    else if (k === 'c') { ev.preventDefault(); state.chmFirst = !state.chmFirst; refresh(state); }
    else if (k === 'arrowleft' || k === '[') { ev.preventDefault(); goPrev(state); }
    else if (k === 'arrowright' || k === ']') { ev.preventDefault(); goNext(state); }
  });
}

/**
 * Swipe gestures = NAVIGATION (right=next, left=prev). Verdicts are via
 * buttons or keyboard. Per user feedback: arrows mean "move between cards",
 * not "judge this card". Up-swipe is intentionally unbound — the SKIP
 * button + S key suffice.
 */
function bindSwipeNav(cardArea, state) {

  let start = null;
  cardArea.addEventListener('pointerdown', ev => {
    if (ev.button && ev.button !== 0) return;
    start = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    cardArea.setPointerCapture?.(ev.pointerId);
  });
  cardArea.addEventListener('pointerup', ev => {
    if (!start) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    start = null;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < SWIPE_THRESHOLD_PX) return;
    // Treat as horizontal swipe only if x movement clearly dominates,
    // so vertical scrolls of the page don't accidentally navigate.
    if (adx > ady * 1.5) {
      if (dx > 0) goNext(state); else goPrev(state);
    }
  });
  cardArea.addEventListener('pointercancel', () => { start = null; });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

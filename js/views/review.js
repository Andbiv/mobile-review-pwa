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

import {
  getCrop, getPack, loadVerdictsForPack, putVerdict, deleteVerdict,
} from '../state.js';

const SWIPE_THRESHOLD_PX = 80;

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
        <button class="subtle" id="undo-btn" disabled>Undo</button>
        <button class="subtle" onclick="location.hash='#library'">Done</button>
      </div>
    </header>
    <div class="progress-bar"><div class="bar" id="progress-bar"></div></div>
    <section class="review">
      <div class="hud" id="hud-badges"></div>
      <div class="card-area" id="card-area">
        <div class="swipe-hint">⇽ FP &nbsp;·&nbsp; SKIP ⤴ &nbsp;·&nbsp; TP ⇾</div>
        <img class="card-img" id="card-img" alt="">
      </div>
      <div class="toggle-row" id="toggle-row">
        <button id="tg-chm" class="on">CHM</button>
        <button id="tg-rgb">RGB</button>
      </div>
      <div class="verdict-row">
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

  bindKeyboard(state);
  bindSwipe(document.getElementById('card-area'), state);

  await refresh(state);
}

async function refresh(state) {
  const { pack, cursor, verdicts } = state;
  const total = pack.detections.length;

  // Progress
  const reviewed = verdicts.size;
  document.getElementById('progress-bar').style.width =
    `${Math.min(100, Math.round(reviewed / Math.max(1, total) * 100))}%`;
  document.getElementById('hud-title').textContent =
    `${reviewed}/${total} reviewed`;
  document.getElementById('undo-btn').disabled = !state.lastApplied;

  // End state
  if (cursor >= total) {
    document.querySelector('.card-area').innerHTML =
      `<div class="done-state">
         <div class="big">🎉 Pack complete</div>
         <div>${reviewed} of ${total} reviewed.</div>
         <div class="btn-row" style="justify-content:center">
           <button class="primary" onclick="location.hash='#library'">Back to library</button>
         </div>
       </div>`;
    document.getElementById('toggle-row').style.display = 'none';
    document.querySelector('.verdict-row').style.display = 'none';
    return;
  }

  const det = pack.detections[cursor];

  // Badges
  const cls = det.cls || '?';
  const conf = det.conf !== undefined ? det.conf.toFixed(2) : '?';
  const area = det.area_m2 !== undefined ? `${det.area_m2.toFixed(1)} m²` : '?';
  const prior = det.prior_decision;
  const priorChip = prior
    ? `<span class="badge prior${prior}">prior: ${prior}</span>` : '';
  document.getElementById('hud-badges').innerHTML = `
    <span class="badge">${escapeHtml(cls)}</span>
    <span class="badge">conf ${conf}</span>
    <span class="badge">${area}</span>
    ${priorChip}
  `;

  // Image
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

  // Toggle highlights
  document.getElementById('tg-chm').classList.toggle('on', state.chmFirst);
  document.getElementById('tg-rgb').classList.toggle('on', !state.chmFirst);
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
    if (k === 't' || k === '1') { ev.preventDefault(); applyVerdict(state, 'TP'); }
    else if (k === 'f' || k === '2') { ev.preventDefault(); applyVerdict(state, 'FP'); }
    else if (k === 's' || k === '3') { ev.preventDefault(); applyVerdict(state, 'SKIP'); }
    else if (k === 'u') { ev.preventDefault(); undo(state); }
    else if (k === 'c') { ev.preventDefault(); state.chmFirst = !state.chmFirst; refresh(state); }
  });
}

/**
 * PointerEvents-based swipe. Unified API on iOS 13+ and modern desktops.
 * Avoids the touchstart/mousedown + preventDefault quirks of older iOS.
 */
function bindSwipe(cardArea, state) {
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
    if (adx < SWIPE_THRESHOLD_PX && ady < SWIPE_THRESHOLD_PX) return;
    if (adx > ady) {
      applyVerdict(state, dx > 0 ? 'TP' : 'FP');
    } else if (dy < 0) {
      applyVerdict(state, 'SKIP');
    }
  });
  cardArea.addEventListener('pointercancel', () => { start = null; });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

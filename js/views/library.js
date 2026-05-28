// Library view — list of imported packs.

import { deletePack, listPacks, loadVerdictsForPack } from '../state.js';
import { pickAndImportPack } from '../pack-import.js';
import { exportPackVerdicts } from '../verdict-export.js';

/**
 * Render the library view into a container element.
 * @param {HTMLElement} container
 */
export async function renderLibrary(container) {
  container.innerHTML = `
    <header class="app-header">
      <div class="title">Juniper Review</div>
      <div class="actions">
        <button class="primary" id="import-btn">+ Import pack</button>
      </div>
    </header>
    <div class="library" id="library-list">
      <div class="empty"><div class="big">Loading…</div></div>
    </div>
  `;
  document.getElementById('import-btn').addEventListener('click', onImport);
  await refresh();
}

async function refresh() {
  const listEl = document.getElementById('library-list');
  const packs = await listPacks();
  if (packs.length === 0) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="big">No packs imported yet.</div>
        <div>Tap <b>+ Import pack</b> to open a <code>pack_NNN.zip</code> from
             OneDrive – BCI / GIS / BrushDrone / MobileReview.</div>
      </div>`;
    return;
  }

  // Sort newest first
  packs.sort((a, b) => (b.imported_at || '').localeCompare(a.imported_at || ''));

  const cards = await Promise.all(packs.map(renderPackCard));
  listEl.innerHTML = cards.join('');

  // Wire buttons
  for (const pack of packs) {
    document.getElementById(`review-${pack.package_id}`)
      ?.addEventListener('click', () => { location.hash = `#review/${encodeURIComponent(pack.package_id)}`; });
    document.getElementById(`export-${pack.package_id}`)
      ?.addEventListener('click', () => onExport(pack.package_id));
    document.getElementById(`delete-${pack.package_id}`)
      ?.addEventListener('click', () => onDelete(pack.package_id));
  }
}

async function renderPackCard(pack) {
  const total = pack.detections.length;
  const verdicts = await loadVerdictsForPack(pack.package_id);
  const reviewed = verdicts.size;
  const pct = total ? Math.round(reviewed / total * 100) : 0;
  const status = pack.status === 'exported' && !hasNewSinceExport(pack, verdicts)
    ? '<span class="status-chip exported">exported</span>'
    : reviewed === total && total > 0
      ? '<span class="status-chip">ready to export</span>'
      : reviewed > 0 ? '<span class="status-chip">in progress</span>' : '';
  const area = pack.manifest?.area_label || pack.package_id;
  const job = pack.manifest?.job_id || '';
  const imported = pack.imported_at ? new Date(pack.imported_at).toLocaleString() : '';
  const exported = pack.last_exported_at ? new Date(pack.last_exported_at).toLocaleString() : '';

  return `
    <div class="pack-card">
      <div class="head">
        <div>
          <div class="name">${escapeHtml(pack.package_id)}</div>
          <div class="meta">${escapeHtml(area)} · ${total} detections${job ? ` · ${escapeHtml(job)}` : ''}</div>
          <div class="meta">imported ${escapeHtml(imported)}${exported ? ` · last export ${escapeHtml(exported)}` : ''}</div>
        </div>
        ${status}
      </div>
      <div class="progress"><div class="bar" style="width:${pct}%"></div></div>
      <div class="meta">${reviewed} of ${total} reviewed (${pct}%)</div>
      <div class="actions">
        <button class="primary" id="review-${pack.package_id}">
          ${reviewed === 0 ? 'Start review' : reviewed === total ? 'Review again' : 'Continue'}
        </button>
        <button id="export-${pack.package_id}" ${reviewed === 0 ? 'disabled' : ''}>
          Export verdicts
        </button>
        <button class="subtle" id="delete-${pack.package_id}">Delete</button>
      </div>
    </div>`;
}

function hasNewSinceExport(pack, verdictsMap) {
  if (!pack.last_exported_at) return verdictsMap.size > 0;
  const cut = pack.last_exported_at;
  for (const v of verdictsMap.values()) {
    if (v.decided_at > cut) return true;
  }
  return false;
}

async function onImport() {
  try {
    const package_id = await pickAndImportPack(modalConfirm);
    if (package_id) {
      window.showToast(`Imported pack "${package_id}"`, 'ok');
      await refresh();
    }
  } catch (e) {
    console.error(e);
    window.showToast(`Import failed: ${e.message}`, 'err', 4000);
  }
}

async function onExport(package_id) {
  try {
    const r = await exportPackVerdicts(package_id);
    if (!r.invoked) {
      window.showToast(r.reason || 'Nothing to export', 'err');
      return;
    }
    window.showToast(
      `${r.count} verdicts ready in share-sheet. Pick "Save to Files" → OneDrive.`,
      'ok', 4000
    );
    await refresh();
  } catch (e) {
    console.error(e);
    window.showToast(`Export failed: ${e.message}`, 'err', 4000);
  }
}

async function onDelete(package_id) {
  const ok = await modalConfirm(
    `Delete pack "${package_id}" and its verdicts? This cannot be undone. ` +
    `Export verdicts first if you haven't.`
  );
  if (!ok) return;
  try {
    await deletePack(package_id);
    window.showToast(`Deleted "${package_id}"`, 'ok');
    await refresh();
  } catch (e) {
    console.error(e);
    window.showToast(`Delete failed: ${e.message}`, 'err', 4000);
  }
}

/**
 * Modal confirmation. Returns a Promise<boolean>.
 */
function modalConfirm(message) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>Confirm</h2>
        <div>${escapeHtml(message)}</div>
        <div class="row">
          <button class="subtle" data-act="no">Cancel</button>
          <button class="primary" data-act="yes">OK</button>
        </div>
      </div>`;
    wrap.addEventListener('click', e => {
      if (e.target === wrap) finish(false);
      const act = e.target.dataset?.act;
      if (act === 'yes') finish(true);
      else if (act === 'no') finish(false);
    });
    document.body.appendChild(wrap);
    function finish(v) { wrap.remove(); resolve(v); }
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

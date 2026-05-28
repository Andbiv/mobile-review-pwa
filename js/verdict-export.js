// Verdict export — IDB verdicts -> JSON -> iOS share-sheet -> OneDrive.
//
// File-naming contract with the Phase 4 ingester:
//
//   verdicts_<package_id>_<unix_ts>.json
//
// The desktop ingester replays ALL matching files for a pack and takes
// the latest decided_at per det_id (plan §C). So multiple exports for the
// same pack are safe and idempotent — review some today, more tomorrow,
// both exports land in OneDrive, ingester does the right thing.

import { getPack, loadVerdictsForPack, putPack } from './state.js';

/**
 * Build and share a verdicts JSON file for one pack. Returns true if the
 * iOS share-sheet was invoked (user may still cancel inside it), false
 * if there are no verdicts to export.
 */
export async function exportPackVerdicts(package_id) {
  const verdictsMap = await loadVerdictsForPack(package_id);
  if (verdictsMap.size === 0) {
    return { invoked: false, reason: 'No verdicts to export yet.' };
  }

  const pack = await getPack(package_id);
  const created_at = new Date().toISOString();
  const items = [...verdictsMap.values()].map(v => ({
    det_id: v.det_id,
    decision: v.decision,
    decided_at: v.decided_at,
  }));
  const payload = {
    format_version: 1,
    package_id,
    job_id: pack?.manifest?.job_id ?? null,
    reviewer: 'mobile',
    device: navigator.userAgent.split(' ').slice(-2).join(' '),
    created_at,
    item_count: items.length,
    items,
  };

  const json = JSON.stringify(payload, null, 2);
  const ts = Math.floor(Date.now() / 1000);
  const filename = `verdicts_${package_id}_${ts}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    await putPack({ ...pack, last_exported_at: created_at, status: 'exported' });
    return { invoked: true, filename, count: items.length };
  }
  // Fallback: <a download> dumps to Downloads. Worse UX (no folder picker)
  // but better than nothing if the share-files API is missing.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  await putPack({ ...pack, last_exported_at: created_at, status: 'exported' });
  return { invoked: true, filename, count: items.length, fallback: true };
}

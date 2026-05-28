// OPFS-resident COG management.
//
// The map view uses one ortho-COG cached in the iPad's Origin Private File
// System. Persistence story:
//   - User picks the COG via Files picker → we stream it into OPFS in 8 MB
//     chunks (multi-GB files are fine; iOS Safari handles them)
//   - OPFS entries survive PWA cold-starts, Add-to-Home-Screen, app
//     switching. Only deliberate `clear()` or browser-level eviction
//     removes them
//   - On every page load we call `navigator.storage.persist()` to ask for
//     eviction protection. Safari grants/denies heuristically; we plan
//     defensively (re-import is a button-tap away)
//
// Metadata about the COG (name, size, sha256, etc.) lives in IDB under
// the `orthos` store added in state.js. OPFS holds the file bytes; IDB
// holds the index entry. They could go out of sync if the user deletes
// OPFS via Settings → Safari → clear website data — `getOrthoStatus()`
// reconciles both views and reports honestly.

const COG_FILENAME = 'ortho.tif';

/**
 * Return the OPFS root handle, requesting persistent storage first.
 * Persistence is best-effort — Safari may decline.
 */
async function _opfsRoot() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS not supported in this browser');
  }
  try {
    if (navigator.storage.persist) await navigator.storage.persist();
  } catch (e) { /* non-fatal */ }
  return await navigator.storage.getDirectory();
}

/**
 * Stream a File from a picker into OPFS as ./ortho.tif, in 8 MB chunks.
 * @param {File} file
 * @param {(p:{bytesWritten:number, totalBytes:number})=>void} [onProgress]
 * @returns {Promise<{sizeBytes:number, durationMs:number, mibPerSec:number}>}
 */
export async function streamCogIntoOpfs(file, onProgress) {
  const root = await _opfsRoot();
  // Remove any existing copy first so we don't end up with a partial overwrite
  // if the new write is shorter than the old file.
  try { await root.removeEntry(COG_FILENAME); } catch (e) { /* not present */ }

  const handle = await root.getFileHandle(COG_FILENAME, { create: true });
  const writable = await handle.createWritable();
  const totalBytes = file.size;
  const CHUNK = 8 * 1024 * 1024;
  const t0 = performance.now();
  let written = 0;
  try {
    while (written < totalBytes) {
      const end = Math.min(written + CHUNK, totalBytes);
      const chunk = file.slice(written, end);
      await writable.write(chunk);
      written = end;
      if (onProgress) onProgress({ bytesWritten: written, totalBytes });
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch (e) {}
    // On any write failure, scrub the partial file so future reads don't
    // see a half-written blob.
    try { await root.removeEntry(COG_FILENAME); } catch (e) {}
    throw err;
  }
  const durationMs = performance.now() - t0;
  const mibPerSec = (totalBytes / 1024 / 1024) / (durationMs / 1000);
  return { sizeBytes: totalBytes, durationMs, mibPerSec };
}

/**
 * Re-open the OPFS-resident COG as a Blob, suitable for OpenLayers
 * `ol/source/GeoTIFF`'s `{blob: ...}` source option.
 * @returns {Promise<?Blob>} null if no COG is currently in OPFS.
 */
export async function getOpfsCogBlob() {
  try {
    const root = await _opfsRoot();
    const handle = await root.getFileHandle(COG_FILENAME);
    return await handle.getFile();
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

/**
 * Lightweight status of the OPFS-resident COG. Does NOT load the file
 * into memory — just inspects metadata. Used by the library view to show
 * "Ortho loaded (8.2 GB)" or "No ortho loaded yet".
 */
export async function getOrthoStatus() {
  try {
    const root = await _opfsRoot();
    let handle;
    try {
      handle = await root.getFileHandle(COG_FILENAME);
    } catch (e) {
      if (e.name === 'NotFoundError') {
        return { present: false };
      }
      throw e;
    }
    const file = await handle.getFile();
    return {
      present: true,
      sizeBytes: file.size,
      lastModified: file.lastModified,
    };
  } catch (e) {
    return { present: false, error: e.message };
  }
}

/**
 * Browser-reported storage usage and quota. Useful for the "Storage
 * health" UI per the design review.
 */
export async function getStorageUsage() {
  if (!navigator.storage?.estimate) {
    return { usage: null, quota: null, persisted: null };
  }
  const est = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
  return {
    usage: est.usage ?? null,
    quota: est.quota ?? null,
    persisted,
  };
}

/** Permanently delete the OPFS-resident COG. */
export async function clearOpfsCog() {
  const root = await _opfsRoot();
  try {
    await root.removeEntry(COG_FILENAME);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}

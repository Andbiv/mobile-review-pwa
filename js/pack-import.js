// Pack import — file picker → JSZip → IndexedDB.

import { deletePack, getPack, openDb, putCrop, putPack } from './state.js';

const SUPPORTED_FORMAT_VERSION = 1;

/**
 * Open the iOS Files-app picker with multi-select and import every chosen
 * .zip. Returns a summary of what happened so the caller can show one
 * toast for the whole batch.
 *
 * Behavior on duplicates: in batch mode we **skip silently** rather than
 * prompt N times. To replace an already-imported pack, the user can
 * Delete it from the library and re-import. This keeps the multi-select
 * flow from blocking on a modal for every duplicate.
 *
 * @returns {Promise<{imported: string[], skipped: string[],
 *                    errors: {name:string, message:string}[]}>}
 */
/**
 * @param {(p:{index:number,total:number,file:string,phase:string})=>void} [onProgress]
 *        Optional progress callback fired before each file's unzip starts.
 *        Lets the caller show "Importing 2 of 4: pack_002.zip" rather than
 *        leaving the user staring at a frozen UI for tens of seconds.
 */
export async function pickAndImportPacks(onProgress) {
  const files = await pickZipFiles();
  const result = { imported: [], skipped: [], errors: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) {
      onProgress({ index: i, total: files.length, file: file.name, phase: 'start' });
    }
    try {
      // Pass a confirmFn that always declines so importPackZip silently
      // skips duplicates in batch mode rather than waiting for a modal.
      const id = await importPackZip(file, () => false);
      if (id) result.imported.push(id);
      else result.skipped.push(file.name);
    } catch (e) {
      console.error(`import failed for ${file.name}:`, e);
      result.errors.push({ name: file.name, message: e.message });
    }
  }
  return result;
}

/**
 * Show an <input type=file multiple> and resolve with the picked Files
 * (or an empty array on cancel). Multi-select is enabled so the user
 * can tap every pack in the OneDrive folder in one go.
 */
function pickZipFiles() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.zip,application/zip';
    inp.multiple = true;
    inp.style.display = 'none';
    inp.addEventListener('change', () => resolve([...(inp.files || [])]), { once: true });
    document.body.appendChild(inp);
    inp.click();
    // Cleanup later — leave in DOM until change fires so iOS doesn't drop it.
    setTimeout(() => inp.remove(), 60_000);
  });
}

/**
 * Unzip + persist a pack File into IDB. Returns the new package_id.
 * @param {File} file
 * @param {(msg:string)=>boolean|Promise<boolean>} confirmFn
 */
export async function importPackZip(file, confirmFn) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const manifestEntry = zip.file('manifest.json');
  const detectionsEntry = zip.file('detections.json');
  if (!manifestEntry || !detectionsEntry) {
    throw new Error(
      `Not a valid review pack — missing manifest.json or detections.json. ` +
      `Got ${zip.file(/.*/).length} files.`
    );
  }
  const manifest = JSON.parse(await manifestEntry.async('string'));
  const detections = JSON.parse(await detectionsEntry.async('string'));

  if (manifest.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new Error(
      `Unsupported pack format_version=${manifest.format_version}; ` +
      `this PWA only supports v${SUPPORTED_FORMAT_VERSION}.`
    );
  }

  const package_id = manifest.package_id;
  if (!package_id) throw new Error('manifest.json missing package_id');

  const existing = await getPack(package_id);
  if (existing) {
    const ok = await confirmFn(
      `Pack "${package_id}" is already imported (${existing.detections.length} ` +
      `detections). Replace the pack contents? Your verdicts will be preserved.`
    );
    if (!ok) return null;
    await deletePackContentOnly(package_id);
  }

  // Persist the pack record first so the library shows it even if crop
  // writes get interrupted.
  await putPack({
    package_id,
    manifest,
    detections,
    status: 'imported',
    imported_at: new Date().toISOString(),
    last_exported_at: null,
  });

  // Write JPEG blobs to the crops store. ~600 entries per pack — batch
  // small writes; bail loudly if quota hits.
  let written = 0;
  for (const det of detections) {
    const det_id = det.det_id;
    const rgbPath = det.crop_rgb || `crops/${det_id}.jpg`;
    const chmPath = det.crop_chm || `crops_chm/${det_id}.jpg`;
    const rgbEntry = zip.file(rgbPath);
    const chmEntry = zip.file(chmPath);
    if (!rgbEntry || !chmEntry) {
      console.warn('missing crop(s) for', det_id, { rgb: !!rgbEntry, chm: !!chmEntry });
      continue;
    }
    const [rgbBlob, chmBlob] = await Promise.all([
      rgbEntry.async('blob'),
      chmEntry.async('blob'),
    ]);
    // Store RGB and CHM under composite keys so the review view can fetch
    // either one without iterating all crops.
    await putCrop(package_id, `${det_id}_rgb`, rgbBlob);
    await putCrop(package_id, `${det_id}_chm`, chmBlob);
    written++;
  }
  console.log(`pack ${package_id}: wrote ${written}/${detections.length} crop pairs`);

  return package_id;
}

/**
 * Replace-without-deleting-verdicts helper — removes the pack record and
 * its crops but preserves rows in the verdicts store.
 */
async function deletePackContentOnly(package_id) {
  // The full deletePack() also removes verdicts, which is the wrong thing
  // on a replace. Re-implement here with only packs + crops in scope.
  const db = await openDb();
  const tx = db.transaction(['packs', 'crops'], 'readwrite');
  tx.objectStore('packs').delete(package_id);
  const crops = tx.objectStore('crops');
  const range = IDBKeyRange.bound([package_id, ''], [package_id, '￿']);
  await new Promise((resolve, reject) => {
    const cur = crops.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

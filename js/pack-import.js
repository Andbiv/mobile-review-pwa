// Pack import — file picker → JSZip → IndexedDB.

import { deletePack, getPack, openDb, putCrop, putPack } from './state.js';

const SUPPORTED_FORMAT_VERSION = 1;

/**
 * Open the iOS Files-app picker for a single .zip and import it.
 * Returns the imported pack's package_id (or null if user cancelled).
 *
 * If a pack with the same package_id already exists, prompts the user
 * to replace it. Verdicts indexed by (det_id, package_id) survive a
 * replace because they live in a separate object store.
 *
 * @param {(msg:string)=>boolean|Promise<boolean>} confirmFn
 *        Async confirm function the caller provides — typically a modal.
 *        Must return true if the user agrees to replace.
 * @returns {Promise<?string>} package_id imported, or null on cancel.
 */
export async function pickAndImportPack(confirmFn) {
  const file = await pickZipFile();
  if (!file) return null;
  return await importPackZip(file, confirmFn);
}

/**
 * Show an <input type=file> and resolve with the picked File (or null).
 */
function pickZipFile() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.zip,application/zip';
    inp.style.display = 'none';
    inp.addEventListener('change', () => resolve(inp.files[0] || null), { once: true });
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

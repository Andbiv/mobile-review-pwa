// IndexedDB wrapper — all client-side state lives here.
//
// Three object stores:
//   packs    {package_id (key), manifest, detections, status,
//             imported_at, last_exported_at}
//   verdicts (key: [det_id, package_id], decision, decided_at)
//   crops    (key: [package_id, det_id], blob)
//
// Why one IDB layer and not Cache Storage too: modern IDB handles Blob
// values natively, ~75 MB budget covers ~5 packs, eviction story is the
// same as Cache Storage. One eviction surface = simpler offline reasoning.

const DB_NAME = 'juniper-review';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let _db = null;

/** Open (or upgrade) the database. Idempotent. */
export function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'package_id' });
      }
      if (!db.objectStoreNames.contains('verdicts')) {
        const s = db.createObjectStore('verdicts', { keyPath: ['det_id', 'package_id'] });
        s.createIndex('by_pack', 'package_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('crops')) {
        db.createObjectStore('crops', { keyPath: ['package_id', 'det_id'] });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/** Request persistent storage. iOS Safari may silently no-op; that's OK. */
export async function ensurePersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      console.log('storage.persist granted:', granted);
    } catch (e) {
      console.warn('storage.persist threw:', e);
    }
  }
}

/** Wrap an IDBRequest as a Promise. */
function _req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Wrap a transaction's completion. */
function _tx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
  });
}

// ---------------------------------------------------------------- packs

/**
 * @typedef {Object} PackRecord
 * @property {string} package_id
 * @property {object} manifest
 * @property {Array<object>} detections
 * @property {'imported'|'in_progress'|'exported'} status
 * @property {string} imported_at  ISO
 * @property {?string} last_exported_at  ISO
 */

/** @returns {Promise<PackRecord[]>} */
export async function listPacks() {
  const db = await openDb();
  const tx = db.transaction('packs', 'readonly');
  return _req(tx.objectStore('packs').getAll());
}

/** @param {string} package_id @returns {Promise<PackRecord|undefined>} */
export async function getPack(package_id) {
  const db = await openDb();
  const tx = db.transaction('packs', 'readonly');
  return _req(tx.objectStore('packs').get(package_id));
}

/** @param {PackRecord} pack */
export async function putPack(pack) {
  const db = await openDb();
  const tx = db.transaction('packs', 'readwrite');
  tx.objectStore('packs').put(pack);
  return _tx(tx);
}

/** Remove a pack and all its crops + verdicts. */
export async function deletePack(package_id) {
  const db = await openDb();
  const tx = db.transaction(['packs', 'crops', 'verdicts'], 'readwrite');
  tx.objectStore('packs').delete(package_id);
  // Delete crops with key range starting [package_id]
  const cropsStore = tx.objectStore('crops');
  const range = IDBKeyRange.bound([package_id, ''], [package_id, '￿']);
  cropsStore.delete(range);
  // Delete verdicts via index
  const verdictsStore = tx.objectStore('verdicts');
  const idx = verdictsStore.index('by_pack');
  await _req(idx.openKeyCursor(IDBKeyRange.only(package_id))).then(_ => {});
  await new Promise((resolve, reject) => {
    const cur = idx.openCursor(IDBKeyRange.only(package_id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return _tx(tx);
}

// ---------------------------------------------------------------- crops

export async function putCrop(package_id, det_id, blob) {
  const db = await openDb();
  const tx = db.transaction('crops', 'readwrite');
  tx.objectStore('crops').put({ package_id, det_id, blob });
  return _tx(tx);
}

/** @returns {Promise<Blob|undefined>} */
export async function getCrop(package_id, det_id) {
  const db = await openDb();
  const tx = db.transaction('crops', 'readonly');
  const rec = await _req(tx.objectStore('crops').get([package_id, det_id]));
  return rec ? rec.blob : undefined;
}

// ---------------------------------------------------------------- verdicts

/**
 * @typedef {Object} Verdict
 * @property {string} det_id
 * @property {string} package_id
 * @property {'TP'|'FP'|'SKIP'} decision
 * @property {string} decided_at  ISO UTC
 */

/** @param {Verdict} v */
export async function putVerdict(v) {
  const db = await openDb();
  const tx = db.transaction('verdicts', 'readwrite');
  tx.objectStore('verdicts').put(v);
  return _tx(tx);
}

export async function deleteVerdict(det_id, package_id) {
  const db = await openDb();
  const tx = db.transaction('verdicts', 'readwrite');
  tx.objectStore('verdicts').delete([det_id, package_id]);
  return _tx(tx);
}

/** Return a Map(det_id -> Verdict) for one pack. */
export async function loadVerdictsForPack(package_id) {
  const db = await openDb();
  const tx = db.transaction('verdicts', 'readonly');
  const idx = tx.objectStore('verdicts').index('by_pack');
  const rows = await _req(idx.getAll(IDBKeyRange.only(package_id)));
  const map = new Map();
  for (const r of rows) map.set(r.det_id, r);
  return map;
}

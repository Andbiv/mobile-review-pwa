// Map view — pan/pinch-zoom the ortho COG (from OPFS) with detections
// overlaid as colored polygons. Cut 3 of the iPad-parity build.
//
// Tap a detection → opens its review card. Tap an empty area → drops an
// "add this missed tree" marker (Cut 4; for now we just navigate to review).
//
// OpenLayers is lazy-loaded from CDN the first time the map view opens —
// we don't want to pay ~500KB on the library/review code path.

import { BUILD } from '../build.js';
import { forceUpdate } from '../update.js';
import {
  deleteAdd, listAddsForJob, listPacks, loadAllVerdicts, putAdd,
} from '../state.js';
import {
  clearOpfsCog, getOpfsCogBlob, getOrthoStatus, getStorageUsage,
} from '../ortho.js';
import { exportAddsForJob } from '../adds-export.js';

// Vendored locally so we never depend on CDN behavior. Both files live in
// /vendor/ and are part of the SW shell cache — they work offline after
// the PWA's first online launch.
const OL_JS = './vendor/ol.js';
const OL_CSS = './vendor/ol.css';
const GEOTIFF_JS = './vendor/geotiff.js';

const STYLE_BY_DECISION = {
  null:    { stroke: 'rgba(255, 255, 0, 0.95)', fill: 'rgba(255, 255, 0, 0.10)' },
  TP:      { stroke: 'rgba( 76, 175,  80, 0.95)', fill: 'rgba( 76, 175,  80, 0.20)' },
  FP:      { stroke: 'rgba(229,  57,  53, 0.95)', fill: 'rgba(229,  57,  53, 0.20)' },
  SKIP:    { stroke: 'rgba(117, 117, 117, 0.90)', fill: 'rgba(117, 117, 117, 0.15)' },
  IGNORE:  { stroke: 'rgba(117, 117, 117, 0.90)', fill: 'rgba(117, 117, 117, 0.15)' },
};

/**
 * Lazy-load OpenLayers + geotiff.js (only when the map view is opened).
 *
 * Loading order matters: geotiff.js sets window.GeoTIFF; ol.js then
 * looks that global up at module-init time. Sequential load + verification
 * that the global actually exists after each step so a quiet failure is
 * surfaced with a useful error rather than a generic "Can't find variable".
 */
let _olLoaded = false;
async function loadOl() {
  if (_olLoaded || typeof ol !== 'undefined') { _olLoaded = true; return; }

  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = OL_CSS;
  document.head.appendChild(link);

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

  await loadScript(GEOTIFF_JS);
  if (typeof GeoTIFF === 'undefined') {
    throw new Error(
      'vendor/geotiff.js loaded but window.GeoTIFF is undefined. ' +
      'The vendored UMD file may be corrupt — re-download.'
    );
  }
  await loadScript(OL_JS);
  if (typeof ol === 'undefined' || !ol.source || !ol.source.GeoTIFF) {
    throw new Error(
      'vendor/ol.js loaded but ol.source.GeoTIFF is missing. ' +
      'The vendored OpenLayers UMD may not include the GeoTIFF source.'
    );
  }
  _olLoaded = true;
}

/**
 * Top-level entry from the router. Builds the view shell, then either
 * opens the map (if a COG is in OPFS) or shows the "Load ortho" panel.
 */
export async function renderMap(container) {
  container.innerHTML = `
    <header class="app-header">
      <div class="title">Map</div>
      <div class="actions">
        <span class="version-chip" title="PWA build identifier">${escapeHtml(BUILD)}</span>
        <button class="subtle refresh-btn" id="map-refresh" title="Force update" aria-label="Update">↻</button>
        <button class="subtle" onclick="location.hash='#library'">Library</button>
      </div>
    </header>
    <div id="map-body" class="map-body">
      <div class="loading">Checking OPFS…</div>
    </div>
  `;
  document.getElementById('map-refresh').addEventListener('click', forceUpdate);

  const status = await getOrthoStatus();
  if (!status.present) {
    await renderLoadOrthoPanel();
    return;
  }
  await renderMapWithOrtho();
}

/**
 * Empty-state panel inviting the user to load a COG from Files.
 */
async function renderLoadOrthoPanel() {
  const body = document.getElementById('map-body');
  const usage = await getStorageUsage();
  body.innerHTML = `
    <div class="empty">
      <div class="big">No ortho loaded.</div>
      <div>To pan and pinch-zoom across the whole flight on the iPad,
           you need a Cloud-Optimized GeoTIFF (COG) of the ortho in your
           PWA's local storage.</div>
      <div style="margin-top:1em">
        Build one on the desktop:
        <div style="background:#000; color:#dfd; padding:.6em; border-radius:.4em;
                    font-family:ui-monospace,monospace; font-size:.78em; overflow:auto;
                    margin-top:.4em">
brd mobile cogify --source D:/path/to/ortho.vrt
        </div>
        Then "Make available offline" on the resulting <code>orthos/*_cog.tif</code>
        in the OneDrive iOS app, and import it here.
      </div>
      <div class="btn-row" style="justify-content:center; margin-top:1.4em">
        <button class="primary" id="pick-cog">+ Load ortho COG</button>
      </div>
      <progress id="cog-progress" max="1" value="0" style="display:none; width:100%; margin-top:.6em"></progress>
      <div id="storage-line" class="meta" style="margin-top:1em; font-family:ui-monospace,monospace; font-size:.78em">${formatUsage(usage)}</div>
    </div>
  `;
  document.getElementById('pick-cog').addEventListener('click', pickAndLoadCog);
}

/**
 * Open the iOS Files picker for a .tif, stream into OPFS, then re-render.
 */
async function pickAndLoadCog() {
  const { streamCogIntoOpfs } = await import('../ortho.js');
  const inp = document.createElement('input');
  inp.type = 'file';
  // No accept filter — iOS Files hides .tif when it isn't classified as
  // image/tiff (which it often isn't for OneDrive-synced GeoTIFFs).
  inp.style.display = 'none';
  inp.addEventListener('change', async () => {
    const file = inp.files[0];
    if (!file) return;
    const prog = document.getElementById('cog-progress');
    const tip = window.showProgress(`Loading ortho (${(file.size/1e9).toFixed(2)} GB)…`);
    if (prog) { prog.style.display = 'block'; prog.value = 0; }
    try {
      const r = await streamCogIntoOpfs(file, ({ bytesWritten, totalBytes }) => {
        if (prog) prog.value = bytesWritten / totalBytes;
        tip.update(`Loading ortho: ${(bytesWritten/1e9).toFixed(2)} / ${(totalBytes/1e9).toFixed(2)} GB`);
      });
      tip.done(`✓ Ortho ready (${(r.sizeBytes/1e9).toFixed(2)} GB in ${(r.durationMs/1000).toFixed(1)}s, ${r.mibPerSec.toFixed(1)} MiB/s)`, 'ok', 4000);
      await renderMapWithOrtho();
    } catch (e) {
      tip.done(`✗ Load failed: ${e.message}`, 'err', 6000);
      if (prog) prog.style.display = 'none';
    }
  }, { once: true });
  document.body.appendChild(inp);
  inp.click();
  setTimeout(() => inp.remove(), 60_000);
}

/**
 * Build the actual map: COG layer + detection overlay + hit-testing.
 */
async function renderMapWithOrtho() {
  const body = document.getElementById('map-body');
  body.innerHTML = `
    <div id="map-canvas"></div>
    <div class="map-overlay-controls">
      <div id="map-status" class="map-status-chip">loading…</div>
      <button class="subtle" id="reload-cog">Replace ortho</button>
      <button class="subtle danger" id="delete-cog">Delete from OPFS</button>
    </div>
  `;
  document.getElementById('reload-cog').addEventListener('click', async () => {
    await clearOpfsCog();
    await renderLoadOrthoPanel();
  });
  document.getElementById('delete-cog').addEventListener('click', async () => {
    if (!confirm('Delete the local ortho copy? (You can re-import from OneDrive any time.)')) return;
    await clearOpfsCog();
    await renderLoadOrthoPanel();
  });

  try {
    await loadOl();
  } catch (e) {
    document.getElementById('map-status').textContent = e.message;
    return;
  }

  const cogBlob = await getOpfsCogBlob();
  if (!cogBlob) {
    document.getElementById('map-status').textContent = 'OPFS COG vanished — re-import?';
    return;
  }

  // --- COG base layer ---
  const source = new ol.source.GeoTIFF({
    sources: [{ blob: cogBlob }],
    // convertToRGB: true,  // uncomment if multi-band COG renders wrong
  });
  const baseLayer = new ol.layer.WebGLTile({ source });

  // --- Detection overlay layer ---
  const overlay = new ol.layer.Vector({
    source: new ol.source.Vector(),
    style: featureStyle,
  });

  // --- Adds layer (missed-tree markers — Cut 4) ---
  const addsLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    style: addStyle,
  });

  const map = new ol.Map({
    target: 'map-canvas',
    layers: [baseLayer, overlay, addsLayer],
    view: await source.getView(),
    controls: ol.control.defaults.defaults({ rotate: false, attribution: false }),
  });

  // --- Load detections + existing adds ---
  await populateDetectionOverlay(overlay);
  const jobContext = await deriveJobContext();
  if (jobContext) await populateAddsLayer(addsLayer, jobContext.job_id);

  // --- Long-press to drop a missed-tree marker ---
  bindLongPress(map, addsLayer, jobContext);

  // --- Tap-to-review (or tap-to-delete-add) hit testing ---
  map.on('singleclick', async ev => {
    let handled = false;
    map.forEachFeatureAtPixel(ev.pixel, feature => {
      if (handled) return;
      const add = feature.get('add');
      if (add) {
        if (confirm(`Delete this missed-tree add (radius ${add.radius_m} m)?`)) {
          deleteAdd(add.add_uuid).then(() => {
            addsLayer.getSource().removeFeature(feature);
            updateStatusChip(cogBlob, overlay, addsLayer);
          });
        }
        handled = true;
        return true;
      }
      const det = feature.get('det');
      if (det && det.package_id) {
        location.hash = `#review/${encodeURIComponent(det.package_id)}?det=${encodeURIComponent(det.det_id)}`;
        handled = true;
        return true;
      }
    }, { hitTolerance: 4 });
  });

  updateStatusChip(cogBlob, overlay, addsLayer);

  // Adds-export button — wires to job context if any
  const exportBtn = document.createElement('button');
  exportBtn.className = 'subtle';
  exportBtn.textContent = 'Export adds';
  exportBtn.addEventListener('click', async () => {
    if (!jobContext) {
      window.showToast('No imported packs — adds need a job context.', 'err', 4000);
      return;
    }
    const r = await exportAddsForJob(jobContext.job_id, jobContext);
    if (!r.invoked) {
      window.showToast(r.reason || 'Nothing to export', 'err');
      return;
    }
    window.showToast(
      `${r.count} adds ready in share-sheet. Pick "Save to Files" → OneDrive.`,
      'ok', 4000,
    );
  });
  document.querySelector('.map-overlay-controls').prepend(exportBtn);
}

function updateStatusChip(cogBlob, overlay, addsLayer) {
  const dets = overlay.getSource().getFeatures().length;
  const adds = addsLayer.getSource().getFeatures().length;
  const sizeGb = (cogBlob.size / 1e9).toFixed(2);
  document.getElementById('map-status').textContent =
    `${dets} dets · ${adds} adds · ${sizeGb} GB ortho`;
}

/**
 * Adds reference a job_id (which review.sqlite to write into on ingest).
 * For v1 we assume one ortho = one flight, so derive job_id from the
 * first imported pack. Multi-job workflows would need a per-pack picker;
 * defer until we hit it.
 */
async function deriveJobContext() {
  const packs = await listPacks();
  if (packs.length === 0) return null;
  // Sort by imported_at oldest-first for determinism.
  packs.sort((a, b) => (a.imported_at || '').localeCompare(b.imported_at || ''));
  const first = packs[0];
  return {
    job_id: first.manifest?.job_id ?? first.package_id,
    ortho_id: first.manifest?.source_image
      ? first.manifest.source_image.split(/[\\/]/).pop()
      : null,
  };
}

async function populateAddsLayer(addsLayer, job_id) {
  const adds = await listAddsForJob(job_id);
  const reader = new ol.format.GeoJSON({
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });
  const features = [];
  for (const a of adds) {
    if (!a.geom_wgs84) continue;
    try {
      const feat = new ol.Feature({ geometry: reader.readGeometry(a.geom_wgs84) });
      feat.set('add', a);
      features.push(feat);
    } catch (e) { console.debug('add render failed', a.add_uuid, e); }
  }
  addsLayer.getSource().addFeatures(features);
}

/**
 * Bind a long-press detector on the map viewport. After ~600 ms of a
 * single steady pointer on empty map area (no detection hit), shows the
 * "add missed tree" modal.
 *
 * Uses PointerEvents on the map's viewport DOM rather than OL's own
 * event system because OL doesn't expose a clean long-press hook.
 */
function bindLongPress(map, addsLayer, jobContext) {
  const viewport = map.getViewport();
  const HOLD_MS = 600;
  const MOVE_TOLERANCE = 6;
  let pressTimer = null;
  let pressStart = null;
  let pressCoord = null;

  function abort() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStart = null; pressCoord = null;
  }

  viewport.addEventListener('pointerdown', ev => {
    if (ev.button && ev.button !== 0) return;
    if (!jobContext) return;  // can't make an add without a job context
    pressStart = { x: ev.clientX, y: ev.clientY };
    const rect = viewport.getBoundingClientRect();
    const px = [ev.clientX - rect.left, ev.clientY - rect.top];
    pressCoord = map.getCoordinateFromPixel(px);
    // Don't long-press on top of an existing feature — that's a tap.
    let onFeature = false;
    map.forEachFeatureAtPixel(px, () => { onFeature = true; return true; }, { hitTolerance: 4 });
    if (onFeature) { abort(); return; }
    pressTimer = setTimeout(() => {
      if (pressCoord) {
        const wgs = ol.proj.toLonLat(pressCoord);
        showAddDialog(wgs, addsLayer, jobContext);
      }
      pressTimer = null;
    }, HOLD_MS);
  });

  viewport.addEventListener('pointermove', ev => {
    if (!pressStart) return;
    const dx = ev.clientX - pressStart.x;
    const dy = ev.clientY - pressStart.y;
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE) abort();
  });

  viewport.addEventListener('pointerup', abort);
  viewport.addEventListener('pointercancel', abort);
}

/**
 * Modal: numeric radius input + Save / Cancel. Skipping drag-handle resize
 * for v1 — typing or +/- buttons is more reliable on touch than designing
 * a hit-test for a tiny handle dot.
 */
function showAddDialog(coordWgs84, addsLayer, jobContext) {
  const [lon, lat] = coordWgs84;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal">
      <h2>Add missed tree</h2>
      <div class="meta">Center: ${lat.toFixed(6)}, ${lon.toFixed(6)}</div>
      <div style="margin-top:.8em">
        <label for="add-radius">Crown radius (m):</label>
        <div style="display:flex; gap:.4em; align-items:center; margin-top:.3em">
          <button type="button" data-r="-0.5">−0.5</button>
          <input type="number" id="add-radius" value="1.0" min="0.2" max="10" step="0.1"
                 style="flex:1; padding:.5em; font-size:1.1em">
          <button type="button" data-r="+0.5">+0.5</button>
        </div>
      </div>
      <div class="row">
        <button class="subtle" data-act="cancel">Cancel</button>
        <button class="primary" data-act="save">Save add</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const radiusInput = wrap.querySelector('#add-radius');
  wrap.addEventListener('click', async (e) => {
    const r = e.target.dataset?.r;
    if (r) {
      const cur = parseFloat(radiusInput.value) || 1.0;
      const next = Math.max(0.2, Math.min(10, cur + parseFloat(r)));
      radiusInput.value = next.toFixed(1);
      return;
    }
    const act = e.target.dataset?.act;
    if (e.target === wrap || act === 'cancel') { wrap.remove(); return; }
    if (act === 'save') {
      const radius = parseFloat(radiusInput.value) || 1.0;
      const poly = circleToPolygonWgs84(lon, lat, radius);
      const add = {
        add_uuid: (crypto.randomUUID ? crypto.randomUUID() : `add-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        job_id: jobContext.job_id,
        ortho_id: jobContext.ortho_id,
        geom_wgs84: poly,
        radius_m: radius,
        source: 'mobile',
        created_at: new Date().toISOString(),
      };
      try {
        await putAdd(add);
        const reader = new ol.format.GeoJSON({
          dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
        });
        const feat = new ol.Feature({ geometry: reader.readGeometry(poly) });
        feat.set('add', add);
        addsLayer.getSource().addFeature(feat);
        window.showToast(`Add saved (radius ${radius} m)`, 'ok');
      } catch (err) {
        console.error('save add failed', err);
        window.showToast(`Save failed: ${err.message}`, 'err', 4000);
      }
      wrap.remove();
    }
  });
}

/**
 * Approximate a small (<a few hundred meters) circle on Earth as a 32-vertex
 * polygon in WGS84. Accurate within ~1cm at our 1–5 m radii because the
 * curvature over those distances is negligible at any latitude this drone
 * will fly. Avoids pulling in turf.js for a single function.
 */
function circleToPolygonWgs84(centerLon, centerLat, radiusMeters, segments = 32) {
  const points = [];
  const R = 6378137;  // WGS84 mean radius in meters
  const latRad = centerLat * Math.PI / 180;
  for (let i = 0; i < segments; i++) {
    const bearing = (i / segments) * 2 * Math.PI;
    const dNorth = radiusMeters * Math.cos(bearing);
    const dEast = radiusMeters * Math.sin(bearing);
    const dLat = (dNorth / R) * (180 / Math.PI);
    const dLon = (dEast / (R * Math.cos(latRad))) * (180 / Math.PI);
    points.push([centerLon + dLon, centerLat + dLat]);
  }
  points.push(points[0]);
  return { type: 'Polygon', coordinates: [points] };
}

function addStyle() {
  // Bright cyan ring so adds stand out clearly from yellow/green/red dets.
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(0, 188, 212, 0.95)', width: 3 }),
    fill: new ol.style.Fill({ color: 'rgba(0, 188, 212, 0.18)' }),
  });
}

/**
 * Build OL features from every pack in IDB. geom_wgs84 (added in Cut 1)
 * is the source of truth; older packs without it get skipped silently.
 */
async function populateDetectionOverlay(overlay) {
  const packs = await listPacks();
  const verdictMap = await loadAllVerdicts();
  const features = [];
  const geomReader = new ol.format.GeoJSON({
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',  // OL's default web-mercator view space
  });
  for (const pack of packs) {
    for (const det of pack.detections) {
      if (!det.geom_wgs84) continue;
      try {
        const geom = geomReader.readGeometry(det.geom_wgs84);
        const v = verdictMap.get(det.det_id);
        const feat = new ol.Feature({ geometry: geom });
        feat.set('det', {
          det_id: det.det_id,
          package_id: pack.package_id,
          cls: det.cls,
          conf: det.conf,
        });
        feat.set('decision', v ? v.decision : null);
        features.push(feat);
      } catch (e) {
        console.debug('skip det', det.det_id, e.message);
      }
    }
  }
  overlay.getSource().addFeatures(features);
}

/**
 * Style function — color by current verdict, switch to centroid dot at
 * low zoom so 5,000+ polygons stay snappy.
 */
function featureStyle(feature, resolution) {
  const decision = feature.get('decision');
  const sty = STYLE_BY_DECISION[decision] || STYLE_BY_DECISION[null];
  // resolution in meters/pixel; ~0.5 m/px = "review zoom" → full geometry.
  if (resolution > 0.5) {
    // overview zoom: dot at centroid
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: sty.stroke }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.7)', width: 1 }),
      }),
      geometry: f => {
        const g = f.getGeometry();
        const c = g.getInteriorPoint ? g.getInteriorPoint() : g;
        return c;
      },
    });
  }
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: sty.stroke, width: 2 }),
    fill: new ol.style.Fill({ color: sty.fill }),
  });
}

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatUsage(u) {
  if (!u || u.usage == null) return 'storage estimate unavailable';
  const used = (u.usage / 1e9).toFixed(2);
  const quota = u.quota ? (u.quota / 1e9).toFixed(1) : '?';
  const pct = u.quota ? ((u.usage / u.quota) * 100).toFixed(1) : '?';
  return `Storage: ${used} GB used of ${quota} GB quota (${pct}%) · persisted=${u.persisted}`;
}

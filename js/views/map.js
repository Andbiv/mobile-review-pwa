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
import { listPacks, loadAllVerdicts } from '../state.js';
import {
  clearOpfsCog, getOpfsCogBlob, getOrthoStatus, getStorageUsage,
} from '../ortho.js';

const OL_VERSION = '10.5.0';
const OL_JS = `https://cdn.jsdelivr.net/npm/ol@${OL_VERSION}/dist/ol.js`;
const OL_CSS = `https://cdn.jsdelivr.net/npm/ol@${OL_VERSION}/ol.css`;

const STYLE_BY_DECISION = {
  null:    { stroke: 'rgba(255, 255, 0, 0.95)', fill: 'rgba(255, 255, 0, 0.10)' },
  TP:      { stroke: 'rgba( 76, 175,  80, 0.95)', fill: 'rgba( 76, 175,  80, 0.20)' },
  FP:      { stroke: 'rgba(229,  57,  53, 0.95)', fill: 'rgba(229,  57,  53, 0.20)' },
  SKIP:    { stroke: 'rgba(117, 117, 117, 0.90)', fill: 'rgba(117, 117, 117, 0.15)' },
  IGNORE:  { stroke: 'rgba(117, 117, 117, 0.90)', fill: 'rgba(117, 117, 117, 0.15)' },
};

/**
 * Lazy-load OpenLayers (only when the map view is opened).
 */
let _olLoaded = false;
async function loadOl() {
  if (_olLoaded || typeof ol !== 'undefined') { _olLoaded = true; return; }
  await new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = OL_CSS;
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = OL_JS;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => reject(new Error(
      `Failed to load OpenLayers from CDN (${OL_JS}). ` +
      `Check network — first-time map load needs Internet to fetch the library.`
    ));
    document.head.appendChild(script);
  });
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
  inp.accept = '.tif,.tiff,image/tiff';
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

  const map = new ol.Map({
    target: 'map-canvas',
    layers: [baseLayer, overlay],
    view: await source.getView(),
    controls: ol.control.defaults.defaults({ rotate: false, attribution: false }),
  });

  // --- Load detections into the overlay ---
  await populateDetectionOverlay(overlay);

  // --- Tap-to-review hit testing ---
  map.on('singleclick', ev => {
    map.forEachFeatureAtPixel(ev.pixel, feature => {
      const det = feature.get('det');
      if (det && det.package_id) {
        location.hash = `#review/${encodeURIComponent(det.package_id)}?det=${encodeURIComponent(det.det_id)}`;
        return true;
      }
    }, { layerFilter: l => l === overlay, hitTolerance: 4 });
  });

  // Live status badge
  const features = overlay.getSource().getFeatures();
  document.getElementById('map-status').textContent =
    `${features.length} dets · ${(cogBlob.size/1e9).toFixed(2)} GB ortho`;
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

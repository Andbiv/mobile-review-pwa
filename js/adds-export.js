// Missed-tree adds export — IDB adds -> GeoJSON FeatureCollection -> iOS
// share-sheet -> OneDrive.
//
// Filename: adds_<job_id>_<unix_ts>.geojson
//
// Desktop ingester contract:
// - Replays all adds_<job_id>_*.geojson files for a job
// - Deduplicates by add_uuid (idempotent re-import)
// - Converts circle (center + radius) to a polygon at ingest time using
//   the project CRS for accurate geometry
// - Writes to review.sqlite adds table with source='mobile'

import { listAddsForJob } from './state.js';

export async function exportAddsForJob(job_id, packMeta) {
  const adds = await listAddsForJob(job_id);
  if (adds.length === 0) {
    return { invoked: false, reason: 'No adds to export yet.' };
  }

  const ts = Math.floor(Date.now() / 1000);
  const filename = `adds_${job_id}_${ts}.geojson`;

  // GeoJSON FeatureCollection — explicit CRS metadata so desktop knows
  // to interpret coords as WGS84 even though it's the GeoJSON default.
  const fc = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' },
    },
    metadata: {
      format_version: 1,
      job_id,
      ortho_id: packMeta?.ortho_id ?? null,
      source: 'mobile',
      reviewer: 'mobile',
      device: navigator.userAgent.split(' ').slice(-2).join(' '),
      created_at: new Date().toISOString(),
    },
    features: adds.map(a => ({
      type: 'Feature',
      id: a.add_uuid,
      geometry: a.geom_wgs84,
      properties: {
        add_uuid: a.add_uuid,
        job_id: a.job_id,
        ortho_id: a.ortho_id,
        radius_m: a.radius_m ?? null,
        cls: a.cls ?? 'juniper',
        note: a.note ?? null,
        source: 'mobile',
        created_at: a.created_at,
      },
    })),
  };

  const json = JSON.stringify(fc, null, 2);
  const blob = new Blob([json], { type: 'application/geo+json' });
  const file = new File([blob], filename, { type: 'application/geo+json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return { invoked: true, filename, count: adds.length };
  }
  // Fallback: dump to Downloads.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { invoked: true, filename, count: adds.length, fallback: true };
}

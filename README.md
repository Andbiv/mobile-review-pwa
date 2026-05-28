# mobile-review-pwa

iPad/iPhone PWA for reviewing juniper detections from BrushDrone — companion to
[`Andbiv/_Scripts`](https://github.com/Andbiv/_Scripts).

**Live:** https://andbiv.github.io/mobile-review-pwa/ (real PWA)
**Spike:** https://andbiv.github.io/mobile-review-pwa/spike/ (transport-validation artifact from 2026-05-28)

## Architecture (TL;DR)

- Desktop (BrushDrone Python `brd mobile export`) writes pack zips to a BCI OneDrive folder
- OneDrive iOS app syncs them to iPad; they appear in the **Files app**
- **This PWA**: pick a pack zip via Files-app picker → unzip with JSZip → store in IndexedDB
  → swipe TP / FP / SKIP per detection offline → export verdicts JSON via the iOS share-sheet
  back to OneDrive
- Desktop `brd mobile import` (Phase 4) reads verdict JSONs from OneDrive back into
  `review.sqlite`

No Microsoft Graph, no MSAL, no Azure app registration. iOS handles the auth via the
OneDrive app already installed on the device.

Full plan: `BrushDrone_v2/docs/MOBILE_REVIEW_PWA_PLAN.md` on the `feat/mobile-review-pwa`
branch of `Andbiv/_Scripts`. Tracking: `Andbiv/_Scripts#6`.

## Pack format (PWA contract with the desktop exporter)

Each pack zip contains:

- `manifest.json` — `{format_version: 1, package_id, job_id, area_label, count, created_at}`
- `detections.json` — array of `{det_id, cls, conf, area_m2, prior_decision, crop_rgb, crop_chm, ...}`
- `crops/<det_id>.jpg` — RGB crop with the polygon outline drawn
- `crops_chm/<det_id>.jpg` — CHM crop with viridis colormap + height legend

The PWA stores the manifest + detections in IndexedDB and the JPEG blobs as Blob values
in a separate IDB object store (no Cache Storage layer).

## Verdict export contract (PWA → Phase 4 ingester)

Filename: **`verdicts_<package_id>_<unix_ts>.json`**

The unix-timestamp suffix is load-bearing: the desktop ingester replays *all* matching
files for a pack and takes the **latest `decided_at` per `det_id`**. This means:

- Multiple exports for the same pack are safe (review some today, more tomorrow)
- Re-importing the same file is idempotent
- The PWA never needs to "track which verdicts were already exported"

Verdict JSON schema:

```json
{
  "format_version": 1,
  "package_id": "JA_..._pack_001",
  "job_id": "JA_..._smoke",
  "reviewer": "mobile",
  "device": "Safari/605.1.15",
  "created_at": "2026-05-28T19:00:00Z",
  "item_count": 25,
  "items": [
    {"det_id": "e03b2da39f6e6eda", "decision": "TP", "decided_at": "2026-05-28T18:59:42Z"},
    {"det_id": "380a0549859999d8", "decision": "FP", "decided_at": "2026-05-28T18:59:48Z"}
  ]
}
```

Decisions are exactly `"TP"`, `"FP"`, or `"SKIP"`. Per the plan §B, a `SKIP` must
never overwrite a real `TP`/`FP` on ingest.

## Storage layout (IndexedDB)

| Store    | Key                       | Value                                              |
|----------|---------------------------|----------------------------------------------------|
| packs    | `package_id`              | `{manifest, detections, status, imported_at, ...}` |
| crops    | `[package_id, det_id_*]`  | `{blob: Blob}` — `_rgb` and `_chm` suffix variants |
| verdicts | `[det_id, package_id]`    | `{decision, decided_at}`                           |

Verdicts are indexed by `(det_id, package_id)` so re-importing a pack (e.g. after
fixing a crop bug on the desktop) preserves the user's in-progress verdicts.

## Layout

- `/` — real PWA (this readme's main subject)
- `/spike/` — throwaway transport-validation test from 2026-05-28. Kept as a debug tool —
  run it any time to re-confirm Files-app picker + share-sheet still works after iOS updates.

## Local dev

Static site, no build step. Serve any way:

```
cd mobile-review-pwa
python -m http.server 8000
# visit http://localhost:8000/
```

Service worker + IDB require HTTPS or `localhost`. iOS Safari will not install a PWA
without HTTPS, so for iPad testing use the GitHub Pages URL.

## Why no framework

Two views, ~600 LOC of JS total. A framework would add bundling, build steps, and a
~50 KB runtime for no real win. The PWA loads instantly even on poor signal because
the shell is tiny.

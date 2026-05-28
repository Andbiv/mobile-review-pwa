# mobile-review-pwa

iPad/iPhone PWA for reviewing juniper detections from BrushDrone — companion to
[`Andbiv/_Scripts`](https://github.com/Andbiv/_Scripts) (the BrushDrone desktop app).

**Status:** scaffolding. Spike validation in progress.

## Architecture

- Desktop (BrushDrone Python) exports "review packs" (zips of JPEG crops + metadata) to a
  BCI OneDrive folder.
- OneDrive iOS app syncs the folder to iPad; the folder appears in the **Files app**.
- This PWA reads pack zips through the iOS Files picker, lets the user swipe TP/FP/SKIP
  offline, and writes verdict files back through the iOS share-sheet → "Save to Files".
- OneDrive syncs verdicts back to desktop. `brd mobile import` ingests them.

No Microsoft Graph, no MSAL, no Azure app registration. iOS does the auth via the
OneDrive app already installed on the device.

Full plan: `BrushDrone_v2/docs/MOBILE_REVIEW_PWA_PLAN.md` on the `feat/mobile-review-pwa`
branch of `Andbiv/_Scripts`. Tracking: `Andbiv/_Scripts#6`.

## Layout

- `/` — placeholder until the real PWA lands
- `/spike/` — throwaway transport-validation test (2026-05-28). Hand the URL to the user
  on their iPad; runs three tests to validate the Files-app + share-sheet round-trip
  works before sinking a week into the exporter.

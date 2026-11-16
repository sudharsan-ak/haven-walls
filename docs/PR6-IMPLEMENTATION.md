# PR #6: Browser Review → Library

Branch: feature/pr6-persistent-browser-review
Base: main (after PR #5, merge commit b99f334)
Status: Draft. Do not merge until Windows build and functionality are approved.

## Commit 1: Persist the Browser Review selection (this commit)

- Store the Review queue in Haven Walls' existing SQLite database as a
  single, transactionally replaced JSON snapshot. The new browser_review
  table is created with IF NOT EXISTS; migrations do not overwrite the
  browser tabs, cookies, bookmarks, API credentials, or managed wallpapers.
- The new browser_load_review / browser_save_review Tauri commands use the
  same StorageLock and app-owned data root as existing Library and browser
  preferences. The queue follows configured AppData / portable storage.
- Store up to 30 user-selected images, including image URL, original URL,
  alternate candidate URLs, title, source page, attribution, rights status,
  and reported dimensions. The Review queue contains URL metadata ONLY.
  No automatic source downloads, thumbnails, image files, or telemetry.
- Image links must be public HTTPS addresses, not local files, browser
  internal pages or localhost/private IP endpoints. Invalid transient
  data URLs from full-resolution previews are not persisted.
- A failed load cannot trigger an empty save that overwrites the previously
  persisted queue. A failure is surfaced to the UI and must be fixed before
  persistence resumes. Writes are serialized so rapid add/remove/clear
  actions cannot re-order snapshots.
- Restored Review selections survive switching browser tabs, returning
  from Gallery, restarting the app and normal application rebuilds.
- Duplicate selections are consolidated; inspecting a selected image
  refreshes its stored resolution candidate URLs instead of duplicating it.
- The existing disabled Save to Library action stays disabled for now.

### Windows test checklist for Commit 1

1. Build with npm run build and npm run tauri dev.
2. Collect images via Find images and native right-click; ensure max 30
   items and no duplicates when selecting the same image twice.
3. Close Haven Walls entirely, restart, and verify the same Review entries
   and thumbnail links reappear, in their previous order.
4. Remove one Review image, restart, and confirm it remains removed.
5. Click Clear selection, restart and confirm the queue is empty.
6. Add from two browser tabs, switch to Gallery/Library and back, then
   restart. Review remains intact. Found results remain page-specific.
7. Inspect a Review image and choose Add to Review. Verify the same entry
   is updated instead of duplicated, including original URL candidates.
8. Confirm tabs, cookies, zoom, bookmarks, history and Gallery remain
   unchanged; Library must not receive files yet.

### Source validation

- Rust tests exercise successful serialize/deserialize, empty Review,
  30-image maximum, URL restrictions and duplicates.
- SQL schema was exercised against SQLite for repeat initialization,
  insert/upsert, clearing and singleton constraint.
- The repository Windows Build workflow is manual-only by design.
  This commit is NOT a verified Windows build until that workflow
  or the user's local compiler runs it.

## Commit 2: Reuse the existing Library importer (not yet implemented)

- Wire Browser's Save selected to Library to the existing shared
  LibraryImportDialog, with the normal rights/quality confirmation,
  optional Quick Save settings, duplicate checks and original resolution
  probing. Do not introduce another importer or bypass its safety rules.
- Surface per-image saved, duplicate and failed outcomes. Remove only
  successful saves and confirmed exact duplicates from the persisted
  Review queue. Failed/blocked items remain for retries.
- Refresh Library immediately after any successful import, with the
  existing preview/apply workflow untouched.

## PR merge acceptance

Only merge after: Windows Rust + TypeScript build passes; Review restoration
survives process restart and normal rebuild; Library import handles mixed
saved/duplicate/failed batches correctly; existing Gallery and Library
regression checks pass. Never merge automatically.

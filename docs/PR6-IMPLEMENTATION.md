# PR #6: Browser Review → Library

Branch: feature/pr6-persistent-browser-review
Base: main (after PR #5, merge commit b99f334)
Status: Draft. Do not merge until Windows build and functionality are approved.

## Commit 1: Persist the Browser Review selection (user-tested and approved)

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

## Commit 2: Reuse the existing Library importer (implemented; awaiting Windows testing)

- Wire Browser's Save selected to Library to the existing shared
  LibraryImportDialog, with the normal rights/quality confirmation,
  optional Quick Save settings, duplicate checks and original resolution
  probing. Do not introduce another importer or bypass its safety rules.
- Surface per-image saved, duplicate and failed outcomes. Remove only
  successful saves and confirmed exact duplicates from the persisted
  Review queue. Failed/blocked items remain for retries.
- Refresh Library immediately after any successful import, with the
  existing preview/apply workflow untouched.
- The shared LibraryImportDialog reports per-image results back to App after
  each batch, including auto Quick Save and retries. Browser imports remove
  only IDs with a successful save or a backend-confirmed exact duplicate.
  Failed imports remain in the persistent Review queue with their metadata.
- The native browser child is hidden while any global import/apply dialog is
  visible, so it cannot overlap or intercept dialog controls. React's Browser
  workspace remains mounted and restores the child after closing the dialog.
- Existing Gallery and Library callers continue using the same importer;
  their source images never trigger Browser Review removal.

### Windows test checklist for Commit 2

1. Run `npm run build`, then `npm run tauri dev` on the PR #6 branch.
2. Open Browser, add 2–3 images to Review, click **Save N images to
   Library**. The shared import dialog must appear ABOVE the webpage.
3. With Quick Save disabled, review rights and save. With Quick Save enabled,
   verify the existing preference continues to govern automatic saving.
4. Save a valid large image: the dialog reports saved, Library shows the
   image immediately, and the item disappears from Browser Review.
5. Add the same exact image back into Review and save it: it should report
   "Exact duplicate" and leave Review. Re-importing should not duplicate
   the Library entry.
6. Include a broken/unavailable source, a below-minimum image, or an image
   triggering similarity rejection in a mixed batch. Failed entries must
   remain in Review. Successful entries and exact duplicates must leave.
7. Close the modal, switch to Gallery / Library / Browser. Verify the
   website returns and Found/Review remains usable.
8. Restart Haven Walls. Review should contain only failures/pending entries,
   while previously imported wallpapers remain available in Library.
9. Test the importer from Gallery and from Library: neither source should
   remove pending Browser Review images.
10. Check manual original inspection, source metadata, image rights,
    resolution thresholds, duplicate checks, and per-image failure messages.

### Verification status

Source-level wiring and result-state review completed. The Windows build,
Rust native import, and WebView2 layering require local Windows testing.
Do NOT merge the draft PR before those checks succeed.

## Follow-up: Browser publisher-image handoff fix (awaiting Windows testing)

- Scanning a Google image result now preserves a publisher URL from its
  image link (such as `imgrefurl`) when exposed, rather than treating the
  Google results page as the image's original source.
- Native right-click selections likewise retain the publisher page exposed
  by a Google image result link.
- Find Images captures a bounded set of the selected element's other
  image candidates from srcset/data-original/data-full, revalidates them on
  the native side, and keeps them in the existing Review metadata queue.
- The shared importer checks direct candidates first, then eligible image
  links/standard metadata on the publisher page before spending its budget
  on speculative resized URLs. One bad URL cannot cancel all other links.
- No automatic Library writes, extra importer, change to quality/licensing
  rules, local file scraping, remote telemetry, or changes to protected
  wallpaper files.

### Retest

1. In Browser, use Google Images to find the same Vestrahorn stock-photo
   result. Select it using Find Images (and separately native right-click).
2. Inspect, Add to Review, Save to Library. Verify correct full-size photo is
   selected, or a truthful failure if that publisher blocks requests.
3. Test an image on a publisher website with standard og:image / direct
   download links; confirm it can import after initial thumbnail URL fails.
4. Verify an unavailable/forbidden image remains in Review and no unrelated
   publisher image is silently imported.
5. Confirm persistence after restart, exact duplicate handling, Quick Save
   and manual confirmation, Gallery and Library imports remain unchanged.
6. Run `npm run build`, `npm run tauri dev`, and native tests on Windows
   before approving PR #6. There has been no Windows build in this session.

## PR merge acceptance

Only merge after: Windows Rust + TypeScript build passes; Review restoration
survives process restart and normal rebuild; Library import handles mixed
saved/duplicate/failed batches correctly; existing Gallery and Library
regression checks pass. Never merge automatically.

## Follow-up commit: Highlight and protect current Library wallpaper

- Match Haven Walls' managed active-copy path to each monitor's actual
  `IDesktopWallpaper::GetWallpaper` path before adding the **Current wallpaper**
  badge and blue outline to Library cards. An external Windows wallpaper
  change must not leave a false current badge.
- Keep the existing "Last applied by Haven Walls" history panel. Its records
  remain even if Windows wallpaper has since changed.
- Active assignments are deletion-protected independently of what Windows
  currently displays, consistent with the native Library deletion safeguard.
  Disable Remove in the detail viewer and explain how to release the image by
  applying another wallpaper through Haven Walls.
- Refresh checks the OS current wallpaper state as well as Library items.
  Favorite remains an independent user choice. No changes to managed image
  bytes, background rotation or import behavior.

### Windows regression checks

1. Apply wallpaper A through Haven Walls. The A card shows a blue border
   and Current wallpaper label; Favorite count is unchanged.
2. Apply B through Haven Walls. A loses current status; B gains it. A can be
   removed unless another display still has it assigned.
3. On a multi-monitor setup, set separate wallpapers and verify each current
   wallpaper is marked.
4. Try Remove on an assigned Library image; the button is disabled with an
   explanation. Deleting a nonassigned image remains possible.
5. Change wallpaper from Windows Settings and click Library Refresh. The old
   image loses the Current badge; last-applied history still remains, and
   the protected assignment is not silently deleted.
6. Check build (`npm run build`, `npm run tauri dev`) and Rust Windows
   compilation. PR #6 remains draft until user testing approves it.

# PR #3: Wallpaper Library, Windows Integration and Settings

**Branch:** feature/wallpaper-library-settings
**Target:** main, after PR #2 merger
**Windows builds, tests and merges:** User only. Assistant pushes source commits.

## One PR, three combined commits

### Commit 1: Settings and persistent storage foundation (this commit)
- Replace the inactive Settings sidebar item with a functional Settings page.
- Rust-managed SQLite metadata with an explicit schema version.
- Save defaults for wallpaper fit, minimum resolution, 4K preference, credit/caption, image types, duplicate sensitivity, excluded terms and sources, and the 2 GB default cache limit.
- One-time migration of PR #2's caption/credit choices into SQLite.
- Separate app-owned directories: discovery cache, pending review, managed library, active wallpaper working copies and offline reserve.
- Actual storage root and per-class usage numbers in Settings.
- Safe manual **Clear temporary cache** removes only disposable discovery files.
- AppData or portable-folder mode: migration into a **new empty destination**, staging/copy verification, old data retained. Refuse to overwrite an existing destination.
- No telemetry or stored provider tokens.

**Not active yet:** downloads/imports, file decoding, duplicate detection, automatic cache eviction, Windows wallpaper setting, history recording and rotation. The Settings screen marks those choices as stored defaults for subsequent commits.

### Commit 2: Image importing, downloads, library and caching (pushed)

- New Library sidebar page with offline originals, saved thumbnails, Favorites, search and 4K/portrait filters.
- Import local JPG/PNG/WebP images up to 32 MB from Library or Google Browser Search; originals on your computer remain untouched.
- Add to Library in Gallery image inspection and Save selected to Library in Google Images' shared Review selection.
- Explicit image-rights confirmation, custom source/credit note, optional quality and similarity overrides.
- Bounded HTTPS-only Rust downloads with public DNS pinning, no proxies/redirects, 32 MB/22-second limits, actual image decoding and format/dimension verification. Some image hosts block direct downloads, so a user-downloaded local image is the supported fallback.
- SHA-256 exact duplicates, configurable perceptual dHash similarity detection, favorites and manually confirmed removal of managed copies.
- Settings quality, image type, and exclusion preferences now apply when importing into the Library.
- Managed library files and offline thumbnails are not disposable discovery cache. Cache cleanup leaves managed files and favorites untouched.
- **Later:** automatic discovery-cache eviction, Windows wallpaper apply, applied-image protection and history belong in Commit 3. The 2 GB cache preference is for disposable discovery previews, not the managed Library.

### Commit 3: Windows wallpaper application and final integration
- Apply approved wallpapers to Windows desktop using documented native APIs, default fit and supported monitor targets.
- Protected active working copies, Set Now from Library/review, history.
- Photo-credit/caption overlays only on prepared copies where source rights permit.
- Dashboard integration, error handling and settings polish.

**After PR #3:** rotation schedules, system tray, lock screen, watched folders and advanced automated behavior.

## Local validation for Commit 1 (USER ONLY)

In PowerShell in the Haven Walls repository:

~~~powershell
git switch feature/wallpaper-library-settings
git pull --ff-only origin feature/wallpaper-library-settings
npm ci
npm run tauri build -- --bundles nsis
Start-Process .\src-tauri\target\release\haven-walls.exe
~~~

The new rusqlite dependency bundles SQLite. Cargo may update src-tauri/Cargo.lock on the user's Windows machine. Review changes and commit only that updated lockfile to the existing feature branch. Do not ignore lockfiles or commit provider credentials.

1. Click **Settings** in the left sidebar. Confirm the page is functional, with the existing custom title bar/sidebar unchanged and the right pane scrolling.
2. Edit fit, minimum resolution, prefer 4K, credits, captions, allowed image types, duplicate sensitivity, cache limit and excluded keywords/sources. Click **Save settings**. Navigate away/back and relaunch: saved values should persist.
3. Remove all allowed image types and save. The Rust backend must reject it. Try an invalid cache limit; the backend must reject it too. Discard should restore saved values.
4. Verify the initial AppData Local root and its subfolders: data/library, data/cache/discovery, data/cache/pending, data/active, data/reserve and data/haven-walls.sqlite3.
5. **Clear temporary cache** should be safe and report empty when no image files are present. It must not delete managed, active, reserve or pending files.
6. Optional portable test: choose **Portable folder beside EXE**, save other edits first, click **Move storage**, confirm and inspect the new HavenWallsData folder beside the EXE. Original AppData data is retained for recovery.
7. A migration into a destination that already contains data is intentionally rejected. Do not delete or overwrite either location manually just to satisfy this test.
8. Check Sources: the old separate caption/credit switches are replaced by a link to Settings. Verify Bing, Earth View, TheSportsDB, TMDB and Google Images discovery are unaffected.
9. There should be no automatic image download, Windows wallpaper change or background rotation from opening/saving Settings.

## Important safety/ownership rules

- SQLite owns settings and metadata; wallpaper bytes live separately in the app-owned folders.
- Disposable cache is separate from managed images, active images and offline reserve.
- The user’s local original files are never changed by routine cleanup.
- A settings value being stored does not mean an unfinished feature has been activated.
- The application has no telemetry and no cloud account requirement.
- The user handles all builds, testing and merging. Feedback after each combined commit stays in this PR.


## Commit 2: Local Windows acceptance checks (USER ONLY)

~~~powershell
git switch feature/wallpaper-library-settings
git pull --ff-only origin feature/wallpaper-library-settings
npm ci
npm run tauri build -- --bundles nsis
Start-Process .\src-tauri\target\release\haven-walls.exe
~~~

**Cargo.lock:** This commit adds new Rust image, hashing and base64 dependencies. The first local Cargo build may update src-tauri/Cargo.lock. Review its changes and commit the updated lockfile only on this feature branch. Never merge without successful user-owned Windows testing.

1. **Library:** New sidebar entry and initially empty Library with Discover Wallpapers and Import local images controls.
2. **Local import:** Select one or several JPEG/PNG/WebP photos in Library. Confirm you reviewed their source permissions, then Save to Library. Open the Library and confirm thumbnail, title, true dimensions, source and file size.
3. **Persistence:** Relaunch Haven Walls. Verify saved images, Favorites and original previews are still accessible without network access.
4. **Online source:** In Gallery → Bing Daily or Google Earth View, inspect a photo and select Add to Library. Confirm rights. Original image downloads only work if the host permits it. If blocked, use an authorized downloaded local file.
5. **Google Images:** Browser Search → add photos to Review selection and use Save selected to Library. Repeat with API Search. Confirm individual success/errors for a batch and duplicate prevention.
6. **Quality:** In Settings set 4K minimum, then attempt to save a smaller image. It must reject it unless you explicitly allow smaller images in the import dialog. Disable an image format to ensure it is rejected too.
7. **Duplicates:** Reimport the same file twice. It must not create two Library items. With similar photos, review the similarity warning and optional manual override.
8. **Favorites:** Mark an image favorite, filter favorites, search by title/credit/provider, restart and confirm the favorite persists.
9. **Deletion:** Open a saved image and select Remove from Library. Cancel first; nothing should change. Confirm to remove only the managed file and thumbnail. Your original file in Downloads or Pictures must remain intact.
10. **Cache:** In Settings verify managed library usage grows after imports, while Clear temporary cache does not touch Library or Favorites.
11. **Boundary:** The Library's Set as wallpaper action remains disabled. Actual Windows desktop application, monitors, credits/captions and history are part of Commit 3.

**Limitations:** The Library currently loads up to 500 items without pagination; provider image hotlink restrictions and licensing may prevent downloading; automatic original-image licensing checks do not exist. Pixel dimensions do not prove a photograph is sharp or free of upscaling. No background downloads, telemetry or wallpaper rotation are enabled.


## Commit 2 follow-up: saved source links, preview layout, Quick Save

### User-facing changes
- **Library preview:** The full-size saved image remains contained within the dialog. The source information scrolls in its own middle region, and the favorite/remove/Set as wallpaper buttons remain visible in a separate bottom footer. Test landscape and tall portrait photos on a maximized window and a smaller window.
- **Open source page** opens the original page URL in the system's default browser. **Open original image** opens the original *online* image URL. These buttons are disabled and explain why when a saved Library record has no URL, especially for a local import. Opening the saved full-quality Library copy still works offline.
- Source opening is a validated host-level command. It only accepts HTTPS URLs and uses the Tauri opener Rust plugin, not target=_blank navigation inside WebView2. Any failure should be displayed inside the Library preview.
- **Settings → Library & importing → Quick Save to Library** is **enabled by default**. It is persisted in SQLite, including for users with an existing DB thanks to serde defaults. Clicking Add to Library opens a brief progress dialog and begins the user-requested import without a second confirmation click.
- Turn Quick Save **off** to restore the old per-image rights confirmation and manual metadata controls.
- If a Quick Save import fails because of minimum resolution or similarity policy, choose **Adjust quality or duplicate options and retry** inside the result dialog. Exact-duplicate and image validation rules continue to apply.
- Quick Save does **not** represent a verified license or authorization. The Rust backend checks the saved preference and records that no per-image rights attestation was made. Attribution and source restrictions still apply.

### Acceptance checks (user runs local build)
1. Open an existing saved landscape image in Library; the full image and source metadata must be visible, with action buttons along the bottom. Resize the app smaller and verify the source details can scroll without cutting off the actions. Repeat with a portrait image.
2. For an online image saved with URLs, click **Open source page** and **Open original image** separately. They must open in your normal default browser. If source links are missing, buttons are disabled and an explanation is visible.
3. Check Settings → Library & importing. **Quick Save to Library** should be checked by default. Click Add to Library on a new image, and verify the import begins on its own, with a result and **Open Library** button. Restart the app to confirm the preference persists.
4. Turn Quick Save off and save. Try another import; the original rights confirmation checkbox and optional metadata/quality controls should return.
5. With Quick Save on, try importing a low-resolution or similar image. The normal validation must still reject it. Use the retry options to deliberately override only a minimum-resolution or similarity warning.
6. Make sure the offline managed Library image still opens after disconnecting the internet. Opening an *online* source naturally requires network access.

This follow-up adds the Rust Tauri opener plugin. A local Cargo build may update src-tauri/Cargo.lock; review and commit the expected lockfile changes to the same PR #3 branch. Do not run CI or merge without local validation.


## Commit 3: Windows desktop wallpaper application and finish

This commit adds manual Windows wallpaper application and current application history. The app **does not** automatically discover, rotate or change wallpapers without an explicit user action.

### Implementation

- Library thumbnails/cards and saved-image inspection show **Set Now / Set as Windows wallpaper** actions.
- After a successful Gallery import, the results dialog also offers **Set Now** without requiring a separate trip to the Library.
- The native Rust host uses Windows IDesktopWallpaper (Windows 10 and Windows 11) and retrieves actual attached monitor IDs and screen dimensions. Choose all displays or an individual attached display.
- Supported Windows positioning: Smart Fit (choose Fill or Fit by aspect), Fill, Fit, Center, Stretch, and Span. Span is for **all displays only**. Windows exposes positioning as a shared desktop setting, so changing fit may also affect other monitors' presentation.
- The original saved image remains unchanged. Each apply creates a JPEG working copy in app-owned active storage, and records an active assignment protected against Library deletion/temporary cache clearing. Old working copies are deleted only after a successful replacement and database history update.
- Caption/photo-credit overlays are prepared on the saved image in the local webview and saved into the working copy. The user can toggle them per apply; saved defaults live in Settings. The image is not upscaled; overlays on very large originals may be prepared at up to 4K canvas size for bounded memory.
- Source/photographer credits are shown if known. Unverified creator names are not invented. Source metadata remains in SQLite independently of whether an overlay is visible.
- Application events are stored in SQLite. Library shows recent history and a label saying **Last applied by Haven Walls**. External changes made via Windows Settings are not yet detected/reconciled; configurable external-change behavior belongs to a later automation milestone.
- No new Rust crates are introduced: the Windows bindings are already in Cargo.lock. This commit adds Windows API feature flags in Cargo.toml; your most recent user-pushed Cargo.lock commit is preserved. Future PR commits that change Rust dependency resolution must include Cargo.lock in the same commit.

### User-owned Windows verification

1. Pull the PR #3 branch, build and install it locally using the established commands above. Before testing, note your current Windows desktop wallpaper so you can restore it if desired.
2. Open **Library**, choose a saved photo and click **Set Now** or **Set as Windows wallpaper**. In the new dialog, select **All displays**, **Fill**, and Apply. The actual Windows desktop background should change. The Library original image must be unchanged.
3. Try Fit and Center with an image whose aspect ratio differs from the display. Look for expected letterboxing/cropping. Try Smart Fit. Try Span only with All displays.
4. If you have more than one attached monitor, select a specific display and apply. Verify the chosen display receives the new wallpaper and that monitor IDs survive reopening the apply dialog. Windows positioning is global, not independently configurable per monitor.
5. Switch on **Show caption** and **Show photo credit**. Apply, view the actual desktop and check the lower-right text. Disable both and reapply, confirming the text disappears from the newly generated working copy. The saved Library image should stay unchanged.
6. Visit Settings → Storage & Cache. Active copies should now consume some space. Clear temporary cache and verify the desktop wallpaper and managed Library files are unaffected.
7. In Library, try removing a wallpaper that is currently assigned to Windows. The app should prevent deleting its managed copy until you apply another wallpaper.
8. Apply another image, then check **Last applied by Haven Walls** and **Recent wallpaper history**. Quit/reopen the app: history should still be present. Windows may keep an image as the current wallpaper even while Haven Walls is closed.
9. From **Gallery → Add to Library**, use **Set Now** in the import results; verify the manual apply dialog opens after the image has been safely saved.
10. Check that Google Images, Bing Daily, Google Earth View, sports, TMDB, Library favorites, Quick Save, and Settings still work. No external browser/window should appear without an action.
11. If Windows itself changes the wallpaper outside Haven Walls, the Library label intentionally says **Last applied by Haven Walls**, not that it has rechecked the actual current desktop image.

### Boundaries and recovery

- No scheduled rotation, background discovery, automatic downloading, notifications, lock-screen updates or startup tray behavior in PR #3. Those are future work.
- Caption rendering uses a generated active copy; it does not license or modify the source image. Review applicable copyright/attribution requirements.
- For any Windows API error, check the message shown in the apply dialog and your current monitor configuration. Use Windows Settings → Personalization → Background to restore a previous wallpaper.
- The assistant does not build, test, trigger GitHub Actions or merge. The user owns Windows validation. Leave PR #3 as a draft until tested.

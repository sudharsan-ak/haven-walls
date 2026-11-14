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

### Commit 2: Image importing, downloads, library and cache
- Connect Gallery/review selection to user-approved imports.
- Local-file/URL import, bounded downloads with permission/rights review and actual decoded image checks.
- Protected managed library, favorites and exact-duplicate detection.
- Library UI with previews, search/metadata, delete and source links.
- Cache-size limits and safe cleanup that never removes active/managed files.

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

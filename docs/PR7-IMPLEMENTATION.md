# PR #7: Automatic Wallpaper Rotation + Discovery

Branch: `feature/pr7-automatic-wallpaper-rotation`
Base: `main` after PR #6 (merge `0b0b802`).
Status: Draft. Do not merge without local Windows testing and explicit approval.

## Four-commit plan

1. **Local rotation foundation**: persistent settings, Rust scheduler, eligible saved Library selection, 30-day no-repeat default, pause/resume, pin/unpin and Next.
2. **Automatic discovery and offline reserve**: permitted sources, background replenishment, protected offline storage, duplicate checks. Verify Bing and Unsplash integration policies before unattended downloads.
3. **Tray and scheduling UI**: keep process running with window hidden, startup preference, tray actions, full rotation settings and Dashboard status.
4. **Reliability and regression**: startup/wake coalescing, source/network errors, clock changes, manual/external overrides, full Windows tests.

## Commit 1: Library rotation foundation

- Adds `src-tauri/src/rotation.rs`, storing a single rotation snapshot in
  an additive `rotation_settings` SQLite table, protected by existing
  `StorageLock` and a separate rotation-operation gate.
- Defaults: **disabled**, every 24 hours, 30-day no-repeat cooldown,
  Favorites-only disabled, unpaused and unpinned.
- Supports 1/6/12/24-hour presets and custom 15-minute to 7-day intervals,
  and a configurable 1–365 day no-repeat period.
- The Rust worker checks for one due action every 15 seconds *while the
  application process runs*. No tray or autostart yet.
- Selects managed Library originals only: landscape images at or above
  the saved minimum quality threshold. Avoids active assignments and
  recent repeats; if the pool is small, prefers least-recently-used.
- Reuses the existing `windows_wallpaper::apply_sync` pipeline, so
  conversion, Windows COM, saved originals, active file protection and
  history continue to work the same way. It does not directly download
  or write wallpaper files on its own.
- A successful manual Set Now resets the rotation interval, while a failed
  automatic attempt leaves the previous wallpaper unchanged and schedules
  a bounded retry. Disable, Pause and Pin do not silently apply wallpapers.
- Adds functional but intentionally compact controls on the Library page.
  The full Schedule/Dashboard controls are part of Commit 3.
- Emits a local event when rotation applies a wallpaper so the Library
  current-wallpaper badge refreshes without page navigation.
- No automatic discovery yet. An empty/ineligible Library keeps the existing
  desktop wallpaper until an eligible image is added or Commit 2 is built.
- Includes Rust unit tests for defaults, validation, candidate selection,
  cooldown fallback and SQLite roundtrip.

### Windows test checklist after Commit 1

1. Run `git pull --ff-only origin feature/pr7-automatic-wallpaper-rotation`
   followed by `npm run build` and `npm run tauri dev`.
2. Open Library. Rotation starts Off. Enable it and confirm the next due
   time appears. Restart the app; preferences must persist unchanged.
3. With at least two 1080p+ landscape images saved, press Next. The
   Windows wallpaper and Library's blue Current label should change.
4. Press Next again; the selection should avoid the already applied image
   and choose another eligible image when possible.
5. Mark one eligible image Favorite and enable Favorites only. Only that
   image should be eligible; the app should not quietly apply a nonfavorite.
6. Toggle Pause, Resume, Pin and Unpin. Automatic changes must not occur
   while paused or pinned; unpin/resume should preserve a sensible schedule.
7. Set a short custom interval (minimum 15 minutes) for one due cycle.
   Verify it changes the wallpaper with the app open. Sleep/wake only
   triggers a single overdue change.
8. With an empty Library or no eligible images, the current Windows
   wallpaper remains unchanged and a clear status is shown after a due check.
9. Change a wallpaper manually through Set Now. The next due time resets.
10. Verify Gallery, Browser Review, Library imports and manual Set Now
    still work. Manual user choices must not be overwritten by an immediate
    stale scheduled job.

### Explicitly deferred

Automatic network discovery (including Bing/Unsplash), reserved image
caching, background tray lifetime after window close, startup/clock-time
scheduling, category weighting, per-monitor automatic schedules and
advanced history UI are **not** implemented by Commit 1.

Build and execution are not yet verified in this environment because the
Windows Rust/Tauri toolchain is unavailable here. Keep the PR in draft.

## Commit 1 follow-up: Immediate Library badge during rotation

- Windows rotation and saved preferences worked in user testing, but the
  **Current wallpaper** badge updated only after leaving and re-entering Library.
- The Rust worker already emits `rotation:applied` with the successful native
  `ApplyResult`. Library previously handled that event by refreshing from the OS,
  which could overwrite the immediate success state with a stale wallpaper path.
- Library now applies the confirmed success event directly using the same
  `afterApply` handler as manual Set Now and Next. A ref keeps the handler
  current without repeated event listener registration.
- Refresh remains available for external Windows wallpaper changes; failed
  wallpaper operations do not emit successful updates.

### Retest

1. Stay in Library, click Next wallpaper. The new Current wallpaper badge
   should move immediately, without changing tabs.
2. Keep Library open until an automatic timed rotation occurs. The badge
   should move immediately again.
3. Re-enter Library or click Refresh to confirm Windows agrees with the
   displayed current wallpaper.
4. Verify app restart still preserves rotation preferences.
5. Rebuild with `npm run build` and `npm run tauri dev` on Windows.

## Import regression fix during Commit 1 testing

Native image requests previously advertised AVIF and APNG despite having
only JPEG/PNG/WebP decoders enabled. This could cause Pexels and other CDNs
to deliver unsupported bytes even though WebView2 displayed a preview.
Requests now advertise only the supported image codecs.

When native Inspect successfully verifies an original, it retains those
exact bytes for up to 20 minutes in a bounded, process-local cache (maximum
six images and 96 MB). Saving a matching URL and publisher page reuses the
verified original, then runs the same Library import rules, rights checks,
quality checks and deduplication. No original bytes are persisted in Review.

Find Images also preserves same-site photo detail links as publisher source
pages on supported photo-grid URL patterns such as Pexels /photo/.

### Test
1. Visit Pexels, use Find Images, Inspect a selected image until it explicitly
   says "Verified downloaded source". Add it to Review, then Save to Library.
   It should save without a second request when in the cache.
2. Without inspecting first, select a new Pexels image and Save. The supported
   Accept header should avoid requesting AVIF from content-negotiating servers.
3. Restart the app. Review metadata persists, inspected original bytes do not.
4. Verify blocked/unsupported/low-resolution images still fail honestly and
   no incorrect photo is imported.
5. Run the Windows Tauri build before treating this follow-up as verified.

## Commit 2: Automatic discovery and protected offline reserve

- **Default source:** Wikimedia Commons, limited to individual images whose
  machine-readable metadata explicitly reports public-domain / CC0 and no
  copyright claim. Unknown rights, attribution-licensed, and provider-restricted
  images are not automatically downloaded.
- Reuse existing quality thresholds, image format checks, blocked keywords,
  blocked sources, exact SHA-256 checks and perceptual similarity screening.
- Successful downloads are stored as owned, hash-named original files under
  `reserve/`, with `storage_class='reserve'` metadata. They are not added to
  the permanent Library grid. The ten-file reserve is excluded from normal
  discovery cache cleanup and protected from deletion.
- The existing Windows apply function accepts a verified reserve image as
  well as a managed Library original. It still generates a protected active
  copy and records the apply event/history. No second Windows apply route.
- Rotation tries eligible Library images first, then reserve images. An
  empty Library can discover, cache and apply an approved image automatically
  while the Haven Walls process is running.
- Replenishment is separate from the wallpaper-change interval: one approved
  file per attempt, initially every ~60 seconds, with a 15-minute backoff on
  provider failure. Offline network failures never clear the desktop wallpaper.
- The Library rotation panel exposes automatic discovery On/Off, a limited
  Nature/Space/Cities topic choice, reserve count and discovery errors.
  The main rotation switch is **off by default**. Disabled rotation never
  initiates network discovery.
- Bing Daily and Unsplash remain manual discovery providers for now.
  Their feeds or licenses do not automatically authorize unattended
  third-party wallpaper-app distribution/usage; enable only if a compliant
  integration is established.
- Removed the unused `base64::Engine` import and obsolete browser image
  menu event constant that generated harmless Rust warnings.

### Windows regression checklist for Commit 2

1. Update PR #7 branch, run `npm run build` and `npm run tauri dev`.
2. In Library, enable rotation and automatic discovery. Confirm reserve
   count begins replenishing from 0 toward 10, without adding entries to
   the permanent Library. The existing wallpapers/favorites remain intact.
3. With **no managed Library wallpapers**, use Next wallpaper. It should
   discover an eligible public-domain/CC0 image, apply it, and preserve the
   protected reserve original (provided Commons is reachable).
4. With a managed Library item and a reserve image, verify rotation selects
   Library first; it can use reserve when no different managed image is
   eligible.
5. Enable Favorites only: reserve images must not be used automatically.
6. Disable automatic discovery: no new source network calls while still
   permitting rotation from already saved Library and reserve images.
7. Disconnect internet: available reserve images still rotate; if the pool
   is empty or has no alternate item, retain the Windows desktop and show
   a noncritical failure.
8. Confirm managed Library imports, exact duplicates, browser preview/Review
   saving, Windows apply, and blue current wallpaper badge still work.
9. Try 4K minimum or blocked source/keyword. Discovery must not bypass
   settings or save unknown-license material.
10. Restart: reserved originals, source records and next-discovery state
    must persist, but ongoing network requests must stop when the app exits.

### Remaining in PR #7

Commit 3 adds the keep-running system tray and full scheduling UI.
Commit 4 handles stronger sleep/wake, external changes, retry diagnostics
and end-to-end Windows regression checks. No direct changes to `main`.

## Commit 2 follow-up: Multi-topic automatic discovery

- Replaces the single Nature/Space/Cities dropdown with a checkbox-based
  multi-select of eight topics: Nature, Space, Cities, Mountains, Oceans,
  Wildlife, Architecture and Abstract. The **Select all** action enables
  every topic, and new installations default to all eight.
- At least one topic must stay selected. Rust validates the full list, rejects
  duplicates and unknown values and uses only fixed, approved Commons
  queries. This does not authorize new image providers or arbitrary search.
- Existing installations with a saved `discoveryTopic` retain their former
  single selection when reading settings; saving migrates the field to
  `discoveryTopics` without losing other scheduling preferences.
- Discovery uses one bounded request per turn, visiting page 0 of each
  selected topic before page 1, and repeating after page 19. Topic changes
  reset that cursor and make the next discovery eligible to run immediately.
- Adds persisted last-discovery status: source topic, local timestamp,
  whether a verified wallpaper was saved, no eligible image was found, or
  the source failed. This makes a reserve stuck at 1/10 diagnosable without
  treating a zero-result search as a network error.
- The protected offline reserve target remains 10 and all existing
  license, resolution, source/keyword exclusion, deduplication and network
  safeguards stay in place.

### Windows validation for multi-topic discovery

1. Update the existing PR #7 branch and build with `npm run build` and
   `npm run tauri dev`. Open Library > Automatic wallpaper rotation.
2. Open Auto-discovery topics. Select several, deselect one, select all.
   An attempt to deselect the last remaining topic must be disabled.
3. Restart the app; selected topics and rotation interval must persist.
   Existing users with one previously selected topic should keep it.
4. With discovery enabled and reserve below ten, watch Last discovery
   show the topic, outcome and timestamp. Topics should rotate across
   attempts instead of always showing Nature.
5. If Commons finds no eligible media, the outcome should say no eligible
   image rather than incorrectly claiming a download succeeded.
6. With reserve full, Verify automatic requests stop. Turning rotation
   or discovery off must also stop new background discovery attempts.
7. Library and current-wallpaper highlighting remain unchanged; verify
   automatic Next wallpaper and Browse > Review > Save still work.


## Commit 3: Background operation and Schedule UI

### Native background lifetime
- Tauri 2 system tray (the existing application icon, no new UI process).
  Menu: Open Haven Walls, Next wallpaper, Pause/Resume, Pin/Unpin and
  Quit Haven Walls. The left mouse button restores and focuses the window.
- Closing the main window **while rotation is enabled** hides it into the
  tray when the user's "Keep running in system tray" preference is enabled.
  The Rust process, scheduler and protected reserve keep running. Choosing
  Quit exits the app completely. If rotation is disabled or the preference
  is turned off, Close exits the application normally.
- The background option is stored locally in SQLite and defaults to on,
  but does not run anything by itself: the main rotation switch still
  defaults to off.
- Windows login startup is a **separate opt-in**. A per-user Run entry
  under HKCU is created only after the user checks the control from the
  installed release executable. It starts that specific executable with
  `--background` and keeps the main window hidden. Disabling it removes
  the entry. No admin privileges, system-wide writes or external services.
- The startup control is disabled in `npm run tauri dev`, so a temporary
  development executable is never accidentally registered for login.
- Close-to-tray controls and startup status do not touch automatic image
  discovery permissions or turn rotation on without the user requesting it.

### Scheduling and interface
- Rotation now supports two mutually exclusive schedule types:
  customizable interval, or once daily at a selected **local Windows
  HH:MM** time. The scheduler calculates the next future occurrence and
  uses local timezone rules for DST transitions.
- Manual Set Now / Next resets the next scheduled time without immediately
  causing a second automatic rotation.
- New "Schedule" sidebar destination reuses the existing rotation controls
  and adds background/startup options, status and reserve summary.
- Dashboard adds a compact rotation-status card linking to Schedule.
  The Library retains its current wallpaper indicator and quick controls.
- Existing stored rotation settings migrate automatically to interval mode
  without changing the user's interval, topics or discovery options.

### Windows regression checklist

1. Update the PR #7 branch, then run `npm run build` and
   `npm run tauri dev`.
2. Open Schedule. Confirm Rotation Off by default for new installs, and
   previously enabled intervals/topics still persist.
3. Enable rotation, check Keep running in system tray, then press the title
   bar X. The window hides, the Haven Walls tray icon remains, and no second
   scheduler is created. Left-click the icon to restore the window.
4. Tray: try Next wallpaper, Pause/Resume, Pin/Unpin and Quit. The current
   desktop and Library status should remain consistent with each action.
5. With rotation disabled, closing the app should exit normally even when
   Keep running in system tray is checked.
6. Switch to Daily at a local time just ahead of the current clock.
   Confirm Next change updates, a due change occurs once, and the next due
   advances to tomorrow. Test toggling Pause and Pin.
7. Switch back to Interval. The previous interval and no-repeat period
   should remain intact, and the next due should be recomputed.
8. Confirm the Dashboard status and the Schedule page report the same
   rotation state, next due, eligible count, and reserve count.
9. Install a release executable (`npm run tauri build`). Toggle
   "Start at Windows login" on and off. When enabled, sign out/in and
   verify Haven Walls starts hidden with a working tray icon, without
   showing an unexpected window.
10. Confirm Browser, Library, Quick Save and manual Set Now still work;
    no wallpaper files are deleted by hiding, showing or quitting.

### Known limits before Commit 4
- Commit 4 will validate duplicate process prevention on repeated launches,
  recovery after sleep/wake and Windows startup, and missed schedules, along
  with full Windows regression. Do not merge PR #7 before these tests.
- This authoring environment does not have the Windows Rust toolchain.
  The native build and tray behavior must be validated locally by the user.


## Commit 4: Reliability, single instance, discovery backoff and final polish

### Native process and rotation reliability
- A named Windows session-scoped mutex is acquired **before** Tauri
  creates any windows or starts its Rust rotation worker. If the same
  Windows user starts Haven Walls again, the second instance signals the
  existing window to reopen and exits. A duplicate background login
  launch exits quietly without interrupting the open application.
- The mutex and activation event are held only by the running process
  and disappear when it quits. No administrator privileges, file locks,
  external services or telemetry are involved.
- The native rotation worker checks the persisted absolute next-due
  timestamp every 15 seconds, including after Windows wakes. An overdue
  interval triggers at most one change; a successful apply computes the
  next future rotation rather than replaying every missed interval.
- A future daily local-time deadline is recalculated after a time-zone
  or clock adjustment. **Overdue** daily deadlines are not silently moved
  to tomorrow; they can run once on resumption. Daily retry deadlines are
  preserved rather than overwritten by a timezone reconciliation.
- Paused/pinned/off states still prohibit scheduled changes, and
  user-triggered Next retains its existing semantics.

### Wikimedia Commons / HTTP 429 improvements
- Parse the provider's `Retry-After` header in seconds or HTTP-date form
  on HTTP 429/503, with a bounded upper limit of 48 hours.
- Automatically cap source requests by spacing successful replenishment
  at least 30 minutes apart and empty searches at least 60 minutes apart.
  Consecutive failures use persisted exponential backoff up to 24 hours.
  A provider-specified Retry-After is a **minimum**, not ignored.
- The same backoff is used after restarting the app. Manual Next with
  an empty pool may attempt discovery **only if its deadline permits it**,
  so it cannot repeatedly evade a Commons 429 limit.
- If an image CDN signals HTTP 429, stop the remaining requests in that
  discovery attempt instead of requesting two more files immediately.
- Rate limits never erase stored reserve images or stop existing offline
  Library/reserve rotation. The Library UI presents 429 as a temporary
  provider cooldown rather than implying Haven Walls crashed.

### UI polish
- Replaces the obsolete Dashboard `Milestone 2 · PR #3` copy with a
  neutral Haven Walls label. No other navigation or Library changes.

### Windows final regression checklist

1. Pull the PR #7 branch, run `npm run build`, `npm run tauri dev`
   and `npm run tauri build`. Confirm there are no Rust compile errors.
2. **Single instance:** Leave Haven Walls in the tray, start its executable
   again and verify that the existing window opens and only one Haven Walls
   process/tray icon remains. Do the same with the window already visible.
3. **Background login:** With installed release startup enabled, sign in
   and confirm it appears hidden in the system tray. Starting the EXE
   again should open that instance, not start a second scheduler.
4. **Background operation:** Enable rotation and close the window;
   rotation remains active in tray. Tray Next, Pause/Resume, Pin/Unpin
   and Quit still work. Quit fully stops discovery and rotation.
5. **Sleep/wake:** Configure a short rotation interval, let the PC sleep
   past its deadline, and resume. Confirm a *single* overdue apply, never
   one apply per missed interval. Verify the next due time is in the future.
6. **Daily schedule:** Confirm a daily local time changes wallpaper once,
   then advances the deadline to the next applicable local day. Test
   pause, pin, manually applying a wallpaper and switching back to interval.
7. **Discovery backoff:** With Commons returning HTTP 429, verify the
   next discovery time is well in the future, remains persisted after
   app restart, and manual Next cannot force another source request
   before that deadline. Existing saved images should still rotate.
8. **Normal replenishment:** If Commons accepts requests, a saved
   reserve image should be followed by a 30-minute cooldown. A
   no-result search should be followed by a 60-minute cooldown.
9. **Library/Browser regressions:** Review → Library, Inspect original
   reuse, Favorites-only, active wallpaper highlighting and protection,
   exact duplicate handling and Set Now all still work.
10. **External Windows wallpaper changes:** Library Refresh must reflect
    the actual Windows current status. Configurable external-change
    policy and independent per-monitor schedules are separate future
    features; do not claim those are implemented in this PR.

### Final acceptance
This commit is a **source checkpoint**, not a claim of a completed Windows
release. The authoring environment has no Windows Rust toolchain; local build,
sleep/wake, tray, login startup, and HTTP 429 runtime behavior require user
verification. Do not merge PR #7 without explicit user approval.


## Commit 5: Approved Dashboard and Settings UI revamp

Reference: Haven-Walls-Dashboard-and-Settings-Revamp-Interactive.html
(the user-approved interactive prototype in the Haven Walls project).

- Replace the oversized Dashboard welcome hero and repeated Get Started
  cards with the approved current-wallpaper preview, compact rotation
  summary and Browse/Library/Sources quick actions.
- Preview is the actual **Windows-confirmed** protected working wallpaper,
  not an online sample, a potentially expired discovery thumbnail, or a
  guessed Library image. The read-only native command confirms Windows is
  still using Haven Walls' recorded working file before it decodes a
  bounded JPEG thumbnail. Images originally sourced from the approved
  offline reserve are supported as well as permanently saved wallpapers.
- An external Windows wallpaper override displays a truthful empty
  state. Current Windows wallpaper files from unrelated applications
  are never read through arbitrary filesystem paths.
- Multi-monitor active assignments can be selected independently from
  a display picker. Metadata shows the source, original resolution,
  applied time and working-copy format. Expand displays a larger preview.
- Dashboard Next uses the existing Rust rotation command. View in Library
  opens the actual saved wallpaper's details, when the photo has a
  permanent managed Library entry. For reserve-only images, View in
  Library is disabled and explains why; Change Wallpaper opens Library.
- Add five Settings tabs based on the approved prototype:
  Wallpaper & Display, Automation, Library & Quality, Sources,
  and Storage & Privacy. Existing storage migration, API credentials,
  duplicate/quality checks, source exclusions and privacy controls
  are preserved.
- Move the existing native-backed rotation, discovery and system tray
  controls under Settings > Automation. Keep their persisted SQLite
  values and original commands unchanged, with an immediate status
  summary after actions.
- Remove the separate Schedule sidebar destination and the large
  duplicate rotation controls from Library. Dashboard's Manage Rotation
  opens Settings > Automation directly; Library remains for saved
  wallpapers, Inspect, Favorites and Set Now.
- Keep the current wallpaper label and activity data in Library.

### Commit 5 Windows regression checklist

1. Fetch PR #7 and run npm run build, npm run tauri dev. There must be
   no TypeScript, JSX or Rust errors.
2. Dashboard: with a managed Library wallpaper applied, verify the
   **actual** Windows image is shown, including correct title, source,
   original resolution, last applied time and display label.
3. Apply an eligible wallpaper sourced from the protected offline
   reserve using automatic Next. Dashboard must preview that active
   working copy too, while the reserve does not appear as permanent
   Library entries.
4. Change the desktop wallpaper outside Haven Walls through Windows
   Settings. Dashboard should not claim the old Haven Walls wallpaper
   is current; Library's verified indicator must agree.
5. Next Wallpaper on Dashboard should change the Windows wallpaper and
   refresh both its active photo preview and the Library indicator.
   If rotation is pinned or no eligible alternative exists, show
   the real failure rather than a fake success.
6. Dashboard View in Library opens the saved image's detail viewer;
   Change Wallpaper and all three quick shortcuts navigate correctly.
   Reserve-only wallpapers explain why View in Library is unavailable.
7. Settings tabs: test all five tabs; change one normal AppSettings
   preference, save, restart and verify it persisted. Repeat for
   Automation and verify the rotation schedule is unchanged.
8. Existing Quick Save, allowed image types, resolution, similar
   duplicates, source exclusion, credentials, storage migration
   confirmation and cache clear confirmation still render correctly
   and invoke the same existing commands.
9. Sidebar no longer has Schedule and Library no longer has a second
   rotation panel. Dashboard Manage Rotation should select Settings >
   Automation, while manually clicking Settings continues to work.
10. Tray Next/Pause/Pin, close-to-tray and startup controls still operate
    after the UI move. Check multiple monitors if available.
11. Resize the window to a relatively narrow desktop width. Dashboard
    wallpaper, Settings tabs and controls should remain usable without
    content clipping or horizontal overflow.

No auto-generated or sample wallpaper should ship in the real Dashboard.
As with earlier PR #7 source checkpoints, local Windows Rust compilation
and actual desktop runtime tests must pass before merging the draft PR.

## Commit 5 follow-up: Cache the current Dashboard wallpaper across tabs

Problem reported during local Windows testing: after Dashboard successfully
loads the current wallpaper, switching to another sidebar destination and
returning causes the full native preview to download/decode again and flashes
"Loading current desktop wallpaper...", even when Windows hasn't changed it.

- Added a bounded **process-only** memory cache holding a maximum of four
  Windows-confirmed preview JPEG data URLs, keyed by monitor/target ID,
  wallpaper ID and applied timestamp. No disk persistence and no new
  background network requests.
- Dashboard initializes its image and last verified assignment from the
  cache when remounted, displaying it on the very first paint without a
  loading placeholder. Native preview retrieval is skipped on a cache hit.
- On every return to Dashboard, Windows activity is still verified
  asynchronously. During that check, the status says "Checking Windows"
  instead of falsely claiming a new OS confirmation. If Windows has changed
  the wallpaper externally, the stale cached entry is removed and the UI
  reflects the verified new/unknown state. If verification fails, cached
  imagery remains but the confirmation label clearly says unavailable.
- Successful manual Library Set Now, Dashboard Next, and rotation Next
  invalidate stale previews; the app-level rotation event listener also
  invalidates the cache during scheduled/tray changes while Dashboard is
  not mounted. Native preview successes warm the cache again.
- Previously selected monitor is remembered during the app session so
  navigating away and back restores the right monitor's own cached image.
  Rendering strictly compares target, wallpaper ID and timestamp to avoid
  briefly showing another display's or an outdated image.
- A restart naturally clears this cache because it lives only in memory.
  The existing Windows/SQLite wallpaper application and background scheduler
  paths are unchanged.

### Windows tests

1. Load Dashboard once and confirm the real wallpaper appears.
2. Navigate Dashboard > Library > Settings > Dashboard repeatedly. On
   return the photo should be shown immediately, without a loading block.
3. Use Library Set Now while Dashboard is unmounted, then reopen Dashboard.
   The old photo must not be reused; the actual new desktop photo should load.
4. Use Dashboard Next, scheduled rotation, and tray Next. The preview
   should update and the old cached preview must never return on navigation.
5. Change wallpaper externally using Windows personalization, then return.
   Cached imagery may appear while Windows status is being checked, but
   must be removed when the OS reports it is no longer current. The
   "Windows confirmed" label must not appear until re-verification succeeds.
6. With two monitors, switch display previews and navigate away/back.
   The selected/active monitor preview must correspond to its exact
   target+wallpaper+timestamp, never a different monitor's image.
7. Restart Haven Walls. One fresh native preview fetch is expected; no
   wallpaper image is persisted in the browser cache on disk.
8. Build with `npm run build` and `npm run tauri dev`. PR #7 remains
   draft until local Windows regression checks pass and user approves.

## Commit 5 follow-up: Remove redundant Sources page

- Removed the standalone Sources sidebar destination and its duplicated
  provider-card route. All five provider choices continue to exist in Gallery:
  Bing Daily, Google Images, Discover by Category, TheSportsDB, and TMDB.
- Dashboard quick access now provides two **distinct** discovery actions:
  Browse wallpapers reopens Gallery on the last selected provider, while
  Discover by Category directly opens Gallery's Discover by Category tab.
- The Settings > Sources tab is retained for source exclusions, API credentials
  and other source preferences. No provider integrations or source data were
  removed or changed.
- Deleted the old Sources-card-only styles, leaving the shared link style.
- Updated the Category Discover review footnote to preserve the provider
  usage-rights warning and remove a stale PR #4 claim. Existing Gallery
  license/attribution notices remain in place.

### Windows verification

1. Pull the PR #7 branch; run `npm run build` and `npm run tauri dev`.
2. Confirm sidebar contains Dashboard, Gallery, Browser, Library, Settings;
   the standalone Sources navigation entry is gone.
3. Confirm all five Gallery provider tabs still work, including Bing Daily,
   Google Browser/API, Discover by Category, TheSportsDB, and TMDB.
4. Select a Gallery provider such as TMDB. Return to Dashboard and click
   Browse wallpapers: Gallery should reopen on TMDB, not reset to Category.
5. Return to Dashboard and click Discover by Category: Gallery should
   switch directly to Discover by Category.
6. Settings > Sources must still show API credentials, exclusions and saved
   provider settings. Nothing should have been reset.
7. Verify Browser, Library, current-wallpaper Dashboard preview, Next
   wallpaper, and Settings > Automation still work as before.

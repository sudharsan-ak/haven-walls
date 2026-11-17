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

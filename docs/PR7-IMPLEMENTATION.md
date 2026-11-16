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

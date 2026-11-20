# PR #11 — Commit 1: Backup creation and scheduling

## Scope

Adds Settings → Backup & Restore with real local backup creation, scheduling,
a Windows native destination folder picker, retention, checksum verification,
and a Back Up Now action. Restore and password-protected archives are planned
for Commit 2 and are explicitly disabled here.

## Included behavior

- Automatic backup defaults OFF; the user chooses an existing destination folder.
- Schedules: local daily clock time (default 02:00), weekly day/time, or
  repeating 1–168 hours including every 24 hours.
- The native Rust process schedules backups while the window is hidden in
  the tray. A missed backup runs once after wake/relaunch; a failed run
  retries after 15 minutes. Completely quitting Haven Walls stops scheduling.
- Back Up Now works even with automation turned OFF and preserves the
  existing automatic due time.
- Full Library + Settings includes managed Library originals and a SQLite
  snapshot. Settings only includes the database without image bytes.
- API credential ciphertext is deleted from the SQLite COPY and VACUUMed
  to discard free pages. The live database and credentials stay untouched.
- Discovery/pending cache, offline reserve, active prepared wallpaper
  copies, browser profiles, and external watched originals are excluded.
- Output is a directory ending with .hwbackup, not a ZIP. It includes
  manifest.json, haven-walls.sqlite3 and optionally library/<filename>.
  The versioned manifest records file size and SHA-256 for all included files.
- The newly created snapshot must pass checksum comparison and SQLite
  integrity_check before the staging directory is promoted. Previous
  backups stay safe if creation or verification fails.
- Retention: 1–30 successful backups, default 3. Only recognized backup
  directories with a valid Haven Walls manifest can be pruned.
- Destination unavailable: no automatic fallback folder; show the error
  and retry later. Disabling scheduling is allowed even when the old USB
  drive has disconnected.
- Existing SQLite StorageLock serializes snapshot and Library writes.
  Large Library backups may temporarily delay other storage operations.

## Windows test checklist

1. Fetch: git fetch origin; git switch feature/pr11-backup-restore
2. npm ci
3. npm run build
4. cargo test --manifest-path src-tauri/Cargo.toml
5. npm run tauri dev
6. Settings → Backup & Restore should default to OFF, Daily 02:00,
   Full Library + Settings, retain 3.
7. Browse for a writable folder; save; use Back Up Now while OFF.
   Inspect manifest.json, SQLite snapshot and managed files.
8. Verify the copied SQLite database has zero api_credentials rows while
   the original database still has working credentials.
9. Switch to Settings only, back up and verify there is no library folder.
10. Set retention to 1; create two backups; ensure only the newer verified
    backup remains. Verify unrelated files/folders are never deleted.
11. Switch schedule among Daily, Weekly, and Every N hours; test persistence
    across app restart, with background rotation still working.
12. Simulate a missing destination or disconnected drive; existing backups
    must remain untouched and status should show a failure.
13. Test folder names containing spaces, Library >1 file, and close-to-tray.
14. Verify other Settings tabs, Gallery, Browser, Library, and rotation still work.
15. Confirm Restore is explicitly disabled until Commit 2.

## Validation boundary

Rust tests cover schedules, preferences, file name safety, sanitization of
copied credentials, full/settings snapshots, verification, and retention.
They have been added but have not been executed on Windows in this environment.
The complete Rust and TypeScript build and real backup run must pass before
we call Commit 1 tested. No restore code or password encryption is included.

## Planned Commit 2

Restore picker, archive inspection and preview; safe Merge and Replace,
independent recovery snapshot and rollback, selective settings-only restore,
managed-file reconciliation, optional authenticated password encryption
with reviewed dependencies, and end-to-end recovery tests.

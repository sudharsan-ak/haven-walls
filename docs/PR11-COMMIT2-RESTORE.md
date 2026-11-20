# PR #11 Commit 2: Restore and integration

## Restore behavior
- Settings → Backup & Restore now accepts a selected Haven Walls backup directory or one of the recent backups.
- Inspect is read-only and verifies SHA-256 checksums, SQLite integrity and foreign-key relationships.
- A restore request re-verifies the backup and confirms the manifest matches the preview.
- Before any modification, create a full independent recovery snapshot under the current app-owned data root in the recovery folder. These are never pruned by ordinary backup retention.
- The recovery copy preserves local Windows-bound API credential ciphertext for recovery. Portable exported backups still sanitize API credentials.
- Stage new managed Library image files first. Reject an existing filename whose bytes differ, never overwrite or delete existing originals, and roll back SQLite and remove newly placed files on a failed restore.
- Current active desktop wallpaper, offline reserve, external originals, API keys, backup destination, backup schedule and Windows login-startup registration are retained.
- Restore pauses the automatic wallpaper rotation; quit and relaunch Haven Walls to refresh every view.

## Merge
- Keep existing Library images, memberships and names.
- Add missing backed-up images, categories, collections, saved interests.
- Union favorites on already-saved images.
- Resolve same-name collections to current collection IDs; reject ambiguous name/ID collisions.

## Replace
- Full backup: replace managed Library database records and organization with backup data, without deleting old physical managed files or touching the active Windows wallpaper.
- Settings-only backup: restore preferences and followed interests, add organization definitions without deleting current managed Library images.
- Require the user to type RESTORE before applying a Replace.

## Known limitations
- Restoration supports current v3 SQLite backups, not unverified legacy or future database versions.
- Backups are self-contained directories (suffix .hwbackup), not ZIP archives.
- Optional password encryption is not implemented: proper portable authenticated encryption needs audited dependencies and key recovery testing, not improvised cryptography. Store backups in a private directory.
- A crash while restoring may leave orphan new managed files/staging directories, but no old originals are intentionally deleted.

## Cleanups
- Remove two unused fields from the rust ApprovedImage struct. Original dimension checks remain active both before and after discovery downloads.
- Code-split heavy React workspaces using lazy imports and Suspense to reduce initial Vite bundle size.

## Windows test checklist
1. Use a disposable Haven Walls data profile. Do NOT test Replace on the only copy of your real Library.
2. Build and test: npm run build; cargo test --manifest-path src-tauri/Cargo.toml; npm run tauri build.
3. Create two saved wallpapers plus a collection/favorite. Create a Full backup. Add a third wallpaper after creating the backup.
4. Inspect that backup using the Restore browser and confirm its date, image count, collections, interests and type.
5. Merge that backup and confirm all existing data remains, favorites/assignments work and duplicates are avoided.
6. Replace from the backup with typed confirmation, check original older file remains on disk, all backed-up records are present, and a recovery folder exists.
7. Check existing API credentials, active Windows wallpaper, offline reserve and backup scheduler/destination are preserved.
8. Create a Settings only backup and Replace: current Library files and their assignments must remain intact.
9. Corrupt a COPY of a backup image or manifest. Inspection must reject it without modifying the live Library.
10. Exercise category/collection collisions, directory paths containing spaces and a missing backup destination.
11. Confirm all app pages, embedded Browser, Library viewer, Settings, background rotation and the tray still work after lazy loading.
12. Restart Haven Walls after successful restore to reload persisted preferences and collections.

## Validation
The Rust unit tests cover a full Merge and Replace, sanitized exports versus local credential-preserving recovery, settings-only restoration and backup tampering. The Windows build and on-device restore tests must still be executed. PR #11 must stay draft until confirmed.

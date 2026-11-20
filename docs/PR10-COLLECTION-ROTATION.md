# PR #10: Collection-based wallpaper rotation

This checkpoint adds collection selection to the existing native Rust rotation
engine. It does NOT create another scheduler or enable unattended sports/TV
website image downloads.

## Behavior

- In **Settings → Automation → Rotate wallpapers from**, choose either
  **Entire Library** (existing behavior) or **Selected collections**.
- Selected collections accept multiple IDs, saved persistently in the existing
  `rotation_settings` SQLite JSON row. Earlier profiles deserialize with
  `rotationScope: "all"` and no selected collection IDs.
- Collection selection is staged in the UI. **Apply rotation selection**
  persists it; at least one collection must be selected for collection mode.
  The **Manage collections in Library** action goes directly to that tab.
- Only approved, managed Library wallpapers in the selected collections are
  eligible; the same wallpaper in two collections is counted once, through
  a SQL `EXISTS` membership filter applied **before** the query LIMIT.
- The existing image dimension checks, local-file checks, favorites-only mode,
  30-day (configurable) no-repeat, active-wallpaper exclusion, pause/pin,
  scheduled rotation, manual Next and apply history remain in force.
- **Entire Library** mode remains unchanged, including the permitted Wikimedia
  offline reserve fallback when Favorites-only is off.
- **Selected collections never fall back to unrelated Library images or the
  offline reserve.** When no eligible image exists, the current wallpaper
  stays in place. Scheduled retries continue under the existing failure
  handling policy. Manual Next reports an actionable error.
- A deleted collection does not silently widen rotation scope. Saved IDs
  remain in preferences until changed, the eligible pool is empty when all
  selected collections are missing, and the UI indicates missing selections.
  Backend save validates IDs still exist, so stale settings cannot newly
  enable a nonexistent collection.

## Safety and migration

- No new SQLite tables or destructive schema migrations.
- Existing `collections` and `wallpaper_collections` tables are reused.
- UI retains selections by stable collection ID, not collection name.
- No cached/offline reserve files, managed Library originals, or wallpaper
  events are modified by changing the rotation scope.
- Automated discovery remains limited to approved Wikimedia public-domain /
  CC0 images and has no relationship to auto-downloading third-party
  sports, league, or TV artwork.

## Windows acceptance checks

1. `git pull --ff-only`, `npm run build`,
   `cargo test --manifest-path src-tauri/Cargo.toml`, then run the app.
2. Existing rotation profiles should open as **Entire Library** with their
   original interval, favorites, cooldown, pause/pin and discovery settings.
3. Create two collections (e.g. Warriors and Nature) under Library →
   Collections. Assign several saved landscape wallpapers, including one
   image belonging to both collections.
4. Settings → Automation → Selected collections → choose both → Apply.
   Verify the eligible count is deduplicated and Next rotates only from
   those collections.
5. Toggle Favorites only. Only favorited images in those selected collections
   may rotate; 30-day no-repeat and active wallpaper exclusion still apply.
6. Leave a selected collection empty, or select only a collection without
   eligible wallpaper quality. Next should be disabled or show an error;
   automatic rotation should not switch to the offline reserve or other
   unrelated saved wallpapers.
7. Delete a selected collection. Verify there is no silent return to Entire
   Library, and Settings can remove the missing selection and save.
8. Restart the app. Confirm scope and collection IDs persist and timed/tray
   rotation still uses the chosen pool even with the Settings window closed.
9. Switch back to Entire Library. Confirm the previous broader rotation
   behavior, including reserve fallback when applicable, is restored.
10. Verify Library collection create/rename/delete, Gallery discovery, image
    preview, Review → Save and ordinary Set Now continue to work.

## Validation boundary

Rust unit tests have been added to check backwards-compatible settings
decoding, invalid selections, multi-collection deduplication, favorites-only
intersection, resolution filtering, and missing/deleted collections. They
have not yet run in a native Windows environment. Full TypeScript/Rust
compilation and on-device rotation checks are required before merging PR #10.

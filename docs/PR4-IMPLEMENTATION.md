# PR #4: Discover by Category

Replaces the **Google Earth View** Gallery entry with a category-first,
image-first discovery screen based on the approved interactive HTML
prototype. Starts from merged PR #3. Does not include PR #5's publisher-site
browsing tabs or PR #6's automatic rotation.

## Included

- Nature, Earth & Aerial, Space, Animals, Places & Cities, and Sports.
- Custom categories stored locally on this device (name + search keywords;
  up to 12). Topic chips, text search, manual refresh, source and
  provider-reported resolution filters.
- Live Wikimedia Commons image search (no API key), and NASA Image Library
  for Earth/Space in combined mode. NASA asset manifests are used to locate
  original-size image links rather than assuming a search thumbnail is full size.
- Optional user-owned Unsplash access key and SerpApi Google Images key.
  Keys are entered once in Settings, DPAPI-encrypted in the existing
  local SQLite DB, and read only by native search requests. Google Browser
  Search is available without an API key. Unsplash use remains subject to
  provider API eligibility and required download tracking/attribution.
- Combined results when optional keys are supplied. Each search clearly
  identifies provider failures instead of silently inventing photo results.
- Inspect images with the existing FullResolutionPreview inspector, add to
  Review selection, batch Save selected to Library using PR #3's existing
  validation, duplicate checks, credits, rights review, and Quick Save policy.
- No hidden background downloads, automatic image rotation, photo upscaling,
  or claim that catalog-reported 4K is verified.

## Design notes

- Category tiles use color/illustration placeholders for instant offline
  paint. Actual photographs come from live source results; no static
  third-party promotional photo is silently fetched on startup.
- Commons files are filtered to JPG/PNG/WebP with direct original links and
  source/rights metadata. Rights and source licenses need manual checking.
- NASA sometimes doesn't publish dimensions in search metadata; show
  "Size unknown" rather than inventing 4K labels.
- The Gallery's old Bing Daily, Google Images / Lens, TheSportsDB and TMDB
  features remain accessible through their existing source routes.

## Local Windows acceptance

1. Open Gallery. Discover by Category should be the default. Confirm no
   Google Earth View tab/source is offered in the visible interface.
2. Select Nature/Forests and Places/Cities: Commons should return real
   photo candidates. Select Earth and Space: NASA results should appear
   when reachable. Confirm real source page URLs and provider labels.
3. Select a photo, inspect source quality, add it to Review, save to Library,
   and verify the correct picture and metadata. No catalog-only thumbnails
   should be claimed to be verified 4K originals.
4. Filter by provider and 4K/1080p; unknown-size NASA results should not
   be mislabeled 4K.
5. Set SerpApi and authorized Unsplash keys once under Settings, then
   refresh the category gallery and confirm their results join the grid.
   Restart the app and confirm keys remain configured and results still load.
6. Remove either key and select its provider: show a clear key-required
   message without crashing or suppressing other sources.
7. Create a custom category, browse it, restart the app and check its
   persistence. Delete it and verify removal.
8. Test no network, provider 401/429, inaccessible originals, Quick Save,
   minimum resolution overrides, duplicates and image rights confirmation.
9. Confirm Google Lens reverse search, Bing Daily, Sports and TMDB existing
   views still work, and all PR #3 data remain intact.

## Scope and limitations

This is a draft implementation requiring a Windows Rust + TypeScript build
and real provider API calls. No CI run or merge is performed by the assistant.
Do not deploy an Unsplash API-powered wallpaper catalog without verifying the
specific application's eligibility and download-tracking requirements.

## Load more (per-provider pagination)

- Initial search fetches one page from each enabled provider. A **Load more
  wallpapers** button appears below the grid when more pages are available.
  No infinite scrolling or background API requests.
- Each click requests one provider's next page and rotates through enabled
  sources. Typical page sizes: Commons 32, Unsplash 24, NASA 18, and up to 36
  filtered SerpApi results. New results append below current images without
  resetting scroll position, changing Review selection or duplicating tiles.
- Native paging: Wikimedia generator search `gsroffset`, NASA `page` and
  `total_hits`, Unsplash `page` and `total_pages`, Google Images via
  SerpApi's zero-indexed `ijn`. Requests validate pages 1–100.
- The original search query and provider list are reused across pages.
  Credentials are re-read from the protected SQLite store by native requests. A new search/category/topic clears discovery
  results and pagination state, but not Review selection. On a provider error
  the current results stay visible and that source is skipped until refresh.

Test on Windows:
1. Search Places & Cities with Commons + Unsplash. Start with ~56 and click
   Load more. Confirm new photos appear at the bottom and previous ones stay.
2. Click again; confirm a different provider's next page loads. Repeated
   clicks should not repeat first-page images or clear the Review tray.
3. Switch category, topic, and refresh; pagination restarts. Review selection
   stays intact.
4. Verify NASA and SerpApi also advance to their respective next pages.
5. Test all sources exhausted, offline errors, and source key failures.

## Persistent, encrypted API credentials

- One **Settings → API credentials** section stores the optional SerpApi,
  Unsplash and TMDB credentials. Save, replace and remove them independently
  of wallpaper preference settings. After save, only a configured flag is
  displayed; the plaintext value is never returned to the React UI.
- SQLite has an idempotently created `api_credentials` table containing
  Windows DPAPI (CurrentUser) ciphertext, not plaintext values.
  All native API requests read/decrypt the saved value themselves. Browser
  Search continues to work without a key; Wikimedia Commons and NASA need
  no keys.
- Normal source builds, Git pulls, Tauri installer updates and additional
  feature PRs must not delete or replace the Haven Walls data database.
  The existing `open_database` initialization uses
  `CREATE TABLE IF NOT EXISTS`, preserving existing credentials and
  wallpaper rows. Changing storage mode migrates the existing database;
  the old location remains as a recovery copy.
- Windows user context matters: DPAPI protected secrets cannot be restored
  on a different Windows account/machine merely by copying the DB. Users
  can remove and re-enter a credential when moving systems.
- **Never** store API keys in Tauri resources, .env, localStorage, Rust source,
  GitHub branches, test logs, screenshots, or build output.

Windows acceptance:
1. Set all three keys under Settings and save each separately.
2. Restart Haven Walls, rebuild/reinstall the EXE, and reopen Settings:
   all three must still show Configured without displaying the actual key.
3. Visit Gallery → Discover, Google Images → API Search and TMDB Backdrops.
   Requests must use the saved credentials automatically; no key entry
   fields in Gallery or API Search.
4. Test Load More with Unsplash and SerpApi, and replace/remove a key.
   Removed keys should cause an explanatory Settings error rather than a crash.
5. Test AppData ↔ portable-folder migration and an upgrade from a database
   written by PR #3. Existing wallpapers, settings and credentials must remain.
6. Confirm encrypted BLOBs, not readable keys, in the local
   `api_credentials` SQLite table. Do not print actual keys in test reports.

Durability constraints for future development:
- Keep the Tauri application identifier `com.havenwalls.app` unchanged, or
  provide an explicit migration from the previous app data directory.
- Do not delete `haven-walls.sqlite3` during a build, startup, schema upgrade,
  or feature rollback. Use additive/idempotent migrations; never replace the
  existing DB with the empty schema.
- In portable mode the database lives in `HavenWallsData` beside the running
  executable. Keep that folder with the EXE when switching build/output
  locations. Normal rebuilds in the same folder preserve the data.
- The encrypted keys require the same Windows user profile. Moving a portable
  folder to another Windows account requires re-entering those keys.

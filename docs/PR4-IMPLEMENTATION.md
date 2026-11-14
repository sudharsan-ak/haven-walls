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
  Both are held in React session memory; neither is persisted or included in
  app logs. Google Browser Search is still available without an API key.
  Unsplash use remains subject to provider API eligibility and required
  download tracking/attribution for production use.
- Combined results when optional keys are supplied. Each search clearly
  identifies provider failures instead of silently inventing photo results.
- Inspect images with the existing FullResolutionPreview inspector, add to
  Review selection, batch Save selected to Library using PR #3's existing
  validation, duplicate checks, credits, rights review, and Quick Save policy.
- No hidden background downloads, credential persistence, automatic image
  rotation, photo upscaling, or claim that catalog-reported 4K is verified.

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
5. Enter a SerpApi key, refresh, and confirm Google results join the grid.
   Enter an authorized Unsplash key, refresh, and confirm photo results and
   photographer/source metadata. Keys must not survive a full app restart.
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

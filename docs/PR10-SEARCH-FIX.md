# PR #10 — Gallery search fix (follow-up)

This commit corrects the search flow after the user tested Commit 2.

## Expected behavior

1. In **Library → Categories**, configure a category keyword, a recent/custom
   Google Images time range, and preferred HTTPS websites.
2. Go to **Gallery → Sports Interests / TV & Movies / Discover**, choose that
   saved interest and select **Built-in Browser · No API key** (default).
3. Clicking **Find wallpapers** launches isolated, hidden, user-triggered
   WebView2 searches. It **does not navigate to the Browser workspace**.
4. For general Google Images and website `site:` searches, the hidden session
   loads Google Images with the category keyword/time filter, then runs the
   **same bounded SCAN_JS + parse_scan used by Browser → Find Images**.
5. Websites configured for *direct page scanning* are scanned first. If no
   relevant images are found, the same keyword is searched via Google Images
   `site:` for that website.
6. Results appear incrementally in the existing unified Gallery grid,
   deduplicated by image URL. Inspect and Review continue through existing
   preview and Library import checks. No file is downloaded automatically.
7. The method selector also supports **SerpApi** or **Both**, when the user
   chooses them. The selected mode persists locally. **No SerpApi key is
   required for the built-in Browser method.**
8. Independent TheSportsDB/TMDB artwork remains available when enabled for
   a saved category. The free photo categories and standalone Google Images
   modes remain unchanged.

## Boundaries

- WebView2 scanning inspects only loaded page DOM/image candidates, not an
  entire website. Some search pages use consent prompts, challenges, lazy
  image loading or restrictions, and may return no images.
- There is no generic, reliable search API for arbitrary website-specific
  search boxes. Direct page scans use text/URL relevance and fall back to
  Google Images `site:` searches rather than pretending site-native search
  always works.
- Search results and time filters are best effort, not image publication
  date verification, resolution verification or licensing clearance.
- Each managed WebView has a per-page timeout, is isolated from the visible
  Browser session, and is closed on completion, failure, or cancellation.
- Scheduled discovery and unattended third-party downloads remain out of
  scope for this commit. Collection rotation is still planned separately.

## Windows verification

Run `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`,
and the usual Windows desktop build.

1. Select NBA in Sports Interests, **Built-in Browser**, **Past 24 hours**.
   Click Find wallpapers with no SerpApi key configured. There should be no
   mandatory key error. Scanned candidates should populate the Gallery grid
   when the remote search page exposes images.
2. Select Warriors with `nba.com` and `espn.com`. Confirm separate
   site-filtered searches, merged results, and deduplication. User remains
   in Gallery throughout.
3. Change a website to **Scan site + fallback** in Library → Categories;
   confirm a direct scan can fall back to a Google `site:` query.
4. Switch between interests while searching. Old candidates must not appear
   for the new interest and hidden WebViews should be closed.
5. Try past week and custom dates; check searches reflect the chosen filter.
6. Optionally select SerpApi. With no key, only this opt-in mode should report
   a missing key; switching back to Built-in Browser must work.
7. Verify TMDB/TheSportsDB metadata sources, the main Browser's Find Images
   workflow, standalone Google Images, and existing Library imports still work.

**Validation:** A full Windows build and live remote-site scan cannot be run
from this connector session. Do not merge until tested locally.

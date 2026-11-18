# PR #10 follow-up: three discovery passes per saved website

Every configured website in Library → Categories now contributes **three independent
on-demand passes** when Gallery → Find wallpapers is clicked. The passes are
additive, not alternatives.

1. **Google Images site search**: `<keyword> site:<saved-site>`, respecting the
   category's Google recency/custom-date filter. Built-in WebView2 is the
   default; SerpApi can be explicitly selected.
2. **Direct website scan**: load the configured HTTPS page in an isolated
   off-screen WebView2 and run the existing Browser **Find Images** extraction,
   retaining candidates that match the interest keyword where possible.
3. **Native website search**: load the actual site and look for a supported
   search field or GET search form. Submit the user's keyword to that site's
   search interface and scan the resulting page. This pass reports itself
   unavailable where a site has no usable native search or blocks navigation.

The passes run independently. An unsupported site search does not remove
images found through Google or direct scanning. Duplicate image URLs are
collapsed into one unified Gallery grid, with individual source filters.

All saved sites now use the three-pass model regardless of the legacy website
mode previously stored in the database. The removed category mode dropdown is
not needed. The general Google Images toggle controls only the extra
unrestricted search, not the explicitly configured website searches.

## Image loading

- Isolated WebView2 searches remain off-screen and do not navigate the user's
  Browser workspace.
- Before collecting candidates, the scanner requests lazy images and performs
  four bounded scroll steps instead of scanning once 1.4 seconds after load.
- The scanner uses the same validated Rust metadata parser and image
  identification logic as the existing Browser's Find Images command.
- Broken preview thumbnails try their original URLs when available.
- Each remote site may redirect, refuse scanning, present consent/CAPTCHA
  dialogs, or dynamically load content that isn't discoverable; results are
  best effort and never imply permission to copy copyrighted pictures.
- There is no unrestricted site crawler and no automatic download.

## Test on Windows before merging

1. `git pull --ff-only`, then `npm run build`.
2. Run `cargo test --manifest-path src-tauri/Cargo.toml` and the Windows
   Tauri build using the existing build guide.
3. Select Golden State Warriors and `nba.com` in Categories, then Gallery →
   Sports Interests → Find wallpapers with Built-in Browser selected.
4. Observe independent results/failures for `Google Images site:`,
   `Site images`, and `Site search`, plus optional general Google results.
   Confirm results appear in Gallery without changing the Browser tab.
5. Repeat with `espn.com`. A site without a supported GET/native search
   field should report the unsupported native pass, while the other passes
   continue.
6. Select past-24-hours, past-month, and custom dates. Date filtering applies
   to Google searches, not direct/native scans without their own date options.
7. Try two saved websites and verify duplicates are not repeated in the grid.
8. Change interests while an image scan is in progress. Verify no stale
   results leak into the next interest and no discovery WebViews stay open.
9. If configured, test SerpApi and Both. The native/direct site scans should
   still work without needing a SerpApi key.
10. Verify existing Browser → Find Images, TMDB artwork, Library import and
    rotation are unaffected.

**Validation boundary:** No native Windows WebView2 build or live-site
execution was available in the tool environment. Do not merge PR #10 until
the Windows build and site testing pass.

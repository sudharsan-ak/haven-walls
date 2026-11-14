# Haven Walls: Windows build and PR #2 validation

**Only the user pulls, builds, tests and merges.** Assistant commits do not initiate builds, tests, or GitHub Actions.

## Windows prerequisites

Git, Node.js LTS, Rust stable MSVC toolchain, Visual Studio C++ Build Tools with Desktop development with C++, and Microsoft Edge WebView2.

## Pull the PR branch (USER ONLY)

Open PowerShell in the haven-walls repo:

~~~powershell
git status
git switch feature/online-wallpaper-discovery
git pull --ff-only origin feature/online-wallpaper-discovery
git log -1 --oneline
~~~

Do not overwrite local changes. Do not merge into main before local validation and user approval.

## Build and launch (USER ONLY)

Quit any older Haven Walls instance before rebuilding.

~~~powershell
npm ci
npm run tauri build -- --bundles nsis
Start-Process .\src-tauri\target\release\haven-walls.exe
~~~

The release EXE is for testing on the build PC; portable app packaging is a later milestone. NSIS installer files are under src-tauri/target/release/bundle/nsis. Optional development mode: npm run tauri dev.

If Cargo updates src-tauri/Cargo.lock, review the dependency diff and commit only that lockfile to the feature branch; do not add Cargo.lock to .gitignore.

## Shell and source regression

1. Custom Haven Walls title bar stays visible. Only right content panel scrolls; sidebar stays fixed.
2. Bing Daily: load recent photos.
3. Google Earth View: load regional aerial imagery, e.g. Switzerland.
4. TheSportsDB: search Golden State Warriors and Mumbai Indians.
5. TMDB: paste private TMDB Read Access Token, search Landman, choose correct series and inspect backdrops.
6. Google Images remains one top-level Gallery source with Browser Search and API Search subtabs.

## League and website discovery

1. In Gallery → TheSportsDB, open League image websites. NBA starts with nba.com; IPL starts with iplt20.com.
2. Select NBA and add another website such as espn.com/nba. Choose Search site; Google Images should open with a site-filtered query using the team currently in the team search box.
3. Search saved websites generates a query with all saved site filters joined by OR. Search all websites omits the site restriction.
4. Add WNBA as a new league, and give it wnba.com and optionally espn.com/wnba. Search either or both. Try a different league and team.
5. Verify duplicate/invalid sites are rejected, sites and leagues can be removed, and Restore defaults works. Close and reopen the app: edited leagues and websites should persist.
6. League websites are **Google Images search restrictions only**, not direct crawlers or image download APIs. Google may index little from a given site or ignore complex site operators. Overlong queries show an error; search individual sites instead.
7. Settings currently persist in local WebView2 storage on this PC. The eventual portable-folder vs Windows AppData choice is part of the dedicated storage milestone, not this PR.

## Embedded Google right-click image selection

1. In Gallery → Google Images → Browser Search, enter a wallpaper search and load Google's real image grid in the embedded browser.
2. Check the browser information area: it should show either a native context-menu attachment status or a specific registration error.
3. Right-click a photo in Google's results or enlarged preview. When WebView2 provides an image target or usable direct source, **Add to Haven Walls review** should appear at the top of the image context menu.
4. Choose it; the selected image should appear on the right in Review selection without manual copy and paste. Repeat with several different photos; the same source URL should not be added twice.
5. For Google blob/data thumbnails with no HTTPS image source, the native item may explain why it cannot import that image. Fallbacks are Copy image link → Add copied image, paste direct URL, or Choose images (JPG/PNG/WebP files up to 32 MB each).
6. Inspect individual selected images and check original dimensions. Clear selection empties this temporary list only. It must not modify the Google search, downloaded files or desktop wallpaper.
7. Switch Browser → API → Browser, search again and right-click. No duplicated menu entries. Google's normal right-click actions remain available.
8. Resize Haven Walls, scroll the right content area, adjust browser zoom 70–150% with 100% reset, and select Compact / Normal / Tall embedded page height. No overlay over the sidebar or app chrome.

**Important:** Native menu integration uses WebView2 ContextMenuRequested and CustomItemSelected, not injecting scripts into Google. It must be validated on the user's Windows computer. Code committed does not prove the menu always appears; the status/error message is intended to diagnose missing menu items.

## API Search, preview and sources

1. Under Google Images → API Search, enter your personal SerpApi key inside API settings and browse results with 1080p/1440p/4K filters. Key is held in app memory.
2. Click the + control to select API photos. Selections from Browser Search and API Search share the same temporary review tray, limited to 30 items.
3. Inspect: Haven Walls may unwrap a Google imgres link, try known larger image URLs on supported providers and measure the actual pixel dimensions. It must label cached thumbnail fallback, rather than claim 4K based only on search terms.
4. Image sharpness and reuse permission are not guaranteed by reported image dimensions.
5. Under Sources, check the **Wallpaper photo information** preferences. Show photo credit defaults on and show caption defaults off. These are persisted now but have **no effect on the Windows desktop** until PR #3 adds wallpaper application.
6. Credits and copyright/rights remain metadata even when visible display text is disabled; terms requiring attribution must still be followed.

## PR #2 closure criteria

- No automatic scraping, remote telemetry, persistent library downloads, wallpaper application or rotation are performed by this PR.
- Official league/ESPN websites are discovered through Google site-restricted searches, not scraped or treated as rights-cleared assets.
- Existing Bing, Earth View, TheSportsDB, TMDB, and Google Images browser/API flows still work.
- The user reviews results and explicitly authorizes the merge.

After merge, the user can run:

~~~powershell
git switch main
git pull --ff-only origin main
~~~

**PR #3 goal:** download/cache user-approved images, create a local wallpaper library, support Fill/Fit and optional credit/caption overlays where permitted, and apply Windows desktop wallpapers. Rotation follows in a later PR.

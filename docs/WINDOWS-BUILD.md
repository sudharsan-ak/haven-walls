# Haven Walls: Pull, Build, and Test on Windows

Use a **PowerShell terminal in VS Code**, opened at the root of your local `haven-walls` repository. This is the repeatable testing process for every pull request.

## One-time Windows 11 setup

Install Git, Node.js LTS, Rust (stable **MSVC** toolchain), and Visual Studio C++ Build Tools with the **Desktop development with C++** workload. Windows 11 normally has Edge WebView2 already.

Check these commands in a *new* PowerShell terminal:

```powershell
git --version
node --version
npm --version
rustc --version
cargo --version
rustup show active-toolchain
```

If you have not cloned the repo yet, do this once in your preferred parent folder:

```powershell
git clone https://github.com/sudharsan-ak/haven-walls.git
cd .\haven-walls
```

For each PR, open the repo folder in VS Code and use **Terminal > New Terminal**. The steps below assume that terminal is at the repo root.

## Stage 1: Pull a PR branch

Set the branch name from the PR, then run the entire block:

```powershell
$ErrorActionPreference = "Stop"
$branch = "feature/online-wallpaper-discovery"  # Change for each PR

if (git status --porcelain) {
    throw "Working tree is not clean. Review local changes before switching."
}

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw "Git fetch failed" }

git show-ref --verify --quiet "refs/remotes/origin/$branch"
if ($LASTEXITCODE -ne 0) { throw "PR branch not found: $branch" }

if (git branch --list $branch) {
    git switch $branch
} else {
    git switch --track "origin/$branch"
}
if ($LASTEXITCODE -ne 0) { throw "Could not switch branches" }

git pull --ff-only origin $branch
if ($LASTEXITCODE -ne 0) { throw "Branch update failed" }

git diff --check
if ($LASTEXITCODE -ne 0) { throw "Git diff validation failed" }

git status --short --branch
git log -1 --oneline
```

Expected: You are on the PR branch, with a clean working tree.

## Stage 2: Build an app EXE

Quit any previous Haven Walls instance before rebuilding. Run:

```powershell
$ErrorActionPreference = "Stop"

# Restore exactly the pinned frontend dependencies from package-lock.json.
npm ci
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }

npm run build
if ($LASTEXITCODE -ne 0) { throw "React/TypeScript build failed" }

npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Tauri Windows build failed" }

$appExe = Join-Path (Get-Location) "src-tauri\target\release\haven-walls.exe"
if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Application EXE not found: $appExe"
}

Write-Host "Built commit: $(git rev-parse --short HEAD)"
Write-Host "App EXE: $appExe"

$nsisDir = Join-Path (Get-Location) "src-tauri\target\release\bundle\nsis"
Get-ChildItem -Path $nsisDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object Name, FullName
```

Outputs:

- **Application EXE:** `src-tauri\target\release\haven-walls.exe`
- **Optional installer EXE:** `src-tauri\target\release\bundle\nsis\*.exe`

The direct EXE is for testing on the **build PC**. This does **not** establish that the app is a self-contained portable distribution; portable packaging is a later milestone.

## Stage 3: Launch and test

```powershell
Start-Process -FilePath $appExe
```

For PR #2, verify the custom title bar and Dashboard still work, and the **right content panel scrolls independently** from the sidebar/header. Then open **Gallery** and try all four sources:

1. **Bing Daily:** select it and click **Load recent photos**. Bing's feed is a daily photo catalog, not keyword search.
2. **Google Earth View:** browse with an empty location; try filtering to `Switzerland` or `India`. The data originates from the Earth View archive.
3. **TheSportsDB:** search `Golden State Warriors`, then `Mumbai Indians`. Team badges or fan art may be smaller than a wallpaper.
4. **TMDB:** enter your own **TMDB API Read Access Token**, search `Landman`, select the intended show, then view landscape backdrops. The token is only kept in app memory; it is not persisted.
5. **Google Images (SerpApi):** obtain your own API key from https://serpapi.com/manage-api-key (a free tier is available). Open the **Google Images** tab, paste the key, and search `Golden State Warriors 4K desktop wallpaper` or `Landman TV series 4K wallpaper`. The key stays in app memory until the app closes. Try minimum-resolution filters at 1080p, 1440p and 4K. Verify the results are landscape, their reported original dimensions meet the selected minimum, exact duplicate original URLs have been screened out, and the source URL can be copied. There is no guarantee the source-hosted image itself is sharp or licensed for wallpaper use.
6. **Cross-source exploration:** from TheSportsDB or TMDB results, use **Search Google Images** to open the web-image source with the same team/show name prefilled. Google search is user-triggered, never run on each keystroke.
7. **Sources:** Bing Daily, Google Earth View, TheSportsDB, TMDB and Google Images should appear as selectable entries. Unsplash should be labeled **Not enabled** pending provider permission.
8. Open an image detail preview, copy its source URL, close it with Escape, and verify no Windows wallpaper is downloaded or applied.

Check for empty/error states if a provider returns no images or is unavailable. None of these integrations grants usage rights to third-party artwork.

For a fast development preview (without generating a release EXE):

```powershell
npm run tauri dev
```

Stop the dev session with **Ctrl+C**. Before accepting a PR, test its **release EXE**. If anything fails, keep the PR open; share the exact error, and retest the updated branch.

## Stage 4: Update local main after merge

After you have approved and merged the PR on GitHub:

```powershell
$ErrorActionPreference = "Stop"

if (git status --porcelain) {
    throw "Review local changes before switching."
}

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw "Git fetch failed" }

git switch main
if ($LASTEXITCODE -ne 0) { throw "Switch to main failed" }

git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw "Updating main failed" }

git status --short --branch
git log -1 --oneline
```

**Workflow:** GitHub PR → pull branch locally → build EXE → run and test → fix on same PR if needed → merge after approval → synchronize `main`.

**Reference:** https://v2.tauri.app/start/prerequisites/ and https://v2.tauri.app/distribute/windows-installer/

## PR #2: Rust dependency lockfile

This PR adds Rust HTTP dependencies for the online providers. If your local build updates `src-tauri/Cargo.lock`, **commit that lockfile only** on the same PR branch. GitHub Actions is configured for manual use only; commits and PR updates do **not** trigger builds automatically.

```powershell
git add -- src-tauri/Cargo.lock
git diff --cached --stat
git commit -m "build: lock online source dependencies"
git push origin feature/online-wallpaper-discovery
```

Don't merge the PR until the four source flows and your local Windows build have been reviewed.

## PR #2 final additions: original preview and Google browser

This commit adds **two ways to use Google Images**, retaining the existing SerpApi result grid:

1. **Full-resolution preview:** click a SerpApi result. Haven Walls attempts the provider's `original` URL first. If the host rejects hotlinking or the image fails to load, the dialog falls back to the thumbnail and labels it as such. The WebView image element reports the **actual pixels loaded**, with a warning if the image is below 1080p or not a typical landscape aspect ratio. TMDB backdrops likewise request the original provider file. Provider-reported dimensions are shown for comparison. These are browser rendering checks, not independent image-file validation, blur scoring or rights approval.
2. **Manual Google Images browser:** in **Gallery → Google Images**, choose **Browse Google Images**. A separate Tauri WebView2 window opens Google's own image search for the text in the query field. Google pages have no Haven Walls native API capability; navigation is restricted to approved Google hosts. No automatic scraping of the Google DOM or image extraction takes place. Some Google flows or popups may be blocked in embedded WebView2; if that happens, use **Copy Google search link** and open it in your regular browser.
3. **Manual selection:** right-click/copy a direct HTTPS image URL on the web, then paste it into **Paste a direct image address → Preview URL**. Or download a file using your browser, then choose it with **Preview image file** (JPG, PNG or WebP, 32 MB maximum). The preview inspects the loaded pixels. Files are previewed via temporary browser object URLs and are **not copied into the Haven Walls wallpaper library**.
4. **Library metadata preparation:** `src/lib/imageInspection.ts` defines the inspection draft: source, original URL when available, source page, actual/reported dimensions, aspect, attribution, and unverified rights. This is a preview-only structure for future PR #3; there is no Save, Apply or Add to Rotation action yet.

**Test on Windows yourself:** verify the separate Google webview opens, copy an image address, paste it for preview, and select a downloaded local file. Test image grid → original image preview at 4K and a blocked source → thumbnail fallback. Close the modal with Escape or × and check that the main custom title bar remains unchanged. Only the user performs builds/tests.

## Google Images nested workspace (latest PR #2 commit)

The existing top-level Gallery sources remain unchanged. Inside **Google Images**, two nested tabs match the approved interactive HTML prototype:

- **Browser Search** (default): Enter a query and click **Search Google Images**. Google's actual site opens as a **child WebView2 inside Haven Walls' existing main window**, not as a separately titled Windows window. The child should follow the right content panel while it scrolls or resizes, and disappear when changing tabs or opening a preview.
- **Select an image**: Right-click an image on the real Google page → **Copy image address**, then click **Add copied image** in Haven Walls. It joins the temporary Review selection list. If clipboard access is denied, expand the fallback section to paste a direct HTTPS image URL or choose a downloaded JPG/PNG/WebP file (32 MB maximum). Direct cross-origin DOM/checkbox access is not attempted.
- **API Search**: SerpApi remains available, with minimum reported resolution controls and the personal API key under collapsible **API settings**. Each API result has + to select and **Inspect original** to preview.
- **Review selection**: Shared across Google Images' two subtabs. Inspect, remove or clear chosen candidates. No automatic permanent downloads, cache storage, approval, or rotation in PR #2.
- **Compatibility:** Child webviews are an **unstable Tauri 2 feature**, and this PR enables `tauri/unstable`. Google could block some embedded browsing functions. **Copy Google search link** opens the option to search in an ordinary browser.
- **Isolation:** Main Tauri capabilities now target the local `main` webview label, rather than granting a whole-window capability to the remote Google child. External web content cannot invoke Haven Walls commands; navigation is restricted to Google HTTPS origins.

### Local acceptance checks for this commit

1. Build on Windows as normal and visit **Gallery → Google Images → Browser Search**. Confirm Google results appear **in the page**, with the normal Haven Walls header/sidebar visible.
2. Scroll the right content panel, resize the app, switch Browser → API → Browser, and inspect an image modal. Check that the Google child does not overlap the sidebar, header or modal.
3. Copy image address from a Google image → **Add copied image**. Inspect loaded dimensions, remove it, and try the paste URL and local file alternatives.
4. Switch to API Search, expand API settings, and search with SerpApi. Click + on an image. Switch back to Browser Search and confirm the same review selection persists.
5. Verify Bing Daily, Earth View, TheSportsDB, and TMDB remain unaffected.
6. No library additions or Windows wallpaper changes should occur.

Builds, tests, and merges are carried out only by the user.

## Google Images access and limitations

Google's older Custom Search JSON API is closed to new developers. Haven Walls therefore uses the documented **SerpApi Google Images API** as an optional web-image discovery adapter, not Google's old API and not direct HTML scraping of Google Search.

- Sign up at https://serpapi.com and find your personal API key at https://serpapi.com/manage-api-key.
- Enter that key only into Haven Walls **Gallery → Google Images**. No secrets belong in the repository, GitHub issues, or build logs.
- Each explicit search uses your own SerpApi allowance. The free plan currently advertises **250 successful searches per month**; check their current pricing/terms before subscribing.
- Filtering is done in Rust on the metadata returned by the API: minimum original width/height, landscape ratio, unsafe/product flags, exact-URL duplicates, and 4K/aspect ranking.
- This does **not** scrape source sites, decode image pixels, identify near-duplicate images, prove an image's sharpness, or grant any reuse rights. The previews display provider thumbnails and link back to source pages.
- If you have no SerpApi key, Bing Daily, Google Earth View, TheSportsDB and TMDB remain usable independently.
- This PR does not add any new Rust dependencies beyond the already introduced HTTP and JSON libraries.

**GitHub Actions remains manual-only**. Assistant code pushes never run build workflows automatically. The user owns all builds, tests and merging.


## Browser Search: zoom and review controls

- The **− / percentage / +** buttons in the embedded browser header adjust **only Google's WebView2 page zoom** from 70% to 150%, in 10% increments. Click the percentage to reset to 100%. The rest of Haven Walls is unaffected.
- **View** adjusts the embedded browsing area's height: Compact (420px), Normal (490px) or Tall (680px). The right content pane should continue scrolling independently from the application title bar and sidebar.
- Clicking a picture in Google's page only opens Google's own larger preview. To select one for Haven Walls, right-click the larger image, choose **Copy image address**, then click **Add copied image** just below the embedded page.
- The image then appears in **Review selection**. Click its row to inspect that particular picture; **Inspect first image** opens the first selected picture. **Clear selection (N)** clears the temporary review list but does not delete downloaded files or change Google's results.
- If the clipboard is blocked, expand the **Alternative: Paste an image address or choose a downloaded file** section and paste the direct HTTPS image URL, or choose a local JPG/PNG/WebP file.
- Try changing zoom while the real Google browser is open, after changing the Google query, and after switching Browser Search ↔ API Search. Verify zoom isn't applied to the native Haven Walls UI. Native zoom uses Tauri's Webview.set_zoom.

As agreed, the assistant only commits source code. Only the user builds and tests on Windows.


## Local image picker update

- The local image picker now displays **Choose images** styled to match Haven Walls buttons rather than Windows' default file-input appearance.
- It accepts **multiple JPG, PNG, and WebP files** in one selection, up to 32 MB per image and a 30-image temporary Review selection limit. Invalid and excess files are skipped with a visible message.
- Selected files remain temporary, in-memory previews. Each image appears separately in Review selection and can be inspected or removed. No files are saved to the wallpaper library.
- Test the file chooser's keyboard focus, choose several files together, inspect individual queued images, and verify Clear selection works. Only the user runs the Windows build/tests.


## Browser Search: native right-click image selection on Windows

The embedded Google Images child WebView2 adds one command to its own native image right-click menu. The ordinary Google/WebView2 menu options are retained.

1. In Gallery → Google Images → Browser Search, search for a wallpaper.
2. Right-click a picture in Google's results or large image preview. If the browser exposes a direct HTTPS image URL, the context menu should include "Add to Haven Walls review".
3. Click that command. The native browser sends the image URL and current page URL to the local Haven Walls main UI. The image appears in Review selection immediately, without manually copying or pasting a link.
4. Right-click and add multiple different pictures. Duplicates are ignored and there is a maximum of 30 temporary review images.
5. Click an item in Review selection to inspect its actual displayed dimensions or remove it. Clear selection only empties this temporary review list. It does not delete downloaded files or change your Windows wallpaper.
6. On images that only use blob or data URLs, or for elements that are not reported as image targets by WebView2, the new menu command may not appear. Use Copy image link → Add copied image or the direct URL/file fallback in those cases.
7. Switch Browser Search ↔ API Search and back, then right-click an image again. Verify that the native command still works in the new child webview and that no duplicate menu items appear.

This is a Windows-specific host-level integration using WebView2's ContextMenuRequested and CustomItemSelected APIs. The external Google page never receives native app permissions, no DOM scraping or script injection occurs, and no selected image is saved to the wallpaper library or rotation.

Only the user pulls, builds, tests and merges PR #2.


## Image-link resolution and actual quality verification

When an image is added by the native **Add to Haven Walls review** menu or by pasting its direct HTTPS address, Haven Walls tries to identify its best available source before displaying an inspection preview:

1. If a Google imgres/redirect URL contains an explicit original image address, Haven Walls extracts that address. When WebView2 exposes both an image SourceUri and an enclosing link LinkUri, the source is kept as the preview while the link may provide a better original.
2. For certain known image providers (currently Pexels, Unsplash image URLs, and TMDB's image CDN), Haven Walls may request a larger **candidate image URL** using their URL-size conventions. An upgraded URL is not assumed to be valid.
3. **Inspect** checks a limited set of candidates, one by one, through image loading in the desktop webview. It compares the actual naturalWidth/naturalHeight, prefers a suitable high-resolution landscape, and stops early upon loading a 4K image. It does not run a broad crawl or save source images to the wallpaper library.
4. If all larger candidates fail or are blocked, the preview falls back to the provided image. It reports the pixels actually loaded and explains if only a Google-cached thumbnail was available.
5. Image pixels reported as 4K do not guarantee genuine optical sharpness; some image hosts resize/upscale small originals. The source's copyright and permissions still need review before any library import.

**Manual Windows checks:** Right-click and add a Google image, then inspect it; paste a direct Pexels or TMDB thumbnail-sized image URL and inspect for a larger source; paste a Google imgres link containing an imgurl parameter and inspect the unwrapped source; try a Google encrypted-thumbnail URL and verify the app warns when no original image is available. Compare the loaded pixels and follow the copy-image/source buttons. Verify multiple additions, dedupe and fallback behavior. The user alone builds and tests.

No external image-analysis service, telemetry, automatic download, wallpaper apply or rotation was added in this commit.

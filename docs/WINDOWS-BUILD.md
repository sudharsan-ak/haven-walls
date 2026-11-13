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

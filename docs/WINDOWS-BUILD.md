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

For PR #2, check the custom title bar and Dashboard, then open **Gallery** and search Nature landscape, Mountain sunset, and a custom topic. Confirm that real Wikimedia Commons thumbnails, dimensions and reported license names appear. Open a preview, copy the source link, dismiss with Escape, and check the Sources page. This build must not change the Windows wallpaper.

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

## PR #2 note: update Rust dependency lockfile

This PR adds Rust HTTP dependencies for the first online source. The initial Windows build may update `src-tauri/Cargo.lock`. **Commit that updated lockfile only** to the same PR branch, then push it so GitHub CI uses the same Rust versions as your local test.

```powershell
git add -- src-tauri/Cargo.lock
git diff --cached --stat
git commit -m "build: lock Wikimedia search dependencies"
git push origin feature/online-wallpaper-discovery
```

Don't merge the PR until the Windows CI check and your local test both succeed.

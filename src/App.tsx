import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invalidateDashboardWallpaperCache } from "./lib/dashboardPreviewCache";
import { type CatalogSourceId } from "./lib/native";
import WindowChrome from "./components/WindowChrome";
import SidebarIcon from "./components/SidebarIcon";
import OnlineGallery from "./components/OnlineGallery";
import BrowserPage from "./components/BrowserPage";
import SettingsPage, { type SettingsTab } from "./components/SettingsPage";
import LibraryPage from "./components/LibraryPage";
import DashboardPage from "./components/DashboardPage";
import LibraryImportDialog from "./components/LibraryImportDialog";
import type { ImportItemResult } from "./components/LibraryImportDialog";
import ApplyWallpaperDialog from "./components/ApplyWallpaperDialog";
import type { CatalogImage } from "./lib/native";
import type { LibraryWallpaper } from "./lib/wallpaperLibrary";
import type { FollowedInterest } from "./lib/personalization";
import "./App.css";

type ImportRequest = {
  images: CatalogImage[];
  origin: "browser" | "other";
};

type BrowserImportCompletion = {
  sequence: number;
  completedIds: string[];
};

export default function App() {
  // This subscription remains active across page navigation, including when
  // Dashboard is unmounted. A timed/tray rotation invalidates its cache before
  // the user returns to the Dashboard.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen("rotation:applied", () => {
      if (active) invalidateDashboardWallpaperCache();
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => { /* Dashboard still verifies the OS on navigation. */ });
    return () => { active = false; unlisten?.(); };
  }, []);

  const [page, setPage] = useState<"dashboard" | "gallery" | "browser" | "library" | "settings">("dashboard");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("automation");
  const [libraryFocusId, setLibraryFocusId] = useState<string | null>(null);
  const [libraryEntryTab, setLibraryEntryTab] = useState<"wallpapers" | "categories">("wallpapers");
  const [galleryInterestId, setGalleryInterestId] = useState<string | null>(null);

  function openAutomation() {
    setSettingsTab("automation");
    setPage("settings");
  }
  function openLibrary(wallpaperId?: string) {
    setLibraryFocusId(wallpaperId ?? null);
    setLibraryEntryTab("wallpapers");
    setPage("library");
  }
  function manageCategories() {
    setLibraryFocusId(null);
    setLibraryEntryTab("categories");
    setPage("library");
  }
  function openInterestGallery(interest: FollowedInterest) {
    setGalleryInterestId(interest.id);
    setGallerySource(interest.kind === "league" || interest.kind === "team" ||
      interest.kind === "player" ? "sports" :
      interest.kind === "tv" || interest.kind === "movie" ? "tmdb" : "discover");
    setPage("gallery");
  }
  const [gallerySource, setGallerySource] = useState<CatalogSourceId>("discover");
  const [googleSearchSeed, setGoogleSearchSeed] = useState("");
  const [lensRequest, setLensRequest] = useState<{ imageId: string; requestId: number } | null>(null);
  const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
  const [browserImportCompletion, setBrowserImportCompletion] =
    useState<BrowserImportCompletion | null>(null);

  function beginOtherImport(images: CatalogImage[]) {
    setImportRequest({ images, origin: "other" });
  }

  function beginBrowserImport(images: CatalogImage[]) {
    if (images.length === 0) return;
    setImportRequest({ images, origin: "browser" });
  }

  function completedImport(results: ImportItemResult[]) {
    if (importRequest?.origin !== "browser") return;
    const completedIds = [...new Set(results
      .filter((result) => result.status === "saved" || result.status === "duplicate")
      .map((result) => result.imageId))];
    if (completedIds.length > 0) {
      setBrowserImportCompletion((previous) => ({
        sequence: (previous?.sequence ?? 0) + 1,
        completedIds,
      }));
    }
  }
  const [applyCandidate, setApplyCandidate] = useState<LibraryWallpaper | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);

  function openGallery(source: CatalogSourceId) {
    setGalleryInterestId(null);
    setLensRequest(null);
    setGallerySource(source);
    setPage("gallery");
  }

  function searchWebForWallpaper(term: string) {
    setLensRequest(null);
    setGoogleSearchSeed(term);
    openGallery("google");
  }

  function reverseSearchSavedImage(image: LibraryWallpaper) {
    setLensRequest((previous) => ({
      imageId: image.id, requestId: (previous?.requestId || 0) + 1,
    }));
    // Do not call openGallery here: that is a normal browse action and
    // deliberately clears pending one-shot Lens uploads.
    setGallerySource("google");
    setPage("gallery");
  }

  return (
    <div className="app">
      <WindowChrome />

      <div className="layout">
        <aside className="sidebar" aria-label="Application navigation">
          <div className="side-label">Workspace</div>
          <nav className="nav">
            <button type="button" onClick={() => setPage("dashboard")}
              className={"nav-item " + (page === "dashboard" ? "current" : "")}
              aria-current={page === "dashboard" ? "page" : undefined}><SidebarIcon name="dashboard" /> <span>Dashboard</span></button>
            <button type="button" onClick={() => {
              setLensRequest(null);
              setPage("gallery");
            }}
              className={"nav-item " + (page === "gallery" ? "current" : "")}
              aria-current={page === "gallery" ? "page" : undefined}><SidebarIcon name="gallery" /> <span>Gallery</span></button>
            <button type="button" onClick={() => setPage("browser")}
              className={"nav-item " + (page === "browser" ? "current" : "")}
              aria-current={page === "browser" ? "page" : undefined}><SidebarIcon name="browser" /> <span>Browser</span></button>
            <button type="button" onClick={() => openLibrary()}
              className={"nav-item " + (page === "library" ? "current" : "")}
              aria-current={page === "library" ? "page" : undefined}><SidebarIcon name="library" /> <span>Library</span></button>
            <button type="button" onClick={() => setPage("settings")}
              className={"nav-item " + (page === "settings" ? "current" : "")}
              aria-current={page === "settings" ? "page" : undefined}><SidebarIcon name="settings" /> <span>Settings</span></button>
          </nav>
          <div className="sidebar-footer">Local-first. No accounts or telemetry.</div>
        </aside>

        <main className={"content" + (page === "browser" ? " content-browser" : "")}>
          <BrowserPage active={page === "browser"}
            blockingDialogOpen={importRequest !== null || applyCandidate !== null}
            onSaveToLibrary={beginBrowserImport}
            importCompletion={browserImportCompletion} />
          {page === "browser" ? null : page === "settings" ? (
            <SettingsPage selectedTab={settingsTab} onTabChange={setSettingsTab}
              onBrowseWallpapers={() => openGallery(gallerySource)}
              onOpenLibrary={() => openLibrary()} />
          ) : page === "library" ? (
            <LibraryPage revision={libraryRevision}
              initialTab={libraryEntryTab}
              focusWallpaperId={libraryFocusId}
              onFocusHandled={() => setLibraryFocusId(null)}
              onDiscover={() => openGallery("discover")}
              onDiscoverInterest={openInterestGallery}
              onReverseSearch={reverseSearchSavedImage}
              onSaveToLibrary={beginOtherImport} />
          ) : page === "gallery" ? (
            <OnlineGallery
              source={gallerySource}
              onSourceChange={(source) => {
                setLensRequest(null);
                setGalleryInterestId(null);
                setGallerySource(source);
              }}
              interestSeedId={galleryInterestId}
              onManageCategories={manageCategories}
              googleSearchSeed={googleSearchSeed}
              lensRequest={lensRequest}
              onSearchWeb={searchWebForWallpaper}
              onSaveToLibrary={beginOtherImport}
              blockingDialogOpen={importRequest !== null || applyCandidate !== null}
            />
          ) : (
          <DashboardPage
            onOpenAutomation={openAutomation}
            onOpenLibrary={openLibrary}
            onBrowseWallpapers={() => openGallery(gallerySource)}
            onDiscoverByCategory={() => openGallery("discover")}
          />
          )}
        </main>
      </div>
      {importRequest && (
        <LibraryImportDialog
          images={importRequest.images}
          onClose={() => setImportRequest(null)}
          onFinished={completedImport}
          onImported={() => setLibraryRevision((count) => count + 1)}
          onSetNow={(image) => {
            setImportRequest(null);
            setApplyCandidate(image);
          }}
          onOpenLibrary={() => {
            setImportRequest(null);
            openLibrary();
          }}
        />
      )}
      {applyCandidate && (
        <ApplyWallpaperDialog
          image={applyCandidate}
          onClose={() => setApplyCandidate(null)}
          onApplied={() => setLibraryRevision((count) => count + 1)}
        />
      )}
    </div>
  );
}

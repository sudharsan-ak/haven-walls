import { useState } from "react";
import { type CatalogSourceId } from "./lib/native";
import { catalogSources } from "./lib/catalog";
import WindowChrome from "./components/WindowChrome";
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
  const [page, setPage] = useState<"dashboard" | "gallery" | "browser" | "library" | "sources" | "settings">("dashboard");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("automation");
  const [libraryFocusId, setLibraryFocusId] = useState<string | null>(null);

  function openAutomation() {
    setSettingsTab("automation");
    setPage("settings");
  }
  function openLibrary(wallpaperId?: string) {
    setLibraryFocusId(wallpaperId ?? null);
    setPage("library");
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
              aria-current={page === "dashboard" ? "page" : undefined}>⌂ <span>Dashboard</span></button>
            <button type="button" onClick={() => {
              setLensRequest(null);
              setPage("gallery");
            }}
              className={"nav-item " + (page === "gallery" ? "current" : "")}
              aria-current={page === "gallery" ? "page" : undefined}>▧ <span>Gallery</span></button>
            <button type="button" onClick={() => setPage("browser")}
              className={"nav-item " + (page === "browser" ? "current" : "")}
              aria-current={page === "browser" ? "page" : undefined}>◎ <span>Browser</span></button>
            <button type="button" onClick={() => setPage("library")}
              className={"nav-item " + (page === "library" ? "current" : "")}
              aria-current={page === "library" ? "page" : undefined}>▣ <span>Library</span></button>
            <button type="button" onClick={() => setPage("sources")}
              className={"nav-item " + (page === "sources" ? "current" : "")}
              aria-current={page === "sources" ? "page" : undefined}>✧ <span>Sources</span></button>
            <button type="button" onClick={() => setPage("settings")}
              className={"nav-item " + (page === "settings" ? "current" : "")}
              aria-current={page === "settings" ? "page" : undefined}>⚙ <span>Settings</span></button>
          </nav>
          <div className="sidebar-footer">Local-first. No accounts or telemetry.</div>
        </aside>

        <main className={"content" + (page === "browser" ? " content-browser" : "")}>
          <BrowserPage active={page === "browser"}
            blockingDialogOpen={importRequest !== null || applyCandidate !== null}
            onSaveToLibrary={beginBrowserImport}
            importCompletion={browserImportCompletion} />
          {page === "browser" ? null : page === "settings" ? (
            <SettingsPage selectedTab={settingsTab} onTabChange={setSettingsTab} />
          ) : page === "library" ? (
            <LibraryPage revision={libraryRevision}
              focusWallpaperId={libraryFocusId}
              onFocusHandled={() => setLibraryFocusId(null)}
              onDiscover={() => openGallery("discover")}
              onReverseSearch={reverseSearchSavedImage}
              onSaveToLibrary={beginOtherImport} />
          ) : page === "gallery" ? (
            <OnlineGallery
              source={gallerySource}
              onSourceChange={(source) => {
                setLensRequest(null);
                setGallerySource(source);
              }}
              googleSearchSeed={googleSearchSeed}
              lensRequest={lensRequest}
              onSearchWeb={searchWebForWallpaper}
              onSaveToLibrary={beginOtherImport}
              blockingDialogOpen={importRequest !== null || applyCandidate !== null}
            />
          ) : page === "sources" ? (
            <section className="sources-page">
              <div className="eyebrow">Online image providers</div>
              <h1>Sources</h1>
              <p className="subheading">
                Browse sources individually. Automatic discovery preferences are in Settings → Automation.
              </p>
              <div className="provider-grid">
                {catalogSources.map((source) => (
                  <article className="provider-panel" key={source.id}>
                    <div className="provider-icon" aria-hidden="true">✧</div>
                    <div className="provider-info">
                      <h2>{source.name}</h2>
                      <p>{source.description}</p>
                      <p className="provider-description">{source.hint}</p>
                      <button
                        type="button"
                        onClick={() => openGallery(source.id)}
                        className="provider-link"
                      >Browse {source.name}</button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="provider-footnote">
                Wallpaper caption and photo-credit preferences are now in
                <button type="button" className="gallery-open-link"
                  onClick={() => { setSettingsTab("wallpaper"); setPage("settings"); }}>Settings</button>.
              </div>
              <p className="provider-footnote">
                These are previews, not rights-cleared wallpaper downloads. External provider
                terms, attributions and artwork permissions must be checked before applying images.
              </p>
            </section>
          ) : (
          <DashboardPage
            onOpenAutomation={openAutomation}
            onOpenLibrary={openLibrary}
            onBrowseWallpapers={() => openGallery("discover")}
            onOpenSources={() => setPage("sources")}
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

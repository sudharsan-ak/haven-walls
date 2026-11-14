import { useEffect, useState } from "react";
import { readHostInfo, type HostInfo, type CatalogSourceId } from "./lib/native";
import { catalogSources } from "./lib/catalog";
import WindowChrome from "./components/WindowChrome";
import OnlineGallery from "./components/OnlineGallery";
import SettingsPage from "./components/SettingsPage";
import LibraryPage from "./components/LibraryPage";
import LibraryImportDialog from "./components/LibraryImportDialog";
import ApplyWallpaperDialog from "./components/ApplyWallpaperDialog";
import type { CatalogImage } from "./lib/native";
import type { LibraryWallpaper } from "./lib/wallpaperLibrary";
import "./App.css";

type HostState =
  | { kind: "checking" }
  | { kind: "connected"; info: HostInfo }
  | { kind: "browser" }
  | { kind: "error"; message: string };

const upcoming = [
  { title: "Online gallery", detail: "Explore photography, TV backdrops and team artwork", icon: "▧" },
  { title: "Wallpaper Library", detail: "Save, favorite and organize images offline", icon: "▣" },
  { title: "Set wallpaper", detail: "Apply saved images to Windows displays", icon: "▤" },
  { title: "Rotation", detail: "Schedules and category preferences", icon: "↻" },
];

export default function App() {
  const [host, setHost] = useState<HostState>({ kind: "checking" });
  const [page, setPage] = useState<"dashboard" | "gallery" | "library" | "sources" | "settings">("dashboard");
  const [gallerySource, setGallerySource] = useState<CatalogSourceId>("discover");
  const [tmdbToken, setTmdbToken] = useState("");
  const [serpapiKey, setSerpapiKey] = useState("");
  const [unsplashKey, setUnsplashKey] = useState("");
  const [googleSearchSeed, setGoogleSearchSeed] = useState("");
  const [lensRequest, setLensRequest] = useState<{ imageId: string; requestId: number } | null>(null);
  const [importCandidates, setImportCandidates] = useState<CatalogImage[] | null>(null);
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

  useEffect(() => {
    let active = true;

    readHostInfo()
      .then((info) => {
        if (!active) return;
        setHost(info ? { kind: "connected", info } : { kind: "browser" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHost({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      active = false;
    };
  }, []);

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

        <main className="content">
          {page === "settings" ? (
            <SettingsPage />
          ) : page === "library" ? (
            <LibraryPage revision={libraryRevision}
              onDiscover={() => openGallery("discover")}
              onReverseSearch={reverseSearchSavedImage}
              onSaveToLibrary={setImportCandidates} />
          ) : page === "gallery" ? (
            <OnlineGallery
              source={gallerySource}
              onSourceChange={(source) => {
                setLensRequest(null);
                setGallerySource(source);
              }}
              tmdbToken={tmdbToken}
              onTmdbTokenChange={setTmdbToken}
              serpapiKey={serpapiKey}
              onSerpapiKeyChange={setSerpapiKey}
              unsplashKey={unsplashKey}
              onUnsplashKeyChange={setUnsplashKey}
              googleSearchSeed={googleSearchSeed}
              lensRequest={lensRequest}
              onSearchWeb={searchWebForWallpaper}
              onSaveToLibrary={setImportCandidates}
              blockingDialogOpen={importCandidates !== null || applyCandidate !== null}
            />
          ) : page === "sources" ? (
            <section className="sources-page">
              <div className="eyebrow">Online image providers</div>
              <h1>Sources</h1>
              <p className="subheading">
                Browse sources individually. Every lookup is manual, with no background downloads.
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
                  onClick={() => setPage("settings")}>Settings</button>.
              </div>
              <p className="provider-footnote">
                These are previews, not rights-cleared wallpaper downloads. External provider
                terms, attributions and artwork permissions must be checked before applying images.
              </p>
            </section>
          ) : (
          <>
          <div className="eyebrow">Windows app foundation</div>
          <h1>Welcome to Haven Walls</h1>
          <p className="subheading">
            A better way to discover and manage desktop wallpapers.
            Save wallpapers locally and apply them to Windows. Automatic rotation is coming later.
          </p>

          <section className="hero" aria-labelledby="foundation-title">
            <div className="hero-content">
              <span className="hero-kicker">Milestone 2 · PR #3</span>
              <h2 id="foundation-title">Find your next desktop background.</h2>
              <p>
                Discover wallpapers by Nature, Space, Animals, Cities, Sports and more.
                Inspect real source photos, then save selected images to your offline Library.
              </p>
              <div className="host-pill" role="status">
                <span
                  className={`status-dot ${host.kind === "connected" ? "good" : ""}`}
                  aria-hidden="true"
                />
                {host.kind === "checking" && "Connecting to Windows host…"}
                {host.kind === "browser" && "Browser preview (native host unavailable)"}
                {host.kind === "error" && "Native host connection failed"}
                {host.kind === "connected" && `${host.info.appName} v${host.info.version} · ${host.info.platform}`}
              </div>
              {host.kind === "error" && <p className="host-error">{host.message}</p>}
            </div>
            <div className="hero-ornament" aria-hidden="true">
              <div className="orb orb-one" />
              <div className="orb orb-two" />
            </div>
          </section>

          <div className="section-heading">
            <h2>Get started</h2>
            <span>Find, save and apply a wallpaper directly to your Windows desktop.</span>
          </div>
          <section className="preview-grid" aria-label="Upcoming features">
            {upcoming.map((item) => (
              <article className="preview-card" key={item.title}>
                <span className="preview-icon" aria-hidden="true">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
                {item.title === "Online gallery" ? (
                  <button type="button" className="gallery-open-link" onClick={() => openGallery("discover")}>Open gallery</button>
                ) : item.title === "Wallpaper Library" || item.title === "Set wallpaper" ? (
                  <button type="button" className="gallery-open-link"
                    onClick={() => setPage("library")}>
                    {item.title === "Set wallpaper" ? "Set wallpaper" : "Open Library"}
                  </button>
                ) : <span className="coming-soon">Planned</span>}
              </article>
            ))}
          </section>
          </>
          )}
        </main>
      </div>
      {importCandidates && (
        <LibraryImportDialog
          images={importCandidates}
          onClose={() => setImportCandidates(null)}
          onImported={() => setLibraryRevision((count) => count + 1)}
          onSetNow={(image) => {
            setImportCandidates(null);
            setApplyCandidate(image);
          }}
          onOpenLibrary={() => {
            setImportCandidates(null);
            setPage("library");
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

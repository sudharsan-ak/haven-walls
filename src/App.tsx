import { useEffect, useState } from "react";
import { readHostInfo, type HostInfo, type CatalogSourceId } from "./lib/native";
import { catalogSources } from "./lib/catalog";
import WindowChrome from "./components/WindowChrome";
import OnlineGallery from "./components/OnlineGallery";
import SettingsPage from "./components/SettingsPage";
import "./App.css";

type HostState =
  | { kind: "checking" }
  | { kind: "connected"; info: HostInfo }
  | { kind: "browser" }
  | { kind: "error"; message: string };

const upcoming = [
  { title: "Online gallery", detail: "Explore photography, TV backdrops and team artwork", icon: "▧" },
  { title: "Set wallpaper", detail: "Apply selected images through Windows", icon: "▣" },
  { title: "Rotation", detail: "Schedules and category preferences", icon: "↻" },
];

export default function App() {
  const [host, setHost] = useState<HostState>({ kind: "checking" });
  const [page, setPage] = useState<"dashboard" | "gallery" | "sources" | "settings">("dashboard");
  const [gallerySource, setGallerySource] = useState<CatalogSourceId>("bing");
  const [tmdbToken, setTmdbToken] = useState("");
  const [serpapiKey, setSerpapiKey] = useState("");
  const [googleSearchSeed, setGoogleSearchSeed] = useState("");

  function openGallery(source: CatalogSourceId) {
    setGallerySource(source);
    setPage("gallery");
  }

  function searchWebForWallpaper(term: string) {
    setGoogleSearchSeed(term);
    openGallery("google");
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
            <button type="button" onClick={() => setPage("gallery")}
              className={"nav-item " + (page === "gallery" ? "current" : "")}
              aria-current={page === "gallery" ? "page" : undefined}>▧ <span>Gallery</span></button>
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
          ) : page === "gallery" ? (
            <OnlineGallery
              source={gallerySource}
              onSourceChange={setGallerySource}
              tmdbToken={tmdbToken}
              onTmdbTokenChange={setTmdbToken}
              serpapiKey={serpapiKey}
              onSerpapiKeyChange={setSerpapiKey}
              googleSearchSeed={googleSearchSeed}
              onSearchWeb={searchWebForWallpaper}
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
                <article className="provider-panel provider-disabled">
                  <div className="provider-icon" aria-hidden="true">⊘</div>
                  <div className="provider-info">
                    <h2>Unsplash <span className="provider-pending">Not enabled</span></h2>
                    <p>Unsplash's API requires approval for wallpaper-app use. No API integration is enabled here.</p>
                    <p className="provider-description">We'll only enable this source if its permitted use is established.</p>
                  </div>
                </article>
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
            Online wallpaper discovery is our first priority.
          </p>

          <section className="hero" aria-labelledby="foundation-title">
            <div className="hero-content">
              <span className="hero-kicker">Milestone 1 · PR #2</span>
              <h2 id="foundation-title">Find your next desktop background.</h2>
              <p>
                Browse recent Bing photography, Earth View landscapes, sports team artwork,
                and TV show backdrops. Applying images as wallpaper is a later milestone.
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
            <h2>Coming up</h2>
            <span>Browse sources now. Applying wallpapers is coming later.</span>
          </div>
          <section className="preview-grid" aria-label="Upcoming features">
            {upcoming.map((item) => (
              <article className="preview-card" key={item.title}>
                <span className="preview-icon" aria-hidden="true">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
                {item.title === "Online gallery" ? (
                  <button type="button" className="gallery-open-link" onClick={() => openGallery("bing")}>Open gallery</button>
                ) : <span className="coming-soon">Planned</span>}
              </article>
            ))}
          </section>
          </>
          )}
        </main>
      </div>
    </div>
  );
}

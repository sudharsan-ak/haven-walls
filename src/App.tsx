import { useEffect, useState } from "react";
import { readHostInfo, type HostInfo } from "./lib/native";
import WindowChrome from "./components/WindowChrome";
import OnlineGallery from "./components/OnlineGallery";
import "./App.css";

type HostState =
  | { kind: "checking" }
  | { kind: "connected"; info: HostInfo }
  | { kind: "browser" }
  | { kind: "error"; message: string };

const upcoming = [
  { title: "Online gallery", detail: "Search and preview real Wikimedia Commons images", icon: "▧" },
  { title: "Set wallpaper", detail: "Apply selected images through Windows", icon: "▣" },
  { title: "Rotation", detail: "Schedules and category preferences", icon: "↻" },
];

export default function App() {
  const [host, setHost] = useState<HostState>({ kind: "checking" });
  const [page, setPage] = useState<"dashboard" | "gallery" | "sources">("dashboard");

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
            <span className="nav-item upcoming">⚙ <span>Settings</span><small>Soon</small></span>
          </nav>
          <div className="sidebar-footer">Local-first. No accounts or telemetry.</div>
        </aside>

        <main className="content">
          {page === "gallery" ? <OnlineGallery /> : page === "sources" ? (
            <section className="sources-page">
              <div className="eyebrow">Online image providers</div>
              <h1>Sources</h1>
              <p className="subheading">Our first supported online source is Wikimedia Commons.</p>
              <div className="provider-panel">
                <div className="provider-icon" aria-hidden="true">✧</div>
                <div>
                  <h2>Wikimedia Commons</h2>
                  <p>Public image search with dimensions and license metadata. No API key is required.</p>
                  <p>Searches happen only when you request them. No background downloads.</p>
                  <button type="button" onClick={() => setPage("gallery")} className="provider-link">Explore wallpapers</button>
                </div>
              </div>
              <p className="provider-footnote">Each file may have different attribution rules. Browsing it does not automatically approve it for wallpaper use.</p>
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
              <span className="hero-kicker">Milestone 1 · PR #1</span>
              <h2 id="foundation-title">The desktop shell is taking shape.</h2>
              <p>
                This build checks that the React interface can communicate with the
                Rust application. Gallery browsing is available now. Applying wallpaper comes in PR #3.
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
            <span>Online gallery is ready to explore</span>
          </div>
          <section className="preview-grid" aria-label="Upcoming features">
            {upcoming.map((item) => (
              <article className="preview-card" key={item.title}>
                <span className="preview-icon" aria-hidden="true">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
                {item.title === "Online gallery" ? (
                  <button type="button" className="gallery-open-link" onClick={() => setPage("gallery")}>Open gallery</button>
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

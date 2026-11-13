import { useEffect, useState } from "react";
import { readHostInfo, type HostInfo } from "./lib/native";
import "./App.css";

type HostState =
  | { kind: "checking" }
  | { kind: "connected"; info: HostInfo }
  | { kind: "browser" }
  | { kind: "error"; message: string };

const upcoming = [
  { title: "Online gallery", detail: "Browse approved wallpaper sources", icon: "▧" },
  { title: "Set wallpaper", detail: "Apply selected images through Windows", icon: "▣" },
  { title: "Rotation", detail: "Schedules and category preferences", icon: "↻" },
];

export default function App() {
  const [host, setHost] = useState<HostState>({ kind: "checking" });

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
      <header className="topbar">
        <div className="identity">
          <div className="brand-mark" aria-hidden="true">H</div>
          <span>Haven Walls</span>
        </div>
        <span className="app-version">Foundation · v0.1.0</span>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="Application navigation">
          <div className="side-label">Workspace</div>
          <nav className="nav">
            <span className="nav-item current" aria-current="page">⌂ <span>Dashboard</span></span>
            <span className="nav-item upcoming">▧ <span>Gallery</span><small>Soon</small></span>
            <span className="nav-item upcoming">✧ <span>Sources</span><small>Soon</small></span>
            <span className="nav-item upcoming">⚙ <span>Settings</span><small>Soon</small></span>
          </nav>
          <div className="sidebar-footer">Local-first. No accounts or telemetry.</div>
        </aside>

        <main className="content">
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
                Rust application. Real wallpaper browsing and applying arrive in later PRs.
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
            <span>Features are intentionally inactive in this scaffold</span>
          </div>
          <section className="preview-grid" aria-label="Upcoming features">
            {upcoming.map((item) => (
              <article className="preview-card" key={item.title}>
                <span className="preview-icon" aria-hidden="true">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
                <span className="coming-soon">Planned</span>
              </article>
            ))}
          </section>
        </main>
      </div>
    </div>
  );
}

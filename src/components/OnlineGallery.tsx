import { useEffect, useRef, useState, type FormEvent } from "react";
import { searchOnlineWallpapers, type WallpaperCandidate } from "../lib/native";
import "./OnlineGallery.css";

type Status = "idle" | "loading" | "success" | "error";
const topics = ["Nature landscape", "Mountain sunset", "Architecture cityscape", "Nebula galaxy"];

export default function OnlineGallery() {
  const [query, setQuery] = useState("Nature landscape");
  const [submitted, setSubmitted] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<WallpaperCandidate[]>([]);
  const [scanned, setScanned] = useState(0);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WallpaperCandidate | null>(null);
  const [copied, setCopied] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  async function search(value: string) {
    const term = value.trim();
    if (term.length < 2 || term.length > 70) {
      setError("Enter between 2 and 70 characters.");
      setStatus("error");
      return;
    }
    const currentId = ++requestId.current;
    setSubmitted(term);
    setStatus("loading");
    setResults([]);
    setScanned(0);
    setError("");

    try {
      const data = await searchOnlineWallpapers(term);
      if (currentId !== requestId.current) return;
      setResults(data.items);
      setScanned(data.scanned);
      setStatus("success");
    } catch (cause) {
      if (currentId !== requestId.current) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search(query);
  }

  async function copySource() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.pageUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="gallery-page">
      <div className="eyebrow">Online discovery · Wikimedia Commons</div>
      <h1>Explore wallpapers</h1>
      <p className="subheading">
        Find high-resolution images from Wikimedia Commons.
        Previews only for now. No wallpaper downloads or desktop changes.
      </p>

      <section className="online-search-panel" aria-label="Search online wallpapers">
        <form onSubmit={onSubmit}>
          <label htmlFor="online-search">Search for a subject or location</label>
          <div className="online-input-row">
            <input id="online-search" type="search" maxLength={70} value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try mountain landscape" />
            <button className="online-primary" type="submit" disabled={status === "loading"}>
              {status === "loading" ? "Searching…" : "Search wallpapers"}
            </button>
          </div>
        </form>
        <div className="online-suggestions">
          <span>Try</span>
          {topics.map((topic) => (
            <button key={topic} type="button" className="online-chip"
              onClick={() => { setQuery(topic); void search(topic); }}
              disabled={status === "loading"}>{topic}</button>
          ))}
        </div>
      </section>

      <div className="online-results-heading">
        <div>
          <h2>{status === "idle" ? "Start with a search" : "Results for “" + submitted + "”"}</h2>
          <p>
            {status === "success"
              ? results.length + " previews from " + scanned + " scanned files · 1080p+ landscape"
              : "Search manually. Results are screened for landscape resolution and file type."}
          </p>
        </div>
        <span className="online-source-tag">Wikimedia Commons</span>
      </div>

      {status === "idle" && (
        <div className="online-empty">
          <div className="online-empty-icon" aria-hidden="true">▧</div>
          <h3>Your next wallpaper is out there.</h3>
          <p>Choose a topic or type your own search to browse online images.</p>
        </div>
      )}
      {status === "loading" && (
        <div className="online-empty" role="status">
          <span className="online-loading" aria-hidden="true" />
          <h3>Searching Wikimedia Commons</h3>
          <p>Checking image dimensions and reported licensing data…</p>
        </div>
      )}
      {status === "error" && (
        <div className="online-empty online-error" role="alert">
          <h3>Couldn't finish searching</h3>
          <p>{error}</p>
          <button type="button" className="online-secondary"
            onClick={() => void search(query)}>Try again</button>
        </div>
      )}
      {status === "success" && results.length === 0 && (
        <div className="online-empty">
          <h3>No suitable images found</h3>
          <p>Try a broader term such as 'Swiss Alps landscape'. Only supported high-resolution landscape images are shown; licensing must be checked before downloading.</p>
        </div>
      )}
      {status === "success" && results.length > 0 && (
        <section className="online-grid" aria-label="Wallpaper results">
          {results.map((image) => (
            <button className="online-tile" type="button" key={image.id}
              onClick={() => { setSelected(image); setCopied(false); }}
              aria-label={"Preview " + image.title}>
              <div className="online-tile-photo">
                <img src={image.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                <span className="online-resolution">
                  {image.width >= 3840 && image.height >= 2160 ? "4K+" : "1080p+"}
                </span>
              </div>
              <div className="online-tile-meta">
                <strong title={image.title}>{image.title}</strong>
                <span>{image.width} × {image.height} · {image.license}</span>
              </div>
            </button>
          ))}
        </section>
      )}

      <p className="online-notice">
        Some previews may show 'License needs verification'. All rights must be checked on Wikimedia Commons before any download or wallpaper use.
        Check each image's original file page for creator credit, attribution rules, and limitations.
      </p>

      {selected && (
        <div className="online-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <section className="online-detail" role="dialog" aria-modal="true" aria-label={"Preview " + selected.title}>
            <div className="online-detail-image">
              <img src={selected.thumbnailUrl} alt={selected.title} />
              <button className="online-close" type="button" onClick={() => setSelected(null)}
                aria-label="Close preview">×</button>
            </div>
            <div className="online-detail-footer">
              <div>
                <h2>{selected.title}</h2>
                <p>{selected.source} · {selected.width} × {selected.height} · Reported license: {selected.license}</p>
                <p>Use the original file page to check the creator and required attribution.</p>
              </div>
              <button className="online-secondary" type="button" onClick={() => void copySource()}>
                {copied ? "Source link copied" : "Copy source link"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

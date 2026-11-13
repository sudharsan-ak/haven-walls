import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  browseTMDBBackdrops,
  browseWallpaperSource,
  browseGoogleImages,
  type CatalogImage,
  type CatalogSourceId,
} from "../lib/native";
import { catalogSources, getCatalogSource } from "../lib/catalog";
import FullResolutionPreview from "./FullResolutionPreview";
import GoogleWorkspace from "./GoogleWorkspace";
import "./OnlineGallery.css";

type Status = "idle" | "loading" | "success" | "error";

type Props = {
  source: CatalogSourceId;
  onSourceChange: (value: CatalogSourceId) => void;
  tmdbToken: string;
  onTmdbTokenChange: (value: string) => void;
  serpapiKey: string;
  onSerpapiKeyChange: (value: string) => void;
  googleSearchSeed: string;
  onSearchWeb: (query: string) => void;
};

function CatalogThumbnail({ image }: { image: CatalogImage }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="online-tile-photo">
      {failed ? (
        <div className="online-photo-fallback" role="img" aria-label="Preview unavailable">
          <span>▧</span>
          <small>Preview unavailable</small>
        </div>
      ) : (
        <img
          src={image.previewUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
      <span className="online-resolution">
        {image.kind === "tv-show"
          ? "TV series"
          : image.width >= 3840 && image.height >= 2160
            ? "4K+"
            : image.width >= 1920 && image.height >= 1080
              ? "1080p+"
              : "Artwork"}
      </span>
    </div>
  );
}

function SourceGallery({
  source,
  onSourceChange,
  tmdbToken,
  onTmdbTokenChange,
  serpapiKey,
  onSerpapiKeyChange,
  googleSearchSeed,
  onSearchWeb,
}: Props) {
  const config = getCatalogSource(source);
  const [query, setQuery] = useState(config.defaultQuery);
  const [submitted, setSubmitted] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<CatalogImage[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CatalogImage | null>(null);
  const [selectedShow, setSelectedShow] = useState<CatalogImage | null>(null);
  const [shows, setShows] = useState<CatalogImage[]>([]);
  const [showSearchNote, setShowSearchNote] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [minimumSize, setMinimumSize] = useState<"1080p" | "1440p" | "4K">("1080p");
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setQuery(source === "google" && googleSearchSeed
      ? googleSearchSeed
      : getCatalogSource(source).defaultQuery);
    setSubmitted("");
    setStatus("idle");
    setResults([]);
    setNote("");
    setError("");
    setSelected(null);
    setSelectedShow(null);
    setShows([]);
    setShowSearchNote("");
  }, [source, googleSearchSeed]);

  async function lookup(term: string) {
    const clean = term.trim();
    if (source !== "bing" && source !== "earth" && clean.length < 2) {
      setError("Enter at least two characters to search.");
      setStatus("error");
      return;
    }
    if (source === "tmdb" && !tmdbToken.trim()) {
      setError("Enter your TMDB API Read Access Token before searching TV shows.");
      setStatus("error");
      return;
    }
    if (source === "google" && !serpapiKey.trim()) {
      setError("Enter your personal SerpApi key to retrieve Google Images results inside the app.");
      setStatus("error");
      return;
    }
    const request = ++requestId.current;
    setSubmitted(clean);
    setResults([]);
    setNote("");
    setError("");
    setSelectedShow(null);
    setShows([]);
    setStatus("loading");

    try {
      const resolution = minimumSize === "4K" ? [3840, 2160]
        : minimumSize === "1440p" ? [2560, 1440] : [1920, 1080];
      const data = source === "google"
        ? await browseGoogleImages(clean, serpapiKey.trim(), resolution[0], resolution[1])
        : await browseWallpaperSource(
            source,
            clean,
            source === "tmdb" ? tmdbToken.trim() : undefined,
          );
      if (request !== requestId.current) return;
      setResults(data.items);
      setNote(data.note);
      if (source === "tmdb") {
        setShows(data.items);
        setShowSearchNote(data.note);
      }
      setStatus("success");
    } catch (cause) {
      if (request !== requestId.current) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function openShow(show: CatalogImage) {
    if (source !== "tmdb" || !tmdbToken.trim()) return;
    const id = Number(show.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError("This show has an invalid provider ID.");
      setStatus("error");
      return;
    }
    const request = ++requestId.current;
    setSelectedShow(show);
    setStatus("loading");
    setResults([]);
    setError("");
    setNote("");

    try {
      const data = await browseTMDBBackdrops(id, tmdbToken.trim());
      if (request !== requestId.current) return;
      setResults(data.items);
      setNote(data.note);
      setStatus("success");
    } catch (cause) {
      if (request !== requestId.current) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function backToShows() {
    requestId.current += 1;
    setSelectedShow(null);
    setResults(shows);
    setNote(showSearchNote);
    setError("");
    setStatus("success");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void lookup(query);
  }

  return (
    <div className="gallery-page">
      <div className="eyebrow">Online wallpaper discovery</div>
      <h1>Explore wallpapers</h1>
      <p className="subheading">
        Browse real provider images. Images are previews only, not downloaded or applied.
      </p>

      <div className="online-source-picker" aria-label="Wallpaper sources">
        {catalogSources.map((item) => (
          <button
            key={item.id}
            type="button"
            className={"online-source-option " + (source === item.id ? "active" : "")}
            aria-pressed={source === item.id}
            onClick={() => onSourceChange(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>

      <section className="online-search-panel" aria-label="Browse online images">
        <div className="online-provider-heading">
          <h2>{config.name}</h2>
          <p>{config.description}</p>
        </div>

        <form onSubmit={onSubmit}>
          {source !== "bing" && (
            <>
              <label htmlFor="online-search">
                {source === "earth" ? "Filter by country or region (optional)"
                  : source === "sports" ? "Team name"
                    : source === "google" ? "Search Google Images for wallpapers"
                      : "TV show title"}
              </label>
              <div className="online-input-row">
                <input
                  id="online-search"
                  type="search"
                  maxLength={100}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={source === "earth" ? "e.g. Switzerland"
                    : source === "google" ? "e.g. Golden State Warriors 4K wallpaper"
                      : "Enter a name"}
                />
              </div>
            </>
          )}

          {source === "google" && (
            <div className="online-token-field">
              <label htmlFor="serpapi-key">SerpApi key for Google Images</label>
              <div className="online-input-row">
                <input
                  id="serpapi-key"
                  type={revealed ? "text" : "password"}
                  spellCheck={false}
                  autoComplete="off"
                  value={serpapiKey}
                  onChange={(event) => onSerpapiKeyChange(event.target.value)}
                  placeholder="Paste your SerpApi API key"
                />
                <button type="button" className="online-secondary"
                  onClick={() => setRevealed(!revealed)}>
                  {revealed ? "Hide" : "Show"}
                </button>
              </div>
              <small>
                SerpApi offers a limited free plan. The key stays in app memory and is sent
                directly to SerpApi when you search. It is not saved in Haven Walls.
                This is not an official Google API.
              </small>
              <div className="online-filter-row">
                <label htmlFor="google-min-resolution">Minimum reported image resolution</label>
                <select
                  id="google-min-resolution"
                  value={minimumSize}
                  onChange={(event) => setMinimumSize(event.target.value as "1080p" | "1440p" | "4K")}
                >
                  <option value="1080p">1920 × 1080 (1080p+)</option>
                  <option value="1440p">2560 × 1440 (1440p+)</option>
                  <option value="4K">3840 × 2160 (4K+)</option>
                </select>
              </div>
            </div>
          )}

          {config.requiresToken && source === "tmdb" && (
            <div className="online-token-field">
              <label htmlFor="tmdb-token">TMDB API Read Access Token</label>
              <div className="online-input-row">
                <input
                  id="tmdb-token"
                  type={revealed ? "text" : "password"}
                  spellCheck={false}
                  autoComplete="off"
                  value={tmdbToken}
                  onChange={(event) => onTmdbTokenChange(event.target.value)}
                  placeholder="Paste your own TMDB read token"
                />
                <button
                  type="button"
                  className="online-secondary"
                  onClick={() => setRevealed(!revealed)}
                  aria-label={revealed ? "Hide API token" : "Show API token"}
                >
                  {revealed ? "Hide" : "Show"}
                </button>
              </div>
              <small>
                Create a token in your TMDB account settings. Haven Walls only holds it in
                memory while the app is open. It is not saved to disk.
              </small>
            </div>
          )}

          <div className="online-search-actions">
            <button className="online-primary" type="submit" disabled={status === "loading"}>
              {status === "loading" ? "Loading…" : config.action}
            </button>
            <span>{config.hint}</span>
          </div>
        </form>

        {config.suggestions.length > 0 && (
          <div className="online-suggestions" aria-label="Suggested searches">
            <span>Try</span>
            {config.suggestions.map((topic) => (
              <button
                key={topic}
                type="button"
                className="online-chip"
                disabled={status === "loading"}
                onClick={() => {
                  setQuery(topic);
                  void lookup(topic);
                }}
              >
                {topic}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="online-results-heading">
        <div>
          {selectedShow && (
            <button type="button" className="online-back" onClick={backToShows}>
              ‹ Back to TV show results
            </button>
          )}
          <h2>
            {selectedShow
              ? "Backdrops: " + selectedShow.title
              : status === "idle"
                ? source === "bing" ? "Recent daily photos" : "Ready to browse"
                : "Results" + (submitted && source !== "bing" ? " for “" + submitted + "”" : "")}
          </h2>
          <p>{status === "success" ? results.length + " items returned" : "Select a source and load its images."}</p>
        </div>
        <span className="online-source-tag">{config.name}</span>
      </div>

      {status === "idle" && (
        <div className="online-empty">
          <div className="online-empty-icon" aria-hidden="true">▧</div>
          <h3>{source === "bing" ? "See the latest Bing photos." : "Explore " + config.name + "."}</h3>
          <p>{config.hint}</p>
        </div>
      )}
      {status === "loading" && (
        <div className="online-empty" role="status">
          <span className="online-loading" aria-hidden="true" />
          <h3>{selectedShow ? "Loading TV backdrops…" : "Loading " + config.name + "…"}</h3>
          <p>Fetching preview information from the selected source.</p>
        </div>
      )}
      {status === "error" && (
        <div className="online-empty online-error" role="alert">
          <h3>Couldn't load this source</h3>
          <p>{error}</p>
          {selectedShow ? (
            <button type="button" className="online-secondary" onClick={backToShows}>
              Back to shows
            </button>
          ) : (
            <button type="button" className="online-secondary" onClick={() => void lookup(query)}>
              Retry
            </button>
          )}
        </div>
      )}
      {status === "success" && results.length === 0 && (
        <div className="online-empty">
          <h3>No images matched</h3>
          <p>
            {selectedShow
              ? "No suitable landscape backdrops found for this show. Try another."
              : source === "earth"
                ? "Try a different region or clear the location for a mixed selection."
                : "Try another team or TV show, or switch to a different source."}
          </p>
        </div>
      )}
      {status === "success" && results.length > 0 && (
        <section className="online-grid" aria-label="Online image results">
          {results.map((image) => (
            <button
              className={"online-tile " + (image.kind === "tv-show" ? "poster-tile" : "")}
              type="button"
              key={image.id}
              onClick={() => {
                if (image.kind === "tv-show") {
                  void openShow(image);
                } else {
                  setSelected(image);
                }
              }}
              aria-label={(image.kind === "tv-show" ? "Browse backdrops for " : "Preview ") + image.title}
            >
              <CatalogThumbnail key={image.previewUrl} image={image} />
              <div className="online-tile-meta">
                <strong title={image.title}>{image.title}</strong>
                <span>
                  {image.kind === "tv-show" ? "Select to view backdrops"
                    : image.width > 0 && image.height > 0
                      ? image.width + " × " + image.height
                      : "Dimensions not supplied"}
                  {" · " + image.source}
                </span>
              </div>
            </button>
          ))}
        </section>
      )}

      {(source === "sports" || source === "tmdb") &&
        status !== "idle" && status !== "loading" &&
        (selectedShow || submitted) && (
          <div className="online-web-discovery">
            <div>
              <strong>Need more wallpaper choices?</strong>
              <p>Search beyond official show artwork or team badges using Google Images.
                Images will be screened for desktop resolution and orientation.</p>
            </div>
            <button
              className="online-secondary"
              type="button"
              onClick={() => onSearchWeb(
                (selectedShow?.title || submitted) +
                (source === "tmdb" ? " TV show 4K desktop wallpaper" : " team 4K desktop wallpaper")
              )}
            >
              Search Google Images
            </button>
          </div>
        )}
      {status === "success" && note && <p className="online-catalog-note">{note}</p>}
      <p className="online-notice">
        Photos, team artwork and TV backdrops belong to their respective rights holders.
        Previewing an image does not grant permission to download, redistribute, or apply it.
        Review the source's terms and licensing before use.
      </p>

      {selected && (
        <FullResolutionPreview
          key={selected.previewUrl}
          image={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}


// Google Images alone has nested Browser and API tabs.
// All other source pages continue to use the existing Gallery view.
export default function OnlineGallery(props: Props) {
  if (props.source === "google") {
    return (
      <GoogleWorkspace
        onSourceChange={props.onSourceChange}
        serpapiKey={props.serpapiKey}
        onSerpapiKeyChange={props.onSerpapiKeyChange}
        googleSearchSeed={props.googleSearchSeed}
      />
    );
  }
  return <SourceGallery {...props} />;
}

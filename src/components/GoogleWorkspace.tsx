import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  browseGoogleImages,
  type CatalogImage,
  type CatalogSourceId,
} from "../lib/native";
import { catalogSources, getCatalogSource } from "../lib/catalog";
import FullResolutionPreview from "./FullResolutionPreview";
import InlineGoogleBrowser from "./InlineGoogleBrowser";
import "./GoogleWorkspace.css";

interface Props {
  onSourceChange: (value: CatalogSourceId) => void;
  serpapiKey: string;
  onSerpapiKeyChange: (value: string) => void;
  googleSearchSeed: string;
}

type SearchMode = "browser" | "api";
type SearchStatus = "idle" | "loading" | "success" | "error";
type Resolution = "1080p" | "1440p" | "4K";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_QUERY = getCatalogSource("google").defaultQuery;

function imageKey(item: CatalogImage): string {
  return item.originalUrl || item.previewUrl;
}

function directHttpsImageAddress(value: string): string | null {
  try {
    const uri = new URL(value.trim());
    if (uri.protocol !== "https:" || !uri.hostname || uri.username || uri.password ||
        uri.hostname === "localhost" || uri.hostname.endsWith(".localhost") ||
        uri.hostname.endsWith(".local") || uri.hostname.endsWith(".internal")) {
      return null;
    }
    return uri.toString();
  } catch {
    return null;
  }
}

function makeManualImage(url: string, title: string, fromFile: boolean): CatalogImage {
  return {
    id: "user-" + title,
    source: fromFile ? "Local file preview" : "Google browser selection",
    title,
    originalUrl: url,
    previewUrl: url,
    pageUrl: "",
    credit: fromFile ? "File on your computer" : "Source page not supplied",
    rights: fromFile
      ? "Preview only. This image has not been added to the Haven Walls library."
      : "Google Images is a discovery tool. Image rights and attribution must be checked at the original source.",
    width: 0,
    height: 0,
    kind: "image",
  };
}

function ReviewQueue({
  items, onRemove, onClear, onInspect,
}: {
  items: CatalogImage[];
  onRemove: (item: CatalogImage) => void;
  onClear: () => void;
  onInspect: (item: CatalogImage) => void;
}) {
  return (
    <aside className="gws-review" aria-label="Shared Google Images review selection">
      <div className="gws-review-head">
        <strong>Review selection</strong>
        <span>{items.length} selected</span>
      </div>
      <p>Each image you add stays here across both subtabs. Click any item to inspect its original size.</p>
      <div className="gws-review-list">
        {items.length === 0 ? (
          <div className="gws-review-empty">
            <strong>No images selected yet</strong>
            <span>
              In Browser Search, copy an image address and import it.
              In API Search, click the + on a result.
            </span>
          </div>
        ) : items.map((item) => (
          <div className="gws-review-item" key={imageKey(item)}>
            <button type="button" className="gws-review-thumb"
              onClick={() => onInspect(item)} title={"Inspect " + item.title}>
              <img src={item.previewUrl} alt="" referrerPolicy="no-referrer" />
            </button>
            <button type="button" className="gws-review-name"
              onClick={() => onInspect(item)} title={item.title}>
              <strong>{item.title}</strong>
              <small>{item.source} · Not verified</small>
            </button>
            <button type="button" className="gws-review-remove"
              aria-label={"Remove " + item.title} onClick={() => onRemove(item)}>×</button>
          </div>
        ))}
      </div>
      <div className="gws-review-actions">
        <button className="online-primary" type="button" disabled={items.length === 0}
          onClick={() => onInspect(items[0])}>
          Inspect first image
        </button>
        <button className="online-secondary" type="button" disabled={items.length === 0}
          onClick={onClear}>
          Clear selection ({items.length})
        </button>
        <button className="online-secondary" type="button" disabled>
          Add to library · PR #3
        </button>
      </div>
      <p className="gws-review-footnote">
        Clear selection removes the review list only. It does not delete downloaded files,
        reset Google search, or change your wallpaper.
      </p>
    </aside>
  );
}

function ApiResultCard({
  image, selected, onToggle, onPreview,
}: {
  image: CatalogImage;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={"gws-api-tile " + (selected ? "selected" : "")}>
      <button type="button" className="gws-api-tile-image"
        onClick={onToggle} aria-pressed={selected}
        aria-label={(selected ? "Remove from selection: " : "Select: ") + image.title}>
        {broken ? (
          <span className="gws-tile-missing">Preview unavailable</span>
        ) : (
          <img src={image.previewUrl} alt="" loading="lazy"
            referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        )}
        <span className="gws-image-mark">{selected ? "✓" : "+"}</span>
        <span className="gws-image-size">
          {image.width >= 3840 && image.height >= 2160 ? "4K+" : "1080p+"}
        </span>
      </button>
      <div className="gws-api-tile-info">
        <strong title={image.title}>{image.title}</strong>
        <span>{image.width} × {image.height} · Reported size</span>
        <button type="button" className="gws-preview-link" onClick={onPreview}>
          Inspect original
        </button>
      </div>
    </div>
  );
}

export default function GoogleWorkspace({
  onSourceChange, serpapiKey, onSerpapiKeyChange, googleSearchSeed,
}: Props) {
  const [mode, setMode] = useState<SearchMode>("browser");
  const [browserQuery, setBrowserQuery] = useState(googleSearchSeed || DEFAULT_QUERY);
  const [apiQuery, setApiQuery] = useState(googleSearchSeed || DEFAULT_QUERY);
  const [browserRevision, setBrowserRevision] = useState(0);
  const [browserZoom, setBrowserZoom] = useState(100);
  const [browserHeight, setBrowserHeight] = useState(490);
  const [browserError, setBrowserError] = useState("");
  const [browserNote, setBrowserNote] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [lastFileSelection, setLastFileSelection] = useState("No images chosen");
  const [queue, setQueue] = useState<CatalogImage[]>([]);
  const [preview, setPreview] = useState<CatalogImage | null>(null);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [minResolution, setMinResolution] = useState<Resolution>("4K");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [apiResults, setApiResults] = useState<CatalogImage[]>([]);
  const [apiNote, setApiNote] = useState("");
  const [apiError, setApiError] = useState("");
  const requestNumber = useRef(0);
  const blobUrls = useRef(new Set<string>());

  useEffect(() => {
    if (!googleSearchSeed) return;
    setBrowserQuery(googleSearchSeed);
    setApiQuery(googleSearchSeed);
  }, [googleSearchSeed]);

  useEffect(() => () => {
    requestNumber.current += 1;
    blobUrls.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrls.current.clear();
  }, []);

  function addToQueue(image: CatalogImage) {
    setQueue((items) => items.some((existing) => imageKey(existing) === imageKey(image))
      ? items
      : [...items, image].slice(0, 30));
  }

  function toggleFromApi(image: CatalogImage) {
    const key = imageKey(image);
    setQueue((items) => {
      if (items.some((existing) => imageKey(existing) === key)) {
        return items.filter((existing) => imageKey(existing) !== key);
      }
      return [...items, image].slice(0, 30);
    });
  }

  function removeFromQueue(image: CatalogImage) {
    setQueue((items) => items.filter((item) => imageKey(item) !== imageKey(image)));
    const key = imageKey(image);
    if (blobUrls.current.has(key)) {
      blobUrls.current.delete(key);
      URL.revokeObjectURL(key);
    }
  }

  function clearQueue() {
    setQueue([]);
    blobUrls.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrls.current.clear();
  }

  function importImageAddress(value: string) {
    const url = directHttpsImageAddress(value);
    if (!url) {
      setSelectionError("Copy a direct HTTPS image address, not a Google search or source page URL.");
      return;
    }
    const label = (() => {
      try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "Web image"); }
      catch { return "Web image"; }
    })();
    const image = makeManualImage(url, label.slice(0, 140), false);
    addToQueue(image);
    setSelectionError("");
    setBrowserNote("Image address added to Review selection. Inspect it to check the actual loaded pixels.");
    setImportUrl("");
  }

  async function importClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      importImageAddress(text);
    } catch {
      setSelectionError("Clipboard access is unavailable. Paste the copied image address in the field below.");
    }
  }

  function importLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    const availableSlots = Math.max(0, 30 - queue.length);
    const accepted: CatalogImage[] = [];
    let rejected = 0;

    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)
        || file.size === 0 || file.size > MAX_FILE_BYTES
        || accepted.length >= availableSlots) {
        rejected += 1;
        continue;
      }
      const url = URL.createObjectURL(file);
      blobUrls.current.add(url);
      accepted.push(makeManualImage(url, file.name, true));
    }

    if (accepted.length > 0) {
      setQueue((current) => [...current, ...accepted].slice(0, 30));
      setBrowserNote(
        accepted.length + (accepted.length === 1
          ? " local image added to Review selection."
          : " local images added to Review selection.") +
        " No wallpaper library files were created."
      );
    }
    setLastFileSelection(
      accepted.length > 0
        ? accepted.length + (accepted.length === 1 ? " image added" : " images added")
        : "No images added"
    );
    setSelectionError(
      rejected > 0
        ? rejected + (rejected === 1 ? " file was skipped." : " files were skipped.") +
          " Only JPG, PNG or WebP images up to 32 MB are accepted, with a 30-image review limit."
        : ""
    );
  }

  function browseGoogle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = browserQuery.trim();
    if (term.length < 2 || term.length > 100) {
      setBrowserError("Enter a Google Images search between 2 and 100 characters.");
      return;
    }
    setBrowserError("");
    setBrowserNote("");
    setBrowserRevision((value) => value + 1);
  }

  async function copyGoogleSearchLink() {
    const term = browserQuery.trim();
    if (!term) return;
    const link = "https://www.google.com/search?tbm=isch&safe=active&q=" +
      encodeURIComponent(term);
    try {
      await navigator.clipboard.writeText(link);
      setBrowserNote("Google Images search link copied. You can also use your regular browser.");
    } catch {
      setBrowserError("Could not copy the search link.");
    }
  }

  async function searchApi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = apiQuery.trim();
    if (term.length < 2 || term.length > 100) {
      setApiError("Enter a search between 2 and 100 characters.");
      setStatus("error");
      return;
    }
    if (!serpapiKey.trim()) {
      setApiSettingsOpen(true);
      setApiError("Add your SerpApi key under API settings to run an API search.");
      setStatus("error");
      return;
    }
    const request = ++requestNumber.current;
    const resolution = minResolution === "4K" ? [3840, 2160] :
      minResolution === "1440p" ? [2560, 1440] : [1920, 1080];
    setStatus("loading");
    setApiResults([]);
    setApiNote("");
    setApiError("");

    try {
      const result = await browseGoogleImages(
        term, serpapiKey.trim(), resolution[0], resolution[1],
      );
      if (request !== requestNumber.current) return;
      setApiResults(result.items);
      setApiNote(result.note);
      setStatus("success");
    } catch (cause) {
      if (request !== requestNumber.current) return;
      setApiError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }

  function switchMode(value: SearchMode) {
    if (value === mode) return;
    requestNumber.current += 1;
    if (status === "loading") setStatus("idle");
    setMode(value);
  }

  return (
    <div className="gallery-page gws-page">
      <div className="eyebrow">Online discovery / Google Images</div>
      <h1>Discover your next wallpaper</h1>
      <p className="subheading">
        Two ways to find images, one place to select candidates. Inspect quality before
        moving anything into your wallpaper library.
      </p>

      <div className="online-source-picker" aria-label="Wallpaper sources">
        {catalogSources.map((item) => (
          <button key={item.id} type="button"
            className={"online-source-option " + (item.id === "google" ? "active" : "")}
            aria-pressed={item.id === "google"}
            onClick={() => onSourceChange(item.id)}>
            {item.name}
          </button>
        ))}
      </div>

      <div className="gws-subtabs" role="tablist" aria-label="Google Images search method">
        <button type="button" role="tab" aria-selected={mode === "browser"}
          className={"gws-subtab " + (mode === "browser" ? "active" : "")}
          onClick={() => switchMode("browser")}>
          <span className="gws-tab-icon">◎</span>
          <span><strong>Browser Search</strong><small>Embedded Google Images · No API key</small></span>
        </button>
        <button type="button" role="tab" aria-selected={mode === "api"}
          className={"gws-subtab " + (mode === "api" ? "active" : "")}
          onClick={() => switchMode("api")}>
          <span className="gws-tab-icon">⌕</span>
          <span><strong>API Search</strong><small>Filtered results · SerpApi (optional)</small></span>
        </button>
      </div>

      {mode === "browser" ? (
        <section role="tabpanel" aria-label="Browser Search" className="gws-panel">
          <div className="gws-search-card">
            <div className="gws-search-card-heading">
              <strong>Search directly on Google Images</strong>
              <small>Browse within Haven Walls · No separate app window</small>
            </div>
            <form className="gws-search-form" onSubmit={browseGoogle}>
              <input type="search" value={browserQuery} maxLength={100}
                onChange={(event) => setBrowserQuery(event.target.value)}
                aria-label="Search Google Images" placeholder="Find a wallpaper subject…" />
              <button type="submit" className="online-primary">Search Google Images</button>
            </form>
            <div className="online-suggestions">
              <span>Try</span>
              {["Golden State Warriors 4K wallpaper", "Landman TV series background",
                "Switzerland Alps landscape wallpaper"].map((term) => (
                <button className="online-chip" type="button" key={term}
                  onClick={() => { setBrowserQuery(term); setBrowserRevision((v) => v + 1); }}>
                  {term.startsWith("Golden") ? "Warriors" : term.startsWith("Landman") ? "Landman" : "Swiss Alps"}
                </button>
              ))}
            </div>
            {browserError && <p className="gws-error" role="alert">{browserError}</p>}
            {browserNote && <p className="gws-info" role="status">{browserNote}</p>}
          </div>

          <div className="gws-workbench">
            <div className="gws-browser-column">
              <div className="gws-browser-frame">
                <div className="gws-browser-toolbar">
                  <span className="gws-browser-dots" aria-hidden="true">● ● ●</span>
                  <span className="gws-address">google.com / search / Images</span>
                  <div className="gws-browser-controls" aria-label="Embedded browser display settings">
                    <div className="gws-zoom-controls" role="group" aria-label="Google page zoom">
                      <button type="button" title="Zoom out Google Images" aria-label="Zoom out Google Images"
                        disabled={browserZoom <= 70}
                        onClick={() => setBrowserZoom((value) => Math.max(70, value - 10))}>−</button>
                      <button type="button" className="gws-zoom-value" title="Reset Google page zoom to 100%"
                        aria-label={`Google page zoom ${browserZoom}%. Reset to 100%`}
                        onClick={() => setBrowserZoom(100)}>{browserZoom}%</button>
                      <button type="button" title="Zoom in Google Images" aria-label="Zoom in Google Images"
                        disabled={browserZoom >= 150}
                        onClick={() => setBrowserZoom((value) => Math.min(150, value + 10))}>+</button>
                    </div>
                    <label className="gws-viewport-control">
                      <span>View</span>
                      <select aria-label="Embedded browser viewing area height"
                        value={browserHeight}
                        onChange={(event) => setBrowserHeight(Number(event.target.value))}>
                        <option value={420}>Compact</option>
                        <option value={490}>Normal</option>
                        <option value={680}>Tall</option>
                      </select>
                    </label>
                  </div>
                </div>
                <InlineGoogleBrowser query={browserQuery} searchRevision={browserRevision}
                  obscured={preview !== null} zoom={browserZoom / 100}
                  viewportHeight={browserHeight} onError={setBrowserError} />
                <div className="gws-browser-bottom">
                  <span>Google clicks open Google's preview. To select: right-click the larger image → Copy image address.</span>
                  <button type="button" className="online-secondary"
                    onClick={() => void importClipboard()}>
                    Add copied image
                  </button>
                </div>
              </div>

              <details className="gws-manual">
                <summary>Alternative: Paste an image address or choose a downloaded file</summary>
                <div className="gws-manual-grid">
                  <form onSubmit={(event) => { event.preventDefault(); importImageAddress(importUrl); }}>
                    <label htmlFor="gws-image-url">Direct HTTPS image URL</label>
                    <div className="gws-manual-input">
                      <input id="gws-image-url" type="url" value={importUrl} maxLength={4000}
                        onChange={(event) => setImportUrl(event.target.value)}
                        placeholder="https://example.com/image.jpg" />
                      <button type="submit" className="online-secondary">Add to review</button>
                    </div>
                  </form>
                  <div>
                    <p className="gws-file-heading">Images downloaded to this computer</p>
                    <div className="gws-file-picker">
                      <input id="gws-local-image" className="gws-file-input" type="file"
                        accept="image/jpeg,image/png,image/webp" multiple
                        aria-label="Choose one or more local images"
                        onChange={importLocalFile} />
                      <label htmlFor="gws-local-image" className="online-secondary gws-file-button">
                        Choose images
                      </label>
                      <span className="gws-file-status" role="status">{lastFileSelection}</span>
                    </div>
                    <small>Choose multiple JPG, PNG or WebP files · 32 MB each · Preview only</small>
                  </div>
                </div>
              </details>
              {selectionError && <p className="gws-error" role="alert">{selectionError}</p>}
              <div className="gws-browser-notice">
                The browser shows Google's real website. Haven Walls cannot directly read or
                select elements from Google's page. Copy an image address and use
                <strong> Add copied image</strong> to add it to the review tray.
                If Google blocks embedded viewing, use
                <button type="button" className="gws-inline-link"
                  onClick={() => void copyGoogleSearchLink()}>Copy Google search link</button>.
              </div>
            </div>
            <ReviewQueue items={queue} onRemove={removeFromQueue} onClear={clearQueue}
              onInspect={setPreview} />
          </div>
        </section>
      ) : (
        <section role="tabpanel" aria-label="API Search" className="gws-panel">
          <div className="gws-search-card">
            <div className="gws-search-card-heading">
              <strong>Google Images with structured results</strong>
              <button type="button" className="online-secondary" aria-expanded={apiSettingsOpen}
                onClick={() => setApiSettingsOpen(!apiSettingsOpen)}>
                ⚙ API settings
              </button>
            </div>
            <form className="gws-search-form" onSubmit={(event) => void searchApi(event)}>
              <input type="search" value={apiQuery} maxLength={100}
                onChange={(event) => setApiQuery(event.target.value)}
                placeholder="Search for high-resolution wallpapers" aria-label="API image search"/>
              <button type="submit" className="online-primary" disabled={status === "loading"}>
                {status === "loading" ? "Searching…" : "Search via SerpApi"}
              </button>
            </form>
            <div className="gws-api-filters">
              <label htmlFor="gws-resolution">Minimum resolution</label>
              <select id="gws-resolution" value={minResolution}
                onChange={(event) => setMinResolution(event.target.value as Resolution)}>
                <option value="1080p">1080p+</option>
                <option value="1440p">1440p+</option>
                <option value="4K">4K+</option>
              </select>
              <span>Landscape images · Exact URL duplicates excluded</span>
            </div>
            {apiSettingsOpen && (
              <div className="gws-api-settings">
                <label htmlFor="gws-serp-key">Personal SerpApi API key</label>
                <div className="gws-manual-input">
                  <input id="gws-serp-key" type={keyVisible ? "text" : "password"}
                    autoComplete="off" spellCheck={false} value={serpapiKey}
                    onChange={(event) => onSerpapiKeyChange(event.target.value)}
                    placeholder="Paste your SerpApi key"/>
                  <button type="button" className="online-secondary"
                    onClick={() => setKeyVisible(!keyVisible)}>
                    {keyVisible ? "Hide" : "Show"}
                  </button>
                </div>
                <small>Your key remains in memory and is sent to SerpApi only when you search.</small>
              </div>
            )}
            {apiError && <p className="gws-error" role="alert">{apiError}</p>}
          </div>

          <div className="gws-workbench">
            <div className="gws-api-results">
              <div className="gws-results-header">
                <strong>Filtered wallpapers</strong>
                <span>
                  {status === "success" ? apiResults.length + " results" :
                    status === "loading" ? "Searching…" : "Sorted by reported resolution and desktop fit"}
                </span>
              </div>
              {status === "idle" && (
                <div className="gws-api-empty">
                  Search with SerpApi to see automatically filtered Google Images results.
                </div>
              )}
              {status === "loading" && (
                <div className="gws-api-empty" role="status">Searching Google Images…</div>
              )}
              {status === "error" && (
                <div className="gws-api-empty">Check the message above and try again.</div>
              )}
              {status === "success" && apiResults.length === 0 && (
                <div className="gws-api-empty">No eligible results. Try a lower minimum resolution or broader search.</div>
              )}
              {status === "success" && apiResults.length > 0 && (
                <div className="gws-api-grid">
                  {apiResults.map((image) => (
                    <ApiResultCard key={imageKey(image)} image={image}
                      selected={queue.some((item) => imageKey(item) === imageKey(image))}
                      onToggle={() => toggleFromApi(image)} onPreview={() => setPreview(image)} />
                  ))}
                </div>
              )}
              {apiNote && <div className="gws-api-note">{apiNote}</div>}
            </div>
            <ReviewQueue items={queue} onRemove={removeFromQueue} onClear={clearQueue}
              onInspect={setPreview} />
          </div>
        </section>
      )}

      <p className="gws-disclaimer">
        Image search is discovery, not licensing. Original sites may block full-size
        images. Nothing is saved, approved for reuse, or added to rotation in PR #2.
      </p>

      {preview && (
        <FullResolutionPreview key={imageKey(preview)} image={preview}
          onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

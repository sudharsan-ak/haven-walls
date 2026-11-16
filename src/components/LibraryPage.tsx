import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { CatalogImage } from "../lib/native";
import {
  getLibraryWallpaperImage, listLibraryWallpapers,
  removeLibraryWallpaper, setWallpaperFavorite, openWallpaperSource,
  type LibraryWallpaper,
} from "../lib/wallpaperLibrary";
import { formattedBytes } from "../lib/configuration";
import { qualityTier } from "../lib/imageQuality";
import {
  getWallpaperActivity, formatWallpaperLocalTime, type WallpaperActivity,
} from "../lib/windowsWallpaper";
import ApplyWallpaperDialog from "./ApplyWallpaperDialog";
import ConfirmDialog from "./ConfirmDialog";
import "./LibraryPage.css";

type Filter = "all" | "favorites" | "4k" | "portrait";

interface Props {
  revision: number;
  onDiscover: () => void;
  onReverseSearch: (image: LibraryWallpaper) => void;
  onSaveToLibrary: (images: CatalogImage[]) => void;
}

export default function LibraryPage({ revision, onDiscover, onReverseSearch, onSaveToLibrary }: Props) {
  const [items, setItems] = useState<LibraryWallpaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<LibraryWallpaper | null>(null);
  const [removalError, setRemovalError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<LibraryWallpaper | null>(null);
  const [applyItem, setApplyItem] = useState<LibraryWallpaper | null>(null);
  const [activity, setActivity] = useState<WallpaperActivity | null>(null);
  const [activityError, setActivityError] = useState("");
  const [openedOriginal, setOpenedOriginal] = useState("");
  const [originalError, setOriginalError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [visualSearchNote, setVisualSearchNote] = useState("");
  const [betterSourceUrl, setBetterSourceUrl] = useState("");
  const objectUrls = useRef(new Set<string>());
  const selectedId = useRef<string | null>(null);
  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
  }, []);

  function importLocalFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files || []).slice(0, 30);
    event.currentTarget.value = "";
    if (selectedFiles.length === 0) return;
    const candidates: CatalogImage[] = [];
    for (const file of selectedFiles) {
      if (file.size === 0 || file.size > 32 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        setNotice("Some files were skipped. Select JPG/PNG/WebP images under 32 MB each.");
        continue;
      }
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      candidates.push({
        id: "local-" + file.name + "-" + file.lastModified,
        source: "Local file",
        title: file.name,
        previewUrl: url,
        originalUrl: url,
        pageUrl: "",
        credit: "Imported from this computer",
        rights: "User-supplied local file; source and usage rights must be reviewed.",
        width: 0,
        height: 0,
        kind: "image",
      });
    }
    if (candidates.length) onSaveToLibrary(candidates);
    else setNotice("No supported images selected.");
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setItems(await listLibraryWallpapers());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setLoading(false);
    }
    try {
      setActivity(await getWallpaperActivity());
      setActivityError("");
    } catch (problem) {
      setActivityError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  useEffect(() => {
    let active = true;
    void listLibraryWallpapers()
      .then((rows) => { if (active) setItems(rows); })
      .catch((problem) => {
        if (active) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    let active = true;
    void getWallpaperActivity().then((result) => {
      if (active) {
        setActivity(result);
        setActivityError("");
      }
    }).catch((error: unknown) => {
      if (active) setActivityError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [revision]);

  async function afterApply() {
    setNotice("Windows desktop wallpaper changed. The active working copy is protected.");
    try {
      setActivity(await getWallpaperActivity());
      setActivityError("");
    } catch (problem) {
      setActivityError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  // Current appearance is verified against Windows; deletion protection is
  // deliberately broader and follows every persisted Haven Walls assignment.
  const currentIds = useMemo(() => new Set(
    (activity?.current || []).filter((entry) => entry.isCurrent)
      .map((entry) => entry.wallpaperId),
  ), [activity]);
  const assignedIds = useMemo(() => new Set(
    (activity?.current || []).map((entry) => entry.wallpaperId),
  ), [activity]);
  const canVerifyRemoval = Boolean(activity) && !activityError;

  const visible = useMemo(() => items.filter((item) => {
    const phrase = search.trim().toLowerCase();
    if (phrase && ![item.title, item.source, item.credit, item.sourcePage]
      .some((value) => value.toLowerCase().includes(phrase))) return false;
    if (filter === "favorites" && !item.favorite) return false;
    if (filter === "4k" && qualityTier(item.width, item.height) !== "4K+") return false;
    if (filter === "portrait" && !(item.height > item.width)) return false;
    return true;
  }), [items, filter, search]);

  // Filmstrip shows every item in the current filter, scrolling when the
  // collection outgrows the stage. The selected image is kept in view.
  const selectedIndex = selected ? visible.findIndex((item) => item.id === selected.id) : -1;
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const [viewerMode, setViewerMode] = useState<"fit" | "fill">("fit");

  useEffect(() => {
    if (!selected) return;
    filmstripRef.current?.querySelector<HTMLElement>(".hwl-viewer-thumb.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [selected?.id, visible]);

  function closeViewer() {
    selectedId.current = null;
    setSelected(null);
    setOpenedOriginal("");
    setOriginalError("");
  }

  function navigateViewer(step: number) {
    if (selectedIndex < 0 || visible.length < 2 || busyId || applyItem || pendingRemoval) return;
    const next = visible[(selectedIndex + step + visible.length) % visible.length];
    if (next) void open(next);
  }

  useEffect(() => {
    if (!selected || applyItem || pendingRemoval) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeViewer();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement &&
          target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        navigateViewer(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, selectedIndex, visible, busyId, applyItem, pendingRemoval]);

  async function toggleFavorite(image: LibraryWallpaper) {
    if (busyId) return;
    setBusyId(image.id);
    setError("");
    try {
      await setWallpaperFavorite(image.id, !image.favorite);
      setItems((current) => current.map((item) => item.id === image.id
        ? { ...item, favorite: !image.favorite } : item));
      setSelected((current) => current?.id === image.id
        ? { ...current, favorite: !image.favorite } : current);
      setNotice(!image.favorite ? "Added to Favorites." : "Removed from Favorites.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally { setBusyId(""); }
  }

  async function remove(image: LibraryWallpaper) {
    // Back-end remains authoritative if another display changes mid-operation.
    if (busyId || !canVerifyRemoval || assignedIds.has(image.id)) return;
    setBusyId(image.id);
    setError("");
    try {
      await removeLibraryWallpaper(image.id);
      setItems((current) => current.filter((item) => item.id !== image.id));
      setSelected((current) => current?.id === image.id ? null : current);
      setOpenedOriginal("");
      setNotice("Removed wallpaper from the managed Library.");
      setPendingRemoval(null);
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      setError(message);
      setRemovalError(message);
    } finally { setBusyId(""); }
  }

  async function open(image: LibraryWallpaper) {
    selectedId.current = image.id;
    setSelected(image);
    setOpenedOriginal("");
    setOriginalError("");
    setSourceError("");
    setVisualSearchNote("");
    setBetterSourceUrl(image.sourcePage || "");
    try {
      const data = await getLibraryWallpaperImage(image.id);
      // A rapid click on another entry may return out of order; the active
      // detail card still displays the original file for the chosen item.
      if (selectedId.current === image.id) setOpenedOriginal(data);
    } catch (problem) {
      if (selectedId.current === image.id) {
        setOriginalError(problem instanceof Error ? problem.message : String(problem));
      }
    }
  }

  async function openOnlineLink(url: string, label: string) {
    setSourceError("");
    try {
      await openWallpaperSource(url);
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      setSourceError("Could not open " + label + ": " + message);
    }
  }

  function validHttpsSource(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && Boolean(parsed.hostname) &&
        !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }

  function findBetterImage(image: LibraryWallpaper) {
    setSourceError("");
    setVisualSearchNote("");
    const direct = validHttpsSource(image.originalUrl) ? image.originalUrl : "";
    const manual = betterSourceUrl.trim();
    const manualValid = validHttpsSource(manual);
    // A publisher page is metadata, not a direct image. Keep the saved image
    // as the similarity anchor and let Rust inspect explicit download links.
    const directDownload = manualValid &&
      (/\.(?:jpe?g|png|webp|avif)$/i.test(new URL(manual).pathname) ||
        new URL(manual).pathname.includes("/download/"));
    const original = directDownload ? manual : direct;
    const page = manualValid && !directDownload ? manual : image.sourcePage;
    if (!original) {
      setSourceError("A direct image link is needed to identify the photograph. Use the free visual search below to find one.");
      return;
    }
    const candidate: CatalogImage = {
      id: image.id + "-quality-upgrade",
      kind: "image",
      source: image.source,
      title: image.title,
      previewUrl: image.thumbnailDataUrl || original,
      originalUrl: original,
      candidateUrls: direct && original !== direct ? [direct] : [],
      pageUrl: validHttpsSource(page) ? page : "",
      upgradeFromId: image.id,
      credit: image.credit,
      rights: image.rightsNote,
      width: image.width,
      height: image.height,
    };
    selectedId.current = null;
    setSelected(null);
    onSaveToLibrary([candidate]);
  }

  async function openFreeVisualSearch(image: LibraryWallpaper) {
    setSourceError("");
    setVisualSearchNote("");
    let copied = false;
    // The user explicitly opts in. Nothing is uploaded to a search provider
    // automatically; a public image URL is copied only if supported.
    if (validHttpsSource(image.originalUrl)) {
      try {
        await navigator.clipboard.writeText(image.originalUrl);
        copied = true;
      } catch { /* Clipboard may be disabled; manual paste still works. */ }
    }
    try {
      await openWallpaperSource("https://www.bing.com/visualsearch");
      setVisualSearchNote(copied
        ? "Bing Visual Search opened. Paste the copied image URL into its visual search box, choose a matching result, then paste the higher-resolution link above."
        : "Bing Visual Search opened. Upload an image you choose or paste its image URL. No Library file is uploaded automatically.");
    } catch (problem) {
      setSourceError("Could not open visual search: " +
        (problem instanceof Error ? problem.message : String(problem)));
    }
  }

  const totalBytes = items.reduce((sum, image) => sum + image.bytes, 0);
  return (
    <section className="hwl-page">
      <div className="eyebrow">Haven Walls / Offline library</div>
      <h1>Wallpaper Library</h1>
      <p className="subheading">
        Your saved wallpapers stay available without an internet connection.
        These are managed copies, separate from source originals and temporary discovery cache.
      </p>
      <div className="hwl-summary">
        <div><span>Saved wallpapers</span><strong>{items.length}</strong></div>
        <div><span>Favorites</span><strong>{items.filter((item) => item.favorite).length}</strong></div>
        <div><span>Original files</span><strong>{formattedBytes(totalBytes)}</strong></div>
        <div className="hwl-import-actions">
          <input id="hwl-file-picker" type="file" multiple
            accept="image/jpeg,image/png,image/webp"
            onChange={importLocalFiles} />
          <label htmlFor="hwl-file-picker" className="hwl-secondary hwl-file-label">
            Import local images
          </label>
          <button type="button" className="hwl-primary" onClick={onDiscover}>Discover wallpapers</button>
        </div>
      </div>
      {activity && activity.current.length > 0 && (
        <section className="hwl-current" aria-label="Currently applied wallpapers">
          <strong>Last applied by Haven Walls</strong>
          <div>
            {activity.current.map((active) => (
              <span key={active.targetId} title={"Applied " + formatWallpaperLocalTime(active.appliedAt)}>
                {active.targetId === "all" ? "All displays" :
                  "Selected display"}: {active.title}
                <small>{active.isCurrent ? "Current · " : "Last applied · "}
                  {formatWallpaperLocalTime(active.appliedAt)}</small>
              </span>
            ))}
          </div>
        </section>
      )}
      <div className="hwl-controls">
        <input type="search" value={search}
          placeholder="Search title, provider, or photographer…"
          aria-label="Search saved wallpapers"
          onChange={(event) => setSearch(event.target.value)} />
        <div className="hwl-filters" role="group" aria-label="Library filters">
          {([
            ["all", "All"], ["favorites", "Favorites"],
            ["4k", "4K+"], ["portrait", "Portrait"],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <button type="button" className="hwl-secondary"
          disabled={loading} onClick={() => void refresh()}>Refresh</button>
      </div>

      {notice && <p className="hwl-notice" role="status">{notice}</p>}
      {error && <p className="hwl-error" role="alert">{error}</p>}
      {loading && <div className="hwl-empty" role="status">Loading saved wallpapers…</div>}
      {!loading && !error && visible.length === 0 && (
        <div className="hwl-empty">
          <strong>{items.length ? "No wallpapers match those filters." : "Your wallpaper Library is empty."}</strong>
          <p>{items.length
            ? "Try another search, or view all saved wallpapers."
            : "Find a wallpaper in Gallery, inspect it, and choose Add to Library."}</p>
          <button type="button" className="hwl-primary" onClick={onDiscover}>Browse Gallery</button>
        </div>
      )}
      {!loading && visible.length > 0 && (
        <div className="hwl-grid" aria-label="Saved wallpapers">
          {visible.map((item) => (
            <article key={item.id}
              className={"hwl-card" + (currentIds.has(item.id) ? " hwl-card-current" : "")}>
              <button type="button" className="hwl-card-image"
                title={"Inspect " + item.title}
                onClick={() => void open(item)}>
                {item.thumbnailDataUrl
                  ? <img src={item.thumbnailDataUrl} alt={item.title} loading="lazy" />
                  : <span>Preview unavailable</span>}
                {currentIds.has(item.id) && (
                  <span className="hwl-current-indicator">▣ Current wallpaper</span>
                )}
                <span className="hwl-size">{item.width} × {item.height}</span>
                <span className={"hwl-quality hwl-quality-" + (qualityTier(item.width, item.height) === "Below 1080p" ? "low" : "ok")}>
                  {qualityTier(item.width, item.height)}
                </span>
              </button>
              <div className="hwl-card-info">
                <strong title={item.title}>{item.title}</strong>
                <span>{item.source} · {item.format.toUpperCase()} · {formattedBytes(item.bytes)}</span>
                <div className="hwl-card-actions">
                  <button type="button" className={item.favorite ? "favorite" : ""}
                    disabled={Boolean(busyId)}
                    onClick={() => void toggleFavorite(item)}
                    aria-label={(item.favorite ? "Remove favorite " : "Favorite ") + item.title}>
                    {item.favorite ? "♥ Favorite" : "♡ Favorite"}
                  </button>
                  <button type="button" onClick={() => void open(item)}>Inspect</button>
                  <button type="button" onClick={() => setApplyItem(item)}>
                    Set Now
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="hwl-footer">
        Wallpapers are applied only when you click Set Now or Apply to Windows.
        Automatic rotation and background downloading are not enabled.
        Active working copies stay separate from saved Library originals.
      </p>
      {activityError && <p className="hwl-error" role="alert">
        Windows wallpaper history is unavailable: {activityError}
      </p>}

      {selected && (
        <div className="hwl-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeViewer();
        }}>
          <section className="hwl-detail hwl-viewer" role="dialog" aria-modal="true"
            aria-label={"Saved wallpaper: " + selected.title}>
            <div className={"hwl-viewer-stage" + (viewerMode === "fill" ? " is-fill" : "")}>
              {openedOriginal ? (
                <img className="hwl-viewer-art" src={openedOriginal}
                  alt={selected.title} />
              ) : (
                <div className="hwl-viewer-loading" role="status">
                  {originalError || "Loading saved original image…"}
                </div>
              )}
              <div className="hwl-viewer-stage-badges">
                <span>Saved original</span>
                <span>{qualityTier(selected.width, selected.height)}</span>
                {currentIds.has(selected.id) && <span>Current wallpaper</span>}
              </div>
              <div className="hwl-viewer-fit" role="group" aria-label="Image display mode">
                <button type="button" aria-pressed={viewerMode === "fit"}
                  className={viewerMode === "fit" ? "active" : ""}
                  onClick={() => setViewerMode("fit")}>Fit</button>
                <button type="button" aria-pressed={viewerMode === "fill"}
                  className={viewerMode === "fill" ? "active" : ""}
                  onClick={() => setViewerMode("fill")}>Fill</button>
              </div>
              <button type="button" className="hwl-viewer-arrow prev"
                disabled={visible.length < 2 || Boolean(busyId)}
                aria-label="Previous wallpaper" title="Previous wallpaper (←)"
                onClick={() => navigateViewer(-1)}>‹</button>
              <button type="button" className="hwl-viewer-arrow next"
                disabled={visible.length < 2 || Boolean(busyId)}
                aria-label="Next wallpaper" title="Next wallpaper (→)"
                onClick={() => navigateViewer(1)}>›</button>
              <div className="hwl-viewer-film">
                <div className="hwl-viewer-film-heading">
                  <strong title={selected.title}>{selected.title}</strong>
                  <span>{selectedIndex + 1} / {visible.length}</span>
                </div>
                <div className="hwl-viewer-filmstrip" ref={filmstripRef}
                  aria-label="Browse all saved wallpapers in the current filter">
                  {visible.map((image) => (
                    <button type="button" key={image.id}
                      className={"hwl-viewer-thumb" + (image.id === selected.id ? " active" : "")}
                      aria-label={"View " + image.title}
                      aria-current={image.id === selected.id ? "true" : undefined}
                      title={image.title}
                      onClick={() => void open(image)}>
                      {image.thumbnailDataUrl ? (
                        <img src={image.thumbnailDataUrl} alt="" loading="lazy" />
                      ) : <span>Image</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="hwl-viewer-info">
              <header className="hwl-viewer-header">
                <div><small>Haven Walls / Library</small><strong>Wallpaper details</strong></div>
                <button type="button" className="hwl-viewer-close"
                  onClick={closeViewer} aria-label="Close wallpaper viewer"
                  title="Close (Esc)">×</button>
              </header>
              <div className="hwl-viewer-content">
                <h2 title={selected.title}>{selected.title}</h2>
                {assignedIds.has(selected.id) && (
                  <p className="hwl-protected-message" role="status">
                    {currentIds.has(selected.id)
                      ? "This wallpaper is currently in use."
                      : "This image is still protected by Haven Walls' last display assignment."}
                    {" "}Set another wallpaper through Haven Walls before removing it.
                  </p>
                )}
                <div className="hwl-viewer-pills" aria-label="Wallpaper quality and format">
                  <span className="quality">{qualityTier(selected.width, selected.height)}</span>
                  <span>{selected.width} × {selected.height}</span>
                  <span>{selected.format.toUpperCase()}</span>
                  <span>{formattedBytes(selected.bytes)}</span>
                </div>
                {qualityTier(selected.width, selected.height) === "Below 1080p" && (
                  <p className="hwl-source-error" role="status">
                    This image may look blurry on a desktop. Try finding a higher-resolution original.
                  </p>
                )}
                <section className="hwl-viewer-quality-box" aria-label="Find higher-quality image">
                  <div className="hwl-viewer-quality-heading">
                    <strong>Find higher quality</strong>
                  </div>
                  <div className="hwl-viewer-tool-buttons">
                    <button type="button" className="hwl-secondary"
                      onClick={() => findBetterImage(selected)}
                      disabled={!validHttpsSource(selected.originalUrl) &&
                        !validHttpsSource(betterSourceUrl)}>
                      Check original source
                    </button>
                    <button type="button" className="hwl-secondary"
                      onClick={() => onReverseSearch(selected)}>
                      Google Lens reverse search
                    </button>
                  </div>
                </section>
                {sourceError && <p role="alert" className="hwl-source-error">{sourceError}</p>}
                <div className="hwl-viewer-section-title">Original source</div>
                <div className="hwl-viewer-links">
                  <button type="button" className="hwl-secondary"
                    disabled={!validHttpsSource(selected.sourcePage)}
                    title={selected.sourcePage || "No source website recorded"}
                    onClick={() => void openOnlineLink(selected.sourcePage, "source page")}>
                    ↗ Source page
                  </button>
                  <button type="button" className="hwl-secondary"
                    disabled={!validHttpsSource(selected.originalUrl)}
                    title={selected.originalUrl || "No original image URL recorded"}
                    onClick={() => void openOnlineLink(selected.originalUrl, "original image")}>
                    ↗ Original image
                  </button>
                </div>
                <details key={selected.id + "-extra-search"}
                  className="hwl-viewer-extra hwl-viewer-accordion">
                  <summary>Custom image link and Bing search</summary>
                  <label htmlFor="hwl-better-source-url">Original image or publisher URL</label>
                  <input id="hwl-better-source-url" type="url"
                    value={betterSourceUrl} maxLength={2048}
                    placeholder="https://publisher.example/photo"
                    onChange={(event) => setBetterSourceUrl(event.target.value)} />
                  <button type="button" className="hwl-secondary"
                    onClick={() => findBetterImage(selected)}
                    disabled={!validHttpsSource(selected.originalUrl) &&
                      !validHttpsSource(betterSourceUrl)}>
                    Check supplied source
                  </button>
                  <button type="button" className="hwl-secondary"
                    onClick={() => void openFreeVisualSearch(selected)}>
                    Bing visual search ↗
                  </button>
                  {visualSearchNote && <p role="status">{visualSearchNote}</p>}
                </details>
                <details key={selected.id + "-info"}
                  className="hwl-viewer-rights hwl-viewer-accordion">
                  <summary>Image details and credit</summary>
                  <dl className="hwl-viewer-facts">
                    <div><dt>File size</dt><dd>{formattedBytes(selected.bytes)}</dd></div>
                    <div><dt>Saved from</dt><dd title={selected.source}>{selected.source}</dd></div>
                    <div><dt>Photographer</dt><dd title={selected.credit || "Unknown"}>
                      {selected.credit || "Not provided"}</dd></div>
                  </dl>
                </details>
                <details key={selected.id + "-rights"}
                  className="hwl-viewer-rights hwl-viewer-accordion">
                  <summary>Usage rights and source details</summary>
                  <p><strong>Usage rights:</strong> {selected.rightsNote || "Not verified"}</p>
                  <p><strong>Saved source:</strong> {selected.sourcePage || "Not available"}</p>
                  <p><strong>Original URL:</strong> {selected.originalUrl || "Not available"}</p>
                  <p>Image source and photo credit do not establish usage permission.</p>
                </details>
              </div>
              <footer className="hwl-viewer-actions">
                <button type="button" className={"hwl-secondary hwl-viewer-favorite" +
                  (selected.favorite ? " is-favorite" : "")}
                  title={selected.favorite ? "Remove favorite" : "Add to favorites"}
                  aria-label={selected.favorite ? "Remove favorite" : "Add to favorites"}
                  disabled={Boolean(busyId)}
                  onClick={() => void toggleFavorite(selected)}>
                  {selected.favorite ? "♥" : "♡"}
                </button>
                <button type="button" className="hwl-secondary hwl-danger"
                  disabled={Boolean(busyId) || !canVerifyRemoval || assignedIds.has(selected.id)}
                  title={assignedIds.has(selected.id)
                    ? "Set a different wallpaper through Haven Walls before removing this image."
                    : !canVerifyRemoval ? "Cannot verify protected wallpapers yet." : "Remove image"}
                  onClick={() => {
                    setRemovalError("");
                    setPendingRemoval(selected);
                  }}>Remove</button>
                <button type="button" className="hwl-primary"
                  disabled={Boolean(busyId)}
                  onClick={() => setApplyItem(selected)}>
                  Set as wallpaper
                </button>
              </footer>
            </div>
          </section>
        </div>
      )}
      {applyItem && (
        <ApplyWallpaperDialog image={applyItem}
          imageDataUrl={selected?.id === applyItem.id ? openedOriginal : undefined}
          onClose={() => setApplyItem(null)}
          onApplied={() => void afterApply()} />
      )}
      {pendingRemoval && (
        <ConfirmDialog tone="danger"
          title="Remove wallpaper from Library?"
          description={pendingRemoval.title}
          note={removalError || "The managed image and thumbnail will be removed from Haven Walls. The original outside the app stays untouched. This cannot be undone."}
          confirmLabel="Remove wallpaper"
          busy={Boolean(busyId)}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => void remove(pendingRemoval)} />
      )}
    </section>
  );
}

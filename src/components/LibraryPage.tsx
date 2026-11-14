import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { CatalogImage } from "../lib/native";
import {
  getLibraryWallpaperImage, listLibraryWallpapers,
  removeLibraryWallpaper, setWallpaperFavorite, openWallpaperSource,
  type LibraryWallpaper,
} from "../lib/wallpaperLibrary";
import { formattedBytes } from "../lib/configuration";
import {
  getWallpaperActivity, type WallpaperActivity,
} from "../lib/windowsWallpaper";
import ApplyWallpaperDialog from "./ApplyWallpaperDialog";
import "./LibraryPage.css";

type Filter = "all" | "favorites" | "4k" | "portrait";

interface Props {
  revision: number;
  onDiscover: () => void;
  onSaveToLibrary: (images: CatalogImage[]) => void;
}

export default function LibraryPage({ revision, onDiscover, onSaveToLibrary }: Props) {
  const [items, setItems] = useState<LibraryWallpaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<LibraryWallpaper | null>(null);
  const [applyItem, setApplyItem] = useState<LibraryWallpaper | null>(null);
  const [activity, setActivity] = useState<WallpaperActivity | null>(null);
  const [activityError, setActivityError] = useState("");
  const [openedOriginal, setOpenedOriginal] = useState("");
  const [originalError, setOriginalError] = useState("");
  const [sourceError, setSourceError] = useState("");
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
      if (active) setActivity(result);
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

  const visible = useMemo(() => items.filter((item) => {
    const phrase = search.trim().toLowerCase();
    if (phrase && ![item.title, item.source, item.credit, item.sourcePage]
      .some((value) => value.toLowerCase().includes(phrase))) return false;
    if (filter === "favorites" && !item.favorite) return false;
    if (filter === "4k" && !(item.width >= 3840 && item.height >= 2160)) return false;
    if (filter === "portrait" && !(item.height > item.width)) return false;
    return true;
  }), [items, filter, search]);

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
    if (busyId) return;
    if (!window.confirm(
      "Remove “" + image.title + "” from your managed Haven Walls Library?\n\n" +
      "This deletes the managed copy and thumbnail. The original file outside Haven Walls " +
      "will not be changed. This cannot be undone."
    )) return;
    setBusyId(image.id);
    setError("");
    try {
      await removeLibraryWallpaper(image.id);
      setItems((current) => current.filter((item) => item.id !== image.id));
      setSelected((current) => current?.id === image.id ? null : current);
      setOpenedOriginal("");
      setNotice("Removed wallpaper from the managed Library.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally { setBusyId(""); }
  }

  async function open(image: LibraryWallpaper) {
    selectedId.current = image.id;
    setSelected(image);
    setOpenedOriginal("");
    setOriginalError("");
    setSourceError("");
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
              <span key={active.targetId} title={active.appliedAt}>
                {active.targetId === "all" ? "All displays" :
                  "Selected display"}: {active.title}
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
            <article key={item.id} className="hwl-card">
              <button type="button" className="hwl-card-image"
                title={"Inspect " + item.title}
                onClick={() => void open(item)}>
                {item.thumbnailDataUrl
                  ? <img src={item.thumbnailDataUrl} alt={item.title} loading="lazy" />
                  : <span>Preview unavailable</span>}
                <span className="hwl-size">{item.width} × {item.height}</span>
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
      {activity && activity.history.length > 0 && (
        <section className="hwl-history" aria-label="Recent wallpaper activity">
          <h2>Recent wallpaper history</h2>
          <div className="hwl-history-list">
            {activity.history.slice(0, 12).map((event, index) => (
              <div key={event.appliedAt + event.targetId + index}>
                <strong>{event.title}</strong>
                <span>{event.targetId === "all" ? "All displays" : "Specific display"}
                  {" · "}{event.fit}{" · "}{event.appliedAt} UTC</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {activityError && <p className="hwl-error" role="alert">
        Windows wallpaper history is unavailable: {activityError}
      </p>}

      {selected && (
        <div className="hwl-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            selectedId.current = null;
            setSelected(null);
          }
        }}>
          <section className="hwl-detail" role="dialog" aria-modal="true"
            aria-label={"Saved wallpaper: " + selected.title}>
            <div className="hwl-detail-image">
              {openedOriginal
                ? <img src={openedOriginal} alt={selected.title} />
                : <div role="status">{originalError || "Loading saved original image…"}</div>}
              <button type="button" aria-label="Close wallpaper detail"
                className="hwl-close" onClick={() => {
                  selectedId.current = null;
                  setSelected(null);
                }}>×</button>
            </div>
            <div className="hwl-detail-text">
              <h2>{selected.title}</h2>
              <p>{selected.width} × {selected.height} · {selected.format.toUpperCase()} · {formattedBytes(selected.bytes)}</p>
              <p><strong>Source:</strong> {selected.source}</p>
              <p><strong>Photo credit:</strong> {selected.credit || "Not provided"}</p>
              <p><strong>Rights note:</strong> {selected.rightsNote || "Not verified"}</p>
              <div className="hwl-source-section">
                <strong>Original online sources</strong>
                <div className="hwl-source-links">
                  <button type="button" className="hwl-secondary"
                    disabled={!validHttpsSource(selected.sourcePage)}
                    title={selected.sourcePage || "No source website was recorded"}
                    onClick={() => void openOnlineLink(selected.sourcePage, "source page")}>
                    Open source page ↗
                  </button>
                  <button type="button" className="hwl-secondary"
                    disabled={!validHttpsSource(selected.originalUrl)}
                    title={selected.originalUrl || "No original online image link was recorded"}
                    onClick={() => void openOnlineLink(selected.originalUrl, "original image")}>
                    Open original image ↗
                  </button>
                </div>
                {!validHttpsSource(selected.sourcePage) &&
                  <small>No source page was saved for this image. Local imports may not have an online source.</small>}
                {!validHttpsSource(selected.originalUrl) &&
                  <small>No original online image URL is available. The saved Library copy is still fully available offline.</small>}
                <small>
                  These buttons open recorded online addresses. Some providers
                  may only expose a preview image rather than a full-resolution original.
                </small>
                {sourceError && <p role="alert" className="hwl-source-error">{sourceError}</p>}
              </div>
            </div>
            <div className="hwl-detail-actions">
              <button type="button" className="hwl-secondary"
                disabled={Boolean(busyId)}
                onClick={() => void toggleFavorite(selected)}>
                {selected.favorite ? "♥ Remove favorite" : "♡ Favorite"}
              </button>
              <button type="button" className="hwl-secondary hwl-danger"
                disabled={Boolean(busyId)}
                onClick={() => void remove(selected)}>Remove from Library</button>
              <button type="button" className="hwl-primary"
                disabled={Boolean(busyId)}
                onClick={() => setApplyItem(selected)}>
                Set as Windows wallpaper
              </button>
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
    </section>
  );
}

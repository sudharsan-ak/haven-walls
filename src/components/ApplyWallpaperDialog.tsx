import { useEffect, useState } from "react";
import type { LibraryWallpaper } from "../lib/wallpaperLibrary";
import { getLibraryWallpaperImage } from "../lib/wallpaperLibrary";
import { getConfiguration, type WallpaperFit } from "../lib/configuration";
import {
  applyLibraryWallpaper, FIT_OPTIONS, listWindowsMonitors,
  renderWallpaperOverlay, type WindowsMonitor,
} from "../lib/windowsWallpaper";
import "./ApplyWallpaperDialog.css";

interface Props {
  image: LibraryWallpaper;
  imageDataUrl?: string;
  onClose: () => void;
  onApplied: () => void;
}

export default function ApplyWallpaperDialog({ image, imageDataUrl, onClose, onApplied }: Props) {
  const [monitors, setMonitors] = useState<WindowsMonitor[]>([]);
  const [targetId, setTargetId] = useState("all");
  const [fit, setFit] = useState<WallpaperFit>("smartFit");
  const [caption, setCaption] = useState(false);
  const [credit, setCredit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([listWindowsMonitors(), getConfiguration()])
      .then(([displays, snapshot]) => {
        if (!active) return;
        setMonitors(displays);
        setFit(snapshot.settings.wallpaperFit);
        setCaption(snapshot.settings.showCaption);
        setCredit(snapshot.settings.showPhotoCredit);
        if (displays.length === 0) {
          setError("Windows did not report any attached monitors.");
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);

  async function apply() {
    if (busy || loading || monitors.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let overlay: string | undefined;
      if (caption || credit) {
        const data = imageDataUrl || await getLibraryWallpaperImage(image.id);
        overlay = await renderWallpaperOverlay(data, image, {
          showCaption: caption,
          showPhotoCredit: credit,
        });
      }
      const result = await applyLibraryWallpaper(image.id, targetId, fit, overlay);
      setApplied(true);
      setNotice(result.notice);
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const creditLabel = image.credit && !/^imported from this computer|image hosted by/i.test(image.credit)
    ? image.credit : image.sourcePage || image.source;

  return (
    <div className="hwa-backdrop" role="presentation" onMouseDown={(event) => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <section className="hwa-panel" role="dialog" aria-modal="true"
        aria-label={"Set wallpaper: " + image.title}>
        <div className="hwa-header">
          <div>
            <span>Haven Walls / Windows desktop</span>
            <h2>Set as wallpaper</h2>
          </div>
          <button type="button" className="hwa-close" onClick={onClose} disabled={busy}
            aria-label="Close wallpaper options">×</button>
        </div>
        <div className="hwa-scroll">
          <div className="hwa-preview">
            {image.thumbnailDataUrl && <img src={image.thumbnailDataUrl}
              alt={"Wallpaper preview: " + image.title}/>}
            {(caption || credit) && (
              <div className="hwa-preview-caption">
                {caption && <strong>{image.title}</strong>}
                {credit && creditLabel && <small>{creditLabel}</small>}
              </div>
            )}
          </div>
          <p className="hwa-help">
            Windows uses a separate, protected wallpaper copy. Your original Library
            file is preserved. The preview above approximates the caption placement.
          </p>
          <div className="hwa-fields">
            <label>
              <strong>Apply to</strong>
              <select value={targetId} disabled={loading || busy}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  if (event.target.value !== "all" && fit === "span") setFit("fill");
                }}>
                <option value="all">All displays</option>
                {monitors.map((monitor) => (
                  <option key={monitor.id} value={monitor.id}>
                    {monitor.name}{monitor.isPrimary ? " · Primary" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <strong>Image positioning</strong>
              <select value={fit} disabled={loading || busy}
                onChange={(event) => setFit(event.target.value as WallpaperFit)}>
                {FIT_OPTIONS.filter((item) => targetId === "all" || item.value !== "span")
                  .map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <p className="hwa-fit-note">{FIT_OPTIONS.find((option) => option.value === fit)?.note}</p>
          <div className="hwa-options">
            <label>
              <span><strong>Show photo credit</strong>
                <small>Lower-right corner when source information is available</small></span>
              <input type="checkbox" checked={credit} disabled={busy}
                onChange={(event) => setCredit(event.target.checked)} />
            </label>
            <label>
              <span><strong>Show caption</strong>
                <small>Display the image title on this wallpaper</small></span>
              <input type="checkbox" checked={caption} disabled={busy}
                onChange={(event) => setCaption(event.target.checked)} />
            </label>
          </div>
          <p className="hwa-footnote">
            These switches affect this application only. Change your saved defaults
            under Settings → Wallpaper & display. Credits and licensing information
            stay with the Library entry even when not shown.
          </p>
          {loading && <p className="hwa-status" role="status">Detecting Windows displays and preferences…</p>}
          {busy && <p className="hwa-status" role="status">Preparing and applying your Windows wallpaper…</p>}
          {error && <p className="hwa-error" role="alert">{error}</p>}
          {notice && <p className="hwa-success" role="status">{notice}</p>}
        </div>
        <div className="hwa-actions">
          <button type="button" className="hwl-secondary" onClick={onClose} disabled={busy}>
            {applied ? "Close" : "Cancel"}
          </button>
          <button type="button" className="hwl-primary" disabled={loading || busy || monitors.length === 0}
            onClick={() => void apply()}>
            {busy ? "Applying…" : applied ? "Apply again" : "Apply to Windows"}
          </button>
        </div>
      </section>
    </div>
  );
}

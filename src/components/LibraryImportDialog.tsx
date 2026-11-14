import { useEffect, useMemo, useState } from "react";
import type { CatalogImage } from "../lib/native";
import { imageCandidates } from "../lib/imageResolution";
import {
  fileBlobToBase64, importWallpaperData, importWallpaperUrl, type ImportOutcome,
} from "../lib/wallpaperLibrary";
import "./LibraryImportDialog.css";

interface Props {
  images: CatalogImage[];
  onClose: () => void;
  onImported: () => void;
  onOpenLibrary: () => void;
}

interface ImportLog {
  name: string;
  message: string;
  status: "saved" | "duplicate" | "error";
}

const fileCandidate = (image: CatalogImage): string | undefined =>
  [image.originalUrl, image.previewUrl].find((value) => value?.startsWith("blob:")) || undefined;

export default function LibraryImportDialog({
  images, onClose, onImported, onOpenLibrary,
}: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [allowSmaller, setAllowSmaller] = useState(false);
  const [allowSimilar, setAllowSimilar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const [logs, setLogs] = useState<ImportLog[]>([]);
  const [complete, setComplete] = useState(false);
  const [credit, setCredit] = useState(images.length === 1 ? images[0].credit : "");
  const [rightsNote, setRightsNote] = useState("");

  const distinct = useMemo(() => {
    const urls = new Set<string>();
    return images.filter((item) => {
      if (item.kind !== "image") return false;
      const key = item.originalUrl || item.previewUrl;
      if (urls.has(key)) return false;
      urls.add(key);
      return true;
    });
  }, [images]);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [busy, onClose]);

  async function save() {
    if (!confirmed || busy || distinct.length === 0) return;
    setBusy(true);
    setComplete(false);
    setLogs([]);
    let imported = false;
    for (let i = 0; i < distinct.length; i++) {
      const image = distinct[i];
      setIndex(i + 1);
      const metadata = {
        title: image.title,
        source: image.source,
        sourcePage: image.pageUrl,
        originalUrl: image.originalUrl || image.previewUrl,
        credit: distinct.length === 1 ? credit : image.credit,
        rightsNote: rightsNote.trim() || image.rights,
        rightsConfirmed: true,
        allowBelowMinimum: allowSmaller,
        allowSimilar,
      };
      try {
        const blob = fileCandidate(image);
        let result: ImportOutcome | undefined;
        if (blob) {
          result = await importWallpaperData(await fileBlobToBase64(blob), metadata);
        } else {
          // Sources have different CDN conventions. Attempt only the URLs
          // associated with this explicitly reviewed image, not page scraping.
          const candidates = imageCandidates(image);
          let lastError = "";
          for (const url of candidates) {
            if (!url.startsWith("https://")) continue;
            try {
              result = await importWallpaperUrl(url, metadata);
              break;
            } catch (problem) {
              lastError = problem instanceof Error ? problem.message : String(problem);
              // Do not bypass quality rules, an excluded source, a duplicate
              // warning, or any other user-configured policy with a fallback.
              if (/below your|disabled in Settings|excluded |visually similar|Confirm|permission/i.test(lastError)) {
                break;
              }
            }
          }
          if (!result) throw new Error(lastError || "No usable direct HTTPS image URL was available.");
        }

        if (!result.alreadySaved) imported = true;
        setLogs((entries) => [...entries, {
          name: image.title,
          message: result.note,
          status: result.alreadySaved ? "duplicate" : "saved",
        }]);
      } catch (problem) {
        setLogs((entries) => [...entries, {
          name: image.title,
          message: problem instanceof Error ? problem.message : String(problem),
          status: "error",
        }]);
      }
    }
    if (imported) onImported();
    setComplete(true);
    setBusy(false);
  }

  return (
    <div className="lidi-overlay" onMouseDown={(event) => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <section className="lidi-panel" role="dialog" aria-modal="true"
        aria-label="Save images to local wallpaper library">
        <div className="lidi-header">
          <div>
            <span>Local wallpaper library</span>
            <h2>Save {distinct.length} {distinct.length === 1 ? "image" : "images"}</h2>
          </div>
          <button type="button" className="lidi-close" onClick={onClose} disabled={busy}
            aria-label="Close library import">×</button>
        </div>

        <div className="lidi-scroll">
          <p className="lidi-description">
            Haven Walls saves a verified managed copy to your local Library.
            It does not change your Windows wallpaper yet. Images that are
            blocked, below your minimum resolution, or exact duplicates are handled individually.
          </p>
          <div className="lidi-preview-strip">
            {distinct.slice(0, 7).map((image, i) => (
              <div key={(image.originalUrl || image.previewUrl) + i} title={image.title}>
                <img src={image.previewUrl} alt={image.title} referrerPolicy="no-referrer" />
              </div>
            ))}
            {distinct.length > 7 && <span>+{distinct.length - 7}</span>}
          </div>

          {distinct.length === 1 && (
            <label className="lidi-field">
              <strong>Photo credit / source</strong>
              <input type="text" value={credit} maxLength={240}
                onChange={(event) => setCredit(event.target.value)}
                placeholder="Photographer or original source, if known" />
            </label>
          )}
          <label className="lidi-field">
            <strong>Rights or permission note (optional)</strong>
            <textarea rows={2} maxLength={900} value={rightsNote}
              onChange={(event) => setRightsNote(event.target.value)}
              placeholder="For example: my own photograph, licensed from provider, permission from creator" />
          </label>

          <label className="lidi-check">
            <input type="checkbox" checked={confirmed} disabled={busy || complete}
              onChange={(event) => setConfirmed(event.target.checked)}/>
            <span>
              <strong>I reviewed the original source and have permission for my intended use.</strong>
              <small>
                Discovery results are not automatically licensed. Please follow image copyright,
                photographer credit, and provider restrictions.
              </small>
            </span>
          </label>
          <label className="lidi-check">
            <input type="checkbox" checked={allowSmaller} disabled={busy || complete}
              onChange={(event) => setAllowSmaller(event.target.checked)}/>
            <span><strong>Allow images below my minimum resolution</strong>
              <small>Still validates actual pixels and supported file format.</small>
            </span>
          </label>
          <label className="lidi-check">
            <input type="checkbox" checked={allowSimilar} disabled={busy || complete}
              onChange={(event) => setAllowSimilar(event.target.checked)}/>
            <span><strong>Allow visually similar images</strong>
              <small>Exact duplicates remain blocked, even when this is enabled.</small>
            </span>
          </label>

          {busy && <p className="lidi-status" role="status">
            Processing image {index} of {distinct.length}…
          </p>}
          {logs.length > 0 && (
            <div className="lidi-log" aria-label="Import results" aria-live="polite">
              {logs.map((item, i) => (
                <div className={"lidi-log-" + item.status} key={i}>
                  <strong>{item.name}</strong>
                  <p>{item.message}</p>
                </div>
              ))}
            </div>
          )}
          {complete && <p className="lidi-status" role="status">
            Finished reviewing {distinct.length} images. Check individual results above.
          </p>}
        </div>

        <div className="lidi-actions">
          <button type="button" className="online-secondary" disabled={busy} onClick={onClose}>
            {complete ? "Close" : "Cancel"}
          </button>
          {complete ? (
            <button type="button" className="online-primary" onClick={onOpenLibrary}>
              Open Library
            </button>
          ) : (
            <button type="button" className="online-primary"
              disabled={!confirmed || busy || distinct.length === 0}
              onClick={() => void save()}>
              {busy ? "Saving…" : "Save to Library"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

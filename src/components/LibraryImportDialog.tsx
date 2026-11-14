import { useEffect, useMemo, useRef, useState } from "react";
import { getConfiguration } from "../lib/configuration";
import type { CatalogImage } from "../lib/native";
import { imageCandidates } from "../lib/imageResolution";
import {
  fileBlobToBase64, importWallpaperData, importBestWallpaperUrls, type ImportOutcome,
  type LibraryWallpaper,
} from "../lib/wallpaperLibrary";
import "./LibraryImportDialog.css";

interface Props {
  images: CatalogImage[];
  onClose: () => void;
  onImported: () => void;
  onOpenLibrary: () => void;
  onSetNow: (image: LibraryWallpaper) => void;
}

interface ImportLog {
  name: string;
  message: string;
  status: "saved" | "duplicate" | "error";
}

const fileCandidate = (image: CatalogImage): string | undefined =>
  [image.originalUrl, image.previewUrl].find((value) => value?.startsWith("blob:")) || undefined;

export default function LibraryImportDialog({
  images, onClose, onImported, onOpenLibrary, onSetNow,
}: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [quickMode, setQuickMode] = useState<boolean | null>(null);
  const [manualRetry, setManualRetry] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const autoStarted = useRef(false);
  const [allowSmaller, setAllowSmaller] = useState(false);
  const [allowSimilar, setAllowSimilar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const [logs, setLogs] = useState<ImportLog[]>([]);
  const [complete, setComplete] = useState(false);
  const [credit, setCredit] = useState(images.length === 1 ? images[0].credit : "");
  const [rightsNote, setRightsNote] = useState("");
  const [lastSaved, setLastSaved] = useState<LibraryWallpaper | null>(null);

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

  // A user click on Add to Library is the only action that opens this dialog.
  // In Quick Save mode, start the import once as soon as the preference loads.
  useEffect(() => {
    let active = true;
    void getConfiguration().then((result) => {
      if (active) setQuickMode(result.settings.skipImportConfirmation);
    }).catch((problem) => {
      if (!active) return;
      const message = problem instanceof Error ? problem.message : String(problem);
      setSettingsError("Could not load Quick Save preference: " + message);
      // Failure to read settings must not silently bypass confirmation.
      setQuickMode(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (quickMode !== true || manualRetry || autoStarted.current) return;
    autoStarted.current = true;
    void save(true);
  }, [quickMode]);

  async function save(withQuickSave: boolean) {
    if ((!withQuickSave && !confirmed) || busy || distinct.length === 0) return;
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
        // Quick Save means no per-image attestation was made. The backend
        // enforces the saved preference and records that rights are unverified.
        rightsConfirmed: !withQuickSave && confirmed,
        allowBelowMinimum: allowSmaller,
        allowSimilar,
      };
      try {
        const blob = fileCandidate(image);
        let result: ImportOutcome | undefined;
        if (blob) {
          result = await importWallpaperData(await fileBlobToBase64(blob), metadata);
        } else {
          // Resolve all known original/large image addresses plus standard
          // image metadata from the selected source page. Rust downloads and
          // decodes candidates before writing only the best valid image.
          // A small preview must never win merely because it loads first.
          const candidates = imageCandidates(image).filter((url) => url.startsWith("https://"));
          if (candidates.length === 0) {
            throw new Error("No usable HTTPS original image URL. Open the source website and copy its full-size image address.");
          }
          result = await importBestWallpaperUrls(candidates, metadata);
        }

        if (!result.alreadySaved) imported = true;
        setLastSaved(result.wallpaper);
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
            Haven Walls checks available original image versions and saves the best verified match.
            You can apply a successfully saved image to Windows afterward. Images that are
            blocked, below your minimum resolution, or exact duplicates are reported individually.
          </p>
          <div className="lidi-preview-strip">
            {distinct.slice(0, 7).map((image, i) => (
              <div key={(image.originalUrl || image.previewUrl) + i} title={image.title}>
                <img src={image.previewUrl} alt={image.title} referrerPolicy="no-referrer" />
              </div>
            ))}
            {distinct.length > 7 && <span>+{distinct.length - 7}</span>}
          </div>

          {quickMode === null && (
            <p className="lidi-status" role="status">Loading your Library import preference…</p>
          )}
          {settingsError && <p className="lidi-error" role="alert">{settingsError}</p>}
          {quickMode === true && !manualRetry && (
            <p className="lidi-status" role="status">
              Quick Save is enabled in Settings. Your selected images are being
              saved without another confirmation. This does not verify or grant
              image usage rights.
            </p>
          )}

          {(quickMode === false || manualRetry) && (
            <>
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
                  placeholder="My own image, licensed source, or permission details" />
              </label>

              {quickMode === false && (
                <label className="lidi-check">
                  <input type="checkbox" checked={confirmed} disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}/>
                  <span>
                    <strong>I reviewed the source and have permission for my intended use.</strong>
                    <small>
                      Images found by search are not automatically licensed. Follow the
                      original provider's usage conditions and attribution requirements.
                      You can enable Quick Save under Settings to skip this repeated prompt.
                    </small>
                  </span>
                </label>
              )}
              <label className="lidi-check">
                <input type="checkbox" checked={allowSmaller} disabled={busy}
                  onChange={(event) => setAllowSmaller(event.target.checked)}/>
                <span><strong>Allow images below my minimum resolution</strong>
                  <small>Still validates actual pixels and supported file format.</small>
                </span>
              </label>
              <label className="lidi-check">
                <input type="checkbox" checked={allowSimilar} disabled={busy}
                  onChange={(event) => setAllowSimilar(event.target.checked)}/>
                <span><strong>Allow visually similar images</strong>
                  <small>Exact duplicates remain blocked, even when this is enabled.</small>
                </span>
              </label>
            </>
          )}

          {busy && <p className="lidi-status" role="status">
            Checking source quality and importing image {index} of {distinct.length}…
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
            Finished processing {distinct.length} images. Check individual results above.
          </p>}
          {complete && quickMode === true && !manualRetry &&
            logs.some((entry) => entry.status === "error") && (
              <button type="button" className="online-secondary"
                onClick={() => {
                  setManualRetry(true);
                  setComplete(false);
                }}>
                Adjust quality or duplicate options and retry
              </button>
            )}
        </div>

        <div className="lidi-actions">
          <button type="button" className="online-secondary" disabled={busy} onClick={onClose}>
            {complete ? "Close" : "Cancel"}
          </button>
          {complete ? (
            <>
              {lastSaved && (
                <button type="button" className="online-secondary"
                  onClick={() => onSetNow(lastSaved)}>Set Now</button>
              )}
              <button type="button" className="online-primary" onClick={onOpenLibrary}>
                Open Library
              </button>
            </>
          ) : quickMode === null || (quickMode === true && !manualRetry) ? (
            <button type="button" className="online-primary" disabled>
              {busy ? "Saving automatically…" : "Preparing Quick Save…"}
            </button>
          ) : (
            <button type="button" className="online-primary"
              disabled={(!confirmed && quickMode !== true) || busy || distinct.length === 0}
              onClick={() => void save(quickMode === true)}>
              {busy ? "Saving…" : "Save to Library"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

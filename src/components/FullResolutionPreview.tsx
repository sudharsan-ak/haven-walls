import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { CatalogImage } from "../lib/native";
import { inspectLoadedImage, type InspectedImageDraft } from "../lib/imageInspection";
import {
  inspectBestOriginal, resolveBestAvailableImage,
  type ResolvedImage, type VerifiedSourceImage,
} from "../lib/imageResolution";
import { qualityTier } from "../lib/imageQuality";

interface Props {
  image: CatalogImage;
  onClose: () => void;
  onAddToLibrary?: (image: CatalogImage) => void;
  addLabel?: string;
  navigation?: {
    images: CatalogImage[];
    onSelect: (image: CatalogImage) => void;
  };
}

function isRemote(url: string): boolean {
  return url.startsWith("https://");
}

/**
 * Loads the provider's original image when available instead of enlarging a
 * low-resolution search thumbnail. Actual pixels are read from the displayed
 * HTMLImageElement; we never claim provider metadata is a verified 4K image.
 */
export default function FullResolutionPreview({
  image, onClose, onAddToLibrary, addLabel = "Add to Library", navigation,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedImage | null>(null);
  const [resolving, setResolving] = useState(true);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const [inspection, setInspection] = useState<InspectedImageDraft | null>(null);
  const [verifiedOriginal, setVerifiedOriginal] = useState<VerifiedSourceImage | null>(null);
  const verifiedRef = useRef<VerifiedSourceImage | null>(null);
  const [checkingOriginal, setCheckingOriginal] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [copied, setCopied] = useState<"image" | "source" | null>(null);
  const [viewerMode, setViewerMode] = useState<"fit" | "fill">("fit");
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const galleryResults = navigation?.images ?? [];
  const currentIndex = navigation
    ? galleryResults.findIndex((candidate) => candidate.id === image.id) : -1;
  const canNavigate = currentIndex >= 0 && galleryResults.length > 1;

  function navigate(step: number) {
    if (!navigation || !canNavigate) return;
    const nextIndex = (currentIndex + step + galleryResults.length) % galleryResults.length;
    navigation.onSelect(galleryResults[nextIndex]);
  }

  useEffect(() => {
    if (!navigation || currentIndex < 0) return;
    filmstripRef.current?.querySelector<HTMLElement>(".online-gallery-thumb.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [image.id, currentIndex, Boolean(navigation)]);


  useEffect(() => {
    setCopied(null);
  }, [image]);

  useEffect(() => {
    const controller = new AbortController();
    setSrc(null);
    setResolved(null);
    setResolving(true);
    setFallback(false);
    setFailed(false);
    setInspection(null);
    verifiedRef.current = null;
    void resolveBestAvailableImage(image, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setResolved(result);
      setResolving(false);
      if (verifiedRef.current) return;
      if (result) {
        setFallback(result.isThumbnailFallback);
        setSrc(result.url);
      } else {
        // Preserve the previously supported preview behavior when the
        // original host rejects all available image links.
        setFallback(true);
        setSrc(image.previewUrl);
      }
    });
    return () => controller.abort();
  }, [image]);

  // Native source inspection is independent of the WebView2 thumbnail.
  // A 4K original can be verified even while the displayed preview is smaller.
  useEffect(() => {
    let active = true;
    setVerifiedOriginal(null);
    setSourceError("");
    setCheckingOriginal(true);
    void inspectBestOriginal(image).then((result) => {
      if (!active) return;
      setVerifiedOriginal(result);
      if (result) {
        verifiedRef.current = result;
        setSrc(result.previewDataUrl);
        setResolving(false);
        setFallback(false);
        setFailed(false);
      }
    }).catch((problem: unknown) => {
      if (!active) return;
      setSourceError(problem instanceof Error ? problem.message : String(problem));
    }).finally(() => {
      if (active) setCheckingOriginal(false);
    });
    return () => { active = false; };
  }, [image]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!navigation || !canNavigate ||
          (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      navigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, navigation, canNavigate, currentIndex, image.id]);

  function onLoaded(event: SyntheticEvent<HTMLImageElement>) {
    const element = event.currentTarget;
    setInspection(inspectLoadedImage(
      { ...image, originalUrl: src || image.originalUrl },
      element.naturalWidth,
      element.naturalHeight,
    ));
    setFailed(false);
  }

  function onFailed() {
    if (src !== image.previewUrl) {
      setFallback(true);
      setSrc(image.previewUrl);
      setInspection(null);
      return;
    }
    setFailed(true);
    setInspection(null);
  }

  async function copyUrl(kind: "image" | "source", url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  }

  const originalImageUrl = verifiedOriginal?.originalUrl ||
    (src && isRemote(src) ? src : null);
  const canCopyImage = Boolean(originalImageUrl);
  return (
    <div className="online-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={"online-detail" + (navigation ? " online-gallery-viewer" : "")}
        role="dialog" aria-modal="true" aria-label={"Image preview: " + image.title}>
        <div className={"online-detail-image online-hires-preview" +
          (navigation ? " online-gallery-stage" +
            (viewerMode === "fill" ? " is-fill" : "") : "")}>
          {resolving ? (
            <div className="online-hires-unavailable" role="status">
              <strong>Finding the best available image</strong>
              <p>Checking the source link and available image sizes…</p>
            </div>
          ) : !failed && src ? (
            <img
              className={navigation ? "online-gallery-art" : undefined}
              src={src}
              alt={image.title}
              referrerPolicy="no-referrer"
              onLoad={onLoaded}
              onError={onFailed}
            />
          ) : (
            <div className="online-hires-unavailable">
              <strong>Image could not be loaded</strong>
              <p>The source may block direct access. Try the source website or another image.</p>
            </div>
          )}
          {navigation && (
            <>
              <div className="online-gallery-display" role="group" aria-label="Image display mode">
                <button type="button" className={viewerMode === "fit" ? "active" : ""}
                  aria-pressed={viewerMode === "fit"}
                  onClick={() => setViewerMode("fit")}>Fit</button>
                <button type="button" className={viewerMode === "fill" ? "active" : ""}
                  aria-pressed={viewerMode === "fill"}
                  onClick={() => setViewerMode("fill")}>Fill</button>
              </div>
              <button type="button" className="online-gallery-arrow prev"
                disabled={!canNavigate} onClick={() => navigate(-1)}
                aria-label="Previous discovery result"
                title="Previous image (←)">‹</button>
              <button type="button" className="online-gallery-arrow next"
                disabled={!canNavigate} onClick={() => navigate(1)}
                aria-label="Next discovery result"
                title="Next image (→)">›</button>
              <div className="online-gallery-film">
                <div className="online-gallery-film-heading">
                  <strong title={image.title}>{image.title}</strong>
                  <span>{currentIndex >= 0 ? currentIndex + 1 : "?"} / {galleryResults.length}</span>
                </div>
                <div className="online-gallery-filmstrip" ref={filmstripRef}
                  aria-label="Browse the current Gallery results">
                  {galleryResults.map((candidate) => (
                    <button type="button" key={candidate.id}
                      className={"online-gallery-thumb" +
                        (candidate.id === image.id ? " active" : "")}
                      aria-current={candidate.id === image.id ? "true" : undefined}
                      aria-label={"View " + candidate.title}
                      title={candidate.title} onClick={() => navigation.onSelect(candidate)}>
                      <img src={candidate.previewUrl} alt="" loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          // Keep the thumbnail strip navigable when a host blocks image hotlinking.
                          event.currentTarget.style.display = "none";
                        }}/>
                      <span>Image</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <button type="button" className="online-close" onClick={onClose}
            aria-label="Close image preview">×</button>
        </div>

        <div className="online-detail-footer online-hires-footer">
          <div className="online-hires-copy">
            <h2>{image.title}</h2>
            <p>{image.source}{image.credit ? " · " + image.credit : ""}</p>

            <div className="online-hires-validation" role="status" aria-live="polite">
              {verifiedOriginal ? (
                <>
                  <strong>Verified downloaded source: {verifiedOriginal.width} × {verifiedOriginal.height}
                    {" · "}{qualityTier(verifiedOriginal.width, verifiedOriginal.height)}</strong>
                  <small>
                    Display preview: {verifiedOriginal.previewWidth} × {verifiedOriginal.previewHeight}.
                    The preview can be smaller than the verified original. Checked {verifiedOriginal.tried}
                    {" "}{verifiedOriginal.tried === 1 ? "source candidate" : "source candidates"}.
                  </small>
                </>
              ) : (
                <>
                  {failed ? "Image preview could not be loaded."
                    : resolving ? "Checking displayed image dimensions…"
                    : !inspection ? "Loading image preview…"
                    : (
                      <>
                        <strong>Loaded preview: {inspection.actualWidth} × {inspection.actualHeight}
                          {" · "}{qualityTier(inspection.actualWidth, inspection.actualHeight)}</strong>
                        <span>{inspection.landscape ? " · Landscape" : " · Not standard landscape"}
                          {fallback ? " · Thumbnail fallback" : ""}
                        </span>
                      </>
                    )}
                  {image.width > 0 && image.height > 0 && (
                    <small>Search provider listed {image.width} × {image.height};
                      that does not establish the original image's pixels.</small>
                  )}
                  {checkingOriginal && (
                    <small>Still checking the source for an accessible higher-resolution original…</small>
                  )}
                </>
              )}
            </div>
            {!verifiedOriginal && !checkingOriginal && (
              <p className="online-hires-warning">
                {sourceError
                  ? "Could not verify a larger original from this link. The source website may block automated requests or the link may be a thumbnail."
                  : "Only the preview's displayed pixels are verified. A 4K/8K search-result title does not prove the original image is 4K."}
              </p>
            )}
            {resolved && !verifiedOriginal && (
              <p className={resolved.isThumbnailFallback ? "online-hires-warning" : ""}>
                {resolved.note}
              </p>
            )}
            {fallback && !resolved && !verifiedOriginal && (
              <p className="online-hires-warning">
                We could not find a usable higher-resolution image at this address.
                The fallback preview may be small, even if the Google search was for 4K.
              </p>
            )}
            <p>
              The pixel dimensions above come from the loaded image, not from Google's
              search label. Pixel count alone does not guarantee sharpness.
            </p>
            <p>{image.rights}</p>
          </div>
          <div className="online-hires-actions">
            {onAddToLibrary && !failed && src && (
              <button type="button" className="online-primary"
                onClick={() => onAddToLibrary({
                  ...image,
                  originalUrl: verifiedOriginal?.originalUrl ||
                    (src.startsWith("https://") || src.startsWith("blob:")
                      ? src : image.originalUrl),
                  candidateUrls: [...new Set([
                    verifiedOriginal?.originalUrl || "",
                    ...(image.candidateUrls || []),
                    image.originalUrl || "", image.previewUrl,
                  ].filter(Boolean))],
                })}>
                {addLabel}
              </button>
            )}
            {canCopyImage && (
              <button className="online-secondary" type="button"
                onClick={() => { if (originalImageUrl) void copyUrl("image", originalImageUrl); }}>
                {copied === "image" ? "Image URL copied" : "Copy image URL"}
              </button>
            )}
            {image.pageUrl && (
              <button className="online-secondary" type="button"
                onClick={() => void copyUrl("source", image.pageUrl)}>
                {copied === "source" ? "Source link copied" : "Copy source link"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

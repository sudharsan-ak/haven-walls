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
}

function isRemote(url: string): boolean {
  return url.startsWith("https://");
}

/**
 * Loads the provider's original image when available instead of enlarging a
 * low-resolution search thumbnail. Actual pixels are read from the displayed
 * HTMLImageElement; we never claim provider metadata is a verified 4K image.
 */
export default function FullResolutionPreview({ image, onClose, onAddToLibrary }: Props) {
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
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      <section className="online-detail" role="dialog" aria-modal="true"
        aria-label={"Image preview: " + image.title}>
        <div className="online-detail-image online-hires-preview">
          {resolving ? (
            <div className="online-hires-unavailable" role="status">
              <strong>Finding the best available image</strong>
              <p>Checking the source link and available image sizes…</p>
            </div>
          ) : !failed && src ? (
            <img
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
                Add to Library
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

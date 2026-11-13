import { useEffect, useState, type SyntheticEvent } from "react";
import type { CatalogImage } from "../lib/native";
import { inspectLoadedImage, type InspectedImageDraft } from "../lib/imageInspection";
import { resolveBestAvailableImage, type ResolvedImage } from "../lib/imageResolution";

interface Props {
  image: CatalogImage;
  onClose: () => void;
}

function isRemote(url: string): boolean {
  return url.startsWith("https://");
}

/**
 * Loads the provider's original image when available instead of enlarging a
 * low-resolution search thumbnail. Actual pixels are read from the displayed
 * HTMLImageElement; we never claim provider metadata is a verified 4K image.
 */
export default function FullResolutionPreview({ image, onClose }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedImage | null>(null);
  const [resolving, setResolving] = useState(true);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const [inspection, setInspection] = useState<InspectedImageDraft | null>(null);
  const [copied, setCopied] = useState<"image" | "source" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSrc(null);
    setResolved(null);
    setResolving(true);
    setFallback(false);
    setFailed(false);
    setInspection(null);
    void resolveBestAvailableImage(image, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setResolved(result);
      setResolving(false);
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

  const canCopyImage = Boolean(src && isRemote(src));
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
              {failed ? "Original and fallback preview are unavailable."
                : resolving ? "Checking available image URLs for the largest version…"
                : !inspection ? "Loading image and checking actual pixel dimensions…"
                  : (
                    <>
                      <strong>Loaded image: {inspection.actualWidth} × {inspection.actualHeight}</strong>
                      <span>
                        {inspection.meets4K ? " · 4K+"
                          : inspection.meets1080p ? " · 1080p+"
                            : " · Below 1080p"}
                        {inspection.landscape ? " · Landscape" : " · Not standard landscape"}
                        {fallback ? " · Thumbnail fallback only" : ""}
                      </span>
                      {image.width > 0 && image.height > 0 && (
                        <small>
                          Search provider reported {image.width} × {image.height}.
                          {image.width !== inspection.actualWidth ||
                          image.height !== inspection.actualHeight
                            ? " The loaded file has different dimensions." : ""}
                        </small>
                      )}
                    </>
                  )}
            </div>

            {resolved && (
              <p className={resolved.isThumbnailFallback ? "online-hires-warning" : ""}>
                {resolved.note}
              </p>
            )}
            {fallback && !resolved && (
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
            {canCopyImage && (
              <button className="online-secondary" type="button"
                onClick={() => { if (src) void copyUrl("image", src); }}>
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

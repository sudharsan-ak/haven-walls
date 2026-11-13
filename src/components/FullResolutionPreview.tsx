import { useEffect, useState, type SyntheticEvent } from "react";
import type { CatalogImage } from "../lib/native";
import { inspectLoadedImage, type InspectedImageDraft } from "../lib/imageInspection";

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
  const original = image.originalUrl || image.previewUrl;
  const [src, setSrc] = useState(original);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const [inspection, setInspection] = useState<InspectedImageDraft | null>(null);
  const [copied, setCopied] = useState<"image" | "source" | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onLoaded(event: SyntheticEvent<HTMLImageElement>) {
    const element = event.currentTarget;
    setInspection(inspectLoadedImage(image, element.naturalWidth, element.naturalHeight));
    setFailed(false);
  }

  function onFailed() {
    if (!fallback && original !== image.previewUrl) {
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

  const canCopyImage = isRemote(original);
  return (
    <div className="online-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="online-detail" role="dialog" aria-modal="true"
        aria-label={"Image preview: " + image.title}>
        <div className="online-detail-image online-hires-preview">
          {!failed ? (
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

            {fallback && (
              <p className="online-hires-warning">
                The original image could not be loaded. This is a lower-quality thumbnail,
                not proof that a usable wallpaper is available.
              </p>
            )}
            <p>{image.rights}</p>
          </div>
          <div className="online-hires-actions">
            {canCopyImage && (
              <button className="online-secondary" type="button"
                onClick={() => void copyUrl("image", original)}>
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

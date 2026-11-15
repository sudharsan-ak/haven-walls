import { useEffect, useState } from "react";
import type { BrowserScannedImage } from "../lib/browserNative";
import "./BrowserImagePanel.css";

interface Props {
  pageUrl: string;
  images: BrowserScannedImage[];
  skipped: number;
  onInspect: (image: BrowserScannedImage) => void;
  onAddToReview: (images: BrowserScannedImage[]) => void;
  onClose: () => void;
}

export default function BrowserImagePanel({
  pageUrl, images, skipped, onInspect, onAddToReview, onClose,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [onlyLarge, setOnlyLarge] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    setSelected([]);
    setOnlyLarge(false);
    setSearch("");
  }, [pageUrl, images]);

  const filtered = images.filter((item) => {
    if (onlyLarge && item.width > 0 && item.height > 0
      && (item.width < 1920 || item.height < 1080)) return false;
    return item.title.toLowerCase().includes(search.toLowerCase());
  });
  const allSelected = filtered.length > 0
    && filtered.every((item) => selected.includes(item.url));

  function toggle(url: string) {
    setSelected((before) => before.includes(url)
      ? before.filter((value) => value !== url)
      : before.length < 30 ? [...before, url] : before);
  }

  return (
    <div className="hw-scan-panel" aria-label="Website image scanner" role="region">
      <header className="hw-scan-header">
        <div>
          <strong>Found images</strong>
          <small>{images.length} image candidates detected
            {skipped > 0 ? " · " + skipped + " duplicate/unsafe ignored" : ""}
          </small>
          <small className="hw-scan-page" title={pageUrl}>{pageUrl}</small>
        </div>
        <button type="button" title="Switch to Review" aria-label="Switch to Review"
          onClick={onClose}>×</button>
      </header>
      <div className="hw-scan-controls">
        <label>
          <input type="checkbox" checked={allSelected}
            onChange={(event) => setSelected((before) => event.target.checked
              ? [...new Set([...before, ...filtered.map((item) => item.url)])].slice(0, 30)
              : before.filter((url) => !filtered.some((item) => item.url === url)))}/>
          Select results
        </label>
        <label>
          <input type="checkbox" checked={onlyLarge}
            onChange={(event) => setOnlyLarge(event.target.checked)}/>
          Full HD+
        </label>
        <input className="hw-scan-search" type="search" value={search}
          placeholder="Filter by description" aria-label="Filter scanned images"
          onChange={(event) => setSearch(event.target.value)}/>
      </div>
      <div className="hw-scan-gallery">
        {filtered.length ? filtered.map((item) => (
          <article className={"hw-scan-card" + (selected.includes(item.url) ? " checked" : "")}
            key={item.url}>
            <button type="button" className="hw-scan-card-image"
              aria-label={(selected.includes(item.url) ? "Deselect " : "Select ") + item.title}
              aria-pressed={selected.includes(item.url)}
              onClick={() => toggle(item.url)}
              title="Click to select this image">
              <img src={item.url} alt="" loading="lazy" referrerPolicy="no-referrer"/>
              <span className="hw-scan-card-check" aria-hidden="true">
                {selected.includes(item.url) ? "✓" : ""}
              </span>
            </button>
            <div className="hw-scan-card-details">
              <strong title={item.title}>{item.title}</strong>
              <small>{item.width && item.height
                ? item.width + " × " + item.height + " reported"
                : "Resolution unknown"}
                {item.originalUrl ? " · original candidate" : ""}</small>
              <button type="button" onClick={() => onInspect(item)}>Inspect original</button>
            </div>
          </article>
        )) : (
          <div className="hw-scan-noimages">
            <strong>No matching images found</strong>
            <p>Some websites load images later or render them inside cross-origin
              frames. Scroll the webpage and try scanning again.</p>
          </div>
        )}
      </div>
      <footer className="hw-scan-footer">
        <span>{selected.length} selected / 30 · Dimensions are hints, not verified originals.</span>
        <button type="button" disabled={selected.length === 0}
          onClick={() => {
            onAddToReview(images.filter((item) => selected.includes(item.url)));
            setSelected([]);
          }}>Add selected to Review</button>
      </footer>
    </div>
  );
}

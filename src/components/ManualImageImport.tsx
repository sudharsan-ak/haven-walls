import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { CatalogImage } from "../lib/native";
import { openGoogleImagesBrowser } from "../lib/native";
import "./ManualImageImport.css";

interface Props {
  query: string;
  onPreview: (candidate: CatalogImage) => void;
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function secureImageUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return null;
    }
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Manual intake only: nothing is saved or applied from this screen. */
export default function ManualImageImport({ query, onPreview }: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [browserInfo, setBrowserInfo] = useState("");
  const [opening, setOpening] = useState(false);
  const fileObjectUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (fileObjectUrl.current) URL.revokeObjectURL(fileObjectUrl.current);
  }, []);

  const googleUrl = "https://www.google.com/search?tbm=isch&safe=active&q=" +
    encodeURIComponent(query.trim());

  async function openBrowser() {
    setError("");
    const term = query.trim();
    if (term.length < 2 || term.length > 100) {
      setError("Enter a search term between 2 and 100 characters first.");
      return;
    }
    setOpening(true);
    try {
      await openGoogleImagesBrowser(term);
      setBrowserInfo(
        "Google Images is open in a separate window. Copy an image address there, " +
        "or save an image manually, then return here to preview it."
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBrowserInfo("If Google blocks its embedded browser, copy the search URL and use your regular browser.");
    } finally {
      setOpening(false);
    }
  }

  async function copyGoogleSearch() {
    try {
      await navigator.clipboard.writeText(googleUrl);
      setBrowserInfo("Google Images search URL copied. Open it in your normal browser.");
      setError("");
    } catch {
      setError("Could not copy. Use the in-app Google Images window instead.");
    }
  }

  function fromUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = secureImageUrl(url);
    if (!clean) {
      setError("Paste a direct HTTPS image address (not a Google results page).");
      return;
    }
    setError("");
    onPreview({
      id: "manual-url",
      source: "Manually selected web image",
      title: "Web image preview",
      previewUrl: clean,
      originalUrl: clean,
      pageUrl: "",
      credit: "Original source page not provided",
      rights: "Manual image preview only. Confirm the creator, actual resolution and permitted use.",
      width: 0,
      height: 0,
      kind: "image",
    });
  }

  function fromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type) || file.size === 0 ||
      file.size > MAX_FILE_BYTES) {
      setError("Choose a JPG, PNG, or WebP image up to 32 MB.");
      return;
    }
    if (fileObjectUrl.current) {
      URL.revokeObjectURL(fileObjectUrl.current);
    }
    const localUrl = URL.createObjectURL(file);
    fileObjectUrl.current = localUrl;
    setError("");
    onPreview({
      id: "manual-file",
      source: "Local selected image",
      title: file.name,
      previewUrl: localUrl,
      originalUrl: localUrl,
      pageUrl: "",
      credit: "Your local file",
      rights: "This file is loaded in memory for preview only. Haven Walls has not saved a copy.",
      width: 0,
      height: 0,
      kind: "image",
    });
  }

  return (
    <section className="manual-discovery" aria-labelledby="manual-discovery-title">
      <h2 id="manual-discovery-title">Browse Google Images without an API key</h2>
      <p>
        Use Google's own image search in a separate window. Choose an image yourself,
        then paste its direct image URL or select a file you downloaded.
        Haven Walls does not scrape Google results.
      </p>
      <div className="manual-browser-actions">
        <button type="button" className="online-primary" disabled={opening}
          onClick={() => void openBrowser()}>
          {opening ? "Opening…" : "Browse Google Images"}
        </button>
        <button type="button" className="online-secondary"
          onClick={() => void copyGoogleSearch()}>Copy Google search link</button>
      </div>

      <div className="manual-import-row">
        <form onSubmit={fromUrl} className="manual-url-form">
          <label htmlFor="manual-image-url">Paste a direct image address</label>
          <div className="online-input-row">
            <input id="manual-image-url" type="url" value={url} maxLength={4000}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/wallpaper.jpg" />
            <button type="submit" className="online-secondary">Preview URL</button>
          </div>
        </form>
        <div className="manual-file-field">
          <label htmlFor="manual-image-file">Or preview an image file you've downloaded</label>
          <input id="manual-image-file" type="file" accept="image/jpeg,image/png,image/webp"
            onChange={fromFile} />
          <small>JPG, PNG or WebP, up to 32 MB. The file stays on your computer.</small>
        </div>
      </div>

      {error && <p className="manual-error" role="alert">{error}</p>}
      {browserInfo && <p className="manual-info" role="status">{browserInfo}</p>}
    </section>
  );
}

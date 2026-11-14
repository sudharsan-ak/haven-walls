import type { CatalogImage } from "./native";

const GOOGLE_IMAGE_QUERY_PARAMS = ["imgurl", "mediaurl", "image_url"];
const GOOGLE_LINK_QUERY_PARAMS = ["url", "q"];
const MAX_IMAGE_CANDIDATES = 5;

/** Only treat explicitly linked HTTPS images as remote image candidates. */
export function validRemoteUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" || !host.includes(".") || url.username || url.password ||
      ["localhost", "0.0.0.0"].includes(host) ||
      host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function googleHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "google.com" || host === "www.google.com" ||
    host === "images.google.com";
}

/** Google imgres links sometimes include the ORIGINAL as an encoded query param.
 * Do not parse Google's page content or guess from cached thumbnail IDs.
 */
export function unwrapKnownImageLink(raw: string): string | null {
  let current = validRemoteUrl(raw);
  if (!current) return null;
  for (let i = 0; i < 2; i++) {
    const url = new URL(current);
    if (!googleHost(url)) break;
    const fields = url.pathname.startsWith("/imgres")
      ? GOOGLE_IMAGE_QUERY_PARAMS
      : url.pathname === "/url" ? GOOGLE_LINK_QUERY_PARAMS : [];
    const nested = fields.map((field) => url.searchParams.get(field))
      .find((value) => Boolean(value && validRemoteUrl(value)));
    if (!nested) break;
    const next = validRemoteUrl(nested);
    if (!next || current === next) break;
    current = next;
  }
  return current;
}

export function isGoogleCachedThumbnail(raw: string): boolean {
  const url = validRemoteUrl(raw);
  if (!url) return false;
  const host = new URL(url).hostname.toLowerCase();
  return /^encrypted-tbn\d*\.gstatic\.com$/.test(host) ||
    /^encrypted-tbn\d*\.googleusercontent\.com$/.test(host) ||
    (host.endsWith(".gstatic.com") && url.includes("tbn:"));
}

function isLikelyDirectImage(raw: string): boolean {
  const valid = validRemoteUrl(raw);
  if (!valid) return false;
  const url = new URL(valid);
  const host = url.hostname.toLowerCase();
  return /\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname) ||
    host === "images.pexels.com" ||
    host === "images.unsplash.com" ||
    host === "image.tmdb.org" ||
    host === "images.wallpaperscraft.com" ||
    host.endsWith(".gstatic.com");
}

/** Prefer source links rather than assuming a Google cached thumbnail can be upscaled. */
export function chooseOriginalFromLink(imageUrl: string, linkUrl?: string): {
  original: string;
  preview: string;
  sourcePage: string;
} {
  const supplied = validRemoteUrl(imageUrl);
  if (!supplied) {
    throw new Error("This selection does not contain a valid direct HTTPS image address.");
  }
  // The user might paste a Google imgres link directly, rather than
  // right-clicking a thumbnail. Unwrap it before treating it as an image.
  const preview = unwrapKnownImageLink(supplied) || supplied;
  const linked = linkUrl ? unwrapKnownImageLink(linkUrl) : null;
  const sourceLink = linkUrl ? validRemoteUrl(linkUrl) : null;
  const original = linked && linked !== sourceLink && isLikelyDirectImage(linked)
    ? linked
    : linked && isLikelyDirectImage(linked) && !googleHost(new URL(linked))
      ? linked
      : preview;
  const sourcePage = sourceLink && !isLikelyDirectImage(sourceLink) &&
    !googleHost(new URL(sourceLink)) ? sourceLink : "";
  return { original, preview, sourcePage };
}

/** Upgraded URLs are *candidates*, not proof of a real 4K file. A remote host
 * may ignore parameters, refuse them or return an image smaller than requested.
 */
function largerVersion(urlString: string): string | null {
  const valid = validRemoteUrl(urlString);
  if (!valid) return null;
  const url = new URL(valid);
  const host = url.hostname.toLowerCase();
  if (host === "image.tmdb.org") {
    const replacement = url.pathname.replace(/^\/t\/p\/(?:w\d+|original)\//, "/t/p/original/");
    if (replacement !== url.pathname) {
      url.pathname = replacement;
      return url.href;
    }
  }
  if (host === "images.pexels.com" && url.pathname.startsWith("/photos/")) {
    url.searchParams.delete("h");
    url.searchParams.delete("height");
    url.searchParams.delete("crop");
    url.searchParams.set("w", "3840");
    return url.href;
  }
  if (host === "images.unsplash.com" && url.pathname.startsWith("/photo-")) {
    ["h", "height", "crop", "rect", "fm"].forEach((key) => url.searchParams.delete(key));
    url.searchParams.set("fit", "max");
    url.searchParams.set("w", "3840");
    url.searchParams.set("q", "85");
    return url.href;
  }
  return null;
}

export function imageCandidates(image: CatalogImage): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    const valid = url?.startsWith("blob:") ? url : validRemoteUrl(url);
    if (!valid || seen.has(valid) || candidates.length >= MAX_IMAGE_CANDIDATES) return;
    seen.add(valid);
    candidates.push(valid);
  };
  const original = image.originalUrl || image.previewUrl;
  if (original.startsWith("blob:")) return [original];

  // Prefer the largest advertised source, but retain the actual input URL
  // for hosts that reject the high-res variant.
  push(largerVersion(original));
  push(original);
  for (const alternate of image.candidateUrls || []) {
    push(largerVersion(alternate));
    push(alternate);
  }
  push(image.previewUrl);
  return candidates;
}

export interface ResolvedImage {
  url: string;
  width: number;
  height: number;
  isThumbnailFallback: boolean;
  note: string;
}

function score(width: number, height: number): number {
  const aspect = height > 0 ? width / height : 0;
  const landscape = aspect >= 1.45 && aspect <= 2.6;
  const fourK = width >= 3840 && height >= 2160;
  return (landscape ? 1e13 : 0) +
    (fourK ? 1e12 : 0) +
    Math.min(1e11, width * height) -
    Math.abs(aspect - 16 / 9) * 1e8;
}

function loadActualPixels(
  url: string, signal: AbortSignal, timeoutMs: number,
): Promise<ResolvedImage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (err?: Error) => {
      img.onload = null;
      img.onerror = null;
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve({
        url, width: img.naturalWidth, height: img.naturalHeight,
        isThumbnailFallback: false, note: "",
      });
    };
    const onAbort = () => finish(new Error("Cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) finish(new Error("No image pixels"));
      else finish();
    };
    img.onerror = () => finish(new Error("Image host rejected the request"));
    timer = setTimeout(() => finish(new Error("Image preview timed out")), timeoutMs);
    img.src = url;
  });
}

/** Inspect a small bounded set of known candidate URLs. No arbitrary
 * search-result scraping or proxying; only the selected image is checked.
 */
export async function resolveBestAvailableImage(
  image: CatalogImage,
  signal: AbortSignal,
): Promise<ResolvedImage | null> {
  const urls = imageCandidates(image);
  let best: ResolvedImage | null = null;
  const startedAt = Date.now();
  for (const url of urls) {
    if (signal.aborted) return null;
    // Stop trying increasingly unlikely URL variants after a bounded window.
    const remainingMs = 16000 - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    try {
      const candidate = await loadActualPixels(url, signal, Math.min(7000, remainingMs));
      if (!best || score(candidate.width, candidate.height) >
        score(best.width, best.height)) {
        best = candidate;
      }
      if (candidate.width >= 3840 && candidate.height >= 2160 &&
        candidate.width / candidate.height >= 1.45 &&
        candidate.width / candidate.height <= 2.6) {
        break; // A verified 4K landscape was found; don't fetch more.
      }
    } catch {
      if (signal.aborted) return null;
    }
  }
  if (!best) return null;

  const isThumbnailFallback = isGoogleCachedThumbnail(best.url) ||
    (image.previewUrl !== image.originalUrl && best.url === image.previewUrl);
  const verified4K = best.width >= 3840 && best.height >= 2160;
  const note = verified4K
    ? "An available image was verified at 4K or higher."
    : isThumbnailFallback
      ? "Only a cached/preview image is available from this link. Open the full-size image on the source site for a better URL."
      : "This is the largest available image we could load from the provided link. It has not been verified as 4K.";
  return { ...best, isThumbnailFallback, note };
}

import type { CatalogImage } from "./native";
import { isGoogleCachedThumbnail, validRemoteUrl } from "./imageResolution";

/** Reported dimensions may describe a search thumbnail, not the original. */
export interface ObservedPreviewSize {
  width: number;
  height: number;
}

export type DiscoveryQualityFilter = "wallpaper" | "all";

export function previewSources(image: CatalogImage): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of [
    image.previewUrl, image.originalUrl, ...(image.candidateUrls ?? []),
  ]) {
    if (results.length >= 5) break;
    if (!value) continue;
    const safe = value.startsWith("blob:") ? value : validRemoteUrl(value);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    results.push(safe);
  }
  return results;
}

/** A direct link is a *possibility* of a bigger source, never proof of its
 * actual pixel size. FullResolutionPreview verifies originals on inspection.
 */
export function hasPotentialOriginal(image: CatalogImage): boolean {
  return [image.originalUrl, ...(image.candidateUrls ?? [])].some((value) => {
    const safe = validRemoteUrl(value);
    return Boolean(safe && safe !== image.previewUrl &&
      !isGoogleCachedThumbnail(safe));
  });
}

/** Conservative default for desktop wallpaper discovery.
 * A known square/portrait image is excluded. A small search thumbnail is
 * accepted only when a different non-Google-cache original URL is available.
 * A dimensionless candidate is temporarily kept so its preview can load and
 * supply real pixel dimensions; unknown size is never labeled 1080p/4K.
 */
export function isWallpaperCandidate(
  image: CatalogImage,
  observed?: ObservedPreviewSize,
): boolean {
  const width = image.width > 0 ? image.width : observed?.width ?? 0;
  const height = image.height > 0 ? image.height : observed?.height ?? 0;
  if (width === 0 || height === 0) return true;

  const ratio = width / height;
  if (ratio < 1.3 || ratio > 3.6) return false;
  // A search thumbnail this size is worth inspecting; it is not proof of HQ.
  if (width >= 640 && height >= 360) return true;
  return width >= 180 && height >= 100 && hasPotentialOriginal(image);
}

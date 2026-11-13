import type { CatalogImage } from "./native";

/** One observed image preview, not yet a library item or a license decision. */
export interface InspectedImageDraft {
  title: string;
  source: string;
  sourcePageUrl: string | null;
  originalImageUrl: string | null;
  reportedWidth: number | null;
  reportedHeight: number | null;
  actualWidth: number;
  actualHeight: number;
  landscape: boolean;
  meets1080p: boolean;
  meets4K: boolean;
  attribution: string;
  rightsStatus: "unverified";
  previewOnly: true;
}

export function inspectLoadedImage(
  image: CatalogImage,
  actualWidth: number,
  actualHeight: number,
): InspectedImageDraft {
  const ratio = actualHeight > 0 ? actualWidth / actualHeight : 0;
  return {
    title: image.title,
    source: image.source,
    sourcePageUrl: image.pageUrl || null,
    originalImageUrl: image.originalUrl?.startsWith("https://")
      ? image.originalUrl
      : image.previewUrl.startsWith("https://") ? image.previewUrl : null,
    reportedWidth: image.width || null,
    reportedHeight: image.height || null,
    actualWidth,
    actualHeight,
    landscape: ratio >= 1.45 && ratio <= 2.6,
    meets1080p: actualWidth >= 1920 && actualHeight >= 1080,
    meets4K: actualWidth >= 3840 && actualHeight >= 2160,
    attribution: image.credit,
    rightsStatus: "unverified",
    previewOnly: true,
  };
}

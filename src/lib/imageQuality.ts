/** Quality labels use pixels actually decoded and saved in Library, not
 * a resolution claim from the image search result. Portrait is supported.
 */
export type ImageQualityTier = "Below 1080p" | "1080p" | "1440p" | "4K+";

export function resolutionLongShort(width: number, height: number): [number, number] {
  return [Math.max(width, height), Math.min(width, height)];
}

export function qualityTier(width: number, height: number): ImageQualityTier {
  const [long, short] = resolutionLongShort(width, height);
  if (long >= 3840 && short >= 2160) return "4K+";
  if (long >= 2560 && short >= 1440) return "1440p";
  if (long >= 1920 && short >= 1080) return "1080p";
  return "Below 1080p";
}

export function minimumPixels(resolution: "1080p" | "1440p" | "4K"): [number, number] {
  switch (resolution) {
    case "4K": return [3840, 2160];
    case "1440p": return [2560, 1440];
    default: return [1920, 1080];
  }
}

export function belowResolution(
  width: number, height: number, minimumLong: number, minimumShort: number,
): boolean {
  const [long, short] = resolutionLongShort(width, height);
  return long < minimumLong || short < minimumShort;
}

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LibraryWallpaper } from "./wallpaperLibrary";
import type { AppSettings, WallpaperFit } from "./configuration";

export interface WindowsMonitor {
  id: string;
  name: string;
  width: number;
  height: number;
  left: number;
  top: number;
  isPrimary: boolean;
}
export interface CurrentWallpaper {
  wallpaperId: string;
  title: string;
  targetId: string;
  appliedAt: string;
}
export interface WallpaperHistory {
  wallpaperId: string | null;
  title: string;
  targetId: string;
  fit: string;
  appliedAt: string;
}
export interface WallpaperActivity {
  current: CurrentWallpaper[];
  history: WallpaperHistory[];
}
export interface WallpaperApplyResult {
  notice: string;
  targetId: string;
  wallpaperId: string;
}

function requireDesktop() {
  if (!isTauri()) throw new Error("Windows wallpaper application requires the Haven Walls desktop app.");
}
export async function listWindowsMonitors(): Promise<WindowsMonitor[]> {
  requireDesktop();
  return invoke<WindowsMonitor[]>("list_wallpaper_monitors");
}
export async function getWallpaperActivity(): Promise<WallpaperActivity> {
  requireDesktop();
  return invoke<WallpaperActivity>("get_wallpaper_activity");
}
export async function applyLibraryWallpaper(
  id: string,
  targetId: string,
  fit: WallpaperFit,
  overlayJpegBase64?: string,
): Promise<WallpaperApplyResult> {
  requireDesktop();
  return invoke<WallpaperApplyResult>("apply_library_wallpaper", {
    wallpaperId: id,
    targetId,
    fit,
    overlayJpegBase64: overlayJpegBase64 ?? null,
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not prepare the saved image for captions."));
    img.src = dataUrl;
  });
}

function sourceCredit(image: LibraryWallpaper): string {
  const credit = image.credit?.trim() || "";
  const generic = !credit || /^(not provided|imported from this computer|local file|image hosted by)/i.test(credit);
  if (!generic) return "Photo: " + credit.slice(0, 150);
  if (image.sourcePage || image.originalUrl) {
    try {
      return "Source: " + new URL(image.sourcePage || image.originalUrl).hostname;
    } catch { /* Not a remote URL. */ }
  }
  return image.source && image.source !== "Local file"
    ? "Source: " + image.source.slice(0, 120) : "";
}

/** Use a local Canvas: the persisted Library file is the only input. We don't
 * download any third-party images or inject anything into Google WebView2.
 * Preserve native resolution up to 8K/40MP for captions and credits; only exceptionally large images are downsampled for bounded memory. No upscaling.
 * Original managed wallpaper remains completely untouched.
 */
export async function renderWallpaperOverlay(
  imageDataUrl: string,
  image: LibraryWallpaper,
  settings: Pick<AppSettings, "showCaption" | "showPhotoCredit">,
): Promise<string | undefined> {
  const caption = settings.showCaption ? image.title.trim().slice(0, 150) : "";
  const credit = settings.showPhotoCredit ? sourceCredit(image) : "";
  if (!caption && !credit) return undefined;

  const photo = await loadImage(imageDataUrl);
  const originalWidth = photo.naturalWidth;
  const originalHeight = photo.naturalHeight;
  if (!originalWidth || !originalHeight) throw new Error("Saved wallpaper has no readable image dimensions.");
  const maxPixels = 40_000_000;
  const scale = Math.min(
    1, 8192 / originalWidth, 8192 / originalHeight,
    Math.sqrt(maxPixels / (originalWidth * originalHeight)),
  );
  const w = Math.max(1, Math.round(originalWidth * scale));
  const h = Math.max(1, Math.round(originalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image overlay rendering is unavailable in WebView2.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, 0, 0, w, h);

  const margin = Math.max(14, Math.round(w * 0.022));
  const gap = Math.max(7, Math.round(w * 0.005));
  const titleSize = Math.max(14, Math.min(34, Math.round(w * 0.011)));
  const creditSize = Math.max(12, Math.min(23, Math.round(w * 0.007)));
  const maxTextWidth = Math.max(120, Math.min(w - margin * 3, w * 0.55));
  const lines: Array<{ text: string; size: number; weight: string }> = [];
  if (caption) lines.push({ text: caption, size: titleSize, weight: "600" });
  if (credit) lines.push({ text: credit, size: creditSize, weight: "400" });

  const padX = Math.max(12, Math.round(w * 0.012));
  const padY = Math.max(10, Math.round(w * 0.009));
  let maxWidth = 0;
  for (const line of lines) {
    ctx.font = line.weight + " " + line.size + "px 'Segoe UI', Arial, sans-serif";
    maxWidth = Math.max(maxWidth, Math.min(maxTextWidth, ctx.measureText(line.text).width));
  }
  const boxWidth = Math.min(w - margin * 2, Math.ceil(maxWidth + 2 * padX));
  const contentHeight = lines.reduce((sum, line) => sum + line.size * 1.35, 0) +
    gap * (lines.length - 1);
  const boxHeight = Math.ceil(contentHeight + 2 * padY);
  const left = w - margin - boxWidth;
  const top = Math.max(margin, h - margin - boxHeight);
  ctx.fillStyle = "rgba(7,17,30,0.67)";
  ctx.beginPath();
  ctx.roundRect(left, top, boxWidth, boxHeight, Math.max(6, Math.round(w * 0.003)));
  ctx.fill();

  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  let lineY = top + padY;
  for (const line of lines) {
    ctx.font = line.weight + " " + line.size + "px 'Segoe UI', Arial, sans-serif";
    ctx.fillText(line.text, left + boxWidth - padX, lineY, boxWidth - 2 * padX);
    lineY += line.size * 1.35 + gap;
  }
  const rendered = canvas.toDataURL("image/jpeg", 0.92);
  if (!rendered.startsWith("data:image/jpeg;base64,")) {
    throw new Error("Could not encode the captioned wallpaper.");
  }
  return rendered.slice("data:image/jpeg;base64,".length);
}

export const FIT_OPTIONS: { value: WallpaperFit; label: string; note: string }[] = [
  { value: "smartFit", label: "Smart Fit", note: "Uses Fill for similar aspect ratios; otherwise Fit" },
  { value: "fill", label: "Fill", note: "Fills the screen; edges may crop" },
  { value: "fit", label: "Fit", note: "Shows the whole image; may add borders" },
  { value: "center", label: "Center", note: "Keeps original pixel size" },
  { value: "stretch", label: "Stretch", note: "Fills the screen; may distort proportions" },
  { value: "span", label: "Span", note: "One continuous wallpaper across all displays" },
];

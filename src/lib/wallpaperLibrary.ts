import { invoke, isTauri } from "@tauri-apps/api/core";

export interface LibraryWallpaper {
  id: string;
  title: string;
  source: string;
  sourcePage: string;
  originalUrl: string;
  credit: string;
  rightsNote: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  favorite: boolean;
  createdAt: string;
  thumbnailDataUrl: string;
}

export interface ImportMetadata {
  title: string;
  source: string;
  sourcePage: string;
  originalUrl: string;
  credit: string;
  rightsNote: string;
  rightsConfirmed: boolean;
  allowBelowMinimum: boolean;
  allowSimilar: boolean;
}
export interface ImportOutcome {
  wallpaper: LibraryWallpaper;
  alreadySaved: boolean;
  note: string;
}
const requireHost = () => {
  if (!isTauri()) throw new Error("Wallpaper storage requires the Haven Walls Windows app.");
};

export async function importWallpaperUrl(
  imageUrl: string, metadata: ImportMetadata,
): Promise<ImportOutcome> {
  requireHost();
  return invoke<ImportOutcome>("import_wallpaper_url", { imageUrl, metadata });
}

export async function importWallpaperData(
  base64Data: string, metadata: ImportMetadata,
): Promise<ImportOutcome> {
  requireHost();
  return invoke<ImportOutcome>("import_wallpaper_data", { base64Data, metadata });
}

export async function listLibraryWallpapers(): Promise<LibraryWallpaper[]> {
  requireHost();
  return invoke<LibraryWallpaper[]>("list_library_wallpapers");
}

export async function getLibraryWallpaperImage(id: string): Promise<string> {
  requireHost();
  return invoke<string>("get_library_wallpaper_image", { id });
}

export async function setWallpaperFavorite(id: string, favorite: boolean): Promise<void> {
  requireHost();
  await invoke<void>("set_wallpaper_favorite", { id, favorite });
}

export async function removeLibraryWallpaper(id: string): Promise<void> {
  requireHost();
  await invoke<void>("remove_library_wallpaper", { id });
}

/** Local file blobs from the PR #2 Google selection tray are preview URLs.
 * Read only the user-selected bytes, never an arbitrary OS path.
 */
export async function fileBlobToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Couldn't read the selected local image.");
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > 32 * 1024 * 1024) {
    throw new Error("Local images must be 32 MB or smaller.");
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the selected local image."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.startsWith("data:") || !result.includes(",")) {
        reject(new Error("Local image data is unavailable."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}


/** Open the saved online source in the operating system's default browser.
 * Unlike an ordinary target=_blank anchor, this works in Tauri WebView2.
 */
export async function openWallpaperSource(url: string): Promise<void> {
  requireHost();
  await invoke<void>("open_wallpaper_source", { url });
}


/** Evaluate the selected image's available originals and the recorded source
 * page's standard image metadata, then persist only the highest-quality
 * verified matching image. Never write a low-res preview while probing.
 */
export async function importBestWallpaperUrls(
  candidateUrls: string[],
  metadata: ImportMetadata,
): Promise<ImportOutcome> {
  requireHost();
  return invoke<ImportOutcome>("import_best_wallpaper_urls", { candidateUrls, metadata });
}

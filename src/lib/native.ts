import { invoke, isTauri } from "@tauri-apps/api/core";

export interface HostInfo {
  appName: string;
  version: string;
  platform: string;
}

/** The native Rust host owns all network provider requests. */
export async function readHostInfo(): Promise<HostInfo | null> {
  if (!isTauri()) return null;
  return invoke<HostInfo>("get_host_info");
}

export type CatalogSourceId = "bing" | "earth" | "sports" | "tmdb" | "google";

export interface CatalogImage {
  id: string;
  source: string;
  title: string;
  previewUrl: string;
  /** Direct original-size image link, when the provider supplies it. */
  originalUrl?: string | null;
  pageUrl: string;
  credit: string;
  rights: string;
  width: number;
  height: number;
  kind: "image" | "tv-show";
}

export interface CatalogResponse {
  items: CatalogImage[];
  note: string;
}

/**
 * Catalog only. The user explicitly requests each lookup.
 * Nothing here downloads an original, saves an image, or sets a wallpaper.
 * TMDB bearer tokens are passed in memory and are never persisted by this module.
 */
export async function browseWallpaperSource(
  source: CatalogSourceId,
  query = "",
  tmdbToken?: string,
): Promise<CatalogResponse> {
  if (!isTauri()) {
    throw new Error("Online browsing requires the Haven Walls desktop application.");
  }
  return invoke<CatalogResponse>("browse_wallpaper_source", {
    source,
    query,
    tmdbToken: tmdbToken || null,
  });
}

export async function browseTMDBBackdrops(
  tvId: number,
  tmdbToken: string,
): Promise<CatalogResponse> {
  if (!isTauri()) {
    throw new Error("TV artwork browsing requires the Haven Walls desktop application.");
  }
  return invoke<CatalogResponse>("browse_tmdb_backdrops", { tvId, tmdbToken });
}


/** Real Google Images results are supplied through a user-owned SerpApi key.
 * The query and key are sent directly from Rust to SerpApi over HTTPS.
 * Haven Walls never writes the key or the image catalog to application storage.
 */
export async function browseGoogleImages(
  query: string,
  serpapiKey: string,
  minWidth: number,
  minHeight: number,
): Promise<CatalogResponse> {
  if (!isTauri()) {
    throw new Error("Google Images browsing requires the Haven Walls Windows application.");
  }
  return invoke<CatalogResponse>("browse_google_images", {
    query,
    serpapiKey,
    minWidth,
    minHeight,
  });
}

export interface GoogleInlineBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Opens or navigates the isolated Google Images child WebView2. */
export async function openGoogleImagesInline(
  query: string,
  bounds: GoogleInlineBounds,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Google Images browser requires the Windows desktop application.");
  }
  await invoke<void>("open_google_images_inline", { query, bounds });
}

/** Moves, resizes, or hides the Google Images child WebView2. */
export async function layoutGoogleImagesInline(
  bounds: GoogleInlineBounds | null,
): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("layout_google_images_inline", { bounds });
}

/** Closes the Google Images child WebView2 when leaving its workspace. */
export async function closeGoogleImagesInline(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("close_google_images_inline");
}


/** Zoom Google's native child webview only. 1 = 100%. */
export async function setGoogleImagesInlineZoom(zoom: number): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_google_images_inline_zoom", { zoom });
}

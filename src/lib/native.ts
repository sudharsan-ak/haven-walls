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

export type CatalogSourceId = "discover" | "bing" | "earth" | "sports" | "tmdb" | "google";

export interface CatalogImage {
  id: string;
  source: string;
  title: string;
  previewUrl: string;
  /** Direct original-size image link, when the provider supplies it. */
  originalUrl?: string | null;
  /** Alternative directly linked source URLs, tried when inspecting image quality. */
  candidateUrls?: string[];
  /** Library reference for a candidate that can optionally upgrade an existing image. */
  upgradeFromId?: string;
  /** A Lens result may be a different photo; default its import to a new wallpaper. */
  reverseSearchMatch?: boolean;
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


export type CategoryProvider = "commons" | "nasa" | "unsplash";

/** Manual category search. Unsplash key is session-only and sent directly to its API.
 * Metadata is not a verified image download or license clearance.
 */
export async function browseCategoryImages(
  provider: CategoryProvider, query: string, unsplashKey = "",
): Promise<CatalogResponse> {
  if (!isTauri()) throw new Error("Category browsing needs Haven Walls for Windows.");
  return invoke<CatalogResponse>("browse_category_images", { provider, query, unsplashKey });
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

/** Opens a Google-owned Lens results page in our isolated native WebView2. */
export async function openGoogleLensInline(
  url: string, bounds: GoogleInlineBounds,
): Promise<void> {
  if (!isTauri()) throw new Error("Google Lens requires the Haven Walls Windows app.");
  await invoke<void>("open_google_lens_inline", { url, bounds });
}

/** Initiate a visual search by uploading a search-sized copy from the
 * saved image inside Google's own embedded browser session. This does not
 * prove that Google has produced usable results.
 */
export async function reverseSearchLibraryWallpaperInline(
  imageId: string, bounds: GoogleInlineBounds,
): Promise<void> {
  if (!isTauri()) throw new Error("Google Lens requires the Haven Walls Windows app.");
  return invoke<void>("reverse_search_library_wallpaper_inline", { imageId, bounds });
}

/** Opens Windows Explorer at the saved managed image for manual Lens upload. */
export async function showLibraryWallpaperForLens(id: string): Promise<void> {
  if (!isTauri()) throw new Error("Windows Explorer requires the desktop app.");
  await invoke<void>("show_library_wallpaper_for_lens", { id });
}

/** Look up image metadata from a user-selected Lens publisher link only.
 * Rust enforces bounded HTML/image fetches and public HTTPS host checks.
 */
export async function resolveLensPublisherPreview(sourcePage: string): Promise<string> {
  if (!isTauri()) throw new Error("Publisher image lookup requires the Windows app.");
  return invoke<string>("resolve_lens_publisher_preview", { sourcePage });
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

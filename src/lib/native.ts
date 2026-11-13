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

export type CatalogSourceId = "bing" | "earth" | "sports" | "tmdb";

export interface CatalogImage {
  id: string;
  source: string;
  title: string;
  previewUrl: string;
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

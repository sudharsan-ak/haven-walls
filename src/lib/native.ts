import { invoke, isTauri } from "@tauri-apps/api/core";

export interface HostInfo {
  appName: string;
  version: string;
  platform: string;
}

/**
 * One typed boundary for the native commands. The scheduler, providers and
 * Windows wallpaper APIs belong in Rust, not in the React window.
 */
export async function readHostInfo(): Promise<HostInfo | null> {
  if (!isTauri()) {
    return null;
  }

  return invoke<HostInfo>("get_host_info");
}

/** Preview catalog data; not locally downloaded or automatically authorized. */
export interface WallpaperCandidate {
  id: number;
  title: string;
  width: number;
  height: number;
  thumbnailUrl: string;
  pageUrl: string;
  license: string;
  licenseUrl: string | null;
  source: string;
}
export interface OnlineSearchResponse {
  items: WallpaperCandidate[];
  scanned: number;
}
export async function searchOnlineWallpapers(query: string): Promise<OnlineSearchResponse> {
  if (!isTauri()) {
    throw new Error("Online search requires the Windows desktop application.");
  }
  return invoke<OnlineSearchResponse>("search_commons_wallpapers", { query });
}

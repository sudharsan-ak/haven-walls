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

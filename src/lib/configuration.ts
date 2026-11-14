import { invoke, isTauri } from "@tauri-apps/api/core";

export type StorageMode = "appData" | "portable";

export type WallpaperFit = "smartFit" | "fill" | "fit" | "stretch" | "center" | "span";
export type MinimumResolution = "1080p" | "1440p" | "4K";

export interface AppSettings {
  wallpaperFit: WallpaperFit;
  minimumResolution: MinimumResolution;
  prefer4k: boolean;
  showPhotoCredit: boolean;
  showCaption: boolean;
  cacheLimitMb: number;
  duplicateSensitivity: number;
  allowedImageTypes: string[];
  excludedKeywords: string[];
  excludedSources: string[];
}

export interface StorageStatus {
  mode: StorageMode;
  rootPath: string;
  discoveryBytes: number;
  pendingBytes: number;
  managedBytes: number;
  activeBytes: number;
  offlineReserveBytes: number;
  databaseBytes: number;
}

export interface ConfigurationSnapshot {
  settings: AppSettings;
  storage: StorageStatus;
}

function requireDesktop(): void {
  if (!isTauri()) throw new Error("Settings and local storage require the Haven Walls Windows app.");
}

export async function getConfiguration(): Promise<ConfigurationSnapshot> {
  requireDesktop();
  return invoke<ConfigurationSnapshot>("get_configuration");
}

export async function saveConfiguration(settings: AppSettings): Promise<ConfigurationSnapshot> {
  requireDesktop();
  return invoke<ConfigurationSnapshot>("save_configuration", { settings });
}

export async function changeStorageMode(mode: StorageMode): Promise<ConfigurationSnapshot> {
  requireDesktop();
  return invoke<ConfigurationSnapshot>("change_storage_mode", { mode });
}

export async function clearTemporaryCache(): Promise<ConfigurationSnapshot> {
  requireDesktop();
  return invoke<ConfigurationSnapshot>("clear_temporary_cache");
}

export function formattedBytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + " KB";
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + " MB";
  return (value / 1024 ** 3).toFixed(2) + " GB";
}

const LEGACY_DISPLAY_KEY = "haven-walls.wallpaper-display-prefs.v1";
const MIGRATED_KEY = "haven-walls.sqlite-display-migrated-v1";

/** One-time carryover from PR #2's WebView-only caption/credit settings.
 * All future settings edits go to Rust + SQLite.
 */
export async function migrateLegacyDisplaySettings(
  snapshot: ConfigurationSnapshot,
): Promise<ConfigurationSnapshot> {
  try {
    if (window.localStorage.getItem(MIGRATED_KEY) === "1") return snapshot;
    const stored = window.localStorage.getItem(LEGACY_DISPLAY_KEY);
    if (!stored) {
      window.localStorage.setItem(MIGRATED_KEY, "1");
      return snapshot;
    }
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object") return snapshot;
    const old = value as Record<string, unknown>;
    const merged: AppSettings = {
      ...snapshot.settings,
      showPhotoCredit: typeof old.showPhotoCredit === "boolean"
        ? old.showPhotoCredit : snapshot.settings.showPhotoCredit,
      showCaption: typeof old.showCaption === "boolean"
        ? old.showCaption : snapshot.settings.showCaption,
    };
    const updated = await saveConfiguration(merged);
    window.localStorage.setItem(MIGRATED_KEY, "1");
    return updated;
  } catch {
    // Legacy storage is optional. Never block Settings or overwrite SQLite
    // settings if the browser data is malformed/unavailable.
    return snapshot;
  }
}

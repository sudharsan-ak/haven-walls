import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WallpaperApplyResult } from "./windowsWallpaper";

export interface RotationPreferences {
  enabled: boolean;
  paused: boolean;
  pinned: boolean;
  intervalMinutes: number;
  favoritesOnly: boolean;
  cooldownDays: number;
  discoveryEnabled: boolean;
  discoveryTopic: "nature" | "space" | "cities";
}
export interface RotationStatus {
  preferences: RotationPreferences;
  nextDueUnix: number | null;
  lastSuccessUnix: number | null;
  lastWallpaperId: string | null;
  lastError: string | null;
  eligibleCount: number;
  reserveCount: number;
  nextDiscoveryUnix: number | null;
  lastDiscoveryError: string | null;
}
function desktopOnly(): void {
  if (!isTauri()) throw new Error("Wallpaper rotation requires Haven Walls for Windows.");
}
export async function getRotationStatus(): Promise<RotationStatus> {
  desktopOnly();
  return invoke<RotationStatus>("get_rotation_status");
}
export async function saveRotationPreferences(preferences: RotationPreferences): Promise<RotationStatus> {
  desktopOnly();
  return invoke<RotationStatus>("save_rotation_preferences", { preferences });
}
export async function rotateNextWallpaper(): Promise<WallpaperApplyResult> {
  desktopOnly();
  return invoke<WallpaperApplyResult>("rotation_next");
}
